import {afterEach, vi} from 'vitest';
import {cleanup} from '@testing-library/react';

const listeners = new Set();
let viewport = 'desktop';
export function setViewport(value) {
  viewport = value;
  for (const {query, listener} of listeners)
    listener({matches: matches(query)});
}
function matches(query) {
  if (query.includes('prefers-color-scheme')) return false;
  if (query.includes('orientation: landscape')) return viewport === 'landscape';
  if (query.includes('min-width: 821px')) return viewport === 'desktop';
  return false;
}
Object.defineProperty(window, 'matchMedia', {
  value: (query) => ({
    media: query,
    get matches() {
      return matches(query);
    },
    addEventListener(type, listener) {
      listeners.add({query, listener});
    },
    removeEventListener(type, listener) {
      for (const entry of listeners)
        if (entry.listener === listener) listeners.delete(entry);
    },
  }),
});
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.PointerEvent = class extends MouseEvent {
  constructor(type, options = {}) {
    super(type, options);
    this.pointerType = options.pointerType ?? '';
  }
};
HTMLElement.prototype.scrollIntoView = vi.fn();
Object.defineProperty(HTMLCanvasElement.prototype, 'getBoundingClientRect', {
  writable: true,
  value() {
    return {
      left: 10,
      top: 20,
      width: 320,
      height: this.height / 2,
      right: 330,
      bottom: 20 + this.height / 2,
    };
  },
});
HTMLCanvasElement.prototype.getContext = () =>
  new Proxy(
    {measureText: (text) => ({width: String(text).length * 5})},
    {
      get(target, name) {
        return name in target ? target[name] : () => {};
      },
      set(target, name, value) {
        target[name] = value;
        return true;
      },
    },
  );
afterEach(() => {
  cleanup();
  setViewport('desktop');
  vi.restoreAllMocks();
  vi.useRealTimers();
});
