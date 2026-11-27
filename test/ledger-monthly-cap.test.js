'use strict';
// The monthly spending cap (settings.ledger.monthlyUsd / monthlyResetDay): the month window in the hub's zone, what counts,
// the 80% / 100% notices (once per period), the guard before every pay-per-use request, the settings validation and journal.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeIsolatedInstall } = require('./helpers/isolated-install');

const inst = makeIsolatedInstall('mcap-', { copy: ['templates/settings-records.json'] });
const L = (m) => require(path.join(inst.lib, m));
const { createLedger, cleanMonthly, monthPeriod } = L('ledger');
const gateway = L('gateway-client');
const settings = L('settings');
const journal = L('settings-journal');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const T0 = Date.parse('2026-11-20T12:00:00Z');
function mk(cfg = { monthlyUsd: 100, monthlyResetDay: 1 }, zone = 'UTC') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcap-')); dirs.push(dir);
  const clock = { t: T0 }; const c = { v: cfg };
  const events = []; const pushes = [];
  const l = createLedger({ file: path.join(dir, 'ledger.db'), now: () => clock.t, getCaps: () => c.v, getZone: () => zone,
    publish: (type, data) => events.push({ type, data }), notify: (p) => pushes.push(p) });
  return { l, clock, c, events, pushes, dir };
}
const pay = (l, usd, extra = {}) => l.record({ agent: 'a', model: 'anthropic/claude-sonnet-5-5', costUsd: usd, ...extra });

test('the month window follows the hub zone across the reset day (computed on ts, not the server day)', () => {
  // Reset on the 15th. 2026-11-15T07:30Z is Nov 14 23:30 in Los Angeles (still the old month) but Nov 15 20:30 in Auckland (new month).
  const ts = Date.parse('2026-11-15T07:30:00Z');
  const la = monthPeriod(15, ts, 'America/Los_Angeles');
  const nz = monthPeriod(15, ts, 'Pacific/Auckland');
  assert.equal(new Date(la.start).toISOString(), '2026-10-15T07:00:00.000Z');   // Oct 15 00:00 PDT
  assert.equal(new Date(la.end).toISOString(), '2026-11-15T08:00:00.000Z');     // Nov 15 00:00 PST
  assert.equal(new Date(nz.start).toISOString(), '2026-11-14T11:00:00.000Z');   // Nov 15 00:00 NZDT
  assert.equal(new Date(nz.end).toISOString(), '2026-12-14T11:00:00.000Z');
  // And the ledger counts a row by that window: a $10 row at 07:30Z belongs to the LA old month, to the Auckland new month.
  for (const [zone, firstMonth] of [['America/Los_Angeles', true], ['Pacific/Auckland', false]]) {
    const { l, clock } = mk({ monthlyUsd: 100, monthlyResetDay: 15 }, zone);
    clock.t = ts; pay(l, 10);
    clock.t = Date.parse('2026-11-16T12:00:00Z');
    assert.equal(l.monthlySpend({ ts: Date.parse('2026-11-16T12:00:00Z') }).total, firstMonth ? 0 : 10, zone);
    assert.equal(l.monthlySpend({ ts }).total, firstMonth ? 10 : 10, zone);
  }
  const m = mk({ monthlyUsd: 100, monthlyResetDay: 1 }, 'America/New_York');
  const p = m.l.monthlySpend({ ts: Date.parse('2026-12-01T03:00:00Z') });   // Nov 30 22:00 EST: still November
  assert.equal(new Date(p.start).toISOString(), '2026-11-01T04:00:00.000Z');   // Nov 1 00:00 EDT
  assert.equal(new Date(p.end).toISOString(), '2026-12-01T05:00:00.000Z');
});

