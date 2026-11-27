// The comparisons among `series` ([id, {name, unit, role}] entries): each
// simulator series against the one hardware series of its unit, if exactly
// one exists.
export function seriesComparisons(series) {
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
  return matches;
}

export function comparisonPairs(rows, benchmarks) {
  const pairs = [];
  const comparisons = new Map();
  for (const point of rows) {
    if (!comparisons.has(point.benchmark))
      comparisons.set(
        point.benchmark,
        seriesComparisons(Object.entries(benchmarks[point.benchmark].values)),
      );
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

// `order` lists parameter names in display order; names the point lacks are
// skipped.
export function parameterLabel(params, metadata, order = Object.keys(params)) {
  return (
    order
      .filter((id) => Object.hasOwn(params, id))
      .map((id) => {
        const unit = metadata[id].unit;
        return displayName(id) + '=' + params[id] + (unit ? ' ' + unit : '');
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

// The parameters that name a point's chart: its non_scaling_params, without
// `launch` when it has a `launch_group`, so that repeated launches of one
// group share a chart and each launch stays a separate row. The hosted API
// applies the same rule in SQL (`chartKey` in netlify/lib/api.js).
export function chartParams(params) {
  if (!Object.hasOwn(params, 'launch_group')) return params;
  const {launch: _launch, ...rest} = params;
  return rest;
}

export const isLaunchGroup = (params) => Object.hasOwn(params, 'launch_group');

// A `launch` label that names a global launch ordinal and a kernel, like
// "#912 nw_kernel2": {ordinal, kernel}, else null. `s`: `.` matches any
// character, as in the SQL regex (`launchLabel` in netlify/lib/api.js).
export function parseLaunch(params) {
  const match =
    typeof params.launch === 'string' && /^#([0-9]+) (.+)$/s.exec(params.launch);
  return match ? {ordinal: Number(match[1]), kernel: match[2]} : null;
}

// The group × benchmark pairs, as JSON([group, benchmark]), whose charts are
// launch-ordinal: every row has an ordinal `launch` label and no
// `launch_group`, and for some combination of the other parameters the
// number of launches differs between x values: the launch count varies with
// the scaling value (a count that depends only on other parameters, like
// SRAD's iterations, does not). Such a benchmark gets one chart per
// (parameters without `launch`, x), drawn over the launch ordinal. `rows`
// are visible rows. The hosted API applies the same rule in SQL (`launchOrdinalCharts`).
export function launchOrdinalBenchmarks(rows) {
  const benchmarks = new Map();
  for (const row of rows) {
    const id = JSON.stringify([row.group, row.benchmark]);
    if (!benchmarks.has(id)) benchmarks.set(id, {ordinal: true, launches: new Map()});
    const benchmark = benchmarks.get(id);
    const params = row.non_scaling_params;
    if (!benchmark.ordinal) continue;
    if (isLaunchGroup(params) || !parseLaunch(params)) {
      benchmark.ordinal = false;
      continue;
    }
    const {launch, ...rest} = params;
    const key = JSON.stringify(Object.entries(rest).sort());
    if (!benchmark.launches.has(key)) benchmark.launches.set(key, new Map());
    const perX = benchmark.launches.get(key);
    if (!perX.has(row.x)) perX.set(row.x, new Set());
    perX.get(row.x).add(launch);
  }
  const ordinal = new Set();
  for (const [id, {ordinal: candidate, launches}] of benchmarks)
    if (
      candidate &&
      [...launches.values()].some(
        (perX) => new Set([...perX.values()].map((set) => set.size)).size > 1,
      )
    )
      ordinal.add(id);
  return ordinal;
}

// Shaded percentile bands of launch-group charts, outermost first: the
// [low, high] quantiles and the dispatches an X needs to draw the level.
export const launchBands = [
  {low: 0.02, high: 0.98, minimum: 50},
  {low: 0.1, high: 0.9, minimum: 10},
  {low: 0.25, high: 0.75, minimum: 4},
];

// Linearly interpolated quantile of ascending values.
export function quantile(sorted, q) {
  const position = q * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.min(low + 1, sorted.length - 1);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

// The drawn rows of one unit's plot of a launch-group chart: one row per X of
// `rows` (the dispatches, sorted by x) whose values are medians. `pairs` are
// the chart's comparison pairs of that unit (comparisonPairs). A curve's
// median and bands at an X are taken over its dispatches with a valid pair:
// a simulated curve over the pairs with its reference, a measured curve over
// the union of the pairs it is the reference of, so a measured-versus-
// simulated curve pair uses one dispatch set. A curve without valid pairs at
// that X (hardware-only, untagged, or unpaired results) uses every dispatch
// with a finite value. `curves` carry their series metadata (name, unit,
// role). `launches` keeps the dispatches, the paired count of every
// comparison of `curves` at that X (0 when none paired), and, per curve, the
// sorted values and band ranges (null below a level's minimum).
export function launchGroupRows(rows, curves, pairs) {
  const pairsAt = Map.groupBy(pairs, (pair) => pair.point.x);
  const configured = seriesComparisons(curves.map((curve) => [curve.id, curve]));
  return Array.from(Map.groupBy(rows, (row) => row.x), ([x, dispatches]) => {
    const paired = new Map();
    const found = Map.groupBy(pairsAt.get(x) ?? [], (pair) => pair.id);
    const comparisons = configured.map(({pairId, name}) => ({
      id: pairId,
      name,
      count: found.get(pairId)?.length ?? 0,
    }));
    for (const [id, list] of found) {
      const [reference, simulated] = JSON.parse(id);
      paired.set(simulated, new Map(list.map((pair) => [pair.point, pair.prediction])));
      if (!paired.has(reference)) paired.set(reference, new Map());
      for (const pair of list) paired.get(reference).set(pair.point, pair.actual);
    }
    // Series keys are producer-chosen (`__proto__`).
    const values = Object.create(null);
    const sets = Object.create(null);
    for (const curve of curves) {
      const sorted = (
        paired.has(curve.id)
          ? [...paired.get(curve.id).values()]
          : dispatches.map((row) => row.values[curve.id]).filter(Number.isFinite)
      ).sort((a, b) => a - b);
      if (!sorted.length) continue;
      values[curve.id] = quantile(sorted, 0.5);
      sets[curve.id] = {
        sorted,
        bands: launchBands.map(({low, high, minimum}) =>
          sorted.length >= minimum ? [quantile(sorted, low), quantile(sorted, high)] : null,
        ),
      };
    }
    const first = dispatches[0];
    return {
      group: first.group,
      benchmark: first.benchmark,
      x,
      non_scaling_params: chartParams(first.non_scaling_params),
      values,
      launches: {rows: dispatches, comparisons, curves: sets},
    };
  });
}

// Build once per data revision. Off-page series keep only row/pair references;
// their sorting, plot specifications and canvases are created when visited.
export function indexReport(data, benchmarks) {
  const rows = data.filter(isVisibleRow);
  const pairs = comparisonPairs(rows, benchmarks);
  const groups = new Map();
  const ordinal = launchOrdinalBenchmarks(rows);
  const isOrdinal = (point) => ordinal.has(JSON.stringify([point.group, point.benchmark]));
  // A launch-ordinal chart is one (parameters without `launch`, x).
  const parameterKey = (point) => {
    if (!isOrdinal(point))
      return JSON.stringify(Object.entries(chartParams(point.non_scaling_params)).sort());
    const {launch: _launch, ...rest} = point.non_scaling_params;
    return JSON.stringify([Object.entries(rest).sort(), point.x]);
  };
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
      benchmark.series.set(
        key,
        isOrdinal(point)
          ? {parameters: key, rows: [], pairs: [], launchOrdinal: true}
          : {parameters: key, rows: [], pairs: []},
      );
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

// Version of every hosted API response shape and of buildSummary's output
// (a summary-only change bumps SUMMARY_FORMAT instead); part of the API path
// and of summary cache keys.
export const API_VERSION = 'v1';
// Version of the summary response within API_VERSION, bumped when only the
// summary changes (2: point_progress); part of the summary URL (`format=`)
// and of its cache key, so cached old-format summaries are never served.
export const SUMMARY_FORMAT = 2;
// Version of the plots response within API_VERSION (2: pages charts, plots
// carry `chart`; 3: launch-ordinal charts split plots by x and the response
// says `launch_ordinal`); the viewer sends it as `format=` on every plots
// request, so a cached immutable response of an older format is never
// reused, and the Function rejects any other format.
export const PLOTS_FORMAT = 3;

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
      const take = (pair) => {
        if (chosen.size < limit) chosen.add(pair);
      };
      const largest = [...unitPairs]
        .sort((a, b) => Math.abs(b.signedError) - Math.abs(a.signedError))
        .slice(0, Math.floor(limit / 3));
      for (const pair of largest) take(pair);
      // Extrema in a fixed order while capacity remains.
      for (const key of ['actual', 'prediction']) {
        let low = unitPairs[0],
          high = unitPairs[0];
        for (const pair of unitPairs) {
          if (pair[key] < low[key]) low = pair;
          if (pair[key] > high[key]) high = pair;
        }
        take(low);
        take(high);
      }
      // The rest evenly spaced by measured value.
      const rest = [...unitPairs]
        .filter((pair) => !chosen.has(pair))
        .sort((a, b) => a.actual - b.actual);
      for (const i of spaced(rest.length, limit - chosen.size)) take(rest[i]);
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
    // Every distinct sampled comparison, for statistics shared by both curves.
    sampled: [...new Set([...summary.scurve.sample, ...summary.cdf.sample])].map(
      (sample) => pairs[sample],
    ),
    scatter: Object.entries(summary.scatter).map(([unit, chart]) => ({
      unit,
      log: chart.log,
      count: chart.count,
      stats: chart.stats,
      pairs: chart.sample.map((sample) => pairs[sample]),
    })),
  };
}
