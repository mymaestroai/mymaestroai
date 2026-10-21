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

test('desktop: the bell sits next to Send/Interject, shows exactly while a reply runs, toggles on the hub, follows turn_notify and the turn view', () => {
  const app = read('app.js');
  assert.ok(app.includes(`<button onclick="toggleNotifyDone('\${chatId}')" id="notify-\${chatId}" class="notify-done-btn" style="display:none" aria-pressed="false" title="Get a notification on your phone when this reply is done">🔔 Notify me</button>
          <button onclick="sendSoloMessage('\${chatId}')" id="send-\${chatId}">Send</button>`), 'right before Send, which becomes Interject while a reply runs');
  assert.ok(!app.includes(`⏹️ Cancel</button>
          <button onclick="toggleNotifyDone(`), 'not in the top bar');
  assert.match(app, /if \(cancelBtn\) cancelBtn\.style\.display = 'inline-block';\s*showNotifyBtn\(chatId, true\);/, 'shown when the reply starts');
  assert.ok((app.match(/showNotifyBtn\(chatId, false\);/g) || []).length >= 2, 'gone when paused or done');
  assert.ok(app.includes('showNotifyBtn(solo.chatId || solo.id, busy || question);'), 'and for a turn started elsewhere');
  assert.ok(app.includes("if (btn) btn.style.display = show ? 'inline-block' : 'none';"));
  assert.ok(app.includes("btn.textContent = on ? '🔔 Notifying' : '🔔 Notify me';"));
  assert.ok(app.includes("r = await fetch(`/api/agents/${encodeURIComponent(agent)}/notify`, { method: 'POST'"), 'toggles on the hub');
  assert.ok(app.includes("source.addEventListener('turn_notify', e => {") && app.includes("if (!ev || !ev.agent || String(ev.userId) !== myNotifyId()) return;"), 'follows this person\'s bell from other devices');
  assert.ok(app.includes("if (ev.agent && notifyArmed[ev.agent]) { notifyArmed[ev.agent] = null; paintNotifyBtns(ev.agent); }"), 'cleared when the turn ends');
  assert.ok(app.includes('if (turn) applyTurnNotify(chat.agent, turn);'), 'the turn view says whether it is on (a reload, another device)');
  assert.ok(app.includes('No device of yours has notifications turned on yet.'), 'says when no device would hear it');
  assert.ok(app.includes('<select id="st-question-after" onchange="saveQuestionAfter(this.value)">') && app.includes("body: JSON.stringify({ notify: { questionAfterMinutes } })"), 'Settings: the question delay');
  const css = read('index.html');
  assert.ok(css.includes('.input-area .notify-done-btn {') && css.includes('.input-area .notify-done-btn.on {'));
});

test('phone: the bell sits next to the send/interject button, shows exactly while a reply runs, toggles on the hub and follows other devices', () => {
  const m = read('mobile.js'), html = read('mobile.html');
  assert.ok(html.includes(`<textarea id="msg-input" rows="1" placeholder="Message"></textarea>
        <button class="notify-chip" id="chat-notify-btn" type="button" aria-pressed="false" aria-label="Notify me when this reply is done" title="Get a notification when this reply is done" hidden>&#x1F514;<span class="nlabel"> Notify</span></button>
        <button id="send-btn" aria-label="Send">&#x27A4;</button>`), 'right before the send button, which becomes Interject while a reply runs');
  assert.ok(!html.slice(html.indexOf('id="chat-head"'), html.indexOf('id="chat-scroll"')).includes('chat-notify-btn'), 'not in the header');
  assert.ok(html.includes('#composer .notify-chip {') && html.includes('#composer .notify-chip.on {') && html.includes('#composer .notify-chip[hidden] { display: none; }'));
  assert.ok(m.includes("if (bell) { bell.hidden = !working && !own; paintNotifyBtn(); }"), 'same condition as Stop: only while a reply runs');
  assert.ok(m.includes("r = await api(`/api/agents/${encodeURIComponent(agent)}/notify`, { method: 'POST'"));
  assert.ok(m.includes("on('turn_notify', onTurnNotify);") && m.includes("if (!ev || !ev.agent || String(ev.userId) !== myNotifyId()) return;"));
  assert.ok(m.includes("if (ev.agent && notifyArmed[ev.agent]) { notifyArmed[ev.agent] = null; if (ev.agent === current) paintNotifyBtn(); }"), 'cleared when the turn ends');
  assert.ok(m.includes('applyTurnNotify(ra.agent, turn);') && m.includes('applyTurnNotify(agent, d.turn);'), 'the turn view says whether it is on');
  // Like Send: the tap acts on pointerup and pointerdown keeps the message box focused, so the layout does not jump
  // under the finger (a plain click missed on the first try in the test with the box focused).
  assert.ok(m.includes("bellBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); });") && m.includes("bellBtn.addEventListener('pointerup', (e) => { e.preventDefault(); bellAt = Date.now(); toggleNotifyDone(); });") && m.includes("bellBtn.addEventListener('click', () => { if (Date.now() - bellAt < 700) return; toggleNotifyDone(); });"));
  assert.ok(m.includes('Notifications are off on this phone: turn them on in the ⋮ menu first'), 'says when no device would hear it');
  assert.match(read('sw.js'), /const VERSION = 'hub-mobile-v53'/);
});
