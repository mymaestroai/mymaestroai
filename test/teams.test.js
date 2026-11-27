'use strict';
// Teams view: the pure rules (lib/ui-teams), and the server side of "reportsTo" (lib/agents, server.js, lib/settings).
// agents.js and settings.js keep data under <install>/data, so the server-side tests copy lib/ into a throwaway hub folder
// (the pattern of unit-agents.test.js) and never touch the real data/. Nothing live: no model is called.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const REAL_ROOT = path.join(__dirname, '..');
const T = require(path.join(REAL_ROOT, 'lib', 'ui-teams.js'));
const read = (f) => fs.readFileSync(path.join(REAL_ROOT, f), 'utf8');

// ── The pure module ─────────────────────────────────────────────────────────
const ag = (name, extra) => Object.assign({ name, category: 'specialist' }, extra);
const names = (nodes) => nodes.map(n => n.agent.name);
function placed(t) {
  const out = [];
  const walk = (n) => { out.push(n.agent.name); n.children.forEach(walk); };
  [...t.mains, ...t.shared, ...t.other].forEach(walk);
  return out;
}

test('bossOf: reportsTo wins, a missing boss falls back, main agents never have one', () => {
  const list = [ag('lead', { category: 'primary' }), ag('builder', { reportsTo: 'lead' }), ag('coder', { reportsTo: 'ghost' }), ag('self', { reportsTo: 'self' })];
  assert.strictEqual(T.bossOf(list[1], list), 'lead');
  assert.strictEqual(T.bossOf(list[2], list), null, 'a boss that is not in the list');
  assert.strictEqual(T.bossOf(list[3], list), null, 'itself');
  assert.strictEqual(T.bossOf(Object.assign({}, list[0], { reportsTo: 'builder' }), list), null, 'a main agent');
});

test('bossOf: one primary naming it as buildPartner is its boss; two primaries are none; reportsTo beats it', () => {
  const one = [ag('owner', { category: 'primary', buildPartner: 'builder' }), ag('builder')];
  assert.strictEqual(T.bossOf(one[1], one), 'owner');
  const two = [ag('owner', { category: 'primary', buildPartner: 'builder' }), ag('sam', { category: 'primary', buildPartner: 'builder' }), ag('builder')];
  assert.strictEqual(T.bossOf(two[2], two), null);
  const both = [ag('owner', { category: 'primary', buildPartner: 'builder' }), ag('sam', { category: 'primary' }), ag('builder', { reportsTo: 'sam' })];
  assert.strictEqual(T.bossOf(both[2], both), 'sam');
  const notPrimary = [ag('lead2', { buildPartner: 'builder' }), ag('builder')];
  assert.strictEqual(T.bossOf(notPrimary[1], notPrimary), null, 'only a main agent\'s build partner counts');
});

test('tree: every agent exactly once, including a loop, a missing boss and experimental', () => {
  const list = [
    ag('owner', { category: 'primary' }),
    ag('builder', { reportsTo: 'owner' }),
    ag('coder', { reportsTo: 'builder' }),
    ag('x', { reportsTo: 'y' }), ag('y', { reportsTo: 'x' }),
    ag('orphan', { reportsTo: 'ghost' }),
    ag('lab', { category: 'experimental' }),
    ag('lab2', { category: 'experimental', reportsTo: 'owner' }),
  ];
  const t = T.tree(list, {});
  const p = placed(t);
  assert.strictEqual(t.size, list.length);
  assert.deepStrictEqual(p.slice().sort(), list.map(a => a.name).sort());
  assert.strictEqual(new Set(p).size, list.length, 'no one twice');
  assert.deepStrictEqual(names(t.mains), ['owner']);
  assert.ok(t.shared.map(n => n.agent.name).includes('orphan'));
  assert.deepStrictEqual(names(t.other), ['lab'], 'experimental with no boss');
  assert.strictEqual(t.anyTeam, true);
  assert.strictEqual(T.tree([ag('owner', { category: 'primary' }), ag('sam')], {}).anyTeam, false);
});

test('tree: size, working and helpers', () => {
  const list = [ag('owner', { category: 'primary' }), ag('builder', { reportsTo: 'owner' }), ag('coder', { reportsTo: 'builder' }), ag('sam', { reportsTo: 'owner' })];
  const status = { builder: { busy: true }, coder: { busy: true }, sam: { busy: false },
    w1: { worker: true, parent: 'builder', busy: true }, w2: { worker: true, parent: 'builder', busy: true }, w3: { worker: true, parent: 'sam', busy: false } };
  assert.deepStrictEqual({ ...T.helpersBy(status) }, { builder: 2 });
  const t = T.tree(list, status);
  const owner = t.mains[0];
  assert.strictEqual(owner.size, 3);
  assert.strictEqual(owner.working, 4, 'builder + coder + builder\'s two helpers');
  const builder = owner.children.find(c => c.agent.name === 'builder');
  assert.strictEqual(builder.size, 1);
  assert.strictEqual(builder.helpers, 2);
  assert.strictEqual(builder.working, 3, 'coder + its own two helpers');
  assert.strictEqual(builder.depth, 1);
});

