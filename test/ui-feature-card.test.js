'use strict';
// The new-features card (lib/ui-feature-card.js), run in a sandbox with a small fake DOM, fetch and MutationObserver
// (the pattern of test/ui-team-card.test.js): nothing for a member / signed-out / show:false; the card sits at the end of
// the lead's chat only and comes back after the chat redraws; header and row words; the three buttons and what each sends;
// errors keep the buttons; the closing line; quiet notices; renderInto + refresh keep every copy in step.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'lib', 'ui-feature-card.js');
const SRC = fs.readFileSync(FILE, 'utf8');

function node(tag) {
  const n = {
    tag, className: '', id: '', hidden: false, disabled: false, textContent: '', children: [], listeners: {}, attrs: {}, parentNode: null,
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; },
    replaceChildren(...c) { this.children.forEach((x) => { x.parentNode = null; }); this.children = []; c.forEach((x) => this.appendChild(x)); },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
    click() { if (this.disabled) return; (this.listeners.click || []).forEach((f) => f({ preventDefault() {} })); },
    focus() { doc.activeElement = this; },
    get lastChild() { return this.children[this.children.length - 1] || null; },
    get text() { return this.textContent + this.children.map((c) => c.text).join(''); },
    find(pred, out = []) { if (pred(this)) out.push(this); this.children.forEach((c) => c.find(pred, out)); return out; },
  };
  return n;
}
let doc;

const E1 = { id: 'quick-research', title: 'Agents may start quick research', summary: 'An agent may start a run for its own work.', cost: 'uses your plan allowance', leadMay: true, recommendation: { decision: 'on', why: 'it saves you a step' } };
const E2 = { id: 'protect-code', title: 'Protect the program files', summary: 'Agents can no longer change the program files.', cost: 'none', leadMay: false, recommendation: null };
const N1 = { id: 'quiet-fix', title: 'Faster history search', line: 'Nothing for you to do.' };
const body = (over = {}) => ({ ok: true, show: true, lead: 'harbor', leadDisplay: 'Harbor', entries: [E1, E2], notices: [], ...over });

function page({ first = { status: 200, body: body() }, search = '' } = {}) {
  doc = null;
  const calls = []; const waiting = []; const observers = [];
  const cur = { first };
  const clock = { t: 1000000 };
  const d = {
    activeElement: null, readyState: 'complete', visibilityState: 'visible', listeners: {},
    createElement: (t) => node(t),
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
  };
  d.body = node('body'); d.head = node('head'); d.documentElement = node('html');
  doc = d;
  const fetch = (url, init = {}) => new Promise((resolve) => {
    const call = { url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const reply = (status, b) => resolve({ status, json: async () => b });
    if (call.method === 'GET') reply(cur.first.status, cur.first.body); else waiting.push({ call, reply });
  });
  class MO { constructor(f) { this.f = f; this.targets = []; observers.push(this); } observe(t) { this.targets.push(t); } disconnect() { this.targets = []; } fire() { this.f([]); } }
  const mod = { exports: {} };
  const ctx = { module: mod, document: d, fetch, location: { search }, encodeURIComponent, JSON, Promise, console, MutationObserver: MO, Date: { now: () => clock.t }, setTimeout, clearTimeout };
  vm.runInNewContext(SRC, ctx, { filename: FILE });
  const settle = async () => { for (let k = 0; k < 10; k++) await new Promise((r) => setImmediate(r)); };
  const answer = async (url, status, b) => {
    const i = waiting.findIndex((w) => w.call.url === url);
    assert.ok(i >= 0, `a request to ${url} is waiting`);
    waiting.splice(i, 1)[0].reply(status, b);
    await settle();
  };
  const mkList = () => { const l = node('div'); l.id = 'messages'; l.appendChild(Object.assign(node('div'), { textContent: 'hello' })); return l; };
  const cards = (list) => list.find((n) => n.className.split(' ').includes('feature-card'));
  const btns = (root, label) => root.find((n) => n.tag === 'button' && (label === undefined || n.textContent === label));
  return { FC: mod.exports, d, calls, waiting, answer, settle, mkList, cards, btns, observers, clock, cur, ctx };
}

test('nothing at all for a member (403), a signed-out page (401), an error or show:false', async () => {
  for (const first of [{ status: 403, body: { ok: false } }, { status: 401, body: {} }, { status: 500, body: null }, { status: 200, body: body({ show: false, entries: [] }) }]) {
    const p = page({ first });
    const list = p.mkList();
    p.FC.chatShown('harbor', list); await p.settle();
    assert.strictEqual(p.cards(list).length, 0, String(first.status));
    assert.strictEqual(list.children.length, 1, 'the list is untouched');
    const box = node('div');
    await p.FC.renderInto(box);
    assert.strictEqual(box.children.length, 0, 'the Settings copy is empty too');
  }
});

test('the card is the last child of the lead\'s message list and only there; exactly one', async () => {
  const p = page();
  const other = p.mkList(); const lead = p.mkList();
  await p.FC.start();
  p.FC.chatShown('scout', other); await p.settle();
  assert.strictEqual(p.cards(other).length, 0, 'not in another agent\'s chat');
  p.FC.chatShown('harbor', lead); await p.settle();
  assert.strictEqual(p.cards(lead).length, 1);
  assert.strictEqual(lead.lastChild, p.cards(lead)[0]);
  assert.strictEqual(p.cards(other).length, 0);
  p.FC.chatShown('harbor', lead); await p.settle();
  assert.strictEqual(p.cards(lead).length, 1, 'still one');
  // a second chat panel of the lead: the card moves, never two
  const lead2 = p.mkList();
  p.FC.chatShown('harbor', lead2); await p.settle();
  assert.strictEqual(p.cards(lead2).length, 1);
  assert.strictEqual(p.cards(lead).length, 0);
});

test('the card is a named region of real buttons', async () => {
  const p = page(); const list = p.mkList();
  p.FC.chatShown('harbor', list); await p.settle();
  const c = p.cards(list)[0];
  assert.strictEqual(c.attrs.role, 'region');
  assert.strictEqual(c.attrs['aria-label'], 'New features');
  for (const b of p.btns(c)) assert.strictEqual(b.attrs.type, 'button');
});

test('it survives the chat drawing its messages again (a MutationObserver on the list)', async () => {
  const p = page(); const list = p.mkList();
  p.FC.chatShown('harbor', list); await p.settle();
  const c = p.cards(list)[0];
  assert.ok(p.observers.length >= 1 && p.observers.some((o) => o.targets.includes(list)), 'watching the list');
  list.replaceChildren(Object.assign(node('div'), { textContent: 'one' }), Object.assign(node('div'), { textContent: 'two' }));   // a re-render drops the card
  assert.strictEqual(p.cards(list).length, 0);
  p.observers.forEach((o) => o.fire());
  assert.strictEqual(p.cards(list).length, 1);
  assert.strictEqual(list.lastChild, c, 'back at the end');
  list.appendChild(Object.assign(node('div'), { textContent: 'new message' }));   // a message after it
  p.observers.forEach((o) => o.fire());
  assert.strictEqual(list.lastChild, c);
  assert.strictEqual(p.cards(list).length, 1);
  p.observers.forEach((o) => o.fire());   // nothing changed: nothing moves
  assert.strictEqual(list.children.length, 4);
});

test('the phone: one list shared by every chat: opening another agent takes the card away, the lead brings it back', async () => {
  const p = page(); const list = p.mkList();
  p.FC.chatShown('harbor', list); await p.settle();
  assert.strictEqual(p.cards(list).length, 1);
  p.FC.chatShown('scout', list); await p.settle();
  assert.strictEqual(p.cards(list).length, 0);
  list.replaceChildren(Object.assign(node('div'), { textContent: 'scout says hi' }));
  p.observers.forEach((o) => o.fire());
  assert.strictEqual(p.cards(list).length, 0, 'the watcher does not put it back in another chat');
  p.FC.chatShown('harbor', list); await p.settle();
  assert.strictEqual(p.cards(list).length, 1);
});

test('the chat is shown before the first answer arrives: the card appears when it does', async () => {
  const p = page(); const list = p.mkList();
  p.FC.chatShown('harbor', list);   // no await: the fetch is still going
  assert.strictEqual(p.cards(list).length, 0);
  await p.settle();
  assert.strictEqual(p.cards(list).length, 1);
});

test('the header says One for one and the number in words for more', async () => {
  const words = { 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight', 9: 'Nine', 10: 'Ten' };
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ ...E2, id: 'e' + i, title: 'T' + i }));
  const one = page({ first: { status: 200, body: body({ entries: [E2] }) } }); const l1 = one.mkList();
  one.FC.chatShown('harbor', l1); await one.settle();
  assert.ok(one.cards(l1)[0].text.includes('One new feature is off until you say yes.'));
  for (const n of [2, 3, 10]) {
    const p = page({ first: { status: 200, body: body({ entries: mk(n) }) } }); const l = p.mkList();
    p.FC.chatShown('harbor', l); await p.settle();
    assert.ok(p.cards(l)[0].text.includes(`${words[n]} new features are off until you say yes.`), String(n));
  }
});

