'use strict';
// Voice review round 1 fixes: escaped mic title, verifyPending, voice_off stop, Voice sheet OFF first, real install boundary
// guarded under tests, resumeIfNeeded admission, hint seen-key only on open, no hint while the page is hidden.
// Nothing is downloaded and no engine is started.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const realManifest = require('../lib/voice/manifest');
const { createVoiceEngine } = require('../lib/voice/engine');
const routes = require('../lib/voice/routes');
const mob = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

const tmps = [];
const mk = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmps.push(d); return d; };
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const between = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, a + ' .. ' + b); return src.slice(i, j); };
const fnSrc = (src, name) => {
  const i = src.search(new RegExp('(async )?function ' + name + '\\('));
  assert.ok(i >= 0, name);
  let depth = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}') { depth--; if (!depth) break; } }
  return src.slice(i, j + 1);
};

// ── engine world: the real manifest's structure with small fake archives ──
function makeTgz(files) {
  const src = mk('voice-src-'); const out = path.join(mk('voice-out-'), 'a.tgz');
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true }); fs.writeFileSync(path.join(src, rel), text); }
  execFileSync('tar', ['-czf', out, '-C', src, ...fs.readdirSync(src)]);
  return fs.readFileSync(out);
}
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
/** A fetch over the fake blobs; failUrl: a URL that fails; onCall(url, n): a hook before each answer. */
function fakeFetch(blobs, { failUrl, failWhen, onCall } = {}) {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    if (onCall) onCall(url, calls.length);
    if ((failUrl && url === failUrl) || (failWhen && failWhen(url))) throw new Error('fetch failed');
    const buf = blobs.get(url);
    if (!buf) return { ok: false, status: 404 };
    return new Response(buf, { status: 200 });
  };
  f.calls = calls;
  return f;
}
function engineWith(over = {}) {
  const w = fakeWorld(); const dir = path.join(mk('voice-dir-'), 'voice');
  const fetchImpl = typeof over.fetch === 'function' ? over.fetch(w) : fakeFetch(w.blobs);
  const e = createVoiceEngine({ dir, fetchImpl, manifest: w.manifest, platform: 'linux', arch: 'x64', sys: { cores: () => 8, freemem: () => 8 * 2 ** 30 }, ...over.opts });
  return { e, w, fetchImpl };
}

// ── 2. verifyPending ──
test('an optional download failure preserves verified voice and requests a retry', async () => {
  let checks = 0; let failOn = true;
  const { e, w } = engineWith({
    opts: { isEnabled: () => true, check: async () => { checks++; } },
    fetch: (world) => fakeFetch(world.blobs, { failWhen: (url) => failOn && url === world.manifest.MODELS['silero-vad'].url }),
  });
  await assert.rejects(e.install());
  assert.strictEqual(checks, 1);
  assert.strictEqual(e.status().ready, true);
  assert.strictEqual(e.status().optionalRetry, true);
  failOn = false;
  await e.install();
  assert.strictEqual(e.status().optionalRetry, false);
  assert.strictEqual(checks, 1);
  assert.strictEqual(e.status().ready, true);
  assert.strictEqual(w.manifest.MODELS['silero-vad'].optional, true);
});

test('2. an install complete at start is ready at once: no flag, no check', async () => {
  let checks = 0;
  const { e } = engineWith({ opts: { isEnabled: () => true, check: async () => { checks++; } } });
  await e.install();   // downloads everything and checks once
  assert.strictEqual(checks, 1); assert.strictEqual(e.status().ready, true);
  await e.install();   // nothing to download now
  assert.strictEqual(checks, 1); assert.strictEqual(e.status().ready, true);
});

// ── 3. voice turned off mid-install ──
test('3. voice turned off between items: the install stops with code voice_off, keeps no error, downloads nothing more', async () => {
  // Fails on ebb3500a: the old runInstall never looked at isEnabled and kept downloading every remaining item.
  let on = true;
  const { e, fetchImpl } = engineWith({
    opts: { isEnabled: () => on, check: async () => {} },
    fetch: (world) => fakeFetch(world.blobs, { onCall: (url, n) => { if (n === 1) on = false; } }),
  });
  await assert.rejects(e.install(), (err) => err.code === 'voice_off' && err.message === 'voice was turned off');
  assert.strictEqual(fetchImpl.calls.length, 1, 'the item in flight finished, nothing else was started');
  const s = e.status();
  assert.strictEqual(s.error, ''); assert.strictEqual(s.failReason, null); assert.strictEqual(s.enabled, false); assert.strictEqual(s.installing, false);
});

