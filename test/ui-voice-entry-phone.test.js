'use strict';
// Phone: the microphone appears only when voice is ready (on and everything downloaded). Not ready (getting ready, failed, off,
// unsupported) = no microphone and no hint, exactly as before voice was on by default. The page learns readiness without a reload
// (a 20 s status read while voice is on and not ready). The Voice sheet tells the truth meanwhile. The one-time hint shows once.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mob = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'mobile.html'), 'utf8');
const between = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, a + ' .. ' + b); return src.slice(i, j); };
const fnSrc = (src, name) => {
  const i = src.search(new RegExp('(async )?function ' + name + '\\('));
  assert.ok(i >= 0, name);
  let depth = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}') { depth--; if (!depth) break; } }
  return src.slice(i, j + 1);
};

// ── a small page: the poll, the hint, the status refresh (the real source, a fake DOM) ──
const pollAndHint = between(mob, '// ── The microphone appears only when voice is ready', '// ── end one-time voice hint ──');
function page({ me = { user: { id: 'u1' }, isAdmin: true }, simple = false } = {}) {
  const store = new Map();
  const timers = []; let tid = 0; const cleared = [];
  const mkBtn = (id) => ({ id, hidden: true, classList: { toggle() {}, add() {}, remove() {}, contains: () => false }, getBoundingClientRect: () => ({ left: 300, width: 40 }), setAttribute() {}, removeAttribute() {} });
  const mic = mkBtn('mic-btn'), call = mkBtn('simple-call-btn');
  const appended = [];
  const row = { offsetTop: 10 };
  const composer = { clientHeight: 60, querySelector: (s) => (s === '.row' ? row : null), appendChild: (el) => { appended.push(el); composer.last = el; } };
  const mkEl = (tag) => { const e = { tag, children: [], style: { setProperty() {} }, dataset: {}, attrs: {}, listeners: {}, className: '', id: '', textContent: '',
    setAttribute(k, v) { e.attrs[k] = v; }, addEventListener(t, f) { e.listeners[t] = f; }, append(...c) { e.children.push(...c); }, remove() { e.removed = true; },
    getBoundingClientRect: () => ({ left: 100, width: 250 }) }; Object.defineProperty(e, 'clientWidth', { value: 250 }); return e; };
  const calls = { status: 0 };
  const ctx = {
    console, Number, Math, String, Map, Promise, JSON, Date,
    setTimeout: (fn, ms) => { timers.push({ id: ++tid, fn, ms, live: true }); return tid; },
    clearTimeout: (id) => { cleared.push(id); const t = timers.find((x) => x.id === id); if (t) t.live = false; },
    document: { hidden: false, createElement: mkEl, querySelector: (sel) => (ctx.openSheet && String(sel).includes(ctx.openSheet) ? { id: 'sheet' } : null) }, window: { addEventListener() {} },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    $: (id) => (id === 'mic-btn' ? mic : id === 'simple-call-btn' ? call : id === 'composer' ? composer : null),
    simpleOn: () => simple,
    api: async () => { calls.status++; return { ok: true, json: async () => ctx.nextStatus }; },
    voiceLocalProbe() {}, voiceSpeakPaint() {}, paintVoiceSheet() {}, voiceCallHangUp() {}, voiceMicCancel() {}, toast() {}, voiceStripPaint() {},
    voiceMicPaint() { ctx.voiceHintSync(); },   // the real one is covered below; here it only has to tell the hint something changed
  };
  vm.createContext(ctx);
  vm.runInContext('var voiceStatus = null, screen = "chat", current = "maestro", voiceCall = null, voiceRec = { state: "idle" }, questionBoxes = new Map(), hubMe = null;', ctx);
  ctx.hubMe = me;
  vm.runInContext(fnSrc(mob, 'voiceOn') + '\n' + pollAndHint + '\n' + fnSrc(mob, 'voiceStatusRefresh'), ctx);
  const set = async (st) => { ctx.nextStatus = st; await ctx.voiceStatusRefresh(); };
  return { ctx, mic, call, timers, cleared, store, composer, appended, calls, set, live: (ms) => timers.filter((t) => t.live && (ms === undefined || t.ms === ms)), fire: (t) => { t.live = false; t.fn(); } };
}
const READY = { enabled: true, ready: true, platformSupported: true };
const GETTING = { enabled: true, ready: false, installing: true, progress: 0.42, platformSupported: true };
const FAILED = { enabled: true, ready: false, failed: true, failReason: 'network', platformSupported: true };
const OFF = { enabled: false, ready: false, platformSupported: true };
const UNSUPPORTED = { enabled: true, ready: false, platformSupported: false };

