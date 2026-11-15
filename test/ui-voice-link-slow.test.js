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
  test(`${page}: probe resolves true on 200 and below 500, false on 503 and on a network error`, async () => {
    for (const [st, want] of [[200, true], [404, true], [503, false], [500, false]]) {
      assert.strictEqual(await probeEnv(page, async () => resp(st)).f.voiceLinkProbe(), want, `status ${st}`);
    }
    assert.strictEqual(await probeEnv(page, async () => { throw new TypeError('Failed to fetch'); }).f.voiceLinkProbe(), false);
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

  test(`${page}: a network error with an upload in flight is still false (an outage is reported at once)`, async () => {
    const { f } = probeEnv(page, async () => { throw new TypeError('Failed to fetch'); });
    let release; const up = f.voiceUpTrack(() => new Promise((r) => { release = r; }));
    assert.strictEqual(await f.voiceLinkProbe(), false);
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
