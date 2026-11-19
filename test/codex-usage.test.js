'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createCodexUsage, windowLabel } = require('../lib/codex-usage');

const T0 = Date.parse('2026-11-19T20:00:00Z');
const RESET_S = Math.floor(Date.parse('2026-11-23T16:48:00Z') / 1000);   // a Monday, after T0
const RESET_ISO = new Date(RESET_S * 1000).toISOString();

function make(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-'));
  const stateFile = path.join(dir, 'codex-usage.json');
  const clock = { t: T0 };
  const settings = { ...(o.settings || {}) };
  const published = [];
  const notified = [];
  const u = createCodexUsage({
    getSetting: (k) => settings[k],
    now: () => clock.t,
    stateFile,
    publish: (type, data) => published.push({ type, data }),
    notify: (p) => notified.push(p),
    listAgents: () => o.agents || [{ name: 'cx', model: 'codex-cli/gpt-x' }, { name: 'cl', model: 'claude-sdk/claude-opus-5-5' }],
    readLimits: o.readLimits,
    updateActive: o.updateActive || (() => false),
    log: () => {},
    whenText: (iso) => `<${iso}>`,
  });
  return { u, dir, stateFile, clock, settings, published, notified };
}

const proRead = () => ({
  rateLimits: { limitId: 'codex', limitName: null, planType: 'pro', primary: { usedPercent: 14, windowDurationMins: 10080, resetsAt: RESET_S }, secondary: null, rateLimitReachedType: null, spendControlReached: null, credits: null },
  rateLimitsByLimitId: null, accountId: 'acct-SECRET-1', ordinaryUsageAllowed: true,
  rateLimitResetCredits: { availableCount: 3, credits: [{ id: 'c1' }] }, rateLimitUpsell: { x: 1 },
});
const weekly = (pct, extra = {}) => ({ limitId: 'codex', planType: 'pro', primary: { usedPercent: pct, windowDurationMins: 10080, resetsAt: RESET_S }, secondary: null, ...extra });

test('windowLabel', () => {
  assert.strictEqual(windowLabel(10080), 'weekly');
  assert.strictEqual(windowLabel(300), '5-hour');
  assert.strictEqual(windowLabel(1440), '1-day');
  assert.strictEqual(windowLabel(120), '2-hour');
  assert.strictEqual(windowLabel(45), '45-minute');
  assert.strictEqual(windowLabel(null), 'usage');
});

test('the real Pro reading: one weekly window, no secondary bar', () => {
  const { u } = make();
  assert.strictEqual(u.noteRead(proRead()), true);
  const s = u.snapshot();
  assert.strictEqual(s.enabled, true);
  assert.strictEqual(s.planType, 'pro');
  assert.strictEqual(s.resetCredits, 3);
  assert.strictEqual(s.source, 'read');
  assert.strictEqual(s.limits.length, 1);
  const l = s.limits[0];
  assert.strictEqual(l.id, 'codex');
  assert.strictEqual(l.label, 'ChatGPT');
  assert.strictEqual(l.windows.length, 1);
  assert.strictEqual(l.windows[0].label, 'weekly');
  assert.strictEqual(l.windows[0].key, 'primary');
  assert.strictEqual(l.windows[0].weekly, true);
  assert.strictEqual(l.windows[0].short, false);
  assert.strictEqual(l.windows[0].usedPercent, 14);
  assert.strictEqual(l.windows[0].resetsAt, RESET_ISO);
  assert.deepStrictEqual(s.weekly, [{ limit: 'codex', label: 'ChatGPT', usedPercent: 14, resetsAt: RESET_ISO, reached: false }]);
  assert.deepStrictEqual(s.warn, { at: [75, 90] });
});

test('two windows are sorted shortest first and told apart by length', () => {
  const { u } = make();
  u.noteSnapshot({ limitId: 'codex', primary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: RESET_S }, secondary: { usedPercent: 40, windowDurationMins: 300, resetsAt: Math.floor(T0 / 1000) + 3600 } }, { source: 'read' });
  const w = u.snapshot().limits[0].windows;
  assert.deepStrictEqual(w.map(x => x.label), ['5-hour', 'weekly']);
  assert.strictEqual(w[0].short, true);
  assert.strictEqual(w[0].weekly, false);
  assert.strictEqual(u.snapshot().weekly.length, 1);
});

