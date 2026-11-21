'use strict';
// The self-check's picture writer: a valid PNG (signature, chunk order, CRCs, sizes, scanlines) of the digits.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const zlib = require('zlib');
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('selfcheck-png-iso-');
const { pngDigits, crc32 } = require(path.join(ISO.lib, 'selfcheck', 'png.js'));

function chunks(buf) {
  const out = [];
  let i = 8;
  while (i < buf.length) {
    const len = buf.readUInt32BE(i), type = buf.toString('ascii', i + 4, i + 8);
    out.push({ type, data: buf.subarray(i + 8, i + 8 + len), crc: buf.readUInt32BE(i + 8 + len) });
    i += 12 + len;
  }
  assert.strictEqual(i, buf.length, 'no bytes left over after the last chunk');
  return out;
}

test('crc32 matches the known check value', () => {
  assert.strictEqual(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('png: signature, chunk order and every CRC', () => {
  const png = pngDigits('4821');
  assert.deepStrictEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const cs = chunks(png);
  assert.deepStrictEqual(cs.map(c => c.type), ['IHDR', 'IDAT', 'IEND']);
  for (const c of cs) assert.strictEqual(crc32(Buffer.concat([Buffer.from(c.type, 'ascii'), c.data])), c.crc, `${c.type} CRC`);
  assert.strictEqual(cs[2].data.length, 0);
});

test('png: IHDR size follows the scale, and the pixel data inflates to the right length with filter byte 0', () => {
  for (const scale of [4, 8]) {
    const png = pngDigits('1000', { scale });
    const [ihdr, idat] = chunks(png);
    const w = ihdr.data.readUInt32BE(0), h = ihdr.data.readUInt32BE(4);
    assert.strictEqual(w, (4 * 6 - 1) * scale + 4 * scale);
    assert.strictEqual(h, 7 * scale + 4 * scale);
    assert.strictEqual(ihdr.data[8], 8, 'bit depth');
    assert.ok([0, 2].includes(ihdr.data[9]), 'grayscale or RGB');
    const channels = ihdr.data[9] === 0 ? 1 : 3;
    const raw = zlib.inflateSync(idat.data);
    assert.strictEqual(raw.length, h * (1 + w * channels));
    for (let y = 0; y < h; y++) assert.strictEqual(raw[y * (1 + w * channels)], 0, `row ${y} filter byte`);
  }
});

test('png: black digits on a white page, and different digits make different pictures', () => {
  const [ihdr, idat] = chunks(pngDigits('7'));
  const w = ihdr.data.readUInt32BE(0), raw = zlib.inflateSync(idat.data);
  assert.strictEqual(raw[1], 255, 'the margin is white');
  const pixels = [];
  for (let y = 0; y < ihdr.data.readUInt32BE(4); y++) pixels.push(...raw.subarray(y * (1 + w) + 1, (y + 1) * (1 + w)));
  assert.ok(pixels.includes(0), 'has black ink');
  assert.ok(pixels.every(p => p === 0 || p === 255));
  assert.notDeepStrictEqual(pngDigits('1234'), pngDigits('1235'));
  assert.deepStrictEqual(pngDigits('1234'), pngDigits('1234'), 'the same code draws the same bytes');
  assert.throws(() => pngDigits('abc'));
});
