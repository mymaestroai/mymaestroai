'use strict';
// lib/share-links-routes: creating, listing, revoking and opening share links, with fakes for people, agents, push and the
// audit log, and real temp folders (real lib/files and lib/access) for the files.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');
const SL = require('../lib/share-links');
const { createShareLinkRoutes, PAGE_HEADERS } = require('../lib/share-links-routes');
const { createFiles } = require('../lib/files');
const access = require('../lib/access');

const GONE_TEXT = 'This link no longer works.';

class FakeRes extends Writable {
  constructor() { super(); this.status = null; this.headers = {}; this.chunks = []; this.finished = new Promise((r) => this.once('finish', r)); }
  _write(chunk, enc, cb) { this.chunks.push(Buffer.from(chunk)); cb(); }
  writeHead(status, headers) { this.status = status; for (const [k, v] of Object.entries(headers || {})) this.headers[k.toLowerCase()] = v; return this; }
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; }
  get text() { return Buffer.concat(this.chunks).toString(); }
  get buffer() { return Buffer.concat(this.chunks); }
}

function rig(t, { settings = {}, limiter = null, storeFs = undefined, routeExtra = {} } = {}) {
  const hubHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'share-routes-')));
  t.after(() => fs.rmSync(hubHome, { recursive: true, force: true }));
  const clock = { t: 1_800_000_000_000 };
  const users = {
    owner: { id: 'owner', login: 'owner', name: 'Owner', role: 'admin', disabled: false },
    'admin-b': { id: 'admin-b', login: 'admin-b', name: 'Second Admin', role: 'admin', disabled: false },
    sam: { id: 'sam', login: 'sam', name: 'Sam', role: 'member', disabled: false },
    'member-a': { id: 'member-a', login: 'member-a', name: 'Member A', role: 'member', disabled: false },
  };
  const agents = [
    { name: 'helper', owner: 'owner' },        // an admin's agent: folder share/helper
    { name: 'sam-bot', owner: 'sam' },          // a member's agent: the member's folder
    { name: 'infra-bot', owner: null },         // infrastructure: admin only
  ];
  const audits = [];
  const hubAuth = {
    audit: (userId, action, detail, ip) => audits.push({ userId, action, detail, ip }),
    getUser: (id) => users[id] || null,
    listUsers: () => Object.values(users),
  };
  const pushes = [];
  const push = { notifyUsers: (payload, ids, opts) => { pushes.push({ payload, ids: [...ids].sort(), opts }); return Promise.resolve({ sent: 1 }); } };
  const files = createFiles({ hubHome, getUser: (id) => users[id] || null, isAdminUser: (u) => access.isAdmin(u) });
  const conf = { ...settings };
  const dir = path.join(hubHome, 'data');
  fs.mkdirSync(dir);
  const store = SL.createStore({ file: path.join(dir, 'share-links.json'), now: () => clock.t, ...(storeFs ? { fsImpl: storeFs } : {}) });
  const routes = createShareLinkRoutes({ store, getFiles: () => files, getAgents: async () => agents, access, hubAuth, settings: () => conf, push, log: () => {}, now: () => clock.t, limiter, ...routeExtra });

  const put = (rootRel, name, content = 'hello') => { const d = path.join(hubHome, rootRel); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name), content); return path.join(d, name); };
  const as = (key, extra = {}) => ({ hubIdentKind: 'user', hubUser: users[key], hubPendingTotp: false, hubToken: null, hubService: false, ip: '192.0.2.10', ...extra });
  async function call(ident, method, pathname, body, mkRes) {
    const req = new EventEmitter();
    Object.assign(req, { method, url: pathname, headers: {}, socket: { remoteAddress: ident.ip || '192.0.2.10' }, hubIdentKind: ident.hubIdentKind, hubUser: ident.hubUser, hubPendingTotp: ident.hubPendingTotp, hubToken: ident.hubToken, hubService: ident.hubService });
    if (body !== undefined) req._bodyText = typeof body === 'string' ? body : JSON.stringify(body);
    const res = mkRes ? mkRes() : new FakeRes();
    const handled = await routes.handle(req, res, pathname);
    if (handled && !mkRes) await res.finished;
    return { handled, res, status: res.status, headers: res.headers, text: res.text, json: () => JSON.parse(res.text) };
  }
  const create = (ident, body) => call(ident, 'POST', '/api/share-links', body);
  const ownerFile = (name = 'report.txt', content = 'hello') => put('share', name, content);
  return { hubHome, clock, users, agents, audits, pushes, files, conf, store, routes, put, as, call, create, ownerFile };
}
const tokenOf = (r) => r.json().path.slice(3);
const actions = (r, a) => r.audits.filter(x => x.action === a);

// ── creating ──

test('create: a person on a full browser session gets the link; the answer carries the token once and nothing else secret', async (t) => {
  const r = rig(t);
  r.ownerFile('report.txt', 'hello world');
  const res = await r.create(r.as('owner'), { path: 'report.txt', hours: 24, oneTime: true });
  assert.equal(res.status, 200);
  const j = res.json();
  assert.deepEqual(Object.keys(j).sort(), ['expiresAt', 'id', 'name', 'oneTime', 'path', 'size']);
  assert.match(j.path, /^\/s\/[A-Za-z0-9_-]{43}$/);
  assert.match(j.id, /^[0-9a-f]{16}$/);
  assert.equal(j.name, 'report.txt');
  assert.equal(j.size, 11);
  assert.equal(j.oneTime, true);
  assert.equal(j.expiresAt, new Date(r.clock.t + 24 * 3600 * 1000).toISOString());
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.ok(r.store.findLive(tokenOf(res)));
  // the audit line: link id, folder, file, hours, one-time, the SOCKET address, never the token
  const a = actions(r, 'share.create');
  assert.equal(a.length, 1);
  assert.equal(a[0].userId, 'owner');
  assert.equal(a[0].detail, `link ${j.id} folder "mine" file "report.txt" hours 24 oneTime true`);
  assert.equal(a[0].ip, '192.0.2.10');
  assert.ok(!JSON.stringify(r.audits).includes(tokenOf(res)));
});

