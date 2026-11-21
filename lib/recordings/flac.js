'use strict';
// Lossless audio for call recordings: a WAV reader (16-bit mono PCM only) and a FLAC encoder/decoder (RFC 9639)
// that handles exactly what the encoder writes: one STREAMINFO block, fixed 4096-sample blocks, one subframe per
// frame (CONSTANT, VERBATIM or FIXED order 0-4) with Rice-coded residuals. The store decodes every file it writes.
const crypto = require('crypto');

const BLOCK = 4096;
const MAX_PART_ORDER = 8;
const MAX_RICE = 14;

function badAudio(msg) { const e = new Error(msg); e.badAudio = true; return e; }

// ---- WAV ----
function wavToPcm16(buf) {
  if (!Buffer.isBuffer(buf)) throw badAudio('not a WAV file');
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw badAudio('not a WAV file');
  let pos = 12;
  let fmt = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + size > buf.length) throw badAudio('bad fmt chunk');
      fmt = {
        format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
      if (fmt.format !== 1) throw badAudio('only PCM WAV is accepted');
      if (fmt.channels !== 1) throw badAudio('only mono WAV is accepted');
      if (fmt.bits !== 16) throw badAudio('only 16-bit WAV is accepted');
      if (!Number.isInteger(fmt.sampleRate) || fmt.sampleRate < 8000 || fmt.sampleRate > 192000) throw badAudio('sample rate out of range');
    } else if (id === 'data') {
      if (!fmt) throw badAudio('data before fmt');
      // A streamed header (size 0xFFFFFFFF) or a size past the end means "to the end of the buffer", in whole samples.
      let len = size;
      if (size === 0xffffffff || body + size > buf.length) len = (buf.length - body) - ((buf.length - body) % 2);
      else if (size % 2) throw badAudio('bad audio data length');
      const n = len / 2;
      if (n < 1) throw badAudio('no samples');
      const samples = new Int16Array(n);
      for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(body + i * 2);
      return { sampleRate: fmt.sampleRate, samples };
    }
    pos = body + size + (size & 1);
  }
  throw badAudio(fmt ? 'no data chunk' : 'no fmt chunk');
}

// ---- CRCs ----
const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  CRC8[i] = c;
  let d = i << 8;
  for (let k = 0; k < 8; k++) d = (d & 0x8000) ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff;
  CRC16[i] = d;
}
function crc8(b, from, to) { let c = 0; for (let i = from; i < to; i++) c = CRC8[c ^ b[i]]; return c; }
function crc16(b, from, to) { let c = 0; for (let i = from; i < to; i++) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ b[i]]; return c; }

// ---- bit writer ----
class BitWriter {
  constructor(cap) { this.buf = Buffer.alloc(cap || 1024); this.len = 0; this.acc = 0; this.nb = 0; }
  _ensure(n) { if (this.len + n > this.buf.length) { const nb = Buffer.alloc(Math.max(this.buf.length * 2, this.len + n)); this.buf.copy(nb, 0, 0, this.len); this.buf = nb; } }
  // v: unsigned value below 2^n, n <= 24
  write(v, n) {
    if (n === 0) return;
    this._ensure(4);
    this.acc = (this.acc << n) | v;
    this.nb += n;
    while (this.nb >= 8) { this.nb -= 8; this.buf[this.len++] = (this.acc >>> this.nb) & 0xff; }
    this.acc &= (1 << this.nb) - 1;
  }
  writeSigned16(v) { this.write(v & 0xffff, 16); }
  unary(q) { while (q >= 16) { this.write(0, 16); q -= 16; } this.write(1, q + 1); }
  align() { if (this.nb) this.write(0, 8 - this.nb); }
  bytes() { return this.buf.subarray(0, this.len); }
}

