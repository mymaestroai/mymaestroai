'use strict';
// Camera pictures and video: stills (with the retry schedule), live stills and clips through the RTSPS helper, recorded
// clips, the 4 x 3 frame sheet, and pruning of everything saved into the media folder.
//
// Everything written into the media folder goes through ctx.store's pinned-descriptor helpers (the notice agent owns that
// folder and may swap any part of it for a link at any moment); this file only decides names, sizes, times and what to
// delete. Media is made first in a private work folder under the data home. Times use settings.time_zone (default UTC).
//
// createMedia(ctx) returns:
//   fetchStill(deviceId, ts, componentId) -> { buf, png } | { error }
//   latestStill(deviceId, minutes) -> { buf, png, takenAt, origin } | { error }
//   liveStill(deviceId) -> { buf, png:false, takenAt, origin:'live' } | { error }
//   saveStill(buf, png, ts, cameraName) -> 'events/<YYYY-MM-DD>/<HHMM>-<slug>[-SS[-k]].<jpg|png>'  (path below the media folder)
//   liveClip(deviceId, seconds) -> { file, mediaTs } | { error }
//   recordedClip(deviceId, start, seconds) -> what ctx.api.clipDownload answers
//   makeClip(deviceId, camName, mode, seconds, start) -> { clip, frames, mediaTs, startsAt, seconds, partial } | { error }
//   runLive(deviceId, kind, seconds)  kind 'still' | 'clip' -> { file } | { error }
//   frameSheet(clip, seconds) -> file | null
//   placeFile(tmp, dayParts, base, ext) -> path below the media folder
//   spaceForLive() -> boolean
//   pruneMedia(parts, nameRe, days, quota, keep) -> number removed   (keep = Set of paths below the media folder, e.g. store.recent.keep())
//   pruneStills(keep) -> number removed, pruneClips(keep) -> number removed, pruneWork() -> number removed
//   stillDays() -> days stills are kept (face records follow it)
//   stopChildren() -> Promise   SIGTERM every live helper process, SIGKILL after 2 s
//   localParts(ts), localDay(ts), localTime(ts), parseWhen(v), zone(), freeBytes(dir), workFile(ext)
//
// module.exports = { createMedia, plus pure helpers: slug, clean, shortId, isImage, realFields, parseWhen(v, zone),
//   localParts(ts, zone), localDay(ts, zone), localTime(ts, zone), validZone, stillNames, constants }.
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const SNAP_DELAYS = [3000, 5000, 10000];
const FREE_SPACE_RESERVE = 2 * 1024 * 1024 * 1024;
const MAX_CLIP = 300 * 1024 * 1024;
const YOUNG_MS = 7 * 3600000;   // the hub may still be delivering a notice that names a file this young
const PULL_SCRIPT = path.join(__dirname, '..', 'rtsp-pull.py');
const RTSP_BASE = 'rtsps://video.rtsp.amazonvision.com:322';
const PYTHON = '/usr/bin/python3';
const FFMPEG = '/usr/bin/ffmpeg';
const STILLS_DIR = 'events', CLIPS_DIR = 'clips';
const STILL_NAME = /^\d{4}-[a-z0-9-]+\.(jpg|png)$/;
const CLIP_NAME = /^\d{4}-[a-z0-9-]+\.(mp4|jpg)$/;
const WORK_NAME = /^[0-9a-f-]+\.(jpg|mp4)$/;
const DAY_NAME = /^\d{4}-\d{2}-\d{2}$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s, max = 80) => { let t = ''; try { t = String(s == null ? '' : s); } catch {} return t.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); };   // {"toString": null} can't be turned into text
const shortId = (s) => (s ? `…${String(s).slice(-6)}` : '-');
const slug = (s) => (String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'camera');
const isImage = (b) => !!b && b.length > 8 && ((b[0] === 0xff && b[1] === 0xd8) || b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));

