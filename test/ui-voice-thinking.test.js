'use strict';
// lib/ui-voice-thinking.js: the thinking sound as seeded data (pop clusters A airy / B round bubble / C sparse single).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const L = require('../lib/ui-voice-thinking');
const { voiceThinkingCluster, voiceThinkingEvent, voiceThinkingSchedule, voiceThinkingPeak, voiceThinkingVariant, voiceThinkingRng } = L;

test('deterministic: the same seed gives the same cluster, another seed another one; clusters of a wait are independent of each other', () => {
  for (const variant of ['A', 'B', 'C']) {
    assert.deepStrictEqual(voiceThinkingCluster({ seed: 42, variant }), voiceThinkingCluster({ seed: 42, variant }));
    assert.notDeepStrictEqual(voiceThinkingCluster({ seed: 42, variant, index: 0 }).pops, voiceThinkingCluster({ seed: 43, variant, index: 0 }).pops);
    assert.notDeepStrictEqual(voiceThinkingCluster({ seed: 42, variant, index: 0 }).pops, voiceThinkingCluster({ seed: 42, variant, index: 1 }).pops);
  }
  const r = voiceThinkingRng(1), q = voiceThinkingRng(1);
  for (let i = 0; i < 20; i++) { const x = r(); assert.strictEqual(x, q()); assert.ok(x >= 0 && x < 1); }
});

test('A (the default) and B: 4-7 soft pops, uneven 120-350 ms spacing, decay 30-60 ms, low-pass under 2 kHz, about 1.5 s, loudest pop 1', () => {
  assert.strictEqual(voiceThinkingVariant(undefined), 'A'); assert.strictEqual(voiceThinkingVariant('x'), 'A'); assert.strictEqual(voiceThinkingVariant('b'), 'B');
  const spaces = new Set();
  for (const variant of ['A', 'B']) for (let seed = 0; seed < 300; seed++) {
    const c = voiceThinkingCluster({ seed, variant });
    const n = c.pops.length;
    assert.ok(variant === 'A' ? n >= 5 && n <= 7 : n >= 4 && n <= 6, variant + ' count ' + n);
    assert.ok(n >= 4 && n <= 7);
    for (let i = 1; i < n; i++) { const g = c.pops[i].tMs - c.pops[i - 1].tMs; assert.ok(g >= 120 && g <= 350, 'spacing ' + g); spaces.add(g); }
    for (const p of c.pops) { assert.ok(p.decayMs >= 30 && p.decayMs <= 60, 'decay ' + p.decayMs); assert.ok(p.freqHz > 150 && p.freqHz < 1000); assert.ok(p.strength > 0 && p.strength <= 1); }
    assert.strictEqual(Math.max(...c.pops.map(p => p.strength)), 1);
    assert.ok(c.lowpassHz < 2000);
    assert.ok(c.durationMs >= 1500 && c.durationMs <= 2700, 'about 1.5 s: ' + c.durationMs);
    assert.ok(c.fadeInMs > 100 && c.fadeOutMs > 100 && c.fadeInMs + c.fadeOutMs <= c.durationMs, 'the cluster fades in and out');
    assert.ok(c.pops[n - 1].tMs + c.pops[n - 1].decayMs <= c.durationMs);
    assert.ok(c.gapAfterMs >= 4000 && c.gapAfterMs <= 6000, 'gap ' + c.gapAfterMs);
  }
  assert.ok(spaces.size > 100, 'the spacing is uneven, not a grid');
});

test('C: ONE sparse pop each time, gaps still 4-6 s', () => {
  for (let seed = 0; seed < 100; seed++) {
    const c = voiceThinkingCluster({ seed, variant: 'C' });
    assert.strictEqual(c.pops.length, 1); assert.strictEqual(c.pops[0].tMs, 0); assert.strictEqual(c.pops[0].strength, 1);
    assert.ok(c.pops[0].decayMs >= 30 && c.pops[0].decayMs <= 60);
    assert.ok(c.gapAfterMs >= 4000 && c.gapAfterMs <= 6000);
    assert.ok(c.durationMs < 300);
  }
});

test('the gap is tunable (gapMinMs, gapSpreadMs) and varied by default', () => {
  const gaps = new Set();
  for (let seed = 0; seed < 50; seed++) gaps.add(voiceThinkingCluster({ seed }).gapAfterMs);
  assert.ok(gaps.size > 40, 'varied');
  assert.strictEqual(voiceThinkingCluster({ seed: 1, gapMinMs: 2500, gapSpreadMs: 0 }).gapAfterMs, 2500);
  const g = voiceThinkingCluster({ seed: 1, gapMinMs: 1000, gapSpreadMs: 500 }).gapAfterMs; assert.ok(g >= 1000 && g <= 1500);
  assert.strictEqual(L.VOICE_THINKING_GAP_MIN_MS, 4000); assert.strictEqual(L.VOICE_THINKING_GAP_SPREAD_MS, 2000);
  assert.deepStrictEqual(voiceThinkingCluster({ seed: 9, gapMinMs: -5, gapSpreadMs: 'x' }), voiceThinkingCluster({ seed: 9 }), 'rubbish falls back to the defaults');
});

