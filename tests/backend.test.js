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
import {
  comparisonPairs,
  errorPercentiles,
  errorStats,
  indexReport,
  rankingStats,
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
        `/synthetic/plots?rid=${rid}&group=a&benchmark=gemm&offset=1&limit=2`,
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
        `/synthetic/plots?rid=${rid}&group=a&benchmark=gemm&offset=1&limit=2&after=${first.id}:${first.rows[0].x}`,
      );
      expect(rest.body.plots[0].rows).toEqual(first.rows.slice(1));
    });

    it('returns single points and rejects replaced run ids', async () => {
      const {body: page} = await api(`/synthetic/plots?rid=${manifest.id}&group=b&benchmark=gemm`);
      const plot = page.plots[0];
      const {body} = await api(`/synthetic/points/${plot.id}/${plot.rows[0].x}?rid=${manifest.id}`);
      expect(body.point).toEqual(plot.rows[0]);
      expect((await api(`/synthetic/plots?rid=999999&group=a&benchmark=gemm`)).status).toBe(409);
      expect((await api(`/unknown`)).status).toBe(404);
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

    it('rejects malformed paths', async () => {
      const response = await handleApi(new Request('http://localhost/api/v1/runs/%E0%A4%A'), {pool, store});
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('Invalid path');
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
      const page = await api(`/live/plots?rid=${manifest.id}&group=a&benchmark=fft&limit=48`);
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
          `/wide-points/plots?rid=${manifest.id}&group=g&benchmark=b` +
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
      expect([...store.entries.keys()]).toEqual([`v1/${manifest.id}/${first.body.scope}`]);
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
      expect([...store.entries.keys()]).toEqual([`v1/${manifest.id}/overview`]);
    });

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