function utf8Number(n) {
  if (n < 0x80) return [n];
  const cont = [];
  let v = n;
  const extra = n < 0x800 ? 1 : n < 0x10000 ? 2 : n < 0x200000 ? 3 : n < 0x4000000 ? 4 : 5;
  for (let i = 0; i < extra; i++) { cont.unshift(0x80 | (v & 0x3f)); v = Math.floor(v / 64); }
  const lead = (0xff << (7 - extra)) & 0xff;
  return [lead | v, ...cont];
}

// ---- encoder ----
function zig(r) { return r >= 0 ? r * 2 : -r * 2 - 1; }

// Best Rice partitioning for the residual of a FIXED subframe. Returns { bits, order, params } for the residual
// section (coding method 2 bits + partition order 4 bits + per-partition 4-bit parameter + coded residuals).
function bestRice(u, n, predOrder) {
  let maxO = 0;
  while (maxO < MAX_PART_ORDER && n % (1 << (maxO + 1)) === 0 && (n >> (maxO + 1)) > predOrder) maxO++;
  const parts = 1 << maxO;
  const psize = n >> maxO;
  // sums[p][k] = sum of (u >> k) over the partition, at the finest order
  let sums = new Array(parts);
  let counts = new Array(parts);
  for (let p = 0; p < parts; p++) {
    const from = p === 0 ? 0 : p * psize - predOrder;
    const to = (p + 1) * psize - predOrder;
    counts[p] = to - from;
    const s = new Float64Array(MAX_RICE + 1);
    for (let i = from; i < to; i++) { const x = u[i]; for (let k = 0; k <= MAX_RICE; k++) s[k] += x >>> k; }
    sums[p] = s;
  }
  function pick(s, cnt) {
    let bk = 0, bb = Infinity;
    for (let k = 0; k <= MAX_RICE; k++) { const b = s[k] + cnt * (k + 1); if (b < bb) { bb = b; bk = k; } }
    return { k: bk, bits: bb + 4 };
  }
  let best = null;
  let level = maxO;
  for (;;) {
    const params = [];
    let bits = 6;
    for (let p = 0; p < sums.length; p++) { const c = pick(sums[p], counts[p]); params.push(c.k); bits += c.bits; }
    if (!best || bits < best.bits) best = { bits, order: level, params };
    if (level === 0) break;
    const ns = new Array(sums.length >> 1), nc = new Array(sums.length >> 1);
    for (let p = 0; p < ns.length; p++) {
      const a = sums[2 * p], b = sums[2 * p + 1], s = new Float64Array(MAX_RICE + 1);
      for (let k = 0; k <= MAX_RICE; k++) s[k] = a[k] + b[k];
      ns[p] = s; nc[p] = counts[2 * p] + counts[2 * p + 1];
    }
    sums = ns; counts = nc; level--;
  }
  return best;
}

function residuals(x, start, n, order) {
  const r = new Int32Array(n - order);
  for (let i = order; i < n; i++) {
    const j = start + i;
    let p = 0;
    if (order === 1) p = x[j - 1];
    else if (order === 2) p = 2 * x[j - 1] - x[j - 2];
    else if (order === 3) p = 3 * x[j - 1] - 3 * x[j - 2] + x[j - 3];
    else if (order === 4) p = 4 * x[j - 1] - 6 * x[j - 2] + 4 * x[j - 3] - x[j - 4];
    r[i - order] = x[j] - p;
  }
  return r;
}

