'use strict';
// Easier downloads, server side: POST /api/files/resolve, GET /api/files/recent, GET /api/files/zip, the upload ledger.
// The real /api/files block of server.js runs in a vm behind a real http server (so a real client can disconnect mid-zip);
// lib/ comes from a throwaway install (test/helpers/isolated-install), every folder is a temp folder removed after each test.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const zlib = require('zlib');
const crypto = require('crypto');
const { Readable } = require('stream');
const { makeIsolatedInstall } = require('./helpers/isolated-install');

const iso = makeIsolatedInstall('files-dl-');   // before any lib/ module is loaded
const filesLib = require(path.join(iso.inst, 'lib', 'files.js'));
const access = require(path.join(iso.inst, 'lib', 'access.js'));
const { createFiles } = filesLib;

const USERS = { u_owner: { id: 'u_owner', role: 'admin', name: 'the owner' }, u_sam: { id: 'u_sam', role: 'member', name: 'Sam' }, u_mo: { id: 'u_mo', role: 'member', name: 'Mo' } };
const AGENTS = [
  { name: 'helper-agent' },                                   // no owner: share/helper-agent
  { name: 'other-agent' },                                    // no owner, shared with nobody
  { name: 'shared-agent', sharedWith: ['u_sam'] },            // share/shared-agent, Sam may open it
  { name: 'sam-agent', owner: 'u_sam' },                      // member-owned: users/u_sam/files
];

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const BLOCK_HEAD = "if (pathname === '/api/files' || pathname.startsWith('/api/files/')) {";
const blockStart = serverSource.indexOf(BLOCK_HEAD);
assert.ok(blockStart > 0, 'the /api/files block is missing from server.js');
const BLOCK = serverSource.slice(blockStart, serverSource.indexOf('\n    }\n', blockStart) + '\n    }\n'.length);

const PORTS = [];
/** A world: a hub home with the agent folders, the files lib on it, and a real http server running the real route block. */
async function world({ settings = {}, fsImpl = fs, entryCap } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'files-dl-home-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'files-dl-data-'));
  const files = createFiles({ hubHome: home, fsImpl, getUser: (id) => USERS[id] || null, dataDir });
  const lib = { ...filesLib, getFiles: () => files };
  const sandbox = {
    require: (p) => (p === './lib/files' ? lib : require(p)), path, fs, URL, Buffer, console: { log() {}, error() {} }, __dirname: iso.inst,
    access, hubAuth: { getUser: (id) => USERS[id] || null, listUsers: () => Object.values(USERS) },
    hubSettings: { getSetting: (k) => settings[k] },
    getAgents: async () => AGENTS,
    jsonResponse: (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); return 'json'; },
    authJson: async function () { return this.__body; },
  };
  vm.createContext(sandbox);
  vm.runInContext(`this.route = async (pathname, req, res) => { ${BLOCK} return 'unhandled'; };`, sandbox);
  const results = [];
  const server = http.createServer(async (req, res) => {
    req.hubUser = USERS[req.headers['x-user']] || null;
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    sandbox.authJson = async () => body;
    try { results.push(await sandbox.route(new URL(req.url, 'http://x').pathname, req, res)); }
    catch (e) { results.push(e); if (!res.headersSent) { res.writeHead(500); res.end(String(e && e.message)); } }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const w = {
    home, dataDir, files, results, port,
    root: (...p) => path.join(home, ...p),
    write(rel, data, mtimeSec) { const p = path.join(home, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); if (mtimeSec) fs.utimesSync(p, mtimeSec, mtimeSec); return p; },
    /** One request; resolves { status, headers, body: Buffer, json } (json only when the answer is JSON). */
    req(user, method, url, body) {
      return new Promise((resolve, reject) => {
        const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
        const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: { 'x-user': user || '', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) } }, (res) => {
          const chunks = []; res.on('data', c => chunks.push(c));
          res.on('end', () => { const b = Buffer.concat(chunks); let json; if (/json/.test(res.headers['content-type'] || '')) { try { json = JSON.parse(b.toString('utf8')); } catch {} } resolve({ status: res.statusCode, headers: res.headers, body: b, json }); });
          res.on('aborted', () => { const b = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, body: b, aborted: true }); });
          res.on('error', () => {});
        });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
      });
    },
    resolve: (user, items) => w.req(user, 'POST', '/api/files/resolve', { items }),
    close() { server.closeAllConnections && server.closeAllConnections(); server.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
  return w;
}
const NOT_FOUND = { ok: false, error: 'not found' };

/** Every produced zip: no two entries equal ignoring case, no file entry is also the parent folder of another entry, no segment ends in "." or " ", no "\" or ":". */
function assertSafeNames(names) {
  const lower = names.map(n => n.toLowerCase());
  assert.strictEqual(new Set(lower).size, lower.length, `no two entries equal ignoring case: ${JSON.stringify(names)}`);
  for (const a of lower) for (const b of lower) assert.ok(a === b || !b.startsWith(a + '/'), `no entry is a prefix-folder of another entry: ${JSON.stringify(a)} / ${JSON.stringify(b)}`);
  for (const n of names) {
    assert.ok(!n.includes('\\') && !n.includes(':'), `no backslash or colon: ${JSON.stringify(n)}`);
    assert.ok(!n.split('/').some(s => /[. ]$/.test(s)), `no segment ends with a dot or a space: ${JSON.stringify(n)}`);
  }
}

