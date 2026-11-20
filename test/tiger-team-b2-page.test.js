'use strict';
// The war-room page (tiger-team.html), batch 2: approvals answerable on the page (P1) and download cards under replies (P2).
// The page's own functions are cut out of its source and run in a vm with a very small fake DOM.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../tiger-team.html'), 'utf8');

function cut(from, to) {
  const a = html.indexOf(from); assert.ok(a > 0, from + ' not found');
  const b = html.indexOf(to, a); assert.ok(b > a, to + ' not found');
  return html.slice(a, b);
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** A stub element: querySelector gives one stable stub per selector; innerHTML is just kept as a string. */
function stub(tag) {
  const kids = new Map();
  const el = {
    tag, innerHTML: '', textContent: '', className: '', dataset: {}, disabled: false, removed: false, onclick: null, children: [],
    classList: { _s: new Set(), add(c) { this._s.add(c); }, contains(c) { return this._s.has(c); } },
    querySelector(sel) { if (!kids.has(sel)) kids.set(sel, stub(sel)); return kids.get(sel); },
    querySelectorAll(sel) { if (sel === 'button') return ['.deny', '.allow'].map(s => el.querySelector(s)).filter(b => !b.removed); return []; },
    insertBefore(n) { el.children.unshift(n); },
    appendChild(n) { el.children.push(n); },
    remove() { el.removed = true; },
    isConnected: true,
  };
  return el;
}

// ── P1. Approvals ──
function approvalCtx(fetchImpl) {
  const timeline = stub('timeline');
  const ctx = {
    esc, agents: { atlas: { display: 'Atlas <b>' } }, scrollBottom() {}, fetch: fetchImpl || (async () => ({ ok: true, status: 200 })),
    Date, Map, Set, Promise, JSON, encodeURIComponent, String, Object, Number, Array, setInterval: () => 1, clearInterval() {},
    document: { createElement: stub, getElementById: () => timeline },
  };
  vm.createContext(ctx);
  vm.runInContext(cut('const APPROVAL_CLASS_LABELS', '    // ── Download cards'), ctx);
  ctx.timeline = timeline;
  return ctx;
}
const later = () => new Date(Date.now() + 60000).toISOString();
const block = () => ({ element: { querySelector: () => stub('body') } });

test('the page routes approval_request / approval_resolved to the handler before any member switch', () => {
  assert.match(html, /gw\.type === 'approval_request' \|\| gw\.type === 'approval_resolved'\)\) \{ handleApprovalEvent\(gw, member\); return; \}/);
});

