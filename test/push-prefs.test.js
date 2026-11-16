'use strict';
// Per-person, per-agent notification settings applied to every send in lib/push (lib/notify-prefs).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPush } = require('../lib/push');
const { createNotifyPrefs } = require('../lib/notify-prefs');

const tmpRoot = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'push-prefs-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const EP = { admin: 'https://push.example.test/admin', sam: 'https://push.example.test/sam', legacy: 'https://push.example.test/legacy' };
const sub = (ep, n) => ({ endpoint: ep, keys: { p256dh: 'BPkey' + n, auth: 'auth' + n } });
const wait = (ms = 12) => new Promise(r => setTimeout(r, ms));
const OWNERS = { coach: 'u_sam' };          // coach is a member-owned agent; helper belongs to the household
const NAMES = { helper: 'Helper', coach: 'Coach' };

// A push with the fixed device list: an admin's phone, a member's phone, a phone registered before accounts.
function rig(t, { prefs = null, clock = { t: 1_000_000 } } = {}) {
  const root = tmpRoot(t);
  const sent = [];
  const push = createPush({
    dir: path.join(root, 'push'), now: () => clock.t, questionDelayMs: () => 0, prefs,
    ownerOf: (a) => OWNERS[a] || null, displayName: (a) => NAMES[a] || a,
    webpush: { generateVAPIDKeys: () => ({ publicKey: 'PUBKEY', privateKey: 'PRIVKEY' }) },
    sender: async (s, body, opts) => { sent.push({ who: Object.keys(EP).find(k => EP[k] === s.endpoint), title: JSON.parse(body).title, urgency: opts.urgency }); },
  });
  push.subscribe(sub(EP.admin, 1), null, { id: 'u_admin', role: 'admin' });
  push.subscribe(sub(EP.sam, 2), null, { id: 'u_sam', role: 'member' });
  push.subscribe(sub(EP.legacy, 3), null, null);
  return { push, sent, clock, root };
}
const take = (sent) => sent.splice(0).map(s => `${s.who}|${s.title}`).sort();
const takeU = (sent) => sent.splice(0).map(s => `${s.who}|${s.title}|${s.urgency}`).sort();
const idOf = (ep) => require('node:crypto').createHash('sha256').update(ep).digest('hex').slice(0, 16);

