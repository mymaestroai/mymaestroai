'use strict';
// A slow or lossy link: the call's /health probe must not call the link lost while the call's own upload is in the way (null = unknown),
// a real answer to the call's own requests proves the link (link.alive()), and the next line's speech audio is fetched while the current one plays.
// Page functions are cut out of app.js / mobile.js and run with stubs.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const mob = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
const between = (src, a, b) => { const i = src.indexOf(a); assert.ok(i >= 0, 'missing: ' + a); const j = src.indexOf(b, i + a.length); assert.ok(j > i, 'missing end: ' + b); return src.slice(i, j); };
const tick = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const resp = (status) => ({ status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => ({ text: 'hi' }), blob: async () => ({ size: 3 }), arrayBuffer: async () => new ArrayBuffer(3) });

// Fake timers: the probe's 4 s limit is fired by hand.
function timers() {
  const t = { list: [], id: 1 };
  t.setTimeout = (fn, ms) => { const id = t.id++; t.list.push({ id, fn, ms }); return id; };
  t.clearTimeout = (id) => { t.list = t.list.filter(x => x.id !== id); };
  t.fire = (ms) => { const due = t.list.filter(x => x.ms === ms); t.list = t.list.filter(x => x.ms !== ms); due.forEach(x => x.fn()); };
  return t;
}
class FakeAbort { constructor() { this.signal = {}; } abort() { this.aborted = true; } }

// The probe block of each page (the upload counter, voiceLinkAlive and voiceLinkProbe) with a scripted fetch.
function probeEnv(page, fetchImpl, owner) {
  const t = timers();
  let f;
  if (page === 'phone') {
    const src = between(mob, 'const voiceUp = {', 'function voiceLinkNetFail(');
    f = new Function('fetch', 'setTimeout', 'clearTimeout', 'AbortController', 'voiceCall', src + '\nreturn { voiceUp, voiceUpTrack, voiceLinkProbe, voiceLinkAlive };')(fetchImpl, t.setTimeout, t.clearTimeout, FakeAbort, owner);
  } else {
    const src = between(app, '    const voiceUp = {', '    function voiceLinkNetFail(');
    f = new Function('fetch', 'setTimeout', 'clearTimeout', 'AbortController', 'voiceCallS', src + '\nreturn { voiceUp, voiceUpTrack, voiceLinkProbe, voiceLinkAlive };')(fetchImpl, t.setTimeout, t.clearTimeout, FakeAbort, { call: owner, link: owner && owner.link });
  }
  return { t, f };
}

