'use strict';
// Remote computers, the open desktop (module side): the person's account, the sessions, the tunnel, and the agents' input tools while a person is at the screen.
// Nothing here talks to MeshCentral: clients are stand-ins and the sockets are fakes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createMeshClient, MeshError } = require('../modules/remote-computers/lib/meshclient');
const { createMeshServer } = require('../modules/remote-computers/lib/meshserver');
const { ensurePerson, PERSON_RIGHTS, AGENT_RIGHTS } = require('../modules/remote-computers/lib/setupgroup');
const { createDesktop } = require('../modules/remote-computers/lib/desktop');
const { createRemote, TOOLS } = require('../modules/remote-computers/server');

const DIR = path.join(__dirname, '..', 'modules', 'remote-computers');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rc-desk-'));
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const manifest = () => JSON.parse(fs.readFileSync(path.join(DIR, 'module.json'), 'utf8'));
const mode = (f) => fs.statSync(f).mode & 0o777;

// ── the fake socket for the real client ──
class FakeWebSocket extends EventEmitter {
  constructor(url, opts) { super(); this.url = url; this.opts = opts; this.sent = []; this.closed = false; FakeWebSocket.instances.push(this); }
  send(data) { if (this.closed) throw new Error('closed'); this.sent.push(JSON.parse(data)); this.emit('sent', this.sent[this.sent.length - 1]); }
  close() { if (this.closed) return; this.closed = true; setImmediate(() => this.emit('close', 1000)); }
  terminate() { this.close(); }
  deliver(frame) { this.emit('message', Buffer.from(JSON.stringify(frame)), false); }
}
FakeWebSocket.instances = [];
async function loggedIn(over = {}) {
  FakeWebSocket.instances = [];
  const c = createMeshClient({ url: 'wss://127.0.0.1:9971/control.ashx', ca: 'CA', servername: 'hub.example.ts.net', user: 'person', pass: 'pw', WebSocket: FakeWebSocket, ...over });
  const r = c.ready();
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  ws.deliver({ action: 'userinfo', userinfo: { name: 'person' } });
  await r;
  return { c, ws };
}

// ── the client: waiting for a reply that has no responseid ──
test('client: exchange sends the frame without a responseid and resolves on the next frame of that action', async () => {
  const { c, ws } = await loggedIn();
  const p = c.exchange('authcookie', {}, { timeoutMs: 5000 });
  await flush();
  assert.deepStrictEqual(ws.sent, [{ action: 'authcookie' }], 'no responseid is sent');
  ws.deliver({ action: 'somethingelse', cookie: 'no' });
  ws.deliver({ action: 'authcookie', cookie: 'c1', rcookie: 'r1' });
  assert.deepStrictEqual(await p, { action: 'authcookie', cookie: 'c1', rcookie: 'r1' });
  c.close();
});

test('client: two waiters are answered in order, and a request in flight is still matched by its responseid', async () => {
  const { c, ws } = await loggedIn();
  const a = c.exchange('authcookie', {}, { timeoutMs: 5000 });
  const b = c.exchange('authcookie', {}, { timeoutMs: 5000 });
  const n = c.request('nodes', { meshid: 'mesh//g1' }, { timeoutMs: 5000 });
  await flush();
  const nodesReq = ws.sent.find((f) => f.action === 'nodes');
  ws.deliver({ action: 'authcookie', cookie: 'one', rcookie: 'r' });
  ws.deliver({ action: 'nodes', responseid: nodesReq.responseid, nodes: {} });
  ws.deliver({ action: 'authcookie', cookie: 'two', rcookie: 'r' });
  assert.strictEqual((await a).cookie, 'one');
  assert.strictEqual((await b).cookie, 'two');
  assert.deepStrictEqual((await n).nodes, {});
  c.close();
});

test('client: exchange times out (ETIMEDOUT) and fails when the connection closes', async () => {
  const { c, ws } = await loggedIn();
  await assert.rejects(c.exchange('authcookie', {}, { timeoutMs: 20 }), (e) => e instanceof MeshError && e.code === 'ETIMEDOUT');
  const p = c.exchange('authcookie', {}, { timeoutMs: 5000 });
  await flush();
  ws.close();
  await assert.rejects(p, (e) => e.code === 'ECLOSED');
  await assert.rejects(c.exchange('', {}), (e) => e.code === 'EBADARG');
});