// The same fixed script of events; returns what each step sent (device + title + urgency).
// Kept in step with /tmp/anvil-golden.js, which produced GOLDEN by running this script against the base branch's lib/push.js.
async function script(push, sent) {
  const log = [];
  const step = async (name, fn) => { await fn(); await wait(); log.push([name, takeU(sent)]); };
  await step('ask_user + fire (household agent)', () => push.onEvent({ type: 'ask_user', agent: 'helper', request_id: 'r1' }));
  await step('ask_user + fire (member agent)', () => push.onEvent({ type: 'ask_user', agent: 'coach', request_id: 'r2' }));
  await step('ask_user_done', () => { push.onEvent({ type: 'ask_user', agent: 'helper', request_id: 'r3' }); });   // fires at once (delay 0); done after is a no-op
  await step('ask_user_done after', () => push.onEvent({ type: 'ask_user_done', agent: 'helper', request_id: 'r3' }));
  await step('approval_request + fire', () => push.onEvent({ type: 'approval_request', id: 'ap1', agent: 'helper', cls: 'send', summary: 's' }));
  await step('approval_request member agent', () => push.onEvent({ type: 'approval_request', id: 'ap2', agent: 'coach', cls: 'admin', summary: 's' }));
  await step('approval_request module', () => push.onEvent({ type: 'approval_request', id: 'ap3', agent: 'helper', cls: 'module', detail: { module: 'ledger' }, summary: 's' }));
  await step('approval_resolved', () => push.onEvent({ type: 'approval_resolved', id: 'ap1' }));
  await step('for_owner household', () => push.onEvent({ type: 'for_owner', agent: 'helper', turnId: 't1', reason: 'x' }));
  await step('for_owner member agent', () => push.onEvent({ type: 'for_owner', agent: 'coach', turnId: 't2', reason: 'x' }));
  await step('for_owner asks', () => push.onEvent({ type: 'for_owner', agent: 'helper', turnId: 't3', reason: 'x', asks: true }));
  await step('turn_end notify by admin', () => push.onEvent({ type: 'turn_end', agent: 'helper', turnId: 'e1', ok: true, notify: [{ id: 'u_admin', role: 'admin' }] }));
  await step('turn_end notify by member', () => push.onEvent({ type: 'turn_end', agent: 'coach', turnId: 'e2', ok: true, notify: [{ id: 'u_sam', role: 'member' }] }));
  await step('turn_end failed', () => push.onEvent({ type: 'turn_end', agent: 'helper', turnId: 'e3', ok: false, notify: [{ id: 'u_admin', role: 'admin' }] }));
  await step('turn_end stopped', () => push.onEvent({ type: 'turn_end', agent: 'helper', turnId: 'e4', ok: false, error: 'stopped', notify: [{ id: 'u_admin', role: 'admin' }] }));
  await step('turn_end nobody asked', () => push.onEvent({ type: 'turn_end', agent: 'helper', turnId: 'e5', ok: true, notify: [] }));
  await step('agent_request', () => push.onEvent({ type: 'agent_request', id: 'q1', byAgent: 'helper', kind: 'agent', description: 'd' }));
  await step('provider_paced', () => push.onEvent({ type: 'provider_paced', provider: 'openai', reason: 'rate_limit' }));
  await step('hub_halted', () => push.onEvent({ type: 'hub_halted' }));
  await step('notify adminsOnly', () => push.notify({ title: 'Admin notice' }, { adminsOnly: true }));
  await step('notify everyone', () => push.notify({ title: 'Everyone notice' }));
  await step('notifyEach adminsOnly', () => push.notifyEach({ title: 'Each notice' }, { adminsOnly: true }));
  await step('notifyEach skip one device', () => push.notifyEach({ title: 'Skip notice' }, { skip: (id) => id === idOf(EP.sam) }));
  await step('notifyUsers', () => push.notifyUsers({ title: 'Users notice' }, ['u_sam']));
  await step('notifyUsers two people, no kind', () => push.notifyUsers({ title: 'Two notice' }, ['u_sam', 'u_admin']));
  await step('test()', () => push.test());
  return log;
}

// What the base branch's createPush sent for the script above (step, then device|title|urgency, sorted).
const GOLDEN = [
 [
  "ask_user + fire (household agent)",
  [
   "admin|Helper has a question|high",
   "legacy|Helper has a question|high"
  ]
 ],
 [
  "ask_user + fire (member agent)",
  [
   "sam|Coach has a question|high"
  ]
 ],
 [
  "ask_user_done",
  [
   "admin|Helper has a question|high",
   "legacy|Helper has a question|high"
  ]
 ],
 [
  "ask_user_done after",
  []
 ],
 [
  "approval_request + fire",
  [
   "admin|Helper wants to send something|high",
   "legacy|Helper wants to send something|high"
  ]
 ],
 [
  "approval_request member agent",
  [
   "sam|Coach wants to change hub data|high"
  ]
 ],
 [
  "approval_request module",
  [
   "admin|Helper needs your OK|high",
   "legacy|Helper needs your OK|high"
  ]
 ],
 [
  "approval_resolved",
  []
 ],
 [
  "for_owner household",
  [
   "admin|Helper has something for you|high",
   "legacy|Helper has something for you|high"
  ]
 ],
 [
  "for_owner member agent",
  [
   "sam|Coach has something for you|high"
  ]
 ],
 [
  "for_owner asks",
  [
   "admin|Helper has something for you|high",
   "legacy|Helper has something for you|high"
  ]
 ],
 [
  "turn_end notify by admin",
  [
   "admin|Helper is done|high",
   "legacy|Helper is done|high"
  ]
 ],
 [
  "turn_end notify by member",
  [
   "sam|Coach is done|high"
  ]
 ],
 [
  "turn_end failed",
  [
   "admin|Helper stopped with an error|high",
   "legacy|Helper stopped with an error|high"
  ]
 ],
 [
  "turn_end stopped",
  []
 ],
 [
  "turn_end nobody asked",
  []
 ],
 [
  "agent_request",
  [
   "admin|Helper asks for a new agent|normal",
   "legacy|Helper asks for a new agent|normal",
   "sam|Helper asks for a new agent|normal"
  ]
 ],
 [
  "provider_paced",
  [
   "admin|My Maestro AI pacing: OpenAI|high",
   "legacy|My Maestro AI pacing: OpenAI|high",
   "sam|My Maestro AI pacing: OpenAI|high"
  ]
 ],
 [
  "hub_halted",
  [
   "admin|My Maestro AI halted|high",
   "legacy|My Maestro AI halted|high",
   "sam|My Maestro AI halted|high"
  ]
 ],
 [
  "notify adminsOnly",
  [
   "admin|Admin notice|normal",
   "legacy|Admin notice|normal"
  ]
 ],
 [
  "notify everyone",
  [
   "admin|Everyone notice|normal",
   "legacy|Everyone notice|normal",
   "sam|Everyone notice|normal"
  ]
 ],
 [
  "notifyEach adminsOnly",
  [
   "admin|Each notice|normal",
   "legacy|Each notice|normal"
  ]
 ],
 [
  "notifyEach skip one device",
  [
   "admin|Skip notice|normal",
   "legacy|Skip notice|normal"
  ]
 ],
 [
  "notifyUsers",
  [
   "sam|Users notice|high"
  ]
 ],
 [
  "notifyUsers two people, no kind",
  [
   "admin|Two notice|high",
   "sam|Two notice|high"
  ]
 ],
 [
  "test()",
  [
   "admin|My Maestro AI test|normal",
   "legacy|My Maestro AI test|normal",
   "sam|My Maestro AI test|normal"
  ]
 ]
];

