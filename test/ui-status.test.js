'use strict';
// Source-level checks for the resilience UI work (live status, re-attach, push). Offline.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const app = read('app.js');
const mobile = read('mobile.js');
const sw = read('sw.js');
const html = read('index.html');
const mhtml = read('mobile.html');

test('desktop listens to the status events and polls /api/agents/status as a fallback', () => {
  for (const ev of ['status_snapshot', 'turn_start', 'turn_end', 'ask_user', 'ask_user_done']) {
    assert.ok(app.includes(`addEventListener('${ev}'`), `app.js listens to ${ev}`);
  }
  assert.ok(app.includes("'/api/agents/status'"));
  assert.match(app, /hubEventSource\.readyState === EventSource\.OPEN\) return;\s*pollAgentStatus\(\)/);
  assert.ok(app.includes('function applyStatusSnapshot'));
  assert.ok(app.includes("'busy' in a"), 'derives status from /api/agents busy field at load');
  assert.ok(html.includes('id="agents-working"') && html.includes('live-question') && html.includes('live-busy'));
});

test('mobile listens to the status events and polls /api/agents/status as a fallback', () => {
  for (const ev of ['status_snapshot', 'turn_start', 'turn_end', 'ask_user', 'ask_user_done']) {
    assert.ok(mobile.includes(`on('${ev}'`), `mobile.js listens to ${ev}`);
  }
  assert.ok(mobile.includes("'/api/agents/status'"));
  assert.ok(mhtml.includes('id="working-chip"') && mhtml.includes('.dot.question'));
});

test('both UIs stop a turn through /api/chat/stop', () => {
  assert.ok(app.includes("'/api/chat/stop'"));
  assert.ok(mobile.includes("'/api/chat/stop'"));
  assert.match(app, /stopAgentTurn\(chat\.agent\);/);
  assert.match(mobile, /stopTurn\(agent\); running\.controller\.abort\(\)/);
});

test('mobile streams are per agent: Stop only in the chat that is streaming, other chats can send and open', () => {
  assert.ok(!mobile.includes('if (streaming) { stopTurn(streaming.agent)'), 'the global single-stream Stop is gone');
  assert.ok(!/^let streaming\b/m.test(mobile) && !/^let reattach\b/m.test(mobile), 'no global streaming/reattach state');
  assert.ok(mobile.includes('const streams = new Map()') && mobile.includes('const reattaches = new Map()'));
  assert.match(mobile, /const running = streams\.get\(agent\);\s*if \(running\) \{ stopTurn\(agent\); running\.controller\.abort\(\); return; \}/);
  assert.ok(!mobile.includes('Stop the running reply first'), 'opening another agent is always allowed');
  assert.ok(mobile.includes('function attachStreamBubble') && mobile.includes('function bubbleLive'));
  assert.match(mobile, /const own = ownTurnFor\(current\);\s*const working = isBusy\(current\) && !own;/);
  assert.ok(mobile.includes('setSendMode(own)'), 'send button follows the open chat only');
});

test('mobile bubbles have a copy control and the menu copies the whole chat as markdown', () => {
  assert.ok(mobile.includes('clipboard.writeText'));
  assert.ok(mobile.includes('function addCopyButton') && mobile.includes("b.className = 'copy'"));
  assert.ok(mobile.includes('const rawText = new WeakMap()'), 'raw markdown kept per bubble');
  assert.ok(mobile.includes("toast('Copied')"));
  assert.ok(mobile.includes('function chatAsMarkdown') && mobile.includes('`**You:** ${'));
  assert.ok(mhtml.includes('id="menu-copy"') && mhtml.includes('.msg .copy'));
});

test('the auto-resend path is gone; a dropped stream re-attaches instead', () => {
  assert.ok(!app.includes('waitForHubAndResend'));
  assert.ok(!/sendSoloMessage\(chatId, retryCount \+ 1\)/.test(app));
  assert.ok(app.includes('function enterReattach') && app.includes('function reattachCheck'));
  assert.ok(app.includes('Connection lost;'));
  assert.ok(mobile.includes('function enterReattach') && mobile.includes('function reattachCheck'));
  assert.ok(mobile.includes('Connection lost;'));
  for (const src of [app, mobile]) {
    for (const evName of ['online', 'focus']) assert.ok(src.includes(`addEventListener('${evName}'`), `re-attach on ${evName}`);
    assert.ok(src.includes("addEventListener('visibilitychange'"));
  }
});

test('busy agent: inline notice before sending and a 409 that keeps the text', () => {
  assert.ok(app.includes('is still working on the previous message'));
  assert.ok(mobile.includes('is still working on the previous message'));
  assert.ok(app.includes('is busy; it will finish first'));
  assert.ok(mobile.includes('Agent is busy; it will finish first'));
});

test('service worker shows push notifications and focuses the app on click', () => {
  assert.match(sw, /const VERSION = 'hub-mobile-v([4-9]|[1-9][0-9]+)'/);
  assert.ok(sw.includes("addEventListener('push'"));
  assert.ok(sw.includes("addEventListener('notificationclick'"));
  assert.ok(sw.includes('self.registration.showNotification'));
  assert.ok(sw.includes("icon: ICON") && sw.includes("'/icons/hub-192.png'"));
  assert.ok(sw.includes('renotify: true'));
});

test('mobile subscribes to push through the service worker and the hub', () => {
  assert.ok(mobile.includes('pushManager.subscribe'));
  assert.ok(mobile.includes("'/api/push/vapid-public-key'"));
  assert.ok(mobile.includes("'/api/push/subscribe'") && mobile.includes("'/api/push/unsubscribe'"));
  assert.ok(mobile.includes("'PushManager' in window"));
  assert.ok(mobile.includes('Install to home screen first'));
  assert.ok(mhtml.includes('id="menu-notify"') && mhtml.includes('id="push-banner"'));
});

test('a busy agent can be stopped from any device: mobile header Stop and desktop Cancel surface from status', () => {
  const fs = require('fs'); const path = require('path');
  const root = path.join(__dirname, '..');
  const mh = fs.readFileSync(path.join(root, 'mobile.html'), 'utf8');
  const mj = fs.readFileSync(path.join(root, 'mobile.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.ok(mh.includes('id="chat-stop-btn"'));
  assert.ok(mj.includes('stopRemoteTurn') && mj.includes("stopBtn.hidden = !working"));
  assert.ok(app.includes('A turn started elsewhere') && app.includes('cancel-${solo.chatId || solo.id}'));
});
