'use strict';
// The call display chooser inside the call itself (the call bar on the desktop, the call panel on the phone), so the owl / Orb / None
// can be picked without opening the voice settings. The real page functions are cut out of app.js and mobile.js and RUN against a
// fake DOM with the real lib/ui-call-display.js (the same approach as voice-face-integration.test.js); wiring that cannot be run
// cheaply (listeners, the factored retry) is checked on the source.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
Object.assign(globalThis, require('../lib/ui-voice'));
const CD = require('../lib/ui-call-display');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('app.js'), mob = read('mobile.js'), mobHtml = read('mobile.html');
const tick = async (n = 12) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
function between(src, a, b) { const i = src.indexOf(a); assert.ok(i >= 0, 'start marker: ' + a); const j = src.indexOf(b, i + a.length); assert.ok(j > i, 'end marker: ' + b); return src.slice(i, j); }

function fakeDom() {
  const doc = { activeElement: null, byId: new Map(), hidden: false };
  class El {
    constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.parentNode = null; this.attrs = {}; this.listeners = {}; this.className = ''; this.hidden = false; this.disabled = false; this.value = ''; this.checked = false; this._text = ''; this.props = {}; this.style = { setProperty: (k, v) => { this.props[k] = v; } }; }
    get firstChild() { return this.children[0] || null; }
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
    set textContent(v) { this.children.forEach(c => { c.parentNode = null; }); this.children = []; this._text = String(v); }
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
    insertBefore(c, ref) { if (c.parentNode) c.parentNode.removeChild(c); const i = this.children.indexOf(ref); c.parentNode = this; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; } return c; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
    contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
    focus() { doc.activeElement = this; }
    click() { for (const f of this.listeners.click || []) f({ preventDefault() {}, target: this }); }
    all() { return this.children.flatMap(c => [c, ...c.all()]); }
    querySelectorAll() { return []; }
  }
  doc.createElement = (t) => new El(t); doc.body = new El('body'); doc.El = El;
  doc.getElementById = (id) => doc.byId.get(id) || null;
  doc.add = (id, parent, tag) => { const e = new El(tag || 'div'); e.id = id; doc.byId.set(id, e); (parent || doc.body).appendChild(e); return e; };
  return doc;
}
const memStorage = (init) => { const m = new Map(Object.entries(init || {})); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };
const PACKS = [{ id: 'owl', name: 'Owl', background: '#ffd6ab', hasReactions: true }];
const facesFetch = async (u) => { assert.strictEqual(u, '/api/faces'); return { ok: true, status: 200, json: async () => ({ packs: PACKS }) }; };
const optionsOf = (sel) => sel.children.map(o => [o.value, o.textContent]);
const player = (log) => () => { const p = { calls: [], setState() {}, setAnalyser() {}, setMicLevel() {}, speechEvent() {}, react: () => true, destroy() {}, ready: null }; p.ready = Promise.resolve(p); log.push(p); return p; };

