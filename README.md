# SarchLab Calibration Report

Shared result format and reporting for SarchLab simulators. Poros and MGPUSim are the first integration targets.

## Data format

A report publishes one `data.json` at its GitHub Pages site root. See the [JSON Schema](data.schema.json) and the [minimal example](examples/data.json).

- `report` provides the global `title` and `description` for every view, a boolean `live` flag, and the `groups` map of tab IDs to display names. An Overview tab appears when there are paired measurements.
- `progress` contains counts for the entire report. `total`, `completed`, and `running` are required. `queued` and `unsuccessful` can be supplied when available. `started_at` and `updated_at` are ISO 8601 timestamps and can be omitted or set to `null` when unknown.
- `benchmarks` defines each benchmark's scaling parameter, parameter units, and available value series. Each series has a display name and unit. Its optional `role` is `hardware_measurement` or `simulator_output`.
- `data` stores one entry per benchmark configuration. Its `group` selects the tab, and `x` is the scaling parameter's numeric value. Its `non_scaling_params` object contains the other parameter values.
- Each point's `values` is an object keyed by the benchmark's series IDs. A number is a measured value in that series' unit. Use `null` for a series with a planned but unavailable result. Omit a series that does not apply to that point. Use an empty string for a dimensionless unit.
- A point may also provide `statuses`, keyed by the same series IDs. For example, `"statuses": {"mgpusim": {"state": "verification_failed", "symbol": "⚠️", "reason": "CPU verification mismatch"}}` explains a null simulator result. Available states are `queued`, `running`, `failed`, `verification_failed`, `timeout`, `memory_limit`, and `unsupported`. The plot overlays a clickable marker for every state except `queued`. The optional `symbol` sets the marker text or emoji. A default marker is used otherwise. If several series have a status at the same X, the chart shows one marker and lists each series when opened. Statuses do not contribute to error statistics.

JSON Schema validates the structure. Producers and consumers also check cross-references:

- Each point names a declared group and benchmark.
- The benchmark's `scaling_param` is declared in `params`.
- Each point's `non_scaling_params` contains exactly the declared parameter names other than the scaling parameter.
- Every series key in a point's `values` or `statuses` is declared in its benchmark's `values`. Status entries describe unavailable results.
- Each combination of group, benchmark, `x`, and non-scaling parameter values appears at most once.

Within a tab, the renderer makes one plot for each benchmark and non-scaling parameter combination. Each value key is a curve over `x`. Each benchmark occupies a full-width card. Its series cards wrap into three, two, or one columns as the available content width narrows, with equal widths and heights within that benchmark. Different benchmarks can have different series-card heights. Series cards use the available width beside the sidebar, including when a narrow landscape view opens point details.

## Pagination and large reports

Device views show 10 benchmarks per page and 6 parameter series per benchmark by default. Each level has page buttons, a direct page-number field (Enter or blur to apply), and a page-size selector. Benchmark page sizes are 5, 10, 20 or 50; series page sizes are 6, 12, 24 or 48. Changing the page size keeps the first visible item on the resulting page. All benchmark and series pages remain accessible.

Page numbers and sizes are remembered independently for each device and each benchmark while the report is open. Live updates retain valid page numbers and clamp pages that no longer exist to the last available page, including for inactive devices. Later growth does not restore an obsolete page number. Only the visible benchmark and series pages mount plots. Leaving a selected plot's page closes its details.

Pagination never changes the summary population: device and Overview summaries use all eligible comparisons, and benchmark-wide error uses every eligible comparison in that benchmark. The renderer builds a device/benchmark/series index once per data revision, computes exact Kendall statistics in O(n log n) time with tie-aware Fenwick counts, and avoids passing large arrays as function arguments. Input remains one schema-compatible `data.json`; no producer-side summary or pagination files are needed.

## Accuracy summary

The Overview aggregates the qualified comparisons from all groups. Each group shows only its own comparisons. Both views include a ranked signed-error plot, a cumulative distribution of absolute relative error, and a measured-versus-simulated scatter plot. A comparison requires two positive measurements at the same point and one declared hardware series with the same unit as the simulator series. Ambiguous hardware references are omitted. The S-curve uses signed error, `(simulated - measured) / min(simulated, measured)`. The CDF takes the absolute value of the same error.

The scatter plot can switch both axes to logarithmic scale. It reports Kendall’s tau-b, pairwise ordering accuracy among pairs with distinct measured values, and Spearman’s rho using average ranks for ties.

For a positive axis with at least three distinct values, the default scale minimizes the variance of adjacent gaps after normalizing the axis to the same span. Ties and axes with nonpositive values use a linear scale. Manual scale selections are kept during live refreshes. The scatter plot applies the same scale to both axes.

## Point details

Hover over a point in a benchmark plot, S-curve, CDF, or scatter plot for a compact preview of its measurements and error. Click, tap, or use keyboard navigation for full details. Details separate the benchmark and GPU header, measured and simulated values, error metrics, and configuration. Comparison plots show signed error with its direction; the S-curve includes rank and the CDF includes absolute error and cumulative fraction (labeled CDF percentile). Values use the same units as the axes.

Desktop reserves a permanent 360px right sidebar plus gutters. Device views show their three accuracy-summary charts stacked in that sidebar; Overview keeps its summary charts in the main area and shows the report's existing run statistics in the sidebar. Selecting a point replaces the sidebar content with full details, and dismissing it restores the summaries or statistics without changing the report width.

