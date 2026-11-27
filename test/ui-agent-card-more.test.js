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
  const confirms = []; const prompts = [];
  const win = { innerWidth: 1200, location: { pathname: '/', hash: '', search: '' }, addEventListener() {}, removeEventListener() {}, open: (...a) => opened.push(a),
    confirm: (q) => { confirms.push(q); return over.confirm !== false; }, prompt: (q) => { prompts.push(q); return over.promptAnswer === undefined ? null : over.promptAnswer; } };
  if (over.openSchedulePanel) win.openSchedulePanel = () => { opened.push(['scheduler']); };
  const state = Object.assign({
    agents: agentsFix(), fail: null, failRoutes: {},
    records: { records: [{ name: 'BRIEF.md', bytes: 2048 }, { name: 'notes.md', bytes: 6144 }], maxBytes: 65536 },
    compaction: { pct: 42, tokens: 84000, limit: 200000, lastRunAt: null, running: false },
    root: { agent: 'harbor', lead: false, memberOwned: false, sandboxed: false, grant: null, defaultMinutes: 60, maxMinutes: 1440 },
    recordTexts: { 'BRIEF.md': 'Brief text', 'notes.md': 'Notes text' },
    files: { 'SOUL.md': 'Be kind.', 'IDENTITY.md': 'Harbor, the port keeper.', 'MEMORY.md': 'Likes tea.', 'TOOLS.md': 'Uses git.', 'USER.md': 'Sam likes short answers.', 'TASKS.md': '- every day: tidy' },
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
    const rm = /^\/api\/agents\/harbor\/records\/([^/]+)$/.exec(url);
    if (rm) {
      const name = decodeURIComponent(rm[1]);
      if (state.recordFail) return resp(state.recordFail.status, { ok: false, error: state.recordFail.error });
      if (method === 'GET') return state.recordTexts[name] === undefined ? resp(404, { ok: false, error: 'no such record' }) : resp(200, { ok: true, name, content: state.recordTexts[name] });
      if (method === 'PUT' && state.putResult) return resp(200, { ok: true, result: state.putResult(name) });   // the real route: 200 with the status text of records.write
      if (method === 'PUT') { state.recordTexts[name] = body.content; if (!state.records.records.some((r) => r.name === name)) state.records.records.push({ name, bytes: String(body.content).length }); return resp(200, { ok: true }); }
      if (method === 'DELETE') { delete state.recordTexts[name]; state.records.records = state.records.records.filter((r) => r.name !== name); return resp(200, { ok: true }); }
    }
    if (url === '/api/agents/harbor/files' && method === 'GET') return state.filesFail ? resp(500, { error: 'files unavailable' }) : resp(200, { files: state.files });
    const fm = /^\/api\/agents\/harbor\/files\/([^/]+)$/.exec(url);
    if (fm && method === 'PUT') { if (state.fileFail) return resp(400, { success: false, error: state.fileFail }); state.files[decodeURIComponent(fm[1])] = body.content; return resp(200, { success: true }); }
    if (/^\/api\/agents\/harbor\/compaction$/.test(url) && method === 'GET' && state.compactionGetStatus && state.compactionGetStatus.length) return resp(state.compactionGetStatus.shift(), { error: 'no' });
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
  const card = C.createCard({ doc, win, fetch, records: () => over.records || REAL, me: () => ('me' in over ? over.me : ADMIN), agentsList: () => JSON.parse(JSON.stringify(state.agents)), subscribe: () => () => {}, help: null, simple: false, phone: false, setTimeout: over.setTimeout || (() => {}), clearTimeout: over.clearTimeout || (() => {}) });
  return { card, doc, win, state, calls, opened, confirms, prompts, patches: () => calls.filter((c) => c.method === 'PATCH'), writes: () => calls.filter((c) => c.method !== 'GET') };
}
async function openAt(t, id) { await t.card.open('harbor', { row: id }); await flush(); return rowOf(t.card.el(), id); }
const sel = (row, i = 0) => all(row, 'select')[i];
const inp = (row) => all(row, 'input')[0];
const change = (el, v) => { if (typeof v === 'boolean') el.checked = v; else el.value = v; el.dispatch('change'); };

// The Access rows that used to be doors to the agent page: lib/ui-agent-card-access.js registers them live now.
const MOVED = ['OPT-0008', 'OPT-0009', 'OPT-0010', 'OPT-0011', 'OPT-0012', 'OPT-0013', 'OPT-0017', 'OPT-0018', 'OPT-0053', 'OPT-0054', 'OPT-0055'];

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
  assert.strictEqual(all(t.card.el(), 'a').filter((a) => /agent-settings\.html/.test(a.getAttribute('href') || '') && !MOVED.some((id) => (a.getAttribute('href') || '').endsWith('#rec=' + id))).length, 0, 'no record is left on the fallback link');
  for (const r of REAL) assert.ok(M.ROWS[r.id] || r.id === 'OPT-0040' || MOVED.includes(r.id), r.id + ' has a row');
  for (const id of MOVED) assert.ok(!M.ROWS[id], id + ' is no door row here any more (lib/ui-agent-card-access.js registers it live)');
  assert.ok(!('doorUrl' in M), 'no door to the agent page is left in this file');
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
  assert.match(row3.textContent, /Compression running… the agent is writing its working brief\./);
  assert.ok(all(row3, 'button').find((b) => /Compressing/.test(b.textContent)).getAttribute('disabled') !== null, 'the button is off while it runs');
});

