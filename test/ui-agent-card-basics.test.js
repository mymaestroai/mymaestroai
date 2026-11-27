'use strict';
// lib/ui-agent-card-basics.js: the rows of Basics and Role and team on the agent card. The real card and the real rows run against a
// small fake DOM and a fake hub (no browser, no server); each row is checked for what it reads and for the route and body it saves with.
// Offline; reads templates/settings-records.json only (never a data/ folder).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const C = require('../lib/ui-agent-card.js');
const B = require('../lib/ui-agent-card-basics.js');
const recFile = JSON.parse(fs.readFileSync(path.join(root, 'templates', 'settings-records.json'), 'utf8'));
const ALL_RECORDS = Array.isArray(recFile) ? recFile : recFile.records;
const RECORDS = ALL_RECORDS.filter((r) => /^Agent card > (Basics|Role and team)( > |$)/.test(r.home || ''));

// ---- a fake DOM (as in test/ui-agent-card.test.js) -------------------------------------------------------------------------
class El {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase(); this.ownerDocument = doc; this.attrs = {}; this.children = []; this.parentNode = null;
    this.listeners = {}; this._text = ''; this.style = {}; this.value = ''; this.scrollTop = 0;
  }
  get className() { return this.attrs.class || ''; }
  get classList() {
    const el = this;
    const list = () => String(el.attrs.class || '').split(/\s+/).filter(Boolean);
    return {
      add: (c) => { const l = list(); if (!l.includes(c)) l.push(c); el.attrs.class = l.join(' '); },
      remove: (c) => { el.attrs.class = list().filter((x) => x !== c).join(' '); },
      contains: (c) => list().includes(c),
    };
  }
  get isConnected() { for (let n = this; n; n = n.parentNode) if (n === this.ownerDocument) return true; return false; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { for (const c of this.children) c.parentNode = null; this.children = []; this._text = String(v); }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
  dispatch(t, extra = {}) {
    const ev = { type: t, target: this, stopped: false, preventDefault() {}, stopPropagation() { this.stopped = true; }, ...extra };
    for (let n = this; n && !ev.stopped; n = n.parentNode) for (const fn of [...(n.listeners[t] || [])]) fn(ev);
    return ev;
  }
  click() { return this.dispatch('click'); }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() {}
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
  querySelectorAll(sel) { return [...this.walk()].filter((e) => matchOne(e, sel)); }
}
function matchOne(el, simple) {   // tag.class[attr=val]
  const re = /([.])([\w-]+)|\[([\w-]+)(?:="?([^"\]]*)"?)?\]|^([a-zA-Z][\w-]*)/g;
  let m; let any = false;
  while ((m = re.exec(simple))) {
    any = true;
    if (m[5]) { if (el.tagName !== m[5].toUpperCase()) return false; }
    else if (m[1] === '.') { if (!el.classList.contains(m[2])) return false; }
    else if (m[3]) { const v = el.getAttribute(m[3]); if (v === null || (m[4] !== undefined && v !== m[4])) return false; }
  }
  return any;
}
function makeDoc() {
  const doc = new El('#document', null);
  doc.ownerDocument = doc;
  doc.createElement = (t) => new El(t, doc);
  doc.documentElement = new El('html', doc); doc.body = new El('body', doc);
  doc.appendChild(doc.documentElement); doc.documentElement.appendChild(doc.body);
  doc.activeElement = null;
  return doc;
}
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const all = (p, sel) => p.querySelectorAll(sel);
const rowOf = (p, id) => all(p, '.ac-row').find((r) => r.getAttribute('data-ac-row') === id);
const rowIds = (p) => all(p, '.ac-row').map((r) => r.getAttribute('data-ac-row'));

// ---- a fake hub --------------------------------------------------------------------------------------------------------------
const ADMIN = { isAdmin: true, isOwner: true, user: { id: 'u1' } };
const MEMBER = { isAdmin: false, user: { id: 'u2' }, memberModels: ['claude-sdk/claude-haiku-4-5'] };
const MEMBER_NO_LIST = { isAdmin: false, user: { id: 'u2' } };
const MODELS = ['claude-sdk/claude-sonnet-4-6', 'claude-sdk/claude-haiku-4-5', 'openai/gpt-6-astra', 'google/gemini-3-pro', 'ninfer/qwen3'];
const resp = (status, json) => ({ ok: status < 300, status, json: async () => json });
const agentsFix = () => [
  { name: 'maestro', display: 'Maestro', lead: true, category: 'primary', owner: null, sharedWith: [], model: 'claude-sdk/claude-sonnet-4-6', effort: 'default' },
  { name: 'harbor', display: 'Harbor', lead: false, category: 'specialist', reportsTo: 'maestro', owner: 'u2', sharedWith: [], model: 'claude-sdk/claude-sonnet-4-6', effort: 'medium', icon: 'H', callDisplay: 'none' },
  { name: 'quill', display: 'Quill', category: 'specialist', owner: 'u3', sharedWith: [], model: 'ninfer/qwen3' },
];

function setup(over = {}) {
  const doc = makeDoc();
  const win = { innerWidth: 1200, location: { pathname: '/', hash: '', search: '' }, addEventListener() {}, removeEventListener() {} };
  const confirms = [];
  win.confirm = (q) => { confirms.push(q); return over.confirm !== false; };
  const state = { agents: agentsFix(), notify: over.notify || { default: { questions: 'on', requested: 'on', other: 'on', security: 'on' }, agents: {} }, fail: {}, models: over.models || MODELS };
  if (over.tweak) over.tweak(state.agents);
  const calls = [];
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method, body });
    const failKey = method + ' ' + url;
    if (state.fail[failKey]) return resp(state.fail[failKey].status || 400, { error: state.fail[failKey].error });
    if (url === '/api/agents' && method === 'GET') return resp(200, JSON.parse(JSON.stringify(state.agents)));
    if (url === '/api/models' && state.modelGate) await state.modelGate;   // a test holds the model list back
    if (url === '/api/models') return resp(200, { models: state.models, billing: {}, health: { 'ninfer/qwen3': { state: 'warn', short: 'slow lately' } } });
    if (url === '/api/faces') return resp(200, { packs: [{ id: 'fox', name: 'Fox' }], available: [{ id: 'owl', name: 'Owl', size: 4000000 }] });
    if (url === '/api/voice/status') return resp(200, { enabled: true, voices: [{ id: 'amber', label: 'Amber' }] });
    if (url === '/api/users') return resp(200, { users: [{ id: 'u1', name: 'Owner', login: 'owner' }, { id: 'u2', name: 'Sam', login: 'sam' }, { id: 'u3', name: 'Hazel', login: 'hazel' }] });
    if (url === '/api/openrouter') return resp(200, { models: [] });
    if (url === '/api/notify/prefs' && method === 'GET') return resp(200, { ok: true, prefs: state.notify });
    if (url === '/api/notify/prefs' && method === 'PUT') {
      if (state.stallPutBody) return { ok: true, status: 200, json: () => new Promise(() => {}) };   // headers arrive, the body never does
      if (body.prefs === null) delete state.notify.agents[body.agent];
      else { const cur = { ...(state.notify.agents[body.agent] || {}) }; for (const [k, v] of Object.entries(body.prefs)) { if (v === null) delete cur[k]; else cur[k] = v; } state.notify.agents[body.agent] = cur; }
      return resp(200, { ok: true, prefs: state.notify });
    }
    if (url === '/api/agents/rename' && method === 'POST') {
      if (state.renameHold) await state.renameHold;
      const a = state.agents.find((x) => x.name === body.oldName); a.name = body.newName;
      return resp(200, { success: true });
    }
    if (state.gate && method === 'PATCH') await state.gate;   // a test holds a save in flight
    let m = /^\/api\/agents\/([^/]+)\/(model|display|icon)$/.exec(url);
    if (m && method === 'POST') {
      const a = state.agents.find((x) => x.name === decodeURIComponent(m[1]));
      if (m[2] === 'model') a.model = body.model; else if (m[2] === 'display') a.display = body.display; else a.icon = body.icon;
      return resp(200, { success: true });
    }
    m = /^\/api\/agents\/([^/]+)$/.exec(url);
    if (m && method === 'PATCH') {
      const a = state.agents.find((x) => x.name === decodeURIComponent(m[1]));
      for (const [k, v] of Object.entries(body)) {
        if (v === null) delete a[k];
        else if (['voice', 'voiceDefaults', 'compaction'].includes(k) && v && typeof v === 'object') {   // the server merges these (null removes a key)
          const next = { ...(a[k] || {}) }; for (const [k2, v2] of Object.entries(v)) { if (v2 === null) delete next[k2]; else next[k2] = v2; }
          if (Object.keys(next).length) a[k] = next; else delete a[k];
        } else a[k] = v;
      }
      return resp(200, { success: true });
    }
    if (m && method === 'DELETE') { state.agents = state.agents.filter((x) => x.name !== decodeURIComponent(m[1])); return resp(200, { success: true }); }
    return resp(404, {});
  };
  const stale = JSON.parse(JSON.stringify(state.agents));
  const card = C.createCard({
    doc, win, fetch, records: () => over.records || RECORDS, me: () => ('me' in over ? over.me : ADMIN), agentsList: () => stale, subscribe: () => () => {},
    help: null, setTimeout: () => {}, phone: false, simple: !!over.simple, requestMs: over.requestMs,
  });
  return { card, doc, win, state, calls, confirms };
}
const opened = async (over, where) => { B.reset(); const t = setup(over); await t.card.open('harbor', where || {}); await flush(); return t; };
const writes = (t) => t.calls.filter((c) => c.method !== 'GET');
const pick = async (sel, v) => { sel.value = v; sel.dispatch('change'); await flush(); };

