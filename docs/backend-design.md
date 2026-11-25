# Backend design: hosted reports on Netlify

Status: proposal for review. Nothing in this document is implemented yet.

## 1. Goals and non-goals

Today a report is one `data.json` file. The viewer downloads all of it (`useReport` in `site/App.jsx` fetches `./data.json`) and builds every view in the browser (`indexReport` in `site/model.js`). Two problems follow:

1. **Size.** A release-scale MGPUSim report has about 450,000 points and its `data.json` exceeds 100 MB. Every viewer downloads and parses the whole file, and every live refresh downloads it again.
2. **Latency.** Simulators run in GitHub Actions jobs that last hours and publish `data.json` as a workflow artifact when the job ends. Nobody can see partial results while a run is in progress. The live mode of `serve.py` only helps when the producer and the viewer share a machine.

Goals:

- Producers write results to a hosted database **while they run**, so partial results are visible within seconds.
- The viewer fetches only what the current page needs. The accuracy summaries stay exact over all comparisons.
- Several simulators (MGPUSim, Poros, ...) report to one site, and each run has a stable URL.
- No machine of ours to maintain: hosting, database, and API live on the Netlify team that is already on the Open Source plan.
- `data.json` and `data.schema.json` stay the interchange format. A run can be imported from and exported to `data.json`, and the static viewer keeps working offline.

Non-goals for this iteration:

- Archiving finished runs to object storage (for example, Cloudflare R2 summaries and shards). Revisit only if database storage becomes expensive.
- Self-hosting on lab machines.
- Editing results in the browser, authenticated viewing, and cross-run comparison views.

## 2. Architecture

```
GitHub Actions job (simulator repo)                         browser
  │  Python writer client                                     │  viewer (static build of site/)
  │  calls cr.open_run / cr.put_points / cr.finish_run        │  GET /api/...
  ▼  over Postgres, role cr_ingest                            ▼
┌──────────────────────── Netlify team (Open Source plan) ────────────────────────┐
│  Netlify Database (Postgres, schema cr)  ◄── read-only transactions ── Netlify Functions │
│                                                                   static hosting of dist/ │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- **Netlify Database** stores every run ([overview](https://docs.netlify.com/build/data-and-storage/netlify-database/)). Schema changes are SQL migrations in `netlify/database/migrations/`, applied by Netlify before each production deploy is published ([migrations](https://docs.netlify.com/build/data-and-storage/netlify-database/migrations/)).
- **Producers write directly to the database.** There is no write API. A runner connects with a dedicated `cr_ingest` login whose only privilege is executing three SQL functions (§4).
- **Netlify Functions are read-only.** They query through `getDatabase()` from `@netlify/database` ([API](https://docs.netlify.com/build/data-and-storage/netlify-database/api/)). Every query runs inside `BEGIN READ ONLY`, because the platform-provided connection is the owner role. Functions accept only `GET`.
- **The viewer** is the existing Vite build, deployed by Netlify. It gains an API data source next to the existing `data.json` source (§6).

## 3. Database schema

One row per declared entity, with surrogate keys to keep the large tables narrow. Composite foreign keys make every cross-reference rule from the README a database constraint, except the two rules listed after the DDL. A `plot` is one chart: one group, one benchmark, and one combination of non-scaling parameter values. This is the "series" level that the viewer pages through.

```sql
CREATE SCHEMA cr;

CREATE TABLE cr.runs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key         text NOT NULL UNIQUE CHECK (key ~ '^[A-Za-z0-9._/-]{1,200}$'),
  title       text NOT NULL CHECK (title <> ''),
  description text NOT NULL DEFAULT '',
  state       text NOT NULL DEFAULT 'running'
              CHECK (state IN ('running', 'completed', 'failed')),
  progress    jsonb NOT NULL CHECK (jsonb_typeof(progress) = 'object'),  -- data.json "progress", verbatim
  revision    bigint NOT NULL DEFAULT 0,   -- incremented by every write call
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cr.groups (
  id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES cr.runs ON DELETE CASCADE,
  key    text NOT NULL CHECK (key <> ''),
  name   text NOT NULL CHECK (name <> ''),
  UNIQUE (run_id, key),
  UNIQUE (id, run_id)
);