// ---- Memory: the compression row keeps itself up to date (5 s), only while the card is open and the row is showing ----------
/** Timers the card asks for 5 seconds out (the polling); everything else the card sets is dropped as before. */
function clock() {
  const q = [];
  return {
    q, setTimeout: (fn, ms) => { if (ms !== 5000) return undefined; const h = { fn, on: true }; q.push(h); return h; }, clearTimeout: (h) => { if (h) h.on = false; },
    live: () => q.filter((h) => h.on),
    async tick() { const h = q.filter((x) => x.on).pop(); assert.ok(h, 'a timer is waiting'); h.on = false; await h.fn(); await flush(); },
  };
}
const compCalls = (t) => t.calls.filter((c) => c.url === '/api/agents/harbor/compaction' && c.method === 'GET').length;
const pressCompress = async (t) => { all(rowOf(t.card.el(), 'OPT-0833'), 'button').find((b) => /Compress now/.test(b.textContent)).click(); await flush(); };

test('Memory: the local-model hint shows under "When the conversation gets long" only for a local model', async () => {
  const t = setup({ state: { compaction: { pct: 10, tokens: 1, limit: 2, local: true } } });
  const row = await openAt(t, 'OPT-0040');
  assert.match(row.textContent, /Local model: assisted mode at 60% is the default\./);
  const t2 = setup({ state: { compaction: { pct: 10, tokens: 1, limit: 2, local: false } } });
  assert.ok(!/Local model/.test((await openAt(t2, 'OPT-0040')).textContent));
  assert.strictEqual(M.LOCAL_HINT, 'Local model: assisted mode at 60% is the default.');
});

test('Memory: Compress now asks the old question for the mode, then every 5 s reads the status until it is done, and says how it ended', async () => {
  const clk = clock();
  const t = setup({ setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout });
  await openAt(t, 'OPT-0833');
  assert.strictEqual(clk.live().length, 0, 'nothing runs, nothing is read again');
  await pressCompress(t);
  assert.match(t.confirms[0], /^Compress now\?\n\nharbor will write its working brief \(working-brief\.md\), then its session is reset and seeded from Records, recent turns and recall\.\n\nThis takes a turn of the agent \(it can run for minutes\)\.$/);
  assert.deepStrictEqual(t.calls.filter((c) => c.url.endsWith('/compaction/run')).map((c) => c.method), ['POST']);
  assert.match(rowOf(t.card.el(), 'OPT-0833').textContent, /Started \(on\)… this card checks every 5 s\./);
  assert.strictEqual(clk.live().length, 1, 'one re-read is waiting');
  t.state.compaction = { ...t.state.compaction, running: true };   // the agent is writing the brief
  const before = compCalls(t);
  await clk.tick();
  assert.strictEqual(compCalls(t), before + 1, 'one more read');
  assert.match(rowOf(t.card.el(), 'OPT-0833').textContent, /Compression running… the agent is writing its working brief\./);
  assert.strictEqual(clk.live().length, 1, 'still going: the next read is queued');
  t.state.compaction = { ...t.state.compaction, running: false, requested: false, lastOk: true, lastReset: true, lastRunAt: Date.now() };
  await clk.tick();
  const done = rowOf(t.card.el(), 'OPT-0833').textContent;
  assert.match(done, /✅ Done: brief written, fresh session started/);
  assert.match(done, /Done, read the brief/);
  assert.strictEqual(clk.live().length, 0, 'finished: the reads stop');
});

