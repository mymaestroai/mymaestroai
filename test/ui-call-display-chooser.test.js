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
    window: win, document: doc, localStorage: storage, fetch: facesFetch, AGENTS: [{ name: 'bob', callDisplay: 'none' }], chats: { c1: { agent: 'bob' } },
    voiceById: (id) => doc.getElementById(id), voiceCallS: S, voiceCallHangUp() {}, voicePopToggle() { pop.hidden = false; }, voicePopClose() { pop.hidden = true; }, CallDisplay: CD, voicePlay: { token: 1, ctx: null },
    voiceSpeedNow: () => 1, hubToast() {}, setTimeout, clearTimeout, Promise, voiceCallRunning: () => false, hubOriginLabel: () => '', voiceSentences: (t) => [t], voiceSpeechText: (t) => t,
    VOICE_HANGUP_SVG: '', voicePauseSelectHtml: (id, attrs) => `<select id="${id}" ${attrs}></select>`, voiceMicLevelNow: () => 50, voiceSensNow: () => 50, voiceSpeedLabel: () => '1x', VOICE_SPEED_HINT: '', VOICE_CALL_HELP: '',
  };
  const names = Object.keys(stubs);
  const glue = between(app, '    const voiceDisp = {', '    const VOICE_CALL_HELP');
  const bar = between(app, '    function voiceCallBarHtml(', '    function voiceCallShowBar(');
  const retry = between(app, '    function voiceCallRetryMicTap(', '    function voiceCallHideBar(');   // onRetryMic is handed to the display at begin
  const code = [glue, bar, retry, 'return { voiceDisp, voiceDispBegin, voiceDispEnd, voiceDispSetChoice, voiceDispPaintPanel, voiceCallBarHtml };'].join('\n');
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
    window: win, document: doc, localStorage: storage, fetch: facesFetch, agents: [{ name: 'bob', callDisplay: 'none' }], current: 'bob', $: (id) => doc.getElementById(id),
    CallDisplay: CD, voicePlay, URL: { createObjectURL: () => 'blob:0', revokeObjectURL() {} }, Audio, voiceOn: () => true, api: async () => ({ ok: true }), toast() {},
    voiceSpeedNow: () => 1, voiceWaitLocalVoice: async () => ({ lang: 'en' }), SpeechSynthesisUtterance: function (t) { this.text = t; }, voicePanelPaint() {},
    voiceCallHangUp() {}, originLabel: () => '', setTimeout, clearTimeout, Promise, Blob: function Blob() {}, Float32Array, voiceEncodeWav: () => new Uint8Array(1),
  };
  const names = Object.keys(stubs);
  const glue = between(mob, 'const voiceDisp = {', 'function voiceCallPaintState(');
  const code = ['let voiceCall = null;', glue, 'return { voiceDisp, voiceDispBegin, voiceDispEnd, voiceDispSetChoice, voiceDispPaintPanel };'].join('\n');
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
  const ml = between(mob, '      micLost: (on) => {', '      state: (name)');
  assert.ok(ml.indexOf('if (voiceCall !== vc) return;') >= 0 && /if \(typeof voiceDisplayHook === 'function'\) voiceDisplayHook\('micLost', !!on\);/.test(ml), 'guarded by the same call check');
  assert.ok(/id="cp-levels" class="cp-levels">Levels</.test(mobHtml), 'Levels keeps its name');
});