// ── a zip reader that checks the format, not just that "some unzip accepts it" ──
function readZip(buf) {
  const eocd = buf.length - 22;
  assert.ok(eocd >= 0 && buf.readUInt32LE(eocd) === 0x06054b50, 'the zip ends with an end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10), cdSize = buf.readUInt32LE(eocd + 12), cdOff = buf.readUInt32LE(eocd + 16);
  assert.strictEqual(cdOff + cdSize, eocd, 'the central directory ends where the end record starts');
  const out = {}; let p = cdOff;
  for (let i = 0; i < count; i++) {
    assert.strictEqual(buf.readUInt32LE(p), 0x02014b50, 'central entry signature');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    assert.ok(flags & 0x0008, `${name}: data descriptor flag (bit 3)`);
    assert.ok(flags & 0x0800, `${name}: UTF-8 name flag (bit 11)`);
    assert.strictEqual(method, 8, `${name}: deflate`);
    assert.strictEqual(buf.readUInt32LE(lho), 0x04034b50, `${name}: local header signature`);
    const lnlen = buf.readUInt16LE(lho + 26), lxlen = buf.readUInt16LE(lho + 28);
    assert.strictEqual(buf.slice(lho + 30, lho + 30 + lnlen).toString('utf8'), name, 'local and central names agree');
    const dataStart = lho + 30 + lnlen + lxlen;
    const data = zlib.inflateRawSync(buf.slice(dataStart, dataStart + csize));
    assert.strictEqual(data.length, usize, `${name}: uncompressed size`);
    assert.strictEqual(zlib.crc32(data) >>> 0, crc, `${name}: CRC-32`);
    const dd = dataStart + csize;
    assert.strictEqual(buf.readUInt32LE(dd), 0x08074b50, `${name}: data descriptor follows the data`);
    assert.strictEqual(buf.readUInt32LE(dd + 4), crc); assert.strictEqual(buf.readUInt32LE(dd + 8), csize); assert.strictEqual(buf.readUInt32LE(dd + 12), usize);
    out[name] = data;
    p += 46 + nlen + xlen + clen;
  }
  assert.strictEqual(Object.keys(out).length, count, 'no duplicate names');
  assertSafeNames(Object.keys(out));
  return out;
}

// ───────────────────────────── POST /api/files/resolve ─────────────────────────────
test('resolve: an abs path inside an agent folder the person may open gives the agent, the facts and a download URL the download route serves', async (t) => {
  const w = await world(); t.after(() => w.close());
  const abs = w.write('share/helper-agent/reports/q1 summary.txt', 'hello there');
  const r = await w.resolve('u_owner', [{ abs }]);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
  const it = r.json.items[0];
  assert.strictEqual(it.ok, true);
  assert.deepStrictEqual([it.name, it.size, it.mime, it.kind, it.isDir, it.agent, it.owner, it.path],
    ['q1 summary.txt', 11, 'text/plain; charset=utf-8', 'text', false, 'helper-agent', null, 'reports/q1 summary.txt'], 'agent roots win over the general share, so the link names the agent');
  assert.ok(!Number.isNaN(Date.parse(it.mtime)), 'mtime is an ISO date');
  assert.strictEqual(it.download, '/api/files/download?agent=helper-agent&path=reports%2Fq1%20summary.txt');
  assert.strictEqual(it.inline, it.download + '&inline=1');
  const d = await w.req('u_owner', 'GET', it.download);
  assert.strictEqual(d.status, 200, 'the existing download route serves the exact URL');
  assert.strictEqual(d.body.toString(), 'hello there');
  assert.match(d.headers['content-disposition'], /^attachment; filename\*=UTF-8''q1%20summary\.txt$/);
  // a file on the general share: owner= and path=
  const loose = w.write('share/loose.txt', 'x');
  const l = (await w.resolve('u_owner', [{ abs: loose }])).json.items[0];
  assert.deepStrictEqual([l.agent, l.owner, l.download], [null, 'mine', '/api/files/download?owner=mine&path=loose.txt']);
  assert.strictEqual((await w.req('u_owner', 'GET', l.download)).body.toString(), 'x');
  // active types are never offered inline
  const html = w.write('share/helper-agent/page.html', '<b>x</b>');
  const h = (await w.resolve('u_owner', [{ abs: html }])).json.items[0];
  assert.strictEqual(h.ok, true); assert.strictEqual(h.inline, null); assert.strictEqual(h.kind, 'text');
  const kinds = {};
  for (const n of ['a.png', 'b.pdf', 'c.mp3', 'd.mp4', 'e.zip', 'f.bin']) kinds[n] = (await w.resolve('u_owner', [{ abs: w.write(`share/helper-agent/${n}`, 'z') }])).json.items[0].kind;
  assert.deepStrictEqual(kinds, { 'a.png': 'image', 'b.pdf': 'pdf', 'c.mp3': 'audio', 'd.mp4': 'video', 'e.zip': 'archive', 'f.bin': 'other' });
});

test('resolve: the same file for a member who may not open that agent is "not found"; members reach their own and shared agents', async (t) => {
  const w = await world(); t.after(() => w.close());
  const secret = w.write('share/other-agent/secret.txt', 's');
  assert.strictEqual((await w.resolve('u_owner', [{ abs: secret }])).json.items[0].ok, true);
  assert.deepStrictEqual((await w.resolve('u_sam', [{ abs: secret }])).json.items, [NOT_FOUND]);
  assert.deepStrictEqual((await w.resolve('u_sam', [{ agent: 'other-agent', path: 'secret.txt' }])).json.items, [NOT_FOUND], 'same answer for an agent the member may not open');
  assert.deepStrictEqual((await w.resolve('u_sam', [{ agent: 'no-such-agent', path: 'secret.txt' }])).json.items, [NOT_FOUND], 'and for an agent that does not exist');
  const shared = w.write('share/shared-agent/n.txt', 'n');
  const sh = (await w.resolve('u_sam', [{ abs: shared }])).json.items[0];
  assert.deepStrictEqual([sh.ok, sh.agent], [true, 'shared-agent']);
  // the member's own folder is the root of their own agent
  const mine = w.write('users/u_sam/files/doc.txt', 'd');
  const m = (await w.resolve('u_sam', [{ abs: mine }])).json.items[0];
  assert.deepStrictEqual([m.ok, m.agent, m.path], [true, 'sam-agent', 'doc.txt']);
  assert.strictEqual((await w.req('u_sam', 'GET', m.download)).body.toString(), 'd');
  // another member's folder, and the admin's share (not an agent folder of Sam's): not found
  const theirs = w.write('users/u_mo/files/private.txt', 'p');
  assert.deepStrictEqual((await w.resolve('u_sam', [{ abs: theirs }, { abs: w.write('share/admin-only.txt', 'a') }])).json.items, [NOT_FOUND, NOT_FOUND]);
  assert.strictEqual((await w.resolve('u_owner', [{ abs: theirs }])).json.items[0].owner, 'u_mo', 'an admin reaches every member folder');
});

test('resolve: outside every root, a missing file, ".." and a folder all answer the same "not found"', async (t) => {
  const w = await world(); t.after(() => w.close());
  const inside = w.write('share/helper-agent/ok.txt', 'ok');
  fs.writeFileSync(path.join(iso.data, 'settings.json'), '{}');
  const answers = (await w.resolve('u_owner', [
    { abs: path.join(iso.data, 'settings.json') },              // the install's data folder (a real file, outside every root)
    { abs: path.join(iso.data, 'nothing-here.json') },          // a missing file there
    { abs: w.root('share/helper-agent/missing.txt') },           // missing inside a root
    { abs: '/etc/passwd' },
    { abs: w.root('share/helper-agent') + '/../other-agent/secret.txt' },   // ".."
    { abs: w.root('share/helper-agent') },                      // a folder
    { abs: w.root('share') },                                   // a root itself
    { abs: 'relative/path.txt' }, { abs: '' }, { abs: 'x\0y' },
  ])).json.items;
  const more = (await w.resolve('u_owner', [{ agent: 'helper-agent', path: '../other-agent/secret.txt' }, { agent: 'helper-agent', path: '' }, { agent: 'helper-agent', path: '.' }])).json.items;
  answers.push(...more);
  w.write('share/other-agent/secret.txt', 's');
  for (const [i, a] of answers.entries()) assert.deepStrictEqual(a, NOT_FOUND, `item ${i}`);
  assert.strictEqual((await w.resolve('u_owner', [{ abs: inside }])).json.items[0].ok, true, 'control: the inside file resolves');
  const dotted = (await w.resolve('u_owner', [{ abs: w.root('share/helper-agent') + '/../other-agent/secret.txt' }])).json.items[0];
  assert.deepStrictEqual(dotted, NOT_FOUND, 'a ".." path is refused even for an admin who may read the target');
  fs.rmSync(path.join(iso.data, 'settings.json'), { force: true });
});

test('resolve: a symlink inside a root that points outside is "not found" (as abs and as {agent, path})', async (t) => {
  const w = await world(); t.after(() => w.close());
  const outside = w.write('elsewhere/out.txt', 'outside');
  fs.mkdirSync(w.root('share/helper-agent'), { recursive: true });
  fs.symlinkSync(outside, w.root('share/helper-agent/link.txt'));
  fs.symlinkSync(w.root('elsewhere'), w.root('share/helper-agent/dirlink'));
  w.write('share/helper-agent/real.txt', 'in');
  fs.symlinkSync(w.root('share/helper-agent/real.txt'), w.root('share/helper-agent/inlink.txt'));
  const r = (await w.resolve('u_owner', [
    { abs: w.root('share/helper-agent/link.txt') }, { abs: w.root('share/helper-agent/dirlink/out.txt') },
    { agent: 'helper-agent', path: 'link.txt' }, { agent: 'helper-agent', path: 'dirlink/out.txt' },
    { owner: 'mine', path: 'helper-agent/link.txt' },
  ])).json.items;
  for (const [i, a] of r.entries()) assert.deepStrictEqual(a, NOT_FOUND, `item ${i}`);
  assert.strictEqual((await w.resolve('u_owner', [{ abs: w.root('share/helper-agent/inlink.txt') }])).json.items[0].ok, true, 'control: a link to a file inside the root still resolves (the download route serves it too)');
});

test('resolve: {agent, path} and {owner, path} items, mixed with abs, keep their order; members always get their own folder', async (t) => {
  const w = await world(); t.after(() => w.close());
  w.write('share/helper-agent/a.txt', 'A'); w.write('share/b.txt', 'B'); w.write('users/u_sam/files/c.txt', 'C'); w.write('users/u_mo/files/d.txt', 'D');
  const r = (await w.resolve('u_owner', [
    { agent: 'helper-agent', path: 'a.txt' }, { owner: 'mine', path: 'b.txt' }, { path: 'b.txt' }, { owner: 'u_mo', path: 'd.txt' },
    null, 5, 'a.txt', {}, { agent: 'helper-agent', path: 'nope.txt' }, { owner: 'u_nobody', path: 'b.txt' }, { abs: w.root('share/b.txt') },
  ])).json.items;
  assert.deepStrictEqual(r.map(x => x.ok ? `${x.agent || '-'}|${x.owner || '-'}|${x.path}` : 'nf'),
    ['helper-agent|-|a.txt', '-|mine|b.txt', '-|mine|b.txt', '-|u_mo|d.txt', 'nf', 'nf', 'nf', 'nf', 'nf', 'nf', '-|mine|b.txt']);
  // a member naming another owner still lands in their own folder (the existing rule)
  const s = (await w.resolve('u_sam', [{ owner: 'u_mo', path: 'd.txt' }, { owner: 'u_mo', path: 'c.txt' }, { path: 'c.txt' }])).json.items;
  assert.deepStrictEqual(s.map(x => x.ok ? x.owner : 'nf'), ['nf', 'u_sam', 'u_sam']);
  assert.strictEqual((await w.req('u_sam', 'GET', s[1].download)).body.toString(), 'C', 'the owner= link downloads through the existing route');
});

test('resolve: more than 12 items is a 400, exactly 12 is fine, a body without a list is a 400', async (t) => {
  const w = await world(); t.after(() => w.close());
  const abs = w.write('share/helper-agent/a.txt', 'A');
  const twelve = Array.from({ length: 12 }, () => ({ abs }));
  const ok = await w.resolve('u_owner', twelve);
  assert.strictEqual(ok.status, 200); assert.strictEqual(ok.json.items.length, 12);
  const big = await w.resolve('u_owner', [...twelve, { abs }]);
  assert.strictEqual(big.status, 400);
  assert.strictEqual((await w.req('u_owner', 'POST', '/api/files/resolve', { items: 'x' })).status, 400);
  assert.strictEqual((await w.req('u_owner', 'POST', '/api/files/resolve', {})).status, 400);
  assert.strictEqual((await w.resolve('u_owner', [])).json.items.length, 0);
});

// ───────────────────────────── GET /api/files/recent + the upload ledger ─────────────────────────────
test('recent: newest first, with folder/size/kind/download, limit 1..30 (default 10), dot-files and symlinks skipped', async (t) => {
  const w = await world(); t.after(() => w.close());
  const base = 1_700_000_000;
  for (let i = 0; i < 35; i++) w.write(`share/helper-agent/f${String(i).padStart(2, '0')}.txt`, `n${i}`, base + i);
  w.write('share/helper-agent/deep/er/new.md', 'newest', base + 100);
  w.write('share/helper-agent/.hidden.txt', 'h', base + 200);
  w.write('share/helper-agent/.git/obj.txt', 'h', base + 200);
  fs.symlinkSync(w.root('share/helper-agent/f00.txt'), w.root('share/helper-agent/linkfile.txt'));
  fs.symlinkSync(w.root('share/helper-agent/deep'), w.root('share/helper-agent/linkdir'));
  const r = await w.req('u_owner', 'GET', '/api/files/recent?agent=helper-agent');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true); assert.strictEqual(r.json.truncated, false);
  assert.strictEqual(r.json.files.length, 10, 'default limit 10');
  assert.deepStrictEqual(r.json.files[0], { name: 'new.md', path: 'deep/er/new.md', folder: 'deep/er', size: 6, mtime: new Date((base + 100) * 1000).toISOString(), kind: 'text',
    download: '/api/files/download?agent=helper-agent&path=deep%2Fer%2Fnew.md', inline: '/api/files/download?agent=helper-agent&path=deep%2Fer%2Fnew.md&inline=1' });
  assert.deepStrictEqual(r.json.files.slice(1, 4).map(f => f.name), ['f34.txt', 'f33.txt', 'f32.txt'], 'newest first');
  assert.strictEqual(r.json.files[1].folder, '', 'folder is "" at the root');
  const names = (await w.req('u_owner', 'GET', '/api/files/recent?agent=helper-agent&limit=100')).json.files.map(f => f.name);
  assert.strictEqual(names.length, 30, 'limit is capped at 30');
  for (const bad of ['.hidden.txt', 'obj.txt', 'linkfile.txt']) assert.ok(!names.includes(bad), `${bad} is not listed`);
  assert.strictEqual((await w.req('u_owner', 'GET', '/api/files/recent?agent=helper-agent&limit=3')).json.files.length, 3);
  assert.strictEqual((await w.req('u_owner', 'GET', '/api/files/recent?agent=helper-agent&limit=0')).json.files.length, 10, 'a limit below 1 falls back to the default');
  const all = [];
  for (const f of (await w.req('u_owner', 'GET', '/api/files/recent?agent=helper-agent&limit=30')).json.files) all.push(f.path);
  assert.ok(!all.some(p => p.startsWith('linkdir') || p.startsWith('.git')), 'no symlinked folder, no dot-folder');
  // owner= form uses the general share; html is never offered inline
  w.write('share/page.html', '<b>x</b>', base + 500);
  const o = (await w.req('u_owner', 'GET', '/api/files/recent?owner=mine&limit=1')).json.files[0];
  assert.deepStrictEqual([o.path, o.inline, o.download], ['page.html', null, '/api/files/download?owner=mine&path=page.html']);
});

