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

// ── the request layer: a stale read never overwrites a saved choice; saves run in the order they were made ──
function requestHarness() {
  const a = app.indexOf('let notifyPrefsCache = null;'), b = app.indexOf('function notifyModeOptions');
  assert.ok(a >= 0 && b > a, 'the request block is in app.js');
  const calls = [];
  const ctx = {
    fetch: (url, o) => new Promise((res) => calls.push({ url, method: o.method, body: o.body, answer: (prefs) => res({ ok: true, json: async () => ({ ok: true, prefs }) }), fail: () => res({ ok: false, json: async () => ({ ok: false, error: 'nope' }) }) })),
    notifyBellsPaint() {},
  };
  vm.createContext(ctx);
  vm.runInContext(app.slice(a, b) + '\nthis.req = notifyPrefsRequest; this.load = notifyPrefsLoad; this.cache = () => notifyPrefsCache;', ctx);
  return { ctx, calls };
}
const tick = () => new Promise((r) => setImmediate(r));
const P = (q) => ({ default: {}, agents: { coach: { questions: q } } });

test('a GET that began before a save and answers after it does not replace the saved choice', async () => {
  const { ctx, calls } = requestHarness();
  const get = ctx.load();                               // the bell menu opens and reads
  await tick();
  const put = ctx.req('PUT', { agent: 'coach', prefs: { questions: 'off' } });
  await tick();
  assert.strictEqual(calls.length, 2);
  calls[1].answer(P('off')); await put;
  assert.strictEqual(ctx.cache().agents.coach.questions, 'off');
  calls[0].answer(P('on')); await get;                 // the earlier read answers late, with the old value
  assert.strictEqual(ctx.cache().agents.coach.questions, 'off', 'the stale read was dropped');
});

test('a GET that started while a save was running does not replace the saved choice either', async () => {
  const { ctx, calls } = requestHarness();
  const put = ctx.req('PUT', { agent: 'coach', prefs: { questions: 'off' } });
  await tick();
  const get = ctx.load();
  await tick();
  calls[0].answer(P('off')); await put;
  calls[1].answer(P('on')); await get;
  assert.strictEqual(ctx.cache().agents.coach.questions, 'off');
});

test('a GET with no save around still fills the cache', async () => {
  const { ctx, calls } = requestHarness();
  const get = ctx.load();
  await tick();
  calls[0].answer(P('away')); await get;
  assert.strictEqual(ctx.cache().agents.coach.questions, 'away');
});

test('two quick saves run one after the other and the last answer is the cache', async () => {
  const { ctx, calls } = requestHarness();
  const p1 = ctx.req('PUT', { default: { questions: 'off' } });
  const p2 = ctx.req('PUT', { default: { questions: 'away' } });
  await tick();
  assert.strictEqual(calls.length, 1, 'the second save waits for the first');
  calls[0].answer({ default: { questions: 'off' }, agents: {} }); await p1;
  await tick();
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(JSON.parse(calls[1].body), { default: { questions: 'away' } });
  calls[1].answer({ default: { questions: 'away' }, agents: {} }); await p2;
  assert.strictEqual(ctx.cache().default.questions, 'away');
});

test('a failed save does not stop the next one', async () => {
  const { ctx, calls } = requestHarness();
  const p1 = ctx.req('PUT', { default: { questions: 'off' } });
  const p2 = ctx.req('PUT', { default: { questions: 'away' } });
  await tick();
  calls[0].fail();
  await assert.rejects(p1, /nope/);
  await tick();
  assert.strictEqual(calls.length, 2);
  calls[1].answer({ default: { questions: 'away' }, agents: {} }); await p2;
  assert.strictEqual(ctx.cache().default.questions, 'away');
});

test('a select is disabled while its save runs, and enabled again after success or failure', () => {
  const grab = (name) => { const s = app.indexOf(name); assert.ok(s > 0, name); return app.slice(s, s + 900); };
  const d = grab('async function notifyDefaultSave');
  assert.ok(/sel\.disabled = true;[^]*await notifyPrefsRequest\('PUT'[^]*finally \{ sel\.disabled = false; \}/.test(d), 'settings select');
  const m = grab("menu.addEventListener('change'");
  assert.ok(/sel\.disabled = true;[^]*await notifyPrefsRequest\('PUT'[^]*finally \{ sel\.disabled = false; \}/.test(m), 'bell menu select');
});

test('the bell menu does not repaint over a change made after it opened', () => {
  const s = app.indexOf('async function notifyBellToggle');
  const body = app.slice(s, s + 4500);
  assert.match(body, /const writesAtOpen = notifyPrefsWrites;[^]*await notifyPrefsLoad\(\);[^]*notifyPrefsWrites === writesAtOpen/);
});
