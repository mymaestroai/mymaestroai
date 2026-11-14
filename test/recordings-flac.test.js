'use strict';
// Call-recording audio (lib/recordings/flac.js): the WAV reader, the FLAC encoder and decoder.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { wavToPcm16, encodeFlac, encodeFlacAsync, decodeFlac } = require('../lib/recordings/flac');

function wav({ rate = 16000, samples = new Int16Array(10), channels = 1, bits = 16, format = 1, extra = false, dataSize, bytes } = {}) {
  const data = bytes || Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const fmt = Buffer.alloc(24); fmt.write('fmt ', 0); fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(format, 8); fmt.writeUInt16LE(channels, 10); fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE(rate * channels * bits / 8, 16); fmt.writeUInt16LE(channels * bits / 8, 20); fmt.writeUInt16LE(bits, 22);
  const parts = [Buffer.from('RIFF\0\0\0\0WAVE', 'latin1'), fmt];
  if (extra) parts.push(Buffer.from('LIST\x03\0\0\0abc\0', 'latin1'));   // odd size plus a pad byte
  const dh = Buffer.alloc(8); dh.write('data', 0); dh.writeUInt32LE(dataSize === undefined ? data.length : dataSize, 4);
  parts.push(dh, data);
  const out = Buffer.concat(parts); out.writeUInt32LE(out.length - 8, 4);
  return out;
}
function sine(n, rate, amp = 12000, hz = 440) { const a = new Int16Array(n); for (let i = 0; i < n; i++) a[i] = Math.round(amp * Math.sin(2 * Math.PI * hz * i / rate)); return a; }
function noise(n, amp = 32767, seed = 1) {
  const a = new Int16Array(n); let s = seed;
  for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; a[i] = ((s >>> 8) % (2 * amp + 1)) - amp; }
  return a;
}
function roundTrip(samples, rate) {
  const flac = encodeFlac(samples, rate);
  const d = decodeFlac(flac);
  assert.strictEqual(d.sampleRate, rate);
  assert.deepStrictEqual(Array.from(d.samples), Array.from(samples));
  return flac;
}

test('round trips are byte exact: silence, sine, noise, tiny and block-edge lengths, extremes, rates', () => {
  roundTrip(new Int16Array(5000), 16000);
  roundTrip(sine(20000, 48000), 48000);
  roundTrip(noise(9000), 44100);
  roundTrip(new Int16Array([123]), 16000);
  roundTrip(sine(4096, 16000), 16000);
  roundTrip(sine(4097, 16000), 16000);
  roundTrip(noise(4095, 32767, 5), 8000);
  roundTrip(sine(300, 16000), 16000);
  roundTrip(new Int16Array(4096).fill(-5), 16000);
  const ext = new Int16Array(10000);
  for (let i = 0; i < ext.length; i++) ext[i] = (i >> 2) & 1 ? 32767 : -32768;
  roundTrip(ext, 48000);
  roundTrip(Int16Array.from({ length: 5000 }, (_, i) => (i % 2 ? 32767 : -32768)), 48000);
  roundTrip(noise(3000, 32767, 9), 44100);
});

test('zero samples: STREAMINFO only', () => {
  const f = encodeFlac(new Int16Array(0), 16000);
  assert.strictEqual(f.length, 42);
  const d = decodeFlac(f);
  assert.strictEqual(d.samples.length, 0);
  assert.strictEqual(d.sampleRate, 16000);
});

test('STREAMINFO fields', () => {
  const f = encodeFlac(sine(5000, 44100), 44100);
  assert.strictEqual(f.toString('latin1', 0, 4), 'fLaC');
  assert.strictEqual(f[4], 0x80);
  assert.strictEqual(f.readUInt16BE(8), 4096);
  assert.strictEqual(f.readUInt16BE(10), 4096);
});

test('async encoder gives the same bytes and yields to the event loop', async () => {
  const s = sine(4096 * 130, 48000);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 0);
  const a = await encodeFlacAsync(s, 48000);
  clearInterval(timer);
  assert.ok(a.equals(encodeFlac(s, 48000)));
  assert.ok(ticks >= 1);
});

test('a 48 kHz sine plus noise compresses well below WAV size', () => {
  const n = 48000 * 3;
  const s = sine(n, 48000, 8000);
  const nz = noise(n, 40, 3);
  for (let i = 0; i < n; i++) s[i] += nz[i];
  const flac = roundTrip(s, 48000);
  assert.ok(flac.length < n * 2 * 0.6, `flac ${flac.length} vs wav ${n * 2}`);
});

