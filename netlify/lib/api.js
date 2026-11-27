// Read API of hosted reports (docs/backend-design.md §5). Platform-free: the
// Netlify Function passes a pg-compatible pool and a Netlify Blobs store, and
// tests pass their own.
import {
  API_VERSION,
  PAIRS_FORMAT,
  PLOTS_FORMAT,
  SUMMARY_FORMAT,
  buildPairs,
  buildSummary,
  summaryLimits,
} from '../../site/model.js';

const PAGE_BYTES = 4 * 1024 * 1024;
const PAGE_ROWS = 20000;
// Rows read per query of a plot chunk, so a chunk never buffers more than
// this many points beyond its budget.
const PAGE_BATCH = 256;
const SUMMARY_MAX_BYTES = 2 * 1024 * 1024;
// Total serialized pages of one scope's pairs (§5 Pairs); a larger scope
// keeps its sampled charts. `PAIRS_MAX_BYTES` in the environment lowers it.
const PAIRS_MAX_BYTES = 64 * 1024 * 1024;
const encoder = new TextEncoder();
const MAX_PLOTS_PER_PAGE = 48;
// The chart of a plot: chartParams (site/model.js) in SQL. Plots whose
// params name a `launch_group` share a chart across `launch` values; any
// other plot is its own chart.
const chartKey = `CASE WHEN params ? 'launch_group' THEN params - 'launch' ELSE params END`;
// parseLaunch (site/model.js) in SQL: `.` matches any character.
const launchLabel = `'^#[0-9]+ .+$'`;
const drawnStates = [
  'failed',
  'verification_failed',
  'timeout',
  'memory_limit',
  'unsupported',
  'running',
];
// The indexReport row filter: a value or a drawn status.
const drawnPoint = `EXISTS (SELECT 1 FROM cr.observations o WHERE o.point_id = p.id
  AND (o.value IS NOT NULL OR o.state = ANY ($DRAWN::text[])))`;

// Launch-ordinal benchmarks (launchOrdinalBenchmarks in site/model.js) among
// the visible plots matching `scope` (SQL over cr.plots with parameters from
// `values`), with their chart counts, keyed `group_id:benchmark_id`. A
// candidate's visible plots all have an ordinal `launch` and no
// `launch_group`; it is launch-ordinal when, for some params - 'launch', its
// launch counts (drawn points) differ between x values. Each
// (params - 'launch', x) is one chart.
async function launchOrdinalCharts(client, scope, values) {
  const drawn = drawnPoint.replace('$DRAWN', '$' + (values.length + 1));
  const found = await rows(
    client,
    `WITH candidates AS (
       SELECT group_id, benchmark_id FROM cr.plots WHERE ${scope} AND visible
       GROUP BY group_id, benchmark_id
       HAVING bool_and(coalesce(params->>'launch' ~ ${launchLabel}, false)
                       AND NOT params ? 'launch_group')),
     charts AS (
       SELECT pl.group_id, pl.benchmark_id, pl.params - 'launch' AS rest, count(*) AS launches
       FROM candidates c
       JOIN cr.plots pl USING (group_id, benchmark_id)
       JOIN cr.points p ON p.plot_id = pl.id
       WHERE pl.visible AND ${drawn}
       GROUP BY pl.group_id, pl.benchmark_id, pl.params - 'launch', p.x),
     varying AS (
       SELECT group_id, benchmark_id, min(launches) <> max(launches) AS varies, count(*) AS n
       FROM charts GROUP BY group_id, benchmark_id, rest)
     SELECT group_id, benchmark_id, sum(n)::int AS charts FROM varying
     GROUP BY group_id, benchmark_id HAVING bool_or(varies)`,
    [...values, drawnStates],
  );
  return new Map(found.map((r) => [r.group_id + ':' + r.benchmark_id, r.charts]));
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(body, {status = 200, immutable = false} = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': immutable
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    },
  });
}

