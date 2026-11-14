'use strict';
// lib/voice/engine.js + manifest.js: pinned manifest, install with a fake fetch (real tiny tar.gz archives built here),
// checksum mismatch, status shape, speed check, unsupported platform. Nothing is downloaded, no engine is started.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const realManifest = require('../lib/voice/manifest');
const { createVoiceEngine } = require('../lib/voice/engine');

const tmps = [];
const mk = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmps.push(d); return d; };
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** Builds a tar.gz holding { 'a/b.txt': 'text' } with the system tar. */
function makeTgz(files) {
  const src = mk('voice-src-'); const out = path.join(mk('voice-out-'), 'a.tgz');
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true }); fs.writeFileSync(path.join(src, rel), text); }
  execFileSync('tar', ['-czf', out, '-C', src, ...fs.readdirSync(src)]);   // names without ./ like the real archives
  return fs.readFileSync(out);
}

/** The real manifest's structure with every URL pointing at a small fake archive; returns { manifest, blobs: url -> Buffer }. */
function fakeWorld() {
  const blobs = new Map();
  const put = (id, buf) => { const url = `https://fake.invalid/${id}`; blobs.set(url, buf); return { url, bytes: buf.length, sha256: sha(buf) }; };
  const NODE_PACKAGES = {};
  for (const [name, d] of Object.entries(realManifest.NODE_PACKAGES)) {
    NODE_PACKAGES[name] = { ...d, ...put(`npm-${name}`, makeTgz({ 'package/package.json': JSON.stringify({ name, version: d.version }), 'package/sherpa-onnx.node': 'bin' })) };
  }
  const MODELS = {};
  for (const [id, d] of Object.entries(realManifest.MODELS)) {
    if (d.format === 'file') { MODELS[id] = { ...d, ...put(id, Buffer.from('onnx ' + id)) }; continue; }
    const files = {};
    for (const f of d.files) files[`${d.top}/${f}${f === 'espeak-ng-data' ? '/voices.txt' : ''}`] = 'x ' + f;
    MODELS[id] = { ...d, ...put(id, makeTgz(files)) };
  }
  const WEB_PACKAGES = {}; const WEB_FILES = {};
  for (const [id, d] of Object.entries(realManifest.WEB_PACKAGES)) {
    const files = {};
    for (const [n, f] of Object.entries(realManifest.WEB_FILES)) if (f.pkg === id) { files[f.member] = 'web ' + n; WEB_FILES[n] = { ...f, sha256: sha(Buffer.from('web ' + n)) }; }
    WEB_PACKAGES[id] = { ...d, ...put(`web-${id}`, makeTgz(files)) };
  }
  return { manifest: { ...realManifest, NODE_PACKAGES, MODELS, WEB_PACKAGES, WEB_FILES }, blobs };
}

function fakeFetch(blobs, { corrupt, oversize, gate, calls = [] } = {}) {
  const f = async (url) => {
    calls.push(url);
    if (gate) await gate;
    let buf = blobs.get(url);
    if (!buf) return { ok: false, status: 404 };
    if (corrupt && url === corrupt) { buf = Buffer.from(buf); buf[0] ^= 0xff; }   // same length, other content
    if (oversize && url === oversize) buf = Buffer.concat([buf, Buffer.from('more than the manifest says')]);
    return new Response(buf, { status: 200 });
  };
  f.calls = calls;
  return f;
}

function engineWith(over = {}) {
  const w = fakeWorld(); const dir = path.join(mk('voice-dir-'), 'voice');
  const fetchImpl = over.fetchImpl || fakeFetch(w.blobs);
  const e = createVoiceEngine({ dir, fetchImpl, manifest: w.manifest, platform: 'linux', arch: 'x64', sys: { cores: () => 8, freemem: () => 8 * 2 ** 30 }, ...over.opts });
  return { e, dir, w, fetchImpl };
}

