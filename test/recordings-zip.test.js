'use strict';
// The ZIP writer for recording exports (lib/recordings/zip.js), checked by reading archives back with Python.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { PassThrough, Writable } = require('stream');
const { spawnSync } = require('child_process');
const { writeZip } = require('../lib/recordings/zip');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-zip-'));

async function zipToBuffer(entries, opts) {
  const pt = new PassThrough();
  const chunks = [];
  pt.on('data', (c) => chunks.push(c));
  await writeZip(entries, pt, opts);
  pt.end();
  return Buffer.concat(chunks);
}

const PY = 'import sys,zipfile,json\nz=zipfile.ZipFile(sys.argv[1])\nprint(json.dumps({"bad":z.testzip(),"items":[[i.filename,z.read(i).hex(),i.compress_type] for i in z.infolist()]}))';
function readWithPython(buf, name) {
  const file = path.join(DIR, name);
  fs.writeFileSync(file, buf);
  const r = spawnSync('/usr/bin/python3', ['-I', '-c', PY, file], { encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const ENTRIES = () => [
  { name: 'sess/manifest.json', data: Buffer.from('{"a":1}\n'), mtime: new Date(2026, 10, 13, 21, 47, 0) },
  { name: 'sess/0001-person.flac', data: crypto.randomBytes(70000) },
  { name: 'sess/ünï-çödé.txt', data: Buffer.from('héllo') },
  { name: 'sess/empty.txt', data: Buffer.alloc(0) },
];

function check(res, entries) {
  assert.strictEqual(res.bad, null);
  assert.deepStrictEqual(res.items.map((i) => i[0]), entries.map((e) => e.name));
  entries.forEach((e, i) => { assert.strictEqual(res.items[i][1], e.data.toString('hex')); assert.strictEqual(res.items[i][2], 0); });
}

test('crc32: the table-based CRC-32 gives the same value as zlib.crc32 and as the check value, and a zip is valid without zlib.crc32', async () => {
  const zlib = require('zlib');
  const { crc32, crc32Table } = require('../lib/recordings/zip');
  assert.strictEqual(crc32Table(Buffer.from('123456789')), 0xcbf43926, 'the standard check value');
  assert.strictEqual(crc32Table(Buffer.alloc(0)), 0);
  for (const buf of [Buffer.from('hello'), crypto.randomBytes(70001), Buffer.alloc(1000, 0xff), Buffer.from('ünï-çödé')]) {
    if (typeof zlib.crc32 === 'function') assert.strictEqual(crc32Table(buf), zlib.crc32(buf) >>> 0);
    assert.strictEqual(crc32(buf), crc32Table(buf));
  }
  // a Node without zlib.crc32: the zip still carries correct checksums (Python's testzip checks every one)
  const saved = zlib.crc32;
  zlib.crc32 = undefined;
  try {
    assert.strictEqual(crc32(Buffer.from('123456789')), 0xcbf43926);
    const entries = ENTRIES();
    check(readWithPython(await zipToBuffer(entries), 'nocrc32.zip'), entries);
  } finally { zlib.crc32 = saved; }
});

test('a zip of stored entries reads back with Python zipfile', async () => {
  const entries = ENTRIES();
  check(readWithPython(await zipToBuffer(entries), 'plain.zip'), entries);
});

test('an async iterable of entries works too', async () => {
  const entries = ENTRIES();
  const buf = await zipToBuffer((async function* () { for (const e of entries) yield e; })());
  check(readWithPython(buf, 'iter.zip'), entries);
});

test('forced ZIP64 (threshold 10) reads back with Python zipfile', async () => {
  const entries = ENTRIES();
  const buf = await zipToBuffer(entries, { zip64Threshold: 10 });
  assert.ok(buf.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])), 'has a ZIP64 end record');
  check(readWithPython(buf, 'zip64.zip'), entries);
});

test('an empty zip is valid', async () => {
  const res = readWithPython(await zipToBuffer([]), 'empty.zip');
  assert.deepStrictEqual(res.items, []);
});

test('bad names are refused', async () => {
  for (const name of ['../x', 'a/../b', '/abs', 'a\\b', '', 'a//b', 'a/', 'C:/x', 'a/..']) {
    await assert.rejects(() => zipToBuffer([{ name, data: Buffer.from('x') }]), (e) => e.code === 'bad_input', name);
  }
  await assert.rejects(() => zipToBuffer([{ name: 'a', data: Buffer.from('x') }, { name: 'a', data: Buffer.from('y') }]));
  await assert.rejects(() => zipToBuffer([{ name: 'a', data: 'not a buffer' }]));
});

test('backpressure: it waits for drain', async () => {
  let pending = 0, maxPending = 0;
  const slow = new Writable({
    highWaterMark: 1024,
    write(chunk, enc, cb) { pending++; maxPending = Math.max(maxPending, pending); setImmediate(() => { pending--; cb(); }); },
  });
  const entries = Array.from({ length: 20 }, (_, i) => ({ name: 'f' + i, data: Buffer.alloc(5000, i) }));
  await writeZip(entries, slow);
  slow.end();
  assert.ok(maxPending <= 2, 'writes were not queued without bound: ' + maxPending);
});
