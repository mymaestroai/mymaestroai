'use strict';
// System health on the pages: Settings → Status → Health (app.js), ?health=1, the desktop and phone banners and the
// security notice kind's hint. Page code is lifted out of app.js / mobile.js and run against stand-in pages and
// servers (the ui-*.test.js pattern); nothing here touches a hub.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const mobile = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
const between = (src, a, b) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + 1);
  assert.ok(i > 0 && j > i, `${a} found`);
  return src.slice(i + a.length, j);
};
const HL = between(app, '// ── health page (begin) ──', '// ── health page (end) ──');
const ESC = app.match(/^\s*const esc = \(s\) => .*$/m)[0];
const SAVE_FETCH = between(app, '// ── save fetch (begin) ──', '// ── save fetch (end) ──');
// A top-level function of app.js, from its first line to the first line that is just its closing brace.
const fnSrc = (src, head) => {
  const i = src.indexOf(head);
  assert.ok(i > 0, `${head} found`);
  const j = src.indexOf('\n    }\n', i);
  return src.slice(i, j + 7);
};

// ── stand-in page ──
function makePage(ids) {
  const els = {};
  for (const id of ids) {
    const classes = new Set();
    els[id] = { id, textContent: '', value: '', checked: false, disabled: false, innerHTML: '', classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), has: (c) => classes.has(c) } };
  }
  return { els, document: { getElementById: (id) => els[id] || null } };
}
const IDS = ['st-hl-list', 'st-hl-msg', 'st-hl-run', 'st-hl-state', 'st-hl-save-state', 'st-hl-enabled', 'st-hl-at', 'st-hl-notify',
  'st-hl-n-diskWarnPct', 'st-hl-n-diskWarnGB', 'st-hl-n-diskCritPct', 'st-hl-n-diskCritGB', 'st-hl-n-fullInDays', 'st-hl-n-backupWarnHours', 'st-hl-n-backupCritHours', 'st-hl-n-warnNights'];
function build(routes, { me = { isAdmin: true, user: { id: 'owner' } } } = {}) {
  const page = makePage(IDS);
  const calls = [], sums = [], timers = [];
  const fetch = async (url, init = {}) => {
    const key = `${init.method || 'GET'} ${url}`;
    calls.push({ key, body: init.body && init.body !== '{}' ? JSON.parse(init.body) : undefined });
    let r = routes[key];
    if (typeof r === 'function') r = r();
    assert.ok(r, `no route for ${key}`);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };
  const setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const stSum = (g, k, text, crit) => sums.push({ g, k, text, crit });
  const guardLog = [];   // stand-in for the dialog guard: what the save settled
  const dialogGuard = { savePoint: (fields) => () => guardLog.push(`commit ${fields.length}`), markLoaded: (els) => guardLog.push(`loaded ${els.length}`) };
  const make = new Function('document', 'fetch', 'setTimeout', 'stSum', 'window', 'dialogGuard', `${ESC}\n${SAVE_FETCH}\n${HL}\nreturn { hlRender, loadHealth, saveHealthSettings, hlFillSettings, HL_POLL_MS, HL_POLL_MAX_MS };`);
  const S = make(page.document, fetch, setTimeout, stSum, { hubMe: me }, dialogGuard);
  return { ...page, S, calls, sums, timers, guardLog };
}
const SETTINGS = { enabled: true, afterStart: true, checkAt: '03:15', diskWarnPct: 15, diskWarnGB: 20, diskCritPct: 5, diskCritGB: 5, fullInDays: 14, inodeWarnPct: 10, inodeCritPct: 3, backupWarnHours: 36, backupCritHours: 72, notify: 'critical', warnNights: 3 };
const T0 = '2026-11-17T08:45:00.000Z';
const item = (id, level, extra = {}) => ({ id, check: 'x', level, title: `Title ${id}`, detail: `Detail ${id}`, fix: `Fix ${id}`, since: null, notified: false, ...extra });
const view = (items, extra = {}) => ({ settings: SETTINGS, running: false, lastRun: { startedAt: T0, finishedAt: T0, trigger: 'nightly', full: true }, items, critical: items.filter(i => i.level === 'critical').length, warnings: items.filter(i => i.level === 'warn').length, ...extra });

