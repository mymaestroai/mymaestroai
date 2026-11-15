'use strict';
// Open desktop, hub core (lib/remote-desktop.js): every refusal, open/reuse/end/expiry, the log line, the boot JSON, the script
// allow-list, the desktop_address rule and the websocket relay against a local fake TLS upstream. Plus text checks of the wiring.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const tls = require('tls');
const http = require('http');
const { Readable } = require('stream');
const { spawnSync } = require('child_process');
const { makeIsolatedInstall } = require('./helpers/isolated-install');

const ISO = makeIsolatedInstall('rd-');
const { createRemoteDesktop, SCRIPTS } = require(path.join(ISO.lib, 'remote-desktop'));
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const T0 = Date.UTC(2026, 10, 15, 14, 0, 0);
const MIN = 60000;
const SID = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-aaaaa';   // 43 chars like 32 random bytes in base64url
const SID2 = 'ZyXwVuTsRqPoNnMmLlKkJjIiHhGgFfEeDdCcBbAa_-9';
const BOOT = '<script type="application/json" id="rd-boot">{}</script>';
const PAGE = `<!doctype html><html><body><h1>viewer</h1>${BOOT}</body></html>`;

const USERS = {
  owner: { id: 'u1', name: 'Owner', role: 'admin' },
  sam: { id: 'u2', name: 'Sam', role: 'admin' },
  ann: { id: 'u3', name: 'Ann', role: 'member' },
};

function rig(over = {}) {
  const st = { now: T0, timers: [], calls: [], logs: [], audits: [], settings: { desktop_who: 'admins', desktop_minutes: 30, desktop_address: '' }, enabled: true, tailnet: true,
    mod: new Map(), endpoint: { port: 9971, servername: 'mesh.example', ca: 'CA-PEM' }, got: [], page: PAGE, script: 'console.log(1)', connectReply: null, openReply: null };
  let n = 0;
  const handlers = {
    computers_status: () => ({ computers: [{ nodeid: 'node//pc1', name: 'PC One', online: true }, { nodeid: 'node//pc2', name: 'PC Two', online: false }] }),
    desktop_sessions: () => ({ sessions: Array.from(st.mod.values()).map((s) => ({ nodeid: s.nodeid, name: s.name, who: s.who, start: s.start, until: s.until })) }),
    desktop_open: (a) => {
      for (const s of st.mod.values()) if (s.nodeid === a.nodeid && s.until > st.now) return { error: `PC One is in use by ${s.who.name} until 14:30.`, busy: { who: { name: s.who.name }, until: s.until } };
      const session = (n++ === 0 ? SID : SID2);
      const rec = { session, nodeid: a.nodeid, name: 'PC One', who: a.who, start: st.now, until: st.now + a.minutes * MIN };
      st.mod.set(session, rec);
      return { session, nodeid: rec.nodeid, name: rec.name, start: rec.start, until: rec.until };
    },
    desktop_endpoint: () => ({ ...st.endpoint }),
    desktop_connect: (a) => (st.connectReply || { query: `browser=1&p=2&nodeid=node%2F%2Fpc1&id=${a.tunnelid}&auth=MESHAUTH` }),
    desktop_end: (a) => { const s = st.mod.get(a.session) || Array.from(st.mod.values()).find((x) => x.nodeid === a.nodeid); if (!s) return { error: 'No such session.' }; st.mod.delete(s.session); return { ...s, ended: st.now }; },
  };
  const callTool = async (tool, args) => {
    st.calls.push({ tool, args });
    if (over.callTool) { const r = await over.callTool(tool, args, st); if (r !== undefined) return r; }
    const h = handlers[tool]; if (!h) throw new Error('no tool');
    const out = h(args, st);
    return typeof out === 'string' ? out : JSON.stringify(out);
  };
  const rd = createRemoteDesktop({
    callTool, parse: (t) => { try { return JSON.parse(t); } catch { return null; } },
    identify: (req) => {
      const w = req.headers['x-who'];
      if (w === 'service') return { service: true };
      if (w === 'token') return { token: { scopes: ['chat'] } };
      if (w === 'pending') return { user: USERS.owner, pendingTotp: true };
      return USERS[w] ? { user: USERS[w] } : {};
    },
    isAdmin: (u) => u.role === 'admin', isOwner: (u) => u.id === 'u1',
    tailnetOk: () => st.tailnet, enabled: () => st.enabled, settings: () => st.settings, readPage: () => st.page,
    log: (l) => st.logs.push(l), audit: (r) => st.audits.push(r), now: () => st.now,
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; st.timers.push(t); return t; }, clearTimer: (t) => { if (t) t.live = false; },
    httpsGet: async (o) => { st.got.push(o); return { status: 200, body: st.script }; },
    ...(over.deps || {}),
  });
  return { rd, st };
}

