'use strict';
// Behavioural unit tests for lib/ledger.js (temp sqlite file via the `file` option, injected clock) and lib/approvals.js (injected clock, mocked timers).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLedger, estimateCost, priceFor, localDay, PRICES } = require('../lib/ledger');
const { createApprovals, hashArgs, DEFAULT_TIMEOUT_MS } = require('../lib/approvals');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const quiet = (fn) => { const e = console.error; console.error = () => {}; try { return fn(); } finally { console.error = e; } };
function mk(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-ledger-'));
  dirs.push(dir);
  const clock = { t: new Date(2026, 4, 10, 12, 0).getTime() };
  const l = createLedger({ file: path.join(dir, 'ledger.db'), now: () => clock.t, ...opts });
  return { l, clock, dir };
}
const rows = (l) => { const Database = require('better-sqlite3'); const d = new Database(l.file, { readonly: true }); try { return d.prepare('SELECT * FROM turns ORDER BY id').all(); } finally { d.close(); } };

test('priceFor / estimateCost: every PRICES row matches its own prefix (with or without provider and [suffix]); order resolves overlaps', () => {
  for (const [prefix, p] of PRICES) {
    assert.deepStrictEqual(priceFor(prefix), p, prefix);
    assert.deepStrictEqual(priceFor(`openai/${prefix}-x`.replace('openai', 'claude-sdk')), p, `${prefix} with provider`);
    assert.deepStrictEqual(priceFor(`${prefix.toUpperCase()}[1m]`), p, `${prefix} upper-case with suffix`);
    assert.strictEqual(estimateCost(prefix, 1e6, 1e6), p[0] + p[1], prefix);
  }
  assert.deepStrictEqual(priceFor('claude-opus-5-5'), [4, 20], 'Opus 5.5 at the 2026-10 published rate');
  assert.deepStrictEqual(priceFor('claude-sdk/claude-fable-5-1[1m]'), [10, 50]);
  assert.deepStrictEqual(priceFor('claude-sonnet-5-5'), [2, 10]);
  assert.deepStrictEqual(priceFor('claude-haiku-5-5'), [0.1, 0.5]);
  assert.deepStrictEqual(priceFor('claude-opus-4-6'), [5, 25], 'Opus 4.5-4.8 are not the old Opus 4 rate');
  assert.deepStrictEqual(priceFor('claude-opus-4-1'), [15, 75]);
  const { cacheReadFactor } = require('../lib/ledger');
  assert.strictEqual(cacheReadFactor('claude-sdk/claude-fable-5-1'), 0.025);
  assert.strictEqual(cacheReadFactor('claude-opus-5-5'), 0.05);
  assert.strictEqual(cacheReadFactor('claude-haiku-4-5'), 0.1);
  assert.strictEqual(estimateCost('claude-fable-5-1', 0, 0, { cacheRead: 1e6, cacheWrite: 1e6 }), 0.25 + 12.5);
  assert.deepStrictEqual(priceFor('gpt-5.4-mini-x'), [0.4, 1.6], 'mini wins over gpt-5');
  assert.deepStrictEqual(priceFor('gpt-5.6-sol'), [2.5, 10]);
  assert.deepStrictEqual(priceFor('gpt-5.4'), [1.25, 10], 'falls to gpt-5');
  assert.deepStrictEqual(priceFor('o3-mini'), [1.1, 4.4]);
  assert.deepStrictEqual(priceFor('o3-pro'), [20, 80]);
  assert.deepStrictEqual(priceFor('o3'), [2, 8]);
  // Prompt-cache aware: Fable 5.1 reads at 2.5% and writes at 125% of the $10 input rate; Haiku 4.5 reads at 10%.
  assert.strictEqual(estimateCost('claude-sdk/claude-fable-5-1[1m]', 1e6, 0), 10);
  assert.strictEqual(estimateCost('claude-sdk/claude-fable-5-1[1m]', 0, 0, { cacheRead: 1e6 }), 0.25);
  assert.strictEqual(estimateCost('claude-sdk/claude-fable-5-1[1m]', 0, 0, { cacheWrite: 1e6 }), 12.5);
  assert.strictEqual(estimateCost('claude-haiku-4-5', 0, 0, { cacheRead: 1e6 }), 0.1);
});

