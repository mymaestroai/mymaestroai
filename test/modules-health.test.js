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
    detail: (id) => ({ manifest: { health: { check: 'ping' } }, id, enabled: world.list.find(x => x.id === id).enabled !== false }),
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

test('an attention module is checked whoever recorded the failure (no earlier result needed)', async (t) => {
  const r = rig(); t.after(r.cleanup);
  r.world.list.find(x => x.id === 'mail').state = 'attention';   // e.g. the setup page's own check failed
  r.world.result.mail = { ok: true, summary: 'fine' };
  await r.h.run();
  assert.deepStrictEqual(r.world.ran, [['mail', 'ping']]);
  assert.strictEqual(r.h.state().results.mail.ok, true);
  // a module that is still being set up or broken is not checked
  r.world.list.push({ id: 'half', name: 'Half', state: 'setup', health: true }, { id: 'bad', name: 'Bad', state: 'broken', health: true });
  r.world.ran.length = 0;
  await r.h.run();
  assert.deepStrictEqual(r.world.ran.map(x => x[0]), ['mail']);
});

test('results and notice markers of modules no longer checked are dropped, so the check is not due for them', async (t) => {
  const r = rig(); t.after(r.cleanup);
  r.world.result.mail = { ok: false, summary: 'down' };
  r.world.pushReply = { sent: 0, failed: 1 };   // not delivered: the marker is missing and the check is due
  await r.h.run();
  assert.strictEqual(r.h.isDue(), true);
  // the module is switched off (or removed, or broken): its failed result must not keep the check due
  for (const state of ['off', 'broken', null]) {
    const rr = rig(); t.after(rr.cleanup);
    rr.world.result.mail = { ok: false, summary: 'down' };
    rr.world.pushReply = { sent: 0, failed: 1 };
    await rr.h.run();
    assert.strictEqual(rr.h.isDue(), true);
    if (state === null) rr.world.list = rr.world.list.filter(x => x.id !== 'mail'); else rr.world.list.find(x => x.id === 'mail').state = state;
    await rr.h.run();
    const s = rr.h.state();
    assert.deepStrictEqual(s.results, {}, `${state}: result dropped`);
    assert.deepStrictEqual(s.notified, [], `${state}: marker dropped`);
    assert.strictEqual(rr.h.isDue(), false, `${state}: not due any more`);
  }
  // a delivered notice's marker goes too, and a module that comes back is treated as new
  const r3 = rig(); t.after(r3.cleanup);
  r3.world.result.mail = { ok: false, summary: 'down' };
  await r3.h.run();
  assert.deepStrictEqual(r3.h.state().notified, ['mail']);
  r3.world.list.find(x => x.id === 'mail').state = 'off';
  await r3.h.run();
  assert.deepStrictEqual(r3.h.state().notified, []);
  r3.world.list.find(x => x.id === 'mail').state = 'ready';
  await r3.h.run();
  assert.strictEqual(r3.world.notices.length, 2, 'a new failure after coming back notifies again');
});

test('a module list that cannot be read leaves the recorded results alone', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.h.run();
  const h2 = createModulesHealth({ modules: { list: () => { throw new Error('unreadable'); } }, push: { notify: async () => ({ sent: 1, failed: 0 }) }, clock: () => r.clock.t, file: r.file, hubZone: () => 'UTC', log: () => {} });
  await h2.run();
  assert.strictEqual(h2.state().results.mail.ok, true);
});

test('a module that is switched off is not checked even when its status is attention; no result, no notice', async (t) => {
  const r = rig(); t.after(r.cleanup);
  const mail = r.world.list.find(x => x.id === 'mail');
  mail.state = 'attention'; mail.enabled = false;
  r.world.result.mail = { ok: false, summary: 'down' };
  await r.h.run();
  assert.deepStrictEqual(r.world.ran, []);
  assert.deepStrictEqual(r.world.notices, []);
  assert.deepStrictEqual(r.h.state().results, {});
  mail.enabled = true;   // switched on again: looked at
  await r.h.run();
  assert.deepStrictEqual(r.world.ran, [['mail', 'ping']]);
});
