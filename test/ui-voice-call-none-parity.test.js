'use strict';
// With display None the call's thinking sound behaves as in commit cd112d2 (before the shared thinking clock) in everything but the
// intentional new timbre and rhythm (quiet seeded pop clusters with a 4-6 s gap instead of a pulse every 2.5 s): the same first sound
// 2 s into a wait, the same VAD playback notices, the same silence when the sound is off, the same do-not-disturb and phase behaviour.
// The base controller is read from git (read-only); the test is skipped when that commit is not available.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
Object.assign(globalThis, require('../lib/ui-voice'), require('../lib/ui-voice-thinking'));
const CUR = require('../lib/ui-voice-call');

let BASE = null;
try {
  const src = execFileSync('git', ['-C', path.join(__dirname, '..'), 'show', 'cd112d2:lib/ui-voice-call.js'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'base-call-'));
  fs.writeFileSync(path.join(dir, 'ui-voice-call.js'), src);
  BASE = require(path.join(dir, 'ui-voice-call.js'));
} catch { BASE = null; }

const tick = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

// One scripted call; returns what was HEARD (oscillator starts with the clock time) and what the VAD was told.
async function drive(M, script, o) {
  o = o || {};
  const t = { now: 0, q: [], id: 1 }, log = [];
  const setTimer = (f, ms) => { const id = t.id++; t.q.push({ id, at: t.now + ms, f }); return id; };
  const clearTimer = (id) => { t.q = t.q.filter(x => x.id !== id); };
  const adv = async (ms) => {
    const end = t.now + ms;
    for (;;) { const n = t.q.filter(x => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0]; if (!n) break; t.q = t.q.filter(x => x !== n); t.now = n.at; n.f(); await tick(); }
    t.now = end; await tick();
  };
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {}, exponentialRampToValueAtTime() {}, setTargetAtTime() {} });
  const ctx = { state: 'running', destination: {}, resume() { return Promise.resolve(); },
    createGain() { return { gain: param(), connect() {}, disconnect() {} }; },
    createBiquadFilter() { return { type: '', frequency: param(), Q: param(), connect() {}, disconnect() {} }; },
    createOscillator() { return { type: '', frequency: param(), connect() {}, start() { log.push('osc@' + t.now); }, stop() {}, disconnect() {} }; } };
  Object.defineProperty(ctx, 'currentTime', { get: () => t.now / 1000 });
  const snd = M.voiceCreateThinkingSound({ ctx, volume: 0.5, seed: 3, setInterval: (f, ms) => { const id = t.id++; const arm = () => t.q.push({ id, at: t.now + ms, f: () => { f(); arm(); } }); arm(); return id; }, clearInterval: clearTimer, perfNow: () => t.now });
  let prefs = Object.assign({ continueWait: 0 }, o.prefs || {}), running = false, vadH = null;
  const deps = { agent: 'a', thinkingPlan: { seed: 3 }, now: () => t.now, setTimer, clearTimer, prefs: () => prefs, thinking: snd,
    vad: { start: async (h) => { vadH = h; }, stop() {}, setPlaybackActive: (b) => log.push('vad ' + b + '@' + t.now) },
    stt: async (a) => a.text, isTurnRunning: () => running, send: async () => { running = true; }, interject: async () => {}, stop() {}, cancelSpeech() {}, answerAsk() {},
    speak: () => new Promise(() => {}),
    server: { start: async () => ({ callId: 'c', held: [] }), heartbeat: async () => ({ callId: 'c', held: [] }), mode: async () => {}, end: async () => ({ held: [] }), decide: async () => {} },
    ui: Object.assign({ state() {}, heard() {}, held() {}, toast() {}, summary() {} }, o.display ? { thinkingPulse() {}, thinkingWanted: () => false } : {}) };
  if (o.perf) deps.perfNow = () => t.now + 5000;
  const call = M.voiceCreateCall(deps);
  await call.start();
  const H = { adv, call, setPrefs: (p) => { prefs = Object.assign({}, prefs, p); call.setPrefs(); },
    say: async (text) => { vadH.onSpeechStart(); vadH.onSpeechEnd({ text }); await tick(); }, log, t };
  await script(H);
  call.hangUp && quiet(() => call.hangUp());
  return log;
}
const quiet = (f) => { try { return f(); } catch { return undefined; } };

