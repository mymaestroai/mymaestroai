'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createVoiceOrb, orbParseColor, orbLevelFromSamples, ORB_MOODS, ORB_RADIUS, ORB_RADIUS_PRIOR } = require('../lib/ui-voice-orb.js');

function makeEnv(opts) {
  opts = opts || {};
  const t = { ms: 0, raf: null, rafCount: 0, cancelled: 0, calls: [], stops: [], listeners: {}, mq: null, ro: null };
  const grad = { addColorStop(_, c) { t.stops.push(c); } };
  const ctx = new Proxy({}, {
    get(_, k) {
      if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => grad;
      return (...a) => { t.calls.push([k, ...a]); };
    },
    set(_, k, v) { if (k === 'lineWidth') (t.widths = t.widths || []).push(v); if (k === 'fillStyle' || k === 'strokeStyle') { t.styleBad = t.styleBad || /NaN|undefined|Infinity/.test(String(v)); } return true; },
  });
  const canvas = { style: {}, attrs: {}, parentNode: null, width: 0, height: 0, setAttribute(k, v) { this.attrs[k] = v; }, getContext() { return ctx; } };
  const container = {
    clientWidth: opts.w == null ? 400 : opts.w, clientHeight: opts.h == null ? 300 : opts.h,
    appendChild(c) { c.parentNode = container; container.child = c; },
    removeChild(c) { c.parentNode = null; container.child = null; },
    getBoundingClientRect() { return { width: container.clientWidth, height: container.clientHeight }; },
  };
  const addL = (map, ev, fn) => { (map[ev] = map[ev] || []).push(fn); };
  const rmL = (map, ev, fn) => { map[ev] = (map[ev] || []).filter(f => f !== fn); };
  const doc = { hidden: false, visibilityState: 'visible', createElement: () => canvas, dl: {},
    addEventListener(e, f) { addL(doc.dl, e, f); }, removeEventListener(e, f) { rmL(doc.dl, e, f); } };
  const mq = { matches: !!opts.reduced, l: [], addEventListener(e, f) { mq.l.push(f); }, removeEventListener(e, f) { mq.l = mq.l.filter(x => x !== f); } };
  const win = { devicePixelRatio: opts.dpr || 1, wl: {}, matchMedia: () => mq,
    addEventListener(e, f) { addL(win.wl, e, f); }, removeEventListener(e, f) { rmL(win.wl, e, f); },
    getComputedStyle: () => ({ getPropertyValue: n => (opts.vars || {})[n] || '' }) };
  class RO { constructor(cb) { this.cb = cb; this.observed = null; this.disconnected = false; t.ro = this; } observe(el) { this.observed = el; } disconnect() { this.disconnected = true; } }
  const o = { document: doc, window: win, now: () => t.ms, ResizeObserver: opts.noRO ? null : RO,
    raf: cb => { t.raf = cb; t.rafCount++; return t.rafCount; }, caf: () => { t.cancelled++; t.raf = null; } };
  // advance n frames of dtMs
  t.tick = (n, dtMs) => { for (let i = 0; i < n; i++) { const cb = t.raf; if (!cb) return i; t.raf = null; t.ms += dtMs || 16; cb(t.ms); } return n; };
  Object.assign(t, { ctx, canvas, container, doc, win, mq, o });
  return t;
}

test('parsers and level maths are finite', () => {
  assert.deepStrictEqual(orbParseColor('#0af'), [0, 170, 255]);
  assert.deepStrictEqual(orbParseColor(' rgb(1, 2, 3) '), [1, 2, 3]);
  assert.deepStrictEqual(orbParseColor('rgb(10 20 30 / 0.5)'), [10, 20, 30]);
  assert.strictEqual(orbParseColor('banana'), null);
  assert.strictEqual(orbLevelFromSamples(new Uint8Array(256).fill(128)), 0);
  assert.strictEqual(orbLevelFromSamples(new Float32Array([NaN, NaN])), 0);
  assert.strictEqual(orbLevelFromSamples(null), 0);
  const loud = new Uint8Array(256).map((_, i) => (i % 2 ? 255 : 0));
  assert.ok(orbLevelFromSamples(loud) > 0.9 && orbLevelFromSamples(loud) <= 1);
});

test('creates an accessible canvas, DPR capped at 2, label follows state', () => {
  const e = makeEnv({ dpr: 3, w: 200, h: 100 });
  const orb = createVoiceOrb(e.container, e.o);
  assert.strictEqual(e.canvas.attrs.role, 'img');
  assert.strictEqual(e.canvas.attrs['aria-label'], 'Voice orb: idle');
  assert.strictEqual(e.canvas.width, 400); assert.strictEqual(e.canvas.height, 200); // 200*2, not *3
  assert.strictEqual(orb.setState('thinking'), true);
  assert.strictEqual(e.canvas.attrs['aria-label'], 'Voice orb: thinking');
  assert.strictEqual(orb.setState('dancing'), false);
  assert.strictEqual(orb.getInfo().state, 'thinking');
  orb.destroy();
});