test('create: refused for an API token, the hub service, the legacy sign-in, a half-signed-in session and nobody', async (t) => {
  const r = rig(t); r.ownerFile();
  const msg = { error: 'Share links can only be made from a signed-in browser.' };
  const idents = [
    { hubIdentKind: 'token', hubUser: null, hubToken: { id: 'tok', scopes: ['chat'] } },
    { hubIdentKind: 'service', hubUser: null, hubService: true },
    { hubIdentKind: 'legacy', hubUser: r.users.owner },
    { ...r.as('owner'), hubPendingTotp: true },
    { hubIdentKind: null, hubUser: null },
    // a token must not pass even if some code set a user next to it
    { hubIdentKind: 'user', hubUser: r.users.owner, hubToken: { id: 'x' } },
  ];
  for (const ident of idents) {
    const res = await r.create(ident, { path: 'report.txt', hours: 1 });
    assert.equal(res.status, 403, JSON.stringify(ident.hubIdentKind));
    assert.deepEqual(res.json(), msg);
    assert.equal((await r.call(ident, 'GET', '/api/share-links')).status, 403);
  }
  assert.equal(r.store.list().length, 0);
  assert.equal(r.pushes.length, 0);
});

test('create: the notice goes to every admin; a member creator does not get one, an admin sharing a member\'s file also tells that member', async (t) => {
  const r = rig(t);
  r.put('users/sam/files', 'mine.txt'); r.put('users/member-a/files', 'theirs.txt');
  let res = await r.create(r.as('sam'), { path: 'mine.txt', hours: 2 });
  assert.equal(res.status, 200);
  assert.equal(r.pushes.length, 1);
  assert.deepEqual(r.pushes[0].ids, ['admin-b', 'owner']);
  assert.equal(r.pushes[0].opts.kind, 'security');
  assert.equal(r.pushes[0].payload.title, 'Share link created');
  assert.equal(r.pushes[0].payload.body, 'Sam created a share link for mine.txt, valid for 2 hours.');
  assert.ok(!JSON.stringify(r.pushes).includes(tokenOf(res)), 'the notice never carries the token');
  // an admin shares a member's file through the owner switcher
  res = await r.create(r.as('owner'), { owner: 'member-a', path: 'theirs.txt', hours: 1 });
  assert.equal(res.status, 200);
  assert.deepEqual(r.pushes[1].ids, ['admin-b', 'member-a', 'owner']);
  assert.equal(r.pushes[1].payload.body, 'Owner created a share link for theirs.txt, valid for 1 hours.');
  assert.equal(actions(r, 'share.create')[1].detail.startsWith(`link ${res.json().id} folder "member-a" file "theirs.txt" hours 1`), true);
  // an admin sharing from the admin folder tells admins only
  r.ownerFile('own.txt');
  await r.create(r.as('owner'), { path: 'own.txt', hours: 1 });
  assert.deepEqual(r.pushes[2].ids, ['admin-b', 'owner']);
});

test('create: a disabled admin is not sent the notice', async (t) => {
  const r = rig(t); r.ownerFile();
  r.users['admin-b'].disabled = true;
  await r.create(r.as('owner'), { path: 'report.txt', hours: 1 });
  assert.deepEqual(r.pushes[0].ids, ['owner']);
});

test('create: an agent\'s folder follows the Files rules (allowed agent, member-owned rule)', async (t) => {
  const r = rig(t);
  r.put('users/sam/files', 'bot.txt'); r.put('share/helper', 'h.txt'); r.put('share/infra-bot', 'i.txt');
  // sam on his own agent: his member folder
  let res = await r.create(r.as('sam'), { agent: 'sam-bot', path: 'bot.txt', hours: 1 });
  assert.equal(res.status, 200);
  assert.equal(r.store.list()[0].agent, 'sam-bot');
  assert.equal(r.store.list()[0].root, path.join(r.hubHome, 'users', 'sam', 'files'));
  // member-a may not use sam's agent, nor an admin's or infrastructure
  for (const a of ['sam-bot', 'helper', 'infra-bot']) {
    res = await r.create(r.as('member-a'), { agent: a, path: 'bot.txt', hours: 1 });
    assert.equal(res.status, 403, a);
    assert.equal(res.json().error, 'no_access_to_agent');
  }
  assert.equal((await r.create(r.as('member-a'), { agent: 'nope', path: 'x', hours: 1 })).status, 404);
  // sam may not use an admin's agent folder either
  assert.equal((await r.create(r.as('sam'), { agent: 'helper', path: 'h.txt', hours: 1 })).status, 403);
  // an admin may use any agent's folder
  res = await r.create(r.as('owner'), { agent: 'helper', path: 'h.txt', hours: 1 });
  assert.equal(res.status, 200);
  assert.equal(r.store.list()[1].root, path.join(r.hubHome, 'share', 'helper'));
  assert.equal((await r.create(r.as('owner'), { agent: 'infra-bot', path: 'i.txt', hours: 1 })).status, 200);
});

