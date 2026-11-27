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
  let deliveries = 0; let runaway = false; let queued = false;
  const pending = new Set();
  function notify(target) {
    for (const o of observers) if (o.targets.includes(target)) pending.add(o);
    if (queued || !pending.size) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      const now = [...pending]; pending.clear();
      for (const o of now) {
        if (deliveries >= MAX_DELIVERIES) { runaway = true; return; }
        deliveries++;
        o.f([]);
      }
    });
  }
  function node(tag) {
    const n = {
      tag, className: '', id: '', hidden: false, disabled: false, textContent: '', children: [], listeners: {}, attrs: {}, parentNode: null, isConnected: true,
      classList: { contains: (c) => String(n.className).split(/\s+/).includes(c), add: (c) => { if (!n.classList.contains(c)) n.className = `${n.className} ${c}`.trim(); }, remove: () => {}, toggle: () => {} },
      appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c, true); c.parentNode = this; this.children.push(c); notify(this); return c; },
      insertBefore(c, ref) {
        if (!ref) return this.appendChild(c);
        if (c.parentNode) c.parentNode.removeChild(c, true);
        const i = this.children.indexOf(ref); c.parentNode = this; this.children.splice(i < 0 ? this.children.length : i, 0, c); notify(this); return c;
      },
      removeChild(c, quiet) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; if (!quiet) notify(this); return c; },
      replaceChildren(...c) { this.children.forEach((x) => { x.parentNode = null; }); this.children = []; c.forEach((x) => { x.parentNode = this; this.children.push(x); }); notify(this); },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k]; },
      hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); },
      addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
      focus() {},
      get lastChild() { return this.children[this.children.length - 1] || null; },
      get lastElementChild() { return this.lastChild; },
      get nextElementSibling() { const p = this.parentNode; if (!p) return null; const i = p.children.indexOf(this); return p.children[i + 1] || null; },
    };
    return n;
  }
  class MO { constructor(f) { this.f = f; this.targets = []; observers.push(this); } observe(t) { this.targets.push(t); } disconnect() { this.targets = []; } }
  return { node, MO, stats: () => ({ deliveries, runaway }) };
}

function load() {
  const D = dom();
  const d = {
    activeElement: null, readyState: 'complete', visibilityState: 'visible', listeners: {},
    createElement: (t) => D.node(t), createTextNode: (t) => { const n = D.node('#text'); n.textContent = t; return n; },
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
  };
  d.body = D.node('body'); d.head = D.node('head'); d.documentElement = D.node('html');
  const card = { ok: true, show: true, lead: 'harbor', leadDisplay: 'Harbor', notices: [],
    entries: [{ id: 'quick-research', title: 'Quick research', summary: 'A run for its own work.', cost: 'plan allowance', leadMay: true, recommendation: null, rev: 'pending #0' }] };
  const fetch = () => Promise.resolve({ status: 200, json: async () => card });
  const mod = { exports: {} };
  const ctx = { module: mod, document: d, fetch, location: { search: '' }, encodeURIComponent, JSON, Promise, console, MutationObserver: D.MO, Date: { now: () => 1000000 }, setTimeout, clearTimeout, queueMicrotask };
  vm.runInNewContext(SRC, ctx, { filename: FILE });
  return { FC: mod.exports, D, d };
}
// The phone's busy card as mobile.js paints it: appended last, and its own observer puts it back at the end after anything else is added.
function busyCard(D, list) {
  const el = D.node('div'); el.className = 'chat-busy-card';
  list.appendChild(el);
  const o = new D.MO(() => { if (el.parentNode === list && list.lastElementChild !== el) list.appendChild(el); });
  o.observe(list, { childList: true });
  return el;
}
const settle = async () => { for (let k = 0; k < 40; k++) await new Promise((r) => setImmediate(r)); };

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
