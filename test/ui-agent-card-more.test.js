'use strict';
// lib/ui-agent-card-more.js: the Memory, Access and Schedule and background work rows of the agent card. The real card runs against
// a small fake DOM and a fake hub (no browser, no server); every row's read and save is checked against the route and body it uses.
// Offline; reads no data/.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const C = require('../lib/ui-agent-card.js');
const M = require('../lib/ui-agent-card-more.js');
const RECORDS_ALL = JSON.parse(fs.readFileSync(path.join(root, 'templates/settings-records.json'), 'utf8'));
const REAL = (Array.isArray(RECORDS_ALL) ? RECORDS_ALL : RECORDS_ALL.records).filter((r) => /^Agent card > (Memory|Access|Schedule and background work)/.test(r.home || ''));

// ---- a fake DOM (as in test/ui-agent-card.test.js) -----------------------------------------------------------------------
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
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
const all = (p, sel) => p.querySelectorAll(sel);
const rowOf = (p, id) => all(p, '.ac-row').find((r) => r.getAttribute('data-ac-row') === id);
const sums = (p) => Object.fromEntries(all(p, '.ac-sec').map((s) => [s.getAttribute('data-sec'), all(s, '.ac-sec-sum')[0].textContent]));

// ---- fixtures ------------------------------------------------------------------------------------------------------------
const ADMIN = { isAdmin: true, user: { id: 'u1' } };
const MEMBER = { isAdmin: false, user: { id: 'u2' } };
const resp = (status, json) => ({ ok: status < 300, status, json: async () => json });
const agentsFix = () => [
  { name: 'maestro', display: 'Maestro', lead: true, owner: null, sharedWith: [], model: 'claude-sdk/opus' },
  { name: 'harbor', display: 'Harbor', owner: 'u2', sharedWith: [], model: 'claude-sdk/sonnet', sandbox: 'container', lockbox: 'watch', toolWhitelist: ['read', 'write', 'web'], policy: { roots: ['/srv/shared'], overrides: { web: 'ask' } }, compaction: { mode: 'on', at: 0.7 }, maxContextMessages: 40, tools: 'inherit' },
];
const rec = (id, name, home, who) => ({ id, kind: 'setting', name, home, who: who || 'admin', what: name + ' does a thing. A second sentence.' });