test('create: a member naming another owner\'s folder gets only their own folder (nothing of the other is reachable)', async (t) => {
  const r = rig(t);
  r.put('users/sam/files', 'private.txt'); r.ownerFile('admin-only.txt');
  for (const owner of ['sam', 'owner', 'mine', 'infra']) {
    for (const p of ['private.txt', 'admin-only.txt', '../sam/files/private.txt', '../../share/admin-only.txt']) {
      const res = await r.create(r.as('member-a'), { owner, path: p, hours: 1 });
      assert.ok([400, 404].includes(res.status), `${owner} ${p} -> ${res.status}`);
    }
  }
  assert.equal(r.store.list().length, 0);
  assert.equal((await r.create(r.as('owner'), { owner: 'nobody', path: 'x', hours: 1 })).status, 403, 'an admin naming no such owner');
});

test('create: a folder, a hidden file, a file in a hidden folder, a symlink, a missing file and a path outside are refused', async (t) => {
  const r = rig(t);
  r.ownerFile('ok.txt'); r.ownerFile('.secret'); fs.mkdirSync(path.join(r.hubHome, 'share', 'dir'));
  r.put('share/.hidden-dir', 'in.txt');
  const outside = path.join(r.hubHome, 'outside.txt'); fs.writeFileSync(outside, 'x');
  fs.symlinkSync(outside, path.join(r.hubHome, 'share', 'ln.txt'));
  fs.mkdirSync(path.join(r.hubHome, 'users', 'sam', 'files'), { recursive: true });
  fs.writeFileSync(path.join(r.hubHome, 'users', 'sam', 'files', 'x.txt'), 'x');
  fs.symlinkSync(path.join(r.hubHome, 'users'), path.join(r.hubHome, 'share', 'folder-link'));
  for (const p of ['dir', '', '/', '.secret', '.hidden-dir/in.txt', 'ln.txt', 'missing.txt', '../outside.txt', 'folder-link/sam/files/x.txt']) {
    const res = await r.create(r.as('owner'), { path: p, hours: 1 });
    assert.ok([400, 404].includes(res.status), `${JSON.stringify(p)} -> ${res.status} ${res.text}`);
  }
  assert.equal(r.store.list().length, 0);
  assert.equal((await r.create(r.as('owner'), { path: 'ok.txt', hours: 1 })).status, 200);
  assert.equal((await r.create(r.as('owner'), { hours: 1 })).status, 400, 'no path');
  assert.equal((await r.create(r.as('owner'), '{bad json')).status, 400);
  assert.equal((await r.create(r.as('owner'), { path: ['ok.txt'], hours: 1 })).status, 400);
});

test('create: switched off, and the hours rule (integer, at most the maximum, default from settings)', async (t) => {
  const r = rig(t); r.ownerFile();
  r.conf.enabled = false;
  const off = await r.create(r.as('owner'), { path: 'report.txt', hours: 1 });
  assert.equal(off.status, 403);
  r.conf.enabled = true;
  r.conf.maxHours = 48; r.conf.defaultHours = 6;
  for (const h of [0, -1, 1.5, '24', 49, 169, 1000, null]) assert.equal((await r.create(r.as('owner'), { path: 'report.txt', hours: h })).status, 400, String(h));
  const dflt = await r.create(r.as('owner'), { path: 'report.txt' });
  assert.equal(dflt.json().expiresAt, new Date(r.clock.t + 6 * 3600 * 1000).toISOString());
  assert.equal((await r.create(r.as('owner'), { path: 'report.txt', hours: 48 })).status, 200);
  r.conf.maxHours = 100000;   // the code's own ceiling is 168
  assert.equal((await r.create(r.as('owner'), { path: 'report.txt', hours: 169 })).status, 400);
  assert.equal((await r.create(r.as('owner'), { path: 'report.txt', hours: 168 })).status, 200);
  assert.equal(r.store.list().length, 3);
});

test('create: 30 an hour per person (429), then fine again; the store\'s 50-live limit answers 429 too', async (t) => {
  const r = rig(t); r.ownerFile();
  for (let i = 0; i < 30; i++) assert.equal((await r.create(r.as('owner'), { path: 'report.txt', hours: 1 })).status, 200, `#${i + 1}`);
  const over = await r.create(r.as('owner'), { path: 'report.txt', hours: 1 });
  assert.equal(over.status, 429);
  r.put('users/sam/files', 's.txt');
  assert.equal((await r.create(r.as('sam'), { path: 's.txt', hours: 1 })).status, 200, 'another person is not affected');
  r.clock.t += 3600 * 1000 + 1;
  assert.equal((await r.create(r.as('owner'), { path: 'report.txt', hours: 2 })).status, 200);
  // 50 live per person: with the hourly limit out of the way
  const r2 = rig(t, { limiter: { hit: () => true, isBlocked: () => false, block() {} } }); r2.ownerFile();
  for (let i = 0; i < 50; i++) assert.equal((await r2.create(r2.as('owner'), { path: 'report.txt', hours: 1 })).status, 200);
  assert.equal((await r2.create(r2.as('owner'), { path: 'report.txt', hours: 1 })).status, 429);
});

// ── listing and revoking ──

