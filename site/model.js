export function comparisonPairs(rows, benchmarks) {
  const pairs = [];
  const comparisons = new Map();
  for (const point of rows) {
    if (!comparisons.has(point.benchmark)) {
      const series = Object.entries(benchmarks[point.benchmark].values);
      const hardware = series.filter(
        ([, value]) => value.role === 'hardware_measurement',
      );
      const matches = [];
      for (const [id, simulated] of series) {
        if (simulated.role !== 'simulator_output') continue;
        const references = hardware.filter(
          ([, value]) => value.unit === simulated.unit,
        );
        if (references.length !== 1) continue;
        const [reference, measured] = references[0];
        matches.push({
          reference,
          id,
          unit: simulated.unit,
          pairId: JSON.stringify([reference, id]),
          name: simulated.name + ' vs. ' + measured.name,
        });
      }
      comparisons.set(point.benchmark, matches);
    }
    for (const {reference, id, unit, pairId, name} of comparisons.get(
      point.benchmark,
    )) {
      const actual = point.values[reference];
      const prediction = point.values[id];
      if (
        !Number.isFinite(actual) ||
        actual <= 0 ||
        !Number.isFinite(prediction) ||
        prediction <= 0
      )
        continue;
      pairs.push({
        point,
        group: point.group,
        actual,
        prediction,
        signedError:
          (100 * (prediction - actual)) / Math.min(prediction, actual),
        unit,
        id: pairId,
        name,
      });
    }
  }
  return pairs.filter((p) => Number.isFinite(p.signedError));
}

export function errorStats(pairs) {
  if (!pairs.length) return [];
  let total = 0,
    max = 0;
  for (const pair of pairs) {
    const error = Math.abs(pair.signedError);
    total += error;
    max = Math.max(max, error);
  }
  const mean = total / pairs.length;
  return [
    ['Average error', mean.toFixed(2) + '%'],
    ['Max error', max.toFixed(2) + '%'],
  ];
}

export function averageRanks(values) {
  const ordered = values
    .map((value, index) => ({value, index}))
    .sort((a, b) => a.value - b.value);
  const ranks = [];
  for (let start = 0; start < ordered.length;) {
    let end = start + 1;
    while (end < ordered.length && ordered[end].value === ordered[start].value)
      end++;
    const rank = (start + end + 1) / 2;
    for (let i = start; i < end; i++) ranks[ordered[i].index] = rank;
    start = end;
  }
  return ranks;
}

export function rankStatistics(pairs) {
  const count = pairs.length;
  const total = count < 2 ? 0 : (count * (count - 1)) / 2;
  let concordant = 0,
    discordant = 0;
  let measuredUnequal = total,
    simulatedUnequal = total;
  const measuredRanks = new Float64Array(count);
  const simulatedRanks = averageRanks(pairs.map((pair) => pair.prediction));
  const ordered = Array.from({length: count}, (_, i) => i).sort(
    (a, b) => pairs[a].actual - pairs[b].actual,
  );
  // Distinct tie blocks have distinct ceil(average rank) indices in [1, n].
  const frequencies = new Uint32Array(count + 1);
  for (const rank of simulatedRanks) {
    const index = Math.ceil(rank);
    simulatedUnequal -= frequencies[index];
    frequencies[index]++;
  }
  // A Fenwick tree counts earlier predictions below / at each average rank.
  // Query an entire measured-value tie block before inserting any of it, so
  // pairs tied on either axis never enter the concordant/discordant counts.
  const tree = new Float64Array(count + 1);
  const prefix = (index) => {
    let sum = 0;
    for (; index > 0; index -= index & -index) sum += tree[index];
    return sum;
  };
  for (let start = 0; start < count;) {
    let end = start + 1;
    while (
      end < count &&
      pairs[ordered[end]].actual === pairs[ordered[start]].actual
    )
      end++;
    measuredUnequal -= ((end - start) * (end - start - 1)) / 2;
    for (let i = start; i < end; i++) {
      const original = ordered[i];
      measuredRanks[original] = (start + end + 1) / 2;
      const rank = Math.ceil(simulatedRanks[original]);
      concordant += prefix(rank - 1);
      discordant += start - prefix(rank);
    }
    for (let i = start; i < end; i++)
      for (
        let rank = Math.ceil(simulatedRanks[ordered[i]]);
        rank <= count;
        rank += rank & -rank
      )
        tree[rank]++;
    start = end;
  }
  const tauDenominator = Math.sqrt(measuredUnequal * simulatedUnequal);
  const mean = (pairs.length + 1) / 2;
  let covariance = 0,
    measuredVariance = 0,
    simulatedVariance = 0;
  for (let i = 0; i < pairs.length; i++) {
    const x = measuredRanks[i] - mean;
    const y = simulatedRanks[i] - mean;
    covariance += x * y;
    measuredVariance += x * x;
    simulatedVariance += y * y;
  }
  const rhoDenominator = Math.sqrt(measuredVariance * simulatedVariance);
  return {
    tau: tauDenominator ? (concordant - discordant) / tauDenominator : null,
    concordant,
    measuredUnequal,
    rho: rhoDenominator ? covariance / rhoDenominator : null,
  };
}

