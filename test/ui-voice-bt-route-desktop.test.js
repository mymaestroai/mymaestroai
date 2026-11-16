'use strict';
// Call sound through the car, computer layout (app.js): the microphone choice reaches the VAD, the route words of the call bar's microphone line, the plain line
// once per call, the call's outputs made again once the microphone is open (voiceCallOutputsRenew, run against fakes), and the Sound route block.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const LL = require('../lib/ui-voice-call');

function between(a, b) {
  const i = app.indexOf(a), j = app.indexOf(b, i + a.length);
  assert.ok(i > 0 && j > i, 'found ' + a);
  return app.slice(i, j);
}
const routeBlock = () => between('    // ── Call sound route:', '    // ── Wake phrase standby');
const soundBlock = () => between('    // Sound route (Settings, Voices,', '    // Message rendering\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The call's route functions run against fakes. Names the page provides are passed in.
function makeRoute(o = {}) {
  const log = { toasts: [], moved: [], loud: 0, made: [], timeouts: [] };
  class Ctx {
    constructor() { this.state = 'suspended'; this.n = Ctx.n = (Ctx.n || 0) + 1; log.made.push(this); }
    resume() { this.state = 'running'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }
  const bar = { textContent: '' };
  const S = { call: { id: 'c' }, vad: null, thinking: null, keepAlive: null, chatId: 'c1', micLabel: 'Speakerphone', micLost: false, micLine: '', route: null, routeSeen: 0, outputsRenewed: 0, renewPending: false, renewing: false, renewTimer: null };
  Object.assign(S, o.S || {});
  const voicePlay = { token: 0, ctx: new Ctx(), source: null, btn: null, busy: 0 };
  const win = { AudioContext: o.noAC ? undefined : Ctx, speechSynthesis: { speaking: false } };
  const src = routeBlock().replace(/^[\s\S]*?(?=    function voiceMicChoiceId)/, '');
  const make = new Function('voiceCallS', 'voicePlay', 'window', 'navigator', 'voiceIsIOSNav', 'voiceIsAndroidNav', 'voiceById', 'voiceMicLineText', 'hubToast', 'voiceLoudApply', 'voicePrefsNow', 'setTimeout',
    src + '\nreturn { voiceRenewApplies, voiceMicChoiceId, voiceRouteSuffix, voiceCallVadFor, voiceCallOnRoute, voiceCallOnMicChange, voiceCallSounding, voiceCallOutputsRenew, VOICE_ROUTE_PLAIN_LINE, voiceRouteReadyMake, voiceRouteDone, voiceRouteSettle, voiceRouteWait };');
  const api = make(S, voicePlay, win, { userAgent: o.android === false ? 'Mozilla/5.0 (X11; Linux x86_64)' : 'Mozilla/5.0 (Linux; Android 14; Pixel Fold)' }, () => !!o.ios, require('../lib/ui-voice').voiceIsAndroidNav, () => bar, (i) => 'Microphone: ' + (i.label || 'default'), (t, ms) => log.toasts.push([t, ms]),
    () => { log.loud++; }, () => ({ micDevice: o.choice || undefined }), (f, ms) => { log.timeouts.push({ f, ms }); return o.holdTimers ? 0 : setTimeout(f, ms); });
  return { api, S, voicePlay, win, log, bar, Ctx };
}

test('voiceCreateVad gets micChoice in voiceCallStart; voiceMicChoiceId reads prefs.micDevice', () => {
  const start = between('    async function voiceCallStart(chatId)', '    function voiceCallSseMood');
  assert.match(start, /voiceCreateVad\(\{[^\n]*micChoice: voiceMicChoiceId/);
  assert.match(start, /voiceCreateVad\(\{[^\n]*bluetoothFirst: voiceIsAndroidNav\(navigator\)/);
  assert.match(start, /voiceCallVadFor\(vad\)/);
  assert.strictEqual(makeRoute({ choice: { id: 'dev-9', label: 'Headset' } }).api.voiceMicChoiceId(), 'dev-9');
  assert.strictEqual(makeRoute().api.voiceMicChoiceId(), null);
});

test('route words after the microphone name', () => {
  const { api } = makeRoute();
  assert.strictEqual(api.voiceRouteSuffix({ bluetooth: true }), ' · car or Bluetooth');
  assert.strictEqual(api.voiceRouteSuffix({ bluetooth: false, bluetoothListed: true, chosen: null }), ' · a car or Bluetooth device is connected but not used');
  assert.strictEqual(api.voiceRouteSuffix({ bluetooth: false, bluetoothListed: true, chosen: 'x' }), '');
  assert.strictEqual(api.voiceRouteSuffix({ fellBack: true }), ' · the chosen microphone is not available');
  assert.strictEqual(api.voiceRouteSuffix(null), '');
  assert.match(between('          mic: (info) =>', 'micLost: (on)'), /voiceMicLineText\(info\) \+ voiceRouteSuffix\(voiceCallS\.route\)/);
});

test('the controller does not pass onRoute: the page adds it to vad.start, and the route words reach the bar', () => {
  const t = makeRoute();
  const got = [];
  const vad = { start: (h) => { got.push(h); return Promise.resolve(); } };
  t.S.vad = vad;
  const view = t.api.voiceCallVadFor(vad);
  const passed = [];
  view.start({ onMicInfo: () => passed.push('info'), onMicChange: (ev) => passed.push(ev.reason) });
  assert.strictEqual(typeof got[0].onRoute, 'function');
  assert.strictEqual(typeof got[0].onMicInfo, 'function');
  got[0].onMicChange({ ok: true, changed: false, reason: 'x' });
  assert.deepStrictEqual(passed, ['x']);
  got[0].onRoute({ label: 'Speakerphone', bluetooth: false, bluetoothListed: true, chosen: null });
  assert.strictEqual(t.bar.textContent, 'Microphone: Speakerphone · a car or Bluetooth device is connected but not used');
  assert.strictEqual(t.S.route.bluetoothListed, true);
});

test('the plain line comes once per call', () => {
  const t = makeRoute({ ios: true });
  const vad = { start() {} }; t.S.vad = vad;
  const r = { label: 'Speakerphone', bluetooth: false, bluetoothListed: true, chosen: null };
  t.api.voiceCallOnRoute(vad, r); t.api.voiceCallOnRoute(vad, r);
  assert.strictEqual(t.log.toasts.length, 1);
  assert.strictEqual(t.log.toasts[0][0], 'Your car or Bluetooth device is connected, but this call is using the phone. Voice settings → Sound route can switch it.');
  assert.strictEqual(t.log.toasts[0][1], 5000);
  const u = makeRoute({ ios: true }); u.S.vad = vad;
  u.api.voiceCallOnRoute(vad, { bluetooth: true, bluetoothListed: true }); u.api.voiceCallOnRoute(vad, { bluetooth: false, bluetoothListed: true, chosen: 'x' });
  assert.strictEqual(u.log.toasts.length, 0);
});

test('voiceCallOutputsRenew: a new reply context, the keep-alive moves, the old one closes 300 ms later; counted', async () => {
  const t = makeRoute();
  const old = t.voicePlay.ctx;
  t.S.keepAlive = { moveTo: (c) => t.log.moved.push(c) };
  assert.strictEqual(await t.api.voiceCallOutputsRenew(), true);
  assert.notStrictEqual(t.voicePlay.ctx, old);
  assert.strictEqual(t.voicePlay.ctx.state, 'running');
  assert.deepStrictEqual(t.log.moved, [t.voicePlay.ctx]);
  assert.strictEqual(t.log.loud, 1);
  assert.strictEqual(t.S.outputsRenewed, 1);
  assert.strictEqual(old.state, 'suspended', 'the old context is still open right after the switch');
  await wait(380);
  assert.strictEqual(old.state, 'closed');
  assert.strictEqual(t.voicePlay.ctx.state, 'running');
});

test('voiceCallOutputsRenew is not run on iOS and never cuts a sentence', async () => {
  const ios = makeRoute({ ios: true });
  assert.strictEqual(await ios.api.voiceCallOutputsRenew(), false);
  assert.strictEqual(ios.log.made.length, 1);
  const t = makeRoute();
  const old = t.voicePlay.ctx;
  t.voicePlay.source = {};   // a sentence plays
  assert.strictEqual(await t.api.voiceCallOutputsRenew(), false);
  assert.strictEqual(t.voicePlay.ctx, old); assert.strictEqual(t.S.renewPending, true); assert.strictEqual(t.S.outputsRenewed, 0);
  t.voicePlay.source = null;
  await wait(1100);   // the one-second check runs it
  assert.strictEqual(t.S.outputsRenewed, 1); assert.strictEqual(t.S.renewPending, false); assert.notStrictEqual(t.voicePlay.ctx, old);
  const b = makeRoute(); b.voicePlay.busy = 1;   // a playback between two sentences
  assert.strictEqual(await b.api.voiceCallOutputsRenew(), false); assert.strictEqual(b.S.renewPending, true);
  clearTimeout(b.S.renewTimer);
});

test('the first route renews once; a changed microphone renews again; an unchanged one does not', async () => {
  const t = makeRoute();
  const vad = { start() {} }; t.S.vad = vad;
  t.api.voiceCallOnRoute(vad, { bluetooth: true, bluetoothListed: true });
  await wait(20);
  assert.strictEqual(t.S.outputsRenewed, 1);
  t.api.voiceCallOnRoute(vad, { bluetooth: true, bluetoothListed: true });   // a later route report alone does nothing
  await wait(20);
  assert.strictEqual(t.S.outputsRenewed, 1);
  t.api.voiceCallOnMicChange(vad, { ok: true, changed: false });
  t.api.voiceCallOnMicChange(vad, { ok: false, changed: true });
  await wait(20);
  assert.strictEqual(t.S.outputsRenewed, 1);
  t.api.voiceCallOnMicChange(vad, { ok: true, changed: true });
  await wait(20);
  assert.strictEqual(t.S.outputsRenewed, 2);
});

test('a failure leaves the call as it was; no AudioContext: nothing happens', async () => {
  const t = makeRoute();
  t.S.keepAlive = { moveTo() { throw new Error('boom'); } };
  assert.strictEqual(await t.api.voiceCallOutputsRenew(), true);   // the keep-alive failing does not undo the switch
  const n = makeRoute({ noAC: true }); const old = n.voicePlay.ctx;
  assert.strictEqual(await n.api.voiceCallOutputsRenew(), false);
  assert.strictEqual(n.voicePlay.ctx, old);
});

test('every user of the reply context reads it when it plays; the playback count and the thinking sound report busy', () => {
  assert.match(app, /voicePlay\.busy\+\+;/);
  assert.match(app, /voicePlay\.busy = Math\.max\(0, voicePlay\.busy - 1\);/);
  assert.match(app, /busy\(\) \{ return on; \}/);
  assert.match(app, /voiceLinkTone\(voicePlay\.ctx, up\)/);
  const hook = between('window.__voiceBt = {', ';   // read-only hooks for the browser proof');
  assert.match(hook, /outputsRenewed: \(\) => S\.outputsRenewed \|\| 0/);
});

test('the Sound route block is in Settings and in the chat voice panel, below the Car or Bluetooth check', () => {
  const car = app.indexOf("h += row('Car or Bluetooth check'"), route = app.indexOf("h += row('Sound route', voiceRouteBlockHtml());");
  assert.ok(car > 0 && route > car && route < app.indexOf("h += row('Replies'"));
  const pop = app.indexOf('data-vp="car" id="${id(\'car\')}"'), popRoute = app.indexOf('Sound route</div>${voiceRouteBlockHtml()}');
  assert.ok(pop > 0 && popRoute > pop && popRoute < app.indexOf('${voiceWakeRowsHtml(chatId)}`;'));
  const html = soundBlock();
  assert.match(html, /data-route="list">Sound devices</);
  assert.match(html, /data-route="test">Test sound</);
  assert.ok(html.includes("On Android the call's sound follows the microphone chosen here.") || html.includes("On Android the call\\'s sound follows the microphone chosen here."));
});

// The Sound route functions run against a tiny DOM.
function makeDom(o = {}) {
  const boxes = [], outs = [];
  const mk = (tag) => { const e = { tag, children: [], dataset: {}, style: {}, _text: '', appendChild(c) { e.children.push(c); return c; }, set textContent(v) { e._text = v; if (v === '') e.children = []; }, get textContent() { return e._text + e.children.map((c) => c.textContent).join(''); } }; return e; };
  const doc = { createElement: mk, createTextNode: (t) => ({ textContent: t }), querySelectorAll: (sel) => (sel === '.voice-route-list' ? boxes : sel === '.voice-route-out' ? outs : []) };
  outs.push(mk('span')); boxes.push(mk('div'));
  const saved = []; let prefs = Object.assign({}, o.prefs || {});
  const S = { call: o.call || null, vad: o.vad || null };
  const toasts = [], opened = [];
  const src = soundBlock().replace(/^[\s\S]*?(?=    const VOICE_ROUTE_NEARBY_LINE)/, '').replace(/    document\.addEventListener\('click'[\s\S]*$/, '');
  const make = new Function('document', 'voiceCallS', 'voicePrefsNow', 'voiceSavePrefs', 'localStorage', 'hubToast', 'voiceRoom', 'voiceRec', 'voiceTest', 'navigator', 'voiceOpenMicStream', 'voiceAudioRoutes', 'voiceMicError', 'voiceMicChoiceId', 'window', 'setTimeout',
    'let voicePrefsCache = null;\n' + src + '\nreturn { voiceRouteList, voiceRouteUse, voiceRouteTest, voiceRoutePaint, voiceRouteUi };');
  const nav = o.nav || { mediaDevices: { enumerateDevices: async () => o.list || [] } };
  const api = make(doc, S, () => prefs, (st, p) => { saved.push(p); prefs = p; }, {}, (t) => toasts.push(t),
    { active: false }, { chatId: null, busy: false, guard: { pending: false } }, { mic: null, guard: { pending: false } }, nav,
    async (n, op) => { opened.push(op === undefined ? 'open' : op); return { stream: { getTracks: () => [{ stop() { opened.push('stopped'); } }] } }; }, LL.voiceAudioRoutes,
    () => 'mic error', () => (prefs.micDevice ? prefs.micDevice.id : null), { AudioContext: o.AC }, setTimeout);
  return { api, boxes, outs, saved, toasts, opened, S, prefs: () => prefs };
}

test('Use saves micDevice and calls useMic during a call; Automatic saves none', async () => {
  const used = [];
  const vad = { useMic: async (id) => { used.push(id); return true; }, routes: async () => ({ inputs: [], outputs: [], bluetoothInput: null }) };
  const d = makeDom({ call: {}, vad });
  await d.api.voiceRouteUse('dev-1', 'Bluetooth headset');
  assert.deepStrictEqual(d.prefs().micDevice, { id: 'dev-1', label: 'Bluetooth headset' });
  assert.deepStrictEqual(used, ['dev-1']);
  await d.api.voiceRouteUse('', '');
  assert.strictEqual(d.prefs().micDevice, undefined);
  assert.deepStrictEqual(used, ['dev-1', null]);
  const e = makeDom({ prefs: { micDevice: { id: 'a', label: 'A' }, mode: 'tap' } });
  await e.api.voiceRouteUse('', '');
  assert.strictEqual(e.prefs().micDevice, undefined); assert.strictEqual(e.prefs().mode, 'tap');
});

test('the list: Automatic first, in use / Bluetooth / chosen marks, the Nearby devices line only without a Bluetooth input', async () => {
  assert.strictEqual(typeof LL.voiceAudioRoutes, 'function', 'the library has voiceAudioRoutes');
  const routes = LL.voiceAudioRoutes([{ kind: 'audioinput', deviceId: 'default', label: 'Default' }, { kind: 'audioinput', deviceId: 's', label: 'Speakerphone' }, { kind: 'audioinput', deviceId: 'b', label: 'Bluetooth headset' }, { kind: 'audiooutput', deviceId: 'default', label: 'Default' }], 's');
  const d = makeDom({ call: {}, vad: { routes: async () => routes }, prefs: { micDevice: { id: 'b', label: 'Bluetooth headset' } } });
  await d.api.voiceRouteList();
  const text = d.boxes[0].textContent;
  assert.match(text, /^Automatic \(car or Bluetooth first\) Use/);
  assert.match(text, /Speakerphone · in use Use/);
  assert.match(text, /Bluetooth headset · Bluetooth · chosen Use/);
  assert.ok(!/Default/.test(text), 'pseudo entries are skipped');
  assert.ok(!text.includes('Nearby devices'));
  const none = makeDom({ call: {}, vad: { routes: async () => LL.voiceAudioRoutes([{ kind: 'audioinput', deviceId: 's', label: 'Speakerphone' }], 's') } });
  await none.api.voiceRouteList();
  assert.ok(none.boxes[0].textContent.includes('No car or Bluetooth microphone is visible to the browser. If one is connected: Android Settings → Apps → Chrome → Permissions → Nearby devices → Allow, then start the call again.'));
});

test('without microphone permission the list opens the microphone once and lets it go', async () => {
  let calls = 0;
  const nav = { mediaDevices: { enumerateDevices: async () => (calls++ ? [{ kind: 'audioinput', deviceId: 'x', label: 'Speakerphone' }] : [{ kind: 'audioinput', deviceId: 'x', label: '' }]) } };
  const d = makeDom({ nav });
  await d.api.voiceRouteList();
  assert.deepStrictEqual(d.opened, ['open', 'stopped']);
  assert.match(d.boxes[0].textContent, /Speakerphone/);
});

test('Test sound opens the microphone first, then the context, plays two beeps, and lets both go; not during a call', async () => {
  const order = [];
  class AC {
    constructor() { order.push('context'); this.currentTime = 0; this.destination = {}; }
    resume() { return Promise.resolve(); }
    close() { order.push('closed'); return Promise.resolve(); }
    createOscillator() { const f = { value: 0 }; return { frequency: f, connect() {}, start() { order.push('beep' + f.value); }, stop() {} }; }
    createGain() { return { gain: {}, connect() {} }; }
  }
  const t = makeDom({ AC, prefs: { micDevice: { id: 'b', label: 'B' } } });
  const push = t.opened.push.bind(t.opened); t.opened.push = (v) => { order.push('mic'); return push(v); };
  await t.api.voiceRouteTest();
  assert.deepStrictEqual(order.slice(0, 4), ['mic', 'context', 'beep440', 'beep660']);
  assert.ok(order.includes('closed'));
  assert.ok(order.includes('mic') && t.opened.includes('stopped'));
  assert.deepStrictEqual(t.opened[0], { deviceId: 'b' });
  assert.ok(t.outs[0].textContent.startsWith('Where did you hear it? In the car: calls will be heard there too. On the phone: choose the car above, or check Nearby devices.'));
  const call = makeDom({ AC, call: {} });
  await call.api.voiceRouteTest();
  assert.strictEqual(call.outs[0].textContent, 'Not during a call.');
});

// ── review r1 ──
test('renewal only on Android (user agent, or a device list that looks like Chrome Android\'s); iOS never', async () => {
  const d = makeRoute({ android: false });
  assert.strictEqual(await d.api.voiceCallOutputsRenew(), false); assert.strictEqual(d.log.made.length, 1, 'a plain desktop: nothing is made');
  d.S.route = { label: 'Built-in microphone', bluetoothListed: false };
  assert.strictEqual(d.api.voiceRenewApplies(), false);
  for (const route of [{ label: 'Speakerphone' }, { label: 'Headset earpiece' }, { label: 'Wired headset' }, { label: 'USB audio' }, { label: 'Bluetooth headset' }]) {
    d.S.route = route; assert.strictEqual(d.api.voiceRenewApplies(), true, JSON.stringify(route));
  }
  d.S.route = { label: 'x', bluetoothListed: true };   // r2 FU1: a listed Bluetooth input alone does not make it Android
  assert.strictEqual(d.api.voiceRenewApplies(), false);
  d.S.route = { label: 'Speakerphone (2)' };
  assert.strictEqual(d.api.voiceRenewApplies(), false, 'only the exact names');
  const i = makeRoute({ ios: true }); i.S.route = { label: 'Speakerphone', bluetoothListed: true };
  assert.strictEqual(i.api.voiceRenewApplies(), false);
});

test('a route whose deviceId differs from the previous one renews again; the same id does not; a mic change before the first route does not', async () => {
  const t = makeRoute();
  const vad = { start() {} }; t.S.vad = vad;
  t.api.voiceCallOnMicChange(vad, { ok: true, changed: true });   // before the first route
  await wait(20); assert.strictEqual(t.S.outputsRenewed, 0);
  t.api.voiceCallOnRoute(vad, { deviceId: 'spk', label: 'Speakerphone' }); await wait(20);
  assert.strictEqual(t.S.outputsRenewed, 1);
  t.api.voiceCallOnRoute(vad, { deviceId: 'spk', label: 'Speakerphone' }); await wait(20);
  assert.strictEqual(t.S.outputsRenewed, 1, 'same microphone');
  t.api.voiceCallOnRoute(vad, { deviceId: 'bt', label: 'Bluetooth headset', bluetooth: true }); await wait(20);
  assert.strictEqual(t.S.outputsRenewed, 2, 'the microphone moved to the car');
});

test('F3: a context that is not running after the cap is closed, the old one stays, and it is tried again; at most 5 tries', async () => {
  const t = makeRoute();
  t.Ctx.prototype.resume = function () { return Promise.resolve(); };   // never reaches running
  const old = t.voicePlay.ctx; old.state = 'running';
  assert.strictEqual(await t.api.voiceCallOutputsRenew(), false);
  assert.strictEqual(t.voicePlay.ctx, old); assert.strictEqual(t.S.outputsRenewed, 0);
  assert.strictEqual(t.S.renewPending, true);
  assert.strictEqual(t.log.made[1].state, 'closed', 'the fresh one is closed');
  clearTimeout(t.S.renewTimer); t.S.renewTimer = null;
  for (let i = 0; i < 6; i++) await t.api.voiceCallOutputsRenew();
  assert.strictEqual(t.S.renewPending, false, 'stopped trying');
  const made = t.log.made.length;
  assert.strictEqual(t.S.renewFails, 5);
  assert.ok(made <= 7, 'no endless tries: ' + made);
  clearTimeout(t.S.renewTimer);
});

test('F4: a trigger during an active renewal sets renewPending and the retry timer; renewing is cleared only by its own call', async () => {
  const t = makeRoute();
  const first = t.api.voiceCallOutputsRenew();
  assert.strictEqual(t.S.renewing, t.S.call);
  assert.strictEqual(await t.api.voiceCallOutputsRenew(), false);
  assert.strictEqual(t.S.renewPending, true); assert.ok(t.S.renewTimer, 'a retry is scheduled');
  clearTimeout(t.S.renewTimer); t.S.renewTimer = null;
  await first;
  assert.strictEqual(t.S.renewing, false);
  // a renewal of an earlier call ending does not clear the flag of the current one
  const u = makeRoute(); const oldCall = u.S.call;
  const p = u.api.voiceCallOutputsRenew();
  u.S.call = { id: 'c2' }; u.S.renewing = u.S.call;
  await p;
  assert.strictEqual(u.S.renewing, u.S.call, 'the new call keeps its own flag');
});

test('the thinking sound counts as sounding: a renewal waits', async () => {
  const t = makeRoute(); t.S.thinking = { busy: () => true };
  assert.strictEqual(await t.api.voiceCallOutputsRenew(), false); assert.strictEqual(t.S.renewPending, true); assert.strictEqual(t.log.made.length, 1);
  clearTimeout(t.S.renewTimer);
});

// ── review r2 ──
test('r2 FU3: the failure count starts again when the microphone\'s deviceId changes', async () => {
  const t = makeRoute({ S: { renewFails: 5 } });
  const vad = { start() {} }; t.S.vad = vad;
  t.api.voiceCallOnRoute(vad, { deviceId: 'a', label: 'Speakerphone' }); await wait(20);
  assert.strictEqual(t.S.renewFails, 0, 'the first microphone is a new device too');
  t.S.renewFails = 5;
  t.api.voiceCallOnRoute(vad, { deviceId: 'a', label: 'Speakerphone' }); await wait(20);
  assert.strictEqual(t.S.renewFails, 5, 'the same microphone: no fresh tries');
  t.api.voiceCallOnRoute(vad, { deviceId: 'b', label: 'Bluetooth headset', bluetooth: true }); await wait(20);
  assert.strictEqual(t.S.renewFails, 0); assert.strictEqual(t.S.outputsRenewed, 2, 'the first route renewed, and the move renews again');
});

test('r2 B: Android: the call has a pending routeReady; iOS and other browsers have none', () => {
  const a = makeRoute({ holdTimers: true }); a.S.callStartedAt = Date.now(); a.api.voiceRouteReadyMake();
  assert.strictEqual(a.S.routeDone, false);
  assert.ok(a.api.voiceRouteWait(), 'a sentence waits');
  const i = makeRoute({ ios: true }); i.S.callStartedAt = Date.now(); i.api.voiceRouteReadyMake();
  assert.strictEqual(i.S.routeDone, true); assert.strictEqual(i.api.voiceRouteWait(), null);
  const d = makeRoute({ android: false }); d.S.callStartedAt = Date.now(); d.api.voiceRouteReadyMake();
  assert.strictEqual(d.S.routeDone, true); assert.strictEqual(d.api.voiceRouteWait(), null);
});

test('r2 B: the wait is bounded: 2500 ms from the call\'s start; none once that has passed or when no call is up', async () => {
  const t = makeRoute({ holdTimers: true }); t.S.callStartedAt = Date.now() - 1000; t.api.voiceRouteReadyMake();
  const w = t.api.voiceRouteWait();
  const tm = t.log.timeouts[t.log.timeouts.length - 1];
  assert.ok(tm.ms <= 1500 && tm.ms > 1400, 'the rest of 2500 ms: ' + tm.ms);
  tm.f(); await w;
  assert.strictEqual(t.S.routeDone, false);
  t.S.callStartedAt = Date.now() - 2600;
  assert.strictEqual(t.api.voiceRouteWait(), null);
  t.S.callStartedAt = Date.now(); t.S.call = null;
  assert.strictEqual(t.api.voiceRouteWait(), null, 'outside a call');
});

test('r2 B: the first renewal finishing settles routeReady; a deferred one keeps it waiting; the call ending settles it', async () => {
  const t = makeRoute(); t.S.callStartedAt = Date.now(); t.api.voiceRouteReadyMake();
  const vad = { start() {} }; t.S.vad = vad;
  let woke = false; t.api.voiceRouteWait().then(() => { woke = true; });
  await wait(5); assert.strictEqual(woke, false);
  t.api.voiceCallOnRoute(vad, { deviceId: 'spk', label: 'Speakerphone' }); await wait(30);
  assert.strictEqual(t.S.outputsRenewed, 1); assert.strictEqual(t.S.routeDone, true); assert.strictEqual(woke, true);
  const d = makeRoute({ holdTimers: true }); d.S.callStartedAt = Date.now(); d.api.voiceRouteReadyMake(); d.voicePlay.busy = 1;   // a sentence sounds
  const vd = { start() {} }; d.S.vad = vd;
  d.api.voiceCallOnRoute(vd, { deviceId: 'spk', label: 'Speakerphone' }); await wait(30);
  assert.strictEqual(d.S.renewPending, true); assert.strictEqual(d.S.routeDone, false, 'deferred: still waiting');
  d.api.voiceRouteDone(); assert.strictEqual(d.S.routeDone, true);
  const n = makeRoute({ android: false }); n.S.callStartedAt = Date.now(); n.api.voiceRouteReadyMake();
  assert.strictEqual(n.S.routeDone, true, 'not applicable: ready at once');
});

test('r2 B: voiceSpeakText waits for the first route during a call before it plays; a stop during the wait plays nothing; no wait outside a call', async () => {
  const src = between('    async function voiceSpeakText(agent, md, btn', '    document.addEventListener(\'click\'');
  const make = (o) => {
    const log = { hub: 0, waits: 0 };
    const voicePlay = { token: 1, btn: null, busy: 0, pre: null };
    const fn = new Function('voicePlay', 'voiceStopPlayback', 'voiceSpeechText', 'voiceSentences', 'voicePlayState', 'voiceReady', 'voicePlayHub', 'voiceDeviceFallback', 'hubToast', 'voiceCallS', 'voiceRouteWait', 'voicePlayDevice',
      src + '\nreturn voiceSpeakText;')(voicePlay, () => {}, (s) => s, (s) => [s], () => {}, () => true, async () => { log.hub++; }, () => false, () => {}, { linkLost: false }, () => { log.waits++; return o.wait ? o.wait() : null; }, async () => {});
    return { fn, log, voicePlay };
  };
  let release; const gate = new Promise((r) => { release = r; });
  const t = make({ wait: () => gate });
  const p = t.fn('a', 'Hello.', null, {}); await wait(5);
  assert.strictEqual(t.log.hub, 0, 'waiting for the route'); assert.strictEqual(t.voicePlay.busy, 0, 'not counted as sounding while it waits, so the renewal can run');
  release(); await p; assert.strictEqual(t.log.hub, 1);
  let rel2; const g2 = new Promise((r) => { rel2 = r; });
  const u = make({ wait: () => g2 });
  const q = u.fn('a', 'Hello.', null, {}); await wait(5);
  u.voicePlay.token = 2;   // a stop
  rel2(); await q; assert.strictEqual(u.log.hub, 0);
  const n = make({});
  await n.fn('a', 'Hello.', null, {}); assert.strictEqual(n.log.hub, 1);
});

test('r2 B: voiceCallStart makes the call\'s routeReady; the call ending settles it', () => {
  assert.match(app, /S\.callStartedAt = Date\.now\(\); if \(typeof voiceRouteReadyMake === 'function'\) voiceRouteReadyMake\(\);/);
  assert.match(between('      S.renewPending = false; S.renewFails = 0; S.route = null;', 'S.call = null; S.vad = null;'), /voiceRouteDone\(\)/);
});
