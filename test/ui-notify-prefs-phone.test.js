'use strict';
// Phone: notifications per agent. The pure helpers (lifted with vm), the presence heartbeat, the always-shown header bell
// with its sheet (Notify me only while a reply runs), and the ⋮ menu's Notifications sheet.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const html = read('mobile.html'), js = read('mobile.js');

const BEGIN = '// ── notify prefs (begin)', END = '// ── notify prefs (end) ──';
function helpers() {
  const a = js.indexOf(BEGIN), b = js.indexOf(END);
  assert.ok(a >= 0 && b > a, 'the delimited helper block exists');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(js.slice(a, b) + '\nthis.h = { notifyModeLabel, notifyEffective, notifyBellIcon, NOTIFY_MODES };', ctx);
  return ctx.h;
}
const fn = (name) => { const a = js.indexOf(`function ${name}(`); assert.ok(a >= 0, name); const b = js.indexOf('\n}\n', a); return js.slice(a, b + 2); };

test('notifyModeLabel: On, Off, Only when I\'m away; unknown reads On', () => {
  const h = helpers();
  assert.strictEqual(h.notifyModeLabel('on'), 'On');
  assert.strictEqual(h.notifyModeLabel('off'), 'Off');
  assert.strictEqual(h.notifyModeLabel('away'), "Only when I'm away");
  assert.strictEqual(h.notifyModeLabel(undefined), 'On');
});

test('notifyEffective: the agent\'s own value, else my default, else On', () => {
  const h = helpers();
  const prefs = { default: { questions: 'away', other: 'off' }, agents: { helper: { questions: 'on' }, coach: { other: 'away' } } };
  assert.strictEqual(h.notifyEffective(prefs, 'helper', 'questions'), 'on');
  assert.strictEqual(h.notifyEffective(prefs, 'helper', 'other'), 'off');
  assert.strictEqual(h.notifyEffective(prefs, 'coach', 'other'), 'away');
  assert.strictEqual(h.notifyEffective(prefs, 'coach', 'questions'), 'away');
  assert.strictEqual(h.notifyEffective(prefs, 'sam', 'other'), 'off');
  assert.strictEqual(h.notifyEffective(prefs, null, 'questions'), 'away');
  assert.strictEqual(h.notifyEffective(null, 'helper', 'other'), 'on');
  assert.strictEqual(h.notifyEffective({ default: { questions: 'bogus' } }, 'helper', 'questions'), 'on');
});

test('notifyBellIcon: 🔕 only when both kinds resolve to Off for the agent', () => {
  const h = helpers();
  const prefs = { default: { questions: 'on', other: 'on' }, agents: { helper: { questions: 'off', other: 'off' }, coach: { other: 'off' } } };
  assert.strictEqual(h.notifyBellIcon(prefs, 'helper'), '🔕');
  assert.strictEqual(h.notifyBellIcon(prefs, 'coach'), '🔔');
  assert.strictEqual(h.notifyBellIcon(prefs, 'sam'), '🔔');
  assert.strictEqual(h.notifyBellIcon({ default: { questions: 'off', other: 'off' }, agents: { coach: { other: 'on' } } }, 'sam'), '🔕');
  assert.strictEqual(h.notifyBellIcon({ default: { questions: 'off', other: 'off' }, agents: { coach: { other: 'on' } } }, 'coach'), '🔔');
  assert.strictEqual(h.notifyBellIcon(null, 'sam'), '🔔');
});

test('presence heartbeat: one page id per load; on load, visibilitychange, every 60 s while visible; a pagehide beacon', () => {
  assert.match(js, /const presencePage = 'p' \+ Math\.random\(\)/);
  const send = fn('sendPresence');
  assert.ok(send.includes("'/api/notify/presence'") && send.includes("method: 'POST'") && send.includes('page: presencePage, visible: !!visible') && send.includes('.catch(() => {})'), 'api() POST, silent on failure');
  const start = fn('presenceStart');
  assert.ok(start.includes('sendPresence(!document.hidden);'), 'on load');
  assert.ok(start.includes("document.addEventListener('visibilitychange', () => sendPresence(!document.hidden));"));
  assert.ok(start.includes("setInterval(() => { if (!document.hidden) sendPresence(true); }, 60000);"));
  assert.ok(start.includes("window.addEventListener('pagehide'") && start.includes("navigator.sendBeacon('/api/notify/presence', new Blob([JSON.stringify({ page: presencePage, visible: false })], { type: 'application/json' }))"));
  assert.match(js, /await loadMe\(\);\s*applyMultiUser\(\);\s*refreshPlanUsage\(\);\s*if \(hubMe\) \{ presenceStart\(\); loadNotifyPrefs\(\); \}/, 'started once signed in');
});