export function rankingStats(pairs) {
  const stats = rankStatistics(pairs);
  const probability = stats.measuredUnequal
    ? ((100 * stats.concordant) / stats.measuredUnequal).toFixed(2) +
      '% (' +
      stats.concordant.toLocaleString() +
      '/' +
      stats.measuredUnequal.toLocaleString() +
      ')'
    : '—';
  return [
    ['Kendall’s τ-b', stats.tau?.toFixed(4) ?? '—'],
    ['Pairwise ordering accuracy', probability],
    ['Spearman’s ρ', stats.rho?.toFixed(4) ?? '—'],
  ];
}

export function displayName(key) {
  return key.replaceAll('_', ' ');
}

export function displayUnit(unit) {
  return unit === 'ns' ? 'ms' : unit;
}

export function preferLogScale(values) {
  const sorted = [...new Set(values.filter(Number.isFinite))].sort(
    (a, b) => a - b,
  );
  if (sorted.length < 3 || sorted[0] <= 0) return false;

  function spacingVariance(points) {
    const span = points.at(-1) - points[0];
    if (span === 0) return Infinity;
    const meanGap = 1 / (points.length - 1);
    let squaredDeviation = 0;
    for (let i = 1; i < points.length; i++) {
      const gap = (points[i] - points[i - 1]) / span;
      squaredDeviation += (gap - meanGap) ** 2;
    }
    return squaredDeviation / (points.length - 1);
  }

  const linear = spacingVariance(sorted);
  const log = spacingVariance(sorted.map(Math.log10));
  return log + 1e-12 < linear;
}

export function parameterLabel(params, metadata) {
  return (
    Object.entries(params)
      .map(([id, value]) => {
        const unit = metadata[id].unit;
        return displayName(id) + '=' + value + (unit ? ' ' + unit : '');
      })
      .join(' · ') || 'Default parameters'
  );
}

export const visibleStates = new Map([
  ['failed', {label: 'Failed', symbol: '×'}],
  ['verification_failed', {label: 'Verification failed', symbol: '⚠️'}],
  ['timeout', {label: 'Timed out', symbol: '⏱️'}],
  ['memory_limit', {label: 'Memory limit', symbol: '×'}],
  ['unsupported', {label: 'Unsupported', symbol: '×'}],
  ['running', {label: 'Running', symbol: '▶️'}],
]);

export function isMarked(row, id) {
  return (
    !Number.isFinite(row.values[id]) &&
    visibleStates.has(row.statuses?.[id]?.state)
  );
}

export function pointDescription(
  point,
  comparisons = [],
  extra = {},
  selectedSeries,
) {
  return {point, comparisons, extra, selectedSeries};
}
export function pairDescription(pair, extra = {}) {
  return pointDescription(pair.point, [pair], extra);
}

