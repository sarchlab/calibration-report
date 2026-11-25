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
  revision    bigint NOT NULL DEFAULT 0,  -- incremented by every write call, under the run row lock
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
  revision     bigint NOT NULL,  -- run revision of the last write to this point
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
-- Measurements keyset (§5): one group, a revision window, then (revision, id).
CREATE INDEX ON cr.points (group_id, revision, id);
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
| `cr_ingest` (login) | a migration creates it `NOLOGIN`; the team owner runs `ALTER ROLE cr_ingest LOGIN PASSWORD ...` once by hand | `USAGE` on schema `cr`; `EXECUTE` on `cr.open_run`, `cr.put_points`, `cr.finish_run` only |

The three functions are `SECURITY DEFINER` with `SET search_path = cr, pg_temp`, and `EXECUTE` is revoked from `PUBLIC`. `cr_ingest` has no table privileges. A leaked ingest credential can therefore add or overwrite results, but it cannot read data, delete runs, or change the schema. Passwords never enter the repository. The connection string is stored once as a **GitHub organization secret** (for example `CALIBRATION_REPORT_DSN`) and granted to the simulator repositories that report.

No row-level security (RLS). All data is public and read only through Functions, which run read-only transactions as the owner role, and the owner bypasses RLS anyway. Writes go only through the `SECURITY DEFINER` functions, and no role has table grants. RLS would add policy surface that protects nothing. If simulators later need write isolation from each other, the fix is per-simulator ingest roles plus a run-key prefix check inside the functions, not RLS. If private runs are ever needed, consider RLS or authentication in the Functions at that point.

### Functions

Each function locks the run row (`SELECT ... FOR UPDATE`) before it checks the run's state, then validates its whole argument against the matching `data.schema.json` rules before writing anything. For example, it checks for required `progress` fields and non-negative counts, at least one group, benchmark, parameter, and series, required point fields, no unknown keys, and the status enum. `data.schema.json` stays the source of truth: the implementation tests the SQL validation against the same fixtures that a JSON Schema validator accepts or rejects.

| Call | Arguments | Effect |
|---|---|---|
| `cr.open_run(run_key, report, benchmarks, progress)` | `report`, `benchmarks`, and `progress` objects from `data.json` (`report.live` is ignored) | Creates the run in state `running`, or appends metadata to an existing `running` run, or **reopens a `failed` run** (state back to `running`). Rejects a `completed` run, which is terminal. |
| `cr.put_points(run_key, points, progress)` | array of `data.json` points (may be empty); optional `progress` | Requires `running`. Upserts plots, points, and observations; recomputes `visible` for touched plots; replaces `progress` when given; sets `updated_at`; increments `revision` and stamps touched points with it. |
| `cr.finish_run(run_key, state, progress)` | `state` is `completed` or `failed` | Requires `running`. Sets the final state and progress, and increments `revision`. |

The run lock serializes all writes to one run, so no write can cross the transition to a final state. It also means revisions commit in increasing order, which the live-refresh protocol in §5 relies on.

### Ownership, retries, and lifecycle

A point is identified by `(group, benchmark, non_scaling_params, x)`. In a batch, each series key replaces that series' stored observation, so a `running` status can later become a value. Series that are absent from the batch keep their stored observation.

Retries are safe under these rules:

