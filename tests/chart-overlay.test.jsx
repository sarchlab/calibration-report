import {MantineProvider} from '@mantine/core';
import {act, fireEvent, render, screen, within} from '@testing-library/react';
import {describe, expect, test, vi} from 'vitest';
import {Report} from '../site/App.jsx';
import {nearestPoint} from '../site/Charts.jsx';
import {
  drawChart,
  factorLabel,
  factorLabels,
  factorTicks,
  fromLogFactor,
  logFactor,
  zoomAxes,
} from '../site/drawing.js';
import {buildPairs, comparisonPairs, preferLogScale} from '../site/model.js';
import {fullCharts, visibleCDF} from '../site/resample.js';
import {cdfAxis} from '../site/drawing.js';
import {panView, pinchView, wheelFactor, zoomView} from '../site/zoom.js';

const benchmarks = {
  fir: {
    scaling_param: 'size',
    params: {size: {unit: ''}, block: {unit: ''}},
    values: {
      hw: {name: 'Measured', role: 'hardware_measurement', unit: 'ns'},
      sim: {name: 'Simulated', role: 'simulator_output', unit: 'ns'},
    },
  },
};
const groups = {gpu: {name: 'Example GPU'}};
// Errors from −75% (4× faster) to +300% (4× slower).
const rows = Array.from({length: 12}, (_, i) => ({
  group: 'gpu',
  benchmark: 'fir',
  x: 2 ** (i + 4),
  non_scaling_params: {block: 64},
  values: {hw: (i + 1) * 1e6, sim: (i + 1) * 1e6 * 4 ** ((i - 5.5) / 5.5)},
}));
const theme = {
  grid: '#ddd',
  label: '#333',
  reference: '#555',
  palette: ['#078'],
  roles: new Map(),
};
const pairs = comparisonPairs(rows, benchmarks);
const colors = new Map([[pairs[0].id, {color: '#078', name: 'Simulated'}]]);

// Mantine's test environment renders modals without transitions.
const report = (data, revision = 0) => (
  <MantineProvider env="test">
    <Report snapshot={{report: {groups}, benchmarks, data}} revision={revision} />
  </MantineProvider>
);
function mount() {
  return render(report(rows));
}
const dialog = () => screen.getByRole('dialog');
const pressed = (button) => button.getAttribute('aria-pressed');

describe('log-factor axis', () => {
  test('a signed error maps to sign · log10(1 + |e| / 100), i.e. log10(sim / hw)', () => {
    expect(logFactor(0)).toBe(0);
    expect(logFactor(100)).toBeCloseTo(Math.log10(2));
    expect(logFactor(-100)).toBeCloseTo(-Math.log10(2));
    for (const pair of pairs)
      expect(logFactor(pair.signedError)).toBeCloseTo(Math.log10(pair.prediction / pair.actual));
    for (const error of [-900, -100, -12.5, 0, 3, 100, 4000])
      expect(fromLogFactor(logFactor(error))).toBeCloseTo(error);
  });

  test('labels read as factors, slower above 1× and faster below', () => {
    expect(factorLabel(0)).toBe('1×');
    expect(factorLabel(100)).toBe('2× slower');
    expect(factorLabel(-100)).toBe('2× faster');
    expect(factorLabel(50)).toBe('1.5× slower');
    expect(factorLabel(900)).toBe('10× slower');
    expect(factorLabel(-900)).toBe('10× faster');
    // Bare 1× is parity only; near-parity ticks get the digits they need.
    expect(factorLabel(0.1)).not.toBe('1×');
    expect(factorLabels([-0.1, 0, 0.1])).toEqual(['1.001× faster', '1×', '1.001× slower']);
  });

  test('ticks are round factors around 1×, or linear factors away from it', () => {
    const ticks = factorTicks(-300, 300, 5).map((error) => factorLabel(error));
    expect(ticks).toContain('1×');
    expect(ticks).toContain('2× slower');
    expect(ticks).toContain('2× faster');
    const wide = factorTicks(-9900, 9900, 7).map((error) => factorLabel(error));
    expect(wide).toContain('10× slower');
    expect(wide).toContain('10× faster');
    // A view between 3× and 5× slower holds only the 5× round factor.
    const away = factorTicks(200, 390, 5);
    expect(away.length).toBeGreaterThan(1);
    expect(away.every((error) => error >= 200 && error <= 390)).toBe(true);
  });

  test('the S-curve draws factor ticks, its bands and its 1× line in the transform', () => {
    const drawn = drawChart(
      document.createElement('canvas'),
      {kind: 'ranked', pairs, colors, factor: true},
      theme,
      benchmarks,
    );
    const {y} = drawn.axes;
    expect(y.scale).toBe('factor');
    const ones = y.ticks.filter((tick) => tick.label === '1×');
    expect(ones).toHaveLength(1);
    expect(ones[0].position).toBeCloseTo(y.position(0));
    // Points sit at their log factor: equal factors either side of 1× are
    // equally far from it.
    const one = y.position(0);
    expect(one - y.position(100)).toBeCloseTo(y.position(-100) - one);
    for (const point of drawn.hitPoints) {
      const error = Number(point.description.comparisons[0].signedError);
      expect(point.y).toBeCloseTo(y.position(error));
    }
    const linear = drawChart(
      document.createElement('canvas'),
      {kind: 'ranked', pairs, colors},
      theme,
      benchmarks,
    );
    expect(linear.axes.y.scale).toBe('linear');
    // A tight view around parity still has distinct, usable ticks.
    const tight = drawChart(
      document.createElement('canvas'),
      {kind: 'ranked', pairs, colors, factor: true},
      theme,
      benchmarks,
      {view: {y: [-0.05, 0.05]}},
    );
    const labels = tight.axes.y.ticks.map((tick) => tick.label);
    expect(labels.length).toBeGreaterThanOrEqual(2);
    expect(new Set(labels).size).toBe(labels.length);
    const parity = tight.axes.y.ticks.find((tick) => tick.label === '1×');
    expect(parity.position).toBeCloseTo(tight.axes.y.position(0));
    expect(linear.axes.y.ticks.every((tick) => tick.label.endsWith('%'))).toBe(true);
  });
});

