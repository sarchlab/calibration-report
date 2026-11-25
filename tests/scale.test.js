import {expect, test} from 'vitest';
import {comparisonPairs, errorStats, indexReport, rankStatistics, valueBounds} from '../site/model.js';

// Deliberately quadratic reference, independent of the production Fenwick tree.
function quadraticRanks(pairs) {
  let concordant = 0, discordant = 0, measuredUnequal = 0, simulatedUnequal = 0;
  for (let i = 0; i < pairs.length; i++) {
    for (let j = 0; j < i; j++) {
      const x = Math.sign(pairs[i].actual - pairs[j].actual);
      const y = Math.sign(pairs[i].prediction - pairs[j].prediction);
      if (x) measuredUnequal++;
      if (y) simulatedUnequal++;
      if (x && y) {
        if (x === y) concordant++;
        else discordant++;
      }
    }
  }
  const rank = (value, key) => 1 + pairs.filter((p) => p[key] < value).length +
    (pairs.filter((p) => p[key] === value).length - 1) / 2;
  const mean = (pairs.length + 1) / 2;
  let covariance = 0, xVariance = 0, yVariance = 0;
  for (const pair of pairs) {
    const x = rank(pair.actual, 'actual') - mean;
    const y = rank(pair.prediction, 'prediction') - mean;
    covariance += x * y;
    xVariance += x * x;
    yVariance += y * y;
  }
  const tauDenominator = Math.sqrt(measuredUnequal * simulatedUnequal);
  const rhoDenominator = Math.sqrt(xVariance * yVariance);
  return {
    tau: tauDenominator ? (concordant - discordant) / tauDenominator : null,
    concordant,
    measuredUnequal,
    rho: rhoDenominator ? covariance / rhoDenominator : null,
  };
}

test('exact ranks match the old definition for empty, constant, tied and randomized inputs', () => {
  const cases = [[], [[1, 1]], [[1, 1], [1, 1]], [[1, 1], [1, 2]],
    [[1, 2], [2, 2]], [[1, 3], [1, 1], [2, 2], [3, 1], [3, 1]]];
  let seed = 73;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let i = 0; i < 200; i++)
    cases.push(Array.from({length: random() % 60}, () => [1 + random() % 11, 1 + random() % 13]));
  for (const values of cases) {
    const pairs = values.map(([actual, prediction]) => ({actual, prediction}));
    expect(rankStatistics(pairs)).toEqual(quadraticRanks(pairs));
  }
});

test('455,291 pairs use exact safe counts and bounds without argument spreads', () => {
  const count = 455291;
  const pairs = Array.from({length: count}, (_, i) => ({
    actual: i + 1, prediction: count - i, signedError: i % 2 ? -2 : 2,
  }));
  const statistics = rankStatistics(pairs);
  expect(statistics.tau).toBe(-1);
  expect(statistics.rho).toBe(-1);
  expect(statistics.concordant).toBe(0);
  expect(statistics.measuredUnequal).toBe(103644719695);
  expect(errorStats(pairs)).toEqual([['Average error', '2.00%'], ['Max error', '2.00%']]);
  expect(valueBounds(pairs.map((pair) => pair.actual))).toEqual({min: 1, max: count});
});

test('report indexes preserve all eligible pairs, parameter groups and status-only rows', () => {
  const meta = {
    scaling_param: 'x', params: {x: {unit: ''}, launch: {unit: ''}, blocks: {unit: ''}},
    values: {
      hw: {name: 'Measured', unit: 'ns', role: 'hardware_measurement'},
      sim: {name: 'Simulated', unit: 'ns', role: 'simulator_output'},
    },
  };
  const point = (group, x, params, values, statuses) => ({group, benchmark: 'b', x, non_scaling_params: params, values, statuses});
  const data = [
    point('a', 1, {launch: 'one', blocks: 1}, {hw: 2, sim: 3}),
    point('a', 2, {blocks: 1, launch: 'one'}, {hw: 4, sim: 3}),
    point('a', 3, {launch: 'two', blocks: 1}, {hw: null, sim: null}, {sim: {state: 'failed'}}),
    point('b', 1, {launch: 'one', blocks: 1}, {hw: 5, sim: 6}),
    point('b', 2, {launch: 'one', blocks: 1}, {hw: 0, sim: 6}),
    point('b', 3, {launch: 'two', blocks: 1}, {hw: null, sim: null}, {sim: {state: 'queued'}}),
  ];
  const index = indexReport(data, {b: meta});
  expect(index.pairs).toEqual(comparisonPairs(data, {b: meta}));
  expect(index.pairs).toHaveLength(3);
  expect(index.groups.get('a').benchmarks[0].series).toHaveLength(2);
  expect(index.groups.get('a').benchmarks[0].series[0].rows).toEqual(data.slice(0, 2));
  expect(index.groups.get('a').benchmarks[0].series[0].pairs).toHaveLength(2);
  expect(index.groups.get('a').benchmarks[0].series[1].rows).toEqual([data[2]]);
  expect(index.groups.get('b').benchmarks[0].series).toHaveLength(1);
  const ambiguous = {...meta, values: {...meta.values, hw2: {...meta.values.hw}}};
  expect(comparisonPairs(data, {b: ambiguous})).toEqual([]);
});