CREATE TABLE cr.benchmarks (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id        bigint NOT NULL REFERENCES cr.runs ON DELETE CASCADE,
  key           text NOT NULL CHECK (key <> ''),
  scaling_param text NOT NULL,
  UNIQUE (run_id, key),
  UNIQUE (id, run_id)
);

CREATE TABLE cr.params (
  benchmark_id bigint NOT NULL REFERENCES cr.benchmarks ON DELETE CASCADE,
  key          text NOT NULL CHECK (key <> ''),
  unit         text NOT NULL,
  PRIMARY KEY (benchmark_id, key)
);

-- Rule: the scaling parameter is a declared parameter. Deferred so that a
-- benchmark and its parameters can be inserted in one transaction.
ALTER TABLE cr.benchmarks
  ADD FOREIGN KEY (id, scaling_param) REFERENCES cr.params (benchmark_id, key)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE cr.series (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  benchmark_id bigint NOT NULL REFERENCES cr.benchmarks ON DELETE CASCADE,
  key          text NOT NULL CHECK (key <> ''),
  name         text NOT NULL CHECK (name <> ''),
  unit         text NOT NULL,
  role         text CHECK (role IN ('hardware_measurement', 'simulator_output')),
  UNIQUE (benchmark_id, key),
  UNIQUE (id, benchmark_id)
);

CREATE TABLE cr.plots (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id       bigint NOT NULL,
  group_id     bigint NOT NULL,
  benchmark_id bigint NOT NULL,
  params       jsonb NOT NULL,  -- data.json "non_scaling_params"
  CHECK (jsonb_typeof(params) = 'object'),
  CHECK (NOT jsonb_path_exists(params, 'strict $.* ? (@.type() != "number" && @.type() != "string" && @.type() != "boolean")')),
  -- Rule: a point names a declared group and benchmark of the same run.
  FOREIGN KEY (group_id, run_id) REFERENCES cr.groups (id, run_id) ON DELETE CASCADE,
  FOREIGN KEY (benchmark_id, run_id) REFERENCES cr.benchmarks (id, run_id) ON DELETE CASCADE,
  UNIQUE (group_id, benchmark_id, params),
  UNIQUE (id, benchmark_id)
);

CREATE TABLE cr.points (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plot_id      bigint NOT NULL,
  benchmark_id bigint NOT NULL,
  x            double precision NOT NULL CHECK (x NOT IN ('NaN', 'Infinity', '-Infinity')),
  revision     bigint NOT NULL,  -- run revision of the last write to this point
  FOREIGN KEY (plot_id, benchmark_id) REFERENCES cr.plots (id, benchmark_id) ON DELETE CASCADE,
  -- Rule: group, benchmark, x and non-scaling values appear at most once
  -- (together with the plots UNIQUE above).
  UNIQUE (plot_id, x),
  UNIQUE (id, benchmark_id)
);

-- One row per (point, series): the point's entry in "values" and/or "statuses".
CREATE TABLE cr.observations (
  point_id     bigint NOT NULL,
  benchmark_id bigint NOT NULL,
  series_id    bigint NOT NULL,
  in_values    boolean NOT NULL,  -- key present in "values" (its value may be null)
  value        double precision CHECK (value NOT IN ('NaN', 'Infinity', '-Infinity')),
  state        text CHECK (state IN ('queued', 'running', 'failed', 'verification_failed',
                                     'timeout', 'memory_limit', 'unsupported')),
  reason       text CHECK (reason <> ''),
  symbol       text CHECK (symbol <> ''),
  PRIMARY KEY (point_id, series_id),
  FOREIGN KEY (point_id, benchmark_id) REFERENCES cr.points (id, benchmark_id) ON DELETE CASCADE,
  -- Rule: every series key in values/statuses is declared by the point's benchmark.
  FOREIGN KEY (series_id, benchmark_id) REFERENCES cr.series (id, benchmark_id) ON DELETE CASCADE,
  CHECK (in_values OR value IS NULL),
  CHECK (in_values OR state IS NOT NULL),
  CHECK (state IS NOT NULL OR (reason IS NULL AND symbol IS NULL))
);

