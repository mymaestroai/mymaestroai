'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  HandOffs, slugify, MAX_OPEN_PER_CALLER, MAX_BRIEF, MAX_TOPIC, RESULT_CHARS,
  framingMessage, noteMessage, reportMessage,
} = require('../lib/hand-offs');

const T0 = Date.parse('2026-11-19T12:00:00Z');
const temps = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ho-test-'));
  temps.push(d);
  return d;
}
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

function setup(over = {}) {
  const dataDir = tmp();
  const files = tmp();
  const env = {
    t: T0, dataDir, files,
    active: new Set(), held: new Set(), missing: new Set(), continuations: new Set(),
    turns: [], delivered: [], interjected: [], stopped: [], cancelled: [],
    deliverFails: 0, startError: null, interjectResult: true,
  };
  const opts = {
    dataDir, log: () => {}, retryMs: 15000, pollMs: 1000000,
    now: () => env.t,
    startTurn: async (agent, message, extra) => {
      if (env.startError) throw env.startError;
      const turn = { agent, message, origin: extra.origin };
      turn.done = new Promise((res) => { turn.finish = res; });
      env.turns.push(turn);
      return { done: turn.done };
    },
    deliver: async (agent, message, meta) => {
      if (env.deliverFails > 0) { env.deliverFails--; throw new Error('busy'); }
      env.delivered.push({ agent, message, meta });
    },
    isAgentActive: (n) => env.active.has(n),
    agentExists: async (n) => !env.missing.has(n),
    hasContinuation: (id) => env.continuations.has(id),
    interject: (a, text) => { env.interjected.push({ a, text }); return env.interjectResult; },
    stopTurn: (a) => env.stopped.push(a),
    cancelContinuations: (id) => env.cancelled.push(id),
    filesFolderFor: (a) => path.join(files, a),
    holds: (a) => env.held.has(a),
    ...over,
  };
  env.opts = opts;
  env.h = new HandOffs(opts);
  return env;
}
const mk = (env, extra = {}) => env.h.create({ caller: 'sam', target: 'lead', topic: 'Big Job', brief: 'Do the thing', ...extra });
const flush = () => new Promise((r) => setImmediate(r));

test('slugify', () => {
  assert.strictEqual(slugify('Hello, World!!'), 'hello-world');
  assert.strictEqual(slugify('  ---  '), 'job');
  assert.strictEqual(slugify('a'.repeat(60)).length, 40);
});

