'use strict';
// The Welcome page's team box (welcome.html between the team-box markers), run in a sandbox with a stand-in page and a
// stand-in api(): Start waits for the plan; a saved skip loads unticked; the create carries what was shown and a changed
// plan creates nothing until the person looks again; a plan that comes late leaves a "Create the team" button.
// Review r1 (GPT-6 BLOCKs 1-3).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'welcome.html'), 'utf8');
const BLOCK = SRC.slice(SRC.indexOf('// <team-box>'), SRC.indexOf('// </team-box>'));

function el(id) {
  return {
    id, hidden: false, checked: id === 'team-create', disabled: false, value: '', textContent: '', className: '', children: [], listeners: {},
    replaceChildren(...c) { this.children = c; }, appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
    fire(t) { (this.listeners[t] || []).forEach(f => f()); },
    get text() { return [this.textContent, ...this.children.map(c => (c && c.text) || (c && c.textContent) || '')].join(' '); },
  };
}
const PLAN = [
  { role: 'challenger', name: 'challenger', display: 'Challenger', icon: 'C', model: 'codex-cli/gpt-x', route: 'Subscription', perUse: false, tier: 'mid', note: null, action: 'create', reason: null },
  { role: 'scout', name: 'scout', display: 'Scout', icon: 'S', model: 'claude-sdk/claude-haiku-5', route: 'Subscription', perUse: false, tier: 'fast', note: null, action: 'create', reason: null },
];
function page({ plan = PLAN, skippedAt = null } = {}) {
  const els = {};
  const $ = (id) => (els[id] = els[id] || el(id));
  $('m-model').value = 'claude-sdk/default';
  const calls = [];
  const waiting = [];
  const api = (method, url, body) => new Promise((resolve) => { calls.push({ method, url, body }); waiting.push({ url, resolve }); });
  const ctx = {
    $, api, offered: new Map([['claude', { models: ['claude-sdk/claude-haiku-5'] }]]),
    document: { createElement: () => el(''), createTextNode: (t) => ({ textContent: t }) },
    encodeURIComponent, setTimeout: (f) => { ctx.timers.push(f); return 0; }, timers: [], Promise, console,
  };
  vm.runInNewContext(BLOCK + '\nthis.loadTeam = loadTeam; this.setUpTeam = setUpTeam;', ctx);
  const answer = async (url, status, body) => {
    const i = waiting.findIndex(w => w.url.startsWith(url));
    assert.ok(i >= 0, `a request to ${url} is waiting`);
    waiting.splice(i, 1)[0].resolve({ status, body });
    for (let k = 0; k < 5; k++) await new Promise(r => setImmediate(r));
  };
  const planBody = { ok: true, plan, ...(skippedAt ? { skippedAt } : {}) };
  return { ctx, $, calls, answer, planBody, settle: async () => { for (let k = 0; k < 5; k++) await new Promise(r => setImmediate(r)); } };
}

test('Start pressed before the plan arrives: it waits for it, then creates what was shown', async () => {
  const p = page();
  p.ctx.loadTeam();
  const start = p.ctx.setUpTeam();
  await p.settle();
  assert.ok(!p.calls.some(c => c.url === '/api/welcome/team'), 'no create before the plan');
  await p.answer('/api/welcome/team/plan', 200, p.planBody);
  await p.settle();
  const create = p.calls.find(c => c.url === '/api/welcome/team');
  assert.ok(create, 'created after the plan came');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(create.body.expect)), [{ role: 'challenger', model: 'codex-cli/gpt-x' }, { role: 'scout', model: 'claude-sdk/claude-haiku-5' }]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(create.body.models)), ['claude-sdk/claude-haiku-5'], 'the same model list as the preview');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p.calls[0].body.models)), ['claude-sdk/claude-haiku-5']);
  await p.answer('/api/welcome/team', 200, { ok: true, created: PLAN, skipped: [] });
  await start;
  assert.strictEqual(p.$('team-create-now').hidden, true);
});

test('a skip saved earlier loads unticked, and Start records the skip instead of creating', async () => {
  const p = page({ skippedAt: '2026-01-01T00:00:00Z' });
  p.ctx.loadTeam();
  await p.answer('/api/welcome/team/plan', 200, p.planBody);
  assert.strictEqual(p.$('team-create').checked, false);
  const start = p.ctx.setUpTeam();
  await p.settle();
  assert.ok(p.calls.some(c => c.url === '/api/welcome/team/skip'));
  assert.ok(!p.calls.some(c => c.url === '/api/welcome/team'));
  await p.answer('/api/welcome/team/skip', 200, { ok: true });
  await start;
  // ticking it again by hand is a real opt-in: a later plan refresh does not untick it
  const q = page({ skippedAt: '2026-01-01T00:00:00Z' });
  q.ctx.loadTeam(); await q.answer('/api/welcome/team/plan', 200, q.planBody);
  q.$('team-create').checked = true; q.$('team-create').fire('change');
  q.ctx.loadTeam(); await q.answer('/api/welcome/team/plan', 200, q.planBody);
  assert.strictEqual(q.$('team-create').checked, true);
});

test('a plan that changed since it was shown creates nothing; the new plan is shown with a Create the team button', async () => {
  const p = page();
  p.ctx.loadTeam(); await p.answer('/api/welcome/team/plan', 200, p.planBody);
  const start = p.ctx.setUpTeam(); await p.settle();
  const changed = [{ ...PLAN[0], model: 'openai/gpt-x', route: 'API', perUse: true }, PLAN[1]];
  await p.answer('/api/welcome/team', 409, { ok: false, changed: true, plan: changed });
  await start;
  assert.match(p.$('team-result').textContent, /changed since it was shown/);
  assert.strictEqual(p.$('team-create-now').hidden, false);
  assert.strictEqual(p.$('team-opt').hidden, true);
  p.$('team-create-now').fire('click'); await p.settle();
  const second = p.calls.filter(c => c.url === '/api/welcome/team')[1];
  assert.strictEqual(second.body.expect[0].model, 'openai/gpt-x', 'the button sends what is now on screen');
});

test('a plan that never comes by Start: a message, and the button once it arrives; Start never waits forever', async () => {
  const p = page();
  p.ctx.loadTeam();
  const start = p.ctx.setUpTeam(); await p.settle();
  p.ctx.timers.forEach(f => f());   // the 15-second wait ends
  await start;
  assert.match(p.$('team-result').textContent, /could not be shown just now/);
  assert.strictEqual(p.$('team-box').hidden, false, 'the message stays visible');
  assert.ok(!p.calls.some(c => c.url === '/api/welcome/team'));
  await p.answer('/api/welcome/team/plan', 200, p.planBody);
  assert.strictEqual(p.$('team-create-now').hidden, false, 'the late plan offers the button');
});
