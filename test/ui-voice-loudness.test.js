'use strict';
// Loudness boost for call replies: the shared helpers (lib/ui-voice.js), the display's `output` option (lib/ui-call-display.js),
// the pref on both pages, and how the desktop and the phone route reply audio only while a call is up.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const V = require('../lib/ui-voice');
const CD = require('../lib/ui-call-display');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('app.js'), mob = read('mobile.js'), mobHtml = read('mobile.html');
const tick = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const between = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, a + ' .. ' + b); return src.slice(i, j); };

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
function memStorage(init) { const m = new Map(Object.entries(init || {})); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; }
// A fake AudioContext that records the nodes made and every connection.
function fakeCtx(over) {
  const o = over || {};
  const ctx = { state: 'running', destination: { id: 'dest' }, nodes: [], conns: [], analysis: null };
  const node = (kind, extra) => { const n = Object.assign({ kind, connect(to) { ctx.conns.push([n, to]); return to; } }, extra); ctx.nodes.push(n); return n; };
  const param = (v) => ({ value: v });
  if (!o.noGain) ctx.createGain = () => node('gain', { gain: param(1) });
  if (!o.noComp) ctx.createDynamicsCompressor = () => node('comp', { threshold: param(0), knee: param(0), ratio: param(0), attack: param(0), release: param(0) });
  if (!o.noAnalyser) ctx.createAnalyser = () => node('analyser', { fftSize: 0, getFloatTimeDomainData(buf) { const d = ctx.analysis || []; for (let i = 0; i < buf.length; i++) buf[i] = d.length ? d[i % d.length] : 0; } });
  ctx.createMediaElementSource = (el) => { const n = node('mediaSrc', { el }); ctx.sources = (ctx.sources || []).concat([el]); return n; };
  ctx.createBufferSource = () => node('bufSrc');
  return ctx;
}
const names = (ctx) => ctx.conns.map(([a, b]) => `${a.kind}>${b.kind || b.id}`);

// ── voiceLoudnessDb ──
test('voiceLoudnessDb maps the three names and defaults to louder', () => {
  assert.deepStrictEqual(V.VOICE_LOUDNESS, { normal: 0, louder: 9, loudest: 14 });
  assert.strictEqual(V.voiceLoudnessDb('normal'), 0);
  assert.strictEqual(V.voiceLoudnessDb('louder'), 9);
  assert.strictEqual(V.voiceLoudnessDb('loudest'), 14);
  for (const v of [undefined, null, '', 'LOUD', 'toString', '__proto__', 5, {}, 'constructor']) assert.strictEqual(V.voiceLoudnessDb(v), 9, String(v));
});

