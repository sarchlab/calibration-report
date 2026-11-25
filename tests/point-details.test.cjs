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
    this.classChanges = [];
    this.classList = {
      add: name => this.classes.add(name),
      remove: name => { this.classChanges.push([name, false]); this.classes.delete(name); },
      toggle: (name, on) => { this.classChanges.push([name, on]); return on ? this.classes.add(name) : this.classes.delete(name); },
      contains: name => this.classes.has(name),
    };
    this.hideCount = 0;
    this.rect = {left: 10, top: 20, width: 320, height: 160};
  }
  set hidden(value) { if (value && !this._hidden) this.hideCount++; this._hidden = value; }
  get hidden() { return this._hidden; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text ?? '') + this.children.map(c => c.textContent).join(''); }
  append(...nodes) {
    for (const node of nodes) {
      if (node.parentElement) node.parentElement.children = node.parentElement.children.filter(child => child !== node);
      node.appendCount = (node.appendCount ?? 0) + 1;
      node.parentElement = this;
      this.children.push(node);
    }
  }
  closest(selector) {
    if (selector === '#' + this.id) return this;
    return this.parentElement?.closest(selector) ?? null;
  }
  replaceChildren(...nodes) { this.text = ''; this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  getBoundingClientRect() { return this.rect; }
  focus() { this.focused = true; }
  scrollIntoView() { this.scrollCount = (this.scrollCount ?? 0) + 1; }
  fire(type, properties = {}) { this.listeners[type]?.({preventDefault() {}, ...properties}); }
}

function byClass(root, className) {
  return [root, ...root.children.flatMap(child => byClass(child, className))]
    .filter(node => (node.className ?? '').split(' ').includes(className));
}

function fixture(pointCount = 2) {
  const document = new Element('document');
  document.body = new Element('body');
  document.createElement = tag => new Element(tag);
  const desktop = {matches: true, addEventListener(type, listener) { this.change = listener; }};
  const temporaryLandscape = {matches: false};
  const context = vm.createContext({document, Intl, matchMedia: query => query.includes('orientation') ? temporaryLandscape : desktop});
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
  while (points.length < pointCount) {
    const index = points.length;
    points.push({x: 100 + index * 5, y: 50, description: context.pointDescription({...row, x: (index + 1) * 131072})});
  }
  const plot = context.interactivePlot(canvas, points.slice(0, pointCount));
  document.body.append(plot);
  const detail = byClass(plot, 'point-detail')[0];
  const controls = byClass(plot, 'point-controls')[0];
  const [previousTen, previous, counter, next, nextTen, close] = controls.children;
  const tap = () => canvas.fire('click', {pointerType: 'touch', clientX: 110, clientY: 70});
  return {context, document, desktop, temporaryLandscape, row, description, canvas, plot, detail, controls, previousTen, previous, counter, next, nextTen, close, tap};
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
  const appendCount = f.detail.appendCount;
  f.plot.fire('focusout', {relatedTarget: null});
  assert.equal(f.detail.hidden, false);
  for (let i = 0; i < 4; i++) {
    f.next.fire('click'); assert.equal(f.counter.textContent, '2 / 2');
    assert.match(f.detail.textContent, /262,144/);
    f.previous.fire('click'); assert.equal(f.counter.textContent, '1 / 2');
  }
  assert.equal(f.detail.hideCount, hideCount, 'navigation must not transiently hide focused controls');
  assert.equal(f.detail.appendCount, appendCount, 'navigation must not move the panel and blur its focused control');
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
  f.tap(); f.document.fire('click', {target: new Element('button')}); assert.equal(f.detail.hidden, true);
  f.tap(); f.plot.fire('focusout', {relatedTarget: new Element('button')}); assert.equal(f.detail.hidden, false, 'focusout cannot move a target before its click');
  f.document.fire('click', {target: new Element('button')}); assert.equal(f.detail.hidden, true);
});

test('pinned details survive other-plot hover and selection transfers the sole panel', () => {
  const f = fixture(); f.tap();
  const otherCanvas = new Element('canvas');
  otherCanvas.width = 640; otherCanvas.height = 320;
  otherCanvas.setAttribute('aria-label', 'Other plot');
  const otherPlot = f.context.interactivePlot(otherCanvas, [
    {x: 100, y: 50, description: f.context.pointDescription({...f.row, x: 512})},
  ]);
  f.document.body.append(otherPlot);
  const otherDetail = byClass(otherPlot, 'point-detail')[0];
  otherCanvas.fire('pointermove', {pointerType: 'mouse', clientX: 110, clientY: 70});
  assert.equal(f.detail.hidden, false, 'hover must not replace a pinned selection');
  assert.equal(otherDetail.hidden, true);
  f.document.body.classChanges = [];
  f.document.fire('pointerdown', {target: otherCanvas});
  f.plot.fire('focusout', {relatedTarget: otherCanvas});
  assert.equal(f.detail.hidden, false, 'press and focus transfer must not resize before hit testing');
  otherCanvas.fire('click', {pointerType: 'touch', clientX: 110, clientY: 70});
  f.document.fire('click', {target: otherCanvas});
  assert.ok(f.document.body.classChanges.every(([, open]) => open), 'selection transfer must never collapse the sidebar');
  assert.equal(f.detail.hidden, true);
  assert.equal(otherDetail.hidden, false);
  assert.match(otherDetail.textContent, /512/);
  f.document.fire('click', {target: otherDetail});
  assert.equal(otherDetail.hidden, false, 'interacting with panel content is not an outside tap');
  f.document.fire('pointerdown', {target: f.canvas});
  assert.equal(otherDetail.hidden, false);
  f.canvas.fire('click', {pointerType: 'mouse', clientX: 10, clientY: 20});
  f.document.fire('click', {target: f.canvas});
  assert.equal(otherDetail.hidden, true, 'clicking an empty area in another plot dismisses after hit testing');
  assert.equal(f.document.body.classList.contains('point-details-open'), false);
});

