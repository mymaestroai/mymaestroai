'use strict';
// The pages for the lead's settings tool (phase 2, part C2): the fixed confirm card, the change strip with Undo, the doors
// (#settings-for= and #rec=), and Recent changes. The shared functions in lib/ui-settings-help.js run against a small fake DOM
// (no browser); the page wiring is pinned with source checks. Offline; reads no data/.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const H = require('../lib/ui-settings-help.js');

// ---- a fake DOM (as in test/ui-settings-help.test.js) ------------------------------------------------------------------
class El {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase(); this.ownerDocument = doc; this.attrs = {}; this.children = []; this.parentNode = null;
    this.listeners = {}; this._text = ''; this.style = {}; this.dataset = {}; this.value = ''; this.hidden = false; this.disabled = false;
    this.scrolled = 0;
  }
  get className() { return this.attrs.class || ''; }
  set className(v) { this.attrs.class = String(v); }
  get classList() {
    const el = this;
    const list = () => String(el.attrs.class || '').split(/\s+/).filter(Boolean);
    return {
      add: (c) => { const l = list(); if (!l.includes(c)) l.push(c); el.attrs.class = l.join(' '); },
      remove: (c) => { el.attrs.class = list().filter((x) => x !== c).join(' '); },
      contains: (c) => list().includes(c),
    };
  }
  get id() { return this.attrs.id || ''; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { for (const c of this.children) c.parentNode = null; this.children = []; this._text = String(v); }
  get nextSibling() { const p = this.parentNode; if (!p) return null; return p.children[p.children.indexOf(this) + 1] || null; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
    return c;
  }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
  async click() { for (const fn of [...(this.listeners.click || [])]) await fn({ type: 'click', target: this, preventDefault() {}, stopPropagation() {} }); }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() { this.scrolled++; }
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
  querySelectorAll(sel) { return [...this.walk()].filter((e) => sel.split(',').some((s) => matchChain(e, s.trim(), this))); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
function matchOne(el, simple) {
  if (simple === '*') return true;
  const re = /([#.])([\w-]+)|\[([\w-]+)(?:="?([^"\]]*)"?)?\]|^([a-zA-Z][\w-]*)/g;
  let m; let any = false;
  while ((m = re.exec(simple))) {
    any = true;
    if (m[5]) { if (el.tagName !== m[5].toUpperCase()) return false; }
    else if (m[1] === '#') { if (el.id !== m[2]) return false; }
    else if (m[1] === '.') { if (!el.classList.contains(m[2])) return false; }
    else if (m[3]) { const v = el.getAttribute(m[3]); if (v === null || (m[4] !== undefined && v !== m[4])) return false; }
  }
  return any;
}
function matchChain(el, sel, scope) {
  const parts = sel.split(/\s+/);
  if (!matchOne(el, parts[parts.length - 1])) return false;
  let n = el.parentNode;
  for (let i = parts.length - 2; i >= 0; i--) {
    while (n && n !== scope && !matchOne(n, parts[i])) n = n.parentNode;
    if (!n || n === scope) return false;
    n = n.parentNode;
  }
  return true;
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
const el = (doc, tag, attrs = {}, text = '') => { const e = doc.createElement(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text) e.textContent = text; return e; };
const store = () => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, raw: m }; };
const NOW = 1800000000000;
const HOUR = 3600000;
// a fetch that answers by route: routes[`${method} ${path}`] = { status, body } (the query is ignored in the key)
function fakeFetch(routes, calls) {
  return async (url, o) => {
    const method = (o && o.method) || 'GET';
    const key = method + ' ' + String(url).split('?')[0];
    calls.push({ method, url: String(url) });
    const r = routes[key];
    if (!r) return { ok: false, status: 404, json: async () => ({ error: 'none' }) };
    const x = typeof r === 'function' ? r(url, o) : r;
    return { ok: x.status >= 200 && x.status < 300, status: x.status, json: async () => x.body };
  };
}
const entry = (n, over = {}) => ({ id: 'sj-' + String(n).padStart(10, '0'), at: NOW - n * 60000, record: 'OPT-0' + n, name: 'Setting ' + n, agentName: null, before: false, after: true, restorable: true, undoUntil: NOW + 23 * HOUR, ...over });

// ---- 1. the fixed confirm card ------------------------------------------------------------------------------------------
test('fixedRows: Setting, For, Now, After, What it means, and the restart line only when it is needed', () => {
  const rows = H.fixedRows({ name: 'Voice replies', agent: 'Hazel', before: false, after: true, meaning: 'Hazel speaks her answers.', restart: true });
  assert.deepStrictEqual(rows.map((r) => r[0]), ['Setting', 'For', 'Now', 'After', 'What it means', '']);
  assert.deepStrictEqual(rows[2], ['Now', 'off']);
  assert.deepStrictEqual(rows[3], ['After', 'on']);
  assert.strictEqual(rows[5][1], 'Needs a restart to take effect');
  const plain = H.fixedRows({ name: 'Theme', agent: null, before: 'dark', after: 'light', meaning: 'Colours.', restart: false });
  assert.ok(!plain.some((r) => r[0] === 'For') && !plain.some((r) => /restart/.test(r[1])));
  assert.strictEqual(H.isFixedCard({ fixed: true, change: { name: 'x' } }), true);
  assert.strictEqual(H.isFixedCard({ fixed: false, change: { name: 'x' } }), false);
  assert.strictEqual(H.isFixedCard({ fixed: true }), false);
  assert.strictEqual(H.isFixedCard({ questions: [] }), false);
});

test('desktop and phone: a fixed card has no text box and no "type an answer", only Confirm and Cancel, and carries fixed/change through every path', () => {
  const app = read('app.js');
  const a0 = app.indexOf('function showQuestionModal(');
  const a1 = app.indexOf('function askFromStream(', a0);
  const body = app.slice(a0, a1);
  const f0 = body.indexOf('if (fixed) {');
  const f1 = body.indexOf('return;\n        }', f0);
  assert.ok(f0 > 0 && f1 > f0, 'the fixed branch is there');
  const branch = body.slice(f0, f1);
  assert.ok(!/textarea|type an answer|type your/i.test(branch), 'no text box in the desktop card');
  assert.ok(/Confirm/.test(branch) && /Cancel/.test(branch) && /fixedRows\(data\.change\)/.test(branch));
  assert.ok(branch.includes("submitAnswers({ '0': fixedBtn('Confirm') })") && branch.includes("submitAnswers({ '0': fixedBtn('Cancel') })"));
  assert.match(app, /ev\.fixed === true \? \{ fixed: true, change: ev\.change \}/, 'the /api/events question keeps fixed and change');
  const mob = read('mobile.js');
  const m0 = mob.indexOf('function showQuestion(data, onAnswered)');
  const m1 = mob.indexOf('const isSkip', m0);
  const mbranch = mob.slice(m0, m1).slice(mob.slice(m0, m1).indexOf('FH.isFixedCard(data)'));
  assert.ok(mbranch.length > 100 && !/textarea|qcustom|type your/i.test(mbranch), 'no text box in the phone card');
  assert.ok(/'Confirm'/.test(mbranch) && /'Cancel'/.test(mbranch) && /FH\.fixedRows\(data\.change\)/.test(mbranch));
  assert.match(mob, /ev\.fixed === true \? \{ fixed: true, change: ev\.change \}/, 'the phone keeps fixed and change from the ask_user event');
});

// ---- 2. the change strip -----------------------------------------------------------------------------------------------
test('the strip draws one line per change of the last 24 h: "Changed <name> for <agent>: <before> → <after>." with Undo', async () => {
  const doc = makeDoc(); const host = el(doc, 'div'); doc.body.appendChild(host);
  const calls = [];
  const entries = [
    entry(1, { name: 'Voice replies', agentName: 'Hazel', before: false, after: true }),
    entry(2, { name: 'Notify me when done', before: 'off', after: 'on' }),
    entry(3, { at: NOW - 25 * HOUR }),   // older than a day: not shown
  ];
  const ok = await H.stripLoad(host, { doc, now: () => NOW, storage: store(), fetch: fakeFetch({ 'GET /api/settings-journal': { status: 200, body: { ok: true, entries } } }, calls) });
  assert.strictEqual(ok, true);
  assert.match(calls[0].url, /by=lead&since=\d+/);
  assert.strictEqual(Number(/since=(\d+)/.exec(calls[0].url)[1]), NOW - 24 * HOUR);
  const lines = host.querySelectorAll('.change-text').map((e) => e.textContent);
  assert.deepStrictEqual(lines, ['Changed Voice replies for Hazel: off → on.', 'Changed Notify me when done: off → on.']);
  assert.strictEqual(host.querySelectorAll('.change-undo').length, 2);
  assert.strictEqual(host.hidden, false);
});

test('Undo posts the restore and the line reads "Put back."; a 409 shows the server\'s own text and keeps the button', async () => {
  const doc = makeDoc(); const host = el(doc, 'div'); doc.body.appendChild(host);
  const calls = [];
  const e1 = entry(1), e2 = entry(2);
  const routes = {
    ['POST /api/settings-journal/' + e1.id + '/restore']: { status: 200, body: { ok: true } },
    ['POST /api/settings-journal/' + e2.id + '/restore']: { status: 409, body: { ok: false, status: 409, error: 'It has changed since, so it was left as it is.' } },
  };
  H.stripPaint(host, [e1, e2], { doc, now: () => NOW, storage: store(), fetch: fakeFetch(routes, calls) });
  const lines = host.querySelectorAll('.change-line');
  await lines[0].querySelector('.change-undo').click();
  assert.deepStrictEqual(calls[0], { method: 'POST', url: '/api/settings-journal/' + e1.id + '/restore' });
  assert.strictEqual(lines[0].querySelector('.change-text').textContent, 'Put back.');
  assert.strictEqual(lines[0].querySelectorAll('.change-undo').length, 0, 'no second Undo');
  await lines[1].querySelector('.change-undo').click();
  assert.strictEqual(lines[1].querySelector('.change-msg').textContent, 'It has changed since, so it was left as it is.');
  assert.strictEqual(lines[1].querySelectorAll('.change-undo').length, 1, 'the person may try again');
  assert.match(lines[1].querySelector('.change-text').textContent, /^Changed Setting 2/, 'the line itself is not rewritten by a refusal');
});

test('the strip never shows more than 5 lines (the newest) and says "and N more in Settings, Recent changes"', () => {
  const doc = makeDoc(); const host = el(doc, 'div');
  const entries = []; for (let i = 1; i <= 8; i++) entries.push(entry(i, { id: 'sj-70000000' + String(i).padStart(2, '0') }));
  H.stripPaint(host, entries.reverse(), { doc, now: () => NOW, storage: store() });
  const lines = host.querySelectorAll('.change-text').map((e) => e.textContent);
  assert.strictEqual(lines.length, 5);
  assert.strictEqual(lines[0], 'Changed Setting 1: off → on.', 'newest first');
  assert.strictEqual(lines[4], 'Changed Setting 5: off → on.');
  assert.strictEqual(host.querySelector('.change-more').textContent, 'and 3 more in Settings, Recent changes');
  assert.strictEqual(H.STRIP_MAX, 5);
});

test('the × dismisses the strip and remembers the ids; a later load does not bring those back, a newer change shows', async () => {
  const doc = makeDoc(); const host = el(doc, 'div'); const st = store();
  const first = [entry(1), entry(2)];
  H.stripPaint(host, first, { doc, now: () => NOW, storage: st });
  await host.querySelector('.change-x').click();
  assert.strictEqual(host.hidden, true);
  assert.strictEqual(host.children.length, 0);
  const saved = JSON.parse(st.raw['mm-settings-strip-dismissed']);
  assert.deepStrictEqual(saved.sort(), first.map((e) => e.id).sort());
  H.stripPaint(host, first, { doc, now: () => NOW, storage: st });
  assert.strictEqual(host.hidden, true, 'still dismissed after a reload');
  H.stripPaint(host, first.concat([entry(0, { name: 'Brand new' })]), { doc, now: () => NOW, storage: st });
  assert.deepStrictEqual(host.querySelectorAll('.change-text').map((e) => e.textContent), ['Changed Brand new: off → on.']);
});

test('page wiring: the strip is in the lead\'s chat on desktop and phone, loaded on open and on settings_changed', () => {
  const app = read('app.js'), mob = read('mobile.js'), html = read('mobile.html');
  assert.ok(app.includes('id="change-strip-${chatId}"') && app.includes("addEventListener('settings_changed'") && app.includes('function changeStripRefresh()'));
  assert.ok(/changeStripRefresh\(\);\s*\/\/ what the lead changed/.test(app), 'refreshed when a chat opens');
  assert.ok(mob.includes("on('settings_changed'") && mob.includes('function changeStripLoad()') && html.includes('id="change-strip"'));
  assert.ok(/changeStripLoad\(\);\s*\/\/ what the lead changed/.test(mob), 'refreshed when the phone chat opens');
  assert.ok(mob.includes('stripLoad(host'), 'state comes from the journal route, not from the event');
});

// ---- 3. the doors ------------------------------------------------------------------------------------------------------
const REC = { version: 1, leadTool: true, records: [
  { id: 'OPT-0341', kind: 'setting', name: 'Provider keys', labels: ['Provider keys'], what: 'Keys.', home: 'Settings, AI models', anchors: [{ surface: 'desktop', selector: '#st-keys' }, { surface: 'agent-settings', selector: '#as-keys' }] },
  { id: 'OPT-0400', kind: 'setting', name: 'Elsewhere', labels: ['Elsewhere'], what: 'On another screen.', home: 'the Users page', anchors: [{ surface: 'users', selector: '#u-x' }] },
] };
function settingsPage() {
  const doc = makeDoc();
  const overlay = el(doc, 'div', { id: 'st-overlay' }); doc.body.appendChild(overlay);
  const group = el(doc, 'details', { class: 'st-group' }); overlay.appendChild(group);
  const sec = el(doc, 'div', { class: 'st-section' }); group.appendChild(sec);
  const row = el(doc, 'div', { class: 'st-row' }); sec.appendChild(row);
  row.appendChild(el(doc, 'label', { for: 'st-keys' }, 'Provider keys'));
  row.appendChild(el(doc, 'input', { id: 'st-keys' }));
  return { doc, overlay, group, row };
}
test('parseDoorHash accepts only #settings-for=OPT-… and #rec=OPT-… and nothing else', () => {
  assert.deepStrictEqual(H.parseDoorHash('#settings-for=OPT-0341'), { kind: 'settings-for', id: 'OPT-0341' });
  assert.deepStrictEqual(H.parseDoorHash('#rec=OPT-0341'), { kind: 'rec', id: 'OPT-0341' });
  assert.strictEqual(H.parseDoorHash('#rec=OPT-0341', 'settings-for'), null);
  for (const bad of ['', '#settings-for=', '#settings-for=<img>', '#settings-for=OPT-1&x', '#ask-lead=hi', '#settings-for=OPT-' + 'a'.repeat(60), null]) assert.strictEqual(H.parseDoorHash(bad), null, String(bad));
});

test('#settings-for=OPT-xxxx opens the group, scrolls to the row, lights it for 2 s and focuses its ⓘ', async () => {
  H.setRecords(JSON.parse(JSON.stringify(REC)));
  const p = settingsPage();
  const timers = [];
  let opened = null; const toasts = [];
  const ok = await H.doorFollow('#settings-for=OPT-0341', p.overlay, 'desktop', {
    opts: { doc: p.doc },
    open: (f) => { opened = f.row; p.group.open = true; },
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    notHere: (rec) => toasts.push(H.hereIs(rec)),
  }, 'settings-for');
  assert.strictEqual(ok, true);
  assert.strictEqual(opened, p.row, 'the group opener got the row');
  assert.strictEqual(p.group.open, true);
  assert.ok(p.row.scrolled >= 1, 'scrolled to');
  assert.ok(p.row.classList.contains('st-door-hit'), 'lit');
  const lightOff = timers.find((t) => t.ms === 2000); assert.ok(lightOff, 'the 2 s highlight timer'); assert.ok(timers.some((t) => t.ms === 150) && timers.some((t) => t.ms === 450), 'scrolls again after the group is laid out');
  lightOff.fn();
  assert.ok(!p.row.classList.contains('st-door-hit'), 'the light goes after 2 s');
  const info = p.doc.activeElement;
  assert.ok(info && info.tagName === 'BUTTON' && info.getAttribute('class') === 'st-info' && info.getAttribute('data-rec') === 'OPT-0341', 'the ⓘ has the focus');
  assert.deepStrictEqual(toasts, []);
});

test('the door scrolls again after the group opens, but not once the person has scrolled meanwhile (wheel, touch or key)', async () => {
  for (const ev of ['wheel', 'touchstart', 'keydown']) {
    H.setRecords(JSON.parse(JSON.stringify(REC)));
    const p = settingsPage();
    const timers = [];
    await H.doorFollow('#settings-for=OPT-0341', p.overlay, 'desktop', { opts: { doc: p.doc }, open: () => { p.group.open = true; }, setTimeout: (fn, ms) => timers.push({ fn, ms }) }, 'settings-for');
    assert.strictEqual(p.row.scrolled, 1, 'the first scroll');
    for (const fn of p.doc.listeners[ev] || []) fn({});
    assert.ok((p.doc.listeners[ev] || []).length > 0, `listens for ${ev}`);
    timers.find((t) => t.ms === 150).fn(); timers.find((t) => t.ms === 450).fn();
    assert.strictEqual(p.row.scrolled, 1, `no re-scroll after ${ev}`);
  }
  // without any scrolling by the person both later scrolls happen
  H.setRecords(JSON.parse(JSON.stringify(REC)));
  const p = settingsPage(); const timers = [];
  await H.doorFollow('#settings-for=OPT-0341', p.overlay, 'desktop', { opts: { doc: p.doc }, setTimeout: (fn, ms) => timers.push({ fn, ms }) }, 'settings-for');
  timers.find((t) => t.ms === 150).fn(); timers.find((t) => t.ms === 450).fn();
  assert.strictEqual(p.row.scrolled, 3);
});

test('R7 FU: the door takes its listeners off at once when the row is gone, and also at the last timer when it is not', async () => {
  const count = (doc) => Object.values(doc.listeners || {}).reduce((n, a) => n + a.length, 0);
  // the row goes (the group was re-drawn) before the first later scroll: no scroll, the listeners are off at that timer
  H.setRecords(JSON.parse(JSON.stringify(REC)));
  const p = settingsPage(); const timers = [];
  await H.doorFollow('#settings-for=OPT-0341', p.overlay, 'desktop', { opts: { doc: p.doc }, setTimeout: (fn, ms) => timers.push({ fn, ms }) }, 'settings-for');
  assert.ok(count(p.doc) > 0, 'listening while the door works');
  p.row.parentNode.removeChild(p.row);
  p.row.isConnected = false;   // this file's fake element has none; a real one reports it itself once detached
  timers.find((t) => t.ms === 150).fn();
  assert.strictEqual(count(p.doc), 0, 'off as soon as the row is seen gone');
  assert.strictEqual(p.row.scrolled, 1, 'no scroll to a row that is gone');
  timers.find((t) => t.ms === 450).fn();   // the last timer after that is harmless
  assert.strictEqual(count(p.doc), 0);
  // the row stays: the listeners stay until the last timer
  H.setRecords(JSON.parse(JSON.stringify(REC)));
  const q = settingsPage(); const t2 = [];
  await H.doorFollow('#settings-for=OPT-0341', q.overlay, 'desktop', { opts: { doc: q.doc }, setTimeout: (fn, ms) => t2.push({ fn, ms }) }, 'settings-for');
  t2.find((t) => t.ms === 150).fn();
  assert.ok(count(q.doc) > 0, 'still listening after the first timer');
  t2.find((t) => t.ms === 450).fn();
  assert.strictEqual(count(q.doc), 0, 'off at the last timer');
});

test('a record with no row on this surface: Settings stays at the top and the toast says where the setting is', async () => {
  H.setRecords(JSON.parse(JSON.stringify(REC)));
  const p = settingsPage();
  const toasts = [];
  const ok = await H.doorFollow('#settings-for=OPT-0400', p.overlay, 'desktop', { opts: { doc: p.doc }, notHere: (rec) => toasts.push(H.hereIs(rec)) }, 'settings-for');
  assert.strictEqual(ok, false);
  assert.deepStrictEqual(toasts, ['That setting is on the Users page']);
  assert.strictEqual(p.doc.activeElement, null);
  const none = [];
  await H.doorFollow('#settings-for=OPT-9999', p.overlay, 'desktop', { opts: { doc: p.doc }, notHere: (rec) => none.push(H.hereIs(rec)) }, 'settings-for');
  assert.deepStrictEqual(none, ['That setting is on its own screen']);
});

test('#rec=OPT-xxxx on the agent settings page finds the row by the same anchors', async () => {
  H.setRecords(JSON.parse(JSON.stringify(REC)));
  const doc = makeDoc();
  const sec = el(doc, 'div', { class: 'section' }); doc.body.appendChild(sec);
  sec.appendChild(el(doc, 'label', { for: 'as-keys' }, 'Provider keys'));
  const ctl = el(doc, 'input', { id: 'as-keys' }); sec.appendChild(ctl);
  const ok = await H.doorFollow('#rec=OPT-0341', doc.body, 'agent-settings', { opts: { doc }, setTimeout: () => 0 }, 'rec');
  assert.strictEqual(ok, true);
  assert.strictEqual(doc.activeElement.getAttribute('data-rec'), 'OPT-0341');
  assert.ok(sec.classList.contains('st-door-hit'));
});

test('page wiring: desktop and phone follow their doors; agent-settings.html redirects to them', () => {
  const app = read('app.js'), mob = read('mobile.js'), as = read('agent-settings.html');
  assert.ok(app.includes("parseDoorHash(h, 'settings-for')") && app.includes('settingsDoorStart();') && /settingsDoorStart\(\);\s*\/\/ the phone's/.test(app), 'the full page and the Settings frame');
  assert.ok(app.includes("open: (f) => stReveal(f.row)") && app.includes('hubToast(H.hereIs(rec)'), 'opens the group; a toast when the row is elsewhere');
  assert.ok(mob.includes('function settingsDoorPhone()') && mob.includes("'#settings-for=' + s.door") && mob.includes('settingsDoorPhone();   //'), 'the phone passes the door on to the frame');
  assert.ok(as.includes('agent-card=') && as.includes('settings-for=') && as.includes('/api/settings-records'), 'agent-settings #rec= goes to the card or to Settings (test/agent-settings-redirect.test.js)');
});

// ---- 4. Recent changes -------------------------------------------------------------------------------------------------
test('Recent changes: when, who, what, before → after, and a Restore button only where the entry can be put back', async () => {
  const doc = makeDoc(); const host = el(doc, 'div'); doc.body.appendChild(host);
  const calls = [];
  const list = [
    { id: 'sj-0000000001', at: NOW - 5 * 60000, who: { kind: 'person', user: 'u-owner' }, store: 'settings', key: 'voice.enabled', record: 'OPT-0100', before: false, after: true, restorable: true },
    { id: 'sj-0000000002', at: NOW - 2 * HOUR, who: { kind: 'hub' }, store: 'settings', key: 'a.b', record: null, before: 1, after: 2, restorable: true },
    { id: 'sj-0000000003', at: NOW - 3 * HOUR, who: { kind: 'update' }, store: 'settings', key: 'c.d', before: 'x', after: 'y', restorable: false },
    { id: 'sj-0000000004', at: NOW - 4 * HOUR, who: { kind: 'outside' }, store: 'settings', key: 'e.f', after: 'z', restorable: true },
    { id: 'sj-0000000005', at: NOW - 5 * HOUR, who: { kind: 'lead', agent: 'maestro' }, store: 'agents', key: 'agents.hazel.effort', record: 'OPT-0200', before: 'low', after: 'high', restorable: true },
  ];
  const env = {
    doc, now: () => NOW,
    fetch: fakeFetch({ 'GET /api/settings-journal': { status: 200, body: { ok: true, entries: list, next: 'sj-0000000005' } } }, calls),
    userName: (id) => (id === 'u-owner' ? 'Owner' : ''), agentName: (n) => (n === 'hazel' ? 'Hazel' : n), recordName: (id) => ({ 'OPT-0100': 'Voice replies', 'OPT-0200': 'Effort' }[id] || ''),
  };
  assert.strictEqual(await H.recentLoad(host, env), true);
  assert.match(calls[0].url, /limit=30/);
  const rows = host.querySelectorAll('.st-recent-row');
  assert.strictEqual(rows.length, 5);
  const t = (r, c) => r.querySelector('.' + c).textContent;
  assert.strictEqual(t(rows[0], 'st-recent-what'), 'Voice replies');
  assert.strictEqual(t(rows[0], 'st-recent-change'), 'off → on');
  assert.strictEqual(t(rows[0], 'st-recent-meta'), '5 min ago · Owner');
  assert.match(t(rows[1], 'st-recent-meta'), /your Maestro on start-up/);
  assert.strictEqual(t(rows[1], 'st-recent-what'), 'a.b');
  assert.match(t(rows[2], 'st-recent-meta'), /an update/);
  assert.match(t(rows[3], 'st-recent-meta'), /a program on this computer/);
  assert.strictEqual(t(rows[3], 'st-recent-change'), 'not set → z');
  assert.strictEqual(t(rows[4], 'st-recent-what'), 'Effort (Hazel)');
  assert.match(t(rows[4], 'st-recent-meta'), /Maestro$/);
  assert.deepStrictEqual(rows.map((r) => r.querySelectorAll('.st-recent-restore').length), [1, 1, 0, 1, 1]);
});

test('Recent changes: Restore puts it back or shows the 409 text inline; Load more asks by `before`', async () => {
  const doc = makeDoc(); const host = el(doc, 'div'); doc.body.appendChild(host);
  const calls = [];
  const page1 = []; for (let i = 1; i <= 30; i++) page1.push({ id: 'sj-' + String(i).padStart(10, '0'), at: NOW - i * 1000, who: { kind: 'person' }, store: 'settings', key: 'k' + i, before: 1, after: 2, restorable: true });
  const page2 = [{ id: 'sj-0000000099', at: NOW - 9 * HOUR, who: { kind: 'person' }, store: 'settings', key: 'older', before: 1, after: 2, restorable: false }];
  const routes = {
    'GET /api/settings-journal': (u) => (/before=/.test(u) ? { status: 200, body: { ok: true, entries: page2, next: 'sj-0000000099' } } : { status: 200, body: { ok: true, entries: page1, next: 'sj-0000000030' } }),
    'POST /api/settings-journal/sj-0000000001/restore': { status: 200, body: { ok: true } },
    'POST /api/settings-journal/sj-0000000002/restore': { status: 409, body: { ok: false, status: 409, error: 'It has changed since, so it was left as it is.' } },
  };
  const env = { doc, now: () => NOW, fetch: fakeFetch(routes, calls) };
  await H.recentLoad(host, env);
  const rows = host.querySelectorAll('.st-recent-row');
  await rows[0].querySelector('.st-recent-restore').click();
  assert.strictEqual(rows[0].querySelector('.st-recent-msg').textContent, 'Put back.');
  assert.strictEqual(rows[0].querySelectorAll('.st-recent-restore').length, 0);
  await rows[1].querySelector('.st-recent-restore').click();
  assert.strictEqual(rows[1].querySelector('.st-recent-msg').textContent, 'It has changed since, so it was left as it is.');
  assert.strictEqual(rows[1].querySelectorAll('.st-recent-restore').length, 1);
  await host.querySelector('.st-recent-more').click();
  await new Promise((r) => setTimeout(r, 0));
  const get = calls.filter((c) => c.method === 'GET').pop();
  assert.match(get.url, /before=sj-0000000030/);
  assert.strictEqual(host.querySelectorAll('.st-recent-row').length, 31);
  assert.strictEqual(host.querySelectorAll('.st-recent-more').length, 0, 'no more to load');
});

test('page wiring: Recent changes is a Settings section for admins, in the For your review group', () => {
  const app = read('app.js');
  assert.ok(app.includes('id="st-recent-section"') && app.includes('function stRecentLoad()'));
  assert.deepStrictEqual(require('../lib/ui-settings-groups.js').groupOfSection('st-recent-section'), { group: 'review', more: false });
  assert.ok(/if \(isHubAdmin\(\)\) \{\s*html \+= `<div class="st-section" id="st-recent-section">/.test(app), 'admins only');
});

// ---- 5. the rest ---------------------------------------------------------------------------------------------------------
test('the phone service worker is bumped (v99) and the new CSS uses only variables the pages define', () => {
  assert.match(read('sw.js'), /const VERSION = 'hub-mobile-v105'/);
  for (const f of ['index.html', 'mobile.html']) {
    const css = read(f);
    for (const sel of ['.change-strip', '.question-fixed']) assert.ok(css.includes(sel), f + ' has ' + sel);
    const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const block = css.split('\n').filter((l) => /change-strip|question-fixed|qcancel|question-cancel|st-recent|st-door-hit/.test(l)).join('\n');
    for (const v of new Set([...block.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))) assert.ok(defined.has(v), f + ' defines ' + v);
  }
  assert.ok(!new RegExp('[' + String.fromCharCode(0xfe0f, 0x200d) + ']').test(read('lib/ui-settings-help.js')), 'no invisible characters');
});
