"""Write calibration results to a hosted report database while a job runs.

See docs/backend-design.md §4. The database role used here may only call
cr.open_run, cr.put_points, cr.heartbeat, and cr.finish_run, which take
data.json-shaped arguments. Depends only on psycopg 3.

    with Writer(os.environ["CALIBRATION_REPORT_DSN"], run_key) as w:
        w.open(report, benchmarks, progress)
        for point in results():
            w.add(point)
    # leaving the block only flushes; it never finishes the run

    finish_run(dsn, run_key, "completed", progress)  # in the finalizer job only

Command line:  python3 calibration_report_writer.py import data.json --run KEY [--live]
"""

import argparse
import json
import os
import sys
import threading
import time

import psycopg
from psycopg.types.json import Json

BATCH_POINTS = 2000
FLUSH_SECONDS = 30
HEARTBEAT_SECONDS = 300
RETRIES = 6


class _Connection:
    """One autocommit connection; a call whose outcome is unknown is replayed."""

    def __init__(self, dsn, connect=psycopg.connect, sleep=time.sleep, retries=RETRIES):
        self._dsn = dsn
        self._connect = connect
        self._sleep = sleep
        self._retries = retries
        self._conn = None

    def call(self, sql, args):
        for attempt in range(self._retries + 1):
            try:
                if self._conn is None or self._conn.closed:
                    self._conn = self._connect(self._dsn, autocommit=True)
                self._conn.execute(sql, args)
                return
            except psycopg.Error as error:
                # Only a lost connection leaves the outcome unknown; validation
                # and state errors (22023, 55000, ...) are final.
                if not self._outcome_unknown(error):
                    raise
                # The call may have committed: every call is safe to replay
                # (docs/backend-design.md §4, retries).
                self.close()
                if attempt == self._retries:
                    raise
                self._sleep(min(60, 2**attempt))

    def _outcome_unknown(self, error):
        state = getattr(error, "sqlstate", None)
        if state:
            # connection_exception (08) and operator intervention such as
            # admin_shutdown (57P).
            return state.startswith(("08", "57P"))
        conn = self._conn
        return conn is None or conn.closed or bool(getattr(conn, "broken", False))

    def close(self):
        if self._conn is not None:
            try:
                self._conn.close()
            except psycopg.Error:
                pass
            self._conn = None


class Writer:
    """Buffers this job's points and sends them in order, one batch at a time.

    Flushes at `batch_points` points or `flush_seconds` after the last write,
    and sends a heartbeat after `heartbeat_seconds` without writes.
    """

    def __init__(
        self,
        dsn,
        run_key,
        *,
        batch_points=BATCH_POINTS,
        flush_seconds=FLUSH_SECONDS,
        heartbeat_seconds=HEARTBEAT_SECONDS,
        connection=None,
        clock=time.monotonic,
    ):
        self.run_key = run_key
        self._connection = connection or _Connection(dsn)
        self._batch_points = batch_points
        self._flush_seconds = flush_seconds
        self._heartbeat_seconds = heartbeat_seconds
        self._clock = clock
        self._lock = threading.RLock()  # one batch in flight
        self._buffer = []
        self._progress = None
        self._last_write = clock()
        self._opened = False
        self._stop = threading.Event()
        self._timer = None
        self._error = None  # terminal error of a flush or heartbeat

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if self._error is not None:
            # A batch was rejected: do not resubmit it.
            self._stop_timer()
            self._connection.close()
            if exc_type is None:
                raise self._error
            return
        self.close()

    def _check(self):
        if self._error is not None:
            raise self._error

    def open(self, report, benchmarks, progress):
        with self._lock:
            self._connection.call(
                "SELECT cr.open_run(%s, %s, %s, %s)",
                (self.run_key, Json(report), Json(benchmarks), Json(progress)),
            )
            self._last_write = self._clock()
            self._opened = True
        if self._timer is None and (self._flush_seconds or self._heartbeat_seconds):
            self._timer = threading.Thread(target=self._background, daemon=True)
            self._timer.start()

    def add(self, point):
        with self._lock:
            self._check()
            self._buffer.append(point)
            if len(self._buffer) >= self._batch_points:
                self.flush()

    def set_progress(self, progress):
        """Sent with the next batch; only the run's progress writer calls this."""
        with self._lock:
            self._progress = progress

    def flush(self):
        with self._lock:
            self._check()
            if not self._buffer and self._progress is None:
                return
            batch, progress = self._buffer, self._progress
            try:
                # Replays a lost outcome itself; anything raised is terminal.
                self._connection.call(
                    "SELECT cr.put_points(%s, %s, %s)",
                    (self.run_key, Json(batch), None if progress is None else Json(progress)),
                )
            except Exception as error:
                self._error = error
                raise
            self._buffer, self._progress = [], None
            self._last_write = self._clock()

    def tick(self):
        """Flushes or heartbeats when due; the background thread calls it."""
        with self._lock:
            if not self._opened:
                return
            idle = self._clock() - self._last_write
            if (self._buffer or self._progress is not None) and idle >= self._flush_seconds:
                self.flush()
            elif not self._buffer and idle >= self._heartbeat_seconds:
                self._connection.call("SELECT cr.heartbeat(%s)", (self.run_key,))
                self._last_write = self._clock()

    def _timed(self):
        """One step of timed work. Any error (the connection already retried
        lost outcomes; others include serialization errors) is saved for the
        producer and stops timed work; the rejected batch is not resubmitted."""
        with self._lock:
            try:
                self.tick()
            except Exception as error:  # noqa: BLE001 - the producer gets it
                self._error = error
                self._stop.set()
                return False
        return True

    def _background(self):
        period = max(1, min(self._flush_seconds or 60, self._heartbeat_seconds or 60) / 4)
        while not self._stop.wait(period) and self._timed():
            pass

    def _stop_timer(self):
        self._stop.set()
        if isinstance(self._timer, threading.Thread):
            self._timer.join()
        self._timer = None

    def close(self):
        self._stop_timer()
        try:
            self.flush()
        finally:
            self._connection.close()


