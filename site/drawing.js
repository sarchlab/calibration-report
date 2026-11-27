import {
  comparisonPairs,
  displayUnit,
  launchBands,
  preferLogScale,
  pointDescription,
  pairDescription,
  quantile,
} from './model.js';

const percentNumber = new Intl.NumberFormat('en-US', {maximumFractionDigits: 1});
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

function formatTick(value, number = tickNumber) {
  if (Math.abs(value) >= 0.1 && Math.abs(value) < 1)
    return number.format(value);
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
    : number.format(scaled) + prefix;
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

// The S-curve's log-factor scale: a signed error e (%, positive when the
// simulator is slower) is the factor 1 + |e|/100 between simulated and
// measured values, plotted as sign(e)·log10(factor) = log10(sim / hw).
export function logFactor(error) {
  return Math.sign(error) * Math.log10(1 + Math.abs(error) / 100);
}
export function fromLogFactor(position) {
  return Math.sign(position) * (10 ** Math.abs(position) - 1) * 100;
}
// "1×" names only parity; any other error reads as a factor slower or
// faster, with `digits` significant digits.
export function factorLabel(error, digits = 3) {
  if (error === 0) return '1×';
  const number = new Intl.NumberFormat('en-US', {maximumSignificantDigits: digits});
  return number.format(1 + Math.abs(error) / 100) + '× ' + (error > 0 ? 'slower' : 'faster');
}
// Labels for factor ticks, with the fewest digits (from 3) that keep them
// distinct and keep every factor other than parity from reading as 1.
export function factorLabels(errors) {
  let labels;
  for (let digits = 3; digits <= 12; digits++) {
    labels = errors.map((error) => factorLabel(error, digits));
    if (
      new Set(labels).size === labels.length &&
      labels.every((label, i) => errors[i] === 0 || !label.startsWith('1× '))
    )
      break;
  }
  return labels;
}
const FACTOR_STEPS = [1.001, 1.002, 1.005, 1.01, 1.02, 1.05, 1.1, 1.2, 1.5, 2, 3, 5];
// Signed errors at round factors in [min, max]: 1× (exactly 0) first, then powers of
// ten, then other round factors in increasing order on either side, each at
// least an even share of the axis from the ticks already chosen.
export function factorTicks(min, max, count) {
  const low = logFactor(min),
    high = logFactor(max);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return [];
  if (!(high > low)) return [min];
  const gap = (high - low) / (count + 1);
  const chosen = [];
  const add = (position) => {
    if (
      position >= low - 1e-12 &&
      position <= high + 1e-12 &&
      chosen.every((other) => Math.abs(other - position) >= gap)
    )
      chosen.push(position);
  };
  add(0);
  // Powers of ten come next, so a wide axis reads 10×, 100×….
  const decades = [];
  for (let power = 1; power <= Math.max(Math.abs(low), Math.abs(high)); power++)
    decades.push(power);
  for (const factor of [
    ...decades.map((power) => 10 ** power),
    ...FACTOR_STEPS,
    ...decades.flatMap((power) => [2, 5].map((n) => n * 10 ** power)),
  ]) {
    add(Math.log10(factor));
    add(-Math.log10(factor));
  }
  // A narrow view (near parity, or between two round factors) holds few
  // round factors: linear ticks over the error itself then read better.
  // They include 0 (1×) whenever it is in view.
  const errors = chosen.map(fromLogFactor);
  if (errors.length < 3) {
    const linear = linearTicks(min, max, count);
    if (linear.length > errors.length) return linear;
  }
  return errors.sort((a, b) => a - b);
}

// Each axis scale maps data values to the space positions are linear in.
const axisScales = {
  linear: {transform: (n) => n, inverse: (n) => n},
  log: {transform: Math.log10, inverse: (n) => 10 ** n},
  factor: {transform: logFactor, inverse: fromLogFactor},
};

// An axis from data `[min, max]` to positions `[start, end]`. The returned
// `domain`, `range` and `transform`/`inverse` describe it to the zoom math.
function numericAxis(
  [min, max],
  [start, end],
  {
    log = false,
    factor = false,
    unit = '',
    count = 5,
    format = formatTick,
    values: valuesOf,
    subformat,
  } = {},
) {
  // A factor axis labels its ticks together (factorLabels); `format` is unused.
  const scale = factor ? 'factor' : log && min > 0 ? 'log' : 'linear';
  const {transform, inverse} = axisScales[scale];
  const low = transform(min),
    high = transform(max);
  const position = (value) =>
    low === high
      ? (start + end) / 2
      : start + ((transform(value) - low) / (high - low)) * (end - start);
  const divisor = unit === 'ns' ? 1e6 : 1;
  // `valuesOf(min, max, count)` replaces the automatic tick values, and
  // `subformat` adds a second, smaller label line under each tick.
  const values = valuesOf
    ? valuesOf(min, max, count)
    : scale === 'factor'
      ? factorTicks(min, max, count)
      : axisTicks(min / divisor, max / divisor, count, scale === 'log');
  const labels = scale === 'factor' ? factorLabels(values) : values.map((value) => format(value));
  const ticks = values.map((value, i) => ({
    label: labels[i],
    sublabel: subformat?.(value),
    position: position(value * divisor),
  }));
  return {position, ticks, scale, domain: [min, max], range: [start, end], transform, inverse};
}

// Background bands of the summary curves: the comparisons split by measured
// hardware time at these quantiles, one faint unselectable curve per band.
const BAND_QUANTILES = [0.02, 0.25, 0.5, 0.75, 0.98];
const BAND_MINIMUM = 30;
const TIME_UNITS = new Set(['ns', 'us', 'µs', 'ms', 's']);
const BAND_COLORS = ['#4c6fd1', '#3a9bd0', '#36b39b', '#8cbf4d', '#e0a33a', '#d9583b'];

function formatTime(value, unit, number) {
  return unit === 'ns'
    ? formatTick(value / 1e9, number) + 's'
    : formatTick(value, number) + ' ' + unit;
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
  // Interpolated quantiles, so both tail bands hold a sample at the minimum.
  return {unit, values: BAND_QUANTILES.map((q) => quantile(sorted, q))};
}

// Labels for each band, with enough significant digits that distinct
// cutoffs never print the same.
export function bandLabels({unit, cutoffs}) {
  const distinct = (texts) =>
    cutoffs.every(
      (cutoff, i) => i === 0 || cutoff === cutoffs[i - 1] || texts[i] !== texts[i - 1],
    );
  let texts;
  for (let digits = 3; digits <= 9; digits++) {
    const number = new Intl.NumberFormat('en-US', {
      maximumSignificantDigits: digits,
      useGrouping: false,
    });
    texts = cutoffs.map((cutoff) => formatTime(cutoff, unit, number));
    if (distinct(texts)) break;
  }
  // Exact values in the declared unit always tell distinct cutoffs apart.
  if (!distinct(texts)) texts = cutoffs.map((cutoff) => String(cutoff) + ' ' + unit);
  return [
    '< ' + texts[0],
    ...texts.slice(1).map((text, i) => texts[i] + '–' + text),
    '≥ ' + texts.at(-1),
  ];
}

// Which axes a zoom may change, by chart kind: the S-curve keeps its rank
// axis and the CDF its fraction axis.
export const zoomAxes = {
  curve: ['x', 'y'],
  scatter: ['x', 'y'],
  ranked: ['y'],
  cdf: ['x'],
};

const byAbsolute = (list) =>
  [...list].sort((a, b) => Math.abs(a.signedError) - Math.abs(b.signedError));
// The CDF's error axis from `pairs` (its comparisons sorted by absolute
// error, those errors, and the scale): a log axis starts at the decade of
// the smallest nonzero error, where exact matches sit (`left`). The drawing
// and the zoomed full-data selection (site/resample.js) share it.
export function cdfAxis(pairs, preferLog) {
  const sorted = byAbsolute(pairs);
  const errors = sorted.map((pair) => Math.abs(pair.signedError));
  const log = preferLog ?? preferLogScale(errors);
  const smallest = errors.find((error) => error > 0) ?? 1;
  const left = log ? 10 ** Math.floor(Math.log10(smallest)) : 0;
  const maximum = errors.at(-1);
  const padded = log
    ? 10 ** (Math.ceil(Math.log10(Math.max(maximum, smallest))) + 0.1)
    : maximum * 1.04 || 1;
  // Padding an extreme error may overflow: keep the axis at the error.
  const right = Number.isFinite(padded) ? padded : maximum;
  return {sorted, errors, log, left, right};
}

// Drawing is imperative only inside the supplied canvas; React owns every DOM element.
// `view` overrides each axis's data domain ({x: [min, max], y: [min, max]},
// either optional); marks outside it are clipped and not hit-testable.
// `size` ({width, height}) replaces the default layout size, in drawing units
// of `pixelRatio` canvas pixels. Every result gives that size as `width` and
// `height`, its `hitPoints`, and its `axes` for the zoom math.
export function drawChart(
  canvas,
  spec,
  chartTheme,
  benchmarks,
  {view = null, size = null, pixelRatio = 2} = {},
) {
  // Sizes the canvas and returns its scaled drawing context.
  function setup(width, height) {
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    canvas.setAttribute('role', 'img');
    const ctx = canvas.getContext('2d');
    ctx.scale(pixelRatio, pixelRatio);
    return ctx;
  }

  // Marks reach a little past the frame, so edge points stay whole.
  const CLIP = 3;
  function clipTo(ctx, {left, right, top, bottom}) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(left - CLIP, top - CLIP, right - left + 2 * CLIP, bottom - top + 2 * CLIP);
    ctx.clip();
  }
  // Only points centered in the frame itself are selectable.
  const EDGE = 1e-6;
  const inside = ({left, right, top, bottom}, x, y) =>
    x >= left - EDGE && x <= right + EDGE && y >= top - EDGE && y <= bottom + EDGE;

  // Default-sized axes get the default tick counts; larger ones more.
  const tickCount = (length, spacing, minimum) =>
    Math.max(minimum, Math.round(Math.abs(length) / spacing));
  function drawAxisTicks(ctx, x, y, {left, right, top, bottom}) {
    ctx.strokeStyle = chartTheme.grid;
    ctx.fillStyle = chartTheme.label;
    ctx.textAlign = 'center';
    let lastRight = -Infinity;
    let lastLabel;
    for (const {position, label, sublabel} of x.ticks) {
      ctx.beginPath();
      ctx.moveTo(position, top);
      ctx.lineTo(position, bottom);
      ctx.stroke();
      ctx.save();
      ctx.font = '9px system-ui';
      const subWidth = sublabel ? ctx.measureText(sublabel).width : 0;
      ctx.restore();
      const half = Math.max(ctx.measureText(label).width, subWidth) / 2;
      if (label === lastLabel || position - half < lastRight + 6) continue;
      ctx.fillText(label, position, bottom + 13);
      if (sublabel) {
        ctx.save();
        ctx.font = '9px system-ui';
        ctx.globalAlpha = 0.75;
        ctx.fillText(sublabel, position, bottom + 24);
        ctx.restore();
      }
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

  // `xOf` gives a row's X (its x unless a launch-ordinal chart says
  // otherwise; rows are sorted by it); `lineOf`, when given, splits each
  // curve into one line per value, connecting only rows that share it.
  function drawCurve(rows, curves, xLabel, unit, bounds, scales, xOf, lineOf) {
    const hitPoints = [];
    const width = Math.max(320, size?.width ?? 320);
    const height = bounds ? Math.max(159, size?.height ?? 159) : 35;
    const ctx = setup(width, height);
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
    const frame = {left: 53, right: width - 15, top: 8, bottom: bounds ? height - 35 : 8};
    const {left, right, top, bottom} = frame;
    ctx.font = '10px system-ui';
    ctx.fillStyle = chartTheme.label;
    const xAxis = numericAxis(
      view?.x ?? [xOf(rows[0]), xOf(rows.at(-1))],
      [left, right],
      {log: scales.x, count: tickCount(right - left, 42, 6)},
    );
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
      yAxis = numericAxis(view?.y ?? [inverseY(min), inverseY(max)], [bottom, top], {
        log: scales.y,
        unit,
        count: tickCount(bottom - top, 23, 5),
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
    const x = (index) => xAxis.position(xOf(rows[index]));
    const y = yAxis.position;
    clipTo(ctx, frame);

    // Launch-group percentile bands behind every curve, outermost first in
    // the curve's color, so nested levels darken toward the median. A level
    // missing at an X breaks it; an isolated X is a narrow bar.
    if (bounds)
      for (const curve of curves) {
        ctx.save();
        ctx.fillStyle = curve.color;
        ctx.globalAlpha = 0.14;
        launchBands.forEach((_, level) => {
          let run = [];
          const flush = () => {
            if (run.length === 1) {
              const [px, low, high] = run[0];
              ctx.fillRect(px - 2, high, 4, low - high);
            } else if (run.length > 1) {
              ctx.beginPath();
              run.forEach(([px, , high], j) =>
                j ? ctx.lineTo(px, high) : ctx.moveTo(px, high),
              );
              for (let j = run.length - 1; j >= 0; j--)
                ctx.lineTo(run[j][0], run[j][1]);
              ctx.closePath();
              ctx.fill();
            }
            run = [];
          };
          rows.forEach((row, i) => {
            const band = row.launches?.curves[curve.id]?.bands[level];
            if (band) run.push([x(i), y(band[0]), y(band[1])]);
            else flush();
          });
          flush();
        });
        ctx.restore();
      }

    for (const curve of curves) {
      ctx.strokeStyle = ctx.fillStyle = curve.color;
      ctx.lineWidth = 1.65;
      ctx.beginPath();
      const lines = lineOf
        ? Map.groupBy(rows.keys(), (i) => lineOf(rows[i])).values()
        : [rows.keys()];
      for (const line of lines) {
        let drawing = false;
        for (const i of line) {
          const value = rows[i].values[curve.id];
          if (!Number.isFinite(value)) {
            drawing = false;
            continue;
          }
          if (drawing) ctx.lineTo(x(i), y(value));
          else ctx.moveTo(x(i), y(value));
          drawing = true;
        }
      }
      ctx.stroke();
      rows.forEach((row, i) => {
        const value = row.values[curve.id];
        if (!Number.isFinite(value)) return;
        ctx.beginPath();
        ctx.arc(x(i), y(value), 2.6, 0, 2 * Math.PI);
        ctx.fill();
        // A launch-group median is compared only when both medians come
        // from the same paired dispatches.
        const paired = row.launches?.comparisons
          .filter((comparison) => comparison.count > 0)
          .map((comparison) => comparison.id);
        if (!inside(frame, x(i), y(value))) return;
        hitPoints.push({
          x: x(i),
          y: y(value),
          description: pointDescription(
            row,
            comparisonPairs([row], benchmarks).filter(
              (pair) => pair.unit === unit && (!paired || paired.includes(pair.id)),
            ),
            {},
            curve.id,
          ),
        });
      });
    }
    ctx.restore();
    return {
      hitPoints,
      width,
      height,
      axes: {x: xAxis, y: bounds ? yAxis : null},
      // The X of a status marker as a fraction of the width, or null when
      // the view leaves it out.
      xPosition: (value) => {
        const px = xAxis.position(value);
        return px >= left - EDGE && px <= right + EDGE ? px / width : null;
      },
      statusPosition: (bounds ? bottom - 4 : bottom) / height,
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
    const width = Math.max(320, size?.width ?? 320);
    const legend = bands && bandLegendLayout(canvas, bands, width - 14);
    const legendHeight = legend ? 18 + 13 * legend.rows : 0;
    const height = Math.max(186 + legendHeight, size?.height ?? 0);
    const plotHeight = height - legendHeight;
    const ctx = setup(width, height);
    canvas.setAttribute(
      'aria-label',
      legend
        ? title + '. Hardware time bands: ' + legend.labels.join(', ') + '.'
        : title,
    );
    ctx.font = '10px system-ui';
    // A second line of X tick labels takes room from the plot.
    const top = 12,
      bottom = plotHeight - (xOptions.subformat ? 53 : 43);
    const yAxis = numericAxis(view?.y ?? yRange, [bottom, top], {
      count: tickCount(bottom - top, 26, 5),
      ...yOptions,
    });
    // Room for the widest Y tick label beside the rotated axis title.
    const widest = Math.max(0, ...yAxis.ticks.map(({label}) => ctx.measureText(label).width));
    const left = Math.max(51, Math.ceil(widest) + 22);
    const frame = {left, right: width - 14, top, bottom};
    const {maxCount = Infinity, ...xRest} = xOptions;
    const xAxis = numericAxis(view?.x ?? xRange, [left, frame.right], {
      count: Math.min(maxCount, tickCount(frame.right - left, 42, 6)),
      ...xRest,
    });
    const x = xAxis.position;
    const y = yAxis.position;
    drawAxisTicks(ctx, xAxis, yAxis, frame);
    drawAxisTitles(ctx, xLabel, yLabel, frame, plotHeight - 7);
    if (legend) drawBandLegend(ctx, legend, plotHeight + 10);
    clipTo(ctx, frame);
    return {ctx, x, y, frame, points: [], width, height, axes: {x: xAxis, y: yAxis}};
  }

  // The most legend columns (of 3, 2, 1) whose slots fit every label.
  function bandLegendLayout(canvas, bands, width) {
    const ctx = canvas.getContext('2d');
    ctx.font = '9px system-ui';
    const labels = bandLabels(bands).map(
      (label, i) => label + (bands.bands[i].length ? '' : ' (none)'),
    );
    const widest = Math.max(...labels.map((label) => ctx.measureText(label).width));
    const columns = [3, 2, 1].find((n) => 16 + widest + 6 <= width / n) ?? 1;
    return {labels, columns, rows: Math.ceil(labels.length / columns), slot: width / columns};
  }

  function drawBandLegend(ctx, {labels, columns, slot}, top) {
    ctx.save();
    ctx.font = '9px system-ui';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = chartTheme.label;
    ctx.textAlign = 'left';
    ctx.fillText('Hardware time bands (2 / 25 / 50 / 75 / 98th percentile cutoffs)', 12, top);
    labels.forEach((label, i) => {
      const left = 12 + (i % columns) * slot;
      const y = top + 14 + Math.floor(i / columns) * 13;
      ctx.strokeStyle = BAND_COLORS[i];
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(left + 12, y);
      ctx.stroke();
      ctx.fillStyle = chartTheme.label;
      ctx.fillText(label, left + 16, y);
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
      if (!pairs.length) return;
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
    const px = chart.x(x),
      py = chart.y(y);
    chart.ctx.fillStyle = color;
    chart.ctx.beginPath();
    chart.ctx.arc(px, py, 1.5, 0, 2 * Math.PI);
    chart.ctx.fill();
    if (inside(chart.frame, px, py)) chart.points.push({x: px, y: py, description});
  }

  // Ends the clipped plot drawing and gives the chart's result.
  function finish(chart) {
    chart.ctx.restore();
    const {points: hitPoints, width, height, axes} = chart;
    return {hitPoints, width, height, axes};
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

  // The S-curve's rank axis, ticked at percentiles of all `total` cases
  // (rank r is 100·(r − 1)/(total − 1)%), each with its case rank below.
  // A single case has one tick, at its rank 1, labelled 100%.
  function percentileAxis(total) {
    const rankAt = (percent) => 1 + (percent / 100) * (total - 1);
    const percentOf = (rank) => (total > 1 ? (100 * (rank - 1)) / (total - 1) : 100);
    return {
      // Quartiles, or 5% steps (which keep them) when the axis has room.
      values: (min, max, count) => {
        if (total <= 1) return [1];
        const step = 100 / 5 + 1 <= count ? 5 : 25;
        return Array.from({length: 100 / step + 1}, (_, i) => rankAt(i * step));
      },
      format: (rank) => percentNumber.format(percentOf(rank)) + '%',
      subformat: (rank) => Math.round(rank).toLocaleString('en-US'),
    };
  }

  // A sampled chart's pairs carry their `rank` among `total` comparisons.
  // With `factor`, the error axis is the signed log factor (sim / hw).
  // `shown` (default `pairs`) are the points drawn; axes and bands always
  // come from `pairs`, so a denser zoomed sample magnifies the same chart.
  function rankedErrors(pairs, colors, total = pairs.length, bandSource = pairs, factor = false, shown = pairs) {
    const ranked = [...pairs].sort((a, b) => a.signedError - b.signedError);
    const end = Math.max(2, total);
    // Margins are a share of the axis in its own (transformed) space.
    const {transform, inverse} = axisScales[factor ? 'factor' : 'linear'];
    const minimum = transform(Math.min(0, ranked[0].signedError));
    const maximum = transform(Math.max(0, ranked[ranked.length - 1].signedError));
    const margin = Math.max(factor ? 0.001 : 0.2, (maximum - minimum) * 0.06);
    const bands = timeBands(pairs, bandSource);
    const chart = summaryAxes(
      'S-curve of signed relative error' + (factor ? ', log-factor Y axis' : ''),
      'Percentile of cases (case count below)',
      factor ? 'Sim / hardware (log)' : 'Signed error (%)',
      [1, end],
      // An extreme log factor's padded end may overflow: keep it unpadded.
      [inverse(minimum - margin), inverse(maximum + margin)].map((end, i) =>
        Number.isFinite(end) ? end : inverse(i ? maximum : minimum),
      ),
      // Ticks count real cases; `end` only pads a single case's axis.
      percentileAxis(total),
      factor
        ? {factor: true}
        : {format: (n) => (n > 0 ? '+' : '') + formatTick(n) + '%'},
      bands,
    );
    referenceLine(chart, 1, 0, end, 0);
    // Each band spans the whole rank axis: its own rank, scaled to the run's.
    if (bands)
      drawBandCurves(chart, bands, (band) =>
        [...band]
          .sort((a, b) => a.signedError - b.signedError)
          // A single comparison spans the whole rank axis as a flat line.
          .flatMap((pair, j, all) =>
            (all.length === 1 ? [0, 1] : [j / (all.length - 1)]).map((share) => [
              chart.x(1 + (end - 1) * share),
              chart.y(pair.signedError),
            ]),
          ),
      );
    (shown === pairs ? ranked : [...shown].sort((a, b) => a.signedError - b.signedError)).forEach((pair, i) => {
      const rank = pair.rank ?? i + 1;
      summaryPoint(
        chart,
        rank,
        pair.signedError,
        colors.get(pair.id).color,
        pairDescription(pair, {'Case rank': rank.toLocaleString('en-US')}),
      );
    });
    return finish(chart);
  }

  function absoluteErrorCDF(pairs, total = pairs.length, preferLog, bandSource = pairs, shown = pairs) {
    const {sorted, errors, log, left, right} = cdfAxis(pairs, preferLog);
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
    const ranked = shown === pairs ? sorted : byAbsolute(shown);
    for (let i = 0; i < ranked.length; i++) {
      const error = Math.abs(ranked[i].signedError);
      const px = x(Math.max(left, error));
      ctx.lineTo(px, y(fraction));
      fraction = (ranked[i].rank ?? i + 1) / total;
      ctx.lineTo(px, y(fraction));
      if (!inside(chart.frame, px, y(fraction))) continue;
      chart.points.push({
        x: px,
        y: y(fraction),
        description: pairDescription(ranked[i], {
          'Absolute error': error.toFixed(2) + '%',
          'CDF percentile': (fraction * 100).toFixed(2) + '%',
        }),
      });
    }
    ctx.lineTo(x(right), y(1));
    ctx.stroke();
    return finish(chart);
  }

  function comparisonScatter(pairs, unit, colors, log, shown = pairs) {
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
    for (const pair of shown) {
      summaryPoint(
        chart,
        pair.actual,
        pair.prediction,
        colors.get(pair.id).color,
        pairDescription(pair),
      );
    }
    return finish(chart);
  }

  if (spec.kind === 'curve')
    return drawCurve(
      spec.rows,
      spec.curves,
      spec.xLabel,
      spec.unit,
      spec.bounds,
      spec.scales,
      spec.xOf ?? ((row) => row.x),
      spec.lineOf,
    );
  if (spec.kind === 'ranked')
    return rankedErrors(spec.pairs, spec.colors, spec.total, spec.bands, spec.factor, spec.shown);
  if (spec.kind === 'cdf')
    return absoluteErrorCDF(spec.pairs, spec.total, spec.log, spec.bands, spec.shown);
  return comparisonScatter(spec.pairs, spec.unit, spec.colors, spec.log, spec.shown);
}
