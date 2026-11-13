'use strict';
/**
 * ui-voice-thinking.js — the call's "thinking" sound as DATA: quiet, seeded, random pop clusters. Pure and deterministic: the same
 * seed gives the same pops and the same gaps, with no clock, no Web Audio and no DOM, so the call controller (lib/ui-voice-call.js),
 * the sound (voiceCreateThinkingSound), the call display's orb, the demo page and an offline WAV renderer can all use ONE plan.
 * Browser-safe plain JS (a classic <script>, served as /ui-voice-thinking.js): no require, every top-level name starts with
 * voice / VOICE_, nothing runs at load time.
 *
 * Variants (VOICE_THINKING_VARIANTS):
 *   'A' airy (the default build)  5-7 light pops, 480-900 Hz, short (30-42 ms) decays, a little upward glide
 *   'B' round bubble              4-6 round pops, 200-520 Hz, longer (44-60 ms) decays, a bubble-like upward glide
 *   'C' sparse single             ONE pop, 260-420 Hz, 50-60 ms
 * A cluster (A, B) lasts about 1.5 s: the pops are unevenly spaced (120-350 ms apart), the whole cluster fades in and out, each pop is
 * a few-ms attack and a 30-60 ms decay through a low-pass below 2 kHz. Quiet gap between clusters: gapMinMs + random * gapSpreadMs
 * (4000 + 2000 = 4-6 s by default), measured from the END of the previous cluster. The first sound is 2 s after the wait began (the call
 * controller's VOICE_CALL_THINK_MS). Peak level: voiceThinkingPeak(0.5) is -30 dBFS (volume 0.5 is the default thinking volume).
 *
 *   voiceThinkingCluster(opts)       -> plan { variant, seed, index, durationMs, fadeInMs, fadeOutMs, lowpassHz, pops, gapAfterMs }
 *                                       opts { seed (int), index (cluster number in the wait, default 0), variant ('A'), gapMinMs (4000), gapSpreadMs (2000) }
 *   voiceThinkingEvent(plan, at)     -> the pulse EVENT (below) for a plan; `at` is a performance.now() time in ms
 *   voiceThinkingSchedule(opts)      -> the events of a whole wait, offline: opts { seed, variant, gapMinMs, gapSpreadMs, startAt (0),
 *                                       firstAtMs (2000), count (or untilMs) } -> [event, ...] with at = startAt + firstAtMs, then
 *                                       previous at + durationMs + gapAfterMs (exactly what the call's clock does)
 *   voiceThinkingPeak(volume)        -> the master gain for a thinking volume 0..1 (0.5 -> 10^(-30/20) ~ 0.0316)
 *   voiceThinkingVariant(v)          -> 'A' | 'B' | 'C' (anything else is 'A')
 *   voiceThinkingRng(seed)           -> () => float in [0, 1), a small seeded generator (mulberry32)
 *
 * THE PULSE EVENT (what ui.thinkingPulse(ev) / thinking.pulse(ev) receive; ONE object, shared by the sound and the picture):
 *   at          performance.now() ms when the cluster window STARTS (the audio start; the sound may move it to when it is really heard)
 *   kind        'cluster' (audible: pops) | 'tick' (the small silent pulse at the start of a wait: no pops, visual only)
 *   variant     'A' | 'B' | 'C' (cluster only)           seed, index   the plan's seed and cluster number (cluster only)
 *   durationMs  length of the cluster window from `at`   gapAfterMs  the quiet gap planned after it   fadeInMs, fadeOutMs   the cluster's own fade in / out
 *   pops        [{ tMs, strength, freqHz, decayMs }]  tMs = offset from `at` (so it stays right when `at` is moved to the heard time),
 *               strength 0..1 (the loudest pop is 1), decayMs the pop's decay; the pop is at event.at + tMs. [] for a tick.
 *   attackMs, decayMs, strength   the single-swell envelope the orb used before (kept so an orb that only knows swells still works):
 *               swell = fadeInMs up, then the rest of the window down; strength 1 for a cluster, 0.35 for a tick.
 */
