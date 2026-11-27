'use strict';
// "For your review" and the count on the gear (P4-4B): the pure module lib/ui-review.js (every rule), then the pages: the review
// group's blocks, the buttons' requests, the calm line, the gear badge and the phone menu count. The page functions are cut out of
// app.js / mobile.js and run against small stubs (no browser, no hub). Offline.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const R = require('../lib/ui-review.js');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);
const DAY = 24 * 3600 * 1000;
const item = (id, level, extra) => ({ id, level, title: `Title ${id}`, detail: `Detail of ${id}. More words.`, ...(extra || {}) });
const pending = (id, extra) => ({ id, state: 'pending', title: `Feature ${id}`, changes: `What ${id} changes. And a second sentence.`, ...(extra || {}) });

test('nothing to review: no problems, no features, count 0, worst none', () => {
  const r = R.build({ readiness: { items: [item('a', 'ok'), item('b', 'info')] }, health: { items: [] }, security: { items: [item('s', 'info')] }, setup: { setupNeeded: false }, backups: null, changes: { changes: [{ id: 'x', state: 'on' }] }, now: NOW });
  assert.deepStrictEqual([r.problems, r.features, r.count, r.worst, r.notes], [[], [], 0, 'none', []]);
  assert.deepStrictEqual(R.build({}).count, 0);
  assert.strictEqual(R.summaryText(r), 'Nothing waiting');
  assert.strictEqual(R.badgeKind(r), '');
  assert.strictEqual(R.gearLabel(r), 'Settings');
});

test('readiness: critical and warn are problems (critical first), ok and info are not; items other rules cover are not counted twice', () => {
  const r = R.build({ readiness: { items: [item('w', 'warn', { action: { label: 'Fix it', api: '/api/x', method: 'POST' } }), item('c', 'critical', { action: { label: 'Open', href: '/somewhere' } }), item('i', 'info'), item('ok', 'ok'), item('accounts', 'critical'), item('provider', 'critical'), item('health-disk', 'critical')] }, now: NOW });
  assert.deepStrictEqual(r.problems.map((p) => [p.id, p.level]), [['ready:c', 'critical'], ['ready:w', 'warn']]);
  assert.deepStrictEqual(r.problems[0].fix, { label: 'Open', href: '/somewhere' });
  assert.deepStrictEqual(r.problems[1].fix, { label: 'Fix it', api: '/api/x', method: 'POST' });
  assert.strictEqual(r.problems[0].text, 'Detail of c.', 'one plain sentence');
  assert.strictEqual(r.problems[0].detailsSection, 'st-ready-section');
  assert.deepStrictEqual([r.count, r.worst], [2, 'critical']);
});

test('health: warn and critical count; the Claude sign-in item gets the sign-in fix', () => {
  const r = R.build({ health: { items: [item('disk', 'warn'), item('health-signin-claude', 'critical', { action: 'claude-signin' }), item('fine', 'ok')] }, now: NOW });
  assert.deepStrictEqual(r.problems.map((p) => p.id), ['health:health-signin-claude', 'health:disk']);
  assert.deepStrictEqual(r.problems[0].fix, { label: 'Sign in again', kind: 'claude-signin' });
  assert.strictEqual(r.problems[1].detailsSection, 'st-health-section');
  assert.strictEqual(r.worst, 'critical');
});

test('security: warn and critical count, the one-click fix is kept, no-accounts has its own line', () => {
  const sec = { items: [item('modes', 'warn', { action: { label: 'Tighten', api: '/api/security-check/fix-modes', method: 'POST' } }), item('accounts', 'critical'), item('note', 'info')] };
  const r = R.build({ security: sec, now: NOW });
  assert.deepStrictEqual(r.problems.map((p) => p.id), ['sec:modes']);
  assert.deepStrictEqual(r.problems[0].fix, { label: 'Tighten', api: '/api/security-check/fix-modes', method: 'POST' });
  assert.strictEqual(r.problems[0].detailsSection, 'st-sec-section');
  assert.strictEqual(r.worst, 'warn');
});

test('security warnings dismissed in this browser stop counting; a changed set and a critical finding always count', () => {
  const warns = { items: [item('b', 'warn'), item('a', 'warn')] };
  assert.strictEqual(R.securityWarnKey(warns.items), 'a,b');
  assert.strictEqual(R.build({ security: warns, securityDismissed: 'a,b', now: NOW }).count, 0, 'dismissed');
  assert.strictEqual(R.build({ security: warns, securityDismissed: 'a', now: NOW }).count, 2, 'the set changed: they count again');
  assert.strictEqual(R.build({ security: warns, securityDismissed: '', now: NOW }).count, 2);
  const withCrit = { items: [item('b', 'warn'), item('a', 'warn'), item('z', 'critical')] };
  const r = R.build({ security: withCrit, securityDismissed: 'a,b', now: NOW });
  assert.deepStrictEqual(r.problems.map((p) => p.id), ['sec:z'], 'the critical one is never hidden; the dismissed warnings stay hidden');
});