test('priceFor / estimateCost: local models are free, unknown models are null, bad token counts count as zero', () => {
  for (const m of ['lmstudio/qwen/qwen3.6-27b', 'OLLAMA/llama3', 'omlx/anything']) assert.deepStrictEqual(priceFor(m), [0, 0], m);
  for (const m of ['mystery-model', '', null, undefined, 'qwen/qwen3.6']) assert.strictEqual(priceFor(m), null, String(m));
  assert.strictEqual(estimateCost('mystery', 100, 100), null);
  assert.strictEqual(estimateCost('lmstudio/x', 1e9, 1e9), 0);
  assert.strictEqual(estimateCost('claude-sonnet-4-6', 'abc', undefined), 0);
  assert.strictEqual(estimateCost('claude-sonnet-4-6', 1000, 2000), (1000 * 3 + 2000 * 15) / 1e6);
});

test('localDay uses local calendar fields with zero padding', () => {
  assert.strictEqual(localDay(new Date(2026, 0, 5, 0, 0).getTime()), '2026-01-05');
  assert.strictEqual(localDay(new Date(2026, 11, 31, 23, 59).getTime()), '2026-12-31');
  assert.match(localDay(), /^\d{4}-\d\d-\d\d$/);
});

test('record: reported vs estimated vs unknown cost, provider derivation, rounding, defaults', () => {
  const { l } = mk();
  assert.deepStrictEqual(l.record({ agent: 'a', model: 'claude-sdk/claude-opus-5', costUsd: 0.5, inputTokens: 10.6, outputTokens: 3.4, durationMs: 99.5, tools: 2.2, origin: 'chat' }), { cost: 0.5, source: 'reported' });
  assert.deepStrictEqual(l.record({ agent: 'a', model: 'claude-sonnet-4-6', costUsd: 0 }), { cost: 0, source: 'reported' }, 'a reported 0 is kept');
  assert.deepStrictEqual(l.record({ agent: 'b', model: 'openai/gpt-5', inputTokens: 1e6, outputTokens: 0 }), { cost: 1.25, source: 'estimated' });
  assert.deepStrictEqual(l.record({ agent: 'b', model: 'lmstudio/q', inputTokens: 5e6 }), { cost: 0, source: 'estimated' });
  assert.deepStrictEqual(l.record({ agent: 'c', model: 'mystery', inputTokens: 5 }), { cost: null, source: 'none' });
  l.record({ model: '', ok: false });
  const r = rows(l);
  assert.deepStrictEqual([r[0].provider, r[0].input_tokens, r[0].output_tokens, r[0].duration_ms, r[0].tools, r[0].origin, r[0].ok], ['claude-sdk', 11, 3, 100, 2, 'chat', 1]);
  assert.deepStrictEqual([r[1].provider, r[2].provider, r[3].provider, r[4].provider], ['claude-sdk', 'openai', 'lmstudio', 'unknown']);
  assert.deepStrictEqual([r[4].cost_usd, r[4].cost_source, r[4].input_tokens], [null, 'none', 5]);
  assert.deepStrictEqual([r[5].agent, r[5].model, r[5].provider, r[5].ok, r[5].origin], ['unknown', null, 'unknown', 0, null]);
  assert.strictEqual(r[0].ts, new Date(new Date(2026, 4, 10, 12, 0)).toISOString());
});

