'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPush } = require('../lib/push');
const hubEvents = require('../lib/hub-events');

const SUB = (n = 1) => ({ endpoint: `https://push.example.test/send/${n}`, keys: { p256dh: 'BPkey' + n, auth: 'auth' + n } });
const mode = (f) => (fs.statSync(f).mode & 0o777).toString(8);

function mk(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-'));
  const clock = { t: 1_000_000 };
  const sent = [];
  const fail = o.fail || (() => null);
  const push = createPush({
    dir, now: () => clock.t, minGapMs: 20000,
    displayName: (a) => ({ trader: 'Trader', maestro: 'Maestro' }[a] || a),
    webpush: { generateVAPIDKeys: () => ({ publicKey: 'PUBKEY', privateKey: 'PRIVKEY' }) },
    sender: async (sub, body, opts) => {
      sent.push({ sub, body: JSON.parse(body), opts });
      const e = fail(sub); if (e) { const err = new Error('push failed'); err.statusCode = e; throw err; }
    },
  });
  return { push, dir, clock, sent };
}
const end = (agent, extra = {}) => ({ type: 'turn_end', turnId: `${agent}-${Math.random()}`, agent, ok: true, origin: { kind: 'user' }, reply: 'SECRET REPLY TEXT', ...extra });
const flush = () => new Promise(r => setImmediate(r));

test('VAPID keys are generated on first use, persisted at mode 0600, and reused', () => {
  const { push, dir } = mk();
  assert.strictEqual(push.publicKey(), 'PUBKEY');
  const f = path.join(dir, 'vapid.json');
  assert.strictEqual(mode(f), '600');
  assert.strictEqual(JSON.parse(fs.readFileSync(f, 'utf8')).privateKey, 'PRIVKEY');
  const again = createPush({ dir, webpush: { generateVAPIDKeys: () => { throw new Error('must not regenerate'); } } });
  assert.strictEqual(again.publicKey(), 'PUBKEY');
});

test('the real web-push library generates a usable VAPID pair', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-real-'));
  const key = createPush({ dir }).publicKey();
  assert.match(key, /^[A-Za-z0-9_-]{80,}$/);
});

test('subscribe stores {id, endpoint, keys, agents, createdAt, lastSeen, failures} at 0600 and dedupes by endpoint', () => {
  const { push, dir } = mk();
  const r1 = push.subscribe(SUB(1), ['trader']);
  assert.strictEqual(r1.ok, true);
  const file = path.join(dir, 'subscriptions.json');
  assert.strictEqual(mode(file), '600');
  const [rec] = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(Object.keys(rec).sort(), ['agents', 'createdAt', 'endpoint', 'failures', 'id', 'keys', 'lastSeen']);
  assert.deepStrictEqual(rec.agents, ['trader']);
  assert.strictEqual(rec.failures, 0);

  const r2 = push.subscribe(SUB(1), null);
  assert.strictEqual(r2.id, r1.id, 'same endpoint, same id');
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).length, 1);
  assert.strictEqual(push.subscriptions()[0].agents, null);

  push.subscribe(SUB(2));
  assert.strictEqual(push.subscriptions().length, 2);
  assert.deepStrictEqual(push.unsubscribe(SUB(1).endpoint), { ok: true });
  assert.strictEqual(push.subscriptions().length, 1);
  assert.deepStrictEqual(push.unsubscribe('https://nope.example.test/'), { ok: true });
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).length, 1);
});

test('subscribe rejects malformed subscriptions', () => {
  const { push } = mk();
  assert.strictEqual(push.subscribe(null).ok, false);
  assert.strictEqual(push.subscribe({ endpoint: 'http://insecure.example.test', keys: SUB().keys }).ok, false);
  assert.strictEqual(push.subscribe({ endpoint: SUB().endpoint }).ok, false);
  assert.strictEqual(push.subscriptions().length, 0);
});

test('a turn_end push carries a title, a deep link and NO message content', async () => {
  const { push, sent } = mk();
  push.subscribe(SUB(1));
  push.onEvent(end('trader', { reply: 'The wallet holds 12,345 USDC' }));
  await flush();
  assert.strictEqual(sent.length, 1);
  const p = sent[0].body;
  assert.deepStrictEqual(Object.keys(p).sort(), ['body', 'tag', 'title', 'ts', 'url']);
  assert.strictEqual(p.title, 'Trader replied');
  assert.strictEqual(p.body, 'Tap to open');
  assert.strictEqual(p.url, '/mobile#chat=trader');
  assert.strictEqual(p.tag, 'agent-trader');
  assert.ok(!JSON.stringify(sent[0]).includes('12,345'));
  assert.ok(!JSON.stringify(sent[0]).includes('SECRET'));
  assert.strictEqual(sent[0].opts.TTL, 300);
  assert.strictEqual(sent[0].opts.urgency, 'normal');
  assert.strictEqual(sent[0].opts.vapidDetails.publicKey, 'PUBKEY');
});