test('no AI provider and no accounts are critical problems with a link to the Welcome page', () => {
  const r = R.build({ setup: { setupNeeded: true }, accounts: { none: true }, now: NOW });
  assert.deepStrictEqual(r.problems.map((p) => [p.id, p.level, p.fix.href]), [['accounts', 'critical', '/welcome'], ['provider', 'critical', '/welcome']]);
  assert.strictEqual(R.build({ setup: { setupNeeded: false }, accounts: { none: false }, now: NOW }).count, 0);
});

test('backups: a paused restore, a failed backup and a failed nightly backup are problems; backups off is not', () => {
  const ok = { key: { configured: true }, nightly: {} };
  assert.strictEqual(R.build({ backups: ok, now: NOW }).count, 0);
  assert.strictEqual(R.build({ backups: { key: { configured: false }, lastError: { message: 'x' } }, now: NOW }).count, 0, 'off is a choice');
  const paused = R.build({ backups: { ...ok, recovery: { restoredFrom: 1 } }, now: NOW });
  assert.deepStrictEqual(paused.problems.map((p) => [p.id, p.fix && p.fix.api]), [['backup:paused', '/api/backups/recovery/resume']]);
  assert.strictEqual(R.build({ backups: { ...ok, recovery: { resumedAt: 5 } }, now: NOW }).count, 0, 'resumed');
  const failed = R.build({ backups: { ...ok, lastError: { message: 'Disk full. Free some space.' } }, now: NOW });
  assert.deepStrictEqual([failed.problems[0].id, failed.problems[0].text, failed.problems[0].detailsSection], ['backup:failed', 'Disk full.', 'st-backups-section']);
  assert.strictEqual(R.build({ backups: { ...ok, lastError: { message: 'x' }, running: { step: 'a' } }, now: NOW }).count, 0, 'not while one is running');
  assert.strictEqual(R.build({ backups: { ...ok, nightly: { lastError: { message: 'x' } } }, now: NOW }).problems[0].id, 'backup:nightly');
});

test('features: pending behaviour changes only; a snoozed one is listed but not counted; it counts again once the time has passed', () => {
  const changes = { changes: [pending('one'), pending('two', { snoozedUntil: NOW + 3 * DAY }), pending('three', { snoozedUntil: NOW - 1 }), { id: 'four', state: 'on', title: 'Four' }, { id: 'five', state: 'off', title: 'Five' }] };
  const r = R.build({ changes, now: NOW });
  assert.deepStrictEqual(r.features.map((f) => [f.id, f.snoozed]), [['one', false], ['two', true], ['three', false]]);
  assert.strictEqual(r.features[1].snoozedUntil, NOW + 3 * DAY);
  assert.strictEqual(r.features[0].text, 'What one changes.', 'one line from the entry');
  assert.strictEqual(r.features[0].title, 'Feature one');
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.worst, 'none', 'features never raise the worst level');
  assert.strictEqual(R.badgeKind(r), 'info');
  assert.strictEqual(R.summaryText(r), '2 new features');
  assert.strictEqual(R.build({ changes: { changes: [pending('a', { snoozedUntil: NOW + DAY })] }, now: NOW }).count, 0);
  assert.strictEqual(R.summaryText(R.build({ changes: { changes: [pending('a', { snoozedUntil: NOW + DAY })] }, now: NOW })), 'Nothing waiting');
});

test('count = problems + features that are not snoozed; worst follows the problems; the words and the colour kind', () => {
  const r = R.build({ readiness: { items: [item('w', 'warn')] }, health: { items: [item('h', 'critical')] }, changes: { changes: [pending('a'), pending('b', { snoozedUntil: NOW + DAY })] }, now: NOW });
  assert.deepStrictEqual([r.count, r.worst, R.badgeKind(r)], [3, 'critical', 'critical']);
  assert.strictEqual(R.summaryText(r), '2 problems · 1 new feature');
  assert.strictEqual(R.gearLabel(r), 'Settings, 3 things for your review');
  const w = R.build({ readiness: { items: [item('w', 'warn')] }, now: NOW });
  assert.deepStrictEqual([w.count, w.worst, R.badgeKind(w), R.summaryText(w), R.gearLabel(w)], [1, 'warn', 'warn', '1 problem', 'Settings, 1 thing for your review']);
});

