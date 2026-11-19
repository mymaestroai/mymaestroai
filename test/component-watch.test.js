'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createComponentWatch, compareVersions } = require('../lib/component-watch');

const NOW = Date.parse('2026-11-19T12:00:00Z');
const ago = (h) => new Date(NOW - h * 3600 * 1000).toISOString();
const tmpState = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-')), 'component-watch.json');

function npmDoc(map) { return { time: { created: ago(9999), modified: ago(1), ...map } }; }
const CODEX_URL = 'https://registry.npmjs.org/@openai%2fcodex';
const CLAUDE_URL = 'https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk';
const SWAP_URL = 'https://api.github.com/repos/mostlygeek/llama-swap/releases/latest';
const CPP_URL = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest';

function make(over = {}) {
  const calls = { fetched: [], updates: [], timers: [], discovers: 0 };
  const docs = over.docs || {
    [CODEX_URL]: npmDoc({ '0.156.1': ago(500), '0.166.0': ago(30), '0.170.0': ago(3), '0.171.0-beta.1': ago(1) }),
    [CLAUDE_URL]: npmDoc({ '1.0.0': ago(500) }),
  };
  let models = over.models || [{ id: 'gpt-a' }];
  const deps = {
    stateFile: over.stateFile || tmpState(),
    now: () => NOW,
    fetchJson: async (url) => { calls.fetched.push(url); const v = docs[url]; if (v instanceof Error) throw v; return v === undefined ? null : v; },
    setting: () => over.setting || { codex: 'auto' },
    codexInstalled: () => (over.installed === undefined ? '0.156.1' : over.installed),
    codexInUse: () => !!over.inUse,
    updateCodex: async (o) => {
      calls.updates.push(o);
      if (over.afterUpdate) models = over.afterUpdate;
      return over.updateResult || { ok: true, from: '0.156.1', to: '0.166.0', rolledBack: false };
    },
    discover: async () => { calls.discovers++; },
    codexModels: () => models,
    claudeInstalled: () => (over.claude === undefined ? '1.0.0' : over.claude),
    claudeOffered: () => over.offered || null,
    localStatus: async () => over.local || null,
    setTimer: (fn, ms) => { const t = { fn, ms, unref() {} }; calls.timers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; },
    log: () => {},
  };
  if (over.fetchJson) deps.fetchJson = over.fetchJson;
  return { w: createComponentWatch(deps), calls, deps };
}
const byId = (items, id) => items.find(i => i.id === id);

test('compareVersions', () => {
  assert.ok(compareVersions('0.170.0', '0.166.0') > 0);
  assert.ok(compareVersions('0.166.0', '0.156.1') > 0);
  assert.ok(compareVersions('0.156.1', '0.170.0') < 0);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0);
  assert.ok(compareVersions('b6200', 'b6123') > 0);
  assert.ok(compareVersions('b6123', 'b6200') < 0);
  assert.ok(compareVersions('v200', 'v123') > 0);
});

test('latest vs cooled: a 3-hour-old release is not cooled, a prerelease is ignored; auto updates the cooled one', async () => {
  const { w, calls } = make();
  const items = await w.check();
  const c = byId(items, 'codex');
  assert.equal(c.latest, '0.170.0');
  assert.equal(c.behind, true);
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.updates[0].before.getTime(), NOW - 24 * 3600 * 1000);
  assert.equal(c.action, 'auto');
  assert.equal(c.how, 'Your Maestro updates it by itself once a release is a day old and Codex is idle.');
});

test('auto update records the unlocks from the models diff', async () => {
  const { w, calls } = make({ afterUpdate: [{ id: 'gpt-a' }, { id: 'gpt-b' }] });
  const items = await w.check();
  assert.equal(calls.discovers, 1);
  const lu = byId(items, 'codex').lastUpdate;
  assert.equal(lu.ok, true);
  assert.equal(lu.from, '0.156.1');
  assert.equal(lu.to, '0.166.0');
  assert.deepEqual(lu.unlocks, ['gpt-b']);
  assert.equal(lu.at, NOW);
});

test('a failed update is recorded and not tried again for the same release', async () => {
  const { w, calls } = make({ updateResult: { ok: false, from: '0.156.1', to: '0.166.0', rolledBack: true, error: 'The new Codex 0.166.0 failed its check, so 0.156.1 was put back.' } });
  const items = await w.check();
  const lu = byId(items, 'codex').lastUpdate;
  assert.equal(lu.ok, false);
  assert.equal(lu.rolledBack, true);
  assert.deepEqual(lu.unlocks, []);
  await w.check();
  assert.equal(calls.updates.length, 1);
});

test('in use: waiting, one retry scheduled an hour out, and no update', async () => {
  const { w, calls } = make({ inUse: true });
  const items = await w.check();
  assert.equal(byId(items, 'codex').waiting, 'Codex is in use');
  assert.equal(calls.updates.length, 0);
  assert.equal(calls.timers.length, 1);
  assert.equal(calls.timers[0].ms, 3600 * 1000);
  await w.check();
  assert.equal(calls.timers.length, 1);   // the pending retry is not doubled
});

