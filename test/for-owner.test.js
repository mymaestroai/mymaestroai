'use strict';
// for_owner: an agent marks its reply in a turn the hub started as one the owner must see. The tool exists on both
// tool lists across turn kinds. When permitted, the handler stores a mark for the running turn and the saved assistant
// entry then carries for_owner; the phone gets one notice per turn; the agent is told about it in its notes and prompts.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// lib/ comes from a throwaway install, so nothing under the real data/ is touched.
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('for-owner-iso-');
const L = (p) => require(path.join(ISO.lib, p));
const sdkChat = L('sdk-chat');
const hubEvents = L('hub-events');
const { createPush } = L('push');
const scheduledTasks = L('scheduled-tasks');
const { handleForOwner, forOwnerMarks, FOR_OWNER_DESC, getWorkspaceTools } = sdkChat.__forOwner;
const { buildHubMcpServer, appendConversationLog } = sdkChat.__askUser;

const AGENT = 'zz_for_owner_test';
const convFile = path.join(ISO.data, 'conversations', `${AGENT}.jsonl`);
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

test('for_owner is on the gateway tool list with its original schema', () => {
  const own = getWorkspaceTools(AGENT, fakeRes(), 0);
  const t = own.find(x => x.name === 'for_owner');
  assert.ok(t, 'offered on its own turn');
  assert.strictEqual(t.description, FOR_OWNER_DESC);
  assert.deepStrictEqual(t.parameters.required, ['reason']);
  assert.strictEqual(t.parameters.properties.asks.type, 'boolean', 'asks is an optional boolean');
  assert.strictEqual(t.parameters.properties.requested.type, 'boolean', 'requested is an optional boolean');
  assert.ok(!t.parameters.required.includes('requested'));
  assert.match(t.parameters.properties.requested.description, /"Requests you made" setting/);
});

test('for_owner is in the hub MCP server (Claude and Codex clients) with its original schema', async () => {
  const own = await buildHubMcpServer(AGENT, fakeRes(), fakeSdk, { consultationDepth: 0 });
  const t = own.tools.find(x => x.name === 'for_owner');
  assert.ok(t, 'registered');
  assert.strictEqual(t.description, FOR_OWNER_DESC);
  assert.deepStrictEqual(Object.keys(t.shape), ['reason', 'asks', 'requested']);   // asks and requested: optional, added with per-agent notification settings
  assert.ok(!t.shape.reason.isOptional(), 'reason is required');
  assert.ok(t.shape.asks.isOptional(), 'asks is optional');
  assert.ok(t.shape.requested.isOptional(), 'requested is optional');
  assert.match(FOR_OWNER_DESC, /requested: true when they asked you to tell them \("let me know when\.\.\."\); requested also works in a turn they started/);
});

