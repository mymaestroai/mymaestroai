'use strict';
// The archive inside a backup (lib/backup/tar.js): our writer round-trips through our reader and through the system
// tar; the reader refuses anything a crafted backup could use to write outside the restore folder or exhaust the disk.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { tarStream, readTar, _test } = require('../lib/backup/tar');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-tar-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

async function collect(gen) { const out = []; for await (const b of gen) out.push(b); return Buffer.concat(out); }
async function readAll(buf, limits) {
  const out = [];
  for await (const e of readTar((async function* () { for (let i = 0; i < buf.length; i += 3001) yield buf.subarray(i, i + 3001); })(), limits)) {
    const chunks = [];
    if (e.type === 'file') for await (const c of e.content()) chunks.push(c);
    out.push({ path: e.path, type: e.type, mode: e.mode, size: e.size, linkname: e.linkname, data: Buffer.concat(chunks) });
  }
  return out;
}
const longName = 'workspaces/agent/' + Array(5).fill('déjà-vu-'.repeat(8)).join('/') + '/notes.md';   // > 255 bytes in all, not ASCII

test('our archives round-trip through our reader: sizes on block edges, long and non-ASCII names, links, folders', async () => {
  const src = path.join(TMP, 'big.bin');
  const bigData = crypto.randomBytes(1024 * 1024 + 7);
  fs.writeFileSync(src, bigData);
  const entries = [
    { path: 'manifest.json', type: 'file', data: Buffer.from('{"v":1}'), mode: 0o600, mtime: Date.parse('2026-10-29T12:00:00Z') },
    { path: 'data', type: 'dir', mode: 0o700 },
    { path: 'data/empty', type: 'file', data: Buffer.alloc(0) },
    { path: 'data/block', type: 'file', data: crypto.randomBytes(512) },
    { path: 'data/big.bin', type: 'file', source: src, size: bigData.length, mode: 0o644 },
    { path: longName, type: 'file', data: Buffer.from('long name') },
    { path: 'workspaces/doc/records/patient-a.md', type: 'link', linkname: '../../../home/medical/patients/patient-a.md' },
    { path: 'workspaces/x/' + 'l'.repeat(120), type: 'link', linkname: 'y'.repeat(150) },
  ];
  const tar = await collect(tarStream(entries));
  assert.strictEqual(tar.length % 512, 0);
  const got = await readAll(tar);
  assert.deepStrictEqual(got.map(e => e.path), entries.map(e => e.path));
  assert.ok(got[4].data.equals(bigData));
  assert.strictEqual(got[5].data.toString(), 'long name');
  assert.strictEqual(got[6].linkname, '../../../home/medical/patients/patient-a.md');
  assert.strictEqual(got[7].linkname, 'y'.repeat(150));
  assert.strictEqual(got[1].type, 'dir');
  assert.strictEqual(got[4].mode, 0o644);
});

test('the system tar lists and unpacks our archives the same way', async () => {
  const tar = await collect(tarStream([
    { path: 'a', type: 'dir' }, { path: 'a/one.txt', type: 'file', data: Buffer.from('one') },
    { path: longName, type: 'file', data: Buffer.from('two') }, { path: 'a/ln', type: 'link', linkname: 'one.txt' },
  ]));
  const file = path.join(TMP, 'sys.tar'); fs.writeFileSync(file, tar);
  const list = spawnSync('tar', ['-tf', file], { encoding: 'utf8' });
  assert.strictEqual(list.status, 0, list.stderr);
  // GNU tar prints bytes outside ASCII as \ooo escapes when the locale isn't UTF-8 (as under env -i): decode them
  const unescape = (line) => { const bytes = []; for (let i = 0; i < line.length; i++) { const m = /^\\([0-7]{3})/.exec(line.slice(i)); if (m) { bytes.push(parseInt(m[1], 8)); i += 3; } else bytes.push(...Buffer.from(line[i], 'utf8')); } return Buffer.from(bytes).toString('utf8'); };
  assert.deepStrictEqual(list.stdout.trim().split('\n').map(unescape), ['a/', 'a/one.txt', longName, 'a/ln']);
  const out = path.join(TMP, 'sys-out'); fs.mkdirSync(out);
  assert.strictEqual(spawnSync('tar', ['-xf', file, '-C', out]).status, 0);
  assert.strictEqual(fs.readFileSync(path.join(out, longName), 'utf8'), 'two');
  assert.strictEqual(fs.readlinkSync(path.join(out, 'a/ln')), 'one.txt');
});

test('a writer refuses a file that changed size while being archived', async () => {
  const src = path.join(TMP, 'grow.txt'); fs.writeFileSync(src, 'abc');
  await assert.rejects(collect(tarStream([{ path: 'g', type: 'file', source: src, size: 2 }])), /grew|changed size/);
  await assert.rejects(collect(tarStream([{ path: 'g', type: 'file', source: src, size: 9 }])), /changed size/);
});

