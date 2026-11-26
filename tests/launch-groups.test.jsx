import {MantineProvider} from '@mantine/core';
import {fireEvent, render, screen, within} from '@testing-library/react';
import {describe, expect, test} from 'vitest';
import {Report} from '../site/App.jsx';
import {PointDescription} from '../site/PointDetails.jsx';
import {drawChart} from '../site/drawing.js';
import {
  buildSummary,
  chartParams,
  comparisonPairs,
  errorStats,
  indexReport,
  launchGroupRows,
  quantile,
} from '../site/model.js';
import {fdtdBenchmark, fdtdPoints, fdtdReport} from './launch-fixture.js';

const benchmarks = {polybench_fdtd2d: fdtdBenchmark};
const curves = [
  {id: 'hw', color: '#765'},
  {id: 'sim', color: '#375'},
];
const median = (values) => quantile([...values].sort((a, b) => a - b), 0.5);
const seriesOf = (data) =>
  indexReport(data, benchmarks).groups.get('gpu').benchmarks[0].series;
const groupOf = (series) => series.rows[0].non_scaling_params.launch_group;
// Every curve's drawn rows for one series, as Benchmark builds them.
const drawnRows = (series) =>
  launchGroupRows(
    [...series.rows].sort((a, b) => a.x - b.x),
    curves,
    series.pairs,
  );

describe('chart identity', () => {
  test('drops launch only when a launch group is present', () => {
    expect(chartParams({tmax: 2, launch: 7, launch_group: 'g'})).toEqual({
      tmax: 2,
      launch_group: 'g',
    });
    const plain = {tmax: 2, launch: 7};
    expect(chartParams(plain)).toBe(plain);
  });

  test('FDTD2D tmax=200 has six charts per fixed parameter combination', () => {
    const series = seriesOf(fdtdReport({}, [200, 100]).data);
    expect(series).toHaveLength(12);
    for (const tmax of [200, 100]) {
      const charts = series.filter((s) => s.rows[0].non_scaling_params.tmax === tmax);
      expect(charts.map(groupOf).sort()).toEqual([
        'fdtd_update_ex',
        'fdtd_update_ex_first',
        'fdtd_update_ey',
        'fdtd_update_ey_first',
        'fdtd_update_hz',
        'fdtd_update_hz_first',
      ]);
      for (const chart of charts) {
        const perX = groupOf(chart).endsWith('_first') ? 1 : tmax - 1;
        expect(chart.rows).toHaveLength(3 * perX);
        expect(new Set(chart.rows.map((row) => row.non_scaling_params.launch)).size).toBe(perX);
      }
    }
    expect(series.reduce((n, s) => n + s.rows.length, 0)).toBe(3 * 600 + 3 * 300);
  });

  test('a benchmark without launch groups keeps one chart per launch', () => {
    const data = fdtdPoints({tmax: 2}).map(({non_scaling_params: {launch_group, ...rest}, ...point}) => ({
      ...point,
      non_scaling_params: rest,
    }));
    const series = seriesOf(data);
    expect(series).toHaveLength(6);
    expect(series.every((s) => s.rows.length === 3)).toBe(true);
  });
});

