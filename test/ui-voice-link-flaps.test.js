'use strict';
// Link flaps: a healthy-but-slow link is never shown or spoken as lost, a transcript that arrives is never dropped, a real outage is still detected.
// Link watch: probe() may answer true / false / null (unknown); ONE failure = suspect, TWO in a row = lost; alive() = a real response arrived.
// Controller: the link state never discards a transcript; d.prefetch(text) gets the one next line.
const { test } = require('node:test');
const assert = require('node:assert');
Object.assign(globalThis, require('../lib/ui-voice'));
const { voiceCreateCall, voiceCreateLinkWatch } = require('../lib/ui-voice-call');
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
function watch(over) {
  const c = clock(), w = { c, ev: [], probes: [] };
  w.probe = () => new Promise((resolve) => { w.probes.push(resolve); w.ev.push('probe@' + c.t); });
  w.answer = async (r) => { const f = w.probes.shift(); f(r); await tick(); };
  w.watch = voiceCreateLinkWatch(Object.assign({ probe: w.probe, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, now: c.now,
    onLost: () => w.ev.push('lost@' + c.t), onBack: () => w.ev.push('back@' + c.t), onGiveUp: () => w.ev.push('giveup@' + c.t) }, over || {}));
  return w;
}
const states = (w) => w.ev.filter(e => !e.startsWith('probe'));
const probeTimes = (w) => w.ev.filter(e => e.startsWith('probe')).map(e => Number(e.slice(6)));

test('flaps: one failed probe is not lost; it probes again after 1 s (suspect)', async () => {
  const w = watch(); w.watch.start();
  await w.c.advance(5000); await w.answer(false);
  assert.strictEqual(w.watch.lost, false); assert.deepStrictEqual(states(w), []);
  await w.c.advance(999); assert.strictEqual(w.probes.length, 0);
  await w.c.advance(1); assert.strictEqual(w.probes.length, 1, 'the next probe after lostEveryMs');
  w.watch.stop();
});

test('flaps: two failed probes in a row are lost (once), 1 s apart', async () => {
  const w = watch(); w.watch.start();
  await w.c.advance(5000); await w.answer(false); await w.c.advance(1000); await w.answer(false);
  assert.deepStrictEqual(states(w), ['lost@6000']); assert.strictEqual(w.watch.lost, true);
  w.watch.stop();
});

test('flaps: fail, ok, fail is not lost (a success clears the suspicion; the next failure is the first again)', async () => {
  const w = watch(); w.watch.start();
  await w.c.advance(5000); await w.answer(false);
  await w.c.advance(1000); await w.answer(true);
  await w.c.advance(5000); await w.answer(false);
  assert.strictEqual(w.watch.lost, false); assert.deepStrictEqual(states(w), []);
  assert.deepStrictEqual(probeTimes(w).slice(0, 3), [5000, 6000, 11000], 'back to the 5 s rhythm after the ok');
  w.watch.stop();
});

// Decision: an unknown result (null / undefined) changes nothing. It never marks lost, never clears the suspicion (a failure then an unknown then a
// failure is still two failures in a row), and while suspect or lost the next probe follows after lostEveryMs, else after everyMs.
test('flaps: unknown results never mark lost and never clear the suspicion', async () => {
  const w = watch({ unknownGraceMs: 1e9 }); w.watch.start();   // (the grace is tested below: unknowns alone are not lost only while the link was last known good)
  for (let i = 0; i < 6; i++) { await w.c.advance(5000); await w.answer(null); }
  await w.c.advance(5000); await w.answer(undefined);
  assert.strictEqual(w.watch.lost, false); assert.deepStrictEqual(states(w), [], 'unknowns alone never mark lost');
  assert.deepStrictEqual(probeTimes(w).slice(0, 3), [5000, 10000, 15000], 'unknown while fine: still every 5 s');
  w.watch.stop();
  const v = watch(); v.watch.start();
  await v.c.advance(5000); await v.answer(false);                       // suspect
  await v.c.advance(1000); await v.answer(null);                        // unknown: nothing changes, still suspect
  assert.strictEqual(v.watch.lost, false);
  await v.c.advance(1000); assert.strictEqual(v.probes.length, 1, 'suspect: probe again after 1 s');
  await v.answer(false);
  assert.deepStrictEqual(states(v), ['lost@7000'], 'fail, unknown, fail = two failures in a row');
  v.watch.stop();
});