describe('S-curve percentile axis', () => {
  const ranked = (options) =>
    drawChart(
      document.createElement('canvas'),
      {kind: 'ranked', pairs, colors, total: 2861},
      theme,
      benchmarks,
      options,
    ).axes.x;

  test('ticks at quartiles of the full total, with the case rank below', () => {
    const x = ranked();
    expect(x.ticks.map((tick) => tick.label)).toEqual(['0%', '25%', '50%', '75%', '100%']);
    // Rank r of N is 100·(r − 1)/(N − 1)%: a sample of 12 still counts 2,861.
    expect(x.ticks.map((tick) => tick.sublabel)).toEqual(['1', '716', '1,431', '2,146', '2,861']);
    expect(x.ticks[0].position).toBeCloseTo(x.position(1));
    expect(x.ticks[2].position).toBeCloseTo(x.position(1431));
    expect(x.ticks[4].position).toBeCloseTo(x.position(2861));
  });

  test('a single case has one tick, labelled with its real count', () => {
    const x = drawChart(
      document.createElement('canvas'),
      {kind: 'ranked', pairs: pairs.slice(0, 1), colors},
      theme,
      benchmarks,
    ).axes.x;
    expect(x.ticks.map((tick) => [tick.label, tick.sublabel])).toEqual([['100%', '1']]);
    expect(x.ticks[0].position).toBeCloseTo(x.position(1));
  });

  test('a wide overlay ticks every 5%, keeping the quartiles', () => {
    const x = ranked({size: {width: 1200, height: 500}});
    const labels = x.ticks.map((tick) => tick.label);
    expect(labels).toHaveLength(21);
    expect(labels).toEqual(expect.arrayContaining(['5%', '25%', '75%', '95%']));
  });
});