function encodeFrame(x, start, n, frameNo) {
  // header
  const hdr = [0xff, 0xf8];
  let bsCode;
  if (n === BLOCK) bsCode = 0b1100; else if (n <= 256) bsCode = 0b0110; else bsCode = 0b0111;
  hdr.push((bsCode << 4) | 0b0000);
  hdr.push((0b0000 << 4) | (0b100 << 1) | 0);
  hdr.push(...utf8Number(frameNo));
  if (bsCode === 0b0110) hdr.push(n - 1);
  else if (bsCode === 0b0111) hdr.push((n - 1) >> 8, (n - 1) & 0xff);
  hdr.push(crc8(hdr, 0, hdr.length));

  // choose the subframe
  let allSame = true;
  for (let i = 1; i < n; i++) if (x[start + i] !== x[start]) { allSame = false; break; }
  const w = new BitWriter(n * 2 + 64);
  for (const b of hdr) w.write(b, 8);
  if (allSame) {
    w.write(0, 8);
    w.writeSigned16(x[start]);
  } else {
    let best = { bits: 8 + 16 * n, order: -1 };
    for (let order = 0; order <= 4; order++) {
      if (order >= n) break;
      const res = residuals(x, start, n, order);
      const u = new Uint32Array(res.length);
      for (let i = 0; i < res.length; i++) u[i] = zig(res[i]);
      const rc = bestRice(u, n, order);
      const bits = 8 + 16 * order + 2 + rc.bits;
      if (bits < best.bits) best = { bits, order, rc, u };
    }
    if (best.order < 0) {
      w.write(0b000001 << 1, 8);
      for (let i = 0; i < n; i++) w.writeSigned16(x[start + i]);
    } else {
      w.write((0b001000 | best.order) << 1, 8);
      for (let i = 0; i < best.order; i++) w.writeSigned16(x[start + i]);
      w.write(0, 2);                    // 4-bit Rice parameters
      w.write(best.rc.order, 4);
      const parts = 1 << best.rc.order;
      const psize = n >> best.rc.order;
      for (let p = 0; p < parts; p++) {
        const k = best.rc.params[p];
        w.write(k, 4);
        const from = p === 0 ? 0 : p * psize - best.order;
        const to = (p + 1) * psize - best.order;
        for (let i = from; i < to; i++) {
          const v = best.u[i];
          w.unary(v >>> k);
          if (k) w.write(v & ((1 << k) - 1), k);
        }
      }
    }
  }
  w.align();
  const body = w.bytes();
  const c = crc16(body, 0, body.length);
  const out = Buffer.alloc(body.length + 2);
  body.copy(out);
  out.writeUInt16BE(c, body.length);
  return out;
}

function md5Of(samples) {
  const b = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(samples[i], i * 2);
  return crypto.createHash('md5').update(b).digest();
}

function streamInfo(sampleRate, total, minFrame, maxFrame, md5) {
  const b = Buffer.alloc(4 + 34);
  b[0] = 0x80; b[1] = 0; b[2] = 0; b[3] = 34;
  b.writeUInt16BE(BLOCK, 4); b.writeUInt16BE(BLOCK, 6);
  b.writeUIntBE(minFrame, 8, 3); b.writeUIntBE(maxFrame, 11, 3);
  const packed = (BigInt(sampleRate) << 44n) | (0n << 41n) | (15n << 36n) | BigInt(total);
  b.writeBigUInt64BE(packed, 14);
  md5.copy(b, 22);
  return b;
}

function checkInput(samples, sampleRate) {
  if (!(samples instanceof Int16Array)) throw new Error('samples must be an Int16Array');
  if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 655350) throw new Error('bad sample rate');
}

function assemble(samples, sampleRate, frames) {
  let min = 0, max = 0;
  if (frames.length) { min = Infinity; for (const f of frames) { if (f.length < min) min = f.length; if (f.length > max) max = f.length; } }
  return Buffer.concat([Buffer.from('fLaC', 'latin1'), streamInfo(sampleRate, samples.length, min, max, md5Of(samples)), ...frames]);
}

function encodeFlac(samples, sampleRate) {
  checkInput(samples, sampleRate);
  const frames = [];
  for (let s = 0, no = 0; s < samples.length; s += BLOCK, no++) frames.push(encodeFrame(samples, s, Math.min(BLOCK, samples.length - s), no));
  return assemble(samples, sampleRate, frames);
}