function setup(over = {}) {
  M.resetCache();
  const doc = makeDoc();
  const opened = [];
  const win = { innerWidth: 1200, location: { pathname: '/', hash: '', search: '' }, addEventListener() {}, removeEventListener() {}, open: (...a) => opened.push(a) };
  if (over.openSchedulePanel) win.openSchedulePanel = () => { opened.push(['scheduler']); };
  const state = Object.assign({
    agents: agentsFix(), fail: null, failRoutes: {},
    records: { records: [{ name: 'BRIEF.md', bytes: 2048 }, { name: 'notes.md', bytes: 6144 }], maxBytes: 65536 },
    compaction: { pct: 42, tokens: 84000, limit: 200000, lastRunAt: null, running: false },
    root: { agent: 'harbor', lead: false, memberOwned: false, sandboxed: false, grant: null, defaultMinutes: 60, maxMinutes: 1440 },
    blocked: { entries: [] }, runStatus: 202,
    tasks: { tasks: [{ id: 't1', agent: 'harbor', status: 'active', nextRunAt: '2026-12-01T14:00:00.000Z' }, { id: 't2', agent: 'harbor', status: 'active', nextRunAt: '2026-12-02T14:00:00.000Z' }, { id: 't3', agent: 'quill', status: 'active', nextRunAt: '2026-12-01T10:00:00.000Z' }], tasksMd: [] },
    work: { ok: true, count: 0, handOffs: [], jobs: [], jobCount: 0, workers: [] },
  }, over.state || {});
  const calls = [];
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET'; const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method, body });
    for (const [pat, r] of Object.entries(state.failRoutes)) if (url.includes(pat)) return resp(r.status, r.json);
    if (url === '/api/agents' && method === 'GET') return resp(200, JSON.parse(JSON.stringify(state.agents)));
    const pm = /^\/api\/agents\/([^/]+)$/.exec(url);
    if (pm && method === 'PATCH') {
      if (state.fail) return resp(400, { error: state.fail });
      const a = state.agents.find((x) => x.name === pm[1]);
      for (const [k, v] of Object.entries(body)) {
        if (v === null) delete a[k];
        else if (k === 'compaction' && v && typeof v === 'object') {   // the server merges it (null removes a key)
          const next = { ...(a[k] || {}) }; for (const [k2, v2] of Object.entries(v)) { if (v2 === null) delete next[k2]; else next[k2] = v2; }
          if (Object.keys(next).length) a[k] = next; else delete a[k];
        } else a[k] = v;
      }
      return resp(200, { ok: true });
    }
    if (/^\/api\/agents\/harbor\/records$/.test(url)) return resp(200, { ok: true, ...state.records });
    if (/^\/api\/agents\/harbor\/compaction$/.test(url)) return resp(200, { ok: true, ...state.compaction });
    if (/^\/api\/agents\/harbor\/compaction\/run$/.test(url)) return resp(state.runStatus, state.runStatus === 409 ? { error: 'already running' } : { ok: true, started: true });
    if (/^\/api\/root-grants\?agent=harbor$/.test(url)) return resp(200, { ok: true, ...state.root });
    if (url === '/api/root-grants' && method === 'POST') { state.root.grant = { agent: 'harbor', until: '2026-12-01T15:00:00.000Z', minutes: body.minutes }; return resp(200, { ok: true, grant: state.root.grant }); }
    if (url === '/api/root-grants/harbor' && method === 'DELETE') { state.root.grant = null; return resp(200, { ok: true, revoked: true }); }
    if (/^\/api\/lockbox\/watch\?agent=harbor/.test(url)) return resp(200, state.blocked);
    if (url === '/api/scheduled-tasks') return resp(200, state.tasks);
    if (/^\/api\/agents\/harbor\/working-on$/.test(url)) return resp(200, state.work);
    return resp(404, { error: 'no route ' + url });
  };
  const card = C.createCard({ doc, win, fetch, records: () => over.records || REAL, me: () => ('me' in over ? over.me : ADMIN), agentsList: () => JSON.parse(JSON.stringify(state.agents)), subscribe: () => () => {}, help: null, simple: false, phone: false, setTimeout: () => {} });
  return { card, doc, win, state, calls, opened, patches: () => calls.filter((c) => c.method === 'PATCH'), writes: () => calls.filter((c) => c.method !== 'GET') };
}
async function openAt(t, id) { await t.card.open('harbor', { row: id }); await flush(); return rowOf(t.card.el(), id); }
const sel = (row, i = 0) => all(row, 'select')[i];
const inp = (row) => all(row, 'input')[0];
const change = (el, v) => { if (typeof v === 'boolean') el.checked = v; else el.value = v; el.dispatch('change'); };

// ---- 1. registration and first rows ---------------------------------------------------------------------------------------
test('every record of Memory, Access and Schedule has a registered row (nothing falls back to the "Change it on the agent page" link), and the first rows are set', async () => {
  assert.ok(REAL.length >= 45);
  const t = setup();
  await t.card.open('harbor');
  for (const s of ['memory', 'access', 'schedule']) {
    const head = all(t.card.el(), '.ac-sec-head').find((h) => h.parentNode.getAttribute('data-sec') === s);
    head.click();
    const more = all(all(t.card.el(), '.ac-sec').find((x) => x.getAttribute('data-sec') === s), '.ac-more-head')[0];
    if (more) more.click();
  }
  await flush();
  assert.strictEqual(all(t.card.el(), 'a').filter((a) => /agent-settings\.html/.test(a.getAttribute('href') || '')).length, 0, 'no record is left on the fallback link');
  for (const r of REAL) assert.ok(M.ROWS[r.id] || r.id === 'OPT-0040', r.id + ' has a row');
  assert.deepStrictEqual(M.FIRST_ROWS.memory, ['OPT-0019', 'OPT-0040', 'OPT-0043', 'OPT-0833']);
  assert.deepStrictEqual(C.FIRST_ROWS.memory, M.FIRST_ROWS.memory);
  assert.deepStrictEqual(C.FIRST_ROWS.access, M.FIRST_ROWS.access);
  assert.deepStrictEqual(C.FIRST_ROWS.schedule, M.FIRST_ROWS.schedule);
  const ids = new Set(REAL.map((r) => r.id));
  for (const k of Object.keys(M.FIRST_ROWS)) for (const id of M.FIRST_ROWS[k]) assert.ok(ids.has(id), id + ' is a real record');
});