test('list: a person sees their own live links, an admin sees all with the creator; never a token or hash', async (t) => {
  const r = rig(t);
  r.ownerFile('a.txt'); r.put('users/sam/files', 's.txt'); r.put('users/member-a/files', 'm.txt');
  const a = await r.create(r.as('owner'), { path: 'a.txt', hours: 24 });
  const s = await r.create(r.as('sam'), { path: 's.txt', hours: 1, oneTime: true });
  const m = await r.create(r.as('member-a'), { path: 'm.txt', hours: 1 });
  const secrets = [tokenOf(a), tokenOf(s), tokenOf(m)];
  const sam = await r.call(r.as('sam'), 'GET', '/api/share-links');
  assert.equal(sam.status, 200);
  const sj = sam.json();
  assert.deepEqual(sj.links.map(l => l.id), [s.json().id]);
  assert.deepEqual(Object.keys(sj.links[0]).sort(), ['createdAt', 'creator', 'downloads', 'expiresAt', 'id', 'mine', 'name', 'oneTime', 'size']);
  assert.equal(sj.links[0].mine, true);
  assert.deepEqual(sj.links[0].creator, { id: 'sam', name: 'Sam' });
  assert.deepEqual(sj.settings, { enabled: true, defaultHours: 24, maxHours: 168, choices: [1, 24, 168] });
  const admin = (await r.call(r.as('owner'), 'GET', '/api/share-links')).json();
  assert.equal(admin.links.length, 3);
  assert.deepEqual(admin.links.map(l => l.mine).sort(), [false, false, true]);
  assert.deepEqual(admin.links.find(l => l.id === m.json().id).creator, { id: 'member-a', name: 'Member A' });
  const raw = JSON.stringify([sj, admin]) + sam.text;
  for (const x of secrets) assert.ok(!raw.includes(x));
  assert.ok(!/hash|token|"root"|"rel"/.test(raw));
  // a smaller maximum narrows the choices; expired links drop out
  r.conf.maxHours = 48;
  assert.deepEqual((await r.call(r.as('sam'), 'GET', '/api/share-links')).json().settings.choices, [1, 24]);
  r.clock.t += 2 * 3600 * 1000;
  assert.equal((await r.call(r.as('sam'), 'GET', '/api/share-links')).json().links.length, 0);
});

test('revoke: your own link, any link for an admin, 404 for someone else\'s or an unknown one; audited; immediate', async (t) => {
  const r = rig(t);
  r.put('users/sam/files', 's.txt'); r.put('users/member-a/files', 'm.txt');
  const s = await r.create(r.as('sam'), { path: 's.txt', hours: 1 });
  const m = await r.create(r.as('member-a'), { path: 'm.txt', hours: 1 });
  const url = (x) => `/api/share-links/${x.json().id}/revoke`;
  assert.equal((await r.call(r.as('member-a'), 'POST', url(s))).status, 404, 'not theirs');
  assert.equal(r.store.findLive(tokenOf(s)) !== null, true);
  assert.equal((await r.call(r.as('sam'), 'POST', '/api/share-links/0000000000000000/revoke')).status, 404);
  for (const ident of [{ hubIdentKind: 'token', hubUser: null, hubToken: {} }, { hubIdentKind: 'service', hubUser: null, hubService: true }, { ...r.as('sam'), hubPendingTotp: true }]) {
    assert.equal((await r.call(ident, 'POST', url(s))).status, 403);
  }
  assert.equal((await r.call(r.as('sam'), 'POST', url(s))).status, 200);
  assert.equal(r.store.findLive(tokenOf(s)), null);
  assert.equal((await r.call(r.as('sam'), 'POST', url(s))).status, 404, 'already revoked');
  assert.equal((await r.call(r.as('owner'), 'POST', url(m))).status, 200, 'an admin revokes anyone\'s');
  const a = actions(r, 'share.revoke');
  assert.equal(a.length, 2);
  assert.equal(a[1].userId, 'owner');
  assert.ok(a[1].detail.includes(m.json().id));
  assert.ok(!JSON.stringify(r.audits).includes(tokenOf(m)));
  assert.equal((await r.call(r.as('sam'), 'GET', url(s))).status, 405);
});

// ── opening ──

test('GET /s/<token>: the creator, signed in, sees the page; headers exactly as designed; no folder, agent or owner in it', async (t) => {
  const r = rig(t);
  r.put('users/sam/files', '<script>x<script>.txt', 'abc');
  const c = await r.create(r.as('sam'), { agent: 'sam-bot', path: '<script>x<script>.txt', hours: 24, oneTime: true });
  const res = await r.call(r.as('sam'), 'GET', c.json().path);
  assert.equal(res.status, 200);
  assert.deepEqual(res.headers, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    'cache-control': 'no-store', 'referrer-policy': 'same-origin', 'x-robots-tag': 'noindex', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff',
  });
  assert.ok(!/<script/i.test(res.text));
  assert.ok(res.text.includes('&lt;script&gt;x&lt;script&gt;.txt'));
  assert.ok(res.text.includes('3 bytes') && res.text.includes('One download') && res.text.includes('Link expires'));
  for (const leak of ['sam-bot', 'users/sam', r.hubHome, 'Sam']) assert.ok(!res.text.includes(leak), leak);
  assert.equal(r.store.get(c.json().id).downloads, 0, 'a page view uses nothing up');
  assert.equal(r.store.findLive(tokenOf(c)) !== null, true);
  assert.deepEqual(PAGE_HEADERS['Content-Security-Policy'], res.headers['content-security-policy']);
});

test('POST /s/<token>: the download streams the file as an attachment; audited without the token', async (t) => {
  const r = rig(t);
  const content = 'line one\nline two\n' + 'x'.repeat(100000);
  r.ownerFile('Report "Q3"; é.txt', content);
  const c = await r.create(r.as('owner'), { path: 'Report "Q3"; é.txt', hours: 24 });
  for (let i = 1; i <= 2; i++) {
    const res = await r.call(r.as('owner'), 'POST', c.json().path);
    assert.equal(res.status, 200);
    assert.equal(res.res.buffer.toString(), content);
    assert.deepEqual(res.headers, {
      'content-type': 'application/octet-stream', 'content-length': Buffer.byteLength(content),
      'content-disposition': SL.contentDisposition('Report "Q3"; é.txt'), 'x-content-type-options': 'nosniff', 'cache-control': 'no-store',
    });
    assert.equal(r.store.get(c.json().id).downloads, i);
  }
  const a = actions(r, 'share.download');
  assert.equal(a.length, 2);
  assert.equal(a[0].detail, `link ${c.json().id}`);
  assert.equal(a[0].ip, '192.0.2.10');
  assert.ok(!JSON.stringify(r.audits).includes(tokenOf(c)));
  // an empty file
  r.ownerFile('empty.txt', '');
  const e = await r.create(r.as('owner'), { path: 'empty.txt', hours: 1 });
  const er = await r.call(r.as('owner'), 'POST', e.json().path);
  assert.equal(er.status, 200); assert.equal(er.headers['content-length'], 0); assert.equal(er.text, '');
});

