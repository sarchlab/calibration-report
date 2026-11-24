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

Within a tab, the renderer makes one plot for each benchmark and non-scaling parameter combination. Each value key is a curve over `x`. Each benchmark occupies a full-width card. Its series cards wrap into three, two, or one columns as the viewport narrows, with equal widths and heights within that benchmark. Different benchmarks can have different series-card heights. Point details open in an overlay without changing chart or series-card dimensions.

## Accuracy summary

The Overview aggregates the qualified comparisons from all groups. Each group shows only its own comparisons. Both views include a ranked signed-error plot, a cumulative distribution of absolute relative error, and a measured-versus-simulated scatter plot. A comparison requires two positive measurements at the same point and one declared hardware series with the same unit as the simulator series. Ambiguous hardware references are omitted. The S-curve uses signed error, `(simulated - measured) / min(simulated, measured)`. The CDF takes the absolute value of the same error.

The scatter plot can switch both axes to logarithmic scale. It reports Kendall’s tau-b, pairwise ordering accuracy among pairs with distinct measured values, and Spearman’s rho using average ranks for ties.

For a positive axis with at least three distinct values, the default scale minimizes the variance of adjacent gaps after normalizing the axis to the same span. Ties and axes with nonpositive values use a linear scale. Manual scale selections are kept during live refreshes. The scatter plot applies the same scale to both axes.

## Point details

Hover over a point in a benchmark plot, S-curve, CDF, or scatter plot for a compact preview of its measurements and error. Click, tap, or use keyboard navigation for full details. Details separate the benchmark and GPU header, measured and simulated values, error metrics, and configuration. Comparison plots show signed error with its direction; the S-curve includes rank and the CDF includes absolute error and cumulative fraction (labeled CDF percentile). Values use the same units as the axes.

Selected point details stay in a fixed overlay on the right on desktop. On narrow screens (820px or less) and touch-first devices, the panel sits at the bottom and occupies at most half the viewport. Its content scrolls independently while Previous, Next, and Close remain visible; the page and charts do not resize. Touch targets include a 28 CSS-pixel radius around each point; the nearest point is selected. Previous and Next browse every plotted point, including overlapping points. Selecting another point updates the sole panel; hovering other plots does not replace a pinned selection. Tap the selected point again, tap outside its plot and panel, or use Close to dismiss.

Keyboard users can Tab to a chart and use arrow keys, Home, or End to inspect points. Escape dismisses details and returns focus to the selected chart, as Close does. Switching views, changing scales or themes, or receiving changed live data clears the selection; unchanged live polling preserves it.

## Validation

Run `node --test tests/point-details.test.cjs` for the dependency-free point-detail regression checks. These exercise rendering and interaction handlers with a small DOM fixture; verify actual hover, mobile tapping, layout, scrolling, and pinch zoom in a browser as well.

## Hosting

- **GitHub Pages:** Copy the contents of [`site/`](site/) and an exported `data.json` into the Pages publishing branch. The viewer loads its data using a relative URL.
- **Live hosting:** Run `python3 serve.py --data-dir /path/to/export --port 8000`. The exporter can refresh that directory from a separate simulator checkout while the server serves the shared viewer.

The viewer reads only `data.json`. With `report.live: true`, it shows a live indicator and fetches the file every ten seconds without navigating. Static snapshots load once. Plots display numeric measurements and omit points and series that have no measurements.

## Repository scope

Simulator repositories own benchmark collection, simulation orchestration, and adapters that export this format. This repository owns the format, viewer, and live HTTP server.