// ── the section ──
test('Health is a Status section placed right after the setup checklist, and is drawn for admins only', () => {
  const g = require('../lib/ui-settings-groups.js').GROUPS.find((x) => x.id === 'review');   // the first group, For your review: the full checks sit under its More
  const list = g.more; assert.strictEqual(list[list.indexOf('st-ready-section') + 1], 'st-health-section');
  const at = app.indexOf('id="st-health-section"');
  assert.ok(at > 0, 'the section is drawn');
  assert.match(app.slice(app.lastIndexOf('\n', at - 300), at), /if \(isHubAdmin\(\)\) \{/, 'drawn only inside an admin check');
  assert.match(app.slice(at, at + 400), /<h4>Health<\/h4>/);
});

test('rows: level mark and words, title, detail, fix, "since" only for problems; unknown says "Couldn\'t check"', () => {
  const t = build({});
  t.S.hlRender(view([
    item('health-disk-main', 'critical', { since: T0 }), item('health-memory', 'warn', { since: T0 }), item('health-backups', 'ok', { since: T0 }),
    item('health-clock', 'unknown'), item('health-local-models', 'info'),
  ]));
  const h = t.els['st-hl-list'].innerHTML;
  assert.match(h, /Last checked .+ \(nightly\)/);
  // looks-vars: the level colours are variables now (--health-critical #d64545, --health-warn #d9a21b, --health-ok #3fa65b, defined in index.html :root)
  assert.match(h, /var\(--health-critical\)[^>]*aria-label="Critical"/);
  assert.match(h, /var\(--health-warn\)[^>]*aria-label="Warning"/);
  assert.match(h, /var\(--health-ok\)[^>]*aria-label="OK"/);
  assert.match(h, /Couldn't check/);
  assert.match(h, /Title health-disk-main<\/b>/);
  assert.match(h, /Detail health-disk-main/);
  assert.match(h, /Fix health-disk-main/);
  assert.strictEqual((h.match(/since /g) || []).length, 2, 'since is shown for the critical and the warning, not for the ok');
  assert.deepStrictEqual(t.sums.at(-1), { g: 'status', k: 'health', text: 'Health: problem found', crit: true });
});

test('summary: unknown with no critical or warning says "some checks couldn\'t run"; a problem or an all-ok run keeps its own words', () => {
  const t = build({});
  t.S.hlRender(view([item('health-disk-main', 'ok'), item('health-clock', 'unknown')]));
  assert.deepStrictEqual(t.sums.at(-1), { g: 'status', k: 'health', text: "Health: some checks couldn't run", crit: false });
  t.S.hlRender(view([item('health-disk-main', 'ok'), item('health-clock', 'unknown'), item('health-memory', 'warn')]));
  assert.strictEqual(t.sums.at(-1).text, 'Health: warnings');
  t.S.hlRender(view([item('health-disk-main', 'ok'), item('health-clock', 'info')]));
  assert.strictEqual(t.sums.at(-1).text, 'Health: all fine');
});

test('texts from the hub are escaped', () => {
  const t = build({});
  t.S.hlRender(view([item('health-memory', 'warn', { title: '<img src=x onerror=1>', detail: '<b>x</b>' })]));
  assert.doesNotMatch(t.els['st-hl-list'].innerHTML, /<img|<b>x/);
});

test('no run yet: "Not checked yet."', () => {
  const t = build({});
  t.S.hlRender({ settings: SETTINGS, running: false, lastRun: null, items: [], critical: 0, warnings: 0 });
  assert.match(t.els['st-hl-list'].innerHTML, /Not checked yet\./);
});

test('load: GET /api/system-health fills the list and the form; a non-admin page does not fetch', async () => {
  const t = build({ 'GET /api/system-health': { status: 200, body: view([item('health-memory', 'ok')]) } });
  await t.S.loadHealth();
  assert.deepStrictEqual(t.calls.map(c => c.key), ['GET /api/system-health']);
  assert.strictEqual(t.els['st-hl-at'].value, '03:15');
  assert.strictEqual(t.els['st-hl-n-diskWarnGB'].value, '20');
  assert.strictEqual(t.els['st-hl-notify'].value, 'critical');
  const n = build({}, { me: { isAdmin: false, user: { id: 'sam' } } });
  await n.S.loadHealth();
  assert.deepStrictEqual(n.calls, []);
});

test('Check now: POST then poll GET every 2 s until running is false, at most 3 minutes', async () => {
  let running = true;
  const t = build({
    'POST /api/system-health/run': { status: 202, body: { started: true } },
    'GET /api/system-health': () => ({ status: 200, body: view([], { running }) }),
  });
  assert.strictEqual(t.S.HL_POLL_MS, 2000);
  assert.strictEqual(t.S.HL_POLL_MAX_MS, 3 * 60 * 1000);
  await t.S.loadHealth(true);
  assert.deepStrictEqual(t.calls.map(c => c.key), ['POST /api/system-health/run', 'GET /api/system-health']);
  assert.strictEqual(t.els['st-hl-run'].disabled, true);
  assert.strictEqual(t.timers.at(-1).ms, 2000);
  running = false;
  await t.timers.at(-1).fn(); await new Promise(r => setImmediate(r));
  assert.strictEqual(t.calls.length, 3);
  assert.strictEqual(t.els['st-hl-run'].disabled, false);
  assert.strictEqual(t.timers.length, 1, 'no further poll once running is false');
});

test('Check now: 409 running just polls; 409 disabled says it is off and stops', async () => {
  const t = build({ 'POST /api/system-health/run': { status: 409, body: { error: 'running' } }, 'GET /api/system-health': { status: 200, body: view([], { running: true }) } });
  await t.S.loadHealth(true);
  assert.match(t.els['st-hl-msg'].textContent, /already running/);
  assert.ok(t.timers.length === 1, 'polling');
  const d = build({ 'POST /api/system-health/run': { status: 409, body: { error: 'disabled' } } });
  await d.S.loadHealth(true);
  assert.match(d.els['st-hl-msg'].textContent, /turned off/);
  assert.deepStrictEqual(d.calls.map(c => c.key), ['POST /api/system-health/run']);
  assert.strictEqual(d.els['st-hl-run'].disabled, false);
});

test('settings: only the changed keys go by PUT; a 400 shows the hub\'s error text', async () => {
  const t = build({ 'GET /api/system-health': { status: 200, body: view([]) }, 'PUT /api/system-health/settings': { status: 400, body: { error: 'Warn must be above critical.' } } });
  await t.S.loadHealth();
  t.els['st-hl-at'].value = '04:00';
  t.els['st-hl-n-diskWarnPct'].value = '3';
  t.els['st-hl-notify'].value = 'warnings';
  t.els['st-hl-enabled'].checked = false;
  await t.S.saveHealthSettings();
  const put = t.calls.find(c => c.key === 'PUT /api/system-health/settings');
  assert.deepStrictEqual(put.body, { enabled: false, checkAt: '04:00', notify: 'warnings', diskWarnPct: 3 });
  assert.strictEqual(t.els['st-hl-save-state'].textContent, 'Not saved: Warn must be above critical.');
  assert.deepStrictEqual(t.guardLog, [], 'a refused save leaves the form changed (Close still asks)');
});

test('settings: a 200 fills the form from the answer; nothing changed sends nothing', async () => {
  const saved = { ...SETTINGS, checkAt: '04:00' };
  const t = build({ 'GET /api/system-health': { status: 200, body: view([]) }, 'PUT /api/system-health/settings': { status: 200, body: { settings: saved } } });
  await t.S.loadHealth();
  await t.S.saveHealthSettings();
  assert.strictEqual(t.calls.filter(c => c.key.startsWith('PUT')).length, 0);
  assert.strictEqual(t.els['st-hl-save-state'].textContent, 'Nothing to save.');
  assert.deepStrictEqual(t.guardLog, ['commit 13'], 'nothing to save: the saved values shown and settled');
  t.els['st-hl-at'].value = '04:00';
  await t.S.saveHealthSettings();
  assert.strictEqual(t.els['st-hl-save-state'].textContent, 'Saved.');
  assert.deepStrictEqual(t.guardLog, ['commit 13', 'commit 13'], 'refilled from the answer: the form is settled');
});

test('settings: a cleared number is not a change the hub takes: "Nothing to save" puts the saved value back', async () => {
  const t = build({ 'GET /api/system-health': { status: 200, body: view([]) } });
  await t.S.loadHealth();
  const was = t.els['st-hl-n-diskWarnPct'].value;
  assert.ok(was !== '', 'the stand-in has a saved threshold');
  t.els['st-hl-n-diskWarnPct'].value = '';
  await t.S.saveHealthSettings();
  assert.strictEqual(t.calls.filter(c => c.key.startsWith('PUT')).length, 0);
  assert.strictEqual(t.els['st-hl-n-diskWarnPct'].value, was, 'the form shows what is saved');
  assert.deepStrictEqual(t.guardLog, ['commit 13']);
});

test('settings: a field edited while the save runs keeps the newer text (still changed); the others show the answer', async () => {
  let t;
  const saved = { ...SETTINGS, checkAt: '04:00' };
  t = build({ 'GET /api/system-health': { status: 200, body: view([]) }, 'PUT /api/system-health/settings': () => { t.els['st-hl-notify'].value = 'warnings'; return { status: 200, body: { settings: saved } }; } });
  await t.S.loadHealth();
  t.els['st-hl-at'].value = '04:00';
  await t.S.saveHealthSettings();
  assert.strictEqual(t.els['st-hl-at'].value, '04:00');
  assert.strictEqual(t.els['st-hl-notify'].value, 'warnings', 'the edit made during the save is kept');
  assert.deepStrictEqual(t.guardLog, ['commit 13'], 'settled to the answer before the newer text went back');
});

// ── ?health=1 ──
test('?health=1 opens Settings at the Health section, and leaves the address once handled', () => {
  const { parseOpenTarget } = require('../lib/ui-open-target.js');
  assert.strictEqual(parseOpenTarget({ type: 'open-target', url: '/?health=1' }, 'http://x').health, true);
  assert.strictEqual(parseOpenTarget({ type: 'open-target', url: '/' }, 'http://x').health, false);
  assert.match(app, /if \(t\.health\) openSettingsAt\('st-health-section'\);/);
  assert.match(app, /own\.selfcheck \|\| own\.health \|\|/);
  assert.match(app, /'selfcheck', 'health', 'connectors', 'wallet', 'websearch'\]\) u\.searchParams\.delete\(k\);/);
  const L = require('../lib/ui-phone-layout.js');
  assert.ok(L.DESKTOP_ONLY_PARAMS.includes('health'), 'a phone following the link stays on the computer page');
  assert.strictEqual(L.desktopOnlyLink('?health=1'), true);
});

