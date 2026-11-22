# SarchLab Calibration Report

Shared result format and reporting for SarchLab simulators. Poros and MGPUSim are the first integration targets.

## Initial scope

- Define a versioned format for benchmark configurations, hardware and simulator revisions, timing scopes and units, repetitions, measurements, and run status.
- Validate that hardware and simulator measurements have matching parameters and comparable timing boundaries before pairing them.
- Generate Poros-style scaling curves and error summaries from saved results, and update progress and charts during active runs.

Individual simulator repositories own benchmark collection, simulation orchestration, and adapters that export the shared format. This repository owns the format and reporting. Implementation is pending.
