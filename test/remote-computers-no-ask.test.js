'use strict';
// Remote computers, no-ask agents: an agent the owner listed in no_ask_agents starts Act/Drive sessions without a question (same level check, same
// notice on the computer, still one log line per command). Everyone else is asked as before.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGate } = require('../modules/remote-computers/lib/gate');
const { MeshError } = require('../modules/remote-computers/lib/meshclient');
const { createRemote } = require('../modules/remote-computers/server');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../modules/remote-computers/module.json'), 'utf8'));
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const rejects = async (p, code) => {
  try { await p; } catch (e) { assert.strictEqual(e.code, code, e.message); return e; }
  assert.fail('should have been refused');
  return null;
};

function newGate(over = {}) {
  let t = 9000000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const asked = [], toasts = [], logs = [];
  const gate = createGate({
    levels: ['sam:act', 'pat:drive', 'lee:look', 'owner:drive'], noAskAgents: ['sam', 'pat', 'lee'], sessionMinutes: 30, now: clock.now,
    log: (...a) => logs.push(a.join(' ')),
    approve: async (q) => { asked.push(q); return 'allow'; },
    toast: async (id, title, msg) => { toasts.push({ id, title, msg }); },
    ...over,
  });
  return { gate, clock, asked, toasts, logs };
}
const PC1 = { id: 'pc1', name: 'demo-pc' }, PC2 = { id: 'pc2', name: 'other-pc' };

test('manifest: levels declaration and the no_ask_agents list', () => {
  assert.deepStrictEqual(manifest.levels, { setting: 'levels', choices: ['look', 'act', 'drive'], default: 'look', sessionApproval: { setting: 'no_ask_agents', levels: ['act', 'drive'] } });
  const s = manifest.settings.find((x) => x.key === 'no_ask_agents');
  assert.deepStrictEqual([s.type, s.default], ['list', []]);
  assert.ok(new RegExp(s.pattern).test('sam') && !new RegExp(s.pattern).test('sam:act') && !new RegExp(s.pattern).test('Sam'));
  assert.deepStrictEqual(manifest.settings.find((x) => x.key === 'levels').default, []);
});

test('gate: a no-ask agent gets a session at its level with no question, a notice and a distinguishable log line', async () => {
  const { gate, asked, toasts, logs } = newGate();
  await gate.require('sam', 'act', PC1, { as: 'user' });   // no call id needed: nobody is asked
  assert.strictEqual(asked.length, 0);
  assert.deepStrictEqual(toasts, [{ id: 'pc1', title: 'My Maestro', msg: 'sam is using this computer for the next 30 minutes.' }]);
  assert.ok(logs.some((l) => /without asking the owner \(no-ask agent\): sam, act-user, computer pc1/.test(l)), logs.join('|'));
  assert.strictEqual(gate.stillValid('sam', 'pc1', 'act', 'user'), true);
  assert.strictEqual(gate.sessions().length, 1);
  assert.strictEqual(gate.sessions()[0].agent, 'sam');
  await gate.require('sam', 'act', PC1, { as: 'user' });   // covered: no second notice
  assert.strictEqual(toasts.length, 1);
});

test('gate: default is asking; an agent not in the list is asked, and needs a call id', async () => {
  const { gate, asked, toasts } = newGate({ noAskAgents: undefined });
  await rejects(gate.require('sam', 'act', PC1), 'EIDENT');
  await gate.require('sam', 'act', PC1, { call: 'c1' });
  assert.strictEqual(asked.length, 1);
  assert.strictEqual(asked[0].call, 'c1');
  assert.strictEqual(toasts.length, 1);
  const g2 = newGate({ noAskAgents: ['pat'] });   // sam is not listed
  await g2.gate.require('sam', 'act', PC1, { call: 'c2' });
  assert.strictEqual(g2.asked.length, 1);
  for (const junk of ['sam:act', ' ', '', 'a b', null, 5, {}]) {
    const g3 = newGate({ noAskAgents: [junk] });
    await g3.gate.require('sam', 'act', PC1, { call: 'c3' });
    assert.strictEqual(g3.asked.length, 1, String(junk));
  }
  const g4 = newGate({ noAskAgents: 'sam' });   // not a list
  await g4.gate.require('sam', 'act', PC1, { call: 'c4' });
  assert.strictEqual(g4.asked.length, 1);
});