test('an expired window is flagged and leaves the weekly list', () => {
  const { u } = make();
  u.noteSnapshot(weekly(50), { source: 'read' });
  assert.strictEqual(u.snapshot().weekly.length, 1);
  const past = make();
  past.u.noteSnapshot({ limitId: 'codex', primary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: Math.floor(T0 / 1000) - 10 } }, { source: 'read' });
  assert.strictEqual(past.u.snapshot().limits[0].windows[0].expired, true);
  assert.strictEqual(past.u.snapshot().weekly.length, 0);
});

test('turn notifications merge: sparse fields keep what is known, null does not clear', () => {
  const { u } = make();
  u.noteSnapshot(weekly(14, { rateLimitReachedType: null, credits: { hasCredits: true, unlimited: false, balance: '12.50' } }), { source: 'read' });
  u.noteSnapshot({ primary: { usedPercent: 20 } });                       // no limitId: "codex"
  let l = u.snapshot().limits[0];
  assert.strictEqual(l.windows[0].usedPercent, 20);
  assert.strictEqual(l.windows[0].minutes, 10080);
  assert.strictEqual(l.windows[0].resetsAt, RESET_ISO);
  assert.strictEqual(u.snapshot().source, 'turn');
  u.noteSnapshot({ limitId: 'codex', primary: null, secondary: null, credits: null, rateLimitReachedType: null, planType: null, limitName: null });
  l = u.snapshot().limits[0];
  assert.strictEqual(l.windows.length, 1);
  assert.strictEqual(l.windows[0].usedPercent, 20);
  assert.deepStrictEqual(l.credits, { hasCredits: true, unlimited: false });
  assert.strictEqual(u.snapshot().planType, 'pro');
  assert.strictEqual(u.snapshot().limits.length, 1);
});

test('a read replaces: null clears, and a limit missing from the result is removed', () => {
  const { u } = make();
  u.noteRead({ rateLimits: null, rateLimitsByLimitId: { codex: weekly(30, { credits: { hasCredits: true, unlimited: false } }), codex_other: { limitId: 'codex_other', limitName: 'Other', primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: RESET_S } } } });
  assert.deepStrictEqual(u.snapshot().limits.map(l => l.id).sort(), ['codex', 'codex_other']);
  assert.strictEqual(u.snapshot().limits.find(l => l.id === 'codex_other').label, 'Other');
  u.noteRead({ rateLimitsByLimitId: { codex: { limitId: 'codex', primary: null, secondary: null, credits: null } } });
  const s = u.snapshot();
  assert.deepStrictEqual(s.limits.map(l => l.id), ['codex']);
  assert.strictEqual(s.limits[0].windows.length, 0);
  assert.strictEqual(s.limits[0].credits, null);
  assert.strictEqual(s.resetCredits, null);
  // rateLimits alone when the map is null
  u.noteRead(proRead());
  assert.deepStrictEqual(u.snapshot().limits.map(l => l.id), ['codex']);
  assert.strictEqual(u.snapshot().limits[0].windows[0].usedPercent, 14);
});

