import {
  MantineProvider,
  Tabs,
  createTheme,
  localStorageColorSchemeManager,
  useComputedColorScheme,
} from '@mantine/core';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';
import {Benchmark, Summary} from './Charts.jsx';
import {HostedReport, RunList} from './Hosted.jsx';
import {ReportHeader, RunProgress, useChartTheme} from './Layout.jsx';
import {PointProvider} from './PointDetails.jsx';
import {indexReport} from './model.js';
import {PageControls, pageWindow} from './Pagination.jsx';

const emptyView = {pairs: [], benchmarks: []};
const benchmarkPageSizes = [5, 10, 20, 50];
const storageKey = 'calibration-report-theme';
const colorManager = localStorageColorSchemeManager({key: storageKey});
const mantineTheme = createTheme({
  primaryColor: 'teal',
  fontFamily: 'Inter, system-ui, sans-serif',
  defaultRadius: 'sm',
});

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
export function Report({snapshot, revision = 0, waiting = false}) {
  const {report, benchmarks, data, progress} = snapshot;
  const [chosenGroup, setGroup] = useState(undefined);
  const [pages, setPages] = useState(() => new Map());
  const setPage = useCallback((key, value) => {
    setPages((previous) => new Map(previous).set(key, value));
  }, []);
  const [preferences, setPreferences] = useState(() => new Map());
  const setPreference = useCallback(
    (key, value) =>
      setPreferences((previous) => new Map(previous).set(key, value)),
    [],
  );
  const {scheme, theme} = useChartTheme();
  const index = useMemo(
    () => indexReport(data, benchmarks),
    [data, benchmarks],
  );
  const {pairs} = index;
  const groupIds = [...index.groups.keys()];
  // Clamp every remembered page on a live update, including inactive views.
  // Persist the clamp so later growth does not unexpectedly restore an old page.
  useEffect(() => {
    setPages((previous) => {
      let next = previous;
      for (const [key, settings] of previous) {
        const [groupId, benchmarkId] = JSON.parse(key);
        const view = index.groups.get(groupId) ?? emptyView;
        const count =
          benchmarkId === undefined
            ? view.benchmarks.length
            : (view.benchmarks.find((benchmark) => benchmark.id === benchmarkId)
                ?.series.length ?? 0);
        const {page} = pageWindow(count, settings, settings.size);
        if (page !== settings.page) {
          if (next === previous) next = new Map(previous);
          next.set(key, {...settings, page});
        }
      }
      return next;
    });
  }, [index]);
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
  const view = index.groups.get(group) ?? emptyView;
  const groupPairs = overview ? pairs : view.pairs;
  const benchmarkPageKey = JSON.stringify([group]);
  const benchmarkWindow = pageWindow(
    view.benchmarks.length,
    pages.get(benchmarkPageKey),
    10,
  );
  const views = groupIds.map((id) => ({id, name: report.groups[id].name}));
  if (pairs.length) views.unshift({id: null, name: 'Overview'});
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
        <ReportHeader
          report={report}
          status={
            waiting
              ? 'Waiting for report data'
              : progress?.updated_at
                ? 'Updated ' + new Date(progress.updated_at).toLocaleTimeString()
                : ''
          }
          dataLink="./data.json"
        />
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
              {!overview && view.benchmarks.length > 0 && (
                <>
                  <PageControls
                    label="Benchmark"
                    noun="benchmarks"
                    count={view.benchmarks.length}
                    window={benchmarkWindow}
                    sizes={benchmarkPageSizes}
                    onChange={(value) => setPage(benchmarkPageKey, value)}
                  />
                  {view.benchmarks
                    .slice(benchmarkWindow.start, benchmarkWindow.end)
                    .map((benchmark) => {
                      const pageKey = JSON.stringify([group, benchmark.id]);
                      return (
                        <Benchmark
                          key={pageKey}
                          id={benchmark.id}
                          series={benchmark.series}
                          meta={benchmarks[benchmark.id]}
                          pairs={benchmark.pairs}
                          theme={theme}
                          preferences={preferences}
                          setPreference={setPreference}
                          pagination={pages.get(pageKey)}
                          setPagination={(value) => setPage(pageKey, value)}
                        />
                      );
                    })}
                </>
              )}
            </section>
          </Tabs.Panel>
        </Tabs>
      </main>
    </PointProvider>
  );
}
function FileReport() {
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
// ?run=KEY reads a hosted run; the hosted build lists runs at its root; any
// other page reads ./data.json (docs/backend-design.md §6).
function LoadedReport() {
  const scheme = useComputedColorScheme('light', {
    getInitialValueInEffect: false,
  });
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = scheme;
  }, [scheme]);
  const run = new URLSearchParams(window.location.search).get('run');
  if (run) return <HostedReport runKey={run} />;
  if (import.meta.env.VITE_HOSTED === '1') return <RunList />;
  return <FileReport />;
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