const VOICE_THINKING_VARIANTS = ['A', 'B', 'C'];
const VOICE_THINKING_GAP_MIN_MS = 4000, VOICE_THINKING_GAP_SPREAD_MS = 2000, VOICE_THINKING_PEAK_DBFS = -30, VOICE_THINKING_LOWPASS_HZ = 1600;
// min/max/decay/spacing in ms, frequency in Hz. glide = the pop's end frequency over its start (a bubble rises).
const VOICE_THINKING_SHAPES = {
  A: { pops: [5, 7], hz: [480, 900], decay: [30, 42], space: [120, 350], glide: [1.04, 1.12], fadeIn: 320, fadeOut: 480 },
  B: { pops: [4, 6], hz: [200, 520], decay: [44, 60], space: [150, 350], glide: [1.25, 1.6], fadeIn: 300, fadeOut: 500 },
  C: { pops: [1, 1], hz: [260, 420], decay: [50, 60], space: [0, 0], glide: [1.1, 1.3], fadeIn: 6, fadeOut: 70 },
};
function voiceThinkingVariant(v) { const s = String(v == null ? '' : v).toUpperCase(); return VOICE_THINKING_VARIANTS.includes(s) ? s : 'A'; }
function voiceThinkingRng(seed) {
  let a = (Number.isFinite(Number(seed)) ? Math.floor(Number(seed)) : 0) >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function voiceThinkingPeak(volume) {
  const v = Number(volume);
  return (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5) * 2 * Math.pow(10, VOICE_THINKING_PEAK_DBFS / 20);
}
function voiceThinkingCluster(opts) {
  const o = opts || {};
  const variant = voiceThinkingVariant(o.variant), sh = VOICE_THINKING_SHAPES[variant];
  const seed = (Number.isFinite(Number(o.seed)) ? Math.floor(Number(o.seed)) : 0) >>> 0;
  const index = Number.isFinite(Number(o.index)) && Number(o.index) > 0 ? Math.floor(Number(o.index)) : 0;
  // every cluster of a wait has its own stream, so cluster 3 is the same whether or not 1 and 2 were played
  const rnd = voiceThinkingRng((Math.imul(seed ^ 0x9E3779B9, 0x85EBCA6B) + Math.imul(index + 1, 0xC2B2AE35)) >>> 0);
  const between = (lo, hi) => lo + rnd() * (hi - lo);
  const r1 = (n) => Math.round(n), r3 = (n) => Math.round(n * 1000) / 1000;
  const count = sh.pops[0] + Math.floor(rnd() * (sh.pops[1] - sh.pops[0] + 1));
  const pops = [];
  let t = variant === 'C' ? 0 : r1(between(40, 120)), top = 0;
  for (let i = 0; i < count; i++) {
    const decayMs = r1(between(sh.decay[0], sh.decay[1]));
    const freqHz = r1(between(sh.hz[0], sh.hz[1]));
    const glide = r3(between(sh.glide[0], sh.glide[1]));
    const strength = r3(between(0.55, 1));
    pops.push({ tMs: t, strength, freqHz, decayMs, glide });
    top = Math.max(top, strength);
    if (i < count - 1) t += r1(between(sh.space[0], sh.space[1]));   // uneven: every gap is its own draw
  }
  if (top > 0) for (const p of pops) p.strength = r3(p.strength / top);   // the loudest pop is exactly 1
  const last = pops[pops.length - 1];
  const durationMs = variant === 'C' ? last.decayMs + sh.fadeOut : Math.max(1500, last.tMs + last.decayMs + 140);
  const gapMin = Number.isFinite(Number(o.gapMinMs)) && Number(o.gapMinMs) >= 0 ? Number(o.gapMinMs) : VOICE_THINKING_GAP_MIN_MS;
  const gapSpread = Number.isFinite(Number(o.gapSpreadMs)) && Number(o.gapSpreadMs) >= 0 ? Number(o.gapSpreadMs) : VOICE_THINKING_GAP_SPREAD_MS;
  const gapAfterMs = r1(gapMin + rnd() * gapSpread);
  return { variant, seed, index, durationMs, fadeInMs: sh.fadeIn, fadeOutMs: sh.fadeOut, lowpassHz: VOICE_THINKING_LOWPASS_HZ, pops, gapAfterMs };
}
// The shared pulse event of a plan (see the contract above). The pops are copied, so the plan can be reused.
function voiceThinkingEvent(plan, at) {
  const p = plan || {};
  const dur = Number(p.durationMs) > 0 ? Number(p.durationMs) : 1500, fin = Math.max(10, Number(p.fadeInMs) || 250);
  return {
    at: Number(at), kind: 'cluster', variant: p.variant, seed: p.seed, index: p.index,
    durationMs: dur, gapAfterMs: p.gapAfterMs, fadeInMs: Number(p.fadeInMs) || 0, fadeOutMs: Number(p.fadeOutMs) || 0, lowpassHz: p.lowpassHz,
    pops: (p.pops || []).map(x => ({ tMs: x.tMs, strength: x.strength, freqHz: x.freqHz, decayMs: x.decayMs, glide: x.glide })),
    attackMs: fin, decayMs: Math.max(50, dur - fin), strength: 1,
  };
}
function voiceThinkingSchedule(opts) {
  const o = opts || {};
  const out = [], first = Number.isFinite(Number(o.firstAtMs)) ? Number(o.firstAtMs) : 2000;
  const until = Number.isFinite(Number(o.untilMs)) ? Number(o.untilMs) : Infinity;
  const count = Number.isFinite(Number(o.count)) ? Math.max(0, Math.floor(Number(o.count))) : (until === Infinity ? 5 : 1e6);
  let at = (Number.isFinite(Number(o.startAt)) ? Number(o.startAt) : 0) + first;
  for (let i = 0; i < count && at - (Number(o.startAt) || 0) <= until; i++) {
    const plan = voiceThinkingCluster({ seed: o.seed, index: i, variant: o.variant, gapMinMs: o.gapMinMs, gapSpreadMs: o.gapSpreadMs });
    const ev = voiceThinkingEvent(plan, at);
    out.push(ev);
    at += plan.durationMs + plan.gapAfterMs;
  }
  return out;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { voiceThinkingCluster, voiceThinkingEvent, voiceThinkingSchedule, voiceThinkingPeak, voiceThinkingVariant, voiceThinkingRng,
  VOICE_THINKING_VARIANTS, VOICE_THINKING_GAP_MIN_MS, VOICE_THINKING_GAP_SPREAD_MS, VOICE_THINKING_PEAK_DBFS, VOICE_THINKING_LOWPASS_HZ, VOICE_THINKING_SHAPES };
