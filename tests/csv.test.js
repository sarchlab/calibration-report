// @vitest-environment node
import {describe, expect, it} from 'vitest';
import {csvColumns, csvField, csvRows, runCsv} from '../site/csv.js';

const manifest = {
  id: 7,
  revision: 3,
  benchmark_keys: ['gemm', 'fft'],
  param_keys: [['size', 'launch', '10'], ['n', 'launch', 'radix']],
  benchmarks: {
    gemm: {
      scaling_param: 'size',
      values: {hw: {name: 'HW', unit: 'ns'}, sim: {name: 'Sim', unit: 'ns'}},
    },
    fft: {
      scaling_param: 'n',
      values: {hw: {name: 'HW', unit: 'ns'}, simfft: {name: 'Sim', unit: 'ns'}},
    },
  },
  group_order: ['a', 'b'],
  plots: {a: [[0, 2], [1, 1]], b: [[0, 1]]},
};

describe('csvField', () => {
  it('quotes only fields that need it, per RFC 4180', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('two\nlines')).toBe('"two\nlines"');
    expect(csvField('cr\r')).toBe('"cr\r"');
    expect(csvField('ünï')).toBe('ünï');
  });
  it('prints numbers as JavaScript does and empties missing values', () => {
    expect(csvField(1e21)).toBe('1e+21');
    expect(csvField(0.1 + 0.2)).toBe('0.30000000000000004');
    expect(csvField(-3)).toBe('-3');
    expect(csvField(false)).toBe('false');
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });
});

describe('csvColumns', () => {
  it('unions parameters and series over benchmarks without scaling parameters', () => {
    const columns = csvColumns(manifest);
    expect(columns.params).toEqual(['launch', '10', 'radix']);
    expect(columns.series).toEqual(['hw', 'sim', 'simfft']);
    expect(columns.header).toBe(
      'benchmark,group,scaling_param,x,launch,10,radix,' +
        'hw,hw_state,hw_reason,sim,sim_state,sim_reason,simfft,simfft_state,simfft_reason\r\n',
    );
  });
});

describe('csvRows', () => {
  it('writes one row per point with empty cells for missing values', () => {
    const columns = csvColumns(manifest);
    const text = csvRows(columns, manifest, [
      {
        group: 'a',
        benchmark: 'gemm',
        x: 64,
        non_scaling_params: {launch: 'k,1', 10: true},
        values: {hw: 1.5, sim: null},
        statuses: {sim: {state: 'timeout', reason: 'took "too" long'}},
      },
      {
        group: 'a',
        benchmark: 'fft',
        x: 8,
        non_scaling_params: {launch: 2, radix: 4},
        values: {simfft: 7},
      },
      {
        group: 'b',
        benchmark: 'fft',
        x: 16,
        non_scaling_params: {launch: 2, radix: 4},
        values: {hw: 3},
        statuses: {simfft: {state: 'queued'}},
      },
    ]);
    expect(text).toBe(
      'gemm,a,size,64,"k,1",true,,1.5,,,,timeout,"took ""too"" long",,,\r\n' +
        'fft,a,n,8,2,,4,,,,,,,7,,\r\n' +
        'fft,b,n,16,2,,4,3,,,,,,,queued,\r\n',
    );
  });
});

