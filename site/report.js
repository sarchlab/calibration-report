let chartTheme;
let redrawCharts;

function setupTheme() {
  const preference = document.querySelector('#theme');
  const systemTheme = matchMedia('(prefers-color-scheme: dark)');
  const storageKey = 'calibration-report-theme';
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === 'light' || saved === 'dark') preference.value = saved;
  } catch {
    // A browser can disable storage while still allowing a theme for this page.
  }

  function applyTheme() {
    const root = document.documentElement;
    const theme = preference.value === 'system' ? (systemTheme.matches ? 'dark' : 'light') : preference.value;
    if (root.dataset.theme === theme) return;
    root.dataset.theme = theme;
    const style = getComputedStyle(root);
    const color = name => style.getPropertyValue('--chart-' + name).trim();
    chartTheme = {
      grid: color('grid'),
      label: color('label'),
      reference: color('reference'),
      palette: [1, 2, 3, 4, 5].map(i => color('series-' + i)),
      roles: new Map([
        ['hardware_measurement', {color: color('hardware'), layer: 0}],
        ['simulator_output', {color: color('simulator'), layer: 2}],
      ]),
    };
    redrawCharts?.();
  }

  preference.addEventListener('change', () => {
    try {
      localStorage.setItem(storageKey, preference.value);
    } catch {
      // Apply the selection even when it cannot be saved.
    }
    applyTheme();
  });
  systemTheme.addEventListener('change', applyTheme);
  applyTheme();
}

const scalePreferences = new Map();
let selectedGroup;
let previousCharts;
let pointContext;
let closePointDetails = () => {};
let pointTooltipId = 0;

document.addEventListener('pointerdown', event => {
  if (!event.target.closest('.interactive-plot')) closePointDetails();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closePointDetails();
});

const detailNumber = new Intl.NumberFormat('en-US', {maximumSignificantDigits: 7});
const parameterNumber = new Intl.NumberFormat('en-US', {maximumSignificantDigits: 17});

function pointDescription(point, comparisons = [], extra = {}, selectedSeries) {
  return {point, comparisons, extra, selectedSeries};
}

function pairDescription(pair, extra = {}) {
  return pointDescription(pair.point, [pair], extra);
}

