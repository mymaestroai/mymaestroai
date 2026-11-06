'use strict';
// Ring module as a whole: the manifest and setup load without problems, the cross-file calls land on real functions, the real
// server.js runs end to end over stdio against a local fake Ring and a stand-in hub, and nothing personal is in the folder.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadModule } = require('../lib/modules/manifest');
const { computeNonce } = require('../modules/ring/lib/link');
const { createStore } = require('../modules/ring/lib/store');
const { createApi } = require('../modules/ring/lib/api');
const { createCameras } = require('../modules/ring/lib/cameras');
const { createMedia } = require('../modules/ring/lib/media');
const { createFaces } = require('../modules/ring/lib/faces');
const { createEvents } = require('../modules/ring/lib/events');

const DIR = path.join(__dirname, '..', 'modules', 'ring');
const SERVER = path.join(DIR, 'server.js');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const HMAC_KEY = 'hmac-key-for-tests-0123456789';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── (a) the module loads ──
test('the manifest, setup and checks of modules/ring load without problems', () => {
  const m = loadModule(DIR);
  assert.deepStrictEqual(m.problems, []);
  assert.strictEqual(m.manifest.server.background, true);
  assert.strictEqual(m.manifest.rotatingSecret, 'REFRESH_TOKEN');
  assert.deepStrictEqual(Object.keys(m.code.checks).sort(), ['link', 'ring', 'urls']);
  assert.ok(m.hasGuide);
});

test('the checks: urls from the saved public address, health summary without camera data', async () => {
  const { checks } = require('../modules/ring/index.js');
  assert.strictEqual((await checks.urls({ settings: { public_url: '' } })).ok, false);
  assert.strictEqual((await checks.urls({ settings: { public_url: 'http://plain.example.com' } })).ok, false, 'https only');
  const u = await checks.urls({ settings: { public_url: 'https://maestro.example.com/' } });
  assert.deepStrictEqual(u.lines, ['link', 'token', 'events', 'done'].map((p) => `${p}: https://maestro.example.com/hooks/ring/${p}`));
  const parse = (t) => JSON.parse(t);
  const health = (h) => checks.ring({ callTool: async () => JSON.stringify(h), parse });
  const good = { linked: true, needs_relink: false, secrets_present: true, ring_reachable: true, unsaved_token: false };
  assert.strictEqual((await health(good)).ok, true);
  assert.strictEqual((await health({ ...good, linked: false })).ok, false);
  assert.strictEqual((await health({ ...good, needs_relink: true })).ok, false);
  const w = await health({ ...good, unsaved_token: true });
  assert.strictEqual(w.ok, true);
  assert.strictEqual(w.warnings.length, 1);
  const bad = await health({ ...good, linked: false, secrets_present: false, unreadable_state: true, unreadable_files: ['account.json'] });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.summary, /state file \(account\.json\) cannot be read/);
  assert.match(bad.summary, /again will not help/);
  assert.ok(!/No Ring account is connected yet/.test(bad.summary));
  const l = await checks.link({ settings: { time_zone: 'UTC' }, callTool: async (name, args) => { assert.strictEqual(name, 'arm_link'); return JSON.stringify({ code: 'ABCD-2345', expires_at: new Date(Date.now() + 1800000).toISOString(), minutes: args.minutes }); }, parse });
  assert.strictEqual(l.ok, true);
  assert.strictEqual(l.once, true, 'the hub keeps the lines out of its stores');
  assert.ok(l.lines[0].includes('ABCD-2345'));
  assert.ok(!l.summary.includes('ABCD-2345'), 'the code stays out of the summary');
});

