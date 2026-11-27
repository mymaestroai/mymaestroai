'use strict';
// The new-features card and another "stay last" element in the same chat list (the phone's busy card keeps itself at the end with its
// own MutationObserver, mobile.js paintBusyCard). Two observers that each move their element to the end would move each other for ever;
// one such loop grew a browser page to hundreds of GB. This file runs the card with a small DOM whose MutationObserver delivers records
// after every append or insert, like a browser, and caps the deliveries so a loop fails the test instead of hanging it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FILE = path.join(__dirname, '..', 'lib', 'ui-feature-card.js');
const SRC = fs.readFileSync(FILE, 'utf8');
const MAX_DELIVERIES = 5000;

function dom() {
  const observers = [];
  const focused = { el: null };
  let deliveries = 0; let runaway = false; let queued = false;
  const pending = new Map();   // observer -> the nodes added since its last delivery
  function notify(target, added = [], removed = []) {
    for (const o of observers) if (o.targets.includes(target)) { const p = pending.get(o) || { addedNodes: [], removedNodes: [] }; p.addedNodes = p.addedNodes.concat(added); p.removedNodes = p.removedNodes.concat(removed); pending.set(o, p); }
    if (queued || !pending.size) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      const now = [...pending]; pending.clear();
      for (const [o, rec] of now) {
        if (deliveries >= MAX_DELIVERIES) { runaway = true; return; }
        deliveries++;
        o.f([{ addedNodes: rec.addedNodes, removedNodes: rec.removedNodes }]);
      }
    });
  }
  function node(tag) {
    const n = {
      tag, className: '', id: '', hidden: false, disabled: false, textContent: '', children: [], listeners: {}, attrs: {}, parentNode: null, isConnected: true,
      classList: { contains: (c) => String(n.className).split(/\s+/).includes(c), add: (c) => { if (!n.classList.contains(c)) n.className = `${n.className} ${c}`.trim(); }, remove: () => {}, toggle: () => {} },
      appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c, true); c.parentNode = this; this.children.push(c); notify(this, [c]); return c; },
      insertBefore(c, ref) {
        if (!ref) return this.appendChild(c);
        if (c.parentNode) c.parentNode.removeChild(c, true);
        const i = this.children.indexOf(ref); c.parentNode = this; this.children.splice(i < 0 ? this.children.length : i, 0, c); notify(this, [c]); return c;
      },
      removeChild(c, quiet) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; if (!quiet) notify(this, [], [c]); return c; },
      replaceChildren(...c) { const old = this.children.slice(); this.children.forEach((x) => { x.parentNode = null; }); this.children = []; c.forEach((x) => { x.parentNode = this; this.children.push(x); }); notify(this, c, old); },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k]; },
      hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); },
      addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
      focus() { focused.el = this; },
      click() { if (this.disabled) return; (this.listeners.click || []).forEach((f) => f({ preventDefault() {} })); },
      get lastChild() { return this.children[this.children.length - 1] || null; },
      get lastElementChild() { return this.lastChild; },
      get nextElementSibling() { const p = this.parentNode; if (!p) return null; const i = p.children.indexOf(this); return p.children[i + 1] || null; },
    };
    return n;
  }
  class MO { constructor(f) { this.f = f; this.targets = []; observers.push(this); } observe(t) { this.targets.push(t); } disconnect() { this.targets = []; } }
  return { node, MO, focused, stats: () => ({ deliveries, runaway }) };
}

