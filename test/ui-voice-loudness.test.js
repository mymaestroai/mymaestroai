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
  if (o.shaper) ctx.createWaveShaper = () => node('shaper', { curve: null, oversample: '' });
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
// changed: the limit is now compressor (-3 dB, 20:1) -> makeup trim -> fixed ceiling curve, so no peak passes -1 dBFS
test('voiceCreateLoudness builds gain -> compressor -> trim -> ceiling -> analyser -> destination with the limiter settings', () => {
  const ctx = fakeCtx({ shaper: true });
  const c = V.voiceCreateLoudness(ctx);
  assert.ok(c && c.input);
  assert.deepStrictEqual(names(ctx), ['gain>comp', 'comp>gain', 'gain>shaper', 'shaper>analyser', 'analyser>dest']);
  const gains = ctx.nodes.filter((n) => n.kind === 'gain');
  const comp = ctx.nodes.find((n) => n.kind === 'comp'), an = ctx.nodes.find((n) => n.kind === 'analyser'), sh = ctx.nodes.find((n) => n.kind === 'shaper');
  assert.strictEqual(c.input, gains[0]);
  assert.strictEqual(comp.threshold.value, -3); assert.strictEqual(comp.knee.value, 0); assert.strictEqual(comp.ratio.value, 20);   // changed: -6 held speech near -18.5 dBFS (browser measurement), -3 uses the headroom; the curve holds the ceiling
  assert.strictEqual(comp.attack.value, 0.001); assert.strictEqual(comp.release.value, 0.1);
  assert.ok(Math.abs(gains[1].gain.value - Math.pow(10, -1.71 / 20)) < 1e-9, 'the trim takes the compressor makeup back off');
  const t = -V.VOICE_LIMIT_THRESHOLD_DB; assert.ok(Math.abs(V.VOICE_LIMIT_TRIM_DB + (t - t / 20) * 0.6) < 0.005, 'trim = minus the Blink makeup gain (t - t/ratio) * 0.6 at the set threshold');
  assert.ok(sh.curve instanceof Float32Array && sh.curve.length === 4097); assert.strictEqual(sh.oversample, 'none');
  assert.strictEqual(an.fftSize, 2048);
});
test('voiceCreateLoudness without WaveShaper still limits: gain -> compressor -> trim -> analyser', () => {
  const ctx = fakeCtx();
  assert.ok(V.voiceCreateLoudness(ctx));
  assert.deepStrictEqual(names(ctx), ['gain>comp', 'comp>gain', 'gain>analyser', 'analyser>dest']);
});
test('voiceCeilingCurve: straight below 0.7, never at or past -1 dBFS, odd, monotonic', () => {
  const c = V.voiceCeilingCurve(4097), n = c.length;
  assert.ok(Math.abs(V.VOICE_CEILING - Math.pow(10, -1 / 20)) < 1e-12);
  let max = 0;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    max = Math.max(max, Math.abs(c[i]));
    if (Math.abs(x) <= 0.7) assert.ok(Math.abs(c[i] - x) < 1e-6, 'unchanged at ' + x);
    if (i) assert.ok(c[i] >= c[i - 1], 'monotonic at ' + i);
    assert.ok(Math.abs(c[i] + c[n - 1 - i]) < 1e-6, 'odd at ' + i);
  }
  assert.ok(max < V.VOICE_CEILING, 'the end of the curve (held for every input past full scale) stays under -1 dBFS: ' + max);
  assert.ok(20 * Math.log10(max) < -1);
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
  assert.strictEqual(a, b); assert.strictEqual(ctx.nodes.filter((n) => n.kind === 'gain').length, 2);   // changed: input gain + makeup trim, made once
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
  assert.deepStrictEqual(names(badAn), ['gain>comp', 'comp>gain', 'gain>dest']);   // changed: the trim sits after the compressor
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
    assert.ok(/VOICE_DEFAULT_PREFS = \{[^}]*loudness: 'louder', loudnessBt: 'normal'[^}]*\}/.test(src), name + ' default');   // changed: both defaults
    assert.ok(src.includes("if (typeof raw.loudness === 'string' && Object.prototype.hasOwnProperty.call(VOICE_LOUDNESS, raw.loudness)) p.loudness = raw.loudness;"), name + ' cleaner');
    const fn = between(src, 'function voiceCleanPrefs(raw) {', '// The wake phrase of an agent');
    const run = new Function('VOICE_DEFAULT_PREFS', 'VOICE_LOUDNESS', 'VOICE_END_PAUSES', 'VOICE_CONTINUE_WAITS', 'VOICE_ECHO_HOLDS', 'VOICE_WAKE_QUIET_MS', 'voiceCleanSpeed', 'voiceCleanWakePhrase',
      fn + '; return voiceCleanPrefs;')({ micLevel: 50, loudness: 'louder', loudnessBt: 'normal' }, V.VOICE_LOUDNESS, V.VOICE_END_PAUSES, V.VOICE_CONTINUE_WAITS, V.VOICE_ECHO_HOLDS, V.VOICE_WAKE_QUIET_MS, V.voiceCleanSpeed, V.voiceCleanWakePhrase);
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
    const env = new Function('voiceCallS', 'voicePrefsNow', 'VOICE_LOUDNESS', 'voiceCreateLoudness', 'voiceOutputKind', 'voiceLoudnessFor', 'voiceDisp', 'voicePlay', 'window',
      src + '; return { voiceOutNode, voiceDisplayRoute, voiceLoudApply, voiceLoudnessNow };')({ call: callUp ? {} : null }, () => ({ loudness: 'loudest' }), V.VOICE_LOUDNESS, V.voiceCreateLoudness, V.voiceOutputKind, V.voiceLoudnessFor, { cur: null }, { ctx }, {});   // changed: injects the two output helpers
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
  const e3 = new Function('voiceCallS', 'voicePrefsNow', 'VOICE_LOUDNESS', 'voiceCreateLoudness', 'voiceOutputKind', 'voiceLoudnessFor', 'voiceDisp', 'voicePlay', 'window',
    src + '; return { voiceDisplayRoute };')({ call: {} }, () => ({}), V.VOICE_LOUDNESS, V.voiceCreateLoudness, V.voiceOutputKind, V.voiceLoudnessFor, { cur: { routeBufferSource: (c, x) => routed.push([c, x]) } }, { ctx: ctx3 }, {});
  const sx = node0(ctx3); e3.voiceDisplayRoute(ctx3, sx); assert.strictEqual(routed.length, 1); assert.strictEqual(sx.out.length, 0, 'not connected twice');
});
test('desktop: setLevel follows the pref at call start and when it changes; the page passes output to the display and exposes __voiceOut', () => {
  assert.ok(/output: \(ctx\) => voiceOutNode\(ctx\)/.test(between(app, 'function voiceDispBegin(chatId, agent)', 'function voiceDispEnd(goodbye)')));
  assert.ok(/voiceLoudApply\(\);[^\n]*\n\s+voiceCallPaintBtn\(chatId, true\);/.test(app), 'at call start');
  assert.ok(/if \(which === 'loudness' \|\| which === 'loudnessBt'\) \{ voiceLoudApply\(\);/.test(app), 'popover change (changed: both selects)');
  assert.ok(/voicePrefsCache = prefs;\n\s+voiceLoudApply\(\);/.test(app), 'Settings change');
  assert.ok(app.includes('window.__voiceOut = () =>'));
  assert.ok(app.includes('src.connect(typeof voiceOutNode === \'function\' ? voiceOutNode(ctx) : ctx.destination)'), 'no-display branch of the hub voice playback');
  assert.ok(!/src\.connect\(ctx\.destination\)/.test(between(app, 'async function voicePlayHub(', 'async function voicePlayDevice(')), 'no direct destination in the hub voice playback');
});
test('desktop: the two Voice loudness selects (speaker, Bluetooth / car; Normal / Louder / Loudest) are in Settings and the voice popover, and save through the same paths', () => {
  const pop = between(app, 'function voicePopHtml(chatId) {', 'function voiceModeToggle()');
  assert.ok(pop.includes('Voice loudness, speaker') && pop.includes("voiceLoudnessSelectHtml(id('loudness'), 'data-vp=\"loudness\"', 'loudness')"));   // changed: was the single select
  assert.ok(pop.includes('Voice loudness, Bluetooth / car') && pop.includes("voiceLoudnessSelectHtml(id('loudnessBt'), 'data-vp=\"loudnessBt\"', 'loudnessBt')"));
  assert.ok(app.includes("h += row('Voice loudness, speaker', `${voiceLoudnessSelectHtml('st-voice-loudness', 'onchange=\"voiceSettingsSavePrefs()\"', 'loudness')}"));
  assert.ok(app.includes("h += row('Voice loudness, Bluetooth / car', `${voiceLoudnessSelectHtml('st-voice-loudness-bt', 'onchange=\"voiceSettingsSavePrefs()\"', 'loudnessBt')}"));
  assert.ok(/VOICE_LOUDNESS_LABELS = \{ normal: 'Normal', louder: 'Louder', loudest: 'Loudest' \}/.test(app));
  assert.ok(/keep: 'keepAlive', loudness: 'loudness', loudnessBt: 'loudnessBt' \}/.test(app));
  assert.ok(app.includes("else if (k === 'loudness' || k === 'loudnessBt') voiceCtlSet(k, t.value, true);"));
  assert.ok(app.includes('loudness: loud && Object.prototype.hasOwnProperty.call(VOICE_LOUDNESS, loud.value)'), 'Settings save');
  assert.ok(app.includes('loudnessBt: loudBt && Object.prototype.hasOwnProperty.call(VOICE_LOUDNESS, loudBt.value)'), 'Settings save, Bluetooth');
  const html = between(app, 'function voiceLoudnessSelectHtml(id, attrs, key) {', '// The two settings shown everywhere');
  assert.ok(html.includes('<select') && html.includes('VOICE_LOUDNESS_LABELS'));
});