// ── every call one lib file makes on another lands on a function that exists ──
test('cross-file calls: every store./api./media./faces./cameras. member the lib files use exists on the real object', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ring-wire-'));
  try {
    const dataHome = path.join(tmp, 'data'), mediaDir = path.join(tmp, 'media');
    fs.mkdirSync(mediaDir);
    const env = { CONNECTOR_DATA_HOME: dataHome, CONNECTOR_MEDIA_DIR: mediaDir };
    const store = createStore({ dataHome, mediaDir });
    const api = createApi({ env, settings: {}, store, hubRequest: async () => ({ ok: true }) });
    const cameras = createCameras({ store, settings: {} });
    const media = createMedia({ env, settings: {}, store, api });
    const faces = createFaces({ env, settings: {}, store });
    const events = createEvents({ env, settings: {}, store, api, media, faces, cameras, notify: async () => ({ ok: true }) });
    const real = { store, api, media, faces, cameras, events };
    const seen = [];
    for (const f of ['media.js', 'faces.js', 'events.js', 'link.js', 'cameras.js']) {
      const src = fs.readFileSync(path.join(DIR, 'lib', f), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
      for (const m of src.matchAll(/(?<![\w.'"/])(?:ctx\.)?(store|api|media|faces|cameras)\.([A-Za-z_]\w*)/g)) {
        if (f === 'media.js' && m[1] === 'media') continue;
        if (f === 'faces.js' && m[1] === 'faces') continue;
        seen.push(`${f}: ${m[1]}.${m[2]}`);
        assert.ok(m[2] in real[m[1]], `${f} calls ${m[1]}.${m[2]}, which the real ${m[1]} does not have`);
      }
    }
    assert.ok(seen.length > 20, 'the scan found the calls');
    // the nested members those files use
    for (const [obj, names] of [[store.linkArm, ['get', 'arm', 'matches', 'wrong', 'clear']], [store.devices, ['get', 'save']], [store.recent, ['keep', 'add']]]) for (const n of names) assert.strictEqual(typeof obj[n], 'function', n);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ── a compact fake Ring ──
function startRing() {
  const R = { calls: [], presigned: [], tokens: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const auth = req.headers.authorization || '';
      const port = server.address().port;
      const json = (s, o, h = {}) => { res.writeHead(s, { 'Content-Type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
      if (u.pathname.startsWith('/presigned/')) { R.presigned.push({ auth }); res.writeHead(200, { 'Content-Type': 'image/jpeg', 'X-Media-Origin': 'Event', 'X-Media-Timestamp': String(Date.now()) }); return res.end(JPEG); }
      R.calls.push({ method: req.method, path: u.pathname, body, auth });
      if (u.pathname === '/oauth/token') {
        const f = new URLSearchParams(body);
        if (f.get('client_id') !== 'cid' || f.get('client_secret') !== 'csec') return json(401, { error: 'invalid_client' });
        if (f.get('grant_type') === 'authorization_code' && f.get('code') !== 'good-code') return json(400, { error: 'invalid_grant' });
        const n = ++R.tokens;
        return json(200, { access_token: `acc-${n}`, refresh_token: `ref-${n}`, expires_in: 14400, token_type: 'Bearer' });
      }
      if (!/^Bearer acc-\d+$/.test(auth)) return json(401, {});
      if (u.pathname === '/v1/users/me') return json(200, { data: { id: 'acct-1', attributes: { email: 'someone@example.com' } } });
      if (u.pathname === '/v1/accounts/me/app-integrations') return json(req.method === 'POST' ? 201 : 200, { data: {} });
      if (u.pathname === '/v1/devices') return json(200, { data: [{ id: 'dev-front-123456', type: 'doorbell', attributes: { name: 'Front Door' } }] });
      let m = u.pathname.match(/^\/v1\/devices\/([^/]+)\/status$/);
      if (m) return json(200, { data: { attributes: { online: true, reported_at: '2026-01-02T03:04:05Z' } } });
      m = u.pathname.match(/^\/v1\/devices\/([^/]+)\/media\/image\/download$/);
      if (m && req.method === 'POST') { res.writeHead(303, { Location: `http://127.0.0.1:${port}/presigned/img.jpg` }); return res.end(); }
      m = u.pathname.match(/^\/v1\/history\/devices\/([^/]+)\/events$/);
      if (m) return json(200, { data: [{ attributes: { event_type: 'motion', start: Date.now() - 60000, end: Date.now() - 50000 } }, { attributes: { event_type: 'ding', start: Date.now() - 30000, end: null } }] });
      json(404, {});
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ R, server, port: server.address().port })));
}

// ── the real server.js as a child process, with the test acting as the hub ──
function startServer(env) {
  const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const H = { child, notices: [], refreshTokens: [], hubReqs: [], stderr: '', stdout: [], mode: { refresh: 'ok' } };
  const waiting = new Map();
  let seq = 0, buf = '';
  child.stderr.on('data', (d) => { H.stderr += d; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      H.stdout.push(line);
      const msg = JSON.parse(line);   // anything on stdout that is not JSON fails the test
      if (msg.method) {   // a request from the module to the hub
        H.hubReqs.push(msg);
        let result = { ok: true };
        if (msg.method === 'hub/refresh_token') { H.refreshTokens.push(msg.params.value); if (H.mode.refresh !== 'ok') result = { ok: false }; }
        else if (msg.method === 'hub/notify') H.notices.push(msg.params);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
      } else if (waiting.has(msg.id)) { const w = waiting.get(msg.id); waiting.delete(msg.id); w(msg); }
    }
  });
  H.rpc = (method, params, ms = 20000) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`no answer to ${method}`)); }, ms);
    waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  H.call = async (name, args = {}) => {
    const r = await H.rpc('tools/call', { name, arguments: args });
    assert.ok(r.result, JSON.stringify(r));
    const text = r.result.content[0].text;
    return r.result.isError ? { error: text } : JSON.parse(text);
  };
  H.receive = async (p) => {
    const r = await H.rpc('hub/receive', { method: 'GET', query: '', headers: {}, body: '', ip: '203.0.113.5', at: new Date().toISOString(), ...p });
    assert.ok(r.result, JSON.stringify(r));
    for (const k of Object.keys(r.result.headers)) assert.ok(['content-type', 'cache-control', 'content-security-policy', 'retry-after', 'location'].includes(k), `header ${k} would be refused by the hub`);
    assert.ok(Number.isInteger(r.result.status) && r.result.status >= 200 && r.result.status <= 599 && typeof r.result.body === 'string');
    return r.result;
  };
  H.exited = new Promise((res) => child.on('exit', (code, sig) => res({ code, sig })));
  H.stop = async () => { child.stdin.end(); const r = await Promise.race([H.exited, sleep(5000).then(() => null)]); if (!r) child.kill('SIGKILL'); return r; };
  return H;
}
const form = (o) => new URLSearchParams(o).toString();

test('server.js end to end: tools, signed events with a notice, the link flow', async (t) => {
  const { R, server, port } = await startRing();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ring-e2e-'));
  const dataHome = path.join(tmp, 'data'), mediaDir = path.join(tmp, 'media');
  fs.mkdirSync(dataHome, { mode: 0o700 });
  fs.mkdirSync(mediaDir, { mode: 0o775 });
  const H = startServer({
    RING_TEST: '1', RING_API_BASE: `http://127.0.0.1:${port}`, RING_OAUTH_URL: `http://127.0.0.1:${port}/oauth/token`, RING_ALLOW_HTTP_MEDIA: '1', RING_TEST_SNAPSHOT_DELAYS: '1,1,1',
    CONNECTOR_ID: 'ring', CONNECTOR_DATA_HOME: dataHome, CONNECTOR_MEDIA_DIR: mediaDir,
    MODULE_SETTINGS: JSON.stringify({ account_email: 'owner@example.com', time_zone: 'UTC', houses: 'House A: front' }),
    CLIENT_ID: 'cid', CLIENT_SECRET: 'csec', HMAC_KEY,
  });
  t.after(async () => { await H.stop(); server.closeAllConnections(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'module.json'), 'utf8'));

  await t.test('initialize and tools/list list exactly the declared tools, with schemas', async () => {
    const init = await H.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.strictEqual(init.result.serverInfo.name, 'ring');
    const list = await H.rpc('tools/list', {});
    assert.deepStrictEqual(list.result.tools.map((x) => x.name).sort(), Object.keys(manifest.tools).sort());
    for (const x of list.result.tools) { assert.strictEqual(x.inputSchema.type, 'object'); assert.ok(x.description); }
    assert.deepStrictEqual((await H.rpc('tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
  });

  await t.test('before linking: status says so, tools refuse, events are ignored with 200', async () => {
    const s = await H.call('status');
    assert.strictEqual(s.linked, false);
    assert.deepStrictEqual(s.cameras, []);
    assert.match((await H.call('history', { camera: 'all' })).error, /not linked|unknown camera/);
    const raw = Buffer.from(JSON.stringify({ meta: { request_id: 'early', account_id: 'acct-1' }, data: { type: 'motion_detected', attributes: { source: 'dev-front-123456', timestamp: Date.now() } } }));
    const r = await H.receive({ method: 'POST', path: 'events', headers: { 'x-signature': crypto.createHmac('sha256', HMAC_KEY).update(raw).digest('hex') }, body: raw.toString('base64') });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(H.notices.length, 0);
  });

  await t.test('unknown receiver paths and wrong methods are 404', async () => {
    assert.strictEqual((await H.receive({ path: 'nothing' })).status, 404);
    assert.strictEqual((await H.receive({ method: 'GET', path: 'events' })).status, 404);
    assert.strictEqual((await H.receive({ method: 'POST', path: 'done' })).status, 404);
    assert.strictEqual((await H.receive({ path: 'done' })).status, 200);
  });

  await t.test('the link flow: token exchange, link page, armed code, sign-in from a sandboxed page, refresh token to the hub', async () => {
    const tokenBody = form({ grant_type: 'authorization_code', client_id: 'cid', code: 'good-code' });
    const tk = await H.receive({ method: 'POST', path: 'token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: Buffer.from(tokenBody).toString('base64') });
    assert.strictEqual(tk.status, 200);
    const time = String(Date.now());
    const nonce = computeNonce(time, 'acct-1', Buffer.from(HMAC_KEY));
    const query = `nonce=${encodeURIComponent(nonce)}&time=${time}`;
    assert.strictEqual((await H.receive({ path: 'link', query })).status, 403, 'closed until a code is armed');

    const armed = await H.call('arm_link', { minutes: 10 });
    assert.match(armed.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.ok(Date.parse(armed.expires_at) > Date.now());
    assert.ok(!H.stderr.includes(armed.code), 'the code is not logged');
    assert.match((await H.call('arm_link', { minutes: 1 })).error, /between 5 and 120/);
    const armed2 = await H.call('arm_link', { minutes: 10 });   // re-armed: only the newest code works
    assert.notStrictEqual(armed2.code, armed.code);

    const page = await H.receive({ path: 'link', query });
    assert.strictEqual(page.status, 200);
    assert.match(page.body, /action="link"/);
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);

    const wrong = await H.receive({ method: 'POST', path: 'link', headers: { origin: 'null', 'content-type': 'application/x-www-form-urlencoded' }, body: Buffer.from(form({ nonce, time, code: 'AAAA-AAAA' })).toString('base64') });
    assert.strictEqual(wrong.status, 401);
    assert.deepStrictEqual(H.refreshTokens, []);
    const done = await H.receive({ method: 'POST', path: 'link', headers: { origin: 'null', 'content-type': 'application/x-www-form-urlencoded' }, body: Buffer.from(form({ nonce, time, code: armed2.code })).toString('base64') });
    assert.strictEqual(done.status, 200, done.body);
    assert.match(done.body, /connected/i);
    assert.deepStrictEqual(H.hubReqs.filter((x) => x.method === 'hub/refresh_token').map((x) => x.params), [{ value: 'ref-1' }]);
    const appCalls = R.calls.filter((c) => c.path === '/v1/accounts/me/app-integrations');
    assert.deepStrictEqual(appCalls.map((c) => c.method), ['POST', 'PATCH']);
    assert.strictEqual(JSON.parse(appCalls[0].body).nonce, nonce);
    assert.strictEqual(JSON.parse(appCalls[0].body).account_identifier, 'o***r@example.com');
    assert.strictEqual((await H.receive({ path: 'link', query })).status, 400, 'the address cannot be used again');

    const s = await H.call('status');
    assert.strictEqual(s.linked, true);
    assert.strictEqual(s.needs_relink, false);
    assert.strictEqual(s.warning, null);
    assert.strictEqual(s.cameras.length, 1);
    assert.strictEqual(s.cameras[0].camera, 'Front Door');
    assert.strictEqual(s.cameras[0].online, true);
    assert.strictEqual(s.cameras[0].house, 'House A');
    const mode = fs.statSync(path.join(dataHome, 'account.json')).mode & 0o777;
    assert.strictEqual(mode, 0o600);
    assert.ok(!fs.readFileSync(path.join(dataHome, 'account.json'), 'utf8').includes('ref-1'), 'the refresh token is not in the account file');
  });

  await t.test('a signed event is answered 200, then a notice with its still goes to the hub; a bad signature is 401', async () => {
    const ev = (rid) => Buffer.from(JSON.stringify({ meta: { request_id: rid, account_id: 'acct-1' }, data: { type: 'motion_detected', attributes: { source: 'dev-front-123456', sub_type: 'human', timestamp: Date.now(), component_ids: ['1'] } } }));
    const raw = ev('req-1');
    const sig = crypto.createHmac('sha256', HMAC_KEY).update(raw).digest('hex');
    const bad = await H.receive({ method: 'POST', path: 'events', headers: { 'x-signature': 'sha256=' + 'ab'.repeat(32) }, body: raw.toString('base64') });
    assert.strictEqual(bad.status, 401);
    assert.strictEqual((await H.receive({ method: 'POST', path: 'events', headers: {}, body: raw.toString('base64') })).status, 401);
    assert.strictEqual(H.notices.length, 0);
    const ok = await H.receive({ method: 'POST', path: 'events', headers: { 'x-signature': `sha256=${sig}` }, body: raw.toString('base64') });
    assert.strictEqual(ok.status, 200);
    for (let i = 0; i < 100 && !H.notices.length; i++) await sleep(50);
    assert.strictEqual(H.notices.length, 1);
    const n = H.notices[0];
    assert.match(n.id, /^[0-9a-f-]{36}$/, 'the notice carries the outbox entry id');
    assert.match(n.text, /^\[RING EVENT\] Motion \(person\) · Front Door \(…123456\) · House A · /);
    assert.strictEqual(n.files.length, 1);
    assert.match(n.files[0], /^events\/\d{4}-\d{2}-\d{2}\/\d{4}-front-door\.jpg$/);
    assert.ok(!n.text.includes(mediaDir), 'no absolute path in the notice');
    const file = path.join(mediaDir, n.files[0]);
    assert.ok(file.startsWith(mediaDir + path.sep) && fs.existsSync(file));
    assert.deepStrictEqual([...fs.readFileSync(file).subarray(0, 2)], [0xff, 0xd8]);
    assert.ok(R.presigned.every((p) => p.auth === ''), 'no bearer token went to the pre-signed address');
    // the same request id again: a duplicate, answered 200, no second notice
    assert.strictEqual((await H.receive({ method: 'POST', path: 'events', headers: { 'x-signature': sig }, body: raw.toString('base64') })).status, 200);
    await sleep(300);
    assert.strictEqual(H.notices.length, 1);
  });

  await t.test('tools: history, still (latest), validation and the clip/faces refusals', async () => {
    const h = await H.call('history', { camera: 'all', hours: 2 });
    assert.strictEqual(h.count, 2);
    assert.deepStrictEqual(h.events.map((e) => e.type), ['ding', 'motion']);
    assert.strictEqual(h.events[0].camera, 'Front Door');
    const one = await H.call('history', { camera: '123456', hours: 1, types: ['motion'] });
    assert.strictEqual(one.camera, 'Front Door');
    assert.match((await H.call('history', { hours: 500 })).error, /between 1 and 168/);
    assert.match((await H.call('history', { camera: 'Nowhere' })).error, /unknown camera/);

    const s = await H.call('still', { camera: 'Front Door', mode: 'latest', minutes: 30 });
    assert.strictEqual(s.mode, 'latest');
    assert.match(s.still.file, /^events\/\d{4}-\d{2}-\d{2}\/\d{4}-front-door-latest\.jpg$/);
    assert.strictEqual(s.still.path, path.join(mediaDir, s.still.file));
    assert.deepStrictEqual([...fs.readFileSync(s.still.path).subarray(0, 2)], [0xff, 0xd8]);
    assert.strictEqual(fs.statSync(s.still.path).mode & 0o777, 0o664);
    assert.match((await H.call('still', { camera: 'Front Door', minutes: 5000 })).error, /between 1 and 1440/);
    assert.match((await H.call('still', { camera: 'Front Door', mode: 'x' })).error, /latest/);
    assert.match((await H.call('clip', { camera: 'Front Door', mode: 'recorded', seconds: 30 })).error, /needs "start"/);
    assert.match((await H.call('clip', { camera: 'Front Door', mode: 'recorded', start: '2999-01-01 10:00' })).error, /past/);
    assert.match((await H.call('faces', { still: '../../etc/passwd' })).error, /path of a camera still/);
    const f = await H.call('faces', { still: s.still.file });
    assert.ok(f.error && /no face check|not|off/i.test(f.error) || f.faces, JSON.stringify(f));
  });

  await t.test('still/clip/faces run one at a time; status/history/health run in parallel', async () => {
    const results = await Promise.all([1, 2, 3].map(() => H.call('still', { camera: 'Front Door', mode: 'latest' })));
    assert.strictEqual(new Set(results.map((r) => r.still.file)).size, 3, 'three different files');
    const [a, b, c] = await Promise.all([H.call('status'), H.call('health'), H.call('history', { camera: 'all' })]);
    assert.strictEqual(a.linked, true);
    assert.strictEqual(c.count, 2);
    assert.strictEqual(b.ok, true);
    assert.strictEqual(b.linked, true);
    assert.strictEqual(b.secrets_present, true);
    assert.strictEqual(b.ring_reachable, true);
    assert.strictEqual(b.unsaved_token, false);
    assert.strictEqual(b.unreadable_state, false);
    assert.ok(!JSON.stringify(b).includes('Front Door'), 'no camera data in health');
    assert.strictEqual(typeof b.tools.ffmpeg, 'boolean');
  });

  await t.test('nothing but JSON-RPC on stdout; no secret, token, code or key in the logs; the process stops when stdin ends', async () => {
    for (const line of H.stdout) assert.doesNotThrow(() => JSON.parse(line));
    for (const secret of ['csec', HMAC_KEY, 'ref-1', 'acc-1', 'good-code']) assert.ok(!H.stderr.includes(secret), `stderr holds ${secret}`);
    const r = await H.stop();
    assert.ok(r && r.code === 0, JSON.stringify(r));
  });
});

// ── (c) nothing personal in the folder ──
test('no personal or place names, agent names or home paths anywhere in modules/ring', () => {
  const files = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } })(DIR);
  assert.ok(files.length >= 13, `found ${files.length} files`);
  const banned = [/\/home\//, /\/Users\//, /~\/\./, /ring-bridge/i];   // names are kept out by the pre-push scan, never listed here
  const emails = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g;
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const re of banned) assert.ok(!re.test(text), `${path.relative(DIR, f)} matches ${re}`);
    for (const m of text.matchAll(emails)) assert.match(m[0], /@(example\.(com|net|org)|[a-z.]*example\.(com|net|org))$/, `${path.relative(DIR, f)} has the address ${m[0]}`);
  }
});
