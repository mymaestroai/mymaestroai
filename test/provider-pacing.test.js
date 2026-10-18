'use strict';
// Provider pacing: classification, per-provider caps, trip to serial on transient failure, retry
// with backoff, cooldown then ramp-up on successes, typed final failures, status, fault hook.
const { test } = require('node:test');
const assert = require('node:assert');
const { createPacing, classify, describeError, parseRetryAfter, PacingError } = require('../lib/provider-pacing');

function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}
function make(opts = {}) {
  const c = clock();
  const slept = [];
  const events = [];
  const p = createPacing({
    caps: { fake: 4, default: 2 }, now: c.now, sleep: async (ms) => { slept.push(ms); c.advance(ms); },
    cooldownMs: 1000, retryDelaysMs: [10, 20], rampSuccesses: 2, onEvent: (e) => events.push(e), log: () => {}, ...opts,
  });
  return { p, c, slept, events };
}
const tick = () => new Promise(r => setImmediate(r));

test('classify recognises rate limits, overload, timeouts and crashes; long prose is not an error', () => {
  assert.strictEqual(classify(new Error('API Error: 429 Too Many Requests')).kind, 'rate_limit');
  assert.strictEqual(classify("You've hit your limit · resets 3pm").kind, 'rate_limit');
  assert.strictEqual(classify(new Error('529 overloaded_error')).kind, 'overloaded');
  // real strings from this hub: the gateway's post-retry error and LM Studio's load-time 500
  assert.strictEqual(classify(new Error('Provider 500: {"error":"Model is loading"}')).kind, 'overloaded');
  assert.strictEqual(classify(new Error('Provider 429: {"error":{"message":"Rate limit reached"}}')).kind, 'rate_limit');
  assert.strictEqual(classify(new Error('Provider 400: bad request')).kind, 'error');
  assert.strictEqual(classify(new Error('read ECONNRESET')).kind, 'timeout');
  assert.strictEqual(classify('⚠️ The agent\'s process stopped unexpectedly (exit 1)').kind, 'crash');
  assert.strictEqual(classify(new Error('something else')).kind, 'error');
  assert.strictEqual(classify('a fine answer').kind, 'ok');
  assert.strictEqual(classify('rate limits are a topic I can discuss at length. '.repeat(30)).kind, 'ok', 'long prose mentioning rate limits is not a failure');
  assert.strictEqual(classify({ kind: 'overloaded', message: 'x' }).transient, true);
  assert.strictEqual(classify({ kind: 'crash', message: 'x' }).transient, false);
  assert.strictEqual(parseRetryAfter('429 retry-after: 45'), 45000);
  assert.strictEqual(parseRetryAfter('limit resets in 3 minutes'), 180000);
  assert.strictEqual(parseRetryAfter('nothing'), null);
});

test('caps concurrency per provider and queues the rest', async () => {
  const { p } = make();
  let active = 0, peak = 0;
  const release = [];
  const work = () => p.run('fake', () => new Promise(r => { active++; peak = Math.max(peak, active); release.push(() => { active--; r('ok'); }); }));
  const runs = [work(), work(), work(), work(), work(), work()];
  await tick();
  assert.strictEqual(peak, 4);
  assert.strictEqual(p.status().providers.fake.queued, 2);
  release.splice(0).forEach(f => f());
  await tick();
  assert.strictEqual(peak, 4);
  release.splice(0).forEach(f => f());
  await Promise.all(runs);
  assert.strictEqual(p.status().providers.fake.active, 0);
});

test('a transient failure trips the provider to serial, retries with backoff, and succeeds', async () => {
  const { p, slept, events } = make();
  let calls = 0;
  const r = await p.run('fake', async () => { calls++; if (calls === 1) throw new Error('429 rate limit'); return 'fine'; }, { label: 'haiku' });
  assert.strictEqual(r, 'fine');
  assert.strictEqual(calls, 2);
  assert.deepStrictEqual(slept, [10]);
  const st = p.status().providers.fake;
  assert.strictEqual(st.limit, 1);
  assert.strictEqual(st.mode, 'paced');
  assert.strictEqual(st.reason, 'rate_limit');
  assert.strictEqual(st.failures10m, 1);
  assert.ok(events.some(e => e.type === 'provider_paced' && e.provider === 'fake' && e.label === 'haiku'));
  assert.ok(events.some(e => e.type === 'provider_retry'));
});

test('retry-after longer than the backoff wins', async () => {
  const { p, slept } = make();
  let calls = 0;
  await p.run('fake', async () => { calls++; if (calls === 1) throw new Error('429 retry-after: 5'); return 'ok'; });
  assert.deepStrictEqual(slept, [5000]);
});

test('after the retries a transient failure is thrown typed, and the text tells the coordinator what happened', async () => {
  const { p, slept } = make();
  let calls = 0;
  await assert.rejects(
    p.run('fake', async () => { calls++; throw new Error('529 overloaded'); }, { label: 'worker' }),
    (e) => e instanceof PacingError && e.pacing.kind === 'overloaded' && e.pacing.transient && e.pacing.attempts === 3 && e.pacing.final,
  );
  assert.strictEqual(calls, 3);
  assert.deepStrictEqual(slept, [10, 20]);
  const txt = p.failureText(new PacingError('529 overloaded', { kind: 'overloaded', transient: true, attempts: 3, provider: 'fake', message: '529 overloaded' }), 'worker');
  assert.match(txt, /^\[TRANSIENT FAILURE\] "worker"/);
  assert.match(txt, /one-at-a-time/);
});

