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

const TUNING = ['prescan-toggle', 'lazy-tools-toggle', 'sdk-workers-select', 'caveman-toggle', 'max-tokens-select', 'max-context-select'];
const MOVED_BUTTONS = ['comms-btn', 'wallet-btn', 'dream-btn', 'git-sync-btn', 'restart-hub-btn'];

test('header-controls holds only Files, Scheduler, Settings, Help and the ⋯ button (plus the menu they anchor)', () => {
  const header = divBlock(html, '<div class="header-controls">');
  // Direct controls: strip the menu out and look at what is left.
  const menuBlock = divBlock(header, '<div id="more-menu"');
  const outsideMenu = header.replace(menuBlock, '');
  const buttonIds = Array.from(outsideMenu.matchAll(/<button[^>]*\bid="([^"]+)"/g)).map((m) => m[1]);
  assert.deepStrictEqual(buttonIds, ['files-btn', 'schedule-btn', 'settings-btn', 'help-btn', 'more-btn']);
  for (const id of [...TUNING, ...MOVED_BUTTONS, 'advanced-toggle']) {
    assert.ok(!ids(outsideMenu).includes(id), `${id} is not in the header proper`);
  }
  assert.strictEqual((html.match(/<div class="header-controls">/g) || []).length, 1);
});

test('⋯ button: id, aria-label, title, Advanced badge, opens #more-menu', () => {
  assert.match(html, /<button id="more-btn"[^>]*aria-label="More"[^>]*title="More options"/);
  assert.match(html, /<button id="more-btn"[^>]*aria-haspopup="menu"/);
  assert.match(html, /<button id="more-btn"[^>]*onclick="toggleMoreMenu\(\)"/);
  assert.match(html, /<span class="more-badge" id="more-badge">Advanced<\/span>/);
  assert.ok(html.includes('#more-btn.advanced .more-badge { display: inline-block; }'));
});

test('#more-menu holds the moved buttons in order, a separator, the advanced section and the checkbox', () => {
  const menu = divBlock(html, '<div id="more-menu"');
  const menuIds = ids(menu);
  for (const id of [...MOVED_BUTTONS, 'advanced-toggle', ...TUNING]) assert.ok(menuIds.includes(id), `menu contains #${id}`);
  const order = MOVED_BUTTONS.map((id) => menu.indexOf(`id="${id}"`));
  assert.deepStrictEqual([...order].sort((a, b) => a - b), order, 'Messaging, Wallets, Dream, Update, Restart in that order');
  const sep = menu.indexOf('<div class="more-sep"');
  assert.ok(sep > order[order.length - 1], 'separator after the action items');
  assert.ok(menu.indexOf('id="more-advanced"') > sep, 'advanced section below the separator');
  assert.match(menu, /<input type="checkbox" id="advanced-toggle">\s*<span>Advanced controls<\/span>/);
  // Every moved item still calls its original handler and closes the menu first.
  for (const [id, fn] of [['comms-btn', 'openCommsPanel'], ['wallet-btn', 'openWalletPanel'], ['dream-btn', 'startDream'], ['git-sync-btn', 'openGitSync'], ['restart-hub-btn', 'restartHub']]) {
    assert.match(menu, new RegExp(`id="${id}"[^>]*onclick="closeMoreMenu\\(\\); ${fn}\\(\\)"`), `${id} -> ${fn}()`);
  }
  assert.match(html, /<button id="schedule-btn"[^>]*onclick="openSchedulePanel\(\)"/);
  assert.match(html, /<button id="settings-btn"[^>]*onclick="openSettings\(\)"/);
});

test('advanced section: six tuning controls, plain-English labels and a hint per row; hidden unless the flag is on', () => {
  const adv = divBlock(html, '<div class="more-advanced" id="more-advanced">');
  for (const id of TUNING) assert.ok(adv.includes(`id="${id}"`), `advanced section holds #${id}`);
  assert.strictEqual((adv.match(/<div class="more-row">/g) || []).length, 6);
  assert.strictEqual((adv.match(/<div class="more-hint">/g) || []).length, 6);
  assert.ok(adv.includes('<span>Reply length limit</span>'));
  assert.ok(adv.includes('<span>Message history sent</span>'));
  assert.ok(html.includes('.more-menu .more-advanced { display: none;'));
  assert.ok(html.includes('.more-menu.advanced .more-advanced { display: flex; }'));
  // The restart item keeps its "restarting" look inside the menu.
  assert.ok(html.includes('.more-menu .more-item.restarting { opacity: 0.5; pointer-events: none;'));
});

test('app.js persists the Advanced flag in localStorage hub-advanced (default off)', () => {
  assert.ok(app.includes("const ADVANCED_KEY = 'hub-advanced'"));
  assert.match(app, /applyAdvanced\(localStorage\.getItem\(ADVANCED_KEY\) === '1'\)/);
  assert.match(app, /localStorage\.setItem\(ADVANCED_KEY, advancedToggle\.checked \? '1' : '0'\)/);
  assert.match(app, /moreMenu\.classList\.toggle\('advanced', on\)/);
  assert.match(app, /moreBtn\.classList\.toggle\('advanced', on\)/);
});

test('app.js closes the menu on Escape and on a click outside it', () => {
  assert.match(app, /document\.addEventListener\('keydown', \(e\) => \{\s*if \(e\.key === 'Escape' && isMoreMenuOpen\(\)\) \{ e\.preventDefault\(\); closeMoreMenu\(true\); \}/);
  assert.match(app, /document\.addEventListener\('click', \(e\) => \{\s*if \(isMoreMenuOpen\(\) && moreWrap && !moreWrap\.contains\(e\.target\)\) closeMoreMenu\(\);/);
  assert.match(app, /function toggleMoreMenu\(\)/);
  assert.match(app, /moreBtn\.setAttribute\('aria-expanded', 'true'\)/);
  assert.match(app, /moreBtn\.setAttribute\('aria-expanded', 'false'\)/);
});

test('app.js still wires every tuning control and the restart button by id', () => {
  for (const id of [...TUNING, 'restart-hub-btn', 'more-btn', 'more-menu', 'advanced-toggle']) {
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
