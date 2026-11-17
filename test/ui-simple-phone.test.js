'use strict';
// Simple mode, phone page: source checks (the code is present and gated, the pinned lines are intact) and behaviour
// checks of the pure helpers, run in a vm with the real lib/ui-simple.js. No network, no data directory.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'mobile.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'mobile.html'), 'utf8');
const hubSimple = require('../lib/ui-simple.js');

const START = '// ── Simple mode: phone ──';
const END = '// ── end Simple mode: phone ──';
const block = js.slice(js.indexOf(START), js.indexOf(END));

test('the Simple block is one marked region before init()', () => {
  assert.ok(block.length > 2000);
  assert.ok(js.indexOf(END) < js.lastIndexOf('\ninit();'));
  assert.strictEqual(js.split(START).length, 2);
});

test('the Simple block comes after every (begin)/(end) helper block and has none of its own', () => {
  const at = js.indexOf(START);
  assert.ok(js.lastIndexOf('(end) ──') < at);
  assert.ok(!/\((begin|end)\) ──/.test(block));
});

test('every Simple function is gated by simpleOn()', () => {
  for (const name of ['simpleThinkPaint', 'simpleThinkStart', 'simpleThinkEnd', 'simpleGatewayHook', 'simpleActivityHook', 'simpleUserBubbleHook', 'simpleHubEntry', 'simpleEmptyPaint', 'simpleTopPaint', 'simpleAgentsOpen', 'simpleSettingsOpen', 'simpleEffortPaint', 'simpleChatExtra', 'simpleRoute']) {
    const m = new RegExp('function ' + name + '\\([^)]*\\) \\{\\n([^\\n]*)').exec(block);
    assert.ok(m, name + ' exists');
    assert.match(m[1], /simpleOn\(\)/, name + ' starts with the gate');
  }
});

