const palette = ['#2b7884', '#ad6b19', '#7d54aa', '#a2404b', '#4e782e'];
const statusLabels = {
  queued: 'Queued', running: 'Running', complete: 'Passed', failed: 'Failed',
  timeout: 'Timed out', skipped: 'Skipped', unsupported: 'Unsupported', memory_limit: 'RAM limit'
};
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
  if (!Number.isFinite(value)) return '—';
  return unit === 'ns' ? (value / 1e6).toPrecision(4) : value.toPrecision(4);
}

function displayUnit(unit) {
  return unit === 'ns' ? 'ms' : unit;
}

function drawCurve(rows, curves, xLabel, unit) {
  const canvas = el('canvas', 'curve');
  canvas.width = 640;
  canvas.height = 334;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Comparison by ' + xLabel);
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);
  const left = 53, right = 305, top = 16, bottom = 132;
  const measures = curves.flatMap(curve => rows.map(row => row.values[curve.id])).filter(Number.isFinite);
  ctx.font = '10px system-ui';
  ctx.fillStyle = '#526a75';
  if (!measures.length) {
    ctx.fillText('No measurements yet', left, 60);
    return canvas;
  }
  const smallest = Math.min(...measures);
  const largest = Math.max(...measures);
  const log = smallest > 0 && largest / smallest >= 10;
  const transform = log ? Math.log10 : n => n;
  const inverse = log ? n => 10 ** n : n => n;
  let min = transform(smallest), max = transform(largest);
  const span = Math.max(max - min, Math.abs(max) * 0.02, 0.001);
  min -= span * 0.12;
  max += span * 0.12;
  ctx.fillText(displayUnit(unit) + (log ? ' · log' : ''), 4, 9);
  ctx.textAlign = 'right';
  for (let i = 0; i < 4; i++) {
    const fraction = i / 3;
    const y = bottom - (bottom - top) * fraction;
    ctx.strokeStyle = '#e5ecee';
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    ctx.fillText(formatValue(inverse(min + (max - min) * fraction), unit), left - 5, y + 3);
  }

  const sizes = rows.map(row => row.x);
  const xMin = sizes[0], xMax = sizes[sizes.length - 1];
  const x = i => xMin === xMax ? (left + right) / 2 : left + (sizes[i] - xMin) / (xMax - xMin) * (right - left);
  const y = v => bottom - (transform(v) - min) / (max - min) * (bottom - top);
  ctx.textAlign = 'center';
  let lastLabel = -Infinity;
  sizes.forEach((size, i) => {
    const px = x(i);
    if (i > 0 && i < sizes.length - 1 && (px - lastLabel < 50 || right - px < 50)) return;
    ctx.fillText(size.toLocaleString(), px, bottom + 12);
    lastLabel = px;
  });
  ctx.fillText(xLabel, (left + right) / 2, 161);

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

function dataTable(rows, curves, xLabel) {
  const wrapper = el('div', 'clip');
  const table = el('table');
  const hasStatus = rows.some(row => row.progress);
  const head = table.createTHead().insertRow();
  head.append(el('th', '', xLabel));
  for (const curve of curves) {
    const unit = displayUnit(curve.unit);
    head.append(el('th', '', curve.name + (unit ? ' (' + unit + ')' : '')));
  }
  if (hasStatus) head.append(el('th', 'state', 'State'));
  const body = table.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    tr.insertCell().textContent = row.x.toLocaleString();
    for (const curve of curves) tr.insertCell().textContent = formatValue(row.values[curve.id], curve.unit);
    if (hasStatus) {
      const cell = tr.insertCell();
      cell.className = 'state';
      if (row.progress) {
        const {case: number, state, worker, error} = row.progress;
        cell.append(el('span', 'badge ' + state, statusLabels[state] ?? state));
        tr.title = ['Case ' + number, worker, error].filter(Boolean).join(' · ');
      }
    }
  }
  wrapper.append(table);
  return wrapper;
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

  for (const group of fixed.values()) {
    group.sort((a, b) => a.x - b.x);
    const section = el('section', 'series');
    section.append(el('h3', '', parameterLabel(group[0].non_scaling_params, meta.params)));
    for (const [unit, comparable] of units) {
      const active = comparable.filter(curve => group.some(row => Object.hasOwn(row.values, curve.id)));
      if (!active.length) continue;
      const legend = el('div', 'legend');
      for (const curve of active) {
        const label = el('span');
        const swatch = el('i', 'key');
        swatch.style.backgroundColor = curve.color;
        label.append(swatch, document.createTextNode(curve.name));
        legend.append(label);
      }
      section.append(drawCurve(group, active, xLabel, unit), legend, dataTable(group, active, xLabel));
    }
    card.append(section);
  }
  return card;
}

