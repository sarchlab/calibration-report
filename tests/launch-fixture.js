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

// Rodinia NW-like and SRAD-like reports as MGPUSim writes them: `launch` is
// the global 1-based launch ordinal and the kernel name, like "#3 nw_kernel2".
// NW launches 2·N/16 − 1 diagonals (kernel1 for the first N/16, kernel2 for
// the rest), so its launch count grows with `n`; Gaussian interleaves Fan1
// and Fan2; SRAD launches the same two kernels at every size.
const launchValues = {
  hw: {name: 'GPU kernel time', unit: 'ns', role: 'hardware_measurement'},
  sim: {name: 'Simulator kernel time', unit: 'ns', role: 'simulator_output'},
};
export const nwBenchmark = {
  scaling_param: 'n',
  params: {n: {unit: ''}, penalty: {unit: ''}, launch: {unit: ''}},
  values: launchValues,
};
export const sradBenchmark = {
  scaling_param: 'size',
  params: {size: {unit: ''}, launch: {unit: ''}},
  values: launchValues,
};

const launchPoint = (group, benchmark, x, params, k) => {
  const hw = x * 10 + k;
  return {
    group,
    benchmark,
    x,
    non_scaling_params: params,
    values: {hw, sim: Math.round(hw * (0.9 + (k % 5) / 20))},
  };
};

export function nwPoints({
  group = 'gpu',
  benchmark = 'rodinia_nw',
  sizes = [32, 48, 64],
  penalties = [1, 10],
  label = (k, kernel) => '#' + k + ' ' + kernel,
} = {}) {
  const data = [];
  for (const penalty of penalties)
    for (const n of sizes)
      for (let k = 1; k < (2 * n) / 16; k++) {
        const kernel = k <= n / 16 ? 'nw_kernel1' : 'nw_kernel2';
        data.push(launchPoint(group, benchmark, n, {penalty, launch: label(k, kernel)}, k));
      }
  return data;
}

export function gaussianPoints({group = 'gpu', benchmark = 'rodinia_gaussian', sizes = [3, 4]} = {}) {
  const data = [];
  for (const n of sizes)
    for (let k = 1; k <= 2 * (n - 1); k++)
      data.push(
        launchPoint(group, benchmark, n, {launch: '#' + k + (k % 2 ? ' Fan1' : ' Fan2')}, k),
      );
  return data;
}

export function sradPoints({group = 'gpu', benchmark = 'rodinia_srad', sizes = [64, 128, 256]} = {}) {
  return sizes.flatMap((size) =>
    ['#1 srad_cuda_1', '#2 srad_cuda_2'].map((launch, i) =>
      launchPoint(group, benchmark, size, {launch}, i + 1),
    ),
  );
}

export function launchOrdinalReport(data = [...nwPoints(), ...sradPoints()]) {
  return {
    report: {title: 'Launch ordinals', description: '', live: false, groups: {gpu: {name: 'GPU'}}},
    benchmarks: {
      rodinia_nw: nwBenchmark,
      rodinia_gaussian: {...sradBenchmark, scaling_param: 'size'},
      rodinia_srad: sradBenchmark,
    },
    data,
  };
}
