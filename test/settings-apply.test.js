'use strict';
// lib/settings-apply: the one shared way to change a setting. The screens' routes and the lead's settings tool use the same checks and
// the same writers; a refusal writes nothing and journals nothing. Runs against a throwaway install copy (test/helpers/isolated-install.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeIsolatedInstall, REAL } = require('./helpers/isolated-install');

const inst = makeIsolatedInstall('sa-', { copy: ['templates/settings-records.json'] });
const L = (m) => require(path.join(inst.lib, m));
const apply = L('settings-apply');
const journal = L('settings-journal');
const settings = L('settings');
const records = L('settings-records');
const auth = L('auth').createAuth({ dataDir: inst.data, log: () => {} });
const SETTINGS_FILE = path.join(inst.data, 'settings.json');
const AGENTS_FILE = path.join(inst.data, 'agents.json');
const rec = (id) => { const r = records.byId(id); assert.ok(r, `record ${id} exists`); return r; };
const onDisk = () => JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
const entries = () => journal.list({ limit: 500 });

const admin = auth.createUser({ login: 'owner@example.com', name: 'Owner', role: 'admin', password: 'owner-long-password-1' }).user;
const sam = auth.createUser({ login: 'sam@example.com', name: 'Sam', role: 'member', password: 'sam-long-password-1' }).user;
const ravi = auth.createUser({ login: 'ravi@example.com', name: 'Ravi', role: 'member', password: 'ravi-long-password-1' }).user;
fs.writeFileSync(AGENTS_FILE, JSON.stringify([
  { name: 'tester', model: 'openai/gpt-5.6', display: 'Tester', category: 'specialist', owner: sam.id },
  { name: 'other', model: 'openai/gpt-5.6', display: 'Other', category: 'specialist', owner: ravi.id },
]));

// ── target ────────────────────────────────────────────────────────────────
test('target(): a settings, an agent, a prefs, a device, an other and a secret record', () => {
  assert.deepEqual(apply.target(rec('OPT-0381')), { kind: 'settings', path: 'maxContextMessages' });                  // settings.maxContextMessages
  assert.deepEqual(apply.target(rec('OPT-0454')), { kind: 'settings', path: 'cavemanMode' });                         // "settings.cavemanMode (+ localStorage:cavemanMode mirror)": the note is dropped
  assert.deepEqual(apply.target(rec('OPT-0005')), { kind: 'agent', field: 'blurb' });                                 // agents[].blurb
  assert.deepEqual(apply.target(rec('OPT-0031')), { kind: 'agent', field: 'voiceDefaults.interruptSensitivity' });    // a dotted subfield
  assert.deepEqual(apply.target(rec('OPT-0237')), { kind: 'prefs', store: 'users', field: 'theme' });                 // prefs.theme
  assert.deepEqual(apply.target(rec('OPT-0148')), { kind: 'prefs', store: 'users', field: 'timeZone' });              // users[].timeZone
  assert.deepEqual(apply.target(rec('OPT-0467')), { kind: 'prefs', store: 'research', field: 'choice' });             // research-prefs
  assert.deepEqual(apply.target(rec('OPT-0469')), { kind: 'prefs', store: 'notify', scope: 'default', field: 'questions' });
  assert.deepEqual(apply.target(rec('OPT-0475')), { kind: 'prefs', store: 'notify', scope: 'agent', field: 'questions' });
  assert.deepEqual(apply.target(rec('OPT-0119')), { kind: 'device' });                                                // localStorage:sidebarCollapsed
  assert.deepEqual(apply.target(rec('OPT-0074')), { kind: 'screen' });                                                // DELETE /api/agents/:name
  assert.deepEqual(apply.target(rec('OPT-0697')), { kind: 'screen' });                                                // settings.providers.<id>.apiKey: a placeholder is never a path
  assert.deepEqual(apply.target(rec('OPT-0440')), { kind: 'screen' });                                                // one entry of a list: the screen edits the list
  assert.equal(apply.target(rec('OPT-0340')).kind, 'settings');                                                       // a provider key is a settings path, and refused as a secret by check()
  assert.deepEqual(apply.target(null), { kind: 'screen' });
});

