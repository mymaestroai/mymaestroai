'use strict';
// Audio focus for calls: a very quiet looping WAV in a hidden <audio> element, so a phone browser takes full audio focus and other apps pause.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { voiceFocusWav, voiceCreateAudioFocus } = require('../lib/ui-voice');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tag = (u, o) => String.fromCharCode(u[o], u[o + 1], u[o + 2], u[o + 3]);

test('voiceFocusWav: a valid 16-bit mono PCM WAV of very quiet noise', () => {
  const w = voiceFocusWav(2, 8000), dv = new DataView(w.buffer, w.byteOffset, w.byteLength);
  assert.ok(w instanceof Uint8Array);
  assert.strictEqual(w.length, 44 + 2 * 2 * 8000);
  assert.strictEqual(tag(w, 0), 'RIFF'); assert.strictEqual(tag(w, 8), 'WAVE'); assert.strictEqual(tag(w, 12), 'fmt '); assert.strictEqual(tag(w, 36), 'data');
  assert.strictEqual(dv.getUint32(4, true), w.length - 8);
  assert.strictEqual(dv.getUint32(16, true), 16); assert.strictEqual(dv.getUint16(20, true), 1); assert.strictEqual(dv.getUint16(22, true), 1);
  assert.strictEqual(dv.getUint32(24, true), 8000); assert.strictEqual(dv.getUint32(28, true), 16000); assert.strictEqual(dv.getUint16(32, true), 2); assert.strictEqual(dv.getUint16(34, true), 16);
  assert.strictEqual(dv.getUint32(40, true), 2 * 2 * 8000);
  let peak = 0, nonzero = 0;
  for (let i = 44; i < w.length; i += 2) { const v = dv.getInt16(i, true); peak = Math.max(peak, Math.abs(v)); if (v) nonzero++; }
  assert.ok(peak >= 10 && peak <= 100, 'peak ' + peak);
  assert.ok(nonzero > 0);
  assert.deepStrictEqual(Array.from(voiceFocusWav(2, 8000)), Array.from(w), 'deterministic');
});

test('voiceFocusWav: longer than 5 seconds by default (Chrome gives full focus only then)', () => {
  const w = voiceFocusWav(), dv = new DataView(w.buffer, w.byteOffset, w.byteLength);
  assert.ok((dv.getUint32(40, true) / 2) / dv.getUint32(24, true) > 5);
});

function fakeEnv(playImpl) {
  const log = { created: [], appended: [], urls: 0, blobs: [], plays: 0, pauses: 0 };
  const doc = {
    body: { appendChild: (e) => log.appended.push(e) },
    createElement: (t) => {
      const e = { tag: t, style: {}, attrs: {}, setAttribute(k, v) { e.attrs[k] = v; }, currentTime: 5,
        play() { log.plays++; return playImpl(); }, pause() { log.pauses++; } };
      log.created.push(e); return e;
    },
  };
  const URLf = { createObjectURL: () => { log.urls++; return 'blob:x'; } };
  const BlobF = function (parts, opts) { log.blobs.push({ parts, opts }); };
  return { log, args: { doc, URL: URLf, Blob: BlobF } };
}

test('voiceCreateAudioFocus: start plays a looping unmuted hidden element synchronously and resolves true', async () => {
  const { log, args } = fakeEnv(() => Promise.resolve());
  const f = voiceCreateAudioFocus(args);
  assert.strictEqual(f.running, false);
  const p = f.start();
  assert.strictEqual(log.plays, 1, 'play() is called inside start()');
  const e = log.created[0];
  assert.strictEqual(e.tag, 'audio'); assert.strictEqual(e.loop, true); assert.strictEqual(e.muted, false); assert.strictEqual(e.volume, 1);
  assert.strictEqual(e.preload, 'auto'); assert.strictEqual(e.playsInline, true); assert.ok('playsinline' in e.attrs);
  assert.strictEqual(e.style.display, 'none'); assert.strictEqual(e.attrs['aria-hidden'], 'true'); assert.strictEqual(e.src, 'blob:x');
  assert.strictEqual(log.appended.length, 1);
  assert.strictEqual(log.blobs[0].opts.type, 'audio/wav');
  assert.strictEqual(await p, true);
  assert.strictEqual(f.running, true);
});

test('voiceCreateAudioFocus: a refused or throwing play resolves false and never rejects', async () => {
  const a = voiceCreateAudioFocus(fakeEnv(() => Promise.reject(new Error('NotAllowed'))).args);
  assert.strictEqual(await a.start(), false); assert.strictEqual(a.running, false);
  const b = voiceCreateAudioFocus(fakeEnv(() => { throw new Error('boom'); }).args);
  assert.strictEqual(await b.start(), false); assert.strictEqual(b.running, false);
});

