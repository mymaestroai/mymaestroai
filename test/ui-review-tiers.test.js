'use strict';
// P4-7A: For your review tiers (Fix now / Worth doing / Suggestions), the count (red only), the snooze of suggestions kept in this browser,
// and the ONE banner that replaced the eight old ones. lib/ui-review.js is pure; the page functions are cut out of app.js / mobile.js
// and run against small stubs (no browser, no hub). Offline.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const R = require('../lib/ui-review.js');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);
const DAY = 24 * 3600 * 1000;
const item = (id, level, extra) => ({ id, level, title: `Title ${id}`, detail: `Detail of ${id}. More words.`, ...(extra || {}) });
const tierOf = (input, id) => { const p = R.build({ ...input, now: NOW }).problems.find((x) => x.id === id); return p ? p.tier : ''; };

// ---- tiers ----------------------------------------------------------------------------------------------------------------------
test('security items: exposure and exposed secrets are Fix now, hardening (two-factor, SSH, open services) is Worth doing, info is not listed', () => {
  const fix = ['tunnel', 'tailscale', 'file-modes', 'git-secrets', 'git-history-secrets', 'member-host', 'roots-member', 'lead', 'lan-services-critical', 'bind', 'docker', 'node'];
  for (const id of fix) assert.strictEqual(tierOf({ security: { items: [item(id, 'critical')] } }, `sec:${id}`), 'fix', id);
  for (const id of ['ssh', 'lan-services', 'policy-overrides', 'connectors', 'restart-pending', 'lockfile']) assert.strictEqual(tierOf({ security: { items: [item(id, 'warn')] } }, `sec:${id}`), 'worth', id);
  for (const id of ['totp', 'admin-2fa-optional', 'member-totp']) {
    assert.strictEqual(tierOf({ security: { items: [item(id, 'warn')] } }, `sec:${id}`), 'worth', `${id} warn: two-factor is hardening`);
    assert.strictEqual(tierOf({ security: { items: [item(id, 'critical')] } }, `sec:${id}`), 'fix', `${id} critical is always Fix now`);
  }
  assert.deepStrictEqual(R.build({ security: { items: [item('ssh', 'info'), item('lan-other', 'info'), item('x', 'ok')] }, now: NOW }).problems, []);
});

test('setup checklist: agents that cannot answer or are exposed are Fix now; web search, notice devices and a hand-started service are Suggestions', () => {
  for (const id of ['claude-signin', 'chatgpt-signin', 'exposed', 'docker', 'sandbox-image']) assert.strictEqual(tierOf({ readiness: { items: [item(id, 'critical')] } }, `ready:${id}`), 'fix', id);
  for (const id of ['search', 'push-devices', 'supervisor']) assert.strictEqual(tierOf({ readiness: { items: [item(id, 'warn')] } }, `ready:${id}`), 'suggest', id);
  for (const id of ['tools-default', 'legacy-auth', 'poppler', 'sandbox-image', 'totp']) assert.strictEqual(tierOf({ readiness: { items: [item(id, 'warn')] } }, `ready:${id}`), 'worth', id);
  assert.deepStrictEqual(R.build({ readiness: { items: [item('docker', 'info'), item('browser-render', 'info'), item('admin-2fa-optional', 'info')] }, now: NOW }).problems, [], 'info lines are not listed');
});

test('health items: critical is Fix now (Claude signed out included), warn is Worth doing, "Nightly backups are off" is a Suggestion', () => {
  assert.strictEqual(tierOf({ health: { items: [item('health-claude-signedout', 'critical', { action: 'claude-signin' })] } }, 'health:health-claude-signedout'), 'fix');
  assert.strictEqual(tierOf({ health: { items: [item('health-disk-data', 'critical')] } }, 'health:health-disk-data'), 'fix');
  assert.strictEqual(tierOf({ health: { items: [item('health-os-updates', 'critical')] } }, 'health:health-os-updates'), 'fix');
  assert.strictEqual(tierOf({ health: { items: [item('health-os-updates', 'warn')] } }, 'health:health-os-updates'), 'worth');
  assert.strictEqual(tierOf({ health: { items: [item('health-backups', 'info')] } }, 'health:health-backups'), 'suggest');
  assert.strictEqual(tierOf({ health: { items: [item('health-backups', 'warn')] } }, 'health:health-backups'), 'worth');
  assert.strictEqual(tierOf({ health: { items: [item('health-clock', 'info')] } }, 'health:health-clock'), '', 'other info lines are not listed');
});