test('a row: bold title, summary, Cost line, and the lead\'s recommendation', async () => {
  const p = page({ first: { status: 200, body: body({ entries: [E1, E2, { ...E2, id: 'e3', title: 'Third', recommendation: { decision: 'off', why: 'it is rarely needed' } }] }) } });
  const list = p.mkList();
  p.FC.chatShown('harbor', list); await p.settle();
  const c = p.cards(list)[0];
  const rows = c.find((n) => /\bfc-row\b/.test(n.className));
  assert.strictEqual(rows.length, 3);
  const t1 = rows[0].text;
  for (const s of ['Agents may start quick research', 'An agent may start a run for its own work.', 'Cost: uses your plan allowance', 'Harbor recommends: Turn on: it saves you a step']) assert.ok(t1.includes(s), s);
  const title = rows[0].find((n) => /\bfc-title\b/.test(n.className))[0];
  assert.strictEqual(title.textContent, 'Agents may start quick research');
  assert.ok(title.tag === 'strong' || title.tag === 'b', 'bold');
  assert.ok(!rows[1].text.includes('recommends'), 'no recommendation, no line');
  assert.ok(rows[2].text.includes('Harbor recommends: Leave off: it is rarely needed'));
  const q = page({ first: { status: 200, body: body({ leadDisplay: '' }) } }); const l = q.mkList();
  q.FC.chatShown('harbor', l); await q.settle();
  assert.ok(q.cards(l)[0].text.includes('Maestro recommends: Turn on: it saves you a step'));
});

test('buttons per row: Turn on (primary), Leave off, Ask me in a week', async () => {
  const p = page(); const list = p.mkList();
  p.FC.chatShown('harbor', list); await p.settle();
  const rows = p.cards(list)[0].find((n) => /\bfc-row\b/.test(n.className));
  for (const r of rows) {
    assert.deepStrictEqual(p.btns(r).map((b) => b.textContent), ['Turn on', 'Leave off', 'Ask me in a week']);
    assert.ok(!/\bfc-go\b/.test(p.btns(r)[1].className));
  }
});

test('each button POSTs its decision, disables the row while it runs, then shows its result line', async () => {
  const cases = [['Turn on', 'on', 'Turned on.'], ['Leave off', 'off', 'Left off.'], ['Ask me in a week', 'snooze', 'I will ask again next week.']];
  for (const [label, decision, line] of cases) {
    const p = page({ first: { status: 200, body: body({ entries: [E1, E2] }) } }); const list = p.mkList();
    p.FC.chatShown('harbor', list); await p.settle();
    const row = () => p.cards(list)[0].find((n) => /\bfc-row\b/.test(n.className))[0];
    const first = p.btns(row(), label)[0];
    first.click(); first.click();   // a second press does nothing
    await p.settle();
    const posts = p.calls.filter((c) => c.method === 'POST');
    assert.strictEqual(posts.length, 1);
    assert.deepStrictEqual(posts[0], { url: '/api/behaviour-changes/quick-research', method: 'POST', body: { decision, expect: 'pending' } });
    assert.ok(p.btns(row()).every((b) => b.disabled), 'the row is locked while it runs');
    await p.answer('/api/behaviour-changes/quick-research', 200, { ok: true, change: { id: 'quick-research' }, rev: 'r1' });
    assert.ok(row().text.includes(line), line);
    assert.deepStrictEqual(p.btns(row()).map((b) => b.textContent), ['Undo'], 'the buttons are replaced by Undo');
    assert.strictEqual(p.btns(p.cards(list)[0]).length, 4, 'the other row is untouched');
  }
});

