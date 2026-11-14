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
    removeAttribute(k) { delete this.attrs[k]; }
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
    if (kind === 'pack' && !o.noHearing) p.setHearing = o.hearingThrows ? () => { throw new Error('boom'); } : rec('setHearing');   // the orb has none (noHearing: a character view without it)
    if (o.info) p.getInfo = () => o.info;   // a player that reports its readiness (the real one does)
    p.destroy = () => { p.destroyed = true; p.calls.push(['destroy']); };
    if (o.deferred) {   // ready and pictureReady are settled by the test (a slow pack: the picture first, the tracks and patches later)
      let rr, rj, pr; p.ready = new Promise((a, b) => { rr = a; rj = b; }); p.pictureReady = new Promise((a) => { pr = a; });
      p.resolveReady = () => rr(p); p.rejectReadyNow = (status) => rj(Object.assign(new Error('late failure'), typeof status === 'number' ? { status, packGone: true } : (status && typeof status === 'object' ? status : {}))); p.resolvePicture = (v) => pr(v);
    } else p.ready = o.rejectReady ? Promise.reject(Object.assign(new Error('bad pack'), typeof o.rejectReady === 'number' ? { status: o.rejectReady, packGone: true } : (typeof o.rejectReady === 'object' ? o.rejectReady : {}))) : Promise.resolve(p);   // rejectReady: true = a plain failure (no verdict), a number = the MANIFEST's HTTP status (tagged packGone like the player does), an object = raw error fields (e.g. { status: 404 } of an unrelated asset)
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
  const log = { talk: 0, hang: 0, changes: 0, retry: 0 };
  const win = { document: dom.doc, AudioContext: o.AudioContext, createVoiceOrb: undefined };
  if (o.winEvents) { win.added = []; win.removed = []; win.addEventListener = (t, f) => win.added.push([t, f]); win.removeEventListener = (t, f) => win.removed.push([t, f]); }
  const display = CD.createCallDisplay({
    window: win, ResizeObserver: o.ResizeObserver, document: dom.doc, storage, fetch: o.fetch || jsonFetch(PACKS), setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout,
    reopenHost: o.reopenHost, needsContext: !!o.needsContext, shared: o.shared, onRoutesLost: o.onRoutesLost, agentDefault: () => (o.agentDefault === undefined ? 'none' : o.agentDefault), adopt: o.adopt,
    onRetryMic: o.retry ? () => { log.retry++; } : undefined,
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
  assert.ok(/could not load/.test(CD.displayNote(bad)), 'the existing could-not-load message is kept');
  // machine-readable offReason: removed = not in the list or a confirmed removal; could-not-load = the list failed or a load failure without that verdict
  assert.strictEqual(miss.offReason, 'removed'); assert.strictEqual(agentMiss.offReason, 'removed');
  assert.strictEqual(failedList.offReason, 'could-not-load'); assert.strictEqual(bad.offReason, 'could-not-load');
  assert.strictEqual(CD.resolveDisplay({ choice: 'pack:owl', packs: PACKS, unusable: new Set(['owl']), removed: new Set(['owl']) }).offReason, 'removed');
  assert.strictEqual(pend.offReason, undefined); assert.strictEqual(CD.resolveDisplay({ choice: 'pack:owl', packs: PACKS }).offReason, undefined);
  assert.strictEqual(CD.displayNote(CD.resolveDisplay({ choice: 'orb' })), '');
  assert.strictEqual(CD.cleanChoice('pack:../x'), null);
  assert.strictEqual(CD.cleanChoice('pack:' + 'a'.repeat(41)), null);
});