def finish_run(dsn, run_key, state, progress=None, connection=None):
    """Marks the run completed or failed. Call from exactly one finalizer job."""
    connection = connection or _Connection(dsn)
    try:
        connection.call(
            "SELECT cr.finish_run(%s, %s, %s)",
            (run_key, state, None if progress is None else Json(progress)),
        )
    finally:
        connection.close()


class ReportFileError(ValueError):
    """The file is not a data.json object."""


def _check_envelope(data):
    if not isinstance(data, dict):
        raise ReportFileError("the file must contain a JSON object")
    members = ("report", "benchmarks", "progress", "data")
    missing = [k for k in members if k not in data]
    if missing:
        raise ReportFileError("missing top-level member(s): " + ", ".join(missing))
    unknown = sorted(k for k in data if k not in members)
    if unknown:
        raise ReportFileError("unknown top-level member(s): " + ", ".join(unknown))
    if not isinstance(data["data"], list):
        raise ReportFileError("data must be an array")


def import_report(dsn, path, run_key, live=False, batch_points=BATCH_POINTS):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    _check_envelope(data)  # before open_run creates the run
    writer = Writer(dsn, run_key, batch_points=batch_points, flush_seconds=0, heartbeat_seconds=0)
    with writer:
        writer.open(data["report"], data["benchmarks"], data["progress"])
        for point in data["data"]:
            writer.add(point)
    if not live:
        finish_run(dsn, run_key, "completed", data["progress"])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    importer = commands.add_parser("import", help="import a data.json file as a run")
    importer.add_argument("file")
    importer.add_argument("--run", required=True, help="run key")
    importer.add_argument("--live", action="store_true", help="leave the run running")
    importer.add_argument(
        "--dsn",
        default=os.environ.get("CALIBRATION_REPORT_DSN"),
        help="connection string (default: $CALIBRATION_REPORT_DSN)",
    )
    args = parser.parse_args(argv)
    if not args.dsn:
        parser.error("--dsn or CALIBRATION_REPORT_DSN is required")
    try:
        import_report(args.dsn, args.file, args.run, live=args.live)
    except psycopg.Error as error:
        parser.exit(1, "import failed: %s\n" % (error.diag.message_primary or error))
    except (ValueError, OSError) as error:  # file envelope and JSON syntax errors
        parser.exit(1, "import failed: %s\n" % error)


if __name__ == "__main__":
    main()
