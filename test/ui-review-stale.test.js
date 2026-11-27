'use strict';
// P4 r5: a failed read keeps the last result's items (stale), no-accounts installs get the banner, readiness rows are dropped only when their own
// source supplied them, critical is always Fix now, and a failed check is never "Nothing to fix". Offline; page functions cut out of app.js / mobile.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const R = require('../lib/ui-review.js');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);
const item = (id, level, extra) => ({ id, level, title: `Title ${id}`, detail: `Detail of ${id}. More words.`, ...(extra || {}) });

// ---- 1. a failed read keeps the last result ---------------------------------------------------------------------------------------
test('a failed read keeps that source\'s items from the last result, marked stale; the other sources stay current', () => {
  const full = {
    readiness: { items: [item('docker', 'critical')] }, health: { items: [item('health-disk', 'critical')] }, security: { items: [item('bind', 'critical')] },
    setup: { setupNeeded: true }, backups: { key: { configured: true }, nightly: {}, recovery: { restoredFrom: 5 } },
  };
  const prev = R.build({ ...full, now: NOW });
  assert.strictEqual(prev.count, 5);
  for (const [k, id] of [['health', 'health:health-disk'], ['readiness', 'ready:docker'], ['security', 'sec:bind'], ['backups', 'backup:paused'], ['setup', 'provider']]) {
    const input = { ...full, [k]: null, failed: [k], previous: prev, now: NOW + 1000 };
    const r = R.build(input);
    const p = r.problems.find((x) => x.id === id);
    assert.ok(p, `${id} kept when ${k} failed`);
    assert.strictEqual(p.stale, true, `${id} stale`);
    assert.match(p.text, /Could not check just now; this was the last result\./);
    assert.strictEqual(r.count, 5, `the count does not drop when ${k} failed`);
    assert.strictEqual(R.bannerOf(r).count, 5);
    assert.deepStrictEqual(r.notes, [`Could not check ${{ health: 'the health check', readiness: 'the setup checklist', security: 'the security check', backups: 'the backups', setup: 'whether an AI provider is connected' }[k]}.`]);
    assert.strictEqual(r.problems.filter((x) => x.stale).length, 1, 'only the failed source is stale');
  }
});

test('a stale item stays stale (one note in its text) over several failed reads, and is gone once the read works and says it is fixed', () => {
  const prev = R.build({ health: { items: [item('health-disk', 'critical')] }, now: NOW });
  const r1 = R.build({ failed: ['health'], previous: prev, now: NOW + 1 });
  const r2 = R.build({ failed: ['health'], previous: r1, now: NOW + 2 });
  assert.strictEqual(r2.problems[0].text.split('Could not check just now').length, 2);
  assert.strictEqual(r2.count, 1);
  assert.strictEqual(R.build({ health: { items: [] }, previous: r2, now: NOW + 3 }).count, 0);
});

test('a first-read failure (no earlier result) shows only the note: no count, no banner', () => {
  const r = R.build({ failed: ['health', 'security'], previous: null, now: NOW });
  assert.deepStrictEqual([r.count, r.problems.length, R.bannerOf(r), R.badgeKind(r), R.gearLabel(r)], [0, 0, null, '', 'Settings']);
  assert.strictEqual(r.notes.length, 2);
});

test('a registered source that failed keeps its last items (stale); a source that answers replaces them', () => {
  const answer = [{ id: 'mod', problems: [{ id: 'mod:a', title: 'Module trouble', tier: 'fix', level: 'critical', text: 'Bad.' }] }];
  const prev = R.merge(R.build({ now: NOW }), answer, null);
  assert.strictEqual(prev.count, 1);
  const r = R.merge(R.build({ now: NOW + 1, previous: prev }), [{ id: 'mod', failed: true }], prev);
  assert.deepStrictEqual([r.count, r.problems[0].stale, r.notes], [1, true, ['Could not check mod.']]);
  const r2 = R.merge(R.build({ now: NOW + 2, previous: r }), [{ id: 'mod', failed: true }], r);
  assert.strictEqual(r2.count, 1, 'and again');
  assert.strictEqual(R.merge(R.build({ now: NOW + 3 }), [{ id: 'mod', problems: [] }], r).count, 0);
  assert.strictEqual(R.merge(R.build({ now: NOW }), [{ id: 'mod', failed: true }], null).count, 0, 'no earlier result: nothing to keep');
});

