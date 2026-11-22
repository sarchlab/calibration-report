# SarchLab Calibration Report

Shared result format and reporting for SarchLab simulators. Poros and MGPUSim are the first integration targets.

## Data format

A report publishes one `data.json` at its GitHub Pages site root. See the [JSON Schema](data.schema.json) and the [minimal example](examples/data.json).

- `benchmarks` defines each benchmark's scaling parameter, parameter units, and available value series. Each series has a display name and unit.
- `points` stores one entry per benchmark configuration. Its `x` is the scaling parameter's numeric value. Its `non_scaling_params` object contains the other parameter values.
- Each point's `values` is an object keyed by the benchmark's series IDs. A number is a measured value in that series' unit. Use `null` for a series with a planned but unavailable result. Omit a series that does not apply to that point. Use an empty string for a dimensionless unit.

JSON Schema validates the structure. Producers and consumers also check cross-references:

- Each point names a declared benchmark.
- The benchmark's `scaling_param` is declared in `params`.
- Each point's `non_scaling_params` contains exactly the declared parameter names other than the scaling parameter.
- Every key in a point's `values` is declared in its benchmark's `values`.
- Each combination of benchmark, `x`, and non-scaling parameter values appears at most once.

The renderer groups points by benchmark and non-scaling parameters. Within each group, each value key is a curve over `x`.

## Repository scope

Simulator repositories own benchmark collection, simulation orchestration, and adapters that export this format. This repository owns the format and reporting. The report generator is pending.