CREATE INDEX ON cr.plots (run_id, group_id, benchmark_id);
CREATE INDEX ON cr.points (revision);
```

Two rules cannot be expressed as constraints, because each compares a row with a set of rows. `cr.put_points` checks both and rejects the whole batch if either fails:

- `non_scaling_params` has exactly the declared parameters other than the scaling parameter.
- `values` has at least one key (`minProperties: 1` in `data.schema.json`).

`cr.open_run` also rejects metadata that contradicts what is already stored: a changed unit, role, or scaling parameter, or a renamed group. Such a change would silently reinterpret points that are already stored. Adding new groups, benchmarks, parameters, or series is allowed.

The DDL was checked on PostgreSQL 17: it loads cleanly, and duplicate points (including `10` versus `10.0` in parameters), undeclared scaling parameters, non-scalar parameter values, and a value outside `values` are rejected.

Storage estimate: 450,000 points with two to three series each is about 1 million observation rows. With indexes that is roughly 100 MB per run, or about 3 GB for 30 runs.

## 4. Write protocol

### Roles

| Role | Created by | Privileges |
|---|---|---|
| owner (Netlify-provisioned) | Netlify | everything; used by migrations and, inside read-only transactions, by Functions |
| `cr_ingest` (login) | migration creates it `NOLOGIN`; the team owner runs `ALTER ROLE cr_ingest LOGIN PASSWORD ...` once by hand | `USAGE` on schema `cr`; `EXECUTE` on `cr.open_run`, `cr.put_points`, `cr.finish_run` only |
| `cr_reader` (login, optional) | same manual step | `SELECT` on schema `cr`; used by the export command |

The three functions are `SECURITY DEFINER` with `SET search_path = cr, pg_temp`, and `EXECUTE` is revoked from `PUBLIC`. `cr_ingest` has no table privileges, so a leaked ingest credential can add or overwrite results but cannot read other data, delete runs, or change the schema. Passwords never enter the repository. The connection string is stored once as a **GitHub organization secret** (for example `CALIBRATION_REPORT_DSN`) and granted to the simulator repositories that report.

### Functions

Their arguments reuse the `data.json` shapes, so producers depend on the documented format, not on table layout.

| Call | Arguments | Effect |
|---|---|---|
| `cr.open_run(run_key, report, benchmarks, progress)` | `report` and `benchmarks` objects from `data.json` (`report.live` is ignored) | Creates the run in state `running`, or adds metadata to an existing `running` run. Rejects contradictory metadata and runs that already finished. |
| `cr.put_points(run_key, points, progress)` | array of `data.json` points; optional `progress` object | Upserts plots, points, and observations in one transaction, checks the two non-constraint rules, replaces `progress` when given, increments `revision`, and stamps the touched points with the new revision. |
| `cr.finish_run(run_key, state, progress)` | `state` is `completed` or `failed` | Sets the final state and progress. Further writes are rejected. |

Upsert semantics: a point is identified by `(group, benchmark, non_scaling_params, x)`. Each series key in the batch replaces that series' observation, so a `running` status can later become a value. Series that are absent from the batch keep their stored observation. Replaying a batch therefore leaves the same data, and a client may retry a batch whose commit outcome is unknown. A retry only increments `revision` once more, which costs one extra viewer refresh.

Concurrency: matrix jobs of one workflow may write to the same run at the same time. Unique constraints with `ON CONFLICT` make concurrent upserts safe. The `revision` update serializes commits on one run row, which is acceptable for batches that arrive seconds apart. `progress` is last-writer-wins. With matrix jobs only one job, or a final aggregation step, should send it.

Lifecycle: `open_run`, then any number of `put_points`, then `finish_run`. A job that dies never calls `finish_run`. The API reports a `running` run with `stale: true` when `updated_at` is more than 30 minutes old. Nothing changes state automatically.

### Python writer client (to be written)

A single module, for example `clients/python/calibration_report_writer.py`, depending only on `psycopg` 3:

```python
with Writer(os.environ["CALIBRATION_REPORT_DSN"], run_key="mgpusim/mi300x/2026-11-25-434ad66") as w:
    w.open(report, benchmarks, progress)
    for point in results():          # data.json point dicts
        w.add(point)                 # buffered; flushes every 2,000 points or 30 s
    w.progress(progress)             # sent with the next flush
