// @vitest-environment node
import {describe, expect, test} from 'vitest';
import {pairPages} from '../netlify/lib/api.js';
import {buildPairs, comparisonPairs, decodeSamples} from '../site/model.js';
import {fullCharts, visibleCDF, visibleRanked, visibleScatter} from '../site/resample.js';

const benchmarks = {
  k: {
    values: {
      hw: {name: 'HW', unit: 'ns', role: 'hardware_measurement'},
      sim: {name: 'Sim', unit: 'ns', role: 'simulator_output'},
      hwbw: {name: 'HW bw', unit: 'GB/s', role: 'hardware_measurement'},
      simbw: {name: 'Sim bw', unit: 'GB/s', role: 'simulator_output'},
    },
  },
};
const groups = [[1, 'g', 'Group']];
// Deterministic comparisons with repeated errors (ties) and two units.
function rowsOf(n) {
  let seed = 11;
  const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  return Array.from({length: n}, (_, i) => {
    const actual = 1 + Math.round(random() * 1e5);
    const prediction = i % 7 === 0 ? actual : Math.max(1, Math.round(actual * (0.3 + 2 * random())));
    return {
      group: 'g',
      benchmark: 'k',
      plot: 100 + (i % 37),
      x: i,
      non_scaling_params: {block: i % 37},
      values: i % 5 === 0 ? {hwbw: actual, simbw: prediction} : {hw: actual, sim: prediction},
    };
  });
}
const input = (n) => ({rows: rowsOf(n), benchmarks, groups, overview: false});
const envelope = {rid: 1, key: 'run', scope: 'group:1', revision: 3, state: 'completed'};

describe('pairs pages', () => {
  test('split every comparison into self-contained pages within the byte budget', () => {
    const body = buildPairs(input(3000));
    expect(body.count).toBe(comparisonPairs(rowsOf(3000), benchmarks).length);
    const limit = 20_000;
    const pages = pairPages(body, envelope, limit);
    expect(pages.length).toBeGreaterThan(3);
    let offset = 0;
    for (const page of pages) {
      expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThanOrEqual(limit);
      expect(page.offset).toBe(offset);
      expect(page).toMatchObject({...envelope, count: body.count, series: body.series});
      // Each page names exactly the plots of its comparisons.
      expect(Object.keys(page.plots).sort()).toEqual([...new Set(page.samples.plot.map(String))].sort());
      offset += page.samples.plot.length;
      expect(page.next).toBe(offset === body.count ? null : offset);
    }
    expect(pages.flatMap((page) => decodeSamples(page).pairs)).toEqual(decodeSamples(body).pairs);
    // A scope that fits, or has no comparisons, is one page.
    expect(pairPages(body, envelope)).toHaveLength(1);
    const empty = pairPages(buildPairs({...input(0)}), envelope);
    expect(empty).toHaveLength(1);
    expect(empty[0]).toMatchObject({offset: 0, next: null, count: 0});
  });
});

