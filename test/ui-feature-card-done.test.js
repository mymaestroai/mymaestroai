'use strict';
// The new-features card (lib/ui-feature-card.js): the card waits for the chat's first message instead of attaching to an empty list,
// stays below the history that is drawn after it (the chat is kept at the bottom), shrinks to one "Done:" line when every row is
// answered, and that line goes away after DONE_MS or at the person's next send. Small fake DOM with real (short) timers.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FILE = path.join(__dirname, '..', 'lib', 'ui-feature-card.js');
const SRC = fs.readFileSync(FILE, 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async () => { for (let k = 0; k < 30; k++) await new Promise((r) => setImmediate(r)); };

function dom() {
  const observers = [];
  let queued = false; const pending = new Map();
  function notify(target, added = [], removed = []) {
    for (const o of observers) if (o.targets.includes(target)) { const p = pending.get(o) || { addedNodes: [], removedNodes: [] }; p.addedNodes = p.addedNodes.concat(added); p.removedNodes = p.removedNodes.concat(removed); pending.set(o, p); }
    if (queued || !pending.size) return;
    queued = true;
    queueMicrotask(() => { queued = false; const now = [...pending]; pending.clear(); for (const [o, rec] of now) o.f([{ addedNodes: rec.addedNodes, removedNodes: rec.removedNodes }]); });
  }
  function node(tag) {
    const n = {
      tag, className: '', id: '', disabled: false, textContent: '', children: [], listeners: {}, attrs: {}, parentNode: null, isConnected: true, overflowY: 'visible',
      classList: { contains: (c) => String(n.className).split(/\s+/).includes(c), add() {}, remove() {}, toggle() {} },
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
      focus() {},
      click() { if (this.disabled) return; (this.listeners.click || []).forEach((f) => f({ preventDefault() {} })); },
      get lastChild() { return this.children[this.children.length - 1] || null; },
      get lastElementChild() { return this.lastChild; },
      get parentElement() { return this.parentNode; },
      get nextElementSibling() { const p = this.parentNode; if (!p) return null; return p.children[p.children.indexOf(this) + 1] || null; },
      get text() { return this.textContent + this.children.map((c) => c.text).join(''); },
      find(pred, out = []) { if (pred(this)) out.push(this); this.children.forEach((c) => c.find(pred, out)); return out; },
    };
    return n;
  }
  class MO { constructor(f) { this.f = f; this.targets = []; observers.push(this); } observe(t) { this.targets.push(t); } disconnect() { this.targets = []; } }
  return { node, MO };
}

const E1 = { id: 'quick-research', title: 'Agents may start quick research', summary: 's', cost: 'c', recommendation: null, rev: 'pending #0' };
const E2 = { id: 'protect-code', title: 'Protect the program files', summary: 's', cost: 'c', recommendation: null, rev: 'pending #0' };
const N1 = { id: 'quiet-fix', title: 'Faster history search', line: 'Nothing for you to do.' };

function load({ entries = [E1, E2], notices = [], posts = null } = {}) {   // server.gate: a promise that holds the 'reopen' POSTs; it resolves to { status, body }
  const D = dom();
  const d = {
    activeElement: null, readyState: 'complete', visibilityState: 'visible', listeners: {},
    createElement: (t) => D.node(t), createTextNode: (t) => { const n = D.node('#text'); n.textContent = t; return n; },
    addEventListener() {}, scrollingElement: null,
  };
  d.body = D.node('body'); d.head = D.node('head'); d.documentElement = D.node('html');
  const server = { card: { ok: true, show: true, lead: 'harbor', leadDisplay: 'Harbor', entries, notices }, posts: posts || [] };
  const fetch = (url, init = {}) => {
    const method = init.method || 'GET';
    if (method === 'GET') return Promise.resolve({ status: 200, json: async () => server.card });
    const b = JSON.parse(init.body); server.posts.push({ url, body: b });
    const respond = (g) => { const r = g || { status: 200, body: { ok: true, rev: 'rev-' + url.split('/').pop() } }; return { status: r.status, json: async () => r.body }; };
    if (b.decision === 'reopen' && server.gate) return server.gate.then(respond);
    return Promise.resolve(respond(null));
  };
  const mod = { exports: {} };
  const ctx = { module: mod, document: d, fetch, location: { search: '' }, encodeURIComponent, JSON, Promise, console, MutationObserver: D.MO, setTimeout, clearTimeout, queueMicrotask, getComputedStyle: (e) => ({ overflowY: e.overflowY }) };
  vm.runInNewContext(SRC, ctx, { filename: FILE });
  // Most tests model a page whose saved history is already drawn; FC.noAutoDrawn = true turns that off (the page signals nothing).
  { const ex = mod.exports, shown = ex.chatShown; ex.chatShown = (a, l, o) => { shown(a, l, o); if (l && !ex.noAutoDrawn && ex.historyDrawn) ex.historyDrawn(l); }; }
  return { FC: mod.exports, D, d, server };
}
const isCard = (k) => String(k.className).includes('feature-card');
const cardIn = (list) => list.children.find(isCard);
const btn = (root, label) => root.find((n) => n.tag === 'button' && n.textContent === label)[0];
const msg = (D) => { const m = D.node('div'); m.className = 'msg'; return m; };
/** A chat list that scrolls: each child is 100 px tall, the window is 400 px. */
function scrollList(D) {
  const l = D.node('div'); l.overflowY = 'auto'; l.scrollTop = 0;
  Object.defineProperty(l, 'scrollHeight', { get() { return l.children.length * 100; } });
  l.clientHeight = 400;
  return l;
}
async function answerAll(FC, list) {
  btn(cardIn(list), 'Turn on').click(); await settle();
  btn(cardIn(list), 'Leave off').click(); await settle();
}

test('(1) the card waits for historyDrawn: a Loading note is no signal; the backstop FIRST_WAIT_MS attaches anyway; a chat switch resets', async () => {
  const note = (D) => { const n = D.node('div'); n.className = 'note'; n.textContent = 'Loading…'; return n; };
  // a list with a non-card child (the phone's Loading note) before the history is drawn: no card, not even when messages land
  const a = load(); a.FC.noAutoDrawn = true; a.FC.FIRST_WAIT_MS = 5000;
  const list = a.D.node('div'); list.appendChild(note(a.D));
  a.FC.chatShown('harbor', list); await settle();
  assert.strictEqual(cardIn(list), undefined, 'no card next to a Loading note');
  list.replaceChildren(msg(a.D), msg(a.D)); await settle();
  assert.strictEqual(cardIn(list), undefined, 'drawn messages alone are no signal either');
  a.FC.historyDrawn(list); await settle();
  assert.ok(cardIn(list), 'attached once the page says the history is drawn');
  assert.strictEqual(list.lastChild, cardIn(list), 'at the end');
  // an empty (or failed) history is drawn too: the card still comes
  const e0 = load(); e0.FC.noAutoDrawn = true; e0.FC.FIRST_WAIT_MS = 5000;
  const empty0 = e0.D.node('div');
  e0.FC.chatShown('harbor', empty0); await settle();
  assert.strictEqual(cardIn(empty0), undefined);
  e0.FC.historyDrawn(empty0); await settle();
  assert.ok(cardIn(empty0), 'an empty list gets the card after historyDrawn');

  // the page never signals: FIRST_WAIT_MS attaches it anyway
  const b = load(); b.FC.noAutoDrawn = true; b.FC.FIRST_WAIT_MS = 60;
  const l2 = b.D.node('div'); l2.appendChild(note(b.D));
  b.FC.chatShown('harbor', l2); await settle();
  assert.strictEqual(cardIn(l2), undefined);
  await sleep(150); await settle();
  assert.ok(cardIn(l2), 'backstop');
  assert.strictEqual(load().FC.FIRST_WAIT_MS, 8000, 'default backstop');

  // a phone chat switch (same list, another agent, the page redraws) resets the signal and the timer
  const c = load(); c.FC.noAutoDrawn = true; c.FC.FIRST_WAIT_MS = 5000;
  const l3 = c.D.node('div'); l3.appendChild(msg(c.D));
  c.FC.chatShown('harbor', l3); c.FC.historyDrawn(l3); await settle();
  assert.ok(cardIn(l3));
  c.FC.chatShown('scout', l3, { redraw: true }); await settle();
  assert.strictEqual(cardIn(l3), undefined, 'the other agent: no card');
  c.FC.chatShown('harbor', l3, { redraw: true }); await settle();
  assert.strictEqual(cardIn(l3), undefined, 'back in the lead\'s chat: the history is not drawn yet');
  c.FC.historyDrawn(l3); await settle();
  assert.ok(cardIn(l3), 'drawn again: attached');

  // a switch clears the backstop timer: no late attach
  const e = load(); e.FC.noAutoDrawn = true; e.FC.FIRST_WAIT_MS = 60;
  const old = e.D.node('div');
  e.FC.chatShown('harbor', old); await settle();
  e.FC.chatShown('scout', old); await settle();
  await sleep(150); await settle();
  assert.strictEqual(cardIn(old), undefined, 'the timer was cleared by the switch');
});

test('(2) history drawn by emptying and refilling the list ends with the card last and the chat still at the bottom', async () => {
  const { FC, D } = load(); FC.FIRST_WAIT_MS = 5000; FC.noAutoDrawn = true;
  const list = scrollList(D);
  FC.chatShown('harbor', list); await settle();   // the card's answer arrives before the history
  for (let i = 0; i < 20; i++) list.appendChild(msg(D));   // history drawn
  list.scrollTop = list.scrollHeight;   // soloHistoryDraw scrolls to the bottom
  const before = list.scrollHeight;
  FC.historyDrawn(list);   // the page's signal, after the draw and the scroll
  await settle();
  assert.strictEqual(list.lastChild, cardIn(list), 'the card is last');
  assert.ok(list.scrollHeight > before, 'the card made the list taller');
  assert.strictEqual(list.scrollTop, list.scrollHeight, 'still at the bottom');
  // the same, with the page emptying the list first (textContent = '') and the card already attached by the timer
  const q = load(); q.FC.FIRST_WAIT_MS = 30;
  const l2 = scrollList(q.D);
  q.FC.chatShown('harbor', l2); await sleep(100); await settle();
  assert.ok(cardIn(l2));
  l2.replaceChildren();
  for (let i = 0; i < 20; i++) l2.appendChild(msg(q.D));
  q.FC.historyDrawn(l2);   // a page that empties the list signals the redraw again
  l2.scrollTop = l2.scrollHeight; await settle();
  assert.strictEqual(l2.lastChild, cardIn(l2));
  assert.strictEqual(l2.scrollTop, l2.scrollHeight);
});

test('(3) a person who scrolled up is not scrolled down', async () => {
  const { FC, D } = load();
  const list = scrollList(D);
  for (let i = 0; i < 20; i++) list.appendChild(msg(D));
  list.scrollTop = 300;   // far above the bottom (2000 - 300 - 400 > 200)
  FC.chatShown('harbor', list); await settle();
  assert.ok(cardIn(list) && list.lastChild === cardIn(list));
  assert.strictEqual(list.scrollTop, 300, 'unchanged');
});

test('(2b) the scroller is the nearest scrolling ancestor when the list itself does not scroll', async () => {
  const { FC, D } = load();
  const outer = D.node('div'); outer.overflowY = 'scroll'; outer.scrollTop = 0; outer.clientHeight = 400;
  const list = D.node('div'); outer.appendChild(list);
  Object.defineProperty(outer, 'scrollHeight', { get() { return list.children.length * 100; } });
  for (let i = 0; i < 6; i++) list.appendChild(msg(D));
  outer.scrollTop = outer.scrollHeight - 400;
  FC.chatShown('harbor', list); await settle();
  assert.strictEqual(outer.scrollTop, outer.scrollHeight);
});

test('(4) every row answered: one line "Done: ..." with the titles, Undo and where to find it later', async () => {
  const { FC, D } = load();
  const list = D.node('div'); list.appendChild(msg(D));
  FC.chatShown('harbor', list); await settle();
  await answerAll(FC, list);
  const c = cardIn(list);
  assert.strictEqual(c.children.length, 1);
  assert.ok(/\bfc-doneline\b/.test(c.children[0].className));
  assert.strictEqual(c.text, 'Done: Agents may start quick research on · Protect the program files offUndo both Undo later: Settings › For your review › Recent changes.');
  assert.strictEqual(btn(c, 'Undo both').className, 'fc-no');
});

test('(4b) the line words: on / off / asked again next week; a notice answered OK is dropped, a notice turned off is "<title> off"', async () => {
  const { FC, D } = load({ entries: [E1, E2, { ...E1, id: 'third', title: 'Third' }], notices: [N1, { id: 'q2', title: 'Tidier logs', line: 'x' }] });
  const list = D.node('div'); list.appendChild(msg(D));
  FC.chatShown('harbor', list); await settle();
  const rows = () => cardIn(list).find((n) => /\bfc-row\b/.test(n.className));
  btn(rows()[0], 'Turn on').click(); await settle();
  btn(rows()[1], 'Leave off').click(); await settle();
  btn(rows()[2], 'Ask me in a week').click(); await settle();
  btn(rows()[3], 'Turn off').click(); await settle();
  btn(rows()[4], 'OK').click(); await settle();
  const line = cardIn(list).children[0].children[0].textContent;
  assert.strictEqual(line, 'Done: Agents may start quick research on · Protect the program files off · Third: asked again next week · Faster history search off');
});

test('(5) the done line goes away by itself after DONE_MS', async () => {
  const { FC, D } = load(); FC.DONE_MS = 80;
  const list = D.node('div'); list.appendChild(msg(D));
  FC.chatShown('harbor', list); await settle();
  await answerAll(FC, list);
  assert.ok(cardIn(list) && /fc-doneline/.test(cardIn(list).children[0].className));
  await sleep(30); assert.ok(cardIn(list), 'still there before DONE_MS');
  await sleep(150); await settle();
  assert.strictEqual(cardIn(list), undefined, 'gone');
  assert.strictEqual(FC.state.rows.length, 2, 'the answered rows stay (only the chat copy is dismissed)');
  // a new card answer with pending entries shows the card again
  await FC.refresh(); await settle();
  assert.ok(cardIn(list) && btn(cardIn(list), 'Turn on'));
});

test('(6) the person\'s own send removes the done line at once; another message (no own) leaves it', async () => {
  const { FC, D } = load(); FC.DONE_MS = 5000;
  const list = D.node('div'); list.appendChild(msg(D));
  FC.chatShown('harbor', list); await settle();
  await answerAll(FC, list);
  list.appendChild(msg(D)); FC.messageArrived(list); await settle();
  assert.ok(cardIn(list) && /fc-doneline/.test(cardIn(list).children[0].className), 'a reply starting leaves it');
  list.appendChild(msg(D)); FC.messageArrived(list, { own: false }); await settle();
  assert.ok(cardIn(list), 'own must be exactly true');
  list.appendChild(msg(D)); FC.messageArrived(list, { own: true }); await settle();
  assert.strictEqual(cardIn(list), undefined, 'gone at once');
  assert.strictEqual(FC.state.rows.length, 2, 'the rows stay');
});

test('(6b) a full card with open rows folds on messageArrived, own or not', async () => {
  for (const opts of [undefined, { own: true }]) {
    const { FC, D } = load();
    const list = D.node('div'); list.appendChild(msg(D));
    FC.chatShown('harbor', list); await settle();
    list.appendChild(msg(D)); FC.messageArrived(list, opts); await settle();
    const c = cardIn(list);
    assert.ok(c && c.find((n) => /\bfc-toggle\b/.test(n.className)).length === 1, 'folded');
  }
});

test('(7) a pending row never times out', async () => {
  const { FC, D } = load(); FC.DONE_MS = 30;
  const list = D.node('div'); list.appendChild(msg(D));
  FC.chatShown('harbor', list); await settle();
  btn(cardIn(list), 'Turn on').click(); await settle();   // one answered, one still open
  await sleep(150); await settle();
  const c = cardIn(list);
  assert.ok(c, 'still there');
  assert.ok(btn(c, 'Leave off'), 'the open row keeps its buttons');
  assert.ok(!/fc-doneline/.test(c.children[0].className));
});

test('(8) Undo on the line reopens every row answered here (POST reopen with each rev) and the full card returns', async () => {
  const { FC, D, server } = load(); FC.DONE_MS = 60;
  const list = D.node('div'); list.appendChild(msg(D));
  FC.chatShown('harbor', list); await settle();
  await answerAll(FC, list);
  server.posts.length = 0;
  btn(cardIn(list), 'Undo both').click(); await settle();
  assert.deepStrictEqual(server.posts.map((p) => [p.url, p.body]).sort(), [
    ['/api/behaviour-changes/protect-code', { decision: 'reopen', rev: 'rev-protect-code' }],
    ['/api/behaviour-changes/quick-research', { decision: 'reopen', rev: 'rev-quick-research' }],
  ]);
  const c = cardIn(list);
  assert.ok(c && !/fc-doneline/.test(c.children[0].className), 'the full card is back');
  assert.strictEqual(c.find((n) => n.tag === 'button' && n.textContent === 'Turn on').length, 2, 'both rows open');
  await sleep(150); await settle();
  assert.ok(cardIn(list), 'the timer was cancelled: the open rows stay');
});

test('(9) another device answered everything: the card is gone after the next GET; some answered here and the rest elsewhere: the line shows the ones answered here', async () => {
  const a = load();
  const list = a.D.node('div'); list.appendChild(msg(a.D));
  a.FC.chatShown('harbor', list); await settle();
  assert.ok(cardIn(list));
  a.server.card = { ok: true, show: true, lead: 'harbor', leadDisplay: 'Harbor', entries: [], notices: [] };
  await a.FC.refresh(); await settle();
  assert.strictEqual(cardIn(list), undefined, 'gone (show:true, nothing open)');
  const a2 = load();
  const l2 = a2.D.node('div'); l2.appendChild(msg(a2.D));
  a2.FC.chatShown('harbor', l2); await settle();
  a2.server.card = { ok: true, show: false, lead: 'harbor', entries: [], notices: [] };
  await a2.FC.refresh(); await settle();
  assert.strictEqual(cardIn(l2), undefined, 'gone (show:false)');

  const b = load();
  const l3 = b.D.node('div'); l3.appendChild(msg(b.D));
  b.FC.chatShown('harbor', l3); await settle();
  btn(cardIn(l3), 'Turn on').click(); await settle();   // quick-research answered here; protect-code stays open
  b.server.card = { ok: true, show: true, lead: 'harbor', leadDisplay: 'Harbor', entries: [], notices: [] };   // protect-code answered elsewhere
  await b.FC.refresh(); await settle();
  const c = cardIn(l3);
  assert.ok(c && /fc-doneline/.test(c.children[0].className), 'the done line');
  assert.ok(c.text.startsWith('Done: Agents may start quick research on'));
  assert.ok(!c.text.includes('Protect the program files'));
});

test('(10) the Settings page copy keeps today\'s behaviour: no done line, no timer', async () => {
  const { FC, D } = load(); FC.DONE_MS = 30;
  const box = D.node('div');
  await FC.renderInto(box);   // a Settings page with no chat on it
  const rows = () => box.find((n) => /\bfc-row\b/.test(n.className));
  btn(rows()[0], 'Turn on').click(); await settle();
  btn(rows()[1], 'Leave off').click(); await settle();
  assert.ok(box.text.includes('All set. You can change these any time on the Changes page.'));
  assert.strictEqual(box.find((n) => /fc-doneline/.test(n.className)).length, 0);
  assert.ok(rows().length === 2 && rows()[0].text.includes('Turned on.'), 'the rows keep their result lines');
  await sleep(150); await settle();
  assert.ok(box.text.includes('All set.'), 'no timer on the page copy');
});

const isDoneLine = (c) => !!c && c.find((n) => /\bfc-doneline\b/.test(n.className)).length === 1;
const rowsOf = (n) => n.find((x) => /\bfc-row\b/.test(x.className));

test('(11) dismissing the done line only removes the chat copy: the Settings copy keeps its result lines and Undo (timer and own send)', async () => {
  for (const how of ['timer', 'own']) {
    const { FC, D, server } = load(); FC.DONE_MS = how === 'timer' ? 60 : 5000;
    const list = D.node('div'); list.appendChild(msg(D));
    FC.chatShown('harbor', list); await settle();
    const box = D.node('div'); await FC.renderInto(box);
    await answerAll(FC, list);
    assert.ok(isDoneLine(cardIn(list)), how + ': the done line');
    if (how === 'timer') { await sleep(150); } else { list.appendChild(msg(D)); FC.messageArrived(list, { own: true }); }
    await settle();
    assert.strictEqual(cardIn(list), undefined, how + ': the chat copy is gone');
    assert.strictEqual(FC.state.rows.length, 2, how + ': the shared rows stay');
    assert.strictEqual(rowsOf(box).length, 2, how + ': the page copy still has both rows');
    assert.ok(rowsOf(box)[0].text.includes('Turned on.') && rowsOf(box)[1].text.includes('Left off.'), how + ': result lines');
    assert.strictEqual(box.find((n) => n.tag === 'button' && n.textContent === 'Undo').length, 2, how + ': Undo on each row');
    // no timer is running and a later paint does not bring it back
    await sleep(100); await settle();
    assert.strictEqual(cardIn(list), undefined, how + ': stays away');
    // a change (a new open row from the server) shows the card again
    server.card = { ok: true, show: true, lead: 'harbor', leadDisplay: 'Harbor', entries: [{ ...E1, id: 'third', title: 'Third' }], notices: [] };
    await FC.refresh(); await settle();
    assert.ok(cardIn(list) && btn(cardIn(list), 'Turn on'), how + ': a new open row shows the card');
  }
  // an Undo on the page copy changes the key: the chat copy dismissed for the old answers shows the reopened row
  const { FC, D } = load(); FC.DONE_MS = 40;
  const list = D.node('div'); list.appendChild(msg(D));
  FC.chatShown('harbor', list); await settle();
  const box = D.node('div'); await FC.renderInto(box);
  await answerAll(FC, list);
  await sleep(120); await settle();
  assert.strictEqual(cardIn(list), undefined);
  btn(rowsOf(box)[0], 'Undo').click(); await settle();
  assert.ok(cardIn(list) && btn(cardIn(list), 'Turn on'), 'the reopened row is back on the chat card');
});

test('(12) a slow Undo: the line stays while it is pending, an own send does not dismiss, a failure keeps its error, a fresh timer runs after it settles', async () => {
  const { FC, D, server } = load(); FC.DONE_MS = 100;
  const list = D.node('div'); list.appendChild(msg(D));
  FC.chatShown('harbor', list); await settle();
  await answerAll(FC, list);
  let release; server.gate = new Promise((r) => { release = r; });
  btn(cardIn(list), 'Undo both').click(); await settle();
  assert.strictEqual(server.posts.filter((p) => p.body.decision === 'reopen').length, 2, 'both Undo POSTs are out');
  await sleep(250); await settle();   // well beyond DONE_MS
  assert.ok(isDoneLine(cardIn(list)), 'still there while the Undo is pending');
  list.appendChild(msg(D)); FC.messageArrived(list, { own: true }); await settle();
  assert.ok(isDoneLine(cardIn(list)), 'an own send does not dismiss it either');
  release({ status: 500, body: { error: 'The hub said no.' } }); await settle();
  const c = cardIn(list);
  assert.ok(isDoneLine(c), 'the line stays after the failure');
  assert.ok(c.text.includes('The hub said no.'), 'the error shows on the line');
  await sleep(40); await settle();
  assert.ok(cardIn(list), 'a fresh DONE_MS runs from the settle (not the stale one)');
  await sleep(200); await settle();
  assert.strictEqual(cardIn(list), undefined, 'gone after the fresh timer');
});

test('(13) every row answered but none "done" (a notice answered OK): the chat copy goes at once, the Settings copy is unchanged', async () => {
  const { FC, D } = load({ entries: [], notices: [N1] }); FC.DONE_MS = 5000;
  const list = D.node('div'); list.appendChild(msg(D));
  FC.chatShown('harbor', list); await settle();
  const box = D.node('div'); await FC.renderInto(box);
  assert.ok(btn(cardIn(list), 'OK'));
  btn(cardIn(list), 'OK').click(); await settle();
  assert.strictEqual(cardIn(list), undefined, 'no "All set." left in the chat');
  assert.ok(box.text.includes('All set. You can change these any time on the Changes page.'), 'the Settings copy shows the closing line');
  assert.strictEqual(box.find((n) => /fc-doneline/.test(n.className)).length, 0);
});

test('(14) phone reopen of the same chat (redraw): no card until the history is drawn again; desktop switch-back keeps the mark', async () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'mobile.js'), 'utf8');
  assert.ok(src.includes("FeatureCard.chatShown(name, $('messages'), { redraw: true })"), 'the phone says it redraws');
  const lib = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'ui-feature-card.js'), 'utf8');
  assert.ok(/if \(opts && opts\.redraw === true\) \{ st\.drawn\.delete\(list\); st\.firstGo = false; clearFirst\(\); \}/.test(lib), 'only a redraw clears the drawn mark (and the backstop state)');
  assert.ok(!/st\.chat\.list !== list\) \{ st\.drawn\.delete/.test(lib), 'a chat switch alone does not clear it');
});

