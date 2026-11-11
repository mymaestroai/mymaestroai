'use strict';
// for_owner: an agent marks its reply in a turn the hub started as one the owner must see. The tool exists on both
// tool lists on the agent's own turns only; the handler stores a mark for the running turn; the turn's saved assistant
// entry then carries for_owner; the phone gets one notice per turn; the agent is told about it in its notes and prompts.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sdkChat = require('../lib/sdk-chat');
const hubEvents = require('../lib/hub-events');
const { createPush } = require('../lib/push');
const scheduledTasks = require('../lib/scheduled-tasks');
const { handleForOwner, forOwnerMarks, FOR_OWNER_DESC, getWorkspaceTools } = sdkChat.__forOwner;
const { buildHubMcpServer, appendConversationLog } = sdkChat.__askUser;

const AGENT = 'zz_for_owner_test';
const convFile = path.join(__dirname, '..', 'data', 'conversations', `${AGENT}.jsonl`);
fs.mkdirSync(path.dirname(convFile), { recursive: true });
after(() => { try { fs.unlinkSync(convFile); } catch {} });
const readLog = () => fs.existsSync(convFile) ? fs.readFileSync(convFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const fakeRes = () => ({ write() { return true; }, on() {}, writableEnded: false, destroyed: false });
const fakeSdk = { tool: (name, description, shape, handler, opts) => ({ name, description, shape, handler, opts }), createSdkMcpServer: (o) => o };
const REMINDER = 'If the person you work for must see your reply, call for_owner; otherwise it stays folded in their chat.';

// A running turn of AGENT in the real hub-events registry.
function startTurn(origin, turnId) {
  const res = { write: () => true };
  const tap = hubEvents.events.tapTurn(res, { agent: AGENT, origin, message: 'x', turnId });
  return tap;
}

test('for_owner is on the gateway tool list at depth 0 and absent when consulted', () => {
  const own = getWorkspaceTools(AGENT, fakeRes(), 0);
  const t = own.find(x => x.name === 'for_owner');
  assert.ok(t, 'offered on its own turn');
  assert.strictEqual(t.description, FOR_OWNER_DESC);
  assert.deepStrictEqual(t.parameters.required, ['reason']);
  assert.ok(!getWorkspaceTools(AGENT, fakeRes(), 1).some(x => x.name === 'for_owner'), 'withheld when another agent consults it');
});

test('for_owner is in the hub MCP server (Claude and Codex clients) at depth 0 and absent at depth 1', async () => {
  const own = await buildHubMcpServer(AGENT, fakeRes(), fakeSdk, { consultationDepth: 0 });
  const t = own.tools.find(x => x.name === 'for_owner');
  assert.ok(t, 'registered');
  assert.strictEqual(t.description, FOR_OWNER_DESC);
  assert.deepStrictEqual(Object.keys(t.shape), ['reason']);
  assert.ok(!t.shape.reason.isOptional(), 'reason is required');
  const consulted = await buildHubMcpServer(AGENT, fakeRes(), fakeSdk, { consultationDepth: 1 });
  assert.ok(!consulted.tools.some(x => x.name === 'for_owner'));
});

test('for_owner is not offered on tiger-team or ephemeral turns', async () => {
  assert.ok(!getWorkspaceTools(AGENT, fakeRes(), 0, true).some(x => x.name === 'for_owner'), 'gateway list, tiger team');
  const tt = await buildHubMcpServer(AGENT, fakeRes(), fakeSdk, { consultationDepth: 0, tigerTeam: true });
  assert.ok(!tt.tools.some(x => x.name === 'for_owner'), 'MCP server, tiger team');
  const eph = await buildHubMcpServer(AGENT, fakeRes(), fakeSdk, { consultationDepth: 0, ephemeral: true });
  assert.ok(!eph.tools.some(x => x.name === 'for_owner'), 'MCP server, ephemeral');
  const own = await buildHubMcpServer(AGENT, fakeRes(), fakeSdk, { consultationDepth: 0 });
  assert.ok(own.tools.some(x => x.name === 'for_owner'), 'still on an ordinary turn');
});

test('the tool policy classes for_owner as a harmless write inside the hub', () => {
  const tp = require('../lib/tool-policy');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tool-policy.js'), 'utf8');
  assert.match(src, /HUB_WRITE_INSIDE = new Set\([^)]*'for_owner'/);
  assert.ok(tp);
});

test('an automatic turn: the handler stores the mark for that turn and publishes for_owner', () => {
  forOwnerMarks.clear();
  const seen = [];
  const off = hubEvents.events.onPublish(ev => { if (ev.type === 'for_owner') seen.push(ev); });
  const tap = startTurn({ kind: 'schedule', label: 'morning check' }, 'fo-turn-1');
  const out = handleForOwner(AGENT, { reason: 'Needs your approval\nfor the wire' });
  assert.strictEqual(out, 'Marked: your reply will show open in the chat, and their phone gets a notice.');
  const mark = forOwnerMarks.get(AGENT);
  assert.strictEqual(mark.turnId, 'fo-turn-1');
  assert.strictEqual(mark.reason, 'Needs your approval for the wire');
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].agent, AGENT);
  assert.strictEqual(seen[0].turnId, 'fo-turn-1');
  assert.strictEqual(seen[0].origin.kind, 'schedule');
  tap.finish(true, null);
  if (typeof off === 'function') off();
});