// Every database read runs in a read-only transaction: the platform
// connection is the owner role.
async function read(pool, fn, isolation = 'READ COMMITTED') {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation} READ ONLY`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function rows(client, text, values) {
  return (await client.query(text, values)).rows;
}

// The run named by key, which must still have id rid.
async function currentRun(client, key, rid) {
  const [run] = await rows(
    client,
    'SELECT id, key, state, revision FROM cr.runs WHERE key = $1',
    [key],
  );
  if (!run) throw new HttpError(404, 'Unknown run');
  if (rid === null || String(run.id) !== rid)
    throw new HttpError(409, 'The run was replaced; reload its manifest');
  return {...run, id: Number(run.id), revision: Number(run.revision)};
}

async function listRuns(pool) {
  const runs = await read(pool, (client) =>
    rows(
      client,
      `SELECT key, title, state, progress, updated_at FROM cr.runs
       ORDER BY created_at DESC, id DESC`,
    ),
  );
  return json(runs);
}

async function manifest(pool, key) {
  return read(
    pool,
    async (client) => {
      const [run] = await rows(
        client,
        `SELECT id, title, description, state, progress, revision, updated_at
         FROM cr.runs WHERE key = $1`,
        [key],
      );
      if (!run) throw new HttpError(404, 'Unknown run');
      const groups = await rows(
        client,
        'SELECT id, key, name FROM cr.groups WHERE run_id = $1 ORDER BY id',
        [run.id],
      );
      const benchmarks = await rows(
        client,
        `SELECT id, key, scaling_param FROM cr.benchmarks
         WHERE run_id = $1 ORDER BY id`,
        [run.id],
      );
      const params = await rows(
        client,
        `SELECT p.benchmark_id, p.key, p.unit FROM cr.params p
         JOIN cr.benchmarks b ON b.id = p.benchmark_id
         WHERE b.run_id = $1 ORDER BY p.benchmark_id, p.ordinal`,
        [run.id],
      );
      const series = await rows(
        client,
        `SELECT s.benchmark_id, s.key, s.name, s.unit, s.role FROM cr.series s
         JOIN cr.benchmarks b ON b.id = s.benchmark_id
         WHERE b.run_id = $1 ORDER BY s.id`,
        [run.id],
      );
      const counts = await rows(
        client,
        `SELECT group_id, benchmark_id, count(DISTINCT ${chartKey})::int AS plots,
                min(id) AS first
         FROM cr.plots WHERE run_id = $1 AND visible
         GROUP BY group_id, benchmark_id ORDER BY first`,
        [run.id],
      );
      const ordinal = await launchOrdinalCharts(client, 'run_id = $1', [run.id]);
      // Keys are producer-chosen (`constructor`, `__proto__`, "10"): build
      // objects without a prototype and carry order in arrays.
      const record = () => Object.create(null);
      const benchmarkById = new Map();
      const benchmarkMeta = record();
      benchmarks.forEach((benchmark, index) => {
        benchmarkById.set(String(benchmark.id), {key: benchmark.key, index});
        benchmarkMeta[benchmark.key] = {
          scaling_param: benchmark.scaling_param,
          params: record(),
          values: record(),
        };
      });
      // Declaration order of each benchmark's parameters, by benchmark index:
      // JSON objects reorder numeric-looking keys.
      const paramKeys = benchmarks.map(() => []);
      for (const param of params) {
        const benchmark = benchmarkById.get(String(param.benchmark_id));
        benchmarkMeta[benchmark.key].params[param.key] = {unit: param.unit};
        paramKeys[benchmark.index].push(param.key);
      }
      for (const {benchmark_id, key, name, unit, role} of series)
        benchmarkMeta[benchmarkById.get(String(benchmark_id)).key].values[key] =
          role ? {name, unit, role} : {name, unit};
      const groupKey = new Map(groups.map((g) => [String(g.id), g.key]));
      const plots = record();
      const groupOrder = [];
      for (const count of counts) {
        const group = groupKey.get(String(count.group_id));
        if (!plots[group]) {
          plots[group] = [];
          groupOrder.push(group);
        }
        plots[group].push([
          benchmarkById.get(String(count.benchmark_id)).index,
          ordinal.get(count.group_id + ':' + count.benchmark_id) ?? count.plots,
        ]);
      }
      const reportGroups = record();
      const groupIds = record();
      for (const g of groups) {
        reportGroups[g.key] = {name: g.name};
        groupIds[g.key] = Number(g.id);
      }
      return json({
        id: Number(run.id),
        revision: Number(run.revision),
        state: run.state,
        updated_at: run.updated_at,
        report: {
          title: run.title,
          description: run.description,
          live: run.state === 'running',
          groups: reportGroups,
        },
        group_ids: groupIds,
        group_order: groupOrder,
        benchmark_keys: benchmarks.map((b) => b.key),
        param_keys: paramKeys,
        progress: run.progress,
        benchmarks: benchmarkMeta,
        plots,
      });
    },
    'REPEATABLE READ',
  );
}

// One data.json point per row: values and statuses aggregated from
// observations.
const pointColumns = `
  p.plot_id, p.x,
  coalesce(jsonb_object_agg(s.key, o.value) FILTER (WHERE o.in_values), '{}') AS values,
  jsonb_object_agg(s.key, jsonb_strip_nulls(jsonb_build_object(
    'state', o.state, 'reason', o.reason, 'symbol', o.symbol)))
    FILTER (WHERE o.state IS NOT NULL) AS statuses`;
const pointJoins = `
  FROM cr.points p
  JOIN cr.observations o ON o.point_id = p.id
  JOIN cr.series s ON s.id = o.series_id`;

function toPoint(row, group, benchmark, params) {
  const point = {
    group,
    benchmark,
    x: row.x,
    non_scaling_params: params,
    values: row.values,
  };
  if (row.statuses) point.statuses = row.statuses;
  return point;
}

function parseCursor(after) {
  if (after === null) return null;
  const split = after.indexOf(':');
  const plot = after.slice(0, split);
  const x = Number(after.slice(split + 1));
  if (split < 1 || !/^\d+$/.test(plot) || !Number.isFinite(x))
    throw new HttpError(400, 'Invalid cursor');
  return {plot, x};
}

function nonNegativeInteger(value, fallback, name) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) throw new HttpError(400, 'Invalid ' + name);
  return Number(value);
}

async function plotPage(pool, key, query) {
  const rid = query.get('rid');
  const groupKey = query.get('group');
  const benchmarkKey = query.get('benchmark');
  if (groupKey === null || benchmarkKey === null)
    throw new HttpError(400, 'group and benchmark are required');
  // A request without the current format comes from an older viewer, whose
  // offsets count plots rather than charts.
  if (query.get('format') !== String(PLOTS_FORMAT))
    throw new HttpError(400, 'Unsupported plots format; reload the page');
  const offset = nonNegativeInteger(query.get('offset'), 0, 'offset');
  const limit = Math.min(
    MAX_PLOTS_PER_PAGE,
    nonNegativeInteger(query.get('limit'), 6, 'limit'),
  );
  const cursor = parseCursor(query.get('after'));
  return read(
    pool,
    async (client) => {
      const run = await currentRun(client, key, rid);
      const [ids] = await rows(
        client,
        `SELECT g.id AS group_id, b.id AS benchmark_id FROM cr.groups g, cr.benchmarks b
         WHERE g.run_id = $1 AND b.run_id = $1 AND g.key = $2 AND b.key = $3`,
        [run.id, groupKey, benchmarkKey],
      );
      if (!ids) throw new HttpError(404, 'Unknown group or benchmark');
      const ordinal =
        (
          await launchOrdinalCharts(client, 'group_id = $1 AND benchmark_id = $2', [
            ids.group_id,
            ids.benchmark_id,
          ])
        ).size > 0;
      // Charts are paged; each is named by its first plot id and lists its
      // plots, which page together. A launch-ordinal chart is one
      // (params - 'launch', x), named by its first drawn point id, and lists
      // each of its plots at that x, so a plot spans the charts of its xs.
      const scope = [ids.group_id, ids.benchmark_id];
      const visible = ordinal
        ? `SELECT pl.id, pl.params, p.x,
                  min(p.id) OVER (PARTITION BY pl.params - 'launch', p.x) AS chart
           FROM cr.plots pl JOIN cr.points p ON p.plot_id = pl.id
           WHERE pl.group_id = $1 AND pl.benchmark_id = $2 AND pl.visible
             AND ${drawnPoint.replace('$DRAWN', '$3')}`
        : `SELECT id, params, NULL::float8 AS x,
                  min(id) OVER (PARTITION BY ${chartKey}) AS chart
           FROM cr.plots WHERE group_id = $1 AND benchmark_id = $2 AND visible`;
      if (ordinal) scope.push(drawnStates);
      const [{total}] = await rows(
        client,
        `SELECT count(DISTINCT chart)::int AS total FROM (${visible}) v`,
        scope,
      );
      const plots = await rows(
        client,
        `WITH v AS (${visible}),
              page AS (SELECT DISTINCT chart FROM v ORDER BY chart
                       OFFSET $${scope.length + 1} LIMIT $${scope.length + 2})
         SELECT v.id, v.params, v.x, v.chart FROM v JOIN page USING (chart)
         ORDER BY v.id, v.x`,
        [...scope, offset, limit],
      );
      // The chart entry of a row: its plot, or its plot at its x.
      const entryKey = (id, x) => (ordinal ? id + ':' + x : id);
      const entryOf = new Map(plots.map((p) => [entryKey(String(p.id), p.x), p]));
      const byPlot = new Map();
      // The envelope counts against the budget: the longest cursor, and each
      // plot of the response with its parameters once it has a row.
      const envelope = encoder.encode(
        JSON.stringify({
          revision: run.revision,
          total,
          ...(ordinal && {launch_ordinal: true}),
          plots: [],
          next: '9'.repeat(20) + ':' + '-1.0000000000000000e+308',
        }),
      ).length;
      const plotEntry = (plot, pagePoints) => ({
        id: Number(plot.id),
        chart: Number(plot.chart),
        non_scaling_params: plot.params,
        rows: pagePoints,
      });
      let bytes = envelope,
        emitted = 0,
        next = null,
        position = cursor,
        done = plots.length === 0;
      // Bounded batches inside this snapshot, stopping at the first row that
      // does not fit; `next` names the last emitted row.
      while (!done) {
        const batch = await rows(
          client,
          `SELECT ${pointColumns} ${pointJoins}
           WHERE p.plot_id = ANY ($1::bigint[])
             AND ($5::float8[] IS NULL
                  OR (p.plot_id, p.x) IN (SELECT * FROM unnest($1::bigint[], $5::float8[])))
             AND ($2::bigint IS NULL OR (p.plot_id, p.x) > ($2::bigint, $3::float8))
           GROUP BY p.id
           HAVING bool_or(o.value IS NOT NULL OR o.state = ANY ($4::text[]))
           ORDER BY p.plot_id, p.x
           LIMIT ${PAGE_BATCH}`,
          [
            plots.map((p) => p.id),
            position?.plot ?? null,
            position?.x ?? 0,
            drawnStates,
            ordinal ? plots.map((p) => p.x) : null,
          ],
        );
        for (const row of batch) {
          const id = String(row.plot_id);
          const key = entryKey(id, row.x);
          const plot = entryOf.get(key);
          const point = toPoint(row, groupKey, benchmarkKey, plot.params);
          let size = encoder.encode(JSON.stringify(point)).length + 1; // comma
          if (!byPlot.has(key))
            size += encoder.encode(JSON.stringify(plotEntry(plot, []))).length + 1;
          if (emitted === PAGE_ROWS || (emitted > 0 && bytes + size > PAGE_BYTES)) {
            next = position.plot + ':' + position.x;
            done = true;
            break;
          }
          if (!byPlot.has(key)) byPlot.set(key, []);
          byPlot.get(key).push(point);
          bytes += size;
          emitted++;
          position = {plot: id, x: row.x};
        }
        if (batch.length < PAGE_BATCH) done = true;
      }
      return json(
        {
          revision: run.revision,
          total,
          ...(ordinal && {launch_ordinal: true}),
          plots: [...byPlot].map(([key, pagePoints]) => plotEntry(entryOf.get(key), pagePoints)),
          next,
        },
        {immutable: run.state === 'completed'},
      );
    },
    'REPEATABLE READ',
  );
}

async function singlePoint(pool, key, query, plot, x) {
  if (!/^\d+$/.test(plot) || !Number.isFinite(Number(x)))
    throw new HttpError(400, 'Invalid point');
  return read(
    pool,
    async (client) => {
      const run = await currentRun(client, key, query.get('rid'));
      const [row] = await rows(
        client,
        `SELECT ${pointColumns}, g.key AS group_key, b.key AS benchmark_key,
                pl.params ${pointJoins}
         JOIN cr.plots pl ON pl.id = p.plot_id
         JOIN cr.groups g ON g.id = pl.group_id
         JOIN cr.benchmarks b ON b.id = pl.benchmark_id
         WHERE pl.run_id = $1 AND p.plot_id = $2 AND p.x = $3
         GROUP BY p.id, g.key, b.key, pl.params`,
        [run.id, plot, Number(x)],
      );
      if (!row) throw new HttpError(404, 'Unknown point');
      return json(
        {
          revision: run.revision,
          point: toPoint(row, row.group_key, row.benchmark_key, row.params),
        },
        {immutable: run.state === 'completed'},
      );
    },
    'REPEATABLE READ',
  );
}

// Live progress of the whole run, derived from its written points: parallel
// writers cannot maintain runs.progress, which then changes only at open and
// finish (§5). A point counts once,
// by the observations of its benchmark's simulator_output series (a missing
// observation counts as queued): failed if any has a state other than queued
// or running, else running if any is running, else completed if every one
// has a value and no state, else queued. Points of benchmarks without a
// simulator_output series are not counted. Every scope's summary carries
// the whole run's progress, so the progress card does not change with tabs.
async function runPointProgress(client, groups) {
  const progress = {total: 0, completed: 0, running: 0, failed: 0, queued: 0};
  for (const {status, n} of await rows(
    client,
    `SELECT status, count(*)::int AS n FROM (
       SELECT CASE
         WHEN bool_or(o.state NOT IN ('queued', 'running')) THEN 'failed'
         WHEN bool_or(o.state = 'running') THEN 'running'
         WHEN bool_and(o.value IS NOT NULL AND o.state IS NULL) THEN 'completed'
         ELSE 'queued' END AS status
       FROM cr.points p
       JOIN cr.series s ON s.benchmark_id = p.benchmark_id AND s.role = 'simulator_output'
       LEFT JOIN cr.observations o ON o.point_id = p.id AND o.series_id = s.id
       WHERE p.group_id = ANY ($1::bigint[])
       GROUP BY p.id) per_point
     GROUP BY status`,
    [groups.map(([id]) => id)],
  )) {
    progress[status] = n;
    progress.total += n;
  }
  return progress;
}

const halve = (limits) =>
  Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, v >> 1]));

// The response body of one canonical scope, read and sized in one snapshot.
// The sample is halved until the complete body (envelope and sampled plot
// parameters included) fits the budget; the exact part never changes, and at
// limit 0 only the exact part remains.
// A one-group run's Overview is its group (§5).
const canonicalScope = (groups) =>
  groups.length === 1 ? 'group:' + groups[0][0] : 'overview';

// The groups and comparison input of one canonical scope, read in the
// caller's snapshot: `all` is every group of the run, `input` what
// buildSummary and buildPairs take. Returns null when `requested` no longer
// resolves to `scope`.
async function readScope(client, run, requested, scope) {
  const all = (
    await rows(
      client,
      'SELECT id, key, name FROM cr.groups WHERE run_id = $1 ORDER BY id',
      [run.id],
    )
  ).map((g) => [Number(g.id), g.key, g.name]);
  // The group count may have changed since the scope was resolved: a
  // one-group Overview is no longer its group.
  if (requested === 'overview' && canonicalScope(all) !== scope) return null;
  const groups =
    scope === 'overview' ? all : all.filter(([id]) => 'group:' + id === scope);
  if (!groups.length) throw new HttpError(404, 'Unknown scope');
  const series = await rows(
    client,
    `SELECT b.id AS benchmark_id, b.key AS benchmark, s.key, s.name, s.unit, s.role
     FROM cr.series s JOIN cr.benchmarks b ON b.id = s.benchmark_id
     WHERE b.run_id = $1 ORDER BY s.id`,
    [run.id],
  );
  const benchmarks = Object.create(null);
  const benchmarkKey = new Map();
  for (const {benchmark_id, benchmark, key, name, unit, role} of series) {
    benchmarkKey.set(String(benchmark_id), benchmark);
    benchmarks[benchmark] ??= {values: Object.create(null)};
    benchmarks[benchmark].values[key] = role ? {name, unit, role} : {name, unit};
  }
  const groupKey = new Map(groups.map(([id, key]) => [String(id), key]));
  // One row per point: the values of its role-tagged series.
  const points = await rows(
    client,
    `SELECT p.group_id, p.benchmark_id, p.plot_id, p.x,
            array_agg(s.key ORDER BY s.id) AS keys,
            array_agg(o.value ORDER BY s.id) AS vals
     FROM cr.points p
     JOIN cr.observations o ON o.point_id = p.id
     JOIN cr.series s ON s.id = o.series_id
     WHERE p.group_id = ANY ($1::bigint[]) AND s.role IS NOT NULL AND o.value IS NOT NULL
     GROUP BY p.id ORDER BY p.id`,
    [groups.map(([id]) => id)],
  );
  return {
    all,
    input: {
      rows: points.map((point) => ({
        group: groupKey.get(String(point.group_id)),
        benchmark: benchmarkKey.get(String(point.benchmark_id)),
        plot: Number(point.plot_id),
        x: point.x,
        values: Object.fromEntries(point.keys.map((k, i) => [k, point.vals[i]])),
      })),
      benchmarks,
      groups,
      overview: scope === 'overview',
    },
  };
}

// Fills `plots[id][2]` with each plot's non_scaling_params, reading only the
// ids not in `known` (a Map of params by id, extended in place).
async function fillPlotParams(client, plots, known = new Map()) {
  const missing = Object.keys(plots).filter((id) => !known.has(id));
  for (const {id, params} of await rows(
    client,
    'SELECT id, params FROM cr.plots WHERE id = ANY ($1::bigint[])',
    [missing],
  ))
    known.set(String(id), params);
  for (const id of Object.keys(plots)) plots[id][2] = known.get(id);
}

// Returns null when `requested` no longer resolves to `scope`.
async function computeSummary(pool, key, rid, requested, scope, envelope) {
  return read(
    pool,
    async (client) => {
      const run = await currentRun(client, key, rid);
      const scoped = await readScope(client, run, requested, scope);
      if (!scoped) return null;
      const pointProgress = await runPointProgress(client, scoped.all);
      const sample = buildSummary(scoped.input);
      const plotParams = new Map();
      for (let limits = {...summaryLimits}; ; limits = halve(limits)) {
        const summary = sample(limits);
        await fillPlotParams(client, summary.plots, plotParams);
        const body = envelope(run, {...summary, point_progress: pointProgress});
        const exactOnly = !Object.values(limits).some(Boolean);
        if (encoder.encode(JSON.stringify(body)).length <= SUMMARY_MAX_BYTES)
          return body;
        if (exactOnly) {
          console.error('Summary over budget', key, scope);
          throw new HttpError(500, 'Summary over budget');
        }
      }
    },
    'REPEATABLE READ',
  );
}

const byteLength = (value) => encoder.encode(JSON.stringify(value)).length;

// Splits a buildPairs body into pages of at most PAGE_BYTES serialized, each
// self-contained: `envelope`, the comparison tables, `offset` (index of its
// first comparison), `next` (the next page's offset or null), and the
// `samples` columns of its comparisons with the `plots` they name. There is
// always at least one page. Returns null as soon as the pages exceed `total`
// bytes in all. Exported for tests, which pass small budgets.
export function pairPages(body, envelope, limit = PAGE_BYTES, total = PAIRS_MAX_BYTES) {
  const {plots, samples, ...tables} = body;
  const empty = () => ({plot: [], x: [], pair: [], actual: [], prediction: []});
  // Sized with the longest offset and next.
  const base =
    byteLength({
      ...envelope,
      ...tables,
      offset: Number.MAX_SAFE_INTEGER,
      next: Number.MAX_SAFE_INTEGER,
      plots: {},
      samples: empty(),
    });
  // The tables are bounded (§3) far below the budget.
  if (base >= limit) {
    console.error('Pairs header over budget', envelope.key, envelope.scope);
    throw new HttpError(500, 'Pairs over budget');
  }
  const pages = [];
  let page = null,
    bytes = 0,
    done = 0; // bytes of the pages before `page`
  const start = (offset) => {
    done += bytes;
    page = {...envelope, ...tables, offset, next: null, plots: {}, samples: empty()};
    pages.push(page);
    bytes = base;
  };
  start(0);
  const columns = Object.keys(samples);
  for (let i = 0; i < body.count; i++) {
    const plot = samples.plot[i];
    let size = columns.reduce((sum, column) => sum + byteLength(samples[column][i]) + 1, 0);
    const named = plot in page.plots;
    if (!named) size += byteLength(String(plot)) + byteLength(plots[plot]) + 2;
    if (i > page.offset && bytes + size > limit) {
      page.next = i;
      start(i);
      size += named ? byteLength(String(plot)) + byteLength(plots[plot]) + 2 : 0;
    }
    if (!(plot in page.plots)) page.plots[plot] = plots[plot];
    for (const column of columns) page.samples[column].push(samples[column][i]);
    bytes += size;
    if (done + bytes > total) return null;
  }
  return done + bytes > total ? null : pages;
}

// Every comparison of one canonical scope, paged; null when `requested` no
// longer resolves to `scope`.
async function computePairs(pool, key, rid, requested, scope, computedAt, interval, maxBytes) {
  return read(
    pool,
    async (client) => {
      const run = await currentRun(client, key, rid);
      const scoped = await readScope(client, run, requested, scope);
      if (!scoped) return null;
      const body = buildPairs(scoped.input);
      await fillPlotParams(client, body.plots);
      const envelope = {
        rid: run.id,
        key,
        scope,
        revision: run.revision,
        state: run.state,
        computed_at: computedAt,
        min_interval: interval,
      };
      // Over the total budget, a small record says so, so that later
      // requests answer 413 from the cache without recomputing.
      const pages = pairPages(body, envelope, PAGE_BYTES, maxBytes);
      return pages ? {...envelope, pages} : {...envelope, too_large: true, pages: []};
    },
    'REPEATABLE READ',
  );
}

// The validated `rid` and `scope` of a summary or pairs request.
function scopeQuery(query) {
  const rid = query.get('rid');
  const requested = query.get('scope') ?? 'overview';
  if (!/^(overview|group:\d+)$/.test(requested))
    throw new HttpError(400, 'Invalid scope');
  if (rid === null || !/^\d+$/.test(rid)) throw new HttpError(409, 'rid required');
  return {rid, requested};
}

// §5 summary cache, shared by summaries and pairs: compute only on request;
// recompute only when the run's revision changed and the cached result is
// older than the interval; a completed run's result is final. No locks.
// Entries are stored under the canonical scope only: a one-group run's
// Overview is its group. `compute(scope, computedAt)` returns the value to
// store, which carries its `revision`, `state` and `computed_at`, or null
// when `requested` no longer resolves to `scope`. Returns the value.
async function cachedScope({pool, store, key, rid, requested, interval, now, blobKey, compute}) {
  const lookup = (scope) => store.getWithMetadata(blobKey(scope), {type: 'json'});
  const final = (entry) =>
    entry?.metadata.state === 'completed' && entry.metadata.key === key;

  // A requested scope that has an entry is canonical: a completed one is
  // served without the database.
  let cached = await lookup(requested);
  if (final(cached)) return cached.data;

  // Resolve the canonical scope and read its baseline entry before the
  // computing snapshot; if the scope changes meanwhile, start over.
  let scope, value;
  for (let attempt = 0; !value; attempt++) {
    if (attempt === 3) throw new HttpError(503, 'The run is changing; retry');
    const [run] = await read(pool, (client) =>
      rows(
        client,
        `SELECT r.id, r.state, r.revision,
                (SELECT count(*) FROM cr.groups g WHERE g.run_id = r.id)::int AS groups,
                (SELECT min(g.id) FROM cr.groups g WHERE g.run_id = r.id) AS first_group
         FROM cr.runs r WHERE r.key = $1`,
        [key],
      ),
    );
    if (!run) throw new HttpError(404, 'Unknown run');
    if (String(run.id) !== rid)
      throw new HttpError(409, 'The run was replaced; reload its manifest');
    scope =
      requested === 'overview' && run.groups === 1
        ? 'group:' + run.first_group
        : requested;
    if (scope !== requested || attempt > 0) {
      cached = await lookup(scope);
      if (final(cached)) return cached.data;
    }
    // `cached` was read before the snapshot below, so the conditional write
    // can only replace the entry this computation saw.
    if (cached && cached.metadata.key === key) {
      if (Number(cached.metadata.revision) === Number(run.revision))
        return cached.data;
      const age = (now() - Date.parse(cached.metadata.computed_at)) / 1000;
      if (run.state !== 'completed' && age < interval) return cached.data;
    }
    value = await compute(scope, new Date(now()).toISOString());
  }
  const metadata = {
    key,
    revision: value.revision,
    state: value.state,
    computed_at: value.computed_at,
  };
  const target = blobKey(scope);
  const write = await store.setJSON(target, value, {
    metadata,
    ...(cached ? {onlyIfMatch: cached.etag} : {onlyIfNew: true}),
  });
  if (!write.modified && value.state === 'completed') {
    // Another request wrote first: keep a final result, never an older one.
    const stored = await store.getWithMetadata(target, {type: 'json'});
    if (final(stored) && Number(stored.metadata.revision) === value.revision)
      return stored.data;
    if (stored && Number(stored.metadata.revision) < value.revision)
      await store.setJSON(target, value, {metadata, onlyIfMatch: stored.etag});
  }
  return value;
}

async function summaryResponse(pool, store, key, query, env, now) {
  const {rid, requested} = scopeQuery(query);
  // A viewer built for another summary format must reload; one that names
  // none gets the current format.
  const format = query.get('format');
  if (format !== null && format !== String(SUMMARY_FORMAT))
    throw new HttpError(400, 'Unsupported summary format; reload the page');
  const interval = Number(env.SUMMARY_MIN_INTERVAL ?? 60);
  const body = await cachedScope({
    pool,
    store,
    key,
    rid,
    requested,
    interval,
    now,
    blobKey: (scope) => `${API_VERSION}/summary${SUMMARY_FORMAT}/${rid}/${scope}`,
    compute: (scope, computedAt) =>
      computeSummary(pool, key, rid, requested, scope, (current, summary) => ({
        rid: current.id,
        key,
        scope,
        revision: current.revision,
        state: current.state,
        computed_at: computedAt,
        min_interval: interval,
        ...summary,
      })),
  });
  return json(body, {immutable: body.state === 'completed'});
}

// Every comparison of a scope for zoomed summary charts, paged (§5 Pairs).
// The first request (no `revision`) goes through the summary cache policy
// and returns the page at offset 0, naming the canonical `scope` and the
// `revision` it was computed at. Continuations name both and an `offset`
// from `next`, and are served from that cached record only: if it has moved
// to another revision, they get 503 and the viewer starts over.
async function pairsResponse(pool, store, key, query, env, now) {
  const {rid, requested} = scopeQuery(query);
  if (query.get('format') !== String(PAIRS_FORMAT))
    throw new HttpError(400, 'Unsupported pairs format; reload the page');
  const offset = nonNegativeInteger(query.get('offset'), 0, 'offset');
  const revision = query.get('revision');
  const blobKey = (scope) => `${API_VERSION}/pairs${PAIRS_FORMAT}/${rid}/${scope}`;
  let value;
  if (revision === null) {
    if (offset !== 0) throw new HttpError(400, 'A continuation needs its revision');
    const interval = Number(env.SUMMARY_MIN_INTERVAL ?? 60);
    value = await cachedScope({
      pool,
      store,
      key,
      rid,
      requested,
      interval,
      now,
      blobKey,
      compute: (scope, computedAt) =>
        computePairs(
          pool,
          key,
          rid,
          requested,
          scope,
          computedAt,
          interval,
          Number(env.PAIRS_MAX_BYTES ?? PAIRS_MAX_BYTES),
        ),
    });
  } else {
    if (!/^\d+$/.test(revision)) throw new HttpError(400, 'Invalid revision');
    const entry = await store.getWithMetadata(blobKey(requested), {type: 'json'});
    if (entry?.metadata.key !== key || String(entry.metadata.revision) !== revision)
      throw new HttpError(503, 'The run changed; start over');
    value = entry.data;
  }
  if (value.too_large)
    throw new HttpError(413, 'Full data too large; the summary keeps its sample');
  const page = value.pages.find((candidate) => candidate.offset === offset);
  if (!page) throw new HttpError(400, 'Invalid offset');
  return json(page, {immutable: page.state === 'completed'});
}

export async function handleApi(
  request,
  {pool, store, env = {}, now = () => Date.now()},
) {
  try {
    if (request.method !== 'GET') throw new HttpError(405, 'GET only');
    const url = new URL(request.url);
    const prefix = `/api/${API_VERSION}/runs`;
    if (url.pathname !== prefix && !url.pathname.startsWith(prefix + '/'))
      throw new HttpError(404, 'Not found');
    const parts = url.pathname
      .slice(prefix.length)
      .split('/')
      .filter(Boolean)
      .map((part) => {
        try {
          return decodeURIComponent(part);
        } catch {
          throw new HttpError(400, 'Invalid path');
        }
      });
    const query = url.searchParams;
    if (parts.length === 0) return await listRuns(pool);
    const [key, resource, ...rest] = parts;
    if (resource === undefined) return await manifest(pool, key);
    if (resource === 'summary' && rest.length === 0)
      return await summaryResponse(pool, store, key, query, env, now);
    if (resource === 'pairs' && rest.length === 0)
      return await pairsResponse(pool, store, key, query, env, now);
    if (resource === 'plots' && rest.length === 0)
      return await plotPage(pool, key, query);
    if (resource === 'points' && rest.length === 2)
      return await singlePoint(pool, key, query, rest[0], rest[1]);
    throw new HttpError(404, 'Not found');
  } catch (error) {
    if (error instanceof HttpError)
      return json({error: error.message}, {status: error.status});
    console.error(error);
    return json({error: 'Internal error'}, {status: 500});
  }
}
