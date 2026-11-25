# Backend design: hosted reports on Netlify

Status: proposal for review. Nothing in this document is implemented yet.

## 1. Goals and non-goals

Today a report is one `data.json` file. The viewer downloads all of it (`useReport` in `site/App.jsx` fetches `./data.json`) and builds every view in the browser (`indexReport` in `site/model.js`). Two problems follow:

1. **Size.** A release-scale MGPUSim report has about 450,000 points and its `data.json` exceeds 100 MB. Every viewer downloads and parses the whole file, and every live refresh downloads it again.
2. **Latency.** Simulators run in GitHub Actions jobs that last hours and publish `data.json` as a workflow artifact when the job ends. Nobody can see partial results while a run is in progress. The live mode of `serve.py` only helps when the producer and the viewer share a machine.

Goals:

- Producers write results to a hosted database **while they run**, so partial results are visible within about a minute.
- The viewer fetches only what the current page needs. **Summary statistics are exact over all comparisons; summary charts are drawn from a bounded sample** that the page labels as such.
- Several simulators (MGPUSim, Poros, ...) report to one site, and each run has a stable URL.
- No machine of ours to maintain: hosting, database, and API live on the Netlify team that is already on the Open Source plan.
- `data.json` and `data.schema.json` stay the interchange format. A run can be imported from and exported to `data.json`, and the static viewer keeps working offline.

Non-goals for this iteration:

- Archiving finished runs to object storage (for example, Cloudflare R2). Revisit only if database storage becomes expensive.
- Self-hosting on lab machines.
- Editing results in the browser, authenticated viewing, and cross-run comparison views.

## 2. Architecture

```
GitHub Actions job (simulator repo)                              browser
  │  Python writer client                                          │  viewer (static build of site/)
  │  calls cr.open_run / put_points / heartbeat / finish_run       │  GET /api/...
  ▼  over Postgres, role cr_ingest                                 ▼
┌───────────────────────────── Netlify team (Open Source plan) ─────────────────────────────┐
│  Netlify Database (Postgres, schema cr) ◄── read-only transactions ── Netlify Functions     │
│                                                                       │  summary cache      │
│                                                                       ▼                     │
│                                                    Netlify Blobs (store "summaries")        │
│                                                    static hosting of dist/, CDN             │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Netlify Database** stores every run ([overview](https://docs.netlify.com/build/data-and-storage/netlify-database/)). Schema changes are SQL migrations in `netlify/database/migrations/`, applied by Netlify before each production deploy is published ([migrations](https://docs.netlify.com/build/data-and-storage/netlify-database/migrations/)).
- **Producers write directly to the database.** There is no write API. A runner connects with a dedicated `cr_ingest` login whose only privilege is executing four SQL functions (§4).
- **Netlify Functions never write to the database.** They query through `getDatabase()` from `@netlify/database` ([API](https://docs.netlify.com/build/data-and-storage/netlify-database/api/)). Every query runs inside a read-only transaction, because the platform-provided connection is the owner role. Functions accept only `GET`.
- **Summaries are computed by a Function on request and cached in Netlify Blobs** (§5). The Function imports the statistics code from `site/model.js`, so the browser and the server share one implementation.
- **The viewer** is the existing Vite build, deployed by Netlify. It gains an API data source next to the existing `data.json` source (§6).

## 3. Database schema

The schema uses one row per declared entity and surrogate keys, which keeps the large tables narrow. Composite foreign keys turn every cross-reference rule in the README into a database constraint; the exceptions are the rules listed after the DDL. A `plot` is one chart: one group, one benchmark, and one combination of non-scaling parameter values. It is the "series" level the viewer pages through. Plots are always ordered by `id`.

```sql
CREATE SCHEMA cr;