// ── the person's account ──
const MESHID = 'mesh//g1';
function fakeAdmin(over = {}) {
  const calls = [];
  return {
    calls,
    request: async (action, fields, opts) => {
      calls.push({ action, fields, opts });
      if (over[action]) return over[action](fields, opts);
      if (action === 'adduser') return { action, result: 'ok' };
      if (action === 'addmeshuser') return { action, result: 'Added user person', success: 1, failed: 0 };
      throw new MeshError('unexpected', 'EMESH');
    },
    close() {},
  };
}
const memStore = (initial) => { let acct = initial || null; return { read: () => acct, write: (pass) => { acct = { user: 'person', pass }; }, get: () => acct }; };

test('person account: adduser, then addmeshuser with the desktop-only rights; the agent rights stay as they are', async () => {
  assert.strictEqual(PERSON_RIGHTS, 12584456);
  assert.strictEqual(PERSON_RIGHTS, 8 + 512 + 1024 + 4194304 + 8388608);
  assert.strictEqual(PERSON_RIGHTS & 256, 0, 'not view only');
  assert.strictEqual(PERSON_RIGHTS & 65536, 0, 'desktop allowed');
  assert.strictEqual(AGENT_RIGHTS, 1263104);
  const admin = fakeAdmin(), store = memStore();
  const r = await ensurePerson(admin, MESHID, store);
  assert.deepStrictEqual(admin.calls.map((c) => c.action), ['adduser', 'addmeshuser']);
  assert.strictEqual(admin.calls[0].fields.username, 'person');
  assert.ok(admin.calls[0].fields.pass.length >= 24);
  assert.strictEqual(admin.calls[0].fields.pass, store.get().pass);
  assert.strictEqual(r.pass, store.get().pass);
  assert.deepStrictEqual(admin.calls[1].fields, { meshid: MESHID, usernames: ['person'], meshadmin: 12584456 });
});

test('person account: an existing user gets its password set again with changeuserpass (no answer is fine); a stored password is kept', async () => {
  const admin = fakeAdmin({
    adduser: async () => { throw new MeshError('User already exists', 'EMESH'); },
    changeuserpass: async () => { throw new MeshError('changeuserpass timed out after 3 s.', 'ETIMEDOUT'); },
  });
  const store = memStore({ user: 'person', pass: 'stored-password-123' });
  await ensurePerson(admin, MESHID, store);
  assert.deepStrictEqual(admin.calls.map((c) => c.action), ['adduser', 'changeuserpass', 'addmeshuser']);
  assert.deepStrictEqual(admin.calls[1].fields, { userid: 'user//person', pass: 'stored-password-123', removeMultiFactor: false });
  assert.ok(admin.calls[1].opts.timeoutMs <= 5000, 'a short wait: there is no reply');
  assert.strictEqual(store.get().pass, 'stored-password-123');
  // another failure is not hidden
  const bad = fakeAdmin({ adduser: async () => { throw new MeshError('Invalid password', 'EMESH'); } });
  await assert.rejects(ensurePerson(bad, MESHID, memStore()), /Invalid password/);
  const noAdd = fakeAdmin({ addmeshuser: async () => ({ action: 'addmeshuser', success: 0 }) });
  await assert.rejects(ensurePerson(noAdd, MESHID, memStore()), /could not be added/);
});

test('person account: the password is kept in accounts.json beside admin and agent (0600, the other entries untouched)', () => {
  const home = tmp(), runtimeDir = tmp();
  const ms = createMeshServer({ runtimeDir, home, settings: {}, log() {} });
  const accountsFile = path.join(home, 'accounts.json');
  const original = { admin: { user: 'admin', pass: 'a-pass' }, agent: { user: 'maestro', pass: 'm-pass' }, createdAt: '2026-11-01T00:00:00.000Z' };
  fs.writeFileSync(accountsFile, JSON.stringify(original), { mode: 0o600 });
  assert.strictEqual(ms.personAccount(), null);
  ms.savePersonAccount('p-pass');
  assert.deepStrictEqual(ms.personAccount(), { user: 'person', pass: 'p-pass' });
  const after = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
  assert.deepStrictEqual({ admin: after.admin, agent: after.agent, createdAt: after.createdAt }, original);
  assert.strictEqual(mode(accountsFile), 0o600);
  assert.deepStrictEqual(ms.accounts().admin, original.admin);
});

// ── the module with stand-in clients ──
const ID_A = 'Abcdefghijkl0123456789', ID_B = 'Bcdefghijklm9876543210';
const NODES = {
  'mesh//g1': [
    { _id: `node//${ID_A}`, name: 'demo-pc', osdesc: 'Windows 11 Pro', conn: 1, agct: 1783000000000, agent: { id: 4, ver: 12 } },
    { _id: `node//${ID_B}`, name: 'Laptop', osdesc: 'Windows 10', conn: 0, lastconnect: 1782000000000, agent: { id: 4, ver: 11 } },
  ],
};
const NODE_A = `node//${ID_A}`;
const SAM = { id: 'user-1', name: 'Sam' };
const AGENT = { __agent: 'sam', __call: 'call-1' };
const START = new Date(2026, 10, 7, 9, 5, 3).getTime();