// Hand-made hostile archives
function rawEntry(name, type, data = Buffer.alloc(0), { linkname = '', sizeField } = {}) {
  const h = _test.header({ name, mode: 0o644, size: sizeField == null ? data.length : sizeField, mtime: 0, type, linkname });
  const padLen = (512 - (data.length % 512)) % 512;
  return Buffer.concat([h, data, Buffer.alloc(padLen)]);
}
const end = Buffer.alloc(1024);
const paxEntry = (records) => rawEntry('PaxHeader', 'x', Buffer.from(records.map(([k, v]) => _test.paxRecord(k, v)).join('')));

test('hostile archives are refused: escaping paths, devices, hard links, global records, bad checksums, cut-offs', async () => {
  const cases = {
    absolute: Buffer.concat([rawEntry('/etc/passwd', '0', Buffer.from('x')), end]),
    dotdot: Buffer.concat([rawEntry('data/../../evil', '0', Buffer.from('x')), end]),
    dot: Buffer.concat([rawEntry('data/./x', '0', Buffer.from('x')), end]),
    doubleSlash: Buffer.concat([rawEntry('data//x', '0', Buffer.from('x')), end]),
    paxEscape: Buffer.concat([paxEntry([['path', '../outside']]), rawEntry('ok', '0', Buffer.from('x')), end]),
    hardlink: Buffer.concat([rawEntry('h', '1', Buffer.alloc(0), { linkname: 'etc/passwd' }), end]),
    charDevice: Buffer.concat([rawEntry('d', '3'), end]),
    fifo: Buffer.concat([rawEntry('f', '6'), end]),
    globalPax: Buffer.concat([rawEntry('g', 'g', Buffer.from(_test.paxRecord('path', 'x'))), end]),
    gnuLongName: Buffer.concat([rawEntry('././@LongLink', 'L', Buffer.from('x'.repeat(200))), end]),
    emptyLink: Buffer.concat([rawEntry('l', '2', Buffer.alloc(0), { linkname: '' }), end]),
  };
  for (const [name, buf] of Object.entries(cases)) await assert.rejects(readAll(buf), /isn't allowed|malformed/, name);
  const bad = Buffer.concat([rawEntry('ok', '0', Buffer.from('x')), end]); bad[0] ^= 1;
  await assert.rejects(readAll(bad), /checksum/);
  const good = await collect(tarStream([{ path: 'a', type: 'file', data: crypto.randomBytes(2000) }]));
  await assert.rejects(readAll(good.subarray(0, 1000)), /cut off/);
  await assert.rejects(readAll(good.subarray(0, 512)), /cut off/);
});

test('limits apply before any bytes are read: entries, path length, one file, the total, and pax sizes', async () => {
  const many = await collect(tarStream(Array.from({ length: 6 }, (_, i) => ({ path: `f${i}`, type: 'file', data: Buffer.from('x') }))));
  await assert.rejects(readAll(many, { maxEntries: 5 }), /more entries/);
  await assert.rejects(readAll(await collect(tarStream([{ path: 'p'.repeat(300), type: 'file', data: Buffer.from('x') }])), { maxPathBytes: 200 }), /too long/);
  const two = await collect(tarStream([{ path: 'a', type: 'file', data: Buffer.alloc(3000) }, { path: 'b', type: 'file', data: Buffer.alloc(3000) }]));
  await assert.rejects(readAll(two, { maxFileBytes: 2000 }), /larger than allowed/);
  await assert.rejects(readAll(two, { maxTotalBytes: 5000 }), /larger than allowed/);
  // a pax record claiming a giant size is refused by the limit, not by trying to read it
  const giant = Buffer.concat([paxEntry([['size', String(2 ** 50)]]), rawEntry('huge', '0', Buffer.alloc(0)), end]);
  await assert.rejects(readAll(giant), /larger than allowed/);
  assert.deepStrictEqual(await readAll(Buffer.concat([rawEntry('fine', '0', Buffer.from('ok')), end])), [{ path: 'fine', type: 'file', mode: 0o644, size: 2, linkname: null, data: Buffer.from('ok') }]);
});

test('a reader that skips a file\'s content still lands on the next entry', async () => {
  const tar = await collect(tarStream([{ path: 'a', type: 'file', data: crypto.randomBytes(5000) }, { path: 'b', type: 'file', data: Buffer.from('second') }]));
  const seen = [];
  for await (const e of readTar([tar])) {
    if (e.path === 'b') { const c = []; for await (const x of e.content()) c.push(x); seen.push(Buffer.concat(c).toString()); }
    else seen.push('skipped ' + e.path);
  }
  assert.deepStrictEqual(seen, ['skipped a', 'second']);
});
