'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('mobile.html links the manifest and has the three tabs', () => {
  const html = read('mobile.html');
  assert.match(html, /<link rel="manifest" href="\/manifest\.json">/);
  for (const id of ['tab-agents', 'tab-chat', 'tab-activity']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.includes('src="mobile.js"'));
});

test('server.js maps /mobile to mobile.html and serves .webmanifest', () => {
  const src = read('server.js');
  assert.match(src, /pathname === '\/mobile'\)\s*\{\s*filePath = path\.join\(__dirname, 'mobile\.html'\)/);
  assert.match(src, /'\.webmanifest': 'application\/manifest\+json'/);
  assert.match(src, /'\.png': 'image\/png'/);
});

test('manifest parses and starts at /mobile with both icons present', () => {
  const m = JSON.parse(read('manifest.json'));
  assert.strictEqual(m.start_url, '/mobile.html');
  assert.strictEqual(m.display, 'standalone');
  for (const icon of m.icons) assert.ok(fs.existsSync(path.join(root, icon.src)), icon.src);
  assert.deepStrictEqual(m.icons.map(i => i.sizes).sort(), ['192x192', '512x512']);
});

test('service worker has a version and never caches /api/', () => {
  const sw = read('sw.js');
  assert.match(sw, /const VERSION = '[^']+'/);
  assert.ok(sw.includes("startsWith('/api/')"));
  const shell = sw.match(/const SHELL = \[([^\]]*)\]/)[1];
  assert.ok(!shell.includes('/api/'));
  assert.ok(shell.includes("'/mobile.html'") && shell.includes("'/mobile.js'") && !shell.includes("manifest") && !shell.includes("icons"));
});

