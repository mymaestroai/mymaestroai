'use strict';
// A hand-off survives ordinary edits of either agent (a model switch, effort, blurb...) and ends only when the caller or
// the target really is another agent (deleted and made again under the same name) or the caller may no longer reach it.
// A report no agent may receive is never given to a re-made agent; the caller's owner is told instead.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { HandOffs } = require('../lib/hand-offs');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
// lib/agents.js opens the install's data folder when required, so its identity helpers are taken from the source
function extractFn(src, head) {
  const at = src.indexOf(head);
  assert.ok(at >= 0, head);
  let i = src.indexOf('{', at), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(at, i + 1);
}
const AGENTS = read('lib/agents.js');
const { identityOf, sameAgentIdentity, stampOf } = new Function(
  `${extractFn(AGENTS, 'function identityOf(rec)')}\n${extractFn(AGENTS, 'function sameAgentIdentity(stored, now)')}\n` +
  `${extractFn(AGENTS, 'function stampOf(rec)')}\nreturn { identityOf, sameAgentIdentity, stampOf };`)();
// stampOf uses require('crypto') inside its body: the extracted copy runs where require is not defined, so give it one
const oldStampOf = (rec) => { if (!rec) return null; if (rec.box) return `box:${rec.box}`; const rest = { ...rec }; delete rest.teamGuidance; return 'rec:' + crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex'); };

const T0 = Date.parse('2026-11-21T12:00:00Z');
const temps = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ho-id-test-')); temps.push(d); return d; };
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

// sam: an agent from before box ids (no box); lead: a newer one with a box id
function setup(over = {}, env0 = null) {
  const env = env0 || {
    t: T0, dataDir: tmp(), files: tmp(), turns: [], delivered: [], notices: [], cancelled: [], continuations: new Set(),
    recs: { sam: { name: 'sam', model: 'model-a', owner: 'member-1' }, lead: { name: 'lead', box: '0a1b2c3d4e', model: 'model-x' } },
  };
  const opts = {
    dataDir: env.dataDir, log: () => {}, retryMs: 15000, pollMs: 1000,
    now: () => env.t,
    startTurn: async (agent, message, extra) => {
      const turn = { agent, message, origin: extra.origin };
      turn.done = new Promise((res) => { turn.finish = res; });
      env.turns.push(turn);
      return { done: turn.done };
    },
    deliver: async (agent, message, meta) => { env.delivered.push({ agent, message, meta }); },
    isAgentActive: () => false,
    agentExists: async (n) => !!env.recs[n],
    hasContinuation: (id) => env.continuations.has(id),
    interject: () => true, stopTurn: () => {}, cancelContinuations: (id) => env.cancelled.push(id),
    filesFolderFor: (a) => path.join(env.files, a),
    holds: () => false,
    stampOf: (n) => identityOf(env.recs[n]),
    sameAgent: sameAgentIdentity,
    ownerOf: (n) => (env.recs[n] && env.recs[n].owner) || null,
    notifyOwner: (r, why) => { env.notices.push({ id: r.id, caller: r.caller, owner: r.callerOwner, why }); },
    mayTarget: async () => true,
    ...over,
  };
  env.opts = opts;
  env.h = new HandOffs(opts);
  return env;
}
const flush = () => new Promise((r) => setImmediate(r));
async function settle(env) { for (let i = 0; i < 4; i++) { await flush(); await env.h.tick(); env.t += 2000; } await env.h.tick(); }

test('identityOf: the box id, or the name for an agent from before box ids; ordinary edits leave it as it is', () => {
  const old = { name: 'sam', model: 'model-a', effort: 'high', blurb: 'x' };
  assert.strictEqual(identityOf(old), 'name:sam');
  assert.strictEqual(identityOf({ ...old, model: 'model-b', effort: 'low', blurb: 'y', voice: { v: 1 }, compaction: 'on' }), 'name:sam');
  assert.strictEqual(identityOf({ name: 'lead', box: '0a1b2c3d4e', model: 'm' }), 'box:0a1b2c3d4e');
  assert.strictEqual(identityOf({ name: 'lead', box: '0a1b2c3d4e', model: 'other', sharedWith: ['u'] }), 'box:0a1b2c3d4e');
  assert.strictEqual(identityOf(null), null);
  assert.strictEqual(identityOf({}), null);
  // the strict stamp the other checks use still changes with any edit of an agent without a box id
  assert.notStrictEqual(oldStampOf(old), oldStampOf({ ...old, model: 'model-b' }));
});

test('sameAgentIdentity: exact for box and name stamps; an older record stamp names the agent while it has no box id', () => {
  assert.strictEqual(sameAgentIdentity('box:aa11bb22', 'box:aa11bb22'), true);
  assert.strictEqual(sameAgentIdentity('box:aa11bb22', 'box:cc33dd44'), false, 're-made: another box');
  assert.strictEqual(sameAgentIdentity('name:sam', 'name:sam'), true);
  assert.strictEqual(sameAgentIdentity('name:sam', 'box:cc33dd44'), false, 'deleted and made again: the new one has a box id');
  assert.strictEqual(sameAgentIdentity('rec:' + 'a'.repeat(64), 'name:sam'), true, 'an open record from before the update');
  assert.strictEqual(sameAgentIdentity('rec:' + 'a'.repeat(64), 'box:cc33dd44'), false);
  for (const [a, b] of [[null, 'name:sam'], ['name:sam', null], ['', ''], [undefined, undefined], ['box:x', 'name:x']]) assert.strictEqual(sameAgentIdentity(a, b), false, `${a} ${b}`);
});

test('every way of making an agent gives it a box id, and a rename gives one (so a re-made agent never has a name identity)', () => {
  const create = extractFn(AGENTS, 'async function createAgentNow(');
  assert.match(create, /box: newBoxId\(\),/);
  assert.match(AGENTS, /for \(const e of entries\) list\.push\(\{ \.\.\.e, box: newBoxId\(\) \}\);/, 'import');
  assert.match(AGENTS, /box: newBoxId\(\),   \/\/ its own box, never the source's/, 'clone');
  assert.match(AGENTS, /if \(!agent\.box\) agent\.box = newBoxId\(\);/, 'rename');
});

test('the caller\'s model is switched mid-hand-off: its continuation runs and the report is delivered', async () => {
  const env = setup();
  const v = await env.h.create({ caller: 'sam', target: 'lead', topic: 'Tidy the list', brief: 'Do it' });
  assert.strictEqual(env.h.get(v.id).callerStamp, 'name:sam');
  assert.strictEqual(env.h.get(v.id).callerOwner, 'member-1');
  await env.h.tick();
  env.continuations.add(v.id);
  env.turns[0].finish('step one done, a job runs'); await flush();
  env.recs.sam = { ...env.recs.sam, model: 'model-b', effort: 'low' };   // the owner switches the caller's model
  assert.strictEqual(await env.h.mayContinue(v.id, 'lead'), true);
  assert.strictEqual(env.h.turnStarted(v.id, 'lead'), true);
  env.h.turnEnded(v.id, 'all done', 'lead');
  env.continuations.delete(v.id);
  await settle(env);
  assert.strictEqual(env.h.get(v.id).state, 'done');
  assert.strictEqual(env.delivered.length, 1);
  assert.strictEqual(env.delivered[0].agent, 'sam');
  assert.match(env.delivered[0].message, /^\[Hand-off finished\]/);
  assert.deepStrictEqual(env.notices, []);
});

test('the target\'s model is switched mid-hand-off: it carries on and reports', async () => {
  const env = setup();
  env.recs.sam.box = '9f8e7d6c5b';   // both newer agents this time
  const v = await env.h.create({ caller: 'sam', target: 'lead', topic: 'Tidy the list', brief: 'Do it' });
  await env.h.tick();
  env.continuations.add(v.id);
  env.turns[0].finish('step one'); await flush();
  env.recs.lead = { ...env.recs.lead, model: 'model-y', blurb: 'new words', voice: { name: 'v2' } };
  assert.strictEqual(await env.h.mayContinue(v.id, 'lead'), true);
  env.h.turnStarted(v.id, 'lead');
  env.h.turnEnded(v.id, 'finished', 'lead');
  env.continuations.delete(v.id);
  await settle(env);
  assert.strictEqual(env.delivered.length, 1);
  assert.match(env.delivered[0].message, /\[Hand-off finished\]/);
});

test('the caller is deleted and made again under the same name: the report is not given to it; its owner is told', async () => {
  const env = setup();
  const v = await env.h.create({ caller: 'sam', target: 'lead', topic: 'Tidy the list', brief: 'Do it' });
  await env.h.tick();
  env.recs.sam = { name: 'sam', box: '5e5e5e5e5e', model: 'model-a', owner: 'member-2' };   // made again: a box id of its own
  env.turns[0].finish('the secret result'); await flush();
  await settle(env);
  assert.strictEqual(env.delivered.length, 0, 'never delivered to the new agent');
  assert.strictEqual(env.h.get(v.id).report.state, 'dropped');
  assert.ok(env.h.get(v.id).report.ownerTold);
  assert.strictEqual(env.notices.length, 1);
  assert.strictEqual(env.notices[0].owner, 'member-1', 'the owner of the agent that started it, not of the new one');
  assert.match(env.notices[0].why, /gone or is another agent now/);
  await settle(env);
  assert.strictEqual(env.notices.length, 1, 'told once');
});

test('the target is deleted and made again: the hand-off ends and the caller gets "[Hand-off interrupted]" with the replies so far', async () => {
  const env = setup();
  const v = await env.h.create({ caller: 'sam', target: 'lead', topic: 'Tidy the list', brief: 'Do it' });
  await env.h.tick();
  env.continuations.add(v.id);
  env.turns[0].finish('Sorted the first half by supplier.'); await flush();
  env.recs.lead = { name: 'lead', box: '7a7a7a7a7a', model: 'model-x' };
  assert.strictEqual(await env.h.mayContinue(v.id, 'lead'), false);
  assert.strictEqual(env.h.get(v.id).state, 'failed');
  await settle(env);
  assert.strictEqual(env.delivered.length, 1);
  const m = env.delivered[0].message;
  assert.match(m, /^\[Hand-off interrupted\] "Tidy the list" \(id ho-[0-9a-f]+\): it ended before agent "lead" finished, because agent "lead" is not the agent it was handed to any more\./);
  assert.match(m, /What it had replied before it ended:/);
  assert.match(m, /Sorted the first half by supplier\./);
  assert.deepStrictEqual(env.notices, []);
});

test('a record from before the update (an older stamp) keeps working after a model switch, and still ends for a re-made agent', async () => {
  // the hand-off was made by the earlier code: whole-record stamps for an agent without a box id
  const env = setup({ stampOf: (n) => oldStampOf(env0recs()[n]), sameAgent: undefined });
  function env0recs() { return env.recs; }
  const v = await env.h.create({ caller: 'sam', target: 'lead', topic: 'Old one', brief: 'Do it' });
  assert.match(env.h.get(v.id).callerStamp, /^rec:[0-9a-f]{64}$/);
  await env.h.tick();
  env.continuations.add(v.id);
  env.turns[0].finish('step one'); await flush();
  // the update and a restart: the new code reads the same file
  const env2 = setup({}, { ...env, turns: [], delivered: [], notices: [], cancelled: [] });
  env2.h.start();
  env2.recs.sam = { ...env2.recs.sam, model: 'model-b' };
  assert.strictEqual(await env2.h.mayContinue(v.id, 'lead'), true, 'not failed by the model switch');
  env2.h.turnStarted(v.id, 'lead');
  env2.h.turnEnded(v.id, 'done now', 'lead');
  env2.continuations.delete(v.id);
  await settle(env2);
  assert.strictEqual(env2.delivered.length, 1);
  // another old record whose caller is then deleted and made again
  const v2 = await env.h.create({ caller: 'sam', target: 'lead', topic: 'Old two', brief: 'Do it' });
  const env3 = setup({}, { ...env, recs: { ...env.recs }, turns: [], delivered: [], notices: [], cancelled: [] });
  env3.h.start();
  env3.recs.sam = { name: 'sam', box: '1c1c1c1c1c', model: 'model-a' };
  assert.strictEqual(await env3.h.mayContinue(v2.id, 'lead'), false);
  assert.match(env3.h.get(v2.id).error, /not the agent that started it/);
  await settle(env3);
  // (the earlier runner instance saved its own view of the first record with this one, so only this record is looked at)
  assert.strictEqual(env3.delivered.filter(d => d.meta.handOffId === v2.id).length, 0);
  assert.strictEqual(env3.notices.filter(n => n.id === v2.id).length, 1);
});

test('review r1: access lost after the target replied: the hand-off ends and the caller gets no word of what the target wrote', async () => {
  let allowed = true;
  const env = setup({ mayTarget: async () => allowed });
  const v = await env.h.create({ caller: 'sam', target: 'lead', topic: 'Tidy the list', brief: 'Do it' });
  await env.h.tick();
  env.continuations.add(v.id);
  env.turns[0].finish('PRIVATE FIGURES 4411'); await flush();
  allowed = false;   // the owner stops sam from reaching lead
  assert.strictEqual(await env.h.mayContinue(v.id, 'lead'), false);
  await settle(env);
  assert.strictEqual(env.delivered.length, 1);
  assert.match(env.delivered[0].message, /^\[Hand-off interrupted\] .*because agent "sam" may no longer hand work to "lead"\./);
  assert.ok(!env.delivered[0].message.includes('PRIVATE FIGURES'), 'none of the target\'s words');
});

test('review r1: a finished report waiting for delivery when access is lost goes without the target\'s words; an access check that fails waits', async () => {
  let allowed = true, broken = false;
  const env = setup({ mayTarget: async () => { if (broken) throw new Error('accounts unreadable'); return allowed; } });
  let busy = true;
  env.opts.deliver = async (agent, message, meta) => { if (busy) throw new Error('busy'); env.delivered.push({ agent, message, meta }); };
  env.h = new HandOffs(env.opts);
  const v = await env.h.create({ caller: 'sam', target: 'lead', topic: 'Tidy the list', brief: 'Do it' });
  await env.h.tick();
  env.turns[0].finish('PRIVATE FIGURES 4411'); await flush();
  await settle(env);
  assert.strictEqual(env.h.get(v.id).state, 'done');
  assert.strictEqual(env.delivered.length, 0, 'the caller was busy');
  busy = false; broken = true;
  env.t += 60000; await env.h.tick(); await flush();
  assert.strictEqual(env.delivered.length, 0, 'no answer on access: tried again later, not sent');
  assert.strictEqual(env.h.get(v.id).report.state, 'pending');
  broken = false; allowed = false;
  env.t += 60000; await env.h.tick(); await flush();
  assert.strictEqual(env.delivered.length, 1);
  assert.match(env.delivered[0].message, /^\[Hand-off ended\] "Tidy the list" \(id ho-[0-9a-f]+\): agent "sam" may no longer hand work to "lead", so what agent "lead" replied is not passed on\.$/);
  assert.strictEqual(env.h.get(v.id).result, null, 'not kept for a later delivery either');
});

test('review r1: the owner notice is told once and records how many devices it reached', async () => {
  const env = setup({ notifyOwner: async (r, why) => { env.notices.push({ id: r.id, why }); return { sent: 2 }; } });
  const v = await env.h.create({ caller: 'sam', target: 'lead', topic: 'Tidy the list', brief: 'Do it' });
  await env.h.tick();
  env.recs.sam = { name: 'sam', box: '5e5e5e5e5e' };
  env.turns[0].finish('done'); await flush();
  await settle(env); await settle(env);
  assert.strictEqual(env.notices.length, 1);
  assert.strictEqual(env.h.get(v.id).report.ownerTold.sent, 2);
});

test('review r2: an agent made again under the caller\'s name never sees, notes or cancels the earlier agent\'s hand-offs', async () => {
  const env = setup();
  const v = await env.h.create({ caller: 'sam', target: 'lead', topic: 'Tidy the list', brief: 'Do it' });
  await env.h.tick();
  env.continuations.add(v.id);
  env.turns[0].finish('PRIVATE FIGURES 4411'); await flush();
  assert.strictEqual(env.h.list('sam').length, 1);
  env.recs.sam = { name: 'sam', box: '5e5e5e5e5e' };
  assert.deepStrictEqual(env.h.list('sam', { includeDone: true }), []);
  assert.deepStrictEqual(await env.h.listShown('sam', { includeDone: true, withStatus: true }), []);
  assert.throws(() => env.h.note({ caller: 'sam', id: v.id, text: 'hello' }), /No such hand-off/);
  assert.throws(() => env.h.cancel({ caller: 'sam', id: v.id }), /No such hand-off/);
  // an identity that can't be read shows none
  const env2 = setup({ stampOf: () => { throw new Error('unreadable'); } });
  env2.h.items.set(v.id, { ...env.h.get(v.id) });
  assert.deepStrictEqual(env2.h.list('sam', { includeDone: true }), []);
});

test('review r2: listShown gives none of the target\'s words for a target the caller may no longer reach, or can\'t be checked', async () => {
  let allowed = true, broken = false;
  const env = setup({ mayTarget: async () => { if (broken) throw new Error('accounts unreadable'); return allowed; } });
  const v = await env.h.create({ caller: 'sam', target: 'lead', topic: 'Tidy the list', brief: 'Do it' });
  await env.h.tick();
  env.continuations.add(v.id);
  env.turns[0].finish('PRIVATE FIGURES 4411'); await flush();
  fs.writeFileSync(path.join(v.folder, 'STATUS.md'), 'PRIVATE STATUS 77');
  const shown = await env.h.listShown('sam', { withStatus: true });
  assert.match(shown[0].lastReply, /PRIVATE FIGURES/);
  assert.match(String(shown[0].status), /PRIVATE STATUS/);
  for (const [set, kind] of [[() => { allowed = false; }, 'access'], [() => { allowed = true; broken = true; }, 'unchecked']]) {
    set();
    for (const withStatus of [true, false]) {
      const rows = await env.h.listShown('sam', { withStatus });
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].lastReply, null);
      assert.strictEqual(rows[0].withheld, kind);
      assert.strictEqual(rows[0].folder, null, 'no folder, so no Status button');
      if (withStatus) assert.strictEqual(rows[0].status, null);
      assert.ok(!JSON.stringify(rows).includes('PRIVATE'), JSON.stringify(rows));
    }
  }
  broken = false; allowed = false;
  // the agent's tool says why
  const tools = require('../lib/hand-off-tools');
  const out = await tools.runTool('hand_off_list', {}, 'sam', { runner: env.h, mayTarget: async () => false });
  assert.match(out, /STATUS\.md: not shown \(you may no longer hand work to lead\)\./);
  assert.ok(!out.includes('PRIVATE'));
});