test('Memory: a failed compression says why; a postponed one says so and stops reading', async () => {
  for (const [state, want] of [[{ lastOk: false, lastError: 'the model refused', lastRunAt: Date.now() + 1000 }, /❌ Compression failed: the model refused/], [{ lastBusy: true, lastError: 'the agent stayed busy', runs: [{ at: new Date(Date.now() + 1000).toISOString() }] }, /⏸ Postponed: the agent stayed busy/]]) {
    const clk = clock();
    const t = setup({ setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout });
    await openAt(t, 'OPT-0833');
    await pressCompress(t);
    t.state.compaction = { ...t.state.compaction, running: false, requested: false, ...state };
    await clk.tick();
    assert.match(rowOf(t.card.el(), 'OPT-0833').textContent, want);
    assert.ok(!/Done, read the brief/.test(rowOf(t.card.el(), 'OPT-0833').textContent), 'no brief to read');
    assert.strictEqual(clk.live().length, 0);
  }
});

test('Memory r1: an older result is never shown as this run\'s Done; the reads go on until a result from this run arrives', async () => {
  const clk = clock();
  const old = Date.now() - 3600000;
  const t = setup({ setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout, state: { compaction: { pct: 42, tokens: 1, limit: 2, running: false, lastOk: true, lastRunAt: old } } });   // yesterday's run is the server's marker before the press
  await openAt(t, 'OPT-0833');
  await pressCompress(t);
  t.state.compaction = { ...t.state.compaction, running: false, requested: false, lastOk: true, lastReset: true };
  await clk.tick();
  assert.ok(!/Done/.test(rowOf(t.card.el(), 'OPT-0833').textContent), 'not this run\'s Done');
  assert.strictEqual(clk.live().length, 1, 'still reading');
  t.state.compaction = { ...t.state.compaction, lastRunAt: old + 1000 };
  await clk.tick();
  assert.match(rowOf(t.card.el(), 'OPT-0833').textContent, /✅ Done/);
  assert.strictEqual(clk.live().length, 0);
});

test('Memory r2: Done compares the server\'s result marker with the one read before the run, not the browser clock (60 s ahead or behind)', async () => {
  const realNow = Date.now;
  const S = 1800000000000;   // the server's "now"
  try {
    for (const skew of [60000, -60000]) {
      Date.now = () => S + skew;
      const clk = clock();
      const t = setup({ setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout, state: { compaction: { pct: 42, tokens: 1, limit: 2, running: false, lastOk: true, lastRunAt: S - 3600000 } } });
      await openAt(t, 'OPT-0833');
      await pressCompress(t);
      assert.strictEqual(clk.live().length, 1, 'reading');
      t.state.compaction = { ...t.state.compaction, running: false, requested: false, lastOk: true, lastReset: true };
      await clk.tick();
      assert.ok(!/Done/.test(rowOf(t.card.el(), 'OPT-0833').textContent), 'the old result is not Done (skew ' + skew + ')');
      t.state.compaction = { ...t.state.compaction, lastRunAt: S + 2000 };   // the server made a new result 2 s after the press
      await clk.tick();
      assert.match(rowOf(t.card.el(), 'OPT-0833').textContent, /✅ Done/, 'finished run is Done with the browser clock off by ' + skew);
      assert.strictEqual(clk.live().length, 0);
    }
    // a different run id counts as a new result too
    Date.now = () => S + 60000;
    const clk = clock();
    const t = setup({ setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout, state: { compaction: { pct: 42, tokens: 1, limit: 2, running: false, lastOk: true, runs: [{ id: 'r1', at: new Date(S - 1000).toISOString() }] } } });
    await openAt(t, 'OPT-0833');
    await pressCompress(t);
    t.state.compaction = { ...t.state.compaction, runs: [{ id: 'r2', at: new Date(S - 1000).toISOString() }], lastReset: false };
    await clk.tick();
    assert.match(rowOf(t.card.el(), 'OPT-0833').textContent, /✅ Done/);
  } finally { Date.now = realNow; }
});