test('manifest: every download has https URL, byte size and sha256; voices point at real models; files used are extracted', () => {
  const m = realManifest;
  const hex = /^[a-f0-9]{64}$/;
  assert.strictEqual(m.SHERPA_VERSION, '1.13.8');
  for (const d of Object.values(m.NODE_PACKAGES)) { assert.match(d.sha256, hex, d.name); assert.match(d.url, /^https:\/\/registry\.npmjs\.org\//); assert.ok(d.bytes > 0); assert.strictEqual(d.version, '1.13.8'); }
  for (const d of Object.values(m.MODELS)) {
    assert.match(d.sha256, hex, d.id); assert.match(d.url, /^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\//); assert.ok(d.bytes > 0);
    for (const f of Object.values(d.used)) assert.ok(d.files.includes(f), `${d.id} uses ${f} but does not extract it`);
  }
  for (const d of Object.values(m.WEB_PACKAGES)) { assert.match(d.sha256, hex); assert.ok(d.bytes > 0); assert.match(d.integrity, /^sha512-/); }
  assert.deepStrictEqual(Object.keys(m.WEB_FILES).sort(), ['bundle.min.js', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm', 'ort.wasm.min.js', 'silero_vad_v5.onnx', 'vad.worklet.bundle.min.js']);
  for (const f of Object.values(m.WEB_FILES)) { assert.match(f.sha256, hex); assert.ok(m.WEB_PACKAGES[f.pkg]); }
  assert.strictEqual(m.WEB_PACKAGES['vad-web'].version, '0.0.31'); assert.strictEqual(m.WEB_PACKAGES['onnxruntime-web'].version, '1.22.0');
  assert.deepStrictEqual(m.VOICES.map(v => v.id), ['af_heart', 'am_michael', 'bf_emma', 'bm_george', 'alba', 'lessac']);
  for (const v of m.VOICES) assert.ok(m.MODELS[v.model], v.id);
  for (const p of ['linux-x64', 'darwin-arm64', 'darwin-x64']) assert.ok(m.NODE_PACKAGES[m.platformPackage(...p.split('-'))], p);
  assert.strictEqual(m.platformPackage('win32', 'x64'), null);
  assert.strictEqual(m.platformPackage('linux', 'arm64'), null);
});

test('manifest: the sherpa-onnx version and every per-platform hash live in ONE block (SHERPA), everything else is derived from it', () => {
  const m = realManifest;
  assert.strictEqual(m.SHERPA.version, '1.13.8');
  assert.strictEqual(m.SHERPA_VERSION, m.SHERPA.version);
  assert.deepStrictEqual(Object.keys(m.SHERPA.packages).sort(), Object.keys(m.NODE_PACKAGES).sort());
  for (const [name, p] of Object.entries(m.SHERPA.packages)) {
    assert.match(p.sha256, /^[a-f0-9]{64}$/, name); assert.ok(p.bytes > 0, name);
    const d = m.NODE_PACKAGES[name];
    assert.deepStrictEqual([d.name, d.version, d.bytes, d.sha256, d.url], [name, m.SHERPA.version, p.bytes, p.sha256, `https://registry.npmjs.org/${name}/-/${name}-${m.SHERPA.version}.tgz`], name);
    if (p.platform) assert.strictEqual(m.PLATFORM_PACKAGE[p.platform], name);
  }
  assert.deepStrictEqual(Object.keys(m.PLATFORM_PACKAGE).sort(), ['darwin-arm64', 'darwin-x64', 'linux-x64']);
  // nothing else in the file spells out the version or a package hash: a version switch is one edit
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'voice', 'manifest.js'), 'utf8');
  const lines = src.split('\n');
  const from = lines.findIndex(l => l.startsWith('const SHERPA = {')), to = lines.findIndex((l, i) => i > from && l === '};');
  assert.ok(from > 0 && to > from);
  const outside = lines.filter((l, i) => (i < from || i > to) && !l.trim().startsWith('//') && /sherpa-onnx-(node|linux|darwin)|1\.13\.8/.test(l));
  assert.deepStrictEqual(outside, [], 'only the SHERPA block names the version and the packages');
});

test('install: downloads, verifies, extracts, copies the browser files; status goes ready with the exact shape', async () => {
  const { e, dir } = engineWith();
  const s0 = e.status();
  assert.strictEqual(s0.ready, false); assert.strictEqual(s0.installing, false); assert.deepStrictEqual(s0.voices, []);
  const done = await e.install({});
  assert.strictEqual(done.ready, true);
  const s = e.status();
  assert.deepStrictEqual(Object.keys(s).filter(k => !['bytesDone', 'bytesTotal'].includes(k)).sort(), ['enabled', 'error', 'installing', 'platformSupported', 'progress', 'ready', 'step', 'stt', 'tts', 'voices']);
  assert.deepStrictEqual({ ...s, voices: undefined, bytesDone: undefined, bytesTotal: undefined }, { enabled: false, ready: true, installing: false, step: 'ready', progress: 1, error: '', platformSupported: true, stt: { engine: 'local', model: 'small.en' }, tts: { engine: 'local', defaultVoice: 'af_heart' }, voices: undefined, bytesDone: undefined, bytesTotal: undefined });
  assert.deepStrictEqual(s.voices.map(v => [v.id, v.engine, v.accent]), [['af_heart', 'kokoro', 'US'], ['am_michael', 'kokoro', 'US'], ['bf_emma', 'kokoro', 'British'], ['bm_george', 'kokoro', 'British'], ['alba', 'piper', 'Scottish'], ['lessac', 'piper', 'US']]);
  assert.ok(s.voices.every(v => typeof v.label === 'string' && v.label));
  assert.ok(fs.existsSync(path.join(dir, 'node_modules', 'sherpa-onnx-node', 'package.json')));
  assert.ok(fs.existsSync(path.join(dir, 'node_modules', 'sherpa-onnx-linux-x64', 'sherpa-onnx.node')));
  assert.ok(fs.existsSync(path.join(dir, 'models', 'whisper-small.en', 'small.en-encoder.int8.onnx')));
  assert.ok(fs.existsSync(path.join(dir, 'models', 'kokoro-multi-lang-v1_0', 'espeak-ng-data', 'voices.txt')));
  assert.ok(fs.existsSync(path.join(dir, 'models', 'silero-vad', 'silero_vad.onnx')));
  for (const n of Object.keys(realManifest.WEB_FILES)) assert.ok(fs.existsSync(path.join(dir, 'web', n)), n);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'downloads')), [], 'archives are removed after unpacking');
  assert.ok(!fs.readdirSync(path.join(dir, 'node_modules')).some(n => n.endsWith('.tmp')));
});

