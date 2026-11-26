import {
  Anchor,
  Badge,
  NativeSelect,
  Paper,
  Progress,
  useComputedColorScheme,
  useMantineColorScheme,
} from '@mantine/core';
import {useMemo} from 'react';

const chartColors = {
  light: {
    grid: '#e5ecee',
    label: '#526a75',
    reference: '#69808a',
    hardware: '#b57e14',
    simulator: '#16815d',
    palette: ['#2b7884', '#ad6b19', '#7d54aa', '#a2404b', '#4e782e'],
  },
  dark: {
    grid: '#364850',
    label: '#adbec7',
    reference: '#8da2ad',
    hardware: '#e9b64e',
    simulator: '#55cc9d',
    palette: ['#69c5d4', '#f0ac66', '#c0a2eb', '#ed939a', '#a1c87e'],
  },
};

export function useChartTheme() {
  const scheme = useComputedColorScheme('light', {
    getInitialValueInEffect: false,
  });
  const theme = useMemo(() => {
    const colors = chartColors[scheme];
    return {
      ...colors,
      roles: new Map([
        ['hardware_measurement', {color: colors.hardware, layer: 0}],
        ['simulator_output', {color: colors.simulator, layer: 2}],
      ]),
    };
  }, [scheme]);
  return {scheme, theme};
}
export function ReportHeader({report, status, dataLink, actions, children}) {
  const {colorScheme, setColorScheme} = useMantineColorScheme();
  return (
    <header className="report-header">
      <h1 id="title">{report.title || 'Calibration report'}</h1>
      {report.description && (
        <p className="muted report-description">{report.description}</p>
      )}
      <div className="report-meta">
        <div className="report-status">
          {report.live === true && (
            <Badge
              className="live-badge"
              color="teal"
              variant="light"
              leftSection={<span className="live-dot" aria-hidden="true" />}
            >
              Live
            </Badge>
          )}
          <span className="muted" aria-live="polite">
            {status}
          </span>
          {children}
        </div>
        <div className="report-actions">
          <NativeSelect
            aria-label="Theme"
            size="xs"
            value={colorScheme}
            onChange={(event) => setColorScheme(event.currentTarget.value)}
            data={[
              {value: 'auto', label: 'System'},
              {value: 'light', label: 'Light'},
              {value: 'dark', label: 'Dark'},
            ]}
          />
          {dataLink && (
            <Anchor className="report-data-link" href={dataLink} size="xs">
              Results JSON
            </Anchor>
          )}
          {actions}
        </div>
      </div>
    </header>
  );
}
// `unit` names what the counts count: data.json progress counts
// configurations; the hosted viewer's derived progress counts points.
export function RunProgress({progress, live, unit = 'configurations'}) {
  if (!progress) return null;
  const remaining = Math.max(
    0,
    progress.total - progress.completed - progress.running,
  );
  const failed =
    progress.unsuccessful ??
    Math.max(0, remaining - (progress.queued ?? remaining));
  const states = [
    ['completed', 'Completed', progress.completed],
    ['running', 'Running', progress.running],
    ['failed', 'Failed', failed],
    [
      'pending',
      'Not started',
      progress.queued ?? Math.max(0, remaining - failed),
    ],
  ];
  const stats = [
    [
      'Completed',
      progress.completed.toLocaleString() +
        ' / ' +
        progress.total.toLocaleString() +
        ' ' +
        unit,
    ],
    ['Running', progress.running.toLocaleString()],
  ];
  if (progress.queued !== undefined)
    stats.push(['Queued', progress.queued.toLocaleString()]);
  if (progress.unsuccessful !== undefined)
    stats.push([
      'Unsuccessful or unavailable',
      progress.unsuccessful.toLocaleString(),
    ]);
  if (progress.started_at)
    stats.push(['Started', new Date(progress.started_at).toLocaleString()]);
  return (
    <Paper
      component="section"
      id="progress"
      className="progress"
      aria-label="Run progress"
      withBorder
      radius="md"
      p="md"
    >
      {live ? (
        <div className="live-progress">
          <div className="progress-caption">
            <h2>Run progress</h2>
            <span>
              {progress.total.toLocaleString()} {unit}
            </span>
          </div>
          <Progress.Root size={8} aria-hidden="true">
            {states.map(([state, , count]) => (
              <Progress.Section
                key={state}
                value={progress.total ? (100 * count) / progress.total : 0}
                color={
                  'var(--' + (state === 'pending' ? 'pending' : state) + ')'
                }
              />
            ))}
          </Progress.Root>
          <ul className="progress-legend">
            {states.map(([state, label, count]) => (
              <li
                key={state}
                className={'progress-count ' + state}
                title={
                  state === 'failed'
                    ? 'Includes timeouts and unavailable configurations'
                    : undefined
                }
              >
                <i className="progress-key" aria-hidden="true" />
                <span>{label}</span>
                <strong>{count.toLocaleString()}</strong>
              </li>
            ))}
          </ul>
          {progress.started_at && (
            <p className="progress-started">
              Started {new Date(progress.started_at).toLocaleString()}
            </p>
          )}
        </div>
      ) : (
        stats.map(([label, value]) => (
          <div className="progress-item" key={label}>
            <strong>{value}</strong>
            <span>{label}</span>
          </div>
        ))
      )}
    </Paper>
  );
}