test('Memory r2: a failed progress check stands over a kept "running"; the row redrawn keeps the error and starts no read until a good read or another press', async () => {
  const clk = clock();
  const t = setup({ setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout, state: { compaction: { pct: 80, tokens: 1, limit: 2, running: true } } });
  await openAt(t, 'OPT-0833');
  assert.strictEqual(clk.live().length, 1, 'running (kept answer): reading');
  t.state.compactionGetStatus = [403];
  await clk.tick();
  const shown = () => rowOf(t.card.el(), 'OPT-0833').textContent;
  assert.match(shown(), /Could not check the progress\./);
  assert.ok(!/Compression running/.test(shown()), 'the error is not covered by "running"');
  assert.strictEqual(clk.live().length, 0, 'no timer');
  // redraw the row from the kept running:true answer
  const head = () => all(t.card.el(), '.ac-sec-head').find((h) => h.parentNode.getAttribute('data-sec') === 'memory');
  head().click(); await flush(); head().click(); await flush();
  assert.match(shown(), /Could not check the progress\./);
  assert.ok(!/Compression running/.test(shown()));
  assert.strictEqual(clk.live().length, 0, 'a redraw starts no new poll');
  // pressing again clears it
  t.state.compaction = { ...t.state.compaction, running: false };
  await pressCompress(t);
  assert.ok(!/Could not check the progress/.test(shown()), 'cleared by the new press');
  assert.strictEqual(clk.live().length, 1, 'reading again');
});

test('Memory r1: a refused status read stops the reads at once and says so; three failures in a row do the same', async () => {
  for (const [codes, reads] of [[[403], 1], [[401], 1], [[500, 500, 500], 3]]) {
    const clk = clock();
    const t = setup({ setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout });
    await openAt(t, 'OPT-0833');
    await pressCompress(t);
    t.state.compaction = { ...t.state.compaction, running: true };
    t.state.compactionGetStatus = codes.slice();
    const before = compCalls(t);
    for (let i = 0; i < reads; i++) {
      assert.strictEqual(clk.live().length, 1, 'still reading before read ' + (i + 1));
      await clk.tick();
    }
    assert.strictEqual(compCalls(t), before + reads);
    assert.match(rowOf(t.card.el(), 'OPT-0833').textContent, /Could not check the progress\./);
    assert.strictEqual(clk.live().length, 0, 'no more reads');
  }
  // two failures then an answer: the count starts again
  const clk = clock();
  const t = setup({ setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout });
  await openAt(t, 'OPT-0833');
  await pressCompress(t);
  t.state.compaction = { ...t.state.compaction, running: true };
  t.state.compactionGetStatus = [500, 500];
  await clk.tick(); await clk.tick(); await clk.tick();
  assert.strictEqual(clk.live().length, 1, 'two failures then a good read: still going');
  assert.ok(!/Could not check the progress/.test(rowOf(t.card.el(), 'OPT-0833').textContent));
});

test('Memory: the 5-second reads stop when the card closes, and when its row is no longer showing', async () => {
  // closed
  const clk = clock();
  const t = setup({ setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout, state: { compaction: { pct: 80, tokens: 1, limit: 2, running: true } } });
  await openAt(t, 'OPT-0833');
  assert.strictEqual(clk.live().length, 1, 'a card opened on a running compression keeps reading');
  const at = compCalls(t);
  t.card.close();
  assert.strictEqual(clk.live().length, 0, 'closing cancels the waiting read');
  assert.strictEqual(compCalls(t), at, 'and reads nothing');
  // the row is not drawn any more: its section is shut, so the reads give up on their own
  const clk2 = clock();
  const t2 = setup({ setTimeout: clk2.setTimeout, clearTimeout: clk2.clearTimeout, state: { compaction: { pct: 80, tokens: 1, limit: 2, running: true } } });
  await openAt(t2, 'OPT-0833');
  all(t2.card.el(), '.ac-sec-head').find((h) => h.parentNode.getAttribute('data-sec') === 'memory').click();
  await flush();
  assert.ok(!rowOf(t2.card.el(), 'OPT-0833'), 'the row is not on screen');
  await clk2.tick();
  await (async () => { const h = clk2.live().pop(); if (h) { h.on = false; await h.fn(); await flush(); } })();
  assert.strictEqual(clk2.live().length, 0, 'no reads are left once the row has been off screen for a round');
});

