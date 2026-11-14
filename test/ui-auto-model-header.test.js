'use strict';
// "Auto" in the chat header's model picker, desktop (app.js) and phone (mobile.js). Auto is an admin's choice and the
// picker's first entry; a real model turns it off. Every change (picker, Auto, the "More OpenRouter models" window or
// sheet) runs through one queue per agent with the latest choice winning, and ends by reading the hub's state back.
// The tests run the pages' real functions against a stand-in hub whose requests can be held and released in any order.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const mob = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
// A function's source: desktop functions are indented four spaces, the phone's are top level.
// (A function an older version doesn't have yet comes back empty, so these tests also run against that version.)
const fnApp = (name) => (app.match(new RegExp(`\\n    (?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n    \\}\\n`)) || [''])[0];
const fnMob = (name) => (mob.match(new RegExp(`\\n(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`)) || [''])[0];
const tick = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

// The hub: one agent's { model, autoModel }. Request kinds ('test', 'POST', 'PATCH') listed in hold wait until released.
function fakeHub({ model = 'claude-sdk/a', autoModel = false, admin = true } = {}) {
  const hub = { state: { model, autoModel }, calls: [], held: [], hold: new Set(), fail: {} };
  hub.release = async (kind) => { const i = hub.held.findIndex(h => !kind || h.kind === kind); assert.ok(i >= 0, `nothing held${kind ? ` of kind ${kind}` : ''}`); hub.held.splice(i, 1)[0].go(); await tick(); };
  const wait = (kind) => (hub.hold.has(kind) ? new Promise(go => hub.held.push({ kind, go })) : Promise.resolve());
  const res = (status, body) => ({ ok: status < 400, status, json: async () => body });
  hub.fetch = async (url, o = {}) => {
    const method = o.method || 'GET';
    if (method === 'GET' && /^\/api\/agents(\?|$)/.test(url)) return res(200, { agents: [{ name: 'compass', ...hub.state }] });
    const body = o.body ? JSON.parse(o.body) : {};
    if (method === 'POST' && /\/model$/.test(url)) {
      hub.calls.push(`POST ${body.model}`); await wait('POST');
      if (hub.fail.POST) return res(500, { success: false, error: hub.fail.POST });
      hub.state.model = body.model; return res(200, { success: true });
    }
    if (method === 'PATCH') {
      hub.calls.push(`PATCH auto=${body.autoModel}`); await wait('PATCH');
      if (!admin) return res(403, { error: 'only an admin can change: autoModel' });
      if (hub.fail.PATCH) return res(500, { success: false, error: hub.fail.PATCH });
      hub.state.autoModel = !!body.autoModel; return res(200, { success: true });
    }
    if (method === 'POST' && url === '/api/openrouter') { hub.calls.push(`list + ${body.models.slice(-1)[0]}`); return res(200, { ok: true, chosen: body.models }); }
    throw new Error(`unexpected ${method} ${url}`);
  };
  hub.test = async (m) => { hub.calls.push(`test ${m}`); await wait('test'); return true; };
  return hub;
}
const ids = ['__auto__', 'claude-sdk/a', 'claude-sdk/b', 'claude-sdk/c', 'openrouter/x'];
function select(values = ids) {
  const sel = { options: values.map(v => ({ value: v, textContent: v })), title: '', dataset: { tip: 'tip' }, disabled: false };
  sel.insertAdjacentHTML = (_, html) => sel.options.unshift({ value: html.match(/value="([^"]*)"/)[1], textContent: '' });
  let v = values[1];
  Object.defineProperty(sel, 'value', { get: () => v, set: (x) => { v = sel.options.some(o => o.value === x) ? x : ''; } });
  return sel;
}

// ── Desktop ──
function desktop(hub, { admin = true, chat: c = {} } = {}) {
  const chat = { id: 'c1', agent: 'compass', model: hub.state.model, autoModel: hub.state.autoModel, ...c };
  const sel = select(); sel.value = chat.autoModel ? '__auto__' : chat.model;
  const alerts = [], toasts = [];
  const ctx = {
    chats: { c1: chat }, fetch: hub.fetch, testBeforeSwitch: hub.test, isHubAdmin: () => admin,
    alert: (t) => alerts.push(t), hubToast: (t) => toasts.push(t), billingDisplay: (m) => m, refreshEffortPick: () => {}, openOrPicker: () => {},
    document: { getElementById: (id) => (id === 'model-pick-c1' ? sel : null) },
  };
  vm.runInNewContext(`const AUTO_PICK='__auto__'; const AUTO_TIP='Auto tip'; const OR_MORE='__or_more__'; const modelChanges = {};\n`
    + ['autoPickLabel', 'paintAutoPick', 'setChatAuto', 'agentStateFromHub', 'reserveModelChange', 'queueModelChange', 'applyModelChange', 'changeChatModel'].map(fnApp).join('')
    + '\nthis.pick = changeChatModel; this.queue = queueModelChange;', ctx);
  return { ctx, chat, sel, alerts, toasts, pick: (m, o) => ctx.pick('c1', m, o) };
}

test('desktop (a): an untested model B, then Auto before B\'s test ends: B is never posted, the agent ends on Auto', async () => {
  const hub = fakeHub(); hub.hold.add('test');
  const d = desktop(hub);
  const p1 = d.pick('claude-sdk/b'); await tick();
  const p2 = d.pick('__auto__'); await tick();
  await hub.release('test'); await Promise.all([p1, p2]);
  assert.deepStrictEqual(hub.calls, ['test claude-sdk/b', 'PATCH auto=true']);
  assert.deepStrictEqual(hub.state, { model: 'claude-sdk/a', autoModel: true });
  assert.strictEqual(d.sel.value, '__auto__'); assert.deepStrictEqual(d.alerts, []);
});

test('desktop (b): B\'s switch in flight, then Auto: B lands, then Auto; the agent ends on Auto, never turned back off', async () => {
  const hub = fakeHub(); hub.hold.add('POST');
  const d = desktop(hub);
  const p1 = d.pick('claude-sdk/b'); await tick();
  const p2 = d.pick('__auto__'); await tick();
  await hub.release('POST'); await Promise.all([p1, p2]);
  assert.deepStrictEqual(hub.calls, ['test claude-sdk/b', 'POST claude-sdk/b', 'PATCH auto=true']);
  assert.deepStrictEqual(hub.state, { model: 'claude-sdk/b', autoModel: true });
  assert.strictEqual(d.sel.value, '__auto__');
});

test('desktop (c): B then C, with B\'s request finishing last: C wins; and B still in its test when C comes: B is dropped', async () => {
  let hub = fakeHub(); hub.hold.add('POST');
  let d = desktop(hub);
  const p1 = d.pick('claude-sdk/b'); await tick();
  const p2 = d.pick('claude-sdk/c'); await tick();
  assert.deepStrictEqual(hub.calls, ['test claude-sdk/b', 'POST claude-sdk/b'], 'C waits for B (one change at a time)');
  await hub.release('POST'); await hub.release('POST'); await Promise.all([p1, p2]);
  assert.strictEqual(hub.state.model, 'claude-sdk/c'); assert.strictEqual(d.sel.value, 'claude-sdk/c');
  hub = fakeHub(); hub.hold.add('test'); d = desktop(hub);
  const q1 = d.pick('claude-sdk/b'); await tick();
  const q2 = d.pick('claude-sdk/c'); await tick();
  await hub.release('test'); await hub.release('test'); await Promise.all([q1, q2]);
  assert.deepStrictEqual(hub.calls.filter(c => c.startsWith('POST')), ['POST claude-sdk/c']);
  assert.strictEqual(hub.state.model, 'claude-sdk/c');
});

test('desktop: model A, then Auto, then A again before Auto\'s request ends: the agent ends on A with Auto off', async () => {
  const hub = fakeHub(); hub.hold.add('PATCH');
  const d = desktop(hub);
  const p1 = d.pick('__auto__'); await tick();
  const p2 = d.pick('claude-sdk/a'); await tick();
  await hub.release('PATCH'); await hub.release('PATCH'); await Promise.all([p1, p2]);
  assert.deepStrictEqual(hub.calls, ['PATCH auto=true', 'PATCH auto=false']);
  assert.deepStrictEqual(hub.state, { model: 'claude-sdk/a', autoModel: false });
  assert.strictEqual(d.sel.value, 'claude-sdk/a');
});

test('desktop: switched but Auto could not be turned off: the message says so and the picker shows the hub\'s state', async () => {
  const hub = fakeHub({ autoModel: true }); hub.fail.PATCH = 'disk full';
  const d = desktop(hub);
  assert.strictEqual(await d.pick('claude-sdk/b'), true);
  assert.deepStrictEqual(d.alerts, ['Switched to claude-sdk/b, but could not turn Auto off: disk full']);
  assert.deepStrictEqual(hub.state, { model: 'claude-sdk/b', autoModel: true });
  assert.strictEqual(d.chat.model, 'claude-sdk/b'); assert.strictEqual(d.sel.value, '__auto__');
});

test('desktop: turning Auto off shows the new model at once, from the hub, before any agent_updated event', async () => {
  const hub = fakeHub({ autoModel: true });
  const d = desktop(hub);
  await d.pick('claude-sdk/b');
  assert.strictEqual(d.sel.value, 'claude-sdk/b'); assert.strictEqual(d.chat.autoModel, false);
  const hub2 = fakeHub({ autoModel: true }); const d2 = desktop(hub2);
  await d2.pick('claude-sdk/a');   // the model it is already set to: only Auto goes off
  assert.deepStrictEqual(hub2.calls, ['PATCH auto=false']); assert.strictEqual(d2.sel.value, 'claude-sdk/a');
});

test('desktop (e): a member never sends the Auto setting; on an Auto agent an allowed model is saved and Auto stays on', async () => {
  let hub = fakeHub({ autoModel: true, admin: false });
  let d = desktop(hub, { admin: false });
  assert.strictEqual(await d.pick('claude-sdk/b'), true);
  assert.deepStrictEqual(hub.calls, ['test claude-sdk/b', 'POST claude-sdk/b'], 'no PATCH');
  assert.deepStrictEqual(d.alerts, []);
  assert.match(d.toasts[0], /Saved claude-sdk\/b as this agent's model\. Auto stays on: only an admin can turn it off\./);
  assert.strictEqual(d.sel.value, '__auto__');
  hub = fakeHub({ admin: false }); d = desktop(hub, { admin: false });
  assert.strictEqual(await d.pick('__auto__'), false); assert.deepStrictEqual(hub.calls, []);
});

test('desktop (e): the Auto group is offered to admins, and to a member only as an Auto agent\'s current entry', async () => {
  const fill = async (admin, autoModel) => {
    const sel = select(); let html = '';
    Object.defineProperty(sel, 'innerHTML', { set: (h) => { html = h; } });
    const ctx = {
      chats: { c1: { id: 'c1', agent: 'compass', model: 'claude-sdk/a', autoModel } }, isHubAdmin: () => admin,
      document: { getElementById: () => sel }, modelList: async () => ({ models: ['claude-sdk/a'], billing: {}, health: {} }),
      groupModels: (ms) => [['Anthropic', ms]], esc: (s) => String(s), billingDisplay: (m) => m, healthNote: () => '', refreshEffortPick: () => {}, console,
    };
    vm.runInNewContext(`const AUTO_PICK='__auto__'; const AUTO_TIP='Auto tip'; const OR_MORE='__or_more__';\n` + ['autoPickLabel', 'paintAutoPick', 'fillModelPickNow'].map(fnApp).join('') + '\nthis.fill = fillModelPickNow;', ctx);
    await ctx.fill('c1', sel);
    return html;
  };
  assert.match(await fill(true, false), /^<optgroup label="Auto"><option value="__auto__">Auto<\/option><\/optgroup>/);
  assert.ok(!/__auto__/.test(await fill(false, false)), 'a member on a fixed agent: no Auto entry');
  assert.match(await fill(false, true), /^<optgroup label="Auto">/, 'a member on an Auto agent sees Auto as its current entry');
});

test('desktop: the "More OpenRouter models" window goes through the same path, and its own model leaves Auto', async () => {
  const hub = fakeHub({ model: 'openrouter/x', autoModel: true });
  const d = desktop(hub);
  const overlay = { dataset: { chat: 'c1' } };
  Object.assign(d.ctx, { closeOrPicker: () => {}, orPickView: { view: { chosen: ['x'] } }, capName: (s) => s });
  d.ctx.document.getElementById = (id) => (id === 'model-pick-c1' ? d.sel : id === 'or-pick-overlay' ? overlay : null);
  vm.runInContext(fnApp('chooseOrModel') + '\nthis.choose = chooseOrModel;', d.ctx);
  await d.ctx.choose('x', null);
  assert.deepStrictEqual(hub.calls, ['PATCH auto=false']);
  assert.deepStrictEqual(hub.state, { model: 'openrouter/x', autoModel: false });
});

function withOrWindow(d, chosen) {
  const overlay = { dataset: { chat: 'c1' } };
  Object.assign(d.ctx, { closeOrPicker: () => {}, orPickView: { view: { chosen } }, capName: (s) => s, orView: null, __modelListCache: null,
    orOfferWith: (c, id) => [...(c || []), id] });
  d.ctx.document.getElementById = (id) => (id === 'model-pick-c1' ? d.sel : id === 'or-pick-overlay' ? overlay : null);
  d.ctx.document.querySelectorAll = () => [];
  vm.runInContext(fnApp('chooseOrModel') + '\nthis.choose = chooseOrModel;', d.ctx);
}
test('desktop: an OpenRouter model whose test is slow, then Auto meanwhile: Auto wins, the OpenRouter model is never saved', async () => {
  const hub = fakeHub(); hub.hold.add('test');
  const d = desktop(hub); withOrWindow(d, ['x']);
  const p1 = d.ctx.choose('y', null); await tick();
  const p2 = d.pick('__auto__'); await tick();
  await hub.release('test'); await Promise.all([p1, p2]);
  assert.deepStrictEqual(hub.calls, ['test openrouter/y', 'PATCH auto=true'], 'no list update, no POST of the older choice, Auto never turned off');
  assert.deepStrictEqual(hub.state, { model: 'claude-sdk/a', autoModel: true });
  assert.strictEqual(d.sel.value, '__auto__');
});

test('desktop: Auto waiting in line behind another change, then a model: the superseded Auto sends nothing', async () => {
  const hub = fakeHub(); hub.hold.add('POST');
  const d = desktop(hub);
  const p1 = d.pick('claude-sdk/b'); await tick();
  const p2 = d.pick('__auto__'); await tick();
  const p3 = d.pick('claude-sdk/c'); await tick();
  await hub.release('POST'); await hub.release('POST'); await Promise.all([p1, p2, p3]);
  assert.deepStrictEqual(hub.calls, ['test claude-sdk/b', 'POST claude-sdk/b', 'test claude-sdk/c', 'POST claude-sdk/c']);
  assert.deepStrictEqual(hub.state, { model: 'claude-sdk/c', autoModel: false });
  assert.strictEqual(d.sel.value, 'claude-sdk/c');
});

test('desktop: model names in the auto_model HTML are escaped (the two stream readers and the context box)', () => {
  assert.strictEqual((app.match(/<strong style="color:#7eb8f7">\$\{esc\(modelShort\)\}<\/strong>/g) || []).length, 2);
  assert.match(app, /<strong style="color:#7eb8f7">\$\{esc\(pending\)\}<\/strong>/);
  assert.ok(!/headerSpan\.textContent\s*=/.test(app), 'no handler rewrites the header text');
});

// ── Phone ──
function phone(hub, { admin = true } = {}) {
  const sel = select(); sel.dataset.agent = 'compass'; sel.value = hub.state.autoModel ? '__auto__' : hub.state.model;
  const toasts = []; const els = { 'chat-model-pick': sel, 'or-sheet': { dataset: { agent: 'compass' }, close() {} }, 'ors-msg': { textContent: '' } };
  const ctx = {
    agents: [], current: 'compass', api: hub.fetch, testBeforeSwitch: hub.test, isAdmin: () => admin, toast: (t) => toasts.push(t),
    $: (id) => els[id], mpLabel: (m) => m, paintChatStatus: () => {}, fillEffortPick: () => {}, fillModelPick: () => {}, openOrSheet: () => {},
    modelChanged: (a, n, m) => toasts.push(`now ${m}`), orSheetView: { view: { chosen: ['x'] } }, _modelListCache: null,
  };
  ctx.loadAgents = async () => { ctx.agents = [{ name: 'compass', display: 'Compass', ...hub.state }]; };
  vm.runInNewContext(`const AUTO_PICK='__auto__'; const OR_MORE='__or_more__';\nfunction agentByName(n) { return agents.find(a => a.name === n); }\n`
    + ['reserveModelChange', 'queueModelChange', 'setAgentAuto', 'applyModelChange', 'changeModelFromPick', 'onOrSheetClick'].map(fnMob).join('').replace('const modelChanges', 'var modelChanges')
    + '\nvar modelChanges = {};\nthis.pickNow = changeModelFromPick; this.sheet = onOrSheetClick;', ctx);
  return { ctx, sel, els, toasts, ready: () => ctx.loadAgents(), pick: async (m) => { sel.value = m; return ctx.pickNow(); } };
}

test('phone (a)(b)(c): the same ordering rules as the desktop, with the real handler', async () => {
  let hub = fakeHub(); hub.hold.add('test'); let p = phone(hub); await p.ready();
  const a1 = p.pick('claude-sdk/b'); await tick(); const a2 = p.pick('__auto__'); await tick();
  await hub.release('test'); await Promise.all([a1, a2]);
  assert.deepStrictEqual(hub.calls, ['test claude-sdk/b', 'PATCH auto=true'], '(a) B is never posted');
  assert.deepStrictEqual(hub.state, { model: 'claude-sdk/a', autoModel: true }); assert.strictEqual(p.sel.value, '__auto__');

  hub = fakeHub(); hub.hold.add('POST'); p = phone(hub); await p.ready();
  const b1 = p.pick('claude-sdk/b'); await tick(); const b2 = p.pick('__auto__'); await tick();
  await hub.release('POST'); await Promise.all([b1, b2]);
  assert.deepStrictEqual(hub.state, { model: 'claude-sdk/b', autoModel: true }, '(b) ends on Auto');

  hub = fakeHub(); hub.hold.add('POST'); p = phone(hub); await p.ready();
  const c1 = p.pick('claude-sdk/b'); await tick(); const c2 = p.pick('claude-sdk/c'); await tick();
  await hub.release('POST'); await hub.release('POST'); await Promise.all([c1, c2]);
  assert.strictEqual(hub.state.model, 'claude-sdk/c', '(c) the later choice wins'); assert.strictEqual(p.sel.value, 'claude-sdk/c');

  hub = fakeHub(); hub.hold.add('PATCH'); p = phone(hub); await p.ready();
  const d1 = p.pick('__auto__'); await tick(); const d2 = p.pick('claude-sdk/a'); await tick();
  await hub.release('PATCH'); await hub.release('PATCH'); await Promise.all([d1, d2]);
  assert.deepStrictEqual(hub.state, { model: 'claude-sdk/a', autoModel: false }, 'A → Auto → A ends on A with Auto off');
});

test('phone (d): another chat opened while a change is pending: a failure never paints into, or re-enables, that chat\'s picker', async () => {
  const hub = fakeHub(); hub.hold.add('PATCH'); hub.fail.PATCH = 'nope';
  const p = phone(hub); await p.ready();
  const run = p.pick('__auto__'); await tick();
  p.ctx.current = 'other'; p.sel.dataset.agent = 'other'; p.sel.options.push({ value: 'openai/gpt', textContent: 'gpt' }); p.sel.value = 'openai/gpt'; p.sel.disabled = true;
  await hub.release('PATCH'); await run;
  assert.strictEqual(p.sel.value, 'openai/gpt', 'the other agent\'s picker is untouched');
  assert.strictEqual(p.sel.disabled, true, 'and not re-enabled');
  assert.deepStrictEqual(p.toasts, ['Could not turn on Auto: nope']);
});

test('phone: switched but Auto could not be turned off says so; a member never sends the Auto setting', async () => {
  let hub = fakeHub({ autoModel: true }); hub.fail.PATCH = 'disk full'; let p = phone(hub); await p.ready();
  await p.pick('claude-sdk/b');
  assert.deepStrictEqual(p.toasts, ['Switched Compass to claude-sdk/b, but could not turn Auto off: disk full']);
  assert.strictEqual(p.sel.value, '__auto__', 'the picker shows the hub\'s state: Auto still on');
  hub = fakeHub({ autoModel: true, admin: false }); p = phone(hub, { admin: false }); await p.ready();
  await p.pick('claude-sdk/b');
  assert.deepStrictEqual(hub.calls, ['test claude-sdk/b', 'POST claude-sdk/b']);
  assert.match(p.toasts[0], /Auto stays on: only an admin can turn it off/);
});

test('phone: the "More OpenRouter models" sheet turns Auto off, also for the model the agent already has', async () => {
  const row = (id) => ({ target: { closest: () => ({ dataset: { id }, disabled: false }) } });
  let hub = fakeHub({ model: 'openrouter/x', autoModel: true }); let p = phone(hub); await p.ready();
  await p.ctx.sheet(row('x'));
  assert.deepStrictEqual(hub.calls, ['PATCH auto=false']); assert.strictEqual(hub.state.autoModel, false);
  hub = fakeHub({ autoModel: true }); p = phone(hub); await p.ready();
  await p.ctx.sheet(row('x'));
  assert.deepStrictEqual(hub.calls, ['test openrouter/x', 'POST openrouter/x', 'PATCH auto=false']);
  assert.deepStrictEqual(hub.state, { model: 'openrouter/x', autoModel: false });
});

test('phone: an OpenRouter model whose test is slow, then Auto meanwhile: Auto wins, the OpenRouter model is never saved', async () => {
  const row = (id) => ({ target: { closest: () => ({ dataset: { id }, disabled: false }) } });
  const hub = fakeHub(); hub.hold.add('test'); const p = phone(hub); await p.ready();
  p.ctx.orOfferWith = (c, id) => [...(c || []), id];
  const s1 = p.ctx.sheet(row('y')); await tick();
  const s2 = p.pick('__auto__'); await tick();
  await hub.release('test'); await Promise.all([s1, s2]);
  assert.deepStrictEqual(hub.calls, ['test openrouter/y', 'PATCH auto=true'], 'no list update, no POST of the older choice, Auto never turned off');
  assert.deepStrictEqual(hub.state, { model: 'claude-sdk/a', autoModel: true });
  assert.strictEqual(p.sel.value, '__auto__');
});

test('phone: Auto waiting in line behind another change, then a model: the superseded Auto sends nothing', async () => {
  const hub = fakeHub(); hub.hold.add('POST'); const p = phone(hub); await p.ready();
  const p1 = p.pick('claude-sdk/b'); await tick();
  const p2 = p.pick('__auto__'); await tick();
  const p3 = p.pick('claude-sdk/c'); await tick();
  await hub.release('POST'); await hub.release('POST'); await Promise.all([p1, p2, p3]);
  assert.deepStrictEqual(hub.calls, ['test claude-sdk/b', 'POST claude-sdk/b', 'test claude-sdk/c', 'POST claude-sdk/c']);
  assert.deepStrictEqual(hub.state, { model: 'claude-sdk/c', autoModel: false });
  assert.strictEqual(p.sel.value, 'claude-sdk/c');
});
