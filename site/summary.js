function comparisonPairs(rows, benchmarks) {
  const pairs = [];
  for (const point of rows) {
    const series = Object.entries(benchmarks[point.benchmark].values);
    const hardware = series.filter(([, value]) => value.role === 'hardware_measurement');
    for (const [id, simulated] of series) {
      if (simulated.role !== 'simulator_output') continue;
      const references = hardware.filter(([, value]) => value.unit === simulated.unit);
      if (references.length !== 1) continue;
      const [reference, measured] = references[0];
      const actual = point.values[reference];
      const prediction = point.values[id];
      if (!Number.isFinite(actual) || actual <= 0 || !Number.isFinite(prediction) || prediction <= 0) continue;
      pairs.push({
        actual,
        prediction,
        signedError: 100 * (prediction - actual) / Math.min(prediction, actual),
        unit: simulated.unit,
        id: JSON.stringify([reference, id]),
        name: simulated.name + ' vs. ' + measured.name,
      });
    }
  }
  return pairs.filter(p => Number.isFinite(p.signedError));
}

function summaryAxes(title, xLabel, yLabel, xRange, yRange, xTick, yTick) {
  const canvas = el('canvas', 'curve');
  canvas.width = 640;
  canvas.height = 372;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', title);
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);
  ctx.font = '10px system-ui';
  const left = 51, right = 306, top = 12, bottom = 143;
  const x = value => left + (value - xRange[0]) / (xRange[1] - xRange[0]) * (right - left);
  const y = value => bottom - (value - yRange[0]) / (yRange[1] - yRange[0]) * (bottom - top);
  ctx.fillStyle = '#526a75';
  ctx.strokeStyle = '#e5ecee';
  for (let i = 0; i <= 4; i++) {
    const a = i / 4;
    const px = left + a * (right - left);
    const py = bottom - a * (bottom - top);
    ctx.beginPath();
    ctx.moveTo(px, top);
    ctx.lineTo(px, bottom);
    ctx.moveTo(left, py);
    ctx.lineTo(right, py);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillText(xTick(xRange[0] + a * (xRange[1] - xRange[0])), px, bottom + 13);
    ctx.textAlign = 'right';
    ctx.fillText(yTick(yRange[0] + a * (yRange[1] - yRange[0])), left - 5, py + 3);
  }
  ctx.textAlign = 'center';
  ctx.fillText(xLabel, (left + right) / 2, 179);
  ctx.save();
  ctx.translate(10, (top + bottom) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();
  return {canvas, ctx, x, y};
}

function summaryPoint(chart, x, y, color) {
  chart.ctx.fillStyle = color;
  chart.ctx.beginPath();
  chart.ctx.arc(chart.x(x), chart.y(y), 2.15, 0, 2 * Math.PI);
  chart.ctx.fill();
}

function referenceLine(chart, x0, y0, x1, y1) {
  const {ctx, x, y} = chart;
  ctx.save();
  ctx.strokeStyle = '#69808a';
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(x(x0), y(y0));
  ctx.lineTo(x(x1), y(y1));
  ctx.stroke();
  ctx.restore();
}

function rankedErrors(pairs, colors) {
  const ranked = [...pairs].sort((a, b) => a.signedError - b.signedError);
  const end = Math.max(2, ranked.length);
  const minimum = Math.min(0, ranked[0].signedError);
  const maximum = Math.max(0, ranked[ranked.length - 1].signedError);
  const margin = Math.max(0.2, (maximum - minimum) * 0.06);
  const chart = summaryAxes(
    'S-curve of signed relative error',
    'Case rank', 'Signed error (%)', [1, end], [minimum - margin, maximum + margin],
    n => Math.round(n).toLocaleString(), n => (n > 0 ? '+' : '') + Number(n.toPrecision(2)) + '%'
  );
  referenceLine(chart, 1, 0, end, 0);
  ranked.forEach((pair, i) => summaryPoint(chart, i + 1, pair.signedError, colors.get(pair.id).color));
  return chart.canvas;
}