test('PARITY (golden, from the base branch): no settings send exactly what the code sent before settings existed', async (t) => {
  const a = rig(t);                                                         // (a) no prefs at all
  const b = rig(t, { prefs: createNotifyPrefs({ file: path.join(tmpRoot(t), 'prefs.json') }) });   // (b) a real, empty store
  const la = await script(a.push, a.sent);
  const lb = await script(b.push, b.sent);
  assert.equal(la.length, GOLDEN.length);
  for (let i = 0; i < GOLDEN.length; i++) {
    assert.deepEqual(la[i], GOLDEN[i], `no prefs, step "${GOLDEN[i][0]}"`);
    assert.deepEqual(lb[i], GOLDEN[i], `empty store, step "${GOLDEN[i][0]}"`);
  }
  // Sanity: the golden really holds sends (not a list of empty steps).
  assert.ok(GOLDEN.reduce((n, g) => n + g[1].length, 0) >= 40);
  assert.deepEqual(Object.fromEntries(GOLDEN)['turn_end stopped'], []);
});

function gated(t, setup) {
  const prefs = createNotifyPrefs({ file: path.join(tmpRoot(t), 'prefs.json'), now: () => clock.t });
  const clock = { t: 1_000_000 };
  const r = rig(t, { prefs, clock });
  setup(prefs);
  return { ...r, prefs, clock };
}
const fire = async (r, ev) => { r.push.onEvent(ev); await wait(); return take(r.sent); };

test('questions off for one agent blocks only that person\'s devices for that agent', async (t) => {
  const r = gated(t, (p) => { p.setAgent('u_admin', 'helper', { questions: 'off' }); });
  assert.deepEqual(await fire(r, { type: 'ask_user', agent: 'helper', request_id: 'a' }), ['legacy|Helper has a question']);   // admin silenced; legacy and others unchanged
  assert.deepEqual(await fire(r, { type: 'approval_request', id: 'ap', agent: 'helper', cls: 'send', summary: '' }), ['legacy|Helper wants to send something']);
  const other = await fire(r, { type: 'ask_user', agent: 'coach', request_id: 'b' });
  assert.deepEqual(other, ['sam|Coach has a question']);                      // other agent / other person unchanged
  const r2 = gated(t, (p) => { p.setAgent('u_sam', 'coach', { questions: 'off' }); });
  assert.deepEqual(await fire(r2, { type: 'ask_user', agent: 'coach', request_id: 'c' }), []);
  assert.deepEqual(await fire(r2, { type: 'ask_user', agent: 'helper', request_id: 'd' }), ['admin|Helper has a question', 'legacy|Helper has a question']);
});