function renderProgress(rows, progress) {
  const section = document.querySelector('#live');
  section.hidden = !progress;
  const stamp = document.querySelector('#stamp');
  if (!progress) {
    stamp.textContent = '';
    return;
  }
  const counts = {};
  for (const row of rows) {
    const status = row.progress?.state;
    counts[status] = (counts[status] ?? 0) + 1;
  }
  const completed = counts.complete ?? 0;
  const running = counts.running ?? 0;
  const queued = counts.queued ?? 0;
  const stopped = rows.length - completed - running - queued;
  const stats = document.querySelector('#stats');
  stats.replaceChildren();
  for (const [name, number] of [
    ['Verified', completed + ' / ' + rows.length],
    ['Running', running], ['Queued', queued], ['Failed, timed out or unavailable', stopped],
  ]) {
    const card = el('div', 'card');
    card.append(el('small', '', name), el('strong', 'big', number));
    stats.append(card);
  }
  const bar = document.querySelector('#progress');
  bar.max = Math.max(rows.length, 1);
  bar.value = completed + stopped;
  stamp.textContent = 'Updated ' + new Date(progress.updated_at * 1000).toLocaleTimeString();
}

function render(data, progress) {
  const groups = Object.keys(data.groups);
  if (!groups.includes(selectedGroup)) selectedGroup = groups[0];
  document.querySelector('#title').textContent = data.groups[selectedGroup].name + ' calibration';
  const tabs = document.querySelector('#groups');
  tabs.hidden = groups.length < 2;
  tabs.replaceChildren();
  if (groups.length > 1) {
    for (const id of groups) {
      const button = el('button', '', data.groups[id].name);
      button.setAttribute('aria-pressed', String(id === selectedGroup));
      button.addEventListener('click', () => {
        selectedGroup = id;
        render(data, progress);
        tabs.querySelector('[aria-pressed="true"]').focus();
      });
      tabs.append(button);
    }
  }

  const rows = data.points.map((point, i) => ({...point, progress: progress?.points[i]}))
    .filter(point => point.group === selectedGroup);
  renderProgress(rows, progress);
  const list = document.querySelector('#charts');
  const byBenchmark = Map.groupBy(rows, row => row.benchmark);
  list.replaceChildren(...Array.from(byBenchmark, ([id, points]) => plotBenchmark(id, points, data.benchmarks[id])));
  if (!rows.length) list.append(el('p', 'muted', 'No points for this group.'));
}

async function refresh() {
  try {
    const dataResponse = await fetch('./data.json', {cache: 'no-store'});
    if (!dataResponse.ok) throw new Error('Data unavailable');
    const data = await dataResponse.json();
    let progress = null;
    if (dataResponse.headers.get('X-Calibration-Live') === 'true') {
      try {
        const status = await fetch('./progress.json', {cache: 'no-store'});
        if (status.ok) {
          const candidate = await status.json();
          if (candidate.points.length === data.points.length) progress = candidate;
        }
      } catch {
        // A static snapshot remains usable while the live progress feed reconnects.
      }
    }
    render(data, progress);
  } catch {
    document.querySelector('#stamp').textContent = 'Waiting for report data';
  }
  setTimeout(refresh, 24000);
}

refresh();
