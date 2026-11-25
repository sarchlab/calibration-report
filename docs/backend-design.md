# Backend design: hosted reports on Netlify

Status: proposal for review. Nothing in this document is implemented yet.

## 1. Goals and non-goals

Today a report is one `data.json` file. The viewer downloads all of it (`useReport` in `site/App.jsx` fetches `./data.json`) and builds every view in the browser (`indexReport` in `site/model.js`). Two problems follow:

1. **Size.** A release-scale MGPUSim report has about 450,000 points and exceeds 100 MB. Every viewer, and every live refresh, downloads and parses all of it.
2. **Latency.** Simulators run for hours in GitHub Actions and publish `data.json` as an artifact when the job ends, so nobody sees partial results. `serve.py`'s live mode only helps on the producer's machine.

Goals:

- Producers write results to a hosted database **while they run**, so partial results are visible within one summary interval (§5).
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
  │  calls cr.open_run / put_points / heartbeat / finish_run       │  GET /api/v1/...
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

One row per declared entity with surrogate keys keeps the large tables narrow. Composite foreign keys make every README cross-reference rule a constraint, except the rules listed after the DDL. A `plot` is one chart (one group, benchmark, and non-scaling parameter combination), the "series" level the viewer pages through, ordered by `id`.

```sql
CREATE SCHEMA cr;

CREATE TABLE cr.runs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- one URL segment: no '/', no '.' or '..'
  key         text NOT NULL UNIQUE CHECK (key ~ '^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$'),
  title       text NOT NULL CHECK (title <> '' AND octet_length(title) <= 500),
  description text NOT NULL DEFAULT '' CHECK (octet_length(description) <= 10000),
  state       text NOT NULL DEFAULT 'running'
              CHECK (state IN ('running', 'completed', 'failed')),
  progress    jsonb NOT NULL CHECK (jsonb_typeof(progress) = 'object' AND octet_length(progress::text) <= 4096),  -- data.json "progress", verbatim
  revision    bigint NOT NULL DEFAULT 0,  -- incremented by every data write, under the run row lock
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cr.groups (
  id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES cr.runs ON DELETE CASCADE,
  key    text NOT NULL CHECK (key <> '' AND octet_length(key) <= 200 AND key !~ '[[:cntrl:]]'),
  name   text NOT NULL CHECK (name <> '' AND octet_length(name) <= 200 AND name !~ '[[:cntrl:]]'),
  UNIQUE (run_id, key),
  UNIQUE (id, run_id)
);

CREATE TABLE cr.benchmarks (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id        bigint NOT NULL REFERENCES cr.runs ON DELETE CASCADE,
  key           text NOT NULL CHECK (key <> '' AND octet_length(key) <= 200 AND key !~ '[[:cntrl:]]'),
  scaling_param text NOT NULL,
  UNIQUE (run_id, key),
  UNIQUE (id, run_id)
);

CREATE TABLE cr.params (
  benchmark_id bigint NOT NULL REFERENCES cr.benchmarks ON DELETE CASCADE,
  key          text NOT NULL CHECK (key <> '' AND octet_length(key) <= 200 AND key !~ '[[:cntrl:]]'),
  unit         text NOT NULL CHECK (octet_length(unit) <= 50 AND unit !~ '[[:cntrl:]]'),
  ordinal      integer NOT NULL CHECK (ordinal >= 0),  -- declaration order in data.json
  PRIMARY KEY (benchmark_id, key),
  UNIQUE (benchmark_id, ordinal)
);

-- Rule: the scaling parameter is a declared parameter. Deferred so that a
-- benchmark and its parameters can be inserted in one transaction.
ALTER TABLE cr.benchmarks
  ADD FOREIGN KEY (id, scaling_param) REFERENCES cr.params (benchmark_id, key)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE cr.series (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  benchmark_id bigint NOT NULL REFERENCES cr.benchmarks ON DELETE CASCADE,
  key          text NOT NULL CHECK (key <> '' AND octet_length(key) <= 200 AND key !~ '[[:cntrl:]]'),
  name         text NOT NULL CHECK (name <> '' AND octet_length(name) <= 200 AND name !~ '[[:cntrl:]]'),
  unit         text NOT NULL CHECK (octet_length(unit) <= 50 AND unit !~ '[[:cntrl:]]'),
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
  CHECK (jsonb_typeof(params) = 'object' AND octet_length(params::text) <= 2000),  -- real values are tens of bytes; keeps the UNIQUE btree entry small
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
  reason       text CHECK (reason <> '' AND octet_length(reason) <= 1000),
  symbol       text CHECK (symbol <> '' AND octet_length(symbol) <= 16),
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
- A benchmark has at most 32 parameters and 64 series, so one serialized point fits well within the 4 MB plot-chunk budget (§5). A run has at most 16 groups, 1,000 benchmarks, and 32 distinct role-tagged series keys, which bounds the exact part of a summary (§5).
- A run's declared metadata (`report` and `benchmarks`, serialized as JSON) is at most **2 MB**, checked by `open_run` on create and on every append. Keys, names, and units are bounded in UTF-8 bytes (`octet_length`) and contain no control characters, so JSON escaping at most doubles them. The manifest adds `benchmark_keys` (≤ 1,000 × 403 bytes ≈ 400 KB), `plots` arrays (≤ 16 × 1,000 × ≈ 12 bytes ≈ 190 KB), `group_order`, and `progress` (≤ 4 KB), so it stays under about 2.6 MB, well inside the 6 MB Function limit.
- Metadata is append-only. `cr.open_run` may add groups, benchmarks, and series and update the title and description; every other difference is rejected (§4), including **any change to an existing benchmark's parameter set**, because stored points were validated against that set. It also rejects a role-tagged series key whose name, unit, or role differs from an earlier declaration of the same key in the run, so the 32-key cap bounds distinct series definitions.

`plots.visible` is true when the plot has a point with a finite value or a drawn status (`failed`, `verification_failed`, `timeout`, `memory_limit`, `unsupported`, `running`), mirroring `isMarked` and `visibleStates` in `site/model.js`, which `indexReport` uses to drop rows. `cr.put_points` recomputes it for touched plots, so it can turn false.

Storage estimate: 450,000 points with two to three series is about 1 million observation rows, roughly 100 MB per run with indexes (§8).

## 4. Write protocol

### Roles and why there is no row-level security

| Role | Created by | Privileges |
|---|---|---|
| owner (Netlify-provisioned) | Netlify | everything; used by migrations and, inside read-only transactions, by Functions |
| `cr_ingest` (login) | a migration creates it `NOLOGIN`; the team owner runs `ALTER ROLE cr_ingest LOGIN PASSWORD ...` once by hand | `USAGE` on schema `cr`; `EXECUTE` on `cr.open_run`, `cr.put_points`, `cr.heartbeat`, `cr.finish_run` only |

The four functions are `SECURITY DEFINER` with `SET search_path = cr, pg_temp`; `EXECUTE` is revoked from `PUBLIC`, and `cr_ingest` has no table privileges. A leaked ingest credential can add or overwrite results but cannot read, delete, or change the schema. The connection string lives only in a **GitHub organization secret** (for example `CALIBRATION_REPORT_DSN`) granted to the reporting repositories.

No row-level security (RLS): all data is public, Functions read as the owner (which bypasses RLS), and writes go only through the `SECURITY DEFINER` functions, so RLS would protect nothing. Write isolation between simulators, if needed later, means per-simulator ingest roles plus a run-key prefix check in the functions; private runs would mean RLS or authentication at that point.

### Functions

Each function locks the run row (`SELECT ... FOR UPDATE`; `open_run` first runs `INSERT ... ON CONFLICT (key) DO NOTHING` so concurrent first calls cannot race) before it checks the run's state, then validates its whole argument against the matching `data.schema.json` rules before writing anything (required fields, non-negative counts, non-empty declarations, no unknown keys, the status enum). `data.schema.json` stays the source of truth: the SQL validation is tested against the fixtures a JSON Schema validator accepts or rejects.

| Call | Arguments | Effect |
|---|---|---|
| `cr.open_run(run_key, report, benchmarks, progress)` | `report`, `benchmarks`, and `progress` objects from `data.json` (`report.live` is ignored) | Creates the run in state `running` with the given `progress`, appends metadata to a `running` run, or **reopens a `failed` run**. A changed `title` or `description` is updated in place. Each of these increments `revision` and sets `updated_at`; a call that changes nothing writes nothing. Any other difference from stored metadata (for example a parameter unit or an untagged series name) is rejected with an error naming the field. Stored entities absent from the call stay unchanged (omission is not a difference), so matrix jobs can declare only their own benchmarks. Never touches the progress of an existing run. Rejects a `completed` run, which is terminal. |
| `cr.put_points(run_key, points, progress)` | array of `data.json` points (may be empty); optional `progress` | Requires `running`. Upserts plots, points, and observations; recomputes `visible` for touched plots; replaces `progress` when given; sets `updated_at`; increments `revision`. |
| `cr.heartbeat(run_key)` | | Requires `running`. Sets `updated_at` only. It does **not** increment `revision`, so it never invalidates a cached summary (§5). |
| `cr.finish_run(run_key, state, progress)` | `state` is `completed` or `failed` | From `running`, sets the final state and progress and increments `revision`. Succeeds without writing if the run is already in the requested state; rejects the other terminal state. |

The run lock serializes all writes to one run, so no write can cross the transition to a final state. A revision therefore names exactly one state of the run's data.

### Ownership, retries, and lifecycle

A point is identified by `(group, benchmark, non_scaling_params, x)`. In a batch, each series key replaces that series' stored observation, so a `running` status can later become a value. Series that are absent from the batch keep their stored observation.

Retries are safe under these rules:

- **One owner per observation.** Each (point, series) belongs to exactly one writer. Matrix jobs of one run must own disjoint benchmarks or configurations. Overlapping writers are unsupported, and their results are undefined.
- **One batch in flight per writer.** A writer sends batches in order and waits for each. If a batch's outcome is unknown (the connection dropped during commit), it replays that batch before the next. Replaying rewrites the same observations, so the only side effect is one extra revision; no batch IDs are needed.
- **One progress writer.** Initial progress comes from the `open_run` call that creates the run. After that, only one designated job (the run's only job, or one named matrix job) sends `progress`, including after a reopen; the finalizer sends the final value with `finish_run`.

Lifecycle:

1. Every job calls `open_run` with the same metadata. Repeated calls change nothing.
2. Each job sends its own points with `put_points`. A job calls `heartbeat` when it has written nothing for 5 minutes, so a long benchmark does not look stale.
3. Exactly **one finalizer job** calls `finish_run` after all workers have ended, for example a workflow job that `needs:` the matrix and runs `if: always()`. It sends `completed` or `failed`.

A run whose jobs died stays `running` and looks stale after 30 minutes (§6); nothing changes state automatically. Rerunning the workflow reopens a `failed` run or continues a stale one.

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

The client retries a failed flush with backoff, replaying the same batch. The same module provides `import data.json --run KEY` and `export --run KEY > data.json`; export reads the public API (§6) and needs no credential.

### Cost of writing directly to the database

The design accepts these costs of having no write API:

- Every reporting repository needs a Postgres driver, network access to the database, and a credential (one organization secret keeps rotation in one place).
- Validation errors surface as Postgres exceptions; the client turns them into readable messages.
- Netlify request logs and rate limits do not see writes.
- The four function signatures are the contract. Changing them breaks producers that pin an old client, so an incompatible change needs a new function name (for example `put_points_v2`), with the old one kept for a while.

Because the functions accept only `data.json` shapes and the role has only `EXECUTE`, the coupling is no wider than a write API's.

## 5. Read API

Every endpoint is a Netlify Function under `/api/v1/` that returns JSON. `v1` is the format version: a constant in `site/model.js` shared by the Functions and the viewer, bumped whenever `buildSummary` or any response shape changes. Data requests carry `rid=<run id>` from the manifest. When a request reaches the database, the Function returns `409` if `rid` is not the current id of `key` (the run was deleted and imported again).

| Endpoint (under `/api/v1/runs`) | Returns | Used for |
|---|---|---|
| `/` | `[{key, title, state, progress, updated_at}]`, newest first | run list on the hosted root |
| `/{key}` | manifest (below) | header, progress, tabs, benchmark pagination, live polling |
| `/{key}/summary?rid=&scope=` | summary of one scope: `group:<id>` or `overview` (below) | summary section, benchmark-wide error |
| `/{key}/plots?rid=&group=&benchmark=&offset=&limit=[&after=PLOT:X][&all=1]` | `{revision, total, plots: [{id, non_scaling_params, rows: [point]}], next}` | series pages inside one benchmark card; export |
| `/{key}/points/{plot}/{x}?rid=` | `{revision, point}`: one full `data.json` point and the revision it was read at | point details opened from a summary chart |

HTTP caching: only data responses whose URL carries `rid` (`summary`, `plots`, `points`) may be `Cache-Control: public, max-age=31536000, immutable`, and only once the run is `completed`; such a URL names a historical run, so it stays valid after the key is reused. Data responses about `running` and `failed` runs are `no-cache`. `/runs` and the key-only manifest are **always** `no-cache` with an ETag and `304`, also for completed runs, so a deleted and reimported key is picked up. The manifest's ETag is `"<run id>-<revision>-<updated_at>"` (data writes increment `revision`, a heartbeat changes only `updated_at`); `/runs` uses a hash of its body. The viewer derives staleness from `updated_at` (§6).

### Manifest

```json
{
  "id": 7, "revision": 418, "state": "running", "updated_at": "2026-11-25T16:20:00Z",
  "report": {"title": "MGPUSim calibration", "description": "", "live": true,
             "groups": {"mi300x": {"name": "AMD MI300X"}}},
  "group_ids": {"mi300x": 3}, "group_order": ["mi300x"], "benchmark_keys": ["polybench_fdtd2d"],
  "progress": {"total": 450000, "completed": 212000, "running": 32},
  "benchmarks": {"polybench_fdtd2d": {
    "scaling_param": "size",
    "params": {"size": {"unit": "cells"}, "tmax": {"unit": "steps"}},
    "values": {"mi300x": {"name": "MI300X kernel time", "unit": "ns", "role": "hardware_measurement"},
               "mgpusim": {"name": "MGPUSim kernel time", "unit": "ns", "role": "simulator_output"}}}},
  "plots": {"mi300x": [[0, 1184]]}
}
```

`report`, `progress`, and `benchmarks` have exactly the `data.json` shapes (the benchmark above is valid `data.json`), with `report.live` derived as `state = 'running'`. Because JavaScript reorders numeric-looking object keys, order travels in arrays: `group_order` lists groups with visible plots, and `plots[group]` lists `[index into benchmark_keys, visible plot count]` for each benchmark of the group, both by first appearance (minimum visible plot id; plot ids follow `data` order, because import and `put_points` insert new plots in array order). Parameters are emitted in `cr.params.ordinal` order and series in id order, both declaration order. The hosted viewer uses these arrays. The file viewer keeps `indexReport`'s current order (`site/model.js:251-275`), which differs only when a plot's first row is invisible and a later one visible. The manifest grows with groups × benchmarks, not with points; §3 bounds it.

### Plot pages

Netlify buffers a Function response up to 6 MB ([Functions defaults](https://docs.netlify.com/build/functions/configuration/#default-values)). `plots` returns one page (`offset`, `limit`) of visible plots of one group and benchmark ordered by id, each with its visible rows (the `indexReport` row filter) ordered by `x`. A chunk stops at **4 MB** or 20,000 rows and returns `next = "PLOT:X"`; the client fetches the rest of that plot before rendering. One point is bounded (§3), so one row always fits. With `all=1`, `group` and `benchmark` are optional and the endpoint returns every plot and row, invisible ones included (§6).

Each chunk is read in one snapshot and carries the run `revision` it was read at. If a later chunk of a page has a different revision than the first, the viewer discards the partial page, refetches the manifest, and retries. Plot pages are not pinned to the summary's revision; the summary's freshness is independent (below).

### Summary

The summary Function computes what the summary section and benchmark-wide error show today. It imports the pure functions of `site/model.js`, which has no imports and no DOM use (`site/model.js:1`; verified to load in plain Node): `comparisonPairs` (line 1), `errorStats` (56), `rankStatistics` and `rankingStats` (88, 161), `preferLogScale` (186). Logic that now sits in components moves there too: the Overview relabeling and percentiles (`site/Charts.jsx:503-545`), the scatter statistics and default scale (`site/Charts.jsx:468,477`), and the CDF default scale (`site/drawing.js:350`). A new `buildSummary(rows, benchmarks, groups, scope, limits)` wraps them with the sampling rules below. The file source calls it without limits, so the offline viewer keeps full-resolution charts.

**Read**, in one `REPEATABLE READ READ ONLY` transaction, so revision, series metadata, and values come from one snapshot:

1. The run's `id`, `state`, and `revision` by key, and its groups, benchmarks, and series (the pairing rules read roles and units).
2. **One row per point** of the scope's groups: group, benchmark, plot, `x`, and the values of the benchmark's role-tagged series aggregated in SQL into one array in series-id order. The scan uses the §3 `points (group_id)` index and observations by primary key. At about 50 bytes per row, a 450,000-point run is **about 20–25 MB on the wire** (unaggregated, one row per observation, it would be about 50 MB).
3. `non_scaling_params` of the sampled plots only.

For a run with exactly one group, the viewer requests `scope=group:<id>` for Overview too, so there is one cache entry with the full group payload and warm hits avoid the database. Defensively, the Function also canonicalizes `overview` to that group after its database read.

**Exact over all comparisons**, never reduced: comparison count; average and maximum error; P50/P90/P95/P98; per unit, Kendall's τ-b, pairwise ordering accuracy, Spearman's ρ, and error statistics; per benchmark (group scopes), comparison count and error statistics; and every chart's default axis scale (`preferLogScale` over all data).

**Sampled deterministically**, per scope:

| Chart | Limit | Rule |
|---|---|---|
| S-curve (signed error by rank) | 1,500 points | ranks 1 and N, plus evenly spaced ranks |
| Error CDF (absolute error) | 1,500 points | smallest and largest, plus evenly spaced ranks |
| Scatter, per unit | 3,000 points | the 1,000 largest absolute errors, the minimum and maximum of actual and prediction, then evenly spaced comparisons ordered by actual |

Sampled charts say so ("3,000 of 212,000 comparisons shown").

```json
{
  "rid": 7, "key": "mgpusim.mi300x.2026-11-25-434ad66", "scope": "group:3", "revision": 418,
  "state": "running", "computed_at": "2026-11-25T16:20:05Z", "min_interval": 60, "count": 212000,
  "groups": [[3, "mi300x", "AMD MI300X"]],
  "stats": [["Average error", "18.2%"], ["Max error", "412%"]],
  "percentiles": [["P50", "9.81%"], ["P90", "41.0%"], ...],
  "series": [["mi300x", "MI300X kernel time", "ns"], ["mgpusim", "MGPUSim kernel time", "ns"]],
  "pairs": [[0, 1]],
  "benchmarks": ["polybench_fdtd2d"],
  "plots": {"17": [0, 0, {"tmax": 10}]},
  "samples": {"plot": [17], "x": [64], "pair": [0], "actual": [57889], "prediction": [79339]},
  "scurve": {"sample": [0], "rank": [118000]},
  "cdf": {"log": true, "sample": [0], "rank": [160500]},
  "scatter": {"ns": {"log": true, "count": 212000, "sample": [0], "stats": [["Kendall’s τ-b", "0.912"], ...]}},
  "benchmark_stats": [[0, 5320, [["Average error", "12.0%"], ["Max error", "88.1%"]]]]
}
```

`samples` holds the union of the three samples in columns, and the charts index into it. A sample carries what click-through needs (`plot`, `x`, `pair`) and, through `plots` (`[group index, benchmark index, non_scaling_params]`), what hover needs (`PointDescription` reads `point.non_scaling_params.launch`, `site/PointDetails.jsx:41`). The full point is loaded on selection. Group indices refer to the summary's own `groups` array (`[id, key, name]` from the same snapshot, in id order), never to the manifest's `group_order`. In a multi-group Overview, pairs are relabeled per group as today. `benchmark_stats` entries are `[benchmark index, comparison count, statistics]`, so each benchmark key is serialized once.

**Byte budget: 2 MB serialized**, well under the 6 MB buffered limit. Worst cases follow from the §3 limits, with JSON escaping at most doubling a key, name, or unit (no control characters): `benchmarks` ≤ 1,000 × 403 bytes ≈ 400 KB; `benchmark_stats` ≤ 1,000 × ≈ 110 bytes ≈ 110 KB; `groups` ≤ 16 × ≈ 830 bytes ≈ 13 KB; `series` ≤ 32 × ≈ 930 bytes ≈ 30 KB; `pairs` ≤ 16 groups × 1,024 × ≈ 12 bytes ≈ 200 KB; per-unit statistics ≤ 32 × ≈ 400 bytes ≈ 13 KB; totals and percentiles ≈ 1 KB. The exact part is therefore under 800 KB, leaving at least 1.2 MB for samples. If the samples do not fit, `buildSummary` halves every sample limit and samples again; at limit 0 it returns the exact part alone, which fits by construction. If a response still exceeds 2 MB (the invariant is broken), the Function returns `500`, logs an error, and caches nothing. Sampling is deterministic and never changes the exact part.

### Summary cache

Rule: compute only on request, and recompute only when new data has arrived and the cached result is at least `SUMMARY_MIN_INTERVAL` old. That is one Netlify environment variable (default 60 s) set from the plan-tier answer (§8): 60 s if the tier's database egress allows it, about 10 minutes on Free. The tier gate changes this value, not the design. Nothing is computed on write; there are no background jobs and no locks.

Each scope has one record in the site-wide Netlify Blobs store `getStore({name: "summaries", consistency: "strong"})` under `v1/<run id>/<scope>` (`group:<id>` or `overview`) ([Netlify Blobs](https://docs.netlify.com/build/data-and-storage/netlify-blobs/); Functions use it without configuration; keys ≤ 600 bytes, metadata ≤ 2 KB). The value is the response body; the metadata is `{key, revision, state, computed_at}`. A live response carries `ETag: "<rid>-<scope>-<revision computed at>"` and answers a matching `If-None-Match` with `304`.

On each request the Function:

1. Reads the record. If it is `completed` and its `key` matches the request, returns it without touching the database. Only such a **warm** hit avoids the database; a completed run with no record computes its summary (step 4).
2. Otherwise reads the run's state and revision. If the record's revision is current, returns it.
3. Otherwise, if the record is younger than `SUMMARY_MIN_INTERVAL` and the run is `running` or `failed`, returns it; the body states its `revision` and `computed_at`, and the viewer shows "summary as of …".
4. Otherwise computes, writes, and returns. Requests after a run becomes `completed` bypass the interval until the final summary is stored, so it is exact; overlapping requests may each compute it, as the no-lock policy accepts.

The write uses `onlyIfMatch` with the ETag read in step 1 (or `onlyIfNew`), so an older computation never overwrites a newer record. If a completed run's write loses, the Function rereads the record: it returns a stored completed result for the same revision, or conditionally publishes its own if the stored revision is older. There is no claim or lease: requests that arrive while a computation runs (about 10 s) may each compute. **Normally there is at most one computation per interval per scope; concurrent requests may duplicate it**, bounded by the number of concurrent viewers, which is small. A `failed` run is not terminal (`open_run` can reopen it), so its summary costs one small query per request and follows the interval like a live run.

### Retention and deletion

Runs are kept until someone deletes them. At about 100 MB per run, the 5 GB storage cap of the Free tier (§8) holds about 40 runs, so on that tier old runs must be deleted. The team owner deletes a run by hand: `DELETE FROM cr.runs WHERE key = '...'` (everything cascades), then deletes every Blob key under `v*/<run id>/`. Immutable responses already in the CDN expire on their own.

## 6. Viewer changes and `data.json` compatibility

The viewer gains a data source interface with two implementations:

- **API source**, when the URL has `?run=KEY`. A query string keeps the relative-asset build working without rewrites.
- **File source**: today's behavior, in memory with `indexReport` and `buildSummary`, so `npm run dev`, `serve.py`, and static hosting keep working.

A build setting, `VITE_HOSTED=1`, is set only in the Netlify build (`netlify.toml`). In the hosted build the root without `run` renders the run list. In the default build the root renders the file viewer from `./data.json`, as today.

`Report` consumes the interface:

- Tabs follow `group_order` (groups with a non-zero visible plot count). With more than one group, Overview is selectable without waiting for a count, and shows an empty state if its summary has zero comparisons; with one group it uses the group's scope (§5). The file source keeps deriving tabs from `indexReport` (`site/App.jsx:244,285-286`).
- `Summary` and the summary drawings in `site/drawing.js` consume the summary object (exact statistics, sampled series) instead of the full pair list.
- Benchmark cards take counts from the manifest, rows from `plots` pages, and benchmark-wide error from `benchmark_stats`.
- A sampled point's details show the sample's own values and derived metrics (error, rank, percentile). The panel also fetches `/points/{plot}/{x}` and merges the raw point only if its `revision` equals the summary's; otherwise it shows it separately, labeled as newer. A response for a selection that has since changed is dropped.

Polling, API source only:

- Poll the manifest every 10 s while the run is `running`, not stale, and the tab is visible; every 60 s after 5 minutes without a new revision.
- Stop once the run is stale (`updated_at` more than 30 minutes old; writers heartbeat every 5 minutes) and offer a manual refresh.
- On a new revision, refetch the visible `plots` pages.
- After every manifest poll, including a `304`, re-request the active summary only if the manifest's revision is greater than the summary's **and** `computed_at + min_interval` has passed, so a run that only heartbeats still catches up. On observing `completed`, fetch the final summary once. On observing `failed` (at load or on a transition) with a manifest revision newer than the summary's, schedule one summary request at `computed_at + min_interval` (or immediately if that has passed), and stop once the revisions match; the manual refresh lets an open viewer discover a reopened run.

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

Export is defined for **completed runs only**, which cannot change while it pages. It reads the manifest, then pages `plots?all=1` without `group` or `benchmark`, over every plot of the run by id, invisible plots included, taking all points of every plot. Round trip is semantic: `export(import(f))` equals `f` up to key order and `data` order, numbers compared as doubles (`1.0` becomes `1`), `report.live` derived from `state`, and empty `statuses` omitted. The result validates against `data.schema.json` unchanged.

## 7. Cost

Rates in Netlify credits ([how credits work](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/), [database billing](https://docs.netlify.com/build/data-and-storage/netlify-database/billing-and-usage/)): database compute 10 per compute-unit hour (the database sleeps after 5 idle minutes); database bandwidth, web bandwidth 20 per GB; function compute 10 per GB-hour (1 GB default memory); requests 2 per 10,000; database storage currently free; Netlify Blobs not listed (unverified, §8). The Open Source plan grants 10,000 credits per month.

Assumptions: three runs per month, each about 6 hours, single group, watched live; all figures unmeasured. Which database tier applies to the Open Source plan is unknown (§8), so the summary line depends on it:

| Item | Credits / month |
|---|---|
| Database awake while runs write (1 CU × 6 h × 3 = 18 CU-h) | 180 |
| Database woken by finished-run views (each view revalidates the manifest, which may wake it; plot-page CDN misses; warm summaries come from Blobs; ≤ 8 CU-h) | ≤ 80 |
| Summary reads, `SUMMARY_MIN_INTERVAL` = 60 s: ≤ 360 per watched run × ≈ 22 MB × 3 = ≈ 24 GB | ≈ 480 |
| Function compute (≈ 10 s at 1 GB per computation, ≈ 3 GB-h) | ≈ 30 |
| Web bandwidth and requests | ≤ 60 |
| **Total** | **≈ 650–850** |

Duplicated computations (§5) add to the summary line in proportion to concurrent viewers. Live plot-page refetches also consume database egress; they are unmeasured, sized in §8 risk 6, and on Free may need the same throttling as summaries. An unwatched run costs no summary reads, and a finished run's summary is computed once (overlapping requests may duplicate that computation). **On the Free tier this does not fit**: one watched run reads about 8 GB, over the 5 GB monthly database egress limit. There `SUMMARY_MIN_INTERVAL` must be about 10 minutes (≤ 36 reads, ≈ 0.8 GB per run, ≈ 2.4 GB per month), which brings the total to about 400 credits.

The polling policy (§6) bounds a forgotten tab; without it, a tab polling every 10 s would keep the database awake around the clock, about 7,200 credits per month.

## 8. Risks to verify before implementation

1. **External connections.** Confirm that a GitHub-hosted runner can connect with the copied connection string (only Team Owners can copy a read-write one, [access control](https://docs.netlify.com/build/data-and-storage/netlify-database/access-control/)), that the owner can create the `cr_ingest` login, and whether a pooled endpoint exists. Measure first-connect latency after the database has slept.
2. **Plan tier (gate).** The [database limits](https://docs.netlify.com/build/data-and-storage/netlify-database/billing-and-usage/#limits) list Free, Personal, Pro, and Enterprise, but not Open Source. Per billing period, Free allows 48 compute-unit hours, 5 GB written, and **5 GB of database egress**, with 5 GB of storage; Pro has no compute-unit cap and 100 GB for each. On Free, writes (18 CU-h, ≈ 0.3 GB written) fit, but storage needs retention (§5) and `SUMMARY_MIN_INTERVAL` must be about 10 minutes (§7). Ask Netlify support which column applies before building.
3. **Storage billing.** Database storage is free "for now"; Blobs rates are not published on the credits page. The summary store holds about 1 MB per run. If storage becomes expensive, revive the deferred R2 archive.
4. **Direct-write coupling.** See §4. Revisit if more than a handful of repositories report; a thin write Function could front the same SQL functions without a schema change.
5. **Summary computation time.** A synchronous Function may run for 60 s ([Functions defaults](https://docs.netlify.com/build/functions/configuration/#default-values)). The aggregated read and pairing of 450,000 points is estimated at about 10 s, unmeasured. If it nears the limit, stream the read; a background Function (≤ 15 minutes) would fit but needs a decision. Longer computations also widen the window in which concurrent requests duplicate work.
6. **Measurements on a synthetic 450,000-point run** in a database branch: `EXPLAIN (ANALYZE, BUFFERS)` of the summary read, plot pages, and manifest counts against the §3 indexes; bytes per summary read (≈ 22 MB) and per live plot-page refetch; summary and page sizes against their budgets; storage per run (≈ 100 MB).
7. **Deploy previews copy production data** ([branching](https://docs.netlify.com/build/data-and-storage/netlify-database/#database-branching)). Confirm the copy is cheap or disable database access for previews. Previews share run ids with production but may diverge, so they cache summaries in a deploy-scoped store (`getDeployStore`), never in `summaries`.

Implementation checklist, before the first real run: a constraint smoke test against the migrated DDL (accepted and rejected `data.json` fixtures; oversize and non-scalar `params`; concurrent first `open_run` calls for one key; `finish_run` repeated and conflicting); a shared fixture test of `plots.visible` against `isMarked`; and the measurements in risk 6.