Narrow screens (820px or less) and touch-first devices keep summaries and run statistics in the page. Selecting a point opens a 300px sidebar in landscape, reserving width until dismissed, or a bottom panel occupying at most half the viewport in portrait. While the portrait panel is open, extra space at the end of the page lets even the last chart scroll above it. Opening a landscape sidebar keeps the selected chart in view after cards rewrap; Close and Escape also reveal its chart after restoring the width. Point navigation does not scroll the page. Panel content scrolls independently while the navigation controls remain visible. Touch targets include a 28 CSS-pixel radius around each point; the nearest point is selected. The compact `<` and `>` buttons move one point; `<<` and `>>` move ten points. Navigation wraps around both ends, including for series with fewer than ten points, and includes overlapping points. The `×` button closes details; all buttons have English accessible labels and hover titles. Selecting another point updates the sole panel without an intermediate resize; hovering other plots does not replace a pinned selection. Tap the selected point again, click or tap outside its plot and panel, or use Close to dismiss.

Keyboard users can Tab to a chart and use arrow keys, Home, or End to inspect points. Tab from a selected chart enters the details panel; Left/Right and Home/End also browse while its content is focused. Tabbing away keeps selected details open. Escape dismisses details and returns focus to the selected chart, as Close does. Switching views, changing scales or themes, or receiving changed live data clears the selection; unchanged live polling preserves it.

## Validation

Run `npm test` for the React interaction and statistics checks plus the Python static-server checks. The statistics tests compare tied and randomized inputs to the quadratic definition and check exact counts at 455,291 pairs. Pagination tests cover both levels, unchanged summary populations, device switching, point-detail cleanup and live-update clamping. The UI tests render real React and Mantine components in jsdom with a mocked canvas drawing context; verify actual hover, mobile tapping, layout, scrolling, and pinch zoom in a browser as well. `npm run build` verifies the production bundle. The npm integration tests also pack the actual package, install it offline without lifecycle scripts or runtime dependencies, and exercise the installed executable and its output protection.

## Generate a report with npm

The npm package includes the prebuilt viewer and a small command-line tool. Generate a static report without cloning this repository or installing frontend build dependencies:

```sh
npx calibration-report@0.3.0 --data ./data.json --out ./report
```

The output contains `index.html`, bundled `assets/`, and a byte-for-byte copy of the supplied `data.json`. Publish this directory on a static host, or preview it over HTTP:

```sh
python3 -m http.server 8000 --directory ./report
```

Open `http://localhost:8000/`. Nested hosting paths work because asset and data URLs are relative. No Node.js runtime is required on the static host.

Both `--data` and `--out` are required. Paths with spaces can be quoted. The destination must be new or an empty directory; the CLI refuses nonempty directories, files and destination symlinks. It checks JSON syntax before creating the output; producers remain responsible for the schema and cross-reference requirements above. The original input is preserved. The generated data is a snapshot: ongoing exporter changes must be copied to the generated `data.json`, or use the source checkout's live server below.

Use `npx calibration-report@0.3.0 --help` for usage and `--version` for the installed version. For repeatable CI, pin the version as shown, or install it as an exact development dependency and invoke the local command with `npx calibration-report`.

## Build and hosting

The viewer uses React and Mantine for UI and state, with the existing Canvas plots and statistical calculations kept in separate modules. Node.js 22.22.2+ on the 22.x line, 24.15.0+ on the 24.x line, or Node.js 26+, and Python 3.9+ for the optional live server are supported.

```sh
npm ci
npm run build
```

`npm run build` generates the standalone static website in `dist/`. It bundles the UI dependencies locally; no Node.js server or CDN is needed to view it. The build does not read or bundle report data. The viewer fetches `./data.json` at runtime. Rebuilding empties `dist/`, including any copied `data.json`: keep the original export outside `dist/` and re-copy it after each build when using static hosting or `npm run preview`.

- **GitHub Pages or any static host:** publish the contents of `dist/` together with your exported `data.json` at the same level as `index.html`. Asset URLs are relative, so a project subpath works as well as a domain root. Build once and reuse the same viewer for different reports.
- **Live hosting with external data:** after building, run `python3 serve.py --data-dir /path/to/export --port 8000`. The server serves `dist/` and reads the external `data.json` on every request, so an exporter can continue updating that file. Add `--bind 0.0.0.0` or a specific interface address when access from another device is needed. Rebuild after UI edits; the server reads the current build on each request.
- **Local production preview:** copy your report to `dist/data.json`, then run `npm run preview`.
- **UI development:** place or symlink your report at `site/data.json`, then run `npm run dev` for hot reload. This local data file is ignored by Git and is not copied into the production build.

The viewer reads only `data.json`. With `report.live: true`, it shows a live indicator and fetches the file every ten seconds without navigating. Static snapshots load once. Plots display numeric measurements and omit points and series that have no measurements.

## Package publishing

`npm pack` runs the production build through `prepack`. The publish allowlist includes only the CLI, built HTML/JavaScript/CSS, JSON Schema, README and package metadata. It excludes exported report data, source maps, source files, tests and development dependencies. Consumers do not run a build during installation. Inspect the tarball and run `npm test` before publishing; version changes should update both `package.json` and `package-lock.json`.

## Repository scope

Simulator repositories own benchmark collection, simulation orchestration, and adapters that export this format. This repository owns the format, viewer, and live HTTP server.