test('flaps: unknown while lost is not back; it keeps probing every 1 s and the give-up deadline stands', async () => {
  const w = watch(); w.watch.start(); w.watch.offline();
  for (let i = 0; i < 9; i++) { await w.c.advance(1000); await w.answer(null); }
  assert.deepStrictEqual(states(w), ['lost@0']);
  await w.c.advance(1000);
  assert.deepStrictEqual(states(w), ['lost@0', 'giveup@10000']);
});

test('flaps: a probe that failed while a real response arrived (alive) after it left counts as unknown', async () => {
  const w = watch(); w.watch.start();
  await w.c.advance(5000);            // a probe is out
  w.watch.alive();                    // a real response comes in
  await w.answer(false);              // not trusted: unknown, nothing changes (and the next probe is routine, 5 s)
  await w.c.advance(5000); assert.strictEqual(w.probes.length, 1);
  await w.answer(false);              // the first trusted failure: only suspect
  assert.strictEqual(w.watch.lost, false, 'the first failure was not trusted: the second is only the first failure');
  assert.deepStrictEqual(probeTimes(w), [5000, 10000]);
  w.watch.stop();
});

test('flaps: alive() while fine clears the suspicion and pushes the next probe to 5 s from now', async () => {
  const w = watch(); w.watch.start();
  await w.c.advance(5000); await w.answer(false);          // suspect
  await w.c.advance(500); w.watch.alive();                  // t = 5500
  await w.c.advance(4999); assert.strictEqual(w.probes.length, 0, 'the suspect probe at 6000 is pushed out');
  await w.c.advance(1); assert.strictEqual(w.probes.length, 1, 'at 5500 + 5000 = 10500');
  assert.strictEqual(w.c.t, 10500);
  await w.answer(false); await w.c.advance(1000); await w.answer(false);
  assert.deepStrictEqual(states(w), ['lost@11500'], 'the suspicion was cleared: it takes two new failures');
  w.watch.stop();
});

test('flaps: alive() while lost is back at once (onBack once), also for a request sent before the loss; the rhythm returns to 5 s', async () => {
  const w = watch(); w.watch.start();
  await w.c.advance(2000); w.watch.report();
  assert.deepStrictEqual(states(w), ['lost@2000']);
  await w.c.advance(500); w.watch.alive(); w.watch.alive();
  assert.deepStrictEqual(states(w), ['lost@2000', 'back@2500'], 'back once');
  assert.strictEqual(w.watch.lost, false);
  await w.c.advance(4999); assert.strictEqual(w.probes.length, 0);
  await w.c.advance(1); assert.strictEqual(w.probes.length, 1);
  w.watch.stop();
});

test('flaps: alive() after the give-up or stop() does nothing; after the deadline but before the give-up timer it does nothing either', async () => {
  const w = watch(); w.watch.start(); w.watch.offline();
  await w.c.advance(10000);
  assert.deepStrictEqual(states(w), ['lost@0', 'giveup@10000']);
  w.watch.alive(); await tick(); await w.c.advance(60000);
  assert.deepStrictEqual(states(w), ['lost@0', 'giveup@10000'], 'no back after give-up');
  const v = watch(); v.watch.start(); v.watch.offline(); v.watch.stop(); v.watch.alive(); await v.c.advance(60000);
  assert.deepStrictEqual(states(v), ['lost@0'], 'nothing after stop');
  const u = watch({ giveUpMs: 10000 }); u.watch.start(); u.watch.offline();
  u.c.t = 10001; u.watch.alive();                      // the deadline passed (the timer has not run yet)
  assert.deepStrictEqual(states(u), ['lost@0'], 'too late for alive()');
});

test('flaps: report() and offline() still mark lost at once (even while suspect)', async () => {
  for (const how of ['report', 'offline']) {
    const w = watch(); w.watch.start();
    await w.c.advance(5000); await w.answer(false);    // suspect
    w.watch[how]();
    assert.deepStrictEqual(states(w), ['lost@5000'], how); assert.strictEqual(w.watch.lost, true);
    w.watch.stop();
  }
});

