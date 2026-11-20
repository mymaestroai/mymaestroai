'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createCodexUsage } = require('../lib/codex-usage');

const T0 = Date.parse('2026-11-19T20:00:00Z');
const RESET_S = Math.floor(Date.parse('2026-11-23T16:48:00Z') / 1000);
const RESET_ISO = new Date(RESET_S * 1000).toISOString();
const TAIL = '. Settings → Subscriptions shows every window.';

function make(settings = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-'));
  const clock = { t: T0 };
  const u = createCodexUsage({
    getSetting: (k) => settings[k], now: () => clock.t, stateFile: path.join(dir, 'codex-usage.json'),
    listAgents: () => [], log: () => {}, whenText: (iso) => `<${iso}>`,
  });
  return { u, clock, settings };
}
const claude = (o = {}) => ({ windows: { seven_day: { utilization: 42.2, resets_at: '2026-11-23T16:48:00Z' }, five_hour: { utilization: 63 }, ...o.windows }, fetchedAt: '2026-11-19T19:59:00Z' });
const weekly = (pct, extra = {}) => ({ limitId: 'codex', primary: { usedPercent: pct, windowDurationMins: 10080, resetsAt: RESET_S }, secondary: null, ...extra });

test('both plans, ChatGPT seen just now', () => {
  const { u } = make();
  u.noteSnapshot(weekly(14), { source: 'read' });
  assert.strictEqual(u.briefLine({ claude: claude() }),
    `- Subscriptions: Claude plan 42% of this week (5-hour 63%), resets <2026-11-23T16:48:00Z>; ChatGPT plan 14% of this week, resets <${RESET_ISO}>${TAIL}`);
});

test('Claude only; and no 5-hour part when that window is missing', () => {
  const { u } = make();
  assert.strictEqual(u.briefLine({ claude: claude() }), `- Subscriptions: Claude plan 42% of this week (5-hour 63%), resets <2026-11-23T16:48:00Z>${TAIL}`);
  const c = { windows: { seven_day: { utilization: 10, resets_at: '2026-11-23T16:48:00Z' } } };
  assert.strictEqual(u.briefLine({ claude: c }), `- Subscriptions: Claude plan 10% of this week, resets <2026-11-23T16:48:00Z>${TAIL}`);
});

test('ChatGPT only', () => {
  const { u } = make();
  u.noteSnapshot(weekly(14), { source: 'read' });
  assert.strictEqual(u.briefLine({ claude: null }), `- Subscriptions: ChatGPT plan 14% of this week, resets <${RESET_ISO}>${TAIL}`);
  assert.strictEqual(u.briefLine(), `- Subscriptions: ChatGPT plan 14% of this week, resets <${RESET_ISO}>${TAIL}`);
});

test('last seen only when the reading is over 30 minutes old', () => {
  const { u, clock } = make();
  u.noteSnapshot(weekly(14), { source: 'read' });
  clock.t += 29 * 60000;
  assert.ok(!u.briefLine({ claude: null }).includes('last seen'));
  clock.t += 2 * 60000;
  assert.strictEqual(u.briefLine({ claude: null }), `- Subscriptions: ChatGPT plan 14% of this week, resets <${RESET_ISO}> (last seen <${new Date(T0).toISOString()}>)${TAIL}`);
});

test('several ChatGPT limits: the highest weekly percentage', () => {
  const { u } = make();
  u.noteSnapshot(weekly(14), { source: 'read' });
  u.noteSnapshot({ limitId: 'other', primary: { usedPercent: 61, windowDurationMins: 10080, resetsAt: RESET_S } }, { source: 'read' });
  assert.ok(u.briefLine({ claude: null }).includes('ChatGPT plan 61% of this week'));
});

test('reached: says so, with the reset time', () => {
  const { u } = make();
  u.noteSnapshot(weekly(100, { rateLimitReachedType: 'rate_limit_reached' }), { source: 'read' });
  assert.strictEqual(u.briefLine({ claude: claude() }),
    `- Subscriptions: Claude plan 42% of this week (5-hour 63%), resets <2026-11-23T16:48:00Z>; ChatGPT plan limit reached until <${RESET_ISO}>${TAIL}`);
});

test('off, and nothing known, give an empty line', () => {
  const off = make({ subscriptionUsage: false });
  assert.strictEqual(off.u.briefLine({ claude: claude() }), '');
  const none = make();
  assert.strictEqual(none.u.briefLine({ claude: null }), '');
  assert.strictEqual(none.u.briefLine({ claude: { windows: {} } }), '');
  assert.strictEqual(none.u.briefLine(), '');
});

test('the line is one line', () => {
  const { u } = make();
  u.noteSnapshot({ ...weekly(14), limitName: 'Pro\nplan' }, { source: 'read' });
  assert.ok(!/\n/.test(u.briefLine({ claude: claude() })));
});