function validZone(z) {
  if (typeof z !== 'string' || !z) return 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return z; } catch { return 'UTC'; }
}
function localParts(ts, zone = 'UTC') {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-CA', { timeZone: validZone(zone), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ts))) parts[p.type] = p.value;
  return parts;
}
const localDay = (ts, zone) => { const p = localParts(ts, zone); return `${p.year}-${p.month}-${p.day}`; };
const localTime = (ts, zone = 'UTC') => new Intl.DateTimeFormat('en-US', { timeZone: validZone(zone), weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(ts));

// Epoch (s or ms), an ISO time with a zone, or "YYYY-MM-DD HH:MM[:SS]" in the module's time zone. Impossible dates (Nov 31,
// 24:30) and local times skipped by the spring DST change are refused, not rolled over; in the repeated autumn hour a
// local time means the first (daylight-time) one.
function realFields(y, mo, d, h, mi, s) {
  return mo >= 1 && mo <= 12 && d >= 1 && d <= new Date(Date.UTC(y, mo, 0)).getUTCDate() && h <= 23 && mi <= 59 && s <= 59;
}
function parseWhen(v, zone = 'UTC') {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? (v < 1e11 ? v * 1000 : v) : null;
  const s = clean(v, 40);
  if (/^\d{10,13}$/.test(s)) return parseWhen(Number(s), zone);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/i);
  if (m) {
    if (!realFields(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0))) return null;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m || !realFields(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0))) return null;
  const want = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  let t = want;
  for (let i = 0; i < 3; i++) { const p = localParts(t, zone); t += want - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second); }
  const back = (x) => { const p = localParts(x, zone); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second); };
  if (back(t) !== want) return null;   // a time the clocks skipped comes back as another time: refuse it
  for (const d of [3600000, 1800000]) if (back(t - d) === want) return t - d;   // the repeated hour: the first one, east or west of UTC
  return t;
}
// The names tried for one still, in order: <HHMM>-<slug>, then with the seconds, then with a counter (50 names in all).
function stillNames(p, cameraName, png) {
  const ext = png ? 'png' : 'jpg';
  const base = `${p.hour}${p.minute}-${slug(cameraName)}`;
  const names = [`${base}.${ext}`, `${base}-${p.second}.${ext}`];
  for (let k = 2; k <= 50; k++) names.push(`${base}-${p.second}-${k}.${ext}`);
  return names;
}
function writeAll(fd, buf) {
  for (let off = 0; off < buf.length;) {
    const n = fs.writeSync(fd, buf, off, buf.length - off);
    if (n <= 0) throw Object.assign(new Error('short write'), { code: 'EIO' });
    off += n;
  }
}

