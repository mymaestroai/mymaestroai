'use strict';
// The call display (lib/ui-call-display.js): which display a call shows (device choice vs agent default, None, missing packs),
// the Talk floor against the REAL call controller, the full-screen view with a fake DOM, state/audio/mood/caption driving of
// injected players, controls moved into the view and put back, goodbye / release, and the static files that serve it.
// Fake DOM, fake clock, fake players: these tests cannot prove how it looks or sounds in a browser.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
Object.assign(globalThis, require('../lib/ui-voice'));   // the call controller uses these helpers as globals, like the pages
const { voiceCreateCall } = require('../lib/ui-voice-call');
const CD = require('../lib/ui-call-display');
const staticFiles = require('../lib/static-files');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const tick = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

// ── fakes ──
function fakeDom() {
  const doc = { activeElement: null, listeners: {} };
  class El {
    constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.parentNode = null; this.attrs = {}; this.listeners = {}; this.className = ''; this.hidden = false; this.disabled = false; this.value = ''; this.checked = false; this._text = ''; this.props = {}; this.style = { props: this.props, setProperty: (k, v) => { this.props[k] = v; } }; }
    get firstChild() { return this.children[0] || null; }
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
    set textContent(v) { this.children.forEach(c => { c.parentNode = null; }); this.children = []; this._text = String(v); }
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
    insertBefore(c, ref) { if (c.parentNode) c.parentNode.removeChild(c); const i = this.children.indexOf(ref); c.parentNode = this; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; } return c; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k]; }
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
    contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
    focus() { doc.activeElement = this; }
    click() { this.dispatch('click', {}); }
    dispatch(t, ev) { const e = Object.assign({ preventDefault() {}, stopPropagation() {}, target: this }, ev); for (const f of this.listeners[t] || []) f(e); return e; }
    all() { return this.children.flatMap(c => [c, ...c.all()]); }
    querySelectorAll(sel) { const tags = sel.split(',').map(x => x.trim().split('[')[0].toUpperCase()); return this.all().filter(n => tags.includes(n.tagName)); }
  }
  doc.createElement = (t) => new El(t);
  doc.body = new El('body');
  const find = (cls) => doc.body.all().filter(n => (' ' + n.className + ' ').includes(' ' + cls + ' '));
  return { doc, El, find, overlay: () => find('ucd-overlay')[0] || null };
}
function memStorage(init) { const m = new Map(Object.entries(init || {})); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; }
function fakePlayerFactory(kind, log, opts) {
  const o = opts || {};
  return (host, options) => {
    const p = { kind, host, options, calls: [], reactRet: o.react === undefined ? true : o.react, destroyed: false };
    const rec = (n) => (...a) => { p.calls.push([n, ...a]); };
    p.setState = rec('setState'); p.setAnalyser = rec('setAnalyser'); p.setMicLevel = rec('setMicLevel'); p.speechEvent = rec('speechEvent'); p.setLevel = rec('setLevel');
    if (kind === 'orb') p.thinkingPulse = rec('thinkingPulse');   // the Character player has no thinkingPulse: the display must cope
    p.react = (m) => { p.calls.push(['react', m]); return typeof p.reactRet === 'function' ? p.reactRet(m) : p.reactRet; };
    p.cancelReaction = rec('cancelReaction');
    if (o.info) p.getInfo = () => o.info;   // a player that reports its readiness (the real one does)
    p.destroy = () => { p.destroyed = true; p.calls.push(['destroy']); };
    p.ready = o.rejectReady ? Promise.reject(new Error('bad pack')) : Promise.resolve(p);
    p.ready.catch(() => {});
    p.last = (n) => { const c = p.calls.filter(x => x[0] === n); return c.length ? c[c.length - 1][1] : undefined; };
    p.count = (n) => p.calls.filter(x => x[0] === n).length;
    log.push(p);
    return p;
  };
}
const PACKS = [{ id: 'owl', name: 'Owl <b>x</b>', background: '#ffd6ab', hasReactions: true }, { id: 'plain', name: 'Plain', background: '#222', hasReactions: false }];
const jsonFetch = (packs, status) => async () => ({ ok: (status || 200) < 400, status: status || 200, json: async () => ({ packs }) });
function clock() {
  const c = { t: 0, timers: [], id: 1 };
  c.setTimeout = (fn, ms) => { const id = c.id++; c.timers.push({ id, at: c.t + ms, fn }); return id; };
  c.clearTimeout = (id) => { c.timers = c.timers.filter(x => x.id !== id); };
  c.advance = async (ms) => { const end = c.t + ms; for (;;) { const d = c.timers.filter(x => x.at <= end).sort((a, b) => a.at - b.at)[0]; if (!d) break; c.timers = c.timers.filter(x => x !== d); c.t = d.at; d.fn(); await tick(); } c.t = end; await tick(); };
  return c;
}
function world(o) {
  o = o || {};
  const dom = fakeDom(), clk = clock(), players = [], orbs = [];
  const storage = o.storage || memStorage(o.prefs ? { [CD.DISPLAY_STORE_KEY]: JSON.stringify(o.prefs) } : {});
  const log = { talk: 0, hang: 0, changes: 0 };
  const win = { document: dom.doc, AudioContext: o.AudioContext, createVoiceOrb: undefined };
  const display = CD.createCallDisplay({
    window: win, document: dom.doc, storage, fetch: o.fetch || jsonFetch(PACKS), setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout,
    reopenHost: o.reopenHost, needsContext: !!o.needsContext, shared: o.shared, onRoutesLost: o.onRoutesLost, agentDefault: () => (o.agentDefault === undefined ? 'none' : o.agentDefault), adopt: o.adopt,
    onTalk: () => { log.talk++; }, onHangUp: () => { log.hang++; }, onChange: () => { log.changes++; },
    createVoiceOrb: fakePlayerFactory('orb', orbs, o.orb), createFacePlayer: fakePlayerFactory('pack', players, o.pack),
  });
  return { dom, clk, players, orbs, storage, log, display, win };
}

// ── choice resolution ──
test('a device choice wins over the agent default, an explicit None included; unset follows the agent, else None', () => {
  const r = (choice, agentDefault, packs) => CD.resolveDisplay({ choice, agentDefault, packs: packs || PACKS });
  assert.strictEqual(r('orb', 'none').kind, 'orb');
  assert.strictEqual(r('none', 'orb').kind, 'none', 'the person explicitly chose None');
  assert.strictEqual(r('none', 'orb').missing, false);
  assert.strictEqual(r('none', 'pack:owl').kind, 'none');
  assert.strictEqual(r('pack:plain', 'orb').slug, 'plain');
  assert.strictEqual(r('follow', 'orb').kind, 'orb');
  assert.strictEqual(r('follow', 'pack:owl').kind, 'pack');
  assert.strictEqual(r(undefined, 'orb').kind, 'orb', 'unset follows the agent');
  assert.strictEqual(r('follow', undefined).kind, 'none', 'no agent default: None');
  assert.strictEqual(r('follow', 'garbage').kind, 'none');
  assert.strictEqual(r('weird', 'orb').kind, 'orb', 'an invalid saved choice is treated as unset');
  assert.strictEqual(r('follow', 'follow').kind, 'none', 'an agent default can not say follow');
  assert.strictEqual(r('orb', 'orb').source, 'device');
  assert.strictEqual(r('follow', 'orb').source, 'agent');
});

test('a character that is missing, failed or still being looked up falls back to None, never to the Orb', () => {
  const miss = CD.resolveDisplay({ choice: 'pack:ghost', agentDefault: 'orb', packs: PACKS });
  assert.deepStrictEqual([miss.kind, miss.missing, miss.wanted], ['none', true, 'ghost']);
  assert.ok(/not installed/.test(CD.displayNote(miss)));
  const agentMiss = CD.resolveDisplay({ choice: 'follow', agentDefault: 'pack:ghost', packs: [] });
  assert.deepStrictEqual([agentMiss.kind, agentMiss.missing], ['none', true]);
  const pend = CD.resolveDisplay({ choice: 'pack:owl', packs: null });
  assert.deepStrictEqual([pend.kind, pend.pending, pend.missing], ['none', true, false]);
  const failedList = CD.resolveDisplay({ choice: 'pack:owl', packs: [], packsState: 'failed' });
  assert.deepStrictEqual([failedList.kind, failedList.missing], ['none', true]);
  const bad = CD.resolveDisplay({ choice: 'pack:owl', packs: PACKS, unusable: new Set(['owl']) });
  assert.deepStrictEqual([bad.kind, bad.missing, bad.failed], ['none', true, true]);
  assert.ok(/could not load/.test(CD.displayNote(bad)));
  assert.strictEqual(CD.displayNote(CD.resolveDisplay({ choice: 'orb' })), '');
  assert.strictEqual(CD.cleanChoice('pack:../x'), null);
  assert.strictEqual(CD.cleanChoice('pack:' + 'a'.repeat(41)), null);
});

test('the choice is saved per device under the voice-prefs style key; a missing character stays saved; garbage is ignored; no credentials are stored', () => {
  assert.strictEqual(CD.DISPLAY_STORE_KEY, 'hub-voice-display');
  const st = memStorage();
  assert.deepStrictEqual(CD.loadDisplayPrefs(st), { choice: 'follow', captions: false });
  CD.saveDisplayPrefs(st, { choice: 'pack:ghost' });
  assert.deepStrictEqual(CD.loadDisplayPrefs(st), { choice: 'pack:ghost', captions: false }, 'saved even though nothing installed matches');
  CD.saveDisplayPrefs(st, { captions: true });
  assert.deepStrictEqual(CD.loadDisplayPrefs(st), { choice: 'pack:ghost', captions: true });
  CD.saveDisplayPrefs(st, { choice: 'bogus', captions: 'yes' });
  assert.deepStrictEqual(CD.loadDisplayPrefs(st), { choice: 'pack:ghost', captions: true });
  assert.deepStrictEqual(CD.loadDisplayPrefs(memStorage({ 'hub-voice-display': '{not json' })), { choice: 'follow', captions: false });
  assert.deepStrictEqual(CD.loadDisplayPrefs(memStorage({ 'hub-voice-display': '[1]' })), { choice: 'follow', captions: false });
  assert.deepStrictEqual(CD.loadDisplayPrefs({ getItem() { throw new Error('blocked'); } }), { choice: 'follow', captions: false });
  assert.ok(!/token|password|cookie|credential/i.test(st.m.get('hub-voice-display')));
  assert.doesNotThrow(() => CD.saveDisplayPrefs({ getItem: () => null, setItem() { throw new Error('full'); } }, { choice: 'orb' }));
});

