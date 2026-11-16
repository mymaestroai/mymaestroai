// Desktop page: per-person notification settings (defaults, per-agent overrides), the chat-header bell, the presence heartbeat.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function lift() {
  const a = app.indexOf('// ── notify prefs (begin) ──');
  const b = app.indexOf('// ── notify prefs (end) ──');
  assert.ok(a >= 0 && b > a, 'the helper block is delimited in app.js');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(app.slice(a, b) + '\nthis.notifyModeLabel = notifyModeLabel; this.notifyEffective = notifyEffective; this.notifyBellIcon = notifyBellIcon;', ctx);
  return ctx;
}

test('mode labels', () => {
  const h = lift();
  assert.strictEqual(h.notifyModeLabel('on'), 'On');
  assert.strictEqual(h.notifyModeLabel('off'), 'Off');
  assert.strictEqual(h.notifyModeLabel('away'), "Only when I'm away");
  assert.strictEqual(h.notifyModeLabel(undefined), 'On');
});

test('resolution: the agent override, else the default, else on', () => {
  const h = lift();
  const prefs = { default: { questions: 'away', other: 'off' }, agents: { coach: { questions: 'on' }, helper: { other: 'away' } } };
  assert.strictEqual(h.notifyEffective(prefs, 'coach', 'questions'), 'on');
  assert.strictEqual(h.notifyEffective(prefs, 'coach', 'other'), 'off');
  assert.strictEqual(h.notifyEffective(prefs, 'helper', 'other'), 'away');
  assert.strictEqual(h.notifyEffective(prefs, 'helper', 'questions'), 'away');
  assert.strictEqual(h.notifyEffective(prefs, 'nobody', 'other'), 'off');
  assert.strictEqual(h.notifyEffective(null, 'coach', 'other'), 'on');
  assert.strictEqual(h.notifyEffective({ default: {}, agents: {} }, 'coach', 'questions'), 'on');
});

test('bell icon is muted only when both kinds are off', () => {
  const h = lift();
  assert.strictEqual(h.notifyBellIcon(null, 'coach'), '🔔');
  assert.strictEqual(h.notifyBellIcon({ default: { questions: 'off', other: 'off' }, agents: {} }, 'coach'), '🔕');
  assert.strictEqual(h.notifyBellIcon({ default: { questions: 'off', other: 'off' }, agents: { coach: { other: 'away' } } }, 'coach'), '🔔');
  assert.strictEqual(h.notifyBellIcon({ default: { questions: 'on', other: 'on' }, agents: { coach: { questions: 'off', other: 'off' } } }, 'coach'), '🔕');
  assert.strictEqual(h.notifyBellIcon({ default: { questions: 'off', other: 'on' }, agents: {} }, 'coach'), '🔔');
});

test('presence heartbeat: load, visibilitychange, interval, pagehide beacon', () => {
  assert.match(app, /notifyPageId = \(typeof crypto !== 'undefined' && crypto\.randomUUID\)/);
  assert.match(app, /fetch\('\/api\/notify\/presence', \{ method: 'POST', credentials: 'include'/);
  assert.match(app, /visible: document\.visibilityState === 'visible'/);
  const s = app.indexOf('function startNotifyPresence');
  const body = app.slice(s, s + 1200);
  assert.match(body, /notifyPresenceSend\(\);/);
  assert.match(body, /addEventListener\('visibilitychange', notifyPresenceSend\)/);
  assert.match(body, /setInterval\([^]*document\.visibilityState === 'visible'[^]*60000\)/);
  assert.match(body, /addEventListener\('pagehide'[^]*navigator\.sendBeacon\('\/api\/notify\/presence', new Blob\(\[JSON\.stringify\(\{ page: notifyPageId, visible: false \}\)\], \{ type: 'application\/json' \}\)\)/);
  // started where the hub event stream starts after sign-in, and only there
  assert.match(app, /startHubEventMonitor\(\);\n\s*startNotifyPresence\(\);/);
  assert.strictEqual(app.split(/(?<!function )startNotifyPresence\(\)/).length - 1, 1);
});

test('settings: Your notifications block with both selects, overrides and Reset', () => {
  assert.match(app, /id="st-notify-mine" role="group" aria-label="Your notifications"/);
  assert.match(app, /Your notifications<\/h5>/);
  assert.match(app, /Agents with their own setting/);
  assert.match(app, /\['questions', 'Questions', 'when an agent needs your answer or approval'\]/);
  assert.match(app, /\['other', 'Everything else', 'finished replies you asked about, reports and notices'\]/);
  assert.match(app, /body: body \? JSON\.stringify\(body\)/);
  assert.match(app, /notifyPrefsRequest\('PUT', \{ default: \{ \[kind\]: sel\.value \} \}\)/);
  assert.match(app, /notifyPrefsRequest\('PUT', \{ agent, prefs: null \}\)/);
  assert.match(app, /catch \(e\) \{ sel\.value = before;/);   // a failed save puts the select back
  // the admin's "remind after N minutes" control stays
  assert.match(app, /id="st-question-after" onchange="saveQuestionAfter\(this\.value\)"/);
});

test('header bell: aria attributes, menu title, default option, Escape, focus back', () => {
  assert.match(app, /class="notify-bell-btn" id="notify-bell-\$\{chatId\}"[^>]*aria-label="Notifications for this agent"[^>]*aria-haspopup="dialog" aria-expanded="false"/);
  assert.match(app, /Notifications for \$\{esc\(display\)\}/);
  assert.match(app, /Use my default \(\$\{notifyModeLabel\(defMode\)\}\)/);
  assert.match(app, /\{ agent, prefs: \{ \[kind\]: sel\.value === '' \? null : sel\.value \} \}/);
  assert.match(app, /e\.key === 'Escape'/);
  assert.match(app, /mousedown', notifyBellOutside/);
  assert.match(app, /if \(refocus && btn\) btn\.focus\(\)/);
  // the existing Notify me button near Send is untouched
  assert.match(app, /onclick="toggleNotifyDone\('\$\{chatId\}'\)" id="notify-\$\{chatId\}" class="notify-done-btn"/);
});
