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
  const t = { now: 1000, timers: [], tid: 0, raf: [], rid: 0, videos: [], canvases: [], imgs: [], fetched: [], listeners: {}, hold: new Set(), fail: new Set(), ctxCalls: [], canvasWrites: 0, played: [], docL: {} };
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
      v._src = u; v.readyState = 0; v.duration = NaN; v.clipName = nameOf(u);
      if (t.hold.has(v.clipName)) return;
      setTimeoutF(() => { if (v._src !== u) return; if (t.fail.has(v.clipName)) { v.currentSrc = u; v.fire('error'); return; } v.currentSrc = u; v.readyState = 4; v.duration = durOf(u); v.fire('loadeddata'); }, 10, true);
    } });
    v.load = () => { v.loads++; };
    v.play = () => { v.paused = false; v.plays++; t.played.push(v.clipName); if (!t.noPlaying) setTimeoutF(() => { if (!v.paused) v.fire('playing'); }, 20, true); return Promise.resolve(); };
    v.pause = () => { v.paused = true; v.pauses++; };
    v.requestVideoFrameCallback = (cb) => { v._rvfc = cb; return ++id; };
    v.cancelVideoFrameCallback = () => { v._rvfc = null; };
    v.frame = (mediaTime, now) => { const cb = v._rvfc; v._rvfc = null; if (cb) cb(now == null ? t.now : now, { mediaTime }); return !!cb; };
    v.end = () => { v.fire('ended'); };
    return v;
  };
  const gradCtx = () => new Proxy({}, {
    get(_, k) { if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(32 * 18 * 4).fill(100) }); return (...a) => { t.ctxCalls.push([k, ...a]); }; },
    set(_, k, v) { t.ctxCalls.push([k, v]); return true; },
  });
  const doc = { hidden: false, visibilityState: 'visible',
    createElement(tag) {
      if (tag === 'video') { const v = mkVideo(); t.videos.push(v); return v; }
      if (tag === 'canvas') {
        const c = mkEl('canvas'); let w = 0, h = 0; const cx = gradCtx();
        Object.defineProperty(c, 'width', { get: () => w, set: (v) => { w = v; t.canvasWrites++; } });
        Object.defineProperty(c, 'height', { get: () => h, set: (v) => { h = v; } });
        c.getContext = () => cx; t.canvases.push(c); return c;
      }
      if (tag === 'img') { const im = mkEl('img'); im.complete = true; Object.defineProperty(im, 'src', { get: () => im._s, set: (u) => { im._s = u; const n = (/\/beak\/([^/]+)\.png$/.exec(u) || [])[1]; if (opts.imgHold && opts.imgHold.has(n)) return; setTimeoutF(() => { if (opts.imgFail && opts.imgFail.has(n)) { if (im.onerror) im.onerror(); } else if (im.onload) im.onload(); }, 5, true); } }); t.imgs.push(im); return im; }
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
test('pose rules in the player: from rest, speaking waits for the way back (no shortcut cross-fade), then the speaking clip', async () => {
  const clips = [clip('idle-up', 'idle', { endsOn: 'B', dur: 3 }), clip('idle-back', 'idle', { startsFrom: 'B', dur: 2 }), clip('speaking-1', 'speaking', { track: true, beakEnds: 'closed' }), clip('listening-1', 'listening')];
  const w = makeWorld({ manifest: packManifest(clips) }); const p = w.make(); await p.ready; await w.settle(100);
  assert.strictEqual(p.getInfo().clip, 'idle-up'); assert.strictEqual(p.getInfo().pose, 'B');
  p.setState('speaking'); await w.settle(300);
  assert.strictEqual(p.getInfo().clip, 'idle-up', 'a clip that changes the pose is not cut short');
  w.front(p).end(); await w.settle(100);
  assert.strictEqual(p.getInfo().clip, 'idle-back'); assert.strictEqual(p.getInfo().pose, 'A');
  w.front(p).currentTime = 0; w.front(p).end(); await w.settle(100);
  assert.strictEqual(p.getInfo().clip, 'speaking-1');
  const L = p.getInfo().log; assert.ok(L.every(e => e.kind !== 'fallback')); p.destroy();
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
  assert.ok(!w.ctxCalls.some(c => c[0] === 'drawImage'), 'no beak patch over the held still'); p.destroy();
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
test('edges: the video stage is masked 9 percent on all four edges into the background (both directions, intersected)', async () => {
  const { w, p } = await started(); const stage = w.container.children[0].children[0];
  const m = stage.style.maskImage;
  assert.match(m, /to right, transparent 0%, #000 9%, #000 91%, transparent 100%/); assert.match(m, /to bottom, transparent 0%, #000 9%, #000 91%, transparent 100%/);
  assert.strictEqual(stage.style.maskComposite, 'intersect'); assert.strictEqual(stage.style.webkitMaskImage, m); assert.strictEqual(stage.style.webkitMaskComposite, 'source-in');
  assert.strictEqual(stage.children.length, 2, 'both videos are in the masked stage'); assert.ok(stage.children.every(c => c.tag === 'video'));
  assert.ok(!w.container.children[0].children.slice(1).some(c => c.style.maskImage), 'the beak canvas is not masked');
  assert.strictEqual(p.getInfo().stage.feather, 0.09); p.destroy();
});
test('landscape: geometry is the plain fit (whole picture, letterboxed in a wider view); the stage is the picture', async () => {
  const { p } = await started({}, { w: 800, h: 450 }); let s = p.getInfo().stage;
  near(s.x, 0); near(s.y, 0); near(s.w, 800); near(s.h, 450); near(s.picture.scale, 0.625); assert.strictEqual(s.portrait, false); p.destroy();
  const r = await started({}, { w: 1000, h: 450 }); s = r.p.getInfo().stage;
  near(s.picture.scale, 0.625); near(s.x, 100); near(s.w, 800); near(s.h, 450); r.p.destroy();
});
test('portrait: the central 50 percent of the width at full height is fitted, the empty sides are cropped; video and beak share one transform', async () => {
  const { w, p } = await started({}, { w: 390, h: 800 }); const s = p.getInfo().stage;
  const k = 390 / 640;   // width-limited: 640 safe px fill the 390 view
  assert.strictEqual(s.portrait, true); near(s.picture.scale, k); near(s.picture.w, 1280 * k); near(s.picture.x, -(1280 * k - 390) / 2);
  near(s.x, 0); near(s.w, 390, 'the stage is the visible part: cut to the view'); near(s.h, 720 * k); near(s.y, (800 - 720 * k) / 2); near(s.picture.y, s.y);
  const sl = w.videos[0].style; assert.strictEqual(sl.width, Math.round(1280 * k * 100) / 100 + 'px'); assert.strictEqual(sl.left, Math.round(-(1280 * k - 390) / 2 * 100) / 100 + 'px'); assert.strictEqual(sl.top, '0px');
  // the safe area (x 320..960) is exactly the view width: its left/right edges land on the stage edges
  near(s.picture.x + 320 * k, 0); near(s.picture.x + 960 * k, 390);
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
  let s = p.getInfo().stage; assert.strictEqual(s.portrait, true); near(s.picture.scale, 400 / 640); near(s.w, 400); near(parseFloat(w.videos[0].style.width), 1280 * 400 / 640);
  w.container.clientWidth = 800; w.container.clientHeight = 450; fire(); s = p.getInfo().stage; assert.strictEqual(s.portrait, false); near(s.picture.scale, 0.625); near(s.w, 800);
  p.destroy();
  const r = await started({ portraitSafe: 0.7 }, { w: 390, h: 800 }); near(r.p.getInfo().stage.picture.scale, 390 / (1280 * 0.7)); r.p.destroy();
  const g = await started({ portraitSafe: 5 }, { w: 390, h: 800 }); near(g.p.getInfo().stage.picture.scale, 390 / 640, 'out of range falls back to 0.5'); g.p.destroy();
  const sq = await started({}, { w: 600, h: 600 }); assert.strictEqual(sq.p.getInfo().stage.portrait, false, 'a square view is not portrait'); near(sq.p.getInfo().stage.picture.scale, 600 / 1280); sq.p.destroy();
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