test('target(): every record maps to one kind, and each kind is used', () => {
  const count = {};
  for (const r of records.all()) { const k = apply.target(r).kind; count[k] = (count[k] || 0) + 1; }
  assert.equal(Object.values(count).reduce((a, b) => a + b, 0), records.all().length);
  for (const k of ['settings', 'agent', 'prefs', 'device', 'screen']) assert.ok(count[k] > 0, `${k} records: ${JSON.stringify(count)}`);
});

// ── check ─────────────────────────────────────────────────────────────────
test('check(): the keys the bulk route drops are refused (requireAdmin2fa, walletAgents, walletOwner, receiverAliases, backup)', () => {
  for (const id of ['OPT-0298', 'OPT-0966', 'OPT-0967', 'OPT-0968']) {
    const r = apply.check({ record: rec(id), value: true, user: admin, isAdmin: true, ownSession: true });
    assert.equal(r.ok, false, id);
    assert.equal(r.error, 'protected', id);
  }
  const r = apply.check({ record: rec('OPT-0969'), value: { folders: [] }, user: admin, isAdmin: true, ownSession: true });   // settings.backup
  assert.equal(r.ok, false);
});

test('check(): lockboxDefault needs the admin\'s own browser session; with it the value is cleaned', () => {
  const no = apply.check({ record: rec('OPT-0431'), value: 'enforce', user: admin, isAdmin: true, ownSession: false });
  assert.equal(no.ok, false);
  assert.match(no.error, /Sign in with an admin account in your browser to change the command lockbox\./);
  const yes = apply.check({ record: rec('OPT-0431'), value: 'watch', user: admin, isAdmin: true, ownSession: true });
  assert.equal(yes.ok, true);
  assert.equal(yes.value, 'watch');
  const bad = apply.check({ record: rec('OPT-0431'), value: 'sometimes', user: admin, isAdmin: true, ownSession: true });
  assert.equal(bad.ok, false);
});

test('check(): a member cannot change an admin-only agent field or another person\'s agent; an own agent\'s everyday field passes', () => {
  const asMember = (id, agent, value, user = sam) => apply.check({ record: rec(id), value, agent, user, isAdmin: false, ownSession: false });
  const owner = asMember('OPT-0006', 'tester', ravi.id);                                  // agents[].owner: an admin decision
  assert.equal(owner.ok, false);
  assert.match(owner.error, /only an admin can change: owner/);
  const policy = asMember('OPT-0008', 'tester', 'allow');                                 // agents[].policy.overrides.web
  assert.equal(policy.ok, false);
  assert.match(policy.error, /only an admin can change: policy/);
  const other = asMember('OPT-0065', 'other', 50);                                        // maxContextMessages is a member field, but Ravi's agent is not Sam's
  assert.equal(other.ok, false);
  assert.equal(other.error, 'not your agent');
  const own = asMember('OPT-0065', 'tester', 50);
  assert.equal(own.ok, true);
  assert.equal(own.value, 50);
  assert.equal(apply.check({ record: rec('OPT-0005'), value: 'x', agent: 'tester', user: admin, isAdmin: true }).ok, true);
  assert.equal(apply.check({ record: rec('OPT-0005'), value: 'x', agent: 'nobody', user: admin, isAdmin: true }).error, 'no such agent');
});

test('check(): a member changes no setting; a secret record is never changed through it; a device or screen record is not changed here', () => {
  assert.equal(apply.check({ record: rec('OPT-0381'), value: 50, user: sam, isAdmin: false }).error, 'admin');
  for (const id of ['OPT-0340', 'OPT-0482']) {   // a provider key, a web-search key
    assert.deepEqual(apply.check({ record: rec(id), value: 'sk-test-0001', user: admin, isAdmin: true, ownSession: true }), { ok: false, error: 'secret' }, id);
  }
  assert.deepEqual(apply.check({ record: rec('OPT-0119'), value: true, user: admin, isAdmin: true }), { ok: false, error: 'screen' });
  assert.deepEqual(apply.check({ record: rec('OPT-0074'), value: true, user: admin, isAdmin: true }), { ok: false, error: 'screen' });
});

