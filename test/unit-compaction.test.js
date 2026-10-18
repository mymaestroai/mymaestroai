'use strict';
// Agent-authored context compression (lib/compaction): thresholds, modes, the compression turn, and
// the one rule that matters most: a session is reset ONLY in mode 'on'.
const { test } = require('node:test');
const assert = require('node:assert');
const { createCompaction, compressionPrompt, BRIEF_FILE, MIN_GAP_MS } = require('../lib/compaction');

function make({ agents = {}, settings = {} } = {}) {
  let t = 1_000_000;
  const posts = []; const resets = []; const events = [];
  const c = createCompaction({
    now: () => t, log: () => {}, persist: false,
    post: async (agent, message) => { posts.push({ agent, message }); return 'updated pat.md; wrote working-brief.md'; },
    resetSession: async (agent) => { resets.push(agent); },
    getAgent: (name) => agents[name] || null,
    getSetting: (k) => settings[k],
    onEvent: (ev) => events.push(ev),
    getRecentRows: async () => [
      { ts: '2026-10-09T10:00:00Z', kind: 'user', text: 'Owner line one ' + 'x'.repeat(900) },
      { ts: '2026-10-09T10:01:00Z', kind: 'assistant', text: 'Reply one ' + 'y'.repeat(900) },
      { ts: '2026-10-09T10:02:00Z', kind: 'user', text: 'Owner line two ' + 'z'.repeat(900) },
    ],
    chunkCharsFor: async () => 2000,
    briefStatus: async () => (global.__noBrief ? { exists: false, bytes: 0, mtimeMs: 0 } : { exists: true, bytes: 900, mtimeMs: t }),
  });
  return { c, posts, resets, events, tick: (ms) => { t += ms; } };
}
const flush = () => new Promise(r => setImmediate(r));

test('defaults: dry run at 75%; below the threshold nothing happens; at it the agent writes its brief and the session is NOT reset', async () => {
  const { c, posts, resets, events } = make();
  assert.deepStrictEqual([c.get('gp').mode, c.get('gp').at], ['dry', 0.75]);
  assert.strictEqual(c.noteUsage('gp', 500_000, 1_000_000, 's1'), null);
  assert.strictEqual(c.get('gp').pct, 50);
  const p = c.noteUsage('gp', 760_000, 1_000_000, 's1');
  assert.ok(p && typeof p.then === 'function', 'a run started');
  const r = await p;
  assert.deepStrictEqual([r.ok, r.mode, r.reset], [true, 'dry', false]);
  assert.strictEqual(posts.length, 1); assert.strictEqual(posts[0].agent, 'gp');
  assert.match(posts[0].message, /DRY RUN: your session will NOT be reset/);
  assert.match(posts[0].message, new RegExp(BRIEF_FILE));
  assert.deepStrictEqual(resets, []);
  assert.deepStrictEqual(events.map(e => e.type), ['compaction_start', 'compaction_end']);
  // same session, still over: not again (dry run already written for this session)
  assert.strictEqual(c.noteUsage('gp', 790_000, 1_000_000, 's1'), null);
  const g = c.get('gp');
  assert.strictEqual(g.lastRunSession, 's1'); assert.strictEqual(g.running, false);
});

test('mode on: brief, then the session is reset and usage cleared; never twice within an hour', async () => {
  const { c, posts, resets, tick } = make({ agents: { maestro: { name: 'maestro', compaction: { mode: 'on', at: 0.5 } } } });
  const r = await c.noteUsage('maestro', 600_000, 1_000_000, 'sA');
  assert.deepStrictEqual([r.mode, r.reset], ['on', true]);
  assert.deepStrictEqual(resets, ['maestro']);
  assert.match(posts[0].message, /FRESH session seeded with your Records/);
  assert.match(posts[1].message, /Resumed after compression/, 'the agent speaks first after a rollover');
  assert.ok(r.resumed);
  assert.deepStrictEqual([c.get('maestro').tokens, c.get('maestro').pct, c.get('maestro').sessionId], [0, 0, null]);
  // the new session fills up fast: not within the hour
  assert.strictEqual(c.noteUsage('maestro', 700_000, 1_000_000, 'sB'), null);
  tick(MIN_GAP_MS + 1);
  const r2 = await c.noteUsage('maestro', 700_000, 1_000_000, 'sB');
  assert.strictEqual(r2.reset, true); assert.strictEqual(resets.length, 2);
});

test('mode off: nothing at the threshold; the agent\'s request is refused; the owner\'s manual run is a dry run', async () => {
  const { c, posts, resets } = make({ settings: { compactionMode: 'off' } });
  assert.strictEqual(c.noteUsage('gp', 990_000, 1_000_000, 's1'), null);
  assert.match(c.request('gp', 'agent'), /OFF/);
  assert.strictEqual(c.noteUsage('gp', 990_000, 1_000_000, 's1'), null, 'a request on an off agent is dropped');
  const r = await c.run('gp', 'owner');
  assert.deepStrictEqual([r.ok, r.mode, r.reset], [true, 'dry', false]);
  assert.strictEqual(posts.length, 1); assert.deepStrictEqual(resets, []);
  assert.match(posts[0].message, /The owner asked for a compression now/);
});

