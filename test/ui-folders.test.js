'use strict';
// Shared-folder grants: lib/folders (the list behind GET /api/folders) against fake agents and admins, the
// route wiring in server.js, the "Shared folders" picker on agent-settings.html, and the read-only sandbox
// line on the Settings page. Source-string pins follow the ui-*.test.js pattern.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { listFolders, resolveRoots } = require('../lib/folders');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const server = read('server.js');
const page = read('agent-settings.html');
const app = read('app.js');

const AGENTS = [
  { name: 'maestro' },                                  // infrastructure (no owner)
  { name: 'doc', owner: 'u_admin' },                    // admin-owned
  { name: 'sam', owner: 'u_member' },                   // member-owned: never listed
  { name: 'zed', owner: 'u_admin', policy: { roots: ['~/projects', '/h/share/common'] } },
];
const EXISTS = new Set(['/h/share/common', '/h/medical', '/h/legal', '/r/workspaces/maestro', '/r/workspaces/doc', '/h/users/u_member/files', '/r/data']);
const rig = () => listFolders({ agents: AGENTS, adminIds: new Set(['u_admin']), hubHome: '/h', hubRoot: '/r', exists: (p) => EXISTS.has(p) });

test('listFolders: common, team, files and workspace entries with the right labels, admin-side agents only', () => {
  const out = rig();
  assert.deepStrictEqual(out.map(f => f.kind), ['common', 'team', 'team', 'files', 'files', 'files', 'workspace', 'workspace']);
  assert.deepStrictEqual(out.filter(f => f.kind === 'team').map(f => f.label), ['Medical team folder', 'Legal team folder']);
  assert.deepStrictEqual(out.filter(f => f.kind === 'files').map(f => f.label), ['Files of doc', 'Files of maestro', 'Files of zed']);
  assert.deepStrictEqual(out.filter(f => f.kind === 'workspace').map(f => f.path), ['/r/workspaces/doc', '/r/workspaces/maestro']);
  assert.strictEqual(out.find(f => f.kind === 'common').path, '/h/share/common');
  for (const f of out) assert.ok(path.isAbsolute(f.path), `absolute: ${f.path}`);
});

test('listFolders: never a member tree, never data/, nothing for a member-owned agent', () => {
  const out = rig();
  assert.ok(!out.some(f => f.path.includes('/users/')), 'no users/<id> paths');
  assert.ok(!out.some(f => f.path.includes('/data')), 'no data/ paths');
  assert.ok(!out.some(f => /\bsam\b/.test(f.label) || f.path.endsWith('/sam')), 'member agent sam is not listed');
  // Team and common folders only when they exist; workspaces only when they exist.
  const none = listFolders({ agents: AGENTS, adminIds: new Set(['u_admin']), hubHome: '/h', hubRoot: '/r', exists: () => false });
  assert.deepStrictEqual(none.map(f => f.kind), ['files', 'files', 'files']);
});

test('resolveRoots expands ~ and resolves, keeping order (the page matches extraRoots[i] to granted[i])', () => {
  assert.deepStrictEqual(resolveRoots(['~/x', '/a/../b', 'rel/p'], '/home/me'), ['/home/me/x', '/b', path.resolve('rel/p')]);
  assert.deepStrictEqual(resolveRoots(undefined), []);
});

test('server.js: GET /api/folders wired before the sandbox routes, admin-side by lib/auth admins(), ?agent adds granted', () => {
  assert.match(server, /if \(pathname === '\/api\/folders' && req\.method === 'GET'\) \{/);
  assert.match(server, /const \{ listFolders, resolveRoots \} = require\('\.\/lib\/folders'\);/);
  assert.match(server, /const adminIds = new Set\(hubAuth\.admins\(\)\.map\(u => String\(u\.id\)\)\);/);
  assert.match(server, /out\.granted = resolveRoots\(a\.policy && a\.policy\.roots\);/);
  assert.ok(server.indexOf("pathname === '/api/folders'") < server.indexOf("pathname.startsWith('/api/sandbox')"), 'near the sandbox routes');
  // Admin-only: unknown /api paths are admin by default (lib/access classifyRoute).
  const access = require('../lib/access');
  assert.deepStrictEqual(access.classifyRoute('/api/folders'), { kind: 'admin' });
});

test('agent-settings.html: Shared folders picker grouped by kind, pre-ticked from policy.roots, textarea for the rest, save joins both', () => {
  assert.match(page, /<label>Shared folders<\/label>/);
  assert.match(page, /A sandboxed agent sees exactly these folders \(plus its own workspace and Files folder\); changing them rebuilds its container on its next turn\./);
  assert.match(page, /<div id="policy-folders" class="folder-picker">/);
  assert.match(page, /<label>Other folders \(one path per line, <code>~<\/code> allowed\)<\/label>/);
  assert.match(page, /const FOLDER_GROUPS = \[\['common', 'Common'\], \['files', 'Files folders'\], \['team', 'Team folders'\], \['workspace', 'Workspaces'\]\];/);
  assert.match(page, /apiFetch\(`\/api\/folders\?agent=\$\{encodeURIComponent\(agentName\)\}`\)/);
  assert.match(page, /const checked = new Set\(granted\.filter\(p => shown\.has\(p\)\)\);/, 'pre-ticked by resolved absolute path');
  assert.match(page, /ta\.value = \(extraRoots \|\| \[\]\)\.filter\(\(r, i\) => !shown\.has\(granted\[i\]\)\)\.join\('\\n'\);/, 'checkbox paths kept out of the textarea');
  assert.match(page, /<input type="checkbox" data-folder="\$\{escapeHtml\(f\.path\)\}"/);
  assert.match(page, /await loadFolderPicker\(p\.extraRoots \|\| \[\]\);/, 'loaded from the same policy response as the hint');
  assert.match(page, /const roots = \[\.\.\.new Set\(\[\.\.\.pickedFolders\(\), \.\.\.typed\]\)\];/, 'save: checked + typed, deduped');
  assert.match(page, /if \(roots\.length\) policy\.roots = roots;/, 'sent as before');
  assert.match(page, /body: JSON\.stringify\(\{ policy \}\)/, 'PATCH /api/agents/<name> with the policy object');
  assert.match(page, /\.folder-picker \{/);
});

test('Settings page: the sandbox box states who runs on the host and what the defaults mean', () => {
  assert.match(app, /function sandboxNowText\(sbd, toolsDefault\)/);
  assert.match(app, /filter\(a => a && a\.sandbox === 'off'\)\.map\(a => a\.name\)/);
  assert.match(app, /On the host \(no sandbox\): \$\{/);
  assert.match(app, /const hands = toolsDefault === 'hub' \? 'hub hands' : 'client tools \(Claude\/Codex agents\)';/);
  assert.match(app, /const adminWord = \(sbd && sbd\.admin\) === 'container' \? 'sandboxed' : 'on the host';/);
  assert.match(app, /<span id="st-sb-now"[^>]*>\$\{hubEsc\(sandboxNowText\(sbd, data && data\.toolsDefault\)\)\}<\/span>/);
  // The existing controls are untouched.
  assert.match(app, /selSb\('st-sb-member'/); assert.match(app, /selSb\('st-sb-admin'/); assert.match(app, /selSb\('st-tools-default'/);
  assert.match(app, /onclick="saveSandboxDefaults\(\)"/);
});

test('service worker does not precache the two changed pages, so no cache bump is needed', () => {
  const sw = read('sw.js');
  assert.ok(!sw.includes('agent-settings') && !sw.includes("'/app.js'") && !sw.includes('/index.html'), 'app.js and agent-settings.html are not in the precache lists');
});