test('states: starting is idle; listening and hearing are listening; speaking is thinking until the reply audio really starts', () => {
  const m = CD.mapDisplayState;
  assert.strictEqual(m('starting'), 'idle');
  assert.strictEqual(m('listening'), 'listening');
  assert.strictEqual(m('listening', { hello: true }), 'idle');
  assert.strictEqual(m('hearing'), 'listening');
  assert.strictEqual(m('hearing', { hello: true }), 'listening', 'hearing cancels hello');
  assert.strictEqual(m('thinking'), 'thinking');
  assert.strictEqual(m('speaking'), 'thinking');
  assert.strictEqual(m('speaking', { audio: true }), 'speaking');
  assert.strictEqual(m('nonsense'), 'idle');
  assert.strictEqual(CD.levelFromDb(-60), 0); assert.strictEqual(CD.levelFromDb(-10), 1); assert.strictEqual(CD.levelFromDb(NaN), 0);
});

// ── Talk floor, against the real controller ──
function callHarness() {
  const h = { t: 0, timers: [], id: 1, stt: 0, sent: [], states: [], spoken: [], pend: [], cancelled: 0, vad: null };
  const setTimer = (fn, ms) => { const id = h.id++; h.timers.push({ id, at: h.t + ms, fn }); return id; };
  const clearTimer = (id) => { h.timers = h.timers.filter(x => x.id !== id); };
  h.advance = async (ms) => { const end = h.t + ms; for (;;) { const d = h.timers.filter(x => x.at <= end).sort((a, b) => a.at - b.at)[0]; if (!d) break; h.timers = h.timers.filter(x => x !== d); h.t = d.at; d.fn(); await tick(); } h.t = end; await tick(); };
  h.floor = null;
  const vad = { start: async (hd) => { h.vad = hd; }, stop() {}, setPlaybackActive() {} };
  h.call = voiceCreateCall({
    agent: 'a', now: () => h.t, setTimer, clearTimer, prefs: () => ({ continueWait: 0 }),
    vad: { start: (hd) => vad.start(h.floor ? h.floor.wrap(hd) : hd), stop: () => vad.stop(), setPlaybackActive: (b) => vad.setPlaybackActive(b) },
    stt: async (a) => { h.stt++; return a.text; }, isTurnRunning: () => false, send: async (t) => { h.sent.push(t); }, interject: async () => {}, stop() {},
    speak: (t) => new Promise((res) => { h.spoken.push(t); h.pend.push(res); }), cancelSpeech: () => { h.cancelled++; const r = h.pend.shift(); if (r) r(false); },
    answerAsk() {}, server: { start: async () => ({ callId: 'c1', held: [] }), heartbeat: async () => ({ held: [] }), mode: async () => {}, end: async () => ({ held: [] }), decide: async () => {} },
    ui: { state: (n) => h.states.push(n) },
  });
  h.floor = CD.createTalkFloor({ call: () => h.call, setTimer, clearTimer });
  return h;
}

test('Talk takes the floor with the controller own entry point, makes up no utterance, and a silent microphone returns the call to listening', async () => {
  const h = callHarness();
  assert.strictEqual(await h.call.start(), true);
  assert.strictEqual(h.call.state, 'listening');
  assert.strictEqual(h.floor.take(), true);
  assert.strictEqual(h.call.state, 'hearing');
  await h.advance(CD.TALK_WAIT_MS - 100);
  assert.strictEqual(h.call.state, 'hearing', 'the person has a few seconds to begin');
  await h.advance(200);
  assert.strictEqual(h.call.state, 'listening', 'nothing was heard: back to listening like after a false start');
  assert.strictEqual(h.stt, 0, 'no speech-to-text call was made');
  assert.deepStrictEqual(h.sent, [], 'no message was made up');
  assert.strictEqual(h.floor.taken, false);
  // and the call still works afterwards: a real utterance goes through
  h.vad.onSpeechStart(); h.vad.onSpeechEnd({ text: 'hello there friend' }); await tick(20);
  assert.deepStrictEqual(h.sent, ['hello there friend']);
});

test('Talk while a reply is read cuts it at once; real speech then belongs to the microphone (no release), and its end is a normal turn', async () => {
  const h = callHarness();
  await h.call.start();
  h.call.onReplyText('First sentence here. Second sentence here.', false);
  await tick();
  assert.strictEqual(h.call.state, 'speaking');
  assert.strictEqual(h.floor.take(), true);
  assert.strictEqual(h.cancelled, 1, 'the reading was cut');
  assert.strictEqual(h.call.state, 'hearing');
  h.vad.onSpeechBegin();   // the microphone hears the person
  await h.advance(CD.TALK_WAIT_MS + 1000);
  assert.strictEqual(h.call.state, 'hearing', 'the watchdog does not run past a person who is speaking (frames keep it fed)');
  for (let i = 0; i < 3; i++) { h.vad.onFrame(-30, {}); await h.advance(5000); }
  assert.strictEqual(h.call.state, 'hearing');
  h.vad.onSpeechEnd({ text: 'please stop that' }); await tick(20);
  assert.strictEqual(h.stt, 1);
  assert.strictEqual(h.floor.taken, false);
});

test('Talk is refused before the call is up and after it ended; a silent microphone after hearing starts lets go (no stuck hearing)', async () => {
  const h = callHarness();
  assert.strictEqual(h.floor.take(), false, 'not started');
  await h.call.start();
  h.vad.onSpeechBegin(); h.vad.onSpeechStart();
  assert.strictEqual(h.floor.take(), true);
  h.floor.wrap({ onFrame() {} }).onFrame(-40);
  h.floor.cancel();
  assert.strictEqual(h.floor.taken, false);
  await h.call.release('test');
  assert.strictEqual(h.floor.take(), false, 'ended');
  const h2 = callHarness(); await h2.call.start();
  h2.floor.take(); h2.vad.onSpeechBegin();           // the VAD took over...
  await h2.advance(CD.TALK_WAIT_MS + 8100);          // ...then went silent for good: no frames
  assert.strictEqual(h2.call.state, 'listening', 'the watchdog released the floor');
});

// ── the view ──
const flushP = () => tick(20);

test('None: no overlay, no player, no analyser routing, no audio context, no mood request, nothing to restore', async () => {
  let ctxMade = 0;
  const w = world({ prefs: { choice: 'none' }, agentDefault: 'orb', needsContext: true, AudioContext: function () { ctxMade++; } });
  w.display.start(); await flushP();
  assert.strictEqual(w.dom.overlay(), null);
  assert.strictEqual(w.orbs.length + w.players.length, 0);
  assert.strictEqual(ctxMade, 0, 'None does not unlock or route anything');
  assert.strictEqual(w.display.activeFacePack(), null);
  const src = { connected: [], connect(x) { this.connected.push(x); } };
  assert.strictEqual(w.display.routeBufferSource({ destination: 'D', createAnalyser() { throw new Error('must not'); } }, src), false);
  assert.deepStrictEqual(src.connected, ['D'], 'plain playback');
  assert.strictEqual(w.display.routeElement({}), false);
  w.display.setState('listening'); w.display.audioStart(); w.display.caption('x'); w.display.mood('t', 'proud');
  assert.strictEqual(w.display.info().kind, 'none');
});

test('thinkingPulse: the orb gets the very same event, a character without the method ignores it, nothing after release', async () => {
  const ev = { at: 1234.5, attackMs: 250, decayMs: 1000, strength: 0.35 };
  const w = world({ prefs: { choice: 'orb' } });
  w.display.start(); await flushP();
  w.display.thinkingPulse(ev); w.display.thinkingPulse(undefined);
  assert.strictEqual(w.orbs[0].count('thinkingPulse'), 1);
  assert.strictEqual(w.orbs[0].calls.find(c => c[0] === 'thinkingPulse')[1], ev, 'passed through unchanged (reduced motion is the orb\'s business)');
  w.display.release();
  w.display.thinkingPulse(ev);
  assert.strictEqual(w.orbs[0].count('thinkingPulse'), 1, 'nothing after the call is let go');
  const w2 = world({ prefs: { choice: 'pack:owl' }, packs: PACKS });
  w2.display.start(); await flushP();
  assert.doesNotThrow(() => w2.display.thinkingPulse(ev), 'a character player has no thinkingPulse');
  const w3 = world({ prefs: { choice: 'none' } });
  assert.doesNotThrow(() => w3.display.thinkingPulse(ev), 'no view at all');
});

test('Orb: built with the call, states map, mic level drives it, no mood request (the orb has no tag), hello not played', async () => {
  const w = world({ prefs: { choice: 'orb' }, agentDefault: 'pack:owl', orb: { react: (m) => CD.MOODS.includes(m) } });   // the real orb answers true only for the seven moods
  w.display.start(); await flushP();
  const orb = w.orbs[0];
  assert.ok(orb && w.dom.overlay(), 'the overlay and the orb exist');
  assert.strictEqual(w.display.activeFacePack(), null, 'the mood-tag request is only for a character with reactions');
  assert.strictEqual(orb.last('setState'), 'idle');
  w.display.setState('listening');
  assert.strictEqual(orb.last('setState'), 'listening', 'the orb has no hello clip: listening at once');
  w.display.setState('hearing'); assert.strictEqual(orb.last('setState'), 'listening');
  w.display.level(-35); assert.ok(Math.abs(orb.last('setMicLevel') - 0.5) < 1e-9);
  w.display.setState('thinking'); assert.strictEqual(orb.last('setState'), 'thinking');
  w.display.setState('speaking'); assert.strictEqual(orb.last('setState'), 'thinking', 'speaking waits for the audio');
  w.display.mood('t1', 'delighted'); assert.notStrictEqual(orb.last('react'), 'delighted', 'queued: nothing plays before the reply is over');
  w.display.reply('end', 't1'); assert.strictEqual(orb.last('react'), 'delighted', 'a brief pulse once the whole reply is over');
});

