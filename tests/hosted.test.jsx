import {MantineProvider} from '@mantine/core';
import {fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {HostedReport, RunList} from '../site/Hosted.jsx';
import {PointDescription} from '../site/PointDetails.jsx';
import {RunProgress} from '../site/Layout.jsx';
import {buildPairs, buildSummary, isVisibleRow, summaryLimits} from '../site/model.js';
import {pairPages} from '../netlify/lib/api.js';

const benchmarks = {
  gemm: {
    scaling_param: 'size',
    // Producer-chosen names that plain objects and key order mishandle.
    params: JSON.parse(
      '{"size":{"unit":""},"launch":{"unit":""},"__proto__":{"unit":""},' +
        '"constructor":{"unit":""},"10":{"unit":""},"2":{"unit":""}}',
    ),
    values: {
      hw: {name: 'Measured', unit: 'ns', role: 'hardware_measurement'},
      sim: {name: 'Simulated', unit: 'ns', role: 'simulator_output'},
    },
  },
};
const groups = [[3, 'a', 'Device A'], [4, 'b', 'Device B']];
const report = {
  title: 'Hosted fixture',
  description: '',
  live: true,
  groups: {a: {name: 'Device A'}, b: {name: 'Device B'}},
};
// Plot ids: launch 0 and 1 of each group.
const rows = groups.flatMap(([, group], g) =>
  [0, 1].flatMap((launch) =>
    [1, 2, 4].map((x) => ({
      group,
      benchmark: 'gemm',
      x,
      plot: 10 + 2 * g + launch,
      non_scaling_params: {launch},
      values: {hw: 100 * x, sim: 100 * x + 10 * (launch + 1)},
    })),
  ),
);
const paramKeys = [['size', 'launch', '__proto__', 'constructor', '10', '2']];
const manifest = (revision, state = 'running', completed = 12, updatedAt) => ({
  id: 7,
  revision,
  state,
  updated_at: updatedAt,
  report,
  group_ids: {a: 3, b: 4},
  group_order: ['a', 'b'],
  benchmark_keys: ['gemm'],
  param_keys: paramKeys,
  progress: {total: 24, completed, running: 0},
  benchmarks,
  plots: {a: [[0, 2]], b: [[0, 2]]},
});
// A benchmark that a later revision declares, with large errors.
const fftMeta = {
  scaling_param: 'n',
  params: {n: {unit: ''}},
  values: benchmarks.gemm.values,
};
const fftRows = [1, 2].map((x) => ({
  group: 'a', benchmark: 'fft', x, plot: 50, non_scaling_params: {},
  values: {hw: 100, sim: 900 + x},
}));
function summary(scope, revision, computedAt, limits = summaryLimits, fft = false) {
  const scoped = scope === 'overview' ? groups : groups.filter(([id]) => scope === 'group:' + id);
  const keys = scoped.map(([, key]) => key);
  return {
    rid: 7,
    key: 'demo',
    scope,
    revision,
    state: 'running',
    computed_at: computedAt,
    min_interval: 60,
    ...buildSummary({
      rows: [...rows, ...(fft ? fftRows : [])].filter((row) => keys.includes(row.group)),
      benchmarks: fft ? {...benchmarks, fft: fftMeta} : benchmarks,
      groups: scoped,
      overview: scope === 'overview',
    })(limits),
  };
}
// With `launchGroup`, both launches belong to launch group `k`, one chart.
function plotPage(group, bump = 0, launchGroup = false) {
  const plots = [0, 1].map((launch) => {
    const plotRows = rows
      .filter((row) => row.group === group && row.non_scaling_params.launch === launch)
      .filter(isVisibleRow)
      .map(({plot, ...point}) => ({...point, values: {...point.values, sim: point.values.sim + bump}}));
    // jsonb key order, and keys that object literals cannot hold.
    const params = JSON.parse(
      `{"2":"d","10":"c","constructor":"b","__proto__":"a","launch":${launch}` +
        (launchGroup ? ',"launch_group":"k"}' : '}'),
    );
    return {
      id: 100 + launch,
      chart: launchGroup ? 100 : 100 + launch,
      non_scaling_params: params,
      rows: plotRows.map((row) => ({...row, non_scaling_params: params})),
    };
  });
  return {revision: 1, total: 2, plots, next: null};
}

// A launch-ordinal page: one chart per x, whose launch count grows with x;
// plot 100 (launch #1) spans all three charts.
function ordinalPage(group) {
  const labels = ['#1 k1', '#2 k2', '#3 k1'];
  const plots = [1, 2, 4].flatMap((x, chart) =>
    labels.slice(0, chart + 1).map((launch, i) => ({
      id: 100 + i,
      chart: 200 + chart,
      non_scaling_params: {launch},
      rows: [{
        group, benchmark: 'gemm', x, non_scaling_params: {launch},
        values: {hw: 100 * x + i, sim: 110 * x + i},
      }],
    })),
  );
  return {revision: 1, total: 3, launch_ordinal: true, plots, next: null};
}

// `updatedAt` changes only when a test simulates a write or heartbeat.
function stubApi(state) {
  state.updatedAt ??= new Date().toISOString();
  const calls = [];
  vi.stubGlobal('fetch', async (url) => {
    const path = String(url);
    calls.push(path);
    const failure = state.failures?.find((f) => path.includes(f.match));
    if (failure) {
      state.failures.splice(state.failures.indexOf(failure), 1);
      if (failure.reject) throw new TypeError('Network down');
      if (failure.html)
        return {ok: false, status: 502, json: async () => JSON.parse('<html>')};
      return {ok: false, status: 500, json: async () => ({error: 'Server busy'})};
    }
    // A held response answers with the state at request time.
    const hold = state.holds?.find((h) => path === h.match || path.includes(h.match + '?'));
    const snapshot = {...state};
    if (hold) {
      state.holds.splice(state.holds.indexOf(hold), 1);
      await hold.promise;
      Object.assign(snapshot, hold.answer ?? {});
    }
    return respond(path, snapshot);
  });
  function respond(path, state) {
    const query = new URLSearchParams(path.split('?')[1]);
    let body;
    if (path === 'api/v1/runs') body = [{key: 'demo', title: 'Hosted fixture', state: 'running', updated_at: new Date().toISOString()}];
    else if (path === 'api/v1/runs/demo') {
      body = manifest(state.revision, state.state, state.completed, state.updatedAt);
      if (state.launchGroup) {
        const gemm = body.benchmarks.gemm;
        body.benchmarks = {gemm: {...gemm, params: {...gemm.params, launch_group: {unit: ''}}}};
        body.param_keys = [[...paramKeys[0], 'launch_group']];
        body.plots = {a: [[0, 1]], b: [[0, 1]]};
      }
      if (state.launchOrdinal) body.plots = {a: [[0, 3]], b: [[0, 3]]};
      if (state.manifestFft) {
        body.benchmarks = {...body.benchmarks, fft: fftMeta};
        body.benchmark_keys = [...body.benchmark_keys, 'fft'];
        body.param_keys = [...body.param_keys, ['n']];
      }
    } else if (path.includes('/summary')) {
      body = summary(
        query.get('scope'),
        state.summaryRevision ?? state.revision,
        state.computedAt,
        state.limits,
        state.summaryFft,
      );
      if (state.state) body.state = state.state;
      if (state.pointProgress) body.point_progress = state.pointProgress;
    }
    else if (path.includes('/pairs')) {
      // Every pair of the scope; with `pairsLimit`, in pages of that size.
      const scope = query.get('scope');
      const scoped = scope === 'overview' ? groups : groups.filter(([id]) => scope === 'group:' + id);
      const keys = scoped.map(([, key]) => key);
      const pages = pairPages(
        buildPairs({
          rows: rows.filter((row) => keys.includes(row.group)),
          benchmarks,
          groups: scoped,
          overview: scope === 'overview',
        }),
        {rid: 7, key: 'demo', scope, revision: state.pairsRevision ?? state.revision, state: 'running'},
        state.pairsLimit,
      );
      body = pages.find((page) => page.offset === Number(query.get('offset') ?? 0));
    }
    else if (path.includes('/plots') && state.launchOrdinal) body = ordinalPage(query.get('group'));
    else if (path.includes('/plots')) {
      body = plotPage(query.get('group'), state.bump, state.launchGroup);
      // With `plotRevisions`, a page comes in two chunks, each answered at
      // the next listed revision.
      if (state.plotRevisions) {
        body.revision = state.plotRevisions.shift() ?? body.revision;
        body = query.get('after')
          ? {...body, plots: body.plots.slice(1)}
          : {...body, plots: body.plots.slice(0, 1), next: '100:4'};
      }
    }
    const text = JSON.stringify(body);
    return {ok: true, status: 200, json: async () => JSON.parse(text)};
  }
  return calls;
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return {promise, resolve};
}

let visibility = 'visible';
Object.defineProperty(document, 'visibilityState', {
  configurable: true,
  get: () => visibility,
});
function setVisibility(value) {
  visibility = value;
  document.dispatchEvent(new Event('visibilitychange'));
}
// Step a second at a time so React commits between polls.
async function advance(seconds) {
  for (let i = 0; i < seconds; i++) await vi.advanceTimersByTimeAsync(1000);
}
afterEach(() => {
  vi.useRealTimers();
  visibility = 'visible';
});

const mount = (element) => render(<MantineProvider>{element}</MantineProvider>);

test('the run list links each run by key', async () => {
  stubApi({revision: 1});
  mount(<RunList />);
  const link = await screen.findByRole('link', {name: 'Hosted fixture'});
  expect(link.getAttribute('href')).toBe('?run=demo');
});

test('a hosted run shows the server summary and server-paged series', async () => {
  const calls = stubApi({revision: 1, computedAt: new Date().toISOString()});
  mount(<HostedReport runKey="demo" />);
  expect(await screen.findByText('Overview · Accuracy summary')).toBeTruthy();
  expect(screen.getByText('12 paired measurements')).toBeTruthy();
  expect(screen.getByText('Device A · Simulated vs. Measured')).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', {name: 'Device A'}));
  expect(await screen.findByText('Device A accuracy summary')).toBeTruthy();
  const card = await screen.findByRole('article');
  expect(within(card).getByText('Benchmark-wide error')).toBeTruthy();
  expect(card.querySelectorAll('.series')).toHaveLength(2);
  // Parameters follow declaration order, not the API's key order.
  for (const heading of card.querySelectorAll('.series h3'))
    expect(heading.textContent).toMatch(/^launch=\d · {3}proto {2}=a · constructor=b · 10=c · 2=d$/);
  expect(calls).toContain('api/v1/runs/demo/summary?rid=7&scope=group%3A3&format=2');
  expect(calls.some((c) => c.includes('/plots?rid=7&group=a&benchmark=gemm&offset=0&limit=6&format=3'))).toBe(true);
});

test('a hosted launch group gathers its plots into one median chart', async () => {
  stubApi({revision: 1, computedAt: new Date().toISOString(), launchGroup: true});
  mount(<HostedReport runKey="demo" />);
  expect(await screen.findByText('Overview · Accuracy summary')).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', {name: 'Device A'}));
  await screen.findByText('Benchmark-wide error');
  const card = screen.getByRole('article');
  expect(card.querySelectorAll('.series')).toHaveLength(1);
  expect(card.querySelector('.series h3').textContent).toBe(
    '  proto  =a · constructor=b · 10=c · 2=d · launch group=k',
  );
  // Statistics count both launches' pairs; the chart draws one median per X.
  expect(within(card).getAllByTitle('Based on 6 paired measurements').length).toBeGreaterThan(0);
  const canvas = within(card).getByRole('img');
  canvas.focus();
  fireEvent.keyDown(canvas, {key: 'Home'});
  expect(screen.getByText('1 / 6')).toBeTruthy();
  const details = document.querySelector('.point-detail-pinned');
  expect(within(details).getByText('Dispatches at this X').nextSibling.textContent).toBe('2');
  expect(within(details).getAllByText('median of 2')).toHaveLength(2);
});

test('a hosted launch-ordinal chart gathers its plots at one x over the launch ordinal', async () => {
  const calls = stubApi({revision: 1, computedAt: new Date().toISOString(), launchOrdinal: true});
  mount(<HostedReport runKey="demo" />);
  expect(await screen.findByText('Overview · Accuracy summary')).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', {name: 'Device A'}));
  await screen.findByText('Benchmark-wide error');
  expect(calls.some((c) => c.includes('&format=3'))).toBe(true);
  const card = screen.getByRole('article');
  expect([...card.querySelectorAll('.series h3')].map((h) => h.textContent)).toEqual([
    'size=1',
    'size=2',
    'size=4',
  ]);
  const canvas = within(card.querySelectorAll('.series')[2]).getByRole('img');
  expect(canvas.getAttribute('aria-label')).toMatch(/^Comparison by launch, linear X axis/);
  canvas.focus();
  fireEvent.keyDown(canvas, {key: 'End'});
  expect(screen.getByText('6 / 6')).toBeTruthy();
  // Details show the raw point: its launch label and its size.
  const details = document.querySelector('.point-detail-pinned');
  expect(details.querySelector('.point-kernel').textContent).toBe('#3 k1');
  expect(within(details).getByText('Size').nextSibling.textContent).toBe('4');
});

test('a plot page whose chunks span revisions is read again', async () => {
  const state = {
    revision: 1,
    computedAt: new Date().toISOString(),
    launchGroup: true,
    plotRevisions: [1, 2, 2, 2],
  };
  const calls = stubApi(state);
  mount(<HostedReport runKey="demo" />);
  expect(await screen.findByText('Overview · Accuracy summary')).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', {name: 'Device A'}));
  await screen.findByText('Benchmark-wide error');
  const pages = calls.filter((c) => c.includes('/plots?') && c.includes('group=a'));
  expect(pages).toHaveLength(4);
  expect(pages[1]).toContain('&after=100%3A4');
  expect(pages[2]).not.toContain('after=');
  const card = screen.getByRole('article');
  expect(card.querySelectorAll('.series')).toHaveLength(1);
  const canvas = within(card).getByRole('img');
  canvas.focus();
  fireEvent.keyDown(canvas, {key: 'Home'});
  const details = document.querySelector('.point-detail-pinned');
  expect(within(details).getByText('Dispatches at this X').nextSibling.textContent).toBe('2');
});

test('a live summary is re-requested only after new data and the interval', async () => {
  vi.useFakeTimers({shouldAdvanceTime: true});
  const state = {revision: 1, computedAt: new Date().toISOString()};
  const calls = stubApi(state);
  mount(<HostedReport runKey="demo" />);
  await screen.findByText('Overview · Accuracy summary');
  const summaries = () => calls.filter((c) => c.includes('/summary')).length;
  expect(summaries()).toBe(1);
  state.revision = 2;
  await advance(50);
  expect(calls.filter((c) => c === 'api/v1/runs/demo').length).toBeGreaterThan(1);
  expect(summaries()).toBe(1);
  expect(screen.getByText(/Summary as of/)).toBeTruthy();
  await advance(30);
  expect(summaries()).toBe(2);
  expect(screen.queryByText(/Summary as of/)).toBeNull();
  vi.useRealTimers();
});

test('a failed manifest poll is shown and polling continues', async () => {
  vi.useFakeTimers({shouldAdvanceTime: true});
  const state = {revision: 1, completed: 12, computedAt: new Date().toISOString(), failures: []};
  stubApi(state);
  mount(<HostedReport runKey="demo" />);
  await screen.findByText('Overview · Accuracy summary');
  state.failures.push({match: 'api/v1/runs/demo', reject: true});
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await screen.findByText('Update failed: Network down')).toBeTruthy();
  expect(screen.getByRole('button', {name: 'Retry'})).toBeTruthy();
  state.revision = 2;
  state.completed = 18;
  await vi.advanceTimersByTimeAsync(10_000);
  await waitFor(() => expect(screen.queryByText(/Update failed/)).toBeNull());
  expect(screen.getAllByText((_, el) => el?.textContent === '18').length).toBeGreaterThan(0);
  vi.useRealTimers();
});