// ── voiceCreateLoudness ──
test('voiceCreateLoudness builds gain -> limiter -> analyser -> destination with the limiter settings', () => {
  const ctx = fakeCtx();
  const c = V.voiceCreateLoudness(ctx);
  assert.ok(c && c.input);
  assert.deepStrictEqual(names(ctx), ['gain>comp', 'comp>analyser', 'analyser>dest']);
  const comp = ctx.nodes.find((n) => n.kind === 'comp'), an = ctx.nodes.find((n) => n.kind === 'analyser');
  assert.strictEqual(c.input, ctx.nodes.find((n) => n.kind === 'gain'));
  assert.strictEqual(comp.threshold.value, -3); assert.strictEqual(comp.knee.value, 0); assert.strictEqual(comp.ratio.value, 20);
  assert.strictEqual(comp.attack.value, 0.003); assert.strictEqual(comp.release.value, 0.12);
  assert.strictEqual(an.fftSize, 2048);
});
test('voiceCreateLoudness: the gain value of each level, default louder, setLevel changes it', () => {
  const ctx = fakeCtx(); const c = V.voiceCreateLoudness(ctx);
  assert.strictEqual(c.gainDb, 9); assert.ok(Math.abs(c.input.gain.value - Math.pow(10, 9 / 20)) < 1e-9);
  c.setLevel('normal'); assert.strictEqual(c.gainDb, 0); assert.strictEqual(c.input.gain.value, 1);
  c.setLevel('loudest'); assert.strictEqual(c.gainDb, 14); assert.ok(Math.abs(c.input.gain.value - Math.pow(10, 14 / 20)) < 1e-9);
  c.setLevel('louder'); assert.ok(Math.abs(c.input.gain.value - Math.pow(10, 9 / 20)) < 1e-9);
  c.setLevel('nonsense'); assert.strictEqual(c.gainDb, 9, 'unknown -> louder');
});
test('voiceCreateLoudness: one chain per context (cached), a second context gets its own', () => {
  const ctx = fakeCtx(); const a = V.voiceCreateLoudness(ctx), b = V.voiceCreateLoudness(ctx);
  assert.strictEqual(a, b); assert.strictEqual(ctx.nodes.filter((n) => n.kind === 'gain').length, 1);
  assert.strictEqual(ctx.__voiceLoudness, a);
  const other = fakeCtx(); assert.notStrictEqual(V.voiceCreateLoudness(other), a);
});
test('voiceCreateLoudness: null without the nodes, never throws', () => {
  assert.strictEqual(V.voiceCreateLoudness(fakeCtx({ noComp: true })), null);
  assert.strictEqual(V.voiceCreateLoudness(fakeCtx({ noGain: true })), null);
  assert.strictEqual(V.voiceCreateLoudness(null), null);
  assert.strictEqual(V.voiceCreateLoudness({}), null);
  const boom = fakeCtx(); boom.createGain = () => { throw new Error('x'); };
  assert.doesNotThrow(() => V.voiceCreateLoudness(boom)); assert.strictEqual(V.voiceCreateLoudness(boom), null);
  const noAn = V.voiceCreateLoudness(fakeCtx({ noAnalyser: true })); assert.ok(noAn); assert.strictEqual(noAn.meter(), null);   // no analyser: still a chain, no meter
  const badAn = fakeCtx(); badAn.createAnalyser = () => { throw new Error('x'); };
  const c = V.voiceCreateLoudness(badAn); assert.ok(c); assert.strictEqual(c.meter(), null);
  assert.deepStrictEqual(names(badAn), ['gain>comp', 'comp>dest']);
});
test('voiceCreateLoudness.meter reads rms and peak in dBFS from the analyser, -120 when silent', () => {
  const ctx = fakeCtx(); const c = V.voiceCreateLoudness(ctx);
  ctx.analysis = [0, 0, 0, 0];
  assert.deepStrictEqual(c.meter(), { rmsDb: -120, peakDb: -120 });
  ctx.analysis = [0.5, -0.5];   // rms 0.5, peak 0.5
  let m = c.meter(); assert.ok(Math.abs(m.rmsDb - 20 * Math.log10(0.5)) < 1e-6); assert.ok(Math.abs(m.peakDb - 20 * Math.log10(0.5)) < 1e-6);
  ctx.analysis = [1, 0, 0, 0];   // peak 1 (0 dB), rms 0.5
  m = c.meter(); assert.ok(Math.abs(m.peakDb) < 1e-9); assert.ok(Math.abs(m.rmsDb - 20 * Math.log10(0.5)) < 1e-6);
  const an = ctx.nodes.find((n) => n.kind === 'analyser'); an.getFloatTimeDomainData = () => { throw new Error('x'); };
  assert.strictEqual(c.meter(), null);
});

