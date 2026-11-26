'use strict';
// The chat header's Claude usage badge: the shared view rule (lib/ui-plan-state.js planBadgeView), the words, the per-person
// choice, and the chooser popup, on the desktop page (app.js) and the phone page (mobile.js). The real page functions run in a
// vm over a small fake DOM.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const L = require('../lib/ui-plan-state');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const tick = () => new Promise(r => setImmediate(r));
const W = (family, utilization, extra) => Object.assign({ family, label: family ? family[0].toUpperCase() + family.slice(1) : null, utilization, rejected: false, extraUsage: false, resetsAt: '2026-11-30T20:00:00Z' }, extra || {});
const D = (weekly, five, extra) => ({ weekly, windows: five == null ? {} : { five_hour: Object.assign({ utilization: five, resets_at: '2026-11-27T01:00:00Z' }, extra || {}) }, warn: { at: [75, 90] } });
const LV = [75, 90];
const kinds = (v) => [v.main.kind, ...v.extras.map(e => e.kind)];

// ── the shared rule ──
test('planBadgeView default: the plan higher -> plan alone; avail lists the windows with a reading, in order', () => {
  const v = L.planBadgeView(D([W(null, 40), W('fable', 22)], 10), 'fable', null, true, LV);
  assert.deepStrictEqual(kinds(v), ['plan']);
  assert.deepStrictEqual(v.avail, ['plan', 'family', 'five']);
  assert.strictEqual(v.cls, '');
  assert.strictEqual(v.main.w.utilization, 40);
});
test('planBadgeView default: the family higher -> added; equal after rounding -> not', () => {
  assert.deepStrictEqual(kinds(L.planBadgeView(D([W(null, 18), W('fable', 19)]), 'fable', null, true, [])), ['plan', 'family']);
  assert.deepStrictEqual(kinds(L.planBadgeView(D([W(null, 18.2), W('fable', 18.4)]), 'fable', null, true, [])), ['plan']);
});
test('planBadgeView default: the family used up (rejected, or exactly 100) or on extra usage is added even when lower; the plan at 99.6 does not hide it', () => {
  assert.deepStrictEqual(kinds(L.planBadgeView(D([W(null, 50), W('fable', 60, { rejected: true })]), 'fable', null, true, [])), ['plan', 'family']);
  assert.deepStrictEqual(kinds(L.planBadgeView(D([W(null, 99.6), W('fable', 100)]), 'fable', null, true, [])), ['plan', 'family']);
  assert.deepStrictEqual(kinds(L.planBadgeView(D([W(null, 99.6), W('fable', 100, { extraUsage: true })]), 'fable', null, true, [])), ['plan', 'family']);
  assert.deepStrictEqual(kinds(L.planBadgeView(D([W(null, 70, { rejected: true }), W('fable', 40)]), 'fable', null, true, [75])), ['plan']);
});
test('planBadgeView default: no plan window -> the family leads; no weekly window at all -> null', () => {
  const v = L.planBadgeView(D([W('fable', 30)]), 'fable', null, true, []);
  assert.deepStrictEqual([kinds(v), v.avail], [['family'], ['family']]);
  assert.strictEqual(L.planBadgeView(D([W('opus', 30)]), 'fable', null, true, []), null);
  assert.strictEqual(L.planBadgeView(D([], 80), 'fable', 'five', true, []), null, 'a 5-hour reading alone gives no badge');
  assert.strictEqual(L.planBadgeView(D([W(null, null), W('fable', null)]), 'fable', null, true, []), null);
  assert.strictEqual(L.planBadgeView(null, 'fable', null, true, []), null);
  assert.deepStrictEqual(L.planBadgeView(D([W(null, 30), W('opus', 90)]), null, null, true, []).avail, ['plan'], 'no family: only the plan');
});
test('planBadgeView default: the 5h window is last, added over 50 with subscriptions on, or when used up whatever the switch says', () => {
  assert.deepStrictEqual(kinds(L.planBadgeView(D([W(null, 80), W('fable', 95)], 62), 'fable', null, true, LV)), ['plan', 'family', 'five']);
  assert.deepStrictEqual(kinds(L.planBadgeView(D([W(null, 80)], 40), 'fable', null, true, LV)), ['plan']);
  assert.deepStrictEqual(kinds(L.planBadgeView(D([W(null, 80)], 62), 'fable', null, false, LV)), ['plan']);
  assert.deepStrictEqual(kinds(L.planBadgeView(D([W(null, 20)], 100), 'fable', null, false, LV)), ['plan', 'five']);
  assert.strictEqual(L.planBadgeView(D([W(null, 80)], 62), 'fable', null, true, LV).extras[0].w.utilization, 62);
});
test('planBadgeView: the 5-hour window reads resets_at as resetsAt', () => {
  const v = L.planBadgeView(D([W(null, 20)], 70), 'fable', 'five', true, LV);
  assert.strictEqual(v.main.w.resetsAt, '2026-11-27T01:00:00Z');
});
test('planBadgeView choice "family": the family leads; the plan joins only when higher, at a warning level, used up or on extra usage', () => {
  assert.deepStrictEqual(kinds(L.planBadgeView(D([W(null, 18), W('fable', 19)]), 'fable', 'family', true, LV)), ['family'], 'plan lower and quiet: not shown');
  assert.deepStrictEqual(kinds(L.planBadgeView(D([W(null, 30), W('fable', 19)]), 'fable', 'family', true, LV)), ['family', 'plan'], 'plan higher');
  assert.deepStrictEqual(kinds(L.planBadgeView(D([W(null, 80), W('fable', 85)]), 'fable', 'family', true, LV)), ['family', 'plan'], 'plan at a warning level');
  assert.deepStrictEqual(kinds(L.planBadgeView(D([W(null, 50, { rejected: true }), W('fable', 60)]), 'fable', 'family', true, LV)), ['family', 'plan'], 'plan used up');
  assert.deepStrictEqual(kinds(L.planBadgeView(D([W(null, 100, { extraUsage: true }), W('fable', 100, { extraUsage: true })]), 'fable', 'family', true, LV)), ['family', 'plan'], 'plan on extra usage');
});
test('planBadgeView choice "five": the 5-hour window leads; weekly windows follow only at a warning level or used up', () => {
  assert.deepStrictEqual(kinds(L.planBadgeView(D([W(null, 40), W('fable', 22)], 70), 'fable', 'five', true, LV)), ['five']);
  assert.deepStrictEqual(kinds(L.planBadgeView(D([W(null, 40), W('fable', 80)], 70), 'fable', 'five', true, LV)), ['five', 'family']);
  assert.deepStrictEqual(kinds(L.planBadgeView(D([W(null, 95), W('fable', 60, { rejected: true })], 70), 'fable', 'five', true, LV)), ['five', 'plan', 'family']);
  assert.deepStrictEqual(kinds(L.planBadgeView(D([W(null, 20)], 10), 'fable', 'five', false, LV)), ['five', 'plan'], 'a low 5h reading can still be chosen; a higher weekly window joins');
  assert.deepStrictEqual(kinds(L.planBadgeView(D([W(null, 10)], 30), 'fable', 'five', false, LV)), ['five'], 'a low 5h reading can still be chosen');
});
test('planBadgeView: a choice whose window is missing falls back to the plan (or the family when there is no plan window)', () => {
  assert.strictEqual(L.planBadgeView(D([W(null, 40), W('fable', 22)]), 'fable', 'five', true, LV).main.kind, 'plan');
  assert.strictEqual(L.planBadgeView(D([W(null, 40)]), 'fable', 'family', true, LV).main.kind, 'plan');
  assert.strictEqual(L.planBadgeView(D([W('fable', 40)]), 'fable', 'plan', true, LV).main.kind, 'family');
  assert.strictEqual(L.planBadgeView(D([W(null, 40)]), 'fable', 'bogus', true, LV).main.kind, 'plan');
});
test('planBadgeView: cls is the worst of all windows with a reading, shown or not', () => {
  assert.strictEqual(L.planBadgeView(D([W(null, 80), W('fable', 20)]), 'fable', null, true, LV).cls, 'warn');
  assert.strictEqual(L.planBadgeView(D([W(null, 80), W('fable', 95)]), 'fable', null, true, LV).cls, 'hot');
  assert.strictEqual(L.planBadgeView(D([W(null, 20), W('fable', 20)], 95), 'fable', null, true, LV).cls, 'hot', 'a 5h window that is not shown still counts');
  assert.strictEqual(L.planBadgeView(D([W(null, 95), W('fable', 60, { rejected: true })], 80), 'fable', 'five', true, LV).cls, 'refused');
  assert.strictEqual(L.planBadgeView(D([W(null, 20), W('fable', 20)], 10), 'fable', null, true, LV).cls, '');
});

