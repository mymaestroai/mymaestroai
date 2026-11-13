'use strict';
// Agents "on a call" (lib/voice/call): while a person is on a hands-free voice call with an agent, hub-started turns for
// that agent wait (consultations, scheduled tasks, job notices and reports, hub tasks, queued replies) until the call ends
// or the person says now; skip drops them. Everything here uses a fake clock and a fake event bus; nothing starts a turn.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable, Writable } = require('node:stream');
const { createVoiceCalls, HELD_KINDS, EXPIRE_MS } = require('../lib/voice/call');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 3000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(15); } return false; }

function rig(extra = {}) {
  const clock = { t: Date.parse('2026-11-12T20:00:00Z') };
  const events = [];
  const bus = { publish: (type, data, opts) => { events.push({ type, ...data, _opts: opts }); } };
  const timers = [];
  const calls = createVoiceCalls({ now: () => clock.t, bus, setInterval: (fn, ms) => { const h = { fn, ms, unref() {} }; timers.push(h); return h; }, clearInterval: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); }, ...extra });
  const ofType = (type) => events.filter(e => e.type === type);
  return { calls, clock, events, ofType, timers };
}
const consult = (over = {}) => ({ id: 'consult:helper:planner:abc', kind: 'consultation', label: 'Review the draft', from: 'helper', ...over });

// ── the registry ────────────────────────────────────────────────────────────────────────────────

test('start / heartbeat / mode / end: one call per agent, owned by the person who started it; events carry the agent', () => {
  const r = rig();
  assert.strictEqual(r.calls.onCall('planner'), false);
  const v = r.calls.start('planner', { userId: 'u1', person: 'Sam', mode: 'announce' });
  assert.deepStrictEqual([v.mode, v.person, v.held], ['announce', 'Sam', []]);
  assert.ok(Date.parse(v.since));
  assert.strictEqual(r.calls.onCall('planner'), true);
  assert.deepStrictEqual(r.ofType('voice_call').map(e => [e.agent, e.state, e.mode, e.person]), [['planner', 'on', 'announce', 'Sam']]);
  assert.ok(r.events.every(e => e.agent === 'planner'), 'every event names the agent, so only people who may see it get it');

  assert.strictEqual(r.calls.heartbeat('planner', 'u1').mode, 'announce');
  assert.strictEqual(r.calls.setMode('planner', 'u1', 'dnd').mode, 'dnd');
  assert.strictEqual(r.calls.setMode('planner', 'u1', 'loud').error, 'bad_mode');
  assert.strictEqual(r.ofType('voice_call').pop().mode, 'dnd');

  // somebody else, an admin included, cannot touch it or take it over
  for (const r2 of [r.calls.heartbeat('planner', 'u2'), r.calls.setMode('planner', 'u2', 'announce'), r.calls.end('planner', 'u2'), r.calls.decide('planner', 'u2', 'x', 'now'), r.calls.start('planner', { userId: 'u2', person: 'Alex' })]) assert.strictEqual(r2.error, 'not_your_call');
  assert.strictEqual(r.calls.onCall('planner'), true);
  assert.strictEqual(r.calls.heartbeat('nobody', 'u1').error, 'no_call');

  // the same person starting again (a page reload) carries the call on
  assert.strictEqual(r.calls.start('planner', { userId: 'u1', person: 'Sam', mode: 'dnd' }).mode, 'dnd');
  assert.strictEqual(r.ofType('voice_call').filter(e => e.state === 'on' && e.agent === 'planner').length, 2, 'the mode change published; the restart did not publish a second "on"');
  assert.deepStrictEqual(r.calls.end('planner', 'u1'), { held: [] });
  assert.strictEqual(r.calls.onCall('planner'), false);
  assert.strictEqual(r.ofType('voice_call').pop().state, 'off');
  assert.deepStrictEqual(r.calls.end('planner', 'u1'), { held: [] }, 'ending twice is harmless');
});

test('holds: only waiting kinds are held; users, comms and alerts always go through; the first sighting is recorded and published once', () => {
  const r = rig();
  assert.strictEqual(r.calls.holds('planner', consult()), false, 'no call, nothing held');
  r.calls.start('planner', { userId: 'u1', person: 'Sam' });
  for (const kind of ['user', 'comms', 'alert', 'voice']) assert.strictEqual(r.calls.holds('planner', { id: `${kind}:1`, kind, label: 'x' }), false, kind);
  assert.deepStrictEqual([...HELD_KINDS].sort(), ['consult_reply', 'consultation', 'job_notice', 'job_report', 'schedule', 'task']);
  for (const kind of HELD_KINDS) assert.strictEqual(r.calls.holds('planner', { id: `${kind}:1`, kind, label: 'x' }), true, kind);
  assert.strictEqual(r.calls.holds('other', consult()), false, 'another agent is not on a call');

  const r2 = rig(); r2.calls.start('planner', { userId: 'u1', person: 'Sam' });
  assert.strictEqual(r2.calls.holds('planner', consult({ label: 'x'.repeat(200) })), true);
  assert.strictEqual(r2.calls.holds('planner', consult()), true, 'asked again: still held');
  const held = r2.ofType('voice_held');
  assert.strictEqual(held.length, 1, 'announced once');
  assert.strictEqual(held[0].agent, 'planner');
  assert.strictEqual(held[0].item.kind, 'consultation');
  assert.strictEqual(held[0].item.label.length, 80, 'label: first 80 characters');
  assert.deepStrictEqual([held[0].mode, held[0].quiet], ['announce', false]);
  assert.strictEqual(r2.calls.statusOf('planner').held.length, 1);
});