test('install is idempotent: a second run fetches nothing; two at once share one run; sttModel can be chosen', async () => {
  const w = fakeWorld(); const calls = [];
  let release; const gate = new Promise(r => { release = r; });
  const dir = path.join(mk('voice-dir-'), 'voice');
  const e = createVoiceEngine({ dir, fetchImpl: fakeFetch(w.blobs, { gate, calls }), manifest: w.manifest, platform: 'darwin', arch: 'arm64', sys: { cores: () => 4, freemem: () => 16 * 2 ** 30 } });
  const p1 = e.install({ sttModel: 'tiny.en' }); const p2 = e.install({});
  assert.strictEqual(p1, p2, 'same promise');
  await new Promise(r => setTimeout(r, 20));
  const mid = e.status();
  assert.strictEqual(mid.installing, true); assert.match(mid.step, /Downloading/); assert.ok(mid.bytesTotal > 0); assert.ok(mid.progress >= 0 && mid.progress < 1);
  release();
  await p1;
  assert.ok(calls.some(u => u.includes('sherpa-onnx-darwin-arm64')) && !calls.some(u => u.includes('linux-x64')), 'only this platform package');
  const n = calls.length; assert.ok(n > 0);
  await e.install({});
  assert.strictEqual(calls.length, n, 'nothing downloaded the second time');
  assert.strictEqual(e.status().stt.model, 'tiny.en');
  // asking for the other recogniser later fetches only that model
  await e.install({ sttModel: 'small.en' });
  assert.deepStrictEqual(calls.slice(n), ['https://fake.invalid/whisper-small.en']);
  assert.strictEqual(e.status().stt.model, 'small.en');
});

test('checksum mismatch: the download is deleted, install throws, nothing is marked installed', async () => {
  const w = fakeWorld(); const bad = w.manifest.MODELS['whisper-tiny.en'].url;
  const { e, dir } = engineWith({ fetchImpl: fakeFetch(w.blobs, { corrupt: bad }), opts: { manifest: w.manifest } });
  await assert.rejects(() => e.install({ sttModel: 'tiny.en' }), /checksum mismatch/);
  const s = e.status();
  assert.strictEqual(s.ready, false); assert.strictEqual(s.installing, false); assert.match(s.error, /checksum mismatch/);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'downloads')), [], 'no .part file left');
  assert.ok(!fs.existsSync(path.join(dir, 'models', 'whisper-tiny.en')));
  assert.ok(!fs.existsSync(path.join(dir, '.done', 'model_whisper-tiny.en.json')));
});

