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
  const make = new Function('document', 'stSetOpen', `let stSearchSnap = null; let stWordsIdx = null; ${body}; return { stSearch, setIdx: (v) => { stWordsIdx = v; } };`);
  const p = page();
  const wrap = el(p.doc, 'div', { id: 'st-groups' }); p.doc.body.appendChild(wrap);
  const mk = (id, title, secs) => { const g = el(p.doc, 'details', { class: 'st-group' }); g.dataset.group = id; g.open = false; const t = el(p.doc, 'span', { class: 'st-group-title' }, title); g.appendChild(t); for (const s of secs) g.appendChild(s); wrap.appendChild(g); return g; };
  const g1 = mk('memory', 'Memory', [p.secA]), g2 = mk('safety', 'Safety', [p.secB]), g3 = mk('voice', 'Voice', [p.secC]);
  const none = el(p.doc, 'span', { id: 'st-search-none' }); p.doc.body.appendChild(none); none.hidden = true;
  const doc = { querySelectorAll: (s) => wrap.querySelectorAll(s.replace('#st-groups ', '')), getElementById: (id) => (id === 'st-search-none' ? none : null) };
  const fns = make(doc, (g, open) => { g.open = !!open; });
  return { ...fns, p, g1, g2, g3, none, wrap };
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
  assert.strictEqual(r.g1.open, true); assert.strictEqual(r.g2.style.display, 'none');
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
  assert.strictEqual(r.p.secA.style.display, ''); assert.strictEqual(r.g2.style.display, '');
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
  assert.ok(as.includes(tag) && as.indexOf(tag) < as.indexOf("hubSettingsHelp.mount(document, 'agent-settings')"), 'agent-settings.html');
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
  assert.match(read('agent-settings.html'), /hubSettingsHelp\.mount\(document, 'agent-settings'\)/);
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
  for (const f of ['index.html', 'mobile.html', 'agent-settings.html', 'users.html']) {
    const rs = rules(read(f));
    assert.ok(rs.length >= 8, f + ': the rules are there');
    for (const l of rs) assert.ok(!lit.test(l), f + ': ' + l.trim().slice(0, 80));
  }
  const lib = read('lib/ui-settings-help.js');
  assert.ok(!lit.test(lib.replace(/\/\*[\s\S]*?\*\//g, '')), 'the script sets no colour');
  assert.ok(!/style\.(color|background)/.test(lib));
  // agent-settings.html keeps to its own --as-* variables (and the page-wide ones it never defines are not used)
  for (const l of rules(read('agent-settings.html'))) for (const m of l.matchAll(/var\(--([\w-]+)/g)) assert.match(m[1], /^as-/, l.trim().slice(0, 60));
});

test('the ⓘ is at least 32x32 on the phone page and in the phone frame', () => {
  const mob = read('mobile.html'), idx = read('index.html');
  assert.match(mob, /\.st-info \{[^}]*width: 32px; height: 32px;/);
  assert.match(idx, /html\.mm-settings-only \.st-info \{[^}]*width: 32px; height: 32px;/);
});

test('the phone service worker is bumped for the new mobile.html and mobile.js (hub-mobile-v98)', () => {
  assert.match(read('sw.js'), /const VERSION = 'hub-mobile-v98'/);
});
