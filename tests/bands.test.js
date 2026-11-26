import {expect, test} from 'vitest';
import {bandLabels, timeBands} from '../site/drawing.js';
import {buildSummary, summaryCharts} from '../site/model.js';

const timed = (n, unit = 'ns', offset = 0) =>
  Array.from({length: n}, (_, i) => ({actual: offset + i + 1, prediction: i + 1, unit}));

test('bands split by percentile cutoffs of hardware time', () => {
  const bands = timeBands(timed(100));
  expect(bands.unit).toBe('ns');
  expect(bands.cutoffs.map((c) => +c.toFixed(2))).toEqual([2.98, 25.75, 50.5, 75.25, 98.02]);
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

test('both tail bands hold a comparison at the minimum', () => {
  const counts = timeBands(timed(30)).bands.map((band) => band.length);
  expect(counts[0]).toBe(1);
  expect(counts[5]).toBe(1);
  expect(counts.reduce((a, b) => a + b)).toBe(30);
});

test('labels gain digits until distinct cutoffs differ', () => {
  const labels = bandLabels({unit: 'ns', cutoffs: [1000, 1001, 1002, 2000, 3000]});
  expect(labels).toEqual(['< 1µs', '1µs–1.001µs', '1.001µs–1.002µs', '1.002µs–2µs', '2µs–3µs', '≥ 3µs']);
  expect(new Set(labels).size).toBe(6);
});

test('labels fall back to exact values when nine digits are not enough', () => {
  const cutoffs = [1000, 1000.0000000001, 1000.0000000002, 2000, 3000];
  const labels = bandLabels({unit: 'ns', cutoffs});
  expect(new Set(labels).size).toBe(6);
  expect(labels[1]).toBe('1000 ns–1000.0000000001 ns');
});