// ---- 1. registration, first rows, hidden duplicates -----------------------------------------------------------------------
test('the Basics first rows are Model, Thinking effort, Notifications, Voice and Call display; Role and team has its own first rows', () => {
  assert.deepStrictEqual(C.FIRST_ROWS.basics, ['OPT-0047', 'OPT-0057', 'OPT-0168', 'OPT-0023', 'OPT-0063']);
  assert.deepStrictEqual(B.FIRST_ROWS.basics, C.FIRST_ROWS.basics);
  assert.deepStrictEqual(C.FIRST_ROWS.role, ['OPT-0003', 'OPT-0062', 'OPT-0060']);
  const names = (ids) => ids.map((id) => ALL_RECORDS.find((r) => r.id === id).name);
  assert.deepStrictEqual(names(C.FIRST_ROWS.basics), ['Model', 'Thinking effort', 'Notifications for this agent', 'Speaks with', 'Call screen for this agent']);
});

test('every record of Basics and Role and team either has a row, or is one of the few left read-only (a door, an indicator or a list with no control today)', () => {
  const READ_ONLY = ['OPT-0034', 'OPT-0039', 'OPT-0048', 'OPT-0138', 'OPT-0139', 'OPT-0817', 'OPT-0827', 'OPT-0885'];
  // OPT-0005 (the short description) is the card's own sample row; this module leaves it as it is.
  const unregistered = RECORDS.map((r) => r.id).filter((id) => !B.ROWS[id] && id !== 'OPT-0005');
  assert.deepStrictEqual(unregistered.sort(), READ_ONLY.sort());
  assert.ok(!B.ROWS['OPT-0005']);
});

test('records whose control lives on a chip or repeats a row (the three notification triples, the phone model picker, the usage badge) are not drawn', async () => {
  const t = await opened({}, { section: 'basics' });
  const more = all(t.card.el(), '.ac-more-head')[0]; more.click();
  const ids = rowIds(t.card.el());
  for (const id of ['OPT-0475', 'OPT-0866', 'OPT-1075', 'OPT-0878', 'OPT-0178', 'OPT-0137', 'OPT-0702', 'OPT-0046']) assert.ok(!ids.includes(id), id + ' is not on the card');
  assert.deepStrictEqual(ids.slice(0, 5), ['OPT-0047', 'OPT-0057', 'OPT-0168', 'OPT-0023', 'OPT-0063']);
});

// ---- 2. model --------------------------------------------------------------------------------------------------------------
test('Model: the options are the chat header\'s (Auto, then each model with who pays); a change POSTs /api/agents/<name>/model', async () => {
  const t = await opened();
  const sel = all(rowOf(t.card.el(), 'OPT-0047'), 'select')[0];
  const labels = all(sel, 'option').map((o) => o.textContent);
  assert.strictEqual(labels[0], 'Auto');
  assert.ok(labels.includes('Sonnet · Subscription'), labels.join(' | '));
  assert.ok(labels.includes('gpt-6-astra · API $'));
  assert.ok(labels.includes('qwen3 · Local — ⚠ slow lately'), labels.join(' | '));
  assert.strictEqual(sel.value, 'claude-sdk/claude-sonnet-4-6');
  assert.match(rowOf(t.card.el(), 'OPT-0047').textContent, /Subscription means no extra cost per message/);
  await pick(sel, 'openai/gpt-6-astra');
  assert.deepStrictEqual(writes(t).map((c) => [c.method, c.url, c.body]), [['POST', '/api/agents/harbor/model', { model: 'openai/gpt-6-astra' }]]);
  assert.strictEqual(t.state.agents[1].model, 'openai/gpt-6-astra');
});

test('Model: a model missing from the list reads "<words> · not in the list"; two options with the same words get their model id', async () => {
  const t = await opened({ tweak: (l) => { l[1].model = 'claude-sdk/claude-opus-5-5'; } });
  const labels = all(all(rowOf(t.card.el(), 'OPT-0047'), 'select')[0], 'option').map((o) => o.textContent);
  assert.ok(labels.includes('Opus · Subscription · not in the list'), labels.join(' | '));
  assert.ok(!labels.some((l) => /current; not in/.test(l)));
  assert.match(rowOf(t.card.el(), 'OPT-0047').textContent, /Opus · Subscription/);
  const d = await opened({ models: ['claude-sdk/claude-sonnet-4-6', 'anthropic/claude-sonnet-4-6', 'openai/gpt-6-astra'] });
  const dl = all(all(rowOf(d.card.el(), 'OPT-0047'), 'select')[0], 'option').map((o) => o.textContent);
  assert.ok(dl.includes('Sonnet · Subscription'), dl.join(' | '));
  assert.ok(dl.includes('Sonnet · API $'), dl.join(' | '));
  const same = await opened({ models: ['claude-sdk/claude-sonnet-4-6', 'claude-sdk/claude-sonnet-4-5', 'openai/gpt-6-astra'] });
  const sl = all(all(rowOf(same.card.el(), 'OPT-0047'), 'select')[0], 'option').map((o) => o.textContent);
  assert.ok(sl.includes('Sonnet · Subscription (claude-sonnet-4-6)'), sl.join(' | '));
  assert.ok(sl.includes('Sonnet · Subscription (claude-sonnet-4-5)'), sl.join(' | '));
  assert.ok(sl.includes('gpt-6-astra · API $'), 'a unique label gets no id');
});

test('Model: Auto is PATCH {autoModel:true}; choosing a model while Auto is on also turns Auto off', async () => {
  const t = await opened();
  await pick(all(rowOf(t.card.el(), 'OPT-0047'), 'select')[0], '__auto__');
  assert.deepStrictEqual(writes(t).map((c) => [c.method, c.url, c.body]), [['PATCH', '/api/agents/harbor', { autoModel: true }]]);
  t.calls.length = 0;
  await pick(all(rowOf(t.card.el(), 'OPT-0047'), 'select')[0], 'openai/gpt-6-astra');
  assert.deepStrictEqual(writes(t).map((c) => [c.method, c.url, c.body]), [['POST', '/api/agents/harbor/model', { model: 'openai/gpt-6-astra' }], ['PATCH', '/api/agents/harbor', { autoModel: false }]]);
});

test('Model, a member: live only when the admin listed models for members, and then only those; otherwise read-only with who can change it', async () => {
  const ok = await opened({ me: MEMBER });
  const sel = all(rowOf(ok.card.el(), 'OPT-0047'), 'select')[0];
  assert.ok(sel, 'a member with a members list gets the picker');
  const labels = all(sel, 'option').map((o) => o.textContent);
  assert.ok(!labels.includes('Auto'), 'Auto is an admin\'s choice');
  assert.ok(labels.includes('Haiku · Subscription'), labels.join(' | '));
  assert.ok(!labels.some((l) => l.startsWith('gpt-6-astra')), 'a paid model that is not on the list is not offered');
  await pick(sel, 'claude-sdk/claude-haiku-4-5');
  assert.deepStrictEqual(writes(ok).map((c) => [c.method, c.url, c.body]), [['POST', '/api/agents/harbor/model', { model: 'claude-sdk/claude-haiku-4-5' }]]);
  const none = await opened({ me: MEMBER_NO_LIST });
  const row = rowOf(none.card.el(), 'OPT-0047');
  assert.strictEqual(all(row, 'select').length, 0);
  assert.match(row.textContent, /Only an admin can change this\./);
});

