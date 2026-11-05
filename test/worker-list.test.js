'use strict';
// The desktop worker list (Option B): one button, and a list that keeps running workers, finished ones for 2 minutes
// and failed ones until opened or 10 minutes (the newest 3), never takes away the worker on screen, and turns the
// button red while an unopened failure is listed. The page code runs here on its own.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extract(src, name) {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} present`);
  let p = src.indexOf('(', at); let pd = 0;
  for (; p < src.length; p++) { if (src[p] === '(') pd++; else if (src[p] === ')' && --pd === 0) break; }
  let i = src.indexOf('{', p); let depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(at, i + 1);
}
const NAMES = ['workerCardState', 'workerCardEndedAt', 'workerListOf', 'workerButtonLabel', 'fmtWorkerClock'];
const L = new Function(`const WORKER_DONE_MS = 2 * 60 * 1000, WORKER_FAILED_MS = 10 * 60 * 1000, WORKER_FAILED_MAX = 3;
  ${NAMES.map(n => extract(app, n)).join('\n')}
  return { ${NAMES.join(', ')} };`)();

const NOW = 1_800_000_000_000;
const card = (status, endedAgoMs, extra = {}) => ({ isWorker: true, startedAt: NOW - 600000, runs: { r: { status, startedAt: NOW - 600000, ...(status === 'running' ? {} : { endedAt: NOW - endedAgoMs }) } }, ...extra });

test('the page has one worker button and no strip of cards', () => {
  assert.match(html, /<button id="workers-btn"[^>]*onclick="toggleWorkersMenu\(\)"/);
  assert.match(html, /\.worker-tabs-bar, \.worker-tabs-bar\.has-tabs \{ display: none; \}/);
  assert.match(app, /setInterval\(refreshWorkerList, 5000\)/);
});

test('running first; finished workers stay 2 minutes; stopped counts as finished', () => {
  const chats = { a: card('completed', 30000), b: card('running'), c: card('completed', 125000), d: card('cancelled', 1000), chat: { agent: 'maestro' } };
  const r = L.workerListOf(chats, NOW, 'chat');
  assert.deepStrictEqual(r.items.map(i => [i.id, i.state]), [['b', 'running'], ['d', 'stopped'], ['a', 'done']]);
  assert.deepStrictEqual(r.gone, ['c']);
  assert.deepStrictEqual(r.counts, { running: 1, done: 2, failed: 0 });
  assert.strictEqual(L.workerButtonLabel(r.counts), '1 working · 2 done');
  assert.strictEqual(r.alert, false);
});

test('failed workers stay until opened or 10 minutes, the newest 3; the button turns red while one is unopened', () => {
  const chats = { f1: card('failed', 1000), f2: card('failed', 2000), f3: card('failed', 3000), f4: card('failed', 4000), old: card('failed', 11 * 60000), seen: card('failed', 500, { failSeen: true }) };
  const r = L.workerListOf(chats, NOW, null);
  assert.deepStrictEqual(r.items.map(i => i.id), ['f1', 'f2', 'f3']);
  assert.deepStrictEqual(r.gone.sort(), ['f4', 'old', 'seen']);
  assert.strictEqual(r.alert, true);
  assert.strictEqual(L.workerButtonLabel(r.counts), '0 working · 0 done · 3 failed');
  // once opened, a failed worker no longer turns the button red, and leaves when something else is on screen
  chats.f1.failSeen = true; chats.f2.failSeen = true; chats.f3.failSeen = true;
  const r2 = L.workerListOf({ f1: chats.f1 }, NOW, 'f1');
  assert.deepStrictEqual([r2.items.map(i => i.id), r2.alert], [['f1'], false], 'on screen: it stays');
  assert.deepStrictEqual(L.workerListOf({ f1: chats.f1 }, NOW, 'chat').gone, ['f1']);
});

test('the worker on screen is never taken away; history views and ordinary chats are not listed; idle reads "Workers"', () => {
  const chats = { old: card('completed', 30 * 60000), hist: { isWorker: true, isHistory: true, runs: {} }, chat: { agent: 'maestro' } };
  const r = L.workerListOf(chats, NOW, 'old');
  assert.deepStrictEqual([r.items.map(i => i.id), r.gone], [['old'], []]);
  assert.strictEqual(L.workerButtonLabel(L.workerListOf({}, NOW, null).counts), 'Workers');
  // a card with a new call running is running again, whatever its earlier calls did
  const again = { isWorker: true, runs: { r1: { status: 'failed', startedAt: 1, endedAt: 2 }, r2: { status: 'running', startedAt: 3 } } };
  assert.strictEqual(L.workerCardState(again), 'running');
  assert.strictEqual(L.workerCardState({ isWorker: true, runs: { r1: { status: 'completed', startedAt: 1, endedAt: 5 }, r2: { status: 'failed', startedAt: 3, endedAt: 4 } } }), 'failed', 'the newest call decides');
  assert.deepStrictEqual([L.fmtWorkerClock(5000), L.fmtWorkerClock(102000), L.fmtWorkerClock(3725000)], ['0:05', '1:42', '1:02:05']);
});