test('a turn the owner started: nothing is stored, and no turn running stores nothing either', () => {
  forOwnerMarks.clear();
  const tap = startTurn({ kind: 'user' }, 'fo-turn-user');
  assert.match(handleForOwner(AGENT, { reason: 'r' }), /started by them, so your reply already shows; no mark needed/);
  assert.strictEqual(forOwnerMarks.has(AGENT), false);
  tap.finish(true, null);
  assert.match(handleForOwner('zz_for_owner_idle', { reason: 'r' }), /./);
  assert.strictEqual(forOwnerMarks.has('zz_for_owner_idle'), false);
  const comms = startTurn({ kind: 'comms' }, 'fo-turn-comms');
  handleForOwner(AGENT, { reason: 'r' });
  assert.strictEqual(forOwnerMarks.has(AGENT), false, 'a channel message came from the person');
  comms.finish(true, null);
});

test('a consultation-origin turn is refused: nothing is stored and no event is published', () => {
  forOwnerMarks.clear();
  const seen = [];
  const off = hubEvents.events.onPublish(ev => { if (ev.type === 'for_owner') seen.push(ev); });
  const tap = startTurn({ kind: 'consultation', from: 'lead' }, 'fo-turn-consult');
  assert.match(handleForOwner(AGENT, { reason: 'r' }), /consultation stays folded in the chat, so there is nothing to mark/);
  assert.strictEqual(forOwnerMarks.has(AGENT), false);
  assert.strictEqual(seen.length, 0);
  tap.finish(true, null);
  if (typeof off === 'function') off();
});

test('a handler built for turn A refuses while turn B runs (stale handler); one built for B marks B', async () => {
  forOwnerMarks.clear();
  const seen = [];
  const off = hubEvents.events.onPublish(ev => { if (ev.type === 'for_owner') seen.push(ev); });
  const a = startTurn({ kind: 'schedule', label: 'first' }, 'fo-turn-A');
  const staleGateway = getWorkspaceTools(AGENT, fakeRes(), 0).find(x => x.name === 'for_owner');
  const staleMcp = (await buildHubMcpServer(AGENT, fakeRes(), fakeSdk, { consultationDepth: 0 })).tools.find(x => x.name === 'for_owner');
  a.finish(true, null);
  const b = startTurn({ kind: 'job_notice' }, 'fo-turn-B');
  const refused = 'This tool belongs to an earlier turn; nothing was marked.';
  assert.strictEqual(await staleGateway.handler({ reason: 'r' }), refused);
  assert.strictEqual((await staleMcp.handler({ reason: 'r' })).content[0].text, refused);
  assert.strictEqual(forOwnerMarks.has(AGENT), false, 'nothing stored');
  assert.strictEqual(seen.length, 0, 'no event');
  const fresh = getWorkspaceTools(AGENT, fakeRes(), 0).find(x => x.name === 'for_owner');
  assert.match(await fresh.handler({ reason: 'r' }), /^Marked:/);
  assert.strictEqual(forOwnerMarks.get(AGENT).turnId, 'fo-turn-B');
  b.finish(true, null);
  if (typeof off === 'function') off();
  // Built with no turn running: the old behaviour (the running turn is marked).
  forOwnerMarks.clear();
  const idleBuilt = getWorkspaceTools(AGENT, fakeRes(), 0).find(x => x.name === 'for_owner');
  const c = startTurn({ kind: 'schedule' }, 'fo-turn-C');
  assert.match(await idleBuilt.handler({ reason: 'r' }), /^Marked:/);
  c.finish(true, null);
});