test('the choice is saved per device under the voice-prefs style key; a missing character stays saved; garbage is ignored; no credentials are stored', () => {
  assert.strictEqual(CD.DISPLAY_STORE_KEY, 'hub-voice-display');
  const st = memStorage();
  assert.deepStrictEqual(CD.loadDisplayPrefs(st), { choice: 'follow', captions: false, interrupt: false });
  CD.saveDisplayPrefs(st, { choice: 'pack:ghost' });
  assert.deepStrictEqual(CD.loadDisplayPrefs(st), { choice: 'pack:ghost', captions: false, interrupt: false }, 'saved even though nothing installed matches');
  CD.saveDisplayPrefs(st, { captions: true });
  assert.deepStrictEqual(CD.loadDisplayPrefs(st), { choice: 'pack:ghost', captions: true, interrupt: false });
  CD.saveDisplayPrefs(st, { choice: 'bogus', captions: 'yes' });
  assert.deepStrictEqual(CD.loadDisplayPrefs(st), { choice: 'pack:ghost', captions: true, interrupt: false });
  assert.deepStrictEqual(CD.loadDisplayPrefs(memStorage({ 'hub-voice-display': '{not json' })), { choice: 'follow', captions: false, interrupt: false });
  assert.deepStrictEqual(CD.loadDisplayPrefs(memStorage({ 'hub-voice-display': '[1]' })), { choice: 'follow', captions: false, interrupt: false });
  assert.deepStrictEqual(CD.loadDisplayPrefs({ getItem() { throw new Error('blocked'); } }), { choice: 'follow', captions: false, interrupt: false });
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

test('Character: the controller state hearing tells the view the person is talking (setHearing(true)); listening and the rest say false; views without it cope', async () => {
  const w = world({ prefs: { choice: 'pack:owl' } }); w.display.start(); await flushP();
  const p = w.players[0];
  w.display.setState('listening'); assert.strictEqual(p.last('setHearing'), false);
  w.display.setState('hearing'); assert.strictEqual(p.last('setHearing'), true); assert.strictEqual(p.last('setState'), 'listening', 'the display state is still listening');
  w.display.setState('listening'); assert.strictEqual(p.last('setHearing'), false);
  w.display.setState('hearing'); w.display.setState('thinking'); assert.strictEqual(p.last('setHearing'), false); assert.strictEqual(p.last('setState'), 'thinking');
  const ord = p.calls.map(c => c[0]).filter(n => n === 'setHearing' || n === 'setState'), i = ord.lastIndexOf('setHearing'); assert.strictEqual(ord[i + 1], 'setState', 'setHearing comes before the setState it goes with');
  const w2 = world({ prefs: { choice: 'pack:owl' }, pack: { noHearing: true } }); w2.display.start(); await flushP();
  assert.doesNotThrow(() => { w2.display.setState('listening'); w2.display.setState('hearing'); });
  assert.strictEqual(w2.players[0].last('setState'), 'listening');
  const w3 = world({ prefs: { choice: 'pack:owl' }, pack: { hearingThrows: true } }); w3.display.start(); await flushP();
  assert.doesNotThrow(() => { w3.display.setState('listening'); w3.display.setState('thinking'); });
  assert.strictEqual(w3.players[0].last('setState'), 'thinking', 'a throwing view never breaks the call');
  const wo = world({ prefs: { choice: 'orb' } }); wo.display.start(); await flushP();
  assert.doesNotThrow(() => wo.display.setState('hearing'));
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

test('real ordering: reply(end) comes before setState(listening); the mood is not consumed or played while the display still speaks, then plays exactly once', async () => {
  const w = world({ prefs: { choice: 'pack:owl' } }); w.display.start(); await flushP();
  const p = w.players[0];
  w.display.setState('listening');
  const hello = p.count('react');
  w.display.reply('turn', 'seq:1'); w.display.setState('thinking');
  assert.strictEqual(w.display.mood('seq:1', 'proud'), true);
  w.display.setState('speaking'); w.display.audioStart();
  assert.strictEqual(p.last('setState'), 'speaking');
  w.display.audioEnd();   // the last sentence ended; the controller has not settled yet
  assert.strictEqual(p.count('react'), hello, 'no reaction while the audio is heard / the display speaks');
  w.display.reply('end', 'seq:1');   // the controller ends the reply BEFORE settling
  assert.strictEqual(p.count('react'), hello, 'still speaking: the mood is retained, not consumed and not sent');
  w.display.setState('listening');
  assert.strictEqual(p.count('react'), hello + 1);
  assert.strictEqual(p.last('react'), 'proud');
  w.display.setState('hearing'); w.display.setState('listening'); w.display.audioEnd();
  assert.strictEqual(p.count('react'), hello + 1, 'exactly once');
  // no reaction while reply audio is heard, even after the state left speaking
  w.display.reply('turn', 'seq:2'); assert.strictEqual(w.display.mood('seq:2', 'curious'), true);
  w.display.setState('speaking'); w.display.audioStart(); w.display.reply('end', 'seq:2'); w.display.setState('listening');
  assert.strictEqual(p.count('react'), hello + 1, 'audio still heard');
  w.display.audioEnd();
  assert.strictEqual(p.last('react'), 'curious'); assert.strictEqual(p.count('react'), hello + 2);
});

test('hang-up before the first picture: a pack that reports ready but not drawable closes at once; an older player without getInfo still says goodbye', async () => {
  const a = world({ prefs: { choice: 'pack:owl' }, pack: { info: { ready: true, failed: false, drawable: false } } }); a.display.start(); await flushP();
  await a.display.hangUp();
  assert.strictEqual(a.players[0].count('react'), 0, 'no goodbye over a blank view'); assert.strictEqual(a.dom.overlay(), null); assert.strictEqual(a.clk.timers.length, 0);
  const b = world({ prefs: { choice: 'pack:owl' }, pack: { info: { ready: true, failed: false, drawable: true } } }); b.display.start(); await flushP();
  const pb = b.display.hangUp(); assert.strictEqual(b.players[0].last('react'), 'goodbye'); await b.clk.advance(CD.GOODBYE_MS + 5); await pb;
  const c = world({ prefs: { choice: 'pack:owl' } }); c.display.start(); await flushP();
  const pc = c.display.hangUp(); assert.strictEqual(c.players[0].last('react'), 'goodbye', 'no getInfo: unchanged'); await c.clk.advance(CD.GOODBYE_MS + 5); await pc;
});

test('captions: off by default and a local pref; show the spoken sentence as text only; a mood tag or markup never becomes markup', async () => {
  const w = world({ prefs: { choice: 'orb' } }); w.display.start(); await flushP();
  const cap = () => w.dom.overlay().all().find(n => n.className === 'ucd-caption');
  w.display.caption('Hello there.'); assert.strictEqual(cap().textContent, ''); assert.strictEqual(cap().hidden, true, 'off by default');
  w.display.setCaptions(true);
  assert.deepStrictEqual(CD.loadDisplayPrefs(w.storage), { choice: 'orb', captions: true, interrupt: false }, 'saved locally');
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

test('a pack whose manifest is CONFIRMED gone (404/410) falls back to None (not the Orb), without a notice, and the choice stays saved; any other failure is not a verdict', async () => {
  for (const status of [404, 410]) {
    const w = world({ prefs: { choice: 'pack:owl' }, pack: { rejectReady: status } }); w.display.start(); await flushP();
    assert.strictEqual(w.display.info().kind, 'none'); assert.strictEqual(w.dom.overlay(), null); assert.strictEqual(w.orbs.length, 0);
    assert.strictEqual(w.display.info().offReason, 'removed', 'a confirmed removal is machine-readable');
    assert.ok(/was removed/.test(w.display.info().note), 'the note says it was removed (offReason), not "could not load"'); assert.strictEqual(CD.loadDisplayPrefs(w.storage).choice, 'pack:owl'); assert.strictEqual(w.players[0].destroyed, true);
    assert.ok(CD.displayNote(CD.resolveDisplay({ choice: 'pack:owl', packs: PACKS, unusable: new Set(['owl']) })).includes('could not load'), 'a failure without the verdict still could not load');
    assert.ok(CD.displayNote(CD.resolveDisplay({ choice: 'pack:ghost', packs: PACKS })).includes('not installed'), 'a pack the list lacks is not installed');
  }
  for (const status of [true, 500, 503, 429, { status: 404 }, { status: 410 }]) {   // a plain failure, a 5xx, a 429, or a 404/410 of an UNRELATED asset (no packGone tag): no verdict, the view is kept (not unusable, not None)
    const w = world({ prefs: { choice: 'pack:owl' }, pack: { rejectReady: status } }); w.display.start(); await flushP();
    assert.strictEqual(w.display.info().kind, 'pack', JSON.stringify(status)); assert.strictEqual(w.players[0].destroyed, false); assert.strictEqual(w.display.info().note, ''); assert.strictEqual(w.display.info().destroyed, false); assert.strictEqual(w.display.info().offReason, null, 'drawable (no info): nothing to report'); w.display.release();
  }
  const f = world({ prefs: { choice: 'pack:owl' }, fetch: jsonFetch([], 500) }); f.display.start(); await flushP();
  assert.strictEqual(f.display.info().kind, 'none'); assert.strictEqual(f.display.info().packsState, 'failed'); assert.strictEqual(f.orbs.length, 0);
});

test('a transient boot failure with nothing drawable reports could-not-load, marks nothing unusable, and Show display / choosing again retries (no pending loop)', async () => {
  const info = { ready: false, failed: 'x', drawable: false };
  const w = world({ prefs: { choice: 'pack:owl' }, pack: { info, deferred: true } }); w.display.start(); await flushP();
  const p0 = w.players[0]; const timersBefore = w.clk.timers.length;
  p0.rejectReadyNow({ status: 503 }); await flushP();
  assert.strictEqual(w.display.info().kind, 'pack', 'the view is kept, not None'); assert.strictEqual(w.display.info().offReason, 'could-not-load'); assert.strictEqual(w.display.info().resolved.offReason, undefined, 'nothing was marked unusable');
  assert.strictEqual(w.dom.overlay(), null, 'nothing drawable: no overlay'); assert.strictEqual(p0.destroyed, false);
  assert.strictEqual(w.display.activeFacePack(), null, 'a view that could not load asks for no mood tags (nothing is shown)');
  assert.ok(w.clk.timers.length <= timersBefore, 'no retry timer or pending loop was started'); await w.clk.advance(30000); assert.strictEqual(w.players.length, 1, 'nothing retries by itself');
  w.display.showView();   // the person asks again: a fresh view, the old one let go
  await flushP(); assert.strictEqual(w.players.length, 2, 'retried'); assert.strictEqual(p0.destroyed, true); assert.strictEqual(w.display.info().offReason, null, 'the reason is reset for the new view');
  const p1 = w.players[1]; info.drawable = true; info.ready = true; p1.resolvePicture(true); p1.resolveReady(); await flushP();
  assert.ok(w.dom.overlay(), 'the retry works: the picture opens'); assert.strictEqual(w.display.info().offReason, null);
  w.display.release();
  // choosing the same character again is a retry too, and recovery (a late picture) clears the reason
  const v = world({ prefs: { choice: 'pack:owl' }, pack: { info: { ready: false, failed: 'x', drawable: false }, deferred: true } }); v.display.start(); await flushP();
  v.players[0].rejectReadyNow(); await flushP(); assert.strictEqual(v.display.info().offReason, 'could-not-load');
  assert.strictEqual(v.display.setChoice('pack:owl'), true); await flushP(); assert.strictEqual(v.players.length, 2); assert.strictEqual(v.display.info().offReason, null);
  assert.strictEqual(v.display.setChoice('orb'), true); await flushP(); assert.strictEqual(v.display.info().offReason, null); v.display.release();
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

// Changed with the Interrupt slot: the slot button is off while starting/listening, so the call opens with focus on the overlay root,
// the click happens in 'speaking', and the Tab wrap goes to the first control that is in the list (Hang up once the slot is off again).
test('Interrupt and Hang up call the page; the view is a labelled modal dialog; focus goes to the overlay and returns; Tab stays inside', async () => {
  const w = world({ prefs: { choice: 'orb', interrupt: true } }); const { dom } = w;
  const opener = new dom.El('button'); dom.doc.body.appendChild(opener); opener.focus();
  w.display.start(); await flushP();
  const ov = dom.overlay();
  assert.strictEqual(ov.attrs.role, 'dialog'); assert.strictEqual(ov.attrs['aria-modal'], 'true'); assert.ok(ov.attrs['aria-label']);
  const talk = dom.find('ucd-talk')[0], hang = dom.find('ucd-hang')[0];
  assert.strictEqual(dom.doc.activeElement, ov, 'the slot is off at start: focus is on the overlay root'); assert.strictEqual(ov.attrs.tabindex, '-1');
  w.display.setState('speaking');
  talk.click(); assert.strictEqual(w.log.talk, 1); hang.click(); assert.strictEqual(w.log.hang, 1);
  for (const b of ov.all().filter(n => n.tagName === 'BUTTON')) assert.ok(b.attrs['aria-label'], 'every button has a name');
  const ctl = dom.find('ucd-ctl')[0]; assert.strictEqual(ctl.attrs['aria-expanded'], 'false'); ctl.click(); assert.strictEqual(ctl.attrs['aria-expanded'], 'true');
  ctl.click();
  const last = dom.find('ucd-ctl')[0]; last.focus();
  let prevented = false; ov.dispatch('keydown', { key: 'Tab', shiftKey: false, preventDefault() { prevented = true; } });
  assert.ok(prevented); assert.strictEqual(dom.doc.activeElement, talk, 'wraps to the first control (Interrupt is in the list while on)');
  w.display.setState('listening'); dom.find('ucd-ctl')[0].focus(); prevented = false;
  ov.dispatch('keydown', { key: 'Tab', shiftKey: false, preventDefault() { prevented = true; } });
  assert.ok(prevented); assert.strictEqual(dom.doc.activeElement, hang, 'the off slot is left out of the Tab list');
  w.display.release(); assert.strictEqual(dom.doc.activeElement, opener, 'focus returns to where it was');
  const status = ov.all().find(n => n.className === 'ucd-status'); assert.strictEqual(status.attrs['aria-live'], 'polite');
});

// ── the slot button (Interrupt / Try the microphone again / off) and the Display chooser ──
const slotOf = (dom) => dom.find('ucd-talk')[0];
const statusOf = (dom) => dom.find('ucd-status')[0].textContent;

test('slot: Interrupt shows only while the agent thinks or speaks; starting, listening, hearing and ended keep the place but are invisible and inert (Orb and character)', async () => {
  for (const choice of ['orb', 'pack:owl']) {
    const w = world({ prefs: { choice, interrupt: true } }); const { dom } = w;
    w.display.start(); await flushP();
    const slot = slotOf(dom);
    const off = (s) => { assert.strictEqual(slot.attrs['data-ucd-mode'], 'off', choice + ' ' + s); assert.strictEqual(slot.attrs['data-ucd-off'], ''); assert.strictEqual(slot.attrs['aria-hidden'], 'true'); assert.strictEqual(slot.attrs.tabindex, '-1'); assert.strictEqual(w.display.info().talk, 'off'); };
    const on = (s) => { assert.strictEqual(slot.attrs['data-ucd-mode'], 'interrupt', choice + ' ' + s); assert.strictEqual(slot.textContent, 'Interrupt'); assert.strictEqual(slot.attrs['aria-label'], 'Interrupt the reply'); assert.ok(!('data-ucd-off' in slot.attrs)); assert.ok(!('aria-hidden' in slot.attrs)); assert.ok(!('tabindex' in slot.attrs)); assert.strictEqual(w.display.info().talk, 'interrupt'); };
    off('starting');
    w.display.setState('listening'); off('listening');
    w.display.setState('hearing'); off('hearing');
    w.display.setState('thinking'); on('thinking');
    w.display.setState('speaking'); on('speaking');
    w.display.setState('listening'); off('listening again');
    w.display.setState('speaking'); on('speaking again');
    w.display.setState('ended'); off('ended');
    w.display.release();
  }
});

test('slot: the click path is unchanged while Interrupt is on (onTalk once) and the off slot does nothing', async () => {
  const w = world({ prefs: { choice: 'orb', interrupt: true } }); const { dom } = w;
  w.display.start(); await flushP();
  w.display.setState('speaking'); slotOf(dom).click(); assert.strictEqual(w.log.talk, 1);
  w.display.setState('listening'); slotOf(dom).click(); assert.strictEqual(w.log.talk, 1, 'off: a click does nothing');
  w.display.setState('thinking'); slotOf(dom).click(); assert.strictEqual(w.log.talk, 2);
  w.display.release();
});

test('slot: a lost microphone turns the slot into "Try the microphone again" (onRetryMic, never onTalk) and the status says so; back again restores Interrupt', async () => {
  const w = world({ prefs: { choice: 'orb', interrupt: true }, retry: true }); const { dom } = w;
  w.display.start(); await flushP();
  w.display.setState('speaking'); assert.strictEqual(statusOf(dom), 'Speaking');
  w.display.micLost(true);
  const slot = slotOf(dom);
  assert.strictEqual(slot.attrs['data-ucd-mode'], 'mic'); assert.strictEqual(slot.textContent, 'Try the microphone again'); assert.strictEqual(slot.attrs['aria-label'], 'Try the microphone again');
  assert.ok(!('data-ucd-off' in slot.attrs)); assert.strictEqual(statusOf(dom), 'Microphone lost');
  assert.deepStrictEqual([w.display.info().talk, w.display.info().micLost], ['mic', true]);
  slot.click(); assert.strictEqual(w.log.retry, 1); assert.strictEqual(w.log.talk, 0);
  w.display.micLost(false);
  assert.strictEqual(slot.attrs['data-ucd-mode'], 'interrupt'); assert.strictEqual(slot.textContent, 'Interrupt'); assert.strictEqual(statusOf(dom), 'Speaking');
  // listening with the microphone lost: the retry stays offered (the person cannot be heard), the status still says it
  w.display.setState('listening'); w.display.micLost(true);
  assert.strictEqual(slot.attrs['data-ucd-mode'], 'mic'); assert.strictEqual(statusOf(dom), 'Microphone lost');
  w.display.setState('ended'); assert.strictEqual(slot.attrs['data-ucd-mode'], 'off');
  w.display.release();
  // without onRetryMic the slot stays the Interrupt button
  const n = world({ prefs: { choice: 'orb', interrupt: true } }); n.display.start(); await flushP();
  n.display.setState('speaking'); n.display.micLost(true);
  assert.strictEqual(slotOf(n.dom).attrs['data-ucd-mode'], 'interrupt'); assert.strictEqual(statusOf(n.dom), 'Microphone lost');
  slotOf(n.dom).click(); assert.strictEqual(n.log.talk, 1);
  n.display.release();
});

test('slot: Hang up never moves: the slot stays in .ucd-main right before it in every state, is never removed and never gets the hidden property', async () => {
  const w = world({ prefs: { choice: 'pack:owl', interrupt: true }, retry: true }); const { dom } = w;
  w.display.start(); await flushP();
  const slot = slotOf(dom), hang = dom.find('ucd-hang')[0], main = slot.parentNode;
  assert.strictEqual(main.className, 'ucd-main');
  const check = (s) => { assert.strictEqual(slot.parentNode, main, s); assert.strictEqual(hang.parentNode, main, s); assert.strictEqual(main.children.indexOf(slot), 0, s); assert.strictEqual(main.children.indexOf(hang), 1, s); assert.strictEqual(slot.hidden, false, s); };
  for (const st of ['starting', 'listening', 'hearing', 'thinking', 'speaking', 'listening']) { w.display.setState(st); check(st); }
  w.display.micLost(true); check('mic lost'); w.display.micLost(false); check('mic back');
  w.display.setState('ended'); check('ended');
  w.display.hangUp(); check('hang-up');
});

test('slot: when the slot turns off while it has focus, focus moves to the overlay root; at start focus is on the slot only when it is on', async () => {
  const w = world({ prefs: { choice: 'orb', interrupt: true } }); const { dom } = w;
  w.display.start(); await flushP();
  const ov = dom.overlay(), slot = slotOf(dom);
  w.display.setState('speaking'); slot.focus(); assert.strictEqual(dom.doc.activeElement, slot);
  w.display.setState('listening'); assert.strictEqual(dom.doc.activeElement, ov, 'focus is not left on an invisible button');
  w.display.setState('thinking'); dom.find('ucd-back')[0].focus(); w.display.setState('listening'); assert.strictEqual(dom.doc.activeElement, dom.find('ucd-back')[0], 'other focus is left alone');
  // a view built while the call is speaking puts focus on the (on) slot
  w.display.setState('speaking'); w.display.setChoice('pack:owl'); await flushP();
  assert.strictEqual(dom.doc.activeElement, slotOf(dom));
  w.display.release();
});

// ── the Interrupt button is an option (off by default, per device) ──
test('interrupt option: by default no Interrupt in any state (mode off, data-ucd-off), and Hang up keeps its index in .ucd-main', async () => {
  for (const choice of ['orb', 'pack:owl']) {
    const w = world({ prefs: { choice }, retry: true }); const { dom } = w;
    w.display.start(); await flushP();
    const slot = slotOf(dom), hang = dom.find('ucd-hang')[0], main = slot.parentNode;
    assert.strictEqual(w.display.info().interruptButton, false);
    for (const st of ['starting', 'listening', 'hearing', 'thinking', 'speaking', 'ended']) {
      w.display.setState(st);
      assert.strictEqual(slot.attrs['data-ucd-mode'], 'off', choice + ' ' + st); assert.ok('data-ucd-off' in slot.attrs, st); assert.strictEqual(w.display.info().talk, 'off', st);
      assert.strictEqual(main.children.indexOf(hang), 1, 'Hang up stays at the same index in ' + st); assert.strictEqual(main.children.indexOf(slot), 0, st);
    }
    slot.click(); assert.strictEqual(w.log.talk, 0);
    w.display.release();
  }
});

test('interrupt option: on shows Interrupt only while thinking or speaking (onTalk once); setInterruptButton saves it and turns it on or off at once', async () => {
  const w = world({ prefs: { choice: 'orb' } }); const { dom } = w;
  w.display.start(); await flushP();
  const slot = slotOf(dom);
  w.display.setState('speaking'); assert.strictEqual(slot.attrs['data-ucd-mode'], 'off');
  w.display.setInterruptButton(true);
  assert.strictEqual(CD.loadDisplayPrefs(w.storage).interrupt, true); assert.strictEqual(w.display.info().interruptButton, true);
  assert.strictEqual(slot.attrs['data-ucd-mode'], 'interrupt'); assert.strictEqual(slot.textContent, 'Interrupt'); assert.ok(!('data-ucd-off' in slot.attrs));
  for (const st of ['starting', 'listening', 'hearing', 'ended']) { w.display.setState(st); assert.strictEqual(slot.attrs['data-ucd-mode'], 'off', st); }
  w.display.setState('thinking'); assert.strictEqual(slot.attrs['data-ucd-mode'], 'interrupt');
  w.display.setState('speaking'); slot.click(); assert.strictEqual(w.log.talk, 1);
  const before = w.log.changes;
  w.display.setInterruptButton(false);
  assert.strictEqual(slot.attrs['data-ucd-mode'], 'off', 'off at once mid-speaking'); assert.ok('data-ucd-off' in slot.attrs);
  assert.strictEqual(CD.loadDisplayPrefs(w.storage).interrupt, false); assert.strictEqual(w.display.info().interruptButton, false); assert.ok(w.log.changes > before, 'onChange fires');
  slot.click(); assert.strictEqual(w.log.talk, 1, 'off: a click does nothing');
  w.display.release();
  assert.strictEqual(CD.loadDisplayPrefs(memStorage({ 'hub-voice-display': JSON.stringify({ interrupt: 'true' }) })).interrupt, false, 'only exactly true counts');
});

test('interrupt option: with the option off a lost microphone still shows "Try the microphone again"', async () => {
  const w = world({ prefs: { choice: 'orb' }, retry: true }); const { dom } = w;
  w.display.start(); await flushP();
  w.display.setState('speaking'); w.display.micLost(true);
  const slot = slotOf(dom);
  assert.strictEqual(slot.attrs['data-ucd-mode'], 'mic'); assert.strictEqual(slot.textContent, 'Try the microphone again'); assert.ok(!('data-ucd-off' in slot.attrs));
  slot.click(); assert.strictEqual(w.log.retry, 1); assert.strictEqual(w.log.talk, 0);
  w.display.micLost(false); assert.strictEqual(slot.attrs['data-ucd-mode'], 'off');
  w.display.release();
});

// ── the Controls drawer can be closed ──
async function drawerWorld() {
  const w = world({ prefs: { choice: 'orb' }, adopt: () => [{ el: bar, label: 'Call' }, { el: pop, label: 'Voice settings', show: true }] }); const { dom } = w;
  const composer = new dom.El('div'), bar = new dom.El('div'), pop = new dom.El('div');
  composer.appendChild(bar); composer.appendChild(pop); dom.doc.body.appendChild(composer);
  w.display.start(); await flushP();
  const ui = w.display.ui, ctl = dom.find('ucd-ctl')[0];
  return { w, dom, ui, ctl, bar, pop, head: dom.find('ucd-drawer-head')[0], section: bar.parentNode };
}
const touch = (el, type, y) => el.dispatch(type, type === 'touchend' ? { changedTouches: [{ clientY: y }] } : { touches: [{ clientY: y }] });

test('drawer: opening shows a header (grab handle + Close) as the first child with the adopted sections after it; Close closes it and focus goes to Controls', async () => {
  const { w, dom, ui, ctl, head } = await drawerWorld();
  assert.strictEqual(ui.drawer.hidden, true); assert.strictEqual(ctl.attrs['aria-expanded'], 'false');
  ctl.click();
  assert.strictEqual(ui.drawer.hidden, false); assert.strictEqual(ctl.attrs['aria-expanded'], 'true');
  assert.strictEqual(ui.drawer.children[0], head); assert.strictEqual(head.className, 'ucd-drawer-head');
  const grab = head.children.find(c => c.className === 'ucd-grab'); assert.ok(grab); assert.strictEqual(grab.attrs['aria-hidden'], 'true');
  const close = dom.find('ucd-drawer-close')[0]; assert.strictEqual(close.textContent, 'Close'); assert.strictEqual(close.attrs['aria-label'], 'Close the controls'); assert.ok(head.contains(close));
  assert.ok(ui.drawer.children.length >= 3 && ui.drawer.children.slice(1).every(c => /ucd-section/.test(c.className)), 'sections follow the header');
  dom.doc.activeElement = close; close.click();
  assert.strictEqual(ui.drawer.hidden, true); assert.strictEqual(ctl.attrs['aria-expanded'], 'false'); assert.strictEqual(dom.doc.activeElement, ctl);
  const other = dom.find('ucd-back')[0]; other.focus();
  ctl.click(); assert.strictEqual(dom.doc.activeElement, other, 'opening does not move focus');
  assert.strictEqual(ui.drawer.children[0], head, 'the header is still first');
  w.display.release();
  assert.strictEqual(dom.overlay(), null);
});

test('drawer: a touch swipe down of 50 px on the header closes it; 20 px does not; touches inside the list never close it; a pointer (mouse) drag works and a touch pointer is ignored', async () => {
  const { w, dom, ui, ctl, head, section } = await drawerWorld();
  ctl.click();
  touch(head, 'touchstart', 100); touch(head, 'touchmove', 120); touch(head, 'touchend', 120);
  assert.strictEqual(ui.drawer.hidden, false, '20 px is not a swipe');
  touch(head, 'touchstart', 100); touch(head, 'touchmove', 130); touch(head, 'touchmove', 150); touch(head, 'touchend', 150);
  assert.strictEqual(ui.drawer.hidden, true, 'a 50 px swipe closes'); assert.strictEqual(ctl.attrs['aria-expanded'], 'false'); assert.strictEqual(dom.doc.activeElement, ctl);
  ctl.click(); assert.strictEqual(ui.drawer.hidden, false);
  touch(head, 'touchstart', 100); touch(head, 'touchmove', 40); touch(head, 'touchend', 40);
  assert.strictEqual(ui.drawer.hidden, false, 'an upward swipe does not close');
  touch(section, 'touchstart', 100); touch(section, 'touchmove', 200); touch(section, 'touchend', 200);
  section.dispatch('pointerdown', { clientY: 100, pointerType: 'mouse' }); section.dispatch('pointerup', { clientY: 200, pointerType: 'mouse' });
  assert.strictEqual(ui.drawer.hidden, false, 'touches inside the list scroll and never close it');
  head.dispatch('pointerdown', { clientY: 100, pointerType: 'touch' }); head.dispatch('pointerup', { clientY: 200, pointerType: 'touch' });
  assert.strictEqual(ui.drawer.hidden, false, 'a touch pointer does not count twice');
  head.dispatch('pointerdown', { clientY: 100, pointerType: 'mouse' }); head.dispatch('pointerup', { clientY: 120, pointerType: 'mouse' });
  assert.strictEqual(ui.drawer.hidden, false, 'a short mouse drag does not close');
  head.dispatch('pointerdown', { clientY: 100, pointerType: 'mouse' }); head.dispatch('pointerup', { clientY: 150, pointerType: 'mouse' });
  assert.strictEqual(ui.drawer.hidden, true, 'a mouse drag of 50 px closes');
  // a press on Close is never captured by the header (a captured pointer would take the click away from the button); a right button starts no drag
  ctl.click(); assert.strictEqual(ui.drawer.hidden, false);
  const close = dom.find('ucd-drawer-close')[0]; const captured = [];
  head.setPointerCapture = (id) => captured.push(id); head.releasePointerCapture = () => {};
  head.dispatch('pointerdown', { target: close, clientY: 100, pointerType: 'mouse', button: 0, pointerId: 3 });   // bubbled from the button
  assert.deepStrictEqual(captured, [], 'no capture for a press on Close');
  head.dispatch('pointerdown', { clientY: 100, pointerType: 'mouse', button: 2, pointerId: 4 });
  assert.deepStrictEqual(captured, [], 'no capture for a right button');
  head.dispatch('pointerdown', { clientY: 100, pointerType: 'mouse', button: 0, pointerId: 5 });
  assert.deepStrictEqual(captured, [5], 'a press on the header itself is captured');
  head.dispatch('pointerup', { clientY: 100, pointerType: 'mouse', pointerId: 5 });
  close.click(); assert.strictEqual(ui.drawer.hidden, true, 'Close closes'); assert.strictEqual(dom.doc.activeElement, ctl);
  w.display.release();
});

test('drawer: a tap on the stage closes it when open and does nothing when closed; Escape closes the drawer only, a second Escape hides the view to chat; Controls aria-expanded follows every path', async () => {
  const { w, dom, ui, ctl } = await drawerWorld();
  const stage = dom.find('ucd-stage')[0];
  stage.click(); assert.strictEqual(ui.drawer.hidden, true); assert.strictEqual(ctl.attrs['aria-expanded'], 'false');
  assert.strictEqual(w.display.info().visible, true, 'a stage tap with the drawer closed does nothing');
  ctl.click(); assert.strictEqual(ctl.attrs['aria-expanded'], 'true');
  stage.click(); assert.strictEqual(ui.drawer.hidden, true); assert.strictEqual(ctl.attrs['aria-expanded'], 'false'); assert.strictEqual(dom.doc.activeElement, ctl);
  ctl.click(); assert.strictEqual(ctl.attrs['aria-expanded'], 'true');
  ctl.click(); assert.strictEqual(ui.drawer.hidden, true, 'the Controls button toggles it closed'); assert.strictEqual(ctl.attrs['aria-expanded'], 'false'); assert.strictEqual(dom.doc.activeElement, ctl);
  ctl.click();
  dom.overlay().dispatch('keydown', { key: 'Escape' });
  assert.strictEqual(ui.drawer.hidden, true); assert.strictEqual(ctl.attrs['aria-expanded'], 'false'); assert.strictEqual(dom.doc.activeElement, ctl);
  assert.ok(dom.overlay(), 'the view is still visible'); assert.strictEqual(w.display.info().visible, true);
  dom.overlay().dispatch('keydown', { key: 'Escape' });
  assert.strictEqual(dom.overlay(), null, 'a second Escape hides the view to chat as before'); assert.strictEqual(w.display.info().visible, false);
  w.display.release();
});

test('drawer: hang up hides the open drawer without moving focus; the open Controls button has an accent style; Hang up stays in the bar', async () => {
  const { w, dom, ui, ctl } = await drawerWorld();
  ctl.click(); const hang = dom.find('ucd-hang')[0]; dom.doc.activeElement = hang;
  const idx = hang.parentNode.children.indexOf(hang);
  w.display.hangUp();
  assert.strictEqual(ui.drawer.hidden, true); assert.strictEqual(dom.doc.activeElement, hang, 'focus is not moved');
  assert.strictEqual(hang.parentNode.children.indexOf(hang), idx);
  const css = read('lib/ui-call-display.css');
  assert.ok(/\.ucd-bar \.ucd-ctl\[aria-expanded="true"\]\s*\{[^}]*background: var\(--accent/.test(css));
  assert.ok(/\.ucd-drawer-head\s*\{[^}]*position: sticky[^}]*top: 0/.test(css));
});

test('chooser: a Display select sits first in the view side bar and lists Follow agent default / None / Orb / installed characters', async () => {
  const w = world({ prefs: { choice: 'orb' } }); const { dom } = w;
  w.display.start(); await flushP();
  const ui = w.display.ui;
  assert.ok(ui.disp && ui.disp.tagName === 'SELECT' && ui.disp.className === 'ucd-display'); assert.strictEqual(ui.disp.attrs['aria-label'], 'Display');
  const label = ui.disp.parentNode; assert.strictEqual(label.tagName, 'LABEL'); assert.strictEqual(label.children[0].textContent, 'Display');
  const side = dom.find('ucd-side')[0]; assert.strictEqual(side.children[0], label, 'first in the side bar, before Back to chat');
  assert.ok(label.parentNode === side && side.children[1] === dom.find('ucd-back')[0]);
  assert.deepStrictEqual(ui.disp.children.map(o => o.value), ['follow', 'none', 'orb', 'pack:owl', 'pack:plain'], 'an Orb call lists the installed characters too');
  assert.strictEqual(ui.disp.value, 'orb');
  assert.strictEqual(ui.disp.children[3].textContent, 'Owl <b>x</b>', 'names are text');
  w.display.release();
});

test('chooser: changing it applies the choice (None leaves the page and is saved); other changes repaint it; it is not refilled while it has focus', async () => {
  const w = world({ prefs: { choice: 'orb' } }); const { dom } = w;
  w.display.start(); await flushP();
  const sel = w.display.ui.disp;
  w.display.setChoice('pack:plain'); await flushP();
  assert.strictEqual(w.display.ui.disp.value, 'pack:plain', 'repainted from elsewhere');
  w.display.setChoice('orb'); await flushP(); assert.strictEqual(sel.value, 'orb');
  // focused: left alone
  sel.focus(); const kids = sel.children.slice(); w.display.setChoice('none'); await flushP();
  assert.ok(sel.children.every((c, i) => c === kids[i]), 'not refilled while it is the active element'); assert.strictEqual(w.display.info().choice, 'none');
  w.display.setChoice('orb'); await flushP(); dom.find('ucd-back')[0] && dom.doc.body.focus();
  // a change by the person
  const s2 = w.display.ui.disp; s2.focus(); dom.doc.activeElement = null; s2.value = 'none'; s2.dispatch('change', {});
  assert.strictEqual(dom.overlay(), null, 'None: the overlay leaves the page'); assert.strictEqual(JSON.parse(w.storage.getItem(CD.DISPLAY_STORE_KEY)).choice, 'none');
  w.display.release();
});

test('chooser: it is disabled by hang-up and is in the Tab list; an Orb call fetches the installed characters once', async () => {
  let fetches = 0; const base = jsonFetch(PACKS);
  const w = world({ prefs: { choice: 'orb' }, fetch: async (...a) => { fetches++; return base(...a); } }); const { dom } = w;
  w.display.start(); await flushP();
  assert.strictEqual(fetches, 1); assert.strictEqual(w.display.info().packsState, 'ready');
  const ov = dom.overlay(), sel = w.display.ui.disp;
  w.display.setState('listening'); dom.find('ucd-hang')[0].focus();
  ov.dispatch('keydown', { key: 'Tab', shiftKey: false, preventDefault() {} }); assert.notStrictEqual(dom.doc.activeElement, sel, 'Tab does not wrap here: the browser moves on');
  sel.focus(); ov.dispatch('keydown', { key: 'Tab', shiftKey: true, preventDefault() {} }); assert.strictEqual(dom.doc.activeElement, sel, 'the select is in the list: not first, so Shift+Tab is left to the browser');
  w.display.hangUp(); assert.ok(sel.disabled);
});

// A /api/faces the test answers by hand (each call is parked until settle()).
function parkedFaces(packs) {
  const parked = [];
  const f = () => new Promise((res) => { parked.push(() => res({ ok: true, status: 200, json: async () => ({ packs }) })); });
  return { f, parked, settle: (i) => parked[i || 0]() };
}

test('chooser: an Orb call whose installed list arrives while the Display select has focus does not refill it then; blur fills it with the characters', async () => {
  const pf = parkedFaces(PACKS);
  const w = world({ prefs: { choice: 'orb' }, fetch: pf.f }); const { dom } = w;
  w.display.start(); await flushP();
  const sel = w.display.ui.disp;
  assert.deepStrictEqual(sel.children.map(o => o.value), ['follow', 'none', 'orb'], 'no characters yet');
  sel.focus(); const kids = sel.children.slice();
  pf.settle(); await flushP();
  assert.strictEqual(w.display.info().packsState, 'ready');
  assert.ok(sel.children.length === kids.length && sel.children.every((c, i) => c === kids[i]), 'not refilled while it has focus');
  assert.ok((sel.listeners.blur || []).length >= 1, 'the select has a blur listener');
  dom.doc.activeElement = null;   // the browser has moved focus on when blur fires
  sel.dispatch('blur', {});
  assert.deepStrictEqual(sel.children.map(o => o.value), ['follow', 'none', 'orb', 'pack:owl', 'pack:plain'], 'the installed characters are listed (owl included)');
  assert.strictEqual(sel.value, 'orb');
  w.display.release();
});

test('chooser: a blur with an unchanged list and choice leaves the options alone (refilled only when the key changed)', async () => {
  const w = world({ prefs: { choice: 'orb' } });
  w.display.start(); await flushP();
  const sel = w.display.ui.disp, kids = sel.children.slice();
  sel.focus(); w.dom.doc.activeElement = null; sel.dispatch('blur', {});
  assert.ok(sel.children.length === kids.length && sel.children.every((c, i) => c === kids[i]), 'same nodes');
  w.display.release();
});

test('chooser: an Orb call makes ONE /api/faces request, also when the choice is changed to Orb while the first request is still on its way', async () => {
  const a = parkedFaces(PACKS);
  const w = world({ prefs: { choice: 'orb' }, fetch: a.f });
  w.display.start(); await flushP();
  assert.strictEqual(a.parked.length, 1, 'one request for the Orb call');
  w.display.setChoice('orb'); await flushP();
  assert.strictEqual(a.parked.length, 1, 'rebuilding the Orb view does not ask again');
  a.settle(); await flushP(); assert.strictEqual(w.display.info().packsState, 'ready'); assert.strictEqual(a.parked.length, 1);
  w.display.release();
  // the overlay is first built after the call began with a pack choice (the list is already on its way): switching to Orb must not replace that request
  const b = parkedFaces(PACKS);
  const v = world({ prefs: { choice: 'pack:owl' }, fetch: b.f });
  v.display.start(); await flushP();
  assert.strictEqual(b.parked.length, 1, 'one request at start');
  v.display.setChoice('orb'); await flushP();
  assert.strictEqual(v.dom.overlay() !== null, true, 'the Orb overlay is up');
  assert.strictEqual(b.parked.length, 1, 'the request already on its way is not replaced');
  b.settle(); await flushP(); assert.strictEqual(v.display.info().packsState, 'ready');
  assert.deepStrictEqual(v.display.ui.disp.children.map(o => o.value), ['follow', 'none', 'orb', 'pack:owl', 'pack:plain']);
  v.display.release();
});

test('chooser: a change made on the focused Display select keeps focus on it after the view is rebuilt', async () => {
  const w = world({ prefs: { choice: 'orb' } }); const { dom } = w;
  w.display.start(); await flushP();
  const sel = w.display.ui.disp;
  assert.notStrictEqual(dom.doc.activeElement, sel, 'focus starts on the view, not on the select');
  sel.focus(); sel.value = 'pack:owl'; sel.dispatch('change', {}); await flushP();
  assert.strictEqual(w.display.info().choice, 'pack:owl');
  assert.strictEqual(dom.doc.activeElement, w.display.ui.disp, 'the select still has focus'); assert.strictEqual(w.display.ui.disp, sel);
  dom.doc.activeElement = null; w.display.setChoice('orb'); await flushP();   // focus elsewhere: the view takes it as before
  assert.notStrictEqual(dom.doc.activeElement, sel, 'without focus on the select the view takes it');
  w.display.release();
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
  assert.deepStrictEqual(reacts(p), [], 'the display still speaks (the controller has not settled): retained');
  w.display.setState('listening');
  assert.deepStrictEqual(reacts(p), ['proud'], 'played as soon as the display left speaking');
  w.display.reply('end', 'seq:1'); w.display.audioEnd();
  assert.deepStrictEqual(reacts(p), ['proud'], 'once only');
  // device voice
  w.display.reply('turn', 'seq:2'); w.display.mood('seq:2', 'curious'); w.display.speech('start'); w.display.reply('end', 'seq:2');
  assert.deepStrictEqual(reacts(p), ['proud'], 'device speech still heard');
  w.display.speech('end');
  w.display.setState('listening');
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
  const o = order(h.p); assert.ok(o.lastIndexOf('react:proud') > o.lastIndexOf('setState:speaking'), 'only after the display left speaking: ' + o.join(' '));
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

// ── never a blank stage: the character is put on screen only once the player has a real picture ──
test('a character with no drawable picture yet is not put on screen (the call stays usable); it appears when the picture is there', async () => {
  const info = { ready: true, failed: null, drawable: false };
  const w = world({ prefs: { choice: 'pack:owl' }, pack: { info } }); w.display.start(); await flushP();
  assert.strictEqual(w.dom.overlay(), null, 'no blank paper over the call'); assert.strictEqual(w.display.info().destroyed, false);
  info.drawable = true; await w.clk.advance(150); assert.ok(w.dom.overlay(), 'the picture is there: the display opens'); w.display.release();
});
test('a character that gets its picture late: no verdict, never unusable or None; after 8 s the check goes on every second, a picture at 12 s opens it, teardown stops it', async () => {
  const info = { ready: true, failed: null, drawable: false };
  const w = world({ prefs: { choice: 'pack:owl' }, pack: { info } }); w.display.start(); await flushP();
  await w.clk.advance(8500); assert.strictEqual(w.dom.overlay(), null); assert.strictEqual(w.display.info().kind, 'pack', 'still the character, never marked unusable'); assert.strictEqual(w.players[0].destroyed, false);
  assert.strictEqual(w.display.info().note, ''); assert.strictEqual(JSON.parse(w.storage.getItem(CD.DISPLAY_STORE_KEY)).choice, 'pack:owl', 'the saved choice is kept');
  assert.strictEqual(w.clk.timers.length, 1, 'one slow check stays');
  const next = w.clk.timers[0].at - w.clk.t; assert.ok(next > 100 && next <= 1000, 'every second now, not every 100 ms (' + next + ')');
  await w.clk.advance(3000); assert.strictEqual(w.dom.overlay(), null); assert.strictEqual(w.clk.timers.length, 1, 'still one timer, no pile-up');
  info.drawable = true; await w.clk.advance(1000); assert.ok(w.dom.overlay(), 'a picture that arrives at 12 s still opens the display');
  assert.strictEqual(w.clk.timers.length, 0, 'drawn: the check ended');
  w.display.release();
  const h = world({ prefs: { choice: 'pack:owl' }, pack: { info: { ready: true, failed: null, drawable: false } } }); h.display.start(); await flushP();
  await h.clk.advance(9000); assert.strictEqual(h.clk.timers.length, 1); h.display.hideToChat(); assert.strictEqual(h.clk.timers.length, 0, 'teardown (back to chat) stops the slow check'); h.display.release();
});
test('stale: a display released, hidden or switched while the picture is awaited never opens late', async () => {
  const info = { ready: true, failed: null, drawable: false };
  const w = world({ prefs: { choice: 'pack:owl' }, pack: { info } }); w.display.start(); await flushP();
  w.display.release(); info.drawable = true; await w.clk.advance(500); assert.strictEqual(w.dom.overlay(), null, 'released: nothing opens');
  const v = world({ prefs: { choice: 'pack:owl' }, pack: { info: { ready: true, failed: null, drawable: false } } }); v.display.start(); await flushP();
  v.display.hideToChat(); v.players[0].getInfo = () => ({ ready: true, drawable: true }); await v.clk.advance(500); assert.strictEqual(v.dom.overlay(), null, 'hidden while waiting: it does not appear'); v.display.release();
});

// ── pictureReady: the overlay appears with the real picture, not when the slow tracks and patches have also arrived ──
test('pictureReady: the character opens as soon as its picture is painted, while ready (tracks, patches) is still pending; a later failure falls back to None cleanly', async () => {
  const info = { ready: false, failed: null, drawable: true };
  const w = world({ prefs: { choice: 'pack:owl' }, pack: { info, deferred: true } }); w.display.start(); await flushP(); const p = w.players[0];
  assert.strictEqual(w.dom.overlay(), null, 'nothing before the picture');
  p.resolvePicture(true); await flushP(); assert.ok(w.dom.overlay(), 'the overlay is up before ready'); assert.strictEqual(w.display.info().kind, 'pack');
  p.rejectReadyNow(); await flushP();
  assert.ok(w.dom.overlay(), 'a later failed load without a verdict (no 404/410) keeps the picture up'); assert.strictEqual(w.display.info().kind, 'pack'); assert.strictEqual(p.destroyed, false); w.display.release();
  const g = world({ prefs: { choice: 'pack:owl' }, pack: { info, deferred: true } }); g.display.start(); await flushP(); const pg = g.players[0];
  pg.resolvePicture(true); await flushP(); pg.rejectReadyNow(404); await flushP();
  assert.strictEqual(g.dom.overlay(), null, 'the later 404 verdict ends in None'); assert.strictEqual(g.display.info().kind, 'none'); assert.strictEqual(pg.destroyed, true);
  assert.strictEqual(JSON.parse(g.storage.getItem(CD.DISPLAY_STORE_KEY)).choice, 'pack:owl', 'the choice stays saved'); g.display.release();
  const v = world({ prefs: { choice: 'pack:owl' }, pack: { info: { ready: true, failed: null, drawable: true }, deferred: true } }); v.display.start(); await flushP(); const q = v.players[0];
  q.resolvePicture(true); await flushP(); q.resolveReady(); await flushP(); await v.clk.advance(300); assert.ok(v.dom.overlay(), 'ready after the picture changes nothing, no double mount'); assert.strictEqual(v.dom.find('ucd-overlay').length, 1); v.display.release();
});
test('pictureReady: false does not open it (ready decides, bounded); a picture that is not drawable, a stale view and a destroyed display never open late', async () => {
  const a = world({ prefs: { choice: 'pack:owl' }, pack: { info: { ready: true, failed: null, drawable: false }, deferred: true } }); a.display.start(); await flushP();
  a.players[0].resolvePicture(false); await flushP(); assert.strictEqual(a.dom.overlay(), null);
  a.players[0].resolveReady(); await flushP(); await a.clk.advance(8500); assert.strictEqual(a.dom.overlay(), null); assert.strictEqual(a.display.info().kind, 'pack', 'no picture yet: no overlay, but no verdict either'); assert.strictEqual(a.clk.timers.length, 1, 'past 8 s: one slow (1 s) check keeps looking'); a.display.release(); assert.strictEqual(a.clk.timers.length, 0, 'released: the check is gone');
  const b = world({ prefs: { choice: 'pack:owl' }, pack: { info: { ready: false, failed: null, drawable: true }, deferred: true } }); b.display.start(); await flushP();
  b.display.release(); b.players[0].resolvePicture(true); await flushP(); assert.strictEqual(b.dom.overlay(), null, 'released before the picture: nothing opens');
  const c = world({ prefs: { choice: 'pack:owl' }, pack: { info: { ready: false, failed: null, drawable: true }, deferred: true } }); c.display.start(); await flushP();
  c.display.hideToChat(); c.players[0].resolvePicture(true); await flushP(); assert.strictEqual(c.dom.overlay(), null, 'hidden while waiting: it does not appear'); c.display.release();
  const d = world({ prefs: { choice: 'pack:owl' }, pack: { info: { ready: false, failed: null, drawable: true }, deferred: true } }); d.display.start(); await flushP();
  d.display.setChoice('none'); await flushP(); d.players[0].resolvePicture(true); d.players[0].rejectReadyNow(); await flushP();
  assert.strictEqual(d.players[0].destroyed, true, 'the old view was torn down'); assert.strictEqual(d.dom.overlay(), null, 'a stale picture of a switched-away view never opens'); assert.strictEqual(d.display.info().kind, 'none'); d.display.release();
});

// ── first frame: the overlay enters the page "arming" (transparent, click-through), the player is sized at once, it is revealed two frames later ──
function withRaf(w) {
  const r = { q: [], id: 0, cancelled: [] };
  w.win.requestAnimationFrame = (f) => { const id = ++r.id; r.q.push({ id, f }); return id; };
  w.win.cancelAnimationFrame = (id) => { r.cancelled.push(id); r.q = r.q.filter(x => x.id !== id); };
  r.frame = () => { const due = r.q; r.q = []; due.forEach(x => x.f(0)); };
  w.dom.El.prototype.removeAttribute = function (k) { delete this.attrs[k]; };
  return r;
}
test('first frame: the character overlay is in the page but transparent until two frames after its picture, with the player sized at mount', async () => {
  const adoptEl = (w) => { const home = new w.dom.El('div'); w.dom.doc.body.appendChild(home); const node = new w.dom.El('div'); home.appendChild(node); return [{ el: node, label: 'Levels' }]; };
  let w; const opts = { prefs: { choice: 'pack:owl' }, pack: { info: { ready: false, failed: null, drawable: true }, deferred: true }, adopt: () => adoptEl(w) };
  w = world(opts); const raf = withRaf(w); w.display.start(); await flushP(); const p = w.players[0];
  const sized = []; p.resize = () => { const o = w.dom.overlay(); sized.push(!!(o && o.parentNode === w.dom.doc.body && o.attrs['data-ucd-arming'] === '')); };
  p.resolvePicture(true); await flushP();
  const o = w.dom.overlay();
  assert.ok(o && o.parentNode === w.dom.doc.body, 'in the page at once (laid out, its layers composited)');
  assert.strictEqual(o.attrs['data-ucd-arming'], '', 'but arming: transparent and click-through');
  assert.deepStrictEqual(sized, [true], 'the player was sized once, in the page, before any frame (no ResizeObserver wait)');
  assert.strictEqual(w.display.ui.drawer.children.length, 1, 'controls are not moved in while arming (only the drawer header is there)');
  raf.frame(); assert.strictEqual(o.attrs['data-ucd-arming'], '', 'still arming after one frame');
  raf.frame(); assert.strictEqual(o.attrs['data-ucd-arming'], undefined, 'revealed on the second frame');
  assert.strictEqual(w.display.ui.drawer.children.length, 2, 'the controls move in at the reveal (after the header)');
  assert.strictEqual(raf.q.length, 0); w.display.release();
  // torn down while arming (back to chat): the frames are cancelled and no mark is left on the reused overlay
  const h = world({ prefs: { choice: 'pack:owl' }, pack: { info: { ready: false, failed: null, drawable: true }, deferred: true } }); const hr = withRaf(h); h.display.start(); await flushP();
  h.players[0].resolvePicture(true); await flushP(); const ho = h.dom.overlay(); assert.strictEqual(ho.attrs['data-ucd-arming'], '');
  h.display.hideToChat(); assert.ok(hr.cancelled.length >= 1, 'the pending frame was cancelled'); assert.strictEqual(ho.attrs['data-ucd-arming'], undefined); assert.strictEqual(hr.q.length, 0);
  h.display.showView(); await flushP(); h.players[1].resolvePicture(true); await flushP(); hr.frame(); hr.frame();
  assert.strictEqual(h.dom.overlay().attrs['data-ucd-arming'], undefined, 'shown again: revealed normally'); h.display.release();
  // the orb (no picture to wait for) and a window without frames keep opening at once
  const b = world({ prefs: { choice: 'orb' } }); withRaf(b); b.display.start(); await flushP(); assert.strictEqual(b.dom.overlay().attrs['data-ucd-arming'], undefined, 'the orb opens at once'); b.display.release();
  const n = world({ prefs: { choice: 'pack:owl' }, pack: { info: { ready: false, failed: null, drawable: true }, deferred: true } }); n.display.start(); await flushP();
  n.players[0].resolvePicture(true); await flushP(); assert.strictEqual(n.dom.overlay().attrs['data-ucd-arming'], undefined, 'no requestAnimationFrame: revealed at once'); n.display.release();
  // frames stop (a hidden tab, an occluded window): revealed after the bound anyway, and the frames that come later change nothing
  const s = world({ prefs: { choice: 'pack:owl' }, pack: { info: { ready: false, failed: null, drawable: true }, deferred: true } }); const sr = withRaf(s); s.display.start(); await flushP();
  s.players[0].resolvePicture(true); await flushP(); assert.strictEqual(s.dom.overlay().attrs['data-ucd-arming'], '');
  await s.clk.advance(200); assert.strictEqual(s.dom.overlay().attrs['data-ucd-arming'], '', 'still within the bound');
  await s.clk.advance(60); assert.strictEqual(s.dom.overlay().attrs['data-ucd-arming'], undefined, 'revealed by the bound without any frame');
  assert.ok(sr.cancelled.length >= 1, 'the waiting frame was cancelled'); const changes = s.log.changes; sr.frame(); sr.frame(); assert.strictEqual(s.log.changes, changes, 'a late frame does not reveal twice'); s.display.release();
  // the frame after the second one wins over the bound: the timer is cancelled
  const f = world({ prefs: { choice: 'pack:owl' }, pack: { info: { ready: false, failed: null, drawable: true }, deferred: true } }); const fr = withRaf(f); f.display.start(); await flushP();
  f.players[0].resolvePicture(true); await flushP(); fr.frame(); fr.frame(); assert.strictEqual(f.dom.overlay().attrs['data-ucd-arming'], undefined);
  const ch2 = f.log.changes; await f.clk.advance(400); assert.strictEqual(f.log.changes, ch2, 'the bound did not fire after the reveal'); f.display.release();
  // a requestAnimationFrame that throws: revealed at once, nothing left transparent
  const t = world({ prefs: { choice: 'pack:owl' }, pack: { info: { ready: false, failed: null, drawable: true }, deferred: true } }); withRaf(t); t.win.requestAnimationFrame = () => { throw new Error('no frames'); }; t.display.start(); await flushP();
  t.players[0].resolvePicture(true); await flushP(); assert.strictEqual(t.dom.overlay().attrs['data-ucd-arming'], undefined, 'a failing requestAnimationFrame reveals at once'); t.display.release();
  assert.ok(/\.ucd-overlay\[data-ucd-arming\]\s*\{[^}]*opacity:\s*0[^}]*pointer-events:\s*none/.test(read('lib/ui-call-display.css')), 'the CSS makes arming transparent and click-through');
});

// ── hello on a slow start: kept until its clip has arrived (bounded), played out, and still cancelled by a real person ──
test('hello: a player whose hello clip has not arrived keeps hello past HELLO_MS, up to the bound; it then plays out; plain players keep the old timer', async () => {
  const mk = (extra) => { const info = Object.assign({ ready: true, failed: null, drawable: true, helloWaiting: true, helloPlaying: false }, extra); const w = world({ prefs: { choice: 'pack:owl' }, pack: { info } }); return { w, info }; };
  let { w, info } = mk(); w.display.start(); await flushP(); const p = w.players[0];
  w.display.setState('listening'); assert.strictEqual(p.last('react'), 'hello'); assert.strictEqual(p.last('setState'), 'idle');
  await w.clk.advance(CD.HELLO_MS + 500); assert.strictEqual(p.last('setState'), 'idle', 'still waiting for the clip: hello is NOT swallowed at HELLO_MS');
  info.helloWaiting = true; info.helloPlaying = true;   // the clip arrived and plays
  await w.clk.advance(1500); assert.strictEqual(p.last('setState'), 'idle', 'playing out');
  info.helloWaiting = false; info.helloPlaying = false; await w.clk.advance(150); assert.strictEqual(p.last('setState'), 'listening', 'hello is over');
  ({ w, info } = mk()); w.display.start(); await flushP(); w.display.setState('listening');   // never arrives: bounded
  await w.clk.advance(CD.HELLO_WAIT_MS - 300); assert.strictEqual(w.players[0].last('setState'), 'idle');
  await w.clk.advance(600); assert.strictEqual(w.players[0].last('setState'), 'listening', 'given up after the bound');
  ({ w, info } = mk()); w.display.start(); await flushP(); w.display.setState('listening'); await w.clk.advance(CD.HELLO_MS + 500);
  w.display.setState('hearing'); assert.strictEqual(w.players[0].last('setState'), 'listening', 'a real person speaking cancels the waiting hello at once');
  const n = w.clk.timers.length; await w.clk.advance(CD.HELLO_WAIT_MS); assert.strictEqual(w.players[0].last('setState'), 'listening'); assert.ok(w.clk.timers.length <= n);
  const q = world({ prefs: { choice: 'pack:owl' }, pack: { info: { ready: true, failed: null, drawable: true } } }); q.display.start(); await flushP(); q.display.setState('listening');
  await q.clk.advance(CD.HELLO_MS + 10); assert.strictEqual(q.players[0].last('setState'), 'listening', 'a player that does not report hello keeps the plain timer');
});

// ── caption reserve: the character's host stops above the caption band (the band never covers the feet) ──
const stageOf = (w) => w.display.ui ? w.display.ui.stage : null;
const capOf = (w) => w.display.ui ? w.display.ui.caption : null;
const RES = '--ucd-caption-reserve';
const packCaps = (extra) => world(Object.assign({ prefs: { choice: 'pack:owl', captions: true }, pack: { info: { ready: true, failed: null, drawable: true } } }, extra || {}));
test('caption reserve: a measured band height + 12px offset + 8px gap is reserved under a character, follows multi-line growth, and clears with the caption', async () => {
  let fire = null, made = 0, disc = 0, observed = [];
  const RO = function (cb) { made++; fire = cb; this.observe = (n) => observed.push(n); this.disconnect = () => { disc++; }; };
  const w = packCaps({ ResizeObserver: RO }); w.display.start(); await flushP();
  assert.strictEqual(w.display.info().kind, 'pack'); assert.strictEqual(stageOf(w).props[RES], undefined, 'nothing reserved before there is text');
  const cap = capOf(w); cap.offsetHeight = 100; w.display.caption('One line.');
  assert.strictEqual(stageOf(w).props[RES], '120px', '100 + 12 + 8');
  cap.offsetHeight = 180; w.display.caption('A much longer sentence that wraps over several lines on a narrow stage.'); assert.strictEqual(stageOf(w).props[RES], '200px', 'multi-line');
  cap.offsetHeight = 140; fire(); assert.strictEqual(stageOf(w).props[RES], '160px', 'a resize that re-wraps the text re-measures through the observer');
  w.display.clearCaption(); assert.strictEqual(stageOf(w).props[RES], '0px', 'cleared');
  w.display.caption('Again.'); cap.offsetHeight = 60; w.display.caption('Again.'); assert.strictEqual(stageOf(w).props[RES], '80px');
  w.display.setCaptions(false); assert.strictEqual(stageOf(w).props[RES], '0px', 'captions off (toggle)');
  w.display.setCaptions(true); w.display.caption('Back.'); assert.strictEqual(stageOf(w).props[RES], '80px', 'captions on again');
  w.display.hideToChat(); assert.strictEqual(stageOf(w).props[RES], '0px', 'hiding the view clears it');
  w.display.showView(); await flushP(); assert.strictEqual(stageOf(w).props[RES], '0px', 'a rebuilt view starts without a reserve');
  w.display.caption('Rebuilt.'); assert.strictEqual(stageOf(w).props[RES], '80px');
  w.display.setChoice('pack:plain'); await flushP(); assert.strictEqual(stageOf(w).props[RES], '80px', 'another character: the caption band is still there, so is its reserve');
  w.display.setChoice('orb'); await flushP(); assert.strictEqual(stageOf(w).props[RES], '0px', 'the Orb never reserves');
  w.display.setChoice('pack:owl'); await flushP(); assert.strictEqual(stageOf(w).props[RES], '80px', 'back to a character with the band showing');
  assert.strictEqual(made, 1, 'one observer for the whole call'); assert.deepStrictEqual(observed.map(n => n.className), ['ucd-caption', 'ucd-stage']);
  w.display.release(); assert.strictEqual(disc, 1, 'the observer is disconnected on destroy'); assert.doesNotThrow(() => fire());
});
test('caption reserve: no measurement (no layout) falls back to an estimate from the stage size and the text, never more than 40 percent of the stage', async () => {
  const w = packCaps(); w.display.start(); await flushP();   // fake elements have no offsetHeight / clientWidth: stage 640x360, font 26.88px
  w.display.caption('x'.repeat(40)); assert.strictEqual(stageOf(w).props[RES], '108px', '2 lines: ceil(2 * 26.88 * 1.25 + 20) = 88, + 20');
  w.display.caption('x'.repeat(400)); assert.strictEqual(stageOf(w).props[RES], '164px', 'capped at 40% of 360 = 144, + 20');
  const s = stageOf(w); s.clientWidth = 1000; s.clientHeight = 600; w.display.caption('x'.repeat(10)); assert.strictEqual(stageOf(w).props[RES], '90px', 'one line at 1000px: font min(40, 42) = 40: ceil(40 * 1.25 + 20) = 70, + 20');
  w.display.release();
});
test('caption reserve: the Orb and None never reserve anything; without ResizeObserver a window resize listener is used and removed', async () => {
  const o = world({ prefs: { choice: 'orb', captions: true }, winEvents: true }); o.display.start(); await flushP(); capOf(o).offsetHeight = 90;
  o.display.caption('Orb text.'); assert.strictEqual(stageOf(o).props[RES], undefined, 'the orb layout is untouched');
  assert.strictEqual(o.win.added.filter(a => a[0] === 'resize').length, 1); o.display.release(); assert.deepStrictEqual(o.win.removed.map(a => a[0]), ['resize']); assert.strictEqual(o.win.removed[0][1], o.win.added[0][1]);
  const p = packCaps({ winEvents: true }); p.display.start(); await flushP(); const cap = capOf(p); cap.offsetHeight = 50; p.display.caption('Hi.');
  assert.strictEqual(stageOf(p).props[RES], '70px'); cap.offsetHeight = 90; p.win.added.find(a => a[0] === 'resize')[1](); assert.strictEqual(stageOf(p).props[RES], '110px', 'the resize listener re-measures');
  p.display.release(); assert.strictEqual(p.win.removed.length, 1);
  const n = world({ prefs: { choice: 'none', captions: true } }); n.display.start(); await flushP(); assert.strictEqual(n.dom.overlay(), null);
  assert.match(read('lib/ui-call-display.css'), /\.ucd-host \{[^}]*inset: 0 0 var\(--ucd-caption-reserve, 0px\) 0/, 'the host leaves the reserve at its bottom');
});

// ── follow-ups: the long caption scrolls to its newest line; the stage takes the player's background ──
test('long caption: the band keeps its newest line in view after every caption and every resize (not clipped), and the CSS lets it scroll inside the stage', async () => {
  let fire = null; const RO = function (cb) { fire = cb; this.observe = () => {}; this.disconnect = () => {}; };
  const w = packCaps({ ResizeObserver: RO }); w.display.start(); await flushP();
  const cap = capOf(w); cap.offsetHeight = 300; cap.scrollHeight = 520; cap.scrollTop = 0;
  w.display.caption('The first part of a very long reply. '.repeat(12)); assert.strictEqual(cap.scrollTop, 520, 'the end of the text is scrolled into view');
  cap.scrollHeight = 700; cap.scrollTop = 40; w.display.caption('The first part of a very long reply. '.repeat(12) + 'And the newest sentence.'); assert.strictEqual(cap.scrollTop, 700, 'a longer caption: newest line again');
  cap.scrollHeight = 900; cap.scrollTop = 10; fire(); assert.strictEqual(cap.scrollTop, 900, 'a resize that rewraps keeps the newest line in view');
  w.display.clearCaption(); cap.scrollTop = 5; fire(); assert.strictEqual(cap.scrollTop, 5, 'nothing to scroll without a caption'); w.display.release();
  const css = read('lib/ui-call-display.css'), band = /\.ucd-caption \{([^}]*)\}/.exec(css)[1];
  assert.match(band, /overflow-y: auto/); assert.doesNotMatch(band, /overflow: hidden/, 'the old clipping is gone'); assert.match(band, /max-height: 40%/); assert.match(band, /box-sizing: border-box/, 'the 40% cap includes the padding');
  assert.match(band, /bottom: 12px/, 'the band sits in the stage above the call bar'); assert.match(css, /\.ucd-stage \{[^}]*overflow: hidden/, 'inside the stage, which ends above the bar (flex column: stage, drawer, bar)');
  assert.match(css, /\.ucd-caption::-webkit-scrollbar \{ display: none; \}/);
});
test('edge glow: the character player may run its glow past its host (the stage clips it, so the glow also fills the caption reserve below the host); the host never clips', async () => {
  const w = world({ prefs: { choice: 'pack:owl' }, pack: { info: { ready: true, failed: null, drawable: true } } }); w.display.start(); await flushP();
  assert.strictEqual(w.players[0].options.glowBeyond, true); w.display.release();
  const css = read('lib/ui-call-display.css'); assert.match(css, /\.ucd-host \{[^}]*overflow: visible/, 'the host lets the glow through'); assert.match(css, /\.ucd-stage \{[^}]*overflow: hidden/, 'the stage is what clips it');
});
test('stage background: the colour the player reports (its poster ring) replaces the pack list colour on the stage; invalid, stale and destroyed reports are ignored', async () => {
  const w = world({ prefs: { choice: 'pack:owl' }, pack: { info: { ready: true, failed: null, drawable: true } } }); w.display.start(); await flushP();
  const st = stageOf(w), p = w.players[0]; assert.strictEqual(typeof p.options.onBackground, 'function'); assert.strictEqual(st.props['--ucd-bg'], '#ffd6ab', 'the list colour until the player reports');
  p.options.onBackground('rgb(200,180,160)'); assert.strictEqual(st.props['--ucd-bg'], 'rgb(200,180,160)');
  p.options.onBackground('url(javascript:x)'); assert.strictEqual(st.props['--ucd-bg'], '', 'an invalid colour is dropped, never written');
  p.options.onBackground('rgb(1,2,3)'); w.display.setChoice('pack:plain'); await flushP(); const q = w.players[1];
  assert.strictEqual(st.props['--ucd-bg'], '#222', 'the new view starts with its own list colour'); p.options.onBackground('rgb(9,9,9)'); assert.strictEqual(st.props['--ucd-bg'], '#222', 'a report from the replaced view is stale');
  q.options.onBackground('rgb(7,7,7)'); assert.strictEqual(st.props['--ucd-bg'], 'rgb(7,7,7)');
  w.display.release(); assert.doesNotThrow(() => q.options.onBackground('rgb(5,5,5)')); assert.strictEqual(st.props['--ucd-bg'], 'rgb(7,7,7)', 'nothing after release');
});

// ── a pack removed while a call is up ──
test('files removed mid-call (the player reports it lost): the display closes to the ordinary call bar, the choice is kept, a stale or late report does nothing', async () => {
  const w = world({ prefs: { choice: 'pack:owl' }, pack: { info: { ready: true, failed: null, drawable: true } } }); w.display.start(); await flushP();
  assert.ok(w.dom.overlay(), 'the character is up'); const p = w.players[0]; assert.strictEqual(typeof p.options.onLost, 'function', 'the display asks the player to report a lost pack');
  p.options.onLost('the character files are no longer available'); await flushP();
  assert.strictEqual(w.dom.overlay(), null, 'no frozen picture over the call'); assert.strictEqual(w.display.info().kind, 'none'); assert.strictEqual(p.destroyed, true);
  assert.strictEqual(JSON.parse(w.storage.getItem(CD.DISPLAY_STORE_KEY)).choice, 'pack:owl', 'the choice stays saved');
  assert.doesNotThrow(() => p.options.onLost('again'), 'a second report of the destroyed view is ignored'); assert.strictEqual(w.display.info().destroyed, false, 'the call itself continues');
  w.display.release();
  const e = world({ prefs: { choice: 'pack:owl' }, pack: { info: { ready: true, failed: null, drawable: true } } }); e.display.start(); await flushP(); const q = e.players[0];
  e.display.setChoice('orb'); await flushP(); q.options.onLost('late'); assert.strictEqual(e.display.info().kind, 'orb', 'a report from a view that was switched away does not touch the new one'); e.display.release();
});
test('the next call after the pack was removed resolves None (missing, saved choice kept), never an Orb and never a player', async () => {
  const w = world({ prefs: { choice: 'pack:owl' }, fetch: jsonFetch([PACKS[1]]) }); w.display.start(); await flushP();
  assert.strictEqual(w.display.info().kind, 'none'); assert.strictEqual(w.dom.overlay(), null); assert.strictEqual(w.players.length, 0); assert.strictEqual(w.orbs.length, 0);
  assert.strictEqual(JSON.parse(w.storage.getItem(CD.DISPLAY_STORE_KEY)).choice, 'pack:owl'); w.display.release();
});
test('caption observer: when observe() throws after the observer exists, it is disconnected before the resize-listener fallback', async () => {
  let made = 0, disc = 0;
  const RO = function () { made++; this.observe = () => { throw new Error('observe failed'); }; this.disconnect = () => { disc++; }; };
  const w = world({ prefs: { choice: 'pack:owl', captions: true }, pack: { info: { ready: true, failed: null, drawable: true } }, ResizeObserver: RO, winEvents: true });
  w.display.start(); await flushP();
  assert.ok(w.dom.overlay()); assert.strictEqual(made, 1); assert.strictEqual(disc, 1, 'the partly registered observer is released'); assert.strictEqual(w.win.added.filter(a => a[0] === 'resize').length, 1, 'the fallback listener is used');
  w.display.release(); assert.strictEqual(disc, 1, 'not disconnected twice'); assert.strictEqual(w.win.removed.length, 1);
});

test('connLost(true): the status reads "Connection lost" (over a lost microphone too); false restores the call state', async () => {
  const w = world({ prefs: { choice: 'orb' } }); const { dom } = w;
  w.display.start(); await flushP();
  w.display.setState('listening'); assert.strictEqual(statusOf(dom), 'Listening');
  w.display.connLost(true); assert.strictEqual(statusOf(dom), 'Connection lost'); assert.strictEqual(w.display.info().connLost, true);
  w.display.setState('speaking'); assert.strictEqual(statusOf(dom), 'Connection lost', 'a state change keeps it');
  w.display.micLost(true); assert.strictEqual(statusOf(dom), 'Connection lost');
  w.display.connLost(false); assert.strictEqual(statusOf(dom), 'Microphone lost'); assert.strictEqual(w.display.info().connLost, false);
  w.display.micLost(false); assert.strictEqual(statusOf(dom), 'Speaking');
  w.display.release();
});
