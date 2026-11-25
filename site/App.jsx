import {
  Anchor,
  Badge,
  MantineProvider,
  NativeSelect,
  Paper,
  Progress,
  Tabs,
  createTheme,
  localStorageColorSchemeManager,
  useComputedColorScheme,
  useMantineColorScheme,
} from '@mantine/core';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';
import {Benchmark, Summary} from './Charts.jsx';
import {PointProvider} from './PointDetails.jsx';
import {comparisonPairs, isMarked} from './model.js';

const storageKey = 'calibration-report-theme';
const colorManager = localStorageColorSchemeManager({key: storageKey});
const mantineTheme = createTheme({
  primaryColor: 'teal',
  fontFamily: 'Inter, system-ui, sans-serif',
  defaultRadius: 'sm',
});
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

export function useReport() {
  const [state, setState] = useState({
    snapshot: null,
    revision: 0,
    waiting: true,
  });
  useEffect(() => {
    let stopped = false,
      timer,
      live = false;
    const controller = new AbortController();
    async function refresh() {
      try {
        const response = await fetch('./data.json', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Data unavailable');
        const raw = await response.json();
        const report = {
          ...raw.report,
          groups: raw.report?.groups ?? raw.groups,
        };
        const snapshot = {...raw, report, data: raw.data ?? raw.points};
        const signature = JSON.stringify([
          report.groups,
          snapshot.benchmarks,
          snapshot.data,
        ]);
        live = report.live === true;
        if (!stopped)
          setState((previous) => {
            const same = signature === previous.signature;
            if (same) {
              snapshot.report.groups = previous.snapshot.report.groups;
              snapshot.benchmarks = previous.snapshot.benchmarks;
              snapshot.data = previous.snapshot.data;
            }
            return {
              snapshot,
              signature,
              revision: previous.revision + (same ? 0 : 1),
              waiting: false,
            };
          });
      } catch (error) {
        if (!stopped && error.name !== 'AbortError')
          setState((previous) => ({...previous, waiting: true}));
      }
      if (!stopped && live) timer = setTimeout(refresh, 10000);
    }
    refresh();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, []);
  return state;
}
function RunProgress({progress, live}) {
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
        progress.total.toLocaleString(),
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
            <span>{progress.total.toLocaleString()} points</span>
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
export function Report({snapshot, revision = 0, waiting = false}) {
  const {report, benchmarks, data, progress} = snapshot;
  const [chosenGroup, setGroup] = useState(undefined);
  const [preferences, setPreferences] = useState(() => new Map());
  const setPreference = useCallback(
    (key, value) =>
      setPreferences((previous) => new Map(previous).set(key, value)),
    [],
  );
  const {colorScheme, setColorScheme} = useMantineColorScheme();
  const scheme = useComputedColorScheme('light');
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
  const {measured, pairs, groupIds} = useMemo(() => {
    const measured = data.filter(
      (point) =>
        Object.values(point.values).some(Number.isFinite) ||
        Object.keys(point.statuses ?? {}).some((id) => isMarked(point, id)),
    );
    return {
      measured,
      pairs: comparisonPairs(measured, benchmarks),
      groupIds: [...new Set(measured.map((point) => point.group))],
    };
  }, [data, benchmarks]);
  const group =
    (chosenGroup === null && pairs.length) || groupIds.includes(chosenGroup)
      ? chosenGroup
      : pairs.length
        ? null
        : groupIds[0];
  const overview = group === null;
  useEffect(() => {
    if (chosenGroup !== group) setGroup(group);
  }, [chosenGroup, group]);
  const {groupPairs, byBenchmark, pairsByBenchmark} = useMemo(() => {
    const groupPairs = overview
      ? pairs
      : pairs.filter((pair) => pair.group === group);
    return {
      groupPairs,
      byBenchmark: Map.groupBy(
        measured.filter((point) => point.group === group),
        (point) => point.benchmark,
      ),
      pairsByBenchmark: Map.groupBy(groupPairs, (pair) => pair.point.benchmark),
    };
  }, [group, overview, pairs, measured]);
  const views = groupIds.map((id) => ({id, name: report.groups[id].name}));
  if (pairs.length) views.unshift({id: null, name: 'Overview'});
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = scheme;
  }, [scheme]);
  useEffect(() => {
    document.title = report.title || 'Calibration report';
  }, [report.title]);
  return (
    <PointProvider
      key={revision}
      benchmarks={benchmarks}
      groups={report.groups}
      overview={overview}
      resetKey={JSON.stringify([revision, group, scheme])}
    >
      <main>
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
                {waiting
                  ? 'Waiting for report data'
                  : progress?.updated_at
                    ? 'Updated ' +
                      new Date(progress.updated_at).toLocaleTimeString()
                    : ''}
              </span>
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
              <Anchor className="report-data-link" href="./data.json" size="xs">
                Results JSON
              </Anchor>
            </div>
          </div>
        </header>
        <RunProgress progress={progress} live={report.live === true} />
        <Tabs
          value={JSON.stringify(group) ?? 'empty'}
          onChange={(value) => setGroup(JSON.parse(value))}
          className="report-tabs"
        >
          {views.length > 1 && (
            <Tabs.List aria-label="Report views">
              {views.map((view) => (
                <Tabs.Tab
                  key={JSON.stringify(view.id)}
                  value={JSON.stringify(view.id)}
                >
                  {view.name}
                </Tabs.Tab>
              ))}
            </Tabs.List>
          )}
          <Tabs.Panel value={JSON.stringify(group) ?? 'empty'}>
            <Summary
              pairs={groupPairs}
              scope={group}
              groups={report.groups}
              theme={theme}
              preferences={preferences}
              setPreference={setPreference}
            />
            <section
              className="charts"
              id="charts"
              aria-label="Benchmark plots"
            >
              {!overview &&
                Array.from(byBenchmark, ([id, rows]) => (
                  <Benchmark
                    key={JSON.stringify([group, id])}
                    id={id}
                    rows={rows}
                    meta={benchmarks[id]}
                    pairs={pairsByBenchmark.get(id) ?? []}
                    theme={theme}
                    preferences={preferences}
                    setPreference={setPreference}
                  />
                ))}
            </section>
          </Tabs.Panel>
        </Tabs>
      </main>
    </PointProvider>
  );
}
function LoadedReport() {
  const {snapshot, revision, waiting} = useReport();
  return snapshot ? (
    <Report snapshot={snapshot} revision={revision} waiting={waiting} />
  ) : (
    <main>
      <h1>Calibration report</h1>
      <p role="status">Waiting for report data</p>
    </main>
  );
}
export default function App() {
  return (
    <MantineProvider
      theme={mantineTheme}
      colorSchemeManager={colorManager}
      defaultColorScheme="auto"
    >
      <LoadedReport />
    </MantineProvider>
  );
}