test('check(): a normal value is accepted and cleaned exactly as the route\'s cleaner cleans it', () => {
  const same = (id, key, input) => {
    const viaCheck = apply.check({ record: rec(id), value: input, user: admin, isAdmin: true, ownSession: true });
    const viaRoute = apply.cleanSettingsPatch({ [key]: input }, { ownSession: true });
    assert.equal(viaRoute.errors.length, 0);
    assert.equal(viaCheck.ok, true, JSON.stringify(viaCheck));
    assert.deepEqual(viaCheck.value, viaRoute.patch[key]);
    return viaCheck.value;
  };
  assert.equal(same('OPT-0384', 'researchReminderDays', '30'), 30);             // "30" -> 30
  assert.equal(same('OPT-0382', 'showReasoning', 'whatever'), true);             // on unless false
  assert.equal(same('OPT-0287', 'sidebarTeams', false), false);
  // refused the way the route refuses it
  const r = apply.check({ record: rec('OPT-0384'), value: 999, user: admin, isAdmin: true });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'researchReminderDays must be a whole number of days from 0 to 365');
  // one of the six one-value routes' values: the same limits as POST /api/max_context_messages
  assert.equal(apply.check({ record: rec('OPT-0381'), value: '45', user: admin, isAdmin: true }).value, 45);
  assert.equal(apply.check({ record: rec('OPT-0381'), value: 3, user: admin, isAdmin: true }).error, 'value must be between 5 and 200');
  // a nested path is cleaned inside its object
  assert.equal(apply.check({ record: rec('OPT-0227'), value: true, user: admin, isAdmin: true }).ok, false, 'voice.enabled is changed only by the voice routes');
});

test('check(): prefs use each store\'s own values', () => {
  assert.deepEqual(apply.check({ record: rec('OPT-0237'), value: 'dark', user: sam, isAdmin: false }), { ok: true, value: 'dark' });
  assert.match(apply.check({ record: rec('OPT-0237'), value: 'purple', user: sam, isAdmin: false }).error, /theme must be/);
  assert.equal(apply.check({ record: rec('OPT-0237'), value: 'dark', user: null, isAdmin: false }).error, 'sign in');
  assert.equal(apply.check({ record: rec('OPT-0469'), value: 'away', user: sam, isAdmin: false }).ok, true);
  assert.equal(apply.check({ record: rec('OPT-0469'), value: 'sometimes', user: sam, isAdmin: false }).ok, false);
  assert.equal(apply.check({ record: rec('OPT-0148'), value: 'Not/AZone', user: sam, isAdmin: false }).error, 'unknown time zone');
});

// ── apply ─────────────────────────────────────────────────────────────────
test('apply(): writes one key, journals one entry with the actor given, returns before and after', async () => {
  settings.updateSettings({ maxContextMessages: 40 });
  const seen = new Set(entries().map((e) => e.id));
  const r = await apply.apply({ record: rec('OPT-0381'), value: '60', user: admin, isAdmin: true, ownSession: false, actor: { kind: 'lead', agent: 'maestro', user: admin.id, turn: 't1', why: 'asked to' }, auth });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.before, 40);
  assert.equal(r.after, 60);
  assert.equal(r.restart, false);
  const added = entries().filter((e) => !seen.has(e.id));
  assert.equal(added.length, 1, JSON.stringify(added));
  assert.deepEqual(r.journalIds, [added[0].id]);
  assert.equal(added[0].key, 'maxContextMessages');
  assert.equal(added[0].who.kind, 'lead');
  assert.equal(added[0].who.agent, 'maestro');
  assert.equal(added[0].before, 40);
  assert.equal(added[0].after, 60);
  assert.equal(onDisk().maxContextMessages, 60);
  assert.equal(global.__maxContextMessages, 60, 'the running hub follows');
});

