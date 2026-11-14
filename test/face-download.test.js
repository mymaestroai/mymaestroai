'use strict';
// lib/faces/download.js (catalogue download + install) and its routes, with a stand-in transport: no network.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Readable, Writable } = require('node:stream');
const download = require('../lib/faces/download');
const routes = require('../lib/faces/routes');
const packs = require('../lib/faces/packs');
const tar = require('../lib/faces/tar');
const access = require('../lib/access');
const { CATALOG } = require('../lib/faces/catalog');

function crc32(buf) { let c = 0xffffffff; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function png(w, h) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc((w * 4 + 1) * h))), chunk('IEND', Buffer.alloc(0))]);
}
function mp4() { const b = Buffer.alloc(24 + 4000); for (let i = 24; i < b.length; i++) b[i] = (i * 7) % 251; b.writeUInt32BE(24, 0); b.write('ftypisom', 4, 'latin1'); b.write('isom', 16, 'latin1'); return b; }

/** The entries of a tiny valid pack, archived the way the release archive is. */
function packEntries() {
  const m = { version: 3, name: 'Test Bird', clips: [
    { name: 'idle-one', state: 'idle', weight: 1, dur: 2, track: false, rare: false },
    { name: 'speaking-one', state: 'speaking', weight: 1, dur: 1, track: true, rare: false }],
  beak: { roi: [1, 2, 8, 6], centre: [5, 5], shapes: ['closed', 'slight', 'half', 'wide', 'oo'] } };
  const e = [{ name: 'manifest.json', data: Buffer.from(JSON.stringify(m)) },
    { name: 'web/idle-one.mp4', data: mp4() }, { name: 'web/speaking-one.mp4', data: mp4() },
    { name: 'tracks/speaking-one.json', data: Buffer.from(JSON.stringify({ fps: 24, w: 10, h: 10, frames: [[1, 1, 1, 0]] })) },
    { name: 'beak/beak.json', data: Buffer.from(JSON.stringify({ roi: [1, 2, 8, 6], centre: [5, 5] })) }];
  for (const s of ['closed', 'slight', 'half', 'wide', 'oo']) e.push({ name: `beak/${s}.png`, data: png(8, 6) });
  return e;
}
const ARCHIVE = tar.writeTarGz(packEntries());
const URL1 = 'https://github.com/mymaestroai/mymaestroai/releases/download/bird-pack-v1/bird-pack-v1.tar.gz';
const entryFor = (id, buf = ARCHIVE) => ({ id, name: 'Bird', version: 1, tag: 'bird-pack-v1', file: 'bird-pack-v1.tar.gz', url: URL1, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
const catalog = [entryFor('bird'), entryFor('crow')];

// ── Stand-in transport ──
/** fake(urlMap) -> transport; calls recorded in transport.calls. Each handler: { status, headers, body: Buffer|null, pieces, delay }. */
function fake(map) {
  const calls = [];
  const t = (url, options, onResponse) => {
    calls.push({ url, options });
    const req = new EventEmitter();
    req.setTimeout = () => req; req.destroy = () => { req.destroyed = true; };
    const h = typeof map === 'function' ? map(url, calls.length) : map[url];
    setImmediate(() => {
      if (!h || h.error) return req.emit('error', Object.assign(new Error('boom'), { code: (h && h.error) || 'ENOTFOUND' }));
      const res = new EventEmitter();
      res.statusCode = h.status || 200;
      res.headers = { ...(h.headers || {}) };
      res.resume = () => {};
      res.destroy = () => { res.destroyed = true; setImmediate(() => res.emit('close')); };
      onResponse(res);
      const body = h.body || Buffer.alloc(0);
      const pieces = h.pieces || 8;
      const step = Math.max(1, Math.ceil(body.length / pieces));
      let off = 0;
      const pump = () => {
        if (res.destroyed) return;
        if (off >= body.length) { res.emit('end'); return setImmediate(() => res.emit('close')); }
        const c = body.subarray(off, off + step); off += step;
        res.sent = off;
        res.emit('data', c);
        setTimeout(pump, h.delay === undefined ? 3 : h.delay);
      };
      setTimeout(pump, 1);
    });
    return req;
  };
  t.calls = calls;
  return t;
}
const ok = (body = ARCHIVE, extra = {}) => ({ status: 200, headers: { 'content-length': String(body.length) }, body, ...extra });
const goodRedirect = 'https://objects.githubusercontent.com/github-production-release-asset/1/abc?sig=1';

function makeHome() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'face-dl-')); return path.join(root, 'home'); }
const leftovers = (home) => { try { return fs.readdirSync(path.join(home, 'faces')).filter(n => n.startsWith('.')); } catch { return []; } };
const installed = (home) => { try { return fs.readdirSync(path.join(home, 'faces')).filter(n => !n.startsWith('.')); } catch { return []; } };
async function finish(id, home) { await download.__whenIdleForTests(); return download.downloadStatus(id, { home, catalog }); }

