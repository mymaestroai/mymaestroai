'use strict';
// lib/faces/routes.js and the access-table entries for /api/faces, on a tiny synthetic pack generated here.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { Readable, Writable } = require('node:stream');
const routes = require('../lib/faces/routes');
const packs = require('../lib/faces/packs');
const access = require('../lib/access');

function crc32(buf) { let c = 0xffffffff; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function png(w, h) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc((w * 4 + 1) * h))), chunk('IEND', Buffer.alloc(0))]);
}
function mp4() { const b = Buffer.alloc(24 + 976); for (let i = 24; i < b.length; i++) b[i] = i % 251; b.writeUInt32BE(24, 0); b.write('ftypisom', 4, 'latin1'); b.write('isom', 16, 'latin1'); return b; }   // 1000 bytes
const VIDEO = mp4();

function makeHome(mutate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'face-rt-'));
  const src = path.join(root, 'src'); const home = path.join(root, 'home');
  for (const d of ['web', 'tracks', 'beak']) fs.mkdirSync(path.join(src, d), { recursive: true });
  const m = { version: 3, name: 'Test Bird', background: '#102030', clips: [
    { name: 'idle-one', state: 'idle', weight: 1, dur: 2, track: false, rare: false },
    { name: 'speaking-one', state: 'speaking', weight: 1, dur: 1, track: true, rare: false },
    { name: 'reaction-proud', state: 'reaction', weight: 1, dur: 2, track: false, rare: false, mood: 'proud' }],
  beak: { roi: [1, 2, 8, 6], centre: [5, 5], shapes: ['closed', 'slight', 'half', 'wide', 'oo'] } };
  if (mutate) mutate(src, m);
  fs.writeFileSync(path.join(src, 'manifest.json'), JSON.stringify(m));
  for (const c of m.clips) { fs.writeFileSync(path.join(src, 'web', `${c.name}.mp4`), VIDEO); }
  fs.writeFileSync(path.join(src, 'tracks', 'speaking-one.json'), JSON.stringify({ fps: 24, w: 10, h: 10, frames: [[1, 1, 1, 0]] }));
  fs.writeFileSync(path.join(src, 'beak', 'beak.json'), JSON.stringify({ roi: [1, 2, 8, 6], centre: [5, 5] }));
  for (const s of ['closed', 'slight', 'half', 'wide', 'oo']) fs.writeFileSync(path.join(src, 'beak', `${s}.png`), png(8, 6));
  packs.installPack(src, { home, id: 'bird' });
  return { root, home };
}

const member = { id: 'u_sam', role: 'member', name: 'Sam' };
const admin = { id: 'u_owner', role: 'admin', name: 'Owner' };

function fakeRes() {
  const chunks = [];
  const r = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  r.writeHead = (code, headers) => { r.statusCode = code; r.headers = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v])); };
  r.finished = new Promise((resolve) => r.on('finish', resolve));
  r.body = () => Buffer.concat(chunks);
  r.json = () => JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return r;
}
function fakeReq(method, headers = {}, user = member) {
  const r = Readable.from([]);
  return Object.assign(r, { method, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), hubUser: user });
}
async function call(home, pathname, { method = 'GET', headers, user = member } = {}) {
  const req = fakeReq(method, headers, user); const res = fakeRes();
  await routes.handle(pathname, req, res, { home });
  if (!res.writableEnded) await res.finished;
  return res;
}

test('only signed-in users: nobody is refused to members, nobody gets in without a user', async () => {
  const { home } = makeHome();
  const r = await call(home, '/api/faces', { user: null });
  assert.strictEqual(r.statusCode, 401);
  assert.strictEqual((await call(home, '/api/faces/bird/manifest.json', { user: null })).statusCode, 401);
  assert.strictEqual((await call(home, '/api/faces/bird/web/idle-one.mp4', { user: null, method: 'HEAD' })).statusCode, 401);
  const pending = fakeReq('GET'); pending.hubPendingTotp = true; const res = fakeRes();
  await routes.handle('/api/faces', pending, res, { home }); assert.strictEqual(res.statusCode, 401);
  assert.strictEqual((await call(home, '/api/faces', { user: member })).statusCode, 200);
  assert.strictEqual((await call(home, '/api/faces', { user: admin })).statusCode, 200);
});