test('failed summary and plot requests of a completed run can be retried', async () => {
  const state = {
    revision: 3,
    state: 'completed',
    computedAt: new Date().toISOString(),
    failures: [{match: '/summary'}],
  };
  const calls = stubApi(state);
  mount(<HostedReport runKey="demo" />);
  const summaryError = await screen.findByRole('alert');
  expect(summaryError.textContent).toContain('Could not load the summary: Server busy');
  fireEvent.click(within(summaryError).getByRole('button', {name: 'Retry'}));
  expect(await screen.findByText('Overview · Accuracy summary')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();

  state.failures.push({match: '/plots'});
  fireEvent.click(screen.getByRole('tab', {name: 'Device B'}));
  const plotError = await screen.findByText(/Could not load gemm: Server busy/);
  fireEvent.click(within(plotError).getByRole('button', {name: 'Retry'}));
  await waitFor(() =>
    expect(screen.getByRole('article').querySelectorAll('.series')).toHaveLength(2),
  );
  expect(calls.filter((c) => c.includes('/plots')).length).toBe(2);
});

test('a summary whose sample is empty shows exact statistics and no charts', async () => {
  stubApi({revision: 1, computedAt: new Date().toISOString(), limits: {scurve: 0, cdf: 0, scatter: 0}});
  mount(<HostedReport runKey="demo" />);
  expect(await screen.findByText('12 paired measurements')).toBeTruthy();
  expect(screen.getAllByText('No sample available')).toHaveLength(3);
});

test('the summary shows a loading state and non-JSON errors as HTTP status', async () => {
  const gate = deferred();
  const state = {
    revision: 1,
    computedAt: new Date().toISOString(),
    holds: [{match: 'api/v1/runs/demo/summary', promise: gate.promise}],
    failures: [],
  };
  stubApi(state);
  mount(<HostedReport runKey="demo" />);
  expect(await screen.findByText('Loading summary')).toBeTruthy();
  state.failures.push({match: '/summary', html: true});
  fireEvent.click(screen.getByRole('tab', {name: 'Device A'}));
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Could not load the summary: HTTP 502',
  );
  expect(screen.queryByText('Loading summary')).toBeNull();
  gate.resolve();
});

