'use strict';
// Remote computers, the per-computer approval policy: how often an agent's act/drive on a computer needs the owner's yes.
// '<computer>:day' = one approval lasts until the end of the owner's day; '<computer>:trust:<agent>' = that agent is not asked on that computer.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGate } = require('../modules/remote-computers/lib/gate');
const { MeshError } = require('../modules/remote-computers/lib/meshclient');
const { createRemote } = require('../modules/remote-computers/server');

const HOUR = 3600000, MIN = 60000;
const PC1 = { id: 'pc1', name: 'demo-pc' }, PC2 = { id: 'pc2', name: 'other-pc' };
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const rejects = async (p, code) => {
  try { await p; } catch (e) { assert.strictEqual(e.code, code, e.message); return e; }
  assert.fail('should have been refused');
  return null;
};

function newGate(over = {}) {
  let t = 9000000;
  const clock = { now: () => t, advance: (ms) => { t += ms; }, get t() { return t; } };
  const asked = [], toasts = [], logs = [];
  const answers = over.answers || [];
  const gate = createGate({
    levels: ['sam:act', 'pat:drive', 'lee:look', 'kim:drive'], sessionMinutes: 30, now: clock.now,
    log: (...a) => logs.push(a.join(' ')),
    approve: async (q) => { asked.push(q); const a = answers.length ? answers.shift() : 'allow'; return typeof a === 'function' ? a(clock) : a; },
    toast: async (id, title, msg) => { toasts.push({ id, title, msg }); },
    ...over,
  });
  return { gate, clock, asked, toasts, logs };
}
const sessionEnd = (gate) => gate.sessions()[0].expiresAt;

test('default (empty policy): asks every session, lasts sessionMinutes, basis asked, same texts as before', async () => {
  const { gate, clock, asked, toasts } = newGate({ approvalPolicy: [] });
  assert.strictEqual(await gate.require('sam', 'act', PC1, { call: 'c1' }), 'asked');
  assert.strictEqual(asked.length, 1);
  assert.strictEqual(asked[0].detail, 'For 30 minutes sam may run commands as the system account (full control) on demo-pc (pc1). Every action is logged. Say no if you did not expect this.');
  assert.deepStrictEqual(toasts, [{ id: 'pc1', title: 'My Maestro', msg: 'sam is using this computer for the next 30 minutes.' }]);
  assert.strictEqual(sessionEnd(gate), clock.t + 30 * MIN);
  assert.strictEqual(await gate.require('sam', 'act', PC1, { call: 'c2' }), 'asked', 'a covered need returns the covering basis');
  assert.strictEqual(asked.length, 1);
  clock.advance(31 * MIN);
  await gate.require('sam', 'act', PC1, { call: 'c3' });
  assert.strictEqual(asked.length, 2, 'asked again after the session ended');
  assert.strictEqual(gate.allowedBy('sam', 'pc1', 'act'), 'asked');
});

test('day computer: one approval lasts until dayEnds; no second question before it, a new one after it', async () => {
  const { gate, clock, asked, toasts } = newGate({ approvalPolicy: ['pc1:day'], answers: [(c) => ({ decision: 'allow', dayEnds: c.t + 5 * HOUR })] });
  const start = clock.t;
  assert.strictEqual(await gate.require('sam', 'act', PC1, { call: 'c1' }), 'asked-day');
  assert.strictEqual(sessionEnd(gate), start + 5 * HOUR);
  assert.strictEqual(asked[0].detail, 'For the rest of today sam may run commands as the system account (full control) on demo-pc (pc1). Every action is logged. Say no if you did not expect this.');
  assert.deepStrictEqual(toasts, [{ id: 'pc1', title: 'My Maestro', msg: 'sam is using this computer until midnight.' }]);
  clock.advance(4 * HOUR);   // far longer than sessionMinutes
  assert.strictEqual(await gate.require('sam', 'act', PC1, { call: 'c2' }), 'asked-day');
  assert.strictEqual(asked.length, 1, 'no second question during the day');
  assert.strictEqual(gate.stillValid('sam', 'pc1', 'act'), true);
  assert.strictEqual(gate.allowedBy('sam', 'pc1', 'act'), 'asked-day');
  clock.advance(HOUR + 1);
  assert.strictEqual(gate.stillValid('sam', 'pc1', 'act'), false);
  assert.strictEqual(gate.allowedBy('sam', 'pc1', 'act'), null);
  await gate.require('sam', 'act', PC1, { call: 'c3' });
  assert.strictEqual(asked.length, 2, 'asked again after dayEnds');
});