function load({ deferGet = false } = {}) {
  const D = dom();
  const d = {
    activeElement: null, readyState: 'complete', visibilityState: 'visible', listeners: {},
    createElement: (t) => D.node(t), createTextNode: (t) => { const n = D.node('#text'); n.textContent = t; return n; },
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
  };
  d.body = D.node('body'); d.head = D.node('head'); d.documentElement = D.node('html');
  const card = { ok: true, show: true, lead: 'harbor', leadDisplay: 'Harbor', notices: [],
    entries: [{ id: 'quick-research', title: 'Quick research', summary: 'A run for its own work.', cost: 'plan allowance', leadMay: true, recommendation: null, rev: 'pending #0' }] };
  const gets = [];
  const fetch = () => deferGet ? new Promise((r) => gets.push(() => r({ status: 200, json: async () => card }))) : Promise.resolve({ status: 200, json: async () => card });
  const mod = { exports: {} };
  const ctx = { module: mod, document: d, fetch, location: { search: '', assign(u) { ctx.assigned.push(u); } }, assigned: [], encodeURIComponent, JSON, Promise, console, MutationObserver: D.MO, Date: { now: () => CLOCK.t }, setTimeout, clearTimeout, queueMicrotask };
  vm.runInNewContext(SRC, ctx, { filename: FILE });
  // these tests model a page whose saved history is already drawn (a page that signals nothing is the done test's business)
  { const ex = mod.exports, shown = ex.chatShown; ex.chatShown = (a, l, o) => { shown(a, l, o); if (l && !ex.noAutoDrawn) ex.historyDrawn(l); }; }
  return { FC: mod.exports, D, d, ctx, card, gets };
}
// The phone's busy card as mobile.js paints it: appended last, and its own observer puts it back at the end after anything else is added.
function busyCard(D, list) {
  const el = D.node('div'); el.className = 'chat-busy-card';
  list.appendChild(el);
  const o = new D.MO(() => { if (el.parentNode === list && list.lastElementChild !== el) list.appendChild(el); });
  o.observe(list, { childList: true });
  return el;
}
const CLOCK = { t: 1000000 };   // moves on 3 s after each settle, so the card's quiet window for folding has passed
const settle = async () => { for (let k = 0; k < 40; k++) await new Promise((r) => setImmediate(r)); CLOCK.t += 3000; };

test('the card and the phone busy card in one list settle: the card sits just above the busy card, no endless moving', async () => {
  const { FC, D } = load();
  const list = D.node('div'); list.id = 'messages';
  list.appendChild(D.node('div'));   // a message bubble
  const busy = busyCard(D, list);
  FC.chatShown('harbor', list);
  await settle();
  const s = D.stats();
  assert.strictEqual(s.runaway, false, `observer deliveries ran away (${s.deliveries})`);
  assert.ok(s.deliveries < 50, `few deliveries, got ${s.deliveries}`);
  const kids = list.children;
  assert.strictEqual(kids[kids.length - 1], busy, 'the busy card stays last');
  assert.ok(String(kids[kids.length - 2].className).includes('feature-card'), 'the card sits just above it');
});

test('a new bubble added below both: the order settles again (bubble, card, busy card)', async () => {
  const { FC, D } = load();
  const list = D.node('div');
  const busy = busyCard(D, list);
  FC.chatShown('harbor', list);
  await settle();
  const bubble = D.node('div'); bubble.className = 'msg';
  list.appendChild(bubble);
  await settle();
  const s = D.stats();
  assert.strictEqual(s.runaway, false, `observer deliveries ran away (${s.deliveries})`);
  const kids = list.children;
  assert.deepStrictEqual(kids.slice(-3).map((k) => k === busy ? 'busy' : k === bubble ? 'bubble' : (String(k.className).includes('feature-card') ? 'card' : '?')), ['bubble', 'card', 'busy']);
});

test('any element marked data-keep-last is respected the same way', async () => {
  const { FC, D } = load();
  const list = D.node('div');
  const keep = D.node('div'); keep.setAttribute('data-keep-last', '');
  list.appendChild(keep);
  const o = new D.MO(() => { if (keep.parentNode === list && list.lastElementChild !== keep) list.appendChild(keep); });
  o.observe(list, { childList: true });
  FC.chatShown('harbor', list);
  await settle();
  assert.strictEqual(D.stats().runaway, false);
  assert.strictEqual(list.children[list.children.length - 1], keep);
});

