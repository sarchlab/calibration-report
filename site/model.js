export function comparisonPairs(rows, benchmarks) {
  const pairs = [];
  for (const point of rows) {
    const series = Object.entries(benchmarks[point.benchmark].values);
    const hardware = series.filter(
      ([, value]) => value.role === 'hardware_measurement',
    );
    for (const [id, simulated] of series) {
      if (simulated.role !== 'simulator_output') continue;
      const references = hardware.filter(
        ([, value]) => value.unit === simulated.unit,
      );
      if (references.length !== 1) continue;
      const [reference, measured] = references[0];
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
        unit: simulated.unit,
        id: JSON.stringify([reference, id]),
        name: simulated.name + ' vs. ' + measured.name,
      });
    }
  }
  return pairs.filter((p) => Number.isFinite(p.signedError));
}

export function errorStats(pairs) {
  if (!pairs.length) return [];
  const errors = pairs.map((pair) => Math.abs(pair.signedError));
  const mean =
    errors.reduce((total, error) => total + error, 0) / errors.length;
  const max = Math.max(...errors);
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
  let concordant = 0,
    discordant = 0,
    measuredUnequal = 0,
    simulatedUnequal = 0;
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
  const tauDenominator = Math.sqrt(measuredUnequal * simulatedUnequal);
  const measuredRanks = averageRanks(pairs.map((pair) => pair.actual));
  const simulatedRanks = averageRanks(pairs.map((pair) => pair.prediction));
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