test('validation: bad ids dropped, names cleaned and cut, percent clamped, reset times in s and ms, odd dates null', () => {
  const { u } = make();
  for (const bad of ['has space', '', 'x'.repeat(65), 'a/b', 5]) assert.strictEqual(u.noteSnapshot({ limitId: bad, primary: { usedPercent: 1 } }), null);
  assert.strictEqual(u.noteSnapshot('nope'), null);
  assert.strictEqual(u.snapshot().limits.length, 0);
  u.noteSnapshot({ limitId: 'ok.1:x-y_z', limitName: '  Pro\u0007 \u0000plan' + 'x'.repeat(100), planType: 'Bad Plan!', rateLimitReachedType: 'a b',
    primary: { usedPercent: 140.4, windowDurationMins: 10080, resetsAt: RESET_S * 1000 }, secondary: { usedPercent: -5, windowDurationMins: 0, resetsAt: 5 } }, { source: 'read' });
  const l = u.snapshot().limits[0];
  assert.strictEqual(l.id, 'ok.1:x-y_z');
  assert.ok(!/[\u0000-\u001f]/.test(l.name));
  assert.ok(l.name.startsWith('Pro plan'));
  assert.ok(l.name.length <= 60);
  assert.strictEqual(l.planType, null);
  assert.strictEqual(l.reachedType, null);
  const byKey = Object.fromEntries(l.windows.map(w => [w.key, w]));
  assert.strictEqual(byKey.primary.usedPercent, 100);
  assert.strictEqual(byKey.primary.resetsAt, RESET_ISO);          // milliseconds accepted
  assert.strictEqual(byKey.secondary.usedPercent, 0);
  assert.strictEqual(byKey.secondary.minutes, null);              // 0 minutes is not a length
  assert.strictEqual(byKey.secondary.resetsAt, null);             // 5 s after 1970
  assert.strictEqual(byKey.secondary.label, 'usage');
  const far = make();
  far.u.noteSnapshot({ primary: { usedPercent: 1, windowDurationMins: 89281, resetsAt: Date.UTC(2150, 0, 1) } }, { source: 'read' });
  const w = far.u.snapshot().limits[0].windows[0];
  assert.strictEqual(w.minutes, null);
  assert.strictEqual(w.resetsAt, null);
  const rounded = make();
  rounded.u.noteSnapshot({ primary: { usedPercent: 33.6, windowDurationMins: 89280 } }, { source: 'read' });
  assert.strictEqual(rounded.u.snapshot().limits[0].windows[0].usedPercent, 34);
  assert.strictEqual(rounded.u.snapshot().limits[0].windows[0].minutes, 89280);
});

test('at most 8 limits are kept, the most recently seen', () => {
  const { u, clock } = make();
  for (let i = 0; i < 10; i++) { clock.t += 1000; u.noteSnapshot({ limitId: `l${i}`, primary: { usedPercent: i } }); }
  const ids = u.snapshot().limits.map(l => l.id).sort();
  assert.strictEqual(ids.length, 8);
  assert.ok(!ids.includes('l0') && !ids.includes('l1'));
  assert.ok(ids.includes('l9'));
});

test('the saved file never holds accountId, balances or credit details; written atomically with mode 0600', () => {
  const { u, stateFile, dir } = make();
  u.noteRead({ ...proRead(), rateLimits: { ...proRead().rateLimits, credits: { hasCredits: true, unlimited: false, balance: '99.99' }, individualLimit: { secret: 1 } } });
  u.flush();
  const raw = fs.readFileSync(stateFile, 'utf8');
  for (const bad of ['acct-SECRET-1', 'accountId', 'balance', '99.99', 'individualLimit', 'rateLimitUpsell', 'c1', 'credits":[']) assert.ok(!raw.includes(bad), bad);
  const j = JSON.parse(raw);
  assert.deepStrictEqual(j.limits.codex.credits, { hasCredits: true, unlimited: false });
  assert.strictEqual(j.resetCredits, 3);
  assert.deepStrictEqual(fs.readdirSync(dir), ['codex-usage.json']);
  assert.strictEqual(fs.statSync(stateFile).mode & 0o777, 0o600);
});

test('state survives a restart; a missing or broken file starts empty', () => {
  const a = make();
  a.u.noteRead(proRead());
  a.u.flush();
  const again = createCodexUsage({ getSetting: () => undefined, now: () => T0, stateFile: a.stateFile, log: () => {}, whenText: String });
  assert.strictEqual(again.snapshot().limits[0].windows[0].usedPercent, 14);
  assert.strictEqual(again.snapshot().resetCredits, 3);
  fs.writeFileSync(a.stateFile, '{not json');
  const logs = [];
  const broken = createCodexUsage({ getSetting: () => undefined, now: () => T0, stateFile: a.stateFile, log: (m) => logs.push(m) });
  assert.deepStrictEqual(broken.snapshot().limits, []);
  broken.snapshot();
  assert.strictEqual(logs.length, 1);
  const none = createCodexUsage({ getSetting: () => undefined, now: () => T0, stateFile: path.join(a.dir, 'nope', 'x.json'), log: () => {} });
  assert.deepStrictEqual(none.snapshot().limits, []);
});

