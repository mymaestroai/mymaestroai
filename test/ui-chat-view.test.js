'use strict';
// The chat view helpers (lib/ui-chat-view.js) and their byte-identical copies in app.js and mobile.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const V = require('../lib/ui-chat-view');

const ROOT = path.join(__dirname, '..');
const BEGIN = '// ── chat view helpers (begin) ──', END = '// ── chat view helpers (end) ──';
const block = (src) => src.slice(src.indexOf(BEGIN), src.indexOf(END) + END.length);
const strip = (s, indent) => s.split('\n').map(l => (l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n');

test('chat view: both pages carry a byte-identical copy of the helpers', () => {
  const lib = block(fs.readFileSync(path.join(ROOT, 'lib', 'ui-chat-view.js'), 'utf8'));
  assert.ok(lib.length > 200);
  assert.strictEqual(block(fs.readFileSync(path.join(ROOT, 'mobile.js'), 'utf8')), lib, 'mobile.js');
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const a = app.indexOf('    ' + BEGIN);
  assert.ok(a >= 0, 'app.js has the block at 4-space indent');
  assert.strictEqual(strip(app.slice(a, app.indexOf(END) + END.length), '    '), lib, 'app.js');
});

test('chat view: the choice is per device, main by default, anything odd counts as main', () => {
  const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
  const s = store();
  assert.strictEqual(V.chatViewGet(s), 'main');
  assert.strictEqual(V.chatViewSet(s, 'all'), 'all'); assert.strictEqual(V.chatViewGet(s), 'all');
  assert.strictEqual(V.chatViewSet(s, 'weird'), 'main'); assert.strictEqual(V.chatViewGet(s), 'main');
  s.setItem('hub-chat-view', 'ALL'); assert.strictEqual(V.chatViewGet(s), 'main');
  assert.strictEqual(V.chatViewGet(null), 'main');
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.strictEqual(V.chatViewGet(broken), 'main'); assert.strictEqual(V.chatViewSet(broken, 'all'), 'all');
});

test('chat view: history url', () => {
  assert.strictEqual(V.chatViewHistoryUrl('maestro', {}), '/api/history/maestro?view=main&limit=40');
  assert.strictEqual(V.chatViewHistoryUrl('a b', { view: 'all', limit: 10, before: 'arc:12' }), '/api/history/a%20b?view=all&limit=10&before=arc%3A12');
  assert.strictEqual(V.chatViewHistoryUrl('x', { limit: 9999 }), '/api/history/x?view=main&limit=200');
});

test('chat view: hub origins and the busy card text', () => {
  assert.strictEqual(V.chatViewIsHubOrigin({ kind: 'user' }), false);
  assert.strictEqual(V.chatViewIsHubOrigin({ kind: 'comms' }), false);
  assert.strictEqual(V.chatViewIsHubOrigin(null), false);
  assert.strictEqual(V.chatViewIsHubOrigin({ kind: 'consultation', from: 'forge' }), true);
  assert.strictEqual(V.chatViewBusyText({ kind: 'consultation', from: 'forge' }), 'Answering a consultation from Forge');
  assert.strictEqual(V.chatViewBusyText({ kind: 'schedule', from: 'Daily review' }), 'Working on a scheduled task: Daily review');
  assert.strictEqual(V.chatViewBusyText({ kind: 'job_notice', jobName: 'suite' }), 'Reading a job result: suite');
  assert.strictEqual(V.chatViewBusyText({ kind: 'job_report' }), 'Reading a job report');
  assert.strictEqual(V.chatViewBusyText({ kind: 'consult_reply' }), 'Reading consultation replies');
  assert.strictEqual(V.chatViewBusyText({ kind: 'mystery' }), 'Working on a hub task');
  assert.strictEqual(V.chatViewBusyText(null, 'consulted by anvil'), 'Answering a consultation from Anvil');
  assert.strictEqual(V.chatViewBusyText(null, 'scheduled task: owl run'), 'Working on a scheduled task: owl run');
  assert.strictEqual(V.chatViewBusyText(null, 'job finished'), 'Reading a job result');
  assert.strictEqual(V.chatViewBusyText(null, ''), 'Working on a hub task');
});

test('chat view: elapsed time and merging an older page', () => {
  assert.strictEqual(V.chatViewElapsed(0, 12000), '12 s');
  assert.strictEqual(V.chatViewElapsed(0, 4 * 60000 + 5000), '4 min');
  assert.strictEqual(V.chatViewElapsed(0, 65 * 60000), '1 h 5 min');
  assert.strictEqual(V.chatViewElapsed(0, 120 * 60000), '2 h');
  assert.strictEqual(V.chatViewElapsed(5000, 1000), '0 s');
  const a = { ts: '1', role: 'user', content: 'a' }, b = { ts: '2', role: 'assistant', content: 'b' }, c = { ts: '3', role: 'user', content: 'c' };
  assert.deepStrictEqual(V.chatViewMergeOlder([a, b], [b, c]), [a, b, c], 'the seam entry is not doubled');
  assert.deepStrictEqual(V.chatViewMergeOlder(null, [c]), [c]);
});