test('backstop: against an unknown element that also forces itself last, the card stops moving after a bounded number of moves', async () => {
  const { FC, D } = load();
  const list = D.node('div');
  const other = D.node('div'); other.className = 'someone-else';
  list.appendChild(other);
  const o = new D.MO(() => { if (other.parentNode === list && list.lastElementChild !== other) list.appendChild(other); });
  o.observe(list, { childList: true });
  FC.chatShown('harbor', list);
  await settle();
  const s = D.stats();
  assert.strictEqual(s.runaway, false, `observer deliveries ran away (${s.deliveries})`);
  assert.ok(s.deliveries < 1000, `bounded, got ${s.deliveries}`);
});

// The desktop's busy card keeps itself last only when it paints (no observer): a bubble can land after it in between.
function desktopBusy(D, list) { const el = D.node('div'); el.className = 'chat-busy-card'; list.appendChild(el); return el; }
const order = (list, names) => list.children.map((k) => names.get(k) || (String(k.className).includes('feature-card') ? 'card' : '?'));

test('desktop busy card without an observer: a bubble after it gives bubble, card, busy card (not busy, bubble, card)', async () => {
  const { FC, D } = load();
  const list = D.node('div');
  const busy = desktopBusy(D, list);
  FC.chatShown('harbor', list);
  await settle();
  const bubble = D.node('div'); bubble.className = 'msg';
  list.appendChild(bubble);
  await settle();
  assert.strictEqual(D.stats().runaway, false);
  assert.deepStrictEqual(order(list, new Map([[busy, 'busy'], [bubble, 'bubble']])), ['bubble', 'card', 'busy']);
});

test('the card already last with the busy card higher up: the busy card goes back to the end, the card just above it', async () => {
  const { FC, D } = load();
  const list = D.node('div');
  FC.chatShown('harbor', list);
  await settle();
  const busy = desktopBusy(D, list);   // painted after the card ...
  const bubble = D.node('div');
  list.insertBefore(busy, list.children[0]);   // ... and moved above it by a redraw
  list.appendChild(bubble);
  await settle();
  assert.strictEqual(D.stats().runaway, false);
  const o = order(list, new Map([[busy, 'busy'], [bubble, 'bubble']]));
  assert.deepStrictEqual(o.slice(-2), ['card', 'busy']);
  assert.ok(o.indexOf('bubble') < o.indexOf('card'), o.join(','));
});

test('after the move limit gave up, a chat switch places the card at once in the new list (the spent budget is reset too)', async () => {
  const { FC, D } = load();
  const a = D.node('div');
  const other = D.node('div'); other.className = 'someone-else';
  a.appendChild(other);
  const o = new D.MO(() => { if (other.parentNode === a && a.lastElementChild !== other) a.appendChild(other); });
  o.observe(a, { childList: true });
  FC.chatShown('harbor', a);
  await settle();
  const b = D.node('div'); b.appendChild(D.node('div'));
  FC.chatShown('harbor', b);
  await settle();
  const last = b.children[b.children.length - 1];
  assert.ok(last && String(last.className).includes('feature-card'), 'the card is placed at the end of the new list');
});

// ---- folding when a newer message arrives, the closing link, the second admin header ----
const isCard = (k) => String(k.className).includes('feature-card');
const cardIn = (list) => list.children.find(isCard);
const allNodes = (n, out = []) => { out.push(n); n.children.forEach((c) => allNodes(c, out)); return out; };
const buttonsIn = (n) => allNodes(n).filter((x) => x.tag === 'button');
const toggleOf = (n) => buttonsIn(n).find((b) => /\bfc-toggle\b/.test(b.className));

test('(a) bubbles appended without messageArrived (saved history) never fold the card', async () => {
  const { FC, D } = load();
  const list = D.node('div'); list.appendChild(D.node('div'));
  FC.chatShown('harbor', list); await settle();
  for (let i = 0; i < 4; i++) { const b = D.node('div'); b.className = 'msg'; list.appendChild(b); await settle(); }
  const old = D.node('div'); list.insertBefore(old, list.children[0]); await settle();
  const card = cardIn(list);
  assert.ok(card && buttonsIn(card).some((b) => b.textContent === 'Turn on'), 'still unfolded');
  assert.ok(!toggleOf(card), 'a plain header');
  assert.strictEqual(list.children[list.children.length - 1], card, 'the card stays last');
});