test('3. voice turned off before the working check: no check runs, voice is not ready, the error stays empty', async () => {
  let on = true; let checks = 0;
  const { e } = engineWith({
    opts: { isEnabled: () => on, check: async () => { checks++; } },
    fetch: (world) => fakeFetch(world.blobs, { onCall: (url) => { if (url === world.manifest.MODELS['silero-vad'].url) on = false; } }),
  });
  await assert.rejects(e.install(), (err) => err.code === 'voice_off');
  assert.strictEqual(checks, 0);
  assert.strictEqual(e.status().ready, false); assert.strictEqual(e.status().error, '');
});

test('3. routes: a turned-off install is not retried (startInstall leaves no timer when voice is off)', async () => {
  routes.resetEnsureForTests();
  const timers = [];
  const eng = { status: () => ({ ready: false, installing: false, error: '', platformSupported: true }), install: () => { const e = new Error('voice was turned off'); e.code = 'voice_off'; return Promise.reject(e); } };
  const ctx = { engine: eng, getSetting: () => ({ enabled: false }), setTimer: (fn, ms) => { timers.push(ms); return 1; }, clearTimer() {} };
  routes.ensureEngines({ ...ctx, getSetting: () => undefined, force: true });   // voice on by default: starts, the install says voice_off, status has no error
  await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(timers, [], 'no retry for a turned-off install');
  routes.resetEnsureForTests();
});

// ── 5. the real install boundary ──
test('5. the real getVoice() engine refuses install() under the test variables: no network, nothing written in data/voice', async () => {
  // Fails on ebb3500a: getVoice().engine.install() was the real installer (it would fetch and write data/voice); not run there.
  // A throwaway install (the suite's data guard: no test reads the real data/): its lib/ computes data/voice and settings inside it.
  const { makeIsolatedInstall } = require('./helpers/isolated-install');
  const iso = makeIsolatedInstall('voice-r1-boundary-');
  after(() => { try { fs.rmSync(iso.root, { recursive: true, force: true }); } catch { /* temp */ } });
  const isoRoutes = require(path.join(iso.inst, 'lib', 'voice', 'routes'));
  const dataVoice = path.join(iso.data, 'voice');
  const before = fs.existsSync(dataVoice) ? fs.readdirSync(dataVoice).sort() : null;
  const realFetch = global.fetch; let fetched = 0;
  global.fetch = (...a) => { fetched++; return Promise.reject(new Error('no network in tests')); };
  try {
    assert.ok(process.env.NODE_TEST_CONTEXT || process.env.MM_TEST_NO_REAL_CLAUDE === '1' || process.env.MM_VOICE_NO_AUTO_INSTALL === '1');
    const v = isoRoutes.getVoice();
    await assert.rejects(v.engine.install(), (e) => e.code === 'test_refused' && e.message === 'voice install refused under tests');
    await assert.rejects(v.engine.install({ sttModel: 'tiny.en' }), (e) => e.code === 'test_refused');
    assert.strictEqual(typeof v.engine.status, 'function');
  } finally { global.fetch = realFetch; }
  assert.strictEqual(fetched, 0);
  const after2 = fs.existsSync(dataVoice) ? fs.readdirSync(dataVoice).sort() : null;
  assert.deepStrictEqual(after2, before);
});