test('Character: the pack is fetched, its background and name are data, hello plays without blocking, hearing cancels it, the tag is requested only with reactions', async () => {
  const w = world({ prefs: { choice: 'pack:owl' } });
  w.display.start();
  assert.strictEqual(w.players.length, 0, 'nothing is built until the pack list says the character exists');
  await flushP();
  const p = w.players[0];
  assert.ok(p, 'built once the list arrived');
  assert.strictEqual(p.options.packId, 'owl');
  assert.strictEqual(p.options.fit, 'contain');
  assert.strictEqual(p.options.label, 'Owl <b>x</b>', 'the name is passed as data, not markup');
  assert.strictEqual(w.dom.overlay().all().find(n => n.className === 'ucd-stage').props['--ucd-bg'], '#ffd6ab');
  assert.strictEqual(w.display.activeFacePack(), 'owl');
  w.display.setState('starting'); assert.strictEqual(p.last('setState'), 'idle');
  w.display.setState('listening');
  assert.strictEqual(p.count('react'), 1); assert.strictEqual(p.last('react'), 'hello');
  assert.strictEqual(p.last('setState'), 'idle', 'hello holds the picture, the microphone is not held');
  w.display.setState('hearing');
  assert.strictEqual(p.last('setState'), 'listening', 'actual hearing cancels hello');
  w.display.setState('listening'); assert.strictEqual(p.count('react'), 1, 'hello once');
  // and the timer path: hello ends by itself
  const w2 = world({ prefs: { choice: 'pack:owl' } }); w2.display.start(); await flushP();
  w2.display.setState('listening'); assert.strictEqual(w2.players[0].last('setState'), 'idle');
  await w2.clk.advance(CD.HELLO_MS + 10); assert.strictEqual(w2.players[0].last('setState'), 'listening');
  const w3 = world({ prefs: { choice: 'pack:plain' } }); w3.display.start(); await flushP();
  assert.strictEqual(w3.display.activeFacePack(), null, 'a pack without reactions: no tag request');
});

test('reply audio gates the analyser: speaking only after the audio starts, the beak closes at once on end, cut and barge-in; device speech maps for both players', async () => {
  const w = world({ prefs: { choice: 'pack:owl' } }); w.display.start(); await flushP();
  const p = w.players[0], mkCtx = () => ({ destination: { id: 'dest' }, createAnalyser() { const a = { id: 'an', connected: [], connect(x) { this.connected.push(x); } }; return a; } });
  const ctx = mkCtx();
  w.display.setState('listening'); w.display.setState('thinking'); w.display.setState('speaking');
  assert.strictEqual(p.last('setState'), 'thinking', 'the speech is only being fetched');
  const s1 = { connected: [], connect(x) { this.connected.push(x); } };
  assert.strictEqual(w.display.routeBufferSource(ctx, s1), true);
  assert.deepStrictEqual(s1.connected.map(x => x.id), ['an'], 'source -> analyser only');
  w.display.audioStart();
  const an = s1.connected[0];
  assert.strictEqual(an.fftSize, 2048); assert.strictEqual(an.smoothingTimeConstant, 0);
  assert.deepStrictEqual(an.connected, [ctx.destination], 'analyser -> destination: audible once');
  assert.strictEqual(p.last('setState'), 'speaking'); assert.strictEqual(p.last('setAnalyser'), an);
  w.display.audioEnd(); assert.strictEqual(p.last('setAnalyser'), null, 'closed when a sentence ends');
  const s2 = { connected: [], connect(x) { this.connected.push(x); } };
  w.display.routeBufferSource(ctx, s2); w.display.audioStart();
  assert.strictEqual(s2.connected[0], an, 'one analyser per context, reused');
  assert.strictEqual(an.connected.length, 1, 'connected to the destination once');
  w.display.audioStop();
  assert.strictEqual(p.last('setAnalyser'), null, 'closed at once on barge-in'); assert.strictEqual(p.last('speechEvent'), 'cancel');
  w.display.setState('hearing'); assert.strictEqual(p.last('setState'), 'listening');
  // a context without an analyser falls back to plain playback and the device-speech rhythm
  const s3 = { connected: [], connect(x) { this.connected.push(x); } };
  assert.strictEqual(w.display.routeBufferSource({ destination: 'D' }, s3), false); assert.deepStrictEqual(s3.connected, ['D']);
  w.display.setState('speaking'); w.display.audioStart();
  assert.strictEqual(p.last('speechEvent'), 'start'); assert.strictEqual(p.last('setState'), 'speaking');
  for (const k of ['boundary', 'pause', 'resume', 'end']) { w.display.speech(k); assert.strictEqual(p.last('speechEvent'), k); }
  // the Orb only knows start / boundary / end: cancel and pause become end
  const o = world({ prefs: { choice: 'orb' } }); o.display.start(); await flushP();
  const orb = o.orbs[0]; o.display.setState('speaking'); o.display.speech('start'); assert.strictEqual(orb.last('speechEvent'), 'start');
  o.display.speech('pause'); assert.strictEqual(orb.last('speechEvent'), 'end');
  o.display.speech('cancel'); assert.strictEqual(orb.last('speechEvent'), 'end');
  o.display.speech('resume'); assert.strictEqual(orb.last('speechEvent'), 'boundary');
  // a throwing routing never leaves the source unconnected
  const s4 = { connected: [], connect(x) { this.connected.push(x); } };
  w.display.routeBufferSource({ destination: 'D', createAnalyser() { throw new Error('no'); } }, s4); assert.deepStrictEqual(s4.connected, ['D']);
});

test('phone: one media element source per element, only through a running context; a suspended or failing context leaves native playback (never mute)', async () => {
  const made = [];
  function Ctx() { this.state = 'running'; this.destination = { id: 'D' }; this.resumed = 0; this.resume = () => { this.resumed++; return Promise.resolve(); }; this.close = () => Promise.resolve();
    this.createAnalyser = () => ({ connected: [], connect(x) { this.connected.push(x); } });
    this.createMediaElementSource = (el) => { made.push(el); return { connected: [], connect(x) { this.connected.push(x); } }; }; made.ctx = this; }
  const w = world({ prefs: { choice: 'orb' }, needsContext: true, AudioContext: Ctx });
  w.display.start(); await flushP();
  assert.ok(made.ctx && made.ctx.resumed >= 1, 'the context was made and resumed inside start (the tap)');
  const el = { id: 'audio' };
  assert.strictEqual(w.display.routeElement(el), true); assert.strictEqual(w.display.routeElement(el), true); assert.strictEqual(w.display.routeElement(el), true);
  assert.strictEqual(made.length, 1, 'createMediaElementSource only once for the reused element');
  w.display.audioStart(); assert.ok(w.orbs[0].last('setAnalyser'));
  // suspended: not routed
  made.length = 0;
  function Ctx2() { Ctx.call(this); this.state = 'suspended'; }
  const w2 = world({ prefs: { choice: 'orb' }, needsContext: true, AudioContext: Ctx2 }); w2.display.start(); await flushP();
  assert.strictEqual(w2.display.routeElement({}), false); assert.strictEqual(made.length, 0, 'a suspended context is never put in the path (it would be silent)');
  w2.display.audioStart(); assert.strictEqual(w2.orbs[0].last('speechEvent'), 'start', 'device-style rhythm instead');
  // throwing source: native
  function Ctx3() { Ctx.call(this); this.createMediaElementSource = () => { throw new Error('already'); }; }
  const w3 = world({ prefs: { choice: 'orb' }, needsContext: true, AudioContext: Ctx3 }); w3.display.start(); await flushP();
  assert.strictEqual(w3.display.routeElement({}), false);
  // a context that cannot even be made
  const w4 = world({ prefs: { choice: 'orb' }, needsContext: true, AudioContext: function () { throw new Error('no audio'); } });
  assert.doesNotThrow(() => w4.display.start()); assert.strictEqual(w4.display.routeElement({}), false);
});

test('moods: once per turn however they arrive, unknown words ignored, nothing after hang-up; the request word list is the fixed one', async () => {
  const w = world({ prefs: { choice: 'pack:owl' } }); w.display.start(); await flushP();
  const p = w.players[0];
  w.display.reply('turn', 'seq:1');
  assert.strictEqual(w.display.mood('seq:1', 'proud'), true);
  assert.strictEqual(w.display.mood('seq:1', 'laughing'), false, 'the second mood of one turn (SSE and hub event) is dropped');
  assert.strictEqual(p.count('react'), 0, 'queued until the reply is over');
  w.display.reply('end', 'seq:1');
  w.display.reply('turn', 'seq:2');
  assert.strictEqual(w.display.mood('seq:2', 'grumpy'), false); assert.strictEqual(w.display.mood('seq:2', '[proud]'), false);
  assert.strictEqual(w.display.mood('seq:2', 'curious'), true);
  w.display.reply('end', 'seq:2');
  assert.deepStrictEqual(p.calls.filter(c => c[0] === 'react').map(c => c[1]), ['proud', 'curious']);
  assert.deepStrictEqual(CD.MOODS, ['delighted', 'laughing', 'sympathetic', 'surprised', 'proud', 'curious', 'encouraging']);
  const done = w.display.hangUp();
  assert.strictEqual(w.display.mood('seq:3', 'proud'), false, 'stale after hang-up');
  assert.strictEqual(w.display.activeFacePack(), null);
  w.display.setState('speaking'); w.display.audioStart(); w.display.caption('x'); w.display.level(-20);
  await w.clk.advance(CD.GOODBYE_MS + 5); await done;
});

