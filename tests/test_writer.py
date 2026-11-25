import json
import os
import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "clients" / "python"))

try:
    import psycopg
    import calibration_report_writer as writer_module
except ImportError:  # psycopg is only needed by producers
    psycopg = None

DSN = os.environ.get("CR_TEST_DSN")


class FakeConnection:
    """Stands in for psycopg.connect(); fails the first `failures` executes."""

    def __init__(self, log, failures=0, error=None):
        self.log = log
        self.failures = failures
        self.error = error
        self.closed = False
        self.attempts = 0

    def __call__(self, dsn, autocommit):
        self.closed = False
        return self

    def execute(self, sql, args):
        self.attempts += 1
        if self.error is not None:
            raise self.error
        if self.failures:
            self.failures -= 1
            self.closed = True
            raise psycopg.OperationalError("connection lost")
        self.log.append((sql.split("(")[0].removeprefix("SELECT "), [getattr(a, "obj", a) for a in args]))

    def close(self):
        self.closed = True


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


@unittest.skipIf(psycopg is None, "psycopg is not installed")
class WriterTest(unittest.TestCase):
    def writer(self, log, failures=0, **options):
        fake = FakeConnection(log, failures)
        connection = writer_module._Connection("dsn", connect=fake, sleep=lambda s: None)
        options.setdefault("flush_seconds", 0)
        options.setdefault("heartbeat_seconds", 0)
        return writer_module.Writer("dsn", "run", connection=connection, **options)

    def test_batches_in_order_and_flushes_on_exit(self):
        log = []
        with self.writer(log, batch_points=2) as w:
            w.open({"title": "t"}, {}, {"total": 0})
            for x in range(5):
                w.add({"x": x})
        self.assertEqual([call for call, _ in log], ["cr.open_run", "cr.put_points", "cr.put_points", "cr.put_points"])
        self.assertEqual([[p["x"] for p in args[1]] for call, args in log[1:]], [[0, 1], [2, 3], [4]])

    def test_points_and_progress_are_snapshots(self):
        log = []
        w = self.writer(log, batch_points=10)
        w.open({}, {}, {})
        point = {"x": 1, "values": {"hw": 1}}
        w.add(point)
        point["x"] = 2
        point["values"]["hw"] = 2
        w.add(point)
        progress = {"total": 2, "completed": 1, "running": 0}
        w.set_progress(progress)
        progress["completed"] = 2
        w.flush()
        _, (_, batch, sent) = log[-1]
        self.assertEqual(batch, [{"x": 1, "values": {"hw": 1}}, {"x": 2, "values": {"hw": 2}}])
        self.assertEqual(sent["completed"], 1)

    def test_pending_progress_flushes_instead_of_heartbeats(self):
        log, clock = [], Clock()
        w = self.writer(log, clock=clock, flush_seconds=30, heartbeat_seconds=10)
        w._timer = object()
        w.open({}, {}, {})
        w.set_progress({"total": 1, "completed": 1, "running": 0})
        clock.now = 15
        w.tick()  # past the heartbeat interval, before the flush deadline
        self.assertEqual(len(log), 1)
        clock.now = 31
        w.tick()
        self.assertEqual(log[-1], ("cr.put_points", ["run", [], {"total": 1, "completed": 1, "running": 0}]))
        clock.now = 42
        w.tick()
        self.assertEqual(log[-1], ("cr.heartbeat", ["run"]))
        w._timer = None

    def test_lost_connection_replays_the_same_batch(self):
        log = []
        w = self.writer(log, batch_points=10)
        w.open({}, {}, {})
        w._connection._connect.failures = 2
        w.add({"x": 1})
        w.flush()
        self.assertEqual(log[-1], ("cr.put_points", ["run", [{"x": 1}], None]))
        self.assertEqual(len(log), 2)

    def test_state_errors_are_not_retried(self):
        sleeps = []
        fake = FakeConnection([], error=psycopg.errors.ObjectNotInPrerequisiteState("run is completed"))
        connection = writer_module._Connection("dsn", connect=fake, sleep=sleeps.append)
        with self.assertRaises(psycopg.errors.ObjectNotInPrerequisiteState):
            connection.call("SELECT cr.heartbeat(%s)", ["run"])
        self.assertEqual(sleeps, [])

    def timed_failure(self, prepare):
        log, clock = [], Clock()
        w = self.writer(log, clock=clock, flush_seconds=30, heartbeat_seconds=300)
        w._timer = object()  # no background thread in tests
        w.open({}, {}, {})
        fake = w._connection._connect
        prepare(w, clock)
        fake.error = psycopg.errors.ObjectNotInPrerequisiteState("run is completed")
        before = fake.attempts
        self.assertFalse(w._timed())
        self.assertEqual(fake.attempts - before, 1)
        with self.assertRaises(psycopg.errors.ObjectNotInPrerequisiteState):
            w.add({"x": 2})
        with self.assertRaises(psycopg.errors.ObjectNotInPrerequisiteState):
            w.__exit__(None, None, None)
        self.assertEqual(fake.attempts - before, 1)  # the batch is not resubmitted
        self.assertTrue(w._stop.is_set())

    def test_timed_serialization_error_reaches_the_producer(self):
        log, clock = [], Clock()
        w = self.writer(log, clock=clock, flush_seconds=30, heartbeat_seconds=300)
        w._timer = object()
        w.open({}, {}, {})
        w._connection._connect.error = TypeError("Object of type set is not JSON serializable")
        w.add({"x": {1}})
        clock.now = 31
        self.assertFalse(w._timed())
        with self.assertRaises(TypeError):
            w.add({"x": 2})
        with self.assertRaises(TypeError):
            w.__exit__(None, None, None)
        self.assertTrue(w._stop.is_set())

    def test_rejected_batch_in_a_with_block_is_sent_once(self):
        log = []
        error = psycopg.errors.InvalidParameterValue("point 1: undeclared group")
        with self.assertRaises(psycopg.errors.InvalidParameterValue) as raised:
            with self.writer(log, batch_points=2) as w:
                w.open({}, {}, {})
                fake = w._connection._connect
                fake.error = error
                w.add({"x": 1})
                w.add({"x": 2})  # size-triggered flush, rejected
        self.assertIs(raised.exception, error)
        self.assertEqual(fake.attempts, 2)  # open_run, then put_points once

    def test_unrelated_exceptions_still_flush_on_exit(self):
        log = []
        with self.assertRaises(KeyError):
            with self.writer(log, batch_points=10) as w:
                w.open({}, {}, {})
                w.add({"x": 1})
                raise KeyError("producer bug")
        self.assertEqual(log[-1][0], "cr.put_points")

    def test_timed_flush_failure_reaches_the_producer(self):
        def prepare(w, clock):
            w.add({"x": 1})
            clock.now = 31

        self.timed_failure(prepare)

    def test_heartbeat_failure_reaches_the_producer(self):
        def prepare(w, clock):
            clock.now = 301

        self.timed_failure(prepare)

    def test_progress_goes_with_the_next_batch(self):
        log = []
        w = self.writer(log)
        w.open({}, {}, {})
        w.set_progress({"total": 3, "completed": 1, "running": 0})
        w.flush()
        self.assertEqual(log[-1][1][2], {"total": 3, "completed": 1, "running": 0})

    def test_tick_flushes_due_points_and_heartbeats_when_idle(self):
        log, clock = [], Clock()
        w = self.writer(log, clock=clock, flush_seconds=30, heartbeat_seconds=300)
        w._timer = object()  # no background thread in tests
        w.open({}, {}, {})
        w.add({"x": 1})
        clock.now = 10
        w.tick()
        self.assertEqual(len(log), 1)
        clock.now = 31
        w.tick()
        self.assertEqual(log[-1][0], "cr.put_points")
        clock.now = 200
        w.tick()
        self.assertEqual(log[-1][0], "cr.put_points")
        clock.now = 332
        w.tick()
        self.assertEqual(log[-1], ("cr.heartbeat", ["run"]))
        w._timer = None