function mkRes() {
  const r = { code: 0, headers: {}, body: '', ended: false, writeHead(c, h) { r.code = c; r.headers = h || {}; }, end(b) { r.body += b || ''; r.ended = true; } };
  return r;
}
async function call(rd, { method = 'GET', url, who, headers = {}, body }) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  req.method = method; req.url = url; req.headers = { host: 'hub.example.ts.net', ...(who ? { 'x-who': who } : {}), ...headers }; req.socket = { remoteAddress: '127.0.0.1' };
  const res = mkRes();
  const handled = await rd.handle(req, res);
  return { handled, res, json: () => { try { return JSON.parse(res.body); } catch { return null; } } };
}
const open = (rd, who, nodeid = 'node//pc1') => call(rd, { method: 'POST', url: '/api/remote-desktop/open', who, body: { nodeid } });

// ── refusals ──────────────────────────────────────────────────────────────
test('every route refuses: no sign-in, a half-signed-in 2FA session, a token, the hub service, a member', async () => {
  const { rd, st } = rig();
  await open(rd, 'owner'); // a live session exists, so session routes are reachable by its owner only
  const routes = [
    { method: 'GET', url: '/api/remote-desktop' },
    { method: 'POST', url: '/api/remote-desktop/open', body: { nodeid: 'node//pc1' } },
    { method: 'POST', url: `/api/remote-desktop/${SID}/end` },
    { method: 'GET', url: `/remote-desktop/${SID}/` },
    { method: 'GET', url: `/remote-desktop/${SID}/scripts/common-0.0.1.js` },
  ];
  const before = st.calls.length;
  for (const r of routes) {
    const api = r.url.startsWith('/api/');
    const anon = await call(rd, r);
    assert.strictEqual(anon.handled, true);
    if (api) { assert.strictEqual(anon.res.code, 401, `anon ${r.url}`); assert.strictEqual(anon.json().error, 'unauthorized'); }
    else { assert.strictEqual(anon.res.code, 302); assert.match(anon.res.headers.Location, /^\/login\?next=/); }
    const pend = await call(rd, { ...r, who: 'pending' });
    if (api) { assert.strictEqual(pend.res.code, 401); assert.strictEqual(pend.json().error, 'totp_required'); } else assert.strictEqual(pend.res.code, 302);
    for (const who of ['token', 'service']) assert.strictEqual((await call(rd, { ...r, who })).res.code, 403, `${who} ${r.url}`);
    const mem = await call(rd, { ...r, who: 'ann' });
    assert.strictEqual(mem.res.code, 403, `member ${r.url}`);
  }
  assert.strictEqual(st.calls.length, before, 'no tool is called for a refused request');
  assert.strictEqual(st.mod.size, 1);
});

test('desktop_who "owner": another admin is refused everywhere, the list says allowed:false, the owner still passes', async () => {
  const { rd, st } = rig();
  st.settings.desktop_who = 'owner';
  const o = await open(rd, 'owner'); assert.strictEqual(o.res.code, 200);
  const sam = await open(rd, 'sam'); assert.strictEqual(sam.res.code, 403); assert.strictEqual(sam.json().error, 'owner_only');
  assert.strictEqual((await call(rd, { url: `/remote-desktop/${SID}/`, who: 'sam' })).res.code, 403);
  assert.strictEqual((await call(rd, { url: `/remote-desktop/${SID}/scripts/common-0.0.1.js`, who: 'sam' })).res.code, 403);
  assert.strictEqual((await call(rd, { method: 'POST', url: `/api/remote-desktop/${SID}/end`, who: 'sam' })).res.code, 403);
  const l = await call(rd, { url: '/api/remote-desktop', who: 'sam' });
  assert.deepStrictEqual(l.json(), { allowed: false, minutes: 30, computers: [] });
  assert.strictEqual((await call(rd, { url: `/remote-desktop/${SID}/`, who: 'owner' })).res.code, 200);
  st.settings.desktop_who = 'admins';
  assert.strictEqual((await open(rd, 'sam', 'node//pc2')).res.code, 200, 'with "admins" a second admin may');
});

test('an unknown, an expired and another person\'s session look the same: not found (page, script, end)', async () => {
  const { rd, st } = rig();
  await open(rd, 'owner');
  const mine = [`/remote-desktop/${SID}/`, `/remote-desktop/${SID}/scripts/common-0.0.1.js`];
  for (const u of mine) {
    assert.strictEqual((await call(rd, { url: u, who: 'sam' })).res.code, 404, `other person ${u}`);
    assert.strictEqual((await call(rd, { url: u.replace(SID, SID2), who: 'owner' })).res.code, 404, `unknown ${u}`);
    assert.strictEqual((await call(rd, { url: u.replace(SID, 'short'), who: 'owner' })).res.code, 404, `malformed ${u}`);
  }
  assert.strictEqual((await call(rd, { method: 'POST', url: `/api/remote-desktop/${SID}/end`, who: 'sam' })).res.code, 404);
  assert.strictEqual(st.mod.size, 1, 'the other person could not end it');
  st.now += 31 * MIN;   // past until, timer not fired yet
  assert.strictEqual((await call(rd, { url: `/remote-desktop/${SID}/`, who: 'owner' })).res.code, 404);
  assert.strictEqual(rd.sessions.size, 0, 'an expired session is cleaned up');
  assert.strictEqual(st.logs.length, 1);
  assert.match(st.logs[0], /\(time\)$/);
});

