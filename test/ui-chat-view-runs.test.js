'use strict';
// The one-line summary of a run of hub-started turns (a hidden_run entry): its words, merging, fetch url,
// and the byte-identical helper block (the page tests for desktop and phone are in ui-chat-view-runs-pages.test.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const V = require('../lib/ui-chat-view');

const ROOT = path.join(__dirname, '..');
const BEGIN = '// ── chat view helpers (begin) ──', END = '// ── chat view helpers (end) ──';
const block = (src) => src.slice(src.indexOf(BEGIN), src.indexOf(END) + END.length);
const strip = (s, indent) => s.split('\n').map(l => (l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n');

// The page's own formatter, in a fixed zone for the test: "8:09 AM", or "Nov 24, 8:09 AM" when asked with a date.
const fmt = (ts, withDate) => new Date(ts).toLocaleString('en-US', { timeZone: 'UTC', ...(withDate ? { month: 'short', day: 'numeric' } : {}), hour: 'numeric', minute: '2-digit' });
const run = (o) => ({ role: 'hidden_run', ts: '2026-11-24T08:09:00Z', last_ts: '2026-11-24T08:17:00Z', turns: 4, kinds: [{ kind: 'consultation', from: 'Beacon', n: 4 }], content: '', ...o });

test('run text: one kind, plural and singular, with the from-name and the time range', () => {
  assert.strictEqual(V.chatViewRunText(run(), fmt), '4 consultations from Beacon · 8:09–8:17 AM');
  assert.strictEqual(V.chatViewRunText(run({ turns: 1, last_ts: '2026-11-24T08:09:00Z', kinds: [{ kind: 'consultation', from: 'Beacon', n: 1 }] }), fmt), '1 consultation from Beacon · 8:09 AM');
});

test('run text: mixed kinds in order, words per kind, no from where none is known', () => {
  const r = run({ ts: '2026-11-24T07:02:00Z', turns: 6, kinds: [{ kind: 'consultation', from: 'Beacon', n: 2 }, { kind: 'hand_off', from: 'Maestro', n: 1 }, { kind: 'schedule', from: null, n: 3 }] });
  assert.strictEqual(V.chatViewRunText(r, fmt), '2 consultations from Beacon, 1 task from Maestro, 3 check-ins · 7:02–8:17 AM');
  const j = run({ turns: 3, kinds: [{ kind: 'job_notice', from: null, n: 1 }, { kind: 'other', from: null, n: 2 }, { kind: 'consultation', from: null, n: 1 }] });
  assert.match(V.chatViewRunText(j, fmt), /^1 job notice, 2 hub turns, 1 consultation · /);
  // a hand-off's report and a job report count as the server counts them
  assert.deepStrictEqual(V.chatViewRunKindOf({ kind: 'hand_off_report', from: 'Maestro' }), { kind: 'hand_off', from: 'Maestro' });
  assert.deepStrictEqual(V.chatViewRunKindOf({ kind: 'job_report' }), { kind: 'job_notice', from: null });
  assert.match(V.chatViewRunText(run({ turns: 3, kinds: [{ kind: 'job_notice', from: null, n: 3 }] }), fmt), /^3 job notices · /);
  assert.match(V.chatViewRunText(run({ turns: 1, kinds: [{ kind: 'schedule', from: null, n: 1 }] }), fmt), /^1 check-in · /);
  assert.match(V.chatViewRunText(run({ turns: 1, kinds: [{ kind: 'weird', from: 'x', n: 1 }] }), fmt), /^1 hub turn · /, 'an unknown kind reads as a hub turn');
});

test('run text: the am/pm is said once on one day; a range over two days shows the date on both ends', () => {
  assert.strictEqual(V.chatViewRunText(run({ ts: '2026-11-24T11:50:00Z', last_ts: '2026-11-24T13:05:00Z' }), fmt), '4 consultations from Beacon · 11:50 AM–1:05 PM');
  assert.strictEqual(V.chatViewRunText(run({ ts: '2026-11-23T22:30:00Z', last_ts: '2026-11-24T08:17:00Z' }), fmt), '4 consultations from Beacon · Nov 23, 10:30 PM – Nov 24, 8:17 AM');
  assert.strictEqual(V.chatViewRunText(run({ kinds: [] }), fmt).startsWith('4 hub turns'), true, 'no kinds: the total');
});

test('mergeRuns: adjacent runs become one (turns and kinds added by kind and from, widest range); other entries are untouched', () => {
  const a = run({ ts: '2026-11-24T07:00:00Z', last_ts: '2026-11-24T07:10:00Z', turns: 2, kinds: [{ kind: 'consultation', from: 'Beacon', n: 2 }] });
  const b = run({ ts: '2026-11-24T07:20:00Z', last_ts: '2026-11-24T07:40:00Z', turns: 3, kinds: [{ kind: 'consultation', from: 'Beacon', n: 1 }, { kind: 'schedule', from: null, n: 2 }] });
  const own = { ts: '2026-11-24T07:45:00Z', role: 'user', content: 'hi' };
  const c = run({ ts: '2026-11-24T07:50:00Z', last_ts: '2026-11-24T07:55:00Z', turns: 1, kinds: [{ kind: 'consultation', from: 'Scout', n: 1 }] });
  const copyA = JSON.stringify(a);
  const out = V.chatViewMergeRuns([own, a, b, own, c]);
  assert.strictEqual(out.length, 4);
  assert.deepStrictEqual(out[1], run({ ts: '2026-11-24T07:00:00Z', last_ts: '2026-11-24T07:40:00Z', turns: 5, kinds: [{ kind: 'consultation', from: 'Beacon', n: 3 }, { kind: 'schedule', from: null, n: 2 }] }));
  assert.strictEqual(out[2], own); assert.strictEqual(out[3], c);
  assert.strictEqual(JSON.stringify(a), copyA, 'the inputs are not changed');
  assert.deepStrictEqual(V.chatViewMergeRuns(null), []);
  assert.strictEqual(V.chatViewMergeRuns([a, b, c]).length, 1, 'three in a row');
});

test('mergeOlder: a hidden_run is keyed by run|ts|last_ts at the seam', () => {
  const r = run();
  const cur = [{ ...r }, { ts: '2026-11-24T09:00:00Z', role: 'user', content: 'x' }];
  assert.strictEqual(V.chatViewMergeOlder([{ ...r }], cur).length, 2, 'the same run is not drawn twice');
  assert.strictEqual(V.chatViewMergeOlder([run({ last_ts: '2026-11-24T08:18:00Z' })], cur).length, 3, 'a different range is another entry');
  assert.strictEqual(V.chatViewMergeOlder([{ ts: '2026-11-24T08:09:00Z', role: 'user', content: '' }], cur).length, 3, 'a message with the same ts is not the run');
});

test('runAdd and runKindOf count a live hub turn into a run', () => {
  assert.deepStrictEqual(V.chatViewRunKindOf({ kind: 'consultation', from: 'Beacon' }), { kind: 'consultation', from: 'Beacon' });
  assert.deepStrictEqual(V.chatViewRunKindOf({ kind: 'job_notice', from: 'x' }), { kind: 'job_notice', from: null });
  assert.deepStrictEqual(V.chatViewRunKindOf({ kind: 'alert' }), { kind: 'other', from: null });
  assert.deepStrictEqual(V.chatViewRunKindOf(null), { kind: 'other', from: null });
  const r = { role: 'hidden_run', ts: '2026-11-24T08:21:00Z', last_ts: '2026-11-24T08:21:00Z', turns: 0, kinds: [], content: '' };
  V.chatViewRunAdd(r, 'consultation', 'Beacon', '2026-11-24T08:21:00Z');
  assert.strictEqual(V.chatViewRunText(r, fmt), '1 consultation from Beacon · 8:21 AM');
  V.chatViewRunAdd(r, 'consultation', 'Beacon', '2026-11-24T08:25:00Z');
  V.chatViewRunAdd(r, 'schedule', null, '2026-11-24T08:26:00Z');
  assert.strictEqual(V.chatViewRunText(r, fmt), '2 consultations from Beacon, 1 check-in · 8:21–8:26 AM');
});

test('runUrl: view=run with the run\'s first and last time, encoded', () => {
  assert.strictEqual(V.chatViewRunUrl('forge', run()), '/api/history/forge?view=run&from=2026-11-24T08%3A09%3A00Z&to=2026-11-24T08%3A17%3A00Z');
  assert.strictEqual(V.chatViewRunUrl('a b', { ts: 'T1' }), '/api/history/a%20b?view=run&from=T1&to=T1');
});

test('the helper block, with the run helpers, is byte-identical in lib, app.js and mobile.js', () => {
  const lib = block(fs.readFileSync(path.join(ROOT, 'lib', 'ui-chat-view.js'), 'utf8'));
  for (const name of ['chatViewRunText', 'chatViewMergeRuns', 'chatViewRunUrl', 'chatViewRunAdd', 'chatViewRunKindOf']) assert.ok(lib.includes(`function ${name}(`), name);
  assert.strictEqual(block(fs.readFileSync(path.join(ROOT, 'mobile.js'), 'utf8')), lib, 'mobile.js');
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const a = app.indexOf('    ' + BEGIN);
  assert.strictEqual(strip(app.slice(a, app.indexOf(END) + END.length), '    '), lib, 'app.js');
});
