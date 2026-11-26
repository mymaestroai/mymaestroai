'use strict';
// r4 E2: every hub-started prompt a run returns names its sender, also an archive row that kept only the origin's kind.

const { test } = require('node:test');
const assert = require('node:assert');
const { runPage } = require('../lib/chat-history');
const { autoInfoOf } = require('../lib/ui-auto-turns');

const T0 = Date.parse('2026-07-01T00:00:00Z');
const t = (n) => new Date(T0 + n * 1000).toISOString();
function fakeArchive(rows) {
  return {
    rowsBefore({ beforeId = null, beforeTs = null, afterTs = null, afterId = null, oldestFirst = false, kinds = ['user', 'assistant'], limit }) {
      return rows.filter(r => (beforeId == null || r.id < beforeId) && (afterId == null || r.id > afterId) && (!beforeTs || r.ts < beforeTs) && (!afterTs || r.ts > afterTs) && kinds.includes(r.kind))
        .sort((a, b) => (oldestFirst ? a.id - b.id : b.id - a.id)).slice(0, limit);
    },
    forOwnerTurns: () => new Set(),
    lastMarkTs: () => null,
  };
}
const row = (id, ts, kind, text, turn, origin = 'user') => ({ id, ts, kind, text, origin, turn_id: turn, meta: {} });

test('r4 E2: an archived consultation prompt comes back with its sender, so the card reads "Consultation from scout"', () => {
  const rows = [row(1, t(3), 'user', '[Consultation from agent "scout"] q1', 'c1', 'consultation'), row(2, t(4), 'assistant', 'a1', 'c1')];
  const log = [{ ts: t(50), role: 'user', content: 'owner now' }];
  const r = runPage({ logEntries: log, archive: fakeArchive(rows), from: t(3), to: t(4) });
  const p = r.history.find(e => e.role === 'user');
  assert.strictEqual(p.origin.kind, 'consultation');
  assert.strictEqual(p.origin.from, 'scout');
  assert.strictEqual(autoInfoOf(p).label, 'Consultation from scout');
});

test('r4 E2: a log prompt that has a sender is left as it is; the log entry itself is not changed', () => {
  const prompt = { ts: t(3), role: 'user', content: '[Consultation from agent "scout"] q', origin: { kind: 'consultation' } };
  const log = [prompt, { ts: t(4), role: 'assistant', content: 'a' }, { ts: t(50), role: 'user', content: 'owner' }];
  const r = runPage({ logEntries: log, archive: fakeArchive([]), from: t(3), to: t(4) });
  assert.strictEqual(r.history[0].origin.from, 'scout');
  assert.strictEqual(prompt.origin.from, undefined, 'the stored entry is a copy, not edited');
  const named = { ts: t(3), role: 'user', content: '[Consultation from agent "scout"] q', origin: { kind: 'consultation', from: 'helper' } };
  const r2 = runPage({ logEntries: [named, { ts: t(4), role: 'assistant', content: 'a' }, { ts: t(50), role: 'user', content: 'owner' }], archive: fakeArchive([]), from: t(3), to: t(4) });
  assert.strictEqual(r2.history[0].origin.from, 'helper');
});
