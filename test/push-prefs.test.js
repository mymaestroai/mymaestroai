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
    sender: async (s, body) => { sent.push({ who: Object.keys(EP).find(k => EP[k] === s.endpoint), title: JSON.parse(body).title }); },
  });
  push.subscribe(sub(EP.admin, 1), null, { id: 'u_admin', role: 'admin' });
  push.subscribe(sub(EP.sam, 2), null, { id: 'u_sam', role: 'member' });
  push.subscribe(sub(EP.legacy, 3), null, null);
  return { push, sent, clock, root };
}
const take = (sent) => sent.splice(0).map(s => `${s.who}|${s.title}`).sort();

// The same fixed script of events; returns what each step sent (device + title).
async function script(push, sent) {
  const log = [];
  const step = async (name, fn) => { await fn(); await wait(); log.push([name, take(sent)]); };
  await step('ask_user + fire (household agent)', () => push.onEvent({ type: 'ask_user', agent: 'helper', request_id: 'r1' }));
  await step('ask_user + fire (member agent)', () => push.onEvent({ type: 'ask_user', agent: 'coach', request_id: 'r2' }));
  await step('ask_user_done', () => { push.onEvent({ type: 'ask_user', agent: 'helper', request_id: 'r3' }); });   // fires at once (delay 0); done after is a no-op
  await step('ask_user_done after', () => push.onEvent({ type: 'ask_user_done', agent: 'helper', request_id: 'r3' }));
  await step('approval_request + fire', () => push.onEvent({ type: 'approval_request', id: 'ap1', agent: 'helper', cls: 'send', summary: 's' }));
  await step('approval_request member agent', () => push.onEvent({ type: 'approval_request', id: 'ap2', agent: 'coach', cls: 'admin', summary: 's' }));
  await step('approval_resolved', () => push.onEvent({ type: 'approval_resolved', id: 'ap1' }));
  await step('for_owner household', () => push.onEvent({ type: 'for_owner', agent: 'helper', turnId: 't1', reason: 'x' }));
  await step('for_owner member agent', () => push.onEvent({ type: 'for_owner', agent: 'coach', turnId: 't2', reason: 'x' }));
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
  await step('notifyUsers', () => push.notifyUsers({ title: 'Users notice' }, ['u_sam']));
  await step('test()', () => push.test());
  return log;
}