test('appendConversationLog saves for_owner on the marked turn\'s assistant entry (also progress saves) and never on the next turn', () => {
  try { fs.unlinkSync(convFile); } catch {}
  forOwnerMarks.clear();
  const tap = startTurn({ kind: 'job_notice' }, 'fo-turn-a');
  handleForOwner(AGENT, { reason: 'x'.repeat(300) });
  appendConversationLog(AGENT, 'assistant', 'part of the reply');
  appendConversationLog(AGENT, 'assistant', 'part of the reply, and the rest', true);
  appendConversationLog(AGENT, 'user', 'a user line');
  let log = readLog();
  assert.strictEqual(log.length, 2);
  assert.strictEqual(log[0].for_owner, true);
  assert.strictEqual(log[0].for_owner_reason.length, 200);
  assert.strictEqual(log[0].content, 'part of the reply, and the rest', 'the progress save kept the mark');
  assert.strictEqual(log[1].for_owner, undefined, 'only assistant entries');
  tap.finish(true, null);

  const next = startTurn({ kind: 'schedule' }, 'fo-turn-b');
  appendConversationLog(AGENT, 'assistant', 'the next turn replies');
  log = readLog();
  assert.strictEqual(log[log.length - 1].content, 'the next turn replies');
  assert.strictEqual(log[log.length - 1].for_owner, undefined, 'a mark never applies to a different turn');
  next.finish(true, null);
});

test('push: for_owner sends once per turn to the devices that follow the agent, with the tap target', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'for-owner-push-'));
  const sent = []; const logs = [];
  const push = createPush({
    dir, now: () => 1_000_000, log: (...a) => logs.push(a.join(' ')),
    ownerOf: (a) => (a === 'patient-a-agent' ? 'u_sam' : null),
    displayName: (a) => ({ 'patient-a-agent': 'Helper' }[a] || a),
    webpush: { generateVAPIDKeys: () => ({ publicKey: 'PUBKEY', privateKey: 'PRIVKEY' }) },
    sender: async (sub, body, opts) => { sent.push({ sub, body: JSON.parse(body), opts }); },
  });
  const SUB = (n) => ({ endpoint: `https://push.example.test/send/${n}`, keys: { p256dh: 'BPkey' + n, auth: 'auth' + n } });
  push.subscribe(SUB(1), null, { id: 'u_sam', role: 'member' });
  push.subscribe(SUB(2), null, { id: 'u_other', role: 'member' });
  push.subscribe(SUB(3), null, { id: 'u_admin', role: 'admin' });
  const ev = { type: 'for_owner', agent: 'patient-a-agent', reason: 'Needs your approval of the plan', turnId: 't-1', origin: { kind: 'schedule' } };
  push.onEvent(ev);
  push.onEvent(ev);   // the same turn again: nothing
  await new Promise(r => setImmediate(r));
  assert.strictEqual(sent.length, 1, 'once per turn, only the owner\'s device');
  assert.strictEqual(sent[0].sub.endpoint, SUB(1).endpoint);
  assert.deepStrictEqual(
    { title: sent[0].body.title, body: sent[0].body.body, url: sent[0].body.url, tag: sent[0].body.tag, ts: sent[0].body.ts },
    { title: 'Helper has something for you', body: 'Needs your approval of the plan · Tap to open', url: '/mobile#chat=patient-a-agent', tag: 'for-owner-patient-a-agent', ts: 1_000_000 });
  assert.strictEqual(sent[0].opts.urgency, 'high');
  assert.ok(logs.some(l => /for-owner push for patient-a-agent: sent 1, failed 0/.test(l)), logs.join('|'));
  push.onEvent({ ...ev, turnId: 't-2' });
  await new Promise(r => setImmediate(r));
  assert.strictEqual(sent.length, 2, 'a new turn notifies again');
});

test('the agent notes explain for_owner, and automatic prompts carry the one-line reminder', () => {
  assert.match(scheduledTasks.policyText(), /## REPLIES THEY MUST SEE[\s\S]*`for_owner`/);
  const jobs = require('../lib/jobs');
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8');
  assert.ok(src('scheduler.js').includes(REMINDER), 'TASKS.md prompt');
  assert.ok(src('scheduled-tasks.js').includes(REMINDER), 'scheduled-task prompt');
  assert.ok(src('jobs.js').includes('FOR_OWNER_REMINDER') && src('jobs.js').includes(REMINDER), 'job notices');
  assert.ok(jobs);
  // the notes reach every agent's per-turn prompt on all three routes
  assert.strictEqual((src('sdk-chat.js').match(/scheduledTasks\.policyText\(\)/g) || []).length, 3);
});

test('the scheduled-task prompt itself ends with the reminder', () => {
  const st = new scheduledTasks.ScheduledTasks({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'for-owner-st-')), tick: false, post: async () => ({}) });
  const t = { label: 'check', id: 'st-1', createdBy: 'sam', agent: 'a', createdAt: new Date().toISOString(), schedule: { type: 'once', text: 'x', tz: 'UTC' }, prompt: 'Do it', nextRunAt: null };
  const m = st.message(t, { dueAt: new Date().toISOString() }, { late: false });
  assert.ok(m.endsWith(REMINDER), m);
  st.stop && st.stop();
});
