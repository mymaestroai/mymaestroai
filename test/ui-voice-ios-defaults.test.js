'use strict';
const test = require('node:test');
const assert = require('node:assert');
const V = require('../lib/ui-voice.js');

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

test('voiceIsIOSNav: iPhone, iPad, iPadOS desktop site', () => {
  assert.strictEqual(V.voiceIsIOSNav({ userAgent: IPHONE, platform: 'iPhone', maxTouchPoints: 5 }), true);
  assert.strictEqual(V.voiceIsIOSNav({ userAgent: IPAD, platform: 'iPad', maxTouchPoints: 5 }), true);
  assert.strictEqual(V.voiceIsIOSNav({ userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 5 }), true);
});

test('voiceIsIOSNav: everything else is false', () => {
  assert.strictEqual(V.voiceIsIOSNav({ userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 0 }), false);
  assert.strictEqual(V.voiceIsIOSNav({ userAgent: ANDROID, platform: 'Linux armv81', maxTouchPoints: 5 }), false);
  assert.strictEqual(V.voiceIsIOSNav({ userAgent: WIN, platform: 'Win32', maxTouchPoints: 10 }), false);
  assert.strictEqual(V.voiceIsIOSNav(null), false);
  assert.strictEqual(V.voiceIsIOSNav(undefined), false);
  assert.strictEqual(V.voiceIsIOSNav({ get userAgent() { throw new Error('no'); } }), false);
});

test('voiceCleanPrefs keeps 1200 and set, drops unknown set keys', () => {
  assert.strictEqual(V.voiceCleanPrefs({ echoHold: 1200 }).echoHold, 1200);
  assert.strictEqual(V.voiceCleanPrefs({ echoHold: 1100 }).echoHold, 600);
  assert.deepStrictEqual(V.voiceCleanPrefs({ set: ['echoHold', 'loudness', 'bogus', 'micLevel'] }).set, ['loudness', 'echoHold']);
  assert.deepStrictEqual(V.voiceCleanPrefs({ set: [] }).set, []);
  assert.strictEqual('set' in V.voiceCleanPrefs({}), false);
  assert.strictEqual('set' in V.voiceCleanPrefs({ set: 'loudness' }), false);
});

test('voiceEchoChoices and voiceEchoHoldOk', () => {
  assert.deepStrictEqual(V.voiceEchoChoices(true), [0, 600, 1000, 1200, 1500]);
  assert.deepStrictEqual(V.voiceEchoChoices(false), [0, 600, 1000, 1500]);
  assert.notStrictEqual(V.voiceEchoChoices(false), V.VOICE_ECHO_HOLDS);
  assert.deepStrictEqual(V.VOICE_ECHO_HOLDS, [0, 600, 1000, 1500]);
  assert.strictEqual(V.VOICE_ECHO_HOLD_IOS, 1200);
  assert.strictEqual(V.voiceEchoHoldOk(1200), true);
  assert.strictEqual(V.voiceEchoHoldOk(0), true);
  assert.strictEqual(V.voiceEchoHoldOk(1100), false);
});

test('voiceEchoHoldLabel(1200)', () => {
  assert.strictEqual(V.voiceEchoHoldLabel(1200), '1.2 s');
  assert.strictEqual(V.voiceEchoHoldLabel(0), 'off');
});

test('voiceMarkDeviceSet', () => {
  assert.deepStrictEqual(V.voiceMarkDeviceSet({ a: 1 }, ['echoHold', 'bogus']).set, ['echoHold']);
  assert.deepStrictEqual(V.voiceMarkDeviceSet({ set: ['echoHold'] }, ['loudness', 'echoHold']).set, ['loudness', 'echoHold']);
  const src = { set: ['loudness'] };
  V.voiceMarkDeviceSet(src, ['echoHold']);
  assert.deepStrictEqual(src.set, ['loudness']);
});

test('voiceDevicePrefs on iOS', () => {
  const fresh = V.voiceCleanPrefs(null);
  const r = V.voiceDevicePrefs(fresh, true);
  assert.strictEqual(r.loudness, 'normal');
  assert.strictEqual(r.echoHold, 1200);
  assert.strictEqual(r.loudnessBt, fresh.loudnessBt);
  assert.strictEqual(fresh.loudness, 'louder');
  assert.strictEqual(V.voiceDevicePrefs(V.voiceCleanPrefs({ loudness: 'loudest' }), true).loudness, 'loudest');
  assert.strictEqual(V.voiceDevicePrefs(V.voiceCleanPrefs({ loudness: 'louder', set: ['loudness'] }), true).loudness, 'louder');
  assert.strictEqual(V.voiceDevicePrefs(V.voiceCleanPrefs({ echoHold: 0 }), true).echoHold, 0);
  assert.strictEqual(V.voiceDevicePrefs(V.voiceCleanPrefs({ echoHold: 600, set: ['echoHold'] }), true).echoHold, 600);
  assert.strictEqual(V.voiceDevicePrefs(V.voiceCleanPrefs({ echoHold: 1000 }), true).echoHold, 1000);
  const mixed = V.voiceDevicePrefs(V.voiceCleanPrefs({ set: ['loudness'] }), true);
  assert.strictEqual(mixed.loudness, 'louder');
  assert.strictEqual(mixed.echoHold, 1200);
});

test('voiceDevicePrefs off iOS is an identical copy', () => {
  for (const raw of [null, { loudness: 'loudest' }, { echoHold: 0, set: ['echoHold'] }, { loudness: 'louder', echoHold: 600, set: [] }, { echoHold: 1200 }]) {
    const p = V.voiceCleanPrefs(raw);
    const r = V.voiceDevicePrefs(p, false);
    assert.deepStrictEqual(r, p);
    assert.notStrictEqual(r, p);
  }
});

test('voiceCarCheckResult: unchanged results, 1200 accepted as current', () => {
  const none = [{ delayMs: null, echoDb: -80 }, { delayMs: null, echoDb: -80 }, { delayMs: null, echoDb: -80 }];
  assert.strictEqual(V.voiceCarCheckResult(none, { echoHold: 1000 }).echoHold, 1000);
  assert.strictEqual(V.voiceCarCheckResult(none, { echoHold: 1100 }).echoHold, 600);
  assert.strictEqual(V.voiceCarCheckResult(none, {}).echoHold, 600);
  const r = V.voiceCarCheckResult(none, { echoHold: 1200 });
  assert.strictEqual(r.echoHold, 1200);
  assert.match(r.line, /1\.2 s/);
  const heard = [{ delayMs: 400, echoDb: -50 }, { delayMs: 420, echoDb: -50 }, { delayMs: 410, echoDb: -50 }];
  assert.strictEqual(V.voiceCarCheckResult(heard, { echoHold: 1200 }).echoHold, 1000);
  const late = [{ delayMs: 1100, echoDb: -50 }, { delayMs: 1100, echoDb: -50 }, { delayMs: 1100, echoDb: -50 }];
  assert.strictEqual(V.voiceCarCheckResult(late, { echoHold: 600 }).echoHold, 1500);
  const mid = [{ delayMs: 800, echoDb: -50 }, { delayMs: 800, echoDb: -50 }, { delayMs: 800, echoDb: -50 }];
  assert.strictEqual(V.voiceCarCheckResult(mid, { echoHold: 600 }).echoHold, 1500);
});
