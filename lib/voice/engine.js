'use strict';

// lib/voice/engine.js: installs, describes and removes the local speech engine (sherpa-onnx + models + browser files).
//
// Everything lives under one folder (default <app>/data/voice):
//   node_modules/sherpa-onnx-node, node_modules/sherpa-onnx-<platform>-<arch>   the addon (npm tarballs, no npm install)
//   models/<id>/                                                                speech models
//   web/                                                                        the six files the browser speech detector needs
//   state.json                                                                  the speed-check choice
//   .done/<id>.json                                                             one marker per finished item (sha256 it was installed from)
//   downloads/*.part                                                            in-flight downloads (deleted on mismatch)
// Nothing here loads the addon: that happens in lib/voice/worker.js, in a child process.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const defaultManifest = require('./manifest');

const DEFAULT_DIR = path.join(__dirname, '..', '..', 'data', 'voice');
const MIN_FREE_BYTES_FOR_SMALL = 2 * 1024 * 1024 * 1024;
const STALL_MS = 60000;   // a download that sends nothing for this long is abandoned

function defaultSpawnTar(args) {
  return new Promise((resolve) => {
    let err = '';
    let p;
    try { p = spawn('tar', args, { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { return resolve({ status: 127, stderr: e.message }); }
    p.stderr.on('data', (c) => { if (err.length < 4000) err += c; });
    p.on('error', (e) => resolve({ status: 127, stderr: e.message }));
    p.on('close', (code) => resolve({ status: code, stderr: err }));
  });
}

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }

function createVoiceEngine(opts = {}) {
  const dir = opts.dir || DEFAULT_DIR;
  const fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));
  const now = opts.now || Date.now;
  const log = opts.log || (() => {});
  const spawnTar = opts.spawnTar || defaultSpawnTar;
  const platform = opts.platform || process.platform;
  const arch = opts.arch || process.arch;
  const M = opts.manifest || defaultManifest;
  const sys = Object.assign({ cores: () => os.cpus().length || 1, freemem: () => os.freemem() }, opts.sys || {});
  const isEnabled = opts.isEnabled || (() => false);

  const paths = {
    dir, nodeModules: path.join(dir, 'node_modules'), models: path.join(dir, 'models'), web: path.join(dir, 'web'),
    downloads: path.join(dir, 'downloads'), done: path.join(dir, '.done'), state: path.join(dir, 'state.json'),
    worker: path.join(__dirname, 'worker.js'),
    model: (id) => path.join(dir, 'models', id),
  };

  const platformPkg = M.platformPackage(platform, arch);
  const platformSupported = !!platformPkg;

  const prog = { installing: false, step: '', bytesDone: 0, bytesTotal: 0, error: '' };
  let installPromise = null;

  // ── state ──
  function readState() { try { return JSON.parse(fs.readFileSync(paths.state, 'utf8')) || {}; } catch { return {}; } }
  function writeState(s) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(paths.state, JSON.stringify(s, null, 1)); }

  // ── items: what the install fetches ──
  // item = { id, label, kind: 'npm'|'model'|'web', def, target(s), bytes, sha256 }
  function npmItem(name) { const d = M.NODE_PACKAGES[name]; return { id: `npm:${name}`, label: name === 'sherpa-onnx-node' ? 'speech engine' : 'speech engine (this platform)', kind: 'npm', def: d, bytes: d.bytes, sha256: d.sha256 }; }
  function modelItem(id) { const d = M.MODELS[id]; return { id: `model:${id}`, label: d.label || id, kind: 'model', def: d, bytes: d.bytes, sha256: d.sha256, optional: !!d.optional }; }
  function webItems() { return Object.values(M.WEB_PACKAGES).map(d => ({ id: `web:${d.id}`, label: 'browser speech detector', kind: 'web', def: d, bytes: d.bytes, sha256: d.sha256 })); }

  /** The items a given choice needs. */
  function plan(choice) {
    const items = [npmItem('sherpa-onnx-node')];
    if (platformPkg) items.push(npmItem(platformPkg));
    items.push(modelItem(`whisper-${choice.sttModel}`));
    // Voices: Kokoro tier = Kokoro + both Piper voices; light tier (fewer than 4 cores) = the two Piper voices only.
    if (choice.tts === 'kokoro') items.push(modelItem('kokoro-multi-lang-v1_0'));
    items.push(modelItem('piper-en_GB-alba-medium'), modelItem('piper-en_US-lessac-medium'));
    items.push(...webItems());
    items.push(modelItem('silero-vad'));
    return items;
  }

  function markerFile(item) { return path.join(paths.done, item.id.replace(/[^A-Za-z0-9._-]/g, '_') + '.json'); }
  function isDone(item) {
    try { const m = JSON.parse(fs.readFileSync(markerFile(item), 'utf8')); if (m.sha256 !== item.sha256) return false; } catch { return false; }
    if (item.kind === 'npm') return fs.existsSync(path.join(paths.nodeModules, item.def.name, 'package.json'));
    if (item.kind === 'model') return fs.existsSync(paths.model(item.def.id));
    if (item.kind === 'web') return Object.entries(M.WEB_FILES).filter(([, f]) => f.pkg === item.def.id).every(([n]) => fs.existsSync(path.join(paths.web, n)));
    return false;
  }
  function markDone(item) { fs.mkdirSync(paths.done, { recursive: true }); fs.writeFileSync(markerFile(item), JSON.stringify({ sha256: item.sha256, at: now() })); }

  // ── status ──
  function installedVoices() {
    return M.VOICES.filter(v => { const it = modelItem(v.model); return isDone(it); }).map(v => ({ id: v.id, label: v.label, engine: v.engine, accent: v.accent }));
  }
  function chosen() {
    const st = readState(); const c = st.choice || {};
    return { sttModel: c.sttModel || M.DEFAULT_STT, tts: c.tts || 'kokoro', defaultVoice: c.defaultVoice || M.DEFAULT_VOICE };
  }
  function status() {
    const st = readState();
    const c = chosen();
    let ready = false;
    if (platformSupported && st.choice) ready = plan(c).filter(i => !i.optional).every(isDone);
    const progress = prog.bytesTotal > 0 ? Math.min(1, prog.bytesDone / prog.bytesTotal) : (ready ? 1 : 0);
    return {
      enabled: !!isEnabled(),
      ready,
      installing: prog.installing,
      step: prog.installing ? prog.step : (ready ? 'ready' : ''),
      progress: prog.installing ? progress : (ready ? 1 : 0),
      bytesDone: prog.bytesDone, bytesTotal: prog.bytesTotal,   // extra detail for a progress bar; the keys below are the stable shape
      error: prog.error,
      platformSupported,
      stt: { engine: 'local', model: c.sttModel },
      tts: { engine: 'local', defaultVoice: c.defaultVoice },
      voices: ready ? installedVoices() : [],
    };
  }

  // ── speed check ──
  /** cores >= 8 and free RAM >= 2 GB -> small.en (else tiny.en); cores >= 4 -> Kokoro (else Piper). Recorded in state.json. */
  function speedCheck(over = {}) {
    const cores = Number(over.cores) || sys.cores();
    const freeMem = over.freeMem !== undefined ? Number(over.freeMem) : sys.freemem();
    const sttModel = cores >= 8 && freeMem >= MIN_FREE_BYTES_FOR_SMALL ? 'small.en' : 'tiny.en';
    const tts = cores >= 4 ? 'kokoro' : 'piper';
    const defaultVoice = tts === 'kokoro' ? 'af_heart' : 'lessac';
    const result = { cores, freeMemMb: Math.round(freeMem / 1048576), sttModel, tts, defaultVoice, at: now() };
    const st = readState(); st.choice = result; writeState(st);
    return result;
  }

  // ── download + verify ──
  async function download(item, onBytes) {
    fs.mkdirSync(paths.downloads, { recursive: true });
    const name = (item.def.fileName || path.basename(new URL(item.def.url).pathname)) || 'download';
    const part = path.join(paths.downloads, name + '.part');
    const ac = new AbortController();
    let timer = null;
    const poke = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => ac.abort(), STALL_MS); if (timer.unref) timer.unref(); };
    poke();
    const hash = crypto.createHash('sha256');
    let fd = null;
    try {
      const res = await fetchImpl(item.def.url, { redirect: 'follow', signal: ac.signal });
      if (!res || !res.ok) throw new Error(`download ${item.label}: HTTP ${res ? res.status : 'no response'}`);
      fd = fs.openSync(part, 'w', 0o600);
      const write = (buf) => { hash.update(buf); fs.writeSync(fd, buf); onBytes(buf.length); poke(); };
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        for (;;) { const { done, value } = await reader.read(); if (done) break; write(Buffer.from(value.buffer, value.byteOffset, value.byteLength)); }
      } else if (res.body && typeof res.body[Symbol.asyncIterator] === 'function') {
        for await (const chunk of res.body) write(Buffer.from(chunk));
      } else {
        write(Buffer.from(await res.arrayBuffer()));
      }
      fs.closeSync(fd); fd = null;
      const got = hash.digest('hex');
      if (got !== item.sha256) { rmrf(part); throw new Error(`checksum mismatch for ${item.label}: download discarded`); }
      return part;
    } catch (e) {
      if (fd !== null) { try { fs.closeSync(fd); } catch {} }
      rmrf(part);
      if (e && e.name === 'AbortError') throw new Error(`download ${item.label}: stalled (no data for ${STALL_MS / 1000} s)`);
      throw e;
    } finally { if (timer) clearTimeout(timer); }
  }

  async function untar(archive, destTmp, extra) {
    rmrf(destTmp); fs.mkdirSync(destTmp, { recursive: true });
    const r = await spawnTar(['-xf', archive, '-C', destTmp, ...extra]);
    if (!r || r.status !== 0) { rmrf(destTmp); throw new Error(`extract failed: ${((r && r.stderr) || '').trim() || 'tar exited ' + (r && r.status)}`); }
  }
  function swapIn(tmp, target) { rmrf(target); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.renameSync(tmp, target); }
  function sha256Of(p) { const h = crypto.createHash('sha256'); h.update(fs.readFileSync(p)); return h.digest('hex'); }

  async function installItem(item, onBytes) {
    prog.step = `Downloading ${item.label}`;
    const archive = await download(item, onBytes);
    prog.step = `Unpacking ${item.label}`;
    try {
      if (item.kind === 'npm') {
        const tmp = path.join(paths.nodeModules, `.${item.def.name}.tmp`);
        fs.mkdirSync(paths.nodeModules, { recursive: true });
        await untar(archive, tmp, ['--strip-components=1']);
        swapIn(tmp, path.join(paths.nodeModules, item.def.name));
      } else if (item.kind === 'model') {
        const d = item.def; const target = paths.model(d.id); const tmp = target + '.tmp';
        if (d.format === 'file') {
          rmrf(tmp); fs.mkdirSync(tmp, { recursive: true });
          fs.copyFileSync(archive, path.join(tmp, d.fileName));
        } else {
          await untar(archive, tmp, ['--strip-components=1', ...d.files.map(f => `${d.top}/${f}`)]);
        }
        for (const f of Object.values(d.used || {})) if (!fs.existsSync(path.join(tmp, f))) { rmrf(tmp); throw new Error(`${d.id}: expected file ${f} is missing from the archive`); }
        swapIn(tmp, target);
      } else if (item.kind === 'web') {
        const mine = Object.entries(M.WEB_FILES).filter(([, f]) => f.pkg === item.def.id);
        const tmp = path.join(paths.dir, `.web-${item.def.id}.tmp`);
        await untar(archive, tmp, mine.map(([, f]) => f.member));
        fs.mkdirSync(paths.web, { recursive: true });
        for (const [fname, f] of mine) {
          const src = path.join(tmp, f.member);
          if (!fs.existsSync(src)) { rmrf(tmp); throw new Error(`${fname} is missing from ${item.def.id}`); }
          if (sha256Of(src) !== f.sha256) { rmrf(tmp); throw new Error(`checksum mismatch for ${fname}: discarded`); }
          fs.copyFileSync(src, path.join(paths.web, fname));
        }
        rmrf(tmp);
      }
    } finally { rmrf(archive); }
    markDone(item);
    log(`[voice] installed ${item.id}`);
  }

  async function runInstall(want) {
    const prev = readState().choice;
    const c = prev && prev.sttModel && prev.tts ? prev : speedCheck();   // a recorded choice stands; speedCheck() re-measures on request
    if (want && M.STT_MODELS.includes(want)) { const st = readState(); st.choice.sttModel = want; writeState(st); c.sttModel = want; }
    const todo = plan(c).filter(i => !isDone(i));
    prog.bytesDone = 0; prog.bytesTotal = todo.reduce((n, i) => n + (i.bytes || 0), 0);
    for (const item of todo) await installItem(item, (n) => { prog.bytesDone += n; });
    prog.step = 'ready';
  }

  /** install({ sttModel }): idempotent; a second call while one runs returns the same promise. Errors are kept in status().error. */
  function install({ sttModel } = {}) {
    if (!platformSupported) {
      prog.error = `voice is not supported on ${platform}-${arch}`;
      return Promise.reject(new Error(prog.error));
    }
    if (installPromise) return installPromise;
    prog.installing = true; prog.error = ''; prog.step = 'Starting'; prog.bytesDone = 0; prog.bytesTotal = 0;
    installPromise = runInstall(sttModel).then(
      () => { prog.installing = false; installPromise = null; return status(); },
      (e) => { prog.installing = false; prog.error = e.message; installPromise = null; log(`[voice] install failed: ${e.message}`); throw e; },
    );
    return installPromise;
  }

  /** Removes every downloaded file. The caller stops the worker first. */
  function uninstall() {
    if (prog.installing) throw new Error('an install is running');
    for (const p of [paths.nodeModules, paths.models, paths.web, paths.downloads, paths.done, paths.state]) rmrf(p);
    prog.error = ''; prog.step = ''; prog.bytesDone = 0; prog.bytesTotal = 0;
    return status();
  }

  return { status, install, uninstall, speedCheck, paths, plan, isDone };
}

module.exports = { createVoiceEngine, DEFAULT_DIR };
