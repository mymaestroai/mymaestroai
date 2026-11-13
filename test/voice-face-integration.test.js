'use strict';
// The call display wired into the real pages: the page helpers of app.js (desktop) and mobile.js (phone) are cut out of the
// files and RUN here against a fake DOM, a fake audio context and injected players (the same VM way the other page tests work),
// with the real lib/ui-call-display.js. Proves wiring, ordering and parity; it cannot prove how any of it looks or sounds.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
Object.assign(globalThis, require('../lib/ui-voice'));
const CD = require('../lib/ui-call-display');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('app.js'), mob = read('mobile.js');
const tick = async (n = 12) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
function between(src, a, b) { const i = src.indexOf(a); assert.ok(i >= 0, 'start marker: ' + a); const j = src.indexOf(b, i + a.length); assert.ok(j > i, 'end marker: ' + b); return src.slice(i, j); }

// ── fakes (compact versions of the ones in ui-call-display.test.js) ──
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
  doc.find = (cls) => doc.body.all().filter(n => (' ' + n.className + ' ').includes(' ' + cls + ' '));
  doc.add = (id, parent) => { const e = new El('div'); e.id = id; doc.byId.set(id, e); (parent || doc.body).appendChild(e); return e; };
  return doc;
}
const memStorage = (init) => { const m = new Map(Object.entries(init || {})); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };
function players(log, kind, o) {
  return (host, options) => {
    const p = { kind, options, calls: [], destroyed: false };
    for (const n of ['setState', 'setAnalyser', 'setMicLevel', 'speechEvent']) p[n] = (...a) => { p.calls.push([n, ...a]); };
    p.react = (m) => { p.calls.push(['react', m]); return kind === 'pack' ? true : CD.MOODS.includes(m); };
    p.destroy = () => { p.destroyed = true; };
    p.ready = Promise.resolve(p);
    p.last = (n) => { const c = p.calls.filter(x => x[0] === n); return c.length ? c[c.length - 1][1] : undefined; };
    p.all = (n) => p.calls.filter(x => x[0] === n).map(c => c[1]);
    log.push(p); return p;
  };
}
const PACKS = [{ id: 'owl', name: 'Owl', background: '#ffd6ab', hasReactions: true }];
const facesFetch = (packs) => async (u) => { assert.strictEqual(u, '/api/faces'); return { ok: true, status: 200, json: async () => ({ packs }) }; };
function fakeAnalyserCtx(state) {
  const ctx = { state: state || 'running', destination: { id: 'dest' }, sources: [], analysers: [], resumed: 0, closed: 0,
    resume() { ctx.resumed++; return Promise.resolve(); }, close() { ctx.closed++; return Promise.resolve(); },
    createAnalyser() { const a = { connected: [], connect(x) { this.connected.push(x); } }; ctx.analysers.push(a); return a; },
    createMediaElementSource(el) { const s = { el, connected: [], connect(x) { this.connected.push(x); } }; ctx.sources.push(s); return s; },
    decodeAudioData: async (b) => ({ dur: 1, b }),
    createBufferSource() { const s = { connected: [], stopped: 0, connect(x) { this.connected.push(x); }, start() { s.started = true; }, stop() { s.stopped++; setImmediate(() => s.onended && s.onended()); } }; ctx.sources.push(s); return s; } };
  return ctx;
}

// ═══════════════ desktop page (app.js) ═══════════════
function desktop(o) {
  o = o || {};
  const doc = fakeDom(), storage = memStorage(o.prefs ? { [CD.DISPLAY_STORE_KEY]: JSON.stringify(o.prefs) } : {});
  const orbs = [], faces = [], log = { hang: 0, popClosed: 0, popOpened: 0, hub: [] };
  const win = { document: doc, createVoiceOrb: players(orbs, 'orb'), createFacePlayer: players(faces, 'pack'), speechSynthesis: o.synth };
  const ctx = fakeAnalyserCtx();
  const S = { call: null, chatId: 'c1', agent: 'bob', own: new Map(), hub: new Map(), asks: new Map(), sendSeq: 0, active: true, vad: null };
  const callbar = doc.add('voice-callbar-c1'), hangBtn = new doc.El('button'); hangBtn.className = 'vcb-hang'; callbar.appendChild(hangBtn); callbar.querySelector = (s) => (s === '.vcb-hang' ? hangBtn : null);   // "Show display" goes inside the bar, beside Hang up
  const host = doc.add('home'), pop = doc.add('voice-pop-c1', host); pop.hidden = true;
  const voicePlay = { token: 1, ctx, source: null, btn: null };
  const stubs = {
    window: win, document: doc, localStorage: storage, fetch: o.fetch || facesFetch(PACKS), AGENTS: o.agents || [{ name: 'bob', callDisplay: 'none' }], chats: { c1: { agent: 'bob' } },
    voiceById: (id) => doc.getElementById(id), voiceCallS: S, voiceCallHangUp: () => { log.hang++; }, voicePopToggle: () => { log.popOpened++; pop.hidden = false; }, voicePopClose: () => { log.popClosed++; pop.hidden = true; },
    CallDisplay: CD, voicePlay,
    voiceFetchTts: async () => new ArrayBuffer(8), voiceSpeedNow: () => 1, voiceWaitLocalVoice: async () => ({ lang: 'en' }), hubToast() {}, voiceOfflineHint: '', voicePlayState() {},
    SpeechSynthesisUtterance: function (t) { this.text = t; }, setTimeout, clearTimeout, Promise, voiceCallRunning: () => false, hubOriginLabel: () => '', voiceSentences: (t) => [t], voiceSpeechText: (t) => t,
  };
  const names = Object.keys(stubs);
  const glue = between(app, '    const voiceDisp = {', '    const VOICE_CALL_HELP');
  const stop = between(app, '    function voiceStopPlayback() {', '    async function voiceFetchTts');
  const hub = between(app, '    function voiceCallSseMood(', "    document.addEventListener('visibilitychange', () => {   // a hidden tab");
  const play = between(app, '    async function voicePlayHub(', '    // opts: { sentences, voice }.');
  const code = [glue, stop, play, hub, 'return { voiceDisp, voiceDispBegin, voiceDispEnd, voiceDispVad, voiceDispTalk, voiceFacePackBody, voiceStopPlayback, voicePlayHub, voicePlayDevice, voiceCallSseMood, voiceCallHubEvent, voiceDisplayHook, voiceDispSetChoice, voiceDispSetCaptions, voiceDispPaintPanel };'].join('\n');
  const api = new Function(...names, code)(...names.map(n => stubs[n]));
  // the fake call the page drives (state is what the controller reports)
  const calls = [];
  S.call = { state: 'listening', onSpeechStart() { calls.push('onSpeechStart'); this.state = 'hearing'; }, onMisfire() { calls.push('onMisfire'); this.state = 'listening'; }, callId: 'k1' };
  return { api, doc, orbs, faces, storage, log, ctx, S, callbar, pop, host, voicePlay, calls, win };
}

