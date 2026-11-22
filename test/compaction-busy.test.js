'use strict';
// The compression turn of a busy agent (lib/compaction + lib/sdk-chat postHubTurn): the hub answers 409 while another turn of that
// agent runs. The compression run must wait and ask again, never blame the agent for a turn that never started, never reset a session
// while another turn runs, and a postponed run must not start the one-hour gap. The real "asked and did not write" case stays as it was.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('compaction-busy-iso-');
const L = (p) => require(path.join(ISO.lib, p));
const { createCompaction, MIN_GAP_MS, BUSY_WAIT_MS, BUSY_RETRIES } = L('compaction');

const busyErr = () => Object.assign(new Error('the agent is busy (HTTP 409: Agent is busy; use interject or wait for the current turn.)'), { status: 409, busy: true });

/** A compaction with a fake clock: sleep(ms) advances it. busy(t) says whether the agent is in another turn at time t; script(i, msg) may
 *  throw (a refusal) or return a reply; a compression or assisted-final prompt that is answered writes the brief at that time, unless noWrite. */
function make({ mode = 'on', busy = () => false, script = null, noWrite = false, waitMs = BUSY_WAIT_MS, yieldEachSleep = false, onReset = null } = {}) {
  let t = 10_000_000; let briefAt = 0; let n = 0;
  const posts = [], resets = [], events = [], logs = [], busyAtReset = [];
  const isBusyNow = () => !!busy(t);
  const c = createCompaction({
    now: () => t, log: (s) => logs.push(s), persist: false,
    post: async (agent, message) => {
      const i = n++;
      if (script) { const r = script(i, message, t); if (r instanceof Error) throw r; }
      else if (isBusyNow()) throw busyErr();
      posts.push({ agent, message, at: t });
      if (!noWrite && /working-brief\.md/.test(message) && !/^\[Resumed/.test(message)) briefAt = t;
      return 'done';
    },
    resetSession: async (agent) => { busyAtReset.push(isBusyNow()); resets.push(agent); if (onReset) onReset(); },
    getAgent: (name) => ({ name, compaction: { mode, at: 0.5 } }),
    onEvent: (ev) => events.push(ev),
    getRecentRows: async () => [{ ts: '2026-11-22T10:00:00Z', kind: 'user', text: 'a'.repeat(3000) }, { ts: '2026-11-22T10:01:00Z', kind: 'assistant', text: 'b'.repeat(3000) }],
    chunkCharsFor: async () => 2000,
    briefStatus: async () => (briefAt ? { exists: true, bytes: 900, mtimeMs: briefAt } : { exists: true, bytes: 900, mtimeMs: 1 }),
    isBusy: () => isBusyNow(), sleep: (ms) => (yieldEachSleep ? new Promise((r) => setImmediate(() => { t += ms; r(); })) : Promise.resolve().then(() => { t += ms; })), busyWaitMs: waitMs,
  });
  return { c, posts, resets, events, logs, busyAtReset, now: () => t, tick: (ms) => { t += ms; } };
}
const ends = (events) => events.filter((e) => e.type === 'compaction_end');

test('busy at the threshold (fails on the old code): the run waits for the turn to end, then the agent is asked, writes its brief, the session resets; no failure', async () => {
  let t0 = 0;
  const h = make({ busy: (t) => t < t0 + 90_000 });
  t0 = h.now();
  const r = await h.c.noteUsage('anvil', 600, 1000, 's1');
  assert.deepStrictEqual([r.ok, r.reset, !!r.busy], [true, true, false], JSON.stringify(r));
  assert.ok(h.posts[0].at >= t0 + 90_000, 'asked only once the other turn ended');
  assert.deepStrictEqual(h.busyAtReset, [false], 'never reset while another turn runs');
  assert.strictEqual(ends(h.events)[0].ok, true);
  assert.ok(h.events.some((e) => e.type === 'compaction_waiting'));
  assert.ok(!h.logs.some((l) => /didn't write its brief/.test(l)));
});

test('a 409 from the hub (another turn slipped in) is asked again after waiting; the agent is never blamed', async () => {
  const h = make({ script: (i) => (i < 2 ? busyErr() : null) });
  const r = await h.c.run('forge', 'threshold');
  assert.deepStrictEqual([r.ok, r.reset], [true, true], JSON.stringify(r));
  assert.ok(!/didn't write/.test(String(r.error)));
});

test('the ceiling: an agent busy for the whole wait gives a "postponed" run in plain words; no reset, no one-hour gap, no blame', async () => {
  const h = make({ busy: () => true });
  const r = await h.c.run('maestro', 'threshold');
  assert.deepStrictEqual([r.ok, r.reset, r.busy], [false, false, true]);
  assert.match(r.error, /^the compression turn could not start: the agent stayed busy with other turns for 20 minutes; it will try again after a later turn$/);
  assert.strictEqual(h.posts.length, 0, 'the agent was never asked');
  assert.strictEqual(h.resets.length, 0);
  const end = ends(h.events)[0];
  assert.deepStrictEqual([end.ok, end.busy], [false, true]);
  assert.ok(!h.c.get('maestro').lastRunAt, 'the one-hour gap is not started');
  assert.strictEqual(h.c.get('maestro').runs.slice(-1)[0].busy, true);
  assert.strictEqual(h.c.get('maestro').running, false);
});

test('refusals are capped at BUSY_RETRIES per prompt even when the agent looks idle between them', async () => {
  const h = make({ script: () => busyErr() });
  const r = await h.c.run('worker', 'threshold');
  assert.deepStrictEqual([r.ok, r.busy], [false, true]);
  assert.ok(h.now() - 10_000_000 < BUSY_WAIT_MS, 'gave up on the refusal count, before the time ceiling');
});

test('after a postponed run the next turn end runs it again at once (no one-hour gap), and it succeeds', async () => {
  let idleFrom = Infinity;
  const h = make({ busy: (t) => t < idleFrom });
  const r1 = await h.c.noteUsage('anvil', 600, 1000, 's1');
  assert.strictEqual(r1.busy, true);
  idleFrom = h.now();
  const r2 = await h.c.noteUsage('anvil', 610, 1000, 's1');
  assert.ok(r2 && r2.ok && r2.reset, JSON.stringify(r2));
});

test('a real "asked and did not write" is still reported as before, and it starts the one-hour gap', async () => {
  const h = make({ noWrite: true });
  const r = await h.c.run('beacon', 'threshold');
  assert.strictEqual(r.ok, false); assert.ok(!r.busy);
  assert.match(r.error, /the agent didn't write its brief during the compression turn/);
  assert.strictEqual(h.posts.length, 1);
  assert.strictEqual(h.c.get('beacon').lastRunAt, h.now());
  assert.strictEqual(h.c.noteUsage('beacon', 900, 1000, 's1'), null, 'within the hour: no new run');
  h.tick(MIN_GAP_MS + 1);
  assert.ok(h.c.noteUsage('beacon', 900, 1000, 's1'));
});

test('agent-requested run postponed: the request is kept with its time and session, and runs at the next turn end', async () => {
  let idleFrom = Infinity;
  const h = make({ busy: (t) => t < idleFrom });
  h.c.noteUsage('maestro', 100, 1000, 's9');
  h.c.request('maestro', 'agent');
  const before = h.c.get('maestro');
  const r1 = await h.c.noteUsage('maestro', 110, 1000, 's9');
  assert.strictEqual(r1.busy, true);
  const kept = h.c.get('maestro');
  assert.deepStrictEqual([kept.requested, kept.requestedAt, kept.requestedSessionId], ['agent', before.requestedAt, 's9']);
  idleFrom = h.now();
  const r2 = await h.c.noteUsage('maestro', 120, 1000, 's9');
  assert.ok(r2 && r2.ok && r2.reset, JSON.stringify(r2));
  assert.strictEqual(h.c.get('maestro').requested, null);
});

test('assisted mode: a busy answer in the middle of the slices waits and carries on; every part is sent once', async () => {
  const h = make({ mode: 'assisted', script: (i) => (i === 1 ? busyErr() : null) });
  const r = await h.c.run('local1', 'threshold');
  assert.deepStrictEqual([r.ok, r.reset], [true, true], JSON.stringify(r));
  assert.ok(r.parts >= 2, String(r.parts));
  const sent = h.posts.map((p) => p.message);
  for (let i = 1; i <= r.parts; i++) assert.strictEqual(sent.filter((m) => m.includes(`part ${i} of ${r.parts}`) || m.includes(`${i}/${r.parts}`) || m.includes(`slice ${i} of ${r.parts}`)).length, 1, `slice ${i} sent exactly once`);
});

test('dry mode: busy then free gives a written brief and no reset, as before', async () => {
  let t0 = 0;
  const h = make({ mode: 'dry', busy: (t) => t < t0 + 30_000 });
  t0 = h.now();
  const r = await h.c.run('gp', 'threshold');
  assert.deepStrictEqual([r.ok, r.reset, r.mode], [true, false, 'dry']);
});

test('review r1: another turn starts between the compression turn and the reset: no reset on that brief; postponed (no gap); the next run asks for a fresh brief', async () => {
  let busyFrom = Infinity, busyTo = Infinity;
  const h = make({ busy: (t) => t >= busyFrom && t < busyTo, script: (i, m, t) => { if (i === 0) { busyFrom = t; busyTo = t + 45_000; } return null; } });
  const r = await h.c.run('anvil', 'threshold');
  assert.deepStrictEqual([r.ok, r.reset, r.busy], [false, false, true]);
  assert.strictEqual(r.error, 'another turn started after the brief was written, so the session was kept; a fresh brief is asked for after that turn');
  assert.strictEqual(h.resets.length, 0);
  assert.ok(!h.c.get('anvil').lastRunAt, 'no one-hour gap');
  h.tick(60_000);   // that turn ended
  const r2 = await h.c.noteUsage('anvil', 900, 1000, 's1');
  assert.ok(r2 && r2.ok && r2.reset, JSON.stringify(r2));
  assert.strictEqual(h.posts.filter((p) => /\[Context compression/.test(p.message)).length, 2, 'asked again for a fresh brief');
});

test('review r1: the reset is recorded (compactedAt, readings cleared) before the resume turn is sent', async () => {
  let seenAtResume = null;
  const h = make({ script: (i, m) => { if (/^\[Resumed/.test(m)) seenAtResume = h.c.get('anvil'); return null; } });
  h.c.noteUsage('anvil', 100, 1000, 's1');
  const r = await h.c.run('anvil', 'threshold');
  assert.ok(r.ok && r.reset);
  assert.ok(seenAtResume && seenAtResume.compactedAt && seenAtResume.sessionId === null && seenAtResume.tokens === 0, JSON.stringify(seenAtResume));
  assert.strictEqual(h.c.get('anvil').compactedAt, seenAtResume.compactedAt, 'the final write keeps the time of the reset');
});

test('review r1: the resume turn is skipped when another turn already runs (it opens the fresh session); a 409 on it is not an error', async () => {
  let busyNow = false;
  const h = make({ busy: () => busyNow, script: (i, m) => { if (!/^\[Resumed/.test(m)) return null; return busyErr(); } });
  const r = await h.c.run('anvil', 'threshold');
  assert.deepStrictEqual([r.ok, r.reset, r.resumed], [true, true, null]);
  assert.ok(h.logs.some((l) => /resume turn skipped/.test(l)));
  let started = false;
  const g = make({ busy: () => started, onReset: () => { started = true; } });   // the person's turn starts right after the reset
  const r2 = await g.c.run('forge', 'threshold');
  assert.deepStrictEqual([r2.ok, r2.reset, r2.resumed], [true, true, null]);
  assert.ok(!g.posts.some((x) => /^\[Resumed/.test(x.message)), 'the resume prompt is not sent into a running turn');
});

test('review r1: the refusal cap says how many refusals, not "20 minutes"', async () => {
  const h = make({ script: () => busyErr() });
  const r = await h.c.run('worker', 'threshold');
  assert.match(r.error, /^the compression turn could not start: the hub refused it 6 times \(the agent is busy \(HTTP 409: /);
  assert.doesNotMatch(r.error, /20 minutes/);
});

test('review r1: a request the agent makes while the run waits is answered by that run (no second compression right after)', async () => {
  let idleFrom = Infinity, asked = false;
  const h = make({ busy: (t) => { if (!asked && t > 10_000_000 + 4000) { asked = true; h.c.request('anvil', 'agent'); } if (t > 10_000_000 + 30_000 && idleFrom === Infinity) idleFrom = t; return t < idleFrom; } });
  const r = await h.c.run('anvil', 'threshold');
  assert.ok(r.ok && r.reset && asked, JSON.stringify(r));
  assert.strictEqual(h.c.get('anvil').requested, null);
  assert.strictEqual(h.c.noteUsage('anvil', 100, 1000, 's2'), null, 'nothing runs again at the next turn end');
});

test('no second compression while one waits: a run in progress answers "already running"', async () => {
  let release = false;
  const h = make({ busy: () => !release, yieldEachSleep: true });
  const p = h.c.run('anvil', 'threshold');
  await new Promise((r) => setImmediate(r));
  const r2 = await h.c.run('anvil', 'owner');
  assert.deepStrictEqual(r2, { ok: false, error: 'already running' });
  release = true;
  assert.strictEqual((await p).ok, true);
});

test('a refusal that is not busy (503 hub halted) is reported as a turn that could not start, not as a missing brief', async () => {
  const h = make({ script: () => Object.assign(new Error('the hub refused the turn (HTTP 503: hub halted)'), { status: 503 }) });
  const r = await h.c.run('anvil', 'threshold');
  assert.strictEqual(r.ok, false); assert.ok(!r.busy);
  assert.match(r.error, /^the compression turn could not start: the hub refused the turn \(HTTP 503: hub halted\)$/);
});

// ── lib/sdk-chat postHubTurn, its own source run against a real local server ──
function loadPostHubTurn(port) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  const a = src.indexOf('function postHubTurn('), b = src.indexOf('\nconst agentRequests', a);
  assert.ok(a > 0 && b > a, 'postHubTurn found');
  const ctx = { require: (m) => (m === './auth' ? { SERVICE_HEADER: 'x-hub-service', SERVICE_TOKEN: 't' } : require(m)), process: { env: { PORT: String(port) } }, Buffer, JSON, Error, String, Promise, setTimeout };
  vm.createContext(ctx);
  vm.runInContext(src.slice(a, b) + '\nthis.postHubTurn = postHubTurn;', ctx);
  return ctx.postHubTurn;
}
test('postHubTurn (fails on the old code): 2xx resolves the reply; 409 rejects busy; a voice-call hold is busy; 503 rejects with the hub reason; never an empty reply for a refusal', async () => {
  const answers = [[200, { response: 'hello' }], [409, { error: 'agent busy', detail: 'Agent is busy; use interject or wait for the current turn.' }], [409, { error: 'agent busy', detail: 'on_voice_call', agent: 'a' }], [503, { error: 'hub halted' }], [200, 'not json']];
  let i = 0;
  const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => { const [st, body] = answers[i++]; res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const post = loadPostHubTurn(srv.address().port);
    assert.strictEqual(await post('a', 'm'), 'hello');
    await assert.rejects(post('a', 'm'), (e) => e.status === 409 && e.busy === true && /the agent is busy \(HTTP 409: Agent is busy/.test(e.message));
    await assert.rejects(post('a', 'm'), (e) => e.status === 409 && e.busy === true && /on a voice call/.test(e.message));
    await assert.rejects(post('a', 'm'), (e) => e.status === 503 && !e.busy && /HTTP 503: hub halted/.test(e.message));
    assert.strictEqual(await post('a', 'm'), '', 'a 2xx that is not JSON stays an empty reply, as before');
  } finally { srv.close(); }
});

test('the pages show a postponed run as postponed, not failed; the health check does not count it as a failure', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8'), mob = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
  for (const src of [app, mob]) assert.match(src, /if \(ev\.busy\) [\s\S]{0,40}compression postponed: \$\{ev\.error/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'lib', 'memory-health.js'), 'utf8'), /!lastRun\.ok && !lastRun\.busy/);
  assert.ok(BUSY_RETRIES >= 1 && BUSY_WAIT_MS >= 60_000);
});
