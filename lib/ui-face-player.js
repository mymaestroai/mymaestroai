'use strict';
/**
 * ui-face-player.js — the Character call display: an illustrated character (a pack of short video clips, pack format v3)
 * played with a live-drawn beak, driven by the call states. Same small interface as the Orb (lib/ui-voice-orb.js), so the
 * call code drives either one. Browser-safe plain JS (also loads with require() for tests); nothing runs at load time;
 * CSP-safe (external file, DOM built with createElement, styles only through CSSOM property writes, no eval, no inline
 * markup); the pack files are data (never executed); every request goes to /api/faces/<encoded pack id>/<known file>.
 *
 *   createFacePlayer(container, options) -> player          (returned at once; `player.ready` is the promise of readiness)
 *     options.packId          the installed pack id (the server's slug: lower-case letters, digits, hyphens, 1 to 40); anything else makes `ready` reject
 *     options.manifest        an already fetched manifest object (skips the manifest request)
 *     options.fetch           fetch function (default the page's); called as fetch(url, { credentials: 'same-origin' })
 *     options.fit             'contain' (default) | 'cover'
 *     options.label           accessible name of the view (default 'Animated character')
 *     options.reducedMotion   true/false to force; undefined follows prefers-reduced-motion live
 *     options.seed / random   deterministic random source (number seed, or a function returning [0,1))
 *     options.warmLimit/warmBytes/warmConcurrency   bounds of the low-priority background cache (default 300 clips / 100 MiB / at most 2 at a time)
 *     options.dprCap          device pixel ratio cap (default 2)
 *     options.portraitSafe    share of the picture width kept in a portrait stage (default 0.5, clamped 0.3..1)
 *     options.fallbackBackground   colour while neither the manifest nor the first frame gives one (default '#1c1c1c')
 *     injection (tests): window, document, now, raf, caf, setTimeout, clearTimeout, ResizeObserver
 *   The player is not a thenable: `await createFacePlayer(...)` returns at once and does NOT wait; await `player.ready`. It resolves
 *   with the player once the manifest, all the beak patches (the five speaking shapes and the smile) and a first speaking track
 *   are in (never the whole pack) and rejects when the pack is unusable, e.g. a required beak patch or every first track failed.
 *
 *   player.setState('idle'|'listening'|'thinking'|'speaking')   unknown name: ignored (false)
 *   player.setLevel(v)        0..1 voice level, used for the beak only while no analyser is attached and no device speech runs
 *   player.setMicLevel(v)     accepted and ignored (the character does not follow the microphone)
 *   player.setAnalyser(a|null)   AnalyserNode of the reply audio (fftSize 2048, smoothing 0 expected); null closes the beak at once
 *   player.react(mood)        delighted|laughing|sympathetic|surprised|proud|curious|encouraging|hello|goodbye or a reaction clip name;
 *                             true when a clip exists (clip mood field first, then the clip name "reaction-<mood>[-n]")
 *   player.speechEvent(kind)  device speech without an analyser: 'start' | 'boundary' | 'end' | 'pause' | 'resume' | 'cancel'
 *   player.setReducedMotion(b|null)   player.getInfo()   player.destroy()
 *
 * The beak maths (RMS of 20 ms, fast/valley/peak trackers, thresholds 0.18/0.40/0.78, 80 ms hold, silence closing, 'oo' below a
 * 750 Hz centroid) is the demo's, unchanged. Clip choice follows PACK-FORMAT.md; pose compatibility is never relaxed.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.FacePlayer = api; root.createFacePlayer = api.createFacePlayer; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const STATES = ['idle', 'listening', 'thinking', 'speaking'];
  const CLIP_STATES = ['idle', 'listening', 'thinking', 'speaking', 'reaction'];
  const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;                      // clip and shape names (the server's rule: no dots)
  const PACK_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;                // the server's pack slug: lower case, at most 40
  const SHAPES5 = ['closed', 'slight', 'half', 'wide', 'oo'];
  const inRange = (v, lo, hi) => typeof v === 'number' && isFinite(v) && v >= lo && v <= hi;
  const WARM_LIMIT = 300, WARM_BYTES = 100 * 1024 * 1024;
  const FADE_MS = 250, FADE_GUARD_MS = 260, RARE_GAP_MS = 180000, END_WAIT_S = 0.6, RECENT = 12;
  const MASTER = { w: 1280, h: 720, frames: [[646, 350, 1, 0, 1]] };
  const FEATHER = 0.09;          // every video edge fades into the background over this share of the stage (8 to 10 percent)
  const PORTRAIT_SAFE = 0.5;     // portrait: the central half of the width (full height) is what must fit the stage
  const STILL_WAIT_MS = 4000, COVER_MAX_MS = 2000, COVER_TRIES = 5;   // still-picture wait; interval of the "play again" nudge while the still is held, and how many (then it just holds)

  function faceRng(seed) {   // mulberry32
    let a = (Number(seed) || 0) >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ── manifest ──
  function faceNormalizeManifest(m) {
    if (!m || typeof m !== 'object' || !Array.isArray(m.clips)) return null;
    const seen = new Set(), clips = [];
    for (const c of m.clips) {
      if (!c || typeof c !== 'object' || !NAME_RE.test(String(c.name)) || CLIP_STATES.indexOf(c.state) < 0 || seen.has(c.name)) continue;
      seen.add(c.name);
      const o = Object.assign({}, c);
      o.weight = Number(c.weight) > 0 && Number(c.weight) <= 1000 ? Number(c.weight) : 1;
      o.dur = Number(c.dur) > 0 && Number(c.dur) <= 600 ? Number(c.dur) : 5;
      o.track = !!c.track || c.state === 'speaking'; o.rare = !!c.rare;   // a speaking clip always carries a beak track
      o.startsFrom = c.startsFrom === 'B' ? 'B' : 'A';
      o.endsOn = c.endsOn === 'B' ? 'B' : 'A';
      o.family = typeof c.family === 'string' ? c.family : '';
      o.beakEnds = c.beakEnds === 'closed' || c.beakEnds === 'smile' ? c.beakEnds : (o.track ? 'closed' : 'smile');
      o.mood = typeof c.mood === 'string' ? c.mood.toLowerCase() : '';
      clips.push(o);
    }
    let beak = null;
    const b = m.beak;
    const nums = (a, n) => Array.isArray(a) && a.length >= n && a.slice(0, n).every(v => inRange(v, -8192, 8192));
    if (b && typeof b === 'object' && nums(b.roi, 4) && b.roi[2] > 0 && b.roi[3] > 0 && b.roi[2] <= 1024 && b.roi[3] <= 1024 && nums(b.centre, 2)) {
      const shapes = (Array.isArray(b.shapes) ? b.shapes : []).filter(s => typeof s === 'string' && NAME_RE.test(s)).slice(0, 32);
      if (shapes.indexOf('closed') >= 0) {
        const smile = NAME_RE.test(String(b.smile || 'smile')) ? String(b.smile || 'smile') : 'smile';
        const bf = Number.isInteger(b.blendFrames) && b.blendFrames >= 0 && b.blendFrames <= 10 ? b.blendFrames : 3;
        beak = { roi: b.roi.slice(0, 4), centre: b.centre.slice(0, 2), shapes, smile, blendFrames: bf };
      }
    }
    const bg = typeof m.background === 'string' && (/^#[0-9a-f]{3,8}$/i.test(m.background) || /^rgba?\([\d\s.,%]+\)$/i.test(m.background)) ? m.background : '';
    return { clips, beak, background: bg };
  }
  function faceNormalizeTrack(t) {
    if (!t || typeof t !== 'object' || !Array.isArray(t.frames) || !t.frames.length || t.frames.length > 20000) return null;
    const frames = [];
    for (const f of t.frames) {
      if (!Array.isArray(f) || f.length < 4 || !inRange(f[0], -20000, 20000) || !inRange(f[1], -20000, 20000) || !(inRange(f[2], 0, 50) && f[2] > 0) || !inRange(f[3], -720, 720)) return null;
      frames.push([f[0], f[1], f[2], f[3]]);
    }
    const w = inRange(Number(t.w), 1, 8192) ? Number(t.w) : 1280, h = inRange(Number(t.h), 1, 8192) ? Number(t.h) : 720, fps = inRange(Number(t.fps), 1, 120) ? Number(t.fps) : 24;
    return { w, h, fps, frames };
  }

  // ── clip selection (pure, deterministic with a seeded random source) ──
  // Pose A is the master pose (baton up), B the resting pose. A clip only ever follows a clip that ended on its startsFrom pose.
  function faceCreateSelector(clips, o) {
    o = o || {};
    const rng = o.random || Math.random, nowFn = o.now || (() => Date.now()), ok = o.ok || (() => true);
    const S = { pose: 'A', poseSince: nowFn(), poseHold: 30000 + rng() * 60000, current: null, recent: [], hist: {}, lastRareAt: -Infinity };

    function choose(pool, hkey, st) {
      if (!pool.length) return null;
      const now = nowFn(), h = S.hist[hkey] || [];
      const keep = Math.floor(pool.length * 0.7), kept = keep > 0 ? h.slice(-keep) : [];
      const rareOk = (st === 'idle' || st === 'listening') && now - S.lastRareAt >= RARE_GAP_MS;
      const cur = S.current;
      // Exhaustion relaxes in this order: the rare cooldown, the global 12, the 70 percent memory, the same-family rule.
      const tiers = [[1, 1, 1, 1], [0, 1, 1, 1], [0, 0, 1, 1], [0, 0, 0, 1], [0, 0, 0, 0]];
      for (const [fRare, fGlob, fHist, fFam] of tiers) {
        const cands = pool.filter(c =>
          !(fRare && c.rare && !rareOk) && !(fGlob && S.recent.indexOf(c.name) >= 0) && !(fHist && kept.indexOf(c.name) >= 0) &&
          !(fFam && cur && c.family && c.family === cur.family) && !(pool.length > 1 && cur && c.name === cur.name));
        if (!cands.length) continue;
        const plain = cands.filter(c => !c.rare), rare = cands.filter(c => c.rare);
        let set = plain.length ? plain : rare;
        if (rare.length && plain.length && rareOk && rng() < 0.05) set = rare;
        let total = 0; for (const c of set) total += c.weight;
        let x = rng() * total, pick = set[0];
        for (const c of set) { x -= c.weight; if (x <= 0) { pick = c; break; } }
        return { clip: pick, hkey };
      }
      return null;
    }
    const good = () => clips.filter(ok);
    // the short way back: clips that leave the current pose; the shorter half of them, weighted choice inside it
    function transition() {
      const t = good().filter(c => c.startsFrom === S.pose && c.endsOn !== S.pose).sort((a, b) => a.dur - b.dur);
      if (!t.length) return null;
      const r = choose(t.slice(0, Math.ceil(t.length / 2)), 'pose', 'pose');
      return r ? { clip: r.clip, hkey: r.hkey, kind: 'transition' } : null;
    }
    function statePool(st) { return good().filter(c => c.state === st && c.startsFrom === S.pose && c.endsOn === S.pose); }
    function pickState(st, allowPoseMoves) {
      const now = nowFn();
      if (allowPoseMoves && st === 'idle') {
        if (S.pose === 'A' && now - S.poseSince > S.poseHold && rng() < 0.5) {
          const r = choose(good().filter(c => c.startsFrom === 'A' && c.endsOn === 'B'), 'pose', 'pose');
          if (r) return { clip: r.clip, hkey: r.hkey, kind: 'settle' };
        }
        if (S.pose === 'B' && now - S.poseSince > S.poseHold) { const t = transition(); if (t) return t; }
      }
      const pool = statePool(st);
      if (pool.length) { const r = choose(pool, st + (S.pose === 'B' ? '-B' : ''), st); if (r) return { clip: r.clip, hkey: r.hkey, kind: 'state' }; }
      if (good().some(c => c.state === st)) { const t = transition(); if (t) return t; }   // the state exists, only from the other pose
      return null;
    }
    // pick(state, { react: [clips] }) -> { clip, hkey, kind: state|reaction|transition|settle|fallback } | null; no bookkeeping until commit()
    function pick(st, opt) {
      if (opt && opt.react && opt.react.length) {
        const pool = opt.react.filter(c => ok(c) && c.startsFrom === S.pose);
        if (pool.length) { const r = choose(pool, 'reaction', 'reaction'); if (r) return { clip: r.clip, hkey: r.hkey, kind: 'reaction' }; }
        else { const t = transition(); if (t) return t; }
      }
      let r = pickState(st, true);
      if (!r && st !== 'idle') { r = pickState('idle', false); if (r) r.kind = r.kind === 'state' ? 'fallback' : r.kind; }
      return r;
    }
    function commit(sel) {
      const c = sel.clip, now = nowFn();
      S.recent.push(c.name); if (S.recent.length > RECENT) S.recent.shift();
      const h = S.hist[sel.hkey] || (S.hist[sel.hkey] = []);
      h.push(c.name); if (h.length > 200) h.shift();
      if (c.rare) S.lastRareAt = now;
      if (c.endsOn !== S.pose) { S.pose = c.endsOn; S.poseSince = now; S.poseHold = S.pose === 'A' ? 30000 + rng() * 60000 : 20000 + rng() * 40000; }
      S.current = c;
    }
    return { pick, commit, state: S };
  }

  // ── the beak: shape from the voice (the demo's maths, unchanged) ──
  function faceCreateBeak() {
    const env = { fast: 0, valley: 0, peak: 0.05, cur: 'closed', since: 0, last: 0 };
    let tbuf = null, fbuf = null, tbyte = null, fbyte = null, bufFor = null;   // all buffers made once per analyser, never per frame
    function hold(want, r, now) {
      if (want !== env.cur && now - env.since < 80 && !(want === 'closed' && r < 0.005 && now - env.since >= 70)) want = env.cur;
      if (want !== env.cur) { env.cur = want; env.since = now; }
      return env.cur;
    }
    const byO = (o, cent) => (o < 0.18 ? 'closed' : o < 0.40 ? 'slight' : o < 0.78 ? ((cent && cent < 750) ? 'oo' : 'half') : 'wide');
    return {
      env,
      close() { env.cur = 'closed'; env.fast = env.valley = 0; env.last = 0; return 'closed'; },
      fromAnalyser(analyser, now, sampleRate) {
        const fftN = analyser.fftSize || 2048;
        if (bufFor !== analyser || !tbuf || tbuf.length !== fftN) {
          bufFor = analyser;
          tbuf = new Float32Array(fftN); fbuf = new Float32Array(analyser.frequencyBinCount || fftN / 2); tbyte = fbyte = null;
        }
        const dt = Math.min(0.1, Math.max(0.001, (now - (env.last || now)) / 1000)); env.last = now;
        const hasFloat = typeof analyser.getFloatTimeDomainData === 'function';
        if (hasFloat) analyser.getFloatTimeDomainData(tbuf);
        else { if (!tbyte) tbyte = new Uint8Array(tbuf.length); analyser.getByteTimeDomainData(tbyte); for (let i = 0; i < tbyte.length; i++) tbuf[i] = (tbyte[i] - 128) / 128; }
        const n = Math.max(1, Math.min(tbuf.length, Math.floor(0.02 * sampleRate)));
        let s = 0;
        for (let i = tbuf.length - n; i < tbuf.length; i++) s += tbuf[i] * tbuf[i];
        const r = Math.sqrt(s / n);
        const k = Math.exp(-dt / 0.05);
        env.fast = r > env.fast ? r : env.fast * k + r * (1 - k);
        env.valley = env.fast < env.valley ? env.fast : env.valley + (env.fast - env.valley) * (1 - Math.exp(-dt / 0.25));
        env.peak = Math.max(env.fast, env.peak * Math.exp(-dt / 2.0), 0.02);
        const o = r < 0.005 ? 0 : (env.fast - env.valley) / Math.max(env.peak - env.valley, 0.02);
        let cent = 0;
        if (r > 0.005) {
          if (typeof analyser.getFloatFrequencyData === 'function') analyser.getFloatFrequencyData(fbuf);
          else {   // bytes 0..255 span the analyser's own minDecibels..maxDecibels (default -100..-30)
            if (!fbyte) fbyte = new Uint8Array(fbuf.length);
            analyser.getByteFrequencyData(fbyte);
            const lo = isFinite(analyser.minDecibels) ? analyser.minDecibels : -100, hi = isFinite(analyser.maxDecibels) && analyser.maxDecibels > lo ? analyser.maxDecibels : lo + 70;
            for (let i = 0; i < fbyte.length; i++) fbuf[i] = lo + (fbyte[i] / 255) * (hi - lo);
          }
          const hz = sampleRate / (analyser.fftSize || 2048); let num = 0, den = 0;
          for (let b = Math.ceil(80 / hz); b < Math.min(fbuf.length, 4000 / hz); b++) { const m = Math.pow(10, fbuf[b] / 20); num += m * b * hz; den += m; }
          cent = den ? num / den : 0;
        }
        return hold(byO(o, cent), r, now);
      },
      // a plain openness 0..1 (the level fallback, device speech): never 'oo', same hold rule
      fromOpenness(o, now) {
        env.last = now;
        return hold(byO(Math.max(0, Math.min(1, o)), 0), o < 0.02 ? 0 : 1, now);
      },
    };
  }

  function faceUrls(packId) {
    const base = '/api/faces/' + encodeURIComponent(packId) + '/';
    const enc = encodeURIComponent;
    return {
      manifest: () => base + 'manifest.json',
      clip: n => base + 'web/' + enc(n) + '.mp4',
      track: n => base + 'tracks/' + enc(n) + '.json',
      patch: n => base + 'beak/' + enc(n) + '.png',
    };
  }

  function createFacePlayer(container, options) {
    const opts = options || {};
    const win = opts.window || (typeof window !== 'undefined' ? window : null);
    const doc = opts.document || (win && win.document) || (typeof document !== 'undefined' ? document : null);
    const nowFn = opts.now || (() => (win && win.performance ? win.performance.now() : Date.now()));
    const setT = opts.setTimeout || ((fn, ms) => setTimeout(fn, ms)), clearT = opts.clearTimeout || (id => clearTimeout(id));
    const rafFn = opts.raf || (win && win.requestAnimationFrame ? cb => win.requestAnimationFrame(cb) : cb => setTimeout(() => cb(nowFn()), 16));
    const cafFn = opts.caf || (win && win.cancelAnimationFrame ? id => win.cancelAnimationFrame(id) : id => clearTimeout(id));
    const fetchFn = opts.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    const rng = typeof opts.random === 'function' ? opts.random : (opts.seed != null ? faceRng(opts.seed) : Math.random);
    const dprCap = Number(opts.dprCap) > 0 ? Number(opts.dprCap) : 2;
    const warmLimit = isFinite(Number(opts.warmLimit)) && opts.warmLimit != null ? Math.max(0, Math.min(1000, Math.floor(Number(opts.warmLimit)))) : WARM_LIMIT;
    const warmBytes = Number(opts.warmBytes) > 0 && isFinite(Number(opts.warmBytes)) ? Number(opts.warmBytes) : WARM_BYTES;
    const warmConc = Number(opts.warmConcurrency) >= 1 ? Math.min(2, Math.floor(Number(opts.warmConcurrency))) : 2;   // never more than two at a time

    let dead = false, M = null, urls = null, ready = false, failed = null;
    let state = 'idle', pending = null, earlyReact = null;
    let gen = 0, startToken = 0, starting = 0, endedFor = -1, busyUntil = 0, planned = null, rareFails = 0;
    let front = 0, V = { clip: null, frame: 0, blendFrom: null }, lastShape = 'closed', beakShape = 'closed';
    let pausedHidden = false, reducedSys = false, reducedForce = typeof opts.reducedMotion === 'boolean' ? opts.reducedMotion : null;
    let analyser = null, gated = false, extLevel = 0;
    const synth = { on: false, since: 0, kick: 0 };
    const bad = new Set(), tracks = {}, trackLoading = {}, patches = {};
    const log = [];
    let selector = null, selectorOk = null;
    const beak = faceCreateBeak();
    let watchCancel = null, watchdog = null, retryTimer = null, fadeTimer = null, planTimer = null, loadTimer = null, redrawRaf = null, reducedRaf = null;
    let abort = null, bgSampled = false, bgGiven = false, stillClip = null, stillReady = false;
    let stillUp = false, coverUp = false, coverGen = 0, coverTries = 0, coverTimer = null, stillCancel = null, stage = null, stageRect = null;
    const safeFrac = Number(opts.portraitSafe) >= 0.3 && Number(opts.portraitSafe) <= 1 ? Number(opts.portraitSafe) : PORTRAIT_SAFE;
    let cw = 0, ch = 0, dpr = 1, ro = null, onVis = null, onWinResize = null, mql = null, mqlHandler = null, gestureHandler = null;
    const patchWaits = new Set();   // image loads in flight: each one is settled when the player is destroyed

    // ── DOM (createElement only; styles through the CSSOM) ──
    const css = (el, o) => { for (const k in o) el.style[k] = o[k]; };
    let rootEl = null, canvas = null, ctx = null;
    const slots = [];
    function mkVideo(i) {
      const v = doc.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto';
      if (v.setAttribute) { v.setAttribute('muted', ''); v.setAttribute('playsinline', ''); v.setAttribute('aria-hidden', 'true'); v.setAttribute('disablepictureinpicture', ''); }
      css(v, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', objectFit: opts.fit === 'cover' ? 'cover' : 'contain', opacity: i === 0 ? '1' : '0', zIndex: i === 0 ? '2' : '1', pointerEvents: 'none' });
      const slot = { video: v, clip: null, url: '', gen: 0, ready: false, failed: false, waiters: [], onLoaded: null, onError: null, onEnded: null, onPlaying: null };
      // a late event of an earlier resource must not decide for the one loading now: it needs the slot's own url (currentSrc when the
      // browser knows it) and, for loadeddata, real data (readyState >= 2; a freshly assigned src starts at 0)
      const mine = () => { const cs = v.currentSrc; return !!slot.url && (!cs || cs === slot.url || (cs.length > slot.url.length && cs.slice(-slot.url.length) === slot.url)); };
      slot.onLoaded = () => { if (dead || !mine() || (typeof v.readyState === 'number' && v.readyState < 2)) return; slot.ready = true; slot.failed = false; flush(slot); };
      slot.onError = () => {
        if (dead || !mine()) return;
        slot.failed = true; flush(slot);
        if (coverUp && slots[front] === slot && slot.gen === coverGen && starting !== startToken) coverFail(slot);   // the clip under the held still broke: set aside, another is tried, the still stays
      };
      slot.onEnded = () => { if (!dead && slots[front] === slot) clipEnded(); };
      // the still goes only when the clip under it is really playing: its own, current resource (a late event of an earlier one does not count)
      slot.onPlaying = () => { if (!dead && coverUp && slots[front] === slot && slot.gen === coverGen && mine() && !v.paused) uncover(); };
      v.addEventListener('loadeddata', slot.onLoaded);
      v.addEventListener('error', slot.onError);
      v.addEventListener('ended', slot.onEnded);
      v.addEventListener('playing', slot.onPlaying);
      return slot;
    }
    function setSource(slot, name) {   // one place that points a slot's video at a clip: a new load generation, nothing of the old one left
      slot.gen++; slot.clip = name; slot.url = urls.clip(name); slot.ready = false; slot.failed = false; slot.waiters = [];
      const v = slot.video;
      try { v.pause && v.pause(); } catch (e) { /* ignore */ }
      v.src = slot.url;
      if (v.load) { try { v.load(); } catch (e) { /* ignore */ } }
    }
    function flush(slot) { const w = slot.waiters; slot.waiters = []; w.forEach(fn => { try { fn(); } catch (e) { /* guarded callbacks */ } }); }

    // ── helpers ──
    const live = new Set();   // the timers pending right now (fired or cancelled ones leave it), so destroy() can cancel them all
    const timer = (fn, ms) => { const id = setT(() => { live.delete(id); if (!dead) fn(); }, ms); live.add(id); return id; };
    const untimer = id => { if (id != null) { live.delete(id); clearT(id); } };
    const reduced = () => (reducedForce !== null ? reducedForce : reducedSys);
    function measure() {
      if (!rootEl) return;
      cw = (container.clientWidth || (container.getBoundingClientRect && container.getBoundingClientRect().width) || cw || 640);
      ch = (container.clientHeight || (container.getBoundingClientRect && container.getBoundingClientRect().height) || ch || 360);
      dpr = Math.min(dprCap, (win && win.devicePixelRatio) || 1);
      const W = Math.max(1, Math.round(cw * dpr)), H = Math.max(1, Math.round(ch * dpr));
      if (canvas.width !== W) canvas.width = W;      // only when the size really changed, never per frame
      if (canvas.height !== H) canvas.height = H;
      applyStage();
    }
    // The stage is the visible part of the picture (the video rectangle cut to the view); both videos sit in it at the picture's own
    // position and its four edges are feathered into the background. The beak canvas uses the same layout(), so it stays aligned.
    function applyStage() {
      if (!stage || !(cw > 0) || !(ch > 0)) return;
      const L = layout(MASTER), w = MASTER.w * L.s, h = MASTER.h * L.s;
      const x0 = Math.max(0, L.ox), y0 = Math.max(0, L.oy), x1 = Math.min(cw, L.ox + w), y1 = Math.min(ch, L.oy + h);
      const px = n => (Math.round(n * 100) / 100) + 'px';
      css(stage, { left: px(x0), top: px(y0), width: px(Math.max(0, x1 - x0)), height: px(Math.max(0, y1 - y0)) });
      slots.forEach(sl => css(sl.video, { left: px(L.ox - x0), top: px(L.oy - y0), width: px(w), height: px(h) }));
      stageRect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0, picture: { x: L.ox, y: L.oy, w, h, scale: L.s }, portrait: ch > cw, feather: FEATHER };
    }
    function layout(t) {
      // landscape (and square): the whole picture fits (or covers) the view. Portrait: the central safeFrac of the width, at full
      // height, is fitted to the view, so the empty sides are cropped; the rest of the picture is simply outside the view.
      const portrait = ch > cw, sw = portrait ? t.w * safeFrac : t.w;
      const sx = cw / sw, sy = ch / t.h, s = opts.fit === 'cover' && !portrait ? Math.max(sx, sy) : Math.min(sx, sy);
      return { s, ox: (cw - t.w * s) / 2, oy: (ch - t.h * s) / 2 };
    }
    function drawPatch(im, f, t, alpha) {
      if (!im || im.complete === false || alpha <= 0 || !M.beak) return;
      const L = layout(t), k = dpr * L.s, x = f[0], y = f[1], sc = f[2], ang = f[3], rx = M.beak.roi[0], ry = M.beak.roi[1], cx = M.beak.centre[0], cy = M.beak.centre[1];
      ctx.save(); ctx.globalAlpha = alpha;
      ctx.setTransform(k, 0, 0, k, dpr * L.ox, dpr * L.oy);
      ctx.translate(x, y); ctx.rotate(-ang * Math.PI / 180); ctx.scale(sc, sc);
      ctx.drawImage(im, rx - cx, ry - cy);
      ctx.restore();
    }
    function draw() {
      if (!ctx || dead) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!M || !M.beak || coverUp) return;   // no beak over the held still: the clip behind it is not showing yet
      if (reducedActive()) { if (state === 'speaking' && stillReady) drawPatch(patches[beakShape], MASTER.frames[0], MASTER, 1); return; }   // only over the canonical A still
      const clip = V.clip; if (!clip) return;
      const N = M.beak.blendFrames, fi = V.frame;
      if (clip.track) {
        const t = tracks[clip.name]; if (!t) return;
        const f = t.frames[Math.min(t.frames.length - 1, Math.max(0, fi))];
        const a = (V.blendFrom === 'smile' && fi < N) ? 1 - fi / N : 0;      // the clip's own smile fading into the drawn beak
        drawPatch(patches[beakShape], f, t, 1 - a);
        drawPatch(patches[M.beak.smile], f, t, a);
        lastShape = beakShape;
      } else if (V.blendFrom === 'closed' && fi < N) {
        drawPatch(patches[lastShape], MASTER.frames[0], MASTER, 1 - fi / N);   // the drawn beak fading into the clip's smile
      }
    }
    const reducedActive = () => reduced();

    // ── the beak source: analyser > device speech > level ──
    function sampleRate() { return (analyser && analyser.context && analyser.context.sampleRate) || opts.sampleRate || 48000; }
    function beakNow(now) {
      if (state !== 'speaking') { beak.close(); return 'closed'; }
      if (analyser) return gated ? beak.close() : beak.fromAnalyser(analyser, now, sampleRate());
      if (synth.on) {
        const t = (now - synth.since) / 1000;
        synth.kick = Math.max(0, synth.kick - 0.06);            // a word boundary opens the beak a little more, then relaxes
        const rhythm = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI * 3.4) * (0.6 + 0.4 * Math.sin(t * 2 * Math.PI * 0.7));
        return beak.fromOpenness(Math.min(0.74, 0.12 + 0.42 * rhythm + synth.kick), now);
      }
      if (extLevel > 0.02) return beak.fromOpenness(extLevel, now);
      return beak.close();
    }
    function closeBeakNow() { beakShape = beak.close(); redraw(); }
    function redraw() { if (dead) return; draw(); }

    // ── frames: requestVideoFrameCallback, else rAF; every callback is tied to its clip's generation ──
    function watch(video, clip, g) {
      cancelWatch();
      const step = (now, mediaTime) => {
        if (dead || g !== gen || slots[front].video !== video) return false;
        const t = tracks[clip.name];
        V.frame = Math.round(mediaTime * ((t && t.fps) || 24));
        beakShape = beakNow(now); draw(); return true;
      };
      if (typeof video.requestVideoFrameCallback === 'function') {
        let id = null;
        const cb = (now, meta) => { id = null; if (step(now, meta && meta.mediaTime != null ? meta.mediaTime : video.currentTime)) id = video.requestVideoFrameCallback(cb); };
        id = video.requestVideoFrameCallback(cb);
        watchCancel = () => { if (id != null && video.cancelVideoFrameCallback) { try { video.cancelVideoFrameCallback(id); } catch (e) { /* gone */ } } id = null; };
      } else {
        let id = null, stop = false;
        const tick = now => { id = null; if (!stop && step(now, video.currentTime)) id = rafFn(tick); };
        id = rafFn(tick);
        watchCancel = () => { stop = true; if (id != null) cafFn(id); id = null; };
      }
    }
    function cancelWatch() { if (watchCancel) { watchCancel(); watchCancel = null; } }

    // ── loading ──
    function loadRec(clip) {
      const slot = coverUp ? slots[front] : slots[1 - front];   // while the still is held it owns the other slot: loads go under it, never into it
      if (slot.clip === clip.name && !slot.failed) return slot;
      setSource(slot, clip.name);
      return slot;
    }
    function jget(url) {
      if (!fetchFn) return Promise.reject(new Error('no fetch'));
      return Promise.resolve(fetchFn(url, { credentials: 'same-origin', signal: abort ? abort.signal : undefined })).then(r => {
        if (!r || r.ok === false) throw new Error('HTTP ' + (r && r.status));
        return r.json();
      });
    }
    function loadTrack(name) {
      if (tracks[name]) return Promise.resolve(true);
      if (trackLoading[name]) return trackLoading[name];
      const p = jget(urls.track(name)).then(j => {
        const t = faceNormalizeTrack(j);
        if (!t) throw new Error('bad track');
        if (dead) return false;
        tracks[name] = t; onTracks(); return true;
      }).catch(() => { delete trackLoading[name]; return false; });
      trackLoading[name] = p;
      return p;
    }
    function loadPatch(n) {   // always settles: loaded (true), failed (false) or cancelled by destroy() (false); handlers never outlive it
      return new Promise(res => {
        if (dead) { res(false); return; }
        const im = doc.createElement('img');
        const w = { done: false };
        const finish = ok => {
          if (w.done) return; w.done = true; patchWaits.delete(w);
          im.onload = null; im.onerror = null;
          if (ok && !dead) patches[n] = im; else if (patches[n] === im) delete patches[n];
          res(ok && !dead);
        };
        w.cancel = () => finish(false);
        patchWaits.add(w);
        im.onload = () => finish(im.naturalWidth !== 0);
        im.onerror = () => finish(false);
        im.src = urls.patch(n);
      });
    }
    function onTracks() {   // a speaking track arrived: a waiting speaking state can now be shown
      if (dead || !ready || state !== 'speaking' || pausedHidden || reducedActive()) return;
      const c = selector.state.current;
      if (!c || (c.state !== 'speaking' && cuttable(c))) evaluate();
    }

    // ── choosing and starting ──
    const isHelloName = m => m === 'hello' || /^reaction-hello(-|$)/.test(m);
    const isHello = c => !!c && c.state === 'reaction' && (c.mood === 'hello' || /^reaction-hello(-|$)/.test(c.name));
    const poseChanging = c => c.startsFrom !== c.endsOn;
    function resolveReaction(name) {
      const m = String(name == null ? '' : name).toLowerCase().trim();
      if (!m || !M) return [];
      const rs = M.clips.filter(c => c.state === 'reaction' && !bad.has(c.name));
      let r = rs.filter(c => c.mood === m);
      if (!r.length) r = rs.filter(c => c.name.toLowerCase() === m || c.name.toLowerCase().indexOf('reaction-' + m + '-') === 0 || c.name.toLowerCase() === 'reaction-' + m);
      return r;
    }
    function key() { const c = selector.state.current; return [state, pending ? pending.name : '', selector.state.pose, c ? c.name : ''].join('|'); }
    function decide() {
      let sel = null;
      if (pending) {
        const pool = resolveReaction(pending.name);
        sel = pool.length ? selector.pick(state, { react: pool }) : null;
        if (!sel || (sel.kind !== 'reaction' && sel.kind !== 'transition')) { pending = null; sel = null; }
      }
      return sel || selector.pick(state);
    }
    function next(fade) {
      if (dead || !ready || pausedHidden || reducedActive()) return;
      clearRetry();
      let sel = planned && planned.key === key() ? planned.sel : null;
      planned = null;
      if (!sel) sel = decide();
      if (!sel) { holdLast(); return; }
      begin(sel, fade, 0);
    }
    function holdLast() {   // nothing playable now: the last picture stays; look again soon (bounded, never a tight loop)
      retryTimer = timer(() => { retryTimer = null; if (!dead) next(true); }, 2500);
    }
    function clearRetry() { untimer(retryTimer); retryTimer = null; }
    function begin(sel, fade, depth) {
      const tok = ++startToken; starting = tok;
      const clip = sel.clip;
      if (busyUntil > nowFn()) finishFade();   // a request inside the 250 ms fade ends it now (never waits: hello yields at once)
      const rec = loadRec(clip);
      const fail = () => {
        if (tok !== startToken) return;
        bad.add(clip.name); planned = null;
        if (depth > 6) { holdLast(); return; }
        const s2 = decide();
        if (!s2) { holdLast(); return; }
        begin(s2, fade, depth + 1);
      };
      if (rec.failed) { fail(); return; }
      if (rec.ready) { commit(sel, rec, fade, tok); return; }
      rec.waiters.push(() => { if (tok !== startToken || dead) return; if (rec.failed) fail(); else commit(sel, rec, fade, tok); });
      untimer(loadTimer); loadTimer = timer(() => { loadTimer = null; if (tok === startToken && !rec.ready) fail(); }, 8000);
    }
    function commit(sel, slot, fade, tok) {
      if (tok !== startToken || dead || pausedHidden || reducedActive()) return;
      starting = 0; untimer(loadTimer); loadTimer = null;
      const clip = sel.clip, cur = slots[front], nxt = slot, prevClip = selector.state.current;
      const rehold = coverUp;   // a second start while the first is still held: the still stays, the new clip replaces the one under it
      const hold = stillUp || rehold;   // the first clip: the still stays on top until this video is really playing
      gen++;
      const myGen = gen;
      const rate = (clip.state === 'idle' || clip.state === 'listening') ? 0.95 + rng() * 0.1 : 1;
      try { nxt.video.currentTime = 0; } catch (e) { /* not seekable yet */ }
      nxt.video.playbackRate = rate;
      playVideo(nxt.video);
      untimer(fadeTimer); fadeTimer = null;
      if (hold) {
        const stillSlot = rehold ? slots[1 - front] : cur;
        css(nxt.video, { transition: 'none', opacity: '1', zIndex: '1' });
        css(stillSlot.video, { transition: 'none', opacity: '1', zIndex: '2' });
        coverUp = true; coverGen = nxt.gen; coverTries = 0; armCover();
      } else {
        stillUp = false;
        css(nxt.video, { transition: fade ? 'opacity ' + FADE_MS + 'ms linear' : 'none', opacity: '1', zIndex: '2' });
        css(cur.video, { zIndex: '1' });
        fadeTimer = timer(() => { fadeTimer = null; if (slots[front] !== cur) { try { cur.video.pause(); } catch (e) { /* ignore */ } css(cur.video, { opacity: '0' }); } }, fade ? FADE_GUARD_MS : 30);
      }
      if (!rehold) front = 1 - front;
      selector.commit(sel);
      if (sel.kind === 'reaction' && pending) pending = null;
      busyUntil = nowFn() + (fade ? FADE_GUARD_MS : 30);
      V = { clip, frame: 0, blendFrom: prevClip && prevClip.beakEnds !== clip.beakEnds ? prevClip.beakEnds : null };
      if (V.blendFrom === 'closed' && clip.track) V.blendFrom = null;
      log.push({ t: Math.round(nowFn()), name: clip.name, state: clip.state, kind: sel.kind, pose: selector.state.pose, fade: !!fade });
      if (log.length > 400) log.shift();
      draw();
      watch(nxt.video, clip, myGen);
      untimer(watchdog);
      watchdog = timer(() => { watchdog = null; if (myGen === gen) clipEnded(); }, clip.dur * 1000 / rate + 1500);
      if (!bgGiven && !bgSampled) { bgSampled = true; sampleBackground(nxt.video); }
      untimer(planTimer);
      planTimer = timer(() => { planTimer = null; planAhead(); }, (fade ? FADE_GUARD_MS : 30) + 40);
    }
    function armCover() { untimer(coverTimer); coverTimer = timer(coverCheck, COVER_MAX_MS); }
    function coverCheck() {   // still no playing event: the still is NOT given up. Ask the clip to play again (bounded); events still release it
      coverTimer = null;
      if (!coverUp) return;
      if (++coverTries >= COVER_TRIES) { log.push({ t: Math.round(nowFn()), name: slots[front].clip, kind: 'cover-stalled' }); return; }   // stop polling, keep the still; a late playing event or gesture releases it
      playVideo(slots[front].video); armCover();
    }
    function coverFail(slot) {   // the held first clip errored: set it aside, try another under the same still
      bad.add(slot.clip); planned = null; untimer(watchdog); watchdog = null; untimer(coverTimer); coverTimer = null;
      next(false);
    }
    function uncover() {   // the clip is really playing: it takes the front, the still is hidden and paused
      if (!coverUp) return;
      coverUp = false; stillUp = false; untimer(coverTimer); coverTimer = null;
      untimer(planTimer); planTimer = timer(() => { planTimer = null; planAhead(); }, 70);
      const old = slots[1 - front];
      try { old.video.pause(); } catch (e) { /* ignore */ }
      css(old.video, { opacity: '0', transition: 'none', zIndex: '1' }); css(slots[front].video, { opacity: '1', transition: 'none', zIndex: '2' });
      draw();
    }
    function finishFade() {
      untimer(fadeTimer); fadeTimer = null;
      if (coverUp) { busyUntil = 0; return; } // a state change must not hide the startup still before playing
      const old = slots[1 - front];
      try { old.video.pause(); } catch (e) { /* ignore */ }
      css(old.video, { opacity: '0', transition: 'none' }); css(slots[front].video, { opacity: '1', transition: 'none' });
      busyUntil = 0;
    }
    function playVideo(v) {
      let p; try { p = v.play(); } catch (e) { p = null; }
      if (p && p.catch) p.catch(() => {
        if (dead || gestureHandler || !doc.addEventListener) return;
        gestureHandler = () => { doc.removeEventListener('pointerdown', gestureHandler); doc.removeEventListener('keydown', gestureHandler); gestureHandler = null; if (!dead && !pausedHidden) { const s = slots[front].video; try { const q = s.play(); if (q && q.catch) q.catch(() => {}); } catch (e) { /* ignore */ } } };
        doc.addEventListener('pointerdown', gestureHandler); doc.addEventListener('keydown', gestureHandler);
      });
    }
    function planAhead() {   // preload the clip that most likely comes next into the hidden video
      if (dead || !ready || pausedHidden || reducedActive() || starting === startToken || coverUp) return;   // never into the slot the held still sits in
      const sel = decide(); planned = sel ? { sel, key: key() } : null;
      if (sel) { const r = loadRec(sel.clip); if (r.failed) { bad.add(sel.clip.name); planned = null; } }
    }
    function clipEnded() {
      if (dead || endedFor === gen) return;
      endedFor = gen;
      untimer(watchdog); watchdog = null;
      next(false);
    }
    function invalidatePlan() { planned = null; }
    function leftOf(slot, clip) { const v = slot.video; return (isFinite(v.duration) && v.duration > 0 ? v.duration : clip.dur) - (v.currentTime || 0); }
    // may the playing clip be cut short for a new request? Pose changes and reactions always finish; hello yields to any state but idle.
    function cuttable(c) { return !poseChanging(c) && (c.state !== 'reaction' || (isHello(c) && state !== 'idle')); }
    function evaluate() {
      if (dead || !ready || pausedHidden || reducedActive()) return;
      const c = selector.state.current;
      if (!c) { next(false); return; }
      if (!cuttable(c)) return;
      if (c.state === state && !isHello(c)) return;
      if (!isHello(c) && leftOf(slots[front], c) <= END_WAIT_S) return;   // nearly over: let it end
      next(true);
    }

    // ── background colour ──
    function sampleBackground(video) {
      try {
        const cv = doc.createElement('canvas'); cv.width = 32; cv.height = 18;
        const c2 = cv.getContext('2d'); c2.drawImage(video, 0, 0, 32, 18);
        const d = c2.getImageData(0, 0, 32, 18).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = 0; y < 18; y++) for (let x = 0; x < 32; x++) {
          if (x > 1 && x < 30 && y > 1 && y < 16) continue;   // the outer two pixels only
          const i = (y * 32 + x) * 4; r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
        }
        if (n) css(rootEl, { background: 'rgb(' + Math.round(r / n) + ',' + Math.round(g / n) + ',' + Math.round(b / n) + ')' });
      } catch (e) { /* keep the fallback colour */ }
    }

    // ── reduced motion: a still pose plus the beak only ──
    function enterReduced() {
      startToken++; gen++; planned = null; cancelWatch(); clearRetry();
      coverUp = false; stillUp = false; untimer(coverTimer); coverTimer = null;
      untimer(watchdog); watchdog = null; untimer(planTimer); planTimer = null; untimer(loadTimer); loadTimer = null;
      V = { clip: null, frame: 0, blendFrom: null };
      if (!ready) return;
      selector.state.current = null; selector.state.pose = 'A';   // whatever was playing (even a clip that began on pose B) gives way to the canonical A still
      showStill();
      draw(); reducedLoop();
    }
    // the still is always an A-pose first frame, never the paused first frame of whatever played: the beak is drawn at the master
    // position, which is only right over pose A. Until that picture is really there the beak is not drawn (stillReady).
    function stillCandidate() {   // an existing pose-A picture: an idle clip's first frame (the pack carries no separate master image)
      const usable = c => !bad.has(c.name) && c.startsFrom === 'A';
      return M.clips.filter(c => usable(c) && c.state === 'idle' && c.endsOn === 'A' && !c.track)[0] || M.clips.filter(c => usable(c) && !c.track)[0] || M.clips.filter(usable)[0] || null;
    }
    // start-up and reopen: the still is loaded into the front video and shown at once; readiness waits for it (bounded), so the
    // stage is never declared ready while empty. It stays until the first clip is really playing (see commit/uncover).
    function loadStill() {
      const cand = dead || reducedActive() ? null : stillCandidate();
      if (!cand) return Promise.resolve(false);
      return new Promise(res => {
        const slot = slots[front]; let done = false, tm = null;
        const fin = ok => { if (done) return; done = true; untimer(tm); stillCancel = null; res(ok); };
        stillCancel = () => fin(false);
        tm = timer(() => fin(false), STILL_WAIT_MS);
        setSource(slot, cand.name);
        const g = slot.gen;
        slot.waiters.push(() => {
          if (dead || slot.gen !== g) { fin(false); return; }
          if (slot.failed) { bad.add(cand.name); fin(false); return; }
          if (done || reducedActive()) { fin(false); return; }
          try { slot.video.currentTime = 0; slot.video.pause(); } catch (e) { /* ignore */ }
          css(slot.video, { opacity: '1', transition: 'none', zIndex: '2' });
          stillUp = true;
          if (!bgGiven && !bgSampled) { bgSampled = true; sampleBackground(slot.video); }
          fin(true);
        });
      });
    }
    function showStill() {
      untimer(fadeTimer); fadeTimer = null;
      stillReady = false; stillClip = null;
      const cand = stillCandidate();
      slots.forEach(sl => { try { sl.video.pause(); } catch (e) { /* ignore */ } });
      if (!cand) return;   // no A-pose picture at all: nothing is shown and no beak is drawn over nothing
      stillClip = cand;
      const slot = slots[front], other = slots[1 - front];
      css(other.video, { opacity: '0', transition: 'none', zIndex: '1' }); css(slot.video, { opacity: '1', transition: 'none', zIndex: '2' });
      const shown = () => {
        try { slot.video.currentTime = 0; slot.video.pause(); } catch (e) { /* ignore */ }
        stillReady = true;
        if (!bgGiven && !bgSampled) { bgSampled = true; sampleBackground(slot.video); }
        draw();
      };
      if (slot.clip === cand.name && slot.ready && !slot.failed) { shown(); return; }
      setSource(slot, cand.name);
      const myGen = slot.gen;
      slot.waiters.push(() => {
        if (dead || !reducedActive() || slots[front] !== slot || slot.gen !== myGen) return;   // a late load of an earlier choice does nothing
        if (slot.failed) { bad.add(cand.name); showStill(); return; }                              // set aside, the next candidate (bounded: bad only grows)
        shown();
      });
    }
    function reducedLoop() {
      if (reducedRaf != null || dead || !reducedActive() || pausedHidden) return;
      const tick = now => {
        reducedRaf = null;
        if (dead || !reducedActive() || pausedHidden) return;
        if (state === 'speaking') { beakShape = beakNow(now); draw(); reducedRaf = rafFn(tick); }
        else { beakShape = beakNow(now); draw(); }   // closed + cleared; the loop restarts with the next speaking state
      };
      reducedRaf = rafFn(tick);
    }
    function leaveReduced() {
      if (reducedRaf != null) { cafFn(reducedRaf); reducedRaf = null; }
      stillClip = null; stillReady = false;
      if (!ready || pausedHidden) return;
      selector.state.current = null;   // the still is not a played clip: start over from the master pose
      selector.state.pose = 'A';
      V = { clip: null, frame: 0, blendFrom: null };
      next(false);
    }
    function applyReduced(was) {
      if (reduced() === was) return;
      if (reduced()) enterReduced(); else leaveReduced();
    }

    // ── hidden: pause everything that moves, resume where it was ──
    function onHidden() {
      pausedHidden = true; startToken++; cancelWatch(); clearRetry(); untimer(loadTimer); loadTimer = null;
      untimer(watchdog); watchdog = null;
      if (reducedRaf != null) { cafFn(reducedRaf); reducedRaf = null; }
      slots.forEach(s => { try { s.video.pause(); } catch (e) { /* ignore */ } });
    }
    function onVisible() {
      pausedHidden = false;
      if (!ready) return;
      if (reducedActive()) { reducedLoop(); return; }
      const c = selector.state.current, s = slots[front];
      if (!c || leftOf(s, c) <= 0.1) { next(false); return; }
      gen++;
      const myGen = gen;
      playVideo(s.video); watch(s.video, c, myGen);
      watchdog = timer(() => { watchdog = null; if (myGen === gen) clipEnded(); }, leftOf(s, c) * 1000 + 1500);
      evaluate();
    }

    // ── the background cache: starters first, the rest at low priority and bounded; never waited for ──
    function startWarm() {
      if (!fetchFn || !M) return;
      const by = st => M.clips.filter(c => c.state === st);
      const starters = [].concat(
        M.clips.filter(c => isHello(c)).slice(0, 1), by('idle').slice(0, 3), by('listening').slice(0, 2), by('thinking').slice(0, 1), by('speaking').slice(0, 2),
        M.clips.filter(c => c.state === 'reaction' && (c.mood === 'goodbye' || /^reaction-goodbye/.test(c.name))).slice(0, 1));
      const seen = new Set(starters.map(c => c.name)), rest = [];
      const lanes = ['idle', 'listening', 'thinking', 'speaking', 'reaction'].map(st => by(st).filter(c => !seen.has(c.name)));
      for (let i = 0; lanes.some(l => i < l.length); i++) lanes.forEach(l => { if (i < l.length) rest.push(l[i]); });
      const list = starters.concat(rest).map(c => c.name);
      let idx = 0, active = 0, count = 0, bytes = 0;
      const pump = () => {
        while (!dead && active < warmConc && idx < list.length && count < warmLimit && bytes < warmBytes) {
          const n = list[idx++];
          if (slots.some(s => s.clip === n) || bad.has(n)) continue;
          active++; count++;
          const low = idx > starters.length;
          Promise.resolve(fetchFn(urls.clip(n), { credentials: 'same-origin', priority: low ? 'low' : 'auto', signal: abort ? abort.signal : undefined }))
            .then(r => (r && r.ok !== false && r.arrayBuffer ? r.arrayBuffer() : null))
            .then(b => { if (b && b.byteLength) bytes += b.byteLength; }, () => {})   // only the size is kept: the bytes are dropped at once
            .then(() => { active--; if (!dead) timer(pump, low ? 120 : 0); });
        }
      };
      pump();
      // every remaining speaking track (small files), two at a time
      const rem = M.clips.filter(c => c.track && !tracks[c.name]).map(c => c.name);
      let ti = 0;
      const tpump = () => { if (dead || ti >= rem.length) return; const n = rem[ti++]; loadTrack(n).then(() => { if (!dead) timer(tpump, 30); }); };
      tpump(); tpump();
    }

    // ── start-up ──
    function init() {
      if (!doc || !container || typeof doc.createElement !== 'function') throw new Error('no document or container');
      rootEl = doc.createElement('div');
      css(rootEl, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', overflow: 'hidden', background: opts.fallbackBackground || '#1c1c1c' });
      if (rootEl.setAttribute) { rootEl.setAttribute('role', 'img'); rootEl.setAttribute('aria-label', opts.label || 'Animated character'); }
      slots.push(mkVideo(0), mkVideo(1));
      canvas = doc.createElement('canvas');
      css(canvas, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', zIndex: '5', pointerEvents: 'none' });
      if (canvas.setAttribute) canvas.setAttribute('aria-hidden', 'true');
      ctx = canvas.getContext('2d');
      stage = doc.createElement('div');
      const ramp = d => 'linear-gradient(to ' + d + ', transparent 0%, #000 ' + (FEATHER * 100) + '%, #000 ' + (100 - FEATHER * 100) + '%, transparent 100%)';
      const mask = ramp('right') + ', ' + ramp('bottom');
      css(stage, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', overflow: 'hidden', pointerEvents: 'none',
        maskImage: mask, webkitMaskImage: mask, maskComposite: 'intersect', webkitMaskComposite: 'source-in' });
      stage.appendChild(slots[0].video); stage.appendChild(slots[1].video);
      rootEl.appendChild(stage); rootEl.appendChild(canvas);
      container.appendChild(rootEl);
      if (typeof AbortController !== 'undefined') abort = new AbortController();
      if (opts.reducedMotion === undefined && win && win.matchMedia) {
        try {
          mql = win.matchMedia('(prefers-reduced-motion: reduce)'); reducedSys = !!mql.matches;
          mqlHandler = e => { const was = reduced(); reducedSys = !!e.matches; applyReduced(was); };
          if (mql.addEventListener) mql.addEventListener('change', mqlHandler); else if (mql.addListener) mql.addListener(mqlHandler);
        } catch (e) { mql = null; }
      }
      const RO = opts.ResizeObserver || (win && win.ResizeObserver);
      if (RO) { try { ro = new RO(() => { if (!dead) { measure(); draw(); } }); ro.observe(container); } catch (e) { ro = null; } }
      if (!ro && win && win.addEventListener) { onWinResize = () => { if (!dead) { measure(); draw(); } }; win.addEventListener('resize', onWinResize); }
      pausedHidden = !!(doc.hidden || doc.visibilityState === 'hidden');
      onVis = () => { if (dead) return; const h = !!(doc.hidden || doc.visibilityState === 'hidden'); if (h && !pausedHidden) onHidden(); else if (!h && pausedHidden) onVisible(); };
      if (doc.addEventListener) doc.addEventListener('visibilitychange', onVis);
      measure();
    }
    function boot() {
      const pm = opts.manifest ? Promise.resolve(opts.manifest) : jget(urls.manifest());
      return pm.then(raw => {
        const m = faceNormalizeManifest(raw);
        if (!m || !m.clips.length) throw new Error('unusable manifest');
        M = m;
        if (M.background) { bgGiven = true; css(rootEl, { background: M.background }); }
        selector = faceCreateSelector(M.clips, { random: rng, now: nowFn, ok: c => !bad.has(c.name) && (!c.track || !!tracks[c.name]) });
        const speak = M.clips.filter(c => c.track);
        // a pack whose clips carry a beak track must bring a complete beak: the five speaking shapes (and the smile) all have to load,
        // otherwise speaking would be a talking character without a visible beak
        if (speak.length && (!M.beak || SHAPES5.some(n => M.beak.shapes.indexOf(n) < 0))) throw new Error('the pack has beak tracks but no complete beak (closed, slight, half, wide, oo)');
        const names = M.beak ? Array.from(new Set(M.beak.shapes.concat([M.beak.smile]))) : [];
        const firstTracks = speak.slice(0, 2).map(c => loadTrack(c.name));
        return Promise.all([Promise.all(names.map(loadPatch)), Promise.all(firstTracks), loadStill()]).then(r => ({ names, patchOk: r[0], trackOk: r[1], speak }));
      }).then(r => {
        if (dead) return player;
        const miss = r.names.filter((n, i) => !r.patchOk[i]);
        if (miss.length) throw new Error('beak patch could not be loaded: ' + miss.join(', '));
        if (r.speak.length && !r.trackOk.some(Boolean)) throw new Error('no speaking track could be loaded');
        ready = true;
        if (reducedActive()) enterReduced(); else if (!pausedHidden) next(false);
        if (earlyReact) { const n = earlyReact; earlyReact = null; if (!(state !== 'idle' && isHelloName(n))) api.react(n); }
        startWarm();
        return player;
      });
    }

    // ── the interface ──
    const api = {
      setState(s) {
        if (dead || STATES.indexOf(s) < 0) return false;
        const changed = s !== state;
        const hello = ready && !!selector.state.current && isHello(selector.state.current) && !reducedActive();
        state = s;
        if (changed && s !== 'speaking') { synth.on = false; closeBeakNow(); }
        if (s !== 'idle' && earlyReact && isHelloName(earlyReact)) earlyReact = null;   // a hello asked for before ready is dropped like a waiting one
        if (pending && pending.hello && s !== 'idle') pending = null;   // a hello that has not started yet is dropped when the person is already being heard
        if (!changed && !(hello && s !== 'idle')) return true;
        invalidatePlan();
        if (reducedActive()) { reducedLoop(); return true; }
        evaluate();
        return true;
      },
      setLevel(v) { if (dead) return; const n = Number(v); extLevel = isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; },
      setMicLevel() { /* the character does not follow the microphone */ },
      setAnalyser(a) {
        if (dead) return;
        analyser = a || null; gated = false; beak.env.last = 0;
        if (!analyser) closeBeakNow();
      },
      react(name) {
        if (dead) return false;
        if (!ready) { if (failed || name == null || !String(name).trim()) return false; earlyReact = String(name).toLowerCase().trim(); return true; }
        const pool = resolveReaction(name);
        if (!pool.length) return false;
        if (reducedActive()) return true;
        const m = String(name).toLowerCase().trim();
        pending = { name: m, hello: m === 'hello' || pool.every(c => isHello(c)) };
        invalidatePlan();
        const c = selector.state.current;
        if (!c) { next(false); return true; }
        if (poseChanging(c) || (c.state === 'reaction' && !(isHello(c) && state !== 'idle'))) return true;   // finishes first, the reaction follows
        if (leftOf(slots[front], c) <= END_WAIT_S) return true;
        next(true);
        return true;
      },
      speechEvent(kind) {
        if (dead) return;
        const now = nowFn();
        if (kind === 'start') { synth.on = true; synth.since = now; synth.kick = 0.2; gated = false; }
        else if (kind === 'boundary') { if (!synth.on) synth.since = now; synth.on = true; synth.kick = 0.3; gated = false; }
        else if (kind === 'resume') { synth.on = true; if (!synth.since) synth.since = now; gated = false; }
        else if (kind === 'end') { synth.on = false; synth.kick = 0; gated = true; closeBeakNow(); }   // gated: residual analyser samples must not reopen the beak
        else if (kind === 'pause' || kind === 'cancel') { synth.on = false; synth.kick = 0; gated = true; extLevel = 0; closeBeakNow(); }
      },
      setReducedMotion(b) { const was = reduced(); reducedForce = typeof b === 'boolean' ? b : null; if (!dead) applyReduced(was); },
      getInfo() {
        const c = selector && selector.state.current;
        return { state, ready, failed: failed ? String(failed.message || failed) : null, clip: c ? c.name : null, pose: selector ? selector.state.pose : 'A', front, shape: beakShape,
          reduced: reduced(), hidden: pausedHidden, destroyed: dead, pending: pending ? pending.name : null, w: cw, h: ch, dpr, canvasW: canvas ? canvas.width : 0, canvasH: canvas ? canvas.height : 0,
          covered: coverUp, still: stillUp, stage: stageRect ? Object.assign({}, stageRect) : null, tracks: Object.keys(tracks).length, bad: Array.from(bad), log: log.slice() };
      },
      destroy() {
        if (dead) return;
        dead = true; startToken++; gen++;
        cancelWatch();
        live.forEach(t => clearT(t)); live.clear();
        watchdog = retryTimer = fadeTimer = planTimer = loadTimer = null;
        Array.from(patchWaits).forEach(w => w.cancel());
        if (stillCancel) stillCancel();
        if (redrawRaf != null) cafFn(redrawRaf);
        if (reducedRaf != null) cafFn(reducedRaf);
        if (abort) { try { abort.abort(); } catch (e) { /* ignore */ } }
        if (ro) { try { ro.disconnect(); } catch (e) { /* ignore */ } ro = null; }
        if (onWinResize && win.removeEventListener) win.removeEventListener('resize', onWinResize);
        if (onVis && doc.removeEventListener) doc.removeEventListener('visibilitychange', onVis);
        if (gestureHandler && doc.removeEventListener) { doc.removeEventListener('pointerdown', gestureHandler); doc.removeEventListener('keydown', gestureHandler); }
        if (mql && mqlHandler) { try { if (mql.removeEventListener) mql.removeEventListener('change', mqlHandler); else if (mql.removeListener) mql.removeListener(mqlHandler); } catch (e) { /* ignore */ } }
        slots.forEach(s => {
          s.waiters = [];
          try { s.video.pause(); s.video.removeEventListener('loadeddata', s.onLoaded); s.video.removeEventListener('error', s.onError); s.video.removeEventListener('ended', s.onEnded); s.video.removeEventListener('playing', s.onPlaying); s.video.removeAttribute('src'); if (s.video.load) s.video.load(); } catch (e) { /* ignore */ }
        });
        if (rootEl && rootEl.parentNode) { try { rootEl.parentNode.removeChild(rootEl); } catch (e) { /* ignore */ } }
        analyser = null; planned = null; pending = null; earlyReact = null;
      },
    };
    const player = api;

    api.ready = new Promise((resolve, reject) => {
      try {
        const id = opts.packId;
        if (!opts.manifest && !(typeof id === 'string' && PACK_RE.test(id))) throw new Error('invalid pack id');
        urls = faceUrls(typeof id === 'string' && PACK_RE.test(id) ? id : '_');
        init();
        boot().then(resolve, e => { failed = e; reject(e); });
      } catch (e) { failed = e; reject(e); }
    });
    api.ready.catch(() => {});   // a failed pack is reported by `ready` and getInfo(); never an unhandled rejection
    return api;
  }

  return { createFacePlayer, faceCreateSelector, faceCreateBeak, faceNormalizeManifest, faceNormalizeTrack, faceRng, faceUrls };
});