test('apply(): an agent field goes through updateAgentField and is journaled; a member\'s own agent works, another\'s does not', async () => {
  const seen = new Set(entries().map((e) => e.id));
  const r = await apply.apply({ record: rec('OPT-0065'), value: 55, agent: 'tester', user: sam, isAdmin: false, actor: { kind: 'person', user: sam.id }, auth });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.after, 55);
  const added = entries().filter((e) => !seen.has(e.id));
  assert.deepEqual(added.map((e) => e.key), ['agents.tester.maxContextMessages']);
  assert.equal(added[0].who.kind, 'person');
  assert.equal(JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')).find((a) => a.name === 'tester').maxContextMessages, 55);
  // a dotted subfield keeps its siblings
  const v1 = await apply.apply({ record: rec('OPT-0031'), value: 70, agent: 'tester', user: admin, isAdmin: true, actor: { kind: 'person' }, auth });
  assert.equal(v1.ok, true, JSON.stringify(v1));
  const v2 = await apply.apply({ record: rec('OPT-0032'), value: 1.2, agent: 'tester', user: admin, isAdmin: true, actor: { kind: 'person' }, auth });
  assert.equal(v2.ok, true, JSON.stringify(v2));
  const vd = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')).find((a) => a.name === 'tester').voiceDefaults;
  assert.equal(vd.interruptSensitivity, 70);
  assert.equal(vd.voiceSpeed, 1.2);
});

test('apply(): a preference is written by the person\'s own setter and journaled', async () => {
  const seen = new Set(entries().map((e) => e.id));
  const r = await apply.apply({ record: rec('OPT-0237'), value: 'dark', user: sam, isAdmin: false, actor: { kind: 'person', user: sam.id }, auth });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.after, 'dark');
  assert.equal(auth.getUser(sam.id).theme, 'dark');
  const added = entries().filter((e) => !seen.has(e.id));
  assert.deepEqual(added.map((e) => e.key), [`prefs.${sam.id}.theme`]);
  assert.deepEqual(r.journalIds, [added[0].id]);
});

test('apply(): a refused check writes nothing and journals nothing', async () => {
  const filesBefore = fs.readFileSync(SETTINGS_FILE, 'utf8');
  const agentsBefore = fs.readFileSync(AGENTS_FILE, 'utf8');
  const nBefore = entries().length;
  const refusals = [
    { record: rec('OPT-0298'), value: false, user: admin, isAdmin: true, ownSession: true },              // requireAdmin2fa
    { record: rec('OPT-0431'), value: 'enforce', user: admin, isAdmin: true, ownSession: false },         // lockboxDefault without the browser session
    { record: rec('OPT-0340'), value: 'sk-test-0002', user: admin, isAdmin: true, ownSession: true },    // a secret
    { record: rec('OPT-0381'), value: 3, user: admin, isAdmin: true },                                    // out of range
    { record: rec('OPT-0381'), value: 50, user: sam, isAdmin: false },                                    // a member
    { record: rec('OPT-0006'), value: ravi.id, agent: 'tester', user: sam, isAdmin: false },              // an admin-only agent field
    { record: rec('OPT-0065'), value: 50, agent: 'other', user: sam, isAdmin: false },                    // another person's agent
    { record: rec('OPT-0119'), value: true, user: admin, isAdmin: true },                                 // a device record
    { record: rec('OPT-0237'), value: 'purple', user: sam, isAdmin: false },                              // a bad preference
  ];
  for (const a of refusals) {
    const r = await apply.apply({ ...a, actor: { kind: 'lead', agent: 'maestro' }, auth });
    assert.equal(r.ok, false, JSON.stringify(a.record.id));
    assert.ok(r.error);
    assert.equal(r.journalIds, undefined);
  }
  assert.equal(fs.readFileSync(SETTINGS_FILE, 'utf8'), filesBefore);
  assert.equal(fs.readFileSync(AGENTS_FILE, 'utf8'), agentsBefore);
  assert.equal(entries().length, nBefore);
  assert.equal(auth.getUser(sam.id).theme, 'dark');
});

