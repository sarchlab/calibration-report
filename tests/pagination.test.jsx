import {MantineProvider} from '@mantine/core';
import {fireEvent, render, screen, within} from '@testing-library/react';
import {expect, test} from 'vitest';
import {Report} from '../site/App.jsx';
import {pageWindow} from '../site/Pagination.jsx';

function fixture(benchmarkCount = 12, seriesCount = 8) {
  const benchmarks = {};
  const data = [];
  for (let i = 0; i < benchmarkCount; i++) {
    const id = 'benchmark_' + i;
    benchmarks[id] = {
      scaling_param: 'size', params: {size: {unit: ''}, launch: {unit: ''}},
      values: {
        hw: {name: 'Measured', unit: 'ns', role: 'hardware_measurement'},
        sim: {name: 'Simulated', unit: 'ns', role: 'simulator_output'},
      },
    };
    for (const group of ['a', 'b'])
      for (let launch = 0; launch < seriesCount; launch++)
        data.push({group, benchmark: id, x: 1, non_scaling_params: {launch}, values: {hw: 10 + launch, sim: 20 + launch}});
  }
  return {
    report: {title: 'Pagination fixture', groups: {a: {name: 'Device A'}, b: {name: 'Device B'}}},
    benchmarks, data,
  };
}
function mount(snapshot) {
  const view = render(<MantineProvider><Report snapshot={snapshot} /></MantineProvider>);
  return (next, revision = 0) => view.rerender(<MantineProvider><Report snapshot={next} revision={revision} /></MantineProvider>);
}
const switchDevice = (name = 'Device A') => fireEvent.click(screen.getByRole('tab', {name}));
const nav = (name) => screen.getByRole('navigation', {name: name + ' pagination'});
const jump = (name, page) => {
  const input = within(nav(name)).getByRole('textbox', {name: name + ' page'});
  fireEvent.change(input, {target: {value: String(page)}});
  fireEvent.keyDown(input, {key: 'Enter'});
};
const firstSeries = 'Series for benchmark 0';
const articles = () => screen.getAllByRole('article');
const pin = (article) => {
  const canvas = within(article).getAllByRole('img')[0];
  canvas.focus();
  fireEvent.keyDown(canvas, {key: 'Home'});
};

test('two-level pages mount only visible charts, preserve summary population and remember device pages', () => {
  mount(fixture());
  switchDevice();
  expect(articles()).toHaveLength(10);
  expect(articles()[0].querySelectorAll('.series')).toHaveLength(6);
  expect(screen.getByText('96 paired measurements')).toBeTruthy();
  const summary = screen.getByRole('region', {name: 'Accuracy summary'});
  const before = summary.textContent;
  const summaryCanvas = within(summary).getAllByRole('img')[0];
  jump(firstSeries, 2);
  expect(articles()[0].querySelectorAll('.series')).toHaveLength(2);
  expect(summary.textContent).toBe(before);
  expect(within(summary).getAllByRole('img')[0]).toBe(summaryCanvas);
  pin(articles()[0]);
  expect(screen.getByRole('group', {name: 'Point details'})).toBeTruthy();
  jump('Benchmark', 2);
  expect(articles()).toHaveLength(2);
  expect(screen.queryByRole('group', {name: 'Point details'})).toBeNull();
  expect(summary.textContent).toBe(before);
  switchDevice('Device B');
  expect(articles()).toHaveLength(10);
  expect(articles()[0].querySelectorAll('.series')).toHaveLength(6);
  switchDevice();
  expect(articles()).toHaveLength(2);
  jump('Benchmark', 1);
  expect(articles()[0].querySelectorAll('.series')).toHaveLength(2);
  pin(articles()[0]);
  jump(firstSeries, 1);
  expect(screen.queryByRole('group', {name: 'Point details'})).toBeNull();
});

test('page sizes and direct jumps reach every item and clamp invalid typed pages', () => {
  mount(fixture());
  switchDevice();
  fireEvent.change(within(nav('Benchmark')).getByRole('combobox'), {target: {value: '5'}});
  expect(articles()).toHaveLength(5);
  jump('Benchmark', 3);
  expect(articles()).toHaveLength(2);
  expect(within(articles()[1]).getByRole('heading', {level: 2}).textContent).toBe('benchmark 11');
  jump('Benchmark', 99);
  expect(within(nav('Benchmark')).getByRole('textbox').value).toBe('3');
  jump('Benchmark', 0);
  expect(within(nav('Benchmark')).getByRole('textbox').value).toBe('1');
  fireEvent.change(within(nav(firstSeries)).getByRole('combobox'), {target: {value: '12'}});
  expect(articles()[0].querySelectorAll('.series')).toHaveLength(8);
  switchDevice('Device B');
  switchDevice();
  expect(articles()).toHaveLength(5);
  expect(articles()[0].querySelectorAll('.series')).toHaveLength(8);
});

test('live refresh retains valid pages and persists clamps for inactive devices and series', () => {
  const original = fixture();
  const update = mount(original);
  switchDevice();
  jump(firstSeries, 2);
  jump('Benchmark', 2);
  update({...original, data: [...original.data]}, 1);
  expect(articles()).toHaveLength(2);
  expect(within(nav('Benchmark')).getByRole('textbox').value).toBe('2');
  switchDevice('Device B');
  const reduced = {...original, data: original.data.filter((point) => point.group === 'b' || (Number(point.benchmark.split('_')[1]) < 4 && point.non_scaling_params.launch < 3))};
  update(reduced, 2);
  update({...original, data: [...original.data]}, 3);
  switchDevice();
  expect(within(nav('Benchmark')).getByRole('textbox').value).toBe('1');
  expect(within(nav(firstSeries)).getByRole('textbox').value).toBe('1');
  expect(articles()[0].querySelectorAll('.series')).toHaveLength(6);
});

test('empty page ranges and page counts clamp without hiding the final items', () => {
  expect(pageWindow(0, {page: 3, size: 10}, 10)).toEqual({page: 1, size: 10, total: 1, start: 0, end: 0});
  expect(pageWindow(21, {page: 9, size: 10}, 10)).toEqual({page: 3, size: 10, total: 3, start: 20, end: 21});
});

test('unmounting benchmark plots leaves a selected summary chart intact', () => {
  mount(fixture(12, 1));
  switchDevice();
  const summary = screen.getByRole('region', {name: 'Accuracy summary'});
  pin(summary);
  const details = screen.getByRole('group', {name: 'Point details'});
  jump('Benchmark', 2);
  expect(screen.getByRole('group', {name: 'Point details'})).toBe(details);
  expect(articles()).toHaveLength(2);
});
