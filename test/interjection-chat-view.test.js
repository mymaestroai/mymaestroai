'use strict';
// Interjections in the main chat view (lib/chat-history): an interjection line is the person's own message, keeps
// its pictures, pages with "Load earlier" like any other entry, and is never shown twice at the chat log / archive seam.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { filterMainView, historyPage } = require(path.join(__dirname, '..', 'lib', 'chat-history'));

const ts = (s) => `2026-11-14T10:00:${String(s).padStart(2, '0')}.000Z`;
const ij = (s, text, extra = {}) => ({ ts: ts(s), role: 'user', content: `[OPERATOR INTERJECTION]: ${text}`, interjection: { id: `ij-${s}`, transport: 'sdk-live' }, ...extra });

test('an interjection in the person\'s own turn is shown, with its pictures', () => {
  const log = [
    { ts: ts(1), role: 'user', content: 'Please do the long task' },
    { ts: ts(2), role: 'assistant', content: 'Starting.' },
    ij(3, 'also check the blue folder', { images: ['/srv/example/data/uploads/a.jpg'] }),
    { ts: ts(4), role: 'assistant', content: ' Done.', base: 9 },
  ];
  assert.deepEqual(filterMainView(log), [true, true, true, true]);
  const page = historyPage({ logEntries: log, archive: null, view: 'main' });
  const line = page.history.find((e) => e.interjection);
  assert.ok(line, 'the interjection line is in the main view');
  assert.deepEqual(line.images, ['/srv/example/data/uploads/a.jpg'], 'its pictures stay on the line');
});

test('an interjection into a hidden hub-started turn is shown, with the reply after it', () => {
  const log = [
    { ts: ts(1), role: 'user', content: 'Hello' },
    { ts: ts(2), role: 'assistant', content: 'Hi.' },
    { ts: ts(3), role: 'user', content: '[Scheduled task — started by the hub scheduler, NOT a message typed by the owner] "Daily check"' },
    { ts: ts(4), role: 'assistant', content: 'Checking.' },
    ij(5, 'stop after the first item'),
    { ts: ts(6), role: 'assistant', content: ' Stopped after the first item.', base: 9 },
  ];
  assert.deepEqual(filterMainView(log), [true, true, false, false, true, true]);
});

test('Load earlier pages an interjection once and the archive behind the log never repeats it', () => {
  const log = [];
  for (let s = 10; s < 30; s += 2) {
    log.push({ ts: ts(s), role: 'user', content: `message ${s}` });
    log.push({ ts: ts(s + 1), role: 'assistant', content: `reply ${s}` });
  }
  log.splice(5, 0, ij(14, 'note in the middle'));   // between the entries of second 13 and 14 (sorted by time)
  log.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  // The archive holds a copy of the interjection (recorded when it was delivered, never before its log line) and
  // older rows; only rows older than the log's oldest entry are used.
  const archiveRows = [
    { id: 3, ts: ts(14), kind: 'user', text: 'note in the middle', origin: 'interjection' },
    { id: 2, ts: ts(5), kind: 'assistant', text: 'old reply' },
    { id: 1, ts: ts(4), kind: 'user', text: 'old message' },
  ];
  const archive = {
    rowsBefore: ({ beforeId, beforeTs, limit }) => archiveRows
      .filter((r) => (beforeId != null ? r.id < beforeId : beforeTs ? Date.parse(r.ts) < Date.parse(beforeTs) : true))
      .slice(0, limit || 50),
    forOwnerTurns: () => [],
    lastMarkTs: () => null,
  };
  const seen = [];
  let before = null;
  for (let i = 0; i < 20; i++) {
    const page = historyPage({ logEntries: log, archive, view: 'main', before, limit: 4 });
    seen.unshift(...page.history);
    if (!page.next) break;
    before = page.next;
  }
  const copies = seen.filter((e) => /note in the middle/.test(e.content || ''));
  assert.equal(copies.length, 1, 'the interjection is shown once across all pages');
  assert.ok(copies[0].interjection, 'and it is the chat log line (marker and pictures), not the archive copy');
  assert.ok(seen.some((e) => e.archived && e.content === 'old message'), 'the archive behind the log is still reached');
});