// ── a small fake DOM ──
class El {
  constructor(tag, doc) { this.tag = tag; this.doc = doc; this.children = []; this.parentNode = null; this.attrs = {}; this.style = {}; this.hidden = false; this.className = ''; this.title = ''; this.id = ''; this._text = ''; this.L = {}; this.onclick = null; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach(c => this.appendChild(c)); }
  remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(x => x !== this); this.parentNode = null; } }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  addEventListener(t, f) { (this.L[t] = this.L[t] || []).push(f); }
  removeEventListener(t, f) { this.L[t] = (this.L[t] || []).filter(x => x !== f); }
  dispatch(t, e) {
    e = Object.assign({ target: this, preventDefault() { this.prevented = true; }, stopPropagation() {} }, e || {});
    for (let n = this; n; n = n.parentNode) for (const f of (n.L[t] || []).slice()) f(e);
    if (t === 'click' && this.onclick) this.onclick(e);
    return e;
  }
  focus() { this.doc.activeElement = this; }
  getBoundingClientRect() { return this.rect || { left: 800, right: 900, top: 10, bottom: 40, width: 100, height: 30 }; }
  get offsetWidth() { return 300; }
  get offsetHeight() { return 120; }
  find(pred, out) { out = out || []; if (pred(this)) out.push(this); this.children.forEach(c => c.find(pred, out)); return out; }
}
function makeDom() {
  const doc = new El('#document', null); doc.doc = doc;
  doc.body = new El('body', doc); doc.appendChild(doc.body);
  doc.activeElement = doc.body;
  doc.createElement = (t) => new El(t, doc);
  doc.getElementById = (id) => doc.find(e => e.id === id)[0] || null;
  return doc;
}
const storage = (init) => { const m = Object.assign({}, init || {}); return { m, getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } }; };