test('(b) messageArrived(list) folds it to its header button; the card stays last', async () => {
  const { FC, D } = load();
  const list = D.node('div'); list.appendChild(D.node('div'));
  FC.chatShown('harbor', list); await settle();
  const card = cardIn(list);
  assert.ok(card && buttonsIn(card).some((b) => b.textContent === 'Turn on'), 'unfolded to begin with');
  assert.ok(!toggleOf(card), 'a plain header before any fold');
  const bubble = D.node('div'); bubble.className = 'msg'; list.appendChild(bubble);
  FC.messageArrived(list);
  await settle();
  assert.strictEqual(D.stats().runaway, false);
  assert.strictEqual(list.children[list.children.length - 1], card, 'the card is last');
  const t = toggleOf(card);
  assert.ok(t, 'the header is a button');
  assert.strictEqual(t.type, 'button');
  assert.strictEqual(t.getAttribute('aria-expanded'), 'false');
  assert.ok(t.textContent.endsWith(' \u25BE'), t.textContent);
  assert.ok(t.textContent.startsWith('One new feature is off until you say yes.'));
  assert.deepStrictEqual(buttonsIn(card), [t], 'no row buttons');
});

test('(a2) folded and a busy card present: the card sits just above the busy card', async () => {
  const { FC, D } = load();
  const list = D.node('div');
  const busy = desktopBusy(D, list);
  FC.chatShown('harbor', list); await settle();
  const bubble = D.node('div'); list.appendChild(bubble); FC.messageArrived(list); await settle();
  assert.strictEqual(D.stats().runaway, false);
  assert.ok(toggleOf(cardIn(list)), 'folded');
  assert.deepStrictEqual(order(list, new Map([[busy, 'busy'], [bubble, 'bubble']])), ['bubble', 'card', 'busy']);
});

test('(b) adding a busy card or a keep-last element does not fold the card', async () => {
  const { FC, D } = load();
  const list = D.node('div'); list.appendChild(D.node('div'));
  FC.chatShown('harbor', list); await settle();
  busyCard(D, list);
  const keep = D.node('div'); keep.setAttribute('data-keep-last', ''); list.appendChild(keep);
  await settle();
  assert.strictEqual(D.stats().runaway, false);
  assert.ok(!toggleOf(cardIn(list)), 'not folded');
  assert.ok(buttonsIn(cardIn(list)).some((b) => b.textContent === 'Turn on'));
});

test('(c) messageArrived for another list does nothing', async () => {
  const { FC, D } = load();
  const list = D.node('div'); const other = D.node('div'); list.appendChild(D.node('div'));
  FC.chatShown('harbor', list); await settle();
  FC.messageArrived(other); await settle();
  assert.ok(!toggleOf(cardIn(list)), 'not folded');
  FC.messageArrived(); await settle();   // no list: the card's own list counts
  assert.ok(toggleOf(cardIn(list)), 'folded when no list is named and the card is in the target');
});

test('(d) pressing the header unfolds (rows back, aria-expanded true, focus on the first button); pressing again folds', async () => {
  const { FC, D } = load();
  const list = D.node('div'); list.appendChild(D.node('div'));
  FC.chatShown('harbor', list); await settle();
  list.appendChild(D.node('div')); FC.messageArrived(list); await settle();
  const card = cardIn(list);
  toggleOf(card).click();
  assert.strictEqual(list.children[list.children.length - 1], card);
  let t = toggleOf(card);
  assert.strictEqual(t.getAttribute('aria-expanded'), 'true');
  assert.ok(t.textContent.endsWith(' \u25B4'), t.textContent);
  const turnOn = buttonsIn(card).find((b) => b.textContent === 'Turn on');
  assert.ok(turnOn, 'the rows are back');
  assert.strictEqual(D.focused.el, turnOn, 'focus goes to the first button of the first open row');
  t.click();
  await settle();
  t = toggleOf(card);
  assert.strictEqual(t.getAttribute('aria-expanded'), 'false');
  assert.ok(t.textContent.endsWith(' \u25BE'));
  assert.deepStrictEqual(buttonsIn(card), [t]);
  assert.strictEqual(D.stats().runaway, false);
});