test('a failed plot refresh keeps the older page, marked stale, until Retry', async () => {
  vi.useFakeTimers({shouldAdvanceTime: true});
  const state = {revision: 1, computedAt: new Date().toISOString(), failures: []};
  stubApi(state);
  mount(<HostedReport runKey="demo" />);
  await screen.findByText('Overview · Accuracy summary');
  fireEvent.click(screen.getByRole('tab', {name: 'Device A'}));
  await waitFor(() => expect(document.querySelectorAll('.series')).toHaveLength(2));
  const statsText = () =>
    [...document.querySelectorAll('.series .stats')].map((el) => el.textContent).join('|');
  const live = statsText();
  Object.assign(state, {revision: 2, state: 'completed', bump: 50});
  state.failures.push({match: '/plots'});
  await advance(10);
  const alert = await screen.findByText(/Could not refresh gemm: Server busy/);
  expect(document.querySelector('.hosted-benchmark').dataset.stale).toBe('true');
  expect(statsText()).toBe(live);
  fireEvent.click(within(alert).getByRole('button', {name: 'Retry'}));
  await waitFor(() => expect(statsText()).not.toBe(live));
  expect(document.querySelector('.hosted-benchmark').dataset.stale).toBeUndefined();
  expect(screen.queryByText(/Could not refresh/)).toBeNull();
});