test('PARITY: no settings send exactly what the code sent before settings existed', async (t) => {
  const a = rig(t);                                                         // (a) no prefs at all
  const b = rig(t, { prefs: createNotifyPrefs({ file: path.join(tmpRoot(t), 'prefs.json') }) });   // (b) a real, empty store
  const la = await script(a.push, a.sent);
  const lb = await script(b.push, b.sent);
  assert.deepEqual(lb, la);
  const flat = Object.fromEntries(la);
  // Sanity: the script really exercised the sends (not two empty lists).
  assert.deepEqual(flat['ask_user + fire (household agent)'], ['admin|Helper has a question', 'legacy|Helper has a question']);
  assert.deepEqual(flat['ask_user + fire (member agent)'], ['sam|Coach has a question']);
  assert.deepEqual(flat['for_owner household'], ['admin|Helper has something for you', 'legacy|Helper has something for you']);
  assert.deepEqual(flat['turn_end notify by admin'], ['admin|Helper is done', 'legacy|Helper is done']);
  assert.deepEqual(flat['turn_end notify by member'], ['sam|Coach is done']);
  assert.deepEqual(flat['turn_end failed'], ['admin|Helper stopped with an error', 'legacy|Helper stopped with an error']);
  assert.deepEqual(flat['turn_end stopped'], []);
  assert.deepEqual(flat['notify adminsOnly'], ['admin|Admin notice', 'legacy|Admin notice']);
  assert.equal(flat['notify everyone'].length, 3);
  assert.equal(flat['agent_request'].length, 3);
  assert.equal(flat['test()'].length, 3);
  assert.deepEqual(flat['notifyUsers'], ['sam|Users notice']);
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

test('Notify me: still sends when "everything else" is off, not when away and present', async (t) => {
  const r = gated(t, (p) => { p.setDefault('u_admin', { other: 'off' }); });
  const done = (id) => ({ type: 'turn_end', agent: 'helper', turnId: id, ok: true, notify: [{ id: 'u_admin', role: 'admin' }] });
  assert.deepEqual(await fire(r, done('n1')), ['admin|Helper is done', 'legacy|Helper is done']);
  r.prefs.setDefault('u_admin', { other: 'away' });
  r.prefs.touch('u_admin', 'tab', true);
  assert.deepEqual(await fire(r, done('n2')), ['legacy|Helper is done']);
  r.clock.t += 151000;
  assert.deepEqual(await fire(r, done('n3')), ['admin|Helper is done', 'legacy|Helper is done']);
});

test('hub notices without an agent follow the person\'s default for everything else', async (t) => {
  const r = gated(t, (p) => { p.setDefault('u_admin', { other: 'off' }); p.setDefault('u_sam', { other: 'off' }); });
  assert.deepEqual(await fire(r, { type: 'agent_request', id: 'x', byAgent: 'helper', kind: 'agent', description: '' }), ['legacy|Helper asks for a new agent']);
  assert.deepEqual(await fire(r, { type: 'provider_paced', provider: 'google', reason: 'timeout' }), ['legacy|My Maestro AI pacing: Gemini']);
  assert.deepEqual(await fire(r, { type: 'hub_halted' }), ['legacy|My Maestro AI halted']);
  await r.push.notify({ title: 'Plan limit' }, { adminsOnly: true });
  assert.deepEqual(take(r.sent), ['legacy|Plan limit']);
  await r.push.notifyEach({ title: 'Update' }, { adminsOnly: true });
  assert.deepEqual(take(r.sent), ['legacy|Update']);
  await r.push.notify({ title: 'Question-ish' }, { kind: 'questions' });      // another kind is not affected by other:off
  assert.deepEqual(take(r.sent), ['admin|Question-ish', 'legacy|Question-ish', 'sam|Question-ish']);
});

test('always notices ignore "off"; notifyUsers without a kind goes; test() is never gated', async (t) => {
  const r = gated(t, (p) => { for (const u of ['u_admin', 'u_sam']) p.setDefault(u, { questions: 'off', other: 'off' }); });
  await r.push.notify({ title: 'Security' }, { adminsOnly: true, always: true });
  assert.deepEqual(take(r.sent), ['admin|Security', 'legacy|Security']);
  await r.push.notifyEach({ title: 'Backup failed' }, { adminsOnly: true, always: true });
  assert.deepEqual(take(r.sent), ['admin|Backup failed', 'legacy|Backup failed']);
  await r.push.notifyUsers({ title: 'Recording access changed' }, ['u_sam']);
  assert.deepEqual(take(r.sent), ['sam|Recording access changed']);
  await r.push.notifyUsers({ title: 'Gated' }, ['u_sam'], { kind: 'other' });
  assert.deepEqual(take(r.sent), []);
  await r.push.test();
  assert.equal(take(r.sent).length, 3);
});

test('a device registered before accounts always gets everything, whatever anyone set', async (t) => {
  const r = gated(t, (p) => { for (const u of ['u_admin', 'u_sam', '*']) p.setDefault(u, { questions: 'off', other: 'off' }); });
  assert.deepEqual(await fire(r, { type: 'ask_user', agent: 'helper', request_id: 'l1' }), ['legacy|Helper has a question']);
  assert.deepEqual(await fire(r, { type: 'for_owner', agent: 'helper', turnId: 'l2', reason: '' }), ['legacy|Helper has something for you']);
});

test('a broken store never silences or breaks a send', async (t) => {
  const prefs = { mode() { throw new Error('boom'); }, isAway() { throw new Error('boom'); } };
  const r = rig(t, { prefs });
  assert.deepEqual(await fire(r, { type: 'ask_user', agent: 'helper', request_id: 'z' }), ['admin|Helper has a question', 'legacy|Helper has a question']);
});

test('wiring: security, access and data-safety callers pass always: true; plain notices keep the default', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const server = read('server.js');
  assert.match(server, /admin2fa = [\s\S]{0,400}getPush\(\)\.notify\(p, \{ adminsOnly: true, always: true \}\)/);
  assert.match(server, /createPasskeyRoutes\([\s\S]{0,400}notifyEach\(p, \{ adminsOnly: true, urgency: 'high', always: true \}\)/);
  assert.match(server, /createScheduler\([\s\S]{0,400}notifyEach\(p, \{ adminsOnly: true, urgency: 'high', always: true \}\)/);
  assert.match(server, /walletLockedNotice\([\s\S]{0,400}notifyEach\(p, \{ \.\.\.o, always: true \}\)/);
  assert.match(read('lib/connector-access.js'), /adminsOnly: true, always: true/);
  assert.match(read('lib/modules/index.js'), /notify\(payload, \{ adminsOnly: true, always: true \}\)/);
  for (const f of ['lib/plan-usage.js', 'lib/memory-health.js', 'lib/update-check.js', 'lib/modules/health.js']) assert.ok(!/always: true/.test(read(f)), `${f} stays a normal notice`);
  assert.match(read('lib/push.js'), /prefs: require\('\.\/notify-prefs'\)\.getNotifyPrefs\(\)/);
});