// ── prefs ──
test('prefs: loudness is kept, defaulted and cleaned (lib)', () => {
  assert.strictEqual(V.voiceCleanPrefs(null).loudness, 'louder');
  assert.strictEqual(V.voiceCleanPrefs({}).loudness, 'louder');
  for (const v of ['normal', 'louder', 'loudest']) assert.strictEqual(V.voiceCleanPrefs({ loudness: v }).loudness, v);
  for (const v of ['loud', 9, null, 'toString']) assert.strictEqual(V.voiceCleanPrefs({ loudness: v }).loudness, 'louder', String(v));
  assert.strictEqual(V.voiceCleanPrefs({ loudness: 'normal', micLevel: 70 }).micLevel, 70);
});
test('prefs: both pages carry the same cleaner and default (the synced lib block)', () => {
  for (const [name, src] of [['app.js', app], ['mobile.js', mob]]) {
    assert.ok(/VOICE_DEFAULT_PREFS = \{[^}]*loudness: 'louder'[^}]*\}/.test(src), name + ' default');
    assert.ok(src.includes("if (typeof raw.loudness === 'string' && Object.prototype.hasOwnProperty.call(VOICE_LOUDNESS, raw.loudness)) p.loudness = raw.loudness;"), name + ' cleaner');
    const fn = between(src, 'function voiceCleanPrefs(raw) {', '// The wake phrase of an agent');
    const run = new Function('VOICE_DEFAULT_PREFS', 'VOICE_LOUDNESS', 'VOICE_END_PAUSES', 'VOICE_CONTINUE_WAITS', 'VOICE_ECHO_HOLDS', 'VOICE_WAKE_QUIET_MS', 'voiceCleanSpeed', 'voiceCleanWakePhrase',
      fn + '; return voiceCleanPrefs;')({ micLevel: 50, loudness: 'louder' }, V.VOICE_LOUDNESS, V.VOICE_END_PAUSES, V.VOICE_CONTINUE_WAITS, V.VOICE_ECHO_HOLDS, V.VOICE_WAKE_QUIET_MS, V.voiceCleanSpeed, V.voiceCleanWakePhrase);
    assert.strictEqual(run({ loudness: 'loudest' }).loudness, 'loudest', name);
    assert.strictEqual(run({ loudness: 'x' }).loudness, 'louder', name);
    assert.strictEqual(run({}).loudness, 'louder', name);
  }
});
test('prefs: the stored value round-trips through voiceSavePrefs / voiceLoadPrefs', () => {
  const st = memStorage();
  V.voiceSavePrefs(st, { loudness: 'loudest' });
  assert.strictEqual(V.voiceLoadPrefs(st).loudness, 'loudest');
  assert.strictEqual(V.voiceLoadPrefs(memStorage()).loudness, 'louder');
});

// ── the display's output option ──
function displayWith(extra, ctxMaker) {
  const dom = fakeDom();
  const orbFactory = () => ({ setState() {}, setAnalyser() {}, setMicLevel() {}, speechEvent() {}, setLevel() {}, thinkingPulse() {}, react: () => true, cancelReaction() {}, destroy() {}, ready: Promise.resolve(), pictureReady: Promise.resolve() });
  const win = { document: dom.doc, AudioContext: ctxMaker };
  const d = CD.createCallDisplay(Object.assign({ window: win, document: dom.doc, storage: memStorage({ [CD.DISPLAY_STORE_KEY]: JSON.stringify({ choice: 'orb' }) }), fetch: async () => ({ ok: true, status: 200, json: async () => ({ packs: [] }) }),
    agentDefault: () => 'none', createVoiceOrb: orbFactory, createFacePlayer: orbFactory }, extra));
  return d;
}
test('display: routeBufferSource ends in output(ctx), ctx.destination by default (and after a throwing output)', async () => {
  const sink = { id: 'sink' };
  for (const [label, extra, want] of [['output', { output: () => sink }, 'sink'], ['default', {}, 'dest'], ['throws', { output: () => { throw new Error('x'); } }, 'dest'], ['null', { output: () => null }, 'dest']]) {
    const d = displayWith(extra); d.start(); await tick(20);
    const ctx = fakeCtx(); const src = node0(ctx);
    assert.strictEqual(d.routeBufferSource(ctx, src), true, label);
    const an = src.out[0]; assert.strictEqual(an.kind, 'analyser');
    assert.deepStrictEqual(ctx.conns.filter(([a]) => a === an).map(([, b]) => b.id), [want], label);
  }
  const seen = []; const d = displayWith({ output: (c) => { seen.push(c); return { id: 'sink' }; } }); d.start(); await tick(20);
  const ctx = fakeCtx(); d.routeBufferSource(ctx, node0(ctx)); d.routeBufferSource(ctx, node0(ctx));
  assert.strictEqual(seen[0], ctx);
  // the direct fallback (no analyser) also goes to output
  const d2 = displayWith({ output: () => ({ id: 'sink' }) }); d2.start(); await tick(20);
  const noAn = fakeCtx({ noAnalyser: true }); const s = node0(noAn);
  assert.strictEqual(d2.routeBufferSource(noAn, s), false); assert.strictEqual(s.out[0].id, 'sink');
});
function node0(ctx) { const out = []; return { out, connect(to) { out.push(to); ctx.conns.push([{ kind: 'bufSrc' }, to]); return to; } }; }
test('display: routeElement ends in output(ctx) (destination by default), one source per element', async () => {
  for (const [label, extra, want] of [['output', { output: () => ({ id: 'sink' }) }, 'sink'], ['default', {}, 'dest']]) {
    let made;
    function Ctx() { const c = fakeCtx(); c.resume = () => Promise.resolve(); c.close = () => Promise.resolve(); made = c; return c; }
    const d = displayWith(Object.assign({ needsContext: true }, extra), Ctx); d.start(); await tick(20);
    const el = { id: 'audio' };
    assert.strictEqual(d.routeElement(el), true, label); assert.strictEqual(d.routeElement(el), true, label);
    assert.strictEqual(made.sources.length, 1, label);
    const an = made.nodes.filter((n) => n.kind === 'analyser')[0];
    assert.deepStrictEqual(made.conns.filter(([a]) => a === an).map(([, b]) => b.id), [want], label);
  }
});
test('display: the output option is documented in the options list', () => {
  assert.ok(/output\(ctx\)\s+optional: the AudioNode reply audio ends in/.test(read('lib/ui-call-display.js')));
});

