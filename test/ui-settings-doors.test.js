'use strict';
// P4-6a: hooks for work built in parallel (two empty slots, the "drawn" event), the top-bar ⋯ menu gone (its items moved into Settings),
// door rows to the pages that hold other options, and chips / banners that open their own group. Source checks plus small runs of the
// page functions cut out of app.js. Offline.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const G = require('../lib/ui-settings-groups.js');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const app = read('app.js'), idx = read('index.html');

function fnSrc(src, head) {
  const at = src.indexOf(head);
  assert.ok(at >= 0, head);
  let i = src.indexOf('{', at), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(at, i + 1);
}
const openSettingsSrc = fnSrc(app, 'async function openSettings() {');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

test('the two slots: st-review-top (stop-all) first in For your review, st-money-cap (monthly-cap) just above Spend in Models and money; empty, admin only', () => {
  const src = fnSrc(app, 'function groupSettings(data) {');
  assert.match(src, /\[\['review', 'st-review-top', 'stop-all'\], \['money', 'st-money-cap', 'monthly-cap'\]\]/);
  assert.match(src, /b\.insertBefore\(d, spend \|\| b\.firstChild\)/, 'first child of the group body, but the cap rows sit with Spend in Models and money');
  assert.match(src, /gid === 'money' \? b\.querySelector\('#st-spend-section'\) : null/);
  assert.match(src, /if \(!stSingle\) \{\s*for \(const \[gid, id, slot\]/, 'a member has no such groups');
  // the list of problems is a separate element, so a module filling the slot is never wiped by a repaint
  assert.match(src, /reviewMount\(wrap\);[\s\S]*?st-review-top/, 'the slots are put in after the list, above it');
  assert.ok(!app.includes("getElementById('st-review-top')"), 'the repaint never touches the slot');
  assert.ok(app.includes("top.id = 'st-review-list'"));
  assert.ok(!idx.includes('id="st-review-top"') && !idx.includes('id="st-money-cap"'), 'drawn by the page script, empty: nothing in index.html');
});

test('hub-settings-drawn fires at the end of groupSettings, once, after the slots', () => {
  const src = fnSrc(app, 'function groupSettings(data) {');
  const at = src.indexOf("document.dispatchEvent(new CustomEvent('hub-settings-drawn'))");
  assert.ok(at > 0 && at > src.indexOf("'st-money-cap'") && at > src.indexOf('reviewMount(wrap)'));
  assert.strictEqual(src.split("dispatchEvent(new CustomEvent('hub-settings-drawn'))").length - 1, 1);
  assert.ok(src.slice(at).split('\n').length <= 3, 'the last statement of the function');
});

test('the top-bar ⋯ menu is gone: no button, no menu, no CSS, no handler; the handlers it called all still exist', () => {
  for (const s of ['id="more-btn"', 'id="more-menu"', 'id="more-wrap"', 'class="more-item"', 'more-sep']) assert.ok(!idx.includes(s), s);
  assert.ok(!/\.more-menu|\.more-wrap|#more-btn|\.more-item/.test(idx), 'no CSS for it');
  assert.ok(!/MoreMenu|moreMenu|more-menu/.test(app), 'no handler in app.js');
  for (const fn of ['openAboutDialog', 'startDream', 'openGitSync', 'restartHub', 'openWalletPanel', 'openCommsPanel', 'openVoiceSettings']) {
    assert.match(app + read('comms-panel.js'), new RegExp(`function ${fn}\\(`), fn);
  }
  // an admin's gear still opens everything; the buttons that were hidden for members are no longer drawn for them at all
  const maestro = openSettingsSrc.slice(openSettingsSrc.indexOf('id="st-maestro-section"'), openSettingsSrc.indexOf('id="st-updates-section"'));
  assert.match(maestro, /<h4>This Maestro<\/h4>/);
  assert.deepStrictEqual([...maestro.matchAll(/id="([a-z-]+-btn)"/g)].map((m) => m[1]), ['about-btn', 'dream-btn', 'git-sync-btn', 'restart-hub-btn']);
  assert.deepStrictEqual(G.groupOfSection('st-maestro-section'), { group: 'upkeep', more: false });
  assert.strictEqual(G.GROUPS.find((g) => g.id === 'upkeep').sections[0], 'st-maestro-section');
  assert.match(fnSrc(app, 'function groupSettings(data) {'), /\['st-maestro-section', 'st-users-section'\]/, 'moved to the top of its group');
});

test('restart, dream and the update dialog work with Settings closed (their button is only in Settings now)', () => {
  assert.match(fnSrc(app, 'async function restartHub() {'), /getElementById\('restart-hub-btn'\) \|\| document\.createElement\('button'\)/);
  assert.match(fnSrc(app, 'async function startDream() {'), /getElementById\('dream-btn'\) \|\| document\.createElement\('button'\)/);
  assert.strictEqual((app.match(/getElementById\('restart-hub-btn'\) \|\| document\.createElement\('button'\)/g) || []).length, 3);
  assert.doesNotMatch(app, /Restart it from the ⋯ menu/);
});

test('stDoorHtml: a stable id, the name, plain words, an Open button; hidden on request; names and actions are escaped', () => {
  const stDoorHtml = new Function('esc', `${fnSrc(app, 'function stDoorHtml(name, title, text, action, o) {')}; return stDoorHtml;`)(esc);
  const h = stDoorHtml('users', 'Users & invitations', 'Accounts and tokens.', "location.href='/users'");
  assert.match(h, /^<div class="st-door" id="st-door-users"><div class="st-door-text"><span class="st-door-title">Users &amp; invitations<\/span><span class="st-door-sub">Accounts and tokens\.<\/span><\/div>/);
  assert.match(h, /<button type="button" class="st-test-btn" id="st-door-users-open" aria-label="Open Users &amp; invitations" onclick="location\.href=&#39;\/users&#39;">Open<\/button><\/div>$/);
  assert.ok(!/style=/.test(h));
  assert.match(stDoorHtml('remote', 'R', 't', 'x()', { hidden: true }), /id="st-door-remote" style="display:none"/);
});

test('door rows: each option on another page is a door in its group, with plain words and an Open button', () => {
  const doors = [
    // [name, section it sits in, group, what the Open button does, words that must be in the text]
    ['users', 'st-users-section', 'safety', "location.href='/users'", /Accounts, invitations, what each person's agents may do, API tokens/],
    ['local-models', 'st-local-models-section', 'money', "location.href='/local-models'", /Run models on this computer/],
    ['modules', 'st-modules-section', 'tools', "location.href='/modules'", /Google Drive/],
    ['remote', 'st-modules-section', 'tools', "location.href='/modules#remote-computers'", /another computer's desktop/],
    ['wallets', 'st-modules-section', 'tools', 'openWalletPanel()', /Trading wallets/],
    ['comms', 'st-comms-section', 'tools', 'openCommsPanel()', /Telegram/],
    ['recordings', 'st-voice-section', 'voice', "location.href='/recordings'", /saved as audio/],
  ];
  const all = openSettingsSrc + app.slice(app.indexOf('function voiceSettingsHtml(data) {'), app.indexOf('function voicePaintSettings('));
  for (const [name, section, group, action, words] of doors) {
    const m = new RegExp(`stDoorHtml\\('${name}', '([^']+)', ("[^"]+"|'[^']+'), (["'])`).exec(all);
    assert.ok(m, `${name}: a door is drawn`);
    assert.match(m[2], words, `${name}: says what is on the other side`);
    assert.ok(m[2].length > 30, `${name}: more than the page's name`);
    assert.ok(all.includes(action.includes("'") ? `"${action}"` : `'${action}'`), `${name}: Open does ${action}`);
    assert.strictEqual(G.groupOfSection(section).group, group, `${name}: ${section} is in ${group}`);
    assert.ok(all.indexOf(section) >= 0 && all.indexOf(`stDoorHtml('${name}'`) > all.indexOf(`id="${section}"`), `${name}: drawn inside ${section}`);
  }
  assert.deepStrictEqual(G.groupOfSection('st-users-section'), { group: 'safety', more: false });
  assert.strictEqual(G.GROUPS.find((g) => g.id === 'safety').sections[0], 'st-users-section');
  assert.match(fnSrc(app, 'function groupSettings(data) {'), /\['st-maestro-section', 'st-users-section'\]/);
  // the "Go to:" line and the old stand-alone links are gone; the pending changes are in For your review
  assert.ok(!/Go to: |st-quick-links|st-connectors-link|st-changes-link|st-remote-link/.test(app));
  assert.ok(!/href="\/local-models" style=/.test(app), 'no inline link to Local models any more');
  // the Remote computers door follows the same admin + connector check as the account menu
  assert.match(app, /for \(const id of \['account-remote', 'st-door-remote'\]\)/);
});

test('the Recordings door is drawn in a member\'s Settings too (their voice section), hidden until an agent allows their download', () => {
  assert.match(fnSrc(app, 'async function openMemberSettings() {'), /\$\{voiceSettingsHtml\(\{\}\)\}/);
  const shown = new Function('AGENTS', `${fnSrc(app, 'function recordingsDoorShown() {')}; return recordingsDoorShown();`);
  assert.strictEqual(shown([{ name: 'a' }]), false);
  assert.strictEqual(shown([{ name: 'a', recordings: { canDownload: true } }]), true);
});

test('door text and ids carry no inline colours, font stacks, variation selectors or zero-width characters', () => {
  const bad = new RegExp(`[${String.fromCharCode(0xFE0F, 0x200B, 0x200C, 0x200D, 0x2060)}]`);
  const css = idx.slice(idx.indexOf('.st-door {'), idx.indexOf('.st-door-sub'));
  assert.ok(css.length > 100);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgba?\(|font-family/);
  for (const v of css.match(/var\(--[a-z-]+\)/g) || []) assert.match(idx, new RegExp(`${v.slice(4, -1)}:`), `${v} is defined`);
  const doors = [...app.matchAll(/stDoorHtml\([^\n]*/g)].map((m) => m[0]).join('\n');
  assert.doesNotMatch(doors, bad);
  assert.doesNotMatch(doors, /style="[^"]*(color|font)/);
});

test('chips, badges and banners open their own group', () => {
  // plan badge and spend chip -> Models and money; the voice entry -> Voice and calls
  assert.match(app, /async function openPlanSettings\(\) \{\s*await openSettingsAt\('st-plan-section'\);/);
  assert.match(idx, /id="spend-today" onclick="openSettingsAt\('st-spend-section'\)"/);
  assert.match(app, /async function openVoiceSettings\(\) \{\s*await openSettingsAt\('st-voice-section'\);/);
  assert.strictEqual(G.groupOfSection('st-plan-section').group, 'money');
  assert.strictEqual(G.groupOfSection('st-spend-section').group, 'money');
  assert.strictEqual(G.groupOfSection('st-voice-section').group, 'voice');
  // the update chip shows the card; the card's link opens Upkeep
  assert.match(idx, /<span id="update-chip" onclick="showUpdateCard\(\)"/);
  assert.match(app, /id="uc-settings" onclick="openSettingsAt\('st-updates-section'\); return false">Update settings/);
  assert.strictEqual(G.groupOfSection('st-updates-section').group, 'upkeep');
  assert.strictEqual(G.groupOfSection('st-backups-section').group, 'upkeep');
  // the setup, health and security banners -> For your review
  assert.match(app, /<a href="#" data-rv="open-fix"[^>]*>Open For your review<\/a>/, 'the one banner (P4-15) replaces the setup, health and security banners');
  assert.doesNotMatch(app, /openReviewAt\('(setup|health|sec)'\)/);
  assert.doesNotMatch(app, /onclick="openSettingsAt\('st-(ready|health|sec)-section'\)/, 'no banner opens the full section directly any more');
  // and the full sections stay one Details press away, under More of For your review
  assert.deepStrictEqual(G.groupOfSection('st-ready-section'), { group: 'review', more: true });
  assert.match(app, /data-rv="details" data-sec="\$\{esc\(p\.detailsSection\)\}">Details</);
});

test('openReviewAt: opens Settings at For your review and scrolls the Fix now block to the top once the list has been read', async () => {
  const src = fnSrc(app, 'async function openReviewAt(tier) {');
  const run = async (tier, blocks, lateBlocks) => {
    const log = { opened: 0, revealed: [], scrolled: [], asked: [] };
    const mk = (t) => ({ dataset: { tier: t }, scrollIntoView: (o) => log.scrolled.push([t, o.block]) });
    let current = blocks.map(mk);
    const list = { querySelector: (q) => { log.asked.push(q); const m = /data-tier="(\w+)"/.exec(q); return current.find((b) => b.dataset.tier === m[1]) || null; } };
    const document = { getElementById: (id) => (id === 'st-review-list' ? list : null) };
    const f = new Function('openSettings', 'document', 'stReveal', 'setTimeout', `${src}; return openReviewAt;`)(
      async () => { log.opened++; }, document, (el) => log.revealed.push(el === list), (fn) => { if (lateBlocks) current = lateBlocks.map(mk); fn(); });
    await f(tier);
    return log;
  };
  const a = await run('fix', ['worth', 'fix', 'suggest']);
  assert.deepStrictEqual([a.opened, a.revealed, a.scrolled], [1, [true], [['fix', 'start']]]);
  assert.deepStrictEqual((await run(undefined, ['fix'])).scrolled, [['fix', 'start']], 'no argument: Fix now');
  assert.deepStrictEqual((await run('nonsense', ['fix'])).scrolled, [['fix', 'start']], 'anything else: Fix now');
  assert.deepStrictEqual((await run('worth', ['fix', 'worth'])).scrolled, [['worth', 'start']]);
  const late = await run('fix', [], ['fix']);
  assert.deepStrictEqual(late.scrolled, [['fix', 'start']], 'the list arrives a moment after the dialog opens');
  const none = await run('fix', ['worth']);
  assert.deepStrictEqual([none.opened, none.revealed, none.scrolled], [1, [true], []], 'no Fix now block: the group is still shown');
});