test('only pay-per-use counts: plan and local turns add nothing and are never refused; unpriced calls add no dollars', () => {
  const { l, clock } = mk({ monthlyUsd: 10, monthlyResetDay: 1 });
  l.record({ agent: 'a', model: 'claude-sdk/claude-opus-5-5', costUsd: 900 });
  l.record({ agent: 'a', model: 'codex-cli/gpt-6', inputTokens: 1e6, outputTokens: 1e6 });
  l.record({ agent: 'a', model: 'lmstudio/q', inputTokens: 1000, outputTokens: 1000 });
  l.record({ agent: 'a', model: 'openai/not-priced-model', inputTokens: 500, outputTokens: 500 });   // paid, price unknown
  l.record({ agent: 'a', model: 'openai/boom', ok: false });                                          // failed, no cost, no usage: not a paid turn
  const s = l.monthlySpend({ ts: clock.t });
  assert.equal(s.total, 0); assert.equal(s.unpriced, 1); assert.equal(s.over, false);
  pay(l, 12);
  assert.equal(l.monthlySpend().over, true);
  for (const model of ['claude-sdk/claude-opus-5-5', 'codex-cli/gpt-6', 'lmstudio/q', 'ollama/x']) assert.equal(l.monthlyGate({ model, agent: 'a' }), null, model);
  assert.equal(l.monthlyGate({ provider: 'claude-sdk', agent: 'a' }), null);
  assert.ok(l.monthlyGate({ provider: 'anthropic', agent: 'a' }).refused);
  assert.ok(l.monthlyGate({ model: 'codex/gpt-6', agent: 'a' }).refused, 'codex/ runs on the OpenAI key: paid');
});

test('80% announces once per period, 100% once, a second 80% reading stays quiet, a new period announces again', () => {
  const { l, clock, events, pushes } = mk({ monthlyUsd: 100, monthlyResetDay: 1 });
  pay(l, 79);
  assert.equal(events.length, 0, '79% is silent'); assert.equal(pushes.length, 0);
  pay(l, 1);   // 80%
  assert.deepEqual(events.map(e => [e.type, e.data.level]), [['spend_warning', 80]]);
  assert.equal(pushes.length, 1); assert.equal(pushes[0].tag, 'spend-80');
  pay(l, 1); pay(l, 1);   // 82%: still the same level
  assert.equal(events.length, 1, 'no second 80% notice');
  pay(l, 18);   // 100%
  assert.deepEqual(events.map(e => e.data.level), [80, 100]);
  assert.equal(pushes[1].tag, 'spend-100');
  pay(l, 5);
  assert.equal(events.length, 2, 'no second 100% notice');
  // The state is on disk, so a restart does not announce again.
  const again = createLedger({ file: l.file, now: () => clock.t, getCaps: () => ({ monthlyUsd: 100, monthlyResetDay: 1 }), getZone: () => 'UTC', publish: (t, d) => events.push({ type: t, data: d }) });
  again.record({ agent: 'a', model: 'anthropic/x', costUsd: 1 });
  assert.equal(events.length, 2, 'restart: same period, no repeat');
  // Next month: a fresh period.
  clock.t = Date.parse('2026-12-02T12:00:00Z');
  pay(l, 85);
  assert.deepEqual(events.slice(2).map(e => e.data.level), [80]);
});

test('at 100% a new turn\'s paid call is refused with the sentence; a turn that started before the cap was reached passes', () => {
  const { l, clock } = mk({ monthlyUsd: 50, monthlyResetDay: 1 });
  const turnStart = clock.t;               // a long turn begins now
  clock.t += 60000; pay(l, 49);
  assert.equal(l.monthlyGate({ provider: 'anthropic', agent: 'Scout', turnStartedAt: clock.t }), null, 'under the cap');
  clock.t += 60000; pay(l, 2);             // the cap is reached here
  const reachedAt = clock.t;
  assert.equal(l.capReachedAt(), reachedAt);
  assert.equal(l.monthlyGate({ provider: 'anthropic', agent: 'Scout', turnStartedAt: turnStart }), null, 'the turn started before the cap was reached');
  const g = l.monthlyGate({ provider: 'anthropic', agent: 'Scout', turnStartedAt: reachedAt + 1 });
  assert.equal(g.refused, true);
  assert.equal(g.text, 'Your monthly pay-per-use cap of $50 is used up ($51 spent since Nov 1). Scout uses a pay-per-use model, so it can\'t answer until Dec 1 or until you raise the monthly cap in Settings.');
  const rows = () => l.monthlySpend().turns;
  const before = rows(); l.monthlyGate({ provider: 'openai', agent: 'Scout' }); assert.equal(rows(), before, 'a refusal books nothing');
  // Raising the cap lifts the stop at once.
  const { l: l2, clock: c2, c } = mk({ monthlyUsd: 50, monthlyResetDay: 1 });
  pay(l2, 60); assert.ok(l2.monthlyGate({ provider: 'openai', agent: 'x' }));
  c.v = { monthlyUsd: 200, monthlyResetDay: 1 }; assert.equal(l2.monthlyGate({ provider: 'openai', agent: 'x' }), null);
  c.v = { monthlyUsd: null, monthlyResetDay: 1 }; assert.equal(l2.monthlyGate({ provider: 'openai', agent: 'x' }), null, 'no cap = never refused');
  void c2;
});