describe('zoom math', () => {
  const linear = {
    domain: [0, 100],
    range: [0, 200],
    scale: 'linear',
    transform: (n) => n,
    inverse: (n) => n,
  };
  const log = {
    domain: [1, 1e4],
    range: [100, 0],
    scale: 'log',
    transform: Math.log10,
    inverse: (n) => 10 ** n,
  };

  test('zooming keeps the data under the cursor in place, in transformed space', () => {
    const view = zoomView(null, {x: linear, y: log}, ['x', 'y'], {x: 50, y: 50}, 0.5);
    expect(view.x[0]).toBeCloseTo(12.5);
    expect(view.x[1]).toBeCloseTo(62.5);
    // y=50 is the middle of a 0..4 decade axis: 10^2, kept at the center.
    expect(view.y[0]).toBeCloseTo(10);
    expect(view.y[1]).toBeCloseTo(1000);
  });

  test('panning moves content with the drag, log axes by decades', () => {
    const view = panView(null, {x: linear, y: log}, ['x', 'y'], {x: 20, y: 25});
    // Dragging right by a tenth shows data a tenth further left.
    expect(view.x).toEqual([-10, 90]);
    // Dragging down by a quarter of four decades reveals the decade above.
    expect(view.y[0]).toBeCloseTo(10);
    expect(view.y[1]).toBeCloseTo(1e5);
  });

  test('only allowed axes change, and each chart kind locks its own', () => {
    expect(zoomAxes).toEqual({
      curve: ['x', 'y'],
      scatter: ['x', 'y'],
      ranked: ['y'],
      cdf: ['x'],
    });
    const axes = {x: linear, y: {...linear, range: [100, 0]}};
    const start = {x: [5, 6]};
    const ranked = zoomView(start, axes, zoomAxes.ranked, {x: 10, y: 50}, 0.5);
    expect(ranked.x).toEqual([5, 6]);
    expect(ranked.y).toBeDefined();
    const cdf = panView(null, axes, zoomAxes.cdf, {x: 20, y: 20});
    expect(cdf.y).toBeUndefined();
    expect(cdf.x).toEqual([-10, 90]);
  });

  test('a pinch zooms around where it began and pans with its midpoint', () => {
    const axes = {x: linear, y: {...linear, range: [100, 0]}};
    const at = (x1, y1, x2, y2) => [{x: x1, y: y1}, {x: x2, y: y2}];
    // Fingers spreading from 20 to 40 apart around x = 100 (data 50).
    const spread = pinchView(null, axes, ['x', 'y'], at(90, 50, 110, 50), at(80, 50, 120, 50));
    expect(spread.x[0]).toBeCloseTo(25);
    expect(spread.x[1]).toBeCloseTo(75);
    expect(spread.y[0]).toBeCloseTo(25);
    expect(spread.y[1]).toBeCloseTo(75);
    // The S-curve's rank axis stays automatic.
    const ranked = pinchView(null, axes, zoomAxes.ranked, at(90, 50, 110, 50), at(80, 50, 120, 50));
    expect(ranked.x).toBeUndefined();
    expect(ranked.y).toEqual(spread.y);
    // Moving both fingers together pans; zooming then panning keeps the data
    // under the starting midpoint under the new one.
    expect(pinchView(null, axes, ['x', 'y'], at(90, 50, 110, 50), at(110, 50, 130, 50))).toEqual(
      panView(null, axes, ['x', 'y'], {x: 20, y: 0}),
    );
    const both = pinchView(null, axes, ['x'], at(90, 50, 110, 50), at(100, 50, 140, 50));
    // Data 50 (the start midpoint) is at pixel 120, the new midpoint.
    expect(both.x[0] + ((120 - 0) / 200) * (both.x[1] - both.x[0])).toBeCloseTo(50);
    // Still fingers change nothing.
    const still = {x: [1, 2]};
    expect(pinchView(still, axes, ['x', 'y'], at(90, 50, 110, 50), at(90, 50, 110, 50))).toBe(still);
  });

  test('degenerate or out-of-range zooms store no override and keep existing ones', () => {
    expect(zoomView(null, {x: linear}, ['x'], {x: 0, y: 0}, 0)).toBeNull();
    expect(zoomView(null, {y: log}, ['y'], {x: 0, y: 0}, 1e6)).toBeNull();
    expect(zoomView({x: [3, 7]}, {x: linear}, ['x'], {x: 0, y: 0}, 0).x).toEqual([3, 7]);
    expect(wheelFactor({deltaY: -100, deltaMode: 0})).toBeLessThan(1);
    expect(wheelFactor({deltaY: 3, deltaMode: 1})).toBeGreaterThan(1);
  });

  test('a single-X chart zooms Y only, so a refresh with a second X spreads out', () => {
    const curve = (data) => ({
      kind: 'curve',
      rows: data,
      curves: [{id: 'hw', color: '#333'}],
      series: [],
      xLabel: 'Size',
      unit: 'ns',
      bounds: {min: 1e6, max: 2e6},
      scales: {x: false, y: false},
    });
    const canvas = document.createElement('canvas');
    const single = drawChart(canvas, curve(rows.slice(0, 1)), theme, benchmarks);
    const zoomed = zoomView(null, single.axes, zoomAxes.curve, {x: 100, y: 60}, 0.5);
    const panned = panView(zoomed, single.axes, zoomAxes.curve, {x: 30, y: 10});
    expect(zoomed.x).toBeUndefined();
    expect(panned.x).toBeUndefined();
    expect(panned.y).toBeDefined();
    const refreshed = drawChart(canvas, curve(rows.slice(0, 2)), theme, benchmarks, {
      view: panned,
    });
    const [first, second] = refreshed.hitPoints;
    expect(second.x - first.x).toBeGreaterThan(100);
    expect(refreshed.axes.y.domain).toEqual(panned.y);
  });

  test('an axis the gesture does not move stays on automatic bounds', () => {
    const curve = (data, max) => ({
      kind: 'curve',
      rows: data,
      curves: [{id: 'hw', color: '#333'}],
      series: [],
      xLabel: 'Size',
      unit: 'ns',
      bounds: {min: 1e6, max},
      scales: {x: false, y: false},
    });
    const canvas = document.createElement('canvas');
    const drawn = drawChart(canvas, curve(rows.slice(0, 4), 4e6), theme, benchmarks);
    const panned = panView(null, drawn.axes, zoomAxes.curve, {x: 30, y: 0});
    expect(panned.x).toBeDefined();
    expect(panned.y).toBeUndefined();
    // A live revision with larger values keeps Y automatic: nothing clipped.
    const grown = rows.slice(0, 4).map((row, i) =>
      i === 3 ? {...row, values: {...row.values, hw: 9e6}} : row,
    );
    const refreshed = drawChart(canvas, curve(grown, 9e6), theme, benchmarks, {view: panned});
    expect(refreshed.axes.y.domain[1]).toBeGreaterThan(9e6);
    // No moved axis at all leaves the view itself.
    expect(panView(null, drawn.axes, zoomAxes.ranked, {x: 30, y: 0})).toBeNull();
    expect(zoomView(panned, drawn.axes, zoomAxes.curve, {x: 100, y: 50}, 1)).toBe(panned);
  });

  test('a forced log CDF with an extreme error keeps a finite axis', () => {
    const extreme = comparisonPairs(
      [...rows, {...rows[0], x: 1, values: {hw: 1, sim: 1.7e306}}],
      benchmarks,
    );
    const largest = Math.max(...extreme.map((pair) => Math.abs(pair.signedError)));
    for (const log of [true, false]) {
      const {domain, ticks} = drawChart(
        document.createElement('canvas'),
        {kind: 'cdf', pairs: extreme, log},
        theme,
        benchmarks,
      ).axes.x;
      expect(domain.every(Number.isFinite)).toBe(true);
      expect(domain[1]).toBeGreaterThanOrEqual(largest);
      expect(ticks.every((tick) => Number.isFinite(tick.position))).toBe(true);
    }
  });

  test('an extreme log factor gives a finite axis and finite ticks', () => {
    const extreme = comparisonPairs(
      [...rows, {...rows[0], x: 1, values: {hw: 1, sim: 1e298}}],
      benchmarks,
    );
    const largest = Math.max(...extreme.map((pair) => pair.signedError));
    expect(largest).toBeGreaterThan(1e299);
    const drawn = drawChart(
      document.createElement('canvas'),
      {kind: 'ranked', pairs: extreme, colors, factor: true},
      theme,
      benchmarks,
    );
    const {domain, ticks} = drawn.axes.y;
    expect(domain.every(Number.isFinite)).toBe(true);
    expect(domain[1]).toBeGreaterThanOrEqual(largest);
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks.every((tick) => Number.isFinite(tick.position))).toBe(true);
    expect(factorTicks(-50, Infinity, 5)).toEqual([]);
  });

  test('a view clips hit points to the plot and moves the rest', () => {
    const spec = {kind: 'scatter', pairs, unit: 'ns', colors, log: true};
    const canvas = document.createElement('canvas');
    const full = drawChart(canvas, spec, theme, benchmarks);
    expect(full.hitPoints).toHaveLength(pairs.length);
    const view = zoomView(null, full.axes, zoomAxes.scatter, {x: 51, y: 143}, 0.4);
    const zoomed = drawChart(canvas, spec, theme, benchmarks, {view});
    expect(zoomed.axes.x.domain).toEqual(view.x);
    expect(zoomed.hitPoints.length).toBeGreaterThan(0);
    expect(zoomed.hitPoints.length).toBeLessThan(pairs.length);
    const {x, y} = zoomed.axes;
    for (const point of zoomed.hitPoints) {
      // Selectable centers lie in the frame itself, not its drawn bleed.
      expect(point.x).toBeGreaterThanOrEqual(x.range[0] - 1e-6);
      expect(point.x).toBeLessThanOrEqual(x.range[1] + 1e-6);
      expect(point.y).toBeGreaterThanOrEqual(y.range[1] - 1e-6);
      expect(point.y).toBeLessThanOrEqual(y.range[0] + 1e-6);
      const [pair] = point.description.comparisons;
      expect(point.x).toBeCloseTo(zoomed.axes.x.position(pair.actual));
      expect(point.y).toBeCloseTo(zoomed.axes.y.position(pair.prediction));
    }
  });

  test('hit testing uses the drawn size, not the canvas pixels', () => {
    // An overlay draws 500×300 units at 2.5 canvas pixels per unit.
    const canvas = document.createElement('canvas');
    canvas.width = 1250;
    canvas.height = 750;
    canvas.getBoundingClientRect = () => ({left: 0, top: 0, width: 625, height: 375});
    const points = [{x: 400, y: 200}];
    const size = {width: 500, height: 300};
    expect(nearestPoint({clientX: 500, clientY: 250}, canvas, points, 'mouse', size)).toBe(0);
    expect(nearestPoint({clientX: 400, clientY: 200}, canvas, points, 'mouse', size)).toBe(-1);
  });
});