function setup(over = {}) {
  const home = 'home' in over ? over.home : tmp();
  const time = over.time || { t: START };
  const calls = [], gateCalls = [], logs = [];
  const handlers = { ...(over.handlers || {}) };
  const client = {
    request: async (action, fields, opts) => {
      calls.push({ action, fields, opts });
      if (handlers[action]) return handlers[action](fields, opts);
      if (action === 'nodes') return { action: 'nodes', nodes: NODES };
      if (action === 'toast') return { action: 'toast', result: 'ok' };
      throw new MeshError('Unexpected action in the test.', 'EMESH');
    },
  };
  const admin = over.admin || fakeAdmin();
  const personCalls = [];
  const person = over.person || {
    request: async (action, fields, opts) => { personCalls.push({ kind: 'request', action, fields, opts }); return { action, result: 'OK' }; },
    exchange: async (action, fields, opts) => { personCalls.push({ kind: 'exchange', action, fields, opts }); return { action: 'authcookie', cookie: 'CooKie$1@x', rcookie: 'rCooKie$2@y' }; },
  };
  const store = over.store || memStore();
  const gate = {
    require: async (agent, need, pc, opts) => { gateCalls.push({ agent, need, pc: pc && pc.name }); if (over.onGate) await over.onGate(need); },
    stillValid: () => true,
  };
  const remote = createRemote({
    env: { MODULE_SETTINGS: JSON.stringify({ levels: ['sam:drive'], session_minutes: 30, ...(over.settings || {}) }), CONNECTOR_DATA_HOME: home },
    write() {}, log: (...a) => logs.push(a.join(' ')),
    deps: { agentClient: client, group: 'mesh//g1', now: () => time.t, adminClient: admin, personClient: person, personStore: store, gate, endpoint: () => ({ port: 9971, servername: 'hub.example.ts.net', ca: 'CA-PEM' }), ...(over.deps || {}) },
  });
  let n = 0;
  const raw = async (name, args) => (await remote.handle({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } })).result;
  const call = async (name, args) => {
    const r = await raw(name, args);
    const text = r.content[0].text;
    return r.isError ? { toolError: text } : JSON.parse(text);
  };
  return { remote, calls, personCalls, gateCalls, handlers, time, home, admin, store, call, raw, logs };
}
const open = (t, over = {}) => t.call('desktop_open', { nodeid: NODE_A, who: SAM, ...over });

test('module.json: the three settings and the five hub tools are declared', () => {
  const m = manifest();
  const by = Object.fromEntries(m.settings.map((s) => [s.key, s]));
  assert.strictEqual(by.desktop_who.type, 'choice');
  assert.deepStrictEqual(by.desktop_who.options, ['admins', 'owner']);
  assert.strictEqual(by.desktop_who.default, 'admins');
  assert.deepStrictEqual([by.desktop_minutes.type, by.desktop_minutes.default, by.desktop_minutes.min, by.desktop_minutes.max], ['number', 30, 5, 120]);
  assert.strictEqual(by.desktop_address.default, '');
  const re = new RegExp(by.desktop_address.pattern);
  for (const ok of ['https://hub.example.ts.net', 'https://hub.example.ts.net:8443']) assert.ok(re.test(ok), ok);
  for (const bad of ['http://hub.example.ts.net', 'https://hub.example.ts.net/x', 'hub.example.ts.net', 'https://', 'https://a b']) assert.ok(!re.test(bad), bad);
  for (const k of ['desktop_who', 'desktop_minutes', 'desktop_address']) assert.ok(by[k].label && by[k].help, k);
  assert.match(by.desktop_who.help, /owner/); assert.match(by.desktop_address.help, /owner/);
  for (const n of ['desktop_sessions', 'desktop_open', 'desktop_endpoint', 'desktop_connect', 'desktop_end']) {
    assert.strictEqual(m.tools[n], 'hub', n);
    assert.ok(TOOLS.some((t) => t.name === n), n);
  }
});