test('the setting is read when the reminder fires, not when the question was asked', async (t) => {
  const r = gated(t, () => {});
  const root = tmpRoot(t);
  const sent = [];
  const prefs = createNotifyPrefs({ file: path.join(root, 'p.json') });
  const push = createPush({ dir: path.join(root, 'push'), prefs, questionDelayMs: () => 30, webpush: { generateVAPIDKeys: () => ({ publicKey: 'K', privateKey: 'P' }) }, sender: async (s) => { sent.push(s.endpoint); } });
  push.subscribe(sub(EP.admin, 1), null, { id: 'u_admin', role: 'admin' });
  push.onEvent({ type: 'ask_user', agent: 'helper', request_id: 'late' });
  prefs.setAgent('u_admin', 'helper', { questions: 'off' });                  // changed during the wait
  await wait(80);
  assert.deepEqual(sent, []);
  assert.equal(r.push.count(), 3);
});

test('other off blocks for_owner without asks, not with asks: true; questions off blocks asks', async (t) => {
  const r = gated(t, (p) => { p.setDefault('u_admin', { other: 'off' }); });
  assert.deepEqual(await fire(r, { type: 'for_owner', agent: 'helper', turnId: 'f1', reason: '' }), ['legacy|Helper has something for you']);
  assert.deepEqual(await fire(r, { type: 'for_owner', agent: 'helper', turnId: 'f2', reason: '', asks: true }), ['admin|Helper has something for you', 'legacy|Helper has something for you']);
  r.prefs.setAgent('u_admin', 'helper', { questions: 'off' });
  assert.deepEqual(await fire(r, { type: 'for_owner', agent: 'helper', turnId: 'f3', reason: '', asks: true }), ['legacy|Helper has something for you']);
  assert.deepEqual(await fire(r, { type: 'for_owner', agent: 'helper', turnId: 'f4', reason: '', asks: 'yes' }), ['legacy|Helper has something for you']);   // only a real true counts as a question
});

test('away: a visible page of the person silences it, no page lets it through', async (t) => {
  const r = gated(t, (p) => { p.setDefault('u_admin', { questions: 'away' }); });
  r.prefs.touch('u_admin', 'tab', true);
  assert.deepEqual(await fire(r, { type: 'ask_user', agent: 'helper', request_id: 'p1' }), ['legacy|Helper has a question']);
  r.clock.t += 151000;                                                         // the page stopped reporting
  assert.deepEqual(await fire(r, { type: 'ask_user', agent: 'helper', request_id: 'p2' }), ['admin|Helper has a question', 'legacy|Helper has a question']);
  r.prefs.touch('u_admin', 'tab', true); r.prefs.touch('u_admin', 'tab', false);   // hidden
  assert.deepEqual(await fire(r, { type: 'ask_user', agent: 'helper', request_id: 'p3' }), ['admin|Helper has a question', 'legacy|Helper has a question']);
});

test('Notify me follows "requests you made" fully: off blocks, away applies; "everything else" does not matter', async (t) => {
  const r = gated(t, (p) => { p.setDefault('u_admin', { other: 'off' }); });
  const done = (id) => ({ type: 'turn_end', agent: 'helper', turnId: id, ok: true, notify: [{ id: 'u_admin', role: 'admin' }] });
  assert.deepEqual(await fire(r, done('n1')), ['admin|Helper is done', 'legacy|Helper is done'], 'other off does not stop a requested notice');
  r.prefs.setDefault('u_admin', { requested: 'off' });
  assert.deepEqual(await fire(r, done('n1b')), ['legacy|Helper is done'], 'requested off blocks Notify me (no Off exception any more)');
  r.prefs.setDefault('u_admin', { requested: 'away' });
  r.prefs.touch('u_admin', 'tab', true);
  assert.deepEqual(await fire(r, done('n2')), ['legacy|Helper is done']);
  r.clock.t += 151000;
  assert.deepEqual(await fire(r, done('n3')), ['admin|Helper is done', 'legacy|Helper is done']);
  r.prefs.setAgent('u_admin', 'helper', { requested: 'off' });
  assert.deepEqual(await fire(r, done('n4')), ['legacy|Helper is done'], 'a per-agent override applies');
});

