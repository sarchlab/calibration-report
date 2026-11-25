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
  if (!response.ok) {
    let message = null;
    try {
      message = (await response.json()).error;
    } catch {
      // Not a JSON error body (a proxy or platform error page).
    }
    throw new Error(message ?? 'HTTP ' + response.status);
  }
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

const isLive = (manifest) =>
  manifest?.state === 'running' &&
  !isStale(manifest) &&
  document.visibilityState === 'visible';

// The next manifest to show: never an older revision of the same run, and
// the previous objects when the data is unchanged, so charts do not redraw.
function mergeManifest(previous, next) {
  if (!previous || previous.id !== next.id) return next;
  if (next.revision < previous.revision) return previous;
  if (next.revision > previous.revision) return next;
  return previous.updated_at === next.updated_at
    ? previous
    : {...previous, updated_at: next.updated_at};
}

// One poll chain: at most one manifest request in flight and one timer. It
// polls while the run is live, not stale, and the tab visible, and keeps
// polling after a failed request while the last known manifest is live.
// `polls` counts successful polls, changed or not; `stale` is published when
// polling stops because the run went quiet.
function useManifest(runKey) {
  const [manifest, setManifest] = useState(null);
  const [error, setError] = useState(null);
  const [polls, setPolls] = useState(0);
  const [stale, setStale] = useState(false);
  const [generation, setGeneration] = useState(0);
  const last = useRef(null);
  const refresh = useCallback(() => setGeneration((g) => g + 1), []);
  useEffect(() => {
    let timer = null;
    let inFlight = null;
    const publishStale = () =>
      setStale(last.current?.state === 'running' && isStale(last.current));
    const schedule = () => {
      clearTimeout(timer);
      timer = isLive(last.current) ? setTimeout(tick, POLL_MS) : null;
      publishStale();
    };
    // A scheduled request rechecks visibility and staleness first.
    function tick() {
      timer = null;
      if (isLive(last.current)) poll();
      else publishStale();
    }
    async function poll() {
      if (inFlight) return;
      const controller = new AbortController();
      inFlight = controller;
      try {
        const next = mergeManifest(
          last.current,
          await fetchJson(runPath(runKey), controller.signal),
        );
        if (inFlight !== controller) return;
        last.current = next;
        setManifest(next);
        setError(null);
        setPolls((n) => n + 1);
      } catch (e) {
        if (inFlight !== controller) return;
        setError(e.message);
      } finally {
        if (inFlight === controller) inFlight = null;
      }
      if (!controller.signal.aborted) schedule();
    }
    poll();
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') {
        clearTimeout(timer);
        timer = null;
      } else if (!inFlight && !timer && last.current?.state === 'running') poll();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      inFlight?.abort();
      inFlight = null;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [runKey, generation]);
  return {manifest, error, polls, stale, refresh};
}

// One request at a time: a new or cancelled request supersedes the previous
// one, whose completion is ignored. Request state is cleared on success and
// on failure.
function useRequest() {
  const current = useRef(null);
  const [error, setError] = useState(null);
  const start = useCallback((run, onDone) => {
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    setError(null);
    run(controller.signal).then(
      (value) => {
        if (current.current !== controller) return;
        current.current = null;
        onDone(value);
      },
      (e) => {
        if (current.current !== controller) return;
        current.current = null;
        setError(e);
      },
    );
  }, []);
  const cancel = useCallback(() => {
    current.current?.abort();
    current.current = null;
  }, []);
  const pending = useCallback(() => current.current !== null, []);
  return {start, cancel, error, pending};
}

// The summary of the active scope. Once per successful manifest poll it is
// re-requested if the manifest shows newer data and the server's interval has
// passed. The first completed manifest supersedes any live request with a
// request for the final summary, and a live summary that settles after
// completion is followed by one request for the final summary.
function useSummary(runKey, manifest, polls, scope, onReplaced) {
  const [summary, setSummary] = useState(null);
  const request = useRequest();
  const {start, cancel, pending} = request;
  const rid = manifest?.id;
  const scopeKey = rid + '|' + scope;
  // Scopes whose final summary was requested, by trigger; a request made
  // while the manifest is completed is already the final one.
  const finals = useRef({completion: new Set(), settled: new Set()});
  // Read through refs so that only a poll re-evaluates.
  const latest = useRef(null);
  const load = useCallback(() => {
    if (latest.current?.manifest?.state === 'completed')
      finals.current.completion.add(rid + '|' + scope);
    start(
      (signal) =>
        fetchJson(
          `${runPath(runKey)}/summary?rid=${rid}&scope=${encodeURIComponent(scope)}`,
          signal,
        ),
      (body) => setSummary({...body, requested: scope}),
    );
  }, [runKey, rid, scope, start]);
  useEffect(() => {
    if (rid === undefined) return;
    load();
    return cancel;
  }, [rid, load, cancel]);
  useEffect(() => {
    if (request.error instanceof ReplacedRun) onReplaced();
  }, [request.error, onReplaced]);
  const current = summary?.requested === scope && summary.rid === rid ? summary : null;
  latest.current = {current, load, manifest, scopeKey};
  useEffect(() => {
    const {current, load, manifest, scopeKey} = latest.current;
    if (!manifest || polls === 0) return;
    if (manifest.state === 'completed') {
      if (current?.state !== 'completed' && !finals.current.completion.has(scopeKey))
        load(); // supersedes an in-flight live request
      return;
    }
    if (!current || pending() || manifest.revision <= current.revision) return;
    const eligible =
      Date.now() >= Date.parse(current.computed_at) + current.min_interval * 1000;
    if (eligible) load();
  }, [polls, pending]);
  useEffect(() => {
    const {manifest, load, scopeKey} = latest.current;
    if (
      current &&
      current.state !== 'completed' &&
      manifest?.state === 'completed' &&
      !pending() &&
      !finals.current.settled.has(scopeKey)
    ) {
      finals.current.settled.add(scopeKey);
      load();
    }
  }, [current, pending]);
  return {summary: current, error: request.error, retry: load};
}

