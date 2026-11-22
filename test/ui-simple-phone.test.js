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
  // menu split (gear = what you set, ⋯ = what you do): the Look row is in the This device group, so Switch to Simple stays near the top (first item) and Look's picker is followed by the device items
  assert.match(html, /<div id="menu-2fa-note" hidden>[^\n]*<\/div>\n    <button id="menu-simple">Switch to Simple<\/button>\n/);
  assert.match(html, /<div id="menu-look-pick" hidden><\/div>\n      <button id="menu-notify">[^\n]*<\/button>\n      <button id="menu-notify-test" hidden>[^\n]*<\/button>\n      <button id="menu-fold" class="chat-only">[^\n]*<\/button>\n      <button id="menu-active-top">/);
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
  vm.runInContext(block + '\nthis.__h = { simpleOn, simpleThinkModel, simpleAutoOf, simpleStartAgent, simpleInitial, simpleChatExtra, simpleEffortOk, simpleThinkPaint, simpleThinkEnd, simpleTurnOver, simpleConsultSet, simpleConsultText, simpleEffortLabelOf, simpleAccountOk, simpleMenuHide, simpleCallPaint };', ctx);
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
    assert.deepStrictEqual({ ...h.simpleChatExtra('agent-a') }, { simple: true });   // never picked: the agent's own setting applies, nothing is sent
    assert.strictEqual(hubSimple.setEffort('agent-a', 'high', ctx.window.localStorage), true);
    assert.deepStrictEqual({ ...h.simpleChatExtra('agent-a') }, { simple: true, effort: 'high' });
  } finally { delete global.window; }
  assert.deepStrictEqual({ ...h.simpleChatExtra('agent-b') }, { simple: true });   // effort does nothing for this model
  assert.deepStrictEqual({ ...h.simpleChatExtra('agent-c') }, { simple: true });   // Auto model
  assert.deepStrictEqual({ ...h.simpleChatExtra('nobody') }, { simple: true });
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

// ── hub-started turns, one mic and one call button ──
test('Simple reads the chat view as "all" without writing localStorage; Advanced keeps the stored choice', () => {
  const chatViewGet = (st) => (st && st.getItem('hub-chat-view') === 'all' ? 'all' : 'main');
  const { ctx, classes, store } = sandbox({ chatViewGet });
  assert.strictEqual(ctx.chatViewGet(ctx.window.localStorage), 'all');
  assert.strictEqual(store.size, 0, 'nothing was written');
  classes.delete('mm-simple');
  assert.strictEqual(ctx.chatViewGet(ctx.window.localStorage), 'main');
  store.set('hub-chat-view', 'all');
  assert.strictEqual(ctx.chatViewGet(ctx.window.localStorage), 'all');
});

test('Simple hides the page\'s "⚡ Scheduled task" note, Advanced keeps it', () => {
  const mk = (text) => { const set = new Set(); return { text, set, classList: { add: (c) => set.add(c) } }; };
  const { ctx, classes } = sandbox({ addNote: mk });
  assert.ok(ctx.addNote('⚡ Scheduled task: water the plants — 9:00').set.has('simple-auto-hide'));
  assert.ok(ctx.addNote('⚡ Job finished — 9:01').set.has('simple-auto-hide'));
  assert.ok(!ctx.addNote('⚡ sent from another device — 9:02').set.has('simple-auto-hide'));
  assert.ok(!ctx.addNote('No messages yet').set.has('simple-auto-hide'));
  classes.delete('mm-simple');
  assert.ok(!ctx.addNote('⚡ Scheduled task: x — 9:00').set.has('simple-auto-hide'));
});