function renderPointDescription({point, comparisons, extra, selectedSeries}) {
  const meta = pointContext.benchmarks[point.benchmark];
  const content = el('div', 'point-content');
  const header = el('div', 'point-header');
  const title = displayName(point.benchmark).replace(/\b(fp\d+|int\d+)\b/gi, word => word.toUpperCase());
  header.append(el('strong', 'point-title', title),
    el('span', 'point-group', pointContext.groups[point.group].name));
  content.append(header);
  const launch = point.non_scaling_params.launch;
  if (launch !== undefined) content.append(el('div', 'point-kernel', String(launch)));

  const measurements = el('dl', 'point-measurements');
  for (const [id, series] of Object.entries(meta.values)) {
    const value = point.values[id];
    const status = point.statuses?.[id];
    if (!(id in point.values) && !status) continue;
    const item = el('div', 'point-measurement');
    item.dataset.role = series.role ?? 'other';
    if (id === selectedSeries) item.classList.add('point-measurement-selected');
    const role = series.role === 'hardware_measurement' ? 'Measured' :
      series.role === 'simulator_output' ? 'Simulated' : 'Value';
    const label = el('dt', 'point-measurement-label', role);
    const source = el('span', 'point-measurement-source', series.name.replace(/ kernel time(?: \(median\))?$/i, ''));
    source.title = series.name;
    label.append(source);
    label.setAttribute('aria-label', role + ': ' + series.name);
    const measure = el('dd', 'point-measurement-value');
    if (Number.isFinite(value)) {
      const converted = series.unit === 'ns' ? value / 1e6 : value;
      measure.append(el('strong', '', detailNumber.format(converted)));
      if (series.unit) measure.append(el('span', 'point-unit', displayUnit(series.unit)));
      measure.title = String(value) + (series.unit ? ' ' + series.unit : '');
    } else {
      measure.classList.add('point-measurement-unavailable');
      measure.textContent = status ? displayName(status.state) : 'Unavailable';
    }
    item.append(label, measure);
    if (status?.reason && !Number.isFinite(value)) item.append(el('dd', 'point-measurement-reason', status.reason));
    measurements.append(item);
  }
  content.append(measurements);

  const metrics = el('div', 'point-metrics');
  for (const pair of comparisons) {
    const row = el('div', 'point-error');
    if (comparisons.length > 1) row.append(el('div', 'point-comparison-name', pair.name));
    const line = el('div', 'point-metric-row');
    const error = pair.signedError;
    const value = (error > 0 ? '+' : error < 0 ? '−' : '') + Math.abs(error).toFixed(2) + '%';
    const direction = error < 0 ? 'Underestimate' : error > 0 ? 'Overestimate' : 'Exact match';
    const result = el('span', 'point-error-result');
    result.append(el('strong', 'point-error-value', value), el('span', 'point-direction', direction));
    line.append(el('span', 'point-metric-label', 'Signed error'), result);
    row.append(line);
    metrics.append(row);
  }
  for (const [label, value] of Object.entries(extra)) {
    const row = el('div', 'point-metric-row');
    row.append(el('span', 'point-metric-label', label), el('strong', 'point-metric-value', value));
    metrics.append(row);
  }
  if (metrics.children.length) content.append(metrics);

  const configuration = el('div', 'point-configuration');
  configuration.append(el('div', 'point-section-label', 'Configuration'));
  const params = el('dl', 'point-parameters');
  for (const [key, value] of Object.entries({[meta.scaling_param]: point.x, ...point.non_scaling_params})) {
    if (key === 'launch' && key !== meta.scaling_param) continue;
    const row = el('div');
    const label = displayName(key).replace(/\b(fmas|mads)\b/gi, word => word.slice(0, -1).toUpperCase() + 's')
      .replace(/ per /g, ' / ').replace(/^num blocks$/, 'Blocks').replace(/^threads/, 'Threads');
    const unit = meta.params[key].unit;
    const formatted = typeof value === 'number' ? parameterNumber.format(value) : String(value);
    row.append(el('dt', '', label.charAt(0).toUpperCase() + label.slice(1)),
      el('dd', '', formatted + (unit ? ' ' + unit : '')));
    params.append(row);
  }
  configuration.append(params);
  content.append(configuration);
  return content;
}