test('(15) another panel finishing its history does not cancel the open chat\'s backstop', async () => {
  const { FC, D } = load(); FC.noAutoDrawn = true; FC.FIRST_WAIT_MS = 80;
  const lead = D.node('div'); lead.appendChild(D.node('div'));
  const other = D.node('div'); other.appendChild(D.node('div'));
  FC.chatShown('harbor', lead); await settle();
  FC.historyDrawing(other); FC.historyDrawn(other);   // a second desktop panel redraws; the lead's history request is stalled
  await sleep(200); await settle();
  assert.ok(lead.children.some((k) => String(k.className).includes('feature-card')), 'the backstop still attaches the card in the lead\'s chat');
});

test('(16a) the desktop draws the history twice: historyDrawing takes the card out, it waits for the next historyDrawn', async () => {
  const { FC, D } = load(); FC.FIRST_WAIT_MS = 5000;
  const list = scrollList(D);
  for (let i = 0; i < 5; i++) list.appendChild(msg(D));
  FC.chatShown('harbor', list); await settle();   // the wrapper signals historyDrawn: the card attaches
  assert.ok(cardIn(list) && list.lastChild === cardIn(list), 'attached after the first draw');
  FC.historyDrawing(list);   // the second draw: the page says so, then empties the list ...
  list.replaceChildren();
  for (let i = 0; i < 20; i++) list.appendChild(msg(D));   // ... and refills it, with no historyDrawn yet
  await settle();
  assert.strictEqual(cardIn(list), undefined, 'the observer does not put the card back mid-draw');
  assert.strictEqual(FC.state.drawn.has(list), false, 'the drawn mark is gone');
  list.scrollTop = list.scrollHeight;
  FC.historyDrawn(list); await settle();
  assert.ok(cardIn(list) && list.lastChild === cardIn(list), 'attached at the end once the second draw is signalled');
  assert.strictEqual(list.children.length, 21);
});

