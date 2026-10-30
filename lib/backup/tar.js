'use strict';
/**
 * backup/tar.js — the archive inside a backup: POSIX tar (ustar headers, pax records for long names and big sizes),
 * written and read by our own code rather than the system `tar`, so a restore accepts exactly what we allow.
 *
 *   tarStream(entries)          async generator of Buffers: one archive from entries
 *                               { path, type: 'file'|'dir'|'link', mode, mtime (ms), size, source (file path) | data (Buffer),
 *                                 linkname }
 *   readTar(source, limits)     async generator of entries { path, type, mode, mtime, size, linkname, content() } from an
 *                               async iterable of Buffers. content() yields the file's bytes; anything not read is
 *                               skipped. Only regular files, folders and symbolic links (plus per-file pax records) are
 *                               accepted; paths must be relative and clean; limits on entry count, path length, single
 *                               and total sizes apply before the bytes are read.
 */
const fs = require('fs');

const BLOCK = 512;
const MAX_OCTAL_SIZE = 0o77777777777;   // what fits the 11-digit size field; bigger goes into a pax record
const MAX_PAX = 64 * 1024;
const DEFAULT_LIMITS = { maxEntries: 2000000, maxPathBytes: 4096, maxFileBytes: 64 * 1024 ** 3, maxTotalBytes: Infinity, drain: false, maxTail: 1024 * 1024 };
const fail = (msg) => Object.assign(new Error(msg), { code: 'ETAR' });
const pad = (n) => (BLOCK - (n % BLOCK)) % BLOCK;

// ── writing ──────────────────────────────────────────────────────────────────────────────────────────────────────
function octal(n, width) {
  const s = Math.floor(n).toString(8);
  if (s.length > width - 1) throw fail(`a value does not fit a tar header field: ${n}`);
  return s.padStart(width - 1, '0') + '\0';
}
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  return `${len}${body}`;
}
const ASCII_NAME = /^[\x20-\x7e]*$/;
function header({ name, mode, size, mtime, type, linkname = '' }) {
  const b = Buffer.alloc(BLOCK, 0);
  b.write(name, 0, 100, 'utf8');
  b.write(octal(mode & 0o7777, 8), 100, 'ascii');
  b.write(octal(0, 8), 108, 'ascii');
  b.write(octal(0, 8), 116, 'ascii');
  b.write(octal(size, 12), 124, 'ascii');
  b.write(octal(Math.max(0, mtime), 12), 136, 'ascii');
  b.write('        ', 148, 'ascii');
  b.write(type, 156, 'ascii');
  b.write(linkname, 157, 100, 'utf8');
  b.write('ustar\0', 257, 'ascii');
  b.write('00', 263, 'ascii');
  let sum = 0;
  for (const x of b) sum += x;
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return b;
}
async function* tarStream(entries) {
  for await (const e of entries) {
    const type = e.type === 'dir' ? '5' : e.type === 'link' ? '2' : '0';
    const rel = e.type === 'dir' && !e.path.endsWith('/') ? e.path + '/' : e.path;
    const size = type === '0' ? (e.data ? e.data.length : e.size) : 0;
    const mtime = Math.floor((e.mtime || 0) / 1000);
    const pax = [];
    if (Buffer.byteLength(rel) > 100 || !ASCII_NAME.test(rel)) pax.push(paxRecord('path', rel));
    if (type === '2' && (Buffer.byteLength(e.linkname) > 100 || !ASCII_NAME.test(e.linkname))) pax.push(paxRecord('linkpath', e.linkname));
    if (size > MAX_OCTAL_SIZE) pax.push(paxRecord('size', String(size)));
    if (pax.length) {
      const data = Buffer.from(pax.join(''), 'utf8');
      yield header({ name: 'PaxHeader', mode: 0o644, size: data.length, mtime, type: 'x' });
      yield data;
      if (pad(data.length)) yield Buffer.alloc(pad(data.length));
    }
    const name = pax.some(p => p.includes(' path=')) ? rel.replace(/[^\x20-\x7e]/g, '_').slice(-100) : rel;
    const link = type === '2' ? (pax.some(p => p.includes(' linkpath=')) ? 'pax-linkpath' : e.linkname) : '';
    yield header({ name, mode: e.mode == null ? (type === '5' ? 0o700 : 0o600) : e.mode, size: Math.min(size, MAX_OCTAL_SIZE), mtime, type, linkname: link });
    if (type !== '0') continue;
    if (e.data) yield e.data;
    else {
      let n = 0;
      for await (const chunk of fs.createReadStream(e.source)) {
        n += chunk.length;
        if (n > size) throw fail(`${e.path} grew while it was being archived`);
        yield chunk;
      }
      if (n !== size) throw fail(`${e.path} changed size while it was being archived`);
    }
    if (pad(size)) yield Buffer.alloc(pad(size));
  }
  yield Buffer.alloc(BLOCK * 2);
}