// ---- 2. Memory ---------------------------------------------------------------------------------------------------------------
test('Memory: records show their count and size; memory fullness and the last compression come from the compaction route', async () => {
  const t = setup();
  const r19 = await openAt(t, 'OPT-0019');
  assert.match(r19.textContent, /2 records/);
  const r43 = rowOf(t.card.el(), 'OPT-0043');
  assert.match(r43.textContent, /42% full \(84,000 of 200,000 tokens\)/);
  assert.ok(t.calls.some((c) => c.url === '/api/agents/harbor/records') && t.calls.some((c) => c.url === '/api/agents/harbor/compaction'));
  const r20 = await openAt(t, 'OPT-0020');
  assert.match(r20.textContent, /8 KB of 64 KB/);
  assert.match((await openAt(t, 'OPT-0044')).textContent, /Never/);
  assert.match((await openAt(t, 'OPT-0183')).textContent, /Context 42% full/);
  assert.match((await openAt(t, 'OPT-0882')).textContent, /42% context/);
  assert.strictEqual(t.writes().length, 0, 'reading changes nothing');
});

test('Memory: the number rows save PATCH {field: number} and refuse a number outside the range before any call; "Use default again" sends null', async () => {
  const cases = [['OPT-0065', 'maxContextMessages', '60', 60, '500'], ['OPT-0067', 'contextBudget', '300000', 300000, '1000'], ['OPT-0042', 'contextWindow', '100000', 100000, '10'], ['OPT-0081', 'recordsMaxBytes', '8192', 8192, '10']];
  for (const [id, field, typed, sent, bad] of cases) {
    const t = setup();
    const row = await openAt(t, id);
    change(inp(row), bad);
    await flush();
    assert.strictEqual(t.patches().length, 0, id + ': out of range is not sent');
    assert.match(rowOf(t.card.el(), id).textContent, /Enter a whole number/);
    change(inp(rowOf(t.card.el(), id)), typed);
    await flush();
    assert.deepStrictEqual(t.patches().map((c) => [c.url, c.body]), [['/api/agents/harbor', { [field]: sent }]], id);
    assert.strictEqual(t.state.agents[1][field], sent);
  }
  const t = setup();
  const row = await openAt(t, 'OPT-0065');
  assert.ok(!/Using the default/.test(row.textContent), 'it has its own value (40)');
  all(row, '.ac-reset')[0].click();
  await flush();
  assert.deepStrictEqual(t.patches().map((c) => c.body), [{ maxContextMessages: null }]);
  assert.match(rowOf(t.card.el(), 'OPT-0065').textContent, /Using the default for all agents/);
});

test('Memory: "How full before it acts" saves the threshold and keeps the mode; the empty choice drops only the threshold; compression mode stays the card\'s own row', async () => {
  const t = setup();
  const row = await openAt(t, 'OPT-0041');
  assert.strictEqual(sel(row).value, '0.7');
  assert.deepStrictEqual(all(sel(row), 'option').map((o) => o.textContent), ['Same as all agents', '50%', '55%', '60%', '65%', '70%', '75%', '80%', '85%', '90%']);
  change(sel(row), '0.85');
  await flush();
  assert.deepStrictEqual(t.patches().map((c) => c.body), [{ compaction: { at: 0.85 } }], 'only the threshold is sent');
  change(sel(rowOf(t.card.el(), 'OPT-0041')), '');
  await flush();
  assert.deepStrictEqual(t.patches()[1].body, { compaction: { at: null } }, 'null drops only the threshold');
  assert.deepStrictEqual(t.state.agents[1].compaction, { mode: 'on' });
  assert.match(rowOf(t.card.el(), 'OPT-0041').textContent, /Using the default for all agents/);
  assert.ok(!t.writes().some((c) => c.method === 'PUT'), 'never the admin-only PUT route');
});

