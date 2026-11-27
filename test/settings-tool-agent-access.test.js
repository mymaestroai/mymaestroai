'use strict';
// P4-lead: the lead may change an admin's agent's Access rows (box OPT-0053, shared folders OPT-0017, other folders OPT-0018, command lockbox
// OPT-0054) with the owner's Confirm on a fixed card, in a turn the owner typed. Never at once; a member's agent and a member person stay on the
// screen; the lockbox write is accepted only through the tool's confirm path; folders keep the other roots and overrides and use the compare-and-set.
// Runs against a throwaway install copy (test/helpers/isolated-install.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeIsolatedInstall } = require('./helpers/isolated-install');

const inst = makeIsolatedInstall('stool-acc-', { copy: ['templates/settings-records.json'] });
const L = (m) => require(path.join(inst.lib, m));
const tool = L('settings-tool');
const journal = L('settings-journal');
const records = L('settings-records');
const apply = L('settings-apply');
const agentsLib = L('agents');
const auth = L('auth').getAuth();
const AGENTS_FILE = path.join(inst.data, 'agents.json');

const admin = auth.createUser({ login: 'owner@example.com', name: 'Owner', role: 'admin', password: 'owner-long-password-1' }).user;
const sam = auth.createUser({ login: 'sam@example.com', name: 'Sam', role: 'member', password: 'sam-long-password-1' }).user;
const BASE = [
  { name: 'maestro', model: 'openai/gpt-5.6', display: 'Maestro', category: 'primary', lead: true },
  { name: 'hazel', model: 'openai/gpt-5.6', display: 'Hazel', category: 'specialist', owner: admin.id, policy: { overrides: { web: 'allow' }, roots: ['/tmp/acc-keep'] } },
  { name: 'samagent', model: 'openai/gpt-5.6', display: 'Samagent', category: 'specialist', owner: sam.id },
];
const reset = () => fs.writeFileSync(AGENTS_FILE, JSON.stringify(JSON.parse(JSON.stringify(BASE))));
const agentOf = (n) => JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')).find((a) => a.name === n);
const BOX = 'OPT-0053', SHARED = 'OPT-0017', OTHER = 'OPT-0018', LOCK = 'OPT-0054';
const SHARED_PATH = '/tmp/acc-shared';

let n = 0;
function turn(over = {}) { return { turnId: `acc-t${++n}`, origin: { kind: 'user' }, personKey: admin.id, tainted: false, typed: '', voice: false, ...over }; }
/** Runs one change_setting call; the fake card answers with `answer` (a function of the card args is allowed). Returns { out, cards }. */
async function run(args, { t = turn(), answer = 'Confirm', t2 = null } = {}) {
  const cards = [];
  const st = tool.createSettingsTool({ folders: () => [{ path: SHARED_PATH }] });
  const ctx = {
    agentName: 'maestro', turn: t, stillOffered: () => true, emit: () => {}, onAgentChanged: null,
    ask: async (a) => { cards.push(a); if (typeof answer === 'function') return answer(a); return answer; },
  };
  const out = await st.run(args, ctx);
  return { out, cards, st };
}
const lastEntry = (rec) => journal.list({ limit: 500 }).find((e) => e.record === rec);
const lastPolicyEntry = () => journal.list({ limit: 500 }).find((e) => /policy/.test(String(e.key)));
const restoreOf = (e) => journal.restore(e.id, { user: admin.id, isAdmin: true, isAdminSession: true });

test('the four records carry the marker, keep danger dangerous and lead confirm', () => {
  for (const id of [BOX, SHARED, OTHER, LOCK]) {
    const r = records.byId(id);
    assert.equal(r.leadAgentAccess, true, id);
    assert.equal(r.danger, 'dangerous', id);
    assert.equal(r.lead, 'confirm', id);
  }
});

test('class: confirm for an admin person and an admin-owned agent; screen for a member person, a member agent, no agent, an unknown agent', () => {
  reset();
  const st = tool.createSettingsTool();
  const rec = records.byId(BOX);
  const adminP = { id: String(admin.id), isAdmin: true, user: admin };
  const samP = { id: String(sam.id), isAdmin: false, user: sam };
  assert.equal(st.classOf(rec, adminP, 'hazel'), 'confirm');
  assert.equal(st.classOf(rec, adminP, 'maestro'), 'confirm');
  assert.equal(st.classOf(rec, adminP, 'samagent'), 'screen', 'a member\'s agent');
  assert.equal(st.classOf(rec, samP, 'hazel'), 'screen', 'a member person');
  assert.equal(st.classOf(rec, samP, 'samagent'), 'screen', 'a member person, even for their own agent');
  assert.equal(st.classOf(rec, adminP, undefined), 'screen');
  assert.equal(st.classOf(rec, adminP, 'nobody'), 'screen');
  for (const id of [SHARED, OTHER, LOCK]) assert.equal(st.classOf(records.byId(id), adminP, 'hazel'), 'confirm', id);
});

