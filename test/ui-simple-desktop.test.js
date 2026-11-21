// Simple mode, desktop page (index.html + app.js): the new code is present, gated by mm-simple / hubSimple, and the
// pure helpers behave. Source-text checks like the other test/ui-*.test.js files; reads no hub data.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const hubSimple = require(path.join(ROOT, 'lib', 'ui-simple.js'));

const cssBlock = (() => {
  const a = html.indexOf('<style id="simple-mode-css">');
  assert.ok(a > 0, 'the Simple style block exists');
  return html.slice(a, html.indexOf('</style>', a));
})();

test('index.html: the helper script loads before app.js, after the other ui scripts', () => {
  const s = html.indexOf('<script src="/ui-simple.js"></script>');
  assert.ok(s > 0);
  assert.ok(s > html.indexOf('<script src="/ui-file-card.js"></script>'));
  assert.ok(s < html.indexOf('<script src="app.js"></script>'));
});

test('index.html: ONE Simple style block, after the existing styles, every rule under html.mm-simple', () => {
  assert.strictEqual((html.match(/id="simple-mode-css"/g) || []).length, 1);
  assert.ok(html.indexOf('simple-mode-css') > html.indexOf('#st-share-block .sec-msg'), 'after the existing styles');
  const body = cssBlock.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^<style[^>]*>/, '');
  // selectors = text before each "{" at depth 0 (and inside @media); every comma part must start with html.mm-simple
  const sels = [];
  let depth = 0, cur = '';
  for (const ch of body) {
    if (ch === '{') { if (!/^\s*@(media|keyframes)/.test(cur) && depth <= 1) sels.push(cur); depth++; cur = ''; }
    else if (ch === '}') { depth--; cur = ''; }
    else cur += ch;
  }
  const bad = [];
  for (const sel of sels) for (const part of sel.split(',')) { const p = part.trim(); if (p && !p.startsWith('html.mm-simple') && !/^(from|to|\d+%|0%, 100%|50%)/.test(p)) bad.push(p); }
  assert.deepStrictEqual(bad, [], 'selectors outside html.mm-simple: ' + bad.slice(0, 5).join(' | '));
});