test('configFor is not changed by the desktop settings (no "run the install again")', () => {
  const ms = createMeshServer({ runtimeDir: tmp(), home: tmp(), settings: {}, log() {} });
  const base = { run_as: 'hub', address_name: 'hub.example.ts.net', listen_ip: '100.64.0.10', control_port: 9971, agent_port: 9972, levels: [], session_minutes: 30 };
  const a = ms.configFor(base);
  const b = ms.configFor({ ...base, desktop_who: 'owner', desktop_minutes: 90, desktop_address: 'https://hub.example.ts.net' });
  assert.deepStrictEqual(b, a);
  assert.ok(!JSON.stringify(a).includes('person'));
});

test('nothing is done for the desktop until the first desktop_open (no account, no connection, no file)', async () => {
  const t = setup();
  await t.call('computers', AGENT);
  await t.call('desktop_sessions', {});
  assert.deepStrictEqual(t.admin.calls, []);
  assert.deepStrictEqual(t.personCalls, []);
  assert.strictEqual(t.store.get(), null);
  assert.ok(!fs.existsSync(path.join(t.home, 'desktop-sessions.json')));
});

test('desktop_open: makes the person account once, then a session of 30 minutes; the file is private', async () => {
  const t = setup();
  const r = await open(t);
  assert.deepStrictEqual(t.admin.calls.map((c) => c.action), ['adduser', 'addmeshuser']);
  assert.strictEqual(t.admin.calls[1].fields.meshadmin, 12584456);
  assert.match(r.session, /^[A-Za-z0-9_-]{43}$/);
  assert.deepStrictEqual([r.nodeid, r.name, r.start, r.until], [NODE_A, 'demo-pc', START, START + 30 * 60000]);
  // a second computer open later (after the first ends) does not repeat the account
  await t.call('desktop_end', { session: r.session, reason: 'ended' });
  const r2 = await open(t);
  assert.ok(r2.session && r2.session !== r.session);
  assert.strictEqual(t.admin.calls.length, 2, 'the account was made once');
  assert.strictEqual(mode(path.join(t.home, 'desktop-sessions.json')), 0o600);
});

test('desktop_open: minutes are clamped to 5..120 and default to the setting; a bad argument is a plain error', async () => {
  const t = setup({ settings: { desktop_minutes: 45 } });
  const a = await open(t);
  assert.strictEqual(a.until - a.start, 45 * 60000);
  await t.call('desktop_end', { session: a.session });
  const lo = await open(t, { minutes: 1 }); assert.strictEqual(lo.until - lo.start, 5 * 60000);
  await t.call('desktop_end', { session: lo.session });
  const hi = await open(t, { minutes: 9999 }); assert.strictEqual(hi.until - hi.start, 120 * 60000);
  await t.call('desktop_end', { session: hi.session });
  for (const bad of [{ nodeid: 5 }, { nodeid: '' }, { who: null }, { who: {} }, { who: { id: 'x' } }, { who: { id: 'x'.repeat(101), name: 'n' } }, { who: { id: 'x', name: 'n'.repeat(101) } }, { who: { id: 1, name: 'n' } }, { minutes: 'ten' }]) {
    const e = await open(t, bad);
    assert.strictEqual(typeof e.error, 'string', JSON.stringify(bad));
    assert.ok(!e.session);
  }
});

test('desktop_open: unknown and offline computers are refused; a busy one names who and until when (HH:MM, local)', async () => {
  const t = setup();
  const unknown = await open(t, { nodeid: 'node//NoSuchComputer000000' });
  assert.match(unknown.error, /not in the list/);
  const offline = await open(t, { nodeid: `node//${ID_B}` });
  assert.match(offline.error, /Laptop is offline/);
  assert.deepStrictEqual(t.admin.calls, [], 'refused before the account is touched');
  const r = await open(t);
  t.time.t += 60000;
  const busy = await open(t, { who: { id: 'user-2', name: 'Pat' } });
  assert.strictEqual(busy.error, 'demo-pc is in use by Sam until 09:35.');
  assert.deepStrictEqual(busy.busy, { who: { name: 'Sam' }, until: r.until });
  assert.ok(!('session' in busy));
});

test('desktop_open: when the account cannot be set up it says the desktop is not ready', async () => {
  const t = setup({ admin: fakeAdmin({ adduser: async () => { throw new MeshError('Invalid password', 'EMESH'); } }) });
  const e = await open(t);
  assert.match(e.error, /desktop is not ready/);
  assert.deepStrictEqual((await t.call('desktop_sessions', {})).sessions, []);
  assert.ok(!JSON.stringify(t.logs).includes(t.store.get().pass), 'no password in the log');
});