test('do not disturb: held items are announced quietly', () => {
  const r = rig(); r.calls.start('planner', { userId: 'u1', person: 'Sam', mode: 'dnd' });
  assert.strictEqual(r.calls.holds('planner', consult()), true);
  const ev = r.ofType('voice_held')[0];
  assert.deepStrictEqual([ev.quiet, ev.mode], [true, 'dnd']);
});

test('decide: now allows the item and kicks its producer; later keeps it; skip calls onSkip and removes it; all publish voice_held_done', () => {
  const r = rig(); const kicked = [], skipped = [];
  r.calls.registerProducer('consultation', { kick: () => kicked.push('consultation'), onSkip: (agent, item) => skipped.push([agent, item.id]) });
  r.calls.registerProducer('schedule', { kick: () => kicked.push('schedule') });
  r.calls.start('planner', { userId: 'u1', person: 'Sam' });
  r.calls.holds('planner', consult({ id: 'c1' })); r.calls.holds('planner', consult({ id: 'c2' })); r.calls.holds('planner', consult({ id: 'c3' }));
  r.calls.holds('planner', { id: 's1', kind: 'schedule', label: 'Nightly', from: 'schedule' });

  assert.deepStrictEqual(r.calls.decide('planner', 'u1', 'c1', 'now'), { ok: true, choice: 'now' });
  assert.strictEqual(r.calls.holds('planner', consult({ id: 'c1' })), false, 'allowed: the producer runs it on its next check');
  assert.deepStrictEqual(kicked, ['consultation']);

  assert.strictEqual(r.calls.decide('planner', 'u1', 'c2', 'later').ok, true);
  assert.strictEqual(r.calls.holds('planner', consult({ id: 'c2' })), true, 'later: stays held');
  assert.deepStrictEqual(kicked, ['consultation'], 'later kicks nothing');

  assert.strictEqual(r.calls.decide('planner', 'u1', 'c3', 'skip').ok, true);
  assert.deepStrictEqual(skipped, [['planner', 'c3']]);
  assert.ok(!r.calls.statusOf('planner').held.some(i => i.id === 'c3'), 'skipped items leave the list');
  assert.strictEqual(r.calls.holds('planner', consult({ id: 'c3' })), true, 'a skipped item that is asked about again stays out of the way, silently');
  assert.strictEqual(r.ofType('voice_held').filter(e => e.item.id === 'c3').length, 1);

  assert.strictEqual(r.calls.decide('planner', 'u1', 'nope', 'now').error, 'unknown_item');
  assert.strictEqual(r.calls.decide('planner', 'u1', 'c2', 'maybe').error, 'bad_choice');
  assert.deepStrictEqual(r.ofType('voice_held_done').map(e => [e.agent, e.id, e.choice]), [['planner', 'c1', 'now'], ['planner', 'c2', 'later'], ['planner', 'c3', 'skip']]);
});

test('end returns what came in during the call (not what was skipped) and kicks the producers that had something waiting', () => {
  const r = rig(); const kicked = [];
  for (const k of ['consultation', 'schedule', 'job_notice']) r.calls.registerProducer(k, { kick: () => kicked.push(k) });
  r.calls.start('planner', { userId: 'u1', person: 'Sam' });
  r.calls.holds('planner', consult({ id: 'c1' }));
  r.calls.holds('planner', { id: 's1', kind: 'schedule', label: 'Nightly', from: 'schedule' });
  r.calls.holds('planner', consult({ id: 'c2' })); r.calls.decide('planner', 'u1', 'c2', 'skip');
  const out = r.calls.end('planner', 'u1');
  assert.deepStrictEqual(out.held.map(i => [i.id, i.kind, i.state]), [['c1', 'consultation', 'held'], ['s1', 'schedule', 'held']]);
  assert.deepStrictEqual(kicked.sort(), ['consultation', 'schedule'], 'job notices had nothing waiting');
  assert.strictEqual(r.calls.holds('planner', consult({ id: 'c1' })), false, 'after the call nothing is held');
});