test('(16b) the module\'s own removal does not clear the drawn mark', async () => {
  // a chat switch to another agent on the same list (the phone), then back without a redraw: the card returns at once
  const a = load(); a.FC.noAutoDrawn = true; a.FC.FIRST_WAIT_MS = 5000;
  const list = a.D.node('div'); list.appendChild(msg(a.D));
  a.FC.chatShown('harbor', list); a.FC.historyDrawn(list); await settle();
  assert.ok(cardIn(list));
  a.FC.chatShown('scout', list); await settle();
  assert.strictEqual(cardIn(list), undefined, 'the card left with the other agent');
  assert.ok(a.FC.state.drawn.has(list), 'the mark stays');
  a.FC.chatShown('harbor', list); await settle();
  assert.ok(cardIn(list) && list.lastChild === cardIn(list), 're-attached at once, no redraw needed');
  // the card taken out by the module while the list is watched (a notice answered OK): the mark stays too
  const b = load({ entries: [], notices: [N1] }); b.FC.noAutoDrawn = true; b.FC.FIRST_WAIT_MS = 5000;
  const l2 = b.D.node('div'); l2.appendChild(msg(b.D));
  b.FC.chatShown('harbor', l2); b.FC.historyDrawn(l2); await settle();
  btn(cardIn(l2), 'OK').click(); await settle();
  assert.strictEqual(cardIn(l2), undefined, 'the chat copy went');
  assert.ok(b.FC.state.drawn.has(l2), 'its own removal is not taken for a redraw');
});