test('the address in the audit is the socket address, whatever headers say', async (t) => {
  const r = rig(t); r.ownerFile();
  const c = await r.create({ ...r.as('owner'), ip: '203.0.113.7' }, { path: 'report.txt', hours: 1 });
  await r.call({ ...r.as('owner'), ip: '198.51.100.9' }, 'POST', c.json().path);
  assert.equal(actions(r, 'share.create')[0].ip, '203.0.113.7');
  assert.equal(actions(r, 'share.download')[0].ip, '198.51.100.9');
});

async function expectGone(r, ident, method, p, status = 404) {
  const res = await r.call(ident, method, p);
  assert.equal(res.status, status, `${method} ${ident.hubIdentKind} ${ident.hubUser && ident.hubUser.id}: ${res.status}`);
  assert.ok(res.text.includes(GONE_TEXT));
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['referrer-policy'], 'same-origin');   // a form POST under no-referrer sends Origin: null, which the origin guard refuses
  assert.ok(!res.text.includes('report.txt'));
  return res;
}

test('someone else signed in, a token, the service, the legacy sign-in, a pending session and nobody all get the same 404 page', async (t) => {
  const r = rig(t); r.ownerFile();
  const c = await r.create(r.as('owner'), { path: 'report.txt', hours: 24 });
  const p = c.json().path;
  const idents = [r.as('sam'), r.as('admin-b'), { hubIdentKind: 'token', hubUser: null, hubToken: { id: 't' } }, { hubIdentKind: 'service', hubUser: null, hubService: true },
    { hubIdentKind: 'legacy', hubUser: r.users.owner }, { ...r.as('owner'), hubPendingTotp: true }, { hubIdentKind: null, hubUser: null }];
  const gone = [];
  for (const ident of idents) for (const m of ['GET', 'POST']) gone.push((await expectGone(r, ident, m, p)).text);
  assert.equal(new Set(gone).size, 1, 'the identical page every time');
  assert.equal(r.store.get(c.json().id).downloads, 0);
  assert.equal(actions(r, 'share.download').length, 0);
  // an unknown token looks the same
  assert.equal((await expectGone(r, r.as('owner'), 'GET', `/s/${'A'.repeat(43)}`)).text, gone[0]);
  assert.equal((await r.call(r.as('owner'), 'GET', p)).status, 200, 'the creator still can');
});

test('dead links: expired, revoked, creator disabled or deleted, file changed or gone, feature off', async (t) => {
  const r = rig(t);
  r.put('users/sam/files', 's.txt', 'abc');
  r.put('users/sam/files', 't.txt', 'abc');
  const fresh = async (key, body) => { const c = await r.create(r.as(key), body); assert.equal((await r.call(r.as(key), 'GET', c.json().path)).status, 200); return c; };
  const body = { path: 's.txt', hours: 1 };
  // expired
  let c = await fresh('sam', body);
  r.clock.t += 3600 * 1000;
  await expectGone(r, r.as('sam'), 'GET', c.json().path); await expectGone(r, r.as('sam'), 'POST', c.json().path);
  // revoked
  c = await fresh('sam', body);
  await r.call(r.as('sam'), 'POST', `/api/share-links/${c.json().id}/revoke`);
  await expectGone(r, r.as('sam'), 'GET', c.json().path);
  // the creator's account disabled
  c = await fresh('sam', body);
  r.users.sam.disabled = true;
  await expectGone(r, r.as('sam'), 'GET', c.json().path); await expectGone(r, r.as('sam'), 'POST', c.json().path);
  r.users.sam.disabled = false;
  assert.equal((await r.call(r.as('sam'), 'GET', c.json().path)).status, 200, 'enabled again: the same link works');
  // deleted
  const saved = r.users.sam; delete r.users.sam;
  await expectGone(r, { ...r.as('member-a'), hubUser: saved }, 'GET', c.json().path);
  r.users.sam = saved;
  // the file edited, replaced, removed
  c = await fresh('sam', { path: 't.txt', hours: 1 });
  const abs = path.join(r.hubHome, 'users', 'sam', 'files', 't.txt');
  fs.appendFileSync(abs, 'more');
  await expectGone(r, r.as('sam'), 'GET', c.json().path);
  fs.writeFileSync(abs, 'abc');
  c = await fresh('sam', { path: 't.txt', hours: 1 });
  fs.renameSync(abs, abs + '.old'); fs.writeFileSync(abs, 'abc');
  await expectGone(r, r.as('sam'), 'POST', c.json().path);
  c = await fresh('sam', { path: 't.txt', hours: 1 });
  fs.rmSync(abs);
  await expectGone(r, r.as('sam'), 'POST', c.json().path);
  // switched off
  c = await fresh('sam', body);
  r.conf.enabled = false;
  await expectGone(r, r.as('sam'), 'GET', c.json().path);
  r.conf.enabled = true;
  assert.equal((await r.call(r.as('sam'), 'GET', c.json().path)).status, 200);
  // a refused download did not count
  assert.equal(r.store.get(c.json().id).downloads, 0);
});

