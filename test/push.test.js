'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPush, questionDelayFrom, cleanNotifySettings, QUESTION_DELAY_MS } = require('../lib/push');
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
    ...(o.questionDelayMs !== undefined ? { questionDelayMs: o.questionDelayMs } : {}),
    ...(o.ownerOf ? { ownerOf: o.ownerOf } : {}),
    displayName: (a) => ({ trader: 'Trader', maestro: 'Maestro' }[a] || a),
    webpush: { generateVAPIDKeys: () => ({ publicKey: 'PUBKEY', privateKey: 'PRIVKEY' }) },
    sender: async (sub, body, opts) => {
      sent.push({ sub, body: JSON.parse(body), opts });
      const e = fail(sub); if (e) { const err = new Error('push failed'); err.statusCode = e; throw err; }
    },
  });
  return { push, dir, clock, sent };
}
// A finished turn someone tapped "Notify me when done" on (an admin); pass notify: [] for a turn nobody asked about.
const ADMIN_BELL = [{ id: 'u_admin', role: 'admin' }];
const end = (agent, extra = {}) => ({ type: 'turn_end', turnId: `${agent}-${Math.random()}`, agent, ok: true, origin: { kind: 'user' }, reply: 'SECRET REPLY TEXT', notify: ADMIN_BELL, ...extra });
const ask = (agent, id, extra = {}) => ({ type: 'ask_user', agent, request_id: id, questions: [{ question: 'Is the SSN 123-45-6789?', options: [{ label: 'Yes' }] }], ...extra });
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

test('a finished turn someone asked about says "<Agent> is done" with a deep link, high urgency and NO message content', async () => {
  const { push, sent } = mk();
  push.subscribe(SUB(1));
  push.onEvent(end('trader', { reply: 'The wallet holds 12,345 USDC' }));
  await flush();
  assert.strictEqual(sent.length, 1);
  const p = sent[0].body;
  assert.deepStrictEqual(Object.keys(p).sort(), ['body', 'tag', 'title', 'ts', 'url']);
  assert.strictEqual(p.title, 'Trader is done');
  assert.strictEqual(p.body, 'Tap to open the reply');
  assert.strictEqual(p.url, '/mobile#chat=trader');
  assert.strictEqual(p.tag, 'done-trader');
  assert.ok(!JSON.stringify(sent[0]).includes('12,345'));
  assert.ok(!JSON.stringify(sent[0]).includes('SECRET'));
  assert.strictEqual(sent[0].opts.TTL, 300);
  assert.strictEqual(sent[0].opts.urgency, 'high');
  assert.strictEqual(sent[0].opts.vapidDetails.publicKey, 'PUBKEY');
});

test('no bell, no push: finished replies (yours, consults, workers, scheduled tasks) notify no one', async () => {
  const { push, sent } = mk();
  push.subscribe(SUB(1));
  push.onEvent(end('maestro', { notify: [] }));
  push.onEvent(end('fable', { notify: undefined, origin: { kind: 'consultation', from: 'maestro' } }));
  push.onEvent(end('tw-maestro-1-abcd', { notify: [] }));
  push.onEvent(end('trader', { notify: [], origin: { kind: 'schedule', from: 'Nightly', label: 'Nightly' } }));
  await flush();
  assert.strictEqual(sent.length, 0);
});

test('a failed turn someone asked about says "stopped with an error"; stopped turns and repeats of a turn do not push', async () => {
  const { push, sent } = mk();
  push.subscribe(SUB(1));
  push.onEvent(end('trader', { ok: false, error: 'provider error' }));
  await flush();
  assert.strictEqual(sent[0].body.title, 'Trader stopped with an error');
  const e = end('maestro');
  push.onEvent(e); push.onEvent(e);
  await flush();
  assert.strictEqual(sent.length, 2, 'the same turn_end pushes once');
  push.onEvent(end('maestro', { ok: false, error: 'stopped' }));
  push.onEvent({ type: 'turn_delta', agent: 'maestro', text: 'x' });
  push.onEvent({ type: 'turn_start', agent: 'maestro' });
  await flush();
  assert.strictEqual(sent.length, 2, 'you stopped it yourself: nothing to tell');
});