test('gate: no level escalation; look and unlisted agents stay denied', async () => {
  const { gate, asked, toasts } = newGate({ noAskAgents: ['sam', 'lee', 'ghost'] });
  const e = await rejects(gate.require('sam', 'drive', PC1), 'ELEVEL');   // sam is act
  assert.match(e.message, /this needs drive/);
  await rejects(gate.require('lee', 'act', PC1), 'ELEVEL');
  await rejects(gate.require('ghost', 'act', PC1), 'ELEVEL');          // in no_ask_agents but not in levels: look
  await rejects(gate.require('stranger', 'act', PC1), 'ELEVEL');
  await rejects(gate.require('', 'act', PC1), 'EIDENT');
  await gate.require('lee', 'look', PC1);
  assert.strictEqual(asked.length + toasts.length, 0);
  assert.strictEqual(gate.sessions().length, 0);
  assert.strictEqual(gate.stillValid('lee', 'pc1', 'act'), false);
});

test('gate: sessions are per agent, per computer and per scope (act-user, act-system, drive)', async () => {
  const { gate, toasts, logs } = newGate();
  await gate.require('pat', 'act', PC1, { as: 'user' });
  assert.strictEqual(gate.stillValid('pat', 'pc1', 'act', 'user'), true);
  assert.strictEqual(gate.stillValid('pat', 'pc1', 'act', 'system'), false, 'a user run does not cover a system run');
  assert.strictEqual(gate.stillValid('pat', 'pc1', 'drive'), false);
  assert.strictEqual(gate.stillValid('pat', 'pc2', 'act', 'user'), false, 'another computer');
  assert.strictEqual(gate.stillValid('sam', 'pc1', 'act', 'user'), false, 'another agent');
  assert.strictEqual(toasts.length, 1);
  await gate.require('pat', 'act', PC1, { as: 'system' });   // a new scope: a new session start and notice
  assert.strictEqual(toasts.length, 2);
  assert.strictEqual(gate.stillValid('pat', 'pc1', 'act', 'system'), true);
  assert.strictEqual(gate.stillValid('pat', 'pc1', 'drive'), false, 'system does not cover drive');
  await gate.require('pat', 'drive', PC1);
  assert.strictEqual(gate.stillValid('pat', 'pc1', 'drive'), true);
  await gate.require('pat', 'act', PC2, { as: 'user' });
  await gate.require('sam', 'act', PC1);
  assert.strictEqual(gate.sessions().length, 3);
  assert.strictEqual(logs.filter((l) => /without asking/.test(l)).length, 5);
  assert.strictEqual(gate.end('pat', 'pc1'), true);
  assert.strictEqual(gate.stillValid('pat', 'pc1', 'act', 'user'), false, 'ended: not valid');
  assert.strictEqual(gate.stillValid('pat', 'pc2', 'act', 'user'), true, 'the other computer is untouched');
  const before = toasts.length;
  await gate.require('pat', 'act', PC1, { as: 'user' });   // a new session starts, with a new notice
  assert.strictEqual(toasts.length, before + 1);
});

test('gate: an expired no-ask session is not valid and the next request starts a new one with a new notice', async () => {
  const { gate, clock, toasts, logs, asked } = newGate();
  await gate.require('sam', 'act', PC1);
  const first = gate.sessions()[0].expiresAt;
  clock.advance(30 * 60000 - 1);
  assert.strictEqual(gate.stillValid('sam', 'pc1', 'act'), true);
  clock.advance(1);
  assert.strictEqual(gate.stillValid('sam', 'pc1', 'act'), false, 'finite: no unconditional pass');
  assert.deepStrictEqual(gate.sessions(), []);
  assert.strictEqual(gate.stillValid('sam', 'pc1', 'act'), false, 'checking never creates a session');
  assert.strictEqual(toasts.length, 1);
  await gate.require('sam', 'act', PC1);
  assert.strictEqual(toasts.length, 2);
  assert.strictEqual(asked.length, 0);
  assert.ok(gate.sessions()[0].expiresAt > first);
  assert.strictEqual(logs.filter((l) => /without asking/.test(l)).length, 2);
});

