'use strict';
// Provider pacing wired into the hub: consult_agent and spawn_workers run under it, every agent path
// reports typed turn_error events, the status API / status_snapshot / push carry its state.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createPacing } = require('../lib/provider-pacing');
const temporalWorkers = require('../lib/temporal-workers');
const { createHubEvents } = require('../lib/hub-events');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const sdk = read('lib/sdk-chat.js');

test('consult_agent runs under the shared pacing keyed by the consulted agent\'s provider (not Tiger Team, not temporal workers)', () => {
  const i = sdk.indexOf('async function consultViaHub(');
  const body = sdk.slice(i, sdk.indexOf('\n}', i));
  assert.ok(body.includes("if (opts.tigerTeam || opts.temporal) return consultViaHubNow("));
  assert.ok(body.includes('temporalWorkers.providerOf(await getAgentModel(agentName))'));
  assert.ok(body.includes('pacing.run(provider, () => consultViaHubNow('));
  // both tool handlers hand the typed failure text to the coordinator
  assert.strictEqual((sdk.match(/pacing\.failureText\(e, agent\)/g) || []).length, 2);
});

test('the consulted turn\'s typed turn_error becomes a typed rejection the pacing layer can classify', () => {
  assert.ok(sdk.includes("if (gw && gw.type === 'turn_error') turnError = gw;"));
  assert.ok(sdk.includes("err.pacing = { kind: turnError.kind || 'error', retryAfterMs: turnError.retryAfterMs || null };"));
});

test('every agent path emits turn_error: SDK result is_error, SDK crash, gateway failure, Codex stop and Codex crash', () => {
  const sites = sdk.match(/type: 'turn_error'/g) || [];
  assert.strictEqual(sites.length, 5, `expected 5 turn_error emitters, found ${sites.length}`);
  assert.ok(sdk.includes("if (msg.is_error || (msg.subtype && msg.subtype !== 'success')) {"), 'SDK result error flag is honoured');
});

test('spawn_workers and stand-ins run through the pacing limiter', () => {
  assert.strictEqual((sdk.match(/limiter: pacingLimiter/g) || []).length, 2);
  assert.ok(read('lib/temporal-workers.js').includes("require('./provider-pacing').getPacing()"), 'default limiter is the shared pacing');
});

test('runWorkers: a transient worker failure is retried under pacing and the final text is typed', async () => {
  const slept = [];
  const pacing = createPacing({ caps: { fake: 2 }, sleep: async (ms) => { slept.push(ms); }, retryDelaysMs: [1, 2], cooldownMs: 1000, log: () => {} });
  let calls = 0;
  const results = await temporalWorkers.runWorkers(
    [{ index: 1, task: 't', model: 'fake/model', provider: 'fake', toolScope: 'read', label: 'w1' }],
    { parent: 'coord', limiter: pacing, runOne: async () => { calls++; if (calls < 3) throw new Error('API Error: 429 rate limit'); return 'answer'; } },
  );
  assert.strictEqual(calls, 3);
  assert.deepStrictEqual(slept, [1, 2]);
  assert.strictEqual(results[0].ok, true);
  assert.strictEqual(results[0].text, 'answer');
  assert.strictEqual(pacing.status().providers.fake.limit, 1, 'provider went serial');

  calls = 0;
  const failed = await temporalWorkers.runWorkers(
    [{ index: 2, task: 't', model: 'fake/model', provider: 'fake', toolScope: 'read', label: 'w2' }],
    { parent: 'coord', limiter: pacing, runOne: async () => { calls++; throw new Error('529 overloaded'); } },
  );
  assert.strictEqual(calls, 3);
  assert.strictEqual(failed[0].ok, false);
  assert.match(failed[0].text, /^\[TRANSIENT FAILURE\] overloaded after 3 attempt/);
  assert.match(temporalWorkers.formatResults(failed), /0 succeeded, 1 failed/);

  const crashed = await temporalWorkers.runWorkers(
    [{ index: 3, task: 't', model: 'fake/model', provider: 'fake', toolScope: 'read', label: 'w3' }],
    { parent: 'coord', limiter: pacing, runOne: async () => { throw new Error('process stopped unexpectedly'); } },
  );
  assert.match(crashed[0].text, /^\[FAILED\] crash/);
});

test('status_snapshot carries the paced providers; the status route and reset/fault routes exist', () => {
  const ev = createHubEvents();
  ev.setPacingProvider(() => ({ providers: { x: {} }, paced: [{ provider: 'x', limit: 1, cap: 4, reason: 'rate_limit' }] }));
  assert.deepStrictEqual(ev.pacingState().paced[0].provider, 'x');
  const writes = [];
  const res = { writeHead() {}, write: (s) => writes.push(s), on() {}, destroy() {} };
  ev.subscribe({ headers: {} }, res);
  const snap = writes.find(w => w.startsWith('event: status_snapshot'));
  const data = JSON.parse(snap.split('\n')[1].slice(6));
  assert.deepStrictEqual(data.pacing, { paced: [{ provider: 'x', limit: 1, cap: 4, reason: 'rate_limit' }] });

  const server = read('server.js');
  assert.ok(server.includes("pacing: getPacing().status()"), '/api/hub/status includes pacing');
  assert.ok(server.includes("pathname === '/api/hub/pacing/reset' && req.method === 'POST'"));
  assert.ok(server.includes("pathname === '/api/hub/pacing/fault' && req.method === 'POST'"));
  assert.ok(sdk.includes('hubEvents.events.setPacingProvider(() => pacing.status())'));
});

test('pacing events are published on /api/events and a paced provider sends a push notice', () => {
  assert.ok(sdk.includes("getPacing({ onEvent: (ev) => { try { hubEvents.events.publish(ev.type, ev); } catch {} } })"));
  const push = read('lib/push.js');
  assert.ok(push.includes("ev.type === 'provider_paced'"));
  assert.ok(push.includes("tag: `pacing-${ev.provider}`"));
});

test('the gateway does not retry a refused connection; the gateway turn_error carries the cause chain', () => {
  const gw = read('lib/gateway-client.js');
  assert.ok(gw.includes("const refused = /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/.test(describeNetworkError(fetchErr));"));
  assert.ok(gw.includes('if (!refused && !opts.noRetries && isRetryableError(fetchErr)'));
  assert.ok(sdk.includes("message: providerPacing.describeError(e).slice(0, 300) || 'error'"));
});
