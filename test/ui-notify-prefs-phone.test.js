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
  vm.runInContext(js.slice(a, b) + '\nthis.h = { notifyModeLabel, notifyEffective, notifyBellIcon, NOTIFY_MODES, NOTIFY_KINDS, NOTIFY_AGENT_KINDS, NOTIFY_SECURITY_WARNING };', ctx);
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

test('notifyBellIcon: 🔕 only when all three agent kinds resolve to Off for the agent', () => {
  const h = helpers();
  const prefs = { default: { questions: 'on', requested: 'on', other: 'on' }, agents: { helper: { questions: 'off', requested: 'off', other: 'off' }, coach: { other: 'off' }, pal: { questions: 'off', other: 'off' } } };
  assert.strictEqual(h.notifyBellIcon(prefs, 'pal'), '🔔', 'requested still On');
  assert.strictEqual(h.notifyBellIcon(prefs, 'helper'), '🔕');
  assert.strictEqual(h.notifyBellIcon(prefs, 'coach'), '🔔');
  assert.strictEqual(h.notifyBellIcon(prefs, 'sam'), '🔔');
  assert.strictEqual(h.notifyBellIcon({ default: { questions: 'off', requested: 'off', other: 'off' }, agents: { coach: { other: 'on' } } }, 'sam'), '🔕');
  assert.strictEqual(h.notifyBellIcon({ default: { questions: 'off', requested: 'off', other: 'off' }, agents: { coach: { other: 'on' } } }, 'coach'), '🔔');
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
  assert.ok(js.includes("onComposerTap($('chat-notify-btn'), onNotifyBellTap);"), 'the bell runs onNotifyBellTap');
  assert.ok(!js.includes("onComposerTap($('chat-notify-btn'), openNotifyAgentSheet)"));
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
  assert.ok(fn('notifyOptionsHtml').includes('My default: ${defaultLabel}'), 'default option (short enough for a 360 px select)');
  assert.ok(paint.includes('NOTIFY_AGENT_KINDS.map'), 'the three agent kinds, no security row');
  const chg = fn('onNotifyAgentSheetChange');
  assert.ok(chg.includes("s.value || null") && chg.includes('saveNotifyPrefs({ agent, prefs: { [s.dataset.nk]: value } })') && chg.includes('toast('), 'null = back to my default; toasts');
  assert.ok(fn('saveNotifyPrefsNow').includes("'/api/notify/prefs', { method: 'PUT'"));
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
  assert.ok(js.includes("'When an agent needs your answer or approval'") && js.includes("'Things you asked an agent to tell you about, and replies you asked to hear about'") && js.includes("'Reports and other notices'"), 'hints from the contract');
});

// ── the request layer: a stale read never overwrites a saved choice; saves run in the order they were made ──
function requestHarness() {
  const a = js.indexOf('let notifyPrefs = null;'), b = js.indexOf('function notifyOptionsHtml');
  assert.ok(a >= 0 && b > a, 'the request block is in mobile.js');
  const calls = [];
  const ctx = {
    api: (url, o) => new Promise((res) => calls.push({ url, method: (o && o.method) || 'GET', body: o && o.body, answer: (prefs) => res({ ok: true, json: async () => ({ ok: true, prefs }) }) })),
    toast() {}, paintNotifyBtn() {},
    notifyServerMode: {},   // adoptNotifyPrefs (in this block) drops the modes remembered from bell taps
  };
  vm.createContext(ctx);
  vm.runInContext(js.slice(a, b) + '\nthis.load = loadNotifyPrefs; this.save = saveNotifyPrefs; this.cache = () => notifyPrefs;', ctx);
  return { ctx, calls };
}
const tick = () => new Promise((r) => setImmediate(r));
const P = (q) => ({ default: {}, agents: { helper: { questions: q } } });

test('a GET that began before a save and answers after it does not replace the saved choice', async () => {
  const { ctx, calls } = requestHarness();
  const get = ctx.load();
  await tick();
  const put = ctx.save({ agent: 'helper', prefs: { questions: 'off' } });
  await tick();
  assert.strictEqual(calls.length, 2);
  calls[1].answer(P('off')); assert.strictEqual(await put, true);
  assert.strictEqual(ctx.cache().agents.helper.questions, 'off');
  calls[0].answer(P('on')); await get;
  assert.strictEqual(ctx.cache().agents.helper.questions, 'off', 'the stale read was dropped');
});

test('a GET that started while a save was running does not replace the saved choice either', async () => {
  const { ctx, calls } = requestHarness();
  const put = ctx.save({ agent: 'helper', prefs: { questions: 'off' } });
  await tick();
  const get = ctx.load();
  await tick();
  calls[0].answer(P('off')); await put;
  calls[1].answer(P('on')); await get;
  assert.strictEqual(ctx.cache().agents.helper.questions, 'off');
});