// ---- 3. readiness rows dropped only when their source supplied them ----------------------------------------------------------------
test('readiness drops provider and health-* rows only when setup / system-health supplied the matching row in this build', () => {
  const rd = { items: [item('provider', 'critical', { title: 'No AI provider configured' }), item('health-disk', 'warn'), item('health-mem', 'critical')] };
  // sources answered with the rows: no double listing
  let r = R.build({ readiness: rd, setup: { setupNeeded: true }, health: { items: [item('health-disk', 'warn'), item('health-mem', 'critical')] }, now: NOW });
  assert.deepStrictEqual(r.problems.map((p) => p.id).sort(), ['health:health-disk', 'health:health-mem', 'provider']);
  // sources failed (null): the readiness rows stay, with their tier
  r = R.build({ readiness: rd, setup: null, health: null, failed: ['setup', 'health'], now: NOW });
  assert.deepStrictEqual(r.problems.map((p) => [p.id, p.tier]).sort(), [['ready:health-disk', 'worth'], ['ready:health-mem', 'fix'], ['ready:provider', 'fix']]);
  assert.strictEqual(r.count, 2);
  // sources answered without that row: the readiness row stays
  r = R.build({ readiness: rd, setup: { setupNeeded: false }, health: { items: [item('health-disk', 'ok')] }, now: NOW });
  assert.deepStrictEqual(r.problems.map((p) => p.id).sort(), ['ready:health-disk', 'ready:health-mem', 'ready:provider']);
  // health supplied one of the two
  r = R.build({ readiness: rd, setup: { setupNeeded: true }, health: { items: [item('health-mem', 'critical')] }, now: NOW });
  assert.deepStrictEqual(r.problems.map((p) => p.id).sort(), ['health:health-mem', 'provider', 'ready:health-disk']);
});

test('a failed source whose last items are carried is listed once with the fresh readiness row (fresh beats stale)', () => {
  const rd = { items: [item('provider', 'critical')] };
  const prev = R.build({ readiness: rd, setup: { setupNeeded: true }, now: NOW });
  const r = R.build({ readiness: rd, setup: null, failed: ['setup'], previous: prev, now: NOW + 1 });
  assert.deepStrictEqual(r.problems.map((p) => p.id), ['ready:provider']);
  assert.notStrictEqual(r.problems[0].stale, true);
  // the readiness read has nothing about the provider: the carried one stays
  const r2 = R.build({ readiness: { items: [] }, setup: null, failed: ['setup'], previous: prev, now: NOW + 1 });
  assert.deepStrictEqual(r2.problems.map((p) => [p.id, p.stale]), [['provider', true]]);
});

// ---- P4 r6: one item per condition: fresh beats stale, then the higher severity; a source critical with no tier is Fix now -------------
test('r6 health: a carried stale health:health-disk (warn) loses to the fresh ready:health-disk (critical); never drops a fresh critical', () => {
  const prev = R.build({ health: { items: [item('health-disk', 'warn')] }, now: NOW });
  assert.strictEqual(prev.problems[0].id, 'health:health-disk');
  const r = R.build({ readiness: { items: [item('health-disk', 'critical')] }, health: null, failed: ['health'], previous: prev, now: NOW + 1 });
  assert.deepStrictEqual(r.problems.map((p) => [p.id, p.tier, p.stale === true]), [['ready:health-disk', 'fix', false]]);
  assert.strictEqual(r.count, 1);
});

test('r6 health: both fresh: the higher severity wins, whichever source it came from; equal ones list the health row once', () => {
  let r = R.build({ readiness: { items: [item('health-disk', 'critical')] }, health: { items: [item('health-disk', 'warn')] }, now: NOW });
  assert.deepStrictEqual(r.problems.map((p) => [p.id, p.tier]), [['ready:health-disk', 'fix']]);
  r = R.build({ readiness: { items: [item('health-disk', 'warn')] }, health: { items: [item('health-disk', 'critical')] }, now: NOW });
  assert.deepStrictEqual(r.problems.map((p) => [p.id, p.tier]), [['health:health-disk', 'fix']]);
  r = R.build({ readiness: { items: [item('health-disk', 'critical')] }, health: { items: [item('health-disk', 'critical')] }, now: NOW });
  assert.deepStrictEqual(r.problems.map((p) => p.id), ['health:health-disk']);
});

