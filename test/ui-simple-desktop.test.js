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
  assert.match(app, /\.\.\.\(simpleOn\(\) \? simpleEffortBody\(window\.hubSimple, chat\.agent\) : \{\}\)/);   // effort in the chat POST body, Simple only
  assert.match(app, /if \(delta\) \{\n\s+if \(simpleOn\(\)\) simpleFirstReply\(chatId, msgId\);/);   // first reply text
  assert.match(app, /simpleThinkPaint\(msgId, st\);/);   // paintReasoning
  assert.match(app, /function handleWorkerEvent\(chatId, oc\) \{\n\s+simpleConsultNote\(chatId, oc\);/);   // consult line
  assert.match(app, /await streamResponseSolo\(response, msgId, chatId, chat\.agent\);\n\s+simpleThinkClear\(chatId\);/);   // turn end
  assert.match(app, /notify\(err\);[^\n]*\n\s+simpleThinkClear\(chatId\);/);   // error / stop
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

test('simpleEffortBody: the chat POST carries the level of that agent', () => {
  const store = {};
  const hs = { effortFor: (a) => store[a] || 'medium' };
  store['agent-a'] = 'max';
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.simpleEffortBody(hs, 'agent-a'))), { effort: 'max' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.simpleEffortBody(hs, 'agent-b'))), { effort: 'medium' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.simpleEffortBody(null, 'agent-a'))), {});
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
