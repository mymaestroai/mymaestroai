'use strict';
// A lost connection ends the call: the link watch (fake timers, scripted probe), the controller's setLinkLost, the two-tone, and the
// page wiring (source checks on app.js and mobile.js). The display's "Connection lost" line is tested in ui-call-display.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
Object.assign(globalThis, require('../lib/ui-voice'));
const { voiceCreateCall, voiceCreateLinkWatch, voiceLinkTone } = require('../lib/ui-voice-call');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const tick = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

function clock() {
  const c = { t: 0, timers: [], nextId: 1 };
  c.setTimeout = (fn, ms) => { const id = c.nextId++; c.timers.push({ id, at: c.t + ms, fn }); return id; };
  c.clearTimeout = (id) => { c.timers = c.timers.filter(x => x.id !== id); };
  c.now = () => c.t;
  c.advance = async (ms) => {
    const end = c.t + ms;
    for (;;) {
      const due = c.timers.filter(x => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      c.timers = c.timers.filter(x => x !== due); c.t = due.at; due.fn(); await tick();
    }
    c.t = end; await tick();
  };
  return c;
}
// A watch with a scripted probe: every probe started waits in w.probes; w.answer(ok) settles the oldest.
function watch(over) {
  const c = clock(), w = { c, ev: [], probes: [] };
  w.probe = () => new Promise((resolve) => { w.probes.push(resolve); w.ev.push('probe@' + c.t); });
  w.answer = async (ok) => { const r = w.probes.shift(); r(ok); await tick(); };
  w.watch = voiceCreateLinkWatch(Object.assign({ probe: w.probe, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, now: c.now,
    onLost: () => w.ev.push('lost@' + c.t), onBack: () => w.ev.push('back@' + c.t), onGiveUp: () => w.ev.push('giveup@' + c.t) }, over || {}));
  return w;
}
const nonProbe = (w) => w.ev.filter(e => !e.startsWith('probe'));

test('link watch: probes every 5 s while the link is fine, and a good answer changes nothing', async () => {
  const w = watch(); w.watch.start();
  await w.c.advance(4999); assert.deepStrictEqual(w.ev, []);
  await w.c.advance(1); await w.answer(true);
  await w.c.advance(5000); await w.answer(true);
  assert.deepStrictEqual(w.ev, ['probe@5000', 'probe@10000']);
  assert.strictEqual(w.watch.lost, false);
  w.watch.stop();
});

test('link watch: a failed probe is lost once, then 1 s probes; a success within 10 s is back once and the rhythm returns to 5 s', async () => {
  const w = watch(); w.watch.start();
  await w.c.advance(5000); await w.answer(false);
  assert.deepStrictEqual(w.ev, ['probe@5000', 'lost@5000']); assert.strictEqual(w.watch.lost, true);
  await w.c.advance(1000); await w.answer(false);
  await w.c.advance(1000); await w.answer(false);
  await w.c.advance(1000); await w.answer(true);
  assert.deepStrictEqual(nonProbe(w), ['lost@5000', 'back@8000']);
  assert.deepStrictEqual(w.ev.filter(e => e.startsWith('probe')), ['probe@5000', 'probe@6000', 'probe@7000', 'probe@8000']);
  assert.strictEqual(w.watch.lost, false);
  await w.c.advance(4999); assert.strictEqual(w.probes.length, 0);
  await w.c.advance(1); assert.strictEqual(w.probes.length, 1, 'back to 5 s');
  w.watch.stop();
});

test('link watch: no success for 10 s gives up once and never probes again', async () => {
  const w = watch(); w.watch.start();
  await w.c.advance(5000); await w.answer(false);
  for (let i = 0; i < 9; i++) { await w.c.advance(1000); await w.answer(false); }
  assert.deepStrictEqual(nonProbe(w), ['lost@5000'], 'not yet: 9 s');
  await w.c.advance(1000);
  assert.deepStrictEqual(nonProbe(w), ['lost@5000', 'giveup@15000']);
  const n = w.ev.length; w.probes.length = 0;
  await w.c.advance(60000);
  assert.strictEqual(w.ev.length, n, 'nothing runs after the give-up');
  w.watch.report(); w.watch.offline(); w.watch.online(); await tick();
  assert.strictEqual(w.ev.length, n);
});

test('link watch: report() and offline() mark it lost at once, once per outage; online() probes at once', async () => {
  for (const how of ['report', 'offline']) {
    const w = watch(); w.watch.start();
    await w.c.advance(1000);
    w.watch[how](); w.watch[how]();
    assert.deepStrictEqual(w.ev, ['lost@1000'], how + ': at once, once');
    await w.c.advance(1000); assert.strictEqual(w.probes.length, 1, how + ': 1 s probes');
    w.watch.stop();
  }
  const w = watch(); w.watch.start(); w.watch.offline();
  assert.strictEqual(w.probes.length, 0);
  w.watch.online(); await tick();
  assert.deepStrictEqual(w.ev, ['lost@0', 'probe@0'], 'online() probes now');
  await w.answer(true);
  assert.deepStrictEqual(w.ev, ['lost@0', 'probe@0', 'back@0']);
  w.watch.stop();
});

test('link watch: never two probes at once (a slow probe), and a second outage after back is announced again', async () => {
  const w = watch(); w.watch.start();
  await w.c.advance(5000);
  w.watch.online(); w.watch.online(); await w.c.advance(2000);   // the first probe has not answered
  assert.strictEqual(w.probes.length, 1, 'one in flight');
  await w.answer(true);
  await w.c.advance(5000); await w.answer(false); await w.c.advance(1000); await w.answer(true); await w.c.advance(5000); await w.answer(false);
  assert.deepStrictEqual(nonProbe(w), ['lost@12000', 'back@13000', 'lost@18000']);
  w.watch.stop();
});

test('link watch: stop() silences everything, including a probe that resolves late', async () => {
  const w = watch(); w.watch.start();
  await w.c.advance(5000);   // a probe is out
  w.watch.stop();
  await w.answer(false);
  assert.deepStrictEqual(w.ev, ['probe@5000'], 'the late failure is ignored');
  w.watch.report(); w.watch.offline(); w.watch.online(); await w.c.advance(60000);
  assert.deepStrictEqual(w.ev, ['probe@5000']); assert.strictEqual(w.c.timers.length, 0);
  const v = watch(); v.watch.start(); v.watch.report(); v.watch.stop(); await v.c.advance(60000);   // stop() during an outage: no give-up
  assert.deepStrictEqual(nonProbe(v), ['lost@0']);
});

test('link watch: a probe that throws counts as failed; a listener that throws does not break it', async () => {
  const w = watch({ probe: () => { throw new Error('x'); }, onLost: () => { throw new Error('listener'); } });
  w.watch.start(); await w.c.advance(5000);
  assert.strictEqual(w.watch.lost, true);
  w.watch.stop();
});

test('voiceLinkTone: descending when lost, rising when back, and never throws', () => {
  const made = [];
  const ctx = { currentTime: 1, destination: {}, createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {} }; },
    createOscillator() { const o = { type: '', frequency: { value: 0 }, connect() {}, start(t) { o.t = t; }, stop() {} }; made.push(o); return o; } };
  assert.strictEqual(voiceLinkTone(ctx, false), true);
  assert.deepStrictEqual(made.map(o => o.frequency.value), [660, 440]);
  assert.ok(Math.abs((made[1].t - made[0].t) - 0.16) < 0.001, '160 ms apart');
  made.length = 0; voiceLinkTone(ctx, true);
  assert.deepStrictEqual(made.map(o => o.frequency.value), [440, 660]);
  assert.strictEqual(voiceLinkTone(null, true), false);
  assert.strictEqual(voiceLinkTone({ createOscillator() { throw new Error('closed'); }, createGain() {} }, true), false);
});