test('Model: the server\'s refusal is shown plainly under the row', async () => {
  B.reset();
  const t = setup(); t.state.fail['POST /api/agents/harbor/model'] = { status: 403, error: 'only an admin can change this agent\'s model' };
  await t.card.open('harbor'); await flush();
  await pick(all(rowOf(t.card.el(), 'OPT-0047'), 'select')[0], 'openai/gpt-6-astra');
  assert.match(rowOf(t.card.el(), 'OPT-0047').textContent, /only an admin can change this agent's model/);
});

// ---- 3. thinking effort ----------------------------------------------------------------------------------------------------
test('effort levels follow the model: a Claude model takes all five (a select), Gemini three and gpt-5.5-pro three (segmented), a local model none', () => {
  const lv = (model, agent) => B.effortLevels(model, agent || {}, { isAdmin: true, fetch: null });
  assert.deepStrictEqual(lv('claude-sdk/claude-sonnet-4-6'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepStrictEqual(lv('anthropic/claude-opus-5-5'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepStrictEqual(lv('google/gemini-3-pro'), ['low', 'medium', 'high']);
  assert.deepStrictEqual(lv('google/gemma-2'), []);
  assert.deepStrictEqual(lv('openai/gpt-5.5-pro'), ['medium', 'high', 'xhigh']);
  assert.deepStrictEqual(lv('openai/gpt-6-astra'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepStrictEqual(lv('openai/gpt-4o'), []);
  assert.deepStrictEqual(lv('ninfer/qwen3'), []);
  assert.deepStrictEqual(lv('codex-cli/gpt-6'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepStrictEqual(lv('codex-cli/gpt-6', { effortUltra: true }).slice(-1), ['ultra'], 'Ultra only when the server says the model takes it');
});

test('Thinking effort: the chat header\'s words, a select for more than four choices, a PATCH {effort} on change', async () => {
  const t = await opened();
  const row = rowOf(t.card.el(), 'OPT-0057');
  const sel = all(row, 'select')[0];
  assert.deepStrictEqual(all(sel, 'option').map((o) => o.textContent), ['Default effort', 'Low effort', 'Medium effort', 'High effort', 'Extra high effort', 'Max effort']);
  assert.strictEqual(sel.value, 'medium');
  await pick(sel, 'high');
  assert.deepStrictEqual(writes(t).map((c) => [c.method, c.url, c.body]), [['PATCH', '/api/agents/harbor', { effort: 'high' }]]);
});

test('Thinking effort: up to four levels are a segmented control; a click saves; the row is not drawn for a model without levels or for Auto', async () => {
  const g = await opened({ tweak: (l) => { l[1].model = 'google/gemini-3-pro'; } });
  const seg = all(rowOf(g.card.el(), 'OPT-0057'), '.ac-seg-b');
  assert.deepStrictEqual(seg.map((b) => b.textContent), ['Default effort', 'Low effort', 'Medium effort', 'High effort']);
  assert.strictEqual(seg[2].getAttribute('aria-checked'), 'true');
  seg[3].click(); await flush();
  assert.deepStrictEqual(writes(g).map((c) => c.body), [{ effort: 'high' }]);
  const local = await opened({ tweak: (l) => { l[1].model = 'ninfer/qwen3'; } });
  assert.strictEqual(rowOf(local.card.el(), 'OPT-0057'), undefined);
  const auto = await opened({ tweak: (l) => { l[1].autoModel = true; } });
  assert.strictEqual(rowOf(auto.card.el(), 'OPT-0057'), undefined);
});

test('Thinking effort, a member: read-only (the server lets only an admin set it)', async () => {
  const t = await opened({ me: MEMBER });
  const row = rowOf(t.card.el(), 'OPT-0057');
  assert.strictEqual(all(row, 'select').length + all(row, '.ac-seg-b').length, 0);
  assert.match(row.textContent, /Only an admin can change this\./);
});

// ---- 4. notifications ------------------------------------------------------------------------------------------------------
test('the switch and the preset map to the stored kinds both ways', () => {
  const P = (q, r, o) => ({ default: { questions: 'on', requested: 'on', other: 'on' }, agents: { harbor: { questions: q, requested: r, other: o } } });
  assert.deepStrictEqual(B.notifyState(P('on', 'on', 'on'), 'harbor'), { on: true, preset: 'all' });
  assert.deepStrictEqual(B.notifyState(P('on', 'on', 'off'), 'harbor'), { on: true, preset: 'asks' });
  assert.deepStrictEqual(B.notifyState(P('away', 'away', 'away'), 'harbor'), { on: true, preset: 'away' });
  assert.deepStrictEqual(B.notifyState(P('off', 'off', 'off'), 'harbor'), { on: false, preset: 'off' });
  assert.deepStrictEqual(B.notifyState(P('on', 'off', 'away'), 'harbor'), { on: true, preset: 'custom' });
  assert.deepStrictEqual(B.notifyState({ default: { questions: 'off', requested: 'off', other: 'off' }, agents: {} }, 'harbor'), { on: false, preset: 'off' }, 'the person\'s default counts');
  assert.deepStrictEqual(B.presetKinds('all'), { questions: 'on', requested: 'on', other: 'on' });
  assert.deepStrictEqual(B.presetKinds('asks'), { questions: 'on', requested: 'on', other: 'off' });
  assert.deepStrictEqual(B.presetKinds('away'), { questions: 'away', requested: 'away', other: 'away' });
  assert.deepStrictEqual(B.presetKinds('off'), { questions: 'off', requested: 'off', other: 'off' });
  for (const p of ['all', 'asks', 'away', 'off']) assert.strictEqual(B.notifyState({ agents: { harbor: B.presetKinds(p) } }, 'harbor').preset, p);
});

test('Notifications: one select, no switch; "Same as all agents (...)" first, the presets, Off; a preset saves all three kinds through PUT /api/notify/prefs; "Same as all agents" removes them', async () => {
  const t = await opened();
  let row = rowOf(t.card.el(), 'OPT-0168');
  assert.strictEqual(all(row, 'input').length, 0, 'no switch any more');
  assert.deepStrictEqual(all(row, 'option').map((o) => o.textContent), ['Same as all agents (Everything)', 'Everything', 'Only questions and requests', "Only when I'm away", 'Off']);
  assert.strictEqual(all(row, 'select')[0].value, '');
  assert.strictEqual(all(row, 'select')[0].getAttribute('aria-label'), 'Notifications for Harbor');
  assert.match(row.textContent, /Using the default for all agents/);
  await pick(all(row, 'select')[0], 'asks');
  assert.deepStrictEqual(writes(t).map((c) => [c.method, c.url, c.body]), [['PUT', '/api/notify/prefs', { agent: 'harbor', prefs: { questions: 'on', requested: 'on', other: 'off' } }]]);
  row = rowOf(t.card.el(), 'OPT-0168');
  assert.strictEqual(all(row, 'select')[0].value, 'asks');
  assert.strictEqual(all(row, '.ac-reset').length, 0, 'no "Use default again" button on this row');
  t.calls.length = 0;
  await pick(all(row, 'select')[0], 'off');
  assert.deepStrictEqual(writes(t).map((c) => c.body), [{ agent: 'harbor', prefs: { questions: 'off', requested: 'off', other: 'off' } }]);
  row = rowOf(t.card.el(), 'OPT-0168');
  assert.strictEqual(all(row, 'select')[0].value, 'off');
  assert.notStrictEqual(all(row, 'select')[0].disabled, true, 'never disabled');
  t.calls.length = 0;
  await pick(all(row, 'select')[0], '');
  assert.deepStrictEqual(writes(t).map((c) => [c.method, c.url, c.body]), [['PUT', '/api/notify/prefs', { agent: 'harbor', prefs: null }]]);
});

test('Notifications: the first option names the hub default\'s preset', async () => {
  const t = await opened({ notify: { default: { questions: 'off', requested: 'off', other: 'off' }, agents: {} } });
  assert.strictEqual(all(rowOf(t.card.el(), 'OPT-0168'), 'option')[0].textContent, 'Same as all agents (Off)');
  const a = await opened({ notify: { default: { questions: 'away', requested: 'away', other: 'away' }, agents: {} } });
  assert.strictEqual(all(rowOf(a.card.el(), 'OPT-0168'), 'option')[0].textContent, "Same as all agents (Only when I'm away)");
  const c = await opened({ notify: { default: { questions: 'on', requested: 'off', other: 'away' }, agents: {} } });
  assert.strictEqual(all(rowOf(c.card.el(), 'OPT-0168'), 'option')[0].textContent, 'Same as all agents (Custom)');
});

test('Notifications: the stored kinds show as the preset ("Only when I\'m away"), an odd mix as Custom (only while it is custom); "Same as all agents" removes the agent\'s own setting', async () => {
  const away = await opened({ notify: { default: { questions: 'on', requested: 'on', other: 'on' }, agents: { harbor: { questions: 'away', requested: 'away', other: 'away' } } } });
  assert.strictEqual(all(rowOf(away.card.el(), 'OPT-0168'), 'select')[0].value, 'away');
  const custom = await opened({ notify: { default: { questions: 'on', requested: 'on', other: 'on' }, agents: { harbor: { questions: 'on', requested: 'off', other: 'away' } } } });
  const row = rowOf(custom.card.el(), 'OPT-0168');
  assert.strictEqual(all(row, 'select')[0].value, 'custom');
  assert.match(row.textContent, /Custom \(see More\)/);
  assert.strictEqual(all(row, '.ac-reset').length, 0);
  await pick(all(row, 'select')[0], 'custom');
  assert.deepStrictEqual(writes(custom), [], 'choosing Custom does nothing');
  await pick(all(row, 'select')[0], '');
  assert.deepStrictEqual(writes(custom).map((c) => [c.method, c.url, c.body]), [['PUT', '/api/notify/prefs', { agent: 'harbor', prefs: null }]]);
  assert.ok(!all(rowOf(away.card.el(), 'OPT-0168'), 'option').some((o) => /Custom/.test(o.textContent)), 'no Custom option while the state is not custom');
});

test('Notifications, the three kinds under More: a select each, saved as one kind; a member may use all of them', async () => {
  const t = await opened({ me: MEMBER });
  all(t.card.el(), '.ac-more-head')[0].click();
  const q = rowOf(t.card.el(), 'OPT-0169');
  assert.deepStrictEqual(all(q, 'option').map((o) => o.textContent), ['Use my default', 'On', 'Off', "Only when I'm away"]);
  await pick(all(q, 'select')[0], 'away');
  assert.deepStrictEqual(writes(t).map((c) => [c.method, c.url, c.body]), [['PUT', '/api/notify/prefs', { agent: 'harbor', prefs: { questions: 'away' } }]]);
  t.calls.length = 0;
  const sw = all(rowOf(t.card.el(), 'OPT-0168'), 'select')[0];
  assert.ok(sw && !sw.disabled, 'the member\'s notifications row is live (a "both" record)');
  const kind = rowOf(t.card.el(), 'OPT-0171');
  await pick(all(kind, 'select')[0], 'off');
  assert.deepStrictEqual(writes(t).map((c) => c.body), [{ agent: 'harbor', prefs: { other: 'off' } }]);
});

// ---- 5. voice --------------------------------------------------------------------------------------------------------------
test('Voice: "Same as all agents" while none of the four voice fields is set, with no voice options shown', async () => {
  const t = await opened();
  const row = rowOf(t.card.el(), 'OPT-0023');
  assert.strictEqual(all(row, 'label').length + all(row, '.ac-label').filter((e) => e.textContent === 'Voice for Harbor').length, 1);
  assert.deepStrictEqual(all(row, 'option').map((o) => o.textContent), ['Same as all agents', 'Its own voice']);
  assert.strictEqual(all(row, 'select')[0].value, 'same');
  assert.match(row.textContent, /Using the default for all agents/);
  all(t.card.el(), '.ac-more-head')[0].click();
  assert.ok(!rowIds(t.card.el()).includes('OPT-0022'), 'the voice options wait for "Its own voice"');
  assert.strictEqual(B.hasOwnVoice({ voice: { voice: '', stt: 'local', tts: 'local' } }), false);
  for (const v of [{ voice: 'amber' }, { stt: 'openai' }, { tts: 'google' }, { tts: 'openai', cloudVoice: 'coral' }]) assert.strictEqual(B.hasOwnVoice({ voice: v }), true, JSON.stringify(v));
});

test('Voice: "Its own voice" opens the voice options under More; each saves PATCH {voice} with only the changed keys', async () => {
  const t = await opened();
  await pick(all(rowOf(t.card.el(), 'OPT-0023'), 'select')[0], 'own');
  assert.strictEqual(writes(t).length, 0, 'choosing it changes nothing stored until a field is picked');
  assert.strictEqual(all(rowOf(t.card.el(), 'OPT-0023'), 'select')[0].value, 'own');
  const ids = rowIds(t.card.el());
  for (const id of ['OPT-0022', 'OPT-0024', 'OPT-0025', 'OPT-0026']) assert.ok(ids.includes(id), id + ' shown under More');
  await pick(all(rowOf(t.card.el(), 'OPT-0022'), 'select')[0], 'openai');
  assert.deepStrictEqual(writes(t).map((c) => [c.method, c.url, c.body]), [['PATCH', '/api/agents/harbor', { voice: { stt: 'openai' } }]]);
  t.calls.length = 0;
  await pick(all(rowOf(t.card.el(), 'OPT-0024'), 'select')[0], 'openai:nova');
  assert.deepStrictEqual(writes(t).map((c) => c.body), [{ voice: { tts: 'openai', cloudVoice: 'nova' } }]);
  t.calls.length = 0;
  await pick(all(rowOf(t.card.el(), 'OPT-0026'), 'select')[0], 'amber');
  assert.deepStrictEqual(writes(t).map((c) => c.body), [{ voice: { voice: 'amber' } }]);
  const row = rowOf(t.card.el(), 'OPT-0023');
  assert.strictEqual(all(row, 'select')[0].value, 'own');
  assert.ok(all(row, '.ac-reset').length === 1, 'Use default again is offered');
});

test('Voice: back to "Same as all agents" clears the voice (PATCH {voice:null}); an agent with a stored voice shows as its own', async () => {
  const t = await opened({ tweak: (l) => { l[1].voice = { voice: 'amber', stt: 'local', tts: 'local' }; } });
  const row = rowOf(t.card.el(), 'OPT-0023');
  assert.strictEqual(all(row, 'select')[0].value, 'own');
  await pick(all(row, 'select')[0], 'same');
  assert.deepStrictEqual(writes(t).map((c) => [c.method, c.url, c.body]), [['PATCH', '/api/agents/harbor', { voice: null }]]);
  assert.strictEqual(all(rowOf(t.card.el(), 'OPT-0023'), 'select')[0].value, 'same');
});

test('Voice: an ElevenLabs voice needs its ID; a cloud engine for an agent kept on this computer asks first and says who may confirm', async () => {
  const t = await opened({ tweak: (l) => { l[1].voice = { voice: 'amber', stt: 'local', tts: 'local' }; l[1].keptOnBox = true; }, confirm: false });
  all(t.card.el(), '.ac-more-head')[0].click();
  await pick(all(rowOf(t.card.el(), 'OPT-0025'), 'input')[0], 'short');
  assert.match(rowOf(t.card.el(), 'OPT-0025').textContent, /Enter the ElevenLabs voice ID \(10 to 40 letters and digits\)/);
  assert.strictEqual(writes(t).length, 0);
  await pick(all(rowOf(t.card.el(), 'OPT-0022'), 'select')[0], 'google');
  assert.strictEqual(t.confirms.length, 1);
  assert.match(t.confirms[0], /data is meant to stay on this computer[\s\S]*Google[\s\S]*Only the owner of this Maestro can confirm this/);
  assert.strictEqual(writes(t).length, 0, 'not confirmed, nothing saved');
  const ok = await opened({ tweak: (l) => { l[1].voice = { voice: 'amber', stt: 'local', tts: 'local' }; l[1].keptOnBox = true; } });
  all(ok.card.el(), '.ac-more-head')[0].click();
  ok.state.fail['PATCH /api/agents/harbor'] = { status: 403, error: 'owner_confirmation_required' };
  await pick(all(rowOf(ok.card.el(), 'OPT-0022'), 'select')[0], 'google');
  assert.deepStrictEqual(ok.calls.filter((c) => c.method === 'PATCH').map((c) => c.body), [{ voice: { stt: 'google', cloudConfirm: true } }]);
  assert.match(rowOf(ok.card.el(), 'OPT-0022').textContent, /Only the owner of this Maestro can choose a cloud engine for this agent\./);
});

test('Voice, a member: read-only with who can change it', async () => {
  const t = await opened({ me: MEMBER });
  const row = rowOf(t.card.el(), 'OPT-0023');
  assert.strictEqual(all(row, 'select').length, 0);
  assert.match(row.textContent, /Only an admin can change this\./);
});

// ---- P3-1: a member always sees the first four Basics rows, read-only, whatever the hub sent or the reads return ------------
const MEMBER_RECORDS = RECORDS.filter((r) => r.who === 'member' || r.who === 'both');   // what GET /api/settings-records sends a member: no admin-only record
const memberCard = async (me, tweak) => {
  B.reset();
  const t = setup({ me, records: MEMBER_RECORDS, tweak });
  for (const u of ['/api/models', '/api/faces', '/api/voice/status']) t.state.fail['GET ' + u] = { status: 500, error: 'no' };
  await t.card.open('harbor'); await flush();
  return t;
};
test('a member\'s card draws Model, Thinking effort, Voice and Call display read-only with the admin-only note, even with no admin-only records and failing reads', async () => {
  assert.ok(!MEMBER_RECORDS.some((r) => r.id === 'OPT-0047'), 'the member\'s record list has no Model record (the cause)');
  for (const me of [MEMBER_NO_LIST, MEMBER]) {
    const t = await memberCard(me, (l) => { l[1].model = 'ninfer/qwen3'; l[1].effort = 'high'; l[1].callDisplay = 'pack:fox'; });
    const p = t.card.el();
    const ids = rowIds(p);
    for (const id of ['OPT-0047', 'OPT-0057', 'OPT-0023', 'OPT-0063']) assert.ok(ids.includes(id), id + ' is drawn: ' + ids.join(','));
    assert.deepStrictEqual(ids.filter((id) => ['OPT-0047', 'OPT-0057', 'OPT-0168', 'OPT-0023', 'OPT-0063'].includes(id)), ['OPT-0047', 'OPT-0057', 'OPT-0168', 'OPT-0023', 'OPT-0063'], 'in the first-rows order');
    for (const id of ['OPT-0057', 'OPT-0023', 'OPT-0063']) {
      const row = rowOf(p, id);
      assert.strictEqual(all(row, 'select').length + all(row, '.ac-seg-b').length + all(row, 'input').length, 0, id + ' has no control');
      assert.match(row.textContent, /Only an admin can change this\./, id);
    }
    assert.match(rowOf(p, 'OPT-0057').textContent, /High effort/);
    assert.match(rowOf(p, 'OPT-0023').textContent, /Same as all agents/);
    assert.match(rowOf(p, 'OPT-0063').textContent, /fox/i);
    assert.match(rowOf(p, 'OPT-0047').textContent, /qwen3/);
    if (me === MEMBER_NO_LIST) assert.match(rowOf(p, 'OPT-0047').textContent, /Only an admin can change this\./);
    assert.deepStrictEqual(writes(t), []);
  }
});
test('a member\'s Thinking effort shows "Default" when none is stored, and Call display None', async () => {
  const t = await memberCard(MEMBER_NO_LIST, (l) => { delete l[1].effort; delete l[1].callDisplay; });
  assert.match(rowOf(t.card.el(), 'OPT-0057').textContent, /Default/);
  assert.match(rowOf(t.card.el(), 'OPT-0063').textContent, /None/);
});
test('an admin is unchanged: the effort row is still left out for a model with no levels, and the rows stay live', async () => {
  const local = await opened({ tweak: (l) => { l[1].model = 'ninfer/qwen3'; } });
  assert.strictEqual(rowOf(local.card.el(), 'OPT-0057'), undefined);
  const t = await opened();
  for (const id of ['OPT-0047', 'OPT-0057', 'OPT-0023', 'OPT-0063']) assert.ok(all(rowOf(t.card.el(), id), 'select').length + all(rowOf(t.card.el(), id), '.ac-seg-b').length > 0, id + ' is live for an admin');
});

// ---- 6. call display, call timing, recordings, model extras ----------------------------------------------------------------
test('Call display: None, Orb, the installed and the downloadable characters; a change is PATCH {callDisplay}', async () => {
  const t = await opened();
  const row = rowOf(t.card.el(), 'OPT-0063');
  assert.strictEqual(all(row, '.ac-label')[0].textContent, 'Call display');
  assert.match(row.textContent, /What you see during a call with Harbor\./);
  assert.deepStrictEqual(all(row, 'option').map((o) => o.textContent), ['None', 'Orb', 'Fox', 'Owl · downloads 4 MB']);
  await pick(all(row, 'select')[0], 'pack:fox');
  assert.deepStrictEqual(writes(t).map((c) => [c.method, c.url, c.body]), [['PATCH', '/api/agents/harbor', { callDisplay: 'pack:fox' }]]);
});

test('Call timing: Patient saves the preset, Custom the four numbers (and drops the preset); one number sends only itself', async () => {
  const t = await opened();
  all(t.card.el(), '.ac-more-head')[0].click();
  assert.ok(!rowIds(t.card.el()).includes('OPT-0029'));
  await pick(all(rowOf(t.card.el(), 'OPT-0028'), 'select')[0], 'patient');
  assert.deepStrictEqual(writes(t).map((c) => c.body), [{ voiceDefaults: { preset: 'patient' } }]);
  t.calls.length = 0;
  await pick(all(rowOf(t.card.el(), 'OPT-0028'), 'select')[0], 'custom');
  assert.deepStrictEqual(writes(t).map((c) => c.body), [{ voiceDefaults: { preset: null, endPause: 1200, continueWait: 3000, interruptSensitivity: 50, voiceSpeed: 1 } }]);
  t.calls.length = 0;
  await pick(all(rowOf(t.card.el(), 'OPT-0029'), 'select')[0], '2000');
  assert.deepStrictEqual(writes(t).map((c) => c.body), [{ voiceDefaults: { endPause: 2000 } }]);
  assert.deepStrictEqual(t.state.agents[1].voiceDefaults, { endPause: 2000, continueWait: 3000, interruptSensitivity: 50, voiceSpeed: 1 });
});

test('R3-4: the pause and wait rows are selects offering only the values the server accepts (lib/ui-voice lists)', async () => {
  const voice = require('../lib/ui-voice');
  const t = await opened();
  all(t.card.el(), '.ac-more-head')[0].click();
  await pick(all(rowOf(t.card.el(), 'OPT-0028'), 'select')[0], 'custom');
  const optionsOf = (id) => {
    const s = all(rowOf(t.card.el(), id), 'select');
    assert.strictEqual(s.length, 1, id + ' is a select');
    assert.strictEqual(all(rowOf(t.card.el(), id), 'input').length, 0, id + ' has no number input');
    return all(s[0], 'option').map((o) => Number(o.value));
  };
  assert.deepStrictEqual(optionsOf('OPT-0029'), voice.VOICE_END_PAUSES);
  assert.deepStrictEqual(optionsOf('OPT-0030'), voice.VOICE_CONTINUE_WAITS);
  assert.deepStrictEqual(optionsOf('OPT-0029'), [800, 1200, 2000, 4000]);
  assert.deepStrictEqual(optionsOf('OPT-0030'), [1500, 3000, 5000, 8000]);
  t.calls.length = 0;
  await pick(all(rowOf(t.card.el(), 'OPT-0030'), 'select')[0], '8000');
  assert.deepStrictEqual(writes(t).map((c) => c.body), [{ voiceDefaults: { continueWait: 8000 } }]);
});

test('Recordings: only the owner of the Maestro may change them (the route\'s rule); the body carries only the changed key (the server merges)', async () => {
  const t = await opened({ tweak: (l) => { l[1].recordings = { keep: false, allowed: ['u1'], keepReplies: false, consentLine: 'Hi', mic: 'processed', announce: 'first' }; } });
  all(t.card.el(), '.ac-more-head')[0].click();
  const keep = all(rowOf(t.card.el(), 'OPT-0033'), 'input')[0];
  keep.checked = true; keep.dispatch('change'); await flush();
  assert.deepStrictEqual(writes(t).map((c) => [c.method, c.url, c.body]), [['PATCH', '/api/agents/harbor', { recordings: { keep: true } }]]);
  const notOwner = await opened({ me: { isAdmin: true, isOwner: false, user: { id: 'u9' } } });
  all(notOwner.card.el(), '.ac-more-head')[0].click();
  const row = rowOf(notOwner.card.el(), 'OPT-0033');
  assert.strictEqual(all(row, 'input').length, 0);
  assert.match(row.textContent, /Change this on the agent's full settings page\./);
});

test('Model extras and limits: keep model, Auto per message, speed and price, longest reply, cheapest and fallback model', async () => {
  const t = await opened({ tweak: (l) => { l[1].tierOptions = ['standard', 'fast']; l[1].tierLabels = { standard: 'Standard', fast: 'Fast (costs more)' }; } });
  all(t.card.el(), '.ac-more-head')[0].click();
  const pin = all(rowOf(t.card.el(), 'OPT-0049'), 'input')[0]; pin.checked = true; pin.dispatch('change'); await flush();
  await pick(all(rowOf(t.card.el(), 'OPT-0058'), 'select')[0], 'fast');
  const mx = all(rowOf(t.card.el(), 'OPT-0066'), 'input')[0]; mx.value = '4000'; mx.dispatch('change'); await flush();
  await pick(all(rowOf(t.card.el(), 'OPT-0075'), 'select')[0], 'claude-sdk/claude-haiku-4-5');
  await pick(all(rowOf(t.card.el(), 'OPT-0076'), 'select')[0], 'none');
  assert.deepStrictEqual(writes(t).map((c) => c.body), [{ modelPinned: true }, { tier: 'fast' }, { maxOutputTokens: 4000 }, { minModel: 'claude-sdk/claude-haiku-4-5' }, { fallbackModel: 'none' }]);
  assert.ok(!rowIds(t.card.el()).includes('OPT-0052'), 'the models Auto may use show only while Auto is on');
});

test('Longest reply stays live for a member (the route lets a member set it); the other model extras do not', async () => {
  const t = await opened({ me: MEMBER });
  all(t.card.el(), '.ac-more-head')[0].click();
  assert.strictEqual(all(rowOf(t.card.el(), 'OPT-0066'), 'input').length, 1);
  assert.strictEqual(all(rowOf(t.card.el(), 'OPT-0075'), 'select').length, 0);
  assert.match(rowOf(t.card.el(), 'OPT-0075').textContent, /Only an admin can change this\./);
});

// ---- 7. section summaries --------------------------------------------------------------------------------------------------
test('the section summaries: Basics "Sonnet · Subscription · Medium effort", Role and team "Solo · reports to Maestro"', async () => {
  const t = await opened();
  const sums = all(t.card.el(), '.ac-sec-sum').map((e) => e.textContent);
  assert.strictEqual(sums[0], 'Sonnet · Subscription · Medium effort');
  assert.strictEqual(sums[1], 'Solo · reports to Maestro');
  assert.strictEqual(B.modelName('openai/gpt-6-astra'), 'gpt-6-astra');
  const local = await opened({ tweak: (l) => { l[1].model = 'ninfer/qwen3'; } });
  assert.strictEqual(all(local.card.el(), '.ac-sec-sum')[0].textContent, 'qwen3 · Local', 'no effort part for a model without levels');
  const auto = await opened({ tweak: (l) => { l[1].autoModel = true; } });
  assert.strictEqual(all(auto.card.el(), '.ac-sec-sum')[0].textContent, 'Auto');
});

// ---- 8. Role and team ------------------------------------------------------------------------------------------------------
const openRole = async (over) => { const t = await opened(over, { section: 'role' }); return t; };

test('Role and team: Role, Reports to and its job in the team first; rename, owner and sharing under More', async () => {
  const t = await openRole();
  const first = rowIds(t.card.el()).filter((id) => !['OPT-0047', 'OPT-0057', 'OPT-0168', 'OPT-0023', 'OPT-0063'].includes(id));
  assert.deepStrictEqual(first, ['OPT-0003', 'OPT-0062', 'OPT-0060']);
  const more = all(all(t.card.el(), '.ac-sec')[1], '.ac-more-head')[0];
  assert.match(more.textContent, /^▸ More: /);
  more.click();
  assert.match(all(all(t.card.el(), '.ac-sec')[1], '.ac-more-head')[0].textContent, /^▾ More: /);
  const ids = rowIds(t.card.el());
  for (const id of ['OPT-0001', 'OPT-0002', 'OPT-0004', 'OPT-0006', 'OPT-0007', 'OPT-0045', 'OPT-0059', 'OPT-0061']) assert.ok(ids.includes(id), id + ' under More');
  assert.ok(!ids.includes('OPT-0074'), 'Remove is not in a section');
});

test('Role and team rows read and save: role, lead, display name, icon, team job, team advice, build partner, reports to, owner, sharing', async () => {
  const t = await openRole();
  all(all(t.card.el(), '.ac-sec')[1], '.ac-more-head')[0].click();
  const E = () => t.card.el();
  await pick(all(rowOf(E(), 'OPT-0003'), 'select')[0], 'worker');
  await pick(all(rowOf(E(), 'OPT-0062'), 'select')[0], '');
  await pick(all(rowOf(E(), 'OPT-0060'), 'select')[0], 'challenger');
  const lead = all(rowOf(E(), 'OPT-0004'), 'input')[0]; lead.checked = true; lead.dispatch('change'); await flush();
  await pick(all(rowOf(E(), 'OPT-0059'), 'select')[0], 'off');
  await pick(all(rowOf(E(), 'OPT-0061'), 'select')[0], 'quill');
  await pick(all(rowOf(E(), 'OPT-0006'), 'select')[0], 'u3');
  assert.deepStrictEqual(writes(t).map((c) => [c.method, c.url, c.body]), [
    ['PATCH', '/api/agents/harbor', { category: 'worker' }], ['PATCH', '/api/agents/harbor', { reportsTo: '' }], ['PATCH', '/api/agents/harbor', { teamRole: 'challenger' }],
    ['PATCH', '/api/agents/harbor', { lead: true }], ['PATCH', '/api/agents/harbor', { teamGuidance: 'off' }], ['PATCH', '/api/agents/harbor', { buildPartner: 'quill' }], ['PATCH', '/api/agents/harbor', { owner: 'u3' }],
  ]);
  t.calls.length = 0;
  const name = all(rowOf(E(), 'OPT-0002'), 'input')[0]; name.value = 'Harbor Two'; name.dispatch('change'); await flush();
  const icon = all(rowOf(E(), 'OPT-0045'), 'input')[0]; icon.value = ''; icon.dispatch('change'); await flush();
  assert.deepStrictEqual(writes(t).map((c) => [c.method, c.url, c.body]), [['POST', '/api/agents/harbor/display', { display: 'Harbor Two' }], ['POST', '/api/agents/harbor/icon', { icon: '' }]]);
  t.calls.length = 0;
  const boxes = all(rowOf(E(), 'OPT-0007'), 'input');
  assert.deepStrictEqual(boxes.map((b) => b.getAttribute('value')), ['u1', 'u2', 'u3']);
  assert.strictEqual(boxes[2].disabled, true, 'the owner is not a person it is "shared with"');
  boxes[0].checked = true; boxes[0].dispatch('change'); await flush();
  assert.deepStrictEqual(writes(t).map((c) => c.body), [{ sharedWith: ['u1'] }]);
});

test('Rename: asks first with today\'s words, POSTs /api/agents/rename, and the card reopens on the new name', async () => {
  const t = await openRole();
  all(all(t.card.el(), '.ac-sec')[1], '.ac-more-head')[0].click();
  const input = all(rowOf(t.card.el(), 'OPT-0001'), 'input')[0];
  input.value = 'Harbor-2!'; input.dispatch('change'); await flush();
  assert.deepStrictEqual(t.confirms, ['Rename agent "harbor" to "harbor-2"?  This renames the workspace folder, conversation file, and config entry.']);
  assert.deepStrictEqual(writes(t).map((c) => [c.method, c.url, c.body]), [['POST', '/api/agents/rename', { oldName: 'harbor', newName: 'harbor-2' }]]);
  assert.strictEqual(t.card.isOpen(), true);
  assert.strictEqual(t.card.el().getAttribute('data-agent'), 'harbor-2', 'reopened on the new name');
  assert.match(all(t.card.el(), '.ac-title')[0].textContent, /Settings for Harbor/);
  assert.ok(rowOf(t.card.el(), 'OPT-0001'), 'at the rename row');
});

test('Rename: a declined confirm sends nothing; an empty or unchanged name is refused in words; the server\'s refusal is shown', async () => {
  const no = await openRole({ confirm: false });
  all(all(no.card.el(), '.ac-sec')[1], '.ac-more-head')[0].click();
  const i = all(rowOf(no.card.el(), 'OPT-0001'), 'input')[0]; i.value = 'other'; i.dispatch('change'); await flush();
  assert.strictEqual(writes(no).length, 0);
  const same = all(rowOf(no.card.el(), 'OPT-0001'), 'input')[0]; same.value = 'harbor'; same.dispatch('change'); await flush();
  assert.match(rowOf(no.card.el(), 'OPT-0001').textContent, /That is the current short name\./);
  const blank = all(rowOf(no.card.el(), 'OPT-0001'), 'input')[0]; blank.value = '!!!'; blank.dispatch('change'); await flush();
  assert.match(rowOf(no.card.el(), 'OPT-0001').textContent, /can not be empty/);
  B.reset();
  const bad = setup(); bad.state.fail['POST /api/agents/rename'] = { status: 400, error: 'This agent has call recordings, so it can not be renamed.' };
  await bad.card.open('harbor', { section: 'role' }); await flush();
  all(all(bad.card.el(), '.ac-sec')[1], '.ac-more-head')[0].click();
  const x = all(rowOf(bad.card.el(), 'OPT-0001'), 'input')[0]; x.value = 'other'; x.dispatch('change'); await flush();
  assert.match(rowOf(bad.card.el(), 'OPT-0001').textContent, /This agent has call recordings, so it can not be renamed\./);
  assert.strictEqual(bad.card.el().getAttribute('data-agent'), 'harbor');
});

test('Remove this agent: alone at the very bottom, after the footer line, for admins only; today\'s confirm, DELETE, then the card closes', async () => {
  const t = await openRole();
  const body = all(t.card.el(), '.ac-body')[0];
  const last = body.children[body.children.length - 1];
  assert.strictEqual(last.getAttribute('data-rec'), 'OPT-0074');
  assert.strictEqual(all(last, 'button')[0].textContent, 'Remove this agent');
  assert.strictEqual(all(t.card.el(), '.ac-bottom').length, 1);
  assert.strictEqual(body.children[body.children.length - 2].textContent, C.TEXT.footer, 'after "You can also ask Maestro"');
  all(last, 'button')[0].click(); await flush();
  assert.deepStrictEqual(t.confirms, ["Delete Harbor? Its files, chats and memory are kept with the hub's deleted agents, and its name is free again."]);
  assert.ok(t.confirms[0].startsWith('Delete Harbor? '), 'the question names the agent');
  assert.deepStrictEqual(writes(t).map((c) => [c.method, c.url]), [['DELETE', '/api/agents/harbor']]);
  assert.strictEqual(t.card.isOpen(), false);
});

test('Reports to: a primary agent reads "<name> is a primary agent and takes its work from you." with no "can not be changed" line', async () => {
  const t = await openRole({ tweak: (l) => { l[1].category = 'primary'; l[1].reportsTo = ''; } });
  const row = rowOf(t.card.el(), 'OPT-0062');
  assert.match(row.textContent, /Harbor is a primary agent and takes its work from you\./);
  assert.strictEqual(all(row, 'select').length, 0);
  assert.ok(!row.textContent.includes(C.TEXT.notHere), 'no notHere line');
  assert.strictEqual(all(row, '.ac-note').length, 0);
});

test('Remove this agent: a declined confirm sends nothing; a refusal is shown under the button; members and Simple never see it', async () => {
  const no = await openRole({ confirm: false });
  all(all(no.card.el(), '.ac-bottom')[0], 'button')[0].click(); await flush();
  assert.strictEqual(writes(no).length, 0);
  assert.strictEqual(no.card.isOpen(), true);
  B.reset();
  const bad = setup(); bad.state.fail['DELETE /api/agents/harbor'] = { status: 400, error: 'Maestro can not be deleted.' };
  await bad.card.open('harbor'); await flush();
  all(all(bad.card.el(), '.ac-bottom')[0], 'button')[0].click(); await flush();
  assert.match(all(bad.card.el(), '.ac-bottom')[0].textContent, /Maestro can not be deleted\./);
  const member = await opened({ me: MEMBER });
  assert.strictEqual(all(member.card.el(), '.ac-bottom').length, 0);
  const simple = await opened({ simple: true });
  assert.strictEqual(all(simple.card.el(), '.ac-bottom').length, 0);
});

test('a member sees Basics only: no Role and team section, so no rename, owner, sharing or Remove', async () => {
  const t = await opened({ me: MEMBER });
  assert.deepStrictEqual(all(t.card.el(), '.ac-sec').map((s) => s.getAttribute('data-sec')), ['basics']);
});

// ---- 8b. phase 3 round 1: one save at a time, whole objects from a fresh read, lazy lists retry ---------------------------------
test('Voice: only the changed key is sent (the server merges); what is checked (cloud confirmation) is read fresh', async () => {
  const t = await opened({ tweak: (l) => { l[1].voice = { voice: 'amber', stt: 'local', tts: 'local' }; } });
  all(t.card.el(), '.ac-more-head')[0].click();
  t.state.agents[1].voice = { voice: 'amber', stt: 'google', tts: 'local' };   // changed elsewhere; the card has not heard yet
  t.calls.length = 0;
  await pick(all(rowOf(t.card.el(), 'OPT-0026'), 'select')[0], '');
  assert.deepStrictEqual(t.calls.filter((c) => c.method === 'GET' && c.url === '/api/agents').length >= 1, true, 'a fresh GET came first');
  assert.deepStrictEqual(writes(t).map((c) => c.body), [{ voice: { voice: '' } }], 'the stt another device set is not in the body');
  assert.strictEqual(t.state.agents[1].voice.stt, 'google', 'the other device\'s change is still there');
});

test('Voice: going back to this computer for speech sends tts and removes the stored cloud voice with null', async () => {
  const t = await opened({ tweak: (l) => { l[1].voice = { voice: '', stt: 'local', tts: 'openai', cloudVoice: 'nova' }; } });
  all(t.card.el(), '.ac-more-head')[0].click();
  await pick(all(rowOf(t.card.el(), 'OPT-0024'), 'select')[0], 'local');
  assert.deepStrictEqual(writes(t).map((c) => c.body), [{ voice: { tts: 'local', cloudVoice: null } }]);
});

test('Voice: "Its own voice" with nothing saved yet reads "(choose below)"; once a detail is stored it reads "Its own voice"', async () => {
  const t = await opened();
  await pick(all(rowOf(t.card.el(), 'OPT-0023'), 'select')[0], 'own');
  const row = rowOf(t.card.el(), 'OPT-0023');
  assert.deepStrictEqual(all(row, 'option').map((o) => o.textContent), ['Same as all agents', 'Its own voice (choose below)']);
  await pick(all(rowOf(t.card.el(), 'OPT-0022'), 'select')[0], 'openai');
  assert.deepStrictEqual(all(rowOf(t.card.el(), 'OPT-0023'), 'option').map((o) => o.textContent), ['Same as all agents', 'Its own voice']);
  B.reset();
});

test('a second change while a save is in flight is blocked (every control disabled); the next timing body is the Custom switch with the numbers read fresh', async () => {
  const t = await opened();
  all(t.card.el(), '.ac-more-head')[0].click();
  let release; t.state.gate = new Promise((r) => { release = r; });
  await pick(all(rowOf(t.card.el(), 'OPT-0063'), 'select')[0], 'pack:fox');
  const p = t.card.el();
  const live = all(p, 'select').concat(all(p, 'input'));
  assert.ok(live.length > 3 && live.every((e) => e.disabled === true), 'all controls disabled while the save runs');
  const other = all(rowOf(p, 'OPT-0028'), 'select')[0];
  other.value = 'custom'; other.dispatch('change'); await flush();
  assert.deepStrictEqual(writes(t).length, 1, 'the second change did not start a save');
  t.state.gate = null; release(); await flush();
  assert.ok(all(t.card.el(), 'select').every((e) => !e.disabled), 'controls are back');
  t.state.agents[1].voiceDefaults = { endPause: 900, continueWait: 3000, interruptSensitivity: 50, voiceSpeed: 1 };   // changed elsewhere
  t.calls.length = 0;
  await pick(all(rowOf(t.card.el(), 'OPT-0028'), 'select')[0], 'custom');
  assert.deepStrictEqual(writes(t).map((c) => c.body), [{ voiceDefaults: { preset: null, endPause: 900, continueWait: 3000, interruptSensitivity: 50, voiceSpeed: 1 } }]);
});

test('a list that failed to load is asked for again after a while (not forever blank)', async () => {
  B.reset();
  const t = setup(); t.state.fail['GET /api/models'] = { status: 500, error: 'down' };
  await t.card.open('harbor', {}); await flush();
  const gets = () => t.calls.filter((c) => c.url === '/api/models').length;
  assert.strictEqual(gets(), 1);
  await t.card.refresh(); await flush();
  assert.strictEqual(gets(), 1, 'not at once');
  delete t.state.fail['GET /api/models'];
  const realNow = Date.now; Date.now = () => realNow() + 60000;
  try { await t.card.refresh(); await flush(); } finally { Date.now = realNow; }
  assert.strictEqual(gets(), 2, 'asked again');
  assert.ok(all(rowOf(t.card.el(), 'OPT-0047'), 'option').length > 1, 'the list is there now');
});

test('a lazy list that lands after the person switched cards fills the card that is open now', async () => {
  B.reset();
  const t = setup();
  let release; t.state.modelGate = new Promise((r) => { release = r; });
  await t.card.open('harbor', {}); await flush();   // starts the model list read, held back
  await t.card.open('quill', {}); await flush();
  const before = all(rowOf(t.card.el(), 'OPT-0047'), 'option').length;
  release(); await flush();
  assert.strictEqual(t.card.state().name, 'quill');
  assert.ok(all(rowOf(t.card.el(), 'OPT-0047'), 'option').length > before, 'the list is in the open card, not lost with the first');
});

test('Short name: a rename answered after the person opened another card leaves that card open; with nobody navigating it reopens on the new name', async () => {
  const start = async () => {
    const t = setup();
    await t.card.open('harbor', { section: 'role' }); await flush();
    for (const h of all(t.card.el(), '.ac-more-head')) if (h.getAttribute('aria-expanded') === 'false') h.click();
    let release; t.state.renameHold = new Promise((r) => { release = r; });
    const input = all(rowOf(t.card.el(), 'OPT-0001'), 'input')[0];
    input.value = 'harbor2'; input.dispatch('change'); await flush();
    return { t, release };
  };
  const a = await start();
  await a.t.card.open('quill', { section: 'role' });   // moved on while the rename is still being answered
  a.release(); await flush();
  assert.ok(a.t.calls.some((c) => c.url === '/api/agents/rename'), 'the rename went through');
  assert.strictEqual(a.t.card.state().name, 'quill', 'quill stays; harbor2 does not take over');
  const b = await start();
  b.release(); await flush();
  assert.strictEqual(b.t.card.state().name, 'harbor2', 'nobody navigated: the card is on the new name');
});

// ---- 8b. phase 3 round 4 ---------------------------------------------------------------------------------------------------
test('R4-1: a notifications save whose body never arrives is given up after the limit and the row unlocks with a message', async () => {
  const t = await opened({ requestMs: 40 });
  t.state.stallPutBody = true;
  const row = rowOf(t.card.el(), 'OPT-0168');
  await pick(all(row, 'select')[0], 'asks');
  assert.strictEqual(t.card.state().saving.size, 1, 'locked while waiting');
  await new Promise((r) => setTimeout(r, 150)); await flush();
  assert.strictEqual(t.card.state().saving.size, 0, 'unlocked after the deadline');
  assert.match(rowOf(t.card.el(), 'OPT-0168').textContent, /did not answer in time/);
});

test('R4-1: no row code calls fetch directly (every request goes through the card\'s bounded helper)', () => {
  for (const f of ['ui-agent-card-basics.js', 'ui-agent-card-more.js']) {
    const src = fs.readFileSync(path.join(root, 'lib', f), 'utf8');
    assert.ok(!/\.fetch\s*\(|\bfetch\s*\(/.test(src), f + ' has no raw fetch call');
  }
});

test('R4-4: the voice speed row is 0.75 to 1.5 in steps of 0.05, and 2.0 is refused before anything is sent; sensitivity is 0 to 100', async () => {
  const t = await opened({ tweak: (a) => { a[1].voiceDefaults = { endPause: 1200, continueWait: 3000, interruptSensitivity: 50, voiceSpeed: 1 }; } });
  all(t.card.el(), '.ac-more-head')[0].click();
  const input = all(rowOf(t.card.el(), 'OPT-0032'), 'input')[0];
  assert.deepStrictEqual(['min', 'max', 'step'].map((k) => input.getAttribute(k)), ['0.75', '1.5', '0.05']);
  t.calls.length = 0;
  input.value = '2'; input.dispatch('change'); await flush();
  assert.strictEqual(writes(t).length, 0, 'nothing saved');
  assert.match(rowOf(t.card.el(), 'OPT-0032').textContent, /Enter a number from 0\.75 to 1\.5/);
  const sens = all(rowOf(t.card.el(), 'OPT-0031'), 'input')[0];
  sens.value = '101'; sens.dispatch('change'); await flush();
  assert.strictEqual(writes(t).length, 0, 'sensitivity above 100 is refused too');
  const ok = all(rowOf(t.card.el(), 'OPT-0032'), 'input')[0];
  ok.value = '1.25'; ok.dispatch('change'); await flush();
  assert.deepStrictEqual(writes(t).map((c) => c.body), [{ voiceDefaults: { voiceSpeed: 1.25 } }]);
});

test('R5-3: a voice speed that is not a multiple of 0.05, and a sensitivity that is not a whole number, are refused before saving', async () => {
  const t = await opened({ tweak: (a) => { a[1].voiceDefaults = { endPause: 1200, continueWait: 3000, interruptSensitivity: 50, voiceSpeed: 1 }; } });
  all(t.card.el(), '.ac-more-head')[0].click();
  t.calls.length = 0;
  for (const bad of ['1.07', '0.8333', '1.001']) {
    const input = all(rowOf(t.card.el(), 'OPT-0032'), 'input')[0];
    input.value = bad; input.dispatch('change'); await flush();
    assert.strictEqual(writes(t).length, 0, bad + ' not saved');
    assert.match(rowOf(t.card.el(), 'OPT-0032').textContent, /steps of 0\.05/, bad);
  }
  for (const bad of ['50.5', '']) {
    const sens = all(rowOf(t.card.el(), 'OPT-0031'), 'input')[0];
    sens.value = bad; sens.dispatch('change'); await flush();
    assert.strictEqual(writes(t).length, 0, JSON.stringify(bad) + ' not saved');
    assert.match(rowOf(t.card.el(), 'OPT-0031').textContent, bad === '' ? /Enter a number/ : /whole number from 0 to 100/);
  }
  const ok = all(rowOf(t.card.el(), 'OPT-0032'), 'input')[0];
  ok.value = '1.15'; ok.dispatch('change'); await flush();
  const sens2 = all(rowOf(t.card.el(), 'OPT-0031'), 'input')[0];
  sens2.value = '70'; sens2.dispatch('change'); await flush();
  assert.deepStrictEqual(writes(t).map((c) => c.body), [{ voiceDefaults: { voiceSpeed: 1.15 } }, { voiceDefaults: { interruptSensitivity: 70 } }]);
});

// ---- 9. source checks ------------------------------------------------------------------------------------------------------
test('the module uses no innerHTML, no invisible characters, and no real names', () => {
  const src = fs.readFileSync(path.join(root, 'lib', 'ui-agent-card-basics.js'), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(src));
  assert.ok(!new RegExp('[' + String.fromCharCode(0xfe0f, 0x200d) + ']').test(src));
  assert.ok(!/\beval\(|new Function/.test(src));
});