test('box: unbox shows a fixed card with the looser and the session sentences; Confirm applies; journaled as the lead; Restore puts it back', async () => {
  reset();
  const { out, cards } = await run({ action: 'set', setting: BOX, agent: 'hazel', value: 'off', reason: 'x' });
  assert.match(out, /^Changed /, out);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].fixed, true);
  assert.deepEqual(cards[0].options, ['Confirm', 'Cancel']);
  assert.equal(cards[0].allow_skip, false);
  assert.match(cards[0].change.meaning, /Hazel's commands and file work would run directly on this computer, outside its box\./);
  assert.match(cards[0].change.meaning, /This restarts Hazel's current session\./);
  assert.equal(cards[0].change.restart, true);
  assert.equal(agentOf('hazel').sandbox, 'off');
  const e = lastEntry(BOX);
  assert.equal(e.who.kind, 'lead');
  assert.equal(restoreOf(e).ok, true);
  assert.ok(!agentOf('hazel').sandbox || agentOf('hazel').sandbox === 'inherit', 'restored');
});

test('box: boxing an agent that runs outside a box says so; Cancel writes nothing; then Confirm boxes it', async () => {
  reset();
  const entriesBefore = journal.list({ limit: 500 }).filter((e) => e.who && e.who.kind === 'lead').length;
  const cancelled = await run({ action: 'set', setting: BOX, agent: 'hazel', value: 'container', reason: 'x' }, { answer: 'Cancel' });
  assert.match(cancelled.out, /^Not changed/);
  assert.match(cancelled.cards[0].change.meaning, /^Hazel runs outside a box now; boxing it restarts its session\./);
  assert.equal(agentOf('hazel').sandbox, undefined);
  assert.equal(journal.list({ limit: 500 }).filter((e) => e.who && e.who.kind === 'lead').length, entriesBefore, 'nothing journaled by the lead');
  const ok = await run({ action: 'set', setting: BOX, agent: 'hazel', value: 'in a box', reason: 'x' });
  assert.match(ok.out, /^Changed /, ok.out);
  assert.equal(agentOf('hazel').sandbox, 'container');
  const again = await run({ action: 'set', setting: BOX, agent: 'hazel', value: 'container', reason: 'x' });
  assert.match(again.out, /already/);
  assert.equal(again.cards.length, 0);
});

test('never at once: a typed command that names the setting and the agent, and a turn with outside text, still show the card', async () => {
  reset();
  const typed = turn({ typed: 'Set Keep this agent in a box to off for Hazel.' });
  const a = await run({ action: 'set', setting: BOX, agent: 'hazel', value: 'off', reason: 'x' }, { t: typed, answer: 'Cancel' });
  assert.equal(a.cards.length, 1, 'the card even for a whole typed command');
  const tainted = turn({ typed: 'Turn the box off for Hazel', tainted: true });
  const b = await run({ action: 'set', setting: BOX, agent: 'hazel', value: 'off', reason: 'x' }, { t: tainted, answer: 'Cancel' });
  assert.equal(b.cards.length, 1);
  assert.doesNotMatch(JSON.stringify(b.cards[0]), /taint|outside text|pasted|untrusted/i);
  const voice = turn({ voice: true });
  const c = await run({ action: 'set', setting: BOX, agent: 'hazel', value: 'off', reason: 'x' }, { t: voice, answer: 'Cancel' });
  assert.equal(c.cards.length, 1);
  assert.equal(agentOf('hazel').sandbox, undefined, 'nothing written');
});