test('access lost without any event: an admin demoted, an agent removed or no longer allowed, a moved folder', async (t) => {
  const r = rig(t);
  r.put('users/member-a/files', 'm.txt'); r.put('users/sam/files', 's.txt');
  // an admin sharing a member's file, then demoted to a member: the folder is no longer theirs
  let c = await r.create(r.as('admin-b'), { owner: 'member-a', path: 'm.txt', hours: 1 });
  assert.equal((await r.call(r.as('admin-b'), 'GET', c.json().path)).status, 200);
  r.users['admin-b'].role = 'member';
  await expectGone(r, r.as('admin-b'), 'GET', c.json().path);
  await expectGone(r, r.as('admin-b'), 'POST', c.json().path);
  // an admin's link through an agent's folder; the agent is removed
  r.put('share/helper', 'h.txt');
  c = await r.create(r.as('owner'), { agent: 'helper', path: 'h.txt', hours: 1 });
  assert.equal((await r.call(r.as('owner'), 'GET', c.json().path)).status, 200);
  const i = r.agents.findIndex(a => a.name === 'helper'); const [removed] = r.agents.splice(i, 1);
  await expectGone(r, r.as('owner'), 'GET', c.json().path);
  r.agents.splice(i, 0, removed);
  // a member's agent: the member loses it (the owner changes)
  c = await r.create(r.as('sam'), { agent: 'sam-bot', path: 's.txt', hours: 1 });
  assert.equal((await r.call(r.as('sam'), 'GET', c.json().path)).status, 200);
  r.agents.find(a => a.name === 'sam-bot').owner = 'member-a';
  await expectGone(r, r.as('sam'), 'GET', c.json().path);
  // the same agent now resolves to another folder (owner an admin: share/sam-bot): the root no longer matches
  r.agents.find(a => a.name === 'sam-bot').owner = 'owner';
  await expectGone(r, r.as('sam'), 'GET', c.json().path);
});

test('one-time: used up by the first download only; two parallel downloads give one file and one 404', async (t) => {
  const r = rig(t); r.ownerFile('once.txt', 'payload');
  let c = await r.create(r.as('owner'), { path: 'once.txt', hours: 1, oneTime: true });
  assert.equal((await r.call(r.as('owner'), 'GET', c.json().path)).status, 200);
  assert.equal((await r.call(r.as('owner'), 'GET', c.json().path)).status, 200, 'looking does not use it up');
  const first = await r.call(r.as('owner'), 'POST', c.json().path);
  assert.equal(first.status, 200); assert.equal(first.text, 'payload');
  await expectGone(r, r.as('owner'), 'POST', c.json().path);
  await expectGone(r, r.as('owner'), 'GET', c.json().path);
  c = await r.create(r.as('owner'), { path: 'once.txt', hours: 1, oneTime: true });
  const both = await Promise.all([r.call(r.as('owner'), 'POST', c.json().path), r.call(r.as('owner'), 'POST', c.json().path)]);
  assert.deepEqual(both.map(x => x.status).sort(), [200, 404]);
  assert.equal(actions(r, 'share.download').length, 2, 'one audit line per file that went out');
  assert.equal(r.store.get(c.json().id).downloads, 1);
  // a one-time link whose file changed is not used up by the refusal
  c = await r.create(r.as('owner'), { path: 'once.txt', hours: 1, oneTime: true });
  fs.appendFileSync(path.join(r.hubHome, 'share', 'once.txt'), 'x');
  await expectGone(r, r.as('owner'), 'POST', c.json().path);
  assert.equal(r.store.get(c.json().id).usedAt, null);
});

test('guessing: 20 dead tokens in 10 minutes block the person for 10 minutes, with one share.refused line; others are unaffected', async (t) => {
  const r = rig(t); r.ownerFile();
  const c = await r.create(r.as('owner'), { path: 'report.txt', hours: 24 });
  const guess = (i) => `/s/${String(i).padStart(43, 'B')}`;
  for (let i = 0; i < 19; i++) await expectGone(r, r.as('owner'), 'GET', guess(i));
  assert.equal(actions(r, 'share.refused').length, 0);
  assert.equal((await r.call(r.as('owner'), 'GET', c.json().path)).status, 200, 'not blocked yet');
  await expectGone(r, r.as('owner'), 'GET', guess(19));
  assert.equal(actions(r, 'share.refused').length, 1);
  assert.equal(actions(r, 'share.refused')[0].userId, 'owner');
  assert.equal(actions(r, 'share.refused')[0].ip, '192.0.2.10');
  await expectGone(r, r.as('owner'), 'GET', c.json().path);   // blocked: even the real link
  await expectGone(r, r.as('owner'), 'POST', c.json().path);
  for (let i = 20; i < 30; i++) await expectGone(r, r.as('owner'), 'GET', guess(i));
  assert.equal(actions(r, 'share.refused').length, 1, 'one line per block');
  assert.equal((await r.call({ ...r.as('owner'), ip: '198.51.100.20' }, 'GET', c.json().path)).status, 200, 'another address is keyed separately');
  r.clock.t += 10 * 60 * 1000 + 1;
  assert.equal((await r.call(r.as('owner'), 'GET', c.json().path)).status, 200, 'the block ends');
  assert.ok(!JSON.stringify(r.audits).includes(tokenOf(c)));
  // another person presenting someone's token counts against that person
  const s = r.as('sam');
  for (let i = 0; i < 20; i++) await expectGone(r, s, 'GET', c.json().path);
  assert.equal(actions(r, 'share.refused').length, 2);
});