test('r6 reverse: a stale carried ready:health-* / ready:provider does not sit next to the fresh health:* / provider', () => {
  const prev = R.build({ readiness: { items: [item('health-disk', 'warn'), item('provider', 'critical')] }, now: NOW });
  const r = R.build({ readiness: null, health: { items: [item('health-disk', 'warn')] }, setup: { setupNeeded: true }, failed: ['readiness'], previous: prev, now: NOW + 1 });
  assert.deepStrictEqual(r.problems.map((p) => [p.id, p.stale === true]).sort(), [['health:health-disk', false], ['provider', false]]);
});

test('r6 merge: a source critical item with no tier is Fix now (counts); a warn one is Worth doing', () => {
  const r = R.merge(R.build({ now: NOW }), [{ id: 's', problems: [{ id: 's:1', title: 'Red', level: 'critical' }, { id: 's:2', title: 'Amber', level: 'warn' }, { id: 's:3', title: 'None' }] }]);
  assert.deepStrictEqual(r.problems.map((p) => [p.id, p.tier]), [['s:1', 'fix'], ['s:2', 'worth'], ['s:3', 'worth']]);
  assert.strictEqual(r.count, 1);
});

// ---- 4 and 5. critical is always Fix now ------------------------------------------------------------------------------------------
test('a critical item is always Fix now, two-factor and setup advice included; only a warning is worth doing / a suggestion', () => {
  const tier = (src, id, lvl) => {
    const input = src === 'sec' ? { security: { items: [item(id, lvl)] } } : { readiness: { items: [item(id, lvl)] } };
    const p = R.build({ ...input, now: NOW }).problems[0];
    return p ? p.tier : '';
  };
  for (const id of ['totp', 'admin-2fa-optional', 'member-totp']) {
    assert.strictEqual(tier('sec', id, 'critical'), 'fix', `sec ${id} critical`);
    assert.strictEqual(tier('sec', id, 'warn'), 'worth', `sec ${id} warn`);
  }
  assert.strictEqual(tier('ready', 'totp', 'critical'), 'fix');
  for (const id of ['search', 'push-devices', 'supervisor', 'browser-render']) {
    assert.strictEqual(tier('ready', id, 'critical'), 'fix', `ready ${id} critical`);
    assert.strictEqual(tier('ready', id, 'warn'), 'suggest', `ready ${id} warn`);
  }
});

// ---- 6. a failed check is not "Nothing to fix" -------------------------------------------------------------------------------------
test('summary: count 0 with a failed check says "Could not check everything", not "Nothing to fix"; a real count still leads', () => {
  const r = R.build({ failed: ['security'], now: NOW });
  assert.strictEqual(R.summaryText(r), 'Could not check everything');
  assert.strictEqual(R.summaryText(R.build({ failed: ['security'], changes: { changes: [{ id: 'a', state: 'pending', title: 'A' }] }, now: NOW })), 'Could not check everything · 1 new feature');
  assert.strictEqual(R.summaryText(R.build({ now: NOW })), 'Nothing to fix');
  assert.strictEqual(R.summaryText(R.build({ failed: ['security'], health: { items: [item('health-x', 'critical')] }, now: NOW })), '1 to fix');
});
test('the Simple lines (desktop and phone) use the review summary, so they say it too', () => {
  const app = read('app.js'), mob = read('mobile.js');
  const at = app.indexOf('function simpleReviewText(r) {');
  const text = new Function('window', `${app.slice(at, app.indexOf('\n    }', at) + 6)}; return simpleReviewText;`)({ hubReview: R });
  assert.strictEqual(text(R.build({ failed: ['health'], now: NOW })), 'Could not check everything');
  assert.match(mob, /window\.hubReview\.summaryText\(r\)/);
});

