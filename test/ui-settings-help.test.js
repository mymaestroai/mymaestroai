'use strict';
// lib/ui-settings-help.js: the ⓘ help beside a setting (attach, the panel and the sheet, "Who can change it", Ask Maestro,
// the #ask-lead address) and the search by other words. The real functions run against a small fake DOM (no browser, no
// jsdom); the page wiring is pinned with source checks. Offline; reads no data/.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const H = require('../lib/ui-settings-help.js');

// ---- a fake DOM: just what the helper and stSearch touch ---------------------------------------------------------------
class El {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase(); this.ownerDocument = doc; this.attrs = {}; this.children = []; this.parentNode = null;
    this.listeners = {}; this._text = ''; this.style = {}; this.dataset = {}; this.value = ''; this.open = false;
    this.offsetHeight = 0; this.rect = { left: 100, right: 130, top: 200, bottom: 220 };
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
      toggle: (c, on) => { const has = list().includes(c); const want = on === undefined ? !has : !!on; if (want && !has) el.classList.add(c); if (!want && has) el.classList.remove(c); return want; },
    };
  }
  get id() { return this.attrs.id || ''; }
  get isConnected() { for (let n = this; n; n = n.parentNode) if (n === this.ownerDocument) return true; return false; }
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
  /** bubbles from this element up to the document; stopPropagation ends it */
  dispatch(t, extra = {}) {
    const ev = { type: t, target: this, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
    for (let n = this; n && !ev.stopped; n = n.parentNode) for (const fn of [...(n.listeners[t] || [])]) fn(ev);
    return ev;
  }
  click() { return this.dispatch('click'); }
  focus() { this.ownerDocument.activeElement = this; }
  getBoundingClientRect() { return this.rect; }
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
  matches(sel) { return matchOne(this, sel); }
  querySelectorAll(sel) { return [...this.walk()].filter((e) => sel.split(',').some((s) => matchChain(e, s.trim(), this))); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
function matchOne(el, simple) {   // tag#id.class[attr][attr=val]; "*" matches any element
  if (simple === '*') return el.tagName !== '#WINDOW';
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
function matchChain(el, sel, scope) {   // descendant combinator only
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
  doc.getElementById = (id) => [...doc.walk()].find((e) => e.id === id) || null;
  doc.activeElement = null;
  return doc;
}
function makeWin(doc, extra = {}) {
  const w = new El('#window', doc);
  Object.assign(w, { innerWidth: 1200, innerHeight: 800, location: { pathname: '/', href: '' }, ...extra });
  w.top = w;
  return w;
}
const el = (doc, tag, attrs = {}, text = '', parent = null) => {
  const e = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text) e.textContent = text;
  if (parent) parent.appendChild(parent === doc ? e : e);
  return e;
};

// ---- fixtures ----------------------------------------------------------------------------------------------------------
const FIX = {
  version: 1, leadTool: false,
  records: [
    { id: 'OPT-1', kind: 'setting', name: 'When the conversation gets long', labels: ['Compress at'], what: 'Writes a short summary of the older part.', when: 'Turn it off for short jobs.', risk: 'One extra model call.', def: 'Default 80%.', restart: false, danger: 'everyday', who: 'admin', lead: 'apply', words: ['compress', 'compaction'], scope: 'install', anchors: [{ surface: 'desktop', selector: '#st-compact' }, { surface: 'phone', selector: '#ph-compact' }] },
    { id: 'OPT-2', kind: 'setting', name: 'Records', labels: ['Records'], what: 'Notes <b>kept</b> by the agent.', when: 'Rarely.', risk: 'None.', def: 'On.', restart: true, danger: 'care', who: 'both', lead: 'confirm', words: [], scope: 'per-agent', anchors: [{ surface: 'desktop', selector: '#st-records' }] },
    { id: 'OPT-3', kind: 'setting', name: 'Sandbox', labels: ['Sandbox'], what: 'Boxes agents in.', when: 'w', risk: 'r', def: 'd', restart: false, danger: 'dangerous', who: 'admin', lead: 'none', words: ['docker'], scope: 'install', anchors: [{ surface: 'desktop', selector: '#st-sandbox' }] },
    { id: 'OPT-4', kind: 'setting', name: 'Theme', labels: ['Theme'], what: 'Light or dark.', when: 'w', risk: 'r', def: 'd', restart: false, danger: 'everyday', who: 'both', lead: 'apply', words: [], scope: 'per-person', anchors: [{ surface: 'desktop', selector: '#st-theme' }] },
    { id: 'OPT-5', kind: 'setting', name: 'Old name', labels: ['Old name'], mergedInto: 'OPT-1', words: [], anchors: [{ surface: 'desktop', selector: '#st-old' }] },
    { id: 'OPT-6', kind: 'setting', name: 'Voice on', labels: ['Voice'], what: 'Speak answers.', when: 'w', risk: 'r', def: 'd', restart: false, danger: 'everyday', who: 'both', lead: 'apply', words: ['microphone'], scope: 'install', anchors: [{ surface: 'desktop', selector: '#st-voice-on' }] },
  ],
};
function page(opts = {}) {
  const doc = makeDoc();
  const win = makeWin(doc, opts.win);
  const overlay = el(doc, 'div', { id: 'st-overlay', class: 'st-overlay' }); doc.body.appendChild(overlay);
  // a row with label[for], a wrapping label, a row with a bare label, and a row with only a text span
  const secA = el(doc, 'div', { id: 'st-memory-section', class: 'st-section' }); overlay.appendChild(secA);
  const rowA = el(doc, 'div', { class: 'st-row' }); secA.appendChild(rowA);
  rowA.appendChild(el(doc, 'label', { for: 'st-compact' }, 'Compress at'));
  rowA.appendChild(el(doc, 'select', { id: 'st-compact' }));
  const rowB = el(doc, 'div', { class: 'st-row' }); secA.appendChild(rowB);
  const wrap = el(doc, 'label', {}, ' Records'); rowB.appendChild(wrap);
  wrap.appendChild(el(doc, 'input', { id: 'st-records', type: 'checkbox' }));
  const secB = el(doc, 'div', { id: 'st-sandbox-section', class: 'st-section' }); overlay.appendChild(secB);
  const rowC = el(doc, 'div', { class: 'st-row' }); secB.appendChild(rowC);
  rowC.appendChild(el(doc, 'label', {}, 'Sandbox'));
  rowC.appendChild(el(doc, 'input', { id: 'st-sandbox', type: 'checkbox' }));
  const rowD = el(doc, 'div', { class: 'st-row' }); secB.appendChild(rowD);
  rowD.appendChild(el(doc, 'span', {}, 'Theme'));
  rowD.appendChild(el(doc, 'select', { id: 'st-theme' }));
  const rowE = el(doc, 'div', { class: 'st-row' }); secB.appendChild(rowE);
  rowE.appendChild(el(doc, 'label', { for: 'st-old' }, 'Old name'));
  rowE.appendChild(el(doc, 'input', { id: 'st-old' }));
  const secC = el(doc, 'div', { id: 'st-voice-section', class: 'st-section' }); overlay.appendChild(secC);
  const rowF = el(doc, 'div', { class: 'st-row' }); secC.appendChild(rowF);
  rowF.appendChild(el(doc, 'label', { for: 'st-voice-on' }, 'Voice'));
  rowF.appendChild(el(doc, 'input', { id: 'st-voice-on', type: 'checkbox' }));
  return { doc, win, overlay, secA, secB, secC, rowA, rowB, rowC, rowD, rowE, rowF, wrap };
}
const loaded = (json = FIX) => { H.setRecords(JSON.parse(JSON.stringify(json))); };
const infos = (root) => root.querySelectorAll('button.st-info');
const panelOf = (doc) => doc.querySelector('.st-help-panel');
const textsOf = (p) => [...p.walk()].filter((e) => e.getAttribute('class') === 'st-help-p').map((e) => e.textContent);
const headsOf = (p) => [...p.walk()].filter((e) => e.getAttribute('class') === 'st-help-h').map((e) => e.textContent);

// ---- attach ------------------------------------------------------------------------------------------------------------
test('attach puts exactly one ⓘ right after the label of each anchored control, with the button markup of the spec', () => {
  loaded(); const p = page();
  const n = H.attach(p.overlay, 'desktop', { doc: p.doc, win: p.win });
  assert.strictEqual(n, 6);
  const b = p.rowA.children[1];   // label, ⓘ, select
  assert.strictEqual(b.tagName, 'BUTTON');
  assert.strictEqual(p.rowA.children[0].tagName, 'LABEL');
  assert.strictEqual(p.rowA.children[2].id, 'st-compact');
  assert.strictEqual(b.getAttribute('type'), 'button');
  assert.strictEqual(b.getAttribute('class'), 'st-info');
  assert.strictEqual(b.getAttribute('data-rec'), 'OPT-1');
  assert.strictEqual(b.getAttribute('aria-label'), 'About When the conversation gets long');
  assert.strictEqual(b.getAttribute('aria-haspopup'), 'dialog');
  assert.strictEqual(b.textContent, 'ⓘ');
});

test('attach never adds a second ⓘ to a control (a second run, a second observer pass, a re-render of nothing)', () => {
  loaded(); const p = page();
  H.attach(p.overlay, 'desktop', { doc: p.doc, win: p.win });
  const again = H.attach(p.overlay, 'desktop', { doc: p.doc, win: p.win });
  assert.strictEqual(again, 0);
  assert.strictEqual(infos(p.overlay).length, 6);
  for (const r of [p.rowA, p.rowC]) assert.strictEqual(infos(r).length, 1);
});

test('attach: a control inside a wrapping label gets its ⓘ after that label, never inside it; a bare label and a text-only row work too', () => {
  loaded(); const p = page();
  H.attach(p.overlay, 'desktop', { doc: p.doc, win: p.win });
  assert.strictEqual(infos(p.wrap).length, 0, 'not inside the label');
  assert.strictEqual(p.rowB.children[0], p.wrap);
  assert.strictEqual(p.rowB.children[1].getAttribute('data-rec'), 'OPT-2');
  assert.strictEqual(p.rowC.children[1].getAttribute('data-rec'), 'OPT-3', 'the closest row\'s first label');
  assert.strictEqual(p.rowD.children[0].tagName, 'SPAN');
  assert.strictEqual(p.rowD.children[1].getAttribute('data-rec'), 'OPT-4', 'the first text-bearing child of the row');
});

test('attach: a label that sits inside a button or another label is passed over: the ⓘ goes after the outer one', () => {
  loaded();
  const doc = makeDoc(), win = makeWin(doc);
  const ov = el(doc, 'div'); doc.body.appendChild(ov);
  const row = el(doc, 'div', { class: 'st-row' }); ov.appendChild(row);
  const btn = el(doc, 'button', {}); row.appendChild(btn);
  btn.appendChild(el(doc, 'label', { for: 'st-compact' }, 'Compress at'));
  row.appendChild(el(doc, 'select', { id: 'st-compact' }));
  H.attach(ov, 'desktop', { doc, win });
  assert.strictEqual(infos(btn).length, 0);
  assert.strictEqual(row.children[1].getAttribute('data-rec'), 'OPT-1');
});

test('attach only looks at anchors of its own surface and only where the selector matches', () => {
  loaded(); const p = page();
  assert.strictEqual(H.attach(p.overlay, 'agent-settings', { doc: p.doc, win: p.win }), 0);
  assert.strictEqual(H.attach(p.overlay, 'phone', { doc: p.doc, win: p.win }), 0, '#ph-compact is not in this dialog');
  assert.strictEqual(infos(p.overlay).length, 0);
  H.setRecords({ leadTool: false, records: [{ id: 'OPT-9', name: 'X', anchors: [{ surface: 'desktop', selector: '#nope' }, { surface: 'desktop', selector: '[[bad' }] }] });
  assert.strictEqual(H.attach(p.overlay, 'desktop', { doc: p.doc, win: p.win }), 0);
});

test('a MutationObserver re-runs attach for rows added later, and disconnects when the root leaves the page', async () => {
  loaded();
  const p = page();
  const seen = [];
  class MO { constructor(cb) { this.cb = cb; this.disconnected = false; seen.push(this); } observe() {} disconnect() { this.disconnected = true; } }
  p.overlay.removeChild(p.secC);   // the voice row arrives later
  H.watch(p.overlay, 'desktop', { doc: p.doc, win: p.win, MutationObserver: MO });
  assert.strictEqual(seen.length, 1);
  p.overlay.appendChild(p.secC);
  seen[0].cb([{}]);
  await new Promise((r) => setTimeout(r, 90));
  assert.strictEqual(infos(p.rowF).length, 1);
  p.doc.body.removeChild(p.overlay);
  seen[0].cb([{}]);
  await new Promise((r) => setTimeout(r, 90));
  assert.strictEqual(seen[0].disconnected, true);
});

test('records are fetched once per page load and again on request; a failed fetch leaves the screens as they were; leadTool is read', async () => {
  let calls = 0;
  const fetchFn = async (url, init) => { calls++; assert.strictEqual(url, '/api/settings-records'); assert.strictEqual(init.credentials, 'include'); return { ok: true, json: async () => ({ ...FIX, leadTool: true }) }; };
  H.setRecords({ records: [] });
  const fresh = require('../lib/ui-settings-help.js');
  // not loaded yet by a fetch of its own: ask for a forced load, then a plain one must not fetch again
  await fresh.load(true, fetchFn); await fresh.load(false, fetchFn); await fresh.load(false, fetchFn);
  assert.strictEqual(calls, 1);
  assert.strictEqual(fresh.leadTool(), true);
  assert.strictEqual(fresh.records().size, 6);
  await fresh.load(true, fetchFn);
  assert.strictEqual(calls, 2, 'refetched when Settings opens again');
  await fresh.load(true, async () => { throw new Error('offline'); });
  assert.strictEqual(fresh.records().size, 6, 'the old records stay when the fetch fails');
  await fresh.load(true, async () => ({ ok: false, status: 500, json: async () => ({}) }));
  assert.strictEqual(fresh.records().size, 6);
});

// ---- the panel ---------------------------------------------------------------------------------------------------------
function openFor(p, id, opts = {}) {
  H.attach(p.overlay, 'desktop', { doc: p.doc, win: p.win, ...opts });
  const b = p.overlay.querySelector(`button.st-info[data-rec="${id}"]`);
  b.click();
  return b;
}
test('open shows the title, the five headings with the record\'s texts, who can change it, and the Ask button, on a wide screen', () => {
  loaded(); const p = page();
  const b = openFor(p, 'OPT-1', { sheet: false });
  const panel = panelOf(p.doc);
  assert.ok(panel, 'a panel is on the page');
  assert.strictEqual(panel.getAttribute('class'), 'st-help-panel', 'a popover, not a sheet');
  assert.strictEqual(panel.getAttribute('role'), 'dialog');
  const title = panel.querySelector('.st-help-title');
  assert.ok(title.textContent.startsWith('When the conversation gets long'));
  assert.strictEqual(title.querySelector('.st-help-today').textContent.trim(), 'Compress at', 'today\'s label in small grey when it differs');
  assert.deepStrictEqual(headsOf(panel), ['What it does', 'When to change it', 'Cost or risk', 'Default and our recommendation', 'Restart needed', 'Who can change it']);
  assert.deepStrictEqual(textsOf(panel), ['Writes a short summary of the older part.', 'Turn it off for short jobs.', 'One extra model call.', 'Default 80%.', 'No.', 'An admin, on this screen.']);
  assert.strictEqual(panel.querySelector('.st-help-ask').textContent, 'Ask Maestro about this');
  assert.strictEqual(panel.querySelector('.st-help-x').getAttribute('aria-label'), 'Close');
  assert.strictEqual(b.getAttribute('aria-expanded'), 'true');
  assert.strictEqual(p.doc.activeElement, panel, 'focus moves into the panel');
  assert.ok(panel.style.left && panel.style.top, 'placed beside the button');
});

test('the title carries no small label when today\'s label is the same as the name', () => {
  loaded(); const p = page();
  openFor(p, 'OPT-2', { sheet: false });
  assert.strictEqual(panelOf(p.doc).querySelector('.st-help-today'), null);
});

test('restart: Yes says it is saved now and takes effect after the restart', () => {
  loaded(); const p = page();
  openFor(p, 'OPT-2', { sheet: false });
  assert.ok(textsOf(panelOf(p.doc)).includes('Yes. Saved now; it takes effect after your Maestro restarts.'));
});

test('the texts go in with textContent: markup in a record shows literally and creates no element', () => {
  loaded(); const p = page();
  openFor(p, 'OPT-2', { sheet: false });
  const panel = panelOf(p.doc);
  assert.ok(textsOf(panel).includes('Notes <b>kept</b> by the agent.'));
  assert.strictEqual([...panel.walk()].filter((e) => e.tagName === 'B').length, 0);
  const src = read('lib/ui-settings-help.js');
  assert.ok(!/\binnerHTML\b\s*=|insertAdjacentHTML|outerHTML\s*=/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'the library never writes markup');
});

test('a record merged into another shows its target\'s help under its own name', () => {
  loaded(); const p = page();
  openFor(p, 'OPT-5', { sheet: false });
  const panel = panelOf(p.doc);
  assert.ok(panel.querySelector('.st-help-title').textContent.startsWith('Old name'));
  assert.strictEqual(textsOf(panel)[0], 'Writes a short summary of the older part.');
});

test('Escape closes the panel only: the Settings dialog\'s own Escape handler never hears it, and focus goes back to the ⓘ', () => {
  loaded(); const p = page();
  let dialogHeard = 0;
  p.doc.addEventListener('keydown', () => { dialogHeard++; });   // stands in for createDialogGuard (a keydown listener on the document)
  const b = openFor(p, 'OPT-1', { sheet: false });
  const panel = panelOf(p.doc);
  const ev = panel.dispatch('keydown', { key: 'Escape' });
  assert.strictEqual(panelOf(p.doc), null, 'the panel closed');
  assert.strictEqual(dialogHeard, 0, 'the event did not reach the document');
  assert.strictEqual(ev.defaultPrevented, true);
  assert.ok(p.doc.getElementById('st-overlay'), 'the dialog is still there');
  assert.strictEqual(p.doc.activeElement, b);
  assert.strictEqual(b.getAttribute('aria-expanded'), 'false');
});

test('the close × and a click or tap outside close it; a press on the same ⓘ closes it; another ⓘ replaces it', () => {
  loaded(); const p = page();
  H.attach(p.overlay, 'desktop', { doc: p.doc, win: p.win, sheet: false });
  const [b1, b2] = [p.overlay.querySelector('[data-rec="OPT-1"]'), p.overlay.querySelector('[data-rec="OPT-2"]')];
  b1.click(); panelOf(p.doc).querySelector('.st-help-x').click();
  assert.strictEqual(panelOf(p.doc), null);
  b1.click(); p.rowC.dispatch('pointerdown');
  assert.strictEqual(panelOf(p.doc), null, 'outside');
  b1.click(); panelOf(p.doc).querySelector('.st-help-title').dispatch('pointerdown');
  assert.ok(panelOf(p.doc), 'inside is not outside');
  b1.click();
  assert.strictEqual(panelOf(p.doc), null, 'same button again');
  b1.click(); b2.click();
  assert.strictEqual(p.doc.querySelectorAll('.st-help-panel').length, 1);
  assert.strictEqual(panelOf(p.doc).getAttribute('data-rec'), 'OPT-2');
});

test('it opens on click only: nothing listens for hover, and Enter/Space are the button\'s own click', () => {
  loaded(); const p = page();
  H.attach(p.overlay, 'desktop', { doc: p.doc, win: p.win });
  const b = p.overlay.querySelector('[data-rec="OPT-1"]');
  assert.deepStrictEqual(Object.keys(b.listeners), ['click']);
  b.dispatch('mouseover'); b.dispatch('pointerenter'); b.dispatch('focus');
  assert.strictEqual(panelOf(p.doc), null);
});

test('the panel is a bottom sheet in the phone frame, on a narrow screen and on the phone page; a popover otherwise', () => {
  loaded();
  const sheetOf = (setup, opts = {}) => { const p = page(opts); setup(p); openFor(p, 'OPT-1'); const pn = panelOf(p.doc); return { sheet: /st-help-sheet/.test(pn.getAttribute('class')), scrim: !!p.doc.querySelector('.st-help-scrim'), p }; };
  assert.strictEqual(sheetOf(() => {}).sheet, false, 'wide');
  assert.strictEqual(sheetOf((p) => p.doc.documentElement.classList.add('mm-settings-only')).sheet, true, 'the phone frame');
  assert.strictEqual(sheetOf(() => {}, { win: { innerWidth: 600 } }).sheet, true, 'narrow');
  assert.strictEqual(sheetOf(() => {}, { win: { innerWidth: 700 } }).sheet, false, '700 is wide enough');
  const ph = sheetOf(() => {}, { win: { location: { pathname: '/mobile' } } });
  assert.strictEqual(ph.sheet, true, 'the phone page'); assert.strictEqual(ph.scrim, true, 'with something behind to tap');
  assert.strictEqual(panelOf(ph.p.doc).style.left, undefined, 'a sheet is placed by CSS, not by the button');
});

test('a popover is placed beside the button and flips to the left when there is no room on the right', () => {
  loaded();
  const a = page(); a.rowA.children[0].rect = { left: 10, right: 40, top: 100, bottom: 120 };
  H.attach(a.overlay, 'desktop', { doc: a.doc, win: a.win, sheet: false });
  const ba = a.overlay.querySelector('[data-rec="OPT-1"]'); ba.rect = { left: 100, right: 130, top: 200, bottom: 220 }; ba.click();
  assert.strictEqual(panelOf(a.doc).style.left, '140px');
  const b = page(); H.attach(b.overlay, 'desktop', { doc: b.doc, win: b.win, sheet: false });
  const bb = b.overlay.querySelector('[data-rec="OPT-1"]'); bb.rect = { left: 1000, right: 1030, top: 200, bottom: 220 }; bb.click();
  assert.strictEqual(panelOf(b.doc).style.left, String(1000 - 10 - 360) + 'px', 'flipped');
});

test('inside a modal <dialog> (the phone\'s sheets) the panel is put in the dialog, or it would sit under it', () => {
  loaded();
  const doc = makeDoc(), win = makeWin(doc, { innerWidth: 400 });
  const dlg = el(doc, 'dialog', { id: 'notify-prefs-sheet' }); doc.body.appendChild(dlg);
  const row = el(doc, 'div', { class: 'row' }); dlg.appendChild(row);
  row.appendChild(el(doc, 'label', { for: 'ph-compact' }, 'Compress at')); row.appendChild(el(doc, 'select', { id: 'ph-compact' }));
  assert.strictEqual(H.attach(dlg, 'phone', { doc, win }), 1);
  row.children[1].click();
  assert.strictEqual(dlg.querySelectorAll('.st-help-panel').length, 1);
});

// ---- Who can change it -------------------------------------------------------------------------------------------------
test('whoLines: per-person, admin, dangerous, and everyone, with no promise about Maestro while the lead has no settings tool', () => {
  const r = (o) => ({ danger: 'everyday', who: 'both', scope: 'install', ...o });
  assert.deepStrictEqual(H.whoLines(r({ scope: 'per-person' }), false), ['Each person sets their own.']);
  assert.deepStrictEqual(H.whoLines(r({ who: 'admin' }), false), ['An admin, on this screen.']);
  assert.deepStrictEqual(H.whoLines(r({ who: 'admin', danger: 'dangerous' }), false), ['Only an admin, on this screen, and the change is logged.']);
  assert.deepStrictEqual(H.whoLines(r({}), false), ['Anyone who can open this screen.']);
  assert.deepStrictEqual(H.whoLines(r({ who: 'admin', danger: 'care' }), undefined), ['An admin, on this screen.']);
});

test('whoLines when the route says leadTool is true: the record\'s own lead field decides (apply, confirm, screen, none)', () => {
  const r = (o) => ({ scope: 'install', who: 'admin', danger: 'everyday', ...o });
  assert.deepStrictEqual(H.whoLines(r({ lead: 'apply' }), true), ['An admin, on this screen.', 'You can also ask your Maestro to change it.']);
  assert.deepStrictEqual(H.whoLines(r({ lead: 'confirm', danger: 'care' }), true), ['An admin, on this screen.', 'Your Maestro can change it after you confirm.']);
  assert.deepStrictEqual(H.whoLines(r({ lead: 'screen' }), true), ['An admin, on this screen.']);
  assert.deepStrictEqual(H.whoLines(r({ lead: 'none' }), true), ['An admin, on this screen.']);
  assert.deepStrictEqual(H.whoLines(r({}), true), ['An admin, on this screen.'], 'no lead field: no Maestro line');
  // the danger class no longer decides: a dangerous setting the lead may apply says so, an everyday one marked screen does not
  assert.deepStrictEqual(H.whoLines(r({ danger: 'dangerous', lead: 'apply' }), true), ['Only an admin, on this screen, and the change is logged.', 'You can also ask your Maestro to change it.']);
  assert.deepStrictEqual(H.whoLines(r({ danger: 'everyday', lead: 'screen' }), true), ['An admin, on this screen.']);
  assert.deepStrictEqual(H.whoLines(r({ lead: 'apply', scope: 'per-person' }), true), ['Each person sets their own.', 'You can also ask your Maestro to change it.']);
  assert.deepStrictEqual(H.whoLines(r({ lead: 'apply' }), false), ['An admin, on this screen.'], 'leadTool false: never');
});

test('the panel shows the Maestro line only when the loaded route said leadTool is true', () => {
  loaded({ ...FIX, leadTool: false }); let p = page(); openFor(p, 'OPT-1', { sheet: false });
  assert.deepStrictEqual(textsOf(panelOf(p.doc)).slice(-1), ['An admin, on this screen.']);
  loaded({ ...FIX, leadTool: true }); p = page(); openFor(p, 'OPT-1', { sheet: false });
  assert.deepStrictEqual(textsOf(panelOf(p.doc)).slice(-2), ['An admin, on this screen.', 'You can also ask your Maestro to change it.']);
  p = page(); openFor(p, 'OPT-2', { sheet: false });
  assert.ok(textsOf(panelOf(p.doc)).includes('Your Maestro can change it after you confirm.'));
  p = page(); openFor(p, 'OPT-3', { sheet: false });
  assert.deepStrictEqual(textsOf(panelOf(p.doc)).slice(-1), ['Only an admin, on this screen, and the change is logged.']);
  loaded();
});

// ---- anchors by label (rows with no id) --------------------------------------------------------------------------------
const lrec = (id, label, extra = {}) => ({ id, kind: 'setting', name: 'Name ' + id, labels: [label], what: 'w', when: 'w', risk: 'r', def: 'd', restart: false, danger: 'everyday', who: 'admin', lead: 'apply', words: [], scope: 'install', anchors: [{ surface: 'desktop', label }], ...extra });
function labelPage() {
  const doc = makeDoc(), win = makeWin(doc);
  const root = el(doc, 'div', { class: 'st-overlay' }); doc.body.appendChild(root);
  const row = (cls = 'st-row') => { const r = el(doc, 'div', { class: cls }); root.appendChild(r); return r; };
  const out = { doc, win, root, opts: { doc, win } };
  out.rowA = row(); out.spanA = el(doc, 'span', {}, '🔔 Quiet hours:'); out.rowA.appendChild(out.spanA); out.rowA.appendChild(el(doc, 'select', { class: 'no-id' }));
  out.rowB = row(); out.wrap = el(doc, 'label', {}, ' Keep a log '); out.rowB.appendChild(out.wrap); out.wrap.appendChild(el(doc, 'input', { type: 'checkbox' }));
  out.rowC = row(); out.rowC.appendChild(el(doc, 'span', {}, 'Same words')); out.rowD = row(); out.rowD.appendChild(el(doc, 'label', {}, 'Same words'));
  out.rowE = row('ss-row'); out.titleE = el(doc, 'div', { class: 'ss-title' }, 'Reasoning'); out.rowE.appendChild(out.titleE);
  out.rowF = row(); out.labF = el(doc, 'label', {}, 'Door label'); out.rowF.appendChild(out.labF);
  return out;
}
test('a label anchor puts the ⓘ right after the one element whose own words match (case, emoji and colon ignored)', () => {
  H.setRecords({ leadTool: false, records: [lrec('OPT-11', 'quiet HOURS')] });
  const p = labelPage();
  assert.strictEqual(H.attach(p.root, 'desktop', p.opts), 1);
  assert.strictEqual(p.rowA.children[1].tagName, 'BUTTON');
  assert.strictEqual(p.rowA.children[1].getAttribute('data-rec'), 'OPT-11');
  assert.strictEqual(p.rowA.children[0], p.spanA);
  assert.strictEqual(p.rowA.children[2].tagName, 'SELECT');
  assert.strictEqual(infos(p.root).length, 1);
  assert.strictEqual(H.attach(p.root, 'desktop', p.opts), 0, 'never twice');
  assert.strictEqual(infos(p.root).length, 1);
});
test('a label anchor on a title class and on a button-carrying label uses only the element\'s own words', () => {
  H.setRecords({ leadTool: false, records: [lrec('OPT-11', 'Reasoning')] });
  const p = labelPage();
  p.titleE.appendChild(el(p.doc, 'button', {}, 'Reset'));   // text of a nested button is not part of the label
  assert.strictEqual(H.attach(p.root, 'desktop', p.opts), 1);
  assert.strictEqual(p.rowE.children[1].getAttribute('data-rec'), 'OPT-11');
  assert.strictEqual(infos(p.titleE).length, 0);
});
test('two elements with the same words: the label anchor is ambiguous and nothing is attached', () => {
  H.setRecords({ leadTool: false, records: [lrec('OPT-12', 'Same words')] });
  const p = labelPage();
  assert.strictEqual(H.attach(p.root, 'desktop', p.opts), 0);
  assert.strictEqual(infos(p.root).length, 0);
});
test('a wrapping checkbox label gets its ⓘ after it, never inside it', () => {
  H.setRecords({ leadTool: false, records: [lrec('OPT-13', 'Keep a log')] });
  const p = labelPage();
  assert.strictEqual(H.attach(p.root, 'desktop', p.opts), 1);
  assert.strictEqual(infos(p.wrap).length, 0);
  assert.strictEqual(p.rowB.children[0], p.wrap);
  assert.strictEqual(p.rowB.children[1].getAttribute('data-rec'), 'OPT-13');
});
test('doors and actions get no ⓘ by id or by label; a record merged into another does, and opens the target\'s help', () => {
  const door = lrec('OPT-14', 'Door label', { kind: 'door' });
  const action = lrec('OPT-15', 'Quiet hours', { kind: 'action' });
  const idDoor = lrec('OPT-16', 'x', { kind: 'door', anchors: [{ surface: 'desktop', selector: '#st-compact' }] });
  H.setRecords({ leadTool: false, records: [door, action, idDoor] });
  const p = labelPage();
  p.rowA.appendChild(el(p.doc, 'label', { for: 'st-compact' }, 'Compress')); p.rowA.appendChild(el(p.doc, 'select', { id: 'st-compact' }));
  assert.strictEqual(H.attach(p.root, 'desktop', p.opts), 0);
  assert.strictEqual(infos(p.root).length, 0);
  const merged = lrec('OPT-17', 'Door label', { kind: 'action', mergedInto: 'OPT-18', what: '', when: '', risk: '', def: '' });
  H.setRecords({ leadTool: false, records: [merged, lrec('OPT-18', 'Elsewhere', { what: 'The target text.', anchors: [] })] });
  const q = labelPage();
  assert.strictEqual(H.attach(q.root, 'desktop', q.opts), 1);
  q.rowF.children[1].click();
  assert.ok(textsOf(q.doc.querySelector('.st-help-panel')).includes('The target text.'));
  loaded();
});
test('label anchors only count on their own surface; an element that already has an ⓘ gets no second one', () => {
  H.setRecords({ leadTool: false, records: [lrec('OPT-19', 'Quiet hours', { anchors: [{ surface: 'phone', label: 'Quiet hours' }] })] });
  const p = labelPage();
  assert.strictEqual(H.attach(p.root, 'desktop', p.opts), 0);
  assert.strictEqual(H.attach(p.root, 'phone', p.opts), 1);
  H.setRecords({ leadTool: false, records: [lrec('OPT-19', 'Quiet hours'), lrec('OPT-20', 'Quiet hours')] });
  const q = labelPage();
  assert.strictEqual(H.attach(q.root, 'desktop', q.opts), 1, 'two records, one label: the first wins, the row gets one ⓘ');
  assert.strictEqual(infos(q.root).length, 1);
  loaded();
});
test('normLabel: trim, collapse spaces, drop a leading emoji/symbol run, a trailing colon or ellipsis and a long trailing note', () => {
  assert.strictEqual(H.normLabel('  🔔   Quiet   hours: '), 'Quiet hours');
  assert.strictEqual(H.normLabel('⚙ ▸ Search…'), 'Search');
  assert.strictEqual(H.normLabel('Short (note)'), 'Short (note)', 'a note stays on a short label');
  assert.strictEqual(H.normLabel('A rather long label for the thing (only on phones)'), 'A rather long label for the thing');
  assert.strictEqual(H.normLabel(''), '');
});

// ---- Ask Maestro about this --------------------------------------------------------------------------------------------
test('the ask text is the sentence of the spec', () => {
  assert.strictEqual(H.askText('Records'), 'Tell me about the setting “Records”: what it does here and whether I should change it.');
});

test('"Ask Maestro about this" on a page with a chat hands the text to window.mmAskLead and closes the panel', () => {
  loaded(); const p = page({ win: { mmAskLead: (t) => { asked.push(t); } } }); const asked = [];
  openFor(p, 'OPT-2', { sheet: false });
  panelOf(p.doc).querySelector('.st-help-ask').click();
  assert.deepStrictEqual(asked, ['Tell me about the setting “Records”: what it does here and whether I should change it.']);
  assert.strictEqual(panelOf(p.doc), null);
});

test('from the phone frame the top window goes to /mobile#ask-lead=…; from agent-settings or users it goes to /#ask-lead=…', () => {
  loaded();
  const frame = page(); frame.doc.documentElement.classList.add('mm-settings-only');
  const top = { location: { href: '' } }; frame.win.top = top;
  openFor(frame, 'OPT-2');
  panelOf(frame.doc).querySelector('.st-help-ask').click();
  assert.strictEqual(top.location.href, '/mobile#ask-lead=' + encodeURIComponent(H.askText('Records')));
  const other = page(); const top2 = { location: { href: '' } }; other.win.top = top2;
  openFor(other, 'OPT-2', { sheet: false });
  panelOf(other.doc).querySelector('.st-help-ask').click();
  assert.strictEqual(top2.location.href, '/#ask-lead=' + encodeURIComponent(H.askText('Records')));
});

function askEnv(over = {}) {
  const box = { value: '', focused: false, focus() { this.focused = true; }, dispatchEvent() { this.inputEvents = (this.inputEvents || 0) + 1; } };
  const calls = { opened: [], cleared: 0, sent: 0, before: 0 };
  return { box, calls, env: { findLead: () => ({ name: 'maestro' }), openChat: (n) => { calls.opened.push(n); }, getBox: () => box, clearHash: () => { calls.cleared++; }, beforeOpen: () => { calls.before++; }, send: () => { calls.sent++; }, ...over } };
}
test('the #ask-lead hash opens the lead\'s chat and fills the box with the text, drops the hash and sends nothing', async () => {
  const { box, calls, env } = askEnv();
  const text = H.askText('Sandbox & “docker”');
  const ok = await H.handleAskHash('#ask-lead=' + encodeURIComponent(text), env);
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(calls.opened, ['maestro']);
  assert.strictEqual(box.value, text);
  assert.strictEqual(box.focused, true);
  assert.strictEqual(calls.cleared, 1);
  assert.strictEqual(calls.sent, 0, 'never sent');
});

test('the hash handler ignores other hashes, bad encodings and an empty text, and does nothing when there is no lead agent', async () => {
  for (const h of ['', '#chat=maestro', '#activity', '#ask-lead=', '#ask-lead=%E0%A4%A', '#ask-lead=%20%20']) {
    const { env, calls } = askEnv();
    assert.strictEqual(await H.handleAskHash(h, env), false, h);
    assert.strictEqual(calls.opened.length, 0, h);
  }
  const { env, calls, box } = askEnv({ findLead: () => null });
  assert.strictEqual(await H.handleAskHash('#ask-lead=hello', env), false);
  assert.strictEqual(calls.opened.length, 0); assert.strictEqual(box.value, '');
});

test('the text from the address is cut to a sane length and control characters become spaces', () => {
  assert.strictEqual(H.parseAskHash('#ask-lead=' + encodeURIComponent('a\u0000b\nc')), 'a b c');
  assert.strictEqual(H.parseAskHash('#ask-lead=' + 'x'.repeat(5000)).length, 600);
});

test('the box is waited for while the chat opens (it is not there on the first look)', async () => {
  let n = 0; const box = { value: '', focus() {}, dispatchEvent() {} };
  const ok = await H.askFill('hello', { findLead: () => ({ name: 'm' }), openChat: () => {}, getBox: () => (++n < 3 ? null : box) });
  assert.strictEqual(ok, true); assert.strictEqual(box.value, 'hello');
});

// ---- search by other words ---------------------------------------------------------------------------------------------
test('sectionWords maps each section to the words of the records anchored inside it (name, labels, words, what)', () => {
  loaded(); const p = page();
  const m = H.sectionWords(p.overlay, 'desktop', 'st-section');
  const a = m.get(p.secA);
  assert.ok(a.some((e) => e.text.includes('compress') && e.text.includes('compaction') && e.row === p.rowA), '"compress" belongs to the context-compression row');
  assert.ok(m.get(p.secB).some((e) => e.text.includes('docker')));
  assert.ok(m.get(p.secC).some((e) => e.text.includes('microphone')));
  assert.ok(!(m.get(p.secC) || []).some((e) => e.text.includes('docker')));
});

/** the real stSearch from app.js, run against the fake DOM */
function searchRig() {
  const src = read('app.js');
  const a = src.indexOf('function stSearch(q) {'), b = src.indexOf('// Links into Settings (the plan badge', a);
  assert.ok(a > 0 && b > a, 'stSearch found');
  const body = src.slice(a, b);
  const make = new Function('document', 'stShowGroup', 'STG', `let stCurGroup = null; let stPicked = false; let stSearching = false; let stWordsIdx = null; function stPhoneSaveMark() {} ${body}; return { stSearch, setIdx: (v) => { stWordsIdx = v; }, searching: () => stSearching };`);
  const p = page();
  const wrap = el(p.doc, 'div', { id: 'st-groups' }); p.doc.body.appendChild(wrap);
  // the eight-group page: each group is a .st-group (one shown at a time) holding its sections
  const mk = (id, secs) => { const g = el(p.doc, 'section', { class: 'st-group' }); g.dataset.group = id; g.hidden = true; for (const s of secs) g.appendChild(s); wrap.appendChild(g); return g; };
  const g1 = mk('upkeep', [p.secA]), g2 = mk('safety', [p.secB]), g3 = mk('voice', [p.secC]);
  const none = el(p.doc, 'span', { id: 'st-search-none' }); p.doc.body.appendChild(none); none.hidden = true;
  const doc = { querySelectorAll: (s) => wrap.querySelectorAll(s.replace('#st-groups ', '')), getElementById: (id) => (id === 'st-search-none' ? none : id === 'st-groups' ? wrap : null) };
  const shown = [];
  const fns = make(doc, (id) => { shown.push(id); for (const g of [g1, g2, g3]) g.hidden = g.dataset.group !== id; }, require('../lib/ui-settings-groups.js'));
  return { ...fns, p, g1, g2, g3, none, wrap, shown };
}
test('search: "compress" finds the compression row by the record\'s words although the screen never says it; the row gets the highlight class', () => {
  loaded(); const r = searchRig();
  r.p.secA.querySelector('label').textContent = 'Summarize at';   // the words on screen today do not contain "compress"
  r.p.rowA.querySelector('label').textContent = 'Summarize at';
  assert.ok(!r.p.secA.textContent.toLowerCase().includes('compress'));
  r.setIdx(H.sectionWords(r.p.doc.body, 'desktop', 'st-section'));   // the sections now sit inside the groups, all inside the page
  r.stSearch('compress');
  assert.strictEqual(r.p.secA.style.display, '', 'the section is shown');
  assert.strictEqual(r.p.secB.style.display, 'none'); assert.strictEqual(r.p.secC.style.display, 'none');
  assert.strictEqual(r.g1.hidden, false, 'its group is shown'); assert.strictEqual(r.g2.hidden, true); assert.strictEqual(r.searching(), true);
  assert.ok(r.p.rowA.classList.contains('st-word-hit'), 'the matching row is highlighted');
  assert.ok(!r.p.rowB.classList.contains('st-word-hit'));
  assert.strictEqual(r.p.secA.classList.contains('st-match'), true);
});

test('search: without the words index it behaves as before (the section\'s own text only); clearing the box puts everything back', () => {
  loaded(); const r = searchRig();
  r.stSearch('docker');
  assert.strictEqual(r.p.secB.style.display, 'none', 'no index, no word on screen: no match, as before');
  r.setIdx(H.sectionWords(r.p.doc.body, 'desktop', 'st-section'));
  r.stSearch('docker');
  assert.strictEqual(r.p.secB.style.display, '');
  assert.ok(r.p.rowC.classList.contains('st-word-hit'));
  r.stSearch('');
  assert.strictEqual(r.p.secA.style.display, ''); assert.deepStrictEqual(r.shown, ['you'], 'the open group is back alone'); assert.strictEqual(r.searching(), false);
  assert.ok(![...r.wrap.walk()].some((e) => e.classList.contains('st-word-hit')), 'highlights are gone');
  r.stSearch('sandbox');   // the section's own text still matches (the existing behaviour)
  assert.strictEqual(r.p.secB.style.display, '');
  r.stSearch('zzzz');
  assert.strictEqual(r.none.hidden, false, 'nothing matches');
});

// ---- the pages ---------------------------------------------------------------------------------------------------------
test('the shared script is served under /ui-settings-help.js and every page that shows the ⓘ loads it before its own script', () => {
  const { ALIASES, resolve } = require('../lib/static-files');
  assert.strictEqual(ALIASES.get('ui-settings-help.js'), 'lib/ui-settings-help.js');
  assert.strictEqual(resolve('/ui-settings-help.js', root), fs.realpathSync(path.join(root, 'lib/ui-settings-help.js')));
  const tag = '<script src="/ui-settings-help.js"></script>';
  const idx = read('index.html'), mob = read('mobile.html'), as = read('agent-settings.html'), us = read('users.html');
  assert.ok(idx.includes(tag) && idx.indexOf(tag) < idx.indexOf('<script src="app.js">'), 'index.html');
  assert.ok(mob.includes(tag) && mob.indexOf(tag) < mob.indexOf('<script src="mobile.js">'), 'mobile.html');
  assert.ok(!as.includes('ui-settings-help'), 'agent-settings.html is a redirect page now (P4-2): it shows no ⓘ and loads no helper');
  assert.ok(us.includes(tag) && us.indexOf(tag) < us.indexOf("hubSettingsHelp.mount(document, 'users')"), 'users.html');
});

test('the screens call the helper after they draw: Settings (desktop and so the phone frame), Simple settings, the phone sheets, agent-settings, users', () => {
  const app = read('app.js'), mob = read('mobile.js');
  assert.match(app, /groupSettings\(data\);\n\s+stHelpMount\(\);/, 'after the Settings dialog is drawn');
  assert.match(app, /H\.mount\(overlay, 'desktop', \{ refetch: true \}\)/);
  assert.match(app, /mount\(overlay, 'simple-desktop'\)/);
  assert.match(app, /stWordsIdx = H\.sectionWords\(overlay, 'desktop', 'st-section'\)/);
  assert.match(mob, /mount\(d, 'simple-phone'\)/);
  assert.match(mob, /H\.mount\(el, 'phone'\)/);
  assert.match(mob, /notify-prefs-sheet', 'notify-agent-sheet', 'research-sheet', 'profile-sheet', 'security-sheet'/);
  assert.match(mob, /helpMountPhone\(\);/);
  assert.doesNotMatch(read('agent-settings.html'), /hubSettingsHelp/, 'the agent card draws its own ⓘ (P4-2: the old page is a redirect)');
  assert.match(read('users.html'), /hubSettingsHelp\.mount\(document, 'users'\)/);
});

test('today\'s row markup is not touched: the library only inserts elements after render (no markup strings in the generated rows)', () => {
  const app = read('app.js');
  assert.ok(!/st-info/.test(app.replace(/\.st-word-hit/g, '')), 'app.js never writes an ⓘ into a row string');
});

test('both pages handle #ask-lead on load and on hashchange, and set mmAskLead only where a chat is on the page', () => {
  const app = read('app.js'), mob = read('mobile.js');
  for (const [name, src] of [['app.js', app], ['mobile.js', mob]]) {
    assert.match(src, /function askLeadStart\(\)/, name);
    assert.match(src, /addEventListener\('hashchange', run\)/, name);
    assert.match(src, /H\.handleAskHash\(location\.hash, askLeadEnv\(\)\)/, name);
    assert.match(src, /window\.mmAskLead = \(text\) => H\.askFill\(text, askLeadEnv\(\)\)/, name);
    assert.match(src, /findLead: \(\) => .*\.lead\)/, name);
  }
  assert.match(app, /if \(!H \|\| SETTINGS_ONLY\) return;/, 'the phone\'s Settings frame does not fill a hidden chat of its own');
  assert.match(app, /askLeadStart\(\);\s+\/\/ "Ask Maestro about this"/);
  assert.match(mob, /askLeadStart\(\);\s+\/\/ "Ask Maestro about this"/);
  assert.ok(!/send/i.test(app.slice(app.indexOf('function askLeadEnv()'), app.indexOf('function askLeadStart()'))), 'filling the box never sends');
  assert.ok(!/send/i.test(mob.slice(mob.indexOf('function askLeadEnv()'), mob.indexOf('function askLeadStart()'))));
});

test('colours of the ⓘ, the panel and the sheet go through CSS variables only (no literal colour in the new rules or the script)', () => {
  const lit = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\b(white|black|red|blue|green|gray|grey|orange|yellow)\b\s*[;}]/;
  const rules = (html) => html.split('\n').filter((l) => /\.st-info|\.st-help-|\.st-word-hit/.test(l));
  for (const f of ['index.html', 'mobile.html', 'users.html']) {
    const rs = rules(read(f));
    assert.ok(rs.length >= 8, f + ': the rules are there');
    for (const l of rs) assert.ok(!lit.test(l), f + ': ' + l.trim().slice(0, 80));
  }
  const lib = read('lib/ui-settings-help.js');
  assert.ok(!lit.test(lib.replace(/\/\*[\s\S]*?\*\//g, '')), 'the script sets no colour');
  assert.ok(!/style\.(color|background)/.test(lib));
  assert.strictEqual(rules(read('agent-settings.html')).length, 0, 'the redirect page carries no ⓘ rules');
});

test('the ⓘ is at least 32x32 on the phone page and in the phone frame', () => {
  const mob = read('mobile.html'), idx = read('index.html');
  assert.match(mob, /\.st-info \{[^}]*width: 32px; height: 32px;/);
  assert.match(idx, /html\.mm-settings-only \.st-info \{[^}]*width: 32px; height: 32px;/);
});

test('the phone service worker is bumped for the new mobile.html and mobile.js (hub-mobile-v107)', () => {
  assert.match(read('sw.js'), /const VERSION = 'hub-mobile-v107'/);
});

// ---- review round 1 fixes (spec U) -------------------------------------------------------------------------------------
const r1rec = (id, selector, extra = {}) => ({ id, kind: 'setting', name: 'Name ' + id, labels: [], what: 'w', when: 'w', risk: 'r', def: 'd', restart: false, danger: 'everyday', who: 'admin', lead: 'apply', words: [], scope: 'install', anchors: [{ surface: 'desktop', selector }], ...extra });
function stage() {
  const doc = makeDoc(), win = makeWin(doc);
  const ov = el(doc, 'div', { class: 'st-overlay' }); doc.body.appendChild(ov);
  const row = (cls = 'st-row') => { const r = el(doc, 'div', { class: cls }); ov.appendChild(r); return r; };
  return { doc, win, ov, row, opts: { doc, win } };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Ask Maestro: a draft is never lost; Settings must really close first
function askEnv2(over = {}) {
  const box = { value: '', inputEvents: 0, focus() {}, dispatchEvent() { this.inputEvents++; } };
  const calls = { opened: [] };
  return { box, calls, env: { findLead: () => ({ name: 'maestro' }), openChat: (n) => { calls.opened.push(n); }, getBox: () => box, ...over } };
}
test('Ask keeps a draft already in the lead\'s box and adds the question after it on a new line; the same question twice is not added', async () => {
  const q = H.askText('Records');
  const a = askEnv2(); a.box.value = 'my unsent draft';
  assert.strictEqual(await H.askFill(q, a.env), true);
  assert.strictEqual(a.box.value, 'my unsent draft\n' + q);
  assert.strictEqual(a.box.inputEvents, 1, 'the box is told, so the draft is saved with the question');
  const b = askEnv2(); b.box.value = q;
  assert.strictEqual(await H.askFill(q, b.env), true);
  assert.strictEqual(b.box.value, q); assert.strictEqual(b.box.inputEvents, 0, 'nothing changed, nothing sent to the box');
  const c = askEnv2(); c.box.value = 'draft\n' + q;
  await H.askFill(q, c.env); assert.strictEqual(c.box.value, 'draft\n' + q, 'the question is not added again after a draft');
  const d = askEnv2();
  await H.askFill(q, d.env); assert.strictEqual(d.box.value, q, 'an empty box simply gets the question');
});

test('Keep editing at the discard question: the chat is not opened and the box is left alone', async () => {
  const k = askEnv2({ beforeOpen: async () => false });
  k.box.value = 'draft';
  assert.strictEqual(await H.askFill('hello', k.env), false);
  assert.deepStrictEqual(k.calls.opened, []);
  assert.strictEqual(k.box.value, 'draft'); assert.strictEqual(k.box.inputEvents, 0);
  const t = askEnv2({ beforeOpen: () => { throw new Error('guard broke'); } });
  assert.strictEqual(await H.askFill('hello', t.env), false); assert.deepStrictEqual(t.calls.opened, []);
  const ok = askEnv2({ beforeOpen: async () => true });
  assert.strictEqual(await H.askFill('hello', ok.env), true); assert.deepStrictEqual(ok.calls.opened, ['maestro']);
});

test('closeGuarded reads the guard\'s outcome: closed at once = true; the question answered Keep editing = false, Discard = true; busy or kept = false', async () => {
  const mk = () => { const s = stage(); const dlg = el(s.doc, 'div', { id: 'st-overlay' }); s.doc.body.appendChild(dlg); return { ...s, dlg }; };
  let s = mk();
  assert.strictEqual(await H.closeGuarded(s.dlg, (e) => { e.parentNode.removeChild(e); return 'closed'; }, s.opts), true);
  s = mk();
  const asked = el(s.doc, 'dialog', { class: 'dlg-discard' });
  const keep = H.closeGuarded(s.dlg, () => { s.doc.body.appendChild(asked); return 'confirm'; }, s.opts);
  await wait(80); assert.strictEqual(asked.isConnected, true);
  s.doc.body.removeChild(asked);   // Keep editing: the question goes, the dialog stays
  assert.strictEqual(await keep, false);
  s = mk();
  const asked2 = el(s.doc, 'dialog', { class: 'dlg-discard' });
  const go = H.closeGuarded(s.dlg, () => { s.doc.body.appendChild(asked2); return 'confirm'; }, s.opts);
  await wait(80); s.doc.body.removeChild(asked2); s.doc.body.removeChild(s.dlg);   // Discard: both go
  assert.strictEqual(await go, true);
  s = mk(); assert.strictEqual(await H.closeGuarded(s.dlg, () => 'busy', s.opts), false);
  s = mk(); assert.strictEqual(await H.closeGuarded(s.dlg, () => 'kept', s.opts), false);
});

test('the pages hand the guard\'s outcome to askFill: app.js waits on the overlay, mobile.js on the Settings sheet and every open dialog', () => {
  const app = read('app.js'), mob = read('mobile.js');
  const a = app.slice(app.indexOf('function askLeadEnv()'), app.indexOf('function askLeadStart()'));
  assert.match(a, /beforeOpen: async \(\) =>/); assert.match(a, /closeGuarded\(o, \(el\) => dialogRequestClose\(el\)/); assert.match(a, /return false;/);
  const m = mob.slice(mob.indexOf('function askCloseSettingsSheet()'), mob.indexOf('function askLeadStart()'));
  assert.match(m, /beforeOpen: async \(\) =>/); assert.match(m, /await askCloseSettingsSheet\(\)\)\) return false/); assert.match(m, /mm-settings-kept/); assert.match(m, /closeGuarded\(d,/);
  assert.ok(!/send/i.test(m), 'still never sends');
});

// labels
test('a label for another control is never used: the ⓘ goes after the control instead', () => {
  const s = stage(); const row = s.row();
  const lab = el(s.doc, 'label', { for: 'other' }, 'Other'); const other = el(s.doc, 'input', { id: 'other' }); const mine = el(s.doc, 'select', { id: 'mine' });
  for (const c of [lab, other, mine]) row.appendChild(c);
  H.setRecords({ records: [r1rec('OPT-1', '#mine')] });
  assert.strictEqual(H.attach(s.ov, 'desktop', s.opts), 1);
  assert.strictEqual(infos(row).length, 1);
  assert.strictEqual(mine.nextSibling.getAttribute('data-rec'), 'OPT-1', 'right after the control');
  assert.strictEqual(lab.nextSibling, other, 'not after the other control\'s label');
  loaded();
});

test('a label that is the nearest label of a different control in the row is not taken', () => {
  const s = stage(); const row = s.row();
  const lab = el(s.doc, 'label', {}, 'First'); const a = el(s.doc, 'select', { id: 'a' }); const b = el(s.doc, 'select', { id: 'b' });
  for (const c of [lab, a, b]) row.appendChild(c);
  H.setRecords({ records: [r1rec('OPT-1', '#b')] });   // only the second control has a record
  H.attach(s.ov, 'desktop', s.opts);
  assert.strictEqual(lab.nextSibling, a, 'the label stays with the first control');
  assert.strictEqual(b.nextSibling.getAttribute('data-rec'), 'OPT-1');
  loaded();
});

test('an empty or whitespace-only label is never used: the ⓘ goes after the control', () => {
  const s = stage(); const row = s.row();
  const lab = el(s.doc, 'label', {}, '  \n '); const btn = el(s.doc, 'button', { id: 'go' }, 'Go');
  row.appendChild(lab); row.appendChild(btn);
  H.setRecords({ records: [r1rec('OPT-1', '#go')] });
  assert.strictEqual(H.attach(s.ov, 'desktop', s.opts), 1);
  assert.strictEqual(btn.nextSibling.getAttribute('data-rec'), 'OPT-1');
  assert.strictEqual(lab.nextSibling, btn, 'nothing beside the blank label');
  const t = stage(); const r2 = t.row();
  const l2 = el(t.doc, 'label', { for: 'x' }, ' '); const x = el(t.doc, 'input', { id: 'x' }); r2.appendChild(l2); r2.appendChild(x);
  H.setRecords({ records: [r1rec('OPT-2', '#x')] });
  H.attach(t.ov, 'desktop', t.opts);
  assert.strictEqual(x.nextSibling.getAttribute('data-rec'), 'OPT-2', 'even its own label, when blank');
  loaded();
});

test('two records in one row get two ⓘ in two places, never stacked after one label', () => {
  const s = stage(); const row = s.row();
  const lab = el(s.doc, 'label', {}, 'Both'); const a = el(s.doc, 'select', { id: 'a' }); const b = el(s.doc, 'select', { id: 'b' });
  for (const c of [lab, a, b]) row.appendChild(c);
  H.setRecords({ records: [r1rec('OPT-1', '#a'), r1rec('OPT-2', '#b')] });
  assert.strictEqual(H.attach(s.ov, 'desktop', s.opts), 2);
  assert.strictEqual(infos(row).length, 2);
  assert.strictEqual(lab.nextSibling.getAttribute('data-rec'), 'OPT-1');
  assert.strictEqual(a.nextSibling, b, 'the first ⓘ sits after the label only');
  assert.strictEqual(b.nextSibling.getAttribute('data-rec'), 'OPT-2');
  loaded();
});

test('on the agent page a section\'s heading label is not taken for a control deep inside the section', () => {
  const s = stage(); const sec = s.row('section');
  const head = el(s.doc, 'label', {}, 'Tool policy'); const wrap = el(s.doc, 'div', {}); const sel = el(s.doc, 'select', { id: 'deep' });
  sec.appendChild(head); sec.appendChild(wrap); wrap.appendChild(sel);
  H.setRecords({ records: [r1rec('OPT-1', '#deep', { anchors: [{ surface: 'agent-settings', selector: '#deep' }] })] });
  assert.strictEqual(H.attach(s.ov, 'agent-settings', s.opts), 1);
  assert.strictEqual(head.nextSibling, wrap, 'nothing after the heading');
  assert.strictEqual(sel.nextSibling.getAttribute('data-rec'), 'OPT-1');
  // a control that is a direct child of the section still takes the label before it
  const t = stage(); const sec2 = t.row('section'); const h2 = el(t.doc, 'label', {}, 'Root'); const inp = el(t.doc, 'input', { id: 'root' });
  sec2.appendChild(h2); sec2.appendChild(inp);
  H.setRecords({ records: [r1rec('OPT-2', '#root', { anchors: [{ surface: 'agent-settings', selector: '#root' }] })] });
  H.attach(t.ov, 'agent-settings', t.opts);
  assert.strictEqual(h2.nextSibling.getAttribute('data-rec'), 'OPT-2');
  loaded();
});

// search uses the label anchors
test('search: a record anchored by label text is found by its search words and its row is highlighted', () => {
  const s = stage();
  const sec = el(s.doc, 'div', { class: 'st-section' }); s.ov.appendChild(sec);
  const row = el(s.doc, 'div', { class: 'st-row' }); sec.appendChild(row);
  row.appendChild(el(s.doc, 'span', {}, 'OpenAI key')); row.appendChild(el(s.doc, 'input', { type: 'password' }));
  H.setRecords({ records: [r1rec('OPT-9', null, { name: 'OpenAI key', words: ['pay per use'], anchors: [{ surface: 'desktop', label: 'OpenAI key' }] })] });
  const m = H.sectionWords(s.ov, 'desktop', 'st-section');
  assert.ok(m.get(sec) && m.get(sec).some((e) => e.row === row && e.text.includes('pay per use')));
  // the real stSearch from app.js
  const src = read('app.js');
  const a = src.indexOf('function stSearch(q) {'), b = src.indexOf('// Links into Settings (the plan badge', a);
  const make = new Function('document', 'stShowGroup', 'STG', `let stCurGroup = null; let stPicked = false; let stSearching = false; let stWordsIdx = null; function stPhoneSaveMark() {} ${src.slice(a, b)}; return { stSearch, setIdx: (v) => { stWordsIdx = v; } };`);
  const grp = el(s.doc, 'section', { class: 'st-group' }); grp.dataset.group = 'money';
  s.ov.removeChild(sec); grp.appendChild(sec); s.ov.appendChild(grp);
  const none = el(s.doc, 'span', { id: 'st-search-none' });
  const rig = make({ querySelectorAll: (x) => s.ov.querySelectorAll(x.replace('#st-groups ', '')), getElementById: (id) => (id === 'st-search-none' ? none : null) }, () => {}, require('../lib/ui-settings-groups.js'));
  rig.setIdx(H.sectionWords(s.ov, 'desktop', 'st-section'));
  rig.stSearch('pay per use');
  assert.strictEqual(sec.style.display, '', 'the section is shown');
  assert.ok(row.classList.contains('st-word-hit'), 'and the row is highlighted');
  loaded();
});

// the panel
function openedR1(opts = {}) {
  const s = stage(); const row = s.row();
  row.appendChild(el(s.doc, 'label', { for: 'c' }, 'Compress at')); row.appendChild(el(s.doc, 'select', { id: 'c' }));
  H.setRecords({ leadTool: false, records: [r1rec('OPT-1', '#c')] });
  const o = { ...s.opts, ...opts };
  H.attach(s.ov, 'desktop', o);
  const b = s.ov.querySelector('button.st-info'); b.click();
  return { ...s, row, b };
}
test('tapping the sheet\'s scrim closes it and returns focus to the ⓘ, like Escape', () => {
  const s = openedR1({ sheet: true });
  const scrim = s.doc.querySelector('.st-help-scrim'); assert.ok(scrim);
  scrim.dispatch('pointerdown'); scrim.click();
  assert.strictEqual(panelOf(s.doc), null);
  assert.strictEqual(s.doc.activeElement, s.b);
  assert.strictEqual(s.b.getAttribute('aria-expanded'), 'false');
  loaded();
});

test('when the ⓘ that opened the panel leaves the page (a redraw), the panel closes', () => {
  const seen = []; class MO { constructor(cb) { this.cb = cb; this.disconnected = false; seen.push(this); } observe() {} disconnect() { this.disconnected = true; } }
  const s = openedR1({ sheet: false, MutationObserver: MO });
  assert.ok(panelOf(s.doc));
  seen[0].cb([]); assert.ok(panelOf(s.doc), 'still there while the ⓘ is');
  s.row.removeChild(s.b);
  seen[0].cb([{}]);
  assert.strictEqual(panelOf(s.doc), null);
  assert.strictEqual(seen[0].disconnected, true, 'the observer goes with it');
  loaded();
});

test('a resize closes the panel on a width change only, not on a height change; the sheet is aria-modal, the popover is not', () => {
  const s = openedR1({ sheet: false });
  assert.strictEqual(panelOf(s.doc).getAttribute('aria-modal'), null);
  s.win.innerHeight = 500; s.win.dispatch('resize');
  assert.ok(panelOf(s.doc), 'address bar: height only');
  s.win.innerWidth = 900; s.win.dispatch('resize');
  assert.strictEqual(panelOf(s.doc), null, 'width changed');
  const t = openedR1({ sheet: true });
  assert.strictEqual(panelOf(t.doc).getAttribute('aria-modal'), 'true');
  t.win.innerWidth = 400; t.win.dispatch('resize');
  loaded();
});

test('the "who can change it" line follows the record\'s who', () => {
  const r = (o) => ({ danger: 'everyday', who: 'both', scope: 'install', ...o });
  const only = /^Only an admin/;
  for (const who of ['both', 'member']) for (const danger of ['everyday', 'care', 'dangerous']) assert.ok(!only.test(H.whoLines(r({ who, danger }), false)[0]), who + '/' + danger);
  assert.ok(only.test(H.whoLines(r({ who: 'admin', danger: 'dangerous' }), false)[0]));
  assert.strictEqual(H.whoLines(r({ who: 'both' }), false)[0], 'Anyone who can open this screen.');
  assert.match(H.whoLines(r({ who: 'member' }), false)[0], /^Any member/);
  assert.strictEqual(H.whoLines(r({ who: 'admin' }), false)[0], 'An admin, on this screen.');
  assert.strictEqual(H.whoLines(r({ who: 'both', danger: 'dangerous', scope: 'per-person' }), false)[0], 'Each person sets their own.');
});

// the cost of watching
test('watching: bursts cost at most one pass per 250 ms, and only elements that could hold an anchor start one', async () => {
  const s = stage(); const row = s.row();
  row.appendChild(el(s.doc, 'label', { for: 'c' }, 'Compress at')); row.appendChild(el(s.doc, 'select', { id: 'c' }));
  H.setRecords({ records: [r1rec('OPT-1', '#c')] });
  let passes = 0; const qsa = s.ov.querySelectorAll.bind(s.ov);
  s.ov.querySelectorAll = (sel) => { if (sel === '#c') passes++; return qsa(sel); };   // one look for the record's selector = one pass
  const seen = []; class MO { constructor(cb) { this.cb = cb; seen.push(this); } observe() {} disconnect() {} }
  H.watch(s.ov, 'desktop', { ...s.opts, MutationObserver: MO });
  const node = (cls) => el(s.doc, 'div', { class: cls });
  seen[0].cb([{ addedNodes: [el(s.doc, 'button', { class: 'st-info' }), node('st-help-panel')] }, { addedNodes: [] }]);
  await wait(120); assert.strictEqual(passes, 0, 'our own ⓘ and panel, removals and text: no pass');
  seen[0].cb([{ addedNodes: [node('st-section')] }]);
  await wait(120); const first = passes; assert.ok(first >= 1, 'a section drawn later is attached');
  for (let i = 0; i < 5; i++) seen[0].cb([{ addedNodes: [node('st-section')] }]);
  await wait(100); assert.strictEqual(passes, first, 'within 250 ms of the last pass: no second pass yet');
  await wait(250); assert.strictEqual(passes, first + 1, 'one pass for the whole burst, once the gap has passed');
  loaded();
});

// ---- the ⓘ sits on its label's line (spec V) --------------------------------------------------------------------------------
const recFor = (id, anchors) => ({ id, kind: 'setting', name: 'N ' + id, labels: [], what: 'w', when: 'w', risk: 'r', def: 'd', restart: false, danger: 'everyday', who: 'both', lead: 'none', words: [], scope: 'install', anchors });

test('a text-block label (div.sec-title) gets its ⓘ as its last child; the words stay the same', () => {
  const doc = makeDoc(), win = makeWin(doc);
  const ov = el(doc, 'div'); doc.body.appendChild(ov);
  const sec = el(doc, 'div', { class: 'sec-section' }); ov.appendChild(sec);
  const t = el(doc, 'div', { class: 'sec-title' }, 'Questions'); sec.appendChild(t);
  sec.appendChild(el(doc, 'div', { class: 'sec-hint' }, 'When an agent asks you something'));
  H.setRecords({ records: [recFor('OPT-1', [{ surface: 'phone', label: 'Questions' }])] });
  assert.strictEqual(H.attach(ov, 'phone', { doc, win }), 1);
  const kids = t.children;
  assert.strictEqual(kids[kids.length - 1].tagName, 'BUTTON');
  assert.strictEqual(kids[kids.length - 1].getAttribute('class'), 'st-info');
  assert.strictEqual(sec.children[1].getAttribute('class'), 'sec-hint', 'nothing between the title and its hint');
  assert.strictEqual(infos(sec).length, 1);
  assert.strictEqual(H.attach(ov, 'phone', { doc, win }), 0, 'idempotent: not a second one, inside or after');
  assert.strictEqual(infos(sec).length, 1);
  loaded();
});

test('a LABEL gets its ⓘ right after it and the class st-has-info; a label holding a control is never entered', () => {
  const doc = makeDoc(), win = makeWin(doc, { getComputedStyle: () => ({ display: 'block' }) });
  const ov = el(doc, 'div'); doc.body.appendChild(ov);
  const col = el(doc, 'div', { class: 'col' }); ov.appendChild(col);
  const lab = el(doc, 'label', { for: 'x1' }, 'Voice'); col.appendChild(lab);
  col.appendChild(el(doc, 'input', { id: 'x1', type: 'checkbox' }));
  const wrap = el(doc, 'label', {}, ' Wrapped'); col.appendChild(wrap);
  wrap.appendChild(el(doc, 'input', { id: 'x2', type: 'checkbox' }));
  H.setRecords({ records: [recFor('OPT-1', [{ surface: 'phone', selector: '#x1' }]), recFor('OPT-2', [{ surface: 'phone', selector: '#x2' }])] });
  assert.strictEqual(H.attach(ov, 'phone', { doc, win }), 2);
  assert.strictEqual(lab.nextSibling.getAttribute('data-rec'), 'OPT-1');
  assert.ok(/\bst-has-info\b/.test(lab.getAttribute('class')), 'the label carries the class');
  assert.strictEqual(infos(lab).length, 0, 'never inside a label');
  assert.strictEqual(infos(wrap).length, 0, 'never inside a label holding a control');
  assert.strictEqual(wrap.nextSibling.getAttribute('data-rec'), 'OPT-2');
  for (const f of ['mobile.html', 'index.html', 'users.html']) assert.match(read(f), /label\.st-has-info/, f + ' styles the class');
  loaded();
});

test('a flex row of the desktop Settings keeps its ⓘ after the label, and a text block holding a control is not entered', () => {
  const doc = makeDoc(), win = makeWin(doc);
  const ov = el(doc, 'div'); doc.body.appendChild(ov);
  const row = el(doc, 'div', { class: 'st-row' }); ov.appendChild(row);
  const sp = el(doc, 'span', {}, 'Theme'); row.appendChild(sp);
  row.appendChild(el(doc, 'select', { id: 'th' }));
  const box = el(doc, 'div', { class: 'ss-title' }, 'Name'); ov.appendChild(box);
  box.appendChild(el(doc, 'input', { id: 'nm' }));
  H.setRecords({ records: [recFor('OPT-1', [{ surface: 'phone', selector: '#th' }]), recFor('OPT-2', [{ surface: 'phone', label: 'Name' }])] });
  H.attach(ov, 'phone', { doc, win });
  assert.strictEqual(row.children[1].getAttribute('data-rec'), 'OPT-1', 'after the span, as today');
  assert.strictEqual(infos(sp).length, 0);
  assert.strictEqual(infos(box).length, 0, 'a block holding a control is not entered');
  assert.strictEqual(box.nextSibling.getAttribute('data-rec'), 'OPT-2');
  loaded();
});

test('reading a title for a toast or a lookup does not include the ⓘ', () => {
  const doc = makeDoc(), win = makeWin(doc);
  const ov = el(doc, 'div'); doc.body.appendChild(ov);
  const t = el(doc, 'div', { class: 'sec-title' }, 'Questions'); ov.appendChild(t);
  H.setRecords({ records: [recFor('OPT-1', [{ surface: 'phone', label: 'Questions' }])] });
  H.attach(ov, 'phone', { doc, win });
  assert.strictEqual(infos(t).length, 1);
  assert.strictEqual(H.ownText(t).trim(), 'Questions');
  assert.strictEqual(H.normLabel(H.ownText(t)), 'Questions');
  const b = infos(t)[0];
  assert.strictEqual(b.getAttribute('aria-label'), 'About N OPT-1');
  // the label found again (a second record on the same title) still reads "Questions"
  H.setRecords({ records: [recFor('OPT-2', [{ surface: 'phone', label: 'Questions' }])] });
  assert.strictEqual(H.attach(ov, 'phone', { doc, win }), 0, 'found again by its own words, already has its ⓘ');
  loaded();
});

test('Simple on the phone: the records anchored on simple-phone get their ⓘ in the Simple settings sheet and the agent sheet', () => {
  const json = JSON.parse(read('templates/settings-records.json'));
  H.setRecords(json);
  const doc = makeDoc(), win = makeWin(doc);
  // the sheet as simpleSettingsOpen() draws it (mobile.js), with Deep research as researchSimplePaint() adds it
  const d = el(doc, 'dialog'); doc.body.appendChild(d);
  const sec = (title, id) => { const s = el(doc, 'div', { class: 'ss-sec', ...(id ? { id } : {}) }); d.appendChild(s); s.appendChild(el(doc, 'div', { class: 'ss-title' }, title)); return s; };
  sec('Appearance'); sec('Interface style', 'ss-style-sec'); sec('Name');
  const rs = sec('Deep research', 'ss-research-sec');
  rs.appendChild(el(doc, 'div', { class: 'ss-rseg', 'data-setting': 'OPT-1037', role: 'group' }));
  const sheet = el(doc, 'dialog'); doc.body.appendChild(sheet);
  const list = el(doc, 'div', { class: 'sa-list' }); sheet.appendChild(list);
  list.appendChild(el(doc, 'div', { class: 'sa-switch', 'data-setting': 'OPT-0128' }));
  list.appendChild(el(doc, 'button', { class: 'sa-row sa-more', 'data-setting': 'OPT-1023' }, 'More agents'));
  const n1 = H.attach(d, 'simple-phone', { doc, win }), n2 = H.attach(sheet, 'simple-phone', { doc, win });
  const have = new Set([...infos(d), ...infos(sheet)].map((b) => b.getAttribute('data-rec')));
  for (const id of ['OPT-1022', 'OPT-0284', 'OPT-0613', 'OPT-1036', 'OPT-1037', 'OPT-0128', 'OPT-1023']) assert.ok(have.has(id), id + ' has its ⓘ');
  assert.ok(n1 >= 5 && n2 >= 2);
  // the markup the anchors rely on is in the page code, and both sheets are mounted for the surface
  const mob = read('mobile.js');
  // data-setting, not an id: simpleAgentListFill also fills the sidebar, so an id could appear twice
  for (const id of ['OPT-0128', 'OPT-1023', 'OPT-1037']) assert.ok(mob.includes(`'data-setting', '${id}'`), id);
  assert.match(mob, /function simpleAgentsOpen\(\)[\s\S]*?mount\(d, 'simple-phone'\)[\s\S]*?\n\}/);
  assert.match(mob, /function simpleSettingsOpen\(\)[\s\S]*?mount\(d, 'simple-phone'\)/);
  loaded();
});

// ---- U2 (review round 2) ---------------------------------------------------------------------------------------------
test('U2.1: st-has-info only goes on a label whose computed display is exactly block (flex, inline-flex or no way to tell: no class)', () => {
  for (const [display, want] of [['block', true], ['flex', false], ['inline-flex', false], ['inline-block', false], [undefined, false]]) {
    const doc = makeDoc();
    const win = display === undefined ? makeWin(doc) : makeWin(doc, { getComputedStyle: () => ({ display }) });
    const ov = el(doc, 'div'); doc.body.appendChild(ov);
    const lab = el(doc, 'label', { for: 'u1', class: 'cx-lab' }, 'Voice'); ov.appendChild(lab);
    ov.appendChild(el(doc, 'input', { id: 'u1', type: 'checkbox' }));
    H.setRecords({ records: [recFor('OPT-9', [{ surface: 'phone', selector: '#u1' }])] });
    assert.strictEqual(H.attach(ov, 'phone', { doc, win }), 1);
    assert.strictEqual(lab.nextSibling.getAttribute('data-rec'), 'OPT-9', 'the ⓘ is still right after the label: ' + display);
    assert.strictEqual(/\bst-has-info\b/.test(lab.getAttribute('class')), want, 'display ' + display);
  }
  for (const f of ['mobile.html', 'index.html', 'users.html']) assert.match(read(f), /label\.st-has-info/, f + ' keeps the class rule');
  assert.ok(!/label:has\(\+ \.st-info\)/.test(read('users.html')), 'no rule that restyles every label followed by an ⓘ');
  loaded();
});

test('U2.3: the ⓘ character sits in an aria-hidden span inside the button; the button keeps its aria-label; the block still reads as its words', () => {
  const doc = makeDoc(), win = makeWin(doc);
  const ov = el(doc, 'div'); doc.body.appendChild(ov);
  const t = el(doc, 'div', { class: 'sec-title' }, 'Voice'); ov.appendChild(t);
  H.setRecords({ records: [recFor('OPT-8', [{ surface: 'phone', label: 'Voice' }])] });
  assert.strictEqual(H.attach(ov, 'phone', { doc, win }), 1);
  const b = infos(t)[0];
  assert.strictEqual(b.getAttribute('aria-label'), 'About N OPT-8');
  assert.strictEqual(b.children.length, 1);
  assert.strictEqual(b.children[0].tagName, 'SPAN');
  assert.strictEqual(b.children[0].getAttribute('aria-hidden'), 'true');
  assert.strictEqual(b.children[0].textContent, 'ⓘ');
  assert.strictEqual(H.ownText(t).trim(), 'Voice', 'the words only');
  assert.strictEqual(H.normLabel(H.ownText(t)), 'Voice');
  // the pages only ever WRITE an anchored heading's text (prof-name, .ss-title); the one reader is stSearch over a section's text, which a lone glyph does not change
  const pages = read('app.js') + read('mobile.js');
  assert.ok(!/(sec-title|prof-name|ss-title|sm-lab)[^\n]{0,80}\.(textContent|innerText)(?!\s*=[^=])/.test(pages), 'no page reads those headings\' text');
  loaded();
});

test('U2.4a: a section anchored as a whole gets its ⓘ inside its heading, after the words; every desktop record anchored on a st-section id', () => {
  const doc = makeDoc(), win = makeWin(doc, { getComputedStyle: () => ({ display: 'block' }) });
  const ov = el(doc, 'div'); doc.body.appendChild(ov);
  const ids = [];
  for (const r of JSON.parse(read('templates/settings-records.json')).records) for (const a of r.anchors || []) if (a.surface === 'desktop' && /^#st-[a-z-]+-section$/.test(a.selector || '')) ids.push([r.id, a.selector.slice(1)]);
  assert.ok(ids.length >= 6, 'the six sections of the browser proof');
  H.setRecords(JSON.parse(read('templates/settings-records.json')));
  const secs = {};
  for (const [, id] of ids) {   // the markup app.js draws: <div class="st-section" id=...><h4>Title</h4> rows...
    const s = el(doc, 'div', { class: 'st-section', id }); ov.appendChild(s);
    s.appendChild(el(doc, 'h4', {}, 'Title of ' + id));
    const row = el(doc, 'div', { class: 'st-row' }); s.appendChild(row);
    row.appendChild(el(doc, 'span', {}, 'A thing')); secs[id] = s;
  }
  H.attach(ov, 'desktop', { doc, win });
  for (const [rid, id] of ids) {
    const s = secs[id], h4 = s.children[0];
    const mine = infos(h4).filter((b) => b.getAttribute('data-rec') === rid);
    assert.strictEqual(mine.length, 1, rid + ' on ' + id + ': the ⓘ is in the heading');
    assert.strictEqual(h4.children[h4.children.length - 1], mine[0], 'after the words');
    assert.ok(!(s.nextSibling && s.nextSibling.tagName === 'BUTTON'), 'not after the section');
    assert.strictEqual(H.ownText(h4).trim(), 'Title of ' + id);
  }
  loaded();
});

test('U2.4b: a label wrapping a checkbox and a text span gets the ⓘ at the end of the span; clicking it leaves the checkbox as it was', () => {
  const doc = makeDoc(), win = makeWin(doc, { getComputedStyle: () => ({ display: 'flex' }) });
  const ov = el(doc, 'div'); doc.body.appendChild(ov);
  const lab = el(doc, 'label', {}); ov.appendChild(lab);
  const cb = el(doc, 'input', { id: 'agent-lead', type: 'checkbox' }); cb.checked = false; lab.appendChild(cb);
  const sp = el(doc, 'span', {}, '👑 '); lab.appendChild(sp);
  sp.appendChild(el(doc, 'strong', {}, 'Lead agent')); const tail = el(doc, 'em', {}, ' other agents'); sp.appendChild(tail);
  // the browser's label activation, as HTML says it: a click inside a label toggles its control unless it came from interactive content
  lab.addEventListener('click', (ev) => { if (ev.defaultPrevented || ev.target.tagName === 'BUTTON') return; cb.checked = !cb.checked; });
  H.setRecords({ records: [recFor('OPT-4', [{ surface: 'agent', selector: '#agent-lead' }])] });
  assert.strictEqual(H.attach(ov, 'agent', { doc, win }), 1);
  const b = infos(lab)[0];
  assert.ok(b, 'the ⓘ is inside the label');
  assert.strictEqual(b.parentNode, sp, 'at the end of the text span');
  assert.strictEqual(sp.children[sp.children.length - 1], b);
  assert.strictEqual(lab.nextSibling, null, 'nothing alone after the label');
  assert.ok(!/st-has-info/.test(lab.getAttribute('class') || ''));
  const ev = b.click();
  assert.strictEqual(cb.checked, false, 'the checkbox did not change');
  assert.ok(ev.defaultPrevented && ev.stopped, 'the click is stopped at the ⓘ');
  H.close(false);
  sp.click(); assert.strictEqual(cb.checked, true, 'a click on the words still toggles it (the harness is faithful)');
  // the real browser proof confirms this on the page: a button inside a label never activates the label's control
  loaded();
});

// the phone's Ask over unsaved changes: the harness runs the real askCloseSettingsSheet / askLeadEnv from mobile.js
function askHarness() {
  const mob = read('mobile.js');
  const src = mob.slice(mob.indexOf('function askCloseSettingsSheet()'), mob.indexOf('function askLeadStart()'));
  const listeners = new Set(), ticks = []; let clock = 0, requested = 0;
  const frameWin = {};
  const sheet = { frame: { contentWindow: frameWin } };
  const win = { addEventListener: (t, f) => { if (t === 'message') listeners.add(f); }, removeEventListener: (t, f) => { listeners.delete(f); } };
  const env = {
    window: win, location: { origin: 'https://hub.example' }, document: { querySelectorAll: () => [] }, agents: [{ name: 'maestro', lead: true }],
    Date: { now: () => clock }, setInterval: (f) => { ticks.push({ f, on: true }); return ticks.length; }, clearInterval: (n) => { if (ticks[n - 1]) ticks[n - 1].on = false; },
    settingsSheetRequestClose: () => { requested++; },
    navigate: (s, n) => { h.opened.push(n); }, $: () => null,
  };
  const h = { opened: [], listeners, say: (type) => { for (const f of [...listeners]) f({ source: frameWin, origin: 'https://hub.example', data: { type } }); },
    advance: (ms) => { clock += ms; for (const t of ticks.slice()) if (t.on) t.f(); }, requested: () => requested };
  const body = `let settingsSheet = ${'null'}; let current = null;\n${src}\nreturn { env: askLeadEnv(), ask: askCloseSettingsSheet, open: () => { settingsSheet = SHEET; }, shut: () => { settingsSheet = null; } };`;
  const api = new Function(...Object.keys(env), 'SHEET', body)(...Object.values(env), sheet);
  h.api = api; h.env = api.env; h.api.open();
  return h;
}

test('U2.2: Ask with unsaved changes: question up then Discard = Ask goes on to the lead\'s chat, however long the question stays up', async () => {
  const h = askHarness();
  const run = H.askFill('hello', { ...h.env, getBox: () => ({ value: '', focus() {}, dispatchEvent() {} }) });
  await wait(10);
  assert.strictEqual(h.requested(), 1, 'Settings is asked to close through its guard');
  h.say('mm-settings-asking');
  h.advance(60000);   // far past the 9 s limit: the question is still up
  assert.deepStrictEqual(h.opened, [], 'nothing opened while the question is up');
  h.api.shut();   // Discard: the sheet closed
  h.advance(50);
  assert.strictEqual(await run, true);
  assert.deepStrictEqual(h.opened, ['maestro']);
  assert.strictEqual(h.listeners.size, 0, 'the waiting listener is gone');
});

test('U2.2: question up then Keep editing = Ask does nothing else', async () => {
  const h = askHarness();
  const run = H.askFill('hello', { ...h.env, getBox: () => ({ value: '', focus() {}, dispatchEvent() {} }) });
  await wait(10);
  h.say('mm-settings-asking'); h.advance(30000);
  h.say('mm-settings-kept');   // the frame's final answer
  assert.strictEqual(await run, false);
  assert.deepStrictEqual(h.opened, []);
  assert.strictEqual(h.listeners.size, 0);
});

test('U2.2: a frame that never answers = Ask stops after the limit', async () => {
  const h = askHarness();
  const run = H.askFill('hello', { ...h.env, getBox: () => ({ value: '', focus() {}, dispatchEvent() {} }) });
  await wait(10);
  h.advance(8000);
  let done = false; run.then(() => { done = true; }); await wait(5);
  assert.strictEqual(done, false, 'still within the limit');
  h.advance(1500);
  assert.strictEqual(await run, false);
  assert.deepStrictEqual(h.opened, []);
});

test('U2.2: the users of mm-settings-kept / mm-settings-asking: the frame posts them, the sheet treats both as "the frame answered", Ask waits for the final one', () => {
  const app = read('app.js'), mob = read('mobile.js');
  assert.match(app, /if \(how === 'confirm'\) \{ settingsOnlyAsk\(\); return; \}/);
  assert.match(app, /settingsOnlyPost\('mm-settings-asking'\)/);
  assert.match(mob, /type === 'mm-settings-kept' \|\| type === 'mm-settings-asking' \|\| type === 'mm-settings-popped'\) \{ clearTimeout\(s\.closeTimer\)/);
  assert.match(mob, /!asking && Date\.now\(\) - t0 > 9000/);
  assert.ok(!/mm-settings-kept/.test(read('lib/ui-settings-help.js')));
});

// ---- three ⓘ placement and look fixes (spec W) ------------------------------------------------------------------------
function specificity(sel) {   // [ids, classes+attributes+pseudo-classes, elements]; :is() takes its most specific argument
  let s = sel.trim(), a = 0, b = 0, c = 0;
  s = s.replace(/:is\(([^)]*)\)/g, (_, args) => {
    const best = args.split(',').map((x) => specificity(x)).sort((x, y) => (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2])).pop();
    a += best[0]; b += best[1]; c += best[2]; return '';
  });
  a += (s.match(/#[\w-]+/g) || []).length;
  b += (s.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) || []).length;
  c += (s.replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|:+[\w-]+/g, ' ').match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length;
  return [a, b, c];
}
const outranks = (x, y) => (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]);

test('W1: on the phone the .st-info rule for the sheets outranks the sheet button rule and is a transparent round outline', () => {
  const mob = read('mobile.html');
  const rule = mob.split('\n').find((l) => /button\.st-info \{/.test(l) && /#notify-prefs-sheet/.test(l));
  assert.ok(rule, 'a sheet-level button.st-info rule');
  const sel = rule.slice(0, rule.indexOf('{')).trim();
  const body = rule.slice(rule.indexOf('{'), rule.indexOf('}'));
  assert.match(body, /background: transparent/);
  assert.match(body, /min-height: 0/);
  assert.match(body, /padding: 0/);
  assert.match(body, /border-radius: 50%/);
  const sheetBtn = mob.split('\n').find((l) => /^\s*#notify-agent-sheet button, #notify-prefs-sheet button \{/.test(l));
  assert.ok(sheetBtn, 'the sheet button rule');
  const theirs = specificity('#notify-prefs-sheet button'), theirs2 = specificity('#notify-prefs-sheet .np-row button');
  assert.ok(outranks(specificity(sel), theirs) > 0, 'outranks "#notify-prefs-sheet button"');
  assert.ok(outranks(specificity(sel), theirs2) >= 0, 'at least ties "#notify-prefs-sheet .np-row button" (and comes after it)');
  assert.ok(mob.indexOf(rule) > mob.indexOf('#notify-prefs-sheet .np-row button'), 'after the np-row rule');
  assert.match(sheetBtn, /background: var\(--border\)/, 'the tile background it overrides');
  // the phone frame and Simple dialogs
  const idx = read('index.html');
  const fr = idx.split('\n').find((l) => /html\.mm-settings-only \.st-modal button\.st-info/.test(l));
  assert.ok(fr, 'the frame rule');
  assert.match(fr, /background: transparent/);
  assert.ok(outranks(specificity('html.mm-settings-only .st-modal button.st-info'), specificity('html.mm-settings-only .st-modal button')) > 0);
  assert.ok(outranks(specificity('html.mm-simple .simple-modal button.st-info'), specificity('html.mm-simple .simple-modal button')) > 0);
});

test('W2: an ⓘ after a hidden control is hidden by CSS, in the three pages that draw it', () => {
  for (const f of ['index.html', 'mobile.html', 'users.html']) {
    const t = read(f);
    assert.ok(t.includes('[hidden] + .st-info, [style*="display:none"] + .st-info, [style*="display: none"] + .st-info { display: none; }'), f);
  }
});

test('W3: a previous plain text sibling is the label of an anchored container; one holding a control is not taken', () => {
  const run = (build) => {
    const doc = makeDoc(); const win = makeWin(doc);
    const ov = el(doc, 'div', { id: 'ov' }); doc.body.appendChild(ov);
    const sec = el(doc, 'div', { class: 'section' }); ov.appendChild(sec);
    const wrap = el(doc, 'div', {}); sec.appendChild(wrap);
    build(doc, wrap);
    H.setRecords({ version: 1, leadTool: false, records: [r1rec('OPT-W3', '#agent-shared', { anchors: [{ surface: 'agent', selector: '#agent-shared' }] })] });
    const n = H.attach(ov, 'agent', { document: doc, win });
    return { doc, wrap, n };
  };
  const a = run((doc, wrap) => { el(doc, 'span', {}, 'Shared with'); wrap.appendChild(el(doc, 'span', {}, 'Shared with')); wrap.appendChild(el(doc, 'div', { id: 'agent-shared' }, 'users')); });
  assert.strictEqual(a.n, 1);
  const span = a.wrap.children[0];
  assert.strictEqual(a.wrap.children.length, 2, 'no ⓘ after the list');
  assert.strictEqual(span.children[span.children.length - 1].getAttribute('class'), 'st-info', 'the ⓘ ends the span');
  const b = run((doc, wrap) => { const p = el(doc, 'div', {}); p.appendChild(el(doc, 'span', {}, 'Pick')); p.appendChild(el(doc, 'select', {})); wrap.appendChild(p); wrap.appendChild(el(doc, 'div', { id: 'agent-shared' }, 'users')); });
  assert.strictEqual(b.wrap.children[0].children.length, 2, 'nothing put into the sibling that holds a control');
  assert.strictEqual(b.wrap.children[b.wrap.children.length - 1].getAttribute('class'), 'st-info', 'the ⓘ goes after the control as before');
  const c = run((doc, wrap) => { wrap.appendChild(el(doc, 'span', { id: 'sp' }, 'Other')); wrap.appendChild(el(doc, 'div', { id: 'agent-shared' }, 'users')); const l = el(doc, 'label', { for: 'sp' }, 'x'); wrap.parentNode.appendChild(l); });
  assert.strictEqual(c.wrap.children[0].children.length, 0, 'a span that is another control\'s label is not taken');
});