- **One owner per observation.** Each (point, series) belongs to exactly one writer. Matrix jobs of one run must own disjoint benchmarks or configurations. Overlapping writers are unsupported, and their results are undefined.
- **One batch in flight per writer.** A writer sends its batches in order and waits for each to finish. If the outcome of a batch is unknown (for example, the connection dropped during commit), the writer replays that same batch before sending the next one. Replaying writes the same observations again, so the stored data matches a single successful write. The only side effect is one extra revision. No batch IDs are needed.
- **One progress writer.** Only the finalizer job (or the run's only job) sends `progress`.

Lifecycle:

1. Every job calls `open_run` with the same metadata. The call is idempotent.
2. Each job sends its own points with `put_points`. A job sends a heartbeat at least every 5 minutes: `put_points` with no points, and with progress if that job owns progress. This keeps a long benchmark from looking stale.
3. Exactly **one finalizer job** calls `finish_run` after all workers have ended, for example a workflow job that `needs:` the matrix and runs `if: always()`. It sends `completed` or `failed`.

A run whose jobs died stays `running`. The viewer treats it as stale once `updated_at` is 30 minutes old (§6). Nothing changes state automatically. Rerunning the workflow reopens a `failed` run, or continues a stale `running` run.

### Python writer client (to be written)

A single module, for example `clients/python/calibration_report_writer.py`, depending only on `psycopg` 3:

```python
with Writer(os.environ["CALIBRATION_REPORT_DSN"], run_key="mgpusim.mi300x.2026-11-25-434ad66") as w:
    w.open(report, benchmarks, progress)
    for point in results():   # data.json point dicts owned by this job
        w.add(point)          # buffered; one batch in flight; flushes at 2,000 points or 30 s,
                              # and sends a heartbeat after 5 idle minutes
# leaving the block only flushes; it never finishes the run

# in the finalizer job only:
finish_run(dsn, "mgpusim.mi300x.2026-11-25-434ad66", "completed", progress)
```

The client retries a failed flush with backoff, replaying the same batch. The first connection after the database has slept can take a few seconds. The same module provides `import data.json --run KEY`, which makes the same three calls, and `export --run KEY > data.json`, which reads through the public API (§6). No database credential is needed to export.

### Cost of writing directly to the database

Producers write directly to the database, not through a write API. The design accepts these costs:

- Every reporting repository needs a Postgres driver and network access to the database host, and it holds a database credential. The organization secret keeps rotation in one place.
- Validation errors surface as Postgres exceptions, not HTTP errors. The client has to turn them into readable messages.
- Netlify request logs and rate limits do not see writes. A runaway producer is limited only by the database itself.
- The three function signatures are the contract. Changing them breaks producers that pin an old client, so an incompatible change needs a new function name (for example `put_points_v2`), with the old one kept for a while.

Because the functions accept only `data.json` shapes and the role has only `EXECUTE`, the coupling is no wider than a write API would create.

## 5. Read API

Every endpoint is a Netlify Function at `/api/...`. It runs one read-only transaction and returns JSON.

Caching rules:

- `/api/runs` is `Cache-Control: no-cache` and has no validator. It is one small query.
- The manifest carries `ETag: "<run id>-<revision>"` and answers a matching `If-None-Match` with `304`. Every change a write makes (points, progress, metadata, state) increments `revision`, so the ETag covers everything in the manifest. Only the passage of time is not covered, and the viewer handles that itself (§6).
- Every data request also carries `rid=<run id>&rev=<revision>` from the manifest. The function returns `409` if `rid` no longer matches the key, which happens when a run was deleted and imported again. Responses to a finished run's data URLs are `Cache-Control: public, max-age=31536000, immutable`, so the CDN serves repeat visits without waking the database. While a run is `running`, data responses are `no-cache`.

| Endpoint | Returns | Used for |
|---|---|---|
| `GET /api/runs` | `[{key, title, state, progress, updated_at}]`, newest first | run list on the site root |
| `GET /api/runs/{key}` | manifest (below) | header, progress, tabs, benchmark-level pagination, live polling |
| `GET /api/runs/{key}/plots?group=&benchmark=&offset=&limit=[&after=PLOT:X][&all=1]` | `{total, plots: [{id, non_scaling_params, rows: [point]}], next}` | series pages inside one benchmark card; export |
| `GET /api/runs/{key}/measurements?group=&since=A&upto=B[&after=REV:ID]` | one page of columnar measurements (below) | Overview and group summaries, benchmark-wide error |
| `GET /api/runs/{key}/points/{plot}/{x}` | one full `data.json` point | point details opened from a summary chart |

Manifest. This benchmark is a valid `data.json` benchmark:

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

### Response size

Netlify buffers a Function response up to 6 MB ([Functions defaults](https://docs.netlify.com/build/functions/configuration/#default-values)). Both row-producing endpoints, `plots` and `measurements`, stop adding records when either cap is reached:

- the serialized body reaches **4 MB**, or
- the count cap is reached: 50,000 points for `measurements`, 20,000 rows for `plots`.

They then return a continuation cursor in `next`. Ingest bounds the size of a single record (§3), so one record always fits in the remainder of the budget. `plots` returns the plots of one page (`offset`, `limit`) ordered by plot id, with rows ordered by `x`. If the budget runs out inside a plot, that plot is returned partially, and `next = "PLOT:X"` continues from the same plot. The client appends the remaining rows before rendering the page. `all=1` includes invisible plots, which only export needs.

### Measurements and live refresh

Measurements contain every hardware-measurement and simulator-output value of one group. They are not pre-paired:

```json
{
  "group": "mi300x", "since": 0, "upto": 418, "next": "391:120544",
  "benchmarks": ["polybench_fdtd2d"],
  "series": [["mi300x", "mgpusim"]],
  "plots": {"17": {"tmax": 10}, "18": {"tmax": 20}},
  "benchmark": [0, 0, 0],
  "plot": [17, 17, 18],
  "x": [64, 128, 64],
  "values": [[57889, 79339], [103715, null], [61000, 70100]]
}
```

- `benchmark[i]` indexes `benchmarks`, and `values[i]` is aligned with that benchmark's entry in `series` (its series that declare a `role`).
- `plots` maps each plot id in the page to its `non_scaling_params`. The rebuilt rows therefore carry everything that hover previews read (`PointDescription` reads `point.non_scaling_params.launch` in `site/PointDetails.jsx`) without another request.
- The viewer rebuilds lightweight rows `{group, benchmark, x, plot, non_scaling_params, values}` and passes them to the existing `comparisonPairs(rows, benchmarks)`. Pairing rules (role, matching unit, exactly one hardware reference), signed error, and the statistics (`errorStats`, `rankStatistics`, and `rankingStats`) therefore stay in one place, `site/model.js`.

A run's measurements are roughly 15–20 MB of JSON before compression. The MI300X report has a single group, so the endpoint is paged with a keyset cursor over a revision window:

```sql
SELECT ... FROM cr.points p ...                        -- joined to observations and series with a role
WHERE p.group_id = $group AND p.revision > $A AND p.revision <= $B
  AND (p.revision, p.id) > ($after_revision, $after_id)
ORDER BY p.revision, p.id
LIMIT 50000;                                           -- and the 4 MB budget
```

The index `points (group_id, revision, id)` serves this query directly. The client protocol:

1. Read the manifest and take `B = revision`.
2. Fetch all pages with `since=A&upto=B`, following `next`. The first load uses `A = 0`.
3. Only after every page has succeeded, merge the rows by `(plot, x)`, publish them, and set the watermark `A := B`.
4. If any page fails, discard the partial result and retry the same window.
5. A finished run's single load uses its final, immutable revision as `B`.

This is consistent without a database snapshot across pages, for three reasons:

- Revisions are assigned under the run row lock and commit in order. By the time a client sees `B` in the manifest, every write with revision `≤ B` has committed. No new row can later appear inside the window `(A, B]`.
- A point that is rewritten while the client is paging moves to a revision greater than `B`. It may drop out of the current window, but the next refresh (`since = B`) picks it up with its newer values.
- Merging replaces rows by `(plot, x)`. A row seen in both windows therefore ends with its latest values.

A live refresh therefore costs only the points written since the last one.

Cost estimates, to be measured (§8): each page is one index range scan. Manifest and plot pages are indexed lookups on small tables. A finished run's pages are computed once each, then served by the CDN.

## 6. Viewer changes and `data.json` compatibility

The viewer gains a data source interface with two implementations:

- **API source.** Used when the URL has `?run=KEY`. A query string keeps the existing relative-asset build working without rewrites. The site root without `run` lists runs.
- **File source.** Used when there is no `run` parameter and `./data.json` exists. This is today's behavior, implemented in memory with `indexReport`, so `npm run dev`, `serve.py`, and static hosting keep working unchanged.

`Report` then consumes the interface:

- Summaries take pairs from `comparisonPairs` over the measurement rows.
- Benchmark cards take counts from the manifest and rows from `plots` pages. `pageWindow` clamping uses the manifest counts.
- When a summary pair's details are opened, `PointDetails` fetches `/points/{plot}/{x}`. It shows the result only if the selection is still the same point at the same revision. A late response therefore cannot replace a newer selection. Benchmark-card points are already complete.

Polling policy for the API source:

- Poll the manifest every 10 s only while all of these hold: `state` is `running`, the run is not stale, and the tab is visible (`document.visibilityState`).
- After 5 minutes without a new revision, poll every 60 s.
- Stop polling once the run is stale, meaning `updated_at` is more than 30 minutes old (the writer heartbeat is every 5 minutes). Show the run as stale with a manual refresh button.
- Staleness is computed in the browser from `updated_at`, so the manifest ETag never depends on the clock.
- On a new revision, run the measurements protocol in §5 and refetch the visible `plots` pages.

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
| Function compute | 10 credits per GB-hour |
| Web bandwidth | 20 credits per GB |
| Web requests | 2 credits per 10,000 |
| Database storage | currently free |

The team's Open Source plan grants 10,000 credits per month at no charge. 106 had been used in the current period when this was written.

The estimate below assumes three runs per month (tens per year), each about 6 hours long and watched live. It also assumes the §6 polling policy. All figures are estimates to be measured.

| Item | Estimate | Credits / month |
|---|---|---|
| Database awake while runs write (1 CU × 6 h × 3) | 18 CU-h | 180 |
| Database woken by viewers of finished runs (≈5 min each, 100 visits, CDN misses only) | ≤ 8 CU-h | ≤ 80 |
| Measurements leaving the database (≈30 MB per uncached full load, 20 loads) | 0.6 GB | 12 |
| Function compute (≈2 s at 1 GB per uncached full load, plus small requests) | < 0.1 GB-h | < 1 |
| Web bandwidth (≈5 MB per page load, 200 loads, plus live deltas) | 1–2 GB | 20–40 |
| Requests (≤ one poll per 10 s per visible live tab, plus page loads) | < 100,000 | < 20 |
| **Total** | | **≈ 300–350** |

A forgotten visible tab is bounded by the polling policy. It stops polling when the run finishes, or 30 minutes after the last write if the run died. A hidden tab does not poll. A live viewer keeps the database awake no longer than the writers already do, plus at most those 30 minutes. Without this policy, a forgotten tab polling every 10 s would keep the database awake around the clock, about 720 CU-h or 7,200 credits per month per tab. The policy is therefore part of the cost model, not an optimization.

The dominant cost is the database staying awake during runs, which grows linearly with run-hours. Storage is about 100 MB per run and free today; §8 covers billing.

## 8. Risks to verify before implementation

1. **External connections.** Confirm three things:
   - A GitHub-hosted runner can connect to the production database with the copied connection string. Per [access control](https://docs.netlify.com/build/data-and-storage/netlify-database/access-control/), only Team Owners can copy a read-write string.
   - The owner can create the `cr_ingest` login.
   - Whether a pooled endpoint exists for many short-lived connections.

   Measure the first-connect latency after the database has slept. Also check whether deploy-preview branches copy the role. If they do not, previews have no ingest access, which is acceptable.
2. **Plan limits.** The database limits table lists Free, Personal, Pro, and Enterprise, but not Open Source ([limits](https://docs.netlify.com/build/data-and-storage/netlify-database/billing-and-usage/#limits)). If Open Source maps to Free, the 5 GB storage cap and the **48 compute-unit hours per month** cap would bind. Three 6-hour runs already use 18 CU-h. Ask Netlify support which column applies before building.
3. **Storage billing.** Storage is free "for now", and Netlify will announce rates in advance. At about 100 MB per run, the data grows by a few GB per year. If the announced rate makes that expensive, revive the deferred R2 archive.
4. **Direct-write coupling.** See §4. Revisit if more than a handful of repositories report. A thin write Function could front the same three SQL functions without a schema change.
5. **Query plans and sizes.** Load a synthetic 450,000-point run into a Netlify Database branch. Then check:
   - `EXPLAIN (ANALYZE, BUFFERS)` for the measurements keyset query, the plot-page query, and the manifest counts, confirming each uses the §3 indexes.
   - Real page sizes against the 4 MB budget.
   - The time to load a full run.
   - The storage size against the 100 MB-per-run estimate.

   If a full load is too slow, the fallback must be lossless, for example a denser encoding or brotli compression. It must not reduce precision or make the statistics inexact.
6. **Deploy previews copy production data.** Each deploy preview gets a database branch with a copy of production data ([branching](https://docs.netlify.com/build/data-and-storage/netlify-database/#database-branching)). Confirm that copying several GB per preview is cheap (copy-on-write), or disable database access for previews.
