'use strict';
// "Notify me when done": the 🔔 next to Stop while a reply runs. The hub keeps who asked on the running turn, the end
// of the turn carries it to lib/push (one notification to that person's devices), and every page shows the bell's
// state. Finished replies notify no one otherwise; questions wait settings.notify.questionAfterMinutes (test/push).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createHubEvents } = require('../lib/hub-events');
const access = require('../lib/access');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

function fakeRes() { return { write() { return true; }, writableEnded: false }; }

test('the running turn remembers who asked; the end of the turn carries them; turn_notify keeps pages in step', () => {
  const ev = createHubEvents();
  const seen = [];
  ev.onPublish((e) => seen.push(e));
  assert.strictEqual(ev.setTurnNotify('maestro', { on: true, user: { id: 'u_admin', role: 'admin' } }), null, 'nothing running: nothing to arm');
  const tap = ev.tapTurn(fakeRes(), { agent: 'maestro', origin: { kind: 'user' }, message: 'build it' });
  const r = ev.setTurnNotify('maestro', { on: true, user: { id: 'u_admin', role: 'admin' } });
  assert.deepStrictEqual([r.turnId, r.on, r.users], [tap.turnId, true, ['u_admin']]);
  assert.deepStrictEqual(ev.turnFor('maestro').notify, ['u_admin']);
  assert.strictEqual(ev.setTurnNotify('maestro', { on: true, user: { id: 'u_admin' }, turnId: 'some-other-turn' }), null, 'a stale page cannot arm a newer turn');
  ev.setTurnNotify('maestro', { on: true, user: { id: 'u_member', role: 'member' } });
  ev.setTurnNotify('maestro', { on: false, user: { id: 'u_member', role: 'member' } });
  const notes = seen.filter(e => e.type === 'turn_notify');
  assert.deepStrictEqual(notes.map(e => [e.userId, e.on, e.turnId === tap.turnId]), [['u_admin', true, true], ['u_member', true, true], ['u_member', false, true]]);
  assert.ok(!ev.recent(0).some(e => e.type === 'turn_notify'), 'a point-in-time state: not replayed to pages that reconnect (they read the turn view)');
  tap.finish(true);
  const endEv = seen.find(e => e.type === 'turn_end');
  assert.deepStrictEqual(endEv.notify, [{ id: 'u_admin', role: 'admin' }], 'the end of the turn says who to notify');
  assert.deepStrictEqual(ev.turnFor('maestro').notify, [], 'a finished turn has no bell');
  assert.strictEqual(ev.setTurnNotify('maestro', { on: true, user: { id: 'u_admin' } }), null, 'too late once it ended');
});

test('server: POST /api/agents/<name>/notify is for a person on a page, checks access, answers 409 when idle and counts the asker\'s devices; settings are cleaned', () => {
  const s = read('server.js');
  assert.ok(s.includes("const nm = pathname.match(/^\\/api\\/agents\\/([^/]+)\\/notify$/);"), 'route');
  assert.ok(s.includes("if (req.hubToken || req.hubService) return jsonResponse(res, 403, { error: 'session_only'"), 'not for programs');
  assert.ok(s.includes("events.setTurnNotify(agentName, { on: b.on !== false, user, turnId:"), 'arms the running turn');
  assert.ok(s.includes("return jsonResponse(res, 409, { error: 'not_running'"), 'idle: 409');
  assert.ok(s.includes("devices = require('./lib/push').getPush().devicesFor(user);"), 'tells the page whether any device will hear it');
  assert.ok(s.includes("if (patch && patch.notify !== undefined) patch.notify = require('./lib/push').cleanNotifySettings(patch.notify);"), 'settings.notify cleaned');
  assert.deepStrictEqual(access.classifyRoute('/api/agents/kids/notify', 'POST'), { kind: 'agent', from: 'path', agent: 'kids' }, 'members may use it on their own agents');
  assert.deepStrictEqual(access.classifyRoute('/api/agents/kids/turn', 'GET'), { kind: 'agent', from: 'path', agent: 'kids' }, 'and read their own agents\' turn view');
});

