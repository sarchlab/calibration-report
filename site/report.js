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
    const marker = el('button', 'plot-status-marker', symbol ?? visibleStates.get(state).symbol);
    marker.dataset.state = state;
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
    });
  }
  return {
    canvas,
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
    const {canvas, xPosition, statusPosition} = drawCurve(rows, curves, xLabel, unit, bounds, scales);
    if (!hasStatuses) {
      figure.replaceChildren(canvas);
      return;
    }
    const surface = el('div', 'plot-surface');
    const {track, detail} = drawStatusMarkers(rows, series, xLabel, xPosition, statusPosition);
    surface.append(canvas, track);
    figure.replaceChildren(surface, detail);
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