function absoluteErrorCDF(pairs) {
  const errors = pairs.map(pair => Math.abs(pair.signedError)).sort((a, b) => a - b);
  const smallestPositive = errors.find(x => x > 0);
  const left = smallestPositive === undefined ? -3 : Math.floor(Math.log10(smallestPositive)) - 1;
  const right = smallestPositive === undefined ? 0 : Math.max(left + 1, Math.ceil(Math.log10(errors[errors.length - 1])) + 0.1);
  const chart = summaryAxes(
    'Absolute error cumulative distribution',
    'Absolute error (%) · log', 'Cumulative fraction', [left, right], [0, 1],
    x => x === left ? '0' : (10 ** x).toPrecision(2),
    y => Number(y.toFixed(2)).toString()
  );
  const {ctx, x, y} = chart;
  ctx.strokeStyle = palette[0];
  ctx.lineWidth = 1.7;
  ctx.beginPath();
  ctx.moveTo(x(left), y(0));
  let fraction = 0;
  for (let i = 0; i < errors.length; i++) {
    const px = x(errors[i] === 0 ? left : Math.log10(errors[i]));
    ctx.lineTo(px, y(fraction));
    fraction = (i + 1) / errors.length;
    ctx.lineTo(px, y(fraction));
  }
  ctx.lineTo(x(right), y(1));
  ctx.stroke();
  const nearestRank = p => errors[Math.ceil(p * errors.length) - 1].toPrecision(3) + '%';
  return [
    chart.canvas,
    el('p', 'summary-note', 'P50 ' + nearestRank(0.5) + ' · P90 ' + nearestRank(0.9)),
    el('p', 'summary-note', '|simulated − measured| / min(simulated, measured)')
  ];
}

function comparisonScatter(pairs, unit, colors) {
  const limit = Math.max(...pairs.flatMap(pair => [pair.actual, pair.prediction]));
  const axisUnit = displayUnit(unit);
  const suffix = axisUnit ? ' (' + axisUnit + ')' : '';
  const chart = summaryAxes(
    'Measured versus predicted values',
    'Measured' + suffix, 'Simulated' + suffix, [0, limit * 1.04], [0, limit * 1.04],
    n => formatValue(n, unit), n => formatValue(n, unit)
  );
  referenceLine(chart, 0, 0, limit, limit);
  for (const pair of pairs) summaryPoint(chart, pair.actual, pair.prediction, colors.get(pair.id).color);
  return chart.canvas;
}

function renderSummary(rows, benchmarks) {
  const section = document.querySelector('#summary');
  section.replaceChildren();
  const pairs = comparisonPairs(rows, benchmarks);
  section.hidden = !pairs.length;
  if (!pairs.length) return;
  const colors = new Map();
  for (const pair of pairs) {
    if (!colors.has(pair.id)) {
      colors.set(pair.id, {color: palette[colors.size % palette.length], name: pair.name});
    }
  }

  const legend = el('div', 'legend summary-legend');
  for (const {color, name} of colors.values()) {
    const item = el('span');
    const swatch = el('i', 'key');
    swatch.style.backgroundColor = color;
    item.append(swatch, document.createTextNode(name));
    legend.append(item);
  }
  const charts = el('div', 'charts summary-charts');
  const signed = el('figure', 'card');
  signed.append(el('figcaption', '', 'S-curve'), rankedErrors(pairs, colors),
    el('p', 'summary-note', 'Negative values are underestimates. Positive values are overestimates.'));
  const cdf = el('figure', 'card');
  cdf.append(el('figcaption', '', 'Absolute error distribution (CDF)'), ...absoluteErrorCDF(pairs));
  const scatter = el('figure', 'card');
  scatter.append(el('figcaption', '', 'Measured vs. simulated'));
  for (const [unit, values] of Map.groupBy(pairs, pair => pair.unit)) {
    scatter.append(comparisonScatter(values, unit, colors));
  }
  scatter.append(el('p', 'summary-note', 'Dashed line indicates equal values.'));
  charts.append(signed, cdf, scatter);
  section.append(el('h2', '', 'Accuracy summary'),
    el('p', 'summary-note', pairs.length.toLocaleString() + ' paired measurements'), legend, charts);
}
