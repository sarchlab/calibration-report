import {Button, Paper, VisuallyHidden} from '@mantine/core';
import {useId, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {drawChart} from './drawing.js';
import {
  chartParams,
  comparisonPairs,
  displayName,
  errorPercentiles,
  errorStats,
  isLaunchGroup,
  isMarked,
  launchGroupRows,
  parameterLabel,
  parseLaunch,
  preferLogScale,
  rankingStats,
  relabelPairs,
  summaryCharts,
  visibleStates,
  valueBounds,
} from './model.js';
import {PointDescription, usePoints} from './PointDetails.jsx';
import {PageControls, pageWindow} from './Pagination.jsx';

const seriesPageSizes = [6, 12, 24, 48];

export function Stats({entries, count}) {
  if (!entries.length) return null;
  return (
    <dl
      className="stats"
      title={'Based on ' + count.toLocaleString() + ' paired measurements'}
    >
      {entries.map(([name, value]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
function PlotDetails({children, entries, count}) {
  return (
    <footer className="plot-details">
      <div className="description">{children}</div>
      <Stats entries={entries} count={count} />
    </footer>
  );
}
function Legend({curves}) {
  return (
    <div className="legend">
      {curves.map((curve, i) => (
        <span key={curve.id ?? i}>
          <i className="key" style={{backgroundColor: curve.color}} />
          {curve.name}
        </span>
      ))}
    </div>
  );
}
export function nearestPoint(event, canvas, points, pointerType) {
  const rect = canvas.getBoundingClientRect();
  const radius = pointerType === 'touch' || pointerType === 'pen' ? 28 : 14;
  let best = -1,
    distance = radius * radius;
  points.forEach((point, index) => {
    const dx =
      event.clientX - rect.left - (point.x * rect.width) / (canvas.width / 2);
    const dy =
      event.clientY - rect.top - (point.y * rect.height) / (canvas.height / 2);
    const d = dx * dx + dy * dy;
    if (d < distance) {
      best = index;
      distance = d;
    }
  });
  return best;
}
// A summary chart whose sample is empty (the byte budget left none) is
// replaced by a note.
function SummaryCanvas({spec, theme}) {
  if (!spec.pairs.length)
    return <p className="summary-note empty-sample">No sample available</p>;
  return <PlotCanvas spec={spec} theme={theme} summary />;
}
export function PlotCanvas({spec, theme, summary = false}) {
  const interaction = usePoints();
  const {
    benchmarks,
    groups,
    selection,
    hover,
    select,
    close,
    showHover,
    browse,
    contentRef,
    removePlot,
  } = interaction;
  const canvas = useRef(null),
    wrapper = useRef(null),
    pointer = useRef();
  const id = useId();
  useLayoutEffect(() => () => removePlot(id), [id, removePlot]);
  // Refreshed rows replace what a hover or pinned selection pointed at.
  // Rebuilt arrays of the same row objects (new metadata) are not a refresh.
  // A launch-group chart compares its dispatches, not its rebuilt medians.
  const sourceRows = spec.dispatches ?? spec.rows;
  const shownRows = useRef(sourceRows);
  useLayoutEffect(() => {
    const previous = shownRows.current;
    shownRows.current = sourceRows;
    if (
      previous === sourceRows ||
      (previous?.length === sourceRows?.length &&
        previous.every((row, i) => row === sourceRows[i]))
    )
      return;
    removePlot(id);
  }, [sourceRows, id, removePlot]);
  const [drawing, setDrawing] = useState(null);
  const [statusDetail, setStatusDetail] = useState('');
  useLayoutEffect(() => {
    setDrawing(drawChart(canvas.current, spec, theme, benchmarks));
    setStatusDetail('');
  }, [spec, theme, benchmarks]);
  const points = drawing?.hitPoints ?? [];
  const plot = {id, canvas, wrapper, points, summary};
  const pinned = selection?.id === id;
  const active = pinned
    ? selection
    : !selection && hover?.id === id
      ? hover
      : null;
  const point = active && points[active.index];
  // One marker per X with unavailable results; in a launch-group chart, a
  // status shared by several dispatches is listed once with its count.
  const markers = drawing?.xPosition
    ? Array.from(
        Map.groupBy(sourceRows, spec.xOf ?? ((row) => row.x)),
        ([x, rows]) => {
          const marked = rows.flatMap((row) =>
            spec.series
              .filter((curve) => isMarked(row, curve.id))
              .map((curve) => ({curve, status: row.statuses[curve.id]})),
          );
          if (!marked.length) return null;
          const main =
            marked.find(({status}) => status.state !== 'running') ?? marked[0];
          const {state, symbol} = main.status;
          const lines = new Map();
          for (const {curve, status} of marked) {
            const line =
              curve.name +
              ' · ' +
              visibleStates.get(status.state).label +
              (status.reason ? ' · ' + status.reason : '');
            lines.set(line, (lines.get(line) ?? 0) + 1);
          }
          const message = [
            spec.xLabel + ' = ' + x,
            ...Array.from(lines, ([line, n]) =>
              n > 1 ? line + ' · ' + n + ' dispatches' : line,
            ),
          ].join('\n');
          return {
            x,
            state,
            symbol: symbol ?? visibleStates.get(state).symbol,
            message,
          };
        },
      ).filter(Boolean)
    : [];
  return (
    <div
      className="interactive-plot"
      ref={wrapper}
      onPointerLeave={() => {
        if (!pinned) showHover(plot, -1);
      }}
      onBlur={(event) => {
        if (
          !pinned &&
          event.relatedTarget &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          showHover(plot, -1);
      }}
    >
      <div className="point-surface">
        <canvas
          className="curve"
          ref={canvas}
          tabIndex={points.length ? 0 : undefined}
          aria-describedby={
            [
              points.length ? id + '-hint' : null,
              active
                ? pinned
                  ? 'pinned-point-description'
                  : id + '-preview'
                : null,
            ]
              .filter(Boolean)
              .join(' ') || undefined
          }
          onPointerMove={(event) => {
            if (event.pointerType !== 'mouse' || pinned || selection) return;
            const index = nearestPoint(
              event,
              canvas.current,
              points,
              event.pointerType,
            );
            canvas.current.style.cursor = index < 0 ? '' : 'pointer';
            showHover(plot, index);
          }}
          onPointerDown={(event) => {
            pointer.current = event.pointerType;
          }}
          onPointerCancel={() => {
            pointer.current = undefined;
          }}
          onClick={(event) => {
            const index = nearestPoint(
              event,
              canvas.current,
              points,
              event.nativeEvent.pointerType || pointer.current,
            );
            pointer.current = undefined;
            if (index < 0 || (pinned && selection.index === index)) close();
            else select(plot, index);
          }}
          onKeyDown={(event) => {
            if (!points.length) return;
            if (pinned && event.key === 'Tab' && !event.shiftKey) {
              event.preventDefault();
              contentRef.current?.focus({preventScroll: true});
            } else browse(event, plot);
          }}
        />
        {point && (
          <span
            className="point-highlight"
            aria-hidden="true"
            style={{
              left: (100 * point.x) / (canvas.current.width / 2) + '%',
              top: (100 * point.y) / (canvas.current.height / 2) + '%',
            }}
          />
        )}
        {markers.length > 0 && (
          <div
            className="plot-status-track"
            role="group"
            aria-label="Unavailable results"
            style={{top: 100 * drawing.statusPosition + '%'}}
          >
            {markers.map(({x, state, symbol, message}, i) => (
              <button
                type="button"
                className="plot-status-marker"
                data-state={state}
                data-emoji={
                  /\p{Emoji_Presentation}|\uFE0F/u.test(symbol) || undefined
                }
                key={i}
                style={{left: 100 * drawing.xPosition(x) + '%'}}
                title={message}
                aria-label={message}
                onClick={() => setStatusDetail(message)}
              >
                {symbol}
              </button>
            ))}
          </div>
        )}
      </div>
      {statusDetail && (
        <p className="plot-status-detail" aria-live="polite">
          {statusDetail}
        </p>
      )}
      {point && !pinned && (
        <Paper
          className="point-detail"
          id={id + '-preview'}
          role="tooltip"
          withBorder
          radius="md"
          shadow="md"
        >
          <PointDescription
            description={point.description}
            benchmarks={benchmarks}
            groups={groups}
          />
          <p className="point-preview-hint">Click for full details</p>
        </Paper>
      )}
      {points.length > 0 && (
        <p className="point-hint" id={id + '-hint'}>
          Hover or tap a point · Arrow keys browse
          <VisuallyHidden>. Escape closes details.</VisuallyHidden>
        </p>
      )}
    </div>
  );
}
function CurvePlot({
  plotKey,
  rows,
  dispatches,
  launchOrdinal,
  curves,
  series,
  xLabel,
  unit,
  theme,
  preferences,
  setPreference,
}) {
  const {close} = usePoints();
  const spec = useMemo(() => {
    const measures = curves
      .flatMap((curve) =>
        rows.flatMap((row) => [
          row.values[curve.id],
          ...(row.launches?.curves[curve.id]?.bands.flat() ?? []),
        ]),
      )
      .filter(Number.isFinite);
    const bounds = valueBounds(measures);
    // A launch-ordinal chart is drawn over the launch ordinal, linear by
    // default, with one line per kernel.
    const ordinal = launchOrdinal
      ? {
          xOf: (row) => parseLaunch(row.non_scaling_params).ordinal,
          lineOf: (row) => parseLaunch(row.non_scaling_params).kernel,
        }
      : {};
    const xOf = ordinal.xOf ?? ((row) => row.x);
    const canLog = {x: xOf(rows[0]) > 0, y: bounds !== null && bounds.min > 0};
    const scales = {
      x:
        canLog.x &&
        (preferences?.x ?? (!launchOrdinal && preferLogScale(rows.map(xOf)))),
      y: canLog.y && (preferences?.y ?? preferLogScale(measures)),
    };
    return {
      kind: 'curve',
      rows,
      dispatches,
      ...ordinal,
      curves,
      series,
      xLabel,
      unit,
      bounds,
      scales,
      canLog,
    };
  }, [rows, dispatches, launchOrdinal, curves, series, xLabel, unit, preferences]);
  return (
    <div className="plot">
      <div className="scale-controls" role="group" aria-label="Axis scales">
        {['x', 'y'].map((axis) => (
          <Button
            key={axis}
            size="compact-xs"
            variant={spec.scales[axis] ? 'filled' : 'default'}
            disabled={!spec.canLog[axis]}
            aria-pressed={spec.scales[axis]}
            title={
              !spec.canLog[axis]
                ? 'Log scale requires positive ' +
                  axis.toUpperCase() +
                  ' values'
                : undefined
            }
            onClick={() => {
              close();
              setPreference(plotKey, {
                ...preferences,
                [axis]: !spec.scales[axis],
              });
            }}
          >
            {axis.toUpperCase()} log
          </Button>
        ))}
      </div>
      <PlotCanvas spec={spec} theme={theme} />
    </div>
  );
}
// The heading of a launch-ordinal chart: its parameters without `launch`,
// then the scaling parameter at the chart's x.
function ordinalLabel(row, meta, order = Object.keys(row.non_scaling_params)) {
  const {launch: _launch, ...rest} = row.non_scaling_params;
  const scaling = meta.scaling_param;
  return parameterLabel({...rest, [scaling]: row.x}, meta.params, [
    ...order.filter((key) => key !== scaling),
    scaling,
  ]);
}
// `series` is every series of the benchmark (file source). With `paged`
// (API source), `series` is only the current page of `count` series, `wide`
// is the server's benchmark-wide {count, stats} (absent until it loads),
// series pairs come from their rows, and `parameterOrder` is the declaration
// order of the parameters.
export function Benchmark({
  id,
  series: sourceSeries,
  count = sourceSeries.length,
  meta,
  pairs,
  paged = false,
  wide,
  parameterOrder,
  theme,
  preferences,
  setPreference,
  pagination,
  setPagination,
}) {
  const window = pageWindow(count, pagination, 6);
  const benchmarkWide = useMemo(
    () =>
      paged
        ? (wide ?? {count: 0, stats: []})
        : {count: pairs.length, stats: errorStats(pairs)},
    [paged, wide, pairs],
  );
  const series = useMemo(() => {
    const curves = Object.entries(meta.values)
      .map(([id, info], i) => ({
        id,
        ...info,
        ...(theme.roles.get(info.role) ?? {
          color: theme.palette[i % theme.palette.length],
          layer: 1,
        }),
      }))
      .sort((a, b) => a.layer - b.layer);
    const units = Map.groupBy(curves, (curve) => curve.unit);
    const visible = paged
      ? sourceSeries
      : sourceSeries.slice(window.start, window.end);
    return visible.map(
      ({
        parameters,
        rows,
        pairs: groupPairs = comparisonPairs(rows, {[id]: meta}),
        launchOrdinal = false,
      }) => {
        const group = launchOrdinal
          ? [...rows].sort(
              (a, b) =>
                parseLaunch(a.non_scaling_params).ordinal -
                parseLaunch(b.non_scaling_params).ordinal,
            )
          : [...rows].sort((a, b) => a.x - b.x);
        const grouped = isLaunchGroup(group[0].non_scaling_params);
        return {
          parameters,
          launchOrdinal,
          label: launchOrdinal
            ? ordinalLabel(group[0], meta, parameterOrder)
            : parameterLabel(
                chartParams(group[0].non_scaling_params),
                meta.params,
                parameterOrder,
              ),
          plots: Array.from(units, ([unit, comparable]) => {
            const plotted = group.filter((row) =>
              comparable.some(
                (curve) =>
                  Number.isFinite(row.values[curve.id]) ||
                  isMarked(row, curve.id),
              ),
            );
            // Statistics always use every dispatch pair, never the medians.
            const pairs = groupPairs.filter((pair) => pair.unit === unit);
            return {
              unit,
              comparable,
              active: comparable.filter((curve) =>
                group.some((row) => Number.isFinite(row.values[curve.id])),
              ),
              rows: grouped
                ? launchGroupRows(plotted, comparable, pairs)
                : plotted,
              dispatches: grouped ? plotted : undefined,
              pairs,
              key: JSON.stringify([rows[0].group, id, parameters, unit]),
            };
          }).filter((plot) => plot.rows.length),
        };
      },
    );
  }, [sourceSeries, paged, window.start, window.end, meta, theme, id, parameterOrder]);
  const axisUnit = meta.params[meta.scaling_param].unit;
  const xLabel =
    displayName(meta.scaling_param) + (axisUnit ? ' (' + axisUnit + ')' : '');
  return (
    <Paper
      component="article"
      className="chart card"
      withBorder
      radius="md"
      p="md"
    >
      <h2>{displayName(id)}</h2>
      {benchmarkWide.count > 0 && (
        <div className="benchmark-error">
          <p>Benchmark-wide error</p>
          <Stats entries={benchmarkWide.stats} count={benchmarkWide.count} />
        </div>
      )}
      <PageControls
        label={'Series for ' + displayName(id)}
        noun="series"
        count={count}
        window={window}
        sizes={seriesPageSizes}
        onChange={setPagination}
      />
      <div className="series-grid">
        {series.map((group) => (
          <Paper
            component="section"
            withBorder
            className="series"
            key={group.parameters}
          >
            <h3>{group.label}</h3>
            {group.plots.map((plot) => (
              <div className="series-plot" key={plot.unit}>
                <CurvePlot
                  plotKey={plot.key}
                  rows={plot.rows}
                  dispatches={plot.dispatches}
                  launchOrdinal={group.launchOrdinal}
                  curves={plot.active}
                  series={plot.comparable}
                  xLabel={group.launchOrdinal ? 'launch' : xLabel}
                  unit={plot.unit}
                  theme={theme}
                  preferences={preferences.get(plot.key)}
                  setPreference={setPreference}
                />
                <PlotDetails
                  entries={errorStats(plot.pairs)}
                  count={plot.pairs.length}
                >
                  <Legend curves={plot.active} />
                </PlotDetails>
              </div>
            ))}
          </Paper>
        ))}
      </div>
    </Paper>
  );
}
function Scatter({
  scope,
  pairs,
  unit,
  colors,
  theme,
  preferences,
  setPreference,
  exact,
}) {
  const {close} = usePoints();
  const key = JSON.stringify(['scatter', scope, unit]);
  const computedLog = useMemo(
    () =>
      exact?.log ??
      preferLogScale(pairs.flatMap((pair) => [pair.actual, pair.prediction])),
    [pairs, exact],
  );
  const log = preferences.get(key) ?? computedLog;
  const spec = useMemo(
    () => ({kind: 'scatter', pairs, unit, colors, log}),
    [pairs, unit, colors, log],
  );
  const stats = useMemo(
    () => exact?.stats ?? [...rankingStats(pairs), ...errorStats(pairs)],
    [pairs, exact],
  );
  const count = exact?.count ?? pairs.length;
  return (
    <div className="plot">
      <div className="scale-controls">
        <Button
          size="compact-xs"
          variant={log ? 'filled' : 'default'}
          aria-pressed={log}
          onClick={() => {
            close();
            setPreference(key, !log);
          }}
        >
          X/Y log
        </Button>
      </div>
      <SummaryCanvas spec={spec} theme={theme} />
      <SampleNote shown={pairs.length} count={count} />
      <PlotDetails entries={stats} count={count}>
        <p>Dashed line indicates equal values.</p>
        <p>Pairwise accuracy uses pairs with distinct measured values.</p>
      </PlotDetails>
    </div>
  );
}
function SampleNote({shown, count}) {
  if (shown >= count) return null;
  return (
    <p className="summary-note sample-note">
      {shown.toLocaleString()} of {count.toLocaleString()} comparisons shown
    </p>
  );
}
// Summary of one scope, from the full pair list (file source) or from a
// server summary with exact statistics and sampled charts (API source).
export function Summary({
  pairs: sourcePairs,
  summary,
  scope,
  groups,
  theme,
  preferences,
  setPreference,
}) {
  const model = useMemo(() => {
    const colorsFor = (curves) => {
      const colors = new Map();
      for (const curve of curves)
        if (!colors.has(curve.id))
          colors.set(curve.id, {
            color: theme.palette[colors.size % theme.palette.length],
            name: curve.name,
          });
      return colors;
    };
    if (summary) {
      const charts = summaryCharts(summary);
      const colors = colorsFor(charts.legend);
      // Both curves split by the same cutoffs, taken from all sampled pairs.
      const bands = charts.sampled;
      return {
        count: charts.count,
        colors,
        stats: charts.stats,
        percentiles: charts.percentiles,
        ranked: {kind: 'ranked', pairs: charts.scurve, colors, total: charts.count, bands},
        cdf: {kind: 'cdf', pairs: charts.cdf.pairs, total: charts.count, log: charts.cdf.log, bands},
        scatter: charts.scatter.map((unit) => ({unit: unit.unit, pairs: unit.pairs, exact: unit})),
      };
    }
    const pairs = relabelPairs(
      sourcePairs,
      scope === null,
      (group) => groups[group].name,
    );
    const colors = colorsFor(pairs);
    return {
      count: pairs.length,
      colors,
      stats: errorStats(pairs),
      percentiles: errorPercentiles(pairs),
      ranked: {kind: 'ranked', pairs, colors, bands: pairs},
      cdf: {kind: 'cdf', pairs, bands: pairs},
      scatter: Array.from(
        Map.groupBy(pairs, (pair) => pair.unit),
        ([unit, values]) => ({unit, pairs: values}),
      ),
    };
  }, [sourcePairs, summary, scope, groups, theme]);
  const {count, colors, stats, percentiles, ranked, cdf} = model;
  if (!count) return null;
  return (
    <section id="summary" aria-label="Accuracy summary">
      <h2>
        {scope === null
          ? 'Overview · Accuracy summary'
          : groups[scope].name + ' accuracy summary'}
      </h2>
      <div className="summary-context">
        <p className="summary-note">
          {count.toLocaleString()} paired measurements
        </p>
        <Legend curves={[...colors.values()]} />
      </div>
      <div className="charts summary-charts">
        <Paper
          component="figure"
          className="card"
          withBorder
          radius="md"
          p="md"
        >
          <figcaption>S-curve</figcaption>
          <SummaryCanvas spec={ranked} theme={theme} />
          <SampleNote shown={ranked.pairs.length} count={count} />
          <PlotDetails entries={stats} count={count}>
            <p>
              Negative values are underestimates. Positive values are
              overestimates.
            </p>
          </PlotDetails>
        </Paper>
        <Paper
          component="figure"
          className="card"
          withBorder
          radius="md"
          p="md"
        >
          <figcaption>Absolute error distribution (CDF)</figcaption>
          <SummaryCanvas spec={cdf} theme={theme} />
          <SampleNote shown={cdf.pairs.length} count={count} />
          <PlotDetails entries={percentiles} count={count}>
            <p>|simulated − measured| / min(simulated, measured)</p>
          </PlotDetails>
          <Stats entries={stats} count={count} />
        </Paper>
        <Paper
          component="figure"
          className="card"
          withBorder
          radius="md"
          p="md"
        >
          <figcaption>Measured vs. simulated</figcaption>
          {model.scatter.map(({unit, pairs, exact}) => (
            <Scatter
              key={unit}
              scope={scope}
              pairs={pairs}
              unit={unit}
              colors={colors}
              theme={theme}
              preferences={preferences}
              setPreference={setPreference}
              exact={exact}
            />
          ))}
        </Paper>
      </div>
    </section>
  );
}