test('a failed HTTP status or a broken archive fails cleanly', async () => {
  const w = fakeWorld(); w.blobs.delete(w.manifest.MODELS['piper-en_US-lessac-medium'].url);
  const a = engineWith({ opts: { manifest: w.manifest }, fetchImpl: fakeFetch(w.blobs) });
  await assert.rejects(() => a.e.install({}), /HTTP 404/);
  assert.match(a.e.status().error, /HTTP 404/);
  // an archive that is not a tar: sha matches the manifest but extraction fails
  const w2 = fakeWorld(); const m = w2.manifest.MODELS['whisper-tiny.en']; const junk = Buffer.from('not a tar'); w2.blobs.set(m.url, junk); m.sha256 = sha(junk);
  const b = engineWith({ opts: { manifest: w2.manifest }, fetchImpl: fakeFetch(w2.blobs) });
  await assert.rejects(() => b.e.install({ sttModel: 'tiny.en' }), /extract failed/);
  assert.deepStrictEqual(fs.readdirSync(path.join(b.dir, 'downloads')), []);
});

test('download: more bytes than the manifest size are refused and the partial file is removed', async () => {
  const w = fakeWorld(); const big = w.manifest.MODELS['whisper-tiny.en'].url;
  const { e, dir } = engineWith({ fetchImpl: fakeFetch(w.blobs, { oversize: big }), opts: { manifest: w.manifest } });
  await assert.rejects(() => e.install({ sttModel: 'tiny.en' }), /more data than expected/);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'downloads')), []);
  assert.ok(!fs.existsSync(path.join(dir, 'models', 'whisper-tiny.en')));
});

test('download: a file still coming after the overall deadline is abandoned even if data keeps flowing', async () => {
  const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }); });
  const { e } = engineWith({ fetchImpl, opts: { downloadDeadlineMs: 30 } });
  const keepAlive = setTimeout(() => {}, 5000);   // the engine's own timers are unref'd; a real socket would keep the process up
  try { await assert.rejects(() => e.install({ sttModel: 'tiny.en' }), /took longer than/); } finally { clearTimeout(keepAlive); }
});

test('download: a short write is continued until the whole chunk is on disk', async () => {
  const fsReal = require('node:fs'); const orig = fsReal.writeSync; let short = 0;
  fsReal.writeSync = (fd, buf, off, len, ...rest) => {   // takes at most half of what it is given, like a full pipe or disk can
    if (!Buffer.isBuffer(buf)) return orig(fd, buf, off, len, ...rest);
    const o = typeof off === 'number' ? off : 0; const l = typeof len === 'number' ? len : buf.length - o;
    if (l > 1) { short++; return orig(fd, buf, o, Math.ceil(l / 2)); }
    return orig(fd, buf, o, l);
  };
  try {
    const { e } = engineWith();
    await e.install({ sttModel: 'tiny.en' });
    assert.strictEqual(e.status().ready, true, 'checksums match, so nothing was lost');
    assert.ok(short > 0);
  } finally { fsReal.writeSync = orig; }
});

test('extract: when tar cannot run bzip2 the error says what to install', async () => {
  const spawnTar = async () => ({ status: 2, stderr: 'tar (child): bzip2: Cannot exec: No such file or directory\ntar: Error is not recoverable' });
  const { e } = engineWith({ opts: { spawnTar } });
  await assert.rejects(() => e.install({ sttModel: 'tiny.en' }), (err) => err.message === 'Voice setup needs the bzip2 program on this computer (on Ubuntu: sudo apt install bzip2).');
  assert.match(e.status().error, /apt install bzip2/);
});

