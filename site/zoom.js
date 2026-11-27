// Zoom and pan of a drawn chart's view. A view is {x?: [min, max], y?:
// [min, max]} in data units, as drawChart takes it; `axes` are the axes the
// chart was drawn with (domain, pixel range, transform and inverse), so
// zooming and panning are linear in each axis's transformed space (log10 for
// a log axis). Only the `allowed` axes change.

// Data domain of `axis` after mapping its transformed domain through `step`,
// or null when the result is degenerate or out of range (a zero-width axis,
// such as a chart with a single X, never zooms).
function remap(axis, step) {
  const {domain, transform, inverse} = axis;
  const [low, high] = domain.map(transform).map(step);
  const next = [inverse(low), inverse(high)];
  const scale = Math.max(1, Math.abs(low), Math.abs(high));
  if (!next.every(Number.isFinite) || !(Math.abs(high - low) > 1e-12 * scale))
    return null;
  // A log axis that underflows to zero has left its range.
  if (axis.scale === 'log' && !(next[0] > 0)) return null;
  return next;
}

// The position of pixel `px` in `axis`'s transformed space.
function transformedAt(axis, px) {
  const [start, end] = axis.range;
  const [low, high] = axis.domain.map(axis.transform);
  return low + ((px - start) / (end - start)) * (high - low);
}

// `view` with each allowed axis the gesture moves remapped. `stepOf` gives
// an axis's step, or null when the gesture leaves that axis alone. An axis
// left alone, or one the step cannot change, keeps its current override or
// stays on automatic bounds. With no axis changed, `view` itself (possibly
// null) is returned.
function step(view, axes, allowed, stepOf) {
  let next = view;
  for (const name of allowed) {
    const axis = axes[name];
    const stepped = axis && stepOf(axis, name);
    const domain = stepped && remap(axis, stepped);
    if (domain) next = {...next, [name]: domain};
  }
  return next;
}

// Scales each allowed axis by `factor` (< 1 zooms in) around the drawing
// position `point` ({x, y}).
export function zoomView(view, axes, allowed, point, factor) {
  if (factor === 1) return view;
  return step(view, axes, allowed, (axis, name) => {
    const center = transformedAt(axis, point[name]);
    return (t) => center + (t - center) * factor;
  });
}

// Moves each allowed axis so its content follows a drag by `delta` ({x, y},
// drawing units).
export function panView(view, axes, allowed, delta) {
  return step(view, axes, allowed, (axis, name) => {
    if (!delta[name]) return null;
    const shift =
      transformedAt(axis, axis.range[0]) - transformedAt(axis, axis.range[0] + delta[name]);
    return (t) => t + shift;
  });
}

// Wheel delta in pixels to a zoom factor: one notch (100px) is about 1.2×.
export function wheelFactor({deltaY, deltaMode}) {
  const pixels = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1);
  return Math.exp(Math.max(-1, Math.min(1, pixels * 0.0018)));
}