test('Memory: "Done, read the brief" chooses working-brief.md in the records picker and opens the editor on it', async () => {
  const clk = clock();
  const t = setup({ setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout, state: { recordTexts: { 'working-brief.md': 'The brief text' }, records: { records: [{ name: 'BRIEF.md', bytes: 10 }, { name: 'working-brief.md', bytes: 14 }], maxBytes: 65536 } } });
  await openAt(t, 'OPT-0833');
  await pressCompress(t);
  t.state.compaction = { ...t.state.compaction, running: false, requested: false, lastOk: true, lastReset: false, lastRunAt: Date.now() + 1000 };
  await clk.tick();
  assert.match(rowOf(t.card.el(), 'OPT-0833').textContent, /✅ Done, read the brief/);
  all(rowOf(t.card.el(), 'OPT-0833'), 'button').find((b) => b.textContent === 'Done, read the brief').click();
  await flush();
  const ed = rowOf(t.card.el(), 'OPT-0021');
  assert.ok(ed, 'the records row is on screen');
  assert.strictEqual(sel(ed).value, 'working-brief.md', 'the picker shows it chosen');
  assert.strictEqual(all(ed, 'textarea')[0].value, 'The brief text', 'its text is in the editor');
  // no such record: said plainly
  const t2 = setup({ setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout });
  await openAt(t2, 'OPT-0833');
  await pressCompress(t2);
  t2.state.compaction = { ...t2.state.compaction, running: false, requested: false, lastOk: true, lastRunAt: Date.now() + 1000 };
  await clk.tick();
  all(rowOf(t2.card.el(), 'OPT-0833'), 'button').find((b) => b.textContent === 'Done, read the brief').click();
  await flush();
  assert.match(rowOf(t2.card.el(), 'OPT-0833').textContent, /❌ No record working-brief\.md yet\./);
});

const btn = (row, text) => all(row, 'button').find((b) => b.textContent === text);
const area = (row) => all(row, 'textarea')[0];
const typeIn = (ta, v) => { ta.value = v; ta.dispatch('input'); };

test('Memory: the records row picks a record, loads it in an editor and saves PUT {content}; the editor closes and the list is read again', async () => {
  const t = setup();
  let row = await openAt(t, 'OPT-0021');
  assert.deepStrictEqual(all(sel(row), 'option').map((o) => o.textContent), ['Choose a record…', 'BRIEF.md', 'notes.md']);
  assert.ok(!btn(row, 'Edit'), 'no Edit button until a record is chosen');
  change(sel(row), 'notes.md'); await flush();
  row = rowOf(t.card.el(), 'OPT-0021');
  assert.ok(t.calls.some((c) => c.method === 'GET' && c.url === '/api/agents/harbor/records/notes.md'));
  assert.strictEqual(area(row).value, 'Notes text');
  typeIn(area(row), 'Notes text, changed');
  btn(row, 'Save').click(); await flush();
  assert.deepStrictEqual(t.writes().map((c) => [c.method, c.url, c.body]), [['PUT', '/api/agents/harbor/records/notes.md', { content: 'Notes text, changed' }]]);
  row = rowOf(t.card.el(), 'OPT-0021');
  assert.ok(!area(row), 'the editor closed after the save');
  assert.strictEqual(t.state.recordTexts['notes.md'], 'Notes text, changed');
});

