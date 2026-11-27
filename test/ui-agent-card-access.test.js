'use strict';
// lib/ui-agent-card-access.js: the live Access rows of the agent card (permission classes, folders, the box, the command lockbox).
// The real card runs against a small fake DOM and a fake hub (no browser, no server); every save is checked against the route and
// body it uses, and every change that loosens a protection against the confirm it asks first. Offline; reads no data/.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const C = require('../lib/ui-agent-card.js');
require('../lib/ui-agent-card-more.js');   // loaded first, as on the pages: the access rows replace its door rows
const A = require('../lib/ui-agent-card-access.js');
const RECORDS_ALL = JSON.parse(fs.readFileSync(path.join(root, 'templates/settings-records.json'), 'utf8'));
const ACCESS = (Array.isArray(RECORDS_ALL) ? RECORDS_ALL : RECORDS_ALL.records).filter((r) => /^Agent card > (Basics|Access)/.test(r.home || ''));

// ---- a fake DOM (as in test/ui-agent-card-more.test.js) ------------------------------------------------------------------
class El {
  constructor(tag, doc) { this.tagName = String(tag).toUpperCase(); this.ownerDocument = doc; this.attrs = {}; this.children = []; this.parentNode = null; this.listeners = {}; this._text = ''; this.style = {}; this.value = ''; this.scrollTop = 0; }
  get classList() {
    const el = this; const list = () => String(el.attrs.class || '').split(/\s+/).filter(Boolean);
    return { add: (c) => { const l = list(); if (!l.includes(c)) l.push(c); el.attrs.class = l.join(' '); }, remove: (c) => { el.attrs.class = list().filter((x) => x !== c).join(' '); }, contains: (c) => list().includes(c) };
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
  dispatch(t, extra = {}) { const ev = { type: t, target: this, stopped: false, preventDefault() {}, stopPropagation() { this.stopped = true; }, ...extra }; for (let n = this; n && !ev.stopped; n = n.parentNode) for (const fn of [...(n.listeners[t] || [])]) fn(ev); return ev; }
  click() { return this.dispatch('click'); }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() {}
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
  querySelectorAll(sel) { return [...this.walk()].filter((e) => matchOne(e, sel)); }
}
function matchOne(el, simple) {
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
  const doc = new El('#document', null); doc.ownerDocument = doc; doc.createElement = (t) => new El(t, doc);
  doc.documentElement = new El('html', doc); doc.body = new El('body', doc); doc.appendChild(doc.documentElement); doc.documentElement.appendChild(doc.body); doc.activeElement = null;
  return doc;
}
const flush = async () => { for (let i = 0; i < 14; i++) await new Promise((r) => setImmediate(r)); };
const all = (p, sel) => p.querySelectorAll(sel);
const rowOf = (p, id) => all(p, '.ac-row').find((r) => r.getAttribute('data-ac-row') === id);
const sel = (row, i = 0) => all(row, 'select')[i];
const change = (el, v) => { if (typeof v === 'boolean') el.checked = v; else el.value = v; el.dispatch('change'); };

// ---- fixtures ------------------------------------------------------------------------------------------------------------
const ADMIN = { isAdmin: true, user: { id: 'owner' } };
const MEMBER = { isAdmin: false, user: { id: 'sam' } };
const resp = (status, json) => ({ ok: status < 300, status, json: async () => json });
const ROLE = { worker: { web: 'allow', read_outside: 'allow', write_outside: 'deny', send: 'deny', admin: 'deny', destroy: 'deny' }, member: { web: 'deny', read_outside: 'deny', write_outside: 'deny', send: 'deny', admin: 'deny', destroy: 'deny' } };
const FOLDERS = [
  { path: '/srv/common', label: 'Common files', kind: 'common' },
  { path: '/srv/team/ops', label: 'Ops team', kind: 'team' },
  { path: '/srv/team/legal', label: 'Legal team', kind: 'team' },
];
const agentsFix = () => [
  { name: 'maestro', display: 'Maestro', lead: true, owner: null, sharedWith: [], model: 'claude-sdk/opus' },
  { name: 'hazel', display: 'Hazel', owner: null, sharedWith: [], model: 'claude-sdk/sonnet', policy: { overrides: { web: 'ask' }, roots: ['/srv/common', '~/notes'] } },
];

function setup(over = {}) {
  A.resetCache();
  const doc = makeDoc();
  const confirms = [];
  const win = { innerWidth: 1200, location: { pathname: '/', hash: '', search: '' }, addEventListener() {}, removeEventListener() {}, open() {}, confirm: (q) => { confirms.push(q); return t.yes; } };
  const state = Object.assign({
    agents: agentsFix(), role: 'worker', fail: null, failRoutes: {},
    sandboxDefaults: { member: 'container', admin: 'off' }, lockDefault: 'off', blocked: { entries: [] },
  }, over.state || {});
  const calls = [];
  const resolve = (r) => String(r).replace(/^~/, '/home/owner');
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET'; let body = init.body ? JSON.parse(init.body) : null;
    const ifMatch = body && 'policyIfMatch' in body ? body.policyIfMatch : undefined;   // kept apart: the checks below read `body` as the change itself
    if (ifMatch !== undefined) { body = { ...body }; delete body.policyIfMatch; }
    calls.push({ url, method, body, ifMatch });
    for (const [pat, r] of Object.entries(state.failRoutes)) if (url.includes(pat) && (!r.method || r.method === method)) return resp(r.status, r.json);
    if (url === '/api/agents' && method === 'GET') return resp(200, JSON.parse(JSON.stringify(state.agents)));
    const pm = /^\/api\/agents\/([^/]+)$/.exec(url);
    if (pm && method === 'PATCH') {
      if (state.fail) return resp(400, { error: state.fail });
      const a = state.agents.find((x) => x.name === pm[1]);
      if (state.racing) { const f = state.racing; state.racing = null; f(a); }   // another card's change lands just before this request
      if (ifMatch !== undefined && JSON.stringify(ifMatch) !== JSON.stringify(a.policy || {})) {   // the server's compare-and-set
        return resp(409, { ok: false, error: "This agent's permissions were changed elsewhere. The card now shows them again; make your change once more." });
      }
      for (const [k, v] of Object.entries(body)) {
        if (k === 'policy') {   // the server replaces the whole policy object
          const ov = v.overrides || {}; const roots = v.roots || [];
          if (Object.keys(ov).length || roots.length) a.policy = { ...(Object.keys(ov).length ? { overrides: ov } : {}), ...(roots.length ? { roots } : {}) }; else delete a.policy;
        } else a[k] = v;
      }
      return resp(200, { success: true });
    }
    if (/^\/api\/policy\/hazel$/.test(url)) {
      const a = state.agents.find((x) => x.name === 'hazel'); const ov = (a.policy && a.policy.overrides) || {};
      const rules = { ...ROLE[state.role] }; const source = {}; for (const k of Object.keys(rules)) source[k] = 'role';
      for (const [k, v] of Object.entries(ov)) { rules[k] = v; source[k] = 'agent'; }
      return resp(200, { agent: 'hazel', role: state.role, rules, source, roots: ['/work/hazel', ...(a.policy && a.policy.roots || []).map(resolve)], overrides: ov, extraRoots: (a.policy && a.policy.roots) || [] });
    }
    if (/^\/api\/folders\?agent=hazel$/.test(url)) { const a = state.agents.find((x) => x.name === 'hazel'); return resp(200, { ok: true, folders: FOLDERS, granted: ((a.policy && a.policy.roots) || []).map(resolve) }); }
    if (url === '/api/sandbox/status') return resp(200, { ok: true, docker: true, imageReady: true, error: null, defaults: state.sandboxDefaults, containers: [] });
    if (url === '/api/lockbox/status') return resp(200, { ok: true, host: state.lockHost || { ok: true }, default: state.lockDefault, agents: state.agents.map((a) => ({ name: a.name, setting: a.lockbox || 'inherit', mode: a.lockbox || state.lockDefault, coverage: state.lockCoverage || 'covered' })) });
    if (/^\/api\/lockbox\/watch\?agent=hazel&limit=10$/.test(url)) return resp(200, state.blocked);
    return resp(404, { error: 'no route ' + url });
  };
  const records = over.records || ACCESS;
  const card = C.createCard({ doc, win, fetch, records: () => records, me: () => ('me' in over ? over.me : ADMIN), agentsList: () => JSON.parse(JSON.stringify(state.agents)), subscribe: () => () => {}, help: null, simple: false, phone: false, setTimeout: () => {} });
  const t = { card, doc, win, state, calls, confirms, yes: true, patches: () => calls.filter((c) => c.method === 'PATCH'), writes: () => calls.filter((c) => c.method !== 'GET') };
  return t;
}
async function openAt(t, id) { await t.card.open('hazel', { row: id }); await flush(); return rowOf(t.card.el(), id); }
const again = (t, id) => rowOf(t.card.el(), id);
const checks = (row) => all(row, 'input').filter((i) => i.getAttribute('type') === 'checkbox');
const labels = (s) => all(s, 'option').map((o) => o.textContent);

