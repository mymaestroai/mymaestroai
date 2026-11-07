'use strict';
// Remote computers, the guided setup: the manifest and setup load through the hub's loader, the one-time installer link
// (tokens, the receiver, the cached download) and the three checks. Nothing here talks to a real MeshCentral.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadModule } = require('../lib/modules/manifest');
const { createTokens, createInstaller, sessionCookies, ALPHABET, TOKEN_LENGTH, TOKEN_TTL_MS, MAX_TOKENS, CACHE_FILE, CACHE_TTL_MS, RATE_LIMIT, GONE, UNAVAILABLE } = require('../modules/remote-computers/lib/installer');
const { createRemote, TOOLS } = require('../modules/remote-computers/server');
const { checks } = require('../modules/remote-computers/index');

const DIR = path.join(__dirname, '..', 'modules', 'remote-computers');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rc-setup-'));
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.from('a pretend program')]);
const clock = (t = 1783000000000) => { const c = { t, now: () => c.t, advance: (ms) => { c.t += ms; } }; return c; };
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };

// ── the manifest and the setup ──────────────────────────────────────────────────────────────────
test('setup: the module loads through the hub\'s loader without problems', () => {
  const m = loadModule(DIR);
  assert.deepStrictEqual(m.problems, []);
  assert.deepStrictEqual(m.manifest.receiver.paths, ['installer']);
  assert.strictEqual(m.manifest.tools.installer_link, 'hub');
  assert.strictEqual(m.manifest.tools.computers_status, 'hub');
  assert.deepStrictEqual(TOOLS.map((t) => t.name).sort(), Object.keys(m.manifest.tools).sort());
  assert.ok(m.hasGuide);
});

test('setup: the steps come in the planned order with the right types', () => {
  const { setup } = loadModule(DIR);
  assert.deepStrictEqual(setup.steps.map((s) => [s.id, s.type]), [
    ['about', 'explain'], ['install', 'install'], ['prefs', 'settings'], ['server', 'check'], ['pc', 'outside'],
    ['installer', 'check'], ['computer', 'check'], ['levels', 'settings'], ['agents', 'grant'], ['done', 'finish'],
  ]);
  const by = Object.fromEntries(setup.steps.map((s) => [s.id, s]));
  assert.strictEqual(by.about.confirm, 'I understand that agents I allow can fully control the computers I add.');
  assert.deepStrictEqual(by.prefs.fields, ['address_name', 'listen_ip', 'control_port', 'agent_port']);
  assert.deepStrictEqual(by.levels.fields, ['levels', 'session_minutes']);
  assert.match(by.prefs.body, /tailscale status/);
  assert.match(by.about.body, /phone/);
  assert.strictEqual(by.server.title, 'Start the server');
  assert.strictEqual(by.installer.title, 'Get the installer');
  assert.strictEqual(by.computer.title, 'Check the PC is connected');
  assert.strictEqual(by.pc.title, 'Prepare the PC');
});

test('setup: the guide has the planned sections and no placeholder text', () => {
  const g = fs.readFileSync(path.join(DIR, 'guide.md'), 'utf8');
  for (const h of ['What it does', 'Safety', 'What each step does', 'What each setting does', 'Tools', 'Common errors and fixes', 'Removing a computer', 'Switching it off']) assert.match(g, new RegExp(`^## ${h}$`, 'm'), h);
  assert.doesNotMatch(g, /placeholder/i);
  assert.doesNotMatch(g, /-fulluninstall/);   // only confirmed for Linux in MeshCentral's scripts, so the guide does not promise it on Windows
  assert.match(g, /Settings -> Apps/);
  assert.match(g, /MyMaestro-RemoteAgent\.exe/);
});

// ── the tokens ──────────────────────────────────────────────────────────────────────────────────
test('tokens: 8 characters from an unambiguous lowercase alphabet', () => {
  assert.ok(!/[0o1li]/.test(ALPHABET));
  assert.match(ALPHABET, /^[a-z2-9]+$/);
  const t = createTokens({});
  for (let i = 0; i < 200; i++) {
    const { token } = t.make();
    assert.strictEqual(token.length, TOKEN_LENGTH);
    assert.match(token, /^[abcdefghjkmnpqrstuvwxyz2-9]{8}$/);
  }
});