test('recent: the access rule is the Files panel\'s (a member never sees another agent or member)', async (t) => {
  const w = await world(); t.after(() => w.close());
  w.write('share/other-agent/x.txt', 'x'); w.write('users/u_mo/files/m.txt', 'm'); w.write('users/u_sam/files/s.txt', 's');
  const a = await w.req('u_sam', 'GET', '/api/files/recent?agent=other-agent');
  const list = await w.req('u_sam', 'GET', '/api/files?agent=other-agent');
  assert.deepStrictEqual([a.status, a.json], [list.status, list.json]);
  assert.strictEqual(a.status, 403);
  const n = await w.req('u_sam', 'GET', '/api/files/recent?agent=nope'); assert.strictEqual(n.status, 404);
  const mo = await w.req('u_sam', 'GET', '/api/files/recent?owner=u_mo');
  assert.deepStrictEqual(mo.json.files.map(f => f.name), ['s.txt'], 'a member always gets their own folder');
});

test('recent: an uploaded file is left out until its content changes; the ledger survives a restart and keeps the newest 2000', async (t) => {
  const w = await world(); t.after(() => w.close());
  const root = w.files.resolveOwner(USERS.u_owner, 'mine').root;
  w.write('share/by-agent.txt', 'agent made this', 1_700_000_100);
  const up = async (name, body) => { const tg = w.files.uploadTarget(root, '', name, { overwrite: true }); return w.files.saveStream(tg, Readable.from([Buffer.from(body)])); };
  assert.strictEqual((await up('from-person.txt', 'person made this')).ok, true);
  const names = async () => (await w.req('u_owner', 'GET', '/api/files/recent?owner=mine')).json.files.map(f => f.name);
  assert.deepStrictEqual(await names(), ['by-agent.txt'], 'the upload is not "from agents"');
  const ledgerFile = path.join(w.dataDir, 'files-uploads.json');
  const led = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  assert.deepStrictEqual(led.map(e => [e.abs, e.size]), [[path.join(root, 'from-person.txt'), 16]]);
  assert.ok(Number.isFinite(led[0].mtimeMs));
  assert.deepStrictEqual(fs.readdirSync(w.dataDir), ['files-uploads.json'], 'written atomically: no temp file left');
  // a new process (a new lib on the same data folder) reads the ledger lazily
  const again = createFiles({ hubHome: w.home, getUser: (id) => USERS[id] || null, dataDir: w.dataDir });
  assert.deepStrictEqual(again.recent(root).files.map(f => f.name), ['by-agent.txt']);
  // an agent rewrites it: same size, later mtime -> from agents again
  fs.writeFileSync(path.join(root, 'from-person.txt'), 'agent rewrote it');
  fs.utimesSync(path.join(root, 'from-person.txt'), 1_800_000_000, 1_800_000_000);
  assert.deepStrictEqual(await names(), ['from-person.txt', 'by-agent.txt']);
  // size change alone also counts
  assert.strictEqual((await up('again.txt', 'abc')).ok, true);
  assert.ok(!(await names()).includes('again.txt'));
  fs.appendFileSync(path.join(root, 'again.txt'), 'more');
  assert.ok((await names()).includes('again.txt'));
  // the ledger keeps at most 2000 entries, newest last
  fs.mkdirSync(path.join(root, 'many'), { recursive: true });
  for (let i = 0; i < 2003; i++) { const p = path.join(root, 'many', `m${i}.txt`); fs.writeFileSync(p, 'x'); w.files.recordUpload(p); }
  const big = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  assert.strictEqual(big.length, 2000);
  assert.strictEqual(big[big.length - 1].abs, path.join(root, 'many', 'm2002.txt'));
  assert.ok(!big.some(e => e.abs === path.join(root, 'many', 'm0.txt')), 'the oldest entries are dropped');
});