test('pinned content is keyboard reachable and dismissal restores focus without redraw stealing it', () => {
  const f = fixture();
  f.canvas.fire('pointermove', {pointerType: 'mouse', clientX: 110, clientY: 70});
  const content = byClass(f.detail, 'point-description')[0];
  const previewHint = byClass(f.detail, 'point-preview-hint')[0];
  assert.equal(content.tabIndex, -1);
  assert.equal(previewHint.hidden, false);
  f.canvas.fire('keydown', {key: 'Enter'});
  assert.equal(content.tabIndex, 0, 'keyboard users can focus and scroll the panel content');
  assert.equal(previewHint.hidden, true);
  assert.equal(f.controls.hidden, false);
  f.document.fire('keydown', {key: 'Escape'});
  assert.equal(f.detail.hidden, true);
  assert.equal(f.canvas.focused, true);
  f.canvas.focused = false;
  f.tap();
  vm.runInContext('closePointDetails()', f.context);
  assert.equal(f.detail.hidden, true);
  assert.equal(f.canvas.focused, false, 'redraw cleanup must not refocus a disappearing chart');
  f.canvas.fire('pointermove', {pointerType: 'mouse', clientX: 110, clientY: 70});
  assert.equal(f.detail.hidden, false, 'cleanup releases the pinned-owner guard');
});

test('summary selections leave the hidden summary, keep keyboard navigation, and restore their source', () => {
  const f = fixture();
  const summary = new Element('section'); summary.id = 'summary';
  summary.append(f.plot); f.document.body.append(summary);
  f.canvas.fire('keydown', {key: 'Enter'});
  const content = byClass(f.detail, 'point-description')[0];
  assert.equal(f.detail.parentElement, f.document.body, 'details escape the summary ancestor');
  assert.equal(summary.contains(f.detail), false);
  assert.equal(content.focused, true, 'focus follows details when their source summary is hidden');
  const layoutChanges = f.document.body.classChanges.length;
  content.fire('keydown', {key: 'ArrowRight'});
  assert.equal(f.counter.textContent, '2 / 2');
  assert.ok(f.document.body.classChanges.slice(layoutChanges).every(([, open]) => open));
  f.desktop.matches = false; f.desktop.change();
  assert.equal(f.detail.hidden, false, 'orientation changes preserve selection');
  content.focused = false;
  f.desktop.matches = true; f.desktop.change();
  assert.equal(content.focused, true, 'returning to desktop keeps hidden-summary details reachable');
  f.document.fire('keydown', {key: 'Escape'});
  assert.equal(f.detail.parentElement, f.plot);
  assert.equal(f.document.body.classList.contains('point-details-open'), false);
  assert.equal(f.canvas.focused, true);
  f.tap(); vm.runInContext('closePointDetails()', f.context);
  assert.equal(f.detail.parentElement, f.plot, 'redraw cleanup leaves no detached body panel');
});

test('outside activation completes before dismissal and resized charts use current geometry', () => {
  const f = fixture(); f.tap();
  const button = new Element('button');
  f.document.fire('pointerdown', {target: button});
  f.plot.fire('focusout', {relatedTarget: button});
  assert.equal(f.detail.hidden, false);
  button.addEventListener('click', () => assert.equal(f.detail.hidden, false, 'outside button activates before page width is restored'));
  button.fire('click'); f.document.fire('click', {target: button});
  assert.equal(f.detail.hidden, true);
  f.tap();
  f.canvas.rect = {left: 30, top: 40, width: 160, height: 80};
  f.canvas.fire('click', {pointerType: 'mouse', clientX: 130, clientY: 80});
  assert.equal(f.counter.textContent, '2 / 2', 'selection follows the resized chart, not old coordinates');
  assert.equal(f.detail.hidden, false);
});

test('Tab reaches portaled details directly and Shift-Tab returns to a visible source', () => {
  const f = fixture(); f.canvas.fire('keydown', {key: 'Enter'});
  const content = byClass(f.detail, 'point-description')[0];
  f.canvas.fire('keydown', {key: 'Tab'});
  assert.equal(content.focused, true);
  content.fire('keydown', {key: 'Tab', shiftKey: true});
  assert.equal(f.canvas.focused, true);
  assert.equal(f.detail.hidden, false);
});