test('Memory: the threshold save sends only {at}, so a mode changed elsewhere is not overwritten', async () => {
  const t = setup();
  const row = await openAt(t, 'OPT-0041');
  t.state.agents[1].compaction = { mode: 'off', at: 0.7 };   // changed elsewhere; the card still shows "on"
  t.calls.length = 0;
  change(sel(row), '0.85');
  await flush();
  assert.deepStrictEqual(t.patches().map((c) => c.body), [{ compaction: { at: 0.85 } }]);
  assert.deepStrictEqual(t.state.agents[1].compaction, { mode: 'off', at: 0.85 });
});

test('Memory: the shortest-background switch saves {minimalContext}; Compress now posts to the run route and says so plainly when it is already running', async () => {
  const t = setup();
  const sw = all(await openAt(t, 'OPT-0077'), 'input')[0];
  change(sw, true);
  await flush();
  assert.deepStrictEqual(t.patches().map((c) => c.body), [{ minimalContext: true }]);
  const row = await openAt(t, 'OPT-0833');
  assert.match(row.textContent, /Compress now/);
  all(row, 'button').find((b) => /Compress now/.test(b.textContent)).click();
  await flush();
  const runs = t.calls.filter((c) => c.url === '/api/agents/harbor/compaction/run');
  assert.deepStrictEqual(runs.map((c) => c.method), ['POST']);
  const t2 = setup({ state: { runStatus: 409 } });
  const row2 = await openAt(t2, 'OPT-0833');
  all(row2, 'button').find((b) => /Compress now/.test(b.textContent)).click();
  await flush();
  assert.match(rowOf(t2.card.el(), 'OPT-0833').textContent, /It is already being compressed\./);
  const t3 = setup({ state: { compaction: { pct: 80, tokens: 1, limit: 2, running: true } } });
  const row3 = await openAt(t3, 'OPT-0833');
  assert.match(row3.textContent, /Compressing…/);
  assert.match(row3.textContent, /This can not be changed from here right now\./);
});

test('Memory: the notes files and the record editor open the agent page at their record (a new tab), without saving anything', async () => {
  const t = setup();
  for (const id of ['OPT-0021', 'OPT-0068', 'OPT-0069', 'OPT-0070', 'OPT-0071', 'OPT-0072']) {
    const row = await openAt(t, id);
    all(row, 'button').find((b) => b.getAttribute('class') === 'ac-action').click();
    await flush();
    assert.strictEqual(t.opened[t.opened.length - 1][0], '/agent-settings.html?agent=harbor#rec=' + id);
  }
  assert.strictEqual(t.writes().length, 0);
});

// ---- 3. members -----------------------------------------------------------------------------------------------------------------
test('a member gets Memory only: Access and Schedule are not drawn and nothing is read for them; the "both" limits are live, an admin record is read-only', async () => {
  const recs = [rec('OPT-0065', 'Past messages it reads', 'Agent card > Memory', 'both'), rec('OPT-0042', 'Size of its working memory', 'Agent card > Memory', 'admin'), rec('OPT-0064', 'Tools it can use', 'Agent card > Access'), rec('OPT-0736', 'Scheduled tasks', 'Agent card > Schedule and background work')];
  const t = setup({ me: MEMBER, records: recs });
  const live = await openAt(t, 'OPT-0065');
  assert.deepStrictEqual(all(t.card.el(), '.ac-sec').map((s) => s.getAttribute('data-sec')), ['memory']);
  assert.ok(!t.calls.some((c) => /root-grants|lockbox|scheduled-tasks|working-on/.test(c.url)), 'no admin data is read for a member');
  change(inp(live), '25');
  await flush();
  assert.deepStrictEqual(t.patches().map((c) => c.body), [{ maxContextMessages: 25 }]);
  const ro = await openAt(t, 'OPT-0042');
  assert.strictEqual(all(ro, 'input').length, 0);
  assert.match(ro.textContent, /Only an admin can change this\./);
  // an admin-only door: a member never gets the button
  const t2 = setup({ me: MEMBER, records: [rec('OPT-0068', 'Personality notes', 'Agent card > Memory')] });
  const r = await openAt(t2, 'OPT-0068');
  assert.strictEqual(all(r, 'button').filter((b) => b.getAttribute('class') === 'ac-action').length, 0);
  assert.match(r.textContent, /Only an admin can change this\./);
});

