import {Button, Paper, VisuallyHidden} from '@mantine/core';
import {useId, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {drawChart} from './drawing.js';
import {
  displayName,
  errorStats,
  isMarked,
  parameterLabel,
  preferLogScale,
  rankingStats,
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
  const markers = drawing?.xPosition
    ? spec.rows.flatMap((row) => {
        const marked = spec.series.filter((curve) => isMarked(row, curve.id));
        if (!marked.length) return [];
        const main =
          marked.find((curve) => row.statuses[curve.id].state !== 'running') ??
          marked[0];
        const {state, symbol} = row.statuses[main.id];
        const message = [
          spec.xLabel + ' = ' + row.x,
          ...marked.map((curve) => {
            const status = row.statuses[curve.id];
            return (
              curve.name +
              ' · ' +
              visibleStates.get(status.state).label +
              (status.reason ? ' · ' + status.reason : '')
            );
          }),
        ].join('\n');
        return [
          {
            row,
            state,
            symbol: symbol ?? visibleStates.get(state).symbol,
            message,
          },
        ];
      })
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
            {markers.map(({row, state, symbol, message}, i) => (
              <button
                type="button"
                className="plot-status-marker"
                data-state={state}
                data-emoji={
                  /\p{Emoji_Presentation}|\uFE0F/u.test(symbol) || undefined
                }
                key={i}
                style={{left: 100 * drawing.xPosition(row.x) + '%'}}
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
      .flatMap((curve) => rows.map((row) => row.values[curve.id]))
      .filter(Number.isFinite);
    const bounds = valueBounds(measures);
    const canLog = {x: rows[0].x > 0, y: bounds !== null && bounds.min > 0};
    const scales = {
      x:
        canLog.x &&
        (preferences?.x ?? preferLogScale(rows.map((row) => row.x))),
      y: canLog.y && (preferences?.y ?? preferLogScale(measures)),
    };
    return {
      kind: 'curve',
      rows,
      curves,
      series,
      xLabel,
      unit,
      bounds,
      scales,
      canLog,
    };
  }, [rows, curves, series, xLabel, unit, preferences]);
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
export function Benchmark({
  id,
  series: sourceSeries,
  meta,
  pairs,
  theme,
  preferences,
  setPreference,
  pagination,
  setPagination,
}) {
  const window = pageWindow(sourceSeries.length, pagination, 6);
  const benchmarkStats = useMemo(() => errorStats(pairs), [pairs]);
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
    return sourceSeries.slice(window.start, window.end).map(
      ({parameters, rows, pairs: groupPairs}) => {
        const group = [...rows].sort((a, b) => a.x - b.x);
        return {
          parameters,
          label: parameterLabel(group[0].non_scaling_params, meta.params),
          plots: Array.from(units, ([unit, comparable]) => ({
            unit,
            comparable,
            active: comparable.filter((curve) =>
              group.some((row) => Number.isFinite(row.values[curve.id])),
            ),
            plotted: group.filter((row) =>
              comparable.some(
                (curve) =>
                  Number.isFinite(row.values[curve.id]) ||
                  isMarked(row, curve.id),
              ),
            ),
            pairs: groupPairs.filter((pair) => pair.unit === unit),
            key: JSON.stringify([rows[0].group, id, parameters, unit]),
          })).filter((plot) => plot.plotted.length),
        };
      },
    );
  }, [sourceSeries, window.start, window.end, meta, theme, id]);
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
      {pairs.length > 0 && (
        <div className="benchmark-error">
          <p>Benchmark-wide error</p>
          <Stats entries={benchmarkStats} count={pairs.length} />
        </div>
      )}
      <PageControls
        label={'Series for ' + displayName(id)}
        noun="series"
        count={sourceSeries.length}
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
                  rows={plot.plotted}
                  curves={plot.active}
                  series={plot.comparable}
                  xLabel={xLabel}
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
}) {
  const {close} = usePoints();
  const key = JSON.stringify(['scatter', scope, unit]);
  const defaultLog = useMemo(
    () => preferLogScale(pairs.flatMap((pair) => [pair.actual, pair.prediction])),
    [pairs],
  );
  const log = preferences.get(key) ?? defaultLog;
  const spec = useMemo(
    () => ({kind: 'scatter', pairs, unit, colors, log}),
    [pairs, unit, colors, log],
  );
  const stats = useMemo(
    () => [...rankingStats(pairs), ...errorStats(pairs)],
    [pairs],
  );
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
      <PlotCanvas spec={spec} theme={theme} summary />
      <PlotDetails entries={stats} count={pairs.length}>
        <p>Dashed line indicates equal values.</p>
        <p>Pairwise accuracy uses pairs with distinct measured values.</p>
      </PlotDetails>
    </div>
  );
}
export function Summary({
  pairs: sourcePairs,
  scope,
  groups,
  theme,
  preferences,
  setPreference,
}) {
  const {pairs, colors, byUnit, ranked, cdf, percentiles} = useMemo(() => {
    const pairs =
      scope === null && new Set(sourcePairs.map((pair) => pair.group)).size > 1
        ? sourcePairs.map((pair) => ({
            ...pair,
            id: JSON.stringify([pair.group, pair.id]),
            name: groups[pair.group].name + ' · ' + pair.name,
          }))
        : sourcePairs;
    const colors = new Map();
    for (const pair of pairs)
      if (!colors.has(pair.id))
        colors.set(pair.id, {
          color: theme.palette[colors.size % theme.palette.length],
          name: pair.name,
        });
    const errors = pairs
      .map((pair) => Math.abs(pair.signedError))
      .sort((a, b) => a - b);
    return {
      pairs,
      colors,
      byUnit: Map.groupBy(pairs, (pair) => pair.unit),
      ranked: {kind: 'ranked', pairs, colors},
      cdf: {kind: 'cdf', pairs},
      percentiles: errors.length
        ? [50, 90, 95, 98].map((p) => [
            'P' + p,
            errors[Math.ceil((p / 100) * errors.length) - 1].toPrecision(3) +
              '%',
          ])
        : [],
    };
  }, [sourcePairs, scope, groups, theme]);
  const stats = useMemo(() => errorStats(pairs), [pairs]);
  if (!pairs.length) return null;
  return (
    <section id="summary" aria-label="Accuracy summary">
      <h2>
        {scope === null
          ? 'Overview · Accuracy summary'
          : groups[scope].name + ' accuracy summary'}
      </h2>
      <div className="summary-context">
        <p className="summary-note">
          {pairs.length.toLocaleString()} paired measurements
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
          <PlotCanvas spec={ranked} theme={theme} summary />
          <PlotDetails entries={stats} count={pairs.length}>
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
          <PlotCanvas spec={cdf} theme={theme} summary />
          <PlotDetails entries={percentiles} count={pairs.length}>
            <p>|simulated − measured| / min(simulated, measured)</p>
          </PlotDetails>
          <Stats entries={stats} count={pairs.length} />
        </Paper>
        <Paper
          component="figure"
          className="card"
          withBorder
          radius="md"
          p="md"
        >
          <figcaption>Measured vs. simulated</figcaption>
          {Array.from(byUnit, ([unit, values]) => (
            <Scatter
              key={unit}
              scope={scope}
              pairs={values}
              unit={unit}
              colors={colors}
              theme={theme}
              preferences={preferences}
              setPreference={setPreference}
            />
          ))}
        </Paper>
      </div>
    </section>
  );
}