test('a GET with no save around still fills the cache', async () => {
  const { ctx, calls } = requestHarness();
  const get = ctx.load();
  await tick();
  calls[0].answer(P('away')); await get;
  assert.strictEqual(ctx.cache().agents.helper.questions, 'away');
});

test('two quick saves run one after the other and the last answer is the cache', async () => {
  const { ctx, calls } = requestHarness();
  const p1 = ctx.save({ default: { questions: 'off' } });
  const p2 = ctx.save({ default: { questions: 'away' } });
  await tick();
  assert.strictEqual(calls.length, 1, 'the second save waits for the first');
  calls[0].answer({ default: { questions: 'off' }, agents: {} }); await p1;
  await tick();
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(JSON.parse(calls[1].body), { default: { questions: 'away' } });
  calls[1].answer({ default: { questions: 'away' }, agents: {} }); await p2;
  assert.strictEqual(ctx.cache().default.questions, 'away');
});

test('a select is disabled while its save runs, and enabled again after', () => {
  for (const name of ['onNotifyAgentSheetChange', 'onNotifyPrefsSheetChange']) {
    const f = fn(name);
    assert.ok(/s\.disabled = true;[^]*await saveNotifyPrefs\([^]*finally \{ s\.disabled = false; \}/.test(f), name);
  }
});

test('the agent sheet acts only for the chat that is open: a changed chat closes it and does nothing', () => {
  const click = fn('onNotifyAgentSheetClick'), chg = fn('onNotifyAgentSheetChange');
  assert.ok(click.includes('if (d._agent !== current) { d.close(); return; }'));
  assert.ok(click.indexOf('d._agent !== current') < click.indexOf('toggleNotifyDone()'));
  assert.ok(chg.includes('if (agent !== current) { d.close(); return; }'));
  assert.ok(chg.indexOf('agent !== current') < chg.indexOf('saveNotifyPrefs('));
});

test('an open agent sheet repaints when its agent\'s reply ends or its notify state changes', () => {
  assert.ok(fn('repaintNotifyAgentSheet').includes('d.open && d._agent === agent) paintNotifyAgentSheet()'));
  for (const name of ['applyTurnNotify', 'onTurnNotify', 'toggleNotifyDone', 'onTurnEnd']) assert.ok(fn(name).includes('repaintNotifyAgentSheet('), name);
});

// ── round 2: four kinds, one-tap bell, ⋮ item, security warning ──
test('four kinds in order; the agent sheet and the per-agent list use the three agent kinds', () => {
  const h = helpers();
  assert.deepStrictEqual([...h.NOTIFY_KINDS.map(k => k.kind)], ['questions', 'requested', 'other', 'security']);
  assert.deepStrictEqual([...h.NOTIFY_KINDS.map(k => k.label)], ['Questions', 'Requests you made', 'Everything else', 'Security and access']);
  assert.deepStrictEqual([...h.NOTIFY_AGENT_KINDS.map(k => k.kind)], ['questions', 'requested', 'other']);
  assert.ok(fn('paintNotifyAgentSheet').includes('NOTIFY_AGENT_KINDS.map'));
  assert.ok(fn('paintNotifyPrefsSheet').includes('NOTIFY_KINDS.map') && fn('paintNotifyPrefsSheet').includes('NOTIFY_AGENT_KINDS.some') && fn('paintNotifyPrefsSheet').includes('NOTIFY_AGENT_KINDS.filter'));
});

// Lift the real functions and run them with stubs.
function bellHarness({ busy, own, apiBody }) {
  const a = js.indexOf('function onNotifyBellTap('), b = js.indexOf('function onTurnNotify(');
  assert.ok(a >= 0 && b > a);
  const calls = { api: [], toasts: [], sheet: 0 };
  const ctx = {
    current: 'helper', notifyArmed: {}, notifyServerMode: {}, NOTIFY_MODES: ['on', 'off', 'away'], hubMe: null,
    isBusy: () => busy, ownTurnFor: () => own,
    displayName: (n) => n, paintNotifyBtn() {}, repaintNotifyAgentSheet() {},
    openNotifyAgentSheet() { calls.sheet++; }, notifyPrefs: null, notifyEffective: helpers().notifyEffective,
    api: async (url, o) => { calls.api.push({ url, o }); return { ok: true, status: 200, json: async () => apiBody }; },
    toast: (text, ms, onTap) => calls.toasts.push({ text, ms, onTap }),
  };
  vm.createContext(ctx);
  vm.runInContext(js.slice(a, b) + '\nthis.bell = onNotifyBellTap;', ctx);
  return { ctx, calls };
}

test('onNotifyBellTap: a reply running -> Notify me (same API) and one toast whose tap opens the sheet', async () => {
  for (const [busy, own] of [[true, false], [false, true]]) {
    const { ctx, calls } = bellHarness({ busy, own, apiBody: { on: true, turnId: 't1', devices: 1, requested: 'on' } });
    await ctx.bell();
    assert.strictEqual(calls.api.length, 1);
    assert.ok(calls.api[0].url.endsWith('/api/agents/helper/notify') && calls.api[0].o.method === 'POST' && JSON.parse(calls.api[0].o.body).on === true);
    assert.strictEqual(ctx.notifyArmed.helper, 't1');
    assert.strictEqual(calls.sheet, 0, 'the sheet is not opened by the tap itself');
    assert.strictEqual(calls.toasts.length, 1, 'one toast');
    assert.ok(calls.toasts[0].text.includes('You will get a notification') && calls.toasts[0].text.includes('Notification settings'));
    assert.strictEqual(typeof calls.toasts[0].onTap, 'function');
    calls.toasts[0].onTap();
    assert.strictEqual(calls.sheet, 1, 'the toast link opens the agent sheet');
  }
});

test('onNotifyBellTap: the no-device warning is kept and carries the link; cancelling too', async () => {
  const { ctx, calls } = bellHarness({ busy: true, own: false, apiBody: { on: true, turnId: 't1', devices: 0 } });
  await ctx.bell();
  assert.ok(calls.toasts[0].text.includes('Notifications are off on this phone') && typeof calls.toasts[0].onTap === 'function');
  const c = bellHarness({ busy: true, own: false, apiBody: { on: false } });
  c.ctx.notifyArmed.helper = 't1';
  await c.ctx.bell();
  assert.ok(c.calls.toasts[0].text.startsWith('Notification cancelled') && typeof c.calls.toasts[0].onTap === 'function');
});

test('onNotifyBellTap: nothing running -> the agent sheet, no request, no toast', async () => {
  const { ctx, calls } = bellHarness({ busy: false, own: false, apiBody: {} });
  await ctx.bell();
  assert.strictEqual(calls.sheet, 1);
  assert.strictEqual(calls.api.length, 0);
  assert.strictEqual(calls.toasts.length, 0);
});

test('the sheet\'s own Notify me item still toasts without a link', () => {
  assert.ok(js.includes("if (b.dataset.nk === 'done') { d.close(); toggleNotifyDone(); }"));
  assert.ok(fn('toggleNotifyDone').includes('withLink ?'));
});

test('the ⋮ menu: "Notifications for this agent" is chat-only, opens the agent sheet; the settings item stays', () => {
  const tag = html.match(/<button id="menu-notify-agent"[^>]*>[^<]*/)[0];
  assert.ok(/class="chat-only"/.test(tag) && tag.includes('Notifications for this agent'), tag);
  assert.ok(html.includes('#menu.no-chat .chat-only { display: none; }'), 'hidden when no chat is open');
  assert.ok(html.includes('id="menu-notify-prefs"') && html.includes('Notification settings&hellip;'));
  assert.ok(/\$\('menu-notify-agent'\)\?\.addEventListener\('click', \(e\) => \{[^}]*openNotifyAgentSheet\(\);/.test(js));
});

test('the defaults sheet: a plain warning under Security and access only when it is Off', () => {
  const a = js.indexOf('function paintNotifyPrefsSheet('), b = js.indexOf('\n}\n', a) + 2;
  const h = helpers();
  const ctx = { notifyPrefs: null, $: () => el, esc: (s) => String(s), displayName: (n) => n, notifyOptionsHtml: () => '', notifyEffective: h.notifyEffective, NOTIFY_KINDS: h.NOTIFY_KINDS, NOTIFY_AGENT_KINDS: h.NOTIFY_AGENT_KINDS, NOTIFY_MODES: h.NOTIFY_MODES, NOTIFY_SECURITY_WARNING: h.NOTIFY_SECURITY_WARNING, notifyModeLabel: h.notifyModeLabel };
  const el = { innerHTML: '' };
  vm.createContext(ctx);
  vm.runInContext(js.slice(a, b) + '\nthis.paint = paintNotifyPrefsSheet;', ctx);
  ctx.notifyPrefs = { default: { questions: 'on', requested: 'on', other: 'on', security: 'on' }, agents: {} };
  ctx.paint();
  assert.ok(!el.innerHTML.includes("You won't be told"), 'no warning while On');
  const order = ['questions', 'requested', 'other', 'security'].map(k => el.innerHTML.indexOf(`data-nd="${k}"`));
  assert.ok(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), 'four rows in order');
  ctx.notifyPrefs = { default: { questions: 'on', requested: 'on', other: 'on', security: 'off' }, agents: {} };
  ctx.paint();
  const w = "You won't be told about sign-in and passkey changes, wallet locks, failed backups, access changes, a halted hub or health problems such as a full disk.";
  assert.ok(el.innerHTML.includes(w), 'warning shown');
  assert.ok(el.innerHTML.indexOf(w) > el.innerHTML.indexOf('data-nd="security"') && el.innerHTML.indexOf(w) < el.innerHTML.indexOf('Agents with their own setting'), 'right under the security row');
  ctx.notifyPrefs = { default: { security: 'away' }, agents: {} };
  ctx.paint();
  assert.ok(!el.innerHTML.includes("You won't be told"), 'not for away');
});

test('the agent sheet paints three rows (no security) and keeps Notify me while a reply runs', () => {
  const a = js.indexOf('function paintNotifyAgentSheet('), b = js.indexOf('\n}\n', a) + 2;
  const h = helpers();
  const el = { _agent: 'helper', innerHTML: '' };
  let busy = false;
  const ctx = { notifyPrefs: { default: { questions: 'on', requested: 'off', other: 'on' }, agents: {} }, notifyServerMode: {}, notifyArmed: {}, $: () => el, esc: (s) => String(s), displayName: (n) => n, isBusy: () => busy, ownTurnFor: () => false, notifyOptionsHtml: (sel, l) => `[${sel}|${l}]`, notifyModeLabel: h.notifyModeLabel, notifyEffective: h.notifyEffective, NOTIFY_AGENT_KINDS: h.NOTIFY_AGENT_KINDS, NOTIFY_MODES: h.NOTIFY_MODES };
  vm.createContext(ctx);
  vm.runInContext(js.slice(a, b) + '\nthis.paint = paintNotifyAgentSheet;', ctx);
  ctx.paint();
  assert.deepStrictEqual([...el.innerHTML.matchAll(/data-nk="(questions|requested|other|security)"/g)].map(m => m[1]), ['questions', 'requested', 'other']);
  assert.ok(el.innerHTML.includes('[|Off]'), 'My default shows the default of Requests you made');
  assert.ok(!el.innerHTML.includes('Notify me when this reply is done'));
  busy = true; ctx.paint();
  assert.ok(el.innerHTML.includes('Notify me when this reply is done'));
});

// Round 4: the Notify me toast follows the "Requests you made" setting, and its link is bound to the agent it was about.
function toastHarness(prefs, { current = 'helper', agent = 'helper', requested } = {}) {
  const h = bellHarness({ busy: true, own: false, apiBody: { on: true, turnId: 't1', devices: 1, ...(requested ? { requested } : {}) } });
  const a = js.indexOf('function notifyEffective('), b = js.indexOf('// 🔕 when all three');
  h.ctx.notifyPrefs = prefs;
  h.ctx.current = current;
  h.ctx.openNotifyAgentSheet = (ag) => h.calls.opened = (h.calls.opened || []).concat([ag === undefined ? '(default)' : ag]);
  h.ctx.NOTIFY_MODES = ['on', 'off', 'away'];
  vm.runInContext(js.slice(a, b), h.ctx);
  return h;
}
test('Notify me toast: the hub\'s answer (requested) wins over cached prefs; without it the cache, else a neutral line', async () => {
  const cases = [
    [null, undefined, 'Notification requested for helper; it follows your notification settings'],
    [{ default: { requested: 'on' }, agents: {} }, undefined, 'You will get a notification when helper is done'],
    [{ default: { requested: 'off' }, agents: {} }, undefined, 'Requests you made is Off for helper, so no notification will come'],
    [{ default: { requested: 'on' }, agents: { helper: { requested: 'off' } } }, undefined, 'Requests you made is Off for helper, so no notification will come'],
    [{ default: { requested: 'away' }, agents: {} }, undefined, "You'll get a notification when helper is done if none of your pages is open"],
    [{ default: { requested: 'off', other: 'on' }, agents: { helper: { requested: 'on' } } }, undefined, 'You will get a notification when helper is done'],
    [null, 'off', 'Requests you made is Off for helper, so no notification will come'],
    [null, 'away', "You'll get a notification when helper is done if none of your pages is open"],
    [null, 'on', 'You will get a notification when helper is done'],
    [{ default: { requested: 'on' }, agents: {} }, 'off', 'Requests you made is Off for helper, so no notification will come'],
    [{ default: { requested: 'off' }, agents: {} }, 'on', 'You will get a notification when helper is done'],
  ];
  for (const [prefs, requested, text] of cases) {
    const { ctx, calls } = toastHarness(prefs, { requested });
    await ctx.bell();
    assert.ok(calls.toasts[0].text.includes(text), `${JSON.stringify(prefs)} ${requested} -> ${calls.toasts[0].text}`);
    assert.ok(calls.toasts[0].text.includes('Notification settings'), 'the link stays');
    if (requested) assert.strictEqual(ctx.notifyServerMode.helper, requested, 'kept for the sheet');
  }
});
test('Notify me toast link: opens the sheet of the agent the toast was about, and does nothing once another chat is open', async () => {
  const { ctx, calls } = toastHarness(null);
  await ctx.bell();
  calls.toasts[0].onTap();
  assert.deepStrictEqual(calls.opened, ['helper'], 'the agent is passed');
  ctx.current = 'coach';                       // the open chat changed while the toast was up
  calls.toasts[0].onTap();
  assert.deepStrictEqual(calls.opened, ['helper'], 'no sheet for the other chat');
});
test('openNotifyAgentSheet takes an optional agent (default: the open chat)', () => {
  assert.ok(js.includes('function openNotifyAgentSheet(agent = current)'));
  assert.ok(fn('openNotifyAgentSheet').includes('d._agent = agent;'));
});
test('the agent sheet qualifies the armed item when Requests you made is Off or away', () => {
  const a = js.indexOf('function paintNotifyAgentSheet('), b = js.indexOf('\n}\n', a) + 2;
  const h = helpers();
  const el = { _agent: 'helper', innerHTML: '' };
  const ctx = { notifyPrefs: null, notifyServerMode: {}, notifyArmed: { helper: 't1' }, $: () => el, esc: (s) => String(s), displayName: (n) => n, isBusy: () => true, ownTurnFor: () => false, notifyOptionsHtml: () => '', notifyModeLabel: h.notifyModeLabel, notifyEffective: h.notifyEffective, NOTIFY_AGENT_KINDS: h.NOTIFY_AGENT_KINDS, NOTIFY_MODES: h.NOTIFY_MODES };
  vm.createContext(ctx);
  vm.runInContext(js.slice(a, b) + '\nthis.paint = paintNotifyAgentSheet;', ctx);
  ctx.paint();
  assert.ok(el.innerHTML.includes('You will be told when this reply is done (tap to cancel)'));
  ctx.notifyPrefs = { default: { requested: 'off' }, agents: {} }; ctx.paint();
  assert.ok(el.innerHTML.includes('(Requests you made is Off: no notification)'));
  ctx.notifyPrefs = { default: { requested: 'away' }, agents: {} }; ctx.paint();
  assert.ok(el.innerHTML.includes('(only when you are away)'));
  ctx.notifyServerMode.helper = 'off'; ctx.notifyPrefs = null; ctx.paint();   // the hub's last answer wins over a missing or stale cache
  assert.ok(el.innerHTML.includes('(Requests you made is Off: no notification)'));
});

// Review r5: settings that arrive after a bell tap (a save in the sheet, or a newer load) are newer than the mode the
// hub reported with that tap, so the remembered mode is dropped and the sheet reads the settings again.
test('newer settings replace the mode remembered from a bell tap (On -> Off and Off -> On while armed)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
  const a = src.indexOf('function adoptNotifyPrefs(prefs) {');
  assert.ok(a > 0, 'adoptNotifyPrefs exists');
  const body = src.slice(a, src.indexOf('\n}\n', a) + 2);
  const ctx = { notifyPrefs: null, notifyServerMode: { helper: 'on', coach: 'off' } };
  vm.createContext(ctx);
  vm.runInContext(`${body}; this.adopt = adoptNotifyPrefs;`, ctx);
  ctx.adopt({ default: { requested: 'off' }, agents: {} });
  assert.deepStrictEqual(ctx.notifyPrefs, { default: { requested: 'off' }, agents: {} });
  assert.deepStrictEqual(Object.keys(ctx.notifyServerMode), [], 'every remembered mode is dropped');
  // Both places that take new settings go through it; nothing assigns them around it.
  assert.ok(/notifyPrefsPending === 0\) adoptNotifyPrefs\(d\.prefs\);/.test(src), 'a load');
  assert.ok(/if \(d\.prefs\) adoptNotifyPrefs\(d\.prefs\);/.test(src), 'a save');
  assert.ok(!/notifyPrefs = d\.prefs/.test(src), 'no direct assignment left');
});