// ═══════════════ desktop (app.js) ═══════════════
function desktop(o) {
  o = o || {};
  const doc = fakeDom(), storage = memStorage(o.prefs ? { [CD.DISPLAY_STORE_KEY]: JSON.stringify(o.prefs) } : {});
  const orbs = [], faces = [];
  const win = { document: doc, createVoiceOrb: player(orbs), createFacePlayer: player(faces) };
  const S = { call: null, chatId: 'c1', agent: 'bob', own: new Map(), hub: new Map(), asks: new Map(), sendSeq: 0, active: true, vad: null };
  const callbar = doc.add('voice-callbar-c1'), hangBtn = new doc.El('button'); hangBtn.className = 'vcb-hang'; callbar.appendChild(hangBtn); callbar.querySelector = (s) => (s === '.vcb-hang' ? hangBtn : null);
  const host = doc.add('home'), pop = doc.add('voice-pop-c1', host); pop.hidden = true;
  if (!o.noPanelSelect) doc.add('vp-display-c1', null, 'select');
  if (!o.noBarSelect) doc.add('vcb-display-c1', callbar, 'select');
  const stubs = {
    window: win, document: doc, localStorage: storage, fetch: o.fetch || facesFetch, AGENTS: [{ name: 'bob', callDisplay: 'none' }], chats: { c1: { agent: 'bob' } },
    voiceById: (id) => doc.getElementById(id), voiceCallS: S, voiceCallHangUp() {}, voicePopToggle() { pop.hidden = false; }, voicePopClose() { pop.hidden = true; }, CallDisplay: CD, voicePlay: { token: 1, ctx: null },
    voiceSpeedNow: () => 1, hubToast() {}, setTimeout, clearTimeout, Promise, voiceCallRunning: () => false, hubOriginLabel: () => '', voiceSentences: (t) => [t], voiceSpeechText: (t) => t,
    VOICE_HANGUP_SVG: '', voicePauseSelectHtml: (id, attrs) => `<select id="${id}" ${attrs}></select>`, voiceMicLevelNow: () => 50, voiceSensNow: () => 50, voiceSpeedLabel: () => '1x', VOICE_SPEED_HINT: '', VOICE_CALL_HELP: '',
  };
  const names = Object.keys(stubs);
  const glue = between(app, '    const voiceDisp = {', '    const VOICE_CALL_HELP');
  const bar = between(app, '    function voiceCallBarHtml(', '    function voiceCallShowBar(');
  const retry = between(app, '    function voiceCallRetryMicTap(', '    function voiceCallHideBar(');   // onRetryMic is handed to the display at begin
  const code = [glue, bar, retry, 'return { voiceDisp, voiceDispBegin, voiceDispEnd, voiceDispSetChoice, voiceDispPaintPanel, voiceCallBarHtml, voiceDispSetInterrupt };'].join('\n');
  const api = new Function(...names, code)(...names.map(n => stubs[n]));
  S.call = { state: 'listening', onSpeechStart() {}, onMisfire() {}, callId: 'k1' };
  return { api, doc, storage, orbs, faces, callbar, panelSel: doc.getElementById('vp-display-c1'), barSel: doc.getElementById('vcb-display-c1') };
}

test('desktop: the call bar carries a labelled Display select (id vcb-display-<chat>, data-vcb="display") before Hang up', () => {
  const html = desktop().api.voiceCallBarHtml('c1');
  assert.ok(/<select id="vcb-display-c1" data-vcb="display" aria-label="Display">/.test(html), 'the select');
  assert.ok(/<label class="vcb-disp">Display <select/.test(html), 'labelled Display');
  assert.ok(html.indexOf('data-vcb="display"') < html.indexOf('data-vcb="hang"'), 'before the Hang up button');
  assert.ok(html.indexOf('data-vcb="display"') < html.indexOf('class="vcb-sliders"'), 'in the first row');
});

test('desktop: the paint fills the bar select like the voice panel select, also when the panel select is absent', async () => {
  const d = desktop({ prefs: { choice: 'pack:owl' } });
  await d.api.voiceDispPaintPanel('c1');
  assert.deepStrictEqual(optionsOf(d.barSel), optionsOf(d.panelSel)); assert.strictEqual(d.barSel.value, 'pack:owl'); assert.strictEqual(d.panelSel.value, 'pack:owl');
  assert.ok(optionsOf(d.barSel).some(([v, t]) => v === 'pack:owl' && t === 'Owl') && optionsOf(d.barSel).some(([v]) => v === 'orb') && optionsOf(d.barSel).some(([v]) => v === 'none'));
  const only = desktop({ prefs: { choice: 'orb' }, noPanelSelect: true });
  await only.api.voiceDispPaintPanel('c1');
  assert.strictEqual(only.barSel.value, 'orb'); assert.strictEqual(only.barSel.children.length, 4, 'follow, none, orb, owl');
  const none = desktop({ noPanelSelect: true, noBarSelect: true });
  await none.api.voiceDispPaintPanel('c1');   // neither select: nothing to do, no crash
});

test('desktop: a select that is the active element (an open picker) is not refilled; the other one is', async () => {
  const d = desktop({ prefs: { choice: 'orb' } });
  d.barSel.value = 'stale'; d.doc.activeElement = d.barSel;
  await d.api.voiceDispPaintPanel('c1');
  assert.strictEqual(d.barSel.value, 'stale'); assert.strictEqual(d.barSel.children.length, 0, 'untouched');
  assert.strictEqual(d.panelSel.value, 'orb', 'the other select is still painted');
});