test('hiding and resuming during a pending poll keeps one chain and never rolls back', async () => {
  vi.useFakeTimers({shouldAdvanceTime: true});
  const state = {revision: 1, completed: 12, computedAt: new Date().toISOString(), holds: []};
  const calls = stubApi(state);
  mount(<HostedReport runKey="demo" />);
  await screen.findByText('Overview · Accuracy summary');
  const polls = () => calls.filter((c) => c === 'api/v1/runs/demo').length;
  const gate = deferred();
  state.holds.push({match: 'api/v1/runs/demo', promise: gate.promise, answer: {revision: 3, completed: 20}});
  await advance(10);
  expect(polls()).toBe(2);
  setVisibility('hidden');
  setVisibility('visible');
  await advance(1);
  expect(polls()).toBe(2); // the pending request is the only one
  gate.resolve();
  await waitFor(() => expect(screen.getByText('20')).toBeTruthy());
  // An older revision arriving later is ignored.
  Object.assign(state, {revision: 2, completed: 16});
  await advance(10);
  expect(polls()).toBe(3);
  await advance(10);
  expect(polls()).toBe(4);
  expect(screen.getByText('20')).toBeTruthy();
  expect(screen.queryByText('16')).toBeNull();
});

test('a summary behind the manifest is re-requested at most once per poll', async () => {
  vi.useFakeTimers({shouldAdvanceTime: true});
  // The client clock is ahead: the throttled summary always looks due.
  const state = {
    revision: 2,
    summaryRevision: 1,
    computedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  };
  const calls = stubApi(state);
  mount(<HostedReport runKey="demo" />);
  await screen.findByText('Overview · Accuracy summary');
  const summaries = () => calls.filter((c) => c.includes('/summary')).length;
  await advance(1);
  expect(summaries()).toBe(1);
  await advance(35);
  expect(calls.filter((c) => c === 'api/v1/runs/demo')).toHaveLength(4);
  expect(summaries()).toBe(4);
});

