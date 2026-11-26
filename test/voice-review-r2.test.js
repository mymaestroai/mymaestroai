'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createVoiceEngine } = require('../lib/voice/engine');
const manifest = require('../lib/voice/manifest');
const routes = require('../lib/voice/routes');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-restart-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bytes = Buffer.from('fake package');
  const name = 'sherpa-onnx-node';
  const pkg = { ...manifest.NODE_PACKAGES[name], bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  const open = (options = {}) => createVoiceEngine({
    dir, platform: 'linux', arch: 'x64', isEnabled: () => true,
    manifest: { ...manifest, NODE_PACKAGES: { ...manifest.NODE_PACKAGES, [name]: pkg } },
    fetchImpl: async () => { throw Error('unexpected download'); },
    spawnTar: async args => {
      fs.writeFileSync(path.join(args[args.indexOf('-C') + 1], 'package.json'), '{}');
      return { status: 0 };
    }, ...options,
  });
  const e = open();
  const choice = e.speedCheck({ cores: 2, freeMem: 1 });
  function touch(file, value = '') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  }
  for (const item of e.plan(choice)) {
    const marker = item.id.replace(/[^A-Za-z0-9._-]/g, '_') + '.json';
    touch(path.join(e.paths.done, marker), JSON.stringify({ sha256: item.sha256 }));
    if (item.kind === 'npm') touch(path.join(e.paths.nodeModules, item.def.name, 'package.json'));
    if (item.kind === 'model') fs.mkdirSync(e.paths.model(item.def.id), { recursive: true });
    if (item.kind === 'web') for (const [file, def] of Object.entries(manifest.WEB_FILES)) {
      if (def.pkg === item.def.id) touch(path.join(e.paths.web, file));
    }
  }
  return { open, bytes, state: () => JSON.parse(fs.readFileSync(e.paths.state, 'utf8')),
    removeRequired: () => fs.unlinkSync(path.join(e.paths.nodeModules, name, 'package.json')) };
}

test('startup retries a failed required check without downloading again', async t => {
  const f = fixture(t);
  f.removeRequired();
  const first = f.open({ fetchImpl: async () => {
    assert.equal(f.state().verifyPending, true);
    return new Response(f.bytes);
  }, check: async () => { throw Error('worker failed'); } });
  await first.install();
  assert.match(first.status().error, /worker failed/);
  let checks = 0;
  const next = f.open({ check: async () => { checks++; } });
  assert.equal(next.status().ready, false);
  const ctx = { getVoice: () => ({ engine: next }), getSetting: () => ({ enabled: true }) };
  routes.resetEnsureForTests();
  t.after(() => routes.resetEnsureForTests());
  assert.equal(routes.resumeIfNeeded(ctx), true);
  await next.install(); // joins the run already started by resumeIfNeeded
  assert.equal(checks, 1);
  assert.equal(f.state().verifyPending, undefined);
  assert.equal(f.open().status().ready, true);
});

test('a complete legacy install starts ready without work', t => {
  const f = fixture(t);
  let checks = 0;
  const engine = f.open({ check: async () => { checks++; } });
  assert.equal(engine.status().ready, true);
  assert.equal(routes.resumeIfNeeded({ getVoice: () => ({ engine }), getSetting: () => ({}) }), false);
  assert.equal(checks, 0);
});

test('disable aborts a pending fetch and preserves the unfinished check', async t => {
  const f = fixture(t);
  f.removeRequired();
  let enabled = true, signal;
  const e = f.open({ isEnabled: () => enabled, check: async () => assert.fail('unexpected check'),
    fetchImpl: async (_, opts) => new Promise((resolve, reject) => {
      signal = opts.signal;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) });
  const pending = e.install();
  assert.equal(signal.aborted, false);
  enabled = false;
  e.cancelDownload();
  assert.equal(signal.aborted, true);
  await assert.rejects(pending, { code: 'voice_off' });
  assert.equal(e.status().error, '');
  assert.equal(f.state().verifyPending, true);
  assert.deepEqual(fs.readdirSync(e.paths.downloads).filter(n => n.endsWith('.part')), []);
});

test('optional failure gets one backoff timer while required voice stays ready', async t => {
  routes.resetEnsureForTests();
  t.after(() => routes.resetEnsureForTests());
  let attempts = 0, pending = true;
  const timers = [];
  const engine = {
    status: () => ({ platformSupported: true, ready: true, optionalRetry: pending,
      error: pending ? 'optional download failed' : '' }),
    async install() {
      if (++attempts === 1) throw Error('optional download failed');
      pending = false;
    },
  };
  const ctx = { engine, getSetting: () => ({ enabled: true }),
    setTimer(fn) { timers.push(fn); return timers.length; }, clearTimer() {} };
  assert.equal(routes.ensureEngines(ctx), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers.length, 1);
  assert.equal(routes.ensureEngines(ctx), false);
  timers[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.equal(timers.length, 1);
  assert.equal(routes.ensureEngines(ctx), false);
});