// ---- 1. registration -------------------------------------------------------------------------------------------------------
test('the module registers a live row for every Access record it owns, and they replace the door rows of ui-agent-card-more', () => {
  for (const id of ['OPT-0008', 'OPT-0009', 'OPT-0010', 'OPT-0011', 'OPT-0012', 'OPT-0013', 'OPT-0015', 'OPT-0017', 'OPT-0018', 'OPT-0053', 'OPT-0054', 'OPT-0055', 'OPT-0056']) {
    assert.ok(A.ROWS[id], id + ' has a row');
    assert.ok(ACCESS.some((r) => r.id === id), id + ' is a real record');
  }
  assert.deepStrictEqual(Object.values(A.CLASSES), ['web', 'read_outside', 'write_outside', 'send', 'admin', 'destroy']);
  const t = setup();
  assert.ok(t.card, 'the card builds with both modules loaded');
});

// ---- 2. the six permission classes ---------------------------------------------------------------------------------------------
test('a class row is a select with the role default word, Allow, Ask first and Never, and says what is in force and from where', async () => {
  const t = await (async () => { const x = setup(); await openAt(x, 'OPT-0008'); return x; })();
  const row = again(t, 'OPT-0008');
  assert.strictEqual(sel(row).value, 'ask');
  assert.deepStrictEqual(labels(sel(row)), ['Role default (allow)', 'Allow', 'Ask first', 'Never']);
  assert.match(row.textContent, /Right now: Asks you first, from this agent's own setting/);
  const w = await openAt(t, 'OPT-0010');
  assert.strictEqual(sel(w).value, '');
  assert.deepStrictEqual(labels(sel(w)), ['Role default (never)', 'Allow', 'Ask first', 'Never']);
  assert.match(w.textContent, /Right now: Never, from its role/);
  assert.strictEqual(t.writes().length, 0, 'reading changes nothing');
  assert.ok(t.calls.filter((c) => c.url === '/api/policy/hazel').length >= 1);
  assert.strictEqual(t.calls.filter((c) => c.url === '/api/policy/hazel').length, 1, 'one lazy read shared by the rows');
});

test('saving a class sends the overrides AND the roots together, then reads the policy again', async () => {
  const t = setup();
  const row = await openAt(t, 'OPT-0011');
  t.calls.length = 0;
  change(sel(row), 'ask');   // never -> ask: loosens, so it asks
  await flush();
  assert.strictEqual(t.confirms.length, 1);
  assert.deepStrictEqual(t.patches().map((c) => [c.url, c.body]), [['/api/agents/hazel', { policy: { overrides: { web: 'ask', send: 'ask' }, roots: ['/srv/common', '~/notes'] } }]]);
  assert.deepStrictEqual(t.state.agents[1].policy, { overrides: { web: 'ask', send: 'ask' }, roots: ['/srv/common', '~/notes'] }, 'the folders were not dropped');
  const after = t.calls.map((c) => c.url);
  assert.ok(after.lastIndexOf('/api/policy/hazel') > after.indexOf('/api/agents/hazel'), 'the policy is read again after the save');
  assert.strictEqual(sel(again(t, 'OPT-0011')).value, 'ask');
  assert.match(again(t, 'OPT-0011').textContent, /Right now: Asks you first/);
});

test('"Role default" removes only that override and keeps the others and the roots', async () => {
  const t = setup();
  t.state.agents[1].policy = { overrides: { web: 'ask', send: 'ask', destroy: 'deny' }, roots: ['/srv/common'] };
  const row = await openAt(t, 'OPT-0011');
  assert.strictEqual(sel(row).value, 'ask');
  t.calls.length = 0;
  change(sel(row), '');   // what is inherited is not 'allow' now, so clearing the override asks first (the role default is not what decides)
  await flush();
  assert.strictEqual(t.confirms.length, 1);
  assert.deepStrictEqual(t.patches().map((c) => c.body), [{ policy: { overrides: { web: 'ask', destroy: 'deny' }, roots: ['/srv/common'] } }]);
  assert.strictEqual(sel(again(t, 'OPT-0011')).value, '');
});

test('the confirm: towards allow asks (never to ask, never to allow, ask to allow, role default when it is looser); declining sends nothing and the row shows the old value again', async () => {
  const t = setup();
  let row = await openAt(t, 'OPT-0010');   // write outside: role default never
  t.yes = false;
  change(sel(row), 'allow');
  await flush();
  assert.strictEqual(t.confirms.length, 1);
  assert.match(t.confirms[0], /^Let Hazel change files outside its own folder without asking\?$/);
  assert.strictEqual(t.patches().length, 0, 'declined: no request');
  assert.strictEqual(sel(again(t, 'OPT-0010')).value, '', 'the old value shows again');
  t.yes = true;
  change(sel(again(t, 'OPT-0010')), 'ask');
  await flush();
  assert.match(t.confirms[1], /^Let Hazel change files outside its own folder, asking you first each time\?$/);
  assert.strictEqual(t.patches().length, 1);
  change(sel(again(t, 'OPT-0010')), 'allow');   // ask -> allow
  await flush();
  assert.strictEqual(t.confirms.length, 3);
  assert.strictEqual(t.patches().length, 2);
  // an explicit Never back to Role default (never): not looser, no confirm
  change(sel(again(t, 'OPT-0010')), 'deny');
  await flush();
  assert.strictEqual(t.confirms.length, 3, 'allow -> never is tighter');
  // never -> Role default (web: role default allow, the override is ask): looser
  row = await openAt(t, 'OPT-0009');   // read outside: role default allow
  change(sel(row), 'deny');
  await flush();
  assert.strictEqual(t.confirms.length, 3, 'allow -> never: no confirm');
  change(sel(again(t, 'OPT-0009')), '');   // never -> role default (allow): looser
  await flush();
  assert.strictEqual(t.confirms.length, 4);
  assert.match(t.confirms[3], /^Stop using this agent's own setting and use the inherited one\? It may let Hazel read files outside its own folder\.$/);
});

test('tightening a class saves without a confirm', async () => {
  const t = setup();
  const row = await openAt(t, 'OPT-0008');   // web is ask
  change(sel(row), 'deny');
  await flush();
  assert.strictEqual(t.confirms.length, 0);
  assert.deepStrictEqual(t.patches().map((c) => c.body), [{ policy: { overrides: { web: 'deny' }, roots: ['/srv/common', '~/notes'] } }]);
});

test('a member-owned agent: only web, read outside, write outside and send can be set; the others are read-only with the reason', async () => {
  const t = setup({ state: { role: 'member' } });
  for (const id of ['OPT-0012', 'OPT-0013']) {
    const row = await openAt(t, id);
    assert.strictEqual(all(row, 'select').length, 0, id + ' has no select');
    assert.match(row.textContent, /A member's agent can never be given this; it stays refused whatever is set\./);
  }
  for (const id of ['OPT-0008', 'OPT-0009', 'OPT-0010', 'OPT-0011']) {
    const row = await openAt(t, id);
    assert.strictEqual(all(row, 'select').length, 1, id + ' can be set');
  }
  assert.strictEqual(t.writes().length, 0);
});

test('OPT-0015 stays read-only and shows the live summary from the policy route', async () => {
  const t = setup();
  const row = await openAt(t, 'OPT-0015');
  assert.strictEqual(all(row, 'select').length + all(row, 'input').length, 0);
  assert.match(row.textContent, /Web: asks you first · Reading outside: allowed · Writing outside: never · Sending: never · Changing Maestro: never · Destroying: never/);
});

test('a class save refuses when the agent can not be read right now (nothing is sent that could drop the folders)', async () => {
  const t = setup();
  const row = await openAt(t, 'OPT-0008');
  t.state.failRoutes = { '/api/agents': { status: 500, json: { error: 'down' }, method: 'GET' } };
  t.calls.length = 0;
  change(sel(row), 'deny');
  await flush();
  assert.strictEqual(t.patches().length, 0);
  assert.match(again(t, 'OPT-0008').textContent, /nothing was changed/);
});

// ---- 3. folders ---------------------------------------------------------------------------------------------------------------
test('shared folders: checkboxes from the folders route, ticked through "granted"; a typed root is not a checkbox', async () => {
  const t = setup();
  const row = await openAt(t, 'OPT-0017');
  const boxes = checks(row);
  assert.deepStrictEqual(boxes.map((b) => [b.getAttribute('value'), b.checked]), [['/srv/common', true], ['/srv/team/ops', false], ['/srv/team/legal', false]]);
  assert.match(row.textContent, /Common files/);
  assert.match(row.textContent, /Ops team/);
  const typed = await openAt(t, 'OPT-0018');
  const ta = all(typed, 'textarea')[0];
  assert.strictEqual(ta.value, '~/notes', 'only the root that is not a checkbox');
});

test('adding a shared folder asks first; declining sends nothing and the box is unticked again; accepting saves the roots with the overrides', async () => {
  const t = setup();
  let row = await openAt(t, 'OPT-0017');
  t.yes = false; t.calls.length = 0;
  change(checks(row)[1], true);
  await flush();
  assert.strictEqual(t.confirms.length, 1);
  assert.match(t.confirms[0], /^Give Hazel write access to Ops team\?$/);
  assert.strictEqual(t.patches().length, 0, 'no request when declined');
  assert.strictEqual(checks(again(t, 'OPT-0017'))[1].checked, false, 'the old state shows again');
  t.yes = true;
  change(checks(again(t, 'OPT-0017'))[1], true);
  await flush();
  assert.strictEqual(t.confirms.length, 2);
  assert.deepStrictEqual(t.patches().map((c) => c.body), [{ policy: { overrides: { web: 'ask' }, roots: ['~/notes', '/srv/common', '/srv/team/ops'] } }]);
  assert.strictEqual(checks(again(t, 'OPT-0017'))[1].checked, true);
});

test('unticking a shared folder needs no confirm and keeps the typed roots', async () => {
  const t = setup();
  const row = await openAt(t, 'OPT-0017');
  t.calls.length = 0;
  change(checks(row)[0], false);
  await flush();
  assert.strictEqual(t.confirms.length, 0);
  assert.deepStrictEqual(t.patches().map((c) => c.body), [{ policy: { overrides: { web: 'ask' }, roots: ['~/notes'] } }]);
});

test('other folders: a typed path asks first, saves on blur with the ticked folders kept, and a too-long path is refused before any request', async () => {
  const t = setup();
  const row = await openAt(t, 'OPT-0018');
  const ta = all(row, 'textarea')[0];
  t.yes = false; t.calls.length = 0;
  ta.value = '~/notes\n/mnt/data';
  ta.dispatch('blur');
  await flush();
  assert.strictEqual(t.confirms.length, 1);
  assert.match(t.confirms[0], /^Give Hazel write access to \/mnt\/data\?$/);
  assert.strictEqual(t.patches().length, 0);
  assert.strictEqual(all(again(t, 'OPT-0018'), 'textarea')[0].value, '~/notes\n/mnt/data', 'a declined confirm keeps what was typed');
  assert.match(again(t, 'OPT-0018').textContent, /Not changed\./);
  t.yes = true;
  const ta2 = all(again(t, 'OPT-0018'), 'textarea')[0];
  ta2.value = '~/notes\n  /mnt/data  \n\n/mnt/data';
  ta2.dispatch('change'); ta2.dispatch('blur');
  await flush();
  assert.strictEqual(t.confirms.length, 2);
  assert.deepStrictEqual(t.patches().map((c) => c.body), [{ policy: { overrides: { web: 'ask' }, roots: ['/srv/common', '~/notes', '/mnt/data'] } }], 'one request: the checkbox folder kept, blank and repeated lines gone');
  t.calls.length = 0;
  const ta3 = all(again(t, 'OPT-0018'), 'textarea')[0];
  ta3.value = '/' + 'x'.repeat(400);
  ta3.dispatch('blur');
  await flush();
  assert.strictEqual(t.patches().length, 0);
  assert.match(again(t, 'OPT-0018').textContent, /shorter than 400 characters/);
});

test('removing a typed path needs no confirm', async () => {
  const t = setup();
  const row = await openAt(t, 'OPT-0018');
  const ta = all(row, 'textarea')[0];
  ta.value = '';
  ta.dispatch('blur');
  await flush();
  assert.strictEqual(t.confirms.length, 0);
  assert.deepStrictEqual(t.patches().map((c) => c.body), [{ policy: { overrides: { web: 'ask' }, roots: ['/srv/common'] } }]);
});

// ---- 4. the box ---------------------------------------------------------------------------------------------------------------------
test('box: the select names the default from the sandbox status; the row says where the agent runs now', async () => {
  const t = setup();
  const row = await openAt(t, 'OPT-0053');
  assert.deepStrictEqual(labels(sel(row)), ['Same as the default (outside a box)', 'In a box', 'Outside a box']);
  assert.match(row.textContent, /It runs outside a box now\./);
  t.state.sandboxDefaults = { member: 'container', admin: 'container' };
  const t2 = setup({ state: { sandboxDefaults: { member: 'container', admin: 'container' } } });
  const r2 = await openAt(t2, 'OPT-0053');
  assert.deepStrictEqual(labels(sel(r2)), ['Same as the default (in a box)', 'In a box', 'Outside a box']);
});

test('box: every change asks and says it restarts the session; an agent outside a box now gets the extra sentence; declining sends nothing', async () => {
  const t = setup();
  let row = await openAt(t, 'OPT-0053');
  t.yes = false;
  change(sel(row), 'container');
  await flush();
  assert.strictEqual(t.confirms.length, 1);
  assert.match(t.confirms[0], /This restarts Hazel's current session\./);
  assert.match(t.confirms[0], /Hazel runs outside a box now; boxing it restarts its session\./);
  assert.strictEqual(t.patches().length, 0);
  assert.strictEqual(sel(again(t, 'OPT-0053')).value, 'inherit', 'the old value shows again');
  t.yes = true;
  change(sel(again(t, 'OPT-0053')), 'container');
  await flush();
  assert.deepStrictEqual(t.patches().map((c) => c.body), [{ sandbox: 'container' }]);
  // tightening or not, a box change from a box asks too, without the "runs outside" sentence
  change(sel(again(t, 'OPT-0053')), 'inherit');   // default is outside a box: looser
  await flush();
  assert.strictEqual(t.confirms.length, 3);
  assert.match(t.confirms[2], /This restarts Hazel's current session\./);
  assert.doesNotMatch(t.confirms[2], /runs outside a box now/);
  assert.match(t.confirms[2], /directly on this computer/);
});

test('box: from a box to outside a box is a loosening and says so; the names come from the agent, nothing is hard-coded', async () => {
  const t = setup();
  t.state.agents[1].sandbox = 'container';
  t.state.agents[1].display = 'Juniper';
  const row = await openAt(t, 'OPT-0053');
  change(sel(row), 'off');
  await flush();
  assert.match(t.confirms[0], /^Run Juniper outside a box\? Its commands and file work would then run directly on this computer\. This restarts Juniper's current session\.$/);
  assert.deepStrictEqual(t.patches().map((c) => c.body), [{ sandbox: 'off' }]);
});

// ---- 5. the command lockbox ----------------------------------------------------------------------------------------------------------
test('lockbox: the select names the hub default; looser modes ask first, tighter ones do not', async () => {
  const t = setup();
  t.state.agents[1].lockbox = 'enforce';
  let row = await openAt(t, 'OPT-0054');
  assert.deepStrictEqual(labels(sel(row)), ['Same as the default (off)', 'Off', 'Watch (report only)', 'Enforce (block)']);
  assert.match(row.textContent, /Commands can write only in this agent's folders/);
  t.yes = false;
  change(sel(row), 'watch');   // enforce -> watch
  await flush();
  assert.strictEqual(t.confirms.length, 1);
  assert.strictEqual(t.patches().length, 0);
  assert.strictEqual(sel(again(t, 'OPT-0054')).value, 'enforce');
  t.yes = true;
  change(sel(again(t, 'OPT-0054')), 'off');
  await flush();
  assert.strictEqual(t.confirms.length, 2);
  assert.match(t.confirms[1], /^Turn the command lockbox off for Hazel\?/);
  assert.deepStrictEqual(t.patches().map((c) => c.body), [{ lockbox: 'off' }]);
  change(sel(again(t, 'OPT-0054')), 'enforce');   // tighter
  await flush();
  assert.strictEqual(t.confirms.length, 2, 'tightening: no confirm');
  assert.deepStrictEqual(t.patches().map((c) => c.body), [{ lockbox: 'off' }, { lockbox: 'enforce' }]);
});

test('lockbox: a 403 on the save shows the server\'s own text under the row, and the value goes back', async () => {
  const t = setup();
  const msg = 'Sign in with an admin account in your browser to change the command lockbox.';
  const row = await openAt(t, 'OPT-0054');
  t.state.failRoutes = { '/api/agents/hazel': { status: 403, json: { error: msg }, method: 'PATCH' } };
  change(sel(row), 'watch');
  await flush();
  assert.match(again(t, 'OPT-0054').textContent, new RegExp(msg.replace(/[.]/g, '\\.')));
  assert.strictEqual(sel(again(t, 'OPT-0054')).value, 'inherit');
  const env = await openAt(t, 'OPT-0055');
  change(all(env, 'input')[0], 'HOME_EXTRA, TOKEN_X');
  await flush();
  assert.match(again(t, 'OPT-0055').textContent, /Sign in with an admin account in your browser/);
});

test('lockbox: when the status route refuses (not the admin\'s own browser session) the rows are read-only with the server\'s message', async () => {
  const t = setup({ state: { failRoutes: { '/api/lockbox/status': { status: 403, json: { error: 'Only the signed-in admin\'s own browser may use the lockbox.' } }, '/api/lockbox/watch': { status: 403, json: { error: 'admin_only' } } } } });
  const row = await openAt(t, 'OPT-0054');
  assert.strictEqual(all(row, 'select').length, 0);
  assert.match(row.textContent, /Only the signed-in admin's own browser may use the lockbox\./);
  const t2 = setup({ state: { failRoutes: { '/api/lockbox/status': { status: 403, json: { error: 'admin_only' } } } } });
  const r2 = await openAt(t2, 'OPT-0055');
  assert.match(r2.textContent, /Sign in with an admin account in your browser/);
});

test('kept variables: a list of names saves PATCH {lockboxEnv}', async () => {
  const t = setup();
  t.state.agents[1].lockboxEnv = ['EDITOR'];
  const row = await openAt(t, 'OPT-0055');
  assert.strictEqual(all(row, 'input')[0].value, 'EDITOR');
  change(all(row, 'input')[0], 'EDITOR, PAGER');
  await flush();
  assert.deepStrictEqual(t.patches().map((c) => c.body), [{ lockboxEnv: ['EDITOR', 'PAGER'] }]);
});

test('recently blocked: the last lines from the watch route, or "Nothing blocked recently"', async () => {
  const t = setup({ state: { blocked: { entries: [
    { ts: '2026-11-25T14:00:00.000Z', rule: 'write-outside', path: '/etc/hosts', cmd: 'echo x >> /etc/hosts' },
    { ts: '2026-11-25T15:00:00.000Z', rule: 'secret-read', path: '/home/owner/.ssh/id_rsa' },
  ] } } });
  const row = await openAt(t, 'OPT-0056');
  assert.match(row.textContent, /write outside its folders/);
  assert.match(row.textContent, /\/etc\/hosts/);
  assert.match(row.textContent, /read a secret file/);
  assert.ok(t.calls.some((c) => c.url === '/api/lockbox/watch?agent=hazel&limit=10'));
  assert.strictEqual(t.writes().length, 0);
  const t2 = setup();
  assert.match((await openAt(t2, 'OPT-0056')).textContent, /Nothing blocked recently/);
});

// Ported from the old agent page's lockbox tests (lockbox-settings.test.js): the line under the select, the rules in words, the failures.
test('lockbox: the line under the select for each mode, the lead, and the coverage that replaces it', async () => {
  const enforce = 'Commands can write only in this agent\'s folders, can\'t read secret files, and can\'t use docker, systemd or other local services. Git over SSH and signed commits fail inside it.';
  const lineFor = async (setup0, agentName = 'hazel') => {
    const t = setup(setup0);
    const row = await openAt(t, 'OPT-0054');
    return row.textContent;
  };
  const withMode = (mode, extra = {}) => ({ state: { lockHost: extra.host, lockCoverage: extra.coverage, agents: (() => { const a = agentsFix(); a[1].lockbox = mode; return a; })() } });
  assert.ok((await lineFor(withMode('off'))).includes('Commands run as they do today.'));
  assert.ok((await lineFor(withMode('watch'))).includes('Commands run as today; anything the lockbox would have blocked is listed below.'));
  const e1 = await lineFor(withMode('enforce'));
  assert.ok(e1.includes(enforce) && !e1.includes('The lead needs sudo'));
  const lead = setup({ state: { agents: (() => { const a = agentsFix(); a[1].lead = true; a[1].lockbox = 'enforce'; return a; })() } });
  assert.ok((await openAt(lead, 'OPT-0054')).textContent.includes(enforce + ' The lead needs sudo for crontab, systemctl --user and docker.'));
  const leadWatch = setup({ state: { agents: (() => { const a = agentsFix(); a[1].lead = true; a[1].lockbox = 'watch'; return a; })() } });
  assert.ok(!(await openAt(leadWatch, 'OPT-0054')).textContent.includes('The lead needs sudo'));
  assert.ok((await lineFor(withMode('enforce', { coverage: 'container' }))).includes('This agent\'s commands already run in its own container.'));
  assert.ok((await lineFor(withMode('enforce', { coverage: 'codex-client' }))).includes('This agent uses Codex\'s own tools, which the lockbox can\'t box; switch it to the hub\'s hands.'));
  assert.ok((await lineFor(withMode('enforce', { coverage: 'unavailable', host: { ok: false, reason: 'Landlock not available' } }))).includes('Not available on this computer: Landlock not available.'));
});

test('recently blocked: each rule in words, an unknown rule as it is', async () => {
  const rules = ['write-outside', 'secret-read', 'unix-socket', 'io_uring', 'sudo-unconfined', 'watch-unavailable', 'toString'];
  const t = setup({ state: { blocked: { entries: rules.map((rule, i) => ({ ts: '2026-11-25T1' + i + ':00:00.000Z', rule, path: '/p' + i })) } } });
  const text = (await openAt(t, 'OPT-0056')).textContent;
  for (const w of ['write outside its folders', 'read a secret file', 'local socket', 'io_uring', 'ran with sudo, outside the box', 'watch not possible', 'toString']) assert.ok(text.includes(w), w);
});

test('lockbox: a failed or unreadable status check leaves the rows read-only and says why, never a guessed value', async () => {
  const cases = [
    [{ status: 500, json: { error: 'boom' } }, /boom|Not available/],
    [{ status: 404, json: { error: 'not found' } }, /not found|Not available/],
    [{ status: 401, json: { error: 'unauthorized' } }, /unauthorized|Not available/],
  ];
  for (const [fail, why] of cases) {
    const t = setup({ state: { failRoutes: { '/api/lockbox/status': fail } } });
    const row = await openAt(t, 'OPT-0054');
    assert.strictEqual(all(row, 'select').length, 0, JSON.stringify(fail) + ': nothing to change');
    assert.match(row.textContent, why);
    assert.doesNotMatch(row.textContent, /Checking…/);
    const env = await openAt(t, 'OPT-0055');
    assert.strictEqual(all(env, 'input').length, 0, 'kept variables are read-only too');
    assert.strictEqual(t.writes().length, 0);
  }
});

test('lockbox: a later good check brings the controls back', async () => {
  const t = setup({ state: { failRoutes: { '/api/lockbox/status': { status: 500, json: { error: 'boom' } } } } });
  assert.strictEqual(all(await openAt(t, 'OPT-0054'), 'select').length, 0);
  t.state.failRoutes = {};
  A.resetCache();
  assert.strictEqual(all(await openAt(t, 'OPT-0054'), 'select').length, 1);
});

// ---- review round 1 -------------------------------------------------------------------------------------------------------------------
test('G3/G4: every policy write sends policyIfMatch (the policy it was built from); a 409 reads everything again and shows the hub\'s words', async () => {
  const t = setup();
  const row = await openAt(t, 'OPT-0011');
  t.calls.length = 0;
  change(sel(row), 'allow');
  await flush();
  assert.deepStrictEqual(t.patches().map((c) => c.ifMatch), [{ overrides: { web: 'ask' }, roots: ['/srv/common', '~/notes'] }], 'a class save');
  t.calls.length = 0;
  const fr = await openAt(t, 'OPT-0017');
  checks(fr)[1].checked = true; checks(fr)[1].dispatch('change');
  await flush();
  assert.strictEqual(t.patches().length, 1);
  assert.deepStrictEqual(t.patches()[0].ifMatch, { overrides: { web: 'ask', send: 'allow' }, roots: ['/srv/common', '~/notes'] }, 'a folders save');
  // someone else revokes the folder just before the next save: the request is refused, nothing is written, the card reads again
  t.state.racing = (a) => { a.policy = { overrides: { web: 'ask', send: 'allow' } }; };
  t.calls.length = 0;
  change(sel(await openAt(t, 'OPT-0008')), 'deny');
  await flush();
  assert.strictEqual(t.patches().length, 1);
  assert.deepStrictEqual(t.state.agents[1].policy, { overrides: { web: 'ask', send: 'allow' } }, 'nothing was written over the other change');
  const urls = t.calls.map((c) => c.url);
  assert.ok(urls.lastIndexOf('/api/policy/hazel') > urls.indexOf('/api/agents/hazel'), 'the policy is read again');
  assert.ok(urls.lastIndexOf('/api/folders?agent=hazel') > urls.indexOf('/api/agents/hazel'), 'the folders are read again');
  assert.ok(urls.lastIndexOf('/api/agents') > urls.indexOf('/api/agents/hazel'), 'the agent is read again');
  assert.match(again(t, 'OPT-0008').textContent, /permissions were changed elsewhere/);
  assert.strictEqual(sel(again(t, 'OPT-0008')).value, 'ask', 'the row shows what the hub has');
});

test('G1: a failed folder-list read keeps the draft and sends nothing (the ticked folders would be dropped)', async () => {
  const t = setup();
  const row = await openAt(t, 'OPT-0018');
  t.state.failRoutes = { '/api/folders': { status: 500, json: { error: 'boom' } } };
  t.calls.length = 0;
  const ta = all(row, 'textarea')[0];
  ta.value = '~/notes\n/mnt/data';
  ta.dispatch('blur');
  await flush();
  assert.strictEqual(t.patches().length, 0);
  assert.strictEqual(t.confirms.length, 0);
  assert.match(again(t, 'OPT-0018').textContent, /Could not read the folder list just now, so nothing was changed/);
  assert.strictEqual(all(again(t, 'OPT-0018'), 'textarea')[0].value, '~/notes\n/mnt/data', 'the typed text stays');
});

test('G2: clearing an override asks unless what is in force now is already allow', async () => {
  const t = setup();
  t.state.agents[1].policy = { overrides: { web: 'allow', send: 'deny' }, roots: ['/srv/common'] };
  let row = await openAt(t, 'OPT-0008');   // web: allowed now
  change(sel(row), '');
  await flush();
  assert.strictEqual(t.confirms.length, 0, 'allow now: nothing can get looser');
  assert.strictEqual(t.patches().length, 1);
  t.yes = false;
  row = await openAt(t, 'OPT-0011');   // send: never now, the role may say otherwise
  t.calls.length = 0;
  change(sel(row), '');
  await flush();
  assert.strictEqual(t.confirms.length, 1);
  assert.match(t.confirms[0], /Hazel send things off this computer/);
  assert.strictEqual(t.patches().length, 0);
  assert.match(again(t, 'OPT-0011').textContent, /Not changed\./, 'S4: a declined row says so');
  assert.strictEqual(sel(again(t, 'OPT-0011')).value, 'deny');
});

test('S3: a permission row is read-only until the policy was read, with the reason', async () => {
  const t = setup({ state: { failRoutes: { '/api/policy/': { status: 500, json: { error: 'no policy' } } } } });
  const row = await openAt(t, 'OPT-0008');
  assert.strictEqual(all(row, 'select').length, 0);
  assert.match(row.textContent, /Could not read the permissions: no policy/);
  assert.strictEqual(t.writes().length, 0);
});

test('G5: adding kept variables asks first and names them; a decline sends nothing; removing needs no confirm; the lockbox status is read again', async () => {
  const t = setup();
  t.state.agents[1].lockboxEnv = ['EDITOR'];
  const row = await openAt(t, 'OPT-0055');
  t.yes = false; t.calls.length = 0;
  change(all(row, 'input')[0], 'EDITOR, PAGER, TOKEN');
  await flush();
  assert.strictEqual(t.confirms.length, 1);
  assert.match(t.confirms[0], /PAGER, TOKEN/);
  assert.doesNotMatch(t.confirms[0], /EDITOR/);
  assert.strictEqual(t.patches().length, 0);
  assert.match(again(t, 'OPT-0055').textContent, /Not changed\./);
  t.yes = true;
  change(all(again(t, 'OPT-0055'), 'input')[0], 'EDITOR, PAGER');
  await flush();
  assert.deepStrictEqual(t.patches().map((c) => c.body), [{ lockboxEnv: ['EDITOR', 'PAGER'] }]);
  assert.ok(t.calls.map((c) => c.url).lastIndexOf('/api/lockbox/status') > t.calls.map((c) => c.url).indexOf('/api/agents/hazel'));
  const n = t.confirms.length;
  change(all(again(t, 'OPT-0055'), 'input')[0], 'EDITOR');
  await flush();
  assert.strictEqual(t.confirms.length, n, 'removing a name needs no confirm');
});

test('S5: an unknown lockbox default counts as off (switching to watch is not a loosening)', async () => {
  const t = setup({ state: { lockDefault: 'strange' } });
  t.state.agents[1].lockbox = 'enforce';
  const row = await openAt(t, 'OPT-0054');
  change(sel(row), 'inherit');   // enforce -> the unknown default (off): a loosening, asks
  await flush();
  assert.strictEqual(t.confirms.length, 1);
  assert.match(t.confirms[0], /Turn the command lockbox off/);
});

// ---- 6. members -----------------------------------------------------------------------------------------------------------------------
test('members never get the Access section, and nothing of it is read', async () => {
  const t = setup({ me: MEMBER });
  t.state.agents[1].owner = 'sam';
  await t.card.open('hazel');
  await flush();
  const secs = all(t.card.el(), '.ac-sec').map((s) => s.getAttribute('data-sec'));
  assert.ok(!secs.includes('access'), secs.join(','));
  assert.ok(!t.calls.some((c) => /\/api\/(policy|folders|sandbox|lockbox)/.test(c.url)), 'no Access data is read for a member');
  assert.strictEqual(t.writes().length, 0);
});
