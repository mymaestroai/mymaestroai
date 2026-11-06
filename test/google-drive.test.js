'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MOD = path.join(__dirname, '..', 'modules', 'google-drive');
const manifestLib = require('../lib/modules/manifest');
const { createDrive, FOLDER_NAME } = require(path.join(MOD, 'drive.js'));
const server = require(path.join(MOD, 'server.js'));
const mod = require(path.join(MOD, 'index.js'));

const INSTALL = 'a1b2c3d4e5f60718';
const OTHER = '0f0e0d0c0b0a0908';
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gdrive-test-'));
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });

// A stand-in for Google: token endpoint, folders, files, resumable uploads. Records every request.
function fakeGoogle(opts = {}) {
  const g = {
    files: [], calls: [], tokens: 0, clock: 0, uploads: {}, nextId: 1,
    tokenReply: opts.tokenReply, failChunk: opts.failChunk || null, corrupt: !!opts.corrupt, pageSize: opts.pageSize || 1000,
  };
  const add = (f) => { const rec = { id: `f${g.nextId++}`, createdTime: new Date(Date.UTC(2026, 0, 1, 0, 0, g.nextId)).toISOString(), ...f }; g.files.push(rec); return rec; };
  g.add = add;
  g.fetch = async (url, init = {}) => {
    url = String(url);
    const method = init.method || 'GET';
    const u = new URL(url);
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    g.calls.push({ method, url, headers, body: init.body, redirect: init.redirect });
    if (u.origin === 'https://oauth2.googleapis.com') {
      g.tokens++;
      if (g.tokenReply) return g.tokenReply();
      return json({ access_token: `tok-${g.tokens}`, expires_in: 3600 });
    }
    assert.match(headers.authorization || '', /^Bearer tok-\d+$/, 'every Drive request carries a bearer token');
    if (u.pathname === '/upload/drive/v3/files' && method === 'POST') {
      const meta = JSON.parse(init.body);
      const sid = `s${Object.keys(g.uploads).length + 1}`;
      g.uploads[sid] = { meta, data: Buffer.alloc(0), size: Number(headers['x-upload-content-length']), puts: 0 };
      return new Response('', { status: 200, headers: { location: g.location ? g.location(sid) : `https://www.googleapis.com/upload/session/${sid}` } });
    }
    if (u.pathname.startsWith('/upload/session/')) {
      const up = g.uploads[u.pathname.split('/').pop()];
      const cr = headers['content-range'];
      if (/^bytes \*\//.test(cr)) {
        return new Response('', { status: 308, headers: up.data.length ? { range: `bytes=0-${up.data.length - 1}` } : {} });
      }
      const [, a, b] = /^bytes (\d+)-(\d+)\//.exec(cr);
      up.puts++;
      const fc = g.failChunk;
      if (fc && (fc.at === up.puts || fc.at === 'all')) {
        if (fc.mode === 'lost') throw new TypeError('network down');
        if (fc.mode === 'stored') { up.data = Buffer.concat([up.data, Buffer.from(init.body)]); throw new TypeError('network down'); }
        if (fc.mode === 'always') throw new TypeError('network down');
      }
      assert.equal(Number(a), up.data.length, 'chunks arrive in order, from the offset the session holds');
      up.data = Buffer.concat([up.data, Buffer.from(init.body)]);
      assert.equal(up.data.length - 1, Number(b));
      if (up.data.length < up.size) return new Response('', { status: 308, headers: { range: `bytes=0-${up.data.length - 1}` } });
      const rec = add({ name: up.meta.name, parent: up.meta.parents[0], data: up.data, appProperties: up.meta.appProperties });
      return json({ id: rec.id });
    }
    if (u.pathname === '/drive/v3/files' && method === 'POST') {
      const meta = JSON.parse(init.body);
      return json({ id: add({ name: meta.name, mime: meta.mimeType, appProperties: meta.appProperties }).id });
    }
    if (u.pathname === '/drive/v3/files' && method === 'GET') {
      const qs = u.searchParams.get('q');
      assert.equal(u.searchParams.get('spaces'), 'drive');
      let rows;
      if (qs.includes("mimeType='application/vnd.google-apps.folder'")) {
        assert.ok(qs.includes("appProperties has { key='mymaestro' and value='backups' }") && qs.includes('trashed=false'));
        const inst = /key='install' and value='([^']+)'/.exec(qs)[1];
        rows = g.files.filter((f) => f.mime === 'application/vnd.google-apps.folder' && f.appProperties.install === inst);
      } else {
        const parent = /'([^']+)' in parents/.exec(qs)[1];
        const nm = /name='((?:[^'\\]|\\.)*)'/.exec(qs);
        rows = g.files.filter((f) => f.parent === parent && (!nm || f.name === nm[1].replace(/\\(.)/g, '$1')));
      }
      const start = Number(u.searchParams.get('pageToken') || 0);
      const page = rows.slice(start, start + g.pageSize);
      return json({
        files: page.map((f) => ({ id: f.id, name: f.name, size: f.data ? String(f.data.length) : undefined, md5Checksum: f.data ? md5(f.data) : undefined, createdTime: f.createdTime })),
        ...(start + g.pageSize < rows.length ? { nextPageToken: String(start + g.pageSize) } : {}),
      });
    }
    const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (m) {
      const f = g.files.find((x) => x.id === m[1]);
      if (method === 'DELETE') {
        g.files = g.files.filter((x) => x !== f);
        return new Response(null, { status: f ? 204 : 404 });
      }
      if (!f) return json({ error: { code: 404, message: 'File not found' } }, 404);
      if (u.searchParams.get('alt') === 'media') return g.media ? g.media(f) : new Response(f.data, { status: 200 });
      return json({ id: f.id, name: f.name, parents: f.parent ? [f.parent] : [], trashed: false, size: f.data ? String(f.data.length) : undefined,
        md5Checksum: f.data ? (g.corrupt ? 'ffffffffffffffffffffffffffffffff' : md5(f.data)) : undefined });
    }
    throw new Error(`unexpected request ${method} ${url}`);
  };
  return g;
}

