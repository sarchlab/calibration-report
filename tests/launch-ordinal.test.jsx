import {MantineProvider} from '@mantine/core';
import {fireEvent, render, screen, within} from '@testing-library/react';
import {describe, expect, test} from 'vitest';
import {Report} from '../site/App.jsx';
import {drawChart} from '../site/drawing.js';
import {indexReport, launchOrdinalBenchmarks, parseLaunch} from '../site/model.js';
import {
  fdtdPoints,
  gaussianPoints,
  launchOrdinalReport,
  nwPoints,
  sradPoints,
} from './launch-fixture.js';

const {benchmarks} = launchOrdinalReport();
const ordinalOf = (data) => [...launchOrdinalBenchmarks(data)];
const seriesOf = (data, benchmark) =>
  indexReport(data, benchmarks)
    .groups.get('gpu')
    .benchmarks.find((b) => b.id === benchmark).series;

describe('launch labels', () => {
  test('parse the ordinal and the kernel name', () => {
    expect(parseLaunch({launch: '#912 nw_kernel2'})).toEqual({ordinal: 912, kernel: 'nw_kernel2'});
    expect(parseLaunch({launch: '#3 a kernel with spaces'})).toEqual({
      ordinal: 3,
      kernel: 'a kernel with spaces',
    });
    for (const launch of ['912 nw', '#x nw', '#12', '#12 ', ' #1 k', '#١ k', 12, true])
      expect(parseLaunch({launch})).toBeNull();
    expect(parseLaunch({})).toBeNull();
  });
});

describe('launch-ordinal benchmarks', () => {
  test('a launch count that grows with the scaling value pivots to one chart per (params, x)', () => {
    expect(ordinalOf([...nwPoints(), ...sradPoints(), ...gaussianPoints()]).sort()).toEqual([
      JSON.stringify(['gpu', 'rodinia_gaussian']),
      JSON.stringify(['gpu', 'rodinia_nw']),
    ]);
    const series = seriesOf(nwPoints(), 'rodinia_nw');
    // Two penalties × three sizes, instead of one chart per launch label.
    expect(series).toHaveLength(6);
    expect(series.every((s) => s.launchOrdinal)).toBe(true);
    for (const s of series) {
      const [{x, non_scaling_params: params}] = s.rows;
      expect(s.rows.every((row) => row.x === x && row.non_scaling_params.penalty === params.penalty)).toBe(true);
      expect(s.rows).toHaveLength((2 * x) / 16 - 1);
      expect(s.pairs).toHaveLength(s.rows.length);
    }
    expect(seriesOf(gaussianPoints(), 'rodinia_gaussian')).toHaveLength(2);
  });

  test('a fixed launch count keeps one chart per launch', () => {
    expect(ordinalOf(sradPoints())).toEqual([]);
    const series = seriesOf(sradPoints(), 'rodinia_srad');
    expect(series).toHaveLength(2);
    expect(series.every((s) => s.rows.length === 3 && !('launchOrdinal' in s))).toBe(true);
  });

  test('launch groups keep their median charts', () => {
    const grouped = nwPoints().map((point) => ({
      ...point,
      non_scaling_params: {...point.non_scaling_params, launch_group: 'diagonal'},
    }));
    expect(ordinalOf(grouped)).toEqual([]);
    expect(seriesOf(grouped, 'rodinia_nw')).toHaveLength(2);
    expect(ordinalOf(fdtdPoints({tmax: 2}))).toEqual([]);
  });

  test('labels without an ordinal leave the benchmark unchanged', () => {
    const plain = nwPoints({label: (k, kernel) => k + ' ' + kernel});
    expect(ordinalOf(plain)).toEqual([]);
    // One chart per (penalty, label), as before: k=3 is kernel2 at n=32 and
    // kernel1 at n=48, so each penalty has nine labels.
    expect(seriesOf(plain, 'rodinia_nw')).toHaveLength(2 * 9);
    // One malformed label is enough.
    const one = nwPoints();
    one[4] = {...one[4], non_scaling_params: {...one[4].non_scaling_params, launch: 'diagonal'}};
    expect(ordinalOf(one)).toEqual([]);
  });

  test('groups and benchmarks are judged separately', () => {
    const data = [...nwPoints(), ...sradPoints({benchmark: 'rodinia_nw', group: 'cpu'})];
    expect(ordinalOf(data)).toEqual([JSON.stringify(['gpu', 'rodinia_nw'])]);
  });
});