test('0 data connectors is not a problem at all; backups that are not set up are a Suggestion; a source problem is Worth doing unless it says a tier', () => {
  assert.deepStrictEqual(R.build({ security: { items: [item('connectors', 'ok')] }, readiness: { items: [item('connectors', 'info')] }, now: NOW }).problems, []);
  assert.deepStrictEqual(R.build({ backups: { key: { configured: false } }, now: NOW }).suggestions.map((p) => p.id), ['backup:off']);
  const base = R.build({ now: NOW });
  const r = R.merge(base, [{ id: 'm', problems: [{ id: 'm:1', title: 'A', level: 'critical' }, { id: 'm:2', title: 'B', tier: 'suggest' }, { id: 'm:3', title: 'C', tier: 'nonsense' }] }]);
  assert.deepStrictEqual(r.problems.map((p) => [p.id, p.tier]), [['m:1', 'fix'], ['m:3', 'worth'], ['m:2', 'suggest']]);
  assert.deepStrictEqual([r.count, r.worst], [1, 'critical']);
});

test('count is the Fix now items; worst is critical or none (amber never colours the gear); the line starts with the red part', () => {
  const r = R.build({ accounts: { none: true }, setup: { setupNeeded: true }, health: { items: [item('health-disk', 'critical')] }, security: { items: [item('ssh', 'warn'), item('bind', 'warn')] }, readiness: { items: [item('search', 'warn')] }, changes: { changes: [{ id: 'f1', state: 'pending', title: 'F1' }, { id: 'f2', state: 'pending', title: 'F2' }] }, now: NOW });
  assert.deepStrictEqual([r.count, r.worst, R.badgeKind(r)], [3, 'critical', 'critical']);
  assert.deepStrictEqual([r.fix.length, r.worth.length, r.suggestions.length], [3, 2, 1]);
  assert.strictEqual(R.summaryText(r), '3 to fix · 1 suggestion · 2 new features');
  const calm = R.build({ security: { items: [item('ssh', 'warn')] }, now: NOW });
  assert.deepStrictEqual([calm.count, calm.worst, R.badgeKind(calm), R.summaryText(calm)], [0, 'none', '', 'Nothing to fix']);
});

// ---- the snooze of suggestions -------------------------------------------------------------------------------------------------
const memory = (init) => { const m = { ...(init || {}) }; return { m, getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } }; };

test('suggestions can be asked again in a week: stored in this browser under hub-review-snooze, listed as asked again, back after 7 days', () => {
  assert.strictEqual(R.SNOOZE_KEY, 'hub-review-snooze');
  const st = memory();
  const until = R.snoozeSuggestion(st, 'ready:search', NOW);
  assert.strictEqual(until, NOW + 7 * DAY);
  assert.deepStrictEqual(JSON.parse(st.m['hub-review-snooze']), { 'ready:search': NOW + 7 * DAY });
  const input = { readiness: { items: [item('search', 'warn'), item('push-devices', 'warn')] }, now: NOW + DAY };
  const r = R.build({ ...input, snooze: R.readSnooze(st, NOW + DAY) });
  assert.deepStrictEqual(r.suggestions.map((p) => p.id), ['ready:push-devices']);
  assert.deepStrictEqual(r.snoozedSuggestions.map((p) => [p.id, p.snoozedUntil]), [['ready:search', NOW + 7 * DAY]]);
  assert.strictEqual(R.summaryText(r), 'Nothing to fix · 1 suggestion', 'a snoozed suggestion is not in the line');
  const later = R.build({ ...input, now: NOW + 7 * DAY + 1, snooze: R.readSnooze(st, NOW + 7 * DAY + 1) });
  assert.deepStrictEqual(later.suggestions.map((p) => p.id).sort(), ['ready:push-devices', 'ready:search'], 'after the week it is asked again');
  assert.deepStrictEqual(R.readSnooze(st, NOW + 8 * DAY), {}, 'expired entries are dropped');
  assert.deepStrictEqual(R.readSnooze({ getItem: () => 'not json' }, NOW), {});
  assert.deepStrictEqual(R.readSnooze(null, NOW), {});
});

