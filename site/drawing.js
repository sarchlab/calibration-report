import {
  comparisonPairs,
  displayUnit,
  preferLogScale,
  pointDescription,
  pairDescription,
} from './model.js';

const tickNumber = new Intl.NumberFormat('en-US', {
  maximumSignificantDigits: 3,
  useGrouping: false,
});
const tickPrefixes = new Map([
  [-12, 'p'],
  [-9, 'n'],
  [-6, 'µ'],
  [-3, 'm'],
  [0, ''],
  [3, 'k'],
  [6, 'M'],
  [9, 'G'],
  [12, 'T'],
]);

function formatTick(value) {
  if (Math.abs(value) >= 0.1 && Math.abs(value) < 1)
    return tickNumber.format(value);
  if (value === 0) return '0';
  let exponent = 3 * Math.floor(Math.log10(Math.abs(value)) / 3);
  let scaled = value / 10 ** exponent;
  if (Math.abs(scaled) >= 999.5) {
    exponent += 3;
    scaled /= 1000;
  }
  const prefix = tickPrefixes.get(exponent);
  return prefix === undefined
    ? value.toExponential(2)
    : tickNumber.format(scaled) + prefix;
}

function linearTicks(min, max, count) {
  if (min === max) return [min];
  const rough = (max - min) / (count - 1);
  const power = 10 ** Math.floor(Math.log10(rough));
  if (!power || !Number.isFinite(power)) return [min, max];
  const multiplier = [1, 2, 5, 10].find((n) => rough / power <= n * Math.SQRT2);
  const step = power * multiplier;
  const first = Math.ceil(min / step - 1e-10);
  const last = Math.floor(max / step + 1e-10);
  return Array.from({length: Math.max(0, last - first + 1)}, (_, i) =>
    Number(((first + i) * step).toPrecision(13)),
  );
}

function axisTicks(min, max, count, log) {
  if (!log || min <= 0 || min === max || !Number.isFinite(max))
    return linearTicks(min, max, count);
  const low = Math.log10(min),
    high = Math.log10(max);
  const major = [],
    minor = [];
  for (
    let exponent = Math.floor(low);
    exponent <= Math.floor(high);
    exponent++
  ) {
    for (const factor of [1, 2, 5]) {
      const tick = factor * 10 ** exponent;
      if (tick >= min * (1 - 1e-12) && tick <= max * (1 + 1e-12)) {
        (factor === 1 ? major : minor).push(tick);
      }
    }
  }
  if (major.length + minor.length < 2) return linearTicks(min, max, count);
  if (major.length + minor.length <= count)
    return [...major, ...minor].sort((a, b) => a - b);
  if (major.length >= count) {
    const stride = Math.ceil(major.length / count);
    return major.filter((_, i) => i % stride === 0);
  }
  const ticks = [...major];
  for (const tick of minor) {
    if (ticks.length === count) break;
    if (
      ticks.every(
        (other) => Math.abs(Math.log10(tick / other)) >= (high - low) / count,
      )
    )
      ticks.push(tick);
  }
  return ticks.sort((a, b) => a - b);
}

function numericAxis(
  [min, max],
  [start, end],
  {log = false, unit = '', count = 5, format = formatTick} = {},
) {
  log = log && min > 0;
  const transform = log ? Math.log10 : (n) => n;
  const low = transform(min),
    high = transform(max);
  const position = (value) =>
    low === high
      ? (start + end) / 2
      : start + ((transform(value) - low) / (high - low)) * (end - start);
  const divisor = unit === 'ns' ? 1e6 : 1;
  const ticks = axisTicks(min / divisor, max / divisor, count, log).map(
    (value) => ({
      label: format(value),
      position: position(value * divisor),
    }),
  );
  return {position, ticks};
}

// Background bands of the summary curves: the comparisons split by measured
// hardware time at these quantiles, one faint unselectable curve per band.
const BAND_QUANTILES = [0.02, 0.25, 0.5, 0.75, 0.98];
const BAND_MINIMUM = 30;
const TIME_UNITS = new Set(['ns', 'us', 'µs', 'ms', 's']);
const BAND_COLORS = ['#4c6fd1', '#3a9bd0', '#36b39b', '#8cbf4d', '#e0a33a', '#d9583b'];

