'use strict';
// One home for every setting: the gear (Settings) holds what you set, the ⋯ menu what you do or open now. Each item that
// left the ⋯ menu is listed here with its new home; the ones that stay are listed too. The phone menu: a "This device"
// group for everyone; what an admin sets is in Settings, a member keeps it in the menu AND has it in Settings, in the one group
// "You and this device" (P4-5b: a member has the gear, the one-group dialog and the phone's Settings item).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const idx = read('index.html'), app = read('app.js'), mhtml = read('mobile.html'), mob = read('mobile.js');
function fnSrc(src, head) {
  const at = src.indexOf(head);
  assert.ok(at >= 0, head);
  let i = src.indexOf('{', at), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(at, i + 1);
}
const openSettings = fnSrc(app, 'async function openSettings() {');

test('every item that left the ⋯ menu has its one new home in Settings', () => {
  const moved = [
    // [old ⋯ entry, gone from the menu, its home in Settings]
    ['notify-agent-item', /id="st-notify-agent"[^>]*><label for="st-nb-agent">For an agent<\/label><select id="st-nb-agent" onchange="stNotifyAgentPaint\(\)">/],
    ['comms-btn', /id="st-comms-section"><h4>Messaging channels<\/h4>[\s\S]*?stDoorHtml\('comms', 'Messaging channels', '[^']+', 'openCommsPanel\(\)'\)/],
    ['more-advanced', /id="st-tuning-section"><h4>Tuning<\/h4>[\s\S]*?<div id="st-tuning-slot"><\/div>/],
    ['advanced-toggle', /id="st-tuning-section"/],
  ];
  for (const [id, home] of moved) {
    assert.ok(!idx.includes(`id="${id}"`), `${id}: no longer in index.html`);
    assert.match(openSettings, home, `${id}: its home in Settings`);
  }
  assert.ok(!idx.includes('id="more-badge"'), 'the Advanced badge went with the switch');
  // the Settings groups hold the new sections
  const G = require('../lib/ui-settings-groups.js');
  assert.deepStrictEqual(G.groupOfSection('st-chat-section'), { group: 'you', more: false });
  assert.deepStrictEqual(G.groupOfSection('st-tuning-section'), { group: 'money', more: true });
  assert.deepStrictEqual(G.groupOfSection('st-comms-section'), { group: 'tools', more: false });
  assert.deepStrictEqual(G.groupOfSection('st-cx-section'), { group: 'tools', more: false });
  // the tuning controls keep their ids and their page-load wiring, and live in Settings' holder (saved at once: never dirty)
  const holder = idx.slice(idx.indexOf('<div id="st-tuning-body" data-no-dirty hidden>'), idx.indexOf('<script src="/ui-voice-thinking.js">'));
  for (const c of ['prescan-toggle', 'lazy-tools-toggle', 'sdk-workers-select', 'team-guidance-select', 'caveman-toggle']) {
    assert.ok(holder.includes(`id="${c}"`), c);
    assert.ok(app.includes(`document.getElementById('${c}')`), `${c} still wired`);
  }
  assert.match(openSettings, /stModal\(html\);\n\s+stTuningMount\(\); stNotifyAgentFill\(\);[^\n]*\n\s+groupSettings\(data\);/);
  assert.match(openSettings, /id="st-nb-agent-box" class="st-nb-box" data-no-dirty/);
});

test('the top-bar ⋯ menu is gone (P4-11) and every item has a home in Settings', () => {
  assert.ok(!idx.includes('id="more-menu"') && !idx.includes('id="more-btn"') && !idx.includes('id="more-wrap"'), 'no ⋯ button or menu in index.html');
  assert.ok(!/\.more-menu|\.more-wrap|#more-btn/.test(idx), 'its CSS went too');
  assert.ok(!/toggleMoreMenu|closeMoreMenu|openMoreMenu|isMoreMenuOpen/.test(idx + app), 'its handlers went too');
  for (const id of ['about-btn', 'reload-app-item', 'more-modules-item', 'more-remote-item', 'recordings-item', 'wallet-btn', 'more-voice-item', 'more-moved-item']) assert.ok(!idx.includes(`id="${id}"`), `${id} is not in index.html`);
  // Upkeep: a section "This Maestro" with About, Dream, Update and Restart calling the same functions
  const maestro = openSettings.slice(openSettings.indexOf('id="st-maestro-section"'), openSettings.indexOf('id="st-updates-section"'));
  for (const [id, fn] of [['about-btn', 'openAboutDialog'], ['dream-btn', 'startDream'], ['git-sync-btn', 'openGitSync'], ['restart-hub-btn', 'restartHub']]) {
    assert.match(maestro, new RegExp(`id="${id}"[^>]*onclick="${fn}\\(\\)"`), `${id} -> ${fn}()`);
  }
  const G = require('../lib/ui-settings-groups.js');
  assert.deepStrictEqual(G.groupOfSection('st-maestro-section'), { group: 'upkeep', more: false });
  assert.strictEqual(G.GROUPS.find((g) => g.id === 'upkeep').sections[0], 'st-maestro-section', 'first in Upkeep');
  // doors: Wallets in Tools and connections, Recordings in Voice and calls
  assert.match(openSettings, /stDoorHtml\('wallets', 'Wallets', '[^']+', 'openWalletPanel\(\)'\)/);
  assert.match(app, /stDoorHtml\('recordings', 'Recordings', '[^']+', "location\.href='\/recordings'"/);
  assert.ok(!/hub-advanced|advancedToggle|applyAdvanced/.test(app), 'nothing reads the old switch');
});

test('Settings → For an agent: the chat on screen first, then the phone\'s open chat (?agent=), then the first agent', () => {
  const fill = fnSrc(app, 'function stNotifyAgentFill() {');
  const env = { AGENTS: [{ name: 'alpha' }, { name: 'beta', display: 'Beta' }, { name: 'gamma' }], chats: {}, activeChat: null, painted: 0 };
  const run = (wanted) => {
    const sel = { innerHTML: '' };
    const f = new Function('document', 'AGENTS', 'activeChat', 'chats', 'esc', 'capName', 'stNotifyAgentPaint', 'stNotifyAgentWanted',
      `${fill}; stNotifyAgentFill();`);
    f({ getElementById: () => sel }, env.AGENTS, env.activeChat, env.chats, (s) => String(s), (s) => s.toUpperCase(), () => { env.painted++; }, wanted);
    return (/<option value="([^"]+)" selected>/.exec(sel.innerHTML) || [])[1];
  };
  assert.strictEqual(run(''), 'alpha');
  assert.strictEqual(run('gamma'), 'gamma');
  assert.strictEqual(run('nobody'), 'alpha', 'an unknown name falls back');
  env.activeChat = 'c1'; env.chats = { c1: { agent: 'beta' } };
  assert.strictEqual(run('gamma'), 'beta', 'the chat on screen wins');
  assert.match(app, /stNotifyAgentWanted = new URLSearchParams\(location\.search\)\.get\('agent'\) \|\| ''/);
  assert.match(mob, /s\.frame\.src = SETTINGS_SHEET_URL \+ \(typeof current === 'string' && current \? '&agent=' \+ encodeURIComponent\(current\) : ''\) \+ \(s\.door \? '#settings-for=' \+ s\.door : ''\);/);
  // the same rows and the same save as the chat's bell
  const paint = fnSrc(app, 'function stNotifyAgentPaint(fetchFirst = true) {');
  assert.match(paint, /notifyBellMenuHtml\(agent, display\)/);
  assert.match(paint, /await notifyPrefsRequest\('PUT', \{ agent: who, prefs: \{ \[kind\]: s2\.value === '' \? null : s2\.value \} \}\);/);
  // review r1: one saved answer repaints both views (the list of agents with their own setting, and this editor), no extra fetch
  assert.match(paint, /notifySettingsPaint\(\);[^\n]*\n[\s\S]*?stNotifyAgentPaint\(false\);/);
  assert.match(fnSrc(app, 'async function notifyAgentReset(agent) {'), /notifySettingsPaint\(\); if \(typeof stNotifyAgentPaint === 'function'\) stNotifyAgentPaint\(false\);/);
  // review r1: reply length and message history: one editor (Agent Defaults); the menu's duplicates and their page-load POST are gone
  assert.ok(!idx.includes('max-tokens-select') && !app.includes('/api/max_completion_tokens'));
  assert.ok(!idx.includes('max-context-select') && !app.includes('/api/max_context_messages'));
});

test('phone: a "This device" group for everyone; Notification settings, Notifications for this agent and Deep research stay in the menu for members (and are also in their Settings group)', () => {
  const g = mhtml.slice(mhtml.indexOf('<div class="menu-group" data-group="device"'), mhtml.indexOf('<button id="menu-adv-toggle"'));
  assert.match(g, /<div class="menu-group-title" id="menu-gt-device">This device<\/div>/);
  const order = ['menu-look', 'menu-look-pick', 'menu-notify', 'menu-notify-test', 'menu-fold', 'menu-active-top'].map((id) => g.indexOf(`id="${id}"`));
  for (let i = 0; i < order.length; i++) assert.ok(order[i] > 0 && (i === 0 || order[i] > order[i - 1]), String(i));
  assert.ok(mhtml.indexOf('id="menu-settings"') < mhtml.indexOf('data-group="device"'));
  assert.match(mhtml, /<div class="menu-group-title" id="menu-gt-notify">Your notifications<\/div>/);
  assert.match(mob, /for \(const id of \['menu-notify-prefs', 'menu-notify-agent'\]\) if \(\$\(id\)\) \$\(id\)\.hidden = !!hubMe\.isAdmin;/);
  assert.match(mob, /row\.hidden = !researchPrefOn \|\| !!\(hubMe && hubMe\.isAdmin\);/);
});

test('words people use find the moved items in Settings search (it matches a section\'s text)', () => {
  const tuning = openSettings.slice(openSettings.indexOf('id="st-tuning-section"'), openSettings.indexOf('id="st-emergency-section"'));
  for (const w of ['tuning', 'pre-scan', 'lazy tools', 'sdk workers', 'team guidance', 'terse', 'reply length', 'message history', 'agent defaults']) assert.ok(tuning.toLowerCase().includes(w), w);
  const comms = openSettings.slice(openSettings.indexOf('id="st-comms-section"'), openSettings.indexOf('id="st-modules-section"'));
  for (const w of ['messaging', 'channels', 'telegram']) assert.ok(comms.toLowerCase().includes(w), w);
  const notify = openSettings.slice(openSettings.indexOf('id="st-notify-agent"'), openSettings.indexOf('st-nb-agent-box'));
  for (const w of ['for an agent', 'notifications']) assert.ok(notify.toLowerCase().includes(w), w);
  assert.match(read('help.html'), /Settings → Agents → Tuning \(Team guidance\)/);
});