test('gate: concurrent requests of a no-ask agent share one session start and one notice', async () => {
  let release;
  const hold = new Promise((r) => { release = r; });
  const sent = [];
  const { gate, logs } = newGate({ toast: async (id) => { await hold; sent.push(id); } });
  const rs = [gate.require('sam', 'act', PC1), gate.require('sam', 'act', PC1), gate.require('sam', 'act', PC1)];
  await flush();
  release();
  await Promise.all(rs);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(logs.filter((l) => /without asking/.test(l)).length, 1);
});

test('gate: a failing notice is logged, not fatal', async () => {
  const { gate, logs } = newGate({ toast: async () => { throw new Error('offline'); } });
  await gate.require('sam', 'act', PC1);
  assert.ok(logs.some((l) => /toast failed/.test(l)));
  assert.strictEqual(gate.stillValid('sam', 'pc1', 'act'), true);
});

test('gate: an asked agent in the same gate is still asked, and a no keeps its cool-down', async () => {
  const answers = ['deny'];
  const { gate, asked } = newGate({ noAskAgents: ['sam'], approve: async (q) => { asked.push(q); return answers.shift() || 'allow'; } });
  await rejects(gate.require('owner', 'act', PC1, { call: 'c1' }), 'EDENIED');
  await rejects(gate.require('owner', 'act', PC1, { call: 'c2' }), 'EDENIED');
  assert.strictEqual(asked.length, 1);
  await gate.require('sam', 'act', PC1);   // sam is unaffected
  assert.strictEqual(asked.length, 1);
});

// ── the real tools with a stand-in transport ──────────────────────────────────────────────────
const ID_A = 'Abcdefghijkl0123456789', ID_C = 'Cdefghijklmn1111111111';
const NODES = { 'mesh//g1': [
  { _id: `node//${ID_A}`, name: 'demo-pc', osdesc: 'Windows 11 Pro', conn: 1, agct: 1783000000000, ip: '::ffff:192.0.2.20' },
  { _id: `node//${ID_C}`, name: 'second-pc', osdesc: 'Windows 10', conn: 1, agct: 1783000000000 },
] };
function setup(settings = {}) {
  const time = { t: new Date(2026, 10, 7, 9, 5, 3).getTime() };
  const calls = [], lines = [], logs = [];
  const client = { request: async (action, fields) => {
    calls.push({ action, fields });
    if (action === 'nodes') return { action: 'nodes', nodes: NODES };
    if (action === 'toast') return { action: 'toast', result: 'ok' };
    if (action === 'runcommands') return { result: 'C:\\>\r\nok\r\nC:\\>exit\r\n' };
    throw new MeshError('Unexpected action in the test.', 'EMESH');
  } };
  const remote = createRemote({
    env: { MODULE_SETTINGS: JSON.stringify({ levels: ['sam:act', 'pat:act', 'dee:drive'], no_ask_agents: ['sam', 'dee'], session_minutes: 30, ...settings }), CONNECTOR_DATA_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'rc-noask-')) },
    write: (l) => lines.push(l), log: (...a) => logs.push(a.join(' ')),
    deps: { agentClient: client, group: 'mesh//g1', now: () => time.t },
  });
  let n = 0;
  const call = async (name, args) => {
    const r = (await remote.handle({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } })).result;
    return r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text);
  };
  const asks = () => lines.map((l) => JSON.parse(l)).filter((m) => m.method === 'hub/approve');
  return { remote, calls, logs, time, call, asks };
}

