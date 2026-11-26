'use strict';
// Setup fixes r1: the ↻ arrow asks before dropping attached photos; the phone Build team span link is keyboard-reachable;
// the --vvh fallback; analyseSetup keeps belongs_to.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const js = read('mobile.js'), html = read('mobile.html');
const { createAppReloader } = require('../lib/ui-reload.js');

function reloadWorld({ images = [], preparing = 0, screen = 'chat' } = {}) {
  const ctx = { pendingImages: images.slice(), imagesPreparing: new Set(Array.from({ length: preparing }, (_, i) => i)), screen, current: 'bea', JSON, Promise, $: () => null, sessionStorage: { setItem() {} } };
  vm.createContext(ctx);
  const src = js.slice(js.indexOf('const RELOAD_STATE_KEY'), js.indexOf('function toggleMenu('));
  vm.runInContext(src + '\nthis.api = { reloadPhotoQuestions, setKeep(v) { reloadKeepChat = v; } };', ctx);
  return ctx;
}
// the page's own wiring, run for real: the questions callback is the one in reloadApp()
test('reloadApp asks the photo question through the reloader\'s questions list', () => {
  assert.match(js, /questions: \(\) => \[\.\.\.\(voiceCall \? \[APP_RELOAD_CALL_QUESTION\] : \[\]\), \.\.\.reloadPhotoQuestions\(\)\]/);
});
async function press(w, answers) {
  const asked = []; let reloads = 0;
  const r = createAppReloader({
    questions: () => w.api.reloadPhotoQuestions(),
    confirm: (q) => { asked.push(q); const a = answers.shift(); if (typeof a === 'function') a(); return a === undefined ? true : a !== false; },
    go: () => { reloads++; }, setTimer: () => {},
  });
  w.api.setKeep(true);
  r.reload();
  await new Promise((res) => setImmediate(res));
  return { asked, reloads };
}
test('↻ with attached photos asks "Reload and remove the attached photo(s)? The text stays." and Cancel does not reload', async () => {
  const w = reloadWorld({ images: ['data:image/jpeg;base64,x'] });
  const r = await press(w, [false]);
  assert.deepStrictEqual(r.asked, ['Reload and remove the attached photo(s)? The text stays.']);
  assert.strictEqual(r.reloads, 0);
  const ok = await press(reloadWorld({ images: ['x'] }), [true]);
  assert.strictEqual(ok.reloads, 1);
});
test('↻ with a photo still converting asks too; with none it reloads without a question', async () => {
  const c = await press(reloadWorld({ preparing: 1 }), [false]);
  assert.strictEqual(c.asked.length, 1); assert.strictEqual(c.reloads, 0);
  const none = await press(reloadWorld(), []);
  assert.deepStrictEqual(none.asked, []); assert.strictEqual(none.reloads, 1);
});
test('a photo added while the reload waited is asked about right before location.reload()', async () => {
  const w = reloadWorld();
  const asked = []; let reloads = 0;
  const r = createAppReloader({
    questions: () => w.api.reloadPhotoQuestions(),
    confirm: (q) => { asked.push(q); return false; },
    prepare: () => { w.pendingImages.push('data:image/jpeg;base64,y'); },
    go: () => { reloads++; }, setTimer: () => {},
  });
  w.api.setKeep(true);
  r.reload();
  await new Promise((res) => setImmediate(res));
  assert.strictEqual(asked.length, 1); assert.strictEqual(reloads, 0, 'Cancel at the second look: no reload');
});
test('the menu Reload (not an arrow) is not asked: the question is for the arrows only', () => {
  const w = reloadWorld({ images: ['x'] });
  assert.deepStrictEqual(Array.from(w.api.reloadPhotoQuestions()), []);
});

test('mobile.html: --vvh falls back to vh, and dvh only where it is supported', () => {
  assert.match(html, /html \{ --vvh: 100vh;/);
  assert.doesNotMatch(html, /html \{ --vvh: 100dvh;[^}]*--tm-bar/, 'the plain html block no longer declares dvh');
  assert.match(html, /@supports \(height: 100dvh\) \{ html \{ --vvh: 100dvh; \} \}/);
});

test('phone Build team span link is focusable and Enter / Space press it without opening the row', () => {
  assert.match(js, /<span role="button" tabindex="0" class="\$\{cls\}" data-build-team=/);
  const sandbox = { started: [], listeners: {} };
  const list = { addEventListener: (ev, f) => { sandbox.listeners[ev] = f; } };
  const i = js.indexOf("$('agents-list').addEventListener('keydown'");
  assert.ok(i >= 0, 'keydown handler');
  const end = js.indexOf("\n  });", i) + 6;
  const fn = js.slice(js.indexOf('function buildTeamActivate('), js.indexOf('function buildSubHtml('));
  const wire = js.slice(i, end);
  new Function('$', 'buildTeamStart', fn + '\n' + wire)(() => list, (n) => sandbox.started.push(n));
  const mk = (key, aria) => {
    const span = { disabled: undefined, dataset: { buildTeam: 'bea' }, getAttribute: () => aria || null };
    const ev = { key, prevented: 0, stopped: 0, target: { closest: (q) => (q === 'span[data-build-team]' ? span : null) }, preventDefault() { this.prevented++; }, stopPropagation() { this.stopped++; } };
    sandbox.listeners.keydown(ev); return ev;
  };
  const e1 = mk('Enter'); assert.deepStrictEqual(sandbox.started, ['bea']); assert.ok(e1.prevented && e1.stopped);
  mk(' '); assert.strictEqual(sandbox.started.length, 2);
  const e3 = mk('a'); assert.strictEqual(sandbox.started.length, 2); assert.strictEqual(e3.stopped, 0);
  mk('Enter', 'true'); assert.strictEqual(sandbox.started.length, 2, 'a busy link does nothing');
});

test('analyseSetup keeps belongs_to on the rows (setupFacts level 0): an agent that reports to another boss says so', () => {
  const TS = require('../lib/team-setup.js');
  const NOW = Date.now();
  const list = [
    { name: 'ann', category: 'primary', model: 'm' }, { name: 'bob', category: 'primary', model: 'm' },
    { name: 'wes', category: 'worker', reportsTo: 'bob' },
  ];
  const handOffs = Array.from({ length: 3 }, () => ({ caller: 'ann', target: 'wes', createdAt: NOW - 1000 }));
  const f = TS.setupFacts({ agentsList: list, adminIds: new Set(), handOffs, consultsOf: () => ({}), starterNames: new Set(), now: NOW, level: 0 });
  const row = f.mains.find((m) => m.name === 'ann').working_history.find((r) => r.name === 'wes');
  assert.ok(row, 'the row is there');
  assert.strictEqual(row.belongs_to, 'bob');
});