test('desktop: the display starts inside the call start; the agent default is used only when the device has not chosen; None changes nothing', async () => {
  let d = desktop({ agents: [{ name: 'bob', callDisplay: 'orb' }] });
  d.api.voiceDispBegin('c1', 'bob'); await tick();
  assert.strictEqual(d.orbs.length, 1, 'unset device choice follows the agent default (Orb)');
  assert.ok(d.doc.find('ucd-overlay').length === 1);
  d = desktop({ agents: [{ name: 'bob', callDisplay: 'orb' }], prefs: { choice: 'none' } });
  d.api.voiceDispBegin('c1', 'bob'); await tick();
  assert.strictEqual(d.orbs.length + d.faces.length, 0, 'the device choice None wins over the agent default');
  assert.strictEqual(d.doc.find('ucd-overlay').length, 0);
  assert.deepStrictEqual(d.api.voiceFacePackBody(), {});
  d = desktop({ agents: [{ name: 'bob', callDisplay: 'pack:owl' }] });
  d.api.voiceDispBegin('c1', 'bob'); await tick();
  assert.strictEqual(d.faces.length, 1); assert.strictEqual(d.faces[0].options.packId, 'owl');
  d = desktop({});   // no agent default, nothing chosen
  d.api.voiceDispBegin('c1', 'bob'); await tick();
  assert.strictEqual(d.orbs.length + d.faces.length, 0, 'default for a new device without an agent default: None');
});

test('desktop: facePack goes with the message only while a character with reactions is on screen (not Orb, not None, not hidden, not after hang-up)', async () => {
  let d = desktop({ prefs: { choice: 'pack:owl' } }); d.api.voiceDispBegin('c1', 'bob'); await tick();
  assert.deepStrictEqual(d.api.voiceFacePackBody(), { facePack: 'owl' });
  d.doc.find('ucd-back')[0].click(); assert.deepStrictEqual(d.api.voiceFacePackBody(), {}, 'back to chat: the character is not shown');
  d.doc.find('ucd-reopen')[0].click(); assert.deepStrictEqual(d.api.voiceFacePackBody(), { facePack: 'owl' });
  d.api.voiceDispEnd(false); assert.deepStrictEqual(d.api.voiceFacePackBody(), {});
  d = desktop({ prefs: { choice: 'orb' } }); d.api.voiceDispBegin('c1', 'bob'); await tick(); assert.deepStrictEqual(d.api.voiceFacePackBody(), {});
  d = desktop({ prefs: { choice: 'pack:ghost' } }); d.api.voiceDispBegin('c1', 'bob'); await tick(); assert.deepStrictEqual(d.api.voiceFacePackBody(), {}, 'a missing pack: no tag request');
  assert.strictEqual(JSON.parse(d.storage.m.get(CD.DISPLAY_STORE_KEY)).choice, 'pack:ghost', 'and the saved choice is untouched');
  assert.ok(/\.\.\.\(chat\.voiceSend && typeof voiceFacePackBody === 'function' \? voiceFacePackBody\(\) : \{\}\)/.test(app), 'the send body carries it only for voice sends');
  assert.ok(/\.\.\.\(fallback && fallback\.voice && typeof voiceFacePackBody === 'function' \? voiceFacePackBody\(\) : \{\}\)/.test(mob), 'and on the phone');
});

test('desktop: reply audio goes source -> analyser -> destination, starts the beak when it really plays, and a stop closes it at once', async () => {
  const d = desktop({ prefs: { choice: 'pack:owl' } }); d.api.voiceDispBegin('c1', 'bob'); await tick();
  const p = d.faces[0]; d.api.voiceDisplayHook('setState', 'listening'); d.api.voiceDisplayHook('setState', 'speaking');
  assert.strictEqual(p.last('setState'), 'thinking');
  const run = d.api.voicePlayHub('bob', ['One.', 'Two.'], undefined, 1);
  await tick(30);
  const src = d.ctx.sources.find(s => s.started);
  assert.ok(src, 'the first sentence started');
  assert.strictEqual(src.connected.length, 1); assert.strictEqual(src.connected[0], d.ctx.analysers[0], 'only to the analyser');
  assert.deepStrictEqual(d.ctx.analysers[0].connected, [d.ctx.destination]);
  assert.strictEqual(p.last('setAnalyser'), d.ctx.analysers[0]); assert.strictEqual(p.last('setState'), 'speaking');
  d.api.voiceStopPlayback();   // barge-in
  assert.strictEqual(p.last('setAnalyser'), null, 'closed immediately, before the source even reports its end');
  d.voicePlay.token = 2; await run;
  assert.strictEqual(d.ctx.analysers.length, 1, 'one analyser');
});

test('desktop: with None the same playback code connects straight to the destination (nothing routed, nothing duplicated)', async () => {
  const d = desktop({ prefs: { choice: 'none' } }); d.api.voiceDispBegin('c1', 'bob'); await tick();
  const run = d.api.voicePlayHub('bob', ['One.'], undefined, 1); await tick(30);
  const src = d.ctx.sources.find(s => s.started); assert.deepStrictEqual(src.connected, [d.ctx.destination]); assert.strictEqual(d.ctx.analysers.length, 0);
  src.onended && src.onended(); await run;
});

test('desktop: captions show the sentence that is actually playing; device speech start / boundary / pause / resume / end reach the player; an error ends it', async () => {
  const synth = { speak(u) { synth.u = u; }, cancel() {} };
  const d = desktop({ prefs: { choice: 'pack:owl', captions: true }, synth }); d.api.voiceDispBegin('c1', 'bob'); await tick();
  const p = d.faces[0], cap = () => d.doc.find('ucd-caption')[0].textContent;
  d.api.voiceDisplayHook('setState', 'speaking');
  const run = d.api.voicePlayDevice(['Hello friend.', 'Second one.'], 0, 1); await tick(10);
  assert.strictEqual(cap(), '', 'nothing shown before the device voice really starts');
  const u = synth.u; u.onstart(); assert.strictEqual(cap(), 'Hello friend.'); assert.strictEqual(p.last('setState'), 'speaking');
  u.onboundary(); u.onpause(); u.onresume();
  assert.deepStrictEqual(p.all('speechEvent'), ['start', 'boundary', 'pause', 'resume']);
  u.onend(); assert.strictEqual(p.last('speechEvent'), 'end'); await tick(10);
  const u2 = synth.u; assert.notStrictEqual(u2, u); u2.onstart(); assert.strictEqual(cap(), 'Second one.'); u2.onerror(); assert.strictEqual(p.last('speechEvent'), 'end');
  await run;
});

