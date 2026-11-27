// Full-resolution summary charts for the hosted overlay (README, "Expanded
// charts"): every comparison of a scope from the /pairs pages, and the
// comparisons to draw in a zoomed view, at most the summary's per-chart
// limit. Selection is stable: each comparison has a fixed priority per chart
// and a view draws the highest-priority comparisons inside it, so panning
// keeps the points that stay in view and zooming in only adds points.
import {sampleDecoder, signedError} from './model.js';

// Reverses the 32 bits of n. Ranks by ascending bit reversal form the van der
// Corput order: every prefix of it is spread evenly over any rank interval.
function bitReverse(n) {
  n = ((n >>> 1) & 0x55555555) | ((n & 0x55555555) << 1);
  n = ((n >>> 2) & 0x33333333) | ((n & 0x33333333) << 2);
  n = ((n >>> 4) & 0x0f0f0f0f) | ((n & 0x0f0f0f0f) << 4);
  n = ((n >>> 8) & 0x00ff00ff) | ((n & 0x00ff00ff) << 8);
  return ((n >>> 16) | (n << 16)) >>> 0;
}

// A deterministic pseudo-random sequence (mulberry32).
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Indices 0..n-1 sorted by `key` (ties by index, so the order matches a
// stable sort of the comparisons in /pairs order, as the server samples).
function sortedBy(n, key) {
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  return order.sort((a, b) => key[a] - key[b] || a - b);
}

// The full chart data of a scope from its /pairs pages: comparisons are
// decoded only when drawn. `scurve` and `cdf` order comparisons by signed
// and absolute error (a comparison's rank is its position + 1), and
// `scatter` maps each unit to its comparisons in priority order.
export function fullCharts(pages) {
  const decoders = pages.map(sampleDecoder);
  const count = pages.reduce((sum, page) => sum + page.samples.plot.length, 0);
  const page = new Uint32Array(count);
  const local = new Uint32Array(count);
  const actual = new Float64Array(count);
  const prediction = new Float64Array(count);
  const error = new Float64Array(count);
  const absolute = new Float64Array(count);
  const unitOf = [];
  let i = 0;
  pages.forEach(({samples}, p) => {
    const {legend} = decoders[p];
    for (let j = 0; j < samples.plot.length; j++, i++) {
      page[i] = p;
      local[i] = j;
      actual[i] = samples.actual[j];
      prediction[i] = samples.prediction[j];
      error[i] = signedError(actual[i], prediction[i]);
      absolute[i] = Math.abs(error[i]);
      unitOf.push(legend[samples.pair[j]].unit);
    }
  });
  const units = new Map();
  for (let i = 0; i < count; i++) {
    if (!units.has(unitOf[i])) units.set(unitOf[i], []);
    units.get(unitOf[i]).push(i);
  }
  const scatter = new Map();
  for (const [unit, indices] of units) scatter.set(unit, scatterOrder(indices, actual, prediction, absolute));
  return {
    revision: pages[0].revision,
    count,
    actual,
    prediction,
    error,
    absolute,
    scurve: sortedBy(count, error),
    cdf: sortedBy(count, absolute),
    scatter,
    pair: (index) => decoders[page[index]].pair(local[index]),
  };
}

// A unit's comparisons in scatter priority: the extremes of measured and
// simulated values, then, alternately, one of the largest absolute errors
// and two in a fixed pseudo-random order. Any view's first comparisons are
// thus its largest errors mixed with an even spread, as the server sample.
function scatterOrder(indices, actual, prediction, absolute) {
  const order = [];
  const taken = new Set();
  const take = (index) => {
    if (taken.has(index)) return;
    taken.add(index);
    order.push(index);
  };
  for (const values of [actual, prediction]) {
    let low = indices[0],
      high = indices[0];
    for (const index of indices) {
      if (values[index] < values[low]) low = index;
      if (values[index] > values[high]) high = index;
    }
    take(low);
    take(high);
  }
  const largest = [...indices].sort((a, b) => absolute[b] - absolute[a] || a - b);
  const shuffled = [...indices];
  const next = random(0x5eed);
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  for (let a = 0, b = 0; order.length < indices.length; ) {
    while (a < largest.length && taken.has(largest[a])) a++;
    if (a < largest.length) take(largest[a]);
    for (let k = 0; k < 2; k++) {
      while (b < shuffled.length && taken.has(shuffled[b])) b++;
      if (b < shuffled.length) take(shuffled[b]);
    }
  }
  return Uint32Array.from(order);
}

// First position in `order` whose value (`key` of the index there) is not
// below `value`.
function lowerBound(order, key, value) {
  let low = 0,
    high = order.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (key[order[middle]] < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

// Positions of `order` (ascending by `key`) to draw for the view range
// [min, max] of `key`, at most `limit`: the highest-priority positions in
// range, priority being the bit reversal of the position (so a view draws
// evenly spread ranks), plus the first and last positions overall, and the
// nearest position outside each end of the range, so a line enters and
// leaves the view where it would at full resolution. A `limit` below 5
// draws only those.
function rankWindow(order, key, [min, max], limit) {
  const n = order.length;
  if (!n) return [];
  const start = lowerBound(order, key, min);
  let end = lowerBound(order, key, max);
  while (end < n && key[order[end]] === max) end++;
  const picked = new Set([0, n - 1]);
  if (start > 0) picked.add(start - 1);
  if (end < n) picked.add(end);
  // The same budget in every view, so a narrower range only adds positions.
  const budget = limit - 4;
  if (budget <= 0) return [...picked].sort((a, b) => a - b);
  // Only multiples of the largest power of two leaving at least `budget`
  // candidates can be among the top `budget` priorities.
  let step = 1;
  while (step * 2 <= (end - start) / budget) step *= 2;
  const candidates = [];
  for (let position = Math.ceil(start / step) * step; position < end; position += step)
    candidates.push(position);
  candidates.sort((a, b) => bitReverse(a) - bitReverse(b));
  for (const position of candidates.slice(0, budget)) picked.add(position);
  return [...picked].sort((a, b) => a - b);
}

const everything = [-Infinity, Infinity];

// The S-curve comparisons for a view (zoomed in signed error), each with
// its global `rank`.
export function visibleRanked(full, view, limit) {
  return rankWindow(full.scurve, full.error, view?.y ?? everything, limit).map(
    (position) => ({...full.pair(full.scurve[position]), rank: position + 1}),
  );
}

// The CDF comparisons for a view (zoomed in absolute error), each with its
// global `rank`, so its cumulative share is rank / count.
export function visibleCDF(full, view, limit) {
  return rankWindow(full.cdf, full.absolute, view?.x ?? everything, limit).map(
    (position) => ({...full.pair(full.cdf[position]), rank: position + 1}),
  );
}

// The scatter comparisons of `unit` for a view: the first `limit` of the
// unit's priority order inside it.
export function visibleScatter(full, unit, view, limit) {
  const [xMin, xMax] = view?.x ?? everything;
  const [yMin, yMax] = view?.y ?? everything;
  const shown = [];
  for (const index of full.scatter.get(unit) ?? []) {
    if (shown.length === limit) break;
    const x = full.actual[index],
      y = full.prediction[index];
    if (x >= xMin && x <= xMax && y >= yMin && y <= yMax) shown.push(full.pair(index));
  }
  return shown;
}