function createMedia(ctx) {
  const env = ctx.env || process.env;
  const store = ctx.store, api = ctx.api;
  const rawSpawn = ctx.spawn || childProcess.spawn;
  const now = ctx.now || Date.now;
  const log = ctx.log || (() => {});
  const testMode = env.RING_TEST === '1';   // test-only stand-ins are ignored otherwise
  const snapDelays = testMode && env.RING_TEST_SNAPSHOT_DELAYS ? env.RING_TEST_SNAPSHOT_DELAYS.split(',').map(Number).filter(Number.isFinite) : SNAP_DELAYS;
  const ffmpeg = testMode && env.RING_TEST_FFMPEG ? env.RING_TEST_FFMPEG : FFMPEG;
  const liveFile = testMode ? env.RING_TEST_LIVE_FILE || '' : '';
  const workDir = store.workDir;
  // Every child gets a minimal environment, so no secret of this process reaches it. Live children are remembered for stopChildren().
  const childEnv = () => ({ PATH: '/usr/bin:/bin', HOME: store.dataHome || env.CONNECTOR_DATA_HOME || '/tmp', LANG: 'C.UTF-8', TZ: 'UTC' });
  const children = new Set();
  function spawn(cmd, args, opts) {
    const child = rawSpawn(cmd, args, { ...(opts || {}), env: childEnv() });
    if (child && typeof child.on === 'function') {
      children.add(child);
      const gone = () => children.delete(child);
      child.on('close', gone);
      child.on('error', gone);
    }
    return child;
  }
  // SIGTERM to every live child, SIGKILL for those still there after 2 s. Resolves when they are gone or the SIGKILL went out.
  function stopChildren() {
    const list = [...children];
    if (!list.length) return Promise.resolve();
    for (const c of list) { try { c.kill('SIGTERM'); } catch {} }
    return new Promise((resolve) => {
      let poll = null;
      const t = setTimeout(() => { clearInterval(poll); for (const c of list) { if (children.has(c)) { try { c.kill('SIGKILL'); } catch {} } } resolve(); }, 2000);
      poll = setInterval(() => { if (!list.some((c) => children.has(c))) { clearTimeout(t); clearInterval(poll); resolve(); } }, 50);
    });
  }
  const settings = () => { const s = typeof ctx.settings === 'function' ? ctx.settings() : ctx.settings; return s && typeof s === 'object' ? s : {}; };
  const zone = () => validZone(settings().time_zone);
  const quiet = new Map();
  const logEvery = (key, ms, ...a) => { const t = quiet.get(key) || 0; if (now() - t > ms) { quiet.set(key, now()); log(...a); } };
  const lp = (ts) => localParts(ts, zone());
  const freeBytes = (dir) => {
    if (store && typeof store.freeBytes === 'function') return store.freeBytes(dir);
    try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return Infinity; }
  };

  // ── stills ──
  async function fetchStill(deviceId, ts, componentId) {
    let why = 'no image yet';
    for (let i = 0; i < snapDelays.length; i++) {
      await sleep(snapDelays[i]);
      const last = i === snapDelays.length - 1;
      const body = last
        ? { type: 'latest_in_range', start_timestamp: ts - 15000, end_timestamp: now(), image_options: { format: 'jpeg' } }
        : { type: 'at_timestamp', timestamp: Math.min(ts, now()), image_options: { format: 'jpeg' } };
      if (componentId != null) body.components = [{ component_id: String(componentId) }];
      const d = await api.imageDownload(deviceId, body);
      if (d.buf) return { buf: d.buf, png: d.png };
      why = d.why;
      if (d.retryAfter) await sleep(d.retryAfter * 1000);
      if (d.stop) break;
    }
    return { error: why };
  }
  // The newest stored image in the last `minutes` (a tool call; no retries).
  async function latestStill(deviceId, minutes) {
    const d = await api.imageDownload(deviceId, { type: 'latest_in_range', start_timestamp: now() - minutes * 60000, end_timestamp: now(), image_options: { format: 'jpeg' } });
    if (!d.buf) return { error: d.why === 'Ring answered 404' ? `no image from this camera in the last ${minutes} minutes` : d.why };
    const origin = d.origin === 'snapshot' ? 'periodic snapshot' : d.origin === 'recording' ? 'frame from a recording' : 'stored image';
    return { buf: d.buf, png: !!d.png, takenAt: d.mediaTs || now(), origin };
  }
  async function liveStill(deviceId) {
    const lv = await runLive(deviceId, 'still', 0);
    if (lv.error) return { error: lv.error };
    let buf;
    try { buf = fs.readFileSync(lv.file); } catch (e) { return { error: e.code || e.message }; } finally { try { fs.unlinkSync(lv.file); } catch {} }
    if (!isImage(buf)) return { error: 'the live frame was not an image' };
    return { buf, png: false, takenAt: now(), origin: 'live' };
  }
  function saveStill(buf, png, ts, cameraName) {
    const p = lp(ts);
    const day = `${p.year}-${p.month}-${p.day}`;
    const { name } = store.mediaPut({ parts: [STILLS_DIR, day], names: stillNames(p, cameraName, png), buf });   // the disk reserve is checked there
    return `${STILLS_DIR}/${day}/${name}`;
  }

  // ── work folder (private; the media folder only gets finished files) ──
  const workFile = (ext) => store.workFile(ext);
  function spaceForLive() {   // room for the longest live clip (ffmpeg stops at MAX_CLIP) above the reserve
    fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
    return freeBytes(workDir) >= FREE_SPACE_RESERVE + MAX_CLIP;
  }
  // Moves a finished file from the work folder into <media>/dayParts under a fresh name (the store never follows or
  // replaces anything already at that name, and removes the work file once it is placed).
  function placeFile(tmp, dayParts, base, ext) {
    const names = [];
    for (let k = 1; k <= 50; k++) names.push(k > 1 ? `${base}-${k}.${ext}` : `${base}.${ext}`);
    const { name } = store.mediaPut({ parts: dayParts, names, file: tmp, mode: 0o664, removeSource: true });
    return [...dayParts, name].join('/');
  }

  // ── live video ──
  // rtsp-pull.py reads Ring's RTSPS stream (the token goes in on stdin, never in the arguments) and writes MPEG-TS;
  // ffmpeg takes one frame or the first N seconds. The helper stops by itself when ffmpeg closes the pipe (and sends Ring
  // a TEARDOWN).
  function runLive(deviceId, kind, seconds) {
    return new Promise((resolve) => {
      let src = null, ff = null, timer = null, out = null;
      const killAll = () => { for (const p of [src, ff]) { if (p) { try { p.kill('SIGKILL'); } catch {} } } };
      (async () => {
        let token = 'test';
        if (!liveFile) { try { token = await api.accessTokenFor(); } catch (e) { resolve({ error: e.message }); return; } }
        out = workFile(kind === 'still' ? 'jpg' : 'mp4');
        src = liveFile
          ? spawn('/bin/cat', [liveFile], { stdio: ['ignore', 'pipe', 'ignore'] })
          : spawn(PYTHON, ['-I', PULL_SCRIPT, `${RTSP_BASE}/v1/devices/${encodeURIComponent(deviceId)}/stream`, String(kind === 'still' ? 25 : seconds + 20)], { stdio: ['pipe', 'pipe', 'pipe'] });
        src.on('error', () => {});   // a program that can't start reports through 'close' (code -2) as well
        timer = setTimeout(killAll, (kind === 'still' ? 30 : seconds + 35) * 1000);   // armed before anything else can fail
        if (!src.stdout) throw new Error('the live video helper could not start');
        if (src.stdin) { src.stdin.on('error', () => {}); src.stdin.end(`${token}\n`); }
        const args = kind === 'still'
          ? ['-hide_banner', '-loglevel', 'error', '-f', 'mpegts', '-i', 'pipe:0', '-frames:v', '1', '-q:v', '3', '-y', out]
          : ['-hide_banner', '-loglevel', 'error', '-f', 'mpegts', '-i', 'pipe:0', '-t', String(seconds), '-map', '0:v:0', '-c', 'copy', '-map_metadata', '-1', '-movflags', '+faststart', '-fs', String(MAX_CLIP), '-y', out];
        ff = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
        ff.on('error', () => {});
        if (!ff.stdin) throw new Error('ffmpeg could not start');
        ff.stdin.on('error', () => {});
        if (ff.stderr) ff.stderr.on('data', () => {});
        src.stdout.pipe(ff.stdin);
        let srcErr = '', srcCode = null;
        if (src.stderr) src.stderr.on('data', (c) => { if (srcErr.length < 1000) srcErr += c; });
        const srcClosed = new Promise((r) => src.on('close', (c) => { srcCode = c; r(); }));
        ff.on('close', async (code) => {
          clearTimeout(timer);
          src.stdout.unpipe(ff.stdin);
          src.stdout.destroy();   // the helper's next write fails, so it ends the Ring session (TEARDOWN) and exits
          const stopper = setTimeout(() => { try { src.kill('SIGTERM'); } catch {} }, 3000);
          const killer = setTimeout(() => { try { src.kill('SIGKILL'); } catch {} }, 8000);
          srcClosed.then(() => { clearTimeout(stopper); clearTimeout(killer); });
          let size = 0;
          try { size = fs.statSync(out).size; } catch {}
          if (code === 0 && size > 0) { resolve({ file: out }); return; }
          try { fs.unlinkSync(out); } catch {}
          await Promise.race([srcClosed, sleep(4000)]);
          if (srcErr) log('live video:', clean(srcErr, 200));
          resolve({ error: srcCode === 3 ? 'the live stream could not be opened' : srcCode === 4 ? 'the live stream carried no video' : 'no video arrived from the live stream' });
        });
      })().catch((e) => {
        clearTimeout(timer);
        killAll();
        if (out) { try { fs.unlinkSync(out); } catch {} }
        resolve({ error: e.code || e.message });
      });
    });
  }
  async function liveClip(deviceId, seconds) {
    const got = await runLive(deviceId, 'clip', seconds);
    if (got.error) return got;
    return { file: got.file, mediaTs: now() - seconds * 1000 };
  }
  const recordedClip = (deviceId, start, seconds) => api.clipDownload(deviceId, start, seconds);

  function frameSheet(clip, seconds) {   // 12 frames spread over the clip on one 4 x 3 sheet: agents look rather than watch
    return new Promise((resolve) => {
      const out = workFile('jpg');
      const fps = Math.min(10, Math.max(0.02, 12 / Math.max(1, seconds)));
      const ff = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', clip, '-vf', `fps=${fps.toFixed(4)},scale=480:-2,tile=4x3:padding=4:margin=4`, '-frames:v', '1', '-q:v', '4', '-y', out], { stdio: ['ignore', 'ignore', 'ignore'] });
      ff.on('error', () => {});
      const timer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch {} }, 60000);
      ff.on('close', (code) => {
        clearTimeout(timer);
        let ok = false;
        try { ok = code === 0 && fs.statSync(out).size > 0; } catch {}
        if (ok) resolve(out); else { try { fs.unlinkSync(out); } catch {} resolve(null); }
      });
    });
  }
  // A clip (live or recorded) and its frame sheet, placed in <media>/clips/<day>/.
  async function makeClip(deviceId, camName, mode, seconds, start) {
    if (mode === 'live' && !spaceForLive()) return { error: 'the disk is nearly full' };
    const got = mode === 'live' ? await liveClip(deviceId, seconds) : await recordedClip(deviceId, start, seconds);
    if (got.error) return { error: got.error };
    const p = lp(got.mediaTs);
    const dayParts = [CLIPS_DIR, `${p.year}-${p.month}-${p.day}`];
    const base = `${p.hour}${p.minute}-${slug(camName)}-${mode}`;
    const sheet = await frameSheet(got.file, got.lengthMs ? got.lengthMs / 1000 : seconds);
    let clip;
    try { clip = placeFile(got.file, dayParts, base, 'mp4'); } catch (e) {
      try { fs.unlinkSync(got.file); } catch {}
      if (sheet) { try { fs.unlinkSync(sheet); } catch {} }
      return { error: e.code || e.message };
    }
    let frames = null;
    if (sheet) { try { frames = placeFile(sheet, dayParts, `${base}-frames`, 'jpg'); } catch { try { fs.unlinkSync(sheet); } catch {} } }
    return { clip, frames, mediaTs: got.mediaTs, startsAt: localTime(got.mediaTs, zone()), seconds: got.lengthMs ? Math.round(got.lengthMs / 1000) : seconds, partial: !!got.partial };
  }

  // ── pruning ──
  // Keeps a media folder (day folders of files this module named) within days and quota. Never removes a file younger than
  // 7 hours or one named in `keep` (paths below the media folder), never a link, a pipe or a folder; day folders that are
  // links are never entered. Everything goes through the store's pinned helpers; this decides only what goes.
  function pruneMedia(parts, nameRe, days, quota, keep = new Set()) {
    if (!Array.isArray(parts) || !parts.length || parts.some((x) => typeof x !== 'string' || !/^[A-Za-z0-9._-]+$/.test(x) || x === '.' || x === '..')) return 0;
    const what = parts[parts.length - 1];
    let removed = 0;
    let dayNames = [];
    try { dayNames = store.mediaDirs(parts, { max: 2000, re: DAY_NAME }); } catch { return 0; }   // a day folder that is a link is never entered
    const cutoff = localDay(now() - days * 86400000, zone());
    const files = [];
    let budget = 100000;   // entries looked at per pass, all day folders together
    for (const d of dayNames) {
      if (budget <= 0) { logEvery(`budget:${what}`, 3600000, `the ${what} folder holds too many files: pruning looks at ${100000} per pass`); break; }
      const dparts = [...parts, d];
      const max = Math.min(20000, budget);
      let entries = [];
      try { entries = store.mediaList(dparts, { max }); } catch { continue; }
      if (entries.length >= max) logEvery(`full:${what}/${d}`, 3600000, `the ${what}/${d} folder holds more than ${max} entries: only the first are looked at`);
      budget -= entries.length;
      try { store.mediaSweepTemp(dparts, 3600000); } catch {}   // leftovers of an interrupted write
      for (const s of entries) {
        if (!s.isFile || !nameRe.test(s.name) || keep.has([...dparts, s.name].join('/'))) continue;
        const young = now() - s.mtimeMs < YOUNG_MS;
        if (d < cutoff && !young) { if (store.mediaRemove(dparts, s.name)) removed++; } else files.push({ d, f: s.name, size: s.size, t: s.mtimeMs, young });
      }
    }
    let total = files.reduce((n, x) => n + x.size, 0);
    files.sort((a, b) => a.t - b.t);
    for (const x of files) {
      if (total <= quota) break;
      if (x.young) continue;
      if (store.mediaRemove([...parts, x.d], x.f)) { total -= x.size; removed++; }
    }
    for (const d of dayNames) {
      let empty = false;
      try { empty = store.mediaList([...parts, d], { max: 1 }).length === 0; } catch {}
      if (empty) { try { store.mediaRemoveDir([...parts, d]); } catch {} }
    }
    return removed;
  }
  const num = (v, dflt) => (Number(v) > 0 ? Number(v) : dflt);
  const stillDays = () => num(settings().still_days, 30);
  // Stills are kept still_days (default 30) and within still_quota_mb (default 2048).
  function pruneStills(keep) {
    const s = settings();
    const removed = pruneMedia([STILLS_DIR], STILL_NAME, stillDays(), num(s.still_quota_mb, 2048) * 1024 * 1024, keep);
    if (removed) log(`removed ${removed} old still(s)`);
    return removed;
  }
  // Clips and frame sheets are kept clip_days (default 30) within clip_quota_mb (default 4096).
  function pruneClips(keep) {
    const s = settings();
    const removed = pruneMedia([CLIPS_DIR], CLIP_NAME, num(s.clip_days, 30), num(s.clip_quota_mb, 4096) * 1024 * 1024, keep);
    if (removed) log(`removed ${removed} old clip file(s)`);
    return removed;
  }
  // Leftovers in the private work folder (an interrupted run) after an hour.
  function pruneWork() {
    let names = [], removed = 0;
    try { if (fs.lstatSync(workDir).isDirectory()) names = fs.readdirSync(workDir); } catch {}
    for (const n of names) {
      const fp = path.join(workDir, n);
      try { const st = fs.lstatSync(fp); if (st.isFile() && WORK_NAME.test(n) && now() - st.mtimeMs > 3600000) { fs.unlinkSync(fp); removed++; } } catch {}
    }
    return removed;
  }

  return {
    fetchStill, latestStill, liveStill, saveStill, liveClip, recordedClip, makeClip, runLive, frameSheet, placeFile, spaceForLive,
    pruneMedia, pruneStills, pruneClips, pruneWork, stillDays,
    localParts: lp, localDay: (ts) => localDay(ts, zone()), localTime: (ts) => localTime(ts, zone()), parseWhen: (v) => parseWhen(v, zone()),
    zone, freeBytes, workFile, stopChildren,
  };
}

module.exports = {
  createMedia, slug, clean, shortId, isImage, realFields, parseWhen, localParts, localDay, localTime, validZone, stillNames, writeAll,
  SNAP_DELAYS, FREE_SPACE_RESERVE, MAX_CLIP, YOUNG_MS, PULL_SCRIPT, RTSP_BASE, STILLS_DIR, CLIPS_DIR, STILL_NAME, CLIP_NAME,
};
