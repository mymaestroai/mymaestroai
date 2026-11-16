'use strict';
// Phone page: the call follows the chosen microphone (micChoice, onRoute), the call's outputs are made again once the microphone is open (not on iOS),
// the Sound route block in the Voice sheet, the Nearby devices line and the plain line.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(ROOT, 'mobile.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'mobile.html'), 'utf8');
const sliceBetween = (a, b) => { const i = js.indexOf(a), j = js.indexOf(b, i + a.length); assert.ok(i > 0 && j > i, a + ' .. ' + b); return js.slice(i, j); };
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

// ── the renewal and route code, run with fakes ──
const ROUTE_SRC = () => sliceBetween('const VOICE_ROUTE_TOAST', 'function voiceThinkingVolume()') + '\n' + sliceBetween('function voiceMicLine(info, route)', '// ── Wake phrase standby');

function env(over) {
  const o = over || {};
  const log = [], timers = [], posts = [];
  class AC { constructor() { this.state = o.wake === false ? 'suspended' : 'running'; AC.made.push(this); } resume() { return Promise.resolve(); } close() { this.closed = true; log.push('closed'); return Promise.resolve(); } }
  AC.made = [];
  const e = {
    window: { AudioContext: AC },
    voiceIsIOS: () => !!o.ios,
    navigator: { userAgent: o.android === false ? 'Mozilla/5.0 (X11; Linux x86_64)' : 'Mozilla/5.0 (Linux; Android 14; Pixel Fold)' },
    voiceIsAndroidNav: require('../lib/ui-voice').voiceIsAndroidNav,
    voicePlay: o.voicePlay || { audio: null, cancel: null },
    voiceDisp: o.voiceDisp || { cur: null, shared: { ctx: null, routed: 0, routes: new WeakMap() } },
    voiceDispRoutesLost: () => log.push('routesLost'),
    voiceOwnCtx: () => null,
    setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; },
    clearTimeout() {},
    toast: (t, ms) => log.push('toast:' + ms + ':' + t),
    $: (id) => (o.els || {})[id] || null,
    Date: o.Date || Date,
    voiceCallPost: (url, body) => { posts.push({ url, body }); return o.postFails ? Promise.reject(new Error('offline')) : Promise.resolve({ ok: true }); },
    voiceCall: undefined,
  };
  const names = Object.keys(e).filter((n) => n !== 'voiceCall');
  const prefsNow = o.prefsNow || (() => ({}));
  const body = 'let voiceCall = null;\nconst voicePrefsNow = __p;\n' + ROUTE_SRC() + '\nreturn { voiceCallOutputsRenew, voiceCallOnRoute, voiceCallOnMicChange, voiceMicChoiceId, voiceMicLine, voiceRouteReadyMake, voiceRouteDone, voiceRouteWait, voiceRouteSettle, voiceRouteReport, setCall: (c) => { voiceCall = c; } };';
  const fns = new Function(...names, '__p', body)(...names.map((n) => e[n]), prefsNow);
  return { fns, log, timers, AC, e, posts };
}
const makeVc = (extra) => Object.assign({ thinkCtx: { closed: false, close() { this.closed = true; return Promise.resolve(); }, state: 'running' }, thinkSnd: null, keepAlive: null }, extra || {});

test('voiceCallStart gives voiceCreateVad micChoice: voiceMicChoiceId; the id comes from the prefs micDevice', () => {
  const start = sliceBetween('function voiceCallStart()', 'function voiceCallWire()');
  assert.match(start, /voiceCreateVad\(\{[^}]*micChoice: voiceMicChoiceId[^}]*\}\)/);
  assert.match(start, /voiceCreateVad\(\{[^}]*bluetoothFirst: voiceIsAndroidNav\(navigator\)[^}]*\}\)/);
  const t = env({ prefsNow: () => ({ micDevice: { id: 'dev-a', label: 'Mic A' } }) });
  assert.strictEqual(t.fns.voiceMicChoiceId(), 'dev-a');
  assert.strictEqual(env({ prefsNow: () => ({}) }).fns.voiceMicChoiceId(), null);
  assert.strictEqual(env({ prefsNow: () => ({ micDevice: { id: '' } }) }).fns.voiceMicChoiceId(), null);
});

test('the page hands onRoute and the microphone-change watcher to the VAD through the controller deps', () => {
  const deps = sliceBetween('vad: { start: (h) =>', 'stt: (f32)');
  assert.match(deps, /onRoute: \(r\) => voiceCallOnRoute\(vc, r\)/);
  assert.match(deps, /voiceCallOnMicChange\(vc, ev\)/);
  assert.match(deps, /w\.onMicChange\(ev\)/, 'the controller\'s own handler still runs');
});

test('outputs renew: not on iOS', async () => {
  const t = env({ ios: true }); const vc = makeVc(); t.fns.setCall(vc);
  assert.strictEqual(await t.fns.voiceCallOutputsRenew(vc), false);
  assert.strictEqual(t.AC.made.length, 0);
  assert.ok(!vc.outputsRenewed);
});

test('outputs renew: a playing sentence defers it (renewPending) and nothing is made; the beat runs it once nothing plays', async () => {
  const vp = { audio: { paused: false, ended: false }, cancel: null };
  const t = env({ voicePlay: vp }); const vc = makeVc(); t.fns.setCall(vc);
  const old = vc.thinkCtx;
  assert.strictEqual(await t.fns.voiceCallOutputsRenew(vc), false);
  assert.strictEqual(vc.renewPending, true);
  assert.strictEqual(t.AC.made.length, 0);
  assert.strictEqual(vc.thinkCtx, old);
  vp.cancel = () => {}; vp.audio = null;   // a play waiting also counts
  assert.strictEqual(await t.fns.voiceCallOutputsRenew(vc), false);
  vp.cancel = null;
  assert.strictEqual(await t.fns.voiceCallOutputsRenew(vc), true);
  assert.strictEqual(vc.renewPending, false);
  assert.notStrictEqual(vc.thinkCtx, old);
  const beat = sliceBetween('function voiceCallBeat()', 'function voiceCallRelease(');
  assert.match(beat, /if \(vc\.renewPending\) voiceCallOutputsRenew\(vc\)/);
});