// Hit testing uses CSS pixels, so targets stay usable at any chart size or scale.
function interactivePlot(canvas, points) {
  if (!points.length) return canvas;
  const wrapper = el('div', 'interactive-plot');
  const surface = el('div', 'point-surface');
  const ring = el('span', 'point-highlight');
  ring.hidden = true;
  ring.setAttribute('aria-hidden', 'true');
  const detail = el('div', 'point-detail');
  detail.id = 'point-detail-' + (++pointTooltipId);
  detail.hidden = true;
  const text = el('div', 'point-description');
  text.setAttribute('aria-live', 'polite');
  text.setAttribute('aria-atomic', 'true');
  const controls = el('div', 'point-controls');
  const hint = el('p', 'point-hint', 'Hover or tap a point · Arrow keys browse');
  let selected = -1;
  let pinned = false;
  let clickPointerType;
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-describedby', detail.id);
  canvas.setAttribute('aria-label', canvas.getAttribute('aria-label') +
    '. Interactive data points. Use arrow keys to browse; Escape to close.');

  function hide() {
    detail.hidden = ring.hidden = true;
    wrapper.classList.remove('point-pinned');
    selected = -1;
    pinned = false;
    canvas.style.cursor = '';
  }

  function show(index, pin) {
    if (selected === index && pinned === pin && !detail.hidden) return;
    // Keep this plot's controls visible and focused when browsing its points.
    if (closePointDetails !== hide) closePointDetails();
    closePointDetails = hide;
    selected = index;
    pinned = pin;
    const point = points[index];
    text.replaceChildren(renderPointDescription(point.description));
    counter.textContent = (index + 1) + ' / ' + points.length;
    wrapper.classList.toggle('point-pinned', pin);
    detail.setAttribute('role', pin ? 'group' : 'tooltip');
    detail.setAttribute('aria-label', 'Point details');
    controls.hidden = !pin;
    detail.hidden = ring.hidden = false;
    ring.style.left = (100 * point.x / (canvas.width / 2)) + '%';
    ring.style.top = (100 * point.y / (canvas.height / 2)) + '%';
  }

  function nearest(event, pointerType = event.pointerType) {
    const rect = canvas.getBoundingClientRect();
    const radius = pointerType === 'touch' || pointerType === 'pen' ? 28 : 14;
    let best = -1, distance = radius * radius;
    points.forEach((point, index) => {
      const dx = event.clientX - rect.left - point.x * rect.width / (canvas.width / 2);
      const dy = event.clientY - rect.top - point.y * rect.height / (canvas.height / 2);
      const d = dx * dx + dy * dy;
      if (d < distance) { best = index; distance = d; }
    });
    return best;
  }

  const previous = el('button', '', 'Previous');
  const counter = el('span');
  const next = el('button', '', 'Next');
  const close = el('button', '', 'Close');
  function step(delta) {
    show((selected + delta + points.length) % points.length, true);
  }
  for (const button of [previous, next, close]) button.type = 'button';
  previous.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(1));
  close.addEventListener('click', () => { hide(); canvas.focus({preventScroll: true}); });
  controls.append(previous, counter, next, close);
  detail.append(text, controls);
  surface.append(canvas, ring);
  wrapper.append(surface, detail, hint);
  canvas.addEventListener('pointermove', event => {
    if (event.pointerType !== 'mouse' || pinned) return;
    const index = nearest(event);
    canvas.style.cursor = index < 0 ? '' : 'pointer';
    if (index < 0) hide();
    else show(index, false);
  });
  wrapper.addEventListener('pointerleave', () => { if (!pinned) hide(); });
  // Some touch browsers emit a MouseEvent for click, without pointerType.
  canvas.addEventListener('pointerdown', event => { clickPointerType = event.pointerType; });
  canvas.addEventListener('pointercancel', () => { clickPointerType = undefined; });
  canvas.addEventListener('click', event => {
    const index = nearest(event, event.pointerType || clickPointerType);
    clickPointerType = undefined;
    if (index < 0 || (pinned && index === selected)) hide();
    else show(index, true);
  });
  canvas.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'End') show(points.length - 1, true);
    else if (event.key === 'Home' || selected < 0) show(0, true);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') step(-1);
    else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') step(1);
    else show(selected, true);
  });
  wrapper.addEventListener('focusout', event => {
    // Touch browsers can blur the canvas without focusing the tapped button.
    // Outside taps are handled by pointerdown; a null focus target is ambiguous.
    if (event.relatedTarget && !wrapper.contains(event.relatedTarget)) hide();
  });
  return wrapper;
}

