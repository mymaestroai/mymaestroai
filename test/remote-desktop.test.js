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

const sha = (s) => require('crypto').createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
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
    mod: new Map(), endpoint: { port: 9971, servername: 'mesh.example', ca: 'CA-PEM' }, got: [], page: PAGE, script: 'console.log(1)', connectReply: null, openReply: null,
    demoted: [], gone: [], repeats: [] };
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
    isAdmin: (u) => u.role === 'admin' && !st.demoted.includes(u.id), isOwner: (u) => u.id === 'u1',
    stillAdmin: (id) => !st.gone.includes(id),
    scriptHashes: Object.fromEntries(Array.from(SCRIPTS).map((n) => [n, sha('console.log(1)')])),
    setRepeat: (fn, ms) => { const t = { fn, ms }; st.repeats.push(t); return t; }, clearRepeat: () => {},
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
  assert.strictEqual(st.timers.length, 2); assert.strictEqual(st.timers[0].ms, 30 * MIN); assert.strictEqual(st.timers[1].ms, 2 * 60000, 'plus the never-loaded grace');
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
  const t = st.timers.filter((x) => x.ms === 30 * MIN).pop(); assert.ok(t && t.live);
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
  assert.ok(st.calls.some((c) => c.tool === 'desktop_end' && c.args.reason === 'restart' && c.args.nodeid === 'node//pc1' && c.args.start === T0 - MIN), 'ended by computer and start');
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
function fakeMesh(status = 101, extraHead = '') {
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
      if (status === 101) { up = true; c.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: fakeaccept\r\n' + extraHead + '\r\nhello-from-mesh'); }
      else c.end(`HTTP/1.1 ${status} Nope\r\nContent-Length: 0\r\n\r\n`);
    });
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({ srv, seen, port: srv.address().port })));
}

async function relayRig(status, over = {}, extraHead = '') {
  const mesh = await fakeMesh(status, extraHead);
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

// ── revocation, relay bound, script pins, 101 head, start-up cleanup ──────
test('sweep: ends a session when the module is off ("disabled"), when desktop_who became owner and the opener is not the owner, or the opener is no longer an admin ("revoked")', async () => {
  const cases = [
    ['module off', (st) => { st.enabled = false; }, 'disabled'],
    ['owner only now', (st) => { st.settings.desktop_who = 'owner'; }, 'revoked'],
    ['no longer an admin', (st) => { st.gone.push('u2'); }, 'revoked'],
  ];
  for (const [label, change, reason] of cases) {
    const { rd, st } = rig();
    await open(rd, 'sam');
    await rd.sweep();
    assert.strictEqual(rd.sessions.size, 1, `${label}: nothing changed, the session stays`);
    change(st);
    await rd.sweep();
    assert.strictEqual(rd.sessions.size, 0, label);
    assert.ok(st.calls.some((c) => c.tool === 'desktop_end' && c.args.session === SID && c.args.reason === reason), `${label}: desktop_end ${reason}`);
    assert.strictEqual(st.logs.length, 1, label); assert.match(st.logs[0], new RegExp(`\\(${reason}\\)$`));
    assert.strictEqual(st.audits.length, 1);
    assert.strictEqual(st.timers[0].live, false, 'the expiry timer is cancelled');
    await rd.sweep();
    assert.strictEqual(st.logs.length, 1, `${label}: a second sweep logs nothing more`);
  }
  // the owner's own session survives desktop_who "owner"
  const own = rig(); await open(own.rd, 'owner'); own.st.settings.desktop_who = 'owner'; await own.rd.sweep();
  assert.strictEqual(own.rd.sessions.size, 1);
  // a standing check that throws closes the session (unknown standing is not trusted)
  const thr = rig({ deps: { stillAdmin: () => { throw new Error('store'); } } }); await open(thr.rd, 'sam'); await thr.rd.sweep();
  assert.strictEqual(thr.rd.sessions.size, 0);
});

test('sweep: every revoked session is cut at once, even while the module is slow to answer desktop_end', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const { rd, st } = rig({ callTool: async (tool) => { if (tool === 'desktop_end') await held; } });
  await open(rd, 'sam', 'node//pc1');
  await open(rd, 'sam', 'node//pc2');
  assert.strictEqual(rd.sessions.size, 2);
  const cut = [];
  for (const [id, s] of rd.sessions) s.sockets.add({ destroy() { cut.push(id); } });
  st.settings.desktop_who = 'owner';
  const sweeping = rd.sweep();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(cut.length, 2, 'both desktops are cut before any desktop_end answers');
  assert.strictEqual(rd.sessions.size, 0);
  release();
  await sweeping;
  assert.strictEqual(st.calls.filter((c) => c.tool === 'desktop_end').length, 2);
});