@unittest.skipIf(psycopg is None or not DSN, "set CR_TEST_DSN to a migrated database")
class ImportTest(unittest.TestCase):
    def test_import_example_report(self):
        key = "python-import-test"
        with psycopg.connect(DSN, autocommit=True) as conn:
            conn.execute("DELETE FROM cr.runs WHERE key = %s", (key,))
        writer_module.main(["import", str(ROOT / "examples" / "data.json"), "--run", key, "--dsn", DSN])
        with psycopg.connect(DSN) as conn:
            state, points = conn.execute(
                "SELECT state, (SELECT count(*) FROM cr.points p JOIN cr.plots pl ON pl.id = p.plot_id"
                " WHERE pl.run_id = r.id) FROM cr.runs r WHERE key = %s",
                (key,),
            ).fetchone()
        self.assertEqual((state, points), ("completed", 2))

    def test_import_into_a_completed_run_fails_fast(self):
        key = "python-completed-test"
        with psycopg.connect(DSN, autocommit=True) as conn:
            conn.execute("DELETE FROM cr.runs WHERE key = %s", (key,))
        args = ["import", str(ROOT / "examples" / "data.json"), "--run", key, "--dsn", DSN]
        writer_module.main(args)
        started = time.monotonic()
        with self.assertRaises(SystemExit) as stop:
            writer_module.main(args)
        self.assertEqual(stop.exception.code, 1)
        self.assertLess(time.monotonic() - started, 0.9)  # the first backoff is 1 s

    def test_import_checks_the_file_before_creating_the_run(self):
        data = json.loads((ROOT / "examples" / "data.json").read_text())
        cases = [
            {**data, "data": {}},
            [],
            {k: v for k, v in data.items() if k != "progress"},
            {**data, "extra": 1},
        ]
        for i, bad in enumerate(cases):
            key = "python-envelope-%d" % i
            path = ROOT / "tests" / ("envelope-%d.tmp.json" % i)
            path.write_text(json.dumps(bad))
            self.addCleanup(path.unlink)
            with self.assertRaises(SystemExit) as stop:
                writer_module.main(["import", str(path), "--run", key, "--dsn", DSN])
            self.assertEqual(stop.exception.code, 1)
            with psycopg.connect(DSN) as conn:
                self.assertIsNone(conn.execute("SELECT 1 FROM cr.runs WHERE key = %s", (key,)).fetchone())
        empty = ROOT / "tests" / "envelope-empty.tmp.json"
        empty.write_text(json.dumps({**data, "data": []}))
        self.addCleanup(empty.unlink)
        key = "python-envelope-empty"
        with psycopg.connect(DSN, autocommit=True) as conn:
            conn.execute("DELETE FROM cr.runs WHERE key = %s", (key,))
        writer_module.main(["import", str(empty), "--run", key, "--dsn", DSN])
        with psycopg.connect(DSN) as conn:
            state = conn.execute("SELECT state FROM cr.runs WHERE key = %s", (key,)).fetchone()
        self.assertEqual(state, ("completed",))

    def test_validation_errors_are_readable(self):
        bad = ROOT / "tests" / "bad-report.tmp.json"
        data = json.loads((ROOT / "examples" / "data.json").read_text())
        data["data"][0]["group"] = "nope"
        bad.write_text(json.dumps(data))
        self.addCleanup(bad.unlink)
        with self.assertRaises(SystemExit) as stop:
            writer_module.main(["import", str(bad), "--run", "python-bad-test", "--dsn", DSN])
        self.assertEqual(stop.exception.code, 1)


if __name__ == "__main__":
    unittest.main()
