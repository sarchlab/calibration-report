// @vitest-environment node
// Database and read-API tests. They need a disposable Postgres 17 database:
// CR_TEST_DSN=postgresql://... npm test   (the schema cr is dropped and recreated)
// CR_PYTHON names a Python with psycopg 3 for the import tests (default python3).
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {handleApi} from '../netlify/lib/api.js';
import {runCsv} from '../site/csv.js';
import {
  fdtdReport,
  gaussianPoints,
  launchOrdinalReport,
  nwPoints,
  sradPoints,
} from './launch-fixture.js';
import {
  chartParams,
  comparisonPairs,
  errorPercentiles,
  errorStats,
  decodeSamples,
  indexReport,
  PAIRS_FORMAT,
  rankingStats,
  relabelPairs,
  SUMMARY_FORMAT,
} from '../site/model.js';

const dsn = process.env.CR_TEST_DSN;
const migration = readFileSync(
  new URL(
    '../netlify/database/migrations/0001_calibration_reports.sql',
    import.meta.url,
  ),
  'utf8',
);
const example = JSON.parse(
  readFileSync(new URL('../examples/data.json', import.meta.url), 'utf8'),
);

// Netlify Blobs stand-in with the conditional writes the summary cache uses.
function memoryStore() {
  const entries = new Map();
  let version = 0;
  return {
    entries,
    async getWithMetadata(key) {
      const entry = entries.get(key);
      return entry ? structuredClone(entry) : null;
    },
    async setJSON(key, data, {metadata, onlyIfMatch, onlyIfNew} = {}) {
      const current = entries.get(key);
      if ((onlyIfNew && current) || (onlyIfMatch && current?.etag !== onlyIfMatch))
        return {modified: false};
      const etag = String(++version);
      entries.set(key, {data: structuredClone(data), metadata, etag});
      return {modified: true, etag};
    },
  };
}

