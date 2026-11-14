'use strict';
// lib/faces/tar.js: a deterministic tar.gz writer and a strict reader (hostile archives are refused).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const tar = require('../lib/faces/tar');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'face-tar-'));
const sample = () => [
  { name: 'web/b.mp4', data: Buffer.from('bbbb') },
  { name: 'manifest.json', data: Buffer.from('{"a":1}') },
  { name: 'web/a.mp4', data: Buffer.alloc(1000, 7) },
  { name: 'beak/closed.png', data: Buffer.alloc(0) },
];

/** A hand-made raw tar block for hostile cases. */
function rawHeader(name, { size = 0, type = '0', prefix = '', badSum = false, magic = 'ustar\0' } = {}) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 'latin1');
  h.write('0000644\0', 100, 'latin1'); h.write('0000000\0', 108, 'latin1'); h.write('0000000\0', 116, 'latin1');
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'latin1');
  h.write('00000000000\0', 136, 'latin1');
  h.fill(0x20, 148, 156);
  h.write(type, 156, 'latin1');
  h.write(magic, 257, 'latin1'); h.write('00', 263, 'latin1');
  if (prefix) h.write(prefix, 345, 'latin1');
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  if (badSum) h.write('0000001\0', 148, 'latin1');
  return h;
}
const body = (data) => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
const END = Buffer.alloc(1024);
const entry = (name, data = Buffer.from('x'), opt = {}) => [rawHeader(name, { size: data.length, ...opt }), body(data)];
function archive(parts) { const f = path.join(tmp(), 'a.tar.gz'); fs.writeFileSync(f, zlib.gzipSync(Buffer.concat(parts.flat()))); return f; }
async function refused(file, re, limits) {
  const dest = tmp();
  await assert.rejects(() => tar.extractTarGz(file, dest, limits), re);
  return dest;
}

test('writeTarGz is deterministic: same entries (any order) give identical bytes, with gzip MTIME 0', () => {
  const a = tar.writeTarGz(sample());
  const b = tar.writeTarGz(sample().reverse());
  assert.ok(a.equals(b));
  assert.deepStrictEqual([...a.subarray(4, 8)], [0, 0, 0, 0]);
  assert.strictEqual(crypto.createHash('sha256').update(a).digest('hex'), crypto.createHash('sha256').update(tar.writeTarGz(sample())).digest('hex'));
});