test('the bell reaches the devices of the person who tapped it; devices registered before accounts count as an admin\'s; "*" (no accounts) reaches all', async () => {
  const { push, sent } = mk();
  push.subscribe(SUB(1), null, { id: 'u_admin', role: 'admin' });
  push.subscribe(SUB(2), null, { id: 'u_member', role: 'member' });
  push.subscribe(SUB(3), ['someone-else'], { id: 'u_admin', role: 'admin' });   // the follow list does not apply: you asked
  push.subscribe(SUB(4), null);
  push.onEvent(end('trader'));
  await flush();
  assert.deepStrictEqual(sent.map(x => x.sub.endpoint).sort(), [SUB(1).endpoint, SUB(3).endpoint, SUB(4).endpoint]);
  sent.length = 0;
  push.onEvent(end('kids', { notify: [{ id: 'u_member', role: 'member' }] }));
  await flush();
  assert.deepStrictEqual(sent.map(x => x.sub.endpoint), [SUB(2).endpoint], 'a member\'s bell: that member\'s device only');
  sent.length = 0;
  push.onEvent(end('trader', { notify: [{ id: '*', role: 'admin' }] }));
  await flush();
  assert.strictEqual(sent.length, 4);
  assert.strictEqual(push.devicesFor({ id: 'u_admin', role: 'admin' }), 3);
  assert.strictEqual(push.devicesFor({ id: 'u_member', role: 'member' }), 1);
  assert.strictEqual(push.devicesFor({ id: '*' }), 4);
  assert.strictEqual(push.devicesFor(null), 0);
});

test('a question notifies only after it waited 3 minutes unanswered, once, never with its text; answered sooner: nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { push, sent } = mk();
  push.subscribe(SUB(1));
  push.onEvent(ask('maestro', 'r1'));
  await flush();
  assert.strictEqual(sent.length, 0, 'not at once');
  t.mock.timers.tick(QUESTION_DELAY_MS - 1000); await flush();
  assert.strictEqual(sent.length, 0, 'not before 3 minutes');
  t.mock.timers.tick(1000); await flush();
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].body.title, 'Maestro has a question');
  assert.strictEqual(sent[0].body.body, 'Waiting for your answer for 3 min. Tap to answer');
  assert.strictEqual(sent[0].body.tag, 'question-maestro');
  assert.strictEqual(sent[0].opts.urgency, 'high');
  assert.ok(!JSON.stringify(sent[0]).includes('123-45'));
  push.onEvent(ask('maestro', 'r1')); t.mock.timers.tick(QUESTION_DELAY_MS * 2); await flush();
  assert.strictEqual(sent.length, 2, 'a repeat of the event for a question already reminded waits its own 3 minutes once');

  push.onEvent(ask('trader', 'r2'));
  t.mock.timers.tick(60000);
  push.onEvent({ type: 'ask_user_done', agent: 'trader', request_id: 'r2', result: 'answered' });
  t.mock.timers.tick(QUESTION_DELAY_MS); await flush();
  assert.strictEqual(sent.length, 2, 'answered after one minute: no reminder');
  push.onEvent(ask('trader', 'r3'));
  push.onEvent(end('trader', { notify: [] }));    // the turn ended (timed out, stopped): its question went with it
  t.mock.timers.tick(QUESTION_DELAY_MS); await flush();
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(push.waitingCount(), 0);
});

test('the question delay comes from settings: unset = 3 min, null = never, 0 = at once; the settings box value is cleaned', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const never = mk({ questionDelayMs: () => null });
  never.push.subscribe(SUB(1));
  never.push.onEvent(ask('maestro', 'n1')); t.mock.timers.tick(QUESTION_DELAY_MS * 3); await flush();
  assert.strictEqual(never.sent.length, 0);
  const now = mk({ questionDelayMs: () => 0 });
  now.push.subscribe(SUB(1));
  now.push.onEvent(ask('maestro', 'z1')); t.mock.timers.tick(0); await flush();
  assert.strictEqual(now.sent.length, 1);
  assert.strictEqual(now.sent[0].body.body, 'Tap to answer');
  assert.strictEqual(questionDelayFrom({}), QUESTION_DELAY_MS);
  assert.strictEqual(questionDelayFrom({ notify: { questionAfterMinutes: null } }), null);
  assert.strictEqual(questionDelayFrom({ notify: { questionAfterMinutes: 0 } }), 0);
  assert.strictEqual(questionDelayFrom({ notify: { questionAfterMinutes: 10 } }), 600000);
  assert.strictEqual(questionDelayFrom({ notify: { questionAfterMinutes: 'x' } }), QUESTION_DELAY_MS);
  assert.deepStrictEqual(cleanNotifySettings({ questionAfterMinutes: '5' }), { questionAfterMinutes: 5 });
  assert.deepStrictEqual(cleanNotifySettings({ questionAfterMinutes: 999 }), { questionAfterMinutes: 120 });
  assert.deepStrictEqual(cleanNotifySettings({ questionAfterMinutes: -2 }), { questionAfterMinutes: 0 });
  assert.deepStrictEqual(cleanNotifySettings({ questionAfterMinutes: null }), { questionAfterMinutes: null });
  assert.deepStrictEqual(cleanNotifySettings({ questionAfterMinutes: 'off' }), { questionAfterMinutes: null });
  assert.deepStrictEqual(cleanNotifySettings('junk'), { questionAfterMinutes: 3 });
});

