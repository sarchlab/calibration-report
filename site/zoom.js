// Zoom and pan of a drawn chart's view. A view is {x?: [min, max], y?:
// [min, max]} in data units, as drawChart takes it; `axes` are the axes the
// chart was drawn with (domain, pixel range, transform and inverse), so
// zooming and panning are linear in each axis's transformed space (log10 for
// a log axis). Only the `allowed` axes change.

// Data domain of `axis` after mapping its transformed domain through `step`,
// or the current domain when the result is degenerate or out of range.
function remap(axis, step) {
  const {domain, transform, inverse} = axis;
  const [low, high] = domain.map(transform).map(step);
  const next = [inverse(low), inverse(high)];
  const scale = Math.max(1, Math.abs(low), Math.abs(high));
  if (!next.every(Number.isFinite) || !(Math.abs(high - low) > 1e-12 * scale))
    return domain;
  // A log axis that underflows to zero has left its range.
  if (axis.scale === 'log' && !(next[0] > 0)) return domain;
  return next;
}

// The position of pixel `px` in `axis`'s transformed space.
function transformedAt(axis, px) {
  const [start, end] = axis.range;
  const [low, high] = axis.domain.map(axis.transform);
  return low + ((px - start) / (end - start)) * (high - low);
}

// Scales each allowed axis by `factor` (< 1 zooms in) around the drawing
// position `point` ({x, y}).
export function zoomView(view, axes, allowed, point, factor) {
  const next = {...view};
  for (const name of allowed) {
    const axis = axes[name];
    if (!axis) continue;
    const center = transformedAt(axis, point[name]);
    next[name] = remap(axis, (t) => center + (t - center) * factor);
  }
  return next;
}

// Moves each allowed axis so its content follows a drag by `delta` ({x, y},
// drawing units).
export function panView(view, axes, allowed, delta) {
  const next = {...view};
  for (const name of allowed) {
    const axis = axes[name];
    if (!axis) continue;
    const shift = transformedAt(axis, axis.range[0]) - transformedAt(axis, axis.range[0] + delta[name]);
    next[name] = remap(axis, (t) => t + shift);
  }
  return next;
}

// Wheel delta in pixels to a zoom factor: one notch (100px) is about 1.2×.
export function wheelFactor({deltaY, deltaMode}) {
  const pixels = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1);
  return Math.exp(Math.max(-1, Math.min(1, pixels * 0.0018)));
}