test('completion supersedes a pending live summary with the final one', async () => {
  vi.useFakeTimers({shouldAdvanceTime: true});
  const state = {
    revision: 1,
    summaryRevision: 1,
    computedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    holds: [],
  };
  const calls = stubApi(state);
  mount(<HostedReport runKey="demo" />);
  await screen.findByText('Overview · Accuracy summary');
  const gate = deferred();
  state.holds.push({match: 'api/v1/runs/demo/summary', promise: gate.promise});
  Object.assign(state, {revision: 2, summaryRevision: undefined});
  await advance(11); // the live summary request is held
  expect(calls.filter((c) => c.includes('/summary'))).toHaveLength(2);
  Object.assign(state, {revision: 3, state: 'completed'});
  await advance(10);
  await waitFor(() => expect(calls.filter((c) => c.includes('/summary'))).toHaveLength(3));
  gate.resolve(); // the superseded live response arrives last
  await advance(1);
  expect(screen.queryByText(/Summary as of/)).toBeNull();
  await advance(20);
  expect(calls.filter((c) => c.includes('/summary'))).toHaveLength(3);
  expect(calls.filter((c) => c === 'api/v1/runs/demo')).toHaveLength(3);
});

test('an unchanged manifest still triggers the summary at the first eligible poll', async () => {
  vi.useFakeTimers({shouldAdvanceTime: true});
  const state = {revision: 1, computedAt: new Date().toISOString()};
  const calls = stubApi(state);
  mount(<HostedReport runKey="demo" />);
  await screen.findByText('Overview · Accuracy summary');
  const summaries = () => calls.filter((c) => c.includes('/summary')).length;
  state.revision = 2; // a write, with updated_at kept fixed
  await advance(50);
  expect(summaries()).toBe(1);
  expect(screen.getByText(/Summary as of/)).toBeTruthy();
  await advance(15);
  expect(summaries()).toBe(2);
  await advance(30);
  expect(summaries()).toBe(2);
  expect(screen.queryByText(/Summary as of/)).toBeNull();
});

test('a run that goes quiet stops polling and offers Refresh', async () => {
  vi.useFakeTimers({shouldAdvanceTime: true});
  const state = {
    revision: 1,
    computedAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - 30 * 60_000 + 15_000).toISOString(),
  };
  const calls = stubApi(state);
  mount(<HostedReport runKey="demo" />);
  await screen.findByText('Overview · Accuracy summary');
  const polls = () => calls.filter((c) => c === 'api/v1/runs/demo').length;
  expect(screen.queryByRole('button', {name: 'Refresh'})).toBeNull();
  await advance(25);
  const refresh = await screen.findByRole('button', {name: 'Refresh'});
  expect(screen.getByText('No updates for 30 minutes')).toBeTruthy();
  const stopped = polls();
  await advance(30);
  expect(polls()).toBe(stopped);
  state.updatedAt = new Date().toISOString(); // the run wrote again
  fireEvent.click(refresh);
  await waitFor(() => expect(screen.queryByRole('button', {name: 'Refresh'})).toBeNull());
  await advance(11);
  expect(polls()).toBe(stopped + 2);
});