// ── phone page (mobile.js) ──
const phoneSrc = () => between(mob, '// One media element, one source: the analyser is wired the first time', 'function voiceFacePackBody()');
function phoneEnv(o) {
  const x = o || {};
  const prefs = { loudness: x.loudness || 'louder', loudnessBt: x.loudnessBt || 'normal' };
  const voiceCall = x.call === false ? null : { thinkCtx: x.thinkCtx || null, micInfo: x.micLabel === undefined ? null : { label: x.micLabel } };
  const shared = { ctx: x.sharedCtx || null, routes: x.routes || new WeakMap() };
  const state = { voiceCall, voiceDisp: { cur: x.display || null, shared }, voicePlay: { audio: x.audio || null } };
  const fn = new Function('state', 'voicePrefsNow', 'VOICE_LOUDNESS', 'voiceCreateLoudness', 'voiceOutputKind', 'voiceLoudnessFor', 'window',
    'let voiceCall = state.voiceCall; const voiceDisp = state.voiceDisp, voicePlay = state.voicePlay;\n' + phoneSrc() + '; return { voiceDisplayRoute, voiceOwnRoute, voiceLoudSync, voiceOutNode, voiceOwnCtx, voiceOwnRoutes, voiceOutputNow, voiceLoudnessNow, voiceOutputOnDeviceChange, setCall(v) { voiceCall = v; }, getCall: () => voiceCall };');   // changed: the two output helpers, and the new page functions returned
  const env = fn(state, () => prefs, V.VOICE_LOUDNESS, V.voiceCreateLoudness, V.voiceOutputKind, V.voiceLoudnessFor, {});
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
  assert.ok(mob.includes("$('vp-loudness-bt')?.addEventListener('change'"));   // changed: the second select
  for (const id of ['vp-loudness', 'vp-loudness-bt']) {
    const sel = between(mobHtml, `<select id="${id}"`, '</select>');
    for (const v of ['normal', 'louder', 'loudest']) assert.ok(sel.includes(`value="${v}"`), id + ' ' + v);
    assert.ok(sel.includes('Normal') && sel.includes('Louder') && sel.includes('Loudest'));
  }
  assert.ok(mobHtml.includes('<span>Voice loudness, speaker</span>') && mobHtml.includes('<span>Voice loudness, Bluetooth / car</span>'));
  const html = between(mobHtml, '<div id="voice-panel"', 'id="vp-pause"');
  assert.ok(html.indexOf('id="vp-speed"') < html.indexOf('id="vp-loudness"'), 'right after the Voice speed row');
});