// Build once per data revision. Off-page series keep only row/pair references;
// their sorting, plot specifications and canvases are created when visited.
export function indexReport(data, benchmarks) {
  const rows = data.filter(isVisibleRow);
  const pairs = comparisonPairs(rows, benchmarks);
  const groups = new Map();
  const parameterKey = (point) =>
    JSON.stringify(Object.entries(point.non_scaling_params).sort());
  for (const point of rows) {
    if (!groups.has(point.group))
      groups.set(point.group, {pairs: [], benchmarks: new Map()});
    const group = groups.get(point.group);
    if (!group.benchmarks.has(point.benchmark))
      group.benchmarks.set(point.benchmark, {
        id: point.benchmark,
        pairs: [],
        series: new Map(),
      });
    const benchmark = group.benchmarks.get(point.benchmark);
    const key = parameterKey(point);
    if (!benchmark.series.has(key))
      benchmark.series.set(key, {parameters: key, rows: [], pairs: []});
    benchmark.series.get(key).rows.push(point);
  }
  for (const pair of pairs) {
    const group = groups.get(pair.group);
    const benchmark = group.benchmarks.get(pair.point.benchmark);
    group.pairs.push(pair);
    benchmark.pairs.push(pair);
    benchmark.series.get(parameterKey(pair.point)).pairs.push(pair);
  }
  for (const group of groups.values()) {
    for (const benchmark of group.benchmarks.values())
      benchmark.series = [...benchmark.series.values()];
    group.benchmarks = [...group.benchmarks.values()];
  }
  return {pairs, groups};
}

export function valueBounds(values) {
  let min = Infinity,
    max = -Infinity;
  for (const value of values) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return values.length ? {min, max} : null;
}

// Version of every hosted API response shape and of buildSummary's output;
// part of the API path and of summary cache keys.
export const API_VERSION = 'v1';

// The row filter of indexReport: a finite value or a drawn status.
export function isVisibleRow(point) {
  return (
    Object.values(point.values).some(Number.isFinite) ||
    Object.keys(point.statuses ?? {}).some((id) => isMarked(point, id))
  );
}

// In a multi-group Overview, the same comparison in different groups is a
// different curve.
export function relabelPairs(pairs, overview, groupName) {
  if (!overview || new Set(pairs.map((pair) => pair.group)).size <= 1)
    return pairs;
  return pairs.map((pair) => ({
    ...pair,
    id: JSON.stringify([pair.group, pair.id]),
    name: groupName(pair.group) + ' · ' + pair.name,
  }));
}

export function errorPercentiles(pairs) {
  const errors = pairs
    .map((pair) => Math.abs(pair.signedError))
    .sort((a, b) => a - b);
  return errors.length
    ? [50, 90, 95, 98].map((p) => [
        'P' + p,
        errors[Math.ceil((p / 100) * errors.length) - 1].toPrecision(3) + '%',
      ])
    : [];
}

export const summaryLimits = {scurve: 1500, cdf: 1500, scatter: 3000};

// Indices 0 and n - 1 plus evenly spaced ones, at most `limit` in total.
function spaced(n, limit) {
  if (limit >= n) return Array.from({length: n}, (_, i) => i);
  if (limit <= 0) return [];
  if (limit === 1) return [0];
  const picked = new Set();
  for (let k = 0; k < limit; k++)
    picked.add(Math.round((k * (n - 1)) / (limit - 1)));
  return [...picked];
}