test('peak: volume 0.5 (the default) is -30 dBFS, 0 is silent, the volume is clamped', () => {
  assert.ok(Math.abs(20 * Math.log10(voiceThinkingPeak(0.5)) + 30) < 1e-9);
  assert.strictEqual(voiceThinkingPeak(0), 0);
  assert.strictEqual(voiceThinkingPeak(9), voiceThinkingPeak(1)); assert.strictEqual(voiceThinkingPeak(-1), 0);
  assert.ok(Math.abs(20 * Math.log10(voiceThinkingPeak(undefined)) + 30) < 1e-9, 'unknown volume = default');
});

test('the event: at, kind, pops as offsets from at, the old swell fields, a copy of the pops', () => {
  const plan = voiceThinkingCluster({ seed: 8, index: 2 });
  const ev = voiceThinkingEvent(plan, 12345);
  assert.strictEqual(ev.at, 12345); assert.strictEqual(ev.kind, 'cluster'); assert.strictEqual(ev.variant, 'A'); assert.strictEqual(ev.seed, 8); assert.strictEqual(ev.index, 2);
  assert.strictEqual(ev.durationMs, plan.durationMs); assert.strictEqual(ev.gapAfterMs, plan.gapAfterMs);
  assert.deepStrictEqual(ev.pops, plan.pops); assert.notStrictEqual(ev.pops, plan.pops); assert.notStrictEqual(ev.pops[0], plan.pops[0]);
  assert.strictEqual(ev.strength, 1); assert.ok(ev.attackMs >= 10 && ev.decayMs >= 50, 'an orb that only knows one swell still works');
  assert.strictEqual(ev.attackMs + ev.decayMs, ev.durationMs);
  ev.at += 140;   // the sound moves at to when it is heard: the pops follow because they are offsets
  assert.strictEqual(ev.at + ev.pops[0].tMs, 12345 + 140 + plan.pops[0].tMs);
});

test('the schedule of a wait: first sound at 2 s, then previous + length + gap; the same as one clock would make; count / untilMs', () => {
  const s = voiceThinkingSchedule({ seed: 5, count: 4, startAt: 1000 });
  assert.strictEqual(s.length, 4); assert.strictEqual(s[0].at, 3000);
  for (let i = 1; i < 4; i++) assert.strictEqual(s[i].at, s[i - 1].at + s[i - 1].durationMs + s[i - 1].gapAfterMs);
  for (let i = 0; i < 4; i++) assert.deepStrictEqual(s[i].pops, voiceThinkingCluster({ seed: 5, index: i }).pops, 'cluster i of the controller');
  assert.deepStrictEqual(voiceThinkingSchedule({ seed: 5, count: 4, startAt: 1000 }), s, 'deterministic');
  const u = voiceThinkingSchedule({ seed: 5, untilMs: 30000 });
  assert.ok(u.length >= 3 && u.every(e => e.at <= 30000)); assert.ok(u.length < 8);
  assert.strictEqual(voiceThinkingSchedule({ seed: 5, count: 1, firstAtMs: 500 })[0].at, 500);
  assert.deepStrictEqual(voiceThinkingSchedule({ seed: 5, count: 0 }), []);
});

test('the file is browser-safe: no require, only voice / VOICE_ names at the top level, nothing runs at load, no Web Audio or DOM', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ui-voice-thinking.js'), 'utf8');
  assert.ok(!/\brequire\(/.test(src.replace(/module\.exports[^\n]*/g, '')));
  for (const m of src.matchAll(/^(?:async )?(?:function|const|let|var|class) ([A-Za-z0-9_$]+)/gm)) assert.ok(/^(voice|VOICE_)/.test(m[1]), 'top-level name ' + m[1]);
  assert.ok(!/AudioContext|document\.|window\.|Date\.now|Math\.random|performance\./.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'pure: no clock, no randomness of its own, no audio, no DOM');
});

test('the pages load it before the call code, and the server serves it by name', () => {
  for (const [page, script] of [['index.html', 'app.js'], ['mobile.html', 'mobile.js']]) {
    const html = fs.readFileSync(path.join(__dirname, '..', page), 'utf8');
    const a = html.indexOf('<script src="/ui-voice-thinking.js"></script>'), b = html.indexOf('<script src="' + script + '"></script>');
    assert.ok(a > 0 && a < b, page);
  }
  const sf = require('../lib/static-files');
  const real = sf.resolve('/ui-voice-thinking.js');
  assert.ok(real && real.endsWith(path.join('lib', 'ui-voice-thinking.js')));
});