test('index.html: Simple hides what the spec lists, and has the light theme', () => {
  for (const sel of ['#hub-version', '#plan-warn', '#credit-meter', '#spend-today', '.tool-stream', '.reason-stream', '#worker-tabs', '.main-header',
    '.sidebar .tabs', '#group-chat-panel', '#guide-panel', '.group-action-btn', '.agent-group-title', '.live-activity', '.context-info-box', '[id^="panel-worker-"]', '.compaction-line'])
    assert.ok(cssBlock.includes(sel), 'hidden: ' + sel);
  assert.match(cssBlock, /display: none !important/);
  assert.match(cssBlock, /html\.mm-simple\.mm-light \{/);
  for (const el of ['.question-modal', '.file-card', '.voice-callbar', '#hub-toast', '.simple-modal', '.input-area', '.message.user', '.sidebar'])
    assert.ok(cssBlock.includes(el), 'styled: ' + el);
  assert.match(cssBlock, /--sm-page: #ffffff; --sm-side: #f6f6f3/);   // the light page and side colours of the spec
});

test('app.js: loadMe calls hubSimple.apply with the person, guarded', () => {
  assert.match(app, /window\.hubMe = await r\.json\(\);\n\s+try \{ if \(window\.hubSimple\) \{ window\.hubSimple\.apply\(window\.hubMe\); simpleBoot\(\); \} \}/);
});

test('app.js: every Simple entry point is gated by simpleOn (mm-simple + hubSimple)', () => {
  assert.match(app, /function simpleOn\(\) \{ return !!\(window\.hubSimple && document\.documentElement\.classList\.contains\('mm-simple'\)\); \}/);
  for (const fn of ['simpleThinkClear', 'simpleFirstReply', 'simpleThinkPaint', 'simpleConsultNote', 'simpleLvlRefresh', 'simpleComposerInit', 'simpleScan', 'simpleBoot']) {
    const i = app.indexOf('function ' + fn + '(');
    assert.ok(i > 0, fn + ' exists');
    assert.match(app.slice(i, i + 260), /simpleOn\(\)/, fn + ' is gated');
  }
});

test('app.js: hook points are in place', () => {
  assert.match(app, /\.\.\.\(typeof simpleOn === 'function' && simpleOn\(\) \? simpleEffortBody\(window\.hubSimple, chat\.agent, effortSupported\(chatModelOf\(chat\)\) && !chat\.autoModel\) : \{\}\)/);   // effort in the chat POST body, Simple only, only when the level button is shown
  assert.match(app, /if \(delta\) \{\n\s+if \(typeof simpleOn === 'function' && simpleOn\(\)\) simpleFirstReply\(chatId, msgId\);/);   // first reply text
  assert.match(app, /simpleThinkPaint\(msgId, st\);/);   // paintReasoning
  assert.match(app, /function handleWorkerEvent\(chatId, oc\) \{\n\s+if \(typeof simpleConsultNote === 'function'\) simpleConsultNote\(chatId, oc\);/);   // consult line
  assert.match(app, /await streamResponseSolo\(response, msgId, chatId, chat\.agent\);\n\s+if \(typeof simpleThinkClear === 'function'\) simpleThinkClear\(chatId\);/);   // turn end
  assert.match(app, /notify\(err\);[^\n]*\n\s+if \(typeof simpleThinkClear === 'function'\) simpleThinkClear\(chatId\);/);   // error / stop
  assert.match(app, /simpleComposerInit\(chatId\);/);   // composer button
  assert.match(app, /simpleSwitchMode\('simple'\)/);   // Advanced settings: Switch to Simple
  assert.match(app, /simplePrefs\(\{ uiMode: mode \}\)/);
  assert.match(app, /simplePrefs\(\{ theme: t\.dataset\.theme \}\)/);
  assert.match(app, /data-act="advanced"/);
  assert.match(app, /else if \(a\.dataset\.act === 'signout'\) signOut\(\);/);
});

test('app.js: the existing lines next to the hooks are unchanged and no helper block was edited', () => {
  for (const line of [
    "const r = await fetch('/api/me', { credentials: 'include' });",
    "if (window.hubMe && window.hubMe.user) setTimeout(() => { try { voiceRecResendPending(",
    "const response = await fetch('/api/chat/stream', {",
    "...(chat.voiceSend ? { voice: true } : {}),",
    "const delta = parsed.choices?.[0]?.delta?.content;",
    "if (rsnFullFor === msgId) paintReasoningFull();",
    "function finishReasoning(msgId) {",
    "function appendReasoning(msgId, chatId, ev) {",
    "if (oc && oc.worker_id != null && /^worker_(started|text_delta|tool_start|tool_use|tool_result)$/.test(oc.type)) reopenEndedWorkerRun(oc.worker_id);",
    "function foldAutoOn() { try { return localStorage.getItem('hub-fold-auto') !== 'off'; } catch { return true; } }"])
    assert.ok(app.includes(line), 'still there: ' + line.slice(0, 60));
  // no new code between a (begin) and its (end) marker
  const re = /\/\/ ── ([\w -]+) helpers \(begin\) ──([\s\S]*?)\/\/ ── \1 helpers \(end\) ──/g;
  let m, n = 0;
  while ((m = re.exec(app))) { n++; assert.ok(!/simple(On|Boot|Think|Scan|Consult)/.test(m[2]), 'Simple code inside the ' + m[1] + ' block'); }
  assert.ok(n > 5);
});

// ── the pure helpers, run for real ──
const helperSrc = (() => {
  const a = app.indexOf('    // Pure helpers (tested in test/ui-simple-desktop.test.js)');
  const b = app.indexOf('    // The reasoning box:', a);
  assert.ok(a > 0 && b > a);
  return app.slice(a, b);
})();
const sandbox = vm.createContext({ window: { hubSimple } });
vm.runInContext(helperSrc + '\nthis.simpleInitialOf = simpleInitialOf; this.simpleTailText = simpleTailText; this.simpleNoteState = simpleNoteState; this.simpleEffortBody = simpleEffortBody;', sandbox);

test('simpleInitialOf: the avatar letter', () => {
  assert.strictEqual(sandbox.simpleInitialOf('sam'), 'S');
  assert.strictEqual(sandbox.simpleInitialOf('  robin lee'), 'R');
  assert.strictEqual(sandbox.simpleInitialOf(''), '?');
  assert.strictEqual(sandbox.simpleInitialOf(null), '?');
});

test('simpleTailText: the last lines of the reasoning, as text', () => {
  const text = 'one\ntwo\n\nthree\nfour\nfive\nsix\nseven';
  assert.strictEqual(sandbox.simpleTailText(hubSimple, text, 5), 'three\nfour\nfive\nsix\nseven');
  assert.strictEqual(sandbox.simpleTailText(hubSimple, 'a\nb', 5), 'a\nb');
  assert.strictEqual(sandbox.simpleTailText(hubSimple, '', 5), '');
  assert.strictEqual(sandbox.simpleTailText(null, 'x', 5), '');   // no helper: nothing, no throw
  assert.strictEqual(sandbox.simpleTailText({ reasoningTail: () => 'already text' }, 'x'), 'already text');
});

test('simpleNoteState: hub-started prompts become a label, a hidden line, or stay plain', () => {
  assert.strictEqual(sandbox.simpleNoteState(hubSimple, 'What is the weather?'), 'none');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.simpleNoteState(hubSimple, '[Scheduled task] water the plants'))), { label: 'Reminder' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.simpleNoteState(hubSimple, '[Job finished] build'))), { label: 'Background job finished' });
  assert.strictEqual(sandbox.simpleNoteState(hubSimple, '[Resumed after compression] ...'), 'hide');
  assert.strictEqual(sandbox.simpleNoteState(null, 'x'), 'none');
  assert.strictEqual(sandbox.simpleNoteState({ autoNote: () => ({ label: null }) }, 'x'), 'hide');
});