CREATE TABLE cr.runs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- one URL segment: no '/', no '.' or '..'
  key         text NOT NULL UNIQUE CHECK (key ~ '^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$'),
  title       text NOT NULL CHECK (title <> '' AND char_length(title) <= 500),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 10000),
  state       text NOT NULL DEFAULT 'running'
              CHECK (state IN ('running', 'completed', 'failed')),
  progress    jsonb NOT NULL CHECK (jsonb_typeof(progress) = 'object'),  -- data.json "progress", verbatim
  revision    bigint NOT NULL DEFAULT 0,  -- incremented by every data write, under the run row lock
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cr.groups (
  id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES cr.runs ON DELETE CASCADE,
  key    text NOT NULL CHECK (key <> '' AND char_length(key) <= 200),
  name   text NOT NULL CHECK (name <> '' AND char_length(name) <= 200),
  UNIQUE (run_id, key),
  UNIQUE (id, run_id)
);

CREATE TABLE cr.benchmarks (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id        bigint NOT NULL REFERENCES cr.runs ON DELETE CASCADE,
  key           text NOT NULL CHECK (key <> '' AND char_length(key) <= 200),
  scaling_param text NOT NULL,
  UNIQUE (run_id, key),
  UNIQUE (id, run_id)
);

CREATE TABLE cr.params (
  benchmark_id bigint NOT NULL REFERENCES cr.benchmarks ON DELETE CASCADE,
  key          text NOT NULL CHECK (key <> '' AND char_length(key) <= 200),
  unit         text NOT NULL CHECK (char_length(unit) <= 50),
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
  key          text NOT NULL CHECK (key <> '' AND char_length(key) <= 200),
  name         text NOT NULL CHECK (name <> '' AND char_length(name) <= 200),
  unit         text NOT NULL CHECK (char_length(unit) <= 50),
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
  visible      boolean NOT NULL DEFAULT false,  -- maintained by cr.put_points (see below)
  CHECK (jsonb_typeof(params) = 'object' AND octet_length(params::text) <= 4096),
  CHECK (NOT jsonb_path_exists(params, 'strict $.* ? (@.type() != "number" && @.type() != "string" && @.type() != "boolean")')),
  -- Rule: a point names a declared group and benchmark of the same run.
  FOREIGN KEY (group_id, run_id) REFERENCES cr.groups (id, run_id) ON DELETE CASCADE,
  FOREIGN KEY (benchmark_id, run_id) REFERENCES cr.benchmarks (id, run_id) ON DELETE CASCADE,
  UNIQUE (group_id, benchmark_id, params),
  UNIQUE (id, group_id, benchmark_id)
);

CREATE TABLE cr.points (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plot_id      bigint NOT NULL,
  group_id     bigint NOT NULL,
  benchmark_id bigint NOT NULL,
  x            double precision NOT NULL CHECK (x NOT IN ('NaN', 'Infinity', '-Infinity')),
  FOREIGN KEY (plot_id, group_id, benchmark_id)
    REFERENCES cr.plots (id, group_id, benchmark_id) ON DELETE CASCADE,
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
  reason       text CHECK (reason <> '' AND char_length(reason) <= 1000),
  symbol       text CHECK (symbol <> '' AND char_length(symbol) <= 16),
  PRIMARY KEY (point_id, series_id),
  FOREIGN KEY (point_id, benchmark_id) REFERENCES cr.points (id, benchmark_id) ON DELETE CASCADE,
  -- Rule: every series key in values/statuses is declared by the point's benchmark.
  FOREIGN KEY (series_id, benchmark_id) REFERENCES cr.series (id, benchmark_id) ON DELETE CASCADE,
  CHECK (in_values OR value IS NULL),
  CHECK (in_values OR state IS NOT NULL),
  CHECK (state IS NOT NULL OR (reason IS NULL AND symbol IS NULL))
);