test('module disabled: every route answers 404, nothing is called; tailnet gate is respected', async () => {
  const { rd, st } = rig();
  st.enabled = false;
  for (const r of [{ url: '/api/remote-desktop' }, { method: 'POST', url: '/api/remote-desktop/open', body: { nodeid: 'node//pc1' } }, { url: `/remote-desktop/${SID}/` }, { method: 'POST', url: `/api/remote-desktop/${SID}/end` }]) {
    const x = await call(rd, { ...r, who: 'owner' });
    assert.strictEqual(x.handled, true); assert.strictEqual(x.res.code, 404, r.url);
  }
  assert.strictEqual(st.calls.length, 0);
  st.enabled = true; st.tailnet = false;
  assert.strictEqual((await call(rd, { url: '/api/remote-desktop', who: 'owner' })).res.code, 403);
  assert.strictEqual(st.calls.length, 0);
});

test('paths that are not the desktop\'s are not answered', async () => {
  const { rd } = rig();
  for (const u of ['/api/modules', '/remote-desktop.html', '/remote-desktop/', '/modules']) assert.strictEqual((await call(rd, { url: u, who: 'owner' })).handled, false, u);
  assert.strictEqual(rd.upgrade({ url: '/api/events', headers: {}, method: 'GET' }, {}, Buffer.alloc(0)), false);
});

// ── open / reuse / end / expiry ───────────────────────────────────────────
test('open, reuse, busy, end and expiry: one log line and one audit record per session', async () => {
  const { rd, st } = rig();
  const a = await open(rd, 'owner');
  assert.strictEqual(a.res.code, 200);
  assert.deepStrictEqual(a.json(), { url: `/remote-desktop/${SID}/`, session: SID, until: T0 + 30 * MIN });
  assert.deepStrictEqual(st.calls[0], { tool: 'desktop_open', args: { nodeid: 'node//pc1', who: { id: 'u1', name: 'Owner' }, minutes: 30 } });
  assert.strictEqual(st.timers.length, 1); assert.strictEqual(st.timers[0].ms, 30 * MIN);
  const again = await open(rd, 'owner');
  assert.strictEqual(again.json().session, SID);
  assert.strictEqual(st.calls.filter((c) => c.tool === 'desktop_open').length, 1, 'the same person gets the same session');
  const busy = await open(rd, 'sam');
  assert.strictEqual(busy.res.code, 409);
  assert.match(busy.json().error, /in use by Owner until/); assert.strictEqual(busy.json().busy.who.name, 'Owner');
  // list shows busy for both people
  const lo = (await call(rd, { url: '/api/remote-desktop', who: 'owner' })).json();
  assert.deepStrictEqual(lo.computers[0].busy, { who: 'Owner', until: T0 + 30 * MIN, mine: true, url: `/remote-desktop/${SID}/` });
  assert.strictEqual(lo.computers[1].busy, null);
  assert.strictEqual(lo.computers[1].online, false);
  const ls = (await call(rd, { url: '/api/remote-desktop', who: 'sam' })).json();
  assert.deepStrictEqual(ls.computers[0].busy, { who: 'Owner', until: T0 + 30 * MIN, mine: false });
  // End
  st.now = T0 + 5 * MIN;
  const e = await call(rd, { method: 'POST', url: `/api/remote-desktop/${SID}/end`, who: 'owner' });
  assert.deepStrictEqual(e.json(), { ok: true });
  assert.ok(st.calls.some((c) => c.tool === 'desktop_end' && c.args.session === SID && c.args.reason === 'ended'));
  assert.strictEqual(st.timers[0].live, false, 'the expiry timer is cancelled');
  assert.deepStrictEqual(st.logs, [`[remote-desktop] Owner (u1) PC One: 2026-11-15T14:00:00.000Z to 2026-11-15T14:05:00.000Z (ended)`]);
  assert.strictEqual(st.audits.length, 1);
  assert.strictEqual(st.audits[0].tool, 'desktop'); assert.strictEqual(st.audits[0].note, st.logs[0].replace('[remote-desktop] ', ''));
  assert.strictEqual(st.audits[0].ended_by, 'ended'); assert.deepStrictEqual(st.audits[0].who, { id: 'u1', name: 'Owner' });
  assert.strictEqual((await call(rd, { method: 'POST', url: `/api/remote-desktop/${SID}/end`, who: 'owner' })).res.code, 404, 'a second End finds nothing');
  assert.strictEqual(st.logs.length, 1); assert.strictEqual(st.audits.length, 1);
  // a new session on the freed computer expires by time
  const b = await open(rd, 'sam'); assert.strictEqual(b.json().session, SID2);
  const t = st.timers[st.timers.length - 1]; assert.strictEqual(t.ms, 30 * MIN);
  st.now = T0 + 5 * MIN + 30 * MIN;
  t.fn(); await new Promise((r) => setImmediate(r));
  assert.ok(st.calls.some((c) => c.tool === 'desktop_end' && c.args.session === SID2 && c.args.reason === 'time'));
  assert.strictEqual(st.logs.length, 2); assert.match(st.logs[1], /^\[remote-desktop\] Sam \(u2\) PC One: 2026-11-15T14:05:00\.000Z to 2026-11-15T14:35:00\.000Z \(time\)$/);
  assert.strictEqual(st.audits.length, 2); assert.strictEqual(rd.sessions.size, 0);
});

