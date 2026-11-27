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

test('header-controls holds only Workers, Files, Scheduler, Settings, Help and Reload (shown in the installed app only): no ⋯ button', () => {
  const header = divBlock(html, '<div class="header-controls">');
  const buttonIds = Array.from(header.matchAll(/<button[^>]*\bid="([^"]+)"/g)).map((m) => m[1]);
  assert.deepStrictEqual(buttonIds, ['workers-btn', 'files-btn', 'schedule-btn', 'settings-btn', 'help-btn', 'reload-btn']);
  for (const id of [...TUNING, ...MOVED_BUTTONS, ...LEFT_THE_MENU, 'more-btn', 'more-menu', 'more-wrap']) {
    assert.ok(!ids(header).includes(id), `${id} is not in the header`);
  }
  assert.strictEqual((html.match(/<div class="header-controls">/g) || []).length, 1);
});

test('the ⋯ button and #more-menu are gone; Wallets, Dream, Update and Restart live in Settings (Upkeep, Tools)', () => {
  assert.ok(!html.includes('id="more-btn"') && !html.includes('id="more-menu"') && !html.includes('id="more-badge"'));
  const maestro = app.slice(app.indexOf('id="st-maestro-section"'), app.indexOf('id="st-updates-section"'));
  for (const [id, fn] of [['dream-btn', 'startDream'], ['git-sync-btn', 'openGitSync'], ['restart-hub-btn', 'restartHub']]) {
    assert.match(maestro, new RegExp(`id="${id}"[^>]*onclick="${fn}\\(\\)"`), `${id} -> ${fn}()`);
  }
  assert.match(app, /stDoorHtml\('wallets', 'Wallets', '[^']+', 'openWalletPanel\(\)'\)/);
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
  assert.match(app, /<div class="st-section" id="st-tuning-section"><h4>Tuning<\/h4>[\s\S]*?<div id="st-tuning-slot"><\/div>/);
  assert.match(app, /function stTuningMount\(\) \{[\s\S]*?body\.hidden = false;\s*slot\.appendChild\(body\);/);
  // The restart button keeps its "restarting" look inside Settings.
  assert.ok(html.includes('.st-test-btn.restarting { opacity: 0.5; pointer-events: none;'));
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

test('app.js has no ⋯ menu code left', () => {
  assert.ok(!/isMoreMenuOpen|closeMoreMenu|toggleMoreMenu|moreWrap|moreBtn/.test(app));
  assert.ok(!app.includes("getElementById('more-btn')") && !app.includes("getElementById('more-menu')"));
});

test('app.js still wires every tuning control and the restart button by id', () => {
  // menu split (gear = what you set, ⋯ = what you do): 'advanced-toggle' is no longer looked up; the tuning controls keep their wiring
  for (const id of [...TUNING, 'restart-hub-btn']) {
    assert.ok(app.includes(`document.getElementById('${id}')`), `app.js looks up #${id}`);
  }
  // restartHub()/pollForRestart() keep driving the restart item's class and title.
  assert.match(app, /btn\.classList\.add\('restarting'\)/);
  assert.match(app, /btn\.classList\.remove\('restarting'\)/);
});

test('no CSS for the ⋯ menu is left; the door row uses the shared palette', () => {
  assert.ok(!/\.more-menu|\.more-wrap|#more-btn|\.more-item/.test(html));
  const door = html.slice(html.indexOf('.st-door {'), html.indexOf('.st-door-sub'));
  assert.ok(door.includes('border: 1px solid var(--border)') && door.includes('.st-door-title'));
});