test('focus moves to the result line after a press', async () => {
  const p = page(); const list = p.mkList();
  p.FC.chatShown('harbor', list); await p.settle();
  const row = p.cards(list)[0].find((n) => /\bfc-row\b/.test(n.className))[0];
  p.btns(row, 'Turn on')[0].click(); await p.settle();
  await p.answer('/api/behaviour-changes/quick-research', 200, { ok: true });
  const f = p.d.activeElement;
  assert.ok(f && /Turned on\./.test(f.text), 'focus is on the result line');
  assert.strictEqual(f.attrs.tabindex, '-1');
});

test('an error shows the server text in the row and gives the buttons back', async () => {
  const p = page(); const list = p.mkList();
  p.FC.chatShown('harbor', list); await p.settle();
  const row = () => p.cards(list)[0].find((n) => /\bfc-row\b/.test(n.className))[0];
  p.btns(row(), 'Turn on')[0].click(); await p.settle();
  await p.answer('/api/behaviour-changes/quick-research', 403, { ok: false, error: 'Only the owner can answer this, from the owner\'s own browser.' });
  assert.ok(row().text.includes('Only the owner can answer this, from the owner\'s own browser.'));
  assert.deepStrictEqual(p.btns(row()).map((b) => b.textContent), ['Turn on', 'Leave off', 'Ask me in a week']);
  assert.ok(p.btns(row()).every((b) => !b.disabled));
  assert.ok(!p.cards(list)[0].text.includes('All set'));
  // a network failure still gives a line
  p.btns(row(), 'Leave off')[0].click(); await p.settle();
  await p.answer('/api/behaviour-changes/quick-research', 500, null);
  assert.ok(p.btns(row()).every((b) => !b.disabled));
  assert.ok(/could not|try again/i.test(row().text));
});

test('every row answered: one closing line and no buttons', async () => {
  const p = page(); const list = p.mkList();
  p.FC.chatShown('harbor', list); await p.settle();
  const c = () => p.cards(list)[0];
  p.btns(c(), 'Turn on')[0].click(); await p.settle();
  await p.answer('/api/behaviour-changes/quick-research', 200, { ok: true, rev: 'r1' });
  assert.ok(!c().text.includes('All set.'), 'one row is still open');
  p.btns(c(), 'Leave off')[0].click(); await p.settle();
  await p.answer('/api/behaviour-changes/protect-code', 200, { ok: true, rev: 'r1' });
  assert.ok(c().text.includes('All set. You can change these any time in Settings.'));
  assert.deepStrictEqual(p.btns(c()).map((b) => b.textContent), ['Undo', 'Undo', 'Settings'], 'only Undo and the Settings link');
  assert.strictEqual(c().text.split('All set.').length, 2, 'once');
});

test('quiet features already on: "<title> is now on. <line>" with Turn off and OK', async () => {
  const mk = () => page({ first: { status: 200, body: body({ entries: [], notices: [N1, { id: 'quiet-two', title: 'Tidier logs', line: 'Old logs are folded.' }] }) } });
  const p = mk(); const list = p.mkList();
  p.FC.chatShown('harbor', list); await p.settle();
  const c = () => p.cards(list)[0];
  const rows = () => c().find((n) => /\bfc-row\b/.test(n.className));
  assert.ok(rows()[0].text.includes('Faster history search is now on. Nothing for you to do.'));
  assert.deepStrictEqual(p.btns(rows()[0]).map((b) => b.textContent), ['Turn off', 'OK']);
  p.btns(rows()[0], 'Turn off')[0].click(); await p.settle();
  assert.deepStrictEqual(p.calls.filter((x) => x.method === 'POST')[0], { url: '/api/behaviour-changes/quiet-fix', method: 'POST', body: { decision: 'off', expect: 'on' } });
  await p.answer('/api/behaviour-changes/quiet-fix', 200, { ok: true });
  assert.ok(rows()[0].text.includes('Turned off.'));
  p.btns(rows()[1], 'OK')[0].click(); await p.settle();
  assert.deepStrictEqual(p.calls.filter((x) => x.method === 'POST')[1].body, { decision: 'seen', expect: 'on' });
  await p.answer('/api/behaviour-changes/quiet-two', 200, { ok: true });
  assert.ok(!c().text.includes('Tidier logs'), 'the OK row disappears');
  assert.ok(c().text.includes('All set.'));
});

test('renderInto draws the same card into a Settings element; answering in one copy updates the others; refresh refetches', async () => {
  const p = page(); const list = p.mkList(); const box = node('div');
  p.FC.chatShown('harbor', list); await p.settle();
  const shown = await p.FC.renderInto(box);
  assert.ok(shown);
  const inBox = () => box.find((n) => /\bfc-row\b/.test(n.className));
  assert.strictEqual(inBox().length, 2);
  assert.deepStrictEqual(p.btns(inBox()[0]).map((b) => b.textContent), ['Turn on', 'Leave off', 'Ask me in a week']);
  assert.strictEqual(box.find((n) => n.attrs && n.attrs['aria-label'] === 'New features').length, 1);
  p.btns(inBox()[0], 'Leave off')[0].click(); await p.settle();
  await p.answer('/api/behaviour-changes/quick-research', 200, { ok: true });
  assert.ok(inBox()[0].text.includes('Left off.'));
  const inChat = p.cards(list)[0].find((n) => /\bfc-row\b/.test(n.className))[0];
  assert.ok(inChat.text.includes('Left off.'), 'the chat copy follows');
  // refresh: the server now lists a new entry; the answered row stays, the new one is added in both
  p.cur.first = { status: 200, body: body({ entries: [E2, { ...E2, id: 'e9', title: 'Brand new thing' }] }) };
  const before = p.calls.filter((c) => c.method === 'GET').length;
  await p.FC.refresh();
  assert.strictEqual(p.calls.filter((c) => c.method === 'GET').length, before + 1);
  assert.ok(box.text.includes('Brand new thing') && p.cards(list)[0].text.includes('Brand new thing'));
  assert.ok(box.text.includes('Left off.'), 'the answered row keeps its result');
  assert.strictEqual(p.cards(list).length, 1);
});