test('outputs renew: a sentence that starts while the new context wakes leaves everything as it was', async () => {
  const vp = { audio: null, cancel: null };
  const t = env({ voicePlay: vp }); const vc = makeVc(); t.fns.setCall(vc);
  const old = vc.thinkCtx;
  const p = t.fns.voiceCallOutputsRenew(vc);
  vp.cancel = () => {};   // starts right after the call began
  assert.strictEqual(await p, false);
  assert.strictEqual(vc.thinkCtx, old);
  assert.strictEqual(vc.renewPending, true);
  assert.ok(t.AC.made.every((c) => c.closed), 'the unused new contexts are closed');
});

test('outputs renew: new context, keep-alive moved, thinking sound dropped, display renewed, old contexts closed 300 ms later, counted', async () => {
  const sndLog = [];
  const calls = [];
  const sharedOld = { closed: false, close() { this.closed = true; return Promise.resolve(); } };
  const disp = { cur: { renewContext: (c) => { calls.push(c); return true; } }, shared: { ctx: sharedOld, routed: 2, routes: new WeakMap() } };
  const t = env({ voiceDisp: disp }); const vc = makeVc({ thinkSnd: { stop: () => sndLog.push('stop') }, keepAlive: { moveTo: (c) => sndLog.push(['moveTo', c]) } });
  t.fns.setCall(vc);
  const old = vc.thinkCtx;
  assert.strictEqual(await t.fns.voiceCallOutputsRenew(vc), true);
  assert.strictEqual(t.AC.made.length, 2, 'one for the call, one for the display');
  assert.strictEqual(vc.thinkCtx, t.AC.made[0]);
  assert.deepStrictEqual(sndLog[0], ['moveTo', t.AC.made[0]]);
  assert.strictEqual(sndLog[1], 'stop');
  assert.strictEqual(vc.thinkSnd, null);
  assert.deepStrictEqual(calls, [t.AC.made[1]]);
  assert.strictEqual(vc.outputsRenewed, 1);
  assert.ok(!old.closed && !sharedOld.closed, 'not closed yet');
  const close = t.timers.filter((x) => x.ms === 300); assert.strictEqual(close.length, 1, 'one delayed close, 300 ms');
  close[0].f(); await flush();
  assert.ok(old.closed && sharedOld.closed, 'closed after the delay');
  assert.ok(t.AC.made.every((c) => !c.closed), 'the new ones keep running');
});

test('outputs renew: no display but a context left from an earlier call: the shared state is reset, the replies route through the new call context', async () => {
  const left = { closed: false, close() { this.closed = true; return Promise.resolve(); } };
  const shared = { ctx: left, routed: 3, routes: new WeakMap() }; const oldRoutes = shared.routes;
  const t = env({ voiceDisp: { cur: null, shared } }); const vc = makeVc(); t.fns.setCall(vc);
  assert.strictEqual(await t.fns.voiceCallOutputsRenew(vc), true);
  assert.strictEqual(shared.ctx, null); assert.strictEqual(shared.routed, 0); assert.notStrictEqual(shared.routes, oldRoutes);
  assert.ok(t.log.includes('routesLost'));
  t.timers.filter((x) => x.ms === 300)[0].f(); await flush();
  assert.ok(left.closed);
  assert.strictEqual(t.AC.made.length, 1);
});

test('outputs renew: never throws; a failing keep-alive / display leaves the rest done', async () => {
  const disp = { cur: { renewContext() { throw new Error('boom'); } }, shared: { ctx: { close() { return Promise.resolve(); } }, routed: 0, routes: new WeakMap() } };
  const t = env({ voiceDisp: disp }); const vc = makeVc({ keepAlive: { moveTo() { throw new Error('boom'); } }, thinkSnd: { stop() { throw new Error('boom'); } } });
  t.fns.setCall(vc);
  assert.strictEqual(await t.fns.voiceCallOutputsRenew(vc), true);
  assert.strictEqual(vc.outputsRenewed, 1);
  t.fns.setCall(null);
  assert.strictEqual(await t.fns.voiceCallOutputsRenew(vc), false);
});

test('onRoute: the first one renews the outputs; a later mic change (ok, changed) renews again; an unchanged one does not', async () => {
  const t = env({ els: { 'cp-mic': { textContent: '' } } }); const vc = makeVc({ micInfo: { label: 'Bluetooth headset', deviceId: 'b' } }); t.fns.setCall(vc);
  t.fns.voiceCallOnMicChange(vc, { ok: true, changed: true });   // the first open's own change: before any route, nothing yet
  await flush(); assert.ok(!vc.outputsRenewed);
  t.fns.voiceCallOnRoute(vc, { label: 'Bluetooth headset', deviceId: 'b', bluetooth: true, bluetoothListed: true, chosen: null, fellBack: false });
  await flush(); assert.strictEqual(vc.outputsRenewed, 1);
  t.fns.voiceCallOnRoute(vc, { label: 'Bluetooth headset', deviceId: 'b', bluetooth: true, bluetoothListed: true, chosen: null, fellBack: false });
  await flush(); assert.strictEqual(vc.outputsRenewed, 1, 'only the first');
  t.fns.voiceCallOnMicChange(vc, { ok: true, changed: false }); t.fns.voiceCallOnMicChange(vc, { ok: false });
  await flush(); assert.strictEqual(vc.outputsRenewed, 1);
  t.fns.voiceCallOnMicChange(vc, { ok: true, changed: true });
  await flush(); assert.strictEqual(vc.outputsRenewed, 2);
  assert.strictEqual(vc.route.bluetooth, true);
});

