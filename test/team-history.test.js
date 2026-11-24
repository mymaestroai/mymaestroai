'use strict';
// Build Team starts from existing agents (lib/team-plan workingHistory, setupSignals, suggestionFor, the facts and the playbook).
// Every source is injected: nothing here reads the install's data/.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const TP = require('../lib/team-plan');

const ROOT = path.join(__dirname, '..');
const NOW = Date.parse('2026-11-23T12:00:00Z');
const DAY = 86400000;
const ago = (d) => NOW - d * DAY;
const facts = (message) => JSON.parse(message.match(/```json\n([\s\S]*)\n```$/)[1]);

const roster = () => [
  { name: 'studio', display: 'Studio', category: 'primary', model: 'm-top', policy: { roots: ['/work/proj-a'] } },
  { name: 'press', display: 'Press', category: 'primary', model: 'm-top' },
  { name: 'writer', category: 'worker', blurb: 'Drafts text' },
  { name: 'editor', category: 'worker', blurb: 'Edits text' },
  { name: 'atlas', category: 'worker', blurb: 'Looks things up' },
  { name: 'critic', category: 'specialist', blurb: 'Challenges plans' },
  { name: 'scribe', category: 'worker', blurb: 'Keeps notes', policy: { roots: ['/work/proj-a'] } },
  { name: 'sam', category: 'worker', blurb: 'Odd jobs' },
  { name: 'drone', category: 'worker', blurb: 'Never called' },
  { name: 'tw-1', category: 'worker' },
];
const ho = (caller, target, d = 1, n = 1) => Array.from({ length: n }, () => ({ caller, target, createdAt: ago(d) }));
const handOffs = () => [
  ...ho('studio', 'writer', 2, 5),                  // studio owns writer: 5 of 5
  ...ho('studio', 'editor', 3, 3), ...ho('press', 'editor', 3, 1),   // editor: 3 of 4 = 0.75
  ...ho('studio', 'atlas', 1, 3), ...ho('press', 'atlas', 1, 3),     // atlas: shared, 3 of 6 each
  ...ho('studio', 'critic', 1, 6), ...ho('press', 'critic', 1, 1),   // critic: a reviewer, one main dominates
  ...ho('studio', 'sam', 1, 1),                                      // sam: too little
  ...ho('studio', 'writer', 60, 9),                                  // outside the window
];
const consultsOf = (agent) => ({ press: { editor: 0 }, studio: { writer: 0 } }[agent] || {});
const ctx = (o = {}) => ({ main: roster()[0], agentsList: roster(), handOffs: handOffs(), consultsOf, now: NOW, ...o });
const byName = (rows) => Object.fromEntries(rows.map(r => [r.name, r]));
const suggest = (o = {}) => {
  const c = ctx(o), rows = TP.workingHistory(c), list = c.agentsList;
  const out = {};
  for (const r of rows) { const a = list.find(x => x.name === r.name); out[r.name] = TP.suggestionFor(r, TP.setupSignals(c.main, a, o.starterNames), a, c.main.name); }
  return out;
};

test('the named constants', () => {
  assert.equal(TP.SHARE_MIN, 0.7);
  assert.equal(TP.CALLS_MIN, 3);
  assert.equal(TP.HISTORY_DAYS, 30);
});

test('workingHistory: hand-offs and consults from the main agent, the total from every caller, the share to 2 decimals', () => {
  const c = ctx({ consultsOf: (a) => ({ studio: { editor: 1 }, atlas: { editor: 2 } }[a] || {}) });
  const rows = byName(TP.workingHistory(c));
  assert.deepEqual(rows.writer.from_main, { hand_offs: 5, consults: 0 });
  assert.equal(rows.writer.total_calls, 5, 'the hand-offs outside the 30 days are not counted');
  assert.equal(rows.writer.share, 1);
  assert.deepEqual(rows.editor.from_main, { hand_offs: 3, consults: 1 });
  assert.equal(rows.editor.total_calls, 7, 'one hand-off from press, two consults from a worker count in the total');
  assert.equal(rows.editor.share, 0.57);
  assert.equal(rows.atlas.share, 0.5);
  assert.equal(rows.atlas.mains_using, 2);
  assert.ok(!rows.studio && !rows['tw-1'], 'the main agent itself and virtual workers are left out');
  assert.equal(rows.drone.total_calls, 0);
  assert.equal(rows.drone.share, 0);
});