test('the page comes back after 5+ minutes hidden: the card is fetched again; a short absence does not', async () => {
  const p = page(); const list = p.mkList();
  p.FC.autostart(); await p.settle();
  p.FC.chatShown('harbor', list); await p.settle();
  const gets = () => p.calls.filter((c) => c.method === 'GET').length;
  const g0 = gets();
  const vis = (state) => { p.d.visibilityState = state; (p.d.listeners.visibilitychange || []).forEach((f) => f()); };
  vis('hidden'); p.clock.t += 60 * 1000; vis('visible'); await p.settle();
  assert.strictEqual(gets(), g0, 'one minute: nothing');
  vis('hidden'); p.clock.t += 6 * 60 * 1000; vis('visible'); await p.settle();
  assert.strictEqual(gets(), g0 + 1);
});

test('opening the lead\'s chat asks again when the last answer is old', async () => {
  const p = page(); const list = p.mkList();
  p.FC.chatShown('harbor', list); await p.settle();
  const gets = () => p.calls.filter((c) => c.method === 'GET').length;
  const g0 = gets();
  p.FC.chatShown('harbor', list); await p.settle();
  assert.strictEqual(gets(), g0, 'just fetched: not again');
  p.clock.t += 60 * 1000;
  p.FC.chatShown('harbor', list); await p.settle();
  assert.strictEqual(gets(), g0 + 1);
});

test('server text only goes in as text: no innerHTML in the file, markup stays text', async () => {
  assert.doesNotMatch(SRC, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  const evil = { ...E2, title: '<img src=x onerror=alert(1)>', summary: '<script>1</script>' };
  const p = page({ first: { status: 200, body: body({ entries: [evil] }) } }); const list = p.mkList();
  p.FC.chatShown('harbor', list); await p.settle();
  assert.ok(p.cards(list)[0].text.includes('<img src=x onerror=alert(1)>'));
  assert.strictEqual(p.cards(list)[0].find((n) => n.tag === 'img' || n.tag === 'script').length, 0);
});

test('the style: page variables only (no raw colours), primary on the accent, 36px buttons on the phone', async () => {
  const p = page();
  const css = p.FC.CSS;
  assert.strictEqual(typeof css, 'string');
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, 'no hex colours');
  assert.doesNotMatch(css, /\b(rgba?|hsla?)\(/i, 'no rgb/hsl colours');
  assert.doesNotMatch(css, /:\s*(white|black|red|green|blue|gray|grey)\b/i, 'no colour names');
  for (const v of ['--bg-card', '--border', '--text', '--text-dim', '--accent', '--on-accent']) assert.ok(css.includes(v), v);
  assert.match(css, /fc-go[^}]*background: var\(--accent\)[^}]*color: var\(--on-accent\)/);
  assert.match(css, /min-height: 36px/);
  const list = p.mkList();
  p.FC.chatShown('harbor', list); await p.settle();
  assert.ok(p.d.head.find((n) => n.tag === 'style').length + p.d.body.find((n) => n.tag === 'style').length >= 1, 'the style is injected once');
  const box = node('div'); await p.FC.renderInto(box);
  assert.strictEqual(p.d.head.find((n) => n.tag === 'style').length + p.d.body.find((n) => n.tag === 'style').length, 1);
});

test('the module is documented, exports its API, and the pages load and call it', () => {
  assert.match(SRC, /root\.FeatureCard = api/);
  assert.match(SRC, /renderInto/);
  assert.match(SRC, /refresh/);
  const p = page();
  for (const f of ['start', 'chatShown', 'renderInto', 'refresh']) assert.strictEqual(typeof p.FC[f], 'function', f);
  for (const f of ['index.html', 'mobile.html']) assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), /<script src="\/ui-feature-card\.js"><\/script>/, f);
  assert.match(fs.readFileSync(path.join(ROOT, 'lib', 'static-files.js'), 'utf8'), /\['ui-feature-card\.js', 'lib\/ui-feature-card\.js'\]/);
  assert.match(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'), /FeatureCard\.chatShown\(/);
  assert.match(fs.readFileSync(path.join(ROOT, 'mobile.js'), 'utf8'), /FeatureCard\.chatShown\(/);
});

