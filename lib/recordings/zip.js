'use strict';
// A streaming ZIP writer (stored entries, no compression: FLAC does not shrink) with ZIP64 records when a size,
// an offset or the entry count needs them.
const zlib = require('zlib');

const U32 = 0xffffffff;
const U16 = 0xffff;

// CRC-32 (IEEE): zlib.crc32 when this Node has it, else a table-based one with the same result.
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); CRC_TABLE[i] = c >>> 0; }
function crc32Table(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function crc32(buf) { return typeof zlib.crc32 === 'function' ? zlib.crc32(buf) >>> 0 : crc32Table(buf); }

function badName(name) { const e = new Error('bad zip entry name: ' + JSON.stringify(String(name))); e.code = 'bad_input'; return e; }

function checkName(name) {
  if (typeof name !== 'string' || !name || name.startsWith('/') || name.includes('\\') || name.includes('\0') || /^[A-Za-z]:/.test(name)) throw badName(name);
  if (name.split('/').some((p) => p === '..' || p === '')) throw badName(name);
  if (Buffer.byteLength(name, 'utf8') > U16) throw badName(name);
}

function dosTime(d) {
  const y = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

async function write(out, buf) {
  if (!buf.length) return;
  if (!out.write(buf)) {
    await new Promise((resolve, reject) => {
      const onDrain = () => { cleanup(); resolve(); };
      const onErr = (e) => { cleanup(); reject(e); };
      const onClose = () => { cleanup(); reject(new Error('output closed')); };
      function cleanup() { out.off('drain', onDrain); out.off('error', onErr); out.off('close', onClose); }
      out.on('drain', onDrain); out.on('error', onErr); out.on('close', onClose);
    });
  }
}

function u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }

async function writeZip(entries, out, { zip64Threshold = U32 } = {}) {
  let offset = 0;
  const central = [];
  const seen = new Set();
  const put = async (buf) => { await write(out, buf); offset += buf.length; };

  for await (const e of entries) {
    checkName(e && e.name);
    if (seen.has(e.name)) throw badName(e.name);
    seen.add(e.name);
    if (!Buffer.isBuffer(e.data)) throw new Error('zip entry data must be a Buffer');
    const name = Buffer.from(e.name, 'utf8');
    const size = e.data.length;
    const crc = crc32(e.data) >>> 0;
    const { time, date } = dosTime(e.mtime instanceof Date ? e.mtime : new Date());
    const need64 = size >= zip64Threshold || offset >= zip64Threshold;
    const extra = need64 ? Buffer.concat([Buffer.from([0x01, 0x00, 16, 0]), u64(size), u64(size)]) : Buffer.alloc(0);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(need64 ? 45 : 20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(need64 ? U32 : size, 18); lh.writeUInt32LE(need64 ? U32 : size, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(extra.length, 28);
    const start = offset;
    await put(Buffer.concat([lh, name, extra]));
    await put(e.data);
    central.push({ name, crc, size, time, date, start, need64 });
  }

  const cdStart = offset;
  for (const c of central) {
    const offBig = c.start >= zip64Threshold;
    const parts = [];
    if (c.need64) parts.push(u64(c.size), u64(c.size));
    if (offBig) parts.push(u64(c.start));
    const extra = parts.length ? Buffer.concat([Buffer.from([0x01, 0x00]), Buffer.from([Buffer.concat(parts).length, 0]), ...parts]) : Buffer.alloc(0);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x031e, 4);                       // made by: Unix, spec 3.0
    ch.writeUInt16LE(c.need64 || offBig ? 45 : 20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(c.time, 12); ch.writeUInt16LE(c.date, 14);
    ch.writeUInt32LE(c.crc, 16);
    ch.writeUInt32LE(c.need64 ? U32 : c.size, 20); ch.writeUInt32LE(c.need64 ? U32 : c.size, 24);
    ch.writeUInt16LE(c.name.length, 28); ch.writeUInt16LE(extra.length, 30);
    ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0o100600 * 65536 >>> 0, 38);      // regular file, mode 0600
    ch.writeUInt32LE(offBig ? U32 : c.start, 42);
    await put(Buffer.concat([ch, c.name, extra]));
  }
  const cdSize = offset - cdStart;
  const count = central.length;
  const big = count >= U16 || cdStart >= zip64Threshold || cdSize >= zip64Threshold || central.some((c) => c.need64 || c.start >= zip64Threshold);
  if (big) {
    const z = Buffer.alloc(56);
    z.writeUInt32LE(0x06064b50, 0);
    z.writeBigUInt64LE(44n, 4);
    z.writeUInt16LE(0x031e, 12); z.writeUInt16LE(45, 14);
    z.writeUInt32LE(0, 16); z.writeUInt32LE(0, 20);
    z.writeBigUInt64LE(BigInt(count), 24); z.writeBigUInt64LE(BigInt(count), 32);
    z.writeBigUInt64LE(BigInt(cdSize), 40); z.writeBigUInt64LE(BigInt(cdStart), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0); loc.writeUInt32LE(0, 4);
    loc.writeBigUInt64LE(BigInt(offset), 8); loc.writeUInt32LE(1, 16);
    await put(Buffer.concat([z, loc]));
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(big ? U16 : count, 8); end.writeUInt16LE(big ? U16 : count, 10);
  end.writeUInt32LE(big ? U32 : cdSize, 12); end.writeUInt32LE(big ? U32 : cdStart, 16);
  end.writeUInt16LE(0, 20);
  await put(end);
}

module.exports = { writeZip, crc32, crc32Table };