test('for_owner requested: its own setting, its own payload; other off or questions off do not block it', async (t) => {
  const r = gated(t, (p) => { p.setDefault('u_admin', { other: 'off', questions: 'off' }); });
  const ev = (id, extra = {}) => ({ type: 'for_owner', agent: 'helper', turnId: id, reason: 'Done: all work finished, good time to reboot', requested: true, ...extra });
  assert.deepEqual(await fire(r, ev('q1')), ['admin|Helper: something you asked to hear about', 'legacy|Helper: something you asked to hear about']);
  assert.deepEqual(await fire(r, ev('q2', { asks: true })), ['admin|Helper: something you asked to hear about', 'legacy|Helper: something you asked to hear about'], 'requested wins over asks');
  r.prefs.setDefault('u_admin', { requested: 'off' });
  assert.deepEqual(await fire(r, ev('q3')), ['legacy|Helper: something you asked to hear about']);
  r.prefs.setDefault('u_admin', { requested: 'away' });
  r.prefs.touch('u_admin', 'tab', true);
  assert.deepEqual(await fire(r, ev('q4')), ['legacy|Helper: something you asked to hear about']);
  r.clock.t += 151000;
  assert.equal((await fire(r, ev('q5'))).length, 2, 'away and no page in view: it goes');
  r.prefs.setAgent('u_admin', 'helper', { requested: 'off' });
  r.prefs.setDefault('u_admin', { requested: 'on' });
  assert.deepEqual(await fire(r, ev('q6')), ['legacy|Helper: something you asked to hear about'], 'a per-agent override applies');
});

test('for_owner requested payload: fixed title without the agent text, reason in the body (cut at 120), chat url, requested tag; others unchanged', async (t) => {
  const bodies = [];
  const root = tmpRoot(t);
  const push = createPush({ dir: path.join(root, 'push'), now: () => 1, displayName: (a) => NAMES[a] || a, webpush: { generateVAPIDKeys: () => ({ publicKey: 'K', privateKey: 'P' }) }, sender: async (s, body) => { bodies.push(JSON.parse(body)); } });
  push.subscribe(sub(EP.admin, 1), null, { id: 'u_admin', role: 'admin' });
  push.onEvent({ type: 'for_owner', agent: 'helper', turnId: 'p1', reason: 'x'.repeat(200), requested: true });
  push.onEvent({ type: 'for_owner', agent: 'helper', turnId: 'p2', reason: 'plain reason' });
  await wait();
  assert.deepEqual(bodies[0], { title: 'Helper: something you asked to hear about', body: 'x'.repeat(120) + ' · Tap to open', url: '/mobile#chat=helper', tag: 'requested-helper', ts: 1 });
  assert.deepEqual(bodies[1], { title: 'Helper has something for you', body: 'plain reason · Tap to open', url: '/mobile#chat=helper', tag: 'for-owner-helper', ts: 1 });
});

test('hub notices without an agent follow the person\'s default for everything else (halted follows security)', async (t) => {
  const r = gated(t, (p) => { p.setDefault('u_admin', { other: 'off' }); p.setDefault('u_sam', { other: 'off' }); });
  assert.deepEqual(await fire(r, { type: 'agent_request', id: 'x', byAgent: 'helper', kind: 'agent', description: '' }), ['admin|Helper asks for a new agent', 'legacy|Helper asks for a new agent', 'sam|Helper asks for a new agent'], 'an agent asking for a new agent is a question: other off does not block it');
  assert.deepEqual(await fire(r, { type: 'provider_paced', provider: 'google', reason: 'timeout' }), ['legacy|My Maestro AI pacing: Gemini']);
  assert.deepEqual(await fire(r, { type: 'hub_halted' }), ['admin|My Maestro AI halted', 'legacy|My Maestro AI halted', 'sam|My Maestro AI halted'], 'halted is a security notice: other off does not block it');
  await r.push.notify({ title: 'Plan limit' }, { adminsOnly: true });
  assert.deepEqual(take(r.sent), ['legacy|Plan limit']);
  await r.push.notifyEach({ title: 'Update' }, { adminsOnly: true });
  assert.deepEqual(take(r.sent), ['legacy|Update']);
  await r.push.notify({ title: 'Question-ish' }, { kind: 'questions' });      // another kind is not affected by other:off
  assert.deepEqual(take(r.sent), ['admin|Question-ish', 'legacy|Question-ish', 'sam|Question-ish']);
});