describe('zoomed summary resampling', () => {
  const body = buildPairs(input(20_000));
  const full = fullCharts(pairPages(body, envelope, 200_000));
  const pairs = decodeSamples(body).pairs;
  const errors = pairs.map((pair) => pair.signedError);
  const key = (pair) => pair.point.x + ':' + pair.id;

  test('ranks count every comparison, as the server sample ranks them', () => {
    expect(full.count).toBe(pairs.length);
    const bySigned = pairs.map((pair, i) => [pair, i]).sort(
      ([a, i], [b, j]) => a.signedError - b.signedError || i - j,
    );
    for (const pair of visibleRanked(full, {y: [-20, 40]}, 300))
      expect(key(bySigned[pair.rank - 1][0])).toBe(key(pair));
    const byAbsolute = [...pairs].sort(
      (a, b) => Math.abs(a.signedError) - Math.abs(b.signedError),
    );
    for (const pair of visibleCDF(full, {x: [5, 50]}, 300))
      expect(Math.abs(pair.signedError)).toBe(Math.abs(byAbsolute[pair.rank - 1].signedError));
  });

  test('a view draws at most the limit, inside it plus one neighbor per side and both extremes', () => {
    const view = {y: [-10, 25]};
    const shown = visibleRanked(full, view, 1500);
    expect(shown.length).toBeLessThanOrEqual(1500);
    const inside = shown.filter((p) => p.signedError >= -10 && p.signedError <= 25);
    expect(shown.length - inside.length).toBeLessThanOrEqual(4);
    expect(inside.length).toBeGreaterThan(700);
    expect(shown[0].rank).toBe(1);
    expect(shown.at(-1).rank).toBe(full.count);
    // Ranks in view are spread evenly: no gap is more than twice the mean.
    const ranks = inside.map((p) => p.rank);
    const gaps = ranks.slice(1).map((r, i) => r - ranks[i]);
    const mean = (ranks.at(-1) - ranks[0]) / gaps.length;
    expect(Math.max(...gaps)).toBeLessThanOrEqual(2 * mean + 1);
    // A view holding fewer comparisons than the limit draws all of them.
    const narrow = visibleRanked(full, {y: [3, 3.5]}, 1500);
    const count = errors.filter((e) => e >= 3 && e <= 3.5).length;
    expect(narrow.filter((p) => p.signedError >= 3 && p.signedError <= 3.5)).toHaveLength(count);
  });

  test('sampling is stable: zooming in only adds points and panning keeps those still in view', () => {
    const keys = (list) => new Set(list.map(key));
    const signed = (p) => p.signedError;
    const absolute = (p) => Math.abs(p.signedError);
    for (const [shown, metric, wide, narrow] of [
      [(range) => visibleRanked(full, {y: range}, 1500), signed, [-40, 80], [0, 20]],
      [(range) => visibleCDF(full, {x: range}, 1500), absolute, [1, 100], [10, 30]],
    ]) {
      const inner = keys(shown(narrow));
      for (const pair of shown(wide))
        if (metric(pair) >= narrow[0] && metric(pair) <= narrow[1])
          expect(inner.has(key(pair))).toBe(true);
    }
    // Panning by a sliver at the same zoom keeps almost every point.
    const before = visibleRanked(full, {y: [0, 30]}, 1500);
    const after = keys(visibleRanked(full, {y: [0.5, 30.5]}, 1500));
    const kept = before.filter((p) => p.signedError >= 0.5 && p.signedError <= 30);
    expect(kept.filter((p) => after.has(key(p))).length).toBeGreaterThan(0.9 * kept.length);
  });

  test('scatter draws the first comparisons of its priority order in view', () => {
    const units = new Set(pairs.map((p) => p.unit));
    expect([...full.scatter.keys()].sort()).toEqual([...units].sort());
    const all = visibleScatter(full, 'ns', null, 3000);
    expect(all).toHaveLength(3000);
    expect(all.every((p) => p.unit === 'ns')).toBe(true);
    // The extremes and the largest errors come first.
    const ns = pairs.filter((p) => p.unit === 'ns');
    const largest = Math.max(...ns.map((p) => Math.abs(p.signedError)));
    expect(all.some((p) => Math.abs(p.signedError) === largest)).toBe(true);
    expect(all.some((p) => p.actual === Math.max(...ns.map((q) => q.actual)))).toBe(true);
    const view = {x: [2e4, 6e4], y: [2e4, 8e4]};
    const inside = (p) => p.actual >= 2e4 && p.actual <= 6e4 && p.prediction >= 2e4 && p.prediction <= 8e4;
    const zoomed = visibleScatter(full, 'ns', view, 500);
    expect(zoomed).toHaveLength(500);
    expect(zoomed.every(inside)).toBe(true);
    // Zooming in keeps every drawn point still in view.
    const inner = new Set(
      visibleScatter(full, 'ns', {x: [3e4, 5e4], y: [3e4, 7e4]}, 500).map(key),
    );
    for (const pair of zoomed)
      if (pair.actual >= 3e4 && pair.actual <= 5e4 && pair.prediction >= 3e4 && pair.prediction <= 7e4)
        expect(inner.has(key(pair))).toBe(true);
  });
});
