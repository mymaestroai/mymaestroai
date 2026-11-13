'use strict';
// A running temporary-worker card whose end never reached the page is reconciled against the full status feed
// (workerGoneStep in lib/ui-busy-workers.js): source checks of how app.js and mobile.js use it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
// the text from `start` up to the next line that begins with `endRe` at the same indent as `start`
function section(src, start, endMarker) {
  const a = src.indexOf(start);
  assert.ok(a >= 0, `${start} present`);
  const b = src.indexOf(endMarker, a + start.length);
  assert.ok(b > a, `${endMarker} follows ${start}`);
  return src.slice(a, b);
}

const app = read('app.js');
const mobile = read('mobile.js');

test('app.js: applyStatusSnapshot steps workerGoneStep only for a full feed and ends each gone id', () => {
  const body = section(app, 'function applyStatusSnapshot(map) {', 'let workerGoneState');
  const at = body.indexOf('if (!namedOnly) {');
  assert.ok(at > 0, 'guarded by !namedOnly');
  const guarded = body.slice(at);
  assert.match(guarded, /workerGoneStep\(workerGoneState, \{ running, statusMap: map, now: Date\.now\(\) \}\)/);
  assert.match(guarded, /workerGoneState = step\.next/);
  assert.match(guarded, /for \(const id of step\.gone\) endWorkerRunUnreported\(id\)/);
  assert.ok(!body.slice(0, at).includes('workerGoneStep'), 'not called outside the full-feed guard');
  assert.match(guarded, /chat\.isWorker/);
  assert.match(guarded, /run\.status === 'running'/);
  assert.match(app, /let workerGoneState = \{\};/);
});

test('app.js: endWorkerRunUnreported marks the run ended and asks the caller\'s worker history', () => {
  const body = section(app, 'function endWorkerRunUnreported(workerId) {', 'async function reattachIfIdle');
  assert.match(body, /run\.status = 'ended'/);
  assert.match(body, /settleWorkerCard\(workerChatId, 'idle', 'Ended'\)/);
  assert.match(body, /ended \(no result was reported\)/);
  assert.match(body, /\/workers\/\$\{encodeURIComponent\(workerId\)\}/);
  assert.match(body, /\.worker\b/, 'the route nests the record under worker');
  assert.match(body, /run\.status !== 'ended'/, 'only a run still ended takes the outcome');
  assert.match(body, /rec\.outcome === 'done'[\s\S]*worker_completed/);
  assert.match(body, /rec\.outcome === 'stopped'[\s\S]*cancelled: true/);
  assert.match(body, /rec\.outcome === 'failed'[\s\S]*worker_failed/);
  assert.ok(!/outcome === 'unfinished'/.test(body), 'unfinished leaves it ended');
});

test('app.js: workerCardState returns ended, and the menu shows a neutral mark and word for it', () => {
  const state = section(app, 'function workerCardState(chat) {', 'function workerCardEndedAt');
  assert.match(state, /last\.status === 'ended' \? 'ended'/);
  const menu = section(app, 'function renderWorkersMenu(items) {', 'for (const group of hubGroups)');
  assert.match(menu, /state === 'ended' \? '–'/);
  assert.match(menu, /state === 'ended' \? 'ended'/);
  assert.match(menu, /`wm-row wm-\$\{state\}`/, 'the row class carries wm-ended');
  const markLine = menu.split('\n').find(l => l.includes('mark.textContent'));
  assert.ok(markLine.indexOf("'ended'") < markLine.indexOf("'✕'"), 'ended is picked before the ✕ fallback');
  assert.ok(!/state === 'ended' \? '[✓✕]'/.test(menu));
  assert.match(menu, /if \(state === 'running'\) \{\s*const stop/, 'only a running row has a stop button');
  assert.match(read('index.html'), /\.wm-ended \.wm-mark/);
});

test('app.js: workerPollWanted is also true while a tw- worker card runs', () => {
  const body = section(app, 'function workerPollWanted() {', 'setInterval(() => { if (!document.hidden && workerPollWanted())');
  assert.match(body, /r\.status === 'running' && id\.startsWith\('tw-'\)/);
});

test('app.js: a late completed / failed result still applies to an ended run', () => {
  const done = section(app, "if (oc.type === 'worker_completed') {", "// ── Tiger Team Events ──");
  const failed = section(app, "if (oc.type === 'worker_failed') {", 'const failLabel');
  for (const b of [done, failed]) {
    assert.match(b, /if \(run\.status === 'completed' \|\| run\.status === 'failed'\) return true;/);
    assert.ok(!/'ended'/.test(b), 'nothing blocks on ended');
  }
  assert.match(failed, /if \(run\.status !== 'cancelled'\) markWorkerRunCancelled/);
});

test('mobile.js: applySnapshot steps workerGoneStep for a full feed and ends gone cards', () => {
  const body = section(mobile, 'function applySnapshot(map, repaint = true, opts = {}) {', 'let wkGoneState');
  const at = body.indexOf('if (!namedOnly) {', body.indexOf('reattachIfIdle(current)'));
  assert.ok(at > 0, 'guarded by !namedOnly');
  const guarded = body.slice(at);
  assert.match(guarded, /workerGoneStep\(wkGoneState, \{ running, statusMap: map, now: Date\.now\(\) \}\)/);
  assert.match(guarded, /!e\.it\.inferred/);
  assert.match(guarded, /startedAt: e\.it\.t0/);
  assert.match(guarded, /wkInferEnd\(wkSeen\.get\(id\), 0, 'gone'\)/);
  assert.match(mobile, /let wkGoneState = \{\};/);
});

test('mobile.js: the 5 s interval polls while a tw- worker card is running', () => {
  const body = section(mobile, 'function wkRefresh() {', 'setInterval(wkRefresh');
  const iv = mobile.slice(mobile.lastIndexOf('setInterval(() => {', mobile.indexOf('function wkRefresh() {')), mobile.indexOf('function wkRefresh() {'));
  assert.match(iv, /e\.it\.status === 'running' && \/\^tw-\/\.test\(e\.id\)/);
  assert.match(iv, /wkHubPoll\(\)/);
  assert.match(iv, /\}, 5000\);/);
  assert.ok(body.length > 0);
});