test('day computer: a missing, past or too far dayEnds falls back to sessionMinutes and basis asked (one log line); strings still work', async () => {
  const bad = [undefined, null, NaN, Infinity, '12345', 'soon', 0, (c) => c.t - 1, (c) => c.t, (c) => c.t + 25 * HOUR + 1, (c) => c.t + 100 * HOUR];
  for (const dayEnds of bad) {
    const { gate, clock, logs, toasts } = newGate({ approvalPolicy: ['pc1:day'], answers: [(c) => ({ decision: 'allow', dayEnds: typeof dayEnds === 'function' ? dayEnds(c) : dayEnds })] });
    assert.strictEqual(await gate.require('sam', 'act', PC1, { call: 'c1' }), 'asked', String(dayEnds));
    assert.strictEqual(sessionEnd(gate), clock.t + 30 * MIN, String(dayEnds));
    assert.strictEqual(logs.length, 1, `one log line: ${logs.join('|')}`);
    assert.match(toasts[0].msg, /for the next 30 minutes/);
  }
  // exactly 25 h is still allowed
  const edge = newGate({ approvalPolicy: ['pc1:day'], answers: [(c) => ({ decision: 'allow', dayEnds: c.t + 25 * HOUR })] });
  assert.strictEqual(await edge.gate.require('sam', 'act', PC1, { call: 'c1' }), 'asked-day');
  // a string answer on a day computer, and an object answer on an every-session computer
  const str = newGate({ approvalPolicy: ['pc1:day'], answers: ['allow'] });
  assert.strictEqual(await str.gate.require('sam', 'act', PC1, { call: 'c1' }), 'asked');
  assert.strictEqual(sessionEnd(str.gate), str.clock.t + 30 * MIN);
  const other = newGate({ approvalPolicy: ['pc1:day'], answers: [(c) => ({ decision: 'allow', dayEnds: c.t + 5 * HOUR })] });
  assert.strictEqual(await other.gate.require('sam', 'act', PC2, { call: 'c1' }), 'asked', 'pc2 is not a day computer');
  assert.strictEqual(sessionEnd(other.gate), other.clock.t + 30 * MIN);
  assert.match(other.asked[0].detail, /^For 30 minutes sam may/);
  // deny and timeout still work as strings and as objects
  const d = newGate({ approvalPolicy: ['pc1:day'], answers: ['deny', { decision: 'timeout' }] });
  await rejects(d.gate.require('sam', 'act', PC1, { call: 'c1' }), 'EDENIED');
  d.clock.advance(3 * MIN);
  await rejects(d.gate.require('sam', 'act', PC1, { call: 'c2' }), 'ETIMEOUT');
  const junk = newGate({ approvalPolicy: ['pc1:day'], answers: [{ decision: 'maybe' }] });
  await rejects(junk.gate.require('sam', 'act', PC1, { call: 'c1' }), 'EAPPROVE');
});