// ── p5b round 1 ──
const rowsOf = (p, list) => p.cards(list)[0].find((n) => /\bfc-row\b/.test(n.className));
test('r1 fix3: a 409 from a press refetches the card: the row shows the fresh state or disappears (no error, no dead buttons)', async () => {
  const p = page(); const list = p.mkList();
  p.FC.chatShown('harbor', list); await p.settle();
  p.btns(rowsOf(p, list)[0], 'Turn on')[0].click(); await p.settle();
  const gets = p.calls.filter((c) => c.method === 'GET').length;
  p.cur.first = { status: 200, body: body({ entries: [E2] }) };   // another device already answered it
  await p.answer('/api/behaviour-changes/quick-research', 409, { ok: false, error: 'already decided' });
  assert.strictEqual(p.calls.filter((c) => c.method === 'GET').length, gets + 1, 'the card was fetched again');
  assert.ok(!p.cards(list)[0].text.includes('Agents may start quick research'), 'the row is gone');
  assert.ok(!p.cards(list)[0].text.includes('already decided'));
  // still listed (snoozed on the other device, then back): the row shows the fresh data with working buttons
  const q = page(); const l2 = q.mkList();
  q.FC.chatShown('harbor', l2); await q.settle();
  q.btns(rowsOf(q, l2)[0], 'Leave off')[0].click(); await q.settle();
  q.cur.first = { status: 200, body: body({ entries: [{ ...E1, summary: 'A fresh summary.' }, E2] }) };
  await q.answer('/api/behaviour-changes/quick-research', 409, { ok: false, error: 'already decided' });
  assert.ok(rowsOf(q, l2)[0].text.includes('A fresh summary.'));
  assert.ok(!rowsOf(q, l2)[0].text.includes('already decided'));
  assert.ok(q.btns(rowsOf(q, l2)[0]).length === 3 && q.btns(rowsOf(q, l2)[0]).every((b) => !b.disabled));
});
test('r1 fix4: an answered row the server lists as actionable again (snooze ended, Restore) goes back to open with fresh data', async () => {
  const p = page(); const list = p.mkList();
  p.FC.chatShown('harbor', list); await p.settle();
  p.btns(rowsOf(p, list)[0], 'Ask me in a week')[0].click(); await p.settle();
  await p.answer('/api/behaviour-changes/quick-research', 200, { ok: true });
  assert.ok(rowsOf(p, list)[0].text.includes('I will ask again next week.'));
  p.cur.first = { status: 200, body: body({ entries: [{ ...E1, summary: 'Back, with new words.' }, E2] }) };
  await p.FC.refresh(); await p.settle();
  const r = rowsOf(p, list)[0];
  assert.ok(r.text.includes('Back, with new words.') && !r.text.includes('I will ask again'));
  assert.deepStrictEqual(p.btns(r).map((b) => b.textContent), ['Turn on', 'Leave off', 'Ask me in a week']);
  // a row the server no longer lists keeps its result line
  p.btns(rowsOf(p, list)[1], 'Leave off')[0].click(); await p.settle();
  await p.answer('/api/behaviour-changes/protect-code', 200, { ok: true });
  p.cur.first = { status: 200, body: body({ entries: [E1] }) };
  await p.FC.refresh(); await p.settle();
  assert.ok(p.cards(list)[0].text.includes('Left off.'));
});
test('r1 fix4: an answer that lands after a card fetch began is not undone by that older fetch', async () => {
  const p = page(); const list = p.mkList();
  p.FC.chatShown('harbor', list); await p.settle();
  const held = [];
  const real = p.ctx.fetch;
  p.ctx.fetch = (url, init = {}) => ((init.method || 'GET') === 'GET' ? new Promise((resolve) => held.push(() => resolve({ status: 200, json: async () => body() }))) : real(url, init));
  const f = p.FC.refresh();   // an older answer is on its way and still lists the row
  p.btns(rowsOf(p, list)[0], 'Turn on')[0].click(); await p.settle();
  await p.answer('/api/behaviour-changes/quick-research', 200, { ok: true });
  held.forEach((h) => h()); await f; await p.settle();
  assert.ok(rowsOf(p, list)[0].text.includes('Turned on.'), 'the answered row stays answered');
});
test('r1 fix5: a 401/403 on a fetch clears every row (answered too) and removes every copy', async () => {
  for (const status of [401, 403]) {
    const p = page(); const list = p.mkList(); const box = node('div');
    p.FC.chatShown('harbor', list); await p.settle();
    await p.FC.renderInto(box);
    p.btns(rowsOf(p, list)[0], 'Turn on')[0].click(); await p.settle();
    await p.answer('/api/behaviour-changes/quick-research', 200, { ok: true });
    p.cur.first = { status, body: { ok: false } };
    await p.FC.refresh(); await p.settle();
    assert.strictEqual(p.cards(list).length, 0, 'no chat copy');
    assert.strictEqual(box.find((n) => /\bfeature-card\b/.test(n.className)).length, 0, 'no Settings copy');
    assert.strictEqual(p.FC.state.rows.length, 0);
    assert.ok(!list.text.includes('Turned on.'));
  }
});
test('r1 fix6: the lead\'s chat then another chat shown before the first answer: the card lands in the lead\'s list', async () => {
  const p = page(); const lead = p.mkList(); const other = p.mkList();
  p.FC.chatShown('harbor', lead);
  p.FC.chatShown('scout', other);   // both before the first fetch resolves
  await p.settle();
  assert.strictEqual(p.cards(lead).length, 1);
  assert.strictEqual(p.cards(other).length, 0);
  assert.strictEqual(lead.lastChild, p.cards(lead)[0]);
});
test('r1 fix7: the header counts only open entry rows; no header when none is open; notices keep their own header while one is open', async () => {
  const p = page(); const list = p.mkList();
  p.FC.chatShown('harbor', list); await p.settle();
  assert.ok(p.cards(list)[0].text.includes('Two new features are off until you say yes.'));
  p.btns(rowsOf(p, list)[0], 'Leave off')[0].click(); await p.settle();
  await p.answer('/api/behaviour-changes/quick-research', 200, { ok: true });
  assert.ok(p.cards(list)[0].text.includes('One new feature is off until you say yes.'), 'only the open row counts');
  p.btns(rowsOf(p, list)[1], 'Leave off')[0].click(); await p.settle();
  await p.answer('/api/behaviour-changes/protect-code', 200, { ok: true });
  const t = p.cards(list)[0].text;
  assert.ok(!/new features? (is|are) off/.test(t), 'no entry header');
  assert.ok(t.includes('Left off.') && t.includes('All set. You can change these any time in Settings.'));
  const q = page({ first: { status: 200, body: body({ entries: [], notices: [N1] }) } }); const l2 = q.mkList();
  q.FC.chatShown('harbor', l2); await q.settle();
  assert.ok(q.cards(l2)[0].text.includes('New features were turned on for you.'));
  q.btns(rowsOf(q, l2)[0], 'Turn off')[0].click(); await q.settle();
  await q.answer('/api/behaviour-changes/quiet-fix', 200, { ok: true });
  assert.ok(!q.cards(l2)[0].text.includes('New features were turned on for you.'), 'no notice open: no header');
});

