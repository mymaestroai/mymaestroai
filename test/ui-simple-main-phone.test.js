'use strict';
// Simple mode first-look changes, phone page: the mode switch, the theme button, the person's bubble colours,
// the agent sheet (Primary first, "More agents", busy dots). Source checks plus the pure helpers run in a vm.
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
  let at = block.indexOf('function ' + name + '(');
  if (at >= 6 && block.slice(at - 6, at) === 'async ') at -= 6;
  assert.ok(at >= 0, name + ' exists');
  let i = block.indexOf('{', at), depth = 0;
  for (; i < block.length; i++) { if (block[i] === '{') depth++; else if (block[i] === '}' && --depth === 0) break; }
  return block.slice(at, i + 1);
}

test('the mode switch is in both Advanced top bars, hidden until the account is known', () => {
  const tog = /<button type="button" class="mode-toggle" role="switch" aria-checked="false" title="Simple view on\/off" hidden><span class="mt-lab">Simple<\/span><span class="mt-track"><span class="mt-knob"><\/span><\/span><\/button>/g;
  assert.strictEqual((html.match(tog) || []).length, 2);
  const agentsHead = /<div class="topbar" id="agents-head">[\s\S]*?<\/div>/.exec(html)[0];
  assert.ok(agentsHead.includes('class="mode-toggle"'));
  const chatHead = /<div class="topbar" id="chat-head">[\s\S]*?<\/div>\n    <!--/.exec(html)[0];
  assert.ok(chatHead.includes('class="mode-toggle"'));
});

test('Simple top bar: pill, the switch (on), the theme button and the avatar', () => {
  const f = fnSource('simpleTopEnsure');
  assert.match(f, /class="mode-toggle" role="switch" aria-checked="true" title="Simple view on\/off"/);
  assert.match(f, /class="simple-theme-btn"/);
  assert.match(f, /addEventListener\('click', simpleThemeTap\)/);
  assert.match(fnSource('simpleTopPaint'), /simpleToggleSync\(\)/);
});

test('wiring: one delegated click calls the mode tap; the legacy login sees no toggle', () => {
  assert.match(block, /closest\('\.mode-toggle'\)\) simpleModeTap\(\)/);
  assert.match(js, /if \(typeof simpleToggleSync === 'function'\) simpleToggleSync\(\);/);
  const mt = fnSource('simpleModeTap');
  assert.match(mt, /simpleOn\(\) \? 'advanced' : 'simple'/);
  assert.match(mt, /simplePrefsPost\(\{ uiMode: target \}\)/);
  assert.match(mt, /simpleReload\(\)/);
  assert.match(mt, /toast\('Could not switch'\)/);
  const th = fnSource('simpleThemeTap');
  assert.match(th, /nextTheme\(was\)/);
  assert.match(th, /simplePrefsPost\(\{ theme: hubMe\.theme \}\)/);
  assert.match(th, /hubMe\.theme = was;/);
  assert.match(th, /toast\('Could not save that'\)/);
});