describe('overlay', () => {
  test('every chart has an expand button; summary overlays open and close', () => {
    mount();
    expect(screen.getByRole('button', {name: 'Expand S-curve'})).toBeTruthy();
    expect(screen.getByRole('button', {name: 'Expand Absolute error distribution (CDF)'})).toBeTruthy();
    expect(screen.getByRole('button', {name: 'Expand Measured vs. simulated · ms'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: 'Expand S-curve'}));
    expect(within(dialog()).getByText('S-curve')).toBeTruthy();
    expect(within(dialog()).getByRole('img')).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, {key: 'Escape'});
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: 'Expand Measured vs. simulated · ms'}));
    fireEvent.click(within(dialog()).getByRole('button', {name: 'Close expanded chart'}));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('benchmark overlays keep point details; Escape closes them before the overlay', () => {
    mount();
    fireEvent.click(screen.getByRole('tab', {name: 'Example GPU'}));
    fireEvent.click(screen.getByRole('button', {name: /^Expand .*block=64/}));
    expect(dialog().textContent).toContain('block=64');
    const canvas = within(dialog()).getByRole('img');
    canvas.focus();
    fireEvent.keyDown(canvas, {key: 'Home'});
    // The pinned panel shares the dialog's focus boundary.
    expect(within(dialog()).getByRole('group', {name: 'Point details'})).toBeTruthy();
    fireEvent.keyDown(canvas, {key: 'Escape'});
    expect(screen.queryByRole('group', {name: 'Point details'})).toBeNull();
    expect(dialog()).toBeTruthy();
    fireEvent.keyDown(canvas, {key: 'Escape'});
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('wheel zoom enables Reset; double click and Reset restore the default view', () => {
    mount();
    fireEvent.click(screen.getByRole('button', {name: 'Expand Measured vs. simulated · ms'}));
    const canvas = within(dialog()).getByRole('img');
    const reset = within(dialog()).getByRole('button', {name: 'Reset zoom'});
    expect(reset.disabled).toBe(true);
    fireEvent.wheel(canvas, {deltaY: -200, clientX: 100, clientY: 80});
    expect(reset.disabled).toBe(false);
    fireEvent.doubleClick(canvas);
    expect(reset.disabled).toBe(true);
    fireEvent.wheel(canvas, {deltaY: -200, clientX: 100, clientY: 80});
    fireEvent.click(reset);
    expect(reset.disabled).toBe(true);
    // A drag pans, and the click that ends it selects nothing.
    fireEvent.pointerDown(canvas, {pointerType: 'mouse', button: 0, clientX: 100, clientY: 80});
    fireEvent.pointerMove(canvas, {pointerType: 'mouse', clientX: 140, clientY: 90});
    fireEvent.pointerUp(canvas, {pointerType: 'mouse'});
    fireEvent.click(canvas, {clientX: 140, clientY: 90});
    expect(reset.disabled).toBe(false);
    expect(screen.queryByRole('group', {name: 'Point details'})).toBeNull();
  });

  test('the S-curve log-factor toggle is shared by the overlay and survives switching views', () => {
    mount();
    const toggle = () => screen.getAllByRole('button', {name: 'Y log factor'});
    expect(toggle()).toHaveLength(1);
    expect(pressed(toggle()[0])).toBe('false');
    fireEvent.click(screen.getByRole('button', {name: 'Expand S-curve'}));
    fireEvent.click(within(dialog()).getByRole('button', {name: 'Y log factor'}));
    expect(toggle().map(pressed)).toEqual(['true', 'true']);
    expect(within(dialog()).getByRole('img').getAttribute('aria-label')).toContain('log-factor');
    fireEvent.click(within(dialog()).getByRole('button', {name: 'Close expanded chart'}));
    fireEvent.click(screen.getByRole('tab', {name: 'Example GPU'}));
    fireEvent.click(screen.getByRole('tab', {name: 'Overview'}));
    expect(pressed(screen.getByRole('button', {name: 'Y log factor'}))).toBe('true');
  });

  test('a data revision keeps the overlay and its zoom but clears pinned details', () => {
    const view = mount();
    fireEvent.click(screen.getByRole('button', {name: 'Expand Measured vs. simulated · ms'}));
    fireEvent.wheel(within(dialog()).getByRole('img'), {deltaY: -100, clientX: 170, clientY: 90});
    const canvas = within(dialog()).getByRole('img');
    canvas.focus();
    fireEvent.keyDown(canvas, {key: 'Home'});
    expect(screen.getByRole('group', {name: 'Point details'})).toBeTruthy();
    const changed = rows.map((row, i) =>
      i === 3 ? {...row, values: {...row.values, sim: row.values.sim * 1.01}} : row,
    );
    view.rerender(report(changed, 1));
    expect(within(dialog()).getByRole('button', {name: 'Reset zoom'}).disabled).toBe(false);
    expect(screen.queryByRole('group', {name: 'Point details'})).toBeNull();
  });

  test('changing a scale discards the zoom, even when changed back', () => {
    mount();
    fireEvent.click(screen.getByRole('button', {name: 'Expand Measured vs. simulated · ms'}));
    const reset = within(dialog()).getByRole('button', {name: 'Reset zoom'});
    fireEvent.wheel(within(dialog()).getByRole('img'), {deltaY: -200, clientX: 100, clientY: 80});
    expect(reset.disabled).toBe(false);
    const scale = within(dialog()).getByRole('button', {name: 'X/Y log'});
    fireEvent.click(scale);
    fireEvent.click(scale);
    expect(reset.disabled).toBe(true);
  });

  test('the second click of a double click neither pins nor unpins', () => {
    mount();
    fireEvent.click(screen.getByRole('button', {name: 'Expand Measured vs. simulated · ms'}));
    const canvas = within(dialog()).getByRole('img');
    canvas.focus();
    fireEvent.keyDown(canvas, {key: 'Home'});
    fireEvent.click(canvas, {clientX: 5, clientY: 5, detail: 2});
    expect(screen.getByRole('group', {name: 'Point details'})).toBeTruthy();
    // Unzoomed, a double click has nothing to reset and keeps the details.
    fireEvent.doubleClick(canvas);
    expect(screen.getByRole('group', {name: 'Point details'})).toBeTruthy();
  });

  test('the S-curve note follows the log-factor axis', () => {
    mount();
    expect(screen.getByText(/Negative values are underestimates/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: 'Y log factor'}));
    expect(screen.getByText(/Above 1× the simulator is slower than hardware/)).toBeTruthy();
  });

  test('a drag along the S-curve rank axis changes nothing and keeps details', () => {
    mount();
    fireEvent.click(screen.getByRole('button', {name: 'Expand S-curve'}));
    const canvas = within(dialog()).getByRole('img');
    canvas.focus();
    fireEvent.keyDown(canvas, {key: 'Home'});
    fireEvent.pointerDown(canvas, {pointerType: 'mouse', button: 0, clientX: 100, clientY: 80});
    fireEvent.pointerMove(canvas, {pointerType: 'mouse', clientX: 160, clientY: 80});
    fireEvent.pointerUp(canvas, {pointerType: 'mouse'});
    fireEvent.click(canvas, {clientX: 160, clientY: 80});
    expect(within(dialog()).getByRole('button', {name: 'Reset zoom'}).disabled).toBe(true);
    expect(screen.getByRole('group', {name: 'Point details'})).toBeTruthy();
  });

  test('a revision that flips the CDF scale discards its zoom', () => {
    // Evenly spaced errors draw linear; geometrically spaced ones, log.
    const withErrors = (errors) =>
      rows.map((row, i) => ({
        ...row,
        values: {hw: row.values.hw, sim: row.values.hw * (1 + errors[i] / 100)},
      }));
    const linear = withErrors(rows.map((_, i) => 10 * (i + 1)));
    const log = withErrors(rows.map((_, i) => 2 ** i / 10));
    const view = render(report(linear));
    fireEvent.click(screen.getByRole('button', {name: 'Expand Absolute error distribution (CDF)'}));
    expect(within(dialog()).getByRole('img').getAttribute('aria-label')).toBe(
      'Absolute error cumulative distribution',
    );
    fireEvent.wheel(within(dialog()).getByRole('img'), {deltaY: -200, clientX: 150, clientY: 80});
    expect(within(dialog()).getByRole('button', {name: 'Reset zoom'}).disabled).toBe(false);
    view.rerender(report(log, 1));
    expect(within(dialog()).getByRole('button', {name: 'Reset zoom'}).disabled).toBe(true);
  });

  test('a revision that clears overlay details keeps focus in the dialog', () => {
    const view = mount();
    fireEvent.click(screen.getByRole('button', {name: 'Expand Measured vs. simulated · ms'}));
    const canvas = within(dialog()).getByRole('img');
    canvas.focus();
    fireEvent.keyDown(canvas, {key: 'Home'});
    screen.getByRole('button', {name: 'Next point'}).focus();
    expect(screen.getByRole('group', {name: 'Point details'}).contains(document.activeElement)).toBe(true);
    view.rerender(report(rows.slice(0, 11), 1));
    expect(screen.queryByRole('group', {name: 'Point details'})).toBeNull();
    expect(document.activeElement).toBe(within(dialog()).getByRole('img'));
  });

  describe('touch', () => {
    const scatterOverlay = () => {
      mount();
      fireEvent.click(screen.getByRole('button', {name: 'Expand Measured vs. simulated · ms'}));
      return within(dialog()).getByRole('img');
    };
    const reset = () => within(dialog()).getByRole('button', {name: 'Reset zoom'});
    const touch = (type, canvas, pointerId, clientX, clientY) =>
      fireEvent[type](canvas, {pointerType: 'touch', pointerId, clientX, clientY});
    const tap = (canvas, clientX, clientY) => {
      touch('pointerDown', canvas, 1, clientX, clientY);
      touch('pointerUp', canvas, 1, clientX, clientY);
      fireEvent.click(canvas, {clientX, clientY});
    };
    // Where the overlay canvas shows the first scatter point, in client
    // pixels: it draws the default 320-unit-wide layout.
    const firstPoint = (canvas) => {
      const log = preferLogScale(pairs.flatMap((pair) => [pair.actual, pair.prediction]));
      const [point] = drawChart(
        document.createElement('canvas'),
        {kind: 'scatter', pairs, unit: 'ns', colors, log},
        theme,
        benchmarks,
      ).hitPoints;
      const rect = canvas.getBoundingClientRect();
      const ratio = canvas.width / 320;
      return [
        rect.left + (point.x * rect.width) / (canvas.width / ratio),
        rect.top + (point.y * rect.height) / (canvas.height / ratio),
      ];
    };

    test('only the overlay canvas opts out of native touch gestures', () => {
      mount();
      const inline = screen.getAllByRole('img');
      expect(inline.every((canvas) => canvas.style.touchAction === '')).toBe(true);
      fireEvent.click(screen.getByRole('button', {name: 'Expand S-curve'}));
      expect(within(dialog()).getByRole('img').style.touchAction).toBe('none');
    });

    test('a two-finger pinch zooms; still fingers change nothing', () => {
      const canvas = scatterOverlay();
      canvas.focus();
      fireEvent.keyDown(canvas, {key: 'Home'});
      touch('pointerDown', canvas, 1, 100, 80);
      touch('pointerDown', canvas, 2, 140, 80);
      touch('pointerMove', canvas, 2, 140, 80);
      touch('pointerUp', canvas, 2, 140, 80);
      touch('pointerUp', canvas, 1, 100, 80);
      expect(reset().disabled).toBe(true);
      expect(screen.getByRole('group', {name: 'Point details'})).toBeTruthy();
      touch('pointerDown', canvas, 1, 100, 80);
      touch('pointerDown', canvas, 2, 140, 80);
      touch('pointerMove', canvas, 1, 80, 80);
      touch('pointerMove', canvas, 2, 160, 80);
      touch('pointerUp', canvas, 1, 80, 80);
      touch('pointerUp', canvas, 2, 160, 80);
      fireEvent.click(canvas, {clientX: 160, clientY: 80});
      expect(reset().disabled).toBe(false);
      expect(screen.queryByRole('group', {name: 'Point details'})).toBeNull();
    });

    test('a pinch on the S-curve zooms only its error axis', () => {
      mount();
      fireEvent.click(screen.getByRole('button', {name: 'Expand S-curve'}));
      const canvas = within(dialog()).getByRole('img');
      // Fingers spreading only horizontally still zoom Y (by distance).
      touch('pointerDown', canvas, 1, 100, 80);
      touch('pointerDown', canvas, 2, 140, 80);
      touch('pointerMove', canvas, 2, 200, 80);
      expect(reset().disabled).toBe(false);
    });

    test('one finger pans, and the lift after it selects nothing', () => {
      const canvas = scatterOverlay();
      touch('pointerDown', canvas, 1, 100, 80);
      touch('pointerMove', canvas, 1, 130, 95);
      touch('pointerUp', canvas, 1, 130, 95);
      fireEvent.click(canvas, {clientX: 130, clientY: 95});
      expect(reset().disabled).toBe(false);
      expect(screen.queryByRole('group', {name: 'Point details'})).toBeNull();
    });

    test('a tap, even with a little wobble, still pins a point', () => {
      const canvas = scatterOverlay();
      const [x, y] = firstPoint(canvas);
      touch('pointerDown', canvas, 1, x, y);
      touch('pointerMove', canvas, 1, x + 4, y + 3);
      touch('pointerUp', canvas, 1, x + 4, y + 3);
      fireEvent.click(canvas, {clientX: x, clientY: y});
      expect(screen.getByRole('group', {name: 'Point details'})).toBeTruthy();
      expect(reset().disabled).toBe(true);
    });

    test('a double tap resets a zoomed view and keeps details when unzoomed', () => {
      const canvas = scatterOverlay();
      const [x, y] = firstPoint(canvas);
      tap(canvas, x, y);
      tap(canvas, x, y);
      // Unzoomed: the second tap neither unpins nor resets.
      expect(screen.getByRole('group', {name: 'Point details'})).toBeTruthy();
      fireEvent.wheel(canvas, {deltaY: -200, clientX: 100, clientY: 80});
      expect(reset().disabled).toBe(false);
      tap(canvas, 300, 30);
      tap(canvas, 300, 30);
      expect(reset().disabled).toBe(true);
    });

    test('on a zoomed chart a tap selects after the double-tap window', () => {
      vi.useFakeTimers();
      const canvas = scatterOverlay();
      const [x, y] = firstPoint(canvas);
      // Zooming around the point keeps it under the finger.
      fireEvent.wheel(canvas, {deltaY: -100, clientX: x, clientY: y});
      expect(reset().disabled).toBe(false);
      tap(canvas, x, y);
      expect(screen.queryByRole('group', {name: 'Point details'})).toBeNull();
      act(() => vi.advanceTimersByTime(350));
      expect(screen.getByRole('group', {name: 'Point details'})).toBeTruthy();
      expect(reset().disabled).toBe(false);
    });

    test('a zoomed double tap resets and never opens details', () => {
      vi.useFakeTimers();
      const canvas = scatterOverlay();
      const [x, y] = firstPoint(canvas);
      fireEvent.wheel(canvas, {deltaY: -100, clientX: x, clientY: y});
      tap(canvas, x, y);
      expect(screen.queryByRole('group', {name: 'Point details'})).toBeNull();
      tap(canvas, x, y);
      expect(reset().disabled).toBe(true);
      act(() => vi.advanceTimersByTime(1000));
      expect(screen.queryByRole('group', {name: 'Point details'})).toBeNull();
    });

    test('a data change drops a pending zoomed tap', () => {
      vi.useFakeTimers();
      const view = mount();
      fireEvent.click(screen.getByRole('button', {name: 'Expand Measured vs. simulated · ms'}));
      const canvas = within(dialog()).getByRole('img');
      const [x, y] = firstPoint(canvas);
      fireEvent.wheel(canvas, {deltaY: -100, clientX: x, clientY: y});
      tap(canvas, x, y);
      const changed = rows.map((row, i) =>
        i === 3 ? {...row, values: {...row.values, sim: row.values.sim * 1.01}} : row,
      );
      view.rerender(report(changed, 1));
      act(() => vi.advanceTimersByTime(1000));
      expect(screen.queryByRole('group', {name: 'Point details'})).toBeNull();
      expect(reset().disabled).toBe(false);
    });

    test('zoomed mouse clicks wait for the double-click window; a double click resets', () => {
      vi.useFakeTimers();
      const canvas = scatterOverlay();
      const [x, y] = firstPoint(canvas);
      const click = (detail) => {
        fireEvent.pointerDown(canvas, {pointerType: 'mouse', button: 0, clientX: x, clientY: y});
        fireEvent.pointerUp(canvas, {pointerType: 'mouse', clientX: x, clientY: y});
        fireEvent.click(canvas, {clientX: x, clientY: y, detail});
      };
      // Unzoomed, a click pins at once.
      click(1);
      expect(screen.getByRole('group', {name: 'Point details'})).toBeTruthy();
      click(1);
      expect(screen.queryByRole('group', {name: 'Point details'})).toBeNull();
      fireEvent.wheel(canvas, {deltaY: -100, clientX: x, clientY: y});
      click(1);
      expect(screen.queryByRole('group', {name: 'Point details'})).toBeNull();
      act(() => vi.advanceTimersByTime(350));
      expect(screen.getByRole('group', {name: 'Point details'})).toBeTruthy();
      // Unpin, then double-click: no details, and the zoom resets.
      click(1);
      act(() => vi.advanceTimersByTime(350));
      expect(screen.queryByRole('group', {name: 'Point details'})).toBeNull();
      click(1);
      click(2);
      fireEvent.doubleClick(canvas, {clientX: x, clientY: y});
      act(() => vi.advanceTimersByTime(1000));
      expect(screen.queryByRole('group', {name: 'Point details'})).toBeNull();
      expect(reset().disabled).toBe(true);
    });

    test('an unzoomed tap selects at once', () => {
      vi.useFakeTimers();
      const canvas = scatterOverlay();
      const [x, y] = firstPoint(canvas);
      tap(canvas, x, y);
      expect(screen.getByRole('group', {name: 'Point details'})).toBeTruthy();
    });
  });
});