test('point details skip series a point lacks, even with inherited names', () => {
  const meta = JSON.parse(
    '{"b":{"scaling_param":"x","params":{"x":{"unit":""}},"values":{' +
      '"hw":{"name":"Measured","unit":"ns","role":"hardware_measurement"},' +
      '"constructor":{"name":"Builder","unit":"ns"},' +
      '"sim":{"name":"Simulated","unit":"ns","role":"simulator_output"}}}}',
  );
  const point = {
    group: 'a', benchmark: 'b', x: 1, non_scaling_params: {},
    values: {hw: 5, sim: null},
    statuses: {sim: {state: 'timeout', reason: 'took too long'}},
  };
  render(
    <MantineProvider>
      <PointDescription description={{point}} benchmarks={meta} groups={report.groups} />
    </MantineProvider>,
  );
  expect(document.querySelectorAll('.point-measurement')).toHaveLength(2);
  expect(screen.queryByText('Builder')).toBeNull();
  expect(screen.getByText('took too long')).toBeTruthy();
});

test('a summary ahead of the manifest waits for it before showing new benchmarks', async () => {
  vi.useFakeTimers({shouldAdvanceTime: true});
  const state = {revision: 1, computedAt: new Date(Date.now() - 10 * 60_000).toISOString()};
  const calls = stubApi(state);
  mount(<HostedReport runKey="demo" />);
  await screen.findByText('12 paired measurements');
  const select = (key) => {
    const [scurve] = screen.getAllByRole('img');
    scurve.focus();
    fireEvent.keyDown(scurve, {key});
  };
  // The manifest shows revision 2; the summary is computed at revision 3,
  // after a write that declared fft.
  Object.assign(state, {revision: 2, summaryRevision: 3, summaryFft: true});
  await advance(11);
  await waitFor(() => expect(calls.filter((c) => c.includes('/summary'))).toHaveLength(2));
  expect(screen.getByText('12 paired measurements')).toBeTruthy();
  select('End');
  expect(screen.getByRole('group', {name: 'Point details'})).toBeTruthy();
  Object.assign(state, {revision: 3, summaryRevision: undefined, manifestFft: true});
  await advance(10);
  expect(await screen.findByText('14 paired measurements')).toBeTruthy();
  select('End');
  expect(screen.getByRole('group', {name: 'Point details'}).textContent).toMatch(/^fftDevice A/);
});

test('a failed run offers Refresh and resumes polling when it runs again', async () => {
  vi.useFakeTimers({shouldAdvanceTime: true});
  const state = {revision: 1, state: 'failed', computedAt: new Date().toISOString()};
  const calls = stubApi(state);
  mount(<HostedReport runKey="demo" />);
  const refresh = await screen.findByRole('button', {name: 'Refresh'});
  const polls = () => calls.filter((c) => c === 'api/v1/runs/demo').length;
  await advance(15);
  expect(polls()).toBe(1);
  Object.assign(state, {state: undefined, revision: 2, updatedAt: new Date().toISOString()});
  fireEvent.click(refresh);
  await waitFor(() => expect(screen.queryByRole('button', {name: 'Refresh'})).toBeNull());
  await advance(11);
  expect(polls()).toBe(3);
});

test('a plot load in flight finishes before the next revision is fetched', async () => {
  vi.useFakeTimers({shouldAdvanceTime: true});
  const state = {revision: 1, computedAt: new Date().toISOString(), holds: []};
  const calls = stubApi(state);
  mount(<HostedReport runKey="demo" />);
  await screen.findByText('Overview · Accuracy summary');
  const gate = deferred();
  state.holds.push({match: 'api/v1/runs/demo/plots', promise: gate.promise});
  fireEvent.click(screen.getByRole('tab', {name: 'Device A'}));
  const plots = () => calls.filter((c) => c.includes('/plots')).length;
  await waitFor(() => expect(plots()).toBe(1));
  Object.assign(state, {revision: 2, bump: 50});
  await advance(11); // the poll sees revision 2 while the load is pending
  expect(plots()).toBe(1);
  gate.resolve();
  await waitFor(() => expect(plots()).toBe(2));
  await waitFor(() => expect(document.querySelectorAll('.series')).toHaveLength(2));
  await advance(11);
  expect(plots()).toBe(2);
});

test('refreshed rows clear a pinned point; a failed refresh keeps it', async () => {
  vi.useFakeTimers({shouldAdvanceTime: true});
  const state = {revision: 1, computedAt: new Date().toISOString(), failures: []};
  stubApi(state);
  mount(<HostedReport runKey="demo" />);
  await screen.findByText('Overview · Accuracy summary');
  fireEvent.click(screen.getByRole('tab', {name: 'Device A'}));
  await waitFor(() => expect(document.querySelectorAll('.series')).toHaveLength(2));
  const canvas = document.querySelector('.series canvas');
  canvas.focus();
  fireEvent.keyDown(canvas, {key: 'Home'});
  const details = () => screen.queryByRole('group', {name: 'Point details'});
  expect(details()).toBeTruthy();
  Object.assign(state, {revision: 2, bump: 50});
  state.failures.push({match: '/plots'});
  await advance(11);
  const alert = await screen.findByText(/Could not refresh gemm/);
  expect(details()).toBeTruthy(); // the old page, and its selection, stay
  fireEvent.click(within(alert).getByRole('button', {name: 'Retry'}));
  await waitFor(() => expect(screen.queryByText(/Could not refresh/)).toBeNull());
  expect(details()).toBeNull();
});