// ── health problems in the one banner (P4-15: the desktop health bar and the phone #health-notice are gone) ──
const ADMIN = { isAdmin: true, user: { id: 'owner' } };
const RV = require('../lib/ui-review.js');

test('health banner is gone on both pages; a critical health item (never a warning) is a Fix now item and the one banner shows it', () => {
  for (const f of ['hub-health-notice', 'healthBannerItems', 'paintHealthBanner']) assert.ok(!app.includes(f), `${f} in app.js`);
  for (const f of ['healthNoticeItems', 'paintHealthNotice', 'system health notice']) assert.ok(!mobile.includes(f), `${f} in mobile.js`);
  const r = RV.build({ health: view([item('health-disk-main', 'critical', { title: 'Disk almost full' }), item('health-memory', 'warn'), item('health-clock', 'unknown'), item('health-signin-claude', 'critical'), item('health-backups', 'critical', { title: 'No backup <3 days>' })]) });
  assert.deepStrictEqual(r.fix.map((p) => p.id), ['health:health-disk-main', 'health:health-signin-claude', 'health:health-backups']);
  assert.deepStrictEqual(r.worth.map((p) => p.id), ['health:health-memory'], 'a health warning is Worth doing: no banner, no count');
  assert.strictEqual(RV.bannerOf(r).text, 'Disk almost full (and 2 more to fix). Open For your review');
  assert.strictEqual(RV.bannerOf(RV.build({ health: view([item('health-memory', 'warn')]) })), null, 'nothing critical: no banner');
});

