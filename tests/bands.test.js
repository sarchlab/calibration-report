import {expect, test} from 'vitest';
import {timeBands} from '../site/drawing.js';
import {buildSummary, summaryCharts} from '../site/model.js';

const timed = (n, unit = 'ns', offset = 0) =>
  Array.from({length: n}, (_, i) => ({actual: offset + i + 1, prediction: i + 1, unit}));

test('bands split by percentile cutoffs of hardware time', () => {
  const bands = timeBands(timed(100));
  expect(bands.unit).toBe('ns');
  expect(bands.cutoffs).toEqual([3, 26, 51, 76, 99]);
  expect(bands.bands.map((band) => band.length)).toEqual([2, 23, 25, 25, 23, 2]);
});

test('bands ignore non-time units, even when they are the majority', () => {
  expect(timeBands(timed(40, 'cells'))).toBeNull();
  expect(timeBands(timed(40, ''))).toBeNull();
  const mixed = [...timed(40, 'cells'), ...timed(35, 'ns')];
  const bands = timeBands(mixed);
  expect(bands.unit).toBe('ns');
  expect(bands.bands.flat()).toHaveLength(35);
});

test('bands need enough timed comparisons', () => {
  expect(timeBands(timed(29))).toBeNull();
});

test('hosted band population counts each sampled comparison once', () => {
  const benchmarks = {
    b: {
      scaling_param: 'x',
      params: {x: {unit: ''}},
      values: {
        hw: {name: 'Measured', unit: 'ns', role: 'hardware_measurement'},
        sim: {name: 'Simulated', unit: 'ns', role: 'simulator_output'},
      },
    },
  };
  const rows = Array.from({length: 15}, (_, i) => ({
    group: 'g',
    benchmark: 'b',
    plot: 1,
    x: i + 1,
    values: {hw: 100 + i, sim: 110 + i},
  }));
  const summary = buildSummary({rows, benchmarks, groups: [[1, 'g', 'G']], overview: false})({
    scurve: 100,
    cdf: 100,
    scatter: 100,
  });
  const charts = summaryCharts(summary);
  expect(charts.scurve).toHaveLength(15);
  expect(charts.cdf.pairs).toHaveLength(15);
  expect(charts.sampled).toHaveLength(15);
  // 15 distinct comparisons stay below the minimum even though both curves hold them.
  expect(timeBands(charts.scurve, charts.sampled)).toBeNull();
});