describe('medians and bands', () => {
  const dispatches = (n, values = (i) => ({hw: 100 + i, sim: 200 + 2 * i})) =>
    Array.from({length: n}, (_, i) => ({
      group: 'gpu',
      benchmark: 'polybench_fdtd2d',
      x: 1,
      non_scaling_params: {tmax: 9, launch: i, launch_group: 'g'},
      values: values(i),
    }));
  const rowsFor = (rows) => launchGroupRows(rows, curves, comparisonPairs(rows, benchmarks));

  test('band levels need 4, 10, and 50 dispatches; a singleton has none', () => {
    const levels = (n) => rowsFor(dispatches(n))[0].launches.curves.hw.bands.map(Boolean);
    expect(levels(1)).toEqual([false, false, false]);
    expect(levels(3)).toEqual([false, false, false]);
    expect(levels(4)).toEqual([false, false, true]);
    expect(levels(9)).toEqual([false, false, true]);
    expect(levels(10)).toEqual([false, true, true]);
    expect(levels(49)).toEqual([false, true, true]);
    expect(levels(50)).toEqual([true, true, true]);
    const [row] = rowsFor(dispatches(1));
    expect(row.values).toEqual({hw: 100, sim: 200});
    expect(row.non_scaling_params).toEqual({tmax: 9, launch_group: 'g'});
  });

  test('both medians use the same valid pairs; unpaired values stay out', () => {
    // Odd dispatches have no simulated value (one timed out, one absent).
    const rows = dispatches(10, (i) =>
      i % 2 ? {hw: 1000 + i} : {hw: 100 + i, sim: 300 + i},
    );
    rows[1].statuses = {sim: {state: 'timeout'}};
    const [row] = rowsFor(rows);
    expect(row.launches.rows).toHaveLength(10);
    expect(row.launches.comparisons).toEqual([
      {
        id: JSON.stringify(['hw', 'sim']),
        name: 'Simulator kernel time vs. GPU kernel time',
        count: 5,
      },
    ]);
    expect(row.values.hw).toBe(median([100, 102, 104, 106, 108]));
    expect(row.values.sim).toBe(median([300, 302, 304, 306, 308]));
    expect(row.launches.curves.hw.sorted).toEqual([100, 102, 104, 106, 108]);
    expect(row.launches.curves.sim.bands).toEqual([null, null, [302, 306]]);
  });

  test('hardware-only dispatches still draw the hardware curve', () => {
    const [row] = rowsFor(dispatches(5, (i) => ({hw: 10 * (i + 1)})));
    expect(row.values).toEqual({hw: 30});
    expect(row.launches.comparisons).toEqual([]);
    expect(row.launches.curves.hw.bands).toEqual([null, null, [20, 40]]);
  });

  test('medians are compared only over one non-empty paired set', () => {
    const hitComparisons = (rows) =>
      drawChart(
        document.createElement('canvas'),
        {
          kind: 'curve',
          rows: rowsFor(rows),
          curves,
          xLabel: 'size',
          unit: 'ns',
          bounds: {min: 1, max: 1e3},
          scales: {x: false, y: false},
        },
        {grid: '#ddd', label: '#333'},
        benchmarks,
      ).hitPoints.map((point) => point.description.comparisons.length);
    // One dispatch has only a measured value, the other only a simulated one:
    // both medians fall back to unpaired values.
    const unpaired = dispatches(2, (i) => (i ? {sim: 200} : {hw: 100}));
    expect(rowsFor(unpaired)[0].values).toEqual({hw: 100, sim: 200});
    expect(hitComparisons(unpaired)).toEqual([0, 0]);
    expect(hitComparisons(dispatches(3))).toEqual([1, 1]);
  });

  test('producer-chosen series keys survive as median values', () => {
    const meta = JSON.parse(
      '{"b":{"scaling_param":"x","params":{"x":{"unit":""}},' +
        '"values":{"__proto__":{"name":"Odd","unit":"ns"}}}}',
    );
    const rows = [5, 7, 9].map((value, launch) => ({
      group: 'gpu',
      benchmark: 'b',
      x: 1,
      non_scaling_params: {launch, launch_group: 'g'},
      values: JSON.parse(`{"__proto__": ${value}}`),
    }));
    const [row] = launchGroupRows(rows, [{id: '__proto__'}], comparisonPairs(rows, meta));
    expect(Object.hasOwn(row.values, '__proto__')).toBe(true);
    expect(row.values['__proto__']).toBe(7);
    expect(Object.hasOwn(row.launches.curves, '__proto__')).toBe(true);
    expect(JSON.stringify(row.values)).toBe('{"__proto__":7}');
  });

  test('bands are filled behind grouped curves only, in each curve color', () => {
    const series = seriesOf(fdtdPoints());
    const draw = (rows) => {
      const fills = [];
      const target = {};
      const saved = [];
      const context = new Proxy(target, {
        get(_, name) {
          if (name === 'measureText') return (text) => ({width: String(text).length * 5});
          if (name === 'save') return () => saved.push({...target});
          if (name === 'restore')
            return () => {
              for (const key of Object.keys(target)) delete target[key];
              Object.assign(target, saved.pop());
            };
          if (name in target) return target[name];
          if (name === 'fill' || name === 'fillRect')
            return () => fills.push({alpha: target.globalAlpha ?? 1, color: target.fillStyle});
          return () => {};
        },
        set(_, name, value) {
          target[name] = value;
          return true;
        },
      });
      const canvas = document.createElement('canvas');
      canvas.getContext = () => context;
      drawChart(
        canvas,
        {
          kind: 'curve',
          rows,
          curves,
          xLabel: 'size',
          unit: 'ns',
          bounds: {min: 1, max: 1e5},
          scales: {x: false, y: false},
        },
        {grid: '#ddd', label: '#333'},
        benchmarks,
      );
      return fills.filter((fill) => fill.alpha < 1);
    };
    const steady = series.find((s) => groupOf(s) === 'fdtd_update_ex');
    const bands = draw(drawnRows(steady));
    // Three nested levels per curve, each one polygon across the X values.
    expect(bands.map((fill) => fill.color)).toEqual([
      ...Array(3).fill('#765'),
      ...Array(3).fill('#375'),
    ]);
    const first = series.find((s) => groupOf(s) === 'fdtd_update_ex_first');
    expect(draw(drawnRows(first))).toEqual([]);
    expect(draw([...steady.rows].sort((a, b) => a.x - b.x).slice(0, 3))).toEqual([]);
  });
});