test('owner marks and every hand-off tool stay registered and keep their original permissions', async (t) => {
  const tw = L('temporal-workers');
  const worker = tw.createVirtual({ parent: AGENT, toolScope: 'read' });
  const names = ['hand_off', 'hand_off_list', 'hand_off_note', 'hand_off_cancel'];
  const agents = L('agents');
  const handOffs = L('hand-off-tools');
  t.mock.method(agents, 'getAgentsSync', () => [{ name: AGENT, category: 'primary' }]);
  const run = t.mock.method(handOffs, 'runTool', async (name) => `Ran ${name}`);
  const published = [];
  const off = hubEvents.events.onPublish(ev => { if (ev.type === 'for_owner') published.push(ev); });
  try {
    for (const [kind, options, marks, handsOff] of [
      ['user', {}, [false, false], true],
      ['requested', {}, [true, true], true],
      ['schedule', {}, [true, true], true],
      ['consultation', { consultationDepth: 1 }, [false, false], false],
      ['hand_off', { consultationDepth: 1 }, [false, false], false],
      ['ephemeral', { ephemeral: true }, [true, false], true],
      ['tiger', { tigerTeam: true }, [false, false], true],
      ['virtual', { ephemeral: true }, [false, false], false],
    ]) {
      const agent = kind === 'virtual' ? worker.id : AGENT;
      const origin = kind === 'requested' ? 'user' : ['ephemeral', 'tiger', 'virtual'].includes(kind) ? 'schedule' : kind;
      const tap = hubEvents.events.tapTurn(fakeRes(), { agent, origin: { kind: origin }, message: 'x', turnId: `availability-${kind}` });
      try {
        const gateway = getWorkspaceTools(agent, fakeRes(), options.consultationDepth, options.tigerTeam);
        const mcp = (await buildHubMcpServer(agent, fakeRes(), fakeSdk, options)).tools;
        for (const [index, list] of [gateway, mcp].entries()) {
          const call = async (name, args) => {
            const tool = list.find(tool => tool.name === name);
            assert.ok(tool, `${kind}: ${name} is registered on path ${index}`);
            const result = await tool.handler(args);
            if (index) assert.strictEqual(result.isError, undefined);
            return index ? result.content[0].text : result;
          };
          const count = published.length;
          forOwnerMarks.delete(agent);
          const marked = await call('for_owner', { reason: kind, requested: !['user', 'schedule'].includes(kind) });
          assert.match(marked, marks[index] ? /^Marked:/ : kind === 'user' ? /^Not needed here/ : /^This turn cannot be marked/);
          assert.strictEqual(forOwnerMarks.has(agent), marks[index], kind);
          assert.strictEqual(published.length - count, Number(marks[index]), kind);
          const handOffCount = run.mock.callCount();
          for (const name of names) {
            assert.strictEqual(await call(name, {}), handsOff ? `Ran ${name}` : 'Hand-offs can only be started from your own turn.');
          }
          assert.strictEqual(run.mock.callCount() - handOffCount, handsOff ? names.length : 0, kind);
        }
      } finally {
        tap.finish(true, null);
        forOwnerMarks.delete(agent);
      }
    }
  } finally {
    off();
    tw.releaseVirtual(worker.id);
  }
});

test('the read-only SDK and Codex Bash stub never calls the real tool callback', async () => {
  const text = 'This helper is read-only: it has no shell. Use Read, Grep or Glob. If the job needs a command run, say so in your report so your lead can start a helper with full tools.';
  const tw = L('temporal-workers');
  const hands = L('hub-tools').createHubTools();
  let calls = 0;
  hands.call = () => { calls++; throw new Error('real tools must not be called by the stub'); };
  for (const sdk of [fakeSdk, L('codex-cli/bridge').collectingSdk]) {
    const opts = { blocked: tw.sdkDisallowedFor('read'), readOnlyHelper: true };
    for (const only of [null, ['Bash'], ['Bash', ...sdkChat.SEARCH_BOTH_TOOLS]]) {
      const { tools } = sdkChat.buildHandsMcpServer(sdk, hands, { ...opts, only });
      assert.ok(!tools.some(tool => ['Write', 'Edit'].includes(tool.name)));
      const bash = tools.find(tool => tool.name === 'Bash');
      assert.strictEqual(bash.description, text);
      for (const run_in_background of [true, false]) {
        assert.deepStrictEqual(await bash.handler({ command: 'anything', run_in_background }), { content: [{ type: 'text', text }] });
      }
    }
    const none = sdkChat.buildHandsMcpServer(sdk, hands, { blocked: tw.sdkDisallowedFor('none') });
    assert.deepStrictEqual(none.tools, []);
  }
  assert.strictEqual(calls, 0);
});