// One page of series of a benchmark, following continuation cursors. After a
// failed refresh the previous page of the same query stays, marked stale.
function usePlotPage(runKey, manifest, group, benchmark, window, onReplaced) {
  const [page, setPage] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const request = useRequest();
  const {start, cancel} = request;
  const query = new URLSearchParams({
    rid: manifest.id,
    group,
    benchmark,
    offset: window.start,
    limit: window.end - window.start,
  }).toString();
  const revision = manifest.state === 'running' ? manifest.revision : 'final';
  useEffect(() => {
    start(
      async (signal) => {
        const plots = new Map();
        let after = null;
        do {
          const body = await fetchJson(
            `${runPath(runKey)}/plots?${query}${after ? '&after=' + encodeURIComponent(after) : ''}`,
            signal,
          );
          for (const plot of body.plots) {
            if (!plots.has(plot.id))
              plots.set(plot.id, {parameters: String(plot.id), rows: []});
            plots.get(plot.id).rows.push(...plot.rows);
          }
          after = body.next;
        } while (after);
        return [...plots.values()];
      },
      (series) => setPage({query, series}),
    );
    return cancel;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey, query, revision, attempt]);
  useEffect(() => {
    if (request.error instanceof ReplacedRun) onReplaced();
  }, [request.error, onReplaced]);
  return {
    series: page?.query === query ? page.series : null,
    error: request.error,
    retry: () => setAttempt((n) => n + 1),
  };
}

function RequestError({what, error, retry, stale = false}) {
  return (
    <p role="alert" className="request-error">
      {stale ? 'Could not refresh ' : 'Could not load '}
      {what}: {error.message}
      {stale && '. Showing older data.'}{' '}
      <Button size="compact-xs" variant="default" onClick={retry}>
        Retry
      </Button>
    </p>
  );
}

function HostedBenchmark({runKey, manifest, group, benchmark, count, wide, onReplaced, ...props}) {
  const window = pageWindow(count, props.pagination, 6);
  const {series, error, retry} = usePlotPage(
    runKey,
    manifest,
    group,
    benchmark,
    window,
    onReplaced,
  );
  const failed = error && !(error instanceof ReplacedRun);
  if (!series)
    return (
      <Paper component="article" className="chart card" withBorder radius="md" p="md">
        {failed ? (
          <RequestError what={benchmark} error={error} retry={retry} />
        ) : (
          <p role="status">Loading {benchmark}</p>
        )}
      </Paper>
    );
  return (
    <div className="hosted-benchmark" data-stale={failed ? 'true' : undefined}>
      {failed && <RequestError what={benchmark} error={error} retry={retry} stale />}
      <Benchmark
        id={benchmark}
        series={series}
        count={count}
        meta={manifest.benchmarks[benchmark]}
        paged
        wide={wide}
        parameterOrder={manifest.param_keys[manifest.benchmark_keys.indexOf(benchmark)]}
        {...props}
      />
    </div>
  );
}

export function HostedReport({runKey}) {
  const {manifest, error, polls, stale, refresh} = useManifest(runKey);
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
  const {
    summary,
    error: summaryError,
    retry: retrySummary,
  } = useSummary(runKey, manifest, polls, manifest ? scopeOf(group) : null, refresh);
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
          {error ?? 'Waiting for report data'}{' '}
          {error && (
            <Button size="compact-xs" variant="default" onClick={refresh}>
              Retry
            </Button>
          )}
        </p>
      </main>
    );
  const {report, progress} = manifest;
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
            error
              ? 'Update failed: ' + error
              : stale
                ? 'No updates for 30 minutes'
                : 'Updated ' + new Date(manifest.updated_at).toLocaleTimeString()
          }
        >
          {(stale || error) && (
            <Button size="compact-xs" variant="default" onClick={refresh}>
              {error ? 'Retry' : 'Refresh'}
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
            {summaryError && !(summaryError instanceof ReplacedRun) && (
              <RequestError
                what="the summary"
                error={summaryError}
                retry={retrySummary}
              />
            )}
            {!summary && !summaryError && (
              <p role="status" className="summary-note">
                Loading summary
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