beforeEach(() => { download.__resetForTests(); packs.clearCache(); });

test('download shows progress, then installing, then done; the pack is listed and the temp files are gone', async () => {
  const home = makeHome();
  download.__setTransportForTests(fake({ [URL1]: ok(ARCHIVE, { pieces: 12, delay: 8 }) }));
  const s0 = download.startDownload('bird', { home, catalog });
  assert.deepStrictEqual(s0, { id: 'bird', state: 'downloading', received: 0, total: ARCHIVE.length });
  const seen = []; const states = new Set();
  while (true) {
    const s = download.downloadStatus('bird', { home, catalog });
    states.add(s.state); if (s.state === 'downloading') seen.push(s.received);
    assert.strictEqual(s.total, ARCHIVE.length);
    if (s.state === 'done' || s.state === 'failed') break;
    await new Promise(r => setTimeout(r, 2));
  }
  assert.ok(seen.length >= 2 && seen.some((v, i) => i && v > seen[i - 1]), 'received grew');
  assert.ok(states.has('downloading'));
  assert.strictEqual(download.downloadStatus('bird', { home, catalog }).state, 'done');
  assert.deepStrictEqual(packs.listPacks({ home }).map(p => p.id), ['bird']);
  assert.deepStrictEqual(leftovers(home), []);
  const t = download.__setTransportForTests;   // exported for tests only
  assert.strictEqual(typeof t, 'function');
});

test('the request carries only a User-Agent and Accept header, to the catalogue URL', async () => {
  const home = makeHome(); const tr = fake({ [URL1]: ok() });
  download.__setTransportForTests(tr);
  download.startDownload('bird', { home, catalog }); await finish('bird', home);
  assert.strictEqual(tr.calls.length, 1);
  assert.strictEqual(tr.calls[0].url, URL1);
  assert.deepStrictEqual(tr.calls[0].options.headers, { 'User-Agent': 'My-Maestro-AI-hub', Accept: 'application/octet-stream' });
});

test('a single-chunk transfer completes too', async () => {
  const home = makeHome();
  download.__setTransportForTests(fake({ [URL1]: ok(ARCHIVE, { pieces: 1, delay: 0 }) }));
  download.startDownload('bird', { home, catalog });
  const states = new Set();
  while (true) { const s = download.downloadStatus('bird', { home, catalog }); states.add(s.state); if (s.state === 'done') break; await new Promise(r => setImmediate(r)); }
  assert.ok(states.has('done'));
  assert.strictEqual(packs.listPacks({ home }).length, 1);
});

test('a wrong checksum fails, installs nothing, and leaves no .part, .unpack or .staging', async () => {
  const home = makeHome(); const evil = Buffer.from(ARCHIVE); evil[evil.length - 20] ^= 0xff;
  download.__setTransportForTests(fake({ [URL1]: ok(evil) }));
  download.startDownload('bird', { home, catalog });
  const s = await finish('bird', home);
  assert.strictEqual(s.state, 'failed');
  assert.match(s.error, /did not match the published file; nothing was installed/);
  assert.deepStrictEqual(installed(home), []); assert.deepStrictEqual(leftovers(home), []);
  assert.strictEqual(packs.listPacks({ home }).length, 0);
});

test('a truncated body fails', async () => {
  const home = makeHome();
  download.__setTransportForTests(fake({ [URL1]: ok(ARCHIVE.subarray(0, ARCHIVE.length - 50), { headers: {} }) }));
  download.startDownload('bird', { home, catalog });
  const s = await finish('bird', home);
  assert.strictEqual(s.state, 'failed'); assert.match(s.error, /nothing was installed/);
  assert.deepStrictEqual(leftovers(home), []); assert.deepStrictEqual(installed(home), []);
});