test('tools: a no-ask agent runs a command with no question, the computer gets the notice, the command is logged', async () => {
  const t = setup();
  const r = await t.call('run', { __agent: 'sam', __call: 'call-1', computer: 'demo-pc', command: 'whoami' });
  assert.strictEqual(r.output, 'ok');
  assert.strictEqual(t.asks().length, 0, 'the owner was not asked');
  const toasts = t.calls.filter((c) => c.action === 'toast');
  assert.strictEqual(toasts.length, 1);
  assert.deepStrictEqual(toasts[0].fields, { nodeids: [`node//${ID_A}`], title: 'My Maestro', msg: 'sam is using this computer for the next 30 minutes.' });
  assert.ok(t.logs.some((l) => /without asking the owner \(no-ask agent\): sam, act-system/.test(l)));
  await t.call('run', { __agent: 'sam', __call: 'call-2', computer: 'demo-pc', command: 'hostname' });
  assert.strictEqual(t.logs.filter((l) => /^run on demo-pc for sam /.test(l)).length, 2, 'every command is still logged');
  assert.strictEqual(t.calls.filter((c) => c.action === 'toast').length, 1, 'the session covers the second command');
  assert.strictEqual(t.asks().length, 0);
});

test('tools: an agent not in no_ask_agents is asked, and nothing runs before the yes', async () => {
  const t = setup();
  const p = t.call('run', { __agent: 'pat', __call: 'call-9', computer: 'demo-pc', command: 'whoami' });
  await flush();
  const asks = t.asks();
  assert.strictEqual(asks.length, 1);
  assert.strictEqual(asks[0].params.call, 'call-9');
  assert.ok(!t.calls.some((c) => c.action === 'runcommands'));
  t.remote.onLine(JSON.stringify({ jsonrpc: '2.0', id: asks[0].id, result: { decision: 'allow' } }));
  assert.strictEqual((await p).output, 'ok');
  assert.ok(!t.logs.some((l) => /without asking/.test(l)));
});

test('tools: no-ask does not raise the level, and tool arguments cannot switch it on', async () => {
  const t = setup();
  const drive = await t.call('key', { __agent: 'sam', __call: 'c1', computer: 'demo-pc', keys: 'a' });   // sam is act
  assert.match(drive.error, /Remote computers -> Settings/);
  const forged = { no_ask_agents: ['pat'], noAskAgents: ['pat'], noAsk: true, __noAsk: true, __no_ask: true, sessionApproval: true, approved: true, levels: ['pat:drive'], settings: { no_ask_agents: ['pat'] } };
  const p = t.call('run', { __agent: 'pat', __call: 'call-7', computer: 'demo-pc', command: 'whoami', ...forged });
  await flush();
  assert.strictEqual(t.asks().length, 1, 'pat is still asked');
  assert.ok(!t.calls.some((c) => c.action === 'runcommands'));
  const stranger = await t.call('run', { __agent: 'stranger', __call: 'c3', computer: 'demo-pc', command: 'x', ...forged });
  assert.match(stranger.error, /may only look/);
  const noAgent = await t.call('run', { __call: 'c4', computer: 'demo-pc', command: 'x', ...forged });
  assert.match(noAgent.error, /did not say which agent/);
  t.remote.onLine(JSON.stringify({ jsonrpc: '2.0', id: t.asks()[0].id, result: { decision: 'deny' } }));
  assert.match((await p).error, /said no/);
});

test('tools: no-ask sessions are per computer and per agent; expiry needs a new notice', async () => {
  const t = setup();
  const run = (who, pc, extra = {}) => t.call('run', { __agent: who, __call: 'c', computer: pc, command: 'x', ...extra });
  assert.strictEqual((await run('sam', 'demo-pc')).output, 'ok');
  assert.strictEqual((await run('sam', 'second-pc')).output, 'ok');
  assert.strictEqual(t.calls.filter((c) => c.action === 'toast').length, 2, 'each computer gets its own notice');
  assert.strictEqual((await run('dee', 'demo-pc')).output, 'ok');
  assert.strictEqual(t.calls.filter((c) => c.action === 'toast').length, 3, 'another agent has its own session');
  assert.strictEqual(t.asks().length, 0);
  t.time.t += 31 * 60000;
  assert.strictEqual((await run('sam', 'demo-pc')).output, 'ok');
  assert.strictEqual(t.calls.filter((c) => c.action === 'toast').length, 4, 'a new session after expiry gets a new notice');
  assert.strictEqual(t.asks().length, 0);
});