test('a member\'s agent and a member person stay on the screen: the answer holds the card row link for that agent only; nothing is written', async () => {
  reset();
  const a = await run({ action: 'set', setting: BOX, agent: 'samagent', value: 'off', reason: 'x' });
  assert.equal(a.cards.length, 0);
  assert.match(a.out, /\(\/#agent-card=samagent&row=OPT-0053\)/);
  assert.doesNotMatch(a.out, /hazel/);
  assert.equal(agentOf('samagent').sandbox, undefined);
  const b = await run({ action: 'set', setting: LOCK, agent: 'hazel', value: 'off', reason: 'x' }, { t: turn({ personKey: sam.id }) });
  assert.equal(b.cards.length, 0);
  assert.match(b.out, /\(\/#agent-card=hazel&row=OPT-0054\)/);
  const c = await run({ action: 'set', setting: BOX, agent: 'samagent', value: 'off', reason: 'x' }, { t: turn({ personKey: sam.id }) });
  assert.equal(c.cards.length, 0);
  assert.equal(agentOf('samagent').sandbox, undefined);
  const st = tool.createSettingsTool();
  const link = st.doorLink(records.byId(SHARED), { name: 'samagent', display: 'Samagent' });
  assert.equal(link, '[Open Samagent\'s settings](/#agent-card=samagent&row=OPT-0017)');
});

test('lockbox: works only through the confirm path; a direct call without the tool\'s proof is refused, forged proofs too', async () => {
  reset();
  const rec = records.byId(LOCK);
  const base = { record: rec, value: 'enforce', agent: 'hazel', user: admin, isAdmin: true, ownSession: false };
  assert.equal(apply.check(base).ok, false, 'no proof');
  assert.equal((await apply.apply(base)).ok, false);
  assert.equal(apply.check({ ...base, internal: { by: 'lead-confirm' } }).ok, false, 'a look-alike object');
  assert.equal(apply.check({ ...base, internal: Object.freeze({ by: 'lead-confirm' }) }).ok, false);
  assert.equal(apply.check({ ...base, internal: true, leadConfirmed: true }).ok, false);
  assert.equal(agentOf('hazel').lockbox, undefined);
  // through the card
  const cancelled = await run({ action: 'set', setting: LOCK, agent: 'hazel', value: 'enforce', reason: 'x' }, { answer: 'Cancel' });
  assert.match(cancelled.out, /^Not changed/);
  assert.equal(agentOf('hazel').lockbox, undefined);
  const ok = await run({ action: 'set', setting: LOCK, agent: 'hazel', value: 'enforce', reason: 'x' });
  assert.match(ok.out, /^Changed /, ok.out);
  assert.equal(agentOf('hazel').lockbox, 'enforce');
  assert.doesNotMatch(ok.cards[0].change.meaning, /restarts/);
  const off = await run({ action: 'set', setting: LOCK, agent: 'hazel', value: 'off', reason: 'x' });
  assert.match(off.cards[0].change.meaning, /^The command lockbox would stop limiting Hazel's commands\./);
  assert.equal(agentOf('hazel').lockbox, 'off');
  const e = lastEntry(LOCK);
  assert.equal(e.who.kind, 'lead');
  assert.equal(restoreOf(e).ok, true, 'Restore of the lockbox goes through settings-apply');
  assert.equal(agentOf('hazel').lockbox, 'enforce');
});

test('lockbox on the member\'s agent through the tool is refused as before (no card, nothing written)', async () => {
  reset();
  const r = await run({ action: 'set', setting: LOCK, agent: 'samagent', value: 'off', reason: 'x' });
  assert.equal(r.cards.length, 0);
  assert.equal(agentOf('samagent').lockbox, undefined);
});

test('folders: add and remove one path keep the other roots and the overrides; the card names the folder; Restore works', async () => {
  reset();
  const add = await run({ action: 'set', setting: OTHER, agent: 'hazel', value: { add: '/tmp/acc-new' }, reason: 'x' });
  assert.match(add.out, /^Changed /, add.out);
  assert.match(add.cards[0].change.meaning, /^Hazel could change files in \/tmp\/acc-new without asking\./);
  assert.match(add.cards[0].change.meaning, /This restarts Hazel's current session\./);
  assert.deepEqual(agentOf('hazel').policy, { overrides: { web: 'allow' }, roots: ['/tmp/acc-keep', '/tmp/acc-new'] });
  const e = lastPolicyEntry();
  assert.equal(e.who.kind, 'lead');
  const rem = await run({ action: 'set', setting: OTHER, agent: 'hazel', value: { remove: '/tmp/acc-keep' }, reason: 'x' });
  assert.match(rem.out, /^Changed /, rem.out);
  assert.deepEqual(agentOf('hazel').policy, { overrides: { web: 'allow' }, roots: ['/tmp/acc-new'] });
  const none = await run({ action: 'set', setting: OTHER, agent: 'hazel', value: { remove: '/tmp/not-there' }, reason: 'x' });
  assert.match(none.out, /not in the list/);
  assert.equal(none.cards.length, 0);
  assert.equal(restoreOf(lastPolicyEntry()).ok, true);
  assert.deepEqual(agentOf('hazel').policy.roots, ['/tmp/acc-keep', '/tmp/acc-new']);
  assert.deepEqual(agentOf('hazel').policy.overrides, { web: 'allow' });
});

test('folders: the shared list takes only the listed paths; a path of 400 characters or more is refused; two values at once are refused', async () => {
  reset();
  const bad = await run({ action: 'set', setting: SHARED, agent: 'hazel', value: { add: '/tmp/acc-not-listed' }, reason: 'x' });
  assert.match(bad.out, /not one of the shared folders/);
  assert.equal(bad.cards.length, 0);
  const good = await run({ action: 'set', setting: SHARED, agent: 'hazel', value: { add: SHARED_PATH }, reason: 'x' });
  assert.match(good.out, /^Changed /, good.out);
  assert.deepEqual(agentOf('hazel').policy.roots, ['/tmp/acc-keep', SHARED_PATH]);
  const long = await run({ action: 'set', setting: OTHER, agent: 'hazel', value: { add: `/${'x'.repeat(400)}` }, reason: 'x' });
  assert.match(long.out, /too long/);
  const two = await run({ action: 'set', setting: OTHER, agent: 'hazel', value: { add: '/a', remove: '/b' }, reason: 'x' });
  assert.match(two.out, /one path at a time/);
  const plain = await run({ action: 'set', setting: OTHER, agent: 'hazel', value: ['/a'], reason: 'x' });
  assert.match(plain.out, /one path at a time/);
});

test('folders: the policy changed while the card was open gives a 409 and writes nothing; apply() reports the status', async () => {
  reset();
  const r = await run({ action: 'set', setting: OTHER, agent: 'hazel', value: { add: '/tmp/acc-late' }, reason: 'x' }, {
    answer: () => {   // another change of the permissions lands (an override only: the roots stay the same) before Confirm is read
      const list = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'));
      list.find((a) => a.name === 'hazel').policy.overrides = { web: 'deny' };
      fs.writeFileSync(AGENTS_FILE, JSON.stringify(list));
      return 'Confirm';
    },
  });
  assert.match(r.out, /^Not changed: the agent changed while the card was open\./, r.out);   // the agent stamp guard comes first; policyIfMatch is the lower layer, below
  assert.deepEqual(agentOf('hazel').policy, { overrides: { web: 'deny' }, roots: ['/tmp/acc-keep'] });
  // the lower layer
  const rec = records.byId(OTHER);
  const stale = { overrides: { web: 'allow' }, roots: ['/tmp/acc-keep'] };
  const w = await apply.apply({ record: rec, value: ['/tmp/acc-keep', '/tmp/acc-x'], agent: 'hazel', user: admin, isAdmin: true, ownSession: false, policyIfMatch: stale });
  assert.equal(w.ok, false);
  assert.equal(w.status, 409);
  const fresh = await apply.apply({ record: rec, value: ['/tmp/acc-keep', '/tmp/acc-x'], agent: 'hazel', user: admin, isAdmin: true, ownSession: false, policyIfMatch: agentOf('hazel').policy });
  assert.equal(fresh.ok, true);
  assert.deepEqual(agentOf('hazel').policy.overrides, { web: 'deny' });
});

test('folders: the roots changed while the card was open give ONE new card made from the roots now', async () => {
  reset();
  let first = true;
  const r = await run({ action: 'set', setting: OTHER, agent: 'hazel', value: { add: '/tmp/acc-two' }, reason: 'x' }, {
    answer: () => {
      if (first) {
        first = false;
        const list = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'));
        list.find((a) => a.name === 'hazel').policy.roots.push('/tmp/acc-concurrent');
        fs.writeFileSync(AGENTS_FILE, JSON.stringify(list));
      }
      return 'Confirm';
    },
  });
  assert.equal(r.cards.length, 2);
  assert.match(r.cards[1].question, /^It is now /);
  assert.match(r.out, /^Changed /, r.out);
  assert.deepEqual(agentOf('hazel').policy.roots, ['/tmp/acc-keep', '/tmp/acc-concurrent', '/tmp/acc-two']);
});

test('the tool description tells the lead about the box, folders and command lockbox with the owner\'s confirm', () => {
  assert.match(tool.DESCRIPTION, /box.*folders.*command lockbox.*confirm/s);
  assert.ok(agentsLib.AGENT_PATCH_FIELDS.includes('lockbox'));
});