test('a Fix now or Worth doing item cannot be snoozed away: only suggestions read the snooze', () => {
  const r = R.build({ health: { items: [item('health-disk', 'critical')] }, security: { items: [item('ssh', 'warn')] }, snooze: { 'health:health-disk': NOW + DAY, 'sec:ssh': NOW + DAY }, now: NOW });
  assert.deepStrictEqual([r.fix.length, r.worth.length, r.count], [1, 1, 1]);
});

// ---- the pages -------------------------------------------------------------------------------------------------------------------
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
  for (const id of ids) doc.byId[id] = makeEl(doc, id);
  return doc;
}
const answers = (o) => ({
  '/api/readiness': { items: [] }, '/api/system-health': { items: [] }, '/api/security-check': { ok: true, items: [] }, '/api/setup/status': { setupNeeded: false },
  '/api/backups': { key: { configured: true }, nightly: {} }, '/api/behaviour-changes': { changes: [] }, ...(o || {}),
});
function desktop() {
  const src = cut(read('app.js'), '// ── For your review (lib/ui-review.js)', '// The ⓘ help (lib/ui-settings-help.js)');
  const doc = makeDoc(['settings-btn', 'st-review-list', 'st-sum-review']);
  const st = { me: { isAdmin: true, user: { id: 'u1' } }, responses: {}, store: {}, noAccounts: false };
  const calls = { layout: 0, openReview: [], sum: [] };
  const fetchStub = async (url) => { const b = st.responses[url]; return b === undefined ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, status: 200, json: async () => b }; };
  const storage = { getItem: (k) => (k in st.store ? st.store[k] : null), setItem: (k, v) => { st.store[k] = String(v); } };
  const factory = new Function('window', 'document', 'fetch', 'localStorage', 'esc', 'stSum', 'stOpenGroup', 'stReveal', 'securityActionHtml', 'readinessActionHtml', 'ClaudeSignin', 'layoutBanners', 'openReviewAt',
    `${src}\nreturn { reviewRefresh, reviewPaintGroup, reviewPaintBanner, reviewSnooze, get last() { return reviewLast; } };`);
  const win = { hubReview: R, get hubMe() { return st.me; }, get hubNoAccounts() { return st.noAccounts; } };
  const api = factory(win, doc, fetchStub, storage, escHtml, (g, k, t, c) => calls.sum.push([g, k, t, !!c]), () => {}, () => {},
    (a) => `<sec-fix>${escHtml(a.label)}</sec-fix>`, (a) => `<ready-fix>${escHtml(a.label)}${a.href ? ` href=${a.href}` : ''}${a.api ? ` api=${a.api}` : ''}</ready-fix>`, undefined, () => { calls.layout++; }, (t) => calls.openReview.push(t));
  return { api, doc, st, calls };
}

test('page: Suggestions are folded behind "▸ Suggestions (N)"; "Ask me in a week" on one stores the snooze here, lists it as asked again and sends no request', async () => {
  const d = desktop();
  d.st.responses = answers({ '/api/readiness': { items: [item('search', 'warn', { title: 'Web search uses the free fallback' }), item('push-devices', 'warn', { title: 'No device gets notices' })] } });
  await d.api.reviewRefresh();
  let h = d.doc.getElementById('st-review-list').innerHTML;
  assert.match(h, /▸ Suggestions \(2\)/);
  assert.match(h, /data-rv="snooze" data-id="ready:search">Ask me in a week</);
  assert.match(h, /data-rv="snooze" data-id="ready:push-devices">Ask me in a week</);
  assert.doesNotMatch(h, /Worth doing|Fix now/, 'blocks with nothing in them are not drawn');
  d.api.reviewSnooze('ready:search');
  assert.deepStrictEqual(Object.keys(JSON.parse(d.st.store['hub-review-snooze'])), ['ready:search']);
  h = d.doc.getElementById('st-review-list').innerHTML;
  assert.match(h, /▸ Suggestions \(1\)/, 'the count in the button follows');
  assert.match(h, /Web search uses the free fallback[\s\S]*ask again on /, 'listed again inside the folded block with its date');
  assert.doesNotMatch(h.slice(h.indexOf('Web search uses the free fallback')), /data-id="ready:search">Ask me/, 'no second snooze button on it');
  assert.deepStrictEqual(d.calls.sum.at(-1).slice(0, 3), ['review', 'list', 'Nothing to fix · 1 suggestion']);
  // the next read keeps it snoozed
  await d.api.reviewRefresh();
  assert.deepStrictEqual(d.api.last.suggestions.map((p) => p.id), ['ready:push-devices']);
});

