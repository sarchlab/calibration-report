// Read API of hosted reports (docs/backend-design.md §5). Platform-free: the
// Netlify Function passes a pg-compatible pool and a Netlify Blobs store, and
// tests pass their own.
import {API_VERSION, buildSummary, summaryLimits} from '../../site/model.js';

const PAGE_BYTES = 4 * 1024 * 1024;
const PAGE_ROWS = 20000;
// Rows read per query of a plot chunk, so a chunk never buffers more than
// this many points beyond its budget.
const PAGE_BATCH = 256;
const SUMMARY_MAX_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const MAX_PLOTS_PER_PAGE = 48;
const drawnStates = [
  'failed',
  'verification_failed',
  'timeout',
  'memory_limit',
  'unsupported',
  'running',
];

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
        `SELECT group_id, benchmark_id, count(*)::int AS plots, min(id) AS first
         FROM cr.plots WHERE run_id = $1 AND visible
         GROUP BY group_id, benchmark_id ORDER BY first`,
        [run.id],
      );
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
          count.plots,
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
      const [{total}] = await rows(
        client,
        `SELECT count(*)::int AS total FROM cr.plots
         WHERE group_id = $1 AND benchmark_id = $2 AND visible`,
        [ids.group_id, ids.benchmark_id],
      );
      const plots = await rows(
        client,
        `SELECT id, params FROM cr.plots
         WHERE group_id = $1 AND benchmark_id = $2 AND visible
         ORDER BY id OFFSET $3 LIMIT $4`,
        [ids.group_id, ids.benchmark_id, offset, limit],
      );
      const params = new Map(plots.map((p) => [String(p.id), p.params]));
      const byPlot = new Map();
      // The envelope counts against the budget: every page plot with its
      // parameters, and the longest cursor.
      const envelope = encoder.encode(
        JSON.stringify({
          revision: run.revision,
          total,
          plots: plots.map((p) => ({id: p.id, non_scaling_params: p.params, rows: []})),
          next: '9'.repeat(20) + ':' + '-1.0000000000000000e+308',
        }),
      ).length;
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
             AND ($2::bigint IS NULL OR (p.plot_id, p.x) > ($2::bigint, $3::float8))
           GROUP BY p.id
           HAVING bool_or(o.value IS NOT NULL OR o.state = ANY ($4::text[]))
           ORDER BY p.plot_id, p.x
           LIMIT ${PAGE_BATCH}`,
          [plots.map((p) => p.id), position?.plot ?? null, position?.x ?? 0, drawnStates],
        );
        for (const row of batch) {
          const point = toPoint(
            row,
            groupKey,
            benchmarkKey,
            params.get(String(row.plot_id)),
          );
          const size = encoder.encode(JSON.stringify(point)).length + 1; // comma
          if (emitted === PAGE_ROWS || (emitted > 0 && bytes + size > PAGE_BYTES)) {
            next = position.plot + ':' + position.x;
            done = true;
            break;
          }
          const id = String(row.plot_id);
          if (!byPlot.has(id)) byPlot.set(id, []);
          byPlot.get(id).push(point);
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
          plots: [...byPlot].map(([id, pagePoints]) => ({
            id: Number(id),
            non_scaling_params: params.get(id),
            rows: pagePoints,
          })),
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

const halve = (limits) =>
  Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, v >> 1]));

// The response body of one canonical scope, read and sized in one snapshot.
// The sample is halved until the complete body (envelope and sampled plot
// parameters included) fits the budget; the exact part never changes, and at
// limit 0 only the exact part remains.
// A one-group run's Overview is its group (§5).
const canonicalScope = (groups) =>
  groups.length === 1 ? 'group:' + groups[0][0] : 'overview';

// Returns null when `requested` no longer resolves to `scope`.
async function computeSummary(pool, key, rid, requested, scope, envelope) {
  return read(
    pool,
    async (client) => {
      const run = await currentRun(client, key, rid);
      let groups = (
        await rows(
          client,
          'SELECT id, key, name FROM cr.groups WHERE run_id = $1 ORDER BY id',
          [run.id],
        )
      ).map((g) => [Number(g.id), g.key, g.name]);
      // The group count may have changed since the scope was resolved: a
      // one-group Overview is no longer its group.
      if (requested === 'overview' && canonicalScope(groups) !== scope) return null;
      if (scope !== 'overview') {
        groups = groups.filter(([id]) => 'group:' + id === scope);
        if (!groups.length) throw new HttpError(404, 'Unknown scope');
      }
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
      const sample = buildSummary({
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
      });
      const plotParams = new Map();
      for (let limits = {...summaryLimits}; ; limits = halve(limits)) {
        const summary = sample(limits);
        const missing = Object.keys(summary.plots).filter((id) => !plotParams.has(id));
        for (const {id, params} of await rows(
          client,
          'SELECT id, params FROM cr.plots WHERE id = ANY ($1::bigint[])',
          [missing],
        ))
          plotParams.set(String(id), params);
        for (const id of Object.keys(summary.plots))
          summary.plots[id][2] = plotParams.get(id);
        const body = envelope(run, summary);
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

// §5 summary cache: compute only on request; recompute only when the run's
// revision changed and the cached result is older than the interval; a
// completed run's summary is final. No locks. Entries are stored under the
// canonical scope only: a one-group run's Overview is its group.
async function summaryResponse(pool, store, key, query, env, now) {
  const rid = query.get('rid');
  const requested = query.get('scope') ?? 'overview';
  if (!/^(overview|group:\d+)$/.test(requested))
    throw new HttpError(400, 'Invalid scope');
  if (rid === null || !/^\d+$/.test(rid)) throw new HttpError(409, 'rid required');
  const interval = Number(env.SUMMARY_MIN_INTERVAL ?? 60);
  const blobKey = (scope) => `${API_VERSION}/${rid}/${scope}`;
  const respond = (body) => json(body, {immutable: body.state === 'completed'});
  const lookup = (scope) => store.getWithMetadata(blobKey(scope), {type: 'json'});
  const final = (entry) =>
    entry?.metadata.state === 'completed' && entry.metadata.key === key;

  // A requested scope that has an entry is canonical: a completed one is
  // served without the database.
  let cached = await lookup(requested);
  if (final(cached)) return respond(cached.data);

  // Resolve the canonical scope and read its baseline entry before the
  // computing snapshot; if the scope changes meanwhile, start over.
  let scope, body;
  for (let attempt = 0; !body; attempt++) {
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
      if (final(cached)) return respond(cached.data);
    }
    // `cached` was read before the snapshot below, so the conditional write
    // can only replace the entry this computation saw.
    if (cached && cached.metadata.key === key) {
      if (Number(cached.metadata.revision) === Number(run.revision))
        return respond(cached.data);
      const age = (now() - Date.parse(cached.metadata.computed_at)) / 1000;
      if (run.state !== 'completed' && age < interval) return respond(cached.data);
    }
    const computedAt = new Date(now()).toISOString();
    body = await computeSummary(pool, key, rid, requested, scope, (current, summary) => ({
      rid: current.id,
      key,
      scope,
      revision: current.revision,
      state: current.state,
      computed_at: computedAt,
      min_interval: interval,
      ...summary,
    }));
  }
  const metadata = {
    key,
    revision: body.revision,
    state: body.state,
    computed_at: body.computed_at,
  };
  const target = blobKey(scope);
  const write = await store.setJSON(target, body, {
    metadata,
    ...(cached ? {onlyIfMatch: cached.etag} : {onlyIfNew: true}),
  });
  if (!write.modified && body.state === 'completed') {
    // Another request wrote first: keep a final result, never an older one.
    const stored = await store.getWithMetadata(target, {type: 'json'});
    if (final(stored) && Number(stored.metadata.revision) === body.revision)
      return respond(stored.data);
    if (stored && Number(stored.metadata.revision) < body.revision)
      await store.setJSON(target, body, {metadata, onlyIfMatch: stored.etag});
  }
  return respond(body);
}

export async function handleApi(
  request,
  {pool, store, env = {}, now = () => Date.now()},
) {
  try {
    if (request.method !== 'GET') throw new HttpError(405, 'GET only');
    const url = new URL(request.url);
    const prefix = `/api/${API_VERSION}/runs`;
    if (!url.pathname.startsWith(prefix)) throw new HttpError(404, 'Not found');
    const parts = url.pathname
      .slice(prefix.length)
      .split('/')
      .filter(Boolean)
      .map(decodeURIComponent);
    const query = url.searchParams;
    if (parts.length === 0) return await listRuns(pool);
    const [key, resource, ...rest] = parts;
    if (resource === undefined) return await manifest(pool, key);
    if (resource === 'summary' && rest.length === 0)
      return await summaryResponse(pool, store, key, query, env, now);
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