test('ask_user pushes "<Agent> has a question" with high urgency and never the question text', async () => {
  const { push, sent } = mk();
  push.subscribe(SUB(1));
  push.onEvent({ type: 'ask_user', agent: 'maestro', request_id: 'r1', question: 'Is the SSN 123-45-6789?', options: ['Yes', 'No'] });
  await flush();
  assert.strictEqual(sent[0].body.title, 'Maestro has a question');
  assert.strictEqual(sent[0].opts.urgency, 'high');
  assert.ok(!JSON.stringify(sent[0]).includes('123-45'));
});

test('scheduled turns say "Scheduled task ran: <agent>"; stopped turns and repeats of a turn do not push', async () => {
  const { push, sent, clock } = mk();
  push.subscribe(SUB(1));
  push.onEvent(end('trader', { origin: { kind: 'schedule', from: 'Nightly', label: 'Nightly' } }));
  await flush();
  assert.strictEqual(sent[0].body.title, 'Scheduled task ran: trader');
  assert.ok(!JSON.stringify(sent[0].body).includes('Nightly'));

  clock.t += 60000;
  const e = end('maestro');
  push.onEvent(e); push.onEvent(e);
  await flush();
  assert.strictEqual(sent.length, 2, 'the same turn_end pushes once');
  clock.t += 60000;
  push.onEvent(end('maestro', { ok: false, error: 'stopped' }));
  push.onEvent({ type: 'turn_delta', agent: 'maestro', text: 'x' });
  push.onEvent({ type: 'turn_start', agent: 'maestro' });
  await flush();
  assert.strictEqual(sent.length, 2);
});

test('only subscriptions that follow the agent are notified', async () => {
  const { push, sent } = mk();
  push.subscribe(SUB(1), ['trader']);
  push.subscribe(SUB(2), ['maestro']);
  push.subscribe(SUB(3), null);
  push.onEvent(end('trader'));
  await flush();
  assert.deepStrictEqual(sent.map(s => s.sub.endpoint).sort(), [SUB(1).endpoint, SUB(3).endpoint]);
});

test('rate limit: one push per agent per 20 s; the rest coalesce into a single trailing push', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { push, sent, clock } = mk();
  push.subscribe(SUB(1));
  for (let i = 0; i < 4; i++) push.onEvent(end('trader'));
  await flush();
  assert.strictEqual(sent.length, 1, 'first goes out at once');
  push.onEvent(end('maestro'));                    // another agent has its own window
  await flush();
  assert.strictEqual(sent.length, 2);

  clock.t += 19000; t.mock.timers.tick(19000); await flush();
  assert.strictEqual(sent.length, 2, 'still inside the window');
  clock.t += 1000; t.mock.timers.tick(1000); await flush();
  assert.strictEqual(sent.length, 3, 'three coalesced events become one trailing push');
  assert.strictEqual(sent[2].body.title, 'Trader replied');

  clock.t += 25000; t.mock.timers.tick(25000); await flush();
  assert.strictEqual(sent.length, 3, 'nothing left pending');
  push.onEvent(end('trader')); await flush();
  assert.strictEqual(sent.length, 4, 'after a quiet window the next one goes out at once');
});

test('coalesced pushes: a pending question outranks a pending reply', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { push, sent, clock } = mk();
  push.subscribe(SUB(1));
  push.onEvent(end('trader'));
  push.onEvent({ type: 'ask_user', agent: 'trader', request_id: 'r', question: 'q', options: [] });
  push.onEvent(end('trader'));
  await flush();
  assert.strictEqual(sent.length, 1);
  clock.t += 20000; t.mock.timers.tick(20000); await flush();
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(sent[1].body.title, 'Trader has a question');
  assert.strictEqual(sent[1].opts.urgency, 'high');
});

test('a subscription is removed after 3 consecutive 404/410 answers; other errors and successes reset or are ignored', async () => {
  const { push, dir, clock } = mk({ fail: (s) => s.endpoint === SUB(1).endpoint ? 410 : (s.endpoint === SUB(2).endpoint ? 500 : null) });
  push.subscribe(SUB(1)); push.subscribe(SUB(2)); push.subscribe(SUB(3));
  for (let i = 0; i < 2; i++) { push.onEvent(end('trader')); await flush(); clock.t += 21000; }
  assert.strictEqual(push.subscriptions().length, 3);
  assert.strictEqual(push.subscriptions().find(s => s.endpoint === SUB(1).endpoint).failures, 2);
  assert.strictEqual(push.subscriptions().find(s => s.endpoint === SUB(2).endpoint).failures, 0, '500s are not counted');
  push.onEvent(end('trader')); await flush();
  assert.deepStrictEqual(push.subscriptions().map(s => s.endpoint).sort(), [SUB(2).endpoint, SUB(3).endpoint]);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'subscriptions.json'), 'utf8')).length, 2, 'removal is persisted');
});