test('recent: stops after the entry cap and says truncated (cap passed as an option)', async (t) => {
  const w = await world(); t.after(() => w.close());
  const root = w.root('share/helper-agent');
  for (let i = 0; i < 12; i++) w.write(`share/helper-agent/f${i}.txt`, 'x', 1_700_000_000 + i);
  const small = w.files.recent(root, { limit: 30, maxEntries: 5 });
  assert.strictEqual(small.truncated, true);
  assert.strictEqual(small.files.length, 5, 'answers from what was seen');
  const roomy = w.files.recent(root, { limit: 30, maxEntries: 12 });
  assert.strictEqual(roomy.truncated, false, 'exactly the cap is not truncated');
  assert.strictEqual(roomy.files.length, 12);
  const shallow = w.files.recent(root, { limit: 30, maxDepth: 0 });
  w.write('share/helper-agent/a/b/c/deep.txt', 'x');
  assert.ok(!w.files.recent(root, { limit: 30, maxDepth: 1 }).files.some(f => f.name === 'deep.txt'), 'max depth is honoured');
  assert.ok(w.files.recent(root, { limit: 30 }).files.some(f => f.name === 'deep.txt'), 'depth 3 is within the default 8');
  assert.strictEqual(shallow.files.length, 12);
  assert.strictEqual(w.files.recent(w.root('share/not-there')).files.length, 0, 'a missing root is just empty');
});

// ───────────────────────────── GET /api/files/zip ─────────────────────────────
test('zip: a valid zip (data descriptors, UTF-8 names, nested folders); dot-files and symlinks are left out', async (t) => {
  const w = await world(); t.after(() => w.close());
  const text = Buffer.from('line of text\n'.repeat(500));
  const bin = crypto.randomBytes(3000);
  w.write('share/helper-agent/proj/readme.txt', text);
  w.write('share/helper-agent/proj/héllo/日本語 ファイル.txt', 'unicode content');
  w.write('share/helper-agent/proj/a/b/c/deep.bin', bin);
  w.write('share/helper-agent/proj/empty.txt', '');
  w.write('share/helper-agent/proj/pic.png', crypto.randomBytes(500));
  w.write('share/helper-agent/proj/.secret', 'no');
  w.write('share/helper-agent/proj/.hiddendir/x.txt', 'no');
  w.write('share/helper-agent/outside.txt', 'outside the zipped folder');
  w.write('elsewhere/far.txt', 'far away');
  fs.symlinkSync(w.root('share/helper-agent/proj/readme.txt'), w.root('share/helper-agent/proj/link-inside.txt'));
  fs.symlinkSync(w.root('elsewhere/far.txt'), w.root('share/helper-agent/proj/link-outside.txt'));
  fs.symlinkSync(w.root('elsewhere'), w.root('share/helper-agent/proj/link-dir'));
  const r = await w.req('u_owner', 'GET', '/api/files/zip?agent=helper-agent&path=proj');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['content-type'], 'application/zip');
  assert.strictEqual(r.headers['content-disposition'], "attachment; filename*=UTF-8''proj.zip");
  assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
  assert.strictEqual(r.headers['cache-control'], 'no-store');
  assert.strictEqual(r.headers['content-length'], undefined, 'streamed: no Content-Length');
  const z = readZip(r.body);
  assert.deepStrictEqual(Object.keys(z).sort(), ['a/b/c/deep.bin', 'empty.txt', 'héllo/日本語 ファイル.txt', 'pic.png', 'readme.txt']);
  assert.ok(z['readme.txt'].equals(text)); assert.ok(z['a/b/c/deep.bin'].equals(bin));
  assert.strictEqual(z['héllo/日本語 ファイル.txt'].toString(), 'unicode content');
  assert.strictEqual(z['empty.txt'].length, 0);
  assert.strictEqual(w.results.at(-1).ok, true);
  assert.strictEqual(w.results.at(-1).entries, 5);
});

test('zip: the whole root is "files.zip"; a member zips their own agent folder; the folder name is percent-encoded in the header', async (t) => {
  const w = await world(); t.after(() => w.close());
  w.write('share/top.txt', 't'); w.write('share/reports 2026/日本.txt', 'j');
  const root = await w.req('u_owner', 'GET', '/api/files/zip?owner=mine');
  assert.strictEqual(root.headers['content-disposition'], "attachment; filename*=UTF-8''files.zip");
  assert.ok(Object.keys(readZip(root.body)).includes('top.txt'));
  const sub = await w.req('u_owner', 'GET', '/api/files/zip?owner=mine&path=' + encodeURIComponent('reports 2026'));
  assert.strictEqual(sub.headers['content-disposition'], "attachment; filename*=UTF-8''reports%202026.zip");
  assert.deepStrictEqual(Object.keys(readZip(sub.body)), ['日本.txt']);
  w.write('users/u_sam/files/work/x.txt', 'x');
  const mine = await w.req('u_sam', 'GET', '/api/files/zip?agent=sam-agent&path=work');
  assert.deepStrictEqual(Object.keys(readZip(mine.body)), ['x.txt']);
});

test('zip: an empty folder gives a valid empty zip', async (t) => {
  const w = await world(); t.after(() => w.close());
  fs.mkdirSync(w.root('share/helper-agent/void/.only-hidden'), { recursive: true });
  w.write('share/helper-agent/void/.dot', 'x');
  const r = await w.req('u_owner', 'GET', '/api/files/zip?agent=helper-agent&path=void');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.length, 22, 'just the end record');
  assert.deepStrictEqual(readZip(r.body), {});
});