function pageSlice(src, from, to) { const a = src.indexOf(from); const b = src.indexOf(to, a); assert.ok(a > 0 && b > a, 'slice ' + from); return src.slice(a, b); }
const PHONE_WHEN = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });

// A page under test: { badge, doc, ctx, store, opened, posts, paint(), chooser() }
function makePage(kind, o) {
  o = o || {};
  const doc = makeDom();
  const badge = new El('button', doc); doc.body.appendChild(badge);
  badge.hidden = true;
  const store = storage(o.local);
  const posts = []; const opened = { subs: 0, settings: 0 };
  const win = { hubMe: o.me === undefined ? {} : o.me, innerWidth: 1000, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
  const fetchStub = async (url, init) => { const post = { url, init, body: init && init.body ? JSON.parse(init.body) : null }; posts.push(post); if (o.hold) return o.hold(post); const st = o.status || 200; return { ok: st === 200, status: st, json: async () => ({}) }; };
  const base = { Math, Number, String, Array, Object, Date, JSON, Promise, setTimeout, clearTimeout, document: doc, localStorage: store, console, window: win };
  let ctx;
  if (kind === 'desktop') {
    badge.id = 'plan-badge-c1';
    ctx = vm.createContext(Object.assign(base, {
      planLast: o.data, chats: { c1: { agent: 'a', isGroup: false } }, chatModelOf: () => o.model || 'claude-sdk/claude-fable-5', fetch: fetchStub,
      subsIsCodex: (m) => /^codex-cli\//.test(m), subsEnabled: () => o.subs !== false, planWhen: (x) => 'WHEN-' + String(x).slice(5, 10),
      openPlanSettings() { opened.settings++; }, openSubsSettings() { opened.subs++; }, codexLast: null,
    }));
    vm.runInContext(pageSlice(read('app.js'), '// ── plan state helpers (begin) ──', 'async function openPlanSettings('), ctx);
  } else {
    badge.id = 'chat-plan';
    ctx = vm.createContext(Object.assign(base, {
      planUsageLast: o.data, current: 'a', agentByName: () => ({ model: o.model || 'claude-sdk/claude-fable-5' }), $: (id) => (id === 'chat-plan' ? badge : doc.getElementById(id)),
      subsEnabled: () => o.subs !== false, isAdmin: () => true, codexBadge() { return null; }, codexUsageLast: null, codexAskAt: 0,
      codexShouldRead: () => false, codexAskRead() {}, codexPendingBadge: () => null, hubMe: win.hubMe,
      api: async (p, init) => fetchStub(p, init), openSubsSheet() { opened.subs++; }, toast() {},
    }));
    vm.runInContext(pageSlice(read('mobile.js'), '// ── plan state helpers (begin) ──', '\n// Every model change'), ctx);
  }
  const paint = () => vm.runInContext(kind === 'desktop' ? 'paintPlanBadges()' : 'paintPlan()', ctx);
  const chooser = () => doc.getElementById('plan-badge-chooser');
  const rows = () => (chooser() ? chooser().find(e => e.getAttribute('role') === 'option') : []);
  const choice = () => vm.runInContext('planBadgeChoice()', ctx);
  return { kind, badge, doc, ctx, store, posts, opened, win, paint, chooser, rows, choice, set data(d) { if (kind === 'desktop') ctx.planLast = d; else ctx.planUsageLast = d; } };
}
const KINDS = ['desktop', 'phone'];
const whenOf = (kind, iso) => (kind === 'desktop' ? 'WHEN-' + iso.slice(5, 10) : PHONE_WHEN(iso));
const stripCheck = (t) => t.replace(/^✓\s*/, '');

// ── the words ──
for (const kind of KINDS) {
  test(`${kind}: default badge words; phone now says "this week" too`, () => {
    const p = makePage(kind, { data: D([W(null, 18), W('fable', 19)], 62) });
    p.paint();
    assert.strictEqual(p.badge.textContent, 'Plan 18% this week · Fable 19% · 5h 62%');
    assert.strictEqual(p.badge.hidden, false);
  });
  test(`${kind}: choice "family" -> "Fable 19% this week"; plan joins only when higher / at a warning level / used up`, () => {
    const p = makePage(kind, { data: D([W(null, 18), W('fable', 19)]), local: { 'mm-plan-badge': 'family' } });
    p.paint();
    assert.strictEqual(p.badge.textContent, 'Fable 19% this week');
    p.data = D([W(null, 80), W('fable', 85)]); p.paint();
    assert.strictEqual(p.badge.textContent, 'Fable 85% this week · Plan 80%');
    assert.match(p.badge.className, /\bhot\b|\bwarn\b/);
  });
  test(`${kind}: choice "five" -> "5h 70%" then the weekly windows that pass a level or are used up`, () => {
    const p = makePage(kind, { data: D([W(null, 40), W('fable', 22)], 70), local: { 'mm-plan-badge': 'five' } });
    p.paint();
    assert.strictEqual(p.badge.textContent, '5h 70%');
    p.data = D([W(null, 95), W('fable', 60, { rejected: true })], 70); p.paint();
    assert.strictEqual(p.badge.textContent, '5h 70% · Plan 95% · Fable used up');
    assert.match(p.badge.className, /\brefused\b/);
  });
  test(`${kind}: a choice whose window is missing shows the plan`, () => {
    const p = makePage(kind, { data: D([W(null, 40), W('fable', 22)]), local: { 'mm-plan-badge': 'five' } });
    p.paint();
    assert.strictEqual(p.badge.textContent, 'Plan 40% this week');
  });
  test(`${kind}: the hover has one sentence per window shown, main first`, () => {
    const p = makePage(kind, { data: D([W(null, 80), W('fable', 95)], 62) });
    p.paint();
    const t = p.badge.title;
    if (kind === 'desktop') {
      assert.ok(t.startsWith("Your Claude plan has used 80% of this week's allowance (resets WHEN-11-30); Fable has used 95% (resets WHEN-11-30); 5-hour window 62%"), t);
    } else {
      assert.strictEqual(t, "All models: 80% of this week's Claude plan allowance; Fable: 95%; 5-hour window 62%");
    }
    p.data = D([W(null, 80)], 40); p.paint();
    assert.ok(!p.badge.title.includes('5-hour'), 'a window that is not shown is not in the hover: ' + p.badge.title);
    p.store.setItem('mm-plan-badge', 'five'); p.paint();
    assert.ok(p.badge.title.startsWith('5-hour window 40%'), p.badge.title);
  });
  test(`${kind}: the badge is a button with the accessible name, a listbox popup and aria-expanded`, () => {
    const p = makePage(kind, { data: D([W(null, 40), W('fable', 22)]) });
    p.paint();
    assert.strictEqual(p.badge.getAttribute('aria-haspopup'), 'listbox');
    assert.strictEqual(p.badge.getAttribute('aria-expanded'), 'false');
    assert.strictEqual(p.badge.getAttribute('aria-label'), 'Claude usage: Plan 40% this week. Press to choose what this shows.');
    assert.match(p.badge.className, kind === 'desktop' ? /^plan-badge/ : /^sub/);
  });
}
test('the badge markup is a <button type="button"> on both pages, keeping its id; the span is gone', () => {
  assert.ok(read('app.js').includes('<button type="button" class="plan-badge" id="plan-badge-${chatId}" hidden></button>'));
  assert.ok(!read('app.js').includes('<span class="plan-badge" id="plan-badge-'));
  assert.match(read('mobile.html'), /<button type="button" class="sub" id="chat-plan"[^>]*\bhidden\b[^>]*><\/button>/);
  assert.ok(!read('mobile.html').includes('<span class="sub" id="chat-plan"'));
});

// ── where the choice is kept ──
for (const kind of KINDS) {
  const data = D([W(null, 18), W('fable', 19)]);
  test(`${kind}: the person's stored value beats the device copy and replaces it`, () => {
    const p = makePage(kind, { data, me: { planBadge: 'family' }, local: { 'mm-plan-badge': 'five' } });
    assert.strictEqual(p.choice(), 'family');
    assert.strictEqual(p.store.m['mm-plan-badge'], 'family', 'the device copy now matches');
  });
  test(`${kind}: the device value is used when the person has none; nothing -> null; junk is ignored`, () => {
    assert.strictEqual(makePage(kind, { data, me: {}, local: { 'mm-plan-badge': 'five' } }).choice(), 'five');
    assert.strictEqual(makePage(kind, { data, me: null, local: { 'mm-plan-badge': 'family' } }).choice(), 'family');
    assert.strictEqual(makePage(kind, { data, me: {} }).choice(), null);
    assert.strictEqual(makePage(kind, { data, me: { planBadge: 'bogus' }, local: { 'mm-plan-badge': 'nope' } }).choice(), null);
    const noOverwrite = makePage(kind, { data, me: { planBadge: 'plan' }, local: { 'mm-plan-badge': 'five' } });
    noOverwrite.choice();
    assert.strictEqual(noOverwrite.win.hubMe.planBadge, 'plan', 'a device value never overwrites a stored one');
  });
  test(`${kind}: choosing repaints at once, writes the device copy, POSTs { planBadge } and updates the person value on 200`, async () => {
    const p = makePage(kind, { data, me: { planBadge: 'plan' } });
    p.paint();
    p.badge.dispatch('click');
    p.rows()[1].dispatch('click');   // the family row
    assert.strictEqual(p.badge.textContent, 'Fable 19% this week', 'repainted before the answer');
    assert.strictEqual(p.store.m['mm-plan-badge'], 'family');
    await tick();
    assert.strictEqual(p.posts.length, 1);
    assert.strictEqual(p.posts[0].url, '/api/me/prefs');
    assert.strictEqual(p.posts[0].init.method, 'POST');
    if (kind === 'desktop') assert.strictEqual(p.posts[0].init.credentials, 'include');   // the phone's api() adds it itself
    assert.strictEqual(p.posts[0].init.headers['Content-Type'], 'application/json');
    assert.deepStrictEqual(p.posts[0].body, { planBadge: 'family' });
    assert.strictEqual(p.win.hubMe.planBadge, 'family');
    assert.strictEqual(p.choice(), 'family');
  });
  test(`${kind}: a 400 (an older server) keeps the device value silently, even over an older stored value`, async () => {
    const p = makePage(kind, { data, me: { planBadge: 'plan' }, status: 400 });
    p.paint();
    p.badge.dispatch('click');
    p.rows()[1].dispatch('click');
    await tick();
    assert.strictEqual(p.posts.length, 1);
    assert.strictEqual(p.store.m['mm-plan-badge'], 'family');
    assert.strictEqual(p.choice(), 'family');
    p.paint();
    assert.strictEqual(p.badge.textContent, 'Fable 19% this week');
    assert.strictEqual(p.win.hubMe.planBadge, 'plan', 'the stored value is untouched');
  });
  test(`${kind}: only plan / family / five are ever sent`, async () => {
    const p = makePage(kind, { data, me: {} });
    await vm.runInContext("planBadgePick('bogus')", p.ctx);
    assert.strictEqual(p.posts.length, 0);
    assert.strictEqual(p.store.m['mm-plan-badge'], undefined);
  });
}

// ── the chooser ──
for (const kind of KINDS) {
  const data = D([W(null, 40), W('fable', 22)], 70);
  const open = (o) => { const p = makePage(kind, Object.assign({ data }, o)); p.paint(); p.badge.dispatch('click'); return p; };
  test(`${kind}: pressing the badge opens a listbox of rows in order, the current one selected with a check, focus on it`, () => {
    const p = open();
    const box = p.chooser();
    assert.ok(box, 'chooser in the page');
    const list = box.find(e => e.getAttribute('role') === 'listbox')[0];
    assert.ok(list, 'role=listbox');
    const rows = p.rows();
    const W11 = whenOf(kind, '2026-11-30T20:00:00Z'), WF = whenOf(kind, '2026-11-27T01:00:00Z');
    assert.deepStrictEqual(rows.map(r => stripCheck(r.textContent)), [
      `Plan (all models) · 40% this week · resets ${W11}`,
      `Fable · 22% this week · resets ${W11}`,
      `5-hour window · 70% · resets ${WF}`,
    ]);
    assert.deepStrictEqual(rows.map(r => r.getAttribute('aria-selected')), ['true', 'false', 'false']);
    assert.ok(rows[0].textContent.startsWith('✓'), 'check mark on the current row');
    assert.ok(!rows[1].textContent.includes('✓'));
    assert.strictEqual(p.doc.activeElement, rows[0]);
    assert.strictEqual(p.badge.getAttribute('aria-expanded'), 'true');
    const subs = box.find(e => e.tag === 'button')[0];
    assert.strictEqual(subs.textContent, 'All subscriptions…');
    assert.ok(!list.contains(subs), 'a separate button below the list, not an option');
  });
  test(`${kind}: the row of the chosen window is the selected one; missing windows have no row; a used-up window says "used up"`, () => {
    const p = open({ data: D([W(null, 40), W('fable', 60, { rejected: true })]), local: { 'mm-plan-badge': 'family' } });
    const rows = p.rows();
    assert.strictEqual(rows.length, 2, 'no 5-hour reading, no row');
    assert.deepStrictEqual(rows.map(r => r.getAttribute('aria-selected')), ['false', 'true']);
    assert.ok(stripCheck(rows[1].textContent).startsWith('Fable · used up this week · resets '), rows[1].textContent);
    assert.strictEqual(p.doc.activeElement, rows[1]);
  });
  test(`${kind}: arrows move, Enter and Space pick, and picking closes the chooser and repaints`, async () => {
    const p = open();
    const rows = p.rows();
    const key = (k) => p.doc.activeElement.dispatch('keydown', { key: k });
    key('ArrowDown'); assert.strictEqual(p.doc.activeElement, rows[1]);
    key('ArrowDown'); assert.strictEqual(p.doc.activeElement, rows[2]);
    key('ArrowUp'); assert.strictEqual(p.doc.activeElement, rows[1]);
    const e = key('Enter');
    assert.ok(e.prevented);
    assert.strictEqual(p.chooser(), null, 'closed');
    assert.strictEqual(p.badge.textContent, 'Fable 22% this week · Plan 40% · 5h 70%', 'the plan is higher, so it joins; the 5h window is over 50');
    assert.strictEqual(p.doc.activeElement, p.badge, 'focus back on the badge');
    assert.strictEqual(p.badge.getAttribute('aria-expanded'), 'false');
    await tick();
    p.badge.dispatch('click');
    p.doc.activeElement.dispatch('keydown', { key: 'ArrowDown' });
    p.doc.activeElement.dispatch('keydown', { key: ' ' });
    assert.strictEqual(p.badge.textContent, '5h 70%');
    assert.deepStrictEqual(p.posts.map(x => x.body.planBadge), ['family', 'five']);
  });
  test(`${kind}: Esc closes and returns focus to the badge; a click outside closes without taking focus; pressing the badge again closes`, () => {
    let p = open();
    p.doc.activeElement.dispatch('keydown', { key: 'Escape' });
    assert.strictEqual(p.chooser(), null);
    assert.strictEqual(p.doc.activeElement, p.badge);
    assert.strictEqual(p.badge.getAttribute('aria-expanded'), 'false');
    assert.strictEqual(p.posts.length, 0, 'Esc picks nothing');
    p = open();
    const other = p.doc.createElement('div'); p.doc.body.appendChild(other); other.focus();
    other.dispatch('pointerdown');
    assert.strictEqual(p.chooser(), null);
    assert.strictEqual(p.doc.activeElement, other);
    p = open();
    p.badge.dispatch('pointerdown');
    assert.ok(p.chooser(), 'a press on the badge itself is not an outside click');
    p.badge.dispatch('click');
    assert.strictEqual(p.chooser(), null);
  });
  test(`${kind}: Tab goes to "All subscriptions…", then closes on leaving; the button opens the subscriptions`, () => {
    let p = open();
    const subs = p.chooser().find(e => e.tag === 'button')[0];
    const e = p.doc.activeElement.dispatch('keydown', { key: 'Tab' });
    assert.ok(e.prevented);
    assert.strictEqual(p.doc.activeElement, subs);
    p.doc.activeElement.dispatch('keydown', { key: 'Tab' });
    assert.strictEqual(p.chooser(), null);
    assert.strictEqual(p.doc.activeElement, p.badge);
    p = open();
    p.chooser().find(e2 => e2.tag === 'button')[0].dispatch('click');
    assert.strictEqual(p.opened.subs, 1);
    assert.strictEqual(p.opened.settings, 0, 'not the plan settings');
    assert.strictEqual(p.chooser(), null);
  });
  test(`${kind}: the chooser stays inside the window; the badge is not opened without a view`, () => {
    const p = open();
    const s = p.chooser().style;
    if (kind === 'desktop') {
      const left = parseFloat(s.left), top = parseFloat(s.top);
      assert.ok(left >= 8 && left + 300 <= 1000 - 8, 'inside horizontally: ' + s.left);
      assert.ok(top >= 40, 'below the badge: ' + s.top);
    } else {
      assert.strictEqual(s.left, '8px');
      assert.strictEqual(s.right, '8px');
    }
    const q = makePage(kind, { data: D([W('opus', 30)]) });
    q.paint(); q.badge.dispatch('click');
    assert.strictEqual(q.chooser(), null);
  });
}
test('desktop: the Codex badge stays a plain button that opens the subscriptions (no listbox)', () => {
  const src = read('app.js');
  const a = src.indexOf('function paintPlanBadges()');
  const body = src.slice(a, src.indexOf('async function openPlanSettings(', a));
  assert.ok(body.includes('el.onclick = () => openSubsSettings();'));
  assert.ok(body.includes("el.removeAttribute('aria-haspopup')"));
});

// ── the styles ──
test('CSS: the chooser uses the pages\' variables only (no raw colours) and has a visible focus ring; the phone rows are at least 36 px', () => {
  for (const [f, sel] of [['index.html', '.plan-chooser'], ['mobile.html', '.plan-chooser']]) {
    const css = read(f);
    const lines = css.split('\n').filter(l => l.includes(sel));
    assert.ok(lines.length >= 4, f + ': chooser rules present');
    const joined = lines.join('\n');
    assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(joined), f + ': no raw colours in the chooser rules: ' + joined);
    assert.ok(/focus-visible|\.pc-row:focus/.test(joined) && /outline/.test(joined), f + ': focus ring');
    // every row is drawn in the text colour (the tick marks the choice, no dimmed rows that look switched off)
    assert.ok(/var\(--bg-card\)/.test(joined) && /var\(--border\)/.test(joined) && /var\(--text\)/.test(joined) && /var\(--accent\)/.test(joined), f + ': surface, border, text, accent');
    assert.ok(!/\.pc-row\s*\{[^}]*var\(--text-dim\)/.test(joined), f + ': rows are not dimmed');
  }
  assert.ok(/\.plan-chooser \.pc-row[^{]*\{[^}]*min-height:\s*36px/.test(read('mobile.html')), 'phone row min-height 36px');
  // the phone badge's button reset (#chat-meta #chat-plan { color: inherit }) must not undo its warning colours: the
  // coloured states carry the same weight and come after it; the badge shows a picker arrow and is 36 px tall to tap
  const m = read('mobile.html');
  const resetAt = m.indexOf('#chat-meta #chat-plan {');
  for (const c of ['warn', 'hot', 'refused']) {
    const at = m.indexOf('#chat-meta #chat-plan.' + c);
    assert.ok(resetAt >= 0 && at > resetAt, 'phone ' + c + ' colour comes after the reset with the same weight');
  }
  assert.ok(/#chat-meta #chat-plan \{[^}]*min-height:\s*36px/.test(m), 'phone badge tap height 36px');
  assert.ok(/#chat-plan\[aria-haspopup\]::after\s*\{[^}]*content:\s*'\\25BE'/.test(m), 'phone badge arrow');
  assert.ok(/\.plan-badge\[aria-haspopup\]::after\s*\{[^}]*content:\s*'\\25BE'/.test(read('index.html')), 'desktop badge arrow');
  assert.ok(/#chat-plan\s*\{[^}]*background:\s*none/.test(read('mobile.html')) || /#chat-plan[^{]*\{[^}]*background:\s*none/.test(read('mobile.html')), 'phone button reset');
  assert.ok(/\.chat-actions \.plan-badge \{[^}]*background:\s*(none|transparent)/.test(read('index.html')), 'desktop button reset');
});

// ── review round 4: saves out of order, the safety rule for the 5h choice, a chooser that follows the badge ──
test('planBadgeView choice "five": a weekly window higher than the 5-hour one is added (rounded), the 5h rule for weekly main is unchanged', () => {
  assert.deepStrictEqual(kinds(L.planBadgeView(D([W(null, 40)], 5), 'fable', 'five', true, LV)), ['five', 'plan'], 'plan 40 over 5h 5, below the warning levels');
  assert.deepStrictEqual(kinds(L.planBadgeView(D([W(null, 40)], 5.4), 'fable', 'five', true, LV)), ['five', 'plan']);
  assert.deepStrictEqual(kinds(L.planBadgeView(D([W(null, 5.4)], 5.2), 'fable', 'five', true, LV)), ['five'], 'equal after rounding: not added');
  assert.deepStrictEqual(kinds(L.planBadgeView(D([W(null, 5), W('fable', 40)], 5), 'fable', 'five', true, LV)), ['five', 'family']);
  assert.deepStrictEqual(kinds(L.planBadgeView(D([W(null, 5)], 40), 'fable', 'plan', false, LV)), ['plan'], 'the 5h window is not added just for being higher');
  assert.deepStrictEqual(kinds(L.planBadgeView(D([W(null, 5)], 40), 'fable', 'plan', true, LV)), ['plan'], '40 is not over 50, so subscriptions on do not add it');
  assert.deepStrictEqual(kinds(L.planBadgeView(D([W(null, 5)], 60), 'fable', 'plan', true, LV)), ['plan', 'five'], 'over 50 with subscriptions on: the existing rule');
});
for (const kind of KINDS) {
  test(`${kind}: choice five at 5% with the plan at 40% shows both; choice plan 5% with five 40% and subscriptions off shows the plan alone`, () => {
    const p = makePage(kind, { data: D([W(null, 40)], 5), local: { 'mm-plan-badge': 'five' } });
    p.paint();
    assert.strictEqual(p.badge.textContent, '5h 5% · Plan 40%');
    const q = makePage(kind, { data: D([W(null, 5)], 40), local: { 'mm-plan-badge': 'plan' }, subs: false });
    q.paint();
    assert.strictEqual(q.badge.textContent, 'Plan 5% this week');
  });
  const held = (o) => {
    const resolvers = [];
    const p = makePage(kind, Object.assign({ data: D([W(null, 18), W('fable', 19)], 30), me: { planBadge: 'plan' }, hold: (post) => new Promise(res => resolvers.push({ post, res })) }, o));
    p.paint();
    return { p, resolvers };
  };
  const OK = { ok: true, status: 200, json: async () => ({}) }, BAD = { ok: false, status: 400, json: async () => ({}) };
  // the fake server: stores what each POST says, in the order the POSTs reach it
  const serve = (p, resolvers, answer) => { const stored = { v: 'plan' }; return { stored, settle: async (i, r) => { stored.v = resolvers[i].post.body.planBadge; resolvers[i].res(r || OK); await tick(); await tick(); } }; };
  test(`${kind}: pick family then five while the first is in flight: exactly two POSTs in order family, five; the stored value and the shown choice are five`, async () => {
    const { p, resolvers } = held();
    const s = serve(p, resolvers);
    vm.runInContext("planBadgePick('family')", p.ctx);
    vm.runInContext("planBadgePick('five')", p.ctx);
    await tick();
    assert.deepStrictEqual(resolvers.map(r => r.post.body.planBadge), ['family'], 'only one save in flight');
    assert.strictEqual(p.store.m['mm-plan-badge'], 'five', 'the device copy is the newest pick at once');
    assert.ok(p.badge.textContent.startsWith('5h '), 'repainted at once: ' + p.badge.textContent);
    await s.settle(0);
    assert.strictEqual(p.win.hubMe.planBadge, 'plan', 'an older value does not become the person value');
    assert.deepStrictEqual(resolvers.map(r => r.post.body.planBadge), ['family', 'five']);
    await s.settle(1);
    assert.deepStrictEqual(resolvers.map(r => r.post.body.planBadge), ['family', 'five'], 'nothing more to send');
    assert.strictEqual(s.stored.v, 'five');
    assert.strictEqual(p.win.hubMe.planBadge, 'five');
    assert.strictEqual(p.choice(), 'five');
    p.paint();
    assert.ok(p.badge.textContent.startsWith('5h '), p.badge.textContent);
  });
  test(`${kind}: three quick picks family, five, plan while the first is in flight: two POSTs, family then plan; the final value is plan`, async () => {
    const { p, resolvers } = held({ me: { planBadge: 'five' } });
    const s = serve(p, resolvers);
    vm.runInContext("planBadgePick('family')", p.ctx);
    vm.runInContext("planBadgePick('five')", p.ctx);
    vm.runInContext("planBadgePick('plan')", p.ctx);
    await s.settle(0);
    await s.settle(1);
    assert.deepStrictEqual(resolvers.map(r => r.post.body.planBadge), ['family', 'plan']);
    assert.strictEqual(s.stored.v, 'plan');
    assert.strictEqual(p.win.hubMe.planBadge, 'plan');
    assert.strictEqual(p.choice(), 'plan');
  });
  test(`${kind}: a pick equal to the value just sent is not sent again`, async () => {
    const { p, resolvers } = held();
    const s = serve(p, resolvers);
    vm.runInContext("planBadgePick('family')", p.ctx);
    vm.runInContext("planBadgePick('five')", p.ctx);
    vm.runInContext("planBadgePick('family')", p.ctx);
    await s.settle(0);
    assert.strictEqual(resolvers.length, 1);
    assert.strictEqual(p.win.hubMe.planBadge, 'family');
    assert.strictEqual(p.choice(), 'family');
  });
  test(`${kind}: the newest pick's save failing keeps the device copy of the newest pick; the older save's success does not become the person value`, async () => {
    const { p, resolvers } = held();
    vm.runInContext("planBadgePick('family')", p.ctx);
    vm.runInContext("planBadgePick('five')", p.ctx);
    resolvers[0].res(OK); await tick(); await tick();
    assert.strictEqual(resolvers.length, 2);
    resolvers[1].res(BAD); await tick(); await tick();
    assert.strictEqual(p.win.hubMe.planBadge, 'plan', 'the older answer did not touch the person value');
    assert.strictEqual(p.store.m['mm-plan-badge'], 'five');
    assert.strictEqual(p.choice(), 'five');
    p.paint();
    assert.ok(p.badge.textContent.startsWith('5h '), p.badge.textContent);
  });
  test(`${kind}: an open chooser follows a repaint to another model family: the row says Opus, not Fable`, () => {
    const p = makePage(kind, { data: D([W(null, 0), W('fable', 0)]) });
    p.paint(); p.badge.dispatch('click');
    assert.ok(stripCheck(p.rows()[1].textContent).startsWith('Fable · 0% this week'), p.rows()[1].textContent);
    if (kind === 'desktop') p.ctx.chatModelOf = () => 'claude-sdk/claude-opus-5'; else p.ctx.agentByName = () => ({ model: 'claude-sdk/claude-opus-5' });
    p.data = D([W(null, 0), W('opus', 0)]); p.paint();
    assert.ok(p.chooser(), 'still open');
    assert.ok(stripCheck(p.rows()[1].textContent).startsWith('Opus · 0% this week'), p.rows()[1].textContent);
  });
  test(`${kind}: an open chooser follows a repaint: rows rebuilt, focus on the same kind, still open; no view closes it`, () => {
    const p = makePage(kind, { data: D([W(null, 40), W('fable', 22)], 70) });
    p.paint(); p.badge.dispatch('click');
    const before = p.rows();
    assert.ok(stripCheck(before[0].textContent).includes('40% this week'));
    p.data = D([W(null, 40, { rejected: true }), W('fable', 22)], 70);
    p.paint();
    const rows = p.rows();
    assert.ok(p.chooser(), 'still open');
    assert.strictEqual(p.chooser().find(e => e.tag === 'button').length, 1, 'one All subscriptions… button');
    assert.ok(stripCheck(rows[0].textContent).includes('used up'), rows[0].textContent);
    assert.strictEqual(p.doc.activeElement, rows[0], 'focus on the Plan row');
    assert.strictEqual(p.badge.getAttribute('aria-expanded'), 'true');
    rows[1].focus();
    p.data = D([W(null, 41), W('fable', 23)], 70); p.paint();
    assert.strictEqual(p.doc.activeElement, p.rows()[1], 'focus stays on the family row');
    p.doc.activeElement.dispatch('keydown', { key: 'ArrowDown' });
    assert.strictEqual(p.doc.activeElement, p.rows()[2], 'the rebuilt rows take keys');
    p.data = D([W(null, 41), W('fable', 23)], null); p.paint();
    assert.strictEqual(p.rows().length, 2, 'the 5h row is gone');
    assert.ok(p.doc.activeElement && p.rows().some(r => r === p.doc.activeElement), 'focus moved to a row that exists');
    p.data = D([W('opus', 30)]); p.paint();
    assert.strictEqual(p.chooser(), null, 'no view: closed');
    assert.notStrictEqual(p.doc.activeElement, p.badge, 'focus not moved to a hidden badge');
  });
}