test('G8: apply() returns the ids its own operation recorded, never a concurrent write\'s entry', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const p = apply.apply({ record: rec('OPT-0065'), value: 61, agent: 'tester', user: sam, isAdmin: false, actor: { kind: 'lead', agent: 'maestro', user: sam.id }, auth,
    onAgentChanged: async () => { await gate; } });   // the write is done; the follow-up is still waiting
  await new Promise((r) => setTimeout(r, 5));
  settings.updateSettings({ hubBrief: 'someone else wrote this meanwhile' });   // another request, its own flow
  await journal.withActor({ kind: 'person', user: ravi.id }, () => { settings.updateSettings({ hubBrief: 'and another one' }); });
  release();
  const r = await p;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.journalIds.length, 1, JSON.stringify(r.journalIds));
  const e = journal.get(r.journalIds[0]);
  assert.equal(e.key, 'agents.tester.maxContextMessages'); assert.equal(e.who.kind, 'lead');
  assert.ok(entries().some((x) => x.key === 'hubBrief' && x.after === 'and another one'), 'the other writes are in the journal, just not in this operation\'s ids');
  // a setting and a preference: only their own entries
  const r2 = await apply.apply({ record: rec('OPT-0381'), value: 62, user: admin, isAdmin: true, actor: { kind: 'lead' }, auth });
  assert.deepEqual(r2.journalIds.map((id) => journal.get(id).key), ['maxContextMessages']);
  settings.updateSettings({ hubBrief: undefined });
});

