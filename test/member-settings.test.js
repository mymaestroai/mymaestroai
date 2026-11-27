'use strict';
// P4-5b: a member has Settings: the gear, the one-group dialog "You and this device" (no list of groups, none of the admin sections,
// no admin-only request), the phone's Settings item and frame, and Simple's "More settings". The page itself is not run: functions
// are cut out of app.js and run against small stubs (the way phone-settings.test.js does it).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const G = require('../lib/ui-settings-groups.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('app.js'), mob = read('mobile.js'), idx = read('index.html');
function fnSrc(src, head) {
  const at = src.indexOf(head);
  assert.ok(at >= 0, head);
  let i = src.indexOf('{', at), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(at, i + 1);
}
const ADMIN_ONLY_SECTIONS = G.allSectionIds().filter((id) => !['st-looks-section', 'st-notify-section', 'st-chat-section', 'st-voice-section'].includes(id));

test('openSettings sends a member to the one-group dialog before any request (no /api/settings read)', async () => {
  const head = app.slice(app.indexOf('async function openSettings() {'), app.indexOf('stModal(`<h3>Loading settings...</h3>`);'));
  const run = async (admin) => {
    const calls = [], urls = [];
    const f = new Function('isHubAdmin', 'openMemberSettings', 'stModal', 'fetch', `${head} return 'admin path'; } return openSettings;`);
    const openSettings = f(() => admin, async () => { calls.push('member'); return 'member path'; }, () => { calls.push('modal'); }, async (u) => { urls.push(u); throw new Error('stop'); });
    const out = await openSettings();
    return { out, calls, urls };
  };
  const m = await run(false);
  assert.strictEqual(m.out, 'member path');
  assert.deepStrictEqual(m.calls, ['member']);
  assert.deepStrictEqual(m.urls, [], 'no request is made for a member by openSettings');
  const a = await run(true);
  assert.strictEqual(a.out, 'admin path', 'an admin goes on to the full dialog');
});