test('the microphone is shown only when voice is ready: getting ready, failed, off and unsupported keep it hidden', async () => {
  for (const [name, st] of [['getting ready', GETTING], ['on, not started', { enabled: true, ready: false, platformSupported: true }], ['failed', FAILED], ['off', OFF], ['unsupported', UNSUPPORTED]]) {
    const p = page(); await p.set(st);
    assert.strictEqual(p.mic.hidden, true, name + ': hidden');
  }
  const p = page(); await p.set(READY);
  assert.strictEqual(p.mic.hidden, false, 'ready: shown');
  await p.set(GETTING);   // never step backwards is the server's rule; the page simply follows the status
  assert.strictEqual(p.mic.hidden, true);
});

test('no non-ready looks or taps are left: the mic has no wait/off class, the Voice sheet is not opened from the mic', () => {
  assert.ok(!/voice-wait-look|voice-off-look|voiceMicState|voiceStateTitle/.test(mob), 'mobile.js');
  assert.ok(!/voice-wait-look|voice-off-look|voice-wait-pulse/.test(html), 'mobile.html');
  assert.match(html, /id="mic-btn"[^>]*hidden>/, 'the markup starts hidden');
  assert.match(mob, /if \(b\) \{ b\.hidden = !voiceOn\(\);/, 'shown only by voiceOn() (enabled and ready)');
  const tap = fnSrc(mob, 'voiceMicTap');
  assert.ok(!/openVoiceSheet/.test(tap), 'a tap on the mic never opens the sheet');
  const simpleTap = between(mob, 'onComposerTap(cb, () =>', 'sheet.addEventListener');
  assert.ok(!/openVoiceSheet/.test(simpleTap), 'nor does the Simple call button');
  assert.match(html, /html\.mm-simple #composer \.row:has\(#mic-btn\[hidden\]\) #simple-call-btn \{ display: none; \}/, 'the Simple call button follows #mic-btn[hidden]');
});

test('the ready tooltip names the agent of the open chat (Hands-free, Tap to talk, Dictation)', () => {
  const cls = new Set(), attrs = {};
  const b = { classList: { toggle: (c, v) => { if (v) cls.add(c); else cls.delete(c); }, add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)) }, setAttribute: (k, v) => { attrs[k] = String(v); }, removeAttribute() {}, querySelector: () => ({}), innerHTML: '<svg></svg>', textContent: '' };
  let mode = 'handsfree';
  const ctx = { voiceStripPaint() {}, voiceHintSync() {}, $: (id) => (id === 'mic-btn' ? b : { hidden: false, style: {} }), voiceCall: null, VOICE_MIC_SVG: '<svg></svg>', VOICE_HANGUP_SVG: '', voiceRec: { state: 'idle', t0: 0 },
    voicePrefsNow: () => ({ mode }), voiceBarPaint() {}, Date, current: 'maestro', displayName: () => 'Maestro' };
  vm.createContext(ctx);
  vm.runInContext(fnSrc(mob, 'voiceAgentLabel') + fnSrc(mob, 'voiceReadyTitle') + fnSrc(mob, 'voiceMicPaint') + '\nthis.paint = voiceMicPaint;', ctx);
  ctx.paint(); assert.strictEqual(b.title, 'Talk to Maestro: hands-free call'); assert.strictEqual(attrs['aria-label'], 'Talk hands-free', 'aria-labels stay');
  mode = 'press'; ctx.paint(); assert.strictEqual(b.title, 'Talk to Maestro: tap to talk'); assert.strictEqual(attrs['aria-label'], 'Tap to talk');
  mode = 'tap'; ctx.paint(); assert.strictEqual(b.title, 'Dictate a message to Maestro'); assert.strictEqual(attrs['aria-label'], 'Dictate');
  ctx.displayName = () => ''; ctx.paint(); assert.strictEqual(b.title, 'Dictate a message to your agent', 'fallback');
});