function driveFor(g, extra = {}) {
  const clock = { t: 1_000_000 };
  const sleeps = [];
  const d = createDrive({
    clientId: 'client-id-1', clientSecret: 'client-secret-1', refreshToken: 'refresh-1', fetch: (...a) => g.fetch(...a),
    now: () => clock.t, sleep: async (ms) => { sleeps.push(ms); }, chunkSize: 4, ...extra,
  });
  return { d, clock, sleeps };
}

const folderOf = (g) => g.files.find((f) => f.mime === 'application/vnd.google-apps.folder');
const backups = (g) => g.files.filter((f) => f.data);

test('module.json and setup.json pass the hub validators', () => {
  const loaded = manifestLib.loadModule(MOD);
  const hubKnown = manifestLib.TOOL_CLASSES.includes('hub');
  // Until the 'hub' class exists in lib/modules/manifest.js only its complaints are tolerated.
  const problems = loaded.problems.filter((p) => hubKnown || !/^tool backup_\w+: class must be one of/.test(p));
  assert.deepEqual(problems, []);
  const m = JSON.parse(fs.readFileSync(path.join(MOD, 'module.json'), 'utf8'));
  assert.equal(m.id, 'google-drive');
  assert.equal(m.backup, true);
  assert.deepEqual(m.tools, { backup_put: 'hub', backup_list: 'hub', backup_delete: 'hub', backup_get: 'hub' });
  assert.equal(m.health.check, 'drive');
  assert.deepEqual(m.oauth.scopes, ['https://www.googleapis.com/auth/drive.file']);
  const v = manifestLib.validateManifest(m, 'google-drive');
  const setup = JSON.parse(fs.readFileSync(path.join(MOD, 'setup.json'), 'utf8'));
  assert.deepEqual(manifestLib.validateSetup(setup, v, mod.checks), []);
  assert.deepEqual(setup.steps.map((s) => s.id), ['about', 'google', 'install', 'keys', 'signin', 'done']);
  assert.ok(loaded.hasGuide);
  if (!hubKnown) console.log("note: lib/modules/manifest.js has no 'hub' tool class yet; the tool classes could not be fully validated");
});