test('tokens: valid for 15 minutes on the clock, single use', () => {
  const c = clock();
  const t = createTokens({ now: c.now });
  const a = t.make();
  assert.strictEqual(a.expiresAt, c.t + 15 * 60000);
  assert.strictEqual(TOKEN_TTL_MS, 15 * 60000);
  assert.strictEqual(t.consume(a.token), true);
  assert.strictEqual(t.consume(a.token), false, 'spent');
  const b = t.make();
  c.advance(15 * 60000 - 1);
  assert.strictEqual(t.consume(b.token), true, 'still alive one millisecond before the end');
  const d = t.make();
  c.advance(15 * 60000);
  assert.strictEqual(t.consume(d.token), false, 'expired');
  assert.strictEqual(t.consume('nonsense'), false);
  assert.strictEqual(t.consume(undefined), false);
});

test('tokens: at most 3 alive, the newest replaces the oldest', () => {
  assert.strictEqual(MAX_TOKENS, 3);
  const t = createTokens({});
  const made = [1, 2, 3, 4].map(() => t.make().token);
  assert.strictEqual(t.size(), 3);
  assert.strictEqual(t.consume(made[0]), false, 'the oldest was replaced');
  for (const tok of made.slice(1)) assert.strictEqual(t.consume(tok), true);
});

test('tokens: an expired one does not count against the three', () => {
  const c = clock();
  const t = createTokens({ now: c.now });
  const old = t.make().token;
  c.advance(TOKEN_TTL_MS + 1);
  const rest = [t.make().token, t.make().token, t.make().token];
  assert.strictEqual(t.size(), 3);
  assert.strictEqual(t.consume(old), false);
  for (const tok of rest) assert.strictEqual(t.consume(tok), true);
});

// ── the receiver ────────────────────────────────────────────────────────────────────────────────
function newInstaller(over = {}) {
  const c = over.clock || clock();
  const home = 'home' in over ? over.home : tmp();
  const logs = [];
  let fetches = 0;
  const fetchInstaller = over.fetchInstaller || (async () => { fetches++; return EXE; });
  const inst = createInstaller({
    home, now: c.now, log: (...a) => logs.push(a.join(' ')),
    fetchInstaller: async () => { const r = await fetchInstaller(); if (!over.fetchInstaller) return r; fetches++; return r; },
    address: () => 'hub.example.ts.net',
  });
  const get = (token) => inst.receive({ method: 'GET', path: 'installer', query: { t: token } });
  return { inst, c, home, logs, get, fetches: () => fetches };
}

test('installer link: the address and the expiry', () => {
  const { inst, c } = newInstaller();
  const l = inst.link();
  assert.match(l.url, /^https:\/\/hub\.example\.ts\.net\/hooks\/remote-computers\/installer\?t=[abcdefghjkmnpqrstuvwxyz2-9]{8}$/);
  assert.strictEqual(l.expiresAt, new Date(c.t + 15 * 60000).toISOString());
});

test('receiver: bad, unknown, spent and expired tokens get the same 404 text', async () => {
  const x = newInstaller();
  const good = x.inst.link().url.split('?t=').pop();
  for (const bad of ['zzzzzzzz', 'short', 'UPPER123', '..%2f..', '']) {
    const r = await x.get(bad);
    assert.strictEqual(r.status, 404, bad);
    assert.strictEqual(r.body, GONE);
    assert.match(r.body, /^This link has expired\. Make a new one in Data connectors -> Remote computers\.\n?$/);
    assert.match(r.headers['content-type'], /^text\/plain/);
  }
  assert.strictEqual((await x.inst.receive({ method: 'GET', path: 'installer' })).status, 404);
  assert.strictEqual((await x.inst.receive({ method: 'GET', path: 'other/zzzzzzzz' })).status, 404);
  assert.strictEqual((await x.get(good)).status, 200);
  assert.strictEqual((await x.get(good)).status, 404, 'spent');
  const y = newInstaller();
  const late = y.inst.link().url.split('?t=').pop();
  y.c.advance(TOKEN_TTL_MS + 1);
  assert.strictEqual((await y.get(late)).status, 404, 'expired');
});

test('receiver: a good token gives the installer as a download', async () => {
  const x = newInstaller();
  const token = x.inst.link().url.split('?t=').pop();
  const r = await x.get(token);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['content-type'], 'application/octet-stream');
  assert.strictEqual(r.headers['content-disposition'], 'attachment; filename="MyMaestro-RemoteAgent.exe"');
  assert.strictEqual(r.body, undefined);
  assert.deepStrictEqual(Buffer.from(r.bodyBase64, 'base64'), EXE);
  const file = path.join(x.home, CACHE_FILE);
  assert.deepStrictEqual(fs.readFileSync(file), EXE);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(x.fetches(), 1);
});

