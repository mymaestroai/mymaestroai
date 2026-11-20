'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { handle } = require('../lib/system-health/routes');
const { validateSettings } = require('../lib/system-health');

function fake({ running = false, enabled = true } = {}) {
  const calls = { run: [], saved: [] };
  const cur = { ...validateSettings({}).value, enabled };
  const health = {
    view: () => ({ settings: cur, running, items: [], critical: 0, warnings: 0, lastRun: null }),
    isRunning: () => running, settings: () => cur,
    run: async (a) => { calls.run.push(a); },
  };
  return { calls, args: { health: () => health, validateSettings, saveSettings: (v) => { calls.saved.push(v); Object.assign(cur, v); }, admin: true } };
}
const flush = () => new Promise(r => setImmediate(r));

test('GET /api/system-health returns the view', async () => {
  const f = fake();
  const r = await handle({ ...f.args, method: 'GET', pathname: '/api/system-health' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.running, false);
  assert.deepStrictEqual(Object.keys(r.body).sort(), ['critical', 'items', 'lastRun', 'running', 'settings', 'warnings']);
  assert.strictEqual((await handle({ ...f.args, method: 'GET', pathname: '/api/system-health/' })).status, 200, 'trailing slash');
});

test('POST /api/system-health/run: 202 and a manual run; 409 running; 409 disabled', async () => {
  const f = fake();
  const r = await handle({ ...f.args, method: 'POST', pathname: '/api/system-health/run' });
  assert.deepStrictEqual(r, { status: 202, body: { started: true } });
  await flush();
  assert.deepStrictEqual(f.calls.run, [{ trigger: 'manual' }]);
  const busy = fake({ running: true });
  assert.deepStrictEqual(await handle({ ...busy.args, method: 'POST', pathname: '/api/system-health/run' }), { status: 409, body: { error: 'running' } });
  const off = fake({ enabled: false });
  assert.deepStrictEqual(await handle({ ...off.args, method: 'POST', pathname: '/api/system-health/run' }), { status: 409, body: { error: 'disabled' } });
  await flush();
  assert.deepStrictEqual([busy.calls.run, off.calls.run], [[], []]);
});

test('a run that fails after the 202 is logged, not thrown', async () => {
  const f = fake(); const logs = [];
  f.args.health = () => ({ ...fake().args.health(), isRunning: () => false, settings: () => ({ enabled: true }), run: async () => { throw new Error('nope'); } });
  const r = await handle({ ...f.args, method: 'POST', pathname: '/api/system-health/run', log: (m) => logs.push(m) });
  assert.strictEqual(r.status, 202);
  await flush();
  assert.deepStrictEqual(logs, ['[health] manual run failed: nope']);
});

test('PUT /api/system-health/settings: a partial object on top of what is saved; bad values 400 and nothing saved', async () => {
  const f = fake();
  const r = await handle({ ...f.args, method: 'PUT', pathname: '/api/system-health/settings', body: { checkAt: '04:30', notify: 'warnings' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.settings.checkAt, '04:30');
  assert.strictEqual(r.body.settings.diskWarnPct, 15, 'the rest is kept');
  assert.strictEqual(f.calls.saved.length, 1);
  for (const body of [{ checkAt: 'noon' }, { bogus: 1 }, { diskCritPct: 99 }, { notify: 'loud' }]) {
    const bad = await handle({ ...f.args, method: 'PUT', pathname: '/api/system-health/settings', body });
    assert.strictEqual(bad.status, 400); assert.ok(bad.body.error);
  }
  for (const body of [null, [], 'x']) assert.deepStrictEqual(await handle({ ...f.args, method: 'PUT', pathname: '/api/system-health/settings', body }), { status: 400, body: { error: 'invalid JSON' } });
  assert.strictEqual(f.calls.saved.length, 1);
});

test('members get 403 admin_only on all three routes; the module is not even asked', async () => {
  let asked = 0;
  for (const admin of [false, undefined, 'yes', null]) {
    for (const [method, pathname] of [['GET', '/api/system-health'], ['POST', '/api/system-health/run'], ['PUT', '/api/system-health/settings']]) {
      const r = await handle({ method, pathname, admin, body: {}, health: () => { asked++; return {}; }, validateSettings, saveSettings: () => { asked++; } });
      assert.deepStrictEqual(r, { status: 403, body: { error: 'admin_only' } });
    }
  }
  assert.strictEqual(asked, 0);
});

test('other paths and methods are not ours (null)', async () => {
  const f = fake();
  assert.strictEqual(await handle({ ...f.args, method: 'GET', pathname: '/api/selfcheck' }), null);
  assert.strictEqual(await handle({ ...f.args, method: 'DELETE', pathname: '/api/system-health' }), null);
  assert.strictEqual(await handle({ ...f.args, method: 'GET', pathname: '/api/system-health/run' }), null);
  assert.strictEqual(await handle({ ...f.args, method: 'POST', pathname: '/api/system-health/settings' }), null);
});

test('a module that throws gives 500 with plain words and a log line', async () => {
  const logs = [];
  const r = await handle({ method: 'GET', pathname: '/api/system-health', admin: true, health: () => { throw new Error('x'); }, validateSettings, saveSettings() {}, log: (m) => logs.push(m) });
  assert.strictEqual(r.status, 500);
  assert.strictEqual(logs.length, 1);
});
