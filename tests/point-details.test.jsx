import {MantineProvider} from '@mantine/core';
import {act, fireEvent, render, screen, within} from '@testing-library/react';
import {expect, test, vi} from 'vitest';
import {PointDescription, PointProvider} from '../site/PointDetails.jsx';
import {PlotCanvas, nearestPoint} from '../site/Charts.jsx';
import App, {Report, useReport} from '../site/App.jsx';
import {comparisonPairs, rankStatistics} from '../site/model.js';
import {setSystemDark, setViewport} from './setup.js';
import fs from 'node:fs';

const benchmarks = {
  fp32_throughput: {
    scaling_param: 'fmas_per_thread',
    params: {
      fmas_per_thread: {unit: ''},
      launch: {unit: ''},
      num_blocks: {unit: ''},
    },
    values: {
      hw: {
        name: 'GPU kernel time (median)',
        role: 'hardware_measurement',
        unit: 'ns',
      },
      sim: {
        name: 'Simulator kernel time',
        role: 'simulator_output',
        unit: 'ns',
      },
    },
  },
};
const groups = {gpu: {name: 'Example GPU'}};
const theme = {
  grid: '#ddd',
  label: '#333',
  reference: '#555',
  palette: ['#078'],
  roles: new Map([
    ['hardware_measurement', {color: '#765', layer: 0}],
    ['simulator_output', {color: '#375', layer: 2}],
  ]),
};
function rows(count = 13) {
  return Array.from({length: count}, (_, i) => ({
    group: 'gpu',
    benchmark: 'fp32_throughput',
    x: (i + 1) * 131072,
    non_scaling_params: {launch: '#1 kernel<script>', num_blocks: 1},
    values: {hw: (i + 1) * 1000000, sim: (i + 1) * 500000},
  }));
}
function spec(data) {
  return {
    kind: 'curve',
    rows: data,
    curves: [{id: 'hw', color: '#333'}],
    series: [],
    xLabel: 'FMAs',
    unit: 'ns',
    bounds: {min: data[0].values.hw, max: data.at(-1).values.hw},
    scales: {x: false, y: false},
  };
}
function fixture(count = 13, {summary = false, second = false} = {}) {
  const first = spec(rows(count)),
    other = spec(rows(3));
  render(
    <MantineProvider>
      <PointProvider
        benchmarks={benchmarks}
        groups={groups}
        overview={!summary}
        resetKey="test"
      >
        <section id={summary ? 'summary' : undefined}>
          <PlotCanvas spec={first} theme={theme} summary={summary} />
        </section>
        {second && <PlotCanvas spec={other} theme={theme} />}
        <button>Outside action</button>
      </PointProvider>
    </MantineProvider>,
  );
  return screen.getAllByRole('img');
}
const home = (canvas) => {
  canvas.focus();
  fireEvent.keyDown(canvas, {key: 'Home'});
};
const panel = () => screen.getByRole('group', {name: 'Point details'});
const click = (label) =>
  fireEvent.click(screen.getByRole('button', {name: label}));