test('writeTarGz makes folder entries first, sorted, with fixed modes and no owner or time', () => {
  const raw = zlib.gunzipSync(tar.writeTarGz(sample()));
  const names = [];
  for (let off = 0; off + 512 <= raw.length && raw[off] !== 0; ) {
    const h = raw.subarray(off, off + 512);
    const name = h.toString('latin1', 0, h.indexOf(0));
    const type = String.fromCharCode(h[156]);
    names.push(name);
    assert.strictEqual(h.toString('latin1', 100, 107), type === '5' ? '0000755' : '0000644');
    assert.strictEqual(h.toString('latin1', 108, 115), '0000000');
    assert.strictEqual(h.toString('latin1', 136, 147), '00000000000');
    assert.strictEqual(h.toString('latin1', 265, 297).replace(/\0/g, ''), '');
    const size = parseInt(h.toString('latin1', 124, 135), 8);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  assert.deepStrictEqual(names, ['beak/', 'beak/closed.png', 'manifest.json', 'web/', 'web/a.mp4', 'web/b.mp4']);
});

test('round trip: extract gives the same files, with private modes', async () => {
  const file = path.join(tmp(), 'p.tar.gz'); fs.writeFileSync(file, tar.writeTarGz(sample()));
  const dest = tmp();
  const r = await tar.extractTarGz(file, dest);
  assert.deepStrictEqual(r, { files: 4, bytes: 4 + 7 + 1000 });
  assert.ok(fs.readFileSync(path.join(dest, 'web', 'a.mp4')).equals(Buffer.alloc(1000, 7)));
  assert.strictEqual(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'), '{"a":1}');
  assert.strictEqual(fs.statSync(path.join(dest, 'web')).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(path.join(dest, 'web', 'a.mp4')).mode & 0o777, 0o600);
});

test('extract refuses unsafe names and writes nothing outside the folder', async () => {
  const root = tmp(); const dest = path.join(root, 'dest'); fs.mkdirSync(dest, { mode: 0o700 });
  for (const name of ['../x', '/abs', 'a/../b', '.hidden', 'a/.b', 'a//b', './a', 'a\\b', 'a b', 'a/b/c/d/e', 'x'.repeat(100), 'a/./b']) {
    const f = archive([entry(name), [END]]);
    await assert.rejects(() => tar.extractTarGz(f, dest), /refused|too long|name/i, name);
  }
  assert.deepStrictEqual(fs.readdirSync(root), ['dest']);
  assert.deepStrictEqual(fs.readdirSync(dest), []);
});

test('extract refuses a prefix field that makes an unsafe name, and accepts an empty one', async () => {
  await refused(archive([entry('x', Buffer.from('1'), { prefix: '../up' }), [END]]), /refused/);
  await refused(archive([entry('x', Buffer.from('1'), { prefix: '/abs' }), [END]]), /refused/);
  const ok = archive([entry('x', Buffer.from('1')), [END]]);
  assert.strictEqual((await tar.extractTarGz(ok, tmp())).files, 1);
});

test('extract refuses symlinks, hardlinks, devices, fifos, pax and GNU long-name headers', async () => {
  for (const type of ['2', '1', '3', '4', '6', 'x', 'g', 'L', 'K', 'S', '7']) {
    await refused(archive([entry('a', Buffer.alloc(0), { type }), [END]]), /not a plain file or folder/, undefined);
  }
});

test('extract refuses duplicate names, a bad checksum, a non-ustar header, and a file used as a folder', async () => {
  await refused(archive([entry('a'), entry('a'), [END]]), /twice/);
  await refused(archive([entry('a', Buffer.from('x'), { badSum: true }), [END]]), /checksum/);
  await refused(archive([entry('a', Buffer.from('x'), { magic: 'nope\0' }), [END]]), /plain tar/);
  await refused(archive([entry('a'), entry('a/b'), [END]]), /file used as a folder/);
});

test('extract refuses a file over the cap while streaming, and a total over the cap', async () => {
  const big = Buffer.alloc(3000, 1);
  await refused(archive([entry('a', big), [END]]), /limit for one file/, { maxFileBytes: 2000 });
  await refused(archive([entry('a', Buffer.alloc(1500)), entry('b', Buffer.alloc(1500)), [END]]), /total limit/, { maxTotalBytes: 2000 });
  const many = []; for (let i = 0; i < 5; i++) many.push(entry(`f${i}`));
  await refused(archive([...many, [END]]), /more than 3 entries/, { maxEntries: 3 });
});

test('extract refuses a truncated archive, a missing end, damaged gzip and data after the end', async () => {
  const full = Buffer.concat([...entry('a', Buffer.alloc(2000, 5)), END]);
  const cut = path.join(tmp(), 'cut.tar.gz'); fs.writeFileSync(cut, zlib.gzipSync(full.subarray(0, 1500)));
  await refused(cut, /incomplete/);
  await refused(archive([entry('a'), []]), /incomplete/);               // no end blocks
  await refused(archive([entry('a'), [Buffer.alloc(512)]]), /incomplete/);   // one zero block only
  const half = path.join(tmp(), 'half.tar.gz'); const gz = zlib.gzipSync(full); fs.writeFileSync(half, gz.subarray(0, gz.length - 12));
  await refused(half, /gzip|damaged/);
  const junk = path.join(tmp(), 'junk.tar.gz'); fs.writeFileSync(junk, Buffer.from('this is not gzip at all'));
  await refused(junk, /gzip|damaged/);
  await refused(archive([entry('a'), [END], [Buffer.from('trailing junk')]]), /after its end/);
});

test('extract accepts zero padding after the end blocks (tar record padding)', async () => {
  const f = archive([entry('a'), [END], [Buffer.alloc(8192)]]);
  assert.strictEqual((await tar.extractTarGz(f, tmp())).files, 1);
});