test('desktop_sessions: live sessions only, never the session id', async () => {
  const t = setup();
  assert.deepStrictEqual(await t.call('desktop_sessions', {}), { sessions: [] });
  const r = await open(t);
  const list = await t.call('desktop_sessions', {});
  assert.deepStrictEqual(list, { sessions: [{ nodeid: NODE_A, name: 'demo-pc', who: SAM, start: START, until: START + 30 * 60000 }] });
  assert.ok(!JSON.stringify(list).includes(r.session));
});

test('desktop_endpoint: the port, the certificate name and the CA of a live session only', async () => {
  const t = setup();
  const r = await open(t);
  assert.deepStrictEqual(await t.call('desktop_endpoint', { session: r.session }), { port: 9971, servername: 'hub.example.ts.net', ca: 'CA-PEM' });
  assert.match((await t.call('desktop_endpoint', { session: 'x'.repeat(43) })).error, /not open/);
  assert.match((await t.call('desktop_endpoint', { session: 'short' })).error, /session/);
  assert.match((await t.call('desktop_endpoint', {})).error, /session/);
  t.time.t = r.until;
  assert.match((await t.call('desktop_endpoint', { session: r.session })).error, /not open/);
});

test('desktop_connect: waits for the authcookie (no responseid), sends the exact tunnel message and returns the query', async () => {
  const t = setup();
  const r = await open(t);
  const c = await t.call('desktop_connect', { session: r.session, tunnelid: 'k3j2h1g' });
  assert.deepStrictEqual(c, { query: `browser=1&p=2&nodeid=${NODE_A}&id=k3j2h1g&auth=CooKie$1@x` });
  assert.deepStrictEqual(t.personCalls.map((p) => [p.kind, p.action]), [['exchange', 'authcookie'], ['request', 'msg']]);
  const msg = t.personCalls[1].fields;
  assert.deepStrictEqual(msg, { type: 'tunnel', nodeid: NODE_A, value: `*/meshrelay.ashx?p=2&nodeid=${NODE_A}&id=k3j2h1g&rauth=rCooKie$2@y`, usage: 2 });
  assert.deepStrictEqual(t.personCalls[0].fields, {}, 'the authcookie request carries nothing else');
});

test('desktop_connect: a bad tunnel id, a bad or ended session, a refused tunnel and a missing cookie are plain errors', async () => {
  const t = setup();
  const r = await open(t);
  for (const bad of ['', 'abc', 'a'.repeat(65), 'abc def1', 'abc&id=1x', 'abc/../1', 7, null, undefined]) {
    const e = await t.call('desktop_connect', { session: r.session, tunnelid: bad });
    assert.match(e.error, /tunnelid/, String(bad));
  }
  assert.strictEqual(t.personCalls.length, 0, 'nothing was asked of the server');
  assert.match((await t.call('desktop_connect', { session: 'x'.repeat(43), tunnelid: 'abcdef' })).error, /not open/);
  assert.match((await t.call('desktop_connect', { session: 'bad session', tunnelid: 'abcdef' })).error, /session/);
  const refused = setup({ person: { exchange: async () => ({ action: 'authcookie', cookie: 'C00kie1234', rcookie: 'R00kie1234' }), request: async () => { throw new MeshError('Unable to route', 'EMESH'); } } });
  const r2 = await open(refused);
  const e = await refused.call('desktop_connect', { session: r2.session, tunnelid: 'abcdef' });
  assert.match(e.error, /could not reach/);
  assert.ok(!('query' in e));
  const nocookie = setup({ person: { exchange: async () => ({ action: 'authcookie' }), request: async () => ({}) } });
  const r3 = await open(nocookie);
  assert.match((await nocookie.call('desktop_connect', { session: r3.session, tunnelid: 'abcdef' })).error, /cookie/);
  const bad = setup({ person: { exchange: async () => ({ action: 'authcookie', cookie: 'a b&c=d', rcookie: 'R00kie1234' }), request: async () => ({}) } });
  const r4 = await open(bad);
  assert.match((await bad.call('desktop_connect', { session: r4.session, tunnelid: 'abcdef' })).error, /cookie/, 'a cookie that could change the query is not used');
  const slow = setup({ person: { exchange: async () => { throw new MeshError('authcookie timed out after 10 s.', 'ETIMEDOUT'); }, request: async () => ({}) } });
  const r5 = await open(slow);
  assert.match((await slow.call('desktop_connect', { session: r5.session, tunnelid: 'abcdef' })).error, /did not answer/);
});