-- Plot pages and manifest counts (§5): visible plots of one group and benchmark, by id.
CREATE INDEX ON cr.plots (group_id, benchmark_id, id) WHERE visible;
-- Summary read (§5): every point of one group; observations follow by primary key.
CREATE INDEX ON cr.points (group_id) INCLUDE (id, benchmark_id, plot_id, x);
```

Some rules compare a row with a set of rows, so they cannot be constraints. The SQL functions check them under the run lock and reject the whole call if any fails:

- `non_scaling_params` has exactly the declared parameters other than the scaling parameter.
- `values` has at least one key (`minProperties: 1`).
- A benchmark has at most 32 parameters and 64 series. With the length limits above, this bounds one serialized point to well under 100 KB.
- Metadata is append-only. `cr.open_run` may add groups, benchmarks, and series. It rejects a changed scaling parameter, series unit or role, or group name. It also rejects **any change to an existing benchmark's parameter set**, because stored points were validated against that set.

`plots.visible` is true when the plot has a point with a finite value or with a status the viewer draws: `failed`, `verification_failed`, `timeout`, `memory_limit`, `unsupported`, or `running`. This mirrors `isMarked` and `visibleStates` in `site/model.js`, which the static viewer uses to drop rows in `indexReport`. `cr.put_points` recomputes it for the plots it touches, so it can also turn false. The duplicated rule needs one shared fixture test once it is implemented.

Storage estimate: 450,000 points with two to three series each is about 1 million observation rows. With indexes that is roughly 100 MB per run, or about 3 GB for 30 runs. To be measured (§8).

## 4. Write protocol

### Roles and why there is no row-level security

| Role | Created by | Privileges |
|---|---|---|
| owner (Netlify-provisioned) | Netlify | everything; used by migrations and, inside read-only transactions, by Functions |
| `cr_ingest` (login) | a migration creates it `NOLOGIN`; the team owner runs `ALTER ROLE cr_ingest LOGIN PASSWORD ...` once by hand | `USAGE` on schema `cr`; `EXECUTE` on `cr.open_run`, `cr.put_points`, `cr.heartbeat`, `cr.finish_run` only |

The four functions are `SECURITY DEFINER` with `SET search_path = cr, pg_temp`, and `EXECUTE` is revoked from `PUBLIC`. `cr_ingest` has no table privileges. A leaked ingest credential can therefore add or overwrite results, but it cannot read data, delete runs, or change the schema. Passwords never enter the repository. The connection string is stored once as a **GitHub organization secret** (for example `CALIBRATION_REPORT_DSN`) and granted to the simulator repositories that report.

No row-level security (RLS): all data is public, Functions read as the owner (which bypasses RLS), and writes go only through the `SECURITY DEFINER` functions, so RLS would protect nothing. Write isolation between simulators, if needed later, means per-simulator ingest roles plus a run-key prefix check in the functions; private runs would mean RLS or authentication at that point.

### Functions

Each function locks the run row (`SELECT ... FOR UPDATE`) before it checks the run's state, then validates its whole argument against the matching `data.schema.json` rules before writing anything. For example, it checks for required `progress` fields and non-negative counts, at least one group, benchmark, parameter, and series, required point fields, no unknown keys, and the status enum. `data.schema.json` stays the source of truth: the implementation tests the SQL validation against the same fixtures that a JSON Schema validator accepts or rejects.

| Call | Arguments | Effect |
|---|---|---|
| `cr.open_run(run_key, report, benchmarks, progress)` | `report`, `benchmarks`, and `progress` objects from `data.json` (`report.live` is ignored) | Creates the run in state `running`, or appends metadata to an existing `running` run, or **reopens a `failed` run** (state back to `running`). Rejects a `completed` run, which is terminal. |
| `cr.put_points(run_key, points, progress)` | array of `data.json` points (may be empty); optional `progress` | Requires `running`. Upserts plots, points, and observations; recomputes `visible` for touched plots; replaces `progress` when given; sets `updated_at`; increments `revision`. |
| `cr.heartbeat(run_key)` | | Requires `running`. Sets `updated_at` only. It does **not** increment `revision`, so it never invalidates a cached summary (§5). |
| `cr.finish_run(run_key, state, progress)` | `state` is `completed` or `failed` | Requires `running`. Sets the final state and progress, and increments `revision`. |

The run lock serializes all writes to one run, so no write can cross the transition to a final state. A revision therefore names exactly one state of the run's data.

### Ownership, retries, and lifecycle

A point is identified by `(group, benchmark, non_scaling_params, x)`. In a batch, each series key replaces that series' stored observation, so a `running` status can later become a value. Series that are absent from the batch keep their stored observation.

Retries are safe under these rules:

- **One owner per observation.** Each (point, series) belongs to exactly one writer. Matrix jobs of one run must own disjoint benchmarks or configurations. Overlapping writers are unsupported, and their results are undefined.
- **One batch in flight per writer.** A writer sends its batches in order and waits for each to finish. If the outcome of a batch is unknown (for example, the connection dropped during commit), the writer replays that same batch before sending the next one. Replaying writes the same observations again, so the stored data matches a single successful write. The only side effect is one extra revision, which costs at most one extra summary computation. No batch IDs are needed.
- **One progress writer.** Only the finalizer job (or the run's only job) sends `progress`.

Lifecycle:

1. Every job calls `open_run` with the same metadata. The call is idempotent.
2. Each job sends its own points with `put_points`. A job calls `heartbeat` when it has written nothing for 5 minutes, so a long benchmark does not look stale. The progress owner sends progress with `put_points` (points may be empty).
3. Exactly **one finalizer job** calls `finish_run` after all workers have ended, for example a workflow job that `needs:` the matrix and runs `if: always()`. It sends `completed` or `failed`.

A run whose jobs died stays `running`. The viewer treats it as stale once `updated_at` is 30 minutes old (§6). Nothing changes state automatically. Rerunning the workflow reopens a `failed` run, or continues a stale `running` run.

### Python writer client (to be written)

A single module, for example `clients/python/calibration_report_writer.py`, depending only on `psycopg` 3:

```python
with Writer(os.environ["CALIBRATION_REPORT_DSN"], run_key="mgpusim.mi300x.2026-11-25-434ad66") as w:
    w.open(report, benchmarks, progress)
    for point in results():   # data.json point dicts owned by this job
        w.add(point)          # buffered; one batch in flight; flushes at 2,000 points or 30 s,
                              # and calls heartbeat after 5 idle minutes