test('writes are debounced: a reading schedules one write, flush() writes now', () => {
  const { u, stateFile } = make();
  u.noteSnapshot(weekly(10));
  assert.strictEqual(fs.existsSync(stateFile), false);            // debounced (and the timer is unref'd)
  u.flush();
  assert.strictEqual(fs.existsSync(stateFile), true);
});

test('published at most once per 5 s', () => {
  const { u, published, clock } = make();
  u.noteSnapshot(weekly(10));
  u.noteSnapshot(weekly(11));
  u.noteSnapshot(weekly(12));
  assert.strictEqual(published.filter(p => p.type === 'codex_usage').length, 1);
  assert.strictEqual(published[0].data.limits[0].windows[0].usedPercent, 10);
  clock.t += 6000;
  u.noteSnapshot(weekly(13));
  assert.strictEqual(published.filter(p => p.type === 'codex_usage').length, 2);
});

test('warnings: 75 then 90 once each, never repeated, again after the window resets', () => {
  const { u, published, notified, clock } = make();
  u.noteSnapshot(weekly(60));
  assert.strictEqual(notified.length, 0);
  u.noteSnapshot(weekly(76));
  assert.strictEqual(notified.length, 1);
  assert.strictEqual(notified[0].title, "ChatGPT plan: 76% of this week's allowance");
  assert.strictEqual(notified[0].url, '/mobile');
  assert.strictEqual(notified[0].tag, 'plan-chatgpt-codex');
  assert.ok(notified[0].body.includes(`Resets <${RESET_ISO}>.`));
  assert.ok(notified[0].body.includes('1 agent(s) run on ChatGPT (Codex).'));
  const ev = published.filter(p => p.type === 'plan_warning');
  assert.deepStrictEqual(ev[0].data, { provider: 'chatgpt', window: 'chatgpt:codex', label: 'ChatGPT', family: null, utilization: 76, level: 75, resetsAt: RESET_ISO, agents: ['cx'], autoSwitch: false });
  u.noteSnapshot(weekly(80));
  assert.strictEqual(notified.length, 1);
  u.noteSnapshot(weekly(91));
  assert.strictEqual(notified.length, 2);
  assert.strictEqual(published.filter(p => p.type === 'plan_warning')[1].data.level, 90);
  u.noteSnapshot(weekly(99));
  assert.strictEqual(notified.length, 2);
  // a new weekly window (reset a week later): announced again
  clock.t = Date.parse('2026-11-24T00:00:00Z');
  u.noteSnapshot({ limitId: 'codex', primary: { usedPercent: 76, windowDurationMins: 10080, resetsAt: RESET_S + 7 * 86400 } });
  assert.strictEqual(notified.length, 3);
});

test('a jump straight to 95 marks both levels and announces once, for the highest', () => {
  const { u, published, notified } = make();
  u.noteSnapshot(weekly(95));
  assert.strictEqual(notified.length, 1);
  assert.strictEqual(published.filter(p => p.type === 'plan_warning')[0].data.level, 90);
  u.noteSnapshot(weekly(96));
  u.noteSnapshot(weekly(76));
  assert.strictEqual(notified.length, 1);
});

test('warning levels come from planWarn; [] turns them off; the default is 75 and 90', () => {
  const off = make({ settings: { planWarn: { at: [] } } });
  off.u.noteSnapshot(weekly(99));
  assert.strictEqual(off.notified.length, 0);
  assert.deepStrictEqual(off.u.snapshot().warn, { at: [] });
  const custom = make({ settings: { planWarn: { at: [50] } } });
  custom.u.noteSnapshot(weekly(55));
  assert.strictEqual(custom.notified.length, 1);
  assert.deepStrictEqual(custom.u.snapshot().warn, { at: [50] });
  const nul = make({ settings: { planWarn: null } });
  assert.deepStrictEqual(nul.u.snapshot().warn, { at: [75, 90] });
  nul.u.noteSnapshot(weekly(74));
  assert.strictEqual(nul.notified.length, 0);
});