function formatTime(value, unit) {
  return unit === 'ns'
    ? formatTick(value / 1e9) + 's'
    : formatTick(value) + (unit ? ' ' + unit : '');
}

// Bands over the comparisons in the most common unit, or null when there
// are too few to split. `cutoffs[i]` separates band i from band i + 1.
export function timeBands(pairs, source = pairs) {
  const cutoffs = bandCutoffs(source);
  if (!cutoffs) return null;
  const {unit} = cutoffs;
  const bands = Array.from({length: cutoffs.values.length + 1}, () => []);
  for (const pair of pairs) {
    if (pair.unit !== unit || !Number.isFinite(pair.actual)) continue;
    let band = 0;
    while (band < cutoffs.values.length && pair.actual >= cutoffs.values[band]) band++;
    bands[band].push(pair);
  }
  return {unit, cutoffs: cutoffs.values, bands};
}

function bandCutoffs(pairs) {
  const durations = pairs.filter(
    (pair) => TIME_UNITS.has(pair.unit) && Number.isFinite(pair.actual),
  );
  const byUnit = Map.groupBy(durations, (pair) => pair.unit);
  const [unit, sameUnit] = [...byUnit].sort((a, b) => b[1].length - a[1].length)[0] ?? [];
  const timed = sameUnit ?? [];
  if (timed.length < BAND_MINIMUM) return null;
  const sorted = timed.map((pair) => pair.actual).sort((a, b) => a - b);
  return {
    unit,
    values: BAND_QUANTILES.map(
      (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))],
    ),
  };
}

function bandLabels({unit, cutoffs}) {
  const t = (value) => formatTime(value, unit);
  return [
    '< ' + t(cutoffs[0]),
    ...cutoffs.slice(1).map((cutoff, i) => t(cutoffs[i]) + '–' + t(cutoff)),
    '≥ ' + t(cutoffs.at(-1)),
  ];
}