test('minutes come from desktop_minutes, clamped to 5..120', async () => {
  const { rd, st } = rig();
  st.settings.desktop_minutes = 500;
  await open(rd, 'owner');
  assert.strictEqual(st.calls[0].args.minutes, 120);
  const r2 = rig(); r2.st.settings.desktop_minutes = 'junk';
  await open(r2.rd, 'owner'); assert.strictEqual(r2.st.calls[0].args.minutes, 30);
});

test('a hub restart: the list ends module sessions the hub does not know (reason restart), with one log line', async () => {
  const { rd, st } = rig();
  st.mod.set('lost', { session: 'lost', nodeid: 'node//pc1', name: 'PC One', who: { id: 'u1', name: 'Owner' }, start: T0 - MIN, until: T0 + 20 * MIN });
  const l = (await call(rd, { url: '/api/remote-desktop', who: 'owner' })).json();
  assert.ok(st.calls.some((c) => c.tool === 'desktop_end' && c.args.reason === 'restart' && c.args.nodeid === 'node//pc1'));
  assert.strictEqual(l.computers[0].busy, null);
  assert.strictEqual(st.logs.length, 1); assert.match(st.logs[0], /^\[remote-desktop\] Owner \(u1\) PC One: .* \(restart\)$/);
  assert.strictEqual(st.audits.length, 1);
});

test('a list that arrives while an open is in flight never ends the session being opened', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { rd, st } = rig({ callTool: async (tool) => { if (tool === 'desktop_open') await gate; } });
  const opening = open(rd, 'owner');
  await new Promise((r) => setImmediate(r));
  // the module already holds the session (as it would mid-open); the hub does not know it yet
  st.mod.set('mid', { session: 'mid', nodeid: 'node//pc1', name: 'PC One', who: { id: 'u1', name: 'Owner' }, start: T0, until: T0 + 30 * MIN });
  await call(rd, { url: '/api/remote-desktop', who: 'owner' });
  assert.ok(!st.calls.some((c) => c.tool === 'desktop_end'), 'no desktop_end while the open is in flight');
  st.mod.delete('mid');
  release();
  assert.strictEqual((await opening).res.code, 200);
});

test('a tool reply that is not an object, or has an error, is a failure (never a crash, never a session)', async () => {
  for (const bad of ['The computer is asleep.', '', 'null', '"x"', JSON.stringify({ error: 'Not ready.' })]) {
    const { rd, st } = rig({ callTool: async (tool) => (tool === 'desktop_open' ? bad : undefined) });
    const r = await open(rd, 'owner');
    assert.strictEqual(r.res.code, 409, JSON.stringify(bad)); assert.ok(r.json().error);
    assert.strictEqual(rd.sessions.size, 0); assert.strictEqual(st.timers.length, 0);
  }
  const thrown = rig({ callTool: async (tool) => { if (tool === 'desktop_open') throw new Error('locked'); } });
  assert.strictEqual((await open(thrown.rd, 'owner')).res.code, 409);
  const noSession = rig({ callTool: async (tool) => (tool === 'desktop_open' ? JSON.stringify({ nodeid: 'x' }) : undefined) });
  assert.strictEqual((await open(noSession.rd, 'owner')).res.code, 409);
  const l = rig({ callTool: async (tool) => (tool === 'computers_status' ? 'nope' : undefined) });
  assert.strictEqual((await call(l.rd, { url: '/api/remote-desktop', who: 'owner' })).res.code, 409);
  const bodyBad = rig();
  assert.strictEqual((await call(bodyBad.rd, { method: 'POST', url: '/api/remote-desktop/open', who: 'owner', body: '{nope' })).res.code, 400);
  assert.strictEqual((await call(bodyBad.rd, { method: 'POST', url: '/api/remote-desktop/open', who: 'owner', body: { nodeid: 'a b' } })).res.code, 400);
});

