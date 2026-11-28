'use strict';
// lib/ui-agent-card.js: the agent card's frame (sections from the records, the row contract, who sees what, saving, live updates,
// the door). The real functions run against a small fake DOM (no browser); the page wiring is pinned with source checks.
// Offline; reads no data/.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const C = require('../lib/ui-agent-card.js');

// ---- a fake DOM (as in test/ui-settings-help.test.js) ---------------------------------------------------------------
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
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
  get id() { return this.attrs.id || ''; }
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
  scrollIntoView() { El.scrolled.push(this); }
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
  querySelectorAll(sel) { return [...this.walk()].filter((e) => matchOne(e, sel)); }
}
El.scrolled = [];
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
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

// ---- fixtures ----------------------------------------------------------------------------------------------------------
const R = (id, name, home, who, what) => ({ id, kind: 'setting', name, home, who, what: what || (name + ' does a thing. And a second sentence that is dropped.') });
const RECORDS = [
  R('OPT-0047', 'Model', 'Agent card > Basics', 'admin'),
  R('OPT-0057', 'Thinking effort', 'Agent card > Basics', 'admin'),
  R('OPT-0066', 'Longest reply', 'Agent card > Basics', 'both'),
  R('OPT-0022', 'Listens with', 'Agent card > Basics > More > Voice details', 'admin'),
  R('OPT-0033', 'Keep call recordings', 'Agent card > Basics > More > Recordings', 'admin'),
  R('OPT-0005', 'Short description', 'Agent card > Role and team', 'admin', 'A one-line note about what this agent is for.'),
  R('OPT-0001', 'Short name', 'Agent card > Role and team > More', 'admin'),
  R('OPT-0075', 'Cheapest model it may use', 'Agent card > Role and team > More > Model extras', 'admin'),
  R('OPT-0040', 'When the conversation gets long', 'Agent card > Memory', 'admin'),
  R('OPT-0041', 'How full before it acts', 'Agent card > Memory', 'both'),
  R('OPT-0090', 'Tools it may use', 'Agent card > Access', 'admin'),
  R('OPT-0095', 'Scheduled work', 'Agent card > Schedule and background work', 'admin'),
  R('OPT-0100', 'Other', 'Agent card > Access > More > A', 'admin'), R('OPT-0101', 'Other', 'Agent card > Access > More > B', 'admin'),
  R('OPT-0102', 'Other', 'Agent card > Access > More > C', 'admin'), R('OPT-0103', 'Other', 'Agent card > Access > More > D', 'admin'),
  R('OPT-0104', 'Other', 'Agent card > Access > More > E', 'admin'),
  { id: 'OPT-9999', kind: 'setting', name: 'Theme', home: 'Settings > You and this device', who: 'both', what: 'Light or dark.' },
];
const ADMIN = { isAdmin: true, user: { id: 'u1' } };
const MEMBER = { isAdmin: false, user: { id: 'u2' } };
const FIRST = { basics: ['OPT-0047', 'OPT-0057'], role: [], memory: ['OPT-0040'], access: ['OPT-0090'], schedule: ['OPT-0095'] };
const agentsFix = () => [
  { name: 'maestro', display: 'Maestro', lead: true, owner: null, sharedWith: [] },
  { name: 'harbor', display: 'Harbor', lead: false, reportsTo: 'maestro', owner: 'u2', sharedWith: [], blurb: 'Keeps notes' },
  { name: 'quill', display: 'Quill', owner: 'u3', sharedWith: [] },
  { name: 'tally', display: 'Tally', owner: 'u3', sharedWith: ['u2'] },
];
const resp = (status, json) => ({ ok: status < 300, status, json: async () => json });

function setup(over = {}) {
  const doc = makeDoc();
  const win = { innerWidth: 1200, location: { pathname: '/', hash: '', search: '' }, addEventListener() {}, removeEventListener() {} };
  const state = { agents: agentsFix(), fail: null };
  if (over.tweak) over.tweak(state.agents);
  const calls = [];
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method, body });
    if (url === '/api/agents' && method === 'GET') {
      if (state.hangGet) return new Promise(() => {});   // a re-read the hub never answers
      if (state.hangGetBody) return { ok: true, status: 200, json: () => new Promise(() => {}) };   // headers arrive, the body never does
      if (state.get503) return resp(503, { error: 'unavailable' });   // the hub answers, but not with the list
      if (state.gateGet) await state.gateGet;   // a test holds a re-read
      return resp(200, JSON.parse(JSON.stringify(state.agents)));
    }
    const m = /^\/api\/agents\/([^/]+)$/.exec(url);
    if (m && method === 'PATCH') {
      if (state.hang) return new Promise(() => {});   // a request the hub never answers (and that ignores the abort signal)
      if (state.hangBody) return { ok: false, status: 500, json: () => new Promise(() => {}) };   // headers arrive, the body never does
      if (state.gate) await state.gate;   // a test holds a save in flight
      if (state.fail) return resp(400, { error: state.fail });
      const a = state.agents.find((x) => x.name === decodeURIComponent(m[1]));
      for (const [k, v] of Object.entries(body)) {
        if (['voice', 'voiceDefaults', 'compaction'].includes(k) && v && typeof v === 'object') {   // the server merges these (null removes a key)
          const next = { ...(a[k] || {}) }; for (const [k2, v2] of Object.entries(v)) { if (v2 === null) delete next[k2]; else next[k2] = v2; }
          if (Object.keys(next).length) a[k] = next; else delete a[k];
        } else if (v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) delete a[k]; else a[k] = v;
      }
      return resp(200, { ok: true });
    }
    return resp(404, {});
  };
  const handlers = {};
  const subscribe = (t, fn) => { (handlers[t] = handlers[t] || []).push(fn); return () => { handlers[t] = (handlers[t] || []).filter((x) => x !== fn); }; };
  const emit = (t, p) => { for (const fn of [...(handlers[t] || [])]) fn(p); };
  const helpCalls = [];
  const help = { open: (id, btn) => helpCalls.push({ id, btn }), isOpen: () => false };
  const timers = [];
  const guard = { opened: [], closed_: [], requests: [], open(el, o) { this.opened.push({ el, o }); }, closed(el) { this.closed_.push(el); }, requestClose(el, how) { this.requests.push({ el, how }); return 'confirm'; } };   // the real guard asks "Discard?" and the person may keep editing
  const stale = JSON.parse(JSON.stringify(state.agents));   // the page's own list is older than the hub's
  const card = C.createCard({
    doc, win, fetch, records: () => RECORDS, me: () => ('me' in over ? over.me : ADMIN), agentsList: () => stale, subscribe, help: over.noHelp ? null : help,
    guard, rows: over.rows || undefined, firstRows: over.firstRows || FIRST, setTimeout: (fn, ms) => timers.push({ fn, ms }), phone: !!over.phone, simple: !!over.simple,
    requestMs: over.requestMs,
  });
  return { card, doc, win, state, calls, handlers, emit, helpCalls, timers, guard, fetchCount: () => calls.filter((c) => c.url === '/api/agents' && c.method === 'GET').length };
}
const all = (p, sel) => p.querySelectorAll(sel);
const secKeys = (p) => all(p, '.ac-sec').map((s) => s.getAttribute('data-sec'));
const rowIds = (p) => all(p, '.ac-row').map((r) => r.getAttribute('data-ac-row'));
const rowOf = (p, id) => all(p, '.ac-row').find((r) => r.getAttribute('data-ac-row') === id);

// ---- 1. sections --------------------------------------------------------------------------------------------------------
test('sections come from the records homed on "Agent card > ", in order, each with its one-line summary from its rows', async () => {
  const rows = new Map([
    ['OPT-0047', { get: () => ({ value: 'sonnet', display: 'Sonnet' }), control: { type: 'readonly' }, summary: () => 'Sonnet · Subscription' }],
    ['OPT-0057', { get: () => ({ value: 'medium', display: 'Medium' }), control: { type: 'readonly' }, summary: () => 'Medium effort' }],
    ['OPT-0090', { get: () => ({ value: 1, display: '1' }), control: { type: 'readonly' }, summary: () => '3 tools · 1 folder' }],
  ]);
  const t = setup({ rows });
  assert.strictEqual(await t.card.open('harbor'), true);
  const p = t.card.el();
  assert.deepStrictEqual(secKeys(p), ['basics', 'role', 'memory', 'access', 'schedule']);
  assert.deepStrictEqual(all(p, '.ac-sec-title').map((e) => e.textContent.replace(/[^\w ]/gu, '').trim()), ['Basics', 'Role and team', 'Memory', 'Access', 'Schedule and background work']);
  const sums = all(p, '.ac-sec-sum').map((e) => e.textContent);
  assert.strictEqual(sums[0], 'Sonnet · Subscription · Medium effort');
  assert.strictEqual(sums[3], '3 tools · 1 folder');
  assert.strictEqual(sums[1], '');
  assert.ok(!p.textContent.includes('Theme'), 'a record homed elsewhere is not on the card');
  assert.match(p.textContent, /You can also ask Maestro to change any of these\./);
  assert.ok(all(p, '.ac-shield').length === 1 && p.textContent.includes('Access'), 'only Access carries the shield mark');
});

