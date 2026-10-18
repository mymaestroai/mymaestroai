'use strict';

// Memory context assembly: newest long-term entries win, small sections load
// in full, shared memory has one row per (topic, author), and only the two
// most recent days of session notes are injected.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memctx-'));
process.env.HUB_MEMORY_DB = path.join(tmp, 'memory.db');
const mem = require('../lib/memory-db');

test('oversized general section keeps the newest entries, not the oldest', () => {
  const lines = [];
  for (let i = 0; i < 2000; i++) lines.push(`entry-${String(i).padStart(4, '0')} ${'x'.repeat(40)}`);
  mem.writeLongTermMemory('a1', lines.join('\n'), 'general');
  const ctx = mem.getMemoryContext('a1');
  assert.ok(ctx.includes('entry-1999'), 'newest entry present');
  assert.ok(!ctx.includes('entry-0000'), 'oldest entry dropped');
  assert.ok(ctx.includes('read_memory("general")'), 'points at the full section');
  assert.match(ctx.split('loads the full section)_\n')[1], /^entry-\d{4} /, 'cut on a line boundary');
});

test('small sections (rules) always load in full even when general is huge', () => {
  mem.writeLongTermMemory('a2', 'big '.repeat(30000), 'general');
  mem.writeLongTermMemory('a2', 'NEVER restart without approval.', 'feedback');
  mem.writeLongTermMemory('a2', 'zzz-short rule', 'zrules');
  const ctx = mem.getMemoryContext('a2');
  assert.ok(ctx.includes('## feedback\nNEVER restart without approval.'));
  assert.ok(ctx.includes('## zrules\nzzz-short rule'));
});

test('rewriting shared memory updates the row instead of duplicating it', () => {
  mem.writeSharedMemory('topic-x', 'v1', 'maestro');
  mem.writeSharedMemory('topic-x', 'v2', 'maestro');
  const n = mem.getDb().prepare("SELECT COUNT(*) n FROM shared_memory WHERE topic='topic-x'").get().n;
  assert.strictEqual(n, 1);
  assert.ok(mem.readSharedMemory('topic-x').includes('v2'));
});

test('legacy duplicate shared rows appear once in the context', () => {
  const db = mem.getDb();
  const ins = db.prepare("INSERT INTO shared_memory (topic, content, author) VALUES ('dup-topic', 'same body', 'maestro')");
  ins.run(); ins.run();
  const ctx = mem.getMemoryContext('a3');
  assert.strictEqual(ctx.split('## dup-topic').length - 1, 1);
});

test('only the two most recent days with session notes are injected', () => {
  const db = mem.getDb();
  const day = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const ins = db.prepare("INSERT INTO session_notes (agent, date, time, category, content) VALUES ('a4', ?, '10:00', 'Chat', ?)");
  ins.run(day(1), 'note-d1'); ins.run(day(3), 'note-d3'); ins.run(day(5), 'note-d5');
  const ctx = mem.getMemoryContext('a4');
  assert.ok(ctx.includes('note-d1') && ctx.includes('note-d3'));
  assert.ok(!ctx.includes('note-d5'));
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
