import {MantineProvider} from '@mantine/core';
import {fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, expect, test, vi} from 'vitest';
import {HostedReport, RunList} from '../site/Hosted.jsx';
import {buildSummary, isVisibleRow, summaryLimits} from '../site/model.js';

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
function summary(scope, revision, computedAt, limits = summaryLimits) {
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
      rows: rows.filter((row) => keys.includes(row.group)),
      benchmarks,
      groups: scoped,
      overview: scope === 'overview',
    })(limits),
  };
}
function plotPage(group, bump = 0) {
  const plots = [0, 1].map((launch) => {
    const plotRows = rows
      .filter((row) => row.group === group && row.non_scaling_params.launch === launch)
      .filter(isVisibleRow)
      .map(({plot, ...point}) => ({...point, values: {...point.values, sim: point.values.sim + bump}}));
    // jsonb key order, and keys that object literals cannot hold.
    const params = JSON.parse(
      `{"2":"d","10":"c","constructor":"b","__proto__":"a","launch":${launch}}`,
    );
    return {
      id: 100 + launch,
      non_scaling_params: params,
      rows: plotRows.map((row) => ({...row, non_scaling_params: params})),
    };
  });
  return {revision: 1, total: 2, plots, next: null};
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
    else if (path === 'api/v1/runs/demo')
      body = manifest(state.revision, state.state, state.completed, state.updatedAt);
    else if (path.includes('/summary')) {
      body = summary(
        query.get('scope'),
        state.summaryRevision ?? state.revision,
        state.computedAt,
        state.limits,
      );
      if (state.state) body.state = state.state;
    }
    else if (path.includes('/plots')) body = plotPage(query.get('group'), state.bump);
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
  expect(calls).toContain('api/v1/runs/demo/summary?rid=7&scope=group%3A3');
  expect(calls.some((c) => c.includes('/plots?rid=7&group=a&benchmark=gemm&offset=0&limit=2'))).toBe(true);
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