test('voiceCreateAudioFocus: stop pauses and resets; start twice makes one element and one blob URL; stop is safe early and twice', async () => {
  const { log, args } = fakeEnv(() => Promise.resolve());
  const f = voiceCreateAudioFocus(args);
  assert.doesNotThrow(() => f.stop());
  await f.start(); assert.strictEqual(await f.start(), true);
  assert.strictEqual(log.created.length, 1); assert.strictEqual(log.urls, 1); assert.strictEqual(log.plays, 1);
  f.stop(); f.stop();
  assert.strictEqual(f.running, false); assert.ok(log.pauses >= 1); assert.strictEqual(log.created[0].currentTime, 0);
  assert.strictEqual(await f.start(), true);   // the next call reuses the element and the blob
  assert.strictEqual(log.created.length, 1); assert.strictEqual(log.urls, 1); assert.strictEqual(log.plays, 2);
});

test('voiceCreateAudioFocus: no document means start resolves false and stop is harmless', async () => {
  const f = voiceCreateAudioFocus({});
  assert.strictEqual(await f.start(), false); assert.doesNotThrow(() => f.stop()); assert.strictEqual(f.running, false);
  assert.strictEqual(await voiceCreateAudioFocus().start(), false);
});

// ── source checks ──
const upTo = (src, startMark, awaitMark) => { const i = src.indexOf(startMark); assert.ok(i >= 0, startMark); const j = src.indexOf(awaitMark, i); assert.ok(j > i, awaitMark); return [i, j]; };

test('phone: the focus is created and started in the tap before any await, stopped in the teardown, with the hint', () => {
  const js = read('mobile.js'), html = read('mobile.html');
  const i = js.indexOf('function voiceCallStart()'), body = js.slice(i, js.indexOf('\n}\n', i));
  const aw = body.search(/\bawait +[\w(]/), create = body.indexOf('voiceCreateAudioFocus({ doc: document, URL, Blob })'), start = body.indexOf('vc.focus.start()');
  assert.ok(create > 0 && start > create, 'created then started');
  assert.ok(aw < 0 || start < aw, 'before the first await');
  assert.ok(body.indexOf('typeof voiceCreateAudioFocus') >= 0 && /voiceFocusHint\(!ok \|\| /.test(body) && body.includes('voiceIsIOS()'));
  const t = js.indexOf('function voiceCallTeardown(vc)'), tb = js.slice(t, js.indexOf('\n}\n', t));
  assert.ok(/if \(vc\.focus\) \{ try \{ vc\.focus\.stop\(\); \} catch \{\} \}/.test(tb)); assert.ok(tb.includes('voiceFocusHint(false)'));
  assert.ok(/function voiceFocusHint\(show\)/.test(js));
  assert.ok(html.includes('<p id="cp-focus-hint" class="cp-focus-hint" role="status" hidden>Music playing? Pause it for a clearer call</p>'));
  assert.ok(html.indexOf('class="cp-top"') < html.indexOf('id="cp-focus-hint"'));
});

test('desktop: started before the first await, stopped in the teardown, hint only when play is refused', () => {
  const app = read('app.js'), html = read('index.html');
  const i = app.indexOf('async function voiceCallStart(chatId)'), body = app.slice(i, app.indexOf('\n    }\n', i));
  const aw = body.search(/\bawait\b/), create = body.indexOf('voiceCreateAudioFocus({ doc: document, URL, Blob })'), start = body.indexOf('focus.start()');
  assert.ok(create > 0 && start > create && start < aw, 'before the first await');
  assert.ok(body.indexOf('S.focus = focus') > 0 && body.indexOf('S.focus = focus') < aw);
  assert.ok(/!ok && S\.focus === focus/.test(body), 'hint only on refusal');
  const t = app.indexOf('function voiceCallTeardown()'), tb = app.slice(t, app.indexOf('\n    }\n', t));
  assert.ok(tb.includes('focus = S.focus') && tb.includes('S.focus = null') && tb.includes('focus.stop()'));
  assert.ok(app.includes('<div class="vcb-focus-hint" id="${id(\'focushint\')}" hidden>Music playing? Pause it for a clearer call</div>'));
  assert.ok(html.includes('.voice-callbar .vcb-focus-hint'));
});

test('each page makes one focus element and one sound, reused by every call (no pile-up over a long session)', () => {
  for (const f of ['app.js', 'mobile.js']) assert.ok(/window\.__voiceFocusOne \|\| \(window\.__voiceFocusOne = voiceCreateAudioFocus\(/.test(read(f)), f);
});

test('the synced blocks carry the new functions', () => {
  for (const f of ['app.js', 'mobile.js']) { const s = read(f); assert.strictEqual(s.split('function voiceFocusWav(').length, 2, f); assert.strictEqual(s.split('function voiceCreateAudioFocus(').length, 2, f); }
});