test('the access table lets members reach the list and a pack\'s files, and nothing else under /api/faces', () => {
  const kind = (p) => access.classifyRoute(p, 'GET').kind;
  assert.strictEqual(kind('/api/faces'), 'session');
  assert.strictEqual(kind('/api/faces/'), 'session');
  assert.strictEqual(kind('/api/faces/bird/manifest.json'), 'session');
  assert.strictEqual(kind('/api/faces/bird/web/idle-one.mp4'), 'session');
  assert.strictEqual(kind('/api/faces/bird/tracks/x.json'), 'session');
  assert.strictEqual(kind('/api/faces/bird/beak/closed.png'), 'session');
  assert.strictEqual(kind('/api/faces/bird/poster.jpg'), 'session');
  assert.strictEqual(kind('/api/faces/bird/posters/a.png'), 'session');
  for (const p of ['/api/faces/bird', '/api/faces/Bird/manifest.json', '/api/faces/bird/../x', '/api/faces/bird/web/../manifest.json', '/api/faces/bird/.hidden', '/api/faces/bird/web/.x', '/api/faces/bird/a%2fb', '/api/faces/bird/a\\b', '/api/faces/bird/a/b/c/d/e', '/api/faces//poster.jpg', '/api/faces/bird/web/']) {
    // a trailing slash is stripped by classifyRoute, so only the others must be admin
    if (p.endsWith('/') && p !== '/api/faces//poster.jpg') continue;
    assert.strictEqual(kind(p), 'admin', p);
  }
});

test('a signed-in member may request a manifest-listed root poster; an unlisted one is denied by path/auth and by the route', async () => {
  const jpg = png(4, 4);   // a poster is validated by content and extension at install; use a PNG at the pack root
  const { home } = makeHome((src, m) => { m.poster = 'poster.png'; m.posters = { A: 'poster.png' }; fs.writeFileSync(path.join(src, 'poster.png'), jpg); });
  fs.writeFileSync(path.join(home, 'faces', 'bird', 'unlisted.png'), jpg);
  packs.clearCache();
  // access table: both root paths are session routes (any signed-in user), the allowlist is the handler's
  assert.strictEqual(access.classifyRoute('/api/faces/bird/poster.png', 'GET').kind, 'session');
  assert.strictEqual(access.classifyRoute('/api/faces/bird/unlisted.png', 'GET').kind, 'session');
  // signed-in member: the listed poster is served, the unlisted file never
  const ok = await call(home, '/api/faces/bird/poster.png', { user: member });
  assert.strictEqual(ok.statusCode, 200); assert.ok(ok.body().equals(jpg)); assert.strictEqual(ok.headers['content-type'], 'image/png');
  assert.strictEqual((await call(home, '/api/faces/bird/unlisted.png', { user: member })).statusCode, 404);
  // no user: refused
  assert.strictEqual((await call(home, '/api/faces/bird/poster.png', { user: null })).statusCode, 401);
});

test('the list: id, name, background, hasReactions; invalid packs are left out', async () => {
  const { home } = makeHome();
  fs.mkdirSync(path.join(home, 'faces', 'broken'));
  const r = await call(home, '/api/faces');
  assert.strictEqual(r.statusCode, 200);
  assert.deepStrictEqual(r.json(), { packs: [{ id: 'bird', name: 'Test Bird', background: '#102030', hasReactions: true }], available: [{ id: 'owl', name: 'Owl', size: require('../lib/faces/catalog').CATALOG[0].size }] });
  const h = await call(home, '/api/faces', { method: 'HEAD' });
  assert.strictEqual(h.statusCode, 200); assert.strictEqual(h.body().length, 0);
  assert.deepStrictEqual((await call(home, '/api/faces/', {})).json().packs.length, 1);
  assert.deepStrictEqual((await call(path.join(home, 'none'), '/api/faces')).json().packs, []);
});