test('the microphone line gains the route', () => {
  const { fns } = env();
  assert.strictEqual(fns.voiceMicLine({ label: 'Bluetooth headset' }, { bluetooth: true }), 'Microphone: Bluetooth headset · car or Bluetooth');
  assert.strictEqual(fns.voiceMicLine({ label: 'Speakerphone' }, { bluetooth: false, bluetoothListed: true, chosen: null }), 'Microphone: Speakerphone · a car or Bluetooth device is connected but not used');
  assert.strictEqual(fns.voiceMicLine({ label: 'Speakerphone' }, { bluetoothListed: true, chosen: 'spk' }), 'Microphone: Speakerphone');
  assert.strictEqual(fns.voiceMicLine({ label: 'Speakerphone' }, { fellBack: true }), 'Microphone: Speakerphone · the chosen microphone is not available');
  assert.strictEqual(fns.voiceMicLine({ label: 'Speakerphone' }), 'Microphone: Speakerphone', 'without a route as before');
  const t = env({ els: { 'cp-mic': { textContent: '' } } }); const vc = makeVc({ micInfo: { label: 'Speakerphone', deviceId: 's' } }); t.fns.setCall(vc);
  t.fns.voiceCallOnRoute(vc, { deviceId: 's', bluetooth: false, bluetoothListed: true, chosen: null });
  assert.strictEqual(t.e.$('cp-mic').textContent, 'Microphone: Speakerphone · a car or Bluetooth device is connected but not used');
});

test('the plain line: once per call, only when Bluetooth is listed, not used and not chosen', () => {
  const t = env({ els: {} }); const vc = makeVc(); t.fns.setCall(vc);
  const want = 'Your car or Bluetooth device is connected, but this call is using the phone. Voice settings → Sound route can switch it.';
  t.fns.voiceCallOnRoute(vc, { bluetooth: false, bluetoothListed: false, chosen: null });
  t.fns.voiceCallOnRoute(vc, { bluetooth: false, bluetoothListed: true, chosen: 'spk' });
  t.fns.voiceCallOnRoute(vc, { bluetooth: true, bluetoothListed: true, chosen: null });
  assert.deepStrictEqual(t.log.filter((l) => l.startsWith('toast:')), []);
  t.fns.voiceCallOnRoute(vc, { bluetooth: false, bluetoothListed: true, chosen: null });
  t.fns.voiceCallOnRoute(vc, { bluetooth: false, bluetoothListed: true, chosen: null });
  assert.deepStrictEqual(t.log.filter((l) => l.startsWith('toast:')), ['toast:5000:' + want]);
});

test('the test hook reports outputsRenewed', () => {
  assert.match(js, /window\.__voiceBt = \{[^}]*outputsRenewed: \(\) => vc\.outputsRenewed \|\| 0/);
});

// ── Sound route block ──
test('the Sound route block sits below the Car or Bluetooth check in the sheet and the panel, with its texts', () => {
  const sheet = sliceBetween("'<button type=\"button\" class=\"vs-btn vs-car\">Car or Bluetooth check</button>'", "'<label class=\"vs-check\"><input type=\"checkbox\" class=\"vs-read\">");
  assert.ok(sheet.includes('voiceRouteHtml()'), 'in the sheet right after the car check');
  const block = sliceBetween('function voiceRouteHtml()', 'function voiceRouteInUse()');
  for (const w of ['Sound route', 'Sound devices', 'Test sound', 'vs-route-list', 'vs-route-test', 'VOICE_ROUTE_NEARBY', 'VOICE_ROUTE_FOLLOWS']) assert.ok(block.includes(w), w);
  assert.ok(html.indexOf('id="vp-route"') > html.indexOf('id="vp-car"'), 'the panel slot is below the car check');
  assert.match(js, /\$\('vp-route'\)[^\n]*voiceRouteHtml\(\)/);
  assert.ok(js.includes("const VOICE_ROUTE_FOLLOWS = 'On Android the call\\'s sound follows the microphone chosen here.';"));
  assert.ok(js.includes("Automatic (car or Bluetooth first)"));
  assert.ok(js.includes("const VOICE_ROUTE_HEARD = 'Where did you hear it? In the car: calls will be heard there too. On the phone: choose the car above, or check Nearby devices.';"));
});

function routeEnv(over) {
  const o = over || {};
  const log = [];
  const e = {
    voicePrefsSave: (p) => log.push(['save', p]),
    voiceRouteList: async () => { log.push('list'); },
    voiceRoutePaint: () => log.push('paint'),
    voiceRoute: { busy: false, last: null },
    voiceAudioRoutes: (l, id) => ({ inputs: l.map((d) => ({ id: d.deviceId, label: d.label, bluetooth: /bluetooth/i.test(d.label), pseudo: d.deviceId === 'default', inUse: d.deviceId === id })) }),
    voiceMicChoiceId: () => o.chosen || null,
    document: undefined,
  };
  const names = Object.keys(e);
  const src = sliceBetween('async function voiceRouteUse(', 'async function voiceRouteTest(');
  const body = 'let voiceCall = __c;\n' + src + '\nreturn { voiceRouteUse };';
  const fns = new Function(...names, '__c', body)(...names.map((n) => e[n]), o.call || null);
  return { fns, log };
}

