import {ActionIcon, Button, Modal, Paper, VisuallyHidden} from '@mantine/core';
import {useElementSize} from '@mantine/hooks';
import {useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {drawChart, zoomAxes} from './drawing.js';
import {panView, pinchView, wheelFactor, zoomView} from './zoom.js';
import {
  chartParams,
  comparisonPairs,
  displayName,
  displayUnit,
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
// Drawing units per CSS pixel of a canvas drawn at `size` (drawing units;
// the default layout draws at 2 canvas pixels per unit).
function drawingScale(canvas, size) {
  const rect = canvas.getBoundingClientRect();
  return {
    rect,
    x: (size?.width ?? canvas.width / 2) / rect.width,
    y: (size?.height ?? canvas.height / 2) / rect.height,
  };
}
// The index of the point nearest the event within the pointer's radius, or -1.
export function nearestPoint(event, canvas, points, pointerType, size) {
  const {rect, x, y} = drawingScale(canvas, size);
  const radius = pointerType === 'touch' || pointerType === 'pen' ? 28 : 14;
  let best = -1,
    distance = radius * radius;
  points.forEach((point, index) => {
    const dx = event.clientX - rect.left - point.x / x;
    const dy = event.clientY - rect.top - point.y / y;
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
function SummaryChart(props) {
  if (!props.spec.pairs.length)
    return <p className="summary-note empty-sample">No sample available</p>;
  return <ChartFrame {...props} summary />;
}
function ExpandIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    </svg>
  );
}
// A chart with its `controls`, plus an expand button that opens the same
// spec in a full-screen overlay, where it can be zoomed and panned. The
// overlay repeats the controls and shows `legend` below the chart.
function ChartFrame({spec, theme, title, controls = null, legend = null, summary = false}) {
  const [expanded, setExpanded] = useState(false);
  const collapse = useCallback(() => setExpanded(false), []);
  return (
    <>
      <div className="scale-controls" role="group" aria-label="Chart controls">
        {controls}
        <ActionIcon
          size={22}
          variant="default"
          aria-label={'Expand ' + title}
          title="Expand chart"
          onClick={() => setExpanded(true)}
        >
          <ExpandIcon />
        </ActionIcon>
      </div>
      <PlotCanvas spec={spec} theme={theme} summary={summary} />
      {/* Escape is handled by ChartOverlay; the page scroll lock is CSS, so
          the pinned point panel (z-index 10, outside the modal) still scrolls. */}
      <Modal
        opened={expanded}
        onClose={collapse}
        title={title}
        fullScreen
        zIndex={9}
        lockScroll={false}
        closeOnEscape={false}
        transitionProps={{transition: 'fade'}}
        className="chart-overlay"
        classNames={{content: 'chart-overlay-content', body: 'chart-overlay-body'}}
        closeButtonProps={{'aria-label': 'Close expanded chart'}}
      >
        <ChartOverlay
          spec={spec}
          theme={theme}
          controls={controls}
          legend={legend}
          onClose={collapse}
        />
      </Modal>
    </>
  );
}
// Two taps this close in time (ms) make a double tap.
const DOUBLE_TAP_MS = 350;
// Overlay drawing units are this many CSS pixels, so its text reads at a
// comfortable size on a window-sized chart.
const OVERLAY_TEXT_SCALE = 1.25;
// Room under the overlay canvas for its hint line.
const OVERLAY_HINT_HEIGHT = 24;
const scaleKey = (spec) => JSON.stringify([spec.scales, spec.log, spec.factor]);
function ChartOverlay({spec, theme, controls, legend, onClose}) {
  const {selection, close} = usePoints();
  // A zoom belongs to the axis scales it was made on: changing a scale
  // discards it. Changing the view dismisses point details, as scales do.
  const scales = scaleKey(spec);
  const [view, setView] = useState(null);
  const [zoomedScales, setZoomedScales] = useState(scales);
  if (zoomedScales !== scales) {
    setZoomedScales(scales);
    setView(null);
  }
  const changeView = useCallback(
    (next) => {
      close();
      setView(next);
    },
    [close],
  );
  const detailsTarget = useRef(null);
  // Escape dismisses pinned point details first (PointProvider handles
  // that), then the overlay.
  const pinned = useRef(selection);
  pinned.current = selection;
  useEffect(() => {
    const keydown = (event) => {
      if (event.key === 'Escape' && !event.isComposing && !pinned.current) onClose();
    };
    window.addEventListener('keydown', keydown, true);
    return () => window.removeEventListener('keydown', keydown, true);
  }, [onClose]);
  const {ref, width, height} = useElementSize();
  const size = useMemo(
    () =>
      width > 0 && height > OVERLAY_HINT_HEIGHT
        ? {
            width: width / OVERLAY_TEXT_SCALE,
            height: (height - OVERLAY_HINT_HEIGHT) / OVERLAY_TEXT_SCALE,
          }
        : null,
    [width, height],
  );
  const pixelRatio = OVERLAY_TEXT_SCALE * Math.max(2, globalThis.devicePixelRatio || 1);
  return (
    <>
      <div className="scale-controls chart-overlay-controls" role="group" aria-label="Chart controls">
        <p className="zoom-hint">Scroll or pinch to zoom · Drag to pan · Double-click or double-tap to reset</p>
        {controls}
        <Button
          size="compact-xs"
          variant="default"
          disabled={!view}
          onClick={() => changeView(null)}
        >
          Reset zoom
        </Button>
      </div>
      <div className="chart-overlay-plot" ref={ref}>
        <PlotCanvas
          spec={spec}
          theme={theme}
          view={view}
          onViewChange={changeView}
          size={size}
          pixelRatio={pixelRatio}
          detailsTarget={detailsTarget}
        />
      </div>
      {legend}
      <div ref={detailsTarget} />
    </>
  );
}
// With `onViewChange`, the wheel or a two-finger pinch zooms the chart's view
// around the pointer or pinch, a one-pointer drag pans it, and a double click
// or double tap resets it (calls it with null),
// changing only the axes zoomAxes allows for the chart's kind. `size` and
// `pixelRatio` replace the default layout (see drawChart). With
// `detailsTarget` (a ref), pinned point details render inside that element.
export function PlotCanvas({
  spec,
  theme,
  summary = false,
  view = null,
  onViewChange,
  size = null,
  pixelRatio = 2,
  detailsTarget,
}) {
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
    setDrawing(drawChart(canvas.current, spec, theme, benchmarks, {view, size, pixelRatio}));
  }, [spec, theme, benchmarks, view, size, pixelRatio]);
  useLayoutEffect(() => setStatusDetail(''), [spec, theme, benchmarks]);
  const points = drawing?.hitPoints ?? [];
  const drawnSize = drawing && {width: drawing.width, height: drawing.height};
  // Zoom gestures read the latest drawing; a drag pans from where it began.
  const zoomable = Boolean(onViewChange);
  const allowed = zoomAxes[spec.kind];
  const latest = useRef();
  latest.current = {drawing, view, onViewChange};
  // Pointers down on a zoomable chart, and the drawing, view and pointer
  // positions where the current drag or pinch began.
  const gesture = useRef({pointers: new Map(), start: null});
  const dragged = useRef(false);
  const lastTap = useRef(null);
  // A click or tap on a zoomed chart waits out the double-click window
  // before selecting, so the details panel cannot cover the chart before a
  // second click or tap. A view or data change, or unmount, drops it along
  // with the double-tap history.
  const pendingTap = useRef(null);
  const cancelTap = () => {
    clearTimeout(pendingTap.current);
    pendingTap.current = null;
  };
  useEffect(
    () => () => {
      cancelTap();
      lastTap.current = null;
    },
    [view, spec],
  );
  const beginGesture = () => {
    const {pointers} = gesture.current;
    const {drawing, view} = latest.current;
    gesture.current.start =
      pointers.size && drawing?.axes ? {drawing, view, pointers: new Map(pointers)} : null;
  };
  // A pointer's position in the drawing units of `drawing`.
  const drawingPoint = ({clientX, clientY}, drawing) => {
    const {rect, x, y} = drawingScale(canvas.current, drawing);
    return {x: (clientX - rect.left) * x, y: (clientY - rect.top) * y};
  };
  const moveGesture = (event) => {
    const {pointers, start} = gesture.current;
    pointers.set(event.pointerId, {clientX: event.clientX, clientY: event.clientY});
    if (!start) return;
    const ids = [...start.pointers.keys()];
    let next;
    if (ids.length >= 2 && pointers.has(ids[0]) && pointers.has(ids[1])) {
      const at = (positions) => ids.slice(0, 2).map((id) => drawingPoint(positions.get(id), start.drawing));
      dragged.current = true;
      next = pinchView(start.view, start.drawing.axes, allowed, at(start.pointers), at(pointers));
    } else {
      const from = start.pointers.get(event.pointerId);
      if (!from) return;
      const dx = event.clientX - from.clientX,
        dy = event.clientY - from.clientY;
      // A touch may wobble a little and still be a tap.
      const slop = event.pointerType === 'mouse' ? 3 : 8;
      if (!dragged.current && Math.hypot(dx, dy) < slop) return;
      dragged.current = true;
      const {x, y} = drawingScale(canvas.current, start.drawing);
      next = panView(start.view, start.drawing.axes, allowed, {x: dx * x, y: dy * y});
    }
    // A gesture along locked axes only changes nothing.
    if (next !== latest.current.view) onViewChange(next);
  };
  const endPointer = (event) => {
    const {pointers} = gesture.current;
    if (!pointers.delete(event.pointerId)) return;
    // A finger left after a pinch pans on from the current view.
    beginGesture();
  };
  useEffect(() => {
    if (!zoomable) return;
    const node = canvas.current;
    // A non-passive listener, so the page does not scroll as the chart zooms.
    const wheel = (event) => {
      const {drawing, view, onViewChange} = latest.current;
      if (!drawing?.axes) return;
      event.preventDefault();
      const {rect, x, y} = drawingScale(node, drawing);
      const point = {
        x: (event.clientX - rect.left) * x,
        y: (event.clientY - rect.top) * y,
      };
      const next = zoomView(view, drawing.axes, allowed, point, wheelFactor(event));
      if (next !== view) onViewChange(next);
    };
    node.addEventListener('wheel', wheel, {passive: false});
    return () => node.removeEventListener('wheel', wheel);
  }, [zoomable, allowed]);
  const plot = {id, canvas, wrapper, points, summary, detailsTarget};
  const pinned = selection?.id === id;
  const active = pinned
    ? selection
    : !selection && hover?.id === id
      ? hover
      : null;
  const point = active && points[active.index];
  // One marker per X with unavailable results; in a launch-group chart, a
  // status shared by several dispatches is listed once with its count.
  // A zoomed view drops the markers it leaves out.
  const markers = drawing?.xPosition
    ? Array.from(
        Map.groupBy(sourceRows, spec.xOf ?? ((row) => row.x)),
        ([x, rows]) => {
          const marked = rows.flatMap((row) =>
            spec.series
              .filter((curve) => isMarked(row, curve.id))
              .map((curve) => ({curve, status: row.statuses[curve.id]})),
          );
          const xFraction = drawing.xPosition(x);
          if (!marked.length || xFraction === null) return null;
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
            xFraction,
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
          data-zoomable={zoomable || undefined}
          // The overlay handles pinch, pan and double tap itself.
          style={zoomable ? {touchAction: 'none'} : undefined}
          onPointerMove={(event) => {
            if (gesture.current.pointers.has(event.pointerId)) {
              moveGesture(event);
              return;
            }
            if (event.pointerType !== 'mouse' || pinned || selection) return;
            const index = nearestPoint(
              event,
              canvas.current,
              points,
              event.pointerType,
              drawnSize,
            );
            canvas.current.style.cursor = index < 0 ? '' : 'pointer';
            showHover(plot, index);
          }}
          onPointerDown={(event) => {
            pointer.current = event.pointerType;
            if (!zoomable || (event.pointerType === 'mouse' && event.button !== 0)) return;
            const {pointers} = gesture.current;
            // A second pointer makes a pinch, never a tap.
            dragged.current = pointers.size > 0;
            pointers.set(event.pointerId, {clientX: event.clientX, clientY: event.clientY});
            beginGesture();
            // Capture fails for a pointer that is no longer active.
            try {
              canvas.current.setPointerCapture?.(event.pointerId);
            } catch {
              // The gesture still follows events on the canvas.
            }
          }}
          onPointerUp={endPointer}
          onPointerCancel={(event) => {
            pointer.current = undefined;
            endPointer(event);
          }}
          onDoubleClick={() => {
            cancelTap();
            if (zoomable && view) onViewChange(null);
          }}
          onClick={(event) => {
            // The click that ends a drag or pinch, or the second click of a
            // double click or tap on a zoomable chart, selects nothing; a
            // double tap resets a zoomed view as a double click does.
            if (dragged.current) {
              dragged.current = false;
              pointer.current = undefined;
              return;
            }
            const touchTap =
              zoomable && (event.nativeEvent.pointerType || pointer.current) === 'touch';
            if (touchTap) {
              const tap = {time: event.timeStamp, x: event.clientX, y: event.clientY};
              const last = lastTap.current;
              lastTap.current = tap;
              if (
                last &&
                tap.time - last.time < DOUBLE_TAP_MS &&
                Math.hypot(tap.x - last.x, tap.y - last.y) < 30
              ) {
                lastTap.current = null;
                pointer.current = undefined;
                cancelTap();
                if (view) onViewChange(null);
                return;
              }
            }
            if (zoomable && event.detail > 1) {
              cancelTap();
              pointer.current = undefined;
              return;
            }
            const index = nearestPoint(
              event,
              canvas.current,
              points,
              event.nativeEvent.pointerType || pointer.current,
              drawnSize,
            );
            pointer.current = undefined;
            const apply = () => {
              if (index < 0 || (pinned && selection.index === index)) close();
              else select(plot, index);
            };
            cancelTap();
            if (zoomable && view)
              pendingTap.current = setTimeout(() => {
                pendingTap.current = null;
                apply();
              }, DOUBLE_TAP_MS);
            else apply();
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
              left: (100 * point.x) / drawing.width + '%',
              top: (100 * point.y) / drawing.height + '%',
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
            {markers.map(({xFraction, state, symbol, message}, i) => (
              <button
                type="button"
                className="plot-status-marker"
                data-state={state}
                data-emoji={
                  /\p{Emoji_Presentation}|\uFE0F/u.test(symbol) || undefined
                }
                key={i}
                style={{left: 100 * xFraction + '%'}}
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
  title,
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
  const controls = (
    <div className="scale-group" role="group" aria-label="Axis scales">
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
  );
  return (
    <div className="plot">
      <ChartFrame
        spec={spec}
        theme={theme}
        title={title}
        controls={controls}
        legend={<Legend curves={curves} />}
      />
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
                  title={
                    displayName(id) +
                    ' · ' +
                    group.label +
                    (group.plots.length > 1 ? ' · ' + displayUnit(plot.unit) : '')
                  }
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
  legend,
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
      <SummaryChart
        spec={spec}
        theme={theme}
        title={'Measured vs. simulated' + (unit ? ' · ' + displayUnit(unit) : '')}
        legend={legend}
        controls={
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
        }
      />
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
      // The scale is resolved here, so the overlay sees when data flips it.
      cdf: {
        kind: 'cdf',
        pairs,
        bands: pairs,
        log: preferLogScale(pairs.map((pair) => Math.abs(pair.signedError))),
      },
      scatter: Array.from(
        Map.groupBy(pairs, (pair) => pair.unit),
        ([unit, values]) => ({unit, pairs: values}),
      ),
    };
  }, [sourcePairs, summary, scope, groups, theme]);
  const {count, colors, stats, percentiles, ranked, cdf} = model;
  // The S-curve's log-factor Y axis, remembered per scope like scatter scales.
  const factorKey = JSON.stringify(['scurve-factor', scope]);
  const factor = preferences.get(factorKey) ?? false;
  const rankedSpec = useMemo(() => ({...ranked, factor}), [ranked, factor]);
  // The CDF's log X axis: the automatic choice unless toggled, per scope.
  const cdfKey = JSON.stringify(['cdf-log', scope]);
  const cdfLog =
    preferences.get(cdfKey) ??
    cdf.log ??
    preferLogScale(cdf.pairs.map((pair) => Math.abs(pair.signedError)));
  const cdfSpec = useMemo(() => ({...cdf, log: cdfLog}), [cdf, cdfLog]);
  const {close} = usePoints();
  if (!count) return null;
  const legend = <Legend curves={[...colors.values()]} />;
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
        {legend}
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
          <SummaryChart
            spec={rankedSpec}
            theme={theme}
            title="S-curve"
            legend={legend}
            controls={
              <Button
                size="compact-xs"
                variant={factor ? 'filled' : 'default'}
                aria-pressed={factor}
                title="Plot simulated / measured as a factor on a log scale"
                onClick={() => {
                  close();
                  setPreference(factorKey, !factor);
                }}
              >
                Y log factor
              </Button>
            }
          />
          <SampleNote shown={ranked.pairs.length} count={count} />
          <PlotDetails entries={stats} count={count}>
            <p>
              {factor
                ? 'Above 1× the simulator is slower than hardware; below, faster.'
                : 'Negative values are underestimates. Positive values are overestimates.'}
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
          <SummaryChart
            spec={cdfSpec}
            theme={theme}
            title="Absolute error distribution (CDF)"
            controls={
              <Button
                size="compact-xs"
                variant={cdfLog ? 'filled' : 'default'}
                aria-pressed={cdfLog}
                onClick={() => {
                  close();
                  setPreference(cdfKey, !cdfLog);
                }}
              >
                X log
              </Button>
            }
          />
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
              legend={legend}
            />
          ))}
        </Paper>
      </div>
    </section>
  );
}