test('the Claude sign-in button rides on the one banner when its first item is the sign-in item', () => {
  const r = RV.build({ health: view([item('health-claude-signedout', 'critical', { action: 'claude-signin' })]) });
  assert.deepStrictEqual(RV.bannerOf(r).fix, { label: 'Sign in again', kind: 'claude-signin' });
  assert.match(app, /ClaudeSignin\.healthButton\(\{ action: 'claude-signin' \}\)/);
  assert.match(mobile, /ClaudeSignin\.healthButton\(\{ action: 'claude-signin' \}\)/);
});

test('the phone has one notice at the top of the agent list (#review-banner, red, wraps within 390 px), painted with the count on load and on return to the front', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'mobile.html'), 'utf8');
  const at = html.indexOf('<section id="screen-agents"');
  assert.ok(at > 0 && html.slice(at, at + 200).includes('id="review-banner"'), 'first thing in the agents screen');
  assert.doesNotMatch(html, /id="health-notice"/);
  assert.match(html, /#review-banner\s*\{[^}]*background: var\(--health-notice-bg\)/);
  assert.match(html, /--health-notice-bg:\s*#7a1212;/);
  assert.match(html, /#review-banner\s*\{[^}]*overflow-wrap: anywhere/, 'text wraps within 390 px');
  assert.match(mobile, /document\.addEventListener\('visibilitychange', \(\) => \{ if \(!document\.hidden\) reviewRefresh\(\)/);
  const init = mobile.slice(mobile.indexOf('async function init() {'));
  assert.ok(init.indexOf('await loadMe();') < init.indexOf('reviewRefresh()'), 'painted after /api/me answered');
  assert.ok(init.indexOf('reviewRefresh()') < init.indexOf('await loadAgents();'));
});

// ── the security kind's hint ──
test('the security notice kind names health problems, with the same words on both pages', () => {
  const HINT = 'Sign-in and passkey changes, wallet locks, failed backups, access changes, a halted hub, health problems (a full disk)';
  const WARN = "You won't be told about sign-in and passkey changes, wallet locks, failed backups, access changes, a halted hub or health problems such as a full disk.";
  assert.ok(app.includes(`'${HINT}'`), 'desktop hint');
  assert.ok(mobile.includes(`hint: '${HINT}'`), 'phone hint');
  assert.ok(app.includes(`>${WARN}</div>`), 'desktop warning');
  assert.ok(mobile.includes(`const NOTIFY_SECURITY_WARNING = "${WARN}";`), 'phone warning');
});