test('desktop_end: returns the session and frees the computer; a second end is an error', async () => {
  const t = setup();
  const r = await open(t);
  t.time.t += 5 * 60000;
  const e = await t.call('desktop_end', { session: r.session, reason: 'ended' });
  assert.deepStrictEqual(e, { nodeid: NODE_A, name: 'demo-pc', who: SAM, start: START, until: START + 30 * 60000, ended: START + 5 * 60000 });
  assert.match((await t.call('desktop_end', { session: r.session })).error, /not open/);
  assert.match((await t.call('desktop_end', { session: 'nope' })).error, /session/);
  assert.deepStrictEqual((await t.call('desktop_sessions', {})).sessions, []);
  assert.ok((await open(t)).session, 'the computer is free again');
});

test('desktop_end by the computer alone (the hub restarted and no longer knows the session id); computers_status carries the node id', async () => {
  const t = setup();
  const r = await open(t);
  const e = await t.call('desktop_end', { nodeid: NODE_A, start: START, reason: 'restart' });
  assert.strictEqual(e.nodeid, NODE_A); assert.strictEqual(e.name, 'demo-pc');
  assert.deepStrictEqual((await t.call('desktop_sessions', {})).sessions, []);
  assert.match((await t.call('desktop_end', { nodeid: NODE_A })).error, /not open/);
  assert.match((await t.call('desktop_end', {})).error, /session/);
  assert.match((await t.call('desktop_end', { session: r.session })).error, /not open/);
  const st = await t.call('computers_status', {});
  assert.ok(Array.isArray(st) && st.some((c) => c.nodeid === NODE_A && c.name === 'demo-pc'), 'the hub opens a desktop by this id');
});

test('expiry: a session is no longer live at its end time; the hub can still end it with the reason "time" a moment later; old entries leave the file', async () => {
  const t = setup();
  const r = await open(t);
  t.time.t = r.until - 1;
  assert.strictEqual((await t.call('desktop_sessions', {})).sessions.length, 1);
  t.time.t = r.until;
  assert.deepStrictEqual((await t.call('desktop_sessions', {})).sessions, []);
  assert.ok((await open(t, { who: { id: 'user-2', name: 'Pat' } })).session, 'a new session can start on the computer');
  const file = JSON.parse(fs.readFileSync(path.join(t.home, 'desktop-sessions.json'), 'utf8'));
  const ended = await t.call('desktop_end', { session: r.session, reason: 'time' });
  assert.strictEqual(ended.ended, r.until, 'the end is the time it ran out');
  t.time.t = r.until + 11 * 60000;
  await t.call('desktop_sessions', {});
  const after = JSON.parse(fs.readFileSync(path.join(t.home, 'desktop-sessions.json'), 'utf8'));
  assert.ok(Object.keys(file.sessions).length >= 1);
  assert.ok(Object.keys(file.sessions).includes(r.session), 'kept for a moment so the hub can end it');
  assert.strictEqual(Object.keys(after.sessions).length, 1, 'the live session of the other person stays');
});

test('expiry: an entry that ran out long ago is dropped from the file on the next read', async () => {
  const t = setup();
  const r = await open(t);
  t.time.t = r.until + 11 * 60000;
  assert.deepStrictEqual((await t.call('desktop_sessions', {})).sessions, []);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(t.home, 'desktop-sessions.json'), 'utf8')).sessions, {});
  assert.match((await t.call('desktop_end', { session: r.session })).error, /not open/);
});

test('a module restart keeps the sessions (and the lock)', async () => {
  const first = setup();
  const r = await open(first);
  const again = setup({ home: first.home, time: first.time, store: first.store });
  assert.deepStrictEqual((await again.call('desktop_sessions', {})).sessions.map((s) => s.name), ['demo-pc']);
  assert.match((await open(again, { who: { id: 'u2', name: 'Pat' } })).error, /in use by Sam until 09:35/);
  assert.deepStrictEqual(await again.call('desktop_endpoint', { session: r.session }), { port: 9971, servername: 'hub.example.ts.net', ca: 'CA-PEM' });
  assert.ok((await again.call('desktop_connect', { session: r.session, tunnelid: 'abcdef' })).query, 'the person connection is made again after a restart');
  // a damaged file never crashes, and the locks already known stay (fail closed)
  fs.writeFileSync(path.join(first.home, 'desktop-sessions.json'), '{ not json');
  assert.deepStrictEqual((await again.call('desktop_sessions', {})).sessions.map((s) => s.name), ['demo-pc']);
});