// ── p5b round 2 ──
const OWNER_LINE = 'Only the owner of this Maestro can switch this one.';
const gets = (p) => p.calls.filter((c) => c.method === 'GET').length;
test('r2 fix1: a press sends the rev the row was drawn from', async () => {
  const p = page({ first: { status: 200, body: body({ entries: [{ ...E1, rev: 'pending' }, { ...E2, rev: 'snoozed until 2026-12-03T12:00:00.000Z' }], notices: [{ ...N1, rev: 'on, seen x' }] }) } }); const list = p.mkList();
  p.FC.chatShown('harbor', list); await p.settle();
  p.btns(rowsOf(p, list)[0], 'Turn on')[0].click(); await p.settle();
  p.btns(rowsOf(p, list)[1], 'Leave off')[0].click(); await p.settle();
  p.btns(rowsOf(p, list)[2], 'OK')[0].click(); await p.settle();
  const posts = p.calls.filter((c) => c.method === 'POST').map((c) => c.body);
  assert.deepStrictEqual(posts, [{ decision: 'on', rev: 'pending' }, { decision: 'off', rev: 'snoozed until 2026-12-03T12:00:00.000Z' }, { decision: 'seen', rev: 'on, seen x' }]);
});
test('r2 fix2: a row with canSwitch false has no buttons and says only the owner can switch it', async () => {
  const p = page({ first: { status: 200, body: body({ entries: [{ ...E1, canSwitch: true }, { ...E2, canSwitch: false }] }) } }); const list = p.mkList();
  p.FC.chatShown('harbor', list); await p.settle();
  const [r1, r2] = rowsOf(p, list);
  assert.strictEqual(p.btns(r1).length, 3);
  assert.strictEqual(p.btns(r2).length, 0);
  assert.ok(r2.text.includes(OWNER_LINE) && !r1.text.includes(OWNER_LINE));
});
test('r2 fix3: role revoked while the card is open: a press gets 403, the fresh card is denied too: the card is gone everywhere', async () => {
  const p = page(); const list = p.mkList(); const box = node('div');
  p.FC.chatShown('harbor', list); await p.settle();
  await p.FC.renderInto(box);
  p.btns(rowsOf(p, list)[0], 'Turn on')[0].click(); await p.settle();
  const g = gets(p);
  p.cur.first = { status: 403, body: { ok: false } };
  await p.answer('/api/behaviour-changes/quick-research', 403, { ok: false, error: 'Sign in with an admin account in your browser to decide this.' });
  assert.strictEqual(gets(p), g + 1, 'the card was fetched again');
  assert.strictEqual(p.cards(list).length, 0);
  assert.strictEqual(box.find((n) => /\bfeature-card\b/.test(n.className)).length, 0);
  assert.strictEqual(p.FC.state.rows.length, 0);
  // 401 the same
  const q = page(); const l2 = q.mkList();
  q.FC.chatShown('harbor', l2); await q.settle();
  q.btns(rowsOf(q, l2)[0], 'Leave off')[0].click(); await q.settle();
  q.cur.first = { status: 401, body: {} };
  await q.answer('/api/behaviour-changes/quick-research', 401, { ok: false });
  assert.strictEqual(q.cards(l2).length, 0);
});
test('r2 fix3: a 403 from a press while the card is still allowed keeps the card: the error shows; canSwitch false from the fresh card turns it into the owner-only line', async () => {
  const p = page(); const list = p.mkList();
  p.FC.chatShown('harbor', list); await p.settle();
  p.btns(rowsOf(p, list)[1], 'Turn on')[0].click(); await p.settle();
  p.cur.first = { status: 200, body: body({ entries: [E1, { ...E2, canSwitch: false }] }) };
  await p.answer('/api/behaviour-changes/protect-code', 403, { ok: false, error: OWNER_LINE });
  const r2 = rowsOf(p, list)[1];
  assert.strictEqual(p.btns(r2).length, 0);
  assert.strictEqual(r2.text.split(OWNER_LINE).length - 1, 1, 'the line shows once');
  assert.strictEqual(p.btns(rowsOf(p, list)[0]).length, 3, 'other rows keep their buttons');
  // some other 403 text with a card that still allows it: text shown, buttons back
  p.btns(rowsOf(p, list)[0], 'Turn on')[0].click(); await p.settle();
  p.cur.first = { status: 200, body: body({ entries: [E1, E2] }) };
  await p.answer('/api/behaviour-changes/quick-research', 403, { ok: false, error: 'Sign in with an admin account in your browser to decide this.' });
  const r1 = rowsOf(p, list)[0];
  assert.ok(r1.text.includes('Sign in with an admin account'));
  assert.strictEqual(p.btns(r1).length, 3);
  assert.ok(p.btns(r1).every((b) => !b.disabled));
});
test('r2 fix4: only already decided means stale; any other 409 text or a 500 is shown in the row with the buttons back and no refetch', async () => {
  for (const [status, error] of [[409, 'not decided yet'], [409, 'the behaviour changes file could not be read, so it is not overwritten'], [500, 'Something broke.']]) {
    const p = page(); const list = p.mkList();
    p.FC.chatShown('harbor', list); await p.settle();
    p.btns(rowsOf(p, list)[0], 'Turn on')[0].click(); await p.settle();
    const g = gets(p);
    await p.answer('/api/behaviour-changes/quick-research', status, { ok: false, error });
    assert.strictEqual(gets(p), g, 'no refetch');
    const r = rowsOf(p, list)[0];
    assert.ok(r.text.includes(error), error);
    assert.strictEqual(p.btns(r).length, 3);
    assert.ok(p.btns(r).every((b) => !b.disabled));
  }
});
test('r2 fix4: already decided while a fetch is in flight: waits for it, then fetches once more', async () => {
  const p = page(); const list = p.mkList();
  p.FC.chatShown('harbor', list); await p.settle();
  const held = []; const real = p.ctx.fetch; let live = body();
  p.ctx.fetch = (url, init = {}) => ((init.method || 'GET') === 'GET' ? new Promise((resolve) => { const b = live; held.push(() => resolve({ status: 200, json: async () => b })); }) : real(url, init));
  const f = p.FC.refresh();   // in flight, still lists the row (older answer)
  p.btns(rowsOf(p, list)[0], 'Turn on')[0].click(); await p.settle();
  live = body({ entries: [E2] });   // the other device answered it
  await p.answer('/api/behaviour-changes/quick-research', 409, { ok: false, error: 'already decided' });
  assert.strictEqual(held.length, 1, 'no second GET while the first is in flight');
  held.shift()(); await f; await p.settle();
  assert.strictEqual(held.length, 1, 'one more GET after the first');
  held.shift()(); await p.settle();
  assert.ok(!p.cards(list)[0].text.includes('Agents may start quick research'), 'the answer reflects the other device');
});
test('r2 fix5: a card answer with no lead (or another lead) takes the chat copy off the old lead\'s list; Settings copies stay', async () => {
  const p = page(); const list = p.mkList(); const other = p.mkList(); const box = node('div');
  p.FC.chatShown('harbor', list); p.FC.chatShown('quill', other); await p.settle();
  await p.FC.renderInto(box);
  assert.strictEqual(p.cards(list).length, 1);
  p.cur.first = { status: 200, body: body({ lead: null, leadDisplay: null }) };
  await p.FC.refresh(); await p.settle();
  assert.strictEqual(p.FC.state.lead, '');
  assert.strictEqual(p.cards(list).length, 0, 'gone from the old lead\'s list');
  assert.strictEqual(p.cards(other).length, 0);
  assert.strictEqual(box.find((n) => /\bfeature-card\b/.test(n.className)).length, 1, 'the Settings copy stays');
  p.cur.first = { status: 200, body: body({ lead: 'quill', leadDisplay: 'Quill' }) };
  await p.FC.refresh(); await p.settle();
  assert.strictEqual(p.cards(list).length, 0);
  assert.strictEqual(p.cards(other).length, 1, 'now in the new lead\'s list');
  // show:false with no lead too
  p.cur.first = { status: 200, body: { ok: true, show: false, lead: null, entries: [], notices: [] } };
  await p.FC.refresh(); await p.settle();
  assert.strictEqual(p.FC.state.lead, '');
});
test('r2 fix6: a closed chat (its list no longer connected) is forgotten', async () => {
  const p = page(); const list = p.mkList(); const other = p.mkList();
  p.FC.chatShown('harbor', list); p.FC.chatShown('quill', other); await p.settle();
  assert.ok(p.FC.state.lists.has('quill'));
  other.isConnected = false;
  await p.FC.refresh(); await p.settle();
  assert.ok(!p.FC.state.lists.has('quill'));
  assert.ok(p.FC.state.lists.has('harbor'), 'a list without isConnected info stays');
});

