'use strict';
// Source-level checks for the multi-user UI: owner switcher, account menu, member view,
// 401 -> /login redirect (desktop app.js / index.html, mobile mobile.js / mobile.html / sw.js). Offline.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const app = read('app.js');
const html = read('index.html');
const mobile = read('mobile.js');
const mhtml = read('mobile.html');
const sw = read('sw.js');

test('desktop reads /api/me and lists agents by owner, remembering the choice', () => {
  assert.match(app, /fetch\('\/api\/me'/);
  assert.match(app, /window\.hubMe\s*=/);
  assert.match(app, /\/api\/agents'\s*\+\s*ownerQuery/);
  assert.match(app, /\?owner=\$\{encodeURIComponent\(ownerView\(\)\)\}/);
  assert.ok(app.includes("'hub-owner-view'"), 'persisted in localStorage');
  assert.match(app, /localStorage\.setItem\(OWNER_VIEW_KEY, sel\.value\)/);
});

test('owner switcher sits outside #agent-list and only admins get it', () => {
  const sel = html.indexOf('id="owner-view"');
  const list = html.indexOf('id="agent-list"');
  assert.ok(sel > 0 && list > 0 && sel < list, 'select precedes the agent list');
  assert.doesNotMatch(html.slice(sel, list), /<div id="agent-list"/, 'select is not inside the list');
  assert.match(app, /if \(!me \|\| !me\.isAdmin\) \{ sel\.style\.display = 'none'; return; \}/);
  assert.match(app, /\['mine', 'Mine'\], \['infra', 'Infrastructure'\]/);
  assert.match(app, /`\$\{o\.name\} \(\$\{o\.count\}\)`/);
});

test('chat tabs of other owners\' agents carry the owner name', () => {
  assert.match(app, /function agentOwnerSuffix\(/);
  assert.match(app, /class="tab-owner"/);
});

test('any API 401 sends the browser to /login with next=, except the password checks', () => {
  assert.match(app, /window\.fetch = async function/);
  assert.match(app, /res\.status === 401/);
  assert.match(app, /location\.href = '\/login\?next=' \+ encodeURIComponent\(location\.pathname \+ location\.search\)/);
  for (const p of ['/api/auth/totp/disable', '/api/auth/password']) assert.ok(app.includes(p) && mobile.includes(p), `${p} keeps its own 401 handling`);
});

test('user chip and account menu: Security, Users (admin), Sign out, admin 2FA nudge', () => {
  assert.ok(html.includes('id="user-chip"'));
  assert.ok(html.includes('id="account-menu"'));
  assert.match(html, /href="\/users"/);
  assert.match(html, /Two-factor is required for admins: /);
  assert.match(app, /fetch\('\/api\/auth\/logout', \{ method: 'POST'/);
  assert.match(app, /location\.href = '\/login'/);
  assert.match(app, /get\('security'\) === '1'\) openSecurityDialog\(\)/);
});

test('Security dialog covers 2FA enrol / disable, password change and sign out everywhere', () => {
  assert.ok(app.includes('/api/auth/totp/begin'));
  assert.ok(app.includes('/api/auth/totp/confirm'));
  assert.ok(app.includes('/api/auth/totp/disable'));
  assert.ok(app.includes('/api/auth/password'));
  assert.ok(app.includes('/api/auth/sessions/revoke'));
  assert.match(app, /qrcode\.svg\(d\.uri/);
  assert.ok(app.includes('/vendor/qrcode.min.js'));
  assert.match(app, /d\.recoveryCodes/);
  assert.match(app, /function copyRecoveryCodes\(/);
});

test('members: admin surfaces are hidden and approvals / Resume buttons are not rendered', () => {
  assert.match(app, /function applyMemberView\(\) \{[^]*?if \(!me \|\| me\.isAdmin\) return;/);
  for (const id of ['comms-btn', 'wallet-btn', 'dream-btn', 'git-sync-btn', 'restart-hub-btn', 'advanced-toggle', 'settings-btn', 'schedule-btn', 'spend-today', 'more-wrap']) {
    assert.ok(app.includes(`'${id}'`), `${id} is hidden for members`);
    assert.ok(html.includes(`id="${id}"`), `${id} exists in index.html`);
  }
  // The ⋯ menu as a whole, the Tiger Team and Guide tabs and the tab strip are hidden for members.
  assert.match(app, /for \(const t of \['group-chat', 'guide'\]\)/);
  assert.match(app, /document\.querySelector\('\.sidebar \.tabs'\)[^]*?style\.display = 'none'/);
  assert.match(app, /const groupActions = !isHubAdmin\(\) \? ''/);
  assert.match(app, /\$\{isHubAdmin\(\) \? `<span class="action-btn gear-btn"/);
  assert.match(app, /function upsertApproval\(ev\) \{\s*if \(!ev \|\| !ev\.id\) return;\s*if \(!isHubAdmin\(\)\) return;/);
  assert.match(app, /if \(!isHubAdmin\(\)\) return;\s*\/\/ approvals are an admin surface/);
  assert.match(app, /if \(!isHubAdmin\(\)\) btn\.style\.display = 'none'/);
  assert.match(app, /if \(!isHubAdmin\(\)\) bar\.querySelector\('#hub-halt-resume'\)/);
});

test('mobile: owner query, Security sheet, sign out, member gating, 401 redirect', () => {
  assert.match(mobile, /\/api\/agents' \+ \(hubMe && hubMe\.isAdmin \? `\?owner=\$\{encodeURIComponent\(ownerView\(\)\)\}`/);
  assert.ok(mobile.includes("'hub-owner-view'"));
  assert.match(mobile, /res\.status === 401/);
  assert.match(mobile, /location\.href = '\/login\?next=' \+ encodeURIComponent/);
  assert.ok(mobile.includes('/api/auth/logout'));
  assert.ok(mobile.includes('/api/auth/totp/confirm'));
  assert.ok(mobile.includes('/vendor/qrcode.min.js'));
  assert.ok(mhtml.includes('id="owner-view"'));
  assert.ok(mhtml.includes('id="menu-security"'));
  assert.ok(mhtml.includes('id="menu-signout"'));
  assert.ok(mhtml.includes('id="security-sheet"'));
  assert.ok(mhtml.includes('id="agents-menu-btn"'));
  assert.ok(mobile.includes("if (hubMe && !hubMe.isAdmin) { $('menu-restart').hidden = true; $('menu-update').hidden = true; }"), 'members get neither Restart nor Update in the menu');
  assert.match(mobile, /function applyApprovals\(list\) \{\n  if \(!Array\.isArray\(list\)\) return;\n  if \(!isAdmin\(\)\) return;/);
  assert.match(mobile, /function confirmPacingReset\(\) \{\n  if \(!pacing\.size \|\| !isAdmin\(\)\) return;/);
});

test('service worker version bumped so phones pick up the new mobile.js', () => {
  assert.match(sw, /const VERSION = 'hub-mobile-v57';/);
});