test('details preserve units, signed error, configuration and literal metadata', () => {
  const point = rows(1)[0];
  render(
    <PointDescription
      description={{
        point,
        comparisons: comparisonPairs([point], benchmarks),
        extra: {'CDF percentile': '81.91%'},
        selectedSeries: 'sim',
      }}
      benchmarks={benchmarks}
      groups={groups}
    />,
  );
  expect(screen.getByText('FP32 throughput')).toBeTruthy();
  expect(screen.getByText('#1 kernel<script>').children.length).toBe(0);
  expect(screen.getByText('0.5')).toBeTruthy();
  expect(screen.getByText('−100.00%')).toBeTruthy();
  expect(screen.getByText('Underestimate')).toBeTruthy();
  expect(screen.getByText('81.91%')).toBeTruthy();
  expect(screen.getByText('131,072')).toBeTruthy();
});
test('unavailable measurements show reason while statistics exclude them', () => {
  const point = {
    ...rows(1)[0],
    values: {hw: 1000000, sim: null},
    statuses: {sim: {state: 'verification_failed', reason: 'CPU mismatch'}},
  };
  expect(comparisonPairs([point], benchmarks)).toEqual([]);
  render(
    <PointDescription
      description={{point}}
      benchmarks={benchmarks}
      groups={groups}
    />,
  );
  expect(screen.getByText('verification failed')).toBeTruthy();
  expect(screen.getByText('CPU mismatch')).toBeTruthy();
});
test.each([1, 2, 3, 13])(
  'ten-point navigation wraps %i points and preserves focused button and panel',
  (count) => {
    const [canvas] = fixture(count);
    home(canvas);
    const original = panel();
    const next = screen.getByRole('button', {name: 'Next 10 points'});
    next.focus();
    fireEvent.click(next);
    expect(
      within(panel()).getByText((10 % count) + 1 + ' / ' + count),
    ).toBeTruthy();
    expect(panel()).toBe(original);
    expect(document.activeElement).toBe(next);
    click('Previous 10 points');
    expect(within(panel()).getByText('1 / ' + count)).toBeTruthy();
    click('Previous point');
    expect(within(panel()).getByText(count + ' / ' + count)).toBeTruthy();
    click('Next point');
    expect(within(panel()).getByText('1 / ' + count)).toBeTruthy();
    click('Close point details');
    expect(screen.queryByRole('group', {name: 'Point details'})).toBeNull();
    expect(document.activeElement).toBe(canvas);
  },
);
test('keyboard enters details and Escape restores chart focus', () => {
  const [canvas] = fixture();
  home(canvas);
  fireEvent.keyDown(canvas, {key: 'Tab'});
  expect(document.activeElement.id).toBe('pinned-point-description');
  fireEvent.keyDown(document.activeElement, {key: 'End'});
  expect(within(panel()).getByText('13 / 13')).toBeTruthy();
  fireEvent.keyDown(document.activeElement, {key: 'Tab', shiftKey: true});
  expect(document.activeElement).toBe(canvas);
  fireEvent.keyDown(document, {key: 'Escape'});
  expect(screen.queryByRole('group', {name: 'Point details'})).toBeNull();
  expect(document.activeElement).toBe(canvas);
});
test('first selection of hidden desktop summary focuses mounted portal and Next keeps focus', () => {
  const [canvas] = fixture(13, {summary: true});
  home(canvas);
  expect(document.activeElement.id).toBe('pinned-point-description');
  expect(document.getElementById('summary').contains(panel())).toBe(false);
  const next = screen.getByRole('button', {name: 'Next point'});
  next.focus();
  fireEvent.click(next);
  expect(document.activeElement).toBe(next);
  act(() => setViewport('portrait'));
  act(() => setViewport('desktop'));
  expect(document.activeElement.id).toBe('pinned-point-description');
  click('Close point details');
  expect(document.activeElement).toBe(canvas);
});
test('cross-plot selection transfers the sole panel without hover or blur dismissing it', () => {
  const [first, second] = fixture(13, {second: true});
  home(first);
  const original = panel();
  fireEvent.pointerMove(second, {
    pointerType: 'mouse',
    clientX: 100,
    clientY: 100,
  });
  expect(panel()).toBe(original);
  fireEvent.blur(first, {relatedTarget: null});
  expect(panel()).toBe(original);
  home(second);
  expect(screen.getAllByRole('group', {name: 'Point details'})).toHaveLength(1);
  expect(within(panel()).getByText('1 / 3')).toBeTruthy();
  expect(panel()).toBe(original);
});
test('outside target activates before click dismissal restores width', () => {
  const [canvas] = fixture();
  home(canvas);
  const outside = screen.getByRole('button', {name: 'Outside action'});
  outside.addEventListener(
    'click',
    () =>
      expect(document.body.classList.contains('point-details-open')).toBe(true),
    {once: true},
  );
  fireEvent.pointerDown(outside);
  fireEvent.blur(canvas, {relatedTarget: outside});
  expect(panel()).toBeTruthy();
  fireEvent.click(outside);
  expect(screen.queryByRole('group', {name: 'Point details'})).toBeNull();
});
test('only first landscape pin and explicit dismissal reveal the source', () => {
  setViewport('landscape');
  const [canvas] = fixture();
  const scroll = vi.spyOn(canvas, 'scrollIntoView');
  home(canvas);
  expect(scroll).toHaveBeenCalledTimes(1);
  click('Next point');
  click('Next 10 points');
  expect(scroll).toHaveBeenCalledTimes(1);
  click('Close point details');
  expect(scroll).toHaveBeenCalledTimes(2);
  home(canvas);
  fireEvent.click(screen.getByRole('button', {name: 'Outside action'}));
  expect(scroll).toHaveBeenCalledTimes(3);
});
test('CSS-pixel hit testing scales with canvas bounds and touch has wider tolerance', () => {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 320;
  const points = [{x: 100, y: 50}];
  expect(
    nearestPoint({clientX: 135, clientY: 70}, canvas, points, 'mouse'),
  ).toBe(-1);
  expect(
    nearestPoint({clientX: 135, clientY: 70}, canvas, points, 'touch'),
  ).toBe(0);
  canvas.getBoundingClientRect = () => ({
    left: 10,
    top: 20,
    width: 640,
    height: 320,
  });
  expect(
    nearestPoint({clientX: 210, clientY: 120}, canvas, points, 'mouse'),
  ).toBe(0);
});
test('plain touch-origin clicks use initiating pointer type once, cancellation clears it', () => {
  const [canvas] = fixture(1);
  // A single point is horizontally centered (179), y66, in CSS canvas coordinates.
  fireEvent.pointerDown(canvas, {pointerType: 'touch'});
  fireEvent.click(canvas, {clientX: 214, clientY: 86});
  expect(panel()).toBeTruthy();
  click('Close point details');
  fireEvent.click(canvas, {clientX: 214, clientY: 86});
  expect(screen.queryByRole('group', {name: 'Point details'})).toBeNull();
  fireEvent.pointerDown(canvas, {pointerType: 'touch'});
  fireEvent.pointerCancel(canvas);
  fireEvent.click(canvas, {clientX: 214, clientY: 86});
  expect(screen.queryByRole('group', {name: 'Point details'})).toBeNull();
});
test('report re-renders progress without dropping selection; data revision removes stale details safely', () => {
  const snapshot = {
    report: {title: 'Test report', live: true, groups},
    benchmarks,
    data: rows(),
    progress: {total: 20, completed: 13, running: 2},
  };
  const view = render(
    <MantineProvider>
      <Report snapshot={snapshot} revision={1} />
    </MantineProvider>,
  );
  home(screen.getByRole('img', {name: /Absolute error cumulative/}));
  view.rerender(
    <MantineProvider>
      <Report
        snapshot={{
          ...snapshot,
          progress: {...snapshot.progress, completed: 14},
        }}
        revision={1}
      />
    </MantineProvider>,
  );
  expect(panel()).toBeTruthy();
  view.rerender(
    <MantineProvider>
      <Report snapshot={{...snapshot, data: rows(3)}} revision={2} />
    </MantineProvider>,
  );
  expect(document.body.classList.contains('overview-view')).toBe(true);
  expect(document.body.classList.contains('point-details-open')).toBe(false);
  view.rerender(
    <MantineProvider>
      <Report
        snapshot={{report: snapshot.report, benchmarks: {}, data: []}}
        revision={3}
      />
    </MantineProvider>,
  );
  expect(screen.queryByRole('group', {name: 'Point details'})).toBeNull();
});
test('scale preference survives switching views', () => {
  render(
    <MantineProvider>
      <Report snapshot={{report: {groups}, benchmarks, data: rows()}} />
    </MantineProvider>,
  );
  const scale = screen.getByRole('button', {name: 'X/Y log'}),
    before = scale.getAttribute('aria-pressed');
  fireEvent.click(scale);
  const after = scale.getAttribute('aria-pressed');
  expect(after).not.toBe(before);
  fireEvent.click(screen.getByRole('tab', {name: 'Example GPU'}));
  fireEvent.click(screen.getByRole('tab', {name: 'Overview'}));
  expect(
    screen.getByRole('button', {name: 'X/Y log'}).getAttribute('aria-pressed'),
  ).toBe(after);
});
test('live loading supports legacy snapshots, polls data and preserves chart identities on progress-only changes', async () => {
  vi.useFakeTimers();
  const raw = {
    report: {live: true},
    groups,
    benchmarks,
    points: rows(),
    progress: {completed: 1},
  };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce({ok: true, json: async () => raw})
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({...raw, progress: {completed: 2}}),
    });
  vi.stubGlobal('fetch', fetcher);
  let latest;
  function Probe() {
    latest = useReport();
    return null;
  }
  render(<Probe />);
  await act(async () => {});
  const first = latest.snapshot;
  expect(first.report.groups).toBe(groups);
  expect(first.data).toEqual(raw.points);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(latest.snapshot.progress.completed).toBe(2);
  expect(latest.snapshot.data).toBe(first.data);
  expect(latest.revision).toBe(1);
  expect(fetcher).toHaveBeenCalledWith(
    './data.json',
    expect.objectContaining({cache: 'no-store'}),
  );
  vi.unstubAllGlobals();
});
test('touch controls preserve manipulation while portrait panels reserve page-end clearance', () => {
  const css = fs.readFileSync('site/report.css', 'utf8');
  expect(css).toMatch(
    /\.point-controls, \.point-controls button, \.interactive-plot \.curve \{ touch-action: manipulation;/,
  );
  expect(css).toMatch(/padding-bottom: 50dvh/);
});
test('comparison pairing and tied rankings retain report semantics', () => {
  const data = rows(3),
    pairs = comparisonPairs(data, benchmarks);
  expect(pairs.map((pair) => pair.signedError)).toEqual([-100, -100, -100]);
  expect(rankStatistics(pairs)).toEqual({
    tau: 1,
    concordant: 3,
    measuredUnequal: 3,
    rho: 1,
  });
  const tied = [
    {actual: 1, prediction: 2},
    {actual: 1, prediction: 2},
    {actual: 3, prediction: 1},
  ];
  expect(rankStatistics(tied)).toEqual({
    tau: -1,
    concordant: 0,
    measuredUnequal: 2,
    rho: -1,
  });
});

test('status details on a benchmark without pairs survive progress-only live updates', () => {
  const data = rows(1).map((point) => ({
    ...point,
    values: {...point.values, sim: null},
    statuses: {
      sim: {state: 'unsupported', reason: 'Unavailable configuration'},
    },
  }));
  const snapshot = {
    report: {groups, live: true},
    benchmarks,
    data,
    progress: {total: 2, completed: 1, running: 1},
  };
  const view = render(
    <MantineProvider>
      <Report snapshot={snapshot} revision={1} />
    </MantineProvider>,
  );
  fireEvent.click(
    screen.getByRole('button', {name: /Unavailable configuration/}),
  );
  const message = screen.getByText(/Unavailable configuration/, {
    selector: 'p',
  });
  view.rerender(
    <MantineProvider>
      <Report
        snapshot={{
          ...snapshot,
          progress: {...snapshot.progress, completed: 2, running: 0},
        }}
        revision={1}
      />
    </MantineProvider>,
  );
  expect(screen.getByText(/Unavailable configuration/, {selector: 'p'})).toBe(
    message,
  );
});

test('interactive charts describe keyboard usage before and after pinning details', () => {
  const [canvas] = fixture();
  const hintId = canvas.getAttribute('aria-describedby');
  expect(document.getElementById(hintId).textContent).toMatch(
    /Arrow keys browse.*Escape closes details/,
  );
  home(canvas);
  expect(canvas.getAttribute('aria-describedby').split(' ')).toEqual([
    hintId,
    'pinned-point-description',
  ]);
  expect(document.getElementById('pinned-point-description')).toBeTruthy();
});

test.each(['pending', 'failed'])(
  'stored dark theme applies while report fetch is %s',
  async (state) => {
    localStorage.setItem('calibration-report-theme', 'dark');
    const fetcher =
      state === 'pending'
        ? vi.fn(() => new Promise(() => {}))
        : vi.fn().mockRejectedValue(new Error('Data unavailable'));
    vi.stubGlobal('fetch', fetcher);
    render(<App />);
    await act(async () => {});
    expect(screen.getByRole('status').textContent).toBe(
      'Waiting for report data',
    );
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.mantineColorScheme).toBe('dark');
  },
);

test('waiting page follows system color scheme before data arrives', () => {
  setSystemDark(true);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  );
  render(<App />);
  expect(document.documentElement.dataset.theme).toBe('dark');
  act(() => setSystemDark(false));
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(screen.getByRole('status').textContent).toBe(
    'Waiting for report data',
  );
});