test('S5: apply() on an agent field runs the shared after-change steps (open pages told, container rebuilt for sandbox / policy / tools)', async () => {
  const removed = [];
  apply._setSandboxRemover((a) => removed.push(a.name));
  const events = require(path.join(inst.lib, 'hub-events')).events;
  const seen = [];
  const realPublish = events.publish;
  events.publish = function (name, payload) { if (name === 'agent_updated') seen.push(payload); return realPublish.apply(this, arguments); };
  try {
    const r = await apply.apply({ record: rec('OPT-0053'), value: 'container', agent: 'tester', user: admin, isAdmin: true, actor: { kind: 'lead' }, auth });   // agents[].sandbox
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(removed, ['tester']);
    assert.ok(seen.some((p) => p.agent === 'tester' && p.changed.includes('sandbox')), 'agent_updated is published');
    // the caller's own publish replaces the default event; the container step still runs
    removed.length = 0; seen.length = 0;
    const own = [];
    const r2 = await apply.apply({ record: rec('OPT-0053'), value: 'off', agent: 'tester', user: admin, isAdmin: true, actor: { kind: 'lead' }, auth, onAgentChanged: async (n, f) => { own.push([n, f]); } });
    assert.equal(r2.ok, true);
    assert.deepEqual(own, [['tester', ['sandbox']]]);
    assert.deepEqual(removed, ['tester']);
    assert.equal(seen.length, 0, 'no second event');
    // a plain conversation field does not touch the container
    removed.length = 0;
    await apply.apply({ record: rec('OPT-0065'), value: 66, agent: 'tester', user: admin, isAdmin: true, actor: { kind: 'lead' }, auth });
    assert.deepEqual(removed, []);
  } finally { events.publish = realPublish; apply._setSandboxRemover(null); }
  const src = fs.readFileSync(path.join(REAL, 'server.js'), 'utf8');
  assert.match(src, /settingsApply\.afterAgentChange\(name, body,/, 'the route uses the same function');
});

test('G3 support: apply() hands expectStamp to updateAgentField, so a card for one agent never changes a later agent of the same name', async () => {
  const agentsLib = require(path.join(inst.lib, 'agents'));
  const stamp = agentsLib.agentStamp('tester');
  const nBefore = entries().length;
  const bad = await apply.apply({ record: rec('OPT-0065'), value: 71, agent: 'tester', user: admin, isAdmin: true, actor: { kind: 'lead' }, auth, expectStamp: 'box:some-other-agent' });
  assert.equal(bad.ok, false); assert.match(bad.error, /agent changed/);
  assert.equal(entries().length, nBefore, 'nothing journaled');
  const good = await apply.apply({ record: rec('OPT-0065'), value: 72, agent: 'tester', user: admin, isAdmin: true, actor: { kind: 'lead' }, auth, expectStamp: stamp });
  assert.equal(good.ok, true, JSON.stringify(good));
});

// ── the routes keep their behaviour ───────────────────────────────────────
test('POST /api/settings: a mixed patch gives the saved result the old route gave', () => {
  // What the old route (server.js, before the extraction) did to this patch, written out by hand from reading it:
  //  - backup, walletAgents, walletOwner, requireAdmin2fa and receiverAliases are deleted (with a warning)
  //  - memberPolicy -> sanitizeGrants; approvalClasses -> only known class names, once each
  //  - showReasoning / modelOffers / subscriptionUsage / walletLockedNotice / buildPartnerNotice / sidebarTeams: true unless exactly false
  //  - sidebarTigerTeam / sidebarGuide: true only for a real true
  //  - researchReminderDays: Number, 0..365; researchOfferWaitSeconds: a whole number 0..600 (digits in a string are read)
  //  - researchAgentCaps / researchThorough: each field in its range, merged onto the stored value
  //  - componentUpdates: { codex: auto | notify | off }, anything else is 'auto'
  //  - handOffWaitMinutes: rounded, 0..240; researchHelperSearch: default | both
  //  - anything with no cleaner (maxContextMessages here) is saved as sent
  const warn = console.warn; const warned = []; console.warn = (m) => warned.push(String(m));
  let cleaned;
  try {
    settings.updateSettings({ researchAgentCaps: { install: 7 } });   // stored value the patch merges onto
    const patch = {
      backup: { folders: ['/'] }, walletAgents: ['mallory'], walletOwner: '0xabc', requireAdmin2fa: false, receiverAliases: { a: '/b' },
      memberPolicy: {}, approvalClasses: ['sudo', 'bogus', 'sudo', 'money'],
      showReasoning: 'no', modelOffers: false, subscriptionUsage: 0, walletLockedNotice: false, buildPartnerNotice: false, sidebarTeams: false,
      sidebarTigerTeam: 'yes', sidebarGuide: true,
      researchReminderDays: '7', researchOfferWaitSeconds: ' 30 ',
      researchAgentCaps: { perAgent: '5' }, researchThorough: { maxSources: '12', pdf: true, engine: 'pipeline' },
      componentUpdates: { codex: 'weird' }, handOffWaitMinutes: '15.4', researchHelperSearch: 'both',
      maxContextMessages: 45,
    };
    cleaned = apply.cleanSettingsPatch(patch, { ownSession: false });
    assert.deepEqual(cleaned.errors, []);
    settings.updateSettings(cleaned.patch);   // what the route does next
  } finally { console.warn = warn; }
  assert.equal(warned.length, 5, 'one warning per dropped key');
  const s = onDisk();
  for (const k of ['backup', 'walletAgents', 'walletOwner', 'requireAdmin2fa', 'receiverAliases']) assert.ok(!(k in s), `${k} is not saved`);
  const expected = {
    memberPolicy: {}, approvalClasses: ['sudo', 'money'],
    showReasoning: true, modelOffers: false, subscriptionUsage: true, walletLockedNotice: false, buildPartnerNotice: false, sidebarTeams: false,
    sidebarTigerTeam: false, sidebarGuide: true,
    researchReminderDays: 7, researchOfferWaitSeconds: 30,
    researchAgentCaps: { install: 7, perAgent: 5 }, researchThorough: { maxSources: 12, pdf: true, engine: 'pipeline' },
    componentUpdates: { codex: 'auto' }, handOffWaitMinutes: 15, researchHelperSearch: 'both',
    maxContextMessages: 45,
  };
  for (const [k, v] of Object.entries(expected)) assert.deepEqual(s[k], v, k);
});

test('POST /api/settings: the refusals keep their status and words', () => {
  const warn = console.warn; console.warn = () => {};
  try {
    const look = apply.cleanSettingsPatch({ lookDefaultForNewMembers: 'nope' }, { ownSession: true });
    assert.equal(look.status, 400);
    assert.match(look.errors[0], /^lookDefaultForNewMembers must be one of: /);
    const lock = apply.cleanSettingsPatch({ lockboxDefault: 'enforce' }, { ownSession: false });
    assert.equal(lock.status, 403);
    assert.equal(lock.errors[0], 'Sign in with an admin account in your browser to change the command lockbox.');
    const caps = apply.cleanSettingsPatch({ researchAgentCaps: { bogus: 1 } }, { ownSession: true });
    assert.deepEqual([caps.status, caps.errors[0]], [400, 'researchAgentCaps.bogus is not a setting']);
    const thorough = apply.cleanSettingsPatch({ researchThorough: { maxSources: 99 } }, { ownSession: true });
    assert.equal(thorough.errors[0], 'researchThorough.maxSources must be a whole number from 1 to 40');
    const chg = apply.cleanSettingsPatch({ lockboxDefault: 'watch' }, { ownSession: true, who: 'Owner', getSetting: () => 'off' });
    assert.equal(chg.lockboxChange, 'Command lockbox hub default: off -> watch (by Owner)');
    assert.equal(apply.cleanSettingsPatch(null, {}).patch, null, 'a non-object patch passes through, as it did');
  } finally { console.warn = warn; }
  const src = fs.readFileSync(path.join(REAL, 'server.js'), 'utf8');
  assert.match(src, /require\('\.\/lib\/settings-apply'\)\.cleanSettingsPatch\(patch,/);
  assert.match(src, /settingsApply\.agentFieldAllowed\(body,/);
  assert.match(src, /require\('\.\/lib\/settings-apply'\)\.setGlobalSetting\('maxCompletionTokens', body\.value\)/);
});

test('the one-value routes: each sets its global and writes only its own key', () => {
  const seen = new Set(entries().map((e) => e.id));
  const before = onDisk();
  assert.deepEqual(apply.setGlobalSetting('cavemanMode', true), { ok: true, value: true });
  assert.equal(global.__cavemanMode, true);
  const after = onDisk();
  assert.equal(after.cavemanMode, true);
  for (const k of ['prescanTools', 'confirmTools', 'lazyTools', 'maxCompletionTokens']) assert.equal(after[k], before[k], `${k} was not rewritten`);
  assert.deepEqual(entries().filter((e) => !seen.has(e.id)).map((e) => e.key), ['cavemanMode']);
  assert.deepEqual(apply.setGlobalSetting('maxCompletionTokens', '100'), { ok: false, error: 'value must be between 256 and 128000' });
  assert.deepEqual(apply.setGlobalSetting('maxContextMessages', 201), { ok: false, error: 'value must be between 5 and 200' });
  assert.deepEqual(apply.setGlobalSetting('maxCompletionTokens', '4096'), { ok: true, value: 4096 });
  assert.equal(global.__maxCompletionTokens, 4096);
  assert.deepEqual(apply.setGlobalSetting('lazyTools', 0), { ok: true, value: false });
  assert.equal(global.__lazyToolsEnabled, false);
});

test('agentFieldAllowed(): the guards of PATCH /api/agents/:name, in the route\'s order', () => {
  const person = (o = {}) => ({ service: false, token: false, user: admin, isAdmin: true, isOwner: false, pendingTotp: false, ownSession: false, ...o });
  const f = apply.agentFieldAllowed;
  assert.deepEqual(f({ recordings: {} }, person()), { ok: false, status: 403, error: 'only the owner can change: recordings' });
  assert.equal(f({ recordings: {} }, person({ isOwner: true })).ok, true);
  assert.equal(f({ recordings: {} }, person({ isOwner: true, token: true })).ok, false);
  assert.equal(f({ envKeep: [] }, person({ service: true })).error, 'only an admin can change: envKeep');
  assert.equal(f({ envKeep: [] }, person()).ok, true);
  assert.equal(f({ reportsTo: 'x' }, person({ isAdmin: false, user: sam })).error, 'reportsTo is set by an admin or through the team tool');
  assert.equal(f({ lockbox: 'off' }, person()).status, 403);
  assert.equal(f({ lockboxEnv: [] }, person({ ownSession: true })).ok, true);
  assert.equal(f({ blurb: 'x', tier: 'fast' }, person({ isAdmin: false, user: sam })).error, 'only an admin can change: tier');
  assert.equal(f({ blurb: 'x' }, person({ isAdmin: false, user: sam })).ok, true);
  assert.equal(f({ tier: 'fast' }, { service: true, user: null }).ok, true, 'the hub itself passes the member rule');
  assert.equal(f(null, person()).ok, true);
});