async function encodeFlacAsync(samples, sampleRate) {
  checkInput(samples, sampleRate);
  const frames = [];
  for (let s = 0, no = 0; s < samples.length; s += BLOCK, no++) {
    frames.push(encodeFrame(samples, s, Math.min(BLOCK, samples.length - s), no));
    if ((no + 1) % 64 === 0) await new Promise((r) => setImmediate(r));
  }
  return assemble(samples, sampleRate, frames);
}

// ---- decoder ----
function bad(msg) { return new Error('flac: ' + msg); }

class BitReader {
  constructor(buf, pos) { this.buf = buf; this.pos = pos * 8; this.end = buf.length * 8; }
  bits(n) { // n <= 32
    if (this.pos + n > this.end) throw bad('unexpected end of data');
    let v = 0;
    let left = n;
    while (left > 0) {
      const byte = this.buf[this.pos >> 3];
      const avail = 8 - (this.pos & 7);
      const take = Math.min(avail, left);
      v = v * (1 << take) + ((byte >> (avail - take)) & ((1 << take) - 1));
      this.pos += take; left -= take;
    }
    return v;
  }
  signed(n) { const v = this.bits(n); return v >= Math.pow(2, n - 1) ? v - Math.pow(2, n) : v; }
  unary() {
    let q = 0;
    for (;;) {
      if (this.pos >= this.end) throw bad('unexpected end of data');
      const byte = this.buf[this.pos >> 3] & (0xff >> (this.pos & 7));
      if (byte === 0) { const step = 8 - (this.pos & 7); q += step; this.pos += step; if (q > 1 << 24) throw bad('bad Rice code'); continue; }
      const lead = Math.clz32(byte) - 24;           // leading zeros in the byte
      q += lead - (this.pos & 7);
      this.pos += lead - (this.pos & 7) + 1;
      return q;
    }
  }
  align() { this.pos = (this.pos + 7) & ~7; }
}