test('trusted on this computer: never asked there, asked elsewhere, toast and log, basis trusted-here', async () => {
  const { gate, asked, toasts, logs, clock } = newGate({ approvalPolicy: ['pc1:trust:sam'] });
  assert.strictEqual(await gate.require('sam', 'act', PC1), 'trusted-here', 'no call id needed: nobody is asked');
  assert.strictEqual(asked.length, 0);
  assert.deepStrictEqual(toasts, [{ id: 'pc1', title: 'My Maestro', msg: 'sam is using this computer for the next 30 minutes.' }]);
  assert.ok(logs.some((l) => /without asking the owner \(trusted on this computer\): sam, act-system, computer pc1/.test(l)), logs.join('|'));
  assert.strictEqual(sessionEnd(gate), clock.t + 30 * MIN);
  assert.strictEqual(gate.allowedBy('sam', 'pc1', 'act'), 'trusted-here');
  await rejects(gate.require('sam', 'act', PC2), 'EIDENT');   // another computer: asked, so a call id is needed
  assert.strictEqual(await gate.require('sam', 'act', PC2, { call: 'c1' }), 'asked');
  assert.strictEqual(asked.length, 1);
  // another agent on the trusted computer is asked
  assert.strictEqual(await gate.require('pat', 'drive', PC1, { call: 'c2' }), 'asked');
  assert.strictEqual(asked.length, 2);
});

test('trusted on this computer: the level check still applies first; the owner earlier no does not stop a trusted agent', async () => {
  const { gate, asked } = newGate({ approvalPolicy: ['pc1:trust:lee', 'pc1:trust:sam'] });
  await rejects(gate.require('lee', 'act', PC1), 'ELEVEL');
  await rejects(gate.require('sam', 'drive', PC1), 'ELEVEL');   // sam is act
  await rejects(gate.require('ghost', 'act', PC1), 'ELEVEL');   // not in levels: look
  assert.strictEqual(await gate.require('lee', 'look', PC1), 'look');
  assert.strictEqual(asked.length, 0);
  assert.strictEqual(await gate.require('sam', 'act', PC1), 'trusted-here');
});

test('global no-ask agents keep basis trusted, and trusted wins when both apply', async () => {
  const a = newGate({ noAskAgents: ['sam'] });
  assert.strictEqual(await a.gate.require('sam', 'act', PC1), 'trusted');
  assert.strictEqual(a.gate.allowedBy('sam', 'pc1', 'act'), 'trusted');
  assert.ok(a.logs.some((l) => /\(no-ask agent\)/.test(l)));
  const b = newGate({ noAskAgents: ['sam'], approvalPolicy: ['pc1:trust:sam', 'pc1:day'] });
  assert.strictEqual(await b.gate.require('sam', 'act', PC1), 'trusted');
  assert.strictEqual(b.asked.length, 0);
  assert.match(b.toasts[0].msg, /for the next 30 minutes/, 'a quiet session on a day computer keeps the ordinary toast');
});

test('malformed policy entries are ignored', async () => {
  const junk = ['pc1', 'pc1:', 'pc1:days', 'pc1:trust', 'pc1:trust:', 'pc1:trust:a:b', 'pc1:trust:sam x', ':day', 'pc 1:day', 'pc1:day:extra', 'pc1:DAY', 42, null, undefined, {}, ['pc1:day'], `${'x'.repeat(101)}:day`, 'pc1:trust:' + 'a'.repeat(65)];
  const { gate, asked, clock } = newGate({ approvalPolicy: junk, answers: [(c) => ({ decision: 'allow', dayEnds: c.t + 5 * HOUR })] });
  assert.strictEqual(await gate.require('sam', 'act', PC1, { call: 'c1' }), 'asked');
  assert.strictEqual(sessionEnd(gate), clock.t + 30 * MIN, 'not a day computer');
  assert.strictEqual(asked.length, 1);
  assert.strictEqual(await gate.require('pat', 'drive', PC1, { call: 'c2' }), 'asked');
  assert.strictEqual(newGate({ approvalPolicy: 'pc1:trust:sam' }).gate.levelOf('sam'), 'act', 'a string is not a list');
  const notList = newGate({ approvalPolicy: 'pc1:trust:sam' });
  await rejects(notList.gate.require('sam', 'act', PC1), 'EIDENT');
  // valid entries next to junk still count; ids may carry @ and $
  const mixed = newGate({ approvalPolicy: ['bad', 'a@b$c_d-1:trust:sam'] });
  assert.strictEqual(await mixed.gate.require('sam', 'act', { id: 'a@b$c_d-1', name: 'x' }), 'trusted-here');
});