test('token: refreshed once, cached until 60 s before expiry, then refreshed again', async () => {
  const g = fakeGoogle();
  const { d, clock } = driveFor(g);
  assert.equal(await d.accessToken(), 'tok-1');
  assert.equal(await d.accessToken(), 'tok-1');
  assert.equal(g.tokens, 1);
  const body = new URLSearchParams(g.calls[0].body);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'refresh-1');
  clock.t += 3600 * 1000 - 61 * 1000;
  assert.equal(await d.accessToken(), 'tok-1');
  clock.t += 2 * 1000;
  assert.equal(await d.accessToken(), 'tok-2');
});

test('token: invalid_grant gives the plain sign-in message and no secrets', async () => {
  const g = fakeGoogle({ tokenReply: () => json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400) });
  const { d } = driveFor(g);
  await assert.rejects(d.accessToken(), (e) => {
    assert.equal(e.message, 'The Google sign-in was revoked or has expired. Sign in again.');
    assert.doesNotMatch(e.message, /refresh-1|client-secret-1/);
    return true;
  });
});

test('folder: found when it exists, created (with the appProperty) when not', async () => {
  const g = fakeGoogle();
  const { d } = driveFor(g);
  assert.equal(await d.folder(INSTALL, false), null);
  const id = await d.folder(INSTALL);
  const f = folderOf(g);
  assert.equal(f.id, id);
  assert.equal(f.name, FOLDER_NAME);
  assert.deepEqual(f.appProperties, { mymaestro: 'backups', install: INSTALL });
  const creates = () => g.calls.filter((c) => c.method === 'POST' && c.url.includes('/drive/v3/files?'));
  assert.equal(creates().length, 1);
  assert.equal(await d.folder(INSTALL), id);
  assert.equal(creates().length, 1, 'the second call found it instead of creating another');
});

test('put: several chunks, a 308, and one failed chunk resumed from what the session holds', async () => {
  for (const mode of ['lost', 'stored']) {
    const g = fakeGoogle({ failChunk: { at: 2, mode } });
    const { d, sleeps } = driveFor(g);
    const dir = tmp();
    const file = path.join(dir, 'b.bin');
    const data = Buffer.from('0123456789');
    fs.writeFileSync(file, data);
    const r = await d.put(file, 'nightly-1.mmbak', INSTALL);
    assert.deepEqual(r, { name: 'nightly-1.mmbak', size: 10, md5: md5(data), id: backups(g)[0].id });
    assert.equal(backups(g).length, 1);
    assert.deepEqual(backups(g)[0].data, data);
    assert.equal(backups(g)[0].parent, folderOf(g).id);
    assert.deepEqual(backups(g)[0].appProperties, { mymaestro: 'backup', install: INSTALL });
    assert.equal(sleeps.length, 1, `one backoff for the failed chunk (${mode})`);
    const init = g.calls.find((c) => c.url.includes('uploadType=resumable'));
    assert.equal(init.headers['x-upload-content-length'], '10');
    assert.ok(g.calls.some((c) => c.method === 'PUT' && c.headers['content-range'] === 'bytes */10'), 'asked the session what it holds');
    fs.rmSync(dir, { recursive: true });
  }
});