test('no warning for a window that has reset, or for a non-weekly window', () => {
  const { u, notified } = make();
  u.noteSnapshot({ limitId: 'codex', primary: { usedPercent: 99, windowDurationMins: 10080, resetsAt: Math.floor(T0 / 1000) - 60 } });
  u.noteSnapshot({ limitId: 'codex2', primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: RESET_S } });
  assert.strictEqual(notified.length, 0);
});

test('reached: announced once per window, with its own tag', () => {
  const { u, published, notified } = make();
  u.noteSnapshot(weekly(100, { rateLimitReachedType: 'rate_limit_reached' }), { source: 'read' });
  const reached = notified.filter(n => n.title === 'ChatGPT plan limit reached');
  assert.strictEqual(reached.length, 1);
  assert.strictEqual(reached[0].tag, 'plan-chatgpt-reached-codex');
  assert.strictEqual(reached[0].body, `Codex agents can't run on the ChatGPT plan until <${RESET_ISO}>.`);
  const ev = published.filter(p => p.type === 'plan_warning' && p.data.reached);
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].data.level, 100);
  assert.strictEqual(ev[0].data.window, 'chatgpt:codex');
  u.noteSnapshot(weekly(100, { rateLimitReachedType: 'rate_limit_reached' }), { source: 'read' });
  assert.strictEqual(notified.filter(n => n.title === 'ChatGPT plan limit reached').length, 1);
  assert.strictEqual(u.snapshot().limits[0].reached, true);
  // spend control also counts
  const sc = make();
  sc.u.noteSnapshot({ limitId: 'codex', spendControlReached: true, primary: { usedPercent: 10, windowDurationMins: 10080 } }, { source: 'read' });
  assert.strictEqual(sc.notified.length, 1);
  assert.strictEqual(sc.notified[0].body, "Codex agents can't run on the ChatGPT plan until it resets.");
});

test('warning markers are saved, so a restart does not announce again', () => {
  const a = make();
  a.u.noteSnapshot(weekly(80));
  a.u.flush();
  assert.strictEqual(a.notified.length, 1);
  const n2 = [];
  const again = createCodexUsage({ getSetting: () => undefined, now: () => T0, stateFile: a.stateFile, notify: (p) => n2.push(p), log: () => {}, whenText: String });
  again.noteSnapshot(weekly(81));
  assert.strictEqual(n2.length, 0);
});

test('the setting off: readings ignored, no warnings, readNow refused, snapshot says so', async () => {
  let called = 0;
  const { u, notified, settings } = make({ settings: { subscriptionUsage: false }, readLimits: async () => { called++; return proRead(); } });
  assert.strictEqual(u.noteSnapshot(weekly(99)), null);
  assert.strictEqual(u.noteRead(proRead()), false);
  assert.strictEqual(notified.length, 0);
  assert.deepStrictEqual(await u.readNow(), { ok: false, error: 'Subscription usage is off.' });
  assert.strictEqual(called, 0);
  const s = u.snapshot();
  assert.strictEqual(s.enabled, false);
  assert.deepStrictEqual(s.limits, []);
  settings.subscriptionUsage = undefined;                         // on unless exactly false
  assert.strictEqual(u.snapshot().enabled, true);
  settings.subscriptionUsage = 0;
  assert.strictEqual(u.snapshot().enabled, true);
});