test('desktop: a select rebuilt while the packs load is not painted (the old node is gone)', async () => {
  const d = desktop({ prefs: { choice: 'orb' } });
  const p = d.api.voiceDispPaintPanel('c1');
  d.doc.byId.delete('vcb-display-c1');   // the bar was rebuilt meanwhile
  await p;
  assert.strictEqual(d.barSel.children.length, 0); assert.strictEqual(d.panelSel.value, 'orb');
});

test('desktop: choosing in the bar reaches the running display and both selects show it; with no display the prefs change', async () => {
  const d = desktop({ prefs: { choice: 'orb' } });
  d.api.voiceDispBegin('c1', 'bob'); await tick();
  const seen = []; const cur = d.api.voiceDisp.cur; assert.ok(cur, 'a display is running'); const real = cur.setChoice.bind(cur); cur.setChoice = (v) => { seen.push(v); return real(v); };
  d.api.voiceDispSetChoice('c1', 'none'); await tick(30);
  assert.deepStrictEqual(seen, ['none']);
  assert.strictEqual(d.barSel.value, 'none'); assert.strictEqual(d.panelSel.value, 'none');
  d.api.voiceDispEnd(false);
  d.api.voiceDispSetChoice('c1', 'pack:owl'); await tick(30);
  assert.strictEqual(JSON.parse(d.storage.m.get(CD.DISPLAY_STORE_KEY)).choice, 'pack:owl');
  assert.strictEqual(d.barSel.value, 'pack:owl'); assert.strictEqual(d.panelSel.value, 'pack:owl');
});