test('push: the hub wires owners and the question delay; replies push only for the bell; questions and approvals wait', () => {
  const p = read('lib/push.js');
  assert.ok(p.includes("ownerOf: (agent) => { try { return require('./agents').getAgentsSync().find(a => a.name === agent)?.owner || null; } catch { return null; } },"));
  assert.ok(p.includes("questionDelayMs: () => questionDelayFrom(require('./settings').get()),"));
  assert.ok(p.includes('donePush(ev);') && !p.includes("queue(ev.agent, 'reply', ev.origin)"), 'no automatic reply pushes');
  assert.ok(p.includes("remind(`q:${ev.request_id || ev.agent}`") && p.includes("remind(`a:${ev.id}`") && p.includes("ev.type === 'approval_request'"));
});

test('desktop: the bell sits next to Cancel, shows exactly while a reply runs, toggles on the hub, follows turn_notify and the turn view', () => {
  const app = read('app.js');
  assert.ok(app.includes(`<button onclick="cancelRequest('\${chatId}')" id="cancel-\${chatId}" style="display:none;">⏹️ Cancel</button>
          <button onclick="toggleNotifyDone('\${chatId}')" id="notify-\${chatId}" class="notify-done-btn" style="display:none;" aria-pressed="false"`), 'next to Cancel');
  assert.match(app, /if \(cancelBtn\) cancelBtn\.style\.display = 'inline-block';\s*showNotifyBtn\(chatId, true\);/, 'shown with Cancel for the own stream');
  assert.ok((app.match(/showNotifyBtn\(chatId, false\);/g) || []).length >= 2, 'hidden when paused or idle');
  assert.ok(app.includes('showNotifyBtn(solo.chatId || solo.id, busy || question);'), 'and for a turn started elsewhere');
  assert.ok(app.includes("r = await fetch(`/api/agents/${encodeURIComponent(agent)}/notify`, { method: 'POST'"), 'toggles on the hub');
  assert.ok(app.includes("source.addEventListener('turn_notify', e => {") && app.includes("if (!ev || !ev.agent || String(ev.userId) !== myNotifyId()) return;"), 'follows this person\'s bell from other devices');
  assert.ok(app.includes("if (ev.agent && notifyArmed[ev.agent]) { notifyArmed[ev.agent] = null; paintNotifyBtns(ev.agent); }"), 'cleared when the turn ends');
  assert.ok(app.includes('if (turn) applyTurnNotify(chat.agent, turn);'), 'the turn view says whether it is on (a reload, another device)');
  assert.ok(app.includes('No device of yours has notifications turned on yet.'), 'says when no device would hear it');
  assert.ok(app.includes('<select id="st-question-after" onchange="saveQuestionAfter(this.value)">') && app.includes("body: JSON.stringify({ notify: { questionAfterMinutes } })"), 'Settings: the question delay');
  assert.ok(read('index.html').includes('.chat-actions .notify-done-btn.on {'));
});

test('phone: the bell sits next to Stop in the chat header, shows exactly when Stop does, toggles on the hub and follows other devices', () => {
  const m = read('mobile.js'), html = read('mobile.html');
  assert.ok(html.includes('<button class="iconbtn notify-done" id="chat-notify-btn" aria-label="Notify me when this reply is done"') && html.indexOf('id="chat-notify-btn"') < html.indexOf('id="chat-stop-btn"'), 'next to Stop');
  assert.ok(html.includes('#chat-notify-btn.on {') && html.includes('#chat-notify-btn:not(.on) {'));
  assert.ok(m.includes("if (bell) { bell.hidden = !working && !own; paintNotifyBtn(); }"), 'same condition as Stop');
  assert.ok(m.includes("r = await api(`/api/agents/${encodeURIComponent(agent)}/notify`, { method: 'POST'"));
  assert.ok(m.includes("on('turn_notify', onTurnNotify);") && m.includes("if (!ev || !ev.agent || String(ev.userId) !== myNotifyId()) return;"));
  assert.ok(m.includes("if (ev.agent && notifyArmed[ev.agent]) { notifyArmed[ev.agent] = null; if (ev.agent === current) paintNotifyBtn(); }"), 'cleared when the turn ends');
  assert.ok(m.includes('applyTurnNotify(ra.agent, turn);') && m.includes('applyTurnNotify(agent, d.turn);'), 'the turn view says whether it is on');
  assert.ok(m.includes("$('chat-notify-btn')?.addEventListener('click', toggleNotifyDone);"));
  assert.ok(m.includes('Notifications are off on this phone: turn them on in the ⋮ menu first'), 'says when no device would hear it');
  assert.match(read('sw.js'), /const VERSION = 'hub-mobile-v41'/);
});
