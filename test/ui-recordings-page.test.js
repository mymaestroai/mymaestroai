'use strict';
// The Recordings page (/recordings: recordings.html + recordings.js), its menu entries and the admin "Call recordings" section.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const access = require('../lib/access');
const { resolve } = require('../lib/static-files');

test('the page files exist, are web resources, and /recordings is a session page (signed in, not admin-only, not public)', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'recordings.html')));
  assert.ok(fs.existsSync(path.join(ROOT, 'recordings.js')));
  assert.ok(resolve('/recordings.html') && resolve('/recordings.js'), 'served like the other page files');
  for (const p of ['/recordings', '/recordings.html', '/recordings.js']) {
    assert.deepStrictEqual(access.classifyRoute(p, 'GET'), { kind: 'session', page: true }, p);
    assert.ok(!access.ADMIN_PAGES.has(p), p + ' is not an admin page');
  }
  assert.match(read('server.js'), /pathname === '\/recordings'\) \{\s*filePath = path\.join\(__dirname, 'recordings\.html'\)/);
  assert.match(read('recordings.html'), /<script src="\/recordings\.js"><\/script>/);
});

test('the page calls only /api/recordings routes', () => {
  const js = read('recordings.js');
  assert.match(js, /const API = '\/api\/recordings'/);
  const urls = [...js.matchAll(/(?:fetch|getJson)\(\s*([^,)]+)/g)].map(m => m[1].trim());
  assert.ok(urls.length >= 3, 'list, sessions/manifest and delete calls are there');
  for (const u of urls) assert.ok(u === 'API' || u.startsWith('`${API}') || u === 'url', `fetch target ${u}`);
  assert.ok(!/['"`]\/api\/(?!recordings)/.test(js), 'no other /api path');
  assert.ok(!/\/api\/agents|\/api\/users/.test(js));
  assert.match(js, /cache: 'no-store'/);
  assert.ok(!/cache: '(?!no-store)/.test(js));
});

test('the delete dialog needs exactly DELETE before it posts', () => {
  const js = read('recordings.js');
  assert.match(js, /delOk\.disabled = delBox\.value !== 'DELETE'/, 'the button follows the box');
  assert.match(read('recordings.html'), /id="delete-confirm" disabled/, 'the button starts disabled in the page');
  const click = js.slice(js.indexOf("delOk.addEventListener('click'"));
  assert.ok(click.indexOf("delBox.value !== 'DELETE'") > 0 && click.indexOf("delBox.value !== 'DELETE'") < click.indexOf('fetch('), 'the exact word is checked before the post');
  assert.match(click, /method: 'POST'[\s\S]*body: JSON\.stringify\(\{ confirm: 'DELETE' \}\)/);
  assert.match(click, /\/delete`/);
  const text = js.slice(js.indexOf('function askDelete'));
  assert.ok(text.includes('This deletes the recording and its transcript from this computer for good. Backups made before today still hold it. Type DELETE to confirm.'));
  assert.ok(/dateTimeOf\(s\.startedAt\)/.test(text), 'the dialog names the session date');
  assert.ok(js.includes("in_use: 'That call is still going on.'"));
  assert.ok(js.includes("You can't open these recordings."));
  assert.ok(js.includes('There are no recordings you can open.'));
  assert.ok(js.includes("This session can't be opened."));
  assert.ok(js.includes('(ended without hanging up)'));
  assert.ok(js.includes('One file with every recording, its transcripts and details.'));
});

test('the audio source is a .flac under /api/recordings, with preload none', () => {
  const js = read('recordings.js');
  assert.match(js, /el\('audio', \{ controls: '', preload: 'none', src: `\$\{API\}\/\$\{enc\}\/\$\{sid\}\/\$\{Number\(e\.seq\)\}\.flac` \}\)/);
  assert.match(js, /`\$\{API\}\/\$\{enc\}\/\$\{sid\}\.zip`/, 'a session download');
  assert.match(js, /`\$\{API\}\/\$\{enc\}\/all\.zip`/, 'download everything');
});

test('recorded text is never put in with innerHTML: textContent only', () => {
  const js = read('recordings.js');
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(js), 'no HTML string sinks at all');
  assert.match(js, /if \(k === 'text'\) e\.textContent = v/, 'the one element helper sets text with textContent');
  // The manifest text goes through that helper.
  for (const field of ['e.text', 'e.transcript', 's.firstWords']) assert.ok(new RegExp(`text: [^\\n]*${field.replace('.', '\\.')}`).test(js), field + ' is set as text');
});

test('the menus show Recordings only when an agent has recordings.canDownload === true', () => {
  const idx = read('index.html'), mob = read('mobile.html'), app = read('app.js'), mjs = read('mobile.js');
  assert.match(idx, /id="recordings-item" class="more-item" role="menuitem"[^>]*style="display:none"[^>]*location\.href = '\/recordings'/, 'hidden until shown');
  assert.match(mob, /<a id="menu-recordings" href="\/recordings\?from=mobile" hidden>/);
  assert.match(app, /getElementById\('recordings-item'\); if \(ri\) ri\.style\.display = AGENTS\.some\(a => a && a\.recordings && a\.recordings\.canDownload === true\) \? '' : 'none'/);
  assert.match(mjs, /\$\('menu-recordings'\); if \(ri\) ri\.hidden = !agents\.some\(a => a && a\.recordings && a\.recordings\.canDownload === true\)/);
  // The desktop ⋯ menu entry sits with the other more-menu items; the phone's with the ⋮ menu.
  assert.ok(idx.indexOf('id="recordings-item"') > idx.indexOf('id="more-menu"') && idx.indexOf('id="recordings-item"') < idx.indexOf('id="restart-hub-btn"'));
  assert.ok(mob.indexOf('id="menu-recordings"') > mob.indexOf('<div id="menu">'));
});

// removed (P4-2): 'agent settings: the Call recordings section saves the six fields and loads the accounts list' pinned the old page's source (the owner-only gate included);
// the card's Call recordings rows (OPT-0033, 0035-0038, with the owner-only gate and the accounts list) are tested in test/ui-agent-card-basics.test.js.
