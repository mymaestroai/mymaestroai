'use strict';
// lib/faces/packs.js: character packs for the voice call face view. A pack is a folder of short video clips and
// data files that lives OUTSIDE the repo, in <hub home>/faces/<id>/. This module validates a pack folder strictly,
// installs one by an atomic staged copy, and lists / loads the installed ones. Pack files are data: nothing in
// them is ever executed, and only the exact files the manifest names are ever copied or served.
//
// Layout (see the pack format notes): manifest.json, web/<clip>.mp4, tracks/<clip>.json (speaking clips),
// beak/<shape>.png and beak/beak.json.
//
// Safety rules enforced here: no symlinks inside a pack (the pack folder itself, its sub-folders and files) and
// none at <home>/faces or the install destination; no hidden or odd names, strict bounded slug, size limits
// checked by stat BEFORE a file is read, JSON parsed only below a size cap, the copied bytes validated again
// before the final rename, only our own staging folder is ever cleaned up (with fs, never a shell).
// NOT checked: folders ABOVE the pack folder or above <home>/faces (e.g. a symlinked parent of the source folder
// the operator names, or of the hub home); those are the operator's own choice. Serving re-verifies the pack's
// own folders and the file's identity (size, inode, device, mtime, ctime) right before and after opening; Node
// has no openat(), so a swap in the instant between those checks and the open can not be ruled out entirely.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MiB = 1024 * 1024;
const LIMITS = Object.freeze({
  maxClips: 300,
  maxTotalBytes: 100 * MiB,
  maxFileBytes: 16 * MiB,
  maxManifestBytes: 1 * MiB,
  maxFrames: 100000,
  maxShapes: 16,
  slugMax: 40,
});
const POSTER_MAX_BYTES = 1 * MiB;
const POSTER_MAX_DIM = 8192;
const STATES = ['idle', 'listening', 'thinking', 'speaking', 'reaction'];
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;   // clip and shape names: no dots, slashes, percent, hidden
const WORD_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const RESERVED = new Set(['con', 'prn', 'aux', 'nul']);
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const CACHE_TTL_MS = 30000;
const CACHE_MAX = 32;

class PackError extends Error {}
const bad = (msg) => { throw new PackError(msg); };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);

function validateSlug(id) {
  if (typeof id !== 'string' || !SLUG_RE.test(id) || RESERVED.has(id)) {
    return { ok: false, error: `The pack id must be 1 to ${LIMITS.slugMax} characters: lowercase letters, digits and hyphens, starting and ending with a letter or digit.` };
  }
  return { ok: true, id };
}

/** A slug from a folder name: lowercase, anything else becomes a hyphen. Null when nothing usable is left. */
function deriveSlug(name) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, LIMITS.slugMax).replace(/-+$/, '');
  return validateSlug(s).ok ? s : null;
}

// ── Safe file access ─────────────────────────────────────────────────────────────────────────────────────

/** Remember a folder's identity; seeing the same folder with another identity later means it was swapped. */
function noteDir(dirs, abs, st) {
  const old = dirs.get(abs);
  if (!old) dirs.set(abs, { abs, ino: st.ino, dev: st.dev });
  else if (old.ino !== st.ino || old.dev !== st.dev) bad('A pack folder changed while it was being checked.');
}

/** lstat every component of rel under root: none may be a symlink; the last must be a regular file. Returns the lstat of the file. */
function checkedFile(root, rel, dirs) {
  const parts = rel.split('/');
  let cur = root;
  let st = null;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p || p.startsWith('.') || p === '..') bad(`"${rel}" has a hidden or empty name part.`);
    cur = path.join(cur, p);
    try { st = fs.lstatSync(cur); } catch (e) { bad(`"${rel}" is missing.`); }
    if (st.isSymbolicLink()) bad(`"${rel}" goes through a symbolic link, which is not allowed.`);
    if (i < parts.length - 1) {
      if (!st.isDirectory()) bad(`"${parts.slice(0, i + 1).join('/')}" is not a folder.`);
      if (dirs) noteDir(dirs, cur, st);
    }
  }
  if (!st.isFile()) bad(`"${rel}" is not a regular file.`);
  return { abs: cur, st };
}

/** Open a checked file without following links, confirm it is still the file lstat saw, and enforce the size cap before any read. */
function openChecked(root, rel, maxBytes, dirs) {
  const { abs, st } = checkedFile(root, rel, dirs);
  let fd;
  try { fd = fs.openSync(abs, fs.constants.O_RDONLY | NOFOLLOW); } catch (e) { bad(`"${rel}" cannot be opened (${e.code || 'error'}).`); }
  try {
    const f = fs.fstatSync(fd);
    if (!f.isFile() || f.ino !== st.ino || f.dev !== st.dev) bad(`"${rel}" changed while it was being checked.`);
    if (f.size <= 0) bad(`"${rel}" is empty.`);
    if (f.size > maxBytes) bad(`"${rel}" is ${(f.size / MiB).toFixed(1)} MiB, over the ${(maxBytes / MiB).toFixed(0)} MiB limit for one file.`);
    return { fd, size: f.size, abs, ino: f.ino, dev: f.dev, mtimeMs: f.mtimeMs, ctimeMs: f.ctimeMs };
  } catch (e) { fs.closeSync(fd); throw e; }
}

function readHead(fd, n) {
  const buf = Buffer.alloc(n);
  const got = fs.readSync(fd, buf, 0, n, 0);
  return buf.subarray(0, got);
}

