'use strict';
// The one card for features that arrive switched off: snooze, card data (lib/feature-card), quiet entries, the lead's recommendation
// (behaviour_change action "recommend", only in the hub's own review turn), and the journal (every decision shows under Recent changes;
// Restore needs the owner's own browser session). A throwaway install and temp folders: nothing under the real data/ is read or written.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeIsolatedInstall, REAL } = require('./helpers/isolated-install');

const ISO = makeIsolatedInstall('feature-card-', { copy: ['templates/behaviour-changes.json'] });
const L = (p) => require(path.join(ISO.inst, 'lib', p));
const bc = L('behaviour-changes');
const card = L('feature-card');
const sj = L('settings-journal');
const access = L('access');
const { createBehaviourSwitch, runTool } = L('behaviour-switch');
const read = (f) => fs.readFileSync(path.join(REAL, f), 'utf8');

const temps = [];
const tempDir = () => { const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'feature-card-t-')); temps.push(d); return d; };
after(() => { for (const d of temps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const DAY = 24 * 3600 * 1000;
const MANIFEST = [
  { id: 'alpha', leadMay: true, title: 'Alpha', changes: 'Alpha does a thing. And a second sentence.', benefits: 'b', costs: 'It costs a little. More words follow.', check: 'c', on: 'Agents get alpha. Then more.', off: 'f' },
  { id: 'beta-two', leadMay: false, title: 'Beta', changes: 'Beta spends money', benefits: 'b', costs: 'It spends. Really.', check: 'c', on: 'o', off: 'f' },
  { id: 'quiet-one', leadMay: true, quiet: true, title: 'Quiet one', changes: 'Quiet one tidies up. Nothing else.', benefits: 'b', costs: 'Nothing.', check: 'c', on: 'Quiet one tidies up. Nothing else.', off: 'f' },
  { id: 'quiet-risky', leadMay: false, quiet: true, title: 'Quiet but owner only', changes: 'Quiet risky touches limits. Careful.', benefits: 'b', costs: 'Spends.', check: 'c', on: 'o', off: 'f' },
];
// A folder with the manifest, the state file (named like the real one: Restore finds it beside the journal) and an agents file.
function setup(manifest = MANIFEST) {
  const d = tempDir();
  const manifestFile = path.join(d, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify({ changes: manifest }));
  return { d, manifestFile, stateFile: path.join(d, 'behaviour-reviews.json'), agentsFile: path.join(d, 'agents.json'), o: { stateFile: path.join(d, 'behaviour-reviews.json'), manifestFile } };
}
const existing = (s) => { fs.writeFileSync(s.agentsFile, '[]'); return bc.migrate({ agentsFile: s.agentsFile, stateFile: s.stateFile, manifestFile: s.manifestFile }); };
const st = (s) => bc.readState(s.stateFile).entries;
const T0 = Date.parse('2026-11-26T12:00:00.000Z');

// ── firstSentence ──
test('firstSentence: ends at ". " or at the end of the text; trims; empty for no text', () => {
  assert.strictEqual(card.firstSentence('One. Two.'), 'One.');
  assert.strictEqual(card.firstSentence('Only one sentence'), 'Only one sentence');
  assert.strictEqual(card.firstSentence('  Padded text.  Next.'), 'Padded text.');
  assert.strictEqual(card.firstSentence('Ends with a stop.'), 'Ends with a stop.');
  assert.strictEqual(card.firstSentence('Version 1.5 is used. Then more.'), 'Version 1.5 is used.');
  assert.strictEqual(card.firstSentence(''), '');
  assert.strictEqual(card.firstSentence(undefined), '');
  assert.strictEqual(card.firstSentence(42), '');
});

// ── snooze ──
test('snooze: a pending entry stays pending, snoozedUntil is now + 7 days, snoozedBy is the person; other bookkeeping survives', async () => {
  const s = setup(); existing(s);
  await bc.setEntryField('alpha', 'reviewTask', 'task-1', s.o);
  const r = await bc.snooze('alpha', { user: 'u1', now: T0, ...s.o });
  assert.strictEqual(r.state, 'pending');
  const e = st(s).alpha;
  assert.deepStrictEqual([e.state, e.by, e.snoozedBy, e.reviewTask], ['pending', 'update', 'u1', 'task-1']);
  assert.strictEqual(e.snoozedUntil, new Date(T0 + 7 * DAY).toISOString());
  const l = bc.list(s.o).find((c) => c.id === 'alpha');
  assert.strictEqual(l.snoozedUntil, e.snoozedUntil, 'list() carries it');
  assert.strictEqual(bc.list(s.o).find((c) => c.id === 'beta-two').snoozedUntil, undefined);
});
test('snooze: a decided entry is refused (already decided); an unknown id is refused; an unreadable file is never overwritten', async () => {
  const s = setup(); existing(s);
  await bc.decide('alpha', 'on', { user: 'u1', ...s.o });
  await assert.rejects(bc.snooze('alpha', { user: 'u1', ...s.o }), /already decided/);
  await assert.rejects(bc.snooze('nope', { user: 'u1', ...s.o }), /no such change/);
  fs.writeFileSync(s.stateFile, '{broken');
  await assert.rejects(bc.snooze('beta-two', { user: 'u1', ...s.o }));
  assert.strictEqual(fs.readFileSync(s.stateFile, 'utf8'), '{broken');
});
test('snooze: a later on or off decision clears snoozedUntil and snoozedBy; the bookkeeping fields stay', async () => {
  for (const decision of ['on', 'off']) {
    const s = setup(); existing(s);
    await bc.setEntryField('alpha', 'reviewTask', 'task-1', s.o);
    await bc.snooze('alpha', { user: 'u1', now: T0, ...s.o });
    await bc.decide('alpha', decision, { user: 'u2', ...s.o });
    const e = st(s).alpha;
    assert.deepStrictEqual([e.state, e.snoozedUntil, e.snoozedBy, e.reviewTask, e.user], [decision, undefined, undefined, 'task-1', 'u2']);
  }
});
test('snooze: two at once and a decision at once all land in a readable file', async () => {
  const s = setup(); existing(s);
  await Promise.all([bc.snooze('alpha', { user: 'u1', ...s.o }), bc.decide('beta-two', 'off', { user: 'u1', ...s.o })]);
  assert.deepStrictEqual([st(s).alpha.state, st(s)['beta-two'].state], ['pending', 'off']);
  assert.ok(st(s).alpha.snoozedUntil);
});

// ── cardState ──
const deps = { leads: () => ['maestro'], agents: [{ name: 'maestro', display: 'Maestro the lead', category: 'primary', lead: true }], adminIds: [] };
test('cardState: the summary is what turning it on does (the first sentence of `on`), else the first sentence of `changes`', () => {
  const s = setup(); existing(s);
  const raw = JSON.parse(fs.readFileSync(s.o.manifestFile, 'utf8'));
  raw.changes.find((e) => e.id === 'beta-two').on = '';
  fs.writeFileSync(s.o.manifestFile, JSON.stringify(raw));
  const c = card.cardState({ ...s.o, deps, now: T0 });
  assert.strictEqual(c.entries.find((e) => e.id === 'alpha').summary, 'Agents get alpha.');
  assert.strictEqual(c.entries.find((e) => e.id === 'beta-two').summary, 'Beta spends money');
});

test('cardState: only pending entries (decided ones are not on it); summary and cost are the first sentences', () => {
  const s = setup(); existing(s);
  const c = card.cardState({ ...s.o, deps, now: T0 });
  assert.strictEqual(c.ok, true);
  assert.deepStrictEqual(c.entries.map((e) => e.id), ['alpha', 'beta-two', 'quiet-risky']);
  const a = c.entries[0];
  assert.deepStrictEqual(Object.keys(a).sort(), ['canSwitch', 'cost', 'id', 'leadMay', 'recommendation', 'rev', 'summary', 'title']);
  assert.deepStrictEqual([a.title, a.summary, a.cost, a.leadMay, a.recommendation], ['Alpha', 'Agents get alpha.', 'It costs a little.', true, null]);
  assert.strictEqual(c.entries[1].leadMay, false);
  assert.strictEqual(c.show, true);
});
test('cardState: a snoozed entry is hidden, an expired snooze brings it back, and it can be snoozed again', async () => {
  const s = setup(); existing(s);
  await bc.snooze('alpha', { user: 'u1', now: T0, ...s.o });
  assert.ok(!card.cardState({ ...s.o, deps, now: T0 + 1000 }).entries.some((e) => e.id === 'alpha'));
  assert.ok(!card.cardState({ ...s.o, deps, now: T0 + 7 * DAY - 1 }).entries.some((e) => e.id === 'alpha'));
  assert.ok(card.cardState({ ...s.o, deps, now: T0 + 7 * DAY }).entries.some((e) => e.id === 'alpha'), 'expired: back on the card');
  await bc.snooze('alpha', { user: 'u1', now: T0 + 8 * DAY, ...s.o });
  assert.ok(!card.cardState({ ...s.o, deps, now: T0 + 8 * DAY + 1 }).entries.some((e) => e.id === 'alpha'));
});
test('cardState: show is false when nothing is pending and no notice; true for a notice alone', async () => {
  const s = setup([MANIFEST[0], MANIFEST[2]]); existing(s);
  await bc.decide('alpha', 'off', { user: 'u1', ...s.o });
  let c = card.cardState({ ...s.o, deps, now: T0 });
  assert.deepStrictEqual([c.entries.length, c.notices.length, c.show], [0, 1, true]);
  await bc.markSeen('quiet-one', { user: 'u1', ...s.o });
  c = card.cardState({ ...s.o, deps, now: T0 });
  assert.deepStrictEqual([c.entries.length, c.notices.length, c.show], [0, 0, false]);
});
test('cardState: the lead is found (name and display name), null when there is none', () => {
  const s = setup(); existing(s);
  const c = card.cardState({ ...s.o, deps, now: T0 });
  assert.deepStrictEqual([c.lead, c.leadDisplay], ['maestro', 'Maestro the lead']);
  const n = card.cardState({ ...s.o, deps: { leads: () => [], agents: [] }, now: T0 });
  assert.deepStrictEqual([n.lead, n.leadDisplay], [null, null]);
  const bare = card.cardState({ ...s.o, deps: { leads: () => ['maestro'], agents: [{ name: 'maestro' }] }, now: T0 });
  assert.deepStrictEqual([bare.lead, bare.leadDisplay], ['maestro', 'Maestro']);
});
test('cardState: an unreadable state file shows nothing (never a guess)', () => {
  const s = setup(); fs.writeFileSync(s.stateFile, '{broken');
  const c = card.cardState({ ...s.o, deps, now: T0 });
  assert.deepStrictEqual([c.entries, c.notices, c.show], [[], [], false]);
});

// ── quiet entries ──
test('migrate: quiet + leadMay true is seeded on by quiet-update; quiet + leadMay false and the others are pending', () => {
  const s = setup();
  const r = existing(s);
  assert.deepStrictEqual(r.added, ['alpha', 'beta-two', 'quiet-risky'], 'added = the ones waiting');
  assert.deepStrictEqual(r.quiet, ['quiet-one']);
  const e = st(s);
  assert.deepStrictEqual([e['quiet-one'].state, e['quiet-one'].by], ['on', 'quiet-update']);
  assert.strictEqual(e['quiet-risky'].state, 'pending');
  assert.strictEqual(e.alpha.state, 'pending');
  assert.strictEqual(bc.isOn('quiet-one', s.o), true);
});
test('quiet notice: one line until acknowledged; seen records noticeSeenAt; off keeps it; quiet + leadMay false is on the card as an entry, not a notice', async () => {
  const s = setup(); existing(s);
  let c = card.cardState({ ...s.o, deps, now: T0 });
  assert.deepStrictEqual(c.notices, [{ id: 'quiet-one', title: 'Quiet one', line: 'Quiet one tidies up.', rev: 'on' }]);
  assert.ok(c.entries.some((e) => e.id === 'quiet-risky'));
  assert.ok(!c.entries.some((e) => e.id === 'quiet-one'));
  await bc.markSeen('quiet-one', { user: 'u1', now: T0, ...s.o });
  assert.strictEqual(st(s)['quiet-one'].noticeSeenAt, new Date(T0).toISOString());
  assert.strictEqual(st(s)['quiet-one'].state, 'on');
  assert.deepStrictEqual(card.cardState({ ...s.o, deps, now: T0 }).notices, []);
  await bc.decide('quiet-one', 'off', { user: 'u1', ...s.o });
  assert.strictEqual(st(s)['quiet-one'].state, 'off');
  assert.ok(st(s)['quiet-one'].noticeSeenAt, 'the acknowledgement survives a decision');
  await assert.rejects(bc.markSeen('alpha', { user: 'u1', ...s.o }), /not decided yet/);
  await assert.rejects(bc.markSeen('nope', { user: 'u1', ...s.o }), /no such change/);
});
test('quiet notice: the owner can turn it off before seeing it, and the notice goes', async () => {
  const s = setup(); existing(s);
  await bc.decide('quiet-one', 'off', { user: 'u1', ...s.o });
  assert.deepStrictEqual(card.cardState({ ...s.o, deps, now: T0 }).notices, []);
});
test('the shipped manifest: no entry is quiet today, and _about documents the field', () => {
  const doc = JSON.parse(read('templates/behaviour-changes.json'));
  assert.ok(doc.changes.length > 0);
  for (const e of doc.changes) assert.strictEqual(e.quiet, undefined, e.id);
  assert.match(doc._about, /quiet/);
});

// ── recommend ──
const REVIEW_TURN = { kind: 'schedule', by: '@hub', taskId: 'task-9' };
async function withReview(s) { await bc.markReviewed(['alpha', 'beta-two'], 'task-9', s.o); }
function sw(s, extra = {}) { return createBehaviourSwitch({ changes: () => ({ list: () => bc.list(s.o), decide: (id, d, o) => bc.decide(id, d, { ...o, ...s.o }), recommend: (id, r, w, o) => bc.recommend(id, r, w, { ...o, ...s.o }) }), agents: () => [], auditFile: path.join(s.d, 'audit.jsonl'), push: () => ({ notify() {} }), afterChange: async () => {}, ...extra }); }
test('recommend: stored in the review turn (any entry, leadMay false too), never changes the state', async () => {
  const s = setup(); existing(s); await withReview(s);
  const out = await runTool(sw(s), { action: 'recommend', id: 'beta-two', recommend: 'off', why: 'It spends money you have not planned for.' }, 'maestro', null, null, REVIEW_TURN);
  assert.match(out, /Recorded/);
  const e = st(s)['beta-two'];
  assert.deepStrictEqual([e.state, e.recommend, e.recommendWhy], ['pending', 'off', 'It spends money you have not planned for.']);
  assert.ok(!isNaN(Date.parse(e.recommendAt)));
  await runTool(sw(s), { action: 'recommend', id: 'alpha', recommend: 'on', why: 'Fits.' }, 'maestro', null, null, REVIEW_TURN);
  assert.strictEqual(st(s).alpha.state, 'pending');
  const c = card.cardState({ ...s.o, deps, now: T0 });
  assert.deepStrictEqual(c.entries.find((x) => x.id === 'alpha').recommendation, { decision: 'on', why: 'Fits.' });
  assert.deepStrictEqual(c.entries.find((x) => x.id === 'beta-two').recommendation, { decision: 'off', why: 'It spends money you have not planned for.' });
});
test('recommend: refused outside the review turn, with a plain sentence, and nothing is written', async () => {
  const s = setup(); existing(s); await withReview(s);
  const args = { action: 'recommend', id: 'alpha', recommend: 'on', why: 'x' };
  for (const turn of [undefined, null, { kind: 'user' }, { kind: 'schedule', by: '@hub', taskId: 'other-task' }, { kind: 'schedule', by: 'someone', taskId: 'task-9' }, { kind: 'job', by: '@hub', taskId: 'task-9' }, { kind: 'schedule', by: '@hub' }]) {
    const out = await runTool(sw(s), args, 'maestro', null, null, turn);
    assert.match(out, /only in the hub's own review turn/, JSON.stringify(turn));
  }
  assert.strictEqual(st(s).alpha.recommend, undefined);
});
test('recommend: bad input is refused (decision, id, why over 200 characters or empty); a decided entry is refused', async () => {
  const s = setup(); existing(s); await withReview(s);
  const run = (a) => runTool(sw(s), { action: 'recommend', id: 'alpha', recommend: 'on', why: 'ok', ...a }, 'maestro', null, null, REVIEW_TURN);
  assert.match(await run({ recommend: 'maybe' }), /on or off/);
  assert.match(await run({ id: 'nope' }), /No behaviour change/);
  assert.match(await run({ why: 'x'.repeat(201) }), /200 characters/);
  assert.match(await run({ why: '   ' }), /one sentence/);
  assert.strictEqual(st(s).alpha.recommend, undefined);
  await bc.decide('alpha', 'on', { user: 'u1', ...s.o });
  assert.match(await run({}), /already decided/);
});
test('recommend: the recommendation survives a decision and the other bookkeeping writes', async () => {
  const s = setup(); existing(s); await withReview(s);
  await bc.recommend('alpha', 'on', 'Good.', s.o);
  await bc.setEntryField('alpha', 'proposalsTask', 'p1', s.o);
  await bc.snooze('alpha', { user: 'u1', now: T0, ...s.o });
  assert.strictEqual(st(s).alpha.recommend, 'on');
  await bc.decide('alpha', 'off', { user: 'u1', ...s.o });
  const e = st(s).alpha;
  assert.deepStrictEqual([e.state, e.recommend, e.recommendWhy, e.proposalsTask, e.reviewTask], ['off', 'on', 'Good.', 'p1', 'task-9']);
  assert.ok(e.recommendAt);
});
test('recommend: in the review turn the other actions stay with the owner (on and off are refused there)', async () => {
  const s = setup(); existing(s);
  const out = await runTool(sw(s), { action: 'on', id: 'alpha' }, 'maestro', async () => true, () => true, REVIEW_TURN);
  assert.match(out, /Switch nothing in this turn|only when the owner asks/);
  assert.strictEqual(st(s).alpha.state, 'pending');
});
test('sdk-chat wiring: the tool is also offered in the hub review turn only for recommend/list, and the origin is the in-process one', () => {
  const sdk = read('lib/sdk-chat.js');
  assert.match(sdk, /function behaviourReviewTurn\(agentName, consultationDepth\)/);
  const fn = sdk.match(/function behaviourReviewTurn\([\s\S]*?\n\}/)[0];
  assert.match(fn, /origin\.kind !== 'schedule'/);
  assert.match(fn, /origin\.by !== scheduledTasks\.HUB/);
  assert.match(fn, /consultationDepth !== 0/);
  assert.match(fn, /ownerLeadNames\(\)\.includes\(agentName\)/);
  const body = sdk.match(/async function runBehaviourSwitch\([\s\S]*?\n\}/)[0];
  assert.match(body, /behaviourReviewTurn\(agentName, consultationDepth\)/);
  assert.match(body, /runTool\(behaviourSwitchLib\.getBehaviourSwitch\(\), args, agentName, confirm, stillAllowed, /);
  assert.ok(read('server.js').includes("const HUB_ONLY_CHAT_FIELDS = ['image_files', 'consulted_by', 'origin', 'owner_turn']"), 'a browser can never send an origin');
});

// ── journal ──
const entriesOf = (s) => sj.forDir(s.d).list({ limit: 100 }).filter((e) => e.store === 'behaviour');
const asPerson = (user, fn) => sj.withActor({ kind: 'person', user }, fn);
test('journal: on, off, snooze and seen each show under Recent changes with the person who pressed', async () => {
  const s = setup(); existing(s);
  await asPerson('sam', () => bc.decide('alpha', 'on', { user: 'sam', ...s.o }));
  await asPerson('sam', () => bc.decide('alpha', 'off', { user: 'sam', ...s.o }));
  await asPerson('sam', () => bc.snooze('beta-two', { user: 'sam', now: T0, ...s.o }));
  await asPerson('owner', () => bc.markSeen('quiet-one', { user: 'owner', now: T0, ...s.o }));
  const list = entriesOf(s);
  assert.strictEqual(list.length, 4);
  const [seen, snooze, off, on] = list;
  assert.deepStrictEqual([on.key, on.before, on.after, on.who], ['behaviour.alpha', 'pending', 'on', { kind: 'person', user: 'sam' }]);
  assert.deepStrictEqual([off.before, off.after], ['on', 'off']);
  assert.deepStrictEqual([snooze.key, snooze.before, snooze.after], ['behaviour.beta-two', 'pending', `snoozed until ${new Date(T0 + 7 * DAY).toISOString()}`]);
  assert.deepStrictEqual([seen.key, seen.who.user], ['behaviour.quiet-one', 'owner']);
  assert.match(seen.after, /^on, seen /);
  for (const e of list) assert.strictEqual(e.restorable, true);
  assert.match(sj.viewEntry(on).name, /^Changes to how agents behave: /);
  const real = bc.manifest()[0];   // the install's own manifest names a change by its title
  const [one] = sj.forDir(s.d).recordChange('behaviour', [{ key: `behaviour.${real.id}`, before: 'pending', after: 'on' }]);
  assert.strictEqual(sj.viewEntry(one).name, `Changes to how agents behave: ${real.title}`);
});
test('journal: a change that is not a change is not journaled (deciding the same value again)', async () => {
  const s = setup(); existing(s);
  await bc.decide('alpha', 'on', { user: 'sam', ...s.o });
  await bc.decide('alpha', 'on', { user: 'sam', ...s.o });
  assert.strictEqual(entriesOf(s).length, 1);
});
test('journal: a failed write is not recorded and the error goes on', async () => {
  const s = setup(); existing(s);
  fs.chmodSync(s.d, 0o500);
  try { await bc.decide('alpha', 'on', { user: 'sam', ...s.o }); } catch { /* may fail on a read-only folder */ } finally { fs.chmodSync(s.d, 0o700); }
  assert.strictEqual(st(s).alpha.state, 'pending');
  assert.strictEqual(entriesOf(s).length, 0);
});
test('Restore: a decision goes back to pending (and an off back to on) through the owner\'s own session', async () => {
  const s = setup(); existing(s);
  await asPerson('sam', () => bc.decide('alpha', 'on', { user: 'sam', ...s.o }));
  await asPerson('sam', () => bc.decide('alpha', 'off', { user: 'sam', ...s.o }));
  const j = sj.forDir(s.d);
  const [off, on] = entriesOf(s);
  let r = j.restoreFor(off.id, { user: 'sam', isAdmin: true, isAdminSession: true });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(st(s).alpha.state, 'on');
  r = j.restoreFor(on.id, { user: 'sam', isAdmin: true, isAdminSession: true });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(st(s).alpha.state, 'pending');
  assert.strictEqual(st(s).alpha.by, 'update');
  assert.ok(card.cardState({ ...s.o, deps, now: T0 }).entries.some((e) => e.id === 'alpha'), 'back on the card');
  const restored = sj.forDir(s.d).list({ limit: 100 }).filter((e) => e.store === 'behaviour' && e.who.kind === 'restore');
  assert.strictEqual(restored.length, 2, 'a restore is journaled too');
});
test('Restore: a snooze goes back to pending without the snooze', async () => {
  const s = setup(); existing(s);
  await asPerson('sam', () => bc.snooze('alpha', { user: 'sam', now: T0, ...s.o }));
  const [e] = entriesOf(s);
  const r = sj.forDir(s.d).restoreFor(e.id, { user: 'sam', isAdmin: true, isAdminSession: true });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual([st(s).alpha.state, st(s).alpha.snoozedUntil, st(s).alpha.snoozedBy], ['pending', undefined, undefined]);
});
test('Restore: refused without the owner\'s own browser session (token, agent, hub service), for every behaviour entry', async () => {
  const s = setup(); existing(s);
  await asPerson('sam', () => bc.decide('alpha', 'on', { user: 'sam', ...s.o }));
  await asPerson('sam', () => bc.decide('quiet-one', 'off', { user: 'sam', ...s.o }));
  await asPerson('sam', () => bc.snooze('beta-two', { user: 'sam', now: T0, ...s.o }));
  const j = sj.forDir(s.d);
  const list = entriesOf(s);
  assert.strictEqual(list.length, 3);
  for (const e of list) {
    const r = j.restoreFor(e.id, { user: 'token:t1', isAdmin: true, isAdminSession: false });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.status, 403, e.key);
    assert.strictEqual(j.restore(e.id, {}).status, 403, 'the hub service');
    // a member never restores a behaviour decision either
    assert.strictEqual(j.restoreFor(e.id, { user: 'u-member', isAdmin: false, isAdminSession: false }).status, 403);
  }
  assert.deepStrictEqual([st(s).alpha.state, st(s)['quiet-one'].state, st(s)['beta-two'].state], ['on', 'off', 'pending']);
  assert.strictEqual(st(s)['beta-two'].snoozedBy, 'sam');
});
test('Restore: refused when it changed since (a later decision), and a member does not see behaviour entries', async () => {
  const s = setup(); existing(s);
  await asPerson('sam', () => bc.decide('alpha', 'on', { user: 'sam', ...s.o }));
  const [on] = entriesOf(s);
  await asPerson('sam', () => bc.decide('alpha', 'off', { user: 'sam', ...s.o }));
  const j = sj.forDir(s.d);
  const r = j.restoreFor(on.id, { user: 'sam', isAdmin: true, isAdminSession: true });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(st(s).alpha.state, 'off');
  assert.deepStrictEqual(j.listFor({ user: 'u-member', isAdmin: false }).filter((e) => e.store === 'behaviour'), []);
});
test('journal: the start-up reconcile settles a pending behaviour entry from the state file', async () => {
  const s = setup(); existing(s);
  const j = sj.forDir(s.d);
  const e = j.recordChange('behaviour', [{ key: 'behaviour.alpha', before: 'pending', after: 'on' }], { actor: { kind: 'person', user: 'sam' }, pending: true });
  await bc.decide('alpha', 'on', { user: 'sam', ...s.o });   // the write happened, the commit did not
  const r = j.reconcile();
  assert.ok(r.committed >= 1 || r.failed === 0);
  assert.ok(entriesOf(s).some((x) => x.after === 'on'));
  assert.strictEqual(e.length, 1);
});

// ── routes ──
test('routes: the card is admin only (a member gets 403 as today); snooze, seen and the decisions take the owner\'s own session only', () => {
  assert.deepStrictEqual(access.classifyRoute('/api/behaviour-changes/card', 'GET'), { kind: 'admin' });
  assert.deepStrictEqual(access.classifyRoute('/api/behaviour-changes/card', 'GET'), access.classifyRoute('/api/behaviour-changes', 'GET'));
  assert.deepStrictEqual(access.classifyRoute('/api/behaviour-changes/alpha', 'POST'), { kind: 'admin' });
  const server = read('server.js');
  const g = server.indexOf("pathname === '/api/behaviour-changes/card' && req.method === 'GET'");
  const list = server.indexOf("pathname === '/api/behaviour-changes' && req.method === 'GET'");
  const dec = server.indexOf("const m = pathname.match(/^\\/api\\/behaviour-changes\\/([a-z][a-z0-9-]{1,40})$/);");
  assert.ok(g > 0 && dec > 0 && list > 0);
  const post = server.slice(dec, dec + 4500);
  assert.match(post, /decision !== 'snooze'/);
  assert.match(post, /decision !== 'seen'/);
  assert.match(post, /error: 'already decided'/);
  assert.match(post, /withActor\(\{ kind: 'person'/);
  assert.ok(post.indexOf("isAdminSession(req)") > 0 && post.indexOf("isAdminSession(req)") < post.indexOf('authJson()'), 'guarded before the body is read');
  const ia = access.isAdminSession;
  assert.strictEqual(ia({ hubService: true }), false);
  assert.strictEqual(ia({ hubIdentKind: 'user', hubUser: { role: 'admin' }, hubToken: {} }), false);
  assert.strictEqual(ia({ hubIdentKind: 'agent', hubUser: { role: 'admin' } }), false);
  assert.strictEqual(ia({ hubIdentKind: 'user', hubUser: { role: 'member' } }), false);
  assert.strictEqual(ia({ hubIdentKind: 'user', hubUser: { role: 'admin' } }), true);
});

// ── the review prompt ──
test('review prompt: explains each change, records the recommendation with the tool, points at the card in this chat, never at /changes', () => {
  const review = L('behaviour-review');
  const p = review.reviewPrompt({ entries: bc.manifest(path.join(REAL, 'templates', 'behaviour-changes.json')).slice(0, 2), facts: 'x' });
  assert.match(p, /behaviour_change/);
  assert.match(p, /action "recommend"/);
  assert.match(p, /for each change/i);
  assert.match(p, /the card in this chat/);
  assert.doesNotMatch(p, /\/changes/);
  assert.doesNotMatch(p, /\[Decide\]/);
  assert.match(p, /Switch nothing in this turn/);
  assert.match(p, /Never claim you switched one when you did not/);
});

// ── p5b round 1 ──
const OWNER_ERR = 'Only the owner of this Maestro can switch this one.';
const OWNER_EXPR = '!!(req.hubUser && !req.hubService && !req.hubPendingTotp && hubAuth.isOwner(req.hubUser))';
test('r1 fix1: an entry the lead may not switch needs the install\'s owner; one the lead may switch keeps the admin rule', () => {
  const s = setup();
  assert.strictEqual(typeof bc.ownerRefusal, 'function');
  assert.strictEqual(bc.ownerRefusal('beta-two', { isOwner: false, manifestFile: s.manifestFile }), OWNER_ERR);
  assert.strictEqual(bc.ownerRefusal('beta-two', { isOwner: true, manifestFile: s.manifestFile }), null);
  assert.strictEqual(bc.ownerRefusal('alpha', { isOwner: false, manifestFile: s.manifestFile }), null);
  assert.strictEqual(bc.ownerRefusal('quiet-risky', { isOwner: false, manifestFile: s.manifestFile }), OWNER_ERR);
  const server = read('server.js');
  const dec = server.indexOf("const m = pathname.match(/^\\/api\\/behaviour-changes\\/([a-z][a-z0-9-]{1,40})$/);");
  const post = server.slice(dec, dec + 4500);
  assert.ok(post.includes('ownerRefusal(m[1]'));
  assert.ok(post.includes(OWNER_EXPR));
  assert.ok(post.includes('jsonResponse(res, 403, { ok: false, error: refused })'));
});
test('r1 fix1: Restore of an owner-only entry needs the owner; a second admin may restore one the lead may switch', async () => {
  const s = setup(); existing(s);
  await asPerson('sam', () => bc.decide('alpha', 'on', { user: 'sam', ...s.o }));
  await asPerson('sam', () => bc.decide('beta-two', 'on', { user: 'sam', ...s.o }));
  const j = sj.forDir(s.d);
  const list = entriesOf(s);
  const beta = list.find((e) => e.key === 'behaviour.beta-two'), alpha = list.find((e) => e.key === 'behaviour.alpha');
  let r = j.restoreFor(beta.id, { user: 'second', isAdmin: true, isAdminSession: true, isOwner: false });
  assert.strictEqual(r.status, 403); assert.strictEqual(r.error, OWNER_ERR);
  assert.strictEqual(st(s)['beta-two'].state, 'on');
  r = j.restoreFor(alpha.id, { user: 'second', isAdmin: true, isAdminSession: true, isOwner: false });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  r = j.restoreFor(beta.id, { user: 'sam', isAdmin: true, isAdminSession: true, isOwner: true });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(st(s)['beta-two'].state, 'pending');
  assert.ok(read('server.js').includes('isOwner: ' + OWNER_EXPR), 'the restore route passes who is the owner');
});
test('r1 fix2: a stale second device gets already decided and the state stays the first one\'s (decide, snooze, markSeen with expect)', async () => {
  const s = setup(); existing(s);
  await bc.decide('alpha', 'on', { user: 'a', expect: 'pending', ...s.o });
  await assert.rejects(() => bc.decide('alpha', 'off', { user: 'b', expect: 'pending', ...s.o }), /already decided/);
  assert.strictEqual(st(s).alpha.state, 'on'); assert.strictEqual(st(s).alpha.user, 'a');
  await assert.rejects(() => bc.snooze('alpha', { user: 'b', expect: 'pending', ...s.o }), /already decided/);
  await bc.decide('quiet-one', 'off', { user: 'a', ...s.o });
  await assert.rejects(() => bc.markSeen('quiet-one', { user: 'b', expect: 'on', ...s.o }), /already decided/);
  // a notice row pressed from a device that saw it on, while another device already turned it off
  await bc.decide('beta-two', 'off', { user: 'a', ...s.o });
  await assert.rejects(() => bc.decide('beta-two', 'off', { user: 'b', expect: 'on', ...s.o }), /already decided/);
  // no expect (the /changes page): nothing changes
  await bc.decide('alpha', 'off', { user: 'b', ...s.o });
  assert.strictEqual(st(s).alpha.state, 'off');
  const server = read('server.js');
  const dec = server.indexOf("const m = pathname.match(/^\\/api\\/behaviour-changes\\/([a-z][a-z0-9-]{1,40})$/);");
  assert.ok(/expect/.test(server.slice(dec, dec + 4500)));
});
test('r2 fix1: a stale Turn on (old rev) after a hub-wide snooze is refused and the snooze stays; a fresh rev works', async () => {
  const s = setup(); existing(s);
  const rev0 = card.cardState({ ...s.o, deps, now: T0 }).entries.find((e) => e.id === 'alpha').rev;
  assert.strictEqual(rev0, 'pending');
  await bc.snooze('alpha', { user: 'a', now: T0, expectRev: rev0, ...s.o });   // device A
  const until = st(s).alpha.snoozedUntil;
  await assert.rejects(() => bc.decide('alpha', 'on', { user: 'b', expectRev: rev0, ...s.o }), /already decided/);   // device B, old rev
  assert.strictEqual(st(s).alpha.state, 'pending'); assert.strictEqual(st(s).alpha.snoozedUntil, until);
  await assert.rejects(() => bc.snooze('alpha', { user: 'b', expectRev: rev0, ...s.o }), /already decided/);
  const rev1 = bc.viewOf(st(s).alpha);
  assert.strictEqual(rev1, 'snoozed until ' + until);
  await bc.decide('alpha', 'on', { user: 'b', expectRev: rev1, ...s.o });
  assert.strictEqual(st(s).alpha.state, 'on');
  const n0 = card.cardState({ ...s.o, deps, now: T0 }).notices.find((n) => n.id === 'quiet-one').rev;
  assert.strictEqual(n0, 'on');
  await bc.markSeen('quiet-one', { user: 'a', now: T0, expectRev: n0, ...s.o });
  await assert.rejects(() => bc.markSeen('quiet-one', { user: 'b', expectRev: n0, ...s.o }), /already decided/);
  await assert.rejects(() => bc.decide('quiet-one', 'off', { user: 'b', expectRev: n0, ...s.o }), /already decided/);
  const server = read('server.js');
  const dec = server.indexOf("const m = pathname.match(/^\\/api\\/behaviour-changes\\/([a-z][a-z0-9-]{1,40})$/);");
  const post = server.slice(dec, dec + 5500);
  assert.match(post, /b\.rev/); assert.match(post, /80/); assert.match(post, /expectRev/);
});
test('r2 fix2: cardState gives each entry canSwitch: leadMay, or the caller is the owner', () => {
  const s = setup(); existing(s);
  const ids = (o) => Object.fromEntries(card.cardState({ ...s.o, deps, now: T0, ...o }).entries.map((e) => [e.id, e.canSwitch]));
  assert.deepStrictEqual(ids({ isOwner: false }), { alpha: true, 'beta-two': false, 'quiet-risky': false });
  assert.deepStrictEqual(ids({ isOwner: true }), { alpha: true, 'beta-two': true, 'quiet-risky': true });
  assert.deepStrictEqual(ids({}), { alpha: true, 'beta-two': false, 'quiet-risky': false });
  const server = read('server.js');
  const at = server.indexOf("pathname === '/api/behaviour-changes/card'");
  assert.ok(/cardState\(\{[^}]*isOwner/.test(server.slice(at, at + 700)));
});
test('r1 fix8: the review turn accepts the agent the review was scheduled for as well as the owner lead names', () => {
  const fn = read('lib/sdk-chat.js').match(/function behaviourReviewTurn\([\s\S]*?\n\}/)[0];
  assert.match(fn, /ownerLeadNames\(\)\.includes\(agentName\)/);
  assert.ok(/!require\('\.\/agents'\)\.ownerLeadNames\(\)\.includes\(agentName\) && require\('\.\/behaviour-review'\)\.leadName\(\) !== agentName/.test(fn));
});
test('r1 fix9: the brief lists only entries still to decide (pending, not snoozed)', () => {
  const s = setup(); existing(s);
  assert.strictEqual(typeof card.waitingTitles, 'function');
  assert.deepStrictEqual(card.waitingTitles({ ...s.o, now: T0 }).sort(), ['Alpha', 'Beta', 'Quiet but owner only'].sort());
  fs.writeFileSync(s.stateFile, JSON.stringify({ entries: { ...st(s), alpha: { ...st(s).alpha, snoozedUntil: new Date(T0 + DAY).toISOString() }, 'beta-two': { ...st(s)['beta-two'], state: 'on' } } }));
  assert.deepStrictEqual(card.waitingTitles({ ...s.o, now: T0 }).sort(), ['Quiet but owner only']);
  assert.deepStrictEqual(card.waitingTitles({ ...s.o, now: T0 + 2 * DAY }).sort(), ['Alpha', 'Quiet but owner only'].sort());
  assert.deepStrictEqual(card.waitingTitles({ stateFile: path.join(s.d, 'none.json'), manifestFile: s.manifestFile }), []);
});
test('r1 fix10: Restore of a quiet entry\'s notice to unseen keeps by quiet-update so the notice shows again', async () => {
  const s = setup(); existing(s);
  assert.strictEqual(st(s)['quiet-one'].by, 'quiet-update');
  await asPerson('sam', () => bc.markSeen('quiet-one', { user: 'sam', now: T0, ...s.o }));
  assert.strictEqual(card.cardState({ ...s.o, deps, now: T0 }).notices.length, 0);
  const [seen] = entriesOf(s);
  const r = sj.forDir(s.d).restoreFor(seen.id, { user: 'sam', isAdmin: true, isAdminSession: true, isOwner: true });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(st(s)['quiet-one'].by, 'quiet-update');
  assert.deepStrictEqual(card.cardState({ ...s.o, deps, now: T0 }).notices.map((n) => n.id), ['quiet-one']);
});

// ── Undo from the card: reopen ──
test('reopen: after on, off and snooze the entry is pending again and back on the card; the recommendation and bookkeeping stay', async () => {
  for (const how of ['on', 'off', 'snooze']) {
    const s = setup(); existing(s);
    fs.writeFileSync(s.stateFile, JSON.stringify({ entries: { ...st(s), alpha: { ...st(s).alpha, recommend: 'on', recommendWhy: 'cheap', reviewTask: 'task-1' } } }));
    if (how === 'snooze') await bc.snooze('alpha', { user: 'u1', now: T0, ...s.o }); else await bc.decide('alpha', how, { user: 'u1', ...s.o });
    const rev = bc.viewOf(st(s).alpha);
    const r = await bc.reopen('alpha', { user: 'u2', expectRev: rev, ...s.o });
    const e = st(s).alpha;
    assert.deepStrictEqual([e.state, e.by, e.snoozedUntil, e.snoozedBy, e.recommend, e.recommendWhy, e.reviewTask], ['pending', 'owner', undefined, undefined, 'on', 'cheap', 'task-1'], how);
    assert.strictEqual(r.id, 'alpha');
    assert.ok(card.cardState({ ...s.o, deps, now: T0 }).entries.some((x) => x.id === 'alpha'), `${how}: back on the card`);
  }
});
test('reopen: a stale rev is refused (already decided) and nothing changes', async () => {
  const s = setup(); existing(s);
  await bc.decide('alpha', 'on', { user: 'u1', ...s.o });
  const stale = bc.viewOf(st(s).alpha);
  await bc.decide('alpha', 'off', { user: 'u3', ...s.o });
  await assert.rejects(bc.reopen('alpha', { user: 'u2', expectRev: stale, ...s.o }), /already decided/);
  assert.strictEqual(st(s).alpha.state, 'off');
});
test('reopen: an untouched pending entry is refused (already decided); an unknown id is refused; an unreadable file is not overwritten', async () => {
  const s = setup(); existing(s);
  await assert.rejects(bc.reopen('alpha', { user: 'u2', expectRev: 'pending', ...s.o }), /already decided/);
  await assert.rejects(bc.reopen('nope', { user: 'u2', expectRev: 'pending', ...s.o }), /no such change/);
  fs.writeFileSync(s.stateFile, '{not json');
  await assert.rejects(bc.reopen('alpha', { user: 'u2', expectRev: 'pending', ...s.o }));
  assert.strictEqual(fs.readFileSync(s.stateFile, 'utf8'), '{not json');
});
test('reopen: the journal gets an entry whose value becomes pending, with the person who pressed', async () => {
  const s = setup(); existing(s);
  await asPerson('sam', () => bc.decide('alpha', 'on', { user: 'sam', ...s.o }));
  await asPerson('sam', () => bc.reopen('alpha', { user: 'sam', expectRev: 'on', ...s.o }));
  const list = entriesOf(s);
  assert.strictEqual(list.length, 2);
  assert.ok(list.some((e) => e.after === 'pending' && e.before === 'on' && e.who.user === 'sam'), JSON.stringify(list));
});
test('reopen route: same owner rule and own-session guard as the other decisions, needs a rev, and every reply carries the new rev', () => {
  const server = read('server.js');
  const dec = server.indexOf("const m = pathname.match(/^\\/api\\/behaviour-changes\\/([a-z][a-z0-9-]{1,40})$/);");
  const post = server.slice(dec, dec + 6000);
  assert.match(post, /decision !== 'reopen'/);
  assert.match(post, /bc\.reopen\(/);
  assert.match(post, /ownerRefusal\(/);
  assert.match(post, /rev: bc\.viewOf\(/);
  assert.match(post, /reopen[\s\S]{0,200}rev/);
  assert.ok(post.indexOf('ownerRefusal(') < post.indexOf('bc.reopen('));
  assert.ok(post.indexOf('bc.viewOf(') > post.indexOf('bc.reopen('), 'rev read after the write');
});
test('reopen: leadMay false entries are the owner\'s alone (ownerRefusal applies to the entry, whatever the decision)', () => {
  const s = setup();
  assert.ok(bc.ownerRefusal('beta-two', { isOwner: false, manifestFile: s.manifestFile }));
  assert.strictEqual(bc.ownerRefusal('beta-two', { isOwner: true, manifestFile: s.manifestFile }), null);
  assert.strictEqual(bc.ownerRefusal('alpha', { isOwner: false, manifestFile: s.manifestFile }), null);
});
test('manifest: research-own-work has the short title; every other field stays', () => {
  const e = bc.manifest(path.join(REAL, 'templates', 'behaviour-changes.json')).find((x) => x.id === 'research-own-work');
  assert.strictEqual(e.title, "Quick research for an agent's own work");
  assert.strictEqual(e.leadMay, false);
  assert.match(e.on, /^Agents may start quick research for their own work/);
});