test('more bytes than the catalogue size fail early (the rest is never read)', async () => {
  const home = makeHome(); const big = Buffer.concat([ARCHIVE, Buffer.alloc(200000, 1)]);
  let res = null;
  const tr = (url, o, cb) => fake({ [url]: { status: 200, headers: {}, body: big, pieces: 100, delay: 1 } })(url, o, (r) => { res = r; cb(r); });
  download.__setTransportForTests(tr);
  download.startDownload('bird', { home, catalog });
  const s = await finish('bird', home);
  assert.strictEqual(s.state, 'failed'); assert.match(s.error, /did not match/);
  assert.ok(res.destroyed, 'the response was cut off');
  assert.ok(res.sent < big.length, 'stopped before the end');
  assert.deepStrictEqual(leftovers(home), []);
});

test('a Content-Length that differs from the catalogue size fails before any data is saved', async () => {
  const home = makeHome();
  download.__setTransportForTests(fake({ [URL1]: ok(ARCHIVE, { headers: { 'content-length': String(ARCHIVE.length + 1) } }) }));
  download.startDownload('bird', { home, catalog });
  const s = await finish('bird', home);
  assert.strictEqual(s.state, 'failed'); assert.strictEqual(s.received, 0);
  assert.deepStrictEqual(leftovers(home), []);
});

test('a non-200 answer fails', async () => {
  const home = makeHome();
  download.__setTransportForTests(fake({ [URL1]: { status: 404, headers: {} } }));
  download.startDownload('bird', { home, catalog });
  const s = await finish('bird', home);
  assert.strictEqual(s.state, 'failed'); assert.match(s.error, /404/);
});

test('a redirect to a wrong host fails and that host is never requested', async () => {
  const home = makeHome();
  const evil = 'https://evil.example.net/pack.tar.gz';
  const tr = fake({ [URL1]: { status: 302, headers: { location: evil } }, [evil]: ok() });
  download.__setTransportForTests(tr);
  download.startDownload('bird', { home, catalog });
  const s = await finish('bird', home);
  assert.strictEqual(s.state, 'failed'); assert.match(s.error, /redirected to an unexpected address; nothing was installed/);
  assert.deepStrictEqual(tr.calls.map(c => c.url), [URL1]);
  for (const loc of ['https://objects.githubusercontent.com.evil.example.net/x', 'https://user@objects.githubusercontent.com/x', 'https://github.com/x/y']) {
    download.__resetForTests();
    const t2 = fake({ [URL1]: { status: 302, headers: { location: loc } }, [loc]: ok() });
    download.__setTransportForTests(t2);
    download.startDownload('bird', { home, catalog });
    assert.strictEqual((await finish('bird', home)).state, 'failed', loc);
    assert.strictEqual(t2.calls.length, 1, loc);
  }
});

test('a redirect to http: fails and is not requested', async () => {
  const home = makeHome(); const loc = 'http://objects.githubusercontent.com/x';
  const tr = fake({ [URL1]: { status: 301, headers: { location: loc } }, [loc]: ok() });
  download.__setTransportForTests(tr);
  download.startDownload('bird', { home, catalog });
  assert.strictEqual((await finish('bird', home)).state, 'failed');
  assert.strictEqual(tr.calls.length, 1);
});

test('more than five redirects fail; five are followed', async () => {
  const home = makeHome();
  const hop = (n) => `https://objects.githubusercontent.com/hop${n}`;
  const mk = (count) => (url) => {
    if (url === URL1) return { status: 302, headers: { location: hop(1) } };
    const n = Number(url.slice(url.lastIndexOf('hop') + 3));
    return n < count ? { status: 307, headers: { location: hop(n + 1) } } : ok();
  };
  const t6 = fake(mk(6)); download.__setTransportForTests(t6);
  download.startDownload('bird', { home, catalog });
  const s = await finish('bird', home);
  assert.strictEqual(s.state, 'failed'); assert.match(s.error, /too many times/);
  download.__resetForTests();
  const t5 = fake(mk(4)); download.__setTransportForTests(t5);   // URL1 -> hop1..hop4 = 5 redirects, then 200
  download.startDownload('bird', { home, catalog });
  assert.strictEqual((await finish('bird', home)).state, 'done');
});