test('release: an item the producer ran is done; asking again later is a new item', () => {
  const r = rig(); r.calls.start('planner', { userId: 'u1', person: 'Sam' });
  r.calls.holds('planner', consult({ id: 'c1' })); r.calls.decide('planner', 'u1', 'c1', 'now');
  assert.strictEqual(r.calls.release('planner', 'c1'), true);
  assert.deepStrictEqual(r.calls.statusOf('planner').held.map(i => i.state), ['done']);
  assert.strictEqual(r.calls.holds('planner', consult({ id: 'c1' })), true, 'a new run of the same id waits again');
  assert.strictEqual(r.ofType('voice_held').length, 2);
});

test('expiry: no heartbeat for 60 seconds is a hang-up (checked lazily and by the 15 second timer), and the producers are kicked', () => {
  const r = rig(); const kicked = [];
  r.calls.registerProducer('consultation', { kick: () => kicked.push('consultation') });
  r.calls.start('planner', { userId: 'u1', person: 'Sam' });
  assert.deepStrictEqual(r.timers.map(t => t.ms), [15000], 'a 15 second timer');
  r.calls.holds('planner', consult());
  r.clock.t += EXPIRE_MS - 1000;
  assert.strictEqual(r.calls.heartbeat('planner', 'u1').mode, 'announce', 'a heartbeat just in time keeps it');
  r.clock.t += EXPIRE_MS - 1000;
  assert.strictEqual(r.calls.onCall('planner'), true);
  r.clock.t += 2000;   // 61 s since the last heartbeat
  assert.strictEqual(r.calls.onCall('planner'), false, 'lazily');
  assert.strictEqual(r.calls.holds('planner', consult()), false, 'nothing is held for a call that is over');
  assert.deepStrictEqual(r.ofType('voice_call').map(e => e.state), ['on', 'off']);
  assert.deepStrictEqual(kicked, ['consultation']);
  assert.strictEqual(r.timers.length, 0, 'the timer is cleared with the last call');

  // by the timer, with nobody asking
  const r2 = rig(); r2.calls.start('a', { userId: 'u1', person: 'Sam' }); r2.calls.start('b', { userId: 'u1', person: 'Sam' });
  r2.clock.t += 30000; r2.calls.heartbeat('b', 'u1'); r2.clock.t += 31000;
  r2.timers[0].fn();
  assert.deepStrictEqual(r2.ofType('voice_call').filter(e => e.state === 'off').map(e => e.agent), ['a']);
  assert.strictEqual(r2.calls.onCall('b'), true);
  assert.strictEqual(r2.ofType('voice_call').find(e => e.state === 'off').reason, 'expired');
});

test('a hub restart ends every call: the state is in memory only', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'voice', 'call.js'), 'utf8');
  assert.ok(!/require\('fs'\)|writeFile/.test(src));
  const t = rig().timers; assert.deepStrictEqual(t, []);
});

// ── the routes ──────────────────────────────────────────────────────────────────────────────────

function fakeRes() {
  const chunks = [];
  const r = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  r.writeHead = (code, headers) => { r.statusCode = code; r.headers = headers; r.headersSent = true; };
  r.json = () => JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return r;
}
function fakeReq(method, url, body, user) {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  return Object.assign(r, { method, url, headers: {}, hubUser: user, hubService: false });
}
const owner = { id: 'u_owner', role: 'admin', name: 'Owner' };
const sam = { id: 'u_sam', role: 'member', name: 'Sam' };

async function post(deps, url, body, user = sam) {
  const routes = require('../lib/voice/routes');
  const res = fakeRes();
  const done = new Promise(resolve => res.on('finish', resolve));
  await routes.handle(url, fakeReq('POST', url, body, user), res, deps);
  if (!res.writableEnded) res.end();
  await done;
  return { status: res.statusCode, json: res.json() };
}
function routeRig() {
  const r = rig();
  const deps = {
    jsonResponse: (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); },
    readBody: (req) => new Promise((resolve) => { let s = ''; req.on('data', c => { s += c; }); req.on('end', () => resolve(s)); }),
    getSetting: () => undefined, updateSettings: () => {}, getAgents: async () => [],
    getVoice: () => ({ engine: { status: () => ({}), paths: {} }, client: {} }),
    voiceCall: r.calls,
  };
  return { ...r, deps };
}