test('flaps: a real outage (every probe fails) is lost after two and gives up giveUpMs after the loss', async () => {
  const w = watch(); w.watch.start();
  await w.c.advance(5000); await w.answer(false);
  for (let i = 0; i < 15; i++) { await w.c.advance(1000); if (w.probes.length) await w.answer(false); }
  assert.deepStrictEqual(states(w), ['lost@6000', 'giveup@16000']);
  w.watch.stop();
});

test('flaps: a late probe after give-up is ignored; one probe in flight at a time', async () => {
  const w = watch(); w.watch.start(); w.watch.offline();
  await w.c.advance(10000);   // give-up; a probe may be out
  const n = w.ev.length; while (w.probes.length) await w.answer(true);
  assert.strictEqual(w.ev.length, n);
  const v = watch(); v.watch.start(); await v.c.advance(5000); v.watch.online(); v.watch.online(); await tick();
  assert.strictEqual(v.probes.length, 1);
  v.watch.stop();
});

// ---- the controller ----
function harness(over) {
  const c = clock(), h = { c, spoken: [], pend: [], sent: [], toasts: [] };
  h.deps = {
    agent: 'a1', now: c.now, setTimer: c.setTimeout, clearTimer: c.clearTimeout, prefs: () => ({ continueWait: 0 }),
    vad: { start: async (hd) => { h.hd = hd; }, stop() {}, setPlaybackActive() {} },
    stt: async (audio) => { if (audio.gate) await audio.gate; if (audio.fail) throw new TypeError('Failed to fetch'); return audio.text; }, isTurnRunning: () => false,
    send: async (t) => { h.sent.push(t); }, interject: async () => {}, stop() {},
    speak: (text) => new Promise((resolve) => { h.spoken.push(text); h.pend.push(resolve); }),
    cancelSpeech() { const r = h.pend.shift(); if (r) r(false); }, answerAsk() {},
    server: { start: async () => ({ callId: 'c1', held: [] }), heartbeat: async () => ({ held: [] }), mode: async () => {}, end: async () => ({ held: [] }), decide: async () => {} },
    ui: { state() {}, heard() {}, held() {}, toast: (m) => h.toasts.push(m), summary() {} },
  };
  Object.assign(h.deps, over || {});
  h.call = voiceCreateCall(h.deps);
  h.say = async (text, extra) => { h.hd.onSpeechStart(); h.hd.onSpeechEnd(Object.assign({ text }, extra || {})); await tick(); };
  h.finish = async () => { const r = h.pend.shift(); if (r) r(true); await tick(); };
  return h;
}
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };

test('flaps controller: the link marked lost while STT is in flight, then STT resolves with text -> the text is sent, no "Say that again."', async () => {
  const h = harness(); await h.call.start();
  const g = gate();
  await h.say('please do the thing', { gate: g.p });
  h.call.setLinkLost(true); await tick();
  g.open(); await tick(); await tick();
  assert.deepStrictEqual(h.sent, ['please do the thing']);
  h.call.setLinkLost(false); await tick();
  await h.finish(); await h.finish(); await tick();
  assert.deepStrictEqual(h.spoken, ['Reconnected.']);
});

test('flaps controller: marked lost and back again before STT answers, and the text still arrives -> sent, nothing but "Reconnected."', async () => {
  const h = harness(); await h.call.start();
  const g = gate();
  await h.say('slow upload', { gate: g.p });
  h.call.setLinkLost(true); h.call.setLinkLost(false); await tick();
  g.open(); await tick(); await tick();
  await h.finish(); await h.finish(); await tick();
  assert.deepStrictEqual(h.sent, ['slow upload']);
  assert.deepStrictEqual(h.spoken, ['Reconnected.']);
});

test('flaps controller: speech heard while the link is marked lost is still sent to STT (the request is the test)', async () => {
  let calls = 0;
  const h = harness({ stt: async (a) => { calls++; return a.text; } }); await h.call.start();
  h.call.setLinkLost(true);
  await h.say('heard in the outage'); await h.c.advance(100);
  assert.strictEqual(calls, 1); assert.deepStrictEqual(h.sent, ['heard in the outage']);
});

