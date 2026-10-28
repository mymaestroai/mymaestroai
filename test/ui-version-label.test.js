'use strict';
// The version label and the About box: GET /api/version (lib/hub-map versionInfo, signed-in users only, no secrets),
// the label formatter and the About box's text helpers (lib/ui-version-label.js, carried verbatim by app.js and
// mobile.js), and the wiring in the desktop and phone pages (source pins, as in the other ui-*.test.js files).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHubMap } = require('../lib/hub-map');
const { classifyRoute } = require('../lib/access');
const vl = require('../lib/ui-version-label');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const BEGIN = '// ── version-label helpers (begin) ──';
const END = '// ── version-label helpers (end) ──';
function helperBlock(src, indent) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  assert.ok(a > 0 && b > a, 'helper markers present');
  return src.slice(a + BEGIN.length, b).split('\n').map(l => (indent && l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n').trim();
}

function hubMap(over = {}) {
  return createHubMap({ root: ROOT, startedAt: new Date('2026-10-26T20:00:00Z'), gitInfo: '2522a10 2026-10-26', gitBranch: 'dev', version: '5.7.3', ...over });
}
const KEYS = ['version', 'channel', 'branch', 'commit', 'commitDate', 'startedAt', 'node', 'restartPending'];

test('versionInfo: exactly the documented fields, from the facts the lead brief already uses', () => {
  const v = hubMap().versionInfo();
  assert.deepStrictEqual(Object.keys(v), KEYS);
  assert.deepStrictEqual(v, { version: '5.7.3', channel: 'experimental', branch: 'dev', commit: '2522a10', commitDate: '2026-10-26',
    startedAt: '2026-10-26T20:00:00.000Z', node: process.versions.node, restartPending: v.restartPending });
  assert.strictEqual(typeof v.restartPending, 'boolean');
  assert.strictEqual(hubMap({ gitBranch: 'main' }).versionInfo().channel, 'stable');
  const other = hubMap({ gitBranch: 'feature/x' }).versionInfo();
  assert.strictEqual(other.channel, null, 'a branch that is no channel has no channel');
  assert.strictEqual(other.branch, 'feature/x');
  const nogit = hubMap({ gitInfo: '' }).versionInfo();
  assert.deepStrictEqual([nogit.commit, nogit.commitDate, nogit.branch, nogit.channel], [null, null, null, null], 'no git: nulls, not empty strings');
});

test('versionInfo: nothing secret or identifying (no paths, host or user names, keys)', () => {
  const v = hubMap().versionInfo();
  const json = JSON.stringify(v);
  for (const s of [ROOT, os.homedir(), os.hostname(), os.userInfo().username, '/Users/', '/home/']) assert.ok(!json.includes(s), `contains ${s}`);
  for (const k of Object.keys(v)) assert.ok(!/key|token|secret|password|path|dir|host|user|pid/i.test(k), k);
});

test('versionInfo: restartPending follows the code-change scan (code newer than the process start)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-version-'));
  try {
    fs.mkdirSync(path.join(tmp, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'lib', 'x.js'), '//');
    assert.strictEqual(hubMap({ root: tmp, startedAt: new Date(Date.now() - 600 * 1000) }).versionInfo().restartPending, true);
    assert.strictEqual(hubMap({ root: tmp, startedAt: new Date(Date.now() + 60 * 1000) }).versionInfo().restartPending, false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('/api/version: signed-in users (not public, not admin-only); the server answers it from hub-map', () => {
  assert.deepStrictEqual(classifyRoute('/api/version', 'GET'), { kind: 'session' });
  assert.ok(read('docs/HUB-MAP.md').includes('`/api/version` (signed-in users; the About box)'), 'in the API quick reference');
  const server = read('server.js');
  const at = server.indexOf("pathname === '/api/version' && req.method === 'GET'");
  assert.ok(at > 0, 'route present');
  assert.ok(server.slice(at, at + 300).includes("require('./lib/hub-map').getHubMap().versionInfo()"), 'answers with versionInfo, nothing added');
});

test('the version-label helpers are byte-identical in lib/ui-version-label.js, app.js and mobile.js', () => {
  const lib = helperBlock(read('lib/ui-version-label.js'), '');
  assert.strictEqual(helperBlock(read('app.js'), '    '), lib, 'app.js copy differs from lib/ui-version-label.js');
  assert.strictEqual(helperBlock(read('mobile.js'), ''), lib, 'mobile.js copy differs from lib/ui-version-label.js');
  for (const fn of ['versionLabel', 'updateStatusText', 'versionDetailsText']) assert.ok(lib.includes(`function ${fn}(`), fn);
});

test('versionLabel: stable, experimental (-dev and the short sha), other branches, and nothing without a version', () => {
  const base = { version: '5.7.3', commit: '2522a10', commitDate: '2026-10-26', node: '22.23.4', restartPending: false };
  assert.deepStrictEqual(vl.versionLabel({ ...base, channel: 'stable', branch: 'main' }).text, 'v5.7.3 · stable');
  assert.strictEqual(vl.versionLabel({ ...base, channel: 'stable', branch: 'main' }).kind, 'stable');
  const exp = vl.versionLabel({ ...base, channel: 'experimental', branch: 'dev' });
  assert.deepStrictEqual([exp.text, exp.kind], ['v5.7.3-dev · 2522a10', 'experimental']);
  assert.strictEqual(vl.versionLabel({ ...base, channel: 'experimental', branch: 'dev', commit: null }).text, 'v5.7.3-dev');
  const other = vl.versionLabel({ ...base, channel: null, branch: 'feature/version-label' });
  assert.deepStrictEqual([other.text, other.kind], ['v5.7.3 · feature/version-label · 2522a10', 'other']);
  assert.strictEqual(vl.versionLabel({ ...base, channel: null, branch: null, commit: null }).text, 'v5.7.3 · no branch');
  assert.strictEqual(vl.versionLabel(null), null);
  assert.strictEqual(vl.versionLabel({ ...base, version: null }), null);
  assert.strictEqual(vl.versionLabel({ ...base, channel: 'experimental', commit: '0123456789abcdef0123' }).text, 'v5.7.3-dev · 0123456789ab', 'sha capped');
});

test('updateStatusText: the About box line from GET /api/update-check', () => {
  assert.strictEqual(vl.updateStatusText(null), null, 'no update check (members): no line');
  assert.strictEqual(vl.updateStatusText({ enabled: true, available: false, checkedAt: '2026-10-26T20:00:00Z' }), 'Up to date');
  assert.strictEqual(vl.updateStatusText({ enabled: true, available: false, checkedAt: null }), 'Not checked yet');
  assert.strictEqual(vl.updateStatusText({ enabled: true, available: true, currentVersion: '5.7.3', latestVersion: '5.8.0', behind: 4 }), '5.8.0 available');
  assert.strictEqual(vl.updateStatusText({ enabled: true, available: true, currentVersion: '5.7.3', latestVersion: '5.7.3', behind: 3 }), '3 new changes available');
  assert.strictEqual(vl.updateStatusText({ enabled: true, available: true, latestVersion: null, behind: 1 }), '1 new change available');
  assert.strictEqual(vl.updateStatusText({ enabled: false, available: true }), 'Check off');
  assert.strictEqual(vl.updateStatusText({ enabled: true, available: false, error: 'offline', checkedAt: 'x' }), 'Check failed: offline');
});

test('versionDetailsText: one fact per line for bug reports; no "undefined", the update line only when there is one', () => {
  const v = { version: '5.7.3', channel: 'experimental', branch: 'dev', commit: '2522a10', commitDate: '2026-10-26', startedAt: '2026-10-26T20:00:00.000Z', node: '22.23.4', restartPending: true };
  const t = vl.versionDetailsText(v, { enabled: true, available: false, checkedAt: 'x' }, 'TestAgent/1.0');
  assert.strictEqual(t, ['My Maestro AI 5.7.3', 'Channel: experimental (branch dev)', 'Commit: 2522a10 (2026-10-26)', 'Hub started: 2026-10-26 20:00 UTC',
    'Node.js: 22.23.4', 'Restart pending: yes (code on disk is newer than the running hub)', 'Update: Up to date', 'Browser: TestAgent/1.0'].join('\n'));
  const bare = vl.versionDetailsText({}, null, '');
  assert.ok(!/undefined|null|NaN/.test(bare), bare);
  assert.ok(!bare.includes('Update:') && !bare.includes('Browser:'));
});

test('desktop: the label sits under the title and opens About; About is the first item of the ⋯ menu', () => {
  const html = read('index.html');
  const h1 = html.indexOf('<h1>🟦 My Maestro AI</h1>');
  const label = html.indexOf('id="hub-version"');
  assert.ok(h1 > 0 && label > h1 && label - h1 < 200, 'label right under the title');
  assert.ok(/<button type="button" id="hub-version"[^>]*onclick="openAboutDialog\(\)"/.test(html));
  const menu = html.slice(html.indexOf('id="more-menu"'));
  assert.ok(menu.indexOf('class="more-item"') === menu.indexOf('id="about-btn" class="more-item"') + 'id="about-btn" '.length, 'About is the first menu item');
  assert.ok(menu.includes('openAboutDialog()'));
  const app = read('app.js');
  for (const s of ['async function paintVersionLabel()', 'async function openAboutDialog()', "fetch('/api/version'", 'paintVersionLabel().catch(() => {});', 'versionDetailsText(v, u, navigator.userAgent)']) assert.ok(app.includes(s), s);
  assert.ok(app.includes('Restart pending: code on disk is newer than the running hub'), 'the dot explains itself');
});

test('phone: About (with the label) is the first item of the ⋮ menu and opens its sheet', () => {
  const html = read('mobile.html');
  const menu = html.slice(html.indexOf('<div id="menu">'));
  const firstLink = Math.min(...['<a ', '<button '].map(t => { const i = menu.indexOf(t); return i < 0 ? Infinity : i; }));
  assert.strictEqual(menu.indexOf('<button id="menu-about">'), firstLink, 'About is the first item');
  assert.ok(menu.includes('id="menu-version"'));
  assert.ok(html.includes('<dialog id="about-sheet"'));
  const js = read('mobile.js');
  assert.ok(read('sw.js').includes("const VERSION = 'hub-mobile-v60';"), 'service worker cache bumped so phones load the new menu');
  for (const s of ["$('menu-about').addEventListener('click'", "$('about-sheet').addEventListener('click', onAboutClick)", "api('/api/version')", 'versionDetailsText(v, u, navigator.userAgent)']) assert.ok(js.includes(s), s);
});