test('review r3: a record without a caller stamp is not shown to, noted or cancelled by any agent while identities are checked', async () => {
  const env = setup();
  const v = await env.h.create({ caller: 'sam', target: 'lead', topic: 'Tidy the list', brief: 'Do it' });
  env.h.get(v.id).callerStamp = null;
  assert.deepStrictEqual(env.h.list('sam', { includeDone: true }), []);
  assert.throws(() => env.h.note({ caller: 'sam', id: v.id, text: 'x' }), /No such hand-off/);
  assert.throws(() => env.h.cancel({ caller: 'sam', id: v.id }), /No such hand-off/);
});

test('review r3: a target made again under the same name gets no note, and neither a cancel nor the ending stops its turn', async () => {
  const stopped = [];
  let busy = false;   // the target is busy once its turn runs (the runner waits for an idle target to start one)
  const env = setup({ isAgentActive: () => busy, stopTurn: (a) => stopped.push(a) });
  const v = await env.h.create({ caller: 'sam', target: 'lead', topic: 'Tidy the list', brief: 'Do it' });
  await env.h.tick(); busy = true;
  assert.strictEqual(env.h.get(v.id).state, 'running');
  env.recs.lead = { name: 'lead', box: '7a7a7a7a7a' };   // re-made while the record still says running
  assert.throws(() => env.h.note({ caller: 'sam', id: v.id, text: 'more' }), /not the agent it was handed to any more, so the note was not sent/);
  env.h.cancel({ caller: 'sam', id: v.id });
  assert.deepStrictEqual(stopped, [], 'the new agent\'s turn is not stopped by a cancel');
  const v2 = await env.h.create({ caller: 'sam', target: 'lead', topic: 'Second', brief: 'Do it' });
  busy = false;   // v2 goes to the lead agent there is now
  await env.h.tick(); busy = true;
  assert.strictEqual(env.h.get(v2.id).state, 'running');
  env.recs.lead = { name: 'lead', box: '8b8b8b8b8b' };
  assert.strictEqual(await env.h.mayContinue(v2.id, 'lead'), false);
  assert.deepStrictEqual(stopped, [], 'nor by the hand-off ending');
  // the same target: a cancel still stops its running turn
  busy = false;
  const env2 = setup({ isAgentActive: () => busy, stopTurn: (a) => stopped.push(a) });
  const v3 = await env2.h.create({ caller: 'sam', target: 'lead', topic: 'Third', brief: 'Do it' });
  await env2.h.tick(); busy = true;
  env2.h.cancel({ caller: 'sam', id: v3.id });
  assert.deepStrictEqual(stopped, ['lead']);
});