// Drawing is imperative only inside the supplied canvas; React owns every DOM element.
export function drawChart(canvas, spec, chartTheme, benchmarks) {
  function drawAxisTicks(ctx, x, y, {left, right, top, bottom}) {
    ctx.strokeStyle = chartTheme.grid;
    ctx.fillStyle = chartTheme.label;
    ctx.textAlign = 'center';
    let lastRight = -Infinity;
    let lastLabel;
    for (const {position, label} of x.ticks) {
      ctx.beginPath();
      ctx.moveTo(position, top);
      ctx.lineTo(position, bottom);
      ctx.stroke();
      const half = ctx.measureText(label).width / 2;
      if (label === lastLabel || position - half < lastRight + 6) continue;
      ctx.fillText(label, position, bottom + 13);
      lastRight = position + half;
      lastLabel = label;
    }
    ctx.textAlign = 'right';
    let lastY = Infinity;
    lastLabel = undefined;
    for (const {position, label} of y.ticks) {
      ctx.beginPath();
      ctx.moveTo(left, position);
      ctx.lineTo(right, position);
      ctx.stroke();
      if (label === lastLabel || lastY - position < 12) continue;
      ctx.fillText(label, left - 5, position + 3);
      lastY = position;
      lastLabel = label;
    }
  }

  function drawAxisTitles(
    ctx,
    xLabel,
    yLabel,
    {left, right, top, bottom},
    xBaseline,
  ) {
    ctx.textAlign = 'center';
    ctx.fillText(xLabel, (left + right) / 2, xBaseline);
    if (!yLabel) return;
    ctx.save();
    ctx.translate(10, (top + bottom) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(yLabel, 0, 0);
    ctx.restore();
  }

  function drawCurve(rows, curves, xLabel, unit, bounds, scales) {
    const hitPoints = [];
    canvas.width = 640;
    canvas.height = bounds ? 318 : 70;
    canvas.setAttribute('role', 'img');
    const xScale = scales.x ? 'logarithmic' : 'linear';
    const yScale = scales.y ? 'logarithmic' : 'linear';
    canvas.setAttribute(
      'aria-label',
      bounds
        ? 'Comparison by ' +
            xLabel +
            ', ' +
            xScale +
            ' X axis, ' +
            yScale +
            ' Y axis'
        : 'Unavailable results by ' + xLabel,
    );
    const ctx = canvas.getContext('2d');
    ctx.scale(2, 2);
    const frame = {left: 53, right: 305, top: 8, bottom: bounds ? 124 : 8};
    const {left, right, top, bottom} = frame;
    ctx.font = '10px system-ui';
    ctx.fillStyle = chartTheme.label;
    const xAxis = numericAxis([rows[0].x, rows.at(-1).x], [left, right], {
      log: scales.x,
      count: 6,
    });
    let yAxis = {ticks: []};
    let yLabel = '';
    if (bounds) {
      const transformY = scales.y ? Math.log10 : (n) => n;
      const inverseY = scales.y ? (n) => 10 ** n : (n) => n;
      let min = transformY(bounds.min),
        max = transformY(bounds.max);
      const span = Math.max(max - min, Math.abs(max) * 0.02) || 0.001;
      min -= span * 0.12;
      max += span * 0.12;
      yAxis = numericAxis([inverseY(min), inverseY(max)], [bottom, top], {
        log: scales.y,
        unit,
      });
      yLabel = [displayUnit(unit), scales.y ? 'log' : '']
        .filter(Boolean)
        .join(' · ');
    }
    drawAxisTicks(ctx, xAxis, yAxis, frame);
    drawAxisTitles(
      ctx,
      xLabel + (scales.x ? ' · log' : ''),
      yLabel,
      frame,
      bottom + (bounds ? 29 : 25),
    );
    const x = (index) => xAxis.position(rows[index].x);
    const y = yAxis.position;

    for (const curve of curves) {
      ctx.strokeStyle = ctx.fillStyle = curve.color;
      ctx.lineWidth = 1.65;
      let drawing = false;
      ctx.beginPath();
      rows.forEach((row, i) => {
        const value = row.values[curve.id];
        if (!Number.isFinite(value)) {
          drawing = false;
          return;
        }
        if (drawing) ctx.lineTo(x(i), y(value));
        else ctx.moveTo(x(i), y(value));
        drawing = true;
      });
      ctx.stroke();
      rows.forEach((row, i) => {
        const value = row.values[curve.id];
        if (!Number.isFinite(value)) return;
        ctx.beginPath();
        ctx.arc(x(i), y(value), 2.6, 0, 2 * Math.PI);
        ctx.fill();
        hitPoints.push({
          x: x(i),
          y: y(value),
          description: pointDescription(
            row,
            comparisonPairs([row], benchmarks).filter(
              (pair) => pair.unit === unit,
            ),
            {},
            curve.id,
          ),
        });
      });
    }
    return {
      canvas,
      hitPoints,
      xPosition: (value) => xAxis.position(value) / (canvas.width / 2),
      statusPosition: (bounds ? bottom - 4 : bottom) / (canvas.height / 2),
    };
  }

  function summaryAxes(
    title,
    xLabel,
    yLabel,
    xRange,
    yRange,
    xOptions = {},
    yOptions = {},
    bands = null,
  ) {
    canvas.width = 640;
    canvas.height = bands ? 372 + 2 * 44 : 372;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', title);
    const ctx = canvas.getContext('2d');
    ctx.scale(2, 2);
    ctx.font = '10px system-ui';
    const frame = {left: 51, right: 306, top: 12, bottom: 143};
    const {left, right, top, bottom} = frame;
    const xAxis = numericAxis(xRange, [left, right], {count: 6, ...xOptions});
    const yAxis = numericAxis(yRange, [bottom, top], yOptions);
    const x = xAxis.position;
    const y = yAxis.position;
    drawAxisTicks(ctx, xAxis, yAxis, frame);
    drawAxisTitles(ctx, xLabel, yLabel, frame, 179);
    if (bands) drawBandLegend(ctx, bands, 196);
    return {canvas, ctx, x, y, points: []};
  }

  function drawBandLegend(ctx, bands, top) {
    const labels = bandLabels(bands);
    ctx.save();
    ctx.font = '9px system-ui';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = chartTheme.label;
    ctx.textAlign = 'left';
    ctx.fillText('Hardware time bands (2 / 25 / 50 / 75 / 98th percentile cutoffs)', 12, top);
    labels.forEach((label, i) => {
      const left = 12 + (i % 3) * 102;
      const y = top + 14 + Math.floor(i / 3) * 13;
      ctx.strokeStyle = BAND_COLORS[i];
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(left + 12, y);
      ctx.stroke();
      ctx.fillStyle = chartTheme.label;
      const count = bands.bands[i].length;
      ctx.fillText(label + (count < 2 ? ' (too few)' : ''), left + 16, y);
    });
    ctx.restore();
  }

  // One faint polyline per band, drawn first so the main chart stays on top.
  function drawBandCurves(chart, bands, toPoints) {
    const {ctx} = chart;
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 0.9;
    bands.bands.forEach((pairs, i) => {
      if (pairs.length < 2) return;
      ctx.strokeStyle = BAND_COLORS[i];
      ctx.beginPath();
      toPoints(pairs).forEach(([px, py], j) =>
        j ? ctx.lineTo(px, py) : ctx.moveTo(px, py),
      );
      ctx.stroke();
    });
    ctx.restore();
  }

  function summaryPoint(chart, x, y, color, description) {
    chart.ctx.fillStyle = color;
    chart.ctx.beginPath();
    chart.ctx.arc(chart.x(x), chart.y(y), 1.5, 0, 2 * Math.PI);
    chart.ctx.fill();
    chart.points.push({x: chart.x(x), y: chart.y(y), description});
  }

  function referenceLine(chart, x0, y0, x1, y1) {
    const {ctx, x, y} = chart;
    ctx.save();
    ctx.strokeStyle = chartTheme.reference;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x(x0), y(y0));
    ctx.lineTo(x(x1), y(y1));
    ctx.stroke();
    ctx.restore();
  }

  // A sampled chart's pairs carry their `rank` among `total` comparisons.
  function rankedErrors(pairs, colors, total = pairs.length, bandSource = pairs) {
    const ranked = [...pairs].sort((a, b) => a.signedError - b.signedError);
    const end = Math.max(2, total);
    const minimum = Math.min(0, ranked[0].signedError);
    const maximum = Math.max(0, ranked[ranked.length - 1].signedError);
    const margin = Math.max(0.2, (maximum - minimum) * 0.06);
    const bands = timeBands(pairs, bandSource);
    const chart = summaryAxes(
      'S-curve of signed relative error',
      'Case rank',
      'Signed error (%)',
      [1, end],
      [minimum - margin, maximum + margin],
      {count: Math.min(6, end)},
      {format: (n) => (n > 0 ? '+' : '') + formatTick(n) + '%'},
      bands,
    );
    referenceLine(chart, 1, 0, end, 0);
    // Each band spans the whole rank axis: its own rank, scaled to the run's.
    if (bands)
      drawBandCurves(chart, bands, (band) =>
        [...band]
          .sort((a, b) => a.signedError - b.signedError)
          .map((pair, j, all) => [
            chart.x(1 + ((end - 1) * j) / (all.length - 1)),
            chart.y(pair.signedError),
          ]),
      );
    ranked.forEach((pair, i) => {
      const rank = pair.rank ?? i + 1;
      summaryPoint(
        chart,
        rank,
        pair.signedError,
        colors.get(pair.id).color,
        pairDescription(pair, {'Case rank': rank.toLocaleString('en-US')}),
      );
    });
    return {hitPoints: chart.points};
  }

  function absoluteErrorCDF(pairs, total = pairs.length, preferLog, bandSource = pairs) {
    const ranked = [...pairs].sort(
      (a, b) => Math.abs(a.signedError) - Math.abs(b.signedError),
    );
    const errors = ranked.map((pair) => Math.abs(pair.signedError));
    const log = preferLog ?? preferLogScale(errors);
    const left = log ? 10 ** Math.floor(Math.log10(errors[0])) : 0;
    const maximum = errors.at(-1);
    const right = log
      ? 10 ** (Math.ceil(Math.log10(maximum)) + 0.1)
      : maximum * 1.04 || 1;
    const bands = timeBands(pairs, bandSource);
    const chart = summaryAxes(
      'Absolute error cumulative distribution',
      'Absolute error (%)' + (log ? ' · log' : ''),
      'Cumulative fraction',
      [left, right],
      [0, 1],
      {log},
      {},
      bands,
    );
    const {ctx, x, y} = chart;
    // Each band's own empirical CDF, as a step line.
    if (bands)
      drawBandCurves(chart, bands, (band) => {
        const sorted = band
          .map((pair) => Math.max(left, Math.abs(pair.signedError)))
          .sort((a, b) => a - b);
        const steps = [[x(left), y(0)]];
        sorted.forEach((error, j) => {
          steps.push([x(error), y(j / sorted.length)]);
          steps.push([x(error), y((j + 1) / sorted.length)]);
        });
        steps.push([x(right), y(1)]);
        return steps;
      });
    ctx.strokeStyle = chartTheme.palette[0];
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    ctx.moveTo(x(left), y(0));
    let fraction = 0;
    for (let i = 0; i < errors.length; i++) {
      const px = x(errors[i]);
      ctx.lineTo(px, y(fraction));
      fraction = (ranked[i].rank ?? i + 1) / total;
      ctx.lineTo(px, y(fraction));
      chart.points.push({
        x: px,
        y: y(fraction),
        description: pairDescription(ranked[i], {
          'Absolute error': errors[i].toFixed(2) + '%',
          'CDF percentile': (fraction * 100).toFixed(2) + '%',
        }),
      });
    }
    ctx.lineTo(x(right), y(1));
    ctx.stroke();
    return {hitPoints: chart.points};
  }

  function comparisonScatter(pairs, unit, colors, log) {
    let minimum = Infinity,
      maximum = -Infinity;
    for (const pair of pairs) {
      minimum = Math.min(minimum, pair.actual, pair.prediction);
      maximum = Math.max(maximum, pair.actual, pair.prediction);
    }
    const transform = log ? Math.log10 : (n) => n;
    const inverse = log ? (n) => 10 ** n : (n) => n;
    const low = log ? transform(minimum) : 0;
    const high = transform(maximum);
    const margin = log ? Math.max((high - low) * 0.04, 0.08) : high * 0.04;
    const range = [log ? inverse(low - margin) : 0, inverse(high + margin)];
    const axisUnit = [displayUnit(unit), log ? 'log' : '']
      .filter(Boolean)
      .join(', ');
    const suffix = axisUnit ? ' (' + axisUnit + ')' : '';
    const chart = summaryAxes(
      'Measured versus predicted values, ' +
        (log ? 'logarithmic' : 'linear') +
        ' X and Y axes',
      'Measured' + suffix,
      'Simulated' + suffix,
      range,
      range,
      {log, unit},
      {log, unit},
    );
    referenceLine(chart, range[0], range[0], range[1], range[1]);
    for (const pair of pairs) {
      summaryPoint(
        chart,
        pair.actual,
        pair.prediction,
        colors.get(pair.id).color,
        pairDescription(pair),
      );
    }
    return {hitPoints: chart.points};
  }

  if (spec.kind === 'curve')
    return drawCurve(
      spec.rows,
      spec.curves,
      spec.xLabel,
      spec.unit,
      spec.bounds,
      spec.scales,
    );
  if (spec.kind === 'ranked')
    return rankedErrors(spec.pairs, spec.colors, spec.total, spec.bands);
  if (spec.kind === 'cdf')
    return absoluteErrorCDF(spec.pairs, spec.total, spec.log, spec.bands);
  return comparisonScatter(spec.pairs, spec.unit, spec.colors, spec.log);
}