test('Use saves micDevice { id, label } and, during a call, tells the VAD; Automatic saves null and useMic(null)', async () => {
  const used = [];
  const call = { vad: { useMic: (id) => { used.push(id); return Promise.resolve(true); } } };
  const t = routeEnv({ call });
  await t.fns.voiceRouteUse({}, 'spk-1', 'Speakerphone');
  assert.deepStrictEqual(t.log[0], ['save', { micDevice: { id: 'spk-1', label: 'Speakerphone' } }]);
  assert.deepStrictEqual(used, ['spk-1']);
  assert.ok(t.log.includes('list'), 'the list is repainted');
  await t.fns.voiceRouteUse({}, '', 'Automatic (car or Bluetooth first)');
  assert.deepStrictEqual(t.log.filter((l) => Array.isArray(l) && l[0] === 'save')[1], ['save', { micDevice: null }]);
  assert.deepStrictEqual(used, ['spk-1', null]);
  const off = routeEnv({});   // no call: only the prefs, then a repaint from the last list
  await off.fns.voiceRouteUse({}, 'x', 'Mic X');
  assert.deepStrictEqual(off.log, [['save', { micDevice: { id: 'x', label: 'Mic X' } }], 'paint']);
});

// A small fake DOM for the list painting.
function fakeDom() {
  const mk = (tag) => ({ tag, children: [], dataset: {}, className: '', textContent: '', hidden: false, appendChild(c) { this.children.push(c); return c; }, get firstChild() { return this.children[0] || null; }, removeChild(c) { this.children.splice(this.children.indexOf(c), 1); } });
  return { document: { createElement: mk }, mk };
}
function paintEnv(chosen) {
  const dom = fakeDom();
  const src = sliceBetween('function voiceRoutePaint(', 'async function voiceRouteList(');
  const fn = new Function('document', 'voiceRoute', 'voiceMicChoiceId', src + '\nreturn voiceRoutePaint;')(dom.document, { last: null }, () => chosen || null);
  const rows = dom.mk('div'), note = dom.mk('p'); note.hidden = true;
  const root = { querySelector: (s) => (s === '.vs-route-rows' ? rows : s === '.vs-route-nearby' ? note : null) };
  const texts = () => rows.children.map((r) => r.children[0].textContent);
  return { fn, root, rows, note, texts };
}
const LIST = { inputs: [{ id: 'default', label: 'Default', pseudo: true }, { id: 'spk', label: 'Speakerphone', inUse: true }, { id: 'bt', label: 'Bluetooth headset', bluetooth: true }] };

test('the list: Automatic first, pseudo entries skipped, in use / Bluetooth / chosen marked, a Use button per row', () => {
  const t = paintEnv('bt');
  t.fn(t.root, LIST);
  assert.deepStrictEqual(t.texts(), ['Automatic (car or Bluetooth first)', 'Speakerphone · in use', 'Bluetooth headset · Bluetooth · chosen']);
  assert.ok(t.rows.children.every((r) => r.children[1].textContent === 'Use' && r.children[1].className.includes('vs-route-use')));
  assert.deepStrictEqual(t.rows.children.map((r) => r.children[1].dataset.id), ['', 'spk', 'bt']);
  assert.strictEqual(t.note.hidden, true, 'a Bluetooth input is listed: no Nearby devices line');
  const a = paintEnv(null); a.fn(a.root, LIST);
  assert.strictEqual(a.texts()[0], 'Automatic (car or Bluetooth first) · chosen');
});

test('no Bluetooth input listed: the Nearby devices line shows', () => {
  const t = paintEnv(null);
  t.fn(t.root, { inputs: [{ id: 'spk', label: 'Speakerphone' }] });
  assert.strictEqual(t.note.hidden, false);
  assert.ok(js.includes("const VOICE_ROUTE_NEARBY = 'No car or Bluetooth microphone is visible to the browser. If one is connected: Android Settings → Apps → Chrome → Permissions → Nearby devices → Allow, then start the call again.';"));
  assert.ok(sliceBetween('function voiceRouteHtml()', 'function voiceRouteInUse()').includes("'<p class=\"vs-hint vs-route-nearby\" hidden>' + VOICE_ROUTE_NEARBY"));
});