test('scope rules are unchanged under day mode', async () => {
  const day = (c) => ({ decision: 'allow', dayEnds: c.t + 5 * HOUR });
  const { gate, asked } = newGate({ approvalPolicy: ['pc1:day'], answers: [day, day, day], levels: ['kim:drive'] });
  assert.strictEqual(await gate.require('kim', 'drive', PC1, { call: 'c1' }), 'asked-day');
  assert.strictEqual(await gate.require('kim', 'act', PC1, { call: 'c2', as: 'user' }), 'asked-day', 'drive covers a user run');
  assert.strictEqual(asked.length, 1);
  assert.strictEqual(gate.allowedBy('kim', 'pc1', 'act', 'system'), null, 'a drive approval does not cover act-system');
  assert.strictEqual(gate.stillValid('kim', 'pc1', 'act', 'system'), false);
  assert.strictEqual(await gate.require('kim', 'act', PC1, { call: 'c3' }), 'asked-day');
  assert.strictEqual(asked.length, 2, 'asked again for the system run');
  assert.match(asked[1].detail, /^For the rest of today kim may run commands as the system account/);
  assert.strictEqual(await gate.require('kim', 'drive', PC1, { call: 'c4' }), 'asked-day');
  assert.strictEqual(asked.length, 2);
  assert.strictEqual(gate.allowedBy('kim', 'pc1', 'look'), 'look');
  assert.strictEqual(gate.allowedBy('', 'pc1', 'act'), null);
  assert.strictEqual(gate.allowedBy('nobody', 'pc1', 'act'), null);
  assert.strictEqual(gate.allowedBy('kim', 'pc2', 'act'), null);
});

test('a shared pending question returns the basis the question set; the deny cool-down is unchanged', async () => {
  let release;
  const gateP = new Promise((r) => { release = r; });
  const { gate, asked, clock } = newGate({ approvalPolicy: ['pc1:day'], answers: [async (c) => { await gateP; return { decision: 'allow', dayEnds: c.t + 2 * HOUR }; }] });
  const p1 = gate.require('sam', 'act', PC1, { call: 'c1' });
  const p2 = gate.require('sam', 'act', PC1, { call: 'c2' });
  await flush();
  release();
  assert.deepStrictEqual(await Promise.all([p1, p2]), ['asked-day', 'asked-day']);
  assert.strictEqual(asked.length, 1);
  const d = newGate({ answers: ['deny'] });
  await rejects(d.gate.require('sam', 'act', PC1, { call: 'c1' }), 'EDENIED');
  d.clock.advance(MIN);
  await rejects(d.gate.require('sam', 'act', PC1, { call: 'c2' }), 'EDENIED');
  assert.strictEqual(d.asked.length, 1, 'cool-down: not asked again');
  assert.ok(clock.t > 0);
});

test('manifest: approval_policy setting and the policy field of levels.sessionApproval', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '../modules/remote-computers/module.json'), 'utf8'));
  const keys = m.settings.map((s) => s.key);
  assert.strictEqual(keys.indexOf('approval_policy'), keys.indexOf('no_ask_agents') + 1);
  const s = m.settings.find((x) => x.key === 'approval_policy');
  assert.deepStrictEqual([s.type, s.label, s.default], ['list', 'How often each computer asks', []]);
  const re = new RegExp(s.pattern);
  for (const ok of ['pc1:day', 'Abcdefghijkl:trust:sam', 'a@b$c_d-1:trust:helper_2']) assert.ok(re.test(ok), ok);
  for (const bad of ['pc1', 'pc1:days', 'pc1:trust:Sam', 'pc1:trust:', ':day', 'pc 1:day', 'pc1:trust:sam:x']) assert.ok(!re.test(bad), bad);
  assert.strictEqual(m.levels.sessionApproval.policy, 'approval_policy');
  assert.strictEqual(m.levels.sessionApproval.setting, 'no_ask_agents');
});