describe('CDF log toggle', () => {
  const withErrors = (errors) =>
    rows.map((row, i) => ({
      ...row,
      values: {hw: row.values.hw, sim: row.values.hw * (1 + errors[i] / 100)},
    }));
  const evenly = withErrors(rows.map((_, i) => 10 * (i + 1)));
  const geometric = withErrors(rows.map((_, i) => 2 ** i / 10));
  const xLog = () =>
    within(screen.getByRole('region', {name: 'Accuracy summary'})).getByRole('button', {
      name: 'X log',
    });

  test.each([
    ['linear', evenly, 'false', 'true'],
    ['log', geometric, 'true', 'false'],
  ])('overrides an automatic %s choice and keeps it across views', (_, data, auto, toggled) => {
    render(report(data));
    expect(pressed(xLog())).toBe(auto);
    fireEvent.click(xLog());
    expect(pressed(xLog())).toBe(toggled);
    fireEvent.click(screen.getByRole('tab', {name: 'Example GPU'}));
    // Each scope keeps its own choice.
    expect(pressed(xLog())).toBe(auto);
    fireEvent.click(screen.getByRole('tab', {name: 'Overview'}));
    expect(pressed(xLog())).toBe(toggled);
  });

  test('toggling in the overlay discards its zoom', () => {
    render(report(evenly));
    fireEvent.click(screen.getByRole('button', {name: 'Expand Absolute error distribution (CDF)'}));
    const reset = within(dialog()).getByRole('button', {name: 'Reset zoom'});
    fireEvent.wheel(within(dialog()).getByRole('img'), {deltaY: -200, clientX: 150, clientY: 80});
    expect(reset.disabled).toBe(false);
    fireEvent.click(within(dialog()).getByRole('button', {name: 'X log'}));
    expect(reset.disabled).toBe(true);
    expect(screen.getAllByRole('button', {name: 'X log'}).map(pressed)).toEqual(['true', 'true']);
  });
});