test('receiver: a post or a head request is refused and spends nothing', async () => {
  const x = newInstaller();
  const token = x.inst.link().url.split('?t=').pop();
  assert.strictEqual((await x.inst.receive({ method: 'POST', path: 'installer', query: { t: token } })).status, 405);
  assert.strictEqual((await x.inst.receive({ method: 'HEAD', path: 'installer', query: { t: token } })).status, 405);
  assert.strictEqual((await x.get(token)).status, 200);
});

test('receiver: the download is reused for 24 hours, then fetched again', async () => {
  const x = newInstaller();
  for (let i = 0; i < 3; i++) assert.strictEqual((await x.get(x.inst.link().url.split('?t=').pop())).status, 200);
  assert.strictEqual(x.fetches(), 1);
  x.c.advance(CACHE_TTL_MS - 60000);
  assert.strictEqual((await x.get(x.inst.link().url.split('?t=').pop())).status, 200);
  assert.strictEqual(x.fetches(), 1, 'still fresh');
  x.c.advance(120000);
  assert.strictEqual((await x.get(x.inst.link().url.split('?t=').pop())).status, 200);
  assert.strictEqual(x.fetches(), 2, 'older than a day');
});

test('receiver: two links used at once fetch once', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const x = newInstaller({ fetchInstaller: async () => { await gate; return EXE; } });
  const a = x.inst.link().url.split('?t=').pop(), b = x.inst.link().url.split('?t=').pop();
  const both = Promise.all([x.get(a), x.get(b)]);
  await new Promise((r) => setImmediate(r));
  release();
  const [ra, rb] = await both;
  assert.strictEqual(ra.status, 200); assert.strictEqual(rb.status, 200);
  assert.strictEqual(x.fetches(), 1);
});

test('receiver: a failed download is a plain 502 that leaks nothing, and the link is spent', async () => {
  const secret = 'hunter2-the-admin-password';
  const x = newInstaller({ fetchInstaller: async () => { throw new Error(`login for admin failed with ${secret} at 127.0.0.1:9971`); } });
  const token = x.inst.link().url.split('?t=').pop();
  const r = await x.get(token);
  assert.strictEqual(r.status, 502);
  assert.strictEqual(r.body, UNAVAILABLE);
  assert.match(r.body, /^The installer is not available right now\.\n?$/);
  assert.doesNotMatch(JSON.stringify(r), /hunter2|127\.0\.0\.1|9971/);
  assert.ok(x.logs.some((l) => /installer download failed/.test(l)), 'the detail goes to the log');
  assert.strictEqual((await x.get(token)).status, 404, 'spent');
});

test('receiver: something that is not a program file is refused, and is not cached', async () => {
  const x = newInstaller({ fetchInstaller: async () => Buffer.from('<html>please sign in</html>') });
  const r = await x.get(x.inst.link().url.split('?t=').pop());
  assert.strictEqual(r.status, 502);
  assert.ok(!fs.existsSync(path.join(x.home, CACHE_FILE)));
});

test('receiver: at most 10 requests a minute in total, wrong tokens included', async () => {
  const x = newInstaller();
  assert.strictEqual(RATE_LIMIT, 10);
  for (let i = 0; i < 10; i++) assert.strictEqual((await x.get('zzzzzzzz')).status, 404);
  const r = await x.get(x.inst.link().url.split('?t=').pop());
  assert.strictEqual(r.status, 429);
  assert.strictEqual(x.fetches(), 0);
  x.c.advance(60000);
  assert.strictEqual((await x.get('zzzzzzzz')).status, 404, 'a minute later it is open again');
});

// ── through the server: the tool, the hub/receive request and the checks' tools ─────────────────
function newRemote(over = {}) {
  const home = tmp();
  const c = clock();
  const lines = [];
  const remote = createRemote({
    env: { MODULE_SETTINGS: JSON.stringify({ address_name: 'hub.example.ts.net', ...(over.settings || {}) }), CONNECTOR_DATA_HOME: home },
    write: (l) => lines.push(l), log: () => {},
    deps: { now: c.now, installerFetcher: async () => EXE, agentClient: { request: async () => ({ nodes: over.nodes || {} }) }, group: 'mesh//g1' },
  });
  let n = 0;
  const rpc = async (method, params) => (await remote.handle({ jsonrpc: '2.0', id: ++n, method, params })).result;
  const tool = async (name, args = {}) => { const r = await rpc('tools/call', { name, arguments: args }); return r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text); };
  return { remote, rpc, tool, home, c };
}

