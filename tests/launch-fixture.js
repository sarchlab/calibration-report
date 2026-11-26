// A polybench FDTD2D-like report as MGPUSim writes it: every time step
// launches three kernels, each dispatch is a point with its own `launch`,
// and `launch_group` separates each kernel's first iteration from the steady
// state, so one `tmax` has six launch groups.
export const fdtdBenchmark = {
  scaling_param: 'size',
  params: {
    size: {unit: ''},
    tmax: {unit: ''},
    launch: {unit: ''},
    launch_group: {unit: ''},
  },
  values: {
    hw: {name: 'GPU kernel time', unit: 'ns', role: 'hardware_measurement'},
    sim: {name: 'Simulator kernel time', unit: 'ns', role: 'simulator_output'},
  },
};

export const kernels = ['ex', 'ey', 'hz'];

// `unavailable(size, launch)` may return a status for the simulator result.
export function fdtdPoints({
  group = 'gpu',
  benchmark = 'polybench_fdtd2d',
  sizes = [64, 128, 256],
  tmax = 200,
  unavailable = () => null,
} = {}) {
  const data = [];
  for (const size of sizes)
    for (let launch = 0; launch < 3 * tmax; launch++) {
      const kernel = kernels[launch % 3];
      const first = launch < 3;
      const hw = size * 100 + (first ? 5000 : 0) + ((launch * 37) % 101);
      const point = {
        group,
        benchmark,
        x: size,
        non_scaling_params: {
          tmax,
          launch,
          launch_group: 'fdtd_update_' + kernel + (first ? '_first' : ''),
        },
        values: {hw, sim: Math.round(hw * (0.8 + ((launch * 13) % 41) / 100))},
      };
      const status = unavailable(size, launch);
      if (status) {
        point.values = {hw};
        point.statuses = {sim: status};
      }
      data.push(point);
    }
  return data;
}

export function fdtdReport(options = {}, tmaxes = [200]) {
  return {
    report: {
      title: 'FDTD2D launches',
      description: '',
      live: false,
      groups: {gpu: {name: 'GPU'}},
    },
    benchmarks: {polybench_fdtd2d: fdtdBenchmark},
    data: tmaxes.flatMap((tmax) => fdtdPoints({...options, tmax})),
  };
}