// ── 6. resumeIfNeeded admission ──
test('6. resumeIfNeeded does nothing on an unsupported platform and while a retry timer is pending', async () => {
  // Fails on ebb3500a: both cases called engine.install().
  routes.resetEnsureForTests();
  const installs = [];
  const mkEng = (platformSupported) => ({ status: () => ({ ready: false, installing: false, error: '', platformSupported }), install: (o) => { installs.push(o); return Promise.resolve(); } });
  const getSetting = () => undefined;   // voice is on by default
  assert.strictEqual(routes.resumeIfNeeded({ getSetting, getVoice: () => ({ engine: mkEng(false) }) }), false);
  assert.strictEqual(installs.length, 0, 'unsupported platform');
  // a pending retry timer (set through a failed ensureEngines with a test timer)
  const timers = [];
  const failing = { status: () => ({ ready: false, installing: false, error: 'fetch failed', platformSupported: true }), install: () => Promise.reject(new Error('fetch failed')) };
  routes.ensureEngines({ engine: failing, getSetting, force: true, setTimer: (fn, ms) => { timers.push(ms); return 7; }, clearTimer() {} });
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(timers.length, 1, 'a retry timer is pending');
  assert.strictEqual(routes.resumeIfNeeded({ getSetting, getVoice: () => ({ engine: mkEng(true) }) }), false);
  assert.strictEqual(installs.length, 0, 'retry timer pending');
  routes.resetEnsureForTests();
  assert.strictEqual(routes.resumeIfNeeded({ getSetting, getVoice: () => ({ engine: mkEng(true) }) }), true, 'no timer, supported: it resumes as before');
  assert.strictEqual(installs.length, 1);
  routes.resetEnsureForTests();
});