test('sweep runs every 15 s on an injected timer', async () => {
  const { rd, st } = rig();
  assert.strictEqual(st.repeats.length, 1); assert.strictEqual(st.repeats[0].ms, 15000);
  await open(rd, 'sam');
  st.gone.push('u2');
  st.repeats[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(rd.sessions.size, 0);
  assert.strictEqual(typeof rd.close, 'function');
});

test('End works for the opener whose role no longer allows opening; nobody else, no token, no pending 2FA', async () => {
  const { rd, st } = rig();
  await open(rd, 'sam');
  st.demoted.push('u2');
  assert.strictEqual((await call(rd, { url: `/remote-desktop/${SID}/`, who: 'sam' })).res.code, 403, 'the page is no longer theirs');
  assert.strictEqual((await open(rd, 'sam', 'node//pc2')).res.code, 403, 'and neither is opening');
  assert.strictEqual((await call(rd, { method: 'POST', url: `/api/remote-desktop/${SID}/end`, who: 'ann' })).res.code, 403);
  assert.strictEqual((await call(rd, { method: 'POST', url: `/api/remote-desktop/${SID}/end`, who: 'token' })).res.code, 403);
  assert.strictEqual(rd.sessions.size, 1);
  const e = await call(rd, { method: 'POST', url: `/api/remote-desktop/${SID}/end`, who: 'sam' });
  assert.strictEqual(e.res.code, 200); assert.deepStrictEqual(e.json(), { ok: true });
  assert.strictEqual(rd.sessions.size, 0); assert.strictEqual(st.logs.length, 1); assert.match(st.logs[0], /\(ended\)$/);
});

test('relay: a change during the awaits (desktop_who owner, opener demoted, module off) refuses the upgrade; nothing reaches MeshCentral and the slot is freed', { skip: !CERT && 'openssl not available' }, async () => {
  for (const [tool, change] of [
    ['desktop_endpoint', (st) => { st.settings.desktop_who = 'owner'; }],
    ['desktop_connect', (st) => { st.settings.desktop_who = 'owner'; }],
    ['desktop_endpoint', (st) => { st.demoted.push('u2'); }],
    ['desktop_connect', (st) => { st.demoted.push('u2'); }],
    ['desktop_connect', (st) => { st.enabled = false; }],
  ]) {
    const x = await relayRig(101, { callTool: async (t, a, s) => { if (t === tool && s.armed) change(s); } });
    try {
      await open(x.rd, 'sam');
      x.st.armed = true;
      const c = await wsClient(x.port, { url: `/remote-desktop/${SID}/meshrelay.ashx?id=tun12345`, headers: { ...SAME, 'x-who': 'sam' } });
      await c.closedP;
      assert.match(c.got, /^HTTP\/1\.1 (403|404) /, `${tool}: ${c.got.split('\r\n')[0]}`);
      assert.ok(!c.got.includes('hello-from-mesh'));
      assert.strictEqual(x.mesh.seen.conns.length, 0, `${tool}: no connection to MeshCentral`);
      assert.strictEqual(x.rd.sessions.get(SID).relays, 0, 'the slot is freed');
    } finally { await x.close(); }
  }
});

test('relay: a session ended while desktop_connect is in flight is not served', { skip: !CERT && 'openssl not available' }, async () => {
  let rdRef = null;
  const x = await relayRig(101, { callTool: async (t) => { if (t === 'desktop_connect' && rdRef) await rdRef.sweep(); } });
  rdRef = x.rd;
  try {
    await open(x.rd, 'owner');
    x.st.gone.push('u1');
    const c = await wsClient(x.port, { url: `/remote-desktop/${SID}/meshrelay.ashx?id=tun12345`, headers: SAME });
    await c.closedP;
    assert.match(c.got, /^HTTP\/1\.1 404 /);
    assert.strictEqual(x.mesh.seen.conns.length, 0);
  } finally { await x.close(); }
});

test('relay: a sweep closes an established relay (opener no longer an admin)', { skip: !CERT && 'openssl not available' }, async () => {
  const x = await relayRig(101);
  try {
    await open(x.rd, 'sam');
    const c = await wsClient(x.port, { url: `/remote-desktop/${SID}/meshrelay.ashx?id=tun12345`, headers: { ...SAME, 'x-who': 'sam' } });
    await until(() => c.got.includes('hello-from-mesh'));
    x.st.gone.push('u2');
    await x.rd.sweep();
    await c.closedP;
    await until(() => x.mesh.seen.conns.every((q) => q.destroyed));
    assert.ok(x.st.calls.some((q) => q.tool === 'desktop_end' && q.args.reason === 'revoked'));
    assert.strictEqual(x.st.logs.length, 1);
  } finally { await x.close(); }
});

test('relay: at most 2 per session at once; the third gets 429 and nothing is asked of the module; every failure frees its slot', { skip: !CERT && 'openssl not available' }, async () => {
  const x = await relayRig(101, { callTool: async (tool, a, s) => { if (s.failTool === tool) return 'broken'; } });
  try {
    await open(x.rd, 'owner');
    const url = `/remote-desktop/${SID}/meshrelay.ashx?id=tun12345`;
    x.st.failTool = 'desktop_connect';
    for (let i = 0; i < 4; i++) { const f = await wsClient(x.port, { url, headers: SAME }); await f.closedP; assert.match(f.got, /^HTTP\/1\.1 502 /); }
    assert.strictEqual(x.rd.sessions.get(SID).relays, 0, 'failed relays free their slot');
    x.st.failTool = null;
    const a = await wsClient(x.port, { url, headers: SAME }); await until(() => a.got.includes('hello-from-mesh'));
    const b = await wsClient(x.port, { url, headers: SAME }); await until(() => b.got.includes('hello-from-mesh'));
    const before = x.st.calls.length;
    const third = await wsClient(x.port, { url, headers: SAME }); await third.closedP;
    assert.match(third.got, /^HTTP\/1\.1 429 /);
    assert.strictEqual(x.st.calls.length, before, 'nothing was sent to the module');
    assert.strictEqual(x.mesh.seen.heads.length, 2);
    a.sock.destroy();
    await until(() => x.rd.sessions.get(SID).relays === 1);
    const d = await wsClient(x.port, { url, headers: SAME }); await until(() => d.got.includes('hello-from-mesh'));
    b.sock.destroy(); d.sock.destroy();
  } finally { await x.close(); }
});

test('scripts: the three pins are MeshCentral 1.3.1\'s hashes; a script that differs is refused with 404 and one console line, never cached', async () => {
  const { SCRIPT_SHA256 } = require(path.join(ISO.lib, 'remote-desktop'));
  assert.deepStrictEqual(SCRIPT_SHA256, {
    'common-0.0.1.js': '4ccd0253f97129d855ece6f68a4629bc4767fe3af33d0b61eeac73f5402db013',
    'agent-redir-ws-0.1.1.js': '54911cffc1e7da5822e772339e79017c1265fa40413cac15134b23b7305a9d54',
    'agent-desktop-0.0.2.js': '5df980270ebf68a74dca6e2a352dea6ab97cd16c6867d71a30effe2b79038d20',
  });
  let body = 'alert("swapped")';
  const { rd, st } = rig({ deps: { httpsGet: async () => ({ status: 200, body }) } });
  await open(rd, 'owner');
  const url = `/remote-desktop/${SID}/scripts/common-0.0.1.js`;
  const bad = await call(rd, { url, who: 'owner' });
  assert.strictEqual(bad.res.code, 404); assert.ok(!bad.res.body.includes('swapped'));
  assert.strictEqual(st.logs.length, 1); assert.match(st.logs[0], /common-0\.0\.1\.js/);
  body = 'console.log(1)';
  const good = await call(rd, { url, who: 'owner' });
  assert.strictEqual(good.res.code, 200, 'the mismatch was never cached');
  // with the real pins, a stand-in body is refused
  const real = rig({ deps: { scriptHashes: undefined } });
  await open(real.rd, 'owner');
  assert.strictEqual((await call(real.rd, { url, who: 'owner' })).res.code, 404);
});

test('relay: MeshCentral\'s 101 head is rebuilt: only Upgrade, Connection, Sec-WebSocket-Accept/Extensions/Protocol reach the browser (no Set-Cookie)', { skip: !CERT && 'openssl not available' }, async () => {
  const x = await relayRig(101, {}, 'Set-Cookie: meshauth=UPSTREAMSECRET; Path=/\r\nX-Leak: 1\r\nSec-WebSocket-Protocol: p1\r\nSec-WebSocket-Extensions: permessage-deflate\r\n');
  try {
    await open(x.rd, 'owner');
    const c = await wsClient(x.port, { url: `/remote-desktop/${SID}/meshrelay.ashx?id=tun12345`, headers: SAME });
    await until(() => c.got.includes('hello-from-mesh'));
    const [head, rest] = c.got.split('\r\n\r\n');
    const lines = head.split('\r\n');
    assert.strictEqual(lines[0], 'HTTP/1.1 101 Switching Protocols');
    assert.deepStrictEqual(lines.slice(1).map((l) => l.split(':')[0].toLowerCase()).sort(), ['connection', 'sec-websocket-accept', 'sec-websocket-extensions', 'sec-websocket-protocol', 'upgrade']);
    assert.ok(!/set-cookie|UPSTREAMSECRET|x-leak/i.test(c.got));
    assert.ok(lines.includes('Sec-WebSocket-Accept: fakeaccept'));
    assert.strictEqual(rest, 'hello-from-mesh');
    c.sock.destroy();
  } finally { await x.close(); }
});

test('reconcile: ends module sessions the hub does not know (by computer and start, reason restart); keeps the hub\'s own; does nothing when off; never throws', async () => {
  const { rd, st } = rig();
  st.mod.set('lost', { session: 'lost', nodeid: 'node//pc2', name: 'PC Two', who: { id: 'u1', name: 'Owner' }, start: T0 - MIN, until: T0 + 20 * MIN });
  await open(rd, 'owner');   // the hub's own session on pc1
  await rd.reconcile();
  const ends = st.calls.filter((c) => c.tool === 'desktop_end');
  assert.deepStrictEqual(ends.map((c) => c.args), [{ nodeid: 'node//pc2', start: T0 - MIN, reason: 'restart' }]);
  assert.ok(st.mod.has(SID), 'the hub\'s own session is untouched');
  assert.strictEqual(st.logs.length, 1); assert.match(st.logs[0], /\(restart\)$/);
  const off = rig(); off.st.enabled = false; off.st.mod.set('lost', { session: 'lost', nodeid: 'node//pc2', name: 'PC Two', who: { id: 'u1', name: 'Owner' }, start: T0, until: T0 + MIN });
  await off.rd.reconcile(); assert.strictEqual(off.st.calls.length, 0);
  const broken = rig({ callTool: async () => { throw new Error('down'); } });
  await broken.rd.reconcile();
  const junk = rig({ callTool: async () => 'nope' });
  await junk.rd.reconcile();
});

// ── wiring (text checks, as test/ui-modules.test.js) ──────────────────────
test('server.js wiring: stillAdmin reads the current account; sweeps after settings and enable/disable; one start-up reconcile 30 s after listening', () => {
  const s = read('server.js');
  assert.match(s, /stillAdmin: \(userId\) => \{[\s\S]*?hubAuth\.getUser\(String\(userId\)\)[\s\S]*?!u\.disabled && access\.isAdmin\(u\)/);
  assert.match(s, /function sweepRemoteDesktop\(moduleId\) \{\s*if \(moduleId !== 'remote-computers' \|\| !_remoteDesktop\) return;/);
  assert.match(s, /const saved = mods\.saveSettings\(id, b\.values \|\| \{\}\);\s*sweepRemoteDesktop\(id\);/);
  assert.match(s, /const changed = mods\.setEnabled\(id, act === 'enable'\);\s*sweepRemoteDesktop\(id\);/);
  const at = s.indexOf('server.listen(PORT, HOST, () => {');
  const rec = s.indexOf('remoteDesktop().reconcile()');
  assert.ok(at > 0 && rec > at, 'inside the listen callback');
  assert.match(s.slice(rec, rec + 200), /\}, 30000\)\.unref\(\);/);
});

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

// ── leaving without End: the grace (real relay sockets against the fake upstream, fake timers; the grace timers are 60000 ms and the never-loaded one 120000 ms) ──
const graceTimers = (st, ms) => st.timers.filter((t) => t.live && t.ms === ms);
const ended = (st, reason) => st.calls.filter((q) => q.tool === 'desktop_end' && q.args.reason === reason);
const RELAY_URL = `/remote-desktop/${SID}/meshrelay.ashx?id=tun12345`;
const connected = async (x) => { const c = await wsClient(x.port, { url: RELAY_URL, headers: SAME }); await until(() => c.got.includes('hello-from-mesh')); return c; };

test('grace: the last relay closing and no reconnect for 60 s ends the session as "left" (one log line, one audit record, desktop_end, lock freed)', { skip: !CERT && 'openssl not available' }, async () => {
  const x = await relayRig(101);
  try {
    await open(x.rd, 'owner');
    const c = await connected(x);
    assert.strictEqual(graceTimers(x.st, 60000).length, 0, 'no grace while a relay is up');
    assert.strictEqual(graceTimers(x.st, 120000).length, 0, 'the never-loaded grace is cleared once a relay came');
    c.sock.destroy();
    await until(() => graceTimers(x.st, 60000).length === 1);
    assert.strictEqual(x.rd.sessions.size, 1, 'still open during the grace');
    assert.strictEqual(ended(x.st, 'left').length, 0);
    x.st.now = T0 + MIN;
    const fired = graceTimers(x.st, 60000)[0];
    fired.fn(); fired.live = false;   // a timer that has fired is no longer pending
    await until(() => ended(x.st, 'left').length === 1);
    assert.strictEqual(x.rd.sessions.size, 0);
    assert.strictEqual(x.st.mod.size, 0, 'the module lock is freed');
    assert.strictEqual(x.st.logs.length, 1); assert.match(x.st.logs[0], /\(left\)$/);
    assert.strictEqual(x.st.audits.length, 1); assert.strictEqual(x.st.audits[0].ended_by, 'left');
    assert.strictEqual(x.st.timers[0].live, false, 'the expiry timer is cancelled');
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(x.st.logs.length, 1, 'closing sockets after finish arms nothing and logs nothing more');
    assert.deepStrictEqual(x.st.timers.filter((t) => t.live).map((t) => t.ms), []);
  } finally { await x.close(); }
});

test('grace: a reconnect within the grace keeps the session (no desktop_end, no log); the old timer is cleared', { skip: !CERT && 'openssl not available' }, async () => {
  const x = await relayRig(101);
  try {
    await open(x.rd, 'owner');
    const a = await connected(x);
    a.sock.destroy();
    await until(() => graceTimers(x.st, 60000).length === 1);
    const old = graceTimers(x.st, 60000)[0];
    const b = await connected(x);
    assert.strictEqual(old.live, false, 'the reconnect clears the grace');
    old.fn();   // even a timer that slipped through does nothing while a relay is up
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(x.rd.sessions.size, 1);
    assert.strictEqual(ended(x.st, 'left').length, 0); assert.strictEqual(x.st.logs.length, 0);
    assert.strictEqual(graceTimers(x.st, 60000).length, 0);
    b.sock.destroy();
    await until(() => graceTimers(x.st, 60000).length === 1);
    assert.strictEqual(graceTimers(x.st, 60000).length, 1, 'never two grace timers for one session');
  } finally { await x.close(); }
});

test('grace: with two relays up, one closing arms nothing; the second closing arms exactly one', { skip: !CERT && 'openssl not available' }, async () => {
  const x = await relayRig(101);
  try {
    await open(x.rd, 'owner');
    const a = await connected(x); const b = await connected(x);
    a.sock.destroy();
    await until(() => x.rd.sessions.get(SID).relays === 1);
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(graceTimers(x.st, 60000).length, 0);
    b.sock.destroy();
    await until(() => graceTimers(x.st, 60000).length === 1);
    assert.strictEqual(x.st.timers.filter((t) => t.ms === 60000).length, 1);
  } finally { await x.close(); }
});

test('grace: a relay that fails (not 101) leaves the session in the grace, not forever', { skip: !CERT && 'openssl not available' }, async () => {
  const x = await relayRig(403);
  try {
    await open(x.rd, 'owner');
    const c = await wsClient(x.port, { url: RELAY_URL, headers: SAME }); await c.closedP;
    await until(() => graceTimers(x.st, 60000).length === 1);
    x.st.now = T0 + MIN;
    graceTimers(x.st, 60000)[0].fn();
    await until(() => ended(x.st, 'left').length === 1);
  } finally { await x.close(); }
});

test('grace: a session no relay ever reaches ends as "left" after 2 x the grace', async () => {
  const { rd, st } = rig();
  await open(rd, 'owner');
  assert.deepStrictEqual(st.timers.map((t) => t.ms), [30 * MIN, 120000]);
  st.now = T0 + 2 * MIN;
  st.timers[1].fn(); await new Promise((r) => setImmediate(r));
  assert.strictEqual(ended(st, 'left').length, 1); assert.strictEqual(rd.sessions.size, 0); assert.strictEqual(st.mod.size, 0);
  assert.strictEqual(st.logs.length, 1); assert.match(st.logs[0], /\(left\)$/);
  assert.strictEqual(st.audits[0].ended_by, 'left');
  assert.strictEqual(st.timers[0].live, false, 'the expiry timer is cancelled');
});

test('grace: leaveGraceMs is injectable', async () => {
  const { rd, st } = rig({ deps: { leaveGraceMs: 5000 } });
  await open(rd, 'owner');
  assert.deepStrictEqual(st.timers.map((t) => t.ms), [30 * MIN, 10000]);
  assert.ok(rd);
});

test('grace: End, the 30-minute time and a revoke each clear it; a stale grace timer never logs a second line', async () => {
  for (const how of ['ended', 'time', 'revoked']) {
    const { rd, st } = rig();
    await open(rd, 'owner');
    const g = st.timers[1];
    assert.strictEqual(g.live, true);
    if (how === 'ended') await call(rd, { method: 'POST', url: `/api/remote-desktop/${SID}/end`, who: 'owner' });
    else if (how === 'time') { st.now = T0 + 30 * MIN; st.timers[0].fn(); await new Promise((r) => setImmediate(r)); }
    else { st.gone.push('u1'); await rd.sweep(); }
    assert.strictEqual(g.live, false, `${how}: grace cleared`);
    assert.strictEqual(ended(st, how).length, 1, how);
    g.fn(); await new Promise((r) => setImmediate(r));
    assert.strictEqual(st.logs.length, 1, `${how}: still one log line`);
    assert.match(st.logs[0], new RegExp(`\\(${how}\\)$`));
    assert.strictEqual(st.audits.length, 1);
  }
});

test('grace: the 30-minute expiry still ends a session that keeps its relay with reason "time"', { skip: !CERT && 'openssl not available' }, async () => {
  const x = await relayRig(101);
  try {
    await open(x.rd, 'owner');
    const c = await connected(x);
    x.st.now = T0 + 30 * MIN;
    x.st.timers[0].fn();
    await c.closedP;
    await until(() => ended(x.st, 'time').length === 1);
    assert.strictEqual(ended(x.st, 'left').length, 0);
    assert.strictEqual(x.st.logs.length, 1); assert.match(x.st.logs[0], /\(time\)$/);
  } finally { await x.close(); }
});
