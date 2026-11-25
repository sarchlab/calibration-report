import {MantineProvider} from '@mantine/core';
import {fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {expect, test, vi} from 'vitest';
import {HostedReport, RunList} from '../site/Hosted.jsx';
import {buildSummary, isVisibleRow, summaryLimits} from '../site/model.js';

const benchmarks = {
  gemm: {
    scaling_param: 'size',
    params: {size: {unit: ''}, launch: {unit: ''}},
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
const manifest = (revision) => ({
  id: 7,
  revision,
  state: 'running',
  updated_at: new Date().toISOString(),
  report,
  group_ids: {a: 3, b: 4},
  group_order: ['a', 'b'],
  benchmark_keys: ['gemm'],
  progress: {total: 12, completed: 12, running: 0},
  benchmarks,
  plots: {a: [[0, 2]], b: [[0, 2]]},
});
function summary(scope, revision, computedAt) {
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
      limits: summaryLimits,
    }),
  };
}
function plotPage(group) {
  const plots = [0, 1].map((launch) => {
    const plotRows = rows
      .filter((row) => row.group === group && row.non_scaling_params.launch === launch)
      .filter(isVisibleRow)
      .map(({plot, ...point}) => point);
    return {id: 100 + launch, non_scaling_params: {launch}, rows: plotRows};
  });
  return {revision: 1, total: 2, plots, next: null};
}

function stubApi(state) {
  const calls = [];
  vi.stubGlobal('fetch', async (url) => {
    const path = String(url);
    calls.push(path);
    const query = new URLSearchParams(path.split('?')[1]);
    let body;
    if (path === 'api/v1/runs') body = [{key: 'demo', title: 'Hosted fixture', state: 'running', updated_at: new Date().toISOString()}];
    else if (path === 'api/v1/runs/demo') body = manifest(state.revision);
    else if (path.includes('/summary')) body = summary(query.get('scope'), state.revision, state.computedAt);
    else if (path.includes('/plots')) body = plotPage(query.get('group'));
    return {ok: true, status: 200, json: async () => body};
  });
  return calls;
}

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
  // Step a second at a time so React commits between polls.
  const advance = async (seconds) => {
    for (let i = 0; i < seconds; i++) await vi.advanceTimersByTimeAsync(1000);
  };
  await advance(50);
  expect(calls.filter((c) => c === 'api/v1/runs/demo').length).toBeGreaterThan(1);
  expect(summaries()).toBe(1);
  expect(screen.getByText(/Summary as of/)).toBeTruthy();
  await advance(30);
  expect(summaries()).toBe(2);
  expect(screen.queryByText(/Summary as of/)).toBeNull();
  vi.useRealTimers();
});
