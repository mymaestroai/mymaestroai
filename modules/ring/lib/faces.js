'use strict';
// The local face recognizer (face-id, loopback only). Only camera images go to it: the bytes the camera service sent,
// never a file from the media folder, which an agent could have written. What it finds in each still is kept privately
// (fingerprints included, in the data home, never in the media folder) as long as the still, so a later "faces" call can
// name people enrolled since. Agents see names, never fingerprints or crops. Off unless settings.faces is true.
//
// createFaces(ctx) returns:
//   facesBase() -> URL | null          (null = off or not a loopback http address)
//   checkFaces(buf, still, cam, at) -> cleaned faces | null   (null = off or recognizer down; keeps the private record)
//   facesOfStill(still) -> { ok:true, still, faces:publicFaces } | { error }   (the "faces" tool: names as of now)
//   rematch(faces) -> faces (names as of now, throws when the recognizer is down)
//   markSeen(faces, at, still)         (sets f.seen on unknown faces that were seen on earlier visits)
//   faceLine(faces) -> 'Faces: ...' | null
//   publicFaces(faces) -> faces without fingerprints and crops
//   cleanFaces(list), faceRecordPath(still), stillKey(still)
//   pruneFaceRecords(days), dropFaceRecord(rec), forgetStill(still), dropFaceIndex(), loadFaceIndex()
//   ping() -> { configured, reachable, people }   (GET /health, for the health tool)
//   faceDir()
//
// module.exports = { createFaces, plus pure helpers: cleanMatch, cleanFaces, isCrop, publicFaces, faceLine, unitVec,
//   FACE_NAME, constants }.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readJson, writePrivate } = require('./store');

const FACE_TIMEOUT_MS = 8000;
const MAX_REPLY = 2 * 1024 * 1024;
const FACE_NAME = /^[A-Za-z][A-Za-z .'-]{0,39}$/;
const FREE_SPACE_RESERVE = 2 * 1024 * 1024 * 1024;
const DEFAULT_URL = 'http://127.0.0.1:9795';
const STILLS_DIR = 'events';
const SEEN_AT = 0.5, SEEN_DAYS = 30, VISIT_GAP_MS = 30 * 60000, MAX_INDEX = 10000, MAX_INDEX_FILES = 30000, MAX_RECORD_BYTES = 256 * 1024;
const EMBEDDING = /^[A-Za-z0-9+/]{2731}=$/;   // base64 of 512 float32 = 2048 bytes
const DAY_NAME = /^\d{4}-\d{2}-\d{2}$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanMatch(m) {
  if (!m || typeof m !== 'object' || typeof m.name !== 'string' || !FACE_NAME.test(m.name)) return null;
  const out = { name: m.name, level: m.level === 'strong' ? 'strong' : 'possible', similarity: Number.isFinite(m.similarity) ? Math.round(m.similarity * 100) / 100 : null };
  if (typeof m.or === 'string' && FACE_NAME.test(m.or)) out.or = m.or;
  return out;
}
const isCrop = (b64) => typeof b64 === 'string' && b64.length <= 65536 && /^[A-Za-z0-9+/]+={0,2}$/.test(b64) && Buffer.from(b64.slice(0, 8), 'base64').subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
function cleanFaces(list) {   // what the recognizer said, checked field by field
  if (!Array.isArray(list)) return null;
  return list.slice(0, 10).map((f) => {
    const box = Array.isArray(f && f.box) && f.box.length === 4 && f.box.every(Number.isFinite) ? f.box.map(Math.round) : null;
    const quality = ['usable', 'too small', 'turned away', 'unclear'].includes(f && f.quality) ? f.quality : 'unclear';
    const out = { box, size: Number.isFinite(f && f.size) ? Math.round(f.size) : null, quality, match: quality === 'usable' ? cleanMatch(f.match) : null };
    if (quality === 'usable' && typeof f.embedding === 'string' && EMBEDDING.test(f.embedding)) out.embedding = f.embedding;
    if (out.embedding && isCrop(f.crop)) out.crop = f.crop;   // the face for the owner's naming sheet: private, like the fingerprint
    return out;
  });
}
const publicFaces = (faces) => (faces || []).map(({ box, size, quality, match, seen }) => ({ box, size, quality, match, seen }));
function faceLine(faces) {   // one line for a notice, or null when no face was seen
  if (!faces || !faces.length) return null;
  const parts = [];
  for (const f of faces) if (f.match) parts.push(`${f.match.name} (${f.match.level === 'strong' ? 'strong match' : `possible match${f.match.or ? `, or ${f.match.or}` : ''}`})`);
  const unknownFaces = faces.filter((f) => f.quality === 'usable' && !f.match);
  for (const f of unknownFaces) if (f.seen) parts.push(`1 unknown face seen before (${f.seen.visits} earlier visit${f.seen.visits > 1 ? 's' : ''} in the last 30 days, first ${f.seen.first}, last ${f.seen.last})`);
  const unknown = unknownFaces.filter((f) => !f.seen).length;
  const unclear = faces.filter((f) => f.quality !== 'usable').length;
  if (unknown) parts.push(`${unknown} unknown face${unknown > 1 ? 's' : ''}`);
  if (unclear) parts.push(`${unclear} face${unclear > 1 ? 's' : ''} too small, turned away or unclear to recognize`);
  return `Faces: ${parts.join('; ')}. (Names come from the face recognizer, not from the picture.)`;
}
function unitVec(b64) {
  if (typeof b64 !== 'string' || !EMBEDDING.test(b64)) return null;
  const raw = Buffer.from(b64, 'base64');
  const v = new Float32Array(512);
  let n = 0;
  for (let i = 0; i < 512; i++) { const x = raw.readFloatLE(i * 4); if (!Number.isFinite(x)) return null; v[i] = x; n += x * x; }
  n = Math.sqrt(n);
  if (!(n > 0)) return null;
  for (let i = 0; i < 512; i++) v[i] /= n;
  return v;
}
function folderBytes(d) { let n = 0; try { for (const f of fs.readdirSync(d)) { try { n += fs.statSync(path.join(d, f)).size; } catch {} } } catch {} return n; }
function validZone(z) {
  if (typeof z !== 'string' || !z) return 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return z; } catch { return 'UTC'; }
}