function el(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

function displayName(key) {
  return key.replaceAll('_', ' ');
}

const tickNumber = new Intl.NumberFormat('en-US', {maximumSignificantDigits: 3, useGrouping: false});
const tickPrefixes = new Map([[-12, 'p'], [-9, 'n'], [-6, 'µ'], [-3, 'm'],
  [0, ''], [3, 'k'], [6, 'M'], [9, 'G'], [12, 'T']]);

function formatTick(value) {
  if (Math.abs(value) >= 0.1 && Math.abs(value) < 1) return tickNumber.format(value);
  if (value === 0) return '0';
  let exponent = 3 * Math.floor(Math.log10(Math.abs(value)) / 3);
  let scaled = value / 10 ** exponent;
  if (Math.abs(scaled) >= 999.5) {
    exponent += 3;
    scaled /= 1000;
  }
  const prefix = tickPrefixes.get(exponent);
  return prefix === undefined ? value.toExponential(2) : tickNumber.format(scaled) + prefix;
}

function displayUnit(unit) {
  return unit === 'ns' ? 'ms' : unit;
}

function linearTicks(min, max, count) {
  if (min === max) return [min];
  const rough = (max - min) / (count - 1);
  const power = 10 ** Math.floor(Math.log10(rough));
  if (!power || !Number.isFinite(power)) return [min, max];
  const multiplier = [1, 2, 5, 10].find(n => rough / power <= n * Math.SQRT2);
  const step = power * multiplier;
  const first = Math.ceil(min / step - 1e-10);
  const last = Math.floor(max / step + 1e-10);
  return Array.from({length: Math.max(0, last - first + 1)},
    (_, i) => Number(((first + i) * step).toPrecision(13)));
}

function axisTicks(min, max, count, log) {
  if (!log || min <= 0 || min === max || !Number.isFinite(max)) return linearTicks(min, max, count);
  const low = Math.log10(min), high = Math.log10(max);
  const major = [], minor = [];
  for (let exponent = Math.floor(low); exponent <= Math.floor(high); exponent++) {
    for (const factor of [1, 2, 5]) {
      const tick = factor * 10 ** exponent;
      if (tick >= min * (1 - 1e-12) && tick <= max * (1 + 1e-12)) {
        (factor === 1 ? major : minor).push(tick);
      }
    }
  }
  if (major.length + minor.length < 2) return linearTicks(min, max, count);
  if (major.length + minor.length <= count) return [...major, ...minor].sort((a, b) => a - b);
  if (major.length >= count) {
    const stride = Math.ceil(major.length / count);
    return major.filter((_, i) => i % stride === 0);
  }
  const ticks = [...major];
  for (const tick of minor) {
    if (ticks.length === count) break;
    if (ticks.every(other => Math.abs(Math.log10(tick / other)) >= (high - low) / count)) ticks.push(tick);
  }
  return ticks.sort((a, b) => a - b);
}

function numericAxis([min, max], [start, end], {log = false, unit = '', count = 5, format = formatTick} = {}) {
  log = log && min > 0;
  const transform = log ? Math.log10 : n => n;
  const low = transform(min), high = transform(max);
  const position = value => low === high ? (start + end) / 2 :
    start + (transform(value) - low) / (high - low) * (end - start);
  const divisor = unit === 'ns' ? 1e6 : 1;
  const ticks = axisTicks(min / divisor, max / divisor, count, log).map(value => ({
    label: format(value), position: position(value * divisor)
  }));
  return {position, ticks};
}

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

function drawAxisTitles(ctx, xLabel, yLabel, {left, right, top, bottom}, xBaseline) {
  ctx.textAlign = 'center';
  ctx.fillText(xLabel, (left + right) / 2, xBaseline);
  if (!yLabel) return;
  ctx.save();
  ctx.translate(10, (top + bottom) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();
}

function preferLogScale(values) {
  const sorted = [...new Set(values.filter(Number.isFinite))].sort((a, b) => a - b);
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

const visibleStates = new Map([
  ['failed', {label: 'Failed', symbol: '×'}],
  ['verification_failed', {label: 'Verification failed', symbol: '⚠️'}],
  ['timeout', {label: 'Timed out', symbol: '⏱️'}],
  ['memory_limit', {label: 'Memory limit', symbol: '×'}],
  ['unsupported', {label: 'Unsupported', symbol: '×'}],
  ['running', {label: 'Running', symbol: '▶️'}],
]);

function isMarked(row, id) {
  return !Number.isFinite(row.values[id]) && visibleStates.has(row.statuses?.[id]?.state);
}

function drawStatusMarkers(rows, series, xLabel, xPosition, statusPosition) {
  const track = el('div', 'plot-status-track');
  track.style.top = (100 * statusPosition) + '%';
  track.setAttribute('role', 'group');
  track.setAttribute('aria-label', 'Unavailable results');
  const detail = el('p', 'plot-status-detail');
  detail.setAttribute('aria-live', 'polite');
  detail.hidden = true;
  for (const row of rows) {
    const marked = series.filter(curve => isMarked(row, curve.id));
    if (!marked.length) continue;
    const messages = marked.map(curve => {
      const {state, reason} = row.statuses[curve.id];
      return curve.name + ' · ' + visibleStates.get(state).label + (reason ? ' · ' + reason : '');
    });
    const main = marked.find(curve => row.statuses[curve.id].state !== 'running') ?? marked[0];
    const {state, symbol} = row.statuses[main.id];
    const message = [xLabel + ' = ' + row.x, ...messages].join('\n');
    const glyph = symbol ?? visibleStates.get(state).symbol;
    const marker = el('button', 'plot-status-marker', glyph);
    marker.dataset.state = state;
    marker.toggleAttribute('data-emoji', /\p{Emoji_Presentation}|\uFE0F/u.test(glyph));
    marker.type = 'button';
    marker.style.left = (100 * xPosition(row.x)) + '%';
    marker.title = message;
    marker.setAttribute('aria-label', message);
    marker.addEventListener('click', () => {
      detail.hidden = false;
      detail.textContent = message;
    });
    track.append(marker);
  }
  return {track, detail};
}

function drawCurve(rows, curves, xLabel, unit, bounds, scales) {
  const hitPoints = [];
  const canvas = el('canvas', 'curve');
  canvas.width = 640;
  canvas.height = bounds ? 318 : 70;
  canvas.setAttribute('role', 'img');
  const xScale = scales.x ? 'logarithmic' : 'linear';
  const yScale = scales.y ? 'logarithmic' : 'linear';
  canvas.setAttribute('aria-label', bounds ? 'Comparison by ' + xLabel + ', ' + xScale + ' X axis, ' +
    yScale + ' Y axis' : 'Unavailable results by ' + xLabel);
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);
  const frame = {left: 53, right: 305, top: 8, bottom: bounds ? 124 : 8};
  const {left, right, top, bottom} = frame;
  ctx.font = '10px system-ui';
  ctx.fillStyle = chartTheme.label;
  const xAxis = numericAxis([rows[0].x, rows.at(-1).x], [left, right], {log: scales.x, count: 6});
  let yAxis = {ticks: []};
  let yLabel = '';
  if (bounds) {
    const transformY = scales.y ? Math.log10 : n => n;
    const inverseY = scales.y ? n => 10 ** n : n => n;
    let min = transformY(bounds.min), max = transformY(bounds.max);
    const span = Math.max(max - min, Math.abs(max) * 0.02) || 0.001;
    min -= span * 0.12;
    max += span * 0.12;
    yAxis = numericAxis([inverseY(min), inverseY(max)], [bottom, top], {log: scales.y, unit});
    yLabel = [displayUnit(unit), scales.y ? 'log' : ''].filter(Boolean).join(' · ');
  }
  drawAxisTicks(ctx, xAxis, yAxis, frame);
  drawAxisTitles(ctx, xLabel + (scales.x ? ' · log' : ''), yLabel, frame,
    bottom + (bounds ? 29 : 25));
  const x = index => xAxis.position(rows[index].x);
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
      hitPoints.push({x: x(i), y: y(value), description: pointDescription(row,
        comparisonPairs([row], pointContext.benchmarks).filter(pair => pair.unit === unit), {}, curve.id)});
    });
  }
  return {
    canvas,
    hitPoints,
    xPosition: value => xAxis.position(value) / (canvas.width / 2),
    statusPosition: (bounds ? bottom - 4 : bottom) / (canvas.height / 2),
  };
}