test('zip: over the file limit or the size limit is a 413 JSON before any zip byte; limits come from the settings', async (t) => {
  const w = await world({ settings: { filesZipMaxFiles: 2 } }); t.after(() => w.close());
  for (let i = 0; i < 3; i++) w.write(`share/helper-agent/many/f${i}.txt`, 'x'.repeat(100));
  const r = await w.req('u_owner', 'GET', '/api/files/zip?agent=helper-agent&path=many');
  assert.strictEqual(r.status, 413);
  assert.match(r.headers['content-type'], /json/);
  assert.deepStrictEqual(r.json, { error: 'This folder is too big to download as one zip: 3 files and 300 B (the limit is 2 files and 2 GB). Download its folders one at a time.', files: 3, bytes: 300, maxFiles: 2, maxBytes: 2048 * 1048576 });
  assert.strictEqual(r.body.toString().startsWith('PK'), false, 'no zip byte');
  const ok = await w.req('u_owner', 'GET', '/api/files/zip?agent=helper-agent&path=many/f0.txt'); assert.strictEqual(ok.status, 400);
  // the size limit, from filesZipMaxMb (a fraction of a MB keeps the test small)
  const w2 = await world({ settings: { filesZipMaxMb: 0.0005 } }); t.after(() => w2.close());
  w2.write('share/helper-agent/big/a.bin', crypto.randomBytes(400)); w2.write('share/helper-agent/big/b.bin', crypto.randomBytes(400));
  const b = await w2.req('u_owner', 'GET', '/api/files/zip?agent=helper-agent&path=big');
  assert.strictEqual(b.status, 413);
  assert.deepStrictEqual([b.json.files, b.json.bytes, b.json.maxFiles, b.json.maxBytes], [2, 800, 2000, 524]);
  assert.match(b.json.error, /^This folder is too big to download as one zip: 2 files and 800 B \(the limit is 2,000 files and 524 B\)\. Download its folders one at a time\.$/);
  assert.strictEqual(b.body.toString().startsWith('PK'), false);
  assert.ok(!w2.results.some(x => x && x.ok), 'streamZip never ran');
  // the settings are capped: never above 3900 MB (no ZIP64), garbage falls back to the defaults
  assert.deepStrictEqual(filesLib.zipLimits(99999, 99999999), { maxBytes: 3900 * 1048576, maxFiles: 65535 });
  assert.deepStrictEqual(filesLib.zipLimits(undefined, 'x'), { maxBytes: 2048 * 1048576, maxFiles: 2000 });
});

test('zip: a file path is 400 "that is a file"; a missing folder 404; ".." and a symlinked folder out are refused like the list route', async (t) => {
  const w = await world(); t.after(() => w.close());
  w.write('share/helper-agent/f.txt', 'x'); w.write('elsewhere/out/o.txt', 'o');
  fs.symlinkSync(w.root('elsewhere/out'), w.root('share/helper-agent/escape'));
  const f = await w.req('u_owner', 'GET', '/api/files/zip?agent=helper-agent&path=f.txt');
  assert.deepStrictEqual([f.status, f.json], [400, { error: 'that is a file' }]);
  const m = await w.req('u_owner', 'GET', '/api/files/zip?agent=helper-agent&path=nope');
  assert.deepStrictEqual([m.status, m.json], [404, { error: 'not found' }]);
  for (const bad of ['..', '../other-agent', 'escape']) {
    const z = await w.req('u_owner', 'GET', `/api/files/zip?agent=helper-agent&path=${encodeURIComponent(bad)}`);
    const l = await w.req('u_owner', 'GET', `/api/files?agent=helper-agent&path=${encodeURIComponent(bad)}`);
    assert.deepStrictEqual([z.status, z.json], [400, { error: 'bad path' }], bad);
    assert.deepStrictEqual([l.status, l.json], [400, { error: 'bad path' }], `${bad}: the list route says the same`);
  }
});

test('zip: check=1 answers the JSON summary (or the same 413/400/404) and writes no zip bytes', async (t) => {
  const w = await world({ settings: { filesZipMaxFiles: 3 } }); t.after(() => w.close());
  w.write('share/helper-agent/ok/a.txt', 'aaaa'); w.write('share/helper-agent/ok/sub/b.txt', 'bb');
  for (let i = 0; i < 4; i++) w.write(`share/helper-agent/toomany/f${i}`, 'x');
  const base = '/api/files/zip?agent=helper-agent&check=1&path=';
  const ok = await w.req('u_owner', 'GET', base + 'ok');
  assert.strictEqual(ok.status, 200); assert.match(ok.headers['content-type'], /json/);
  assert.deepStrictEqual(ok.json, { ok: true, files: 2, bytes: 6, maxFiles: 3, maxBytes: 2048 * 1048576 });
  assert.strictEqual(ok.headers['content-disposition'], undefined);
  assert.strictEqual(w.results.at(-1), 'json', 'the zip writer did not run');
  const big = await w.req('u_owner', 'GET', base + 'toomany');
  const bigReal = await w.req('u_owner', 'GET', '/api/files/zip?agent=helper-agent&path=toomany');
  assert.strictEqual(big.status, 413); assert.deepStrictEqual(big.json, bigReal.json, 'the same refusal as the real download');
  assert.deepStrictEqual([(await w.req('u_owner', 'GET', base + 'ok/sub/b.txt')).status, (await w.req('u_owner', 'GET', base + 'ok/sub/b.txt')).json], [400, { error: 'that is a file' }]);
  assert.strictEqual((await w.req('u_owner', 'GET', base + 'missing')).status, 404);
  assert.strictEqual((await w.req('u_owner', 'GET', base + '..')).status, 400);
  assert.strictEqual((await w.req('u_sam', 'GET', '/api/files/zip?agent=other-agent&check=1')).status, 403);
});

test('zip: a member asking for another member\'s or another agent\'s folder gets the list route\'s refusal', async (t) => {
  const w = await world(); t.after(() => w.close());
  w.write('share/other-agent/s.txt', 's'); w.write('users/u_mo/files/m.txt', 'm'); w.write('users/u_sam/files/own.txt', 'o');
  for (const q of ['agent=other-agent', 'agent=no-such-agent']) {
    const z = await w.req('u_sam', 'GET', `/api/files/zip?${q}`);
    const l = await w.req('u_sam', 'GET', `/api/files?${q}`);
    assert.deepStrictEqual([z.status, z.json], [l.status, l.json], q);
    assert.ok(z.status === 403 || z.status === 404);
    assert.strictEqual(z.body.toString().startsWith('PK'), false);
  }
  // owner=<another member>: the existing rule hands a member their own folder, never theirs
  const o = await w.req('u_sam', 'GET', '/api/files/zip?owner=u_mo');
  assert.deepStrictEqual(Object.keys(readZip(o.body)), ['own.txt']);
  assert.strictEqual((await w.req('u_mo', 'GET', '/api/files/zip?agent=sam-agent')).status, 403);
  assert.strictEqual((await w.req('u_owner', 'GET', '/api/files/zip?owner=u_mo')).status, 200, 'an admin may open any owner');
  assert.strictEqual((await w.req('u_owner', 'GET', '/api/files/zip?owner=u_nobody')).status, 403, 'unknown owner refused like the list route');
});

test('zip: a client that disconnects mid-stream stops the reading, with no unhandled error', async (t) => {
  let opens = 0;
  const fsCount = Object.create(fs); fsCount.openSync = (...a) => { opens++; return fs.openSync(...a); };
  const w = await world({ fsImpl: fsCount }); t.after(() => w.close());
  for (let i = 0; i < 6; i++) w.write(`share/helper-agent/lots/big${i}.bin`, crypto.randomBytes(6 * 1024 * 1024));
  const stray = []; const onStray = (e) => stray.push(e);
  process.on('unhandledRejection', onStray); process.on('uncaughtException', onStray);
  t.after(() => { process.off('unhandledRejection', onStray); process.off('uncaughtException', onStray); });
  await new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: w.port, path: '/api/files/zip?agent=helper-agent&path=lots', headers: { 'x-user': 'u_owner' } }, (res) => {
      res.once('data', () => { res.destroy(); resolve(); });
      res.on('error', () => {});
    });
    r.on('error', reject); r.end();
  });
  const deadline = Date.now() + 5000;
  while (!w.results.length && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(w.results.length, 1, 'the stream ended');
  assert.strictEqual(w.results[0].ok, false); assert.strictEqual(w.results[0].aborted, true);
  assert.ok(opens < 6, `stopped reading: ${opens} of 6 files opened`);
  await new Promise(r => setTimeout(r, 100));
  assert.deepStrictEqual(stray, [], 'nothing unhandled');
});

