const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Only the DOM surface used by point details. Browser layout and gesture
// recognition still require the documented manual phone/browser checks.
class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.listeners = {};
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this.classes = new Set();
    this.classList = {
      add: name => this.classes.add(name),
      remove: name => this.classes.delete(name),
      toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name),
    };
    this.hideCount = 0;
    this.rect = {left: 10, top: 20, width: 320, height: 160};
  }
  set hidden(value) { if (value && !this._hidden) this.hideCount++; this._hidden = value; }
  get hidden() { return this._hidden; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text ?? '') + this.children.map(c => c.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.text = ''; this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  getBoundingClientRect() { return this.rect; }
  focus() { this.focused = true; }
  fire(type, properties = {}) { this.listeners[type]?.({preventDefault() {}, ...properties}); }
}

function byClass(root, className) {
  return [root, ...root.children.flatMap(child => byClass(child, className))]
    .filter(node => (node.className ?? '').split(' ').includes(className));
}

function fixture() {
  const document = new Element('document');
  document.createElement = tag => new Element(tag);
  const context = vm.createContext({document, Intl});
  const source = fs.readFileSync(path.join(__dirname, '../site/report.js'), 'utf8');
  const bootstrap = '\nsetupTheme();\nrefresh();';
  assert.ok(source.trimEnd().endsWith(bootstrap));
  vm.runInContext(source.trimEnd().slice(0, -bootstrap.length), context);
  vm.runInContext(`
    pointContext = {
      groups: {gpu: {name: 'Example GPU'}},
      benchmarks: {fp32_throughput: {
        scaling_param: 'fmas_per_thread',
        params: {fmas_per_thread: {unit: ''}, launch: {unit: ''}, num_blocks: {unit: ''}},
        values: {
          hw: {name: 'GPU kernel time (median)', role: 'hardware_measurement', unit: 'ns'},
          sim: {name: 'Simulator kernel time', role: 'simulator_output', unit: 'ns'},
        },
      }},
    };
  `, context);
  const row = {
    group: 'gpu', benchmark: 'fp32_throughput', x: 131072,
    non_scaling_params: {launch: '#1 kernel<script>', num_blocks: 1},
    values: {hw: 1000000, sim: 500000},
  };
  const description = context.pointDescription(row, [{signedError: -100, name: 'Simulator vs. GPU'}], {'CDF percentile': '81.91%'}, 'sim');
  const canvas = new Element('canvas');
  canvas.width = 640; canvas.height = 320;
  canvas.setAttribute('aria-label', 'Test plot');
  const points = [
    {x: 100, y: 50, description},
    {x: 200, y: 80, description: context.pointDescription({...row, x: 262144})},
  ];
  const plot = context.interactivePlot(canvas, points);
  const detail = byClass(plot, 'point-detail')[0];
  const controls = byClass(plot, 'point-controls')[0];
  const [previous, counter, next, close] = controls.children;
  const tap = () => canvas.fire('click', {pointerType: 'touch', clientX: 110, clientY: 70});
  return {context, document, row, description, canvas, plot, detail, controls, previous, counter, next, close, tap};
}

test('details separate metadata, converted values, signed error, percentile and configuration', () => {
  const f = fixture(); f.tap();
  assert.equal(byClass(f.detail, 'point-title')[0].textContent, 'FP32 throughput');
  assert.equal(byClass(f.detail, 'point-kernel')[0].textContent, '#1 kernel<script>');
  assert.equal(byClass(f.detail, 'point-kernel')[0].children.length, 0, 'metadata is text, not HTML');
  assert.deepEqual(byClass(f.detail, 'point-measurement-value').map(n => n.textContent), ['1ms', '0.5ms']);
  assert.equal(byClass(f.detail, 'point-error-value')[0].textContent, '−100.00%');
  assert.equal(byClass(f.detail, 'point-direction')[0].textContent, 'Underestimate');
  assert.match(byClass(f.detail, 'point-metrics')[0].textContent, /CDF percentile81\.91%/);
  assert.match(byClass(f.detail, 'point-parameters')[0].textContent, /FMAs \/ thread131,072/);
  const unavailable = f.context.renderPointDescription(f.context.pointDescription({
    ...f.row, values: {hw: 1000000, sim: null},
    statuses: {sim: {state: 'verification_failed', reason: 'CPU mismatch'}},
  }));
  assert.equal(byClass(unavailable, 'point-measurement-value')[1].textContent, 'verification failed');
  assert.equal(byClass(unavailable, 'point-measurement-reason')[0].textContent, 'CPU mismatch');
});