test('create refusals', async () => {
  const env = setup();
  await assert.rejects(env.h.create({ target: 'lead', topic: 't', brief: 'b' }));
  await assert.rejects(env.h.create({ caller: 'sam', topic: 't', brief: 'b' }));
  await assert.rejects(env.h.create({ caller: 'sam', target: 'sam', topic: 't', brief: 'b' }), /can't hand off to yourself/);
  await assert.rejects(env.h.create({ caller: 'sam', target: 'lead', topic: ' ', brief: 'b' }), /topic/);
  await assert.rejects(env.h.create({ caller: 'sam', target: 'lead', topic: 'x'.repeat(MAX_TOPIC + 1), brief: 'b' }), /topic/);
  await assert.rejects(env.h.create({ caller: 'sam', target: 'lead', topic: 't', brief: '' }), /brief/);
  await assert.rejects(env.h.create({ caller: 'sam', target: 'lead', topic: 't', brief: 'x'.repeat(MAX_BRIEF + 1) }), /brief/);
  env.missing.add('ghost');
  await assert.rejects(env.h.create({ caller: 'sam', target: 'ghost', topic: 't', brief: 'b' }), /no agent/);
  const noFolder = setup({ filesFolderFor: () => null });
  await assert.rejects(mk(noFolder), /Files folder/);
  assert.strictEqual(env.h.items.size, 0);
});

test('cap of 5 open hand-offs', async () => {
  const env = setup();
  env.active.add('lead');
  for (let i = 0; i < MAX_OPEN_PER_CALLER; i++) await mk(env, { topic: `job ${i}` });
  await assert.rejects(mk(env, { topic: 'one more' }),
    /You have 5 hand-offs open \(queued or running\)\. Wait for one to finish or cancel one\./);
  // another caller is not affected
  await env.h.create({ caller: 'scout', target: 'lead', topic: 'mine', brief: 'b' });
  // cancelling frees a slot
  const first = env.h.list('sam')[0];
  env.h.cancel({ caller: 'sam', id: first.id });
  await mk(env, { topic: 'now fits' });
});

test('folder name, -2 suffix and brief.md', async () => {
  const env = setup();
  env.active.add('lead');
  const a = await mk(env);
  const b = await mk(env);
  const c = await mk(env);
  assert.strictEqual(a.folder, path.join(env.files, 'lead', 'hand-offs', 'sam-big-job'));
  assert.strictEqual(b.folder, a.folder + '-2');
  assert.strictEqual(c.folder, a.folder + '-3');
  const md = fs.readFileSync(path.join(a.folder, 'brief.md'), 'utf8');
  assert.match(md, /^# Big Job\n/);
  assert.ok(md.includes('From agent sam, 2026-11-19T12:00:00.000Z'));
  assert.ok(md.includes('Do the thing'));
  assert.strictEqual(a.state, 'queued');
});

test('queued waits while the target is busy, then starts with origin fields', async () => {
  const env = setup();
  env.active.add('lead');
  const v = await mk(env, { member: true });
  await env.h.tick();
  assert.strictEqual(env.turns.length, 0);
  assert.strictEqual(env.h.get(v.id).state, 'queued');
  env.active.delete('lead');
  await env.h.tick();
  assert.strictEqual(env.turns.length, 1);
  const t = env.turns[0];
  assert.strictEqual(t.agent, 'lead');
  assert.deepStrictEqual(t.origin, {
    kind: 'hand_off', from: 'sam', handOffId: v.id, label: 'Hand-off from sam: Big Job', member: true,
  });
  assert.strictEqual(t.message, framingMessage(env.h.get(v.id)));
  assert.strictEqual(env.h.get(v.id).state, 'running');
  assert.strictEqual(env.h.get(v.id).startedAt, T0);
});

test('non-member origin has no member key', async () => {
  const env = setup();
  await mk(env);
  await env.h.tick();
  assert.ok(!('member' in env.turns[0].origin));
});

test('409 keeps it queued; 503 too; another error fails it with a failed report', async () => {
  const env = setup();
  const v = await mk(env);
  env.startError = Object.assign(new Error('busy'), { status: 409 });
  await env.h.tick();
  assert.strictEqual(env.h.get(v.id).state, 'queued');
  env.startError = Object.assign(new Error('halted'), { status: 503 });
  await env.h.tick();
  assert.strictEqual(env.h.get(v.id).state, 'queued');
  assert.strictEqual(env.h.get(v.id).report, null);

  env.startError = new Error('boom');
  await env.h.tick();
  const r = env.h.get(v.id);
  assert.strictEqual(r.state, 'failed');
  assert.strictEqual(r.error, 'boom');
  await env.h.tick();
  assert.strictEqual(r.report.state, 'delivered');
  assert.strictEqual(env.delivered.length, 1);
  assert.strictEqual(env.delivered[0].message,
    `[Hand-off failed] "Big Job" (id ${v.id}): it could not start agent "lead": boom.`);
  assert.strictEqual(env.delivered[0].meta.label, 'Hand-off failed: Big Job');
});

test('continuation -> waiting, turnStarted -> running, final turn -> done and report delivered', async () => {
  const env = setup();
  const v = await mk(env, { member: true });
  await env.h.tick();
  env.continuations.add(v.id);
  env.turns[0].finish('first reply');
  await flush(); await flush();
  let r = env.h.get(v.id);
  assert.strictEqual(r.state, 'waiting');
  assert.strictEqual(r.turns, 1);
  assert.strictEqual(r.lastReply, 'first reply');
  assert.strictEqual(r.report, null);

  env.h.turnStarted(v.id);
  assert.strictEqual(env.h.get(v.id).state, 'running');

  env.continuations.delete(v.id);
  env.h.turnEnded(v.id, 'final answer');
  r = env.h.get(v.id);
  assert.strictEqual(r.state, 'done');
  assert.strictEqual(r.turns, 2);
  assert.strictEqual(r.endedAt, T0);
  assert.strictEqual(r.result, 'final answer');
  assert.strictEqual(r.report.kind, 'finished');
  assert.strictEqual(r.report.state, 'pending');

  await env.h.tick();
  assert.strictEqual(r.report.state, 'delivered');
  assert.strictEqual(r.report.deliveredAt, T0);
  assert.strictEqual(env.delivered.length, 1);
  const d = env.delivered[0];
  assert.strictEqual(d.agent, 'sam');
  assert.strictEqual(d.message, reportMessage(r));
  assert.ok(d.message.startsWith(`[Hand-off finished] "Big Job" (id ${v.id}): agent "lead" finished after 2 turns.`));
  assert.ok(d.message.includes(`Status: ${r.folder}/STATUS.md`));
  assert.ok(d.message.includes("Its final report:\nfinal answer"));
  assert.ok(d.message.includes('not a message from the owner'));
  assert.deepStrictEqual(d.meta, {
    kind: 'hand_off', from: 'lead', handOffId: v.id, label: 'Hand-off finished: Big Job', member: true,
  });
});

test('empty reply gives "(no reply text)" and long result is cut', async () => {
  const env = setup();
  const v = await mk(env);
  await env.h.tick();
  env.turns[0].finish('');
  await flush(); await flush();
  assert.ok(reportMessage(env.h.get(v.id)).includes('(no reply text)'));
  assert.ok(reportMessage(env.h.get(v.id)).includes('after 1 turn.'));

  const v2 = await mk(env, { topic: 'long' });
  await env.h.tick();
  env.h.turnEnded(v2.id, 'z'.repeat(RESULT_CHARS + 50));
  const r = env.h.get(v2.id);
  assert.strictEqual(r.result.length, RESULT_CHARS + 1);
  assert.ok(r.result.endsWith('…'));
  assert.strictEqual(r.lastReply.length, 600);
});

test('rejected deliver is retried after retryMs', async () => {
  const env = setup();
  const v = await mk(env);
  await env.h.tick();
  env.deliverFails = 1;
  env.h.turnEnded(v.id, 'ok');
  await env.h.tick();
  const r = env.h.get(v.id);
  assert.strictEqual(r.report.state, 'pending');
  assert.strictEqual(r.report.attempts, 1);
  env.t += 5000;
  await env.h.tick();
  assert.strictEqual(r.report.state, 'pending');
  assert.strictEqual(r.report.attempts, 1);
  env.t += 10001;
  await env.h.tick();
  assert.strictEqual(r.report.state, 'delivered');
  assert.strictEqual(env.delivered.length, 1);
});

test('a deleted caller: report dropped', async () => {
  const env = setup();
  const v = await mk(env);
  await env.h.tick();
  env.missing.add('sam');
  env.h.turnEnded(v.id, 'ok');
  await env.h.tick();
  assert.strictEqual(env.h.get(v.id).report.state, 'dropped');
  assert.strictEqual(env.delivered.length, 0);
});

test('notes: running with interject true and false', async () => {
  const env = setup();
  const v = await mk(env);
  await env.h.tick();
  let out = env.h.note({ caller: 'sam', id: v.id, text: 'first' });
  assert.strictEqual(out.queuedNotes, 0);
  assert.strictEqual(env.interjected.length, 1);
  assert.strictEqual(env.interjected[0].a, 'lead');
  assert.ok(env.interjected[0].text.startsWith(`[Note from agent "sam" on hand-off ${v.id} "Big Job" — not a message from the owner]`));
  assert.ok(env.interjected[0].text.includes('first'));
  assert.ok(env.interjected[0].text.endsWith('Carry on with the hand-off; keep STATUS.md current.'));
  env.interjectResult = false;
  out = env.h.note({ caller: 'sam', id: v.id, text: 'second' });
  assert.strictEqual(out.queuedNotes, 1);
  assert.strictEqual(env.h.get(v.id).notes[1].delivered, false);
  // the turn ends with an undelivered note: waiting, not done
  env.h.turnEnded(v.id, 'r');
  assert.strictEqual(env.h.get(v.id).state, 'waiting');
});

test('notes: waiting -> a note turn on the next tick', async () => {
  const env = setup();
  const v = await mk(env);
  await env.h.tick();
  env.continuations.add(v.id);
  env.h.turnEnded(v.id, 'r1');
  assert.strictEqual(env.h.get(v.id).state, 'waiting');
  env.h.note({ caller: 'sam', id: v.id, text: 'change course' });
  assert.strictEqual(env.interjected.length, 0);
  env.active.add('lead');
  await env.h.tick();
  assert.strictEqual(env.turns.length, 1);   // busy: no note turn yet
  env.active.delete('lead');
  await env.h.tick();
  assert.strictEqual(env.turns.length, 2);
  const r = env.h.get(v.id);
  assert.strictEqual(env.turns[1].message, noteMessage(r, [{ text: 'change course' }]));
  assert.strictEqual(r.state, 'running');
  assert.strictEqual(r.notes[0].delivered, true);
});

test('notes: queued -> included in the framing message', async () => {
  const env = setup();
  env.active.add('lead');
  const v = await mk(env);
  const out = env.h.note({ caller: 'sam', id: v.id, text: 'also do X' });
  assert.strictEqual(out.queuedNotes, 1);
  env.active.delete('lead');
  await env.h.tick();
  const msg = env.turns[0].message;
  assert.ok(msg.includes('Notes from agent "sam" since:\nalso do X'));
  assert.ok(msg.includes('schedule_task'));
  assert.ok(msg.includes('run_job'));
  assert.ok(msg.includes(`${env.h.get(v.id).folder}/STATUS.md`));
  assert.ok(msg.includes(`${env.h.get(v.id).folder}/brief.md`));
  assert.ok(msg.startsWith(`[Hand-off from agent "sam" — started by the hub, NOT a message typed by the owner] "Big Job" (id ${v.id}).\n\nBrief:\nDo the thing`));
  assert.strictEqual(env.h.get(v.id).notes[0].delivered, true);
});

test('note refusals', async () => {
  const env = setup();
  env.active.add('lead');
  const v = await mk(env);
  assert.throws(() => env.h.note({ caller: 'scout', id: v.id, text: 'x' }));
  assert.throws(() => env.h.note({ caller: 'sam', id: v.id, text: '' }));
  assert.throws(() => env.h.note({ caller: 'sam', id: v.id, text: 'x'.repeat(4001) }));
  env.h.cancel({ caller: 'sam', id: v.id });
  assert.throws(() => env.h.note({ caller: 'sam', id: v.id, text: 'x' }), /That hand-off has ended \(cancelled\)\./);
});

test('cancel: stops a running turn, cancels continuations, no report, caller only', async () => {
  const env = setup();
  const v = await mk(env);
  await env.h.tick();
  env.active.add('lead');
  assert.throws(() => env.h.cancel({ caller: 'scout', id: v.id }));
  const out = env.h.cancel({ caller: 'sam', id: v.id });
  assert.strictEqual(out.state, 'cancelled');
  assert.deepStrictEqual(env.stopped, ['lead']);
  assert.deepStrictEqual(env.cancelled, [v.id]);
  assert.strictEqual(env.h.get(v.id).endedAt, T0);
  assert.strictEqual(env.h.get(v.id).report, null);
  assert.throws(() => env.h.cancel({ caller: 'sam', id: v.id }), /has ended/);
  // a late turnEnded is ignored
  env.turns[0].finish('late');
  await flush(); await flush();
  const r = env.h.get(v.id);
  assert.strictEqual(r.state, 'cancelled');
  assert.strictEqual(r.turns, 0);
  assert.strictEqual(r.report, null);
  await env.h.tick();
  assert.strictEqual(env.delivered.length, 0);
});

test('cancel of a queued hand-off does not stop a turn', async () => {
  const env = setup();
  env.active.add('lead');
  const v = await mk(env);
  env.h.cancel({ caller: 'sam', id: v.id });
  assert.deepStrictEqual(env.stopped, []);
  assert.deepStrictEqual(env.cancelled, [v.id]);
});

test('list: open plus last 24 h, newest first, withStatus', async () => {
  const env = setup();
  env.active.add('lead');
  const a = await mk(env, { topic: 'a' });
  env.t += 1000;
  const b = await mk(env, { topic: 'b' });
  env.t += 1000;
  const c = await mk(env, { topic: 'c' });
  env.h.cancel({ caller: 'sam', id: a.id });          // ended now: recent
  assert.deepStrictEqual(env.h.list('sam').map((v) => v.topic), ['c', 'b', 'a']);
  env.t += 25 * 3600 * 1000;                           // a is now older than 24 h
  assert.deepStrictEqual(env.h.list('sam').map((v) => v.topic), ['c', 'b']);
  assert.deepStrictEqual(env.h.list('sam', { includeDone: true }).map((v) => v.topic), ['c', 'b', 'a']);
  assert.deepStrictEqual(env.h.list('scout'), []);

  assert.strictEqual(env.h.list('sam', { withStatus: true })[0].status, null);
  fs.writeFileSync(path.join(c.folder, 'STATUS.md'), 'done: 1\nnext: 2');
  assert.strictEqual(env.h.list('sam', { withStatus: true })[0].status, 'done: 1\nnext: 2');
  fs.writeFileSync(path.join(c.folder, 'STATUS.md'), 's'.repeat(2500));
  const st = env.h.list('sam', { withStatus: true })[0].status;
  assert.strictEqual(st.length, 2001);
  assert.ok(st.endsWith('…'));
  assert.ok(!('status' in env.h.list('sam')[0]));
  assert.ok(b.id);
});

test('view fields', async () => {
  const env = setup();
  env.active.add('lead');
  const v = await mk(env);
  assert.deepStrictEqual(Object.keys(v).sort(), [
    'caller', 'createdAt', 'endedAt', 'error', 'folder', 'id', 'lastReply', 'queuedNotes', 'startedAt', 'state', 'target', 'topic', 'turns',
  ]);
  assert.match(v.id, /^ho-[0-9a-f]{8}$/);
});

test('restart sweep: running -> interrupted with a pending report; queued and waiting stay', async () => {
  const env = setup();
  const a = await mk(env, { topic: 'a' });       // will run
  await env.h.tick();
  env.active.add('lead');
  const q = await mk(env, { topic: 'q' });       // stays queued (busy)
  env.active.delete('lead');
  env.continuations.add(a.id);
  // make a third, waiting
  env.active.add('lead');
  const w = await mk(env, { topic: 'w' });
  env.h.get(w.id).state = 'waiting';
  env.h.get(a.id).state = 'running';
  env.h._save();

  const env2 = setup({ dataDir: env.dataDir });
  env2.h.start();
  env2.h.stop();
  const ra = env2.h.get(a.id);
  assert.strictEqual(ra.state, 'interrupted');
  assert.strictEqual(ra.endedAt, T0);
  assert.deepStrictEqual({ kind: ra.report.kind, state: ra.report.state }, { kind: 'interrupted', state: 'pending' });
  assert.strictEqual(env2.h.get(q.id).state, 'queued');
  assert.strictEqual(env2.h.get(w.id).state, 'waiting');
  await env2.h.tick();
  assert.strictEqual(env2.delivered.length, 1);
  assert.strictEqual(env2.delivered[0].meta.label, 'Hand-off interrupted: a');
  assert.ok(env2.delivered[0].message.startsWith(`[Hand-off interrupted] "a" (id ${a.id}): the hub restarted while agent "lead" was working on it, so that turn ended unfinished.`));
  assert.ok(env2.delivered[0].message.includes('Hand it off again if it still needs doing'));
});

test('state file is 0600 and survives a new instance', async () => {
  const env = setup();
  env.active.add('lead');
  const v = await mk(env);
  env.h.note({ caller: 'sam', id: v.id, text: 'n1' });
  const file = path.join(env.dataDir, 'hand-offs.json');
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepStrictEqual(fs.readdirSync(env.dataDir), ['hand-offs.json']);   // no tmp file left
  const again = new HandOffs(env.opts);
  const r = again.get(v.id);
  assert.strictEqual(r.topic, 'Big Job');
  assert.strictEqual(r.notes.length, 1);
  assert.strictEqual(r.state, 'queued');
});

test('closed records older than 30 days are pruned on save', async () => {
  const env = setup();
  env.active.add('lead');
  const a = await mk(env, { topic: 'old' });
  env.h.cancel({ caller: 'sam', id: a.id });
  env.t += 31 * 24 * 3600 * 1000;
  const b = await mk(env, { topic: 'new' });
  assert.strictEqual(env.h.get(a.id), null);
  assert.ok(env.h.get(b.id));
});

test('voice-call holds delay start and delivery', async () => {
  const env = setup();
  env.held.add('lead');
  const v = await mk(env);
  await env.h.tick();
  assert.strictEqual(env.turns.length, 0);
  assert.strictEqual(env.h.get(v.id).state, 'queued');
  env.held.delete('lead');
  await env.h.tick();
  assert.strictEqual(env.turns.length, 1);

  env.held.add('sam');
  env.h.turnEnded(v.id, 'ok');
  await env.h.tick();
  assert.strictEqual(env.delivered.length, 0);
  assert.strictEqual(env.h.get(v.id).report.state, 'pending');
  env.held.delete('sam');
  await env.h.tick();
  assert.strictEqual(env.delivered.length, 1);
  assert.strictEqual(env.h.get(v.id).report.attempts, 0);
});

test('turnEnded and turnStarted on unknown or closed ids are ignored', async () => {
  const env = setup();
  env.h.turnEnded('ho-nope', 'x');
  env.h.turnStarted('ho-nope');
  const v = await mk(env);
  await env.h.tick();
  env.h.turnEnded(v.id, 'done');
  assert.strictEqual(env.h.get(v.id).state, 'done');
  env.h.turnEnded(v.id, 'again');
  env.h.turnStarted(v.id);
  const r = env.h.get(v.id);
  assert.strictEqual(r.turns, 1);
  assert.strictEqual(r.state, 'done');
  assert.strictEqual(r.result, 'done');
});

test('start() runs a timer that ticks; stop() clears it', async () => {
  const env = setup({ pollMs: 10 });
  const v = await mk(env);
  env.h.start();
  await new Promise((r) => setTimeout(r, 60));
  env.h.stop();
  assert.strictEqual(env.h.get(v.id).state, 'running');
  assert.strictEqual(env.h._timer, null);
});