test('a failed read says "Could not check <what>." and counts nothing for it', () => {
  const r = R.build({ readiness: null, security: { items: [item('s', 'warn')] }, failed: ['readiness', 'backups', 'changes'], now: NOW });
  assert.deepStrictEqual(r.notes, ['Could not check the setup checklist.', 'Could not check the backups.', 'Could not check the new features waiting.']);
  assert.strictEqual(r.count, 1);
});

test('load(): every read fails on its own and the rest still arrive; the answers carry through to build()', async () => {
  const calls = [];
  const answers = {
    '/api/readiness': { items: [item('w', 'warn')] }, '/api/system-health': null, '/api/security-check': { ok: false },
    '/api/setup/status': { setupNeeded: true }, '/api/backups': { key: { configured: true } }, '/api/behaviour-changes': { changes: [pending('a')] },
  };
  const fetchFn = async (url, opts) => {
    calls.push([url, opts && opts.credentials]);
    if (url === '/api/system-health') throw new Error('offline');
    if (url === '/api/backups') return { ok: false, status: 403, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => answers[url] };
  };
  const input = await R.load(fetchFn, { accounts: { none: false } });
  assert.deepStrictEqual(calls.map((c) => c[0]).sort(), Object.keys(R.ROUTES).map((k) => R.ROUTES[k]).sort());
  assert.ok(calls.every((c) => c[1] === 'include'));
  assert.deepStrictEqual(input.failed, ['backups', 'health', 'security']);
  const r = R.build({ ...input, now: NOW });
  assert.deepStrictEqual(r.problems.map((p) => p.id), ['provider', 'ready:w']);
  assert.strictEqual(r.features.length, 1);
  assert.deepStrictEqual(r.notes, ['Could not check the backups.', 'Could not check the health check.', 'Could not check the security check.']);
});

test('the words after a choice: Turned on. / Left off. / We\'ll ask again on <date>.', () => {
  assert.strictEqual(R.decisionLine('on'), 'Turned on.');
  assert.strictEqual(R.decisionLine('off'), 'Left off.');
  const at = Date.UTC(2026, 11, 3, 12, 0, 0);
  assert.strictEqual(R.decisionLine('later', at, 'en-US'), "We'll ask again on December 3.");
  assert.strictEqual(R.askedAgainLine(at, 'en-US'), 'Asked again on December 3');
  assert.strictEqual(R.SNOOZE_MS, 7 * DAY);
});

test('the module is served, loaded by both pages before app.js / mobile.js, and has no variation selector or zero-width character', () => {
  assert.strictEqual(require('../lib/static-files').ALIASES.get('ui-review.js'), 'lib/ui-review.js');
  for (const [page, js] of [['index.html', 'app.js'], ['mobile.html', 'mobile.js']]) {
    const html = read(page);
    const at = html.indexOf('<script src="/ui-review.js"></script>');
    assert.ok(at > 0, `${page} loads it`);
    assert.ok(html.indexOf(`<script src="${js}"`) > at, `${page}: before ${js}`);
  }
  const bad = new RegExp(`[${String.fromCharCode(0xFE0F, 0x200B, 0x200C, 0x200D, 0x2060)}]`);
  for (const f of ['lib/ui-review.js', 'test/ui-review.test.js']) assert.doesNotMatch(read(f), bad, f);
  assert.doesNotMatch(read('lib/ui-review.js'), /\bfetch\(/, 'build is pure; only load() gets a fetch function passed in');
});

// ---- the pages: functions cut out of the source and run against stubs ----------------------------------------------------------
function cut(src, from, to) {
  const a = src.indexOf(from), b = src.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `found ${from}`);
  return src.slice(a, b);
}
const escHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function classListOf(el) {
  return { add: (c) => el._cls.add(c), remove: (c) => el._cls.delete(c), contains: (c) => el._cls.has(c), toggle: (c, on) => { if (on) el._cls.add(c); else el._cls.delete(c); } };
}
function makeEl(doc, id) {
  const el = { id, _cls: new Set(), attrs: {}, children: [], textContent: '', innerHTML: '', title: '', hidden: false, listeners: {} };
  el.classList = classListOf(el);
  Object.defineProperty(el, 'className', { get: () => [...el._cls].join(' '), set: (v) => { el._cls = new Set(String(v).split(/\s+/).filter(Boolean)); el.classList = classListOf(el); } });
  el.setAttribute = (k, v) => { el.attrs[k] = String(v); };
  el.getAttribute = (k) => (k in el.attrs ? el.attrs[k] : null);
  el.removeAttribute = (k) => { delete el.attrs[k]; };
  el.appendChild = (c) => { el.children.push(c); if (c.id) doc.byId[c.id] = c; return c; };
  el.remove = () => { if (el.id && doc.byId[el.id] === el) delete doc.byId[el.id]; };
  el.addEventListener = (t, fn) => { (el.listeners[t] = el.listeners[t] || []).push(fn); };
  el.querySelectorAll = () => [];
  el.querySelector = () => null;
  return el;
}
function makeDoc(ids) {
  const doc = { byId: {}, hiddenFlag: false, listeners: {} };
  doc.getElementById = (id) => doc.byId[id] || null;
  doc.createElement = () => makeEl(doc, '');
  doc.addEventListener = (t, fn) => { (doc.listeners[t] = doc.listeners[t] || []).push(fn); };
  for (const id of ids) doc.byId[id] = makeEl(doc, id);
  return doc;
}

