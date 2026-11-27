import {MantineProvider} from '@mantine/core';
import {fireEvent, render, screen, within} from '@testing-library/react';
import {describe, expect, test} from 'vitest';
import {Report} from '../site/App.jsx';
import {nearestPoint} from '../site/Charts.jsx';
import {
  drawChart,
  factorLabel,
  factorTicks,
  fromLogFactor,
  logFactor,
  zoomAxes,
} from '../site/drawing.js';
import {comparisonPairs} from '../site/model.js';
import {panView, wheelFactor, zoomView} from '../site/zoom.js';

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

function mount() {
  // Mantine's test environment renders modals without transitions.
  render(
    <MantineProvider env="test">
      <Report snapshot={{report: {groups}, benchmarks, data: rows}} />
    </MantineProvider>,
  );
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
  });

  test('ticks are round factors around 1×, or linear factors away from it', () => {
    const ticks = factorTicks(-300, 300, 5).map(factorLabel);
    expect(ticks).toContain('1×');
    expect(ticks).toContain('2× slower');
    expect(ticks).toContain('2× faster');
    const wide = factorTicks(-9900, 9900, 7).map(factorLabel);
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
    expect(y.ticks.map((tick) => tick.label)).toContain('1×');
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
    expect(linear.axes.y.ticks.every((tick) => tick.label.endsWith('%'))).toBe(true);
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

  test('degenerate or out-of-range zooms keep the current domain', () => {
    expect(zoomView(null, {x: linear}, ['x'], {x: 0, y: 0}, 0).x).toEqual([0, 100]);
    expect(zoomView(null, {y: log}, ['y'], {x: 0, y: 0}, 1e6).y).toEqual([1, 1e4]);
    expect(wheelFactor({deltaY: -100, deltaMode: 0})).toBeLessThan(1);
    expect(wheelFactor({deltaY: 3, deltaMode: 1})).toBeGreaterThan(1);
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
    for (const point of zoomed.hitPoints) {
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
    expect(screen.getByRole('group', {name: 'Point details'})).toBeTruthy();
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
});