test('zip: a file that grew past the limit cuts the stream (no complete zip); a file that vanished or became a symlink is skipped', async (t) => {
  const w = await world(); t.after(() => w.close());
  const root = w.root('share/helper-agent');
  w.write('share/helper-agent/d/a.txt', 'a'.repeat(100)); w.write('share/helper-agent/d/b.txt', 'b'.repeat(100));
  w.write('share/helper-agent/d/c.txt', 'c'.repeat(100)); w.write('share/helper-agent/d/d.txt', 'dddd');
  w.write('elsewhere/secret.txt', 'SECRET');
  const sink = (extra = {}) => new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const plan = w.files.zipPlan(root, 'd', { maxFiles: 10, maxBytes: 500 });
      assert.strictEqual(plan.tooBig, false);
      fs.unlinkSync(path.join(root, 'd/a.txt'));                                         // vanished since the scan
      fs.unlinkSync(path.join(root, 'd/b.txt')); fs.symlinkSync(w.root('elsewhere/secret.txt'), path.join(root, 'd/b.txt'));   // swapped for a symlink
      if (extra.grow) fs.appendFileSync(path.join(root, 'd/c.txt'), 'z'.repeat(450));    // grew past the limit
      const r = await w.files.streamZip(root, plan, res, { maxBytes: plan.maxBytes });
      server.closeAllConnections(); server.close(); resolve(r);
    });
    server.listen(0, '127.0.0.1', () => {
      const rq = http.get({ host: '127.0.0.1', port: server.address().port, path: '/' }, (res) => { const cs = []; res.on('data', c => cs.push(c)); res.on('end', () => (sink.last = { body: Buffer.concat(cs), aborted: false })); res.on('aborted', () => (sink.last = { body: Buffer.concat(cs), aborted: true })); res.on('error', () => {}); });
      rq.on('error', () => {});
    });
  });
  const r1 = await sink();
  assert.strictEqual(r1.ok, true);
  await new Promise(r => setTimeout(r, 50));
  const z = readZip(sink.last.body);
  assert.deepStrictEqual(Object.keys(z).sort(), ['c.txt', 'd.txt'], 'the vanished file and the symlink are skipped');
  assert.ok(!Object.values(z).some(b => b.toString().includes('SECRET')), 'the symlink target was never read');
  // second round: c.txt grew by 450 bytes -> over the 500 limit
  fs.unlinkSync(path.join(root, 'd/b.txt')); w.write('share/helper-agent/d/a.txt', 'a'.repeat(100)); w.write('share/helper-agent/d/b.txt', 'b'.repeat(100));
  const r2 = await sink({ grow: true });
  assert.strictEqual(r2.ok, false);
  await new Promise(r => setTimeout(r, 50));
  const tail = sink.last.body;
  const complete = tail.length >= 22 && tail.readUInt32LE(tail.length - 22) === 0x06054b50;
  assert.ok(sink.last.aborted || !complete, 'the client never got a complete zip');
});

// Review hardening (lead): a walk cut short is refused, never zipped with files silently missing; and on Linux an opened file
// whose real place (/proc/self/fd) is outside the root is skipped, whatever the path checks before the open said.
test('zip: folders nested deeper than the walk allows are refused (413), not zipped partially', async (t) => {
  const w = await world(); t.after(() => w.close());
  const deep = Array.from({ length: 70 }, (_, i) => `n${i}`).join('/');
  w.write(`share/helper-agent/deep/${deep}/bottom.txt`, 'x');
  w.write('share/helper-agent/deep/top.txt', 'y');
  const plan = w.files.zipPlan(w.root('share/helper-agent'), 'deep', { maxFiles: 10, maxBytes: 1e6 });
  assert.strictEqual(plan.tooBig, true);
  assert.match(plan.error, /nested too deep/);
  const r = await w.req('owner', 'GET', '/api/files/zip?agent=helper-agent&path=deep&check=1');
  assert.strictEqual(r.status, 413);
});

test('zip: a file whose opened descriptor is outside the root is skipped (Linux /proc/self/fd check)', { skip: process.platform !== 'linux' }, async (t) => {
  const fakeFs = Object.assign(Object.create(fs), { readlinkSync: (p, ...a) => (String(p).startsWith('/proc/self/fd/') && fs.statSync(p).isFile() ? '/somewhere/else/secret.txt' : fs.readlinkSync(p, ...a)) });
  const w = await world({ fsImpl: fakeFs }); t.after(() => w.close());
  w.write('share/helper-agent/k/a.txt', 'AAA');
  const r = await w.req('owner', 'GET', '/api/files/zip?agent=helper-agent&path=k');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(Object.keys(readZip(r.body)), [], 'the file that was really elsewhere is not in the zip');
});

// ───────────────────────────── review round 1 (F1): bound walks, no silent holes, safe names ─────────────────────────────
/** An fs whose lstat/open/readdir/stat/realpath of a path ending in "/sub" swaps that folder (once): it moves away and a symlink to an outside folder takes its place. */
function swappingFs(swap, { fallback = false, child = false } = {}) {
  const f = Object.create(fs); const calls = { readdir: [] }; let done = false;
  // child: the swap fires only on the first lstat of a child of "sub" (after every folder check passed). fallback: no /proc/self/fd.
  const fire = (p) => { if (!done && (child ? /[\\/]sub[\\/][^\\/]+$/ : /[\\/]sub$/).test(String(p))) { done = true; swap(); } };
  f.lstatSync = (p, ...a) => { const r = fs.lstatSync(p, ...a); fire(p); return r; };   // after the lstat: the check passed, then the swap
  if (!child) {
    f.openSync = (p, ...a) => { fire(p); return fs.openSync(p, ...a); };
    f.readdirSync = (p, ...a) => { calls.readdir.push(String(p)); fire(p); return fs.readdirSync(p, ...a); };
    f.statSync = (p, ...a) => { fire(p); return fs.statSync(p, ...a); };
    f.realpathSync = (p, ...a) => { fire(p); return fs.realpathSync(p, ...a); };
  }
  if (fallback) f.existsSync = (p, ...a) => (String(p) === '/proc/self/fd' ? false : fs.existsSync(p, ...a));
  f.swapped = () => done; f.calls = calls;
  return f;
}
const SWAP_MODES = process.platform === 'linux' ? [false, true] : [true];
for (const fallback of SWAP_MODES) for (const which of ['recent', 'zipPlan']) {
  test(`${which}${fallback ? ' (no /proc fallback)' : ''}: a folder swapped for a symlink between the check and the read is never listed (no outside name, size or count)`, async (t) => {
    let w; const fsx = swappingFs(() => {
      fs.renameSync(w.root('share/helper-agent/race/sub'), w.root('share/helper-agent/race/sub-moved-away'));
      fs.symlinkSync(w.root('elsewhere/out'), w.root('share/helper-agent/race/sub'));
    }, { fallback });
    w = await world({ fsImpl: fsx }); t.after(() => w.close());
    w.write('share/helper-agent/race/top.txt', 'top');
    w.write('share/helper-agent/race/sub/inner.txt', 'inner');
    w.write('elsewhere/out/secret-outside.txt', 'S'.repeat(777));
    const root = w.root('share/helper-agent/race');
    let names, count, bytes;
    if (which === 'recent') { const r = w.files.recent(root, { limit: 30 }); names = r.files.map(f => f.name); count = r.files.length; bytes = r.files.reduce((a, f) => a + f.size, 0); }
    else { const p = w.files.zipPlan(root, '', { maxFiles: 10, maxBytes: 1e6 }); names = p.files.map(f => f.name); count = p.count; bytes = p.bytes; }
    assert.strictEqual(fsx.swapped(), true, 'the swap happened during the walk');
    assert.ok(!names.some(n => n.includes('secret-outside')), `no outside name: ${names}`);
    assert.ok(count <= 1 && bytes <= 3, `no outside count or size: ${count} files, ${bytes} bytes`);
    if (process.platform === 'linux' && !fallback) assert.ok(fsx.calls.readdir.every(p => p.startsWith('/proc/self/fd/') || p === fs.realpathSync(root) || p === root || !/[\\/]sub$/.test(p)),
      `every folder read is bound to an opened descriptor, never the path "sub": ${fsx.calls.readdir}`);
  });
}