test('retries stop after six in a row', async () => {
  const { w, calls } = make({ inUse: true });
  await w.check();
  for (let i = 0; i < 8; i++) { const t = calls.timers[calls.timers.length - 1]; await t.fn(); await new Promise(r => setImmediate(r)); }
  assert.equal(calls.timers.length, 6);
});

test('notify never updates; off leaves Codex out', async () => {
  const n = make({ setting: { codex: 'notify' } });
  const items = await n.w.check();
  assert.equal(n.calls.updates.length, 0);
  const c = byId(items, 'codex');
  assert.equal(c.action, 'notify');
  assert.equal(c.behind, true);
  assert.equal(c.how, 'Update it in Settings → Status (Update Codex now).');
  const o = make({ setting: { codex: 'off' } });
  const items2 = await o.w.check();
  assert.equal(byId(items2, 'codex'), undefined);
  assert.equal(o.calls.updates.length, 0);
  assert.equal(o.calls.fetched.includes(CODEX_URL), false);
});

test('allowUpdate false only records', async () => {
  const { w, calls } = make();
  const items = await w.check({ allowUpdate: false });
  assert.equal(calls.updates.length, 0);
  assert.equal(byId(items, 'codex').latest, '0.170.0');
});

test('a failed fetch keeps the last known latest', async () => {
  const f = { fail: false };
  const docs = { [CODEX_URL]: npmDoc({ '0.156.1': ago(500), '0.170.0': ago(3) }), [CLAUDE_URL]: npmDoc({ '1.0.0': ago(500) }) };
  const { w } = make({ setting: { codex: 'notify' }, fetchJson: async (u) => (f.fail ? null : docs[u]) });
  assert.equal(byId(await w.check(), 'codex').latest, '0.170.0');
  f.fail = true;
  const c = byId(await w.check(), 'codex');
  assert.equal(c.latest, '0.170.0');
  assert.equal(c.behind, true);
});

test('a fetch that throws does not break the check', async () => {
  const { w } = make({ setting: { codex: 'notify' }, fetchJson: async () => { throw new Error('offline'); } });
  const items = await w.check();
  assert.equal(byId(items, 'codex').latest, null);
});

test('bad version strings from the network are dropped', async () => {
  const docs = {
    [CODEX_URL]: npmDoc({ '0.156.1': ago(500), '9.9.9<script>': ago(500), '0.160.0': ago(500) }),
    [CLAUDE_URL]: npmDoc({ '1.0.0': ago(500) }),
    [SWAP_URL]: { tag_name: 'v1; rm -rf /' },
  };
  const { w } = make({ docs, setting: { codex: 'notify' }, local: { detect: { llamaSwap: { path: '/x/llama-swap', version: 'v100', pinned: 'v100' }, llamaServer: { path: null } } } });
  const items = await w.check();
  assert.equal(byId(items, 'codex').latest, '0.160.0');
  assert.equal(byId(items, 'llama-swap').latest, null);
  assert.equal(JSON.stringify(items).includes('rm -rf'), false);
});

test('claude: how text with and without an offered newer client', async () => {
  const docs = { [CODEX_URL]: npmDoc({ '0.156.1': ago(500) }), [CLAUDE_URL]: npmDoc({ '1.0.0': ago(500), '1.2.0': ago(500) }) };
  const a = make({ docs });
  const ia = byId(await a.w.check(), 'claude');
  assert.equal(ia.name, 'Claude client');
  assert.equal(ia.latest, '1.2.0');
  assert.equal(ia.behind, true);
  assert.equal(ia.how, 'It arrives with My Maestro updates; the current update does not include it yet.');
  const b = make({ docs, offered: '1.2.0' });
  assert.equal(byId(await b.w.check(), 'claude').how, 'The pending My Maestro update brings Claude client 1.2.0: install it with Update in Settings → Status.');
  const c = make({ docs, offered: '1.0.0' });
  assert.match(byId(await c.w.check(), 'claude').how, /^It arrives/);
});