// ── desktop_address ───────────────────────────────────────────────────────
test('desktop_address: an https origin is put before the path; anything else is treated as empty', async () => {
  for (const [addr, prefix] of [['https://hub.example.ts.net', 'https://hub.example.ts.net'], ['https://198.51.100.7:8443', 'https://198.51.100.7:8443'],
    ['http://hub.example.ts.net', ''], ['https://hub.example.ts.net/x', ''], ['https://hub.example.ts.net/', ''], ['hub.example.ts.net', ''], ['https://a b', ''], ['https://h:123456', ''], [42, ''], [null, '']]) {
    const { rd, st } = rig();
    st.settings.desktop_address = addr;
    const r = await open(rd, 'owner');
    assert.strictEqual(r.json().url, `${prefix}/remote-desktop/${SID}/`, String(addr));
    const l = (await call(rd, { url: '/api/remote-desktop', who: 'owner' })).json();
    assert.strictEqual(l.computers[0].busy.url, `${prefix}/remote-desktop/${SID}/`);
  }
});

// ── the page ──────────────────────────────────────────────────────────────
test('the page: boot JSON injected with every "<" escaped; a hostile computer name cannot close the script', async () => {
  const { rd, st } = rig({ callTool: async (tool, a, s) => {
    if (tool !== 'desktop_open') return undefined;
    return JSON.stringify({ session: SID, nodeid: a.nodeid, name: '</script><img src=x onerror=1>$&', start: s.now, until: s.now + 30 * MIN });
  } });
  await open(rd, 'owner');
  const p = await call(rd, { url: `/remote-desktop/${SID}/`, who: 'owner' });
  assert.strictEqual(p.res.code, 200); assert.match(p.res.headers['Content-Type'], /^text\/html/);
  assert.strictEqual(p.res.headers['Cache-Control'], 'no-store');
  const m = p.res.body.match(/<script type="application\/json" id="rd-boot">(.*?)<\/script>/s);
  assert.ok(m);
  assert.ok(!m[1].includes('<'), 'no raw < inside the boot JSON');
  assert.ok(m[1].includes('\\u003c/script>'));
  assert.deepStrictEqual(JSON.parse(m[1]), { session: SID, nodeid: 'node//pc1', name: '</script><img src=x onerror=1>$&', until: T0 + 30 * MIN, endUrl: `/api/remote-desktop/${SID}/end` });
  assert.ok(!p.res.body.includes('onerror=1>$&</script>') && !p.res.body.includes('<img'));
  assert.strictEqual(p.res.body.split('rd-boot').length, 2);
  st.page = '<html>no marker</html>';
  assert.strictEqual((await call(rd, { url: `/remote-desktop/${SID}/`, who: 'owner' })).res.code, 404);
  const bare = await call(rd, { url: `/remote-desktop/${SID}`, who: 'owner' });
  assert.strictEqual(bare.res.code, 301); assert.strictEqual(bare.res.headers.Location, `/remote-desktop/${SID}/`);
});

test('scripts: only the three names, proxied with the pinned CA, cached per name, text/javascript', async () => {
  const { rd, st } = rig();
  await open(rd, 'owner');
  assert.deepStrictEqual([...SCRIPTS].sort(), ['agent-desktop-0.0.2.js', 'agent-redir-ws-0.1.1.js', 'common-0.0.1.js']);
  for (const n of SCRIPTS) {
    const r = await call(rd, { url: `/remote-desktop/${SID}/scripts/${n}`, who: 'owner' });
    assert.strictEqual(r.res.code, 200); assert.strictEqual(r.res.headers['Content-Type'], 'text/javascript'); assert.strictEqual(r.res.body, 'console.log(1)');
  }
  assert.strictEqual(st.got.length, 3);
  assert.deepStrictEqual(st.got[0], { host: '127.0.0.1', port: 9971, path: '/scripts/common-0.0.1.js', ca: 'CA-PEM', servername: 'mesh.example', headers: { Host: 'mesh.example:9971' } });
  await call(rd, { url: `/remote-desktop/${SID}/scripts/common-0.0.1.js`, who: 'owner' });
  assert.strictEqual(st.got.length, 3, 'cached');
  const fresh = rig(); await open(fresh.rd, 'owner');
  for (const n of ['meshcentral.js', 'common-0.0.1.js.map', '..%2Fcommon-0.0.1.js', 'agent-desktop-0.0.1.js', '', 'Common-0.0.1.js']) {
    const r = await call(fresh.rd, { url: `/remote-desktop/${SID}/scripts/${n}`, who: 'owner' });
    assert.strictEqual(r.res.code, 404, n);
  }
  assert.strictEqual((await call(fresh.rd, { url: `/remote-desktop/${SID}/scripts/a/b.js`, who: 'owner' })).res.code, 404);
  assert.strictEqual(fresh.st.got.length, 0, 'nothing off the list is fetched');
  const down = rig({ deps: { httpsGet: async () => ({ status: 500, body: 'x' }) } }); await open(down.rd, 'owner');
  assert.strictEqual((await call(down.rd, { url: `/remote-desktop/${SID}/scripts/common-0.0.1.js`, who: 'owner' })).res.code, 404);
  const noEp = rig({ callTool: async (tool) => (tool === 'desktop_endpoint' ? 'no' : undefined) }); await open(noEp.rd, 'owner');
  assert.strictEqual((await call(noEp.rd, { url: `/remote-desktop/${SID}/scripts/common-0.0.1.js`, who: 'owner' })).res.code, 404);
});