function sampleSummary(pairs, units, limits) {
  const samples = new Map();
  const add = (pair) => {
    if (!samples.has(pair)) samples.set(pair, samples.size);
    return samples.get(pair);
  };
  const byError = [...pairs].sort((a, b) => a.signedError - b.signedError);
  const scurve = {sample: [], rank: []};
  for (const i of spaced(byError.length, limits.scurve)) {
    scurve.sample.push(add(byError[i]));
    scurve.rank.push(i + 1);
  }
  const byAbsolute = [...pairs].sort(
    (a, b) => Math.abs(a.signedError) - Math.abs(b.signedError),
  );
  const cdf = {sample: [], rank: []};
  for (const i of spaced(byAbsolute.length, limits.cdf)) {
    cdf.sample.push(add(byAbsolute[i]));
    cdf.rank.push(i + 1);
  }
  const scatter = {};
  for (const [unit, unitPairs] of units) {
    const limit = limits.scatter;
    const chosen = new Set();
    if (limit < unitPairs.length) {
      const largest = [...unitPairs]
        .sort((a, b) => Math.abs(b.signedError) - Math.abs(a.signedError))
        .slice(0, Math.floor(limit / 3));
      for (const pair of largest) chosen.add(pair);
      for (const key of ['actual', 'prediction']) {
        let low = unitPairs[0],
          high = unitPairs[0];
        for (const pair of unitPairs) {
          if (pair[key] < low[key]) low = pair;
          if (pair[key] > high[key]) high = pair;
        }
        if (limit > 0) chosen.add(low).add(high);
      }
      const byActual = [...unitPairs].sort((a, b) => a.actual - b.actual);
      for (const i of spaced(byActual.length, Math.max(0, limit - chosen.size)))
        chosen.add(byActual[i]);
    } else for (const pair of unitPairs) chosen.add(pair);
    scatter[unit] = [...chosen].map(add);
  }
  return {samples: [...samples.keys()], scurve, cdf, scatter};
}

// The summary of one scope in the hosted format: exact statistics over every
// comparison, charts from a deterministic sample. `rows` are data.json points
// of the scope, each with a `plot` id; `groups` is [[id, key, name]] of the
// scope's groups. Returns `sample(limits)`, which assembles the summary with at
// most `limits` sampled comparisons per chart; the exact part is computed once
// and is the same for every limit. `plots[id][2]` holds the row's
// non_scaling_params, or null when the rows carry none (the API fills them in).
export function buildSummary({rows, benchmarks, groups, overview}) {
  const groupIndex = new Map(groups.map(([, key], i) => [key, i]));
  const base = comparisonPairs(rows, benchmarks);
  const pairs = relabelPairs(
    base,
    overview,
    (key) => groups[groupIndex.get(key)][2],
  );
  const relabeled = pairs !== base;
  const position = new Map(pairs.map((pair, i) => [pair, i]));
  const indexer = (make) => {
    const keys = new Map();
    const list = [];
    return {
      list,
      of(key, ...args) {
        if (!keys.has(key)) {
          keys.set(key, list.length);
          list.push(make(key, ...args));
        }
        return keys.get(key);
      },
    };
  };
  const benchmarkList = indexer((key) => key);
  const seriesList = indexer((key, benchmark) => {
    const {name, unit} = benchmarks[benchmark].values[key];
    return [key, name, unit];
  });
  const pairList = indexer((key, i) => {
    const [reference, simulated] = JSON.parse(base[i].id);
    const benchmark = base[i].point.benchmark;
    return [
      relabeled ? groupIndex.get(base[i].group) : null,
      seriesList.of(reference, benchmark),
      seriesList.of(simulated, benchmark),
    ];
  });
  const pairOf = (pair) => {
    const i = position.get(pair);
    return pairList.of(pair.id, i);
  };
  pairs.forEach(pairOf);
  const units = Map.groupBy(pairs, (pair) => pair.unit);
  const scatterStats = Array.from(units, ([unit, unitPairs]) => [
    unit,
    {
      log: preferLogScale(
        unitPairs.flatMap((pair) => [pair.actual, pair.prediction]),
      ),
      count: unitPairs.length,
      stats: [...rankingStats(unitPairs), ...errorStats(unitPairs)],
    },
  ]);
  const benchmarkStats = overview
    ? []
    : Array.from(
        Map.groupBy(pairs, (pair) => pair.point.benchmark),
        ([benchmark, benchmarkPairs]) => [
          benchmarkList.of(benchmark),
          benchmarkPairs.length,
          errorStats(benchmarkPairs),
        ],
      );
  const exact = {
    count: pairs.length,
    relabeled,
    stats: errorStats(pairs),
    percentiles: errorPercentiles(pairs),
    cdfLog: preferLogScale(pairs.map((pair) => Math.abs(pair.signedError))),
  };
  const assemble = (current) => {
    const sampled = sampleSummary(pairs, units, current);
    const plots = {};
    const samples = {plot: [], x: [], pair: [], actual: [], prediction: []};
    for (const pair of sampled.samples) {
      const {point} = pair;
      if (!(point.plot in plots))
        plots[point.plot] = [
          groupIndex.get(point.group),
          benchmarkList.of(point.benchmark),
          point.non_scaling_params ?? null,
        ];
      samples.plot.push(point.plot);
      samples.x.push(point.x);
      samples.pair.push(pairOf(pair));
      samples.actual.push(pair.actual);
      samples.prediction.push(pair.prediction);
    }
    return {
      count: exact.count,
      relabeled,
      groups,
      stats: exact.stats,
      percentiles: exact.percentiles,
      series: seriesList.list,
      pairs: pairList.list,
      benchmarks: benchmarkList.list,
      plots,
      samples,
      scurve: sampled.scurve,
      cdf: {log: exact.cdfLog, ...sampled.cdf},
      scatter: Object.fromEntries(
        scatterStats.map(([unit, stats]) => [
          unit,
          {...stats, sample: sampled.scatter[unit]},
        ]),
      ),
      benchmark_stats: benchmarkStats,
    };
  };
  return assemble;
}