test('a success resets the failure count', async () => {
  let code = 410;
  const { push, clock } = mk({ fail: () => code });
  push.subscribe(SUB(1));
  for (let i = 0; i < 2; i++) { push.onEvent(end('trader')); await flush(); clock.t += 21000; }
  assert.strictEqual(push.subscriptions()[0].failures, 2);
  code = null;
  push.onEvent(end('trader')); await flush(); clock.t += 21000;
  assert.strictEqual(push.subscriptions()[0].failures, 0);
  code = 404;
  for (let i = 0; i < 2; i++) { push.onEvent(end('trader')); await flush(); clock.t += 21000; }
  assert.strictEqual(push.subscriptions().length, 1, 'only 2 in a row after the reset');
});

test('test() sends to every subscription regardless of the follow list and the rate limit', async () => {
  const { push, sent } = mk();
  push.subscribe(SUB(1), ['trader']); push.subscribe(SUB(2), []);
  const r1 = await push.test(); const r2 = await push.test();
  assert.strictEqual(r1.sent, 2); assert.strictEqual(r2.sent, 2);
  assert.strictEqual(sent.length, 4);
  assert.strictEqual(sent[0].body.title, 'My Maestro AI test');
});

test('start() hooks hub-events: a published turn_end reaches the sender', async () => {
  const { push, sent } = mk();
  push.subscribe(SUB(1));
  const ev = hubEvents.createHubEvents();
  const stop = push.start(ev);
  ev.publish('turn_end', { turnId: 't1', agent: 'trader', origin: { kind: 'user' }, ok: true, error: null, reply: 'hi' });
  await flush();
  assert.strictEqual(sent.length, 1);
  stop();
  ev.publish('turn_end', { turnId: 't2', agent: 'maestro', origin: { kind: 'user' }, ok: true, error: null, reply: 'hi' });
  await flush();
  assert.strictEqual(sent.length, 1);
});

test('has()/count(): the phone can ask whether the hub still knows its subscription; subscribe, unsubscribe, failures and tests are logged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-'));
  const logs = [];
  const push = createPush({ dir, now: () => 1_000_000, log: (...a) => logs.push(a.join(' ')),
    webpush: { generateVAPIDKeys: () => ({ publicKey: 'PUBKEY', privateKey: 'PRIVKEY' }) },
    sender: async () => { const err = new Error('gone'); err.statusCode = 410; throw err; } });
  assert.equal(push.count(), 0);
  assert.equal(push.has(SUB(1).endpoint), false);
  push.subscribe(SUB(1));
  assert.equal(push.has(SUB(1).endpoint), true);
  assert.equal(push.count(), 1);
  assert.match(logs[0], /new subscription \(push\.example\.test\); 1 on file/);
  push.subscribe(SUB(1));
  assert.match(logs[1], /subscription renewed/);
  const r = await push.test();
  assert.deepEqual([r.sent, r.failed], [0, 1]);
  assert.ok(logs.some(l => /delivery failed \(push\.example\.test\): 410/.test(l)), 'delivery failure logged with the status');
  assert.ok(logs.some(l => /test push: sent 0, failed 1/.test(l)));
  push.unsubscribe(SUB(1).endpoint);
  assert.equal(push.has(SUB(1).endpoint), false);
  assert.match(logs[logs.length - 1], /subscription removed/);
});

test('a test push is marked force (the phone shows it even with the app in front); reply pushes log sent/failed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-'));
  const logs = []; const sent = [];
  const push = createPush({ dir, now: () => 1_000_000, log: (...a) => logs.push(a.join(' ')),
    webpush: { generateVAPIDKeys: () => ({ publicKey: 'PUBKEY', privateKey: 'PRIVKEY' }) },
    sender: async (sub, body) => { sent.push(JSON.parse(body)); } });
  push.subscribe(SUB(1));
  await push.test();
  assert.equal(sent[0].force, true);
  push.onEvent({ type: 'turn_end', turnId: 't1', agent: 'trader', ok: true, origin: { kind: 'user' } });
  await new Promise(r => setImmediate(r));
  assert.equal(sent[1].force, undefined, 'reply pushes are not forced');
  assert.ok(logs.some(l => /reply push for trader: sent 1, failed 0/.test(l)), logs.join('|'));
});

test('notify: hub notices (plan warnings) go to every device, or only to admins\' and to devices registered before accounts were recorded', async () => {
  const { push, sent } = mk();
  push.subscribe(SUB(1), null, { id: 'u_admin', role: 'admin' });
  push.subscribe(SUB(2), null, { id: 'u_member', role: 'member' });
  push.subscribe(SUB(3), null);
  assert.deepStrictEqual(push.subscriptions().map(s => s.user ? s.user.role : null), ['admin', 'member', null]);
  const r = await push.notify({ title: 'Claude plan: Fable at 90% of this week', body: 'Resets Wed 8:00 PM.', url: '/mobile', tag: 'plan-model:fable' }, { urgency: 'high', adminsOnly: true });
  assert.deepStrictEqual([r.sent, r.failed], [2, 0]);
  assert.deepStrictEqual(sent.map(x => x.sub.endpoint).sort(), [SUB(1).endpoint, SUB(3).endpoint]);
  assert.strictEqual(sent[0].body.title, 'Claude plan: Fable at 90% of this week'); assert.ok(sent[0].body.ts, 'stamped');
  const all = await push.notify({ title: 'x' });
  assert.strictEqual(all.sent, 3);
});