test('a chat switch away and back does not unfold; a new message while unfolded after a fold folds again', async () => {
  const { FC, D } = load();
  const a = D.node('div'); const b = D.node('div'); a.appendChild(D.node('div'));
  FC.chatShown('harbor', a); await settle();
  a.appendChild(D.node('div')); FC.messageArrived(a); await settle();
  assert.ok(toggleOf(cardIn(a)));
  FC.chatShown('other', b); await settle();
  FC.chatShown('harbor', a); await settle();
  assert.ok(toggleOf(cardIn(a)), 'still folded');
  toggleOf(cardIn(a)).click();
  a.appendChild(D.node('div')); FC.messageArrived(a); await settle();
  assert.strictEqual(toggleOf(cardIn(a)).getAttribute('aria-expanded'), 'false');
});

test('(e0) with every row owner-locked, unfolding keeps focus on the toggle', async () => {
  const { FC, D, card } = load();
  card.entries[0].canSwitch = false;
  const list = D.node('div'); list.appendChild(D.node('div'));
  FC.chatShown('harbor', list); await settle();
  FC.messageArrived(list); await settle();
  toggleOf(cardIn(list)).click();
  const t = toggleOf(cardIn(list));
  assert.strictEqual(t.getAttribute('aria-expanded'), 'true');
  assert.deepStrictEqual(buttonsIn(cardIn(list)), [t], 'no row buttons');
  assert.strictEqual(D.focused.el, t, 'focus stays on the (new) toggle');
});

test('(e) the Settings page copy from renderInto never folds', async () => {
  const { FC, D } = load();
  const box = D.node('div'); D.node('div');
  const list = D.node('div'); list.appendChild(D.node('div'));
  await FC.renderInto(box);
  FC.chatShown('harbor', list); await settle();
  list.appendChild(D.node('div')); FC.messageArrived(list); box.appendChild(D.node('div')); await settle();
  assert.ok(toggleOf(cardIn(list)), 'the chat copy folded');
  const page = box.children.find(isCard);
  assert.ok(page, 'the page copy is drawn');
  assert.ok(!toggleOf(page), 'no fold button');
  assert.ok(buttonsIn(page).some((x) => x.textContent === 'Turn on'));
});

test('(e) the closing line says "on the Changes page" and its link goes to API.openChanges, else location.assign(/changes)', async () => {
  for (const mode of ['fn', 'assign', 'nothing']) {
    const { FC, D, ctx, card: cardBody } = load();
    cardBody.entries = []; cardBody.notices = [{ id: 'quiet-fix', title: 'Faster history search', line: 'Nothing for you to do.' }];   // a notice answered OK leaves no done line: the closing line shows
    let n = 0;
    if (mode === 'fn') FC.openChanges = () => { n++; };
    if (mode === 'nothing') ctx.location = {};   // no assign at all: nothing happens, nothing throws
    const list = D.node('div'); list.appendChild(D.node('div'));
    FC.chatShown('harbor', list); await settle();
    const box = D.node('div'); await FC.renderInto(box);   // the closing line is the Settings copy's (the chat copy of a notice-only answer goes away)
    buttonsIn(box).find((b) => b.textContent === 'OK').click();
    await settle();
    assert.strictEqual(cardIn(list), undefined, mode + ': the chat copy goes');
    const card = box;
    const closing = allNodes(card).find((x) => /\bfc-closing\b/.test(x.className));
    assert.ok(closing, mode);
    const text = (x) => (x.textContent || '') + x.children.map(text).join('');
    assert.strictEqual(text(closing), 'All set. You can change these any time on the Changes page.');
    const link = buttonsIn(closing)[0];
    assert.strictEqual(link.textContent, 'Changes page');
    link.click();
    if (mode === 'fn') { assert.strictEqual(n, 1); assert.deepStrictEqual(ctx.assigned, []); }
    if (mode === 'assign') assert.deepStrictEqual(ctx.assigned, ['/changes']);
    if (mode === 'nothing') assert.deepStrictEqual(ctx.assigned, []);
  }
});

