'use strict';
// Set up teams on a large install: facts are trimmed within SETUP_FACTS_MAX without losing a main agent's evidence.
// Every dependency is injected (no data/ is read).
const test = require('node:test');
const assert = require('node:assert/strict');
const TS = require('../lib/team-setup');

const NOW = Date.now();
const pad = (i) => String(i).padStart(2, '0');
const hand = (caller, target, n) => Array.from({ length: n }, () => ({ caller, target, createdAt: NOW - 1000 }));
const facts = (msg) => JSON.parse(msg.match(/```json\n([\s\S]*)\n```$/)[1]);
const opts = (list, handOffs) => ({ agentsList: list, adminIds: new Set(), handOffs, consultsOf: () => ({}), starterNames: new Set(), now: NOW });

function install() {
  const list = [], handOffs = [];
  for (let i = 1; i <= 22; i++) list.push({ name: `main${pad(i)}`, display: `Main ${pad(i)}`, category: 'primary', model: 'm' });
  for (let i = 1; i <= 88; i++) list.push({ name: `agent${pad(i)}`, category: 'worker', blurb: 'x' });
  for (const k of ['writer07', 'editor07', 'scout07']) {
    list.push({ name: k, category: 'worker', blurb: 'x' });
    handOffs.push(...hand('main07', k, 30), ...hand('main03', k, 2));
  }
  // every other main uses a few agents of its own
  for (let i = 1; i <= 22; i++) for (let j = 0; j < 4; j++) handOffs.push(...hand(`main${pad(i)}`, `agent${pad((i * 4 + j) % 88 + 1)}`, 5));
  // a shared one: two mains, no majority
  list.push({ name: 'helper01', category: 'worker', blurb: 'x' });
  handOffs.push(...hand('main01', 'helper01', 4), ...hand('main02', 'helper01', 4));
  return { list, handOffs };
}

test('a main agent that clearly owns an agent keeps member rows; the agent is not shared, and other mains do not call it shared', () => {
  const { list, handOffs } = install();
  assert.equal(list.length, 22 + 88 + 3 + 1);
  const msg = TS.setupMessage(opts(list, handOffs));
  const f = facts(msg);
  console.log(`22-main seed: message ${msg.length} chars, mains kept ${f.mains.length}, rows kept ${f.mains.reduce((n, m) => n + m.working_history.length, 0)}`);
  assert.ok(msg.length <= TS.SETUP_FACTS_MAX + TS.SETUP_HEAD.length, `fits: ${msg.length}`);
  const m7 = f.mains.find(m => m.name === 'main07');
  for (const k of ['writer07', 'editor07', 'scout07']) {
    const r = m7.working_history.find(x => x.name === k);
    assert.ok(r, `${k} is a row of main07`);
    assert.equal(r.suggestion, 'member');
    assert.equal(f.shared_specialists.names.includes(k), false);
  }
  const m3 = f.mains.find(m => m.name === 'main03');
  for (const r of (m3 ? m3.working_history : [])) if (['writer07', 'editor07', 'scout07'].includes(r.name)) assert.notEqual(r.suggestion, 'shared');
  assert.ok(f.shared_specialists.names.includes('helper01'), 'an agent with no majority owner stays shared');
  assert.ok(m7.working_history.length >= 3, 'a main with member rows is not emptied');
});

test('setupFacts: another main\'s row for an owned agent says owned_elsewhere with the owner, at level 0', () => {
  const { list, handOffs } = install();
  const f = TS.setupFacts({ ...opts(list, handOffs), level: 0 });
  const r = f.mains.find(m => m.name === 'main03').working_history.find(x => x.name === 'writer07');
  assert.deepEqual([r.suggestion, r.owner, r.calls, r.total], ['owned_elsewhere', 'main07', 2, 32]);
  assert.equal(f.shared_specialists.names.includes('writer07'), false);
});

test('a huge install: no main with member rows has an empty working_history; the rest are listed as not_covered_this_pass', () => {
  const list = [], handOffs = [];
  for (let i = 1; i <= 60; i++) {
    list.push({ name: `main${pad(i)}`, category: 'primary', model: 'm' });
    for (let j = 0; j < 5; j++) { const a = `writer${pad(i)}x${j}`; list.push({ name: a, category: 'worker', blurb: 'x' }); handOffs.push(...hand(`main${pad(i)}`, a, 20)); }
  }
  const small = TS.SETUP_FACTS_MAX;
  const msg = TS.setupMessage(opts(list, handOffs));
  assert.ok(msg.length <= small + TS.SETUP_HEAD.length, `fits: ${msg.length}`);
  const f = facts(msg);
  for (const m of f.mains) assert.ok(m.working_history.length >= Math.min(TS.MEMBER_ROWS_MAX, 5), `${m.name} keeps its rows`);
  const names = new Set(f.mains.map(m => m.name));
  assert.ok(f.not_covered_this_pass && f.not_covered_this_pass.length > 0);
  assert.match(f.not_covered_note, /Press Set up teams again/);
  assert.equal(f.mains.length + f.not_covered_this_pass.length, 60);
  assert.equal(f.not_covered_this_pass.some(n => names.has(n)), false);
});

test('mains that already have a team are listed by name only; mains with nothing to suggest go to no_team_suggested (when trimming reaches that level)', () => {
  const list = [], handOffs = [];
  for (let i = 1; i <= 30; i++) {
    list.push({ name: `main${pad(i)}`, category: 'primary', model: 'm' });
    for (let j = 0; j < 12; j++) { const a = `agent${pad(i)}x${j}`; list.push({ name: a, category: 'worker', blurb: 'x', ...(i === 1 && j < 2 ? { reportsTo: 'main01' } : {}) }); if (i > 2) handOffs.push(...hand(`main${pad(i)}`, a, i === 30 ? 1 : 6)); }
  }
  const f = facts(TS.setupMessage(opts(list, handOffs)));
  if (f.already_have_team) { assert.ok(f.already_have_team.includes('main01')); assert.equal(f.mains.some(m => m.name === 'main01'), false); }
  if (f.no_team_suggested) assert.equal(f.mains.some(m => f.no_team_suggested.includes(m.name)), false);
});