test('an agent request runs after the current turn (on noteUsage) regardless of the threshold; settings override per agent; prompt text', async () => {
  const { c, posts } = make({ settings: { compactionMode: 'on', compactionAt: 0.6 }, agents: { gp: { name: 'gp', compaction: { mode: 'dry' } } } });
  assert.deepStrictEqual([c.get('gp').mode, c.get('gp').at], ['dry', 0.6], 'agent mode wins, threshold from settings');
  assert.match(c.request('gp', 'agent'), /dry run/);
  const r = await c.noteUsage('gp', 10_000, 1_000_000, 's1');
  assert.strictEqual(r.ok, true); assert.strictEqual(posts.length, 1);
  assert.match(posts[0].message, /You asked for a compression/);
  const txt = compressionPrompt({ agent: 'x', pct: 80, mode: 'on', reason: 'threshold' });
  assert.match(txt, /at 80% of its window/); assert.match(txt, /record_write/); assert.match(txt, /recall/);
  // a failing post is reported, not thrown, and nothing is reset
  const bad = createCompaction({ persist: false, post: async () => { throw new Error('hub down'); }, resetSession: async () => { throw new Error('no'); }, getAgent: () => ({ compaction: { mode: 'on' } }), log: () => {} });
  const rb = await bad.run('y', 'owner');
  assert.deepStrictEqual([rb.ok, rb.reset, rb.error], [false, false, 'hub down']);
});

test('assisted mode: local models default to it at 60%; the transcript goes in slices, then the brief on the template, then a reset', async () => {
  const { c, posts, resets, events } = make({ agents: { qwen36: { name: 'qwen36', model: 'lmstudio/qwen/qwen3.6-27b' } } });
  assert.deepStrictEqual([c.get('qwen36').mode, c.get('qwen36').at, c.get('qwen36').local], ['assisted', 0.6, true]);
  const r = await c.noteUsage('qwen36', 20_000, 32_768, null);
  assert.deepStrictEqual([r.ok, r.mode, r.reset, r.parts], [true, 'assisted', true, 2]);
  assert.strictEqual(posts.length, 4, 'two slices + the final brief + the resume turn');
  assert.match(posts[0].message, /part 1 of 2/); assert.match(posts[0].message, /Owner line one/);
  assert.match(posts[1].message, /part 2 of 2/); assert.match(posts[1].message, /Owner line two/);
  assert.match(posts[2].message, /final step/); assert.match(posts[2].message, /# Working brief/); assert.match(posts[2].message, /## Pending/);
  assert.deepStrictEqual(resets, ['qwen36']);
  assert.ok(c.compactedAt('qwen36'), 'the gateway recent window now starts at the compression');
  assert.deepStrictEqual(events.map(e => e.type), ['compaction_start', 'compaction_progress', 'compaction_progress', 'compaction_resumed', 'compaction_end']);
  // an explicit agent mode still wins over the local default
  const { c: c2 } = make({ agents: { q: { name: 'q', model: 'ollama/llama3', compaction: { mode: 'dry' } } } });
  assert.strictEqual(c2.get('q').mode, 'dry');
});

test('state survives a restart through the state file (compactedAt, last run), never the running flag', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compaction-')); const file = path.join(dir, 'c.json');
  const mk = () => createCompaction({ file, persist: true, log: () => {}, post: async () => 'ok', resetSession: async () => {}, getAgent: () => ({ name: 'a', compaction: { mode: 'on', at: 0.5 } }) });
  const a = mk();
  await a.noteUsage('a', 600, 1000, 's1');
  const at = a.compactedAt('a'); assert.ok(at);
  const b = mk();
  assert.strictEqual(b.compactedAt('a'), at);
  assert.strictEqual(b.get('a').running, false);
  assert.strictEqual(b.get('a').lastMode, 'on');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('safety: no brief written during the run -> the session is NOT reset, the error says so, nothing resumes', async () => {
  global.__noBrief = true;
  try {
    const { c, posts, resets } = make({ agents: { a: { name: 'a', compaction: { mode: 'on', at: 0.5 } } } });
    const r = await c.noteUsage('a', 900, 1000, 's1');
    assert.deepStrictEqual([r.ok, r.reset], [false, false]);
    assert.match(r.error, /brief not written/);
    assert.deepStrictEqual(resets, []);
    assert.strictEqual(posts.length, 1, 'compression turn ran, no resume turn');
    assert.strictEqual(c.get('a').lastOk, false);
  } finally { delete global.__noBrief; }
});