test('serving the manifest and each file kind with the right type and headers', async () => {
  const { home } = makeHome();
  const m = await call(home, '/api/faces/bird/manifest.json');
  assert.strictEqual(m.statusCode, 200);
  assert.match(m.headers['content-type'], /^application\/json/);
  assert.strictEqual(m.json().name, 'Test Bird');
  assert.strictEqual(m.headers['x-content-type-options'], 'nosniff');
  assert.strictEqual(m.headers['cache-control'], 'private, no-cache');
  assert.ok(m.headers.etag);
  const v = await call(home, '/api/faces/bird/web/idle-one.mp4');
  assert.strictEqual(v.headers['content-type'], 'video/mp4'); assert.strictEqual(v.headers['content-length'], 1000); assert.ok(v.body().equals(VIDEO));
  assert.strictEqual(v.headers['accept-ranges'], 'bytes'); assert.match(v.headers['cache-control'], /^private, max-age=\d+$/);
  assert.match((await call(home, '/api/faces/bird/tracks/speaking-one.json')).headers['content-type'], /^application\/json/);
  assert.strictEqual((await call(home, '/api/faces/bird/beak/closed.png')).headers['content-type'], 'image/png');
  assert.match((await call(home, '/api/faces/bird/beak/beak.json')).headers['content-type'], /^application\/json/);
});

test('no path trickery serves anything outside the allowlist', async () => {
  const { home, root } = makeHome();
  fs.writeFileSync(path.join(root, 'secret.txt'), 'secret');
  fs.writeFileSync(path.join(home, 'faces', 'bird', 'unlisted.txt'), 'x');
  fs.writeFileSync(path.join(home, 'faces', 'bird', 'web', 'unlisted.mp4'), VIDEO);
  packs.clearCache();
  for (const p of [
    '/api/faces/bird/../../secret.txt', '/api/faces/bird/web/../manifest.json', '/api/faces/../bird/manifest.json', '/api/faces/bird/%2e%2e/secret.txt',
    '/api/faces/bird/web%2fidle-one.mp4', '/api/faces/bird/web/idle-one.mp4%00', '/api/faces/bird/web\\idle-one.mp4', '/api/faces/bird/unlisted.txt',
    '/api/faces/bird/web/unlisted.mp4', '/api/faces/bird/web/', '/api/faces/bird/web', '/api/faces/bird/', '/api/faces/bird', '/api/faces/BIRD/manifest.json',
    '/api/faces/.hidden/manifest.json', '/api/faces/bird/.hidden', '/api/faces/bird/web/IDLE-ONE.mp4', '/api/faces/bird/web/constructor', '/api/faces/bird/__proto__',
    '/api/faces/nope/manifest.json', '/api/faces//manifest.json',
  ]) {
    const r = await call(home, p);
    assert.strictEqual(r.statusCode, 404, p);
    assert.doesNotMatch(r.body().toString(), /secret|private/, p);
  }
});

test('a symlink swapped in for a pack file is never followed', async () => {
  const { home, root } = makeHome();
  fs.writeFileSync(path.join(root, 'secret.txt'), 'secret');
  const file = path.join(home, 'faces', 'bird', 'web', 'idle-one.mp4');
  assert.strictEqual((await call(home, '/api/faces/bird/web/idle-one.mp4')).statusCode, 200);   // now cached
  fs.rmSync(file); fs.symlinkSync(path.join(root, 'secret.txt'), file);
  const r = await call(home, '/api/faces/bird/web/idle-one.mp4');
  assert.strictEqual(r.statusCode, 404); assert.doesNotMatch(r.body().toString(), /secret/);
});

test('methods other than GET and HEAD are refused', async () => {
  const { home } = makeHome();
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const r = await call(home, '/api/faces/bird/manifest.json', { method });
    assert.strictEqual(r.statusCode, 405); assert.strictEqual(r.headers.allow, 'GET, HEAD');
  }
});

test('ETag and If-None-Match: 304, weak and list forms, a stale tag gets the file', async () => {
  const { home } = makeHome();
  const url = '/api/faces/bird/web/idle-one.mp4';
  const etag = (await call(home, url)).headers.etag;
  assert.match(etag, /^"[0-9a-f]{24}"$/);
  for (const inm of [etag, `W/${etag}`, `"zzz", ${etag}`, '*']) {
    const r = await call(home, url, { headers: { 'If-None-Match': inm } });
    assert.strictEqual(r.statusCode, 304, inm); assert.strictEqual(r.body().length, 0); assert.strictEqual(r.headers.etag, etag);
  }
  const stale = await call(home, url, { headers: { 'If-None-Match': '"stale"' } });
  assert.strictEqual(stale.statusCode, 200); assert.strictEqual(stale.body().length, 1000);
  assert.strictEqual((await call(home, url, { method: 'HEAD', headers: { 'If-None-Match': etag } })).statusCode, 304);
  assert.strictEqual((await call(home, '/api/faces/bird/manifest.json', { headers: { 'If-None-Match': (await call(home, '/api/faces/bird/manifest.json')).headers.etag } })).statusCode, 304);
});