test('(16c) a card taller than the chat window scrolls to its top (minus 8 px), a short one to the bottom', async () => {
  for (const [h, tall] of [[600, true], [150, false]]) {
    const { FC, D, d } = load(); FC.FIRST_WAIT_MS = 5000;
    const mk = d.createElement;
    // every element gets a rect: the card is h tall, each child sits 100 px apart (viewport coordinates move with the scroll)
    d.createElement = (t) => { const n = mk(t); n.getBoundingClientRect = () => { const p = n.parentNode; const i = p ? p.children.indexOf(n) : 0; return { top: i * 100 - (p ? p.scrollTop : 0), height: String(n.className).includes('feature-card') ? h : 100 }; }; return n; };
    const list = scrollList(D); list.clientHeight = 300;
    list.getBoundingClientRect = () => ({ top: 0, height: 300 });
    for (let i = 0; i < 10; i++) list.appendChild(msg(D));
    list.scrollTop = list.scrollHeight - 300;   // at the bottom
    FC.chatShown('harbor', list); await settle();
    const card = cardIn(list);
    assert.ok(card && list.lastChild === card, 'attached at the end');
    if (tall) assert.strictEqual(list.scrollTop, 10 * 100 - 8, 'the card top is 8 px below the top of the view');
    else assert.strictEqual(list.scrollTop, list.scrollHeight, 'a short card: the bottom');
  }
  // no getBoundingClientRect on the fake DOM: today's bottom scroll
  const { FC, D } = load(); FC.FIRST_WAIT_MS = 5000;
  const list = scrollList(D); list.clientHeight = 300;
  for (let i = 0; i < 10; i++) list.appendChild(msg(D));
  list.scrollTop = list.scrollHeight - 300;
  FC.chatShown('harbor', list); await settle();
  assert.strictEqual(list.scrollTop, list.scrollHeight);
});