test('simpleEffortBody: sent only for a level the person picked, and only when the button is shown', () => {
  const store = {};
  const hs = { pickedEffort: (a) => store[a] || null };
  store['agent-a'] = 'max';
  const j = (x) => JSON.parse(JSON.stringify(x));
  assert.deepStrictEqual(j(sandbox.simpleEffortBody(hs, 'agent-a', true)), { simple: true, effort: 'max' });
  assert.deepStrictEqual(j(sandbox.simpleEffortBody(hs, 'agent-b', true)), { simple: true });   // never picked: the agent's own setting applies
  assert.deepStrictEqual(j(sandbox.simpleEffortBody(hs, 'agent-a', false)), { simple: true });   // no button (model without effort, or Auto model): nothing
  assert.deepStrictEqual(j(sandbox.simpleEffortBody(null, 'agent-a', true)), { simple: true });
  // with the real helper and a real storage
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
  const real = { pickedEffort: (a) => hubSimple.pickedEffort(a, storage) };
  assert.deepStrictEqual(j(sandbox.simpleEffortBody(real, 'agent-a', true)), { simple: true });
  hubSimple.setEffort('agent-a', 'high', storage);
  assert.deepStrictEqual(j(sandbox.simpleEffortBody(real, 'agent-a', true)), { simple: true, effort: 'high' });
});

test('simpleEffortLabel: the pick, else the agent\'s own effort in plain words', () => {
  const store = { 'agent-a': 'low' };
  const hs = Object.assign({}, hubSimple, { pickedEffort: (a) => store[a] || null });
  assert.strictEqual(sandbox.simpleEffortLabel(hs, 'agent-a', 'max'), 'Quick');
  assert.strictEqual(sandbox.simpleEffortLabel(hs, 'agent-b', 'max'), 'Deepest');
  assert.strictEqual(sandbox.simpleEffortLabel(hs, 'agent-b', 'xhigh'), 'Thorough');
  assert.strictEqual(sandbox.simpleEffortLabel(hs, 'agent-b', 'default'), 'Balanced');
  assert.strictEqual(sandbox.simpleEffortLabel(hs, 'agent-b', undefined), 'Balanced');
});