function chartWithScales(key, rows, curves, series, xLabel, unit) {
  const measures = curves.flatMap(curve => rows.map(row => row.values[curve.id])).filter(Number.isFinite);
  const bounds = measures.length ? {min: Math.min(...measures), max: Math.max(...measures)} : null;
  const canLog = {x: rows[0].x > 0, y: bounds !== null && bounds.min > 0};
  const preferences = scalePreferences.get(key) ?? {};
  const scales = {
    x: canLog.x && (preferences.x ?? preferLogScale(rows.map(row => row.x))),
    y: canLog.y && (preferences.y ?? preferLogScale(measures)),
  };

  const plot = el('div', 'plot');
  const controls = el('div', 'scale-controls');
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', 'Axis scales');
  const figure = el('div', 'plot-figure');
  const hasStatuses = rows.some(row => series.some(curve => isMarked(row, curve.id)));
  function redrawPlot() {
    closePointDetails();
    const {canvas, hitPoints, xPosition, statusPosition} = drawCurve(rows, curves, xLabel, unit, bounds, scales);
    const interactive = interactivePlot(canvas, hitPoints);
    if (!hasStatuses) {
      figure.replaceChildren(interactive);
      return;
    }
    const surface = el('div', 'plot-surface');
    const {track, detail} = drawStatusMarkers(rows, series, xLabel, xPosition, statusPosition);
    if (hitPoints.length) {
      interactive.querySelector('.point-surface').append(track);
      figure.replaceChildren(interactive, detail);
    } else {
      surface.append(canvas, track);
      figure.replaceChildren(surface, detail);
    }
  }
  redrawPlot();
  for (const axis of ['x', 'y']) {
    const label = axis.toUpperCase() + ' log';
    const button = el('button', '', label);
    button.type = 'button';
    button.disabled = !canLog[axis];
    button.setAttribute('aria-pressed', String(scales[axis]));
    if (button.disabled) button.title = 'Log scale requires positive ' + axis.toUpperCase() + ' values';
    button.addEventListener('click', () => {
      scales[axis] = !scales[axis];
      preferences[axis] = scales[axis];
      scalePreferences.set(key, preferences);
      button.setAttribute('aria-pressed', String(scales[axis]));
      redrawPlot();
    });
    controls.append(button);
  }
  plot.append(controls, figure);
  return plot;
}