test('the refusal names the agent by its display name, else its id, else "This agent"; the pointer is the monthly cap in Settings; a failing lookup still refuses', () => {
  const mkWith = (getAgents) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcap-')); dirs.push(dir);
    const l = createLedger({ file: path.join(dir, 'ledger.db'), now: () => T0, getCaps: () => ({ monthlyUsd: 10, monthlyResetDay: 1 }), getZone: () => 'UTC', getAgents });
    pay(l, 20);
    return l;
  };
  const recs = () => [{ name: 'scout', display: 'Scout Prime' }, { name: 'plain', display: '' }, { name: 'nodisplay' }];
  const l = mkWith(recs);
  const text = (agent) => l.monthlyGate({ provider: 'anthropic', agent }).text;
  assert.match(text('scout'), /\)\. Scout Prime uses a pay-per-use model, so it can't answer until Dec 1 or until you raise the monthly cap in Settings\.$/);
  assert.match(text('plain'), /\)\. plain uses a pay-per-use model/, 'empty display: the id');
  assert.match(text('nodisplay'), /\)\. nodisplay uses a pay-per-use model/, 'no display: the id');
  assert.match(text('worker-label'), /\)\. worker-label uses a pay-per-use model/, 'not in the list (a temporary worker): its label');
  for (const none of [undefined, null, '', '  ']) assert.match(text(none), /\)\. This agent uses a pay-per-use model/, `no agent: ${JSON.stringify(none)}`);
  assert.ok(!/Money and safety/.test(text('scout')), 'no old group name');
  // A lookup that throws, or returns junk, never breaks the gate.
  for (const bad of [() => { throw new Error('agents file broken'); }, () => null, () => 'x']) {
    const lb = mkWith(bad);
    const g = lb.monthlyGate({ provider: 'anthropic', agent: 'scout' });
    assert.equal(g.refused, true);
    assert.match(g.text, /\)\. scout uses a pay-per-use model, so it can't answer until Dec 1 or until you raise the monthly cap in Settings\.$/);
    assert.match(lb.monthlyGate({ provider: 'anthropic' }).text, /\)\. This agent uses/);
  }
});

// The guard sits in lib/gateway-client, the one place every pay-per-use request passes (chat, consults, workers, research, tests).
async function viaGateway(l, call, opts) {
  const real = global.fetch; let fetched = 0;
  global.fetch = async () => { fetched++; throw new Error('network is not available in this test'); };
  gateway.setSpendGate((a) => l.monthlyGate(a));
  try { await call(opts); return { fetched, err: null }; } catch (err) { return { fetched, err }; }
  finally { global.fetch = real; gateway.setSpendGate(null); }
}

test('a subscription agent consulting a paid agent is refused at the paid call (a new turn), before anything is sent', async () => {
  const { l } = mk({ monthlyUsd: 10, monthlyResetDay: 1 });
  pay(l, 11);
  // The consulted agent runs a fresh turn on its own pay-per-use model.
  const r = await viaGateway(l, (o) => gateway.chatCompletionStream([{ role: 'user', content: 'hi' }], o), { model: 'openai/gpt-5', agent: 'PaidHelper', turnStartedAt: Date.now() });
  assert.equal(r.fetched, 0, 'nothing was sent');
  assert.ok(r.err && r.err.monthlyCap, 'refused with the cap error');
  assert.match(r.err.message, /^Your monthly pay-per-use cap of \$10 is used up/);
  assert.match(r.err.message, /PaidHelper uses a pay-per-use model/);
  // The subscription agent itself (claude-sdk) never goes through the gateway; the gate also lets a plan provider by.
  assert.equal(l.monthlyGate({ provider: 'claude-sdk', agent: 'Lead' }), null);
});

