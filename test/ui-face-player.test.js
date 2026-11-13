'use strict';
// The character player (lib/ui-face-player.js): the beak maths against the written spec, clip selection and pose rules,
// the lifecycle (loading, swapping, fading, hidden, reduced motion, destroy) and the shared interface, with a fake DOM,
// a fake clock and a tiny synthetic pack generated here. No browser: these tests cannot prove how it looks or runs in one.
const { test } = require('node:test');
const assert = require('node:assert');
const FP = require('../lib/ui-face-player.js');
const { createFacePlayer, faceCreateSelector, faceCreateBeak, faceNormalizeManifest, faceRng, faceUrls } = FP;

// ── synthetic pack ──
function clip(name, state, extra) {
  return Object.assign({ name, state, weight: 2, dur: 4, track: false, rare: false, family: name.split('-')[0], startsFrom: 'A', endsOn: 'A', beakEnds: 'smile' }, extra || {});
}
function packClips() {
  return [
    clip('idle-a1', 'idle', { family: 'baton', dur: 5 }), clip('idle-a2', 'idle', { family: 'look', dur: 6 }),
    clip('idle-settle', 'idle', { family: 'settle', dur: 3, endsOn: 'B' }),
    clip('idle-rest', 'idle', { family: 'rest', startsFrom: 'B', endsOn: 'B' }),
    clip('idle-back', 'idle', { family: 'back', dur: 2, startsFrom: 'B' }),
    clip('listening-1', 'listening', { family: 'nod' }), clip('listening-2', 'listening', { family: 'tilt' }),
    clip('thinking-1', 'thinking'),
    clip('speaking-1', 'speaking', { track: true, beakEnds: 'closed' }), clip('speaking-2', 'speaking', { track: true, beakEnds: 'closed' }),
    clip('speaking-3', 'speaking', { track: true, beakEnds: 'closed' }), clip('speaking-4', 'speaking', { track: true, beakEnds: 'closed' }),
    clip('reaction-hello-1', 'reaction', { mood: 'hello', dur: 3 }), clip('reaction-delighted-1', 'reaction', { mood: 'delighted', dur: 3 }),
    clip('reaction-proud-2', 'reaction', { dur: 3 }),                       // no mood field: found through its name
    clip('reaction-goodbye-1', 'reaction', { mood: 'goodbye', dur: 3 }),
    clip('reaction-touched-1', 'reaction', { mood: 'touched', dur: 3 }),     // a mood outside the fixed list: tolerated
  ];
}
function packManifest(clips, extra) {
  return Object.assign({ version: 3, background: '#ffd6ab', clips: clips || packClips(),
    beak: { roi: [580, 296, 130, 136], centre: [646, 350], shapes: ['closed', 'slight', 'half', 'wide', 'oo'], smile: 'smile', blendFrames: 3 }, futureField: { x: 1 } }, extra || {});
}
function trackFor() { return { fps: 24, w: 1280, h: 720, box: [586, 300, 120, 100], frames: Array.from({ length: 24 }, (_, i) => [600 + i, 350 + i, 1 + i * 0.01, i, 1]), extra: 'ok' }; }