test('desktop: a mood arrives by the chat stream or the hub event, plays once per turn, only for the call own turns, and nothing after hang-up', async () => {
  const d = desktop({ prefs: { choice: 'pack:owl' } }); d.api.voiceDispBegin('c1', 'bob'); await tick();
  const p = d.faces[0], S = d.S;
  S.sendSeq = 1; d.api.voiceCallHubEvent('turn_start', { agent: 'bob', turnId: 't1', origin: { kind: 'user' } });
  d.api.voiceCallHubEvent('turn_mood', { agent: 'bob', turnId: 'tX', mood: 'proud' });
  assert.strictEqual(p.all('react').length, 0, 'not the call own turn');
  d.api.voiceCallHubEvent('turn_mood', { agent: 'bob', turnId: 't1', mood: 'proud' });
  d.api.voiceCallSseMood('c1', 'proud'); d.api.voiceCallSseMood('c1', 'laughing');
  assert.deepStrictEqual(p.all('react'), ['proud'], 'the stream chunk and the hub event of one turn count once');
  S.sendSeq = 2; d.api.voiceCallHubEvent('turn_start', { agent: 'bob', turnId: 't2', origin: { kind: 'user' } });
  d.api.voiceCallSseMood('c1', 'curious'); d.api.voiceCallHubEvent('turn_mood', { agent: 'bob', turnId: 't2', mood: 'curious' });
  d.api.voiceCallSseMood('other', 'proud');
  assert.deepStrictEqual(p.all('react'), ['proud', 'curious']);
  d.api.voiceDispEnd(false);
  S.sendSeq = 3; d.api.voiceCallSseMood('c1', 'delighted'); d.api.voiceCallHubEvent('turn_mood', { agent: 'bob', turnId: 't2', mood: 'delighted' });
  assert.deepStrictEqual(p.all('react'), ['proud', 'curious'], 'stale after hang-up');
  assert.ok(/source\.addEventListener\('turn_mood'/.test(app) && /oc2\.type === 'voice_mood'/.test(app), 'both subscriptions are wired');
});

test('desktop: Talk goes through the controller entry points and a silent microphone is released; the VAD handlers pass through the floor', async () => {
  const d = desktop({ prefs: { choice: 'orb' } }); d.api.voiceDispBegin('c1', 'bob'); await tick();
  const seen = []; const vad = { start: (h) => { seen.push(h); return Promise.resolve(); }, stop() {}, setPlaybackActive() {} };
  const wrapped = d.api.voiceDispVad(vad); const handlers = { onSpeechBegin() { seen.push('begin'); }, onSpeechEnd() { seen.push('end'); }, onMisfire() {}, onSpeechStart() {}, onFrame() {} };
  wrapped.start(handlers);
  assert.notStrictEqual(seen[0], handlers, 'the page hands the VAD the floor-wrapped handlers'); seen[0].onSpeechBegin(); assert.strictEqual(seen[1], 'begin');
  d.doc.find('ucd-talk')[0].click(); assert.deepStrictEqual(d.calls, ['onSpeechStart']);
  assert.strictEqual(d.S.call.state, 'hearing');
  assert.strictEqual(typeof wrapped.setPlaybackActive, 'function');
  d.api.voiceDispEnd(false);   // the floor is cancelled with the call: no release timer fires into a dead call
  assert.strictEqual(d.api.voiceDisp.floor, null);
});

test('desktop: the real call bar and voice panel move into the view and are back in the chat before the call is torn down; hang-up says goodbye; release is immediate', async () => {
  const d = desktop({ prefs: { choice: 'pack:owl' } });
  const barHome = d.callbar.parentNode, popHome = d.pop.parentNode, barSibs = barHome.children.slice();
  d.api.voiceDispBegin('c1', 'bob'); await tick();
  const ov = d.doc.find('ucd-overlay')[0];
  assert.ok(ov.contains(d.callbar) && ov.contains(d.pop), 'the actual bar and panel are in the view');
  assert.strictEqual(d.log.popOpened, 1, 'the panel was built through its own opener'); assert.strictEqual(d.pop.hidden, false);
  assert.ok(d.doc.find('voice-extra').length === 1, 'wrapped as .voice-extra so the page outside-click closer leaves it alone');
  d.api.voiceDispEnd(true);
  assert.strictEqual(d.callbar.parentNode, barHome, 'the bar is back the moment hang-up begins'); assert.strictEqual(d.pop.parentNode, popHome); assert.deepStrictEqual(barHome.children.filter(c => c !== d.pop && !c.className.includes('ucd')), barSibs.filter(c => c !== d.pop));
  assert.ok(d.doc.find('ucd-overlay')[0], 'the goodbye is still on screen'); assert.strictEqual(d.faces[0].last('react'), 'goodbye');
  assert.strictEqual(d.api.voiceDisp.cur, null); assert.ok(d.api.voiceDisp.last, 'kept only for the goodbye');
  d.api.voiceDispBegin('c1', 'bob'); await tick();   // a new call while the old goodbye plays: the old one is let go at once
  assert.strictEqual(d.faces[0].destroyed, true); assert.strictEqual(d.doc.find('ucd-overlay').length, 1, 'one view only');
  d.api.voiceDispEnd(false);
  assert.strictEqual(d.doc.find('ucd-overlay').length, 0); assert.strictEqual(d.callbar.parentNode, barHome);
});

test('desktop: the voice panel selector saves the device choice, changes a running call live, and the call is not ended', async () => {
  const d = desktop({ prefs: { choice: 'pack:owl' } }); d.api.voiceDispBegin('c1', 'bob'); await tick();
  d.api.voiceDispSetChoice('c1', 'orb'); await tick();
  assert.strictEqual(JSON.parse(d.storage.m.get(CD.DISPLAY_STORE_KEY)).choice, 'orb'); assert.strictEqual(d.orbs.length, 1); assert.ok(d.faces[0].destroyed); assert.strictEqual(d.log.hang, 0);
  d.api.voiceDispSetCaptions('c1', true); assert.strictEqual(JSON.parse(d.storage.m.get(CD.DISPLAY_STORE_KEY)).captions, true);
  d.api.voiceDispEnd(false);
  d.api.voiceDispSetChoice('c1', 'pack:ghost');   // outside a call: just saved
  assert.strictEqual(JSON.parse(d.storage.m.get(CD.DISPLAY_STORE_KEY)).choice, 'pack:ghost');
});

// ═══════════════ phone page (mobile.js) ═══════════════
function phone(o) {
  o = o || {};
  const doc = fakeDom(), storage = memStorage(o.prefs ? { [CD.DISPLAY_STORE_KEY]: JSON.stringify(o.prefs) } : {});
  const orbs = [], faces = [], order = [], ctxs = [];
  function AC() { const c = fakeAnalyserCtx(o.ctxState); order.push('ctx'); const r = c.resume; c.resume = () => { order.push('resume'); return r(); }; ctxs.push(c); return c; }
  const win = { document: doc, AudioContext: AC, createVoiceOrb: players(orbs, 'orb'), createFacePlayer: players(faces, 'pack'), speechSynthesis: o.synth };
  const panel = doc.add('call-panel'), cpHang = doc.add('cp-hangup', panel), home = doc.add('composer'), vpanel = doc.add('voice-panel', home); vpanel.hidden = true;
  const state = { voiceCall: null, hung: 0, painted: 0 };
  const voicePlay = { token: 5, audio: null, url: null, cancel: null, el: null, told: false };
  const urls = []; const URLs = { createObjectURL: () => { const u = 'blob:' + urls.length; urls.push(u); return u; }, revokeObjectURL() {} };
  function Audio() { const a = this; a.src = ''; a.plays = 0; a.paused = true; a.play = () => { a.plays++; order.push('play'); return Promise.resolve(); }; a.pause = () => { a.paused = true; }; }
  const stubs = {
    window: win, document: doc, localStorage: storage, fetch: facesFetch(PACKS), agents: o.agents || [{ name: 'bob', callDisplay: 'none' }], current: 'bob', $: (id) => doc.getElementById(id),
    CallDisplay: CD, voicePlay, URL: URLs, Audio, voiceOn: () => true, api: async () => ({ ok: true }), toast() {},
    voiceSpeedNow: () => 1, voiceWaitLocalVoice: async () => ({ lang: 'en' }), SpeechSynthesisUtterance: function (t) { this.text = t; }, voicePanelPaint() { state.painted++; },
    voiceCallHangUp: () => { state.hung++; }, originLabel: () => '', setTimeout, clearTimeout, Promise, Blob: function Blob() {}, Float32Array, voiceEncodeWav: () => new Uint8Array(1),
  };
  const names = Object.keys(stubs);
  const glue = between(mob, 'const voiceDisp = {', 'function voiceCallPaintState(');
  const play = between(mob, 'function voiceStopPlayback() {', 'async function voiceTtsBlob');
  const blob = between(mob, 'function voicePlayBlob(', 'async function voiceSpeak(');
  const events = between(mob, 'function voiceCallTurnStart(', 'function voiceCallAsk(');
  const unlock = between(mob, 'function voiceUnlockAudio() {', 'function voiceMarkPlaying(');
  const code = ['let voiceCall = null;', glue, play, blob, events, unlock, 'return { voiceUnlockAudio, get voiceCall() { return voiceCall; }, set voiceCall(v) { voiceCall = v; }, voiceDisp, voiceDispBegin, voiceDispEnd, voiceFacePackBody, voiceStopPlayback, voicePlayBlob, voiceDeviceSpeak, voiceCallTurnStart, voiceCallTurnMood, voiceCallSseMood, voiceDispTalk, voiceDispSetChoice, voiceDisplayHook };'].join('\n');
  const api = new Function(...names, code)(...names.map(n => stubs[n]));
  const vc = { agent: 'bob', callTurns: new Set(), sendSeq: 0, call: { state: 'listening', onSpeechStart() { vc.calls.push('onSpeechStart'); this.state = 'hearing'; }, onMisfire() { vc.calls.push('onMisfire'); this.state = 'listening'; } }, calls: [] };
  api.voiceCall = vc;
  return { api, doc, orbs, faces, storage, order, ctxs, panel, cpHang, vpanel, home, voicePlay, vc, state, win, Audio };
}
const flushPhone = () => tick(30);

test('phone: the audio context is made and resumed synchronously inside the call start (the tap), before any await; None never makes one', async () => {
  const p = phone({ prefs: { choice: 'orb' } });
  p.api.voiceDispBegin(p.vc);   // no await between the tap and here
  assert.deepStrictEqual(p.order.slice(0, 2), ['ctx', 'resume'], 'made and resumed synchronously'); assert.strictEqual(p.ctxs.length, 1);
  await flushPhone(); assert.strictEqual(p.orbs.length, 1);
  const n = phone({ prefs: { choice: 'none' }, agents: [{ name: 'bob', callDisplay: 'orb' }] });
  n.api.voiceDispBegin(n.vc); await flushPhone();
  assert.strictEqual(n.ctxs.length, 0, 'None: no context, no routing'); assert.strictEqual(n.orbs.length + n.faces.length, 0);
  const f = phone({ agents: [{ name: 'bob', callDisplay: 'orb' }] }); f.api.voiceDispBegin(f.vc); await flushPhone();
  assert.strictEqual(f.orbs.length, 1, 'unset: the agent default');
});

test('phone: the reused audio element gets ONE source; the beak starts on the real playing event (not the fetch), closes on end, cut and stop; the audio is never muted when routing is impossible', async () => {
  const p = phone({ prefs: { choice: 'pack:owl' } }); p.api.voiceDispBegin(p.vc); await flushPhone();
  const pl = p.faces[0], ctx = p.ctxs[0];
  p.vc.call.state = 'speaking'; p.api.voiceDisp.cur.setState('speaking');
  assert.strictEqual(pl.last('setState'), 'thinking');
  const first = p.api.voicePlayBlob({}, 5, { text: 'First.' });
  const a = p.voicePlay.audio || null;   // set by voicePlayBlob
  assert.ok(a && a.plays === 1);
  assert.strictEqual(pl.all('setAnalyser').length, 0, 'play() was called but nothing is heard yet: the beak stays closed');
  a.onplaying(); assert.ok(pl.last('setAnalyser') && pl.last('setAnalyser').connect, 'the analyser is attached on the playing event'); assert.strictEqual(pl.last('setState'), 'speaking');
  a.onended(); assert.strictEqual(await first, true); assert.strictEqual(pl.last('setAnalyser'), null);
  const second = p.api.voicePlayBlob({}, 5, { text: 'Second.' }); a.onplaying(); a.onended(); await second;
  const third = p.api.voicePlayBlob({}, 5, { text: 'Third.' }); a.onplaying();
  p.api.voiceStopPlayback();   // barge-in
  assert.strictEqual(pl.last('setAnalyser'), null, 'closed at once'); assert.strictEqual(await third, false);
  assert.strictEqual(ctx.sources.length, 1, 'createMediaElementSource once for the element, however many sentences');
  assert.strictEqual(ctx.sources[0].el, a); assert.strictEqual(ctx.sources[0].connected[0], ctx.analysers[0]); assert.deepStrictEqual(ctx.analysers[0].connected, [ctx.destination], 'source -> analyser -> destination');
  assert.strictEqual(ctx.analysers[0].fftSize, 2048); assert.strictEqual(ctx.analysers[0].smoothingTimeConstant, 0);
  // a context that is not running: the element is not routed (no mute), the beak follows the device-style rhythm
  const q = phone({ prefs: { choice: 'pack:owl' }, ctxState: 'suspended' }); q.api.voiceDispBegin(q.vc); await flushPhone();
  q.vc.call.state = 'speaking'; q.api.voiceDisp.cur.setState('speaking');
  const w = q.api.voicePlayBlob({}, 5, { text: 'Hi.' }); q.voicePlay.audio.onplaying();
  assert.strictEqual(q.ctxs[0].sources.length, 0, 'never routed'); assert.strictEqual(q.faces[0].last('speechEvent'), 'start'); q.voicePlay.audio.onended(); await w;
  // None: the sentence plays natively with no context at all
  const n = phone({ prefs: { choice: 'none' } }); n.api.voiceDispBegin(n.vc); await flushPhone();
  const x = n.api.voicePlayBlob({}, 5, { text: 'Hi.' }); n.voicePlay.audio.onplaying(); n.voicePlay.audio.onended(); await x; assert.strictEqual(n.ctxs.length, 0);
});

test('phone: device speech hooks, captions of the spoken sentence, goodbye and release', async () => {
  const synth = { speak(u) { synth.u = u; }, cancel() {} };
  const p = phone({ prefs: { choice: 'pack:owl', captions: true }, synth }); p.api.voiceDispBegin(p.vc); await flushPhone();
  const pl = p.faces[0], cap = () => p.doc.find('ucd-caption')[0].textContent;
  p.vc.call.state = 'speaking'; p.api.voiceDisp.cur.setState('speaking');
  const done = p.api.voiceDeviceSpeak(['Hello there.'], 5); await tick(10);
  assert.strictEqual(cap(), ''); const u = synth.u; u.onstart(); assert.strictEqual(cap(), 'Hello there.');
  u.onboundary(); u.onpause(); u.onresume(); u.onend(); await done;
  assert.deepStrictEqual(pl.all('speechEvent'), ['start', 'boundary', 'pause', 'resume', 'end']);
  assert.ok(p.doc.find('ucd-overlay').length === 1);
  p.api.voiceDispEnd(true); assert.strictEqual(pl.last('react'), 'goodbye'); assert.strictEqual(p.api.voiceDisp.cur, null);
  assert.strictEqual(p.panel.parentNode, p.doc.body, 'the call panel is back in the page before the page tears the call down');
  p.api.voiceDispEnd(false); p.api.voiceDispBegin(p.vc); await flushPhone(); p.api.voiceDispEnd(false);
  assert.strictEqual(p.doc.find('ucd-overlay').length, 0); assert.ok(p.ctxs.every(c => c.closed === 1), 'the display context is closed with the view');
});

test('phone: moods once per turn from the stream or the hub event; facePack only for a shown character; Talk uses the controller entry points', async () => {
  const p = phone({ prefs: { choice: 'pack:owl' } }); p.api.voiceDispBegin(p.vc); await flushPhone();
  const pl = p.faces[0];
  assert.deepStrictEqual(p.api.voiceFacePackBody(), { facePack: 'owl' });
  p.vc.sendSeq = 1; p.api.voiceCallTurnStart({ agent: 'bob', turnId: 't1', origin: { kind: 'user' } });
  p.api.voiceCallTurnMood({ agent: 'bob', turnId: 'zzz', mood: 'proud' }); assert.strictEqual(pl.all('react').length, 0);
  p.api.voiceCallTurnMood({ agent: 'bob', turnId: 't1', mood: 'proud' }); p.api.voiceCallSseMood({ agent: 'bob' }, 'proud'); p.api.voiceCallSseMood({ agent: 'other' }, 'laughing');
  assert.deepStrictEqual(pl.all('react'), ['proud']);
  p.doc.find('ucd-talk')[0].click(); assert.deepStrictEqual(p.vc.calls, ['onSpeechStart']);
  p.doc.find('ucd-back')[0].click(); assert.deepStrictEqual(p.api.voiceFacePackBody(), {}, 'hidden character: no tag request');
  p.api.voiceDispEnd(false); p.api.voiceCallTurnMood({ agent: 'bob', turnId: 't1', mood: 'curious' }); assert.deepStrictEqual(pl.all('react'), ['proud']);
  const o = phone({ prefs: { choice: 'orb' } }); o.api.voiceDispBegin(o.vc); await flushPhone(); assert.deepStrictEqual(o.api.voiceFacePackBody(), {});
});

test('phone: the real call panel and voice panel move into the view and return; the panel is shown while adopted and hidden again after', async () => {
  const p = phone({ prefs: { choice: 'orb' } });
  p.api.voiceDispBegin(p.vc); await flushPhone();
  const ov = p.doc.find('ucd-overlay')[0];
  assert.ok(ov.contains(p.panel) && ov.contains(p.vpanel)); assert.strictEqual(p.vpanel.hidden, false); assert.ok(p.state.painted >= 1, 'the panel was painted when adopted');
  p.doc.find('ucd-back')[0].click();
  assert.strictEqual(p.vpanel.parentNode, p.home); assert.strictEqual(p.vpanel.hidden, true); assert.strictEqual(p.panel.parentNode, p.doc.body);
  p.api.voiceDispSetChoice('none'); assert.strictEqual(JSON.parse(p.storage.m.get(CD.DISPLAY_STORE_KEY)).choice, 'none'); assert.strictEqual(p.state.hung, 0);
  p.api.voiceDispEnd(false);
});

// ═══════════════ parity and source-level checks ═══════════════
test('both pages carry the same wiring: same hooks, same events, same send field, the shared controller copies untouched', () => {
  const each = (re, what) => { assert.ok(re.test(app), 'desktop: ' + what); assert.ok(re.test(mob), 'phone: ' + what); };
  each(/voiceDisplayHook\('audioStop'\)/, 'barge-in / stop closes the beak');
  each(/voiceDisplayHook\('audioStart'\)/, 'audio start'); each(/voiceDisplayHook\('audioEnd'\)/, 'audio end'); each(/voiceDisplayHook\('caption'/, 'caption of the spoken sentence');
  each(/dsp\('boundary'\)/, 'device speech boundary'); each(/u\.onpause = /, 'device speech pause'); each(/u\.onresume = /, 'device speech resume'); each(/dsp\('end'\)/, 'device speech end');
  each(/voiceDisplayHook\('setState', name\)/, 'controller state'); each(/voiceDisplayHook\('level', db\)/, 'mic level');
  each(/floor\.wrap\(h\)/, 'Talk floor wraps the VAD handlers'); each(/voiceDispEnd\(true\)/, 'goodbye on hang-up'); each(/voiceDispEnd\(false\)/, 'immediate release');
  each(/function voiceFacePackBody\(\)/, 'facePack body helper'); each(/voiceCallSseMood/, 'stream mood'); each(/turn_mood/, 'hub mood event');
  each(/CallDisplay\.fetchPacks/, 'installed packs from the server'); each(/hub-voice-display|CallDisplay\.saveDisplayPrefs/, 'device choice saved through the shared module');
  assert.ok(/'turn_start', 'turn_delta', 'turn_activity', 'turn_end', 'ask_user', 'ask_user_done', 'voice_held', 'voice_held_done', 'voice_call'\]\) \{/.test(app), 'the existing subscription list is unchanged; turn_mood has its own line');
  assert.ok(/on\('turn_mood', voiceCallTurnMood\)/.test(mob) && /source\.addEventListener\('turn_mood'/.test(app));
  assert.ok(/case 'voice_mood':/.test(mob) && /oc2\.type === 'voice_mood'/.test(app));
  const BEGIN = '// ── voice call (begin) ──', END = '// ── voice call (end) ──';
  const lib = read('lib/ui-voice-call.js'), block = (s, ind) => s.slice(s.indexOf(BEGIN) + BEGIN.length, s.indexOf(END)).split('\n').map(l => (ind && l.startsWith(ind) ? l.slice(ind.length) : l)).join('\n').trim();
  assert.strictEqual(block(app, '    '), block(lib, ''), 'desktop controller copy unchanged'); assert.strictEqual(block(mob, ''), block(lib, ''), 'phone controller copy unchanged');
  const V = '// ── voice helpers (begin) ──', VE = '// ── voice helpers (end) ──', helpers = (s, ind) => s.slice(s.indexOf(V) + V.length, s.indexOf(VE)).split('\n').map(l => (ind && l.startsWith(ind) ? l.slice(ind.length) : l)).join('\n').trim();
  const shared = helpers(read('lib/ui-voice.js'), ''); assert.ok(shared.length > 1000, 'the shared voice helpers block was found');
  assert.strictEqual(helpers(app, '    '), shared, 'desktop voice helpers copy unchanged'); assert.strictEqual(helpers(mob, ''), shared, 'phone voice helpers copy unchanged');
});

test('the settings panels of both pages offer Follow agent default / None / Orb / installed characters and a captions switch, for every member', () => {
  assert.ok(/data-vp="display"/.test(app) && /data-vp="captions"/.test(app) && !/admin/i.test(between(app, 'function voicePopHtml(', 'function voicePopClose(')));
  const mh = read('mobile.html');
  assert.ok(/id="vp-display"/.test(mh) && /id="vp-captions"/.test(mh) && /Follow agent default/.test(mh) && /id="vp-display-note"[^>]*aria-live="polite"/.test(mh));
  assert.ok(/voiceDispSetChoice\(e\.target\.value\)/.test(mob) && /voiceDispSetCaptions\(!!e\.target\.checked\)/.test(mob));
  assert.ok(/k === 'display'\) voiceDispSetChoice\(chatId, t\.value\)/.test(app));
});

test('a call is never started or ended by the display: Talk and Hang up reuse the page functions; nothing fake is typed into the chat', () => {
  assert.ok(/onHangUp: \(\) => voiceCallHangUp\(\)/.test(app) && /onHangUp: \(\) => voiceCallHangUp\(\)/.test(mob));
  const talk = between(app, '    function voiceDispTalk()', '    function voiceDispAdopt');
  assert.ok(!/onSpeechEnd|d\.stt|voiceCallSend|sendSoloMessage/.test(talk), 'Talk never makes an utterance');
  assert.ok(!/onSpeechEnd|voiceCallStt|voiceCallSend/.test(between(mob, 'function voiceDispTalk()', 'function voiceDispAdopt')));
  assert.ok(!/createVoiceOrb|new Orb|drawOwl|owl-face/i.test(app + mob), 'the pages draw nothing themselves: no code-drawn owl or orb');
});

// ═══════════════ round 3: browser export, audio lifecycle, mid-sentence view changes, hang-up ordering ═══════════════
test('the module in a BROWSER (no module.exports) defines only window.CallDisplay + createCallDisplay, and both pages begin a display from that alone', async () => {
  const vm = require('vm');
  const sandbox = { window: null }; sandbox.globalThis = sandbox; vm.createContext(sandbox);
  vm.runInContext(read('lib/ui-call-display.js').replace(/^'use strict';/, ''), sandbox);   // `module` is not defined here: the root branch runs
  assert.strictEqual(typeof sandbox.CallDisplay, 'object'); assert.strictEqual(typeof sandbox.CallDisplay.createTalkFloor, 'function');
  assert.strictEqual(typeof sandbox.CallDisplay.createCallDisplay, 'function'); assert.strictEqual(sandbox.createTalkFloor, undefined, 'createTalkFloor is NOT a page global');
  for (const f of ['app.js', 'mobile.js']) { const src = read(f); assert.ok(!/(^|[^.\w])createTalkFloor\(/m.test(src.replace(/CallDisplay\.createTalkFloor\(/g, '')), f + ': no bare createTalkFloor'); }
  // the pages' real voiceDispBegin, with only the browser's global (CallDisplay) present
  const d = desktop({ prefs: { choice: 'orb' } }); d.api.voiceDispBegin('c1', 'bob'); await tick();
  assert.ok(d.api.voiceDisp.cur && d.api.voiceDisp.floor, 'desktop began a display and a floor'); assert.strictEqual(d.orbs.length, 1);
  const p = phone({ prefs: { choice: 'orb' } }); p.api.voiceDispBegin(p.vc); await flushPhone();
  assert.ok(p.api.voiceDisp.cur && p.api.voiceDisp.floor, 'phone began a display and a floor'); assert.strictEqual(p.orbs.length, 1);
});

test('phone: the one <audio> element stays audible after a call and for the next call (no second source, context not closed); a shared context lost is replaced with a new element', async () => {
  const p = phone({ prefs: { choice: 'orb' } }); p.api.voiceDispBegin(p.vc); await flushPhone();
  p.vc.call.state = 'speaking'; p.api.voiceDisp.cur.setState('speaking');
  const w = p.api.voicePlayBlob({}, 5, { text: 'One.' }); const a = p.voicePlay.audio; a.onplaying(); a.onended(); await w;
  const ctx = p.ctxs[0]; assert.strictEqual(ctx.sources.length, 1);
  p.api.voiceDispEnd(false);
  assert.strictEqual(ctx.closed, 0, 'the routed context is NOT closed: the element would be silent for good');
  // read aloud after the call (no display): the same element still plays through its route
  const r = p.api.voicePlayBlob({}, 5, { text: 'Read.' }); assert.strictEqual(p.voicePlay.audio, a); a.onplaying(); a.onended(); assert.strictEqual(await r, true);
  assert.strictEqual(ctx.sources.length, 1);
  // next call: the same element and context are reused, createMediaElementSource is not called again, the analyser is the old one
  p.api.voiceCall = p.vc; p.api.voiceDispBegin(p.vc); await flushPhone();
  assert.strictEqual(p.ctxs.length, 1, 'no new context'); p.vc.call.state = 'speaking'; p.api.voiceDisp.cur.setState('speaking');
  const w2 = p.api.voicePlayBlob({}, 5, { text: 'Two.' }); assert.strictEqual(p.voicePlay.audio, a); a.onplaying();
  assert.strictEqual(ctx.sources.length, 1); assert.strictEqual(p.orbs[1].last('setAnalyser'), ctx.analysers[0], 'the display attaches to the existing analyser');
  a.onended(); await w2; p.api.voiceDispEnd(false); assert.strictEqual(ctx.closed, 0);
  // a context the browser closed: a new context, and the captured element is replaced
  ctx.state = 'closed'; p.api.voiceDispBegin(p.vc); await flushPhone();
  assert.strictEqual(p.ctxs.length, 2); assert.strictEqual(p.voicePlay.audio, null, 'the silenced element is dropped; the next play makes a new one');
  const w3 = p.api.voicePlayBlob({}, 5, { text: 'Three.' }); assert.notStrictEqual(p.voicePlay.audio, a); p.voicePlay.audio.onplaying(); p.voicePlay.audio.onended(); await w3;
  assert.strictEqual(p.ctxs[1].sources.length, 1, 'the new element is routed through the new context'); p.api.voiceDispEnd(false);
});

test('phone: a routed element behind a suspended context is resumed, and the beak does not pretend to hear it until it runs', async () => {
  const p = phone({ prefs: { choice: 'pack:owl' } }); p.api.voiceDispBegin(p.vc); await flushPhone();
  p.vc.call.state = 'speaking'; p.api.voiceDisp.cur.setState('speaking');
  const w = p.api.voicePlayBlob({}, 5, { text: 'A.' }); const a = p.voicePlay.audio; a.onplaying(); a.onended(); await w;
  const ctx = p.ctxs[0], pl = p.faces[0]; ctx.state = 'suspended'; const resumed = ctx.resumed;
  ctx.resume = () => { ctx.resumed++; return new Promise((res) => { ctx.finishResume = () => { ctx.state = 'running'; res(); }; }); };
  const w2 = p.api.voicePlayBlob({}, 5, { text: 'B.' }); a.onplaying();
  assert.ok(ctx.resumed > resumed, 'resume was asked for'); assert.strictEqual(ctx.sources.length, 1, 'no second source');
  assert.notStrictEqual(pl.last('setAnalyser'), ctx.analysers[0]); assert.ok(!pl.all('speechEvent').includes('start'), 'no pretend beak for audio nobody can hear');
  ctx.finishResume(); await flushPhone();
  assert.strictEqual(pl.last('setAnalyser'), ctx.analysers[0], 'once the context runs the analyser is attached'); a.onended(); await w2; p.api.voiceDispEnd(false);
});

test('phone: Back to chat and a choice change in the middle of a sentence keep the audio state and re-attach the analyser / device speech without touching the audio', async () => {
  const p = phone({ prefs: { choice: 'pack:owl' } }); p.api.voiceDispBegin(p.vc); await flushPhone();
  p.vc.call.state = 'speaking'; const d = p.api.voiceDisp.cur; d.setState('speaking');
  const w = p.api.voicePlayBlob({}, 5, { text: 'Long sentence.' }); const a = p.voicePlay.audio; a.onplaying(); const an = p.ctxs[0].analysers[0];
  assert.strictEqual(p.faces[0].last('setAnalyser'), an); const plays = a.plays;
  d.hideToChat(); assert.strictEqual(d.info().audio, true, 'audio is still on'); assert.ok(!a.paused || a.plays === plays);
  d.showView(); await flushPhone(); assert.strictEqual(p.faces[1].last('setAnalyser'), an, 'the new view is attached to the live analyser'); assert.strictEqual(p.faces[1].last('setState'), 'speaking');
  d.setChoice('orb'); await flushPhone(); assert.strictEqual(p.orbs[0].last('setAnalyser'), an, 'a choice change mid-sentence too');
  assert.strictEqual(a.plays, plays, 'the audio was never replayed'); a.onended(); await w; assert.strictEqual(p.orbs[0].last('setAnalyser'), null);
  // device speech
  const synth = { speak(u) { synth.u = u; }, cancel() {} };
  const q = phone({ prefs: { choice: 'pack:owl' }, synth }); q.api.voiceDispBegin(q.vc); await flushPhone(); q.vc.call.state = 'speaking'; q.api.voiceDisp.cur.setState('speaking');
  const done = q.api.voiceDeviceSpeak(['Hi there.'], 5); await tick(10); synth.u.onstart();
  const dd = q.api.voiceDisp.cur; dd.hideToChat(); dd.showView(); await flushPhone();
  assert.strictEqual(q.faces[1].last('speechEvent'), 'start', 'device speech goes on in the reopened view'); synth.u.onend(); await done;
  assert.strictEqual(q.faces[1].last('speechEvent'), 'end');
});

test('phone: hang-up with the REAL controller: it reports ended synchronously inside hangUp(), and the goodbye still runs; the microphone is let go at once', async () => {
  const C = require('../lib/ui-voice-call');
  const p = phone({ prefs: { choice: 'pack:owl' } }); p.api.voiceDispBegin(p.vc); await flushPhone();
  const src = between(mob, 'function voiceCallDeps(vc) {', 'function voiceCallStart()');
  const hangSrc = between(mob, 'function voiceCallTeardown(vc) {', "// The hub's call routes");
  const log = []; const holder = { voiceCall: null };
  const vc = { agent: 'bob', vad: { start() {}, stop() { log.push('vad.stop'); return Promise.resolve(); }, setPlaybackActive() {} }, wake: null, callTurns: new Set(), hubTurns: new Map(), asks: new Map() };
  const env = { voiceThinkingDeps: () => null, voicePrefsNow: () => ({}), voiceCallStt() {}, isBusy: () => false, ownTurnFor: () => false, voiceCallSend() {}, voiceCallInterject() {}, stopTurn() {}, voiceCallSpeak() {}, voiceStopPlayback() {},
    voiceCallAnswerAsk() {}, voiceCallServer: () => ({ start: async () => ({ callId: 'k', held: [] }), heartbeat: async () => ({ callId: 'k', held: [] }), mode: async () => {}, end: async () => ({ held: [] }), decide: async () => {} }),
    voiceCallPaintState() {}, voiceCallPaintMeter() {}, voiceCallPaintHeld() {}, voiceCallPanel: (on) => log.push('panel:' + on), voiceMicPaint() {}, voiceMediaSession() {}, voiceThinkingClose() {}, $: () => null, toast() {}, chatOpenFor: () => false, addNote() {}, scrollChat() {},
    voiceDisp: p.api.voiceDisp, voiceDispEnd: p.api.voiceDispEnd, voiceDisplayHook: p.api.voiceDisplayHook, VOICE_CALL_STATE_TEXT: {}, voiceCallWake() {}, Date, setTimeout, clearTimeout };
  const names = Object.keys(env);
  const f = new Function('holder', ...names, hangSrc.replace(/\bvoiceCall\b(?!\w)/g, 'holder.voiceCall') + src.replace(/\bvoiceCall\b(?!\w)/g, 'holder.voiceCall') + '\nreturn { voiceCallHangUp, voiceCallDeps };')(holder, ...names.map(n => env[n]));
  holder.voiceCall = vc;
  const call = C.voiceCreateCall(Object.assign(f.voiceCallDeps(vc), { vad: vc.vad, stt: async () => '', now: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t), server: { start: async () => ({ callId: 'k', held: [] }), heartbeat: async () => ({ callId: 'k', held: [] }), mode: async () => {}, end: async () => ({ held: [] }), decide: async () => {} }, thinking: undefined }));
  vc.call = call; p.vc.call = call;
  call.start(); await flushPhone();
  const pl = p.faces[0]; const ov = p.doc.find('ucd-overlay')[0]; assert.ok(ov, 'the display is up');
  const wired = f.voiceCallDeps(vc).ui;
  assert.strictEqual(wired.thinkingWanted(), true, 'a view is shown: it takes the thinking clock');
  const hung = f.voiceCallHangUp();
  assert.strictEqual(call.state, 'ended'); assert.ok(log.includes('vad.stop'), 'the microphone is released inside hang-up, no waiting for the goodbye');
  assert.strictEqual(pl.last('react'), 'goodbye', 'the goodbye ran (it used to be skipped: the ended state tore the display down first)');
  assert.strictEqual(pl.destroyed, false, 'the character is still on screen for its goodbye'); assert.strictEqual(p.panel.parentNode, p.doc.body, 'the controls are already back in the page');
  assert.strictEqual(holder.voiceCall, null); await hung;
  // release (leaving the app) still drops the display at once
  const p2 = phone({ prefs: { choice: 'pack:owl' } }); p2.api.voiceDispBegin(p2.vc); await flushPhone();
  p2.api.voiceDispEnd(false); assert.strictEqual(p2.faces[0].destroyed, true);
});

// ═══════════════ audio lifecycle gaps: device speech with no view, and the page's own audio recovery ═══════════════
test('phone: device speech is tracked with no view: hidden during a sentence, its end / cancel while hidden is not lost, a reopened view never starts a fake beak', async () => {
  const synth = { speak(u) { synth.u = u; }, cancel() {} };
  const p = phone({ prefs: { choice: 'pack:owl' }, synth }); p.api.voiceDispBegin(p.vc); await flushPhone();
  p.vc.call.state = 'speaking'; const d = p.api.voiceDisp.cur; d.setState('speaking');
  const done = p.api.voiceDeviceSpeak(['Hi there.'], 5); await tick(10); synth.u.onstart();
  d.hideToChat(); assert.strictEqual(d.info().audio, true);
  synth.u.onend(); await done;   // the end arrives while no view exists
  assert.strictEqual(d.info().audio, false, 'the end was not dropped');
  d.showView(); await flushPhone();
  assert.ok(!p.faces[1].all('speechEvent').includes('start'), 'a reopened view does not start a beak for a sentence that already ended');
  // an error (the device voice cut) while hidden, then reopen
  const d2 = p.api.voiceDeviceSpeak(['Again.'], 5); await tick(10); synth.u.onstart(); d.hideToChat(); synth.u.onerror(); await d2; d.showView(); await flushPhone();
  assert.ok(!p.faces[2].all('speechEvent').includes('start'), 'a cut while hidden: no fake start on reopen');
});

test('phone: speech that starts under None attaches when a character is chosen mid-sentence, and pause / resume are tracked without a view', async () => {
  const synth = { speak(u) { synth.u = u; }, cancel() {} };
  const p = phone({ prefs: { choice: 'none' }, synth }); p.api.voiceDispBegin(p.vc); await flushPhone();
  p.vc.call.state = 'speaking'; const d = p.api.voiceDisp.cur; d.setState('speaking');
  const done = p.api.voiceDeviceSpeak(['Hello.'], 5); await tick(10); synth.u.onstart();
  assert.strictEqual(d.info().audio, true, 'tracked although None shows nothing');
  d.setChoice('pack:owl'); await flushPhone();
  assert.strictEqual(p.faces[0].last('speechEvent'), 'start', 'the character chosen mid-sentence attaches to the speech that is really heard');
  d.setChoice('none'); await flushPhone(); synth.u.onpause(); assert.strictEqual(d.info().audio, false, 'pause with no view');
  synth.u.onresume(); assert.strictEqual(d.info().audio, true, 'resume with no view');
  synth.u.onend(); await done; assert.strictEqual(d.info().audio, false);
});

test('phone: read aloud after a call behind a context the browser suspended: the page resumes it and plays through the same route (one source, nothing muted)', async () => {
  const p = phone({ prefs: { choice: 'orb' } }); p.api.voiceDispBegin(p.vc); await flushPhone();
  const w = p.api.voicePlayBlob({}, 5, { text: 'One.' }); const a = p.voicePlay.audio; a.onplaying(); a.onended(); await w;
  p.api.voiceDispEnd(false); assert.strictEqual(p.api.voiceDisp.cur, null);
  const ctx = p.ctxs[0]; ctx.state = 'suspended'; const resumed = ctx.resumed;
  ctx.resume = () => { ctx.resumed++; return Promise.resolve().then(() => { ctx.state = 'running'; }); };
  const r = p.api.voicePlayBlob({}, 5); assert.strictEqual(a.plays, 1, 'not started before the context runs'); await flushPhone();
  assert.ok(ctx.resumed > resumed, 'resume was asked for'); assert.strictEqual(p.voicePlay.audio, a, 'the routed element is kept: it is audible through its route');
  assert.strictEqual(a.plays, 2); assert.strictEqual(ctx.sources.length, 1, 'no second source'); a.onended(); assert.strictEqual(await r, true);
});

test('phone: read aloud after a call when the context cannot be resumed: a fresh plain element is used (audible), the old one is stopped and not double-sourced', async () => {
  const p = phone({ prefs: { choice: 'orb' } }); p.api.voiceDispBegin(p.vc); await flushPhone();
  const w = p.api.voicePlayBlob({}, 5, { text: 'One.' }); const a = p.voicePlay.audio; a.onplaying(); a.onended(); await w; p.api.voiceDispEnd(false);
  const ctx = p.ctxs[0]; ctx.state = 'suspended'; ctx.resume = () => { ctx.resumed++; return Promise.reject(new Error('blocked')); };
  const r = p.api.voicePlayBlob({}, 5); await flushPhone();
  const b = p.voicePlay.audio; assert.notStrictEqual(b, a, 'replaced'); assert.strictEqual(b.plays, 1); assert.ok(a.paused, 'the captured element is stopped'); assert.strictEqual(ctx.sources.length, 1, 'the new element is never routed without a display');
  b.onended(); assert.strictEqual(await r, true);
  // a hidden page is never asked to resume in the background: straight to a plain element
  const q = phone({ prefs: { choice: 'orb' } }); q.api.voiceDispBegin(q.vc); await flushPhone();
  const w2 = q.api.voicePlayBlob({}, 5); const a2 = q.voicePlay.audio; a2.onplaying(); a2.onended(); await w2; q.api.voiceDispEnd(false);
  const c2 = q.ctxs[0]; c2.state = 'suspended'; const n = c2.resumed; q.doc.hidden = true;
  const r2 = q.api.voicePlayBlob({}, 5); assert.strictEqual(c2.resumed, n, 'no resume in the background'); assert.notStrictEqual(q.voicePlay.audio, a2); q.voicePlay.audio.onended(); await r2;
});

test('phone: read aloud after a call whose context was closed: the element is replaced BEFORE playing, so the new element is plain and plays (never silent); the stale pending play is settled', async () => {
  const p = phone({ prefs: { choice: 'orb' } }); p.api.voiceDispBegin(p.vc); await flushPhone();
  const w = p.api.voicePlayBlob({}, 5, { text: 'One.' }); const a = p.voicePlay.audio; a.onplaying();   // a sentence still pending on the captured element
  p.api.voiceDispEnd(false); const ctx = p.ctxs[0]; ctx.state = 'closed';
  const r = p.api.voicePlayBlob({}, 5);
  assert.strictEqual(await w, false, 'the old pending play settled as not played'); const b = p.voicePlay.audio;
  assert.notStrictEqual(b, a); assert.strictEqual(b.plays, 1, 'the new element was chosen after the recovery and is playing'); assert.strictEqual(ctx.sources.length, 1);
  assert.strictEqual(p.api.voiceDisp.shared.ctx, null, 'the closed context is forgotten'); b.onended(); assert.strictEqual(await r, true);
});

test('phone: a tap (voiceUnlockAudio) recovers the page audio: a suspended context is resumed once, a closed one drops its element for a fresh primed one; a call with None after it is fine', async () => {
  const p = phone({ prefs: { choice: 'orb' } }); p.api.voiceDispBegin(p.vc); await flushPhone();
  const w = p.api.voicePlayBlob({}, 5); const a = p.voicePlay.audio; a.onplaying(); a.onended(); await w; p.api.voiceDispEnd(false);
  const ctx = p.ctxs[0]; ctx.state = 'suspended'; const n = ctx.resumed; p.api.voiceUnlockAudio();
  assert.strictEqual(ctx.resumed, n + 1, 'one resume inside the gesture'); assert.strictEqual(p.voicePlay.audio, a);
  ctx.state = 'closed'; p.api.voiceUnlockAudio(); const b = p.voicePlay.audio;
  assert.notStrictEqual(b, a); assert.ok(b && b.plays === 1, 'a new element is created and primed in the tap'); assert.strictEqual(ctx.resumed, n + 1, 'a closed context is not resumed');
  // the next call with None: no display, the new plain element plays natively
  const none = phone({ prefs: { choice: 'none' } }); none.api.voiceDispBegin(none.vc); await flushPhone();
  const x = none.api.voicePlayBlob({}, 5); none.voicePlay.audio.onended(); assert.strictEqual(await x, true); assert.strictEqual(none.ctxs.length, 0);
  // and a hidden page is never woken by a tap handler running in the background
  const h = phone({ prefs: { choice: 'orb' } }); h.api.voiceDispBegin(h.vc); await flushPhone();
  const w3 = h.api.voicePlayBlob({}, 5); h.voicePlay.audio.onplaying(); h.voicePlay.audio.onended(); await w3; h.api.voiceDispEnd(false);
  h.ctxs[0].state = 'suspended'; const k = h.ctxs[0].resumed; h.doc.hidden = true; h.api.voiceUnlockAudio(); assert.strictEqual(h.ctxs[0].resumed, k);
});

test('phone: Show display sits inside the call panel beside Hang up, never in the body; None gives no thinking-clock consumer', async () => {
  const p = phone({ prefs: { choice: 'orb' } }); p.api.voiceDispBegin(p.vc); await flushPhone();
  assert.ok(p.doc.find('ucd-overlay')[0].contains(p.panel), 'the call panel is in the view');
  p.doc.find('ucd-back')[0].click();
  const r = p.doc.find('ucd-reopen')[0];
  assert.ok(r, 'a way back'); assert.strictEqual(r.parentNode, p.panel, 'inside the call panel'); assert.strictEqual(p.panel.children[p.panel.children.indexOf(r) + 1], p.cpHang, 'beside Hang up');
  assert.ok(!p.doc.body.children.includes(r));
  r.click(); assert.strictEqual(p.doc.find('ucd-reopen').length, 0);
  p.api.voiceDispEnd(false); assert.strictEqual(p.doc.find('ucd-reopen').length, 0);
  const n = phone({ prefs: { choice: 'none' } }); n.api.voiceDispBegin(n.vc); await flushPhone();
  assert.strictEqual(n.doc.find('ucd-overlay').length + n.doc.find('ucd-reopen').length, 0, 'None: nothing in the page');
  assert.strictEqual(n.api.voiceDisp.cur.showsPulse(), false);
});