function sandbox(me, opts) {
  opts = opts || {};
  const mk = () => ({ hidden: false, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
  const toggles = [mk(), mk(), mk()];
  const calls = { posts: [], toasts: [], reloads: 0, applies: [] };
  const ctx = {
    window: { hubSimple: Object.assign({}, hubSimple, { apply: (m) => calls.applies.push(m.theme) }) },
    hubMe: me,
    document: { querySelectorAll: () => toggles, getElementById: () => null, querySelector: () => null },
    simpleOn: () => !!opts.simple,
    simpleAccountOk: (m) => !!(m && m.user && m.user.id && String(m.user.id) !== 'legacy'),
    simplePrefsPost: async (b) => { calls.posts.push(b); return !opts.fail; },
    simpleReload: () => { calls.reloads++; },
    toast: (m) => calls.toasts.push(m),
  };
  vm.createContext(ctx);
  vm.runInContext('let simpleSwitching = false;\nlet simpleThemeSaving = false;\n' + ['simpleToggleSync', 'simpleModeTap', 'simpleThemeTap'].map(fnSource).join('\n') +
    '\nthis.__h = { simpleToggleSync, simpleModeTap, simpleThemeTap };', ctx);
  return { ctx, toggles, calls, h: ctx.__h };
}

test('toggle shows for a real account only and reflects the mode', () => {
  const a = sandbox({ user: { id: 'u1' } }, { simple: true });
  a.h.simpleToggleSync();
  assert.ok(a.toggles.every((t) => t.hidden === false && t.attrs['aria-checked'] === 'true'));
  const b = sandbox({ user: { id: 'legacy' } });
  b.h.simpleToggleSync();
  assert.ok(b.toggles.every((t) => t.hidden === true && t.attrs['aria-checked'] === 'false'));
});

test('a tap saves the other mode and reloads; a failed save toasts and stays', async () => {
  const a = sandbox({ user: { id: 'u1' } }, { simple: false });
  await a.h.simpleModeTap();
  assert.strictEqual(JSON.stringify(a.calls.posts), JSON.stringify([{ uiMode: 'simple' }]));
  assert.strictEqual(a.calls.reloads, 1);
  const b = sandbox({ user: { id: 'u1' } }, { simple: true, fail: true });
  await b.h.simpleModeTap();
  assert.strictEqual(JSON.stringify(b.calls.posts), JSON.stringify([{ uiMode: 'advanced' }]));
  assert.strictEqual(b.calls.reloads, 0);
  assert.strictEqual(JSON.stringify(b.calls.toasts), JSON.stringify(['Could not switch']));
});

test('the theme button cycles, saves, and restores the old theme when the save fails', async () => {
  const a = sandbox({ user: { id: 'u1' }, theme: 'auto' }, { simple: true });
  await a.h.simpleThemeTap();
  assert.strictEqual(a.ctx.hubMe.theme, 'light');
  assert.strictEqual(JSON.stringify(a.calls.posts), JSON.stringify([{ theme: 'light' }]));
  const b = sandbox({ user: { id: 'u1' }, theme: 'light' }, { simple: true, fail: true });
  await b.h.simpleThemeTap();
  assert.strictEqual(b.ctx.hubMe.theme, 'light');
  assert.strictEqual(JSON.stringify(b.calls.applies), JSON.stringify(['dark', 'light']));
  assert.strictEqual(JSON.stringify(b.calls.toasts), JSON.stringify(['Could not save that']));
});

// ── the sheet's grouping ──
function model() {
  const ctx = { window: { hubSimple } };
  vm.createContext(ctx);
  vm.runInContext(fnSource('simpleAgentSheetModel') + '\nthis.__m = simpleAgentSheetModel;', ctx);
  return ctx.__m;
}
const list = [
  { name: 'owner', category: 'primary' }, { name: 'sam', category: 'specialist' },
  { name: 'helper', category: 'worker' }, { name: 'lab', category: 'experimental' },
];
const names = (xs) => xs.map((a) => a.name);

test('closed: Primary rows, then a More agents row; a busy hidden agent shows on that row', () => {
  const m = model()(list, 'owner', false, (n) => n === 'helper');
  assert.deepStrictEqual(names(m.primary), ['owner']);
  assert.strictEqual(m.groups.length, 0);
  assert.strictEqual(m.hasMore, true);
  assert.strictEqual(m.hiddenBusy, true);
  assert.strictEqual(model()(list, 'owner', false, () => false).hiddenBusy, false);
});

test('closed: the open chat stays visible; its own busy dot is on its row, not on More agents', () => {
  const m = model()(list, 'sam', false, (n) => n === 'sam');
  assert.deepStrictEqual(names(m.primary), ['owner', 'sam']);
  assert.strictEqual(m.hiddenBusy, false);
});

test('open: plain-word headings for the non-empty groups only', () => {
  const m = model()(list.filter((a) => a.name !== 'helper'), 'owner', true, () => false);
  assert.strictEqual(m.open, true);
  assert.deepStrictEqual(m.groups.map((g) => g.label), ['Specialists', 'Experimental']);
  assert.deepStrictEqual(names(m.groups[0].items), ['sam']);
  assert.strictEqual(m.hiddenBusy, false);
});

test('no Primary agent: everything is listed and there is no More agents row', () => {
  const m = model()(list.slice(1), 'sam', false, () => true);
  assert.strictEqual(m.primary.length, 3);
  assert.strictEqual(m.hasMore, false);
  assert.strictEqual(m.hiddenBusy, false);
});

test('only the open chat is outside Primary: nothing to reveal, no More agents row', () => {
  const m = model()([list[0], list[1]], 'sam', false, () => false);
  assert.deepStrictEqual(names(m.primary), ['owner', 'sam']);
  assert.strictEqual(m.hasMore, false);
});

test('the sheet remembers open/closed per device and repaints its dots when status changes', () => {
  assert.match(block, /localStorage\.getItem\(window\.hubSimple\.MORE_KEY\) === '1'/);
  assert.match(block, /localStorage\.setItem\(window\.hubSimple\.MORE_KEY, open \? '1' : '0'\)/);
  assert.match(block, /function simpleAgentsDots\(\) \{\n  if \(!simpleOn\(\)\) return;/);
  assert.match(js, /paintChatStatus\(\);\n  if \(typeof simpleAgentsDots === 'function'\) simpleAgentsDots\(\);/);
  assert.match(fnSource('simpleAgentRow'), /simpleDotClass\(a\.name\)/);   // the row builder is shared with the wide sidebar
  assert.match(fnSource('simpleDotClass'), /pendingQuestion \? 'question' : isBusy\(name\) \? 'busy'/);
});

test('CSS: person bubble colours, links and code, the dots, the narrow top bar', () => {
  assert.match(css, /--sp-me-bg: #5b46a8; --sp-me-text: #ffffff;/);
  assert.match(css, /html\.mm-simple\.mm-light \{[^}]*--sp-me-bg: #ebe6fb; --sp-me-text: #1d1640;/);
  assert.match(css, /html\.mm-simple \.msg\.user \{[^}]*background: var\(--sp-me-bg\); color: var\(--sp-me-text\);/);
  assert.match(css, /html\.mm-simple \.msg\.user a \{[^}]*color: inherit/);
  assert.match(css, /html\.mm-simple \.msg\.assistant \{/);
  for (const sel of ['.simple-theme-btn', '.sa-dot.busy', '.sa-dot.question', '.sa-head', '.sa-more']) assert.ok(css.includes('html.mm-simple ' + sel), sel);
  assert.match(css, /@media \(max-width: 420px\) \{[^}]*\.st-to[^}]*\.stb-lab \{ display: none; \}/);
  assert.match(css, /html\.mm-simple #simple-top \{ display: flex;/);
});

test('CSS: the switch has an accent track when on, grey when off, a sliding knob, and fits a narrow bar', () => {
  // looks-vars: the on-colour moved into :root as --toggle-on-bg (same value)
  assert.match(html, /\.mode-toggle\[aria-checked="true"\] \.mt-track \{ background: var\(--toggle-on-bg\); \}/);
  assert.match(html, /--toggle-on-bg:\s*#8b6fd6;/);
  assert.match(html, /\.mode-toggle \.mt-track \{[^}]*background: var\(--border-strong\)/);
  assert.match(html, /\.mode-toggle\[aria-checked="true"\] \.mt-knob \{ transform: translateX/);
  assert.match(html, /\.mode-toggle\[hidden\] \{ display: none !important; \}/);
  assert.match(html, /#chat-head\.has-mode-toggle \.iconbtn \{ min-width: 38px; \}/);
});

test('no emoji variation selectors in the new lines', () => {
  assert.ok(!block.slice(block.indexOf('function simpleAgentSheetModel')).includes('\uFE0F'));
  assert.ok(!css.includes('\uFE0F'));
});