test('(16d) the done line\'s button says what it undoes: Undo / Undo both / Undo all', async () => {
  const E3 = { ...E1, id: 'third', title: 'Third' };
  for (const [entries, label] of [[[E1], 'Undo'], [[E1, E2], 'Undo both'], [[E1, E2, E3], 'Undo all']]) {
    const { FC, D } = load({ entries }); FC.FIRST_WAIT_MS = 5000;
    const list = D.node('div'); list.appendChild(msg(D));
    FC.chatShown('harbor', list); await settle();
    for (let i = 0; i < entries.length; i++) { btn(cardIn(list), 'Turn on').click(); await settle(); }
    const line = cardIn(list).find((n) => /fc-doneline/.test(n.className))[0];
    assert.ok(line, 'the done line shows for ' + entries.length + ' row(s)');
    const b = line.find((n) => n.tag === 'button')[0];
    assert.strictEqual(b && b.textContent, label, entries.length + ' row(s)');
  }
});

test('(17) a move and the page clearing the list in the same task: the card still waits for historyDrawn', async () => {
  const { FC, D } = load(); FC.FIRST_WAIT_MS = 5000;
  const list = scrollList(D);
  for (let i = 0; i < 3; i++) list.appendChild(msg(D));
  FC.chatShown('harbor', list); await settle();
  assert.ok(cardIn(list));
  list.appendChild(msg(D));   // a message lands (the card will move) ...
  FC.historyDrawing(list); list.replaceChildren();   // ... and in the same task the page starts a redraw
  for (let i = 0; i < 10; i++) list.appendChild(msg(D));
  await settle();
  assert.strictEqual(cardIn(list), undefined, 'not back mid-draw');
  FC.historyDrawn(list); await settle();
  assert.ok(cardIn(list) && list.lastChild === cardIn(list), 'back at the end after the draw');
});