// ── the real tools with a stand-in transport ──────────────────────────────────────────────────
const ID_A = 'Abcdefghijkl0123456789', ID_C = 'Cdefghijklmn1111111111';
const SHORT_A = ID_A;   // the gate's computer id is the full node id (without the node// prefix); the policy names it the same way
const NODES = { 'mesh//g1': [
  { _id: `node//${ID_A}`, name: 'demo-pc', osdesc: 'Windows 11 Pro', conn: 1, agct: 1783000000000, ip: '::ffff:192.0.2.20' },
  { _id: `node//${ID_C}`, name: 'second-pc', osdesc: 'Windows 10', conn: 1, agct: 1783000000000 },
] };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('a picture')]);

function setup(settings = {}) {
  const time = { t: new Date(2026, 10, 7, 9, 5, 3).getTime() };
  const calls = [], lines = [], logs = [];
  const client = { request: async (action, fields) => {
    calls.push({ action, fields });
    if (action === 'nodes') return { action: 'nodes', nodes: NODES };
    if (action === 'toast') return { action: 'toast', result: 'ok' };
    if (action === 'getsysinfo') return { action, nodeinfo: { name: 'demo-pc' } };
    if (action === 'runcommands') {
      if (time.failRun) throw new MeshError('The server refused.', 'EMESH');
      const cmds = Buffer.from(String(fields.cmds || ''), 'utf8').toString('utf8');
      if (/MMSHOT/.test(cmds) || /-EncodedCommand/i.test(cmds)) return { result: 'MMOK\r\n' };
      return { result: 'C:\\>\r\nok\r\nC:\\>exit\r\n' };
    }
    throw new MeshError('Unexpected action in the test.', 'EMESH');
  } };
  const person = {
    request: async (action) => ({ action, result: 'OK' }),
    exchange: async () => ({ action: 'authcookie', cookie: 'CooKie$1@x', rcookie: 'rCooKie$2@y' }),
  };
  let acct = null;
  const store = { read: () => acct, write: (pass) => { acct = { user: 'person', pass }; }, get: () => acct };
  const admin = { request: async (action) => (action === 'addmeshuser' ? { action, result: 'Added user person', success: 1, failed: 0 } : { action, result: 'ok' }), close() {} };
  const remote = createRemote({
    env: { MODULE_SETTINGS: JSON.stringify({ levels: ['sam:act', 'pat:drive'], session_minutes: 30, ...settings }), CONNECTOR_DATA_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'rc-policy-')) },
    write: (l) => lines.push(l), log: (...a) => logs.push(a.join(' ')),
    deps: { agentClient: client, group: 'mesh//g1', now: () => time.t, adminClient: admin, personClient: person, personStore: store, endpoint: () => ({ port: 9971, servername: 'hub.example.ts.net', ca: 'CA-PEM' }) },
  });
  let n = 0;
  const raw = async (name, args) => (await remote.handle({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } })).result;
  const asks = () => lines.map((l) => JSON.parse(l)).filter((m) => m.method === 'hub/approve');
  const answer = (id, result) => remote.onLine(JSON.stringify({ jsonrpc: '2.0', id, result }));
  return { remote, calls, logs, time, raw, asks, answer };
}
const body = (r) => JSON.parse(r.content[0].text);