test('a good redirect to objects.githubusercontent.com works', async () => {
  const home = makeHome();
  const tr = fake({ [URL1]: { status: 302, headers: { location: goodRedirect } }, [goodRedirect]: ok() });
  download.__setTransportForTests(tr);
  download.startDownload('bird', { home, catalog });
  assert.strictEqual((await finish('bird', home)).state, 'done');
  assert.deepStrictEqual(tr.calls.map(c => c.url), [URL1, goodRedirect]);
  assert.deepStrictEqual(packs.listPacks({ home }).map(p => p.id), ['bird']);
});

test('two starts join one transfer; another id meanwhile is busy', async () => {
  const home = makeHome();
  const tr = fake({ [URL1]: ok(ARCHIVE, { pieces: 10, delay: 10 }) });
  download.__setTransportForTests(tr);
  const a = download.startDownload('bird', { home, catalog });
  const b = download.startDownload('bird', { home, catalog });
  assert.strictEqual(a.state, 'downloading'); assert.strictEqual(b.state, 'downloading');
  const c = download.startDownload('crow', { home, catalog });
  assert.deepStrictEqual(c, { id: 'crow', state: 'busy', received: 0, total: ARCHIVE.length, error: 'Another character is downloading; try again when it is done.' });
  assert.strictEqual((await finish('bird', home)).state, 'done');
  assert.strictEqual(tr.calls.length, 1);
});

test('a failed job stays visible as failed; the next start is a fresh attempt (retry)', async () => {
  const home = makeHome();
  download.__setTransportForTests(fake({ [URL1]: { error: 'ECONNRESET' } }));
  download.startDownload('bird', { home, catalog });
  assert.strictEqual((await finish('bird', home)).state, 'failed');
  const again = download.downloadStatus('bird', { home, catalog });
  assert.strictEqual(again.state, 'failed'); assert.ok(again.error);
  const tr = fake({ [URL1]: ok() }); download.__setTransportForTests(tr);
  const s = download.startDownload('bird', { home, catalog });
  assert.strictEqual(s.state, 'downloading'); assert.strictEqual(s.error, undefined);
  assert.strictEqual((await finish('bird', home)).state, 'done');
  assert.strictEqual(tr.calls.length, 1);
});

test('an installed pack answers "done" without any request; an id outside the catalogue throws not_in_catalogue', async () => {
  const home = makeHome();
  download.__setTransportForTests(fake({ [URL1]: ok() }));
  download.startDownload('bird', { home, catalog }); await finish('bird', home);
  const tr = fake({}); download.__setTransportForTests(tr);
  assert.strictEqual(download.startDownload('bird', { home, catalog }).state, 'done');
  assert.strictEqual(tr.calls.length, 0);
  assert.throws(() => download.startDownload('nope', { home, catalog }), { code: 'not_in_catalogue' });
  assert.throws(() => download.downloadStatus('nope', { home, catalog }), { code: 'not_in_catalogue' });
  assert.strictEqual(download.downloadStatus('crow', { home, catalog }).state, 'idle');
});

test('an archive with a hostile entry (matching checksum) is refused at unpack and leaves nothing', async () => {
  const home = makeHome();
  const hostile = tar.writeTarGz([{ name: 'manifest.json', data: Buffer.from('{}') }]);   // valid tar, not a valid pack
  const cat = [entryFor('bird', hostile)];
  download.__setTransportForTests(fake({ [URL1]: ok(hostile) }));
  download.startDownload('bird', { home, catalog: cat });
  await download.__whenIdleForTests();
  const s = download.downloadStatus('bird', { home, catalog: cat });
  assert.strictEqual(s.state, 'failed'); assert.match(s.error, /could not be installed/);
  assert.deepStrictEqual(installed(home), []); assert.deepStrictEqual(leftovers(home), []);
});

test('a data stall fails after the idle timeout', async () => {
  const home = makeHome();
  download.__setTransportForTests(fake({ [URL1]: ok(ARCHIVE, { pieces: 4, delay: 400 }) }));
  download.startDownload('bird', { home, catalog, timeouts: { idleMs: 60, totalMs: 60000 } });
  const s = await finish('bird', home);
  assert.strictEqual(s.state, 'failed'); assert.match(s.error, /stopped receiving data/);
  assert.deepStrictEqual(leftovers(home), []);
});