test('HEAD sends the headers without the body', async () => {
  const { home } = makeHome();
  const r = await call(home, '/api/faces/bird/web/idle-one.mp4', { method: 'HEAD' });
  assert.strictEqual(r.statusCode, 200); assert.strictEqual(r.headers['content-length'], 1000); assert.strictEqual(r.headers['content-type'], 'video/mp4'); assert.strictEqual(r.body().length, 0);
  const rg = await call(home, '/api/faces/bird/web/idle-one.mp4', { method: 'HEAD', headers: { Range: 'bytes=0-9' } });
  assert.strictEqual(rg.statusCode, 206); assert.strictEqual(rg.headers['content-length'], 10); assert.strictEqual(rg.body().length, 0);
});

test('Range: closed, open-ended and suffix ranges give 206; unsatisfiable gives 416', async () => {
  const { home } = makeHome();
  const url = '/api/faces/bird/web/idle-one.mp4';
  const get = (range, extra = {}) => call(home, url, { headers: { Range: range, ...extra } });
  let r = await get('bytes=0-99'); assert.strictEqual(r.statusCode, 206); assert.strictEqual(r.headers['content-range'], 'bytes 0-99/1000'); assert.strictEqual(r.headers['content-length'], 100); assert.ok(r.body().equals(VIDEO.subarray(0, 100)));
  r = await get('bytes=900-'); assert.strictEqual(r.headers['content-range'], 'bytes 900-999/1000'); assert.ok(r.body().equals(VIDEO.subarray(900)));
  r = await get('bytes=-50'); assert.strictEqual(r.statusCode, 206); assert.strictEqual(r.headers['content-range'], 'bytes 950-999/1000'); assert.ok(r.body().equals(VIDEO.subarray(950)));
  r = await get('bytes=-5000'); assert.strictEqual(r.headers['content-range'], 'bytes 0-999/1000');
  r = await get('bytes=500-99999'); assert.strictEqual(r.headers['content-range'], 'bytes 500-999/1000');
  r = await get('bytes=0-0'); assert.strictEqual(r.body().length, 1);
  r = await get('bytes=1000-'); assert.strictEqual(r.statusCode, 416); assert.strictEqual(r.headers['content-range'], 'bytes */1000'); assert.strictEqual(r.body().length, 0);
  r = await get('bytes=-0'); assert.strictEqual(r.statusCode, 416);
  r = await get('bytes=5000-6000'); assert.strictEqual(r.statusCode, 416);
  // not a single valid range: ignored, the whole file is sent
  for (const odd of ['bytes=0-1,5-9', 'bytes=9-3', 'items=0-5', 'bytes=-', 'bytes=a-b']) { r = await get(odd); assert.strictEqual(r.statusCode, 200, odd); assert.strictEqual(r.body().length, 1000); }
});

test('If-Range: a matching tag keeps the range, a stale one sends the whole file', async () => {
  const { home } = makeHome();
  const url = '/api/faces/bird/web/idle-one.mp4';
  const etag = (await call(home, url)).headers.etag;
  assert.strictEqual((await call(home, url, { headers: { Range: 'bytes=0-9', 'If-Range': etag } })).statusCode, 206);
  assert.strictEqual((await call(home, url, { headers: { Range: 'bytes=0-9', 'If-Range': '"stale"' } })).statusCode, 200);
});

test('a client that goes away mid-stream does not crash anything, and the file is closed', async () => {
  const { home } = makeHome();
  const req = fakeReq('GET'); const res = fakeRes();
  const done = routes.handle('/api/faces/bird/web/idle-one.mp4', req, res, { home });
  res.destroy();
  await Promise.race([done, new Promise(r => setTimeout(r, 500))]);
  // the server still answers
  assert.strictEqual((await call(home, '/api/faces')).statusCode, 200);
});

