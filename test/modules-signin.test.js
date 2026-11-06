'use strict';
// Device sign-in and the Ask Maestro help message (lib/modules), with a fake oauth implementation.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createConnectors } = require('../lib/connectors');
const { createModules } = require('../lib/modules');

const FIX_ROOT = path.join(__dirname, 'fixtures', 'modules');
const DEVICE_CODE = 'DEVICE-CODE-SECRET-123';

function rig({ leads = [{ name: 'owner', lead: true }] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-si-'));
  const cx = createConnectors({ file: path.join(dir, 'connectors.json'), keyFile: path.join(dir, '.auth-key'), log: () => {}, unlockTtlMs: 0 });
  const clock = { t: 1_000_000 };
  const calls = { start: [], poll: [] };
  const script = { poll: [{ status: 'pending' }] };
  const oauth = {
    async start(a) { calls.start.push(a); return { deviceCode: DEVICE_CODE, userCode: 'ABCD-EFGH', verificationUrl: 'https://auth.example.com/activate', intervalSec: 5, expiresAt: clock.t + 600000 }; },
    async poll(a) { calls.poll.push(a); const r = script.poll.shift() || { status: 'pending' }; if (r.throw) { const e = new Error(r.throw); e.code = 'EX'; throw e; } return r; },
  };
  const mods = createModules({
    root: FIX_ROOT, dataDir: path.join(dir, 'modules'), stateFile: path.join(dir, 'modules.json'), connectorsFile: path.join(dir, 'connectors.json'), connectors: cx,
    listAgents: () => [...leads, { name: 'helper' }], oauth, now: () => clock.t, log: () => {},
  });
  return { dir, cx, mods, clock, calls, script, cleanup: () => { cx.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const keys = (mods) => mods.runStep('fakesignin', 'keys', { values: { FAKE_CLIENT_ID: 'client-id-1', FAKE_CLIENT_SECRET: 'client-secret-1' } });
const step = (mods, id) => mods.detail('fakesignin').steps.find(s => s.id === id);

test('start without the client keys is refused; with them the reply never carries the device code', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.mods.runStep('fakesignin', 'install', {});
  await assert.rejects(r.mods.signinStart('fakesignin'), { message: 'Enter the client ID and secret first.' });
  assert.strictEqual(r.calls.start.length, 0);
  await keys(r.mods);
  const out = await r.mods.signinStart('fakesignin');
  assert.deepStrictEqual(Object.keys(out).sort(), ['expiresAt', 'intervalSec', 'userCode', 'verificationUrl']);
  assert.ok(!JSON.stringify(out).includes(DEVICE_CODE));
  assert.deepStrictEqual(r.calls.start[0], { deviceUrl: 'https://auth.example.com/device', clientId: 'client-id-1', scopes: ['mail.read'] });
});

test('poll: nothing pending is a 409; before nextPollAt the provider is not called; slow_down adds 5 seconds', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.mods.runStep('fakesignin', 'install', {}); await keys(r.mods);
  await assert.rejects(r.mods.signinPoll('fakesignin'), { message: 'Start the sign-in again.', status: 409 });
  await r.mods.signinStart('fakesignin');
  assert.deepStrictEqual(await r.mods.signinPoll('fakesignin'), { status: 'pending' });
  assert.strictEqual(r.calls.poll.length, 0, 'too early: the provider is not asked');
  r.clock.t += 5000;
  r.script.poll = [{ status: 'slow_down' }];
  assert.deepStrictEqual(await r.mods.signinPoll('fakesignin'), { status: 'pending' });
  assert.strictEqual(r.calls.poll.length, 1);
  assert.deepStrictEqual(r.calls.poll[0], { tokenUrl: 'https://auth.example.com/token', clientId: 'client-id-1', clientSecret: 'client-secret-1', deviceCode: DEVICE_CODE });
  r.clock.t += 5000; await r.mods.signinPoll('fakesignin');
  assert.strictEqual(r.calls.poll.length, 1, 'the interval is now 10 seconds');
  r.clock.t += 5000; await r.mods.signinPoll('fakesignin');
  assert.strictEqual(r.calls.poll.length, 2);
  r.clock.t += 700000;
  await assert.rejects(r.mods.signinPoll('fakesignin'), { status: 409 }, 'past expiresAt');
});

test('ok stores the refresh token as the module secret, marks the step done and clears the pending sign-in', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.mods.runStep('fakesignin', 'install', {}); await keys(r.mods);
  assert.strictEqual(step(r.mods, 'signin').done, false);
  await r.mods.signinStart('fakesignin');
  r.clock.t += 5000;
  r.script.poll = [{ status: 'ok', tokens: { refreshToken: 'refresh-xyz', accessToken: 'access-abc', expiresAt: 1, scope: 'mail.read' } }];
  const out = await r.mods.signinPoll('fakesignin');
  assert.deepStrictEqual(out, { status: 'ok' });
  assert.deepStrictEqual(r.cx.readSecrets('fakesignin', ['FAKE_REFRESH_TOKEN'], { byModule: true }), { FAKE_REFRESH_TOKEN: 'refresh-xyz' });
  assert.ok(step(r.mods, 'signin').done && step(r.mods, 'signin').doneAt);
  assert.ok(!JSON.stringify(r.mods.detail('fakesignin')).includes('refresh-xyz'));
  await assert.rejects(r.mods.signinPoll('fakesignin'), { status: 409 });
  await r.mods.runStep('fakesignin', 'signin', {});   // the step can be re-run once signed in
});

test('denied and expired clear the pending sign-in; a thrown error is a plain message', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.mods.runStep('fakesignin', 'install', {}); await keys(r.mods);
  for (const [status, message] of [['denied', 'The sign-in was declined.'], ['expired', 'The code expired. Start again.']]) {
    await r.mods.signinStart('fakesignin'); r.clock.t += 5000;
    r.script.poll = [{ status }];
    assert.deepStrictEqual(await r.mods.signinPoll('fakesignin'), { status, message });
    await assert.rejects(r.mods.signinPoll('fakesignin'), { status: 409 });
  }
  await r.mods.signinStart('fakesignin'); r.clock.t += 5000;
  r.script.poll = [{ throw: 'The provider is unreachable.' }];
  await assert.rejects(r.mods.signinPoll('fakesignin'), { message: 'The provider is unreachable.' });
});

