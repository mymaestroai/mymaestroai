'use strict';
// The Welcome page (first run), the hand-over to Maestro's setup interview, and Help (desktop ? button, phone menu,
// sign-in page). Source-string tests in the ui-*.test.js pattern.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const welcome = read('welcome.html');
const help = read('help.html');
const app = read('app.js');

test('Welcome: setup code, account, two-factor with recovery codes, one AI, then Maestro', () => {
  for (const id of ['s-code', 's-account', 's-totp', 's-recovery', 's-ai', 's-meet', 's-done', 's-member']) assert.ok(welcome.includes(`id="${id}"`), id);
  assert.match(welcome, /api\('POST', '\/api\/auth\/setup', \{ name, login, password, setupToken: setupCode \}\)/);
  assert.match(welcome, /api\('POST', '\/api\/auth\/totp\/begin', \{\}\)/);
  assert.match(welcome, /api\('POST', '\/api\/auth\/totp\/confirm', \{ code: \$\('t-code'\)\.value\.trim\(\) \}\)/);
  assert.match(welcome, /\$\('codes-go'\)\.disabled = !\$\('codes-ok'\)\.checked/, 'continue only after "I saved these codes"');
  assert.match(welcome, /minlength="12"/, 'matches the account password rule');
  for (const r of ["'/api/welcome/claude-check'", "'/api/welcome/api-key'", "'/api/welcome/local'"]) assert.ok(welcome.includes(r), r);
  assert.match(welcome, /if \(!state\.signedIn\) \{ location\.replace\('\/login\?next=' \+ encodeURIComponent\('\/welcome'\)\); return; \}/);
});

test('Welcome text is never built from markup: replies and errors go in as text', () => {
  const assigns = welcome.match(/innerHTML\s*=[^;]*;/g) || [];
  const allowed = [/^innerHTML = '<span class="spin"><\/span>';$/, /^innerHTML = window\.qrcode\.svg\(res\.body\.uri, \{ size: 168, margin: 2, dark: '#000', light: '#fff' \}\);$/];
  for (const a of assigns) assert.ok(allowed.some(re => re.test(a)), `only the spinner and the QR drawing use innerHTML: ${a}`);
  assert.strictEqual(assigns.length, 2);
  assert.match(welcome, /box\.append\(who, document\.createTextNode\(text\.trim\(\)\)\)/);
});

test('the hand-over: the first message starts the setup interview, then the app opens on Maestro\'s chat', () => {
  assert.match(welcome, /message: '\[First-time setup\] Hello! I just installed My Maestro AI and connected my first AI\. Please start the setup interview\.'/);
  assert.match(welcome, /location\.href = '\/\?agent=' \+ encodeURIComponent\(lead\.name\)/);
  assert.match(app, /const want = new URLSearchParams\(location\.search\)\.get\('agent'\); const a = want && AGENTS\.find\(x => x\.name === want\); if \(a\) startSoloChat\(a\.name, a\.model\);/);
  const soul = read('templates/workspaces/maestro/SOUL.md');
  assert.match(soul, /When a message starts with \*\*\[First-time setup\]\*\*[\s\S]*read `SETUP-INTERVIEW\.md`/);
  const iv = read('templates/workspaces/maestro/SETUP-INTERVIEW.md');
  for (const s of ['## Step 1 — About them', '## Step 2 — Their team', '## Step 3 — Build each one', '## Step 4 — Show them', '## Step 5 — The phone', '## Step 6 — A security check of this computer', '## Step 7 — Wrap up', '## If something fails']) assert.ok(iv.includes(s), s);
  assert.match(iv, /\*\*You do the work\.\*\*/);
  assert.match(iv, /\*\*Model: you pick it\.\*\*/);
  assert.match(iv, /nothing you do in this interview does/);
  assert.match(iv, /Do \*\*not\*\* use ask_user in that first reply/, 'the Welcome page cannot show question cards');
});

