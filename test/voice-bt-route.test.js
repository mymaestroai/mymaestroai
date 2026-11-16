'use strict';
// Choosing the call's microphone (which moves Android's call output with it), Bluetooth first, and the call's sound outputs made again:
// voiceIsBluetoothLabel, voiceAudioRoutes, voiceOpenMicStream({ deviceId }), the VAD adapter (useMic, micChoice, onRoute, routes), keepAlive.moveTo, display.renewContext.
const { test } = require('node:test');
const assert = require('node:assert');
Object.assign(globalThis, require('../lib/ui-voice'), require('../lib/ui-voice-thinking'));
const CALL = require('../lib/ui-voice-call');
const { voiceIsBluetoothLabel, voiceAudioRoutes, voiceOpenMicStream, voiceCreateVad, voiceCreateKeepAlive } = CALL;
const DISPLAY = require('../lib/ui-call-display');

const tick = async (n = 40) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const err = (name) => { const e = new Error(name); e.name = name; return e; };

test('voiceIsBluetoothLabel: Bluetooth, car and hands-free names yes; wired, earpiece, speakerphone, USB and empty no', () => {
  for (const l of ['Bluetooth headset', 'AirPods Pro', 'Jabra Evolve (Bluetooth)', 'Hands-Free', 'Car kit', 'Galaxy Buds', 'BT Speaker', 'LE Audio headset']) assert.strictEqual(voiceIsBluetoothLabel(l), true, l);
  for (const l of ['Headset earpiece', 'Wired headset', 'Speakerphone', 'USB audio', '', null, undefined, 42, 'default', 'Wired Bluetooth-free']) assert.strictEqual(voiceIsBluetoothLabel(l), false, String(l));
});

test('voiceIsBluetoothLabel agrees with voiceOutputKind: every label it calls bluetooth is one here', () => {
  for (const l of ['Bluetooth headset', 'Hands free kit', 'HFP device', 'AirPods', 'Car audio', 'My car']) {
    assert.strictEqual(voiceOutputKind(l), 'bluetooth', l);
    assert.strictEqual(voiceIsBluetoothLabel(l), true, l);
  }
});

const androidList = () => [
  { kind: 'audioinput', deviceId: 'default', label: 'Default', groupId: 'g0' },
  { kind: 'audioinput', deviceId: 'spk', label: 'Speakerphone', groupId: 'g1' },
  { kind: 'audioinput', deviceId: 'ear', label: 'Headset earpiece', groupId: 'g2' },
  { kind: 'audioinput', deviceId: 'bt', label: 'Bluetooth headset', groupId: 'g3' },
  { kind: 'audiooutput', deviceId: 'default', label: 'Default', groupId: 'g0' },
  { kind: 'audiooutput', deviceId: 'bt', label: 'Bluetooth headset', groupId: 'g3' },
  { kind: 'videoinput', deviceId: 'cam', label: 'Camera', groupId: 'g9' },
];

test('voiceAudioRoutes: inputs, outputs, the Bluetooth input, pseudo entries and the one in use', () => {
  const r = voiceAudioRoutes(androidList(), 'spk');
  assert.deepStrictEqual(r.inputs.map(x => x.id), ['default', 'spk', 'ear', 'bt']);
  assert.deepStrictEqual(r.outputs.map(x => x.id), ['default', 'bt']);
  assert.strictEqual(r.bluetoothInput.id, 'bt');
  assert.strictEqual(r.inputs[0].pseudo, true); assert.strictEqual(r.inputs[1].pseudo, undefined);
  assert.deepStrictEqual(r.inputs.map(x => x.inUse), [false, true, false, false]);
  assert.deepStrictEqual(r.inputs.map(x => x.bluetooth), [false, false, false, true]);
  assert.strictEqual(r.inputs[3].groupId, 'g3');
  assert.strictEqual(r.outputs[1].bluetooth, true);
});