test('speedCheck: small.en needs 8+ cores and 2 GB free; Kokoro needs 4+ cores; the choice is recorded', () => {
  const { e, dir } = engineWith();
  const GB = 2 ** 30;
  assert.deepStrictEqual([e.speedCheck({ cores: 16, freeMem: 8 * GB })].map(r => [r.sttModel, r.tts, r.defaultVoice])[0], ['small.en', 'kokoro', 'af_heart']);
  assert.strictEqual(e.speedCheck({ cores: 8, freeMem: 2 * GB }).sttModel, 'small.en', '2 GB exactly is enough');
  assert.strictEqual(e.speedCheck({ cores: 8, freeMem: 1.5 * GB }).sttModel, 'tiny.en');
  assert.strictEqual(e.speedCheck({ cores: 7, freeMem: 32 * GB }).sttModel, 'tiny.en');
  const four = e.speedCheck({ cores: 4, freeMem: 32 * GB }); assert.deepStrictEqual([four.sttModel, four.tts], ['tiny.en', 'kokoro']);
  const two = e.speedCheck({ cores: 2, freeMem: 32 * GB }); assert.deepStrictEqual([two.sttModel, two.tts, two.defaultVoice], ['tiny.en', 'piper', 'lessac']);
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).choice;
  assert.strictEqual(rec.tts, 'piper'); assert.strictEqual(rec.cores, 2); assert.strictEqual(rec.freeMemMb, 32768);
  // without overrides it reads the injected system numbers
  const d = e.speedCheck(); assert.deepStrictEqual([d.cores, d.sttModel], [8, 'small.en']);
});

test('a machine with fewer than 4 cores installs Piper only (no Kokoro download) and is ready with the Piper voices', async () => {
  const w = fakeWorld(); const calls = [];
  const dir = path.join(mk('voice-dir-'), 'voice');
  const e = createVoiceEngine({ dir, fetchImpl: fakeFetch(w.blobs, { calls }), manifest: w.manifest, platform: 'linux', arch: 'x64', sys: { cores: () => 2, freemem: () => 4 * 2 ** 30 } });
  await e.install({});
  assert.ok(!calls.some(u => u.includes('kokoro')));
  const s = e.status();
  assert.strictEqual(s.ready, true); assert.deepStrictEqual(s.voices.map(v => v.id), ['alba', 'lessac']); assert.strictEqual(s.tts.defaultVoice, 'lessac');
});

test('unsupported platforms: platformSupported false, install refuses, status stays not ready', async () => {
  for (const [platform, arch] of [['win32', 'x64'], ['linux', 'arm64'], ['freebsd', 'x64']]) {
    const w = fakeWorld(); const calls = [];
    const e = createVoiceEngine({ dir: path.join(mk('voice-dir-'), 'v'), fetchImpl: fakeFetch(w.blobs, { calls }), manifest: w.manifest, platform, arch });
    assert.strictEqual(e.status().platformSupported, false, `${platform}-${arch}`);
    await assert.rejects(() => e.install({}), /not supported/);
    assert.strictEqual(e.status().ready, false); assert.match(e.status().error, /not supported/); assert.strictEqual(calls.length, 0);
  }
  for (const [platform, arch] of [['linux', 'x64'], ['darwin', 'arm64'], ['darwin', 'x64']]) {
    assert.strictEqual(createVoiceEngine({ dir: mk('voice-dir-'), platform, arch }).status().platformSupported, true, `${platform}-${arch}`);
  }
});

test('uninstall removes the files and the choice; enabled comes from the injected isEnabled', async () => {
  let on = true;
  const { e, dir } = engineWith({ opts: { isEnabled: () => on } });
  await e.install({});
  assert.strictEqual(e.status().enabled, true);
  const s = e.uninstall();
  assert.strictEqual(s.ready, false);
  for (const sub of ['node_modules', 'models', 'web', 'state.json', '.done']) assert.ok(!fs.existsSync(path.join(dir, sub)), sub);
  on = false; assert.strictEqual(e.status().enabled, false);
});

test('a changed pin forces a re-install: the marker remembers the sha256 it was installed from', async () => {
  const { e, w, dir } = engineWith();
  await e.install({});
  const alba = w.manifest.MODELS['piper-en_GB-alba-medium'];
  const e2 = createVoiceEngine({ dir, fetchImpl: fakeFetch(w.blobs), manifest: { ...w.manifest, MODELS: { ...w.manifest.MODELS, 'piper-en_GB-alba-medium': { ...alba, sha256: 'f'.repeat(64) } } }, platform: 'linux', arch: 'x64' });
  assert.strictEqual(e2.status().ready, false);
  assert.strictEqual(e.status().ready, true);
});