// No /proc/self/fd: the folder checks pass, then "sub" is swapped for a symlink right at the first lstat of one of its children.
for (const which of ['recent', 'zipPlan']) {
  test(`${which} (no /proc fallback): a folder swapped for a symlink right after its checks, at the lstat of a child, shows no outside file`, async (t) => {
    let w; const fsx = swappingFs(() => {
      fs.renameSync(w.root('share/helper-agent/race/sub'), w.root('share/helper-agent/race/sub-moved-away'));
      fs.symlinkSync(w.root('elsewhere/out'), w.root('share/helper-agent/race/sub'));
    }, { fallback: true, child: true });
    w = await world({ fsImpl: fsx }); t.after(() => w.close());
    w.write('share/helper-agent/race/top.txt', 'top');
    w.write('share/helper-agent/race/sub/inner.txt', 'inner');
    w.write('elsewhere/out/inner.txt', 'O'.repeat(500));
    w.write('elsewhere/out/secret-outside.txt', 'S'.repeat(777));
    const root = w.root('share/helper-agent/race');
    if (which === 'recent') {
      const r = w.files.recent(root, { limit: 30 });
      assert.strictEqual(fsx.swapped(), true, 'the swap happened at the child lstat');
      assert.deepStrictEqual(r.files.map(f => f.path), ['top.txt'], 'the child seen through the swap is not listed');
    } else {
      const p = w.files.zipPlan(root, '', { maxFiles: 10, maxBytes: 1e6 });
      assert.strictEqual(fsx.swapped(), true, 'the swap happened at the child lstat');
      assert.strictEqual(p.incomplete, true, 'the zip is refused as incomplete');
      assert.strictEqual(p.tooBig, true);
      assert.ok(!p.files.some(f => /inner|secret-outside/.test(f.name)), `no outside file in the list: ${p.files.map(f => f.name)}`);
    }
  });
}

const runningAsRoot = !!(process.getuid && process.getuid() === 0);
test('zip: a subfolder that cannot be read refuses the zip (incomplete, 413 for check and download); recent lists the readable files', { skip: runningAsRoot && 'root can read everything' }, async (t) => {
  const w = await world(); t.after(() => { try { fs.chmodSync(w.root('share/helper-agent/p/locked'), 0o755); } catch {} w.close(); });
  w.write('share/helper-agent/p/ok.txt', 'fine'); w.write('share/helper-agent/p/locked/inside.txt', 'hidden');
  fs.chmodSync(w.root('share/helper-agent/p/locked'), 0o000);
  const plan = w.files.zipPlan(w.root('share/helper-agent'), 'p', { maxFiles: 10, maxBytes: 1e6 });
  assert.strictEqual(plan.incomplete, true, 'the plan says it is incomplete');
  assert.strictEqual(plan.error, "Some files in this folder can't be read (for example locked), so it can't be downloaded as one zip.");
  const check = await w.req('u_owner', 'GET', '/api/files/zip?agent=helper-agent&path=p&check=1');
  assert.strictEqual(check.status, 413); assert.strictEqual(check.json.error, plan.error);
  const real = await w.req('u_owner', 'GET', '/api/files/zip?agent=helper-agent&path=p');
  assert.strictEqual(real.status, 413); assert.strictEqual(real.body.toString().startsWith('PK'), false);
  const rec = await w.req('u_owner', 'GET', '/api/files/recent?agent=helper-agent');
  assert.deepStrictEqual(rec.json.files.map(f => f.name), ['ok.txt']);
});

/** Runs streamZip into a real http client: { result, body, aborted }. */
function streamToClient(files, root, plan) {
  return new Promise((resolve) => {
    let got = { body: Buffer.alloc(0), aborted: false }, result;
    const server = http.createServer(async (req, res) => {
      result = await files.streamZip(root, plan, res, { maxBytes: plan.maxBytes });
      setTimeout(() => { server.closeAllConnections(); server.close(); resolve({ result, ...got }); }, 80);
    });
    server.listen(0, '127.0.0.1', () => {
      const rq = http.get({ host: '127.0.0.1', port: server.address().port, path: '/' }, (res) => {
        const cs = []; res.on('data', c => { cs.push(c); got.body = Buffer.concat(cs); });
        res.on('aborted', () => { got.aborted = true; }); res.on('error', () => {});
      });
      rq.on('error', () => {});
    });
  });
}

test('zip: a file that became unreadable after the scan (EACCES) destroys the response: no complete zip', { skip: runningAsRoot && 'root can read everything' }, async (t) => {
  const w = await world(); t.after(() => { try { fs.chmodSync(w.root('share/helper-agent/e/b.txt'), 0o644); } catch {} w.close(); });
  w.write('share/helper-agent/e/a.txt', 'aaa'); w.write('share/helper-agent/e/b.txt', 'bbb'); w.write('share/helper-agent/e/c.txt', 'ccc');
  const root = w.root('share/helper-agent');
  const plan = w.files.zipPlan(root, 'e', { maxFiles: 10, maxBytes: 1e6 });
  assert.strictEqual(plan.tooBig, false);
  fs.chmodSync(w.root('share/helper-agent/e/b.txt'), 0o000);
  const r = await streamToClient(w.files, root, plan);
  assert.strictEqual(r.result.ok, false, 'streamZip reports the failure');
  const tail = r.body; const complete = tail.length >= 22 && tail.readUInt32LE(tail.length - 22) === 0x06054b50;
  assert.ok(r.aborted || !complete, 'the client never got a complete zip');
});

test('zip: entry names are safe to extract anywhere (backslash, colon, control characters; duplicates numbered); the bytes are intact', async (t) => {
  const w = await world(); t.after(() => w.close());
  const evil = Buffer.from('@echo evil'), colon = Buffer.from('colon file'), under = Buffer.from('underscore file');
  w.write('share/helper-agent/slip/' + 'x\\..\\..\\evil.bat', evil);
  w.write('share/helper-agent/slip/a:b.txt', colon);
  w.write('share/helper-agent/slip/a_b.txt', under);
  w.write('share/helper-agent/slip/ctl\x01name\x7f.txt', 'c');
  w.write('share/helper-agent/slip/sub/q?"<>|*.txt', 'q');
  const r = await w.req('u_owner', 'GET', '/api/files/zip?agent=helper-agent&path=slip');
  assert.strictEqual(r.status, 200);
  const z = readZip(r.body);
  const names = Object.keys(z).sort();
  assert.deepStrictEqual(names, ['a_b (2).txt', 'a_b.txt', 'ctl_name_.txt', 'sub/q______.txt', 'x_.._.._evil.bat']);
  for (const n of names) {
    assert.ok(!n.includes('\\') && !n.includes(':') && !n.startsWith('/') && !/[\u0000-\u001f\u007f]/.test(n), `safe name: ${JSON.stringify(n)}`);
    assert.ok(!n.split('/').some(s => s === '..' || s === '.' || s === ''), `no dot segment: ${n}`);
  }
  assert.ok(z['x_.._.._evil.bat'].equals(evil));
  assert.ok(z['a_b.txt'].equals(colon) && z['a_b (2).txt'].equals(under), 'bytes intact, each under its own entry');
  assert.deepStrictEqual(['', '.', '..'].map(filesLib.sanitizeSegment), ['_', '_', '_']);
});