test('desktop: the bar wires change -> voiceDispSetChoice, paints at call start, and retry + micLost are wired', () => {
  const show = between(app, '    function voiceCallShowBar(', '    function voiceCallHideBar(');
  assert.ok(/t\.dataset\.vcb === 'display'\) voiceDispSetChoice\(chatId, t\.value\)/.test(show), 'change handler');
  assert.ok(/insertBefore\(bar, area\);[\s\S]*voiceDispPaintPanel\(chatId\)/.test(show), 'the bar is painted after it is inserted');
  assert.ok(/t\.dataset\.vcb === 'retry'\) voiceCallRetryMicTap\(\)/.test(show), 'the click uses the factored retry');
  assert.ok(/function voiceCallRetryMicTap\(\) \{[\s\S]*retryMic\(\)[\s\S]*Still no microphone\./.test(app));
  assert.ok(/createCallDisplay\(\{[^]*onRetryMic: voiceCallRetryMicTap[,\s]/.test(app), 'onRetryMic goes to the display');
  assert.ok(/micLost: \(on\) => \{[^]*?voiceDisplayHook\('micLost', !!on\);\s*\},/.test(app), 'ui.micLost tells the display');
});

// ═══════════════ phone (mobile.js + mobile.html) ═══════════════
function phone(o) {
  o = o || {};
  const doc = fakeDom(), storage = memStorage(o.prefs ? { [CD.DISPLAY_STORE_KEY]: JSON.stringify(o.prefs) } : {});
  const orbs = [], faces = [];
  function AC() { return { state: 'running', destination: {}, resume: async () => {}, createAnalyser: () => ({ connect() {} }), createMediaElementSource: () => ({ connect() {} }), close: async () => {} }; }
  const win = { document: doc, AudioContext: AC, createVoiceOrb: player(orbs), createFacePlayer: player(faces) };
  const panel = doc.add('call-panel'), vp = doc.add('vp-display', null, 'select'), cp = doc.add('cp-display', panel, 'select');
  if (o.noPanelSelect) doc.byId.delete('vp-display');
  const voicePlay = { token: 5, audio: null, url: null, cancel: null, el: null, told: false };
  function Audio() { this.src = ''; this.play = () => Promise.resolve(); this.pause = () => {}; }
  const stubs = {
    window: win, document: doc, localStorage: storage, fetch: o.fetch || facesFetch, agents: [{ name: 'bob', callDisplay: 'none' }], current: 'bob', $: (id) => doc.getElementById(id),
    CallDisplay: CD, voicePlay, URL: { createObjectURL: () => 'blob:0', revokeObjectURL() {} }, Audio, voiceOn: () => true, api: async () => ({ ok: true }), toast() {},
    voiceSpeedNow: () => 1, voiceWaitLocalVoice: async () => ({ lang: 'en' }), SpeechSynthesisUtterance: function (t) { this.text = t; }, voicePanelPaint() {},
    voiceCallHangUp() {}, originLabel: () => '', setTimeout, clearTimeout, Promise, Blob: function Blob() {}, Float32Array, voiceEncodeWav: () => new Uint8Array(1),
  };
  const names = Object.keys(stubs);
  const glue = between(mob, 'const voiceDisp = {', 'function voiceCallPaintState(');
  const code = ['let voiceCall = null;', glue, 'return { voiceDisp, voiceDispBegin, voiceDispEnd, voiceDispSetChoice, voiceDispPaintPanel, voiceDispSetInterrupt };'].join('\n');
  const api = new Function(...names, code)(...names.map(n => stubs[n]));
  return { api, doc, storage, orbs, faces, vp: doc.getElementById('vp-display'), cp, vpEl: vp };
}

test('phone: mobile.html has #cp-display in #call-panel, labelled Display, before .cp-actions', () => {
  const start = mobHtml.indexOf('<div id="call-panel"'), end = mobHtml.indexOf('<div id="composer"', start);
  assert.ok(start > 0 && end > start);
  const block = mobHtml.slice(start, end);
  assert.ok(/<label class="cp-disp" for="cp-display"><span>Display<\/span><select id="cp-display">/.test(block), 'label and select');
  assert.ok(block.indexOf('id="cp-display"') < block.indexOf('<div class="cp-actions">'), 'before the actions row');
  assert.ok(block.indexOf('id="cp-levels"') > block.indexOf('id="cp-display"'), 'Levels is still there');
  assert.ok(/#call-panel \.cp-disp \{[^}]*min-height: 48px[^}]*font-size: 16px/.test(mobHtml) && /#call-panel \.cp-disp select \{[^}]*min-height: 44px[^}]*font-size: 16px/.test(mobHtml), 'touch size, 16px against iOS zoom');
});

test('phone: the paint fills #cp-display and #vp-display alike (also with one absent); the active one is skipped', async () => {
  const p = phone({ prefs: { choice: 'pack:owl' } });
  await p.api.voiceDispPaintPanel();
  assert.deepStrictEqual(optionsOf(p.cp), optionsOf(p.vp)); assert.strictEqual(p.cp.value, 'pack:owl'); assert.strictEqual(p.vp.value, 'pack:owl');
  assert.ok(optionsOf(p.cp).some(([v, t]) => v === 'pack:owl' && t === 'Owl'));
  const only = phone({ prefs: { choice: 'orb' }, noPanelSelect: true });
  await only.api.voiceDispPaintPanel(); assert.strictEqual(only.cp.value, 'orb');
  const act = phone({ prefs: { choice: 'orb' } });
  act.cp.value = 'stale'; act.doc.activeElement = act.cp;
  await act.api.voiceDispPaintPanel();
  assert.strictEqual(act.cp.value, 'stale'); assert.strictEqual(act.vp.value, 'orb');
});

test('phone: a choice made reaches the display (or the prefs) and both selects show it', async () => {
  const p = phone({ prefs: { choice: 'none' } });
  p.api.voiceDispSetChoice('pack:owl'); await tick(30);
  assert.strictEqual(JSON.parse(p.storage.m.get(CD.DISPLAY_STORE_KEY)).choice, 'pack:owl');
  assert.strictEqual(p.cp.value, 'pack:owl'); assert.strictEqual(p.vp.value, 'pack:owl');
});

test('phone: #cp-display change is wired to voiceDispSetChoice; the panel is painted at call start; retry + micLost are wired', () => {
  assert.ok(/\$\('cp-display'\)\?\.addEventListener\('change', \(e\) => voiceDispSetChoice\(e\.target\.value\)\)/.test(mob));
  assert.ok(/voiceCallPanel\(true\); voiceCallPaintState\('starting'\); voiceMicPaint\(\); if \(typeof voiceDispPaintPanel === 'function'\) voiceDispPaintPanel\(\)/.test(mob));
  assert.ok(/\$\('cp-retry-mic'\)\?\.addEventListener\('click', \(\) => \{ const vc = voiceCall;/.test(mob), 'the panel button keeps its own retry (same behaviour as voiceCallRetryMicTap)');
  assert.ok(/function voiceCallRetryMicTap\(\) \{[\s\S]*retryMic\(\)[\s\S]*Still no microphone\./.test(mob));
  assert.ok(/createCallDisplay\(\{[^]*onRetryMic: voiceCallRetryMicTap[,\s]/.test(mob), 'onRetryMic goes to the display');
  const ml = between(mob, '      micLost: (on) => {', '      state: (name');
  assert.ok(ml.indexOf('if (voiceCall !== vc) return;') >= 0 && /if \(typeof voiceDisplayHook === 'function'\) voiceDisplayHook\('micLost', !!on\);/.test(ml), 'guarded by the same call check');
  assert.ok(/id="cp-levels" class="cp-levels">Levels</.test(mobHtml), 'Levels keeps its name');
});

// ═══════════════ the Interrupt button option (off by default; no Talk button anywhere) ═══════════════
const HINT = "For places where talking over the reply doesn't register.";

function popHtml() {
  const stubs = {
    voicePrefsNow: () => ({ mode: 'handsfree' }), VOICE_CONTINUE_WAITS: [1500, 3000, 5000], voiceContinueWaitNow: () => 3000,
    voicePauseSelectHtml: (id, attrs) => `<select id="${id}" ${attrs}></select>`, voiceMicLevelNow: () => 50, voiceSensNow: () => 50, voiceSpeedNow: () => 1, voiceSpeedLabel: () => '1x',
    voiceThinkingOnNow: () => true, voiceThinkingVolNow: () => 0.5, voiceEchoSelectHtml: (id, attrs) => `<select id="${id}" ${attrs}></select>`, VOICE_ECHO_HINT: 'echo', VOICE_KEEP_HINT: 'keep', voiceKeepAliveNow: () => true,
    voiceWakeRowsHtml: () => '',   // the wake rows have their own tests (ui-voice-wake-pages)
  };
  const names = Object.keys(stubs);
  const src = between(app, '    function voicePopHtml(', '    function voicePopClose(');
  return new Function(...names, src + '\nreturn voicePopHtml;')(...names.map(n => stubs[n]))('c1');
}

test('desktop: the voice pop has the Show an Interrupt button checkbox (data-vp="interrupt") with its help line, after captions, and no Talk button text', () => {
  const html = popHtml();
  assert.ok(/<label class="vp-row"><span class="vp-label">Show an Interrupt button<\/span><input type="checkbox" id="vp-interrupt-c1" data-vp="interrupt"><\/label>/.test(html), 'the row');
  assert.ok(html.indexOf('data-vp="captions"') < html.indexOf('data-vp="interrupt"'), 'after captions');
  assert.ok(html.indexOf(`<div class="vp-display-note">${HINT}</div>`) > html.indexOf('data-vp="interrupt"'), 'the help line follows');
  assert.ok(!/Talk button/i.test(html));
  assert.ok(/else if \(k === 'interrupt'\) voiceDispSetInterrupt\(chatId, t\.checked\);/.test(app), 'the change handler');
});

test('desktop: voiceDispSetInterrupt reaches a running display; with none it saves { interrupt } through the prefs; the panel checkbox follows', async () => {
  const d = desktop({ prefs: { choice: 'orb' } });
  const box = d.doc.add('vp-interrupt-c1', null, 'input'), st = d.doc.add('st-voice-interrupt', null, 'input');
  d.doc.querySelectorAll = () => [];   // the open voice pops (none in this harness)
  d.api.voiceDispBegin('c1', 'bob'); await tick();
  const cur = d.api.voiceDisp.cur; assert.ok(cur, 'a display is running');
  const seen = []; cur.setInterruptButton = (v) => { seen.push(v); };
  d.api.voiceDispSetInterrupt('c1', true); d.api.voiceDispSetInterrupt('c1', false);
  assert.deepStrictEqual(seen, [true, false]);
  d.api.voiceDispEnd(false);
  d.api.voiceDispSetInterrupt('c1', true); await tick(30);
  assert.strictEqual(JSON.parse(d.storage.m.get(CD.DISPLAY_STORE_KEY)).interrupt, true);
  assert.strictEqual(box.checked, true, 'the panel checkbox'); assert.strictEqual(st.checked, true, 'the Settings checkbox');
  d.api.voiceDispSetInterrupt('c1', false); await tick(30);
  assert.strictEqual(JSON.parse(d.storage.m.get(CD.DISPLAY_STORE_KEY)).interrupt, false);
  assert.strictEqual(box.checked, false); assert.strictEqual(st.checked, false);
});

test('desktop: voiceDispPaintPanel sets the interrupt checkbox from the prefs (off by default)', async () => {
  const off = desktop(); const b0 = off.doc.add('vp-interrupt-c1', null, 'input'); b0.checked = true;
  await off.api.voiceDispPaintPanel('c1'); assert.strictEqual(b0.checked, false, 'off by default');
  const on = desktop({ prefs: { interrupt: true } }); const b1 = on.doc.add('vp-interrupt-c1', null, 'input');
  await on.api.voiceDispPaintPanel('c1'); assert.strictEqual(b1.checked, true);
});

test('desktop: Settings Voices has st-voice-interrupt, painted from the display prefs and saved as a display pref (not a voice pref)', () => {
  assert.ok(/id="st-voice-interrupt" \$\{voiceInterruptNow\(\) \? 'checked' : ''\} onchange="voiceDispSetInterrupt\(null, this\.checked\)"> Show an Interrupt button<\/label>[^`]*\$\{VOICE_INTERRUPT_HINT\}/.test(app));
  assert.ok(/const VOICE_INTERRUPT_HINT = 'For places where talking over the reply doesn\\'t register\.';/.test(app));
  assert.ok(/CallDisplay\.loadDisplayPrefs\(localStorage\)\.interrupt === true/.test(app));
  assert.ok(/for \(const e of document\.querySelectorAll\('\.voice-pop \[data-vp="interrupt"\]'\)\) e\.checked = on;/.test(app), 'every open pop follows');
  const save = between(app, '    function voiceSettingsSavePrefs() {', '    function voiceTestStop(');
  assert.ok(!/interrupt(?!Sensitivity)/i.test(save.replace(/interruptSensitivity|interrupt sensitivity/gi, '')), 'not part of the voice prefs');
  assert.ok(!/Talk button/i.test(app));
});

test('phone: #voice-panel has #vp-interrupt right after #vp-captions with the help line; the change is wired; the paint sets it; no Talk button text', async () => {
  const a = mobHtml.indexOf('id="vp-captions"'), b = mobHtml.indexOf('id="vp-interrupt"');
  assert.ok(a > 0 && b > a, 'after captions');
  assert.ok(/<label class="vs-check"><input type="checkbox" id="vp-interrupt"> <span>Show an Interrupt button<\/span><\/label>\s*<p class="vs-hint vp-hint">For places where talking over the reply doesn't register\.<\/p>/.test(mobHtml));
  assert.ok(mobHtml.indexOf('id="vp-think"') > b);
  assert.ok(/\$\('vp-interrupt'\)\?\.addEventListener\('change', \(e\) => voiceDispSetInterrupt\(!!e\.target\.checked\)\);/.test(mob));
  assert.ok(!/Talk button/i.test(mob + mobHtml));
  const off = phone(); const v = off.doc.add('vp-interrupt', null, 'input'); v.checked = true;
  await off.api.voiceDispPaintPanel(); assert.strictEqual(v.checked, false, 'off by default');
  const on = phone({ prefs: { interrupt: true } }); const w = on.doc.add('vp-interrupt', null, 'input');
  await on.api.voiceDispPaintPanel(); assert.strictEqual(w.checked, true);
});

test('phone: voiceDispSetInterrupt reaches a running display or saves the pref; vp-interrupt and vs-interrupt stay in step', async () => {
  const p = phone({ prefs: { choice: 'orb' } });
  const a = p.doc.add('vp-interrupt', null, 'input'), s = p.doc.add('vs-interrupt', null, 'input');
  p.api.voiceDispSetInterrupt(true); await tick(30);
  assert.strictEqual(JSON.parse(p.storage.m.get(CD.DISPLAY_STORE_KEY)).interrupt, true);
  assert.strictEqual(a.checked, true); assert.strictEqual(s.checked, true);
  const seen = []; p.api.voiceDisp.cur = { setInterruptButton: (v) => { seen.push(v); } };   // a running display
  p.api.voiceDispSetInterrupt(false); assert.deepStrictEqual(seen, [false]);
});

test('phone: the Voice sheet has vs-interrupt with the help line, wired to voiceDispSetInterrupt and painted from the display prefs', () => {
  const sheet = between(mob, 'function voiceSheet() {', 'function paintVoiceSheet() {');
  assert.ok(/<label class="vs-check"><input type="checkbox" id="vs-interrupt"> <span>Show an Interrupt button<\/span><\/label>' \+\s*'<p class="vs-hint">' \+ VOICE_INTERRUPT_HINT \+ '<\/p>'/.test(sheet));
  assert.ok(/sh\.querySelector\('#vs-interrupt'\)\.addEventListener\('change', \(e\) => voiceDispSetInterrupt\(!!e\.target\.checked\)\);/.test(sheet));
  const paint = between(mob, 'function paintVoiceSheet() {', 'function openVoiceSheet() {');
  assert.ok(/sh\.querySelector\('#vs-interrupt'\)[\s\S]*CallDisplay\.loadDisplayPrefs\(localStorage\)\.interrupt === true/.test(paint));
  assert.ok(/const VOICE_INTERRUPT_HINT = 'For places where talking over the reply doesn\\'t register\.';/.test(mob));
});

// ═══════════════ the paint after a wait: the newest paint and the newest prefs win; boxes at once; a skipped select is filled on blur ═══════════════
// A fetch the test settles by hand: each call is parked; settle(i) answers the i-th request with the installed characters.
function manualFetch() {
  const parked = [];
  const f = () => new Promise((res) => { parked.push(() => res({ ok: true, status: 200, json: async () => ({ packs: PACKS }) })); });
  return { f, parked, settle: (i) => parked[i]() };
}
const savePrefs = (storage, p) => storage.setItem(CD.DISPLAY_STORE_KEY, JSON.stringify(p));

test('desktop: two paints whose answers arrive in reverse order end on the newest prefs (the older answer does not put back the old choice)', async () => {
  const m = manualFetch();
  const d = desktop({ prefs: { choice: 'none', interrupt: false }, fetch: m.f });
  const intr = d.doc.add('vp-interrupt-c1', null, 'input');
  const p1 = d.api.voiceDispPaintPanel('c1');                       // reads the old prefs
  savePrefs(d.storage, { choice: 'pack:owl', captions: false, interrupt: true });   // the person chose meanwhile
  const p2 = d.api.voiceDispPaintPanel('c1');
  assert.strictEqual(m.parked.length, 2);
  m.settle(1); await p2; assert.strictEqual(d.barSel.value, 'pack:owl'); assert.strictEqual(d.panelSel.value, 'pack:owl'); assert.strictEqual(intr.checked, true);
  m.settle(0); await p1;                                            // the older answer comes last
  assert.strictEqual(d.barSel.value, 'pack:owl', 'bar select'); assert.strictEqual(d.panelSel.value, 'pack:owl', 'panel select');
  assert.strictEqual(intr.checked, true, 'interrupt checkbox');
});

test('desktop: the older paint answering first is dropped too: after both answers the selects show the prefs as they are then', async () => {
  const m = manualFetch();
  const d = desktop({ prefs: { choice: 'none' }, fetch: m.f });
  const p1 = d.api.voiceDispPaintPanel('c1');
  savePrefs(d.storage, { choice: 'pack:owl', interrupt: true });
  const p2 = d.api.voiceDispPaintPanel('c1');
  m.settle(0); await p1; assert.strictEqual(d.barSel.children.length, 0, 'the superseded paint paints nothing');
  m.settle(1); await p2; assert.strictEqual(d.barSel.value, 'pack:owl');
});

test('desktop: the captions and interrupt checkboxes are set at once, before the packs answer', async () => {
  const d = desktop({ prefs: { choice: 'orb', captions: true, interrupt: true }, fetch: () => new Promise(() => {}) });
  const cap = d.doc.add('vp-captions-c1', null, 'input'), intr = d.doc.add('vp-interrupt-c1', null, 'input');
  d.api.voiceDispPaintPanel('c1');   // never answered
  assert.strictEqual(cap.checked, true); assert.strictEqual(intr.checked, true);
  await tick(); assert.strictEqual(d.barSel.children.length, 0, 'the lists wait for the packs');
});

test('desktop: the bar and the voice pop repaint the Display select on focusout (listener source run), a skipped select is then filled', async () => {
  const listeners = {};
  const re = /(bar|pop)\.addEventListener\('focusout', (\(e\) => \{[^\n]*\})\);\s*\/\//g; let mm;
  while ((mm = re.exec(app))) listeners[mm[1]] = mm[2];
  assert.ok(listeners.bar && /dataset\.vcb === 'display'/.test(listeners.bar), 'the call bar has a focusout listener for data-vcb="display"');
  assert.ok(listeners.pop && /dataset\.vp === 'display'/.test(listeners.pop), 'the voice pop has a focusout listener for data-vp="display"');
  assert.ok(/function voiceCallShowBar\([\s\S]*?bar\.addEventListener\('focusout'[\s\S]*?function voiceCallHideBar\(/.test(app), 'the bar one is in voiceCallShowBar');
  assert.ok(/function voicePopToggle\([\s\S]*?pop\.addEventListener\('focusout'/.test(app), 'the pop one is in voicePopToggle');
  for (const [which, key] of [['bar', 'vcb'], ['pop', 'vp']]) {
    const d = desktop({ prefs: { choice: 'orb' } }), sel = which === 'bar' ? d.barSel : d.panelSel;
    const run = (w, target) => new Function('voiceDispPaintPanel', 'chatId', `return ${listeners[w]};`)(d.api.voiceDispPaintPanel, 'c1')({ target });
    sel.dataset = { [key]: 'display' }; sel.value = 'stale';
    d.doc.activeElement = sel; await d.api.voiceDispPaintPanel('c1');
    assert.strictEqual(sel.children.length, 0, which + ': skipped while it has focus'); assert.strictEqual(sel.value, 'stale');
    d.doc.activeElement = null;   // focus left: the browser's focusout
    run(which, { dataset: { [key]: 'mic' } }); await tick(30); assert.strictEqual(sel.children.length, 0, which + ': another control losing focus does nothing');
    run(which, sel); await tick(30);
    assert.ok(optionsOf(sel).some(([v, t]) => v === 'pack:owl' && t === 'Owl'), which + ': filled with the installed characters'); assert.strictEqual(sel.value, 'orb');
  }
});

test('phone: two paints whose answers arrive in reverse order end on the newest prefs', async () => {
  const m = manualFetch();
  const p = phone({ prefs: { choice: 'none' }, fetch: m.f });
  const intr = p.doc.add('vp-interrupt', null, 'input');
  const p1 = p.api.voiceDispPaintPanel();
  savePrefs(p.storage, { choice: 'pack:owl', interrupt: true });
  const p2 = p.api.voiceDispPaintPanel();
  assert.strictEqual(m.parked.length, 2);
  m.settle(1); await p2; assert.strictEqual(p.cp.value, 'pack:owl'); assert.strictEqual(intr.checked, true);
  m.settle(0); await p1;
  assert.strictEqual(p.cp.value, 'pack:owl', '#cp-display'); assert.strictEqual(p.vp.value, 'pack:owl', '#vp-display'); assert.strictEqual(intr.checked, true, 'interrupt checkbox');
});

test('phone: the captions and interrupt checkboxes are set at once, before the packs answer', async () => {
  const p = phone({ prefs: { choice: 'orb', captions: true, interrupt: true }, fetch: () => new Promise(() => {}) });
  const cap = p.doc.add('vp-captions', null, 'input'), intr = p.doc.add('vp-interrupt', null, 'input');
  p.api.voiceDispPaintPanel();
  assert.strictEqual(cap.checked, true); assert.strictEqual(intr.checked, true);
});

test('phone: #cp-display and #vp-display repaint on blur; a select skipped while it had focus is filled by the next paint', async () => {
  assert.ok(/function voiceCallWire\(\)[\s\S]*?\$\('cp-display'\)\?\.addEventListener\('blur', \(\) => voiceDispPaintPanel\(\)\)/.test(mob), 'cp-display blur in voiceCallWire');
  assert.ok(/function voicePanelWire\(\)[\s\S]*?\$\('vp-display'\)\?\.addEventListener\('blur', \(\) => voiceDispPaintPanel\(\)\)/.test(mob), 'vp-display blur in voicePanelWire');
  const p = phone({ prefs: { choice: 'orb' } });
  p.cp.value = 'stale'; p.doc.activeElement = p.cp;
  await p.api.voiceDispPaintPanel();
  assert.strictEqual(p.cp.children.length, 0, 'skipped while focused'); assert.strictEqual(p.vp.value, 'orb');
  p.doc.activeElement = null;   // blur: the listener runs the paint again
  await p.api.voiceDispPaintPanel();
  assert.ok(optionsOf(p.cp).some(([v, t]) => v === 'pack:owl' && t === 'Owl')); assert.strictEqual(p.cp.value, 'orb');
});