test('routes: POST /api/voice/call starts, heartbeats, changes the mode and ends; end returns the held list', async () => {
  const r = routeRig();
  const start = await post(r.deps, '/api/voice/call', { agent: 'sam_assistant', action: 'start', mode: 'announce' });
  assert.strictEqual(start.status, 200);
  assert.deepStrictEqual([start.json.ok, start.json.call.mode, start.json.call.person, start.json.call.held], [true, 'announce', 'Sam', []]);
  assert.ok(start.json.call.since);
  assert.strictEqual((await post(r.deps, '/api/voice/call', { agent: 'sam_assistant', action: 'heartbeat' })).json.call.mode, 'announce');
  assert.strictEqual((await post(r.deps, '/api/voice/call', { agent: 'sam_assistant', action: 'mode', mode: 'dnd' })).json.call.mode, 'dnd');
  r.calls.holds('sam_assistant', consult({ id: 'c1', label: 'Review the draft' }));
  const end = await post(r.deps, '/api/voice/call', { agent: 'sam_assistant', action: 'end' });
  assert.strictEqual(end.status, 200);
  assert.deepStrictEqual(end.json.held.map(i => [i.id, i.label]), [['c1', 'Review the draft']]);
  assert.strictEqual(r.calls.onCall('sam_assistant'), false);
});

test('routes: only the person who started the call may heartbeat, change, end or decide (an admin too); bad input is refused', async () => {
  const r = routeRig();
  await post(r.deps, '/api/voice/call', { agent: 'sam_assistant', action: 'start' });
  r.calls.holds('sam_assistant', consult({ id: 'c1' }));
  for (const body of [{ agent: 'sam_assistant', action: 'heartbeat' }, { agent: 'sam_assistant', action: 'mode', mode: 'dnd' }, { agent: 'sam_assistant', action: 'end' }, { agent: 'sam_assistant', action: 'start' }]) {
    const x = await post(r.deps, '/api/voice/call', body, owner);
    assert.deepStrictEqual([x.status, x.json.error], [403, 'not_your_call'], JSON.stringify(body));
  }
  assert.deepStrictEqual((await post(r.deps, '/api/voice/call/decide', { agent: 'sam_assistant', id: 'c1', choice: 'now' }, owner)).status, 403);
  assert.strictEqual(r.calls.onCall('sam_assistant'), true);
  assert.strictEqual((await post(r.deps, '/api/voice/call', { agent: 'sam_assistant', action: 'dance' })).status, 400);
  assert.strictEqual((await post(r.deps, '/api/voice/call', { action: 'start' })).json.error, 'agent_required');
  assert.strictEqual((await post(r.deps, '/api/voice/call', { agent: 'sam_assistant', action: 'start', mode: 'loud' })).json.error, 'bad_mode');
  assert.strictEqual((await post(r.deps, '/api/voice/call', { agent: 'idle_agent', action: 'heartbeat' })).status, 409, 'no call (it expired): the page starts a new one');
  assert.strictEqual((await post(r.deps, '/api/voice/call', '{nope')).status, 400);
});

test('routes: POST /api/voice/call/decide applies now / later / skip to a held item', async () => {
  const r = routeRig(); const kicked = [];
  r.calls.registerProducer('consultation', { kick: () => kicked.push('k') });
  await post(r.deps, '/api/voice/call', { agent: 'sam_assistant', action: 'start' });
  r.calls.holds('sam_assistant', consult({ id: 'c1' })); r.calls.holds('sam_assistant', consult({ id: 'c2' }));
  const now = await post(r.deps, '/api/voice/call/decide', { agent: 'sam_assistant', id: 'c1', choice: 'now' });
  assert.deepStrictEqual([now.status, now.json.ok, now.json.choice], [200, true, 'now']);
  assert.deepStrictEqual(kicked, ['k']);
  assert.strictEqual((await post(r.deps, '/api/voice/call/decide', { agent: 'sam_assistant', id: 'c2', choice: 'skip' })).json.call.held.length, 1);
  assert.strictEqual((await post(r.deps, '/api/voice/call/decide', { agent: 'sam_assistant', id: 'zzz', choice: 'now' })).status, 404);
  assert.strictEqual((await post(r.deps, '/api/voice/call/decide', { agent: 'sam_assistant', id: 'c1', choice: 'whenever' })).status, 400);
  assert.strictEqual((await post(r.deps, '/api/voice/call/decide', { agent: 'idle_agent', id: 'c1', choice: 'now' })).status, 409);
  const get = fakeRes(); const done = new Promise(resolve => get.on('finish', resolve));
  await require('../lib/voice/routes').handle('/api/voice/call', fakeReq('GET', '/api/voice/call', undefined, sam), get, r.deps); await done;
  assert.strictEqual(get.statusCode, 405);
});

test('access table: the call routes need access to the agent named in the body, like tts', () => {
  const access = require('../lib/access');
  for (const p of ['/api/voice/call', '/api/voice/call/decide']) assert.deepStrictEqual(access.classifyRoute(p, 'POST'), { kind: 'agent', from: 'body' }, p);
});

// ── the producers ───────────────────────────────────────────────────────────────────────────────

const st = require('../lib/scheduled-tasks');
process.env.HUB_TZ = 'America/New_York';
require('../lib/timezone')._setDeps({ auth: { admins: () => [], getUser: () => null }, agents: () => [] });
const T0 = Date.parse('2026-09-29T18:00:00Z');