// ── desktop page (app.js) ──
const desk = () => between(app, '    // Loudness of call replies:', '    function voiceDisplaySpeech(kind)');
test('desktop: reply audio joins the loudness chain only while a call is up; read aloud outside a call plays as before', () => {
  const src = desk();
  const mk = (callUp) => {
    const ctx = fakeCtx();
    const env = new Function('voiceCallS', 'voicePrefsNow', 'VOICE_LOUDNESS', 'voiceCreateLoudness', 'voiceDisp', 'voicePlay', 'window',
      src + '; return { voiceOutNode, voiceDisplayRoute, voiceLoudApply, voiceLoudnessNow };')({ call: callUp ? {} : null }, () => ({ loudness: 'loudest' }), V.VOICE_LOUDNESS, V.voiceCreateLoudness, { cur: null }, { ctx }, {});
    return { ctx, env };
  };
  let { ctx, env } = mk(true);
  const s = node0(ctx); env.voiceDisplayRoute(ctx, s);
  assert.strictEqual(s.out[0], ctx.__voiceLoudness.input, 'a call: into the chain input');
  assert.strictEqual(ctx.__voiceLoudness.gainDb, 14, 'the level of the pref');
  ({ ctx, env } = mk(false));
  const s2 = node0(ctx); env.voiceDisplayRoute(ctx, s2);
  assert.strictEqual(s2.out[0], ctx.destination, 'no call: straight to the speakers');
  assert.strictEqual(ctx.__voiceLoudness, undefined, 'and no chain is even built');
  // with a display, the display routes it (its output option is voiceOutNode)
  const ctx3 = fakeCtx(); const routed = [];
  const e3 = new Function('voiceCallS', 'voicePrefsNow', 'VOICE_LOUDNESS', 'voiceCreateLoudness', 'voiceDisp', 'voicePlay', 'window',
    src + '; return { voiceDisplayRoute };')({ call: {} }, () => ({}), V.VOICE_LOUDNESS, V.voiceCreateLoudness, { cur: { routeBufferSource: (c, x) => routed.push([c, x]) } }, { ctx: ctx3 }, {});
  const sx = node0(ctx3); e3.voiceDisplayRoute(ctx3, sx); assert.strictEqual(routed.length, 1); assert.strictEqual(sx.out.length, 0, 'not connected twice');
});
test('desktop: setLevel follows the pref at call start and when it changes; the page passes output to the display and exposes __voiceOut', () => {
  assert.ok(/output: \(ctx\) => voiceOutNode\(ctx\)/.test(between(app, 'function voiceDispBegin(chatId, agent)', 'function voiceDispEnd(goodbye)')));
  assert.ok(/voiceLoudApply\(\);[^\n]*\n\s+voiceCallPaintBtn\(chatId, true\);/.test(app), 'at call start');
  assert.ok(/if \(which === 'loudness'\) \{ voiceLoudApply\(\);/.test(app), 'popover change');
  assert.ok(/voicePrefsCache = prefs;\n\s+voiceLoudApply\(\);/.test(app), 'Settings change');
  assert.ok(app.includes('window.__voiceOut = () =>'));
  assert.ok(app.includes('src.connect(typeof voiceOutNode === \'function\' ? voiceOutNode(ctx) : ctx.destination)'), 'no-display branch of the hub voice playback');
  assert.ok(!/src\.connect\(ctx\.destination\)/.test(between(app, 'async function voicePlayHub(', 'async function voicePlayDevice(')), 'no direct destination in the hub voice playback');
});
test('desktop: the Voice loudness select (Normal / Louder / Loudest) is in Settings and the voice popover, and saves through the same paths', () => {
  const pop = between(app, 'function voicePopHtml(chatId) {', 'function voiceModeToggle()');
  assert.ok(pop.includes('Voice loudness') && pop.includes("voiceLoudnessSelectHtml(id('loudness'), 'data-vp=\"loudness\"')"));
  assert.ok(app.includes("h += row('Voice loudness', `${voiceLoudnessSelectHtml('st-voice-loudness', 'onchange=\"voiceSettingsSavePrefs()\"')}"));
  assert.ok(/VOICE_LOUDNESS_LABELS = \{ normal: 'Normal', louder: 'Louder', loudest: 'Loudest' \}/.test(app));
  assert.ok(/keep: 'keepAlive', loudness: 'loudness' \}/.test(app));
  assert.ok(app.includes("else if (k === 'loudness') voiceCtlSet('loudness', t.value, true);"));
  assert.ok(app.includes('loudness: loud && Object.prototype.hasOwnProperty.call(VOICE_LOUDNESS, loud.value)'), 'Settings save');
  const html = between(app, 'function voiceLoudnessSelectHtml(id, attrs) {', '// The two settings shown everywhere');
  assert.ok(html.includes('<select') && html.includes('VOICE_LOUDNESS_LABELS'));
});