test('llama-swap and llama.cpp items only when installed', async () => {
  const none = make({ local: { detect: { llamaSwap: { path: null }, llamaServer: { path: '/usr/bin/llama-server', source: 'detected' } } } });
  const i0 = await none.w.check();
  assert.equal(byId(i0, 'llama-swap'), undefined);
  assert.equal(byId(i0, 'llama.cpp'), undefined);
  assert.equal(none.calls.fetched.includes(SWAP_URL), false);
  assert.equal(none.calls.fetched.includes(CPP_URL), false);

  const docs = {
    [CODEX_URL]: npmDoc({ '0.156.1': ago(500) }), [CLAUDE_URL]: npmDoc({ '1.0.0': ago(500) }),
    [SWAP_URL]: { tag_name: 'v200' }, [CPP_URL]: { tag_name: 'b6200' },
  };
  const both = make({ docs, local: { llamaSwap: { path: '/x/llama-swap', version: 'v123', pinned: 'v123' }, llamaServer: { path: '/x/llama-server', source: 'hub build', version: 'b6123' } } });
  const i1 = await both.w.check();
  const s = byId(i1, 'llama-swap');
  assert.equal(s.latest, 'v200');
  assert.equal(s.behind, true);
  assert.equal(s.how, 'My Maestro pins llama-swap v123 (checked by its sha256) and moves to newer releases in its own updates.');
  const l = byId(i1, 'llama.cpp');
  assert.equal(l.name, "llama.cpp (the hub's build)");
  assert.equal(l.latest, 'b6200');
  assert.equal(l.behind, true);
  assert.match(l.how, /^Rebuild data\/local-models\/llama\.cpp/);
});

test('one check at a time: a second call gets the same promise', async () => {
  const { w, calls } = make({ setting: { codex: 'notify' } });
  const p1 = w.check();
  const p2 = w.check();
  assert.equal(p1, p2);
  await p1;
  const n = calls.fetched.length;
  await w.check();
  assert.ok(calls.fetched.length > n);
});

test('updateCodexNow refuses off and an in-use Codex, and works in notify', async () => {
  const off = make({ setting: { codex: 'off' } });
  const r0 = await off.w.updateCodexNow();
  assert.equal(r0.ok, false);
  assert.equal(typeof r0.error, 'string');
  assert.equal(off.calls.updates.length, 0);

  const busy = make({ inUse: true, setting: { codex: 'notify' } });
  const r1 = await busy.w.updateCodexNow();
  assert.equal(r1.ok, false);
  assert.match(r1.error, /in use/);
  assert.equal(busy.calls.updates.length, 0);

  const ok = make({ setting: { codex: 'notify' } });
  const r2 = await ok.w.updateCodexNow();
  assert.equal(r2.ok, true);
  assert.equal(ok.calls.updates.length, 1);

  const none = make({ installed: null });
  assert.equal((await none.w.updateCodexNow()).ok, false);

  const current = make({ installed: '0.170.0', setting: { codex: 'notify' } });
  const r3 = await current.w.updateCodexNow();
  assert.equal(r3.ok, false);
  assert.equal(current.calls.updates.length, 0);
});

test('state is saved (mode 600), kept across instances, and an unreadable file is kept as .bad', async () => {
  const stateFile = tmpState();
  const a = make({ stateFile, setting: { codex: 'notify' } });
  await a.w.check();
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  const b = make({ stateFile, setting: { codex: 'notify' } });
  assert.equal(byId(b.w.items(), 'codex').latest, '0.170.0');   // from the file, before any check

  fs.writeFileSync(stateFile, '{ not json');
  const c = make({ stateFile, setting: { codex: 'notify' } });
  assert.deepEqual(c.w.items(), []);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), '{ not json');   // not overwritten yet
  await c.w.check();
  assert.equal(fs.readFileSync(`${stateFile}.bad`, 'utf8'), '{ not json');
  assert.equal(byId(c.w.items(), 'codex').latest, '0.170.0');
});

test('start schedules the first check at 10 minutes then every 24 hours; stop clears', async () => {
  const { w, calls } = make({ setting: { codex: 'notify' } });
  w.start();
  assert.equal(calls.timers.length, 1);
  assert.equal(calls.timers[0].ms, 10 * 60 * 1000);
  calls.timers[0].fn();
  await new Promise(r => setImmediate(r));
  assert.equal(calls.timers[1].ms, 24 * 3600 * 1000);
  w.stop();
  assert.equal(calls.timers[1].cleared, true);
});

test('lead: an asynchronous Claude client lookup reaches the item; llama.cpp is shown only for the hub build', async () => {
  const os = require('os');
  const { createComponentWatch } = require('../lib/component-watch');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-'));
  const now = Date.parse('2026-11-19T12:00:00Z');
  const doc = { time: { '0.3.322': '2026-10-01T00:00:00Z', '0.3.330': '2026-11-10T00:00:00Z' } };
  const w = createComponentWatch({
    stateFile: path.join(dir, 'cw.json'), now: () => now, fetchJson: async () => doc,
    setting: () => ({ codex: 'off' }), codexInstalled: () => null,
    claudeInstalled: () => '0.3.322', claudeOffered: () => Promise.resolve('0.3.330'),
    localStatus: async () => ({ detect: { llamaSwap: { path: null }, llamaServer: { path: '/x/llama-server', source: 'PATH', version: 'b1' } } }),
  });
  const items = await w.check({ reason: 'test' });
  const c = items.find((i) => i.id === 'claude');
  assert.match(c.how, /brings Claude client 0\.3\.330/);
  assert.equal(items.some((i) => i.id === 'llama.cpp'), false, 'a llama-server from PATH is not the hub build');
  fs.rmSync(dir, { recursive: true, force: true });
});