test('the header bell: always shown with a chat open, opens the agent sheet, keeps its size and the .on look', () => {
  assert.ok(js.includes("if (bell) { bell.hidden = false; paintNotifyBtn(); }"), 'no longer hidden when idle');
  assert.ok(!js.includes('bell.hidden = !working && !own'));
  assert.ok(js.includes("onComposerTap($('chat-notify-btn'), openNotifyAgentSheet);"));
  const tag = html.match(/<button class="iconbtn notify-chip" id="chat-notify-btn"[^>]*>/)[0];
  assert.ok(tag.includes('aria-label="Notifications for this agent"') && !/\bhidden\b/.test(tag), tag);
  assert.ok(html.includes('#chat-head .notify-chip.on {'), 'armed look kept');
  assert.ok(fn('paintNotifyBtn').includes("bell.classList.toggle('on', on)") && fn('paintNotifyBtn').includes('notifyBellIcon(notifyPrefs, current)'));
  assert.ok(/#chat-head \.notify-chip \.nlabel \{ display: none; \}/.test(html), 'icon only: same width as before');
});

test('the agent sheet: titled for the agent; Notify me only while a reply runs and calls toggleNotifyDone; two kind selects PUT per the contract', () => {
  const paint = fn('paintNotifyAgentSheet');
  assert.ok(paint.includes('`Notifications for ${displayName(agent)}`'), 'title');
  assert.ok(paint.includes('const replying = isBusy(agent) || !!ownTurnFor(agent);'), 'the old working || own condition');
  assert.ok(/\$\{replying \? `[^`]*data-nk="done"[^`]*Notify me when this reply is done[^`]*` : ''\}/.test(paint), 'Notify me item only while replying');
  assert.ok(paint.indexOf('${replying ?') < paint.indexOf('${kinds}'), 'it is the first item');
  assert.ok(js.includes("if (b.dataset.nk === 'done') { d.close(); toggleNotifyDone(); }"), 'same function the bell used');
  assert.ok(fn('notifyOptionsHtml').includes('Use my default ('), 'default option');
  assert.ok(paint.includes("NOTIFY_KINDS.map"), 'Questions and Everything else rows');
  assert.ok(js.includes("{ kind: 'questions', label: 'Questions'") && js.includes("{ kind: 'other', label: 'Everything else'"));
  const chg = fn('onNotifyAgentSheetChange');
  assert.ok(chg.includes("s.value || null") && chg.includes('saveNotifyPrefs({ agent, prefs: { [s.dataset.nk]: value } })') && chg.includes('toast('), 'null = back to my default; toasts');
  assert.ok(fn('saveNotifyPrefs').includes("'/api/notify/prefs', { method: 'PUT'"));
  assert.ok(html.includes('<dialog id="notify-agent-sheet"'));
});

test('the toggle itself is unchanged: same API call, notifyArmed and the no-device warning', () => {
  const t = fn('toggleNotifyDone');
  assert.ok(t.includes('/notify`, { method: \'POST\'') && t.includes('notifyArmed[agent] = d.on ? d.turnId : null;') && t.includes('Notifications are off on this phone: turn them on in the ⋮ menu first'));
});

test('the ⋮ menu: a Notifications item next to the test item opens the defaults sheet with the per-agent list and Reset', () => {
  const i = html.indexOf('id="menu-notify-test"'), j = html.indexOf('id="menu-notify-prefs"');
  assert.ok(i > 0 && j > i && j - i < 200, 'right after Send a test notification');
  assert.ok(html.includes('<dialog id="notify-prefs-sheet"'));
  assert.ok(js.includes("$('menu-notify-prefs')?.addEventListener('click'") && js.includes('openNotifyPrefsSheet()'));
  const paint = fn('paintNotifyPrefsSheet');
  assert.ok(paint.includes('Applies to all your devices') && paint.includes('Agents with their own setting') && paint.includes('data-nd="${k.kind}"') && paint.includes('Reset'));
  assert.ok(fn('onNotifyPrefsSheetClick').includes('saveNotifyPrefs({ agent: name, prefs: null })'), 'Reset removes the override');
  assert.ok(fn('onNotifyPrefsSheetChange').includes('saveNotifyPrefs({ default: { [s.dataset.nd]: s.value } })'));
  assert.ok(js.includes("'When an agent needs your answer or approval'") && js.includes("'Finished replies you asked about, reports and notices'"), 'hints from the contract');
});