// ── fake world: clock, timers, rAF, DOM, fetch ──
function makeWorld(opts) {
  opts = opts || {};
  const manifest = opts.manifest || packManifest();
  const t = { now: 1000, timers: [], tid: 0, raf: [], rid: 0, videos: [], canvases: [], imgs: [], fetched: [], listeners: {}, hold: new Set(), fail: new Set(), ctxCalls: [], canvasWrites: 0, played: [], docL: {}, posterReqs: [] };
  const durOf = (url) => { const m = /\/web\/([^/]+)\.mp4$/.exec(url); const n = m && decodeURIComponent(m[1]); const c = manifest.clips.find(x => x.name === n); return c ? c.dur : 4; };
  const nameOf = (url) => { const m = /\/web\/([^/]+)\.mp4$/.exec(url); return m && decodeURIComponent(m[1]); };
  const setTimeoutF = (fn, ms, tag) => { const id = ++t.tid; t.timers.push({ id, at: t.now + (ms || 0), fn, tag: !!tag }); return id; };   // tag: the fake network, not the player's
  const clearTimeoutF = (id) => { t.timers = t.timers.filter(x => x.id !== id); };
  t.advance = (ms) => {
    const target = t.now + ms;
    for (;;) {
      const due = t.timers.filter(x => x.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      t.timers = t.timers.filter(x => x !== due); t.now = Math.max(t.now, due.at); due.fn();
    }
    t.now = target;
  };
  t.settle = async (ms) => { for (let i = 0; i < 12; i++) { await new Promise(r => setImmediate(r)); t.advance((ms || 600) / 12); } };
  const mkEl = (tag) => {
    const L = {};
    const el = { tag, style: {}, attrs: {}, children: [], parentNode: null, listeners: L,
      setAttribute(k, v) { el.attrs[k] = v; }, removeAttribute(k) { delete el.attrs[k]; if (k === 'src') el._src = ''; },
      appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
      removeChild(c) { el.children = el.children.filter(x => x !== c); c.parentNode = null; },
      addEventListener(e, f) { (L[e] = L[e] || []).push(f); }, removeEventListener(e, f) { L[e] = (L[e] || []).filter(x => x !== f); },
      fire(e) { (L[e] || []).slice().forEach(f => f({ type: e })); } };
    return el;
  };
  const mkVideo = () => {
    const v = mkEl('video'); let id = 0;
    Object.assign(v, { readyState: 0, paused: true, currentTime: 0, duration: NaN, playbackRate: 1, _rvfc: null, plays: 0, pauses: 0, loads: 0 });
    Object.defineProperty(v, 'src', { get() { return v._src || ''; }, set(u) {
      v._src = u; v.readyState = 0; v.duration = NaN; v.clipName = nameOf(u); v.videoWidth = 0; v.videoHeight = 0;   // a new source has no decoded size yet (as in a browser)
      if (t.hold.has(v.clipName)) return;
      setTimeoutF(() => { if (v._src !== u) return; if (t.fail.has(v.clipName)) { v.currentSrc = u; v.fire('error'); return; } v.currentSrc = u; v.readyState = 4; v.duration = durOf(u);
        if (opts.videoSize !== false) { v.videoWidth = 1280; v.videoHeight = 720; }   // the decoded frame size: real once the data is there (videoSize:false = a browser that reports none)
        v.fire('loadeddata'); }, 10, true);
    } });
    v.load = () => { v.loads++; };
    v.videoWidth = 0; v.videoHeight = 0;
    v.play = () => { v.paused = false; v.plays++; t.played.push(v.clipName); if (!t.noPlaying) setTimeoutF(() => { if (!v.paused) v.fire('playing'); }, 20, true); return Promise.resolve(); };
    v.pause = () => { v.paused = true; v.pauses++; };
    v.requestVideoFrameCallback = (cb) => { v._rvfc = cb; return ++id; };
    v.cancelVideoFrameCallback = () => { v._rvfc = null; };
    v.frame = (mediaTime, now) => { const cb = v._rvfc; v._rvfc = null; if (cb) cb(now == null ? t.now : now, { mediaTime }); return !!cb; };
    v.end = () => { v.fire('ended'); };
    return v;
  };
  const gradCtx = (log) => { let last = null, lastA = [], style = null; return new Proxy({}, {
    get(_, k) {
      if (k === 'getImageData') return (gx, gy, sw, sh) => {
        if (opts.posterEdge && sh === 1 && last && last.tag === 'canvas') {   // an edge-row read of the painted poster canvas: N columns of the top (source y 0) or bottom strip
          const d = new Uint8ClampedArray(sw * 4), f = lastA[2] === 0 ? opts.posterEdge.top : opts.posterEdge.bottom;
          for (let i = 0; i < sw; i++) { const c = f((i + 0.5) / sw); d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255; }
          t.edgeReads = (t.edgeReads || 0) + 1; return { data: d };
        }
        const d = new Uint8ClampedArray(32 * 18 * 4).fill(100);
        const rg = opts.posterRing;   // [r, g, b]: a poster image whose outer two pixels are this colour and whose inside is pure green (only the ring may be sampled)
        if (rg && last && last.tag === 'img') for (let y = 0; y < 18; y++) for (let x = 0; x < 32; x++) {
          const ring = !(x > 1 && x < 30 && y > 1 && y < 16), i = (y * 32 + x) * 4, c = ring ? rg : [0, 255, 0];
          d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
        }
        return { data: d };
      };
      if (k === 'createLinearGradient') return (...a) => { const g = { a, stops: [], addColorStop(o, c) { g.stops.push([o, c]); } }; return g; };
      return (...a) => { if (k === 'drawImage') { last = a[0]; lastA = a; } if (k === 'fillRect' && log) log.fills.push({ style, rect: a }); if (k === 'clearRect' && log) log.fills.length = 0; t.ctxCalls.push([k, ...a]); };
    },
    set(_, k, v) { if (k === 'fillStyle') style = v; t.ctxCalls.push([k, v]); return true; },
  }); };
  const doc = { hidden: false, visibilityState: 'visible',
    createElement(tag) {
      if (tag === 'video') { const v = mkVideo(); t.videos.push(v); return v; }
      if (tag === 'canvas') {
        const c = mkEl('canvas'); let w = 0, h = 0; c.log = { fills: [] }; const cx = gradCtx(c.log);
        Object.defineProperty(c, 'width', { get: () => w, set: (v) => { w = v; t.canvasWrites++; } });
        Object.defineProperty(c, 'height', { get: () => h, set: (v) => { h = v; } });
        c.getContext = () => cx; t.canvases.push(c); return c;
      }
      if (tag === 'img') {
        const im = mkEl('img'); im.complete = true;
        Object.defineProperty(im, 'src', { get: () => im._s, set: (u) => {
          im._s = u; const n = (/\/beak\/([^/]+)\.png$/.exec(u) || [])[1];
          if (n === undefined && /\.(png|jpe?g|webp)$/.test(u)) {   // a poster image (anything under the pack that is not a beak patch)
            t.posterReqs.push(u); const pf = opts.posterFail, ph = opts.posterHold;
            if (ph) return;
            setTimeoutF(() => { if (pf === 'error') { if (im.onerror) im.onerror(); return; } im.naturalWidth = pf === 'empty' ? 0 : 1920; im.naturalHeight = pf === 'empty' ? 0 : 1080; if (im.onload) im.onload(); }, 5, true);
            return;
          }
          if (opts.imgHold && opts.imgHold.has(n)) return;
          setTimeoutF(() => { if (opts.imgFail && opts.imgFail.has(n)) { if (im.onerror) im.onerror(); } else if (im.onload) im.onload(); }, 5, true);
        } });
        t.imgs.push(im); return im;
      }
      return mkEl(tag);
    },
    addEventListener(e, f) { (t.docL[e] = t.docL[e] || []).push(f); }, removeEventListener(e, f) { t.docL[e] = (t.docL[e] || []).filter(x => x !== f); } };
  const win = { devicePixelRatio: opts.dpr || 1, matchMedia: () => ({ matches: !!opts.sysReduced, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} };
  const container = Object.assign(mkEl('div'), { clientWidth: opts.w || 800, clientHeight: opts.h || 450 });
  t.fetch = async (url) => {
    t.fetched.push(url);
    if (opts.fetchFail && opts.fetchFail(url)) return { ok: false, status: 404 };
    if (/manifest\.json$/.test(url)) return { ok: true, json: async () => manifest };
    if (/\/tracks\//.test(url)) return { ok: true, json: async () => trackFor() };
    if (/\/web\//.test(url)) return { ok: true, arrayBuffer: async () => new ArrayBuffer(10) };
    return { ok: false, status: 404 };
  };
  t.doc = doc; t.win = win; t.container = container; t.manifest = manifest;
  t.hide = (h) => { doc.hidden = h; doc.visibilityState = h ? 'hidden' : 'visible'; (t.docL.visibilitychange || []).slice().forEach(f => f()); };
  t.make = (o) => {
    const p = createFacePlayer(container, Object.assign({ packId: 'owl', fetch: t.fetch, document: doc, window: win, now: () => t.now, setTimeout: setTimeoutF, clearTimeout: clearTimeoutF,
      raf: (cb) => { const id = ++t.rid; t.raf.push({ id, cb }); return id; }, caf: (id) => { t.raf = t.raf.filter(x => x.id !== id); }, seed: 7 }, o || {}));
    const orig = p.ready; let done = false;   // the fake clock only moves when pumped: pump it while readiness is awaited
    p.ready = new Promise((res, rej) => { orig.then(v => { done = true; res(v); }, e => { done = true; rej(e); }); });
    p.ready.catch(() => {});
    (async () => { for (let i = 0; i < 400 && !done; i++) { await new Promise(r => setImmediate(r)); t.advance(10); } })();
    return p;
  };
  t.tickRaf = (ms) => { const q = t.raf; t.raf = []; t.now += ms || 16; q.forEach(x => x.cb(t.now)); };
  t.front = (p) => { const info = p.getInfo(); return t.videos[info.front]; };
  t.lastDraw = () => { const c = t.ctxCalls.filter(x => x[0] === 'drawImage').pop(); return c; };
  return t;
}
async function started(o, wo) { const w = makeWorld(wo); const p = w.make(o); await p.ready; await w.settle(100); return { w, p }; }

// ── the beak: spec re-coded independently, then compared frame by frame ──
function analyserOf(st) {
  return { context: { sampleRate: 48000 }, fftSize: 2048, frequencyBinCount: 1024,
    getFloatTimeDomainData(b) { b.fill(st.amp); },
    getFloatFrequencyData(b) { b.fill(-140); const bin = Math.round(st.hz / (48000 / 2048)); b[bin] = 0; } };
}
function refShapes(frames) {   // PACK-FORMAT.md "Beak shape from the voice", re-coded
  let fast = 0, valley = 0, peak = 0.05, cur = 'closed', since = 0, last = 0; const out = [];
  for (const [now, r, cent] of frames) {
    const dt = Math.min(0.1, Math.max(0.001, (now - (last || now)) / 1000)); last = now;
    const k = Math.exp(-dt / 0.05);
    fast = r > fast ? r : fast * k + r * (1 - k);
    valley = fast < valley ? fast : valley + (fast - valley) * (1 - Math.exp(-dt / 0.25));
    peak = Math.max(fast, peak * Math.exp(-dt / 2.0), 0.02);
    const o = r < 0.005 ? 0 : (fast - valley) / Math.max(peak - valley, 0.02);
    let want = o < 0.18 ? 'closed' : o < 0.40 ? 'slight' : o < 0.78 ? (cent < 750 ? 'oo' : 'half') : 'wide';
    if (want !== cur && now - since < 80 && !(want === 'closed' && r < 0.005 && now - since >= 70)) want = cur;
    if (want !== cur) { cur = want; since = now; }
    out.push(cur);
  }
  return out;
}
test('beak: same shapes as the written rules over a long varied voice, all five shapes occur', () => {
  const st = { amp: 0, hz: 300 }, an = analyserOf(st), b = faceCreateBeak();
  const frames = []; const got = [];
  for (let i = 0; i < 600; i++) {
    const now = 5000 + i * 16.7;
    const syl = Math.abs(Math.sin(i / 5.5)) * (0.12 + 0.1 * Math.sin(i / 37));     // syllable bumps on a slow swell
    const r = i % 97 > 88 ? 0 : syl;                                                // and some real silences
    const cent = (i % 150) < 60 ? 400 : 1500;                                       // dark vowels, then bright ones
    st.amp = r; st.hz = cent; frames.push([now, r, cent]); got.push(b.fromAnalyser(an, now, 48000));
  }
  assert.deepStrictEqual(got, refShapes(frames));
  for (const s of ['closed', 'slight', 'half', 'wide', 'oo']) assert.ok(got.includes(s), 'shape ' + s + ' occurs');
});
test('beak: the byte fallback converts with the analyser min/max decibels and reuses its buffers; the float maths is untouched', () => {
  const st = { amp: 0, hz: 300 }, bins = 1024, hzOf = 48000 / 2048, LO = -90, HI = -10;
  const fl = analyserOf(st); fl.getFloatFrequencyData = b => { b.fill(LO); b[Math.round(st.hz / hzOf)] = HI; };
  const seenT = new Set(), seenF = new Set();
  const by = { context: { sampleRate: 48000 }, fftSize: 2048, frequencyBinCount: bins, minDecibels: LO, maxDecibels: HI,
    getFloatTimeDomainData(b) { b.fill(st.amp); }, getByteFrequencyData(b) { seenF.add(b); b.fill(0); b[Math.round(st.hz / hzOf)] = 255; } };
  const bt = { context: { sampleRate: 48000 }, fftSize: 2048, frequencyBinCount: bins, getByteTimeDomainData(b) { seenT.add(b); b.fill(Math.round(128 + st.amp * 127)); }, getByteFrequencyData(b) { b.fill(0); } };
  const A = faceCreateBeak(), B = faceCreateBeak(), C = faceCreateBeak(); const ga = [], gb = [];
  for (let i = 0; i < 600; i++) {
    const now = 5000 + i * 16.7, syl = Math.abs(Math.sin(i / 5.5)) * (0.12 + 0.1 * Math.sin(i / 37)); st.amp = i % 97 > 88 ? 0 : syl; st.hz = (i % 150) < 60 ? 400 : 1500;
    ga.push(A.fromAnalyser(fl, now, 48000)); gb.push(B.fromAnalyser(by, now, 48000)); C.fromAnalyser(bt, now, 48000);
  }
  assert.deepStrictEqual(gb, ga, 'a byte spectrum from min/max decibels gives the float result'); assert.ok(gb.includes('oo') && gb.includes('wide'));
  assert.strictEqual(seenT.size, 1, 'one time-domain byte buffer for all frames'); assert.strictEqual(seenF.size, 1, 'one frequency byte buffer for all frames');
});
test('beak: 80 ms hold, silence closes after 70 ms, close() is immediate and resets the trackers', () => {
  const st = { amp: 0.2, hz: 1500 }, an = analyserOf(st), b = faceCreateBeak();
  assert.strictEqual(b.fromAnalyser(an, 1000, 48000), 'wide');
  st.amp = 0; assert.strictEqual(b.fromAnalyser(an, 1016, 48000), 'wide');       // held
  assert.strictEqual(b.fromAnalyser(an, 1069, 48000), 'wide');
  assert.strictEqual(b.fromAnalyser(an, 1070, 48000), 'closed');                  // silence may close after 70 ms
  st.amp = 0.2; assert.strictEqual(b.fromAnalyser(an, 1075, 48000), 'closed');   // and now holds closed for 80 ms
  assert.strictEqual(b.fromAnalyser(an, 1160, 48000), 'wide');
  assert.strictEqual(b.close(), 'closed'); assert.strictEqual(b.env.fast, 0); assert.strictEqual(b.env.valley, 0);
});

// ── selection ──
const mk = (n, o) => clip(n, 'idle', o);
function sel(clips, seed, now) { const t = { v: now || 0 }; const s = faceCreateSelector(clips, { random: faceRng(seed), now: () => t.v }); s.t = t; return s; }
function play(s, st, n, opt) { const out = []; for (let i = 0; i < n; i++) { const p = s.pick(st, opt); if (!p) { out.push(null); continue; } s.commit(p); out.push(p); s.t.v += (p.clip.dur || 4) * 1000; } return out; }

test('selection: a single pose-compatible clip may repeat at once, two clips never repeat back to back', () => {
  const one = sel([mk('a')], 1); assert.deepStrictEqual(play(one, 'idle', 4).map(p => p.clip.name), ['a', 'a', 'a', 'a']);
  const two = sel([mk('a', { family: 'x' }), mk('b', { family: 'y' })], 2);
  const names = play(two, 'idle', 40).map(p => p.clip.name);
  for (let i = 1; i < names.length; i++) assert.notStrictEqual(names[i], names[i - 1]);
});
test('selection: never the same family twice in a row while another family exists; the 12-clip memory holds', () => {
  const clips = []; for (let i = 0; i < 20; i++) clips.push(mk('c' + i, { family: 'f' + (i % 4) }));
  const s = sel(clips, 3), names = play(s, 'idle', 120).map(p => p.clip);
  for (let i = 1; i < names.length; i++) assert.notStrictEqual(names[i].family, names[i - 1].family);
  for (let i = 12; i < names.length; i++) assert.ok(!names.slice(i - 12, i).some(c => c.name === names[i].name), 'not within the last 12 at ' + i);
});
test('selection: no repeat until 70 percent of the state has played (pool smaller than the 12-clip memory)', () => {
  const clips = []; for (let i = 0; i < 10; i++) clips.push(mk('c' + i, { family: 'f' + i }));
  const names = play(sel(clips, 4), 'idle', 100).map(p => p.clip.name);
  for (let i = 7; i < names.length; i++) assert.ok(!names.slice(i - 7, i).includes(names[i]), 'within the last 7 at ' + i);
});
test('selection: choice is weighted and deterministic for a seed', () => {
  const clips = [mk('heavy', { weight: 9, family: 'a' }), mk('light', { weight: 1, family: 'b' }), mk('other', { weight: 1, family: 'c' })];
  const run = seed => play(sel(clips, seed), 'idle', 3).map(p => p.clip.name).join();
  assert.strictEqual(run(11), run(11));
  const s = sel(clips, 12); let heavy = 0; for (let i = 0; i < 300; i++) { s.state.recent.length = 0; s.state.hist = {}; s.state.current = null; if (s.pick('idle').clip.name === 'heavy') heavy++; }
  assert.ok(heavy > 200 && heavy < 290, 'heavy picked ' + heavy + ' of 300');
});
test('selection: rare clips only in idle/listening, 5 percent, at most once per 3 minutes', () => {
  const clips = [mk('r', { rare: true, family: 'r' }), mk('r2', { rare: true, family: 'r2' }), clip('l1', 'listening', { family: 'l' }), clip('lr', 'listening', { rare: true, family: 'lr' }), clip('s1', 'speaking', { family: 's' }), clip('s2', 'speaking', { family: 's2' }), clip('s3', 'speaking', { family: 's3' }), clip('s4', 'speaking', { family: 's4' }), clip('sr', 'speaking', { rare: true, family: 'sr' })];
  for (let i = 0; i < 20; i++) clips.push(mk('p' + i, { family: 'pf' + i }));   // a big plain pool, so the memories do not run dry
  for (let i = 0; i < 16; i++) clips.push(clip('sp' + i, 'speaking', { family: 'spf' + i }));
  let n = 0; const times = [];
  const s = faceCreateSelector(clips, { random: () => 0.01, now: () => n });   // always inside the 5 percent
  for (let i = 0; i < 80; i++) { const p = s.pick('idle'); s.commit(p); if (p.clip.rare) times.push(n); n += 20000; }
  assert.ok(times.length >= 3);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 180000);
  const sp = faceCreateSelector(clips, { random: () => 0.01, now: () => 0 }); let sawRare = false;
  for (let i = 0; i < 30; i++) { const p = sp.pick('speaking'); sp.commit(p); if (p.clip.rare) sawRare = true; }
  assert.ok(!sawRare, 'no rare speaking clip while a plain one exists');
});
test('selection: exhaustion relaxes the rare cooldown first, then the memories; it never returns nothing while a clip exists', () => {
  const s = faceCreateSelector([mk('p', { family: 'a' }), mk('r', { rare: true, family: 'b' })], { random: () => 0.9, now: () => 100 });
  s.state.lastRareAt = 90;                                  // cooldown running
  s.commit({ clip: s.pick('idle').clip, hkey: 'idle' });    // plain p (the rare one is held back)
  assert.strictEqual(s.state.current.name, 'p');
  const p2 = s.pick('idle'); assert.strictEqual(p2.clip.name, 'r', 'only the rare cooldown had to give way (p is the clip just played)');
  const clips = [mk('a', { family: 'x' }), mk('b', { family: 'x' }), mk('c', { family: 'x' })];   // one family only: the family rule gives way last
  const f = sel(clips, 5), names = play(f, 'idle', 30).map(p => p && p.clip.name);
  assert.ok(names.every(Boolean));
  for (let i = 1; i < names.length; i++) assert.notStrictEqual(names[i], names[i - 1]);
});
test('selection: pose A/B is never relaxed: back to the master pose first, then the wanted state', () => {
  const clips = [mk('settle', { endsOn: 'B', family: 'z' }), mk('back1', { startsFrom: 'B', dur: 2, family: 'b1' }), mk('back2', { startsFrom: 'B', dur: 9, family: 'b2' }), mk('back3', { startsFrom: 'B', dur: 8, family: 'b3' }),
    mk('rest', { startsFrom: 'B', endsOn: 'B', family: 'r' }), clip('listen', 'listening'), clip('speak', 'speaking', { track: true }), clip('react', 'reaction', { mood: 'proud' })];
  const s = faceCreateSelector(clips, { random: faceRng(1), now: () => 0 });
  s.state.pose = 'B';
  for (const st of ['listening', 'speaking', 'thinking']) {
    const p = s.pick(st); assert.ok(p, st);
    assert.strictEqual(p.clip.startsFrom, 'B', 'what plays from B starts from B (' + st + ')');
    assert.ok(p.clip.endsOn === 'A' || p.clip.name === 'rest');
  }
  const sp = s.pick('speaking'); assert.strictEqual(sp.kind, 'transition'); assert.ok(['back1', 'back3', 'back2'].includes(sp.clip.name) && sp.clip.dur <= 8, 'a short way back');
  const rp = s.pick('idle', { react: [clips[7]] }); assert.strictEqual(rp.kind, 'transition', 'a reaction from B waits for the way back too');
  s.commit(sp);
  assert.strictEqual(s.state.pose, 'A');
  assert.strictEqual(s.pick('speaking').clip.name, 'speak');
  assert.strictEqual(s.pick('idle', { react: [clips[7]] }).kind, 'reaction');
});
test('selection: a state whose clips all begin on B reaches them through the way back, and rests use B-to-B clips', () => {
  const clips = [clip('only-listen', 'listening', { startsFrom: 'B', endsOn: 'B' }), clip('up', 'idle', { startsFrom: 'A', endsOn: 'B' }), clip('down', 'idle', { startsFrom: 'B', endsOn: 'A' }), mk('i1')];
  const s = faceCreateSelector(clips, { random: faceRng(2), now: () => 0 });
  const p = s.pick('listening'); assert.strictEqual(p.kind, 'transition'); assert.strictEqual(p.clip.name, 'up');   // from A the only way is the settle clip
  s.commit(p); assert.strictEqual(s.state.pose, 'B');
  const q = s.pick('listening'); assert.strictEqual(q.clip.name, 'only-listen'); assert.strictEqual(q.kind, 'state');
});
test('selection: a missing state falls back to idle; nothing playable returns null (hold the last picture)', () => {
  const s = faceCreateSelector([mk('i1'), clip('r', 'reaction', { mood: 'proud' })], { random: faceRng(3), now: () => 0 });
  const p = s.pick('thinking'); assert.strictEqual(p.clip.name, 'i1'); assert.strictEqual(p.kind, 'fallback');
  const none = faceCreateSelector([clip('r', 'reaction')], { random: faceRng(3), now: () => 0 });
  assert.strictEqual(none.pick('idle'), null);
  const bad = faceCreateSelector([mk('a'), mk('b')], { random: faceRng(3), now: () => 0, ok: c => c.name === 'b' });
  assert.strictEqual(bad.pick('idle').clip.name, 'b');
});
test('selection: idle pose changes after the hold: settle, rest with B-to-B, return with B-to-A', () => {
  const clips = [mk('a1', { family: 'a' }), mk('a2', { family: 'b' }), mk('settle', { endsOn: 'B', family: 's' }), mk('rest1', { startsFrom: 'B', endsOn: 'B', family: 'r1' }), mk('rest2', { startsFrom: 'B', endsOn: 'B', family: 'r2' }), mk('up', { startsFrom: 'B', family: 'u' })];
  const s = faceCreateSelector(clips, { random: () => 0.3, now: () => 0 });   // 0.3 < 0.5: the settle is taken once the hold has passed
  s.t = 0; const nowRef = { v: 0 }; const s2 = faceCreateSelector(clips, { random: () => 0.3, now: () => nowRef.v });
  assert.ok(['a1', 'a2'].includes(s2.pick('idle').clip.name));
  nowRef.v = 95000; const set = s2.pick('idle'); assert.strictEqual(set.kind, 'settle'); s2.commit(set);
  assert.ok(['rest1', 'rest2'].includes(s2.pick('idle').clip.name));
  nowRef.v += 61000; const back = s2.pick('idle'); assert.strictEqual(back.clip.name, 'up'); assert.strictEqual(back.kind, 'transition');
});

// ── manifest, urls, readiness ──
test('urls: every request is /api/faces/<encoded id>/<known file>; hostile names and ids never reach the network', async () => {
  const u = faceUrls('my pack'); assert.strictEqual(u.manifest(), '/api/faces/my%20pack/manifest.json');
  assert.strictEqual(u.clip('a b'), '/api/faces/my%20pack/web/a%20b.mp4');
  const w = makeWorld({ manifest: packManifest(packClips().concat([clip('../../etc/passwd', 'idle'), clip('x/y', 'idle'), clip('bad name', 'idle'), clip('', 'idle')])) });
  const p = w.make({ packId: 'owl' }); await p.ready; await w.settle(2000);
  assert.ok(w.fetched.length > 3);
  for (const url of w.fetched) assert.match(url, /^\/api\/faces\/owl\/(manifest\.json|web\/[A-Za-z0-9][A-Za-z0-9._-]*\.mp4|tracks\/[A-Za-z0-9][A-Za-z0-9._-]*\.json)$/);
  for (const v of w.videos) assert.ok(!/passwd|\.\.|x%2Fy/.test(v.src));
  const names = faceNormalizeManifest(w.manifest).clips.map(c => c.name); assert.ok(!names.some(n => /[/ ]/.test(n)) && names.length === packClips().length);
  const evil = w.make({ packId: '../x' }); await assert.rejects(evil.ready, /invalid pack id/);
  const evil2 = w.make({ packId: 'a/b' }); await assert.rejects(evil2.ready);
  assert.ok(w.fetched.every(x => !x.includes('..')));
  p.destroy();
});
test('readiness: needs only the manifest, the beak patches and the first speaking tracks; the rest follows in the background, bounded', async () => {
  const w = makeWorld(); const p = w.make({ warmLimit: 5 });
  const r = await p.ready; assert.strictEqual(r, p);
  assert.ok(p.getInfo().ready); assert.ok(p.getInfo().tracks <= 2, 'only the first tracks gated readiness');
  assert.ok(w.videos[0].src || w.videos[1].src, 'the first clip is already loading');
  await w.settle(3000);
  assert.strictEqual(p.getInfo().tracks, 4, 'the other tracks arrive after');
  const warm = w.fetched.filter(x => /\/web\//.test(x));
  assert.ok(warm.length <= 5, 'warm cache is bounded: ' + warm.length);
  p.destroy();
});
test('background cache: the default now covers a big pack (300 clips / 100 MiB), two at a time, low priority, nothing kept', async () => {
  const clips = packClips(); for (let i = 0; i < 90; i++) clips.push(clip('extra-' + i, 'idle', { family: 'f' + i }));
  const w = makeWorld({ manifest: packManifest(clips) }); let act = 0, maxAct = 0; const inits = [];
  const inner = w.fetch; w.fetch = async (url, init) => { if (!/\/web\//.test(url)) return inner(url, init); inits.push(init); act++; maxAct = Math.max(maxAct, act); await new Promise(r => setImmediate(r)); act--; return inner(url, init); };
  const p = w.make({ fetch: w.fetch, warmConcurrency: 9 }); await p.ready; for (let i = 0; i < 15; i++) await w.settle(10000);
  const warm = new Set(w.fetched.filter(x => /\/web\//.test(x))); assert.ok(warm.size >= clips.length - 3, 'the rest was fetched too: ' + warm.size + ' of ' + clips.length);
  assert.ok(maxAct <= 2, 'at most two at once: ' + maxAct); assert.ok(inits.filter(i => i.priority === 'low').length > 60, 'the bulk is low priority');
  assert.ok(w.timers.filter(x => !x.tag).length <= 6, 'no pile of pending timers: ' + w.timers.length);
  const w2 = makeWorld({ manifest: packManifest(clips) }); const p2 = w2.make({ warmLimit: 7 }); await p2.ready; for (let i = 0; i < 5; i++) await w2.settle(10000);
  assert.ok(new Set(w2.fetched.filter(x => /\/web\//.test(x))).size <= 7, 'an explicit limit still holds');
  p.destroy(); p2.destroy();
});
test('readiness: a pack that cannot be read rejects ready, the player stays harmless; extra manifest fields are tolerated', async () => {
  const w = makeWorld({ fetchFail: () => true }); const p = w.make(); await assert.rejects(p.ready);
  assert.strictEqual(p.setState('listening'), true); assert.strictEqual(p.react('delighted'), false); p.speechEvent('start'); p.setAnalyser(null); p.destroy();
  const w2 = makeWorld({ manifest: { clips: [], beak: {} } }); const p2 = w2.make(); await assert.rejects(p2.ready, /unusable/); p2.destroy();
  const w3 = makeWorld({ manifest: Object.assign(packManifest(), { brandNew: [1, 2], clips: packClips().map(c => Object.assign({ newField: 1 }, c)) }) });
  const p3 = w3.make(); await p3.ready; await w3.settle(100); assert.ok(p3.getInfo().clip); p3.destroy();
});
test('readiness: awaiting createFacePlayer does not wait (not a thenable), `ready` does; an injected manifest skips the manifest request', async () => {
  const w = makeWorld(); const p = await w.make({ manifest: w.manifest });
  assert.strictEqual(p.getInfo().ready, false, 'the bare await returned before the pack was ready'); assert.strictEqual(typeof p.then, 'undefined');
  await p.ready; assert.strictEqual(p.getInfo().ready, true); await w.settle(50);
  assert.ok(!w.fetched.some(u => /manifest/.test(u))); p.destroy();
});
test('readiness: a required beak patch (closed, any shape, the smile) that fails, a missing shape, or no loadable speaking track rejects ready', async () => {
  for (const bad of ['closed', 'oo', 'smile']) {
    const w = makeWorld({ imgFail: new Set([bad]) }); const p = w.make(); await assert.rejects(p.ready, new RegExp('beak patch.*' + bad)); await w.settle(300);
    assert.strictEqual(p.getInfo().ready, false); assert.strictEqual(w.played.length, 0, 'nothing plays without a complete beak'); assert.strictEqual(p.react('hello'), false); p.destroy();
  }
  const noOo = packManifest(); noOo.beak.shapes = ['closed', 'slight', 'half', 'wide'];
  const w2 = makeWorld({ manifest: noOo }); const p2 = w2.make(); await assert.rejects(p2.ready, /complete beak/); p2.destroy();
  const w3 = makeWorld({ fetchFail: u => /\/tracks\//.test(u) }); const p3 = w3.make(); await assert.rejects(p3.ready, /speaking track/); p3.destroy();
  const w4 = makeWorld({ fetchFail: u => /speaking-1\.json/.test(u) }); const p4 = w4.make(); await p4.ready; assert.ok(p4.getInfo().ready, 'one first track is enough'); p4.destroy();
  const calm = packManifest(packClips().filter(c => !c.track), { beak: undefined });   // no beak tracks: no beak is needed
  const w5 = makeWorld({ manifest: calm }); const p5 = w5.make(); await p5.ready; assert.ok(p5.getInfo().ready); p5.destroy();
});
test('readiness: image loads settle when the player is destroyed (ready does not hang) and their handlers are cleaned', async () => {
  const w = makeWorld({ imgHold: new Set(['wide', 'oo']) }); const p = w.make(); await w.settle(200);
  assert.ok(w.imgs.some(im => im.onload), 'two patches are still loading'); p.destroy();
  await Promise.race([p.ready, new Promise((_, rej) => setImmediate(() => rej(new Error('ready hung')))) ]);
  assert.ok(w.imgs.every(im => im.onload === null && im.onerror === null), 'no image handler outlives the player'); assert.strictEqual(w.played.length, 0);
  const w2 = makeWorld(); const p2 = w2.make(); await p2.ready; assert.ok(w2.imgs.every(im => im.onload === null), 'handlers are cleared after a load too'); p2.destroy();
});
test('names and ranges follow the server: lower-case 40-char slugs, 80-char names without dots, finite bounded numbers', async () => {
  const w = makeWorld();
  for (const id of ['Owl', 'a'.repeat(41), '-a', 'a-', 'a.b', 'a_b']) await assert.rejects(w.make({ packId: id }).ready, /invalid pack id/, id);
  const ok = w.make({ packId: 'a'.repeat(40) }); await ok.ready; ok.destroy();
  const names = faceNormalizeManifest({ clips: [clip('a.b', 'idle'), clip('a'.repeat(80), 'idle'), clip('b'.repeat(81), 'idle'), clip('ok_1-x', 'idle'), clip('sp', 'speaking', { track: false })] }).clips;
  assert.deepStrictEqual(names.map(c => c.name), ['a'.repeat(80), 'ok_1-x', 'sp']); assert.strictEqual(names[2].track, true, 'a speaking clip always has a track');
  const m = faceNormalizeManifest({ clips: [clip('w', 'idle', { weight: 1e9, dur: 1e9 }), clip('n', 'idle', { weight: Infinity, dur: -1 })] }).clips;
  assert.deepStrictEqual([m[0].weight, m[0].dur, m[1].weight, m[1].dur], [1, 5, 1, 5]);
  const b = (roi, centre) => faceNormalizeManifest({ clips: [clip('a', 'idle')], beak: { roi, centre, shapes: ['closed'] } }).beak;
  assert.ok(b([1, 2, 3, 4], [5, 6])); assert.strictEqual(b([1, 2, 0, 4], [5, 6]), null); assert.strictEqual(b([1, 2, 2000, 4], [5, 6]), null); assert.strictEqual(b([1e9, 2, 3, 4], [5, 6]), null); assert.strictEqual(b([1, 2, 3, 4], [5, NaN]), null);
  const T = (f, extra) => FP.faceNormalizeTrack(Object.assign({ w: 1280, h: 720, fps: 24, frames: [f] }, extra || {}));
  assert.ok(T([1, 2, 1, 0])); assert.strictEqual(T([1e9, 2, 1, 0]), null); assert.strictEqual(T([1, 2, 0, 0]), null); assert.strictEqual(T([1, 2, 99, 0]), null); assert.strictEqual(T([1, 2, 1, 5000]), null);
  assert.strictEqual(T([1, 2, 1, 0], { fps: 1e6 }).fps, 24); assert.strictEqual(T([1, 2, 1, 0], { w: 1e9 }).w, 1280);
});

// ── lifecycle ──
test('start: the first clip is idle, the pack background fills the view, only createElement and CSSOM were used', async () => {
  const { w, p } = await started();
  const info = p.getInfo(); assert.strictEqual(info.state, 'idle'); assert.match(info.clip, /^idle-/);
  const root = w.container.children[0]; assert.strictEqual(root.style.background, '#ffd6ab'); assert.strictEqual(root.attrs.role, 'img');
  assert.ok(!('style' in root.attrs), 'no style attribute (CSP)'); assert.ok(w.videos.every(v => v.attrs.playsinline !== undefined && v.muted === true));
  assert.strictEqual(w.front(p).style.opacity, '1'); assert.strictEqual(w.front(p).paused, false);
  p.destroy();
});
test('swap: a state change mid-clip cross-fades 250 ms into the other video; the old one is paused after the fade', async () => {
  const { w, p } = await started(); const a = w.front(p);
  assert.strictEqual(p.setState('listening'), true); await w.settle(100);
  const b = w.front(p); assert.notStrictEqual(a, b); assert.match(p.getInfo().clip, /^listening-/);
  assert.match(b.style.transition, /250ms/); assert.strictEqual(b.style.opacity, '1'); assert.strictEqual(b.style.zIndex, '2'); assert.strictEqual(a.style.zIndex, '1');
  assert.strictEqual(a.style.opacity, '1', 'the old clip still shows during the fade'); await w.settle(300);
  assert.strictEqual(a.style.opacity, '0'); assert.strictEqual(a.paused, true);
  assert.strictEqual(p.setState('bogus'), false); assert.strictEqual(p.setState('listening'), true);
  p.destroy();
});
test('swap: near the end of a clip the change waits for it (under 0.6 s left) instead of cross-fading', async () => {
  const { w, p } = await started(); const a = w.front(p); const c = p.getInfo().clip;
  a.currentTime = a.duration - 0.3; p.setState('listening'); await w.settle(100);
  assert.strictEqual(p.getInfo().clip, c); a.end(); await w.settle(100);
  assert.match(p.getInfo().clip, /^listening-/); const last = p.getInfo().log.pop(); assert.strictEqual(last.fade, false);
  p.destroy();
});
test('chaining and preload: the next clip is loading in the hidden video before the current one ends, and starts without waiting', async () => {
  const { w, p } = await started(); await w.settle(400);
  const hidden = w.videos[1 - p.getInfo().front]; assert.ok(hidden.src, 'next clip preloaded'); const want = hidden.clipName; assert.strictEqual(hidden.readyState, 4);
  const before = p.getInfo().log.length; w.front(p).end(); await w.settle(5);
  const log = p.getInfo().log; assert.strictEqual(log.length, before + 1); assert.strictEqual(log[log.length - 1].name, want, 'the preloaded clip was the one played');
  p.destroy();
});
test('chaining: a clip whose ended event never comes still advances (watchdog), never twice for one clip', async () => {
  const { w, p } = await started(); const n = p.getInfo().log.length; const c = p.getInfo().clip;
  await w.settle(9000); assert.ok(p.getInfo().log.length > n); assert.notStrictEqual(p.getInfo().clip, c);
  const k = p.getInfo().log.length; const f = w.front(p); f.end(); f.end(); await w.settle(100);
  assert.strictEqual(p.getInfo().log.length, k + 1, 'a duplicate ended event is ignored');
  p.destroy();
});
test('generation guard: a late load of a clip that is no longer wanted never starts, plays or draws', async () => {
  const w = makeWorld(); w.hold.add('speaking-1'); w.hold.add('speaking-2'); w.hold.add('speaking-3'); w.hold.add('speaking-4');
  const p = w.make(); await p.ready; await w.settle(100);
  p.setState('speaking'); await w.settle(400);
  const loading = w.videos.find(v => /^speaking-/.test(v.clipName || '')); assert.ok(loading, 'a speaking clip is being fetched');
  p.setState('listening'); await w.settle(400);
  const state = p.getInfo(); assert.match(state.clip, /^listening-/);
  const plays = w.played.length; loading.readyState = 4; loading.duration = 4; loading.fire('loadeddata'); await w.settle(300);
  assert.strictEqual(w.played.filter(n => /^speaking-/.test(n)).length, 0, 'the late speaking clip was never played');
  assert.strictEqual(p.getInfo().clip, state.clip); assert.ok(w.played.length >= plays);
  p.destroy();
});
test('stale events: a late loadeddata/error of an earlier resource never marks the clip loading now ready or failed', async () => {
  const w = makeWorld(); for (const n of ['speaking-1', 'speaking-2', 'speaking-3', 'speaking-4']) w.hold.add(n);
  const p = w.make(); await p.ready; await w.settle(100); p.setState('speaking'); await w.settle(400);
  const loading = w.videos.find(v => /^speaking-/.test(v.clipName || '')); assert.ok(loading); const mine = loading.src, old = '/api/faces/owl/web/idle-a1.mp4';
  assert.strictEqual(loading.readyState, 0);
  loading.fire('loadeddata'); await w.settle(100);                                   // no data yet: an old event
  loading.readyState = 4; loading.currentSrc = old; loading.fire('loadeddata'); await w.settle(100);   // data, but of the old resource
  loading.currentSrc = old; loading.fire('error'); await w.settle(100);                                  // an old error
  assert.strictEqual(w.played.filter(n => /^speaking-/.test(n)).length, 0, 'never played'); assert.ok(!p.getInfo().bad.some(n => /^speaking-/.test(n)), 'never set aside');
  loading.currentSrc = 'http://host' + mine; loading.fire('loadeddata'); await w.settle(100);     // the real thing (absolute currentSrc, as a browser reports it)
  assert.match(p.getInfo().clip, /^speaking-/, 'the genuine event still works');
  p.destroy();
  const w2 = makeWorld(); for (const n of ['speaking-1', 'speaking-2', 'speaking-3', 'speaking-4']) w2.hold.add(n);
  const q = w2.make(); await q.ready; await w2.settle(100); q.setState('speaking'); await w2.settle(400);
  const l2 = w2.videos.find(v => /^speaking-/.test(v.clipName || '')); l2.currentSrc = l2.src; l2.fire('error'); await w2.settle(100);
  assert.ok(q.getInfo().bad.some(n => /^speaking-/.test(n)), 'a genuine error still sets the clip aside'); q.destroy();
});
test('load failures: a clip that errors is set aside and another one plays; when nothing loads the last picture stays and it retries later', async () => {
  const w = makeWorld(); w.fail.add('idle-a1'); w.fail.add('idle-a2');
  const p = w.make(); await p.ready; await w.settle(500);
  assert.ok(p.getInfo().bad.length >= 1);
  const cur = p.getInfo().clip; assert.ok(cur === null || !/^idle-a[12]$/.test(cur));
  const w2 = makeWorld(); for (const c of w2.manifest.clips) w2.fail.add(c.name);
  const p2 = w2.make(); await p2.ready; await w2.settle(20000);
  assert.strictEqual(p2.getInfo().clip, null); assert.ok(p2.getInfo().bad.length >= 2, 'the idle clips that failed were set aside');
  p.destroy(); p2.destroy();
});
test('pose rules in the player: other states still wait for the way back from pose B (no shortcut cross-fade)', async () => {
  const clips = [clip('idle-up', 'idle', { endsOn: 'B', dur: 3 }), clip('idle-back', 'idle', { startsFrom: 'B', dur: 2 }), clip('speaking-1', 'speaking', { track: true, beakEnds: 'closed' }), clip('listening-1', 'listening')];
  const w = makeWorld({ manifest: packManifest(clips) }); const p = w.make(); await p.ready; await w.settle(100);
  assert.strictEqual(p.getInfo().clip, 'idle-up'); assert.strictEqual(p.getInfo().pose, 'B');
  p.setState('listening'); await w.settle(300);
  assert.strictEqual(p.getInfo().clip, 'idle-up', 'a clip that changes the pose is not cut short');
  w.front(p).end(); await w.settle(100);
  assert.strictEqual(p.getInfo().clip, 'idle-back'); assert.strictEqual(p.getInfo().pose, 'A');
  w.front(p).currentTime = 0; w.front(p).end(); await w.settle(100);
  assert.strictEqual(p.getInfo().clip, 'listening-1');
  const L = p.getInfo().log; assert.ok(L.every(e => e.kind !== 'fallback')); p.destroy();
});

// ── fast speaking: entering speaking cuts to a tracked speaking clip inside 150 ms from every state, pose B included ──
const speakPack = () => [
  clip('idle-a1', 'idle', { family: 'baton', dur: 5 }), clip('idle-up', 'idle', { family: 'settle', dur: 3, endsOn: 'B' }),
  clip('idle-rest', 'idle', { family: 'rest', startsFrom: 'B', endsOn: 'B', dur: 6 }), clip('idle-back', 'idle', { family: 'back', dur: 2, startsFrom: 'B' }),
  clip('listening-1', 'listening', { dur: 6 }), clip('thinking-1', 'thinking', { dur: 6 }),
  clip('speaking-1', 'speaking', { track: true, beakEnds: 'closed', dur: 5 }), clip('speaking-2', 'speaking', { track: true, beakEnds: 'closed', dur: 5, family: 'sp2' }),
  clip('reaction-hello-1', 'reaction', { mood: 'hello', dur: 3 }), clip('reaction-proud-2', 'reaction', { mood: 'proud', dur: 3 }),
  clip('reaction-delighted-1', 'reaction', { mood: 'delighted', dur: 3 }), clip('reaction-goodbye-1', 'reaction', { mood: 'goodbye', dur: 3 }),
];
// drive the player into `how` (a state or a named situation), then ask for speaking and report what happened inside 150 ms.
// The pose-B situations use a pack whose only idle clips are the A-to-B settle and the B rest (a first idle clip is then idle-up, as in the pose test above).
async function enterSpeaking(how, wo) {
  const clips = /^poseB/.test(how) ? speakPack().filter(c => c.name !== 'idle-a1') : speakPack();
  const w = makeWorld(Object.assign({ manifest: packManifest(clips) }, wo || {})); const p = w.make(); await p.ready; await w.settle(100);
  const front = () => w.front(p);
  if (how === 'listening' || how === 'thinking') { p.setState(how); await w.settle(400); }
  else if (how === 'poseB-settling') { /* idle-up (A to B) must be playing */ for (let i = 0; i < 8 && p.getInfo().clip !== 'idle-up'; i++) { front().end(); await w.settle(100); } }
  else if (how === 'poseB-rest') { for (let i = 0; i < 12 && p.getInfo().clip !== 'idle-rest'; i++) { front().end(); await w.settle(100); } }
  else if (how === 'reaction') { p.react('proud'); await w.settle(100); }
  else if (how === 'hello') { p.react('hello'); await w.settle(100); }
  else if (how === 'nearly-over') { front().currentTime = front().duration - 0.2; }
  const before = { clip: p.getInfo().clip, pose: p.getInfo().pose, n: p.getInfo().log.length, t: w.now };
  p.setState('speaking'); await w.settle(150);
  return { w, p, before, info: p.getInfo(), took: w.now - before.t };
}
for (const how of ['idle', 'listening', 'thinking', 'poseB-settling', 'poseB-rest', 'reaction', 'hello', 'nearly-over']) {
  test('fast speaking: from ' + how + ' a tracked speaking clip is in front within 150 ms, never waiting for the playing clip to end', async () => {
    const { w, p, before, info } = await enterSpeaking(how);
    if (how === 'poseB-settling') assert.strictEqual(before.clip, 'idle-up', 'set-up: the pose-changing clip is playing');
    if (how === 'poseB-rest') { assert.strictEqual(before.clip, 'idle-rest'); assert.strictEqual(before.pose, 'B', 'set-up: pose B'); }
    if (how === 'reaction') assert.strictEqual(before.clip, 'reaction-proud-2', 'set-up: a (non-hello) reaction is playing');
    assert.match(info.clip, /^speaking-/, 'now ' + info.clip + ' (was ' + before.clip + ')');
    const last = info.log[info.log.length - 1]; assert.strictEqual(info.log.length, before.n + 1, 'one switch'); assert.strictEqual(last.state, 'speaking');
    const cold = info.coldHolds > 0;   // the clip was still loading: the poster shielded the switch, so it is a hard cut; a warm switch keeps the 120 ms cross-fade
    assert.strictEqual(last.fade, !cold);
    assert.ok(last.latency <= 150 && info.speakLatency <= 150, 'latency ' + last.latency); assert.ok(last.ms <= 120, 'the cross-fade fits the budget: ' + last.ms);
    const v = w.front(p); assert.strictEqual(v.clipName, info.clip); assert.strictEqual(v.paused, false); if (cold) assert.ok(!/\d+ms/.test(v.style.transition || '')); else assert.match(v.style.transition, /120ms/); assert.strictEqual(v.style.opacity, '1');
    assert.strictEqual(info.pose, 'A', 'a speaking clip ends on the master pose'); assert.ok(!info.bad.length);
    p.destroy();
  });
}
test('reaction and goodbye transitions cross-fade in one short 70 ms fade (not 120, not 250: the old pose ghosted); a plain state change keeps 250 ms', async () => {
  const w = makeWorld({ manifest: packManifest(speakPack()) }); const p = w.make(); await p.ready; await w.settle(100);
  p.setState('listening'); await w.settle(400);
  assert.strictEqual(p.getInfo().log.pop().ms, 250, 'same-pose state change: normal fade');
  for (const [mood, name] of [['proud', 'reaction-proud-2'], ['goodbye', 'reaction-goodbye-1']]) {
    p.setState('idle'); await w.settle(400);
    const before = p.getInfo().log.length; assert.strictEqual(p.react(mood), true); await w.settle(30);
    const i = p.getInfo(), last = i.log[i.log.length - 1];
    assert.strictEqual(i.clip, name); assert.strictEqual(i.log.length, before + 1);
    assert.strictEqual(last.state, 'reaction'); assert.strictEqual(last.fade, true); assert.strictEqual(last.ms, 70, mood + ' fade ms');
    assert.match(w.front(p).style.transition, /\b70ms/); assert.ok(!/250ms|120ms/.test(w.front(p).style.transition));
    const old = w.videos[1 - i.front]; await w.settle(35); assert.strictEqual(old.paused, false, 'the old video is still there while the fade runs');
    await w.settle(40); assert.strictEqual(old.paused, true, 'the old video is gone just after the 70 ms fade (nothing ghosts for 85 ms or more)'); assert.strictEqual(old.style.opacity, '0');
    await w.settle(5000);
  }
  p.destroy();
});
// ── goodbye: cuts the playing clip at once (never waits for it to end), pose family of the on-screen clip, first frame presented within 150 ms ──
const goodbyeB = (name) => clip(typeof name === 'string' ? name : 'reaction-goodbye-b', 'reaction', { mood: 'goodbye', dur: 3, startsFrom: 'B', endsOn: 'A', family: 'gb' });
async function goodbyeCut(how, withB, tweak) {
  const clips = speakPack().filter(c => how === 'reaction' || c.name !== 'idle-a1').map(c => c.name === 'idle-up' ? Object.assign({}, c, { dur: 6.2 }) : c).concat(withB ? [goodbyeB(withB)] : []);
  const w = makeWorld({ manifest: packManifest(clips) }); const p = w.make(); await p.ready; await w.settle(100);
  const front = () => w.front(p);
  if (how === 'poseB-rest') { for (let i = 0; i < 12 && p.getInfo().clip !== 'idle-rest'; i++) { front().end(); await w.settle(100); } }
  else if (how === 'reaction') { p.react('proud'); await w.settle(100); }
  if (tweak) tweak(front);
  const before = { clip: p.getInfo().clip, n: p.getInfo().log.length, t: w.now, old: front() };
  assert.strictEqual(p.react('goodbye'), true);
  await w.settle(150);
  const info = p.getInfo(), v = w.front(p);
  // the frame callback of the goodbye video is the "presented" signal the player waits on: it is armed on exactly this video, and delivering it draws the clip's first frame
  const presented = v.frame(0.04, w.now);
  return { w, p, before, info, v, presented, last: info.log[info.log.length - 1], took: w.now - before.t };
}
const settling = (f) => { assert.strictEqual(f().clipName, 'idle-up'); };
test('goodbye while the 6.2 s pose-changing clip plays (first half, on-screen pose A): cut at once to the A goodbye, first frame presented within 150 ms, old poseB code waited for the clip end', async () => {
  const r = await goodbyeCut('poseB-settling', true, settling);
  assert.strictEqual(r.before.clip, 'idle-up', 'set-up: the 6.2 s A-to-B clip is playing');
  assert.strictEqual(r.info.clip, 'reaction-goodbye-1'); assert.strictEqual(r.info.log.length, r.before.n + 1, 'one switch');
  assert.strictEqual(r.last.kind, 'reaction'); assert.strictEqual(r.last.ms, 70); assert.strictEqual(r.last.fade, true);
  assert.ok(r.took <= 150, 'took ' + r.took); assert.strictEqual(r.v.clipName, 'reaction-goodbye-1'); assert.strictEqual(r.v.paused, false); assert.strictEqual(r.v.readyState, 4);
  assert.strictEqual(r.presented, true, 'the goodbye video presented a frame (frame callback was armed on it)'); assert.strictEqual(r.v.style.opacity, '1'); assert.match(r.v.style.transition, /\b70ms/);
  assert.strictEqual(r.info.pending, null); assert.strictEqual(r.info.pose, 'A');
  r.p.destroy();
});
test('goodbye while the pose-changing clip is in its second half (on-screen pose B): the B-family goodbye, not the A one', async () => {
  const r = await goodbyeCut('poseB-settling', true, (f) => { settling(f); f().currentTime = 4.5; });
  assert.strictEqual(r.info.clip, 'reaction-goodbye-b'); assert.ok(r.took <= 150); assert.strictEqual(r.presented, true); assert.strictEqual(r.last.ms, 70);
  r.p.destroy();
});
test('goodbye in pose B mid-clip: the B goodbye when the pack has one; with only an A goodbye (missing pose family) that one is used at once, not a wait for the way back to A', async () => {
  const b = await goodbyeCut('poseB-rest', true, (f) => { assert.strictEqual(f().clipName, 'idle-rest'); f().currentTime = 1; });
  assert.strictEqual(b.before.clip, 'idle-rest'); assert.strictEqual(b.info.clip, 'reaction-goodbye-b'); assert.ok(b.took <= 150); assert.strictEqual(b.presented, true); b.p.destroy();
  const a = await goodbyeCut('poseB-rest', false, (f) => { f().currentTime = 1; });
  assert.strictEqual(a.before.clip, 'idle-rest', 'set-up: pose B, long clip with seconds left');
  assert.strictEqual(a.info.clip, 'reaction-goodbye-1', 'no B goodbye in the pack: any available one, immediately');
  assert.ok(a.took <= 150, 'took ' + a.took); assert.strictEqual(a.presented, true); assert.strictEqual(a.last.ms, 70); assert.strictEqual(a.info.log.filter(x => x.name === 'idle-back').length, 0, 'no detour through the transition clip');
  a.p.destroy();
});
test('goodbye choice is by metadata only: a B-start goodbye with a neutral name (no "-b" suffix) wins at true B rest; the A goodbye is the fallback without it', async () => {
  const b = await goodbyeCut('poseB-rest', 'reaction-goodbye-farewell', (f) => { assert.strictEqual(f().clipName, 'idle-rest'); f().currentTime = 1; });
  assert.strictEqual(b.before.clip, 'idle-rest'); assert.strictEqual(b.info.clip, 'reaction-goodbye-farewell', 'startsFrom B on the resting pose, whatever the name');
  assert.ok(b.took <= 150, 'took ' + b.took); assert.strictEqual(b.presented, true); assert.strictEqual(b.last.ms, 70); b.p.destroy();
  const a = await goodbyeCut('poseB-rest', false, (f) => { f().currentTime = 1; });
  assert.strictEqual(a.before.clip, 'idle-rest'); assert.strictEqual(a.info.clip, 'reaction-goodbye-1', 'no B-start goodbye: the A one is cut to at once from B');
  assert.ok(a.took <= 150, 'took ' + a.took); assert.strictEqual(a.last.ms, 70); a.p.destroy();
});
test('goodbye while a (non-hello) reaction plays: it cuts that too; the old picture stays under the 70 ms fade (no blank), then goes', async () => {
  const r = await goodbyeCut('reaction', false);
  assert.strictEqual(r.before.clip, 'reaction-proud-2'); assert.strictEqual(r.info.clip, 'reaction-goodbye-1'); assert.ok(r.took <= 150); assert.strictEqual(r.presented, true);
  r.p.destroy();
  const w2 = makeWorld({ manifest: packManifest(speakPack()) }); const p2 = w2.make(); await p2.ready; await w2.settle(100);
  p2.react('proud'); await w2.settle(100); const old = w2.front(p2); p2.react('goodbye'); await w2.settle(30);
  assert.strictEqual(p2.getInfo().clip, 'reaction-goodbye-1'); assert.strictEqual(old.paused, false, 'old video still playing under the fade'); assert.notStrictEqual(old.style.opacity, '0');
  await w2.settle(100); assert.strictEqual(old.paused, true); assert.strictEqual(old.style.opacity, '0'); p2.destroy();
});
test('goodbye still never cuts the audible reply, and a goodbye that is already showing is not restarted', async () => {
  const { w, p } = await enterSpeaking('idle'); const at = p.getInfo().clip;
  p.react('goodbye'); await w.settle(300); assert.strictEqual(p.getInfo().clip, at, 'the reply is not cut');
  p.setState('idle'); await w.settle(150); assert.strictEqual(p.getInfo().clip, 'reaction-goodbye-1');
  const n = p.getInfo().log.length; p.react('goodbye'); await w.settle(200); assert.strictEqual(p.getInfo().log.length, n, 'not restarted'); p.destroy();
});
test('fast speaking: a warm switch (tracked clip already loaded, no cold hold) cross-fades explicitly in 120 ms', async () => {
  const { w, p } = await started({}, {});
  p.setState('speaking'); await w.settle(150); const first = p.getInfo().clip; assert.match(first, /^speaking-/);
  p.setState('listening'); await w.settle(36); assert.match(p.getInfo().clip, /^listening-/, 'set-up: listening is in front');
  const holds = p.getInfo().coldHolds, hidden = w.videos[1 - p.getInfo().front]; assert.strictEqual(hidden.clipName, first, 'set-up: the speaking video is still loaded'); assert.strictEqual(hidden.readyState, 4);
  const n = p.getInfo().log.length; p.setState('speaking'); await w.settle(150);
  const i = p.getInfo(), last = i.log[i.log.length - 1];
  assert.strictEqual(i.coldHolds, holds, 'warm: no cold hold'); assert.strictEqual(i.log.length, n + 1); assert.strictEqual(last.state, 'speaking');
  assert.strictEqual(last.fade, true); assert.strictEqual(last.ms, 120); assert.match(w.front(p).style.transition, /120ms/); assert.ok(last.latency <= 150);
  p.destroy();
});
test('fast speaking: from pose B a speaking clip that starts on B is preferred; else one that ends on A; the beak track is the clip\'s own', async () => {
  const mkB = () => speakPack().filter(c => c.name !== 'idle-a1').concat([clip('speaking-b', 'speaking', { track: true, beakEnds: 'closed', startsFrom: 'B', endsOn: 'A', dur: 5, family: 'spb' })]);
  const w = makeWorld({ manifest: packManifest(mkB()) }); const p = w.make(); await p.ready; await w.settle(100);
  for (let i = 0; i < 12 && p.getInfo().clip !== 'idle-rest'; i++) { w.front(p).end(); await w.settle(100); }
  assert.strictEqual(p.getInfo().pose, 'B'); p.setState('speaking'); await w.settle(150);
  assert.strictEqual(p.getInfo().clip, 'speaking-b', 'the pose-B-start speaking clip'); assert.strictEqual(p.getInfo().pose, 'A');
  // the beak draws from that clip's track, at the track's own transform (clip.track gives the frame; the same maths as in the plain case)
  const st = { amp: 0.2, hz: 1500 }; p.setAnalyser(analyserOf(st)); const v = w.front(p);
  v.frame(12 / 24, w.now); v.frame(12 / 24, w.now + 16.7); w.ctxCalls.length = 0; v.frame(12 / 24, w.now + 40);
  assert.deepStrictEqual(w.ctxCalls.find(c => c[0] === 'translate').slice(1), [612, 362]); assert.ok(Math.abs(w.ctxCalls.find(c => c[0] === 'rotate')[1] + 12 * Math.PI / 180) < 1e-12);
  assert.ok(Math.abs(w.ctxCalls.find(c => c[0] === 'scale')[1] - 1.12) < 1e-12); p.destroy();
});
test('fast speaking: no reaction plays while the reply is audible; a waiting mood reaction is dropped; a goodbye waits and never cuts the speech', async () => {
  const { w, p } = await enterSpeaking('idle'); const clipAt = p.getInfo().clip, n = p.getInfo().log.length;
  assert.strictEqual(p.react('proud'), true, 'the reaction exists'); assert.strictEqual(p.getInfo().pending, null, 'not queued'); await w.settle(300);
  assert.strictEqual(p.getInfo().clip, clipAt); assert.strictEqual(p.getInfo().log.length, n);
  assert.strictEqual(p.react('goodbye'), true); assert.strictEqual(p.getInfo().pending, 'goodbye'); await w.settle(300); assert.strictEqual(p.getInfo().clip, clipAt, 'a goodbye does not cut the reply');
  p.setState('idle'); await w.settle(150); assert.strictEqual(p.getInfo().clip, 'reaction-goodbye-1', 'the goodbye plays once the reply is over');
  p.destroy();
  const w2 = makeWorld({ manifest: packManifest(speakPack()) }); const q = w2.make(); await q.ready; await w2.settle(100);
  q.react('proud'); await w2.settle(100); assert.strictEqual(q.getInfo().clip, 'reaction-proud-2');
  q.react('delighted'); assert.strictEqual(q.getInfo().pending, 'delighted', 'set-up: a reaction is waiting behind the playing one');
  q.setState('speaking'); await w2.settle(150);
  const L = q.getInfo().log, si = L.findIndex(e => e.state === 'speaking');
  assert.ok(si > 0 && q.getInfo().clip.startsWith('speaking-')); assert.ok(!L.slice(si).some(e => e.state === 'reaction'), 'the waiting mood is dropped when speaking starts'); assert.strictEqual(q.getInfo().pending, null);
  w2.front(q).end(); await w2.settle(200); assert.match(q.getInfo().clip, /^speaking-/, 'the next clip of the reply is speaking again, never a reaction'); q.destroy();
});
test('fast speaking: the reply keeps chaining tracked speaking clips from any pose, never an idle or transition clip', async () => {
  const { w, p } = await enterSpeaking('poseB-rest');
  for (let i = 0; i < 6; i++) { w.front(p).end(); await w.settle(150); const L = p.getInfo().log; assert.strictEqual(L[L.length - 1].state, 'speaking'); assert.ok(L[L.length - 1].kind !== 'transition' && L[L.length - 1].kind !== 'fallback'); }
  p.destroy();
});
test('fast speaking: load latency is reported honestly; the old clip keeps playing until the speaking clip has data, then it cuts at once', async () => {
  const w = makeWorld({ manifest: packManifest(speakPack()) }); w.hold.add('speaking-1'); w.hold.add('speaking-2');
  const p = w.make(); await p.ready; await w.settle(100); const was = p.getInfo().clip, t0 = w.now;
  p.setState('speaking'); await w.settle(150);
  assert.strictEqual(p.getInfo().clip, was, 'nothing to cut to yet: the picture is not blanked'); assert.strictEqual(p.getInfo().speakLatency, null);
  await w.settle(900); const loading = w.videos.find(v => /^speaking-/.test(v.clipName || '')); assert.ok(loading, 'the speaking clip was requested at once');
  loading.currentSrc = loading.src; loading.readyState = 4; loading.duration = 5; loading.fire('loadeddata'); await w.settle(30);
  assert.match(p.getInfo().clip, /^speaking-/); assert.ok(p.getInfo().speakLatency >= 900, 'the late load is visible in the number: ' + p.getInfo().speakLatency); assert.ok(w.now - t0 >= 1000);
  p.destroy();
});
test('fast speaking: when no tracked speaking clip is available the old rules hold (no speaking clip, no reaction)', async () => {
  const noSpeak = speakPack().filter(c => c.state !== 'speaking'); const w = makeWorld({ manifest: packManifest(noSpeak, { beak: undefined }) });
  const p = w.make(); await p.ready; await w.settle(100); const was = p.getInfo().clip;
  p.setState('speaking'); await w.settle(150); assert.ok(was); assert.match(p.getInfo().clip, /^idle-/); assert.ok(!p.getInfo().log.some(e => e.state === 'speaking' || e.state === 'reaction')); p.destroy();
});

// ── reactions ──
test('reaction: the mood field is used first, then the clip name; unknown moods are ignored; extra moods work', async () => {
  const { w, p } = await started();
  assert.strictEqual(p.react('nonsense'), false); assert.strictEqual(p.react(''), false); assert.strictEqual(p.react(null), false);
  assert.strictEqual(p.react('proud'), true); await w.settle(100); assert.strictEqual(p.getInfo().clip, 'reaction-proud-2');   // by name
  w.front(p).end(); await w.settle(100);
  assert.strictEqual(p.react('delighted'), true); await w.settle(100); assert.strictEqual(p.getInfo().clip, 'reaction-delighted-1');   // by mood
  w.front(p).end(); await w.settle(100);
  assert.strictEqual(p.react('touched'), true); await w.settle(100); assert.strictEqual(p.getInfo().clip, 'reaction-touched-1');
  p.destroy();
  const clips = packClips().concat([clip('reaction-curious-9', 'reaction', { mood: 'proud' })]);   // the field wins over the name
  const w2 = makeWorld({ manifest: packManifest(clips) }); const p2 = w2.make(); await p2.ready; await w2.settle(100);
  p2.react('proud'); await w2.settle(100); assert.ok(['reaction-curious-9', 'reaction-proud-2'].includes(p2.getInfo().clip));
  assert.strictEqual(p2.react('curious'), true, 'a name match still works when no mood field matches'); p2.destroy();
});
test('reaction: a reaction finishes, then the state requested meanwhile follows; a newer reaction replaces a waiting one', async () => {
  const { w, p } = await started(); p.react('delighted'); await w.settle(100);
  assert.strictEqual(p.getInfo().clip, 'reaction-delighted-1');
  p.setState('listening'); await w.settle(400); assert.strictEqual(p.getInfo().clip, 'reaction-delighted-1', 'not cut');
  p.react('proud'); p.react('touched'); await w.settle(200); assert.strictEqual(p.getInfo().clip, 'reaction-delighted-1');
  w.front(p).end(); await w.settle(100); assert.strictEqual(p.getInfo().clip, 'reaction-touched-1', 'the latest waiting reaction plays');
  w.front(p).end(); await w.settle(100); assert.match(p.getInfo().clip, /^listening-/, 'then the pending state');
  p.destroy();
});
test('hello: hearing the person (listening) interrupts hello at once, speaking and thinking too; other reactions are not interrupted', async () => {
  const { w, p } = await started(); p.react('hello'); await w.settle(100);
  assert.strictEqual(p.getInfo().clip, 'reaction-hello-1');
  const t0 = p.getInfo().log.length; p.setState('listening'); await w.settle(60);
  assert.match(p.getInfo().clip, /^listening-/); assert.strictEqual(p.getInfo().log.length, t0 + 1); assert.strictEqual(p.getInfo().log.pop().fade, true);
  p.destroy();
  const { w: w2, p: p2 } = await started(); p2.setState('listening'); await w2.settle(100); p2.react('hello'); await w2.settle(100);
  assert.strictEqual(p2.getInfo().clip, 'reaction-hello-1'); p2.setState('listening'); await w2.settle(60);
  assert.match(p2.getInfo().clip, /^listening-/, 'setState(listening) while already listening still yields the hello');
  p2.destroy();
  const { w: w3, p: p3 } = await started(); p3.react('hello'); p3.setState('thinking'); await w3.settle(300);
  assert.match(p3.getInfo().clip, /^thinking-/, 'a hello that had not started is dropped, the mic/state path is never delayed');
  p3.destroy();
});
test('goodbye plays to its end and is not cut by idle', async () => {
  const { w, p } = await started(); p.react('goodbye'); await w.settle(100); p.setState('idle'); await w.settle(300);
  assert.strictEqual(p.getInfo().clip, 'reaction-goodbye-1'); w.front(p).end(); await w.settle(100); assert.match(p.getInfo().clip, /^idle-/); p.destroy();
});
test('reaction before ready is kept and plays once the pack is ready', async () => {
  const w = makeWorld(); const p = w.make(); assert.strictEqual(p.react('hello'), true); await p.ready; await w.settle(200);
  assert.strictEqual(p.getInfo().clip, 'reaction-hello-1'); p.destroy();
});

test('early reaction: a hello asked for before ready is dropped by setState(listening) during boot; other early reactions survive', async () => {
  const w = makeWorld(); const p = w.make(); assert.strictEqual(p.react('hello'), true); assert.strictEqual(p.setState('listening'), true); await p.ready; await w.settle(300);
  assert.ok(!p.getInfo().log.some(e => e.state === 'reaction'), 'no hello over a person who is already being heard'); assert.strictEqual(p.getInfo().pending, null); p.destroy();
  const w2 = makeWorld(); const q = w2.make(); q.react('Reaction-Hello-1'); q.setState('thinking'); await q.ready; await w2.settle(300);
  assert.ok(!q.getInfo().log.some(e => e.name === 'reaction-hello-1'), 'a hello by clip name too'); q.destroy();
  const w3 = makeWorld(); const r = w3.make(); r.react('hello'); r.setState('idle'); await r.ready; await w3.settle(200); assert.strictEqual(r.getInfo().clip, 'reaction-hello-1', 'idle keeps it'); r.destroy();
  const w4 = makeWorld(); const s = w4.make(); s.react('proud'); s.setState('listening'); await s.ready; await w4.settle(200); assert.strictEqual(s.getInfo().clip, 'reaction-proud-2', 'only hello is dropped'); s.destroy();
  const w5 = makeWorld(); const d = w5.make(); d.react('hello'); d.destroy(); await d.ready.catch(() => {}); await w5.settle(500); assert.strictEqual(w5.played.length, 0);
});

// ── the beak drawing ──
async function speaking(o, wo) {
  const r = await started(o, wo); const { w, p } = r;
  const st = { amp: 0.2, hz: 1500 }; r.st = st; r.an = analyserOf(st);
  p.setState('speaking'); await w.settle(100); r.v = w.front(p); r.name = p.getInfo().clip;
  assert.match(r.name, /^speaking-/); return r;
}
test('beak drawing: track position, scale, angle and the patch offset follow the format exactly (DPR 2, 16:9 view)', async () => {
  const { w, p, st, an, v } = await speaking({ dprCap: 2 }, { dpr: 3, w: 800, h: 450 });
  assert.strictEqual(p.getInfo().canvasW, 1600, 'DPR capped at 2'); p.setAnalyser(an);
  v.frame(12 / 24, w.now); v.frame(12 / 24, w.now + 16.7);   // the first frame primes the trackers, the second is a real loud frame
  w.ctxCalls.length = 0; v.frame(12 / 24, w.now + 40);
  const names = w.ctxCalls.map(c => c[0]); const k = 2 * 800 / 1280;
  const st1 = w.ctxCalls.filter(c => c[0] === 'setTransform')[1];   // [name, a, b, c, d, e, f]
  assert.ok(Math.abs(st1[1] - k) < 1e-9 && Math.abs(st1[4] - k) < 1e-9 && Math.abs(st1[5]) < 1e-9 && Math.abs(st1[6]) < 1e-9);
  const tr = w.ctxCalls.find(c => c[0] === 'translate'); assert.deepStrictEqual(tr.slice(1), [612, 362]);
  const rot = w.ctxCalls.find(c => c[0] === 'rotate'); assert.ok(Math.abs(rot[1] - (-12 * Math.PI / 180)) < 1e-12);
  const sc = w.ctxCalls.find(c => c[0] === 'scale'); assert.ok(Math.abs(sc[1] - 1.12) < 1e-12);
  const di = w.ctxCalls.find(c => c[0] === 'drawImage'); assert.deepStrictEqual(di.slice(2), [580 - 646, 296 - 350]);
  assert.ok(names.indexOf('translate') < names.indexOf('rotate') && names.indexOf('rotate') < names.indexOf('scale') && names.indexOf('scale') < names.indexOf('drawImage'));
  assert.match(di[1]._s, /\/beak\/(wide|half|slight|oo)\.png$/);
  p.destroy();
});
test('beak drawing: letterboxed view (wide container) keeps the same transform maths with an offset; canvas size is not rewritten per frame', async () => {
  const { w, p, an, v } = await speaking({}, { dpr: 1, w: 1600, h: 450 });
  p.setAnalyser(an); const writes = w.canvasWrites; w.ctxCalls.length = 0;
  for (let i = 0; i < 20; i++) v.frame(i / 24, w.now + i * 41);
  assert.strictEqual(w.canvasWrites, writes, 'no canvas resize while drawing');
  const s = 450 / 720, ox = (1600 - 1280 * s) / 2; const t = w.ctxCalls.filter(c => c[0] === 'setTransform')[1];
  assert.ok(Math.abs(t[1] - s) < 1e-9 && Math.abs(t[4] - s) < 1e-9 && Math.abs(t[5] - ox) < 1e-9 && Math.abs(t[6]) < 1e-9);
  p.destroy();
});
test('beak drawing: speaking after a smile clip blends smile 1, 2/3, 1/3, 0 with the voice shape complementary', async () => {
  const w = makeWorld(); const p = w.make(); await p.ready; await w.settle(100);
  const st = { amp: 0.2, hz: 1500 }; p.setAnalyser(analyserOf(st)); p.setState('speaking'); await w.settle(100);
  const v = w.front(p); assert.match(p.getInfo().clip, /^speaking-/);
  const alphas = [];
  for (let f = 0; f < 5; f++) {
    w.ctxCalls.length = 0; v.frame(f / 24, w.now + 100 + f * 41);
    const draws = []; let a = 1;
    for (const c of w.ctxCalls) { if (c[0] === 'globalAlpha') a = c[1]; if (c[0] === 'drawImage') draws.push([c[1]._s.replace(/.*\//, ''), a]); }
    alphas.push(draws);
  }
  const smile = alphas.map(d => (d.find(x => x[0] === 'smile.png') || [0, 0])[1]); const voice = alphas.map(d => (d.find(x => x[0] !== 'smile.png') || [0, 0])[1]);
  const exp = [1, 2 / 3, 1 / 3, 0, 0];
  exp.forEach((e, i) => { assert.ok(Math.abs(smile[i] - e) < 1e-9, 'smile alpha frame ' + i + ' = ' + smile[i]); });
  [0, 1 / 3, 2 / 3, 1, 1].forEach((e, i) => { assert.ok(Math.abs(voice[i] - e) < 1e-9 || (i === 0 && voice[i] === 0), 'voice alpha frame ' + i + ' = ' + voice[i]); });
  p.destroy();
});
test('beak drawing: a smile clip after speaking fades the last drawn shape out at the master position over 3 frames', async () => {
  const { w, p, an, v } = await speaking({});
  p.setAnalyser(an); v.frame(0, w.now); v.frame(0.04, w.now + 40); v.frame(0.08, w.now + 80);
  p.setState('listening'); await w.settle(200);
  const nv = w.front(p); assert.notStrictEqual(nv, v); const got = [];
  for (let f = 0; f < 4; f++) {
    w.ctxCalls.length = 0; nv.frame(f / 24, w.now + 300 + f * 41);
    let a = 1; const d = []; for (const c of w.ctxCalls) { if (c[0] === 'globalAlpha') a = c[1]; if (c[0] === 'translate') d.push(c.slice(1)); if (c[0] === 'drawImage') d.push(['img', a]); }
    got.push(d);
  }
  assert.deepStrictEqual(got[0][0], [646, 350]); assert.ok(Math.abs(got[0][1][1] - 1) < 1e-9);
  assert.ok(Math.abs(got[1][1][1] - 2 / 3) < 1e-9); assert.ok(Math.abs(got[2][1][1] - 1 / 3) < 1e-9); assert.deepStrictEqual(got[3], []);
  p.destroy();
});
test('beak: closed immediately on analyser detach, device-speech cancel/pause/end and when the state leaves speaking (barge-in)', async () => {
  const { w, p, an, v } = await speaking({});
  let tm = w.now;   // frame times only move forward (the 80 ms hold looks at them)
  const open = () => { tm += 1000; p.setAnalyser(an); v.frame(0, tm); v.frame(0.04, tm + 100); };
  open(); assert.notStrictEqual(p.getInfo().shape, 'closed');
  p.setAnalyser(null); assert.strictEqual(p.getInfo().shape, 'closed'); assert.match(w.ctxCalls.filter(c => c[0] === 'drawImage' && !/smile/.test(c[1]._s)).pop()[1]._s, /closed\.png$/);
  open(); assert.notStrictEqual(p.getInfo().shape, 'closed'); p.speechEvent('cancel'); assert.strictEqual(p.getInfo().shape, 'closed');
  v.frame(0.08, w.now + 60); v.frame(0.12, w.now + 80); assert.strictEqual(p.getInfo().shape, 'closed', 'stays closed after a cancel until speech starts again');
  p.speechEvent('start'); open(); assert.notStrictEqual(p.getInfo().shape, 'closed', 'start lifts the cancel');
  p.speechEvent('pause'); assert.strictEqual(p.getInfo().shape, 'closed');
  open(); assert.notStrictEqual(p.getInfo().shape, 'closed', 'a new analyser attaches cleanly');
  p.setState('listening'); assert.strictEqual(p.getInfo().shape, 'closed', 'barge-in: closed in the same call');
  p.destroy();
});
test('beak: silence in the audio closes it (after the minimum hold) while the analyser stays attached', async () => {
  const { w, p, st, an, v } = await speaking({});
  p.setAnalyser(an); v.frame(0, w.now); v.frame(0.04, w.now + 100); assert.notStrictEqual(p.getInfo().shape, 'closed');
  st.amp = 0; v.frame(0.08, w.now + 120); v.frame(0.12, w.now + 200); assert.strictEqual(p.getInfo().shape, 'closed'); p.destroy();
});
test('device fallback: between start and end a gentle rhythm and word pulses move the beak (never wide); end/cancel close it', async () => {
  const { w, p, v } = await speaking({});
  p.speechEvent('start'); const seen = new Set(); let t0 = w.now;
  for (let i = 0; i < 120; i++) { if (i % 15 === 0) p.speechEvent('boundary'); v.frame(i / 24, t0 + i * 41.7); seen.add(p.getInfo().shape); }
  assert.ok(seen.size >= 2 && seen.has('closed'), 'it opens and closes: ' + [...seen]); assert.ok(!seen.has('wide') && !seen.has('oo'), 'gentle only');
  p.speechEvent('end'); assert.strictEqual(p.getInfo().shape, 'closed'); v.frame(6, t0 + 6000); assert.strictEqual(p.getInfo().shape, 'closed');
  p.speechEvent('start'); for (let i = 0; i < 30; i++) v.frame(7 + i / 24, t0 + 7000 + i * 41.7);
  p.speechEvent('cancel'); assert.strictEqual(p.getInfo().shape, 'closed'); p.destroy();
});
test('beak: speechEvent end gates the analyser (residual samples cannot reopen it); start, resume, boundary and a new analyser lift it', async () => {
  const { w, p, an, v } = await speaking({}); let tm = w.now;
  const frames = () => { tm += 1000; v.frame(0, tm); v.frame(0.04, tm + 100); };
  p.setAnalyser(an); frames(); assert.notStrictEqual(p.getInfo().shape, 'closed');
  p.speechEvent('end'); assert.strictEqual(p.getInfo().shape, 'closed'); frames(); frames(); assert.strictEqual(p.getInfo().shape, 'closed', 'the next frames stay closed on residual samples');
  p.speechEvent('resume'); p.speechEvent('end'); p.speechEvent('boundary'); p.speechEvent('end'); p.setAnalyser(an); frames(); assert.notStrictEqual(p.getInfo().shape, 'closed', 'a (re)attached analyser is open again');
  p.speechEvent('end'); p.speechEvent('start'); p.speechEvent('end'); frames(); assert.strictEqual(p.getInfo().shape, 'closed'); p.destroy();
});
test('level fallback: setLevel moves the beak only while no analyser or device speech runs; garbage counts as 0', async () => {
  const { w, p, an, v } = await speaking({});
  p.setLevel(0.9); v.frame(0, w.now); v.frame(0.04, w.now + 200); assert.strictEqual(p.getInfo().shape, 'wide');
  p.setLevel(NaN); v.frame(0.08, w.now + 400); assert.strictEqual(p.getInfo().shape, 'closed');
  p.setLevel(0.9); p.setAnalyser(analyserOf({ amp: 0, hz: 300 })); v.frame(0.1, w.now + 600); v.frame(0.14, w.now + 800); assert.strictEqual(p.getInfo().shape, 'closed', 'the analyser wins, and it is silent');
  assert.strictEqual(p.setMicLevel(0.5), undefined); p.destroy();
});

// ── reduced motion, hidden, destroy, background ──
test('reduced motion: no clip plays, the video is a still pose, only the beak moves (at the master position); live switching works', async () => {
  const w = makeWorld(); const p = w.make({ reducedMotion: true }); await p.ready; await w.settle(200);
  assert.strictEqual(w.played.length, 0, 'nothing was played'); assert.ok(w.videos.some(v => /idle-/.test(v.clipName || '')), 'a still pose is loaded');
  assert.ok(w.videos.every(v => v.paused)); assert.strictEqual(p.getInfo().reduced, true); assert.strictEqual(p.react('delighted'), true); await w.settle(100); assert.strictEqual(w.played.length, 0);
  const st = { amp: 0.2, hz: 1500 }; p.setAnalyser(analyserOf(st)); p.setState('speaking');
  w.ctxCalls.length = 0; w.tickRaf(16); w.tickRaf(40); w.tickRaf(40);
  const tr = w.ctxCalls.find(c => c[0] === 'translate'); assert.deepStrictEqual(tr.slice(1), [646, 350]); const writes = w.canvasWrites;
  for (let i = 0; i < 10; i++) w.tickRaf(30); assert.strictEqual(w.canvasWrites, writes); assert.strictEqual(w.played.length, 0);
  p.setState('listening'); w.tickRaf(16); w.ctxCalls.length = 0; w.tickRaf(16); assert.ok(!w.ctxCalls.some(c => c[0] === 'drawImage'), 'no beak outside speaking');
  p.setReducedMotion(false); await w.settle(200); assert.ok(w.played.length >= 1); assert.match(p.getInfo().clip, /^listening-/);
  p.setReducedMotion(true); assert.ok(w.front(p).paused); p.destroy();
});
test('reduced motion entered from pose B: the still is the canonical A frame, the beak shows only once that picture is there, late loads are ignored', async () => {
  const clips = [clip('idle-up', 'idle', { endsOn: 'B', dur: 3 }), clip('idle-rest', 'idle', { startsFrom: 'B', endsOn: 'B', dur: 3 }), clip('idle-back', 'idle', { startsFrom: 'B', dur: 2 }), clip('speaking-1', 'speaking', { track: true, beakEnds: 'closed' }), clip('listening-1', 'listening')];
  const w = makeWorld({ manifest: packManifest(clips) }); const p = w.make(); await p.ready; await w.settle(100);
  w.front(p).end(); await w.settle(100); assert.strictEqual(p.getInfo().clip, 'idle-rest'); assert.strictEqual(p.getInfo().pose, 'B');
  w.hold.add('idle-up'); p.setReducedMotion(true);
  assert.strictEqual(p.getInfo().pose, 'A', 'the master pose'); assert.strictEqual(p.getInfo().clip, null);
  const still = w.front(p); assert.strictEqual(still.clipName, 'idle-up', 'an A-start clip, never the first frame of the B clip'); assert.strictEqual(still.paused, true);
  p.setAnalyser(analyserOf({ amp: 0.2, hz: 1500 })); p.setState('speaking'); w.ctxCalls.length = 0; w.tickRaf(16); w.tickRaf(40); w.tickRaf(40);
  assert.ok(!w.ctxCalls.some(c => c[0] === 'drawImage'), 'no beak over a picture that is not there yet');
  still.readyState = 4; still.currentSrc = still.src; still.fire('loadeddata'); w.ctxCalls.length = 0; w.tickRaf(40); w.tickRaf(40);
  assert.deepStrictEqual(w.ctxCalls.find(c => c[0] === 'translate').slice(1), [646, 350]); assert.ok(w.ctxCalls.some(c => c[0] === 'drawImage'));
  p.destroy();
  const w2 = makeWorld({ manifest: packManifest(clips) }); const q = w2.make(); await q.ready; await w2.settle(100); w2.hold.add('idle-up');
  q.setReducedMotion(true); const sv = w2.front(q); w2.hold.delete('idle-up'); q.setReducedMotion(false); await w2.settle(200); const plays = w2.played.length;
  sv.readyState = 4; sv.currentSrc = sv.src; sv.fire('loadeddata'); await w2.settle(200);
  assert.strictEqual(q.getInfo().reduced, false); assert.strictEqual(w2.front(q).paused, false, 'the playing clip was not paused by the late still'); assert.ok(q.getInfo().clip, 'a clip plays again'); assert.strictEqual(w2.played.length, plays, 'the late still started nothing');
  q.destroy();
});
test('hidden: pause when hidden (no frames, no advancing), resume when visible; state changes while hidden apply on return', async () => {
  const { w, p } = await started(); const v = w.front(p); const n = p.getInfo().log.length;
  w.hide(true); assert.strictEqual(v.paused, true); assert.strictEqual(v._rvfc, null, 'frame callbacks cancelled'); assert.strictEqual(p.getInfo().hidden, true);
  p.setState('listening'); await w.settle(15000); assert.strictEqual(p.getInfo().log.length, n, 'nothing advanced while hidden');
  w.hide(false); await w.settle(300); assert.strictEqual(w.front(p).paused, false); assert.match(p.getInfo().clip, /^listening-/); assert.ok(w.front(p)._rvfc, 'frames resume'); p.destroy();
});
test('destroy: cancels timers, frame callbacks, loads and listeners; late events change nothing; safe twice', async () => {
  const { w, p } = await started(); const [a, b] = w.videos; const root = w.container.children[0]; w.front(p).currentTime = 0;
  p.setState('speaking'); p.destroy(); p.destroy();
  assert.strictEqual(w.container.children.length, 0); assert.ok(!root.parentNode); assert.strictEqual(p.getInfo().destroyed, true);
  assert.strictEqual(w.timers.filter(x => !x.tag).length, 0, 'no player timers left'); assert.strictEqual(w.raf.length, 0);
  assert.ok(w.videos.every(v => !v.src || v.attrs.src === undefined) && w.videos.every(v => v.paused));
  const plays = w.played.length, calls = w.ctxCalls.length;
  a.readyState = 4; a.fire('loadeddata'); b.fire('ended'); a.fire('ended'); a.frame(0.5); b.frame(0.5); w.tickRaf(16); await w.settle(5000); w.hide(true); w.hide(false);
  assert.strictEqual(w.played.length, plays); assert.strictEqual(w.ctxCalls.length, calls);
  assert.strictEqual(p.setState('idle'), false); assert.strictEqual(p.react('proud'), false); p.setAnalyser(null); p.speechEvent('start');
  assert.strictEqual(w.docL.visibilitychange.length, 0);
  for (const v of w.videos) for (const e of ['ended', 'loadeddata', 'error']) assert.strictEqual((v.listeners[e] || []).length, 0, 'no ' + e + ' listener left (the ended one was anonymous before)');
  let reads = 0; const an = { context: { sampleRate: 48000 }, fftSize: 2048, frequencyBinCount: 1024, getFloatTimeDomainData() { reads++; }, getFloatFrequencyData() { reads++; } };
  p.setAnalyser(an); p.setLevel(0.9); a.frame(0.5); b.frame(0.5); w.tickRaf(16); assert.strictEqual(reads, 0, 'setAnalyser after destroy is ignored'); assert.strictEqual(p.getInfo().shape, 'closed');
});
test('destroy before ready: nothing starts afterwards', async () => {
  const w = makeWorld(); const p = w.make(); p.destroy(); await p.ready.catch(() => {}); await w.settle(3000);
  assert.strictEqual(w.played.length, 0); assert.strictEqual(w.container.children.length, 0); assert.strictEqual(w.timers.length, 0);
});
test('background: the manifest colour is used; without one the first frame edge is sampled; garbage colours are ignored', async () => {
  const noBg = Object.assign(packManifest(), { background: undefined });
  const w = makeWorld({ manifest: noBg }); const p = w.make(); await p.ready; await w.settle(200);
  assert.strictEqual(w.container.children[0].style.background, 'rgb(100,100,100)'); p.destroy();
  const w2 = makeWorld({ manifest: Object.assign(packManifest(), { background: 'url(javascript:x)' }) }); const p2 = w2.make(); await p2.ready; await w2.settle(200);
  assert.match(w2.container.children[0].style.background, /^rgb\(/); p2.destroy();
});
test('resize: a container size change updates the canvas once (device pixels, capped), not per frame', async () => {
  const { w, p } = await started({}, { dpr: 2, w: 400, h: 225 }); assert.strictEqual(p.getInfo().canvasW, 800);
  p.destroy();
});

// ── start-up picture, feathered edges, portrait ── (fake DOM: these prove the logic and the numbers, not how it looks in a browser)
const near = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-6, (m || 'value') + ': ' + a + ' vs ' + b);
test('startup: the idle still is on the stage before the player is ready, and ready is not declared on an empty stage', async () => {
  const w = makeWorld(); w.hold.add('idle-a1'); const p = w.make(); let done = false; p.ready.then(() => { done = true; });
  await w.settle(1000); assert.strictEqual(done, false, 'the still has not loaded: not ready yet');
  assert.strictEqual(w.videos[0].clipName, 'idle-a1', 'an existing idle clip (pose A, no beak track) is the still');
  await w.settle(4000); assert.strictEqual(done, true, 'bounded wait: ready follows even if the still never arrives'); assert.strictEqual(p.getInfo().still, false); p.destroy();
  const w2 = makeWorld(); const q = w2.make(); await q.ready;
  assert.strictEqual(q.getInfo().still, true, 'ready means the still is really there'); assert.strictEqual(w2.videos[0].readyState, 4);
  assert.strictEqual(w2.videos[0].style.opacity, '1'); assert.strictEqual(w2.videos[0].paused, true, 'the still is a paused first frame'); q.destroy();
});
test('startup: the still stays on top until the first clip is really playing (not merely loaded), then the clip takes the front', async () => {
  const w = makeWorld(); w.noPlaying = true; const p = w.make(); await p.ready; await w.settle(400);
  const [a, b] = w.videos, info = p.getInfo();
  assert.strictEqual(info.covered, true); assert.strictEqual(b.readyState, 4, 'the clip has loaded data'); assert.strictEqual(b.paused, false);
  assert.strictEqual(a.style.zIndex, '2'); assert.strictEqual(a.style.opacity, '1'); assert.strictEqual(b.style.zIndex, '1', 'loadeddata alone does not bring the clip forward');
  b.fire('playing');
  assert.strictEqual(p.getInfo().covered, false); assert.strictEqual(b.style.zIndex, '2'); assert.strictEqual(a.style.opacity, '0'); assert.strictEqual(a.paused, true); assert.strictEqual(p.getInfo().still, false); p.destroy();
});
test('startup: a playing event of a video that is not in front does nothing; no beak over the held still', async () => {
  const w = makeWorld(); w.noPlaying = true; const p = w.make(); await p.ready; await w.settle(300);
  w.videos[0].fire('playing'); assert.strictEqual(p.getInfo().covered, true, 'the still itself playing does not release it');
  assert.ok(!w.ctxCalls.some(c => c[0] === 'drawImage' && c[1] && c[1].tag === 'img'), 'no beak patch over the held still (the poster canvas copy of the video frame is not a beak patch)'); p.destroy();
});
test('startup: no playing event at all keeps the still beyond 2 s (and well after), retries play a bounded number of times, then a real playing releases it', async () => {
  const w = makeWorld(); w.noPlaying = true; const p = w.make(); await p.ready; await w.settle(300);
  const a = w.videos[0], b = w.videos[1], plays0 = b.plays;
  await w.settle(2500); assert.strictEqual(p.getInfo().covered, true, 'not playing: the still is not given up after 2 s');
  assert.strictEqual(a.style.zIndex, '2'); assert.strictEqual(a.style.opacity, '1'); assert.strictEqual(a.clipName, 'idle-a1');
  await w.settle(3000); await w.settle(3000); await w.settle(3000);
  assert.strictEqual(p.getInfo().covered, true, 'still held while nothing plays'); assert.strictEqual(a.clipName, 'idle-a1', 'the held still was never reloaded');
  const nudges = w.videos.reduce((n, v) => n + v.plays, 0) - plays0; assert.ok(nudges <= 12, 'bounded play retries: ' + nudges);
  const front = w.front(p); front.fire('playing');
  assert.strictEqual(p.getInfo().covered, false, 'a real playing event releases it'); assert.strictEqual(front.style.zIndex, '2'); assert.strictEqual(a.style.opacity, '0'); p.destroy();
});
test('startup: a stale playing event (other resource, or a paused video) does not release the still', async () => {
  const w = makeWorld(); w.noPlaying = true; const p = w.make(); await p.ready; await w.settle(300);
  const b = w.front(p), real = b.currentSrc;
  b.currentSrc = 'http://x/web/other-old.mp4'; b.fire('playing'); assert.strictEqual(p.getInfo().covered, true, 'an event of an earlier resource is ignored');
  b.currentSrc = real; b.paused = true; b.fire('playing'); assert.strictEqual(p.getInfo().covered, true, 'a paused video is not playing');
  b.paused = false; b.fire('playing'); assert.strictEqual(p.getInfo().covered, false); p.destroy();
});
test('startup: a state change while the still is held keeps it; the new clip loads under it, background planning never touches the still slot', async () => {
  const w = makeWorld(); w.noPlaying = true; const p = w.make(); await p.ready; await w.settle(300); assert.strictEqual(p.getInfo().covered, true);
  const a = w.videos[0], loads = a.loads; p.setState('speaking'); await w.settle(1500);
  assert.strictEqual(p.getInfo().covered, true, 'the new request does not drop the still'); assert.strictEqual(a.clipName, 'idle-a1'); assert.strictEqual(a.loads, loads, 'the still slot was never reloaded (planAhead or a new start)');
  assert.strictEqual(a.style.zIndex, '2'); assert.strictEqual(a.style.opacity, '1');
  const front = w.front(p); assert.notStrictEqual(front, a); assert.match(front.clipName, /^speaking-/, 'the newest request is the clip under the still');
  front.fire('playing'); assert.strictEqual(p.getInfo().covered, false); assert.strictEqual(front.style.zIndex, '2'); assert.strictEqual(a.style.opacity, '0');
  await w.settle(600); assert.ok(p.getInfo().clip, 'planning resumes after the release'); p.destroy();
});
test('startup: the held first clip errors: it is set aside, the still stays, another clip is tried; nothing pretends to play', async () => {
  const w = makeWorld(); w.noPlaying = true; const p = w.make(); await p.ready; await w.settle(300);
  const a = w.videos[0], b = w.front(p), first = b.clipName;
  b.fire('error'); await w.settle(300);
  assert.ok(p.getInfo().bad.indexOf(first) >= 0, 'the broken clip is set aside'); assert.strictEqual(p.getInfo().covered, true); assert.strictEqual(a.clipName, 'idle-a1'); assert.strictEqual(a.style.zIndex, '2');
  p.destroy();
});
test('startup: destroy while the still is held leaves no pending timers of the player', async () => {
  const w = makeWorld(); w.noPlaying = true; const p = w.make(); await p.ready; await w.settle(300); p.destroy();
  assert.strictEqual(w.timers.filter(x => !x.tag).length, 0, 'nothing of the player is left to fire');
});
test('startup: a state change while a clip is playing under no still behaves as before (no hold)', async () => {
  const w = makeWorld(); const p = w.make(); await p.ready; await w.settle(600); assert.strictEqual(p.getInfo().covered, false);
  p.setState('speaking'); await w.settle(600); assert.strictEqual(p.getInfo().covered, false); p.destroy();
});
test('reopen: a new player on the same container shows the still again, never a blank stage, and the old one leaves nothing behind', async () => {
  const w = makeWorld(); const p = w.make(); await p.ready; await w.settle(300); p.destroy();
  assert.strictEqual(w.container.children.length, 0, 'the first stage is removed');
  w.noPlaying = true; const q = w.make(); await q.ready;
  const front = w.videos[w.videos.length - 2];   // the new player's first video
  assert.strictEqual(q.getInfo().still, true); assert.strictEqual(front.clipName, 'idle-a1'); assert.strictEqual(front.style.opacity, '1'); assert.strictEqual(front.style.zIndex, '2');
  assert.strictEqual(q.getInfo().covered, false, 'covered only once a clip is waiting behind it'); await w.settle(300); assert.strictEqual(q.getInfo().covered, true); q.destroy();
});
test('fallback: no usable still (it fails to load) still starts normally; a failing first clip keeps the still up and another plays', async () => {
  const w = makeWorld(); w.fail.add('idle-a1'); const p = w.make(); await p.ready; await w.settle(500);
  assert.strictEqual(p.getInfo().still, false); assert.ok(p.getInfo().bad.indexOf('idle-a1') >= 0); assert.ok(p.getInfo().clip, 'a clip plays'); assert.strictEqual(p.getInfo().covered, false); p.destroy();
  const w2 = makeWorld(packManifest(packClips().filter(c => c.state !== 'idle'))); w2.manifest.clips = w2.manifest.clips.filter(c => c.state !== 'idle');
  const q = w2.make(); await q.ready; await w2.settle(400); assert.strictEqual(q.getInfo().still, true, 'a pose-A non-track clip of another state is the still'); q.destroy();
});
test('edges: every layout fades over 5 percent of the stage at most (landscape and portrait alike)', async () => {
  const { w, p } = await started(); const stage = w.container.children[0].children[0];
  const m = stage.style.maskImage;
  assert.match(m, /to right, transparent 0%, #000 5%, #000 95%, transparent 100%/); assert.match(m, /to bottom, transparent 0%, #000 5%, #000 95%, transparent 100%/);
  assert.strictEqual(p.getInfo().stage.featherY, 0.05);
  const pr = await started({}, { w: 390, h: 800 }), sp = pr.w.container.children[0].children[0];   // portrait: the same mask, the stage there is the short band of the picture
  assert.match(sp.style.maskImage, /to bottom, transparent 0%, #000 5%, #000 95%, transparent 100%/); assert.match(sp.style.maskImage, /to right, transparent 0%, #000 5%, #000 95%, transparent 100%/); assert.strictEqual(pr.p.getInfo().stage.portrait, true); assert.strictEqual(pr.p.getInfo().stage.featherY, 0.05); pr.p.destroy();
  assert.strictEqual(stage.style.maskComposite, 'intersect'); assert.strictEqual(stage.style.webkitMaskImage, m); assert.strictEqual(stage.style.webkitMaskComposite, 'source-in');
  assert.strictEqual(stage.children.length, 3, 'both videos and the poster canvas are in the masked stage'); assert.deepStrictEqual(stage.children.map(c => c.tag), ['video', 'video', 'canvas']);
  assert.ok(!w.container.children[0].children.slice(1).some(c => c.style.maskImage), 'the beak canvas is not masked');
  assert.strictEqual(p.getInfo().stage.feather, 0.05); p.destroy();
});
test('landscape: geometry is the plain fit (whole picture, letterboxed in a wider view); the stage is the picture', async () => {
  const { p } = await started({}, { w: 800, h: 450 }); let s = p.getInfo().stage;
  near(s.x, 0); near(s.y, 0); near(s.w, 800); near(s.h, 450); near(s.picture.scale, 0.625); assert.strictEqual(s.portrait, false); p.destroy();
  const r = await started({}, { w: 1000, h: 450 }); s = r.p.getInfo().stage;
  near(s.picture.scale, 0.625); near(s.x, 100); near(s.w, 800); near(s.h, 450); r.p.destroy();
});
test('portrait: the central 70 percent of the width at full height is fitted (wide wing gestures stay in view), the empty sides are cropped; video and beak share one transform', async () => {
  const { w, p } = await started({}, { w: 390, h: 800 }); const s = p.getInfo().stage;
  const k = 390 / 896;   // width-limited: 896 safe px (70%) fill the 390 view; the default safe area is at least 65%
  assert.ok(k <= 390 / (1280 * 0.65) + 1e-9, 'default portrait safe area is >= 65% of the width');
  assert.strictEqual(s.portrait, true); near(s.picture.scale, k); near(s.picture.w, 1280 * k); near(s.picture.x, -(1280 * k - 390) / 2);
  near(s.x, 0); near(s.w, 390, 'the stage is the visible part: cut to the view'); near(s.h, 720 * k); near(s.y, (800 - 720 * k) / 2); near(s.picture.y, s.y);
  const sl = w.videos[0].style; assert.strictEqual(sl.width, Math.round(1280 * k * 100) / 100 + 'px'); assert.strictEqual(sl.left, Math.round(-(1280 * k - 390) / 2 * 100) / 100 + 'px'); assert.strictEqual(sl.top, '0px');
  // the safe area (x 192..1088) is exactly the view width: its left/right edges land on the stage edges
  near(s.picture.x + 192 * k, 0); near(s.picture.x + 1088 * k, 390);
  // the beak canvas uses the same origin and scale (DPR 1)
  p.setState('speaking'); await w.settle(100); const v = w.front(p); const st = { amp: 0.2, hz: 1500 }; p.setAnalyser(analyserOf(st));
  v.frame(12 / 24, w.now); v.frame(12 / 24, w.now + 16.7); w.ctxCalls.length = 0; v.frame(12 / 24, w.now + 40);
  const tf = w.ctxCalls.filter(c => c[0] === 'setTransform')[1]; near(tf[1], k); near(tf[4], k); near(tf[5], s.picture.x); near(tf[6], s.picture.y);
  p.destroy();
});
test('portrait: a resize between portrait and landscape re-lays the stage once, a wider safe area is an option, garbage is ignored', async () => {
  let fire = null; const RO = function (cb) { fire = cb; this.observe = () => {}; this.disconnect = () => {}; };
  const { w, p } = await started({ ResizeObserver: RO }, { w: 800, h: 450 }); assert.strictEqual(p.getInfo().stage.portrait, false);
  w.container.clientWidth = 400; w.container.clientHeight = 800; fire();
  let s = p.getInfo().stage; assert.strictEqual(s.portrait, true); near(s.picture.scale, 400 / 896); near(s.w, 400); assert.strictEqual(parseFloat(w.videos[0].style.width), Math.round(1280 * 400 / 896 * 100) / 100);
  w.container.clientWidth = 800; w.container.clientHeight = 450; fire(); s = p.getInfo().stage; assert.strictEqual(s.portrait, false); near(s.picture.scale, 0.625); near(s.w, 800);
  p.destroy();
  const r = await started({ portraitSafe: 0.5 }, { w: 390, h: 800 }); near(r.p.getInfo().stage.picture.scale, 390 / (1280 * 0.5)); r.p.destroy();
  const g = await started({ portraitSafe: 5 }, { w: 390, h: 800 }); near(g.p.getInfo().stage.picture.scale, 390 / 896, 'out of range falls back to the 0.7 default'); g.p.destroy();
  const sq = await started({}, { w: 600, h: 600 }); assert.strictEqual(sq.p.getInfo().stage.portrait, false, 'a square view is not portrait'); assert.strictEqual(sq.p.getInfo().stage.narrow, true, 'but it is narrower than 16:9');
  near(sq.p.getInfo().stage.picture.scale, 600 / 896, 'the 70 percent box width fits the square view'); sq.p.destroy();
});

test('resize(): a player built in a detached host (measured the 640x360 fallback) is laid out for its real size at once, without the ResizeObserver callback', async () => {
  let fired = 0; const RO = function () { this.observe = () => {}; this.disconnect = () => {}; this.unused = () => { fired++; }; };   // a callback that never comes
  const w = makeWorld(); w.container.clientWidth = 0; w.container.clientHeight = 0;   // a detached host: no layout yet
  const p = w.make({ ResizeObserver: RO }); await p.ready; await w.settle(100);
  let s = p.getInfo().stage; near(s.w, 640); near(s.h, 360);   // detached: clientWidth/Height 0 -> the fallback size
  w.container.clientWidth = 1280; w.container.clientHeight = 715;   // the host is now in the page (the call display mounted it)
  p.resize();
  s = p.getInfo().stage;
  near(s.picture.scale, 715 / 720); near(s.h, 715); near(s.y, 0); near(s.picture.x, (1280 - 1280 * 715 / 720) / 2);
  assert.strictEqual(parseFloat(w.videos[0].style.height), Math.round(720 * 715 / 720 * 100) / 100, 'the clips are laid out for the real size');
  assert.strictEqual(fired, 0, 'no observer callback was needed');
  p.destroy(); p.resize();   // destroyed: a no-op, never throws
});

test('cancelReaction: a mood clip that has not started (waiting for the playing clip, or for the pack) is dropped; one playing finishes; hello and goodbye are kept', async () => {
  const { w, p } = await started(); p.setState('listening'); await w.settle(100);
  p.react('delighted'); await w.settle(100); assert.strictEqual(p.getInfo().clip, 'reaction-delighted-1');
  p.react('proud'); assert.strictEqual(p.getInfo().pending, 'proud');
  assert.strictEqual(p.cancelReaction(), true); assert.strictEqual(p.getInfo().pending, null);
  w.front(p).end(); await w.settle(100); assert.match(p.getInfo().clip, /^listening-/, 'the cancelled one never plays; the playing one was not cut');
  assert.strictEqual(p.cancelReaction(), false, 'nothing left to drop');
  p.destroy();
  const w2 = makeWorld(); const p2 = w2.make();   // not ready yet: the asked-for reaction waits for the pack
  assert.strictEqual(p2.react('proud'), true); assert.strictEqual(p2.cancelReaction(), true);
  assert.strictEqual(p2.react('hello'), true); assert.strictEqual(p2.cancelReaction(), false, 'a hello is not a mood');
  p2.destroy();
});

// ── a real first picture before anything is shown (drawable): decoded AND presented, bounded, never a drawn placeholder ──
test('blank start: a cold first frame that is decoded but not yet presented keeps ready (and drawable) waiting; the presented frame releases it at once', async () => {
  const w = makeWorld(); const p = w.make(); let done = false; p.ready.then(() => { done = true; });
  await w.settle(120); assert.strictEqual(w.videos[0].readyState, 4, 'loadeddata fired: data is there'); assert.strictEqual(done, false, 'data alone is not a picture on screen');
  assert.strictEqual(p.getInfo().drawable, false); assert.ok(typeof w.videos[0]._rvfc === 'function', 'the player asked to be told when a frame is presented');
  w.videos[0].frame(0, w.now); await p.ready; assert.strictEqual(p.getInfo().still, true); assert.strictEqual(p.getInfo().drawable, true); p.destroy();
  const w2 = makeWorld(); const q = w2.make(); await w2.settle(700); await q.ready;   // a browser that never reports the frame: bounded, not an endless wait
  assert.strictEqual(q.getInfo().drawable, true, 'the bounded wait ends with the still shown'); q.destroy();
});
test('blank start: a missing or rejected poster is set aside and the next one is shown; with none at all ready still resolves, drawable false', async () => {
  const w = makeWorld(); w.fail.add('idle-a1'); const p = w.make(); await p.ready;
  assert.ok(p.getInfo().bad.indexOf('idle-a1') >= 0); assert.strictEqual(p.getInfo().still, true, 'another A-pose clip is the still'); assert.notStrictEqual(w.videos[0].clipName, 'idle-a1'); assert.strictEqual(p.getInfo().drawable, true); p.destroy();
  const w2 = makeWorld(); const m = w2.manifest; m.clips.forEach(c => w2.fail.add(c.name)); const q = w2.make(); await q.ready;
  assert.strictEqual(q.getInfo().still, false); assert.strictEqual(q.getInfo().drawable, false, 'nothing real to show: it never claims a picture'); assert.strictEqual(w2.ctxCalls.filter(c => c[0] === 'drawImage').length, 0, 'no placeholder drawing'); q.destroy();
});
test('blank start: a still that is too slow ends the wait; drawable turns true only when a clip is really playing in front', async () => {
  const w = makeWorld(); w.hold.add('idle-a1'); const p = w.make(); await w.settle(4500); await p.ready;
  assert.strictEqual(p.getInfo().still, false); assert.strictEqual(p.getInfo().drawable, false, 'ready, but no picture yet');
  await w.settle(9000); assert.strictEqual(p.getInfo().drawable, true, 'the first clip played in front'); p.destroy();
});
test('blank start: destroy while the first frame is pending leaves no timer, and a late frame or load changes nothing (release / reopen)', async () => {
  const w = makeWorld(); const p = w.make(); await w.settle(120); p.destroy();
  assert.strictEqual(w.timers.filter(x => !x.tag).length, 0, 'nothing of the player is left to fire'); w.videos[0].frame(0, w.now); w.videos[0].fire('loadeddata');
  assert.strictEqual(p.getInfo().drawable, false); assert.strictEqual(p.getInfo().still, false);
  const q = w.make(); await w.settle(120); assert.strictEqual(q.getInfo().drawable, false, 'a reopened player starts undrawn, never inheriting the old one'); w.videos[w.videos.length - 2].frame(0, w.now); await q.ready; assert.strictEqual(q.getInfo().drawable, true); q.destroy();
});
test('blank start: reduced motion still shows the real A still (drawable) and plays nothing', async () => {
  const w = makeWorld(); const p = w.make({ reducedMotion: true }); await p.ready; await w.settle(700);
  assert.strictEqual(p.getInfo().drawable, true); assert.strictEqual(w.played.length, 0, 'nothing was played'); assert.strictEqual(w.videos[0].style.opacity, '1'); p.destroy();
});

test('poster: the decoded first frame is painted into a canvas in the stage (same rectangle as the video) before drawable, held until a frame is presented while playing', async () => {
  const w = makeWorld({ videoSize: true }); const p = w.make(); await w.settle(120);
  const stage = w.container.children[0].children[0], poster = stage.children[2]; assert.strictEqual(poster.tag, 'canvas');
  assert.strictEqual(p.getInfo().poster, false); assert.strictEqual(p.getInfo().drawable, false, 'decoded but not presented: not drawable, no poster yet');
  w.videos[0].frame(0, w.now); await p.ready;
  const di = w.ctxCalls.filter(c => c[0] === 'drawImage' && c[1] && c[1].tag === 'video'); assert.strictEqual(di.length, 1, 'the first frame was copied once');
  assert.strictEqual(poster.width, 1280); assert.strictEqual(poster.height, 720);
  assert.strictEqual(p.getInfo().poster, true); assert.strictEqual(p.getInfo().drawable, true); assert.strictEqual(poster.style.display, 'block');
  assert.strictEqual(poster.style.width, w.videos[0].style.width); assert.strictEqual(poster.style.left, w.videos[0].style.left); assert.strictEqual(poster.style.zIndex, '3');
  await w.settle(100);   // the first clip plays under the held still: playing event is not enough, a presented frame is
  assert.strictEqual(p.getInfo().poster, true, 'playing alone does not remove the poster');
  const f = w.front(p); f.frame(0.05, w.now);
  assert.strictEqual(p.getInfo().poster, false); assert.strictEqual(poster.style.display, 'none'); p.destroy();
});
test('poster: no frame callback ends in a bounded wait; destroy and reduced motion leave no timer', async () => {
  const w = makeWorld({ videoSize: true }); const p = w.make(); await w.settle(700); await p.ready; await w.settle(700);
  assert.strictEqual(p.getInfo().poster, false, 'a browser with no frame callback still releases the poster once the clip plays (bounded)');
  p.destroy(); assert.strictEqual(w.timers.length, 0, 'destroy leaves no timer');
  const r = makeWorld({ videoSize: true }); const q = r.make({ reducedMotion: true }); await r.settle(700); await q.ready; r.videos[0].frame(0, r.now);
  assert.strictEqual(q.getInfo().poster, true, 'reduced motion shows the poster of the A still'); q.destroy(); assert.strictEqual(r.timers.length, 0);
});

// ── optional pack poster image and measured portrait safe area (all fields optional; old packs behave exactly as before) ──
const SAFE = { x: 0.25, y: 0.1, w: 0.5, h: 0.6 };
const posterManifest = (extra) => packManifest(null, Object.assign({ poster: 'poster.webp', posters: { A: 'poster.webp', B: 'art/rest.png', C: 'ignored.gif', future: 1 } }, extra || {}));
const isPosterDraw = (w, c) => c[0] === 'drawImage' && c[1] && c[1].tag === 'img' && /poster\.webp$/.test(c[1]._s || '') && c[4] === 1920;   // the full-size paint into the poster canvas (the 32x18 background-ring sample is a different draw)
const isFrameCopy = (c) => c[0] === 'drawImage' && c[1] && c[1].tag === 'video' && c[4] === 1280;

test('manifest: poster / posters / safeArea / safeAreaTypical are normalised; bad values and old manifests give null (the fallback)', () => {
  const n = (extra) => faceNormalizeManifest(Object.assign({ clips: packClips() }, extra));
  let m = n(); assert.strictEqual(m.poster, null); assert.strictEqual(m.posters, null); assert.strictEqual(m.safeArea, null); assert.strictEqual(m.safeAreaTypical, null, 'an old manifest has none of them');
  m = n({ poster: 'art/p.JPG', posters: { A: 'art/p.JPG', B: 'b.png', C: 'no way', zzz: 3 }, safeArea: SAFE, safeAreaTypical: { x: 0, y: 0, w: 1, h: 1 } });
  assert.strictEqual(m.poster, 'art/p.JPG'); assert.deepStrictEqual(m.posters, { A: 'art/p.JPG', B: 'b.png' }, 'unknown keys are allowed and ignored');
  assert.deepStrictEqual(m.safeArea, SAFE); assert.deepStrictEqual(m.safeAreaTypical, { x: 0, y: 0, w: 1, h: 1 });
  assert.strictEqual(n({ poster: 'p.webp' }).poster, 'p.webp', 'poster alone (no posters) is fine');
  for (const bad of ['/abs.png', '../x.png', 'a/../x.png', 'a..b.png', 'x.gif', 'x.svg', 'x', '', 'a//b.png', 'a b.png', 'a%2fb.png', 'a\\b.png', '.hidden.png', 7, null, {}, [], 'x'.repeat(300) + '.png'])
    assert.strictEqual(n({ poster: bad }).poster, null, 'bad poster ' + JSON.stringify(bad));
  assert.strictEqual(n({ poster: 'p.png', posters: { A: 'q.png' } }).poster, null, 'posters present: poster must equal posters.A');
  assert.strictEqual(n({ poster: 'p.png', posters: { B: 'p.png' } }).poster, null, 'posters present without A');
  assert.strictEqual(n({ poster: 'p.png', posters: 'p.png' }).poster, null, 'posters of the wrong type'); assert.strictEqual(n({ posters: { A: 'p.png' } }).poster, null, 'posters.A without poster');
  const bads = [{ x: 0, y: 0, w: 1, h: 1, extra: 1 }, { x: -0.1, y: 0, w: 0.5, h: 0.5 }, { x: 0.6, y: 0, w: 0.5, h: 0.5 }, { x: 0, y: 0.6, w: 0.5, h: 0.5 }, { x: 0, y: 0, w: 0, h: 1 }, { x: 0, y: 0, w: 1, h: -1 }, { x: '0', y: 0, w: 1, h: 1 },
    { x: NaN, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: Infinity, h: 1 }, { x: 0, y: 0, w: 1, h: 1.0001 }, { x: 0, y: 0, w: 0.5 }, [0, 0, 1, 1], null, 5, 'x'];
  for (const b of bads) { assert.strictEqual(n({ safeArea: b }).safeArea, null, 'bad safeArea ' + JSON.stringify(b)); assert.strictEqual(n({ safeAreaTypical: b }).safeAreaTypical, null); }
  assert.deepStrictEqual(n({ safeArea: { x: 0, y: 0, w: 1, h: 1 } }).safeArea, { x: 0, y: 0, w: 1, h: 1 }, 'the whole picture is valid');
  assert.deepStrictEqual(n({ safeArea: { x: 0.3, y: 0.7, w: 0.7, h: 0.3 } }).safeArea, { x: 0.3, y: 0.7, w: 0.7, h: 0.3 }, 'x+w and y+h may reach 1');
});
test('urls: a poster is requested only from a valid manifest-named path under /api/faces/<id>/', () => {
  const u = faceUrls('owl');
  assert.strictEqual(u.poster('poster.webp'), '/api/faces/owl/poster.webp'); assert.strictEqual(u.poster('art/p-1.png'), '/api/faces/owl/art/p-1.png');
  for (const bad of ['../x.png', '/x.png', 'x.gif', '//host/x.png', 'a/../b.png', null, undefined, 5]) assert.strictEqual(u.poster(bad), null);
});

test('safeArea: portrait fits the measured box and centres it in the view, x and y offsets included; the manifest safeArea replaces the 70 percent default', async () => {
  const { w, p } = await started({}, { w: 390, h: 800, manifest: packManifest(null, { safeArea: SAFE }) }); const s = p.getInfo().stage, k = 390 / 640;
  assert.deepStrictEqual(s.safeArea, SAFE); assert.strictEqual(s.portrait, true);
  near(s.picture.scale, k); near(s.picture.x, -195); near(s.picture.y, 224.5);
  near(s.picture.x + (SAFE.x + SAFE.w / 2) * 1280 * k, 195, 'box centre x = view centre'); near(s.picture.y + (SAFE.y + SAFE.h / 2) * 720 * k, 400, 'box centre y = view centre');
  near(s.picture.x + SAFE.x * 1280 * k, 0, 'width-limited: the box edges are the view edges'); near(s.picture.x + (SAFE.x + SAFE.w) * 1280 * k, 390);
  assert.strictEqual(w.videos[0].style.left, '-195px', 'the video sits at the picture position inside the stage'); near(s.y, 224.5); near(s.h, 720 * k);
  p.setState('speaking'); await w.settle(100); const v = w.front(p); p.setAnalyser(analyserOf({ amp: 0.2, hz: 1500 }));
  v.frame(12 / 24, w.now); v.frame(12 / 24, w.now + 16.7); w.ctxCalls.length = 0; v.frame(12 / 24, w.now + 40);
  const tf = w.ctxCalls.filter(c => c[0] === 'setTransform')[1]; near(tf[1], k); near(tf[5], s.picture.x); near(tf[6], s.picture.y, 'the beak canvas shares the same offset'); p.destroy();
  const t = await started({}, { w: 300, h: 400, manifest: packManifest(null, { safeArea: { x: 0.4, y: 0, w: 0.2, h: 1 } }) }), ts = t.p.getInfo().stage;   // height-limited
  near(ts.picture.scale, 400 / 720); near(ts.picture.x, 150 - 640 * 400 / 720); near(ts.picture.y, 0); t.p.destroy();
});
test('safeArea: a 16:9 or wider view is unchanged by it (the whole picture); a malformed or missing one keeps the 70 percent default', async () => {
  const l = await started({}, { w: 800, h: 450, manifest: packManifest(null, { safeArea: SAFE }) }); let s = l.p.getInfo().stage;
  near(s.picture.scale, 0.625); near(s.x, 0); near(s.w, 800); near(s.picture.x, 0); near(s.picture.y, 0); assert.strictEqual(s.narrow, false); l.p.destroy();
  const q = await started({}, { w: 600, h: 600, manifest: packManifest(null, { safeArea: SAFE }) }); near(q.p.getInfo().stage.picture.scale, 600 / 720, 'square: the box width would need 600/640, the full height caps it at 600/720'); q.p.destroy();
  for (const extra of [{}, { safeArea: { x: 0.8, y: 0, w: 0.5, h: 1 } }, { safeArea: 'wide' }, { safeAreaTypical: { x: 0.8, y: 0, w: 0.5, h: 1 }, safeAreaComfort: 'x' }, { safeArea: { x: 0, y: 0, w: 0, h: 0 }, safeAreaTypical: { x: 0, y: 0, w: 0, h: 1 } }]) {
    const r = await started({}, { w: 390, h: 800, manifest: packManifest(null, extra) }); s = r.p.getInfo().stage;
    near(s.picture.scale, 390 / 896, JSON.stringify(extra)); near(s.picture.x, -(1280 * 390 / 896 - 390) / 2); near(s.y, (800 - 720 * 390 / 896) / 2); near(s.safeArea.x, 0.15); near(s.safeArea.w, 0.7); r.p.destroy();
  }
  const o = await started({ portraitSafe: 0.5 }, { w: 390, h: 800, manifest: packManifest(null, { safeArea: SAFE }) }); near(o.p.getInfo().stage.picture.scale, 390 / 640, 'the measured box wins over the option'); o.p.destroy();
});

test('poster image: the manifest poster is loaded and decoded first, requested through the pack asset path, and painted instead of a captured video frame', async () => {
  const w = makeWorld({ manifest: posterManifest() }); const p = w.make(); await p.ready;
  assert.deepStrictEqual(w.posterReqs, ['/api/faces/owl/poster.webp']);
  const stage = w.container.children[0].children[0], pc = stage.children[2];
  assert.strictEqual(pc.width, 1920); assert.strictEqual(pc.height, 1080, 'the poster canvas has the image size');
  assert.strictEqual(w.ctxCalls.filter(c => isPosterDraw(w, c)).length, 1, 'the image was drawn into the poster canvas'); assert.strictEqual(w.ctxCalls.filter(isFrameCopy).length, 0, 'no video frame was copied when the image is there');
  const i = p.getInfo(); assert.strictEqual(i.posterImage, true); assert.strictEqual(i.poster, true); assert.strictEqual(i.drawable, true); assert.strictEqual(pc.style.display, 'block');
  assert.strictEqual(pc.style.width, w.videos[0].style.width, 'same picture rectangle as the video'); p.destroy();
});
test('poster image: it is released only after the front video has presented a frame (no frame callback: bounded), never by playing alone', async () => {
  const w = makeWorld({ manifest: posterManifest() }); const p = w.make(); await p.ready; await w.settle(100);
  assert.strictEqual(p.getInfo().poster, true, 'the clip plays under the still: playing alone keeps the poster');
  w.front(p).frame(0.05, w.now); assert.strictEqual(p.getInfo().poster, false); assert.strictEqual(w.container.children[0].children[0].children[2].style.display, 'none'); p.destroy();
});
test('poster image: missing, undecodable, empty or too slow falls back to the actual video frame; the pack still starts, nothing is claimed it does not have', async () => {
  for (const mode of ['error', 'empty']) {
    const w = makeWorld({ manifest: posterManifest(), posterFail: mode }); const p = w.make(); await p.ready;
    assert.strictEqual(p.getInfo().posterImage, false, mode); assert.strictEqual(w.ctxCalls.filter(isFrameCopy).length, 1, mode + ': the actual frame is copied'); assert.strictEqual(p.getInfo().drawable, true); assert.strictEqual(p.getInfo().still, true); p.destroy();
  }
  const w = makeWorld({ manifest: posterManifest(), posterHold: true }); const p = w.make(); await w.settle(1500);
  assert.strictEqual(p.getInfo().still, false, 'nothing is shown before the poster is decoded (bounded wait)'); assert.strictEqual(p.getInfo().poster, false); assert.strictEqual(p.getInfo().drawable, false);
  await w.settle(4000); await p.ready; assert.strictEqual(p.getInfo().posterImage, false); assert.strictEqual(w.ctxCalls.filter(isFrameCopy).length, 1, 'the poster wait ended and the actual frame was copied'); assert.strictEqual(p.getInfo().drawable, true);
  p.destroy(); assert.strictEqual(w.timers.filter(x => !x.tag).length, 0, 'destroy cancelled the poster wait');
});
test('poster image: an invalid path or a poster/posters.A mismatch is never requested; a pack without poster behaves as before; destroy during the load leaves nothing', async () => {
  for (const extra of [{ poster: '../x.png' }, { poster: '/x.png' }, { poster: 'x.gif' }, { poster: 'p.png', posters: { A: 'q.png' } }, { poster: 'p.png', posters: [] }, { posters: { A: 'p.png' } }, {}]) {
    const w = makeWorld({ manifest: packManifest(null, extra) }); const p = w.make(); await p.ready;
    assert.deepStrictEqual(w.posterReqs, [], JSON.stringify(extra)); assert.strictEqual(w.ctxCalls.filter(isFrameCopy).length, 1, 'the actual frame is the poster'); assert.strictEqual(p.getInfo().posterImage, false); p.destroy();
  }
  const w = makeWorld({ manifest: posterManifest(), posterHold: true }); const p = w.make(); await w.settle(100); p.destroy();
  assert.strictEqual(w.timers.filter(x => !x.tag).length, 0); assert.strictEqual(p.getInfo().posterImage, false);
});
test('poster image: reduced motion shows it as the A still; hiding while it is up does not drop it early, and it goes only after a frame is presented on return', async () => {
  const r = makeWorld({ manifest: posterManifest() }); const q = r.make({ reducedMotion: true }); await q.ready; await r.settle(700);
  assert.strictEqual(q.getInfo().poster, true); assert.strictEqual(q.getInfo().posterImage, true); assert.strictEqual(r.played.length, 0); q.destroy();
  const w = makeWorld({ manifest: posterManifest() }); const p = w.make(); await p.ready; await w.settle(100);
  assert.strictEqual(p.getInfo().poster, true); w.hide(true); await w.settle(700);
  assert.strictEqual(p.getInfo().poster, true, 'paused while hidden: no frame was presented, the poster stays');
  w.hide(false); assert.strictEqual(p.getInfo().poster, true, 'visible again: still waiting for a presented frame'); w.front(p).frame(0.3, w.now);
  assert.strictEqual(p.getInfo().poster, false, 'released once the front video presented a frame'); p.destroy();
});
test('poster: a browser that cannot copy the frame (no decoded size) never claims a picture; the clip playing in front does', async () => {
  const w = makeWorld({ videoSize: false }); const p = w.make(); await p.ready;
  assert.strictEqual(w.ctxCalls.filter(isFrameCopy).length, 0, 'nothing copied'); assert.strictEqual(p.getInfo().poster, false); assert.strictEqual(p.getInfo().drawable, false, 'no decoded frame: no false claim');
  await w.settle(300); assert.strictEqual(p.getInfo().drawable, true, 'a clip really playing in front is a picture'); p.destroy();
});

// ── safeAreaComfort: precedence, invalid values, back-compat, and the aspect rule (narrower than 16:9 fits the box width; 16:9 and wider the whole frame) ──
const COMFORT = { x: 0.2, y: 0.1, w: 0.6, h: 0.7 }, WIDEBOX = { x: 0.1, y: 0, w: 0.8, h: 1 }, BADBOX = { x: 0.8, y: 0, w: 0.5, h: 1 };
async function stageOf(extra, dims) { const r = await started({}, Object.assign({ manifest: packManifest(null, extra) }, dims)); const s = r.p.getInfo().stage; r.p.destroy(); return s; }
// the rule: scale = min(view width / box width, view height / full picture height); the box centre lands on the view centre (x and y)
function expectBox(s, b, W, H, m) {
  const k = Math.min(W / (b.w * 1280), H / 720);
  near(s.picture.scale, k, (m || '') + ' scale'); near(s.picture.x + (b.x + b.w / 2) * 1280 * k, W / 2, (m || '') + ' box centre x'); near(s.picture.y + (b.y + b.h / 2) * 720 * k, H / 2, (m || '') + ' box centre y');
}
test('safeAreaComfort: it is normalised like the other boxes (bad values give null)', () => {
  const n = (extra) => faceNormalizeManifest(Object.assign({ clips: packClips() }, extra));
  assert.strictEqual(n().safeAreaComfort, null, 'an old manifest has none'); assert.deepStrictEqual(n({ safeAreaComfort: COMFORT }).safeAreaComfort, COMFORT);
  for (const b of [{ x: 0, y: 0, w: 1, h: 1, extra: 1 }, { x: -0.1, y: 0, w: 0.5, h: 0.5 }, BADBOX, { x: 0, y: 0.6, w: 0.5, h: 0.5 }, { x: 0, y: 0, w: 0, h: 1 }, { x: '0', y: 0, w: 1, h: 1 }, { x: NaN, y: 0, w: 1, h: 1 },
    { x: 0, y: 0, w: Infinity, h: 1 }, { x: 0, y: 0, w: 0.5 }, [0, 0, 1, 1], null, 5, 'x']) assert.strictEqual(n({ safeAreaComfort: b }).safeAreaComfort, null, JSON.stringify(b));
});
test('safeAreaComfort: the player uses Comfort, then Typical, then safeArea, then the 70 percent fallback; an invalid one is skipped', async () => {
  const D = { w: 390, h: 800 };
  let s = await stageOf({ safeAreaComfort: COMFORT, safeAreaTypical: SAFE, safeArea: WIDEBOX }, D); assert.strictEqual(s.safeSource, 'comfort'); assert.deepStrictEqual(s.safeArea, COMFORT); expectBox(s, COMFORT, 390, 800, 'comfort');
  s = await stageOf({ safeAreaComfort: COMFORT }, D); assert.strictEqual(s.safeSource, 'comfort', 'comfort alone is enough'); expectBox(s, COMFORT, 390, 800);
  s = await stageOf({ safeAreaComfort: BADBOX, safeAreaTypical: SAFE, safeArea: WIDEBOX }, D); assert.strictEqual(s.safeSource, 'typical'); expectBox(s, SAFE, 390, 800, 'typical');
  s = await stageOf({ safeAreaTypical: SAFE, safeArea: WIDEBOX }, D); assert.strictEqual(s.safeSource, 'typical', 'typical now counts (it is no longer informational)');
  s = await stageOf({ safeAreaComfort: 'x', safeAreaTypical: { x: 0, y: 0, w: 0, h: 1 }, safeArea: WIDEBOX }, D); assert.strictEqual(s.safeSource, 'safeArea'); expectBox(s, WIDEBOX, 390, 800, 'safeArea');
  s = await stageOf({ safeArea: WIDEBOX }, D); assert.strictEqual(s.safeSource, 'safeArea', 'an old pack with only safeArea keeps working'); expectBox(s, WIDEBOX, 390, 800);
  s = await stageOf({ safeAreaComfort: BADBOX, safeAreaTypical: BADBOX, safeArea: BADBOX }, D); assert.strictEqual(s.safeSource, 'fallback'); expectBox(s, { x: 0.15, y: 0, w: 0.7, h: 1 }, 390, 800, 'fallback');
  s = await stageOf({}, D); assert.strictEqual(s.safeSource, 'fallback'); near(s.safeArea.w, 0.7);
});
test('aspect rule: narrower than 16:9 (portrait, square, 4:3) fits the box width, capped by the full picture height, centred on the box; 16:9 and wider show the whole frame', async () => {
  // 4:3 landscape: the box width would need more than the height allows, so the full height caps it
  let s = await stageOf({ safeAreaComfort: COMFORT }, { w: 800, h: 600 }); assert.strictEqual(s.narrow, true); assert.strictEqual(s.portrait, false); near(s.picture.scale, 600 / 720, 'height cap'); expectBox(s, COMFORT, 800, 600, '4:3 capped');
  // a wide box: the width limits (the box edges are the view edges)
  s = await stageOf({ safeAreaComfort: WIDEBOX }, { w: 800, h: 600 }); near(s.picture.scale, 800 / 1024); near(s.picture.x + 0.1 * 1280 * s.picture.scale, 0); near(s.picture.x + 0.9 * 1280 * s.picture.scale, 800); expectBox(s, WIDEBOX, 800, 600, '4:3 wide box');
  s = await stageOf({ safeAreaComfort: COMFORT }, { w: 600, h: 600 }); assert.strictEqual(s.narrow, true); expectBox(s, COMFORT, 600, 600, 'square');
  s = await stageOf({ safeAreaComfort: COMFORT }, { w: 1500, h: 900 }); assert.strictEqual(s.narrow, true, '5:3 is below 16:9'); expectBox(s, COMFORT, 1500, 900, '5:3');
  // 16:9 and wider: the whole frame, centred, the box ignored
  s = await stageOf({ safeAreaComfort: COMFORT }, { w: 1600, h: 900 }); assert.strictEqual(s.narrow, false); near(s.picture.scale, 1.25); near(s.picture.x, 0); near(s.picture.y, 0); near(s.w, 1600); near(s.h, 900);
  s = await stageOf({ safeAreaComfort: COMFORT }, { w: 2000, h: 900 }); assert.strictEqual(s.narrow, false); near(s.picture.scale, 1.25); near(s.picture.x, 200); near(s.x, 200); near(s.w, 1600);
  s = await stageOf({ safeAreaComfort: COMFORT }, { w: 1280, h: 720 }); assert.strictEqual(s.narrow, false, 'exactly 16:9 is the whole frame'); near(s.picture.scale, 1);
  s = await stageOf({ safeAreaComfort: COMFORT }, { w: 1279, h: 720 }); assert.strictEqual(s.narrow, true, 'just under 16:9');
});
test('aspect rule: the poster canvas and the videos share the one transform (comfort box, 4:3 and portrait)', async () => {
  for (const d of [{ w: 800, h: 600 }, { w: 390, h: 800 }]) {
    const w = makeWorld(Object.assign({ manifest: posterManifest({ safeAreaComfort: COMFORT }) }, d)); const p = w.make(); await p.ready;
    const pc = w.container.children[0].children[0].children[2], v = w.videos[0].style;
    for (const k of ['left', 'top', 'width', 'height']) assert.strictEqual(pc.style[k], v[k], k + ' at ' + d.w + 'x' + d.h);
    const s = p.getInfo().stage; expectBox(s, COMFORT, d.w, d.h); assert.strictEqual(parseFloat(pc.style.width), Math.round(s.picture.w * 100) / 100); p.destroy();
  }
});

// ── cold speech: never audible speech over an untracked clip; until a tracked speaking video is loaded the poster is held with the beak animated on the MASTER transform ──
const SPEAKERS = ['speaking-1', 'speaking-2', 'speaking-3', 'speaking-4'];
const beakDraws = (w) => w.ctxCalls.filter(c => c[0] === 'drawImage' && c[1] && c[1].tag === 'img' && /\/beak\//.test(c[1]._s || ''));
async function coldWorld(o, wo) {
  const r = await started(o, Object.assign({ w: 390, h: 800, manifest: packManifest(null, { safeAreaComfort: COMFORT }) }, wo || {}));
  SPEAKERS.forEach(n => r.w.hold.add(n)); r.p.setState('thinking'); await r.w.settle(400); assert.match(r.p.getInfo().clip, /^thinking-/, 'set-up: an untracked clip is playing');
  r.an = analyserOf({ amp: 0.2, hz: 1500 }); r.p.setAnalyser(r.an); return r;
}
test('cold speech: speaking asked while no tracked video is loaded holds the poster at once with the beak drawn on the MASTER transform, no untracked clip starts', async () => {
  const { w, p } = await coldWorld(); const n0 = p.getInfo().log.length;
  p.setState('speaking');   // synchronous: nothing is awaited between the request and the hold
  let i = p.getInfo(); assert.strictEqual(i.coldHold, true); assert.strictEqual(i.poster, true); assert.strictEqual(i.coldHolds, 1);
  const pc = w.container.children[0].children[0].children[2]; assert.strictEqual(pc.style.display, 'block', 'the poster canvas is up');
  w.ctxCalls.length = 0; for (let k = 0; k < 20; k++) w.tickRaf(16);
  const draws = beakDraws(w); assert.ok(draws.length >= 10, 'the beak is drawn every frame while held: ' + draws.length);
  assert.ok(draws.some(c => !/closed\.png$/.test(c[1]._s)), 'the beak follows the voice (not a frozen closed mouth): ' + [...new Set(draws.map(c => c[1]._s.split('/').pop()))].join(','));
  const s = i.stage, tfs = w.ctxCalls.filter(c => c[0] === 'setTransform' && c[1] !== 1);
  assert.ok(tfs.length >= 10); for (const tf of tfs) { near(tf[1], s.picture.scale); near(tf[4], s.picture.scale); near(tf[5], s.picture.x); near(tf[6], s.picture.y); }
  for (const tr of w.ctxCalls.filter(c => c[0] === 'translate')) { assert.strictEqual(tr[1], 646); assert.strictEqual(tr[2], 350); }   // MASTER beak position, never a track frame (those start at 600)
  // the playing clip ends and the retry timer runs: still nothing untracked is started under the voice
  w.front(p).end(); await w.settle(3200);
  i = p.getInfo(); assert.strictEqual(i.coldHold, true, 'still held'); assert.ok(i.log.slice(n0).every(e => e.state === 'speaking'), 'no untracked clip was started: ' + JSON.stringify(i.log.slice(n0).map(e => e.name))); assert.ok(!i.bad.length);
  p.destroy();
});
test('cold speech: the delayed tracked video takes over (poster released after its first frame), the hold loop stops, nothing is left behind', async () => {
  const { w, p } = await coldWorld(); p.setState('speaking'); await w.settle(300);
  assert.strictEqual(p.getInfo().coldHold, true, 'the video is still loading');
  const ld = w.videos[1 - p.getInfo().front]; assert.match(ld.clipName, /^speaking-/, 'the speaking clip is the one loading'); const name = ld.clipName;
  ld.currentSrc = ld.src; ld.readyState = 4; ld.duration = 5; ld.fire('loadeddata'); await w.settle(100);
  const i = p.getInfo(); assert.strictEqual(i.clip, name); assert.strictEqual(i.coldHold, true, 'MASTER beak stays while the poster is visible'); assert.strictEqual(i.coldHolds, 1); assert.ok(i.speakLatency >= 300, 'honest latency: ' + i.speakLatency);
  assert.ok(w.raf.length > 0, 'the hold loop continues until the poster goes'); assert.strictEqual(i.poster, true, 'poster stays until the clip has presented a frame');
  w.ctxCalls.length = 0; w.tickRaf(16);
  assert.ok(w.ctxCalls.filter(c => c[0] === 'translate').every(c => c[1] === 646 && c[2] === 350), 'visible poster uses MASTER rather than the newly loaded video track');
  await w.settle(500); assert.strictEqual(p.getInfo().poster, false, 'released after the bounded frame wait'); assert.strictEqual(w.container.children[0].children[0].children[2].style.display, 'none');
  const last = i.log[i.log.length - 1]; assert.strictEqual(last.state, 'speaking'); assert.strictEqual(last.fade, false, 'the poster shields the cold switch: a hard cut, no fade'); assert.strictEqual(last.ms, 0);
  w.ctxCalls.length = 0; w.front(p).frame(12 / 24, w.now + 20); w.front(p).frame(12 / 24, w.now + 40);
  const tr = w.ctxCalls.filter(c => c[0] === 'translate'); assert.ok(tr.length && tr.every(c => c[1] !== 646), 'the beak now follows the clip\'s own track');
  p.destroy();
});
test('cold speech: when the poster goes the speaking video is already fully opaque and the old video cannot bleed through', async () => {
  const { w, p } = await coldWorld(); p.setState('speaking'); await w.settle(300);
  const old = w.videos[p.getInfo().front], ld = w.videos[1 - p.getInfo().front]; assert.match(ld.clipName, /^speaking-/);
  ld.currentSrc = ld.src; ld.readyState = 4; ld.duration = 5; ld.fire('loadeddata'); await w.settle(1);
  const nv = w.front(p); assert.strictEqual(nv, ld); assert.strictEqual(p.getInfo().poster, true, 'poster still up at the commit');
  assert.strictEqual(nv.style.opacity, '1'); assert.ok(!/\d+ms/.test(nv.style.transition || ''), 'no fade on the cold handoff: ' + nv.style.transition); assert.strictEqual(nv.style.zIndex, '2');
  await w.settle(500); assert.strictEqual(p.getInfo().poster, false, 'poster released after the presented frame');
  assert.strictEqual(nv.style.opacity, '1'); assert.ok(!/\d+ms/.test(nv.style.transition || '')); assert.strictEqual(nv.style.zIndex, '2');
  assert.strictEqual(old.style.opacity, '0'); assert.strictEqual(old.paused, true); p.destroy();
});
test('cold speech: leaving speaking, hiding and destroy while held stop the loop; the poster goes with the next picture; a return from hidden holds again', async () => {
  const a = await coldWorld(); a.p.setState('speaking'); assert.strictEqual(a.p.getInfo().coldHold, true); assert.ok(a.w.raf.length >= 1);
  a.p.setState('listening'); assert.strictEqual(a.p.getInfo().coldHold, false); assert.strictEqual(a.w.raf.length, 0, 'the beak loop is cancelled');
  await a.w.settle(300); assert.match(a.p.getInfo().clip, /^listening-/); await a.w.settle(500); assert.strictEqual(a.p.getInfo().poster, false, 'the poster is released once the new clip is in front (bounded frame wait)');
  assert.strictEqual(a.p.getInfo().shape, 'closed', 'the beak is closed outside speaking'); a.p.destroy();
  const b = await coldWorld(); b.p.setState('speaking'); b.w.hide(true);
  assert.strictEqual(b.p.getInfo().coldHold, false, 'hidden: nothing moves'); assert.strictEqual(b.w.raf.length, 0);
  b.w.hide(false); assert.strictEqual(b.p.getInfo().coldHold, true, 'visible again and still no tracked video: held again'); assert.strictEqual(b.p.getInfo().poster, true); assert.ok(b.w.raf.length >= 1);
  b.p.destroy(); assert.strictEqual(b.w.raf.length, 0, 'destroy cancels the loop'); assert.strictEqual(b.w.timers.filter(x => !x.tag).length, 0); assert.strictEqual(b.p.getInfo().coldHold, false);
  const c = await coldWorld(); c.p.setState('speaking'); c.p.setReducedMotion(true); assert.strictEqual(c.p.getInfo().coldHold, false, 'reduced motion takes over'); assert.strictEqual(c.w.raf.length <= 1, true); c.p.destroy();
});
test('cold speech: an already loaded tracked speaking clip is used at once even when it is the one that just played (no hold, no new load)', async () => {
  const { w, p } = await started({}, {});
  p.setState('speaking'); await w.settle(150); const first = p.getInfo().clip; assert.match(first, /^speaking-/);
  p.setState('listening'); await w.settle(36); assert.match(p.getInfo().clip, /^listening-/, 'set-up: listening is in front');
  const holds = p.getInfo().coldHolds, hidden = w.videos[1 - p.getInfo().front]; assert.strictEqual(hidden.clipName, first, 'set-up: that speaking video is still loaded in the hidden slot'); assert.strictEqual(hidden.readyState, 4);
  const loads = hidden.loads; p.setState('speaking');
  const i = p.getInfo(); assert.strictEqual(i.clip, first, 'the loaded clip, a repeat, beats a cold one'); assert.strictEqual(i.coldHold, false); assert.strictEqual(i.coldHolds, holds); assert.strictEqual(hidden.loads, loads, 'no reload');
  assert.strictEqual(w.front(p), hidden); assert.strictEqual(i.log[i.log.length - 1].latency, 0); p.destroy();
});
test('cold speech: the selector prefers a speaking clip that is already loaded (a repeat included) and falls back to the rest', () => {
  const cl = ['sA', 'sB', 'sC'].map(nm => clip(nm, 'speaking', { track: true, family: nm }));
  const s = faceCreateSelector(cl, { random: faceRng(3) }); const a = s.pickSpeakNow(); s.commit(a);
  assert.strictEqual(s.pickSpeakNow(c => c.name === a.clip.name).clip.name, a.clip.name, 'the loaded one, though it just played');
  assert.notStrictEqual(s.pickSpeakNow().clip.name, a.clip.name, 'without a preference the variety rules still apply');
  assert.ok(s.pickSpeakNow(() => false), 'nothing loaded: any tracked clip'); assert.ok(s.pickSpeakNow(c => c.name === 'nope'));
  assert.strictEqual(faceCreateSelector([clip('i', 'idle')], {}).pickSpeakNow(() => true), null, 'no tracked speaking clip: null');
});
test('cold speech: without a real poster picture nothing is held (no false claim) and the old rules still run', async () => {
  const { w, p } = await started({}, { videoSize: false }); p.setState('thinking'); await w.settle(400);
  p.setState('speaking'); await w.settle(300); assert.strictEqual(p.getInfo().coldHold, false); assert.strictEqual(p.getInfo().coldHolds, 0); assert.strictEqual(w.container.children[0].children[0].children[2].style.display, 'none'); p.destroy();
});
test('warm: three tracked speaking clips are the first to be fetched, before idle, listening, thinking or reactions', async () => {
  const w = makeWorld(); const p = w.make(); await p.ready; await w.settle(50);
  const web = w.fetched.filter(u => /\/web\//.test(u)); assert.ok(web.length >= 3);
  assert.ok(web.slice(0, 3).every(u => /\/web\/speaking-\d\.mp4$/.test(u)), 'first three: ' + web.slice(0, 3).join(' ')); p.destroy();
});

// ── follow-ups: poster first on a slow start, hello kept until it arrives, no poster linger / flicker, an all-failed speaking set keeps the animated poster beak ──
const posterShown = (w) => w.container.children[0].children[0].children[2];
function recordDisplay(poster) { const writes = []; const st = poster.style; poster.style = new Proxy(st, { set(t, k, v) { if (k === 'display') writes.push(v); t[k] = v; return true; } }); return writes; }
test('slow start: the poster is requested first, no clip request starts before it, and ready / drawable come once the real poster is painted, never waiting for a clip', async () => {
  const w = makeWorld({ manifest: posterManifest() }); w.manifest.clips.forEach(c => w.hold.add(c.name));   // no clip ever arrives (a very slow link)
  const p = w.make({ manifest: w.manifest }); const t0 = w.now; const firstSrc = [];   // what the player had already done when each video was first pointed at a clip
  w.videos.forEach(v => { const l = v.load; v.load = () => { firstSrc.push({ posterReqs: w.posterReqs.length, poster: p.getInfo().poster, drawable: p.getInfo().drawable }); l(); }; });   // setSource calls load() right after pointing the video at a clip
  await p.ready;
  assert.deepStrictEqual(w.posterReqs, ['/api/faces/owl/poster.webp'], 'the poster is the first picture requested'); assert.ok(firstSrc.length > 0 && firstSrc.every(s => s.posterReqs === 1 && s.poster === true && s.drawable === true), 'no clip request before the poster is loaded and painted: ' + JSON.stringify(firstSrc));
  assert.ok(w.now - t0 < 300, 'ready did not wait for a clip or the still-wait: ' + (w.now - t0));
  const i = p.getInfo(); assert.strictEqual(i.drawable, true, 'the painted poster is a real picture'); assert.strictEqual(i.poster, true); assert.strictEqual(i.posterImage, true); assert.strictEqual(posterShown(w).style.display, 'block');
  assert.strictEqual(w.ctxCalls.filter(c => isPosterDraw(w, c)).length, 1); assert.strictEqual(w.ctxCalls.filter(isFrameCopy).length, 0, 'no video frame was needed');
  await w.settle(50); assert.ok(w.videos.some(v => v._src), 'the first clip is requested after the poster is up'); p.destroy();
});
test('slow start: a slow poster keeps clips back until it settles (bounded by the poster wait), then the old still path takes over', async () => {
  const w = makeWorld({ manifest: posterManifest(), posterHold: true }); const p = w.make({ manifest: w.manifest }); await w.settle(1500);
  assert.ok(w.videos.every(v => !v._src), 'no clip request while the poster is still loading'); assert.strictEqual(p.getInfo().drawable, false);
  await w.settle(3000); await p.ready; assert.ok(w.videos.some(v => v._src), 'after the bounded poster wait the still video is loaded'); assert.strictEqual(p.getInfo().drawable, true); p.destroy();
});
test('hello: asked before ready it is kept while its clip is slow (not swallowed), the cache waits for it, it plays on arrival; a person speaking cancels it for good', async () => {
  const w = makeWorld({ manifest: posterManifest() }); w.hold.add('reaction-hello-1'); const p = w.make(); assert.strictEqual(p.react('hello'), true);
  assert.strictEqual(p.getInfo().helloWaiting, true, 'waiting before ready'); await p.ready; await w.settle(2000);
  assert.strictEqual(p.getInfo().helloWaiting, true, 'ready, the hello clip has not arrived: still kept'); assert.strictEqual(w.fetched.filter(u => /\/web\//.test(u)).length, 0, 'the cache does not compete with the waiting hello');
  await w.settle(3000); assert.strictEqual(p.getInfo().helloWaiting, true, 'kept for the bounded few seconds'); assert.ok(w.fetched.filter(u => /\/web\//.test(u)).length > 0, 'the cache starts after its bound');
  const ld = w.videos.find(v => v.clipName === 'reaction-hello-1'); assert.ok(ld, 'the hello clip is the one loading'); ld.currentSrc = ld.src; ld.readyState = 4; ld.duration = 3; ld.fire('loadeddata'); await w.settle(100);
  const i = p.getInfo(); assert.strictEqual(i.clip, 'reaction-hello-1'); assert.strictEqual(i.helloPlaying, true); assert.strictEqual(i.helloWaiting, false); p.destroy();
  const q = makeWorld({ manifest: posterManifest() }); q.hold.add('reaction-hello-1'); const r = q.make(); r.react('hello'); await r.ready; await q.settle(300);
  assert.strictEqual(r.getInfo().helloWaiting, true); r.setState('listening'); assert.strictEqual(r.getInfo().helloWaiting, false, 'real speech dropped the waiting hello'); await q.settle(300);
  const l = q.videos.find(v => v.clipName === 'reaction-hello-1'); if (l) { l.currentSrc = l.src; l.readyState = 4; l.duration = 3; l.fire('loadeddata'); }
  await q.settle(200); assert.notStrictEqual(r.getInfo().clip, 'reaction-hello-1', 'a hello that arrives late never plays over the person'); assert.strictEqual(r.getInfo().helloPlaying, false); r.destroy();
});
test('linger: speech held on the poster while the front listening clip ended; back to listening starts its clip at once, not after the 2.5 s retry', async () => {
  const { w, p } = await coldWorld(); p.setState('listening'); await w.settle(400); assert.match(p.getInfo().clip, /^listening-/, 'set-up: a listening clip is in front');
  p.setState('speaking'); assert.strictEqual(p.getInfo().coldHold, true); w.front(p).end(); await w.settle(50);   // the clip ended under the hold: nothing can start, the retry timer waits
  const n = p.getInfo().log.length; p.setState('listening'); await w.settle(120);
  const i = p.getInfo(); assert.strictEqual(i.coldHold, false); assert.ok(i.log.length > n && /^listening-/.test(i.log[i.log.length - 1].name), 'a listening clip started within 120 ms: ' + JSON.stringify(i.log.slice(n).map(e => e.name)));
  assert.strictEqual(w.front(p).paused, false); await w.settle(600); assert.strictEqual(p.getInfo().poster, false, 'the poster is gone with the new picture, well before 2.5 s'); p.destroy();
});
test('all speaking clips fail: the animated poster beak is kept for the whole reply (no untracked closed mouth, no hide/show flicker), retries are bounded, and it is released cleanly after', async () => {
  const w = makeWorld({ manifest: posterManifest() }); SPEAKERS.forEach(n => w.fail.add(n)); const p = w.make(); await p.ready;
  const writes = recordDisplay(posterShown(w)); p.setAnalyser(analyserOf({ amp: 0.2, hz: 1500 })); const n0 = p.getInfo().log.length;
  p.setState('speaking'); await w.settle(400);
  let i = p.getInfo(); assert.strictEqual(i.coldHold, true, 'held although every speaking clip failed'); assert.strictEqual(i.poster, true); assert.ok(SPEAKERS.every(s => i.bad.indexOf(s) >= 0), 'all speakers were set aside: ' + i.bad);
  w.ctxCalls.length = 0; for (let k = 0; k < 20; k++) w.tickRaf(16);
  const draws = beakDraws(w); assert.ok(draws.length >= 10, 'the beak is animated over the poster: ' + draws.length); assert.ok(draws.some(c => !/closed\.png$/.test(c[1]._s)), 'it follows the voice');
  for (const tr of w.ctxCalls.filter(c => c[0] === 'translate')) { assert.strictEqual(tr[1], 646); assert.strictEqual(tr[2], 350); }
  const loads = () => w.videos.reduce((s, v) => s + v.loads, 0);
  await w.settle(7000); i = p.getInfo(); assert.strictEqual(i.coldHold, true); assert.ok(i.log.slice(n0).every(e => e.state === 'speaking'), 'no untracked clip under the voice: ' + JSON.stringify(i.log.slice(n0).map(e => e.name)));
  await w.settle(7000); const a = loads(); await w.settle(7000); assert.strictEqual(loads(), a, 'bounded retries: no load storm after the retries are used up');
  assert.ok(a <= 24, 'a bounded number of loads: ' + a); assert.ok(!writes.includes('none'), 'the poster never hid and came back during speech: ' + writes.join(','));
  p.setState('listening'); await w.settle(700); i = p.getInfo();
  assert.strictEqual(i.coldHold, false); assert.strictEqual(w.raf.length, 0, 'the hold loop is gone'); assert.strictEqual(i.poster, false, 'released after the reply'); assert.strictEqual(writes[writes.length - 1], 'none');
  assert.match(i.clip, /^(listening|idle)-/); p.destroy(); assert.strictEqual(w.timers.filter(x => !x.tag).length, 0);
  const x = await started({}, { videoSize: false }); SPEAKERS.forEach(s => x.w.fail.add(s)); x.p.setState('thinking'); await x.w.settle(400); x.p.setState('speaking'); await x.w.settle(300);
  assert.strictEqual(x.p.getInfo().coldHold, false, 'without a real poster picture nothing is held and the old rules run'); x.p.destroy();
});
test('all speaking tracks fail over HTTP, speech asked the moment ready resolves: an idle clip that committed under the hold and presents frames never drops the poster or the animated beak', async () => {
  const w = makeWorld({ manifest: posterManifest(), fetchFail: u => /\/tracks\//.test(u) }); const p = w.make(); await p.ready;
  const amp = { amp: 0.2, hz: 1500 }; const writes = recordDisplay(posterShown(w)); p.setAnalyser(analyserOf(amp));
  // A real video keeps every registered frame callback (the per-frame watcher AND the poster release); the shared fake keeps only the last one.
  const cbs = new Map(); w.videos.forEach(v => { cbs.set(v, new Set()); v.requestVideoFrameCallback = (cb) => { cbs.get(v).add(cb); return cbs.get(v).size; }; v.cancelVideoFrameCallback = () => {}; });
  const present = (v, mt) => { const list = [...cbs.get(v)]; cbs.get(v).clear(); list.forEach(cb => cb(w.now, { mediaTime: mt })); };
  p.setState('speaking');   // no settle: the first (idle) clip is still starting, it commits under the hold
  for (let k = 0; k < 40; k++) { await w.settle(25); const v = w.front(p); if (v && !v.paused) { present(v, 0.04 * k); present(v, 0.04 * k + 0.02); } }   // the front video presents frames, as Chrome does
  let i = p.getInfo(); assert.ok(i.log.some(e => e.state === 'idle'), 'set-up: an untracked idle clip is the one in front under the hold');
  assert.strictEqual(i.coldHold, true, 'still held while the reply is audible'); assert.strictEqual(i.poster, true, 'the poster stays up');
  assert.ok(!writes.includes('none'), 'the poster never vanished while speaking: ' + writes.join(','));
  w.ctxCalls.length = 0; for (let k = 0; k < 60; k++) { amp.amp = k % 10 < 5 ? 0.02 : 0.5; w.tickRaf(16); }   // a speaking rhythm (a steady level converges to closed)
  const draws = beakDraws(w); assert.ok(draws.length >= 10, 'the beak is drawn over the poster: ' + draws.length); assert.ok(draws.some(c => !/closed\.png$/.test(c[1]._s)), 'it follows the voice: ' + [...new Set(draws.map(c => c[1]._s.split('/').pop()))].join(','));
  p.setState('listening'); await w.settle(700); i = p.getInfo(); assert.strictEqual(i.coldHold, false); assert.strictEqual(i.poster, false, 'released after the reply'); p.destroy();
});

// ── pictureReady: the picture is separate from `ready` (patches and tracks) ──
function gateTracks(w) {   // every /tracks/ request waits until release() (a slow link); everything else is as in the fake world
  const orig = w.fetch; let release; const gate = new Promise(r => { release = r; });
  w.fetch = async (u) => { if (/\/tracks\//.test(u)) await gate; return orig(u); };
  return release;
}
const patchImgs = (w) => w.imgs.filter(im => /\/beak\//.test(im._s || ''));
test('pictureReady: settles true as soon as the poster is painted, before delayed tracks and beak patches arrive; ready keeps its meaning', async () => {
  const w = makeWorld({ manifest: posterManifest(), imgHold: new Set(['closed', 'slight', 'half', 'wide', 'oo', 'smile']) }); const release = gateTracks(w); const p = w.make();
  let pic = null, rdy = false; p.pictureReady.then(v => { pic = v; }); p.ready.then(() => { rdy = true; }, () => {});
  await w.settle(300);
  assert.strictEqual(pic, true, 'the picture is reported while tracks and patches are still outstanding'); assert.strictEqual(rdy, false); assert.strictEqual(p.getInfo().ready, false);
  const i = p.getInfo(); assert.strictEqual(i.poster, true); assert.strictEqual(i.drawable, true); assert.strictEqual(i.posterImage, true);
  assert.ok(patchImgs(w).length > 0 && patchImgs(w).every(im => im.onload), 'set-up: the patches are still loading');
  patchImgs(w).forEach(im => im.onload()); release(); await p.ready; await w.settle(100);
  assert.strictEqual(p.getInfo().ready, true); assert.strictEqual(typeof p.pictureReady.then, 'function'); p.destroy();
});
test('pictureReady: no picture (poster failed and no decodable frame) settles false and never rejects; a failed ready after a true picture still rejects cleanly', async () => {
  const w = makeWorld({ manifest: posterManifest(), posterFail: 'error', videoSize: false }); const p = w.make();
  assert.strictEqual(await p.pictureReady, false, 'no real picture: false, not a claim'); assert.strictEqual(p.getInfo().drawable, false); await p.ready; p.destroy();
  const w2 = makeWorld({ manifest: posterManifest(), imgHold: new Set(['wide']) }); const p2 = w2.make();
  assert.strictEqual(await p2.pictureReady, true); assert.strictEqual(p2.getInfo().ready, false);
  patchImgs(w2).filter(im => /wide/.test(im._s))[0].onerror(); await assert.rejects(p2.ready, /beak patch.*wide/);
  assert.strictEqual(p2.getInfo().ready, false); assert.ok(p2.getInfo().failed); assert.strictEqual(w2.played.length, 0, 'nothing plays after the later failure'); p2.destroy();
});
test('pictureReady: destroy before the picture settles it false (never hangs) and nothing is left running', async () => {
  const w = makeWorld({ manifest: posterManifest(), posterHold: true }); const p = w.make(); await w.settle(100); p.destroy();
  assert.strictEqual(await Promise.race([p.pictureReady, new Promise((_, rej) => setImmediate(() => rej(new Error('pictureReady hung'))))]), false);
  assert.strictEqual(w.timers.filter(x => !x.tag).length, 0); assert.ok(w.imgs.every(im => im.onload === null && im.onerror === null));
  const w2 = makeWorld({ manifest: posterManifest() }); const p2 = w2.make(); const pr = p2.pictureReady; p2.destroy();
  assert.strictEqual(await pr, false, 'destroyed at once'); await p2.ready.catch(() => {});
});
test('all speaking tracks fail over HTTP: with the real poster and the full beak ready resolves (degraded, honest), speech holds the animated poster beak the whole reply and it is released after', async () => {
  const w = makeWorld({ manifest: posterManifest(), fetchFail: u => /\/tracks\//.test(u) }); const p = w.make();
  assert.strictEqual(await p.pictureReady, true); await p.ready;
  let i = p.getInfo(); assert.strictEqual(i.ready, true); assert.strictEqual(i.failed, null); assert.match(i.degraded, /speaking track/); assert.strictEqual(i.tracks, 0); assert.strictEqual(i.posterImage, true);
  const writes = recordDisplay(posterShown(w)); p.setAnalyser(analyserOf({ amp: 0.2, hz: 1500 })); await w.settle(100); const n0 = p.getInfo().log.length;
  p.setState('speaking'); await w.settle(400); i = p.getInfo();
  assert.strictEqual(i.coldHold, true, 'the hold covers speech although no track exists'); assert.strictEqual(i.poster, true);
  w.ctxCalls.length = 0; for (let k = 0; k < 20; k++) w.tickRaf(16);
  const draws = beakDraws(w); assert.ok(draws.length >= 10, 'the beak is drawn over the poster: ' + draws.length); assert.ok(draws.some(c => !/closed\.png$/.test(c[1]._s)), 'it follows the voice');
  for (const tr of w.ctxCalls.filter(c => c[0] === 'translate')) { assert.strictEqual(tr[1], 646); assert.strictEqual(tr[2], 350); }
  await w.settle(9000); i = p.getInfo(); assert.strictEqual(i.coldHold, true, 'held for the whole reply'); assert.ok(i.log.slice(n0).every(e => e.state === 'speaking'), 'no untracked clip under the voice');
  assert.ok(!writes.includes('none'), 'no hide/show flicker: ' + writes.join(','));
  p.setState('listening'); await w.settle(700); i = p.getInfo();
  assert.strictEqual(i.coldHold, false); assert.strictEqual(w.raf.length, 0); assert.strictEqual(i.poster, false, 'released after the reply'); assert.match(i.clip, /^(listening|idle)-/);
  p.destroy(); assert.strictEqual(w.timers.filter(x => !x.tag).length, 0);
  // without the pack's decoded poster image (a captured frame alone) ready still rejects, as before
  const w2 = makeWorld({ fetchFail: u => /\/tracks\//.test(u), videoSize: false }); const p2 = w2.make(); await assert.rejects(p2.ready, /speaking track/); p2.destroy();
});

// ── review follow-ups: no-frame-callback poster release, goodbye prefers a loaded clip, bounded retry of failed speaking tracks ──
test('no requestVideoFrameCallback: the poster hold ends when the tracked speaking clip commits (the selector commits before the poster release decides)', async () => {
  const { w, p } = await coldWorld(); w.videos.forEach(v => { v.requestVideoFrameCallback = undefined; v.cancelVideoFrameCallback = undefined; });
  p.setState('speaking'); await w.settle(300);
  assert.strictEqual(p.getInfo().coldHold, true, 'set-up: cold hold, the tracked clip is still loading'); assert.strictEqual(p.getInfo().poster, true);
  const ld = w.videos[1 - p.getInfo().front]; assert.match(ld.clipName, /^speaking-/); const name = ld.clipName;
  ld.currentSrc = ld.src; ld.readyState = 4; ld.duration = 5; ld.fire('loadeddata'); await w.settle(60);
  const i = p.getInfo(); assert.strictEqual(i.clip, name, 'the tracked clip is in front');
  assert.strictEqual(i.poster, false, 'the poster is gone at once, not up to a clip length later'); assert.strictEqual(posterShown(w).style.display, 'none');
  assert.strictEqual(i.coldHold, false, 'the MASTER-position beak is dropped, the beak follows the clip track');
  p.destroy();
});
test('goodbye: a LOADED clip of the other pose beats waiting for an unloaded clip of the on-screen pose (pose jump accepted)', async () => {
  const clips = speakPack().filter(c => c.name !== 'idle-a1').concat([goodbyeB('reaction-goodbye-b')]);
  const w = makeWorld({ manifest: packManifest(clips) }); const p = w.make(); await p.ready; await w.settle(100);
  for (let i = 0; i < 12 && p.getInfo().clip !== 'idle-rest'; i++) { w.front(p).end(); await w.settle(100); }
  assert.strictEqual(p.getInfo().clip, 'idle-rest', 'set-up: pose B rest'); w.front(p).currentTime = 1;
  assert.strictEqual(p.react('goodbye'), true); await w.settle(150); assert.strictEqual(p.getInfo().clip, 'reaction-goodbye-b', 'set-up: the B goodbye played and is loaded');
  w.front(p).end(); await w.settle(24);   // the next clip is in front (pose A); the goodbye video still sits loaded in the hidden slot (before the plan-ahead reload)
  const front = p.getInfo().clip; assert.ok(!/^reaction/.test(front), 'set-up: ' + front); assert.strictEqual(p.getInfo().pose === 'A' || /^idle-up$/.test(front), true);
  assert.ok(w.videos.some(v => v.clipName === 'reaction-goodbye-b' && v.readyState === 4), 'set-up: the B goodbye is still loaded in the hidden video');
  w.hold.add('reaction-goodbye-1');   // the on-screen-pose (A-start) goodbye would have to load: not yet there
  const n = p.getInfo().log.length, t0 = w.now; assert.strictEqual(p.react('goodbye'), true); await w.settle(100);
  const i = p.getInfo(); assert.strictEqual(i.clip, 'reaction-goodbye-b', 'the loaded goodbye plays at once: ' + i.clip); assert.strictEqual(i.log.length, n + 1); assert.ok(w.now - t0 <= 150);
  p.destroy();
});
test('goodbye: with nothing loaded the on-screen pose family is chosen (and waited for), as before', async () => {
  const r = await goodbyeCut('poseB-rest', 'reaction-goodbye-b', (f) => { f().currentTime = 1; });
  assert.strictEqual(r.info.clip, 'reaction-goodbye-b'); r.p.destroy();   // nothing loaded: the matching pose group, waited for, as before
});
// the fake network: every /tracks/ request answers per `mode` (a function of the url and the attempt number)
function trackNet(w, mode) {
  const orig = w.fetch; const hits = {};
  w.fetch = async (u) => { if (/\/tracks\//.test(u)) { hits[u] = (hits[u] || 0) + 1; w.fetched.push(u); const m = mode(u, hits[u]); if (m === 'ok') return { ok: true, json: async () => trackFor() }; if (m === 'throw') throw new Error('network'); return { ok: false, status: m }; } return orig(u); };
  return hits;
}
const sp1 = (hits) => hits['/api/faces/owl/tracks/speaking-1.json'] || 0;
async function runFor(w, ms) { for (let k = 0; k < ms; k += 250) await w.settle(250); }
test('transient track failures are retried after 5 s, then 20 s, then never again (no tight loop, no endless polling)', async () => {
  for (const kind of [503, 'throw', 429]) {
    const w = makeWorld({ manifest: posterManifest() }); const hits = trackNet(w, () => kind); const p = w.make(); await p.ready; const t0 = w.now;
    assert.strictEqual(sp1(hits), 1, kind + ': the boot request'); assert.match(p.getInfo().degraded, /speaking track/);
    await runFor(w, 3500); assert.strictEqual(sp1(hits), 1, 'no retry before 5 s');
    await runFor(w, 3000); assert.strictEqual(sp1(hits), 2, 'first retry at ~5 s'); assert.ok(w.now - t0 >= 5000);
    await runFor(w, 14000); assert.strictEqual(sp1(hits), 2, 'the second retry waits ~20 s after the first');
    await runFor(w, 8000); assert.strictEqual(sp1(hits), 3, 'second retry at ~25 s'); 
    await runFor(w, 90000); assert.strictEqual(sp1(hits), 3, 'then it stops for good');
    assert.strictEqual(p.getInfo().trackRetries, 0); assert.strictEqual(p.getInfo().tracks, 0);
    p.destroy();
  }
});
test('a track that loads on a retry clears degraded and speech uses the tracked clip (no poster hold) from then on', async () => {
  const w = makeWorld({ manifest: posterManifest() }); let up = false; const hits = trackNet(w, () => (up ? 'ok' : 503)); const p = w.make(); await p.ready;
  assert.match(p.getInfo().degraded, /speaking track/); p.setState('speaking'); await w.settle(300); assert.strictEqual(p.getInfo().coldHold, true, 'before the retry: the hold');
  up = true; await runFor(w, 6000);
  let i = p.getInfo(); assert.ok(i.tracks > 0, 'a retried track arrived'); assert.strictEqual(i.degraded, null); assert.ok(sp1(hits) >= 2);
  await w.settle(400); i = p.getInfo(); assert.match(i.clip, /^speaking-/, 'the tracked clip now plays: ' + i.clip); p.setState('listening'); await w.settle(700);
  p.destroy(); assert.strictEqual(w.timers.filter(x => !x.tag).length, 0);
});
test('404 / 410 (the file is absent) and an unusable body are final: no retry at all; a transient failure beside them still retries', async () => {
  for (const kind of [404, 410]) {
    const w = makeWorld({ manifest: posterManifest() }); const hits = trackNet(w, () => kind); const p = w.make(); await p.ready; await runFor(w, 60000);
    assert.strictEqual(sp1(hits), 1, kind + ': one request, never retried'); assert.ok(p.getInfo().trackGone.indexOf('speaking-1') >= 0); assert.strictEqual(p.getInfo().trackRetries, 0); p.destroy();
  }
  const w = makeWorld({ manifest: posterManifest() }); const hits = trackNet(w, u => (/speaking-1/.test(u) ? 503 : 404)); const p = w.make(); await p.ready; await runFor(w, 60000);
  assert.strictEqual(sp1(hits), 3, 'the transient one retried twice'); assert.strictEqual(hits['/api/faces/owl/tracks/speaking-2.json'], 1, 'the absent one not at all'); p.destroy();
  const w2 = makeWorld({ manifest: posterManifest() }); let bodies = 0; const orig = w2.fetch;
  w2.fetch = async (u) => { if (/\/tracks\/speaking-1/.test(u)) { bodies++; return { ok: true, json: async () => ({ nonsense: true }) }; } return orig(u); };
  const p2 = w2.make(); await p2.ready; await runFor(w2, 60000); assert.strictEqual(bodies, 1, 'an unusable track body is not retried'); p2.destroy();
});
test('packRemoved() stops new clip and track requests even when the warm queues are already built with many tracks and clips queued', async () => {
  const clips = packClips(); for (let i = 0; i < 40; i++) clips.push(clip('extra-' + i, 'idle', { family: 'f' + i }));
  const run = async (remove) => {
    const w = makeWorld({ manifest: packManifest(clips) }); const hits = trackNet(w, () => 'ok');
    const p = w.make({ warmConcurrency: 1 }); await p.ready; await w.settle(60);   // the warm queues are built and started, work still queued
    const mid = w.fetched.length; if (remove) { assert.strictEqual(p.packRemoved(), true); }
    const at = w.fetched.length, trackHitsAt = Object.values(hits).reduce((a, b) => a + b, 0);
    await runFor(w, 60000);
    const out = { mid, at, after: w.fetched.length, trackHitsAt, trackHitsAfter: Object.values(hits).reduce((a, b) => a + b, 0), tracks: p.getInfo().tracks }; p.destroy(); return out;
  };
  const ctl = await run(false); assert.ok(ctl.after > ctl.at, 'control: without removal the queues keep fetching (' + ctl.at + ' -> ' + ctl.after + ')');
  const r = await run(true);
  assert.strictEqual(r.after, r.at, 'no clip or track request after packRemoved(): ' + r.at + ' -> ' + r.after);
  assert.strictEqual(r.trackHitsAfter, r.trackHitsAt, 'no track request after packRemoved()');
});
test('loadTrack never fetches once the player is destroyed or the pack removed (queued warm tracks included)', async () => {
  const w = makeWorld({ manifest: posterManifest() }); const hits = trackNet(w, () => 404); const p = w.make(); await p.ready; await w.settle(200);
  const gone = Object.keys(hits).reduce((a, b) => a + hits[b], 0); await runFor(w, 60000);
  assert.strictEqual(Object.keys(hits).reduce((a, b) => a + hits[b], 0), gone, 'a track known absent (404) is never requested again'); p.destroy();
});
test('packRemoved() stops pending and future track retries and clip revival; destroy() cancels the retry timers; neither leaves a timer behind', async () => {
  const w = makeWorld({ manifest: posterManifest() }); const hits = trackNet(w, () => 503); const p = w.make(); await p.ready;
  assert.ok(p.getInfo().trackRetries > 0, 'a retry is pending'); assert.strictEqual(p.packRemoved(), true); assert.strictEqual(p.packRemoved(), false, 'once');
  assert.strictEqual(p.getInfo().trackRetries, 0); assert.strictEqual(p.getInfo().packRemoved, true); await runFor(w, 60000); assert.strictEqual(sp1(hits), 1, 'no retry after the pack was removed'); p.destroy();
  assert.strictEqual(p.packRemoved(), false, 'destroyed');
  const w2 = makeWorld({ manifest: posterManifest() }); const h2 = trackNet(w2, () => 503); const p2 = w2.make(); await p2.ready; await w2.settle(100);
  assert.ok(p2.getInfo().trackRetries > 0); p2.destroy(); assert.strictEqual(w2.timers.filter(x => !x.tag).length, 0, 'destroy cleared every timer, the retries included');
  const before = sp1(h2); await runFor(w2, 60000); assert.strictEqual(sp1(h2), before, 'nothing fetched after destroy');
});

// ── portrait glow: the edge fade lives OUTSIDE the owl's safe box (fake DOM: the numbers, not how it looks) ──
const OWLBOX = { x: 0.194, y: 0.0607, w: 0.66, h: 0.9007 };   // the owl pack's real safeAreaComfort
test('portrait glow: with the owl comfort box the paper margin above and below is faded inside the margin only; the box itself stays opaque', async () => {
  const man = packManifest(packClips(), { safeAreaComfort: OWLBOX });
  const { w, p } = await started({}, { manifest: man, w: 390, h: 800 }); const sp = w.container.children[0].children[0], s = p.getInfo().stage;
  const k = 390 / (1280 * 0.66); near(s.picture.scale, k); near(s.h, 720 * k);
  // top margin = 0.0607 of the picture height, bottom = 1 - 0.0607 - 0.9007 = 0.0386 of the stage height (20.2 px and 12.8 px at 390 wide)
  // the 1 px margin pin (was: bottom = exactly the 3.86 percent margin): the fade now ends >= 1 css px short of the box, the 5 percent cap is unchanged
  { const m = boxMargins(s, OWLBOX); near(s.glow.top, 0.05); assert.ok(s.glow.bottom * s.h <= m.bottom - 1 && s.glow.bottom * s.h > m.bottom - 1.1, 'bottom fade ends 1 px above the box: ' + s.glow.bottom * s.h + ' of ' + m.bottom); }
  near(s.glow.left, 0, 'the view edge IS the box edge: no fade inside the box'); near(s.glow.right, 0);
  assert.match(sp.style.maskImage, /to bottom, transparent 0%, rgba\(0, 0, 0, 0\.35\) 2\.5%, #000 5%, #000 9\d\.\d+%, rgba\(0, 0, 0, 0\.35\) 9\d\.\d+%, transparent 100%/);
  assert.match(sp.style.maskImage, /to right, #000 0%, #000 100%/, 'no side feather at all over the comfort box');
  // the owl box (y 6.07% .. 96.14% of the picture = of the stage here) is opaque: the fade is over by the box's top edge, and starts at its bottom edge
  assert.ok(s.glow.top <= OWLBOX.y + 1e-9, 'fully opaque from the box top'); assert.ok(1 - s.glow.bottom >= OWLBOX.y + OWLBOX.h - 1e-9, 'and down to the box bottom');
  assert.strictEqual(sp.style.webkitMaskImage, sp.style.maskImage); p.destroy();
  // landscape: the same rule (bottom margin 3.86 percent only, so the bottom fade shrinks into it; the rest is the 5 percent cap)
  const l = await started({}, { manifest: man, w: 800, h: 450 }); const lg = l.p.getInfo().stage.glow; near(lg.top, 0.05); assert.ok(lg.bottom < 0.0386 && lg.bottom > 0.03, 'bottom shrinks into its margin minus 1 px: ' + lg.bottom); near(lg.left, 0.05); near(lg.right, 0.05);
  assert.match(l.w.container.children[0].children[0].style.maskImage, /to right, transparent 0%, #000 5%, #000 95%, transparent 100%/); l.p.destroy();
});
test('portrait glow: no safe area in the manifest (full-height fallback box) keeps the standard feather; a resize re-lays the glow; garbage safe area is ignored', async () => {
  const f = await started({}, { w: 390, h: 800 }); const g = f.p.getInfo().stage.glow; near(g.top, 0.05); near(g.bottom, 0.05); near(g.left, 0.05); near(g.right, 0.05);
  assert.match(f.w.container.children[0].children[0].style.maskImage, /to bottom, transparent 0%, #000 5%, #000 95%, transparent 100%/); f.p.destroy();
  let fire = null; const RO = function (cb) { fire = cb; this.observe = () => {}; this.disconnect = () => {}; };
  const man = packManifest(packClips(), { safeAreaComfort: OWLBOX });
  const { w, p } = await started({ ResizeObserver: RO }, { manifest: man, w: 800, h: 450 }); near(p.getInfo().stage.glow.top, 0.05);
  w.container.clientWidth = 390; w.container.clientHeight = 800; fire(); near(p.getInfo().stage.glow.top, 0.05); assert.match(w.container.children[0].children[0].style.maskImage, /rgba\(0, 0, 0, 0\.35\)/);
  w.container.clientWidth = 800; w.container.clientHeight = 450; fire(); assert.ok(p.getInfo().stage.glow.bottom < 0.0386 && p.getInfo().stage.glow.bottom > 0.03); assert.match(w.container.children[0].children[0].style.maskImage, /rgba\(0, 0, 0, 0\.35\)/); p.destroy();
  const bad = await started({}, { manifest: packManifest(packClips(), { safeAreaComfort: { x: 0.5, y: 0, w: 0.9, h: 1 } }), w: 390, h: 800 }); assert.strictEqual(bad.p.getInfo().stage.safeSource, 'fallback'); near(bad.p.getInfo().stage.glow.top, 0.05); bad.p.destroy();
});

// ── follow-ups: the comfort box is never feathered; the poster's outer ring is the background ──
// the opacity of the stage mask (0..1) at a fraction p of the stage along an axis, from the player's own numbers (a, b = the two edge fades; 0 = none)
// box margins in CSS px on the RENDERED (2-decimal) geometry the player writes: paper between the box edge and each stage edge
const r2 = n => Math.round(n * 100) / 100;
const boxMargins = (s, box) => { const pl = r2(s.picture.x - s.x), pt = r2(s.picture.y - s.y), pw = r2(s.picture.w), ph = r2(s.picture.h), sw = r2(s.w), sh = r2(s.h);
  return { left: pl + box.x * pw, right: sw - (pl + (box.x + box.w) * pw), top: pt + box.y * ph, bottom: sh - (pt + (box.y + box.h) * ph), sw, sh }; };
const maskAlpha = (p, a, b) => (a > 0 && p < a ? p / a : b > 0 && p > 1 - b ? (1 - p) / b : 1);
test('feather outside the comfort box: on a narrow stage the whole safe box is opaque (>= 0.98) at several sizes, and a zero edge has no gradient stops', async () => {
  const man = packManifest(packClips(), { safeAreaComfort: OWLBOX });
  for (const [cw, chh] of [[390, 844], [390, 800], [768, 1024], [600, 600], [1000, 1300]]) {
    const { w, p } = await started({}, { manifest: man, w: cw, h: chh }); const s = p.getInfo().stage, g = s.glow; assert.ok(g, cw + 'x' + chh + ': narrow stage');
    const bx = s.picture.x + OWLBOX.x * 1280 * s.picture.scale, bx1 = bx + OWLBOX.w * 1280 * s.picture.scale, by = s.picture.y + OWLBOX.y * 720 * s.picture.scale, by1 = by + OWLBOX.h * 720 * s.picture.scale;
    const fx = v => (v - s.x) / s.w, fy = v => (v - s.y) / s.h;   // the box edges as fractions of the stage
    for (const t of [0, 0.02, 0.1, 0.5, 0.9, 1]) {
      const px = fx(bx) + (fx(bx1) - fx(bx)) * t, py = fy(by) + (fy(by1) - fy(by)) * t;
      for (const q of [0, 0.5, 1]) {
        assert.ok(maskAlpha(Math.min(1, Math.max(0, px)), g.left, g.right) >= 0.98, cw + 'x' + chh + ' side alpha at box t=' + t);
        assert.ok(maskAlpha(Math.min(1, Math.max(0, py)), g.top, g.bottom) >= 0.98, cw + 'x' + chh + ' vertical alpha at box t=' + t + q);
      }
    }
    assert.ok(g.left <= Math.max(0, fx(bx)) + 1e-9 && g.right <= Math.max(0, 1 - fx(bx1)) + 1e-9, 'the side fades fit inside the margin outside the box');
    assert.ok(g.top <= Math.max(0, fy(by)) + 1e-9 && g.bottom <= Math.max(0, 1 - fy(by1)) + 1e-9, 'so do the top and bottom fades');
    if (g.left === 0) assert.ok(!/to right, transparent/.test(w.container.children[0].children[0].style.maskImage), 'a zero edge writes no transparent stop');
    p.destroy();
  }
  // a stage whose width leaves paper at the sides (the height cap binds): the side fade lives in that margin only, never more than the standard feather
  const wide = await started({}, { manifest: man, w: 700, h: 400 }); const gs = wide.p.getInfo().stage; assert.ok(gs.glow && gs.glow.left <= 0.05 + 1e-9, '700x400 is just narrower than 16:9'); wide.p.destroy();
});
test('feather cap: with the sampled poster border every fade is fully opaque by 5 percent of the stage in ALL layouts, the comfort box stays opaque, a zero-margin edge has no fade', async () => {
  const man = packManifest(packClips(), { safeAreaComfort: OWLBOX });
  for (const [cw, chh] of [[1100, 756.5], [800, 450], [1920, 1080], [390, 844], [768, 1024], [600, 600], [2000, 700]]) {
    const { p } = await started({}, { manifest: man, w: cw, h: chh }); const s = p.getInfo().stage, g = s.glow; assert.ok(g, cw + 'x' + chh);
    for (const [k, v] of Object.entries(g)) assert.ok(v <= 0.05 + 1e-9, cw + 'x' + chh + ' ' + k + ' fade ' + v + ' is over 5 percent');
    for (const q of [0.05, 0.06, 0.3, 0.5, 0.95]) {   // fully opaque from 5 percent in, on both axes and both ends
      assert.ok(maskAlpha(q, g.left, g.right) === 1 && maskAlpha(q, g.top, g.bottom) === 1 && maskAlpha(1 - q, g.left, g.right) === 1 && maskAlpha(1 - q, g.top, g.bottom) === 1, cw + 'x' + chh + ' opaque at ' + q);
    }
    const bx = s.picture.x + OWLBOX.x * 1280 * s.picture.scale, bx1 = bx + OWLBOX.w * 1280 * s.picture.scale, by = s.picture.y + OWLBOX.y * 720 * s.picture.scale, by1 = by + OWLBOX.h * 720 * s.picture.scale;
    for (const t of [0, 0.01, 0.5, 0.99, 1]) {
      const px = Math.min(1, Math.max(0, (bx + (bx1 - bx) * t - s.x) / s.w)), py = Math.min(1, Math.max(0, (by + (by1 - by) * t - s.y) / s.h));
      assert.ok(maskAlpha(px, g.left, g.right) >= 0.999 && maskAlpha(py, g.top, g.bottom) >= 0.999, cw + 'x' + chh + ' comfort box opaque at t=' + t);
    }
    p.destroy();
  }
  // desktop 1100 x 756.5: the height binds, the sides have paper margin, so they fade over 5 percent (55 px) at most; a wing tip 79 / 85 px in from an edge is opaque
  const d = await started({}, { manifest: man, w: 1100, h: 756.5 }); const ds = d.p.getInfo().stage; near(ds.glow.left, 0.05); near(ds.glow.right, 0.05);
  for (const px of [79, 85]) { assert.ok(maskAlpha(px / ds.w, ds.glow.left, ds.glow.right) >= 0.97, 'left tip at ' + px + 'px'); assert.ok(maskAlpha((ds.w - px) / ds.w, ds.glow.left, ds.glow.right) >= 0.97, 'right tip at ' + px + 'px'); }
  // the top fade (5 percent of the height) is over by 79 / 85 px too
  for (const px of [79, 85]) assert.ok(maskAlpha(px / ds.h, ds.glow.top, ds.glow.bottom) >= 0.97, 'top at ' + px + 'px'); d.p.destroy();
});
test('feather outside the comfort box: no manifest box (the full-height fallback) keeps the standard feather, landscape is unchanged', async () => {
  const f = await started({}, { w: 390, h: 800 }); const g = f.p.getInfo().stage.glow; near(g.left, 0.05); near(g.top, 0.05); f.p.destroy();
  const l = await started({}, { manifest: packManifest(packClips(), { safeAreaComfort: OWLBOX }), w: 800, h: 450 }); near(l.p.getInfo().stage.glow.left, 0.05);
  assert.match(l.w.container.children[0].children[0].style.maskImage, /to right, transparent 0%, #000 5%, #000 95%, transparent 100%/); l.p.destroy();
});
test('background from the poster: the outer ring of the decoded poster (not its inside) is the background, sampled once, before the picture is reported, and passed to the host', async () => {
  const seen = [], man = posterManifest({ background: '#ffd6ab' });
  const w = makeWorld({ manifest: man, posterRing: [200, 180, 160] }); let atPicture = null;
  const p = w.make({ onBackground: c => seen.push(c) }); p.pictureReady.then(() => { atPicture = w.container.children[0].style.background; });
  await p.ready; await w.settle(300);
  assert.strictEqual(atPicture, 'rgb(200,180,160)', 'already the poster colour when the first picture is reported: no flash');
  assert.strictEqual(w.container.children[0].style.background, 'rgb(200,180,160)', 'it wins over the manifest colour');
  assert.deepStrictEqual(seen, ['rgb(200,180,160)'], 'one colour, once, to the host'); assert.strictEqual(p.getInfo().background, 'rgb(200,180,160)');
  const draws = w.ctxCalls.filter(c => c[0] === 'drawImage' && c[1] && c[1].tag === 'img').length;
  p.setState('speaking'); p.setState('listening'); await w.settle(1500); assert.deepStrictEqual(seen, ['rgb(200,180,160)'], 'never sampled again, not from a video frame either');
  assert.strictEqual(w.container.children[0].style.background, 'rgb(200,180,160)'); assert.ok(draws >= 1); p.destroy();
});
test('background from the poster: without a poster the manifest colour stays; a failed poster, a throwing host callback and a destroy during the load change nothing else', async () => {
  const a = makeWorld({ manifest: packManifest(), posterRing: [1, 2, 3] }); const seen = []; const pa = a.make({ onBackground: c => seen.push(c) }); await pa.ready; await a.settle(200);
  assert.strictEqual(a.container.children[0].style.background, '#ffd6ab', 'no poster in the manifest: the manifest colour (the ring is not sampled from a video frame either)'); assert.deepStrictEqual(seen, []); pa.destroy();
  const b = makeWorld({ manifest: posterManifest(), posterRing: [1, 2, 3], posterFail: 'error' }); const pb = b.make({ onBackground: c => seen.push(c) }); await pb.ready; await b.settle(200);
  assert.strictEqual(b.container.children[0].style.background, '#ffd6ab', 'poster failed: the manifest colour'); assert.deepStrictEqual(seen, []); pb.destroy();
  const c = makeWorld({ manifest: posterManifest(), posterRing: [9, 8, 7] }); const pc = c.make({ onBackground: () => { throw new Error('host bug'); } }); await pc.ready; await c.settle(200);
  assert.strictEqual(c.container.children[0].style.background, 'rgb(9,8,7)'); assert.strictEqual(pc.getInfo().ready, true, 'a throwing host callback cannot break the player'); pc.destroy();
  const d = makeWorld({ manifest: posterManifest(), posterRing: [5, 5, 5], posterHold: true }); const late = []; const pd = d.make({ onBackground: x => late.push(x) });
  await d.settle(50); pd.destroy(); await d.settle(4000); assert.deepStrictEqual(late, [], 'destroyed before the poster decoded: nothing is reported afterwards');
});
test('background from the poster: an unreadable canvas (no pixels) keeps the manifest colour and still does not retry', async () => {
  const w = makeWorld({ manifest: posterManifest(), posterRing: [4, 4, 4] }); const orig = w.doc.createElement;
  w.doc.createElement = (tag) => { const e = orig(tag); if (tag === 'canvas') { const gc = e.getContext; e.getContext = (k) => { const cx = gc(k); return new Proxy({}, { get: (_, n) => (n === 'getImageData' ? () => { throw new Error('tainted'); } : cx[n]), set: () => true }); }; } return e; };
  const seen = []; const p = w.make({ onBackground: c => seen.push(c) }); await p.ready; await w.settle(200);
  assert.deepStrictEqual(seen, []); assert.strictEqual(w.container.children[0].style.background, '#ffd6ab'); p.destroy();
});

// ── final glow: the flat stage matches the poster corners, but the poster's top and bottom edge CENTRES are brighter, so a band showed at the clip edge.
// A soft glow of the poster's own top / bottom edge-row colours sits BEHIND the clip, runs out into the border colour, and is laid out again on resize / caption changes. ──
const EDGE = { top: u => { const b = Math.exp(-Math.pow((u - 0.5) / 0.22, 2)); return [240 + Math.round(16 * b), 214 + Math.round(14 * b), 171 + Math.round(12 * b)]; },
  bottom: u => { const b = Math.exp(-Math.pow((u - 0.45) / 0.25, 2)); return [240 + Math.round(12 * b), 214 + Math.round(10 * b), 171 + Math.round(9 * b)]; } };
const RING = [240, 214, 171];
const rgbaOf = c => { const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/.exec(c); return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null; };
const gradAt = (g, t) => {   // the colour + alpha of a recorded linear gradient at t (0..1), stops interpolated
  const st = g.stops.map(([o, c]) => [o, rgbaOf(c)]).sort((a, b) => a[0] - b[0]); if (t <= st[0][0]) return st[0][1]; if (t >= st[st.length - 1][0]) return st[st.length - 1][1];
  for (let i = 1; i < st.length; i++) if (t <= st[i][0]) { const a = st[i - 1], b = st[i], k = b[0] === a[0] ? 1 : (t - a[0]) / (b[0] - a[0]); return a[1].map((v, j) => v + (b[1][j] - v) * k); }
};
// what the glow canvas shows at container column x, container row y, over the border colour `bg`: the recorded fills, sampled the way the browser would
function glowColour(cv, cw, x, y, bg) {
  const top = parseFloat(cv.style.top) || 0, hpx = parseFloat(cv.style.height), col = Math.min(cv.width - 1, Math.floor(x / cw * cv.width)), row = (y - top) / hpx * cv.height;
  let out = bg.slice();
  for (const f of cv.log.fills) {
    const [rx, ry, rw, rh] = f.rect; if (col < rx || col >= rx + rw || row < ry || row >= ry + rh) continue;
    const g = f.style, t = (row - g.a[1]) / (g.a[3] - g.a[1]), c = gradAt(g, t), a = c[3];
    out = out.map((v, j) => v * (1 - a) + c[j] * a);
  }
  return out;
}
const glowCanvas = w => w.container.children[0].children[1];   // rootEl children: the stage, the glow (z 0, under the stage's z 1), the beak canvas
test('edge glow: a glow canvas sits BEHIND the clip stage, drawn from the decoded poster top and bottom edge rows, sampled once, and only the poster colours reach it', async () => {
  const man = posterManifest({ safeAreaComfort: OWLBOX }), world = makeWorld({ manifest: man, posterRing: RING, posterEdge: EDGE, w: 390, h: 800 });
  const p = world.make({}); await p.ready; await world.settle(300);
  const root = world.container.children[0], g = glowCanvas(world), st = root.children[0];
  assert.strictEqual(g.tag, 'canvas'); assert.strictEqual(st.tag, 'div'); assert.ok(Number(g.style.zIndex) < Number(st.style.zIndex), 'the glow is a layer BELOW the feathered clip stage'); assert.strictEqual(g.attrs['aria-hidden'], 'true');
  assert.strictEqual(g.style.pointerEvents, 'none'); assert.notStrictEqual(g.style.display, 'none');
  assert.strictEqual(world.edgeReads, 2, 'the top and the bottom edge row of the decoded poster were read, once each');
  const s = p.getInfo().stage, ch = 800, eg = s.edgeGlow;
  assert.ok(eg.top >= 0.15 * ch - 1e-6 && eg.bottom >= 0.15 * ch - 1e-6, 'the glow reaches at least 15 percent of the stage height beyond the clip top and bottom (' + eg.top + ', ' + eg.bottom + ')');
  assert.ok(s.y > 100 && s.y + s.h < ch - 100, 'a narrow stage: paper above and below the clip');
  // right at the clip edges the glow is the poster's own edge-row colour: the bright centre is brighter than the corner-like edge columns
  const cx = 195, at = (x, y) => glowColour(g, 390, x, y, RING);
  const topC = at(cx, s.y), topE = at(20, s.y), botC = at(390 * 0.45, s.y + s.h - 0.01);
  for (let j = 0; j < 3; j++) assert.ok(Math.abs(topC[j] - EDGE.top(0.5)[j]) <= 2.5, 'top centre channel ' + j + ': ' + topC[j] + ' vs ' + EDGE.top(0.5)[j]);
  assert.ok(topC[0] > topE[0] + 5, 'the centre glow is brighter than the edge column'); assert.ok(Math.abs(botC[0] - EDGE.bottom(0.45)[0]) <= 2.5, 'bottom row profile: ' + botC[0]);
  // far from the clip the glow has run out into the border colour
  const far = at(cx, s.y - eg.top + 0.5); assert.ok(far.every((v, j) => Math.abs(v - RING[j]) <= 1.5), 'far end is the border colour: ' + far);
  // no artwork / frame / zoom change: the clip stage geometry and the 5 percent feather caps are untouched
  near(s.glow.top, 0.05); assert.ok(s.glow.bottom < 0.0386 && s.glow.bottom > 0.03); assert.ok(s.glow.left <= 0.05 && s.glow.right <= 0.05);
  // posters are not read again for a resize, a state change or a speech turn
  const reads = world.edgeReads, draws = world.ctxCalls.filter(c => c[0] === 'drawImage' && c[1] && c[1].tag === 'img').length;
  p.setState('speaking'); await world.settle(800); p.setState('listening'); await world.settle(800); assert.strictEqual(world.edgeReads, reads, 'no new poster read');
  assert.strictEqual(world.ctxCalls.filter(c => c[0] === 'drawImage' && c[1] && c[1].tag === 'img').length >= draws, true);
  // cleanup: destroy takes the glow with the player, and nothing draws to it afterwards
  const n = g.log.fills.length; p.destroy(); assert.strictEqual(world.container.children.length, 0); await world.settle(500); assert.strictEqual(g.log.fills.length, n, 'nothing drawn after destroy');
});
test('edge glow: it is laid out again on resize and caption layout, not per frame; a flat stage with no room outside the clip hides it; no profile, no glow', async () => {
  let fire = null; const RO = function (cb) { fire = cb; this.observe = () => {}; this.disconnect = () => {}; };
  const man = posterManifest({ safeAreaComfort: OWLBOX }), world = makeWorld({ manifest: man, posterRing: RING, posterEdge: EDGE, w: 390, h: 800 });
  const p = world.make({ ResizeObserver: RO }); await p.ready; await world.settle(300); const g = glowCanvas(world);
  const e1 = p.getInfo().stage.edgeGlow.top, h1 = g.height; assert.ok(e1 > 100);
  const writes = world.ctxCalls.length; for (let i = 0; i < 20; i++) { world.tickRaf(16); } assert.strictEqual(world.ctxCalls.slice(writes).filter(c => c[0] === 'fillRect').length, 0, 'an idle frame draws no glow');
  world.container.clientHeight = 560; fire();   // the caption band took 240 px: the host is shorter
  const e2 = p.getInfo().stage.edgeGlow.top; assert.ok(e2 < e1 && e2 >= 0.15 * 560 - 1e-6, 'follows the new height: ' + e1 + ' -> ' + e2); assert.notStrictEqual(g.height, h1);
  const s2 = p.getInfo().stage; assert.ok(glowColour(g, 390, 195, s2.y, RING)[0] > 245, 'the new clip edge shows the profile colour');
  world.container.clientWidth = 800; world.container.clientHeight = 450; fire();   // 16:9 and flat: the clip fills the stage, nothing is outside it
  assert.strictEqual(g.style.display, 'none', 'no room outside the clip: the glow is hidden'); assert.strictEqual(p.getInfo().stage.edgeGlow.top, 0);
  world.container.clientWidth = 390; world.container.clientHeight = 800; fire(); assert.notStrictEqual(g.style.display, 'none'); near(p.getInfo().stage.edgeGlow.top, e1); p.destroy();
  // the poster's edge rows cannot be read (tainted canvas / odd data): no glow, the ring background and the rest are as before
  const w2 = makeWorld({ manifest: man, posterRing: RING, w: 390, h: 800 }); const seen = []; const q = w2.make({ onBackground: c => seen.push(c) }); await q.ready; await w2.settle(300);
  assert.strictEqual(glowCanvas(w2).style.display, 'none'); assert.deepStrictEqual(seen, ['rgb(240,214,171)']); assert.strictEqual(q.getInfo().ready, true); q.destroy();
  const w3 = makeWorld({ manifest: packManifest(), w: 390, h: 800 }); const r = w3.make({}); await r.ready; await w3.settle(200); assert.strictEqual(glowCanvas(w3).style.display, 'none', 'no poster image: no glow'); r.destroy();
});
test('edge glow: at tablet and phone, at rest and with captions, columns 10 / 50 / 90 percent, +/- 60 px around the clip top and bottom edges, no 24 px channel step is over 5', async () => {
  const man = posterManifest({ safeAreaComfort: OWLBOX });
  for (const beyond of [true, false]) for (const [cw, chh, label] of [[390, 844, 'phone rest'], [390, 560, 'phone captions'], [768, 1024, 'tablet rest'], [768, 800, 'tablet captions'], [360, 640, 'small phone']]) {
    const world = makeWorld({ manifest: man, posterRing: RING, posterEdge: EDGE, w: cw, h: chh }), p = world.make({ glowBeyond: beyond }); await p.ready; await world.settle(300);
    const g = glowCanvas(world), s = p.getInfo().stage, bg = RING;
    if (!beyond && (s.y < 0.15 * chh || chh - s.y - s.h < 0.15 * chh)) { p.destroy(); continue; }   // contained: only where the host itself has the room
    for (const f of [0.1, 0.5, 0.9]) {
      const x = cw * f, prof = (edge, y) => EDGE[edge](Math.min(1, Math.max(0, (x - s.picture.x) / s.picture.w)));
      for (const [edge, yEdge, dir] of [['top', s.y, -1], ['bottom', s.y + s.h, 1]]) {
        // outside the clip the glow, inside it the poster edge colour (the clip's own opaque picture at its edge)
        const colourAt = y => (dir * (y - yEdge) > 0 ? glowColour(g, cw, x, y, bg) : prof(edge, y));
        let worst = 0;
        for (let y = yEdge - 60; y + 24 <= yEdge + 60; y += 1) {
          if (y < 0 || y + 24 > (beyond ? chh * 1.3 : chh)) continue;
          const a = colourAt(y), b = colourAt(y + 24); for (let j = 0; j < 3; j++) worst = Math.max(worst, Math.abs(a[j] - b[j]));
        }
        assert.ok(worst <= 5, (beyond ? 'spilling ' : 'contained ') + label + ' ' + cw + 'x' + chh + ' column ' + f + ' ' + edge + ': worst 24 px step ' + worst.toFixed(2));
      }
    }
    p.destroy();
  }
});
test('edge glow: a host that clips (glowBeyond) may let the glow run past the host; by default it stays inside the player', async () => {
  const man = posterManifest({ safeAreaComfort: OWLBOX });
  const a = makeWorld({ manifest: man, posterRing: RING, posterEdge: EDGE, w: 390, h: 800 }), pa = a.make({}); await pa.ready; await a.settle(300);
  assert.strictEqual(a.container.children[0].style.overflow, 'hidden'); assert.ok(parseFloat(glowCanvas(a).style.top) >= 0 && parseFloat(glowCanvas(a).style.top) + parseFloat(glowCanvas(a).style.height) <= 800 + 1e-6, 'contained'); pa.destroy();
  const b = makeWorld({ manifest: man, posterRing: RING, posterEdge: EDGE, w: 390, h: 800 }), pb = b.make({ glowBeyond: true }); await pb.ready; await b.settle(300); const gb = glowCanvas(b);
  assert.strictEqual(b.container.children[0].style.overflow, 'visible'); assert.ok(parseFloat(gb.style.top) < 0 && parseFloat(gb.style.top) + parseFloat(gb.style.height) > 800, 'extends above and below the host (the host stage clips it)');
  assert.ok(pb.getInfo().stage.edgeGlow.top >= 0.15 * 800 && pb.getInfo().stage.edgeGlow.bottom >= 0.15 * 800); pb.destroy();
});

// ── mobile data cap: no speculative background fetches on a metered or slow link; on-demand playback is untouched ──
const webFetches = (w) => w.fetched.filter(x => /\/web\//.test(x)).length;
test('data cap: cellular, saveData and 2g/3g links start no background clip or track warm fetches; the player still plays on demand', async () => {
  for (const conn of [{ type: 'cellular' }, { saveData: true }, { effectiveType: '3g' }, { effectiveType: '2g' }, { effectiveType: 'slow-2g' }, { type: 'cellular', effectiveType: '4g', saveData: false }]) {
    const w = makeWorld(); const p = w.make({ navigator: { connection: conn }, warmLimit: 50 }); await p.ready; await w.settle(3000);
    assert.strictEqual(webFetches(w), 0, 'no clip warm fetch on ' + JSON.stringify(conn)); assert.strictEqual(p.getInfo().warmCapped, true); assert.ok(p.getInfo().tracks <= 2, 'only the first tracks (readiness), none warmed: ' + p.getInfo().tracks);
    p.setState('speaking'); await w.settle(1500); assert.match(p.getInfo().clip || '', /^speaking-/, 'on-demand speech still plays'); assert.ok(w.videos.some(v => /^speaking-/.test(v.clipName || '') && v.readyState === 4), 'its clip loaded on demand');
    p.setState('listening'); await w.settle(1500); assert.ok(p.getInfo().clip, 'other states still pick and load clips'); p.destroy();
  }
  const idle = makeWorld(); const q = idle.make({ navigator: { connection: { type: 'cellular' } } }); await q.ready; await idle.settle(3000); q.destroy();
  assert.strictEqual(idle.timers.filter(x => !x.tag).length, 0, 'nothing of the player is left pending');
});
test('data cap: no connection API, a wifi/4g link, and the window navigator behave as before; an explicit warmLimit 0 still means none; the cap reads win.navigator too', async () => {
  for (const nav of [undefined, {}, { connection: {} }, { connection: { type: 'wifi', effectiveType: '4g', saveData: false } }, { connection: { type: 'ethernet' } }, { connection: null }]) {
    const w = makeWorld(); const p = w.make(nav === undefined ? {} : { navigator: nav }); await p.ready; await w.settle(3000);
    assert.ok(webFetches(w) > 0, 'warm cache runs as before for ' + JSON.stringify(nav)); assert.strictEqual(p.getInfo().warmCapped, false); assert.strictEqual(p.getInfo().tracks, 4); p.destroy();
  }
  const z = makeWorld(); const pz = z.make({ warmLimit: 0, navigator: { connection: { type: 'wifi' } } }); await pz.ready; await z.settle(3000);
  assert.strictEqual(webFetches(z), 0, 'warmLimit 0 still means no clip warming'); assert.strictEqual(pz.getInfo().warmCapped, false, 'and it is the option, not the cap'); assert.strictEqual(pz.getInfo().tracks, 4, 'tracks still warm as before'); pz.destroy();
  const wn = makeWorld(); wn.win.navigator = { connection: { saveData: true } }; const pw = wn.make(); await pw.ready; await wn.settle(3000); assert.strictEqual(webFetches(wn), 0); assert.strictEqual(pw.getInfo().warmCapped, true); pw.destroy();
  const thrower = makeWorld(); const pt = thrower.make({ navigator: { get connection() { throw new Error('blocked'); } } }); await pt.ready; await thrower.settle(3000); assert.ok(webFetches(thrower) > 0, 'a throwing connection getter is no cap'); pt.destroy();
});

// ── a pack whose files disappear mid-call ──
// A pack is lost ONLY on a manifest probe verdict (404/410). Failed clips, failed tracks, timeouts, network errors, 5xx and stalls are never a loss.
test('verdict only: every clip fails and every probe times out, speech is asked: the poster and the animated beak stay for the whole reply, nothing is lost or unusable, no clip classification as lost', async () => {
  const lost = []; const w = makeWorld({ manifest: posterManifest() }); let mode = 'ok'; const st = probeNet(w, () => mode);
  const p = w.make({ onLost: r => lost.push(r) }); await p.ready; await w.settle(100);
  w.manifest.clips.forEach(c => w.fail.add(c.name)); mode = 'hang';   // the clips fail and the manifest probe never answers
  p.setAnalyser(analyserOf({ amp: 0.2, hz: 1500 })); p.setState('speaking'); await runFor(w, 60000);
  const i = p.getInfo(); assert.strictEqual(lost.length, 0, 'onLost never called'); assert.strictEqual(i.lost, null); assert.strictEqual(i.packRemoved, false); assert.strictEqual(i.destroyed, false);
  assert.strictEqual(i.coldHold, true, 'the animated beak is held for the whole reply'); assert.strictEqual(i.poster, true, 'over the poster'); assert.ok(SPEAKERS.every(s => i.bad.indexOf(s) >= 0), 'every speaker was set aside');
  w.ctxCalls.length = 0; for (let k = 0; k < 20; k++) w.tickRaf(16); assert.ok(beakDraws(w).length >= 10, 'the beak is still animated');
  assert.ok(heads(st).length >= 3, 'failed clips did ask for probes'); assertProbeRate(st, 'hang');
  p.setState('listening'); await w.settle(700); assert.strictEqual(p.getInfo().lost, null); p.destroy(); assert.strictEqual(w.timers.filter(x => !x.tag).length, 0);
});
test('verdict only: failed clips with a probe that times out, errors, answers 5xx/429, 200 or 304 are never a loss; failing probes stay within one start per second and one in flight', async () => {
  for (const kind of ['hang', 'throw', 500, 503, 429, 'ok', 304]) {
    const lost = []; const w = makeWorld(); let mode = 'ok'; const st = probeNet(w, () => mode);
    const p = w.make({ onLost: r => lost.push(r) }); await p.ready; await w.settle(100);
    w.manifest.clips.forEach(c => w.fail.add(c.name)); mode = kind; p.setState('listening'); await runFor(w, 45000);
    assert.strictEqual(lost.length, 0, kind + ': not lost'); assert.strictEqual(p.getInfo().lost, null); assert.strictEqual(p.getInfo().packRemoved, false); assert.strictEqual(p.getInfo().destroyed, false);
    assert.ok(heads(st).length >= 2, kind + ': a failed clip asks for a probe'); assertProbeRate(st, kind, 45);
    if (kind === 'ok' || kind === 304) assert.strictEqual(p.getInfo().probeVerdict, 'exists', kind + ': a recent 200/304 means the pack exists');
    mode = 404; const n0 = lost.length; await until(w, () => lost.length > n0, 12000); assert.strictEqual(lost.length, 1, kind + ': a later 404 is still the verdict'); p.destroy();
  }
});
test('verdict only: a tracked-speaking failure with the manifest answering 200 keeps the poster and beak for the reply, then the reply recovers when the clips come back (same reply and the next one)', async () => {
  const lost = []; const w = makeWorld({ manifest: posterManifest() }); const st = probeNet(w, () => 'ok'); SPEAKERS.forEach(n => w.fail.add(n));
  const p = w.make({ onLost: r => lost.push(r) }); await p.ready; await w.settle(100);
  p.setAnalyser(analyserOf({ amp: 0.2, hz: 1500 })); p.setState('speaking'); await w.settle(1000);
  let i = p.getInfo(); assert.strictEqual(i.coldHold, true); assert.strictEqual(i.poster, true); assert.strictEqual(lost.length, 0);
  SPEAKERS.forEach(n => w.fail.delete(n)); await w.settle(5000);   // the files are back: the bounded revival (2.5 s) picks a speaker up inside the same reply
  i = p.getInfo(); assert.match(i.clip, /^speaking-/, 'recovered inside the reply: ' + i.clip); assert.strictEqual(i.coldHold, false); assert.strictEqual(lost.length, 0); assert.strictEqual(i.lost, null);
  p.setState('listening'); await w.settle(700); SPEAKERS.forEach(n => w.fail.add(n)); p.setState('speaking'); await w.settle(1500); assert.strictEqual(p.getInfo().coldHold, true, 'a second reply with the clips failing again: held again');
  SPEAKERS.forEach(n => w.fail.delete(n)); await w.settle(5000); assert.match(p.getInfo().clip, /^speaking-/, 'and recovers again'); assert.strictEqual(lost.length, 0); assert.ok(heads(st).every(o => o.method === 'HEAD')); p.destroy();
});
test('verdict only: a stalled (frozen) picture, a hung clip load and a hidden page never count against the pack; a throwing onLost cannot break the player', async () => {
  const a = await started({ onLost: () => { throw new Error('host bug'); } });
  const first = a.w.manifest.clips.find(c => c.state === 'listening'); a.w.fail.add(first.name); a.p.setState('listening'); await a.w.settle(8000);
  assert.strictEqual(a.p.getInfo().lost, null, 'another clip played: not lost'); a.p.destroy();
  const b = await started({}); b.w.manifest.clips.forEach(c => b.w.fail.add(c.name)); b.p.setState('listening'); await b.w.settle(1000);
  b.w.hide(true); await b.w.settle(30000); assert.strictEqual(b.p.getInfo().lost, null, 'hidden: no verdict'); b.p.destroy();
  const w = makeWorld(); let mode = 'ok'; probeNet(w, () => mode); const lost = []; const p = w.make({ onLost: r => lost.push(r) }); await p.ready; await w.settle(100);
  mode = 'throw'; w.manifest.clips.forEach(c => w.hold.add(c.name)); const f = w.front(p); f.currentTime = Math.max(0, f.duration - 0.05); f._frozen = true;   // frozen picture, the next clip never loads, probes fail
  await runFor(w, 60000); assert.strictEqual(lost.length, 0, 'no stall heuristic'); assert.strictEqual(p.getInfo().lost, null); p.destroy();
  const d = makeWorld(); let dm = 'ok'; probeNet(d, () => dm); const pd = d.make({ onLost: () => { throw new Error('host bug'); } }); await pd.ready; await d.settle(100);
  dm = 404; await until(d, () => pd.getInfo().lost, 12000); assert.ok(pd.getInfo().lost, 'declared lost by the verdict even though the hook threw'); assert.doesNotThrow(() => pd.destroy());
});

// ── availability probe: a removed pack is noticed within ~3 s of the removal (<= 5 s), never from a transient failure ──
function playClock(w) {   // the fake video does not advance by itself: every playing, loaded video moves with the fake clock and fires 'ended' at its end (frozen once nothing new loads, as a real one)
  const adv = w.advance;
  w.advance = (ms) => {
    for (const v of w.videos) {
      if (v._frozen || v.paused || v.readyState !== 4 || !isFinite(v.duration) || v.currentTime >= v.duration) continue;
      v.currentTime = Math.min(v.duration, v.currentTime + ms / 1000);
      if (v.currentTime >= v.duration) v.end();
    }
    adv.call(w, ms);
  };
}
function probeNet(w, mode) {   // mode(): 'ok' | 404 | 410 | 304 | 500 | 'throw' | 'hang'; counts the manifest requests and the ones in flight (a hung one ends when the player aborts it, as fetch does)
  playClock(w);
  const orig = w.fetch; const st = { n: 0, inflight: 0, maxInflight: 0, opts: [], starts: [], t404: null, mode };
  w.fetch = async (u, o) => {
    if (!/manifest\.json$/.test(u)) return orig(u, o);
    st.n++; w.fetched.push(u); st.opts.push(o); st.starts.push(w.now); st.inflight++; st.maxInflight = Math.max(st.maxInflight, st.inflight);
    let live = true; const end = () => { if (live) { live = false; st.inflight--; } };   // an aborted request is over at the abort, as for the network
    try {
      const m = st.mode();
      if (m === 'hang') return await new Promise((_, rej) => { if (o && o.signal) o.signal.addEventListener('abort', () => { end(); rej(new Error('aborted')); }); });
      if (m === 'throw') throw new Error('network');
      if (m === 'ok') return { ok: true, status: 200, json: async () => w.manifest };
      if (m === 404 || m === 410) st.t404 = w.now;   // when the verdict response arrived
      return { ok: false, status: m };
    } finally { end(); }
  };
  return st;
}
const heads = (st) => st.opts.filter(o => o && o.method === 'HEAD');
function headStarts(st) { const a = []; st.opts.forEach((o, k) => { if (o && o.method === 'HEAD') a.push(st.starts[k]); }); return a; }
function assertProbeRate(st, kind, seconds) {   // one start per second at most, never two in flight, and the request is the HEAD/no-cache one
  const s = headStarts(st); for (let k = 1; k < s.length; k++) assert.ok(s[k] - s[k - 1] >= 1000, kind + ': probe starts at least 1 s apart: ' + (s[k] - s[k - 1]));
  assert.ok(st.maxInflight <= 1, kind + ': one in flight: ' + st.maxInflight); if (seconds) assert.ok(s.length <= seconds + 1, kind + ': at most one per second: ' + s.length);
  for (const o of heads(st)) { assert.strictEqual(o.cache, 'no-cache'); assert.strictEqual(o.credentials, 'same-origin'); }
}
async function until(w, cond, maxMs, step) { const t0 = w.now; while (!cond() && w.now - t0 < maxMs) { await new Promise(r => setImmediate(r)); w.advance(step || 20); } return w.now - t0; }
test('probe 404: the verdict closes at once from the RESPONSE (within 5 s of it), packRemoved set, never from anything else, no request of any kind after, every guard holds (next/holdLast/begin/warm/retries)', async () => {
  const lost = []; const w = makeWorld(); let mode = 'ok'; const st = probeNet(w, () => mode);
  const p = w.make({ onLost: r => lost.push(r) }); await p.ready; await w.settle(100);
  await until(w, () => heads(st).length >= 1, 15000); await new Promise(r => setImmediate(r)); w.advance(20);   // a background probe has just been answered: 200
  assert.strictEqual(p.getInfo().probeVerdict, 'exists'); assert.strictEqual(lost.length, 0); assert.ok(p.getInfo().clip, 'an animation is on screen');
  mode = 404; const took = await until(w, () => lost.length > 0, 11000);   // nothing failed: the next background probe is the only thing that can say it
  assert.strictEqual(lost.length, 1, 'notified once'); assert.ok(took <= 10100, 'the next background probe: ' + took); assert.ok(w.now - st.t404 <= 100, 'closed within 5 s (here: at once) of the verdict response: ' + (w.now - st.t404));
  assert.strictEqual(p.getInfo().packRemoved, true); assert.match(p.getInfo().lost, /no longer available/); assert.strictEqual(p.getInfo().probeVerdict, 'gone');
  const all = w.fetched.length, loads = w.videos.reduce((n, v) => n + v.loads, 0); await runFor(w, 40000); assert.strictEqual(w.fetched.length, all, 'no request of any kind once lost'); assert.strictEqual(lost.length, 1);
  assert.doesNotThrow(() => { p.setState('speaking'); p.setState('thinking'); p.react('curious'); w.hide(true); w.hide(false); p.setState('idle'); }); await runFor(w, 12000);
  assert.strictEqual(w.fetched.length, all, 'begin/next/holdLast/warm/retries are all silent once lost'); assert.strictEqual(w.videos.reduce((n, v) => n + v.loads, 0), loads, 'no clip load once lost'); assert.strictEqual(lost.length, 1);
  p.destroy(); assert.strictEqual(w.timers.filter(x => !x.tag).length, 0, 'no player timer left after destroy');
  for (const o of heads(st)) { assert.strictEqual(o.method, 'HEAD'); assert.strictEqual(o.cache, 'no-cache'); }   // the boot manifest request is the only GET
  assert.strictEqual(st.opts.filter(o => !o || o.method !== 'HEAD').length, 1);
});
test('probe 404/410 after a failed clip: the failure asks for a probe at once and the verdict closes it within ~1 s (rate limit), then nothing more is requested', async () => {
  for (const code of [404, 410]) {
    const lost = []; const w = makeWorld(); let mode = 'ok'; const st = probeNet(w, () => mode);
    const p = w.make({ onLost: r => lost.push(r) }); await p.ready; await w.settle(100);
    mode = code; w.manifest.clips.forEach(c => w.fail.add(c.name)); const t0 = w.now; p.setState('listening');
    await until(w, () => lost.length > 0, 8000); assert.strictEqual(lost.length, 1, code + ': lost'); assert.ok(w.now - t0 <= 2500, code + ': ASAP after the failing clip, not the 10 s cadence: ' + (w.now - t0));
    assert.strictEqual(p.getInfo().packRemoved, true); assert.match(p.getInfo().lost, /no longer available/);
    const all = w.fetched.length; await runFor(w, 30000); assert.strictEqual(w.fetched.length, all, 'no request after lost'); p.destroy();
  }
});
test('probe cadence: HEAD every 10 s in the background, starting only once ready (the boot request is the only GET), one in flight, bodies cancelled', async () => {
  const lost = []; const w = makeWorld(); let mode = 'ok'; const st = probeNet(w, () => mode); let cancels = 0;
  const f0 = w.fetch; w.fetch = async (u, o) => { const r = await f0(u, o); if (r && /manifest/.test(u) && r.status === 200 && st.n > 1) r.body = { cancel: () => { cancels++; return Promise.resolve(); } }; return r; };
  const p = w.make({ onLost: r => lost.push(r) }); await p.ready; assert.strictEqual(st.n, 1, 'the boot manifest request only');
  await runFor(w, 62000); const s = headStarts(st); assert.ok(s.length >= 5 && s.length <= 7, 'about one per 10 s: ' + s.length);
  for (let k = 1; k < s.length; k++) assert.ok(s[k] - s[k - 1] >= 9500 && s[k] - s[k - 1] <= 10600, 'gap ' + (s[k] - s[k - 1]));
  assertProbeRate(st, 'bg'); assert.ok(cancels >= s.length - 1, 'every probe body cancelled: ' + cancels); assert.strictEqual(lost.length, 0); assert.strictEqual(p.getInfo().probes, s.length); p.destroy();
});
test('probe cadence: 30 s on a data-capped link (cellular, saveData, 2g/3g), 10 s otherwise', async () => {
  for (const nav of [{ connection: { type: 'cellular' } }, { connection: { saveData: true } }, { connection: { effectiveType: '3g' } }]) {
    const w = makeWorld(); const st = probeNet(w, () => 'ok'); const p = w.make({ navigator: nav }); await p.ready; await runFor(w, 125000);
    const s = headStarts(st); assert.ok(s.length >= 3 && s.length <= 5, JSON.stringify(nav) + ': about one per 30 s: ' + s.length);
    for (let k = 1; k < s.length; k++) assert.ok(s[k] - s[k - 1] >= 29500 && s[k] - s[k - 1] <= 30600, 'gap ' + (s[k] - s[k - 1]));
    assertProbeRate(st, 'capped'); p.destroy();
  }
});
test('probe: 410 is gone too; transient failures (500, 503, 429, network error, timeout) are never a verdict; the timeout is bounded and a later 404 is still caught', async () => {
  const l410 = []; const w410 = makeWorld(); let m410 = 'ok'; probeNet(w410, () => m410); const p410 = w410.make({ onLost: r => l410.push(r) }); await p410.ready; await w410.settle(100);
  m410 = 410; await until(w410, () => l410.length > 0, 11000); assert.strictEqual(l410.length, 1); p410.destroy();
  for (const kind of [500, 503, 429, 'throw', 'hang']) {
    const lost = []; const w = makeWorld(); let mode = 'ok'; const st = probeNet(w, () => mode);
    const p = w.make({ onLost: r => lost.push(r) }); await p.ready; await w.settle(100); mode = kind; const n0 = heads(st).length;
    await runFor(w, 62000);
    assert.strictEqual(lost.length, 0, kind + ': not lost'); assert.strictEqual(p.getInfo().packRemoved, false); assert.strictEqual(p.getInfo().lost, null); assert.strictEqual(p.getInfo().probeVerdict, null, kind + ': no verdict');
    assertProbeRate(st, kind); assert.ok(heads(st).length - n0 >= 5 && heads(st).length - n0 <= 7, kind + ': bounded rate: ' + (heads(st).length - n0)); assert.ok(p.getInfo().clip, 'still animating');
    mode = 404; await until(w, () => lost.length > 0, 11000); assert.strictEqual(lost.length, 1, kind + ': a later 404 is still caught'); p.destroy();
  }
});
// fake videos that report a MediaError code while their clip is in w.fail, and count the source assignments per clip name
function errorCodes(w, codeOf) {
  const attempts = {}; const orig = w.doc.createElement;
  w.doc.createElement = function (tag) {
    const v = orig.call(this, tag);
    if (tag !== 'video') return v;
    return new Proxy(v, {   // the player sees the proxy; the world keeps the raw video (same listeners, same state)
      get(o, k) { if (k === 'error') return o.clipName && w.fail.has(o.clipName) ? { code: codeOf(o.clipName) } : null; return o[k]; },
      set(o, k, val) { if (k === 'src') { const m = /\/web\/([^/]+)\.mp4$/.exec(val); if (m) { const n = decodeURIComponent(m[1]); attempts[n] = (attempts[n] || 0) + 1; } } o[k] = val; return true; } });
  };
  return attempts;
}
test('outage recovery: a network outage keeps the picture, idle and listening clips set aside by it come back within 10 s of the network, and a server that answers the manifest but not the clips causes only a bounded number of retries (a decode error never)', async () => {
  const isIL = (n) => /^(idle|listening)-/.test(n);
  // part 1: 30 s outage, then recovery
  const lost = []; const w = makeWorld(); let mode = 'ok'; const st = probeNet(w, () => mode); const att = errorCodes(w, (n) => (n.length % 2 ? 2 : 4));
  const p = w.make({ onLost: r => lost.push(r) }); await p.ready; await w.settle(100);
  p.setState('listening'); await runFor(w, 6000);
  assert.ok(isIL(p.getInfo().clip), 'playing normally: ' + p.getInfo().clip); assert.strictEqual(p.getInfo().clipRevivals || 0, 0);
  w.manifest.clips.forEach(c => w.fail.add(c.name)); mode = 'throw';
  for (let k = 0; k < 30; k++) { if (k % 3 === 0) p.setState((k / 3) % 2 ? 'listening' : 'idle'); await runFor(w, 1000); assert.strictEqual(p.getInfo().drawable, true, 'a picture all through the outage'); }
  let i = p.getInfo();
  assert.strictEqual(lost.length, 0); assert.strictEqual(i.lost, null); assert.strictEqual(i.destroyed, false); assert.strictEqual(i.probeVerdict, null);
  const badIL = i.bad.filter(isIL); assert.ok(badIL.some(n => /^idle-/.test(n)) && badIL.some(n => /^listening-/.test(n)), 'idle and listening clips set aside: ' + i.bad.join());
  const before = i.clipRevivals;
  w.fail.clear(); mode = 'ok'; const t0 = w.now;
  await until(w, () => { const c = p.getInfo(); return isIL(c.clip || '') && c.clipRevivals > before && !c.bad.some(isIL); }, 10000);
  i = p.getInfo(); assert.ok(w.now - t0 <= 10000, 'within 10 s: ' + (w.now - t0));
  assert.ok(i.clipRevivals > 0, 'revived'); assert.ok(isIL(i.clip), 'animating again: ' + i.clip); assert.strictEqual(i.drawable, true); assert.strictEqual(i.probeVerdict, 'exists');
  const fr = w.front(p); assert.ok(fr && fr.clipName === i.clip && !fr.paused, 'the new clip is playing');
  assert.strictEqual(i.bad.filter(isIL).length, 0, 'no idle/listening clip is left set aside: ' + i.bad.join()); assert.strictEqual(lost.length, 0);
  await runFor(w, 10000); assert.ok(isIL(p.getInfo().clip)); p.destroy();
  // part 2: the manifest answers 200, every clip keeps failing (one with a decode error): bounded retries over 5 minutes
  const lost2 = []; const w2 = makeWorld(); probeNet(w2, () => 'ok'); const DEC = 'listening-2'; const a2 = errorCodes(w2, (n) => (n === DEC ? 3 : (n.length % 2 ? 2 : 4)));
  const q = w2.make({ onLost: r => lost2.push(r) }); await q.ready; await w2.settle(100);
  const before2 = Object.assign({}, a2);   // loads made before the failures began do not count
  w2.manifest.clips.forEach(c => w2.fail.add(c.name)); q.setState('listening'); await runFor(w2, 300000);
  const j = q.getInfo(); assert.strictEqual(lost2.length, 0); assert.strictEqual(j.lost, null); assert.strictEqual(j.drawable, true);
  for (const n of Object.keys(a2)) { const d = a2[n] - (before2[n] || 0); assert.ok(d <= 1 + 4 + 1, n + ': the first failure + at most CLIP_REVIVE_MAX revivals (+1 for a warm load): ' + d); }
  assert.ok(Object.keys(a2).length > 0 && j.clipRevivals > 0, 'it did retry, a little: ' + j.clipRevivals);
  assert.ok(j.clipRevivals <= 4 * w2.manifest.clips.length, 'bounded revivals: ' + j.clipRevivals);
  assert.ok(j.badFinal.indexOf(DEC) >= 0, 'the decode error is final: ' + j.badFinal.join()); assert.strictEqual(a2[DEC], 1, 'a decode error is never retried: ' + a2[DEC]);
  const n300 = Object.values(a2).reduce((s, x) => s + x, 0); await runFor(w2, 120000); assert.ok(Object.values(a2).reduce((s, x) => s + x, 0) - n300 <= 2 * w2.manifest.clips.length, 'and it stays quiet afterwards'); q.destroy();
});
const commitsOf = (p) => p.getInfo().log.filter(e => e.name && e.ev !== 'revive');
test('revive inside a start never starts a second clip: a goodbye that commits while released entries exist is the only commit of its start, and a probe answer during a load does not restart it', async () => {
  const w = makeWorld(); let mode = 'ok'; probeNet(w, () => mode); const p = w.make(); await p.ready; await w.settle(100);
  w.manifest.clips.forEach(c => w.fail.add(c.name)); mode = 'throw'; p.setState('listening');
  await runFor(w, 20000);   // every clip fails, the probe throws: frozen, holdLast's retry pending
  let i = p.getInfo(); assert.ok(i.bad.length >= 5, 'set-up: clips set aside: ' + i.bad.join()); assert.strictEqual(i.clipRevivals, 0, 'set-up: nothing revived while the probe fails');
  await runFor(w, 6000);   // every entry is past its 5 s wait: eligible, but nothing has released them
  const base = commitsOf(p).length, clipBefore = p.getInfo().clip, nBad = p.getInfo().bad.length;
  w.fail.clear(); const plays0 = w.played.length, revs0 = p.getInfo().clipRevivals;
  assert.strictEqual(p.react('goodbye'), true, 'the goodbye is accepted');
  await runFor(w, 100);   // long enough for the 10 ms load, not for the 2.5 s retry
  const cs = commitsOf(p).slice(base); assert.strictEqual(cs.length, 1, 'exactly one commit for this start: ' + cs.map(c => c.name).join());
  assert.match(cs[0].name, /goodbye/); i = p.getInfo(); assert.strictEqual(i.clip, cs[0].name, 'the goodbye clip is the one shown (clip before: ' + clipBefore + ')');
  assert.strictEqual(w.front(p).clipName, cs[0].name, 'and the one in front'); assert.ok(!w.front(p).paused);
  assert.ok(i.clipRevivals > revs0, 'the commit released entries that were eligible'); assert.ok(i.bad.length < nBad, 'released: ' + i.bad.length + ' < ' + nBad);
  assert.deepStrictEqual(w.played.slice(plays0), [cs[0].name], 'only the goodbye video was played by that start: ' + w.played.slice(plays0).join());
  // a probe answer while a start is loading does not restart that load
  const q = makeWorld(); let m2 = 'ok'; probeNet(q, () => m2); const pq = q.make(); await pq.ready; await q.settle(100);
  q.manifest.clips.forEach(c => q.fail.add(c.name)); m2 = 'throw'; pq.setState('listening'); await runFor(q, 12000);
  assert.ok(pq.getInfo().bad.length >= 5, 'set-up 2: clips set aside'); await runFor(q, 6000);
  q.fail.clear(); q.hold.add('reaction-goodbye-1'); const b0 = commitsOf(pq).length, pl0 = q.played.length;
  assert.strictEqual(pq.react('goodbye'), true); await runFor(q, 300);   // the goodbye is loading (held): loadTimer pending
  assert.strictEqual(commitsOf(pq).length, b0, 'still loading'); m2 = 'ok'; await until(q, () => pq.getInfo().probeVerdict === 'exists', 7000, 50);   // a probe answers 200 while it loads (inside its 8 s wait)
  assert.strictEqual(pq.getInfo().probeVerdict, 'exists'); assert.strictEqual(commitsOf(pq).length, b0, 'the probe answer started nothing else'); assert.strictEqual(q.played.length, pl0, 'no clip was started by the revive');
  q.hold.delete('reaction-goodbye-1'); const gv = q.videos.find(v => v.clipName === 'reaction-goodbye-1' && v._src && v.readyState === 0);
  assert.ok(gv, 'the held goodbye video is the one waiting'); gv.src = gv._src;   // released: it loads
  await runFor(q, 200); const cq = commitsOf(pq).slice(b0); assert.strictEqual(cq.length, 1, 'the held clip still commits when released: ' + cq.map(c => c.name).join()); assert.strictEqual(cq[0].name, 'reaction-goodbye-1');
  assert.strictEqual(pq.getInfo().clip, 'reaction-goodbye-1'); pq.destroy(); p.destroy();
});
test('a clip that loads again after an outage starts its failure count afresh: after two failures and one good load it is eligible after 5 s again, not 45 s', async () => {
  const w = makeWorld(); probeNet(w, () => 'ok'); const T = 'thinking-1'; let failAll = false, failT = false;   // the only thinking clip: always the one chosen in that state
  const loads = []; const orig = w.doc.createElement;   // the time of every source assignment of T (a failed load is over 10 ms later)
  w.doc.createElement = function (tag) {
    const v = orig.call(this, tag); if (tag !== 'video') return v;
    return new Proxy(v, { get: (o, k) => o[k], set(o, k, val) { if (k === 'src' && /\/thinking-1\.mp4$/.test(val)) loads.push(w.now); o[k] = val; return true; } });
  };
  const p = w.make(); await p.ready; await w.settle(100);
  w.fail = { has: (n) => (n === T ? failT : failAll), add() {}, delete() {}, clear() {} };
  failAll = true; failT = true; p.setState('thinking');
  await until(w, () => loads.length >= 2, 60000, 20); failT = false;   // failure 1, then the retry after its wait fails too (failure 2); the outage is over for T
  const w1 = loads[1] - loads[0]; assert.ok(w1 >= 4900 && w1 <= 16000, 'first wait is 5 s (the revival comes with the next probe answer, every 10 s): ' + w1);
  await until(w, () => loads.length >= 3, 60000, 20); const w2 = loads[2] - loads[1]; assert.ok(w2 >= 14900 && w2 <= 26000, 'second wait is 15 s (+ probe cadence): ' + w2);
  await until(w, () => p.getInfo().clip === T, 3000, 20); assert.strictEqual(p.getInfo().clip, T, T + ' loaded and plays again after the second outage'); assert.ok(!p.getInfo().bad.includes(T));
  const n = loads.length; failT = true;   // it fails again: the two old failures no longer count
  await until(w, () => p.getInfo().bad.includes(T), 20000, 20); assert.ok(p.getInfo().bad.includes(T), 'failed again');   // the failed load is noticed when the clip is due
  const tBad = w.now, m = loads.length; await until(w, () => loads.length > m, 60000, 20);
  const w3 = loads[m] - tBad; assert.ok(loads.length > m, 'tried again'); assert.ok(w3 >= 4900 && w3 <= 16000, 'after a good load the wait is the first one again (5 s), not the third (45 s): ' + w3);
  p.destroy();
});
test('outage recovery with speech: the probe answers 200, every clip keeps failing and the state switches speaking/listening every 10 s for 5 minutes: source assignments stay within CLIP_REVIVE_MAX plus the per-reply speaker budget, a decode error is never retried', async () => {
  const w = makeWorld({ manifest: posterManifest() }); probeNet(w, () => 'ok'); const DEC = 'listening-2'; const att = errorCodes(w, (n) => (n === DEC ? 3 : (n.length % 2 ? 2 : 4)));
  const lost = []; const p = w.make({ onLost: r => lost.push(r) }); await p.ready; await w.settle(100);
  const before = Object.assign({}, att); w.manifest.clips.forEach(c => w.fail.add(c.name));
  let replies = 0; for (let k = 0; k < 30; k++) { const s = k % 2 ? 'listening' : 'speaking'; if (s === 'speaking') replies++; p.setState(s); await runFor(w, 10000); }
  const j = p.getInfo(); assert.strictEqual(lost.length, 0); assert.strictEqual(j.lost, null); assert.strictEqual(j.drawable, true);
  const SPEAK_REVIVE_MAX = 2, base = 1 + 4 + 1, cap = base + SPEAK_REVIVE_MAX * replies;   // tracked speaking clips: first failure + CLIP_REVIVE_MAX revivals + a warm load, plus 2 reviveSpeakers retries per reply (15 replies: 30)
  const speakers = w.manifest.clips.filter(c => c.state === 'speaking' && c.track).map(c => c.name);
  for (const n of Object.keys(att)) { const d = att[n] - (before[n] || 0); const lim = speakers.includes(n) ? cap : base; assert.ok(d <= lim, n + ': ' + d + ' source assignments, at most ' + lim + (speakers.includes(n) ? ' (= 1 + 4 + 1 + SPEAK_REVIVE_MAX * ' + replies + ' replies)' : ' (= 1 + 4 + 1)')); }
  assert.ok(Object.keys(att).length > 0 && j.clipRevivals > 0, 'it did retry, a little: ' + j.clipRevivals);
  assert.ok(j.badFinal.indexOf(DEC) >= 0, 'the decode error is final: ' + j.badFinal.join()); assert.strictEqual(att[DEC] - (before[DEC] || 0), 1, 'a decode error is never retried: ' + att[DEC]);
  p.destroy();
});
test('probe: hidden stops it (no request, in-flight one has no say), visible probes at once and catches a removal that happened while hidden', async () => {
  const lost = []; const w = makeWorld(); let mode = 'ok'; const st = probeNet(w, () => mode);
  const p = w.make({ onLost: r => lost.push(r) }); await p.ready; await w.settle(100);
  w.hide(true); const n0 = st.n; mode = 404; await runFor(w, 35000); assert.strictEqual(st.n, n0, 'nothing while hidden'); assert.strictEqual(lost.length, 0);
  w.hide(false); await w.settle(50); assert.strictEqual(st.n, n0 + 1, 'an immediate probe on visible'); assert.strictEqual(lost.length, 1, 'gone found right away');
  p.destroy();
  const w2 = makeWorld(); let m2 = 'ok'; const s2 = probeNet(w2, () => m2); const l2 = []; const q = w2.make({ onLost: r => l2.push(r) }); await q.ready; await w2.settle(100);
  await until(w2, () => heads(s2).length >= 1, 12000); m2 = 'hang'; await until(w2, () => s2.inflight > 0, 12000);
  m2 = 404; w2.hide(true); await runFor(w2, 5000); assert.strictEqual(l2.length, 0, 'a request cancelled by hiding gives no verdict'); assert.strictEqual(s2.inflight, 0, 'and it was aborted'); q.destroy();
  const w3 = makeWorld(); let m3 = 'ok'; const s3 = probeNet(w3, () => m3); const p3 = w3.make(); await p3.ready; m3 = 500; w3.manifest.clips.forEach(c => w3.fail.add(c.name)); p3.setState('listening'); await w3.settle(300); w3.hide(true); const h3 = s3.n; await runFor(w3, 20000);
  assert.strictEqual(s3.n, h3, 'failed clips while hidden do not probe'); p3.destroy();
});
test('probe: destroy cancels it (no timer, no request after), an injected manifest or probe:false never probes, a lost report is not repeated by the clip timer', async () => {
  const w = makeWorld(); const st = probeNet(w, () => 'ok'); const p = w.make(); await p.ready; await w.settle(100); await until(w, () => st.n >= 2, 12000);
  p.destroy(); const n = st.n, f = w.fetched.length; await runFor(w, 20000); assert.strictEqual(st.n, n); assert.strictEqual(w.fetched.length, f, 'no call after destroy'); assert.strictEqual(w.timers.filter(x => !x.tag).length, 0);
  const wi = makeWorld(); const si = probeNet(wi, () => 404); const pi = wi.make({ manifest: wi.manifest }); await pi.ready; await runFor(wi, 10000); assert.strictEqual(si.n, 0); pi.destroy();
  const wf = makeWorld(); let fm = 'ok'; const sf = probeNet(wf, () => fm); const lf = []; const pf = wf.make({ probe: false, onLost: r => lf.push(r) }); await pf.ready; await wf.settle(100); fm = 404; const b = sf.n; await runFor(wf, 10000); assert.strictEqual(sf.n, b); assert.strictEqual(lf.length, 0); pf.destroy();
  const wl = makeWorld(); let m = 'ok'; probeNet(wl, () => m); const ll = []; const pl = wl.make({ onLost: r => ll.push(r) }); await pl.ready; await wl.settle(100);
  m = 404; wl.manifest.clips.forEach(c => wl.fail.add(c.name)); pl.setState('listening'); await runFor(wl, 15000); assert.strictEqual(ll.length, 1, 'once only');
  pl.destroy();
});
test('probe: transient track 500 with the manifest still there is unaffected: poster and beak fallback stay, retries stay 5 s / 20 s, never lost', async () => {
  const lost = []; const w = makeWorld({ manifest: posterManifest() }); const hits = trackNet(w, () => 500); const st = probeNet(w, () => 'ok');
  const p = w.make({ onLost: r => lost.push(r) }); await p.ready; assert.match(p.getInfo().degraded, /speaking track/);
  await runFor(w, 60000); assert.strictEqual(sp1(hits), 3, 'boot + 5 s + 20 s retries, then never'); assert.strictEqual(lost.length, 0); assert.strictEqual(p.getInfo().lost, null);
  assert.strictEqual(p.getInfo().packRemoved, false); assert.ok(p.getInfo().poster || p.getInfo().posterImage, 'poster still the picture'); p.destroy();
});

// ── a stalled picture is never a loss (the old no-progress fallback is gone): only a 404/410 probe verdict is ──
test('no stall heuristic: a frozen picture, a clip that never loads and probes that fail or hang for minutes never call the pack lost; reduced motion and hidden are the same', async () => {
  for (const kind of ['ok', 'hang', 'throw', 500, 503]) {
    const lost = []; const w = makeWorld(); let mode = 'ok'; const st = probeNet(w, () => mode);
    const p = w.make({ onLost: r => lost.push(r) }); await p.ready; await w.settle(100);
    mode = kind; w.manifest.clips.forEach(c => w.hold.add(c.name));
    const f = w.front(p); f.currentTime = Math.max(0, f.duration - 0.05); f._frozen = true;   // the presented picture stops where it is, nothing newer ever arrives
    await runFor(w, 90000); assert.strictEqual(lost.length, 0, kind + ': a frozen picture is not a loss'); assert.strictEqual(p.getInfo().lost, null); assert.strictEqual(p.getInfo().packRemoved, false); assertProbeRate(st, kind); p.destroy();
  }
  for (const kind of ['hang', 'throw', 500]) {
    const w = makeWorld(); let mode = 'ok'; probeNet(w, () => mode); const lost = []; const p = w.make({ reducedMotion: true, onLost: r => lost.push(r) }); await p.ready; await w.settle(100);
    mode = kind; await runFor(w, 60000); assert.strictEqual(lost.length, 0, kind + ': reduced motion'); assert.strictEqual(p.getInfo().lost, null); p.destroy();
  }
  const w3 = makeWorld({ manifest: posterManifest() }); trackNet(w3, () => 500); let m3 = 'ok'; probeNet(w3, () => m3); const l3 = [];
  const p3 = w3.make({ onLost: r => l3.push(r) }); await p3.ready; m3 = 'throw'; await runFor(w3, 60000); assert.strictEqual(l3.length, 0); assert.ok(p3.getInfo().poster || p3.getInfo().posterImage, 'the poster stays'); p3.destroy();
  const b = makeWorld(); let mb = 'ok'; probeNet(b, () => mb); const lb = []; const pb = b.make({ onLost: r => lb.push(r) }); await pb.ready; mb = 'hang'; b.hide(true); await runFor(b, 30000); assert.strictEqual(lb.length, 0); pb.destroy();
});
test('probe request: a HEAD of the manifest with cache no-cache and same-origin credentials, even the first one (never a body download), the boot request is the only GET', async () => {
  const w = makeWorld(); const st = probeNet(w, () => 'ok'); const p = w.make(); await p.ready; await until(w, () => heads(st).length >= 1, 12000); await w.settle(100);
  const h = heads(st)[0]; assert.strictEqual(h.method, 'HEAD'); assert.strictEqual(h.cache, 'no-cache'); assert.strictEqual(h.credentials, 'same-origin'); assert.ok(h.signal, 'cancellable');
  assert.strictEqual(st.opts.filter(o => !o || o.method !== 'HEAD').length, 1, 'only the boot manifest request is not a HEAD'); assert.notStrictEqual(st.opts[0].method, 'HEAD'); assert.strictEqual(p.getInfo().probeVerdict, 'exists'); p.destroy();
});

// ── no poster and the first speaking tracks fail transiently: ready rejects (the display decides, None), nothing keeps retrying, destroy cancels the rest ──
test('no poster + first speaking tracks 500: ready rejects (no unusable first picture promise), the player stays harmless, bounded retries end, destroy cancels them', async () => {
  for (const kind of [500, 503, 'throw']) {
    const w = makeWorld(); const hits = trackNet(w, () => kind); const p = w.make();
    await assert.rejects(p.ready, /speaking track/); assert.strictEqual(p.getInfo().ready, false); assert.strictEqual(p.getInfo().posterImage, false, 'there is no poster in this pack');
    assert.strictEqual(w.played.length, 0, 'nothing plays'); assert.strictEqual(p.react('hello'), false); assert.doesNotThrow(() => p.setState('speaking'));
    const first = w.fetched.length; await runFor(w, 90000);
    assert.ok(sp1(hits) <= 3, kind + ': at most boot + 5 s + 20 s retries: ' + sp1(hits)); assert.strictEqual(p.getInfo().ready, false, 'a late track does not revive a rejected player into a surprise display');
    assert.ok(w.fetched.length - first <= 4, 'no tight loop'); assert.strictEqual(p.getInfo().trackRetries, 0);
    p.destroy();
  }
  // destroy right after the rejection, while a retry is still pending: nothing is requested afterwards and no player timer is left
  const w = makeWorld(); const hits = trackNet(w, () => 500); const p = w.make(); await assert.rejects(p.ready, /speaking track/);
  assert.ok(p.getInfo().trackRetries > 0, 'set-up: a retry is pending'); const n = sp1(hits), f = w.fetched.length; p.destroy();
  assert.strictEqual(w.timers.filter(x => !x.tag).length, 0, 'destroy cleared every player timer'); await runFor(w, 60000);
  assert.strictEqual(sp1(hits), n, 'no retry after destroy'); assert.strictEqual(w.fetched.length, f, 'no request of any kind after destroy');
});

// ── 1 px opaque margin outside the comfort box, on the rendered geometry ──
test('comfort box margin: on every layout the opaque mask range reaches >= 1 css px OUTSIDE the box (rendered geometry), the 5 percent cap holds, an edge without the room has no feather', async () => {
  const man = packManifest(packClips(), { safeAreaComfort: OWLBOX });
  // phone, tablet, desktop, plus caption host sizes (a shorter host after the caption band) and an odd fractional one
  for (const [cw, chh] of [[390, 844], [768, 1024], [1100, 850], [390, 560], [768, 800], [1100, 600], [1100, 756.5], [800, 450]]) {
    const { w, p } = await started({}, { manifest: man, w: cw, h: chh }); const s = p.getInfo().stage, g = s.glow, m = boxMargins(s, OWLBOX), tag = cw + 'x' + chh;
    const sp = w.container.children[0].children[0];
    for (const [k, v] of Object.entries(g)) assert.ok(v <= 0.05 + 1e-9, tag + ' ' + k + ' is over the 5 percent cap: ' + v);
    const dim = { left: m.sw, right: m.sw, top: m.sh, bottom: m.sh };
    for (const k of ['left', 'right', 'top', 'bottom']) {
      const ramp = g[k] * dim[k];   // px the fade covers from its stage edge
      if (m[k] < 1) assert.strictEqual(g[k], 0, tag + ' ' + k + ': box at or past the stage edge, zero feather (margin ' + m[k] + ')');
      else assert.ok(ramp <= m[k] - 1 + 1e-9, tag + ' ' + k + ': opaque ramp ends ' + ramp + ' px in, box starts ' + m[k] + ' px in (needs a 1 px gap)');
      if (m[k] >= 1.5 && g[k] < 0.05 - 1e-9) assert.ok(ramp > m[k] - 1.1, tag + ' ' + k + ': no more shrink than the 1 px margin');
    }
    assert.match(sp.style.maskImage, /linear-gradient/); assert.strictEqual(sp.style.webkitMaskImage, sp.style.maskImage); p.destroy();
  }
});
test('comfort box margin: impossible margin (a safe box wider than the picture leaves less than 1 px) gives zero feather on that edge; the fallback box keeps the standard feather', async () => {
  const tight = packManifest(packClips(), { safeAreaComfort: { x: 0.0005, y: 0.0005, w: 0.999, h: 0.999 } });
  const { w, p } = await started({}, { manifest: tight, w: 800, h: 450 }); const s = p.getInfo().stage, g = s.glow;
  assert.strictEqual(s.safeSource !== 'fallback', true);
  for (const k of ['left', 'right', 'top', 'bottom']) assert.strictEqual(g[k], 0, k + ' has under 1 px of paper outside the box');
  assert.match(w.container.children[0].children[0].style.maskImage, /to right, #000 0%, #000 100%/); p.destroy();
  const f = await started({}, { w: 800, h: 450 }); assert.strictEqual(f.p.getInfo().stage.safeSource, 'fallback'); near(f.p.getInfo().stage.glow.left, 0.05); f.p.destroy();
});

// ── the removal verdict is the MANIFEST's, and a lost / removed pack starts nothing at all ──
test('ready rejection: only the manifest answering 404/410 is tagged packGone; a 404 of any other asset (tracks, ...) or a plain failure never is', async () => {
  for (const status of [404, 410]) {
    const w = makeWorld(); w.fetch = async (u) => { w.fetched.push(u); return { ok: false, status }; };
    const p = w.make(); const e = await p.ready.then(() => null, x => x); assert.ok(e, 'rejected'); assert.strictEqual(e.status, status); assert.strictEqual(e.packGone, true, 'manifest ' + status); p.destroy();
  }
  const t = makeWorld({ fetchFail: u => /\/tracks\//.test(u) }); const pt = t.make(); const et = await pt.ready.then(() => null, x => x);
  assert.match(et.message, /speaking track/); assert.notStrictEqual(et.packGone, true, 'every track 404: not a removal'); pt.destroy();
  const m = makeWorld({ manifest: { clips: [], beak: {} } }); const pm = m.make(); const em = await pm.ready.then(() => null, x => x); assert.notStrictEqual(em.packGone, true, 'an unusable manifest is not a removal'); pm.destroy();
  const s = makeWorld(); s.fetch = async (u) => { s.fetched.push(u); return { ok: false, status: 503 }; };
  const ps = s.make(); const es = await ps.ready.then(() => null, x => x); assert.strictEqual(es.status, 503); assert.notStrictEqual(es.packGone, true, '5xx is no verdict'); ps.destroy();
});
test('packRemoved() while the cache start still waits on a hello: no background request starts afterwards (warmSoon is guarded)', async () => {
  const w = makeWorld({ manifest: posterManifest() }); w.hold.add('reaction-hello-1'); const p = w.make(); p.react('hello'); await p.ready; await w.settle(300);
  assert.strictEqual(w.fetched.filter(u => /\/web\//.test(u)).length, 0, 'the cache is still waiting for the hello');
  assert.strictEqual(p.packRemoved(), true); const at = w.fetched.length; await w.settle(8000);
  assert.strictEqual(w.fetched.length, at, 'nothing was requested after the removal'); p.destroy();
});