test('server: installer_link and hub/receive work together', async () => {
  const s = newRemote();
  const link = await s.tool('installer_link');
  assert.match(link.url, /^https:\/\/hub\.example\.ts\.net\/hooks\/remote-computers\/installer\?t=[a-z2-9]{8}$/);
  assert.ok(Date.parse(link.expiresAt) > s.c.t);
  const token = link.url.split('?t=').pop();
  const r = await s.rpc('hub/receive', { method: 'GET', path: 'installer', query: { t: token }, headers: {}, body: '', ip: '100.64.0.10' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['content-type'], 'application/octet-stream');
  assert.strictEqual(r.headers['content-disposition'], 'attachment; filename="MyMaestro-RemoteAgent.exe"');
  assert.deepStrictEqual(Buffer.from(r.bodyBase64, 'base64'), EXE);
  const again = await s.rpc('hub/receive', { method: 'GET', path: 'installer', query: { t: token } });
  assert.strictEqual(again.status, 404);
});

test('server: installer_link needs the tailnet name', async () => {
  const s = newRemote({ settings: { address_name: '' } });
  const r = await s.tool('installer_link');
  assert.match(r.error, /tailnet name/);
});

test('server: computers_status lists names, systems and online state without an agent', async () => {
  const s = newRemote({ nodes: { 'mesh//g1': [{ _id: 'node//Abcdefghijkl0123456789', name: 'demo-pc', osdesc: 'Windows 11', conn: 1 }, { _id: 'node//Bcdefghijklm9876543210', name: 'Laptop', osdesc: 'Windows 10', conn: 0 }] } });
  assert.deepStrictEqual(await s.tool('computers_status'), [{ name: 'demo-pc', os: 'Windows 11', online: true }, { name: 'Laptop', os: 'Windows 10', online: false }]);
});

test('server: the sessions cookies are read from a login reply', () => {
  assert.strictEqual(sessionCookies(['xid=abc123; path=/; httponly', 'xid.sig=sig456; path=/; httponly', 'other=1']), 'xid=abc123; xid.sig=sig456');
  assert.strictEqual(sessionCookies(['xid=abc123; path=/']), null);
  assert.strictEqual(sessionCookies(undefined), null);
});

// ── the checks ──────────────────────────────────────────────────────────────────────────────────
const ctxOf = (tools) => ({
  settings: {}, parse,
  callTool: async (name, args) => { const v = tools[name]; if (typeof v === 'function') return v(args); if (v === undefined) throw new Error(`no stub for ${name}`); return v; },
});

test('check installer: shows the address and the Windows advice, once, and keeps the address out of the summary', async () => {
  const url = 'https://hub.example.ts.net/hooks/remote-computers/installer?t=abcd2345';
  const r = await checks.installer(ctxOf({ installer_link: JSON.stringify({ url, expiresAt: '2026-11-07T14:20:00.000Z' }) }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.once, true);
  assert.strictEqual(r.lines[0], `On the PC, open this address in a browser within 15 minutes (the whole address, including the part after the ? mark): ${url}`);
  assert.ok(r.lines.includes('It downloads MyMaestro-RemoteAgent.exe. Run it and choose Install. Windows Defender or SmartScreen may warn that it is a remote-access tool; that is expected for this kind of software.'));
  assert.ok(!r.summary.includes(url) && !r.summary.includes('abcd2345'));
});

test('check installer: a refusal or an unreadable reply is a plain failure', async () => {
  const a = await checks.installer(ctxOf({ installer_link: 'Save this computer\'s tailnet name in the settings first.' }));
  assert.strictEqual(a.ok, false);
  assert.match(a.summary, /tailnet name/);
  const b = await checks.installer(ctxOf({ installer_link: () => { throw new Error('The hub did not answer.'); } }));
  assert.deepStrictEqual([b.ok, b.summary], [false, 'The hub did not answer.']);
  const c = await checks.installer(ctxOf({ installer_link: JSON.stringify({ url: 'http://hub.example.ts.net/x' }) }));
  assert.strictEqual(c.ok, false);
});

test('check computer: passes when a computer is online', async () => {
  const r = await checks.computer(ctxOf({ computers_status: JSON.stringify([{ name: 'Laptop', os: 'Windows 10', online: false }, { name: 'demo-pc', os: 'Windows 11', online: true }]) }));
  assert.deepStrictEqual([r.ok, r.summary], [true, 'demo-pc is connected (Windows 11)']);
  const two = await checks.computer(ctxOf({ computers_status: JSON.stringify([{ name: 'demo-pc', os: 'Windows 11', online: true }, { name: 'b-pc', online: true }]) }));
  assert.strictEqual(two.ok, true);
  assert.match(two.summary, /^demo-pc is connected \(Windows 11\) \(and 1 more online\)$/);
  const noOs = await checks.computer(ctxOf({ computers_status: JSON.stringify([{ name: 'demo-pc', online: true }]) }));
  assert.strictEqual(noOs.summary, 'demo-pc is connected');
});

test('check computer: fails with the plain text when none has connected or none is online', async () => {
  const none = await checks.computer(ctxOf({ computers_status: '[]' }));
  assert.deepStrictEqual([none.ok, none.summary], [false, 'No computer has connected yet. Run the installer on the PC, then check again.']);
  const off = await checks.computer(ctxOf({ computers_status: JSON.stringify([{ name: 'demo-pc', os: 'Windows 11', online: false }]) }));
  assert.strictEqual(off.ok, false);
  assert.match(off.summary, /demo-pc registered, but none is online/);
  const err = await checks.computer(ctxOf({ computers_status: 'The Remote computers server is not ready yet. Try again in a minute.' }));
  assert.strictEqual(err.ok, false);
  assert.match(err.summary, /not ready/);
  const thrown = await checks.computer(ctxOf({ computers_status: () => { throw new Error('boom'); } }));
  assert.deepStrictEqual([thrown.ok, thrown.summary], [false, 'boom']);
});

test('check server: unchanged, still reads the health tool', async () => {
  const r = await checks.server(ctxOf({ health: JSON.stringify({ ok: true, running: true, group: 'mesh//g1', computers: 1, online: 1, warnings: [] }) }));
  assert.deepStrictEqual([r.ok, r.summary], [true, 'The server is running. 1 computer registered, 1 online.']);
});

test('check server: on a system other than Linux it says so and does not call the server', async () => {
  let called = false;
  const ctx = { ...ctxOf({ health: () => { called = true; return '{}'; } }), platform: 'win32' };
  const r = await checks.server(ctx);
  assert.deepStrictEqual([r.ok, r.summary], [false, 'Remote computers needs My Maestro on Linux for now.']);
  assert.strictEqual(called, false);
});

test('receiver: the token is read from the query string (?t=); a second path segment, a missing or a wrong query is the same 404', async () => {
  const x = newInstaller();
  const url = x.inst.link().url;
  assert.match(url, /\/hooks\/remote-computers\/installer\?t=[a-z0-9]{8}$/);
  const token = url.split('?t=').pop();
  assert.strictEqual((await x.inst.receive({ method: 'GET', path: `installer/${token}` })).status, 404, 'the old second path segment is not a link');
  assert.strictEqual((await x.inst.receive({ method: 'GET', path: 'installer' })).status, 404);
  assert.strictEqual((await x.inst.receive({ method: 'GET', path: 'installer', query: {} })).status, 404);
  assert.strictEqual((await x.inst.receive({ method: 'GET', path: 'installer', query: { t: ['a', 'b'] } })).status, 404);
  assert.strictEqual((await x.inst.receive({ method: 'GET', path: 'other', query: { t: token } })).status, 404);
  const ok = await x.inst.receive({ method: 'GET', path: 'installer', query: { t: token } });
  assert.strictEqual(ok.status, 200, 'the token was not spent by the failed tries');
  assert.strictEqual((await x.inst.receive({ method: 'GET', path: 'installer', query: { t: token } })).status, 404, 'and works once');
  // A query given as text is read too.
  const y = newInstaller();
  const t2 = y.inst.link().url.split('?t=').pop();
  assert.strictEqual((await y.inst.receive({ method: 'GET', path: 'installer', query: `t=${t2}` })).status, 200);
});
