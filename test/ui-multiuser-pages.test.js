'use strict';
// Source-level checks for the multi-user pages: login.html (sign-in / first admin / invite),
// users.html (admin user management) and the owner & sharing section of agent-settings.html. Offline.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const login = read('login.html');
const users = read('users.html');

test('login.html: sign-in, two-factor, first-admin setup and invite acceptance all talk to /api/auth', () => {
  assert.ok(login.includes("fetch('/api/auth/status'"), 'reads the auth status to pick the mode');
  assert.ok(login.includes("post('/api/auth/login', { login, password })"));
  assert.ok(login.includes("post('/api/auth/totp/verify', { code, trust: $('totp-trust').checked })"), 'code step sends trust');
  assert.ok(!login.includes("/api/auth/setup"), 'the first account is created on the Welcome page, with the setup code');
  assert.ok(login.includes("if (status.setupNeeded) { location.replace('/welcome' + location.search); return; }"), 'a fresh hub sends sign-in to the Welcome page');
  assert.ok(login.includes("post('/api/auth/invite/accept', { token, password, name })"));
  assert.ok(login.includes('/api/auth/invite?token='), 'invite details come from the token');
  assert.ok(login.includes("credentials: 'include'"), 'cookies carry the session');
  for (const id of ['f-login', 'f-totp', 'f-invite', 'f-invite-bad']) assert.ok(login.includes(`id="${id}"`), `form ${id}`);
});

test('login.html: needsTotp shows the code step, recovery codes widen the input, trust checkbox, next param', () => {
  assert.match(login, /if \(res\.body\.needsTotp\) \{ show\('f-totp'\); return; \}/);
  assert.ok(login.includes('id="totp-trust"') && login.includes('Trust this browser for 30 days'));
  assert.ok(login.includes('id="totp-recovery"') && login.includes("inp.placeholder = 'ab12-cd34'"), 'recovery link widens the input');
  assert.ok(login.includes("params.get('next')"));
  assert.ok(!/Android\|iPhone/.test(login) && !login.includes("'/mobile' : '/'"), 'the destination does not test the user agent: the phone-layout script on "/" moves phones');
  assert.ok(login.includes("needsTotpEnrol ? '/?security=1'"), 'admin invitees enrol a second factor');
  assert.ok(login.includes('at least 12 characters') && login.includes('minlength="12"'));
  assert.match(login, /btn\.disabled = true;[\s\S]*finally \{ btn\.disabled = false; \}/, 'submit disabled while a request is in flight');
  assert.ok(login.includes("if (res.body && res.body.error) return res.body.error;"), 'server error text shown as is');
  assert.ok(login.includes('Too many attempts'), '429 lockout message');
  assert.ok(!login.includes('app.js'), 'standalone page');
});

test('users.html: lists users and invites, runs every per-user action and shows the invite link with a Copy button', () => {
  assert.ok(users.includes("api('/api/users')"), 'GET /api/users');
  assert.ok(users.includes("api('/api/users', { method: 'POST', body })"), 'invite and create-with-password POST');
  assert.ok(users.includes('{ invite: true, login:'), 'invite body');
  assert.ok(users.includes("api(`/api/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch })"), 'edit name/role');
  assert.ok(users.includes("{ method: 'PATCH', body: { disabled } }"), 'disable / enable');
  assert.ok(users.includes("api(`/api/users/${encodeURIComponent(id)}`, { method: 'DELETE' })"), 'delete');
  assert.ok(users.includes("api(`/api/users/${encodeURIComponent(id)}/password`"), 'set password');
  assert.ok(users.includes("api(`/api/users/${encodeURIComponent(id)}/totp/reset`"), 'reset 2FA');
  assert.ok(users.includes("api(`/api/users/${encodeURIComponent(id)}/team`"), 'create team');
  assert.ok(users.includes('value="medical"') && users.includes('value="legal"'), 'team templates');
  assert.ok(users.includes("api('/api/users/invite', { method: 'DELETE', body: { login } })"), 'revoke invite');
  assert.ok(users.includes("api('/api/users/audit')"), 'audit log');
  assert.ok(users.includes('id="audit-refresh"') && users.includes('.slice(0, 200)'), 'last 200 newest first with a Refresh button');
  assert.ok(users.includes('id="invite-link"') && users.includes('id="invite-copy"') && users.includes('navigator.clipboard.writeText'), 'invite link + Copy');
  assert.ok(users.includes('become infrastructure agents'), 'delete explains what happens to their agents');
  assert.ok(users.includes('← Back to hub'));
  assert.ok(!users.includes('alert('), 'errors are shown inline');
  assert.ok(users.includes("location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`"), '401 goes to login');
  assert.match(users, /await loadUsers\(\);\s*loadAudit\(\);/, 'table reloads after every action');
});