test('spawn_workers on a paid model is refused; on a local model it is not; the non-streaming call is guarded too', async () => {
  const { l } = mk({ monthlyUsd: 10, monthlyResetDay: 1 });
  pay(l, 11);
  const paid = await viaGateway(l, (o) => gateway.chatCompletion([{ role: 'user', content: 'work' }], o), { model: 'openrouter/vendor/model', agent: 'Lead-worker-1', turnStartedAt: Date.now() });
  assert.equal(paid.fetched, 0); assert.ok(paid.err && paid.err.monthlyCap);
  const local = await viaGateway(l, (o) => gateway.chatCompletionStream([{ role: 'user', content: 'work' }], o), { model: 'lmstudio/qwen', agent: 'Lead-worker-2', turnStartedAt: Date.now(), noRetries: true });
  assert.equal(local.fetched, 1, 'a local model is sent (and only fails on the stand-in network)');
  assert.ok(!(local.err && local.err.monthlyCap));
  // Workers, consults and research readers all run streamViaGateway, which installs the gate and passes the turn start.
  const sdk = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.match(sdk, /setSpendGate\(\(a\) => ledger\.monthlyGate\(a\)\)/);
  assert.match(sdk, /turnStartedAt: ledgerStartedAt/);
  assert.match(sdk, /if \(e && e\.monthlyCap\)/);
  const voice = fs.readFileSync(path.join(__dirname, '..', 'lib', 'voice', 'cloud.js'), 'utf8');
  assert.match(voice, /monthlyGate\(\{ provider: engine/);
});

test('cleanMonthly: plain errors, blank or 0 = no cap, day 1 to 28', () => {
  assert.deepEqual(cleanMonthly({ monthlyUsd: '', monthlyResetDay: '' }), { monthlyUsd: null, monthlyResetDay: 1 });
  assert.deepEqual(cleanMonthly({ monthlyUsd: 0 }), { monthlyUsd: null, monthlyResetDay: 1 });
  assert.deepEqual(cleanMonthly({ monthlyUsd: '$250.456', monthlyResetDay: '15' }), { monthlyUsd: 250.46, monthlyResetDay: 15 });
  assert.throws(() => cleanMonthly({ monthlyUsd: 'abc' }), /The monthly cap must be a dollar amount, or blank for none\./);
  assert.throws(() => cleanMonthly({ monthlyUsd: -5 }), /dollar amount/);
  for (const d of [0, 29, 1.5, 'x']) assert.throws(() => cleanMonthly({ monthlyUsd: 10, monthlyResetDay: d }), /The month starts on a day from 1 to 28\./, String(d));
});

test('the caps route accepts the monthly cap and its change is journaled by the settings hook', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = server.slice(server.indexOf("pathname === '/api/ledger/caps'"), server.indexOf("pathname === '/api/hub/pacing/reset'"));
  assert.match(route, /cleanMonthly/); assert.match(route, /monthlyUsd: monthly\.monthlyUsd, monthlyResetDay: monthly\.monthlyResetDay/);
  assert.match(route, /jsonResponse\(res, 400, \{ error: e\.message \}\)/, 'a bad value is a plain 400');
  assert.match(server, /pathname === '\/api\/ledger\/month'/);
  // What the route writes, through the real store: one journal entry per changed key.
  settings.updateSettings({ ledger: { perAgentDailyUsd: null, hubDailyUsd: null, ...cleanMonthly({ monthlyUsd: 75, monthlyResetDay: 5 }) } });
  const list = journal.list({ limit: 50 });
  const usd = list.find(e => e.key === 'ledger.monthlyUsd'), day = list.find(e => e.key === 'ledger.monthlyResetDay');
  assert.ok(usd && day, JSON.stringify(list.map(e => e.key)));
  assert.equal(usd.after, 75); assert.equal(day.after, 5); assert.equal(usd.store, 'settings');
  assert.deepEqual([settings.getSetting('ledger', {}).monthlyUsd, settings.getSetting('ledger', {}).monthlyResetDay], [75, 5]);
});