function readAll(fd, size) {
  const buf = Buffer.alloc(size);
  let off = 0;
  while (off < size) {
    const n = fs.readSync(fd, buf, off, size - off, off);
    if (!n) break;
    off += n;
  }
  if (off !== size) bad('A file changed size while it was being read.');
  return buf;
}

function parseJson(buf, what) {
  let v;
  try { v = JSON.parse(buf.toString('utf8')); } catch { bad(`${what} is not valid JSON.`); }
  return v;
}

// ── Format sniffing ──────────────────────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/** PNG: signature, a well-formed IHDR chunk (length, type, CRC), sane dimensions, a colour type with an alpha channel. */
function pngInfo(head, rel) {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (head.length < 33 || !head.subarray(0, 8).equals(SIG)) bad(`"${rel}" is not a PNG image.`);
  if (head.readUInt32BE(8) !== 13 || head.toString('latin1', 12, 16) !== 'IHDR') bad(`"${rel}" has no valid PNG header.`);
  if (crc32(head.subarray(12, 29)) !== head.readUInt32BE(29)) bad(`"${rel}" has a damaged PNG header.`);
  const w = head.readUInt32BE(16), h = head.readUInt32BE(20), depth = head[24], colour = head[25], interlace = head[28];
  if (!(w >= 1 && w <= 4096 && h >= 1 && h <= 4096)) bad(`"${rel}" has unreasonable PNG dimensions.`);
  if (![4, 6].includes(colour) || ![8, 16].includes(depth) || head[26] !== 0 || head[27] !== 0 || interlace > 1) bad(`"${rel}" is not an RGBA or grey-alpha PNG.`);
  return { w, h };
}

/** PNG header of any colour type (posters): signature, IHDR length/type/CRC, valid depth/colour combination, sane size. */
function pngAnyInfo(head, rel) {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (head.length < 33 || !head.subarray(0, 8).equals(SIG)) bad(`"${rel}" is not a PNG image.`);
  if (head.readUInt32BE(8) !== 13 || head.toString('latin1', 12, 16) !== 'IHDR') bad(`"${rel}" has no valid PNG header.`);
  if (crc32(head.subarray(12, 29)) !== head.readUInt32BE(29)) bad(`"${rel}" has a damaged PNG header.`);
  const w = head.readUInt32BE(16), h = head.readUInt32BE(20), depth = head[24], colour = head[25];
  if (!(w >= 1 && w <= POSTER_MAX_DIM && h >= 1 && h <= POSTER_MAX_DIM)) bad(`"${rel}" has unreasonable PNG dimensions.`);
  const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }[colour];
  if (!depths || !depths.includes(depth) || head[26] !== 0 || head[27] !== 0 || head[28] > 1) bad(`"${rel}" has an invalid PNG header.`);
  return { w, h };
}

/** JPEG: SOI, then walk the marker segments (bounded) to the first start-of-frame, which holds the dimensions. */
function jpegInfo(buf, rel) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) bad(`"${rel}" is not a JPEG image.`);
  let p = 2;
  for (let n = 0; n < 512 && p + 4 <= buf.length; n++) {
    if (buf[p] !== 0xff) bad(`"${rel}" has a damaged JPEG header.`);
    while (p < buf.length && buf[p] === 0xff) p++;   // fill bytes
    const m = buf[p++];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue;   // markers without a length
    if (m === 0xd9 || m === 0xda) break;   // end / scan data before any frame header
    if (p + 2 > buf.length) break;
    const len = buf.readUInt16BE(p);
    if (len < 2 || p + len > buf.length) bad(`"${rel}" has a damaged JPEG header.`);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (len < 8) bad(`"${rel}" has a damaged JPEG header.`);
      const h = buf.readUInt16BE(p + 3), w = buf.readUInt16BE(p + 5);
      if (!(w >= 1 && h >= 1 && w <= POSTER_MAX_DIM && h <= POSTER_MAX_DIM)) bad(`"${rel}" has unreasonable JPEG dimensions.`);
      return { w, h };
    }
    p += len;
  }
  bad(`"${rel}" has no JPEG frame header.`);
}

/** WebP: RIFF/WEBP container whose first chunk is VP8, VP8L or VP8X; dimensions read from that chunk. */
function webpInfo(buf, rel) {
  if (buf.length < 30 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') bad(`"${rel}" is not a WebP image.`);
  if (buf.readUInt32LE(4) + 8 > buf.length) bad(`"${rel}" is a truncated WebP image.`);
  const kind = buf.toString('latin1', 12, 16);
  let w, h;
  if (kind === 'VP8 ') {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) bad(`"${rel}" has a damaged WebP header.`);
    w = buf.readUInt16LE(26) & 0x3fff; h = buf.readUInt16LE(28) & 0x3fff;
  } else if (kind === 'VP8L') {
    if (buf[20] !== 0x2f) bad(`"${rel}" has a damaged WebP header.`);
    const b = buf.readUInt32LE(21);
    w = (b & 0x3fff) + 1; h = ((b >>> 14) & 0x3fff) + 1;
  } else if (kind === 'VP8X') {
    w = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1; h = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1;
  } else bad(`"${rel}" has an unknown WebP layout.`);
  if (!(w >= 1 && h >= 1 && w <= POSTER_MAX_DIM && h <= POSTER_MAX_DIM)) bad(`"${rel}" has unreasonable WebP dimensions.`);
  return { w, h };
}