test('flaps controller: STT throws during an outage -> "Reconnected." then "Say that again.", no toast', async () => {
  const h = harness(); await h.call.start();
  h.call.setLinkLost(true);
  await h.say('lost words', { fail: true }); await h.c.advance(100);
  h.call.setLinkLost(false); await tick();
  await h.finish(); await h.finish();
  assert.deepStrictEqual(h.spoken, ['Reconnected.', 'Say that again.']);
  assert.deepStrictEqual(h.sent, []); assert.deepStrictEqual(h.toasts, []);
});

test('flaps controller: STT throws on a good link (never lost) -> the toast, and no "Say that again."', async () => {
  const h = harness(); await h.call.start();
  await h.say('lost words', { fail: true }); await h.c.advance(100);
  assert.deepStrictEqual(h.toasts, ['Could not transcribe that.']); assert.deepStrictEqual(h.spoken, []);
});

test('flaps controller: STT in flight when the link is lost, throws after it is back -> "Say that again." right behind "Reconnected."', async () => {
  const h = harness(); await h.call.start();
  const g = gate();
  await h.say('cut', { gate: g.p, fail: true });
  h.call.setLinkLost(true); h.call.setLinkLost(false); await tick();
  g.open(); await tick(); await tick();
  await h.finish(); await h.finish();
  assert.deepStrictEqual(h.spoken, ['Reconnected.', 'Say that again.']);
  assert.deepStrictEqual(h.toasts, []);
});

test('flaps controller: a standby piece is never sent for a link reason, and says nothing more than "Reconnected."', async () => {
  const h = harness({ wake: () => ({ local: true, phrase: 'hey maestro' }) }); await h.call.start(); h.call.wakeChanged(); await tick();
  h.call.setLinkLost(true);
  await h.say('room talk', { fail: true }); await h.c.advance(100);
  h.call.setLinkLost(false); await tick();
  await h.finish(); await tick();
  assert.deepStrictEqual(h.spoken, ['Reconnected.']); assert.deepStrictEqual(h.sent, []);
});

// ---- the prefetch hook ----
test('flaps prefetch: d.prefetch(text) gets the next waiting line once, when the current line starts; never more than one ahead', async () => {
  const got = [];
  const h = harness({ prefetch: (t) => { got.push(t); } }); await h.call.start();
  await h.say('hello'); await h.c.advance(10);
  h.call.onReplyText('First sentence here. Second sentence here. Third sentence here. ', true); await tick();
  assert.strictEqual(h.spoken[0], 'First sentence here.');
  assert.deepStrictEqual(got, ['Second sentence here.'], 'only the one next line');
  await h.finish();
  assert.strictEqual(h.spoken[1], 'Second sentence here.');
  assert.deepStrictEqual(got, ['Second sentence here.', 'Third sentence here.'], 'each once, one ahead');
  await h.finish(); await h.finish(); await tick();
  assert.deepStrictEqual(got, ['Second sentence here.', 'Third sentence here.'], 'never called twice for a line');
});

test('flaps prefetch: the next line is asked for only AFTER the current line has started (starting a line may stop the previous playback and clear what was fetched ahead)', async () => {
  const order = [];
  let h = null;
  h = harness({ prefetch: (t) => { order.push('prefetch ' + t + ' after ' + h.spoken.length + ' started'); } }); await h.call.start();
  await h.say('hello'); await h.c.advance(10);
  h.call.onReplyText('First sentence here. Second sentence here. ', true); await tick();
  assert.deepStrictEqual(order, ['prefetch Second sentence here. after 1 started'], 'First was handed to d.speak before Second was prefetched');
  await h.finish(); await h.finish();
});

test('flaps prefetch: a line added while another is spoken and that becomes the next is prefetched once; a throwing or missing prefetch is harmless', async () => {
  const got = [];
  const h = harness({ prefetch: (t) => { got.push(t); throw new Error('boom'); } }); await h.call.start();
  const g = gate();
  await h.say('x', { fail: true, gate: g.p });   // in transcription
  h.call.setLinkLost(true); h.call.setLinkLost(false); await tick();   // "Reconnected." is being spoken
  assert.deepStrictEqual(h.spoken, ['Reconnected.']); assert.deepStrictEqual(got, []);
  g.open(); await tick(); await tick();   // its transcription fails after the outage: "Say that again." is queued behind the line being spoken
  assert.deepStrictEqual(got, ['Say that again.'], 'prefetched when it became queue[0]');
  const h2 = harness(); await h2.call.start();
  h2.call.setLinkLost(true); h2.call.setLinkLost(false); await tick();
  assert.deepStrictEqual(h2.spoken, ['Reconnected.'], 'no d.prefetch: nothing breaks');
});