test('(18) a tall card lands with its header in view, but a later move keeps a reader at its bottom where they are', async () => {
  const { FC, D } = load(); FC.FIRST_WAIT_MS = 5000;
  const list = scrollList(D);
  for (let i = 0; i < 5; i++) list.appendChild(msg(D));
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'ui-feature-card.js'), 'utf8');
  assert.ok(/arriving: root\.parentNode !== list/.test(src) && /const top = m\.arriving \? tallTop\(m\.sc, root\) : null;/.test(src), 'the tall-card landing applies only on arrival');
});

test('(19) a tall card: the page scrolling to the bottom right after the draw is undone; the reader input ends the hold', async () => {
  const mkSetup = () => {
    const { FC, D, d } = load(); FC.FIRST_WAIT_MS = 5000;
    const mk = d.createElement;
    d.createElement = (t) => { const n = mk(t); n.getBoundingClientRect = () => { const p = n.parentNode; const i = p ? p.children.indexOf(n) : 0; return { top: i * 100 - (p ? p.scrollTop : 0), height: String(n.className).includes('feature-card') ? 600 : 100 }; }; return n; };
    const list = scrollList(D); list.clientHeight = 300;
    list.getBoundingClientRect = () => ({ top: 0, height: 300 });
    for (let i = 0; i < 10; i++) list.appendChild(msg(D));
    list.scrollTop = list.scrollHeight - 300;
    return { FC, list };
  };
  // the page scrolls to the bottom 100 ms after the draw (the desktop's timer): the card puts its header back
  { const { FC, list } = mkSetup();
    FC.chatShown('harbor', list); await settle();
    assert.strictEqual(list.scrollTop, 992, 'landed on the header');
    await sleep(100); list.scrollTop = list.scrollHeight - list.clientHeight;   // the page's own scroll
    await sleep(120);
    assert.strictEqual(list.scrollTop, 992, 'back on the header after the page scrolled to the bottom'); }
  // the reader drags to the very bottom (a pointerdown on the chat first): the hold ends, they stay at the bottom
  { const { FC, list } = mkSetup();
    FC.chatShown('harbor', list); await settle();
    await sleep(120);
    for (const f of ((list.listeners || {}).pointerdown || [])) f({});
    list.scrollTop = list.scrollHeight - list.clientHeight;
    await sleep(500);
    assert.strictEqual(list.scrollTop, list.scrollHeight - list.clientHeight, 'the reader stays at the bottom'); }
});
