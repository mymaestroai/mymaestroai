'use strict';
// lib/faces/tar.js: a tiny, strict tar.gz writer and reader for character packs.
//   writeTarGz(entries) -> Buffer        deterministic: the same entries give the same bytes on every run
//   extractTarGz(file, destDir, limits)  streaming; accepts only plain files and folders with safe names, within size caps
// The reader is a security boundary (the archive comes from the network): anything it does not understand is refused,
// never skipped. Archive content is data; nothing in it is ever executed.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const packs = require('./packs');

const BLOCK = 512;
const MAX_ENTRIES = 2000;
const MAX_PARTS = 4;
const MAX_NAME = 100;   // total name length must be below this
const PART_RE = /^[A-Za-z0-9._-]+$/;

class TarError extends Error {}
const bad = (msg) => { throw new TarError(msg); };

// ── Names ────────────────────────────────────────────────────────────────────────────────────────────────

/** Check an entry name (no trailing slash). Throws TarError. Returns the parts. */
function checkName(name) {
  if (typeof name !== 'string' || !name) bad('The archive has an entry with no name.');
  if (name.length >= MAX_NAME) bad('The archive has an entry with a name that is too long.');
  if (name.startsWith('/')) bad('The archive has an entry with an absolute path; it was refused.');
  if (name.includes('\\')) bad('The archive has an entry with a backslash in its name; it was refused.');
  if (name.includes('\0')) bad('The archive has an entry with an odd name; it was refused.');
  const parts = name.split('/');
  if (parts.length > MAX_PARTS) bad('The archive has an entry nested too deeply; it was refused.');
  for (const p of parts) {
    if (!p || p === '.' || p === '..') bad('The archive has an entry with an empty or relative path part; it was refused.');
    if (p.startsWith('.')) bad('The archive has an entry with a hidden name; it was refused.');
    if (!PART_RE.test(p)) bad('The archive has an entry with characters that are not allowed in a name; it was refused.');
  }
  return parts;
}

// ── Writer ───────────────────────────────────────────────────────────────────────────────────────────────

function octal(n, width) {
  const s = n.toString(8);
  if (s.length > width - 1) bad('A value does not fit a tar header field.');
  return s.padStart(width - 1, '0') + '\0';
}

function header(name, size, isDir) {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 'latin1');
  h.write(octal(isDir ? 0o755 : 0o644, 8), 100, 'latin1');
  h.write(octal(0, 8), 108, 'latin1');
  h.write(octal(0, 8), 116, 'latin1');
  h.write(octal(size, 12), 124, 'latin1');
  h.write(octal(0, 12), 136, 'latin1');
  h.fill(0x20, 148, 156);   // checksum field counts as spaces
  h.write(isDir ? '5' : '0', 156, 'latin1');
  h.write('ustar\0', 257, 'latin1');
  h.write('00', 263, 'latin1');
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  return h;
}