test('a member\'s dialog draws only the member-safe sections, in the one group, and none of the admin section ids', () => {
  const src = fnSrc(app, 'async function openMemberSettings() {');
  const drawn = [...src.matchAll(/class="st-section" id="(st-[a-z0-9-]+-section)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(drawn, ['st-looks-section', 'st-notify-section', 'st-chat-section', 'st-account-section']);
  assert.match(src, /\$\{voiceSettingsHtml\(\{\}\)\}/, 'the voice preferences are the same section (its admin rows are inside isHubAdmin() blocks)');
  for (const id of ADMIN_ONLY_SECTIONS) assert.ok(!src.includes(`id="${id}"`), `${id} is not drawn for a member`);
  for (const bad of ['/api/settings', '/api/auto-model', '/api/hub/', '/api/system-health', '/api/security-check', '/api/readiness', '/api/behaviour-changes', '/api/users']) assert.ok(!src.includes(bad), `no ${bad} in a member's dialog`);
  // the pieces that are the member's own: their notification defaults and agents, the deep research choice, looks, the device's chat switches, Profile and Security
  for (const id of ['st-notify-mine', 'st-notify-agent', 'st-nb-agent-box', 'st-research-pref', 'st-push-btn', 'st-fold-auto', 'st-active-top', 'st-open-profile', 'st-open-security', 'st-looks-body']) assert.ok(src.includes(`id="${id}"`), id);
  assert.ok(!src.includes('st-question-after'), 'question reminders are saved through /api/settings (admin): not here');
});

test('openMemberSettings runs: html, loaders and no fetch', async () => {
  const src = fnSrc(app, 'async function openMemberSettings() {');
  const log = { modal: '', timers: [], calls: [], urls: [] };
  const names = ['stModal', 'foldAutoOn', 'activeTopOn', 'simpleAccountOk', 'voiceSettingsHtml', 'setTimeout', 'lookSectionPaint', 'voiceSettingsInit', 'loadNotifySettings', 'researchPrefLoad', 'stNotifyAgentFill', 'groupSettings', 'stHelpMount', 'paintDesktopPush', 'fetch', 'window'];
  const vals = [(h) => { log.modal = h; }, () => true, () => false, () => true, () => '<div class="st-section" id="st-voice-section"></div>', (f) => { log.timers.push(f); }, () => log.calls.push('looks'), () => {}, () => log.calls.push('notify'), () => log.calls.push('research'), () => log.calls.push('agentFill'), (d) => log.calls.push(['group', d]), () => log.calls.push('help'), () => log.calls.push('push'), async (u) => { log.urls.push(u); }, { hubMe: { isAdmin: false } }];
  const f = new Function(...names, `return (${src});`);
  const fn = f(...vals);
  await fn();
  for (const t of log.timers) t();
  assert.deepStrictEqual(log.urls, []);
  assert.ok(log.calls.includes('notify') && log.calls.includes('looks') && log.calls.includes('agentFill') && log.calls.includes('help') && log.calls.includes('push'));
  assert.ok(log.calls.some((c) => Array.isArray(c) && c[0] === 'group'));
  assert.match(log.modal, /<h3>&#x2699; Settings<\/h3>/);
  assert.match(log.modal, /id="st-switch-simple"/, 'Switch to Simple stays for a member whose account allows it');
  const ids = [...log.modal.matchAll(/class="st-section" id="(st-[a-z0-9-]+-section)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(ids, ['st-looks-section', 'st-notify-section', 'st-chat-section', 'st-voice-section', 'st-account-section']);
});

// a stub element that records appendChild and accepts the rest of groupSettings' calls
function groupHarness(admin) {
  const log = { appended: [], wrapHtml: '', shown: [], rv: 0, slots: [], events: [] };
  const stub = (sel) => ({ sel, dataset: {}, hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, appendChild(s) { log.appended.push([sel, s.id]); }, insertBefore(s) { log.slots.push([sel, s.id, s.slot]); }, firstChild: null, querySelector: (q) => stub(q), querySelectorAll: () => [], closest: () => null });
  const wrap = { ...stub('wrap'), set innerHTML(h) { log.wrapHtml = h; }, get innerHTML() { return log.wrapHtml; }, setAttribute(k, v) { if (k === 'data-slot') this.slot = v; }, querySelector: (q) => stub(q), querySelectorAll: () => [] };
  const sections = ['st-looks-section', 'st-notify-section', 'st-chat-section', 'st-voice-section', 'st-account-section'].map((id) => ({ id, classList: { contains: (c) => c === 'st-section' } }));
  const modal = { children: sections, insertBefore() {} };
  const document = { querySelector: () => modal, createElement: () => wrap, getElementById: () => null, dispatchEvent: (e) => { log.events.push(e.type); } };
  const env = {
    document, window: { hubMe: { isAdmin: admin } }, localStorage: { getItem: () => null },
    STG: G, stSumParts: {}, PROVIDERS: [], esc: (s) => String(s), remoteComputersOk: false,
    isHubAdmin: () => admin, stPlaceRows() {}, setTimeout() {}, stShowGroup: (g) => { log.shown.push(g); }, stPhoneList() {}, stPhoneBack() {}, stSearch() {}, stSetMore() {},
    stPhoneOn: () => false, stSum() {}, stSandboxText: () => '', stQuestionsText: () => '', reviewMount: () => { log.rv++; }, fetch: async () => ({ ok: false }),
    stSearching: false, stPicked: false, stCurGroup: null, stPhonePage: null,
  };
  const src = fnSrc(app, 'function groupSettings(data) {');
  const keys = Object.keys(env).filter((k) => !['stSearching', 'stPicked', 'stCurGroup', 'stPhonePage'].includes(k));
  const f = new Function(...keys, `let stSearching, stPicked, stCurGroup, stPhonePage, stSingle; ${src}; return groupSettings;`);
  return { run: f(...keys.map((k) => env[k])), log };
}

test('groupSettings for a member: one group "You and this device", no list of groups, every section in it', () => {
  const m = groupHarness(false);
  m.run({});
  assert.match(m.log.wrapHtml, /id="st-groups"|st-panes/);
  assert.deepStrictEqual([...m.log.wrapHtml.matchAll(/<section class="st-group" id="st-group-([a-z]+)"/g)].map((x) => x[1]), ['you']);
  assert.deepStrictEqual([...m.log.wrapHtml.matchAll(/id="st-gbtn-([a-z]+)"/g)].map((x) => x[1]), ['you']);
  assert.ok(!m.log.wrapHtml.includes('st-group-review') && !m.log.wrapHtml.includes('st-group-upkeep') && !m.log.wrapHtml.includes('st-group-money'));
  assert.match(m.log.wrapHtml, /<h5 class="st-ghead">You and this device<\/h5>/);
  assert.match(m.log.wrapHtml, /<nav class="st-glist" aria-label="Settings groups" hidden>/);
  assert.ok(!m.log.wrapHtml.includes('st-quick-links'), 'the admin links row is not drawn');
  assert.deepStrictEqual([...new Set(m.log.appended.map((a) => a[0]))], ['#st-group-you .st-group-body'], 'every section lands in the one group (the voice section too, not in a Voice group)');
  assert.strictEqual(m.log.appended.length, 5);
  assert.deepStrictEqual(m.log.slots, [], 'a member has no slots');
  assert.deepStrictEqual(m.log.events, ['hub-settings-drawn'], 'the event fires for a member too');
  assert.deepStrictEqual(m.log.shown, ['you']);
});

test('groupSettings for an admin is unchanged: eight groups', () => {
  const a = groupHarness(true);
  a.run({});
  assert.deepStrictEqual([...a.log.wrapHtml.matchAll(/<section class="st-group" id="st-group-([a-z]+)"/g)].map((x) => x[1]), G.GROUPS.map((g) => g.id));
  assert.ok(!a.log.wrapHtml.includes('st-quick-links'), 'the Go to line is gone (doors replace it)');
  assert.doesNotMatch(a.log.wrapHtml, /class="st-single"/);
  // P4-6a: two empty slots, one at the top of For your review and one first in Models and money; then the event modules wait for
  assert.deepStrictEqual(a.log.slots, [['#st-group-review .st-group-body', 'st-review-top', 'stop-all'], ['#st-group-money .st-group-body', 'st-money-cap', 'monthly-cap']]);
  assert.deepStrictEqual(a.log.events, ['hub-settings-drawn'], 'fired once, after the slots exist');
});

test('the phone: a one-group Settings never shows the list page, and Back leaves (closes) at once', () => {
  const src = ['function stPhoneOn() {', 'function stPhoneList() {', 'function stPhoneGo(groupId) {', 'function stPhoneBack() {'].map((h) => fnSrc(app, h)).join('\n');
  const wrap = { dataset: {}, closest: () => null, querySelector: () => null };
  const run = (single) => {
    const f = new Function('document', 'window', 'STG', 'stSingleInit', `let stPhonePage = null; let stSingle = stSingleInit; ${src}; return { stPhoneList, stPhoneGo, stPhoneBack, page: () => stPhonePage };`);
    const doc = { documentElement: { classList: { contains: () => true } }, getElementById: (id) => (id === 'st-groups' ? wrap : null) };
    return f(doc, { matchMedia: () => ({ matches: true }) }, G, single);
  };
  const m = run(true);
  wrap.dataset = {};
  m.stPhoneList();
  assert.strictEqual(wrap.dataset.page, undefined, 'no list page for one group');
  m.stPhoneGo('you');
  assert.strictEqual(wrap.dataset.page, undefined, 'and no "group page" header with a Back to a list that is not there');
  assert.strictEqual(m.stPhoneBack(), false, 'Back is the close request (the frame closes the sheet)');
  const a = run(false);
  wrap.dataset = {};
  a.stPhoneList();
  assert.strictEqual(wrap.dataset.page, 'list', 'an admin on the phone still starts on the list');
});

test('the gear is a member\'s: applyMemberView hides the other admin controls but not settings-btn', () => {
  const src = fnSrc(app, 'function applyMemberView() {');
  const hidden = [];
  const mk = (id) => ({ id, closest: () => null, style: { set display(v) { hidden.push(id); } }, classList: { remove() {} } });
  const doc = { body: { classList: { add() {} } }, getElementById: (id) => mk(id), querySelector: () => null };
  new Function('document', 'window', `${src}; applyMemberView();`)(doc, { hubMe: { isAdmin: false } });
  assert.ok(!hidden.includes('settings-btn'), 'the gear stays');
  for (const id of ['schedule-btn', 'update-chip', 'spend-today']) assert.ok(hidden.includes(id), `${id} is still hidden`);
  assert.match(idx, /<button id="settings-btn" class="header-btn" title="Settings" onclick="openSettings\(\)">/);
});

test('the phone: Settings is in a member\'s menu and the frame draws their group; the count stays admins only', () => {
  assert.match(mob, /\$\('menu-settings'\)\.hidden = false;/);
  assert.doesNotMatch(mob, /\$\('menu-settings'\)\.hidden = !hubMe\.isAdmin/);
  // the frame no longer says "kept by the admins": a member goes through the same openSettings
  assert.doesNotMatch(app, /Settings are kept by the admins/);
  const so = fnSrc(app, 'async function settingsOnlyStart() {');
  assert.match(so, /await openSettings\(\);/);
  assert.match(so, /if \(isHubAdmin\(\) && typeof settingsDoorStart === 'function'\) settingsDoorStart\(\);/, 'the settings-for door stays an admin\'s');
  // the review count: reviewRefresh reads nothing and paints no badge for a member (both pages)
  assert.match(fnSrc(app, 'async function reviewRefresh() {'), /!me\.isAdmin \|\| !me\.user\) \{ reviewLast = null; reviewPaintGear\(\); return; \}/);
  assert.match(fnSrc(mob, 'async function reviewRefresh() {'), /hubMe\.isAdmin === true && hubMe\.user/);
});

test('the phone\'s own "This device" items stay in the menu and are also rows of the member\'s group', () => {
  const mhtml = read('mobile.html');
  const g = mhtml.slice(mhtml.indexOf('<div class="menu-group" data-group="device"'), mhtml.indexOf('<button id="menu-adv-toggle"'));
  for (const id of ['menu-look', 'menu-look-pick', 'menu-fold', 'menu-active-top']) assert.ok(g.includes(`id="${id}"`), `${id} stays in the ⋮ menu`);
  const src = fnSrc(app, 'async function openMemberSettings() {');
  for (const id of ['st-looks-body', 'st-fold-auto', 'st-active-top']) assert.ok(src.includes(`id="${id}"`), `${id} is a row in the member's group`);
  for (const id of ['menu-notify-prefs', 'menu-notify-agent']) assert.ok(mhtml.includes(`id="${id}"`), `${id} stays in the menu`);
  assert.match(mob, /for \(const id of \['menu-notify-prefs', 'menu-notify-agent'\]\) if \(\$\(id\)\) \$\(id\)\.hidden = !!hubMe\.isAdmin;/);
});

test('Simple: a member\'s settings dialog has "More settings" again, opening the same one-group Settings', () => {
  const src = fnSrc(app, 'function openSimpleSettings() {');
  const run = (isAdmin) => {
    let html = '';
    const el = { set innerHTML(h) { html = h; }, get innerHTML() { return html; }, querySelector: () => ({ set textContent(v) {}, style: {}, focus() {}, querySelectorAll: () => [] }), querySelectorAll: () => [], addEventListener() {}, className: '', id: '', isConnected: true };
    const doc = { createElement: () => el, body: { appendChild() {} }, addEventListener() {}, removeEventListener() {} };
    new Function('document', 'window', 'simpleCloseSettings', 'simpleStyleLabel', 'lookPickerBuild', `let simpleLookOff = null; ${src}; openSimpleSettings();`)(doc, { hubMe: { isAdmin, user: { name: 'Sam' } } }, () => {}, () => '', () => {});
    return html;
  };
  assert.match(run(false), /data-act="settings"><div><b>More settings<\/b><span>Notifications, voice, chat and your account<\/span>/);
  assert.match(run(true), /data-act="settings"><div><b>More settings<\/b><span>Provider keys, web search, backups and the rest<\/span>/);
  assert.match(src, /if \(a\.dataset\.act === 'settings'\) \{ simpleCloseSettings\(\); openSettings\(\); \}/);
  assert.match(fnSrc(mob, 'function simpleSettingsOpen() {'), /id="ss-all"><b>More settings<\/b>/);
});

test('"Agents with their own setting" lists the member\'s agents and opens each agent\'s card', () => {
  const src = fnSrc(app, 'function notifySettingsPaint() {');
  const box = { innerHTML: '' };
  const cache = { default: { question: 'on' }, agents: { alpha: { question: 'off' }, ghost: { question: 'away' } } };
  const f = new Function('document', 'notifyPrefsCache', 'NOTIFY_KINDS', 'NOTIFY_AGENT_KINDS', 'notifyModeOptions', 'notifyModeLabel', 'notifySecurityWarning', 'AGENTS', 'capName', 'esc',
    `${src}; notifySettingsPaint();`);
  f({ getElementById: () => box }, cache, [['question', 'Questions', 'a hint']], [['question', 'Questions']], () => '', (m) => m, () => '', [{ name: 'alpha', display: 'Alpha' }], (s) => s, (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'));
  assert.match(box.innerHTML, /onclick="openAgentSettings\(&quot;alpha&quot;, event\)"[^>]*>Open card<\/button>/);
  assert.ok(!box.innerHTML.includes('openAgentSettings(&quot;ghost&quot;'), 'an agent that is not in their list gets no card button');
});

test('no U+FE0F or zero-width characters were added to the member dialog code or its CSS', () => {
  const bad = new RegExp(`[${String.fromCharCode(0xFE0F, 0x200B, 0x200C, 0x200D, 0x2060)}]`);
  assert.doesNotMatch(fnSrc(app, 'async function openMemberSettings() {'), bad);
  const css = idx.slice(idx.indexOf('#st-groups.st-single .st-glist'), idx.indexOf('.st-phone-head { display: none; }'));
  assert.doesNotMatch(css, bad);
  assert.doesNotMatch(css, /var\(--(?!text|border|accent)[a-z-]+\)/, 'only defined variables (none new)');
});

// The member's loaders, run for real against a recording fetch: every URL is one the hub answers a member, none is admin-only.
test('a member\'s dialog loaders request only member routes (stubbed fetch records every URL)', async () => {
  const urls = [];
  const fetch = async (u) => { urls.push(String(u)); return { ok: true, status: 200, json: async () => ({ ok: true, prefs: { default: {}, agents: {} }, on: false, installing: false }) }; };
  const src = [fnSrc(app, 'async function researchPrefLoad() {'), fnSrc(app, 'async function voiceRefreshStatus() {'), fnSrc(app, 'async function notifyPrefsFetch(method, body) {'), fnSrc(app, 'async function reviewRefresh() {')].join('\n');
  const els = { 'st-research-pref': { hidden: false } };
  const document = { getElementById: (id) => els[id] || null };
  const f = new Function('fetch', 'document', 'window', 'RV', 'reviewSeqInit', `let voiceStatus = null, researchPrefChoice, researchPrefLevel, reviewLast = null, reviewSeq = 0; const voicePaint = () => {}, voiceWakeRecheck = () => {}, reviewPaintGear = () => {}, reviewPaintGroup = () => {}, reviewDismissedKey = () => '', researchPrefPaint = () => {}; ${src}; return { researchPrefLoad, voiceRefreshStatus, notifyPrefsFetch, reviewRefresh };`);
  const api = f(fetch, document, { hubMe: { isAdmin: false, user: { name: 'Sam' } } }, { load: async (fx) => { await fx('/api/security-check'); return {}; }, build: () => ({}) }, 0);
  await api.researchPrefLoad();
  await api.voiceRefreshStatus();
  await api.notifyPrefsFetch('GET');
  await api.reviewRefresh();   // admins only: a member reads nothing
  assert.deepStrictEqual(urls, ['/api/research-pref', '/api/voice/status', '/api/notify/prefs']);
  const access = read('lib/access.js');
  for (const u of urls) assert.ok(access.includes(`'${u}'`), `${u} is a signed-in route in lib/access.js`);
});