// ── phone page (mobile.js) ──
const phoneSrc = () => between(mob, '// One media element, one source: the analyser is wired the first time', 'function voiceFacePackBody()');
function phoneEnv(o) {
  const x = o || {};
  const prefs = { loudness: x.loudness || 'louder' };
  const voiceCall = x.call === false ? null : { thinkCtx: x.thinkCtx || null };
  const shared = { ctx: x.sharedCtx || null, routes: x.routes || new WeakMap() };
  const state = { voiceCall, voiceDisp: { cur: x.display || null, shared }, voicePlay: { audio: x.audio || null } };
  const fn = new Function('state', 'voicePrefsNow', 'VOICE_LOUDNESS', 'voiceCreateLoudness', 'window',
    'let voiceCall = state.voiceCall; const voiceDisp = state.voiceDisp, voicePlay = state.voicePlay;\n' + phoneSrc() + '; return { voiceDisplayRoute, voiceOwnRoute, voiceLoudSync, voiceOutNode, voiceOwnCtx, voiceOwnRoutes, setCall(v) { voiceCall = v; } };');
  const env = fn(state, () => prefs, V.VOICE_LOUDNESS, V.voiceCreateLoudness, {});
  return Object.assign(env, { state, prefs });
}
test('phone: the display captures the element -> the page makes no second source; output() sends it through the chain', () => {
  const ctx = fakeCtx(); const el = { id: 'audio' };
  const routes = new WeakMap(); routes.set(el, {});   // the display holds a route for it (even if it is waiting for a context to run)
  const e = phoneEnv({ sharedCtx: ctx, routes, display: { routeElement: () => false } });
  e.voiceDisplayRoute(el);
  assert.strictEqual(ctx.sources, undefined, 'no createMediaElementSource by the page');
  const took = phoneEnv({ sharedCtx: ctx, display: { routeElement: () => true } }); took.voiceDisplayRoute({ id: 'b' });
  assert.strictEqual(ctx.sources, undefined);
  const out = took.voiceOutNode(ctx); assert.strictEqual(out, ctx.__voiceLoudness.input); assert.strictEqual(ctx.__voiceLoudness.gainDb, 9);
});
test('phone: no display route -> the page routes the element itself through the shared context, else the call context, once per element', () => {
  const shared = fakeCtx(), think = fakeCtx(); const el = { id: 'a' };
  let e = phoneEnv({ sharedCtx: shared, thinkCtx: think, display: null, loudness: 'loudest' });
  e.voiceDisplayRoute(el); e.voiceDisplayRoute(el); e.voiceDisplayRoute(el);
  assert.deepStrictEqual(shared.sources, [el], 'one source for the element on the display context');
  assert.strictEqual(think.sources, undefined);
  assert.ok(names(shared).includes('mediaSrc>gain') && shared.__voiceLoudness.gainDb === 14);
  // display option None-like: a display that does not route
  e = phoneEnv({ sharedCtx: shared, thinkCtx: think, display: { routeElement: () => false } });
  const el2 = { id: 'b' }; e.voiceDisplayRoute(el2); assert.deepStrictEqual(shared.sources, [el, el2]);
  // no display context at all: the call's thinking context
  const think2 = fakeCtx(); const e2 = phoneEnv({ sharedCtx: null, thinkCtx: think2 });
  const el3 = { id: 'c' }; e2.voiceDisplayRoute(el3); e2.voiceDisplayRoute(el3);
  assert.deepStrictEqual(think2.sources, [el3]); assert.strictEqual(e2.voiceOwnCtx.call(null), null);
  // a source that cannot be made: plain playback, no throw
  const bad = fakeCtx(); bad.createMediaElementSource = () => { throw new Error('already'); };
  assert.doesNotThrow(() => phoneEnv({ sharedCtx: bad }).voiceDisplayRoute({ id: 'd' }));
});
test('phone: never routes through a context that is not running, and nothing outside a call', () => {
  for (const state of ['suspended', 'closed', 'interrupted']) {
    const ctx = fakeCtx(); ctx.state = state;
    phoneEnv({ sharedCtx: ctx }).voiceDisplayRoute({ id: 'a' });
    assert.strictEqual(ctx.sources, undefined, state);
    const t = fakeCtx(); t.state = state; phoneEnv({ sharedCtx: null, thinkCtx: t }).voiceDisplayRoute({ id: 'a' });
    assert.strictEqual(t.sources, undefined, state + ' think');
  }
  const ctx = fakeCtx(); phoneEnv({ sharedCtx: ctx, call: false }).voiceDisplayRoute({ id: 'a' });
  assert.strictEqual(ctx.sources, undefined, 'read aloud outside a call is not routed');
  assert.strictEqual(ctx.__voiceLoudness, undefined);
  const none = phoneEnv({ sharedCtx: null, thinkCtx: null }); assert.doesNotThrow(() => none.voiceDisplayRoute({ id: 'a' }));
});
test('phone: the level follows the pref during a call and returns to 0 dB outside one', () => {
  const ctx = fakeCtx(); const e = phoneEnv({ sharedCtx: ctx, loudness: 'louder' });
  e.voiceDisplayRoute({ id: 'a' }); assert.strictEqual(ctx.__voiceLoudness.gainDb, 9);
  e.prefs.loudness = 'loudest'; e.voiceLoudSync(); assert.strictEqual(ctx.__voiceLoudness.gainDb, 14, 'a running call follows at once');
  e.prefs.loudness = 'normal'; e.voiceLoudSync(); assert.strictEqual(ctx.__voiceLoudness.gainDb, 0);
  e.prefs.loudness = 'loudest'; e.setCall(null); e.voiceLoudSync(); assert.strictEqual(ctx.__voiceLoudness.gainDb, 0, 'after the call');
});
test('phone: page wiring - output option, voiceCallApplyPrefs syncs, the hook, the select', () => {
  assert.ok(/output: \(ctx\) => voiceOutNode\(ctx\),/.test(between(mob, 'function voiceDispBegin(vc)', 'function voiceDispEnd(goodbye)')));
  assert.ok(/function voiceCallApplyPrefs\(\) \{\n\s+try \{ voiceLoudSync\(\)/.test(mob));
  assert.ok(mob.includes('window.__voiceOut = () =>'));
  assert.ok(mob.includes('if (typeof voiceDisplayRoute === \'function\') voiceDisplayRoute(a);'), 'voicePlayBlob still routes through voiceDisplayRoute');
  assert.ok(/ctx\.state !== 'running'/.test(between(mob, 'function voiceOwnRoute(el)', 'try { window.__voiceOut')));
  assert.ok(mob.includes("$('vp-loudness')?.addEventListener('change'"));
  const sel = between(mobHtml, '<select id="vp-loudness"', '</select>');
  for (const v of ['normal', 'louder', 'loudest']) assert.ok(sel.includes(`value="${v}"`), v);
  assert.ok(sel.includes('Normal') && sel.includes('Louder') && sel.includes('Loudest'));
  const html = between(mobHtml, '<div id="voice-panel"', 'id="vp-pause"');
  assert.ok(html.indexOf('id="vp-speed"') < html.indexOf('id="vp-loudness"'), 'right after the Voice speed row');
});