test('today / days aggregate per local day across a day boundary (injected clock), per agent, cost-desc', () => {
  const { l, clock } = mk();
  const at = (d, h, mi) => { clock.t = new Date(2026, 4, d, h, mi).getTime(); };
  at(10, 23, 59); l.record({ agent: 'a', model: 'x', costUsd: 1, inputTokens: 100, outputTokens: 10 });
  at(11, 0, 1);   l.record({ agent: 'a', model: 'x', costUsd: 2, inputTokens: 5, outputTokens: 1 });
  l.record({ agent: 'b', model: 'x', costUsd: 5 }); l.record({ agent: 'b', model: 'unknown-m' });
  assert.strictEqual(l.today().day, '2026-05-11');
  const t = l.today();
  assert.deepStrictEqual([t.total, t.turns], [7, 3]);
  assert.deepStrictEqual(t.agents.map(a => [a.agent, a.turns, a.cost]), [['b', 2, 5], ['a', 1, 2]], 'ordered by cost, null cost counts 0');
  assert.deepStrictEqual([t.agents[1].inputTokens, t.agents[1].outputTokens, t.agents[0].inputTokens], [5, 1, 0]);
  const y = l.today('2026-05-10');
  assert.deepStrictEqual([y.total, y.turns, y.agents.length], [1, 1, 1]);
  assert.deepStrictEqual(l.today('2020-01-01'), { day: '2020-01-01', total: 0, turns: 0, agents: [] });
  assert.deepStrictEqual(l.days().map(d => [d.day, d.turns, d.cost]), [['2026-05-11', 3, 7], ['2026-05-10', 1, 1]]);
  assert.strictEqual(l.days(1).length, 1);
});

test('caps(): off by default; normalises zero, negative, NaN, text, null and numeric strings; re-read on every call', () => {
  let c = {};
  const { l } = mk({ getCaps: () => c });
  assert.deepStrictEqual(l.caps(), { perAgentDailyUsd: null, hubDailyUsd: null });
  c = { perAgentDailyUsd: 0, hubDailyUsd: -3 }; assert.deepStrictEqual(l.caps(), { perAgentDailyUsd: null, hubDailyUsd: null });
  c = { perAgentDailyUsd: 'abc', hubDailyUsd: Infinity }; assert.deepStrictEqual(l.caps(), { perAgentDailyUsd: null, hubDailyUsd: null });
  c = { perAgentDailyUsd: '2.5', hubDailyUsd: 10 }; assert.deepStrictEqual(l.caps(), { perAgentDailyUsd: 2.5, hubDailyUsd: 10 });
  c = null; assert.deepStrictEqual(l.caps(), { perAgentDailyUsd: null, hubDailyUsd: null });
});

test('overCap: caps off never caps; per-agent first, then hub; limits are inclusive; other agents\' spend only counts toward the hub', () => {
  let c = {};
  const { l, clock } = mk({ getCaps: () => c });
  l.record({ agent: 'big', model: 'x', costUsd: 3 }); l.record({ agent: 'small', model: 'x', costUsd: 1 });
  assert.deepStrictEqual(l.overCap('big'), { capped: false, reason: null, agentSpend: 3, hubSpend: 4, caps: { perAgentDailyUsd: null, hubDailyUsd: null } });
  c = { perAgentDailyUsd: 3 };
  assert.strictEqual(l.overCap('big').capped, true, '>= is inclusive');
  assert.strictEqual(l.overCap('big').reason, 'big is over its daily cap ($3.00 of $3)');
  assert.strictEqual(l.overCap('small').capped, false);
  assert.strictEqual(l.overCap('never-seen').agentSpend, 0);
  c = { hubDailyUsd: 4 };
  assert.strictEqual(l.overCap('small').reason, 'the hub is over its daily cap ($4.00 of $4)');
  assert.strictEqual(l.overCap('never-seen').capped, true, 'hub cap applies to agents with no spend');
  c = { perAgentDailyUsd: 3, hubDailyUsd: 4 };
  assert.match(l.overCap('big').reason, /^big is over/, 'agent reason wins when both apply');
  c = { perAgentDailyUsd: 3.01, hubDailyUsd: 4.01 };
  assert.strictEqual(l.overCap('big').capped, false);
  c = { hubDailyUsd: 1 }; clock.t += 86400000;
  assert.deepStrictEqual([l.overCap('big').capped, l.overCap('big').hubSpend], [false, 0], 'a new day resets the spend');
});