// ---- 4. Access ------------------------------------------------------------------------------------------------------------------
test('Access: every dangerous record is read-only on the card with "Change it on the agent page" and a button to its door; none ever writes', async () => {
  const dangerous = REAL.filter((r) => r.danger === 'dangerous').map((r) => r.id).sort();
  assert.deepStrictEqual(dangerous, M.DANGEROUS_IDS.slice().sort(), 'the list matches the records');
  const t = setup();
  const checked = [];
  for (const id of dangerous) {
    const r = REAL.find((x) => x.id === id);
    if (r.kind === 'indicator') continue;
    const row = await openAt(t, id);
    assert.match(row.textContent, /Change it on the agent page\./, id);
    assert.strictEqual(all(row, 'input').length + all(row, 'select').length, 0, id + ' has no editing control');
    all(row, 'button').find((b) => b.getAttribute('class') === 'ac-action').click();
    await flush();
    assert.strictEqual(t.opened[t.opened.length - 1][0], '/agent-settings.html?agent=harbor#rec=' + id, id);
    checked.push(id);
  }
  assert.strictEqual(checked.length, 11);
  assert.strictEqual(t.writes().length, 0, 'nothing was written');
  assert.match((await openAt(t, 'OPT-0008')).textContent, /Asks you first/);
  assert.match((await openAt(t, 'OPT-0009')).textContent, /Follows its role/);
  assert.match((await openAt(t, 'OPT-0017')).textContent, /1 folder beyond its own/);
  assert.match((await openAt(t, 'OPT-0018')).textContent, /\/srv\/shared/);
  assert.match((await openAt(t, 'OPT-0053')).textContent, /Kept in its own box/);
  assert.match((await openAt(t, 'OPT-0054')).textContent, /Only reports what it would block/);
  assert.match((await openAt(t, 'OPT-0015')).textContent, /1 power of 6 set/);
});

test('Access: the lockbox log row reads the watch route; a refusal is shown plainly', async () => {
  const t = setup({ state: { blocked: { entries: [{ line: 'a' }, { line: 'b' }] } } });
  assert.match((await openAt(t, 'OPT-0056')).textContent, /2 recent lines in the lockbox log/);
  const t2 = setup({ state: { failRoutes: { '/api/lockbox/watch': { status: 403, json: { error: 'admin_only' } } } } });
  assert.match((await openAt(t2, 'OPT-0056')).textContent, /Only an admin can change this\./);
});