test('voiceAudioRoutes: a pseudo entry is never the Bluetooth input; garbage gives empty lists', () => {
  const r = voiceAudioRoutes([{ kind: 'audioinput', deviceId: 'default', label: 'Default - Bluetooth headset' }, { kind: 'audioinput', deviceId: 'communications', label: 'Bluetooth' }]);
  assert.strictEqual(r.bluetoothInput, null); assert.strictEqual(r.inputs.length, 2); assert.ok(r.inputs.every(x => x.pseudo === true));
  for (const bad of [null, undefined, 5, 'x', {}, [null, 3, 'a', {}]]) assert.deepStrictEqual(voiceAudioRoutes(bad), { inputs: [], outputs: [], bluetoothInput: null });
  assert.deepStrictEqual(voiceAudioRoutes({ get length() { throw new Error('boom'); } }), { inputs: [], outputs: [], bluetoothInput: null });
});

test('voiceOpenMicStream with deviceId: the first call has deviceId exact and processing on', async () => {
  const calls = [];
  const nav = { mediaDevices: { getUserMedia: async (c) => { calls.push(c); return { id: 's' }; } } };
  const r = await voiceOpenMicStream(nav, { deviceId: 'bt' });
  assert.deepStrictEqual(calls, [{ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, deviceId: { exact: 'bt' } } }]);
  assert.strictEqual(r.fallback, false); assert.strictEqual(r.deviceFallback, false);
  calls.length = 0;
  await voiceOpenMicStream(nav, { deviceId: 'bt', unprocessed: true });
  assert.deepStrictEqual(calls, [{ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, deviceId: { exact: 'bt' } } }]);
  // without deviceId: exactly the calls and result of before
  const plain = [];
  const nav1 = { mediaDevices: { getUserMedia: async (c) => { plain.push(c); if (plain.length === 1) throw err('NotReadableError'); return { id: 's' }; } } };
  const r1 = await voiceOpenMicStream(nav1, {});
  assert.deepStrictEqual(plain, [{ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }, { audio: true }]);
  assert.deepStrictEqual(r1, { stream: { id: 's' }, fallback: true });
  const nav2 = { mediaDevices: { getUserMedia: async () => ({ id: 't' }) } };
  assert.deepStrictEqual(await voiceOpenMicStream(nav2), { stream: { id: 't' }, fallback: false });
});