function schedRig() {
  const r = rig(); r.clock.t = T0;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-sched-'));
  const woken = [], busy = new Set();
  const inst = new st.ScheduledTasks({
    dataDir, now: () => r.clock.t, log: () => {}, retryMs: 1000, pollMs: 60000, voiceCall: r.calls,
    agentExists: async () => true, isAgentActive: (a) => busy.has(a),
    notify: async (agent, message, onReply, meta) => { woken.push({ agent, label: meta.from, at: r.clock.t }); if (onReply) onReply('ok'); },
  });
  const make = async (agent, label, minutes) => inst.create({ requester: st.OWNER, agent, when: `in ${minutes} minutes`, prompt: `do ${label}`, label });
  // time passes with the person still on the call: a heartbeat every 30 seconds (a call without them lasts 60 s)
  const advance = (agent, userId, ms) => { for (let left = ms; left > 0; left -= 30000) { r.clock.t += Math.min(30000, left); r.calls.heartbeat(agent, userId); } };
  return { ...r, inst, woken, busy, make, dataDir, advance };
}

test('scheduled tasks: a due task for an agent on a call waits in order; now runs it; the end of the call runs the rest; others are not held', async () => {
  const r = schedRig();
  r.calls.start('analyst', { userId: 'u1', person: 'Sam' });
  await r.make('analyst', 'first', 5); await r.make('analyst', 'second', 6); await r.make('planner', 'other', 6);
  r.advance('analyst', 'u1', 10 * 60000);
  await r.inst.tick();
  assert.deepStrictEqual(r.woken.map(w => w.label), ['other'], 'only the agent that is not on the call');
  const held = r.ofType('voice_held');
  assert.deepStrictEqual(held.map(e => [e.agent, e.item.kind, e.item.label]), [['analyst', 'schedule', 'first'], ['analyst', 'schedule', 'second']]);
  assert.match(held[0].item.id, /^schedule:[^:]+:2026-/);
  assert.strictEqual(r.inst.pending.filter(p => p.agent === 'analyst').length, 2, 'held items stay in pending, in order');

  assert.strictEqual(r.calls.decide('analyst', 'u1', held[0].item.id, 'now').ok, true);
  assert.ok(await until(() => r.woken.some(w => w.label === 'first')), 'now: the producer ran it');
  assert.ok(!r.woken.some(w => w.label === 'second'), 'the other one still waits');
  const out = r.calls.end('analyst', 'u1');
  assert.deepStrictEqual(out.held.map(i => [i.label, i.state]), [['first', 'done'], ['second', 'held']]);
  assert.ok(await until(() => r.woken.some(w => w.label === 'second')), 'the end of the call released it');
  assert.deepStrictEqual(r.woken.map(w => w.label), ['other', 'first', 'second'], 'order kept');
  assert.strictEqual(r.inst.pending.length, 0);
  fs.rmSync(r.dataDir, { recursive: true, force: true });
});

test('scheduled tasks: skip drops that run as missed ("skipped during a voice call"); it never fires later', async () => {
  const r = schedRig();
  r.calls.start('analyst', { userId: 'u1', person: 'Sam' });
  const once = await r.make('analyst', 'once only', 5);
  r.advance('analyst', 'u1', 6 * 60000);
  await r.inst.tick();
  const item = r.ofType('voice_held')[0].item;
  r.calls.decide('analyst', 'u1', item.id, 'skip');
  assert.strictEqual(r.inst.pending.length, 0);
  const t = r.inst.tasks.get(once.id || once.task?.id || [...r.inst.tasks.keys()][0]);
  assert.strictEqual(t.runs[0].status, 'missed');
  assert.match(t.runs[0].note, /skipped during a voice call/);
  r.calls.end('analyst', 'u1');
  await r.inst.tick();
  assert.deepStrictEqual(r.woken, [], 'a skipped run never fires');
  fs.rmSync(r.dataDir, { recursive: true, force: true });
});

test('scheduled tasks: time held on a call does not count toward the 12 hour wait limit', async () => {
  const r = schedRig();
  r.calls.start('analyst', { userId: 'u1', person: 'Sam' });
  await r.make('analyst', 'long call', 5);
  r.advance('analyst', 'u1', 6 * 60000); await r.inst.tick();
  for (let i = 0; i < 13; i++) { r.advance('analyst', 'u1', 3600000); await r.inst.tick(); }   // 13 hours on the call
  assert.strictEqual(r.inst.pending.length, 1, 'still waiting, not dropped as missed');
  assert.deepStrictEqual(r.woken, []);
  r.busy.add('analyst');
  r.calls.end('analyst', 'u1');   // the agent is busy now: it waits the ordinary way, and is not dropped
  await r.inst.tick();
  assert.strictEqual(r.inst.pending.length, 1);
  assert.ok(![...r.inst.tasks.values()].some(t => (t.runs || []).some(x => x.status === 'missed')));
  r.busy.clear(); r.clock.t += 5000; await r.inst.tick();
  assert.deepStrictEqual(r.woken.map(w => w.label), ['long call']);
  fs.rmSync(r.dataDir, { recursive: true, force: true });
});