function parameterLabel(params, metadata) {
  return Object.entries(params).map(([id, value]) => {
    const unit = metadata[id].unit;
    return displayName(id) + '=' + value + (unit ? ' ' + unit : '');
  }).join(' · ') || 'Default parameters';
}

function renderStats(entries, pairedCount) {
  if (!entries.length) return document.createDocumentFragment();
  const stats = el('dl', 'stats');
  stats.title = 'Based on ' + pairedCount.toLocaleString() + ' paired measurements';
  for (const [name, value] of entries) {
    const item = el('div');
    item.append(el('dt', '', name), el('dd', '', value));
    stats.append(item);
  }
  return stats;
}

function plotDetails(description, entries, pairedCount) {
  const footer = el('footer', 'plot-details');
  const notes = el('div', 'description');
  notes.append(...description);
  footer.append(notes, renderStats(entries, pairedCount));
  return footer;
}

function plotBenchmark(id, rows, meta, pairs) {
  const card = el('article', 'chart card');
  card.append(el('h2', '', displayName(id)));
  if (pairs.length) {
    const overall = el('div', 'benchmark-error');
    overall.append(el('p', '', 'Benchmark-wide error'), renderStats(errorStats(pairs), pairs.length));
    card.append(overall);
  }
  const fixed = Map.groupBy(rows, row => JSON.stringify(Object.entries(row.non_scaling_params).sort()));
  const curves = Object.entries(meta.values).map(([id, info], i) => {
    const {roles, palette} = chartTheme;
    const style = roles.get(info.role) ?? {color: palette[i % palette.length], layer: 1};
    return {id, ...info, ...style};
  }).sort((a, b) => a.layer - b.layer);
  const units = Map.groupBy(curves, curve => curve.unit);
  const axisUnit = meta.params[meta.scaling_param].unit;
  const xLabel = displayName(meta.scaling_param) + (axisUnit ? ' (' + axisUnit + ')' : '');

  for (const [parameters, group] of fixed) {
    group.sort((a, b) => a.x - b.x);
    const groupPoints = new Set(group);
    const groupPairs = pairs.filter(pair => groupPoints.has(pair.point));
    const section = el('section', 'series');
    section.append(el('h3', '', parameterLabel(group[0].non_scaling_params, meta.params)));
    for (const [unit, comparable] of units) {
      const active = comparable.filter(curve => group.some(row => Number.isFinite(row.values[curve.id])));
      const plotted = group.filter(row => comparable.some(curve =>
        Number.isFinite(row.values[curve.id]) || isMarked(row, curve.id)));
      if (!plotted.length) continue;
      const legend = el('div', 'legend');
      for (const curve of active) {
        const label = el('span');
        const swatch = el('i', 'key');
        swatch.style.backgroundColor = curve.color;
        label.append(swatch, document.createTextNode(curve.name));
        legend.append(label);
      }
      const key = JSON.stringify([rows[0].group, id, parameters, unit]);
      const plotPairs = groupPairs.filter(pair => pair.unit === unit);
      const plot = el('div', 'series-plot');
      plot.append(
        chartWithScales(key, plotted, active, comparable, xLabel, unit),
        plotDetails([legend], errorStats(plotPairs), plotPairs.length)
      );
      section.append(plot);
    }
    card.append(section);
  }
  return card;
}