function desktop(over) {
  const app = read('app.js');
  const src = cut(app, '// ── For your review (lib/ui-review.js)', '// The ⓘ help (lib/ui-settings-help.js)');
  const doc = makeDoc(['settings-btn', 'st-review-list', 'st-sum-review']);
  const calls = { fetch: [], sum: [], open: [], reveal: [] };
  const st = { me: { isAdmin: true, user: { id: 'u1' } }, responses: {}, decideStatus: 200, decideBody: null };
  const fetchStub = async (url, opts) => {
    calls.fetch.push([url, opts && opts.method, opts && opts.body]);
    if (opts && opts.method === 'POST') {
      return { ok: st.decideStatus === 200, status: st.decideStatus, json: async () => st.decideBody || { ok: true, change: { id: 'x', state: 'on' } } };
    }
    const body = st.responses[url];
    if (body === undefined) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
  const factory = new Function('window', 'document', 'fetch', 'localStorage', 'esc', 'stSum', 'stOpenGroup', 'stReveal', 'securityActionHtml', 'readinessActionHtml', 'ClaudeSignin', 'SEC_DISMISS_KEY',
    `${src}\nreturn { reviewRefresh, reviewPaintGear, reviewPaintGroup, reviewDecide, reviewMount, reviewDetails, get last() { return reviewLast; }, set last(v) { reviewLast = v; } };`);
  const win = { hubReview: R, get hubMe() { return st.me; } };
  const api = factory(win, doc, fetchStub, { getItem: () => st.dismissed || '' }, escHtml,
    (g, k, text, crit) => calls.sum.push([g, k, text, !!crit]), (g) => calls.open.push(g), (el) => calls.reveal.push(el),
    (a) => `<sec-fix>${escHtml(a.label)}</sec-fix>`, (a) => `<ready-fix>${escHtml(a.label)}${a.href ? ` href=${a.href}` : ''}${a.api ? ` api=${a.api}` : ''}</ready-fix>`, undefined, 'hub-security-warn-dismissed');
  return { api, doc, calls, st, win };
}
const answers = (o) => ({
  '/api/readiness': { items: [] }, '/api/system-health': { items: [] }, '/api/security-check': { ok: true, items: [] }, '/api/setup/status': { setupNeeded: false },
  '/api/backups': { key: { configured: true }, nightly: {} }, '/api/behaviour-changes': { changes: [] }, ...(o || {}),
});

test('page: the review group shows Problems with their fix and Details, and New features with the three buttons', async () => {
  const d = desktop();
  d.st.responses = answers({
    '/api/readiness': { items: [item('docker', 'critical', { title: 'Docker is not running', action: { label: 'Start Docker', api: '/api/docker/start', method: 'POST' } })] },
    '/api/security-check': { ok: true, items: [item('modes', 'warn', { title: 'Open modes', action: { label: 'Tighten', api: '/api/security-check/fix-modes' } })] },
    '/api/behaviour-changes': { changes: [pending('team-guidance', { title: 'Team advice' })] },
  });
  await d.api.reviewRefresh();
  const h = d.doc.getElementById('st-review-list').innerHTML;
  assert.match(h, /<h4>Problems<\/h4>/);
  assert.match(h, /rv-row rv-critical/);
  assert.match(h, /rv-row rv-warn/);
  assert.match(h, /Docker is not running/);
  assert.match(h, /<ready-fix>Start Docker api=\/api\/docker\/start<\/ready-fix>/, 'readiness fixes use readinessActionHtml');
  assert.match(h, /<sec-fix>Tighten<\/sec-fix>/, 'security fixes use the security one-click');
  assert.match(h, /data-rv="details" data-sec="st-ready-section">Details</);
  assert.match(h, /data-sec="st-sec-section">Details</);
  assert.match(h, /<h4>New features<\/h4>/);
  assert.match(h, /Team advice/);
  assert.match(h, /What team-guidance changes\./);
  for (const [k, l] of [['on', 'Turn on'], ['off', 'Leave off'], ['later', 'Ask me in a week']]) assert.match(h, new RegExp(`data-decision="${k}">${l}<`));
  assert.doesNotMatch(h, /Nothing needs your review/);
  assert.deepStrictEqual(d.calls.sum.at(-1), ['review', 'list', '2 problems · 1 new feature', true], 'the group row: red because a problem is critical');
  assert.ok(d.calls.open.includes('review'), 'a critical problem brings the group forward');
  assert.ok(d.doc.getElementById('st-sum-review').classList.contains('st-sum-warn') === false);
});

test('page: warn-only problems make the summary amber, features alone neutral', async () => {
  const d = desktop();
  d.st.responses = answers({ '/api/readiness': { items: [item('w', 'warn')] } });
  await d.api.reviewRefresh();
  assert.ok(d.doc.getElementById('st-sum-review').classList.contains('st-sum-warn'));
  assert.deepStrictEqual(d.calls.sum.at(-1), ['review', 'list', '1 problem', false]);
  assert.deepStrictEqual(d.calls.open, [], 'amber does not move the open group');
  d.st.responses = answers({ '/api/behaviour-changes': { changes: [pending('a')] } });
  await d.api.reviewRefresh();
  assert.ok(!d.doc.getElementById('st-sum-review').classList.contains('st-sum-warn'));
  assert.deepStrictEqual(d.calls.sum.at(-1), ['review', 'list', '1 new feature', false]);
});

test('page: nothing to review shows one calm line and no heading', async () => {
  const d = desktop();
  d.st.responses = answers();
  await d.api.reviewRefresh();
  const h = d.doc.getElementById('st-review-list').innerHTML;
  assert.strictEqual(h, '<div class="rv-calm">Nothing needs your review.</div>');
  assert.deepStrictEqual(d.calls.sum.at(-1), ['review', 'list', 'Nothing waiting', false]);
});

test('page: a read that failed shows "Could not check ..." and not the calm line', async () => {
  const d = desktop();
  d.st.responses = answers({ '/api/backups': undefined });
  delete d.st.responses['/api/backups'];
  await d.api.reviewRefresh();
  const h = d.doc.getElementById('st-review-list').innerHTML;
  assert.match(h, /Could not check the backups\./);
  assert.doesNotMatch(h, /Nothing needs your review/);
});

test('page: a snoozed feature stays listed with "Asked again on <date>" and is not counted', async () => {
  const d = desktop();
  const until = Date.now() + 3 * DAY;
  d.st.responses = answers({ '/api/behaviour-changes': { changes: [pending('a', { snoozedUntil: until })] } });
  await d.api.reviewRefresh();
  assert.match(d.doc.getElementById('st-review-list').innerHTML, /Asked again on /);
  assert.strictEqual(d.doc.getElementById('settings-count'), null, 'no badge: nothing counts');
  assert.strictEqual(d.doc.getElementById('settings-btn').attrs['aria-label'], 'Settings');
});

test('page: each button posts its own decision; the row then says what happened and the count follows', async () => {
  for (const [decision, line] of [['on', 'Turned on.'], ['off', 'Left off.']]) {
    const d = desktop();
    d.st.responses = answers({ '/api/behaviour-changes': { changes: [pending('team-guidance', { title: 'Team advice' })] } });
    await d.api.reviewRefresh();
    assert.strictEqual(d.doc.getElementById('settings-count').textContent, '1');
    d.st.responses = answers();   // the server now says it is decided
    await d.api.reviewDecide('team-guidance', decision, null);
    const post = d.calls.fetch.find((c) => c[1] === 'POST');
    assert.deepStrictEqual([post[0], post[2]], ['/api/behaviour-changes/team-guidance', JSON.stringify({ decision })]);
    const h = d.doc.getElementById('st-review-list').innerHTML;
    assert.match(h, /Team advice/, 'the row stays with its title');
    assert.ok(h.includes(`>${line}<`), line);
    assert.doesNotMatch(h, /data-decision=/, 'its buttons are gone');
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(d.doc.getElementById('settings-count'), null, 'the count went down');
  }
});

test('page: "Ask me in a week" posts later, says when it will ask again, and the row stays (not counted)', async () => {
  const d = desktop();
  d.st.responses = answers({ '/api/behaviour-changes': { changes: [pending('a', { title: 'Alpha' })] } });
  await d.api.reviewRefresh();
  const until = Date.now() + 7 * DAY;
  d.st.decideBody = { ok: true, change: { id: 'a', state: 'pending', snoozedUntil: until } };
  d.st.responses = answers({ '/api/behaviour-changes': { changes: [pending('a', { title: 'Alpha', snoozedUntil: until })] } });
  await d.api.reviewDecide('a', 'later', null);
  assert.strictEqual(d.calls.fetch.find((c) => c[1] === 'POST')[2], JSON.stringify({ decision: 'later' }));
  const h = d.doc.getElementById('st-review-list').innerHTML;
  assert.ok(h.includes(escHtml(R.decisionLine('later', until))), "We'll ask again on <date>.");
  assert.doesNotMatch(h, /data-decision=/);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(d.doc.getElementById('settings-count'), null);
});

test('page: a refused choice (not their own browser session) shows the server\'s message and keeps the buttons', async () => {
  const d = desktop();
  d.st.responses = answers({ '/api/behaviour-changes': { changes: [pending('a')] } });
  await d.api.reviewRefresh();
  d.st.decideStatus = 403;
  d.st.decideBody = { ok: false, error: 'Sign in with an admin account in your browser to decide this.' };
  const row = makeEl(d.doc, '');
  row.dataset = { fid: 'a' };
  const say = makeEl(d.doc, '');
  row.querySelector = (s) => (s === '.rv-result' ? say : null);
  row.querySelectorAll = () => [];
  d.doc.byId['st-review-list'].querySelectorAll = () => [row];
  await d.api.reviewDecide('a', 'on', null);
  assert.strictEqual(say.textContent, 'Sign in with an admin account in your browser to decide this.');
  assert.match(d.doc.getElementById('st-review-list').innerHTML, /data-decision="on"/, 'nothing was repainted');
});

test('page: Details reveals the full section through stReveal', () => {
  const d = desktop();
  const sec = makeEl(d.doc, 'st-ready-section');
  d.doc.byId['st-ready-section'] = sec;
  sec.scrollIntoView = () => {};
  d.api.reviewDetails('st-ready-section');
  assert.deepStrictEqual(d.calls.reveal, [sec]);
  d.api.reviewDetails('st-nope-section');
  assert.strictEqual(d.calls.reveal.length, 1);
});

test('page: the gear gets the count, the aria-label and the colour class; members and signed-out pages get nothing', async () => {
  const cases = [
    [{ '/api/system-health': { items: [item('h', 'critical')] }, '/api/behaviour-changes': { changes: [pending('a'), pending('b')] } }, '3', 'rv-badge rv-critical', 'Settings, 3 things for your review'],
    [{ '/api/readiness': { items: [item('w', 'warn')] } }, '1', 'rv-badge rv-warn', 'Settings, 1 thing for your review'],
    [{ '/api/behaviour-changes': { changes: [pending('a')] } }, '1', 'rv-badge rv-info', 'Settings, 1 thing for your review'],
  ];
  for (const [over, text, cls, label] of cases) {
    const d = desktop();
    d.st.responses = answers(over);
    await d.api.reviewRefresh();
    const b = d.doc.getElementById('settings-count');
    assert.deepStrictEqual([b.textContent, b.className, d.doc.getElementById('settings-btn').attrs['aria-label']], [text, cls, label]);
    assert.strictEqual(d.doc.getElementById('settings-btn').children.includes(b), true, 'the badge sits inside the gear button');
  }
  const m = desktop();
  m.st.me = { isAdmin: false, user: { id: 'u2' } };
  m.st.responses = answers({ '/api/readiness': { items: [item('w', 'warn')] } });
  await m.api.reviewRefresh();
  assert.strictEqual(m.doc.getElementById('settings-count'), null);
  assert.strictEqual(m.calls.fetch.length, 0, 'a member reads nothing');
  const s = desktop();
  s.st.me = undefined;
  await s.api.reviewRefresh();
  assert.strictEqual(s.calls.fetch.length, 0);
});

test('page: a dismissed security warning in this browser does not count on the gear', async () => {
  const d = desktop();
  d.st.responses = answers({ '/api/security-check': { ok: true, items: [item('a', 'warn'), item('b', 'warn')] } });
  d.st.dismissed = 'a,b';
  await d.api.reviewRefresh();
  assert.strictEqual(d.doc.getElementById('settings-count'), null);
});

test('page: wiring in app.js and index.html (refresh on load, every 5 minutes, on settings_changed and after a dismiss; badge CSS uses page variables)', () => {
  const app = read('app.js');
  assert.match(app, /reviewRefresh\(\)\.catch\(\(\) => \{\}\);   \/\/ the count on the gear/);
  assert.match(app, /window\.__rvTimer = setInterval\(\(\) => reviewRefresh\(\)\.catch\(\(\) => \{\}\), 5 \* 60 \* 1000\)/);
  assert.match(app, /addEventListener\('settings_changed', e => \{ const ev = parse\(e\); if \(ev\) \{ changeStripRefresh\(\); reviewRefresh\(\)/);
  assert.match(app, /bar\.remove\(\);\s*layoutBanners\(\);\s*\(typeof reviewRefresh === "function" \? reviewRefresh\(\)/, 'dismissing the security banner updates the count');
  assert.match(app, /reviewMount\(wrap\);/);
  assert.match(app, /Object\.assign|ST_SUM_HOME = \{ status: \{ setup: 'review-checks'/);
  const html = read('index.html');
  for (const rule of [/\.rv-badge\.rv-critical \{ background: var\(--banner-critical-bg\); color: var\(--on-color-text\); \}/, /\.rv-badge\.rv-warn \{ background: var\(--banner-warn-bg\); color: var\(--on-color-text\); \}/, /\.rv-badge\.rv-info \{ background: var\(--accent\); color: var\(--on-accent\); \}/]) assert.match(html, rule);
  assert.match(html, /<button id="settings-btn" class="header-btn" title="Settings" onclick="openSettings\(\)">/, 'the gear is still the same button');
  const css = html.slice(html.indexOf('/* For your review (lib/ui-review.js)'), html.indexOf('.st-gpane { min-width: 0; }'));
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgba?\(|font-family/, 'no colour literals or font stacks');
});

test('page: the first group is the list on top, then Recent changes; the full checks sit under More', () => {
  const G = require('../lib/ui-settings-groups.js');
  const review = G.GROUPS.find((g) => g.id === 'review');
  assert.deepStrictEqual(review.sections, ['st-emergency-section', 'st-recent-section']);
  assert.deepStrictEqual(review.more, ['st-ready-section', 'st-health-section', 'st-sec-section']);
  const app = read('app.js');
  assert.match(app, /body\.insertBefore\(top, body\.firstChild\);/, 'the list goes above the group\'s sections');
  assert.match(app, /Nothing needs your review\./);
  assert.match(app, /Ask me in a week/);
});

// ---- the phone ----------------------------------------------------------------------------------------------------------------
function phone(me) {
  const mob = read('mobile.js');
  const src = cut(mob, "// ── The count of things for the owner's review (lib/ui-review.js)", '// ── review count (end) ──');
  const doc = makeDoc(['menu-settings', 'agents-menu-btn', 'chat-menu-btn']);
  const st = { me, responses: answers(), dismissed: '', fetched: 0 };
  const fetchStub = async (url) => { st.fetched++; const b = st.responses[url]; return b === undefined ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, status: 200, json: async () => b }; };
  const factory = new Function('window', 'document', 'fetch', 'localStorage', '$', 'hubMe', 'setInterval',
    `${src}\nreturn { reviewRefresh, reviewPaint };`);
  const api = factory({ hubReview: R }, doc, fetchStub, { getItem: () => st.dismissed }, (id) => doc.getElementById(id), me, () => 0);
  return { api, doc, st };
}

test('phone: the menu\'s Settings item shows the count, the ⋮ buttons a dot in the same colour class, with labels', async () => {
  const p = phone({ isAdmin: true, user: { id: 'u1' } });
  p.st.responses = answers({ '/api/system-health': { items: [item('h', 'critical')] }, '/api/behaviour-changes': { changes: [pending('a')] } });
  await p.api.reviewRefresh();
  const c = p.doc.getElementById('menu-settings-count');
  assert.deepStrictEqual([c.textContent, c.className], ['2', 'rv-count rv-critical']);
  assert.strictEqual(p.doc.getElementById('menu-settings').attrs['aria-label'], 'Settings, 2 things for your review');
  for (const id of ['agents-menu-btn', 'chat-menu-btn']) {
    const b = p.doc.getElementById(id);
    assert.ok(b.classList.contains('rv-has') && b.classList.contains('rv-critical'), id);
    assert.strictEqual(b.attrs['aria-label'], 'Menu, 2 things for your review');
  }
  p.st.responses = answers();   // everything fixed: the count and the dots go
  await p.api.reviewRefresh();
  assert.strictEqual(p.doc.getElementById('menu-settings-count'), null);
  assert.strictEqual(p.doc.getElementById('menu-settings').attrs['aria-label'], undefined);
  for (const id of ['agents-menu-btn', 'chat-menu-btn']) { assert.ok(!p.doc.getElementById(id).classList.contains('rv-has')); assert.strictEqual(p.doc.getElementById(id).attrs['aria-label'], 'Menu'); }
});

test('phone: features alone are neutral, warn problems amber; members read nothing and see nothing', async () => {
  const f = phone({ isAdmin: true, user: { id: 'u1' } });
  f.st.responses = answers({ '/api/behaviour-changes': { changes: [pending('a')] } });
  await f.api.reviewRefresh();
  assert.strictEqual(f.doc.getElementById('menu-settings-count').className, 'rv-count rv-info');
  f.st.responses = answers({ '/api/readiness': { items: [item('w', 'warn')] } });
  await f.api.reviewRefresh();
  assert.strictEqual(f.doc.getElementById('menu-settings-count').className, 'rv-count rv-warn');
  const m = phone({ isAdmin: false, user: { id: 'u2' } });
  await m.api.reviewRefresh();
  assert.strictEqual(m.st.fetched, 0);
  assert.strictEqual(m.doc.getElementById('menu-settings-count'), null);
});

test('phone: wiring (load, settings_changed, 5 minutes) and the CSS only uses variables the phone page defines', () => {
  const mob = read('mobile.js');
  assert.match(mob, /paintHealthNotice\(\)\.catch\(\(\) => \{\}\);\n  reviewRefresh\(\)\.catch\(\(\) => \{\}\);/);
  assert.match(mob, /on\('settings_changed', \(\) => \{ changeStripLoad\(\); reviewRefresh\(\)\.catch\(\(\) => \{\}\); \}\);/);
  assert.match(mob, /setInterval\(\(\) => reviewRefresh\(\)\.catch\(\(\) => \{\}\), 5 \* 60 \* 1000\);/);
  const html = read('mobile.html');
  const css = html.slice(html.indexOf('/* The count of things for the owner\'s review'), html.indexOf('#menu .danger'));
  assert.ok(css.length > 200);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgba?\(|font-family/);
  for (const v of ['--error', '--on-error', '--warning', '--on-warning', '--accent', '--on-accent']) assert.match(html, new RegExp(`${v}:`), `${v} is defined on the phone page`);
  assert.match(html, /<button id="menu-settings">/);
});

// ── P4-6a: sources other modules plug in ──
test('register(source): merged into build()\'s result; a failing source adds a "Could not check" note; unregister puts it back', async () => {
  assert.strictEqual(typeof R.register, 'function');
  const base = R.build({ readiness: { items: [item('w', 'warn')] }, now: NOW });
  assert.strictEqual(R.register({ id: 'cap-source', load: async () => ({ problems: [{ id: 'cap:1', level: 'critical', title: 'Cap reached', text: 'Spending stopped.' }], features: [{ id: 'cap-new', title: 'Monthly cap', text: 'A cap you can set.' }] }) }), true);
  assert.strictEqual(R.register({ id: 'bad-source', load: async () => { throw new Error('down'); } }), true);
  assert.strictEqual(R.register({ id: '', load: async () => ({}) }), false, 'a source needs an id');
  assert.strictEqual(R.register({ id: 'no-load' }), false, 'and a load function');
  try {
    const answers = await R.loadSources(async () => ({ ok: true }));
    assert.deepStrictEqual(answers.map((a) => [a.id, !!a.failed]), [['cap-source', false], ['bad-source', true]]);
    const r = R.merge(base, answers);
    assert.deepStrictEqual(r.problems.map((p) => p.id), ['cap:1', 'ready:w'], 'critical first');
    assert.deepStrictEqual(r.features.map((f) => [f.id, f.snoozed]), [['cap-new', false]]);
    assert.deepStrictEqual([r.count, r.worst], [3, 'critical']);
    assert.deepStrictEqual(r.notes, ['Could not check bad-source.']);
    assert.deepStrictEqual([base.count, base.notes], [1, []], 'build()\'s own result is not changed');
    assert.strictEqual(R.merge(base, []).count, 1, 'no sources: build() as it is');
  } finally { R.unregister('cap-source'); R.unregister('bad-source'); }
  assert.deepStrictEqual(await R.loadSources(async () => ({})), []);
});

test('page: reviewRefresh asks the registered sources and shows what they say; it is exported on window.hubReview', async () => {
  assert.match(read('lib/ui-review.js'), /root\.hubReview = api/);
  const d = desktop();
  d.st.responses = answers();
  R.register({ id: 'stop-source', load: async (f) => { assert.strictEqual(typeof f, 'function'); return { problems: [{ id: 'stop:1', level: 'warn', title: 'Agents are stopped', text: 'Press Resume.' }] }; } });
  try {
    await d.api.reviewRefresh();
    assert.deepStrictEqual(d.api.last.problems.map((p) => p.id), ['stop:1']);
    assert.strictEqual(d.api.last.count, 1);
    d.api.reviewPaintGroup();
    const h = d.doc.getElementById('st-review-list').innerHTML;
    assert.match(h, /Agents are stopped/);
    assert.doesNotMatch(h, /data-rv="details"/, 'a problem without a section has no Details button');
    R.register({ id: 'stop-source', load: async () => { throw new Error('x'); } });
    await d.api.reviewRefresh();
    assert.deepStrictEqual(d.api.last.notes, ['Could not check stop-source.']);
  } finally { R.unregister('stop-source'); }
  assert.match(read('mobile.js'), /RV\.merge\(RV\.build\(input\), extra\)/, 'the phone count reads the same sources');
});