test('security notices follow the security setting (notify, notifyEach, notifyUsers default, halted); other kinds do not touch them; test() is never gated', async (t) => {
  const r = gated(t, (p) => { for (const u of ['u_admin', 'u_sam']) p.setDefault(u, { questions: 'off', other: 'off', requested: 'off' }); });
  // security is still On: the other three being Off does not silence it
  await r.push.notify({ title: 'Security' }, { adminsOnly: true, kind: 'security' });
  assert.deepEqual(take(r.sent), ['admin|Security', 'legacy|Security']);
  await r.push.notifyEach({ title: 'Backup failed' }, { adminsOnly: true, kind: 'security' });
  assert.deepEqual(take(r.sent), ['admin|Backup failed', 'legacy|Backup failed']);
  await r.push.notifyUsers({ title: 'Recording access changed' }, ['u_sam']);
  assert.deepEqual(take(r.sent), ['sam|Recording access changed'], 'notifyUsers defaults to security');
  await r.push.notifyUsers({ title: 'Gated' }, ['u_sam'], { kind: 'other' });
  assert.deepEqual(take(r.sent), []);
  // security Off: all four paths hold for that person; the test push still goes
  for (const u of ['u_admin', 'u_sam']) r.prefs.setDefault(u, { security: 'off' });
  await r.push.notify({ title: 'Security' }, { adminsOnly: true, kind: 'security' });
  assert.deepEqual(take(r.sent), ['legacy|Security']);
  await r.push.notifyEach({ title: 'Backup failed' }, { adminsOnly: true, kind: 'security' });
  assert.deepEqual(take(r.sent), ['legacy|Backup failed']);
  await r.push.notifyUsers({ title: 'Recording access changed' }, ['u_sam']);
  assert.deepEqual(take(r.sent), [], 'notifyUsers with no kind is security');
  await r.push.notifyUsers({ title: 'Recording access changed' }, ['u_sam'], { kind: 'security' });
  assert.deepEqual(take(r.sent), []);
  assert.deepEqual(await fire(r, { type: 'hub_halted' }), ['legacy|My Maestro AI halted']);
  await r.push.test();
  assert.equal(take(r.sent).length, 3, 'test() is never gated');
  // security away
  for (const u of ['u_admin']) r.prefs.setDefault(u, { security: 'away' });
  r.prefs.touch('u_admin', 'tab', true);
  assert.deepEqual(await fire(r, { type: 'hub_halted' }), ['legacy|My Maestro AI halted']);
  r.clock.t += 151000;
  assert.deepEqual(await fire(r, { type: 'hub_halted' }), ['admin|My Maestro AI halted', 'legacy|My Maestro AI halted']);
});

test('push no longer has an always option: a notice with no kind is "other"', async (t) => {
  const r = gated(t, (p) => { p.setDefault('u_admin', { other: 'off' }); });
  await r.push.notify({ title: 'Plain' }, { adminsOnly: true, always: true });   // ignored now
  assert.deepEqual(take(r.sent), ['legacy|Plain']);
  assert.ok(!/always/.test(require('node:fs').readFileSync(path.join(__dirname, '..', 'lib', 'push.js'), 'utf8').replace(/as it always did/g, '')));
});