// ── 1. escaped names ──
test('1. desktop: the mic title is escaped in the composer template (an agent name with a quote cannot break the markup)', () => {
  // Fails on ebb3500a: the template had title="${voiceMicIdleTitle(chatId)}" unescaped.
  assert.ok(!/title="\$\{voiceMicIdleTitle\(/.test(app), 'no unescaped title attribute');
  assert.ok(/title="\$\{hubEsc\(voiceMicIdleTitle\(chatId\)\)\}"/.test(app));
  const hubEsc = new Function('return ' + app.match(/const hubEsc = (\(s\) => [^\n]+)/)[1])();
  const name = 'Bob" onmouseover="x';
  const markup = `<button title="${hubEsc(`Talk to ${name}: tap to talk`)}"></button>`;
  assert.strictEqual((markup.match(/"/g) || []).length, 2, 'only the two attribute quotes remain');
  // every other place the voice code puts the agent or admin name into HTML is escaped (or is textContent)
  assert.ok(/vp-admin-note">Voice for everyone on this Maestro is looked after by \$\{hubEsc\(voiceAdminName\(\)\)\}/.test(app));
  const lines = app.split('\n').filter((l) => /voiceAdminName\(\)|voiceAgentName\(|st\.adminName|voiceMicIdleTitle\(/.test(l) && /innerHTML|`<|="\$\{/.test(l));
  for (const l of lines) assert.ok(/hubEsc\(/.test(l), 'unescaped: ' + l.trim().slice(0, 120));
});

// ── 4. phone Voice sheet: OFF first ──
const paintSrc = between(mob, 'function paintVoiceSheet() {', 'function openVoiceSheet() {');
function sheet(status, me = { user: { id: 'u' }, isAdmin: true }) {
  const el = () => new Proxy({ hidden: false, textContent: '', value: '', checked: false, disabled: false, classList: { toggle() {}, contains: () => true, add() {}, remove() {} } }, { get: (t, k) => (k in t ? t[k] : undefined), set: (t, k, v) => { t[k] = v; return true; } });
  const els = {}; for (const s of ['.vs-note', '.vs-enable', '.vs-enable-text', '.vs-enable-btn', '.vs-progress', '.vs-progress-line']) els[s] = el();
  const other = el();
  const sh = { classList: { contains: () => true }, querySelector: (s) => els[s] || other, querySelectorAll: () => [] };
  const f = new Function('$', 'voicePrefsNow', 'voiceEndPauseNow', 'voiceSpeedNow', 'voiceSpeedLabel', 'document', 'CallDisplay', 'voiceOn', 'hubMe', 'VOICE_CALL_HELP', 'voiceLoudnessFor', 'api', 'toast', 'voiceStatusRefresh', 'setTimeout', 'clearTimeout', 'status',
    'let voiceStatus = status;\n' + paintSrc + '\nreturn { paintVoiceSheet };');
  const t = f((id) => (id === 'voice-sheet' ? sh : null), () => ({ micLevel: 50, interruptSensitivity: 50, mode: 'tap', echoHold: 600 }), () => 1200, () => 1, () => '1x', { activeElement: null }, undefined,
    () => !!(status.enabled && status.ready), me, '', () => 'louder', async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }), () => {}, async () => {}, () => 1, () => {}, status);
  return { els, ...t };
}
test('4. phone Voice sheet: voice off wins over failed and installing; an admin sees "Enable voice", never "Retry now"', () => {
  // Fails on ebb3500a: failed came first, so an off voice with a leftover error showed "Retry now".
  for (const extra of [{ failed: true, failReason: 'network', error: 'fetch failed' }, { installing: true, progress: 0.3 }, {}]) {
    const a = sheet({ enabled: false, ready: false, platformSupported: true, ...extra }); a.paintVoiceSheet();
    assert.strictEqual(a.els['.vs-note'].textContent, 'Voice is off.', JSON.stringify(extra));
    assert.strictEqual(a.els['.vs-enable-btn'].textContent, 'Enable voice');
    assert.strictEqual(a.els['.vs-enable-btn'].hidden, false);
    assert.strictEqual(a.els['.vs-progress'].hidden, true);
    const m = sheet({ enabled: false, ready: false, platformSupported: true, adminName: 'Pat', ...extra }, { user: { id: 'm' }, isAdmin: false }); m.paintVoiceSheet();
    assert.match(m.els['.vs-note'].textContent, /^Voice is off\. Pat can turn it on/);
  }
  const f = sheet({ enabled: true, ready: false, failed: true, failReason: 'network', error: 'x', platformSupported: true }); f.paintVoiceSheet();
  assert.strictEqual(f.els['.vs-enable-btn'].textContent, 'Retry now', 'a voice that is on and failed still offers Retry now');
});

// ── 7 + 8. phone hint ──
const pollAndHint = between(mob, '// ── The microphone appears only when voice is ready', '// ── end one-time voice hint ──');
function page({ me = { user: { id: 'u1' }, isAdmin: true } } = {}) {
  const store = new Map();
  const timers = []; let tid = 0;
  const mkBtn = (id) => ({ id, hidden: true, classList: { toggle() {}, add() {}, remove() {}, contains: () => false }, getBoundingClientRect: () => ({ left: 300, width: 40 }), setAttribute() {}, removeAttribute() {} });
  const mic = mkBtn('mic-btn'), call = mkBtn('simple-call-btn');
  const appended = [];
  const row = { offsetTop: 10 };
  const composer = { clientHeight: 60, querySelector: (s) => (s === '.row' ? row : null), appendChild: (el) => { appended.push(el); } };
  const mkEl = (tag) => { const e = { tag, children: [], style: { setProperty() {} }, dataset: {}, attrs: {}, listeners: {}, className: '', id: '', textContent: '',
    setAttribute(k, v) { e.attrs[k] = v; }, addEventListener(t, f) { e.listeners[t] = f; }, append(...c) { e.children.push(...c); }, remove() { e.removed = true; },
    getBoundingClientRect: () => ({ left: 100, width: 250 }) }; Object.defineProperty(e, 'clientWidth', { value: 250 }); return e; };
  const ctx = {
    console, Number, Math, String, Map, Promise, JSON, Date,
    setTimeout: (fn, ms) => { timers.push({ id: ++tid, fn, ms, live: true }); return tid; },
    clearTimeout: (id) => { const t = timers.find((x) => x.id === id); if (t) t.live = false; },
    document: { hidden: false, createElement: mkEl }, window: { addEventListener() {} },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    $: (id) => (id === 'mic-btn' ? mic : id === 'simple-call-btn' ? call : id === 'composer' ? composer : null),
    simpleOn: () => false,
    api: async () => ({ ok: true, json: async () => ctx.nextStatus }),
    voiceLocalProbe() {}, voiceSpeakPaint() {}, paintVoiceSheet() {}, voiceCallHangUp() {}, voiceMicCancel() {}, toast() {}, voiceStripPaint() {},
    voiceMicPaint() { ctx.voiceHintSync(); },
  };
  vm.createContext(ctx);
  vm.runInContext('var voiceStatus = null, screen = "chat", current = "maestro", voiceCall = null, voiceRec = { state: "idle" }, questionBoxes = new Map(), hubMe = null;', ctx);
  ctx.hubMe = me;
  vm.runInContext(fnSrc(mob, 'voiceOn') + '\n' + pollAndHint + '\n' + fnSrc(mob, 'voiceStatusRefresh'), ctx);
  const set = async (st) => { ctx.nextStatus = st; await ctx.voiceStatusRefresh(); };
  return { ctx, mic, timers, store, appended, set, live: (ms) => timers.filter((t) => t.live && (ms === undefined || t.ms === ms)), fire: (t) => { t.live = false; t.fn(); } };
}
const READY = { enabled: true, ready: true, platformSupported: true };

test('7. phone hint: once showing (key set) it stays through ordinary repaints; close, mic use, chat switch, call, a question, mic not ready still take it away', async () => {
  // Fails on ebb3500a: showing the hint set the seen key, and the next voiceHintSync() found it "seen" and took it down at once.
  const p = page(); p.mic.hidden = false;
  await p.set(READY);
  p.fire(p.live(1500)[0]);
  assert.strictEqual(p.appended.length, 1); assert.ok(!p.appended[0].removed);
  assert.strictEqual(p.store.get('mm-voice-hint:u1'), '1');
  p.ctx.voiceHintSync(); p.ctx.voiceHintSync();
  assert.ok(!p.appended[0].removed, 'a repaint leaves the showing hint alone');
  p.ctx.current = 'other'; p.ctx.voiceHintSync();
  assert.ok(p.appended[0].removed, 'a chat switch takes it away');
  // seen: it never opens again
  p.ctx.current = 'maestro'; p.ctx.voiceHintSync();
  assert.strictEqual(p.live(1500).length, 0, 'a seen hint is not opened again');
  // other removals
  for (const [name, change] of [['call', (c) => { c.voiceCall = {}; }], ['question', (c) => { vm.runInContext('questionBoxes.set("q", 1)', c); }], ['not ready', (c) => { c.voiceStatus = { enabled: true, ready: false, platformSupported: true }; }]]) {
    const q = page(); q.mic.hidden = false; await q.set(READY); q.fire(q.live(1500)[0]);
    change(q.ctx); q.ctx.voiceHintSync();
    assert.ok(q.appended[0].removed, name);
  }
  const d = page(); d.mic.hidden = false; await d.set(READY); d.fire(d.live(1500)[0]);
  d.ctx.voiceHintDone(); assert.ok(d.appended[0].removed, 'mic use / close');
});

test('8. phone hint: never opened while the page is hidden', async () => {
  // Fails on ebb3500a: the hint timer was set (and the hint shown) with document.hidden true.
  const p = page(); p.mic.hidden = false;
  p.ctx.document.hidden = true;
  await p.set(READY);
  assert.strictEqual(p.live(1500).length, 0, 'no timer while hidden');
  p.ctx.voiceHintShow();
  assert.strictEqual(p.appended.length, 0, 'and a due timer shows nothing');
  assert.notStrictEqual(p.store.get('mm-voice-hint:u1'), '1', 'the key stays unset');
  p.ctx.document.hidden = false; p.ctx.voiceHintSync();
  assert.strictEqual(p.live(1500).length, 1, 'visible again: it opens');
});

// ── 8. desktop voiceHintOk ──
test('8. desktop hint: voiceHintOk is false while the page is hidden', () => {
  // Fails on ebb3500a: voiceHintOk had no document.hidden term.
  const src = fnSrc(app, 'voiceHintOk');
  const mkOk = (hidden) => new Function('document', 'voiceHintSeen', 'activeChat', 'chats', 'voiceHintBlocked', 'voiceMicState', 'voiceHintTarget', src + '\nreturn voiceHintOk;')(
    { hidden }, () => false, 'c1', { c1: {} }, () => false, () => 'ready', () => ({}));
  assert.strictEqual(!!mkOk(false)(), true);
  assert.strictEqual(!!mkOk(true)(), false);
});
