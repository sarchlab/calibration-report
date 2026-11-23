# SarchLab Calibration Report

Shared result format and reporting for SarchLab simulators. Poros and MGPUSim are the first integration targets.

## Data format

A report publishes one `data.json` at its GitHub Pages site root. See the [JSON Schema](data.schema.json) and the [minimal example](examples/data.json).

- The optional top-level `report` object provides the global `title` and `description` for every view.
- `groups` defines tabs by ID and display name. An Overview tab appears when there are paired measurements and shows the combined accuracy summary.
- `benchmarks` defines each benchmark's scaling parameter, parameter units, and available value series. Each series has a display name and unit. Its optional `role` is `hardware_measurement` or `simulator_output`.
- `points` stores one entry per benchmark configuration. Its `group` selects the tab, and `x` is the scaling parameter's numeric value. Its `non_scaling_params` object contains the other parameter values.
- Each point's `values` is an object keyed by the benchmark's series IDs. A number is a measured value in that series' unit. Use `null` for a series with a planned but unavailable result. Omit a series that does not apply to that point. Use an empty string for a dimensionless unit.

JSON Schema validates the structure. Producers and consumers also check cross-references:

- Each point names a declared group and benchmark.
- The benchmark's `scaling_param` is declared in `params`.
- Each point's `non_scaling_params` contains exactly the declared parameter names other than the scaling parameter.
- Every key in a point's `values` is declared in its benchmark's `values`.
- Each combination of group, benchmark, `x`, and non-scaling parameter values appears at most once.

Within a tab, the renderer makes one plot for each benchmark and non-scaling parameter combination. Each value key is a curve over `x`.

## Accuracy summary

The Overview aggregates the qualified comparisons from all groups. Each group shows only its own comparisons. Both views include a ranked signed-error plot, a cumulative distribution of absolute relative error, and a measured-versus-simulated scatter plot. A comparison requires two positive measurements at the same point and one declared hardware series with the same unit as the simulator series. Ambiguous hardware references are omitted. The S-curve uses signed error, `(simulated - measured) / min(simulated, measured)`. The CDF takes the absolute value of the same error.

The scatter plot can switch both axes to logarithmic scale. It reports Kendall’s tau-b, pairwise ordering accuracy among pairs with distinct measured values, and Spearman’s rho using average ranks for ties.

Plots default to a log axis when the values are positive, span at least one decade, and a log transform meaningfully spreads out the middle half of the distinct values. Otherwise the axis is linear. Manual scale selections are kept during live refreshes. The scatter plot applies the same scale to both axes.

## Hosting

- **GitHub Pages:** Copy the contents of [`site/`](site/) and an exported `data.json` into the Pages publishing branch. The viewer loads its data using a relative URL.
- **Live hosting:** Run `python3 serve.py --data-dir /path/to/export --port 8000`. The exporter can refresh that directory from a separate simulator checkout while the server serves the shared viewer.

The viewer reads only `data.json`. It displays numeric measurements and omits points and series that have no measurements.

## Repository scope

Simulator repositories own benchmark collection, simulation orchestration, and adapters that export this format. This repository owns the format, viewer, and live HTTP server.