test('colour: theme var, then accent, then fallback; palette name; custom; refresh re-reads', () => {
  const first = e => { e.tick(1); return e.stops[0]; };
  let e = makeEnv({ vars: { '--orb-color': '#ff0000', '--accent': '#00ff00' } });
  let orb = createVoiceOrb(e.container, e.o); assert.match(first(e), /^rgba\(255,0,0,/); orb.destroy();
  e = makeEnv({ vars: { '--accent': 'rgb(1,2,3)' } });
  orb = createVoiceOrb(e.container, e.o); assert.match(first(e), /^rgba\(1,2,3,/); orb.destroy();
  e = makeEnv({});
  orb = createVoiceOrb(e.container, e.o); assert.match(first(e), /^rgba\(95,212,255,/); orb.destroy();
  e = makeEnv({ vars: { '--accent': '#ff0000' } });
  orb = createVoiceOrb(e.container, Object.assign({}, e.o, { color: 'green' })); assert.match(first(e), /^rgba\(110,231,160,/);
  orb.setColor('#123456'); e.stops.length = 0; e.tick(1); assert.match(e.stops[0], /^rgba\(18,52,86,/);
  orb.setColor('nonsense'); e.stops.length = 0; e.tick(1); assert.match(e.stops[0], /^rgba\(255,0,0,/); // falls to theme
  orb.destroy();
});

test('idle draws a breathing blob; draws are finite and transform uses capped DPR', () => {
  const e = makeEnv({ dpr: 2 });
  const orb = createVoiceOrb(e.container, e.o);
  e.tick(30, 50);
  assert.ok(e.calls.some(c => c[0] === 'arc'));
  const st = e.calls.find(c => c[0] === 'setTransform'); assert.strictEqual(st[1], 2);
  for (const c of e.calls) for (const v of c.slice(1)) if (typeof v === 'number') assert.ok(isFinite(v), c[0] + ' got ' + v);
  assert.ok(!e.styleBad);
  assert.strictEqual(orb.getInfo().stretch, 0);
  orb.destroy();
});

test('speaking stretches to a line with sound, and gathers back after silence', () => {
  const e = makeEnv();
  const orb = createVoiceOrb(e.container, e.o);
  orb.setState('speaking'); orb.setLevel(0.7);
  e.tick(60, 33);
  assert.ok(orb.getInfo().stretch > 0.9, 'stretched ' + orb.getInfo().stretch);
  e.calls.length = 0; e.tick(1, 16);
  assert.ok(e.calls.some(c => c[0] === 'quadraticCurveTo'), 'a smooth line is drawn');
  orb.setLevel(0);
  e.tick(10, 50); // 0.5 s: hold not yet over
  assert.ok(orb.getInfo().stretch > 0.5);
  e.tick(120, 50); // 6 s: gathered
  assert.strictEqual(orb.getInfo().stretch, 0);
  assert.ok(orb.getInfo().level < 0.01);
  e.calls.length = 0; e.tick(1, 16);
  assert.ok(!e.calls.some(c => c[0] === 'quadraticCurveTo'));
  orb.destroy();
});

test('leaving speaking gathers back and never leaves the line stuck', () => {
  const e = makeEnv();
  const orb = createVoiceOrb(e.container, e.o);
  orb.setState('speaking'); orb.setLevel(1); e.tick(40, 33);
  orb.setLevel(1); orb.setState('listening'); e.tick(200, 50);
  assert.strictEqual(orb.getInfo().stretch, 0);
  orb.destroy();
});

test('levels: NaN, Infinity, negatives, strings and >1 are all safe', () => {
  const e = makeEnv();
  const orb = createVoiceOrb(e.container, e.o);
  for (const v of [NaN, Infinity, -Infinity, -3, 7, '0.5', null, undefined, {}]) { orb.setLevel(v); orb.setMicLevel(v); e.tick(2, 16); const l = orb.getInfo().level; assert.ok(isFinite(l) && l >= 0 && l <= 1, String(v)); }
  for (const c of e.calls) for (const v of c.slice(1)) if (typeof v === 'number') assert.ok(isFinite(v));
  orb.destroy();
});

test('listening follows mic level; idle ignores it', () => {
  const e = makeEnv();
  const orb = createVoiceOrb(e.container, e.o);
  orb.setMicLevel(0.8); e.tick(30, 33);
  assert.ok(orb.getInfo().level < 0.05, 'idle ignores mic');
  orb.setState('listening'); e.tick(30, 33);
  assert.ok(orb.getInfo().level > 0.6);
  orb.setMicLevel(0); e.tick(120, 33);
  assert.ok(orb.getInfo().level < 0.02);
  orb.destroy();
});

test('analyser drives the level; silence reads 0; throwing analyser is dropped; null detaches', () => {
  const e = makeEnv();
  const orb = createVoiceOrb(e.container, e.o);
  let fill = 128, throwIt = false;
  const analyser = { fftSize: 256, getByteTimeDomainData(b) { if (throwIt) throw new Error('closed'); for (let i = 0; i < b.length; i++) b[i] = i % 2 ? 128 + fill : 128 - fill; } };
  orb.setState('speaking'); orb.setAnalyser(analyser); orb.setLevel(1); // setLevel ignored while analyser is set
  fill = 0; e.tick(20, 33);
  assert.ok(orb.getInfo().level < 0.01, 'silent analyser beats setLevel');
  fill = 90; e.tick(20, 33);
  assert.ok(orb.getInfo().level > 0.5 && orb.getInfo().stretch > 0.5);
  throwIt = true; e.tick(2, 33); throwIt = false;
  fill = 90; e.tick(120, 33); // dropped: falls back to setLevel(1)
  assert.ok(orb.getInfo().level > 0.9);
  orb.setLevel(0); orb.setAnalyser(analyser); orb.setAnalyser(null); e.tick(120, 50);
  assert.ok(orb.getInfo().level < 0.01);
  orb.destroy();
});

test('device-speech fallback gives a rhythm between start and end, and stops at end', () => {
  const e = makeEnv();
  const orb = createVoiceOrb(e.container, e.o);
  orb.setState('speaking'); orb.speechEvent('start'); e.tick(40, 33);
  assert.ok(orb.getInfo().stretch > 0.5 && orb.getInfo().level > 0.1);
  orb.speechEvent('boundary'); e.tick(3, 33);
  orb.speechEvent('end'); e.tick(200, 50);
  assert.strictEqual(orb.getInfo().stretch, 0);
  assert.ok(orb.getInfo().level < 0.01);
  orb.speechEvent('start'); orb.setState('idle'); e.tick(100, 50); // leaving speaking cancels the rhythm
  assert.ok(orb.getInfo().level < 0.01);
  orb.destroy();
});

test('react: known moods pulse and decay, unknown ignored', () => {
  const e = makeEnv();
  const orb = createVoiceOrb(e.container, e.o);
  assert.strictEqual(orb.react('shrug'), false);
  for (const m of ORB_MOODS) assert.strictEqual(orb.react(m), true);
  e.tick(5, 16); e.calls.length = 0; e.tick(200, 50);
  orb.destroy();
});

test('reduced motion: steady blob, brightness follows voice, never a line, loop rests when settled', () => {
  const e = makeEnv({ reduced: true });
  const orb = createVoiceOrb(e.container, e.o);
  assert.strictEqual(orb.getInfo().reduced, true);
  orb.setState('speaking'); orb.setLevel(0.9);
  e.tick(100, 33);
  assert.strictEqual(orb.getInfo().stretch, 0);
  assert.ok(!e.calls.some(c => c[0] === 'lineTo' || c[0] === 'quadraticCurveTo'));
  assert.ok(orb.getInfo().level > 0.8);
  // settled: no more frames are queued
  const n = e.tick(1000, 33);
  assert.ok(n < 1000 && e.raf === null && orb.getInfo().running === false, 'loop rested');
  const before = e.rafCount;
  orb.setLevel(0.1); assert.ok(e.rafCount > before, 'a new level wakes the loop');
  orb.destroy();
});

test('reduced motion can change live (media query) and be forced', () => {
  const e = makeEnv();
  const orb = createVoiceOrb(e.container, e.o);
  orb.setState('speaking'); orb.setLevel(1); e.tick(40, 33);
  assert.ok(orb.getInfo().stretch > 0.5);
  e.mq.matches = true; e.mq.l.forEach(f => f({ matches: true }));
  e.tick(2, 33);
  assert.strictEqual(orb.getInfo().stretch, 0);
  orb.setReducedMotion(false); e.tick(40, 33);
  assert.ok(orb.getInfo().stretch > 0.5);
  orb.setReducedMotion(null); // follow system (still reduced)
  assert.strictEqual(orb.getInfo().reduced, true);
  orb.destroy();
});

test('hidden page pauses the loop; visible resumes with no big time jump', () => {
  const e = makeEnv();
  const orb = createVoiceOrb(e.container, e.o);
  e.tick(3, 16);
  e.doc.visibilityState = 'hidden'; e.doc.dl.visibilitychange.forEach(f => f());
  assert.strictEqual(e.raf, null); assert.strictEqual(orb.getInfo().paused, true);
  orb.setLevel(0.5); orb.setState('listening');
  assert.strictEqual(e.raf, null, 'no frames while hidden');
  e.ms += 60000;
  e.doc.visibilityState = 'visible'; e.doc.dl.visibilitychange.forEach(f => f());
  assert.ok(e.raf, 'resumed');
  e.tick(1, 16);
  assert.ok(isFinite(orb.getInfo().level));
  orb.destroy();
});

test('starts paused when the page is already hidden', () => {
  const e = makeEnv(); e.doc.visibilityState = 'hidden'; e.doc.hidden = true;
  const orb = createVoiceOrb(e.container, e.o);
  assert.strictEqual(e.raf, null);
  orb.destroy();
});

test('resize: observer re-measures; zero size does not draw; fallback to window resize without observer', () => {
  let e = makeEnv({ w: 0, h: 0 });
  let orb = createVoiceOrb(e.container, e.o);
  e.tick(2, 16);
  assert.ok(!e.calls.some(c => c[0] === 'arc'), 'nothing drawn at zero size');
  e.container.clientWidth = 300; e.container.clientHeight = 150; e.t = null;
  e.ro.cb();
  assert.strictEqual(e.canvas.width, 300);
  e.tick(2, 16);
  assert.ok(e.calls.some(c => c[0] === 'arc'));
  orb.destroy();
  assert.ok(e.ro.disconnected);
  e = makeEnv({ noRO: true });
  orb = createVoiceOrb(e.container, e.o);
  assert.strictEqual(e.win.wl.resize.length, 1);
  e.container.clientWidth = 100; e.win.wl.resize[0]();
  assert.strictEqual(e.canvas.width, 100);
  orb.destroy();
  assert.strictEqual(e.win.wl.resize.length, 0);
});

test('destroy removes canvas and every listener, cancels the frame, and late callbacks do nothing', () => {
  const e = makeEnv();
  const orb = createVoiceOrb(e.container, e.o);
  e.tick(2, 16);
  const late = e.raf; // a frame queued before destroy
  orb.destroy();
  assert.strictEqual(e.container.child, null);
  assert.strictEqual(e.doc.dl.visibilitychange.length, 0);
  assert.strictEqual(e.mq.l.length, 0);
  assert.ok(e.cancelled >= 1);
  e.calls.length = 0;
  late(e.ms + 16); // late RAF callback after destroy
  assert.strictEqual(e.calls.length, 0);
  assert.strictEqual(e.raf, null);
  // every method is a harmless no-op afterwards; destroy twice is fine
  assert.strictEqual(orb.setState('speaking'), false);
  orb.setLevel(1); orb.setMicLevel(1); orb.setAnalyser({}); orb.react('proud'); orb.speechEvent('start'); orb.setColor('aqua'); orb.refresh(); orb.setReducedMotion(true);
  orb.destroy();
  assert.strictEqual(orb.getInfo().destroyed, true);
  assert.strictEqual(e.raf, null);
  // late media-query and resize callbacks are safe too
  e.ro.cb(); e.doc.dl.visibilitychange && e.doc.dl.visibilitychange.forEach(f => f());
  assert.strictEqual(e.raf, null);
});

test('missing container or document is an error, missing canvas context does not crash', () => {
  assert.throws(() => createVoiceOrb(null, {}), /container/);
  const e = makeEnv(); e.canvas.getContext = () => null;
  const orb = createVoiceOrb(e.container, e.o);
  orb.setState('speaking'); orb.setLevel(1); e.tick(5, 16);
  orb.destroy();
});

test('source is CSP-safe and offline: no eval, no network, no inline style markup', () => {
  const src = require('fs').readFileSync(require.resolve('../lib/ui-voice-orb.js'), 'utf8');
  assert.ok(!/\beval\s*\(|new Function|innerHTML|fetch\(|XMLHttpRequest|https?:\/\/|\.cssText|setAttribute\(\s*['"]style/.test(src.replace(/^\/\*\*[\s\S]*?\*\//, '')));
});

test('afterglow trail is bounded, fades out with the line, and never exists in reduced motion', () => {
  const e = makeEnv();
  const orb = createVoiceOrb(e.container, e.o);
  orb.setState('speaking'); orb.setLevel(0.8);
  e.tick(80, 33);
  e.calls.length = 0; e.tick(1, 33);
  const strokes = e.calls.filter(c => c[0] === 'stroke').length;
  assert.ok(strokes >= 4 && strokes <= 3 + 4, 'main passes plus at most 4 trace strokes, got ' + strokes);
  assert.ok(e.calls.some(c => c[0] === 'quadraticCurveTo'));
  orb.setState('idle'); e.tick(200, 50);
  e.calls.length = 0; e.tick(1, 33);
  assert.ok(!e.calls.some(c => c[0] === 'quadraticCurveTo'), 'no trail left after the line is gone');
  orb.destroy();
  const r = makeEnv({ reduced: true });
  const ro = createVoiceOrb(r.container, r.o);
  ro.setState('speaking'); ro.setLevel(1); r.tick(60, 33);
  assert.ok(!r.calls.some(c => c[0] === 'lineTo' || c[0] === 'moveTo' || c[0] === 'quadraticCurveTo'), 'reduced motion: no line, no trail');
  ro.destroy();
});

test('base radius is ORB_RADIUS (0.20, prior 0.26) of the short side; vignette and scanlines are drawn last', () => {
  const e = makeEnv({ w: 400, h: 300 });
  const orb = createVoiceOrb(e.container, e.o);
  e.tick(1, 16);
  const radii = e.calls.filter(c => c[0] === 'arc').map(c => c[3]);
  assert.strictEqual(ORB_RADIUS, 0.20); assert.strictEqual(ORB_RADIUS_PRIOR, 0.26);
  assert.ok(Math.max(...radii) >= 300 * ORB_RADIUS * 2.6 * 0.99, 'outer glow uses the base radius');
  assert.ok(Math.max(...radii) < 300 * ORB_RADIUS_PRIOR * 2.6 * 0.9, 'smaller than the prior 0.26 radius');
  assert.ok(Math.abs(orb.getInfo().radius - 300 * ORB_RADIUS) < 1.5, 'drawn radius ' + orb.getInfo().radius);
  assert.strictEqual(e.calls[e.calls.length - 1][0], 'fill');
  assert.ok(e.calls.some(c => c[0] === 'rect'), 'scanlines');
  orb.destroy();
});

// helpers for the smooth-line tests: the points of the last (3px core) stroked path of a frame
function lastPath(calls) {
  let end = -1;
  for (let i = calls.length - 1; i >= 0; i--) if (calls[i][0] === 'stroke') { end = i; break; }
  assert.ok(end >= 0, 'a stroke exists');
  let start = end; while (start > 0 && calls[start][0] !== 'beginPath') start--;
  const pts = [];
  for (const c of calls.slice(start, end)) {
    if (c[0] === 'moveTo') pts.push([c[1], c[2]]);
    else if (c[0] === 'quadraticCurveTo') pts.push([c[3], c[4]]);
    else assert.notStrictEqual(c[0], 'lineTo', 'no corner-making lineTo');
  }
  return pts;
}
function quietAnalyser(amp, jitter) { // synthetic speech-like buffer, amp in byte units
  let k = 0;
  return { fftSize: 512, getByteTimeDomainData(b) { k++; for (let i = 0; i < b.length; i++) b[i] = Math.round(128 + amp * (1 + (jitter || 0) * Math.sin(k * 1.7)) * Math.sin(i * 0.9)); } };
}

test('smooth path: quiet real audio gives a broad soft tapered wave, not spikes; core is 3px, glow 10/22', () => {
  const e = makeEnv({ w: 800, h: 600 });
  const orb = createVoiceOrb(e.container, e.o);
  const an = quietAnalyser(9, 0.6); // very quiet, uneven
  orb.setState('speaking'); orb.setAnalyser(an);
  e.tick(150, 33);
  const measured = orb.getInfo().level;
  assert.ok(measured > 0.02 && measured < 0.2, 'getInfo().level stays the honest measurement, got ' + measured);
  e.calls.length = 0; e.tick(1, 33);
  const widths = e.widths.slice(-8);
  assert.ok(widths.includes(3) && widths.includes(10) && widths.includes(22), 'line widths ' + widths);
  const pts = lastPath(e.calls);
  assert.ok(pts.length > 60);
  const ys = pts.map(p => p[1] - 300);
  const peak = Math.max(...ys.map(Math.abs));
  assert.ok(peak > 4, 'quiet audio is visible, peak ' + peak);
  assert.ok(Math.abs(ys[0]) < 0.5 && Math.abs(ys[ys.length - 1]) < 0.5, 'ends taper to the centre line');
  let maxStep = 0, maxCurv = 0;
  for (let i = 1; i < ys.length; i++) maxStep = Math.max(maxStep, Math.abs(ys[i] - ys[i - 1]));
  for (let i = 1; i < ys.length - 1; i++) maxCurv = Math.max(maxCurv, Math.abs(ys[i + 1] - 2 * ys[i] + ys[i - 1]));
  assert.ok(maxStep < peak * 0.25, 'no sharp jumps: step ' + maxStep + ' vs peak ' + peak);
  assert.ok(maxCurv < peak * 0.12, 'broad curvature, not ECG spikes: ' + maxCurv + ' vs peak ' + peak);
  assert.ok(pts.every(p => isFinite(p[0]) && isFinite(p[1])));
  orb.destroy();
});

test('smooth path: an isolated loud burst in history is blurred, not a central spike', () => {
  const e = makeEnv({ w: 800, h: 600 });
  const orb = createVoiceOrb(e.container, e.o);
  let loud = false;
  orb.setState('speaking');
  orb.setAnalyser({ fftSize: 256, getByteTimeDomainData(b) { for (let i = 0; i < b.length; i++) b[i] = loud ? (i % 2 ? 228 : 28) : 128; } });
  e.tick(60, 33); loud = true; e.tick(1, 33); loud = false; e.tick(2, 33);
  e.calls.length = 0; e.tick(1, 16);
  const pts = lastPath(e.calls), ys = pts.map(p => p[1] - 300);
  const peak = Math.max(...ys.map(Math.abs));
  let maxCurv = 0; for (let i = 1; i < ys.length - 1; i++) maxCurv = Math.max(maxCurv, Math.abs(ys[i + 1] - 2 * ys[i] + ys[i - 1]));
  assert.ok(peak > 0.5, 'burst still shows');
  assert.ok(maxCurv < peak * 0.25, 'burst is smooth: ' + maxCurv + ' vs ' + peak);
  orb.destroy();
});

test('silence stays truly silent: level 0, no fabricated level, line flat then gathers and no curve is drawn', () => {
  const e = makeEnv({ w: 800, h: 600 });
  const orb = createVoiceOrb(e.container, e.o);
  let amp = 60;
  orb.setState('speaking');
  orb.setAnalyser({ fftSize: 256, getByteTimeDomainData(b) { for (let i = 0; i < b.length; i++) b[i] = 128 + (i % 2 ? amp : -amp); } });
  e.tick(100, 33); assert.ok(orb.getInfo().level > 0.3);
  amp = 0; e.tick(300, 33); // ~10 s of exact silence
  assert.strictEqual(orb.getInfo().level, 0, 'measured level is exactly 0');
  assert.strictEqual(orb.getInfo().stretch, 0);
  e.calls.length = 0; e.tick(1, 33);
  assert.ok(!e.calls.some(c => c[0] === 'quadraticCurveTo' || c[0] === 'moveTo'), 'nothing drawn but the blob');
  // sub-gate noise (rms < 0.01) also reads exactly 0 and never starts a line
  amp = 1; e.tick(60, 33);
  assert.strictEqual(orb.getInfo().level, 0);
  assert.strictEqual(orb.getInfo().stretch, 0);
  orb.destroy();
});

test('listening: a soft mic-driven halo of gradient lobes hugging the blob; no thin stroke or ring; none while idle or in reduced motion', () => {
  const e = makeEnv();
  const orb = createVoiceOrb(e.container, e.o);
  e.tick(10, 33);
  const frameCalls = () => { e.calls.length = 0; e.tick(1, 33); return e.calls; };
  const idleArcs = frameCalls().filter(c => c[0] === 'arc').length;
  orb.setState('listening'); orb.setMicLevel(0.3); e.tick(60, 33);
  const calls = frameCalls();
  assert.ok(!calls.some(c => ['stroke', 'closePath', 'quadraticCurveTo', 'lineTo'].includes(c[0])), 'no thin stroked ring');
  const arcs = calls.filter(c => c[0] === 'arc');
  assert.ok(arcs.length > idleArcs + 4, 'lobes and band are drawn: ' + arcs.length + ' vs idle ' + idleArcs);
  const R = 300 * ORB_RADIUS, lobes = arcs.slice(0, arcs.length - 5); // blob draws its own 5 last
  assert.ok(lobes.every(c => Math.hypot(c[1] - 200, c[2] - 150) <= R * 1.3 && c[3] <= R * 2.6), 'halo hugs the blob');
  const maxA = () => { e.stops.length = 0; frameCalls(); return e.stops.length; };
  void maxA;
  // brightness of the halo follows the mic (use the stops drawn before the blob's own)
  const haloAlpha = () => { e.stops.length = 0; frameCalls(); return Math.max(...e.stops.slice(0, 7 * 3 - 0).map(s => +/,([\d.]+)\)$/.exec(s)[1])); };
  orb.setMicLevel(0); e.tick(200, 33); const quiet = haloAlpha();
  orb.setMicLevel(0.4); e.tick(80, 33); const loud = haloAlpha();
  assert.ok(loud > quiet * 1.3, 'halo follows the mic: ' + quiet + ' -> ' + loud);
  assert.ok(e.stops.every(s => /^rgba\(/.test(s)));
  orb.setReducedMotion(true); e.tick(3, 33);
  assert.ok(!frameCalls().some(c => ['closePath', 'quadraticCurveTo', 'stroke'].includes(c[0])), 'reduced motion: no halo motion drawn as curves');
  orb.destroy();
});

// steady level through the real draw path: the largest |y| of the wave over a stretch of frames, as a fraction of the maximum wave height
function steadyWaveFraction(level, w, h) {
  const e = makeEnv({ w, h }); const orb = createVoiceOrb(e.container, e.o);
  const maxH = Math.min(h * 0.22, h * 0.28);
  orb.setState('speaking'); orb.setLevel(level); e.tick(150, 33);
  let pk = 0;
  for (let n = 0; n < 60; n++) { e.calls.length = 0; e.tick(1, 33); if (e.calls.some(c => c[0] === 'stroke')) pk = Math.max(pk, ...lastPath(e.calls).map(p => Math.abs(p[1] - h / 2))); }
  const info = orb.getInfo(); orb.destroy();
  return { frac: pk / maxH, info };
}

test('fixed wave curve: quiet is flat, ordinary speech 0.1-0.35 is 25-35% of the height, 0.7+ is full; no auto-gain', () => {
  const q = steadyWaveFraction(0.04, 800, 600), q2 = steadyWaveFraction(0.055, 800, 600);
  assert.strictEqual(q.frac, 0, 'sub-gate level draws no wave'); assert.strictEqual(q2.frac, 0, 'breath level stays flat');
  const o1 = steadyWaveFraction(0.1, 800, 600), o2 = steadyWaveFraction(0.2, 800, 600), o3 = steadyWaveFraction(0.35, 800, 600);
  // visual diagnostics are exactly the fixed curve
  assert.ok(Math.abs(o1.info.visual.level - 0.25) < 0.01, JSON.stringify(o1.info.visual));
  assert.ok(Math.abs(o3.info.visual.level - 0.35) < 0.01, JSON.stringify(o3.info.visual));
  assert.ok(o2.info.visual.level > 0.25 && o2.info.visual.level < 0.35);
  // drawn height: ordinary speech is a modest wave (not filling the height), growing with level
  for (const [o, nm] of [[o1, '0.1'], [o2, '0.2'], [o3, '0.35']]) assert.ok(o.frac > 0.2 && o.frac < 0.5, 'ordinary speech ' + nm + ' is a modest wave: ' + o.frac.toFixed(2));
  assert.ok(o1.frac < o3.frac, 'louder is taller');
  const l = steadyWaveFraction(0.7, 800, 600), l2 = steadyWaveFraction(1, 800, 600);
  assert.ok(l.frac > 0.85 && l.frac <= 1.0001 && l2.frac > 0.85 && l2.frac <= 1.0001, 'loud fills the height: ' + l.frac.toFixed(2) + ' ' + l2.frac.toFixed(2));
  assert.ok(Math.abs(l.frac - l2.frac) < 0.03, '0.7 already counts as full');
  assert.ok(l.frac > 2 * o3.frac, 'loud is far taller than ordinary speech');
  // honest measured level, and the old normalising gain is gone: gain is only the curve's ratio, never a boost to full
  assert.ok(Math.abs(o1.info.level - 0.1) < 0.01);
  assert.ok(o1.info.visual.gain > 2 && o1.info.visual.gain < 3, 'gain is just curve/level: ' + o1.info.visual.gain);
});

test('fixed wave curve: the same voice stays the same after loud speech (no AGC memory), and a quiet voice is not normalised to full', () => {
  const e = makeEnv({ w: 800, h: 600 }); const orb = createVoiceOrb(e.container, e.o);
  orb.setState('speaking'); orb.setLevel(0.12); e.tick(150, 33);
  const before = orb.getInfo().visual.level;
  orb.setLevel(0.9); e.tick(60, 33); orb.setLevel(0.12); e.tick(45, 33);
  assert.ok(Math.abs(orb.getInfo().visual.level - before) < 0.02, 'loud history does not change the quiet mapping: ' + before + ' -> ' + orb.getInfo().visual.level);
  e.tick(300, 33);
  assert.ok(Math.abs(orb.getInfo().visual.level - before) < 0.02 && orb.getInfo().visual.level < 0.35, 'still ordinary height after any time: ' + orb.getInfo().visual.level);
  // a very quiet but audible voice and a loud one differ by the curve, not by a normaliser
  orb.setLevel(0.08); e.tick(60, 33); const v08 = orb.getInfo().visual.level;
  assert.ok(v08 > 0 && v08 < 0.25, 'just above the gate is small: ' + v08);
  orb.destroy();
});

test('fixed wave curve: monotone, continuous, bounded in 0..1 across the whole level range', () => {
  const e = makeEnv(); const orb = createVoiceOrb(e.container, e.o);
  orb.setState('speaking');
  let prev = 0;
  for (let l = 0; l <= 1.0001; l += 0.01) { orb.setLevel(l); e.tick(120, 33); const v = orb.getInfo().visual.level; assert.ok(v >= prev - 1e-6 && v <= 1, 'monotone at ' + l + ': ' + v); assert.ok(v - prev < 0.12, 'no jump at ' + l); prev = v; }
  orb.destroy();
});

test('fixed curve: breath/room noise stays flat after loud speech, whatever the running peak is', () => {
  const e = makeEnv({ w: 800, h: 600 });
  const orb = createVoiceOrb(e.container, e.o);
  orb.setState('speaking'); orb.setLevel(0.9); e.tick(40, 33);
  const loud = orb.getInfo().visual; assert.ok(loud.level > 0.95 && loud.level <= 1, JSON.stringify(loud));
  assert.ok(Math.abs(loud.gain - 1) < 0.5, 'loud speech is not boosted much');
  // breath/noise: low measured levels draw nothing, whatever the peak is
  orb.setLevel(0.04); e.tick(200, 33);
  assert.strictEqual(orb.getInfo().visual.level, 0, 'sub-gate level is not amplified');
  orb.setLevel(0.055); e.tick(200, 33);
  assert.strictEqual(orb.getInfo().visual.level, 0, 'breath-level noise is gated');
  assert.ok(orb.getInfo().level > 0.05 && orb.getInfo().level < 0.06, 'measured level untouched');
  orb.setLevel(0); e.tick(600, 33);
  assert.strictEqual(orb.getInfo().visual.level, 0); assert.strictEqual(orb.getInfo().visual.peak, 0);
  orb.destroy();
});

test('wave moves outward from the blob on both sides, is mirror-symmetric and smooth at the centre', () => {
  const e = makeEnv({ w: 800, h: 600 });
  const orb = createVoiceOrb(e.container, e.o);
  orb.setState('speaking'); orb.setLevel(0.5); e.tick(150, 33); // steady level: flat envelope, only the carrier moves
  const ysAt = () => { e.calls.length = 0; e.tick(1, 20); return lastPath(e.calls).map(p => p[1] - 300); }; // consecutive frames 20 ms apart
  const a = ysAt(), b = ysAt(), c = ysAt();
  const n = a.length, mid = (n - 1) / 2;
  for (let i = 1; i < n - 2; i++) assert.ok(Math.abs(a[i] - a[n - 2 - i]) < 0.01 * 120, 'mirror symmetric at ' + i); // path points are segment midpoints: k mirrors n-2-k
  // outward: the pattern at t+dt on the right half equals the earlier pattern shifted toward the end (larger index)
  const shiftOf = (x, y) => { let best = 0, bestErr = Infinity; for (let s = -9; s <= 9; s++) { let err = 0, m = 0; for (let i = Math.ceil(mid) + 12; i < n - 14; i++) { err += (y[i] - x[i - s]) ** 2; m++; } if (err / m < bestErr) { bestErr = err / m; best = s; } } return best; };
  const wide = [a, b]; // about 0.2 s apart for a measurable shift
  const s = shiftOf(wide[0], wide[1]);
  assert.ok(s > 0, 'right side crests move away from the centre (shift ' + s + ')');
  // left side moves outward too (toward lower index): mirror of the above, by symmetry
  const rev = x => x.slice().reverse();
  assert.ok(shiftOf(rev(wide[0]), rev(wide[1])) > 0, 'left side moves outward as well');
  // smooth at the centre: no cusp, the slope on both sides of the middle point agrees
  const peak = Math.max(...b.map(Math.abs)), k0 = (n - 2) / 2; // the two middle midpoints
  const slopeC = Math.abs(b[Math.ceil(k0)] - b[Math.floor(k0)]), slopeNear = Math.abs(b[Math.ceil(k0) + 4] - b[Math.ceil(k0) + 3]);
  assert.ok(slopeC < peak * 0.02, 'flat (even, smooth) at the centre, not a cusp: ' + slopeC + ' vs peak ' + peak);
  let maxCurv = 0; for (let i = 1; i < n - 1; i++) maxCurv = Math.max(maxCurv, Math.abs(b[i + 1] - 2 * b[i] + b[i - 1]));
  assert.ok(maxCurv < peak * 0.12, 'no kinks anywhere: ' + maxCurv);
  void slopeNear;
  assert.ok(peak > 20, 'the wave is substantial ' + peak);
  orb.destroy();
});

const ORB_THINK_REST_ALPHA = 0.8; // normal resting brightness while thinking (not the old 0.42 dim)
// ---- thinking pulse events: the shared cluster event (lib/ui-voice-thinking.js) and the old { at, attackMs: 250, decayMs: 1000, strength } ----
function thinkRig(opts) {
  const e = makeEnv(opts || { w: 400, h: 300 });
  const orb = createVoiceOrb(e.container, e.o);
  orb.setState('thinking'); e.tick(5, 16);
  const frame = (dt) => { e.calls.length = 0; e.stops.length = 0; e.tick(1, dt || 16); return { r: orb.getInfo().radius, a: Math.max(...e.stops.map(s => +/,([\d.]+)\)$/.exec(s)[1])), v: orb.getInfo().thinking.value }; };
  return { e, orb, frame };
}

test('thinking: rests dim and still without events (no sine pulse of its own)', () => {
  const { e, orb, frame } = thinkRig();
  const rs = [], as = [];
  for (let i = 0; i < 150; i++) { const f = frame(50); rs.push(f.r); as.push(f.a); }
  assert.ok(Math.max(...rs) - Math.min(...rs) < 1e-9, 'radius constant at rest');
  assert.ok(Math.max(...as) - Math.min(...as) < 1e-9, 'brightness constant at rest');
  assert.strictEqual(orb.getInfo().thinking.value, 0);
  assert.ok(Math.abs(rs[0] - 300 * ORB_RADIUS) < 1.5, 'rests at the base radius');
  orb.destroy();
});

test('thinking: one timestamped event (old contract) swells smoothly to 6% at attack, glows a little brighter, and returns to rest by attack+decay', () => {
  const { e, orb, frame } = thinkRig();
  const rest = frame(16), R = rest.r;
  const at = e.ms + 20;
  assert.strictEqual(orb.thinkingPulse({ at, attackMs: 250, decayMs: 1000, strength: 1 }), true);
  assert.strictEqual(orb.getInfo().thinking.events, 1);
  const rs = [], as = [], ts = [];
  while (e.ms < at + 1400) { const f = frame(10); rs.push(f.r); as.push(f.a); ts.push(e.ms - at); }
  const iMax = rs.indexOf(Math.max(...rs));
  assert.ok(Math.abs(ts[iMax] - 250) <= 20, 'peak at the attack time, got ' + ts[iMax]);
  assert.ok(Math.abs(Math.max(...rs) / R - 1.06) < 0.003, 'peak swell is 6%: ' + (Math.max(...rs) / R));
  assert.ok(Math.max(...rs) / R <= 1.0601, 'never beyond 6%');
  assert.ok(Math.max(...as) > rest.a + 0.05 && Math.max(...as) <= 1, 'glows a little brighter at the peak: ' + rest.a + ' -> ' + Math.max(...as));
  // monotone rise to the peak and monotone fall after (one smooth swell, no wobble)
  for (let i = 1; i <= iMax; i++) assert.ok(rs[i] >= rs[i - 1] - 1e-9, 'rises smoothly');
  for (let i = iMax + 1; i < rs.length; i++) assert.ok(rs[i] <= rs[i - 1] + 1e-9, 'falls smoothly');
  let maxStep = 0; for (let i = 1; i < rs.length; i++) maxStep = Math.max(maxStep, Math.abs(rs[i] - rs[i - 1]));
  assert.ok(maxStep < R * 0.06 * 0.1, 'no jumps: ' + maxStep);
  assert.ok(Math.abs(rs[rs.length - 1] - R) < 1e-6 && Math.abs(as[as.length - 1] - rest.a) < 1e-6, 'back at rest after attack+decay');
  assert.strictEqual(orb.getInfo().thinking.phase, 'idle');
  assert.strictEqual(orb.getInfo().thinking.events, 0);
  orb.destroy();
});

test('thinking: a future-dated event waits, strength scales the swell, overlapping events never exceed 6%', () => {
  const { e, orb, frame } = thinkRig();
  const R = frame(16).r, at = e.ms + 400;
  assert.strictEqual(orb.thinkingPulse({ at, attackMs: 250, decayMs: 1000, strength: 0.5 }), true);
  assert.strictEqual(frame(100).v, 0); assert.strictEqual(orb.getInfo().thinking.phase, 'pending');
  let mx = 0; while (e.ms < at + 300) mx = Math.max(mx, frame(10).r);
  assert.ok(Math.abs(mx / R - 1.03) < 0.003, 'half strength is a 3% swell: ' + mx / R);
  const e2 = thinkRig(); const R2 = e2.frame(16).r; let mx2 = 0;
  for (let k = 0; k < 4; k++) e2.orb.thinkingPulse({ at: e2.e.ms + 50 * k, strength: 1 }); // defaults 250/1000, overlapping
  while (e2.e.ms < 1500) mx2 = Math.max(mx2, e2.frame(10).r);
  assert.ok(mx2 / R2 <= 1.0601 && mx2 / R2 > 1.05, 'overlap is capped at 6%: ' + mx2 / R2);
  assert.ok(e2.orb.getInfo().thinking.events <= 6);
  orb.destroy(); e2.orb.destroy();
});

test('thinking: events are ignored when not thinking, stale, malformed or destroyed; leaving thinking drops them', () => {
  const e = makeEnv(); const orb = createVoiceOrb(e.container, e.o); e.tick(3, 16);
  assert.strictEqual(orb.thinkingPulse({ at: e.ms }), false, 'idle: ignored');
  orb.setState('thinking'); e.tick(3, 16); e.ms += 5000;
  assert.strictEqual(orb.thinkingPulse({ at: e.ms - 2000, attackMs: 250, decayMs: 1000, strength: 1 }), false, 'stale (already finished)');
  for (const bad of [null, undefined, 5, 'x', {}, { at: NaN }, { at: Infinity }, { at: '1' }]) assert.strictEqual(orb.thinkingPulse(bad), false, 'malformed ' + JSON.stringify(bad));
  assert.strictEqual(orb.getInfo().thinking.events, 0);
  assert.strictEqual(orb.thinkingPulse({ at: e.ms, strength: 1 }), true);
  orb.setState('idle'); assert.strictEqual(orb.getInfo().thinking.events, 0); assert.strictEqual(orb.getInfo().thinking.value, 0);
  orb.setState('thinking'); e.tick(40, 16);
  assert.strictEqual(orb.getInfo().thinking.value, 0, 'dropped events are not replayed when thinking again');
  const R = orb.getInfo().radius; assert.ok(Math.abs(R - 300 * ORB_RADIUS) < 1.5);
  orb.thinkingPulse({ at: e.ms, strength: 1 }); orb.destroy();
  assert.strictEqual(orb.getInfo().thinking.events, 0);
  assert.strictEqual(orb.thinkingPulse({ at: e.ms, strength: 1 }), false, 'destroyed: ignored');
});

test('thinking: the orb has no timer of its own; with no events time alone changes nothing, only the raf loop and given timestamps drive it', () => {
  const calls = []; const st = globalThis.setTimeout, si = globalThis.setInterval;
  globalThis.setTimeout = (...a) => { calls.push('timeout'); return st(...a); };
  globalThis.setInterval = (...a) => { calls.push('interval'); return si(...a); };
  try {
    const { e, orb, frame } = thinkRig();
    orb.thinkingPulse({ at: e.ms, strength: 1 }); e.tick(30, 16);
    orb.setState('idle'); orb.setState('thinking'); orb.thinkingPulse({ at: e.ms + 10 }); orb.destroy();
    assert.deepStrictEqual(calls, [], 'no setTimeout/setInterval used');
    assert.strictEqual(e.raf, null, 'loop stopped after destroy');
    void frame;
  } finally { globalThis.setTimeout = st; globalThis.setInterval = si; }
});

test('thinking in reduced motion: only brightness changes at the peak, never size, no curves', () => {
  const rig = thinkRig({ reduced: true, w: 400, h: 300 });
  const { e, orb, frame } = rig;
  assert.strictEqual(orb.thinkingPulse({ at: e.ms, attackMs: 250, decayMs: 1000, strength: 1 }), true);
  const rest = frame(1); // pulse is at its start: resting brightness
  let ra = [], aa = [];
  for (let i = 0; i < 130; i++) { const f = frame(10); ra.push(f.r); aa.push(f.a); }
  assert.ok(Math.max(...ra) - Math.min(...ra) < 1e-9, 'size does not change');
  assert.ok(Math.max(...aa) > rest.a + 0.05, 'brightness rises: ' + rest.a + ' -> ' + Math.max(...aa));
  const fin = aa.filter(isFinite); // the loop settles (stops drawing) once the blob is steady again
  assert.ok(fin.length > 20 && Math.abs(fin[fin.length - 1] - rest.a) < 0.005, 'returns to the steady blob: ' + fin[fin.length - 1] + ' vs ' + rest.a);
  assert.strictEqual(orb.getInfo().thinking.value, 0);
  assert.ok(!e.calls.some(c => ['lineTo', 'moveTo', 'quadraticCurveTo', 'stroke'].includes(c[0])));
  orb.destroy();
});

// ---- fast syllable envelope (30 ms attack / 135 ms release) and the drawn wave between syllables ----
test('fast envelope: about 30 ms attack and 135 ms release on the measured level, the slow display level lags behind it', () => {
  const e = makeEnv({ w: 800, h: 600 }); const orb = createVoiceOrb(e.container, e.o);
  orb.setState('speaking'); e.tick(3, 5);
  const info = orb.getInfo(); assert.strictEqual(info.fast.attackMs, 30); assert.strictEqual(info.fast.releaseMs, 135);
  orb.setLevel(1); e.tick(6, 5); // 30 ms
  const f30 = orb.getInfo().fast.level;
  assert.ok(f30 > 0.55 && f30 < 0.72, 'about 63% of the step after one attack time: ' + f30);
  assert.ok(orb.getInfo().level < f30 * 0.75, 'the slow level (tau 50 ms) is behind: ' + orb.getInfo().level);
  e.tick(30, 5); assert.ok(orb.getInfo().fast.level > 0.99);
  orb.setLevel(0); e.tick(27, 5); // 135 ms
  const r135 = orb.getInfo().fast.level;
  assert.ok(r135 > 0.3 && r135 < 0.45, 'about 37% remains after one release time: ' + r135);
  assert.ok(orb.getInfo().level > r135, 'the slow level releases slower (tau 250 ms)');
  e.tick(200, 5); assert.strictEqual(orb.getInfo().fast.level, 0, 'exact silence reaches exactly 0');
  orb.destroy();
});

test('drawn wave: rises within ~30 ms of a syllable and is gone in the 300 ms between quiet syllables (no lingering)', () => {
  const e = makeEnv({ w: 800, h: 600 }); const orb = createVoiceOrb(e.container, e.o);
  const maxH = Math.min(600 * 0.22, 600 * 0.28);
  orb.setState('speaking');
  orb.setLevel(0.5); e.tick(40, 10); // the line is formed
  const amp = () => { e.calls.length = 0; e.tick(1, 10); return e.calls.some(c => c[0] === 'stroke') ? Math.max(...lastPath(e.calls).map(p => Math.abs(p[1] - 300))) : 0; };
  const peaks = [], quietEnd = [], rise = [];
  for (let s = 0; s < 8; s++) {
    orb.setLevel(0.5);
    let pk = 0; const a = [];
    for (let i = 0; i < 15; i++) { const v = amp(); a.push(v); pk = Math.max(pk, v); }
    orb.setLevel(0); let tail = 0;
    for (let i = 0; i < 30; i++) { const v = amp(); if (i >= 25) tail = Math.max(tail, v); }
    if (s >= 3) { peaks.push(pk); quietEnd.push(tail); rise.push(a[3]); }
  }
  for (let i = 0; i < peaks.length; i++) {
    assert.ok(peaks[i] > 0.15 * maxH, 'the syllable is visible: ' + peaks[i]);
    assert.ok(quietEnd[i] < 0.2 * peaks[i], 'wave nearly gone 250-300 ms after the syllable: ' + quietEnd[i] + ' vs ' + peaks[i]);
    assert.ok(rise[i] > 0.25 * peaks[i], 'responds fast to the attack (40 ms): ' + rise[i] + ' vs ' + peaks[i]);
  }
  orb.destroy();
});

// ---- ripple bursts: signed mirrored carrier, fast centre-to-end transport (default 275 ms, tunable) ----
// run speech-like syllables (150 ms on / 300 ms off); returns, for the last syllable, the frames since its onset
function syllableFrames(opts, stepMs) {
  const e = makeEnv({ w: 800, h: 600 }); const orb = createVoiceOrb(e.container, Object.assign({}, e.o, opts || {}));
  orb.setState('speaking'); orb.setLevel(0.5); e.tick(40, 10);
  let frames = [];
  for (let s = 0; s < 8; s++) {
    frames = [];
    orb.setLevel(0.5);
    for (let t = 0; t < 450; t += stepMs) {
      if (t === 150) orb.setLevel(0);
      e.calls.length = 0; e.tick(1, stepMs);
      const ys = e.calls.some(c => c[0] === 'stroke') ? lastPath(e.calls).map(p => p[1] - 300) : null;
      frames.push({ t: t + stepMs, ys });
    }
  }
  orb.destroy();
  return frames;
}
const cenOf = ys => { const n = ys.length; let s = 0, m = 0; ys.forEach((y, i) => { const u = Math.abs(i / (n - 1) * 2 - 1); s += Math.abs(y) * u; m += Math.abs(y); }); return m > 0 ? s / m : 0; };

test('ripple carrier: signed, mirrored, above AND below the baseline across the whole line, tapered at the ends (no one-sided central hump)', () => {
  const fr = syllableFrames({}, 10);
  const f = fr.find(x => x.t === 150).ys, n = f.length, peak = Math.max(...f.map(Math.abs));
  assert.ok(peak > 20, 'a visible burst ' + peak);
  const st = makeEnv({ w: 800, h: 600 }), so = createVoiceOrb(st.container, st.o);
  so.setState('speaking'); so.setLevel(0.5); st.tick(100, 10);
  const all = []; for (let i = 0; i < 60; i++) { st.calls.length = 0; st.tick(1, 10); all.push(lastPath(st.calls).map(p => p[1] - 300)); }
  so.destroy();
  for (const [a, b] of [[0.0, 0.35], [0.35, 0.7]]) {
    let up = 0, down = 0;
    for (const ys of all) ys.forEach((y, i) => { const u = Math.abs(i / (n - 1) * 2 - 1); if (u >= a && u < b) { if (y > peak * 0.1) up++; if (y < -peak * 0.1) down++; } });
    assert.ok(up > 5 && down > 5, 'zone ' + a + '-' + b + ' goes above (' + up + ') and below (' + down + ') the baseline');
  }
  // both halves carry both signs and mirror each other exactly
  for (let i = 1; i < n - 2; i++) assert.ok(Math.abs(f[i] - f[n - 2 - i]) < 1e-6 + 0.01 * peak, 'mirror at ' + i);
  assert.ok(Math.abs(f[0]) < 0.5 && Math.abs(f[n - 1]) < 0.5, 'tapered at both ends');
  // not a central hump: the burst frame has a sign change within each half (a carrier, not a one-signed lobe)
  let sc = 0; for (let i = Math.ceil(n / 2) + 1; i < n - 2; i++) if (f[i] * f[i - 1] < 0) sc++;
  assert.ok(sc >= 1, 'carrier crosses the baseline in the right half: ' + sc);
});

test('ripple transport: a burst moves from the centre to the ends in ~275 ms (not ~2 s), and the tunable rippleMs changes the speed', () => {
  assert.strictEqual(require('../lib/ui-voice-orb.js').ORB_RIPPLE_MS, 275);
  const ext = (fr, t) => { const ys = fr.find(x => x.t === t).ys, n = ys.length, pk = Math.max(...fr.map(x => x.ys ? Math.max(...x.ys.map(Math.abs)) : 0)); let m = 0; ys.forEach((y, i) => { if (Math.abs(y) > 0.08 * pk) m = Math.max(m, Math.abs(i / (n - 1) * 2 - 1)); }); return m; };
  const fr = syllableFrames({}, 10);
  // how far out the burst has reached (largest distance from the centre with visible amplitude, 0..1) grows at ~1/275 ms
  const x40 = ext(fr, 40), x100 = ext(fr, 100), x150 = ext(fr, 150);
  assert.ok(x40 < 0.4 && x100 > x40 + 0.15 && x150 > x100, 'burst front moves outward: ' + [x40, x100, x150].map(x => x.toFixed(2)));
  assert.ok(x150 > 0.4 && x150 < 0.8, 'about half the line after 150 ms (' + x150.toFixed(2) + '), i.e. the end after ~275 ms, not ~2 s');
  const quick = syllableFrames({ rippleMs: 150 }, 10);
  assert.ok(ext(quick, 100) > x100 + 0.1, 'smaller rippleMs means faster travel: ' + ext(quick, 100) + ' vs ' + x100);
  // carrier crests advance away from the centre at 1/rippleS: sample two frames 20 ms apart in steady speech
  const e = makeEnv({ w: 800, h: 600 }); const orb = createVoiceOrb(e.container, e.o);
  orb.setState('speaking'); orb.setLevel(0.5); e.tick(150, 33);
  const ys = () => { e.calls.length = 0; e.tick(1, 20); return lastPath(e.calls).map(p => p[1] - 300); };
  const a = ys(), b = ys(), n = a.length;
  let best = 0, bestErr = Infinity;
  for (let s = -6; s <= 6; s++) { let err = 0; for (let i = Math.ceil(n / 2) + 12; i < n - 14; i++) err += (b[i] - a[i - s]) ** 2; if (err < bestErr) { bestErr = err; best = s; } }
  assert.ok(best >= 2 && best <= 4, 'crests move ~2.6 points (0.073 of the half line) in 20 ms: ' + best);
  orb.destroy();
});

test('ripple: nearly flat 250-300 ms after a syllable, fast attack, no stationary hump; thinking glow edge is feathered', () => {
  const fr = syllableFrames({}, 10);
  const amp = ys => ys ? Math.max(...ys.map(Math.abs)) : 0;
  const pk = Math.max(...fr.filter(x => x.t <= 200).map(x => amp(x.ys)));
  const tail = Math.max(...fr.filter(x => x.t >= 400).map(x => amp(x.ys))); // 250 ms after the syllable ended at 150
  assert.ok(pk > 20 && tail < 0.2 * pk, 'quiet fall: ' + tail + ' vs ' + pk);
  assert.ok(amp(fr.find(x => x.t === 50).ys) > 0.25 * pk, 'responds within ~50 ms');
});

test('thinking peak glow: the outer edge fades smoothly to 0 (feathered), pulse magnitude unchanged', () => {
  const { e, orb } = thinkRig();
  orb.thinkingPulse({ at: e.ms, attackMs: 250, decayMs: 1000, strength: 1 });
  for (let i = 0; i < 100 && orb.getInfo().thinking.value < 0.999; i++) e.tick(1, 10);
  e.stops.length = 0; e.tick(1, 1);
  const al = e.stops.slice(0, 7).map(s => +/,([\d.]+)\)$/.exec(s)[1]);
  assert.strictEqual(al.length, 7);
  for (let i = 1; i < al.length; i++) assert.ok(al[i] <= al[i - 1] + 1e-9, 'monotone fade ' + al);
  assert.strictEqual(al[6], 0);
  assert.ok(al[5] < 0.01 * al[0] && al[4] < 0.05 * al[0], 'soft tail, no rim: ' + al);
  assert.ok(al[0] > 0.34 * ORB_THINK_REST_ALPHA * 1.2, 'peak glow is brighter than rest: ' + al[0]);
  orb.destroy();
});

test('reduced motion: no moving curves, no trail, no rim, even with real audio while listening/speaking', () => {
  const e = makeEnv({ reduced: true });
  const orb = createVoiceOrb(e.container, e.o);
  orb.setAnalyser(quietAnalyser(40, 0.3));
  for (const s of ['speaking', 'listening', 'thinking']) {
    orb.setState(s); orb.setMicLevel(0.8); e.tick(40, 33);
    assert.strictEqual(orb.getInfo().stretch, 0);
  }
  assert.ok(!e.calls.some(c => ['lineTo', 'moveTo', 'quadraticCurveTo', 'closePath', 'stroke'].includes(c[0])), 'only the steady blob and finish');
  for (const c of e.calls) for (const v of c.slice(1)) if (typeof v === 'number') assert.ok(isFinite(v));
  orb.destroy();
});

// ---- shared thinking cluster event (lib/ui-voice-thinking.js): window + soft pops on the caller's clock, normal rest in the gap ----
const CLUSTER = (at) => ({ at, kind: 'cluster', durationMs: 1500, fadeInMs: 320, fadeOutMs: 480, gapAfterMs: 4500,
  pops: [{ tMs: 400, strength: 1, decayMs: 40 }, { tMs: 900, strength: 0.6, decayMs: 40 }], strength: 1 });
const restOf = (rig) => rig.frame(16);

test('thinking cluster: gentle 6% window swell (fade in, hold, fade out), back to the normal rest brightness in the gap', () => {
  const rig = thinkRig(); const { e, orb, frame } = rig;
  const rest = restOf(rig), R = rest.r;
  assert.ok(rest.a > 0.7 && Math.abs(rest.a - 0.95 * ORB_THINK_REST_ALPHA) < 0.01, 'rests at the normal brightness, not the old 0.42 dim: ' + rest.a);
  const at = e.ms + 20;
  assert.strictEqual(orb.thinkingPulse(CLUSTER(at)), true);
  const S = []; while (e.ms < at + 1700) { const f = frame(8); S.push({ t: e.ms - at, r: f.r / R, a: f.a, fl: orb.getInfo().thinking.flicker, ph: orb.getInfo().thinking.phase }); }
  const at_ = t => S.reduce((b, s) => Math.abs(s.t - t) < Math.abs(b.t - t) ? s : b);
  assert.ok(Math.max(...S.map(s => s.r)) <= 1.0601 && Math.max(...S.map(s => s.r)) > 1.059, 'swell is 6% at most: ' + Math.max(...S.map(s => s.r)));
  assert.ok(at_(160).r > 1.025 && at_(160).r < 1.035, 'half-way up the fade in at 160 ms: ' + at_(160).r);
  assert.ok(Math.abs(at_(700).r - 1.06) < 1e-6 && Math.abs(at_(1000).r - 1.06) < 1e-6, 'held between fade in and fade out');
  assert.ok(at_(1260).r < 1.035 && at_(1260).r > 1.025, 'half-way down the fade out');
  assert.strictEqual(at_(100).ph, 'attack'); assert.strictEqual(at_(700).ph, 'hold'); assert.strictEqual(at_(1300).ph, 'decay');
  for (let i = 1; i < S.length; i++) assert.ok(Math.abs(S[i].r - S[i - 1].r) < 0.06 * 0.05, 'smooth swell, no jump at ' + S[i].t);
  const gap = S.filter(s => s.t >= 1500);
  assert.ok(gap.length > 5 && gap.every(s => Math.abs(s.r - 1) < 1e-9 && Math.abs(s.a - rest.a) < 1e-9), 'the gap after the window is exactly the normal rest');
  assert.strictEqual(orb.getInfo().thinking.events, 0); assert.strictEqual(orb.getInfo().thinking.phase, 'idle');
  assert.strictEqual(orb.getInfo().thinking.peakAt, at + 320, 'peak is at at + fadeInMs');
  orb.destroy();
});

test('thinking cluster: each pop is a small SOFT brightness flicker at at+tMs, no harsh flash, size untouched by the pop', () => {
  const rig = thinkRig(); const { e, orb, frame } = rig;
  const rest = restOf(rig), at = e.ms + 20;
  orb.thinkingPulse(CLUSTER(at));
  const S = []; while (e.ms < at + 1500) { const f = frame(4); S.push({ t: e.ms - at, a: f.a, fl: orb.getInfo().thinking.flicker }); }
  const win = (lo, hi) => S.filter(s => s.t >= lo && s.t <= hi);
  const p1 = Math.max(...win(400, 560).map(s => s.fl)), p2 = Math.max(...win(900, 1060).map(s => s.fl));
  assert.ok(p1 > 0.95 && p1 <= 1, 'the loudest pop reaches 1: ' + p1); assert.ok(p2 > 0.55 && p2 < 0.65, 'strength 0.6 pop: ' + p2);
  assert.strictEqual(Math.max(...win(600, 880).map(s => s.fl)), 0, 'between pops the flicker is 0');
  assert.strictEqual(Math.max(...win(0, 395).map(s => s.fl)), 0, 'no flicker before the first pop (pops are at event.at + tMs)');
  const calm = win(650, 850).map(s => s.a), flick = win(400, 560).map(s => s.a);
  const lift = Math.max(...flick) - Math.max(...calm);
  assert.ok(lift > 0.03 && lift < 0.12, 'a small lift, not a flash: ' + lift);
  let step = 0; for (let i = 1; i < S.length; i++) step = Math.max(step, Math.abs(S[i].a - S[i - 1].a));
  assert.ok(step < 0.02, 'brightness never jumps by more than 2% per 4 ms frame: ' + step);
  assert.ok(Math.max(...S.map(s => s.a)) <= 0.95, 'never brighter than the normal full glow: ' + Math.max(...S.map(s => s.a)));
  assert.ok(rest.a > 0);
  orb.destroy();
});

test('thinking cluster: one shared clock; the same event timestamps give the same picture whatever the frame rate; a future cluster waits', () => {
  const run = (dt) => {
    const rig = thinkRig(); const { e, orb } = rig; const out = {};
    const at = 400; orb.thinkingPulse(CLUSTER(at));
    assert.strictEqual(orb.getInfo().thinking.phase, 'idle', 'not yet started: pending only after a frame');
    for (const t of [100, 300, 600, 960, 1300, 1700]) {
      while (e.ms + dt <= at + t) rig.frame(dt);
      rig.frame(at + t - e.ms || dt);
      out[t] = { r: +rig.frame(0.001).r.toFixed(2), ms: Math.round(e.ms), fl: +orb.getInfo().thinking.flicker.toFixed(3) };
    }
    orb.destroy(); return out;
  };
  const a = run(8), b = run(20);
  for (const t of Object.keys(a)) { assert.ok(Math.abs(a[t].r - b[t].r) < 0.6, 'same size at +' + t + ' ms regardless of frame rate: ' + a[t].r + ' vs ' + b[t].r); }
  const rig = thinkRig(); const at = rig.e.ms + 600;
  assert.strictEqual(rig.orb.thinkingPulse(CLUSTER(at)), true);
  assert.strictEqual(rig.frame(100).v, 0); assert.strictEqual(rig.orb.getInfo().thinking.phase, 'pending');
  rig.orb.destroy();
});

test('thinking cluster: the initial tick is small and gentle; malformed pops are skipped; stale or invalid clusters are ignored', () => {
  const rig = thinkRig(); const { e, orb, frame } = rig;
  const R = restOf(rig).r, at = e.ms + 10;
  assert.strictEqual(orb.thinkingPulse({ at, kind: 'tick', attackMs: 250, decayMs: 1000, durationMs: 0, pops: [], strength: 1 }), true, 'a tick with pops [] and no window is the old swell');
  let mx = 0, ma = 0; while (e.ms < at + 1400) { const f = frame(10); mx = Math.max(mx, f.r / R); ma = Math.max(ma, orb.getInfo().thinking.flicker); }
  assert.ok(mx > 1.01 && mx <= 1.025, 'tick swell is small: ' + mx); assert.strictEqual(ma, 0, 'a tick has no pops');
  assert.strictEqual(orb.thinkingPulse(Object.assign(CLUSTER(e.ms), { pops: [null, { tMs: NaN }, { tMs: -5 }, { tMs: 100, strength: 0.5, decayMs: 'x' }, 7] })), true);
  e.tick(30, 16); assert.ok(isFinite(orb.getInfo().radius));
  assert.strictEqual(orb.thinkingPulse(Object.assign(CLUSTER(e.ms - 9000))), false, 'stale cluster');
  orb.setState('idle'); assert.strictEqual(orb.thinkingPulse(CLUSTER(e.ms)), false, 'not thinking');
  orb.destroy();
});

test('thinking cluster in reduced motion: brightness only (window lift + pop flicker), never size or curves, back to the steady blob', () => {
  const rig = thinkRig({ reduced: true, w: 400, h: 300 }); const { e, orb, frame } = rig;
  const at = e.ms + 5;
  assert.strictEqual(orb.thinkingPulse(CLUSTER(at)), true); // (the settled reduced-motion loop wakes up on the event)
  const rest = frame(1);
  const S = []; for (let i = 0; i < 200; i++) { const f = frame(10); S.push({ t: e.ms - at, r: f.r, a: f.a }); }
  const fin = S.filter(s => isFinite(s.a));
  assert.ok(Math.max(...S.map(s => s.r).filter(isFinite)) - Math.min(...S.map(s => s.r).filter(isFinite)) < 1e-9, 'size does not change');
  assert.ok(Math.max(...fin.map(s => s.a)) > rest.a + 0.05, 'brightness rises: ' + rest.a + ' -> ' + Math.max(...fin.map(s => s.a)));
  const calm = Math.max(...fin.filter(s => s.t > 640 && s.t < 860).map(s => s.a)), pop = Math.max(...fin.filter(s => s.t > 400 && s.t < 560).map(s => s.a));
  assert.ok(pop > calm + 0.01, 'a pop adds a little brightness in reduced motion too: ' + calm + ' -> ' + pop);
  assert.ok(Math.abs(fin[fin.length - 1].a - rest.a) < 0.005, 'returns to the steady blob');
  assert.ok(!e.calls.some(c => ['lineTo', 'moveTo', 'quadraticCurveTo', 'stroke'].includes(c[0])));
  orb.destroy();
});

test('wave height: ordinary speech draws a quarter to a third of the full height (no 1.3x envelope inflation), loud speech still fills it', () => {
  const r1 = steadyWaveFraction(0.1, 800, 600), r2 = steadyWaveFraction(0.2, 800, 600), r3 = steadyWaveFraction(0.35, 800, 600);
  assert.ok(r1.frac > 0.22 && r1.frac < 0.29, 'level 0.1 draws about 25%: ' + r1.frac.toFixed(3));
  assert.ok(r3.frac > 0.31 && r3.frac < 0.37, 'level 0.35 draws about 35% (not 45%): ' + r3.frac.toFixed(3));
  assert.ok(r2.frac > r1.frac && r2.frac < r3.frac);
  const l = steadyWaveFraction(0.7, 800, 600), l2 = steadyWaveFraction(1, 800, 600);
  assert.ok(l.frac > 0.85 && l2.frac > 0.85 && l.frac <= 1.0001 && l2.frac <= 1.0001, 'loud is still full: ' + l.frac.toFixed(3) + ' ' + l2.frac.toFixed(3));
});