test('workingHistory: the default window is HISTORY_DAYS from now, and an explicit since wins', () => {
  assert.equal(byName(TP.workingHistory(ctx())).writer.total_calls, 5);
  assert.equal(byName(TP.workingHistory(ctx({ since: new Date(ago(90)).toISOString() }))).writer.total_calls, 14);
});

test('suggestions: one main agent clearly owning three agents', () => {
  const s = suggest();
  assert.equal(s.writer, 'member');
  assert.equal(s.editor, 'member');
  assert.equal(s.scribe, 'member', 'its folder');
  const own = suggest({ handOffs: [...ho('studio', 'writer', 1, 4), ...ho('studio', 'editor', 1, 3), ...ho('studio', 'atlas', 1, 5)] });
  assert.deepEqual([own.writer, own.editor, own.atlas], ['member', 'member', 'member']);
});

test('suggestions: two main agents sharing one agent, none at the share minimum', () => {
  assert.equal(suggest().atlas, 'shared');
  assert.equal(TP.workingHistory(ctx({ main: roster()[1] })).find(r => r.name === 'atlas').share, 0.5);
});

test('suggestions: a team only by its folder is a member by signal, with no calls at all', () => {
  const s = suggest();
  assert.equal(s.scribe, 'member');
  const sig = TP.setupSignals(roster()[0], roster().find(a => a.name === 'scribe'));
  assert.deepEqual(sig, { same_folder: true, build_partner: false, starter_team: false });
  assert.equal(TP.setupSignals(roster()[1], roster().find(a => a.name === 'scribe')).same_folder, false);
  const broad = { policy: { roots: ['/tmp', require('os').homedir()] } };
  assert.equal(TP.setupSignals({ name: 'a', ...broad }, { name: 'b', ...broad }).same_folder, false, 'a root everyone has says nothing');
});

test('suggestions: a reviewer used mostly by one main agent stays shared', () => {
  const rows = byName(TP.workingHistory(ctx()));
  assert.ok(rows.critic.share >= TP.SHARE_MIN && rows.critic.from_main.hand_offs >= TP.CALLS_MIN);
  assert.equal(suggest().critic, 'shared');
  const l = roster(); l.find(a => a.name === 'atlas').blurb = 'Reviews drafts';
  assert.equal(suggest({ agentsList: l }).atlas, 'shared', 'matched by the blurb');
});

test('suggestions: too little history, and unused', () => {
  const s = suggest();
  assert.equal(s.sam, 'too_little');
  assert.equal(s.drone, 'unused');
});

test('suggestions: a setup signal is not enough when another main agent clearly owns the agent; build partner and starter team count', () => {
  const l = roster(); l.find(a => a.name === 'writer').buildPartner = 'studio';
  assert.equal(suggest({ agentsList: l, handOffs: ho('press', 'writer', 1, 5) }).writer, 'shared');
  assert.equal(suggest({ agentsList: l, handOffs: [] }).writer, 'member');
  const l2 = roster(); l2[0].buildPartner = 'sam';
  assert.equal(suggest({ agentsList: l2, main: l2[0] }).sam, 'member');
  assert.equal(suggest({ starterNames: new Set(['studio', 'sam']) }).sam, 'member');
  assert.equal(suggest({ starterNames: new Set(['sam']) }).sam, 'too_little', 'both must be in the starter team');
});

test('suggestions: a 5-5 split between two mains with a shared folder is shared; 7-3 is a member for the 7 side; a folder alone is a member', () => {
  const l = roster(); l[1].policy = { roots: ['/work/proj-a'] };   // press has the folder too
  const split = [...ho('studio', 'scribe', 1, 5), ...ho('press', 'scribe', 1, 5)];
  assert.equal(suggest({ agentsList: l, main: l[0], handOffs: split }).scribe, 'shared');
  assert.equal(suggest({ agentsList: l, main: l[1], handOffs: split }).scribe, 'shared');
  const seven = [...ho('studio', 'scribe', 1, 7), ...ho('press', 'scribe', 1, 3)];
  assert.equal(suggest({ agentsList: l, main: l[0], handOffs: seven }).scribe, 'member');
  assert.equal(suggest({ agentsList: l, main: l[1], handOffs: seven }).scribe, 'shared');
  assert.equal(suggest({ handOffs: [] }).scribe, 'member', 'the folder of one main only');
});

test('starterTeamNames reads the ledger roles', () => {
  const n = TP.starterTeamNames({ roles: { scout: { name: 'scout', status: 'created' }, builder: { name: 'builder', status: 'reserved' } } });
  assert.deepEqual([...n], ['scout']);
});