// ── reading ──────────────────────────────────────────────────────────────────────────────────────────────────────
function field(b, start, len) {
  const s = b.subarray(start, start + len);
  const z = s.indexOf(0);
  return (z < 0 ? s : s.subarray(0, z)).toString('utf8');
}
function num(b, start, len) {
  const s = field(b, start, len).trim();
  if (!/^[0-7]*$/.test(s)) throw fail('A tar header holds a bad number.');
  return s ? parseInt(s, 8) : 0;
}
function parsePax(data) {
  const out = {};
  let pos = 0;
  const text = data.toString('utf8');
  while (pos < text.length) {
    const sp = text.indexOf(' ', pos);
    if (sp < 0) throw fail('A pax record is malformed.');
    const len = Number(text.slice(pos, sp));
    if (!Number.isInteger(len) || len <= 0) throw fail('A pax record is malformed.');
    const rec = Buffer.from(text.slice(pos)).subarray(0, len).toString('utf8');
    if (!rec.endsWith('\n')) throw fail('A pax record is malformed.');
    const kv = rec.slice(rec.indexOf(' ') + 1, -1);
    const eq = kv.indexOf('=');
    if (eq < 1) throw fail('A pax record is malformed.');
    out[kv.slice(0, eq)] = kv.slice(eq + 1);
    pos += rec.length;
  }
  return out;
}
function cleanPath(p, limits) {
  if (Buffer.byteLength(p) > limits.maxPathBytes) throw fail('A path in the backup is too long.');
  if (!p || p.startsWith('/') || p.includes('\0')) throw fail(`The backup holds a path that isn't allowed: ${JSON.stringify(p.slice(0, 200))}`);
  const parts = p.replace(/\/+$/, '').split('/');
  if (parts.some(x => x === '' || x === '.' || x === '..')) throw fail(`The backup holds a path that isn't allowed: ${JSON.stringify(p.slice(0, 200))}`);
  return parts.join('/');
}
async function* readTar(source, limits = {}) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const it = source[Symbol.asyncIterator] ? source[Symbol.asyncIterator]() : source[Symbol.iterator]();
  let buf = Buffer.alloc(0), ended = false, entries = 0, total = 0;
  const fill = async (n) => {
    while (buf.length < n && !ended) {
      const r = await it.next();
      if (r.done) ended = true; else if (r.value.length) buf = buf.length ? Buffer.concat([buf, r.value]) : Buffer.from(r.value);
    }
    return buf.length >= n;
  };
  const take = (n) => { const b = buf.subarray(0, n); buf = buf.subarray(n); return b; };
  let pax = null;
  for (;;) {
    if (!await fill(BLOCK)) throw fail('The archive is cut off.');
    const h = take(BLOCK);
    if (h.every(x => x === 0)) {   // the end marker; with drain, read on to the authenticated end of the stream
      if (lim.drain) {
        let extra = buf.length;
        for (;;) { const r = await it.next(); if (r.done) break; extra += r.value.length; if (extra > lim.maxTail) throw fail('The backup holds data after its end, so it was not used.'); }
      }
      return;
    }
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += (i >= 148 && i < 156) ? 32 : h[i];
    if (sum !== num(h, 148, 8)) throw fail('A tar header failed its checksum.');
    const type = String.fromCharCode(h[156]);
    let size = num(h, 124, 12);
    if (type === 'x') {
      if (pax || size > MAX_PAX) throw fail('A pax record is malformed.');
      if (!await fill(size + pad(size))) throw fail('The archive is cut off.');
      pax = parsePax(take(size)); take(pad(size));
      continue;
    }
    if (!['0', '\0', '5', '2'].includes(type)) throw fail(`The backup holds an entry type that isn't allowed (${JSON.stringify(type)}).`);
    const prefix = h.subarray(257, 263).toString('latin1') === 'ustar\0' ? field(h, 345, 155) : '';
    let rawPath = pax && pax.path != null ? pax.path : (prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100));
    if (pax && pax.size != null) { if (!/^\d+$/.test(pax.size)) throw fail('A pax record is malformed.'); size = Number(pax.size); }
    const linkname = type === '2' ? (pax && pax.linkpath != null ? pax.linkpath : field(h, 157, 100)) : null;
    pax = null;
    const kind = type === '5' ? 'dir' : type === '2' ? 'link' : 'file';
    if (kind !== 'file') size = 0;
    const p = cleanPath(rawPath, lim);
    if (++entries > lim.maxEntries) throw fail('The backup holds more entries than allowed.');
    if (size > lim.maxFileBytes) throw fail(`A file in the backup is larger than allowed: ${p}`);
    total += size;
    if (total > lim.maxTotalBytes) throw fail('The backup is larger than allowed, or than this disk can hold.');
    if (kind === 'link' && (!linkname || linkname.includes('\0') || Buffer.byteLength(linkname) > lim.maxPathBytes)) throw fail(`A link in the backup isn't allowed: ${p}`);
    let left = size;
    const entry = {
      path: p, type: kind, mode: num(h, 100, 8) & 0o7777, mtime: num(h, 136, 12) * 1000, size, linkname,
      async *content() {
        while (left > 0) {
          if (!await fill(1)) throw fail('The archive is cut off.');
          const n = Math.min(left, buf.length);
          left -= n;
          yield take(n);
        }
      },
    };
    yield entry;
    while (left > 0) { if (!await fill(1)) throw fail('The archive is cut off.'); const n = Math.min(left, buf.length); left -= n; take(n); }
    if (!await fill(pad(size))) throw fail('The archive is cut off.');
    take(pad(size));
  }
}

module.exports = { tarStream, readTar, DEFAULT_LIMITS, _test: { paxRecord, parsePax, header, octal } };
