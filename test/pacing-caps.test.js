'use strict';
// Workers at once per AI service: the admin setting (workersAtOnce), resolveCaps, live setCaps, the
// 1, 2, 4, 8, 16, 32 climb after a slow-down, status/capsView, and the wiring in server.js / sdk-chat.js.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createPacing, resolveCaps, cleanWorkersAtOnce, capsView, DEFAULT_CAPS, RAMP_STEPS } = require('../lib/provider-pacing');

const tick = () => new Promise(r => setImmediate(r));
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('resolveCaps: defaults, valid overrides, and every invalid value falls back', () => {
  assert.deepStrictEqual(resolveCaps(), DEFAULT_CAPS);
  assert.notStrictEqual(resolveCaps(), DEFAULT_CAPS, 'a new object each time');
  assert.strictEqual(resolveCaps()['claude-sdk'], 6);
  const c = resolveCaps({ 'claude-sdk': 10, openai: 1, 'my-local': 3, perplexity: 32 });
  assert.deepStrictEqual([c['claude-sdk'], c.openai, c['my-local'], c.perplexity], [10, 1, 3, 32]);
  for (const bad of [0, 33, 1.5, '4', null, -2, NaN, Infinity, true, [], {}, undefined]) {
    assert.strictEqual(resolveCaps({ openai: bad }).openai, DEFAULT_CAPS.openai, `bad value ${JSON.stringify(bad)}`);
  }
  const j = resolveCaps({ 'Bad Key!': 3, '9x': 3, '': 3, ['a'.repeat(40)]: 3 });
  assert.deepStrictEqual(j, DEFAULT_CAPS, 'junk keys are ignored');
  for (const notObject of [null, 'x', 5, [], [3]]) assert.deepStrictEqual(resolveCaps(notObject), DEFAULT_CAPS);
});

test('cleanWorkersAtOnce drops invalid entries; an empty object is fine', () => {
  assert.deepStrictEqual(cleanWorkersAtOnce({}), {});
  assert.deepStrictEqual(cleanWorkersAtOnce(null), {});
  assert.deepStrictEqual(cleanWorkersAtOnce([1, 2]), {});
  assert.deepStrictEqual(cleanWorkersAtOnce({ openai: 8, google: 0, codex: 33, anthropic: '4', ollama: 1.5, 'Junk Key': 3, lmstudio: 2 }), { openai: 8, lmstudio: 2 });
});

test('createPacing accepts initial overrides through caps, and new providers use them', async () => {
  const p = createPacing({ caps: { fake: 5, openai: 99 }, log: () => {} });
  assert.strictEqual(p.capFor('fake'), 5);
  assert.strictEqual(p.capFor('openai'), DEFAULT_CAPS.openai, 'invalid initial value falls back');
  assert.strictEqual(p.capFor('claude-sdk'), 6);
  assert.strictEqual(createPacing({ log: () => {} }).capFor('claude-sdk'), 6);
});

test('setCaps raising lets waiting work start at once', async () => {
  const p = createPacing({ caps: { fake: 1 }, log: () => {} });
  const gates = [], started = [];
  const job = (i) => p.run('fake', () => { started.push(i); return new Promise(r => gates.push(r)); });
  const runs = [job(1), job(2), job(3)];
  await tick();
  assert.deepStrictEqual(started, [1]);
  assert.strictEqual(p.status().providers.fake.queued, 2);
  p.setCaps({ fake: 3 });
  await tick();
  assert.deepStrictEqual(started, [1, 2, 3]);
  assert.strictEqual(p.status().providers.fake.cap, 3);
  assert.strictEqual(p.status().providers.fake.limit, 3);
  gates.forEach(g => g('ok'));
  await Promise.all(runs);
});

test('setCaps lowering never interrupts running work and blocks new starts until fewer run', async () => {
  const p = createPacing({ caps: { fake: 3 }, log: () => {} });
  const gates = [], started = [];
  const job = (i) => p.run('fake', () => { started.push(i); return new Promise(r => gates[i] = r); });
  const runs = [job(1), job(2), job(3)];
  await tick();
  assert.deepStrictEqual(started, [1, 2, 3]);
  p.setCaps({ fake: 1 });
  assert.strictEqual(p.status().providers.fake.limit, 1);
  assert.strictEqual(p.status().providers.fake.active, 3, 'running work is untouched');
  runs.push(job(4));
  await tick();
  assert.deepStrictEqual(started, [1, 2, 3], '4 waits');
  gates[1]('ok'); await tick();
  assert.deepStrictEqual(started, [1, 2, 3], 'still 2 running, limit 1');
  gates[2]('ok'); await tick();
  assert.deepStrictEqual(started, [1, 2, 3], 'still 1 running, limit 1');
  gates[3]('ok'); await tick();
  assert.deepStrictEqual(started, [1, 2, 3, 4], 'starts once nothing runs');
  gates[4]('ok');
  await Promise.all(runs);
});

test('setCaps on a paced provider only ever lowers its limit; providers made later use the new caps', async () => {
  const p = createPacing({ caps: { fake: 8 }, cooldownMs: 0, retryDelaysMs: [], log: () => {} });
  await assert.rejects(p.run('fake', async () => { throw new Error('429'); }, { retry: false }));
  assert.strictEqual(p.status().providers.fake.limit, 1);
  p.setCaps({ fake: 12 });
  assert.strictEqual(p.status().providers.fake.limit, 1, 'serial stays serial');
  assert.strictEqual(p.status().providers.fake.cap, 12);
  p.setCaps({ other: 7 });
  assert.strictEqual(p.status().providers.fake.cap, 2, 'fake back to default (not in the new overrides)');
  assert.strictEqual(p.capFor('other'), 7);
  await p.run('other', async () => 'ok');
  assert.strictEqual(p.status().providers.other.cap, 7);
});