// ── p5b round 3 ──
function heldGets(p, live) {
  const held = []; const real = p.ctx.fetch; const cur = { live };
  p.ctx.fetch = (url, init = {}) => ((init.method || 'GET') === 'GET' ? new Promise((resolve) => { const b = cur.live; held.push((status, bb) => resolve({ status: status === undefined ? 200 : status, json: async () => (bb !== undefined ? bb : b) })); }) : real(url, init));
  return { held, cur };
}
test('r3 fix1: a 403 from a press hides the card, ignores a GET that began before the revoke, then draws from a fresh GET (denied: gone)', async () => {
  const p = page(); const list = p.mkList(); const box = node('div');
  p.FC.chatShown('harbor', list); await p.settle();
  await p.FC.renderInto(box);
  const { held } = heldGets(p, body());
  const f = p.FC.refresh();                                   // began while still admin; its 200 is held
  p.btns(rowsOf(p, list)[0], 'Turn on')[0].click(); await p.settle();
  await p.answer('/api/behaviour-changes/quick-research', 403, { ok: false, error: 'No.' });
  assert.strictEqual(p.cards(list).length, 0, 'hidden at once');
  assert.strictEqual(box.find((n) => /\bfc-row\b/.test(n.className)).length, 0);
  assert.strictEqual(held.length, 1, 'no new GET before the old one settles');
  held.shift()(200); await f; await p.settle();               // the old rows answer
  assert.strictEqual(p.cards(list).length, 0, 'nothing drawn from the old answer');
  assert.strictEqual(box.find((n) => /\bfc-row\b/.test(n.className)).length, 0);
  assert.strictEqual(held.length, 1, 'one fresh GET');
  held.shift()(403, { ok: false }); await p.settle();
  assert.strictEqual(p.cards(list).length, 0);
  assert.strictEqual(box.find((n) => /\bfeature-card\b/.test(n.className)).length, 0);
  assert.strictEqual(p.FC.state.rows.length, 0);
});
test('r3 fix1: the allowed variant: the fresh GET\'s 200 draws the card from fresh data with the error on the pressed row', async () => {
  const p = page(); const list = p.mkList();
  p.FC.chatShown('harbor', list); await p.settle();
  const { held } = heldGets(p, body());
  const f = p.FC.refresh();
  p.btns(rowsOf(p, list)[0], 'Turn on')[0].click(); await p.settle();
  await p.answer('/api/behaviour-changes/quick-research', 403, { ok: false, error: 'Admins only.' });
  assert.strictEqual(p.cards(list).length, 0);
  held.shift()(200, body({ entries: [{ ...E1, title: 'OLD' }, E2] })); await f; await p.settle();
  assert.strictEqual(p.cards(list).length, 0, 'the older answer draws nothing');
  held.shift()(200, body({ entries: [{ ...E1, title: 'Fresh title' }, E2] })); await p.settle();
  const r = rowsOf(p, list)[0];
  assert.ok(r.text.includes('Fresh title') && !r.text.includes('OLD'));
  assert.ok(r.text.includes('Admins only.'));
  assert.strictEqual(p.btns(r).length, 3);
});

// ---- round 4 page changes ----
test('r4 fix1: a press 403, then a failed fresh GET (503): every copy stays hidden; a later 200 draws from that answer', async () => {
  const p = page(); const list = p.mkList(); const box = node('div');
  p.FC.chatShown('harbor', list); await p.settle();
  await p.FC.renderInto(box);
  const { held } = heldGets(p, body());
  p.btns(rowsOf(p, list)[0], 'Turn on')[0].click(); await p.settle();
  await p.answer('/api/behaviour-changes/quick-research', 403, { ok: false, error: 'No.' });
  assert.strictEqual(held.length, 1);
  held.shift()(503, null); await p.settle();
  assert.strictEqual(p.cards(list).length, 0, 'chat copy hidden');
  assert.strictEqual(box.find((n) => /\bfc-row\b/.test(n.className)).length, 0, 'page copy hidden');
  const f = p.FC.refresh(); await p.settle();
  held.shift()(200, body({ entries: [{ ...E1, title: 'Fresh title' }, E2] })); await f; await p.settle();
  assert.ok(rowsOf(p, list)[0].text.includes('Fresh title'));
  assert.ok(box.find((n) => /\bfc-row\b/.test(n.className)).length >= 1);
});
test('r4 fix1: a press 403, then GET 403: gone', async () => {
  const p = page(); const list = p.mkList();
  p.FC.chatShown('harbor', list); await p.settle();
  const { held } = heldGets(p, body());
  p.btns(rowsOf(p, list)[0], 'Turn on')[0].click(); await p.settle();
  await p.answer('/api/behaviour-changes/quick-research', 403, { ok: false, error: 'No.' });
  held.shift()(403, { ok: false }); await p.settle();
  assert.strictEqual(p.cards(list).length, 0);
  assert.strictEqual(p.FC.state.rows.length, 0);
});