test('a device without an account follows the settings stored under "*"; with nothing set for "*" it hears everything', async (t) => {
  const r = gated(t, (p) => { for (const u of ['u_admin', 'u_sam']) p.setDefault(u, { questions: 'off', other: 'off' }); });   // nothing for '*'
  assert.deepEqual(await fire(r, { type: 'ask_user', agent: 'helper', request_id: 'l0' }), ['legacy|Helper has a question']);
  assert.deepEqual(await fire(r, { type: 'for_owner', agent: 'helper', turnId: 'l00', reason: '' }), ['legacy|Helper has something for you']);
  r.prefs.setDefault('*', { questions: 'off', other: 'off' });
  assert.deepEqual(await fire(r, { type: 'ask_user', agent: 'helper', request_id: 'l1' }), []);
  assert.deepEqual(await fire(r, { type: 'for_owner', agent: 'helper', turnId: 'l2', reason: '' }), []);
  assert.deepEqual(await fire(r, { type: 'agent_request', id: 'l3', byAgent: 'helper', kind: 'agent', description: '' }), []);
  await r.push.notify({ title: 'Plan limit' }, { adminsOnly: true });
  assert.deepEqual(take(r.sent), []);
  await r.push.notify({ title: 'Security' }, { adminsOnly: true, kind: 'security' });   // security is still On for admin and for '*'
  assert.deepEqual(take(r.sent), ['admin|Security', 'legacy|Security']);
  r.prefs.setDefault('*', { requested: 'away' });                             // Notify me follows "requests you made": away is held while a page is in view
  r.prefs.touch('*', 'tab', true);
  const done = (id) => ({ type: 'turn_end', agent: 'helper', turnId: id, ok: true, notify: [{ id: '*', role: 'admin' }] });
  assert.deepEqual(await fire(r, done('l4')), ['admin|Helper is done', 'sam|Helper is done']);   // admin and sam have nothing set for requested (On); the no-account device is away and present, so it is held
  r.prefs.setDefault('*', { requested: 'off' });
  assert.deepEqual(await fire(r, done('l5')), ['admin|Helper is done', 'sam|Helper is done']);   // off now blocks the no-account device too
});

test('a broken store never silences or breaks a send', async (t) => {
  const prefs = { mode() { throw new Error('boom'); }, isAway() { throw new Error('boom'); } };
  const r = rig(t, { prefs });
  assert.deepEqual(await fire(r, { type: 'ask_user', agent: 'helper', request_id: 'z' }), ['admin|Helper has a question', 'legacy|Helper has a question']);
});

// Round 2: the old `always: true` option became kind: 'security' (the person's "Security and access" setting, default On).
test('wiring: security, access and data-safety callers pass kind: \'security\'; plain notices keep the default', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const server = read('server.js');
  assert.match(server, /admin2fa = [\s\S]{0,400}getPush\(\)\.notify\(p, \{ adminsOnly: true, kind: 'security' \}\)/);
  assert.match(server, /createPasskeyRoutes\([\s\S]{0,400}notifyEach\(p, \{ adminsOnly: true, urgency: 'high', kind: 'security' \}\)/);
  assert.match(server, /createScheduler\([\s\S]{0,400}notifyEach\(p, \{ adminsOnly: true, urgency: 'high', kind: 'security' \}\)/);
  assert.match(server, /walletLockedNotice\([\s\S]{0,400}notifyEach\(p, \{ \.\.\.o, kind: 'security' \}\)/);
  assert.match(read('lib/connector-access.js'), /adminsOnly: true, kind: 'security'/);
  assert.match(read('lib/modules/index.js'), /notify\(payload, \{ adminsOnly: true, kind: 'security' \}\)/);
  assert.match(server, /notifyUsers\(\{\s*title: 'Recording access changed'[\s\S]{0,400}\{ kind: 'security' \}\)/);
  assert.match(read('lib/recordings/trouble.js'), /\}, ids, \{ kind: 'security' \}\)/);
  for (const f of ['lib/plan-usage.js', 'lib/memory-health.js', 'lib/update-check.js', 'lib/modules/health.js']) assert.ok(!/kind: 'security'/.test(read(f)), `${f} stays a normal notice`);
  assert.match(read('lib/push.js'), /prefs: require\('\.\/notify-prefs'\)\.getNotifyPrefs\(\)/);
});

test('agent_request follows the questions setting (default row), not everything else', async (t) => {
  const r = gated(t, (p) => { p.setDefault('u_admin', { questions: 'off' }); p.setDefault('u_sam', { other: 'off' }); });
  assert.deepEqual(await fire(r, { type: 'agent_request', id: 'aq', byAgent: 'helper', kind: 'team', description: 'd' }), ['legacy|Helper asks for a new team', 'sam|Helper asks for a new team']);
});
