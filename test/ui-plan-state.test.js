'use strict';
// How a weekly Claude plan window looks (lib/ui-plan-state.js), shared by the desktop and phone pages.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const L = require('../lib/ui-plan-state');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const BEGIN = '// ── plan state helpers (begin) ──';
const END = '// ── plan state helpers (end) ──';
function helperBlock(src, indent) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  assert.ok(a > 0 && b > a, 'helper markers present');
  return src.slice(a + BEGIN.length, b).split('\n').map(l => (indent && l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n').trim();
}

test('the plan state helpers are byte-identical in lib/ui-plan-state.js, app.js and mobile.js', () => {
  const lib = helperBlock(read('lib/ui-plan-state.js'), '');
  assert.strictEqual(helperBlock(read('app.js'), '    '), lib, 'app.js copy differs');
  assert.strictEqual(helperBlock(read('mobile.js'), ''), lib, 'mobile.js copy differs');
});

test('extra usage paying at 100%: warning, not refused; words say so', () => {
  const w = { utilization: 100, rejected: false, extraUsage: true };
  assert.deepStrictEqual(L.planState(w, [75, 90]), { pct: 100, extra: true, cls: 'warn' });
  assert.strictEqual(L.planPctText(w, [75, 90]), '100% · extra usage');
});

test('refused: rejected, or 100% without extra usage; rejected beats extraUsage', () => {
  assert.strictEqual(L.planState({ utilization: 60, rejected: true }, [75]).cls, 'refused');
  assert.strictEqual(L.planState({ utilization: 100 }, [75, 90]).cls, 'refused');
  const both = L.planState({ utilization: 100, rejected: true, extraUsage: true }, [75]);
  assert.deepStrictEqual([both.cls, both.extra], ['refused', false]);
  assert.strictEqual(L.planPctText({ utilization: 100, rejected: true, extraUsage: true }, []), '100%');
});

test('levels: all passed -> hot, some -> warn, none -> empty', () => {
  assert.strictEqual(L.planState({ utilization: 95 }, [75, 90]).cls, 'hot');
  assert.strictEqual(L.planState({ utilization: 80 }, [75, 90]).cls, 'warn');
  assert.strictEqual(L.planState({ utilization: 40 }, [75, 90]).cls, '');
  assert.strictEqual(L.planState({ utilization: 40 }).cls, '');
  assert.strictEqual(L.planPctText({ utilization: 89.6 }, [75]), '90%');
});

// ── the header badge: the plan always leads, the agent's model family joins it only when it is worse ──
const W = (family, utilization, extra) => Object.assign({ family, label: family ? family[0].toUpperCase() + family.slice(1) : null, utilization, rejected: false, extraUsage: false, resetsAt: '2026-11-30T20:00:00Z' }, extra || {});

test('planBadgeWindows: the plan is higher -> plan alone', () => {
  const r = L.planBadgeWindows([W(null, 40), W('fable', 22)], 'fable', [75, 90]);
  assert.strictEqual(r.lead.family, null);
  assert.strictEqual(r.second, null);
  assert.strictEqual(r.cls, '');
});
test('planBadgeWindows: the family is higher -> plan leads, family second', () => {
  const r = L.planBadgeWindows([W(null, 18), W('fable', 19)], 'fable', []);
  assert.strictEqual(r.lead.family, null);
  assert.strictEqual(r.second.family, 'fable');
});
test('planBadgeWindows: equal after rounding -> plan alone', () => {
  const r = L.planBadgeWindows([W(null, 18.2), W('fable', 18.4)], 'fable', []);
  assert.strictEqual(r.second, null);
});
test('planBadgeWindows: the family refused while the plan is not -> shown second, class refused', () => {
  const r = L.planBadgeWindows([W(null, 100, { rejected: false, extraUsage: true }), W('fable', 60, { rejected: true })], 'fable', [75]);
  assert.strictEqual(r.second.family, 'fable');
  assert.strictEqual(r.cls, 'refused');
  const r2 = L.planBadgeWindows([W(null, 100), W('fable', 100)], 'fable', []);
  assert.strictEqual(r2.second, null, 'plan refused too: not repeated');
  assert.strictEqual(r2.cls, 'refused');
});
test('planBadgeWindows: the family on extra usage while the plan is not -> shown second, class warn', () => {
  const r = L.planBadgeWindows([W(null, 100 - 1), W('fable', 100, { extraUsage: true })], 'fable', []);
  assert.strictEqual(r.second.family, 'fable');
  assert.strictEqual(r.cls, 'warn');
  const lowerButExtra = L.planBadgeWindows([W(null, 100, { extraUsage: false, rejected: false }), W('fable', 100, { extraUsage: true })], 'fable', []);
  assert.strictEqual(lowerButExtra.cls, 'refused', 'plan at 100% without extra usage is refused, and the worse class wins');
});
test('planBadgeWindows: no all-models window -> the family alone; no family window -> the plan alone; nothing -> null', () => {
  const a = L.planBadgeWindows([W('fable', 30)], 'fable', []);
  assert.deepStrictEqual([a.lead.family, a.second, a.cls], ['fable', null, '']);
  const b = L.planBadgeWindows([W(null, 30), W('opus', 90)], 'fable', []);
  assert.deepStrictEqual([b.lead.family, b.second], [null, null]);
  assert.strictEqual(L.planBadgeWindows([W('opus', 30)], 'fable', []), null);
  assert.strictEqual(L.planBadgeWindows([], 'fable', []), null);
  assert.strictEqual(L.planBadgeWindows([W(null, null), W('fable', null)], 'fable', []), null, 'windows without a reading do not count');
  assert.strictEqual(L.planBadgeWindows([W(null, 30), W('opus', 90)], null, []).second, null, 'no family (non-Claude-family model)');
});
test('planBadgeWindows: the class is the worse of the two windows, even when the family is not shown', () => {
  assert.strictEqual(L.planBadgeWindows([W(null, 80), W('fable', 20)], 'fable', [75, 90]).cls, 'warn');
  assert.strictEqual(L.planBadgeWindows([W(null, 80), W('fable', 95)], 'fable', [75, 90]).cls, 'hot');
  assert.strictEqual(L.planBadgeWindows([W(null, 95), W('fable', 80)], 'fable', [75, 90]).cls, 'hot');
});

// the pages: paint the badge with stubs and read what they write
const vm = require('vm');
function pageSlice(src, from, to) { const a = src.indexOf(from); const b = src.indexOf(to, a); assert.ok(a > 0 && b > a, 'slice ' + from); return src.slice(a, b); }
function desktopBadge(data, model, opts) {
  const o = opts || {};
  const el = { hidden: true, textContent: '', className: '', title: '', onclick: null };
  const ctx = vm.createContext({
    Math, Number, String, Array, Object, Date, planLast: data, chats: { c1: { agent: 'a', isGroup: false } }, chatModelOf: () => model,
    document: { getElementById: () => el }, subsIsCodex: (m) => /^codex-cli\//.test(m), subsEnabled: () => o.subs !== false,
    planWhen: (x) => 'WHEN-' + String(x).slice(5, 10), openPlanSettings() {}, openSubsSettings() {}, codexLast: null,
  });
  vm.runInContext(pageSlice(read('app.js'), '// ── plan state helpers (begin) ──', 'async function openPlanSettings('), ctx);
  vm.runInContext('paintPlanBadges()', ctx);
  return el;
}
function phoneBadge(data, model, opts) {
  const o = opts || {};
  const el = { hidden: true, textContent: '', className: '', title: '' };
  const ctx = vm.createContext({
    Math, Number, String, Array, Object, Date, planUsageLast: data, current: 'a', agentByName: () => ({ model }), $: () => el,
    subsEnabled: () => o.subs !== false, isAdmin: () => true, codexBadge() { return null; }, codexUsageLast: null, codexAskAt: 0,
    codexShouldRead: () => false, codexAskRead() {}, codexPendingBadge: () => null,
  });
  vm.runInContext(pageSlice(read('mobile.js'), '// ── plan state helpers (begin) ──', '\n// Every model change'), ctx);
  vm.runInContext('paintPlan()', ctx);
  return el;
}
const data = (weekly, five) => ({ weekly, windows: five == null ? {} : { five_hour: { utilization: five } }, warn: { at: [75, 90] } });
const FABLE = 'claude-sdk/claude-fable-5';

test('desktop badge: plan higher -> "Plan 40% this week"', () => {
  const el = desktopBadge(data([W(null, 40), W('fable', 22)]), FABLE);
  assert.strictEqual(el.textContent, 'Plan 40% this week');
  assert.strictEqual(el.hidden, false);
});
test('desktop badge: family higher -> "Plan 18% this week · Fable 19%"', () => {
  assert.strictEqual(desktopBadge(data([W(null, 18), W('fable', 19)]), FABLE).textContent, 'Plan 18% this week · Fable 19%');
});
test('desktop badge: equal after rounding -> plan alone', () => {
  assert.strictEqual(desktopBadge(data([W(null, 18.2), W('fable', 18.4)]), FABLE).textContent, 'Plan 18% this week');
});
test('desktop badge: family refused while the plan is not -> shown second, class refused', () => {
  const el = desktopBadge(data([W(null, 50), W('fable', 60, { rejected: true })]), FABLE);
  assert.strictEqual(el.textContent, 'Plan 50% this week · Fable 60%');
  assert.match(el.className, /\brefused\b/);
});
test('desktop badge: family on extra usage -> "Fable 100% · extra usage", class warn', () => {
  const el = desktopBadge(data([W(null, 99), W('fable', 100, { extraUsage: true })]), FABLE);
  assert.strictEqual(el.textContent, 'Plan 99% this week · Fable 100% · extra usage');
  assert.strictEqual(el.className, 'plan-badge hot');   // plan at 99 is past every level: the worse of hot and warn
});
test('desktop badge: no all-models window -> the family alone as today; non-Claude model -> no badge', () => {
  assert.strictEqual(desktopBadge(data([W('fable', 30)]), FABLE).textContent, 'Fable 30% this week');
  const none = desktopBadge(data([W(null, 30)]), 'openrouter/some-model');
  assert.strictEqual(none.hidden, true);
  assert.strictEqual(none.textContent, '');
});
test('desktop badge: the 5h suffix stays last; the class is the worse of the two; the title reads plan, family, 5-hour', () => {
  const el = desktopBadge(data([W(null, 80), W('fable', 95)], 62), FABLE);
  assert.strictEqual(el.textContent, 'Plan 80% this week · Fable 95% · 5h 62%');
  assert.strictEqual(el.className, 'plan-badge hot');
  const t = el.title;
  assert.ok(t.startsWith("Your Claude plan has used 80% of this week's allowance (resets WHEN-11-30)"), t);
  assert.ok(t.indexOf("; Fable has used 95% (resets WHEN-11-30)") > 0 && t.indexOf('; 5-hour window 62%') > t.indexOf('Fable has used'), t);
  assert.ok(t.endsWith('. Click to choose models (Settings → Claude plan).'), t);
  assert.strictEqual(desktopBadge(data([W(null, 80)], 40), FABLE).textContent, 'Plan 80% this week', 'no 5h at 50 or less');
  assert.strictEqual(desktopBadge(data([W(null, 80)], 62), FABLE, { subs: false }).textContent, 'Plan 80% this week', 'no 5h with subscriptions off');
});
test('desktop badge: a shown window on extra usage uses the "used up" sentence for its part', () => {
  const t = desktopBadge(data([W(null, 99), W('fable', 100, { extraUsage: true })]), FABLE).title;
  assert.ok(t.includes("Your Claude plan has used 99% of this week's allowance (resets WHEN-11-30); Fable is used up for this week until WHEN-11-30; extra usage is paying for Claude replies until then"), t);
});
test('desktop badge: the title with only the family window keeps today\'s text', () => {
  assert.strictEqual(desktopBadge(data([W('fable', 30)]), FABLE).title, "Fable has used 30% of this week's allowance (resets WHEN-11-30). Click to choose models (Settings → Claude plan).");
});

test('phone header: plan higher -> "Plan 40%"; family higher -> "Plan 18% · Fable 19%"; equal -> plan alone', () => {
  assert.strictEqual(phoneBadge(data([W(null, 40), W('fable', 22)]), FABLE).textContent, 'Plan 40%');
  assert.strictEqual(phoneBadge(data([W(null, 18), W('fable', 19)]), FABLE).textContent, 'Plan 18% · Fable 19%');
  assert.strictEqual(phoneBadge(data([W(null, 18.2), W('fable', 18.4)]), FABLE).textContent, 'Plan 18%');
});
test('phone header: refused / extra family shown with the worse class; no all-models window -> family alone; non-Claude -> none', () => {
  const r = phoneBadge(data([W(null, 50), W('fable', 60, { rejected: true })]), FABLE);
  assert.strictEqual(r.textContent, 'Plan 50% · Fable 60%');
  assert.strictEqual(r.className, 'sub refused');
  const e = phoneBadge(data([W(null, 30), W('fable', 100, { extraUsage: true })]), FABLE);
  assert.strictEqual(e.textContent, 'Plan 30% · Fable 100% · extra usage');
  assert.strictEqual(e.className, 'sub warn');
  assert.strictEqual(phoneBadge(data([W('fable', 30)]), FABLE).textContent, 'Fable 30%');
  assert.strictEqual(phoneBadge(data([W(null, 30)]), 'openrouter/x').hidden, true);
});
test('phone header: 5h suffix last; title reads plan, family, 5-hour', () => {
  const el = phoneBadge(data([W(null, 80), W('fable', 95)], 62), FABLE);
  assert.strictEqual(el.textContent, 'Plan 80% · Fable 95% · 5h 62%');
  assert.strictEqual(el.className, 'sub hot');
  assert.strictEqual(el.title, "All models: 80% of this week's Claude plan allowance; Fable: 95%; 5-hour window 62%");
  assert.strictEqual(phoneBadge(data([W(null, 80)]), FABLE).title, "All models: 80% of this week's Claude plan allowance");
  assert.strictEqual(phoneBadge(data([W('fable', 30)]), FABLE).title, "Fable: 30% of this week's Claude plan allowance");
});
test('simple mode hides both badges (desktop .agent-name children, phone #chat-plan)', () => {
  assert.ok(read('index.html').includes('html.mm-simple .chat-actions .agent-name > :not(.agent-name-text)'));
  assert.ok(read('mobile.html').includes('html.mm-simple #chat-plan,'));
});
