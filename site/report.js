const palette = ['#2b7884', '#ad6b19', '#7d54aa', '#a2404b', '#4e782e'];
const scalePreferences = new Map();
let selectedGroup;

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
    x: canLog.x && (preferences.x ?? false),
    y: canLog.y && (preferences.y ?? bounds.max / bounds.min >= 10),
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

function plotBenchmark(id, rows, meta) {
  const card = el('article', 'chart card');
  card.append(el('h2', '', displayName(id)));
  const fixed = Map.groupBy(rows, row => JSON.stringify(Object.entries(row.non_scaling_params).sort()));
  const curves = Object.entries(meta.values).map(([id, info], i) => ({
    id, ...info, color: palette[i % palette.length]
  }));
  const units = Map.groupBy(curves, curve => curve.unit);
  const axisUnit = meta.params[meta.scaling_param].unit;
  const xLabel = displayName(meta.scaling_param) + (axisUnit ? ' (' + axisUnit + ')' : '');

  for (const [parameters, group] of fixed) {
    group.sort((a, b) => a.x - b.x);
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
      section.append(chartWithScales(key, measured, active, xLabel, unit), legend);
    }
    card.append(section);
  }
  return card;
}

function render(data) {
  const measured = data.points.filter(point => Object.values(point.values).some(Number.isFinite));
  const groups = [...new Set(measured.map(point => point.group))];
  if (!groups.includes(selectedGroup)) selectedGroup = groups[0];
  const groupName = data.groups[selectedGroup]?.name;
  document.querySelector('#title').textContent = groupName ? groupName + ' calibration' : 'Calibration report';
  const tabs = document.querySelector('#groups');
  tabs.hidden = groups.length < 2;
  tabs.replaceChildren();
  if (groups.length > 1) {
    for (const id of groups) {
      const button = el('button', '', data.groups[id].name);
      button.setAttribute('aria-pressed', String(id === selectedGroup));
      button.addEventListener('click', () => {
        selectedGroup = id;
        render(data);
        tabs.querySelector('[aria-pressed="true"]').focus();
      });
      tabs.append(button);
    }
  }

  const rows = measured.filter(point => point.group === selectedGroup);
  renderSummary(rows, data.benchmarks);
  const list = document.querySelector('#charts');
  const byBenchmark = Map.groupBy(rows, row => row.benchmark);
  list.replaceChildren(...Array.from(byBenchmark, ([id, points]) => plotBenchmark(id, points, data.benchmarks[id])));
}

async function refresh() {
  try {
    const dataResponse = await fetch('./data.json', {cache: 'no-store'});
    if (!dataResponse.ok) throw new Error('Data unavailable');
    render(await dataResponse.json());
    document.querySelector('#stamp').textContent = '';
  } catch {
    document.querySelector('#stamp').textContent = 'Waiting for report data';
  }
  setTimeout(refresh, 24000);
}

refresh();