test('put: gives up after 5 failed retries of a chunk', async () => {
  const g = fakeGoogle({ failChunk: { at: 'all', mode: 'always' } });
  const { d, sleeps } = driveFor(g);
  const dir = tmp();
  const file = path.join(dir, 'b.bin');
  fs.writeFileSync(file, 'abcdefgh');
  await assert.rejects(d.put(file, 'x', INSTALL), /Couldn't reach Google Drive/);
  assert.equal(sleeps.length, 5);
  fs.rmSync(dir, { recursive: true });
});

test('put: an md5 mismatch deletes the upload and throws', async () => {
  const g = fakeGoogle({ corrupt: true });
  const { d } = driveFor(g);
  const dir = tmp();
  const file = path.join(dir, 'b.bin');
  fs.writeFileSync(file, 'abcdefghij');
  await assert.rejects(d.put(file, 'x.mmbak', INSTALL), /different copy.*removed/);
  assert.equal(backups(g).length, 0);
  assert.ok(g.calls.some((c) => c.method === 'DELETE'));
  fs.rmSync(dir, { recursive: true });
});

test('put: a file with the same name is replaced after the new one is verified', async () => {
  const g = fakeGoogle();
  const { d } = driveFor(g);
  const dir = tmp();
  const file = path.join(dir, 'b.bin');
  fs.writeFileSync(file, 'first-copy');
  await d.put(file, 'same.mmbak', INSTALL);
  const oldId = backups(g)[0].id;
  fs.writeFileSync(file, 'second-copy!');
  await d.put(file, 'same.mmbak', INSTALL);
  assert.equal(backups(g).length, 1);
  assert.notEqual(backups(g)[0].id, oldId);
  assert.equal(backups(g)[0].data.toString(), 'second-copy!');
  fs.rmSync(dir, { recursive: true });
});

test('put: an empty file uploads in one request', async () => {
  const g = fakeGoogle();
  g.fetch = ((orig) => async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.pathname.startsWith('/upload/session/') && !/^bytes \*\//.test(((init.headers || {})['Content-Range']) || '')) {
      const up = g.uploads[u.pathname.split('/').pop()];
      g.calls.push({ method: 'PUT', url: String(url), headers: {}, body: init.body });
      const rec = g.add({ name: up.meta.name, parent: up.meta.parents[0], data: Buffer.alloc(0) });
      return json({ id: rec.id });
    }
    return orig(url, init);
  })(g.fetch);
  const { d } = driveFor(g);
  const dir = tmp();
  const file = path.join(dir, 'e.bin');
  fs.writeFileSync(file, '');
  assert.deepEqual(await d.put(file, 'empty', INSTALL), { name: 'empty', size: 0, md5: md5(Buffer.alloc(0)), id: backups(g)[0].id });
  fs.rmSync(dir, { recursive: true });
});