test('poll: while voice is on and not ready the status is read every 20 s while the page is visible; it stops when ready or off', async () => {
  const p = page(); await p.set(GETTING);
  assert.deepStrictEqual(p.live(20000).length, 1, 'one 20 s timer');
  await p.set(GETTING); assert.strictEqual(p.live(20000).length, 1, 'never two');
  const before = p.calls.status;
  p.ctx.nextStatus = GETTING; p.fire(p.live(20000)[0]); await new Promise((r) => setImmediate(r));
  assert.strictEqual(p.calls.status, before + 1, 'the timer reads the status');
  assert.strictEqual(p.live(20000).length, 1, 'and arms the next one');
  p.ctx.document.hidden = true; const n = p.calls.status; p.fire(p.live(20000)[0]);
  assert.strictEqual(p.calls.status, n, 'a hidden page does not read');
  assert.strictEqual(p.live(20000).length, 1, 'but keeps the timer');
  p.ctx.document.hidden = false;
  await p.set(FAILED); assert.strictEqual(p.live(20000).length, 1, 'failed: still waiting for the automatic retry');
  await p.set(READY); assert.strictEqual(p.live(20000).length, 0, 'ready: stopped');
  assert.strictEqual(p.mic.hidden, false, 'and the microphone is painted');
  for (const st of [OFF, UNSUPPORTED]) { const q = page(); await q.set(st); assert.strictEqual(q.live().filter((t) => t.ms === 20000).length, 0, 'off or unsupported: no polling'); }
  assert.match(mob, /need = !!\(st && st\.enabled && st\.platformSupported !== false && !st\.ready\)/);
});

test('hint: not ready = no hint; ready = the hint 1.5 s later, once, with its key', async () => {
  for (const [name, st] of [['getting ready', GETTING], ['failed', FAILED], ['off', OFF], ['unsupported', UNSUPPORTED]]) {
    const p = page(); await p.set(st);
    assert.strictEqual(p.live(1500).length, 0, name + ': no hint timer');
    assert.strictEqual(p.store.size, 0, name + ': no key');
  }
  const p = page(); await p.set(GETTING); assert.strictEqual(p.live(1500).length, 0);
  await p.set(READY);   // the download ended: the microphone appears, then the hint
  assert.strictEqual(p.mic.hidden, false);
  assert.strictEqual(p.live(1500).length, 1);
  p.fire(p.live(1500)[0]);
  const h = p.composer.last;
  assert.ok(h && h.id === 'voice-hint', 'the callout is in the composer');
  assert.strictEqual(h.children[0].textContent, 'New: talk to your agents. Tap the microphone.');
  assert.strictEqual(h.children[1].attrs['aria-label'], 'Close'); assert.strictEqual(h.children[1].textContent, '×');
  assert.strictEqual(p.store.get('mm-voice-hint:u1'), '1', 'the key is set the moment it is shown');
  // never again: a new page with the same storage, and the same page after a close
  h.children[1].listeners.click({ stopPropagation() {} });
  assert.strictEqual(h.removed, true, 'close removes it');
  await p.set(READY); assert.strictEqual(p.live(1500).length, 0, 'not shown twice');
  const anon = page({ me: null }); await anon.set(READY); anon.fire(anon.live(1500)[0]);
  assert.strictEqual(anon.store.get('mm-voice-hint:anon'), '1', 'no signed-in user: the key is anon');
});

