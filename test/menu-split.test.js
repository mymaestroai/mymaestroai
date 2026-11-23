'use strict';
// One home for every setting: the gear (Settings) holds what you set, the ⋯ menu what you do or open now. Each item that
// left the ⋯ menu is listed here with its new home; the ones that stay are listed too. The phone menu: a "This device"
// group for everyone; what an admin sets is in Settings, a member keeps it in the menu (members have no Settings).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const idx = read('index.html'), app = read('app.js'), mhtml = read('mobile.html'), mob = read('mobile.js');
const moreMenu = (() => { const i = idx.indexOf('<div id="more-menu"'); return idx.slice(i, idx.indexOf('</div>\n        </div>', i)); })();
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
    ['comms-btn', /id="st-comms-section"><h4>Messaging channels<\/h4>[\s\S]*?<button class="st-test-btn" onclick="openCommsPanel\(\)">Open messaging channels<\/button>/],
    ['more-advanced', /id="st-tuning-section"><h4>Tuning<\/h4>[\s\S]*?<div id="st-tuning-slot"><\/div>/],
    ['advanced-toggle', /id="st-tuning-section"/],
  ];
  for (const [id, home] of moved) {
    assert.ok(!idx.includes(`id="${id}"`), `${id}: no longer in index.html`);
    assert.match(openSettings, home, `${id}: its home in Settings`);
  }
  assert.ok(!idx.includes('id="more-badge"'), 'the Advanced badge went with the switch');
  // the Settings groups hold the new sections
  assert.match(app, /\{ id: 'agents',[^}]*'st-chat-section', 'st-tuning-section'\] \}/);
  assert.match(app, /\{ id: 'tools',[^}]*'st-comms-section', 'st-cx-section'/);   // voice entry: st-voice-section moved to its own Voice group
  // the tuning controls keep their ids and their page-load wiring, and live in Settings' holder (saved at once: never dirty)
  const holder = idx.slice(idx.indexOf('<div id="st-tuning-body" data-no-dirty hidden>'), idx.indexOf('<script src="/ui-voice-thinking.js">'));
  for (const c of ['prescan-toggle', 'lazy-tools-toggle', 'sdk-workers-select', 'team-guidance-select', 'caveman-toggle']) {
    assert.ok(holder.includes(`id="${c}"`), c);
    assert.ok(app.includes(`document.getElementById('${c}')`), `${c} still wired`);
  }
  assert.match(openSettings, /stModal\(html\);\n\s+stTuningMount\(\); stNotifyAgentFill\(\);[^\n]*\n\s+groupSettings\(data\);/);
  assert.match(openSettings, /id="st-nb-agent-box" class="st-nb-box" data-no-dirty/);
});

test('what stays in the ⋯ menu: things you do or open now, and one line pointing to Settings', () => {
  const stay = ['about-btn', 'reload-app-item', 'more-modules-item', 'more-remote-item', 'recordings-item', 'wallet-btn', 'dream-btn', 'git-sync-btn', 'restart-hub-btn', 'more-moved-item'];
  const at = stay.map((id) => moreMenu.indexOf(`id="${id}"`));
  for (let i = 0; i < stay.length; i++) assert.ok(at[i] >= 0, stay[i]);
  for (let i = 1; i < at.length; i++) assert.ok(at[i] > at[i - 1], `${stay[i]} after ${stay[i - 1]}`);
  assert.match(moreMenu, /<button id="more-moved-item" class="more-item more-moved" role="menuitem" title="Open Settings" onclick="closeMoreMenu\(\); openSettingsAt\('st-notify-agent'\)">Notifications, channels and tuning are now in Settings<\/button>/);
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
  assert.match(mob, /s\.frame\.src = SETTINGS_SHEET_URL \+ \(typeof current === 'string' && current \? '&agent=' \+ encodeURIComponent\(current\) : ''\);/);
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

test('phone: a "This device" group for everyone; Notification settings, Notifications for this agent and Deep research stay for members only', () => {
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