/** entries: [{ name, data: Buffer }] -> Buffer (tar.gz). Folder entries are added for every parent folder. */
function writeTarGz(entries) {
  const files = new Map();
  for (const e of entries || []) {
    const parts = checkName(e && e.name);
    if (!Buffer.isBuffer(e.data)) bad(`"${e.name}" has no data.`);
    if (files.has(e.name)) bad(`"${e.name}" is listed twice.`);
    files.set(e.name, e.data);
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      if (files.has(d) && files.get(d) !== null) bad(`"${d}" is both a file and a folder.`);
    }
  }
  const all = new Map(files);
  for (const name of files.keys()) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      if (files.has(d)) bad(`"${d}" is both a file and a folder.`);
      all.set(d, null);
    }
  }
  const names = [...all.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const chunks = [];
  for (const name of names) {
    const data = all.get(name);
    if (data === null) { chunks.push(header(name + '/', 0, true)); continue; }
    chunks.push(header(name, data.length, false), data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  const gz = zlib.gzipSync(Buffer.concat(chunks), { level: 9 });
  gz.fill(0, 4, 8);   // header MTIME 0
  gz[9] = 3;          // OS byte: the same on every platform
  return gz;
}

// ── Reader ───────────────────────────────────────────────────────────────────────────────────────────────

function cString(buf, from, len) {
  const slice = buf.subarray(from, from + len);
  const z = slice.indexOf(0);
  return slice.toString('latin1', 0, z === -1 ? len : z);
}

function parseOctal(buf, from, len, what) {
  if (buf[from] & 0x80) bad(`The archive uses an unsupported ${what} encoding; it was refused.`);
  const s = buf.toString('latin1', from, from + len).replace(/[\0 ]+$/, '').replace(/^ +/, '');
  if (!/^[0-7]+$/.test(s) || s.length > 12) bad(`The archive has a damaged ${what} field.`);
  return parseInt(s, 8);
}

/**
 * extractTarGz(file, destDir, limits) -> Promise<{ files, bytes }>. destDir must be an empty folder made by the caller.
 * limits (optional): { maxTotalBytes, maxFileBytes, maxEntries }. On failure the caller removes destDir.
 */
async function extractTarGz(file, destDir, limits = {}) {
  const maxTotal = limits.maxTotalBytes || packs.LIMITS.maxTotalBytes;
  const maxFile = limits.maxFileBytes || packs.LIMITS.maxFileBytes;
  const maxEntries = limits.maxEntries || MAX_ENTRIES;
  const destAbs = path.resolve(String(destDir));
  const dst = fs.lstatSync(destAbs);
  if (dst.isSymbolicLink() || !dst.isDirectory()) bad('The unpack folder is not a normal folder.');
  const decompressedCap = maxTotal + maxEntries * 2 * BLOCK + 16 * BLOCK;   // data + headers + padding + end blocks

  const seen = new Set();
  let entries = 0, files = 0, bytes = 0, decompressed = 0;
  const hdr = Buffer.alloc(BLOCK);
  let hdrLen = 0;
  let state = 'header';   // header | body | pad | zero2 | done
  let fd = null, remaining = 0, pad = 0;

  const inside = (p) => p === destAbs || p.startsWith(destAbs + path.sep);
  const target = (parts) => {
    const t = path.resolve(destAbs, ...parts);
    if (!inside(t) || t === destAbs) bad('The archive has an entry outside the unpack folder; it was refused.');
    return t;
  };

  const onHeader = () => {
    const zero = hdr.every(b => b === 0);
    if (state === 'zero2') { if (!zero) bad('The archive is damaged (a gap before its end).'); state = 'done'; return; }
    if (zero) { state = 'zero2'; return; }
    // checksum
    const stored = parseOctal(hdr, 148, 8, 'checksum');
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += (i >= 148 && i < 156) ? 0x20 : hdr[i];
    if (sum !== stored) bad('The archive is damaged (a header checksum is wrong).');
    if (hdr.toString('latin1', 257, 262) !== 'ustar') bad('The archive is not a plain tar archive; it was refused.');
    const flag = hdr[156];
    const isFile = flag === 0x30 || flag === 0;
    const isDir = flag === 0x35;
    if (!isFile && !isDir) bad('The archive has an entry that is not a plain file or folder (a link, device, or extended header); it was refused.');
    let name = cString(hdr, 0, 100);
    const prefix = cString(hdr, 345, 155);
    if (prefix) name = `${prefix}/${name}`;
    if (isDir) { if (name.endsWith('/')) name = name.slice(0, -1); } else if (name.endsWith('/')) bad('The archive has a file entry with a folder name; it was refused.');
    const parts = checkName(name);
    const size = parseOctal(hdr, 124, 12, 'size');
    if (++entries > maxEntries) bad(`The archive has more than ${maxEntries} entries; it was refused.`);
    if (seen.has(name)) bad('The archive lists the same name twice; it was refused.');
    seen.add(name);
    for (let i = 1; i < parts.length; i++) if (seen.has(parts.slice(0, i).join('/')) && !dirs.has(parts.slice(0, i).join('/'))) bad('The archive has a file used as a folder; it was refused.');
    if (isDir) {
      if (size !== 0) bad('The archive has a folder entry with data; it was refused.');
      fs.mkdirSync(target(parts), { recursive: true, mode: 0o700 });
      dirs.add(name);
      return;
    }
    if (size > maxFile) bad(`The archive has a file over the ${Math.round(maxFile / 1048576)} MiB limit for one file; it was refused.`);
    if (bytes + size > maxTotal) bad(`The archive is over the ${Math.round(maxTotal / 1048576)} MiB total limit; it was refused.`);
    const t = target(parts);
    fs.mkdirSync(path.dirname(t), { recursive: true, mode: 0o700 });
    fd = fs.openSync(t, 'wx', 0o600);
    files++;
    remaining = size;
    pad = (BLOCK - (size % BLOCK)) % BLOCK;
    state = size > 0 ? 'body' : (pad ? 'pad' : 'header');
    if (size === 0) { fs.closeSync(fd); fd = null; }
  };
  const dirs = new Set();

  const feed = (chunk) => {
    decompressed += chunk.length;
    if (decompressed > decompressedCap) bad('The archive expands to more than its limits allow; it was refused.');
    let off = 0;
    while (off < chunk.length) {
      if (state === 'done') {
        for (let i = off; i < chunk.length; i++) if (chunk[i] !== 0) bad('The archive has data after its end; it was refused.');
        return;
      }
      if (state === 'body') {
        const n = Math.min(remaining, chunk.length - off);
        let w = 0;
        while (w < n) w += fs.writeSync(fd, chunk, off + w, n - w);
        off += n; remaining -= n; bytes += n;
        if (remaining === 0) { fs.closeSync(fd); fd = null; state = pad ? 'pad' : 'header'; }
      } else if (state === 'pad') {
        const n = Math.min(pad, chunk.length - off);
        off += n; pad -= n;
        if (pad === 0) state = 'header';
      } else {   // header or zero2: gather a whole block
        const n = Math.min(BLOCK - hdrLen, chunk.length - off);
        chunk.copy(hdr, hdrLen, off, off + n);
        hdrLen += n; off += n;
        if (hdrLen === BLOCK) { hdrLen = 0; onHeader(); }
      }
    }
  };

  const src = fs.createReadStream(file);
  const gunzip = zlib.createGunzip();
  let streamError = null;
  src.on('error', (e) => { streamError = new TarError(`The downloaded file could not be read (${e.code || 'error'}).`); gunzip.destroy(); });
  let gzError = null;
  gunzip.on('error', (e) => { gzError = e; });
  src.pipe(gunzip);
  try {
    try {
      for await (const chunk of gunzip) feed(chunk);
    } catch (e) {
      if (e instanceof TarError) throw e;
      if (streamError) throw streamError;
      if (gzError) throw new TarError('The archive is not a valid gzip file or is damaged; it was refused.');
      throw new TarError(`The archive could not be unpacked (${e.code || 'error'}); it was refused.`);
    }
    if (streamError) throw streamError;
    if (state !== 'done') bad('The archive is incomplete (it ends too early); it was refused.');
    return { files, bytes };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } }
    src.destroy();
    gunzip.destroy();
  }
}

module.exports = { writeTarGz, extractTarGz, TarError, MAX_ENTRIES };