test('the More line uses clean group names: no emoji, no ">" path parts, at most four then "and more"', () => {
  const recs = [
    { id: 'a', home: 'Agent card > Basics', name: '\u{1F514} > Questions' },
    { id: 'b', home: 'Agent card > Basics > More > \u{1F50A} Voice speed', name: 'x' },
    { id: 'c', home: 'Agent card > Basics', name: 'Alerts > Phone > ' + String.fromCodePoint(0x2699, 0xFE0F) + ' Requests' },
    { id: 'd', home: 'Agent card > Basics', name: 'Plain name' },
    { id: 'e', home: 'Agent card > Basics', name: 'Fifth' },
  ];
  const line = C.moreLine(recs);
  assert.strictEqual(line, 'More: Questions, Voice speed, Requests, Plain name and more');
  assert.ok(!/>/.test(line) && !/[^\x20-\x7E]/.test(line), line);
  assert.strictEqual(C.groupName({ id: 'z', name: '\u{1F514}' }), '', 'a name of only a symbol is empty, and is left out of the line');
  assert.strictEqual(C.moreLine([{ id: 'z', name: '\u{1F514}' }, { id: 'y', name: 'Kept' }]), 'More: Kept');
  assert.strictEqual(C.groupName({ id: 'w', home: 'Agent card > Schedule > More > Schedule (Task scheduler)', name: 'x' }), 'Schedule', 'a parenthesised part is dropped');
  assert.strictEqual(C.groupName({ id: 'v', name: '(Task scheduler)' }), '', 'a name that is only a parenthesised part is empty');
  assert.ok(!/\(/.test(C.moreLine([{ id: 'w', name: 'Schedule (Task scheduler)' }])));
});

test('FIRST_ROWS are shown first, every other record sits under a closed More that lists the group names (at most four, then "and more")', async () => {
  const t = setup();
  await t.card.open('harbor');
  const p = t.card.el();
  assert.deepStrictEqual(rowIds(p), ['OPT-0047', 'OPT-0057'], 'only the first rows of the open section (Basics)');
  const more = all(p, '.ac-more-head')[0];
  assert.strictEqual(more.textContent, '▸ More: Longest reply, Voice details, Recordings');
  assert.strictEqual(more.getAttribute('aria-expanded'), 'false');
  more.click();
  assert.strictEqual(all(t.card.el(), '.ac-more-head')[0].textContent, '▾ More: Longest reply, Voice details, Recordings');
  assert.strictEqual(all(t.card.el(), '.ac-more-head')[0].getAttribute('aria-expanded'), 'true');
  assert.deepStrictEqual(rowIds(t.card.el()), ['OPT-0047', 'OPT-0057', 'OPT-0066', 'OPT-0022', 'OPT-0033']);
  const access = all(t.card.el(), '.ac-sec-head')[3];
  access.click();
  const heads = all(t.card.el(), '.ac-more-head').map((e) => e.textContent);
  assert.ok(heads.includes('▸ More: A, B, C, D and more'), heads.join(' | '));
  assert.deepStrictEqual(C.FIRST_ROWS.basics, ['OPT-0047', 'OPT-0057', 'OPT-0168', 'OPT-0023', 'OPT-0063']);   // Model, Thinking effort, Notifications, Voice, Call display
  assert.deepStrictEqual(Object.keys(C.FIRST_ROWS), ['basics', 'role', 'memory', 'access', 'schedule']);
});

test('a row shows the record name, the first sentence of what (at most 200 characters) and the ⓘ that opens the help for that record', async () => {
  const t = setup();
  await t.card.open('harbor');
  const row = rowOf(t.card.el(), 'OPT-0047');
  assert.strictEqual(all(row, '.ac-label')[0].textContent, 'Model');
  assert.strictEqual(all(row, '.ac-desc')[0].textContent, 'Model does a thing.');
  all(row, '.st-info')[0].click();
  assert.strictEqual(t.helpCalls.length, 1);
  assert.strictEqual(t.helpCalls[0].id, 'OPT-0047');
  assert.ok(C.firstLine('x'.repeat(300)).length <= 200);
  const sentence = 'A specialist, a helper that does one narrow job well and reports back, and a writer of short plain notes for the whole team to read later on.';
  assert.strictEqual(C.firstLine(sentence + ' Second one.'), sentence, 'a normal first sentence shows in full');
  const none = setup({ noHelp: true });
  await none.card.open('harbor');
  assert.strictEqual(all(none.card.el(), '.st-info').length, 0, 'no help script, no ⓘ');
});

// ---- 2. who sees what ---------------------------------------------------------------------------------------------------
test('a member sees only Basics and Memory, and only for agents they own or that are shared with them', async () => {
  const t = setup({ me: MEMBER });
  assert.strictEqual(await t.card.open('quill'), false, 'not theirs, not shared');
  assert.strictEqual(t.card.isOpen(), false);
  assert.strictEqual(await t.card.open('maestro'), false, 'an infrastructure agent');
  assert.strictEqual(await t.card.open('harbor'), true);
  assert.deepStrictEqual(secKeys(t.card.el()), ['basics', 'memory']);
  t.card.close();
  assert.strictEqual(await t.card.open('tally'), true, 'shared with them');
  assert.deepStrictEqual(secKeys(t.card.el()), ['basics', 'memory']);
  assert.deepStrictEqual(C.sectionsFor(MEMBER), ['basics', 'memory']);
  assert.strictEqual(C.sectionsFor(ADMIN).length, 5);
  assert.strictEqual(C.mayOpen({ owner: 'u2' }, null), false);
});

test('a record whose who is admin is read-only for a member with "Only an admin can change this."; a "both" record stays live', async () => {
  const rows = new Map([
    ['OPT-0047', { get: () => ({ value: 'a', display: 'Sonnet' }), control: { type: 'select', options: () => [{ value: 'a', label: 'Sonnet' }] }, save: async () => ({ ok: true }) }],
    ['OPT-0066', { get: () => ({ value: 5, display: '5' }), control: { type: 'number' }, save: async () => ({ ok: true }) }],
  ]);
  const t = setup({ me: MEMBER, rows, firstRows: { basics: ['OPT-0047', 'OPT-0066'], memory: [] } });
  await t.card.open('harbor');
  const admin = rowOf(t.card.el(), 'OPT-0047');
  assert.match(admin.textContent, /Only an admin can change this\./);
  assert.strictEqual(all(admin, 'select').length, 0);
  assert.strictEqual(all(rowOf(t.card.el(), 'OPT-0066'), 'input').length, 1);
  const a = setup({ rows, firstRows: { basics: ['OPT-0047'] } });
  await a.card.open('harbor');
  assert.strictEqual(all(rowOf(a.card.el(), 'OPT-0047'), 'select').length, 1, 'an admin changes it');
});

test('a row whose live() says false is read-only with a line saying who can change it', async () => {
  const rows = new Map([['OPT-0047', { get: () => ({ value: 'a', display: 'Sonnet' }), control: { type: 'select', options: () => [] }, save: async () => ({ ok: true }), live: () => false }]]);
  const t = setup({ rows, firstRows: { basics: ['OPT-0047'] } });
  await t.card.open('harbor');
  const row = rowOf(t.card.el(), 'OPT-0047');
  assert.strictEqual(all(row, 'select').length, 0);
  assert.match(row.textContent, /This can't be changed right now\./);
});

test('whyNot(agent, ctx) replaces the notHere line for an admin; "" draws no line at all, and the row stays read-only', async () => {
  const mk = (whyNot) => new Map([['OPT-0047', { get: () => ({ value: 'a', display: 'Sonnet' }), control: { type: 'select', options: () => [] }, save: async () => ({ ok: true }), live: () => false, whyNot }]]);
  const own = setup({ rows: mk((agent) => 'Locked for ' + agent.name + '.'), firstRows: { basics: ['OPT-0047'] } });
  await own.card.open('harbor');
  const r1 = rowOf(own.card.el(), 'OPT-0047');
  assert.match(r1.textContent, /Locked for harbor\./);
  assert.ok(!r1.textContent.includes(C.TEXT.notHere));
  const none = setup({ rows: mk(() => ''), firstRows: { basics: ['OPT-0047'] } });
  await none.card.open('harbor');
  const r2 = rowOf(none.card.el(), 'OPT-0047');
  assert.strictEqual(all(r2, '.ac-note').length, 0);
  assert.strictEqual(all(r2, 'select').length, 0, 'still read-only');
  const member = setup({ me: MEMBER, rows: mk(() => 'x'), firstRows: { basics: ['OPT-0047'] } });
  await member.card.open('harbor');
  assert.match(rowOf(member.card.el(), 'OPT-0047').textContent, /Only an admin can change this\./, 'a member never sees whyNot');
});

test('Simple mode: the same card with Basics and Memory only, even for an admin', async () => {
  const t = setup({ simple: true });
  await t.card.open('harbor');
  assert.deepStrictEqual(secKeys(t.card.el()), ['basics', 'memory']);
  assert.deepStrictEqual(C.sectionsFor(ADMIN, true), ['basics', 'memory']);
});

test('Simple mode: an admin gets "More for <name>: …" that opens the other sections on the same card; a member does not', async () => {
  const t = setup({ simple: true });
  await t.card.open('harbor');
  const b = t.card.el().querySelectorAll('button.ac-simple-more')[0] || null;
  assert.ok(b, 'the row is drawn for an admin');
  assert.strictEqual(b.textContent, '▸ More for Harbor: Role and team, Access, Schedule and background work');
  b.click();
  assert.deepStrictEqual(secKeys(t.card.el()), ['basics', 'role', 'memory', 'access', 'schedule']);
  assert.strictEqual(t.card.el().querySelectorAll('button.ac-simple-more')[0] || null, null, 'gone once the sections are shown');
  t.card.close(false);
  await t.card.open('harbor');
  assert.deepStrictEqual(secKeys(t.card.el()), ['basics', 'memory'], 'a new opening starts with Simple\'s two sections again');
  t.card.close(false);
  await t.card.open('harbor', { section: 'access' });
  assert.ok(secKeys(t.card.el()).includes('access'), 'a door to Access opens it in Simple');
  const m = setup({ simple: true, me: MEMBER });
  await m.card.open('harbor');
  assert.strictEqual(m.card.el().querySelectorAll('button.ac-simple-more')[0] || null, null);
  assert.deepStrictEqual(secKeys(m.card.el()), ['basics', 'memory']);
});

// ---- 3. header, default line, unregistered rows ---------------------------------------------------------------------------
test('the header says "Settings for <name>" once, carries the role line and a close ×, and no row says "Applies to"', async () => {
  const t = setup();
  await t.card.open('harbor');
  const p = t.card.el();
  t.card.el().querySelectorAll('.ac-sec-head').forEach((h) => { if (h.getAttribute('aria-expanded') === 'false') h.click(); });
  const text = t.card.el().textContent;
  assert.strictEqual(text.split('Settings for Harbor').length - 1, 1);
  assert.ok(!/Applies to/i.test(text));
  assert.strictEqual(all(p, '.ac-role')[0].textContent, 'Solo · reports to Maestro');
  assert.strictEqual(all(p, '.ac-x')[0].getAttribute('aria-label'), 'Close');
  assert.strictEqual(p.getAttribute('role'), 'dialog');
  assert.strictEqual(all(p, '.ac-header').length, 1);
});

test('a row using the default shows "Using the default for all agents"; when it is not the default, "Use default again" resets it', async () => {
  const t = setup({ firstRows: FIRST, tweak: (l) => { l[1].compaction = { mode: 'on', at: 0.8 }; } });
  await t.card.open('harbor', { section: 'memory' });
  let row = rowOf(t.card.el(), 'OPT-0040');
  assert.ok(row);
  assert.ok(!row.textContent.includes('Using the default for all agents'));
  const reset = all(row, '.ac-reset')[0];
  assert.strictEqual(reset.textContent, 'Use default again');
  reset.click();
  await flush();
  const patch = t.calls.find((c) => c.method === 'PATCH');
  assert.strictEqual(patch.url, '/api/agents/harbor');
  assert.deepStrictEqual(patch.body, { compaction: { mode: null } }, 'only the mode is sent (null = the default again); the at half stays on the server');
  assert.deepStrictEqual(t.state.agents[1].compaction, { at: 0.8 });
  assert.ok(t.fetchCount() >= 1, 'the card re-read the agent');
  row = rowOf(t.card.el(), 'OPT-0040');
  assert.match(row.textContent, /Using the default for all agents/, 'after the reset and the re-read the row is back on the default');
  assert.strictEqual(all(row, '.ac-reset').length, 0);
  const fresh = setup({ firstRows: FIRST });
  await fresh.card.open('harbor', { section: 'memory' });
  const r2 = rowOf(fresh.card.el(), 'OPT-0040');
  assert.match(r2.textContent, /Using the default for all agents/);
  assert.strictEqual(all(r2, '.ac-reset').length, 0);
});

test('a record with no registered rowDef is read-only text for admins (no link to another page), and nothing for members', async () => {
  const a = setup();
  await a.card.open('harbor');
  const row = rowOf(a.card.el(), 'OPT-0047');
  assert.match(row.textContent, /Shown for reading only\./);
  assert.ok(!/agent page|Change it on/.test(row.textContent), 'the old page is not offered');
  assert.strictEqual(all(row, 'a').length, 0, 'no link at all');
  assert.strictEqual(all(row, 'select').length + all(row, 'input').length, 0);
  assert.strictEqual(all(row, '.st-info').length, 1, 'the ⓘ is still there');
  const m = setup({ me: MEMBER });
  await m.card.open('harbor');
  const mrow = rowOf(m.card.el(), 'OPT-0047');
  assert.ok(!/Shown for reading only|Change it on/.test(mrow.textContent));
  assert.strictEqual(all(mrow, 'a').length, 0);
});

// ---- 4. saving ----------------------------------------------------------------------------------------------------------
const TEXT_ROW = (saved) => new Map([['OPT-0005', {
  get: (a) => ({ value: a.blurb || '', display: a.blurb || '' }),
  control: { type: 'text', max: 120 },
  save: async (a, v, ctx) => { saved.push(v); return ctx.patch({ blurb: v }); },
}]]);

test('a saved change calls the row save, disables the control meanwhile, then re-reads the agent and draws the new value', async () => {
  const saved = [];
  const t = setup({ rows: TEXT_ROW(saved), firstRows: { role: ['OPT-0005'] } });
  await t.card.open('harbor', { section: 'role' });
  const before = t.fetchCount();
  let input = all(rowOf(t.card.el(), 'OPT-0005'), 'input')[0];
  assert.strictEqual(input.value, 'Keeps notes');
  input.value = 'Writes the weekly report';
  input.dispatch('change');
  input = all(rowOf(t.card.el(), 'OPT-0005'), 'input')[0];
  assert.ok(input.disabled === true || input.getAttribute('disabled') !== null || t.card.state().saving.has('OPT-0005'), 'disabled while saving');
  await flush();
  assert.deepStrictEqual(saved, ['Writes the weekly report']);
  assert.strictEqual(t.fetchCount(), before + 1, 're-read after the save');
  input = all(rowOf(t.card.el(), 'OPT-0005'), 'input')[0];
  assert.strictEqual(input.value, 'Writes the weekly report');
  assert.ok(!input.disabled);
  assert.strictEqual(all(t.card.el(), '.ac-err').length, 0);
});

test('a failed save puts the control back and shows the error under the row', async () => {
  const saved = [];
  const t = setup({ rows: TEXT_ROW(saved), firstRows: { role: ['OPT-0005'] } });
  await t.card.open('harbor', { section: 'role' });
  t.state.fail = 'That is too long.';
  const before = t.fetchCount();
  const input = all(rowOf(t.card.el(), 'OPT-0005'), 'input')[0];
  input.value = 'x';
  input.dispatch('change');
  await flush();
  const row = rowOf(t.card.el(), 'OPT-0005');
  assert.strictEqual(all(row, '.ac-err')[0].textContent, 'That is too long.');
  assert.strictEqual(all(row, 'input')[0].value, 'Keeps notes', 'the control is back to what is stored');
  assert.ok(!all(row, 'input')[0].disabled);
  assert.strictEqual(t.fetchCount(), before, 'no re-read after a failure');
  const thrown = setup({ rows: new Map([['OPT-0005', { get: () => ({ value: 'a' }), control: { type: 'text' }, save: async () => { throw new Error('boom'); } }]]), firstRows: { role: ['OPT-0005'] } });
  await thrown.card.open('harbor', { section: 'role' });
  const i2 = all(rowOf(thrown.card.el(), 'OPT-0005'), 'input')[0];
  i2.value = 'b'; i2.dispatch('change');
  await flush();
  assert.strictEqual(all(thrown.card.el(), '.ac-err')[0].textContent, 'boom');
});

test('every control type draws and reports its change (toggle, select, segmented, number, list, action)', async () => {
  const got = {};
  const mk = (type, value, extra = {}) => ({ get: () => ({ value, display: String(value) }), control: { type, options: () => [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], ...extra }, save: async (a, v) => { got[type] = v; return { ok: true }; } });
  const rows = new Map([['OPT-0047', mk('toggle', false)], ['OPT-0057', mk('select', 'a')], ['OPT-0066', mk('segmented', 'a')], ['OPT-0022', mk('number', 3, { min: 1, max: 9 })], ['OPT-0033', mk('list', ['x'])], ['OPT-0075', mk('action', 1)]]);
  const t = setup({ rows, firstRows: { basics: ['OPT-0047', 'OPT-0057', 'OPT-0066', 'OPT-0022', 'OPT-0033'], role: ['OPT-0075'] } });
  await t.card.open('harbor', { section: 'role' });
  const p = () => t.card.el();
  const sw = all(rowOf(p(), 'OPT-0047'), 'input')[0]; sw.checked = true; sw.dispatch('change'); await flush();
  const se = all(rowOf(p(), 'OPT-0057'), 'select')[0]; se.value = 'b'; se.dispatch('change'); await flush();
  all(rowOf(p(), 'OPT-0066'), 'button').find((b) => b.textContent === 'B').click(); await flush();
  const nu = all(rowOf(p(), 'OPT-0022'), 'input')[0]; nu.value = '7'; nu.dispatch('change'); await flush();
  const li = all(rowOf(p(), 'OPT-0033'), 'input')[0]; assert.strictEqual(li.value, 'x'); li.value = 'x, y ,'; li.dispatch('change'); await flush();
  all(rowOf(p(), 'OPT-0075'), 'button').find((b) => b.getAttribute('class') === 'ac-action').click(); await flush();
  assert.deepStrictEqual(got, { toggle: true, select: 'b', segmented: 'b', number: 7, list: ['x', 'y'], action: true });
});

// ---- 5. live updates ----------------------------------------------------------------------------------------------------
test('agent_updated for this agent re-reads and re-draws without losing the open sections or the scroll; other agents are ignored', async () => {
  const t = setup();
  await t.card.open('harbor', { section: 'memory', row: 'OPT-0041' });
  const p = t.card.el();
  p.scrollTop = 321;
  assert.strictEqual(t.card.state().open.has('memory'), true);
  const before = t.fetchCount();
  t.emit('agent_updated', { agent: 'quill', changed: ['model'] });
  await flush();
  assert.strictEqual(t.fetchCount(), before, 'another agent: nothing');
  t.state.agents[1].display = 'Harbor Two';
  t.emit('agent_updated', { agent: 'harbor', changed: ['display'] });
  await flush();
  assert.strictEqual(t.fetchCount(), before + 1);
  assert.strictEqual(t.card.el(), p, 'the same panel');
  assert.match(all(p, '.ac-title')[0].textContent, /Settings for Harbor Two/);
  assert.deepStrictEqual(secKeys(p), ['basics', 'role', 'memory', 'access', 'schedule']);
  assert.strictEqual(t.card.state().open.has('memory'), true);
  assert.ok(rowOf(p, 'OPT-0041'), 'the opened More is still open');
  assert.strictEqual(p.scrollTop, 321);
  t.emit('settings_changed', {});
  await flush();
  assert.strictEqual(t.fetchCount(), before + 2, 'settings_changed re-reads too');
});

test('a rename closes the card; so does an agent that is gone or no longer shared on the next read', async () => {
  const t = setup();
  await t.card.open('harbor');
  assert.ok(t.handlers.agent_updated.length === 1);
  t.emit('agent_updated', { agent: 'harbor', renamedTo: 'harbor2' });
  assert.strictEqual(t.card.isOpen(), false);
  assert.strictEqual(t.doc.body.children.length, 0);
  assert.strictEqual((t.handlers.agent_updated || []).length, 0, 'unsubscribed');
  await t.card.open('harbor');
  t.state.agents = t.state.agents.filter((a) => a.name !== 'harbor');
  t.emit('settings_changed', {});
  await flush();
  assert.strictEqual(t.card.isOpen(), false);
  const m = setup({ me: MEMBER });
  await m.card.open('tally');
  m.state.agents.find((a) => a.name === 'tally').sharedWith = [];
  m.emit('agent_updated', { agent: 'tally', changed: ['category'] });
  await flush();
  assert.strictEqual(m.card.isOpen(), false);
});

// ---- 6. the door --------------------------------------------------------------------------------------------------------
test('parseCardHash reads #agent-card=<name>&row=OPT-xxxx and nothing else', () => {
  assert.deepStrictEqual(C.parseCardHash('#agent-card=harbor&row=OPT-0075'), { name: 'harbor', row: 'OPT-0075', section: null });
  assert.deepStrictEqual(C.parseCardHash('#agent-card=harbor'), { name: 'harbor', row: null, section: null });
  assert.deepStrictEqual(C.parseCardHash('#agent-card=harbor&section=memory'), { name: 'harbor', row: null, section: 'memory' });
  assert.strictEqual(C.parseCardHash('#agent-card=harbor&row=bad'), null);
  assert.strictEqual(C.parseCardHash('#settings-for=OPT-0001'), null);
  assert.strictEqual(C.parseCardHash('#agent-card=../x'), null);
  assert.strictEqual(C.parseCardHash(''), null);
});

test('the door opens the row\'s section and its More, scrolls to it now and after 150 and 450 ms, lights it for 2 s and focuses its ⓘ', async () => {
  El.scrolled.length = 0;
  const t = setup();
  await t.card.open('harbor', { row: 'OPT-0075' });
  const p = t.card.el();
  assert.strictEqual(t.card.state().open.has('role'), true);
  assert.strictEqual(t.card.state().more.has('role'), true);
  const row = rowOf(p, 'OPT-0075');
  assert.ok(row, 'the row is drawn');
  assert.ok(row.classList.contains('st-door-hit'));
  assert.strictEqual(El.scrolled.length, 1);
  assert.deepStrictEqual(t.timers.map((x) => x.ms), [150, 450, 2000]);
  assert.strictEqual(t.doc.activeElement, all(row, '.st-info')[0]);
  for (const x of t.timers) x.fn();
  assert.strictEqual(El.scrolled.length, 3, 'scrolled again after 150 and 450 ms');
  assert.ok(!row.classList.contains('st-door-hit'), 'the light goes out after 2 s');
});

test('the door does not scroll again once the person has scrolled', async () => {
  El.scrolled.length = 0;
  const t = setup();
  const wheels = [];
  t.doc.addEventListener = ((orig) => function (type, fn, cap) { if (type === 'wheel') wheels.push(fn); return orig.call(this, type, fn, cap); })(t.doc.addEventListener);
  await t.card.open('harbor', { row: 'OPT-0075' });
  assert.ok(wheels.length >= 1);
  wheels[0]();
  for (const x of t.timers) x.fn();
  assert.strictEqual(El.scrolled.length, 1);
});

test('the door only opens agents the person may open, and a row outside a member\'s sections is not opened', async () => {
  const m = setup({ me: MEMBER });
  assert.strictEqual(await m.card.open('quill', { row: 'OPT-0047' }), false);
  assert.strictEqual(await m.card.open('harbor', { row: 'OPT-0075' }), true);
  assert.deepStrictEqual(secKeys(m.card.el()), ['basics', 'memory']);
  assert.strictEqual(rowOf(m.card.el(), 'OPT-0075'), undefined);
});

test('cardDoorStart follows the address now and on every hashchange', async () => {
  const t = setup();
  t.win.location.hash = '#agent-card=harbor&row=OPT-0040';
  const listeners = [];
  t.win.addEventListener = (type, fn) => listeners.push({ type, fn });
  C.cardDoorStart({ win: t.win, card: t.card, force: true });
  await flush();
  assert.strictEqual(t.card.isOpen(), true);
  assert.strictEqual(t.card.state().name, 'harbor');
  assert.ok(rowOf(t.card.el(), 'OPT-0040'));
  assert.ok(listeners.some((l) => l.type === 'hashchange'));
  t.card.close();
  t.win.location.hash = '#agent-card=tally';
  listeners.find((l) => l.type === 'hashchange').fn();
  await flush();
  assert.strictEqual(t.card.state().name, 'tally');
});

// ---- 7. layout and focus ------------------------------------------------------------------------------------------------
test('Escape and × close the panel and put the focus back on what opened it', async () => {
  const t = setup();
  const opener = t.doc.createElement('button'); t.doc.body.appendChild(opener); opener.focus();
  await t.card.open('harbor');
  assert.notStrictEqual(t.doc.activeElement, opener, 'the focus moved into the card');
  assert.strictEqual(t.doc.activeElement, t.card.el());
  t.card.el().dispatch('keydown', { key: 'Escape' });
  assert.strictEqual(t.card.isOpen(), false);
  assert.strictEqual(t.doc.activeElement, opener);
  await t.card.open('harbor');
  all(t.card.el(), '.ac-x')[0].click();
  assert.strictEqual(t.card.isOpen(), false);
  assert.strictEqual(t.doc.activeElement, opener);
});

test('Escape closes the ⓘ help first when it is open', async () => {
  const t = setup();
  const doc = t.doc;
  let helpOpen = true;
  const card = C.createCard({ doc, win: t.win, fetch: async () => resp(404, {}), records: () => RECORDS, me: ADMIN, agentsList: () => agentsFix(), subscribe: () => () => {}, help: { open() {}, isOpen: () => helpOpen }, firstRows: FIRST });
  await card.open('harbor');
  card.el().dispatch('keydown', { key: 'Escape' });
  assert.strictEqual(card.isOpen(), true);
  helpOpen = false;
  card.el().dispatch('keydown', { key: 'Escape' });
  assert.strictEqual(card.isOpen(), false);
});

test('on the phone the card is a full-screen sheet registered with the page\'s dialog guard; closing tells the guard', async () => {
  const t = setup({ phone: true });
  await t.card.open('harbor');
  const p = t.card.el();
  assert.ok(p.classList.contains('ac-sheet'));
  assert.strictEqual(p.getAttribute('aria-modal'), 'true');
  assert.strictEqual(t.guard.opened.length, 1);
  assert.strictEqual(t.guard.opened[0].el, p);
  t.guard.opened[0].o.close();   // Back or Escape through the guard
  assert.strictEqual(t.card.isOpen(), false);
  assert.deepStrictEqual(t.guard.closed_, [p]);
  const d = setup();
  await d.card.open('harbor');
  assert.ok(!d.card.el().classList.contains('ac-sheet'));
  assert.strictEqual(d.guard.opened.length, 0, 'the desktop panel does not use the guard');
});

// ---- 7b. phase 3 round 1: instance-bound saves, one save at a time, drafts, phone Escape, focus -------------------------------
test('a save started on one agent and a card switched to another meanwhile: every request and the completion go to the first agent only', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const rows = new Map([['OPT-0005', {
    get: (a) => ({ value: a.blurb || '', display: a.blurb || '' }), control: { type: 'text' },
    save: async (agent, value, ctx) => {
      const a = await ctx.patch({ blurb: value });
      await gate;
      const b = await ctx.patch({ display: value + ' (2)' });   // a later request of the same save
      await ctx.refresh();
      return b.ok && a.ok ? { ok: true } : { ok: false, error: 'x' };
    },
  }]]);
  const t = setup({ rows, firstRows: { role: ['OPT-0005'] } });
  await t.card.open('harbor', { section: 'role' });
  const input = all(rowOf(t.card.el(), 'OPT-0005'), 'input')[0];
  input.value = 'New'; input.dispatch('change');
  await flush();
  const before = t.fetchCount();
  assert.strictEqual(await t.card.open('tally', { section: 'role' }), true);   // the card moves to another agent
  assert.strictEqual(t.card.state().name, 'tally');
  release(); await flush();
  const patches = t.calls.filter((c) => c.method === 'PATCH');
  assert.deepStrictEqual(patches.map((c) => c.url), ['/api/agents/harbor', '/api/agents/harbor'], 'all requests of the save went to harbor');
  assert.strictEqual(t.fetchCount(), before, 'the second card was not re-read for the first card\'s save');
  assert.strictEqual(t.card.state().saving.size, 0);
  assert.strictEqual(t.card.state().errors.size, 0, 'nothing was applied to the second card');
  assert.strictEqual(all(t.card.el(), '.ac-err').length, 0);
});

test('a refresh while a text input has focus and typed text keeps the text and the focus; the row catches up after the save', async () => {
  const saved = [];
  const t = setup({ rows: TEXT_ROW(saved), firstRows: { role: ['OPT-0005'] } });
  await t.card.open('harbor', { section: 'role' });
  const input = all(rowOf(t.card.el(), 'OPT-0005'), 'input')[0];
  input.focus(); input.value = 'half typed';
  await t.card.refresh(); await flush();
  const again = all(rowOf(t.card.el(), 'OPT-0005'), 'input')[0];
  assert.strictEqual(again.value, 'half typed', 'the typed text stays');
  assert.strictEqual(t.doc.activeElement, again, 'and so does the focus');
  // typed but no longer focused: still kept until it is saved
  t.doc.activeElement = null;
  t.emit('agent_updated', { agent: 'harbor' }); await flush();
  assert.strictEqual(all(rowOf(t.card.el(), 'OPT-0005'), 'input')[0].value, 'half typed');
  // saving it shows the stored value again
  all(rowOf(t.card.el(), 'OPT-0005'), 'input')[0].dispatch('change'); await flush();
  assert.deepStrictEqual(saved, ['half typed']);
  assert.strictEqual(all(rowOf(t.card.el(), 'OPT-0005'), 'input')[0].value, 'half typed', 'the stored value (the same here)');
  assert.ok(!all(rowOf(t.card.el(), 'OPT-0005'), 'input')[0].disabled);
  // an untouched row is redrawn from the hub as before
  t.state.agents[1].blurb = 'From elsewhere';
  await t.card.refresh(); await flush();
  assert.strictEqual(all(rowOf(t.card.el(), 'OPT-0005'), 'input')[0].value, 'From elsewhere');
});

test('one save at a time per card: every control is disabled while it runs, a second change is blocked, and a changed object sends only its changed key', async () => {
  const t = setup({ firstRows: { memory: ['OPT-0040'], role: ['OPT-0005'] } });
  await t.card.open('harbor', { section: 'memory' });
  all(t.card.el(), '.ac-sec-head').find((h) => h.parentNode.getAttribute('data-sec') === 'role').click();
  let release; t.state.gate = new Promise((r) => { release = r; });
  const sel = all(rowOf(t.card.el(), 'OPT-0040'), 'select')[0];
  sel.value = 'on'; sel.dispatch('change'); await flush();
  const p = t.card.el();
  const live = all(p, 'select').concat(all(p, 'input'));
  assert.ok(live.length >= 2 && live.every((e) => e.disabled === true), 'every control is disabled');
  const blurb = all(rowOf(p, 'OPT-0005'), 'input')[0];
  blurb.value = 'second'; blurb.dispatch('change'); await flush();
  assert.strictEqual(t.calls.filter((c) => c.method === 'PATCH').length, 1, 'no second save started');
  t.state.gate = null; release(); await flush();
  assert.ok(all(t.card.el(), 'select').concat(all(t.card.el(), 'input')).every((e) => !e.disabled), 'controls are back');
  t.state.agents[1].compaction = { mode: 'off', at: 0.6 };   // changed elsewhere; the card has not heard yet
  t.calls.length = 0;
  const sel2 = all(rowOf(t.card.el(), 'OPT-0040'), 'select')[0];
  sel2.value = 'assisted'; sel2.dispatch('change'); await flush();
  assert.deepStrictEqual(t.calls.filter((c) => c.method === 'PATCH').map((c) => c.body), [{ compaction: { mode: 'assisted' } }], 'only the changed key');
  assert.deepStrictEqual(t.state.agents[1].compaction, { mode: 'assisted', at: 0.6 }, 'the half another device set is kept');
});

test('phone: ×, Escape and Back belong to the dialog guard (its discard question); keeping the edit keeps the card; the card has no Escape listener of its own', async () => {
  const t = setup({ phone: true });
  await t.card.open('harbor');
  const p = t.card.el();
  all(p, '.ac-x')[0].click();
  assert.deepStrictEqual(t.guard.requests.map((r) => [r.el, r.how]), [[p, 'close']], '× goes through requestClose');
  assert.strictEqual(t.card.isOpen(), true, 'Keep editing: the card stays');
  t.doc.dispatch('keydown', { key: 'Escape' });
  p.dispatch('keydown', { key: 'Escape' });
  assert.strictEqual(t.card.isOpen(), true, 'the card\'s own listener does not close it while the question is up');
  assert.strictEqual(t.guard.requests.length, 1);
  t.guard.opened[0].o.close();   // Discard
  assert.strictEqual(t.card.isOpen(), false);
});

test('desktop: the card\'s own Escape ignores an event that was already handled and one that comes while another dialog is open', async () => {
  const t = setup();
  await t.card.open('harbor');
  t.card.el().dispatch('keydown', { key: 'Escape', defaultPrevented: true });
  assert.strictEqual(t.card.isOpen(), true, 'already handled');
  const dlg = t.doc.createElement('dialog'); dlg.setAttribute('open', ''); t.doc.body.appendChild(dlg);
  t.card.el().dispatch('keydown', { key: 'Escape' });
  assert.strictEqual(t.card.isOpen(), true, 'another overlay is open');
  t.doc.body.removeChild(dlg);
  t.card.el().dispatch('keydown', { key: 'Escape' });
  assert.strictEqual(t.card.isOpen(), false);
});

test('toggling a section or More puts the focus back on its header; the dead agent_renamed listener is gone', async () => {
  const t = setup();
  await t.card.open('harbor');
  assert.strictEqual(t.handlers.agent_renamed, undefined, 'no agent_renamed listener');
  assert.strictEqual(t.handlers.agent_updated.length, 1);
  const head = () => all(t.card.el(), '.ac-sec-head').find((h) => h.parentNode.getAttribute('data-sec') === 'basics');
  head().click();   // closes Basics
  assert.ok(t.doc.activeElement === head(), 'the section header has the focus again');
  assert.ok(t.doc.activeElement.isConnected);
  head().click();
  assert.ok(t.doc.activeElement === head(), 'opened again: the header has the focus');
  const more = () => all(t.card.el(), '.ac-more-head')[0];
  more().click();
  assert.ok(t.doc.activeElement === more(), 'More keeps the focus');
  assert.strictEqual(more().getAttribute('aria-expanded'), 'true');
});

// ---- 8. the two sample rows ---------------------------------------------------------------------------------------------
test('sample row: the short description saves PATCH /api/agents/<name> {blurb}', async () => {
  const t = setup({ firstRows: { role: ['OPT-0005'] } });
  await t.card.open('harbor', { section: 'role' });
  const input = all(rowOf(t.card.el(), 'OPT-0005'), 'input')[0];
  assert.strictEqual(input.value, 'Keeps notes');
  assert.strictEqual(input.getAttribute('maxlength'), '120');
  input.value = '  Writes reports  ';
  input.dispatch('change');
  await flush();
  const patch = t.calls.find((c) => c.method === 'PATCH');
  assert.strictEqual(patch.url, '/api/agents/harbor');
  assert.deepStrictEqual(patch.body, { blurb: 'Writes reports' });
  assert.strictEqual(t.state.agents[1].blurb, 'Writes reports');
});

test('sample row: compaction mode saves PATCH {compaction} (not the admin-only PUT) and keeps the "at" half', async () => {
  const t = setup({ firstRows: FIRST, tweak: (l) => { l[1].compaction = { mode: 'off', at: 0.7 }; } });
  await t.card.open('harbor', { section: 'memory' });
  const sel = all(rowOf(t.card.el(), 'OPT-0040'), 'select')[0];
  assert.deepStrictEqual(all(sel, 'option').map((o) => o.value), ['', 'off', 'dry', 'on', 'assisted']);
  assert.strictEqual(sel.value, 'off');
  sel.value = 'assisted';
  sel.dispatch('change');
  await flush();
  const patch = t.calls.find((c) => c.method === 'PATCH');
  assert.strictEqual(patch.url, '/api/agents/harbor');
  assert.deepStrictEqual(patch.body, { compaction: { mode: 'assisted' } });
  assert.ok(!t.calls.some((c) => c.method === 'PUT'));
  assert.match(all(t.card.el(), '.ac-sec-sum')[2].textContent, /compression assisted/);
});

test('a member may save the sample "both"-free rows only where the record allows it: compaction mode is an admin record, so it is read-only for a member', async () => {
  const t = setup({ me: MEMBER, firstRows: FIRST });
  await t.card.open('harbor', { section: 'memory' });
  const row = rowOf(t.card.el(), 'OPT-0040');
  assert.strictEqual(all(row, 'select').length, 0);
  assert.match(row.textContent, /Only an admin can change this\./);
});

// ---- 9. the pages -------------------------------------------------------------------------------------------------------
test('the script is served under /ui-agent-card.js, both pages load it after the help script, and each page starts the door once', () => {
  const { ALIASES, resolve } = require('../lib/static-files.js');
  assert.strictEqual(ALIASES.get('ui-agent-card.js'), 'lib/ui-agent-card.js');
  assert.strictEqual(resolve('/ui-agent-card.js', root), fs.realpathSync(path.join(root, 'lib/ui-agent-card.js')));
  for (const f of ['index.html', 'mobile.html']) {
    const h = read(f);
    const a = h.indexOf('<script src="/ui-settings-help.js"></script>');
    const b = h.indexOf('<script src="/ui-agent-card.js"></script>');
    assert.ok(a > 0 && b > a, f + ' loads ui-agent-card.js after ui-settings-help.js');
    assert.strictEqual(h.split('hubAgentCard.cardDoorStart()').length - 1, 1, f + ' starts the door once');
    for (const sel of ['.ac-panel', '.ac-header', '.ac-sec-head', '.ac-row', '.ac-more-head', '.ac-foot']) assert.ok(h.includes(sel + ' {') || h.includes(sel + ' '), f + ' styles ' + sel);
  }
  assert.match(read('mobile.html'), /configure\(\{ guard: typeof dialogGuard/);
});

test('the card CSS uses only variables the pages define and no colour literal; the shield is the accent colour; sw.js is bumped', () => {
  for (const f of ['index.html', 'mobile.html']) {
    const h = read(f);
    const rules = h.split('\n').filter((l) => /^\s*\.ac-[\w.:, -]* \{/.test(l) || /^\s*\.ac-/.test(l));
    assert.ok(rules.length > 25, f + ' has the card rules');
    for (const l of rules) {
      assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(l) && !/rgba?\(/.test(l), f + ': no colour literal in ' + l.slice(0, 60));
      for (const m of l.matchAll(/var\(\s*(--[\w-]+)/g)) {
        if (['--sab', '--sat', '--banner-h'].includes(m[1])) continue;
        assert.ok(new RegExp(m[1] + '\\s*:').test(h), f + ' defines ' + m[1]);
      }
    }
    assert.match(h, /\.ac-shield \{ margin-left: 6px; color: var\(--accent\); \}/);
    assert.ok(!/orange/i.test(rules.join('\n')));
  }
  assert.match(read('sw.js'), /const VERSION = 'hub-mobile-v113'/);
});

test('the script has no invisible characters, sets text with textContent only and names no real person', () => {
  const src = read('lib/ui-agent-card.js');
  assert.ok(!new RegExp('[' + String.fromCharCode(0xfe0f, 0x200d) + ']').test(src));
  assert.ok(!/innerHTML|insertAdjacentHTML|document\.write/.test(src));
  assert.ok(!/Applies to/.test(src));
  assert.strictEqual(C.TEXT.footer, 'You can also ask Maestro to change any of these.');
});

// ---- 10. phase 3 round 2: navigation token, Escape, timeout, drafts, focus, configure -------------------------------------------
const GATED_ROW = (gate, after) => new Map([['OPT-0005', {
  get: (a) => ({ value: a.blurb || '', display: a.blurb || '' }), control: { type: 'text' },
  save: async (agent, value, ctx) => { await ctx.patch({ blurb: value }); await gate; await after(ctx); return { ok: true }; },
}]]);

test('a rename started on one card does not reopen it once the person moved to another card (the navigation token)', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const reopened = [];
  const t = setup({ rows: GATED_ROW(gate, async (ctx) => { reopened.push(await ctx.open('quill', { section: 'role' })); }), firstRows: { role: ['OPT-0005'] } });
  await t.card.open('harbor', { section: 'role' });
  const input = all(rowOf(t.card.el(), 'OPT-0005'), 'input')[0];
  input.value = 'New'; input.dispatch('change'); await flush();
  assert.strictEqual(await t.card.open('tally', { section: 'role' }), true);   // the person goes to B before the rename answers
  release(); await flush();
  assert.deepStrictEqual(reopened, ['superseded'], 'the late reopen was refused as superseded (not a denial)');
  assert.strictEqual(t.card.state().name, 'tally', 'B stays');
});

test('a rename whose own card was closed by the agent_updated rename event still reopens on the new name (nobody navigated)', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const reopened = [];
  const t = setup({ rows: GATED_ROW(gate, async (ctx) => { reopened.push(await ctx.open('quill', { section: 'role' })); }), firstRows: { role: ['OPT-0005'] } });
  await t.card.open('harbor', { section: 'role' });
  const input = all(rowOf(t.card.el(), 'OPT-0005'), 'input')[0];
  input.value = 'New'; input.dispatch('change'); await flush();
  t.emit('agent_updated', { agent: 'harbor', renamedTo: 'quill' });   // the card closes itself
  assert.strictEqual(t.card.isOpen(), false);
  release(); await flush();
  assert.deepStrictEqual(reopened, [true]);
  assert.strictEqual(t.card.state().name, 'quill');
});

test('a slower earlier open() does not replace a later one', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  let n = 0;
  const doc = makeDoc();
  const win = { innerWidth: 1200, location: { pathname: '/', hash: '', search: '' }, addEventListener() {}, removeEventListener() {} };
  const help = { open() {}, isOpen: () => false, load: async () => { if (++n === 1) await gate; }, records: () => RECORDS };
  const card = C.createCard({ doc, win, fetch: async () => resp(404, {}), me: ADMIN, agentsList: () => agentsFix(), subscribe: () => () => {}, help, firstRows: FIRST, setTimeout: () => {} });
  const first = card.open('harbor');   // waits on the slow read
  assert.strictEqual(await card.open('tally'), true);
  release();
  assert.strictEqual(await first, 'superseded', 'the older open gave way');
  assert.strictEqual(card.state().name, 'tally');
  assert.strictEqual(doc.body.children.length, 1, 'one panel only');
  // and a close() while an open() is still loading wins too
  n = 0; card.close();
  let release2; const gate2 = new Promise((r) => { release2 = r; }); n = 0; help.load = async () => { await gate2; };
  const slow = card.open('harbor'); card.close(); release2();
  assert.strictEqual(await slow, 'superseded');
  assert.strictEqual(card.isOpen(), false);
  // a real denial is still false
  assert.strictEqual(await card.open('nobody'), false);
});

test('desktop Escape: a hidden aria-modal box in the page (the closed Reasoning view) does not stop it, a visible one does', async () => {
  const t = setup();
  await t.card.open('harbor');
  const box = t.doc.createElement('div'); box.setAttribute('aria-modal', 'true'); box.checkVisibility = () => false; t.doc.body.appendChild(box);
  t.card.el().dispatch('keydown', { key: 'Escape' });
  assert.strictEqual(t.card.isOpen(), false, 'closed with a hidden modal box present');
  await t.card.open('harbor');
  box.checkVisibility = () => true;
  t.card.el().dispatch('keydown', { key: 'Escape' });
  assert.strictEqual(t.card.isOpen(), true, 'a shown modal box owns Escape');
  box.checkVisibility = () => false;
  const hid = t.doc.createElement('div'); hid.setAttribute('hidden', ''); const inner = t.doc.createElement('div'); inner.setAttribute('aria-modal', 'true'); hid.appendChild(inner); t.doc.body.appendChild(hid);
  inner.closest = (s) => (s === '[hidden]' ? hid : null);
  t.card.el().dispatch('keydown', { key: 'Escape' });
  assert.strictEqual(t.card.isOpen(), false, 'inside a [hidden] parent does not count');
});

test('a PATCH the hub never answers is given up after the time limit: the card unlocks with an error', async () => {
  const t = setup({ requestMs: 40, firstRows: { role: ['OPT-0005'] } });
  await t.card.open('harbor', { section: 'role' });
  t.state.hang = true;
  const input = all(rowOf(t.card.el(), 'OPT-0005'), 'input')[0];
  input.value = 'x'; input.dispatch('change'); await flush();
  assert.ok(all(t.card.el(), 'input').every((e) => e.disabled === true), 'locked while waiting');
  await new Promise((r) => setTimeout(r, 120)); await flush();
  assert.strictEqual(t.card.state().saving.size, 0, 'unlocked');
  assert.ok(all(t.card.el(), 'input').every((e) => !e.disabled));
  assert.match(rowOf(t.card.el(), 'OPT-0005').textContent, /did not answer in time/);
  t.state.hang = false;
  const again = all(rowOf(t.card.el(), 'OPT-0005'), 'input')[0];
  again.value = 'y'; again.dispatch('change'); await flush();
  assert.strictEqual(t.state.agents[1].blurb, 'y', 'a new save works');
});

test('a fresh read that never answers also gives up (the save says it could not read the settings)', async () => {
  const doc = makeDoc();
  const win = { innerWidth: 1200, location: { pathname: '/', hash: '', search: '' }, addEventListener() {}, removeEventListener() {} };
  const fetch = async () => new Promise(() => {});
  const card = C.createCard({ doc, win, fetch, records: () => RECORDS, me: ADMIN, agentsList: () => agentsFix(), subscribe: () => () => {}, help: null, firstRows: { role: ['OPT-0005'] }, setTimeout: () => {}, requestMs: 30,
    rows: new Map([['OPT-0005', { get: () => ({ value: '', display: '' }), control: { type: 'text' }, save: async (a, v, ctx) => { const f = await ctx.fresh(); return f ? { ok: true } : { ok: false, error: 'no fresh' }; } }]]) });
  await card.open('harbor', { section: 'role' });
  const input = all(rowOf(card.el(), 'OPT-0005'), 'input')[0];
  input.value = 'x'; input.dispatch('change');
  await new Promise((r) => setTimeout(r, 100)); await flush();
  assert.strictEqual(card.state().saving.size, 0);
  assert.match(rowOf(card.el(), 'OPT-0005').textContent, /no fresh/);
});

test('an invalid number clears its draft: the stored value shows again, with the error', async () => {
  const rows = new Map([['OPT-0066', { get: (a) => ({ value: 5, display: '5' }), control: { type: 'number' }, save: async () => ({ ok: true }) }]]);
  const t = setup({ rows, firstRows: { basics: ['OPT-0066'] } });
  await t.card.open('harbor', { section: 'basics' });
  const input = all(rowOf(t.card.el(), 'OPT-0066'), 'input')[0];
  input.focus(); input.value = 'abc'; input.dispatch('change'); await flush();
  const now = all(rowOf(t.card.el(), 'OPT-0066'), 'input')[0];
  assert.strictEqual(now.value, '5', 'the bad draft is gone');
  assert.match(rowOf(t.card.el(), 'OPT-0066').textContent, /Enter a number\./);
  assert.strictEqual(t.calls.filter((c) => c.method === 'PATCH').length, 0);
});

test('desktop Escape with typed, unsaved text commits it first, then closes', async () => {
  const saved = [];
  const t = setup({ rows: TEXT_ROW(saved), firstRows: { role: ['OPT-0005'] } });
  await t.card.open('harbor', { section: 'role' });
  const input = all(rowOf(t.card.el(), 'OPT-0005'), 'input')[0];
  input.focus(); input.value = 'typed then escape';
  t.card.el().dispatch('keydown', { key: 'Escape' });
  assert.strictEqual(t.card.isOpen(), true, 'still open while the save runs');
  await new Promise((r) => setTimeout(r, 30)); await flush();
  assert.strictEqual(t.card.isOpen(), false, 'closed after the save');
  assert.deepStrictEqual(saved, ['typed then escape'], 'the row save ran with the typed text');
  assert.strictEqual(t.state.agents[1].blurb, 'typed then escape', 'and the request went to the agent');
  // untouched text: Escape just closes, nothing is saved
  const t2 = setup({ rows: TEXT_ROW(saved), firstRows: { role: ['OPT-0005'] } });
  await t2.card.open('harbor', { section: 'role' });
  saved.length = 0;
  t2.card.el().dispatch('keydown', { key: 'Escape' });
  assert.deepStrictEqual(saved, []);
});

const wait = async (ms) => { await new Promise((r) => setTimeout(r, ms)); await flush(); };

test('R3-7: Escape with a failing save keeps the card open with the typed draft and the error; the next Escape (nothing failing) closes', async () => {
  const saved = [];
  const t = setup({ rows: TEXT_ROW(saved), firstRows: { role: ['OPT-0005'] } });
  await t.card.open('harbor', { section: 'role' });
  t.state.fail = 'That is too long.';
  const input = all(rowOf(t.card.el(), 'OPT-0005'), 'input')[0];
  input.focus(); input.value = 'my long draft';
  t.card.el().dispatch('keydown', { key: 'Escape' });
  await wait(30);
  assert.strictEqual(t.card.isOpen(), true, 'the card stays open');
  const row = rowOf(t.card.el(), 'OPT-0005');
  assert.strictEqual(all(row, '.ac-err')[0].textContent, 'That is too long.', 'the error shows');
  assert.strictEqual(all(row, 'input')[0].value, 'my long draft', 'the draft is still there');
  assert.strictEqual(t.state.agents[1].blurb, 'Keeps notes', 'nothing was saved');
  t.state.fail = null;
  t.card.el().dispatch('keydown', { key: 'Escape' });   // the draft is still unsaved: it saves now and the card closes
  await wait(30);
  assert.strictEqual(t.state.agents[1].blurb, 'my long draft');
  assert.strictEqual(t.card.isOpen(), false);
});

test('R3-7: Escape with two typed rows saves them one at a time in order, and stops at the first failure', async () => {
  const order = []; let failSecond = true;
  const mkRow = (id, field) => [id, { get: (a) => ({ value: a[field] || '', display: a[field] || '' }), control: { type: 'text' },
    save: async (a, v, ctx) => { order.push(id); if (id === 'OPT-0041' && failSecond) return { ok: false, error: 'No.' }; return ctx.patch({ [field]: v }); } }];
  const t = setup({ rows: new Map([mkRow('OPT-0040', 'blurb'), mkRow('OPT-0041', 'tagline')]), firstRows: { memory: ['OPT-0040', 'OPT-0041'] } });
  await t.card.open('harbor', { section: 'memory' });
  const a = all(rowOf(t.card.el(), 'OPT-0040'), 'input')[0]; a.value = 'one';
  const b = all(rowOf(t.card.el(), 'OPT-0041'), 'input')[0]; b.value = 'two';
  t.card.el().dispatch('keydown', { key: 'Escape' });
  await wait(40);
  assert.deepStrictEqual(order, ['OPT-0040', 'OPT-0041'], 'in order, one at a time');
  assert.strictEqual(t.card.isOpen(), true, 'the second failed: the card stays');
  assert.strictEqual(t.state.agents[1].blurb, 'one');
  assert.strictEqual(all(rowOf(t.card.el(), 'OPT-0041'), 'input')[0].value, 'two', 'its draft stays');
  failSecond = false;
  t.card.el().dispatch('keydown', { key: 'Escape' });
  await wait(40);
  assert.strictEqual(t.card.isOpen(), false);
  assert.strictEqual(t.state.agents[1].tagline, 'two');
});

test('R3-6: a PATCH whose body never arrives is given up after the time limit: unlocks with a message and re-reads the row', async () => {
  const saved = [];
  const t = setup({ requestMs: 40, rows: TEXT_ROW(saved), firstRows: { role: ['OPT-0005'] } });
  await t.card.open('harbor', { section: 'role' });
  t.state.hangBody = true;
  const before = t.fetchCount();
  const input = all(rowOf(t.card.el(), 'OPT-0005'), 'input')[0];
  input.value = 'x'; input.dispatch('change'); await flush();
  assert.ok(all(t.card.el(), 'input').every((e) => e.disabled === true), 'locked while waiting');
  await wait(120);
  assert.strictEqual(t.card.state().saving.size, 0, 'unlocked');
  assert.ok(all(t.card.el(), 'input').every((e) => !e.disabled));
  assert.match(rowOf(t.card.el(), 'OPT-0005').textContent, /did not answer in time/);
  assert.ok(t.fetchCount() > before, 'the row was read again');
});

test('R3-6: a post-save refresh that never answers (headers or body) unlocks after the limit with a message', async () => {
  for (const mode of ['hangGet', 'hangGetBody']) {
    const saved = [];
    const t = setup({ requestMs: 40, rows: TEXT_ROW(saved), firstRows: { role: ['OPT-0005'] } });
    await t.card.open('harbor', { section: 'role' });
    t.state[mode] = true;
    const input = all(rowOf(t.card.el(), 'OPT-0005'), 'input')[0];
    input.value = 'x'; input.dispatch('change'); await flush();
    assert.ok(all(t.card.el(), 'input').every((e) => e.disabled === true), mode + ': locked while waiting');
    await wait(120);
    assert.strictEqual(t.card.state().saving.size, 0, mode + ': unlocked');
    assert.ok(all(t.card.el(), 'input').every((e) => !e.disabled), mode);
    assert.match(rowOf(t.card.el(), 'OPT-0005').textContent, /did not answer in time/, mode);
  }
});

test('R4-2: Escape joining a save that is running and fails keeps the submitted text in the row, under the error', async () => {
  const saved = [];
  const t = setup({ rows: TEXT_ROW(saved), firstRows: { role: ['OPT-0005'] } });
  await t.card.open('harbor', { section: 'role' });
  let release; t.state.gate = new Promise((r) => { release = r; });
  t.state.fail = 'That is too long.';
  const input = all(rowOf(t.card.el(), 'OPT-0005'), 'input')[0];
  input.value = 'the submitted text'; input.dispatch('change'); await flush();
  assert.strictEqual(t.card.state().saving.size, 1, 'the save is running');
  t.card.el().dispatch('keydown', { key: 'Escape' });   // joins it
  await flush();
  release(); await wait(30);
  assert.strictEqual(t.card.isOpen(), true, 'the card stays open');
  const row = rowOf(t.card.el(), 'OPT-0005');
  assert.strictEqual(all(row, '.ac-err')[0].textContent, 'That is too long.');
  assert.strictEqual(all(row, 'input')[0].value, 'the submitted text', 'the text is still there');
  assert.strictEqual(t.state.agents[1].blurb, 'Keeps notes');
});

test('R4-3: a PATCH that timed out whose recovery read also times out says the change could not be confirmed', async () => {
  const saved = [];
  const t = setup({ requestMs: 40, rows: TEXT_ROW(saved), firstRows: { role: ['OPT-0005'] } });
  await t.card.open('harbor', { section: 'role' });
  t.state.hang = true; t.state.hangGet = true;
  const input = all(rowOf(t.card.el(), 'OPT-0005'), 'input')[0];
  input.value = 'x'; input.dispatch('change'); await flush();
  await wait(200);
  assert.strictEqual(t.card.state().saving.size, 0, 'unlocked');
  const text = all(rowOf(t.card.el(), 'OPT-0005'), '.ac-err')[0].textContent;
  assert.strictEqual(text, 'The change could not be confirmed; reopen the card to see what the hub has.');
  assert.ok(!/shows what the hub has now/.test(text));
});

test('R5-1: a save that timed out whose recovery read gets a 503 (the cached roster is used) does not say the row shows what the hub has', async () => {
  const saved = [];
  const t = setup({ requestMs: 40, rows: TEXT_ROW(saved), firstRows: { role: ['OPT-0005'] } });
  await t.card.open('harbor', { section: 'role' });
  t.state.hang = true; t.state.get503 = true;
  const input = all(rowOf(t.card.el(), 'OPT-0005'), 'input')[0];
  input.value = 'x'; input.dispatch('change'); await flush();
  await wait(200);
  assert.strictEqual(t.card.state().saving.size, 0, 'unlocked');
  const text = all(rowOf(t.card.el(), 'OPT-0005'), '.ac-err')[0].textContent;
  assert.strictEqual(text, 'The change could not be confirmed; reopen the card to see what the hub has.');
  assert.ok(!/shows what the hub has now/.test(text));
});

test('R5-1: a recovery read that a newer refresh superseded does not claim the shown value is current', async () => {
  const saved = [];
  const t = setup({ requestMs: 40, rows: TEXT_ROW(saved), firstRows: { role: ['OPT-0005'] } });
  await t.card.open('harbor', { section: 'role' });
  t.state.hang = true;
  let release; t.state.gateGet = new Promise((r) => { release = r; });
  const input = all(rowOf(t.card.el(), 'OPT-0005'), 'input')[0];
  input.value = 'x'; input.dispatch('change'); await flush();
  await wait(55);   // the save timed out (40 ms); the recovery read is waiting on the gate, still inside its own limit
  t.emit('agent_updated', { agent: 'harbor', changed: ['blurb'] });   // a newer refresh
  await flush();
  release(); await wait(60);
  const text = all(rowOf(t.card.el(), 'OPT-0005'), '.ac-err')[0].textContent;
  assert.strictEqual(text, 'The change could not be confirmed; reopen the card to see what the hub has.');
});

test('R3-5: a superseded open() resolves "superseded", a denial false; app.js and mobile.js do nothing on it', async () => {
  const fs = require('node:fs'); const path = require('node:path');
  for (const f of ['app.js', 'mobile.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.match(src, /p\.then\(ok => \{ if \(ok === 'superseded'\) return;/, f + ' returns on superseded');
  }
  // the behaviour of those handlers, run on the three results
  const run = (ok) => { const log = []; const h = (ok2) => { if (ok2 === 'superseded') return; if (ok2 === false) log.push('fallback'); }; h(ok); return log; };
  assert.deepStrictEqual(run('superseded'), []);
  assert.deepStrictEqual(run(false), ['fallback']);
  assert.deepStrictEqual(run(true), []);
});

test('after a keyboard save the focus is back on the row\'s control (disabling it had dropped the focus)', async () => {
  const rows = new Map([['OPT-0040', {
    get: (a) => ({ value: (a.compaction && a.compaction.mode) || '', display: '' }), control: { type: 'select', options: () => [{ value: '', label: 'a' }, { value: 'on', label: 'On' }] },
    save: async (agent, value, ctx) => { ctx.doc.activeElement = ctx.doc.body; return ctx.patch({ compaction: { mode: value } }); },   // the browser drops the focus of a control that gets disabled
  }]]);
  const t = setup({ rows, firstRows: { memory: ['OPT-0040'] } });
  await t.card.open('harbor', { section: 'memory' });
  const sel = all(rowOf(t.card.el(), 'OPT-0040'), 'select')[0];
  sel.focus(); sel.value = 'on'; sel.dispatch('change'); await flush();
  const now = all(rowOf(t.card.el(), 'OPT-0040'), 'select')[0];
  assert.strictEqual(t.doc.activeElement, now, 'the focus is on the redrawn control');
  assert.ok(!now.disabled);
});

test('configure({guard}) reaches the page\'s card: on a phone the sheet opens through that guard, and a later configure does not orphan an open card', async () => {
  const doc = makeDoc();
  const saved = global.document;
  global.document = doc;
  const guard = { opened: [], closed_: [], open(el, o) { this.opened.push({ el, o }); }, closed(el) { this.closed_.push(el); }, requestClose() { return 'confirm'; } };
  try {
    C.configure({ guard, phone: true, records: () => RECORDS, me: ADMIN, agentsList: () => agentsFix(), subscribe: () => () => {}, help: null, firstRows: FIRST, fetch: async () => resp(404, {}), simple: false });
    assert.strictEqual(await C.open('harbor'), true);
    assert.strictEqual(guard.opened.length, 1, 'the sheet is registered with the configured guard');
    assert.strictEqual(C.isOpen(), true);
    const guard2 = { opened: [], closed_: [], open() {}, closed() {}, requestClose() { return 'closed'; } };
    C.configure({ guard: guard2 });   // while open: the open card is not dropped
    assert.strictEqual(C.isOpen(), true);
    assert.strictEqual(C.requestClose('close'), 'confirm', 'the open sheet keeps the guard it was registered with');
    assert.strictEqual(guard2.opened.length, 0);
  } finally {
    C.close(false); C.configure({ guard: null, phone: undefined, records: undefined, me: undefined, agentsList: undefined, subscribe: undefined, help: undefined, firstRows: undefined, fetch: undefined, simple: undefined });
    if (saved === undefined) delete global.document; else global.document = saved;
  }
});

// ---- the 'editor' control: a long text kept in a file ---------------------------------------------------------------------
const editorRows = (o = {}) => {
  const log = { loads: 0, saves: [], confirmFor: [] };
  const def = {
    get: () => ({ value: '', display: '' }), control: { type: 'editor' },
    load: async () => { log.loads++; if (o.loadFails) throw new Error('the file is not readable'); return o.text === undefined ? 'first line\nsecond line' : o.text; },
    save: async (agent, text) => { log.saves.push(text); return o.saveFails ? { ok: false, error: 'the disk is full' } : { ok: true }; },
    confirm: o.confirm,
  };
  return { log, rows: new Map([['OPT-0047', def]]) };
};
const edBtn = (row, text) => all(row, 'button').find((b) => b.textContent === text);
const edArea = (row) => all(row, 'textarea')[0];
const typed = (ta, v) => { ta.value = v; ta.dispatch('input'); };
async function editorCard(o, over) {
  const e = editorRows(o);
  const t = setup(Object.assign({ rows: e.rows }, over || {}));
  const confirms = [];
  t.win.confirm = (q) => { confirms.push(q); return (o && o.answer) !== false; };
  await t.card.open('harbor', { section: 'basics' });
  return Object.assign(t, e, { confirms, row: () => rowOf(t.card.el(), 'OPT-0047') });
}

test('editor: an Edit button opens a textarea (monospace, 12 rows) with the loaded text; Save calls save(agent, text) and closes; Cancel closes with no save', async () => {
  const t = await editorCard();
  assert.ok(edBtn(t.row(), 'Edit') && !edArea(t.row()), 'closed: only the Edit button');
  assert.strictEqual(t.log.loads, 0, 'nothing is loaded before Edit');
  edBtn(t.row(), 'Edit').click();
  assert.match(t.row().textContent, /Loading…/, 'Loading… while it loads');
  await flush();
  const ta = edArea(t.row());
  assert.strictEqual(ta.value, 'first line\nsecond line');
  assert.strictEqual(ta.getAttribute('rows'), '12');
  assert.strictEqual(ta.getAttribute('class'), 'ac-textarea', 'its look (monospace, full width) comes from the pages\' .ac-textarea rule');
  for (const page of ['index.html', 'mobile.html']) assert.match(require('fs').readFileSync(require('path').join(__dirname, '..', page), 'utf8'), /\.ac-textarea \{[^}]*font-family: var\(--font-mono\)/, page);
  assert.ok(t.row().classList.contains('ac-editor-open'));
  typed(ta, 'new text');
  edBtn(t.row(), 'Save').click(); await flush();
  assert.deepStrictEqual(t.log.saves, ['new text']);
  assert.ok(!edArea(t.row()) && edBtn(t.row(), 'Edit'), 'closed after the save');
  edBtn(t.row(), 'Edit').click(); await flush();
  edBtn(t.row(), 'Cancel').click(); await flush();
  assert.deepStrictEqual(t.log.saves, ['new text'], 'Cancel saved nothing');
  assert.ok(!edArea(t.row()));
});

test('editor: a load that fails shows its error and no textarea; a save that fails keeps the typed text and shows the error', async () => {
  const bad = await editorCard({ loadFails: true });
  edBtn(bad.row(), 'Edit').click(); await flush();
  assert.match(bad.row().textContent, /the file is not readable/);
  assert.ok(!edArea(bad.row()) && !edBtn(bad.row(), 'Save'), 'nothing to save when the text did not load');
  edBtn(bad.row(), 'Cancel').click(); await flush();
  assert.ok(edBtn(bad.row(), 'Edit'));
  const t = await editorCard({ saveFails: true });
  edBtn(t.row(), 'Edit').click(); await flush();
  typed(edArea(t.row()), 'my work');
  edBtn(t.row(), 'Save').click(); await flush();
  assert.strictEqual(edArea(t.row()).value, 'my work', 'the text stays');
  assert.match(t.row().textContent, /the disk is full/);
  assert.ok(!edArea(t.row()).disabled && !edBtn(t.row(), 'Save').disabled, 'controls are back after the failure');
});

test('editor: the typed text survives a redraw of the card (a refresh)', async () => {
  const t = await editorCard();
  edBtn(t.row(), 'Edit').click(); await flush();
  typed(edArea(t.row()), 'half-written');
  await t.card.refresh(); await flush();
  assert.strictEqual(edArea(t.row()).value, 'half-written');
});

test('S6: the editor keeps its caret, selection and scroll position across a redraw, and starts clean when opened again', async () => {
  const t = await editorCard();
  edBtn(t.row(), 'Edit').click(); await flush();
  const ta = edArea(t.row());
  typed(ta, 'a long text that is being edited');
  ta.selectionStart = 7; ta.selectionEnd = 11; ta.scrollTop = 120; ta.dispatch('keyup');
  await t.card.refresh(); await flush();
  const ta2 = edArea(t.row());
  assert.notStrictEqual(ta2, ta, 'a new element was drawn');
  assert.deepStrictEqual([ta2.selectionStart, ta2.selectionEnd, ta2.scrollTop], [7, 11, 120]);
  edBtn(t.row(), 'Cancel').click(); await flush();
  edBtn(t.row(), 'Edit').click(); await flush();
  assert.strictEqual(edArea(t.row()).scrollTop, 0, 'a fresh editor does not inherit the old position');
});

test('S4: a save that answers { ok:true, declined:true } shows "Not changed." under the row; the next save clears it', async () => {
  let answer = { ok: true, declined: true };
  const def = { get: () => ({ value: 'a', display: 'A' }), control: { type: 'text', max: 20 }, save: async () => answer };
  const t = setup({ rows: new Map([['OPT-0047', def]]) });
  await t.card.open('harbor', { section: 'basics' });
  const row = () => rowOf(t.card.el(), 'OPT-0047');
  const input = all(row(), 'input')[0];
  input.value = 'b'; input.dispatch('change'); await flush();
  assert.match(row().textContent, /Not changed\./);
  answer = { ok: true };
  all(row(), 'input')[0].value = 'c'; all(row(), 'input')[0].dispatch('change'); await flush();
  assert.doesNotMatch(row().textContent, /Not changed\./);
});

test('editor: confirm (a text or a function of the agent) is asked before saving; "no" saves nothing and keeps the text', async () => {
  const t = await editorCard({ confirm: (agent) => 'Change ' + agent.display + '?', answer: false });
  edBtn(t.row(), 'Edit').click(); await flush();
  typed(edArea(t.row()), 'x');
  edBtn(t.row(), 'Save').click(); await flush();
  assert.deepStrictEqual(t.confirms, ['Change Harbor?']);
  assert.deepStrictEqual(t.log.saves, []);
  assert.strictEqual(edArea(t.row()).value, 'x');
  const y = await editorCard({ confirm: 'Sure?' });
  edBtn(y.row(), 'Edit').click(); await flush();
  typed(edArea(y.row()), 'y');
  edBtn(y.row(), 'Save').click(); await flush();
  assert.deepStrictEqual(y.confirms, ['Sure?']);
  assert.deepStrictEqual(y.log.saves, ['y']);
});

test('editor: closing the card (× or Escape) with unsaved editor text asks first; "keep" leaves the card open with the text, "discard" closes; no question when nothing was typed', async () => {
  const t = await editorCard({ answer: false });
  edBtn(t.row(), 'Edit').click(); await flush();
  all(t.card.el(), '.ac-x')[0].click();
  assert.strictEqual(t.card.isOpen(), false, 'nothing typed: closes at once');
  assert.strictEqual(t.confirms.length, 0);
  const k = await editorCard({ answer: false });
  edBtn(k.row(), 'Edit').click(); await flush();
  typed(edArea(k.row()), 'precious');
  all(k.card.el(), '.ac-x')[0].click(); await flush();
  assert.strictEqual(k.confirms.length, 1);
  assert.match(k.confirms[0], /unsaved text/);
  assert.strictEqual(k.card.isOpen(), true, 'kept open');
  assert.strictEqual(edArea(k.row()).value, 'precious');
  k.card.el().dispatch('keydown', { key: 'Escape' }); await flush();
  assert.strictEqual(k.confirms.length, 2, 'Escape asks too');
  assert.strictEqual(k.card.isOpen(), true);
  k.win.confirm = () => true;   // discard
  k.card.el().dispatch('keydown', { key: 'Escape' }); await flush();
  assert.strictEqual(k.card.isOpen(), false);
  // opening another agent's card does not silently drop the text either
  const o = await editorCard({ answer: false });
  edBtn(o.row(), 'Edit').click(); await flush();
  typed(edArea(o.row()), 'still here');
  assert.strictEqual(await o.card.open('quill', {}), 'superseded');
  assert.strictEqual(o.card.el().getAttribute('data-agent'), 'harbor');
});

test('editor: on the phone the dialog guard owns the close question (the card does not ask a second one)', async () => {
  const t = await editorCard({ answer: false }, { phone: true });
  edBtn(t.row(), 'Edit').click(); await flush();
  typed(edArea(t.row()), 'abc');
  all(t.card.el(), '.ac-x')[0].click();
  assert.deepStrictEqual(t.guard.requests.map((r) => r.how), ['close']);
  assert.strictEqual(t.confirms.length, 0);
});

test('editor: while a save is running the textarea and buttons are disabled', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const e = editorRows();
  e.rows.get('OPT-0047').save = async (agent, text) => { await gate; e.log.saves.push(text); return { ok: true }; };
  const t = setup({ rows: e.rows });
  await t.card.open('harbor', { section: 'basics' });
  const row = () => rowOf(t.card.el(), 'OPT-0047');
  edBtn(row(), 'Edit').click(); await flush();
  typed(edArea(row()), 'slow');
  edBtn(row(), 'Save').click(); await flush();
  assert.ok(edArea(row()).disabled && edBtn(row(), 'Cancel').disabled, 'locked while saving');
  release(); await flush();
  assert.deepStrictEqual(e.log.saves, ['slow']);
  assert.ok(!edArea(row()));
});