async function pressed(decision = 'Turn on', extra = {}) {
  const p = page({ first: { status: 200, body: body({ entries: [{ ...E1, rev: 'pending' }, E2] }) } }); const list = p.mkList();
  p.FC.chatShown('harbor', list); await p.settle();
  const box = node('div'); await p.FC.renderInto(box);
  p.btns(rowsOf(p, list)[0], decision)[0].click(); await p.settle();
  await p.answer('/api/behaviour-changes/quick-research', 200, { ok: true, change: {}, rev: 'on, x1', ...extra });
  return { p, list, box };
}
test('r4 fix2: Undo sits beside each result line (not for a notice OK) and every copy shows it', async () => {
  for (const [label, line] of [['Turn on', 'Turned on.'], ['Leave off', 'Left off.'], ['Ask me in a week', 'I will ask again next week.']]) {
    const { p, list, box } = await pressed(label);
    const r = rowsOf(p, list)[0];
    assert.ok(r.text.includes(line)); assert.deepStrictEqual(p.btns(r).map((b) => b.textContent), ['Undo']);
    assert.ok(box.find((n) => n.tag === 'button' && n.textContent === 'Undo').length === 1);
  }
  const p = page({ first: { status: 200, body: body({ entries: [], notices: [{ ...N1, rev: 'on, s' }] }) } }); const list = p.mkList();
  p.FC.chatShown('harbor', list); await p.settle();
  p.btns(rowsOf(p, list)[0], 'OK')[0].click(); await p.settle();
  await p.answer('/api/behaviour-changes/quiet-fix', 200, { ok: true, rev: 'x' });
  assert.strictEqual(p.btns(p.cards(list)[0] || node('div'), 'Undo').length, 0);
});
test('r4 fix2: Undo posts reopen with the press rev; the row goes back to open with its buttons and a refetch', async () => {
  const { p, list, box } = await pressed();
  const getsBefore = p.calls.filter((c) => c.method === 'GET').length;
  p.btns(rowsOf(p, list)[0], 'Undo')[0].click(); await p.settle();
  const post = p.calls.filter((c) => c.method === 'POST').pop();
  assert.deepStrictEqual(post.body, { decision: 'reopen', rev: 'on, x1' });
  p.cur.first = { status: 200, body: body({ entries: [{ ...E1, title: 'Refetched', rev: 'pending' }, E2] }) };
  await p.answer('/api/behaviour-changes/quick-research', 200, { ok: true, rev: 'pending' });
  assert.ok(p.calls.filter((c) => c.method === 'GET').length > getsBefore, 'refetched');
  const r = rowsOf(p, list)[0];
  assert.deepStrictEqual(p.btns(r).map((b) => b.textContent), ['Turn on', 'Leave off', 'Ask me in a week']);
  assert.ok(r.text.includes('Refetched'));
  assert.ok(box.find((n) => n.tag === 'button' && n.textContent === 'Turn on').length >= 1, 'page copy follows');
});
test('r4 fix2: Undo 409 refetches; another error shows on the row', async () => {
  let { p, list } = await pressed();
  p.btns(rowsOf(p, list)[0], 'Undo')[0].click(); await p.settle();
  const g = p.calls.filter((c) => c.method === 'GET').length;
  await p.answer('/api/behaviour-changes/quick-research', 409, { ok: false, error: 'already decided' });
  assert.ok(p.calls.filter((c) => c.method === 'GET').length > g, 'refetched');
  ({ p, list } = await pressed());
  p.btns(rowsOf(p, list)[0], 'Undo')[0].click(); await p.settle();
  await p.answer('/api/behaviour-changes/quick-research', 500, { ok: false, error: 'Disk is full.' });
  const r = rowsOf(p, list)[0];
  assert.ok(r.text.includes('Disk is full.') && r.text.includes('Turned on.'));
  assert.strictEqual(p.btns(r, 'Undo').length, 1, 'Undo stays');
});
test('r5: a refused Undo hides every copy until a fresh card answer; a 403 there too clears the card', async () => {
  const { p, list, box } = await pressed();
  const { held } = heldGets(p, body());
  p.btns(rowsOf(p, list)[0], 'Undo')[0].click(); await p.settle();
  await p.answer('/api/behaviour-changes/quick-research', 403, { ok: false, error: 'No.' });
  assert.strictEqual(p.cards(list).length, 0, 'hidden while access is checked');
  assert.strictEqual(box.find((n) => n.tag === 'button' && n.textContent === 'Undo').length, 0, 'the page copy is hidden too');
  assert.strictEqual(p.FC.state.suspect, true);
  held.shift()(403, { ok: false }); await p.settle();
  assert.strictEqual(p.cards(list).length, 0);
  assert.strictEqual(p.FC.state.rows.length, 0);
});
test('r4 fix3: Settings in the closing line opens Settings through FeatureCard.openSettings, else window.openSettings', async () => {
  for (const mode of ['fc', 'global']) {
    const p = page({ first: { status: 200, body: body({ entries: [E1], notices: [] }) } }); const list = p.mkList();
    let n = 0;
    if (mode === 'fc') p.FC.openSettings = () => { n++; }; else p.ctx.openSettings = () => { n++; };
    p.FC.chatShown('harbor', list); await p.settle();
    p.btns(rowsOf(p, list)[0], 'Leave off')[0].click(); await p.settle();
    await p.answer('/api/behaviour-changes/quick-research', 200, { ok: true, rev: 'r' });
    const c = p.cards(list)[0];
    assert.ok(c.text.includes('All set. You can change these any time in Settings.'));
    p.btns(c, 'Settings')[0].click();
    assert.strictEqual(n, 1, mode);
  }
});
test('r4 fix4: Turn on is the primary only on a row whose recommendation is on', async () => {
  const off = { ...E2, recommendation: { decision: 'off', why: 'x' } };
  const p = page({ first: { status: 200, body: body({ entries: [E1, E2, off] }) } }); const list = p.mkList();
  p.FC.chatShown('harbor', list); await p.settle();
  const rs = rowsOf(p, list);
  assert.ok(/\bfc-go\b/.test(p.btns(rs[0], 'Turn on')[0].className));
  for (const r of rs.slice(1)) assert.ok(p.btns(r).every((b) => !/\bfc-go\b/.test(b.className)));
});
test('r4 fix5: accent outline on the card, recommendation at full text colour, var() only', () => {
  const css = page().FC.CSS;
  assert.match(css, /\.feature-card \{[^}]*border: 1px solid var\(--accent\)/);
  assert.match(css, /\.fc-rec \{[^}]*color: var\(--text\)/);
  assert.doesNotMatch(css, /\.fc-cost, \.feature-card \.fc-rec/);
});