test('the progress card shows the summary point progress, labelled in points', async () => {
  const held = deferred();
  stubApi({
    revision: 1,
    computedAt: new Date().toISOString(),
    pointProgress: {total: 30, completed: 20, running: 3, failed: 2, queued: 5},
    holds: [{match: 'api/v1/runs/demo/summary', promise: held.promise}],
  });
  mount(<HostedReport runKey="demo" />);
  // The stored progress counts configurations until the summary arrives.
  const card = await screen.findByRole('region', {name: 'Run progress'});
  expect(within(card).getByText('24 configurations')).toBeTruthy();
  held.resolve();
  expect(await within(card).findByText('30 points')).toBeTruthy();
  const count = (label) =>
    within(card).getByText(label).closest('li').querySelector('strong').textContent;
  expect([count('Completed'), count('Running'), count('Failed'), count('Not started')]).toEqual(
    ['20', '3', '2', '5'],
  );
});

test('Download CSV pages every plot and saves one file named after the run', async () => {
  const calls = stubApi({revision: 1, computedAt: new Date().toISOString()});
  const saved = [];
  // jsdom has no object URLs.
  URL.createObjectURL = (blob) => {
    saved.push(blob);
    return 'blob:csv';
  };
  URL.revokeObjectURL = () => {};
  const clicks = [];
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(function () {
      clicks.push(this.download);
    });
  mount(<HostedReport runKey="demo" />);
  fireEvent.click(await screen.findByRole('button', {name: 'Download CSV'}));
  await waitFor(() => expect(clicks).toEqual(['demo.csv']));
  click.mockRestore();
  delete URL.createObjectURL;
  delete URL.revokeObjectURL;
  const text = await saved[0].text();
  const lines = text.split('\r\n');
  expect(lines[0]).toBe(
    'benchmark,group,scaling_param,x,launch,__proto__,constructor,10,2,' +
      'hw,hw_state,hw_reason,sim,sim_state,sim_reason',
  );
  expect(lines.slice(1, -1)).toHaveLength(12);
  expect(lines[1]).toBe('gemm,a,size,1,0,a,b,c,d,100,,,110,,');
  expect(calls.filter((c) => c.includes('/plots?') && c.includes('limit=48'))).toHaveLength(2);
  expect(screen.getByRole('button', {name: 'Download CSV'}).disabled).toBe(false);
});

test('a failed CSV download keeps its error until a retry succeeds', async () => {
  const state = {
    revision: 1,
    computedAt: new Date().toISOString(),
    failures: [{match: 'group=a&benchmark=gemm&offset=0&limit=48'}],
  };
  const calls = stubApi(state);
  const saved = [];
  URL.createObjectURL = (blob) => {
    saved.push(blob);
    return 'blob:csv';
  };
  URL.revokeObjectURL = () => {};
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  mount(<HostedReport runKey="demo" />);
  fireEvent.click(await screen.findByRole('button', {name: 'Download CSV'}));
  expect((await screen.findByRole('alert')).textContent).toBe('CSV failed: Server busy');
  // The sibling worker (group b) finishing later does not clear the error.
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.getByRole('alert').textContent).toBe('CSV failed: Server busy');
  expect(saved).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', {name: 'Download CSV'}));
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(screen.queryByRole('alert')).toBeNull();
  expect((await saved[0].text()).split('\r\n').slice(1, -1)).toHaveLength(12);
  expect(calls.filter((c) => c.includes('/plots?') && c.includes('limit=48'))).toHaveLength(4);
  click.mockRestore();
  delete URL.createObjectURL;
  delete URL.revokeObjectURL;
});

