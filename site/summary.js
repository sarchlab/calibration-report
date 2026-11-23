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
        point,
        group: point.group,
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

function errorSummary(pairs, className = '') {
  if (!pairs.length) return document.createDocumentFragment();
  const errors = pairs.map(pair => Math.abs(pair.signedError));
  const mean = errors.reduce((total, error) => total + error, 0) / errors.length;
  const max = Math.max(...errors);
  const stats = el('dl', 'error-summary ' + className);
  stats.title = 'Based on ' + errors.length.toLocaleString() + ' paired measurements';
  for (const [label, value] of [['Average error', mean], ['Max error', max]]) {
    const item = el('div');
    item.append(el('dt', '', label), el('dd', '', value.toFixed(2) + '%'));
    stats.append(item);
  }
  return stats;
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
  const log = preferLogScale(errors);
  const transform = log ? Math.log10 : n => n;
  const inverse = log ? n => 10 ** n : n => n;
  const left = log ? Math.floor(transform(errors[0])) : 0;
  const maximum = transform(errors.at(-1));
  const right = log ? Math.ceil(maximum) + 0.1 : maximum * 1.04 || 1;
  const chart = summaryAxes(
    'Absolute error cumulative distribution',
    'Absolute error (%)' + (log ? ' · log' : ''), 'Cumulative fraction', [left, right], [0, 1],
    x => inverse(x).toPrecision(2),
    y => Number(y.toFixed(2)).toString()
  );
  const {ctx, x, y} = chart;
  ctx.strokeStyle = palette[0];
  ctx.lineWidth = 1.7;
  ctx.beginPath();
  ctx.moveTo(x(left), y(0));
  let fraction = 0;
  for (let i = 0; i < errors.length; i++) {
    const px = x(transform(errors[i]));
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

const scatterLogPreferences = new Map();

function averageRanks(values) {
  const ordered = values.map((value, index) => ({value, index})).sort((a, b) => a.value - b.value);
  const ranks = [];
  for (let start = 0; start < ordered.length;) {
    let end = start + 1;
    while (end < ordered.length && ordered[end].value === ordered[start].value) end++;
    const rank = (start + end + 1) / 2;
    for (let i = start; i < end; i++) ranks[ordered[i].index] = rank;
    start = end;
  }
  return ranks;
}

function rankStatistics(pairs) {
  let concordant = 0, discordant = 0, measuredUnequal = 0, simulatedUnequal = 0;
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
  const measuredRanks = averageRanks(pairs.map(pair => pair.actual));
  const simulatedRanks = averageRanks(pairs.map(pair => pair.prediction));
  const mean = (pairs.length + 1) / 2;
  let covariance = 0, measuredVariance = 0, simulatedVariance = 0;
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

function rankingDescription(pairs) {
  const stats = rankStatistics(pairs);
  const description = el('div', 'rank-stats');
  const probability = stats.measuredUnequal
    ? (100 * stats.concordant / stats.measuredUnequal).toFixed(2) + '% (' +
      stats.concordant.toLocaleString() + '/' + stats.measuredUnequal.toLocaleString() + ')'
    : '—';
  for (const [label, value] of [
    ['Kendall’s τ-b', stats.tau?.toFixed(4) ?? '—'],
    ['Pairwise ordering accuracy', probability],
    ['Spearman’s ρ', stats.rho?.toFixed(4) ?? '—'],
  ]) {
    const item = el('p', 'summary-note');
    item.append(el('strong', '', label), document.createTextNode(' ' + value));
    description.append(item);
  }
  description.append(el('p', 'summary-note', 'Pairwise accuracy uses pairs with distinct measured values.'));
  return description;
}

function comparisonScatter(pairs, unit, colors, log) {
  const values = pairs.flatMap(pair => [pair.actual, pair.prediction]);
  const transform = log ? Math.log10 : n => n;
  const inverse = log ? n => 10 ** n : n => n;
  const low = log ? transform(Math.min(...values)) : 0;
  const high = transform(Math.max(...values));
  const margin = log ? Math.max((high - low) * 0.04, 0.08) : high * 0.04;
  const range = [log ? low - margin : 0, high + margin];
  const axisUnit = [displayUnit(unit), log ? 'log' : ''].filter(Boolean).join(', ');
  const suffix = axisUnit ? ' (' + axisUnit + ')' : '';
  const tick = n => formatValue(inverse(n), unit);
  const chart = summaryAxes(
    'Measured versus predicted values, ' + (log ? 'logarithmic' : 'linear') + ' X and Y axes',
    'Measured' + suffix, 'Simulated' + suffix, range, range, tick, tick
  );
  referenceLine(chart, range[0], range[0], range[1], range[1]);
  for (const pair of pairs) {
    summaryPoint(chart, transform(pair.actual), transform(pair.prediction), colors.get(pair.id).color);
  }
  return chart.canvas;
}

function scatterWithScale(key, pairs, unit, colors) {
  const plot = el('div', 'plot');
  const controls = el('div', 'scale-controls');
  const button = el('button', '', 'X/Y log');
  button.type = 'button';
  let log = scatterLogPreferences.get(key) ?? preferLogScale(pairs.flatMap(pair => [pair.actual, pair.prediction]));
  button.setAttribute('aria-pressed', String(log));
  let canvas = comparisonScatter(pairs, unit, colors, log);
  button.addEventListener('click', () => {
    log = !log;
    scatterLogPreferences.set(key, log);
    button.setAttribute('aria-pressed', String(log));
    const next = comparisonScatter(pairs, unit, colors, log);
    canvas.replaceWith(next);
    canvas = next;
  });
  controls.append(button);
  plot.append(controls, canvas, rankingDescription(pairs));
  return plot;
}

function renderSummary(pairs, scope, groups) {
  const section = document.querySelector('#summary');
  section.replaceChildren();
  section.hidden = !pairs.length;
  if (!pairs.length) return;
  if (scope === null && new Set(pairs.map(pair => pair.group)).size > 1) {
    pairs = pairs.map(pair => ({
      ...pair,
      id: JSON.stringify([pair.group, pair.id]),
      name: groups[pair.group].name + ' · ' + pair.name,
    }));
  }

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
    errorSummary(pairs), el('p', 'summary-note', 'Negative values are underestimates. Positive values are overestimates.'));
  const cdf = el('figure', 'card');
  cdf.append(el('figcaption', '', 'Absolute error distribution (CDF)'), ...absoluteErrorCDF(pairs), errorSummary(pairs));
  const scatter = el('figure', 'card');
  scatter.append(el('figcaption', '', 'Measured vs. simulated'));
  for (const [unit, values] of Map.groupBy(pairs, pair => pair.unit)) {
    const key = JSON.stringify([scope, unit]);
    scatter.append(scatterWithScale(key, values, unit, colors), errorSummary(values));
  }
  scatter.append(el('p', 'summary-note', 'Dashed line indicates equal values.'));
  charts.append(signed, cdf, scatter);
  const heading = scope === null ? 'Overview · Accuracy summary' : groups[scope].name + ' accuracy summary';
  section.append(el('h2', '', heading),
    el('p', 'summary-note', pairs.length.toLocaleString() + ' paired measurements'), legend, charts);
}