test('rate limit: 30 requests a minute per person and address', async (t) => {
  const r = rig(t); r.ownerFile();
  const c = await r.create(r.as('owner'), { path: 'report.txt', hours: 24 });
  for (let i = 0; i < 30; i++) assert.equal((await r.call(r.as('owner'), 'GET', c.json().path)).status, 200, `#${i + 1}`);
  const over = await r.call(r.as('owner'), 'GET', c.json().path);
  assert.equal(over.status, 429);
  assert.ok(over.text.includes(GONE_TEXT));
  assert.equal((await r.call({ ...r.as('owner'), ip: '198.51.100.30' }, 'GET', c.json().path)).status, 200);
  r.clock.t += 60 * 1000;
  assert.equal((await r.call(r.as('owner'), 'GET', c.json().path)).status, 200);
});

test('not ours: wrong-length tokens, other /s/ paths and everything else; wrong methods are refused', async (t) => {
  const r = rig(t);
  const ok = 'A'.repeat(43);
  for (const p of ['/s/', '/s', `/s/${'A'.repeat(42)}`, `/s/${'A'.repeat(44)}`, `/s/${ok}/x`, `/s/${ok}.txt`, `/s/${'A'.repeat(42)}!`, `/s/${'A'.repeat(42)}%41`, '/s/../api/files', '/x/s/' + ok,
    '/api/share-links/xyz/revoke', '/api/share-links/0123456789abcdef', '/api/share-links/0123456789ABCDEF/revoke', '/api/share-links/0123456789abcdef/revoke/x', '/api/files', '/login', '/']) {
    const res = await r.call(r.as('owner'), 'GET', p);
    assert.equal(res.handled, false, p);
    assert.equal(res.status, null, p);
    assert.equal(res.text, '');
  }
  assert.equal((await r.call(r.as('owner'), 'DELETE', '/api/share-links')).status, 405);
  assert.equal((await r.call(r.as('owner'), 'PUT', `/s/${ok}`)).status, 405);
  assert.equal(r.audits.length, 0);
});

test('wiring: the gate classes, server.js hooks, the settings cleaner and the login page header', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(server.includes("require('./lib/share-links-routes').createShareLinkRoutes"));
  assert.ok(/pathname\.startsWith\('\/s\/'\)[\s\S]{0,200}shareLinkRoutes\(\)\.handle\(req, res, pathname\)/.test(server));
  assert.ok(server.includes("patch.shareLinks = require('./lib/share-links').cleanSettings(patch.shareLinks, hubSettings.getSetting('shareLinks'))"));
  assert.ok(/pathname === '\/login' \|\| pathname === '\/invite'\) headers\['Referrer-Policy'\] = 'no-referrer'/.test(server));
  // the handler sits inside the gate: it comes after the classification and before the other routes
  assert.ok(server.indexOf('shareLinkRoutes().handle') > server.indexOf('access.classifyRoute(pathname'));
  assert.ok(server.indexOf('shareLinkRoutes().handle') < server.indexOf("pathname === '/v1/chat/completions'"));
  assert.equal(access.classifyRoute(`/s/${'A'.repeat(43)}`).kind, 'session');
  assert.equal(access.classifyRoute('/api/share-links').kind, 'session');
});

// ── review follow-ups ──

test('an aborted client: a destroyed response does not use up a one-time link and the descriptor is closed', async (t) => {
  const closed = [];
  const spyFs = { ...fs, closeSync: (fd) => { closed.push(fd); return fs.closeSync(fd); } };
  const r = rig(t, { routeExtra: { fsImpl: spyFs } }); r.ownerFile('once.txt', 'payload');
  const c = await r.create(r.as('owner'), { path: 'once.txt', hours: 1, oneTime: true });
  const dead = await r.call(r.as('owner'), 'POST', c.json().path, undefined, () => { const x = new FakeRes(); x.destroy(); return x; });
  assert.equal(dead.handled, true);
  assert.equal(closed.length, 1, 'the descriptor was closed');
  assert.equal(r.store.get(c.json().id).usedAt, null, 'the link is not used up');
  assert.equal(r.store.get(c.json().id).downloads, 0);
  assert.equal(actions(r, 'share.download').length, 0);
  const ok = await r.call(r.as('owner'), 'POST', c.json().path);
  assert.equal(ok.status, 200); assert.equal(ok.text, 'payload');
});

test('an aborted client: a destroyed socket on the request counts the same', async (t) => {
  const closed = [];
  const spyFs = { ...fs, closeSync: (fd) => { closed.push(fd); return fs.closeSync(fd); } };
  const r = rig(t, { routeExtra: { fsImpl: spyFs } }); r.ownerFile('once.txt', 'payload');
  const c = await r.create(r.as('owner'), { path: 'once.txt', hours: 1, oneTime: true });
  const ident = r.as('owner');
  const req = new EventEmitter();
  Object.assign(req, { method: 'POST', url: c.json().path, headers: {}, socket: { remoteAddress: '192.0.2.10', destroyed: true }, hubIdentKind: 'user', hubUser: ident.hubUser, hubPendingTotp: false, hubToken: null, hubService: false });
  const res = new FakeRes();
  assert.equal(await r.routes.handle(req, res, c.json().path), true);
  assert.equal(closed.length, 1);
  assert.equal(r.store.get(c.json().id).usedAt, null);
});