const { JobRunner } = require('../lib/jobs');
function jobRig() {
  const r = rig();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-jobs-'));
  const notes = [];
  const runner = new JobRunner({ dataDir, spawnMode: 'setsid', pollMs: 60000, retryMs: 50, log: () => {}, voiceCall: r.calls, notify: async (agent, message, onReply, meta) => { notes.push({ agent, kind: meta.kind }); }, isAgentActive: () => false, agentExists: async () => true, defaultCwd: async () => dataDir });
  runner.jobs.set('j1', { id: 'j1', name: 'nightly build', owner: 'analyst', status: 'finished', startedAt: new Date(r.clock.t).toISOString() });
  runner.jobs.set('j2', { id: 'j2', name: 'audit run', owner: 'auditor', reportTo: 'analyst', status: 'finished', startedAt: new Date(r.clock.t).toISOString() });
  return { ...r, runner, notes, dataDir };
}

test('jobs: a notice or report for an agent on a call is held without using up delivery attempts; now / the end release it; skip drops only the notice', async () => {
  const r = jobRig();
  r.calls.start('analyst', { userId: 'u1', person: 'Sam' });
  r.runner.pending.push({ kind: 'result', jobId: 'j1', agent: 'analyst', message: 'm1', attempts: 0, notBefore: 0 });
  r.runner.pending.push({ kind: 'report', jobId: 'j2', agent: 'analyst', message: 'm2', attempts: 0, notBefore: 0 });
  for (let i = 0; i < 300; i++) await r.runner._deliver();   // more rounds than MAX_DELIVERY_ATTEMPTS
  assert.deepStrictEqual(r.notes, []);
  assert.strictEqual(r.runner.pending.length, 2, 'still waiting, none dropped');
  assert.deepStrictEqual(r.runner.pending.map(p => p.attempts), [0, 0], 'held rounds are not delivery attempts');
  const held = r.ofType('voice_held');
  assert.deepStrictEqual(held.map(e => [e.item.id, e.item.kind, e.item.label]), [['job:j1', 'job_notice', 'nightly build'], ['job:j2:report', 'job_report', 'audit run']]);

  r.calls.decide('analyst', 'u1', 'job:j1', 'now');
  assert.ok(await until(() => r.notes.length === 1));
  assert.deepStrictEqual(r.notes[0], { agent: 'analyst', kind: 'job_notice' });
  assert.strictEqual(r.runner.pending.length, 1);

  r.calls.decide('analyst', 'u1', 'job:j2:report', 'skip');
  assert.strictEqual(r.runner.pending.length, 0, 'the notice is dropped');
  assert.strictEqual(r.runner.jobs.get('j2').status, 'finished', 'the job keeps its own record and result');
  assert.match(r.runner.jobs.get('j2').note, /skipped during a voice call/);
  assert.strictEqual(r.notes.length, 1);

  r.runner.pending.push({ kind: 'result', jobId: 'j2', agent: 'analyst', message: 'm3', attempts: 0, notBefore: 0 });
  await r.runner._deliver();
  assert.strictEqual(r.notes.length, 1, 'a new notice during the same call is held again');
  r.calls.end('analyst', 'u1');
  assert.ok(await until(() => r.notes.length === 2), 'the end of the call releases it');
  assert.deepStrictEqual(r.notes[1], { agent: 'analyst', kind: 'job_notice' });
  fs.rmSync(r.dataDir, { recursive: true, force: true });
});

const cq = require('../lib/consult-queue');
function queueRig() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-cq-')), 'q.json');
  return { q: new cq.ConsultQueue({ file, now: () => 1_000_000 }), file };
}