test('Access: tools it can use is a select for Claude Code and Codex agents only, saves PATCH {tools}, and is fixed while the agent is boxed', async () => {
  const t = setup({ state: { agents: agentsFix().map((a) => (a.name === 'harbor' ? { ...a, sandbox: 'inherit' } : a)) } });
  const row = await openAt(t, 'OPT-0064');
  assert.deepStrictEqual(all(sel(row), 'option').map((o) => o.textContent), ['Same as all agents', 'Maestro\'s tools', 'Its own tools']);
  change(sel(row), 'hub');
  await flush();
  assert.deepStrictEqual(t.patches().map((c) => c.body), [{ tools: 'hub' }]);
  all(rowOf(t.card.el(), 'OPT-0064'), '.ac-reset')[0].click();
  await flush();
  assert.deepStrictEqual(t.patches()[1].body, { tools: 'inherit' });
  const boxed = setup();
  const r2 = await openAt(boxed, 'OPT-0064');
  assert.strictEqual(all(r2, 'select').length, 0);
  assert.match(r2.textContent, /Kept in its box, so it uses Maestro's tools\./);
  const other = setup({ state: { agents: agentsFix().map((a) => (a.name === 'harbor' ? { ...a, model: 'openrouter/some-model' } : a)) } });
  await other.card.open('harbor', { section: 'access' });
  await flush();
  assert.strictEqual(rowOf(other.card.el(), 'OPT-0064'), undefined, 'not drawn for a model that always uses Maestro\'s tools');
});

test('Access: only-these-tools, no-tools and the commands\' settings save their fields; the server\'s refusal is shown plainly', async () => {
  const t = setup();
  change(inp(await openAt(t, 'OPT-0078')), 'read, web ,');
  await flush();
  assert.deepStrictEqual(t.patches().map((c) => c.body), [{ toolWhitelist: ['read', 'web'] }]);
  all(rowOf(t.card.el(), 'OPT-0078'), '.ac-reset')[0].click();
  await flush();
  assert.deepStrictEqual(t.patches()[1].body, { toolWhitelist: null });
  change(all(await openAt(t, 'OPT-0079'), 'input')[0], true);
  await flush();
  assert.deepStrictEqual(t.patches()[2].body, { noTools: true });
  t.state.fail = 'only an admin can change: envKeep';
  change(inp(await openAt(t, 'OPT-0080')), 'HOME_DIR, TOKEN_NAME');
  await flush();
  assert.deepStrictEqual(t.patches()[3].body, { envKeep: ['HOME_DIR', 'TOKEN_NAME'] });
  assert.match(rowOf(t.card.el(), 'OPT-0080').textContent, /only an admin can change: envKeep/);
});

test('Access: administrator access grants with POST {agent, minutes} and revokes with DELETE; the reasons it can not be given are said plainly', async () => {
  const t = setup();
  const row = await openAt(t, 'OPT-0016');
  assert.deepStrictEqual(all(sel(row), 'option').map((o) => o.textContent), ['Not given', 'For 15 minutes', 'For 1 hour', 'For 4 hours', 'For 24 hours']);
  change(sel(row), '60');
  await flush();
  const post = t.calls.find((c) => c.url === '/api/root-grants' && c.method === 'POST');
  assert.deepStrictEqual(post.body, { agent: 'harbor', minutes: 60 });
  assert.match(rowOf(t.card.el(), 'OPT-0016').textContent, /Given until/);
  change(sel(rowOf(t.card.el(), 'OPT-0016')), '');
  await flush();
  assert.ok(t.calls.some((c) => c.url === '/api/root-grants/harbor' && c.method === 'DELETE'));
  assert.match(rowOf(t.card.el(), 'OPT-0016').textContent, /Not given/);
  for (const [flag, words] of [['lead', /always has administrator access/], ['memberOwned', /member's agent never gets/], ['sandboxed', /switch the box off first/]]) {
    const x = setup({ state: { root: { agent: 'harbor', lead: false, memberOwned: false, sandboxed: false, grant: null, [flag]: true } } });
    const r = await openAt(x, 'OPT-0016');
    assert.match(r.textContent, words, flag);
    assert.strictEqual(all(r, 'select').length, 0);
  }
  const refused = setup({ state: { failRoutes: { '/api/root-grants?agent=': { status: 403, json: { error: 'admin_only' } } } } });
  assert.match((await openAt(refused, 'OPT-0016')).textContent, /Only an admin can change this\./);
  const bad = setup();
  const r = await openAt(bad, 'OPT-0016');
  bad.state.failRoutes['/api/root-grants'] = { status: 400, json: { error: 'this agent\'s shell runs inside a container' } };
  change(sel(r), '15');
  await flush();
  assert.match(rowOf(bad.card.el(), 'OPT-0016').textContent, /runs inside a container/);
});

// ---- 5. Schedule and background work -----------------------------------------------------------------------------------------------
test('Schedule: the agent\'s own scheduled tasks (count, next run) and background work are read-only rows with a button to the scheduler; the scheduler\'s form fields are not drawn', async () => {
  const t = setup({ openSchedulePanel: true, state: { work: { ok: true, count: 3, handOffs: [{ state: 'running' }], jobs: [], jobCount: 1, workers: [{ id: 'w1' }] } } });
  const r = await openAt(t, 'OPT-0736');
  assert.match(r.textContent, /2 tasks scheduled · next run /);
  assert.ok(!/quill/i.test(r.textContent));
  all(r, 'button').find((b) => b.getAttribute('class') === 'ac-action').click();
  await flush();
  assert.deepStrictEqual(t.opened[t.opened.length - 1], ['scheduler']);
  const w = await openAt(t, 'OPT-0742');
  assert.match(w.textContent, /3 running · 1 hand-off · 1 job · 1 worker/);
  assert.strictEqual(t.writes().length, 0);
  await t.card.open('harbor', { section: 'schedule' });
  const mb = all(t.card.el(), '.ac-more-head')[0]; mb.click();
  const shown = all(t.card.el(), '.ac-row').map((x) => x.getAttribute('data-ac-row'));
  assert.deepStrictEqual(shown.sort(), ['OPT-0073', 'OPT-0736', 'OPT-0742']);
  const none = setup();
  assert.match((await openAt(none, 'OPT-0736')).textContent, /Scheduled tasks/);
  all(rowOf(none.card.el(), 'OPT-0736'), 'button').find((b) => b.getAttribute('class') === 'ac-action').click();
  await flush();
  assert.match(rowOf(none.card.el(), 'OPT-0736').textContent, /task scheduler is on the desktop page/);
});

// ---- 6. summaries ------------------------------------------------------------------------------------------------------------------
test('the section summaries follow the mockup', async () => {
  const t = setup({ state: { work: { ok: true, count: 0, handOffs: [], jobs: [], jobCount: 0, workers: [] } } });
  await t.card.open('harbor');
  await flush();
  const s = sums(t.card.el());
  assert.strictEqual(s.memory, 'Records · compression on · recall on');
  assert.strictEqual(s.access, '3 tools · 1 folder · kept in its own box · commands watched');
  assert.strictEqual(s.schedule, '2 scheduled · 0 running');
  const t2 = setup({ state: { agents: agentsFix().map((a) => (a.name === 'harbor' ? { ...a, minimalContext: true, noTools: true, lockbox: 'enforce', sandbox: 'inherit', policy: undefined, compaction: undefined } : a)) } });
  await t2.card.open('harbor');
  await flush();
  const s2 = sums(t2.card.el());
  assert.strictEqual(s2.memory, 'Records · shortest background');
  assert.strictEqual(s2.access, 'no tools · commands blocked');
});

test('a member\'s card reads nothing for the Access and Schedule summaries', async () => {
  const t = setup({ me: MEMBER });
  await t.card.open('harbor');
  await flush();
  assert.ok(!t.calls.some((c) => /root-grants|lockbox|scheduled-tasks|working-on/.test(c.url)));
  assert.deepStrictEqual(all(t.card.el(), '.ac-sec').map((s) => s.getAttribute('data-sec')), ['basics', 'memory'].filter((k) => k === 'memory'));
});

// ---- 7. the file --------------------------------------------------------------------------------------------------------------------
test('the file has no invisible characters, sets nothing as HTML, names no real person and is served with the other card scripts', () => {
  const src = fs.readFileSync(path.join(root, 'lib/ui-agent-card-more.js'), 'utf8');
  assert.ok(!new RegExp('[' + String.fromCharCode(0xfe0f, 0x200d) + ']').test(src));
  assert.ok(!/innerHTML|insertAdjacentHTML|document\.write/.test(src));
  assert.ok(!/#[0-9a-fA-F]{6}\b/.test(src), 'no colour in the script');
});