describe('zoomed sample density', () => {
  test('a file-mode overlay zooms without any request: it draws every pair already', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    mount();
    for (const name of ['S-curve', 'Measured vs. simulated · ms']) {
      fireEvent.click(screen.getByRole('button', {name: 'Expand ' + name}));
      fireEvent.wheel(within(dialog()).getByRole('img'), {deltaY: -200, clientX: 150, clientY: 80});
      expect(screen.queryByRole('status')).toBeNull();
      fireEvent.click(within(dialog()).getByRole('button', {name: 'Close expanded chart'}));
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  test('`shown` pairs are drawn over axes and bands taken from `pairs`', () => {
    const draw = (spec) =>
      drawChart(document.createElement('canvas'), spec, theme, benchmarks);
    for (const kind of ['ranked', 'cdf', 'scatter']) {
      const spec = {kind, pairs, colors, unit: 'ns', log: false};
      const shown = pairs.slice(2, 5).map((pair, i) => ({...pair, rank: 3 + i}));
      const plain = draw(spec);
      const dense = draw({...spec, shown});
      expect(dense.axes.x.domain).toEqual(plain.axes.x.domain);
      expect(dense.axes.y.domain).toEqual(plain.axes.y.domain);
      expect(dense.hitPoints.map((p) => p.description.comparisons[0])).toEqual(
        expect.arrayContaining(shown.map((pair) => expect.objectContaining({actual: pair.actual}))),
      );
      expect(dense.hitPoints).toHaveLength(3);
    }
  });
});

describe('zoomed log CDF', () => {
  test('exact matches drawn at the log floor stay selected and hit-testable', () => {
    // Errors 0 (exact) and 1%…100%; the sample is every fifth comparison.
    const data = Array.from({length: 200}, (_, i) => ({
      group: 'gpu', benchmark: 'fir', plot: 1, x: i, non_scaling_params: {block: 64},
      values: {hw: 1000, sim: i % 4 === 0 ? 1000 : 1000 * (1 + (1 + (i % 100)) / 100)},
    }));
    const body = buildPairs({rows: data, benchmarks, groups: [[1, 'gpu', 'Example GPU']], overview: false});
    const full = fullCharts([{...body, revision: 1}]);
    const sample = comparisonPairs(data, benchmarks).filter((_, i) => i % 5 === 1);
    const {left} = cdfAxis(sample, true);
    expect(left).toBe(1);
    const view = {x: [left, 3]};
    const exact = (pair) => pair.signedError === 0;
    // Selecting by raw error would drop them (0 is outside [1, 3]) but for
    // rank 1 and the neighbor below the view, which are always kept.
    expect(visibleCDF(full, view, 1500).filter(exact).length).toBeLessThanOrEqual(2);
    const shown = visibleCDF(full, view, 1500, left);
    expect(shown.filter(exact).length).toBe(50);
    const drawn = drawChart(
      document.createElement('canvas'),
      {kind: 'cdf', pairs: sample, total: full.count, log: true, bands: sample, shown},
      theme,
      benchmarks,
      {view},
    );
    expect(drawn.hitPoints.some((p) => p.description.comparisons[0].signedError === 0)).toBe(true);
  });
});