test('desktop_end by the computer needs the start of the session: a newer session on the same computer is never ended by an old one (restart race)', async () => {
  const t = setup();
  const r = await open(t);
  const wrong = await t.call('desktop_end', { nodeid: NODE_A, start: START - 1000, reason: 'restart' });
  assert.match(wrong.error, /That desktop session is not open\./);
  assert.match((await t.call('desktop_end', { nodeid: NODE_A, reason: 'restart' })).error, /not open/, 'no start: no end');
  assert.strictEqual((await t.call('desktop_sessions', {})).sessions.length, 1, 'the session is still there');
  assert.ok((await t.call('desktop_endpoint', { session: r.session })).port);
  assert.strictEqual((await t.call('desktop_end', { nodeid: NODE_A, start: START, reason: 'restart' })).nodeid, NODE_A);
});

test('desktop store: a sessions file that cannot be read keeps the last known locks (logged once); a missing file is empty', () => {
  const file = path.join(tmp(), 'desktop-sessions.json');
  let fail = null;
  const logs = [];
  const d = createDesktop({ file, now: () => START, log: (m) => logs.push(m), readFile: (f) => { if (fail) throw fail; return fs.readFileSync(f, 'utf8'); } });
  assert.deepStrictEqual(d.list(), [], 'a missing file is empty');
  const rec = d.open({ nodeid: NODE_A, name: 'demo-pc', who: SAM, minutes: 10 });
  fail = Object.assign(new Error('no access'), { code: 'EACCES' });
  assert.deepStrictEqual(d.list().map((r) => r.session), [rec.session], 'the live lock survives an unreadable file');
  assert.throws(() => d.open({ nodeid: NODE_A, name: 'demo-pc', who: { id: 'u2', name: 'Pat' }, minutes: 10 }), /cannot be read right now/);
  assert.ok(d.forNode(NODE_A) && d.forNode(NODE_A).unknown, 'while unreadable every computer counts as locked');
  d.list();
  assert.strictEqual(logs.length, 1, 'logged once');
  fail = null;
  fs.writeFileSync(file, '{ not json');
  assert.deepStrictEqual(d.list().map((r) => r.session), [rec.session], 'a damaged file too');
  fail = Object.assign(new Error('gone'), { code: 'ENOENT' });
  assert.deepStrictEqual(d.list(), [], 'a file that is gone is empty');
});

test('desktop store: a FRESH process with an unreadable or malformed file fails closed (state unknown), and reads normally again once it can', () => {
  const file = path.join(tmp(), 'desktop-sessions.json');
  let fail = Object.assign(new Error('io'), { code: 'EIO' });
  const read = (f) => { if (fail) throw fail; return fs.readFileSync(f, 'utf8'); };
  const fresh = createDesktop({ file, now: () => START, readFile: read });
  assert.ok(fresh.forNode(NODE_A).unknown, 'unreadable in a fresh process: locked');
  assert.ok(fresh.forQuery('demo-pc').unknown);
  assert.throws(() => fresh.open({ nodeid: NODE_A, name: 'demo-pc', who: SAM, minutes: 10 }), /cannot be read right now/);
  fail = null;
  for (const bad of ['{"x":1}', '[]', '{"sessions":[]}', 'null']) {
    fs.writeFileSync(file, bad);
    const d = createDesktop({ file, now: () => START, readFile: read });
    assert.ok(d.forNode(NODE_A) && d.forNode(NODE_A).unknown, `malformed ${bad}: unknown, not empty`);
  }
  fs.writeFileSync(file, '{"sessions":{}}\n');
  const ok = createDesktop({ file, now: () => START, readFile: read });
  assert.strictEqual(ok.forNode(NODE_A), null, 'a valid empty file: no lock');
  assert.ok(ok.open({ nodeid: NODE_A, name: 'demo-pc', who: SAM, minutes: 10 }).session);
});

test('desktop store: ending by computer and start finds the exact session even when an expired predecessor is still in the file', () => {
  let t = START;
  const d = createDesktop({ file: path.join(tmp(), 'desktop-sessions.json'), now: () => t });
  const a = d.open({ nodeid: NODE_A, name: 'demo-pc', who: SAM, minutes: 5 });
  t += 5 * 60000 + 1000;   // A ran out; it stays in the file for the grace
  const b = d.open({ nodeid: NODE_A, name: 'demo-pc', who: SAM, minutes: 10 });
  assert.notStrictEqual(a.start, b.start);
  const e = d.endNode(NODE_A, b.start);
  assert.strictEqual(e.session, b.session, 'B, the exact match, is ended');
  assert.strictEqual(d.forNode(NODE_A), null);
});