function decodeFlac(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 42 || buf.toString('latin1', 0, 4) !== 'fLaC') throw bad('not a FLAC stream');
  let pos = 4;
  let info = null;
  for (;;) {
    if (pos + 4 > buf.length) throw bad('truncated metadata');
    const h = buf[pos];
    const last = (h & 0x80) !== 0;
    const type = h & 0x7f;
    const len = buf.readUIntBE(pos + 1, 3);
    pos += 4;
    if (pos + len > buf.length) throw bad('truncated metadata');
    if (type === 127) throw bad('bad metadata block type');
    if (type === 0) {
      if (info || len !== 34) throw bad('bad STREAMINFO');
      const packed = buf.readBigUInt64BE(pos + 10);
      info = {
        minBlock: buf.readUInt16BE(pos), maxBlock: buf.readUInt16BE(pos + 2),
        sampleRate: Number(packed >> 44n), channels: Number((packed >> 41n) & 7n) + 1, bps: Number((packed >> 36n) & 31n) + 1,
        total: Number(packed & 0xfffffffffn), md5: buf.subarray(pos + 18, pos + 34),
      };
    } else if (!info) throw bad('STREAMINFO must come first');
    pos += len;
    if (last) break;
  }
  if (!info) throw bad('no STREAMINFO');
  if (info.channels !== 1 || info.bps !== 16) throw bad('only 16-bit mono is supported');
  if (info.sampleRate < 1) throw bad('bad sample rate');
  const samples = new Int16Array(info.total);
  let done = 0;
  let frameNo = 0;
  while (pos < buf.length) {
    const start = pos;
    if (buf[pos] !== 0xff || buf[pos + 1] !== 0xf8) throw bad('bad frame sync');
    const bsCode = buf[pos + 2] >> 4;
    if ((buf[pos + 2] & 0x0f) !== 0) throw bad('unsupported sample-rate code');
    if (buf[pos + 3] !== 0b00001000) throw bad('unsupported channel or sample size');
    pos += 4;
    // frame number
    const first = buf[pos++];
    let num;
    if (first < 0x80) num = first;
    else {
      let extra = 0;
      while (extra < 6 && (first & (0x80 >> (extra + 1)))) extra++;
      if (extra < 1 || extra > 5) throw bad('bad frame number');
      num = first & (0x3f >> extra);
      for (let i = 0; i < extra; i++) {
        const c = buf[pos++];
        if (c === undefined || (c & 0xc0) !== 0x80) throw bad('bad frame number');
        num = num * 64 + (c & 0x3f);
      }
    }
    if (num !== frameNo) throw bad('frame number out of sequence');
    let n;
    if (bsCode === 0b1100) n = BLOCK;
    else if (bsCode === 0b0110) n = buf[pos++] + 1;
    else if (bsCode === 0b0111) { n = buf.readUInt16BE(pos) + 1; pos += 2; }
    else throw bad('unsupported block size');
    if (pos >= buf.length) throw bad('truncated frame');
    if (crc8(buf, start, pos) !== buf[pos]) throw bad('frame header CRC-8 mismatch');
    pos++;
    if (n > BLOCK || done + n > info.total) throw bad('frame exceeds total samples');
    const r = new BitReader(buf, pos);
    if (r.bits(1) !== 0) throw bad('bad subframe header');
    const type = r.bits(6);
    if (r.bits(1) !== 0) throw bad('wasted bits are not supported');
    const out = samples.subarray(done, done + n);
    if (type === 0) {
      out.fill(r.signed(16));
    } else if (type === 1) {
      for (let i = 0; i < n; i++) out[i] = r.signed(16);
    } else if (type >= 8 && type <= 12) {
      const order = type - 8;
      if (order >= n) throw bad('bad predictor order');
      const x = new Int32Array(n);
      for (let i = 0; i < order; i++) x[i] = r.signed(16);
      if (r.bits(2) !== 0) throw bad('unsupported residual coding method');
      const po = r.bits(4);
      if (po > MAX_PART_ORDER || n % (1 << po) !== 0 || (n >> po) <= order) throw bad('bad partition order');
      const psize = n >> po;
      for (let p = 0; p < (1 << po); p++) {
        const k = r.bits(4);
        if (k > MAX_RICE) throw bad('unsupported Rice parameter');
        const cnt = p === 0 ? psize - order : psize;
        const base = p === 0 ? order : p * psize;
        for (let i = 0; i < cnt; i++) {
          const q = r.unary();
          const low = k ? r.bits(k) : 0;
          const u = q * (1 << k) + low;
          const res = (u % 2) ? -(u + 1) / 2 : u / 2;
          const j = base + i;
          let pred = 0;
          if (order === 1) pred = x[j - 1];
          else if (order === 2) pred = 2 * x[j - 1] - x[j - 2];
          else if (order === 3) pred = 3 * x[j - 1] - 3 * x[j - 2] + x[j - 3];
          else if (order === 4) pred = 4 * x[j - 1] - 6 * x[j - 2] + 4 * x[j - 3] - x[j - 4];
          const v = res + pred;
          if (v < -32768 || v > 32767) throw bad('sample out of range');
          x[j] = v;
        }
      }
      for (let i = 0; i < n; i++) out[i] = x[i];
    } else throw bad('unsupported subframe type');
    r.align();
    const endByte = r.pos >> 3;
    if (endByte + 2 > buf.length) throw bad('truncated frame');
    if (crc16(buf, start, endByte) !== buf.readUInt16BE(endByte)) throw bad('frame CRC-16 mismatch');
    pos = endByte + 2;
    done += n;
    frameNo++;
  }
  if (done !== info.total) throw bad('sample count does not match STREAMINFO');
  if (!md5Of(samples).equals(info.md5)) throw bad('MD5 mismatch');
  return { sampleRate: info.sampleRate, samples };
}

module.exports = { wavToPcm16, encodeFlac, encodeFlacAsync, decodeFlac };