test('Simple: #mic-btn always dictates (never starts a call), the call button is the only call button', () => {
  const seen = [];
  const voicePrefsNow = () => ({ mode: 'handsfree', micLevel: 50 });
  let ctx;   // the page's functions call each other through the global binding, which the Simple block replaced
  const voiceMicTap = () => { seen.push(['tap', ctx.voicePrefsNow().mode]); };
  const voiceMicPaint = () => { seen.push(['paint', ctx.voicePrefsNow().mode]); };
  const sb = sandbox({ voicePrefsNow, voiceMicTap, voiceMicPaint });
  ctx = sb.ctx; const classes = sb.classes;
  ctx.voiceMicTap(); ctx.voiceMicPaint();
  assert.deepStrictEqual(seen, [['tap', 'tap'], ['paint', 'tap']]);
  assert.strictEqual(ctx.voicePrefsNow().mode, 'handsfree', 'the call itself still reads the real mode');
  seen.length = 0;
  classes.delete('mm-simple');   // Advanced
  ctx.voiceMicTap(); ctx.voiceMicPaint();
  assert.deepStrictEqual(seen, [['tap', 'handsfree'], ['paint', 'handsfree']]);
  const css = /<style id="simple-css">([\s\S]*?)<\/style>/.exec(html)[1];
  assert.match(css, /html\.mm-simple #mic-btn\.call \{ display: none; \}/);   // during a call only #simple-call-btn is left
  assert.match(css, /html\.mm-simple #simple-call-btn \{ order: 5; display: grid/);
});

// ── Thinking box: reasoning before the first reply text; consults by worker id; call button; account gate ──
function fakeHolder() {
  const kids = [];
  const mkBox = () => {
    const parts = { '.st-lab': {}, '.st-lines': { dataset: {}, hidden: false, textContent: '', appendChild() {} }, '.st-consult': { textContent: '', hidden: true } };
    const b = { className: '', innerHTML: '', setAttribute() {}, querySelector: (sel) => parts[sel], remove() { const i = kids.indexOf(b); if (i >= 0) kids.splice(i, 1); }, parts };
    return b;
  };
  const el = { isConnected: true, querySelector: () => kids[0] || null, insertBefore: (n) => { kids.unshift(n); }, firstChild: null };
  const doc = { documentElement: { classList: { contains: () => true } }, getElementById: () => null, createElement: () => (kids.__make = mkBox()) };
  return { holder: { agent: 'agent-a', bubble: { el } }, kids, doc };
}
function thinkWorld() {
  const f = fakeHolder();
  const w = sandbox({ current: 'agent-b', scrollChat() {} });
  w.ctx.document.createElement = f.doc.createElement;
  const origIns = f.holder.bubble.el.insertBefore;
  f.holder.bubble.el.insertBefore = (n) => { f.kids.unshift(f.kids.__make); };
  w.f = f;
  w.box = () => f.kids[0] || null;
  return w;
}
test('simple think: after the first reply text a consult still shows (alone), reasoning never again', () => {
  const w = thinkWorld(); const { h, f } = w; const hd = f.holder;
  hd.rsn = { live: true, text: 'a\nb' };
  h.simpleThinkPaint(hd);
  assert.ok(w.box(), 'box while reasoning');
  h.simpleThinkEnd(hd, true);   // the first reply text
  assert.strictEqual(w.box(), null);
  hd.rsn = { live: true, text: 'late' };
  h.simpleThinkPaint(hd);
  assert.strictEqual(w.box(), null, 'reasoning never shows again for that reply');
  h.simpleConsultSet(hd, 'Asking Health Helper…', 'w1');
  assert.ok(w.box(), 'a consult that starts after intro text shows');
  assert.strictEqual(w.box().parts['.st-consult'].textContent, 'Asking Health Helper…');
  assert.strictEqual(w.box().parts['.st-lines'].textContent, '', 'no reasoning lines');
  h.simpleConsultSet(hd, null, 'w1');
  assert.strictEqual(w.box(), null, 'consult over, box gone');
});
test('simple think: consults are a map by worker id; the turn end clears them', () => {
  const w = thinkWorld(); const { h, f } = w; const hd = f.holder;
  h.simpleConsultSet(hd, 'Asking Health Helper…', 'w1');
  h.simpleConsultSet(hd, 'Asking Travel Helper…', 'w2');
  assert.strictEqual(h.simpleConsultText(hd), 'Asking Travel Helper… and 1 more');
  h.simpleConsultSet(hd, null, 'w2');
  assert.strictEqual(h.simpleConsultText(hd), 'Asking Health Helper…');
  h.simpleConsultSet(hd, null, 'zzz');
  assert.strictEqual(h.simpleConsultText(hd), 'Asking Health Helper…');
  h.simpleTurnOver(hd);
  assert.strictEqual(w.box(), null);
  assert.strictEqual(h.simpleConsultText(hd), '');
  h.simpleConsultSet(hd, 'Asking X…', 'w9');
  assert.strictEqual(w.box(), null, 'nothing comes back after the turn');
});
test('simple think: wiring - turn end also calls simpleTurnOver', () => {
  assert.match(js, /simpleThinkEnd\(holder, true\);   \/\/ Simple: the turn is over, no Thinking box\n  if \(typeof simpleTurnOver === 'function'\) simpleTurnOver\(holder\);/);
});
test('effort: label is the pick, else the agent\'s own effort; nothing sent until picked', () => {
  const { ctx, h } = sandbox();
  ctx.agents = [{ name: 'agent-a', model: 'claude-sdk/x', effort: 'xhigh' }, { name: 'agent-b', model: 'claude-sdk/x' }];
  global.window = ctx.window;
  try {
    assert.strictEqual(h.simpleEffortLabelOf(ctx.agents[0]), 'Thorough');
    assert.strictEqual(h.simpleEffortLabelOf(ctx.agents[1]), 'Balanced');
    assert.deepStrictEqual({ ...h.simpleChatExtra('agent-a') }, { simple: true });
    hubSimple.setEffort('agent-a', 'low', ctx.window.localStorage);
    assert.strictEqual(h.simpleEffortLabelOf(ctx.agents[0]), 'Quick');
    assert.deepStrictEqual({ ...h.simpleChatExtra('agent-a') }, { simple: true, effort: 'low' });
  } finally { delete global.window; }
});
test('Switch to Simple is hidden without a real account', () => {
  const ms = { hidden: false };
  const w = sandbox({ hubMe: { user: { id: 'legacy' } } });
  w.ctx.document.getElementById = (id) => (id === 'menu-simple' ? ms : null);
  assert.strictEqual(w.h.simpleAccountOk({ user: { id: 'u1' } }), true);
  assert.strictEqual(w.h.simpleAccountOk({ user: { id: 'legacy' } }), false);
  assert.strictEqual(w.h.simpleAccountOk({}), false);
  w.h.simpleMenuHide(); assert.strictEqual(ms.hidden, true);
  assert.match(js, /simpleMenuHide\(\);   \/\/ "Switch to Simple" only for a real account/);
});
test('call and effort buttons use onComposerTap; the call button has an in-call state', () => {
  assert.match(js, /onComposerTap\(eb, \(\) => simpleEffortSheet\(sheet\.hidden\)\)/);
  assert.match(js, /onComposerTap\(cb, \(\) => \{ if \(typeof voiceCall/);
  assert.ok(!/eb\.addEventListener\('click'/.test(block) && !/cb\.addEventListener\('click'/.test(block));
  const cl = new Set(); const cb = { classList: { toggle: (c, on) => (on ? cl.add(c) : cl.delete(c)) }, setAttribute() {}, title: '' };
  const w = sandbox({ voiceCall: null });
  w.ctx.document.getElementById = (id) => (id === 'simple-call-btn' ? cb : null);
  w.h.simpleCallPaint(); assert.ok(!cl.has('in-call'));
  vm.runInContext('voiceCall = {};', w.ctx); w.h.simpleCallPaint(); assert.ok(cl.has('in-call'));
  const css = /<style id="simple-css">([\s\S]*?)<\/style>/.exec(html)[1];
  assert.match(css, /html\.mm-simple #simple-call-btn\.in-call \{/);
});

test('r3: Simple hides the running-turn status line and shows an interjection as an ordinary user bubble', () => {
  const css = /<style id="simple-css">([\s\S]*?)<\/style>/.exec(html)[1];
  assert.match(css, /html\.mm-simple \.reattach, html\.mm-simple \.ij-seg \.note\.interject \{ display: none !important; \}/);
  assert.match(css, /html\.mm-simple \.ij-seg \{[^}]*border: 0[^}]*background: var\(--sp-bubble\)/);
  assert.match(js, /className = 'reattach'/);   // the element the rule hides
  assert.match(js, /if \(ij && typeof simpleOn === 'function' && simpleOn\(\)\) \{ const ijNote = bubbleHost\(\)\.lastElementChild;[^}]*simple-auto-hide/);
  assert.match(html, /\.ij-seg \{ margin: 6px 0; padding: 6px 10px; border-left: 3px solid var\(--warning\)/);   // Advanced unchanged
});