// ---- pages ------------------------------------------------------------------------------------------------------------------------
function cut(src, from, to) {
  const a = src.indexOf(from), b = src.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `found ${from}`);
  return src.slice(a, b);
}
const escHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function makeEl(doc, id) {
  const el = { id, _cls: new Set(), attrs: {}, children: [], textContent: '', innerHTML: '', title: '', hidden: false, listeners: {}, style: {}, dataset: {} };
  el.classList = { add: (c) => el._cls.add(c), remove: (c) => el._cls.delete(c), contains: (c) => el._cls.has(c), toggle: (c, on) => { if (on) el._cls.add(c); else el._cls.delete(c); } };
  Object.defineProperty(el, 'className', { get: () => [...el._cls].join(' '), set: (v) => { el._cls = new Set(String(v).split(/\s+/).filter(Boolean)); } });
  el.setAttribute = (k, v) => { el.attrs[k] = String(v); };
  el.getAttribute = (k) => (k in el.attrs ? el.attrs[k] : null);
  el.removeAttribute = (k) => { delete el.attrs[k]; };
  el.appendChild = (c) => { el.children.push(c); if (c.id) doc.byId[c.id] = c; return c; };
  el.remove = () => { if (el.id && doc.byId[el.id] === el) delete doc.byId[el.id]; el.removed = true; };
  el.addEventListener = (t, fn) => { (el.listeners[t] = el.listeners[t] || []).push(fn); };
  el.querySelectorAll = () => [];
  el.querySelector = () => null;
  return el;
}
function makeDoc(ids) {
  const doc = { byId: {}, listeners: {} };
  doc.getElementById = (id) => doc.byId[id] || null;
  doc.createElement = () => makeEl(doc, '');
  doc.addEventListener = () => {};
  doc.body = { prepend: (el) => { if (el.id) doc.byId[el.id] = el; } };
  doc.documentElement = { classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } } };
  for (const id of ids) doc.byId[id] = makeEl(doc, id);
  return doc;
}
const answers = (o) => ({
  '/api/readiness': { items: [] }, '/api/system-health': { items: [] }, '/api/security-check': { ok: true, items: [] }, '/api/setup/status': { setupNeeded: false },
  '/api/backups': { key: { configured: true }, nightly: {} }, '/api/behaviour-changes': { changes: [] }, ...(o || {}),
});
const stubFetch = (st) => async (url) => { const b = st.responses[url]; return b === undefined ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, status: 200, json: async () => b }; };
function desktop() {
  const src = cut(read('app.js'), '// ── For your review (lib/ui-review.js)', '// The ⓘ help (lib/ui-settings-help.js)');
  const doc = makeDoc(['settings-btn', 'st-review-list', 'st-sum-review']);
  const st = { me: { isAdmin: true, user: { id: 'u1' } }, responses: answers(), store: {}, noAccounts: false };
  const storage = { getItem: (k) => (k in st.store ? st.store[k] : null), setItem: (k, v) => { st.store[k] = String(v); } };
  const factory = new Function('window', 'document', 'fetch', 'localStorage', 'esc', 'stSum', 'stOpenGroup', 'stReveal', 'securityActionHtml', 'readinessActionHtml', 'ClaudeSignin', 'layoutBanners', 'openReviewAt',
    `${src}\nreturn { reviewRefresh, get last() { return reviewLast; } };`);
  const win = { hubReview: R, get hubMe() { return st.me; }, get hubNoAccounts() { return st.noAccounts; } };
  const api = factory(win, doc, stubFetch(st), storage, escHtml, () => {}, () => {}, () => {},
    (a) => `<sec-fix>${escHtml(a.label)}</sec-fix>`, (a) => `<ready-fix>${escHtml(a.label)}${a.href ? ` href=${a.href}` : ''}</ready-fix>`, undefined, () => {}, () => {});
  return { api, doc, st };
}
function phone(me) {
  const src = cut(read('mobile.js'), "// ── The count of things for the owner's review (lib/ui-review.js)", '// ── review count (end) ──');
  const doc = makeDoc(['menu-settings', 'agents-menu-btn', 'chat-menu-btn', 'review-banner']);
  const st = { responses: answers(), store: {} };
  const storage = { getItem: (k) => (k in st.store ? st.store[k] : null), setItem: (k, v) => { st.store[k] = String(v); } };
  const factory = new Function('window', 'document', 'fetch', 'localStorage', '$', 'hubMe', 'setInterval', 'esc', 'api', 'settingsSheetOpen', 'ClaudeSignin',
    `${src}\nreturn { reviewRefresh, get last() { return reviewLastResult; } };`);
  const api = factory({ hubReview: R }, doc, stubFetch(st), storage, (id) => doc.getElementById(id), me, () => 0, escHtml, async () => ({ ok: true }), () => {}, undefined);
  return { api, doc, st };
}