// ── per output: speaker and Bluetooth / car ──
test('voiceOutputKind: Bluetooth / hands-free / car labels are bluetooth, everything else (Android names, wired, empty) is speaker', () => {
  for (const l of ['Bluetooth headset', 'Bluetooth', 'AirPods Pro', 'Hands-Free AG Audio', 'Handsfree', 'Hands Free', 'HFP Headset', 'Car Audio', 'My car', 'Default - Bluetooth Speaker (Sony)']) assert.strictEqual(V.voiceOutputKind(l), 'bluetooth', l);
  for (const l of ['Speakerphone', 'Headset earpiece', 'Wired headset', 'USB audio', 'Fake Default Audio Input', 'Default - MacBook Pro Microphone', 'Realtek Audio', 'Cardioid microphone', 'Scarcity', '', null, undefined, 5]) assert.strictEqual(V.voiceOutputKind(l), 'speaker', String(l));
});
test('voiceLoudnessFor: the speaker pref or the Bluetooth pref, defaults louder / normal', () => {
  const p = { loudness: 'loudest', loudnessBt: 'louder' };
  assert.strictEqual(V.voiceLoudnessFor(p, 'speaker'), 'loudest');
  assert.strictEqual(V.voiceLoudnessFor(p, 'bluetooth'), 'louder');
  assert.strictEqual(V.voiceLoudnessFor({}, 'speaker'), 'louder');
  assert.strictEqual(V.voiceLoudnessFor({}, 'bluetooth'), 'normal');
  for (const bad of [null, undefined, 5, { loudness: 'x', loudnessBt: 'toString' }]) { assert.strictEqual(V.voiceLoudnessFor(bad, 'speaker'), 'louder'); assert.strictEqual(V.voiceLoudnessFor(bad, 'bluetooth'), 'normal'); }
  assert.strictEqual(V.voiceLoudnessFor(p), 'loudest', 'no kind: the speaker');
});
test('prefs: loudnessBt defaults to normal, is kept and cleaned (lib, both pages, round trip)', () => {
  assert.strictEqual(V.voiceCleanPrefs(null).loudnessBt, 'normal');
  assert.strictEqual(V.voiceCleanPrefs({}).loudnessBt, 'normal');
  for (const v of ['normal', 'louder', 'loudest']) assert.strictEqual(V.voiceCleanPrefs({ loudnessBt: v }).loudnessBt, v);
  for (const v of ['loud', 9, null, 'toString', '__proto__']) assert.strictEqual(V.voiceCleanPrefs({ loudnessBt: v }).loudnessBt, 'normal', String(v));
  assert.deepStrictEqual([V.voiceCleanPrefs({}).loudness, V.voiceCleanPrefs({}).loudnessBt], ['louder', 'normal']);
  assert.strictEqual(V.voiceCleanPrefs({ loudness: 'loudest', loudnessBt: 'louder' }).loudness, 'loudest', 'independent');
  for (const [name, src] of [['app.js', app], ['mobile.js', mob]]) {
    const fn = between(src, 'function voiceCleanPrefs(raw) {', '// The wake phrase of an agent');
    const run = new Function('VOICE_DEFAULT_PREFS', 'VOICE_LOUDNESS', 'VOICE_END_PAUSES', 'VOICE_CONTINUE_WAITS', 'VOICE_ECHO_HOLDS', 'VOICE_WAKE_QUIET_MS', 'voiceCleanSpeed', 'voiceCleanWakePhrase',
      fn + '; return voiceCleanPrefs;')({ loudness: 'louder', loudnessBt: 'normal' }, V.VOICE_LOUDNESS, V.VOICE_END_PAUSES, V.VOICE_CONTINUE_WAITS, V.VOICE_ECHO_HOLDS, V.VOICE_WAKE_QUIET_MS, V.voiceCleanSpeed, V.voiceCleanWakePhrase);
    assert.strictEqual(run({ loudnessBt: 'loudest' }).loudnessBt, 'loudest', name);
    assert.strictEqual(run({ loudnessBt: 'x' }).loudnessBt, 'normal', name);
    assert.strictEqual(run({}).loudnessBt, 'normal', name);
  }
  const st = memStorage(); V.voiceSavePrefs(st, { loudnessBt: 'louder' });
  assert.strictEqual(V.voiceLoadPrefs(st).loudnessBt, 'louder'); assert.strictEqual(V.voiceLoadPrefs(memStorage()).loudnessBt, 'normal');
});
test('lib: voiceOutputKind and voiceLoudnessFor are exported and both pages carry the same block', () => {
  assert.strictEqual(typeof V.voiceOutputKind, 'function'); assert.strictEqual(typeof V.voiceLoudnessFor, 'function');
  const norm = (s) => s.split('\n').map((l) => l.trim()).join('\n');
  const blk = norm(between(read('lib/ui-voice.js'), 'function voiceOutputKind(label) {', '// One chain per AudioContext'));
  assert.ok(norm(app).includes(blk), 'app.js'); assert.ok(norm(mob).includes(blk), 'mobile.js');
});