test('checkReportsTo: the rules', () => {
  const list = [
    ag('owner', { category: 'primary' }), ag('lead', { lead: true }),
    ag('builder'), ag('coder'), ag('worker1'),
    ag('mine', { owner: 'u1' }), ag('shared', { category: 'primary', sharedWith: ['u1'] }), ag('theirs', { owner: 'u2' }), ag('adm', { owner: 'a1' }),
  ];
  const admins = new Set(['a1']);
  const ok = (n, b, l = list) => assert.strictEqual(T.checkReportsTo(n, b, l, admins), null, `${n} -> ${b}`);
  const no = (n, b, re, l = list) => assert.match(String(T.checkReportsTo(n, b, l, admins)), re, `${n} -> ${b}`);
  no('builder', 'builder', /cannot report to itself/);
  no('builder', 'ghost', /no agent named ghost/);
  no('ghost', 'owner', /no agent named ghost/);
  no('owner', 'builder', /main agent/);
  no('lead', 'builder', /main agent/);
  no('mine', 'adm', /belongs to someone else/);   // a member's agent to an admin agent
  no('mine', 'theirs', /belongs to someone else/);
  ok('mine', 'shared');   // a boss shared with that member
  ok('builder', 'owner');
  ok('adm', 'owner');
  // 3 levels
  const l3 = list.map(a => (a.name === 'builder' ? Object.assign({}, a, { reportsTo: 'owner' }) : a));
  ok('coder', 'builder', l3);
  const l4 = l3.map(a => (a.name === 'coder' ? Object.assign({}, a, { reportsTo: 'builder' }) : a));
  no('worker1', 'coder', /at most 3 levels/, l4);   // a worker as boss
  no('worker1', 'worker1', /itself/, l4);
});

test('checkReportsTo: a leader with reports, loops, and clearing', () => {
  const list = [ag('owner', { category: 'primary' }), ag('sam', { category: 'primary' }), ag('builder', { reportsTo: 'owner' }), ag('coder', { reportsTo: 'builder' }), ag('other', { reportsTo: 'owner' })];
  const admins = new Set();
  assert.strictEqual(T.checkReportsTo('builder', 'sam', list, admins), null, 'an agent with reports may move to another main agent');
  assert.match(T.checkReportsTo('builder', 'other', list, admins), /has agents reporting to it, so it can report only to a main agent/);
  assert.match(T.checkReportsTo('owner', 'owner', list, admins), /main agent/);
  assert.match(T.checkReportsTo('builder', 'coder', list, admins), /already reports to builder/, 'a loop');
  const loopy = [ag('owner', { category: 'primary' }), ag('x', { reportsTo: 'owner' }), ag('y', { reportsTo: 'x' })];
  assert.match(T.checkReportsTo('x', 'y', loopy, admins), /already reports to x/);
  for (const clear of ['', null, undefined]) assert.strictEqual(T.checkReportsTo('coder', clear, list, admins), null);
  assert.match(T.checkReportsTo('ghost', '', list, admins), /no agent named ghost/);
  assert.match(T.checkReportsTo('coder', 5, list, admins), /must be an agent name/);
  assert.strictEqual(T.ownerKey({ owner: 'a1' }, new Set(['a1'])), '@admin');
  assert.strictEqual(T.ownerKey({ owner: 'u1' }, new Set(['a1'])), 'u1');
});