// ---- the controller ----
function harness(over) {
  const c = clock(), h = { c, spoken: [], pend: [], sent: [], toasts: [], sttCalls: 0 };
  h.speak = (text) => new Promise((resolve) => { h.spoken.push(text); h.pend.push(resolve); });
  h.deps = {
    agent: 'a1', now: c.now, setTimer: c.setTimeout, clearTimer: c.clearTimeout, prefs: () => ({ continueWait: 0 }),
    vad: { start: async (hd) => { h.hd = hd; }, stop() {}, setPlaybackActive() {} },
    stt: async (audio) => { h.sttCalls++; return audio.text; }, isTurnRunning: () => false,
    send: async (t) => { h.sent.push(t); }, interject: async () => {}, stop() {}, speak: h.speak, cancelSpeech() { const r = h.pend.shift(); if (r) r(false); }, answerAsk() {},
    server: { start: async () => ({ callId: 'c1', held: [] }), heartbeat: async () => ({ held: [] }), mode: async () => {}, end: async () => ({ held: [] }), decide: async () => {} },
    ui: { state() {}, heard() {}, held() {}, toast: (m) => h.toasts.push(m), summary() {} },
  };
  Object.assign(h.deps, over || {});
  h.call = voiceCreateCall(h.deps);
  h.say = async (text) => { h.hd.onSpeechStart(); h.hd.onSpeechEnd({ text }); await tick(); };
  h.finish = async () => { const r = h.pend.shift(); if (r) r(true); await tick(); };
  return h;
}