test('mobile menu can restart the hub through the same endpoint as the desktop button', () => {
  const html = read('mobile.html');
  const js = read('mobile.js');
  assert.ok(html.includes('id="menu-restart"'), 'menu item');
  assert.ok(html.includes('<dialog id="restart-confirm">'), 'confirm dialog');
  assert.match(js, /api\('\/api\/restart', \{ method: 'POST' \}\)/);
  assert.ok(js.includes("$('menu-restart').addEventListener('click', confirmRestart)"));
  assert.ok(js.includes("$('restart-yes').addEventListener('click', restartHub)"));
  // Waits on /api/health and reloads, rather than guessing a fixed delay.
  assert.match(js, /api\('\/api\/health'/);
  assert.ok(read('app.js').includes("fetch('/api/restart', { method: 'POST'"), 'desktop uses the same endpoint');
});

test('mobile composer interjects into a running turn; Stop moves to the header; service worker is v10', () => {
  const js = read('mobile.js');
  const html = read('mobile.html');
  assert.match(js, /api\('\/api\/chat\/interject', \{\s*method: 'POST'/);
  assert.match(js, /setAttribute\('aria-label', interject \? 'Interject' : 'Send'\)/);
  assert.ok(js.includes("'Interject into the running turn…'"), 'composer placeholder while busy');
  assert.ok(js.includes("'delivered mid-turn'") && js.includes("'turn had already ended, sent as a new message'"));
  assert.match(js, /not currently processing/, 'falls back to a normal send when the turn is over');
  assert.match(js, /stopBtn\.hidden = !working && !own/, 'header Stop also covers a stream this phone started');
  assert.ok(js.includes('function stopOwnTurn') && js.includes('function sendInterjection'));
  assert.ok(html.includes('#send-btn.interject') && html.includes('.note.interject'));
  assert.match(read('sw.js'), /const VERSION = 'hub-mobile-v47'/);
  assert.ok(js.includes("addEventListener('controllerchange'"), 'a new build reloads the installed app once it takes control');
});

test('desktop banner is dismissible and only shown on narrow screens', () => {
  const app = read('app.js');
  assert.match(app, /window\.innerWidth >= 700/);
  assert.ok(app.includes("'hub-mobile-banner'"));
});

test('send button sends on the touch itself (pointerdown preventDefault keeps the keyboard; pointerup sends; the trailing click is ignored)', () => {
  const js = read('mobile.js');
  assert.match(js, /sendBtn\.addEventListener\('pointerdown', \(e\) => \{ e\.preventDefault\(\); \}\);/);
  assert.match(js, /sendBtn\.addEventListener\('pointerup', \(e\) => \{ e\.preventDefault\(\); sentAt = Date\.now\(\); sendMessage\(\); \}\);/);
  assert.match(js, /sendBtn\.addEventListener\('click', \(\) => \{ if \(Date\.now\(\) - sentAt < 700\) return; sendMessage\(\); \}\);/);
  assert.ok(!js.includes("$('send-btn').addEventListener('click', () => sendMessage());"), 'the old click-only binding is gone');
});

test('mobile push: the phone re-registers when the hub no longer knows its subscription, and can send itself a test', () => {
  const js = read('mobile.js'), html = read('mobile.html');
  assert.ok(js.includes("api('/api/push/status?endpoint=' + encodeURIComponent(sub.endpoint))"), 'asks the hub');
  assert.ok(js.includes("return again.ok ? 'on' : 'lost';"), 're-registers, else reports lost');
  assert.ok(js.includes("lost: '🔕 Notifications: the hub lost this phone"), 'menu names the lost state');
  assert.ok(html.includes('id="menu-notify-test"') && js.includes("$('menu-notify-test')?.addEventListener('click', testPush)"), 'test item wired');
  assert.ok(js.includes("api('/api/push/test', { method: 'POST'"), 'test item calls the hub');
});

test('service worker: a forced (test) push shows its banner even when the app is open in front', () => {
  const sw = read('sw.js');
  assert.ok(sw.includes("if (!data.force && list.some(c => c.focused && c.visibilityState === 'visible')) return;"));
  assert.match(sw, /const VERSION = 'hub-mobile-v47'/);
});

test('ask_user dialogs: a click only highlights the choice and a Submit button sends it (desktop and phone)', () => {
  const app = read('app.js'), m = read('mobile.js'), ih = read('index.html'), mh = read('mobile.html');
  assert.ok(app.includes("btn.classList.add('selected');") && app.includes("id=\"question-submit\" disabled>Submit</button>"), 'desktop selects then submits');
  assert.ok(!app.includes("submitAnswers(answers);\n          });\n        });\n\n        // Custom text input"), 'desktop no longer submits on option click');
  assert.ok(m.includes("else { b.classList.add('selected'); selected[i] = opt.label; }") && m.includes('<button class="qsubmit" disabled>Submit</button>'), 'phone selects then submits');
  assert.ok(app.includes('if (was) delete selected[qi];') && m.includes('if (was) delete selected[i];'), 'a second click on the highlighted option clears it');
  assert.ok(ih.includes('.question-option.selected {') && mh.includes('.question button.opt.selected {'), 'selected styles on both pages');
  assert.match(read('sw.js'), /const VERSION = 'hub-mobile-v47'/);
});

test('a pending ask_user question is re-shown from the hub event stream and on turn catch-up, on both pages (dedup by request id)', () => {
  const app = read('app.js'), m = read('mobile.js');
  const sdk = fs.readFileSync(path.join(root, 'lib', 'sdk-chat.js'), 'utf8');
  assert.ok(sdk.includes("hubEvents.events.setQuestion(agentName, { request_id: requestId, questions: event.questions })"), 'server remembers the question');
  assert.ok(sdk.includes("questions: event.questions });") && sdk.includes("hubEvents.events.setQuestion(agentName, null)"), 'full question on the event stream; cleared when done');
  assert.ok(app.includes("source.addEventListener('ask_user_done'") && app.includes("showQuestionModal({ request_id: ev.request_id, questions: ev.questions }"), 'desktop shows it from the event stream');
  assert.ok(app.includes("if (turn.question && turn.question.request_id && !turn.ended) showQuestionModal(turn.question, chatId)"), 'desktop shows it on catch-up');
  assert.ok(app.includes("if (shownQuestions.has(request_id)) return resolve();"), 'desktop dedups');
  assert.ok(m.includes("if (chatOpenFor(ev.agent)) showQuestion(q);") && m.includes("pendingQuestionsByAgent.set(ev.agent, q);"), 'phone shows or parks it');
  assert.ok(m.includes("toast(`❓ ${displayName(ev.agent)} is asking you something. Tap to answer.`, 8000, () => navigate('chat', ev.agent));"), 'a parked question says so, and the notice opens that chat');
  assert.ok(m.includes("t.onclick = onTap ? () => { t.classList.remove('on'); onTap(); } : null;"), 'the toast can lead somewhere');
  assert.ok(m.includes("if (d.turn.question && d.turn.question.request_id && !d.turn.ended) showQuestion(d.turn.question);"), 'phone shows it on catch-up');
  // Joining a running turn (the app opened mid-turn, or reopened) shows the question that turn waits on: this path
  // used to fetch the turn and drop the question, so a question asked before the phone joined never appeared.
  assert.ok(m.includes("if (!turn.ended && turn.question && turn.question.request_id) {\n    if (chatOpenFor(ra.agent)) showQuestion(turn.question); else pendingQuestionsByAgent.set(ra.agent, turn.question);"), 'phone shows it when re-attaching');
  // Parked questions are shown when their chat opens (the old lookup used the global `name`, so they never were).
  assert.ok(m.includes("const parked = pendingQuestionsByAgent.get(name);\n  if (parked) { pendingQuestionsByAgent.delete(name); showQuestion(parked); }"), 'opening the chat shows a parked question');
  assert.ok(m.includes("const pq = pendingQuestionsByAgent.get(rec.agent);") && !m.includes("const pq = pendingQuestionsByAgent.get(name);"), 'own-stream path looks up its own agent');
  assert.ok(m.includes("on('ask_user_done'") && m.includes("if (shownQuestions.has(request_id)) {"), 'phone closes and dedups');
  assert.ok(m.includes("if (old && !old.isConnected) { chatEl().appendChild(old); scrollChat(); }"), 'an unanswered question survives the chat being closed and reopened');
  assert.match(read('sw.js'), /const VERSION = 'hub-mobile-v47'/);
});

test('after a hub restart both pages reload themselves: hello carries the boot id, a changed id triggers a reload once nothing streams', () => {
  const he = fs.readFileSync(path.join(root, 'lib', 'hub-events.js'), 'utf8');
  assert.ok(he.includes("replayed: last > 0, boot: bootId }"), 'hello carries boot');
  const { createHubEvents } = require('../lib/hub-events');
  const ev = createHubEvents({ bootId: 'boot-test-1' });
  const writes = []; const res = { write: (s) => writes.push(s), on() {}, once() {}, setHeader() {}, writeHead() {} };
  try { ev.subscribe({ headers: {}, url: '/api/events', on() {} }, res); } catch {}
  assert.ok(writes.some(w => w.includes('"boot":"boot-test-1"')), writes.join('|').slice(0, 300));
  const app = read('app.js'), m = read('mobile.js');
  assert.ok(app.includes("ev.boot !== window.__hubBoot") && app.includes("Object.values(chats).some(c => c && c.controller)") && app.includes('location.reload()'), 'desktop reloads when idle');
  assert.ok(m.includes("ev.boot !== window.__hubBoot") && m.includes("if (streams.size) { setTimeout(go, 2000); return; }"), 'phone reloads when idle');
  assert.match(read('sw.js'), /const VERSION = 'hub-mobile-v47'/);
});

test('a pasted image with no words is a valid chat message (no HTTP 400)', () => {
  const sdk = fs.readFileSync(path.join(root, 'lib', 'sdk-chat.js'), 'utf8');
  assert.ok(sdk.includes("const message = typeof body.message === 'string' && body.message.trim() ? body.message : (hasAttachment ? '(see the attached image)' : '');"));
  assert.ok(sdk.includes("'Type a message or attach an image'"));
});

test('phone: Update hub in the menu (admins only) asks the channel like the desktop dialog, posts it, then restarts', () => {
  const html = read('mobile.html'), js = read('mobile.js');
  assert.ok(html.includes('<button id="menu-update">') && html.includes('<dialog id="update-sheet"></dialog>'));
  assert.ok(js.includes('async function openUpdateSheet()') && js.includes("$('menu-update').addEventListener('click', openUpdateSheet);"));
  assert.ok(js.includes("const r = await api('/api/git-sync/status');"), 'reads the same status as the desktop dialog');
  assert.ok(js.includes(`name="upd-channel"`) && js.includes('Switch to ${other.label} & restart'), 'channel radios with the switch label');
  assert.ok(js.includes("await api('/api/git-sync/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(channel ? { channel } : {}) });"));
  assert.ok(js.includes("if (hubMe && !hubMe.isAdmin) { $('menu-restart').hidden = true; $('menu-update').hidden = true; }"), 'members see neither Update nor Restart');
  assert.ok(js.includes('setTimeout(() => { d.close(); restartHub(); }, 800);'), 'reuses the Restart button\'s wait-for-hub path');
});