test('the setup interview offers a security check; the review only looks, and the owner runs anything that needs a password', () => {
  const iv = read('templates/workspaces/maestro/SETUP-INTERVIEW.md');
  assert.match(iv, /a quick demonstration, the phone app, a security check of this computer\)/, 'the first reply says it is coming');
  assert.match(iv, /## Step 6 — A security check of this computer \(offer it; skip it if they say no\)\n\nOffer it in one short message/);
  assert.match(iv, /If they say yes, follow `docs\/SECURITY-REVIEW\.md`/);
  assert.match(read('templates/workspaces/maestro/SOUL.md'), /follow `docs\/SECURITY-REVIEW\.md` in the install folder\. It only looks/);
  const rv = read('docs/SECURITY-REVIEW.md');
  for (const s of ['**Look first, change nothing.**', '**Never ask for a password.**', '**No secrets in the chat.**', '**This computer only.**', "**Don't fix the hub's packages yourself.**", '**Inside a sandbox you can\'t see the computer.**',
    'node scripts/security-check.js', 'Never add `--fix-modes` without a yes', '`ss -tuln`', '`netstat -an -p tcp | grep LISTEN`', '`systemctl is-active ufw firewalld`', '`tailscale funnel status`',
    '`apt list --upgradable`', '`softwareupdate -l`', '`npm audit --omit=dev`', '`fdesetup status`', '**Fix now**', '**Looks good**']) assert.ok(rv.includes(s), s);
  for (const line of rv.split('\n')) assert.doesNotMatch(line, /`(cat|less|more|head|tail)\b[^`]*(\.env|settings\.json)/, 'no command prints a secret file');
  assert.match(welcome, /helps you set up the phone app, and offers to check this computer for security problems\./);
  assert.ok(help.includes('id="security"') && help.includes('<a href="#security">Security</a>'));
  assert.match(help, /Ask <b>Maestro<\/b>: <i>"Check this computer's security\."<\/i>/);
  assert.match(read('docs/HUB-MAP.md'), /18\. \*\*Security review of the install and its computer\.\*\* Follow `docs\/SECURITY-REVIEW\.md`/);
});

test('Help: the ? button opens it beside the chat; phone menu and sign-in page link to it; it is public', () => {
  assert.match(read('index.html'), /<button id="help-btn" class="header-btn" [^>]*onclick="openHelpPanel\(\)">\?<\/button>/);
  assert.match(app, /function openHelpPanel\(\) \{\s*\n\s*gsModal\(`<iframe src="\/help\?embed=1"/);
  assert.match(read('mobile.html'), /<a id="menu-help" href="\/help">&#x2753; Help<\/a>/);
  assert.match(read('login.html'), /<a href="\/help#trouble"[^>]*>Trouble signing in\? Help<\/a>/);
  const access = require('../lib/access');
  assert.deepStrictEqual(access.classifyRoute('/help'), { kind: 'public' });
  assert.ok(require('../lib/static-files').TOP_FILES.has('help.html') && require('../lib/static-files').TOP_FILES.has('welcome.html'));
});

test('Help covers the common tasks, the phone app, and what to do when the hub or the Claude sign-in fails', () => {
  for (const id of ['agents', 'models', 'work', 'family', 'phone', 'trouble', 'terminal']) assert.ok(help.includes(`id="${id}"`), id);
  assert.match(help, /The quickest way: ask Maestro\./);
  assert.match(help, /type <code>claude<\/code> and press Enter, sign in, then type <code>\/exit<\/code>/);
  assert.match(help, /<code>mymaestro status<\/code>, then <code>mymaestro restart<\/code>/);
  assert.match(help, /bash scripts\/tailscale-setup\.sh/);
  assert.match(help, /mymaestro reset-2fa you@example\.com/);
  assert.match(help, /Settings \(⚙ at the top right\) → LLM Providers/);
});

test('the browser tab and the phone app say My Maestro AI', () => {
  for (const f of ['index.html', 'mobile.html']) assert.match(read(f), /<title>My Maestro AI<\/title>/, f);
  assert.match(read('login.html'), /<title>My Maestro AI — Sign in<\/title>/);
  assert.strictEqual(JSON.parse(read('manifest.json')).name, 'My Maestro AI');
});