describe('drawing', () => {
  // Path calls of each stroke, with the x axis read from the tick labels.
  const draw = (spec) => {
    const strokes = [];
    let path = [];
    const texts = [];
    const target = {};
    const context = new Proxy(target, {
      get(_, name) {
        if (name === 'measureText') return (text) => ({width: String(text).length * 5});
        if (name === 'beginPath') return () => (path = []);
        if (name === 'moveTo' || name === 'lineTo') return (x, y) => path.push([name, x, y]);
        if (name === 'stroke') return () => strokes.push({color: target.strokeStyle, path});
        if (name === 'fillText') return (text) => texts.push(String(text));
        if (name in target) return target[name];
        return () => {};
      },
      set(_, name, value) {
        target[name] = value;
        return true;
      },
    });
    const canvas = document.createElement('canvas');
    canvas.getContext = () => context;
    const drawing = drawChart(
      canvas,
      {
        kind: 'curve',
        curves: [
          {id: 'hw', ...benchmarks.rodinia_nw.values.hw, color: '#765'},
          {id: 'sim', ...benchmarks.rodinia_nw.values.sim, color: '#375'},
        ],
        xLabel: 'launch',
        unit: 'ns',
        bounds: {min: 1, max: 1e4},
        scales: {x: false, y: false},
        ...spec,
      },
      {grid: '#ddd', label: '#333'},
      benchmarks,
    );
    return {strokes: strokes.filter((s) => s.color === '#375'), texts, drawing};
  };
  const ordinal = {
    xOf: (row) => parseLaunch(row.non_scaling_params).ordinal,
    lineOf: (row) => parseLaunch(row.non_scaling_params).kernel,
  };

  test('x is the launch ordinal and each kernel is its own line', () => {
    const rows = gaussianPoints({sizes: [4]});
    const {strokes, drawing} = draw({rows, ...ordinal});
    // Fan1 at 1, 3, 5 and Fan2 at 2, 4, 6: two lines of three points.
    const [{path}] = strokes.filter((s) => s.path.length);
    expect(path.map(([name]) => name)).toEqual([
      'moveTo', 'lineTo', 'lineTo', 'moveTo', 'lineTo', 'lineTo',
    ]);
    const xs = path.map(([, x]) => x);
    expect(xs.slice(0, 3).map((x, i) => x < xs[3 + i])).toEqual([true, true, true]);
    expect(drawing.xPosition(1)).toBeCloseTo(xs[0] / 320);
    expect(drawing.xPosition(6)).toBeCloseTo(xs[5] / 320);
    // Point details stay raw: the size and the launch label.
    expect(drawing.hitPoints[0].description.point).toBe(rows[0]);
  });

  test('without lineOf every curve stays one line', () => {
    const rows = sradPoints({sizes: [64, 128, 256]}).filter((row) => row.non_scaling_params.launch === '#1 srad_cuda_1');
    const [{path}] = draw({rows}).strokes.filter((s) => s.path.length);
    expect(path.map(([name]) => name)).toEqual(['moveTo', 'lineTo', 'lineTo']);
  });
});

describe('file viewer', () => {
  test('launch-ordinal charts are headed by their params and x, over a linear launch axis', () => {
    render(
      <MantineProvider>
        <Report snapshot={launchOrdinalReport()} />
      </MantineProvider>,
    );
    fireEvent.click(screen.getByRole('tab', {name: 'GPU'}));
    const [nw, srad] = screen.getAllByRole('article');
    const headings = [...nw.querySelectorAll('.series h3')].map((h) => h.textContent);
    expect(headings).toEqual([
      'penalty=1 · n=32',
      'penalty=1 · n=48',
      'penalty=1 · n=64',
      'penalty=10 · n=32',
      'penalty=10 · n=48',
      'penalty=10 · n=64',
    ]);
    const canvas = within(nw.querySelectorAll('.series')[2]).getByRole('img');
    expect(canvas.getAttribute('aria-label')).toMatch(/^Comparison by launch, linear X axis/);
    // Seven launches per curve at n=64.
    canvas.focus();
    fireEvent.keyDown(canvas, {key: 'End'});
    expect(screen.getByText('14 / 14')).toBeTruthy();
    expect(document.querySelector('.point-kernel').textContent).toBe('#7 nw_kernel2');
    // SRAD keeps a chart per launch over the size.
    const sradHeadings = [...srad.querySelectorAll('.series h3')].map((h) => h.textContent);
    expect(sradHeadings).toEqual(['launch=#1 srad_cuda_1', 'launch=#2 srad_cuda_2']);
  });
});