test('consult queue: a drain skips an agent whose next job is held, keeps its place, and runs it once allowed; decline tells the caller', async () => {
  const r = rig(); const { q } = queueRig(); const ran = [];
  r.calls.start('planner', { userId: 'u1', person: 'Sam' });
  const a = q.enqueue({ from: 'helper', to: 'planner', prompt: 'first request' }).job;
  q.enqueue({ from: 'helper', to: 'planner', prompt: 'second request' });
  const b = q.enqueue({ from: 'helper', to: 'writer', prompt: 'for someone else' }).job;
  const opts = { isActive: () => false, run: async (j) => { ran.push(j.prompt); return `done ${j.prompt}`; }, isHeld: (job) => r.calls.holds(job.to, { id: cq.jobHoldId(job), kind: 'consultation', label: job.prompt, from: job.from }) };
  assert.strictEqual(await q.drain(opts), 1);
  assert.deepStrictEqual(ran, ['for someone else'], 'the agent on the call is skipped, the other agent is not');
  assert.deepStrictEqual(q.pendingFor('planner').map(j => j.prompt), ['first request', 'second request']);
  assert.strictEqual(cq.jobHoldId(a), `consult:helper:planner:${a.key}`);
  assert.deepStrictEqual(r.ofType('voice_held').map(e => e.item.id), [cq.jobHoldId(a)]);

  r.calls.decide('planner', 'u1', cq.jobHoldId(a), 'now');
  assert.strictEqual(await q.drain(opts), 1);
  assert.deepStrictEqual(ran, ['for someone else', 'first request']);
  assert.deepStrictEqual(q.takeMailbox('helper').map(m => [m.to, m.status]), [['writer', 'answered'], ['planner', 'answered']]);

  // the next one (second request) is held; skipping it puts the decline in the caller's mailbox
  assert.strictEqual(await q.drain(opts), 0);
  const second = q.pendingFor('planner')[0];
  assert.strictEqual(q.declineJob(second.id, cq.callDeclinedMessage('Planner', 'Sam')), true);
  assert.deepStrictEqual(q.pendingFor('planner'), []);
  const box = q.takeMailbox('helper');
  assert.deepStrictEqual(box.map(m => [m.to, m.status, m.result]), [['planner', 'declined', 'Planner is on a voice call; Sam declined this request for now.']]);
  assert.strictEqual(q.declineJob('cq-nope', 'x'), false);
  void b;
});

test('a consult to an agent on a call is queued with the status text; no stand-in, no waiting; after the call ends it drains', async () => {
  const { holdConsultForCall } = require('../lib/sdk-chat');
  const r = rig(); const { q } = queueRig();
  assert.strictEqual(await holdConsultForCall('planner', 'Please review this', 'helper', { queue: q, calls: r.calls }), null, 'no call: the consult goes the usual way');
  assert.strictEqual(q.pendingFor('planner').length, 0);

  r.calls.start('planner', { userId: 'u1', person: 'Sam' });
  const text = await holdConsultForCall('planner', 'Please review this', 'helper', { queue: q, calls: r.calls, displayOf: async () => 'Planner' });
  assert.strictEqual(text, 'Planner is on a voice call with Sam; your request is queued and will run when the call ends or Sam says now.');
  assert.deepStrictEqual(q.pendingFor('planner').map(j => [j.from, j.prompt]), [['helper', 'Please review this']]);
  assert.strictEqual(r.ofType('voice_held')[0].item.kind, 'consultation');
  assert.strictEqual(r.ofType('voice_held')[0].item.from, 'helper');

  // asking again with the same words does not queue twice
  await holdConsultForCall('planner', 'Please review this', 'helper', { queue: q, calls: r.calls, displayOf: async () => 'Planner' });
  assert.strictEqual(q.pendingFor('planner').length, 1);

  // the queue's drain is the producer: the end of the call kicks it, and the job runs
  const ran = [];
  r.calls.registerProducer('consultation', { kick: () => q.drain({ isActive: () => false, run: async (j) => { ran.push(j.prompt); return 'reviewed'; }, isHeld: (job) => r.calls.holds(job.to, { id: cq.jobHoldId(job), kind: 'consultation', label: job.prompt, from: job.from }) }) });
  assert.strictEqual(await q.drain({ isActive: () => false, run: async () => 'no', isHeld: (job) => r.calls.holds(job.to, { id: cq.jobHoldId(job), kind: 'consultation', label: job.prompt, from: job.from }) }), 0, 'held while the call lasts');
  r.calls.end('planner', 'u1');
  assert.ok(await until(() => ran.length === 1));
  assert.deepStrictEqual(ran, ['Please review this']);
  assert.strictEqual(q.takeMailbox('helper')[0].result, 'reviewed');
});

test('a consult the person already allowed is not run twice: the queued job is run by the queue', async () => {
  const { holdConsultForCall } = require('../lib/sdk-chat');
  const r = rig(); const { q } = queueRig();
  r.calls.start('planner', { userId: 'u1', person: 'Sam' });
  await holdConsultForCall('planner', 'Please review this', 'helper', { queue: q, calls: r.calls, displayOf: async () => 'Planner' });
  r.calls.decide('planner', 'u1', cq.jobHoldId(q.pendingFor('planner')[0]), 'now');
  const again = await holdConsultForCall('planner', 'Please review this', 'helper', { queue: q, calls: r.calls });
  assert.match(again, /^\[QUEUED\]/, 'the queued request is still the one that runs');
  assert.strictEqual(await holdConsultForCall('planner', 'A different request', 'helper', { queue: q, calls: r.calls, displayOf: async () => 'Planner' }), 'Planner is on a voice call with Sam; your request is queued and will run when the call ends or Sam says now.');
});

