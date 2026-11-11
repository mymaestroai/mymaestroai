'use strict';
// Data connectors page (modules.html, served at /modules) and its routes: source-string tests in the ui-*.test.js pattern.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const page = read('modules.html'), server = read('server.js'), access = read('lib/access.js'), app = read('app.js'), index = read('index.html'), mobileJs = read('mobile.js'), mobileHtml = read('mobile.html');

test('the page is admin-only and served at /modules; the API sits under /api/modules (admin by default)', () => {
  assert.match(access, /'\/modules', '\/modules\.html'/);
  assert.match(server, /else if \(pathname === '\/modules'\) \{\s*filePath = path\.join\(__dirname, 'modules\.html'\);/);
  for (const r of ['step', 'check', 'settings', 'enable', 'disable', 'audit']) assert.match(server, new RegExp(`\\(step\\|check\\|settings\\|enable\\|disable\\|audit\\)`), r);
  assert.match(server, /mods\.runStep\(id, String\(b\.step \|\| ''\), b\.input \|\| \{\}\)/);
});

test('the page and heading say Data connectors; the address stays /modules', () => {
  assert.match(page, /<title>My Maestro AI — Data connectors<\/title>/);
  assert.match(page, /<h1>Data connectors<\/h1>/);
  assert.ok(!/<h1>Modules<\/h1>/.test(page));
});

test('every step type has a renderer; text is escaped; secrets are password fields and never echoed', () => {
  for (const t of ['explain', 'outside', 'install', 'secrets', 'check', 'settings', 'grant', 'signin', 'finish']) assert.ok(page.includes(`s.type === '${t}'`), t);
  assert.match(page, /const esc = \(s\) =>/);
  assert.match(page, /<input type="password" id="sec-\$\{esc\(x\.name\)\}" autocomplete="off"/);
  assert.match(page, /rel="noopener noreferrer"/);
  assert.match(page, /await f\.files\[0\]\.text\(\)/, 'the key file is read in the browser');
});

test('cards show the catalog line and the last check, escaped', () => {
  assert.match(page, /Last verified working \$\{esc\(fmtDay\(c\.verified\)\)\} · \$\{esc\(c\.api\)\} · \$\{c\.official \? 'Official' : 'Community-made'\}/);
  assert.match(page, /Checked \$\{esc\(fmtStamp\(lc\.at\)\)\}: working/);
  assert.match(page, /Needs attention: \$\{esc\(lc\.summary\)\}/);
  assert.match(page, /\$\{catalogLine\(m\.catalog\)\}\s*\$\{checkLine\(m\.lastCheck\)\}/);
  assert.match(page, /month: 'short', day: 'numeric', year: 'numeric'/, 'dates read like Nov 6, 2026');
});

test('signin step: button, code in a monospace box with Copy, https-only link, wording, countdown, never the device code', () => {
  assert.match(page, /Sign in with \$\{esc\(current\.name\)\}/);
  assert.match(page, /\/signin\/start`, \{ origin: location\.origin \}\)/);
  assert.match(page, /\.signin-code \{ font-family: ui-monospace/);
  assert.match(page, /<span class="signin-code" id="signin-code">\$\{esc\(r\.userCode\)\}<\/span><button onclick="signinCopy\(this\)">Copy<\/button>/);
  assert.match(page, /r\.verificationUrl\.startsWith\('https:\/\/'\)/, 'only https links are offered');
  assert.match(page, /<a class="open-link" href="\$\{esc\(url\)\}" target="_blank" rel="noopener noreferrer">Open \$\{esc\(url\)\}<\/a>/);
  assert.match(page, /Approve the request there, then come back\. This page notices by itself\./);
  assert.match(page, /Code expires in/);
  assert.match(page, /r\.expiresAt/);
  assert.ok(!/deviceCode|device_code/.test(page), 'the device code is never read or shown');
});

test('signin polling: 5-second floor, stops with the panel, a hidden page, Cancel; handles every status', () => {
  assert.match(page, /const SIGNIN_MIN_POLL_SEC = 5;/);
  assert.match(page, /Math\.max\(Number\(r\.intervalSec\) \|\| 0, SIGNIN_MIN_POLL_SEC\) \* 1000/);
  assert.match(page, /\/signin\/poll`, \{\}\)/);
  assert.match(page, /const SIGNIN_HIDDEN_LIMIT_MS = 10 \* 60 \* 1000;/);
  assert.match(page, /document\.addEventListener\('visibilitychange'/);
  assert.match(page, /function closePanel\(\) \{ stopSignin\(\);/);
  assert.match(page, /function render\(\) \{\s*stopSignin\(\);/, 'leaving the step stops polling');
  assert.match(page, /async function signinCancel\(\) \{\s*const id = current && current\.id;\s*stopSignin\(\);/);
  assert.match(page, /try \{ await api\('POST', `\/api\/modules\/\$\{id\}\/signin\/cancel`, \{\}\); \} catch \{ if \(current && current\.id === id\) signinFail\('Could not cancel\. Try again\.'\); return; \}/, 'Cancel waits for the hub; a failure says so and stays stopped');
  assert.ok(page.indexOf('await api(\'POST\', `/api/modules/${id}/signin/cancel`') < page.indexOf('signinPaint(signinIdleHtml());', page.indexOf('async function signinCancel')), 'Start again only comes back after the cancel finished');
  assert.match(page, /p\.status === 'ok'\) \{ stopSignin\(\); await openModule\(m\.id, stepId\)/, 'ok reloads the module');
  assert.match(page, /p\.status === 'denied' \|\| p\.status === 'expired'\) \{ signinFail\(p\.message/);
  assert.match(page, /catch \(e\) \{ if \(signin === token\) signinFail\(e\.message\)/, 'an error is shown with Start again');
  assert.match(page, /note \? 'Start again'/);
});

test('Ask Maestro: on every step and on a module that needs attention; help, then /api/chat/stream, then /?agent=', () => {
  assert.match(page, /<div class="actions">\$\{askButton\(s\.id\)\}<\/div><div class="msg" id="step-msg">/, 'every step');
  assert.match(page, /const ask = needsAttention\(m\) \? askButton\(null\) : '';/);
  const fn = page.slice(page.indexOf('async function askMaestro('), page.indexOf('async function busy('));
  const help = fn.indexOf('/help?'), chat = fn.indexOf("'/api/chat/stream'"), go = fn.indexOf("location.href = '/?agent=' + encodeURIComponent(h.agent)");
  assert.ok(help > 0 && chat > help && go > chat, 'help, then chat, then the agent page');
  assert.match(fn, /q\.set\('step', stepId\)/);
  assert.match(fn, /q\.set\('error', shown\)/, 'the error shown on the step goes along');
  assert.match(fn, /credentials: 'same-origin'/);
  assert.match(fn, /JSON\.stringify\(\{ agent: h\.agent, message: h\.message \}\)/);
  assert.ok(!fn.includes('getReader') && !fn.includes('.body'), 'the reply stream is not waited for');
  assert.ok(!/fetch\('\/api\/chat'/.test(fn), 'the stream route, not the plain one');
  assert.ok(fn.indexOf('r.status === 409') > chat && fn.indexOf('r.status === 409') < go, '409 is handled before leaving');
  assert.match(fn, /if \(r\.status === 409\) throw new Error\('Maestro is busy right now\. Try again in a moment\.'\);/);
  assert.match(fn, /if \(!r\.ok\) \{ let j = \{\}; try \{ j = await r\.json\(\); \} catch \{\} throw new Error\(j\.error \|\| `HTTP \$\{r\.status\}`\); \}\s*location\.href/, 'other errors show inline; success goes at once');
  assert.match(fn, /catch \(e\) \{ setMsg\('err', e\.message\); \}/, 'errors show inline');
});

test('leads are listed as "(lead): always" with a checked, disabled box, on the grant step and the overview', () => {
  assert.match(page, /<input type="checkbox" checked disabled> \$\{esc\(n\)\} \(lead\): always/);
  assert.ok((page.match(/leadRows\(m\)/g) || []).length >= 3, 'defined once, used by the grant step and the overview');
  assert.match(page, /inner = leadRows\(m\) \+/);
});

test('money connectors (leadsAlways false): leads are ordinary checkboxes with their eligibility, not "always"', () => {
  assert.match(page, /const leadsLocked = \(m\) => m\.leadsAlways !== false;/);
  assert.match(page, /function leadRows\(m\) \{\s*if \(!leadsLocked\(m\)\) return '';/, 'no locked lead rows');
  assert.match(page, /m\.candidates\.filter\(c => !leadsLocked\(m\) \|\| !\(m\.leads \|\| \[\]\)\.includes\(c\.name\)\)/, 'leads stay in the candidate list');
  assert.match(page, /m\.agents\.filter\(n => !leadsLocked\(m\) \|\| !\(m\.leads \|\| \[\]\)\.includes\(n\)\)/, 'the overview lists granted leads as ordinary agents');
  assert.match(page, /\$\{c\.eligible \? '' : 'disabled'\}/, 'eligibility shown');
});

test('server: sign-in cancel route; the connectors list carries the owner and admin leads', () => {
  assert.match(server, /signin\\\/\(start\|poll\|cancel\)\$\//);
  assert.match(server, /m\[2\] === 'cancel' \? mods\.signinCancel\(m\[1\]\)/);
  assert.match(server, /pathname === '\/api\/connectors' && req\.method === 'GET'\) return jsonResponse\(res, 200, \{ ok: true, \.\.\.cx\.list\(\), leads: .*require\('\.\/lib\/agents'\)\.ownerLeadNames\(\)/);
});

test('phone: viewport meta, stacked layout, 40 px tap targets', () => {
  assert.match(page, /<meta name="viewport" content="width=device-width, initial-scale=1\.0">/);
  const mq = page.slice(page.indexOf('@media (max-width: 760px) {\n    main'));
  assert.match(mq, /\.grid \{ grid-template-columns: 1fr; \}/);
  assert.match(mq, /\.layout \{ grid-template-columns: 1fr; \}/);
  assert.match(mq, /min-height: 40px/);
});

test('the hub links to it: account menu for admins, a Settings box, the phone ⋮ menu for admins', () => {
  assert.match(index, /id="account-modules" href="\/modules"[^>]*>Data connectors<\/a>/);
  assert.match(app, /modulesItem\.style\.display = me\.isAdmin \? '' : 'none';/);
  assert.match(app, /<div class="st-section" id="st-modules-section"><h4>Data connectors<\/h4>/);
  assert.match(app, /Connect outside services such as Google Drive and Oura, with a guided setup\./);
  assert.match(app, /onclick="location\.href='\/modules'">Open Data connectors<\/button>/);
  assert.match(mobileHtml, /<a id="menu-connectors" href="\/modules" hidden>&#x1F50C; Data connectors<\/a>/);
  assert.match(mobileJs, /\$\('menu-connectors'\)\.hidden = !hubMe\.isAdmin;/);
});

test('POST /api/ask_response tells handleAskResponse whether the caller is an admin', () => {
  assert.match(server, /handleAskResponse\(body, \{ isAdmin: access\.isAdmin\(req\.hubUser\) \}\)/);
});