const POSTER_TYPES = { png: { mime: 'image/png', exts: ['png'] }, jpeg: { mime: 'image/jpeg', exts: ['jpg', 'jpeg'] }, webp: { mime: 'image/webp', exts: ['webp'] } };

/** Poster image: the content decides the type, and the file extension must agree with it. Returns the MIME type. */
function sniffPoster(buf, rel) {
  const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase();
  let type;
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50) { pngAnyInfo(buf, rel); type = 'png'; }
  else if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) { jpegInfo(buf, rel); type = 'jpeg'; }
  else if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF') { webpInfo(buf, rel); type = 'webp'; }
  else bad(`"${rel}" is not a PNG, JPEG or WebP image.`);
  if (!POSTER_TYPES[type].exts.includes(ext)) bad(`"${rel}" is a ${type === 'webp' ? 'WebP' : type.toUpperCase()} image but its name ends in .${ext}.`);
  return POSTER_TYPES[type].mime;
}

const POSTER_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** A pack-relative poster path: plain segments, no leading slash, no "..", no hidden parts, a png/jpg/jpeg/webp name. */
function checkPosterPath(v, what) {
  if (typeof v !== 'string' || !v) bad(`${what} must be a file path inside the pack.`);
  if (v.length > 120 || /[\u0000-\u001f\u007f\\%:<>"|?*]/.test(v)) bad(`${what} has characters that are not allowed in a pack path.`);
  if (v.startsWith('/')) bad(`${what} must be relative to the pack folder (no leading slash).`);
  const parts = v.split('/');
  if (parts.length > 4 || parts.some(p => !p || p === '.' || p === '..' || p.startsWith('.') || /[ .]$/.test(p))) bad(`${what} must be a plain relative path (no "..", hidden or empty parts).`);
  if (!parts.every(p => POSTER_SEGMENT_RE.test(p))) bad(`${what} parts must be 1 to 100 letters, digits, ".", "_" or "-", starting with a letter or digit (no spaces or other characters).`);   // the same segment rule the face route (lib/access.js) accepts
  if (!/\.(png|jpe?g|webp)$/i.test(v)) bad(`${what} must end in .png, .jpg, .jpeg or .webp.`);
  if (v.toLowerCase() === 'manifest.json') bad(`${what} can not be the manifest.`);
  return v;
}

/** poster + posters -> list of distinct poster paths to check (poster first). Unknown posters keys are ignored. */
function checkPosters(m) {
  const out = [];
  if (m.posters !== undefined && !isObj(m.posters)) bad('manifest.json: posters must be an object of pose name to image path.');
  if (m.poster !== undefined) out.push(checkPosterPath(m.poster, 'manifest.json: poster'));
  if (isObj(m.posters)) {
    if (m.poster === undefined) bad('manifest.json: posters needs a "poster" that is the same path as posters.A.');
    if (m.posters.A === undefined) bad('manifest.json: posters must include pose "A".');
    for (const k of ['A', 'B']) {
      if (m.posters[k] === undefined) continue;
      const p = checkPosterPath(m.posters[k], `manifest.json: posters.${k}`);
      if (!out.includes(p)) out.push(p);
    }
    if (m.posters.A !== m.poster) bad('manifest.json: poster must be exactly the same path as posters.A.');
  }
  return out;
}

const SAFE_EPS = 1e-9;
/** safeArea / safeAreaTypical / safeAreaComfort: exactly {x, y, w, h}, finite numbers, x,y >= 0, w,h > 0, x+w <= 1, y+h <= 1 (fractions of the frame). */
function checkSafeArea(v, what) {
  if (v === undefined) return;
  if (!isObj(v)) bad(`manifest.json: ${what} must be an object {x, y, w, h}.`);
  const keys = Object.keys(v);
  if (keys.length !== 4 || !['x', 'y', 'w', 'h'].every(k => keys.includes(k))) bad(`manifest.json: ${what} must have exactly x, y, w and h.`);
  if (!['x', 'y', 'w', 'h'].every(k => isNum(v[k]))) bad(`manifest.json: ${what} x, y, w and h must be finite numbers.`);
  if (v.x < 0 || v.y < 0 || !(v.w > 0) || !(v.h > 0) || v.x + v.w > 1 + SAFE_EPS || v.y + v.h > 1 + SAFE_EPS) bad(`manifest.json: ${what} must stay inside the frame (x, y from 0; w, h above 0; x+w and y+h at most 1).`);
}

/** MP4: the first box is "ftyp" with a plausible size. */
function checkMp4(head, rel) {
  if (head.length < 12 || head.toString('latin1', 4, 8) !== 'ftyp') bad(`"${rel}" is not an MP4 video (no ftyp box).`);
  const size = head.readUInt32BE(0);
  if (size < 12 || size > 4096) bad(`"${rel}" has an implausible MP4 header.`);
}

// ── Manifest checks ──────────────────────────────────────────────────────────────────────────────────────

function checkTrack(buf, rel) {
  const t = parseJson(buf, `"${rel}"`);
  if (!isObj(t)) bad(`"${rel}" must be a JSON object.`);
  if (!isNum(t.fps) || t.fps < 1 || t.fps > 120) bad(`"${rel}": fps must be a number from 1 to 120.`);
  if (!isInt(t.w) || !isInt(t.h) || t.w < 1 || t.h < 1 || t.w > 8192 || t.h > 8192) bad(`"${rel}": w and h must be whole numbers from 1 to 8192.`);
  if (t.box !== undefined && !(Array.isArray(t.box) && t.box.length === 4 && t.box.every(isNum))) bad(`"${rel}": box must be four numbers.`);
  if (!Array.isArray(t.frames) || t.frames.length < 1 || t.frames.length > LIMITS.maxFrames) bad(`"${rel}": frames must hold 1 to ${LIMITS.maxFrames} entries.`);
  for (let i = 0; i < t.frames.length; i++) {
    const f = t.frames[i];
    if (!Array.isArray(f) || f.length < 4 || f.length > 8 || !f.every(isNum)) bad(`"${rel}": frame ${i} must be 4 to 8 finite numbers.`);
    if (Math.abs(f[0]) > 20000 || Math.abs(f[1]) > 20000 || !(f[2] > 0 && f[2] <= 50) || Math.abs(f[3]) > 720) bad(`"${rel}": frame ${i} is out of range.`);
  }
}

function checkClip(c, i, seen) {
  if (!isObj(c)) bad(`Clip ${i} must be an object.`);
  if (typeof c.name !== 'string' || !NAME_RE.test(c.name)) bad(`Clip ${i}: name must be letters, digits, "-" or "_" (1 to 80 characters).`);
  const key = c.name.toLowerCase();
  if (seen.has(key)) bad(`Clip name "${c.name}" appears twice.`);
  seen.add(key);
  if (!STATES.includes(c.state)) bad(`Clip "${c.name}": state must be one of ${STATES.join(', ')}.`);
  if (!isNum(c.weight) || c.weight <= 0 || c.weight > 1000) bad(`Clip "${c.name}": weight must be a number above 0 and at most 1000.`);
  if (!isNum(c.dur) || c.dur <= 0 || c.dur > 600) bad(`Clip "${c.name}": dur must be a number of seconds above 0 and at most 600.`);
  if (typeof c.track !== 'boolean') bad(`Clip "${c.name}": track must be true or false.`);
  if (c.state === 'speaking' && c.track !== true) bad(`Clip "${c.name}": a speaking clip needs track: true (its beak track).`);
  if (typeof c.rare !== 'boolean') bad(`Clip "${c.name}": rare must be true or false.`);
  if (c.family !== undefined && !(typeof c.family === 'string' && WORD_RE.test(c.family))) bad(`Clip "${c.name}": family must be a short word.`);
  if (c.mood !== undefined && !(typeof c.mood === 'string' && WORD_RE.test(c.mood))) bad(`Clip "${c.name}": mood must be a short word.`);
  for (const k of ['startsFrom', 'endsOn']) if (c[k] !== undefined && c[k] !== 'A' && c[k] !== 'B') bad(`Clip "${c.name}": ${k} must be "A" or "B".`);
  if (c.beakEnds !== undefined && c.beakEnds !== 'closed' && c.beakEnds !== 'smile') bad(`Clip "${c.name}": beakEnds must be "closed" or "smile".`);
}

const SPEAKING_SHAPES = ['closed', 'slight', 'half', 'wide', 'oo'];

function checkBeak(b, anyTrack, anySpeaking) {
  if (b === undefined) { if (anyTrack) bad('The manifest needs a "beak" block because some clips carry a beak track.'); return null; }
  if (!isObj(b)) bad('"beak" must be an object.');
  const pair = (v, what, min) => { if (!(Array.isArray(v) && v.length === (what === 'roi' ? 4 : 2) && v.every(x => isNum(x) && Math.abs(x) <= 8192))) bad(`beak.${what} must be ${what === 'roi' ? 'four' : 'two'} finite numbers.`); if (min && !(v[2] > 0 && v[3] > 0 && v[2] <= 1024 && v[3] <= 1024)) bad('beak.roi width and height must be from 1 to 1024.'); };
  pair(b.roi, 'roi', true);
  if (!b.roi.every(Number.isInteger)) bad('beak.roi must be whole numbers.');
  pair(b.centre, 'centre', false);
  if (!Array.isArray(b.shapes) || b.shapes.length < 1 || b.shapes.length > LIMITS.maxShapes) bad(`beak.shapes must list 1 to ${LIMITS.maxShapes} shapes.`);
  const shapes = new Set();
  for (const s of b.shapes) {
    if (typeof s !== 'string' || !NAME_RE.test(s)) bad('beak.shapes names must be letters, digits, "-" or "_".');
    if (shapes.has(s.toLowerCase())) bad(`beak shape "${s}" appears twice.`);
    shapes.add(s.toLowerCase());
  }
  // Exact, lower-case names: the player asks for beak/closed.png, which a "Closed.png" would not satisfy on every filesystem.
  if (!b.shapes.includes('closed')) bad('beak.shapes must include "closed" (exactly, in lower case).');
  if (anySpeaking) for (const need of SPEAKING_SHAPES) if (!b.shapes.includes(need)) bad(`beak.shapes must include "${need}" because the pack has speaking clips (needs ${SPEAKING_SHAPES.join(', ')}).`);
  if (b.smile !== undefined && !(typeof b.smile === 'string' && NAME_RE.test(b.smile))) bad('beak.smile must be a shape name.');
  if (b.smile !== undefined && shapes.has(b.smile.toLowerCase()) && !b.shapes.includes(b.smile)) bad('beak.smile differs from a listed shape only by letter case.');
  if (b.blendFrames !== undefined && !(isInt(b.blendFrames) && b.blendFrames >= 0 && b.blendFrames <= 12)) bad('beak.blendFrames must be a whole number from 0 to 12.');
  return b;
}

const sameNums = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

// ── validatePack ─────────────────────────────────────────────────────────────────────────────────────────

const MIME = { json: 'application/json; charset=utf-8', mp4: 'video/mp4', png: 'image/png' };

/**
 * validatePack(root) -> { ok: true, manifest, files, total } | { ok: false, error }
 * files: null-prototype object keyed by the exact relative path ("manifest.json", "web/x.mp4", ...), each
 * { rel, abs, size, mime, kind, ino, dev, mtimeMs, ctimeMs }. dirs: [{ abs, ino, dev }] for the pack folder and each
 * sub-folder used. Reads only the files the manifest names. Never throws for a bad pack.
 */
function validatePack(root) {
  try {
    if (typeof root !== 'string' || !root) bad('No pack folder was given.');
    const rootAbs = path.resolve(root);
    let rst;
    try { rst = fs.lstatSync(rootAbs); } catch { bad('The pack folder does not exist.'); }
    if (rst.isSymbolicLink()) bad('The pack folder is a symbolic link, which is not allowed.');
    if (!rst.isDirectory()) bad('The pack path is not a folder.');
    const files = Object.create(null);
    const dirMap = new Map([[rootAbs, { abs: rootAbs, ino: rst.ino, dev: rst.dev }]]);
    let total = 0;
    const add = (rel, mime, kind, o) => {
      total += o.size;
      if (total > LIMITS.maxTotalBytes) bad(`The pack is over the ${LIMITS.maxTotalBytes / MiB} MiB total limit.`);
      files[rel] = { rel, abs: o.abs, size: o.size, mime, kind, ino: o.ino, dev: o.dev, mtimeMs: o.mtimeMs, ctimeMs: o.ctimeMs };
    };
    // One file open at a time: fn gets the open file and the descriptor is closed when it returns.
    const use = (rel, fn) => {
      const o = openChecked(rootAbs, rel, rel === 'manifest.json' ? LIMITS.maxManifestBytes : LIMITS.maxFileBytes, dirMap);
      try { return fn(o); } finally { try { fs.closeSync(o.fd); } catch { /* closed */ } }
    };

    const manifest = use('manifest.json', (o) => { const m = parseJson(readAll(o.fd, o.size), 'manifest.json'); add('manifest.json', MIME.json, 'manifest', o); return m; });
    if (!isObj(manifest)) bad('manifest.json must be a JSON object.');
    if (manifest.version !== 2 && manifest.version !== 3) bad('manifest.json: version must be 2 or 3.');
    if (manifest.name !== undefined && !(typeof manifest.name === 'string' && manifest.name.length >= 1 && manifest.name.length <= 60 && !/[\u0000-\u001f\u007f<>]/.test(manifest.name))) bad('manifest.json: name must be 1 to 60 plain characters.');
    if (manifest.background !== undefined && !(typeof manifest.background === 'string' && COLOR_RE.test(manifest.background))) bad('manifest.json: background must be a colour like #ffd6ab.');
    if (manifest.demoReaction !== undefined && !(typeof manifest.demoReaction === 'string' && NAME_RE.test(manifest.demoReaction))) bad('manifest.json: demoReaction must be a clip name.');
    if (!Array.isArray(manifest.clips) || manifest.clips.length < 1) bad('manifest.json: clips must be a list with at least one clip.');
    if (manifest.clips.length > LIMITS.maxClips) bad(`manifest.json: ${manifest.clips.length} clips is over the limit of ${LIMITS.maxClips}.`);
    const posterPaths = checkPosters(manifest);
    checkSafeArea(manifest.safeArea, 'safeArea');
    checkSafeArea(manifest.safeAreaTypical, 'safeAreaTypical');
    checkSafeArea(manifest.safeAreaComfort, 'safeAreaComfort');
    const seen = new Set();
    manifest.clips.forEach((c, i) => checkClip(c, i, seen));
    const anyTrack = manifest.clips.some(c => c.track);
    const beak = checkBeak(manifest.beak, anyTrack, manifest.clips.some(c => c.state === 'speaking'));

    for (const c of manifest.clips) {
      const rel = `web/${c.name}.mp4`;
      use(rel, (o) => { checkMp4(readHead(o.fd, 64), rel); add(rel, MIME.mp4, 'video', o); });
      if (c.track) {
        const trel = `tracks/${c.name}.json`;
        use(trel, (t) => { checkTrack(readAll(t.fd, t.size), trel); add(trel, MIME.json, 'track', t); });
      }
    }
    if (beak) {
      use('beak/beak.json', (bj) => {
        const g = parseJson(readAll(bj.fd, bj.size), 'beak/beak.json');
        if (!isObj(g)) bad('beak/beak.json must be a JSON object.');
        if (!sameNums(g.roi, beak.roi) || !sameNums(g.centre, beak.centre)) bad('beak/beak.json does not match the manifest\'s beak roi and centre.');
        add('beak/beak.json', MIME.json, 'beak-json', bj);
      });
      const names = [...beak.shapes];
      if (beak.smile && !names.some(s => s.toLowerCase() === beak.smile.toLowerCase())) names.push(beak.smile);
      for (const s of names) {
        const rel = `beak/${s}.png`;
        use(rel, (o) => {
          const { w, h } = pngInfo(readHead(o.fd, 33), rel);
          if (w !== beak.roi[2] || h !== beak.roi[3]) bad(`"${rel}" is ${w}x${h} but the beak roi is ${beak.roi[2]}x${beak.roi[3]}.`);
          add(rel, MIME.png, 'beak', o);
        });
      }
    }
    for (const rel of posterPaths) {
      if (files[rel]) { if (files[rel].size > POSTER_MAX_BYTES) bad(`Poster "${rel}" is over the 1 MiB limit for one poster.`); if (files[rel].kind !== 'beak') bad(`Poster "${rel}" is already used as another pack file.`); continue; }   // a beak PNG may double as a poster
      use(rel, (o) => {
        if (o.size > POSTER_MAX_BYTES) bad(`Poster "${rel}" is ${(o.size / MiB).toFixed(1)} MiB, over the 1 MiB limit for one poster.`);
        const mime = sniffPoster(readAll(o.fd, o.size), rel);
        add(rel, mime, 'poster', o);
      });
    }
    return { ok: true, manifest, files, dirs: [...dirMap.values()], total };
  } catch (e) {
    if (e instanceof PackError) return { ok: false, error: e.message };
    return { ok: false, error: `The pack could not be checked (${e.code || e.message}).` };
  }
}

// ── Verified open ────────────────────────────────────────────────────────────────────────────────────────

const sameFile = (st, f) => st.isFile() && st.size === f.size && st.ino === f.ino && st.dev === f.dev && st.mtimeMs === f.mtimeMs && st.ctimeMs === f.ctimeMs;

/** True while every recorded folder is still a real folder (not a link) with the identity it had when it was checked. */
function dirsIntact(dirs) {
  for (const d of dirs || []) {
    const s = lstatOrNull(d.abs);
    if (!s || s.isSymbolicLink() || !s.isDirectory() || s.ino !== d.ino || s.dev !== d.dev) return false;
  }
  return true;
}

/**
 * openVerified({ dirs }, f) -> { fd, st } | null. Opens f.abs read-only without following a link, but only when every
 * recorded pack folder is still the real folder it was and the opened file still has the size, inode, device, mtime
 * AND ctime of the checked one (ctime catches an in-place edit with a restored mtime). The folders are checked
 * before and again after the open. The caller owns the descriptor. Null on any difference: revalidate fully.
 */
function openVerified(pack, f) {
  let fd;
  try {
    if (!pack || !f || !dirsIntact(pack.dirs)) return null;
    const l = lstatOrNull(f.abs);
    if (!l || l.isSymbolicLink() || !l.isFile()) return null;
    fd = fs.openSync(f.abs, fs.constants.O_RDONLY | NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!sameFile(st, f) || !dirsIntact(pack.dirs)) { fs.closeSync(fd); return null; }
    return { fd, st };
  } catch {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* closed */ } }
    return null;
  }
}

