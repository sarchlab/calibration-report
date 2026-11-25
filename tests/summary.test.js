import {expect, test} from 'vitest';
import {buildSummary} from '../site/model.js';

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
const rows = Array.from({length: 10}, (_, i) => ({
  group: 'g',
  benchmark: 'b',
  plot: 1,
  x: i + 1,
  values: {hw: 100 + i * 10, sim: 100 + i * 10 + ((i * 7) % 5) * 4},
}));
const sample = buildSummary({rows, benchmarks, groups: [[1, 'g', 'G']], overview: false});

test('samples never exceed the requested limits', () => {
  for (let limit = 0; limit <= 4; limit++) {
    const summary = sample({scurve: limit, cdf: limit, scatter: limit});
    expect(summary.count).toBe(10);
    expect(summary.scatter.ns.count).toBe(10);
    expect(summary.scatter.ns.sample).toHaveLength(limit);
    expect(summary.scurve.sample.length).toBeLessThanOrEqual(limit);
    expect(summary.cdf.sample.length).toBeLessThanOrEqual(limit);
    // Deterministic: the same limit gives the same sample.
    expect(sample({scurve: limit, cdf: limit, scatter: limit})).toEqual(summary);
  }
  // With room for them, the measured extrema are kept.
  const {scatter, samples} = sample({scurve: 0, cdf: 0, scatter: 3});
  const actual = scatter.ns.sample.map((i) => samples.actual[i]);
  expect(actual).toContain(100);
  expect(actual).toContain(190);
});