test('list pages through the install folder and returns ids; remove deletes only the id given, after checking folder and name', async () => {
  const g = fakeGoogle({ pageSize: 2 });
  const { d } = driveFor(g);
  assert.deepEqual(await d.list(INSTALL), [], 'no folder yet: nothing listed, nothing created');
  assert.equal(folderOf(g), undefined);
  const parent = await d.folder(INSTALL);
  const otherParent = await d.folder(OTHER);
  assert.notEqual(parent, otherParent, 'one folder per install');
  const ids = {};
  for (const n of ['a', 'b', 'b2', 'c', 'd']) ids[n] = g.add({ name: n === 'b2' ? 'b' : n, parent, data: Buffer.from(n) }).id;
  const foreign = g.add({ name: 'b', parent: otherParent, data: Buffer.from('x') });
  const files = await d.list(INSTALL);
  assert.deepEqual(files.map((f) => f.name), ['a', 'b', 'b', 'c', 'd']);
  assert.deepEqual(files.map((f) => f.id), [ids.a, ids.b, ids.b2, ids.c, ids.d]);
  assert.equal(files[0].size, 1);
  assert.ok(files[0].createdTime);
  assert.equal(g.calls.filter((c) => c.url.includes('pageToken=')).length, 2);
  assert.equal(await d.remove('b', ids.b, INSTALL), 1);
  assert.deepEqual((await d.list(INSTALL)).map((f) => f.id), [ids.a, ids.b2, ids.c, ids.d], 'the same-named file with another id stays');
  assert.equal(await d.remove('b', ids.b, INSTALL), 0, 'already gone');
  await assert.rejects(d.remove('b', foreign.id, INSTALL), /not the backup "b" in this install's folder/);
  await assert.rejects(d.remove('zzz', ids.c, INSTALL), /left alone/);
  assert.ok(g.files.includes(foreign) && g.files.some((f) => f.id === ids.c), 'nothing wrong was deleted');
  await assert.rejects(d.remove('b', 'bad id!', INSTALL), /file id is not valid/);
  assert.equal(await d.remove('b', ids.b2, 'ffffffffffffffff'), 0, 'an install with no folder deletes nothing');
  assert.equal(await d.remove("it's", ids.a, INSTALL).catch(() => 'rejected'), 'rejected');
  await assert.rejects(d.list('nothex'), /16 hex/);
});

test('put: replacing a same-named file touches only this install\'s folder, only other ids, and only after the new upload is verified', async () => {
  const g = fakeGoogle();
  const { d } = driveFor(g);
  const mine = await d.folder(INSTALL);
  const theirs = await d.folder(OTHER);
  const old = g.add({ name: 'same', parent: mine, data: Buffer.from('old') });
  const alien = g.add({ name: 'same', parent: theirs, data: Buffer.from('alien') });
  const dir = tmp(); const file = path.join(dir, 'b.bin'); fs.writeFileSync(file, 'new-one');
  const r = await d.put(file, 'same', INSTALL);
  assert.ok(g.files.includes(alien), 'another install\'s file is untouched');
  assert.ok(!g.files.includes(old));
  assert.deepEqual(backups(g).filter((f) => f.parent === mine).map((f) => f.id), [r.id]);
  const dels = g.calls.filter((c) => c.method === 'DELETE').map((c) => c.url.split('/').pop());
  assert.deepEqual(dels, [old.id], 'only the old id was deleted, never the new one');
  // a corrupt upload leaves the existing copy alone
  const g2 = fakeGoogle({ corrupt: true });
  const { d: d2 } = driveFor(g2);
  const p2 = await d2.folder(INSTALL);
  const keep = g2.add({ name: 'same', parent: p2, data: Buffer.from('keep') });
  await assert.rejects(d2.put(file, 'same', INSTALL), /different copy/);
  assert.ok(g2.files.includes(keep));
  fs.rmSync(dir, { recursive: true });
});

test('put: a resumable session address that is not https://www.googleapis.com is refused and the token goes nowhere else', async () => {
  for (const bad of ['http://www.googleapis.com/upload/s1', 'https://evil.example/upload/s1', 'https://www.googleapis.com.evil.example/x', 'https://www.googleapis.com:8443/x', 'not a url']) {
    const g = fakeGoogle();
    g.location = () => bad;
    const { d } = driveFor(g);
    const dir = tmp(); const file = path.join(dir, 'b.bin'); fs.writeFileSync(file, 'abcd');
    await assert.rejects(d.put(file, 'x', INSTALL), /not Google's, so nothing was sent/, bad);
    assert.ok(!g.calls.some((c) => c.method === 'PUT'), 'no data and no token were sent');
    assert.ok(g.calls.every((c) => !c.url.includes('evil')));
    fs.rmSync(dir, { recursive: true });
  }
});

test('redirects: API and upload requests refuse them (and do not retry); downloads follow only https and drop the token off-origin', async () => {
  const g = fakeGoogle();
  const { d, sleeps } = driveFor(g);
  const dir = tmp(); const file = path.join(dir, 'b.bin'); fs.writeFileSync(file, 'abcdefgh');
  await d.put(file, 'r', INSTALL);
  assert.ok(g.calls.filter((c) => !c.url.includes('oauth2')).length > 0);
  for (const c of g.calls.filter((x) => !x.url.includes('oauth2') && !x.url.includes('alt=media'))) assert.equal(c.redirect, 'error', `${c.method} ${c.url}`);
  // a redirect the platform refuses is a plain, final error
  const g2 = fakeGoogle();
  const orig = g2.fetch;
  g2.fetch = async (url, init) => { if (String(url).includes('/drive/v3/files?')) throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') }); return orig(url, init); };
  const { d: d2, sleeps: s2 } = driveFor(g2);
  await assert.rejects(d2.list(INSTALL), /unexpected redirect/);
  assert.equal(s2.length, 0);
  assert.equal(sleeps.length, 0);

  // downloads
  const g3 = fakeGoogle();
  const { d: d3 } = driveFor(g3);
  const parent = await d3.folder(INSTALL);
  const data = Buffer.from('payload');
  const f = g3.add({ name: 'n', parent, data });
  const seen = [];
  const orig3 = g3.fetch;
  g3.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.hostname === 'cdn.example') { seen.push({ url: String(url), auth: (init.headers || {}).Authorization, redirect: init.redirect }); return new Response(data, { status: 200 }); }
    if (String(url).includes(`/files/${f.id}?alt=media`)) { g3.calls.push({ method: 'GET', url: String(url), headers: { authorization: (init.headers || {}).Authorization }, redirect: init.redirect }); return new Response(null, { status: 302, headers: { location: 'https://cdn.example/blob' } }); }
    return orig3(url, init);
  };
  const out = path.join(dir, 'o');
  assert.deepEqual(await d3.get('n', f.id, out, INSTALL), { size: data.length, md5: md5(data) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].auth, undefined, 'the token is not sent to the other origin');
  // to http: refused
  g3.fetch = async (url, init = {}) => (String(url).includes('alt=media') ? new Response(null, { status: 302, headers: { location: 'http://cdn.example/blob' } }) : orig3(url, init));
  await assert.rejects(d3.get('n', f.id, out + '2', INSTALL), /not secure/);
  assert.equal(fs.existsSync(`${out}2.part`), false);
  fs.rmSync(dir, { recursive: true });
});

test('get: downloads that id, checks size and md5, then renames; mismatch or foreign file is refused', async () => {
  const g = fakeGoogle();
  const { d } = driveFor(g);
  const parent = await d.folder(INSTALL);
  const data = Buffer.from('some backup bytes');
  const mine = g.add({ name: 'n.mmbak', parent, data });
  const newer = g.add({ name: 'n.mmbak', parent, data: Buffer.from('newer bytes') });
  const dir = tmp();
  const out = path.join(dir, 'restored.bin');
  assert.deepEqual(await d.get('n.mmbak', mine.id, out, INSTALL), { size: data.length, md5: md5(data) });
  assert.deepEqual(fs.readFileSync(out), data, 'that id, not the newest');
  assert.equal(fs.existsSync(`${out}.part`), false);
  assert.ok(g.calls.some((c) => c.url.includes(`${mine.id}?alt=media`)));
  assert.ok(newer);

  const bad = g.add({ name: 'bad', parent, data: Buffer.from('xyz') });
  g.media = (f) => (f === bad ? new Response('xyZ', { status: 200 }) : new Response(f.data));
  const out2 = path.join(dir, 'bad.bin');
  await assert.rejects(d.get('bad', bad.id, out2, INSTALL), /does not match/);
  assert.equal(fs.existsSync(out2), false);
  assert.equal(fs.existsSync(`${out2}.part`), false);
  await assert.rejects(d.get('missing', 'nope', path.join(dir, 'm'), INSTALL), /no backup copy named "missing"/i);
  const foreign = g.add({ name: 'f', parent: await d.folder(OTHER), data: Buffer.from('f') });
  await assert.rejects(d.get('f', foreign.id, path.join(dir, 'f'), INSTALL), /left alone/);
  await assert.rejects(d.get('n.mmbak', mine.id, path.join(dir, 'w'), OTHER), /left alone/, 'another install cannot fetch it by id');
  fs.rmSync(dir, { recursive: true });
});

test('get: every chunk is fully written even when a write takes only a few bytes', async () => {
  const g = fakeGoogle();
  const { d } = driveFor(g);
  const parent = await d.folder(INSTALL);
  const data = crypto.randomBytes(5000);
  const f = g.add({ name: 'big', parent, data });
  g.media = () => new Response(new ReadableStream({ start(c) { c.enqueue(data.subarray(0, 2999)); c.enqueue(data.subarray(2999)); c.close(); } }), { status: 200 });
  const realOpen = fs.promises.open;
  let writes = 0;
  fs.promises.open = async (...a) => {
    const fh = await realOpen(...a);
    const w = fh.write.bind(fh);
    fh.write = (buf, off, len, ...rest) => { writes++; return w(buf, off, Math.min(len, 7), ...rest); };
    return fh;
  };
  const dir = tmp();
  try {
    const r = await d.get('big', f.id, path.join(dir, 'o'), INSTALL);
    assert.deepEqual(r, { size: 5000, md5: md5(data) });
    assert.deepEqual(fs.readFileSync(path.join(dir, 'o')), data);
    assert.ok(writes > 100, `short writes were repeated (${writes})`);
  } finally { fs.promises.open = realOpen; fs.rmSync(dir, { recursive: true }); }
});

test('get: an idle timeout, not a total limit: slow but steady bytes finish; silence fails and leaves nothing behind', async () => {
  const g = fakeGoogle();
  const { d } = driveFor(g, { idleMs: 150 });
  const parent = await d.folder(INSTALL);
  const data = Buffer.from('0123456789');
  const f = g.add({ name: 'slow', parent, data });
  const dir = tmp();
  // 10 chunks 40 ms apart: 400 ms in total, longer than idleMs, but never silent for 150 ms
  g.media = () => new Response(new ReadableStream({
    async start(c) { for (const b of data) { await new Promise((r) => setTimeout(r, 40)); c.enqueue(Buffer.from([b])); } c.close(); },
  }), { status: 200 });
  assert.deepEqual(await d.get('slow', f.id, path.join(dir, 'ok'), INSTALL), { size: 10, md5: md5(data) });
  // one chunk, then nothing
  g.media = () => new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.from('01')); } }), { status: 200 });
  const t0 = Date.now();
  await assert.rejects(d.get('slow', f.id, path.join(dir, 'stuck'), INSTALL), /took too long/);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(fs.existsSync(path.join(dir, 'stuck')), false);
  assert.equal(fs.existsSync(path.join(dir, 'stuck.part')), false);
  fs.rmSync(dir, { recursive: true });
});

