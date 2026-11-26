import {ActionIcon, Paper, Portal} from '@mantine/core';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {useMediaQuery} from '@mantine/hooks';
import {displayName, displayUnit, launchBands} from './model.js';

const PointContext = createContext(null);
export const desktopQuery =
  '(min-width: 821px) and (hover: hover) and (pointer: fine)';
export const landscapeQuery =
  '(max-width: 820px) and (orientation: landscape), (hover: none) and (orientation: landscape), (pointer: coarse) and (orientation: landscape)';
const detailNumber = new Intl.NumberFormat('en-US', {
  maximumSignificantDigits: 7,
});
const parameterNumber = new Intl.NumberFormat('en-US', {
  maximumSignificantDigits: 17,
});
export const wrapIndex = (index, count) => ((index % count) + count) % count;
export const usePoints = () => useContext(PointContext);

const formatValue = (value, unit) =>
  detailNumber.format(unit === 'ns' ? value / 1e6 : value) +
  (unit ? ' ' + displayUnit(unit) : '');

const percent = (q) => 'P' + Math.round(q * 100);

// Details of a launch-group median point: dispatch and pair counts, each
// curve's spread over the dispatches its median was taken from, and every
// dispatch at this X.
function LaunchGroupDetails({launches, meta}) {
  const {rows, comparisons, curves} = launches;
  const series = Object.entries(meta.values).filter(([id]) =>
    rows.some(
      (row) =>
        Object.hasOwn(row.values, id) ||
        (row.statuses && Object.hasOwn(row.statuses, id)),
    ),
  );
  const cell = (row, id, unit) => {
    const value = Object.hasOwn(row.values, id) ? row.values[id] : undefined;
    if (Number.isFinite(value)) return formatValue(value, unit);
    const status =
      row.statuses && Object.hasOwn(row.statuses, id) ? row.statuses[id] : null;
    return status ? displayName(status.state) : '—';
  };
  return (
    <div className="point-launches">
      <div className="point-section-label">Launch group</div>
      <dl className="point-parameters">
        <div>
          <dt>Dispatches at this X</dt>
          <dd>{rows.length.toLocaleString('en-US')}</dd>
        </div>
        {comparisons.map((comparison) => (
          <div key={comparison.name}>
            <dt>
              Paired
              {comparisons.length > 1 ? ' · ' + comparison.name : ''}
            </dt>
            <dd>
              {comparison.count.toLocaleString('en-US')} of{' '}
              {rows.length.toLocaleString('en-US')}
            </dd>
          </div>
        ))}
        {series.flatMap(([id, info]) => {
          const set = Object.hasOwn(curves, id) ? curves[id] : null;
          if (!set) return [];
          const {sorted, bands} = set;
          const range = (low, high) =>
            formatValue(low, info.unit) + ' – ' + formatValue(high, info.unit);
          return [
            <div key={id} className="point-launch-series">
              <dt>{info.name}</dt>
              <dd>median of {sorted.length.toLocaleString('en-US')}</dd>
            </div>,
            ...bands
              .map((band, level) => [band, launchBands[level]])
              .filter(([band]) => band)
              .reverse()
              .map(([[low, high], {low: lq, high: hq}]) => (
                <div key={id + ':' + lq} className="point-launch-spread">
                  <dt>
                    {percent(lq)}–{percent(hq)}
                  </dt>
                  <dd>{range(low, high)}</dd>
                </div>
              )),
            <div key={id + ':range'} className="point-launch-spread">
              <dt>Range</dt>
              <dd>{range(sorted[0], sorted.at(-1))}</dd>
            </div>,
          ];
        })}
      </dl>
      <details className="point-dispatches">
        <summary>Dispatches ({rows.length.toLocaleString('en-US')})</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">Launch</th>
              {series.map(([id, info]) => (
                <th scope="col" key={id} title={info.name}>
                  {info.name.replace(/ kernel time(?: \(median\))?$/i, '')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                <th scope="row">{String(row.non_scaling_params.launch ?? '—')}</th>
                {series.map(([id, info]) => (
                  <td key={id}>{cell(row, id, info.unit)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

export function PointDescription({description, benchmarks, groups}) {
  const {point, comparisons = [], extra = {}, selectedSeries} = description;
  const meta = benchmarks[point.benchmark];
  // A launch-group median names its group where a dispatch names its launch.
  const kernel = point.launches ? 'launch_group' : 'launch';
  const title = displayName(point.benchmark).replace(
    /\b(fp\d+|int\d+)\b/gi,
    (word) => word.toUpperCase(),
  );
  return (
    <div className="point-content">
      <div className="point-header">
        <strong className="point-title">{title}</strong>
        <span className="point-group">{groups[point.group].name}</span>
      </div>
      {point.non_scaling_params[kernel] !== undefined && (
        <div className="point-kernel">
          {String(point.non_scaling_params[kernel])}
        </div>
      )}
      <dl className="point-measurements">
        {Object.entries(meta.values).map(([id, series]) => {
          // Own properties only: series keys are producer-chosen
          // (`constructor`, `__proto__`).
          const measured = Object.hasOwn(point.values, id);
          const value = measured ? point.values[id] : undefined,
            status =
              point.statuses && Object.hasOwn(point.statuses, id)
                ? point.statuses[id]
                : undefined;
          if (!measured && !status) return null;
          const role =
            series.role === 'hardware_measurement'
              ? 'Measured'
              : series.role === 'simulator_output'
                ? 'Simulated'
                : 'Value';
          return (
            <div
              key={id}
              data-role={series.role ?? 'other'}
              className={
                'point-measurement' +
                (id === selectedSeries ? ' point-measurement-selected' : '')
              }
            >
              <dt
                className="point-measurement-label"
                aria-label={role + ': ' + series.name}
              >
                {role}
                <span className="point-measurement-source" title={series.name}>
                  {series.name.replace(/ kernel time(?: \(median\))?$/i, '')}
                </span>
              </dt>
              {Number.isFinite(value) ? (
                <dd
                  className="point-measurement-value"
                  title={String(value) + (series.unit ? ' ' + series.unit : '')}
                >
                  <strong>
                    {detailNumber.format(
                      series.unit === 'ns' ? value / 1e6 : value,
                    )}
                  </strong>
                  {series.unit && (
                    <span className="point-unit">
                      {displayUnit(series.unit)}
                    </span>
                  )}
                </dd>
              ) : (
                <dd className="point-measurement-value point-measurement-unavailable">
                  {status ? displayName(status.state) : 'Unavailable'}
                </dd>
              )}
              {status?.reason && !Number.isFinite(value) && (
                <dd className="point-measurement-reason">{status.reason}</dd>
              )}
            </div>
          );
        })}
      </dl>
      {(comparisons.length > 0 || Object.keys(extra).length > 0) && (
        <div className="point-metrics">
          {comparisons.map((pair, i) => (
            <div className="point-error" key={pair.id ?? i}>
              {comparisons.length > 1 && (
                <div className="point-comparison-name">{pair.name}</div>
              )}
              <div className="point-metric-row">
                <span className="point-metric-label">
                  {point.launches ? 'Error between medians' : 'Signed error'}
                </span>
                <span className="point-error-result">
                  <strong className="point-error-value">
                    {pair.signedError > 0
                      ? '+'
                      : pair.signedError < 0
                        ? '−'
                        : ''}
                    {Math.abs(pair.signedError).toFixed(2)}%
                  </strong>
                  <span className="point-direction">
                    {pair.signedError < 0
                      ? 'Underestimate'
                      : pair.signedError > 0
                        ? 'Overestimate'
                        : 'Exact match'}
                  </span>
                </span>
              </div>
            </div>
          ))}
          {Object.entries(extra).map(([label, value]) => (
            <div className="point-metric-row" key={label}>
              <span className="point-metric-label">{label}</span>
              <strong className="point-metric-value">{value}</strong>
            </div>
          ))}
        </div>
      )}
      {point.launches && (
        <LaunchGroupDetails launches={point.launches} meta={meta} />
      )}
      <div className="point-configuration">
        <div className="point-section-label">Configuration</div>
        <dl className="point-parameters">
          {Object.entries({
            [meta.scaling_param]: point.x,
            ...point.non_scaling_params,
          }).map(([key, value]) => {
            if (key === kernel && key !== meta.scaling_param) return null;
            const label = displayName(key)
              .replace(
                /\b(fmas|mads)\b/gi,
                (word) => word.slice(0, -1).toUpperCase() + 's',
              )
              .replace(/ per /g, ' / ')
              .replace(/^num blocks$/, 'Blocks')
              .replace(/^threads/, 'Threads');
            const unit = meta.params[key].unit;
            return (
              <div key={key}>
                <dt>{label.charAt(0).toUpperCase() + label.slice(1)}</dt>
                <dd>
                  {typeof value === 'number'
                    ? parameterNumber.format(value)
                    : String(value)}
                  {unit ? ' ' + unit : ''}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
    </div>
  );
}

export function PointProvider({
  children,
  benchmarks,
  groups,
  overview,
  resetKey,
}) {
  const [selection, setSelection] = useState(null);
  const [hover, setHover] = useState(null);
  const selectedRef = useRef(null);
  const contentRef = useRef(null),
    panelRef = useRef(null);
  const pendingScroll = useRef(null),
    pendingFocus = useRef(null);
  const desktop = useMediaQuery(desktopQuery, false, {
    getInitialValueInEffect: false,
  });
  const landscape = useMediaQuery(landscapeQuery, false, {
    getInitialValueInEffect: false,
  });
  const sourceHidden = selection?.summary && desktop && !overview;
  const attachContent = useCallback(
    (node) => {
      contentRef.current = node;
      if (node && sourceHidden) node.focus({preventScroll: true});
    },
    [sourceHidden],
  );
  const close = useCallback((restore = false) => {
    const current = selectedRef.current;
    if (restore && current) pendingFocus.current = current.canvas.current;
    selectedRef.current = null;
    setSelection(null);
    setHover(null);
  }, []);
  const removePlot = useCallback(
    (id) => {
      if (selectedRef.current?.id === id) close();
      else setHover((current) => (current?.id === id ? null : current));
    },
    [close],
  );
  const select = useCallback(
    (plot, index) => {
      if (!selectedRef.current && landscape)
        pendingScroll.current = plot.canvas.current;
      const next = {...plot, index};
      selectedRef.current = next;
      setSelection(next);
      setHover(null);
    },
    [landscape],
  );
  const showHover = useCallback((plot, index) => {
    if (!selectedRef.current) setHover(index < 0 ? null : {...plot, index});
  }, []);
  const step = useCallback(
    (delta) => {
      const current = selectedRef.current;
      if (current)
        select(
          current,
          wrapIndex(current.index + delta, current.points.length),
        );
    },
    [select],
  );

  useLayoutEffect(() => {
    close();
  }, [resetKey, close]);
  useLayoutEffect(() => {
    document.body.classList.toggle('point-details-open', !!selection);
    document.body.classList.toggle('overview-view', overview);
    if (pendingScroll.current) {
      pendingScroll.current.scrollIntoView({
        block: 'nearest',
        inline: 'nearest',
      });
      pendingScroll.current = null;
    }
    if (pendingFocus.current) {
      if (landscape)
        pendingFocus.current.scrollIntoView({
          block: 'nearest',
          inline: 'nearest',
        });
      pendingFocus.current.focus({preventScroll: true});
      pendingFocus.current = null;
    }
  }, [selection, overview, landscape]);
  useLayoutEffect(() => {
    if (sourceHidden) contentRef.current?.focus({preventScroll: true});
  }, [sourceHidden, selection?.id]);
  useLayoutEffect(
    () => () => {
      document.body.classList.remove('point-details-open', 'overview-view');
    },
    [],
  );
  useEffect(() => {
    const click = (event) => {
      const current = selectedRef.current;
      if (
        current &&
        !current.wrapper.current?.contains(event.target) &&
        !panelRef.current?.contains(event.target)
      )
        close();
    };
    const keydown = (event) => {
      if (event.key === 'Escape') close(true);
    };
    // Click dismissal happens after the activated target handles its click.
    document.addEventListener('click', click);
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('click', click);
      document.removeEventListener('keydown', keydown);
    };
  }, [close]);
  const browse = (event, plot) => {
    if (
      ![
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
        'Home',
        'End',
        'Enter',
        ' ',
      ].includes(event.key)
    )
      return;
    event.preventDefault();
    const current =
      selectedRef.current?.id === plot.id ? selectedRef.current.index : -1;
    const index =
      event.key === 'End'
        ? plot.points.length - 1
        : event.key === 'Home' || current < 0
          ? 0
          : ['ArrowLeft', 'ArrowUp'].includes(event.key)
            ? wrapIndex(current - 1, plot.points.length)
            : ['ArrowRight', 'ArrowDown'].includes(event.key)
              ? wrapIndex(current + 1, plot.points.length)
              : current;
    select(plot, index);
  };
  const value = {
    selection,
    hover,
    select,
    close,
    showHover,
    browse,
    contentRef,
    removePlot,
    benchmarks,
    groups,
  };
  return (
    <PointContext.Provider value={value}>
      {children}
      {selection && (
        <Portal>
          <Paper
            ref={panelRef}
            className="point-detail point-detail-pinned"
            role="group"
            aria-label="Point details"
            withBorder
            radius="md"
            shadow="md"
          >
            <div
              id="pinned-point-description"
              className="point-description"
              ref={attachContent}
              tabIndex={0}
              aria-live="polite"
              aria-atomic="true"
              onKeyDown={(event) => {
                if (event.key === 'Tab' && event.shiftKey && !sourceHidden) {
                  event.preventDefault();
                  selection.canvas.current?.focus({preventScroll: true});
                }
                if (
                  ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
                )
                  browse(event, selection);
              }}
            >
              <PointDescription
                description={selection.points[selection.index].description}
                benchmarks={benchmarks}
                groups={groups}
              />
            </div>
            <div className="point-controls">
              {[
                [-10, '<<', 'Previous 10 points'],
                [-1, '<', 'Previous point'],
              ].map(([delta, glyph, label]) => (
                <ActionIcon
                  key={delta}
                  size={24}
                  variant="subtle"
                  color="gray"
                  title={label}
                  aria-label={label}
                  onClick={() => step(delta)}
                >
                  {glyph}
                </ActionIcon>
              ))}
              <span>
                {selection.index + 1} / {selection.points.length}
              </span>
              {[
                [1, '>', 'Next point'],
                [10, '>>', 'Next 10 points'],
              ].map(([delta, glyph, label]) => (
                <ActionIcon
                  key={delta}
                  size={24}
                  variant="subtle"
                  color="gray"
                  title={label}
                  aria-label={label}
                  onClick={() => step(delta)}
                >
                  {glyph}
                </ActionIcon>
              ))}
              <ActionIcon
                size={24}
                variant="subtle"
                color="gray"
                title="Close point details"
                aria-label="Close point details"
                onClick={() => close(true)}
              >
                ×
              </ActionIcon>
            </div>
          </Paper>
        </Portal>
      )}
    </PointContext.Provider>
  );
}