test('desktop: a mid-call switch - ui.mic with a Bluetooth label drops the chain to 0 dB, a Speakerphone label brings back +9 dB', () => {
  const ctx = fakeCtx();
  const S = { call: {}, micLabel: '', micLine: '', vad: null };
  const prefs = { loudness: 'louder', loudnessBt: 'normal' };
  const micFn = between(app, '          mic: (info) => { const t = voiceMicLineText(info);', '   // which microphone is open').trim().replace(/,\s*$/, '');
  const env = new Function('voiceCallS', 'voicePrefsNow', 'VOICE_LOUDNESS', 'voiceCreateLoudness', 'voiceOutputKind', 'voiceLoudnessFor', 'voiceDisp', 'voicePlay', 'window', 'voiceMicLineText', 'barEl',
    desk() + '; return { voiceOutNode, voiceLoudApply, voiceLoudnessNow, voiceOutputNow, voiceOutputOnDeviceChange, ui: { ' + micFn + ' } };')(
    S, () => prefs, V.VOICE_LOUDNESS, V.voiceCreateLoudness, V.voiceOutputKind, V.voiceLoudnessFor, { cur: null }, { ctx }, {}, (i) => (i && i.label) || '', () => null);
  env.voiceOutNode(ctx);
  const chain = ctx.__voiceLoudness;
  assert.strictEqual(chain.gainDb, 9, 'unknown mic: the speaker level');
  env.ui.mic({ label: 'Bluetooth headset' });
  assert.strictEqual(chain.gainDb, 0, 'Bluetooth: its own level, at once');
  assert.deepStrictEqual({ ...env.voiceOutputNow() }, { output: 'bluetooth', label: 'Bluetooth headset' });
  env.ui.mic({ label: 'Speakerphone' });
  assert.strictEqual(chain.gainDb, 9, 'back on the speaker');
  prefs.loudnessBt = 'loudest'; env.ui.mic({ label: 'Bluetooth headset' }); assert.strictEqual(chain.gainDb, 14, 'the Bluetooth pref is its own');
  env.ui.mic(null); assert.strictEqual(chain.gainDb, 9, 'no info: speaker');
  assert.strictEqual(env.voiceLoudnessNow(), 'louder');
});
test('desktop: devicechange during a call re-reads the open mic and re-applies; one listener; nothing outside a call', () => {
  const ctx = fakeCtx(); const added = [];
  const S = { call: {}, micLabel: 'Speakerphone', vad: { info: () => ({ label: 'Bluetooth headset' }) } };
  const nav = { mediaDevices: { addEventListener: (t, f) => added.push([t, f]) } };
  const env = new Function('voiceCallS', 'voicePrefsNow', 'VOICE_LOUDNESS', 'voiceCreateLoudness', 'voiceOutputKind', 'voiceLoudnessFor', 'voiceDisp', 'voicePlay', 'window', 'navigator',
    desk() + '; return { voiceOutNode, voiceOutputNow, voiceOutputOnDeviceChange };')(S, () => ({ loudness: 'louder', loudnessBt: 'normal' }), V.VOICE_LOUDNESS, V.voiceCreateLoudness, V.voiceOutputKind, V.voiceLoudnessFor, { cur: null }, { ctx }, {}, nav);
  assert.strictEqual(added.length, 1); assert.strictEqual(added[0][0], 'devicechange'); assert.strictEqual(added[0][1], env.voiceOutputOnDeviceChange);
  env.voiceOutNode(ctx); assert.strictEqual(ctx.__voiceLoudness.gainDb, 9);
  added[0][1]();
  assert.strictEqual(ctx.__voiceLoudness.gainDb, 0, 'the track now says Bluetooth');
  assert.strictEqual(S.micLabel, 'Bluetooth headset');
  S.vad = { info: () => ({ label: 'Speakerphone' }) }; added[0][1]();
  assert.strictEqual(ctx.__voiceLoudness.gainDb, 9);
  S.vad = { info() { throw new Error('gone'); } }; assert.doesNotThrow(() => added[0][1]());
  S.call = null; S.vad = { info: () => ({ label: 'Bluetooth headset' }) }; added[0][1]();
  assert.strictEqual(S.micLabel, 'Speakerphone', 'outside a call the listener does nothing');
  assert.strictEqual(env.voiceOutputNow().output, 'speaker');
  assert.strictEqual((desk().match(/addEventListener\('devicechange'/g) || []).length, 1, 'registered once in the page source');
});
test('desktop: __voiceOut reports the output and label; the call start resets the label', () => {
  assert.ok(app.includes('...voiceOutputNow(), gainDb'));
  assert.ok(app.includes("S.micLine = ''; S.micLabel = '';"));
});

test('phone: a mid-call switch - ui.mic with a Bluetooth label drops the chain to 0 dB, a Speakerphone label brings back +9 dB', () => {
  const ctx = fakeCtx();
  const e = phoneEnv({ sharedCtx: ctx, loudness: 'louder', loudnessBt: 'normal', micLabel: 'Speakerphone' });
  const vc = e.getCall();
  const ui = new Function('voiceCall', 'vc', 'voiceLoudSync', '$', 'voiceMicLine', 'return { ' + between(mob, '      mic: (info) => { if (voiceCall !== vc) return;', '   // while it is lost').trim().replace(/,\s*$/, '') + ' };')(vc, vc, e.voiceLoudSync, () => null, () => '');
  e.voiceOutNode(ctx); const chain = ctx.__voiceLoudness;
  assert.strictEqual(chain.gainDb, 9);
  ui.mic({ label: 'Bluetooth headset' });
  assert.strictEqual(chain.gainDb, 0, 'Bluetooth: at once');
  assert.deepStrictEqual({ ...e.voiceOutputNow() }, { output: 'bluetooth', label: 'Bluetooth headset' });
  ui.mic({ label: 'Speakerphone' });
  assert.strictEqual(chain.gainDb, 9);
  e.prefs.loudnessBt = 'loudest'; ui.mic({ label: 'Bluetooth headset' }); assert.strictEqual(chain.gainDb, 14);
  ui.mic({ label: 'Wired headset' }); assert.strictEqual(chain.gainDb, 9, 'a wired headset counts as speaker');
  assert.strictEqual(e.voiceLoudnessNow(), 'louder');
});
test('phone: devicechange during a call re-reads the open mic and re-applies; one listener; nothing outside a call', () => {
  const ctx = fakeCtx(); const added = [];
  const nav = { mediaDevices: { addEventListener: (t, f) => added.push([t, f]) } };
  const prefs = { loudness: 'louder', loudnessBt: 'normal' };
  const vc = { thinkCtx: null, micInfo: { label: 'Speakerphone' }, vad: { info: () => ({ label: 'Bluetooth headset' }) } };
  const env = new Function('state', 'voicePrefsNow', 'VOICE_LOUDNESS', 'voiceCreateLoudness', 'voiceOutputKind', 'voiceLoudnessFor', 'window', 'navigator',
    'let voiceCall = state.vc; const voiceDisp = { cur: null, shared: { ctx: state.ctx, routes: new WeakMap() } }, voicePlay = { audio: null };\n' + phoneSrc() + '; return { voiceOutNode, voiceOutputNow, voiceOutputOnDeviceChange, setCall(v) { voiceCall = v; } };')({ vc, ctx }, () => prefs, V.VOICE_LOUDNESS, V.voiceCreateLoudness, V.voiceOutputKind, V.voiceLoudnessFor, {}, nav);
  assert.strictEqual(added.length, 1); assert.strictEqual(added[0][0], 'devicechange'); assert.strictEqual(added[0][1], env.voiceOutputOnDeviceChange);
  env.voiceOutNode(ctx); assert.strictEqual(ctx.__voiceLoudness.gainDb, 9);
  added[0][1]();
  assert.strictEqual(ctx.__voiceLoudness.gainDb, 0, 'the track now says Bluetooth');
  vc.vad = { info: () => ({ label: 'Speakerphone' }) }; added[0][1]();
  assert.strictEqual(ctx.__voiceLoudness.gainDb, 9);
  vc.vad = { info() { throw new Error('gone'); } }; assert.doesNotThrow(() => added[0][1]());
  env.setCall(null); assert.doesNotThrow(() => added[0][1]());
  assert.strictEqual(env.voiceOutputNow().output, 'speaker', 'no call: speaker');
  assert.strictEqual((phoneSrc().match(/addEventListener\('devicechange'/g) || []).length, 1, 'registered once in the page source');
});
test('phone: __voiceOut reports the output and label; the panel paints and saves both selects', () => {
  assert.ok(mob.includes('...voiceOutputNow(), gainDb'));
  assert.ok(mob.includes("set('vp-loudness', voiceLoudnessFor(voicePrefsNow(), 'speaker'));") && mob.includes("set('vp-loudness-bt', voiceLoudnessFor(voicePrefsNow(), 'bluetooth'));"));
  // changed: the panel and the Voice sheet share voiceLoudnessSave, which holds the validation and the default
  assert.ok(mob.includes("voiceLoudnessSave('loudnessBt', e.target.value)"));
  assert.ok(mob.includes("(bt ? 'normal' : 'louder')") && mob.includes('Object.prototype.hasOwnProperty.call(VOICE_LOUDNESS, value)'));
});

// ── normalised voices (header X-Voice-Normalized: 1): less boost, same -1 dBFS ceiling ──
test('voiceLoudnessDb(name, true): normalised table 0 / 4 / 8, defaults to 4; without the flag nothing changes', () => {
  assert.deepStrictEqual(V.VOICE_LOUDNESS_NORMALIZED, { normal: 0, louder: 4, loudest: 8 });
  assert.strictEqual(V.voiceLoudnessDb('normal', true), 0);
  assert.strictEqual(V.voiceLoudnessDb('louder', true), 4);
  assert.strictEqual(V.voiceLoudnessDb('loudest', true), 8);
  for (const v of [undefined, null, '', 'LOUD', 'toString', '__proto__', 5, {}]) assert.strictEqual(V.voiceLoudnessDb(v, true), 4, String(v));
  for (const [n, d] of [['normal', 0], ['louder', 9], ['loudest', 14], ['x', 9]]) { assert.strictEqual(V.voiceLoudnessDb(n), d); assert.strictEqual(V.voiceLoudnessDb(n, false), d); }
});
test('chain.setNormalized: louder is +9 dB, +4 dB when normalised, back on false; setLevel afterwards uses the current table', () => {
  const ctx = fakeCtx(); const c = V.voiceCreateLoudness(ctx);
  const lin = (db) => Math.pow(10, db / 20);
  assert.strictEqual(c.normalized, false);
  assert.ok(Math.abs(c.input.gain.value - lin(9)) < 1e-9);
  c.setNormalized(true); assert.strictEqual(c.normalized, true); assert.strictEqual(c.gainDb, 4); assert.ok(Math.abs(c.input.gain.value - lin(4)) < 1e-9);
  c.setLevel('loudest'); assert.strictEqual(c.gainDb, 8); assert.ok(Math.abs(c.input.gain.value - lin(8)) < 1e-9);
  c.setLevel('normal'); assert.strictEqual(c.gainDb, 0);
  c.setLevel('nonsense'); assert.strictEqual(c.gainDb, 4, 'unknown -> louder of the normalised table');
  c.setNormalized(0); assert.strictEqual(c.normalized, false); assert.strictEqual(c.gainDb, 9, 'back on the old table, same remembered name');
  c.setLevel('loudest'); c.setNormalized('yes'); assert.strictEqual(c.normalized, true); assert.strictEqual(c.gainDb, 8);
  c.setNormalized(false); assert.strictEqual(c.gainDb, 14);
});
test('per output: Bluetooth default stays normal (0 dB) with or without the normalised flag, the speaker default is 9 / 4', () => {
  const kindBt = V.voiceLoudnessFor({}, 'bluetooth'), kindSp = V.voiceLoudnessFor({}, 'speaker');
  assert.strictEqual(V.voiceLoudnessDb(kindBt), 0); assert.strictEqual(V.voiceLoudnessDb(kindBt, true), 0);
  assert.strictEqual(V.voiceLoudnessDb(kindSp), 9); assert.strictEqual(V.voiceLoudnessDb(kindSp, true), 4);
  const c = V.voiceCreateLoudness(fakeCtx()); c.setLevel(kindBt); c.setNormalized(true); assert.strictEqual(c.gainDb, 0); c.setNormalized(false); assert.strictEqual(c.gainDb, 0);
});
// changed (review r1, GPT-6 BLOCK): the flag travels with each clip and is applied only when that clip starts playing,
// so a prefetched or cancelled response arriving during another reply never changes the reply that is playing.
test('desktop: voiceFetchTts tags the audio with X-Voice-Normalized and leaves the live chain alone; voicePlayHub applies it at play', async () => {
  const fetchSrc = between(app, 'async function voiceFetchTts(agent, text, voice) {', '// Play sentences with the hub voice');
  const mk = (header, ctx) => {
    const headers = { get: (k) => (String(k).toLowerCase() === 'x-voice-normalized' ? header : null) };
    const fetchFn = async () => ({ ok: true, status: 200, headers, arrayBuffer: async () => new ArrayBuffer(4) });
    return new Function('voiceCallS', 'voicePrefsNow', 'VOICE_LOUDNESS', 'voiceCreateLoudness', 'voiceOutputKind', 'voiceLoudnessFor', 'voiceDisp', 'voicePlay', 'window', 'fetch', 'voiceSpeedNow', 'voiceBusyToast', 'voiceSpeedFor',
      desk() + '\n' + fetchSrc + '; return { voiceOutNode, voiceFetchTts, voiceNoteNormalized };')({ call: {} }, () => ({ loudness: 'louder' }), V.VOICE_LOUDNESS, V.voiceCreateLoudness, V.voiceOutputKind, V.voiceLoudnessFor, { cur: null }, { ctx }, {}, fetchFn, () => 1, () => false, () => 1);   // voiceSpeedFor: the agent's voice defaults (stub)
  };
  let ctx = fakeCtx(); let env = mk('1', ctx);
  env.voiceOutNode(ctx); env.voiceNoteNormalized(true); assert.strictEqual(ctx.__voiceLoudness.gainDb, 4, 'a normalised local reply is playing at +4');
  const late = await mk(null, ctx).voiceFetchTts('a', 'cancelled cloud sentence');   // arrives during the local reply
  assert.strictEqual(late.__voiceNorm, false);
  assert.strictEqual(ctx.__voiceLoudness.gainDb, 4, 'a response arriving never changes the playing reply');
  assert.strictEqual((await env.voiceFetchTts('a', 'hello')).__voiceNorm, true, 'header 1 tags the audio');
  env.voiceNoteNormalized(false); assert.strictEqual(ctx.__voiceLoudness.gainDb, 9, 'un-normalised audio starting: +9 dB');
  ctx = fakeCtx(); env = mk('1', ctx); env.voiceNoteNormalized(true);
  env.voiceOutNode(ctx); assert.strictEqual(ctx.__voiceLoudness.gainDb, 4, 'a chain created after the flag picks it up');
  // voicePlayHub: the flag is read before decoding and applied after the token check, right before the source starts
  const play = between(app, 'async function voicePlayHub(agent, sentences, voice, my) {', '// The device voice is used only');
  const runHub = async (norms, onDecoded) => {
    const log = []; const voicePlay = { token: 1, ctx: null };
    class FakeCtx {
      constructor() { this.state = 'running'; this.destination = {}; }
      async decodeAudioData(buf) { const ab = { norm: buf.__voiceNorm }; if (onDecoded) onDecoded(voicePlay); return ab; }
      createBufferSource() { const s = { connect() {}, buffer: null, start() { log.push('start:' + s.buffer.norm); setImmediate(() => s.onended && s.onended()); } }; return s; }
    }
    const fetchTts = async (a, text) => { const b = new ArrayBuffer(2); b.__voiceNorm = norms[Number(text)]; return b; };
    const fn = new Function('voicePlay', 'window', 'voiceFetchTts', 'voiceNoteNormalized', play + '; return voicePlayHub;');
    await fn(voicePlay, { AudioContext: FakeCtx }, fetchTts, (f) => log.push('note:' + f))('a', norms.map((_, i) => String(i)), 'v', 1);
    return log;
  };
  assert.deepStrictEqual(await runHub([true, false, true]), ['note:true', 'start:true', 'note:false', 'start:false', 'note:true', 'start:true'], "each sentence's flag is applied right before its own start()");
  assert.deepStrictEqual(await runHub([true, true], (vp) => { vp.token = 2; }), [], 'a token change after decode applies nothing and starts nothing');
  assert.ok(!fetchSrc.includes('voiceNoteNormalized'), 'the fetch never touches the chain');
  assert.ok(app.includes('normalized: c ? !!c.normalized : voiceNormFlag'), '__voiceOut reports normalized');
  const bare = new Function('fetch', 'voiceSpeedNow', 'voiceBusyToast', 'voiceSpeedFor', fetchSrc + '; return voiceFetchTts;')(async () => ({ ok: true, status: 200, headers: { get: () => '1' }, arrayBuffer: async () => new ArrayBuffer(1) }), () => 1, () => false, () => 1);   // voiceSpeedFor: stub
  assert.strictEqual((await bare('a', 't')).byteLength, 1);
});
test('phone: voiceTtsBlob tags the blob with X-Voice-Normalized and leaves the live chain alone; voicePlayBlob applies it at play', async () => {
  const blobSrc = between(mob, 'async function voiceTtsBlob(agent, text) {', 'function voicePlayBlob(');
  const mk = (header, ctx) => {
    const headers = { get: (k) => (String(k).toLowerCase() === 'x-voice-normalized' ? header : null) };
    const api = async () => ({ ok: true, status: 200, headers, blob: async () => ({ size: 4 }) });
    const prefs = { loudness: 'louder', loudnessBt: 'normal' };
    const state = { voiceCall: { thinkCtx: null, micInfo: { label: '' } }, voiceDisp: { cur: null, shared: { ctx, routes: new WeakMap() } }, voicePlay: { audio: null } };
    return new Function('state', 'voicePrefsNow', 'VOICE_LOUDNESS', 'voiceCreateLoudness', 'voiceOutputKind', 'voiceLoudnessFor', 'window', 'api', 'voiceOn', 'voiceSpeedNow', 'toast', 'voiceSpeedFor',
      'let voiceCall = state.voiceCall; const voiceDisp = state.voiceDisp, voicePlay = state.voicePlay;\n' + phoneSrc() + '\n' + blobSrc + '; return { voiceOutNode, voiceTtsBlob, voiceNoteNormalized };')(state, () => prefs, V.VOICE_LOUDNESS, V.voiceCreateLoudness, V.voiceOutputKind, V.voiceLoudnessFor, {}, api, () => true, () => 1, () => {}, () => 1);   // voiceSpeedFor: the agent's voice defaults (stub)
  };
  let ctx = fakeCtx(); let env = mk('1', ctx);
  env.voiceOutNode(ctx); env.voiceNoteNormalized(true); assert.strictEqual(ctx.__voiceLoudness.gainDb, 4);
  const late = await mk(null, ctx).voiceTtsBlob('a', 'cancelled cloud sentence');
  assert.strictEqual(late.__voiceNorm, false);
  assert.strictEqual(ctx.__voiceLoudness.gainDb, 4, 'a response arriving never changes the playing reply');
  assert.strictEqual((await env.voiceTtsBlob('a', 'hello')).__voiceNorm, true);
  env.voiceNoteNormalized(false); assert.strictEqual(ctx.__voiceLoudness.gainDb, 9);
  ctx = fakeCtx(); env = mk('1', ctx); env.voiceNoteNormalized(true);
  env.voiceOutNode(ctx); assert.strictEqual(ctx.__voiceLoudness.gainDb, 4, 'a chain created after the flag picks it up');
  // voicePlayBlob: the flag is applied only once play() has resolved (behaviour, with a fake <audio> element)
  const playSrc = between(mob, 'function voicePlayBlob(blob, my, meta) {', 'function voiceDeviceSpeak(');
  const mkPlay = (playImpl) => {
    const applied = []; const state = { token: 1, audio: null, url: null, cancel: null }; const plays = [];
    class FakeAudio { play() { const p = playImpl(); plays.push(p); return p; } }
    const URLStub = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };
    const fn = new Function('voicePlay', 'Audio', 'URL', 'voiceDispPagePrep', 'voiceNoteNormalized', playSrc + '; return voicePlayBlob;');
    return { applied, state, plays, run: (blob, my) => fn(state, FakeAudio, URLStub, () => null, (f) => applied.push(f))(blob, my, {}) };
  };
  const ctl = () => { let res, rej; const p = new Promise((a, b) => { res = a; rej = b; }); return { p, res, rej }; };
  const tick = () => new Promise((r) => setImmediate(r));
  { // resolved: applied after, with the blob's flag
    const c = ctl(); const t = mkPlay(() => c.p); t.run({ size: 4, __voiceNorm: true }, 1);
    await tick(); assert.deepStrictEqual(t.applied, [], 'not applied before play() resolves');
    c.res(); await tick(); assert.deepStrictEqual(t.applied, [true], 'applied with the blob flag once play() resolved');
  }
  { const c = ctl(); const t = mkPlay(() => c.p); t.run({ size: 4 }, 1); c.res(); await tick(); assert.deepStrictEqual(t.applied, [false], 'an untagged blob applies false'); }
  { // rejected play(): never applied
    const c = ctl(); const t = mkPlay(() => c.p); const done = t.run({ size: 4, __voiceNorm: true }, 1);
    c.rej(new Error('NotAllowedError')); assert.strictEqual(await done, false); await tick(); assert.deepStrictEqual(t.applied, [], 'a refused play() leaves the flag alone');
  }
  { // token changes before resolve: never applied
    const c = ctl(); const t = mkPlay(() => c.p); t.run({ size: 4, __voiceNorm: true }, 1);
    t.state.token = 2; c.res(); await tick(); assert.deepStrictEqual(t.applied, [], 'a token change before resolve applies nothing');
  }
  { // play() not a promise (old browsers): applied right after the call
    const t = mkPlay(() => undefined); t.run({ size: 4, __voiceNorm: true }, 1); assert.deepStrictEqual(t.applied, [true]);
  }
  { // token already stale at the call: nothing happens at all
    const t = mkPlay(() => Promise.resolve()); t.state.token = 5; assert.strictEqual(await t.run({ size: 4, __voiceNorm: true }, 1), false); assert.deepStrictEqual(t.applied, []); assert.strictEqual(t.plays.length, 0);
  }
  assert.ok(!blobSrc.includes('voiceNoteNormalized'), 'the fetch never touches the chain');
  assert.ok(mob.includes('normalized: c ? !!c.normalized : voiceNormFlag'), '__voiceOut reports normalized');
});
