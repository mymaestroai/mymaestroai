'use strict';
// Which workers the Workers button lists (lib/ui-worker-list.js), shared by the desktop and phone pages: running ones;
// finished or stopped ones for 2 minutes; failed ones until opened or 10 minutes, the newest 3; never the one on
// screen; and the button's words.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const L = require('../lib/ui-worker-list');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const BEGIN = '// ── worker list helpers (begin) ──';
const END = '// ── worker list helpers (end) ──';
function helperBlock(src, indent) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  assert.ok(a > 0 && b > a, 'helper markers present');
  return src.slice(a + BEGIN.length, b).split('\n').map(l => (indent && l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n').trim();
}

test('the worker list helpers are byte-identical in lib/ui-worker-list.js, app.js and mobile.js', () => {
  const lib = helperBlock(read('lib/ui-worker-list.js'), '');
  assert.strictEqual(helperBlock(read('app.js'), '    '), lib, 'app.js copy differs');
  assert.strictEqual(helperBlock(read('mobile.js'), ''), lib, 'mobile.js copy differs');
});

const NOW = 1_800_000_000_000;
const e = (id, state, endedAgoMs, extra = {}) => ({ id, state, startedAt: NOW - 600000, endedAt: state === 'running' ? null : NOW - endedAgoMs, ...extra });

test('running first, then the newest ended; finished and stopped stay 2 minutes; counts and words', () => {
  const r = L.workerListPick([e('a', 'done', 30000), e('b', 'running'), e('c', 'done', 125000), e('d', 'stopped', 1000)], NOW, null);
  assert.deepStrictEqual(r.items.map(i => [i.id, i.state]), [['b', 'running'], ['d', 'stopped'], ['a', 'done']]);
  assert.deepStrictEqual(r.gone, ['c']);
  assert.deepStrictEqual([r.counts, r.alert, L.workerButtonLabel(r.counts)], [{ running: 1, done: 2, failed: 0 }, false, '1 working · 2 done']);
  assert.strictEqual(L.workerButtonLabel({ running: 0, done: 0, failed: 0 }), 'Workers');
});

test('failed: until opened or 10 minutes, the newest 3; the one on screen always stays; entries keep their own fields', () => {
  const r = L.workerListPick([e('f1', 'failed', 1000), e('f2', 'failed', 2000), e('f3', 'failed', 3000), e('f4', 'failed', 4000), e('old', 'failed', 11 * 60000), e('seen', 'failed', 500, { failSeen: true }), e('x', 'running', 0, { chat: { name: 'kept' } })], NOW, 'f4');
  assert.deepStrictEqual(r.items.map(i => i.id).sort(), ['f1', 'f2', 'f3', 'f4', 'x']);
  assert.deepStrictEqual(r.gone.sort(), ['old', 'seen']);
  assert.strictEqual(r.items.find(i => i.id === 'x').chat.name, 'kept');
  assert.strictEqual(r.alert, true);
  assert.strictEqual(L.workerButtonLabel(r.counts), '1 working · 0 done · 4 failed');
  assert.deepStrictEqual([L.fmtWorkerClock(5000), L.fmtWorkerClock(102000), L.fmtWorkerClock(3725000)], ['0:05', '1:42', '1:02:05']);
});
