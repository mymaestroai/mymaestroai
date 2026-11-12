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
    assert.match(r.error, /didn't write its brief during the compression turn.*session was kept.*next threshold or when the agent asks/);
    assert.deepStrictEqual(resets, []);
    assert.strictEqual(posts.length, 1, 'compression turn ran, no resume turn');
    assert.strictEqual(c.get('a').lastOk, false);
  } finally { delete global.__noBrief; }
});

test('history: the last 20 context readings and compression runs (with how each ended) are kept, and survive a restart', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const { HISTORY } = require('../lib/compaction');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compaction-h-')); const file = path.join(dir, 'c.json');
  let t = 5_000_000;
  const mk = (post) => createCompaction({ file, persist: true, now: () => t, log: () => {}, post, resetSession: async () => {}, getAgent: () => ({ name: 'a', compaction: { mode: 'dry', at: 0.95 } }) });
  const a = mk(async () => 'ok');
  for (let i = 1; i <= 25; i++) { t += 1000; a.noteUsage('a', i * 1000, 100000, 's1'); }
  a.noteUsage('a', 0, 100000, 's1');   // no reading: nothing measured
  const h = a.history('a');
  assert.strictEqual(HISTORY, 20);
  assert.deepStrictEqual([h.readings.length, h.readings[0].tokens, h.readings[19].tokens, h.readings[19].limit], [20, 6000, 25000, 100000]);
  t += MIN_GAP_MS;
  await a.run('a', 'owner');
  const b = mk(async () => { throw new Error('the model was busy'); });
  t += MIN_GAP_MS;
  await b.run('a', 'owner');
  const runs = b.history('a').runs;
  assert.deepStrictEqual(runs.map(r => [r.ok, r.mode, r.reason, r.error || null]), [[true, 'dry', 'owner', null], [false, 'dry', 'owner', 'the model was busy']]);
  const c = mk(async () => 'ok');
  assert.strictEqual(c.history('a').runs.length, 2, 'runs kept across a restart');
  assert.strictEqual(c.history('a').readings.length, 20, 'readings kept across a restart');
  assert.deepStrictEqual(make().c.history('nobody'), { readings: [], runs: [] });
  // readings alone (no run) reach the file on flush, as at the hub's shutdown
  c.noteUsage('a', 77000, 100000, 's2');
  c.flush();
  const d = mk(async () => 'ok');
  assert.strictEqual(d.history('a').readings.slice(-1)[0].tokens, 77000);
  d.flush();   // nothing waiting: no write, no error
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rename: a renamed agent keeps its compression state and history, saved', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compaction-')); const file = path.join(dir, 'c.json');
  const mk = () => createCompaction({ file, persist: true, log: () => {}, post: async () => 'ok', resetSession: async () => {}, getAgent: () => ({ name: 'a', compaction: { mode: 'on', at: 0.5 } }) });
  const a = mk();
  await a.noteUsage('a', 400, 1000, 's1');
  const before = a.history('a');
  assert.strictEqual(a.rename('a', 'b'), true);
  assert.deepStrictEqual([a.history('b'), a.history('a').readings.length], [before, 0]);
  a.flush();
  assert.deepStrictEqual(mk().history('b'), before, 'saved');
  assert.strictEqual(a.rename('nobody', 'x'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rename: when its state can\'t be written, the rename fails and nothing changes', { skip: process.getuid && process.getuid() === 0 }, async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compaction-')); const file = path.join(dir, 'c.json');
  const c = createCompaction({ file, persist: true, log: () => {}, post: async () => 'ok', resetSession: async () => {}, getAgent: () => ({ name: 'a', compaction: { mode: 'on', at: 0.5 } }) });
  await c.noteUsage('a', 400, 1000, 's1');
  c.flush();
  const before = c.history('a');
  fs.chmodSync(dir, 0o500);
  try { assert.throws(() => c.rename('a', 'b'), /EACCES/); } finally { fs.chmodSync(dir, 0o700); }
  assert.deepStrictEqual([c.history('a'), c.history('b').readings.length], [before, 0], 'still under the old name');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('state writes keep the file\'s permissions and leave no temporary file behind', { skip: process.getuid && process.getuid() === 0 }, async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compaction-')); const file = path.join(dir, 'c.json');
  const c = createCompaction({ file, persist: true, log: () => {}, post: async () => 'ok', resetSession: async () => {}, getAgent: () => ({ name: 'a', compaction: { mode: 'on', at: 0.5 } }) });
  await c.noteUsage('a', 400, 1000, 's1'); c.flush();
  fs.chmodSync(file, 0o600);
  await c.noteUsage('a', 500, 1000, 's1'); c.flush();
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepStrictEqual(fs.readdirSync(dir), ['c.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});


// ---- brief acceptance: written during the run, or (agent's own request only) shortly before it ----
const BASE = 1_800_000_000_000;
function makeBrief({ mode = 'on', bytes = 900 } = {}) {
  let t = BASE; let brief = null; let onPost = null;
  const posts = []; const resets = [];
  const c = createCompaction({
    now: () => t, log: () => {}, persist: false,
    post: async (agent, message) => { posts.push(message); if (onPost) onPost(message); return 'ok'; },
    resetSession: async (agent) => { resets.push(agent); },
    getAgent: () => ({ name: 'a', compaction: { mode, at: 0.5 } }),
    chunkCharsFor: async () => 2000, getRecentRows: async () => [],
    briefStatus: async () => brief ? { exists: true, bytes: brief.bytes === undefined ? bytes : brief.bytes, mtimeMs: brief.mtimeMs } : { exists: false, bytes: 0, mtimeMs: 0 },
  });
  const sess = (id = 's1') => { c.noteUsage('a', 10, 1000, id); };   // stand-in session id; below the threshold, so nothing runs
  sess();
  return { c, sess, posts, resets, now: () => t, tick: (ms) => { t += ms; },
    setBrief: (mtimeMs, b) => { brief = { mtimeMs, ...(b || {}) }; }, clearBrief: () => { brief = null; },
    duringPost: (fn) => { onPost = fn; } };
}
const SEC = 1000;
const FAIL = /didn't write its brief during the compression turn.*the session was kept/;

test('brief written during the run -> reset (agent, threshold and owner runs alike)', async () => {
  for (const reason of ['agent', 'threshold', 'owner']) {
    const h = makeBrief();
    if (reason === 'agent') { h.sess(); h.c.request('a', 'agent'); }
    h.duringPost((m) => { if (/from the hub/.test(m) && !/Resumed/.test(m)) { h.tick(20 * SEC); h.setBrief(h.now()); } });
    const r = await h.c.run('a', reason);
    assert.deepStrictEqual([reason, r.ok, r.reset], [reason, true, true]);
    assert.deepStrictEqual(h.resets, ['a']);
  }
});

test('agent request + brief written 30 s before the request -> reset; the stand-in clock is injected, no real files', async () => {
  const h = makeBrief();
  h.setBrief(h.now() - 30 * SEC);
  h.sess(); h.c.request('a', 'agent');
  h.tick(15 * SEC);                       // the request waits for the turn to end
  const r = await h.c.run('a', 'agent');
  assert.deepStrictEqual([r.ok, r.reset, r.error], [true, true, null]);
  assert.strictEqual(h.resets.length, 1);
});

test('agent request + brief written 10 minutes before -> refused, session kept, plain failure text', async () => {
  const h = makeBrief();
  h.setBrief(h.now() - 10 * 60 * SEC);
  h.sess(); h.c.request('a', 'agent');
  const r = await h.c.run('a', 'agent');
  assert.deepStrictEqual([r.ok, r.reset], [false, false]);
  assert.match(r.error, FAIL);
  assert.match(r.error, /next threshold or when the agent asks/);
  assert.deepStrictEqual(h.resets, []);
  assert.strictEqual(h.posts.length, 1, 'no resume turn');
});

test('threshold run + brief written 10 s before -> refused (unchanged rule, no relaxed window)', async () => {
  const h = makeBrief();
  h.setBrief(h.now() - 10 * SEC);
  const r = await h.c.run('a', 'threshold');
  assert.deepStrictEqual([r.ok, r.reset], [false, false]);
  assert.match(r.error, FAIL);
  // a stray agent request does not widen a threshold run either
  h.sess(); h.c.request('a', 'agent');
  const r2 = await h.c.run('a', 'threshold');
  assert.strictEqual(r2.reset, false);
  assert.deepStrictEqual(h.resets, []);
});

test('owner run + brief written 10 s before -> refused; 4 s before still passes the old tolerance', async () => {
  const h = makeBrief();
  h.setBrief(h.now() - 10 * SEC);
  const r = await h.c.run('a', 'owner');
  assert.deepStrictEqual([r.ok, r.reset], [false, false]);
  assert.match(r.error, FAIL);
  h.setBrief(h.now() - 4 * SEC);
  const r2 = await h.c.run('a', 'owner');
  assert.strictEqual(r2.reset, true);
});

test('a brief not newer than the previous compactedAt is rejected, even inside the 5 s tolerance and for an agent request', async () => {
  const h = makeBrief();
  h.duringPost((m) => { if (!/Resumed/.test(m)) h.setBrief(h.now()); });
  assert.strictEqual((await h.c.run('a', 'owner')).reset, true);
  const prev = Date.parse(h.c.compactedAt('a'));
  assert.ok(prev, 'compactedAt recorded');
  h.duringPost(null);
  h.tick(1 * SEC);
  h.setBrief(prev);                       // the old session's brief: equal to compactedAt, within 5 s of the new run
  const r = await h.c.run('a', 'owner');
  assert.deepStrictEqual([r.ok, r.reset], [false, false]);
  assert.match(r.error, FAIL);
  h.setBrief(prev - 1 * SEC);             // older still, and the agent's own request with its 120 s grace
  h.sess(); h.c.request('a', 'agent');
  const r2 = await h.c.run('a', 'agent');
  assert.deepStrictEqual([r2.ok, r2.reset], [false, false]);
  h.setBrief(prev + 1);                   // strictly newer is fine
  h.sess(); h.c.request('a', 'agent');
  const r3 = await h.c.run('a', 'agent');
  assert.strictEqual(r3.reset, true);
});

test('both prompts tell the agent to overwrite the brief during THIS turn, and keep their other wording', () => {
  const { assistedFinalPrompt } = require('../lib/compaction');
  const prompts = [compressionPrompt({ agent: 'a', pct: 80, mode: 'on', reason: 'agent' }), assistedFinalPrompt({ reason: 'agent', pct: 80 })];
  for (const p of prompts) {
    assert.ok(p.includes('Overwrite it during THIS turn even if you updated it a moment ago, so it includes everything that happened since.'));
    assert.ok(!/Write it \(overwrite it\)/.test(p));
    assert.doesNotMatch(p, /only after it sees the brief written in this run/); assert.match(p, new RegExp(BRIEF_FILE));
  }
  assert.match(prompts[0], /FRESH session seeded with your Records/); assert.match(prompts[0], /Replace the previous brief/);
  assert.match(prompts[1], /# Working brief/); assert.match(prompts[1], /Reply "brief written"/);
});

test('assisted mode accepts a brief written 30 s before the agent request, through the final prompt', async () => {
  const h = makeBrief({ mode: 'assisted' });
  h.setBrief(h.now() - 30 * SEC);
  h.sess(); h.c.request('a', 'agent');
  const r = await h.c.run('a', 'agent');
  assert.deepStrictEqual([r.ok, r.reset], [true, true]);
  assert.match(h.posts[0], /THIS turn/);
});

test('the 120 s boundary: exactly request-120 s is accepted, one ms older is not', async () => {
  const h = makeBrief();
  const reqAt = h.now();
  h.sess(); h.c.request('a', 'agent');
  h.setBrief(reqAt - 120 * SEC - 1);
  const r = await h.c.run('a', 'agent');
  assert.deepStrictEqual([r.ok, r.reset], [false, false]);
  h.sess(); h.c.request('a', 'agent');              // a fresh request, a fresh time
  h.setBrief(h.now() - 120 * SEC);
  const r2 = await h.c.run('a', 'agent');
  assert.deepStrictEqual([r2.ok, r2.reset], [true, true]);
});

test('a queued agent request runs late but is judged from the original request time', async () => {
  const h = makeBrief();
  const reqAt = h.now();
  h.setBrief(reqAt - 60 * SEC);           // written a minute before the request
  h.sess(); h.c.request('a', 'agent');
  h.tick(10 * 60 * SEC);                  // a long turn kept it waiting; a second request must not move the time
  h.c.request('a', 'agent');
  const r = await h.c.noteUsage('a', 10, 1000, 's1');   // the queued request runs now
  assert.deepStrictEqual([r.ok, r.reset], [true, true], 'accepted against the original request time (run started 10 min later)');
});

test('too-small and missing briefs are refused even when the request is fresh', async () => {
  const { MIN_BRIEF_BYTES } = require('../lib/compaction');
  const h = makeBrief();
  h.setBrief(h.now() - 5 * SEC, { bytes: MIN_BRIEF_BYTES - 1 });
  h.sess(); h.c.request('a', 'agent');
  const r = await h.c.run('a', 'agent');
  assert.deepStrictEqual([r.reset, /didn't write/.test(r.error)], [false, true]);
  h.clearBrief();
  h.sess(); h.c.request('a', 'agent');
  const r2 = await h.c.run('a', 'agent');
  assert.deepStrictEqual([r2.reset, /no brief found/.test(r2.error)], [false, true]);
  h.setBrief(h.now() - 5 * SEC, { bytes: MIN_BRIEF_BYTES });
  h.sess(); h.c.request('a', 'agent');
  assert.strictEqual((await h.c.run('a', 'agent')).reset, true, 'exactly the minimum is enough');
  assert.deepStrictEqual(h.resets.length, 1);
});

test('a direct run(agent) with no request cannot reuse a stale timestamp: the consumed time is cleared', async () => {
  const h = makeBrief();
  h.setBrief(h.now() - 30 * SEC);
  // no request at all: a direct run gets no grace
  const r0 = await h.c.run('a', 'agent');
  assert.strictEqual(r0.reset, false);
  // a request is made and consumed by a run that fails...
  h.setBrief(h.now() - 10 * 60 * SEC);
  h.sess(); h.c.request('a', 'agent');
  assert.strictEqual((await h.c.run('a', 'agent')).reset, false);
  // ...later a direct run must not reuse it, even with a brief inside what that old request allowed
  h.tick(5 * 60 * SEC);
  h.setBrief(h.now() - 30 * SEC);
  const r2 = await h.c.run('a', 'agent');
  assert.deepStrictEqual([r2.reset, /didn't write/.test(r2.error)], [false, true]);
  // an owner request does not grant the agent's window either
  h.c.request('a', 'owner');
  assert.strictEqual((await h.c.run('a', 'agent')).reset, false);
  assert.deepStrictEqual(h.resets, []);
});


test('session-bound grace: same id allows the 120 s window', async () => {
  const h = makeBrief();
  h.setBrief(h.now() - 60 * SEC);
  h.sess('sX'); h.c.request('a', 'agent');
  h.tick(5 * SEC);
  const r = await h.c.run('a', 'agent');
  assert.deepStrictEqual([r.ok, r.reset], [true, true]);
});

test('session-bound grace: id changed between request and run -> strict window (old brief refused, fresh accepted)', async () => {
  const h = makeBrief();
  h.setBrief(h.now() - 60 * SEC);
  h.sess('sOld'); h.c.request('a', 'agent');
  const r = await h.c.noteUsage('a', 10, 1000, 'sNew');   // the turn ended in a new session: the queued request runs now
  assert.deepStrictEqual([r.ok, r.reset], [false, false]);
  assert.match(r.error, FAIL);
  h.sess('sOld'); h.c.request('a', 'agent');
  h.setBrief(h.now() - 2 * SEC);          // inside the strict run-start-5s window
  const r2 = await h.c.noteUsage('a', 10, 1000, 'sNew');
  assert.deepStrictEqual([r2.ok, r2.reset], [true, true]);
});

test('session-bound grace: a duplicate request keeps the original id binding', async () => {
  const h = makeBrief();
  h.setBrief(h.now() - 60 * SEC);
  h.sess('sOld'); h.c.request('a', 'agent');
  h.c.request('a', 'agent');              // duplicate while pending: same binding
  assert.strictEqual(h.c.get('a').requestedSessionId, 'sOld');
  const r = await h.c.noteUsage('a', 10, 1000, 'sNew');
  assert.strictEqual(r.reset, false, 'bound to sOld, run under sNew');
});

test('session-bound grace: no recorded id (no session known at request time) -> strict window; id is consumed by the run', async () => {
  const h = makeBrief();
  const c2 = createCompaction({ now: h.now, log: () => {}, persist: false, post: async () => 'ok', resetSession: async () => { h.resets.push('x'); },
    getAgent: () => ({ name: 'a', compaction: { mode: 'on', at: 0.5 } }), getRecentRows: async () => [],
    briefStatus: async () => ({ exists: true, bytes: 900, mtimeMs: h.now() - 60 * SEC }) });
  c2.request('a', 'agent');               // never saw a session id
  const r = await c2.noteUsage('a', 10, 1000, 's1');   // an id appears afterwards; it was not bound at request time
  assert.deepStrictEqual([r.ok, r.reset], [false, false]);
  assert.strictEqual(c2.get('a').requestedSessionId, null, 'cleared by the run');
});