test('question reminders follow the device\'s agent list; a member\'s own agents remind only that member\'s devices', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { push, sent } = mk({ ownerOf: (a) => (a === 'kids' ? 'u_member' : null) });
  push.subscribe(SUB(1), ['trader'], { id: 'u_admin', role: 'admin' });
  push.subscribe(SUB(2), ['maestro'], { id: 'u_admin', role: 'admin' });
  push.subscribe(SUB(3), null, { id: 'u_member', role: 'member' });
  push.subscribe(SUB(4), null);
  push.onEvent(ask('trader', 'q1')); t.mock.timers.tick(QUESTION_DELAY_MS); await flush();
  assert.deepStrictEqual(sent.map(s => s.sub.endpoint).sort(), [SUB(1).endpoint, SUB(4).endpoint], 'household agent: admins\' devices that follow it, and older devices; not the member\'s');
  sent.length = 0;
  push.onEvent(ask('kids', 'q2')); t.mock.timers.tick(QUESTION_DELAY_MS); await flush();
  assert.deepStrictEqual(sent.map(s => s.sub.endpoint), [SUB(3).endpoint], 'the member\'s own agent: the member\'s device only');
});

test('approvals wait like questions and are dropped when decided in time', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { push, sent } = mk();
  push.subscribe(SUB(1));
  push.onEvent({ type: 'approval_request', id: 'ap1', agent: 'trader', cls: 'send', summary: 'email to someone' });
  t.mock.timers.tick(QUESTION_DELAY_MS); await flush();
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].body.title, 'Trader wants to send something');
  assert.match(sent[0].body.body, /tap to approve or deny/);
  push.onEvent({ type: 'approval_request', id: 'ap2', agent: 'trader', cls: 'destroy', summary: 'rm' });
  t.mock.timers.tick(30000);
  push.onEvent({ type: 'approval_resolved', id: 'ap2', agent: 'trader', decision: 'deny' });
  t.mock.timers.tick(QUESTION_DELAY_MS); await flush();
  assert.strictEqual(sent.length, 1);
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
  ev.publish('turn_end', { turnId: 't0', agent: 'trader', origin: { kind: 'user' }, ok: true, error: null, reply: 'hi', notify: [] });
  ev.publish('turn_end', { turnId: 't1', agent: 'trader', origin: { kind: 'user' }, ok: true, error: null, reply: 'hi', notify: ADMIN_BELL });
  await flush();
  assert.strictEqual(sent.length, 1, 'only the turn someone asked about');
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

test('a test push is marked force (the phone shows it even with the app in front); done pushes log sent/failed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-'));
  const logs = []; const sent = [];
  const push = createPush({ dir, now: () => 1_000_000, log: (...a) => logs.push(a.join(' ')),
    webpush: { generateVAPIDKeys: () => ({ publicKey: 'PUBKEY', privateKey: 'PRIVKEY' }) },
    sender: async (sub, body) => { sent.push(JSON.parse(body)); } });
  push.subscribe(SUB(1));
  await push.test();
  assert.equal(sent[0].force, true);
  push.onEvent({ type: 'turn_end', turnId: 't1', agent: 'trader', ok: true, origin: { kind: 'user' }, notify: ADMIN_BELL });
  await new Promise(r => setImmediate(r));
  assert.equal(sent[1].force, undefined, 'done pushes are not forced (the app in front already shows the reply)');
  assert.ok(logs.some(l => /done push for trader: sent 1, failed 0/.test(l)), logs.join('|'));
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
