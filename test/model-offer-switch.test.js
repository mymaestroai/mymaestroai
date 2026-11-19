'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createModelOfferSwitch, runTool, TOOL } = require('../lib/model-offer-switch');

const ROOT = path.join(__dirname, '..');
const OFFER = { name: 'helper-b', display: 'Helper B', from: 'claude-sdk/claude-opus-5-5', to: 'claude-sdk/claude-opus-6', kind: 'newer', why: 'a newer version of the same model', route: 'Subscription', cost: 'same subscription' };

function make(o = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-'));
  const pushed = []; const set = []; const pub = []; const declined = [];
  const state = { offer: { ...OFFER }, stamp: 'box:1', busy: false, ...o.state };
  const roster = o.roster || [{ name: 'helper-b', display: 'Helper B', owner: 'u-admin' }, { name: 'sam', owner: 'u-member' }];
  const auditFile = o.auditFile || path.join(d, 'log.jsonl');
  const sw = createModelOfferSwitch({
    offers: { list: async () => (state.offer ? [state.offer] : []), offerFor: async (n) => (state.offer && n === state.offer.name ? state.offer : null), decline: (n, m) => { declined.push([n, m]); return o.declineErr ? { ok: false, error: o.declineErr } : { ok: true }; }, forget() {} },
    agents: () => roster,
    stampOf: () => state.stamp,
    isMemberOwned: (a) => !!(a && a.owner && a.owner !== 'u-admin'),
    isVirtual: (n) => n.startsWith('tmp_'),
    isBusy: () => state.busy,
    setModel: async (n, m) => { set.push([n, m]); return o.setResult || { success: true }; },
    published: (n) => pub.push(n),
    push: { notify: (p, op) => { pushed.push({ p, op }); if (o.pushThrows) throw new Error('x'); } },
    auditFile,
    now: () => 0,
  });
  const lines = () => { try { return fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { d, sw, state, set, pushed, pub, declined, lines, cleanup: () => fs.rmSync(d, { recursive: true, force: true }) };
}
const yes = async () => true;
const allowed = () => true;

test('list and runTool list', async (t) => {
  const m = make(); t.after(m.cleanup);
  assert.equal((await m.sw.list()).length, 1);
  assert.equal(await runTool(m.sw, { action: 'list' }), 'helper-b: claude-sdk/claude-opus-5-5 -> claude-sdk/claude-opus-6 (a newer version of the same model; Subscription, same subscription)');
  m.state.offer = null;
  assert.equal(await runTool(m.sw, { action: 'list' }), 'No model suggestions right now.');
  assert.equal(await runTool(m.sw, { action: 'x' }), 'Action must be list, switch or not_now.');
});

test('switch: asks, logs before, changes, publishes and sends the notice', async (t) => {
  const m = make(); t.after(m.cleanup);
  let q = null, label = null;
  const r = await m.sw.switchTo({ agent: 'helper-b', by: 'lead-a', confirm: async (x, y) => { q = x; label = y; return true; }, stillAllowed: allowed });
  assert.deepEqual(r, { ok: true, name: 'helper-b', from: OFFER.from, to: OFFER.to });
  assert.equal(q, 'lead-a wants to switch Helper B (helper-b) from claude-sdk/claude-opus-5-5 to claude-sdk/claude-opus-6: a newer version of the same model; Subscription, same subscription. Switch?');
  assert.equal(label, 'Switch');
  assert.deepEqual(m.set, [['helper-b', OFFER.to]]);
  assert.deepEqual(m.lines().map((l) => l.state), ['requested', 'done']);
  assert.deepEqual(m.pub, ['helper-b']);
  assert.equal(m.pushed[0].p.title, 'Model switched');
  assert.equal(m.pushed[0].p.url, '/agent-settings.html?agent=helper-b');
  assert.deepEqual(m.pushed[0].op, { adminsOnly: true, kind: 'security' });
  assert.match(m.pushed[0].p.body, /choose claude-sdk\/claude-opus-5-5 again on its settings page\.$/);
});

test('switch refusals change nothing', async () => {
  const cases = [
    [{ agent: 'ghost' }, {}, /No agent named/],
    [{ agent: 'tmp_1' }, { roster: [{ name: 'tmp_1' }] }, /temporary worker/],
    [{ agent: 'sam' }, {}, /belongs to a member; only the owner can change its model\./],
    [{ agent: 'helper-b' }, { state: { offer: null } }, /helper-b has no model suggestion right now\./],
    [{ agent: 'helper-b' }, { state: { busy: true } }, /busy right now; try again when it's free\./],
    [{ agent: 'helper-b' }, { state: { stamp: '' } }, /Couldn't read helper-b's record/],
    [{ agent: 'helper-b' }, {}, /didn't confirm/],
  ];
  for (const [args, o, re] of cases) {
    const m = make(o);
    await assert.rejects(m.sw.switchTo({ ...args, by: 'lead-a', stillAllowed: allowed }), re);
    assert.deepEqual(m.set, []); assert.deepEqual(m.pushed, []);
    m.cleanup();
  }
});

test('switch: a no, a turn that ended, or a change while answering leaves it alone', async (t) => {
  const m = make(); t.after(m.cleanup);
  await assert.rejects(m.sw.switchTo({ agent: 'helper-b', confirm: async () => false, stillAllowed: allowed }), /didn't confirm/);
  await assert.rejects(m.sw.switchTo({ agent: 'helper-b', confirm: yes, stillAllowed: () => false }), /The turn ended before the owner answered/);
  await assert.rejects(m.sw.switchTo({ agent: 'helper-b', confirm: yes }), /The turn ended/);
  await assert.rejects(m.sw.switchTo({ agent: 'helper-b', confirm: async () => { m.state.stamp = 'box:2'; return true; }, stillAllowed: allowed }), /changed while the owner was answering/);
  m.state.stamp = 'box:1';
  await assert.rejects(m.sw.switchTo({ agent: 'helper-b', confirm: async () => { m.state.offer = { ...OFFER, to: 'claude-sdk/claude-opus-7' }; return true; }, stillAllowed: allowed }), /changed while the owner was answering/);
  m.state.offer = { ...OFFER };
  await assert.rejects(m.sw.switchTo({ agent: 'helper-b', confirm: async () => { m.state.busy = true; return true; }, stillAllowed: allowed }), /busy right now/);
  assert.deepEqual(m.set, []);
});

test('switch: a failed audit refuses; a failed change is logged; a failed notice keeps the change', async (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-')); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.mkdirSync(path.join(d, 'dir'));   // the audit file is a directory: the append fails
  let m = make({ auditFile: path.join(d, 'dir') }); t.after(m.cleanup);
  await assert.rejects(m.sw.switchTo({ agent: 'helper-b', confirm: yes, stillAllowed: allowed }), /Couldn't record the change, so nothing changed\./);
  assert.deepEqual(m.set, []);
  m = make({ setResult: { success: false, error: 'disk full' } }); t.after(m.cleanup);
  await assert.rejects(m.sw.switchTo({ agent: 'helper-b', confirm: yes, stillAllowed: allowed }), /disk full/);
  assert.deepEqual(m.lines().map((l) => l.state), ['requested', 'failed']);
  assert.deepEqual(m.pushed, []);
  const n = make({ pushThrows: true }); t.after(n.cleanup);
  assert.equal((await n.sw.switchTo({ agent: 'helper-b', confirm: yes, stillAllowed: allowed })).ok, true);
  assert.equal(n.set.length, 1);
});

test('not_now and runTool texts', async (t) => {
  const m = make(); t.after(m.cleanup);
  assert.equal(await runTool(m.sw, { action: 'not_now', agent: 'helper-b' }, 'lead-a'), 'Put aside: helper-b will not be offered claude-sdk/claude-opus-6 again.');
  assert.deepEqual(m.declined, [['helper-b', OFFER.to]]);
  assert.equal(m.lines()[0].state, 'declined');
  assert.match(await runTool(m.sw, { action: 'not_now', agent: 'sam' }), /belongs to a member/);
  const e = make({ declineErr: 'nope' }); t.after(e.cleanup);
  assert.equal(await runTool(e.sw, { action: 'not_now', agent: 'helper-b' }), 'nope');
  assert.equal(await runTool(m.sw, { action: 'switch', agent: 'helper-b' }, 'lead-a', yes, allowed), 'Done. helper-b now uses claude-sdk/claude-opus-6. The owner can undo it on its settings page.');
  assert.equal(TOOL.name, 'model_offer');
});

test('sdk-chat: model_offer is offered only inside the connectorAccessOffered branches on both routes and re-checked at call time', () => {
  const sdk = fs.readFileSync(path.join(ROOT, 'lib', 'sdk-chat.js'), 'utf8');
  const gated = sdk.split('...(connectorAccessOffered(agentName, consultationDepth)').slice(1).map((s) => s.slice(0, 2600));
  assert.equal(gated.length, 2);
  for (const g of gated) assert.match(g.split(': []),')[0], /modelOfferLib\.TOOL\.name/);
  assert.equal((sdk.match(/modelOfferLib\.TOOL\.name/g) || []).length, 3, 'the gateway list once, the SDK list twice (name and extras)');
  const body = sdk.match(/async function runModelOffer\([\s\S]*?\n\}/)[0];
  assert.match(body, /^async function runModelOffer\(agentName, sseRes, args, consultationDepth, signal\) \{\n  if \(!connectorAccessOffered\(agentName, consultationDepth\)\) return CONNECTOR_ACCESS_NOT_OFFERED;/);
  assert.match(body, /options: \[yesLabel, 'Leave as is'\], header: 'Model suggestion', adminOnly: true/);
  assert.match(body, /const stillAllowed = \(\) => connectorAccessOffered\(agentName, consultationDepth\) && !\(signal && signal\.aborted\);/);
  assert.match(sdk, /createModelOfferSwitch\(\{ isBusy: \(n\) => isAgentActive\(n\) \}\)/);
  assert.match(sdk, /temporalWorkers\.modelFacts\(available\)/);
});

test('review: the lead cannot switch its own model during its own turn; nothing asked, logged or changed', async (t) => {
  const m = make(); t.after(m.cleanup);
  let asked = 0;
  const out = await runTool(m.sw, { action: 'switch', agent: 'helper-b' }, 'helper-b', async () => { asked++; return true; }, allowed);
  assert.match(out, /^Your own model can't change while you are answering/);
  assert.equal(asked, 0);
  assert.deepEqual(m.set, []);
  assert.deepEqual(m.lines(), []);
});
