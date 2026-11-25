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

    def __call__(self, dsn, autocommit):
        self.closed = False
        return self

    def execute(self, sql, args):
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
