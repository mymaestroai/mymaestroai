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
  vm.runInContext(app.slice(a, b) + '\nthis.notifyModeLabel = notifyModeLabel; this.notifyEffective = notifyEffective; this.notifyBellIcon = notifyBellIcon; this.notifySecurityWarning = notifySecurityWarning; this.NOTIFY_KINDS = NOTIFY_KINDS; this.NOTIFY_AGENT_KINDS = NOTIFY_AGENT_KINDS;', ctx);
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

test('bell icon is muted only when all three agent kinds are off', () => {
  const h = lift();
  const o = (extra) => ({ questions: 'off', requested: 'off', other: 'off', ...extra });
  assert.strictEqual(h.notifyBellIcon(null, 'coach'), '🔔');
  assert.strictEqual(h.notifyBellIcon({ default: o(), agents: {} }, 'coach'), '🔕');
  assert.strictEqual(h.notifyBellIcon({ default: o(), agents: { coach: { other: 'away' } } }, 'coach'), '🔔');
  assert.strictEqual(h.notifyBellIcon({ default: { questions: 'on', requested: 'on', other: 'on' }, agents: { coach: o() } }, 'coach'), '🔕');
  assert.strictEqual(h.notifyBellIcon({ default: o({ questions: 'on' }), agents: {} }, 'coach'), '🔔');
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

test('settings: Your notifications block with its selects, overrides and Reset', () => {
  assert.match(app, /id="st-notify-mine" role="group" aria-label="Your notifications"/);
  assert.match(app, /Your notifications<\/h5>/);
  assert.match(app, /Agents with their own setting/);
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

// ── four kinds ──
test('four kinds in order, labels and hints; the agent kinds are the first three', () => {
  const h = lift();
  assert.deepStrictEqual([...h.NOTIFY_KINDS.map(k => k[0])], ['questions', 'requested', 'other', 'security']);
  assert.deepStrictEqual([...h.NOTIFY_KINDS.map(k => k[1])], ['Questions', 'Requests you made', 'Everything else', 'Security and access']);
  assert.strictEqual(h.NOTIFY_KINDS[0][2], 'When an agent needs your answer or approval');
  assert.strictEqual(h.NOTIFY_KINDS[1][2], 'Things you asked an agent to tell you about, and replies you asked to hear about');
  assert.strictEqual(h.NOTIFY_KINDS[2][2], 'Reports and other notices');
  assert.strictEqual(h.NOTIFY_KINDS[3][2], 'Sign-in and passkey changes, wallet locks, failed backups, access changes, a halted hub');
  assert.deepStrictEqual([...h.NOTIFY_AGENT_KINDS.map(k => k[0])], ['questions', 'requested', 'other']);
});

test('resolution for requested and security', () => {
  const h = lift();
  const prefs = { default: { questions: 'on', requested: 'away', other: 'on', security: 'off' }, agents: { coach: { requested: 'off' } } };
  assert.strictEqual(h.notifyEffective(prefs, 'coach', 'requested'), 'off');
  assert.strictEqual(h.notifyEffective(prefs, 'helper', 'requested'), 'away');
  assert.strictEqual(h.notifyEffective(prefs, 'coach', 'security'), 'off');
  assert.strictEqual(h.notifyEffective({ default: {}, agents: {} }, 'coach', 'requested'), 'on');
  assert.strictEqual(h.notifyEffective(null, 'coach', 'security'), 'on');
});

test('bell icon with three kinds: muted only when all three are off; security does not count', () => {
  const h = lift();
  const off3 = { questions: 'off', requested: 'off', other: 'off' };
  assert.strictEqual(h.notifyBellIcon({ default: off3, agents: {} }, 'coach'), '🔕');
  assert.strictEqual(h.notifyBellIcon({ default: { ...off3, requested: 'on' }, agents: {} }, 'coach'), '🔔');
  assert.strictEqual(h.notifyBellIcon({ default: { ...off3, requested: 'on' }, agents: { coach: { requested: 'off' } } }, 'coach'), '🔕');
  assert.strictEqual(h.notifyBellIcon({ default: { ...off3, security: 'on' }, agents: {} }, 'coach'), '🔕');
  assert.strictEqual(h.notifyBellIcon({ default: { questions: 'off', other: 'off' }, agents: {} }, 'coach'), '🔔', 'an unset requested counts as on');
});

test('security off shows one plain warning line; on and away show none', () => {
  const h = lift();
  const w = h.notifySecurityWarning('off');
  assert.ok(w.includes("You won't be told about sign-in and passkey changes, wallet locks, failed backups, access changes or a halted hub."));
  assert.strictEqual(h.notifySecurityWarning('on'), '');
  assert.strictEqual(h.notifySecurityWarning('away'), '');
  assert.strictEqual(h.notifySecurityWarning(undefined), '');
  // the settings page puts it right under the security row
  assert.match(app, /\$\{k === 'security' \? notifySecurityWarning\(p\.default && p\.default\[k\]\) : ''\}/);
});

test('settings rows come from the four kinds; overrides and the bell menu list only the three agent kinds', () => {
  const s = app.indexOf('function notifySettingsPaint');
  const paint = app.slice(s, s + 2600);
  assert.match(paint, /NOTIFY_KINDS\.map\(\(\[k, label, hint\]\)/);
  assert.match(paint, /NOTIFY_AGENT_KINDS\.some\(/);
  assert.match(paint, /NOTIFY_AGENT_KINDS\.map\(\(\[k, label\]\) => `\$\{label\}: /);
  const m = app.slice(app.indexOf('function notifyBellMenuHtml'), app.indexOf('async function notifyBellToggle'));
  assert.match(m, /NOTIFY_AGENT_KINDS\.map\(/);
  assert.doesNotMatch(m, /NOTIFY_KINDS/);
});

test('the household reminder row is "Question reminders"; no second "Questions" label in the section', () => {
  const a = app.indexOf('id="st-notify-section"');
  const b = app.indexOf('id="st-chat-section"');
  const sec = app.slice(a, b);
  assert.match(sec, /<label>Question reminders<\/label>\s*<select id="st-question-after" onchange="saveQuestionAfter\(this\.value\)"/);
  assert.doesNotMatch(sec, /<label[^>]*>Questions<\/label>/);
  // the per-person rows are labelled from NOTIFY_KINDS, so "Questions" appears there once
  assert.strictEqual(app.split("['questions', 'Questions',").length - 1, 1);
});

test('the bell menu closes when the visible chat tab changes', () => {
  const s = app.indexOf('function switchToChat(chatId)');
  const body = app.slice(s, app.indexOf('async function closeChat'));
  assert.match(body, /notifyBellClose\(false\);/);
  assert.ok(body.indexOf('notifyBellClose(false)') < body.indexOf("classList.add('active')"));
});

test('the ⋯ menu has "Notifications for this agent", which opens the bell menu of the visible chat', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const menu = html.slice(html.indexOf('id="more-menu"'), html.indexOf('id="more-menu"') + 3000);
  assert.match(menu, /id="notify-agent-item" class="more-item" role="menuitem"[^>]*onclick="closeMoreMenu\(\); notifyBellOpenVisible\(\)">🔔 Notifications for this agent<\/button>/);
  const f = app.slice(app.indexOf('function notifyBellOpenVisible'), app.indexOf('// Presence: tells the hub'));
  assert.match(f, /activeChat/);
  assert.match(f, /notifyBellToggle\(id\)/);
});

// Round 4: the Notify me toast follows the "Requests you made" setting.
async function desktopToasts(prefs) {
  const a = app.indexOf('async function toggleNotifyDone('), b = app.indexOf('// Ask the hub to stop the agent');
  assert.ok(a >= 0 && b > a);
  const toasts = [];
  const h = lift();
  const ctx = {
    chats: { c1: { agent: 'helper', display: 'Helper' } }, notifyArmed: {}, notifyPrefsCache: prefs, notifyEffective: h.notifyEffective,
    paintNotifyBtns() {}, showNotifyBtn() {}, hubToast: (t) => toasts.push(t), capName: (n) => n,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ on: true, turnId: 't1', devices: 1 }) }),
  };
  vm.createContext(ctx);
  vm.runInContext(app.slice(a, b) + '\nthis.go = toggleNotifyDone;', ctx);
  await ctx.go('c1');
  return toasts;
}
test('Notify me toast: on / off / away for Requests you made; not loaded counts as on', async () => {
  assert.deepStrictEqual(await desktopToasts(null), ['You will get a notification when Helper is done.']);
  assert.deepStrictEqual(await desktopToasts({ default: { requested: 'on' }, agents: {} }), ['You will get a notification when Helper is done.']);
  assert.deepStrictEqual(await desktopToasts({ default: { requested: 'off' }, agents: {} }), ['Requests you made is Off for Helper, so no notification will come.']);
  assert.deepStrictEqual(await desktopToasts({ default: { requested: 'on' }, agents: { helper: { requested: 'off' } } }), ['Requests you made is Off for Helper, so no notification will come.']);
  assert.deepStrictEqual(await desktopToasts({ default: { requested: 'away' }, agents: {} }), ["You'll get a notification when Helper is done if none of your pages is open."]);
});