test('users.html: Requests section lists pending agent requests and approves or declines them', () => {
  assert.ok(users.includes("api('/api/agent-requests')"), 'fetches the agent requests');
  assert.ok(users.includes("api(`/api/agent-requests/${encodeURIComponent(id)}`, { method: 'POST', body })"), 'posts the decision to /api/agent-requests/<id>');
  assert.ok(users.includes('id="requests-section"') && users.includes('No requests waiting'));
  assert.ok(users.includes('data-act="approve"') && users.includes('data-act="decline"'));
  assert.ok(users.includes('placeholder="note to the requester, optional"'), 'optional note per row');
  assert.ok(users.includes('id="requests-recent"') && users.includes('.slice(0, 20)'), 'recent decisions, last 20');
  const usersIdx = users.indexOf('id="users-section"'), reqIdx = users.indexOf('id="requests-section"'), invIdx = users.indexOf('id="invite-section"');
  assert.ok(usersIdx < reqIdx && reqIdx < invIdx, 'Requests sits between the Users table and the Invite form');
});

// removed (P4-2): 'agent-settings.html: owner select and shared-with checkboxes PATCH the agent and read /api/users' pinned the old page's source; the card's Owner and
// Shared with rows (OPT-0006, OPT-0007) read /api/users and PATCH {owner} / {sharedWith} - test/ui-agent-card-basics.test.js (owner and sharing under More).

test('vendor/qrcode.min.js ships with the pages', () => {
  const p = path.join(root, 'vendor', 'qrcode.min.js');
  assert.ok(fs.existsSync(p));
  const src = fs.readFileSync(p, 'utf8');
  assert.ok(src.includes('qrcode.svg(text, { size, margin, dark, light })'), 'documented API');
});

test('server: the Welcome page takes over "/" only while the hub has no accounts; the old setup pages redirect to it', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(server.includes("if (!hubAuth.hasUsers()) { res.writeHead(302, { Location: '/welcome' }); return res.end(); }"));
  assert.ok(server.includes("} else if (pathname === '/setup' || pathname === '/setup-admin') {") && server.includes("res.writeHead(302, { Location: '/welcome' + qs }); return res.end();"));
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'setup.html')), 'the old provider wizard is gone');
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.ok(!app.includes('hub-setup-notice'), 'the old no-provider banner is gone (P4-15)');
  const review = require('../lib/ui-review.js').build({ setup: { setupNeeded: true } });
  assert.deepStrictEqual(review.fix.map((p) => [p.id, p.title, p.fix.href]), [['provider', 'No AI provider is connected', '/welcome']], 'the hub page tells an admin when no provider is configured: a Fix now item with the Welcome link');
});

// destination() cut out of login.html and run with a stubbed location: only a same-site path is followed.
test('login.html: next is followed only for a same-site path (one leading slash, no backslash or control character)', () => {
  const m = login.match(/function destination\(\) \{[\s\S]*?\n  \}\n/);
  assert.ok(m, 'destination() found');
  const run = (nextValue) => new Function('next', 'location', `${m[0]}\nreturn destination();`)(nextValue, { origin: 'https://hub.example' });
  const tok = 'A'.repeat(43);
  assert.equal(run(`/s/${tok}`), `/s/${tok}`);
  assert.equal(run('/mobile?x=1'), '/mobile?x=1');
  assert.equal(run('/%5Cevil'), '/%5Cevil', 'percent-encoded stays a path on this origin');
  for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', '/a\nb', '/a\\b', '/a\u0000b', '', 'evil', '/\t/evil.example']) assert.equal(run(bad), '/', JSON.stringify(bad));
});