test('the tool policy classes for_owner as a harmless write inside the hub', () => {
  const tp = L('tool-policy');
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

test('asks: true is published only for a strict boolean true', () => {
  const seen = [];
  const off = hubEvents.events.onPublish(ev => { if (ev.type === 'for_owner') seen.push(ev); });
  for (const [i, asks] of [[1, true], [2, 'true'], [3, 1], [4, false], [5, undefined]]) {
    forOwnerMarks.clear();
    const tap = startTurn({ kind: 'schedule', label: 'check' }, 'fo-asks-' + i);
    handleForOwner(AGENT, { reason: 'r', asks });
    tap.finish(true, null);
  }
  if (typeof off === 'function') off();
  assert.deepStrictEqual(seen.map(e => e.asks), [true, undefined, undefined, undefined, undefined]);
  assert.ok(!('asks' in seen[1]));
});

test('a turn the owner started: nothing is stored, and no turn running stores nothing either', () => {
  forOwnerMarks.clear();
  const tap = startTurn({ kind: 'user' }, 'fo-turn-user');
  assert.match(handleForOwner(AGENT, { reason: 'r' }), /^Not needed here: the person started this turn/);
  assert.strictEqual(forOwnerMarks.has(AGENT), false);
  tap.finish(true, null);
  assert.match(handleForOwner('zz_for_owner_idle', { reason: 'r' }), /./);
  assert.strictEqual(forOwnerMarks.has('zz_for_owner_idle'), false);
  const comms = startTurn({ kind: 'comms' }, 'fo-turn-comms');
  handleForOwner(AGENT, { reason: 'r' });
  assert.strictEqual(forOwnerMarks.has(AGENT), false, 'a channel message came from the person');
  comms.finish(true, null);
});

test('requested: true is published only for a strict true, and wins over asks', () => {
  const seen = [];
  const off = hubEvents.events.onPublish(ev => { if (ev.type === 'for_owner') seen.push(ev); });
  const cases = [[1, { requested: true }], [2, { requested: true, asks: true }], [3, { requested: 'true' }], [4, { requested: 1 }], [5, { requested: false, asks: true }]];
  for (const [i, extra] of cases) {
    forOwnerMarks.clear();
    const tap = startTurn({ kind: 'schedule', label: 'check' }, 'fo-req-' + i);
    handleForOwner(AGENT, { reason: 'r', ...extra });
    tap.finish(true, null);
  }
  if (typeof off === 'function') off();
  assert.deepStrictEqual(seen.map(e => e.requested), [true, true, undefined, undefined, undefined]);
  assert.deepStrictEqual(seen.map(e => e.asks), [undefined, undefined, undefined, undefined, true], 'asks is dropped when requested is true');
});

test('requested: true in a turn the person started marks and publishes (the reply already shows; the push goes); a plain call does not', () => {
  for (const kind of ['user', 'comms']) {
    forOwnerMarks.clear();
    const seen = [];
    const off = hubEvents.events.onPublish(ev => { if (ev.type === 'for_owner') seen.push(ev); });
    const tap = startTurn({ kind }, 'fo-req-user-' + kind);
    assert.match(handleForOwner(AGENT, { reason: 'plain' }), /^Not needed here: the person started this turn/);
    assert.strictEqual(seen.length, 0, 'a plain call is still refused');
    assert.match(handleForOwner(AGENT, { reason: 'Done: all work finished', requested: true }), /^Marked/);
    assert.strictEqual(forOwnerMarks.get(AGENT).turnId, 'fo-req-user-' + kind);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].requested, true);
    assert.strictEqual(seen[0].reason, 'Done: all work finished');
    tap.finish(true, null);
    if (typeof off === 'function') off();
  }
});

test('requested: true in a consultation is still refused', () => {
  forOwnerMarks.clear();
  const seen = [];
  const off = hubEvents.events.onPublish(ev => { if (ev.type === 'for_owner') seen.push(ev); });
  const tap = startTurn({ kind: 'consultation', from: 'lead' }, 'fo-req-consult');
  assert.match(handleForOwner(AGENT, { reason: 'r', requested: true }), /consultation stays folded/);
  assert.strictEqual(forOwnerMarks.has(AGENT), false);
  assert.strictEqual(seen.length, 0);
  tap.finish(true, null);
  if (typeof off === 'function') off();
});

test('a requested mark with no reason is still allowed', () => {
  forOwnerMarks.clear();
  const tap = startTurn({ kind: 'schedule', label: 'check' }, 'fo-req-noreason');
  assert.match(handleForOwner(AGENT, { requested: true }), /^Marked/);
  tap.finish(true, null);
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
  assert.match(scheduledTasks.policyText(), /asks you to tell them when something happens \("let me know when\.\.\."\), arrange to check for it \(schedule_task or a job\) and, when it happens, call `for_owner` with requested: true and a one-line message saying what happened/);
  const jobs = L('jobs');
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
