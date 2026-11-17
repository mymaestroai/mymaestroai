'use strict';
// Simple mode, phone page, wide screen (an unfolded phone): the agent list on the left, the chat on the right.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'mobile.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'mobile.html'), 'utf8');
const hubSimple = require('../lib/ui-simple.js');
const block = js.slice(js.indexOf('// ── Simple mode: phone ──'), js.indexOf('// ── end Simple mode: phone ──'));
const css = /<style id="simple-css">([\s\S]*?)<\/style>/.exec(html)[1];

function fnSource(name) {
  const at = block.indexOf('function ' + name + '(');
  assert.ok(at >= 0, name + ' exists');
  let i = block.indexOf('{', at), depth = 0;
  for (; i < block.length; i++) { if (block[i] === '{') depth++; else if (block[i] === '}' && --depth === 0) break; }
  return block.slice(at, i + 1);
}
function wideCss() {
  const at = css.indexOf('@media (min-width: 700px) {');
  assert.ok(at >= 0, 'a min-width 700px block exists');
  let i = css.indexOf('{', at), depth = 0;
  for (; i < css.length; i++) { if (css[i] === '{') depth++; else if (css[i] === '}' && --depth === 0) break; }
  return css.slice(at, i + 1);
}

test('CSS: the wide block shows the sidebar, offsets the chat by 260px, hides the pill, mark and avatar', () => {
  const w = wideCss();
  assert.match(w, /html\.mm-simple #simple-side \{ display: flex;/);
  assert.match(w, /width: calc\(260px \+ var\(--sal\)\)/);
  assert.match(w, /html\.mm-simple body \{ padding-left: calc\(260px \+ var\(--sal\)\); \}/);
  assert.match(w, /html\.mm-simple #simple-top \.st-pill, html\.mm-simple #simple-top \.st-mark, html\.mm-simple #simple-top \.st-avatar \{ display: none; \}/);
  assert.match(w, /html\.mm-simple #messages \{ max-width: 760px; \}/);
  assert.match(w, /html\.mm-simple #composer \.row \{ max-width: 760px; \}/);
  // every rule inside the block is scoped under html.mm-simple
  const inner = w.slice(w.indexOf('{') + 1, w.lastIndexOf('}'));
  for (const sel of inner.split('}').map((r) => r.split('{')[0].trim()).filter(Boolean)) {
    for (const part of sel.split(',')) assert.ok(part.trim().startsWith('html.mm-simple '), 'scoped: ' + part.trim());
  }
});

test('CSS: below 700px the sidebar is hidden, and no new rule sits outside html.mm-simple', () => {
  assert.match(css, /\nhtml\.mm-simple #simple-side \{ display: none; \}\n@media \(min-width: 700px\)/);
  const outside = css.split('\n').filter((l) => /simple-side|ssd-/.test(l) && !/^\s*html\.mm-simple /.test(l) && !/^\s*\/\*/.test(l));
  assert.deepStrictEqual(outside, []);
  // Advanced markup: no sidebar in the page's own HTML
  assert.ok(!html.slice(html.indexOf('<body>')).includes('simple-side'));
});

test('JS: the sidebar is built from the sheet model and shares the row builder', () => {
  const f = fnSource('simpleSideEnsure');
  assert.match(f, /createElement\('nav'\)/);
  assert.match(f, /My Maestro AI/);
  assert.match(f, /Chats/);
  assert.match(f, /addEventListener\('click', simpleSettingsOpen\)/);
  const fill = fnSource('simpleAgentListFill');
  assert.match(fill, /simpleAgentSheetModel\(agents, current, simpleMoreGet\(\), isBusy\)/);
  assert.match(fill, /No agents yet\./);
  assert.match(fnSource('simpleSidePaint'), /simpleAgentListFill\(/);
  assert.match(fnSource('simpleAgentsFill'), /simpleAgentListFill\(/);
  assert.match(fnSource('simpleAgentRow'), /navigate\('chat', a\.name\)/);
  assert.strictEqual((block.match(/agentGroups\(/g) || []).length, 1, 'grouping lives in one place');
});

test('JS: the matchMedia listener is guarded; the new hooks are guarded', () => {
  assert.match(block, /if \(typeof window !== 'undefined' && typeof window\.matchMedia === 'function'\) \{/);
  assert.match(block, /matchMedia\('\(min-width: 700px\)'\)/);
  assert.match(block, /wide\.addEventListener\('change', wideChange\)/);
  assert.match(block, /d\.close\(\)/);
  assert.match(js, /function renderAgents\(\) \{\n  if \(typeof simpleSidePaint === 'function'\) simpleSidePaint\(\);/);
  assert.match(fnSource('simpleAgentListsRepaint'), /typeof simpleSidePaint === 'function'/);
  assert.match(fnSource('simpleAgentsDots'), /getElementById\('simple-side'\)/);
  assert.match(fnSource('simpleTopPaint'), /simpleSidePaint\(\)/);
  assert.ok(!css.slice(css.indexOf('Wide screen')).includes('\uFE0F'));
});

// ── run the row builder in a vm, with a tiny DOM ──
function el(tag) {
  const e = {
    tag, children: [], className: '', dataset: {}, attrs: {}, text: '', listeners: {}, _q: {},
    classList: { add(c) { e.className += ' ' + c; }, contains(c) { return e.className.split(/\s+/).includes(c); } },
    setAttribute(k, v) { e.attrs[k] = v; }, appendChild(c) { e.children.push(c); return c; },
    addEventListener(t, f) { e.listeners[t] = f; },
    querySelector(sel) { return e._q[sel] || (e._q[sel] = el('span')); },
    set textContent(v) { e.text = v; if (v === '') e.children = []; }, get textContent() { return e.text; },
    set innerHTML(v) { e.html = v; },
  };
  return e;
}
function run(list, cur, open, busy) {
  const navs = [];
  const ctx = {
    window: { hubSimple },
    document: { createElement: el }, agents: list, current: cur, screen: 'chat', isBusy: (n) => busy.includes(n), live: {},
    navigate: (s, n) => navs.push([s, n]), simpleMoreGet: () => open, simpleMoreSet: () => {}, simpleAgentListsRepaint: () => {},
  };
  vm.createContext(ctx);
  const names = ['simpleAgentSheetModel', 'simpleDotClass', 'simpleAgentRow', 'simpleAgentListFill'];
  vm.runInContext(names.map(fnSource).join('\n') + '\nthis.__f = { simpleAgentListFill };', ctx);
  const box = el('div');
  ctx.__f.simpleAgentListFill(box, {});
  return { box, navs };
}
const list = [
  { name: 'zed', icon: 'Z', category: 'primary' }, { name: 'owner', lead: true, icon: 'O', category: 'primary' },
  { name: 'guide', category: 'primary' },
  { name: 'sam', category: 'specialist' }, { name: 'helper', category: 'worker' },
];
const rowNames = (box) => box.children.filter((c) => c.dataset && c.dataset.agent).map((c) => c.dataset.agent);

test('rows: lead first, then alphabetical; More agents closed by default', () => {
  const { box } = run(list, 'owner', false, []);
  assert.deepStrictEqual(rowNames(box), ['owner', 'guide', 'zed']);
  assert.ok(box.children.some((c) => /sa-more/.test(c.className)));
  assert.ok(!box.children.some((c) => /sa-head/.test(c.className)));
});

test('rows: the open chat shows when its group is closed; the busy dot follows; a tap opens the chat', () => {
  const r = run(list, 'sam', false, ['sam']);
  assert.deepStrictEqual(rowNames(r.box), ['owner', 'guide', 'zed', 'sam']);
  const sam = r.box.children.find((c) => c.dataset.agent === 'sam');
  assert.ok(sam.classList.contains('sel'));
  assert.strictEqual(sam.querySelector('.sa-dot').className, 'sa-dot busy');
  r.box.children.find((c) => c.dataset.agent === 'guide').listeners.click();
  assert.deepStrictEqual(r.navs, [['chat', 'guide']]);
});

test('rows: open shows headings and the other agents; no agents says so', () => {
  const o = run(list, 'owner', true, []);
  assert.deepStrictEqual(rowNames(o.box), ['owner', 'guide', 'zed', 'sam', 'helper']);
  assert.deepStrictEqual(o.box.children.filter((c) => /sa-head/.test(c.className)).map((c) => c.text), ['Specialists', 'Helpers']);
  assert.strictEqual(run([], null, false, []).box.text, 'No agents yet.');
});