test('page: ONE banner, only while something is in Fix now: "<first title> (and N more to fix). Open For your review" and the first item\'s fix button', async () => {
  const d = desktop();
  d.st.responses = answers({
    '/api/readiness': { items: [item('docker', 'critical', { title: 'Docker is missing', action: { label: 'Start Docker', api: '/api/docker/start', method: 'POST' } })] },
    '/api/system-health': { items: [item('health-disk', 'critical', { title: 'The disk is full' })] },
    '/api/security-check': { ok: true, items: [item('ssh', 'warn')] },
  });
  await d.api.reviewRefresh();
  const bars = Object.keys(d.doc.byId).filter((k) => /notice|banner/.test(k));
  assert.deepStrictEqual(bars, ['hub-review-banner'], 'one banner element, none of the old ids');
  const bar = d.doc.getElementById('hub-review-banner');
  assert.match(bar.innerHTML, /^<span class="rv-banner-text">Docker is missing \(and 1 more to fix\)\.<\/span> <a href="#" data-rv="open-fix"[^>]*>Open For your review<\/a> <span class="rv-banner-fix"><ready-fix>Start Docker api=\/api\/docker\/start<\/ready-fix><\/span>$/);
  assert.match(bar.style.cssText, /var\(--banner-critical-bg\)/);
  assert.ok(d.calls.layout > 0, 'the notice stack is laid out again');
  // pressing the link opens Settings at Fix now
  const click = bar.listeners.click[0];
  let prevented = false;
  click({ target: { closest: (s) => (s === '[data-rv="open-fix"]' ? { dataset: { rv: 'open-fix' } } : null) }, preventDefault: () => { prevented = true; } });
  assert.deepStrictEqual([d.calls.openReview, prevented], [['fix'], true]);
  // one item left: no "and N more"
  d.st.responses = answers({ '/api/readiness': { items: [item('docker', 'critical', { title: 'Docker is missing' })] } });
  await d.api.reviewRefresh();
  assert.match(d.doc.getElementById('hub-review-banner').innerHTML, /Docker is missing\.<\/span>/);
  assert.doesNotMatch(d.doc.getElementById('hub-review-banner').innerHTML, /more to fix/);
  // nothing in Fix now (only amber and grey): the banner goes
  d.st.responses = answers({ '/api/security-check': { ok: true, items: [item('ssh', 'warn')] }, '/api/readiness': { items: [item('search', 'warn')] } });
  await d.api.reviewRefresh();
  assert.strictEqual(d.doc.getElementById('hub-review-banner'), null);
});

test('page: a hub with no login at all (no /api/me answer) still gets the banner, with the Welcome link; a signed-out page with accounts gets none', async () => {
  const d = desktop();
  d.st.me = undefined; d.st.noAccounts = true;
  await d.api.reviewRefresh();
  const bar = d.doc.getElementById('hub-review-banner');
  assert.match(bar.innerHTML, /This hub has no login yet\.<\/span>/);
  assert.match(bar.innerHTML, /<ready-fix>Create the admin account href=\/welcome<\/ready-fix>/);
  const s = desktop();
  s.st.me = undefined;
  await s.api.reviewRefresh();
  assert.strictEqual(s.doc.getElementById('hub-review-banner'), null);
});

function phone(me) {
  const src = cut(read('mobile.js'), "// ── The count of things for the owner's review (lib/ui-review.js)", '// ── review count (end) ──');
  const doc = makeDoc(['menu-settings', 'agents-menu-btn', 'chat-menu-btn', 'review-banner']);
  const st = { responses: answers(), store: {}, opened: [], posts: [] };
  const fetchStub = async (url) => { const b = st.responses[url]; return b === undefined ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, status: 200, json: async () => b }; };
  const storage = { getItem: (k) => (k in st.store ? st.store[k] : null), setItem: (k, v) => { st.store[k] = String(v); } };
  const factory = new Function('window', 'document', 'fetch', 'localStorage', '$', 'hubMe', 'setInterval', 'esc', 'api', 'settingsSheetOpen', 'ClaudeSignin',
    `${src}\nreturn { reviewRefresh, reviewPaint };`);
  const api = factory({ hubReview: R }, doc, fetchStub, storage, (id) => doc.getElementById(id), me, () => 0, escHtml,
    async (u, o) => { st.posts.push([u, o && o.method]); return { ok: true }; }, (...a) => st.opened.push(a), undefined);
  return { api, doc, st };
}