test('(f) second admin: every open entry locked (canSwitch false) says "until the owner says yes."', async () => {
  const mk = async (mut) => {
    const l = load(); mut(l.card);
    const list = l.D.node('div'); l.FC.chatShown('harbor', list); await settle();
    return l.FC.headerText();
  };
  assert.strictEqual(await mk((c) => { c.entries[0].canSwitch = false; }), 'One new feature is off until the owner says yes.');
  assert.strictEqual(await mk((c) => { c.entries.push({ ...c.entries[0], id: 'b' }); c.entries.forEach((e) => { e.canSwitch = false; }); }), 'Two new features are off until the owner says yes.');
  assert.strictEqual(await mk((c) => { c.entries.push({ ...c.entries[0], id: 'b' }); c.entries[0].canSwitch = false; }), 'Two new features are off until you say yes.', 'one row can be switched');
  assert.strictEqual(await mk((c) => { c.entries[0].canSwitch = false; c.notices.push({ id: 'n', title: 'T', line: 'x' }); }), 'One new feature is off until you say yes.', 'a notice row is open too');
  assert.strictEqual(await mk(() => {}), 'One new feature is off until you say yes.');
});

test('(g) messageArrived with focus inside the card moves focus to the toggle; focus elsewhere is left alone', async () => {
  for (const inside of [true, false]) {
    const { FC, D, d } = load();
    const list = D.node('div'); list.appendChild(D.node('div'));
    FC.chatShown('harbor', list); await settle();
    const card = cardIn(list);
    card.contains = (x) => allNodes(card).includes(x);
    const other = D.node('textarea');
    const turnOn = buttonsIn(card).find((b) => b.textContent === 'Turn on');
    d.activeElement = inside ? turnOn : other;
    D.focused.el = d.activeElement;
    FC.messageArrived(list);
    const t = toggleOf(card);
    assert.ok(t, 'folded');
    if (inside) assert.strictEqual(D.focused.el, t, 'focus moved to the toggle');
    else assert.strictEqual(D.focused.el, other, 'focus untouched');
  }
});

const isFolded = (list) => { const c = list.children.find((k) => String(k.className).includes('feature-card')); return !!c && c.children.length === 1 && String(c.children[0].className).includes('fc-toggle') && c.children[0].getAttribute('aria-expanded') === 'false'; };   // closed: the header button alone

test('a live message before the card first answers: the card arrives folded in that chat visit', async () => {
  const { FC, D, gets } = load({ deferGet: true });
  const list = D.node('div');
  FC.chatShown('harbor', list);
  await settle();
  const b = D.node('div'); b.className = 'msg'; list.appendChild(b);
  FC.messageArrived(list);   // the reply starts while the card's GET is still out
  gets.shift()();
  await settle();
  assert.ok(list.children.some((k) => String(k.className).includes('feature-card')), 'card attached');
  assert.strictEqual(isFolded(list), true, 'arrives folded');
});

test('phone shared list: a live message in another agent\'s chat before the GET does not fold the lead\'s card', async () => {
  const { FC, D, gets } = load({ deferGet: true });
  const list = D.node('div'); list.appendChild(D.node('div'));
  FC.chatShown('someone', list);
  FC.messageArrived(list);   // a live message in someone else's chat
  FC.chatShown('harbor', list);   // then the lead's chat on the same list
  gets.shift()();
  await settle();
  assert.ok(list.children.some((k) => String(k.className).includes('feature-card')), 'card attached');
  assert.strictEqual(isFolded(list), false, 'not folded');
});