test('live run statistics update independently of an open point panel', () => {
  const f = fixture();
  const nodes = new Map(['description', 'title', 'live-badge', 'progress'].map(id => [id, new Element('div')]));
  f.document.querySelector = selector => nodes.get(selector.slice(1));
  const report = {title: 'Live report', live: true};
  const progress = {total: 10, completed: 3, running: 2, queued: 4, unsuccessful: 1, started_at: '2026-11-24T12:00:00Z'};
  f.context.renderHeader(report, progress);
  const panel = nodes.get('progress');
  assert.match(panel.textContent, /Completed3/);
  f.tap();
  f.document.body.classChanges = [];
  f.context.renderHeader(report, {...progress, completed: 4, running: 1});
  assert.match(panel.textContent, /Completed4/);
  assert.match(panel.textContent, /Running1/);
  assert.match(panel.textContent, /Started/);
  assert.equal(f.detail.hidden, false);
  assert.equal(f.detail.parentElement, f.document.body);
  assert.equal(f.document.body.classChanges.length, 0, 'polling leaves sidebar layout and selection alone');
});

test('only temporary landscape width changes scroll the selected source into view', () => {
  const f = fixture();
  f.tap(); f.next.fire('click'); f.close.fire('click');
  assert.equal(f.canvas.scrollCount, undefined, 'desktop selection and dismissal do not scroll');
  f.temporaryLandscape.matches = true;
  f.tap();
  assert.equal(f.canvas.scrollCount, 1, 'first landscape pin reveals the chart after rewrapping');
  f.next.fire('click'); f.previous.fire('click');
  assert.equal(f.canvas.scrollCount, 1, 'point navigation retains the viewport');
  const otherCanvas = new Element('canvas');
  otherCanvas.width = 640; otherCanvas.height = 320;
  const otherPlot = f.context.interactivePlot(otherCanvas, [{x: 100, y: 50, description: f.description}]);
  f.document.body.append(otherPlot);
  otherCanvas.fire('click', {pointerType: 'touch', clientX: 110, clientY: 70});
  assert.equal(otherCanvas.scrollCount, undefined, 'transferring selection does not change width or scroll');
  f.document.fire('keydown', {key: 'Escape'});
  assert.equal(otherCanvas.scrollCount, 1, 'explicit dismissal reveals the source after width restoration');
  f.tap();
  const beforeOutsideClick = f.canvas.scrollCount;
  f.document.fire('click', {target: new Element('button')});
  assert.equal(f.canvas.scrollCount, beforeOutsideClick, 'outside activation must not scroll away from its target');
  f.temporaryLandscape.matches = false; f.desktop.matches = false;
  f.tap(); f.close.fire('click');
  assert.equal(f.canvas.scrollCount, beforeOutsideClick, 'portrait panels do not scroll the source');
});

test('compact controls expose English labels and ten-point jumps wrap short and long series', () => {
  const cases = [
    {count: 1, homeBack: 1, homeForward: 1, endForward: 1, endBack: 1},
    {count: 2, homeBack: 1, homeForward: 1, endForward: 2, endBack: 2},
    {count: 3, homeBack: 3, homeForward: 2, endForward: 1, endBack: 2},
    {count: 13, homeBack: 4, homeForward: 11, endForward: 10, endBack: 3},
  ];
  for (const {count, homeBack, homeForward, endForward, endBack} of cases) {
    const f = fixture(count); f.canvas.fire('keydown', {key: 'Home'});
    assert.deepEqual(f.controls.children.filter(node => node.tagName === 'button').map(button =>
      [button.textContent, button.getAttribute('aria-label'), button.title]), [
      ['<<', 'Previous 10 points', 'Previous 10 points'],
      ['<', 'Previous point', 'Previous point'],
      ['>', 'Next point', 'Next point'],
      ['>>', 'Next 10 points', 'Next 10 points'],
      ['×', 'Close point details', 'Close point details'],
    ]);
    const hideCount = f.detail.hideCount;
    const appendCount = f.detail.appendCount;
    for (const [key, button, expected] of [
      ['Home', f.previousTen, homeBack], ['Home', f.nextTen, homeForward],
      ['End', f.nextTen, endForward], ['End', f.previousTen, endBack],
    ]) {
      f.canvas.fire('keydown', {key});
      button.focus(); button.fire('click');
      assert.equal(f.counter.textContent, expected + ' / ' + count);
      assert.equal(button.focused, true);
      assert.equal(f.detail.hidden, false);
      assert.equal(f.detail.hideCount, hideCount, 'jumping must not hide focused controls');
      assert.equal(f.detail.appendCount, appendCount, 'jumping must not reparent the panel');
    }
    f.close.fire('click');
    assert.equal(f.detail.hidden, true);
    assert.equal(f.canvas.focused, true);
  }
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
