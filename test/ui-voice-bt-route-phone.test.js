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
  const log = [], timers = [];
  class AC { constructor() { this.state = 'running'; AC.made.push(this); } resume() { return Promise.resolve(); } close() { this.closed = true; log.push('closed'); return Promise.resolve(); } }
  AC.made = [];
  const e = {
    window: { AudioContext: AC },
    voiceIsIOS: () => !!o.ios,
    voicePlay: o.voicePlay || { audio: null, cancel: null },
    voiceDisp: o.voiceDisp || { cur: null, shared: { ctx: null, routed: 0, routes: new WeakMap() } },
    voiceDispRoutesLost: () => log.push('routesLost'),
    voiceOwnCtx: () => null,
    setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; },
    clearTimeout() {},
    toast: (t, ms) => log.push('toast:' + ms + ':' + t),
    $: (id) => (o.els || {})[id] || null,
    voiceCall: undefined,
  };
  const names = Object.keys(e).filter((n) => n !== 'voiceCall');
  const prefsNow = o.prefsNow || (() => ({}));
  const body = 'let voiceCall = null;\nconst voicePrefsNow = __p;\n' + ROUTE_SRC() + '\nreturn { voiceCallOutputsRenew, voiceCallOnRoute, voiceCallOnMicChange, voiceMicChoiceId, voiceMicLine, setCall: (c) => { voiceCall = c; } };';
  const fns = new Function(...names, '__p', body)(...names.map((n) => e[n]), prefsNow);
  return { fns, log, timers, AC, e };
}
const makeVc = (extra) => Object.assign({ thinkCtx: { closed: false, close() { this.closed = true; return Promise.resolve(); }, state: 'running' }, thinkSnd: null, keepAlive: null }, extra || {});

test('voiceCallStart gives voiceCreateVad micChoice: voiceMicChoiceId; the id comes from the prefs micDevice', () => {
  const start = sliceBetween('function voiceCallStart()', 'function voiceCallWire()');
  assert.match(start, /voiceCreateVad\(\{[^}]*micChoice: voiceMicChoiceId[^}]*\}\)/);
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
  assert.ok(test.includes('new AC()') && test.indexOf('voiceOpenMicStream(') < test.indexOf('new AC()'), 'the context is made after the microphone');
  assert.ok(test.includes('[440, 660]') && test.includes('Math.pow(10, -12 / 20)') && test.includes('0.25'));
  assert.ok(test.includes("if (voiceCall) { toast('Hang up first"), 'not during a call');
  assert.ok(sliceBetween('async function voiceCarRun()', 'voiceStopPlayback();').includes('voiceRoute.busy'), 'a car check does not start while a Sound route action holds the microphone');
  assert.ok(sliceBetween('async function voiceRoomRun()', 'voiceStopPlayback();').includes('voiceRoute.busy'));
  assert.ok(sliceBetween('function voiceRoomStop()', 'async function voiceRoomRun()').includes('voiceRouteStop()'), 'closing the sheet lets go of a test');
});