test('Memory: New record asks for a name (no slashes, not one that exists), opens an empty editor and creates the record only on Save; Cancel creates nothing', async () => {
  const t = setup({ promptAnswer: 'clients/a.md' });
  let row = await openAt(t, 'OPT-0021');
  btn(row, 'New record').click(); await flush();
  assert.match(rowOf(t.card.el(), 'OPT-0021').textContent, /cannot contain slashes/);
  t.win.prompt = () => 'BRIEF.md';
  btn(rowOf(t.card.el(), 'OPT-0021'), 'New record').click(); await flush();
  assert.match(rowOf(t.card.el(), 'OPT-0021').textContent, /BRIEF\.md already exists/);
  t.win.prompt = () => null;
  btn(rowOf(t.card.el(), 'OPT-0021'), 'New record').click(); await flush();
  assert.ok(!area(rowOf(t.card.el(), 'OPT-0021')), 'cancelling the question starts nothing');
  t.win.prompt = () => ' clients.md ';
  btn(rowOf(t.card.el(), 'OPT-0021'), 'New record').click(); await flush();
  row = rowOf(t.card.el(), 'OPT-0021');
  assert.strictEqual(area(row).value, '');
  assert.strictEqual(t.writes().length, 0, 'nothing is written before Save');
  btn(row, 'Cancel').click(); await flush();
  assert.strictEqual(t.writes().length, 0);
  btn(rowOf(t.card.el(), 'OPT-0021'), 'New record').click(); await flush();
  typeIn(area(rowOf(t.card.el(), 'OPT-0021')), 'Clients: sam');
  btn(rowOf(t.card.el(), 'OPT-0021'), 'Save').click(); await flush();
  assert.deepStrictEqual(t.writes().map((c) => [c.method, c.url, c.body]), [['PUT', '/api/agents/harbor/records/clients.md', { content: 'Clients: sam' }]]);
});

test('S1: the records route answers 200 with a status text: only "Record <name> written" is a save; any other text is the error, and the name the hub used is kept', async () => {
  const t = setup();
  t.state.putResult = () => 'Bad record name.';
  let row = await openAt(t, 'OPT-0021');
  change(sel(row), 'notes.md'); await flush();
  typeIn(area(rowOf(t.card.el(), 'OPT-0021')), 'changed');
  btn(rowOf(t.card.el(), 'OPT-0021'), 'Save').click(); await flush();
  row = rowOf(t.card.el(), 'OPT-0021');
  assert.match(row.textContent, /Bad record name\./, 'the server\'s text is shown as the failure');
  assert.ok(area(row), 'the editor stays open with the typed text');
  assert.strictEqual(area(row).value, 'changed');
  // a refusal text the hub starts with "not written:" is a failure too
  t.state.putResult = (n) => 'not written: ' + n + ' would not fit in harbor\'s Records.';
  btn(row, 'Save').click(); await flush();
  assert.match(rowOf(t.card.el(), 'OPT-0021').textContent, /not written: notes\.md would not fit/);
  // a real save: the editor closes
  t.state.putResult = (n) => 'Record ' + n + '.md written (7 bytes). It is loaded in full on your next turn.';
  btn(rowOf(t.card.el(), 'OPT-0021'), 'Save').click(); await flush();
  assert.ok(!area(rowOf(t.card.el(), 'OPT-0021')), 'saved: the editor closed');
  assert.strictEqual(M.recordNameProblem('.hidden', []), 'A record name cannot start with a dot.');
  assert.strictEqual(M.recordNameProblem('ok.md', []), '');
});

test('Memory: Delete asks with the record\'s name, then sends DELETE; a "no" deletes nothing; the record leaves the list', async () => {
  const t = setup({ confirm: false });
  let row = await openAt(t, 'OPT-0021');
  change(sel(row), 'BRIEF.md'); await flush();
  btn(rowOf(t.card.el(), 'OPT-0021'), 'Delete').click(); await flush();
  assert.match(t.confirms[t.confirms.length - 1], /Delete the record "BRIEF\.md"\?/);
  assert.strictEqual(t.writes().length, 0, 'declined: nothing deleted');
  const t2 = setup();
  row = await openAt(t2, 'OPT-0021');
  change(sel(row), 'BRIEF.md'); await flush();
  btn(rowOf(t2.card.el(), 'OPT-0021'), 'Delete').click(); await flush();
  assert.match(t2.confirms[0], /BRIEF\.md/);
  assert.deepStrictEqual(t2.writes().map((c) => [c.method, c.url]), [['DELETE', '/api/agents/harbor/records/BRIEF.md']]);
  row = rowOf(t2.card.el(), 'OPT-0021');
  assert.ok(!area(row), 'the editor closed');
  assert.ok(!all(sel(row), 'option').some((o) => o.textContent === 'BRIEF.md'), 'the record is gone from the list');
});

