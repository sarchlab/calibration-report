// API data source (docs/backend-design.md §6): the run list and one run read
// from /api/v1 page by page, with server-computed summaries.
import {Anchor, Badge, Button, Paper, Tabs} from '@mantine/core';
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ReportHeader, RunProgress, useChartTheme} from './Layout.jsx';
import {Benchmark, Summary} from './Charts.jsx';
import {PointProvider} from './PointDetails.jsx';
import {API_VERSION} from './model.js';
import {PageControls, pageWindow} from './Pagination.jsx';

const POLL_MS = 10_000;
const STALE_MS = 30 * 60_000;
const benchmarkPageSizes = [5, 10, 20, 50];

class ReplacedRun extends Error {}

async function fetchJson(path, signal) {
  const response = await fetch(`api/${API_VERSION}/runs${path}`, {
    cache: 'no-cache',
    signal,
  });
  if (response.status === 409) throw new ReplacedRun();
  if (!response.ok) throw new Error((await response.json()).error);
  return response.json();
}

const runPath = (key) => '/' + encodeURIComponent(key);
const isStale = (manifest) =>
  Date.now() - Date.parse(manifest.updated_at) > STALE_MS;

export function RunList() {
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    fetchJson('', controller.signal).then(setRuns, (e) => {
      if (e.name !== 'AbortError') setError(e.message);
    });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    document.title = 'Calibration reports';
  }, []);
  return (
    <main>
      <header className="report-header">
        <h1>Calibration reports</h1>
      </header>
      {error && <p role="alert">{error}</p>}
      {!runs && !error && <p role="status">Loading runs</p>}
      {runs?.length === 0 && <p>No runs yet.</p>}
      <ul className="run-list">
        {runs?.map((run) => (
          <li key={run.key}>
            <Paper withBorder radius="md" p="md" className="run-item">
              <Anchor href={'?run=' + encodeURIComponent(run.key)}>
                {run.title}
              </Anchor>
              <Badge
                variant="light"
                color={
                  run.state === 'running'
                    ? 'teal'
                    : run.state === 'failed'
                      ? 'red'
                      : 'gray'
                }
              >
                {run.state}
              </Badge>
              <span className="muted">
                {run.key} · updated {new Date(run.updated_at).toLocaleString()}
              </span>
            </Paper>
          </li>
        ))}
      </ul>
    </main>
  );
}

// Polls the manifest while the run is live, not stale, and the tab visible.
function useManifest(runKey) {
  const [manifest, setManifest] = useState(null);
  const [error, setError] = useState(null);
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration((g) => g + 1), []);
  useEffect(() => {
    let timer;
    const controller = new AbortController();
    async function poll() {
      try {
        const next = await fetchJson(runPath(runKey), controller.signal);
        setManifest(next);
        setError(null);
        if (
          next.state === 'running' &&
          !isStale(next) &&
          document.visibilityState === 'visible'
        )
          timer = setTimeout(poll, POLL_MS);
      } catch (e) {
        if (e.name !== 'AbortError') setError(e.message);
      }
    }
    poll();
    const resume = () => {
      if (document.visibilityState === 'visible') {
        clearTimeout(timer);
        poll();
      }
    };
    document.addEventListener('visibilitychange', resume);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [runKey, generation]);
  return {manifest, error, refresh};
}

// The summary of the active scope. After every manifest poll it is
// re-requested if the manifest shows newer data and the server's interval has
// passed; on completion it is re-requested once for the final summary.
function useSummary(runKey, manifest, scope, onReplaced) {
  const [summary, setSummary] = useState(null);
  const loading = useRef(null);
  const rid = manifest?.id;
  const load = useCallback(() => {
    loading.current?.abort();
    const controller = new AbortController();
    loading.current = controller;
    fetchJson(
      `${runPath(runKey)}/summary?rid=${rid}&scope=${encodeURIComponent(scope)}`,
      controller.signal,
    ).then(
      (body) => {
        loading.current = null;
        setSummary({...body, requested: scope});
      },
      (e) => {
        if (e instanceof ReplacedRun) onReplaced();
      },
    );
  }, [runKey, rid, scope, onReplaced]);
  useEffect(() => {
    if (rid === undefined) return;
    load();
    return () => loading.current?.abort();
  }, [rid, load]);
  const current = summary?.requested === scope && summary.rid === rid ? summary : null;
  useEffect(() => {
    if (!current || loading.current || manifest.revision <= current.revision)
      return;
    const final = manifest.state === 'completed' && current.state !== 'completed';
    const eligible =
      Date.now() >= Date.parse(current.computed_at) + current.min_interval * 1000;
    if (final || eligible) load();
  }, [manifest, current, load]);
  return current;
}

// One page of series of a benchmark, following continuation cursors.
function usePlotPage(runKey, manifest, group, benchmark, window, onReplaced) {
  const [page, setPage] = useState(null);
  const query = new URLSearchParams({
    rid: manifest.id,
    group,
    benchmark,
    offset: window.start,
    limit: window.end - window.start,
  }).toString();
  const revision = manifest.state === 'running' ? manifest.revision : 'final';
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      const plots = new Map();
      let after = null;
      do {
        const body = await fetchJson(
          `${runPath(runKey)}/plots?${query}${after ? '&after=' + encodeURIComponent(after) : ''}`,
          controller.signal,
        );
        for (const plot of body.plots) {
          if (!plots.has(plot.id))
            plots.set(plot.id, {parameters: String(plot.id), rows: []});
          plots.get(plot.id).rows.push(...plot.rows);
        }
        after = body.next;
      } while (after);
      setPage({query, series: [...plots.values()]});
    })().catch((e) => {
      if (e instanceof ReplacedRun) onReplaced();
    });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey, query, revision]);
  return page?.query === query ? page.series : null;
}