// ── a hung upload must not hide a real outage (review r1 fix): unknown for longer than unknownGraceMs counts as a failed probe ──
async function runUnknown(w, ms, step = 1000) {   // every probe the watch makes is answered "unknown"; time moves in steps
  for (let t = 0; t < ms; t += step) { await w.c.advance(step); while (w.probes.length) await w.answer(null); }
}
test('flaps: every probe unknown (a hung upload, a silently dead link) -> lost after the grace, then give-up', async () => {
  const w = watch(); w.watch.start();
  await runUnknown(w, 40000);
  const lost = states(w).find(e => e.startsWith('lost@'));
  assert.ok(lost, 'a real outage behind a hung upload is noticed: ' + states(w));
  const at = Number(lost.slice(5));
  assert.ok(at > 12000 && at <= 12000 + 2 * 5000, 'lost within about the grace + 2 probe intervals, got ' + at);
  assert.deepStrictEqual(states(w), ['lost@' + at, 'giveup@' + (at + 10000)], 'then the give-up after giveUpMs');
});
test('flaps: unknown results within the grace after an alive() are not lost; an alive() resets the grace', async () => {
  const w = watch(); w.watch.start();
  await runUnknown(w, 11000);
  w.watch.alive();                                  // t = 11000: the link answered
  await runUnknown(w, 11000);                       // t = 22000: 11 s after the alive, 22 s after the start
  assert.deepStrictEqual(states(w), [], 'within the grace of the last alive(): still unknown, not lost');
  w.watch.alive();                                  // t = 22000 again resets it
  await runUnknown(w, 11000);
  assert.deepStrictEqual(states(w), []);
  await runUnknown(w, 8000);                        // now more than 12 s since the last alive
  assert.ok(states(w).some(e => e.startsWith('lost@')), 'after the grace runs out with nothing good, it is lost');
});
test('flaps: progress() (a transfer of the call started) makes the grace count from then: one long upload on a slow link is not an outage; a hung one still is', async () => {
  const w = watch(); w.watch.start();
  await runUnknown(w, 10000);
  w.watch.progress();                               // t = 10000: a 25 s upload starts on a slow link; every probe behind it is unknown
  await runUnknown(w, 11000);                       // t = 21000: 21 s since the start, 11 s since the transfer began
  assert.deepStrictEqual(states(w), [], 'the grace counts from the transfer start, not from the call start');
  w.watch.alive();                                  // the upload's answer arrives
  assert.deepStrictEqual(states(w), []);
  const h = watch(); h.watch.start();
  await h.c.advance(3000); h.watch.progress();      // t = 3000: an upload starts and hangs; the link is silently dead
  await runUnknown(h, 30000);
  const lost = states(h).find(e => e.startsWith('lost@'));
  assert.ok(lost && Number(lost.slice(5)) > 15000 && Number(lost.slice(5)) <= 3000 + 12000 + 2 * 5000, 'the hung transfer runs out the grace from its start: ' + states(h));
  const l = watch(); l.watch.start();
  await runUnknown(l, 30000);                       // lost by now
  assert.ok(l.watch.lost); l.watch.progress(); assert.ok(l.watch.lost, 'progress() never brings a lost link back');
  l.watch.stop();
});

test('flaps: unknownGraceMs is an option (a short one marks lost sooner) and a good probe resets the grace', async () => {
  const w = watch({ unknownGraceMs: 2000 }); w.watch.start();
  await runUnknown(w, 12000);
  const at = Number((states(w).find(e => e.startsWith('lost@')) || 'lost@-1').slice(5));
  assert.ok(at > 2000 && at <= 2000 + 2 * 5000 + 1000, 'short grace: lost at ' + at);
  const v = watch(); v.watch.start();
  await v.c.advance(5000); await v.answer(true);    // good at 5000
  await runUnknown(v, 10000);                       // 10 s after the good probe, inside the grace
  assert.deepStrictEqual(states(v), []);
});