test('review r3: hand_off_note refuses when the caller may no longer reach the target; the card never opens Status for a withheld row', async () => {
  const env = setup();
  const v = await env.h.create({ caller: 'sam', target: 'lead', topic: 'Tidy the list', brief: 'Do it' });
  await env.h.tick();
  const tools = require('../lib/hand-off-tools');
  const out = await tools.runTool('hand_off_note', { id: v.id, text: 'more please' }, 'sam', { runner: env.h, mayTarget: async () => false });
  assert.match(out, /You may no longer hand work to "lead", so the note was not sent\./);
  assert.strictEqual(env.h.get(v.id).notes.length, 0);
  const H = require('../lib/ui-hand-off-card');
  let fetched = 0;
  const r = await H.openStatus({ id: v.id, target: 'lead', topic: 'T', state: 'running', folder: null, withheld: 'access' }, { document: {}, fetchFn: async () => { fetched++; return { ok: false }; } });
  assert.strictEqual(r, null);
  assert.strictEqual(fetched, 0);
});

test('review r4: a cancel or a note reaches only the hand-off\'s own turn, never the person\'s chat with the target', async () => {
  // the hub's rule (lib/sdk-chat): the running turn's origin must carry this hand-off's id
  const registry = new Map();
  const stopped = [], interjected = [];
  let active = false;
  const env = setup({
    isAgentActive: () => active,
    stopTurn: (agent, id) => { const t = registry.get(agent); if (id && t && t.origin.handOff === id) stopped.push([agent, id]); },
    interject: (agent, text, id) => { const t = registry.get(agent); if (!id || !(t && t.origin.handOff === id)) return false; interjected.push([agent, id]); return true; },
    startTurn: async () => new Promise(() => {}),   // admission never finishes: the record says running meanwhile
  });
  const v = await env.h.create({ caller: 'sam', target: 'lead', topic: 'Tidy the list', brief: 'Do it' });
  env.h.tick();
  await flush(); await flush();
  assert.strictEqual(env.h.get(v.id).state, 'running');
  registry.set('lead', { origin: { kind: 'user' } }); active = true;   // the person's own chat with lead runs
  const n = env.h.note({ caller: 'sam', id: v.id, text: 'one more thing' });
  assert.deepStrictEqual(interjected, []);
  assert.strictEqual(n.queuedNotes, 1, 'kept for the hand-off\'s next step');
  env.h.cancel({ caller: 'sam', id: v.id });
  assert.deepStrictEqual(stopped, [], 'the person\'s turn keeps running');
  // the hand-off's own turn is still reached (a fresh runner: the first admission still holds lead in this one)
  const env2 = setup({ isAgentActive: () => active, stopTurn: env.opts.stopTurn, interject: env.opts.interject, startTurn: env.opts.startTurn });
  const v2 = await env2.h.create({ caller: 'sam', target: 'lead', topic: 'Second', brief: 'Do it' });
  active = false; env2.h.tick(); await flush(); await flush();
  assert.strictEqual(env2.h.get(v2.id).state, 'running');
  registry.set('lead', { origin: { kind: 'hand_off', handOff: v2.id } }); active = true;
  env2.h.note({ caller: 'sam', id: v2.id, text: 'go on' });
  assert.deepStrictEqual(interjected, [['lead', v2.id]]);
  env2.h.cancel({ caller: 'sam', id: v2.id });
  assert.deepStrictEqual(stopped, [['lead', v2.id]]);
  const sdk = read('lib/sdk-chat.js');
  const factory = sdk.slice(sdk.indexOf('function getHandOffRunner() {'), sdk.indexOf("voiceCall.registerProducer('hand_off'"));
  assert.match(factory, /interject: \(agent, text, id\) => \{\n\s+const t = turnRegistry\.get\(agent\);\n\s+if \(!id \|\| !\(t && t\.origin && t\.origin\.handOff === id\)\) return false;/);
  assert.match(factory, /stopTurn: \(agent, id\) => \{\n\s+const t = turnRegistry\.get\(agent\);\n\s+if \(!id \|\| !\(t && t\.origin && t\.origin\.handOff === id\)\) return;/);
  assert.ok(!/this\.stopTurn\(r\.target\)|this\.interject\(r\.target, noteMessage\(r, \[n\]\)\)/.test(read('lib/hand-offs.js')), 'every call passes the id');
});

test('review r4: hand_off_note gives another agent of the caller\'s name nothing about an earlier agent\'s hand-off', async () => {
  const env = setup();
  const v = await env.h.create({ caller: 'sam', target: 'lead', topic: 'Tidy the list', brief: 'Do it' });
  env.recs.sam = { name: 'sam', box: '5e5e5e5e5e' };
  const tools = require('../lib/hand-off-tools');
  const out = await tools.runTool('hand_off_note', { id: v.id, text: 'hi' }, 'sam', { runner: env.h, mayTarget: async () => false });
  assert.ok(!out.includes('lead'), out);
  assert.match(out, /No such hand-off/);
});

test('the hub wires hand-offs to the identity, its matching rule, the caller\'s owner and the owner notice; other checks keep the strict stamp', () => {
  const sdk = read('lib/sdk-chat.js');
  const factory = sdk.slice(sdk.indexOf('function getHandOffRunner() {'), sdk.indexOf("voiceCall.registerProducer('hand_off'"));
  assert.match(factory, /stampOf: \(name\) => require\('\.\/agents'\)\.agentIdentity\(name\),/);
  assert.match(factory, /sameAgent: \(stored, now\) => require\('\.\/agents'\)\.sameAgentIdentity\(stored, now\),/);
  assert.match(factory, /ownerOf: \(name\) =>/);
  assert.match(factory, /notifyOwner: async \(r, why\) =>/);
  assert.match(factory, /await push\.notifyUsers\(payload, \[r\.callerOwner\], \{ kind: 'other' \}\)/);
  assert.match(factory, /push\.notify\(payload, \{ adminsOnly: true, kind: 'other' \}\)/);
  assert.ok(!factory.includes('agentStamp('), 'hand-offs no longer use the whole-record stamp');
  const notice = factory.slice(factory.indexOf('notifyOwner: async'), factory.indexOf('mayTarget:'));
  assert.ok(!/r\.topic/.test(notice), 'the phone notice names agents only, never the topic');
  assert.match(notice, /if \(sent\) return \{ sent \};\n\s+\}\n\s+const a = await push\.notify\(payload, \{ adminsOnly: true, kind: 'other' \}\);/, 'the admins when no member device got it');
  for (const f of ['lib/behaviour-switch.js', 'lib/model-offer-switch.js', 'lib/connector-access.js']) assert.match(read(f), /agentStamp\(name\)/, f);
  assert.strictEqual(typeof stampOf, 'function');
});
