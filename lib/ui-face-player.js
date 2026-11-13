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
 *     options.portraitSafe    share of the picture width kept in a portrait stage when the manifest has no valid safeArea (default 0.7, clamped 0.3..1)
 *   Manifest extras (all optional, a bad value is ignored and the fallback used): poster / posters.A (a pack-root relative JPEG/PNG/WebP, drawn
 *   as the first picture instead of a captured frame), safeAreaComfort / safeAreaTypical / safeArea {x,y,w,h} (fractions of the picture; the box
 *   used is the first valid one in that order, else the portraitSafe fallback). A stage narrower than 16:9 (portrait, square, 4:3) fits the BOX
 *   WIDTH to the stage width (capped so the full picture height fits) and centres the box; 16:9 and wider show the whole picture.
 *   Cold speech: while speaking is requested and no tracked speaking video is loaded, the poster is held with the beak animated on the MASTER
 *   transform (info.coldHold), never an untracked clip under the voice.
 *     options.fallbackBackground   colour while neither the manifest nor the first frame gives one (default '#1c1c1c')
 *     Mobile data cap: when navigator.connection reports type 'cellular', saveData true or effectiveType slow-2g/2g/3g, the speculative background
 *     cache (clip warm fetches AND the remaining speaking-track warm fetches) is not started at all (getInfo().warmCapped); clips and tracks
 *     needed for playback still load on demand. No connection API = no cap. Checked once when the cache would start (no listeners).
 *     Edge fade (every layout, never wider than 5 percent of the stage): the edge fade of an edge that has paper margin OUTSIDE the safe box is confined to that margin (exactly the margin
 *     when over 0.5 px, never more than the standard feather), eased as a soft glow, so the owl inside the safe box stays fully opaque (getInfo().stage.glow).
 *     injection (tests): window, document, navigator, now, raf, caf, setTimeout, clearTimeout, ResizeObserver
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
  const FEATHER = 0.05;          // the left and right video edges fade into the background over this share of the stage width (the sampled poster border is the background, so every fade is fully opaque by 5 percent)
  const MARGIN_PX = 1;           // opaque paper kept between the end of a fade ramp and the comfort box, in CSS px (rendered geometry)
  const MARGIN_SLACK = 0.02;     // covers the browser's layout snapping (1/64 px)
  const FEATHER_Y = 0.05;        // the top and bottom edges fade over this share of the stage height (same cap in every layout)
  const SPEAK_FADE_MS = 120;     // entering speaking: the cross-fade is complete inside the 150 ms budget (other changes keep FADE_MS)
  const REACT_FADE_MS = 70;      // reaction/goodbye and any pose-mismatched cut: one short cross-fade (120 ms left a visible ghost of the old pose); warm speech keeps SPEAK_FADE_MS, the cold poster handoff stays opaque
  // availability probe (the ONLY thing that can call a pack lost): a HEAD of the manifest (cache 'no-cache': revalidates through the ETag, never a body)
  // every 10 s in the background (30 s on a data-capped link) and as soon as a clip or track request fails, at most one start per second and one in flight
  const PROBE_BG_MS = 10000, PROBE_BG_CAPPED_MS = 30000, PROBE_MIN_GAP_MS = 1000, PROBE_TIMEOUT_MS = 4000;
  const SPEAK_REVIVE_MS = 4000, SPEAK_REVIVE_MAX = 2;   // every speaking clip failed: the poster-and-beak hold stays and the failed ones are retried at most this often / this many times per reply
  const GLOW_REACH = 0.3, GLOW_COLS = 64, GLOW_ROWS_MIN = 48, GLOW_ROWS_MAX = 384, EDGE_COLS = 48;   // edge glow: eases out over 30% of the stage height (>= 15% wherever there is room), low-resolution canvas
  const PORTRAIT_SAFE = 0.7;     // portrait: the central 70% of the width (full height) is what must fit the stage (wide wing gestures stay in view)
  const FRAME_WAIT_MS = 400;   // how long the first still frame may take to be presented once its data is there
  const POSTER_WAIT_MS = 3000;   // how long the pack's poster image may take to load and decode before the actual first frame is used instead
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
    // optional poster image and portrait safe area; a bad value is ignored here (the player falls back), the installer is what rejects it
    let poster = facePosterPath(m.poster), posters = null;
    if (m.posters !== undefined && m.posters !== null) {
      if (typeof m.posters === 'object' && !Array.isArray(m.posters)) {
        posters = {};   // only the pose names in use today (A, B); other keys are allowed and ignored
        for (const k of ['A', 'B']) { const v = facePosterPath(m.posters[k]); if (v) posters[k] = v; }
        if (!posters.A || posters.A !== poster) poster = null;   // posters present: poster must be there and equal posters.A
      } else poster = null;
    }
    return { clips, beak, background: bg, poster, posters, safeArea: faceSafeArea(m.safeArea), safeAreaTypical: faceSafeArea(m.safeAreaTypical), safeAreaComfort: faceSafeArea(m.safeAreaComfort) };
  }
  // a pack-root relative path to a JPEG/PNG/WebP: no leading slash, no "..", only plain name characters (so it needs no escaping and is
  // exactly the key the server's allowlist knows)
  const POSTER_RE = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,79}\/){0,5}[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.(?:jpe?g|png|webp)$/i;
  function facePosterPath(s) { return typeof s === 'string' && s.length <= 240 && POSTER_RE.test(s) && s.indexOf('..') < 0 ? s : null; }
  // exact numeric {x,y,w,h} in 0..1 of the picture: finite, x,y >= 0, w,h > 0, x+w <= 1, y+h <= 1; anything else is null
  function faceSafeArea(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).sort().join(',') !== 'h,w,x,y') return null;
    const x = o.x, y = o.y, w = o.w, h = o.h, num = v => typeof v === 'number' && isFinite(v);
    if (!num(x) || !num(y) || !num(w) || !num(h) || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1 + 1e-9 || y + h > 1 + 1e-9) return null;
    return { x, y, w, h };
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
    // Speaking is explicit and immediate: a tracked speaking clip whatever the current pose or clip is (the pose chaining above yields to it;
    // the caller cross-fades quickly). Preference: pose-exact (starts and ends on the current pose), starts on the current pose, ends on the
    // master pose A (the chain then continues from A), any tracked speaking clip. Reactions and idle fallbacks are never a candidate.
    const speakers = () => good().filter(c => c.state === 'speaking' && c.track);
    // prefer(clip) -> true marks a clip whose video is already loaded: those are tried first (a repeat of a recent one included, since
    // `choose` relaxes its variety rules last), and only when none of them yields a pick is the rest considered
    function pickSpeakNow(prefer) {
      const sp = speakers();
      if (!sp.length) return null;
      const tiers = [c => c.startsFrom === S.pose && c.endsOn === S.pose, c => c.startsFrom === S.pose, c => c.endsOn === 'A', () => true];
      const hot = typeof prefer === 'function' ? sp.filter(prefer) : [];
      for (const base of hot.length ? [hot, sp] : [sp]) {
        for (const f of tiers) {
          const pool = base.filter(f);
          if (!pool.length) continue;
          const r = choose(pool, 'speaking' + (S.pose === 'B' ? '-B' : ''), 'speaking');
          if (r) return { clip: r.clip, hkey: r.hkey, kind: 'state' };
        }
      }
      return null;
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
    return { pick, pickSpeakNow, choose, canSpeak: () => speakers().length > 0, commit, state: S };
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
      poster: p => { const ok = facePosterPath(p); return ok ? base + ok.split('/').map(enc).join('/') : null; },   // a manifest-named asset path, never anything else
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
    // A pack is LOST only on a verdict: the manifest probe answered 404/410 (the pack was removed). A timeout, a network error, a 5xx, a failed clip,
    // a failed track, a stalled picture or any amount of retrying is NEVER a loss: the poster and the animated beak stay for the whole reply and the
    // bounded retries go on. When lost: retries and warming stop, getInfo().lost says why and options.onLost(reason) is called once.
    let lost = null;
    function markLost(why) {
      if (dead || lost) return;
      lost = why || 'the character files are no longer available';
      stopProbe();
      startToken++; clearRetry(); untimer(loadTimer); loadTimer = null; untimer(planTimer); planTimer = null;
      if (typeof opts.onLost === 'function') { try { opts.onLost(lost); } catch (e) { /* the host's hook must not break the player */ } }
    }
    // Availability probe (only for a pack fetched by id, never an injected manifest): while the player is ready, visible and the pack is not known
    // removed/lost, a HEAD of the manifest (credentials same-origin, cache 'no-cache': a revalidation through the server's ETag, no body even for the
    // first one) runs every PROBE_BG_MS (PROBE_BG_CAPPED_MS on a data-capped link) and ASAP after any failed clip or track request (requestProbe), never
    // more than one start per PROBE_MIN_GAP_MS and never two in flight (no storm: a failing pack with failing probes still costs 1 request/second at
    // most). The verdict is read from the RESPONSE only: 404/410 = gone (packRemoved() + onLost once, at once); 200/other 2xx/304 = exists; anything
    // else (timeout after PROBE_TIMEOUT_MS, network error, 5xx, 429) = no verdict and nothing changes. Hidden cancels it (an in-flight request has no
    // say), visible probes at once, destroy/packRemoved/lost cancel it for good.
    let probeTimer = null, probeKill = null, probeAbort = null, probing = false, probeOn = false, probeGen = 0;   // probeGen: a probe cancelled by hidden/lost/destroy has no say, even when its fetch answers late
    let probeLast = -Infinity, probeAsap = false, probeCount = 0, probeVerdict = null;   // probeVerdict: 'exists' | 'gone' | null (nothing decided yet)
    function stopProbe() {
      probeOn = false; probeAsap = false; probeGen++; untimer(probeTimer); probeTimer = null; untimer(probeKill); probeKill = null; probing = false;
      if (probeAbort) { try { probeAbort.abort(); } catch (e) { /* ignore */ } probeAbort = null; }
    }
    function probeCanRun() { return probeOn && !dead && !lost && !packRemoved && !pausedHidden && !!fetchFn && !!urls; }
    function schedProbe(ms) { untimer(probeTimer); probeTimer = timer(probeNow, Math.max(0, ms)); }
    function probeNow() {
      untimer(probeTimer); probeTimer = null;
      if (!probeCanRun() || probing) return;
      const wait = probeLast + PROBE_MIN_GAP_MS - nowFn();
      if (wait > 0) { schedProbe(wait); return; }   // the rate limit: one start per second at most, whatever asks
      probing = true; probeAsap = false; probeLast = nowFn(); probeCount++;
      const ac = typeof AbortController !== 'undefined' ? new AbortController() : null; probeAbort = ac;
      let done = false; const myGen = probeGen;
      const fin = (verdict) => {   // 'gone' | 'exists' | null (no verdict)
        if (done) return; done = true;
        if (ac) { try { ac.abort(); } catch (e) { /* ignore */ } }
        if (dead || myGen !== probeGen) return;   // cancelled meanwhile: no verdict
        untimer(probeKill); probeKill = null; probing = false;
        if (probeAbort === ac) probeAbort = null;
        if (verdict === 'gone' && !lost && !packRemoved) { probeVerdict = 'gone'; api.packRemoved(); markLost(); return; }
        if (verdict === 'exists') { probeVerdict = 'exists'; reviveClips(); }   // the pack answers again: clips set aside by a transient failure may be tried again (bounded)
        if (probeCanRun()) schedProbe(probeAsap ? probeLast + PROBE_MIN_GAP_MS - nowFn() : probeLast + probeInterval() - nowFn());   // the next one: ASAP if a failure asked meanwhile, else the background cadence from this start
      };
      probeKill = timer(() => fin(null), PROBE_TIMEOUT_MS);
      try {
        Promise.resolve(fetchFn(urls.manifest(), { method: 'HEAD', credentials: 'same-origin', cache: 'no-cache', signal: ac ? ac.signal : undefined }))
          .then(r => {
            if (r && r.body && typeof r.body.cancel === 'function') { try { const c = r.body.cancel(); if (c && c.catch) c.catch(() => {}); } catch (e) { /* ignore */ } }
            const s = r ? r.status : 0;
            fin(s === 404 || s === 410 ? 'gone' : (r && r.ok === true) || s === 304 || (s >= 200 && s < 300) ? 'exists' : null);
          }, () => fin(null));
      } catch (e) { fin(null); }
    }
    function probeInterval() { return dataCapped() ? PROBE_BG_CAPPED_MS : PROBE_BG_MS; }
    function requestProbe() {   // a clip or track request failed: look at the manifest as soon as the rate limit allows (one in flight; folded into one)
      if (!probeCanRun() || (probeAsap && (probeTimer || probing))) return;
      probeAsap = true;
      if (!probing) schedProbe(probeLast + PROBE_MIN_GAP_MS - nowFn());
    }
    function startProbe() {
      if (opts.manifest || opts.probe === false || !fetchFn) return;
      probeOn = true;
      if (!pausedHidden && !probeTimer && !probing) schedProbe(probeInterval());
    }
    function pauseProbe() {   // hidden: nothing runs (an in-flight request is cancelled, no verdict); probeOn stays so visible resumes
      probeAsap = false; probeGen++; untimer(probeTimer); probeTimer = null; untimer(probeKill); probeKill = null; probing = false;
      if (probeAbort) { try { probeAbort.abort(); } catch (e) { /* ignore */ } probeAbort = null; }
    }
    let state = 'idle', pending = null, earlyReact = null, speakAsk = null, speakLatency = null;   // speakAsk: clock time of the setState('speaking') still waiting for its tracked clip
    let gen = 0, startToken = 0, starting = 0, endedFor = -1, busyUntil = 0, planned = null, rareFails = 0;
    let front = 0, V = { clip: null, frame: 0, blendFrom: null }, lastShape = 'closed', beakShape = 'closed';
    let pausedHidden = false, reducedSys = false, reducedForce = typeof opts.reducedMotion === 'boolean' ? opts.reducedMotion : null;
    let analyser = null, gated = false, extLevel = 0;
    const synth = { on: false, since: 0, kick: 0 };
    const bad = new Set(), tracks = {}, trackLoading = {}, patches = {};
    // Why each clip in `bad` was set aside. A decode error (MediaError 3: the file itself is broken) is final. Anything else (a network error, the
    // 8 s load wait, MediaError 4, which Chrome also gives for a server it cannot reach) is transient: once the network is seen working again (the
    // manifest probe answers 'exists', or any clip really starts) the entry is released (reviveClips), at most CLIP_REVIVE_MAX times per clip and
    // only after a growing wait since its last failure (5 s, 15 s, 45 s, then 60 s), so a long outage does not freeze idle, listening and thinking
    // for the rest of the call and a broken server never causes a retry storm. A removed or lost pack revives nothing.
    const CLIP_REVIVE_MAX = 4, CLIP_REVIVE_BASE_MS = 5000, CLIP_REVIVE_CAP_MS = 60000;
    const badWhy = new Map();   // name -> { final, fails, at }
    let clipRevivals = 0;
    const TRACK_RETRY_MS = [5000, 20000];   // transient track failures: retried after 5 s, then 20 s, then never
    const trackRetry = {}, trackTimer = {}, trackGone = {};   // per track: retries used, pending retry timer, definitely absent (404/410/invalid)
    let packRemoved = false;   // set by api.packRemoved(): no further track or clip revival
    const log = [];
    let selector = null, selectorOk = null;
    const beak = faceCreateBeak();
    let watchCancel = null, watchdog = null, retryTimer = null, fadeTimer = null, planTimer = null, loadTimer = null, redrawRaf = null, reducedRaf = null;
    let abort = null, bgSampled = false, bgGiven = false, stillClip = null, stillReady = false, posterBgDone = false, bgColor = '';
    let poster = null, pctx = null, posterUp = false, posterCancel = null;   // poster: a canvas holding the decoded first frame of the pack, painted by us (a detached/unpainted <video> can still show nothing)
    let startingSpeak = false, reviveTries = 0, lastRevive = -Infinity;   // failed speaking clips retried during one reply (bounded, see reviveSpeakers)
    let posterReal = false, holdOn = false, holdRaf = null, coldHolds = 0;   // posterReal: the poster canvas holds a real picture of the pack; holdOn: cold speech, the poster is up with the beak drawn on the MASTER transform until a tracked speaking video is loaded
    let pictureSettle = null, degraded = null;   // pictureSettle(bool) settles `pictureReady` once; degraded: a note when ready resolved without any speaking track (the poster hold is the speech display)
    function settlePicture(ok) { if (pictureSettle) { const f = pictureSettle; pictureSettle = null; f(!!ok); } }
    let posterImg = null, posterPending = null;   // the pack's own poster image (decoded, loaded) when the manifest names one; preferred over a captured frame
    let warmCapped = false;   // the speculative cache was skipped for a metered / slow link
    let drawable = false;   // a real picture of the pack is on screen (the still shown, or a clip playing in front); never a drawn placeholder
    let stillUp = false, coverUp = false, coverGen = 0, coverTries = 0, coverTimer = null, stillCancel = null, stage = null, stageRect = null;
    const safeFrac = Number(opts.portraitSafe) >= 0.3 && Number(opts.portraitSafe) <= 1 ? Number(opts.portraitSafe) : PORTRAIT_SAFE;
    let cw = 0, ch = 0, dpr = 1, ro = null, onVis = null, onWinResize = null, mql = null, mqlHandler = null, gestureHandler = null;
    const patchWaits = new Set();   // image loads in flight: each one is settled when the player is destroyed

    // ── DOM (createElement only; styles through the CSSOM) ──
    const css = (el, o) => { for (const k in o) el.style[k] = o[k]; };
    let rootEl = null, canvas = null, ctx = null;
    let glowCv = null, glowCtx = null, edgeProfile = null, edgeId = 0, glowKey = '';   // the edge glow (see layoutEdgeGlow)
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
      slot.onPlaying = () => { if (!dead && slots[front] === slot && mine() && !v.paused) drawable = true; if (!dead && coverUp && slots[front] === slot && slot.gen === coverGen && mine() && !v.paused) uncover(); };
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
      const fy = FEATHER_Y;
      const L = layout(MASTER), w = MASTER.w * L.s, h = MASTER.h * L.s;
      const x0 = Math.max(0, L.ox), y0 = Math.max(0, L.oy), x1 = Math.min(cw, L.ox + w), y1 = Math.min(ch, L.oy + h);
      // Narrow stage: paper margin between the safe box and a stage edge is faded INSIDE that margin only (opaque from the box edge inward),
      // so the owl and its wing tips never fade; an edge the view cuts into the box has no fade (see realBox below).
      let glow = null;
      const sbx = safeBox(), sw = x1 - x0, sh = y1 - y0;
      // A real (manifest) safe box is never faded: an edge with paper margin fades inside that margin only, and an edge with no margin (the view or
      // the picture edge IS the box edge) gets no fade at all. Only the full-height fallback box (no manifest box) keeps the standard feather.
      const realBox = safeSource() !== 'fallback';
      // Every real-box edge keeps >= 1 CSS px of OPAQUE paper between the end of the ramp and the box (MARGIN_PX), measured on the ROUNDED geometry that
      // is written to the DOM below (2 decimals), with the ramp share floored to the 0.01 percent the gradient is written in; too little margin (or a view
      // cut into the box) means zero feather on that edge. The fallback box (no manifest box) keeps the standard feather.
      const r2 = n => Math.round(n * 100) / 100;
      const edge = (margin, dim, f) => {
        if (!realBox) return f;
        const room = margin - MARGIN_PX - MARGIN_SLACK;
        return room > 0 && dim > 0 ? Math.floor(Math.min(f, room / dim) * 10000) / 10000 : 0;
      };
      const rx0 = r2(x0), ry0 = r2(y0), rsw = r2(Math.max(0, x1 - x0)), rsh = r2(Math.max(0, y1 - y0)), pw = r2(w), ph = r2(h), pl = r2(L.ox - x0), pt = r2(L.oy - y0);
      if (sw > 0 && sh > 0 && rsw > 0 && rsh > 0) {   // every layout: no fade ever reaches into (or within 1 px of) the real safe box
        const bl = pl + sbx.x * pw, br = pl + (sbx.x + sbx.w) * pw, bt = pt + sbx.y * ph, bb = pt + (sbx.y + sbx.h) * ph;   // the box in stage pixels
        glow = { left: edge(bl, rsw, FEATHER), right: edge(rsw - br, rsw, FEATHER), top: edge(bt, rsh, fy), bottom: edge(rsh - bb, rsh, fy) };
      }
      const pc = n => Math.round(n * 10000) / 100;
      const ramp = (d, f, a, b) => {
        a = a == null ? f : a; b = b == null ? f : b;
        if (a === f && b === f) return 'linear-gradient(to ' + d + ', transparent 0%, #000 ' + (f * 100) + '%, #000 ' + (100 - f * 100) + '%, transparent 100%)';
        const lo = a > 0 ? 'transparent 0%, rgba(0, 0, 0, 0.35) ' + pc(a / 2) + '%, #000 ' + pc(a) + '%' : '#000 0%';   // a zero edge has no fade stops at all
        const hi = b > 0 ? '#000 ' + pc(1 - b) + '%, rgba(0, 0, 0, 0.35) ' + pc(1 - b / 2) + '%, transparent 100%' : '#000 100%';
        return 'linear-gradient(to ' + d + ', ' + lo + ', ' + hi + ')';
      };
      const mask = ramp('right', FEATHER, glow && glow.left, glow && glow.right) + ', ' + ramp('bottom', fy, glow && glow.top, glow && glow.bottom);
      css(stage, { maskImage: mask, webkitMaskImage: mask });
      const px = n => (Math.round(n * 100) / 100) + 'px';
      css(stage, { left: px(x0), top: px(y0), width: px(Math.max(0, x1 - x0)), height: px(Math.max(0, y1 - y0)) });
      slots.forEach(sl => css(sl.video, { left: px(L.ox - x0), top: px(L.oy - y0), width: px(w), height: px(h) }));
      if (poster) css(poster, { left: px(L.ox - x0), top: px(L.oy - y0), width: px(w), height: px(h) });
      stageRect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0, picture: { x: L.ox, y: L.oy, w, h, scale: L.s }, portrait: ch > cw, narrow: narrowStage(), feather: FEATHER, featherY: fy, glow, safeArea: Object.assign({}, safeBox()), safeSource: safeSource() };
      stageRect.edgeGlow = layoutEdgeGlow(L, w, x0, y0, x1, y1);
    }
    // ── edge glow ──
    // The flat stage colour matches the poster's corners, but the poster's top and bottom edge CENTRES are brighter, so a band showed where the feathered
    // clip ends. A soft glow of the poster's own top / bottom edge-row colours (a spatial profile across the width, read ONCE from the decoded poster)
    // sits BEHIND the clip stage: it starts at the clip edge in the edge-row colour and eases out into the border colour (it is transparent over the
    // player's background, which is that border colour), over GLOW_REACH of the stage height (never under GLOW_MIN where the host has the room). It is drawn at
    // low resolution into one canvas (CSS scales it smoothly) only when the layout changes (resize, caption reserve), never per frame.
    // opts.glowBeyond: the host clips by itself (the call display's stage): the canvas may run past the player, so a clip that ends above a caption
    // band, or short of the host edge, still fades out fully; otherwise the glow stays inside the player and fades within the room there is.
    function sampleEdgeRows(img) {
      try {
        const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height; if (!(iw > 0 && ih > 0)) return null;
        const cv = doc.createElement('canvas'); cv.width = EDGE_COLS; cv.height = 1; const c2 = cv.getContext('2d'), sh = Math.max(1, Math.round(ih * 0.01));
        const read = sy => {
          c2.clearRect(0, 0, EDGE_COLS, 1); c2.drawImage(img, 0, sy, iw, sh, 0, 0, EDGE_COLS, 1);
          const d = c2.getImageData(0, 0, EDGE_COLS, 1).data; if (!d || d.length !== EDGE_COLS * 4) return null;
          const out = []; for (let i = 0; i < EDGE_COLS; i++) { const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2]; if (!(d[i * 4 + 3] >= 128) || ![r, g, b].every(v => isFinite(v))) return null; out.push([r, g, b]); }
          return out;
        };
        const top = read(0), bottom = read(Math.max(0, ih - sh));
        return top && bottom ? { top, bottom } : null;
      } catch (e) { return null; }
    }
    const profAt = (a, u) => { const f = Math.min(a.length - 1, Math.max(0, u * a.length - 0.5)), i = Math.floor(f), j = Math.min(a.length - 1, i + 1), k = f - i; return [0, 1, 2].map(c => a[i][c] + (a[j][c] - a[i][c]) * k); };
    function layoutEdgeGlow(L, w, x0, y0, x1, y1) {
      const none = { top: 0, bottom: 0, beyond: !!opts.glowBeyond, cols: GLOW_COLS };
      if (!glowCv || !glowCtx) return none;
      const beyond = !!opts.glowBeyond, reach = GLOW_REACH * ch;
      const eTop = y0 > 0.5 ? (beyond ? reach : Math.min(reach, y0)) : 0;
      const eBot = beyond ? reach : (ch - y1 > 0.5 ? Math.min(reach, ch - y1) : 0);
      const res = { top: eTop >= 1 ? eTop : 0, bottom: eBot >= 1 ? eBot : 0, beyond, cols: GLOW_COLS };
      if (!edgeProfile || (!res.top && !res.bottom) || !(x1 > x0) || !(y1 > y0)) { css(glowCv, { display: 'none' }); glowKey = ''; return res; }
      const off = beyond ? reach : 0, total = ch + 2 * off, rows = Math.min(GLOW_ROWS_MAX, Math.max(GLOW_ROWS_MIN, Math.round(total / 3)));
      const key = [cw, ch, y0, y1, L.ox, w, rows, beyond, edgeId, res.top, res.bottom].join('|');
      if (key === glowKey) return res;
      glowKey = key;
      try {
        const px = n => (Math.round(n * 100) / 100) + 'px';
        css(glowCv, { display: 'block', left: '0', top: px(-off), width: px(cw), height: px(total) });
        if (glowCv.width !== GLOW_COLS) glowCv.width = GLOW_COLS;
        if (glowCv.height !== rows) glowCv.height = rows;
        const g2 = glowCtx, k = rows / total, inward = Math.max(2, 0.06 * (y1 - y0)), STEPS = 10;
        g2.clearRect(0, 0, GLOW_COLS, rows);
        const ease = s => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, s)));
        const col = (c, a) => 'rgba(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ',' + (Math.round(a * 1000) / 1000) + ')';
        const band = (i, c, edge, dir, ext) => {   // dir -1: outside is above `edge`; 1: below. Opaque inward (the clip's own fade shows this colour), easing to 0 over `ext`
          const far = edge + dir * ext, near = edge - dir * inward, ya = Math.min(far, near) + off, yb = Math.max(far, near) + off;
          const gr = g2.createLinearGradient(0, ya * k, 0, yb * k), span = yb - ya;
          for (let j = 0; j <= STEPS; j++) {
            const y = dir < 0 ? ya + (ext * j) / STEPS : yb - (ext * j) / STEPS, a = ease(j / STEPS), o = (y - ya) / span;   // j = 0 at the far end: alpha 0; j = STEPS at the clip edge: alpha 1
            gr.addColorStop(Math.min(1, Math.max(0, o)), col(c, a));
          }
          if (dir < 0) gr.addColorStop(1, col(c, 1)); else gr.addColorStop(0, col(c, 1));
          g2.fillStyle = gr; g2.fillRect(i, Math.floor(ya * k), 1, Math.ceil(yb * k) - Math.floor(ya * k) + 1);
        };
        for (let i = 0; i < GLOW_COLS; i++) {
          const u = Math.min(1, Math.max(0, ((i + 0.5) / GLOW_COLS * cw - L.ox) / w));
          if (res.top) band(i, profAt(edgeProfile.top, u), y0, -1, res.top);
          if (res.bottom) band(i, profAt(edgeProfile.bottom, u), y1, 1, res.bottom);
        }
      } catch (e) { css(glowCv, { display: 'none' }); glowKey = ''; }   // no canvas support: no glow, nothing else changes
      return res;
    }
    // the safe box (fractions of the picture): the manifest's safeAreaComfort, else safeAreaTypical, else safeArea (each only when valid),
    // else the central safeFrac of the width at full height
    function safeBox() { return (M && (M.safeAreaComfort || M.safeAreaTypical || M.safeArea)) || { x: (1 - safeFrac) / 2, y: 0, w: safeFrac, h: 1 }; }
    function safeSource() { return M && M.safeAreaComfort ? 'comfort' : M && M.safeAreaTypical ? 'typical' : M && M.safeArea ? 'safeArea' : 'fallback'; }
    const narrowStage = () => cw * 9 < ch * 16;   // aspect below 16:9 (portrait, square and 4:3 landscape included)
    function layout(t) {
      // aspect >= 16:9: the whole picture fits (or covers) the view. Narrower (portrait, square, 4:3): the BOX WIDTH is fitted to the view
      // width, capped so the full picture height still fits the view height, and the box centre is put on the view centre (x and y), so
      // whatever lies outside the box is simply outside the view. The poster and the beak use this same transform.
      if (narrowStage()) {
        const b = safeBox(), bw = b.w * t.w, s = Math.min(cw / bw, ch / t.h);
        return { s, ox: cw / 2 - (b.x * t.w + bw / 2) * s, oy: ch / 2 - (b.y * t.h + (b.h * t.h) / 2) * s };
      }
      const sx = cw / t.w, sy = ch / t.h, s = opts.fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
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
      if (!M || !M.beak) return;
      if (holdOn) { drawPatch(patches[beakShape], MASTER.frames[0], MASTER, 1); return; }   // cold speech: the poster is up, the beak is animated on the MASTER transform
      if (coverUp) return;   // no beak over the held still: the clip behind it is not showing yet
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
        const cb = (now, meta) => { id = null;
          if (holdOn && posterUp && !coverUp && !dead && g === gen && slots[front].video === video && !video.paused && trackedFront()) hidePoster();   // only a TRACKED speaking clip releases the speech hold (an untracked idle clip that committed under it must not, same rule as releasePoster)
          if (step(now, meta && meta.mediaTime != null ? meta.mediaTime : video.currentTime)) id = video.requestVideoFrameCallback(cb);
        };
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
        if (!r || r.ok === false) { const e = new Error('HTTP ' + (r && r.status)); e.status = r && r.status; throw e; }
        return r.json();
      });
    }
    // A track that failed in a way that may pass (network error, timeout, 5xx, 429...) is retried at most twice: 5 s, then 20 s, then never again
    // (no tight loop; every retry is a player timer, so destroy() clears it). 404/410 (the file is gone), an unusable body, or a removed pack
    // are final: no retry. A track that loads late clears `degraded` and wakes a waiting speaking state (onTracks).
    function trackFinal(e) { return !!e && (e.status === 404 || e.status === 410 || e.permanent === true); }
    function loadTrack(name) {
      if (tracks[name]) return Promise.resolve(true);
      if (dead || lost || packRemoved || trackGone[name]) return Promise.resolve(false);   // never a request for a destroyed player, a removed pack or a track known absent
      if (trackLoading[name]) return trackLoading[name];
      const p = jget(urls.track(name)).then(j => {
        const t = faceNormalizeTrack(j);
        if (!t) { const e = new Error('bad track'); e.permanent = true; throw e; }
        if (dead) return false;
        tracks[name] = t; trackRetry[name] = TRACK_RETRY_MS.length; degraded = null; onTracks(); return true;
      }).catch(e => {
        delete trackLoading[name];
        if (dead) return false;
        if (trackFinal(e)) trackGone[name] = true; else scheduleTrackRetry(name);
        requestProbe();   // a failed track: is the pack still there? (a verdict only; the retries above go on either way)
        return false;
      });
      trackLoading[name] = p;
      return p;
    }
    function scheduleTrackRetry(name) {
      const n = trackRetry[name] || 0;
      if (dead || lost || packRemoved || tracks[name] || trackGone[name] || n >= TRACK_RETRY_MS.length || trackTimer[name] != null) return;
      trackRetry[name] = n + 1;
      trackTimer[name] = timer(() => { delete trackTimer[name]; if (!dead && !lost && !packRemoved && !tracks[name]) loadTrack(name); }, TRACK_RETRY_MS[n]);
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
      if (!c || c.state !== 'speaking') evaluate();
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
    const isGoodbyeName = m => /^(goodbye|reaction-goodbye(-|$))/.test(m);
    // the video a new start would be loaded into (see loadRec) already holds this clip, loaded
    function speakLoaded(c) { const s = coverUp ? slots[front] : slots[1 - front]; return s.clip === c.name && s.ready && !s.failed; }
    function decide() {
      let sel = null;
      if (state === 'speaking') {   // explicit requirement: a tracked speaking clip now, over pose chaining; no reaction while the reply is audible
        const s = selector.pickSpeakNow(speakLoaded);   // a speaking clip whose video is already loaded wins, even a repeat
        if (s) { s.fast = true; return s; }
      }
      if (pending && state !== 'speaking') {
        const pool = resolveReaction(pending.name);
        sel = pool.length ? selector.pick(state, { react: pool }) : null;
        if (!sel || (sel.kind !== 'reaction' && sel.kind !== 'transition')) { pending = null; sel = null; }
      }
      return sel || selector.pick(state);   // (speaking with no tracked clip loaded yet falls through here: idle fallback until onTracks)
    }
    function next(fade) {
      if (dead || lost || !ready || pausedHidden || reducedActive()) return;
      clearRetry();
      let sel = planned && planned.key === key() ? planned.sel : null;
      planned = null;
      if (!sel) sel = decide();
      // speaking is requested but nothing tracked can play: never an untracked idle/listening/thinking clip under the voice; the poster is
      // held with the animated beak, and the choice is looked at again soon (onTracks asks as well)
      if (coldHold(sel)) { holdLast(); return; }
      if (!sel) { holdLast(); return; }
      begin(sel, fade, 0);
    }
    // true when speech is requested, the pack has a tracked speaking clip, `sel` is not one, and the poster hold is on: then `sel` must not start
    function coldHold(sel) {
      if (state !== 'speaking' || !M || (sel && sel.clip.state === 'speaking' && sel.clip.track)) return false;
      if (!M.clips.some(c => c.state === 'speaking' && c.track)) return false;   // the pack has no tracked speaking clip at all: the old rules apply
      // Every tracked speaking clip failed (all bad): the explicit fallback is the SAME hold, the animated poster beak, for the whole reply, never an
      // untracked clip with a closed mouth. Without a real poster picture enterHold does nothing and the old rules apply.
      enterHold();
      return holdOn;
    }
    // every tracked speaking clip is set aside as failed: the hold is all that is left of speech until a bounded retry revives some
    const speakersDead = () => !!M && !M.clips.some(c => c.state === 'speaking' && c.track && !bad.has(c.name));
    function reviveSpeakers() {   // bounded: at most SPEAK_REVIVE_MAX times per reply, at least SPEAK_REVIVE_MS apart; never while not speaking or not held
      if (lost || packRemoved || !holdOn || state !== 'speaking' || !speakersDead() || reviveTries >= SPEAK_REVIVE_MAX || nowFn() - lastRevive < SPEAK_REVIVE_MS) return;
      reviveTries++; lastRevive = nowFn();
      M.clips.forEach(c => { if (c.state === 'speaking' && c.track) bad.delete(c.name); });
    }
    function holdLast() {   // nothing playable now: the last picture stays; look again soon (bounded, never a tight loop)
      clearRetry();
      if (lost || packRemoved) return;
      retryTimer = timer(() => { retryTimer = null; if (dead || lost || packRemoved) return; reviveSpeakers(); next(true); }, 2500);
    }
    function clearRetry() { untimer(retryTimer); retryTimer = null; }
    // set a clip aside (see badWhy): final for a decode error of its own file, transient otherwise
    function setAside(name, slot) {
      if (!name) return;
      bad.add(name);
      let code = 0; try { code = slot && slot.video && slot.video.error ? Number(slot.video.error.code) || 0 : 0; } catch (e) { code = 0; }
      const w = badWhy.get(name) || { final: false, fails: 0, at: 0 };
      w.fails++; w.at = nowFn(); if (code === 3) w.final = true;
      badWhy.set(name, w);
    }
    // the network is seen working (probe 'exists', or a clip really started): release the transient entries whose wait is over; if the picture is
    // standing still because nothing was playable (holdLast waiting), look again now
    function reviveClips() {
      if (dead || lost || packRemoved || !bad.size) return 0;
      const t = nowFn(); let n = 0;
      badWhy.forEach((w, name) => {
        if (w.final || !bad.has(name) || w.fails > CLIP_REVIVE_MAX) return;
        if (t - w.at < Math.min(CLIP_REVIVE_CAP_MS, CLIP_REVIVE_BASE_MS * Math.pow(3, w.fails - 1))) return;
        bad.delete(name); n++;
      });
      if (n) { clipRevivals += n; log.push({ t, ev: 'revive', n }); if (retryTimer !== null && ready && !pausedHidden && !reducedActive()) { clearRetry(); next(true); } }
      return n;
    }
    function begin(sel, fade, depth) {
      if (lost || packRemoved) return;
      const tok = ++startToken; starting = tok;
      const clip = sel.clip; startingSpeak = clip.state === 'speaking';
      if (busyUntil > nowFn()) finishFade();   // a request inside the 250 ms fade ends it now (never waits: hello yields at once)
      const rec = loadRec(clip);
      const fail = () => {
        if (tok !== startToken) return;
        setAside(clip.name, rec); planned = null; requestProbe();
        if (depth > 6) { holdLast(); return; }
        const s2 = decide();
        if (!s2 || coldHold(s2)) { holdLast(); return; }
        begin(s2, fade, depth + 1);
      };
      if (rec.failed) { fail(); return; }
      if (rec.ready) { commit(sel, rec, fade, tok); return; }
      if (sel.fast && state === 'speaking') enterHold();   // cold: the tracked video is still loading, the poster and beak cover the wait
      rec.waiters.push(() => { if (tok !== startToken || dead) return; if (rec.failed) fail(); else commit(sel, rec, fade, tok); });
      untimer(loadTimer); loadTimer = timer(() => { loadTimer = null; if (tok === startToken && !rec.ready) fail(); }, 8000);
    }
    function commit(sel, slot, fade, tok) {
      if (tok !== startToken || dead || pausedHidden || reducedActive()) return;
      starting = 0; untimer(loadTimer); loadTimer = null;
      reviveClips();   // a clip really loaded: the network works, transient set-asides whose wait is over may be tried again
      const clip = sel.clip, cur = slots[front], nxt = slot, prevClip = selector.state.current;
      const rehold = coverUp;   // a second start while the first is still held: the still stays, the new clip replaces the one under it
      const hold = stillUp || rehold;   // the first clip: the still stays on top until this video is really playing
      gen++;
      const myGen = gen;
      // A cold poster keeps its MASTER beak until hidePoster confirms the video frame is visible.
      // and the poster shields this switch, so the speaking video goes opaque at once (no fade: the old untracked video must never bleed through when the poster goes).
      if (holdOn && posterUp) fade = false;
      // Warm speech (sel.fast) keeps 120 ms; every reaction/goodbye, and any cut between differing poses, uses the one consistent 70 ms
      // cross-fade (short enough that the old pose cannot ghost through); other same-pose changes keep 250 ms.
      const shortFade = !sel.fast && (clip.state === 'reaction' || (!!prevClip && prevClip.endsOn !== clip.startsFrom));
      const fms = sel.fast ? SPEAK_FADE_MS : shortFade ? REACT_FADE_MS : FADE_MS, gms = sel.fast ? SPEAK_FADE_MS + 10 : shortFade ? REACT_FADE_MS + 10 : FADE_GUARD_MS;
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
        css(nxt.video, { transition: fade ? 'opacity ' + fms + 'ms linear' : 'none', opacity: '1', zIndex: '2' });
        css(cur.video, { zIndex: '1' });
        fadeTimer = timer(() => { fadeTimer = null; if (slots[front] !== cur) { try { cur.video.pause(); } catch (e) { /* ignore */ } css(cur.video, { opacity: '0' }); } }, fade ? gms : 30);
      }
      if (!rehold) front = 1 - front;
      selector.commit(sel);   // before releasePoster: a browser without frame callbacks decides at once and must see the new front AND the new (tracked) current clip
      if (!hold && posterUp) releasePoster(nxt);
      if (sel.kind === 'reaction' && pending) pending = null;
      busyUntil = nowFn() + (fade ? gms : 30);
      let lat = null;
      if (clip.state === 'speaking' && speakAsk != null) { lat = Math.round(nowFn() - speakAsk); speakAsk = null; speakLatency = lat; }   // the honest time from setState('speaking') to the tracked clip taking over
      V = { clip, frame: 0, blendFrom: prevClip && prevClip.beakEnds !== clip.beakEnds ? prevClip.beakEnds : null };
      if (V.blendFrom === 'closed' && clip.track) V.blendFrom = null;
      log.push({ t: Math.round(nowFn()), name: clip.name, state: clip.state, kind: sel.kind, pose: selector.state.pose, fade: !!fade, ms: fade ? fms : 0, latency: lat });
      if (log.length > 400) log.shift();
      draw();
      watch(nxt.video, clip, myGen);
      untimer(watchdog);
      watchdog = timer(() => { watchdog = null; if (myGen === gen) clipEnded(); }, clip.dur * 1000 / rate + 1500);
      if (!bgGiven && !bgSampled) { bgSampled = true; sampleBackground(nxt.video); }
      untimer(planTimer);
      planTimer = timer(() => { planTimer = null; planAhead(); }, (fade ? gms : 30) + 40);
    }
    function armCover() { untimer(coverTimer); coverTimer = timer(coverCheck, COVER_MAX_MS); }
    function coverCheck() {   // still no playing event: the still is NOT given up. Ask the clip to play again (bounded); events still release it
      coverTimer = null;
      if (!coverUp) return;
      if (++coverTries >= COVER_TRIES) { log.push({ t: Math.round(nowFn()), name: slots[front].clip, kind: 'cover-stalled' }); return; }   // stop polling, keep the still; a late playing event or gesture releases it
      playVideo(slots[front].video); armCover();
    }
    function coverFail(slot) {   // the held first clip errored: set it aside, try another under the same still
      setAside(slot.clip, slot); planned = null; requestProbe(); untimer(watchdog); watchdog = null; untimer(coverTimer); coverTimer = null;
      next(false);
    }
    function uncover() {   // the clip is really playing: it takes the front, the still is hidden and paused
      if (!coverUp) return;
      coverUp = false; stillUp = false; untimer(coverTimer); coverTimer = null;
      untimer(planTimer); planTimer = timer(() => { planTimer = null; planAhead(); }, 70);
      const old = slots[1 - front];
      try { old.video.pause(); } catch (e) { /* ignore */ }
      css(old.video, { opacity: '0', transition: 'none', zIndex: '1' }); css(slots[front].video, { opacity: '1', transition: 'none', zIndex: '2' });
      // speech was asked for before the first uncover and no tracked clip is in front yet: the poster must not go (it would be put back at once)
      if (state === 'speaking' && !holdOn && !trackedFront() && !reducedActive() && !pausedHidden) { enterHold(); if (holdOn && starting !== startToken && retryTimer == null) next(false); }
      releasePoster(slots[front]);
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
      if (dead || lost || packRemoved || !ready || pausedHidden || reducedActive() || starting === startToken || coverUp) return;   // never into the slot the held still sits in
      const sel = decide(); planned = sel ? { sel, key: key() } : null;
      if (sel) { const r = loadRec(sel.clip); if (r.failed) { setAside(sel.clip.name, r); planned = null; } }
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
    // Estimate the on-screen pose: use a pose-changing clip's start pose before its midpoint and its end pose afterward
    // (selector.state.pose already holds the END pose from the moment such a clip is committed, which is not what the person sees).
    function onscreenPose() {
      const c = selector.state.current;
      if (!c) return selector.state.pose;
      if (!poseChanging(c)) return c.endsOn;
      const v = slots[front].video, total = isFinite(v.duration) && v.duration > 0 ? v.duration : c.dur;
      return total - leftOf(slots[front], c) < total / 2 ? c.startsFrom : c.endsOn;
    }
    // The goodbye to cut to: a clip of the on-screen pose family (starts on that pose) first, else any available goodbye; inside each
    // group prefer loaded video (no wait), then use the normal seeded weighted choice and history rules.
    function pickGoodbye(pool) {
      const avail = pool.filter(c => !bad.has(c.name));
      const on = onscreenPose();
      const loaded = c => slots.some(s => s.clip === c.name && s.ready && !s.failed);
      const last = selector.state.recent[selector.state.recent.length - 1];
      // order: LOADED of the on-screen pose, LOADED of the other pose (a pose jump beats waiting), then unloaded of the pose, then any unloaded
      const match = avail.filter(c => c.startsFrom === on), other = avail.filter(c => c.startsFrom !== on);
      for (const set of [match.filter(loaded), other.filter(loaded), match, other]) {
        if (!set.length) continue;
        const r = selector.choose(set, 'reaction', 'reaction');   // the normal seeded weighted pick (recent/family avoidance included)
        return r ? r.clip : (set.find(c => c.name !== last) || set[0]);
      }
      return null;
    }
    function evaluate() {
      if (dead || !ready || pausedHidden || reducedActive()) return;
      const c = selector.state.current;
      // a speaking clip still loading (cold) for a reply that is no longer there: it must not start later under silence
      if (starting === startToken && startingSpeak && state !== 'speaking') { startToken++; starting = 0; untimer(loadTimer); loadTimer = null; }
      if (!c) { next(false); return; }
      // the front clip ended and nothing could start (a held poster, the retry timer, or the cancelled cold start above): a state change starts
      // its clip NOW instead of leaving the poster up until the 2.5 s retry (e.g. listening after a speech hold)
      if (retryTimer != null || endedFor === gen) { next(false); return; }
      // speaking is explicit: it cuts whatever plays (idle, listening, thinking, a pose-changing clip, a reaction, pose B, nearly over) and
      // cross-fades in 120 ms; only when no tracked speaking clip is loaded yet does the old rule apply (onTracks asks again when one arrives)
      if (state === 'speaking' && c.state !== 'speaking') {
        if (selector.canSpeak()) { next(true); return; }
        if (coldHold(null)) { holdLast(); return; }   // the pack has tracked speaking clips but none is loaded yet: poster and beak, retried
      }
      if (!cuttable(c)) return;
      if (c.state === state && !isHello(c)) return;
      if (!isHello(c) && leftOf(slots[front], c) <= END_WAIT_S) return;   // nearly over: let it end
      next(true);
    }

    // ── background colour ──
    // The average colour of the outer ring (two pixels of a 32x18 copy) of a drawable (a video frame or the decoded poster); '' when it cannot be read.
    function ringColor(src) {
      try {
        const cv = doc.createElement('canvas'); cv.width = 32; cv.height = 18;
        const c2 = cv.getContext('2d'); c2.drawImage(src, 0, 0, 32, 18);
        const d = c2.getImageData(0, 0, 32, 18).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = 0; y < 18; y++) for (let x = 0; x < 32; x++) {
          if (x > 1 && x < 30 && y > 1 && y < 16) continue;   // the outer two pixels only
          const i = (y * 32 + x) * 4; r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
        }
        if (!n) return '';
        const q = [r, g, b].map(v => Math.round(v / n));
        return q.every(v => isFinite(v) && v >= 0 && v <= 255) ? 'rgb(' + q[0] + ',' + q[1] + ',' + q[2] + ')' : '';
      } catch (e) { return ''; }   // keep the fallback colour
    }
    function useBackground(c) {   // one colour for the player and (through opts.onBackground) for the host's own stage; a throwing host cannot break the player
      if (!c || dead) return;
      bgColor = c; css(rootEl, { background: c });
      if (typeof opts.onBackground === 'function') { try { opts.onBackground(c); } catch (e) { /* host callback */ } }
    }
    function sampleBackground(video) { useBackground(ringColor(video)); }
    // The poster's own outer ring is the background (it wins over the manifest colour and over a video frame), sampled ONCE when the poster is decoded and
    // painted, i.e. before the first picture is reported: the colour never changes afterwards, so there is no flash and nothing stale to undo.
    function samplePosterBackground() {
      if (posterBgDone || dead || !posterImg) return;
      posterBgDone = true;
      const c = ringColor(posterImg);
      if (c) {
        bgGiven = true; useBackground(c);
        edgeProfile = poster ? sampleEdgeRows(poster) : null;   // the top / bottom edge rows, once, read from the poster canvas just painted (no second decode or image draw)
        if (edgeProfile) { edgeId++; applyStage(); }
      }
    }

    // ── poster: the decoded first frame of the pack copied into a canvas that sits above both videos (same picture rectangle, same
    // feathered stage). It does not depend on the compositor having painted a <video>. It is held until the clip in front is playing AND
    // has presented a frame (requestVideoFrameCallback; bounded by FRAME_WAIT_MS where there is none), then removed. ──
    // Paints the poster canvas: the pack's poster image when it loaded, else the actual decoded frame of `v`. True only when something
    // real was painted (a video with no decoded frame yet gives false: the caller must not claim a picture then).
    function capturePoster(v) {
      if (!poster || !pctx) return false;
      let done = false;
      if (posterImg && posterImg.naturalWidth > 0 && posterImg.naturalHeight > 0) {
        try {
          const iw = posterImg.naturalWidth, ih = posterImg.naturalHeight;
          if (poster.width !== iw) poster.width = iw;
          if (poster.height !== ih) poster.height = ih;
          pctx.clearRect(0, 0, iw, ih); pctx.drawImage(posterImg, 0, 0, iw, ih); done = true;
        } catch (e) { done = false; }
        if (done) samplePosterBackground();
      }
      if (!done) {
        try {
          const vw = v && v.videoWidth, vh = v && v.videoHeight;
          if (!(vw > 0 && vh > 0)) return false;
          if (poster.width !== vw) poster.width = vw;
          if (poster.height !== vh) poster.height = vh;
          pctx.clearRect(0, 0, vw, vh); pctx.drawImage(v, 0, 0, vw, vh);
        } catch (e) { return false; }
      }
      css(poster, { display: 'block' }); posterUp = true; posterReal = true;
      return true;
    }
    // Cold speech: speaking was asked for but no tracked speaking video can be shown yet. The picture never stays on an untracked
    // (idle, listening, thinking) clip whose mouth would be frozen: the poster (the pack's A-pose picture, same transform as the master) goes up
    // at once and the beak is drawn over it, animated from the voice, at the MASTER position until a tracked speaking clip is committed.
    // Without a real poster picture nothing can be held (honest: the old picture stays) and holdOn stays false.
    function enterHold() {
      if (dead || holdOn || reducedActive() || pausedHidden || !poster || !posterReal || !M || !M.beak) return;
      holdOn = true;
      cancelWatch();
      css(poster, { display: 'block' }); posterUp = true;
      if (posterCancel) posterCancel();
      coldHolds++;
      const tick = now => { holdRaf = null; if (dead || !holdOn) return; beakShape = beakNow(now); draw(); holdRaf = rafFn(tick); };
      holdRaf = rafFn(tick);
      beakShape = beakNow(nowFn()); draw();
    }
    function trackedFront() { const c = selector && selector.state.current; return !!c && c.state === 'speaking' && !!c.track; }
    function stopHold() { holdOn = false; if (holdRaf != null) { cafFn(holdRaf); holdRaf = null; } }
    function endHold() {   // the reply is over (or the state changed) while still held: the poster goes once the clip in front is playing
      if (!holdOn) return;
      stopHold();
      if (posterUp && !coverUp && slots[front] && !reducedActive()) releasePoster(slots[front]);
    }
    function loadPoster(path) {   // the poster image: settles true (decoded) or false (missing, invalid, slow, destroyed); never rejects, never hangs
      return new Promise(res => {
        const url = dead ? null : urls.poster(path);
        if (!url) { res(false); return; }
        const im = doc.createElement('img'), w = { done: false }; let tm = null;
        const finish = ok => {
          if (w.done) return; w.done = true; patchWaits.delete(w); untimer(tm);
          im.onload = null; im.onerror = null;
          if (ok && !dead) posterImg = im;
          res(ok && !dead);
        };
        w.cancel = () => finish(false);
        patchWaits.add(w);
        tm = timer(() => finish(false), POSTER_WAIT_MS);   // shorter than STILL_WAIT_MS: a slow poster still leaves the still its own time to show the video frame
        im.onload = () => {
          if (!(im.naturalWidth > 0 && im.naturalHeight > 0)) { finish(false); return; }
          if (typeof im.decode === 'function') { try { Promise.resolve(im.decode()).then(() => finish(true), () => finish(false)); } catch (e) { finish(false); } } else finish(true);
        };
        im.onerror = () => finish(false);
        im.src = url;
      });
    }
    function hidePoster() {
      if (posterCancel) posterCancel();
      if (poster) css(poster, { display: 'none' });
      posterUp = false;
      stopHold();
      draw();
    }
    function releasePoster(slot) {   // the poster goes once `slot` has really presented a frame while playing; a newer release or a destroy cancels this one
      if (!posterUp) return;
      if (posterCancel) posterCancel();
      const v = slot.video, g = slot.gen; let ft = null, off = false;
      // only the front video, playing, of the same load, and not while the held still is still covering (uncover() releases it then);
      // a release that finds the video paused (hidden, reduced motion) leaves the poster up, and the next release request takes it
      // a speech hold keeps the poster until a TRACKED speaking clip is in front (an untracked one going up under it must not hide it, only to bring it back)
      const done = () => { if (off) return; off = true; untimer(ft); posterCancel = null; if (!dead && !coverUp && slots[front] === slot && slot.gen === g && !v.paused && !(holdOn && !trackedFront())) hidePoster(); };
      posterCancel = () => { off = true; untimer(ft); posterCancel = null; };
      if (typeof v.requestVideoFrameCallback === 'function') {
        ft = timer(done, FRAME_WAIT_MS);
        try { v.requestVideoFrameCallback(() => { if (!off) done(); }); } catch (e) { /* the bounded timer releases it */ }
      } else done();
    }

    // ── reduced motion: a still pose plus the beak only ──
    function enterReduced() {
      startToken++; gen++; planned = null; cancelWatch(); clearRetry(); stopHold();
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
    // The picture counts as there (drawable) only once the browser has decoded AND presented its first frame (requestVideoFrameCallback,
    // bounded by FRAME_WAIT_MS where the browser has none), not merely when loadeddata fired. A candidate that errors is set aside and
    // the next one tried (at most 3); a slow one ends the wait after STILL_WAIT_MS with drawable still false: ready then resolves, the
    // first clip plays into the other video, and `drawable` turns true when a video is really playing in front.
    function loadStill(tries) {
      const cand = dead ? null : stillCandidate();
      if (!cand) return Promise.resolve(false);
      return new Promise(res => {
        const slot = slots[front]; let done = false, tm = null, ft = null;
        const fin = ok => { if (done) return; done = true; untimer(tm); untimer(ft); stillCancel = null; res(ok); };
        stillCancel = () => fin(false);
        tm = timer(() => fin(false), STILL_WAIT_MS);
        setSource(slot, cand.name);
        const g = slot.gen;
        slot.waiters.push(() => {
          if (dead || slot.gen !== g || done) { fin(false); return; }
          if (slot.failed) {
            setAside(cand.name, slot);
            if (done) return;
            done = true; untimer(tm); untimer(ft); stillCancel = null;
            res((tries || 0) < 2 ? loadStill((tries || 0) + 1) : false);
            return;
          }
          const v = slot.video;
          try { v.currentTime = 0; v.pause(); } catch (e) { /* ignore */ }
          css(v, { opacity: '1', transition: 'none', zIndex: '2' });
          // `presented`: the browser reported a presented frame. A picture is claimed (drawable) only when something real was painted
          // (the pack's poster image or a decoded frame copied into the canvas), or the video itself has decoded dimensions and presented.
          const paint = presented => {
            if (done) return;
            if (dead || slot.gen !== g) { fin(false); return; }
            const ok = capturePoster(v);
            stillUp = true; drawable = ok || (presented && v.videoWidth > 0 && v.videoHeight > 0);
            if (!bgGiven && !bgSampled) { bgSampled = true; sampleBackground(v); }
            fin(true);
          };
          // the poster image (when the manifest names one) is waited for first (bounded by its own timer), so it is the picture shown
          const show = presented => { if (posterPending) posterPending.then(() => paint(presented)); else paint(presented); };
          if (typeof v.requestVideoFrameCallback === 'function') {
            ft = timer(() => show(false), FRAME_WAIT_MS);
            try { v.requestVideoFrameCallback(() => { if (!done && ft != null) { untimer(ft); ft = null; show(true); } }); } catch (e) { /* the bounded timer shows it */ }
          } else show(false);
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
        stillReady = true; drawable = capturePoster(slot.video);   // no false claim: only a really painted picture counts
        if (!bgGiven && !bgSampled) { bgSampled = true; sampleBackground(slot.video); }
        draw();
      };
      if (slot.clip === cand.name && slot.ready && !slot.failed) { shown(); return; }
      setSource(slot, cand.name);
      const myGen = slot.gen;
      slot.waiters.push(() => {
        if (dead || !reducedActive() || slots[front] !== slot || slot.gen !== myGen) return;   // a late load of an earlier choice does nothing
        if (slot.failed) { setAside(cand.name, slot); showStill(); return; }                         // set aside, the next candidate (bounded: a transient entry comes back only through reviveClips)
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
      pausedHidden = true; startToken++; pauseProbe(); cancelWatch(); clearRetry(); stopHold(); untimer(loadTimer); loadTimer = null;
      untimer(watchdog); watchdog = null;
      if (reducedRaf != null) { cafFn(reducedRaf); reducedRaf = null; }
      slots.forEach(s => { try { s.video.pause(); } catch (e) { /* ignore */ } });
    }
    function onVisible() {
      pausedHidden = false;
      if (!ready) return;
      if (probeOn && !probeTimer && !probing) probeNow();   // back on screen: check the pack at once
      if (reducedActive()) { reducedLoop(); return; }
      const c = selector.state.current, s = slots[front];
      if (!c || leftOf(s, c) <= 0.1) { next(false); return; }
      gen++;
      const myGen = gen;
      playVideo(s.video); watch(s.video, c, myGen);
      if (posterUp && !coverUp) releasePoster(s);   // a release that found the video paused while hidden is taken up again now
      watchdog = timer(() => { watchdog = null; if (myGen === gen) clipEnded(); }, leftOf(s, c) * 1000 + 1500);
      evaluate();
    }

    // ── the background cache: starters first, the rest at low priority and bounded; never waited for ──
    // Mobile data cap: a metered or slow link (cellular, data saver, 2g/3g) never gets speculative downloads; on-demand playback loads as usual.
    function dataCapped() {
      try {
        const nav = opts.navigator || (win && win.navigator) || (typeof navigator !== 'undefined' ? navigator : null);
        const c = nav && (nav.connection || nav.mozConnection || nav.webkitConnection);
        if (!c || typeof c !== 'object') return false;
        return c.type === 'cellular' || c.saveData === true || c.effectiveType === 'slow-2g' || c.effectiveType === '2g' || c.effectiveType === '3g';
      } catch (e) { return false; }
    }
    function startWarm() {
      if (!fetchFn || !M || lost || packRemoved) return;
      if (dataCapped()) { warmCapped = true; return; }
      const by = st => M.clips.filter(c => c.state === st);
      // the tracked speaking clips come first (3 of them): speech is the one state that must never wait for a cold download
      const starters = [].concat(
        by('speaking').filter(c => c.track).slice(0, 3), M.clips.filter(c => isHello(c)).slice(0, 1), by('idle').slice(0, 3), by('listening').slice(0, 2), by('thinking').slice(0, 1),
        // one goodbye per start pose (A and B), so the cut to a goodbye of the on-screen pose is warm in either pose
        M.clips.filter(c => c.state === 'reaction' && (c.mood === 'goodbye' || /^reaction-goodbye/.test(c.name))).filter((c, i, a) => a.findIndex(x => x.startsFrom === c.startsFrom) === i));
      const seen = new Set(starters.map(c => c.name)), rest = [];
      const lanes = ['idle', 'listening', 'thinking', 'speaking', 'reaction'].map(st => by(st).filter(c => !seen.has(c.name)));
      for (let i = 0; lanes.some(l => i < l.length); i++) lanes.forEach(l => { if (i < l.length) rest.push(l[i]); });
      const list = starters.concat(rest).map(c => c.name);
      let idx = 0, active = 0, count = 0, bytes = 0;
      const pump = () => {
        while (!dead && !lost && !packRemoved && active < warmConc && idx < list.length && count < warmLimit && bytes < warmBytes) {
          const n = list[idx++];
          if (slots.some(s => s.clip === n) || bad.has(n)) continue;
          active++; count++;
          const low = idx > starters.length;
          Promise.resolve(fetchFn(urls.clip(n), { credentials: 'same-origin', priority: low ? 'low' : 'auto', signal: abort ? abort.signal : undefined }))
            .then(r => { if (r && r.ok === false) requestProbe(); return r && r.ok !== false && r.arrayBuffer ? r.arrayBuffer() : null; })
            .then(b => { if (b && b.byteLength) bytes += b.byteLength; }, () => { if (!dead) requestProbe(); })   // only the size is kept: the bytes are dropped at once; a failed fetch only asks for a probe
            .then(() => { active--; if (!dead && !lost && !packRemoved) timer(pump, low ? 120 : 0); });
        }
      };
      pump();
      // every remaining speaking track (small files), two at a time
      const rem = M.clips.filter(c => c.track && !tracks[c.name] && !trackGone[c.name] && trackTimer[c.name] == null && !packRemoved && !lost).map(c => c.name);   // one that just failed has its own bounded retry (or is absent): no second request now
      let ti = 0;
      const tpump = () => { if (dead || lost || packRemoved || ti >= rem.length) return; const n = rem[ti++]; loadTrack(n).then(() => { if (!dead && !lost && !packRemoved) timer(tpump, 30); }); };
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
      glowCv = doc.createElement('canvas');   // the glow layer: behind the clip stage (z-index), filled by layoutEdgeGlow
      css(glowCv, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', display: 'none', zIndex: '0', pointerEvents: 'none' });   // z 0 under the stage's z 1; appended after the stage so the stage stays the first child
      if (glowCv.setAttribute) glowCv.setAttribute('aria-hidden', 'true');
      try { glowCtx = glowCv.getContext && glowCv.getContext('2d'); } catch (e) { glowCtx = null; }
      if (opts.glowBeyond) css(rootEl, { overflow: 'visible' });
      stage = doc.createElement('div');
      const ramp = (d, f) => 'linear-gradient(to ' + d + ', transparent 0%, #000 ' + (f * 100) + '%, #000 ' + (100 - f * 100) + '%, transparent 100%)';
      const mask = ramp('right', FEATHER) + ', ' + ramp('bottom', FEATHER_Y);
      css(stage, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', overflow: 'hidden', pointerEvents: 'none',
        maskImage: mask, webkitMaskImage: mask, maskComposite: 'intersect', webkitMaskComposite: 'source-in', zIndex: '1' });
      poster = doc.createElement('canvas');
      css(poster, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', display: 'none', zIndex: '3', pointerEvents: 'none' });
      if (poster.setAttribute) poster.setAttribute('aria-hidden', 'true');
      try { pctx = poster.getContext && poster.getContext('2d'); } catch (e) { pctx = null; }
      stage.appendChild(slots[0].video); stage.appendChild(slots[1].video); stage.appendChild(poster);
      rootEl.appendChild(stage); rootEl.appendChild(glowCv); rootEl.appendChild(canvas);
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
      // Only the MANIFEST request answering 404/410 says the pack is gone: that rejection is tagged packGone (a 404 of any other asset, a track,
      // a patch, a clip or the poster, never carries the tag and is never a removal).
      const pm = opts.manifest ? Promise.resolve(opts.manifest) : jget(urls.manifest()).catch(e => { if (e && (e.status === 404 || e.status === 410)) e.packGone = true; throw e; });
      return pm.then(raw => {
        const m = faceNormalizeManifest(raw);
        if (!m || !m.clips.length) throw new Error('unusable manifest');
        M = m;
        applyStage();   // the manifest's safeArea (if any) is known only now: lay the stage out again before anything is shown
        if (M.background) { bgGiven = true; css(rootEl, { background: M.background }); }
        selector = faceCreateSelector(M.clips, { random: rng, now: nowFn, ok: c => !bad.has(c.name) && (!c.track || !!tracks[c.name]) });
        const speak = M.clips.filter(c => c.track);
        // a pack whose clips carry a beak track must bring a complete beak: the five speaking shapes (and the smile) all have to load,
        // otherwise speaking would be a talking character without a visible beak
        if (speak.length && (!M.beak || SHAPES5.some(n => M.beak.shapes.indexOf(n) < 0))) throw new Error('the pack has beak tracks but no complete beak (closed, slight, half, wide, oo)');
        const names = M.beak ? Array.from(new Set(M.beak.shapes.concat([M.beak.smile]))) : [];
        const firstTracks = speak.slice(0, 2).map(c => loadTrack(c.name));
        // the poster image (optional) loads beside the rest; a missing, invalid or failing one changes nothing: the actual frame is the fallback
        posterPending = M.poster ? loadPoster(M.poster).then(ok => { posterPending = null; return ok; }) : null;
        const pp = posterPending;
        // The poster goes first: no clip (video) request starts before it has loaded. Once the real poster picture is painted the pack is
        // drawable and ready never waits for a clip; only when there is no poster, or it failed or was too slow, is a still video loaded for the first picture.
        const first = pp ? pp.then(ok => (dead ? false : ok && capturePoster(null) ? (stillUp = true, drawable = true, true) : loadStill())) : loadStill();
        // pictureReady settles as soon as the first picture is settled (the poster painted, or the still decided), never waiting for patches or tracks
        const firstP = first.then(ok => { settlePicture(!dead && ok && drawable && (posterUp || stillUp)); return ok; }, () => { settlePicture(false); return false; });
        return Promise.all([Promise.all(names.map(loadPatch)), Promise.all(firstTracks), firstP]).then(r => ({ names, patchOk: r[0], trackOk: r[1], speak }));
      }).then(r => {
        if (dead) return player;
        // no still video could be shown, but the pack's poster image is there: it is a real picture of the pack (released once a clip presents)
        if (!stillUp && !drawable && posterImg && capturePoster(null)) drawable = true;
        const miss = r.names.filter((n, i) => !r.patchOk[i]);
        if (miss.length) throw new Error('beak patch could not be loaded: ' + miss.join(', '));
        if (r.speak.length && !r.trackOk.some(Boolean)) {
          // every first speaking track failed (HTTP or decode). With the complete beak and the pack's own decoded poster image the pack is still usable: speech is
          // the poster hold with the animated beak (see coldHold), reported honestly through getInfo().degraded. Without a real picture it is a failure.
          if (!(posterImg && posterReal && drawable)) throw new Error('no speaking track could be loaded');
          degraded = 'no speaking track could be loaded';
        }
        ready = true; startProbe();
        if (reducedActive()) enterReduced(); else if (!pausedHidden) next(false);
        if (earlyReact) { const n = earlyReact; earlyReact = null; if (!(state !== 'idle' && isHelloName(n))) api.react(n); }
        warmSoon(0);
        return player;
      });
    }
    // The background cache starts after the first picture AND after a waiting hello has its clip loading (a slow link must not share
    // its bandwidth with the cache first); bounded, so the cache always starts.
    function warmSoon(n) {
      if (dead || lost || packRemoved) return;   // a lost or removed pack starts no background request, even one already waiting on this timer
      if (n < 40 && ((pending && pending.hello) || (earlyReact && isHelloName(earlyReact)))) { timer(() => warmSoon(n + 1), 100); return; }
      startWarm();
    }

    // ── the interface ──
    const api = {
      setState(s) {
        if (dead || STATES.indexOf(s) < 0) return false;
        const changed = s !== state;
        const hello = ready && !!selector.state.current && isHello(selector.state.current) && !reducedActive();
        state = s;
        if (changed) { reviveTries = 0; lastRevive = -Infinity; }   // a new reply gets its own bounded retries
        if (changed && s === 'speaking') {
          speakAsk = nowFn();
          if (pending && !isGoodbyeName(pending.name)) pending = null;           // no mood reaction over the audible reply (a goodbye waits for it to end)
          if (earlyReact && !isGoodbyeName(earlyReact)) earlyReact = null;
        } else if (changed) speakAsk = null;
        if (changed && s !== 'speaking') { synth.on = false; endHold(); closeBeakNow(); }
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
        if (state === 'speaking') {   // the clip exists but a reaction never plays while the reply is audible: dropped, not queued (a goodbye waits for the reply to end, never cuts it)
          if (isGoodbyeName(m)) { pending = { name: m, hello: false }; invalidatePlan(); }
          return true;
        }
        pending = { name: m, hello: m === 'hello' || pool.every(c => isHello(c)) };
        invalidatePlan();
        const c = selector.state.current;
        if (!c) { next(false); return true; }
        if (isGoodbyeName(m) && !pausedHidden) {
          // A goodbye cuts whatever plays (a pose-changing clip, a reaction, pose B, a long clip) at once and never waits for it to end: the clip of the
          // on-screen pose family, cross-faded in 70 ms over the old picture (the old video stays under it, so there is never a blank frame).
          if (isGoodbyeName(c.name) || c.mood === 'goodbye') return true;   // a goodbye is already showing: it plays on
          const g = pickGoodbye(pool);
          if (g) { begin({ clip: g, hkey: 'reaction', kind: 'reaction' }, true, 0); return true; }
        }
        if (poseChanging(c) || (c.state === 'reaction' && !(isHello(c) && state !== 'idle'))) return true;   // finishes first, the reaction follows
        if (leftOf(slots[front], c) <= END_WAIT_S) return true;
        next(true);
        return true;
      },
      // A mood reaction that was asked for and has not started yet (waiting for the pack, or for the playing clip to finish) is dropped; one
      // already playing finishes. A hello or goodbye is never touched. True when something was dropped.
      cancelReaction() {
        if (dead) return false;
        let did = false;
        if (pending && !pending.hello && !/^(goodbye|reaction-goodbye(-|$))/.test(pending.name)) { pending = null; invalidatePlan(); did = true; }
        if (earlyReact && !isHelloName(earlyReact) && !/^(goodbye|reaction-goodbye(-|$))/.test(earlyReact)) { earlyReact = null; did = true; }
        return did;
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
      // Integration hook (for the caller that learns the pack was deleted, e.g. a 404 on its manifest): stops every track retry and clip
      // revival for good. The player itself keeps showing what it has; the caller decides to destroy it. Returns false when already dead/removed.
      packRemoved() {
        if (dead || packRemoved) return false;
        packRemoved = true; stopProbe();
        Object.keys(trackTimer).forEach(n => { untimer(trackTimer[n]); delete trackTimer[n]; });
        return true;
      },
      setReducedMotion(b) { const was = reduced(); reducedForce = typeof b === 'boolean' ? b : null; if (!dead) applyReduced(was); },
      // resize(): measure the container NOW and lay the picture out for it. The host calls it right after putting the player in the page, so
      // the first layout never waits for the ResizeObserver callback (a player built in a detached host measured the 640x360 fallback).
      resize() { if (dead) return; measure(); draw(); },
      getInfo() {
        const c = selector && selector.state.current;
        return { state, ready, failed: failed ? String(failed.message || failed) : null, lost, clip: c ? c.name : null, pose: selector ? selector.state.pose : 'A', front, shape: beakShape,
          reduced: reduced(), hidden: pausedHidden, destroyed: dead, pending: pending ? pending.name : null, w: cw, h: ch, dpr, canvasW: canvas ? canvas.width : 0, canvasH: canvas ? canvas.height : 0,
          helloWaiting: !!(pending && pending.hello) || (!ready && !!earlyReact && isHelloName(earlyReact)), helloPlaying: !!c && isHello(c) && !reducedActive(),
          speakLatency, coldHold: holdOn, coldHolds, covered: coverUp, still: stillUp, poster: posterUp, posterImage: !!posterImg, background: bgColor, drawable, degraded, warmCapped, stage: stageRect ? Object.assign({}, stageRect) : null, tracks: Object.keys(tracks).length, trackRetries: Object.keys(trackTimer).length, trackGone: Object.keys(trackGone), packRemoved, probes: probeCount, probeVerdict, bad: Array.from(bad), badFinal: Array.from(badWhy).filter(e => e[1].final).map(e => e[0]), clipRevivals, log: log.slice() };
      },
      destroy() {
        if (dead) return;
        dead = true; startToken++; gen++; stopProbe();
        cancelWatch(); stopHold();
        live.forEach(t => clearT(t)); live.clear();
        watchdog = retryTimer = fadeTimer = planTimer = loadTimer = null;
        Array.from(patchWaits).forEach(w => w.cancel());
        if (stillCancel) stillCancel();
        if (posterCancel) posterCancel();
        posterPending = null; posterImg = null; settlePicture(false);
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
        analyser = null; planned = null; pending = null; earlyReact = null; edgeProfile = null; glowKey = ''; glowCtx = null;
      },
    };
    const player = api;

    // pictureReady: resolves true as soon as a real picture of the pack (the poster image or a decoded frame) is painted; false when there is
    // none (failed, too slow, pack unusable, destroyed). Never rejects, never waits for beak patches or speaking tracks. `ready` keeps its meaning.
    api.pictureReady = new Promise(res => { pictureSettle = res; });
    api.ready = new Promise((resolve, reject) => {
      try {
        const id = opts.packId;
        if (!opts.manifest && !(typeof id === 'string' && PACK_RE.test(id))) throw new Error('invalid pack id');
        urls = faceUrls(typeof id === 'string' && PACK_RE.test(id) ? id : '_');
        init();
        boot().then(resolve, e => { failed = e; settlePicture(false); reject(e); });
      } catch (e) { failed = e; settlePicture(false); reject(e); }
    });
    api.ready.catch(() => {});   // a failed pack is reported by `ready` and getInfo(); never an unhandled rejection
    return api;
  }

  return { createFacePlayer, faceCreateSelector, faceCreateBeak, faceNormalizeManifest, faceNormalizeTrack, faceRng, faceUrls };
});