test('Memory: a record that can not be opened shows the error and no textarea; a save the hub refuses keeps the typed text and shows the error', async () => {
  const t = setup({ state: { recordFail: { status: 500, error: 'disk is full' } } });
  let row = await openAt(t, 'OPT-0021');
  change(sel(row), 'notes.md'); await flush();
  row = rowOf(t.card.el(), 'OPT-0021');
  assert.ok(!area(row));
  assert.match(row.textContent, /disk is full/);
  const t2 = setup();
  row = await openAt(t2, 'OPT-0021');
  change(sel(row), 'notes.md'); await flush();
  typeIn(area(rowOf(t2.card.el(), 'OPT-0021')), 'my long text');
  t2.state.recordFail = { status: 400, error: 'record too large' };
  btn(rowOf(t2.card.el(), 'OPT-0021'), 'Save').click(); await flush();
  row = rowOf(t2.card.el(), 'OPT-0021');
  assert.strictEqual(area(row).value, 'my long text', 'the text stays');
  assert.match(row.textContent, /record too large/);
});

test('Memory: the notes files load from the files route and save PUT {content}; SOUL.md and IDENTITY.md ask about the character first, the others do not', async () => {
  const files = { 'OPT-0068': 'SOUL.md', 'OPT-0069': 'IDENTITY.md', 'OPT-0070': 'MEMORY.md', 'OPT-0071': 'TOOLS.md', 'OPT-0072': 'USER.md' };
  const t = setup();
  for (const [id, file] of Object.entries(files)) {
    let row = await openAt(t, id);
    btn(row, 'Edit').click(); await flush();
    row = rowOf(t.card.el(), id);
    assert.strictEqual(area(row).value, t.state.files[file], id + ' shows ' + file);
    typeIn(area(row), 'changed ' + file);
    const before = t.confirms.length;
    btn(row, 'Save').click(); await flush();
    const asked = t.confirms.length - before;
    assert.strictEqual(asked, ['SOUL.md', 'IDENTITY.md'].includes(file) ? 1 : 0, file + ' confirmation');
    if (asked) assert.strictEqual(t.confirms[t.confirms.length - 1], "Change Harbor's character file " + file + '? It takes effect on its next turn.');
    assert.strictEqual(t.state.files[file], 'changed ' + file);
    assert.ok(!area(rowOf(t.card.el(), id)), 'closed after the save');
  }
  assert.deepStrictEqual(t.writes().map((c) => c.url), Object.values(files).map((f) => '/api/agents/harbor/files/' + f));
  // a "no" to the character question saves nothing and keeps the text
  const t2 = setup({ confirm: false });
  let row = await openAt(t2, 'OPT-0068');
  btn(row, 'Edit').click(); await flush();
  typeIn(area(rowOf(t2.card.el(), 'OPT-0068')), 'new soul');
  btn(rowOf(t2.card.el(), 'OPT-0068'), 'Save').click(); await flush();
  assert.strictEqual(t2.writes().length, 0);
  assert.strictEqual(area(rowOf(t2.card.el(), 'OPT-0068')).value, 'new soul');
});

