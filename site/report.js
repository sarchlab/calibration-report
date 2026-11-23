const palette = ['#2b7884', '#ad6b19', '#7d54aa', '#a2404b', '#4e782e'];
const roleStyles = new Map([
  ['hardware_measurement', {color: '#b57e14', layer: 0}],
  ['simulator_output', {color: '#16815d', layer: 2}],
]);
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

function formatValue(value, unit) {
  if (!Number.isFinite(value)) return '';
  return unit === 'ns' ? (value / 1e6).toPrecision(4) : value.toPrecision(4);
}

function displayUnit(unit) {
  return unit === 'ns' ? 'ms' : unit;
}

function preferLogScale(values) {
  const sorted = [...new Set(values.filter(Number.isFinite))].sort((a, b) => a - b);
  if (sorted.length < 3 || sorted[0] <= 0) return false;
  const logValues = sorted.map(Math.log10);
  if (logValues.at(-1) - logValues[0] < 1) return false;

  function middleWidth(points) {
    function quantile(fraction) {
      const index = fraction * (points.length - 1);
      const low = Math.floor(index);
      return points[low] + (index - low) * (points[Math.ceil(index)] - points[low]);
    }
    return (quantile(0.75) - quantile(0.25)) / (points.at(-1) - points[0]);
  }
  const linearWidth = middleWidth(sorted);
  const logWidth = middleWidth(logValues);
  return linearWidth < 0.35 && logWidth >= 0.2 && logWidth - linearWidth >= 0.1;
}

function drawCurve(rows, curves, xLabel, unit, bounds, scales) {
  const canvas = el('canvas', 'curve');
  canvas.width = 640;
  canvas.height = 334;
  canvas.setAttribute('role', 'img');
  const xScale = scales.x ? 'logarithmic' : 'linear';
  const yScale = scales.y ? 'logarithmic' : 'linear';
  canvas.setAttribute('aria-label', 'Comparison by ' + xLabel + ', ' + xScale + ' X axis, ' + yScale + ' Y axis');
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);
  const left = 53, right = 305, top = 16, bottom = 132;
  ctx.font = '10px system-ui';
  ctx.fillStyle = '#526a75';
  const transformY = scales.y ? Math.log10 : n => n;
  const inverseY = scales.y ? n => 10 ** n : n => n;
  let min = transformY(bounds.min), max = transformY(bounds.max);
  const span = Math.max(max - min, Math.abs(max) * 0.02, 0.001);
  min -= span * 0.12;
  max += span * 0.12;
  ctx.fillText(displayUnit(unit) + (scales.y ? ' · log' : ''), 4, 9);
  ctx.textAlign = 'right';
  for (let i = 0; i < 4; i++) {
    const fraction = i / 3;
    const y = bottom - (bottom - top) * fraction;
    ctx.strokeStyle = '#e5ecee';
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    ctx.fillText(formatValue(inverseY(min + (max - min) * fraction), unit), left - 5, y + 3);
  }

  const sizes = rows.map(row => row.x);
  const transformX = scales.x ? Math.log10 : n => n;
  const xMin = transformX(sizes[0]), xMax = transformX(sizes[sizes.length - 1]);
  const x = i => xMin === xMax ? (left + right) / 2 :
    left + (transformX(sizes[i]) - xMin) / (xMax - xMin) * (right - left);
  const y = v => bottom - (transformY(v) - min) / (max - min) * (bottom - top);
  ctx.textAlign = 'center';
  let lastLabel = -Infinity;
  sizes.forEach((size, i) => {
    const px = x(i);
    if (i > 0 && i < sizes.length - 1 && (px - lastLabel < 50 || right - px < 50)) return;
    ctx.fillText(size.toLocaleString(), px, bottom + 12);
    lastLabel = px;
  });
  ctx.fillText(xLabel + (scales.x ? ' · log' : ''), (left + right) / 2, 161);

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
  return canvas;
}

function chartWithScales(key, rows, curves, xLabel, unit) {
  const measures = curves.flatMap(curve => rows.map(row => row.values[curve.id])).filter(Number.isFinite);
  const bounds = {min: Math.min(...measures), max: Math.max(...measures)};
  const canLog = {x: rows[0].x > 0, y: bounds.min > 0};
  const preferences = scalePreferences.get(key) ?? {};
  const scales = {
    x: canLog.x && (preferences.x ?? preferLogScale(rows.map(row => row.x))),
    y: canLog.y && (preferences.y ?? preferLogScale(measures)),
  };

  const plot = el('div', 'plot');
  const controls = el('div', 'scale-controls');
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', 'Axis scales');
  let canvas = drawCurve(rows, curves, xLabel, unit, bounds, scales);
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
      const next = drawCurve(rows, curves, xLabel, unit, bounds, scales);
      canvas.replaceWith(next);
      canvas = next;
    });
    controls.append(button);
  }
  plot.append(controls, canvas);
  return plot;
}

function parameterLabel(params, metadata) {
  return Object.entries(params).map(([id, value]) => {
    const unit = metadata[id].unit;
    return displayName(id) + '=' + value + (unit ? ' ' + unit : '');
  }).join(' · ') || 'Default parameters';
}

function plotBenchmark(id, rows, meta, pairs) {
  const card = el('article', 'chart card');
  card.append(el('h2', '', displayName(id)), errorSummary(pairs, 'benchmark-errors'));
  const fixed = Map.groupBy(rows, row => JSON.stringify(Object.entries(row.non_scaling_params).sort()));
  const curves = Object.entries(meta.values).map(([id, info], i) => {
    const style = roleStyles.get(info.role) ?? {color: palette[i % palette.length], layer: 1};
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
      if (!active.length) continue;
      const legend = el('div', 'legend');
      for (const curve of active) {
        const label = el('span');
        const swatch = el('i', 'key');
        swatch.style.backgroundColor = curve.color;
        label.append(swatch, document.createTextNode(curve.name));
        legend.append(label);
      }
      const measured = group.filter(row => active.some(curve => Number.isFinite(row.values[curve.id])));
      const key = JSON.stringify([rows[0].group, id, parameters, unit]);
      const plotPairs = groupPairs.filter(pair => pair.unit === unit);
      section.append(chartWithScales(key, measured, active, xLabel, unit), legend, errorSummary(plotPairs, 'plot-errors'));
    }
    card.append(section);
  }
  return card;
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
  const measured = data.filter(point => Object.values(point.values).some(Number.isFinite));
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
      renderCharts(report, benchmarks, data);
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

refresh();