# leaving the block only flushes; it never finishes the run

# in the finalizer job only:
finish_run(dsn, "mgpusim.mi300x.2026-11-25-434ad66", "completed", progress)
```

The client retries a failed flush with backoff, replaying the same batch. The first connection after the database has slept can take a few seconds. The same module provides `import data.json --run KEY`, which makes the same calls, and `export --run KEY > data.json`, which reads through the public API (§6). No database credential is needed to export.

### Cost of writing directly to the database

The design accepts these costs of having no write API:

- Every reporting repository needs a Postgres driver, network access to the database, and a credential (one organization secret keeps rotation in one place).
- Validation errors surface as Postgres exceptions; the client turns them into readable messages.
- Netlify request logs and rate limits do not see writes.
- The four function signatures are the contract. Changing them breaks producers that pin an old client, so an incompatible change needs a new function name (for example `put_points_v2`), with the old one kept for a while.

Because the functions accept only `data.json` shapes and the role has only `EXECUTE`, the coupling is no wider than a write API's.

## 5. Read API

Every endpoint is a Netlify Function at `/api/...` that returns JSON. Data requests carry `rid=<run id>` from the manifest, and the Function returns `409` if `rid` no longer matches the key, which happens when a run was deleted and imported again.

| Endpoint | Returns | Used for |
|---|---|---|
| `GET /api/runs` | `[{key, title, state, progress, updated_at}]`, newest first | run list on the site root |
| `GET /api/runs/{key}` | manifest (below) | header, progress, tabs, benchmark-level pagination, live polling |
| `GET /api/runs/{key}/summary?rid=[&group=]` | summary of one scope (below); no `group` means Overview | summary section, benchmark-wide error |
| `GET /api/runs/{key}/plots?rid=&rev=&group=&benchmark=&offset=&limit=[&after=PLOT:X][&all=1]` | `{total, plots: [{id, non_scaling_params, rows: [point]}], next}` | series pages inside one benchmark card; export |
| `GET /api/runs/{key}/points/{plot}/{x}?rid=` | one full `data.json` point | point details opened from a summary chart |

HTTP caching:

- `/api/runs` is `Cache-Control: no-cache` without a validator. It is one small query.
- The manifest carries `ETag: "<run id>-<revision>-<updated_at>"` and answers a matching `If-None-Match` with `304`. Every data write increments `revision`, and a heartbeat changes only `updated_at`, so the ETag covers every manifest field. The viewer derives staleness from `updated_at` (§6).
- `plots` and `points` of a `completed` run are `Cache-Control: public, max-age=31536000, immutable` (their URLs carry `rid`, and `plots` also `rev`). While the run is `running` they are `no-cache`.
- `summary` follows the rules in "Summary cache" below.

### Manifest

This benchmark is a valid `data.json` benchmark:

```json
{
  "id": 7, "revision": 418, "state": "running", "updated_at": "2026-11-25T16:20:00Z",
  "report": {"title": "MGPUSim calibration", "description": "", "live": true,
             "groups": {"mi300x": {"name": "AMD MI300X"}}},
  "progress": {"total": 450000, "completed": 212000, "running": 32},
  "benchmarks": {"polybench_fdtd2d": {
    "scaling_param": "size",
    "params": {"size": {"unit": "cells"}, "tmax": {"unit": "steps"}},
    "values": {"mi300x": {"name": "MI300X kernel time", "unit": "ns", "role": "hardware_measurement"},
               "mgpusim": {"name": "MGPUSim kernel time", "unit": "ns", "role": "simulator_output"}}}},
  "plots": {"mi300x": {"polybench_fdtd2d": 1184}}
}
```

`report`, `progress`, and `benchmarks` have exactly the `data.json` shapes, with `report.live` derived as `state = 'running'`. `plots[group][benchmark]` counts visible plots, so page counts match what `indexReport` produces from the same data. The manifest grows with groups × benchmarks, not with points.

### Plot pages

Netlify buffers a Function response up to 6 MB ([Functions defaults](https://docs.netlify.com/build/functions/configuration/#default-values)). `plots` returns the plots of one page (`offset`, `limit`) ordered by plot id, with rows ordered by `x`, and stops adding rows when the body reaches **4 MB** or 20,000 rows. It then returns `next = "PLOT:X"`, and the client fetches the rest of that plot before rendering the page. Ingest bounds the size of one point (§3), so one row always fits in the remaining budget. `all=1` includes invisible plots, which only export needs.

Plot pages of a running run show the database at request time and are not pinned to the summary's revision, which may lag by up to 60 s. Pinning would require keeping old point versions; the summary states its revision, and both converge on the next refresh.

### Summary

The summary Function computes what the summary section and the benchmark cards' benchmark-wide error show today. It imports the pure functions of `site/model.js`, which has no imports and no DOM use (`site/model.js:1`; verified to load in plain Node): `comparisonPairs` (line 1), `errorStats` (56), `rankStatistics` and `rankingStats` (88, 161), `preferLogScale` (186). Logic that now sits in components moves there too: the Overview relabeling and percentiles (`site/Charts.jsx:503-545`), the scatter statistics and default scale (`site/Charts.jsx:468,477`), and the CDF default scale (`site/drawing.js:350`). A new `buildSummary(rows, benchmarks, groups, scope, limits)` wraps them with the sampling rules below. The file source calls it without limits, so the offline viewer keeps full-resolution charts.

**Read.** The Function reads the run in one `REPEATABLE READ READ ONLY` transaction, so the revision it reports matches the rows it read:

1. `SELECT id, state, revision FROM cr.runs WHERE key = $1` (unique index).
2. Every finite value of a series with a role, for the scope's groups: `cr.points` by `group_id` (index-only scan on the §3 index), joined to `cr.observations` by primary key and to `cr.series`. Each row carries only `(benchmark, plot, x, series, value)`. These become rows `{group, benchmark, x, plot, values}`, all that `comparisonPairs` reads.
3. `non_scaling_params` for the plots of the sampled comparisons only (`WHERE id = ANY($1)`).

When a run has a single group, Overview and that group are the same scope and share one cache entry.

**Exact over all comparisons:** comparison count; average and maximum error; P50/P90/P95/P98; and per unit, Kendall's τ-b, pairwise ordering accuracy, Spearman's ρ, and error statistics; per benchmark (group scopes only), the benchmark-wide error statistics; and every chart's default axis scale (`preferLogScale` over the full data).

**Sampled, deterministically (no random numbers), with the limits per scope:**

| Chart | Limit | Rule |
|---|---|---|
| S-curve (signed error by rank) | 1,500 points | ranks 1 and N, plus evenly spaced ranks |
| Error CDF (absolute error) | 1,500 points | smallest and largest, plus evenly spaced ranks |
| Scatter, per unit | 3,000 points | the 1,000 largest absolute errors, the minimum and maximum of actual and prediction, then evenly spaced comparisons ordered by actual |

Sampled charts say so ("3,000 of 212,000 comparisons shown"). The log/linear toggle redraws the sample.

Response, abbreviated:

```json
{
  "rid": 7, "scope": "mi300x", "revision": 418, "state": "running",
  "computed_at": "2026-11-25T16:20:05Z",
  "count": 212000,
  "stats": [["Average error", "18.2%"], ["Max error", "412%"]],
  "percentiles": [["P50", "9.81%"], ["P90", "41.0%"], ...],
  "pairs": [{"id": "[\"mi300x\",\"mgpusim\"]", "name": "MGPUSim kernel time vs. MI300X kernel time", "unit": "ns"}],
  "benchmarks": ["polybench_fdtd2d"],
  "plots": {"17": [0, {"tmax": 10}]},
  "samples": {"plot": [17], "x": [64], "pair": [0], "actual": [57889], "prediction": [79339]},
  "scurve": {"sample": [0], "rank": [118000]},
  "cdf": {"log": true, "sample": [0], "rank": [160500]},
  "scatter": {"ns": {"log": true, "count": 212000, "sample": [0],
                     "stats": [["Kendall’s τ-b", "0.912"], ...]}},
  "benchmark_stats": {"polybench_fdtd2d": [["Average error", "12.0%"], ["Max error", "88.1%"]]}
}
```

`samples` holds the union of the three samples in columns, and the charts index into it. Each sample carries what click-through needs (`plot`, `x`, `pair`) and, through `plots` and `benchmarks`, what hover needs (`PointDescription` reads `point.non_scaling_params.launch`, `site/PointDetails.jsx:41`). Size bound: ≤ 6,000 samples for a single-unit scope, about 600 KB of JSON or 150 KB compressed; each further unit adds ≤ 3,000. It does not grow with the number of points.

### Summary cache

Rule, enforced by the server: compute only on request, cache, and recompute only when new data has arrived, at most once per 60 s per scope. Nothing is computed on write; there are no background jobs.

Each (run id, scope) has one record in the site-wide Netlify Blobs store `getStore({name: "summaries", consistency: "strong"})`, key `<run id>/<scope>`, which Functions can use without configuration ([Netlify Blobs](https://docs.netlify.com/build/data-and-storage/netlify-blobs/); keys ≤ 600 bytes not starting with `/`, metadata ≤ 2 KB, objects ≤ 5 GB). The value is the response body; the metadata is `{revision, state, computed_at}`.

On each request the Function:

1. Reads the record. If its `state` is `completed`, returns it **without touching the database**. A completed run is terminal, so viewing a finished run's summary never wakes the database.
2. Otherwise reads the run's `state` and `revision` (query 1 above). If the record's revision equals the run's, returns it: there is no new data.
3. Otherwise, if `now − computed_at < 60 s` and the run is still `running`, returns the record as it is. The body states its `revision` and `computed_at`, and the viewer shows "summary as of …".
4. Otherwise computes, writes the record, and returns it. A run that has just become `completed` skips the 60 s window, so its final summary is exact.

The write uses `onlyIfMatch` with the ETag read in step 1 (or `onlyIfNew`), so a slow, older computation cannot overwrite a newer record. There is no lease: requests that miss at the same time may each compute, which is accepted. A `failed` run is not terminal (`open_run` can reopen it), so its summary costs one small query per request.

HTTP: a `completed` summary is `Cache-Control: public, max-age=31536000, immutable`, and the URL carries `rid`. Any other summary is `no-cache` with `ETag: "<run id>-<summary revision>"`, and a matching `If-None-Match` gets `304`.

## 6. Viewer changes and `data.json` compatibility

The viewer gains a data source interface with two implementations:

- **API source.** Used when the URL has `?run=KEY`. A query string keeps the existing relative-asset build working without rewrites. The site root without `run` lists runs.
- **File source.** Used when there is no `run` parameter and `./data.json` exists. This is today's behavior, implemented in memory with `indexReport` and `buildSummary`, so `npm run dev`, `serve.py`, and static hosting keep working unchanged.

`Report` then consumes the interface:

- `Summary` and the summary drawings in `site/drawing.js` consume the summary object (exact statistics, sampled series) instead of the full pair list.
- Benchmark cards take counts from the manifest, rows from `plots` pages, and benchmark-wide error from `benchmark_stats`. `pageWindow` clamping uses the manifest counts.
- Opening a sampled point fetches `/points/{plot}/{x}`. `PointDetails` shows the result only if the selection is still that point and the summary revision is unchanged, so a late response cannot replace a newer selection. Benchmark-card points are already complete.

Polling policy for the API source:

- Poll the manifest every 10 s only while all of these hold: `state` is `running`, the run is not stale, and the tab is visible (`document.visibilityState`).
- After 5 minutes without a new revision, poll every 60 s.
- Stop polling once the run is stale, meaning `updated_at` is more than 30 minutes old (writers heartbeat every 5 minutes). Show the run as stale with a manual refresh button.
- On a new manifest revision, refetch the visible `plots` pages. Request the summary whenever its revision is older than the manifest's. The server decides whether to recompute, so the viewer needs no throttle of its own.

Import and export mapping:

| `data.json` | Database |
|---|---|
| `report.title`, `report.description` | `runs.title`, `runs.description` |
| `report.live` | derived on export as `state = 'running'`; ignored on import (an imported file becomes `completed` unless `--live` is passed) |
| `report.groups.{key}.name` | `groups(key, name)` |
| `progress` (all fields) | `runs.progress` |
| `benchmarks.{key}.scaling_param` | `benchmarks(key, scaling_param)` |
| `benchmarks.{key}.params.{p}.unit` | `params(key = p, unit)` |
| `benchmarks.{key}.values.{s}` `{name, unit, role}` | `series(key = s, name, unit, role)` |
| `data[i].group`, `.benchmark`, `.non_scaling_params` | `plots(group_id, benchmark_id, params)` |
| `data[i].x` | `points.x` |
| `data[i].values.{s} = v` (number or null) | `observations(series s, in_values = true, value = v)` |
| `data[i].statuses.{s}` `{state, reason, symbol}` | same observation row's `state`, `reason`, `symbol`; `in_values = false` when `s` is not in `values` |

Export reads the manifest, then pages through `plots?all=1` for every group and benchmark.

Round trip is semantic, not byte-for-byte: `export(import(f))` is equivalent to `f` after these normalizations.

- Object key order and the order of `data` are ignored.
- Numbers are compared as IEEE-754 doubles. `x`, values, and parameter numbers are stored as `double precision` or JSON numbers, so `1.0` comes back as `1`.
- `report.live` is derived from `state`.
- An empty `statuses` object is omitted.

The exported file validates against `data.schema.json` unchanged.

## 7. Cost

Rates in Netlify credits ([how credits work](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/), [database billing](https://docs.netlify.com/build/data-and-storage/netlify-database/billing-and-usage/)):

| Resource | Rate |
|---|---|
| Database compute | 10 credits per compute-unit hour; the database sleeps after 5 idle minutes |
| Database bandwidth | 20 credits per GB |
| Function compute | 10 credits per GB-hour (default 1 GB memory) |
| Web bandwidth | 20 credits per GB |
| Web requests | 2 credits per 10,000 |
| Database storage | currently free |
| Netlify Blobs | not listed on the credits page; unverified (§8) |

The team's Open Source plan grants 10,000 credits per month at no charge.

The estimate assumes three runs per month (tens per year), each about 6 hours long, single group, and watched live. All figures are estimates to be measured.

| Item | Estimate | Credits / month |
|---|---|---|
| Database awake while runs write (1 CU × 6 h × 3) | 18 CU-h | 180 |
| Database woken by finished-run views (manifest and plot-page CDN misses, ≈5 min each, 100 visits); summaries come from Blobs | ≤ 8 CU-h | ≤ 80 |
| Summary reads leaving the database (≤ 1 per minute per scope while watched: ≤ 360 per run × ≈20 MB × 3 runs) | ≤ 22 GB | ≤ 430 |
| Function compute (≈10 s at 1 GB per summary computation, unmeasured; small requests negligible) | ≤ 3 GB-h | ≤ 30 |
| Web bandwidth (≈150 KB per summary, plot pages, 200 page loads, live refreshes) | ≤ 1 GB | ≤ 20 |
| Requests (manifest and summary polls of visible live tabs, plus page loads) | < 200,000 | < 40 |
| **Total** | | **≈ 600–800** |

Summary computations are bounded per scope, not per viewer: ten viewers of a running run cost the same as one, an unwatched run costs none, and a finished run's summary is computed once. A longer window than 60 s cuts the summary line proportionally.

The polling policy bounds a forgotten tab: it stops when the run finishes or 30 minutes after the last write, and hidden tabs do not poll. Without it, a tab polling every 10 s would keep the database awake around the clock, about 7,200 credits per month.

## 8. Risks to verify before implementation

1. **External connections.** Confirm that a GitHub-hosted runner can connect with the copied connection string (only Team Owners can copy a read-write one, [access control](https://docs.netlify.com/build/data-and-storage/netlify-database/access-control/)), that the owner can create the `cr_ingest` login, and whether a pooled endpoint exists. Measure first-connect latency after the database has slept.
2. **Plan limits.** The database limits table lists Free, Personal, Pro, and Enterprise, but not Open Source ([limits](https://docs.netlify.com/build/data-and-storage/netlify-database/billing-and-usage/#limits)). If Open Source maps to Free, the 5 GB storage cap and the **48 compute-unit hours per month** cap would bind. Three 6-hour runs already use 18 CU-h. Ask Netlify support which column applies before building.
3. **Storage billing.** Database storage is free "for now", and Netlify will announce rates in advance. Blobs usage rates are not on the credits page either; the summary store holds well under 1 MB per scope, but confirm it is billed sanely. If storage becomes expensive, revive the deferred R2 archive.
4. **Direct-write coupling.** See §4. Revisit if more than a handful of repositories report. A thin write Function could front the same SQL functions without a schema change.
5. **Summary computation time.** A synchronous Function may run for at most 60 s ([Functions defaults](https://docs.netlify.com/build/functions/configuration/#default-values)), and a summary reads and pairs about 1 million observation rows. Measure it (risk 6). If it nears the limit, narrow the read first (one row per point with its role-tagged values aggregated in SQL, streamed). A background Function (≤ 15 minutes) writing the Blob would fit but reintroduces background work, so it needs a decision.
6. **Query plans and sizes.** Load a synthetic 450,000-point run into a Netlify Database branch. Check `EXPLAIN (ANALYZE, BUFFERS)` of the summary read, plot pages, and manifest counts against the §3 indexes, and measure response sizes (§5), bytes per summary read (20 MB, §7), and storage (100 MB per run).
7. **Deploy previews copy production data.** Each deploy preview gets a database branch with a copy of production data ([branching](https://docs.netlify.com/build/data-and-storage/netlify-database/#database-branching)). Confirm that copying several GB per preview is cheap (copy-on-write), or disable database access for previews. Previews share run ids with production but may diverge, so they must cache summaries in a deploy-scoped store (`getDeployStore`), never in the site-wide `summaries` store.