test('phone: the same one line at the top of the agent list, only for Fix now items, with the first item\'s fix button when it has one', async () => {
  const p = phone({ isAdmin: true, user: { id: 'u1' } });
  p.st.responses = answers({ '/api/backups': { key: { configured: true }, nightly: {}, recovery: { restoredFrom: 5 } } });
  await p.api.reviewRefresh();
  const bar = p.doc.getElementById('review-banner');
  assert.strictEqual(bar.hidden, false);
  assert.match(bar.innerHTML, /^<span class="rvb-text">Agents are paused after a restore\.<\/span> <a href="#" class="rvb-open">Open For your review<\/a> <button type="button" class="rvb-fix" data-api="\/api\/backups\/recovery\/resume" data-method="POST">Resume<\/button>$/);
  p.st.responses = answers({ '/api/system-health': { items: [item('health-disk', 'critical', { title: 'The disk is full' }), item('health-mem', 'critical', { title: 'Memory' })] } });
  await p.api.reviewRefresh();
  assert.match(bar.innerHTML, /^<span class="rvb-text">The disk is full \(and 1 more to fix\)\.<\/span> <a href="#" class="rvb-open">Open For your review<\/a>$/, 'no fix button when the first item has none');
  p.st.responses = answers({ '/api/readiness': { items: [item('search', 'warn')] } });
  await p.api.reviewRefresh();
  assert.strictEqual(bar.hidden, true);
  assert.strictEqual(bar.textContent, '');
  const m = phone({ isAdmin: false, user: { id: 'u2' } });
  await m.api.reviewRefresh();
  assert.strictEqual(m.doc.getElementById('review-banner').hidden, true, 'a member is never shown one');
  assert.strictEqual(m.doc.getElementById('review-banner').innerHTML, '');
});

// ---- the old banners are gone, the others stay -----------------------------------------------------------------------------------
test('the eight old banners are gone from the pages; the phone-layout and theme notices and the halt banner stay', () => {
  const app = read('app.js'), mob = read('mobile.js'), mhtml = read('mobile.html');
  for (const id of ['hub-no-accounts-notice', 'hub-recovery-notice', 'hub-setup-notice', 'hub-readiness-notice', 'hub-health-notice', 'hub-security-notice']) assert.doesNotMatch(app, new RegExp(id), `${id} in app.js`);
  for (const fn of ['paintNoAccountsNotice', 'paintSetupNotice', 'paintReadinessBanner', 'paintHealthBanner', 'paintSecurityBanner', 'paintRecoveryBanner', 'dismissSecurityBanner', 'healthBannerItems']) assert.doesNotMatch(app, new RegExp(fn), `${fn} in app.js`);
  assert.doesNotMatch(mob, /paintHealthNotice|healthNoticeItems|\$\('health-notice'\)/);
  assert.doesNotMatch(mhtml, /id="health-notice"|#health-notice/);
  assert.match(mhtml, /<div id="review-banner" role="status" hidden><\/div>/);
  assert.match(app, /for \(const id of \['hub-phone-layout-notice', 'hub-theme-notice', 'hub-review-banner'\]\)/, 'the stack: phone-layout notice, theme notice, the one review banner');
  assert.match(app, /hub-halt-banner/, 'the halt banner is kept');
  assert.match(app, /hub-update-card/, 'the update card is kept');
  assert.match(app, /bar\.id = 'hub-phone-layout-notice'/);
  assert.match(mob, /const host = \$\('screen-agents'\), first = \$\('review-banner'\)/, 'the phone theme notice sits under the one banner');
});

test('nothing else is left that reads the security dismissal; every line is free of variation selectors and zero-width characters', () => {
  const bad = new RegExp(`[${String.fromCharCode(0xFE0F, 0x200B, 0x200C, 0x200D, 0x2060)}]`);
  for (const f of ['lib/ui-review.js', 'test/ui-review-tiers.test.js']) assert.doesNotMatch(read(f), bad, f);
  assert.doesNotMatch(read('app.js'), /SEC_DISMISS_KEY|reviewDismissedKey/);
  assert.doesNotMatch(read('mobile.js'), /hub-security-warn-dismissed/);
  const css = read('index.html');
  const block = css.slice(css.indexOf('.rv-row.rv-fix'), css.indexOf('.rv-main {'));
  assert.ok(block.length > 200);
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b|rgba?\(|font-family/, 'no colour literals or font stacks in the tier styles');
});
