'use strict';
// Nightly module health check (lib/modules/health) with fake modules, a fake push and a fake clock.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createModulesHealth } = require('../lib/modules/health');

const T = (iso) => Date.parse(iso);

function rig({ start = '2026-03-10T12:00:00Z' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-hl-'));
  const clock = { t: T(start) };
  const world = {
    list: [{ id: 'mail', name: 'Fake Mail', state: 'ready', health: true }, { id: 'plain', name: 'Plain', state: 'ready', health: false }, { id: 'off', name: 'Off', state: 'off', health: true }],
    result: { mail: { ok: true, summary: 'fine' } }, ran: [], notices: [], pushReply: { sent: 1, failed: 0 },
  };
  const modules = {
    list: () => world.list,
    detail: (id) => ({ manifest: { health: { check: 'ping' } }, id }),
    async check(id, name) {
      world.ran.push([id, name]);
      const r = world.result[id];
      if (r && r.throw) throw new Error(r.throw);
      if (world.list.find(x => x.id === id).health) world.list.find(x => x.id === id).state = r.ok ? 'ready' : 'attention';   // as statusOf does
      return r;
    },
  };
  const push = { async notify(p, o) { world.notices.push({ p, o }); return world.pushReply; } };
  const file = path.join(dir, 'modules-health.json');
  const h = createModulesHealth({ modules, push, clock: () => clock.t, file, hubZone: () => 'UTC', log: () => {} });
  return { h, clock, world, file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('due: first look, the night window once a day, 48 hours stale, and never mid-day', async (t) => {
  const r = rig(); t.after(r.cleanup);
  assert.strictEqual(r.h.isDue(), true, 'never checked');
  await r.h.run();
  assert.strictEqual(r.h.isDue(), false);
  r.clock.t = T('2026-03-11T01:00:00Z'); assert.strictEqual(r.h.isDue(), false, 'before the night window');
  r.clock.t = T('2026-03-11T03:00:00Z'); assert.strictEqual(r.h.isDue(), true, 'night, no look yet today');
  await r.h.run();
  r.clock.t = T('2026-03-11T04:00:00Z'); assert.strictEqual(r.h.isDue(), false, 'already looked today');
  r.clock.t = T('2026-03-11T15:00:00Z'); assert.strictEqual(r.h.isDue(), false);
  r.clock.t = T('2026-03-13T15:00:00Z'); assert.strictEqual(r.h.isDue(), true, '48 hours stale at any hour');
  assert.strictEqual((fs.statSync(r.file).mode & 0o777), 0o600);
});

test('only ready modules that declare a check are run, one at a time, with the declared check name', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.h.run();
  assert.deepStrictEqual(r.world.ran, [['mail', 'ping']]);
  assert.strictEqual(r.world.notices.length, 0);
});

test('one notice per pass-to-fail change; kept quiet while it stays failing; cleared after recovery, then a new failure notifies again', async (t) => {
  const r = rig(); t.after(r.cleanup);
  r.world.result.mail = { ok: false, summary: 'x'.repeat(300) };
  await r.h.run();
  assert.strictEqual(r.world.notices.length, 1);
  const { p, o } = r.world.notices[0];
  assert.strictEqual(p.title, 'Fake Mail needs attention');
  assert.strictEqual(p.body.length, 160);
  assert.strictEqual(p.url, '/modules#mail'); assert.strictEqual(p.tag, 'module-health-mail');
  assert.deepStrictEqual(o, { adminsOnly: true });
  await r.h.run();   // the module is now "attention" but was seen failing, so it is still looked at
  assert.strictEqual(r.world.ran.length, 2);
  assert.strictEqual(r.world.notices.length, 1, 'still failing: no second notice');
  r.world.result.mail = { ok: true, summary: 'fine' };
  await r.h.run();
  assert.deepStrictEqual(r.h.state().notified, []);
  r.world.result.mail = { ok: false, summary: 'down again' };
  await r.h.run();
  assert.strictEqual(r.world.notices.length, 2);
});

test('a notice that reached no device is retried on the next tick; a push error too', async (t) => {
  const r = rig(); t.after(r.cleanup);
  r.world.result.mail = { ok: false, summary: 'down' };
  r.world.pushReply = { sent: 0, failed: 2 };
  await r.h.run();
  assert.deepStrictEqual(r.h.state().notified, []);
  assert.strictEqual(r.h.isDue(), true, 'due again at once, not only at night');
  r.world.pushReply = { error: 'push service down' };
  await r.h.run();
  assert.strictEqual(r.world.notices.length, 2);
  r.world.pushReply = { sent: 0, failed: 0 };   // no device registered: counts as delivered
  await r.h.run();
  assert.strictEqual(r.world.notices.length, 3);
  assert.deepStrictEqual(r.h.state().notified, ['mail']);
  assert.strictEqual(r.h.isDue(), false);
});

test('a thrown check counts as failing, with its message', async (t) => {
  const r = rig(); t.after(r.cleanup);
  r.world.result.mail = { throw: 'The server did not start.' };
  await r.h.run();
  assert.strictEqual(r.world.notices.length, 1);
  assert.strictEqual(r.world.notices[0].p.body, 'The server did not start.');
  assert.strictEqual(r.h.state().results.mail.ok, false);
});
