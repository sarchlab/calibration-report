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
  const rows = data.filter(
    (point) =>
      Object.values(point.values).some(Number.isFinite) ||
      Object.keys(point.statuses ?? {}).some((id) => isMarked(point, id)),
  );
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
