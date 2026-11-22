'use strict';
// Source-level checks for the desktop header cleanup: only Scheduler, Settings and the "⋯" button
// stay in the header; everything else moves into the #more-menu dropdown, with the tuning controls
// behind the "Advanced controls" flag (localStorage 'hub-advanced'). Offline.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const app = read('app.js');
const html = read('index.html');

// Slice a <div ...> ... </div> block out of the page by a selector-ish start marker, counting nested divs.
function divBlock(src, startMarker) {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `page contains ${startMarker}`);
  let depth = 0; let i = start;
  const re = /<div\b|<\/div>/g;
  re.lastIndex = start;
  let m;
  while ((m = re.exec(src))) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) { i = m.index + m[0].length; break; }
  }
  assert.ok(depth === 0, `${startMarker} block is balanced`);
  return src.slice(start, i);
}

const ids = (block) => Array.from(block.matchAll(/\bid="([^"]+)"/g)).map((m) => m[1]);

// menu split, review r1: reply length and message history have one editor, Settings → Agent Defaults (Max tokens, Context msgs)
const TUNING = ['prescan-toggle', 'lazy-tools-toggle', 'sdk-workers-select', 'team-guidance-select', 'caveman-toggle'];
// menu split (gear = what you set, ⋯ = what you do): comms-btn (Messaging) moved to Settings; the ⋯ menu keeps these four actions
const MOVED_BUTTONS = ['wallet-btn', 'dream-btn', 'git-sync-btn', 'restart-hub-btn'];
const LEFT_THE_MENU = ['comms-btn', 'notify-agent-item', 'advanced-toggle', 'more-advanced', 'more-badge'];

test('header-controls holds only Workers, Files, Scheduler, Settings, Help, Reload (shown in the installed app only) and the ⋯ button (plus the menus they anchor)', () => {
  const header = divBlock(html, '<div class="header-controls">');
  // Direct controls: strip the menu out and look at what is left.
  const menuBlock = divBlock(header, '<div id="more-menu"');
  const outsideMenu = header.replace(menuBlock, '');
  const buttonIds = Array.from(outsideMenu.matchAll(/<button[^>]*\bid="([^"]+)"/g)).map((m) => m[1]);
  assert.deepStrictEqual(buttonIds, ['workers-btn', 'files-btn', 'schedule-btn', 'settings-btn', 'help-btn', 'reload-btn', 'more-btn']);
  for (const id of [...TUNING, ...MOVED_BUTTONS, ...LEFT_THE_MENU]) {
    assert.ok(!ids(outsideMenu).includes(id), `${id} is not in the header proper`);
  }
  assert.strictEqual((html.match(/<div class="header-controls">/g) || []).length, 1);
});

test('⋯ button: id, aria-label, title, opens #more-menu; no Advanced badge any more', () => {
  assert.match(html, /<button id="more-btn"[^>]*aria-label="More"[^>]*title="More options"/);
  assert.match(html, /<button id="more-btn"[^>]*aria-haspopup="menu"/);
  assert.match(html, /<button id="more-btn"[^>]*onclick="toggleMoreMenu\(\)"/);
  // menu split (gear = what you set, ⋯ = what you do): the Advanced badge went with the Advanced section; the button is just ⋯
  assert.match(html, /<button id="more-btn"[^>]*>⋯<\/button>/);
  assert.ok(!html.includes('id="more-badge"'));
});

test('#more-menu holds the action items in order, a separator, and the last line that points to Settings', () => {
  const menu = divBlock(html, '<div id="more-menu"');
  const menuIds = ids(menu);
  // menu split (gear = what you set, ⋯ = what you do): no Messaging, no Notifications for this agent, no Advanced section or checkbox, no tuning controls
  for (const id of MOVED_BUTTONS) assert.ok(menuIds.includes(id), `menu contains #${id}`);
  for (const id of [...LEFT_THE_MENU, ...TUNING]) assert.ok(!menuIds.includes(id), `menu no longer contains #${id}`);
  const order = MOVED_BUTTONS.map((id) => menu.indexOf(`id="${id}"`));
  assert.deepStrictEqual([...order].sort((a, b) => a - b), order, 'Wallets, Dream, Update, Restart in that order');
  const sep = menu.indexOf('<div class="more-sep"');
  assert.ok(sep > order[order.length - 1], 'separator after the action items');
  const moved = menu.indexOf('id="more-moved-item"');
  assert.ok(moved > sep, 'the Settings pointer is the last item, below the separator');
  assert.strictEqual(menuIds[menuIds.length - 1], 'more-moved-item');
  assert.match(menu, /id="more-moved-item"[^>]*onclick="closeMoreMenu\(\); openSettingsAt\('st-notify-agent'\)">Notifications, channels and tuning are now in Settings<\/button>/);
  // Every moved item still calls its original handler and closes the menu first.
  for (const [id, fn] of [['wallet-btn', 'openWalletPanel'], ['dream-btn', 'startDream'], ['git-sync-btn', 'openGitSync'], ['restart-hub-btn', 'restartHub']]) {
    assert.match(menu, new RegExp(`id="${id}"[^>]*onclick="closeMoreMenu\\(\\); ${fn}\\(\\)"`), `${id} -> ${fn}()`);
  }
  assert.match(html, /<button id="schedule-btn"[^>]*onclick="openSchedulePanel\(\)"/);
  assert.match(html, /<button id="settings-btn"[^>]*onclick="openSettings\(\)"/);
});