const SCRIPTS = {
  'plain wait: first pulse at 2 s, then every 2.5 s': async (H) => { await H.say('Please check the system status.'); await H.adv(9000); },
  'sound off from the start: nothing is heard': async (H) => { H.setPrefs({ thinkingSound: false }); await H.say('Please check the system status.'); await H.adv(9000); },
  'do-not-disturb does not mute it': async (H) => { H.call.setMode('dnd'); await H.say('Please check the system status.'); await H.adv(9000); },
  'do-not-disturb set mid-wait': async (H) => { await H.say('Please check the system status.'); await H.adv(3000); H.call.setMode('dnd'); await H.adv(6000); H.call.setMode('announce'); await H.adv(3000); },
  'off then on mid-wait starts a fresh 2 s wait': async (H) => {
    await H.say('Please check the system status.'); await H.adv(3000);
    H.setPrefs({ thinkingSound: false }); await H.adv(1300); H.setPrefs({ thinkingSound: true }); await H.adv(9000);
  },
  'off during the first 2 s, on again after': async (H) => {
    await H.say('Please check the system status.'); await H.adv(500); H.setPrefs({ thinkingSound: false }); await H.adv(2500); H.setPrefs({ thinkingSound: true }); await H.adv(8000);
  },
  'the person speaks again in the middle': async (H) => {
    await H.say('Please check the system status.'); await H.adv(4000);
    await H.say('And also the disk space please.'); await H.adv(9000);
  },
  'volume change mid-wait': async (H) => { await H.say('Please check the system status.'); await H.adv(2600); H.setPrefs({ thinkingVolume: 0.2 }); await H.adv(6000); },
};

// One entry per cluster: its pops are scheduled in the same instant, so the times are de-duplicated.
const clusterTimes = (log) => [...new Set(log.filter(x => x.startsWith('osc@')))].map(x => Number(x.slice(4)));
const vadLog = (log) => log.filter(x => x.startsWith('vad '));

for (const [name, script] of Object.entries(SCRIPTS)) {
  test('display None keeps the thinking sound as at cd112d2 (new timbre and rhythm aside): ' + name, { skip: BASE ? false : 'base commit not available' }, async () => {
    const before = await drive(BASE, script);
    const none = await drive(CUR, script, { display: true });             // a page whose display says "no view shown"
    const bare = await drive(CUR, script, { display: false });            // a call with no display hook at all
    assert.deepStrictEqual(none, bare, 'None and no display hook sound the same');
    assert.deepStrictEqual(vadLog(none), vadLog(before), 'the same VAD playback notices at the same moments');
    const was = clusterTimes(before), now = clusterTimes(none);
    assert.strictEqual(now.length > 0, was.length > 0, 'sound or silence, as before');
    if (was.length) assert.strictEqual(now[0], was[0], 'the first sound is at the same moment (2 s into the wait)');
    if (now.length > 1 && name.startsWith('plain wait')) assert.ok(now[1] - now[0] >= 5500 && now[1] - now[0] <= 8200, 'the next cluster: its length + a 4-6 s gap: ' + (now[1] - now[0]));
  });
}

test('display None: the new rhythm is quiet: a plain 9 s wait has the first cluster at 2 s and no second one before 7.5 s', { skip: BASE ? false : 'base commit not available' }, async () => {
  const before = clusterTimes(await drive(BASE, SCRIPTS['plain wait: first pulse at 2 s, then every 2.5 s']));
  const none = clusterTimes(await drive(CUR, SCRIPTS['plain wait: first pulse at 2 s, then every 2.5 s'], { display: true }));
  assert.deepStrictEqual(before.slice(0, 3), [2000, 4500, 7000], 'before: every 2.5 s');
  assert.strictEqual(none[0], 2000); assert.ok(none.length === 1 || none[1] >= 7500, 'now: ' + none.join());
});

test('display None: the sound never receives an event object and no picture event is sent', async () => {
  const seen = [];
  await drive({ ...CUR, voiceCreateThinkingSound: (op) => { const s = CUR.voiceCreateThinkingSound(op); const p = s.pulse; s.pulse = (ev) => { seen.push(ev === undefined ? 'none' : 'ev'); return p(ev); }; return s; }, voiceCreateCall: CUR.voiceCreateCall },
    async (H) => { await H.say('Please check the system status.'); await H.adv(8000); }, { display: true });
  assert.ok(seen.length >= 2 && seen.every(x => x === 'none'), seen.join());
});