test('an unusable ledger file disables the ledger quietly: record returns null, reads are empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-ledger-')); dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'blocker'), 'x');
  const l = createLedger({ file: path.join(dir, 'blocker', 'sub', 'ledger.db'), now: () => 0, getCaps: () => ({ hubDailyUsd: 1 }) });
  assert.strictEqual(quiet(() => l.record({ agent: 'a', model: 'x', costUsd: 9 })), null);
  assert.deepStrictEqual(l.today('2026-01-01'), { day: '2026-01-01', total: 0, agents: [], turns: 0 });
  assert.deepStrictEqual(l.days(), []);
  assert.strictEqual(l.overCap('a').capped, false);
});

// ── approvals ──────────────────────────────────────────────────────────────
const { mock } = test;
function ap(opts = {}) {
  mock.timers.reset(); mock.timers.enable({ apis: ['setTimeout'] });
  const events = [], added = [], clock = { t: 1_700_000_000_000 };
  const a = createApprovals({ now: () => clock.t, log: () => {}, onEvent: (e) => events.push(e), allowances: { add: (k, ttl) => added.push([k, ttl]) }, ...opts });
  return { a, events, added, clock };
}
const spec = (o = {}) => ({ agent: 'a1', tool: 'Bash', input: { command: 'ls' }, cls: 'send', summary: 's', allowKey: 'a1|send|x', ...o });
test.afterEach(() => mock.timers.reset());

test('approvals: request returns id + pending promise; list/get/pendingFor expose a public view only; owner answer resolves it', async () => {
  const { a, events } = ap();
  const { id, promise } = a.request(spec({ detail: 'd', role: 'r', origin: 'chat', secret: 'hidden', input: { command: 'rm x' } }));
  assert.match(id, /^ap_[0-9a-z]+_[0-9a-f]{6}$/);
  const v = a.get(id);
  assert.deepStrictEqual(Object.keys(v).sort(), ['agent', 'allowKey', 'argsHash', 'cls', 'createdAt', 'detail', 'expiresAt', 'id', 'origin', 'role', 'summary', 'tool']);
  assert.strictEqual(v.argsHash, hashArgs('Bash', { command: 'rm x' }));
  assert.strictEqual(new Date(v.expiresAt) - new Date(v.createdAt), DEFAULT_TIMEOUT_MS);
  assert.strictEqual(a.list().length, 1); assert.strictEqual(a.pendingFor('a1').length, 1); assert.strictEqual(a.pendingFor('zz').length, 0);
  assert.deepStrictEqual(a.resolve(id, 'allow'), { ok: true, decision: 'allow', by: 'owner', remember: null });
  assert.deepStrictEqual(await promise, { decision: 'allow', by: 'owner', remember: null });
  assert.deepStrictEqual([a.list().length, a.get(id)], [0, null]);
  assert.deepStrictEqual(events.map(e => e.type), ['approval_request', 'approval_resolved']);
  assert.ok(!('secret' in events[0]) && events[1].decision === 'allow');
  assert.match(a.resolve(id, 'allow').error, /no such pending approval/, 'second answer is refused');
  assert.match(a.resolve('ap_nope', 'deny').error, /no such pending/);
  assert.strictEqual(a.resolve(id, 'maybe').error, 'decision must be allow or deny');
});

test('approvals: timeout can be a function re-read per request; invalid values fall back to the default; expiry denies by timeout', async () => {
  let ms = 1000;
  const { a } = ap({ timeoutMs: () => ms });
  const r1 = a.request(spec());
  ms = 5000; const r2 = a.request(spec());
  assert.strictEqual(a.timeoutMs, 5000);
  mock.timers.tick(999); assert.strictEqual(a.list().length, 2);
  mock.timers.tick(1);
  assert.deepStrictEqual(await r1.promise, { decision: 'deny', by: 'timeout', remember: null });
  assert.strictEqual(a.list().length, 1, 'second request still waiting on its own 5s');
  mock.timers.tick(4000);
  assert.strictEqual((await r2.promise).by, 'timeout');
  for (const bad of [0, -5, NaN, 'abc', null, undefined, () => undefined, () => 0]) assert.strictEqual(ap({ timeoutMs: bad }).a.timeoutMs, DEFAULT_TIMEOUT_MS, String(bad));
  assert.strictEqual(ap({ timeoutMs: '2500' }).a.timeoutMs, 2500);
});