test('CSS-pixel hit targets work with scaling, and touch allows a wider target than hover', () => {
  const f = fixture();
  f.canvas.fire('pointermove', {pointerType: 'mouse', clientX: 135, clientY: 70});
  assert.equal(f.detail.hidden, true);
  f.canvas.fire('click', {pointerType: 'touch', clientX: 135, clientY: 70});
  assert.equal(f.detail.hidden, false);
  f.close.fire('click');
  f.canvas.rect.width = 640; f.canvas.rect.height = 320;
  f.canvas.fire('pointermove', {pointerType: 'mouse', clientX: 210, clientY: 120});
  assert.equal(f.detail.hidden, false);
  assert.equal(f.controls.hidden, true);
  f.plot.fire('pointerleave');
  assert.equal(f.detail.hidden, true);
});

test('plain click events retain the initiating pointer type without leaking it to later input', () => {
  const f = fixture();
  const plainClick = () => f.canvas.fire('click', {clientX: 135, clientY: 70});
  f.canvas.fire('pointerdown', {pointerType: 'touch'});
  plainClick();
  assert.equal(f.detail.hidden, false, 'touch-origin MouseEvent keeps the wider hit target');
  f.close.fire('click');
  plainClick();
  assert.equal(f.detail.hidden, true, 'the initiating pointer type is consumed after one click');
  f.canvas.fire('pointerdown', {pointerType: 'touch'});
  f.canvas.fire('pointerdown', {pointerType: 'mouse'});
  plainClick();
  assert.equal(f.detail.hidden, true, 'a subsequent mouse press replaces earlier touch input');
  f.canvas.fire('pointerdown', {pointerType: 'touch'});
  f.canvas.fire('pointercancel');
  plainClick();
  assert.equal(f.detail.hidden, true, 'a canceled gesture must not affect later clicks');
  f.canvas.fire('pointerdown', {pointerType: 'touch'});
  f.canvas.fire('click', {pointerType: 'mouse', clientX: 135, clientY: 70});
  assert.equal(f.detail.hidden, true, 'an explicit click pointer type takes precedence');
});

test('mobile null-focus blur and repeated Next/Previous retain the open card and controls', () => {
  const f = fixture(); f.tap();
  const hideCount = f.detail.hideCount;
  f.plot.fire('focusout', {relatedTarget: null});
  assert.equal(f.detail.hidden, false);
  for (let i = 0; i < 4; i++) {
    f.next.fire('click'); assert.equal(f.counter.textContent, '2 / 2');
    assert.match(f.detail.textContent, /262,144/);
    f.previous.fire('click'); assert.equal(f.counter.textContent, '1 / 2');
  }
  assert.equal(f.detail.hideCount, hideCount, 'navigation must not transiently hide focused controls');
  f.plot.fire('focusout', {relatedTarget: f.next});
  assert.equal(f.detail.hidden, false);
});

test('keyboard browsing and intentional dismiss paths still work', () => {
  const f = fixture();
  f.canvas.fire('keydown', {key: 'End'}); assert.equal(f.counter.textContent, '2 / 2');
  f.canvas.fire('keydown', {key: 'Home'}); assert.equal(f.counter.textContent, '1 / 2');
  f.document.fire('keydown', {key: 'Escape'}); assert.equal(f.detail.hidden, true);
  f.tap(); f.close.fire('click'); assert.equal(f.detail.hidden, true); assert.equal(f.canvas.focused, true);
  f.tap(); f.tap(); assert.equal(f.detail.hidden, true);
  f.tap(); f.document.fire('pointerdown', {target: {closest: () => null}}); assert.equal(f.detail.hidden, true);
  f.tap(); f.plot.fire('focusout', {relatedTarget: new Element('button')}); assert.equal(f.detail.hidden, true);
});

test('rapid-tap targets retain scrolling and pinch zoom through manipulation touch action', () => {
  const css = fs.readFileSync(path.join(__dirname, '../site/report.css'), 'utf8');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)];
  for (const selector of ['.point-controls button', '.interactive-plot .curve']) {
    assert.ok(rules.some(([, selectors, declarations]) =>
      selectors.split(',').map(s => s.trim()).includes(selector) &&
      /touch-action:\s*manipulation\s*;/.test(declarations)), selector);
  }
});