// A report with two groups, three benchmarks, untagged series, statuses and
// enough comparisons that summary charts are sampled.
function syntheticReport(points = 4800) {
  const benchmarks = {
    gemm: {
      scaling_param: 'size',
      params: {size: {unit: 'elements'}, launch: {unit: ''}},
      values: {
        hw: {name: 'GPU time', unit: 'ns', role: 'hardware_measurement'},
        sim: {name: 'Simulated time', unit: 'ns', role: 'simulator_output'},
        note: {name: 'Other metric', unit: 'ops'},
      },
    },
    fft: {
      scaling_param: 'n',
      params: {n: {unit: ''}},
      values: {
        hw: {name: 'GPU time', unit: 'ns', role: 'hardware_measurement'},
        sim: {name: 'Simulated time', unit: 'ns', role: 'simulator_output'},
      },
    },
    bw: {
      scaling_param: 'bytes',
      params: {bytes: {unit: 'B'}, stride: {unit: 'B'}},
      values: {
        hwbw: {name: 'GPU bandwidth', unit: 'GB/s', role: 'hardware_measurement'},
        simbw: {name: 'Simulated bandwidth', unit: 'GB/s', role: 'simulator_output'},
      },
    },
  };
  let seed = 7;
  const random = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  const data = [];
  for (let i = 0; i < points; i++) {
    const group = i % 2 === 0 ? 'a' : 'b';
    const benchmark = ['gemm', 'fft', 'bw'][i % 3];
    const x = 2 ** (1 + Math.floor(i / 9) % 20) + Math.floor(i / 180);
    const actual = Math.round(1000 + random() * 1e6);
    const prediction = Math.round(actual * (0.5 + random()));
    const point = {group, benchmark, x, non_scaling_params: {}, values: {}};
    if (benchmark === 'gemm') {
      point.non_scaling_params = {launch: 'k' + (i % 5)};
      point.values = {hw: actual, sim: i % 17 === 0 ? null : prediction, note: i};
      if (i % 17 === 0)
        point.statuses = {sim: {state: 'timeout', reason: 'took too long'}};
    } else if (benchmark === 'fft') {
      point.values = {hw: actual, sim: prediction};
    } else {
      point.non_scaling_params = {stride: (i % 4) * 64};
      point.values = {hwbw: actual / 1000, simbw: prediction / 1000};
      if (i % 29 === 0) {
        point.values = {hwbw: null};
        point.statuses = {hwbw: {state: 'queued'}};
      }
    }
    data.push(point);
  }
  // Disambiguate repeated (group, benchmark, params, x).
  const seen = new Set();
  const unique = data.filter((point) => {
    const key = JSON.stringify([
      point.group,
      point.benchmark,
      point.non_scaling_params,
      point.x,
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    report: {
      title: 'Synthetic calibration',
      description: 'Generated for tests.',
      live: false,
      groups: {a: {name: 'Device A'}, b: {name: 'Device B'}},
    },
    progress: {total: unique.length, completed: unique.length, running: 0},
    benchmarks,
    data: unique,
  };
}

function importReport(report, key, live = false) {
  const dir = mkdtempSync(join(tmpdir(), 'cr-'));
  const file = join(dir, 'data.json');
  writeFileSync(file, JSON.stringify(report));
  execFileSync(
    process.env.CR_PYTHON ?? 'python3',
    [
      'clients/python/calibration_report_writer.py',
      'import',
      file,
      '--run',
      key,
      '--dsn',
      dsn,
      ...(live ? ['--live'] : []),
    ],
    {stdio: 'pipe'},
  );
}

describe.skipIf(!dsn)('hosted backend', () => {
  let pool;
  const sql = (text, values) => pool.query(text, values);
  const call = (fn, ...args) =>
    sql(
      `SELECT cr.${fn}(${args.map((_, i) => '$' + (i + 1)).join(', ')})`,
      args.map((arg) =>
        arg === null || typeof arg === 'string' ? arg : JSON.stringify(arg),
      ),
    );
  const open = (key, report = example.report, benchmarks = example.benchmarks, progress = example.progress) =>
    call('open_run', key, report, benchmarks, progress);
  const put = (key, points, progress = null) =>
    call('put_points', key, points, progress);
  const runOf = async (key) =>
    (await sql('SELECT * FROM cr.runs WHERE key = $1', [key])).rows[0];

  beforeAll(async () => {
    pool = new pg.Pool({connectionString: dsn});
    await sql('DROP SCHEMA IF EXISTS cr CASCADE');
    await sql(migration);
  });
  afterAll(() => pool?.end());

  describe('ingest functions', () => {
    it('stores a valid report and derives plot visibility', async () => {
      await open('valid');
      await put('valid', example.data);
      const plots = (await sql('SELECT params, visible FROM cr.plots')).rows;
      expect(plots).toEqual([{params: {tmax: 10}, visible: true}]);
      const run = await runOf('valid');
      expect(run.state).toBe('running');
      expect(Number(run.revision)).toBe(2);
    });

    const point = example.data[0];
    const invalid = {
      'an undeclared group': {...point, group: 'nope'},
      'an undeclared benchmark': {...point, benchmark: 'nope'},
      'an undeclared series': {...point, values: {other: 1}},
      'empty values': {...point, values: {}},
      'a string value': {...point, values: {mi300x: '1'}},
      'an unknown point key': {...point, extra: 1},
      'a missing x': (({x, ...rest}) => rest)(point),
      'a missing non-scaling parameter': {...point, non_scaling_params: {}},
      'the scaling parameter as non-scaling': {
        ...point,
        non_scaling_params: {tmax: 10, size: 64},
      },
      'a non-scalar parameter value': {...point, non_scaling_params: {tmax: [1]}},
      'an oversize parameter value': {
        ...point,
        non_scaling_params: {tmax: 'x'.repeat(2100)},
      },
      'an unknown status state': {
        ...point,
        statuses: {mgpusim: {state: 'lost'}},
      },
      'an empty status reason': {
        ...point,
        statuses: {mgpusim: {state: 'failed', reason: ''}},
      },
    };
    for (const [name, bad] of Object.entries(invalid))
      it('rejects a point with ' + name, async () => {
        await expect(put('valid', [bad])).rejects.toThrow();
      });

    it('rejects invalid declarations', async () => {
      const {report, benchmarks, progress} = example;
      const bench = benchmarks.polybench_fdtd2d;
      const cases = [
        [{...report, title: ''}, benchmarks, progress],
        [(({live, ...r}) => r)(report), benchmarks, progress],
        [{...report, groups: {}}, benchmarks, progress],
        [report, {b: {...bench, scaling_param: 'missing'}}, progress],
        [report, {b: {...bench, values: {}}}, progress],
        [report, {b: {...bench, values: {s: {name: 'S', unit: '', role: 'other'}}}}, progress],
        [report, benchmarks, {...progress, total: -1}],
        [report, benchmarks, {total: 1, completed: 0}],
        [report, benchmarks, {...progress, extra: 1}],
        [report, {}, progress],
        [
          report,
          {
            b: {
              ...bench,
              params: Object.fromEntries(
                Array.from({length: 33}, (_, i) => ['p' + i, {unit: ''}]),
              ),
              scaling_param: 'p0',
            },
          },
          progress,
        ],
      ];
      for (const [i, args] of cases.entries())
        await expect(open('bad-' + i, ...args), 'case ' + i).rejects.toThrow();
      expect((await sql("SELECT count(*)::int AS n FROM cr.runs WHERE key LIKE 'bad-%'")).rows[0].n).toBe(0);
    });

    it('serializes concurrent first open_run calls for one key', async () => {
      const results = await Promise.all(
        Array.from({length: 6}, () => open('concurrent')),
      );
      expect(new Set(results.map((r) => r.rows[0].open_run)).size).toBe(1);
      const run = await runOf('concurrent');
      expect(Number(run.revision)).toBe(1);
    });

    it('applies the metadata-change rules', async () => {
      const {report, benchmarks, progress} = example;
      const bench = benchmarks.polybench_fdtd2d;
      await open('meta');
      await open('meta');
      expect(Number((await runOf('meta')).revision)).toBe(1);
      await open('meta', {...report, title: 'Renamed'});
      const renamed = await runOf('meta');
      expect([renamed.title, Number(renamed.revision)]).toEqual(['Renamed', 2]);
      // Stored entities may be omitted; new ones are appended.
      await open('meta', {...report, groups: {other: {name: 'Other'}}}, benchmarks);
      expect((await sql("SELECT count(*)::int AS n FROM cr.groups g JOIN cr.runs r ON r.id = g.run_id WHERE r.key = 'meta'")).rows[0].n).toBe(2);
      const rejected = [
        [{...report, groups: {mi300x: {name: 'Changed'}}}, benchmarks],
        [report, {polybench_fdtd2d: {...bench, params: {...bench.params, tmax: {unit: 'iterations'}}}}],
        [report, {polybench_fdtd2d: {...bench, params: {size: {unit: 'cells'}}}}],
        [report, {polybench_fdtd2d: {...bench, scaling_param: 'tmax'}}],
        [report, {polybench_fdtd2d: {...bench, values: {...bench.values, mgpusim: {...bench.values.mgpusim, name: 'Other'}}}}],
        [report, {other: {...bench, values: {mi300x: {name: 'MI300X kernel time', unit: 'us', role: 'hardware_measurement'}}}}],
      ];
      for (const [i, [r, b]] of rejected.entries())
        await expect(open('meta', r, b, progress), 'case ' + i).rejects.toThrow();
      // An untagged series name is part of its declaration, too.
      await open('meta', report, {u: {...bench, values: {plain: {name: 'A', unit: ''}}}});
      await expect(
        open('meta', report, {u: {...bench, values: {plain: {name: 'B', unit: ''}}}}),
      ).rejects.toThrow(/differs/);
    });

    it('accepts integral progress numbers in any JSON spelling', async () => {
      const {report, benchmarks} = example;
      // Raw JSON text, so 2.0 and 2e0 reach the database as written.
      const openRaw = (key, progress) =>
        sql('SELECT cr.open_run($1, $2, $3, $4::json)', [
          key, JSON.stringify(report), JSON.stringify(benchmarks), progress,
        ]);
      await openRaw('integral', '{"total": 2.0, "completed": 2e0, "running": 0}');
      for (const [i, progress] of [
        '{"total": 2.5, "completed": 0, "running": 0}',
        '{"total": -1, "completed": 0, "running": 0}',
        '{"total": "2", "completed": 0, "running": 0}',
        '{"total": 2, "completed": 1e-1, "running": 0}',
      ].entries())
        await expect(openRaw('fractional-' + i, progress)).rejects.toThrow(/non-negative integer/);
      expect((await sql("SELECT count(*)::int AS n FROM cr.runs WHERE key LIKE 'fractional-%'")).rows[0].n).toBe(0);
    });

    it('caps the stored series of a benchmark after appends', async () => {
      const {report, progress} = example;
      const bench = example.benchmarks.polybench_fdtd2d;
      const series = (from, to) =>
        Object.fromEntries(
          Array.from({length: to - from}, (_, i) => ['v' + (from + i), {name: 'V' + (from + i), unit: 'ns'}]),
        );
      await open('cap', report, {c: {...bench, values: series(0, 40)}}, progress);
      await open('cap', report, {c: {...bench, values: series(40, 64)}}, progress);
      // A full redeclaration at 64 is accepted and changes nothing.
      await open('cap', report, {c: {...bench, values: series(0, 64)}}, progress);
      const before = await runOf('cap');
      await expect(
        open('cap', report, {c: {...bench, values: series(64, 65)}}, progress),
      ).rejects.toThrow(/more than 64 series/);
      expect(Number((await runOf('cap')).revision)).toBe(Number(before.revision));
      const count = await sql(
        "SELECT count(*)::int AS n FROM cr.series s JOIN cr.benchmarks b ON b.id = s.benchmark_id JOIN cr.runs r ON r.id = b.run_id WHERE r.key = 'cap'",
      );
      expect(count.rows[0].n).toBe(64);
    });

    it('compares parameter declarations exactly, in order', async () => {
      const {report, progress} = example;
      const bench = example.benchmarks.polybench_fdtd2d;
      const declared = {...bench, params: {size: {unit: 'cells'}, 'a=b': {unit: ''}}};
      await open('params', report, {p: declared}, progress);
      const before = Number((await runOf('params')).revision);
      for (const params of [
        {size: {unit: 'cells'}, a: {unit: 'b='}},
        {'a=b': {unit: ''}, size: {unit: 'cells'}},
      ])
        await expect(open('params', report, {p: {...declared, params}}, progress)).rejects.toThrow(
          /params differ/,
        );
      expect(Number((await runOf('params')).revision)).toBe(before);
    });

    it('finishes idempotently and reopens failed runs', async () => {
      await open('finish');
      await call('finish_run', 'finish', 'failed', null);
      await call('finish_run', 'finish', 'failed', null);
      await expect(put('finish', [])).rejects.toThrow(/failed, not running/);
      await open('finish');
      expect((await runOf('finish')).state).toBe('running');
      await call('finish_run', 'finish', 'completed', {total: 2, completed: 2, running: 0});
      const before = Number((await runOf('finish')).revision);
      await call('finish_run', 'finish', 'completed', null);
      expect(Number((await runOf('finish')).revision)).toBe(before);
      await expect(call('finish_run', 'finish', 'failed', null)).rejects.toThrow();
      await expect(open('finish')).rejects.toThrow(/completed/);
      await expect(call('heartbeat', 'finish')).rejects.toThrow();
    });

    it('replaces only the series named in a batch', async () => {
      await open('replace');
      await put('replace', [{...point, values: {mi300x: 1, mgpusim: null}, statuses: {mgpusim: {state: 'running'}}}]);
      await put('replace', [{...point, values: {mgpusim: 2}}]);
      const values = (
        await sql(
          `SELECT s.key, o.value, o.state FROM cr.observations o JOIN cr.series s ON s.id = o.series_id
           JOIN cr.points p ON p.id = o.point_id JOIN cr.plots pl ON pl.id = p.plot_id
           JOIN cr.runs r ON r.id = pl.run_id WHERE r.key = 'replace' ORDER BY s.key`,
        )
      ).rows;
      expect(values).toEqual([
        {key: 'mgpusim', value: 2, state: null},
        {key: 'mi300x', value: 1, state: null},
      ]);
    });

    it('limits cr_ingest to the four functions', async () => {
      const client = await pool.connect();
      try {
        await client.query('SET ROLE cr_ingest');
        await client.query("SELECT cr.heartbeat('valid')");
        await expect(client.query('SELECT * FROM cr.runs')).rejects.toThrow(/permission/);
        await expect(client.query("SELECT cr.fail('x')")).rejects.toThrow(/permission/);
        await expect(client.query("DELETE FROM cr.runs")).rejects.toThrow(/permission/);
      } finally {
        await client.query('RESET ROLE');
        client.release();
      }
    });
  });

  describe('read API over an imported report', () => {
    const report = syntheticReport();
    const store = memoryStore();
    const api = async (path, options = {}) => {
      const response = await handleApi(
        new Request('http://localhost/api/v1/runs' + path),
        {pool, store, env: {SUMMARY_MIN_INTERVAL: '60'}, ...options},
      );
      return {status: response.status, headers: response.headers, body: await response.json()};
    };
    let manifest;
    const index = indexReport(report.data, report.benchmarks);

    beforeAll(async () => {
      importReport(report, 'synthetic');
      manifest = (await api('/synthetic')).body;
    });

    it('lists runs', async () => {
      const {body, headers} = await api('');
      expect(body.map((run) => run.key)).toContain('synthetic');
      expect(headers.get('cache-control')).toBe('no-cache');
    });

    it('returns a data.json-shaped manifest with ordered arrays', () => {
      expect(manifest.state).toBe('completed');
      expect(manifest.report).toEqual({...report.report, live: false});
      expect(manifest.benchmarks).toEqual(report.benchmarks);
      expect(Object.keys(manifest.benchmarks.gemm.params)).toEqual(['size', 'launch']);
      expect(manifest.group_order).toEqual([...index.groups.keys()]);
      for (const [group, view] of index.groups)
        expect(
          manifest.plots[group].map(([b, count]) => [manifest.benchmark_keys[b], count]),
        ).toEqual(view.benchmarks.map((b) => [b.id, b.series.length]));
    });

    it('pages plots with the rows the file viewer shows', async () => {
      const view = index.groups.get('a').benchmarks.find((b) => b.id === 'gemm');
      const rid = manifest.id;
      const {body, headers} = await api(
        `/synthetic/plots?format=3&rid=${rid}&group=a&benchmark=gemm&offset=1&limit=2`,
      );
      expect(headers.get('cache-control')).toContain('immutable');
      expect(body.total).toBe(view.series.length);
      expect(body.next).toBeNull();
      const expected = view.series.slice(1, 3).map((series) =>
        [...series.rows].sort((a, b) => a.x - b.x),
      );
      expect(body.plots.map((plot) => plot.rows)).toEqual(expected);
      // A continuation cursor resumes after the given row.
      const first = body.plots[0];
      const rest = await api(
        `/synthetic/plots?format=3&rid=${rid}&group=a&benchmark=gemm&offset=1&limit=2&after=${first.id}:${first.rows[0].x}`,
      );
      expect(rest.body.plots[0].rows).toEqual(first.rows.slice(1));
    });

    it('returns single points and rejects replaced run ids', async () => {
      const {body: page} = await api(`/synthetic/plots?format=3&rid=${manifest.id}&group=b&benchmark=gemm`);
      const plot = page.plots[0];
      const {body} = await api(`/synthetic/points/${plot.id}/${plot.rows[0].x}?rid=${manifest.id}`);
      expect(body.point).toEqual(plot.rows[0]);
      expect((await api(`/synthetic/plots?format=3&rid=999999&group=a&benchmark=gemm`)).status).toBe(409);
      expect((await api(`/unknown`)).status).toBe(404);
    });

    it('rejects plot pages of a missing or older format', async () => {
      const path = `/synthetic/plots?rid=${manifest.id}&group=a&benchmark=gemm`;
      for (const format of ['', '&format=1', '&format=2'])
        expect((await api(path + format)).status).toBe(400);
      expect((await api(path + '&format=3')).status).toBe(200);
    });

    it('computes exact summary statistics equal to the file viewer', async () => {
      const groupIds = manifest.group_ids;
      for (const [scope, pairs, overview] of [
        ['overview', index.pairs, true],
        ['group:' + groupIds.a, index.groups.get('a').pairs, false],
        ['group:' + groupIds.b, index.groups.get('b').pairs, false],
      ]) {
        const {body} = await api(`/synthetic/summary?rid=${manifest.id}&scope=${scope}`);
        expect(body.count).toBe(pairs.length);
        expect(body.stats).toEqual(errorStats(pairs));
        expect(body.percentiles).toEqual(errorPercentiles(pairs));
        for (const [unit, unitPairs] of Map.groupBy(pairs, (p) => p.unit))
          expect(body.scatter[unit].stats).toEqual([
            ...rankingStats(unitPairs),
            ...errorStats(unitPairs),
          ]);
        expect(body.relabeled).toBe(overview);
        expect(body.scurve.sample.length).toBeLessThanOrEqual(1500);
        expect(body.scurve.sample.length).toBeLessThan(pairs.length);
        if (!overview)
          for (const [b, count, stats] of body.benchmark_stats) {
            const benchmarkPairs = pairs.filter(
              (p) => p.point.benchmark === body.benchmarks[b],
            );
            expect([count, stats]).toEqual([benchmarkPairs.length, errorStats(benchmarkPairs)]);
          }
      }
    });

    it('serves a completed summary from the cache without the database', async () => {
      const scope = 'group:' + manifest.group_ids.a;
      const broken = {connect: () => Promise.reject(new Error('no database'))};
      const {status, body} = await api(`/synthetic/summary?rid=${manifest.id}&scope=${scope}`, {pool: broken});
      expect(status).toBe(200);
      expect(body.state).toBe('completed');
    });

    it('pages every comparison of a scope, paired as in the summary', async () => {
      const groupIds = manifest.group_ids;
      const key = (pair) =>
        JSON.stringify([pair.point.group, pair.point.benchmark, pair.point.x,
          pair.point.non_scaling_params, pair.id, pair.actual, pair.prediction]);
      for (const [scope, pairs, overview] of [
        ['overview', index.pairs, true],
        ['group:' + groupIds.a, index.groups.get('a').pairs, false],
      ]) {
        const path = `/synthetic/pairs?rid=${manifest.id}&scope=${scope}&format=${PAIRS_FORMAT}`;
        const {status, body, headers} = await api(path);
        expect(status).toBe(200);
        expect(headers.get('cache-control')).toContain('immutable');
        const {body: summary} = await api(`/synthetic/summary?rid=${manifest.id}&scope=${scope}`);
        expect(body.count).toBe(summary.count);
        expect([body.scope, body.revision, body.offset, body.next]).toEqual([
          scope, summary.revision, 0, null,
        ]);
        // The same comparisons, labels and parameters as the file viewer's.
        const expected = relabelPairs(pairs, overview, (g) => report.report.groups[g].name);
        expect(decodeSamples(body).pairs.map(key).sort()).toEqual(expected.map(key).sort());
        // Cached under the run id and scope like the summary: later reads
        // and continuations of a completed run need no database.
        expect(store.entries.get(`v1/pairs${PAIRS_FORMAT}/${manifest.id}/${scope}`).metadata)
          .toMatchObject({key: 'synthetic', revision: summary.revision, state: 'completed'});
        const broken = {connect: () => Promise.reject(new Error('no database'))};
        expect((await api(path, {pool: broken})).body).toEqual(body);
        expect((await api(path + `&offset=0&revision=${body.revision}`, {pool: broken})).body).toEqual(body);
      }
    });

    it('rejects pairs requests of a replaced run, another format or a moved revision', async () => {
      const scope = 'group:' + manifest.group_ids.b;
      const path = (query) => `/synthetic/pairs?scope=${scope}&${query}`;
      expect((await api(path(`rid=999999&format=${PAIRS_FORMAT}`))).status).toBe(409);
      expect((await api(path(`rid=${manifest.id}`))).status).toBe(400);
      expect((await api(path(`rid=${manifest.id}&format=2`))).status).toBe(400);
      expect((await api(path(`rid=${manifest.id}&format=${PAIRS_FORMAT}&offset=5`))).status).toBe(400);
      const {body} = await api(path(`rid=${manifest.id}&format=${PAIRS_FORMAT}`));
      const stale = await api(path(`rid=${manifest.id}&format=${PAIRS_FORMAT}&offset=0&revision=${body.revision - 1}`));
      expect(stale.status).toBe(503);
      const unknown = await api(path(`rid=${manifest.id}&format=${PAIRS_FORMAT}&offset=7&revision=${body.revision}`));
      expect(unknown.status).toBe(400);
    });

    it('rejects malformed paths', async () => {
      const response = await handleApi(new Request('http://localhost/api/v1/runs/%E0%A4%A'), {pool, store});
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('Invalid path');
      const near = await handleApi(new Request('http://localhost/api/v1/runsfoo'), {pool, store});
      expect(near.status).toBe(404);
    });

    it('accepts only GET', async () => {
      const response = await handleApi(
        new Request('http://localhost/api/v1/runs', {method: 'POST'}),
        {pool, store},
      );
      expect(response.status).toBe(405);
    });
  });

  describe('live runs', () => {
    it('shows new points and refreshes the summary after the interval', async () => {
      const report = syntheticReport(300);
      const store = memoryStore();
      let now = Date.parse('2026-11-25T12:00:00Z');
      const api = async (path) => {
        const response = await handleApi(
          new Request('http://localhost/api/v1/runs' + path),
          {pool, store, env: {SUMMARY_MIN_INTERVAL: '60'}, now: () => now},
        );
        return response.json();
      };
      const half = report.data.slice(0, 150);
      importReport({...report, data: half}, 'live', true);
      let manifest = await api('/live');
      expect(manifest.report.live).toBe(true);
      const scope = 'group:' + manifest.group_ids.a;
      const first = await api(`/live/summary?rid=${manifest.id}&scope=${scope}`);
      const countA = (data) =>
        comparisonPairs(data.filter((p) => p.group === 'a'), report.benchmarks).length;
      expect(first.count).toBe(countA(half));

      await put('live', report.data.slice(150));
      manifest = await api('/live');
      expect(manifest.revision).toBeGreaterThan(first.revision);
      const page = await api(`/live/plots?format=3&rid=${manifest.id}&group=a&benchmark=fft&limit=48`);
      expect(page.plots.flatMap((p) => p.rows).length).toBe(
        report.data.filter((p) => p.group === 'a' && p.benchmark === 'fft').length,
      );

      now += 30_000;
      const throttled = await api(`/live/summary?rid=${manifest.id}&scope=${scope}`);
      expect(throttled.revision).toBe(first.revision);
      now += 31_000;
      const refreshed = await api(`/live/summary?rid=${manifest.id}&scope=${scope}`);
      expect(refreshed.revision).toBe(manifest.revision);
      expect(refreshed.count).toBe(countA(report.data));

      // Completion bypasses the interval: the final summary is exact.
      await call('finish_run', 'live', 'completed', null);
      const final = await api(`/live/summary?rid=${manifest.id}&scope=${scope}`);
      expect(final.state).toBe('completed');
      expect(final.revision).toBe(refreshed.revision + 1);
    });
  });

  describe('live pairs', () => {
    it('follows the summary interval and restarts continuations after a newer revision', async () => {
      const report = syntheticReport(300);
      const store = memoryStore();
      let now = Date.parse('2026-11-25T12:00:00Z');
      const api = async (path) => {
        const response = await handleApi(
          new Request('http://localhost/api/v1/runs' + path),
          {pool, store, env: {SUMMARY_MIN_INTERVAL: '60'}, now: () => now},
        );
        return {status: response.status, cache: response.headers.get('cache-control'), body: await response.json()};
      };
      importReport({...report, data: report.data.slice(0, 150)}, 'livepairs', true);
      const manifest = (await api('/livepairs')).body;
      const path = `/livepairs/pairs?rid=${manifest.id}&scope=overview&format=${PAIRS_FORMAT}`;
      const first = await api(path);
      expect(first.cache).toBe('no-cache');
      await put('livepairs', report.data.slice(150));
      now += 30_000;
      expect((await api(path)).body.revision).toBe(first.body.revision);
      now += 31_000;
      const refreshed = await api(path);
      expect(refreshed.body.revision).toBeGreaterThan(first.body.revision);
      expect(refreshed.body.count).toBe(comparisonPairs(report.data, report.benchmarks).length);
      // A continuation of the replaced record starts over.
      const continuation = await api(path + `&offset=0&revision=${first.body.revision}`);
      expect(continuation.status).toBe(503);
    });
  });

  describe('point progress', () => {
    it('counts every point of the run by its simulator observations, in every scope', async () => {
      const sim = (key) => ({name: 'Sim ' + key, unit: 'ns', role: 'simulator_output'});
      const benchmarks = {
        one: {
          scaling_param: 'n',
          params: {n: {unit: ''}},
          values: {hw: {name: 'HW', unit: 'ns', role: 'hardware_measurement'}, sim: sim('sim')},
        },
        two: {scaling_param: 'n', params: {n: {unit: ''}}, values: {s1: sim('s1'), s2: sim('s2')}},
        plain: {scaling_param: 'n', params: {n: {unit: ''}}, values: {other: {name: 'O', unit: ''}}},
      };
      const report = {
        title: 'Progress',
        description: '',
        live: true,
        groups: {a: {name: 'A'}, b: {name: 'B'}},
      };
      await open('progress', report, benchmarks, {total: 99, completed: 0, running: 0});
      let x = 0;
      const pt = (group, benchmark, values, statuses) => ({
        group, benchmark, x: ++x, non_scaling_params: {}, values,
        ...(statuses ? {statuses} : {}),
      });
      await put('progress', [
        pt('a', 'one', {hw: 1, sim: 2}), // completed
        pt('a', 'one', {hw: 1, sim: 2}, {sim: {state: 'timeout'}}), // failed, despite a value
        pt('b', 'one', {sim: null}, {sim: {state: 'failed', reason: 'x'}}), // failed
        pt('b', 'one', {hw: 1}, {sim: {state: 'running'}}), // running
        pt('a', 'one', {hw: 1}, {sim: {state: 'queued'}}), // queued
        pt('a', 'one', {hw: 1}), // queued: no simulator observation
        pt('b', 'one', {sim: null}), // queued: no value
        pt('a', 'two', {s1: 1, s2: 2}), // completed
        pt('a', 'two', {s1: 1}), // queued: s2 missing
        pt('b', 'two', {s1: null}, {s1: {state: 'running'}, s2: {state: 'unsupported'}}), // failed
        pt('b', 'two', {s2: 2}, {s1: {state: 'running'}}), // running
        pt('a', 'plain', {other: 1}), // not counted: no simulator series
      ]);
      const store = memoryStore();
      const api = async (path) =>
        (await handleApi(new Request('http://localhost/api/v1/runs' + path), {pool, store})).json();
      const manifest = await api('/progress');
      const expected = {total: 11, completed: 2, running: 2, failed: 3, queued: 4};
      for (const scope of ['overview', 'group:' + manifest.group_ids.b]) {
        const summary = await api(`/progress/summary?rid=${manifest.id}&scope=${scope}`);
        expect(summary.point_progress, scope).toEqual(expected);
      }
      // The stored progress is unchanged.
      expect(manifest.progress).toEqual({total: 99, completed: 0, running: 0});
    });

    it('rejects an unknown group scope before counting point progress', async () => {
      const queries = [];
      const counting = {
        connect: async () => {
          const client = await pool.connect();
          return {
            query: (text, values) => {
              queries.push(text);
              return client.query(text, values);
            },
            release: () => client.release(),
          };
        },
      };
      const manifest = (
        await (await handleApi(new Request('http://localhost/api/v1/runs/progress'), {pool, store: memoryStore()})).json()
      );
      const response = await handleApi(
        new Request(`http://localhost/api/v1/runs/progress/summary?rid=${manifest.id}&scope=group:999999`),
        {pool: counting, store: memoryStore()},
      );
      expect(response.status).toBe(404);
      expect(queries.some((text) => text.includes('per_point'))).toBe(false);
      expect(queries.some((text) => text.includes('cr.groups'))).toBe(true);
    });

    it('never serves a cached summary of the previous format', async () => {
      await open('format');
      await put('format', example.data);
      await call('finish_run', 'format', 'completed', null);
      const store = memoryStore();
      const api = async (path, p = pool) => {
        const response = await handleApi(
          new Request('http://localhost/api/v1/runs' + path),
          {pool: p, store},
        );
        return {status: response.status, body: await response.json()};
      };
      const manifest = (await api('/format')).body;
      const scope = 'group:' + manifest.group_ids.mi300x;
      // A completed entry written by the previous code, without point_progress.
      store.entries.set(`v1/${manifest.id}/${scope}`, {
        data: {rid: manifest.id, key: 'format', scope, revision: manifest.revision, state: 'completed'},
        metadata: {key: 'format', revision: manifest.revision, state: 'completed', computed_at: new Date().toISOString()},
        etag: 'old',
      });
      const path = `/format/summary?rid=${manifest.id}&scope=${scope}&format=${SUMMARY_FORMAT}`;
      const fresh = await api(path);
      expect(fresh.body.point_progress).toEqual({total: 2, completed: 1, running: 0, failed: 1, queued: 0});
      expect([...store.entries.keys()]).toContain(`v1/summary${SUMMARY_FORMAT}/${manifest.id}/${scope}`);
      // Later reads are served from the new entry, without the database.
      const broken = {connect: () => Promise.reject(new Error('no database'))};
      expect((await api(path, broken)).body).toEqual(fresh.body);
      expect((await api(`/format/summary?rid=${manifest.id}&scope=${scope}&format=1`)).status).toBe(400);
    });
  });

  describe('budgets and producer-chosen keys', () => {
    const api = async (path, {store = memoryStore(), pool: p = pool} = {}) => {
      const response = await handleApi(
        new Request('http://localhost/api/v1/runs' + path),
        {pool: p, store},
      );
      const text = await response.text();
      return {status: response.status, bytes: Buffer.byteLength(text), body: JSON.parse(text)};
    };
    const seed = async (key, report, finish = true) => {
      await open(key, report.report, report.benchmarks, report.progress);
      for (let i = 0; i < report.data.length; i += 250)
        await put(key, report.data.slice(i, i + 250));
      if (finish) await call('finish_run', key, 'completed', null);
      return (await api('/' + key)).body;
    };
    const timing = {
      hw: {name: 'GPU time', unit: 'ns', role: 'hardware_measurement'},
      sim: {name: 'Simulated time', unit: 'ns', role: 'simulator_output'},
    };
    const runReport = (groups, benchmarks, data) => ({
      report: {title: 'Budget', description: '', live: false, groups},
      progress: {total: data.length, completed: data.length, running: 0},
      benchmarks,
      data,
    });

    it('shrinks the summary sample until the whole response fits', async () => {
      const data = Array.from({length: 3000}, (_, i) => ({
        group: 'g',
        benchmark: 'b',
        x: 1,
        non_scaling_params: {tag: i + '-' + 'x'.repeat(1900)},
        values: {hw: 1000 + i, sim: 1000 + i * 1.5},
      }));
      const report = runReport(
        {g: {name: 'G'}},
        {b: {scaling_param: 'x', params: {x: {unit: ''}, tag: {unit: ''}}, values: timing}},
        data,
      );
      const manifest = await seed('wide-params', report);
      const {status, bytes, body} = await api(
        `/wide-params/summary?rid=${manifest.id}&scope=overview`,
      );
      expect(status).toBe(200);
      expect(bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
      const pairs = comparisonPairs(data, report.benchmarks);
      expect(body.count).toBe(3000);
      expect(body.stats).toEqual(errorStats(pairs));
      expect(body.scatter.ns.count).toBe(3000);
      expect(body.scurve.sample.length).toBeGreaterThan(0);
      expect(body.scurve.sample.length).toBeLessThan(1500);
      const sampled = Object.values(body.plots);
      expect(sampled.length).toBe(new Set(body.samples.plot).size);
      expect(sampled.every(([, , params]) => params.tag.length > 1900)).toBe(true);
    });

    it('returns every visible wide point once across continuations', async () => {
      const values = Object.fromEntries(
        Array.from({length: 64}, (_, i) => ['s' + i, {name: 'Series ' + i, unit: 'ns'}]),
      );
      const data = Array.from({length: 130}, (_, i) => ({
        group: 'g',
        benchmark: 'b',
        x: i + 0.5,
        non_scaling_params: {},
        values: {s0: i},
        statuses: Object.fromEntries(
          Array.from({length: 63}, (_, k) => [
            's' + (k + 1),
            {state: 'failed', reason: String(i).padEnd(1000, 'r')},
          ]),
        ),
      }));
      const report = runReport(
        {g: {name: 'G'}},
        {b: {scaling_param: 'x', params: {x: {unit: ''}}, values}},
        data,
      );
      const manifest = await seed('wide-points', report);
      const seen = [];
      let after = null,
        chunks = 0;
      do {
        const {body, bytes} = await api(
          `/wide-points/plots?format=3&rid=${manifest.id}&group=g&benchmark=b` +
            (after ? '&after=' + after : ''),
        );
        expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
        chunks++;
        for (const plot of body.plots) seen.push(...plot.rows);
        after = body.next;
      } while (after);
      expect(chunks).toBeGreaterThanOrEqual(3);
      expect(seen.map((point) => point.x)).toEqual(data.map((point) => point.x));
      expect(seen[70].statuses.s5.reason).toBe(data[70].statuses.s5.reason);
    });

    it('caches a one-group Overview under its group scope', async () => {
      const data = [1, 2, 4].map((x) => ({
        group: 'only', benchmark: 'b', x, non_scaling_params: {}, values: {hw: x, sim: x * 1.1},
      }));
      const report = runReport(
        {only: {name: 'Only'}},
        {b: {scaling_param: 'x', params: {x: {unit: ''}}, values: timing}},
        data,
      );
      const manifest = await seed('one-group', report, false);
      const store = memoryStore();
      let connects = 0;
      const counting = {connect: () => (connects++, pool.connect())};
      const path = `/one-group/summary?rid=${manifest.id}&scope=overview`;
      const first = await api(path, {store, pool: counting});
      expect(first.body.scope).toBe('group:' + manifest.group_ids.only);
      expect(connects).toBe(2);
      const second = await api(path, {store, pool: counting});
      expect(connects).toBe(3); // the state query only
      expect(second.body.computed_at).toBe(first.body.computed_at);
      expect([...store.entries.keys()]).toEqual([`v1/summary${SUMMARY_FORMAT}/${manifest.id}/${first.body.scope}`]);
    });

    it('re-resolves a one-group Overview that gains a group before its snapshot', async () => {
      const data = [1, 2].map((x) => ({
        group: 'first', benchmark: 'b', x, non_scaling_params: {}, values: {hw: x, sim: x * 1.2},
      }));
      const report = runReport(
        {first: {name: 'First'}},
        {b: {scaling_param: 'x', params: {x: {unit: ''}}, values: timing}},
        data,
      );
      const manifest = await seed('gains-group', report, false);
      const store = memoryStore();
      let connects = 0;
      const racing = {
        async connect() {
          // Between the state query and the summary snapshot.
          if (++connects === 2)
            await open('gains-group', {...report.report, groups: {second: {name: 'Second'}}}, report.benchmarks, report.progress);
          return pool.connect();
        },
      };
      const {status, body} = await api(
        `/gains-group/summary?rid=${manifest.id}&scope=overview`,
        {store, pool: racing},
      );
      expect(status).toBe(200);
      expect(body.scope).toBe('overview');
      expect(body.groups.map(([, key]) => key)).toEqual(['first', 'second']);
      expect([...store.entries.keys()]).toEqual([`v1/summary${SUMMARY_FORMAT}/${manifest.id}/overview`]);
    });

    it('pages launch-group charts with every dispatch row', async () => {
      const sizes = Array.from({length: 36}, (_, i) => 16 * (i + 1));
      const fdtd = fdtdReport(
        {sizes, unavailable: (size, launch) => (launch % 11 === 0 ? {state: 'timeout'} : null)},
        [200, 100],
      );
      const report = {...fdtd, progress: {total: fdtd.data.length, completed: 0, running: 0}};
      const manifest = await seed('fdtd', report);
      const index = indexReport(report.data, report.benchmarks);
      const fileSeries = index.groups.get('gpu').benchmarks[0].series;
      expect(fileSeries).toHaveLength(12);
      expect(manifest.plots.gpu).toEqual([[0, 12]]);
      const byLaunchThenX = (a, b) =>
        a.non_scaling_params.launch - b.non_scaling_params.launch || a.x - b.x;
      for (const offset of [0, 6]) {
        const charts = new Map();
        const seen = new Set();
        let after = null,
          chunks = 0;
        do {
          const {body, bytes} = await api(
            `/fdtd/plots?format=3&rid=${manifest.id}&group=gpu&benchmark=polybench_fdtd2d` +
              `&offset=${offset}&limit=6` +
              (after ? '&after=' + after : ''),
          );
          expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
          expect(body.total).toBe(12);
          chunks++;
          for (const plot of body.plots) {
            if (!charts.has(plot.chart)) charts.set(plot.chart, {params: new Set(), rows: []});
            const chart = charts.get(plot.chart);
            chart.params.add(JSON.stringify(chartParams(plot.non_scaling_params)));
            for (const row of plot.rows) {
              const key = plot.id + ':' + row.x;
              expect(seen.has(key)).toBe(false);
              seen.add(key);
              expect(row.non_scaling_params).toEqual(plot.non_scaling_params);
              chart.rows.push(row);
            }
          }
          after = body.next;
        } while (after);
        if (offset === 0) expect(chunks).toBeGreaterThanOrEqual(2);
        const ordered = [...charts].sort(([a], [b]) => a - b).map(([, chart]) => chart);
        expect(ordered).toHaveLength(6);
        ordered.forEach((chart, i) => {
          expect(chart.params.size).toBe(1);
          const expected = fileSeries[offset + i];
          expect(chart.rows.sort(byLaunchThenX)).toEqual([...expected.rows].sort(byLaunchThenX));
        });
      }
      // Single points stay addressable by their dispatch plot.
      const {body: page} = await api(
        `/fdtd/plots?format=3&rid=${manifest.id}&group=gpu&benchmark=polybench_fdtd2d&limit=1`,
      );
      const [plot] = page.plots;
      const {body: single} = await api(`/fdtd/points/${plot.id}/${plot.rows[0].x}?rid=${manifest.id}`);
      expect(single.point).toEqual(plot.rows[0]);
      // The CSV keeps one row per dispatch; progress counts charts.
      const progress = [];
      const csv = await runCsv(
        manifest,
        async (query) => (await api(`/fdtd/plots?${query}`)).body,
        {onProgress: (p) => progress.push(p)},
      );
      expect(csv.rows).toBe(report.data.length);
      expect(csv.chunks.join('').split('\r\n').length - 2).toBe(report.data.length);
      expect(progress.at(-1)).toEqual({plots: 12, of: 12});
      // Raw-pair statistics do not depend on charts.
      const {body: summary} = await api(`/fdtd/summary?rid=${manifest.id}&scope=overview`);
      expect(summary.count).toBe(index.pairs.length);
      expect(summary.stats).toEqual(errorStats(index.pairs));
    }, 60_000);

    it('pages launch-ordinal charts, each plot split by x, like the file viewer', async () => {
      const sizes = Array.from({length: 32}, (_, i) => 16 * (200 + i));
      // A chart whose points are all queued is not drawn, nor counted.
      const queued = (point) =>
        point.non_scaling_params.penalty === 10 && point.x === sizes[3]
          ? {...point, values: {hw: null, sim: null}, statuses: {sim: {state: 'queued'}}}
          : point;
      const data = [
        ...nwPoints({sizes, penalties: [1, 10]}).map(queued),
        ...sradPoints({iterations: [1, 2]}),
        ...gaussianPoints(),
      ];
      const report = {
        ...launchOrdinalReport(data),
        progress: {total: data.length, completed: 0, running: 0},
      };
      const manifest = await seed('ordinal', report);
      const index = indexReport(report.data, report.benchmarks);
      const fileBenchmarks = index.groups.get('gpu').benchmarks;
      const fileSeries = fileBenchmarks[0].series;
      expect(fileSeries).toHaveLength(63);
      expect(manifest.plots.gpu).toEqual(
        fileBenchmarks.map((b) => [manifest.benchmark_keys.indexOf(b.id), b.series.length]),
      );
      expect(manifest.plots.gpu.map(([, count]) => count)).toEqual([63, 6, 2]);
      const ordinalOf = (row) => Number(row.non_scaling_params.launch.split(' ')[0].slice(1));
      const byOrdinal = (a, b) => ordinalOf(a) - ordinalOf(b);
      const pages = new Map();
      for (const offset of [0, 48]) {
        const charts = new Map();
        const entries = new Set();
        let after = null,
          chunks = 0;
        do {
          const {body, bytes} = await api(
            `/ordinal/plots?format=3&rid=${manifest.id}&group=gpu&benchmark=rodinia_nw` +
              `&offset=${offset}&limit=48` +
              (after ? '&after=' + after : ''),
          );
          expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
          expect(body.total).toBe(63);
          expect(body.launch_ordinal).toBe(true);
          chunks++;
          for (const plot of body.plots) {
            // One entry per plot and chart, with only that chart's rows.
            const entry = plot.id + ':' + plot.chart;
            expect(entries.has(entry)).toBe(false);
            entries.add(entry);
            expect(new Set(plot.rows.map((row) => row.x)).size).toBe(1);
            if (!charts.has(plot.chart)) charts.set(plot.chart, []);
            for (const row of plot.rows) {
              expect(row.non_scaling_params).toEqual(plot.non_scaling_params);
              charts.get(plot.chart).push({plot: plot.id, row});
            }
          }
          after = body.next;
        } while (after);
        // Over 20,000 rows: the cursor continues inside a plot's charts.
        if (offset === 0) expect(chunks).toBeGreaterThanOrEqual(2);
        const ordered = [...charts].sort(([a], [b]) => a - b).map(([, chart]) => chart);
        expect(ordered).toHaveLength(offset === 0 ? 48 : 15);
        ordered.forEach((chart, i) => {
          const rows = chart.map(({row}) => row);
          expect(rows.sort(byOrdinal)).toEqual([...fileSeries[offset + i].rows].sort(byOrdinal));
        });
        pages.set(offset, ordered);
      }
      // The first launch's plot spans charts on both pages.
      const plotsOf = (offset) => new Set(pages.get(offset).flat().map(({plot}) => plot));
      const shared = [...plotsOf(0)].filter((plot) => plotsOf(48).has(plot));
      expect(shared.length).toBeGreaterThan(0);
      // Point details stay raw.
      const [{plot, row}] = pages.get(48)[0];
      const {body: single} = await api(`/ordinal/points/${plot}/${row.x}?rid=${manifest.id}`);
      expect(single.point).toEqual(row);
      // A fixed launch count keeps one chart per plot, as before.
      const {body: srad} = await api(
        `/ordinal/plots?format=3&rid=${manifest.id}&group=gpu&benchmark=rodinia_srad`,
      );
      expect('launch_ordinal' in srad).toBe(false);
      expect(srad.plots.map((p) => p.chart)).toEqual(srad.plots.map((p) => p.id));
      expect(srad.plots.map((p) => p.rows.length)).toEqual([3, 3, 3, 3, 3, 3]);
      const {body: gaussian} = await api(
        `/ordinal/plots?format=3&rid=${manifest.id}&group=gpu&benchmark=rodinia_gaussian`,
      );
      expect(gaussian.launch_ordinal).toBe(true);
      expect(new Set(gaussian.plots.map((p) => p.chart)).size).toBe(2);
      // The CSV keeps one row per point, in plot and x order as before.
      const csv = await runCsv(manifest, async (query) => (await api(`/ordinal/plots?${query}`)).body);
      const visible = index.groups.get('gpu').benchmarks.flatMap((b) => b.series.flatMap((s) => s.rows));
      expect(csv.rows).toBe(visible.length);
      const lines = csv.chunks.join('').split('\r\n').slice(1, -1);
      const nwLines = lines.filter((line) => line.startsWith('rodinia_nw,'));
      // Plot ids as the pages named them.
      const paged = [...pages.values()].flat(2);
      const expected = paged
        .sort((a, b) => a.plot - b.plot || a.row.x - b.row.x)
        .map(({row}) => row.x + ',' + row.non_scaling_params.penalty + ',' + row.non_scaling_params.launch);
      expect(expected).toHaveLength(fileSeries.reduce((n, series) => n + series.rows.length, 0));
      const columns = csv.chunks[0].split('\r\n')[0].split(',');
      const at = (name) => columns.indexOf(name);
      expect(
        nwLines.map((line) => {
          const cells = line.split(',');
          return [cells[3], cells[at('penalty')], cells[at('launch')]].join(',');
        }),
      ).toEqual(expected);
    }, 60_000);

    it('keeps producer-chosen keys and first-appearance order', async () => {
      const point = (group, x) => ({
        group, benchmark: 'constructor', x, non_scaling_params: {}, values: {hw: x, sim: x * 2},
      });
      const data = [point('10', 1), point('2', 1), point('constructor', 1), point('10', 2)];
      const report = runReport(
        {constructor: {name: 'Builder'}, 2: {name: 'Two'}, 10: {name: 'Ten'}},
        {constructor: {scaling_param: 'x', params: {x: {unit: ''}}, values: timing}},
        data,
      );
      const manifest = await seed('keys', report);
      expect(manifest.group_order).toEqual(['10', '2', 'constructor']);
      expect(manifest.report.groups.constructor).toEqual({name: 'Builder'});
      expect(manifest.plots.constructor).toEqual([[0, 1]]);
      expect(Object.keys(manifest.benchmarks.constructor.values)).toEqual(['hw', 'sim']);
      const summary = await api(`/keys/summary?rid=${manifest.id}&scope=overview`);
      expect(summary.status).toBe(200);
      expect(summary.body.count).toBe(4);
      const group = await api(
        `/keys/summary?rid=${manifest.id}&scope=group:${manifest.group_ids.constructor}`,
      );
      expect(group.body.benchmark_stats[0][1]).toBe(1);
    });
  });
});