test('tools: run and key results carry _meta allowedBy with the basis that allowed them; a refusal carries none', async () => {
  const t = setup({ approval_policy: [`${SHORT_A}:trust:sam`] });
  const r = await t.raw('run', { __agent: 'sam', __call: 'c1', computer: 'demo-pc', command: 'whoami' });
  assert.strictEqual(body(r).output, 'ok');
  assert.deepStrictEqual(r._meta, { 'mymaestro/allowedBy': 'trusted-here' });
  assert.strictEqual(t.asks().length, 0);
  // another computer: asked; the answer carries a day end
  const p = t.raw('run', { __agent: 'sam', __call: 'c2', computer: 'second-pc', command: 'whoami' });
  await flush();
  assert.strictEqual(t.asks().length, 1);
  t.answer(t.asks()[0].id, { decision: 'allow' });
  assert.deepStrictEqual((await p)._meta, { 'mymaestro/allowedBy': 'asked' });
  // a call that passed the gate but failed afterwards still says what allowed it
  t.time.failRun = true;
  const failed = await t.raw('run', { __agent: 'sam', __call: 'c2b', computer: 'demo-pc', command: 'whoami' });
  assert.strictEqual(failed.isError, true);
  assert.deepStrictEqual(failed._meta, { 'mymaestro/allowedBy': 'trusted-here' });
  t.time.failRun = false;
  // a call the gate refuses carries no _meta
  const bad = await t.raw('run', { __agent: 'stranger', __call: 'c3', computer: 'demo-pc', command: 'x' });
  assert.strictEqual(bad.isError, true);
  assert.strictEqual('_meta' in bad, false);
  const lvl = await t.raw('key', { __agent: 'sam', __call: 'c4', computer: 'demo-pc', keys: 'a' });   // sam is act
  assert.strictEqual(lvl.isError, true);
  assert.strictEqual('_meta' in lvl, false);
});

test('tools: a day computer takes dayEnds from the hub answer, shows the day question, and a drive call carries asked-day (also when it fails)', async () => {
  const t = setup({ approval_policy: [`${SHORT_A}:day`], session_minutes: 30 });
  const p = t.raw('key', { __agent: 'pat', __call: 'k1', computer: 'demo-pc', keys: 'a' });
  await flush();
  const ask = t.asks()[0];
  assert.match(ask.params.detail, /^For the rest of today pat may use the mouse and keyboard on demo-pc \(Abcdef\)\. Every action is logged\./);
  t.answer(ask.id, { decision: 'allow', dayEnds: t.time.t + 5 * 3600000 });
  const r = await p;
  assert.deepStrictEqual(r._meta, { 'mymaestro/allowedBy': 'asked-day' });
  assert.ok(t.calls.some((c) => c.action === 'toast' && c.fields.msg === 'pat is using this computer until midnight.'));
  t.time.t += 4 * 3600000;   // long after 30 minutes, still the same day
  const r2 = await t.raw('scroll', { __agent: 'pat', __call: 'k2', computer: 'demo-pc', amount: 2 });
  assert.deepStrictEqual(r2._meta, { 'mymaestro/allowedBy': 'asked-day' });
  assert.strictEqual(t.asks().length, 1, 'no second question');
});

test('tools: look tools carry no _meta', async () => {
  const t = setup({ approval_policy: [`${SHORT_A}:trust:sam`] });
  const c = await t.raw('computers', { __agent: 'sam', __call: 'c1' });
  assert.strictEqual('_meta' in c, false);
  const i = await t.raw('info', { __agent: 'sam', __call: 'c2', computer: 'demo-pc' });
  assert.strictEqual('_meta' in i, false);
  await t.raw('run', { __agent: 'sam', __call: 'c3', computer: 'demo-pc', command: 'whoami' });   // now sam has a live session
  const s = await t.raw('screenshot', { __agent: 'sam', __call: 'c4', computer: 'demo-pc' });
  assert.strictEqual('_meta' in s, false, 'a screenshot is a look tool even when the agent has an act session');
});

test('tools: Open desktop still blocks input for a trusted-here agent, with no _meta', async () => {
  const t = setup({ approval_policy: [`${SHORT_A}:trust:sam`] });
  const ok = await t.raw('run', { __agent: 'sam', __call: 'c1', computer: 'demo-pc', command: 'whoami' });
  assert.deepStrictEqual(ok._meta, { 'mymaestro/allowedBy': 'trusted-here' });
  const o = await t.raw('desktop_open', { nodeid: `node//${ID_A}`, who: { id: 'user-1', name: 'Sam' } });
  assert.notStrictEqual(o.isError, true, o.content[0].text);
  const r = await t.raw('run', { __agent: 'sam', __call: 'c2', computer: 'demo-pc', command: 'whoami' });
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /^A person is using this computer's desktop until /);
  assert.strictEqual('_meta' in r, false);
});