test('Sound devices and Test sound keep to the same guards as the car check; the test opens the microphone before the beeps', () => {
  const list = sliceBetween('async function voiceRouteDevices()', 'function voiceRoutePaint(');
  assert.match(list, /vad\.routes\(\)/);
  assert.match(list, /enumerateDevices/);
  assert.match(list, /voiceOpenMicStream\(navigator\)/);
  assert.match(list, /voiceRouteStopTracks\(r\.stream\)/);
  const guard = sliceBetween('function voiceRouteInUse()', 'function voiceRouteStopTracks');
  for (const w of ['voiceRec.state', 'voiceRec.guard.pending', 'voiceTest.guard.pending', 'voiceTest.handle', 'voiceRoom.running', 'voiceCar.running']) assert.ok(guard.includes(w), w);
  const test = sliceBetween('async function voiceRouteTest(', 'function voiceRouteWire(');
  assert.ok(test.indexOf('voiceOpenMicStream(navigator, { deviceId: id || undefined })') > 0);
  assert.ok(test.indexOf('voiceOpenMicStream(') < test.indexOf('createOscillator'), 'microphone first, beeps after');
  assert.ok(test.includes('new AC()') && test.lastIndexOf('new AC()') > test.indexOf('voiceOpenMicStream('), 'elsewhere the context is made after the microphone');
  assert.match(test, /if \(voiceIsIOS\(\)\) \{ ctx = new AC\(\);[^\n]*\n\s*const r = await voiceOpenMicStream/, 'on iOS the context is made first, inside the tap');
  assert.ok(test.indexOf('if (!ctx) { ctx = new AC()') > test.indexOf('voiceOpenMicStream('));
  assert.ok(test.includes('[440, 660]') && test.includes('Math.pow(10, -12 / 20)') && test.includes('0.25'));
  assert.ok(test.includes("if (voiceCall) { toast('Hang up first"), 'not during a call');
  assert.ok(sliceBetween('async function voiceCarRun()', 'voiceStopPlayback();').includes('voiceRoute.busy'), 'a car check does not start while a Sound route action holds the microphone');
  assert.ok(sliceBetween('async function voiceRoomRun()', 'voiceStopPlayback();').includes('voiceRoute.busy'));
  assert.ok(sliceBetween('function voiceRoomStop()', 'async function voiceRoomRun()').includes('voiceRouteStop()'), 'closing the sheet lets go of a test');
});

// ── review r1 ──
test('outputs renew: only on Android (user agent, or a list that looks like Chrome Android\'s); iOS never', async () => {
  const d = env({ android: false }); const vc = makeVc(); d.fns.setCall(vc);
  assert.strictEqual(await d.fns.voiceCallOutputsRenew(vc), false); assert.strictEqual(d.AC.made.length, 0);
  vc.route = { label: 'Built-in microphone', bluetoothListed: false };
  assert.strictEqual(await d.fns.voiceCallOutputsRenew(vc), false); assert.strictEqual(d.AC.made.length, 0);
  for (const route of [{ label: 'Speakerphone' }, { label: 'USB audio' }, { label: 'Bluetooth headset' }]) {
    const t = env({ android: false }); const v = makeVc({ route }); t.fns.setCall(v);
    assert.strictEqual(await t.fns.voiceCallOutputsRenew(v), true, JSON.stringify(route));
  }
  for (const route of [{ label: 'x', bluetoothListed: true }, { label: 'Speakerphone (2)' }]) {   // r2 FU1: a listed Bluetooth input alone, or a name that is not exactly Chrome's
    const t = env({ android: false }); const v = makeVc({ route }); t.fns.setCall(v);
    assert.strictEqual(await t.fns.voiceCallOutputsRenew(v), false, JSON.stringify(route)); assert.strictEqual(t.AC.made.length, 0);
  }
  const i = env({ android: true, ios: true }); const vi = makeVc({ route: { label: 'Speakerphone', bluetoothListed: true } }); i.fns.setCall(vi);
  assert.strictEqual(await i.fns.voiceCallOutputsRenew(vi), false);
});

test('onRoute: a deviceId that differs from the previous route renews again; the same one does not', async () => {
  const t = env({ els: { 'cp-mic': { textContent: '' } } }); const vc = makeVc({ micInfo: { label: 'Speakerphone', deviceId: 'spk' } }); t.fns.setCall(vc);
  t.fns.voiceCallOnRoute(vc, { label: 'Speakerphone', deviceId: 'spk' }); await flush(); assert.strictEqual(vc.outputsRenewed, 1);
  t.fns.voiceCallOnRoute(vc, { label: 'Speakerphone', deviceId: 'spk' }); await flush(); assert.strictEqual(vc.outputsRenewed, 1);
  t.fns.voiceCallOnRoute(vc, { label: 'Bluetooth headset', deviceId: 'bt', bluetooth: true }); await flush(); assert.strictEqual(vc.outputsRenewed, 2, 'the microphone moved to the car');
});

test('F2: the thinking sound counts as playing: a renewal waits while vc.thinkOn', async () => {
  const t = env(); const vc = makeVc({ thinkOn: true }); t.fns.setCall(vc);
  assert.strictEqual(await t.fns.voiceCallOutputsRenew(vc), false); assert.strictEqual(vc.renewPending, true); assert.strictEqual(t.AC.made.length, 0);
  vc.thinkOn = false;
  assert.strictEqual(await t.fns.voiceCallOutputsRenew(vc), true);
});

test('F3: a fresh context that is not running after the cap is closed, the old ones stay, it is tried again; 5 tries at most', async () => {
  const t = env({ wake: false }); const vc = makeVc(); t.fns.setCall(vc);
  const old = vc.thinkCtx;
  assert.strictEqual(await t.fns.voiceCallOutputsRenew(vc), false);
  assert.strictEqual(vc.thinkCtx, old); assert.strictEqual(vc.renewPending, true); assert.ok(!vc.outputsRenewed);
  assert.ok(t.AC.made.every((c) => c.closed), 'the fresh one is closed');
  for (let i = 0; i < 6; i++) await t.fns.voiceCallOutputsRenew(vc);
  assert.strictEqual(vc.renewPending, false, 'stopped trying');
  assert.strictEqual(vc.renewFails, 5);
  const made = t.AC.made.length;
  await t.fns.voiceCallOutputsRenew(vc);
  assert.strictEqual(t.AC.made.length, made, 'no more tries in this call');
});

test('F4: when the display refuses renewContext (false) its old context is not closed and the fresh one is', async () => {
  const sharedOld = { closed: false, close() { this.closed = true; return Promise.resolve(); } };
  const disp = { cur: { renewContext: () => false }, shared: { ctx: sharedOld, routed: 1, routes: new WeakMap() } };
  const t = env({ voiceDisp: disp }); const vc = makeVc(); t.fns.setCall(vc);
  const oldThink = vc.thinkCtx;
  assert.strictEqual(await t.fns.voiceCallOutputsRenew(vc), true);
  assert.strictEqual(t.AC.made.length, 2);
  t.timers.filter((x) => x.ms === 300)[0].f(); await flush();
  assert.ok(!sharedOld.closed, 'the display still uses it');
  assert.ok(oldThink.closed); assert.ok(t.AC.made[1].closed, 'the unused fresh display context is closed'); assert.ok(!t.AC.made[0].closed);
});

// ── review r2 ──
test('r2 FU2: after a successful renewal renewPending is false (a trigger that came during it does not run a second one)', async () => {
  const t = env(); const vc = makeVc(); t.fns.setCall(vc);
  const p = t.fns.voiceCallOutputsRenew(vc);
  assert.strictEqual(vc.renewing, true);
  const q = t.fns.voiceCallOutputsRenew(vc);   // the trigger during it
  assert.strictEqual(vc.renewPending, true);
  assert.strictEqual(await q, false);
  assert.strictEqual(await p, true);
  assert.strictEqual(vc.renewPending, false);
});

test('r2 FU3: the failure count starts again when the microphone\'s deviceId changes', async () => {
  const t = env({ els: { 'cp-mic': { textContent: '' } } }); const vc = makeVc({ routeSeen: true, route: { deviceId: 'a', label: 'Speakerphone' }, renewFails: 5 }); t.fns.setCall(vc);
  t.fns.voiceCallOnRoute(vc, { deviceId: 'a', label: 'Speakerphone' }); await flush();
  assert.strictEqual(vc.renewFails, 5, 'the same microphone: no fresh tries');
  t.fns.voiceCallOnRoute(vc, { deviceId: 'b', label: 'Bluetooth headset', bluetooth: true }); await flush();
  assert.strictEqual(vc.renewFails, 0); assert.strictEqual(vc.outputsRenewed, 1, 'and the move renews');
});

test('r2 B: Android: the call has a pending routeReady; iOS and other browsers have none (resolved at once)', async () => {
  const a = env(); const va = makeVc(); a.fns.voiceRouteReadyMake(va);
  assert.strictEqual(va.routeDone, false);
  va.startedAt = Date.now();
  assert.ok(a.fns.voiceRouteWait(va), 'a sentence waits');
  const i = env({ ios: true }); const vi = makeVc({ startedAt: Date.now() }); i.fns.voiceRouteReadyMake(vi);
  assert.strictEqual(vi.routeDone, true); assert.strictEqual(i.fns.voiceRouteWait(vi), null);
  const d = env({ android: false }); const vd = makeVc({ startedAt: Date.now() }); d.fns.voiceRouteReadyMake(vd);
  assert.strictEqual(d.fns.voiceRouteWait(vd), null);
  assert.strictEqual(vd.routeDone, true);
});

test('r2 B / r3: the wait is bounded: 2500 ms from the first sentence that waited, never longer; none once that has passed', async () => {
  const t = env(); const vc = makeVc({ startedAt: Date.now() - 1000 }); t.fns.voiceRouteReadyMake(vc);
  const w = t.fns.voiceRouteWait(vc);
  const tm = t.timers[t.timers.length - 1];
  assert.ok(tm.ms <= 2500 && tm.ms > 2400, 'the whole window from the first sentence: ' + tm.ms);
  tm.f(); await w;   // the timer ends the wait without the route
  assert.strictEqual(vc.routeDone, false);
  vc.routeWaitFrom = Date.now() - 2600;
  assert.strictEqual(t.fns.voiceRouteWait(vc), null, 'past 2500 ms: plays at once');
});

test('r3 BLOCK 1: a slow start does not use the wait up: the first sentence asked 3 s after the call began still waits; the next waits only for the rest', async () => {
  let now = 1000000;
  const t = env({ Date: { now: () => now } }); const vc = makeVc({ startedAt: now }); t.fns.voiceRouteReadyMake(vc);
  now += 3000;
  assert.ok(t.fns.voiceRouteWait(vc), 'the first sentence waits although the call began 3 s ago');
  assert.strictEqual(t.timers[t.timers.length - 1].ms, 2500, 'a whole window');
  now += 1000;
  assert.ok(t.fns.voiceRouteWait(vc), 'the second sentence waits too');
  assert.strictEqual(t.timers[t.timers.length - 1].ms, 1500, 'only the rest of the same window');
  now += 1500;
  assert.strictEqual(t.fns.voiceRouteWait(vc), null, 'after the window it plays at once');
});

test('r3 BLOCK 2 (phone): the renewal keeps its state on the call object, so an old call\'s renewal never settles a new call\'s gate', async () => {
  const t = env({ els: { 'cp-mic': { textContent: '' } } });
  const a = makeVc({ startedAt: Date.now() }); t.fns.setCall(a); t.fns.voiceRouteReadyMake(a);
  const b = makeVc({ startedAt: Date.now() });
  t.fns.voiceCallOnRoute(a, { deviceId: 'spk', label: 'Speakerphone' });
  t.fns.setCall(b); t.fns.voiceRouteReadyMake(b);   // a new call began before A's renewal finished
  await flush(40);
  assert.strictEqual(b.routeDone, false, 'B is untouched by A\'s renewal');
  assert.strictEqual(a.routeDone, true);
});

test('r2 B: the first renewal finishing (success, not applicable) or the call ending settles routeReady; a deferred one keeps it waiting', async () => {
  const t = env({ els: { 'cp-mic': { textContent: '' } } }); const vc = makeVc({ startedAt: Date.now() }); t.fns.setCall(vc); t.fns.voiceRouteReadyMake(vc);
  let woke = false; const w = t.fns.voiceRouteWait(vc); w.then(() => { woke = true; });
  await flush(); assert.strictEqual(woke, false, 'nothing yet: no route');
  t.fns.voiceCallOnRoute(vc, { deviceId: 'spk', label: 'Speakerphone' }); await flush(40);
  assert.strictEqual(vc.outputsRenewed, 1); assert.strictEqual(vc.routeDone, true); assert.strictEqual(woke, true);
  // deferred: a sentence sounds, so the first renewal waits; the route is not ready yet
  const d = env({ voicePlay: { audio: { paused: false, ended: false }, cancel: null }, els: { 'cp-mic': { textContent: '' } } }); const vd = makeVc({ startedAt: Date.now() }); d.fns.setCall(vd); d.fns.voiceRouteReadyMake(vd);
  d.fns.voiceCallOnRoute(vd, { deviceId: 'spk', label: 'Speakerphone' }); await flush(40);
  assert.strictEqual(vd.renewPending, true); assert.strictEqual(vd.routeDone, false);
  // the call ends
  d.fns.voiceRouteDone(vd); assert.strictEqual(vd.routeDone, true);
  // not applicable: the renewal does not apply, the route is ready at once
  const n = env({ android: false, els: { 'cp-mic': { textContent: '' } } }); const vn = makeVc({ startedAt: Date.now() }); n.fns.setCall(vn); n.fns.voiceRouteReadyMake(vn);
  assert.strictEqual(vn.routeDone, true);
});

test('r2 B: voicePlayBlob (phone) waits for the first route during a call, only then plays; a stop during the wait means nothing plays; no call: no wait', async () => {
  const src = sliceBetween('function voicePlayBlob(blob, my, meta)', '// report (optional)');
  const make = (o) => {
    const log = { play: 0, urls: 0 };
    const routeWaits = [];
    const voicePlay = { token: 1, audio: null, url: null, cancel: null };
    class Audio { constructor() { voicePlay.audioMade = true; } play() { log.play++; return Promise.resolve(); } }
    const URLf = { createObjectURL: () => { log.urls++; return 'blob:x'; }, revokeObjectURL() {} };
    const fns = new Function('voicePlay', 'Audio', 'URL', 'voiceCall', 'voiceRouteWait', 'voiceDispPagePrep', 'voiceDisplayRoute', 'voiceDisplayHook', 'voiceNoteNormalized',
      src + '\nreturn voicePlayBlob;')(voicePlay, Audio, URLf, o.call, (vc) => { routeWaits.push(vc); return o.wait ? o.wait() : null; }, undefined, undefined, undefined, undefined);
    return { fns, log, voicePlay, routeWaits };
  };
  let release; const gate = new Promise((r) => { release = r; });
  const t = make({ call: { id: 1 }, wait: () => gate });
  const p = t.fns({ size: 3 }, 1, null);
  await flush(); assert.strictEqual(t.log.play, 0, 'waiting for the route');
  release(); await flush(); assert.strictEqual(t.log.play, 1, 'plays after it');
  t.voicePlay.cancel && t.voicePlay.cancel(); await p;
  // a stop during the wait
  let rel2; const g2 = new Promise((r) => { rel2 = r; });
  const u = make({ call: { id: 1 }, wait: () => g2 });
  const q = u.fns({ size: 3 }, 1, null); await flush();
  u.voicePlay.token = 2;   // voiceStopPlayback
  rel2(); assert.strictEqual(await q, false); assert.strictEqual(u.log.play, 0);
  // no call: the wait is not even asked for
  const n = make({ call: null, wait: () => gate });
  const r = n.fns({ size: 3 }, 1, null); await flush();
  assert.strictEqual(n.routeWaits.length, 0); assert.strictEqual(n.log.play, 1);
  n.voicePlay.cancel && n.voicePlay.cancel(); await r;
});

test('r2 B: voiceCallStart makes the call\'s routeReady and the teardown settles it', () => {
  const start = sliceBetween('function voiceCallStart()', 'function voiceCallWire()');
  assert.match(start, /voiceRouteReadyMake\(vc\)/);
  assert.match(sliceBetween('function voiceCallTeardown(vc)', 'function voiceCallRelease'), /voiceRouteDone\(vc\)/);
});

test('r3 FU2: voiceStopPlayback settles a voicePlayBlob that waits for the route at once, and the wait\'s cancel is cleared', async () => {
  assert.match(sliceBetween('function voiceStopPlayback()', 'const voicePre'), /voicePlay\.cancelWait/);
  const src = sliceBetween('function voicePlayBlob(blob, my, meta)', '// report (optional)');
  const log = { play: 0 };
  const voicePlay = { token: 1, audio: null, url: null, cancel: null };
  class Audio { play() { log.play++; return Promise.resolve(); } }
  const call = { id: 1 };
  const never = new Promise(() => {});
  const fn = new Function('voicePlay', 'Audio', 'URL', 'voiceCall', 'voiceRouteWait', 'voiceDispPagePrep', 'voiceDisplayRoute', 'voiceDisplayHook', 'voiceNoteNormalized',
    src + '\nreturn voicePlayBlob;')(voicePlay, Audio, { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, call, () => never, undefined, undefined, undefined, undefined);
  let result = 'pending'; fn({ size: 3 }, 1, null).then((v) => { result = v; });
  await flush(); assert.strictEqual(result, 'pending', 'waiting');
  assert.strictEqual(typeof voicePlay.cancelWait, 'function', 'a cancel is kept for the wait');
  voicePlay.cancelWait();   // what voiceStopPlayback does
  await flush(); assert.strictEqual(result, false, 'settled at once without the wait ending');
  assert.strictEqual(voicePlay.cancelWait, null, 'cleared'); assert.strictEqual(log.play, 0);
});

test('r3 FU2: a normal end of the wait clears the wait\'s cancel', async () => {
  const src = sliceBetween('function voicePlayBlob(blob, my, meta)', '// report (optional)');
  const voicePlay = { token: 1, audio: null, url: null, cancel: null };
  class Audio { play() { return Promise.resolve(); } }
  let release; const gate = new Promise((r) => { release = r; });
  const call = { id: 1 };
  const fn = new Function('voicePlay', 'Audio', 'URL', 'voiceCall', 'voiceRouteWait', 'voiceDispPagePrep', 'voiceDisplayRoute', 'voiceDisplayHook', 'voiceNoteNormalized',
    src + '\nreturn voicePlayBlob;')(voicePlay, Audio, { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, call, () => gate, undefined, undefined, undefined, undefined);
  const p = fn({ size: 3 }, 1, null); await flush();
  assert.strictEqual(typeof voicePlay.cancelWait, 'function');
  release(); await flush();
  assert.ok(!voicePlay.cancelWait, 'cleared when the wait ended');
  voicePlay.cancel && voicePlay.cancel(); await p;
});

test('r3 FU3: after the wait, a call that is no longer the one that was current when the wait began plays nothing', async () => {
  const src = sliceBetween('function voicePlayBlob(blob, my, meta)', '// report (optional)');
  const run = async (endCall) => {
    const log = { play: 0 };
    const voicePlay = { token: 1, audio: null, url: null, cancel: null };
    class Audio { play() { log.play++; return Promise.resolve(); } }
    let release; const gate = new Promise((r) => { release = r; });
    // voiceCall is a variable of the page: here a holder the function reads through a getter-like closure
    const holder = { v: { id: 'A' } };
    const fn = new Function('voicePlay', 'Audio', 'URL', 'H', 'voiceRouteWait', 'voiceDispPagePrep', 'voiceDisplayRoute', 'voiceDisplayHook', 'voiceNoteNormalized',
      'let voiceCall = H.v; H.set = (x) => { voiceCall = x; };\n' + src + '\nreturn voicePlayBlob;')(voicePlay, Audio, { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, holder, () => gate, undefined, undefined, undefined, undefined);
    const p = fn({ size: 3 }, 1, null); await flush();
    endCall(holder);
    release(); await flush();
    const r = await Promise.race([p, new Promise((x) => setTimeout(() => x('pending'), 20))]);
    if (voicePlay.cancel) voicePlay.cancel();
    return { r, plays: log.play, token: voicePlay.token };
  };
  const ended = await run((h) => h.set(null));
  assert.strictEqual(ended.r, false); assert.strictEqual(ended.plays, 0, 'the call ended during the wait');
  assert.strictEqual(ended.token, 2, 'the token moved on: no fallback voice reads the line after the call');
  const other = await run((h) => h.set({ id: 'B' }));
  assert.strictEqual(other.r, false); assert.strictEqual(other.plays, 0, 'another call began during the wait');
  const same = await run(() => {});
  assert.strictEqual(same.plays, 1, 'the same call: it plays');
});

// ── the route report to the hub: names and flags only ──
const routeVc = (extra) => makeVc(Object.assign({ agent: 'sam', call: { callId: 'call-1' }, vad: { routes: async () => ({ inputs: [{ id: 'default', label: 'Default', pseudo: true }, { id: 'a', label: 'Car Kit' }, { id: 'b', label: 'Phone mic' }], outputs: [] }) } }, extra || {}));
const R1 = { label: 'Car Kit', deviceId: 'a', bluetooth: true, bluetoothListed: true, chosen: 'a', fellBack: false };

test('route report: sent once after the first route settles, with the right body', async () => {
  const t = env(); const vc = routeVc(); t.fns.setCall(vc); t.fns.voiceRouteReadyMake(vc);
  t.fns.voiceCallOnRoute(vc, R1);
  await flush(60);
  assert.strictEqual(vc.outputsRenewed, 1);
  assert.strictEqual(t.posts.length, 1);
  assert.strictEqual(t.posts[0].url, '/api/voice/call');
  assert.deepStrictEqual(t.posts[0].body, { agent: 'sam', callId: 'call-1', action: 'route', route: { label: 'Car Kit', bluetooth: true, bluetoothListed: true, chosen: true, fellBack: false, renewed: 1, android: true, inputs: ['Car Kit', 'Phone mic'] } });
  t.fns.voiceCallOnRoute(vc, R1);   // the same route again: nothing more
  await flush(60);
  assert.strictEqual(t.posts.length, 1);
});

test('route report: also when the renewal is not applicable (not Android), once', async () => {
  const t = env({ android: false }); const vc = routeVc(); t.fns.setCall(vc); t.fns.voiceRouteReadyMake(vc);
  t.fns.voiceCallOnRoute(vc, { label: 'Phone mic', deviceId: 'b' });
  await flush(60);
  assert.strictEqual(t.posts.length, 1);
  assert.strictEqual(t.posts[0].body.route.android, false);
  assert.strictEqual(t.posts[0].body.route.renewed, 0);
});

test('route report: again after a later renewal that moved the outputs; not twice within 2 s', async () => {
  let now = 1000000;
  const t = env({ Date: { now: () => now } }); const vc = routeVc(); t.fns.setCall(vc); t.fns.voiceRouteReadyMake(vc);
  t.fns.voiceCallOnRoute(vc, R1);
  await flush(60);
  assert.strictEqual(t.posts.length, 1);
  now += 500;   // the microphone moves 0.5 s later: the renewal succeeds but the report waits out the 2 s
  t.fns.voiceCallOnRoute(vc, { ...R1, deviceId: 'b', label: 'Phone mic', bluetooth: false });
  await flush(60);
  assert.strictEqual(vc.outputsRenewed, 2);
  assert.strictEqual(t.posts.length, 1, 'not twice within 2 s');
  now += 3000;
  t.fns.voiceCallOnRoute(vc, { ...R1, deviceId: 'c', label: 'Car Kit', bluetooth: true });
  await flush(60);
  assert.strictEqual(vc.outputsRenewed, 3);
  assert.strictEqual(t.posts.length, 2);
  assert.strictEqual(t.posts[1].body.route.renewed, 3);
  assert.strictEqual(t.posts[1].body.route.label, 'Car Kit');
});

test('route report: a failing POST or a failing device list does not throw; no call id sends nothing', async () => {
  const t = env({ postFails: true }); const vc = routeVc({ vad: { routes: async () => { throw new Error('no list'); } } }); t.fns.setCall(vc); t.fns.voiceRouteReadyMake(vc);
  vc.route = R1;
  await t.fns.voiceRouteReport(vc);
  await flush(20);
  assert.strictEqual(t.posts.length, 1);
  assert.deepStrictEqual(t.posts[0].body.route.inputs, []);
  const t2 = env(); const vc2 = routeVc({ call: {} }); t2.fns.setCall(vc2); vc2.route = R1;
  await t2.fns.voiceRouteReport(vc2);
  assert.strictEqual(t2.posts.length, 0);
  await t2.fns.voiceRouteReport(null);
});