test('controller: setLinkLost(true) drops what is heard (not transcribed, not sent) and speaks nothing', async () => {
  const h = harness(); await h.call.start();
  await h.say('hello there'); assert.deepStrictEqual(h.sent, ['hello there'], 'baseline: sent while the link is fine');
  h.call.setLinkLost(true);
  await h.say('are you still there'); await h.c.advance(3000);
  assert.deepStrictEqual(h.sent, ['hello there'], 'dropped');
  assert.strictEqual(h.sttCalls, 1, 'not even uploaded');
  assert.deepStrictEqual(h.spoken, []); assert.deepStrictEqual(h.toasts, []);
});

test('controller: a send or transcription that fails while the link is lost says nothing; the same failure with a good link still does', async () => {
  const a = harness({ send: async () => { throw new TypeError('Failed to fetch'); } }); await a.call.start();
  await a.say('hello there'); await a.c.advance(10);
  assert.deepStrictEqual(a.spoken, ['That did not go through.']); assert.deepStrictEqual(a.toasts, ['Could not send that.']);
  const b = harness(); await b.call.start();
  b.deps.send = async () => { b.call.setLinkLost(true); throw new TypeError('Failed to fetch'); };   // the page marks the link lost, then the request fails
  await b.say('hello there'); await b.c.advance(10);
  assert.deepStrictEqual(b.spoken, [], 'no error speech'); assert.deepStrictEqual(b.toasts, [], 'no error toast');
  const s = harness(); await s.call.start();
  s.deps.stt = async () => { s.call.setLinkLost(true); throw new TypeError('Failed to fetch'); };
  await s.say('hello there'); await s.c.advance(10);
  assert.deepStrictEqual(s.toasts, [], 'no "Could not transcribe that."'); assert.deepStrictEqual(s.sent, []);
});

test('controller: setLinkLost(false) after an outage speaks "Reconnected." once; the call carries on', async () => {
  const h = harness(); await h.call.start();
  h.call.setLinkLost(true); h.call.setLinkLost(true);
  h.call.setLinkLost(false); await tick();
  assert.deepStrictEqual(h.spoken, ['Reconnected.']);
  h.call.setLinkLost(false); await tick(); assert.deepStrictEqual(h.spoken, ['Reconnected.'], 'once');
  await h.finish();
  await h.say('carry on please');
  assert.deepStrictEqual(h.sent, ['carry on please'], 'sending works again');
});

test('controller: "Reconnected." is a mic line: a barge-in keeps it and it is said when the person stops', async () => {
  const h = harness(); await h.call.start();
  h.call.setLinkLost(true); h.call.setLinkLost(false); await tick();
  assert.deepStrictEqual(h.spoken, ['Reconnected.']);
  h.hd.onSpeechStart(); await tick();   // the person talks over it
  h.hd.onSpeechEnd({ text: 'go on' }); await tick(); await h.c.advance(10);
  assert.ok(h.spoken.filter(t => t === 'Reconnected.').length >= 2, 'said again after the barge-in: ' + JSON.stringify(h.spoken));
});

