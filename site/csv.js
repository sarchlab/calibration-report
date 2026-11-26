// CSV export of a hosted run, built in the browser from the read API's plot
// pages (docs/backend-design.md §6). Pure apart from `fetchPage`.

const PLOTS_PER_PAGE = 48;
const CONCURRENCY = 4;

// RFC 4180: a field with a comma, quote, CR, or LF is quoted, and quotes are
// doubled. null and undefined are empty; numbers print as JavaScript does.
// A string starting with =, +, -, @, tab, or CR gets a leading ' so that
// spreadsheets do not run it as a formula; numbers are never prefixed.
const protect = (value) =>
  typeof value === 'string' && /^[=+\-@\t\r]/.test(value) ? "'" + value : value;
const quote = (text) =>
  /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;

export function csvField(value) {
  if (value === null || value === undefined) return '';
  return quote(String(protect(value)));
}

const csvLine = (fields) => fields.map(csvField).join(',') + '\r\n';

// The columns of a run's CSV: parameters other than each benchmark's scaling
// parameter, and series keys, each a union over benchmarks in first-appearance
// order (manifest benchmark order, then declaration order). Header names are
// benchmark, group, scaling_param, x, the parameter names, then <series>,
// <series>_state, <series>_reason per series; a name already used by an
// earlier column gets the first free suffix _2, _3, ... Names are compared
// as written, after the formula protection (so `=p` and `'=p` collide).
export function csvColumns(manifest) {
  const params = new Set();
  const series = new Set();
  manifest.benchmark_keys.forEach((benchmark, index) => {
    const meta = manifest.benchmarks[benchmark];
    for (const key of manifest.param_keys[index])
      if (key !== meta.scaling_param) params.add(key);
    for (const key of Object.keys(meta.values)) series.add(key);
  });
  const columns = {params: [...params], series: [...series]};
  const used = new Set();
  const unique = (name) => {
    let candidate = name;
    for (let n = 2; used.has(candidate); n++) candidate = name + '_' + n;
    used.add(candidate);
    return candidate;
  };
  columns.names = [
    'benchmark',
    'group',
    'scaling_param',
    'x',
    ...columns.params,
    ...columns.series.flatMap((key) => [key, key + '_state', key + '_reason']),
  ].map((name) => unique(protect(name)));
  columns.header = columns.names.map(quote).join(',') + '\r\n';
  return columns;
}

// CSV lines of plot-page points (data.json point shape), one per point.
export function csvRows(columns, manifest, points) {
  let text = '';
  for (const point of points) {
    const params = point.non_scaling_params;
    text += csvLine([
      point.benchmark,
      point.group,
      manifest.benchmarks[point.benchmark].scaling_param,
      point.x,
      ...columns.params.map((key) =>
        Object.hasOwn(params, key) ? params[key] : null,
      ),
      ...columns.series.flatMap((key) => {
        const status = point.statuses && Object.hasOwn(point.statuses, key)
          ? point.statuses[key]
          : null;
        return [
          Object.hasOwn(point.values, key) ? point.values[key] : null,
          status?.state,
          status?.reason,
        ];
      }),
    ]);
  }
  return text;
}

// Pages every visible plot of every (group, benchmark) of the manifest, as
// the viewer shows them, and returns the CSV as string chunks in group,
// benchmark, plot, and x order. `fetchPage(query, signal)` returns a plots
// response. The first failed page aborts every other request of the export
// and rejects; no progress is reported after that. Pages are not pinned to
// one revision: a live run exports what each page read, a row already
// exported is not repeated when a window shifts, and `revisions` is the [lowest, highest]
// revision of the manifest and the pages read.
export async function runCsv(manifest, fetchPage, {onProgress, signal} = {}) {
  const columns = csvColumns(manifest);
  const tasks = manifest.group_order.flatMap((group) =>
    (manifest.plots[group] ?? []).map(([index, count]) => ({
      group,
      benchmark: manifest.benchmark_keys[index],
      count,
    })),
  );
  const plots = tasks.reduce((sum, task) => sum + task.count, 0);
  const results = tasks.map(() => []);
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort);
  let done = 0,
    rows = 0,
    low = manifest.revision,
    high = manifest.revision;
  async function exportTask(task, chunks) {
    // The greatest x emitted per plot: rows arrive in x order, so a plot that
    // a shifted window returns again yields only rows beyond it.
    const emitted = new Map();
    let counted = 0;
    for (let offset = 0, total = task.count; offset < total; offset += PLOTS_PER_PAGE) {
      let after = null;
      do {
        const query = new URLSearchParams({
          rid: manifest.id,
          group: task.group,
          benchmark: task.benchmark,
          offset,
          limit: PLOTS_PER_PAGE,
        });
        if (after) query.set('after', after);
        const body = await fetchPage(query.toString(), controller.signal);
        controller.signal.throwIfAborted();
        low = Math.min(low, body.revision);
        high = Math.max(high, body.revision);
        total = body.total;
        const points = body.plots.flatMap((plot) => {
          const last = emitted.get(plot.id) ?? -Infinity;
          const fresh = plot.rows.filter((row) => row.x > last);
          emitted.set(plot.id, fresh.length ? fresh.at(-1).x : last);
          return fresh;
        });
        chunks.push(csvRows(columns, manifest, points));
        rows += points.length;
        after = body.next;
      } while (after);
      done += emitted.size - counted;
      counted = emitted.size;
      onProgress?.({plots: Math.min(done, plots), of: plots});
    }
  }
  let next = 0;
  try {
    await Promise.all(
      Array.from({length: Math.min(CONCURRENCY, tasks.length)}, async () => {
        try {
          while (next < tasks.length) {
            controller.signal.throwIfAborted();
            const index = next++;
            await exportTask(tasks[index], results[index]);
          }
        } catch (error) {
          abort(); // stops the sibling workers
          throw error;
        }
      }),
    );
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  return {
    chunks: [columns.header, ...results.flat()],
    rows,
    revisions: [low, high],
  };
}