test('every call into hubSimple is guarded', () => {
  assert.match(js, /if \(window\.hubSimple\) \{ try \{ window\.hubSimple\.apply\(hubMe\); \}/);
  assert.match(block, /function simpleOn\(\) \{ return !!\(window\.hubSimple && /);
  // outside the Simple block the only hubSimple uses are the guarded apply in loadMe
  const outside = js.replace(block, '');
  assert.strictEqual((outside.match(/hubSimple/g) || []).length, 2);
});

test('hook points: each existing function got its one added line, which tolerates a page without the Simple block', () => {
  const g = (n) => "typeof " + n + " === 'function'";
  assert.ok(js.includes("if (" + g('simpleGatewayHook') + ") simpleGatewayHook(rec, g);"));
  assert.match(js, /simpleGatewayHook\(rec, g\);[^\n]*\n    switch \(g\.type\) \{/);
  assert.match(js, /feedUpsert\(h, ev\.item\);\n  if \(typeof simpleActivityHook === 'function'\) simpleActivityHook\(h, ev\.item\);/);
  assert.match(js, /streams\.set\(agent, rec\);\n  if \(typeof simpleThinkStart === 'function'\) simpleThinkStart\(rec\);/);
  assert.match(js, /paintCtx\(\); refreshCtx\(name\); paintPlan\(\);\n  if \(typeof simpleTopPaint === 'function'\) \{ simpleTopPaint\(\); simpleEffortPaint\(\); \}/);
  assert.match(js, /rec\.full \+= delta;\n        if \(typeof simpleThinkEnd === 'function'\) simpleThinkEnd\(rec, true\);/);
  assert.match(js, /if \(!r \|\| !el \|\| !el\.isConnected\) return;\n  if \(typeof simpleThinkPaint === 'function'\) simpleThinkPaint\(holder\);/);
  assert.match(js, /function reasoningEnd\(holder\) \{\n  if \(typeof simpleThinkEnd === 'function'\) simpleThinkEnd\(holder, false\);/);
  assert.match(js, /function feedEnd\(holder, how = 'sure'\) \{\n  if \(typeof simpleThinkEnd === 'function'\) simpleThinkEnd\(holder, true\);/);
  assert.match(js, /if \(holder\.replyText && typeof simpleThinkEnd === 'function'\) simpleThinkEnd\(holder, true\);/);
  assert.match(js, /addNote\('No messages yet'\);\n  if \(typeof simpleEmptyPaint === 'function'\) simpleEmptyPaint\(/);
  assert.match(js, /if \(typeof simpleHubEntry === 'function' && simpleHubEntry\(m, time\)\) return;/);
  assert.match(js, /if \(typeof simpleUserBubbleHook === 'function'\) simpleUserBubbleHook\(d, text\);[^\n]*\n  return d;/);
  assert.match(js, /const route = routeFromHash\(\);\n  if \(typeof simpleRoute === 'function'\) simpleRoute\(route\);/);
  assert.match(js, /function foldAutoOn\(\) \{\n  if \(typeof simpleOn === 'function' && simpleOn\(\)\) return false;/);
});

test('the effort level rides the chat POST only through simpleChatExtra, and the pinned body line is intact', () => {
  assert.match(js, /body: JSON\.stringify\(\{ agent, message: text, images, confirm_tools: false, \.\.\.\(typeof simpleChatExtra === 'function' \? simpleChatExtra\(agent\) : \{\}\), \.\.\.\(fallback && fallback\.voice \? \{ voice: true \} : \{\}\)/);
  assert.strictEqual((js.match(/simpleChatExtra\(agent\)/g) || []).length, 2);   // the call and the definition's parameter line
});

test('pinned existing lines are unchanged', () => {
  for (const s of [
    "const EFFORT_LABEL = { default: 'Default effort', low: 'Low effort'",
    "$('chat-effort-pick')?.addEventListener('change', changeEffortFromPick);",
    "case 'reasoning': reasoningAdd(rec, g.text); break;",
    "box.className = 'rsn';",
    "box.className = 'question';",
    "b.className = 'opt';",
    "if (!lost) { feedEnd(rec, rec.done ? 'sure' : 'maybe'); reasoningEnd(rec); }",
    'async function signOut() {',
    'function openProfileSheet() {',
    "if (!chatHistory.length && chatNext == null) addNote('No messages yet');",
  ]) assert.ok(js.includes(s), s);
  for (const s of ['<script src="/ui-file-card.js"></script>', '<button id="menu-signout">Sign out</button>', 'id="voice-strip"', 'id="plus-sheet"']) assert.ok(html.includes(s), s);
});

test('loadMe applies the mode right after reading /api/me', () => {
  assert.match(js, /hubMe = await r\.json\(\);\n      if \(window\.hubSimple\) \{ try \{ window\.hubSimple\.apply\(hubMe\)/);
});

test('mobile.html: the script tag, the Switch to Simple item and one Simple style block', () => {
  const a = html.indexOf('<script src="/ui-simple.js"></script>');
  assert.ok(a > html.indexOf('<script src="/ui-file-card.js"></script>'));
  assert.ok(a < html.indexOf('<script src="mobile.js"></script>'));
  assert.strictEqual(html.split('<style id="simple-css">').length, 2);
  assert.match(html, /<button id="menu-simple">Switch to Simple<\/button>\n    <button id="menu-signout">/);
});

function simpleCss() {
  const m = /<style id="simple-css">([\s\S]*?)<\/style>/.exec(html);
  return m[1].replace(/\/\*[\s\S]*?\*\//g, '');
}
test('Simple CSS: every rule is under html.mm-simple (but the hide-by-default of the Simple-only elements)', () => {
  const css = simpleCss();
  const rules = [];
  let depth = 0, cur = '';
  for (const ch of css) {
    if (ch === '{') { if (depth === 0) rules.push(cur.trim()); depth++; cur = ''; }
    else if (ch === '}') { depth--; cur = ''; }
    else if (depth === 0) cur += ch;
  }
  const loose = rules.filter(r => !r.startsWith('html.mm-simple') && !r.startsWith('@media') && !r.startsWith('@keyframes'));
  assert.deepStrictEqual(loose, ['#simple-top, #simple-effort-btn, #simple-call-btn, #simple-effort-sheet, .simple-think, .simple-empty']);
  assert.match(css, /html\.mm-simple\.mm-light \{/);
});

test('Simple CSS hides what the spec lists and keeps tap targets at 44px or more', () => {
  const css = simpleCss();
  for (const sel of ['.tsn', '.frow', '.rsn', '#chat-workers-btn', '#chat-model-pick', '#chat-effort-wrap', '#chat-plan', '#chat-ctx', '#menu', '#tabbar', '.group-title', '.auto-card', '#voice-strip', '#cp-levels']) {
    assert.ok(css.includes('html.mm-simple ' + sel), sel);
  }
  assert.match(css, /font: 18px\/1\.55/);
  for (const [sel, min] of [['#simple-effort-btn', 44], ['#simple-call-btn', 44], ['#send-btn', 44], ['#plus-btn', 44], ['.se-starter', 44], ['.question button.opt', 44], ['.file-card .fc-download', 44], ['.sa-row', 44], ['.ss-row', 44], ['.ss-close', 44], ['.ss-seg button', 44], ['.st-pill', 44]]) {
    const re = new RegExp('html\\.mm-simple ' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{[^}]*?(?:min-height|height): (\\d+)px');
    const m = re.exec(css);
    assert.ok(m && Number(m[1]) >= min, sel + ' >= ' + min);
  }
});

// ── behaviour of the helpers ───────────────────────────────────────────────
function sandbox(extra = {}) {
  const store = new Map();
  const win = { hubSimple, localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) } };
  const classes = new Set(['mm-simple']);
  const ctx = {
    window: win,
    document: { documentElement: { classList: { contains: c => classes.has(c) } }, getElementById: () => null },
    agentByName: n => (ctx.agents || []).find(a => a.name === n) || null,
    effortSupported: m => /^claude-sdk\//.test(String(m)),
    agents: [], ...extra,
  };
  vm.createContext(ctx);
  vm.runInContext(block + '\nthis.__h = { simpleOn, simpleThinkModel, simpleAutoOf, simpleStartAgent, simpleInitial, simpleChatExtra, simpleEffortOk };', ctx);
  return { ctx, h: ctx.__h, classes, store };
}

test('simpleThinkModel: the last five reasoning lines and the consult line', () => {
  const { h } = sandbox();
  const text = ['one', 'two', '', 'three', 'four', 'five', 'six', '**Heading** here'].join('\n');
  const m = h.simpleThinkModel(text, 'Asking Agent A…');
  assert.deepStrictEqual(Array.from(m.lines), ['three', 'four', 'five', 'six', 'Heading here']);
  assert.strictEqual(m.consult, 'Asking Agent A…');
  assert.deepStrictEqual(Array.from(h.simpleThinkModel('', null).lines), []);
  assert.strictEqual(h.simpleThinkModel('x').consult, null);
});

test('simpleAutoOf: label, hide, or null for an ordinary message', () => {
  const { h } = sandbox();
  assert.deepStrictEqual({ ...h.simpleAutoOf('[Scheduled task] water the plants') }, { label: 'Reminder' });
  assert.deepStrictEqual({ ...h.simpleAutoOf('[Job finished] export') }, { label: 'Background job finished' });
  assert.deepStrictEqual({ ...h.simpleAutoOf('[Resumed after compression] x') }, { hide: true, label: '' });
  assert.strictEqual(h.simpleAutoOf('Hello there'), null);
  assert.strictEqual(h.simpleAutoOf(undefined), null);
});

test('simpleStartAgent: last chat if it exists, else the lead, else the first', () => {
  const { h } = sandbox();
  const l = [{ name: 'agent-a' }, { name: 'agent-b', lead: true }, { name: 'agent-c' }];
  assert.strictEqual(h.simpleStartAgent(l, 'agent-c'), 'agent-c');
  assert.strictEqual(h.simpleStartAgent(l, 'gone'), 'agent-b');
  assert.strictEqual(h.simpleStartAgent([{ name: 'agent-a' }], null), 'agent-a');
  assert.strictEqual(h.simpleStartAgent([], 'x'), null);
  assert.strictEqual(h.simpleStartAgent(undefined, null), null);
});

test('simpleInitial: the first letter of the name, else of the login', () => {
  const { h } = sandbox();
  assert.strictEqual(h.simpleInitial({ user: { name: 'sam lee', login: 'sam' } }), 'S');
  assert.strictEqual(h.simpleInitial({ user: { login: 'robin' } }), 'R');
  assert.strictEqual(h.simpleInitial(null), '?');
});

test('simpleChatExtra: effort only in Simple, only for a model where it does something', () => {
  const { ctx, h, classes } = sandbox();
  ctx.agents = [{ name: 'agent-a', model: 'claude-sdk/x' }, { name: 'agent-b', model: 'local/y' }, { name: 'agent-c', model: 'claude-sdk/x', autoModel: true }];
  global.window = ctx.window;   // lib/ui-simple.js reads the page's localStorage through window, as in the browser
  try {
    assert.deepStrictEqual({ ...h.simpleChatExtra('agent-a') }, { effort: 'medium' });   // the default level
    assert.strictEqual(hubSimple.setEffort('agent-a', 'high', ctx.window.localStorage), true);
    assert.deepStrictEqual({ ...h.simpleChatExtra('agent-a') }, { effort: 'high' });
  } finally { delete global.window; }
  assert.deepStrictEqual({ ...h.simpleChatExtra('agent-b') }, {});   // effort does nothing for this model
  assert.deepStrictEqual({ ...h.simpleChatExtra('agent-c') }, {});   // Auto model
  assert.deepStrictEqual({ ...h.simpleChatExtra('nobody') }, {});
  classes.delete('mm-simple');   // Advanced: nothing added to the body
  assert.deepStrictEqual({ ...h.simpleChatExtra('agent-a') }, {});
  assert.strictEqual(h.simpleOn(), false);
});

test('Advanced is untouched: without mm-simple, or without hubSimple, the gate is closed', () => {
  const { h, classes } = sandbox();
  classes.delete('mm-simple');
  assert.strictEqual(h.simpleOn(), false);
  const none = sandbox({ window: {} });
  assert.strictEqual(none.h.simpleOn(), false);
});