test('setCaps lowering the cap to the paced limit ends the slow-down (after the cooldown) and says so', async () => {
  const events = [];
  let t = 1_000_000;
  const p = createPacing({ caps: { fake: 8 }, now: () => t, cooldownMs: 1000, retryDelaysMs: [], log: () => {}, onEvent: (e) => events.push(e) });
  await assert.rejects(p.run('fake', async () => { throw new Error('429'); }, { retry: false }));
  assert.strictEqual(p.status().providers.fake.limit, 1);
  p.setCaps({ fake: 1 });
  assert.notStrictEqual(p.status().providers.fake.mode, 'normal', 'still cooling down');
  t += 5000;
  p.setCaps({ fake: 1 });
  const f = p.status().providers.fake;
  assert.strictEqual(f.mode, 'normal');
  assert.strictEqual(f.reason, null);
  assert.ok(events.some(e => e.type === 'provider_recovered' && e.provider === 'fake'));
});

async function climb(cap) {
  let t = 1_000_000;
  const p = createPacing({ caps: { fake: cap }, now: () => t, sleep: async () => {}, cooldownMs: 0, retryDelaysMs: [], rampSuccesses: 2, log: () => {} });
  await assert.rejects(p.run('fake', async () => { throw new Error('429'); }, { retry: false }));
  const limits = [p.status().providers.fake.limit];
  for (let i = 0; i < 40 && p.status().providers.fake.mode !== 'normal'; i++) {
    t += 1;
    await p.run('fake', async () => 'ok');
    const l = p.status().providers.fake.limit;
    if (l !== limits[limits.length - 1]) limits.push(l);
  }
  assert.strictEqual(p.status().providers.fake.mode, 'normal');
  return limits;
}

test('the climb after a slow-down is 1, 2, 4, 8 ... never above the cap', async () => {
  assert.deepStrictEqual(RAMP_STEPS, [1, 2, 4, 8, 16, 32]);
  assert.deepStrictEqual(await climb(12), [1, 2, 4, 8, 12]);
  assert.deepStrictEqual(await climb(32), [1, 2, 4, 8, 16, 32]);
  assert.deepStrictEqual(await climb(4), [1, 2, 4]);
  assert.deepStrictEqual(await climb(2), [1, 2]);
  assert.deepStrictEqual(await climb(16), [1, 2, 4, 8, 16]);
});

test('status() shows cap and defaultCap per provider', async () => {
  const p = createPacing({ caps: { openai: 9, mystery: 5 }, log: () => {} });
  await p.run('openai', async () => 'ok'); await p.run('mystery', async () => 'ok'); await p.run('claude-sdk', async () => 'ok');
  const s = p.status().providers;
  assert.deepStrictEqual([s.openai.cap, s.openai.defaultCap], [9, 4]);
  assert.deepStrictEqual([s.mystery.cap, s.mystery.defaultCap], [5, 2], 'unknown service: default cap is the generic default');
  assert.deepStrictEqual([s['claude-sdk'].cap, s['claude-sdk'].defaultCap], [6, 6]);
});

test('capsView lists cap and defaultCap for each provider key, in the order given', () => {
  assert.deepStrictEqual(capsView({ openai: 8, google: 0 }, ['claude-sdk', 'codex-cli', 'openai', 'google', 'weird']), [
    { provider: 'claude-sdk', cap: 6, defaultCap: 6 },
    { provider: 'codex-cli', cap: 2, defaultCap: 2 },
    { provider: 'openai', cap: 8, defaultCap: 4 },
    { provider: 'google', cap: 4, defaultCap: 4 },
    { provider: 'weird', cap: 2, defaultCap: 2 },
  ]);
  assert.deepStrictEqual(capsView(undefined, []), []);
});

test('Settings page: admin-only Workers at once block in the Agents group, saved through POST /api/settings', () => {
  const app = read('app.js');
  assert.match(app, /sections: \['st-defaults-section', 'st-workers-section'/);
  assert.match(app, /if \(isHubAdmin\(\)\) \{\s*html \+= `<div class="st-section" id="st-workers-section"><h4>Workers at once<\/h4>/);
  assert.ok(app.includes('How many workers and consults may run at once on this service. If the service pushes back, My Maestro drops to one at a time and climbs back up.'));
  assert.ok(app.includes("fetch('/api/hub/status'") && app.includes('if (wao !== undefined) patch.workersAtOnce = wao;'));
  assert.match(app, /n === d\) delete out\[k\]; else out\[k\] = n;/, 'a value equal to its default removes the key');
});

test('wiring: settings POST validates and applies live; boot starts from the saved value; hub status lists caps', () => {
  const server = read('server.js'), sdk = read('lib/sdk-chat.js');
  assert.ok(server.includes("patch.workersAtOnce = require('./lib/provider-pacing').cleanWorkersAtOnce(patch.workersAtOnce)"));
  assert.ok(server.includes("getPacing().setCaps(hubSettings.getSetting('workersAtOnce'))"));
  assert.ok(server.includes("capsView(hubSettings.getSetting('workersAtOnce'), capList)"));
  assert.ok(sdk.includes("getSetting('workersAtOnce')") && sdk.includes('providerPacing.resolveCaps(savedCaps)'));
  assert.ok(!/PROVIDER_LIMITS|ProviderLimiter/.test(read('lib/temporal-workers.js')), 'one source of truth for caps');
});