test('zip names: Windows and macOS safe, unique ignoring case, files and folders in one namespace per folder', async (t) => {
  const w = await world(); t.after(() => w.close());
  const base = 'share/helper-agent/win/';
  w.write(base + 'A.txt', 'upper'); w.write(base + 'a.txt', 'lower');
  w.write(base + 'x.txt ', 'with space'); w.write(base + 'x.txt', 'plain');
  w.write(base + 'CON.txt', 'reserved'); w.write(base + 'dir./in.txt', 'dotdir');
  w.write(base + 'a:/b.txt', 'colon folder'); w.write(base + 'a_', 'file a_');
  w.write(base + 'Docs/one.txt', '1'); w.write(base + 'docs/two.txt', '2');
  const r = await w.req('u_owner', 'GET', '/api/files/zip?agent=helper-agent&path=win');
  assert.strictEqual(r.status, 200);
  const z = readZip(r.body), names = Object.keys(z);
  const lc = (s) => s.toLowerCase();
  const atxt = names.filter(n => lc(n).startsWith('a') && /^a( \(\d+\))?\.txt$/i.test(n));
  assert.strictEqual(atxt.length, 2, `both A.txt and a.txt are kept: ${names}`);
  assert.ok(names.includes('A.txt') && names.includes('a (2).txt'), `A.txt first (sorted), a.txt numbered: ${names}`);
  assert.ok(z['A.txt'].equals(Buffer.from('upper')) && z['a (2).txt'].equals(Buffer.from('lower')));
  assert.ok(names.includes('x.txt') && names.includes('x.txt_'), `"x.txt " and "x.txt" stay distinct: ${names}`);
  assert.ok(z['x.txt_'].equals(Buffer.from('with space')));
  assert.ok(names.includes('_CON.txt'), `reserved name prefixed: ${names}`);
  assert.ok(names.includes('dir_/in.txt'), `trailing dot in a folder name: ${names}`);
  // "a:" (folder) and "a_" (file) both sanitise to "a_": one of them is numbered, nothing is both a file and a parent.
  const colon = names.find(n => n.endsWith('/b.txt') && lc(n).startsWith('a_'));
  assert.ok(colon, `the colon folder's file is in the zip: ${names}`);
  assert.ok(z[colon].equals(Buffer.from('colon folder')));
  const plainA = names.find(n => lc(n).startsWith('a_') && !n.includes('/'));
  assert.ok(plainA && z[plainA].equals(Buffer.from('file a_')), `the file a_ is in the zip: ${names}`);
  assert.notStrictEqual(lc(colon.split('/')[0]), lc(plainA), 'file and folder have different names');
  // "Docs" and "docs" folders merge into one case-insensitive namespace: two folders, two distinct names.
  const docsDirs = new Set(names.filter(n => /^docs/i.test(n)).map(n => n.split('/')[0].toLowerCase()));
  assert.strictEqual(docsDirs.size, 2, `Docs and docs are different folders after sanitising: ${names}`);
  assert.deepStrictEqual(['CON', 'con.txt', 'Lpt9.log', 'NUL', 'COM1', 'com10', 'x.', 'y ', 'ok'].map(filesLib.sanitizeSegment),
    ['_CON', '_con.txt', '_Lpt9.log', '_NUL', '_COM1', 'com10', 'x_', 'y_', 'ok']);
});

test('zip names: a name over 65535 bytes makes the zip incomplete, never silently skipped', async (t) => {
  const w = await world(); t.after(() => w.close());
  w.write('share/helper-agent/long/ok.txt', 'ok');
  const plan0 = w.files.zipPlan(w.root('share/helper-agent'), 'long', { maxFiles: 10, maxBytes: 1e6 });
  assert.strictEqual(plan0.incomplete, undefined);
  // Fake a very deep path through an fs whose directory listing returns an over-long name.
  const fsx = Object.create(fs); const long = 'n'.repeat(70000);
  fsx.readdirSync = (p, ...a) => { const r = fs.readdirSync(p, ...a); return String(p).endsWith('long') || /\/proc\/self\/fd\//.test(String(p)) ? [...r, long] : r; };
  fsx.lstatSync = (p, ...a) => (String(p).endsWith(long) ? fs.lstatSync(w.root('share/helper-agent/long/ok.txt')) : fs.lstatSync(p, ...a));
  const w2 = await world({ fsImpl: fsx }); t.after(() => w2.close());
  w2.write('share/helper-agent/long/ok.txt', 'ok');
  const plan = w2.files.zipPlan(w2.root('share/helper-agent'), 'long', { maxFiles: 10, maxBytes: 1e6 });
  assert.strictEqual(plan.incomplete, true, 'the over-long name makes the plan incomplete');
  assert.strictEqual(plan.tooBig, true);
});

test('zip: files are opened with O_NONBLOCK, the JS CRC-32 matches zlib.crc32 (and a zip is still correct without zlib.crc32), the walk cap is 20,000', async (t) => {
  const opens = [];
  const fsRec = Object.create(fs); fsRec.openSync = (p, flags, ...a) => { opens.push([String(p), flags]); return fs.openSync(p, flags, ...a); };
  const w = await world({ fsImpl: fsRec }); t.after(() => w.close());
  w.write('share/helper-agent/n/data.bin', crypto.randomBytes(5000));
  const r = await w.req('u_owner', 'GET', '/api/files/zip?agent=helper-agent&path=n');
  assert.strictEqual(r.status, 200);
  const file = opens.find(([p]) => p.endsWith('data.bin'));
  assert.ok(file, 'the file was opened');
  assert.ok(file[1] & fs.constants.O_NONBLOCK, 'O_NONBLOCK is in the open flags of a zipped file');
  assert.ok(file[1] & fs.constants.O_NOFOLLOW, 'O_NOFOLLOW stays');
  assert.strictEqual(filesLib.ZIP_WALK_MAX_ENTRIES, 20000);
  assert.strictEqual(filesLib.crc32Js(Buffer.alloc(0)), 0); assert.strictEqual(filesLib.crc32Js(Buffer.from('123456789')), 0xCBF43926);
  if (typeof zlib.crc32 === 'function') {
    for (let i = 0; i < 20; i++) {
      const a = crypto.randomBytes(Math.floor(Math.random() * 3000)), b = crypto.randomBytes(Math.floor(Math.random() * 3000));
      assert.strictEqual(filesLib.crc32Js(a), zlib.crc32(a) >>> 0);
      assert.strictEqual(filesLib.crc32Js(b, filesLib.crc32Js(a)), zlib.crc32(Buffer.concat([a, b])) >>> 0, 'chained with the previous value');
    }
    const saved = zlib.crc32; let again;
    zlib.crc32 = undefined;
    try { again = await w.req('u_owner', 'GET', '/api/files/zip?agent=helper-agent&path=n'); } finally { zlib.crc32 = saved; }
    assert.strictEqual(again.status, 200);
    assert.strictEqual(Object.keys(readZip(again.body)).length, 1, 'a valid zip (CRC checked) built with the JS fallback');
  }
});

// ───────────────────────────── access ─────────────────────────────
test('access: the three new routes are member-usable (signed-in session), like the other /api/files routes', () => {
  for (const p of ['/api/files/resolve', '/api/files/recent', '/api/files/zip']) {
    assert.deepStrictEqual(access.classifyRoute(p, p.endsWith('resolve') ? 'POST' : 'GET'), { kind: 'session' }, p);
    assert.ok(access.SESSION_EXACT.has(p), `${p} is in SESSION_EXACT`);
  }
  assert.deepStrictEqual(access.classifyRoute('/api/files/zip/extra'), { kind: 'admin' }, 'a longer path is not covered');
});

test('lib: fmtBytes, kindOf, downloadUrl and resolveAbs basics', () => {
  assert.deepStrictEqual([0, 512, 1024, 1229, 9.4 * 1048576, 1.1 * 1073741824, 2 * 1073741824].map(filesLib.fmtBytes), ['0 B', '512 B', '1 KB', '1.2 KB', '9.4 MB', '1.1 GB', '2 GB']);
  assert.deepStrictEqual(['A.PNG', 'x.pdf', 'x.tar', 'noext', '.hidden'].map(filesLib.kindOf), ['image', 'pdf', 'archive', 'other', 'other']);
  assert.strictEqual(filesLib.downloadUrl({ agent: 'a b', path: 'x/y z.txt' }, { inline: true }), '/api/files/download?agent=a%20b&path=x%2Fy%20z.txt&inline=1');
  assert.strictEqual(filesLib.downloadUrl({ owner: null, path: 'f' }), '/api/files/download?owner=mine&path=f');
});