function createFaces(ctx) {
  const env = ctx.env || process.env;
  const store = ctx.store;
  const now = ctx.now || Date.now;
  const log = ctx.log || (() => {});
  const testMode = env.RING_TEST === '1';   // test-only stand-ins are ignored otherwise
  const timeoutMs = testMode && Number(env.RING_TEST_FACE_TIMEOUT_MS) > 0 ? Number(env.RING_TEST_FACE_TIMEOUT_MS) : FACE_TIMEOUT_MS;
  const holdMs = testMode ? Number(env.RING_TEST_FACE_INDEX_HOLD_MS) || 0 : 0;   // a slow index load
  const FACES_DIR = path.join(env.CONNECTOR_DATA_HOME || '', 'faces');
  const stillsRoot = path.join(env.CONNECTOR_MEDIA_DIR || '', STILLS_DIR);
  const settings = () => { const s = typeof ctx.settings === 'function' ? ctx.settings() : ctx.settings; return s && typeof s === 'object' ? s : {}; };
  const zone = () => validZone(settings().time_zone);
  const quiet = new Map();
  const logEvery = (key, ms, ...a) => { const t = quiet.get(key) || 0; if (now() - t > ms) { quiet.set(key, now()); log(...a); } };
  const freeBytes = (dir) => {
    if (store && typeof store.freeBytes === 'function') return store.freeBytes(dir);
    try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return Infinity; }
  };
  const lparts = (ts) => {
    const parts = {};
    for (const p of new Intl.DateTimeFormat('en-CA', { timeZone: zone(), year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ts))) parts[p.type] = p.value;
    return parts;
  };
  const localDay = (ts) => { const p = lparts(ts); return `${p.year}-${p.month}-${p.day}`; };
  const localTime = (ts) => new Intl.DateTimeFormat('en-US', { timeZone: zone(), weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(ts));

  function facesBase() {
    const s = settings();
    if (s.faces !== true) return null;   // off unless switched on
    let u;
    try { u = new URL(s.faces_url || DEFAULT_URL); } catch { return null; }
    return u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname) ? u : null;   // images never leave this computer
  }
  function faceRequest(method, pathname, body, contentType, ms = timeoutMs) {
    const base = facesBase();
    if (!base) return Promise.resolve(null);
    return new Promise((resolve) => {
      let timer = null, done = false;
      const finish = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
      const headers = body ? { 'Content-Type': contentType, 'Content-Length': body.length } : {};
      const req = http.request({ host: base.hostname, port: Number(base.port) || 80, path: pathname, method, headers }, (res) => {
        const chunks = [];
        let n = 0;
        res.on('data', (c) => { n += c.length; if (n > MAX_REPLY) { req.destroy(); finish(null); } else chunks.push(c); });
        res.on('end', () => {
          if (res.statusCode !== 200) { logEvery('faces', 3600000, 'the face recognizer answered', res.statusCode); return finish(null); }
          try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(null); }
        });
        res.on('error', () => finish(null));
        res.on('close', () => finish(null));   // closed before the end: no answer
      });
      timer = setTimeout(() => { req.destroy(new Error('timed out')); finish(null); }, ms);   // for the whole exchange, not idle time
      req.on('error', (e) => { logEvery('faces', 3600000, 'the face recognizer is unavailable:', e.code || e.message); finish(null); });
      req.end(body);
    });
  }
  const facePost = (pathname, body, contentType, ms) => faceRequest('POST', pathname, body, contentType, ms);
  async function ping() {
    if (!facesBase()) return { configured: false, reachable: false, people: null };
    const r = await faceRequest('GET', '/health', null, null);
    const people = r && r.ok === true && Number.isInteger(r.people) ? r.people : null;
    return { configured: true, reachable: !!(r && r.ok === true), people };
  }

  // A still's place: 'events/<day>/<name>' (also '<day>/<name>' or an absolute path inside the stills folder) -> its private
  // record under the data home. Anything else is null.
  const RECORD = /^(\d{4}-\d{2}-\d{2})\/(\d{4}-[a-z0-9-]+\.(?:jpg|png))$/;
  function stillParts(still) {
    const s = String(still || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 300);
    const root = path.dirname(stillsRoot);
    const abs = s.startsWith('/') ? s : s.startsWith(`${STILLS_DIR}/`) ? path.join(root, s) : path.join(stillsRoot, s);
    const m = path.relative(stillsRoot, abs).match(RECORD);
    return m ? { day: m[1], name: m[2] } : null;
  }
  const stillKey = (still) => { const p = stillParts(still); return p ? `${STILLS_DIR}/${p.day}/${p.name}` : null; };
  function faceRecordPath(still) {
    const p = stillParts(still);
    return p ? path.join(FACES_DIR, p.day, `${p.name}.json`) : null;
  }

  const faceGen = new Map();   // record path -> the newest check's number, while checks for it are in flight
  let faceSeq = 0;
  function dropFaceRecord(rec) {   // a record and the crops beside it (<still>.json, <still>.<i>.jpg); true if there was one
    let had = false;
    try { fs.unlinkSync(rec); had = true; } catch {}
    const base = rec.slice(0, -'.json'.length);
    for (let i = 0; i < 10; i++) { try { fs.unlinkSync(`${base}.${i}.jpg`); } catch {} }
    return had;
  }
  function keepCrops(rec, faces) {   // each face's crop as a private file beside the record, which only names it
    const dir = path.dirname(rec), base = path.basename(rec, '.json');
    let room = false;
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); room = freeBytes(dir) >= FREE_SPACE_RESERVE; } catch {}
    return faces.map((f, i) => {
      const { crop, ...rest } = f;
      if (!crop || !room) return rest;
      const file = `${base}.${i}.jpg`, tmp = path.join(dir, `.${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
      const bytes = Buffer.from(crop, 'base64');   // its hash goes in the record, so a file swapped in later is never shown
      try { fs.writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, path.join(dir, file)); return { ...rest, crop_file: file, crop_sha256: crypto.createHash('sha256').update(bytes).digest('hex') }; } catch (e) {
        try { fs.unlinkSync(tmp); } catch {}
        logEvery('crops', 3600000, 'could not keep a face crop:', e.code || e.message);
        return rest;
      }
    });
  }

  // Repeat visitors: an unknown face is compared with the unknown faces of earlier visits in the kept records (30 days).
  // Only fingerprints are compared, inside this module; agents get "seen before" with the visits' times, never a name.
  let faceIndex = null, faceIndexLoad = null, faceIndexGen = 0;   // [{ v: Float32Array(512), at, still, named }]
  const pendingIndex = new Map(), forgotten = new Set();   // while the index loads: stills to add, and stills whose faces are gone
  function dropFaceIndex() { faceIndex = null; faceIndexLoad = null; faceIndexGen++; pendingIndex.clear(); forgotten.clear(); }   // the next load reads the records afresh
  function forgetStill(still) {
    pendingIndex.delete(still);
    if (faceIndex) faceIndex = faceIndex.filter((e) => e.still !== still);
    else if (faceIndexLoad) forgotten.add(still);   // only a load in flight may have read the old record
  }
  function indexFaces(faces, at, still) {
    if (!faceIndex || !Number.isFinite(at)) return;
    for (const f of faces || []) {
      if (!f || f.quality !== 'usable' || f.match) continue;   // only faces nobody was named for
      const v = unitVec(f.embedding);
      if (v) faceIndex.push({ v, at, still, named: false });
    }
    if (faceIndex.length > MAX_INDEX + 1000) faceIndex = faceIndex.sort((a, b) => a.at - b.at).slice(-MAX_INDEX);
  }
  function loadFaceIndex() {   // read once, newest records first, a batch at a time so events keep flowing meanwhile
    if (faceIndex) return Promise.resolve(faceIndex);
    if (faceIndexLoad) return faceIndexLoad;
    const gen = faceIndexGen;
    faceIndexLoad = (async () => {
      const list = [];
      const cutoff = now() - SEEN_DAYS * 86400000;
      let days = [], files = 0;
      try { days = fs.readdirSync(FACES_DIR).filter((d) => DAY_NAME.test(d) && d >= localDay(cutoff - 86400000)).sort().reverse(); } catch {}
      outer: for (const d of days) {
        let names = [];
        try { names = fs.readdirSync(path.join(FACES_DIR, d)).filter((n) => n.endsWith('.json')).sort().reverse(); } catch { continue; }
        for (const n of names) {
          if (++files > MAX_INDEX_FILES || list.length >= MAX_INDEX) break outer;
          if (files % 100 === 0) await new Promise((r) => setImmediate(r));
          let rec = null;
          try { const p = path.join(FACES_DIR, d, n); if (fs.statSync(p).size <= MAX_RECORD_BYTES) rec = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
          const at = rec ? Number(rec.at) : NaN;
          if (!rec || !Array.isArray(rec.faces) || !(at >= cutoff)) continue;
          for (const f of cleanFaces(rec.faces) || []) {
            if (f.quality !== 'usable' || f.match) continue;
            const v = unitVec(f.embedding);
            if (v) list.push({ v, at, still: rec.still, named: false });
          }
        }
      }
      if (holdMs) await sleep(holdMs);
      if (gen !== faceIndexGen) return [];   // abandoned: what it read may be gone, so nobody uses it
      const merged = list.filter((e) => !forgotten.has(e.still) && !pendingIndex.has(e.still));   // what changed while it loaded wins
      faceIndex = merged;
      for (const [st, p] of pendingIndex) indexFaces(p.faces, p.at, st);
      pendingIndex.clear();
      forgotten.clear();
      faceIndex = faceIndex.sort((a, b) => a.at - b.at).slice(-MAX_INDEX);
      faceIndexLoad = null;
      return faceIndex;
    })().catch((e) => { if (gen === faceIndexGen) faceIndexLoad = null; log('face index failed:', e.message); return []; });
    return faceIndexLoad;
  }
  async function markSeen(faces, at, still) {   // f.seen on each unknown face that looks like an unknown face of earlier visits
    if (settings().faces_seen === false || !Number.isFinite(at)) return;
    const todo = [];
    for (const f of faces || []) {
      if (!f || f.quality !== 'usable' || f.match) continue;
      const v = unitVec(f.embedding);
      if (v) todo.push({ f, v, hits: [] });
    }
    if (!todo.length) return;
    const earliest = at - SEEN_DAYS * 86400000;
    for (const e of await loadFaceIndex()) {
      if (e.named || e.still === still || e.at > at || e.at < earliest) continue;
      for (const t of todo) {
        let sim = 0;
        for (let i = 0; i < 512; i++) sim += t.v[i] * e.v[i];
        if (sim >= SEEN_AT) t.hits.push(e);
      }
    }
    for (const t of todo) {   // sightings less than 30 minutes apart are one visit; the newest run holds this face and doesn't count
      const runs = [];
      for (const x of t.hits.map((e) => ({ at: e.at, e })).concat({ at, e: null }).sort((a, b) => a.at - b.at)) {
        const last = runs[runs.length - 1];
        if (last && x.at - last.last <= VISIT_GAP_MS) { last.last = x.at; if (x.e) last.rep = x.e; } else runs.push({ first: x.at, last: x.at, rep: x.e });
      }
      runs.pop();
      t.runs = runs;
    }
    // only visits the recognizer confirms are still unknown count (someone named since isn't a stranger): one sighting
    // per visit is asked about, newest visits first; whatever can't be asked about isn't claimed
    const ask = [...new Set(todo.flatMap((t) => t.runs.map((r) => r.rep)))].sort((a, b) => b.at - a.at).slice(0, 100);
    const unknown = new Set(), until = Date.now() + 3000;   // one deadline for all of it: a notice is never held long
    for (let k = 0; k < ask.length && Date.now() < until; k += 20) {
      const part = ask.slice(k, k + 20);
      const r = await facePost('/match', Buffer.from(JSON.stringify({ embeddings: part.map((e) => Buffer.from(e.v.buffer, e.v.byteOffset, 2048).toString('base64')) })), 'application/json', Math.max(1, until - Date.now()));
      if (!r || !Array.isArray(r.matches) || r.matches.length !== part.length) break;
      part.forEach((e, i) => { if (cleanMatch(r.matches[i])) e.named = true; else if (r.matches[i] === null) unknown.add(e); });
    }
    for (const t of todo) {
      const runs = t.runs.filter((r) => unknown.has(r.rep));
      if (runs.length) t.f.seen = { visits: runs.length, first: localTime(runs[0].first), last: localTime(runs[runs.length - 1].last) };
    }
  }

  async function checkFaces(buf, stillPath, cam, at = now()) {   // the still's bytes as the camera service sent them; null when the recognizer is off or down
    const still = stillKey(stillPath);
    const rec = faceRecordPath(stillPath);
    const gen = ++faceSeq;
    if (rec) {   // a still name used again never keeps an earlier still's faces, on disk or in the index
      faceGen.set(rec, gen);
      dropFaceRecord(rec);
      forgetStill(still);
    }
    try {
      if (!facesBase()) return null;
      const r = await facePost('/analyze', buf, 'application/octet-stream');
      const faces = r && cleanFaces(r.faces);
      if (!faces) return null;
      const seenOn = settings().faces_seen !== false;
      const loaded = seenOn && await Promise.race([loadFaceIndex().then(() => true), sleep(2000).then(() => false)]);   // a notice never waits long for it
      if (rec && faceGen.get(rec) !== gen) return faces;   // a newer still took this name: these faces are neither kept nor counted
      if (rec) {
        const where = cam ? { camera: String(cam.name || '').slice(0, 60), house: String(cam.house || '').slice(0, 40) } : {};
        try { writePrivate(rec, JSON.stringify({ still, at, ...where, faces: keepCrops(rec, faces) }) + '\n'); } catch (e) { log('could not keep a face record:', e.code || e.message); }
      }
      if (!seenOn) { if (faceIndex || faceIndexLoad) dropFaceIndex(); return faces; }   // switched back on, it reads all records afresh
      if (!loaded || !faceIndex) { pendingIndex.set(still, { faces, at }); return faces; }   // the index joins these when it is ready
      const g = faceIndexGen;
      await markSeen(faces, at, still);
      if (rec && faceGen.get(rec) !== gen) return faces;
      if (faceIndexGen !== g) { if (!faceIndex) pendingIndex.set(still, { faces, at }); }   // an index loaded since read this still from disk
      else if (faceIndex) indexFaces(faces, at, still);   // after the lookup: a face is never its own earlier visit
      else pendingIndex.set(still, { faces, at });
      return faces;
    } finally {
      if (rec && faceGen.get(rec) === gen) faceGen.delete(rec);
    }
  }
  async function rematch(faces) {   // names as of now, for faces found earlier
    const usable = faces.filter((f) => f.quality === 'usable' && f.embedding);
    if (!usable.length) return faces;
    const r = await facePost('/match', Buffer.from(JSON.stringify({ embeddings: usable.map((f) => f.embedding) })), 'application/json');
    if (!r || !Array.isArray(r.matches) || r.matches.length !== usable.length) throw new Error('the face recognizer is unavailable');
    usable.forEach((f, i) => { f.match = cleanMatch(r.matches[i]); });
    return faces;
  }
  // The "faces" tool: the kept check of one still, named as of now, from the private record and never from the file in
  // the media folder (an agent could have changed it).
  async function facesOfStill(stillPath) {
    const rec = faceRecordPath(stillPath);
    if (!rec) return { error: 'still must be the path of a camera still, such as events/2026-11-03/0617-front-door.jpg' };
    const r = readJson(rec, null);
    if (!r || !Array.isArray(r.faces)) return { error: 'no face check is kept for that still (only camera stills taken since face recognition started, for 30 days)' };
    try {
      const faces = await rematch(cleanFaces(r.faces));
      await markSeen(faces, Number(r.at), r.still);
      return { ok: true, still: stillKey(stillPath), faces: publicFaces(faces) };
    } catch (e) { return { error: e.message }; }
  }
  function pruneFaceRecords(days) {   // private folder: plain paths are fine here. Age first, then a size quota (oldest days first)
    const cutoff = localDay(now() - days * 86400000);
    let dirs = [];
    try { dirs = fs.readdirSync(FACES_DIR).filter((d) => DAY_NAME.test(d)).sort(); } catch { return 0; }
    const s = settings();
    const quota = (Number(s.faces_quota_mb) > 0 ? Number(s.faces_quota_mb) : 1024) * 1024 * 1024;
    const kept = dirs.filter((d) => d >= cutoff), drop = dirs.filter((d) => d < cutoff);
    const sizes = kept.map((d) => folderBytes(path.join(FACES_DIR, d)));
    let total = sizes.reduce((a, b) => a + b, 0);
    for (let i = 0; i < kept.length - 1 && total > quota; i++) { drop.push(kept[i]); total -= sizes[i]; }   // never the newest day
    for (const d of drop) { try { fs.rmSync(path.join(FACES_DIR, d), { recursive: true, force: true }); } catch {} }
    if (drop.length) { log(`removed face records for ${drop.length} day(s)`); dropFaceIndex(); }
    return drop.length;
  }

  return {
    facesBase, checkFaces, facesOfStill, rematch, markSeen, faceLine, publicFaces, cleanFaces, faceRecordPath, stillKey,
    pruneFaceRecords, dropFaceRecord, forgetStill, dropFaceIndex, loadFaceIndex, ping, faceDir: () => FACES_DIR,
  };
}

module.exports = {
  createFaces, cleanMatch, cleanFaces, isCrop, publicFaces, faceLine, unitVec, folderBytes,
  FACE_NAME, FACE_TIMEOUT_MS, MAX_REPLY, SEEN_AT, SEEN_DAYS, VISIT_GAP_MS, MAX_INDEX, MAX_INDEX_FILES, MAX_RECORD_BYTES, DEFAULT_URL,
};