test('readNow: success goes through noteRead; a second call within 60 s is answered from the store', async () => {
  let calls = 0;
  const { u, clock, stateFile } = make({ readLimits: async () => { calls++; return proRead(); } });
  const r = await u.readNow();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.cached, undefined);
  assert.strictEqual(r.snapshot.limits[0].windows[0].usedPercent, 14);
  assert.strictEqual(r.snapshot.reading, false);
  assert.ok(fs.existsSync(stateFile));                            // written right after the read
  clock.t += 30000;
  const c = await u.readNow();
  assert.strictEqual(c.ok, true);
  assert.strictEqual(c.cached, true);
  assert.strictEqual(calls, 1);
  clock.t += 31000;
  await u.readNow();
  assert.strictEqual(calls, 2);
});

test('readNow: refused while Codex updates, and nothing starts', async () => {
  let calls = 0; let updating = true;
  const { u } = make({ readLimits: async () => { calls++; return proRead(); }, updateActive: () => updating });
  assert.deepStrictEqual(await u.readNow(), { ok: false, error: 'Codex is updating; try again in a few minutes.' });
  assert.strictEqual(calls, 0);
  updating = false;
  assert.strictEqual((await u.readNow()).ok, true);
});

test('readNow: one at a time, a second caller gets the same promise', async () => {
  let calls = 0; let release;
  const gate = new Promise((r) => { release = r; });
  const { u } = make({ readLimits: async () => { calls++; await gate; return proRead(); } });
  const a = u.readNow();
  const b = u.readNow();
  assert.strictEqual(a, b);
  assert.strictEqual(u.snapshot().reading, true);
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.strictEqual(ra.ok, true);
  assert.strictEqual(rb, ra);
  assert.strictEqual(calls, 1);
});

test('readNow errors become plain sentences and never throw', async () => {
  const cases = [
    [Object.assign(new Error('account/rateLimits/read: codex account authentication required to read rate limits'), { code: -32600, rpcMessage: 'codex account authentication required to read rate limits' }), "Codex isn't signed in to ChatGPT."],
    [new Error('ENOENT codex'), "Codex isn't installed."],
    // an older Codex without the request: not "isn't installed"
    [Object.assign(new Error('account/rateLimits/read: Method not found'), { code: -32601, rpcMessage: 'Method not found' }), "This Codex version can't report the plan's usage; a newer one can."],
    [new Error('account/rateLimits/read: no reply in 20s'), "Codex didn't answer in time."],
    [Object.assign(new Error('Codex timed out reading the plan usage'), { code: 'ETIMEDOUT' }), "Codex didn't answer in time."],
    [new Error('boom\nsecond line'), "Couldn't read the ChatGPT plan's usage: boom"],
    [new Error('x'.repeat(400)), `Couldn't read the ChatGPT plan's usage: ${'x'.repeat(160)}`],
  ];
  for (const [err, want] of cases) {
    const { u } = make({ readLimits: async () => { throw err; } });
    const r = await u.readNow();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, want);
    assert.strictEqual(r.snapshot.error, want);
  }
  const sync = make({ readLimits: () => { throw new Error('sync fail'); } });
  assert.strictEqual((await sync.u.readNow()).ok, false);
  // a later good read clears the error
  let fail = true;
  const m = make({ readLimits: async () => { if (fail) throw new Error('boom'); return proRead(); } });
  await m.u.readNow();
  fail = false; m.clock.t += 61000;
  const ok = await m.u.readNow();
  assert.strictEqual(ok.snapshot.error, null);
});

test('the module names no Codex request other than initialize and account/rateLimits/read', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'codex-usage.js'), 'utf8');
  assert.ok(!/consume/i.test(src));
  assert.ok(!/rateLimitResetCredit\//.test(src));
  const methods = new Set((src.match(/['"`]((?:account|thread|turn|item|config|model|fs|command|plugin|app|skills|mcpServer|feedback|review|login|logout)\/[A-Za-z/]+)['"`]/g) || []).map(s => s.slice(1, -1)));
  assert.deepStrictEqual([...methods], ['account/rateLimits/read']);
  const requests = (src.match(/\.request\(\s*['"`][^'"`]+['"`]/g) || []).map(s => s.replace(/^\.request\(\s*['"`]|['"`]$/g, ''));
  assert.deepStrictEqual(requests, ['account/rateLimits/read']);
  assert.ok(/\.initialize\(/.test(src));
});