test('approvals: "remember" adds an allowance only for allow + allowKey + known window (1h / session = 12h)', () => {
  const { a, added } = ap();
  const go = (decision, remember, o = {}) => a.resolve(a.request(spec(o)).id, decision, { remember });
  go('allow', '1h'); go('allow', 'session'); go('allow', 'forever'); go('allow', null);
  go('deny', '1h'); go('allow', '1h', { allowKey: undefined });
  assert.deepStrictEqual(added, [['a1|send|x', 3600000], ['a1|send|x', 12 * 3600000]]);
  const none = createApprovals({ log: () => {} });                       // no allowances store: remember is harmless
  const r = none.request(spec()); assert.strictEqual(none.resolve(r.id, 'allow', { remember: '1h' }).ok, true);
});

test('approvals: cancelFor denies only that agent\'s pending requests, as "cancelled", and returns the count', async () => {
  const { a } = ap();
  const x1 = a.request(spec()), x2 = a.request(spec()), y = a.request(spec({ agent: 'other' }));
  assert.strictEqual(a.cancelFor('a1'), 2);
  assert.deepStrictEqual(await x1.promise, { decision: 'deny', by: 'cancelled', remember: null });
  assert.strictEqual((await x2.promise).by, 'cancelled');
  assert.deepStrictEqual(a.list().map(r => r.agent), ['other']);
  assert.strictEqual(a.cancelFor('a1'), 0);
  a.resolve(y.id, 'deny');
});

test('approvals: history keeps the 50 newest (newest first) and recent() is a copy; a throwing onEvent never breaks the flow', () => {
  const { a } = ap({ onEvent: () => { throw new Error('ui gone'); } });
  const ids = [];
  for (let i = 0; i < 55; i++) { const r = a.request(spec({ summary: `req${i}` })); ids.push(r.id); assert.strictEqual(a.resolve(r.id, i % 2 ? 'deny' : 'allow').ok, true); }
  const h = a.recent();
  assert.strictEqual(h.length, 50);
  assert.deepStrictEqual([h[0].id, h[49].id, h[0].summary, h[0].decision, h[0].by], [ids[54], ids[5], 'req54', 'allow', 'owner']);
  assert.ok(h[0].resolvedAt);
  h.length = 0; assert.strictEqual(a.recent().length, 50, 'mutating the returned array does not touch history');
});

test('hashArgs: 16 hex chars, stable across top-level key order, differs by tool and by value', () => {
  assert.match(hashArgs('Bash', { a: 1 }), /^[0-9a-f]{16}$/);
  assert.strictEqual(hashArgs('T', { a: 1, b: 2 }), hashArgs('T', { b: 2, a: 1 }));
  assert.notStrictEqual(hashArgs('T', { a: 1 }), hashArgs('U', { a: 1 }));
  assert.notStrictEqual(hashArgs('T', { a: 1 }), hashArgs('T', { a: 2 }));
  assert.strictEqual(hashArgs('T', null), hashArgs('T', null));
  assert.notStrictEqual(hashArgs('T', undefined), hashArgs('T', { a: 1 }));
});

test('hashArgs: documents nested-argument and circular-input collisions', () => {
  // Nested arguments count: {opts:{force:false}} and {opts:{force:true}} are different calls.
  assert.notStrictEqual(hashArgs('Edit', { file: 'a', opts: { force: false } }), hashArgs('Edit', { file: 'a', opts: { force: true } }));
  assert.notStrictEqual(hashArgs('Edit', { file: 'a', opts: { force: false } }), hashArgs('Edit', { file: 'b', opts: { force: false } }));
  // Key order never matters, at any depth.
  assert.strictEqual(hashArgs('T', { a: { y: 1, x: [1, { q: 2, p: 3 }] }, b: 2 }), hashArgs('T', { b: 2, a: { x: [1, { p: 3, q: 2 }], y: 1 } }));
  // Circular inputs never collide with each other.
  const c1 = { x: 1 }; c1.self = c1; const c2 = { x: 2 }; c2.self = c2;
  assert.notStrictEqual(hashArgs('T', c1), hashArgs('T', c2));
});