for (const page of ['phone', 'desktop']) {
  // Detection speed: a HARD failure (a 5xx, a network error) is 'down' (the watch marks lost at once); false is now only a timeout without a transfer of ours.
  test(`${page}: probe resolves true on 200 and below 500, 'down' on 503 / 500 / 502 and on a network error`, async () => {
    for (const [st, want] of [[200, true], [404, true], [503, 'down'], [500, 'down'], [502, 'down']]) {
      assert.strictEqual(await probeEnv(page, async () => resp(st)).f.voiceLinkProbe(), want, `status ${st}`);
    }
    assert.strictEqual(await probeEnv(page, async () => { throw new TypeError('Failed to fetch'); }).f.voiceLinkProbe(), 'down');
    assert.strictEqual(await probeEnv(page, () => { throw new TypeError('sync'); }).f.voiceLinkProbe(), 'down', 'fetch throwing at once');
  });

  test(`${page}: the probe limit is 4000 ms, or 2500 ms when called with { confirm: true }`, async () => {
    for (const [arg, ms] of [[undefined, 4000], [{}, 4000], [{ confirm: false }, 4000], [{ confirm: true }, 2500]]) {
      const { t, f } = probeEnv(page, () => new Promise(() => {}));
      const p = f.voiceLinkProbe(arg);
      assert.deepStrictEqual(t.list.map(x => x.ms), [ms], `limit for ${JSON.stringify(arg)}`);
      t.fire(ms);
      assert.strictEqual(await p, false);
    }
  });

  test(`${page}: the timer's own abort can never make the probe 'down' (it resolves first, the rejection that follows is ignored)`, async () => {
    // (the fake abort rejects the fetch the way a real one does; the timer must already have resolved the probe, so the rejection finds it settled)
    let rejectFetch;
    const t = timers(); let order = [];
    class Ab { constructor() { this.signal = {}; } abort() { order.push('abort'); rejectFetch(new TypeError('The operation was aborted')); } }
    const fetchImpl = () => new Promise((_, rej) => { rejectFetch = rej; });
    let f;
    if (page === 'phone') {
      const src = between(mob, 'const voiceUp = {', 'function voiceLinkNetFail(');
      f = new Function('fetch', 'setTimeout', 'clearTimeout', 'AbortController', 'voiceCall', src + '\nreturn { voiceLinkProbe };')(fetchImpl, t.setTimeout, t.clearTimeout, Ab, null);
    } else {
      const src = between(app, '    const voiceUp = {', '    function voiceLinkNetFail(');
      f = new Function('fetch', 'setTimeout', 'clearTimeout', 'AbortController', 'voiceCallS', src + '\nreturn { voiceLinkProbe };')(fetchImpl, t.setTimeout, t.clearTimeout, Ab, {});
    }
    const p = f.voiceLinkProbe({ confirm: true }).then((r) => { order.push('resolved ' + r); return r; });
    t.fire(2500);
    assert.strictEqual(await p, false, 'a timeout, not a network error');
    assert.deepStrictEqual(order, ['abort', 'resolved false'], 'abort ran, yet the answer is the timeout');
    const src = (page === 'phone' ? mob : app);
    assert.match(src, /setTimeout\(\(\) => \{ resolve\(voiceUp\.n > 0 \|\| voiceUp\.seq !== seq0 \? null : false\); try \{ if \(ac\) ac\.abort\(\)/, 'resolve first, then abort');
  });

  test(`${page}: a timeout with a transfer of ours in flight is null, also for the confirm probe`, async () => {
    const { t, f } = probeEnv(page, () => new Promise(() => {}));
    let release; const up = f.voiceUpTrack(() => new Promise((r) => { release = r; }));
    const p = f.voiceLinkProbe({ confirm: true }); t.fire(2500);
    assert.strictEqual(await p, null);
    release(); await up;
  });

  test(`${page}: probe asks for high fetch priority`, async () => {
    let init = null;
    await probeEnv(page, async (u, i) => { init = i; return resp(200); }).f.voiceLinkProbe();
    assert.strictEqual(init.priority, 'high');
  });

  test(`${page}: probe timeout is unknown (null) while an upload is in flight, false without one`, async () => {
    // no upload: false
    let { t, f } = probeEnv(page, () => new Promise(() => {}));
    let p = f.voiceLinkProbe(); t.fire(4000);
    assert.strictEqual(await p, false);
    // an upload in flight at the timeout: null
    ({ t, f } = probeEnv(page, () => new Promise(() => {})));
    let release; const up = f.voiceUpTrack(() => new Promise((r) => { release = r; }));
    p = f.voiceLinkProbe(); t.fire(4000);
    assert.strictEqual(await p, null);
    release(); await up;
    assert.strictEqual(f.voiceUp.n, 0, 'the counter drops when the upload ends');
    // an upload that started and ended during the probe: still unknown
    ({ t, f } = probeEnv(page, () => new Promise(() => {})));
    p = f.voiceLinkProbe();
    await f.voiceUpTrack(async () => {});
    t.fire(4000);
    assert.strictEqual(await p, null);
    // an upload that failed still decrements
    ({ f } = probeEnv(page, async () => resp(200)));
    await assert.rejects(f.voiceUpTrack(async () => { throw new TypeError('x'); }));
    assert.strictEqual(f.voiceUp.n, 0);
  });

  test(`${page}: a network error with an upload in flight is still 'down' (an outage is reported at once)`, async () => {
    const { f } = probeEnv(page, async () => { throw new TypeError('Failed to fetch'); });
    let release; const up = f.voiceUpTrack(() => new Promise((r) => { release = r; }));
    assert.strictEqual(await f.voiceLinkProbe(), 'down');
    release(); await up;
  });

  test(`${page}: voiceLinkAlive tells only the current call's link, and only when the library has alive()`, () => {
    const calls = [];
    const owner = { agent: 'a', link: { alive: () => calls.push('alive') } };
    const { f } = probeEnv(page, async () => resp(200), owner);
    f.voiceLinkAlive(owner, 'a');
    assert.deepStrictEqual(calls, ['alive']);
    f.voiceLinkAlive(null, 'a'); f.voiceLinkAlive({ agent: 'a', link: { alive: () => calls.push('x') } }, 'a');
    assert.strictEqual(calls.length, 1, 'not the current call');
    if (page === 'phone') { f.voiceLinkAlive(owner, 'other'); assert.strictEqual(calls.length, 1, 'another agent'); }
    const old = { agent: 'a', link: {} };   // an older library: no alive()
    assert.doesNotThrow(() => probeEnv(page, async () => resp(200), old).f.voiceLinkAlive(old, 'a'));
  });
}

// ── alive after a good speech-to-text / text-to-speech answer ──
test('phone: alive after a speech-to-text answer below 500 (and not after a 503), and the upload is counted while in flight', async () => {
  const src = between(mob, 'async function voiceCallStt(', '// One sentence, resolved false');
  const alive = [];
  let seenN = -1; const voiceUp = { n: 0 };
  const voiceUpTrack = async (run) => { voiceUp.n++; try { return await run(); } finally { voiceUp.n--; } };
  const mk = (status) => new Function('api', 'voiceEncodeWav', 'Blob', 'voiceCall', 'voiceLinkNetFail', 'voiceLinkAlive', 'voiceUpTrack', 'voiceCallJson',
    src + '\nreturn voiceCallStt;')(async () => { seenN = voiceUp.n; return resp(status); }, () => new ArrayBuffer(2), Blob, { agent: 'a' }, () => {}, (vc, agent) => alive.push(agent), voiceUpTrack, async (r) => r.json());
  assert.strictEqual(await mk(200)('a', new Float32Array(2)), 'hi');
  assert.deepStrictEqual(alive, ['a']); assert.strictEqual(seenN, 1, 'in flight during the request');
  await assert.rejects(mk(503)('a', new Float32Array(2)));
  assert.strictEqual(alive.length, 1, 'a 503 proves nothing');
  await assert.rejects(mk(400)('a', new Float32Array(2)));
  assert.strictEqual(alive.length, 2, 'a 4xx is a real answer');
});

test('desktop: alive after a speech-to-text answer below 500 (and not after a 503)', async () => {
  const src = between(app, '    async function voiceCallStt(', '    // Reads one line with the hub voice');
  const alive = []; let seenN = -1; const voiceUp = { n: 0 };
  const voiceUpTrack = async (run) => { voiceUp.n++; try { return await run(); } finally { voiceUp.n--; } };
  const mk = (status) => new Function('fetch', 'voiceEncodeWav', 'voiceLinkOwner', 'voiceLinkNetFail', 'voiceLinkAlive', 'voiceUpTrack', 'voiceBusyToast', 'voiceRefreshStatus',
    src + '\nreturn voiceCallStt;')(async () => { seenN = voiceUp.n; return resp(status); }, () => new ArrayBuffer(2), () => 'owner', () => {}, (o) => alive.push(o), voiceUpTrack, () => false, () => {});
  assert.strictEqual(await mk(200)(new Float32Array(2), 'a'), 'hi');
  assert.deepStrictEqual(alive, ['owner']); assert.strictEqual(seenN, 1);
  await assert.rejects(mk(503)(new Float32Array(2), 'a'));
  assert.strictEqual(alive.length, 1);
});

test('desktop: alive after a call request answer below 500 (heartbeat, interjection) and after a text-to-speech answer', async () => {
  const alive = [];
  const apiSrc = between(app, '    async function voiceCallApi(', '    // Speech to text for one utterance');
  const api = (status) => new Function('fetch', 'voiceLinkOwner', 'voiceLinkNetFail', 'voiceLinkAlive', apiSrc + '\nreturn voiceCallApi;')(async () => resp(status), () => 'owner', () => {}, (o) => alive.push(o));
  await api(200)('/api/voice/call', {});
  assert.deepStrictEqual(alive, ['owner']);
  await assert.rejects(api(409)('/api/voice/call', {}));
  assert.strictEqual(alive.length, 2, 'a 409 is a real answer');
  await assert.rejects(api(502)('/api/voice/call', {}));
  assert.strictEqual(alive.length, 2);
  const ttsSrc = between(app, '    async function voiceFetchTts(', '    // Play sentences with the hub voice');
  const tts = (status) => new Function('fetch', 'voiceSpeedFor', 'voiceLinkOwner', 'voiceLinkNetFail', 'voiceLinkAlive', 'voiceBusyToast', 'voiceCallS', ttsSrc + '\nreturn voiceFetchTts;')(async () => resp(status), () => 1, () => 'owner', () => {}, (o) => alive.push(o), () => false, { rec: null });
  await tts(200)('a', 'hello'); assert.strictEqual(alive.length, 3);
  await assert.rejects(tts(503)('a', 'hello')); assert.strictEqual(alive.length, 3);
});

test('phone: alive after a text-to-speech answer below 500, not after a 503', async () => {
  const src = between(mob, 'async function voiceTtsBlob(', 'function voicePlayBlob(');
  const alive = [];
  const mk = (status) => new Function('voiceOn', 'api', 'voiceSpeedFor', 'voicePlay', 'toast', 'voiceCall', 'voiceLinkAlive', 'voiceLinkNetFail', src + '\nreturn voiceTtsBlob;')(
    () => true, async () => resp(status), () => 1, { told: false }, () => {}, { agent: 'a' }, (vc, agent) => alive.push(agent), () => {});
  assert.ok(await mk(200)('a', 'hello'));
  assert.deepStrictEqual(alive, ['a']);
  assert.strictEqual(await mk(503)('a', 'hello'), null);
  assert.strictEqual(alive.length, 1);
});

// ── prefetch ──
// apiImpl(n, body): the n-th request's answer (default 200).
function phoneSpeakEnv(apiImpl) {
  const block = between(mob, 'function voiceStopPlayback() {', 'function voicePlayBlob(') + '\n' + between(mob, 'async function voiceCallSpeak(', "// The recording's consent line");
  const reqs = [];
  const voicePlay = { token: 5, told: false, audio: null, el: null, cancel: null };
  const played = [];
  const env = new Function('voiceOn', 'api', 'voiceSpeedFor', 'voicePlay', 'toast', 'voiceCall', 'voiceLinkAlive', 'voiceLinkNetFail', 'voiceSpeechText', 'voicePlayBlob', 'voicePrefsNow', 'voiceDeviceSpeak', 'window',
    block + '\nreturn { voiceStopPlayback, voicePrefetch, voiceCallSpeak, voicePre };')(
    () => true, async (url, init) => { reqs.push(JSON.parse(init.body)); if (apiImpl) return apiImpl(reqs.length); return resp(200); }, () => 1, voicePlay, () => {}, null, () => {}, () => {}, (s) => String(s).trim(),
    async (b, my, meta) => { played.push(meta.text); return true; }, () => ({ deviceVoiceFallback: false }), async () => {}, {});
  return Object.assign(env, { reqs, voicePlay, played });
}

test('phone: prefetch then speak of the same text makes one request; a different text or agent fetches normally', async () => {
  const e = phoneSpeakEnv();
  e.voicePrefetch('a', 'Hello there.'); await tick();
  assert.strictEqual(e.reqs.length, 1);
  assert.strictEqual(await e.voiceCallSpeak('a', 'Hello there.'), true);
  assert.strictEqual(e.reqs.length, 1, 'the speak took the prefetched audio');
  assert.deepStrictEqual(e.played, ['Hello there.']);
  assert.strictEqual(e.voicePre.length, 0, 'the entry is removed');
  await e.voiceCallSpeak('a', 'Hello there.'); assert.strictEqual(e.reqs.length, 2, 'taken once');
  e.voicePrefetch('a', 'Next.'); await tick();
  await e.voiceCallSpeak('b', 'Next.'); assert.strictEqual(e.reqs.length, 4, 'another agent: its own request');
  e.voicePrefetch('a', 'Again.'); e.voicePrefetch('a', 'Again.'); await tick(); assert.strictEqual(e.voicePre.filter(x => x.text === 'Again.').length, 1, 'the same text is not fetched twice');
});

test('phone: the prefetch cache holds at most 2 entries', async () => {
  const e = phoneSpeakEnv();
  e.voicePrefetch('a', 'One.'); e.voicePrefetch('a', 'Two.'); e.voicePrefetch('a', 'Three.'); await tick();
  assert.deepStrictEqual(e.voicePre.map(x => x.text), ['Two.', 'Three.']);
});

test('phone: stopping playback (cancelSpeech, hang-up) clears the cache, so the next speak fetches again', async () => {
  const e = phoneSpeakEnv();
  e.voicePrefetch('a', 'Hello there.'); await tick();
  e.voiceStopPlayback();
  assert.strictEqual(e.voicePre.length, 0);
  await e.voiceCallSpeak('a', 'Hello there.');
  assert.strictEqual(e.reqs.length, 2, 'fetched again after the cancel');
  assert.match(between(mob, 'function voiceCallTeardown(', 'function voiceCallHangUp('), /voicePrefetchClear\(\)/, 'teardown clears it too');
});

test('phone: a failed prefetch falls back to a normal fetch', async () => {
  const e = phoneSpeakEnv((n) => { if (n === 1) throw new TypeError('lossy'); return resp(200); });
  e.voicePrefetch('a', 'Hi.'); await tick();
  assert.strictEqual(await e.voiceCallSpeak('a', 'Hi.'), true);
  assert.strictEqual(e.reqs.length, 2, 'the failed prefetch, then one normal fetch');
});

function deskSpeakEnv(fetchImpl) {
  const block = between(app, '    function voiceStopPlayback() {', "    document.addEventListener('click', (e) => {\n      const b = e.target.closest && e.target.closest('.msg-speak');")
    + '\n' + between(app, '    async function voiceCallSpeak(', "    // The recording's consent line");
  const reqs = [];
  const ctx = { state: 'running', destination: {}, decodeAudioData: async (b) => b, createBufferSource() { return { connect() {}, start() { setTimeout(() => this.onended && this.onended(), 0); } }; } };
  const voicePlay = { token: 3, ctx, source: null, btn: null };
  const window = { AudioContext: function () { return ctx; } };
  const env = new Function('voicePlay', 'window', 'fetch', 'voiceSpeedFor', 'voiceBusyToast', 'voiceCallS', 'voiceReady', 'voiceDeviceFallback', 'voiceSentences', 'voiceSpeechText', 'voicePlayState', 'hubToast', 'voiceLinkOwner', 'voiceLinkNetFail', 'voiceLinkAlive', 'voiceWaitLocalVoice', 'voiceOfflineHint',
    block + '\nreturn { voiceStopPlayback, voicePrefetch, voiceCallSpeak, voicePre };')(
    voicePlay, window, async (url, init) => { reqs.push(JSON.parse(init.body)); if (fetchImpl) return fetchImpl(reqs.length); return resp(200); }, () => 1, () => false, { rec: null, linkLost: false }, () => true, () => false,
    (t) => String(t).split(/(?<=\.)\s+/).filter(Boolean), (s) => String(s).trim(), () => {}, () => {}, () => 'owner', () => {}, () => {}, async () => null, '');
  return Object.assign(env, { reqs, voicePlay });
}

test('desktop: prefetch then speak of the same text makes one request for its first sentence; the rest is fetched as before', async () => {
  const e = deskSpeakEnv();
  e.voicePrefetch('a', 'Hello there. And more.'); await tick();
  assert.strictEqual(e.reqs.length, 1);
  assert.strictEqual(e.reqs[0].text, 'Hello there.');
  assert.strictEqual(await e.voiceCallSpeak('a', 'Hello there. And more.'), true);
  assert.deepStrictEqual(e.reqs.map(r => r.text), ['Hello there.', 'And more.'], 'one request per sentence, none repeated');
  assert.strictEqual(e.voicePre.length, 0);
  await e.voiceCallSpeak('a', 'Hello there.');
  assert.strictEqual(e.reqs.length, 3, 'taken once');
});

test('desktop: cache is at most 2 entries; cancel clears it so the next speak fetches again', async () => {
  const e = deskSpeakEnv();
  e.voicePrefetch('a', 'One.'); e.voicePrefetch('a', 'Two.'); e.voicePrefetch('a', 'Three.'); await tick();
  assert.deepStrictEqual(e.voicePre.map(x => x.text), ['Two.', 'Three.']);
  e.voiceStopPlayback();
  assert.strictEqual(e.voicePre.length, 0);
  const n = e.reqs.length;
  await e.voiceCallSpeak('a', 'Two.');
  assert.strictEqual(e.reqs.length, n + 1);
  assert.match(between(app, '    function voiceCallTeardown(', '    function voiceCallHangUp('), /voicePrefetchClear\(\)/, 'teardown clears it too');
});

test('desktop: a failed prefetch falls back to a normal fetch of the first sentence', async () => {
  const e = deskSpeakEnv((n) => { if (n === 1) throw new TypeError('lossy'); return resp(200); });
  e.voicePrefetch('a', 'Hi.'); await tick();
  assert.strictEqual(await e.voiceCallSpeak('a', 'Hi.'), true);
  assert.strictEqual(e.reqs.length, 2);
});

// ── page wiring ──
test('both pages: the controller gets prefetch, the recorder and speech-to-text uploads are counted, and a call message proves the link', () => {
  assert.match(between(mob, 'function voiceCallDeps(', 'ui: {'), /prefetch: \(text\) => voicePrefetch\(agent, text\)/);
  assert.match(between(app, '    function voiceCallDeps(', '        ui: {'), /prefetch: \(text\) => voicePrefetch\(agent, text\)/);
  assert.match(between(mob, 'function voiceRecMake(', 'function voiceCallDeps('), /fetch: \(url, init\) => voiceUpTrack\(/);
  assert.match(between(app, '    function voiceRecMake(', '    function voiceCallDeps('), /fetch: \(\.\.\.a\) => voiceUpTrack\(/);
  assert.match(between(mob, 'async function sendMessage(', 'function enterReattach('), /fallback\.voice[\s\S]*voiceLinkAlive[\s\S]*rec\.onData/);
  assert.match(mob, /if \(done\) break;\n\s*if \(rec\.onData\) rec\.onData\(\)/);
  assert.match(app, /chat\.onStreamData = \(\) => voiceLinkAlive\(owner\)/);
  assert.match(app, /ch\.onStreamData\) ch\.onStreamData\(\)/);
  assert.match(between(mob, 'async function voiceCallInterject(', 'async function voiceCallAnswerAsk('), /voiceLinkAlive\(vc\)/);
  assert.match(between(mob, 'async heartbeat(callId) {', 'async mode('), /voiceLinkAlive\(getVc\(\)\)/);
});

// ── review r1 fixes: read-back downloads count as the call's traffic; read-back audio is copied into the recording only when it really starts playing, in the call that asked ──
const gate = () => { let res; const p = new Promise((r) => { res = r; }); return { p, res }; };
const upStub = () => { const u = { n: 0, max: 0 }; u.track = async (run) => { u.n++; u.max = Math.max(u.max, u.n); try { return await run(); } finally { u.n--; } }; return u; };
const recStub = () => { const r = { got: [] }; r.replyAudio = (b) => { r.got.push(b); }; return r; };

function phoneRecEnv(first) {
  const src = between(mob, 'async function voiceTtsBlob(', 'function voiceDeviceSpeak(');
  const holder = { call: first }, up = upStub(), hold = { gate: null };
  const mkResp = () => ({ status: 200, ok: true, headers: { get: () => null }, blob: async () => ({ size: 3, arrayBuffer: async () => new ArrayBuffer(3) }) });
  const api = async () => { if (hold.gate) await hold.gate.p; return mkResp(); };
  const voicePlay = { token: 1, audio: null, url: null, cancel: null };
  class FakeAudio { play() { return Promise.resolve(); } }
  const f = new Function('state', 'voiceOn', 'api', 'voiceSpeedFor', 'voicePlay', 'toast', 'voiceUpTrack', 'Audio', 'URL',
    'let voiceCall = state.call;\n' + src + '\nreturn { voiceTtsBlob, voicePlayBlob, setCall(c) { voiceCall = c; } };')(
    holder, () => true, api, () => 1, voicePlay, () => {}, up.track, FakeAudio, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} });
  return Object.assign(f, { up, hold, voicePlay });
}
// Plays a blob to its start and ends it (the fake element never ends by itself: the stop settles it).
async function phonePlay(e, blob, my) { const p = e.voicePlayBlob(blob, my, {}); await tick(); e.voicePlay.token++; if (e.voicePlay.cancel) e.voicePlay.cancel(); return p; }

test('phone: a text-to-speech download (body read included) is counted as the call\'s own traffic in flight', async () => {
  const e = phoneRecEnv({ agent: 'a', rec: null });
  e.hold.gate = gate();
  const p = e.voiceTtsBlob('a', 'hello'); await tick();
  assert.strictEqual(e.up.n, 1, 'in flight while the request is out');
  e.hold.gate.res(); await p; assert.strictEqual(e.up.n, 0);
  assert.match(between(mob, '// The call\'s own uploads and', 'const voiceUp = {'), /read-back downloads in flight/);
});

test('phone: read-back audio is copied to the recording only when it starts playing (a prefetch that is cancelled records nothing)', async () => {
  const rec = recStub(), call = { agent: 'a', rec };
  const e = phoneRecEnv(call);
  const blob = await e.voiceTtsBlob('a', 'Hello.');           // the prefetch arrives
  await tick(); assert.strictEqual(rec.got.length, 0, 'nothing is copied on arrival');
  assert.strictEqual(Object.keys(blob).includes('__voiceRec'), false, 'the tag is not enumerable');
  e.voicePlay.token++;                                        // barge-in: the token moves on before it plays
  assert.strictEqual(await e.voicePlayBlob(blob, 1, {}), false);
  await tick(); assert.strictEqual(rec.got.length, 0, 'audio that never played is never recorded');
});

test('phone: a normally played sentence is copied to its call\'s recorder exactly once', async () => {
  const rec = recStub(), call = { agent: 'a', rec };
  const e = phoneRecEnv(call);
  const blob = await e.voiceTtsBlob('a', 'Hello.');
  await phonePlay(e, blob, 1); await tick();
  assert.strictEqual(rec.got.length, 1); assert.ok(rec.got[0] instanceof ArrayBuffer);
  e.voicePlay.token = 1; await phonePlay(e, blob, 1); await tick();
  assert.strictEqual(rec.got.length, 1, 'the same audio is copied once');
  const none = phoneRecEnv({ agent: 'a', rec: null });
  const b2 = await none.voiceTtsBlob('a', 'Hi.'); await phonePlay(none, b2, 1);   // no recorder: nothing to copy, nothing breaks
  const bad = recStub(); bad.replyAudio = () => { throw new Error('boom'); };
  const e3 = phoneRecEnv({ agent: 'a', rec: bad });
  assert.strictEqual(await phonePlay(e3, await e3.voiceTtsBlob('a', 'x'), 1), false, 'a throwing recorder never breaks the playback');
});

test('phone: audio asked for in call A, answered after call B started, is never copied into B\'s recording', async () => {
  const recA = recStub(), recB = recStub(), callA = { agent: 'a', rec: recA }, callB = { agent: 'a', rec: recB };
  const e = phoneRecEnv(callA);
  e.hold.gate = gate();
  const late = e.voiceTtsBlob('a', 'From call A.'); await tick();   // call A's request is still out
  e.setCall(callB);                                                  // hang up; call B starts with its own recorder
  e.hold.gate.res(); const blob = await late;
  await phonePlay(e, blob, 1); await tick();                         // it even plays
  assert.strictEqual(recB.got.length, 0, 'B\'s recorder gets nothing');
  assert.strictEqual(recA.got.length, 0, 'A is not current any more: nothing either');
  e.setCall(null); const e2 = phoneRecEnv(null); assert.ok(await e2.voiceTtsBlob('a', 'no call'), 'no call: still fetched, nothing to copy');
});

function deskRecEnv(S) {
  const src = between(app, '    async function voiceFetchTts(', '    // The device voice is used only');
  const up = upStub(), hold = { gate: null }, log = [];
  const fetchImpl = async () => { if (hold.gate) await hold.gate.p; return { status: 200, ok: true, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(3) }; };
  const voicePlay = { token: 1, ctx: null };
  class FakeCtx { constructor() { this.state = 'running'; this.destination = {}; } async decodeAudioData(b) { return { len: b.byteLength }; } createBufferSource() { const s = { connect() {}, start() { log.push('start'); setImmediate(() => s.onended && s.onended()); } }; return s; } }
  const f = new Function('fetch', 'voiceSpeedFor', 'voiceLinkOwner', 'voiceLinkNetFail', 'voiceLinkAlive', 'voiceBusyToast', 'voiceCallS', 'voicePlay', 'window', 'voiceUpTrack',
    src + '\nreturn { voiceFetchTts, voicePlayHub };')(fetchImpl, () => 1, () => 'owner', () => {}, () => {}, () => false, S, voicePlay, { AudioContext: FakeCtx }, up.track);
  return Object.assign(f, { up, hold, voicePlay, log });
}

test('desktop: a text-to-speech download (body read included) is counted as the call\'s own traffic in flight', async () => {
  const e = deskRecEnv({ call: {}, rec: null });
  e.hold.gate = gate();
  const p = e.voiceFetchTts('a', 'hello'); await tick();
  assert.strictEqual(e.up.n, 1);
  e.hold.gate.res(); await p; assert.strictEqual(e.up.n, 0);
  assert.match(between(app, "    // The call's own uploads and", '    const voiceUp = {'), /read-back downloads in flight/);
});

test('desktop: a prefetched sentence that is cancelled before it plays is never recorded; a played one is recorded once', async () => {
  const rec = recStub(), S = { call: { id: 1 }, rec };
  const e = deskRecEnv(S);
  const buf = await e.voiceFetchTts('a', 'Hello.');
  await tick(); assert.strictEqual(rec.got.length, 0, 'nothing is copied on arrival');
  assert.strictEqual(Object.keys(buf).includes('__voiceRec'), false, 'the tag is not enumerable');
  e.voicePlay.token = 2;                                                 // barge-in: the playback that wanted it is gone
  await e.voicePlayHub('a', ['Hello.'], undefined, 1);                   // (fetches its own copy, then sees the stale token)
  assert.strictEqual(rec.got.length, 0, 'audio that never played is never recorded');
  e.voicePlay.token = 3;
  await e.voicePlayHub('a', ['Hello.'], undefined, 3);
  assert.strictEqual(rec.got.length, 1, 'a normally played sentence: one copy'); assert.ok(rec.got[0] instanceof ArrayBuffer);
  assert.strictEqual(e.log.length, 1);
  const bad = recStub(); bad.replyAudio = () => { throw new Error('boom'); };
  const e2 = deskRecEnv({ call: {}, rec: bad }); e2.voicePlay.token = 3;
  await e2.voicePlayHub('a', ['x'], undefined, 3); assert.strictEqual(e2.log.length, 1, 'a throwing recorder never breaks the playback');
});

test('desktop: audio asked for in call A, answered after call B started, is never copied into B\'s recording even when it plays', async () => {
  const recA = recStub(), recB = recStub(), S = { call: { id: 'A' }, rec: recA };
  const e = deskRecEnv(S);
  e.hold.gate = gate();
  const late = e.voiceFetchTts('a', 'From call A.'); await tick();
  S.call = { id: 'B' }; S.rec = recB;                                    // hang up; call B starts with its recorder
  e.hold.gate.res(); const buf = await late;
  e.hold.gate = null;
  const e2buf = buf; e.voicePlay.token = 4;
  const playOnly = new Function('voiceCallS', 'voicePlay', 'window', 'voiceFetchTts', between(app, '    async function voicePlayHub(', '    // The device voice is used only') + '\nreturn voicePlayHub;');
  class FakeCtx { constructor() { this.state = 'running'; this.destination = {}; } async decodeAudioData(b) { return {}; } createBufferSource() { const s = { connect() {}, start() { setImmediate(() => s.onended && s.onended()); } }; return s; } }
  await playOnly(S, e.voicePlay, { AudioContext: FakeCtx }, async () => e2buf)('a', ['From call A.'], undefined, 4);
  assert.strictEqual(recB.got.length, 0, 'B\'s recorder gets nothing'); assert.strictEqual(recA.got.length, 0);
});

test('slow: each tracked transfer tells the call\'s link watch it started (progress(): the unknown grace counts from then), on both pages, with an older library tolerated', async () => {
  const mobFn = between(mob, 'async function voiceUpTrack(run) {', '\n}\n');
  const run = (vcArg, upArg) => new Function('voiceCall', 'voiceUp', mobFn + '\n}\nreturn voiceUpTrack;')(vcArg, upArg);
  const seen = []; const up = { n: 0, seq: 0 };
  const vc = { link: { progress: () => seen.push('progress') } };
  assert.strictEqual(await run(vc, up)(async () => { seen.push('run'); return 7; }), 7);
  assert.deepStrictEqual(seen, ['progress', 'run'], 'phone: progress before the transfer');
  assert.strictEqual(await run({ link: {} }, up)(async () => 8), 8, 'phone: an older library (no progress) is fine');
  assert.strictEqual(await run(null, up)(async () => 9), 9, 'phone: no call is fine');
  const appFn = between(app, '    async function voiceUpTrack(run) {', '\n    }\n');
  assert.ok(/voiceCallS\.link[\s\S]*typeof l\.progress === 'function'\) l\.progress\(\)/.test(appFn), 'desktop: progress() on the call\'s link');
});

test('slow: both pages probe every 2.5 s, so a silent outage is found within 2.5 + 4 + 2.5 = 9 s, no slower than before the branch', () => {
  for (const [name, src] of [['phone', mob], ['desktop', app]]) {
    assert.ok(/probe: \(o\) => voiceLinkProbe\(o\), everyMs: 2500,/.test(src), name + ': everyMs 2500 passed to the link watch');
  }
});