function liveProgressBar(progress) {
  const remaining = Math.max(0, progress.total - progress.completed - progress.running);
  const failed = progress.unsuccessful ?? Math.max(0, remaining - (progress.queued ?? remaining));
  const pending = progress.queued ?? Math.max(0, remaining - failed);
  const states = [
    ['completed', 'Completed', progress.completed],
    ['running', 'Running', progress.running],
    ['failed', 'Failed', failed],
    ['pending', 'Not started', pending],
  ];
  const container = el('div', 'live-progress');
  const bar = el('div', 'progress-track');
  bar.setAttribute('aria-hidden', 'true');
  const legend = el('ul', 'progress-legend');
  for (const [state, label, count] of states) {
    const segment = el('div', 'progress-segment ' + state);
    segment.style.flexBasis = (progress.total ? 100 * count / progress.total : 0) + '%';
    bar.append(segment);
    const item = el('li', 'progress-count ' + state);
    const swatch = el('i', 'progress-key');
    swatch.setAttribute('aria-hidden', 'true');
    item.append(swatch, el('span', '', label), el('strong', '', count.toLocaleString()));
    if (state === 'failed') item.title = 'Includes timeouts and unavailable configurations';
    legend.append(item);
  }
  const caption = el('div', 'progress-caption');
  caption.append(el('h2', '', 'Run progress'), el('span', '', progress.total.toLocaleString() + ' points'));
  container.append(caption, bar, legend);
  if (progress.started_at) {
    container.append(el('p', 'progress-started', 'Started ' + new Date(progress.started_at).toLocaleString()));
  }
  return container;
}