test('hint: never during a call or with a question box; a chat switch, a call start or a question takes it away; Simple points at the call button', async () => {
  let p = page(); p.ctx.voiceCall = { press: false }; await p.set(READY);
  assert.strictEqual(p.live(1500).length, 0, 'a call is up');
  p = page(); p.ctx.questionBoxes.set('q1', {}); await p.set(READY);
  assert.strictEqual(p.live(1500).length, 0, 'a question box is showing');
  p = page(); await p.set(READY); p.fire(p.live(1500)[0]); const h = p.composer.last;
  p.ctx.questionBoxes.set('q1', {}); p.ctx.voiceHintSync(); assert.strictEqual(h.removed, true, 'a question appearing');
  p = page(); await p.set(READY); p.fire(p.live(1500)[0]); const h2 = p.composer.last;
  p.ctx.current = 'other'; p.ctx.voiceHintSync(); assert.strictEqual(h2.removed, true, 'a chat switch');
  p = page(); await p.set(READY); assert.strictEqual(p.live(1500).length, 1); p.ctx.voiceCall = {}; p.ctx.voiceHintSync(); assert.strictEqual(p.live(1500).length, 0, 'a call starting cancels the wait');
  // voiceCallStart takes the hint down; the mic tap and the Simple call button end it for good
  assert.match(fnSrc(mob, 'voiceCallStart'), /voiceHintHide\(\)/);
  assert.match(fnSrc(mob, 'voiceMicTap'), /voiceHintDone\(\)/);
  assert.match(mob, /onComposerTap\(cb, \(\) => \{[^\n]*voiceHintDone\(\); voiceCallStart\(\);/);
  // Simple: the callout points at the Simple call button (so it needs that button shown)
  p = page({ simple: true }); p.mic.hidden = false; p.call.hidden = true; await p.set(READY);
  assert.ok(p.mic.hidden === false);
  assert.strictEqual(p.ctx.voiceHintTarget(), p.call);
});

test('hint: a callout above the composer row, never over the message box or Send, inside 390 px', () => {
  const css = html.match(/\.voice-hint \{[^}]*\}/)[0];
  assert.match(css, /position: absolute/); assert.match(css, /right: 8px/); assert.match(css, /width: min\(250px, calc\(100vw - 16px\)\)/);
  const place = fnSrc(mob, 'voiceHintPlace');
  assert.match(place, /h\.style\.bottom = \(c\.clientHeight - row\.offsetTop \+ 10\) \+ 'px'/, 'its bottom edge sits above the row of the box, mic and Send');
});

// ── the Voice sheet tells the truth until ready ──
const paintSrc = between(mob, 'function paintVoiceSheet() {', 'function openVoiceSheet() {');
function sheet(status, me = { user: { id: 'u' }, isAdmin: true }, apiFn) {
  const el = () => new Proxy({ hidden: false, textContent: '', value: '', checked: false, disabled: false, classList: { toggle() {}, contains: () => true, add() {}, remove() {} } }, { get: (t, k) => (k in t ? t[k] : undefined), set: (t, k, v) => { t[k] = v; return true; } });
  const els = {}; for (const s of ['.vs-note', '.vs-enable', '.vs-enable-text', '.vs-enable-btn', '.vs-progress', '.vs-progress-line']) els[s] = el();
  const other = el();
  const sh = { classList: { contains: () => true }, querySelector: (s) => els[s] || other, querySelectorAll: () => [] };
  const posts = [];
  const f = new Function('$', 'voicePrefsNow', 'voiceEndPauseNow', 'voiceSpeedNow', 'voiceSpeedLabel', 'document', 'CallDisplay', 'voiceOn', 'hubMe', 'VOICE_CALL_HELP', 'voiceLoudnessFor', 'api', 'toast', 'voiceStatusRefresh', 'setTimeout', 'clearTimeout', 'status',
    'let voiceStatus = status;\n' + paintSrc + '\nreturn { paintVoiceSheet, voiceSheetEnable };');
  const t = f((id) => (id === 'voice-sheet' ? sh : null), () => ({ micLevel: 50, interruptSensitivity: 50, mode: 'tap', echoHold: 600 }), () => 1200, () => 1, () => '1x', { activeElement: null }, undefined,
    () => !!(status.enabled && status.ready), me, '', () => 'louder', async (p, o) => { posts.push(p); return apiFn ? apiFn() : { ok: true, status: 200, json: async () => ({ ok: true }) }; }, () => {}, async () => {}, () => 1, () => {}, status);
  return { els, posts, ...t };
}

test('Voice sheet, failed: the note shows the reason for everyone; an admin also gets the raw error and "Retry now" (POST /api/voice/retry); a member neither', async () => {
  const st = { enabled: true, ready: false, failed: true, failReason: 'network', error: 'getaddrinfo ENOTFOUND github.com', platformSupported: true };
  const a = sheet(st); a.paintVoiceSheet();
  assert.strictEqual(a.els['.vs-note'].textContent, "Voice isn't ready: this computer couldn't reach the internet to download the speech engines. It tries again by itself.");
  assert.strictEqual(a.els['.vs-enable-btn'].textContent, 'Retry now'); assert.strictEqual(a.els['.vs-enable-btn'].hidden, false);
  assert.strictEqual(a.els['.vs-enable-text'].textContent, 'getaddrinfo ENOTFOUND github.com');
  await a.voiceSheetEnable(); assert.deepStrictEqual(a.posts, ['/api/voice/retry']);
  const m = sheet({ ...st, error: null }, { user: { id: 'm' }, isAdmin: false }); m.paintVoiceSheet();
  assert.match(m.els['.vs-note'].textContent, /^Voice isn't ready: this computer couldn't reach the internet/);
  assert.strictEqual(m.els['.vs-enable-btn'].hidden, true); assert.strictEqual(m.els['.vs-enable'].hidden, true);
});

test('Voice sheet status lines: installing with size and percent, waiting with size, off for a member names the admin, ready', () => {
  let s = sheet({ enabled: true, ready: false, installing: true, progress: 0.42, bytesTotal: 800000000, downloadBytes: 600000000, platformSupported: true }); s.paintVoiceSheet();
  assert.strictEqual(s.els['.vs-note'].textContent, 'Getting voice ready: downloading the speech engines, about 600 MB (42%).');
  s = sheet({ enabled: true, ready: false, platformSupported: true, downloadBytes: 600000000 }); s.paintVoiceSheet();
  assert.strictEqual(s.els['.vs-note'].textContent, 'Getting voice ready: about 600 MB to download. It starts by itself.');
  s = sheet({ enabled: false, ready: false, platformSupported: true, adminName: 'Pat' }, { user: {}, isAdmin: false }); s.paintVoiceSheet();
  assert.match(s.els['.vs-note'].textContent, /^Voice is off\. Pat can turn it on, from the Voice menu on their phone or in Settings, Voice on the computer\.$/);
  s = sheet({ enabled: true, ready: true, platformSupported: true }); s.paintVoiceSheet();
  assert.match(s.els['.vs-note'].textContent, /^Voice is on and ready\./);
  s = sheet({ enabled: true, ready: false, platformSupported: false }); s.paintVoiceSheet();
  assert.strictEqual(s.els['.vs-note'].textContent, 'Voice is not supported on this computer.');
});

test('hint: none while a sheet or panel is open (Voice sheet, + sheet, menu, a dialog); a showing hint is taken down when one opens', async () => {
  for (const sheet of ['#voice-sheet.open', '#plus-sheet:not([hidden])', '#menu.open', 'dialog[open]', '.rsn-sheet.open', '#voice-panel:not([hidden])']) {
    const p = page(); p.ctx.openSheet = sheet; await p.set(READY);
    assert.strictEqual(p.live(1500).length, 0, sheet + ': no hint timer');
    assert.strictEqual(p.store.size, 0, sheet + ': no key');
    p.ctx.openSheet = null; p.ctx.voiceHintSync();
    assert.strictEqual(p.live(1500).length, 1, sheet + ': it is allowed again once the sheet is closed');
  }
  const p = page(); await p.set(READY); p.fire(p.live(1500)[0]); const h = p.composer.last;
  assert.ok(h && !h.removed);
  p.ctx.openSheet = '#voice-sheet.open'; p.ctx.voiceHintSync();
  assert.strictEqual(h.removed, true, 'a sheet opening takes the showing hint down');
  // a timer that fires while a sheet is open shows nothing and sets no key
  const q = page(); await q.set(READY); const t = q.live(1500)[0]; q.ctx.openSheet = '#menu.open'; q.fire(t);
  assert.strictEqual(q.composer.last, undefined); assert.strictEqual(q.store.size, 0);
});
