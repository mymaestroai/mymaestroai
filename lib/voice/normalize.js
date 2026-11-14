'use strict';

// lib/voice/normalize.js: brings a local voice's speech to a steady level with a hard peak ceiling.
// Speech level = RMS over the 20 ms frames that are not near-silent. One gain moves that to the target, then a look-ahead
// limiter keeps every sample under the ceiling. The limiter itself takes a little level off loud passages, so the gain is
// refined (at most 3 passes) until the level measured AFTER limiting is within 0.1 dB of the target (or the gain limit is hit).
// Digital zero stays zero. Pure functions, no I/O.

const DEFAULTS = Object.freeze({ targetDb: -16, ceilingDb: -1, floorDb: -50, frameMs: 20, lookaheadMs: 5, releaseMs: 50, maxGainDb: 20, minGainDb: -20 });

const dbOf = (x) => 20 * Math.log10(x);

/** Speech RMS in dBFS (frames whose own RMS is above floorDb), or null when no frame qualifies. */
function speechLevelDb(samples, sampleRate, opts = {}) {
  const floorDb = opts.floorDb !== undefined ? opts.floorDb : DEFAULTS.floorDb;
  const frameMs = opts.frameMs !== undefined ? opts.frameMs : DEFAULTS.frameMs;
  const frame = Math.max(1, Math.round(frameMs * sampleRate / 1000));
  let sum = 0, count = 0;
  for (let s = 0; s < samples.length; s += frame) {
    const e = Math.min(samples.length, s + frame);
    let f = 0;
    for (let i = s; i < e; i++) { const v = samples[i]; if (Number.isFinite(v)) f += v * v; }
    const rms = Math.sqrt(f / (e - s));
    if (rms > 0 && dbOf(rms) > floorDb) { sum += f; count += e - s; }
  }
  return count ? dbOf(Math.sqrt(sum / count)) : null;
}

/** Look-ahead limiter on x*G. Returns { out, touched, needed, clamped }. */
function limit(x, G, sr, o) {
  const n = x.length;
  const ceiling = Math.pow(10, o.ceilingDb / 20);
  const aim = ceiling * (1 - 1e-9);   // a hair under, so float rounding of y*r can never land above the ceiling
  const y = new Float64Array(n);
  const d = new Float64Array(n);
  let needed = 0;
  for (let i = 0; i < n; i++) {
    y[i] = x[i] * G; const a = Math.abs(y[i]);
    if (a > ceiling) needed++;
    d[i] = a > aim ? aim / a : 1;
  }
  const L = Math.max(0, Math.round(o.lookaheadMs * sr / 1000));
  // h[i] = min of d over [i-L, i+L] (monotonic deque, O(n))
  const h = new Float64Array(n);
  const dq = new Int32Array(n); let head = 0, tail = 0, next = 0;
  for (let i = 0; i < n; i++) {
    const hi = Math.min(n - 1, i + L);
    while (next <= hi) { while (tail > head && d[dq[tail - 1]] >= d[next]) tail--; dq[tail++] = next++; }
    while (dq[head] < i - L) head++;
    h[i] = d[dq[head]];
  }
  // s[i] = mean of h over [i-floor(L/2), i+floor(L/2)], window clipped at the ends (prefix sums)
  const W = Math.floor(L / 2);
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + h[i];
  const k = 1 - Math.exp(-1 / (o.releaseMs / 1000 * sr));
  const out = new Float32Array(n);
  const c32 = Math.fround(ceiling) > ceiling ? Math.fround(ceiling - 1e-7) : Math.fround(ceiling);
  let r = 1, touched = 0, clamped = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - W), b = Math.min(n - 1, i + W);
    let s = (pre[b + 1] - pre[a]) / (b - a + 1);
    if (s > d[i]) s = d[i];   // rounding guard: the mean of minima never exceeds d[i] in exact arithmetic
    r = i === 0 ? s : Math.min(s, r + (1 - r) * k);
    if (r < 0.9999) touched++;
    let v = y[i] * r;
    if (v > ceiling) { v = ceiling; clamped++; } else if (v < -ceiling) { v = -ceiling; clamped++; }
    let f = v;   // float32 rounding of a value just under the ceiling can land a hair above it
    out[i] = f;
    if (out[i] > c32) { out[i] = c32; clamped++; } else if (out[i] < -c32) { out[i] = -c32; clamped++; }
  }
  return { out, touched, needed, clamped };
}

/**
 * normalizeSpeech(Float32Array mono, sampleRate, opts) ->
 *   { samples, gainDb, speechDb (before), touched (samples whose limiter gain is below 0.9999, release tail included),
 *     needed (samples that would have passed the ceiling without the limiter), clamped (float safety net hits), normalized: true }
 */
function normalizeSpeech(samples, sampleRate, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const n = samples ? samples.length : 0;
  if (!n) return { samples: samples || new Float32Array(0), gainDb: 0, speechDb: null, touched: 0, needed: 0, clamped: 0, normalized: true };
  const sr = Number(sampleRate) > 0 ? Number(sampleRate) : 24000;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) { const v = samples[i]; x[i] = Number.isFinite(v) ? v : 0; }
  const speechDb = speechLevelDb(x, sr, o);
  if (speechDb === null) return { samples: x, gainDb: 0, speechDb: null, touched: 0, needed: 0, clamped: 0, normalized: true };

  const clampGain = (g) => Math.max(o.minGainDb, Math.min(o.maxGainDb, g));
  let gainDb = clampGain(o.targetDb - speechDb);
  let res = limit(x, Math.pow(10, gainDb / 20), sr, o);
  for (let pass = 0; pass < 2; pass++) {
    const after = speechLevelDb(res.out, sr, o);
    if (after === null) break;
    const err = o.targetDb - after;
    const g2 = clampGain(gainDb + err);
    if (Math.abs(err) <= 0.1 || g2 === gainDb) break;
    gainDb = g2;
    res = limit(x, Math.pow(10, gainDb / 20), sr, o);
  }
  return { samples: res.out, gainDb, speechDb, touched: res.touched, needed: res.needed, clamped: res.clamped, normalized: true };
}

module.exports = { normalizeSpeech, speechLevelDb, DEFAULTS, TARGET_DB: DEFAULTS.targetDb, CEILING_DB: DEFAULTS.ceilingDb };