// ── The server side ─────────────────────────────────────────────────────────
const roots = [];
const saved = { mem: process.env.HUB_MEMORY_DB, auth: process.env.HUB_AUTH_DIR };
function load(agents) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-test-'));
  roots.push(root);
  const hub = path.join(root, 'hub');
  fs.mkdirSync(path.join(root, 'share'));
  fs.cpSync(path.join(REAL_ROOT, 'lib'), path.join(hub, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(REAL_ROOT, 'package.json'), path.join(hub, 'package.json'));
  fs.symlinkSync(path.join(REAL_ROOT, 'node_modules'), path.join(hub, 'node_modules'));
  fs.mkdirSync(path.join(hub, 'data'), { recursive: true });
  fs.writeFileSync(path.join(hub, 'data', 'agents.json'), JSON.stringify(agents));
  process.env.HUB_MEMORY_DB = path.join(hub, 'data', 'memory.db');
  process.env.HUB_AUTH_DIR = path.join(hub, 'data');
  const gw = new Module(path.join(hub, 'lib', 'gateway-client.js'));
  gw.filename = gw.id; gw.loaded = true;
  gw.exports = { listModels: async () => [], chatCompletion: async () => { throw new Error('no model in tests'); } };
  require.cache[gw.id] = gw;
  const lib = require(path.join(hub, 'lib', 'agents.js'));
  lib.__archive.configure({ sandbox: () => ({ retire: async () => ({ result: 'no Docker here' }), remove: async () => {} }), isBoxed: () => false, log: () => {} });
  const readJson = () => JSON.parse(fs.readFileSync(path.join(hub, 'data', 'agents.json'), 'utf8'));
  const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };
  return { lib, hub, readJson, quiet, boss: (n) => readJson().find(a => a.name === n).reportsTo };
}
test.after(() => {
  for (const [k, v] of [['HUB_MEMORY_DB', saved.mem], ['HUB_AUTH_DIR', saved.auth]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});
const FIXTURE = () => [{ name: 'lead', category: 'primary', model: 'm' }, { name: 'builder', model: 'm' }, { name: 'coder', model: 'm' }];

test('updateAgentField reportsTo: the error text, trimmed and lower-cased, cleared by empty or null; the normalizer exposes it', async () => {
  const a = load(FIXTURE());
  const set = (n, v) => a.lib.updateAgentField(n, { reportsTo: v });
  assert.deepStrictEqual(await set('builder', 'builder'), { success: false, error: 'an agent cannot report to itself' });
  assert.deepStrictEqual(await set('builder', 'ghost'), { success: false, error: 'there is no agent named ghost' });
  assert.deepStrictEqual(await set('lead', 'builder'), { success: false, error: 'lead is a main agent; main agents report to nobody' });
  assert.deepStrictEqual(await set('coder', 'builder'), { success: false, error: 'builder is not a main agent or a team leader; a team has at most 3 levels' });
  assert.ok(!('reportsTo' in a.readJson()[2]), 'a refused change stores nothing');
  assert.deepStrictEqual(await set('builder', '  LEAD '), { success: true });
  assert.strictEqual(a.boss('builder'), 'lead');
  assert.deepStrictEqual(await set('coder', 'builder'), { success: true });
  assert.match((await set('lead', 'coder')).error, /main agent/);
  assert.match((await set('builder', 'coder')).error, /has agents reporting to it|already reports/);
  const list = a.lib.getAgentsSync(true);
  assert.strictEqual(list.find(x => x.name === 'coder').reportsTo, 'builder');
  assert.strictEqual(list.find(x => x.name === 'lead').reportsTo, undefined);
  assert.strictEqual((await a.lib.getAgents()).find(x => x.name === 'builder').reportsTo, 'lead');
  assert.deepStrictEqual(await set('coder', null), { success: true });
  assert.ok(!('reportsTo' in a.readJson().find(x => x.name === 'coder')));
  assert.deepStrictEqual(await set('builder', ''), { success: true });
  assert.ok(!('reportsTo' in a.readJson().find(x => x.name === 'builder')));
});

test('hand-edited junk in reportsTo is not exposed', () => {
  const a = load([{ name: 'lead', category: 'primary', model: 'm' }, { name: 'builder', model: 'm', reportsTo: 'Not A Name' }, { name: 'coder', model: 'm', reportsTo: 7 }]);
  const list = a.lib.getAgentsSync(true);
  assert.strictEqual(list.find(x => x.name === 'builder').reportsTo, undefined);
  assert.strictEqual(list.find(x => x.name === 'coder').reportsTo, undefined);
});

test('renameAgent: those who reported to it follow the new name; delete: they report to nobody', async () => {
  const a = load([{ name: 'lead', category: 'primary', model: 'm' }, { name: 'builder', model: 'm', reportsTo: 'lead' }, { name: 'coder', model: 'm', reportsTo: 'builder' }, { name: 'sam', model: 'm', reportsTo: 'lead' }]);
  const r = await a.quiet(() => a.lib.renameAgent('builder', 'maker'));
  assert.deepStrictEqual(r, { success: true, newName: 'maker' });
  assert.strictEqual(a.boss('coder'), 'maker');
  assert.strictEqual(a.boss('maker'), 'lead', 'its own line is kept');
  assert.strictEqual(a.boss('sam'), 'lead', 'others are not touched');
  // a refused rename changes nobody's line
  assert.strictEqual((await a.quiet(() => a.lib.renameAgent('maker', 'BAD NAME'))).success, false);
  assert.strictEqual(a.boss('coder'), 'maker');
  const kept = a.readJson().find(x => x.name === 'maker');
  const del = await a.quiet(() => a.lib.deleteAgent('maker'));
  assert.strictEqual(del.success, true, JSON.stringify(del));
  assert.ok(!('reportsTo' in a.readJson().find(x => x.name === 'coder')), 'the field is removed, not left pointing at nobody');
  assert.strictEqual(a.boss('sam'), 'lead');
  const bundle = fs.readdirSync(path.join(a.hub, 'data', 'archived-agents')).find(n => n.startsWith('maker-'));
  assert.ok(bundle, 'the deleted agent was archived');
  assert.strictEqual(kept.reportsTo, 'lead');
});

test('createAgent: an optional reportsTo is checked against the list with the new agent in it', async () => {
  const a = load(FIXTURE());
  const make = (n, extra) => a.quiet(() => a.lib.createAgent(n, 'm', null, null, 'specialist', null, extra));
  const bad = await make('newbie', { reportsTo: 'ghost' });
  assert.deepStrictEqual(bad, { success: false, error: 'reportsTo: there is no agent named ghost' });
  assert.ok(!a.readJson().some(x => x.name === 'newbie'), 'nothing was created');
  assert.strictEqual((await make('newbie', { reportsTo: 'Bad Name' })).error, 'reportsTo: an agent name');
  assert.match((await make('newbie', { reportsTo: 'coder' })).error, /^reportsTo: coder is not a main agent/);
  assert.strictEqual((await make('newbie', { reportsTo: 'lead' })).success, true);
  assert.strictEqual(a.boss('newbie'), 'lead');
  assert.strictEqual((await make('plain', {})).success, true);
  assert.ok(!('reportsTo' in a.readJson().find(x => x.name === 'plain')));
});

test('settings: sidebarTigerTeam and sidebarGuide are off by default and always in getForUI', () => {
  const a = load([]);
  const s = require(path.join(a.hub, 'lib', 'settings.js'));
  const ui = s.getForUI();
  assert.strictEqual(ui.sidebarTigerTeam, false);
  assert.strictEqual(ui.sidebarGuide, false);
  s.updateSettings({ sidebarTigerTeam: true });
  assert.strictEqual(s.getForUI().sidebarTigerTeam, true);
  assert.strictEqual(s.getForUI().sidebarGuide, false);
  assert.ok(fs.existsSync(path.join(a.hub, 'data', 'settings.json')), 'saved in the throwaway hub, not the real data/');
});

// ── Wiring that needs a running server: checked in the source ───────────────
test('server.js: reportsTo is refused for the hub service and the two settings are normalized to booleans', () => {
  const src = read('server.js');
  const apply = read('lib/settings-apply.js');   // the PATCH guards and the settings cleaners moved from server.js into lib/settings-apply
  assert.match(apply, /'reportsTo' in body && \(notPerson \|\| !ctx\.isAdmin\)\) return \{ ok: false, status: 403, error: 'reportsTo is set by an admin or through the team tool' \}/);
  assert.match(apply, /const notPerson = !!ctx\.service \|\| !!ctx\.token \|\| !ctx\.user \|\| !!ctx\.pendingTotp;/);
  assert.match(src, /const hideUnseen = \(a\) => seeAll \? \{\} : \{[\s\S]*?reportsTo: undefined[\s\S]*?buildPartner: undefined/);
  assert.match(src, /\.\.\.stripVoice\(a\), \.\.\.hideUnseen\(a\)/);
  assert.match(src, /const seeAll = !!req\.hubService \|\| \(access\.isAdmin\(req\.hubUser\) && !req\.hubPendingTotp\);/);
  assert.match(apply, /patch\.sidebarTigerTeam = patch\.sidebarTigerTeam === true/);
  assert.match(apply, /patch\.sidebarGuide = patch\.sidebarGuide === true/);
  const memberEditable = apply.match(/const MEMBER_EDITABLE_AGENT_FIELDS = new Set\(\[([^\]]*)\]/);
  assert.ok(memberEditable && !/reportsTo/.test(memberEditable[1]), 'a member cannot set it');
  assert.match(src, /const result = await updateAgentField\(name, body/);
});

test('static-files: ui-teams.js is served from lib/', () => {
  assert.match(read('lib/static-files.js'), /\['ui-teams\.js', 'lib\/ui-teams\.js'\]/);
});

// removed (P4-2): 'agent-settings.html: the Reports to select' pinned the old page's source; the card's Reports to row (OPT-0062) saves PATCH {reportsTo}
// (test/ui-agent-card-basics.test.js, Role and team). The old page's two help sentences are not on the card.

test('tree: every level is ordered like All Agents (the lead first, then by shown name)', () => {
  const t = require('../lib/ui-teams.js');
  const r = t.tree([
    { name: 'zed', display: 'Zed', category: 'primary' }, { name: 'lead', display: 'Lead', category: 'primary', lead: true },
    { name: 'amy', display: 'Amy', category: 'primary' }, { name: 'w2', display: 'Bo', reportsTo: 'amy' }, { name: 'w1', display: 'Al', reportsTo: 'amy' },
    { name: 's2', display: 'Yan', category: 'specialist' }, { name: 's1', display: 'Abe', category: 'specialist' },
  ], {});
  assert.deepStrictEqual(r.mains.map(n => n.agent.name), ['lead', 'amy', 'zed']);
  assert.deepStrictEqual(r.mains[1].children.map(n => n.agent.name), ['w1', 'w2']);
  assert.deepStrictEqual(r.shared.map(n => n.agent.name), ['s1', 's2']);
});

// ── Review fixes ────────────────────────────────────────────────────────────
test('buildPartner reading respects ownership: same owner value only (both empty counts as equal)', () => {
  const same = [ag('boss1', { category: 'primary', owner: 'u1', buildPartner: 'bld' }), ag('bld', { owner: 'u1' })];
  assert.strictEqual(T.bossOf(same[1], same), 'boss1');
  const empty = [ag('boss1', { category: 'primary', buildPartner: 'bld' }), ag('bld')];
  assert.strictEqual(T.bossOf(empty[1], empty), 'boss1');
  const diff = [ag('boss1', { category: 'primary', owner: 'u1', buildPartner: 'bld' }), ag('bld', { owner: 'u2' })];
  assert.strictEqual(T.bossOf(diff[1], diff), null);
  const mixed = [ag('boss1', { category: 'primary', buildPartner: 'bld' }), ag('bld', { owner: 'u2' })];
  assert.strictEqual(T.bossOf(mixed[1], mixed), null);
  assert.strictEqual(T.tree(diff, {}).anyTeam, false);
});

test('helpersBy and tree: names like constructor and __proto__ work', () => {
  const list = [ag('constructor', { category: 'primary' }), ag('__proto__x', { reportsTo: 'constructor' })];
  const t = T.tree(list, {});
  assert.strictEqual(t.mains[0].agent.name, 'constructor');
  assert.strictEqual(t.mains[0].working, 0, 'idle: no helpers counted from the prototype');
  assert.strictEqual(t.mains[0].helpers, 0);
  const busy = T.tree(list, { w: { worker: true, parent: 'constructor', busy: true }, w2: { worker: true, parent: '__proto__', busy: true } });
  assert.strictEqual(busy.mains[0].helpers, 1);
  assert.strictEqual(T.helpersBy({ w2: { worker: true, parent: '__proto__', busy: true } }).__proto__, 1, 'counted as a name, not as the prototype');
});

test('tree: only agents inside a loop are cut; one leading into a loop keeps its boss', () => {
  const list = [ag('a', { reportsTo: 'b' }), ag('b', { reportsTo: 'a' }), ag('c', { reportsTo: 'a' })];
  const t = T.tree(list, {});
  const p = placed(t);
  assert.deepStrictEqual(p.slice().sort(), ['a', 'b', 'c']);
  assert.strictEqual(new Set(p).size, 3, 'every agent once');
  const all = [...t.shared];
  const top = all.map(n => n.agent.name);
  assert.ok(top.length === 1 || top.length === 2);
  const findParent = (c) => { let out = null; const walk = (n) => n.children.forEach(k => { if (k.agent.name === c) out = n.agent.name; walk(k); }); all.forEach(walk); return out; };
  assert.strictEqual(findParent('c'), 'a', 'C stays under A');
  assert.ok(top.includes('a') || top.includes('b'), 'one of the loop is cut');
});

test('invalidLines: the lines whose removal leaves a valid graph', () => {
  const admins = new Set();
  const ok = [ag('m', { category: 'primary' }), ag('l', { reportsTo: 'm' }), ag('w', { reportsTo: 'l' })];
  assert.deepStrictEqual(T.invalidLines(ok, admins), []);
  // the main agent demoted: both lines no longer fit
  const demoted = [ag('m'), ag('l', { reportsTo: 'm' }), ag('w', { reportsTo: 'l' })];
  assert.deepStrictEqual(T.invalidLines(demoted, admins).sort(), ['l', 'w']);
  // a line across sides
  const sides = [ag('m', { category: 'primary', owner: 'u1' }), ag('x', { owner: 'u2', reportsTo: 'm' }), ag('y', { owner: 'u1', reportsTo: 'm' })];
  assert.deepStrictEqual(T.invalidLines(sides, admins), ['x']);
  // a loop: one line goes, the graph is valid after
  const loop = [ag('p', { reportsTo: 'q' }), ag('q', { reportsTo: 'p' })];
  const bad = T.invalidLines(loop, admins);
  assert.ok(bad.length >= 1);
  const left = loop.map(a => (bad.includes(a.name) ? { name: a.name, category: a.category } : a));
  assert.deepStrictEqual(T.invalidLines(left, admins), []);
  assert.deepStrictEqual(T.invalidLines(null, admins), []);
  // the input is not changed
  assert.strictEqual(demoted[1].reportsTo, 'm');
});

test('updateAgentField: reportsTo is checked on the final state of the patch, in any key order', async () => {
  for (const body of [{ category: 'primary', reportsTo: 'lead' }, { reportsTo: 'lead', category: 'primary' }]) {
    const a = load(FIXTURE());
    const r = await a.lib.updateAgentField('builder', body);
    assert.deepStrictEqual(r, { success: false, error: 'builder is a main agent; main agents report to nobody' });
    const b = a.readJson().find(x => x.name === 'builder');
    assert.ok(!('reportsTo' in b) && b.category !== 'primary', 'nothing of the refused patch is saved');
  }
  // a patch that fixes the problem itself passes: the boss's side changes in the same body
  const a = load([{ name: 'lead', category: 'primary', model: 'm', owner: 'u1' }, { name: 'builder', model: 'm', owner: 'u2' }]);
  assert.deepStrictEqual(await a.lib.updateAgentField('builder', { reportsTo: 'lead', owner: 'u1' }), { success: true });
  assert.strictEqual(a.boss('builder'), 'lead');
});

test('updateAgentField: a change of owner, sharing, category or lead clears the lines that no longer fit', async () => {
  const notes = [];
  const ctx = { notifyTeam: (t) => notes.push(t) };
  const base = () => [
    { name: 'lead', category: 'primary', model: 'm', owner: 'u1' },
    { name: 'builder', model: 'm', owner: 'u1', reportsTo: 'lead' },
    { name: 'coder', model: 'm', owner: 'u1', reportsTo: 'lead' },
    { name: 'sam', model: 'm', owner: 'u1', reportsTo: 'lead' },
  ];
  // the moved agent's own line
  let a = load(base());
  assert.deepStrictEqual(await a.lib.updateAgentField('builder', { owner: 'u2' }, ctx), { success: true });
  assert.ok(!('reportsTo' in a.readJson().find(x => x.name === 'builder')));
  assert.strictEqual(a.boss('coder'), 'lead');
  assert.deepStrictEqual(notes, ['Reporting lines cleared because they no longer fit the team rules: builder (was lead).']);
  // the boss moves: every line that became cross-side goes, in the same save
  notes.length = 0;
  a = load(base());
  assert.deepStrictEqual(await a.lib.updateAgentField('lead', { owner: 'u2' }, ctx), { success: true });
  for (const n of ['builder', 'coder', 'sam']) assert.ok(!('reportsTo' in a.readJson().find(x => x.name === n)), n);
  assert.deepStrictEqual(notes, ['Reporting lines cleared because they no longer fit the team rules: builder (was lead), coder (was lead), sam (was lead).']);
  // sharing removed: a member agent's line to a shared boss goes
  a = load([{ name: 'lead', category: 'primary', model: 'm', sharedWith: ['u1'] }, { name: 'builder', model: 'm', owner: 'u1', reportsTo: 'lead' }]);
  assert.strictEqual(a.boss('builder'), 'lead');
  assert.deepStrictEqual(await a.lib.updateAgentField('lead', { sharedWith: [] }), { success: true });
  assert.strictEqual(a.boss('builder'), undefined);
  // demoting a main agent with a two-level team below
  a = load([{ name: 'lead', category: 'primary', model: 'm' }, { name: 'leader', model: 'm', reportsTo: 'lead' }, { name: 'worker1', model: 'm', reportsTo: 'leader' }, { name: 'other', category: 'primary', model: 'm' }]);
  assert.deepStrictEqual(await a.lib.updateAgentField('lead', { category: 'specialist' }), { success: true });
  assert.strictEqual(a.boss('leader'), undefined);
  assert.strictEqual(a.boss('worker1'), undefined, 'a worker under a leader that is no longer under a main agent would be too deep');
  // a patch that changes none of those leaves other lines alone
  a = load(base());
  assert.deepStrictEqual(await a.lib.updateAgentField('lead', { blurb: 'hi' }), { success: true });
  assert.strictEqual(a.boss('builder'), 'lead');
});

test('updateAgentField: a leader never loses its boss while workers still report to it', async () => {
  const has = (a, n) => 'reportsTo' in a.readJson().find(x => x.name === n);
  // (a) the leader's boss is inferred from the main agent's buildPartner; clearing that leaves the worker without a leader
  let a = load([{ name: 'chief', category: 'primary', model: 'm', buildPartner: 'builder' }, { name: 'builder', model: 'm' }, { name: 'helper', model: 'm', reportsTo: 'builder' }]);
  assert.strictEqual(a.boss('helper'), 'builder');
  const notes = [];
  assert.deepStrictEqual(await a.lib.updateAgentField('chief', { buildPartner: null }, { notifyTeam: (t) => notes.push(t) }), { success: true });
  assert.ok(!has(a, 'helper'), 'the worker line is cleared in the same save');
  assert.strictEqual(notes.length, 1);
  assert.strictEqual(notes[0], 'Reporting lines cleared because they no longer fit the team rules: helper (was builder).');
  // (b) the leader's own line cleared (or changed)
  a = load([{ name: 'chief', category: 'primary', model: 'm' }, { name: 'builder', model: 'm', reportsTo: 'chief' }, { name: 'helper', model: 'm', reportsTo: 'builder' }]);
  assert.deepStrictEqual(await a.lib.updateAgentField('builder', { reportsTo: null }), { success: true });
  assert.ok(!has(a, 'builder') && !has(a, 'helper'));
  // (c) deleting the main agent clears the leader's and the worker's lines, in the same save
  a = load([{ name: 'chief', category: 'primary', model: 'm' }, { name: 'builder', model: 'm', reportsTo: 'chief' }, { name: 'helper', model: 'm', reportsTo: 'builder' }]);
  const del = await a.quiet(() => a.lib.deleteAgent('chief'));
  assert.strictEqual(del.success, true, JSON.stringify(del));
  assert.ok(!has(a, 'builder') && !has(a, 'helper'));
  assert.deepStrictEqual(del.clearedLines, ['helper']);
  // deleting a leader clears its workers
  a = load([{ name: 'chief', category: 'primary', model: 'm' }, { name: 'builder', model: 'm', reportsTo: 'chief' }, { name: 'helper', model: 'm', reportsTo: 'builder' }]);
  assert.strictEqual((await a.quiet(() => a.lib.deleteAgent('builder'))).success, true);
  assert.ok(!has(a, 'helper'));
  // (d) an unrelated patch leaves valid lines alone
  a = load([{ name: 'chief', category: 'primary', model: 'm' }, { name: 'builder', model: 'm', reportsTo: 'chief' }, { name: 'helper', model: 'm', reportsTo: 'builder' }]);
  assert.deepStrictEqual(await a.lib.updateAgentField('helper', { blurb: 'hi' }), { success: true });
  assert.strictEqual(a.boss('builder'), 'chief');
  assert.strictEqual(a.boss('helper'), 'builder');
});

test('server.js: team notices go out as "Team changed" with their own tag, not as lockbox security notices', () => {
  const s = read('lib/settings-apply.js');   // the context the PATCH route hands updateAgentField is built in lib/settings-apply agentWriteContext
  assert.match(s, /notifyTeam: \(text\) => require\('\.\/push'\)\.getPush\(\)\.notify\(\{ title: 'Team changed', body: text, tag: 'team-change' \}/);
  const l = read('lib/agents.js');
  assert.match(l, /ctx\.notifyTeam\(text\)/);
  assert.doesNotMatch(l.slice(l.indexOf('teamNotices.push')), /notices\.push\(`\$\{n\} no longer/);
});

test('brokenBy: only lines the change broke; lines already invalid before are not returned', () => {
  const T = require('../lib/ui-teams');
  const before = [
    { name: 'chief', category: 'primary', model: 'm', buildPartner: 'builder' },
    { name: 'builder', model: 'm' },
    { name: 'helper', model: 'm', reportsTo: 'builder' },
    { name: 'spec1', model: 'm' },
    { name: 'spec2', model: 'm', reportsTo: 'spec1' },   // already invalid: spec1 is not a leader
  ];
  assert.deepStrictEqual(T.invalidLines(before, new Set()), ['spec2']);
  const after = before.map(a => a.name === 'chief' ? { ...a, buildPartner: undefined } : a);
  assert.deepStrictEqual(T.brokenBy(before, after, new Set()), ['helper']);
  assert.deepStrictEqual(T.brokenBy(before, before, new Set()), []);
});

test('updateAgentField: a patch leaves lines that were already invalid; one notice lists every line it cleared', async () => {
  const notes = [];
  const a = load([
    { name: 'chief', category: 'primary', model: 'm', buildPartner: 'builder' },
    { name: 'builder', model: 'm' },
    { name: 'helper', model: 'm', reportsTo: 'builder' },
    { name: 'helper2', model: 'm', reportsTo: 'builder' },
    { name: 'spec1', model: 'm' },
    { name: 'spec2', model: 'm', reportsTo: 'spec1' },
  ]);
  assert.deepStrictEqual(await a.lib.updateAgentField('chief', { buildPartner: null }, { notifyTeam: (t) => notes.push(t) }), { success: true });
  assert.strictEqual(a.boss('spec2'), 'spec1', 'an earlier invalid line is left as it is');
  assert.strictEqual(a.boss('helper'), undefined);
  assert.strictEqual(a.boss('helper2'), undefined);
  assert.deepStrictEqual(notes, ['Reporting lines cleared because they no longer fit the team rules: helper (was builder), helper2 (was builder).']);
});

test('createAgent: a new main agent with the same build partner clears the lines it broke, in the same save', async () => {
  const a = load([
    { name: 'p1', category: 'primary', model: 'm', buildPartner: 'builder' },
    { name: 'builder', model: 'm' },
    { name: 'worker', model: 'm', reportsTo: 'builder' },
  ]);
  const r = await a.quiet(() => a.lib.createAgent('p2', 'm', null, null, 'primary', null, { buildPartner: 'builder' }));
  assert.strictEqual(r.success, true, JSON.stringify(r));
  assert.deepStrictEqual(r.clearedLines, ['worker']);
  assert.match(r.note, /Reporting lines cleared because they no longer fit the team rules: worker \(was builder\)\./);
  assert.strictEqual(a.boss('worker'), undefined);
  assert.strictEqual(a.readJson().find(x => x.name === 'p2').buildPartner, 'builder');
});

test('renameAgent and deleteAgent keep buildPartner in step with the name', async () => {
  const a = load([{ name: 'lead', category: 'primary', model: 'm', buildPartner: 'builder' }, { name: 'builder', model: 'm' }, { name: 'sam', category: 'primary', model: 'm', buildPartner: 'coder' }, { name: 'coder', model: 'm' }]);
  const bp = (n) => a.readJson().find(x => x.name === n).buildPartner;
  assert.strictEqual((await a.quiet(() => a.lib.renameAgent('builder', 'maker'))).success, true);
  assert.strictEqual(bp('lead'), 'maker');
  assert.strictEqual(bp('sam'), 'coder', 'others are not touched');
  const del = await a.quiet(() => a.lib.deleteAgent('maker'));
  assert.strictEqual(del.success, true, JSON.stringify(del));
  assert.ok(!('buildPartner' in a.readJson().find(x => x.name === 'lead')), 'removed, not left pointing at nobody');
  assert.strictEqual(bp('sam'), 'coder');
});

test('createAgent: the boss is checked again against the list right before the save', () => {
  const a = load(FIXTURE());
  const list = a.lib.getAgentsSync(true);
  const rec = { name: 'newbie', category: 'specialist', reportsTo: 'lead' };
  assert.strictEqual(a.lib.finalReportsToCheck(rec, list, new Set()), null);
  assert.strictEqual(rec.reportsTo, 'lead');
  // the boss was deleted between the first check and the save
  const gone = list.filter(x => x.name !== 'lead');
  const note = a.lib.finalReportsToCheck(rec, gone, new Set());
  assert.match(note, /newbie was created without reporting to lead: there is no agent named lead/);
  assert.ok(!('reportsTo' in rec), 'created without the line');
  assert.strictEqual(a.lib.finalReportsToCheck({ name: 'plain' }, list, new Set()), null);
  const src = read('lib/agents.js');
  assert.match(src, /let lineNote = finalReportsToCheck\(record, current\);[\s\S]*?teams\.brokenBy\([\s\S]*?current\.push\(record\);/);
  assert.match(src, /\.\.\.\(lineNote \? \{ note: lineNote \} : \{\}\)/);
});

test('brokenBy judges each line as it stands: an owner change breaks a worker line even when the leader line was already invalid (review r4)', () => {
  const t = require('../lib/ui-teams.js');
  const before = [
    { name: 'chief', category: 'primary' },
    { name: 'builder', category: 'worker', owner: 'u1', reportsTo: 'chief' },   // already cross-side: invalid before, left alone
    { name: 'worker', category: 'worker', owner: 'u1', reportsTo: 'builder' },
  ];
  assert.notStrictEqual(t.checkReportsTo('builder', 'chief', before, []), null);
  const after = before.map(a => (a.name === 'builder' ? Object.assign({}, a, { owner: 'u2' }) : a));
  assert.deepStrictEqual(t.brokenBy(before, after, []), ['worker']);
  // a cascade: the leader's valid line breaks, so the worker below it goes too
  const b2 = [{ name: 'chief', category: 'primary' }, { name: 'builder', category: 'worker', reportsTo: 'chief' }, { name: 'worker', category: 'worker', reportsTo: 'builder' }];
  const a2 = b2.map(a => (a.name === 'chief' ? Object.assign({}, a, { category: 'specialist' }) : a));
  assert.deepStrictEqual(t.brokenBy(b2, a2, []).sort(), ['builder', 'worker']);
});