test('wavToPcm16 reads mono 16-bit PCM, skips unknown chunks and padding', () => {
  const s = Int16Array.from([1, -2, 3, 32767, -32768]);
  const r = wavToPcm16(wav({ rate: 48000, samples: s, extra: true }));
  assert.strictEqual(r.sampleRate, 48000);
  assert.deepStrictEqual(Array.from(r.samples), Array.from(s));
});

test('wavToPcm16: a streamed header (size 0xFFFFFFFF) or a size past the end means "to the end of the buffer", in whole samples', () => {
  const s = Int16Array.from([5, -6, 7, 8, -9]);
  for (const dataSize of [0xffffffff, 1000000, 0x7fffffff]) {
    const r = wavToPcm16(wav({ samples: s, dataSize }));
    assert.deepStrictEqual(Array.from(r.samples), Array.from(s), `size ${dataSize}`);
  }
  // a last half sample is dropped: the length is rounded down to whole samples
  const odd = wav({ bytes: Buffer.concat([Buffer.from(s.buffer, s.byteOffset, s.byteLength), Buffer.from([0x7f])]), dataSize: 0xffffffff });
  assert.deepStrictEqual(Array.from(wavToPcm16(odd).samples), Array.from(s));
  // a size that is right still reads exactly that many samples (a chunk after the data is not audio)
  const exact = Buffer.concat([wav({ samples: s }), Buffer.from('LIST\x04\0\0\0abcd', 'latin1')]);
  assert.deepStrictEqual(Array.from(wavToPcm16(exact).samples), Array.from(s));
});

test('wavToPcm16 refuses everything else', () => {
  const refused = (b) => assert.throws(() => wavToPcm16(b), (e) => e.badAudio === true && /\S/.test(e.message));
  refused(wav({ channels: 2 }));
  refused(wav({ bits: 8, bytes: Buffer.alloc(10) }));
  refused(wav({ bits: 24, bytes: Buffer.alloc(12) }));
  refused(wav({ bits: 32, bytes: Buffer.alloc(12) }));
  refused(wav({ format: 3, bits: 32, bytes: Buffer.alloc(12) }));
  refused(wav({ rate: 7999 }));
  refused(wav({ rate: 192001 }));
  refused(wav({ dataSize: 1001, bytes: Buffer.alloc(2002) }));   // an odd size that fits is still wrong
  refused(wav({ samples: new Int16Array(0) }));        // no samples
  refused(wav({ dataSize: 0xffffffff, samples: new Int16Array(0) }));   // a streamed header with nothing after it
  refused(wav({ dataSize: 1000, bytes: Buffer.alloc(1) }));            // past the end, but not even one whole sample
  refused(Buffer.from('RIFF\0\0\0\0WAVE', 'latin1'));  // no chunks
  const nodata = wav(); refused(nodata.subarray(0, 36));
  refused(Buffer.from('not a wav file at all'));
  refused(Buffer.alloc(0));
});

test('decodeFlac rejects a flipped byte in a frame, a bad MD5 and a truncated file', () => {
  const flac = encodeFlac(sine(9000, 16000), 16000);
  for (const at of [60, 500, flac.length - 5]) {
    const b = Buffer.from(flac); b[at] ^= 0x10;
    assert.throws(() => decodeFlac(b), /flac/);
  }
  const b = Buffer.from(flac); b[30] ^= 1;
  assert.throws(() => decodeFlac(b), /flac/);
  assert.throws(() => decodeFlac(flac.subarray(0, flac.length - 10)), /flac/);
  assert.throws(() => decodeFlac(Buffer.from('nope')), /flac/);
});

test('ffmpeg decodes our FLAC to the same samples', (t) => {
  if (!fs.existsSync('/usr/bin/ffmpeg')) return t.skip('no ffmpeg');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-flac-'));
  for (const [name, s, rate] of [['a', sine(10000, 48000), 48000], ['b', noise(4097, 20000, 4), 44100], ['c', new Int16Array([7]), 16000], ['d', new Int16Array(5000), 16000]]) {
    const file = path.join(dir, name + '.flac');
    fs.writeFileSync(file, encodeFlac(s, rate));
    const r = spawnSync('/usr/bin/ffmpeg', ['-v', 'error', '-i', file, '-f', 's16le', '-'], { maxBuffer: 1 << 26 });
    assert.strictEqual(r.status, 0, String(r.stderr));
    assert.ok(r.stdout.equals(Buffer.from(s.buffer, s.byteOffset, s.byteLength)), 'ffmpeg output differs for ' + name);
  }
});