test('buildFacts: working_history lists only agents with calls or a signal, most from this main agent first, and the unused by name', () => {
  const f = TP.buildFacts({ primary: roster()[0], agentsList: roster(), adminIds: new Set(), counts: () => ({ turns: {}, tools: { spawn_workers: 4 } }), handOffs: handOffs(), consultsOf, now: NOW });
  assert.deepEqual(f.working_history.map(r => r.name), ['critic', 'writer', 'atlas', 'editor', 'sam', 'scribe']);
  const w = f.working_history.find(r => r.name === 'writer');
  assert.deepEqual(w, { name: 'writer', from_main: { hand_offs: 5, consults: 0 }, total_calls: 5, share: 1, suggestion: 'member' });
  assert.deepEqual(f.working_history.find(r => r.name === 'scribe').setup, ['same_folder']);
  assert.deepEqual(f.unused_30_days, ['drone']);
  assert.equal(f.activity_30_days.spawn_workers, 4);
});

test("a member's agents: counts only, no blurb or text in the history", () => {
  const l = roster().concat([{ name: 'ward', category: 'worker', owner: 'u-member', blurb: 'Private notes about a patient' }]);
  const msg = TP.buildMessage({ primary: l[0], agentsList: l, adminIds: new Set(['u-admin']), counts: () => null, models: [], handOffs: [...handOffs(), ...ho('studio', 'ward', 1, 4)], consultsOf, now: NOW });
  const f = facts(msg), row = f.working_history.find(r => r.name === 'ward');
  assert.deepEqual(Object.keys(row).sort(), ['from_main', 'name', 'share', 'suggestion', 'total_calls']);
  assert.ok(!/Private notes/.test(msg));
  for (const r of f.working_history) for (const k of Object.keys(r)) assert.ok(['name', 'from_main', 'total_calls', 'share', 'setup', 'suggestion'].includes(k), k);
});

test('the facts stay under FACTS_MAX with 60 agents that all have history', () => {
  const l = roster().concat(Array.from({ length: 60 }, (_, i) => ({ name: `agent${i}`, display: `Agent ${i}`, category: 'worker', model: 'm-cheap', blurb: 'x'.repeat(300) })));
  const hs = l.filter(a => /^agent/.test(a.name)).flatMap((a, i) => ho('studio', a.name, 1, 1 + (i % 6)));
  const msg = TP.buildMessage({ primary: l[0], agentsList: l, adminIds: new Set(), counts: () => ({ turns: {}, tools: {} }), models: Array.from({ length: 40 }, (_, i) => ({ id: `acme/model-${i}`, provider: 'acme' })), handOffs: hs, consultsOf, now: NOW });
  const block = msg.slice(msg.indexOf('```json'));
  assert.ok(block.length <= TP.FACTS_MAX, `block is ${block.length} characters`);
  assert.equal((msg.match(/```/g) || []).length, 2);
  assert.ok(facts(msg).working_history.length >= 8);
});

test('the playbook carries the method, and the manifest has its sha', () => {
  const rel = 'maestro/TEAM-PLAYBOOK.md';
  const text = fs.readFileSync(path.join(ROOT, 'templates', 'workspaces', rel), 'utf8');
  assert.match(text, /Existing agents first/);
  assert.match(text, /14 hand-offs from Atlas, 93% of its work/);
  assert.match(text, /New agents only for a gap/);
  assert.match(text, /One boss each/);
  assert.match(text, /shared specialist: no line/);
  assert.match(text, /Reviewers stay shared/);
  assert.match(text, /this already works, no change suggested/);
  assert.ok(!/claude-|opus-|sonnet-|haiku-/i.test(text.split('## Start from')[1].split('## The proposal')[0]), 'tiers, not model ids');
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates', 'workspace-updates.json'), 'utf8'))[rel];
  assert.equal(m.current, crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'templates', 'workspaces', rel))).digest('hex'));
  assert.deepEqual(m.previous, ['758602a0772948e76162f5c4ed102e5f13dd3918200cb9ac27707be69534fed3', '59ec7edc513a3435897aa8a8e63cbfc45b732680c99fa6a0be74205b56550f45', '69d03c6b4614fd13985f0cf67872d9c097b14f5ae8eb3067adb46ad5951d1f22'], 'the versions (the Teams view, then Set up teams) shipped before this one; the first is the version shipped with the Teams view, so installs that copied it get this one');
});
