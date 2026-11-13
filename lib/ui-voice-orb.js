'use strict';
/**
 * ui-voice-orb.js — the Orb call display: a soft, fuzzy, glowing blob with a pale phosphor core, a faint vignette and scanlines, drawn in code on a canvas (no artwork, no files,
 * no network). It has the same small interface the character player will have, so the call code drives either one.
 * Browser-safe plain JS (also loads with require() for tests); nothing runs at load time; CSP-safe (no inline style
 * markup, no eval, no external requests; only canvas + CSSOM property writes).
 *
 *   createVoiceOrb(container, options) -> orb
 *     options.color           'theme' (default: CSS var --orb-color, then --accent, then aqua) | 'aqua' | 'amber' | 'violet' | 'green' | '#rrggbb' | 'rgb(r,g,b)'
 *     options.label           accessible name prefix of the canvas (default 'Voice orb')
 *     options.rippleMs        ms for a speech burst to travel from the centre to either end of the line (default 275, clamped 100..800)
 *     options.reducedMotion   true/false to force; undefined follows prefers-reduced-motion live
 *     options.window/document/raf/caf/now/ResizeObserver   injection points for tests (default: the page's own)
 *
 *   orb.setState('idle'|'listening'|'thinking'|'speaking')   an unknown name is ignored (returns false)
 *   orb.setLevel(v)          0..1 voice level (any non-finite value counts as 0); used while no analyser is attached
 *   orb.setAnalyser(a|null)  a Web Audio AnalyserNode of the reply audio; when set it supplies the level (setLevel is then ignored)
 *   orb.setMicLevel(v)       0..1 microphone level; only moves the blob while listening
 *   orb.react(mood)          a brief brighter pulse for delighted|laughing|sympathetic|surprised|proud|curious|encouraging (others ignored)
 *   orb.speechEvent(kind)    fallback for device speech without an analyser: 'start' | 'boundary' | 'end' gives a gentle level rhythm
 *   orb.setColor(c)          change colour choice;  orb.refresh() re-reads the theme variables (call after a theme switch)
 *   orb.setReducedMotion(b)  true/false to force, null to follow the system again
 *   orb.thinkingPulse(ev)    the shared thinking event (lib/ui-voice-thinking.js): ev = { at: performance.now() ms when the window STARTS (may be a few ms in the future), kind: 'cluster', durationMs, fadeInMs, fadeOutMs, pops: [{ tMs, strength, decayMs }], strength? }. The orb swells 6 % over the window (fade in, hold, fade out) and each pop adds a small soft brightness flicker at at+tMs; in the gaps it rests at normal brightness. Old contract still works: { at, attackMs: 250, decayMs: 1000, strength: 0..1 } is one gentle swell (kind 'tick' is capped small). Reduced motion: brightness only. Ignored (returns false) when not thinking, destroyed, malformed or already finished; events are dropped on leaving thinking (never replayed). No timer of its own: the caller's sound clock sends every event.
 *   orb.getInfo()            { state, level (the honest measured level), stretch, visual:{level,peak,gain}, fast:{level,visual,attackMs,releaseMs}, thinking:{value,flicker,phase,events,peakAt,lastAt}, radius (drawn, px), reduced, running, paused, destroyed, w, h, dpr } (test/diagnostic hook; visual = what the display draws after the fixed curve (gain = visual/level, diagnostic only); fast = the quick syllable envelope that drives the wave height)
 *   orb.destroy()            stops the loop, removes every listener/observer/canvas; late callbacks do nothing; safe to call twice
 *
 * Look: idle breathes slowly; listening swells gently with the mic; thinking rests at normal brightness and swells gently with each thinkingPulse cluster; speaking stretches the blob
 * sideways into a moving line (a voice trace) with a smaller glowing blob in the middle, and gathers back into the blob
 * about 0.9 s after the voice goes quiet (or when the state changes). The line is one smooth curve (quadratic segments, spatially blurred envelope of the level mapped through a fixed curve (no auto-gain: ordinary speech 0.1-0.35 = 25-35 % of the height, 0.7+ full), broad wave travelling outward from the blob on both sides, smooth at the centre, tapered ends); true silence stays flat. Listening adds a soft mic-driven halo (radial-gradient lobes and a wide faint band hugging the blob; no stroke); thinking rests at normal brightness, swells (max 6 %) over each cluster and flickers softly on each pop. A faint short afterglow trails the line (4 traces at most). Reduced motion: no trail, a steady blob whose brightness
 * follows the voice, nothing moves. The loop pauses while the page is hidden and, in reduced motion, while nothing changes.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.VoiceOrb = api; root.createVoiceOrb = api.createVoiceOrb; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const ORB_STATES = ['idle', 'listening', 'thinking', 'speaking'];
  const ORB_MOODS = ['delighted', 'laughing', 'sympathetic', 'surprised', 'proud', 'curious', 'encouraging'];
  const ORB_PALETTES = { aqua: [95, 212, 255], amber: [255, 180, 84], violet: [180, 140, 255], green: [110, 231, 160] };
  const ORB_MAX_DPR = 2, ORB_HOLD_S = 0.9, ORB_HIST = 64, ORB_HIST_STEP = 1 / 30, ORB_POINTS = 72;
  const ORB_TRAIL_MAX = 4, ORB_TRAIL_STEP = 0.16; // afterglow: at most 4 faint past traces, one every 0.16 s
  const ORB_PHOSPHOR = [205, 255, 222]; // restrained pale phosphor tint for the bright core
  const ORB_QUIET = 0.05; // level above which the voice counts as sounding
  // Visual tuning: wave-height multiplier and fraction of the resting radius removed while speaking.
  const ORB_WAVE_HEIGHT = 1, ORB_SPEAKING_SHRINK = 0.45;
  // resting radius as a fraction of the short side (halo and glow scale with it). Prior value: 0.26.
  const ORB_RADIUS = 0.20, ORB_RADIUS_PRIOR = 0.26;
  // outward travel speed of the wave carrier (multiplier on the clock). Prior value: 1 (phase speeds 2.6 and 1.4 rad/s); now doubled.
  const ORB_TRAVEL_SPEED = 2, ORB_TRAVEL_SPEED_PRIOR = 1;
  // ripple: seconds for a burst to travel from the centre to either end of the line (exposed: options.rippleMs, 250-300 ms by design), and carrier cycles between centre and end
  const ORB_RIPPLE_MS = 275, ORB_RIPPLE_MIN_MS = 100, ORB_RIPPLE_MAX_MS = 800, ORB_CARRIER_CYCLES = 1.25, ORB_DIST_C = Math.sqrt(0.02);
  // envelope gain (clamped to 1) to keep quiet speech filling the wave
  const ORB_ENV_BOOST = 1.0, ORB_ENV_GATE_FLOOR = 0.06, ORB_ENV_GATE_LOW = 0.2, ORB_ENV_GATE_FULL = 0.6; // gate: wave amplitude floor between syllables; fast/peak ratio where it starts to open and where it is fully open
  // fast syllable envelope, computed from the measured target BEFORE the slow display smoothing: attack 30 ms, release 135 ms
  const ORB_ENV_ATTACK_S = 0.030, ORB_ENV_RELEASE_S = 0.135;
  // thinking pulse: defaults, bounds, visual swell (max fraction of radius), extra glow, resting brightness
  // (gentle: a cluster swells the radius 6 % at most, resting brightness is the normal 0.8, a cluster lifts it a little and each pop adds a small soft flicker; no harsh flashes)
  const ORB_THINK_ATTACK_MS = 250, ORB_THINK_DECAY_MS = 1000, ORB_THINK_SWELL = 0.06, ORB_THINK_GLOW = 0.35, ORB_THINK_REST = 0.8, ORB_THINK_MAX_EVENTS = 6;
  const ORB_THINK_LIFT = 0.1, ORB_THINK_POP_LIFT = 0.08, ORB_THINK_POP_GLOW = 0.25, ORB_THINK_REDUCED_LIFT = 0.12, ORB_THINK_REDUCED_POP = 0.1; // brightness added by the cluster window / by a pop (normal and reduced motion)
  const ORB_THINK_FADE_IN_MS = 320, ORB_THINK_FADE_OUT_MS = 480, ORB_THINK_POP_ATTACK_MS = 24, ORB_THINK_MAX_POPS = 16, ORB_THINK_TICK_MAX = 0.4; // defaults of a cluster event, soft pop rise, bounds
  // FIXED wave-height curve (no automatic gain: every voice maps the same, a quiet voice stays small, only loud speech fills the height). Knots [measured level, fraction of full height]:
  // gate 0.06 -> 0 (breath/room noise flat), 0.10 -> 25 %, 0.35 -> 35 % (ordinary speech 0.1-0.35 = 25-35 %), 0.70 and above -> 100 %.
  // ORB_VIS_MAX is the one scale for the wave size; the running peak vPeak is only a diagnostic and the reference of the between-syllable gate (it never scales the wave).
  const ORB_PEAK_TAU = 2, ORB_PEAK_RISE = 0.08, ORB_GATE = 0.06, ORB_PEAK_FLOOR = 0.16, ORB_VIS_MAX = 1;
  const ORB_CURVE = [[ORB_GATE, 0], [0.10, 0.25], [0.35, 0.35], [0.70, 1]];

  function orbNum(v, d) { return typeof v === 'number' && isFinite(v) ? v : (d || 0); }
  function orbClamp01(v) { v = orbNum(v, 0); return v < 0 ? 0 : v > 1 ? 1 : v; }
  /** Parse '#rgb', '#rrggbb', 'rgb(r,g,b)', 'rgb(r g b / a)' to [r,g,b] or null. */
  function orbParseColor(s) {
    if (typeof s !== 'string') return null;
    s = s.trim().toLowerCase();
    let m = /^#([0-9a-f]{3})$/.exec(s);
    if (m) return m[1].split('').map(c => parseInt(c + c, 16));
    m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(s);
    if (m) return [0, 2, 4].map(i => parseInt(m[1].substr(i, 2), 16));
    m = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/.exec(s);
    if (m) return [m[1], m[2], m[3]].map(n => Math.min(255, +n));
    return null;
  }
  /** RMS of a byte time-domain buffer (128 = silence) or float buffer, soft-gated and scaled to 0..1. Never NaN. */
  function orbLevelFromSamples(buf, isFloat) {
    const n = buf && buf.length | 0;
    if (!n) return 0;
    let sum = 0;
    for (let i = 0; i < n; i++) { const v = isFloat ? buf[i] : (buf[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / n);
    if (!isFinite(rms) || rms < 0.01) return 0;
    return orbClamp01((rms - 0.01) * 3.5);
  }

  function createVoiceOrb(container, options) {
    options = options || {};
    if (!container) throw new Error('createVoiceOrb: a container element is required');
    const doc = options.document || container.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const win = options.window || (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);
    if (!doc) throw new Error('createVoiceOrb: no document');
    const now = options.now || (() => (win && win.performance && win.performance.now ? win.performance.now() : Date.now()));
    const rafFn = options.raf || (win && win.requestAnimationFrame ? win.requestAnimationFrame.bind(win) : (cb => setTimeout(() => cb(now()), 16)));
    const cafFn = options.caf || (win && win.cancelAnimationFrame ? win.cancelAnimationFrame.bind(win) : (id => clearTimeout(id)));
    const RO = options.ResizeObserver || (win && win.ResizeObserver) || null;

    const canvas = doc.createElement('canvas');
    const labelBase = options.label || 'Voice orb';
    canvas.setAttribute('role', 'img');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    const ctx = canvas.getContext && canvas.getContext('2d');
    container.appendChild(canvas);

    const rippleS = Math.max(ORB_RIPPLE_MIN_MS, Math.min(ORB_RIPPLE_MAX_MS, orbNum(options.rippleMs, ORB_RIPPLE_MS) || ORB_RIPPLE_MS)) / 1000;
    let state = 'idle', destroyed = false, rafId = null, running = false, last = 0, clock = 0;
    let extLevel = 0, micLevel = 0, lvl = 0, fast = 0, fastVis = 0, vPeak = 0, vis = 0, stretch = 0, speakHold = 0, pulse = 0, histAcc = 0;
    let thinkEvents = [], thinkP = 0, thinkFlick = 0, thinkPhase = 'idle', thinkPeakAt = 0, thinkLastAt = 0, drawnR = 0;
    let analyser = null, anBuf = null, anFloat = false;
    let synth = { on: false, kick: 0, since: 0 };
    let reducedForce = typeof options.reducedMotion === 'boolean' ? options.reducedMotion : null;
    let reducedSys = false, mql = null, mqlHandler = null;
    let paused = false, w = 0, h = 0, dpr = 1, dirty = true;
    let color = [95, 212, 255], colorChoice = options.color || 'theme';
    const hist = new Array(ORB_HIST).fill(0); let head = 0;
    const trail = []; let trailAcc = 0;
    let ro = null, onWinResize = null, onVis = null;

    function reduced() { return reducedForce === null ? reducedSys : reducedForce; }
    function setLabel() { canvas.setAttribute('aria-label', labelBase + ': ' + state); }

    function resolveColor() {
      let c = null;
      if (typeof colorChoice === 'string' && ORB_PALETTES[colorChoice]) c = ORB_PALETTES[colorChoice];
      else if (colorChoice && colorChoice !== 'theme') c = orbParseColor(colorChoice);
      if (!c && win && win.getComputedStyle) {
        try {
          const cs = win.getComputedStyle(container);
          c = orbParseColor(cs.getPropertyValue('--orb-color')) || orbParseColor(cs.getPropertyValue('--accent'));
        } catch (e) { c = null; }
      }
      color = c || ORB_PALETTES.aqua;
    }

    function measure() {
      const r = container.getBoundingClientRect ? container.getBoundingClientRect() : {};
      const nw = Math.max(0, Math.floor(orbNum(container.clientWidth, orbNum(r.width, 0)) || orbNum(r.width, 0)));
      const nh = Math.max(0, Math.floor(orbNum(container.clientHeight, orbNum(r.height, 0)) || orbNum(r.height, 0)));
      const nd = Math.min(ORB_MAX_DPR, Math.max(1, orbNum(win && win.devicePixelRatio, 1)));
      if (nw !== w || nh !== h || nd !== dpr) {
        w = nw; h = nh; dpr = nd;
        canvas.width = Math.max(1, Math.round(w * dpr));
        canvas.height = Math.max(1, Math.round(h * dpr));
      }
      dirty = true;
    }

    function readAnalyser() {
      try {
        if (!anBuf) {
          const size = analyser.fftSize || 1024;
          if (analyser.getByteTimeDomainData) { anBuf = new Uint8Array(size); anFloat = false; }
          else if (analyser.getFloatTimeDomainData) { anBuf = new Float32Array(size); anFloat = true; }
          else { analyser = null; return 0; }
        }
        if (anFloat) analyser.getFloatTimeDomainData(anBuf); else analyser.getByteTimeDomainData(anBuf);
        return orbLevelFromSamples(anBuf, anFloat);
      } catch (e) { analyser = null; anBuf = null; return 0; }
    }

    function targetLevel() {
      let t = analyser ? readAnalyser() : extLevel;
      if (state === 'listening') t = Math.max(t, micLevel);
      if (synth.on && state === 'speaking' && !analyser) {
        const s = 0.28 + 0.14 * Math.sin(clock * 7.3) + 0.08 * Math.sin(clock * 3.1 + 1) + synth.kick;
        t = Math.max(t, orbClamp01(s));
      }
      return orbClamp01(t);
    }

    /** Display level 0..ORB_VIS_MAX through a FIXED curve (no auto-gain, the same for every voice): gated, then piecewise linear through ORB_CURVE (measured level -> fraction of full wave height). */
    function visualLevel(v) {
      if (!(v > ORB_GATE)) return 0;
      for (let i = 1; i < ORB_CURVE.length; i++) {
        const a = ORB_CURVE[i - 1], b = ORB_CURVE[i];
        if (v <= b[0]) return ORB_VIS_MAX * (a[1] + (b[1] - a[1]) * (v - a[0]) / (b[0] - a[0]));
      }
      return ORB_VIS_MAX;
    }

    /** Smooth 0..1 shape of one pulse at elapsed ms: half-cosine rise to the peak at attack, half-cosine fall over decay; zero slope at start, peak and end. */
    function thinkShape(el, ev) {
      if (el < 0 || el >= ev.attack + ev.decay) return 0;
      if (el < ev.attack) return 0.5 - 0.5 * Math.cos(Math.PI * el / ev.attack);
      return 0.5 + 0.5 * Math.cos(Math.PI * (el - ev.attack) / ev.decay);
    }
    /** Cluster window 0..1: half-cosine fade in over fin, held, half-cosine fade out over the last fout ms of the window. */
    function clusterShape(el, ev) {
      if (el < 0 || el >= ev.dur) return 0;
      if (el < ev.fin) return 0.5 - 0.5 * Math.cos(Math.PI * el / ev.fin);
      const tail = ev.dur - ev.fout;
      return el < tail ? 1 : 0.5 + 0.5 * Math.cos(Math.PI * (el - tail) / ev.fout);
    }
    /** One soft pop 0..1 at elapsed ms since the pop: a short half-cosine rise, then a half-cosine fall (no hard edge, so no harsh flash). */
    function popShape(el, p) {
      if (el < 0 || el >= p.rise + p.fall) return 0;
      return el < p.rise ? 0.5 - 0.5 * Math.cos(Math.PI * el / p.rise) : 0.5 + 0.5 * Math.cos(Math.PI * (el - p.rise) / p.fall);
    }
    function thinkUpdate(tm) {
      let best = 0, ph = 'idle', pend = false, flick = 0;
      thinkEvents = thinkEvents.filter(ev => tm < ev.end);
      for (const ev of thinkEvents) {
        const el = tm - ev.at;
        if (el < 0) { pend = true; continue; }
        if (ev.cluster) {
          const v = ev.strength * clusterShape(el, ev);
          if (v >= best && v > 0) { best = v; ph = el < ev.fin ? 'attack' : el < ev.dur - ev.fout ? 'hold' : 'decay'; thinkPeakAt = ev.at + ev.fin; }
          for (const p of ev.pops) flick = Math.max(flick, ev.strength * p.strength * popShape(el - p.tMs, p));
        } else {
          const v = ev.strength * thinkShape(el, ev);
          if (v >= best) { best = v; ph = el < ev.attack ? 'attack' : 'decay'; thinkPeakAt = ev.at + ev.attack; }
        }
      }
      thinkP = state === 'thinking' ? best : 0;
      thinkFlick = state === 'thinking' ? flick : 0;
      thinkPhase = state !== 'thinking' ? 'idle' : best > 0 ? ph : pend ? 'pending' : 'idle';
    }

    /** Emission gate 0..1: ORB_ENV_GATE_FLOOR between syllables, fully open while the fast envelope is near its recent peak. Applied when a burst is SENT (history stores the gated amplitude), so a closed gate never hides an old ripple that would reappear when the next syllable opens it. */
    function emitGate() {
      const rel = fast / Math.max(vPeak, ORB_PEAK_FLOOR);
      return ORB_ENV_GATE_FLOOR + (1 - ORB_ENV_GATE_FLOOR) * orbClamp01((rel - ORB_ENV_GATE_LOW) / (ORB_ENV_GATE_FULL - ORB_ENV_GATE_LOW));
    }

    function update(dt, tm) {
      trailDt += dt;
      const t = targetLevel();
      // fast syllable envelope from the actual measured target, before any slow smoothing
      fast += (t - fast) * (1 - Math.exp(-dt / (t > fast ? ORB_ENV_ATTACK_S : ORB_ENV_RELEASE_S)));
      if (!isFinite(fast) || (t === 0 && fast < 0.001)) fast = 0;
      thinkUpdate(tm);
      const listening = state === 'listening';
      const tau = t > lvl ? (listening ? 0.12 : 0.05) : (listening ? 0.4 : 0.25);
      lvl += (t - lvl) * (1 - Math.exp(-dt / tau));
      if (!isFinite(lvl) || (t === 0 && lvl < 0.001)) lvl = 0;
      if (fast > vPeak) vPeak += (fast - vPeak) * (1 - Math.exp(-dt / ORB_PEAK_RISE)); else vPeak *= Math.exp(-dt / ORB_PEAK_TAU);
      if (!isFinite(vPeak) || vPeak < 0.001) vPeak = 0;
      vis = visualLevel(lvl);
      fastVis = visualLevel(fast);
      pulse *= Math.exp(-dt / 0.8); if (pulse < 0.005) pulse = 0;
      synth.kick *= Math.exp(-dt / 0.25);
      if (reduced()) { stretch = 0; trail.length = 0; trailAcc = 0; return; }
      if (state === 'speaking' && t > ORB_QUIET) speakHold = ORB_HOLD_S; else speakHold = Math.max(0, speakHold - dt);
      const sT = state === 'speaking' && speakHold > 0 ? 1 : 0;
      stretch += (sT - stretch) * (1 - Math.exp(-dt / (sT > stretch ? 0.35 : 0.7)));
      if (stretch < 0.002 && sT === 0) stretch = 0;
      histAcc += dt;
      let guard = 0;
      while (histAcc >= ORB_HIST_STEP && guard++ < 8) { histAcc -= ORB_HIST_STEP; head = (head + 1) % ORB_HIST; hist[head] = fastVis * emitGate(); }
      if (histAcc > 1) histAcc = 0;
    }

    function rgba(c, a) { return 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + Math.max(0, Math.min(1, a)).toFixed(3) + ')'; }

    function blob(cx, cy, r, a, fuzz, glow) {
      glow = glow || 1;
      const core = [0, 1, 2].map(i => color[i] * 0.3 + ORB_PHOSPHOR[i] * 0.7);
      let g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 2.6);
      g.addColorStop(0, rgba(color, 0.34 * a * glow)); g.addColorStop(0.4, rgba(color, 0.14 * a * glow));
      // feathered outer edge: from 0.4 to 1 the alpha follows (0.5+0.5cos)^2, so it reaches 0 with zero slope (no visible disc rim, also at the thinking peak); magnitudes at 0 and 0.4 are unchanged
      for (const s of [0.55, 0.7, 0.85, 0.95]) { const x = (s - 0.4) / 0.6, c = 0.5 + 0.5 * Math.cos(Math.PI * x); g.addColorStop(s, rgba(color, 0.14 * a * glow * c * c)); }
      g.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r * 2.6, 0, Math.PI * 2); ctx.fill();
      for (let k = 0; k < 3 && fuzz; k++) {
        const ox = Math.cos(clock * 0.45 + k * 2.1) * r * 0.09, oy = Math.sin(clock * 0.37 + k * 1.7) * r * 0.09, rr = r * (1.12 + 0.07 * k);
        g = ctx.createRadialGradient(cx + ox, cy + oy, 0, cx + ox, cy + oy, rr);
        g.addColorStop(0, rgba(color, 0.3 * a)); g.addColorStop(0.7, rgba(color, 0.12 * a)); g.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx + ox, cy + oy, rr, 0, Math.PI * 2); ctx.fill();
      }
      g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 1.1);
      g.addColorStop(0, rgba(core, 0.95 * a)); g.addColorStop(0.5, rgba(color, 0.7 * a)); g.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r * 1.1, 0, Math.PI * 2); ctx.fill();
    }

    let trailDt = 0;
    /** Continuous curve through points: quadratic segments between midpoints (no corners, no lineTo). */
    function smoothPath(p, closed) {
      const n = p.length;
      if (n < 2) return;
      if (closed) {
        const m0 = [(p[n - 1][0] + p[0][0]) / 2, (p[n - 1][1] + p[0][1]) / 2];
        ctx.moveTo(m0[0], m0[1]);
        for (let i = 0; i < n; i++) { const q = p[(i + 1) % n]; ctx.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + q[0]) / 2, (p[i][1] + q[1]) / 2); }
        ctx.closePath();
        return;
      }
      ctx.moveTo(p[0][0], p[0][1]);
      for (let i = 1; i < n - 1; i++) ctx.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2);
      ctx.quadraticCurveTo(p[n - 1][0], p[n - 1][1], p[n - 1][0], p[n - 1][1]);
    }

    /** Burst amplitude along the line, 0..1 per point: the fast envelope now at the centre, then the same envelope as it was age = |u| * rippleS seconds ago, so each syllable is sent out as a ripple burst that reaches the end of the line after rippleS (true silence stays 0), then a light spatial blur. The carrier (see line) travels at the same speed. */
    function envelope() {
      const e = new Array(ORB_POINTS + 1);
      const now0 = fastVis * emitGate(); // the burst being sent right now
      const at = k => hist[((head - k) % ORB_HIST + ORB_HIST) % ORB_HIST];
      for (let i = 0; i <= ORB_POINTS; i++) {
        const u = Math.abs((i / ORB_POINTS) * 2 - 1), age = u * rippleS;
        let v;
        if (age <= histAcc) v = histAcc > 0 ? now0 + (at(0) - now0) * (age / histAcc) : now0;
        else { const k = (age - histAcc) / ORB_HIST_STEP, k0 = Math.floor(k), f = k - k0; v = at(k0) + (at(k0 + 1) - at(k0)) * f; }
        e[i] = orbClamp01(v * (1 - u) * ORB_ENV_BOOST); // a ripple loses height as it travels (linear age fade), on top of the end taper in line()
      }
      for (let pass = 0; pass < 5; pass++) {
        let prev = e[0];
        for (let i = 0; i <= ORB_POINTS; i++) {
          const cur = e[i], nxt = e[Math.min(ORB_POINTS, i + 1)];
          e[i] = 0.25 * prev + 0.5 * cur + 0.25 * nxt; prev = cur;
        }
      }
      return e;
    }

    function line(cx, cy, half, amp, a) {
      if (half < 2) return;
      const env = envelope(), pts = [];
      for (let i = 0; i <= ORB_POINTS; i++) {
        const u = (i / ORB_POINTS) * 2 - 1;
        const taper = Math.pow(Math.max(0, 1 - u * u), 1.5); // ends settle onto the centre line
        // smooth distance from the blob, 0 at the centre and 1 at the ends (even in u: no cusp, mirrored on both sides)
        const dn = (Math.sqrt(u * u + 0.02) - ORB_DIST_C) / (Math.sqrt(1.02) - ORB_DIST_C);
        // signed outward carrier: crests move away from the centre at 1/rippleS per second (same speed as the burst envelope), troughs go below the baseline
        const wave = Math.sin(2 * Math.PI * ORB_CARRIER_CYCLES * (dn - clock / rippleS));
        pts.push([cx + u * half, cy + amp * env[i] * taper * wave]);
      }
      // afterglow: a few faint, slowly fading earlier traces (bounded; never in reduced motion, which never reaches here)
      trailAcc += trailDt; trailDt = 0;
      if (trailAcc >= ORB_TRAIL_STEP) { trailAcc = 0; trail.push(pts); if (trail.length > ORB_TRAIL_MAX) trail.shift(); }
      for (let k = 0; k < trail.length; k++) {
        const tp = trail[k];
        if (tp === pts) continue;
        ctx.strokeStyle = rgba(color, 0.12 * a * (k + 1) / trail.length);
        ctx.lineWidth = 1.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath();
        smoothPath(tp, false);
        ctx.stroke();
      }
      const passes = [[22, 0.07], [10, 0.16], [3, 0.95]];
      for (const [lw, pa] of passes) {
        const g = ctx.createLinearGradient(cx - half, 0, cx + half, 0);
        const c = lw <= 3 ? [(color[0] + 255) / 2, (color[1] + 255) / 2, (color[2] + 255) / 2] : color;
        g.addColorStop(0, rgba(c, 0)); g.addColorStop(0.22, rgba(c, pa * a)); g.addColorStop(0.78, rgba(c, pa * a)); g.addColorStop(1, rgba(c, 0));
        ctx.strokeStyle = g; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath();
        smoothPath(pts, false);
        ctx.stroke();
      }
    }

    /** Listening: a soft halo hugging the blob, driven by the mic: slowly drifting radial-gradient lobes plus a wide, very faint band. No stroke, no hard edge (every gradient ends at alpha 0). */
    function halo(cx, cy, r, a) {
      const v = vis, n = 6;
      let g = ctx.createRadialGradient(cx, cy, r * 0.8, cx, cy, r * (1.8 + 0.5 * v));
      g.addColorStop(0, rgba(color, 0)); g.addColorStop(0.3, rgba(color, (0.05 + 0.14 * v) * a)); g.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r * (1.8 + 0.5 * v), 0, Math.PI * 2); ctx.fill();
      for (let i = 0; i < n; i++) {
        const th = (i / n) * Math.PI * 2 + clock * 0.35;
        const k = 0.65 + 0.35 * Math.sin(clock * 1.9 + i * 1.7); // each lobe swells a little differently
        const d = r * (0.95 + 0.1 * Math.sin(clock * 1.3 + i * 2.3)), rr = r * (0.5 + 0.55 * v * k);
        const x = cx + Math.cos(th) * d, y = cy + Math.sin(th) * d;
        g = ctx.createRadialGradient(x, y, 0, x, y, rr);
        g.addColorStop(0, rgba(color, (0.04 + 0.2 * v * k) * a)); g.addColorStop(0.5, rgba(color, (0.02 + 0.09 * v * k) * a)); g.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.fill();
      }
    }

    /** Subtle vignette and faint scanlines over the finished picture (drawn last; static, so fine in reduced motion). */
    function finish() {
      const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.22)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(0,0,0,0.05)'; ctx.beginPath();
      for (let y = 0; y < h; y += 4) ctx.rect(0, y, w, 1);
      ctx.fill();
    }

    function draw() {
      if (!ctx || w <= 0 || h <= 0) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const m = Math.min(w, h), cx = w / 2, cy = h / 2, R = m * ORB_RADIUS;
      if (reduced()) {
        const base = state === 'listening' ? 0.5 : state === 'thinking' ? 0.55 : state === 'speaking' ? 0.55 : 0.45;
        blob(cx, cy, R, Math.min(1, base + 0.5 * lvl + 0.3 * pulse + (state === 'thinking' ? ORB_THINK_REDUCED_LIFT * thinkP + ORB_THINK_REDUCED_POP * thinkFlick : 0)), false);
        drawnR = R;
        finish();
        return;
      }
      let r = R, a = 0.8;
      if (state === 'idle') { r = R * (1 + 0.05 * Math.sin(clock * 2 * Math.PI / 5.5)); a = 0.7 + 0.1 * Math.sin(clock * 2 * Math.PI / 5.5) + 0.15 * lvl; }
      else if (state === 'listening') { r = R * (1.02 + 0.28 * lvl); a = 0.75 + 0.25 * lvl; }
      else if (state === 'thinking') { r = R * (1 + ORB_THINK_SWELL * thinkP); a = Math.min(1, ORB_THINK_REST + ORB_THINK_LIFT * thinkP + ORB_THINK_POP_LIFT * thinkFlick); }
      else { r = R * (1 + 0.1 * lvl); a = 0.8 + 0.2 * lvl; }
      const s = stretch * stretch * (3 - 2 * stretch); // smoothstep
      r *= 1 - ORB_SPEAKING_SHRINK * s;
      a = Math.min(1, a + 0.3 * pulse); r *= 1 + 0.12 * pulse;
      if (s > 0.01) line(cx, cy, s * w * 0.42, ORB_WAVE_HEIGHT * Math.min(h * 0.22, m * 0.28), Math.min(1, s * 1.2));
      else { trail.length = 0; trailAcc = 0; }
      if (state === 'listening') halo(cx, cy, r, a);
      drawnR = r;
      blob(cx, cy, r, a, true, state === 'thinking' ? 1 + ORB_THINK_GLOW * thinkP + ORB_THINK_POP_GLOW * thinkFlick : 1);
      finish();
    }

    function settled() {
      if (!reduced()) return false;
      return !(synth.on || pulse > 0 || thinkEvents.length > 0 || Math.abs(lvl - targetLevelPeek()) > 0.002);
    }
    function targetLevelPeek() { return analyser ? lvl : Math.max(extLevel, state === 'listening' ? micLevel : 0); }

    function frame() {
      rafId = null;
      if (destroyed || paused) { running = false; return; }
      const t = now();
      const dt = Math.min(0.1, Math.max(0, (t - last) / 1000));
      last = t; clock += dt;
      update(dt, t);
      draw(); dirty = false;
      if (analyser && reduced()) { schedule(); return; }
      if (settled()) { running = false; return; }
      schedule();
    }
    function schedule() { running = true; rafId = rafFn(frame); }
    function wake() {
      if (destroyed || paused || rafId !== null) return;
      last = now(); schedule();
    }

    // ── wiring ──
    resolveColor(); setLabel();
    if (win && win.matchMedia) {
      try {
        mql = win.matchMedia('(prefers-reduced-motion: reduce)');
        reducedSys = !!(mql && mql.matches);
        mqlHandler = e => { reducedSys = !!e.matches; if (reducedSys) stretch = 0; wake(); };
        if (mql.addEventListener) mql.addEventListener('change', mqlHandler); else if (mql.addListener) mql.addListener(mqlHandler);
      } catch (e) { mql = null; }
    }
    if (RO) { try { ro = new RO(() => { if (!destroyed) { measure(); wake(); } }); ro.observe(container); } catch (e) { ro = null; } }
    if (!ro && win && win.addEventListener) { onWinResize = () => { if (!destroyed) { measure(); wake(); } }; win.addEventListener('resize', onWinResize); }
    paused = !!(doc.hidden || doc.visibilityState === 'hidden');
    onVis = () => {
      if (destroyed) return;
      paused = !!(doc.hidden || doc.visibilityState === 'hidden');
      if (paused) { if (rafId !== null) { cafFn(rafId); rafId = null; } running = false; } else { measure(); wake(); }
    };
    if (doc.addEventListener) doc.addEventListener('visibilitychange', onVis);
    measure();
    if (!paused) { last = now(); schedule(); }

    const api = {
      setState(s) {
        if (destroyed || ORB_STATES.indexOf(s) < 0) return false;
        if (s !== state) { state = s; if (s !== 'speaking') speakHold = 0; if (s !== 'thinking') { thinkEvents = []; thinkP = 0; thinkFlick = 0; thinkPhase = 'idle'; } if (s !== 'speaking') synth.on = false; setLabel(); }
        wake(); return true;
      },
      setLevel(v) { if (destroyed) return; extLevel = orbClamp01(v); wake(); },
      setMicLevel(v) { if (destroyed) return; micLevel = orbClamp01(v); wake(); },
      setAnalyser(a) {
        if (destroyed) return;
        analyser = a || null; anBuf = null; anFloat = false; wake();
      },
      react(mood) {
        if (destroyed || ORB_MOODS.indexOf(mood) < 0) return false;
        pulse = 1; wake(); return true;
      },
      speechEvent(kind) {
        if (destroyed) return;
        if (kind === 'start') { synth.on = true; synth.kick = 0.25; }
        else if (kind === 'boundary') { synth.on = true; synth.kick = 0.35; }
        else if (kind === 'end') { synth.on = false; synth.kick = 0; }
        wake();
      },
      thinkingPulse(ev) {
        if (destroyed || state !== 'thinking' || !ev || typeof ev !== 'object') return false;
        const at = ev.at;
        if (typeof at !== 'number' || !isFinite(at)) return false;
        let strength = ev.strength === undefined ? 1 : orbClamp01(ev.strength);
        let item;
        if (ev.kind === 'cluster' && orbNum(ev.durationMs, 0) > 0) {
          // the shared contract (lib/ui-voice-thinking.js): a window with its own fades and pops at event.at + tMs, all on the caller's clock
          const dur = Math.min(10000, ev.durationMs);
          let fin = Math.max(10, orbNum(ev.fadeInMs, 0) || ORB_THINK_FADE_IN_MS), fout = Math.max(10, orbNum(ev.fadeOutMs, 0) || ORB_THINK_FADE_OUT_MS);
          if (fin + fout > dur) { const k = dur / (fin + fout); fin *= k; fout *= k; }
          const pops = (Array.isArray(ev.pops) ? ev.pops : []).filter(p => p && typeof p.tMs === 'number' && isFinite(p.tMs) && p.tMs >= 0).slice(0, ORB_THINK_MAX_POPS)
            .map(p => ({ tMs: p.tMs, strength: p.strength === undefined ? 1 : orbClamp01(p.strength), rise: ORB_THINK_POP_ATTACK_MS, fall: Math.max(90, Math.min(240, 2.5 * (orbNum(p.decayMs, 40) || 40))) }));
          const end = at + Math.max(dur, ...pops.map(p => p.tMs + p.rise + p.fall));
          item = { cluster: true, at, dur, fin, fout, pops, strength, end };
        } else {
          // old contract: one swell { at, attackMs, decayMs, strength } (a 'tick' stays small)
          const attack = Math.max(10, Math.min(2000, orbNum(ev.attackMs, ORB_THINK_ATTACK_MS) || ORB_THINK_ATTACK_MS));
          const decay = Math.max(50, Math.min(5000, orbNum(ev.decayMs, ORB_THINK_DECAY_MS) || ORB_THINK_DECAY_MS));
          if (ev.kind === 'tick') strength = Math.min(strength, ORB_THINK_TICK_MAX);
          item = { cluster: false, at, attack, decay, strength, end: at + attack + decay };
        }
        if (now() >= item.end) return false; // stale: never replayed
        thinkEvents.push(item); thinkLastAt = at;
        if (thinkEvents.length > ORB_THINK_MAX_EVENTS) thinkEvents.shift();
        wake(); return true;
      },
      setColor(c) { if (destroyed) return; colorChoice = c || 'theme'; resolveColor(); dirty = true; wake(); },
      refresh() { if (destroyed) return; resolveColor(); measure(); wake(); },
      setReducedMotion(b) {
        if (destroyed) return;
        reducedForce = typeof b === 'boolean' ? b : null;
        if (reduced()) stretch = 0;
        wake();
      },
      getInfo() { return { state, level: lvl, stretch, visual: { level: vis, peak: vPeak, gain: vis > 0 && lvl > 0 ? vis / lvl : 0 }, fast: { level: fast, visual: fastVis, attackMs: ORB_ENV_ATTACK_S * 1000, releaseMs: ORB_ENV_RELEASE_S * 1000 }, thinking: { value: thinkP, flicker: thinkFlick, phase: thinkPhase, events: thinkEvents.length, peakAt: thinkPeakAt, lastAt: thinkLastAt }, radius: drawnR, reduced: reduced(), running, paused, destroyed, w, h, dpr }; },
      destroy() {
        if (destroyed) return;
        destroyed = true; running = false;
        if (rafId !== null) { try { cafFn(rafId); } catch (e) { /* ignore */ } rafId = null; }
        if (ro) { try { ro.disconnect(); } catch (e) { /* ignore */ } ro = null; }
        if (onWinResize && win.removeEventListener) win.removeEventListener('resize', onWinResize);
        if (onVis && doc.removeEventListener) doc.removeEventListener('visibilitychange', onVis);
        if (mql && mqlHandler) { try { if (mql.removeEventListener) mql.removeEventListener('change', mqlHandler); else if (mql.removeListener) mql.removeListener(mqlHandler); } catch (e) { /* ignore */ } }
        thinkEvents = []; thinkP = 0; thinkFlick = 0; thinkPhase = 'idle';
        analyser = null; anBuf = null; mql = null; mqlHandler = null; onWinResize = null; onVis = null;
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      },
    };
    return api;
  }

  return { createVoiceOrb, ORB_RIPPLE_MS, ORB_RADIUS, ORB_RADIUS_PRIOR, ORB_TRAVEL_SPEED, ORB_TRAVEL_SPEED_PRIOR, ORB_STATES, ORB_MOODS, ORB_PALETTES, orbParseColor, orbLevelFromSamples };
});