test('captions: off by default and a local pref; show the spoken sentence as text only; a mood tag or markup never becomes markup', async () => {
  const w = world({ prefs: { choice: 'orb' } }); w.display.start(); await flushP();
  const cap = () => w.dom.overlay().all().find(n => n.className === 'ucd-caption');
  w.display.caption('Hello there.'); assert.strictEqual(cap().textContent, ''); assert.strictEqual(cap().hidden, true, 'off by default');
  w.display.setCaptions(true);
  assert.deepStrictEqual(CD.loadDisplayPrefs(w.storage), { choice: 'orb', captions: true }, 'saved locally');
  w.display.caption('[proud] Well done <img src=x onerror=alert(1)>.');
  assert.strictEqual(cap().textContent, 'Well done <img src=x onerror=alert(1)>.'); assert.strictEqual(cap().children.length, 0, 'text node only');
  assert.strictEqual(cap().hidden, false);
  w.display.caption('[unknown] keep'); assert.strictEqual(cap().textContent, '[unknown] keep', 'only a mood word is a tag');
  w.display.caption('x'.repeat(2000)); assert.ok(cap().textContent.length <= 400);
  w.display.clearCaption(); assert.strictEqual(cap().hidden, true);
  w.display.setCaptions(false); assert.strictEqual(cap().hidden, true);
  assert.ok(!/innerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(read('lib/ui-call-display.js').replace(/\/\*[\s\S]*?\*\//g, '')), 'no markup or code from data');
});

test('a live choice change updates the view without ending the call; a missing character leaves the saved choice and shows a note, never the Orb', async () => {
  const w = world({ prefs: { choice: 'pack:owl' } }); w.display.start(); await flushP();
  const first = w.players[0]; w.display.setState('thinking');
  assert.strictEqual(w.display.setChoice('orb'), true); await flushP();
  assert.ok(first.destroyed, 'the character is let go'); assert.strictEqual(w.orbs.length, 1);
  assert.strictEqual(w.orbs[0].last('setState'), 'thinking', 'the new view starts in the call\'s current state');
  assert.strictEqual(w.log.hang, 0, 'the call was not ended');
  assert.strictEqual(w.display.setChoice('none'), true); assert.strictEqual(w.dom.overlay(), null); assert.ok(w.orbs[0].destroyed);
  assert.strictEqual(w.display.setChoice('pack:ghost'), true); await flushP();
  assert.strictEqual(w.dom.overlay(), null); assert.strictEqual(w.display.info().kind, 'none');
  assert.ok(/not installed/.test(w.display.info().note));
  assert.strictEqual(CD.loadDisplayPrefs(w.storage).choice, 'pack:ghost', 'the preference stays saved');
  assert.strictEqual(w.display.setChoice('bogus'), false);
  assert.strictEqual(w.display.setChoice('follow'), true); assert.strictEqual(w.display.info().kind, 'none', 'follow with no agent default: None');
});

test('a pack that cannot load falls back to None with a note (not the Orb) and the choice stays saved', async () => {
  const w = world({ prefs: { choice: 'pack:owl' }, pack: { rejectReady: true } }); w.display.start(); await flushP();
  assert.strictEqual(w.display.info().kind, 'none'); assert.strictEqual(w.dom.overlay(), null); assert.strictEqual(w.orbs.length, 0);
  assert.ok(/could not load/.test(w.display.info().note)); assert.strictEqual(CD.loadDisplayPrefs(w.storage).choice, 'pack:owl');
  const f = world({ prefs: { choice: 'pack:owl' }, fetch: jsonFetch([], 500) }); f.display.start(); await flushP();
  assert.strictEqual(f.display.info().kind, 'none'); assert.strictEqual(f.display.info().packsState, 'failed'); assert.strictEqual(f.orbs.length, 0);
});

test('a pack list that arrives after hang-up, release or a replacement never opens a view', async () => {
  let release; const slow = () => new Promise((res) => { release = () => res({ ok: true, status: 200, json: async () => ({ packs: PACKS }) }); });
  const w = world({ prefs: { choice: 'pack:owl' }, fetch: slow }); w.display.start(); await tick();
  const ended = w.display.hangUp(); await ended;   // nothing on screen: no goodbye to wait for
  release(); await flushP();
  assert.strictEqual(w.players.length, 0); assert.strictEqual(w.dom.overlay(), null);
  const w2 = world({ prefs: { choice: 'pack:owl' }, fetch: slow }); w2.display.start(); await tick();
  w2.display.release(); release(); await flushP();
  assert.strictEqual(w2.players.length, 0); assert.strictEqual(w2.dom.overlay(), null);
  // a stale answer for an earlier request (the choice changed to orb meanwhile) does not replace the orb
  const w3 = world({ prefs: { choice: 'pack:owl' }, fetch: slow }); w3.display.start(); await tick();
  w3.display.setChoice('orb'); await flushP(); release(); await flushP();
  assert.strictEqual(w3.players.length, 0, 'the orb stays'); assert.strictEqual(w3.orbs.length, 1);
});

test('the real controls move into the view with a placeholder and go back before teardown; Back to chat hides without ending; Show display returns', async () => {
  const w = world({ prefs: { choice: 'orb' }, adopt: () => [{ el: bar, label: 'Call' }, { el: pop, label: 'Voice settings', wrapClass: 'voice-extra', show: true, prepare: () => { prepared++; }, release: () => { released++; } }] });
  const { dom } = w;
  const composer = new dom.El('div'), bar = new dom.El('div'), pop = new dom.El('div'), other = new dom.El('div');
  bar.id = 'voice-callbar-c1'; pop.hidden = true; let prepared = 0, released = 0;
  composer.appendChild(other); composer.appendChild(bar); composer.appendChild(pop); dom.doc.body.appendChild(composer);
  const before = composer.children.slice();
  w.display.start(); await flushP();
  const ov = dom.overlay();
  assert.ok(ov.contains(bar) && ov.contains(pop), 'the actual elements are inside the view');
  assert.strictEqual(pop.hidden, false); assert.strictEqual(prepared, 1);
  assert.ok(!composer.children.includes(bar), 'moved, not copied: one element, no duplicate ids');
  assert.strictEqual(dom.doc.body.all().filter(n => n === bar).length, 1);
  assert.ok(composer.children.some(c => c.className === 'ucd-placeholder'), 'a placeholder keeps the place');
  const back = dom.find('ucd-back')[0]; back.click();
  assert.strictEqual(dom.overlay(), null, 'the view is gone'); assert.ok(w.orbs[0].destroyed, 'nothing is drawn behind the chat');
  assert.deepStrictEqual(composer.children, before, 'controls are back exactly where they were, placeholders gone');
  assert.strictEqual(pop.hidden, true, 'the panel is closed again'); assert.strictEqual(released, 1);
  assert.strictEqual(w.log.hang, 0, 'Back to chat does not end the call');
  const reopen = dom.find('ucd-reopen')[0]; assert.ok(reopen, 'a way back to the display'); assert.strictEqual(w.display.activeFacePack(), null);
  w.display.setState('thinking');
  reopen.click();
  assert.ok(dom.overlay() && dom.overlay().contains(bar)); assert.strictEqual(w.orbs.length, 2); assert.strictEqual(w.orbs[1].last('setState'), 'thinking');
  assert.strictEqual(dom.find('ucd-reopen').length, 0);
  // Escape returns to the chat as well
  dom.overlay().dispatch('keydown', { key: 'Escape' }); assert.strictEqual(dom.overlay(), null);
  // teardown restores and leaves nothing
  w.display.showView(); w.display.release();
  assert.deepStrictEqual(composer.children, before); assert.strictEqual(dom.find('ucd-reopen').length + dom.find('ucd-overlay').length, 0);
});

test('Talk and Hang up call the page; the view is a labelled modal dialog; focus goes to Talk and returns; Tab stays inside', async () => {
  const w = world({ prefs: { choice: 'orb' } }); const { dom } = w;
  const opener = new dom.El('button'); dom.doc.body.appendChild(opener); opener.focus();
  w.display.start(); await flushP();
  const ov = dom.overlay();
  assert.strictEqual(ov.attrs.role, 'dialog'); assert.strictEqual(ov.attrs['aria-modal'], 'true'); assert.ok(ov.attrs['aria-label']);
  const talk = dom.find('ucd-talk')[0], hang = dom.find('ucd-hang')[0];
  assert.strictEqual(dom.doc.activeElement, talk);
  talk.click(); assert.strictEqual(w.log.talk, 1); hang.click(); assert.strictEqual(w.log.hang, 1);
  for (const b of ov.all().filter(n => n.tagName === 'BUTTON')) assert.ok(b.attrs['aria-label'], 'every button has a name');
  const ctl = dom.find('ucd-ctl')[0]; assert.strictEqual(ctl.attrs['aria-expanded'], 'false'); ctl.click(); assert.strictEqual(ctl.attrs['aria-expanded'], 'true');
  ctl.click();
  const last = dom.find('ucd-ctl')[0]; last.focus();
  let prevented = false; ov.dispatch('keydown', { key: 'Tab', shiftKey: false, preventDefault() { prevented = true; } });
  assert.ok(prevented); assert.strictEqual(dom.doc.activeElement, talk, 'wraps to the first control');
  w.display.release(); assert.strictEqual(dom.doc.activeElement, opener, 'focus returns to where it was');
  const status = ov.all().find(n => n.className === 'ucd-status'); assert.strictEqual(status.attrs['aria-live'], 'polite');
});

test('hang-up: the controls return at once, the buttons stop, the character says goodbye for a bounded time; Orb and release have no delay', async () => {
  const w = world({ prefs: { choice: 'pack:owl' }, adopt: () => [{ el: bar }] }); const { dom } = w;
  const home = new dom.El('div'), bar = new dom.El('div'); home.appendChild(bar); dom.doc.body.appendChild(home);
  w.display.start(); await flushP();
  w.display.setState('listening'); w.display.audioStart(); w.display.caption('x');
  let done = false; const p = w.display.hangUp().then(() => { done = true; });
  assert.strictEqual(home.children[0], bar, 'no original control is left in the view during the goodbye');
  assert.strictEqual(w.players[0].last('react'), 'goodbye'); assert.strictEqual(w.players[0].last('setAnalyser'), null);
  assert.ok(dom.overlay(), 'still showing for the goodbye');
  assert.ok(dom.find('ucd-hang')[0].disabled && dom.find('ucd-talk')[0].disabled);
  assert.ok(w.display.info().ending); w.display.setState('speaking'); assert.notStrictEqual(w.players[0].last('setState'), 'speaking', 'stale events are ignored');
  await w.clk.advance(CD.GOODBYE_MS - 50); assert.strictEqual(done, false);
  await w.clk.advance(100); await p; assert.strictEqual(done, true); assert.strictEqual(dom.overlay(), null); assert.ok(w.players[0].destroyed);
  assert.strictEqual(w.clk.timers.length, 0, 'no timer is left');
  // an Orb has no goodbye clip: it goes at once
  const o = world({ prefs: { choice: 'orb' }, orb: { react: (m) => CD.MOODS.includes(m) } }); o.display.start(); await flushP(); await o.display.hangUp(); assert.strictEqual(o.dom.overlay(), null);
  // a character without a goodbye: at once as well
  const n = world({ prefs: { choice: 'pack:owl' }, pack: { react: false } }); n.display.start(); await flushP(); await n.display.hangUp(); assert.strictEqual(n.dom.overlay(), null);
  // release (hidden / frozen / failed): no animation, no waiting
  const r = world({ prefs: { choice: 'pack:owl' } }); r.display.start(); await flushP(); r.display.release();
  assert.strictEqual(r.dom.overlay(), null); assert.strictEqual(r.players[0].count('react'), 0, 'no goodbye played'); assert.ok(r.players[0].destroyed); assert.strictEqual(r.clk.timers.length, 0);
  r.display.release(); r.display.release();   // twice: harmless
});

test('the unobtrusive note appears in the view and the selector lists Follow / None / Orb / packs, keeping a saved missing pack selectable', () => {
  const dom = fakeDom(); const sel = dom.doc.createElement('select'); sel.appendChild(dom.doc.createElement('option'));
  CD.fillDisplaySelect(dom.doc, sel, { choice: 'pack:ghost', packs: PACKS });
  assert.deepStrictEqual(sel.children.map(o => o.value), ['follow', 'none', 'orb', 'pack:owl', 'pack:plain', 'pack:ghost']);
  assert.strictEqual(sel.children[3].textContent, 'Owl <b>x</b>', 'names are text'); assert.strictEqual(sel.children[5].textContent, 'ghost (not installed)'); assert.strictEqual(sel.value, 'pack:ghost');
  CD.fillDisplaySelect(dom.doc, sel, { choice: 'orb', packs: [] });
  assert.deepStrictEqual(sel.children.map(o => o.value), ['follow', 'none', 'orb']); assert.strictEqual(sel.value, 'orb');
});

test('fetchPacks: only the packs route, same-origin credentials, entries validated, a failure rejects', async () => {
  const calls = [];
  const list = await CD.fetchPacks(async (u, o) => { calls.push([u, o]); return { ok: true, json: async () => ({ packs: [{ id: 'owl', name: 'Owl', background: '#fff', hasReactions: true }, { id: '../x', name: 'bad' }, { id: 'ok', name: 5, background: 'url(javascript:1)' }, null] }) }; });
  assert.deepStrictEqual(calls, [['/api/faces', { credentials: 'same-origin' }]]);
  assert.deepStrictEqual(list, [{ id: 'owl', name: 'Owl', background: '#fff', hasReactions: true }, { id: 'ok', name: 'ok', background: '', hasReactions: false }]);
  await assert.rejects(CD.fetchPacks(async () => ({ ok: false, status: 401 })));
  await assert.rejects(CD.fetchPacks(null));
});

// ── serving and loading ──
test('the pages load the three scripts and the stylesheet before app.js / mobile.js, and the server aliases serve them', () => {
  for (const [page, main] of [['index.html', 'app.js'], ['mobile.html', 'mobile.js']]) {
    const h = read(page);
    const at = (s) => h.indexOf(s);
    assert.ok(at('/ui-call-display.css') > 0 && at('/ui-call-display.css') < at('</head>'), page + ' stylesheet in the head');
    assert.ok(at('/ui-voice-orb.js') > 0 && at('/ui-voice-orb.js') < at('/ui-call-display.js') && at('/ui-face-player.js') < at('/ui-call-display.js'), page + ' modules before the shared view');
    assert.ok(at('/ui-call-display.js') < at(`<script src="${main}">`), page + ' loads them before ' + main);
  }
  for (const [web, real] of [['/ui-voice-orb.js', 'lib/ui-voice-orb.js'], ['/ui-face-player.js', 'lib/ui-face-player.js'], ['/ui-call-display.js', 'lib/ui-call-display.js'], ['/ui-call-display.css', 'lib/ui-call-display.css']]) {
    const r = staticFiles.resolve(web); assert.ok(r && r.endsWith(real), web + ' is served'); assert.ok(fs.existsSync(r));
  }
  assert.strictEqual(staticFiles.resolve('/lib/ui-call-display.js'), null, 'only the alias, not the lib folder');
  assert.strictEqual(staticFiles.resolve('/ui-call-display.js/../server.js'), null);
});

test('the shared module is CSP-safe plain JS: no network but /api/faces, no inline style markup, nothing at load time, no retired code-drawn owl', () => {
  const src = read('lib/ui-call-display.js'), code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\brequire\(/.test(code) && !/XMLHttpRequest|WebSocket|sendBeacon|importScripts|\bimport\(/.test(code));
  assert.deepStrictEqual(code.match(/'\/api\/[^']*'/g), ["'/api/faces'"]);
  assert.ok(!/https?:\/\//.test(code), 'no external request');
  assert.ok(!/\.style\.cssText|setAttribute\('style'/.test(code), 'styles only through CSSOM property writes');
  assert.ok(!/owl/i.test(code.replace(/'owl'/g, '')), 'no owl drawing code');
  const css = read('lib/ui-call-display.css');
  assert.ok(/env\(safe-area-inset-top/.test(css) && /100dvh/.test(css) && /prefers-reduced-motion/.test(css), 'safe areas, mobile viewport and reduced motion');
  assert.ok(/\.ucd-talk[^}]*min-height: 64px/.test(css), 'large Talk');
  const ctx = require('vm').createContext({ globalThis: {} });
  assert.doesNotThrow(() => require('vm').runInContext(src, ctx), 'loads without running anything in a bare context');
});

test('held items waiting in the controls drawer are announced on the Controls button; the phone toast stays above the view', async () => {
  const w = world({ prefs: { choice: 'orb' } }); w.display.badge(2); w.display.start(); await flushP();
  const ctl = w.dom.find('ucd-ctl')[0];
  assert.strictEqual(ctl.textContent, 'Controls (2)'); assert.ok(/2 waiting/.test(ctl.attrs['aria-label']));
  w.display.badge(0); assert.strictEqual(ctl.textContent, 'Controls'); assert.strictEqual(ctl.attrs['aria-label'], 'Call controls');
  assert.ok(/#toast\.on \{ z-index: 10010/.test(read('lib/ui-call-display.css')));
  w.display.release();
});

// ── round 3 ──
test('release (or destroy) during the goodbye settles the hang-up promise at once and leaves no timer', async () => {
  const w = world({ prefs: { choice: 'pack:owl' } }); w.display.start(); await flushP();
  let settled = false; const p = w.display.hangUp().then(() => { settled = true; });
  await flushP(); assert.strictEqual(settled, false, 'the goodbye is playing');
  w.display.release(); await flushP(); assert.strictEqual(settled, true, 'released: the promise settles');
  assert.strictEqual(w.clk.timers.length, 0); await p;
});

test('hiding to the chat keeps the audio state; showing again (or a choice change) attaches to the live analyser, device speech restarts, audio is not interrupted', async () => {
  function Ctx() { this.state = 'running'; this.destination = { id: 'D' }; this.resume = () => Promise.resolve(); this.close = () => Promise.resolve();
    this.createAnalyser = () => ({ connected: [], connect(x) { this.connected.push(x); } }); this.createMediaElementSource = () => ({ connected: [], connect(x) { this.connected.push(x); } }); }
  const w = world({ prefs: { choice: 'pack:owl' }, needsContext: true, AudioContext: Ctx }); w.display.start(); await flushP();
  const el = {}; w.display.setState('speaking'); assert.strictEqual(w.display.routeElement(el), true); w.display.audioStart();
  const an = w.players[0].last('setAnalyser'); assert.ok(an);
  w.display.hideToChat(); assert.strictEqual(w.display.info().audio, true);
  w.display.showView(); await flushP(); assert.strictEqual(w.players[1].last('setAnalyser'), an);
  w.display.setChoice('orb'); await flushP(); assert.strictEqual(w.orbs[0].last('setAnalyser'), an);
  w.display.audioEnd(); assert.strictEqual(w.orbs[0].last('setAnalyser'), null);
  // device speech
  const d = world({ prefs: { choice: 'pack:owl' } }); d.display.start(); await flushP(); d.display.setState('speaking'); d.display.audioStart();
  assert.strictEqual(d.players[0].last('speechEvent'), 'start'); d.display.hideToChat(); d.display.showView(); await flushP();
  assert.strictEqual(d.players[1].last('speechEvent'), 'start'); d.display.speech('end'); assert.strictEqual(d.players[1].last('speechEvent'), 'end');
});

test('shared route: the context and the element source outlive a display; the next display reuses them; a closed shared context is replaced and reported', async () => {
  const made = [], ctxs = [];
  function Ctx() { ctxs.push(this); this.state = 'running'; this.closed = 0; this.destination = { id: 'D' }; this.resume = () => Promise.resolve(); this.close = () => { this.closed++; return Promise.resolve(); };
    this.createAnalyser = () => ({ connected: [], connect(x) { this.connected.push(x); } }); this.createMediaElementSource = (e) => { made.push(e); return { connected: [], connect(x) { this.connected.push(x); } }; }; }
  const shared = { ctx: null, routes: new WeakMap(), routed: 0 }; let lost = 0; const el = { id: 'a' };
  const a = world({ prefs: { choice: 'orb' }, needsContext: true, AudioContext: Ctx, shared, onRoutesLost: () => { lost++; } }); a.display.start(); await flushP();
  assert.strictEqual(a.display.routeElement(el), true); a.display.release();
  assert.strictEqual(ctxs[0].closed, 0, 'a routed context is kept'); assert.strictEqual(shared.ctx, ctxs[0]);
  const b = world({ prefs: { choice: 'orb' }, needsContext: true, AudioContext: Ctx, shared, onRoutesLost: () => { lost++; } }); b.display.start(); await flushP();
  assert.strictEqual(ctxs.length, 1); assert.strictEqual(b.display.routeElement(el), true); assert.strictEqual(made.length, 1, 'the element source is made once, for ever');
  b.display.release();
  ctxs[0].state = 'closed';
  const c = world({ prefs: { choice: 'orb' }, needsContext: true, AudioContext: Ctx, shared, onRoutesLost: () => { lost++; } }); c.display.start(); await flushP();
  assert.strictEqual(ctxs.length, 2); assert.strictEqual(lost, 1); c.display.release();
  // a shared context that routed nothing is closed with the display
  const s2 = { ctx: null, routes: new WeakMap(), routed: 0 }; const n0 = ctxs.length;
  const d = world({ prefs: { choice: 'orb' }, needsContext: true, AudioContext: Ctx, shared: s2 }); d.display.start(); await flushP(); d.display.release();
  assert.strictEqual(ctxs[n0].closed, 1); assert.strictEqual(s2.ctx, null);
});

test('shared route behind a suspended context: resumed, no claim of audio until it runs, then the analyser attaches', async () => {
  let fin = null, st = 'running';
  function Ctx() { this.destination = {}; Object.defineProperty(this, 'state', { get: () => st }); this.resume = () => new Promise((r) => { fin = () => { st = 'running'; r(); }; }); this.close = () => Promise.resolve();
    this.createAnalyser = () => ({ connect() {} }); this.createMediaElementSource = () => ({ connect() {} }); }
  const shared = { ctx: null, routes: new WeakMap(), routed: 0 }; const el = {};
  const w = world({ prefs: { choice: 'pack:owl' }, needsContext: true, AudioContext: Ctx, shared }); w.display.start(); await flushP();
  assert.strictEqual(w.display.routeElement(el), true); w.display.setState('speaking');
  st = 'suspended'; assert.strictEqual(w.display.routeElement(el), false, 'captured but silent: not claimed');
  w.display.audioStart(); assert.strictEqual(w.players[0].calls.filter(c => c[0] === 'speechEvent').length, 0); assert.strictEqual(w.players[0].last('setAnalyser'), undefined);
  fin(); await flushP(); assert.ok(w.players[0].last('setAnalyser'), 'attached once the context runs');
});

test('device speech is tracked with no view: under None, hidden, pause / resume, end and cancel while hidden; a view opened later attaches only to what is really heard', async () => {
  const evs = (pl) => pl.calls.filter(c => c[0] === 'speechEvent').map(c => c[1]);
  // None: nothing to forward, nothing thrown, state kept
  const w = world({ prefs: { choice: 'none' } }); w.display.start(); await flushP();
  w.display.setState('speaking'); assert.doesNotThrow(() => w.display.speech('start')); assert.strictEqual(w.display.info().audio, true);
  w.display.setChoice('pack:owl'); await flushP(); assert.strictEqual(w.players[0].last('speechEvent'), 'start', 'chosen mid-sentence: attaches');
  assert.strictEqual(w.players[0].last('setState'), 'speaking');
  // hidden: end while hidden is remembered; reopen does not fake a start
  w.display.hideToChat(); w.display.speech('end'); assert.strictEqual(w.display.info().audio, false);
  w.display.showView(); await flushP(); assert.ok(!evs(w.players[1]).includes('start'));
  // cancel while hidden
  w.display.speech('start'); w.display.hideToChat(); w.display.speech('cancel'); w.display.showView(); await flushP();
  assert.strictEqual(w.display.info().audio, false); assert.ok(!evs(w.players[2]).includes('start'));
  // pause clears, resume sets (no view), and a view opened after resume attaches
  w.display.speech('start'); w.display.hideToChat(); w.display.speech('pause'); assert.strictEqual(w.display.info().audio, false);
  w.display.speech('resume'); assert.strictEqual(w.display.info().audio, true); w.display.showView(); await flushP();
  assert.strictEqual(w.players[3].last('speechEvent'), 'start');
  // forwarding still maps for the orb only when forwarding; a pack gets the raw kind
  w.display.speech('pause'); assert.strictEqual(w.players[3].last('speechEvent'), 'pause');
  const o = world({ prefs: { choice: 'orb' } }); o.display.start(); await flushP();
  o.display.speech('start'); o.display.speech('pause'); assert.strictEqual(o.orbs[0].last('speechEvent'), 'end'); o.display.speech('resume'); assert.strictEqual(o.orbs[0].last('speechEvent'), 'boundary');
  o.display.speech('cancel'); assert.strictEqual(o.orbs[0].last('speechEvent'), 'end'); assert.strictEqual(o.display.info().audio, false);
  // after hang-up nothing is tracked
  const done = w.display.hangUp(); w.display.speech('start'); assert.strictEqual(w.display.info().audio, false); await w.clk.advance(CD.GOODBYE_MS + 5); await done;
});

// ── call bar placement, captions, notice bars (try-it fixes) ──
function barWorld(o) {
  const w = world(Object.assign({ prefs: { choice: 'orb' } }, o));
  const { dom } = w;
  const tabs = new dom.El('div'), notify = new dom.El('button'), chatTab = new dom.El('button'); notify.className = 'tab-notify'; chatTab.className = 'tab-chat'; tabs.appendChild(notify); tabs.appendChild(chatTab);
  const page = new dom.El('div'), bar = new dom.El('div'), top = new dom.El('div'), hang = new dom.El('button'); hang.className = 'vcb-hang'; bar.id = 'voice-callbar-c1'; top.appendChild(hang); bar.appendChild(top);
  page.appendChild(tabs); page.appendChild(bar); dom.doc.body.appendChild(page);
  return Object.assign(w, { tabs, bar, top, hang, page, reopenHost: () => hang });
}
function barDisplay(o) {
  const dom = fakeDom(), clk = clock(), orbs = [], tabs = new dom.El('div'), page = new dom.El('div'), bar = new dom.El('div'), top = new dom.El('div'), hang = new dom.El('button');
  hang.className = 'vcb-hang'; bar.id = 'voice-callbar-c1'; top.appendChild(hang); bar.appendChild(top); page.appendChild(tabs); page.appendChild(bar); dom.doc.body.appendChild(page);
  let host = hang;
  const log = { hang: 0 };
  const display = CD.createCallDisplay({ window: { document: dom.doc }, document: dom.doc, storage: memStorage({ [CD.DISPLAY_STORE_KEY]: JSON.stringify({ choice: 'orb', captions: true }) }), fetch: jsonFetch(PACKS),
    setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout, agentDefault: () => 'none', adopt: () => [{ el: bar, label: 'Call' }], reopenHost: () => host,
    onTalk() {}, onHangUp: () => { log.hang++; }, onChange() {}, createVoiceOrb: fakePlayerFactory('orb', orbs), createFacePlayer: fakePlayerFactory('pack', [], {}) });
  return { dom, display, tabs, page, bar, top, hang, orbs, log, setHost: (h) => { host = h; } };
}

test('Show display sits inside the call bar right before Hang up (never in the body or by the tabs), and is gone when the view is shown', async () => {
  const w = barDisplay();
  w.display.start(); await flushP();
  assert.ok(w.dom.overlay().contains(w.bar), 'the bar was adopted into the view');
  assert.strictEqual(w.dom.find('ucd-reopen').length, 0);
  w.dom.find('ucd-back')[0].click();
  const r = w.dom.find('ucd-reopen')[0];
  assert.ok(r, 'the way back exists');
  assert.strictEqual(r.parentNode, w.top, 'inside the bar, in the same row as Hang up');
  assert.strictEqual(r.nextSibling === undefined ? w.top.children[w.top.children.indexOf(r) + 1] : r.nextSibling, w.hang, 'right beside Hang up');
  assert.ok(!w.dom.doc.body.children.includes(r) && !w.tabs.contains(r), 'not floating over the page, not in the tab strip');
  assert.strictEqual(w.page.children.includes(w.bar), true, 'the bar is back in the page');
  r.click();
  assert.ok(w.dom.overlay() && w.dom.overlay().contains(w.bar), 'Show display brings the view and the bar back');
  assert.strictEqual(w.dom.find('ucd-reopen').length, 0, 'removed while the view is shown');
  w.dom.find('ucd-back')[0].click();
  assert.strictEqual(w.dom.find('ucd-reopen').length, 1, 'back again after a second Back, once');
  w.display.release();
  assert.strictEqual(w.dom.find('ucd-reopen').length, 0, 'nothing is left after the call');
});

test('Show display: no call bar on screen -> no button at all (nothing floats); syncReopen puts it in when the bar is back', async () => {
  const w = barDisplay();
  w.display.start(); await flushP();
  w.setHost(null);
  w.dom.find('ucd-back')[0].click();
  assert.strictEqual(w.dom.find('ucd-reopen').length, 0, 'no host: no button, and none in the body');
  w.setHost(w.hang); w.display.syncReopen();
  assert.strictEqual(w.dom.find('ucd-reopen').length, 1); assert.strictEqual(w.dom.find('ucd-reopen')[0].parentNode, w.top);
  // the page re-made the bar: the button moves to the new Hang up
  const top2 = new w.dom.El('div'), hang2 = new w.dom.El('button'); top2.appendChild(hang2); w.page.appendChild(top2);
  w.setHost(hang2); w.display.syncReopen();
  assert.strictEqual(w.dom.find('ucd-reopen').length, 1); assert.strictEqual(w.dom.find('ucd-reopen')[0].parentNode, top2);
  w.display.syncReopen(); assert.strictEqual(w.dom.find('ucd-reopen').length, 1, 'idempotent');
});

test('captions: no band while the text is empty; the text clears when the reply ends and when the call stops speaking', async () => {
  const w = world({ prefs: { choice: 'orb', captions: true } });
  w.display.start(); await flushP();
  const cap = () => w.dom.overlay().all().find(n => n.className === 'ucd-caption');
  assert.strictEqual(cap().hidden, true, 'nothing said yet: no band');
  w.display.setState('speaking'); w.display.audioStart();
  w.display.caption('   '); assert.strictEqual(cap().hidden, true, 'whitespace: no band');
  w.display.caption('[proud]'); assert.strictEqual(cap().hidden, true, 'a mood tag alone: no band');
  w.display.caption('Here is the answer.'); assert.strictEqual(cap().hidden, false); assert.strictEqual(cap().textContent, 'Here is the answer.');
  w.display.audioEnd(); w.display.setState('speaking'); assert.strictEqual(cap().textContent, 'Here is the answer.', 'between sentences of one reply it stays');
  w.display.setState('listening');
  assert.strictEqual(cap().hidden, true); assert.strictEqual(cap().textContent, '', 'the reply is over: cleared');
  w.display.setState('speaking'); w.display.audioStart(); w.display.caption('Another.'); w.display.setState('thinking');
  assert.strictEqual(cap().hidden, true, 'a cut reply clears too');
  const css = fs.readFileSync(path.join(__dirname, '..', 'lib/ui-call-display.css'), 'utf8');
  assert.match(css, /\.ucd-caption:empty/, 'an empty caption element draws nothing even if its hidden flag is lost');
  assert.match(css, /\.ucd-caption \{[^}]*z-index: [1-9]/, 'the caption is above the player host (z-index 0)');
});

test('the full-screen view covers the page notice bars (above their z-index) and Back to chat restores the page', async () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'lib/ui-call-display.css'), 'utf8');
  const z = Number((css.match(/\.ucd-overlay \{[^}]*z-index: (\d+)/) || [])[1]);
  const idx = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const notices = [...idx.matchAll(/#(?:hub-update-card|update-chip)[^{]*\{[^}]*z-index: (\d+)/g)].map(m => Number(m[1]));
  assert.ok(z > 1100, 'above the desktop banner and menus (' + z + ')');
  for (const n of notices) assert.ok(z > n, 'above a notice at ' + n);
  const w = barDisplay();
  w.display.start(); await flushP(); assert.ok(w.dom.overlay());
  w.dom.find('ucd-back')[0].click();
  assert.strictEqual(w.dom.overlay(), null, 'Back removes the view and the page shows again');
  assert.ok(w.page.children.includes(w.bar));
});

test('showsPulse: true only while a view is up (None, hidden and ended: false)', async () => {
  const w = world({ prefs: { choice: 'orb' } });
  assert.strictEqual(w.display.showsPulse(), false); w.display.start(); await flushP(); assert.strictEqual(w.display.showsPulse(), true);
  w.display.hideToChat(); assert.strictEqual(w.display.showsPulse(), false); w.display.showView(); assert.strictEqual(w.display.showsPulse(), true);
  w.display.release(); assert.strictEqual(w.display.showsPulse(), false);
  const n = world({ prefs: { choice: 'none' } }); n.display.start(); await flushP(); assert.strictEqual(n.display.showsPulse(), false);
});

// ── final behavior: the reply's reaction, the pack-list retry, the goodbye of a player that is not ready ──
const reacts = (p) => p.calls.filter(c => c[0] === 'react' && c[1] !== 'hello' && c[1] !== 'goodbye').map(c => c[1]);   // the mood reactions (hello and goodbye are not moods)
async function charWorld(o) { const w = world(Object.assign({ prefs: { choice: 'pack:owl' } }, o)); w.display.start(); await flushP(); w.display.setState('thinking'); return w; }

test('reaction: queued per reply and played ONCE at the reply end, never while any reply audio is heard (clip audio or device voice)', async () => {
  const w = await charWorld(); const p = w.players[0];
  w.display.reply('turn', 'seq:1'); w.display.mood('seq:1', 'proud');
  w.display.setState('speaking'); w.display.audioStart(); w.display.audioEnd(); w.display.audioStart();   // sentences of the reply
  assert.deepStrictEqual(reacts(p), [], 'not between sentences, not while a sentence plays');
  w.display.reply('end', 'seq:1');
  assert.deepStrictEqual(reacts(p), [], 'audio still heard (the end came first): it waits for the audio to stop');
  w.display.audioEnd();
  assert.deepStrictEqual(reacts(p), ['proud'], 'played right after the audio ended');
  w.display.reply('end', 'seq:1'); w.display.audioEnd();
  assert.deepStrictEqual(reacts(p), ['proud'], 'once only');
  // device voice
  w.display.reply('turn', 'seq:2'); w.display.mood('seq:2', 'curious'); w.display.speech('start'); w.display.reply('end', 'seq:2');
  assert.deepStrictEqual(reacts(p), ['proud'], 'device speech still heard');
  w.display.speech('end');
  assert.deepStrictEqual(reacts(p), ['proud', 'curious']);
});

test('reaction: no speech (voice off, a failed line) plays at the reply end; a late mood plays at once; a stale or dropped one never', async () => {
  const w = await charWorld(); const p = w.players[0];
  w.display.reply('turn', 'seq:1'); w.display.reply('end', 'seq:1');   // no audio ever
  assert.strictEqual(w.display.mood('seq:1', 'laughing'), true, 'a late mood (the hub event after the end)');
  assert.deepStrictEqual(reacts(p), ['laughing']);
  w.display.reply('turn', 'seq:2'); w.display.mood('seq:2', 'proud');
  w.display.reply('turn', 'seq:3');   // the next turn began first: the old mood is over
  w.display.reply('end', 'seq:3');
  assert.deepStrictEqual(reacts(p), ['laughing'], 'a mood of an older turn is never played');
  assert.strictEqual(w.display.mood('seq:2', 'curious'), false, 'late for a closed turn');
  assert.strictEqual(w.display.mood('seq:3', 'curious'), true); assert.deepStrictEqual(reacts(p), ['laughing', 'curious']);
});

test('reaction: real speech before the end drops it (and a queued clip), a false start lifts the hold; hello and goodbye are untouched', async () => {
  const w = await charWorld(); const p = w.players[0];
  w.display.reply('turn', 'seq:1'); w.display.mood('seq:1', 'proud');
  w.display.reply('drop');
  assert.ok(p.count('cancelReaction') >= 1, 'a clip that was asked for and has not started is cancelled');
  w.display.reply('end', 'seq:1');
  assert.deepStrictEqual(reacts(p), [], 'the person is speaking: nothing plays');
  w.display.reply('resume');
  assert.deepStrictEqual(reacts(p), ['proud'], 'it was a false start: the reply ended, the reaction plays');
  w.display.reply('turn', 'seq:2'); w.display.mood('seq:2', 'curious'); w.display.reply('end', 'seq:2'); w.display.reply('drop'); w.display.reply('start');
  assert.deepStrictEqual(reacts(p), ['proud', 'curious']);
  // the next message of the person clears the hold and the old end
  w.display.reply('drop'); w.display.reply('turn', 'seq:3'); w.display.mood('seq:3', 'delighted'); w.display.reply('end', 'seq:3');
  assert.deepStrictEqual(reacts(p), ['proud', 'curious', 'delighted']);
  const g = w.display.hangUp(); assert.ok(g); w.display.reply('end', 'seq:3'); assert.strictEqual(p.last('react'), 'goodbye');
  w.display.release();
});

test('a view that is not shown at the end keeps no reaction for later', async () => {
  const w = await charWorld(); const p = w.players[0];
  w.display.reply('turn', 'seq:1'); w.display.mood('seq:1', 'proud'); w.display.hideToChat();
  w.display.reply('end', 'seq:1'); w.display.showView();
  assert.deepStrictEqual(w.players.flatMap(reacts).filter(x => x !== 'hello'), [], 'nothing replayed after the view came back');
});

test('packs list failure: choosing again retries, one automatic retry after a short wait, bounded, nothing after release or for a stale request', async () => {
  let calls = 0, okFrom = 99;
  const f = async () => { calls++; if (calls < okFrom) throw new Error('offline'); return { ok: true, status: 200, json: async () => ({ packs: PACKS }) }; };
  // a manual retry
  let w = world({ prefs: { choice: 'pack:owl' }, fetch: f }); w.display.start(); await flushP();
  assert.strictEqual(w.display.info().packsState, 'failed'); assert.strictEqual(calls, 1);
  okFrom = 3;   // the second call (the automatic one) still fails; the third works
  w.display.setChoice('pack:owl'); await flushP();
  assert.strictEqual(calls, 2, 'choosing again retries the list'); assert.strictEqual(w.display.info().packsState, 'failed');
  w.display.setChoice('pack:owl'); await flushP();
  assert.strictEqual(calls, 3); assert.strictEqual(w.display.info().packsState, 'ready'); assert.strictEqual(w.players.length, 1, 'the character is shown after the retry');
  w.display.release();
  // the automatic retry: once, after PACKS_RETRY_MS
  calls = 0; okFrom = 2;
  w = world({ prefs: { choice: 'pack:owl' }, fetch: f }); w.display.start(); await flushP();
  assert.strictEqual(calls, 1); assert.strictEqual(w.clk.timers.length, 1, 'one retry is waiting');
  await w.clk.advance(2900); assert.strictEqual(calls, 1, 'not before the wait');
  await w.clk.advance(200); await flushP();
  assert.strictEqual(calls, 2); assert.strictEqual(w.display.info().packsState, 'ready'); assert.strictEqual(w.players.length, 1);
  w.display.release();
  // failing again: no second automatic retry
  calls = 0; okFrom = 99;
  w = world({ prefs: { choice: 'pack:owl' }, fetch: f }); w.display.start(); await flushP();
  await w.clk.advance(3100); await flushP(); await w.clk.advance(60000); await flushP();
  assert.strictEqual(calls, 2, 'one automatic retry, no more'); w.display.release();
  // release before the retry: no timer, no request
  calls = 0; w = world({ prefs: { choice: 'pack:owl' }, fetch: f }); w.display.start(); await flushP();
  w.display.release(); assert.strictEqual(w.clk.timers.length, 0); await w.clk.advance(10000); assert.strictEqual(calls, 1);
  // a newer request makes the waiting retry stale
  calls = 0; okFrom = 99; w = world({ prefs: { choice: 'pack:owl' }, fetch: f }); w.display.start(); await flushP();
  w.display.setChoice('pack:owl'); await flushP(); const after = calls;
  await w.clk.advance(3100); await flushP(); assert.strictEqual(calls, after, 'the old timer does nothing');
  w.display.release();
});

test('hang-up with a character that is not ready (or failed) closes at once, no blank goodbye; a ready one still says goodbye', async () => {
  const w = world({ prefs: { choice: 'pack:owl' }, pack: { info: { ready: false, failed: null } } }); w.display.start(); await flushP();
  const p = w.players[0]; let settled = false;
  const r = w.display.hangUp().then(() => { settled = true; }); await flushP();
  assert.strictEqual(settled, true, 'settled at once'); assert.strictEqual(w.dom.overlay(), null, 'no overlay left'); assert.strictEqual(p.count('react'), 0, 'no goodbye asked of a player that cannot show it'); assert.strictEqual(w.clk.timers.length, 0);
  await r;
  const f = world({ prefs: { choice: 'pack:owl' }, pack: { info: { ready: false, failed: 'bad' } } }); f.display.start(); await flushP();
  await f.display.hangUp(); assert.strictEqual(f.dom.overlay(), null);
  const ok = world({ prefs: { choice: 'pack:owl' }, pack: { info: { ready: true, failed: null } } }); ok.display.start(); await flushP();
  ok.display.hangUp(); assert.strictEqual(ok.players[0].last('react'), 'goodbye'); assert.ok(ok.dom.overlay());
  ok.display.release();
});

// ── the reaction against the REAL call controller and the REAL display (fake player, fake clock): the boundaries are the controller's own ──
async function reactionWorld(o) {
  o = o || {};
  const w = world({ prefs: { choice: 'pack:owl' } }); w.display.start(); await flushP(); const p = w.players[0];
  const h = { w, p, t: 0, timers: [], id: 1, pend: [], spoken: [], sent: 0, ok: o.speakOk !== false };
  const setTimer = (fn, ms) => { const id = h.id++; h.timers.push({ id, at: h.t + ms, fn }); return id; };
  const clearTimer = (id) => { h.timers = h.timers.filter(x => x.id !== id); };
  h.advance = async (ms) => { const end = h.t + ms; for (;;) { const d = h.timers.filter(x => x.at <= end).sort((a, b) => a.at - b.at)[0]; if (!d) break; h.timers = h.timers.filter(x => x !== d); h.t = d.at; d.fn(); await tick(); } h.t = end; await tick(); };
  h.call = voiceCreateCall({
    agent: 'a', now: () => h.t, setTimer, clearTimer, prefs: () => ({ continueWait: 0, thinkingSound: false }),
    vad: { start: async () => {}, stop() {}, setPlaybackActive() {} },
    stt: async (a) => a.text, isTurnRunning: () => false, interject: async () => {}, stop() {},
    send: async () => { h.sent++; w.display.reply('turn', 'seq:' + h.sent); },   // the page's voiceCallSend
    speak: (t) => { h.spoken.push(t); if (!h.ok) return Promise.resolve(false); return new Promise((res) => { w.display.audioStart(); h.pend.push((ok) => { w.display.audioEnd(); res(ok); }); }); },
    cancelSpeech: () => { const r = h.pend.shift(); if (r) r(false); w.display.audioStop(); },
    answerAsk() {}, server: { start: async () => ({ callId: 'c1', held: [] }), heartbeat: async () => ({ held: [] }), mode: async () => {}, end: async () => ({ held: [] }), decide: async () => {} },
    ui: { state: (n) => w.display.setState(n), reply: (k) => w.display.reply(k, 'seq:' + h.sent) },
  });
  h.finish = async (ok = true) => { const r = h.pend.shift(); if (r) r(ok); await tick(); };
  h.say = async (text) => { h.call.onSpeechStart(); await h.call.onSpeechEnd({ text }); await tick(); };
  await h.call.start();
  return h;
}
const order = (p) => p.calls.map(c => c[0] + (c[1] !== undefined && c[0] !== 'setAnalyser' ? ':' + c[1] : ''));

test('reaction x controller: a reply of several sentences with gaps between them plays ONE reaction, right after the last sentence and before listening', async () => {
  const h = await reactionWorld(); await h.say('Please check the system status.');
  h.w.display.mood('seq:1', 'proud');
  h.call.onReplyText('First sentence. ', false); await tick();
  assert.deepStrictEqual(h.spoken, ['First sentence.']);
  await h.finish();   // the reader is idle: the text has not grown yet
  assert.deepStrictEqual(reacts(h.p), ['hello'].filter(() => false), 'a gap between two sentences is not the end of the reply');
  h.call.onReplyText('First sentence. Second sentence. ', false); await tick(); assert.strictEqual(h.spoken.length, 2);
  await h.finish(); assert.deepStrictEqual(reacts(h.p), []);
  h.call.onReplyText('First sentence. Second sentence. Third one.', true); await tick(); assert.strictEqual(h.spoken.length, 3);
  assert.deepStrictEqual(reacts(h.p), [], 'never while the third sentence plays');
  await h.finish();
  assert.deepStrictEqual(reacts(h.p), ['proud'], 'once, after the whole reply');
  const o = order(h.p); assert.ok(o.lastIndexOf('react:proud') < o.lastIndexOf('setState:listening'), 'before the call is shown listening: ' + o.join(' '));
  h.call.onReplyText('First sentence. Second sentence. Third one.', true); await tick();
  assert.deepStrictEqual(reacts(h.p), ['proud'], 'a repeated end does not play it again');
});

test('reaction x controller: voice off or failing, and a reply with nothing to say, play when the reply text is complete', async () => {
  const f = await reactionWorld({ speakOk: false }); await f.say('Please check the system status.');
  f.w.display.mood('seq:1', 'curious');
  f.call.onReplyText('Partial text. ', false); await tick();
  assert.deepStrictEqual(reacts(f.p), [], 'text still coming');
  f.call.onReplyText('Partial text. And the rest.', true); await tick();
  assert.deepStrictEqual(reacts(f.p), ['curious'], 'every line failed: at the text end, once');
  const e = await reactionWorld(); await e.say('Please check the system status.');
  e.w.display.mood('seq:1', 'delighted'); e.call.onReplyText('```\ncode\n```', true); await tick(); await e.finish();   // only a note / nothing readable
  assert.ok(reacts(e.p).length <= 1);
  const n = await reactionWorld({ speakOk: false }); await n.say('Please check the system status.');
  n.call.onReplyText('', true); await tick();
  n.w.display.mood('seq:1', 'laughing'); assert.deepStrictEqual(reacts(n.p), ['laughing'], 'a late mood after an empty reply');
});

test('reaction x controller: the person beginning real speech drops it; a false start does not; stop commands and later turns never replay it', async () => {
  let h = await reactionWorld(); await h.say('Please check the system status.');
  h.w.display.mood('seq:1', 'proud');
  h.call.onReplyText('First sentence. Second sentence.', true); await tick();
  h.call.onSpeechStart();   // real speech over the reply
  assert.deepStrictEqual(reacts(h.p), []); assert.ok(h.p.count('cancelReaction') >= 1);
  await h.call.onSpeechEnd({ text: 'never mind' }); await tick();
  assert.deepStrictEqual(reacts(h.p), [], 'dropped: it does not come back after the person finished');
  h.w.display.mood('seq:1', 'curious');
  assert.deepStrictEqual(reacts(h.p), [], 'nor a late mood of the cut reply');
  // a false start over the reply: the reply is read on and the reaction plays at its end
  h = await reactionWorld(); await h.say('Please check the system status.');
  h.w.display.mood('seq:1', 'proud'); h.call.onReplyText('First sentence. Second sentence.', true); await tick();
  h.call.onSpeechStart(); h.call.onMisfire(); await tick(); await h.finish(); await h.finish();
  assert.deepStrictEqual(h.spoken.filter(s => s === 'Second sentence.').length >= 1, true);
  assert.deepStrictEqual(reacts(h.p), ['proud'], 'a cough did not cost the reaction');
  // the person speaks after the reply ended and before a queued clip started: it is cancelled
  h = await reactionWorld(); await h.say('Please check the system status.');
  h.w.display.mood('seq:1', 'proud'); h.call.onReplyText('Only sentence.', true); await tick(); await h.finish();
  assert.deepStrictEqual(reacts(h.p), ['proud']); const c = h.p.count('cancelReaction');
  h.call.onSpeechStart(); assert.ok(h.p.count('cancelReaction') > c, 'the not yet started clip is cancelled');
});