test('desktop store: the session file is only what this module wrote (no id outside the format, no half records)', () => {
  const file = path.join(tmp(), 'desktop-sessions.json');
  let t = START;
  const d = createDesktop({ file, now: () => t });
  const rec = d.open({ nodeid: NODE_A, name: 'demo-pc', who: SAM, minutes: 10 });
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.sessions.short = { session: 'short', nodeid: NODE_A, name: 'x', who: SAM, start: t, until: t + 1e6 };
  raw.sessions['y'.repeat(43)] = { nodeid: NODE_A };
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.deepStrictEqual(d.list().map((r) => r.session), [rec.session]);
});

// ── the agents' input tools while a person is at the screen ──
const REFUSAL = "A person is using this computer's desktop until 09:35. Try again after that.";
const INPUT_ARGS = {
  run: { command: 'dir' }, type: { text: 'hello' }, key: { keys: 'enter' }, scroll: { amount: 3 },
  click: { shot: 'abcdefgh', x: 1, y: 1 },
};

test('input tools: refused at once with the exact sentence while a person has the desktop (no approval, no server call); a normal tool error', async () => {
  const t = setup();
  await open(t);
  const before = t.calls.length;
  for (const tool of ['run', 'click', 'type', 'key', 'scroll']) {
    for (const computer of ['demo-pc', 'DEMO-PC', ID_A.slice(0, 12), ID_A]) {
      const r = await t.raw(tool, { ...AGENT, computer, ...INPUT_ARGS[tool] });
      assert.strictEqual(r.isError, true, tool);
      assert.strictEqual(r.content[0].text, REFUSAL, `${tool} ${computer}`);
    }
  }
  assert.strictEqual(t.calls.length, before, 'no call to the server, not even the computer list');
  assert.deepStrictEqual(t.gateCalls.filter((g) => g.need !== 'look'), [], 'the owner is not asked');
});

test('input tools: refused after the computer list too (a name the cache did not match), and another computer is not affected', async () => {
  const t = setup();
  await open(t);
  const e = await t.raw('run', { ...AGENT, computer: 'demo-pc'.toUpperCase(), command: 'dir' });
  assert.strictEqual(e.content[0].text, REFUSAL);
  // the Laptop is offline: its own (different) refusal, not the desktop's
  const lap = await t.raw('run', { ...AGENT, computer: 'Laptop', command: 'dir' });
  assert.match(lap.content[0].text, /Laptop is offline/);
});

test('input tools: allowed again after the session ends, and after it runs out', async () => {
  const t = setup({ handlers: { runcommands: async () => ({ action: 'runcommands', result: 'hello' }) } });
  const r = await open(t);
  assert.strictEqual((await t.raw('run', { ...AGENT, computer: 'demo-pc', command: 'echo hello' })).isError, true);
  await t.call('desktop_end', { session: r.session });
  assert.deepStrictEqual((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'echo hello' })).output, 'hello');
  const r2 = await open(t);
  assert.strictEqual((await t.raw('run', { ...AGENT, computer: 'demo-pc', command: 'x' })).isError, true);
  t.time.t = r2.until;
  assert.strictEqual((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'echo hello' })).output, 'hello');
});

test('input tools: a session that starts while the owner is being asked stops the command before it is sent', async () => {
  const t = setup({ handlers: { runcommands: async () => ({ action: 'runcommands', result: 'ran' }) } });
  let opened = false;
  const gated = setup({
    home: t.home, handlers: t.handlers,
    onGate: async (need) => { if (need === 'act' && !opened) { opened = true; await open(gated); } },
  });
  const r = await gated.raw('run', { ...AGENT, computer: 'demo-pc', command: 'echo hi' });
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /^A person is using this computer's desktop until 09:35\./);
  assert.strictEqual(gated.calls.filter((c) => c.action === 'runcommands').length, 0, 'nothing was sent to the computer');
});

test('look tools are not affected by a live desktop session: info and screenshot still work', async () => {
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('a picture')]);
  const t = setup({ handlers: {
    getsysinfo: async () => ({ action: 'getsysinfo', hardware: {} }),
    runcommands: async () => ({ action: 'runcommands', result: `MMSHOT 1600 900 1920 1080 ${JPEG.toString('base64')} MMEND\r\n` }),
  } });
  await open(t);
  assert.strictEqual((await t.call('info', { ...AGENT, computer: 'demo-pc' })).name, 'demo-pc');
  const shot = await t.raw('screenshot', { ...AGENT, computer: 'demo-pc' });
  assert.ok(!shot.isError, JSON.stringify(shot).slice(0, 200));
  assert.strictEqual(shot.content[1].type, 'image');
  assert.strictEqual((await t.call('computers', AGENT))[0].name, 'demo-pc');
});