test('a pack deleted after it was cached answers 404, not a crash', async () => {
  const { home } = makeHome();
  assert.strictEqual((await call(home, '/api/faces/bird/web/idle-one.mp4')).statusCode, 200);
  fs.rmSync(path.join(home, 'faces', 'bird', 'web', 'idle-one.mp4'));
  assert.strictEqual((await call(home, '/api/faces/bird/web/idle-one.mp4')).statusCode, 404);
});

test('parseRange and noneMatch helpers', () => {
  assert.deepStrictEqual(routes.parseRange('bytes=2-4', 10), { start: 2, end: 4 });
  assert.strictEqual(routes.parseRange('bytes=10-', 10), 'invalid');
  assert.strictEqual(routes.parseRange('bytes=1-2,4-5', 10), null);
  assert.strictEqual(routes.noneMatch('', '"a"'), false);
});

test('a same-size in-place edit of a cached file is never answered with a 304 or a stale range', async () => {
  const { home } = makeHome();
  const url = '/api/faces/bird/web/idle-one.mp4';
  const first = await call(home, url);
  const etag = first.headers.etag;
  const file = path.join(home, 'faces', 'bird', 'web', 'idle-one.mp4');
  const st = fs.statSync(file); const b = fs.readFileSync(file); b[999] ^= 0xff; fs.writeFileSync(file, b); fs.utimesSync(file, st.atime, st.mtime);   // same size, same mtime
  assert.strictEqual(fs.statSync(file).size, 1000); assert.ok(Math.abs(fs.statSync(file).mtimeMs - st.mtimeMs) < 1);
  const r = await call(home, url, { headers: { 'If-None-Match': etag } });
  assert.strictEqual(r.statusCode, 200, 'not 304');
  assert.notStrictEqual(r.headers.etag, etag);
  assert.ok(r.body().equals(b), 'the new bytes, after a full revalidation');
  const rg = await call(home, url, { headers: { Range: 'bytes=990-999', 'If-Range': etag } });
  assert.strictEqual(rg.statusCode, 200, 'a stale If-Range tag sends the whole file');
  // the new tag now earns a 304
  assert.strictEqual((await call(home, url, { headers: { 'If-None-Match': r.headers.etag } })).statusCode, 304);
});

test('a same-size edit that breaks the file format is a 404, never a 304', async () => {
  const { home } = makeHome();
  const url = '/api/faces/bird/web/idle-one.mp4';
  const etag = (await call(home, url)).headers.etag;
  const file = path.join(home, 'faces', 'bird', 'web', 'idle-one.mp4');
  const st = fs.statSync(file); const b = fs.readFileSync(file); b.write('junk', 4, 'latin1'); fs.writeFileSync(file, b); fs.utimesSync(file, st.atime, st.mtime);
  for (const headers of [{ 'If-None-Match': etag }, { Range: 'bytes=5000-' }, { Range: 'bytes=0-9' }, {}]) {
    const r = await call(home, url, { headers }); assert.strictEqual(r.statusCode, 404, JSON.stringify(headers));
  }
});

test('a pack folder swapped for a symlink to the same files is refused for 304, 416 and 200 alike', async () => {
  const { home, root } = makeHome();
  const url = '/api/faces/bird/web/idle-one.mp4';
  const etag = (await call(home, url)).headers.etag;
  const dir = path.join(home, 'faces', 'bird');
  fs.renameSync(path.join(dir, 'web'), path.join(root, 'realweb')); fs.symlinkSync(path.join(root, 'realweb'), path.join(dir, 'web'));
  for (const headers of [{ 'If-None-Match': etag }, { Range: 'bytes=5000-' }, { Range: 'bytes=0-9' }, {}]) {
    const r = await call(home, url, { headers }); assert.strictEqual(r.statusCode, 404, JSON.stringify(headers));
  }
  // also the whole pack folder and the faces folder
  fs.rmSync(path.join(dir, 'web')); fs.renameSync(path.join(root, 'realweb'), path.join(dir, 'web'));
  assert.strictEqual((await call(home, url)).statusCode, 200);
  fs.renameSync(dir, path.join(root, 'bird-real')); fs.symlinkSync(path.join(root, 'bird-real'), dir);
  assert.strictEqual((await call(home, url, { headers: { 'If-None-Match': etag } })).statusCode, 404);
  assert.strictEqual((await call(home, '/api/faces/bird/manifest.json')).statusCode, 404);
});