test('simpleAccountOk: no Switch to Simple without a real account (legacy single password, accounts off)', () => {
  assert.strictEqual(sandbox.simpleAccountOk({ user: { id: 'u1' } }), true);
  assert.strictEqual(sandbox.simpleAccountOk({ user: { id: 'legacy' } }), false);
  assert.strictEqual(sandbox.simpleAccountOk({}), false);
  assert.strictEqual(sandbox.simpleAccountOk(null), false);
  assert.match(app, /\$\{simpleAccountOk\(window\.hubMe\) \? `<div class="st-row"><button type="button" id="st-switch-simple"/);
});

test('Simple hides the old "Thinking..." placeholder (the box replaces it)', () => {
  assert.match(app, /=== '⏳ Thinking\.\.\.';\n\s+if \(wait !== el\.classList\.contains\('simple-wait'\)\)/);
  assert.match(cssBlock, /html\.mm-simple \.message\.simple-wait \{ display: none; \}/);
});

// ── the Thinking box: reasoning lines before the first reply text, consults by worker id, run on a tiny fake DOM ──
const boxSrc = (() => {
  const a = app.indexOf('    // The reasoning box:');
  const b = app.indexOf('    // The reasoning level in the composer');
  assert.ok(a > 0 && b > a);
  return app.slice(a, b);
})();
function boxWorld() {
  const els = {};
  const mk = (id) => {
    const root = { id, kids: [], parentNode: null };
    root.appendChild = (n) => { n.parentNode = root; root.kids.push(n); };
    root.insertBefore = (n, ref) => { n.parentNode = root; const i = root.kids.indexOf(ref); root.kids.splice(i < 0 ? root.kids.length : i, 0, n); };
    root.querySelector = (sel) => root.kids.find((k) => k.className === 'simple-think') || null;
    root.querySelectorAll = (sel) => root.kids.filter((k) => k.className === 'simple-think');
    Object.defineProperty(root, 'lastElementChild', { get: () => root.kids[root.kids.length - 1] || null });
    els[id] = root;
    return root;
  };
  const doc = {
    getElementById: (id) => els[id] || null,
    createElement: () => {
      const box = { className: '', classList: { contains: () => false }, parentNode: null, parts: { '.st-body': { textContent: '' }, '.st-consult': { textContent: '' } } };
      box.querySelector = (sel) => box.parts[sel];
      box.remove = () => { if (box.parentNode) { const k = box.parentNode.kids; k.splice(k.indexOf(box), 1); box.parentNode = null; } };
      return box;
    },
  };
  const room = mk('messages-c1');
  const host = { id: 'msg-1', classList: { contains: () => false }, closest: () => room, parentElement: room, parentNode: null };
  room.appendChild(host); els['msg-1'] = host;
  const ctx = vm.createContext({ window: { hubSimple }, document: doc, simpleOn: () => true });
  vm.runInContext(helperSrc + '\n' + boxSrc + '\nthis.__api = { simpleThinkPaint, simpleFirstReply, simpleConsultNote, simpleThinkClear };', ctx);
  const api = ctx.__api;
  const box = () => room.kids.find((k) => k.className === 'simple-think') || null;
  const body = () => (box() ? box().parts['.st-body'].textContent : null);
  const consult = () => (box() ? box().parts['.st-consult'].textContent : null);
  return { api, room, host, box, body, consult };
}
const startEvt = (id, name) => ({ type: 'worker_started', worker_id: id, agent_type: 'agent-' + name, description: 'Worker: Agent ' + name });

test('the Thinking box: reasoning shows before the first reply text, never again for that reply', () => {
  const w = boxWorld();
  w.api.simpleThinkPaint('msg-1', { live: true, text: 'one\ntwo' });
  assert.strictEqual(w.body(), 'one\ntwo');
  w.api.simpleFirstReply('c1', 'msg-1');
  assert.strictEqual(w.box(), null, 'gone at the first reply text');
  w.api.simpleThinkPaint('msg-1', { live: true, text: 'late reasoning' });
  assert.strictEqual(w.box(), null, 'reasoning of that reply never shows again');
  w.api.simpleConsultNote('c1', startEvt('w1', 'Health Helper'));
  assert.strictEqual(w.box() !== null, true, 'a consult that starts after the reply text shows the box');
  assert.strictEqual(w.body(), '', 'with the consult line only');
  assert.strictEqual(w.consult(), 'Asking Health Helper…');
});

test('the Thinking box: consults are a map by worker_id; a completed one does not clear another', () => {
  const w = boxWorld();
  w.api.simpleConsultNote('c1', startEvt('w1', 'Health Helper'));
  w.api.simpleConsultNote('c1', startEvt('w2', 'Travel Helper'));
  assert.strictEqual(w.consult(), 'Asking Travel Helper… and 1 more');   // the most recent, one line
  w.api.simpleConsultNote('c1', { type: 'worker_completed', worker_id: 'w2' });
  assert.strictEqual(w.consult(), 'Asking Health Helper…', 'the other consult still runs');
  w.api.simpleConsultNote('c1', { type: 'worker_completed', worker_id: 'nobody' });
  assert.strictEqual(w.consult(), 'Asking Health Helper…', 'an unknown id changes nothing');
  w.api.simpleThinkPaint('msg-1', { live: true, text: 'thinking about it' });
  assert.strictEqual(w.body(), 'thinking about it');
  assert.strictEqual(w.consult(), 'Asking Health Helper…');
  w.api.simpleConsultNote('c1', { type: 'worker_failed', worker_id: 'w1' });
  assert.strictEqual(w.consult(), '');
  assert.strictEqual(w.box() !== null, true, 'reasoning lines keep it up');
  w.api.simpleFirstReply('c1', 'msg-1');
  assert.strictEqual(w.box(), null, 'no reasoning and no consult: gone');
});

test('the Thinking box: turn end, error and stop clear everything (consults too)', () => {
  const w = boxWorld();
  w.api.simpleThinkPaint('msg-1', { live: true, text: 'a' });
  w.api.simpleConsultNote('c1', startEvt('w1', 'Health Helper'));
  w.api.simpleThinkClear('c1');
  assert.strictEqual(w.box(), null);
  w.api.simpleThinkPaint('msg-1', { live: false, text: 'history' });
  assert.strictEqual(w.box(), null, 'a history reload never shows reasoning');
  w.api.simpleConsultNote('c1', { type: 'worker_completed', worker_id: 'w1' });
  assert.strictEqual(w.box(), null, 'a late completion does not bring anything back');
});

// ── hub-started turns in Simple; the reasoning level refreshes at the moments that matter ──
const bootSrc = (() => {
  const a = app.indexOf('      // Simple shows hub-started turns as short ordinary messages');
  const b = app.indexOf('      // Open the first agent so there is always a chat', a);
  assert.ok(a > 0 && b > a);
  return app.slice(a, b);
})();
function bootRun() {
  let on = true;
  const refreshed = [];
  const ctx = vm.createContext({
    simpleOn: () => on, simpleLvlRefresh: (id) => refreshed.push(id), chats: { c1: {}, c2: {} },
    chatViewGet: (st) => (st && st.v === 'all' ? 'all' : 'main'),
    refreshEffortPick: function () { return 'picked'; }, switchToChat: function () { return 'switched'; }, loadAgents: async function () { return 'loaded'; },
  });
  vm.runInContext(bootSrc, ctx);
  return { ctx, refreshed, off: () => { on = false; } };
}
test('Simple reads the chat view as "all" and writes nothing; Advanced keeps the stored choice', () => {
  const st = { v: 'main', setItem() { throw new Error('written'); } };
  const { ctx, off } = bootRun();
  assert.strictEqual(ctx.chatViewGet(st), 'all');
  off();
  assert.strictEqual(ctx.chatViewGet(st), 'main');
  assert.strictEqual(ctx.chatViewGet({ v: 'all' }), 'all');
});
test('the reasoning level refreshes on chat open, model pick change and agent list reload, with no poll', async () => {
  assert.ok(!/setInterval\(\(\) => \{ for \(const id of Object\.keys\(chats\)\) simpleLvlRefresh/.test(app));
  const { ctx, refreshed } = bootRun();
  assert.strictEqual(ctx.switchToChat('c1'), 'switched');
  assert.deepStrictEqual(refreshed, ['c1']);
  assert.strictEqual(ctx.refreshEffortPick({ id: 'c2' }), 'picked');   // the page calls it after a model change
  assert.deepStrictEqual(refreshed, ['c1', 'c2']);
  refreshed.length = 0;
  assert.strictEqual(await ctx.loadAgents(), 'loaded');
  assert.deepStrictEqual(refreshed.sort(), ['c1', 'c2']);
});
test('the chat-view switch is hidden in Simple', () => {
  assert.match(cssBlock, /html\.mm-simple \.chat-view-btn/);
});

test('r3: the "⏳ Thinking..." placeholder is found by its own text, not the play/copy glyphs, and hidden only in Simple', () => {
  const i = app.indexOf("panels.querySelectorAll('.message.assistant').forEach");
  assert.ok(i > 0);
  const seg = app.slice(i, i + 900);
  assert.match(seg, /msg-copy/); assert.match(seg, /msg-speak/); assert.match(seg, /msg-time/);   // those children are left out of the text
  assert.match(seg, /own\.trim\(\) === '⏳ Thinking\.\.\.'/);
  assert.match(seg, /classList\.toggle\('simple-wait', wait\)/);   // removed again when the real reply replaces it
  const fn = app.lastIndexOf('function simpleScan()', i);
  assert.ok(fn > 0 && /if \(!simpleOn\(\)\) return;/.test(app.slice(fn, i)));
  assert.match(cssBlock, /html\.mm-simple \.message\.simple-wait \{ display: none; \}/);
});

test('r3: the play and copy buttons sit below a reply / beside a user bubble in Simple, never on the text', () => {
  assert.match(cssBlock, /html\.mm-simple \.message > \.msg-copy, html\.mm-simple \.message > \.msg-speak \{[^}]*top: 100%[^}]*left: 0[^}]*opacity: 0/);
  assert.match(cssBlock, /html\.mm-simple \.message\.user > \.msg-copy \{[^}]*right: calc\(100% \+ 4px\)/);
  assert.match(cssBlock, /html\.mm-simple \.message:hover > \.msg-copy/);
  assert.match(cssBlock, /@media \(hover: none\) \{ html\.mm-simple \.message\.assistant > \.msg-copy/);
  assert.match(html, /\.message > \.msg-copy \{\s*\n?\s*position: absolute; top: 4px; right: 6px;/);   // Advanced rule unchanged
});

test('r3: while a turn runs, Interject and Cancel use the Simple colours (accent / neutral), both themes via variables', () => {
  assert.match(cssBlock, /html\.mm-simple \.input-area \[id\^="send-"\]\[style\*="--warning"\] \{ background: #8b6fd6 !important; color: #fff !important; \}/);
  assert.match(cssBlock, /html\.mm-simple \.chat-actions \[id\^="cancel-"\] \{ background: var\(--sm-raised\) !important; color: var\(--sm-sec\) !important; border: 1px solid var\(--sm-border\) !important/);
  assert.match(app, /sendBtn\.style\.background = 'var\(--warning\)'/);   // the page's inline orange is what the selector matches
});