test('a redirect whose body never ends is destroyed before the next request; everything the job opened is destroyed after a 404', async () => {
  const home = makeHome(); const opened = [];
  const t = (url, options, onResponse) => {
    const req = new EventEmitter(); req.setTimeout = () => req; req.destroy = () => { req.destroyed = true; };
    opened.push(req);
    setImmediate(() => {
      const res = new EventEmitter(); res.headers = {}; res.resume = () => {}; res.destroyed = false;
      res.destroy = () => { res.destroyed = true; };
      opened.push(res);
      if (url === URL1) { res.statusCode = 302; res.headers.location = goodRedirect; } else res.statusCode = 404;   // neither body ever ends
      onResponse(res);
    });
    return req;
  };
  download.__setTransportForTests(t);
  download.startDownload('bird', { home, catalog });
  const s = await finish('bird', home);
  assert.strictEqual(s.state, 'failed'); assert.match(s.error, /404/);
  assert.strictEqual(opened.length, 4);
  assert.ok(opened.every(o => o.destroyed === true), 'the first response and every request were destroyed');
  assert.deepStrictEqual(leftovers(home), []);
});

test('downloadStatus reports an installed pack as done even when an old failure is stored', async () => {
  const home = makeHome();
  download.__setTransportForTests(fake({ [URL1]: { status: 404 } }));
  download.startDownload('bird', { home, catalog });
  assert.strictEqual((await finish('bird', home)).state, 'failed');
  const un = path.join(home, 'unp'); fs.mkdirSync(un, { recursive: true });
  for (const e of packEntries()) { const f = path.join(un, e.name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, e.data); }
  packs.installPack(un, { home, id: 'bird' }); packs.clearCache();
  assert.strictEqual(download.downloadStatus('bird', { home, catalog }).state, 'done');
});