test('non-transient failures are not retried and are labelled as such', async () => {
  const { p, slept } = make();
  let calls = 0;
  await assert.rejects(p.run('fake', async () => { calls++; throw new Error('process stopped unexpectedly'); }), (e) => e.pacing.kind === 'crash' && !e.pacing.transient);
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(slept, []);
  assert.strictEqual(p.status().providers.fake.limit, 4, 'a crash does not serialize the provider');
  assert.match(p.failureText(new PacingError('x', { kind: 'crash', transient: false, provider: 'fake', message: 'x' }), 'a'), /^\[FAILED\]/);
});

test('a resolved result can be classified as a failure by the caller', async () => {
  const { p } = make();
  let calls = 0;
  const r = await p.run('fake', async () => { calls++; return calls === 1 ? 'API Error: 429 rate limit' : 'real answer'; }, { classifyResult: (t) => t });
  assert.strictEqual(r, 'real answer');
  assert.strictEqual(calls, 2);
});

test('stays serial through the cooldown, then ramps 1 -> 2 -> 4 on consecutive successes', async () => {
  const { p, c, events } = make();
  await assert.rejects(p.run('fake', async () => { throw new Error('429'); }, { retry: false }));
  assert.strictEqual(p.status().providers.fake.limit, 1);
  for (let i = 0; i < 5; i++) await p.run('fake', async () => 'ok');
  assert.strictEqual(p.status().providers.fake.limit, 1, 'successes during the cooldown do not ramp');
  c.advance(1001);
  await p.run('fake', async () => 'ok');
  assert.strictEqual(p.status().providers.fake.limit, 1);
  await p.run('fake', async () => 'ok');
  assert.strictEqual(p.status().providers.fake.limit, 2);
  assert.strictEqual(p.status().providers.fake.mode, 'ramping');
  await p.run('fake', async () => 'ok'); await p.run('fake', async () => 'ok');
  assert.strictEqual(p.status().providers.fake.limit, 4);
  assert.strictEqual(p.status().providers.fake.mode, 'normal');
  assert.ok(events.some(e => e.type === 'provider_ramp' && e.limit === 2));
  assert.ok(events.some(e => e.type === 'provider_recovered'));
  assert.strictEqual(p.status().paced.length, 0);
});

test('a new transient failure while ramping trips it back to serial', async () => {
  const { p, c } = make();
  await assert.rejects(p.run('fake', async () => { throw new Error('429'); }, { retry: false }));
  c.advance(1001);
  await p.run('fake', async () => 'ok'); await p.run('fake', async () => 'ok');
  assert.strictEqual(p.status().providers.fake.limit, 2);
  await assert.rejects(p.run('fake', async () => { throw new Error('overloaded'); }, { retry: false }));
  assert.strictEqual(p.status().providers.fake.limit, 1);
  assert.strictEqual(p.status().providers.fake.failures10m, 2);
});

test('fault() makes the next N runs fail synthetically; reset() restores full parallel', async () => {
  const { p } = make();
  assert.deepStrictEqual(p.fault('fake', 1), { provider: 'fake', pending: 1 });
  let calls = 0;
  const r = await p.run('fake', async () => { calls++; return 'ok'; });
  assert.strictEqual(r, 'ok');
  assert.strictEqual(calls, 1, 'the synthetic failure consumed the first attempt without running the work');
  assert.strictEqual(p.status().providers.fake.limit, 1);
  assert.strictEqual(p.status().paced[0].provider, 'fake');
  p.reset('fake');
  assert.strictEqual(p.status().providers.fake.limit, 4);
  assert.strictEqual(p.status().providers.fake.mode, 'normal');
});

test('a refused connection is "down": paced at once, never retried in-call, typed as PROVIDER DOWN', async () => {
  const { p, slept, events } = make();
  let calls = 0;
  const refused = new TypeError('fetch failed');
  refused.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4000'), { code: 'ECONNREFUSED' });
  assert.strictEqual(classify(refused).kind, 'down', 'cause chain is inspected');
  assert.match(describeError(refused), /fetch failed <- .*ECONNREFUSED/);
  await assert.rejects(p.run('fake', async () => { calls++; throw refused; }, { label: 'qwen' }), (e) => e.pacing.kind === 'down' && e.pacing.transient && e.pacing.final);
  assert.strictEqual(calls, 1, 'no retry');
  assert.deepStrictEqual(slept, [], 'no backoff wait');
  assert.strictEqual(p.status().providers.fake.limit, 1, 'provider paced');
  assert.strictEqual(p.status().providers.fake.reason, 'down');
  assert.ok(events.some(e => e.type === 'provider_paced' && e.reason === 'down'));
  const txt = p.failureText(new PacingError('x', { kind: 'down', transient: true, provider: 'lmstudio', message: 'ECONNREFUSED', attempts: 1 }), 'qwen36');
  assert.match(txt, /^\[PROVIDER DOWN\] "qwen36"/);
  assert.match(txt, /Nothing was retried/);
});

test('unknown providers get the default cap', () => {
  const { p } = make();
  assert.strictEqual(p.capFor('mystery'), 2);
});