test('desktop: a failed read keeps the banner, the count and Fix now; a first read that fails shows no banner', async () => {
  const d = desktop();
  d.st.responses = answers({ '/api/system-health': { items: [item('health-disk', 'critical', { title: 'The disk is full' })] } });
  await d.api.reviewRefresh();
  assert.match(d.doc.getElementById('hub-review-banner').innerHTML, /The disk is full\./);
  delete d.st.responses['/api/system-health'];   // the read fails now
  await d.api.reviewRefresh();
  const bar = d.doc.getElementById('hub-review-banner');
  assert.ok(bar, 'the banner stays');
  assert.match(bar.innerHTML, /The disk is full\./);
  assert.strictEqual(d.api.last.count, 1);
  assert.match(d.doc.getElementById('st-review-list').innerHTML, /Could not check the health check\.[\s\S]*The disk is full[\s\S]*Could not check just now; this was the last result\./);
  assert.match(d.doc.getElementById('settings-btn').attrs['aria-label'], /1 thing to fix/);
  const first = desktop();
  first.st.responses = answers();
  delete first.st.responses['/api/system-health'];
  await first.api.reviewRefresh();
  assert.strictEqual(first.doc.getElementById('hub-review-banner'), null);
  assert.strictEqual(first.api.last.count, 0);
});

test('desktop: the stale text is escaped in the list', async () => {
  const d = desktop();
  d.st.responses = answers({ '/api/system-health': { items: [item('health-x', 'critical', { title: '<img src=x>', detail: 'Bad <b>tag</b>.' })] } });
  await d.api.reviewRefresh();
  delete d.st.responses['/api/system-health'];
  await d.api.reviewRefresh();
  const h = d.doc.getElementById('st-review-list').innerHTML;
  assert.doesNotMatch(h, /<img|<b>/);
  assert.match(h, /&lt;img src=x&gt;/);
});

test('phone: a failed read keeps the banner and the count', async () => {
  const p = phone({ isAdmin: true, user: { id: 'u1' } });
  p.st.responses = answers({ '/api/system-health': { items: [item('health-disk', 'critical', { title: 'The disk is full' })] } });
  await p.api.reviewRefresh();
  delete p.st.responses['/api/system-health'];
  await p.api.reviewRefresh();
  const bar = p.doc.getElementById('review-banner');
  assert.strictEqual(bar.hidden, false);
  assert.match(bar.innerHTML, /The disk is full\./);
  assert.strictEqual(p.api.last.count, 1);
  assert.strictEqual(p.doc.getElementById('menu-settings-count').textContent, '1');
});

// ---- 2. an install with no accounts --------------------------------------------------------------------------------------------------
test('desktop: /api/me says accounts:false with no user -> the banner with the Welcome link', async () => {
  const d = desktop();
  d.st.me = { accounts: false, user: null, isAdmin: true };
  await d.api.reviewRefresh();
  const bar = d.doc.getElementById('hub-review-banner');
  assert.ok(bar, 'banner shown');
  assert.match(bar.innerHTML, /This hub has no login yet\.<\/span>/);
  assert.match(bar.innerHTML, /<ready-fix>Create the admin account href=\/welcome<\/ready-fix>/);
  assert.deepStrictEqual(d.api.last.problems.map((p) => p.id), ['accounts'], 'only the no-login item');
  assert.match(d.doc.getElementById('settings-btn').attrs['aria-label'], /1 thing to fix/);
});

test('phone: hubMe accounts:false with no user -> the banner with the Welcome link and the count', async () => {
  const p = phone({ accounts: false, user: null });
  await p.api.reviewRefresh();
  const bar = p.doc.getElementById('review-banner');
  assert.strictEqual(bar.hidden, false);
  assert.match(bar.innerHTML, /This hub has no login yet\./);
  assert.match(bar.innerHTML, /<a href="\/welcome" class="rvb-fix">Create the admin account<\/a>/);
  assert.deepStrictEqual(p.api.last.problems.map((x) => x.id), ['accounts']);
  const none = phone({ isAdmin: false, user: { id: 'u2' } });
  await none.api.reviewRefresh();
  assert.strictEqual(none.doc.getElementById('review-banner').hidden, true);
});