// Inverse of buildSummary for drawing: pair-like objects that the summary
// charts and point details consume.
export function summaryCharts(summary) {
  const {series, groups, benchmarks, plots, samples} = summary;
  const pairInfo = summary.pairs.map(([group, reference, simulated]) => {
    const [referenceKey, referenceName] = series[reference];
    const [simulatedKey, simulatedName, unit] = series[simulated];
    const id = JSON.stringify([referenceKey, simulatedKey]);
    const name = simulatedName + ' vs. ' + referenceName;
    return group === null
      ? {id, name, unit, referenceKey, simulatedKey}
      : {
          id: JSON.stringify([groups[group][1], id]),
          name: groups[group][2] + ' · ' + name,
          unit,
          referenceKey,
          simulatedKey,
        };
  });
  const pairs = samples.plot.map((plot, i) => {
    const info = pairInfo[samples.pair[i]];
    const [group, benchmark, params] = plots[plot];
    const actual = samples.actual[i];
    const prediction = samples.prediction[i];
    const point = {
      group: groups[group][1],
      benchmark: benchmarks[benchmark],
      x: samples.x[i],
      non_scaling_params: params ?? {},
      values: {[info.referenceKey]: actual, [info.simulatedKey]: prediction},
    };
    return {
      point,
      group: point.group,
      actual,
      prediction,
      signedError: (100 * (prediction - actual)) / Math.min(prediction, actual),
      unit: info.unit,
      id: info.id,
      name: info.name,
    };
  });
  const ranked = (chart) =>
    chart.sample.map((sample, i) => ({...pairs[sample], rank: chart.rank[i]}));
  return {
    count: summary.count,
    legend: pairInfo,
    stats: summary.stats,
    percentiles: summary.percentiles,
    scurve: ranked(summary.scurve),
    cdf: {log: summary.cdf.log, pairs: ranked(summary.cdf)},
    scatter: Object.entries(summary.scatter).map(([unit, chart]) => ({
      unit,
      log: chart.log,
      count: chart.count,
      stats: chart.stats,
      pairs: chart.sample.map((sample) => pairs[sample]),
    })),
  };
}