describe('runCsv', () => {
  const point = (group, benchmark, plot, x) => ({
    group,
    benchmark,
    x,
    non_scaling_params: benchmark === 'gemm' ? {launch: plot, 10: 0} : {launch: plot, radix: 2},
    values: {hw: plot * 100 + x},
  });

  it('pages every plot and continuation in manifest order', async () => {
    const queries = [];
    const fetchPage = async (query) => {
      const q = new URLSearchParams(query);
      queries.push(query);
      const {group, benchmark} = Object.fromEntries(q);
      expect(q.get('rid')).toBe('7');
      expect(q.get('format')).toBe('2');
      if (group === 'a' && benchmark === 'gemm') {
        // Plot 1 continues in a second chunk.
        if (!q.get('after'))
          return {
            revision: 3,
            total: 2,
            plots: [
              {id: 1, chart: 1, rows: [point(group, benchmark, 1, 1)]},
            ],
            next: '1:1',
          };
        return {
          revision: 3,
          total: 2,
          plots: [
            {id: 1, chart: 1, rows: [point(group, benchmark, 1, 2)]},
            {id: 2, chart: 2, rows: [point(group, benchmark, 2, 1)]},
          ],
          next: null,
        };
      }
      const id = group === 'a' ? 3 : 4;
      return {revision: 3, total: 1, plots: [{id, chart: id, rows: [point(group, benchmark, id, 1)]}], next: null};
    };
    const progress = [];
    const {chunks, rows, revisions} = await runCsv(manifest, fetchPage, {
      onProgress: (p) => progress.push(p),
    });
    const lines = chunks.join('').split('\r\n');
    expect(lines.slice(1, -1).map((line) => line.split(',').slice(0, 4).join(','))).toEqual([
      'gemm,a,size,1',
      'gemm,a,size,2',
      'gemm,a,size,1',
      'fft,a,n,1',
      'gemm,b,size,1',
    ]);
    expect(rows).toBe(5);
    expect(revisions).toEqual([3, 3]);
    expect(queries).toHaveLength(4);
    expect(progress.at(-1)).toEqual({plots: 4, of: 4});
  });

  it('follows a growing plot count, skips repeated plots, and reports mixed revisions', async () => {
    const one = {...manifest, group_order: ['a'], plots: {a: [[0, 48]]}};
    const fetchPage = async (query) => {
      const offset = Number(new URLSearchParams(query).get('offset'));
      if (offset === 0)
        return {
          revision: 3,
          total: 49,
          plots: Array.from({length: 48}, (_, i) => ({id: i + 1, chart: i + 1, rows: [point('a', 'gemm', i + 1, 1)]})),
          next: null,
        };
      // A plot became visible before the window: plot 48 shifts into it.
      return {
        revision: 4,
        total: 50,
        plots: [48, 49, 50].map((id) => ({id, chart: id, rows: [point('a', 'gemm', id, 1)]})),
        next: null,
      };
    };
    const {rows, revisions} = await runCsv(one, fetchPage);
    expect(rows).toBe(50);
    expect(revisions).toEqual([3, 4]);
  });

  it('exports every dispatch of a launch-group chart and counts the chart once', async () => {
    const one = {...manifest, group_order: ['a'], plots: {a: [[0, 1]]}};
    const progress = [];
    const {rows} = await runCsv(
      one,
      async () => ({
        revision: 3,
        total: 1,
        plots: [7, 8, 9].map((id) => ({id, chart: 7, rows: [point('a', 'gemm', id, 1), point('a', 'gemm', id, 2)]})),
        next: null,
      }),
      {onProgress: (p) => progress.push(p)},
    );
    expect(rows).toBe(6);
    expect(progress).toEqual([{plots: 1, of: 1}]);
  });

  it('exports only the header for a run without visible plots', async () => {
    const empty = {...manifest, group_order: [], plots: {}};
    const result = await runCsv(empty, async () => {
      throw new Error('no requests expected');
    });
    expect(result.chunks.join('')).toBe(csvColumns(manifest).header);
    expect(result.revisions).toEqual([3, 3]);
  });

  it('includes the manifest revision in the range', async () => {
    const one = {...manifest, revision: 2, group_order: ['b'], plots: {b: [[0, 1]]}};
    const {revisions} = await runCsv(one, async () => ({
      revision: 3,
      total: 1,
      plots: [{id: 4, chart: 4, rows: [point('b', 'gemm', 4, 1)]}],
      next: null,
    }));
    expect(revisions).toEqual([2, 3]);
  });

  it('aborts the sibling workers on the first failure and reports no more progress', async () => {
    const two = {...manifest, group_order: ['a'], plots: {a: [[0, 1], [1, 1]]}};
    let siblingSignal;
    const requests = [];
    const fetchPage = (query, signal) => {
      const benchmark = new URLSearchParams(query).get('benchmark');
      requests.push(benchmark);
      if (benchmark === 'gemm')
        return new Promise((_, reject) => setTimeout(() => reject(new Error('Server busy')), 5));
      // Delayed until aborted.
      siblingSignal = signal;
      return new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => {
          // A late answer after the abort must not count.
          resolve({revision: 3, total: 1, plots: [{id: 9, chart: 9, rows: []}], next: null});
          reject(signal.reason);
        }),
      );
    };
    const progress = [];
    await expect(
      runCsv(two, fetchPage, {onProgress: (p) => progress.push(p)}),
    ).rejects.toThrow('Server busy');
    expect(siblingSignal.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(progress).toEqual([]);
    expect(requests).toEqual(['gemm', 'fft']);
  });
});