test('a full queue is said plainly, not silently dropped', async () => {
  const { holdConsultForCall } = require('../lib/sdk-chat');
  const r = rig(); const { q } = queueRig();
  r.calls.start('planner', { userId: 'u1', person: 'Sam' });
  for (let i = 0; i < cq.MAX_PER_PAIR; i++) assert.ok(/queued/.test(await holdConsultForCall('planner', `request ${i}`, 'helper', { queue: q, calls: r.calls })));
  const full = await holdConsultForCall('planner', 'one too many', 'helper', { queue: q, calls: r.calls, displayOf: async () => 'Planner' });
  assert.match(full, /^\[NOT QUEUED\] Planner is on a voice call with Sam and 3 requests from "helper" are already waiting/);
});

// ── the gate, alerts and the wiring in lib/sdk-chat.js ───────────────────────────────────────────

test('handleChatStream: a hub task (condense, compaction) for an agent on a call gets 409 on_voice_call; the person, comms and alerts do not match the gate', async () => {
  const chat = require('../lib/sdk-chat');
  const calls = require('../lib/voice/call');
  assert.strictEqual(chat.voiceGateKind({ origin: { kind: 'task', from: 'hub', label: 'context compression' } }), 'task');
  assert.strictEqual(chat.voiceGateKind({ origin: { kind: 'schedule', from: 'task-1' } }), 'schedule', 'lib/scheduler.js turns carry no task id');
  assert.strictEqual(chat.voiceGateKind({ origin: { kind: 'schedule', from: 'Nightly', taskId: 't1' } }), null, 'lib/scheduled-tasks holds its own');
  assert.strictEqual(chat.voiceGateKind({ origin: { kind: 'job_notice', jobId: 'j1' } }), null);
  for (const kind of ['user', 'comms', 'alert', 'consultation', 'consult_reply']) assert.strictEqual(chat.voiceGateKind({ origin: { kind } }), null, kind);
  assert.strictEqual(chat.voiceGateKind({ message: 'hi' }), null, 'the person\'s own turn (no origin)');

  calls.start('gate_agent', { userId: 'u1', person: 'Sam' });
  try {
    const res = fakeRes(); const done = new Promise(resolve => res.on('finish', resolve));
    await chat.handleChatStream({ agent: 'gate_agent', message: 'condense', origin: { kind: 'task', from: 'hub', label: 'condense Records' } }, res);
    if (!res.writableEnded) res.end();
    await done;
    assert.strictEqual(res.statusCode, 409);
    assert.deepStrictEqual(res.json(), { error: 'on_voice_call', held: true });
    assert.deepStrictEqual(calls.statusOf('gate_agent').held.map(i => [i.kind, i.label]), [['task', 'condense Records']]);
  } finally { calls.end('gate_agent', 'u1'); }
});

test('wiring in lib/sdk-chat.js: consults are held before any stand-in; producers are registered; alerts are untouched; list_agents shows the call', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  const at = (needle, from = 0) => { const i = src.indexOf(needle, from); assert.ok(i >= 0, needle); return i; };
  // consultViaHub: before the capacity check and the stand-in
  const via = at('async function consultViaHub(');
  assert.ok(at('await holdConsultForCall(', via) < at('isAgentActive(agentName) && await isCapacityAgent(agentName)', via));
  // the 409 path: before standInFor
  const nine = at('if (res.statusCode === 409) {');
  assert.ok(at('await holdConsultForCall(', nine) < at('const capacity = await isCapacityAgent(agentName);', nine));
  assert.ok(at('await holdConsultForCall(', nine) < at('await standInFor(agentName, prompt, sseCtx, coordinatorName, { ...opts, callerTurn', nine));
  // the queue drain gets the held predicate and releases what it ran
  assert.ok(src.includes('isHeld: (job) => voiceCall.holds(job.to, { id: consultQueue.jobHoldId(job), kind: \'consultation\''));
  assert.ok(src.includes('voiceCall.registerProducer(\'consultation\', {') && src.includes("voiceCall.registerProducer('consult_reply'") && src.includes("voiceCall.registerProducer('task'"));
  // scheduled tasks and jobs get the registry
  const ctor = src.slice(at('function getScheduledTasks() {'), at('function getJobRunner() {'));
  assert.ok(ctor.includes('voiceCall,'));
  assert.ok(src.slice(at('function getJobRunner() {'), at('function getJobRunner() {') + 200).includes('voiceCall,'));
  // alerts are an emergency: they never consult the registry
  const alert = src.slice(at('async function handleAlert('), at('async function handleAlert(') + 6000);
  assert.ok(!alert.includes('voiceCall'), 'handleAlert is unchanged');
  // the delivery turn for queued replies and list_agents
  assert.ok(src.includes("kind: 'consult_reply', label: 'replies from other agents'"));
  assert.ok(src.includes('— on a voice call (with ${onCall.person}'));
});