# leaving the block flushes and calls finish_run("completed"), or "failed" on an exception
```

It retries a failed flush with backoff. The first connection after the database has slept can take a few seconds. The same module provides `import data.json --run KEY` (the same three calls) and `export --run KEY > data.json` (reads with `cr_reader`).

### Cost of writing directly to the database

This design has producers write directly instead of going through a write API. It accepts these costs:

- Every reporting repository needs a Postgres driver and network access to the database host, and it holds a database credential. The organization secret keeps rotation to one place.
- Validation errors surface as Postgres exceptions, not HTTP errors. The client has to turn them into readable messages.
- Netlify request logs, rate limits, and Functions do not see writes. A runaway producer is limited only by the database itself.
- The three function signatures are the contract. Changing them breaks producers that pin an old client, so incompatible changes need new function names (for example `put_points_v2`), with the old ones kept for a while.

Accepting only the `data.json` shapes, and granting only `EXECUTE`, keeps the coupling no wider than a write API would have.

## 5. Read API

Every endpoint is a Netlify Function at `/api/...`, runs one read-only transaction, and returns JSON. Every response carries `ETag: "<run id>-<revision>"` and answers a matching `If-None-Match` with `304`. While a run is `running`, responses are `Cache-Control: no-cache`. After a run finishes, the viewer adds `rev=<revision>` from the manifest to every data request, and those responses are `Cache-Control: public, max-age=31536000, immutable`, so the CDN serves repeat visits without waking the database.

| Endpoint | Returns | Used for |
|---|---|---|
| `GET /api/runs` | `[{key, title, state, stale, progress, updated_at}]`, newest first | run list on the site root |
| `GET /api/runs/{key}` | manifest (below) | header, progress, tabs, benchmark-level pagination, live polling |
| `GET /api/runs/{key}/plots?group=&benchmark=&offset=&limit=` | `{total, plots: [{id, non_scaling_params, rows: [point]}]}` with `data.json` points | series-level pagination inside one benchmark card |
| `GET /api/runs/{key}/measurements?group=[&since=REV]` | columnar measurements (below) | Overview and per-group summaries, benchmark-wide error |
| `GET /api/runs/{key}/points/{plot}/{x}` | one full `data.json` point | point details opened from a summary chart |

Manifest:

```json
{
  "revision": 418,
  "state": "running", "stale": false, "updated_at": "2026-11-25T16:20:00Z",
  "report": {"title": "...", "description": "...", "live": true, "groups": {"mi300x": {"name": "AMD MI300X"}}},
  "progress": {"total": 450000, "completed": 212000, "running": 32},
  "benchmarks": {"polybench_fdtd2d": {"scaling_param": "size", "params": {}, "values": {}}},
  "plots": {"mi300x": {"polybench_fdtd2d": 1184}}
}
```

`report`, `progress`, and `benchmarks` have exactly the `data.json` shapes. `plots[group][benchmark]` counts the plots that have at least one finite value or one visible status. This is the same filter that `indexReport` applies to rows, so page counts match the static viewer. The manifest is small: groups × benchmarks, independent of point count.

Measurements contain every hardware-measurement and simulator-output value of one group. They are not pre-paired:

```json
{
  "revision": 418, "group": "mi300x",
  "benchmarks": ["polybench_fdtd2d"],
  "series": [["mi300x", "mgpusim"]],
  "benchmark": [0, 0, 0],
  "plot": [17, 17, 18],
  "x": [64, 128, 64],
  "values": [[57889, 79339], [103715, null], [61000, 70100]]
}
```

`benchmark[i]` indexes `benchmarks`, and `values[i]` is aligned with that benchmark's entry in `series` (its series that declare a `role`). The viewer rebuilds lightweight rows `{group, benchmark, x, plot, values}` from these columns and passes them to the existing `comparisonPairs(rows, benchmarks)`. Pairing rules (role, matching unit, exactly one hardware reference), signed error, and the statistics (`errorStats`, `rankStatistics`, and `rankingStats`) therefore stay in one place, `site/model.js`, and are not duplicated in SQL. At about 450,000 points with two values each, the payload is roughly 15–20 MB of JSON before compression and about 4–6 MB gzip-compressed. The Overview fetches every group in parallel and concatenates the rows. With `since=REV` the endpoint returns only points written after that revision, and the viewer merges them by `(plot, x)`. A live refresh therefore costs a few kilobytes, not the whole payload.

Function cost stays small. No endpoint computes statistics. The manifest and `plots` queries are indexed lookups. `measurements` is one indexed scan per request, and it is requested in full only once per group per finished run, because later requests hit the CDN cache.

## 6. Viewer changes and `data.json` compatibility

The viewer gains a data source interface with two implementations:

- **API source**, used when the URL names a run (`/runs/{key}`; the site root lists runs). It loads the manifest, polls it every 10 s with `If-None-Match` only while `report.live` is true (the same condition `useReport` uses today), and on a new revision fetches `measurements?since=` and the visible `plots` pages.
- **File source**, used when there is no run in the URL and `./data.json` exists. This is today's behavior. It implements the same interface in memory with `indexReport`, so `npm run dev`, `serve.py`, and GitHub Pages hosting keep working unchanged.

`Report` then consumes the interface. Summaries take pairs from `comparisonPairs` over the measurement rows. Benchmark cards take counts from the manifest and rows from `plots` pages, and `pageWindow` clamping uses the manifest counts. In API mode a summary pair's `point` is a lightweight row, so `PointDetails` loads the full point from `/points/{plot}/{x}` when a pair from a summary chart is opened. Benchmark-card points are already complete.

Import and export mapping (both directions; field order and array order are not significant):

| `data.json` | Database |
|---|---|
| `report.title`, `report.description` | `runs.title`, `runs.description` |
| `report.live` | `runs.state = 'running'` on export; ignored on import (an imported file becomes `completed` unless `--live` is passed) |
| `report.groups.{key}.name` | `groups(key, name)` |
| `progress` (all fields) | `runs.progress`, verbatim |
| `benchmarks.{key}.scaling_param` | `benchmarks(key, scaling_param)` |
| `benchmarks.{key}.params.{p}.unit` | `params(key = p, unit)` |
| `benchmarks.{key}.values.{s}` `{name, unit, role}` | `series(key = s, name, unit, role)` |
| `data[i].group`, `.benchmark`, `.non_scaling_params` | `plots(group_id, benchmark_id, params)` |
| `data[i].x` | `points.x` |
| `data[i].values.{s} = v` (number or null) | `observations(series s, in_values = true, value = v)` |
| `data[i].statuses.{s}` `{state, reason, symbol}` | same observation row's `state`, `reason`, `symbol`; `in_values = false` when `s` is not in `values` |

`export(import(file))` equals `file` up to object key order, array order, and number spelling (for example `1.0` becomes `1`). The exported file validates against `data.schema.json` unchanged.

## 7. Cost

Rates in Netlify credits ([how credits work](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/), [database billing](https://docs.netlify.com/build/data-and-storage/netlify-database/billing-and-usage/)): database compute is 10 credits per compute-unit hour, and the database sleeps after 5 idle minutes. Database bandwidth is 20 credits per GB. Function compute is 10 credits per GB-hour. Web bandwidth is 20 credits per GB. Web requests cost 2 credits per 10,000. Database storage is currently free. The team's Open Source plan grants 10,000 credits per month at no charge, and 106 had been used in the current period when this was written.

Assume three runs per month (tens per year), each about 6 hours long and viewed live.

| Item | Estimate | Credits / month |
|---|---|---|
| Database awake while runs write (1 CU × 6 h × 3) | 18 CU-h | 180 |
| Database woken by viewers of finished runs (≈5 min each, 100 visits) | 8 CU-h | 80 |
| Measurements leaving the database (≈30 MB per uncached full load, 20 loads) | 0.6 GB | 12 |
| Function compute (≈2 s at 1 GB per full measurements request, plus small requests) | < 0.1 GB-h | < 1 |
| Web bandwidth (≈5 MB per page load, 200 loads, plus live deltas) | 1–2 GB | 20–40 |
| Requests (one poll per 10 s per live viewer, plus page loads) | < 100,000 | < 20 |
| **Total** | | **≈ 300–350** |

This is about 3% of the monthly grant. The dominant term is the database staying awake during runs, which grows linearly with run-hours: even ten times the assumed load stays under the grant. Storage, about 100 MB per run, is free today. Section 8 covers what happens when it starts to be billed.

## 8. Risks to verify before implementation

1. **External connections.** Confirm that a GitHub-hosted runner can connect to the production database with the copied connection string ([access control](https://docs.netlify.com/build/data-and-storage/netlify-database/access-control/) shows only Team Owners can copy a read-write one), that the owner can create the `cr_ingest` and `cr_reader` logins, and whether a pooled endpoint exists for many short-lived connections. Measure the first-connect latency after the database has slept. Also confirm whether deploy-preview database branches copy these roles. If they do not, previews get no ingest access, which is acceptable.
2. **Plan limits.** The database limits table lists Free, Personal, Pro, and Enterprise, but not Open Source ([limits](https://docs.netlify.com/build/data-and-storage/netlify-database/billing-and-usage/#limits)). If Open Source maps to Free, the 5 GB storage cap and the **48 compute-unit hours per month** cap would bind: three 6-hour runs already use 18 CU-h, and viewers add more. Ask Netlify support which column applies before building.
3. **Storage billing.** Storage is free "for now", and Netlify says rates will be announced in advance. At about 100 MB per run the archive grows by a few GB per year. If the announced rate makes that expensive, revive the deferred R2 archive (finished runs exported as summary plus shards, then deleted from the database).
4. **Direct-write coupling.** See §4. Revisit if more than a handful of repositories report, or if credentials need per-producer scoping. A thin write Function could front the same three SQL functions without a schema change.
5. **Measurement payload and function response limits.** About 4–6 MB compressed per group must be returned by a Function. Confirm the current Functions response-size limit and whether the response must be streamed. Splitting by group (already in the design) and `since=` deltas keep individual responses bounded. If the limit is still a problem, the next step is to page measurements by benchmark, not to drop exact statistics.
6. **Deploy previews copy production data.** Each deploy preview gets a database branch with a copy of production data ([branching](https://docs.netlify.com/build/data-and-storage/netlify-database/#database-branching)). Confirm that copying several GB per preview is cheap (copy-on-write), or disable previews' database access.