describe('shifting windows', () => {
  it('exports every row once when a split plot moves into the next window', async () => {
    const one = {...manifest, group_order: ['a'], plots: {a: [[0, 48]]}};
    // Plots 2..49 hold rows x = 1, 2. The first chunk ends inside plot 49;
    // then plot 1 becomes visible, so plot 49 moves into the second window.
    const rowsOf = (id) =>
      [1, 2].map((x) => ({
        group: 'a', benchmark: 'gemm', x, non_scaling_params: {launch: id}, values: {hw: x},
      }));
    let shifted = false;
    const fetchPage = async (query) => {
      const q = new URLSearchParams(query);
      const offset = Number(q.get('offset'));
      if (offset === 0 && !q.get('after')) {
        const plots = Array.from({length: 48}, (_, i) => ({id: i + 2, chart: i + 2, rows: rowsOf(i + 2)}));
        plots[47] = {id: 49, chart: 49, rows: rowsOf(49).slice(0, 1)};
        return {revision: 3, total: 48, plots, next: '49:1'};
      }
      shifted = true;
      if (offset === 0) // the continuation: plot 49 left the window
        return {revision: 4, total: 49, plots: [], next: null};
      return {revision: 4, total: 49, plots: [{id: 49, chart: 49, rows: rowsOf(49)}], next: null};
    };
    const {chunks, rows} = await runCsv(one, fetchPage);
    expect(shifted).toBe(true);
    const lines = chunks.join('').split('\r\n').slice(1, -1);
    const keys = lines.map((line) => line.split(',').slice(3, 5).join(':'));
    expect(rows).toBe(96);
    expect(new Set(keys).size).toBe(96);
    expect(keys.filter((k) => k.endsWith(':49'))).toEqual(['1:49', '2:49']);
  });
});

describe('spreadsheet safety and header collisions', () => {
  it('prefixes text that a spreadsheet would run as a formula, never numbers', () => {
    expect(['=1+1', '+a', '-a', '@x', '\tt', '\rr', 'a=b'].map(csvField)).toEqual([
      "'=1+1", "'+a", "'-a", "'@x", "'\tt", '"\'\rr"', 'a=b',
    ]);
    expect(csvField(-5)).toBe('-5');
    expect(csvField('-5')).toBe("'-5");
    expect(csvField('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
  });

  it('suffixes header names that an earlier column already uses', () => {
    const colliding = {
      benchmark_keys: ['b'],
      param_keys: [['n', 'x', '=p']],
      benchmarks: {
        b: {
          scaling_param: 'n',
          values: {sim: {name: 'S', unit: ''}, sim_state: {name: 'T', unit: ''}},
        },
      },
    };
    const columns = csvColumns(colliding);
    expect(columns.names).toEqual([
      'benchmark', 'group', 'scaling_param', 'x', 'x_2', "'=p",
      'sim', 'sim_state', 'sim_reason', 'sim_state_2', 'sim_state_state', 'sim_state_reason',
    ]);
    expect(columns.header).toBe(
      "benchmark,group,scaling_param,x,x_2,'=p,sim,sim_state,sim_reason," +
        'sim_state_2,sim_state_state,sim_state_reason\r\n',
    );
  });

  it('compares header names after formula protection, in either order', () => {
    const names = (params) =>
      csvColumns({
        benchmark_keys: ['b'],
        param_keys: [['n', ...params]],
        benchmarks: {b: {scaling_param: 'n', values: {v: {name: 'V', unit: ''}}}},
      }).names.slice(4, 6);
    expect(names(['=p', "'=p"])).toEqual(["'=p", "'=p_2"]);
    expect(names(["'=p", '=p'])).toEqual(["'=p", "'=p_2"]);
    expect(names(['=a,b', "'=a,b"])).toEqual(["'=a,b", "'=a,b_2"]);
    expect(
      csvColumns({
        benchmark_keys: ['b'],
        param_keys: [['n', '=a,b', "'=a,b"]],
        benchmarks: {b: {scaling_param: 'n', values: {v: {name: 'V', unit: ''}}}},
      }).header,
    ).toBe(`benchmark,group,scaling_param,x,"'=a,b","'=a,b_2",v,v_state,v_reason\r\n`);
  });
});