// ── websocket relay ───────────────────────────────────────────────────────
function makeCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-cert-'));
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=mesh.example', '-addext', 'subjectAltName=DNS:mesh.example'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const out = { key: fs.readFileSync(path.join(dir, 'k.pem'), 'utf8'), cert: fs.readFileSync(path.join(dir, 'c.pem'), 'utf8') };
  for (const f of ['k.pem', 'c.pem']) fs.writeFileSync(path.join(dir, f), '');
  return out;
}
const CERT = makeCert();

/** A fake MeshCentral: answers the upgrade (101 or the given status) then echoes every byte upper-cased. */
function fakeMesh(status = 101) {
  const seen = { heads: [], data: [], conns: [] };
  const srv = tls.createServer({ key: CERT.key, cert: CERT.cert }, (c) => {
    seen.conns.push(c);
    let buf = Buffer.alloc(0), up = false;
    c.on('error', () => {});
    c.on('data', (d) => {
      if (up) { seen.data.push(d.toString()); c.write(d.toString().toUpperCase()); return; }
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf('\r\n\r\n'); if (i < 0) return;
      seen.heads.push(buf.subarray(0, i).toString());
      if (status === 101) { up = true; c.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: fakeaccept\r\n\r\nhello-from-mesh'); }
      else c.end(`HTTP/1.1 ${status} Nope\r\nContent-Length: 0\r\n\r\n`);
    });
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({ srv, seen, port: srv.address().port })));
}

async function relayRig(status, over = {}) {
  const mesh = await fakeMesh(status);
  const R = rig({ ...over });
  R.st.endpoint = { port: mesh.port, servername: 'mesh.example', ca: CERT.cert };
  const web = http.createServer((q, s) => { s.end('x'); });
  web.on('upgrade', (q, sock, head) => { if (!R.rd.upgrade(q, sock, head)) sock.destroy(); });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  const close = async () => { web.closeAllConnections?.(); web.close(); mesh.srv.close(); for (const c of mesh.seen.conns) c.destroy(); };
  return { ...R, mesh, web, port: web.address().port, close };
}
/** Raw client: sends an upgrade request and collects what comes back. */
function wsClient(port, { url, headers = {} }) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    const out = { sock, got: '', closed: false, onclose: null };
    const lines = [`GET ${url} HTTP/1.1`, `Host: hub.example.ts.net`, 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13'];
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
    sock.on('data', (d) => { out.got += d.toString(); });
    out.closedP = new Promise((r) => sock.on('close', () => { out.closed = true; r(); }));
    sock.on('error', () => {});
    sock.on('connect', () => { sock.write(lines.join('\r\n') + '\r\n\r\n'); resolve(out); });
  });
}
const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await new Promise((r) => setTimeout(r, 10)); } };
const SAME = { 'x-who': 'owner', origin: 'https://hub.example.ts.net', 'sec-fetch-site': 'same-origin' };