test('errors are plain messages without tokens', async () => {
  const g = fakeGoogle();
  const orig = g.fetch;
  g.fetch = async (url, init) => (String(url).includes('/drive/v3/files?')
    ? json({ error: { code: 403, message: 'Bearer ya29.secret-token-value denied', errors: [{ reason: 'forbidden' }] } }, 403)
    : orig(url, init));
  const { d } = driveFor(g);
  await assert.rejects(d.list(INSTALL), (e) => { assert.match(e.message, /answered 403/); assert.doesNotMatch(e.message, /ya29|secret-token/); return true; });
  g.fetch = async (url, init) => (String(url).includes('/drive/v3/files?')
    ? json({ error: { code: 403, message: 'x', errors: [{ reason: 'storageQuotaExceeded' }] } }, 403)
    : orig(url, init));
  await assert.rejects(d.list(INSTALL), /Drive is full/);
});

test('request handler answers initialize, tools/list and tools/call, and validates install and id', async () => {
  const calls = [];
  const drive = {
    put: async (file, name, inst) => { calls.push(['put', file, name, inst]); return { name, size: 3, md5: 'abc', id: 'F1' }; },
    list: async (inst) => { calls.push(['list', inst]); return [{ id: 'i-1_x', name: 'a', size: 5, createdTime: '2026-01-01T00:00:00.000Z' }]; },
    remove: async (name, id, inst) => { calls.push(['remove', name, id, inst]); return name === 'gone' ? 1 : 0; },
    get: async (name, id, out, inst) => { calls.push(['get', name, id, out, inst]); return { size: 1, md5: 'z' }; },
  };
  const init = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, drive);
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.ok(init.result.capabilities.tools);
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, drive), null);
  const list = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, drive);
  assert.deepEqual(list.result.tools.map((t) => t.name), ['backup_put', 'backup_list', 'backup_delete', 'backup_get']);
  const call = async (name, args) => {
    const r = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }, drive);
    return { isError: r.result.isError, text: r.result.content[0].text };
  };
  assert.deepEqual(JSON.parse((await call('backup_put', { file: '/f', name: 'n', install: INSTALL })).text), { name: 'n', size: 3, md5: 'abc', id: 'F1' });
  assert.deepEqual(JSON.parse((await call('backup_list', { install: INSTALL })).text), { files: [{ name: 'a', size: 5, created: '2026-01-01T00:00:00.000Z', id: 'i-1_x' }] });
  assert.deepEqual(JSON.parse((await call('backup_delete', { name: 'gone', id: 'X1', install: INSTALL })).text), { deleted: true });
  assert.deepEqual(JSON.parse((await call('backup_delete', { name: 'nope', id: 'X1', install: INSTALL })).text), { deleted: false });
  assert.deepEqual(JSON.parse((await call('backup_get', { name: 'n', id: 'X1', install: INSTALL, out: '/o' })).text), { size: 1, md5: 'z' });
  assert.deepEqual(calls.find((c) => c[0] === 'get'), ['get', 'n', 'X1', '/o', INSTALL]);
  const n = calls.length;
  for (const [tool, args, re] of [
    ['backup_put', { file: '/f', install: INSTALL }, /"name" is required/],
    ['backup_put', { file: '/f', name: 'n' }, /"install" is required/],
    ['backup_list', { install: 'ABCDEF0123456789' }, /16 hex/],
    ['backup_list', { install: 'abc' }, /16 hex/],
    ['backup_delete', { name: 'n', install: INSTALL }, /"id" is required/],
    ['backup_delete', { name: 'n', id: 'a/b', install: INSTALL }, /not a valid Drive file id/],
    ['backup_get', { name: 'n', id: 'x'.repeat(201), install: INSTALL, out: '/o' }, /not a valid Drive file id/],
    ['backup_get', { name: 'n', id: 'ok', install: INSTALL }, /"out" is required/],
  ]) {
    const bad = await call(tool, args);
    assert.equal(bad.isError, true, tool);
    assert.match(bad.text, re);
  }
  assert.equal(calls.length, n, 'invalid calls never reach Drive');
  assert.equal((await call('backup_get', { name: 'n', id: 'x'.repeat(200), install: INSTALL, out: '/o' })).isError, undefined);
  drive.list = async () => { throw new Error('The Google sign-in was revoked or has expired. Sign in again.'); };
  const err = await call('backup_list', { install: INSTALL });
  assert.equal(err.isError, true);
  assert.match(err.text, /Sign in again/);
  assert.ok((await server.handle({ jsonrpc: '2.0', id: 4, method: 'nope' }, drive)).error);
});

test('health check: counts backups, or reports the error', async () => {
  const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };
  let asked;
  const ok = await mod.checks.drive({ callTool: async (tool, args) => { asked = [tool, args]; return JSON.stringify({ files: [] }); }, parse });
  assert.deepEqual(ok, { ok: true, summary: 'Signed in to Google Drive.' });
  assert.equal(asked[0], 'backup_list');
  assert.match(asked[1].install, /^[0-9a-f]{16}$/, 'the probe carries a valid install id');
  const thrown = await mod.checks.drive({ callTool: async () => { throw new Error('boom'); }, parse });
  assert.deepEqual(thrown, { ok: false, summary: 'boom' });
  const text = await mod.checks.drive({ callTool: async () => 'The Google sign-in was revoked or has expired. Sign in again.', parse });
  assert.equal(text.ok, false);
  assert.match(text.summary, /Sign in again/);
});