test('voiceOpenMicStream with deviceId: OverconstrainedError and NotFoundError start the ladder again without deviceId, deviceFallback true', async () => {
  for (const name of ['OverconstrainedError', 'NotFoundError']) {
    const calls = [];
    const nav = { mediaDevices: { getUserMedia: async (c) => { calls.push(c); if (c.audio.deviceId) throw err(name); return { id: 's' }; } } };
    const r = await voiceOpenMicStream(nav, { deviceId: 'gone' });
    assert.strictEqual(calls.length, 2, name);
    assert.deepStrictEqual(calls[1], { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    assert.strictEqual(r.deviceFallback, true); assert.strictEqual(r.fallback, false);
  }
});

test('voiceOpenMicStream with deviceId: a refusal throws at once, one call only', async () => {
  for (const name of ['NotAllowedError', 'SecurityError', 'AbortError']) {
    const calls = [];
    const nav = { mediaDevices: { getUserMedia: async (c) => { calls.push(c); throw err(name); } } };
    await assert.rejects(() => voiceOpenMicStream(nav, { deviceId: 'bt' }), (e) => e.name === name);
    assert.strictEqual(calls.length, 1, name);
  }
});

// ── the VAD adapter ──
// devices: [{ id, label }] listed as inputs; opening with no deviceId gives the first one (what Chrome's default does), with { exact } that one, or throws OverconstrainedError.
function world(devices, over) {
  const w = { opens: [], tracks: [], devices, enumerates: 0, changeFns: [], routes: [], ...(over || {}) };
  const ctx = {
    sampleRate: 48000, state: 'running', resume: async () => {}, close: async () => {},
    createMediaStreamSource: (s) => ({ stream: s, connect() {}, disconnect() {} }),
    createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
    createMediaStreamDestination: () => ({ stream: { getTracks: () => [], getAudioTracks: () => [] } }),
  };
  const make = (d, c) => {
    const tr = { enabled: true, readyState: 'live', label: d.label, getSettings: () => ({ deviceId: d.id, sampleRate: 48000, echoCancellation: !(c.audio && c.audio.echoCancellation === false) }),
      stop() { tr.readyState = 'ended'; }, addEventListener() {}, removeEventListener() {} };
    w.tracks.push(tr);
    return { getTracks: () => [tr], getAudioTracks: () => [tr] };
  };
  const nav = { mediaDevices: {
    getUserMedia: async (c) => {
      w.opens.push(c);
      const want = c.audio && c.audio.deviceId && c.audio.deviceId.exact;
      if (want) { const d = w.devices.find(x => x.id === want); if (!d) throw err('OverconstrainedError'); return make(d, c); }
      return make(w.devices[0], c);
    },
    enumerateDevices: async () => { w.enumerates++; return w.devices.map(d => ({ kind: 'audioinput', deviceId: d.id, label: d.label, groupId: 'g-' + d.id })); },
    addEventListener(n, f) { if (n === 'devicechange') w.changeFns.push(f); }, removeEventListener() {},
  } };
  w.win = { AudioContext: function () { return ctx; }, vad: { MicVAD: { new: async (o) => { await o.getStream(); return { start: async () => {}, destroy: async () => {}, setOptions() {} }; } } }, setTimeout, clearTimeout };
  w.nav = nav;
  return w;
}
const PHONE = [{ id: 'spk', label: 'Speakerphone' }, { id: 'ear', label: 'Headset earpiece' }, { id: 'bt', label: 'Bluetooth headset' }];
const exactOf = (c) => (c.audio && c.audio.deviceId ? c.audio.deviceId.exact : undefined);
async function started(devices, opts, over) {
  const w = world(devices, over), routes = w.routes;
  const vad = voiceCreateVad({ win: w.win, nav: w.nav, micLevel: 50, loadScript: async () => {}, ...(opts || {}) });
  const infos = [], changes = [];
  await vad.start({ onRoute: (r) => routes.push(r), onMicInfo: (i) => infos.push(i), onMicChange: (c) => changes.push(c) });
  await tick();
  return { w, vad, routes, infos, changes };
}

test('VAD: Bluetooth listed, the default opened Speakerphone: exactly one reopen with the Bluetooth deviceId; onRoute says bluetooth', async () => {
  const { w, vad, routes, changes } = await started(PHONE);
  assert.strictEqual(w.opens.length, 2);
  assert.strictEqual(exactOf(w.opens[0]), undefined);
  assert.strictEqual(exactOf(w.opens[1]), 'bt');
  assert.strictEqual(w.opens[1].audio.echoCancellation, true);
  assert.ok(changes.some(c => c.ok && c.reason === 'bluetooth'));
  const last = routes[routes.length - 1];
  assert.strictEqual(last.bluetooth, true); assert.strictEqual(last.bluetoothListed, true); assert.strictEqual(last.deviceId, 'bt'); assert.strictEqual(last.chosen, null); assert.strictEqual(last.fellBack, false);
  assert.strictEqual(vad.info().bluetooth, true); assert.strictEqual(vad.info().deviceId, 'bt');
  assert.strictEqual(routes.length, 1, 'one route report, after the Bluetooth try');
  await vad.stop();
});

test('VAD: no second Bluetooth reopen while the list is unchanged; a devicechange allows one more try', async () => {
  const w = world(PHONE);
  // Chrome keeps giving the speaker whatever is asked: the try must not loop.
  w.nav.mediaDevices.getUserMedia = async (c) => { w.opens.push(c); const tr = { enabled: true, readyState: 'live', label: 'Speakerphone', getSettings: () => ({ deviceId: 'spk' }), stop() {}, addEventListener() {}, removeEventListener() {} }; return { getTracks: () => [tr], getAudioTracks: () => [tr] }; };
  const timers = [];
  const vad = voiceCreateVad({ win: w.win, nav: w.nav, loadScript: async () => {}, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer() {} });
  await vad.start({}); await tick();
  assert.strictEqual(w.opens.length, 2, 'one try');
  await vad.reopen(); await tick();   // a new open is a new chance, but exactly one
  assert.strictEqual(w.opens.length, 4);
  await tick();
  assert.strictEqual(w.opens.length, 4, 'nothing more on its own');
  w.changeFns.forEach(f => f()); timers.splice(0).forEach(f => f()); await tick(80);
  assert.strictEqual(w.opens.length, 5, 'a devicechange: one more try');
  assert.strictEqual(exactOf(w.opens[4]), 'bt');
  await vad.stop();
});

test('VAD: after a Bluetooth try that worked, later automatic opens stay on that Bluetooth input while it is listed', async () => {
  const { w, vad, routes } = await started(PHONE);
  assert.strictEqual(exactOf(w.opens[1]), 'bt');
  await vad.reopen(); await tick();   // a lost or changed microphone opened again: no detour through the default device
  assert.strictEqual(w.opens.length, 3);
  assert.strictEqual(exactOf(w.opens[2]), 'bt');
  assert.strictEqual(routes[routes.length - 1].bluetooth, true);
  // The car goes away: the remembered input is forgotten and automatic is the default again.
  w.devices = PHONE.filter(d => d.id !== 'bt');
  await vad.reopen(); await tick();
  assert.strictEqual(exactOf(w.opens[w.opens.length - 1]), undefined, 'the gone Bluetooth input is not asked for again');
  await vad.stop();
});

test('VAD: when the first open is already on Bluetooth nothing is reopened', async () => {
  const { w, vad, routes } = await started([{ id: 'bt', label: 'Bluetooth headset' }, { id: 'spk', label: 'Speakerphone' }]);
  assert.strictEqual(w.opens.length, 1);
  assert.strictEqual(routes[0].bluetooth, true);
  await vad.stop();
});

test('VAD: useMic(id) reopens with that id and Bluetooth first does not override it; useMic(null) is automatic again', async () => {
  const { w, vad, routes } = await started(PHONE);
  assert.strictEqual(w.opens.length, 2);
  assert.strictEqual(await vad.useMic('spk'), true); await tick();
  assert.strictEqual(w.opens.length, 3);
  assert.strictEqual(exactOf(w.opens[2]), 'spk');
  assert.strictEqual(vad.info().deviceId, 'spk'); assert.strictEqual(vad.info().bluetooth, false);
  await tick(80);
  assert.strictEqual(w.opens.length, 3, 'no Bluetooth reopen over the choice');
  const r = routes[routes.length - 1];
  assert.strictEqual(r.chosen, 'spk'); assert.strictEqual(r.bluetooth, false); assert.strictEqual(r.bluetoothListed, true); assert.strictEqual(r.fellBack, false);
  assert.strictEqual(await vad.useMic(null), true); await tick(80);
  // Automatic again: the Bluetooth input the automatic try had found is still listed, so it is opened at once (no detour through the default device).
  assert.strictEqual(exactOf(w.opens[3]), 'bt', 'automatic: back on the Bluetooth input');
  assert.strictEqual(w.opens.length, 4);
  assert.strictEqual(vad.info().deviceId, 'bt');
  await vad.stop();
});

test('VAD: opts.micChoice is read at the open; useMic overrides it', async () => {
  let choice = 'ear';
  const { w, vad } = await started(PHONE, { micChoice: () => choice });
  assert.strictEqual(exactOf(w.opens[0]), 'ear'); assert.strictEqual(w.opens.length, 1, 'a choice: no Bluetooth first');
  choice = 'spk';
  await vad.reopen();
  assert.strictEqual(exactOf(w.opens[1]), 'spk');
  await vad.useMic('ear');
  choice = 'spk';
  await vad.reopen();
  assert.strictEqual(exactOf(w.opens[w.opens.length - 1]), 'ear', 'useMic wins over micChoice');
  await vad.stop();
});

test('VAD: a chosen device that is missing gives fellBack true and the microphone stays open', async () => {
  const { w, vad, routes } = await started(PHONE);
  const n = w.opens.length;
  assert.strictEqual(await vad.useMic('unplugged'), true); await tick();
  assert.strictEqual(exactOf(w.opens[n]), 'unplugged');
  assert.strictEqual(exactOf(w.opens[n + 1]), undefined, 'the ladder again without the id');
  const r = routes[routes.length - 1];
  assert.strictEqual(r.fellBack, true); assert.strictEqual(r.chosen, 'unplugged');
  assert.ok(vad.info() && vad.info().label, 'a microphone is open');
  assert.ok(w.tracks[w.tracks.length - 1].readyState === 'live');
  await vad.stop();
});

test('VAD: an onRoute that throws does not break the microphone', async () => {
  const w = world(PHONE);
  const vad = voiceCreateVad({ win: w.win, nav: w.nav, loadScript: async () => {} });
  await vad.start({ onRoute: () => { throw new Error('boom'); } }); await tick();
  assert.strictEqual(vad.info().deviceId, 'bt');
  assert.strictEqual(await vad.reopen(), true);
  assert.strictEqual(await vad.useMic('ear'), true);
  assert.strictEqual(vad.info().deviceId, 'ear');
  await vad.stop();
});

test('VAD: routes() lists the devices with the open one marked; empty when the list cannot be had', async () => {
  const { w, vad } = await started(PHONE);
  const r = await vad.routes();
  assert.deepStrictEqual(r.inputs.map(x => x.id), ['spk', 'ear', 'bt']);
  assert.deepStrictEqual(r.inputs.map(x => x.inUse), [false, false, true]);
  w.nav.mediaDevices.enumerateDevices = async () => { throw new Error('no'); };
  assert.deepStrictEqual(await vad.routes(), { inputs: [], outputs: [], bluetoothInput: null });
  delete w.nav.mediaDevices.enumerateDevices;
  assert.deepStrictEqual(await vad.routes(), { inputs: [], outputs: [], bluetoothInput: null });
  await vad.stop();
});

// ── keepAlive.moveTo ──
function fakeCtx(rate) {
  const c = { sampleRate: rate, state: 'running', destination: { name: 'dest' }, buffers: [], sources: [], resume: async () => {} };
  c.createBuffer = (n, len, r) => { const b = { n, len, r, getChannelData: () => new Float32Array(len) }; c.buffers.push(b); return b; };
  c.createGain = () => ({ gain: { value: 0 }, connect() {}, disconnect() {} });
  c.createBufferSource = () => { const s = { started: false, stopped: false, connect() {}, disconnect() {}, start() { s.started = true; }, stop() { s.stopped = true; } }; c.sources.push(s); return s; };
  return c;
}
test('keepAlive.moveTo: the playing hiss moves to the new context, running stays true, stop() after the move stops it there', () => {
  const a = fakeCtx(48000), b = fakeCtx(44100);
  const ka = voiceCreateKeepAlive({ ctx: a });
  ka.start();
  assert.strictEqual(ka.running, true); assert.strictEqual(a.sources.length, 1); assert.strictEqual(a.sources[0].started, true);
  ka.moveTo(b);
  assert.strictEqual(ka.running, true);
  assert.strictEqual(a.sources[0].stopped, true);
  assert.strictEqual(b.sources.length, 1); assert.strictEqual(b.sources[0].started, true);
  assert.strictEqual(b.buffers[0].r, 44100); assert.strictEqual(b.buffers[0].len, 88200, 'the 2 s buffer is made again at the new rate');
  ka.stop();
  assert.strictEqual(ka.running, false); assert.strictEqual(b.sources[0].stopped, true);
});

test('keepAlive.moveTo: not playing stays silent; allow() is obeyed on the new context; a later start plays there', () => {
  const a = fakeCtx(48000), b = fakeCtx(48000);
  let ok = true;
  const ka = voiceCreateKeepAlive({ ctx: a, allow: () => ok });
  ka.moveTo(b);
  assert.strictEqual(ka.running, false); assert.strictEqual(b.sources.length, 0);
  ka.start();
  assert.strictEqual(a.sources.length, 0); assert.strictEqual(b.sources.length, 1); assert.strictEqual(ka.running, true);
  const c = fakeCtx(48000);
  ok = false;
  ka.moveTo(c);
  assert.strictEqual(ka.running, false, 'the allow rule still applies');
  ok = true; ka.refresh();
  assert.strictEqual(ka.running, true); assert.strictEqual(c.sources.length, 1);
});

// ── display.renewContext ──
function displayWith(over) {
  const win = { AudioContext: function () { return { state: 'running', resume: async () => {}, close: async () => {}, destination: {} }; }, innerWidth: 500, innerHeight: 800, matchMedia: () => ({ matches: false, addEventListener() {} }), setTimeout, clearTimeout };
  return DISPLAY.createCallDisplay({ window: win, document: null, storage: null, ...(over || {}) });
}
test('display.renewContext: with shared, the context is replaced, the routes reset and onRoutesLost called once', () => {
  const oldRoutes = new WeakMap(), oldCtx = { state: 'running' }, newCtx = { state: 'running' };
  const shared = { ctx: oldCtx, routes: oldRoutes, routed: 3 };
  let lost = 0;
  const d = displayWith({ needsContext: true, shared, onRoutesLost: () => { lost++; } });
  assert.strictEqual(d.renewContext(newCtx), true);
  assert.strictEqual(shared.ctx, newCtx); assert.strictEqual(shared.routed, 0);
  assert.notStrictEqual(shared.routes, oldRoutes); assert.ok(shared.routes instanceof WeakMap);
  assert.strictEqual(lost, 1);
  assert.strictEqual(newCtx.state, 'running', 'nothing closes the old or touches the new context here');
  assert.strictEqual(d.routeElement({}), false, 'a fresh route is built on the new context (here: no view, so none), never the old one');
});

test('display.renewContext: without needsContext it does nothing and returns false', () => {
  const shared = { ctx: { state: 'running' }, routes: new WeakMap(), routed: 2 }, keep = shared.ctx, keepRoutes = shared.routes;
  let lost = 0;
  const d = displayWith({ shared, onRoutesLost: () => { lost++; } });
  assert.strictEqual(d.renewContext({ state: 'running' }), false);
  assert.strictEqual(shared.ctx, keep); assert.strictEqual(shared.routes, keepRoutes); assert.strictEqual(shared.routed, 2); assert.strictEqual(lost, 0);
});

test('voiceCleanPrefs: micDevice { id, label } is kept; a missing, empty or malformed one means automatic (no key)', () => {
  const V = require('../lib/ui-voice');
  assert.deepStrictEqual(V.voiceCleanPrefs({ micDevice: { id: 'bt-1', label: 'Bluetooth headset' } }).micDevice, { id: 'bt-1', label: 'Bluetooth headset' });
  assert.deepStrictEqual(V.voiceCleanPrefs({ micDevice: { id: 'x' } }).micDevice, { id: 'x', label: '' });
  for (const bad of [null, undefined, 'bt', [], {}, { id: '' }, { id: 5 }, { id: 'a'.repeat(513) }]) assert.ok(!('micDevice' in V.voiceCleanPrefs({ micDevice: bad })), JSON.stringify(bad));
  assert.ok(!('micDevice' in V.voiceCleanPrefs(null)));
  assert.strictEqual(V.voiceCleanPrefs({ micDevice: { id: 'y', label: 'L'.repeat(300) } }).micDevice.label.length, 120);
});
