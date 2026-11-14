'use strict';
// Voice phase 2, review round 1: the server fixes S-a to S-g. Fake docker, fake clock, fake bus; no real process or box.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable, Writable } = require('node:stream');
// lib/ comes from a throwaway install (test/helpers/isolated-install.js), so nothing under the real data/ is touched.
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('voice-p2-r1-iso-');
const L = (p) => require(path.join(ISO.lib, p));
const { createSandbox } = L('sandbox');
const { createVoiceCalls } = L('voice/call');
const cq = L('consult-queue');

function rig() {
  const clock = { t: Date.parse('2026-11-12T20:00:00Z') };
  const events = [];
  const bus = { publish: (type, data) => { events.push({ type, ...data }); } };
  const calls = createVoiceCalls({ now: () => clock.t, bus, setInterval: () => ({ unref() {} }), clearInterval: () => {} });
  return { calls, clock, events, ofType: (t) => events.filter(e => e.type === t) };
}
const consult = (over = {}) => ({ id: 'consult:helper:planner:abc', kind: 'consultation', label: 'Review the draft', from: 'helper', ...over });
const queueRig = () => new cq.ConsultQueue({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-r1-')), 'q.json'), now: () => 1_000_000 });

// ── S-a: Stop before the wrapper wrote its pid ───────────────────────────────────────────────────

function sandboxRig() {
  const calls = [];
  const states = { 'hub-agent-boxed': 'running' };
  let hang = null;
  const docker = async (args) => {
    calls.push(args);
    const cmd = args[0];
    if (cmd === 'inspect') return { stdout: args.includes('{{.HostConfig.Init}}') ? 'true\n' : 'running\n', stderr: '' };
    if (cmd === 'exec' && args.includes('setsid')) return new Promise((resolve) => { hang = resolve; });   // the command: never ends by itself
    if (cmd === 'exec' && args.includes('stat')) throw new Error('no file');
    return { stdout: '', stderr: '' };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-r1-'));
  const creds = path.join(dir, '.credentials.json'); fs.writeFileSync(creds, '{"tok":1}');
  const ws = (a) => path.join(dir, 'workspaces', a.name);
  const sb = createSandbox({
    docker, wrapperDir: path.join(dir, 'wrappers'), credentialsFile: creds, uid: 1000, gid: 1000, image: 'agent-hub-sandbox:test', log: () => {},
    getSetting: () => undefined, isMemberOwned: (a) => !!(a && a.owner && a.owner !== 'admin1'),
    rootsFor: (a) => [os.tmpdir(), '/tmp', ws(a)], workspaceFor: ws,
  });
  fs.mkdirSync(ws({ name: 'boxed' }), { recursive: true });
  return { sb, calls, release: () => hang && hang({ stdout: '', stderr: '' }), states };
}
const boxed = { name: 'boxed', model: 'claude-sdk/claude-haiku-5-5', owner: 'member1' };

test('S-a: a Stop before the wrapper wrote its pid leaves a cancel marker and waits up to 2 s for the pid file before killing the group', async () => {
  const r = sandboxRig();
  const ac = new AbortController();
  const p = r.sb.exec(boxed, 'sleep 100', { signal: ac.signal });
  for (let i = 0; i < 100 && !r.calls.some(a => a.includes('setsid')); i++) await new Promise(res => setTimeout(res, 5));
  ac.abort();
  const res = await p;
  assert.strictEqual(res.aborted, true);
  const run = r.calls.find(a => a[0] === 'exec' && a.includes('setsid'));
  const wrapper = run[run.indexOf('-c') + 1];
  const id = /hub-exec-([0-9a-f]{12})\.pid/.exec(wrapper)[1];
  const kill = r.calls.map(a => a[a.length - 1]).find(s => /kill -TERM/.test(s));
  assert.ok(kill, 'a kill script ran in the box');
  assert.ok(kill.startsWith(`touch /tmp/.hub-exec-${id}.cancel;`), 'the marker is created first: ' + kill);
  assert.ok(/while \[ ! -s \/tmp\/\.hub-exec-[0-9a-f]+\.pid \] && \[ \$i -lt 20 \]; do sleep 0\.1;/.test(kill), '20 x 0.1 s wait for the pid file');
  assert.ok(kill.indexOf('sleep 0.1') < kill.indexOf('kill -TERM'), 'the wait comes before the kill');
  assert.ok(kill.includes('sleep 2; kill -KILL') && kill.endsWith(`rm -f /tmp/.hub-exec-${id}.pid`), 'TERM, 2 s, KILL, then the pid file is removed');
  assert.deepStrictEqual(r.calls.find(a => a.includes(kill)).slice(0, 4), ['exec', 'hub-agent-boxed', 'bash', '-c'], 'bash, not sh');
  r.release();
});

test('S-a: the wrapper checks the cancel marker right after writing its pid and before it runs the command', async () => {
  const r = sandboxRig();
  const p = r.sb.exec(boxed, 'echo hi');
  for (let i = 0; i < 100 && !r.calls.some(a => a.includes('setsid')); i++) await new Promise(res => setTimeout(res, 5));
  const run = r.calls.find(a => a[0] === 'exec' && a.includes('setsid'));
  const w = run[run.indexOf('-c') + 1];
  const id = /hub-exec-([0-9a-f]{12})\.pid/.exec(w)[1];
  const pid = `/tmp/.hub-exec-${id}.pid`, cancel = `/tmp/.hub-exec-${id}.cancel`;
  assert.ok(w.startsWith(`echo $$ > ${pid}; if [ -e ${cancel} ]; then rm -f ${pid} ${cancel}; exit 130; fi; bash -lc "$0"; rc=$?; rm -f ${pid} ${cancel}; exit $rc`), w);
  assert.ok(w.indexOf(`-e ${cancel}`) < w.indexOf('bash -lc'));
  r.release(); await p;
});

// ── S-b: call instance id ────────────────────────────────────────────────────────────────────────

test('S-b: every call has a callId; events carry it; a request naming another call id is stale and never touches the newer call', async () => {
  const r = rig();
  const a = r.calls.start('planner', { userId: 'u1', person: 'Sam' });
  assert.match(a.callId, /^call-[0-9a-f]{16}$/);
  assert.strictEqual(r.ofType('voice_call')[0].callId, a.callId);
  r.calls.holds('planner', consult({ id: 'c1' }));
  assert.strictEqual(r.ofType('voice_held')[0].callId, a.callId);
  assert.strictEqual(r.calls.heartbeat('planner', 'u1', a.callId).callId, a.callId);

  // the same person starts again (reload): a new instance, the held items carried over
  const b = r.calls.start('planner', { userId: 'u1', person: 'Sam' });
  assert.notStrictEqual(b.callId, a.callId);
  assert.deepStrictEqual(b.held.map(i => i.id), ['c1']);
  assert.strictEqual(r.ofType('voice_call').pop().callId, b.callId);

  // the old page is late: nothing it says changes the new call
  assert.strictEqual(r.calls.heartbeat('planner', 'u1', a.callId).error, 'stale_call');
  assert.strictEqual(r.calls.setMode('planner', 'u1', 'dnd', a.callId).error, 'stale_call');
  assert.strictEqual(r.calls.end('planner', 'u1', a.callId).error, 'stale_call');
  assert.strictEqual((await r.calls.decide('planner', 'u1', 'c1', 'now', a.callId)).error, 'stale_call');
  assert.strictEqual(r.calls.onCall('planner'), true);
  assert.strictEqual(r.calls.statusOf('planner').mode, 'announce');
  assert.strictEqual(r.calls.statusOf('planner').held[0].state, 'held');

  // the current id works; a request without an id still works
  assert.strictEqual((await r.calls.decide('planner', 'u1', 'c1', 'later', b.callId)).ok, true);
  assert.strictEqual(r.ofType('voice_held_done').pop().callId, b.callId);
  assert.strictEqual(r.calls.heartbeat('planner', 'u1').callId, b.callId);
  const out = r.calls.end('planner', 'u1', b.callId);
  assert.deepStrictEqual(out.held.map(i => i.id), ['c1']);
  const off = r.ofType('voice_call').pop();
  assert.deepStrictEqual([off.state, off.callId], ['off', b.callId]);
});

// ── routes ───────────────────────────────────────────────────────────────────────────────────────

function fakeRes() {
  const chunks = [];
  const r = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  r.writeHead = (code) => { r.statusCode = code; r.headersSent = true; };
  r.json = () => JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return r;
}
const owner = { id: 'u_owner', role: 'admin', name: 'Owner' };
const sam = { id: 'u_sam', role: 'member', name: 'Sam' };
const alex = { id: 'u_alex', role: 'member', name: 'Alex' };
async function post(deps, url, body, user = sam) {
  const routes = L('voice/routes');
  const res = fakeRes();
  const done = new Promise(resolve => res.on('finish', resolve));
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', url, headers: {}, hubUser: user, hubService: false });
  await routes.handle(url, req, res, deps);
  if (!res.writableEnded) res.end();
  await done;
  return { status: res.statusCode, json: res.json() };
}
function routeRig() {
  const r = rig();
  const deps = {
    jsonResponse: (res, code, data) => { res.writeHead(code); res.end(JSON.stringify(data)); },
    readBody: (req) => new Promise((resolve) => { let s = ''; req.on('data', c => { s += c; }); req.on('end', () => resolve(s)); }),
    getSetting: () => undefined, updateSettings: () => {}, getAgents: async () => [],
    getVoice: () => ({ engine: { status: () => ({}), paths: {} }, client: {} }),
    voiceCall: r.calls,
  };
  return { ...r, deps };
}

test('S-b: the routes return callId, pass it through, and answer 409 stale_call for another call\'s id', async () => {
  const r = routeRig();
  const start = await post(r.deps, '/api/voice/call', { agent: 'sam_assistant', action: 'start' });
  const id = start.json.call.callId;
  assert.deepStrictEqual(Object.keys(start.json.call).sort(), ['callId', 'held', 'mode', 'person', 'since']);
  assert.match(id, /^call-/);
  r.calls.holds('sam_assistant', consult({ id: 'c1' }));
  assert.strictEqual((await post(r.deps, '/api/voice/call', { agent: 'sam_assistant', action: 'heartbeat', callId: id })).json.call.callId, id);
  assert.strictEqual((await post(r.deps, '/api/voice/call', { agent: 'sam_assistant', action: 'mode', mode: 'dnd', callId: id })).json.call.mode, 'dnd');
  for (const body of [{ action: 'heartbeat' }, { action: 'mode', mode: 'announce' }, { action: 'end' }]) {
    const x = await post(r.deps, '/api/voice/call', { agent: 'sam_assistant', callId: 'call-old', ...body });
    assert.deepStrictEqual([x.status, x.json.error], [409, 'stale_call'], JSON.stringify(body));
  }
  const d = await post(r.deps, '/api/voice/call/decide', { agent: 'sam_assistant', id: 'c1', choice: 'now', callId: 'call-old' });
  assert.deepStrictEqual([d.status, d.json.error], [409, 'stale_call']);
  assert.strictEqual(r.calls.onCall('sam_assistant'), true, 'the newer call was never ended');
  const ok = await post(r.deps, '/api/voice/call/decide', { agent: 'sam_assistant', id: 'c1', choice: 'later', callId: id });
  assert.deepStrictEqual([ok.status, ok.json.ok], [200, true]);
  const end = await post(r.deps, '/api/voice/call', { agent: 'sam_assistant', action: 'end', callId: id });
  assert.deepStrictEqual([end.status, end.json.ok, end.json.held.map(i => [i.id, i.state])], [200, true, [['c1', 'later']]]);
  assert.strictEqual((await post(r.deps, '/api/voice/call/decide', { agent: 'sam_assistant', id: 'c1', choice: 'now', callId: id })).status, 409, 'no_call');
});

// ── S-e: admins may end, decide and change the mode of any call ──────────────────────────────────

test('S-e: an admin may end, decide and change the mode of a member\'s call; another member may not; heartbeat and start stay with the starter', async () => {
  const r = routeRig();
  const start = await post(r.deps, '/api/voice/call', { agent: 'sam_assistant', action: 'start' });
  const id = start.json.call.callId;
  r.calls.holds('sam_assistant', consult({ id: 'c1' })); r.calls.holds('sam_assistant', consult({ id: 'c2' }));
  assert.strictEqual((await post(r.deps, '/api/voice/call', { agent: 'sam_assistant', action: 'mode', mode: 'dnd', callId: id }, alex)).status, 403);
  assert.strictEqual((await post(r.deps, '/api/voice/call/decide', { agent: 'sam_assistant', id: 'c1', choice: 'now', callId: id }, alex)).status, 403);
  assert.strictEqual((await post(r.deps, '/api/voice/call', { agent: 'sam_assistant', action: 'end', callId: id }, alex)).status, 403);
  assert.strictEqual((await post(r.deps, '/api/voice/call', { agent: 'sam_assistant', action: 'heartbeat', callId: id }, owner)).status, 403);
  assert.strictEqual((await post(r.deps, '/api/voice/call', { agent: 'sam_assistant', action: 'start' }, owner)).status, 403);
  assert.strictEqual((await post(r.deps, '/api/voice/call', { agent: 'sam_assistant', action: 'mode', mode: 'dnd', callId: id }, owner)).json.call.mode, 'dnd');
  assert.strictEqual((await post(r.deps, '/api/voice/call/decide', { agent: 'sam_assistant', id: 'c1', choice: 'later', callId: id }, owner)).status, 200);
  const end = await post(r.deps, '/api/voice/call', { agent: 'sam_assistant', action: 'end', callId: id }, owner);
  assert.deepStrictEqual([end.status, end.json.ok], [200, true]);
  assert.strictEqual(r.calls.onCall('sam_assistant'), false);
});

// ── S-c: a later job that is allowed runs during the call ────────────────────────────────────────

test('S-c: drain picks the FIRST job that is not held; the held ones keep their order', async () => {
  const q = queueRig(); const ran = [];
  const a = q.enqueue({ from: 'helper', to: 'planner', prompt: 'first' }).job;
  const b = q.enqueue({ from: 'helper', to: 'planner', prompt: 'second' }).job;
  const c = q.enqueue({ from: 'helper', to: 'planner', prompt: 'third' }).job;
  const heldIds = new Set([a.id, b.id]);
  const n = await q.drain({ isActive: () => false, isHeld: (j) => heldIds.has(j.id), run: async (j) => { ran.push(j.prompt); return 'ok'; } });
  assert.strictEqual(n, 1);
  assert.deepStrictEqual(ran, ['third'], '"Now" on a later job runs it during the call');
  assert.deepStrictEqual(q.pendingFor('planner').map(j => j.prompt), ['first', 'second'], 'the held ones keep their order');
  void c;
});

// ── S-d: skip ─────────────────────────────────────────────────────────────────────────────────────

test('S-d: declineJob refuses only the job that is running, not any job of that target', async () => {
  const q = queueRig();
  const a = q.enqueue({ from: 'helper', to: 'planner', prompt: 'held one' }).job;
  const b = q.enqueue({ from: 'helper', to: 'planner', prompt: 'allowed one' }).job;
  let during = null;
  await q.drain({ isActive: () => false, isHeld: (j) => j.id === a.id, run: async () => { during = [q.declineJob(a.id, 'no thanks'), q.declineJob(b.id, 'no thanks')]; return 'ok'; } });
  assert.deepStrictEqual(during, [true, false], 'the other job may be declined; the running one may not');
  assert.strictEqual(q.takeMailbox('helper').filter(m => m.status === 'declined').length, 1);
  // a stopped caller must not drop the running job even when it is not the first one
  const c = q.enqueue({ from: 'helper', to: 'planner', prompt: 'x1' }).job;
  const d = q.enqueue({ from: 'helper', to: 'planner', prompt: 'x2' }).job;
  let dropped = null;
  await q.drain({ isActive: () => false, isHeld: (j) => j.id === c.id, run: async () => { dropped = q.cancelFrom('helper', { sinceTs: 0 }); return 'ok'; } });
  assert.strictEqual(dropped, 1, 'only the job that is not running is dropped');
  void d;
});

test('S-d: decide awaits the producer\'s async onSkip; a refusal (false or a throw) keeps the item held and answers cannot_skip', async () => {
  const r = rig(); const seen = [];
  let verdict = false;
  r.calls.registerProducer('consultation', { onSkip: async (agent, item) => { seen.push(item.id); await new Promise(res => setTimeout(res, 10)); if (verdict === 'throw') throw new Error('busy'); return verdict; } });
  const a = r.calls.start('planner', { userId: 'u1', person: 'Sam' });
  r.calls.holds('planner', consult({ id: 'c1' }));
  assert.deepStrictEqual(await r.calls.decide('planner', 'u1', 'c1', 'skip', a.callId), { error: 'cannot_skip' });
  verdict = 'throw';
  assert.deepStrictEqual(await r.calls.decide('planner', 'u1', 'c1', 'skip', a.callId), { error: 'cannot_skip' });
  assert.deepStrictEqual(r.calls.statusOf('planner').held.map(i => [i.id, i.state]), [['c1', 'held']], 'the item stays held');
  assert.strictEqual(r.ofType('voice_held_done').length, 0, 'nothing was announced as done');
  verdict = true;
  const ok = await r.calls.decide('planner', 'u1', 'c1', 'skip', a.callId);
  assert.deepStrictEqual(ok, { ok: true, choice: 'skip' });
  assert.deepStrictEqual(r.calls.statusOf('planner').held, []);
  assert.deepStrictEqual(r.ofType('voice_held_done').map(e => [e.id, e.choice, e.callId]), [['c1', 'skip', a.callId]]);
  assert.strictEqual(seen.length, 3);
});

test('S-d: the route answers 409 cannot_skip', async () => {
  const r = routeRig();
  r.calls.registerProducer('consultation', { onSkip: async () => false });
  const start = await post(r.deps, '/api/voice/call', { agent: 'sam_assistant', action: 'start' });
  r.calls.holds('sam_assistant', consult({ id: 'c1' }));
  const x = await post(r.deps, '/api/voice/call/decide', { agent: 'sam_assistant', id: 'c1', choice: 'skip', callId: start.json.call.callId });
  assert.deepStrictEqual([x.status, x.json.error], [409, 'cannot_skip']);
});

// ── S-f: job notices ──────────────────────────────────────────────────────────────────────────────

test('S-f: skip on a job notice or report means after the call: kept as "later", not announced again, never removed', async () => {
  const r = rig(); const kicked = [];
  let skipCalled = false;
  for (const k of ['job_notice', 'job_report']) r.calls.registerProducer(k, { kick: () => kicked.push(k), onSkip: () => { skipCalled = true; } });
  const a = r.calls.start('analyst', { userId: 'u1', person: 'Sam' });
  r.calls.holds('analyst', { id: 'job:j1', kind: 'job_notice', label: 'build', from: 'analyst' });
  r.calls.holds('analyst', { id: 'job:j1:report', kind: 'job_report', label: 'build', from: 'analyst' });
  assert.deepStrictEqual(await r.calls.decide('analyst', 'u1', 'job:j1', 'skip', a.callId), { ok: true, choice: 'later' });
  assert.deepStrictEqual(await r.calls.decide('analyst', 'u1', 'job:j1:report', 'skip', a.callId), { ok: true, choice: 'later' });
  assert.strictEqual(skipCalled, false, 'the producer never drops it');
  assert.deepStrictEqual(r.calls.statusOf('analyst').held.map(i => i.state), ['later', 'later']);
  assert.strictEqual(r.calls.holds('analyst', { id: 'job:j1', kind: 'job_notice', label: 'build', from: 'analyst' }), true);
  assert.strictEqual(r.ofType('voice_held').length, 2, 'not announced again');
  assert.deepStrictEqual(r.ofType('voice_held_done').map(e => e.choice), ['later', 'later']);
  r.calls.end('analyst', 'u1', a.callId);
  assert.deepStrictEqual(kicked.sort(), ['job_notice', 'job_report'], 'delivered after hang-up');
});

test('S-f: "later" marks the item with state later; items carry held | later | done', async () => {
  const r = rig();
  const a = r.calls.start('planner', { userId: 'u1', person: 'Sam' });
  r.calls.holds('planner', consult({ id: 'c1' })); r.calls.holds('planner', consult({ id: 'c2' }));
  await r.calls.decide('planner', 'u1', 'c1', 'later', a.callId);
  r.calls.release('planner', 'c2');
  assert.deepStrictEqual(r.calls.statusOf('planner').held.map(i => [i.id, i.state]), [['c1', 'later'], ['c2', 'done']]);
});

// ── S-g: holdConsultForCall enqueues first ───────────────────────────────────────────────────────

test('S-g: a request that cannot be queued is never announced to the person', async () => {
  const { holdConsultForCall } = L('sdk-chat');
  const r = rig(); const q = queueRig();
  r.calls.start('planner', { userId: 'u1', person: 'Sam' });
  for (let i = 0; i < cq.MAX_PER_PAIR; i++) await holdConsultForCall('planner', `request ${i}`, 'helper', { queue: q, calls: r.calls, displayOf: async () => 'Planner' });
  assert.strictEqual(r.ofType('voice_held').length, cq.MAX_PER_PAIR);
  const full = await holdConsultForCall('planner', 'one too many', 'helper', { queue: q, calls: r.calls, displayOf: async () => 'Planner' });
  assert.match(full, /^\[NOT QUEUED\]/);
  assert.strictEqual(r.ofType('voice_held').length, cq.MAX_PER_PAIR, 'no held item, no announcement for a request that is not queued');
  assert.ok(!r.calls.statusOf('planner').held.some(i => /one too many/.test(i.label)));
});

test('S-g: after a skip, sending the same consult again is a new item and is announced again', async () => {
  const { holdConsultForCall } = L('sdk-chat');
  const r = rig(); const q = queueRig();
  r.calls.registerProducer('consultation', { onSkip: async (agent, item) => q.declineJob(q.pendingFor(agent).find(j => cq.jobHoldId(j) === item.id).id, 'declined') });
  const a = r.calls.start('planner', { userId: 'u1', person: 'Sam' });
  const send = () => holdConsultForCall('planner', 'Please review this', 'helper', { queue: q, calls: r.calls, displayOf: async () => 'Planner' });
  assert.match(await send(), /queued/);
  const id = r.ofType('voice_held')[0].item.id;
  assert.deepStrictEqual(await r.calls.decide('planner', 'u1', id, 'skip', a.callId), { ok: true, choice: 'skip' });
  assert.strictEqual(q.pendingFor('planner').length, 0);
  assert.match(await send(), /queued/);
  assert.strictEqual(q.pendingFor('planner').length, 1, 'queued again');
  assert.strictEqual(r.ofType('voice_held').length, 2, 'announced again');
  assert.deepStrictEqual(r.calls.statusOf('planner').held.map(i => [i.id, i.state]), [[id, 'held']]);
});

test('S-g: wiring: holdConsultForCall enqueues before it holds, and the consultation producer\'s onSkip is async and answers false for a running job', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function holdConsultForCall('), src.indexOf('async function consultViaHub('));
  assert.ok(fn.indexOf('q.enqueue(') >= 0 && fn.indexOf('q.enqueue(') < fn.indexOf('calls.holds('));
  assert.ok(src.includes("voiceCall.registerProducer('consultation', {") && src.includes('onSkip: async (agent, item) => {'));
});