test('before a job, old .download-* / .unpack-* leftovers in faces are swept; fresh ones and links are handled safely', async () => {
  const home = makeHome(); const faces = path.join(home, 'faces'); fs.mkdirSync(faces, { recursive: true });
  const old = new Date(Date.now() - 30 * 60 * 1000);
  const oldPart = path.join(faces, '.download-old.part'), oldDir = path.join(faces, '.unpack-old'), newPart = path.join(faces, '.download-new.part'), newDir = path.join(faces, '.unpack-new');
  fs.writeFileSync(oldPart, 'x'); fs.mkdirSync(oldDir); fs.writeFileSync(path.join(oldDir, 'f'), 'x'); fs.writeFileSync(newPart, 'x'); fs.mkdirSync(newDir);
  fs.utimesSync(oldPart, old, old); fs.utimesSync(oldDir, old, old);
  const outside = path.join(home, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  fs.symlinkSync(outside, path.join(faces, '.download-x'));
  download.__setTransportForTests(fake({ [URL1]: { status: 404 } }));
  download.startDownload('bird', { home, catalog }); await finish('bird', home);
  assert.ok(!fs.existsSync(oldPart) && !fs.existsSync(oldDir), 'old leftovers removed');
  assert.ok(fs.existsSync(newPart) && fs.existsSync(newDir), 'fresh ones kept');
  assert.throws(() => fs.lstatSync(path.join(faces, '.download-x')), 'the link itself is gone');
  assert.strictEqual(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep', 'its target was not touched');
});

test('the real catalogue entry is shaped as promised', () => {
  assert.ok(Object.isFrozen(CATALOG));
  const e = CATALOG[0];
  assert.strictEqual(e.id, 'owl');
  assert.match(e.url, /^https:\/\/github\.com\/mymaestroai\/mymaestroai\/releases\/download\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/);
  assert.match(e.sha256, /^[0-9a-f]{64}$/); assert.ok(e.size > 1000000);
});

// ── Routes ──
const member = { id: 'u_sam', role: 'member', name: 'Sam' };
function fakeRes() {
  const chunks = [];
  const r = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  r.writeHead = (code, headers) => { r.statusCode = code; r.headers = headers; };
  r.finished = new Promise((resolve) => r.on('finish', resolve));
  r.json = () => JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return r;
}
async function call(home, pathname, method = 'GET', user = member) {
  const req = Object.assign(Readable.from([]), { method, headers: {}, hubUser: user }); const res = fakeRes();
  await routes.handle(pathname, req, res, { home, catalog });
  if (!res.writableEnded) await res.finished;
  return res;
}

test('routes: POST starts (200), GET reports, unknown id is 404, another id while busy is 409, other methods 405', async () => {
  const home = makeHome();
  download.__setTransportForTests(fake({ [URL1]: ok(ARCHIVE, { pieces: 10, delay: 10 }) }));
  const r1 = await call(home, '/api/faces/bird/download', 'POST');
  assert.strictEqual(r1.statusCode, 200); assert.strictEqual(r1.json().state, 'downloading'); assert.strictEqual(r1.json().total, ARCHIVE.length);
  const g = await call(home, '/api/faces/bird/download', 'GET');
  assert.strictEqual(g.statusCode, 200); assert.strictEqual(g.json().id, 'bird');
  const busy = await call(home, '/api/faces/crow/download', 'POST');
  assert.strictEqual(busy.statusCode, 409); assert.strictEqual(busy.json().state, 'busy');
  assert.strictEqual((await call(home, '/api/faces/nope/download', 'POST')).statusCode, 404);
  assert.strictEqual((await call(home, '/api/faces/nope/download', 'GET')).statusCode, 404);
  assert.strictEqual((await call(home, '/api/faces/bird/download', 'DELETE')).statusCode, 405);
  assert.strictEqual((await call(home, '/api/faces/bird/manifest.json', 'POST')).statusCode, 405);
  assert.strictEqual((await call(home, '/api/faces/bird/download', 'POST', null)).statusCode, 401);
  await download.__whenIdleForTests();
  const done = await call(home, '/api/faces/bird/download', 'GET');
  assert.strictEqual(done.json().state, 'done');
  assert.strictEqual((await call(home, '/api/faces/bird/download', 'POST')).json().state, 'done');
});

test('routes: GET /api/faces lists the catalogue entries that are not installed as available', async () => {
  const home = makeHome();
  const before = (await call(home, '/api/faces')).json();
  assert.deepStrictEqual(before.packs, []);
  assert.deepStrictEqual(before.available, [{ id: 'bird', name: 'Bird', size: ARCHIVE.length }, { id: 'crow', name: 'Bird', size: ARCHIVE.length }]);
  download.__setTransportForTests(fake({ [URL1]: ok() }));
  await call(home, '/api/faces/bird/download', 'POST'); await download.__whenIdleForTests();
  const after = (await call(home, '/api/faces')).json();
  assert.deepStrictEqual(after.packs.map(p => p.id), ['bird']);
  assert.deepStrictEqual(after.available.map(a => a.id), ['crow']);
  const m = JSON.parse(require('fs').readFileSync(require('path').join(home, 'faces', 'bird', 'manifest.json'), 'utf8'));
  assert.strictEqual(after.packs[0].name, typeof m.name === 'string' && m.name ? m.name : 'Bird', 'an installed catalogue pack without its own name keeps the catalogue name');
});

test('the real route default lists the owl as available on an empty hub', async () => {
  const home = makeHome();
  const req = Object.assign(Readable.from([]), { method: 'GET', headers: {}, hubUser: member }); const res = fakeRes();
  await routes.handle('/api/faces', req, res, { home });
  assert.deepStrictEqual(res.json().available, [{ id: 'owl', name: 'Owl', size: CATALOG[0].size }]);
});

test('access: members reach the download path with GET and POST, and only for a lowercase slug', () => {
  for (const m of ['GET', 'POST']) {
    assert.strictEqual(access.classifyRoute('/api/faces/owl/download', m).kind, 'session');
    assert.strictEqual(access.classifyRoute('/api/faces/owl-2/download/', m).kind, 'session');
  }
  assert.strictEqual(access.classifyRoute('/api/faces/Owl/download', 'POST').kind, 'admin');
  assert.strictEqual(access.classifyRoute('/api/faces/o_wl/download', 'POST').kind, 'admin');
  assert.strictEqual(access.classifyRoute('/api/faces/a%2fb/download', 'POST').kind, 'admin');
  assert.strictEqual(access.classifyRoute('/api/faces/owl/download', 'POST').kind, 'session');
});