test('readSecrets only serves the module itself, never a plain connector or a call without byModule', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.mods.runStep('fakesignin', 'install', {}); await keys(r.mods);
  assert.throws(() => r.cx.readSecrets('fakesignin', ['FAKE_CLIENT_ID']), /not readable/);
  r.cx.upsert({ id: 'plain', kind: 'mcp', command: 'x', secrets: { TOKEN: 'abc' } });
  assert.throws(() => r.cx.readSecrets('plain', ['TOKEN'], { byModule: true }), /not readable/);
});

test('help message: step and error and guide, each optional; no lead is a 409', async (t) => {
  const r = rig(); t.after(r.cleanup);
  assert.deepStrictEqual(r.mods.help('fakesignin', {}), { agent: 'owner', message: 'Help me with the Fake Mail data connector setup. Its setup guide is modules/fakesignin/guide.md.' });
  assert.strictEqual(r.mods.help('fakesignin', { step: 'signin' }).message, 'Help me with the Fake Mail data connector setup, step 3 of 5: "Sign in". Its setup guide is modules/fakesignin/guide.md.');
  assert.strictEqual(r.mods.help('fakesignin', { step: 'nope' }).message, r.mods.help('fakesignin', {}).message, 'an unknown step is left out');
  const long = `bad\n   thing ${'x'.repeat(600)}`;
  const m = r.mods.help('fakesignin', { step: 'keys', error: long }).message;
  assert.match(m, /step 2 of 5: "Client keys"\. The setup page showed: "bad thing x+"\. Its setup guide/);
  assert.ok(m.match(/"bad thing (x+)"/)[0].length <= 'bad thing '.length + 500 + 2);
  // no guide: fakebank has none
  assert.strictEqual(r.mods.help('fakebank', { step: 'verify', error: 'Boom' }).message, 'Help me with the Fake Bank data connector setup, step 5 of 8: "Check". The setup page showed: "Boom".');
  const none = rig({ leads: [] }); t.after(none.cleanup);
  assert.throws(() => none.mods.help('fakesignin', {}), { message: 'No lead agent.', status: 409 });
});