function HostedBenchmark({runKey, manifest, group, benchmark, count, wide, onReplaced, ...props}) {
  const window = pageWindow(count, props.pagination, 6);
  const series = usePlotPage(runKey, manifest, group, benchmark, window, onReplaced);
  if (!series)
    return (
      <Paper component="article" className="chart card" withBorder radius="md" p="md">
        <p role="status">Loading {benchmark}</p>
      </Paper>
    );
  return (
    <Benchmark
      id={benchmark}
      series={series}
      count={count}
      meta={manifest.benchmarks[benchmark]}
      wide={wide ?? {count: 0, stats: []}}
      {...props}
    />
  );
}

export function HostedReport({runKey}) {
  const {manifest, error, refresh} = useManifest(runKey);
  const {scheme, theme} = useChartTheme();
  const [chosen, setChosen] = useState(null);
  const [pages, setPages] = useState(() => new Map());
  const [preferences, setPreferences] = useState(() => new Map());
  const setPreference = useCallback(
    (key, value) =>
      setPreferences((previous) => new Map(previous).set(key, value)),
    [],
  );
  const setPage = useCallback(
    (key, value) => setPages((previous) => new Map(previous).set(key, value)),
    [],
  );
  const groupKeys = manifest ? Object.keys(manifest.report.groups) : [];
  // A one-group run's Overview is that group's summary (§5).
  const scopeOf = (group) =>
    group === null && groupKeys.length !== 1
      ? 'overview'
      : 'group:' + manifest.group_ids[group ?? groupKeys[0]];
  const group = manifest && (chosen === null || manifest.group_order.includes(chosen)) ? chosen : null;
  const summary = useSummary(runKey, manifest, manifest ? scopeOf(group) : null, refresh);
  const benchmarkStats = useMemo(
    () =>
      new Map(
        (summary?.benchmark_stats ?? []).map(([b, count, stats]) => [
          summary.benchmarks[b],
          {count, stats},
        ]),
      ),
    [summary],
  );
  useEffect(() => {
    if (manifest) document.title = manifest.report.title;
  }, [manifest]);
  if (!manifest)
    return (
      <main>
        <h1>Calibration report</h1>
        <p role={error ? 'alert' : 'status'}>
          {error ?? 'Waiting for report data'}
        </p>
      </main>
    );
  const {report, progress} = manifest;
  const stale = manifest.state === 'running' && isStale(manifest);
  const views = [
    {id: null, name: 'Overview'},
    ...manifest.group_order.map((id) => ({id, name: report.groups[id].name})),
  ];
  const entries = (group === null ? [] : manifest.plots[group] ?? []).map(
    ([b, count]) => ({key: manifest.benchmark_keys[b], count}),
  );
  const benchmarkPageKey = JSON.stringify([group]);
  const benchmarkWindow = pageWindow(entries.length, pages.get(benchmarkPageKey), 10);
  const behind = summary && summary.revision < manifest.revision;
  return (
    <PointProvider
      key={manifest.id}
      benchmarks={manifest.benchmarks}
      groups={report.groups}
      overview={group === null}
      resetKey={JSON.stringify([summary?.revision, group, scheme])}
    >
      <main>
        <ReportHeader
          report={report}
          status={
            stale
              ? 'No updates for 30 minutes'
              : 'Updated ' + new Date(manifest.updated_at).toLocaleTimeString()
          }
        >
          {stale && (
            <Button size="compact-xs" variant="default" onClick={refresh}>
              Refresh
            </Button>
          )}
          {manifest.state === 'failed' && (
            <Badge color="red" variant="light">
              Failed
            </Badge>
          )}
        </ReportHeader>
        <RunProgress progress={progress} live={report.live === true} />
        <Tabs
          value={JSON.stringify(group)}
          onChange={(value) => setChosen(JSON.parse(value))}
          className="report-tabs"
        >
          {views.length > 1 && (
            <Tabs.List aria-label="Report views">
              {views.map((view) => (
                <Tabs.Tab key={JSON.stringify(view.id)} value={JSON.stringify(view.id)}>
                  {view.name}
                </Tabs.Tab>
              ))}
            </Tabs.List>
          )}
          <Tabs.Panel value={JSON.stringify(group)}>
            {behind && (
              <p className="summary-note">
                Summary as of {new Date(summary.computed_at).toLocaleTimeString()}
              </p>
            )}
            {summary && (
              <Summary
                summary={summary}
                scope={group}
                groups={report.groups}
                theme={theme}
                preferences={preferences}
                setPreference={setPreference}
              />
            )}
            {summary?.count === 0 && group === null && (
              <p className="muted">No paired measurements yet.</p>
            )}
            <section className="charts" id="charts" aria-label="Benchmark plots">
              {group !== null && entries.length > 0 && (
                <>
                  <PageControls
                    label="Benchmark"
                    noun="benchmarks"
                    count={entries.length}
                    window={benchmarkWindow}
                    sizes={benchmarkPageSizes}
                    onChange={(value) => setPage(benchmarkPageKey, value)}
                  />
                  {entries
                    .slice(benchmarkWindow.start, benchmarkWindow.end)
                    .map(({key, count}) => {
                      const pageKey = JSON.stringify([group, key]);
                      return (
                        <HostedBenchmark
                          key={pageKey}
                          runKey={runKey}
                          manifest={manifest}
                          group={group}
                          benchmark={key}
                          count={count}
                          wide={benchmarkStats.get(key)}
                          onReplaced={refresh}
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
