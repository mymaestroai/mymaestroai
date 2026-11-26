'use strict';
// Voice is on unless someone turned the switch off; the engines are fetched by themselves.
const { test } = require('node:test');
const assert = require('node:assert');
const { Readable, Writable } = require('node:stream');
const manifest = require('../lib/voice/manifest');
const routes = require('../lib/voice/routes');

test('isVoiceOn: false only for an explicit enabled:false', () => {
  for (const v of [undefined, null, {}, { defaultVoice: 'x' }, { enabled: true }]) assert.strictEqual(manifest.isVoiceOn(v), true);
  assert.strictEqual(manifest.isVoiceOn({ enabled: false }), false);
});

test('cleanVoiceSettings never invents enabled', () => {
  assert.ok(!('enabled' in manifest.cleanVoiceSettings({ defaultVoice: '' }, undefined)));
  assert.strictEqual(manifest.cleanVoiceSettings({ defaultVoice: '' }, { enabled: false }).enabled, false);
  assert.strictEqual(manifest.cleanVoiceSettings({ enabled: true }, undefined).enabled, true);
});

test('cleanVoicePatch never changes the switch', () => {
  assert.strictEqual(manifest.cleanVoicePatch({ enabled: true, sttModel: 'tiny.en' }, { enabled: false }).enabled, false);
  const o = manifest.cleanVoicePatch({ enabled: true, sttModel: 'tiny.en' }, undefined);
  assert.ok(!('enabled' in o)); assert.strictEqual(o.sttModel, 'tiny.en');
});

function fakeRes() {
  const chunks = [];
  const r = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  r.writeHead = (code) => { r.statusCode = code; r.headersSent = true; };
  r.finished = new Promise((resolve) => r.on('finish', resolve));
  r.json = () => JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return r;
}
function setup(stored, { ready = true, installing = false, platformSupported = true } = {}) {
  const calls = { install: [] };
  const engine = {
    status: () => ({ enabled: false, ready, installing, step: '', progress: 0, error: '', platformSupported, stt: { engine: 'local', model: 'tiny.en' }, tts: { engine: 'local', defaultVoice: 'af_heart' }, voices: [] }),
    install: (o) => { calls.install.push(o); return Promise.resolve(); },
  };
  const client = { stt: async () => ({ text: 'hi', ms: 1 }), tts: async () => ({ wav: Buffer.alloc(4), sampleRate: 24000, ms: 1 }), stop() {}, resume() {} };
  const deps = {
    jsonResponse: (res, code, data) => { res.writeHead(code); res.end(JSON.stringify(data)); },
    readBody: async () => '', getSetting: (k) => (k === 'voice' ? stored : undefined), updateSettings: () => {},
    getAgents: async () => [{ name: 'maestro' }], getVoice: () => ({ engine, client }), cloud: { keys: () => ({}) },
  };
  const call = async (method, url, body) => {
    const req = Readable.from(body ? [body] : []);
    Object.assign(req, { method, url, headers: body ? { 'content-type': 'audio/wav' } : {}, hubUser: { id: 'u', role: 'admin' } });
    const res = fakeRes(); await routes.handle(new URL(url, 'http://x').pathname, req, res, deps);
    if (!res.writableEnded) await new Promise(r => setTimeout(r, 5));
    await res.finished; return res;
  };
  return { calls, call };
}

test('routes: unset voice answers enabled true, stt is not voice_off; explicit off refuses', async () => {
  routes.resetEnsureForTests();
  const t = setup(undefined);
  assert.strictEqual((await t.call('GET', '/api/voice/status')).json().enabled, true);
  const wav = Buffer.alloc(108); wav.write('RIFF', 0); wav.write('WAVE', 8);
  const r = await t.call('POST', '/api/voice/stt?agent=maestro', wav);
  assert.ok(!(r.statusCode === 409 && r.json().error === 'voice_off'));
  const off = setup({ enabled: false });
  assert.strictEqual((await off.call('GET', '/api/voice/status')).json().enabled, false);
  const r2 = await off.call('POST', '/api/voice/stt?agent=maestro', wav);
  assert.strictEqual(r2.statusCode, 409); assert.strictEqual(r2.json().error, 'voice_off');
});

test('ensureEngines: starts once, waits 10 minutes, respects off/ready/installing/unsupported, never throws', async () => {
  routes.resetEnsureForTests();
  const logs = [];
  const mkEng = (st, install) => ({ status: () => ({ platformSupported: true, ready: false, installing: false, ...st }), install });
  let n = 0; const eng = mkEng({}, () => { n++; return Promise.resolve(); });
  const get = (v) => () => v;
  let clock = 1000000;
  assert.strictEqual(routes.ensureEngines({ engine: eng, getSetting: get({ sttModel: 'small.en' }), now: () => clock, log: (m) => logs.push(m) }), true);
  assert.strictEqual(n, 1); assert.ok(logs.includes('[voice] getting the speech engines (voice is on, not installed yet)'));
  clock += 9 * 60 * 1000; routes.ensureEngines({ engine: eng, getSetting: get(undefined), now: () => clock }); assert.strictEqual(n, 1);
  clock += 2 * 60 * 1000; routes.ensureEngines({ engine: eng, getSetting: get(undefined), now: () => clock }); assert.strictEqual(n, 2);
  for (const [stored, st] of [[{ enabled: false }, {}], [undefined, { ready: true }], [undefined, { installing: true }], [undefined, { platformSupported: false }]]) {
    routes.resetEnsureForTests(); const c = [];
    routes.ensureEngines({ engine: mkEng(st, (o) => { c.push(o); return Promise.resolve(); }), getSetting: get(stored), now: () => 5 });
    assert.strictEqual(c.length, 0);
  }
  routes.resetEnsureForTests(); const l2 = [];
  assert.doesNotThrow(() => routes.ensureEngines({ engine: mkEng({}, () => Promise.reject(new Error('offline'))), getSetting: get(undefined), now: () => 1, log: (m) => l2.push(m) }));
  await new Promise(r => setTimeout(r, 5)); assert.ok(l2.some(m => /offline/.test(m)));
  routes.resetEnsureForTests();
  assert.doesNotThrow(() => routes.ensureEngines({ engine: mkEng({}, () => { throw new Error('sync'); }), getSetting: get(undefined), now: () => 1 }));
});

test('GET /api/voice/status with unset settings and a not-ready engine starts the install', async () => {
  routes.resetEnsureForTests();
  const t = setup(undefined, { ready: false });
  await t.call('GET', '/api/voice/status');
  assert.strictEqual(t.calls.install.length, 1);
  routes.resetEnsureForTests();
  const off = setup({ enabled: false }, { ready: false }); await off.call('GET', '/api/voice/status'); assert.strictEqual(off.calls.install.length, 0);
});