test('controller: nothing changes when the link was never lost', async () => {
  const h = harness(); await h.call.start();
  h.call.setLinkLost(false); await tick();
  assert.deepStrictEqual(h.spoken, []);
  await h.say('hello there'); assert.deepStrictEqual(h.sent, ['hello there']); assert.strictEqual(h.sttCalls, 1);
  assert.strictEqual(typeof h.call.setLinkLost, 'function');
});

// ---- the pages ----
for (const [file, kind] of [['mobile.js', 'phone'], ['app.js', 'desktop']]) {
  const phone = kind === 'phone';
  const startSig = phone ? 'function voiceCallStart()' : 'async function voiceCallStart(chatId)';
  test(`${file}: the call creates and starts the link watch, stops it at teardown, reports network failures and handles offline / online`, () => {
    const src = read(file);
    const fn = (name, n = 6000) => { const a = src.indexOf(name); assert.ok(a > 0, name + ' exists'); return src.slice(a, a + n); };
    assert.match(src, /fetch\('\/health', \{ cache: 'no-store', credentials: 'include'/, 'the probe');
    assert.match(src, /\}, 4000\);/, '4 s limit'); assert.match(src, /new AbortController|typeof AbortController/);
    assert.match(fn(startSig), /voiceLinkMake\(/, 'created at call start');
    assert.match(fn(startSig), /link\.start\(\)/, 'started at call start');
    assert.match(fn(phone ? 'function voiceCallTeardown(vc)' : 'function voiceCallTeardown()', 2500), /link\.stop\(\)/, 'stopped at teardown');
    const mk = fn(phone ? 'function voiceLinkMake(vc)' : 'function voiceLinkMake(call)', 1500);
    assert.match(mk, /voiceCreateLinkWatch\(/); assert.match(mk, /voiceLinkTone\(/); assert.match(mk, /setLinkLost/);
    assert.match(mk, /onLost[\s\S]*onBack[\s\S]*onGiveUp/);
    const reports = src.match(/voiceLinkNetFail\(/g) || [];
    assert.ok(reports.length >= (phone ? 6 : 5), 'network failures reported: ' + reports.length);
    const nf = fn('function voiceLinkNetFail(', 700);
    assert.match(nf, /link\.report\(\)/); assert.match(nf, /TypeError/, 'a failed fetch, not an HTTP status');
    assert.match(src, /addEventListener\('offline'[^\n]*link\.offline\(\)/); assert.match(src, /addEventListener\('online'[^\n]*link\.online\(\)/);
    const paint = fn(phone ? 'function voiceLinkPaint(vc, on)' : 'function voiceLinkPaint(on)', 700);
    assert.match(paint, /VOICE_LINK_LOST_TEXT/); assert.match(paint, /voiceDisplayHook\('connLost'/);
    assert.match(src, /VOICE_LINK_LOST_TEXT = 'Connection lost'/);
  });
  test(`${file}: giving up ends the call with the immediate release (no goodbye) and leaves "Call ended: connection lost"`, () => {
    const src = read(file);
    const a = src.indexOf(phone ? 'function voiceCallLinkGiveUp(vc)' : 'function voiceCallLinkGiveUp(call)'); assert.ok(a > 0);
    const body = src.slice(a, src.indexOf('function voiceLinkMake', a));
    assert.match(body, /voiceCallRelease\('link'\)/, 'the same immediate path as leaving the app');
    assert.doesNotMatch(body, /hangUp|voiceDispEnd\(true\)/, 'no goodbye');
    assert.match(body, phone ? /voiceEndedBar\(true, VOICE_LINK_ENDED_TEXT\)/ : /appendSystemNotice\(chatId, VOICE_LINK_ENDED_TEXT\)/);
    assert.match(src, /VOICE_LINK_ENDED_TEXT = 'Call ended: connection lost'/);
    assert.doesNotMatch(body, /sendMessage|api\(|fetch/, 'never sent to the agent');
    if (!phone) assert.match(body, /voiceLeftNoticeHide\(\)/, 'not the "left the app" note');
  });
}