// ── installPack ──────────────────────────────────────────────────────────────────────────────────────────

function homeFaces(home) { return path.join(path.resolve(String(home || '')), 'faces'); }

/** Make <home>/faces (a real folder, never a link). */
function ensureFacesDir(home) {
  const dir = homeFaces(home);
  let st = null;
  try { st = fs.lstatSync(dir); } catch { /* not there yet */ }
  if (st) {
    if (st.isSymbolicLink() || !st.isDirectory()) bad(`${dir} must be a normal folder, not a link or a file.`);
  } else fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Account name for a uid from /etc/passwd (or the injected lookup); null when unknown. */
function accountName(uid, lookupUser) {
  try {
    if (typeof lookupUser === 'function') { const n = lookupUser(uid); return n ? String(n) : null; }
    for (const l of fs.readFileSync('/etc/passwd', 'utf8').split('\n')) { const f = l.split(':'); if (f.length >= 3 && Number(f[2]) === uid) return f[0]; }
  } catch { /* unknown */ }
  return null;
}

/**
 * Installing or removing as root inside a hub home that belongs to an ordinary account would leave root-owned files
 * the hub (running as that account) can not manage. Refuse, naming the account to run as; never chown. A root-owned
 * home is fine. geteuid / getuid / lookupUser / homeUid exist so tests can pretend without being root.
 */
function assertNotRootForUserHome(home, { geteuid, getuid, lookupUser, homeUid } = {}) {
  const e = typeof geteuid === 'function' ? geteuid() : (process.geteuid ? process.geteuid() : null);
  const r = typeof getuid === 'function' ? getuid() : (process.getuid ? process.getuid() : null);
  if (e !== 0 && r !== 0) return;
  let owner = homeUid;
  if (owner === undefined) {
    const homeAbs = path.resolve(String(home));
    try { owner = fs.statSync(homeAbs).uid; } catch (e) {
      if (e && e.code === 'ENOENT') return;   // no home yet: root would own what it makes. Every other error is not "absent".
      throw new Error(`Refusing to run as root: could not check who owns the hub home ${homeAbs} (${(e && e.code) || 'error'}), so it is not safe to continue. Nothing was changed.`);
    }
  }
  if (owner === 0) return;
  const name = accountName(owner, lookupUser);
  const who = name ? `the account "${name}"` : `the account with user id ${owner}`;
  throw new Error(`Refusing to run as root: the hub home ${path.resolve(String(home))} belongs to ${who}. Run this command as ${name ? `"${name}"` : 'that account'} instead, so the files keep the right owner. Nothing was changed.`);
}

/** Write all of buf[0..n): fs.writeSync may write less than asked. */
function writeAll(fd, buf, n) {
  let off = 0, stalls = 0;
  while (off < n) {
    const w = fs.writeSync(fd, buf, off, n - off);
    if (!w) { if (++stalls > 100) bad('Writing a pack file made no progress.'); continue; }
    stalls = 0;
    off += w;
  }
}

/** Copy one first-pass file (f) to dest. The source must still be the very file validation saw, before and after the copy. */
function copyFile(src, dest, f, srcPack) {
  const opened = openVerified(srcPack, f);
  if (!opened) bad('A pack file changed while it was being copied.');
  const sfd = opened.fd;
  let dfd = null;
  try {
    dfd = fs.openSync(dest, 'wx', 0o600);
    const buf = Buffer.alloc(256 * 1024);
    let done = 0;
    for (;;) {
      const n = fs.readSync(sfd, buf, 0, buf.length, null);
      if (!n) break;
      done += n;
      if (done > f.size) bad('A pack file grew while it was being copied.');
      writeAll(dfd, buf, n);
    }
    if (done !== f.size) bad('A pack file shrank while it was being copied.');
    if (!sameFile(fs.fstatSync(sfd), f) || !dirsIntact(srcPack.dirs)) bad('A pack file changed while it was being copied.');
  } finally {
    fs.closeSync(sfd);
    if (dfd !== null) fs.closeSync(dfd);
  }
}

/**
 * installPack(source, { home, id }) -> { id, dir, manifest, files, total }. Throws an Error with a plain message.
 * Copies only the manifest and the files it references into <home>/faces/.staging-*, validates the COPY again,
 * then renames it to <home>/faces/<id>. Never overwrites an installed pack.
 */
function installPack(source, { home, id, geteuid, getuid, lookupUser, homeUid } = {}) {
  if (!home) throw new Error('No hub home was given.');
  assertNotRootForUserHome(home, { geteuid, getuid, lookupUser, homeUid });
  const srcAbs = path.resolve(String(source || ''));
  let slug = id;
  if (slug === undefined || slug === null || slug === '') {
    slug = deriveSlug(path.basename(srcAbs));
    if (!slug) throw new Error('Could not make a pack id from the folder name; give one with --id <slug>.');
  } else {
    const v = validateSlug(slug);
    if (!v.ok) throw new Error(v.error);
  }
  const first = validatePack(srcAbs);
  if (!first.ok) throw new Error(`Not a valid character pack: ${first.error}`);
  let staging = null;
  let facesDir = null;
  try {
    facesDir = ensureFacesDir(home);
    const dest = path.join(facesDir, slug);
    const exists = () => { try { fs.lstatSync(dest); return true; } catch { return false; } };
    if (exists()) bad(`A pack with the id "${slug}" is already installed (${dest}). Choose another --id; to replace it, remove that folder yourself first.`);
    const stage = path.join(facesDir, `.staging-${slug}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    fs.mkdirSync(stage, { mode: 0o700 });
    staging = stage;
    for (const f of Object.values(first.files)) {
      const target = path.join(stage, ...f.rel.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      copyFile(f.abs, target, f, first);
    }
    const second = validatePack(stage);
    if (!second.ok) bad(`The copied pack failed its check: ${second.error}`);
    const a = Object.keys(first.files).sort(), b = Object.keys(second.files).sort();
    if (a.length !== b.length || a.some((k, i) => k !== b[i] || first.files[k].size !== second.files[k].size)) bad('The pack changed while it was being copied; nothing was installed.');
    if (exists()) bad(`A pack with the id "${slug}" appeared while installing; nothing was installed.`);
    fs.renameSync(stage, dest);
    staging = null;
    return { id: slug, dir: dest, manifest: second.manifest, files: Object.keys(second.files), total: second.total };
  } catch (e) {
    if (staging && facesDir && path.dirname(staging) === facesDir && path.basename(staging).startsWith('.staging-')) {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* leave it; it is hidden and ignored */ }
    }
    if (e instanceof PackError) throw new Error(e.message);
    throw e;
  }
}

// ── removePack ───────────────────────────────────────────────────────────────────────────────────────────

const shQuote = (s) => (/^[A-Za-z0-9_\/.:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * removePack(id, { home, now, dryRun }) -> { id, from, archiveDir, to, restore }. Never deletes: ONE rename of
 * <home>/faces/<id> to <home>/faces-removed/<id>-<UTC timestamp> on the same filesystem. The archive folder (mode
 * 0700) sits outside faces/, so it is never listed or served. The id is checked like install's; a symlinked pack,
 * faces folder or archive folder is refused, never followed. A taken archive name is never overwritten: the name is
 * reserved with mkdir (fails if it exists) before the rename. dryRun only checks and names the destination.
 * Lists, getPack and the routes see the removal at once: the cache entry is dropped and the folder is gone.
 */
function removePack(id, { home, now, dryRun, geteuid, getuid, lookupUser, homeUid, platform } = {}) {
  if (!home) throw new Error('No hub home was given.');
  // The mode 0700 / link / same-folder guarantees below are not provided by Windows file systems: refuse before any check or change.
  if ((platform || process.platform) === 'win32') throw new Error('Removing a character pack is not supported on Windows; nothing was changed. Move the folder out of faces yourself instead.');
  const v = validateSlug(id);
  if (!v.ok) throw new Error(v.error);
  assertNotRootForUserHome(home, { geteuid, getuid, lookupUser, homeUid });
  const homeAbs = path.resolve(String(home));
  const facesDir = homeFaces(home);
  const notInstalled = () => new Error(`No character pack "${id}" is installed. See: mymaestro face list`);
  const fst = lstatOrNull(facesDir);
  if (!fst) throw notInstalled();
  if (fst.isSymbolicLink() || !fst.isDirectory()) throw new Error(`${facesDir} must be a normal folder, not a link or a file; nothing was changed.`);
  const from = path.join(facesDir, id);
  const st = lstatOrNull(from);
  if (!st) throw notInstalled();
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${from} is a link or not a folder; it is not touched.`);
  const archiveDir = path.join(homeAbs, 'faces-removed');
  const ast = lstatOrNull(archiveDir);
  if (ast && (ast.isSymbolicLink() || !ast.isDirectory())) throw new Error(`${archiveDir} must be a normal folder, not a link or a file; nothing was changed.`);
  if (ast && (ast.mode & 0o777) !== 0o700) throw new Error(`${archiveDir} must have mode 0700 (it has ${(ast.mode & 0o777).toString(8).padStart(4, '0')}); its permissions were not changed, nothing was moved. Fix it yourself (chmod 700) and run this again.`);
  if (ast && ast.dev !== fst.dev) throw new Error(`${archiveDir} is on another filesystem than ${facesDir}; nothing was changed.`);
  const t = now instanceof Date ? now : new Date(now === undefined ? Date.now() : now);
  const stamp = t.toISOString().replace(/[-:.]/g, '');   // 20261113T173800123Z
  const to = path.join(archiveDir, `${id}-${stamp}`);
  const restore = (dest) => `mymaestro face install ${shQuote(dest)} --id ${id}`;
  if (dryRun) return { id, from, archiveDir, to, restore: restore(to) };
  if (!ast) {
    // First-ever archive: another process may create it between the check above and here. Only EEXIST is tolerated;
    // the folder is then checked below exactly like one that existed from the start (real folder, same fs, mode 0700).
    try { fs.mkdirSync(archiveDir, { mode: 0o700 }); } catch (e) { if (!e || e.code !== 'EEXIST') throw e; }
  }
  const a2 = lstatOrNull(archiveDir);
  if (!a2 || a2.isSymbolicLink() || !a2.isDirectory() || a2.dev !== fst.dev || (a2.mode & 0o777) !== 0o700) throw new Error(`${archiveDir} changed or is not mode 0700; nothing was moved.`);
  let dest = null;
  for (let n = 0; n < 100 && !dest; n++) {
    const cand = n ? `${to}-${n}` : to;
    try { fs.mkdirSync(cand, { mode: 0o700 }); dest = cand; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  if (!dest) throw new Error(`Could not find a free name in ${archiveDir}; nothing was changed.`);
  try {
    fs.renameSync(from, dest);   // onto our own empty reservation: nothing else can be replaced
  } catch (e) {
    try { fs.rmdirSync(dest); } catch { /* leave the empty reservation */ }
    throw new Error(`Could not move the pack (${e.code || e.message}); nothing was changed.`);
  }
  cache.delete(`${homeAbs}\0${id}`);
  return { id, from, archiveDir, to: dest, restore: restore(dest) };
}

// ── Installed packs ──────────────────────────────────────────────────────────────────────────────────────

const cache = new Map();   // "<home>\0<id>" -> { pack, at }; pack = { id, manifest, files, dirs }

function clearCache() { cache.clear(); }

function lstatOrNull(p) { try { return fs.lstatSync(p); } catch { return null; } }

/** Slower re-check of a cached pack: every file keeps its size, inode, device, mtime and ctime. (Folders are checked on every call.) */
function filesSame(pack) {
  for (const f of Object.values(pack.files)) {
    const s = lstatOrNull(f.abs);
    if (!s || s.isSymbolicLink() || !sameFile(s, f)) return false;
  }
  return true;
}

/**
 * getPack(id, { home }) -> { id, manifest, files, dirs } | null. Cached. On every call (cached or not) <home>/faces, the
 * pack folder and its sub-folders must still be real folders with their old identity; the files are re-statted after
 * a short interval. Any difference drops the cache entry and the pack is validated again from scratch.
 */
function getPack(id, { home } = {}) {
  if (!home || !validateSlug(id).ok) return null;
  const facesDir = homeFaces(home);
  const dir = path.join(facesDir, id);
  const key = `${path.resolve(home)}\0${id}`;
  const hit = cache.get(key);
  const now = Date.now();
  if (hit) {
    if (dirsIntact(hit.pack.dirs)) {
      if (now - hit.at < CACHE_TTL_MS) return hit.pack;
      if (filesSame(hit.pack)) { hit.at = now; return hit.pack; }
    }
    cache.delete(key);
  }
  const fd = lstatOrNull(facesDir);
  if (!fd || fd.isSymbolicLink() || !fd.isDirectory()) return null;
  const st = lstatOrNull(dir);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return null;
  const v = validatePack(dir);
  if (!v.ok) return null;
  const pack = { id, manifest: v.manifest, files: v.files, dirs: [{ abs: facesDir, ino: fd.ino, dev: fd.dev }, ...v.dirs] };
  if (!dirsIntact(pack.dirs)) return null;   // swapped while validating
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { pack, at: now });
  return pack;
}

/** listPacks({ home }) -> [{ id, manifest }] of the valid installed packs, sorted by id. Invalid ones are left out. */
function listPacks({ home } = {}) {
  if (!home) return [];
  const dir = homeFaces(home);
  const st = lstatOrNull(dir);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names.sort()) {
    if (!validateSlug(n).ok) continue;
    const p = getPack(n, { home });
    if (p) out.push({ id: p.id, manifest: p.manifest });
  }
  return out;
}

module.exports = { validatePack, installPack, removePack, listPacks, getPack, openVerified, validateSlug, deriveSlug, clearCache, LIMITS, STATES };