test('tuning holder: seven tuning controls (team guidance after SDK workers), plain-English labels and a hint per row; hidden until Settings mounts it', () => {
  // menu split (gear = what you set, ⋯ = what you do): the controls moved from the ⋯ Advanced section to #st-tuning-body (Settings → Agents → Tuning)
  const adv = divBlock(html, '<div id="st-tuning-body" data-no-dirty hidden>');
  for (const id of TUNING) assert.ok(adv.includes(`id="${id}"`), `tuning holder has #${id}`);
  const order = TUNING.map((id) => adv.indexOf(`id="${id}"`));
  assert.deepStrictEqual([...order].sort((a, b) => a - b), order, 'the five controls keep their order, team guidance after SDK workers');
  // Team guidance now has a hint line like the rest (the more-menu used the row title): 5 rows, 5 hints.
  assert.strictEqual((adv.match(/<div class="st-row">/g) || []).length, 5);
  assert.strictEqual((adv.match(/<div class="st-hint">/g) || []).length, 5);
  // review r1: the duplicate reply-length and history selects are gone, and nothing posts a browser's own copy at page load
  assert.ok(!html.includes('max-tokens-select') && !html.includes('max-context-select'));
  assert.ok(!app.includes('/api/max_completion_tokens') && !app.includes('/api/max_context_messages'));
  assert.match(app, /id="st-maxTokens"/); assert.match(app, /id="st-maxContext"/);
  assert.ok(!divBlock(html, '<div id="more-menu"').includes('st-tuning-body'), 'the holder is not inside the ⋯ menu');
  assert.match(app, /<div class="st-section" id="st-tuning-section"><h4>Tuning<\/h4>[\s\S]*?<div id="st-tuning-slot"><\/div>/);
  assert.match(app, /function stTuningMount\(\) \{[\s\S]*?body\.hidden = false;\s*slot\.appendChild\(body\);/);
  // The restart item keeps its "restarting" look inside the menu.
  assert.ok(html.includes('.more-menu .more-item.restarting { opacity: 0.5; pointer-events: none;'));
});

test('app.js no longer has the Advanced flag (localStorage hub-advanced, applyAdvanced); the tuning controls always show in Settings', () => {
  // menu split (gear = what you set, ⋯ = what you do): the Advanced controls switch is gone
  assert.ok(!app.includes('hub-advanced'));
  assert.ok(!app.includes('ADVANCED_KEY'));
  assert.ok(!app.includes('applyAdvanced'));
  assert.ok(!app.includes("getElementById('advanced-toggle')"));
  assert.doesNotMatch(app, /moreMenu\.classList\.toggle\('advanced'/);
  assert.match(app, /stModal\(html\);\s*stTuningMount\(\); stNotifyAgentFill\(\);\s*\/\/[^\n]*\n\s*groupSettings\(data\);/);
});

test('app.js closes the menu on Escape and on a click outside it', () => {
  assert.match(app, /document\.addEventListener\('keydown', \(e\) => \{\s*if \(e\.key === 'Escape' && isMoreMenuOpen\(\)\) \{ e\.preventDefault\(\); closeMoreMenu\(true\); \}/);
  assert.match(app, /document\.addEventListener\('click', \(e\) => \{\s*if \(isMoreMenuOpen\(\) && moreWrap && !moreWrap\.contains\(e\.target\)\) closeMoreMenu\(\);/);
  assert.match(app, /function toggleMoreMenu\(\)/);
  assert.match(app, /moreBtn\.setAttribute\('aria-expanded', 'true'\)/);
  assert.match(app, /moreBtn\.setAttribute\('aria-expanded', 'false'\)/);
});

test('app.js still wires every tuning control and the restart button by id', () => {
  // menu split (gear = what you set, ⋯ = what you do): 'advanced-toggle' is no longer looked up; the tuning controls keep their wiring
  for (const id of [...TUNING, 'restart-hub-btn', 'more-btn', 'more-menu']) {
    assert.ok(app.includes(`document.getElementById('${id}')`), `app.js looks up #${id}`);
  }
  // restartHub()/pollForRestart() keep driving the restart item's class and title.
  assert.match(app, /btn\.classList\.add\('restarting'\)/);
  assert.match(app, /btn\.classList\.remove\('restarting'\)/);
});

test('menu styling uses the shared palette and the narrow layout keeps it on screen', () => {
  const css = html.slice(html.indexOf('.more-menu {'), html.indexOf('.more-menu .more-hint'));
  assert.ok(css.includes('background: var(--bg-card); border: 1px solid var(--border)'));
  assert.ok(css.includes('color: var(--text)'));
  assert.ok(html.includes('.more-menu .more-hint { font-size: 0.7rem; color: var(--text-dim);'));
  assert.ok(css.includes('min-height: 32px'));
  assert.ok(css.includes('max-width: calc(100vw - 16px)'));
  const narrowStart = html.indexOf('@media (max-width: 1024px)');
  const narrow = html.slice(narrowStart, html.indexOf('@media (max-width: 768px)', narrowStart));
  assert.ok(narrow.includes('.more-menu { right: 0; left: auto; width: min(320px, calc(100vw - 16px)); max-width: calc(100vw - 16px); }'));
});