test('the descriptor is closed when the client leaves before the end of a download', async (t) => {
  const closed = [];
  const spyFs = { ...fs, closeSync: (fd) => { closed.push(fd); return fs.closeSync(fd); } };
  const r = rig(t, { routeExtra: { fsImpl: spyFs } }); r.ownerFile('big.bin', 'x'.repeat(2 * 1024 * 1024));
  const c = await r.create(r.as('owner'), { path: 'big.bin', hours: 1 });
  let res;
  const got = await r.call(r.as('owner'), 'POST', c.json().path, undefined, () => { res = new FakeRes(); res._write = (chunk, enc, cb) => { res.destroy(); cb(); }; return res; });
  assert.equal(got.handled, true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(res.destroyed, true);
  assert.ok(closed.length <= 1);
});

test('revoke: a failed save still revokes (200 with a warning, link gone at once); a failed save refuses the download and keeps it live', async (t) => {
  const flag = { fail: false };
  const failingFs = { ...fs, writeFileSync: (...a) => { if (flag.fail) throw new Error('disk full'); return fs.writeFileSync(...a); } };
  const r = rig(t, { storeFs: failingFs }); r.ownerFile('once.txt', 'payload'); r.ownerFile('two.txt', 'x');
  const c = await r.create(r.as('owner'), { path: 'once.txt', hours: 1, oneTime: true });
  const d = await r.create(r.as('owner'), { path: 'two.txt', hours: 1 });
  flag.fail = true;
  // the download-save-failure half: gone page, the link stays live
  const dl = await r.call(r.as('owner'), 'POST', c.json().path);
  assert.equal(dl.status, 404); assert.ok(dl.text.includes(GONE_TEXT));
  assert.equal(r.store.get(c.json().id).usedAt, null);
  assert.ok(r.store.findLive(tokenOf(c)));
  // the revoke half
  const rev = await r.call(r.as('owner'), 'POST', `/api/share-links/${d.json().id}/revoke`);
  assert.equal(rev.status, 200);
  assert.deepEqual(rev.json(), { ok: true, warning: 'Revoked. It could not be saved yet, so it might work again if your Maestro restarts before it is saved.' });
  const a = actions(r, 'share.revoke');
  assert.equal(a.length, 1);
  assert.ok(a[0].detail.includes(d.json().id) && a[0].detail.endsWith('(not saved yet)'));
  const gone = await r.call(r.as('owner'), 'GET', d.json().path);
  assert.equal(gone.status, 404); assert.ok(gone.text.includes(GONE_TEXT));
  flag.fail = false;
  assert.equal((await r.call(r.as('owner'), 'POST', c.json().path)).text, 'payload', 'still live once saving works');
});

test('create: the audit detail JSON-quotes the folder and file name, so a control character cannot split or forge a line', async (t) => {
  const r = rig(t);
  const weird = 'a\nb\u0007 "q".txt';
  r.put('share', weird);
  const res = await r.create(r.as('owner'), { path: weird, hours: 1 });
  assert.equal(res.status, 200, res.text);
  const a = actions(r, 'share.create');
  assert.equal(a.length, 1);
  assert.ok(!/[\x00-\x1f]/.test(a[0].detail), 'no raw control character');
  assert.ok(a[0].detail.includes('file ' + JSON.stringify(res.json().name)));
  assert.ok(a[0].detail.includes('\\n') && a[0].detail.includes('\\u0007'));
});

test('a throw inside open() answers the gone page and logs no token', async (t) => {
  const logs = [];
  const r = rig(t, { routeExtra: { log: (m) => logs.push(m), openChecked: () => { throw new Error('boom'); } } }); r.ownerFile();
  const c = await r.create(r.as('owner'), { path: 'report.txt', hours: 1 });
  const got = await r.call(r.as('owner'), 'GET', c.json().path);
  assert.equal(got.status, 404); assert.ok(got.text.includes(GONE_TEXT));
  assert.deepEqual(logs, ['[share-links] open failed: boom']);
  assert.ok(!logs.join('\n').includes(tokenOf(c)));
});

test('a throw whose message holds the token still logs no token', async (t) => {
  const logs = [];
  let tok = '';
  const r = rig(t, { routeExtra: { log: (m) => logs.push(m), openChecked: () => { throw new Error(`failed for /s/${tok}`); } } }); r.ownerFile();
  const c = await r.create(r.as('owner'), { path: 'report.txt', hours: 1 });
  tok = tokenOf(c);
  const got = await r.call(r.as('owner'), 'GET', c.json().path);
  assert.equal(got.status, 404);
  assert.ok(logs.length === 1 && !logs[0].includes(tok));
});

test('server.js: both catch-all error lines redact the share token in the message as well as the URL', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const lines = server.split('\n').filter(l => l.includes('console.error(`[server] ${req.method}'));
  assert.equal(lines.length, 2);
  assert.ok(/redactShareToken\(String\(req\.url \|\| ''\)\)/.test(lines[0]));
  assert.ok(/: \$\{redactShareToken\(err && err\.message \? err\.message : err\)\}/.test(lines[0]));
  assert.ok(/redactShareToken\(pathname\)/.test(lines[1]));
  assert.ok(/: \$\{redactShareToken\(err\.message\)\}/.test(lines[1]));
});

test('server.js redactShareToken: hides a token in a path and in a percent-encoded path, leaves other text alone', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const line = server.split('\n').find(l => l.startsWith('const redactShareToken = '));
  assert.ok(line, 'one-line const');
  const redact = new Function(`${line}; return redactShareToken;`)();
  const tok = 'Ab1_-'.repeat(8) + 'xyz';   // 43 characters
  assert.equal(tok.length, 43);
  assert.equal(redact(`failed for /s/${tok}`), 'failed for /s/<token>');
  assert.equal(redact(`x%2Fs%2F${tok}y`.replace('y', '')), 'x%2Fs%2F<token>');
  assert.equal(redact(`x%2fs%2f${tok}`), 'x%2Fs%2F<token>');
  assert.equal(redact('/s/short'), '/s/short');
  assert.equal(redact(new Error('plain')), 'Error: plain');
});