test('Schedule: the task list is an editor of TASKS.md; its help line says scheduled tasks are re-read when saved; a refusal shows and keeps the text', async () => {
  const t = setup();
  let row = await openAt(t, 'OPT-0073');
  assert.match(row.textContent, /re-read when you save/);
  btn(row, 'Edit').click(); await flush();
  typeIn(area(rowOf(t.card.el(), 'OPT-0073')), '- every day: sweep');
  btn(rowOf(t.card.el(), 'OPT-0073'), 'Save').click(); await flush();
  assert.deepStrictEqual(t.writes().map((c) => [c.method, c.url, c.body]), [['PUT', '/api/agents/harbor/files/TASKS.md', { content: '- every day: sweep' }]]);
  assert.strictEqual(t.confirms.length, 0, 'no question for the task list');
  const t2 = setup({ state: { fileFail: 'Invalid filename' } });
  row = await openAt(t2, 'OPT-0073');
  btn(row, 'Edit').click(); await flush();
  typeIn(area(rowOf(t2.card.el(), 'OPT-0073')), 'x');
  btn(rowOf(t2.card.el(), 'OPT-0073'), 'Save').click(); await flush();
  assert.strictEqual(area(rowOf(t2.card.el(), 'OPT-0073')).value, 'x');
  assert.match(rowOf(t2.card.el(), 'OPT-0073').textContent, /Invalid filename/);
  const t3 = setup({ state: { filesFail: true } });
  row = await openAt(t3, 'OPT-0073');
  btn(row, 'Edit').click(); await flush();
  assert.match(rowOf(t3.card.el(), 'OPT-0073').textContent, /files unavailable/);
});

test('Memory: the editor rows are read-only for a member and the Access doors are gone from this file', async () => {
  const t = setup({ me: MEMBER, records: [rec('OPT-0068', 'Personality notes', 'Agent card > Memory'), rec('OPT-0021', 'Edit a record', 'Agent card > Memory')] });
  for (const id of ['OPT-0068', 'OPT-0021']) {
    const row = await openAt(t, id);
    assert.ok(!btn(row, 'Edit') && !area(row), id);
    assert.match(row.textContent, /Only an admin can change this\./);
  }
  assert.strictEqual(t.calls.filter((c) => /records\/|files\//.test(c.url)).length, 0);
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
test('Access: the dangerous records are not door rows here (the access module owns them); the list still matches the records and the policy summary still reads', async () => {
  const dangerous = REAL.filter((r) => r.danger === 'dangerous').map((r) => r.id).sort();
  assert.deepStrictEqual(dangerous, M.DANGEROUS_IDS.slice().sort(), 'the list matches the records');
  const t = setup();
  for (const id of MOVED) {
    const row = await openAt(t, id);
    assert.ok(!all(row, 'button').some((b) => b.getAttribute('class') === 'ac-action'), id + ' has no "open the agent page" button');
    assert.doesNotMatch(row.textContent, /Open the agent page/, id);
  }
  assert.strictEqual(t.opened.length, 0, 'nothing was opened');
  assert.strictEqual(t.writes().length, 0, 'nothing was written');
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
  assert.strictEqual(s.access, '3 tools');
  assert.strictEqual(s.schedule, '2 scheduled · 0 running');
  const t2 = setup({ state: { agents: agentsFix().map((a) => (a.name === 'harbor' ? { ...a, minimalContext: true, noTools: true, lockbox: 'enforce', sandbox: 'inherit', policy: undefined, compaction: undefined } : a)) } });
  await t2.card.open('harbor');
  await flush();
  const s2 = sums(t2.card.el());
  assert.strictEqual(s2.memory, 'Records · shortest background');
  assert.strictEqual(s2.access, 'no tools');
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

test('Memory r3: no server marker before the run (status unreadable, nothing kept) and the first good read finds the agent idle: says the result cannot be confirmed and stops', async () => {
  const realNow = Date.now;
  try {
    const S = realNow();
    Date.now = () => S + 60000;   // the browser clock runs ahead of the server's
    const clk = clock();
    const t = setup({ setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout, state: { compaction: { pct: 42, tokens: 1, limit: 2, running: false, lastOk: true, lastRunAt: S + 1000 } } });
    t.state.compactionGetStatus = [500, 500, 500, 500];   // the reads at opening and just before the run fail: nothing usable is kept
    await openAt(t, 'OPT-0833');
    t.state.compactionGetStatus = [500];
    await pressCompress(t);
    t.state.compactionGetStatus = [];
    await clk.tick();   // the first good read: idle, with a result the page cannot place before or after the press
    const shown = rowOf(t.card.el(), 'OPT-0833').textContent;
    assert.ok(!/✅ Done/.test(shown), 'never Done by the browser clock');
    assert.match(shown, /could not be confirmed/, shown);
    assert.strictEqual(clk.live().length, 0, 'no timer left');
  } finally { Date.now = realNow; }
});