test('an approval_request draws a card in the member card, newest first, all text escaped', () => {
  const ctx = approvalCtx();
  const b = block(); const body = b.element.querySelector('.agent-block-body');
  b.element = { querySelector: () => body };
  vm.runInContext('globalThis.go = handleApprovalEvent', ctx);
  ctx.go({ type: 'approval_request', id: 'a1', agent: 'atlas', cls: 'send', summary: '<img src=x onerror=alert(1)>', detail: { to: '<script>x</script>' }, expiresAt: later() }, b);
  ctx.go({ type: 'approval_request', id: 'a2', agent: 'atlas', cls: 'destroy', summary: 's2', expiresAt: later() }, b);
  assert.equal(body.children.length, 2);
  assert.equal(body.children[0].dataset.id, 'a2', 'newest first');
  const h = body.children[1].innerHTML;
  assert.match(h, /Atlas &lt;b&gt; wants to send off this machine/);
  assert.match(h, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(h, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.doesNotMatch(h, /<img|<script/);
  assert.match(body.children[0].innerHTML, /wants to take a destructive action/);
  assert.match(h, /expires in \d+m|expires in \d+s/);
});

test('Allow and Deny POST { decision } to /api/approvals/<id> and settle the card', async () => {
  const calls = [];
  const ctx = approvalCtx(async (u, o) => { calls.push([u, o]); return { ok: true, status: 200 }; });
  vm.runInContext('globalThis.go = handleApprovalEvent', ctx);
  ctx.go({ type: 'approval_request', id: 'x/1', agent: 'atlas', cls: 'admin', expiresAt: later() }, null);
  const card = ctx.timeline.children[0];
  await card.querySelector('.allow').onclick();
  assert.equal(calls[0][0], '/api/approvals/x%2F1');
  assert.equal(calls[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0][1].body), { decision: 'allow' });
  assert.equal(card.querySelector('.approval-note').textContent, 'Approved');
  assert.equal(card.querySelector('.allow').removed, true, 'the buttons go');
  ctx.go({ type: 'approval_request', id: 'b2', agent: 'atlas', cls: 'admin', expiresAt: later() }, null);
  await ctx.timeline.children[1].querySelector('.deny').onclick();
  assert.deepEqual(JSON.parse(calls[1][1].body), { decision: 'deny' });
  assert.equal(ctx.timeline.children[1].querySelector('.approval-note').textContent, 'Denied');
});

test('a 404 answer means someone else answered: the card says so and the buttons go; a failure keeps the buttons', async () => {
  let status = 404;
  const ctx = approvalCtx(async () => ({ ok: status < 400, status }));
  vm.runInContext('globalThis.go = handleApprovalEvent', ctx);
  ctx.go({ type: 'approval_request', id: 'n1', agent: 'atlas', cls: 'send', expiresAt: later() }, null);
  const c1 = ctx.timeline.children[0];
  await c1.querySelector('.allow').onclick();
  assert.equal(c1.querySelector('.approval-note').textContent, 'Already answered');
  assert.equal(c1.querySelector('.deny').removed, true);
  status = 500;
  ctx.go({ type: 'approval_request', id: 'n2', agent: 'atlas', cls: 'send', expiresAt: later() }, null);
  const c2 = ctx.timeline.children[1];
  await c2.querySelector('.deny').onclick();
  assert.match(c2.querySelector('.approval-note').textContent, /Could not send: HTTP 500/);
  assert.equal(c2.querySelector('.deny').removed, false);
  assert.equal(c2.querySelector('.deny').disabled, false, 'it can be tried again');
});

test('approval_resolved settles the card with how it was decided; the buttons go', () => {
  const ctx = approvalCtx();
  vm.runInContext('globalThis.go = handleApprovalEvent', ctx);
  ctx.go({ type: 'approval_request', id: 'r1', agent: 'atlas', cls: 'send', expiresAt: later() }, null);
  ctx.go({ type: 'approval_resolved', id: 'r1', decision: 'deny', by: 'timeout' }, null);
  const c = ctx.timeline.children[0];
  assert.equal(c.querySelector('.approval-note').textContent, 'Timed out: not done');
  assert.equal(c.querySelector('.allow').removed, true);
  ctx.go({ type: 'approval_request', id: 'r2', agent: 'atlas', cls: 'send', expiresAt: later() }, null);
  ctx.go({ type: 'approval_resolved', id: 'r2', decision: 'allow', by: 'owner' }, null);
  assert.equal(ctx.timeline.children[1].querySelector('.approval-note').textContent, 'Approved');
});

test('replay: a request whose resolution came first, or already expired, offers no buttons', () => {
  const ctx = approvalCtx();
  vm.runInContext('globalThis.go = handleApprovalEvent', ctx);
  ctx.go({ type: 'approval_resolved', id: 'done1', decision: 'allow', by: 'owner' }, null);
  ctx.go({ type: 'approval_request', id: 'done1', agent: 'atlas', cls: 'send', expiresAt: later() }, null);
  assert.equal(ctx.timeline.children.length, 0, 'a resolved id is never drawn again');
  ctx.go({ type: 'approval_request', id: 'old1', agent: 'atlas', cls: 'send', expiresAt: new Date(Date.now() - 5000).toISOString() }, null);
  const c = ctx.timeline.children[0];
  assert.equal(c.querySelector('.allow').removed, true, 'an expired request has no buttons');
  assert.equal(c.querySelector('.approval-note').textContent, 'Timed out: not done');
  ctx.go({ type: 'approval_request', id: 'dup', agent: 'atlas', cls: 'send', expiresAt: later() }, null);
  ctx.go({ type: 'approval_request', id: 'dup', agent: 'atlas', cls: 'send', expiresAt: later() }, null);
  assert.equal(ctx.timeline.children.length, 2, 'the same request twice draws one card');
});

// ── P2. Download cards ──
function cardsCtx(H, fetchImpl) {
  const textEl = stub('text'); textEl.nextElementSibling = null; textEl.after = (n) => { textEl.boxAfter = n; };
  const ctx = { esc, window: { hubFileCard: H }, fetch: fetchImpl || (async () => ({})), String, document: { createElement: stub } };
  vm.createContext(ctx);
  vm.runInContext(cut('async function attachFileCards', '    function handleEvent'), ctx);
  return { ctx, textEl };
}

test('the page loads /ui-file-card.js before its own script', () => {
  const a = html.indexOf('<script src="/ui-file-card.js"></script>');
  assert.ok(a > 0);
  assert.ok(a < html.indexOf('window.dialogGuard'), 'before the page script');
});

test('finishCallBlock and closeBlock both call attachFileCards with the card', () => {
  assert.match(cut('function finishCallBlock', 'function markUnfinishedTools'), /attachFileCards\(block\)/);
  assert.match(cut('function closeBlock', 'function addTool'), /attachFileCards\(currentBlock\)/);
});

test('attachFileCards: candidatesFrom gets the card text and the member agent; cards go in a .file-cards box after the text', async () => {
  let seen = null; let fetched = 0;
  const H = {
    candidatesFrom: (root, o) => { seen = [root, o]; return [{ key: 'k', item: { abs: '/x/a.pdf' } }]; },
    resolveBatch: async (f, items) => { await f('/probe'); return items.map(() => ({ ok: true, name: 'a.pdf' })); },
    cardHtml: (r, o) => `<div class="file-card">${o.esc(r.name)}</div>`,
  };
  const { ctx, textEl } = cardsCtx(H, async () => { fetched++; return {}; });
  await ctx.attachFileCards({ textEl, slug: 'atlas' });
  assert.equal(seen[0], textEl);
  assert.equal(seen[1].agent, 'atlas');
  assert.equal(fetched, 1);
  assert.equal(textEl.boxAfter.className, 'file-cards');
  assert.match(textEl.boxAfter.innerHTML, /file-card">a\.pdf/);
});

test('attachFileCards: no candidates means no request; a throwing helper never reaches the page', async () => {
  let fetched = 0; let resolved = 0;
  const H = { candidatesFrom: () => [], resolveBatch: async () => { resolved++; return []; }, cardHtml: () => '' };
  const a = cardsCtx(H, async () => { fetched++; return {}; });
  await a.ctx.attachFileCards({ textEl: a.textEl, slug: 'atlas' });
  assert.equal(resolved, 0); assert.equal(fetched, 0); assert.equal(a.textEl.boxAfter, undefined);
  const bad = cardsCtx({ candidatesFrom: () => { throw new Error('boom'); } });
  await assert.doesNotReject(() => bad.ctx.attachFileCards({ textEl: bad.textEl, slug: 'atlas' }));
  const none = cardsCtx(undefined);
  await assert.doesNotReject(() => none.ctx.attachFileCards({ textEl: none.textEl, slug: 'atlas' }));
  await assert.doesNotReject(() => none.ctx.attachFileCards(null));
});