test('relay: after a 101 bytes flow both ways; no Cookie, Origin, auth or rauth reach MeshCentral; the head says exactly what the contract says', { skip: !CERT && 'openssl not available' }, async () => {
  const x = await relayRig(101);
  try {
    await open(x.rd, 'owner');
    const c = await wsClient(x.port, { url: `/remote-desktop/${SID}/meshrelay.ashx?id=tun12345&auth=EVIL&rauth=EVIL2&nodeid=other`, headers: { ...SAME, Cookie: 'hub_sid=SECRET', 'Sec-WebSocket-Extensions': 'permessage-deflate' } });
    await until(() => c.got.includes('hello-from-mesh'));
    assert.match(c.got, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
    assert.ok(c.got.includes('Sec-WebSocket-Accept: fakeaccept'));
    c.sock.write('ping-bytes');
    await until(() => c.got.includes('PING-BYTES'));
    assert.deepStrictEqual(x.mesh.seen.data.join(''), 'ping-bytes');
    const head = x.mesh.seen.heads[0];
    const [first, ...hdr] = head.split('\r\n');
    assert.strictEqual(first, 'GET /meshrelay.ashx?browser=1&p=2&nodeid=node%2F%2Fpc1&id=tun12345&auth=MESHAUTH HTTP/1.1');
    const names = hdr.map((l) => l.split(':')[0].toLowerCase()).sort();
    assert.deepStrictEqual(names, ['connection', 'host', 'sec-websocket-extensions', 'sec-websocket-key', 'sec-websocket-version', 'upgrade']);
    assert.ok(hdr.includes(`Host: mesh.example:${x.mesh.port}`));
    assert.ok(!/EVIL|SECRET|^cookie:|^origin:/im.test(head), head);
    assert.deepStrictEqual(x.st.calls.find((q) => q.tool === 'desktop_connect').args, { session: SID, tunnelid: 'tun12345' });
    c.sock.destroy();
    await until(() => x.mesh.seen.conns.every((q) => q.destroyed));
  } finally { await x.close(); }
});

test('relay: a reply that is not 101 gives the browser a 502 and closes both sides', { skip: !CERT && 'openssl not available' }, async () => {
  const x = await relayRig(403);
  try {
    await open(x.rd, 'owner');
    const c = await wsClient(x.port, { url: `/remote-desktop/${SID}/meshrelay.ashx?id=tun12345`, headers: SAME });
    await c.closedP;
    assert.match(c.got, /^HTTP\/1\.1 502 /);
    assert.strictEqual(x.rd.sessions.get(SID).sockets.size, 0);
  } finally { await x.close(); }
});

test('relay: End and the expiry time close the sockets (End: reason ended; time: reason time)', { skip: !CERT && 'openssl not available' }, async () => {
  const x = await relayRig(101);
  try {
    await open(x.rd, 'owner');
    const c = await wsClient(x.port, { url: `/remote-desktop/${SID}/meshrelay.ashx?id=tun12345`, headers: SAME });
    await until(() => c.got.includes('hello-from-mesh'));
    assert.ok(x.rd.sessions.get(SID).sockets.size >= 2);
    x.st.now = T0 + 30 * MIN;
    x.st.timers[0].fn();
    await c.closedP;
    await until(() => x.mesh.seen.conns.every((q) => q.destroyed));
    assert.ok(x.st.calls.some((q) => q.tool === 'desktop_end' && q.args.reason === 'time'));
    assert.strictEqual(x.st.logs.length, 1);
    // End button
    x.st.now = T0 + 31 * MIN;
    await open(x.rd, 'owner');
    const c2 = await wsClient(x.port, { url: `/remote-desktop/${SID2}/meshrelay.ashx?id=tun12345`, headers: SAME });
    await until(() => c2.got.includes('hello-from-mesh'));
    await call(x.rd, { method: 'POST', url: `/api/remote-desktop/${SID2}/end`, who: 'owner' });
    await c2.closedP;
    assert.ok(x.st.calls.some((q) => q.tool === 'desktop_end' && q.args.reason === 'ended'));
  } finally { await x.close(); }
});

test('upgrade refusals: bad or missing Origin, cross-site, every sign-in/role/session failure, module off, tool failures', async () => {
  const cases = [];
  const x = await relayRig(101, { callTool: async (tool, a, s) => { if (s.failTool === tool) return 'broken'; } });
  const hit = async (label, { who = 'owner', headers = {}, url = `/remote-desktop/${SID}/meshrelay.ashx?id=tun12345`, expect }) => {
    const h = { ...SAME, ...headers }; if (who) h['x-who'] = who; else delete h['x-who'];
    for (const k of Object.keys(h)) if (h[k] === null) delete h[k];
    const c = await wsClient(x.port, { url, headers: h });
    await c.closedP;
    assert.match(c.got, new RegExp(`^HTTP/1\\.1 ${expect} `), `${label}: ${c.got.split('\r\n')[0]}`);
    assert.strictEqual(x.mesh.seen.heads.length, 0, `${label}: nothing reached MeshCentral`);
    cases.push(label);
  };
  try {
    await open(x.rd, 'owner');
    await hit('foreign origin', { headers: { origin: 'https://evil.example' }, expect: 403 });
    await hit('http origin on another host', { headers: { origin: 'http://203.0.113.9' }, expect: 403 });
    await hit('no origin', { headers: { origin: null }, expect: 403 });
    await hit('cross-site', { headers: { 'sec-fetch-site': 'cross-site' }, expect: 403 });
    await hit('same-site', { headers: { 'sec-fetch-site': 'same-site' }, expect: 403 });
    await hit('no sign-in', { who: null, expect: 401 });
    await hit('pending 2FA', { who: 'pending', expect: 401 });
    await hit('token', { who: 'token', expect: 403 });
    await hit('service', { who: 'service', expect: 403 });
    await hit('member', { who: 'ann', expect: 403 });
    await hit('another person', { who: 'sam', expect: 404 });
    await hit('unknown session', { url: `/remote-desktop/${SID2}/meshrelay.ashx?id=tun12345`, expect: 404 });
    await hit('no tunnel id', { url: `/remote-desktop/${SID}/meshrelay.ashx`, expect: 400 });
    await hit('bad tunnel id', { url: `/remote-desktop/${SID}/meshrelay.ashx?id=a%0d%0ab`, expect: 400 });
    x.st.settings.desktop_who = 'owner';
    await hit('admin when owner only', { who: 'sam', expect: 403 });
    x.st.settings.desktop_who = 'admins';
    x.st.failTool = 'desktop_connect';
    await hit('desktop_connect fails', { expect: 502 });
    x.st.failTool = 'desktop_endpoint';
    await hit('desktop_endpoint fails', { expect: 502 });
    x.st.failTool = null;
    x.st.connectReply = { query: 'a b\r\nCookie: x' };
    await hit('connect query with spaces/newlines', { expect: 502 });
    x.st.connectReply = null;
    x.st.tailnet = false; await hit('tailnet', { expect: 403 }); x.st.tailnet = true;
    x.st.enabled = false; await hit('module off', { expect: 404 }); x.st.enabled = true;
    x.st.now = T0 + 31 * MIN;
    await hit('expired', { expect: 404 });
    assert.strictEqual(cases.length, 21);
  } finally { await x.close(); }
});

test('upgrade: the desktop_address origin is an accepted Origin; a valid address is the only other one', { skip: !CERT && 'openssl not available' }, async () => {
  const x = await relayRig(101);
  try {
    x.st.settings.desktop_address = 'https://desk.example.ts.net';
    await open(x.rd, 'owner');
    const c = await wsClient(x.port, { url: `/remote-desktop/${SID}/meshrelay.ashx?id=tun12345`, headers: { ...SAME, origin: 'https://desk.example.ts.net' } });
    await until(() => c.got.includes('hello-from-mesh'));
    c.sock.destroy();
    x.st.settings.desktop_address = 'http://desk.example.ts.net/x';   // invalid: treated as empty, so that origin is foreign again
    const d = await wsClient(x.port, { url: `/remote-desktop/${SID}/meshrelay.ashx?id=tun12345`, headers: { ...SAME, origin: 'http://desk.example.ts.net' } });
    await d.closedP; assert.match(d.got, /^HTTP\/1\.1 403 /);
  } finally { await x.close(); }
});

// ── wiring (text checks, as test/ui-modules.test.js) ──────────────────────
test('server.js wiring: lazy instance with the connector call, upgrade hook that closes every other socket, dispatch before the static files', () => {
  const s = read('server.js');
  assert.match(s, /function remoteDesktop\(\) \{\s*if \(!_remoteDesktop\)/);
  assert.match(s, /callTool\('remote-computers', tool, args, \{ hub: true, timeoutMs: 30000 \}\)/);
  assert.match(s, /parse: \(t\) => require\('\.\/lib\/modules'\)\.parseToolText\(t\)/);
  assert.match(s, /readPage: \(\) => fs\.readFileSync\(path\.join\(__dirname, 'remote-desktop\.html'\), 'utf8'\)/);
  assert.match(s, /server\.on\('upgrade', \(req, socket, head\) => \{[\s\S]*?remoteDesktop\(\)\.upgrade\(req, socket, head\)[\s\S]*?if \(!handled\) \{ try \{ socket\.destroy\(\)/);
  assert.ok(s.indexOf("server.on('upgrade'") > s.indexOf('const server = http.createServer') && s.indexOf("server.on('upgrade'") < s.indexOf('async function handleHttpRequest'));
  const at = s.indexOf("await remoteDesktop().handle(req, res)");
  assert.ok(at > s.indexOf("jsonResponse(res, 404, { error: 'unknown modules route' })") && at < s.indexOf('// ── Static Files'));
  assert.match(s, /pathname === '\/api\/remote-desktop' \|\| pathname\.startsWith\('\/api\/remote-desktop\/'\) \|\| pathname\.startsWith\('\/remote-desktop\/'\)/);
});

test('settings route: only the owner changes desktop_who and desktop_address (compared with the stored values)', () => {
  const s = read('server.js');
  assert.match(s, /id === 'remote-computers' && b\.values && typeof b\.values === 'object' && !\(req\.hubUser && !req\.hubService && !req\.hubToken && !req\.hubPendingTotp && hubAuth\.isOwner\(req\.hubUser\)\)/);
  assert.match(s, /for \(const k of \['desktop_who', 'desktop_address'\]\)/);
  assert.match(s, /Only the owner can change who may open a desktop and its address\./);
  assert.ok(s.indexOf('Only the owner can change who may open') < s.indexOf('mods.saveSettings(id, b.values || {})'));
});

test('access.js: the desktop pages are admin pages and nothing about it is in TOKEN_ROUTES; the service worker never touches the path', () => {
  const a = read('lib/access.js');
  assert.match(a, /\^\\\/remote-desktop\(\\\/\.\*\)\?\$/);
  assert.ok(!/remote-desktop/.test(a.slice(a.indexOf('const TOKEN_ROUTES'), a.indexOf('const AGENT_SCOPED'))));
  const sw = read('sw.js');
  assert.ok(!sw.includes('remote-desktop'));
  assert.match(sw, /if \(!RUNTIME\.includes\(url\.pathname\)\) return;/, 'only the listed shell files are intercepted');
});