describe('statistics', () => {
  test('raw-pair statistics are unchanged by grouping', () => {
    const grouped = fdtdReport({
      unavailable: (size, launch) => (launch % 7 === 0 ? {state: 'timeout'} : null),
    });
    // Before grouping, every launch was its own chart.
    const ungrouped = grouped.data.map(({non_scaling_params: {launch_group, ...rest}, ...point}) => ({
      ...point,
      non_scaling_params: rest,
    }));
    const before = indexReport(ungrouped, benchmarks);
    const after = indexReport(grouped.data, benchmarks);
    const signed = (pairs) => pairs.map((pair) => pair.signedError);
    expect(signed(after.pairs)).toEqual(signed(before.pairs));
    const [benchmarkAfter] = after.groups.get('gpu').benchmarks;
    const [benchmarkBefore] = before.groups.get('gpu').benchmarks;
    expect(errorStats(benchmarkAfter.pairs)).toEqual(errorStats(benchmarkBefore.pairs));
    expect(benchmarkBefore.series).toHaveLength(600);
    expect(benchmarkAfter.series).toHaveLength(6);
    // Each grouped chart holds exactly the dispatch pairs of its launches.
    expect(
      signed(benchmarkAfter.series.flatMap((s) => s.pairs)).sort((a, b) => a - b),
    ).toEqual(signed(benchmarkBefore.pairs).sort((a, b) => a - b));
    const summary = (data) =>
      buildSummary({
        rows: data.map((point, i) => ({...point, plot: i})),
        benchmarks,
        groups: [[1, 'gpu', 'GPU']],
        overview: false,
      })({scurve: 0, cdf: 0, scatter: 0});
    const {stats, percentiles, count, scatter, benchmark_stats} = summary(grouped.data);
    expect({stats, percentiles, count, scatter, benchmark_stats}).toEqual(
      (({stats, percentiles, count, scatter, benchmark_stats}) => ({
        stats,
        percentiles,
        count,
        scatter,
        benchmark_stats,
      }))(summary(ungrouped)),
    );
  });
});

describe('file viewer', () => {
  const unavailable = (size, launch) =>
    size === 128 && launch % 15 === 0 ? {state: 'timeout', reason: 'slow'} : null;
  const mount = () => {
    render(
      <MantineProvider>
        <Report snapshot={fdtdReport({unavailable})} />
      </MantineProvider>,
    );
    fireEvent.click(screen.getByRole('tab', {name: 'GPU'}));
    return screen.getByRole('article');
  };

  test('renders six charts headed by their launch group, with raw-pair statistics', () => {
    const article = mount();
    const sections = article.querySelectorAll('.series');
    expect(sections).toHaveLength(6);
    const headings = [...sections].map((section) => section.querySelector('h3').textContent);
    expect(headings).toContain('tmax=200 · launch group=fdtd_update_ex');
    expect(headings).toContain('tmax=200 · launch group=fdtd_update_hz_first');
    expect(headings.some((heading) => heading.includes('launch='))).toBe(false);
    const ex = [...sections].find(
      (section) => section.querySelector('h3').textContent === 'tmax=200 · launch group=fdtd_update_ex',
    );
    // 199 dispatches per size, minus the timeouts at size 128.
    const timeouts = Array.from({length: 600}, (_, launch) => launch).filter(
      (launch) => launch >= 3 && launch % 3 === 0 && launch % 15 === 0,
    ).length;
    expect(timeouts).toBe(39);
    expect(within(ex).getByTitle('Based on ' + (3 * 199 - timeouts) + ' paired measurements')).toBeTruthy();
    // One marker at the X with timeouts, counting its dispatches.
    const markers = within(ex).getAllByRole('button', {name: /Timed out/});
    expect(markers).toHaveLength(1);
    expect(markers[0].getAttribute('aria-label')).toBe(
      'size = 128\nSimulator kernel time · Timed out · slow · ' + timeouts + ' dispatches',
    );
    // One selectable median per curve and X.
    const canvas = within(ex).getByRole('img');
    canvas.focus();
    fireEvent.keyDown(canvas, {key: 'End'});
    expect(screen.getByText('6 / 6')).toBeTruthy();
  });

  test('median point details summarize and list the dispatches', () => {
    const series = seriesOf(fdtdPoints({unavailable}));
    const steady = series.find((s) => groupOf(s) === 'fdtd_update_ex');
    const row = drawnRows(steady).find((r) => r.x === 128);
    render(
      <MantineProvider>
        <PointDescription
          description={{point: row, comparisons: comparisonPairs([row], benchmarks), selectedSeries: 'sim'}}
          benchmarks={benchmarks}
          groups={{gpu: {name: 'GPU'}}}
        />
      </MantineProvider>,
    );
    expect(screen.getByText('Error between medians')).toBeTruthy();
    const details = document.querySelector('.point-launches');
    expect(document.querySelector('.point-kernel').textContent).toBe('fdtd_update_ex');
    expect(within(details).getByText('Dispatches at this X').nextSibling.textContent).toBe('199');
    expect(within(details).getByText('Paired').nextSibling.textContent).toBe('160 of 199');
    expect(within(details).getAllByText('median of 160')).toHaveLength(2);
    for (const label of ['P2–P98', 'P10–P90', 'P25–P75', 'Range'])
      expect(within(details).getAllByText(label)).toHaveLength(2);
    const table = details.querySelector('.point-dispatches table');
    expect(table.querySelectorAll('tbody tr')).toHaveLength(199);
    expect(within(table).getAllByText('timeout')).toHaveLength(39);
    expect(table.querySelector('tbody th').textContent).toBe('3');
  });
});
