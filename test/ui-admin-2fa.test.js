'use strict';
// Source-level checks for the admin two-factor switch: Settings, Security; the Security dialog / sheet; the menu nudge;
// the Users page. Offline.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const app = read('app.js');
const mobile = read('mobile.js');
const users = read('users.html');

// The text of one function, up to the next function declaration.
const body = (src, head) => {
  const i = src.indexOf(head);
  assert.ok(i >= 0, `${head} exists`);
  const rest = src.slice(i + head.length);
  const m = rest.search(/\n {0,4}(async )?function /);
  return head + (m < 0 ? rest : rest.slice(0, m));
};

test('Settings has a Security group after Status with the st-security-section', () => {
  assert.match(app, /\{ id: 'security', title: '🔐 Security', sections: \['st-security-section'\] \}/);
  assert.ok(app.indexOf("id: 'status'") < app.indexOf("id: 'security'"));
  assert.ok(app.indexOf("id: 'security'") < app.indexOf("id: 'backups'"));
  assert.ok(app.includes('id="st-security-section"'));
  assert.ok(app.includes('Require two-factor sign-in for admins'));
  assert.ok(app.includes('Opening My Maestro directly to your network still needs an admin with two-factor. Members choose for themselves.'));
  assert.match(app, /isHubAdmin\(\)\) \{\s*html \+= `<div class="st-section" id="st-security-section"/);
});

test('the switch is read from /api/me and the summary follows it', () => {
  const paint = body(app, 'async function stAdmin2faPaint()');
  assert.match(paint, /fetch\('\/api\/me'/);
  assert.match(paint, /admin2faRequired === false/);
  assert.ok(app.includes("'Two-factor required for admins'") && app.includes("'Two-factor optional for admins'"));
  assert.ok(app.includes("Admins who have two-factor can\\'t remove it from their own account. An admin without it is asked to set it up."));
  assert.ok(app.includes('An admin may remove two-factor from their own account and then signs in with a password alone.'));
});

test('unchecking opens the confirm panel instead of posting', () => {
  const toggle = body(app, 'function stAdmin2faToggle(box)');
  assert.match(toggle, /box\.checked = true;[^\n]*\n\s*stAdmin2faAsk\(\)/);
  assert.doesNotMatch(toggle.slice(0, toggle.indexOf('stAdmin2faSend({ required: true }')), /stAdmin2faSend/);
  const ask = body(app, 'function stAdmin2faAsk()');
  assert.ok(ask.includes("Allow admins to remove their own two-factor? An admin who removes it signs in with a password alone, so anyone who learns that password could sign in as that admin."));
  assert.match(ask, /type="password" id="st-a2fa-pw" autocomplete="current-password"/);
  assert.match(ask, /me\.user\.totpEnabled \? '<div class="st-row"><label[^']*<input type="text" id="st-a2fa-code" inputmode="numeric" autocomplete="one-time-code" placeholder="123456 or a recovery code">/);
  assert.match(ask, /background:#b71c1c[^>]*onclick="stAdmin2faOff\(\)">Turn it off</);
  assert.match(ask, /stAdmin2faCancel\(\)">Cancel</);
});

test('the confirm posts required:false with password and code; checking posts required:true', () => {
  const off = body(app, 'function stAdmin2faOff()');
  assert.match(off, /required: false, password/);
  assert.match(off, /body\.code = /);
  assert.match(body(app, 'function stAdmin2faToggle(box)'), /stAdmin2faSend\(\{ required: true \}, true\)/);
  const send = body(app, 'async function stAdmin2faSend(body, turningOn)');
  assert.match(send, /fetch\('\/api\/security\/admin-2fa', \{ method: 'POST'/);
  assert.match(send, /stAdmin2faBusy\(true\)/);
  assert.match(send, /\.value = ''/, 'password and code cleared after every answer');
  assert.match(send, /if \(turningOn\)[^\n]*checked = false/, 'box put back on an error');
  assert.ok(app.includes('Two-factor is now optional for admins. Your own two-factor stays on until you remove it in your account menu, Security.'));
  assert.match(body(app, 'function stAdmin2faMsg('), /textContent = text/, 'server text is not parsed as HTML');
});

test('the desktop Security dialog hides the disable controls for an admin while required', () => {
  const paint = body(app, 'function paintTwoFactor(stage)');
  assert.match(paint, /adminLocked = me\.isAdmin && me\.admin2faRequired !== false/);
  assert.ok(paint.includes('Admins can\'t remove it while "Require two-factor sign-in for admins" is on in Settings, 🔐 Security.'));
  assert.match(paint, /adminLocked \? `<div class="sec-hint">[^`]*` : `[\s\S]*sec-2fa-password[\s\S]*disableTwoFactor\(\)/);
  assert.match(paint, /id="sec-2fa-disable-code" inputmode="numeric" autocomplete="one-time-code" placeholder="123456 or a recovery code"/);
  assert.ok(paint.includes('Remove two-factor'));
  const dis = body(app, 'async function disableTwoFactor()');
  assert.match(dis, /body\.code = /);
  assert.match(dis, /authPost\('\/api\/auth\/totp\/disable', body\)/);
  assert.match(dis, /fetch\('\/api\/me'/, 're-read after a removal');
  assert.match(dis, /secMsg\('sec-2fa-msg', e\.message\)/);
  assert.ok(app.includes("p === '/api/auth/totp/disable'"), 'keepsOwn401 stays');
});

test('the account menu nudge depends on admin2faRequired', () => {
  assert.match(app, /note\.style\.display = \(me\.isAdmin && !me\.user\.totpEnabled && me\.admin2faRequired !== false\)/);
});

test('mobile.js has the same rules', () => {
  const paint = body(mobile, 'function paintTwoFactor()');
  assert.match(paint, /adminLocked = hubMe\.isAdmin && hubMe\.admin2faRequired !== false/);
  assert.ok(paint.includes('in Settings, Security on a computer.'));
  assert.match(paint, /id="sec-2fa-disable-code" inputmode="numeric" autocomplete="one-time-code" placeholder="123456 or a recovery code"/);
  assert.ok(paint.includes('Remove two-factor'));
  assert.match(paint, /if \(!adminLocked\) \$\('sec-2fa-disable'\)/);
  const dis = body(mobile, 'async function disableTwoFactor()');
  assert.match(dis, /body\.code = /);
  assert.match(dis, /authPost\('\/api\/auth\/totp\/disable', body\)/);
  assert.match(dis, /await loadMe\(\)/);
  assert.equal(mobile.split('totpEnabled && hubMe.admin2faRequired !== false)').length - 1, 2, 'both menu-note spots');
  assert.doesNotMatch(mobile, /admin-2fa/, 'the phone has no Settings toggle');
});

test('Users page disables the own-row Reset 2FA', () => {
  assert.match(users, /data-act="totp" \$\{self \? 'disabled title="Use Security in your account menu"'/);
  assert.match(users, /setMsg\(msgId, e\.message, 'error'\)/);
});

test('the account forms clear the password and code before the request, one removal at a time; the reminder follows the switch', () => {
  for (const f of ['app.js', 'mobile.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    const fn = src.slice(src.indexOf('async function disableTwoFactor()'), src.indexOf('async function disableTwoFactor()') + 1400);
    const clear = fn.indexOf("pwEl.value = ''; if (codeEl) codeEl.value = '';");
    assert.ok(clear > 0 && clear < fn.indexOf("authPost('/api/auth/totp/disable'"), f + ': fields cleared before the request');
    assert.ok(fn.includes('if (secDisableBusy) return;') && fn.includes('finally { secDisableBusy = false; }'), f + ': one at a time');
  }
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const send = app.slice(app.indexOf('async function stAdmin2faSend('), app.indexOf('function groupSettings('));
  assert.ok(send.includes('renderUserChip();'), 'the account menu reminder is repainted after the switch changes');
});

test('the Security section saves itself, so closing Settings never asks to discard it', () => {
  assert.ok(app.includes('<div class="st-section" id="st-security-section" data-no-dirty>'));
});