function renderHeader(report, progress) {
  const title = report.title || 'Calibration report';
  const description = document.querySelector('#description');
  document.title = title;
  document.querySelector('#title').textContent = title;
  description.textContent = report.description ?? '';
  description.hidden = !description.textContent;
  document.querySelector('#live-badge').hidden = report.live !== true;

  const panel = document.querySelector('#progress');
  panel.hidden = !progress;
  if (!progress) return;
  if (report.live === true) {
    panel.replaceChildren(liveProgressBar(progress));
    return;
  }
  const stats = [
    ['Completed', progress.completed.toLocaleString() + ' / ' + progress.total.toLocaleString()],
    ['Running', progress.running.toLocaleString()],
  ];
  if (progress.queued !== undefined) stats.push(['Queued', progress.queued.toLocaleString()]);
  if (progress.unsuccessful !== undefined) {
    stats.push(['Unsuccessful or unavailable', progress.unsuccessful.toLocaleString()]);
  }
  if (progress.started_at) stats.push(['Started', new Date(progress.started_at).toLocaleString()]);
  panel.replaceChildren(...stats.map(([label, value]) => {
    const item = el('div', 'progress-item');
    item.append(el('strong', '', value), el('span', '', label));
    return item;
  }));
}

function renderCharts(report, benchmarks, data) {
  closePointDetails();
  closePointDetails = () => {};
  pointContext = {benchmarks, groups: report.groups};
  const measured = data.filter(point => Object.values(point.values).some(Number.isFinite) ||
    Object.keys(point.statuses ?? {}).some(id => isMarked(point, id)));
  const groups = [...new Set(measured.map(point => point.group))];
  const pairs = comparisonPairs(measured, benchmarks);
  const hasOverview = pairs.length > 0;
  if (!(selectedGroup === null && hasOverview) && !groups.includes(selectedGroup)) {
    selectedGroup = hasOverview ? null : groups[0];
  }

  const tabs = document.querySelector('#groups');
  const views = groups.map(id => ({id, name: report.groups[id].name}));
  if (hasOverview) views.unshift({id: null, name: 'Overview'});
  tabs.hidden = views.length < 2;
  tabs.replaceChildren();
  if (!tabs.hidden) {
    for (const {id, name} of views) {
      const button = el('button', '', name);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(id === selectedGroup));
      button.addEventListener('click', () => {
        selectedGroup = id;
        renderCharts(report, benchmarks, data);
        tabs.querySelector('[aria-pressed="true"]').focus();
      });
      tabs.append(button);
    }
  }

  const groupPairs = selectedGroup === null ? pairs : pairs.filter(pair => pair.group === selectedGroup);
  renderSummary(groupPairs, selectedGroup, report.groups);
  const list = document.querySelector('#charts');
  list.replaceChildren();
  if (selectedGroup === null) return;
  const rows = measured.filter(point => point.group === selectedGroup);
  const byBenchmark = Map.groupBy(rows, row => row.benchmark);
  const pairsByBenchmark = Map.groupBy(groupPairs, pair => pair.point.benchmark);
  list.replaceChildren(...Array.from(byBenchmark, ([id, points]) =>
    plotBenchmark(id, points, benchmarks[id], pairsByBenchmark.get(id) ?? [])));
}

let live = false;

async function refresh() {
  try {
    const response = await fetch('./data.json', {cache: 'no-store'});
    if (!response.ok) throw new Error('Data unavailable');
    const snapshot = await response.json();
    // Older published snapshots remain readable while projects adopt the new schema.
    const report = {...snapshot.report, groups: snapshot.report?.groups ?? snapshot.groups};
    const data = snapshot.data ?? snapshot.points;
    const benchmarks = snapshot.benchmarks;
    renderHeader(report, snapshot.progress);

    const charts = JSON.stringify([report.groups, benchmarks, data]);
    if (charts !== previousCharts) {
      redrawCharts = () => renderCharts(report, benchmarks, data);
      redrawCharts();
      previousCharts = charts;
    }
    live = report.live === true;
    document.querySelector('#stamp').textContent = snapshot.progress?.updated_at
      ? 'Updated ' + new Date(snapshot.progress.updated_at).toLocaleTimeString()
      : '';
  } catch {
    document.querySelector('#stamp').textContent = 'Waiting for report data';
  }
  if (live) setTimeout(refresh, 10000);
}

setupTheme();
refresh();