test('a failed save shows its error and a retry saves the file', async () => {
  stubApi({revision: 1, computedAt: new Date().toISOString()});
  const saved = [];
  let fail = true;
  URL.createObjectURL = (blob) => {
    if (fail) {
      fail = false;
      throw new Error('Out of memory');
    }
    saved.push(blob);
    return 'blob:csv';
  };
  URL.revokeObjectURL = () => {};
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  mount(<HostedReport runKey="demo" />);
  fireEvent.click(await screen.findByRole('button', {name: 'Download CSV'}));
  expect((await screen.findByRole('alert')).textContent).toBe('CSV failed: Out of memory');
  expect(screen.getByRole('button', {name: 'Download CSV'}).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', {name: 'Download CSV'}));
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(screen.queryByRole('alert')).toBeNull();
  click.mockRestore();
  delete URL.createObjectURL;
  delete URL.revokeObjectURL;
});

test('the non-live progress card shows the unit next to the completed ratio', () => {
  mount(
    <>
      <RunProgress progress={{total: 30, completed: 28, running: 0}} live={false} unit="points" />
      <RunProgress progress={{total: 5, completed: 5, running: 0}} live={false} />
    </>,
  );
  expect(screen.getByText('28 / 30 points')).toBeTruthy();
  expect(screen.getByText('5 / 5 configurations')).toBeTruthy();
});

describe('expanded summary charts', () => {
  const testMount = (element) => render(<MantineProvider env="test">{element}</MantineProvider>);
  const overlay = async (name) => {
    fireEvent.click(await screen.findByRole('button', {name: new RegExp('^Expand ' + name)}));
    return within(screen.getByRole('dialog')).getByRole('img');
  };
  const pairsCalls = (calls) => calls.filter((path) => path.includes('/pairs'));
  // The pinned details' "index / count" of the overlay's last drawn point.
  const lastPoint = (canvas) => {
    fireEvent.keyDown(canvas, {key: 'End'});
    return within(screen.getByRole('dialog')).getByRole('group', {name: 'Point details'});
  };

  test('load every pair once, on the first zoom, and draw zoomed views from it', async () => {
    // A two-point sample of twelve comparisons.
    const limits = {scurve: 2, cdf: 2, scatter: 2};
    const calls = stubApi({revision: 1, computedAt: new Date().toISOString(), limits, pairsLimit: 640});
    testMount(<HostedReport runKey="demo" />);
    const canvas = await overlay('S-curve');
    expect(pairsCalls(calls)).toEqual([]);
    expect(lastPoint(canvas).textContent).toContain('2 / 2');
    fireEvent.wheel(canvas, {deltaY: -10, clientX: 170, clientY: 90});
    expect(screen.getByText('Loading full data…').getAttribute('role')).toBe('status');
    await waitFor(() => expect(screen.queryByText('Loading full data…')).toBeNull());
    // Paged: continuations name the canonical scope and the first page's revision.
    const pages = pairsCalls(calls);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0]).toBe('api/v1/runs/demo/pairs?rid=7&scope=overview&format=1');
    expect(pages[1]).toMatch(/scope=overview&format=1&offset=\d+&revision=1$/);
    // The zoomed view draws all twelve, ranked among all twelve.
    const details = lastPoint(canvas);
    expect(details.textContent).toContain('12 / 12');
    expect(details.textContent).toContain('Case rank12');
    // Later gestures, and the other charts of the same summary, reuse it.
    fireEvent.wheel(canvas, {deltaY: -10, clientX: 170, clientY: 90});
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', {name: 'Close expanded chart'}));
    const scatter = await overlay('Measured vs. simulated');
    fireEvent.wheel(scatter, {deltaY: -10, clientX: 170, clientY: 90});
    await waitFor(() => expect(lastPoint(scatter).textContent).toMatch(/\b(1[0-2]|[3-9]) \/ /));
    expect(pairsCalls(calls)).toHaveLength(pages.length);
    // Reset returns to the sample.
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', {name: 'Reset zoom'}));
    expect(lastPoint(scatter).textContent).toContain('2 / 2');
  });

  test('keep drawing the sample when the pairs fail to load', async () => {
    const limits = {scurve: 2, cdf: 2, scatter: 2};
    const calls = stubApi({
      revision: 1,
      computedAt: new Date().toISOString(),
      limits,
      failures: [{match: '/pairs'}],
    });
    testMount(<HostedReport runKey="demo" />);
    const canvas = await overlay('Absolute error distribution \\(CDF\\)');
    fireEvent.wheel(canvas, {deltaY: -10, clientX: 170, clientY: 90});
    expect(await screen.findByText('Full data unavailable; showing the sample')).toBeTruthy();
    expect(pairsCalls(calls)).toHaveLength(1);
    expect(lastPoint(canvas).textContent).toMatch(/[12] \/ [12]/);
  });

  test('restart paging when the cached pairs move to a newer revision', async () => {
    const limits = {scurve: 2, cdf: 2, scatter: 2};
    const state = {revision: 1, computedAt: new Date().toISOString(), limits, pairsLimit: 640};
    const calls = stubApi(state);
    const fetchStub = globalThis.fetch;
    let moved = false;
    vi.stubGlobal('fetch', async (url) => {
      // The first continuation finds the record moved on.
      if (String(url).includes('revision=') && !moved) {
        moved = true;
        calls.push(String(url));
        return {ok: false, status: 503, json: async () => ({error: 'The run changed; start over'})};
      }
      return fetchStub(url);
    });
    testMount(<HostedReport runKey="demo" />);
    const canvas = await overlay('S-curve');
    fireEvent.wheel(canvas, {deltaY: -10, clientX: 170, clientY: 90});
    await waitFor(() => expect(screen.queryByText('Loading full data…')).toBeNull());
    expect(screen.queryByText('Full data unavailable; showing the sample')).toBeNull();
    const first = pairsCalls(calls).filter((path) => !path.includes('offset='));
    expect(first).toHaveLength(2);
    expect(lastPoint(canvas).textContent).toContain('12 / 12');
  });
});
