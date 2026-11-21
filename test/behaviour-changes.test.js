'use strict';
// Behaviour changes (lib/behaviour-changes.js): the state file, isOn, seeding on a fresh install, the start-up migration,
// the owner's decision, the three gates (team-guidance, starter-team, member-worker-models), the admin-only routes, the
// /changes page and the Settings link. Runs on a throwaway install (test/helpers/isolated-install.js) and temp folders:
// nothing under the real data/ is read or written.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { makeIsolatedInstall, REAL } = require('./helpers/isolated-install');

const ISO = makeIsolatedInstall('behaviour-changes-', { copy: ['templates/behaviour-changes.json'] });
const INST = ISO.inst;
const L = (p) => require(path.join(INST, 'lib', p));
const bc = L('behaviour-changes');
const access = L('access');
const read = (f) => fs.readFileSync(path.join(REAL, f), 'utf8');
const SDK = read('lib/sdk-chat.js');

const temps = [];
const tempDir = () => { const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'behaviour-changes-t-')); temps.push(d); return d; };
after(() => { for (const d of temps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
// A manifest of two entries (and one with an invalid id) in a temp folder, plus the state / agents files next to it.
const setup = () => {
  const d = tempDir();
  const manifestFile = path.join(d, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify({ changes: [{ id: 'alpha', title: 'Alpha' }, { id: 'beta-two', title: 'Beta' }, { id: 'Bad Id', title: 'x' }, { title: 'no id' }] }));
  return { d, manifestFile, stateFile: path.join(d, 'state.json'), agentsFile: path.join(d, 'agents.json') };
};
const put = (f, doc) => fs.writeFileSync(f, typeof doc === 'string' ? doc : JSON.stringify(doc));
const ent = (state, by = 'owner') => ({ state, by, at: '2026-01-01T00:00:00.000Z' });

test('manifest: the shipped file has the ten entries with every field; invalid ids are dropped', () => {
  const real = bc.manifest(path.join(REAL, 'templates', 'behaviour-changes.json'));
  // Owner, 06:09: work-check-ins and work-suggestions joined the five.
  assert.deepStrictEqual(real.map((e) => e.id), ['team-guidance', 'starter-team', 'member-worker-models', 'worker-proposals', 'ask-lead-for-workers', 'work-check-ins', 'work-suggestions', 'hand-off-guidance', 'protect-own-code', 'own-code-guidance']);   // ten entries: protect-own-code and own-code-guidance (lib/code-protect) joined the eight;   // hand-offs (lib/hand-offs): the rule to hand long work to a build partner
  for (const e of real) for (const k of ['title', 'changes', 'benefits', 'costs', 'check', 'on', 'off']) assert.ok(e[k], `${e.id}.${k}`);
  assert.deepStrictEqual(bc.manifest(setup().manifestFile).map((e) => e.id), ['alpha', 'beta-two']);
  assert.deepStrictEqual(bc.manifest(path.join(tempDir(), 'nope.json')), []);
});

test('readState: missing, unreadable variants and a good file', () => {
  const { stateFile } = setup();
  assert.deepStrictEqual(bc.readState(stateFile), { entries: {}, missing: true });
  for (const bad of ['{not json', '[]', '{}', '{"entries":[]}', '{"entries":"x"}', '{"entries":{"a":5}}', '{"entries":{"a":{"state":"maybe"}}}', '{"entries":{"a":{}}}', 'null']) {
    put(stateFile, bad);
    assert.deepStrictEqual(bc.readState(stateFile), { entries: {}, unreadable: true }, bad);
  }
  put(stateFile, { entries: { a: ent('on'), b: ent('pending', 'update'), c: ent('off') } });
  assert.deepStrictEqual(Object.keys(bc.readState(stateFile).entries), ['a', 'b', 'c']);
  assert.strictEqual(bc.readState(path.dirname(stateFile)).unreadable, true, 'a folder is unreadable, not missing');
});

test('isOn: true only for an entry that is on in a readable file', () => {
  const { stateFile } = setup();
  const on = (id) => bc.isOn(id, { stateFile });
  assert.strictEqual(on('alpha'), false, 'missing file');
  const f2 = path.join(path.dirname(stateFile), 's2.json'); put(f2, { entries: { a: ent('on'), p: ent('pending', 'update'), o: ent('off') } });
  const on2 = (id) => bc.isOn(id, { stateFile: f2 });   // each file is read fresh (the 2-second cache is per file)
  assert.deepStrictEqual(['a', 'p', 'o', 'zzz'].map(on2), [true, false, false, false]);
  const f3 = path.join(path.dirname(stateFile), 's3.json'); put(f3, '{broken');
  assert.strictEqual(bc.isOn('a', { stateFile: f3 }), false, 'unreadable');
});

test('isOn: the read is cached for 2 seconds, and decide clears it', async () => {
  const { stateFile, manifestFile } = setup();
  put(stateFile, { entries: { alpha: ent('on') } });
  assert.strictEqual(bc.isOn('alpha', { stateFile }), true);
  put(stateFile, { entries: { alpha: ent('off') } });   // changed behind its back
  assert.strictEqual(bc.isOn('alpha', { stateFile }), true, 'still the cached read');
  await bc.decide('alpha', 'off', { stateFile, manifestFile });
  assert.strictEqual(bc.isOn('alpha', { stateFile }), false, 'decide cleared it');
  await bc.decide('alpha', 'on', { stateFile, manifestFile });
  assert.strictEqual(bc.isOn('alpha', { stateFile }), true);
});

test('seedNew: every manifest entry on by new-install, and an existing file is never overwritten', () => {
  const { stateFile, manifestFile } = setup();
  assert.strictEqual(bc.seedNew({ stateFile, manifestFile }).seeded, true);
  assert.strictEqual(fs.statSync(stateFile).mode & 0o777, 0o600);
  const st = bc.readState(stateFile);
  assert.deepStrictEqual(Object.keys(st.entries), ['alpha', 'beta-two']);
  for (const e of Object.values(st.entries)) { assert.strictEqual(e.state, 'on'); assert.strictEqual(e.by, 'new-install'); assert.ok(!isNaN(Date.parse(e.at))); }
  put(stateFile, { entries: { alpha: ent('off') } });
  assert.strictEqual(bc.seedNew({ stateFile, manifestFile }).seeded, false);
  assert.deepStrictEqual(Object.keys(bc.readState(stateFile).entries), ['alpha']);
  assert.strictEqual(bc.readState(stateFile).entries.alpha.state, 'off');
  put(stateFile, '{broken');
  bc.seedNew({ stateFile, manifestFile });
  assert.strictEqual(fs.readFileSync(stateFile, 'utf8'), '{broken', 'an unreadable file is not replaced either');
});

test('migrate: an install that already has agents gets every entry pending by update', () => {
  const { stateFile, manifestFile, agentsFile } = setup();
  put(agentsFile, []);
  const r = bc.migrate({ agentsFile, stateFile, manifestFile });
  assert.deepStrictEqual(r.added, ['alpha', 'beta-two']);
  const st = bc.readState(stateFile).entries;
  for (const id of ['alpha', 'beta-two']) { assert.strictEqual(st[id].state, 'pending'); assert.strictEqual(st[id].by, 'update'); }
  assert.strictEqual(bc.isOn('alpha', { stateFile: path.join(path.dirname(stateFile), 'other.json') }), false);
  assert.strictEqual(fs.statSync(stateFile).mode & 0o777, 0o600);
  assert.deepStrictEqual(bc.migrate({ agentsFile, stateFile, manifestFile }).added, [], 'a second run adds nothing');
});

test('migrate: a fresh install (no agents.json) changes nothing; a new manifest id is pending; an unreadable file is left alone', () => {
  const a = setup();
  assert.deepStrictEqual(bc.migrate({ agentsFile: a.agentsFile, stateFile: a.stateFile, manifestFile: a.manifestFile }), { added: [] });
  assert.strictEqual(fs.existsSync(a.stateFile), false, 'nothing written: seedNew writes it');
  const b = setup();
  put(b.agentsFile, []);
  put(b.stateFile, { entries: { alpha: ent('on', 'new-install') } });
  assert.deepStrictEqual(bc.migrate({ agentsFile: b.agentsFile, stateFile: b.stateFile, manifestFile: b.manifestFile }).added, ['beta-two']);
  const st = bc.readState(b.stateFile).entries;
  assert.strictEqual(st.alpha.state, 'on', 'an existing decision is untouched');
  assert.strictEqual(st['beta-two'].state, 'pending');
  const c = setup();
  put(c.agentsFile, []);
  put(c.stateFile, '{broken');
  assert.deepStrictEqual(bc.migrate({ agentsFile: c.agentsFile, stateFile: c.stateFile, manifestFile: c.manifestFile }), { unreadable: true });
  assert.strictEqual(fs.readFileSync(c.stateFile, 'utf8'), '{broken');
});

test('decide: on and off are recorded by the owner (0600); unknown id, bad decision and an unreadable file are refused', async () => {
  const { stateFile, manifestFile, agentsFile } = setup();
  put(agentsFile, []);
  bc.migrate({ agentsFile, stateFile, manifestFile });
  const r = await bc.decide('alpha', 'on', { user: 'u1', stateFile, manifestFile });
  assert.strictEqual(r.state, 'on');
  let e = bc.readState(stateFile).entries.alpha;
  assert.deepStrictEqual([e.state, e.by, e.user], ['on', 'owner', 'u1']);
  assert.ok(!isNaN(Date.parse(e.at)));
  assert.strictEqual(fs.statSync(stateFile).mode & 0o777, 0o600);
  await bc.decide('alpha', 'off', { user: 'u1', stateFile, manifestFile });
  assert.strictEqual(bc.readState(stateFile).entries.alpha.state, 'off');
  assert.strictEqual(bc.readState(stateFile).entries['beta-two'].state, 'pending', 'the others are untouched');
  await assert.rejects(bc.decide('nope', 'on', { stateFile, manifestFile }), /no such change/);
  await assert.rejects(bc.decide('alpha', 'pending', { stateFile, manifestFile }));
  put(stateFile, '{broken');
  await assert.rejects(bc.decide('alpha', 'on', { stateFile, manifestFile }));
  assert.strictEqual(fs.readFileSync(stateFile, 'utf8'), '{broken', 'never overwritten');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(stateFile)).filter((n) => n.endsWith('.tmp')), [], 'no temp file left');
});

test('decide: two at once both land', async () => {
  const { stateFile, manifestFile } = setup();
  await Promise.all([bc.decide('alpha', 'on', { stateFile, manifestFile }), bc.decide('beta-two', 'off', { stateFile, manifestFile })]);
  const st = bc.readState(stateFile).entries;
  assert.deepStrictEqual([st.alpha.state, st['beta-two'].state], ['on', 'off']);
});

test('list: the entries with state (pending when absent), by and at; unreadable is flagged', async () => {
  const { stateFile, manifestFile } = setup();
  put(stateFile, { entries: { alpha: ent('on', 'new-install') } });
  const l = bc.list({ stateFile, manifestFile });
  assert.deepStrictEqual(l.map((c) => [c.id, c.state, c.by]), [['alpha', 'on', 'new-install'], ['beta-two', 'pending', undefined]]);
  assert.strictEqual(l[0].title, 'Alpha');
  put(stateFile, '{broken');
  assert.ok(bc.list({ stateFile, manifestFile }).every((c) => c.unreadable === true));
});

test('a fresh install: the first read of agents.json seeds the behaviour changes on (agents.js)', () => {
  assert.match(read('lib/agents.js'), /require\('\.\/behaviour-changes'\)\.seedNew\(\)/);
  assert.strictEqual(fs.existsSync(path.join(INST, 'data', 'agents.json')), false);
  L('agents.js').getAgentsSync();
  const st = bc.readState(path.join(INST, 'data', 'behaviour-reviews.json'));
  assert.deepStrictEqual(Object.keys(st.entries), bc.manifest().map((e) => e.id));
  assert.ok(Object.values(st.entries).every((e) => e.state === 'on' && e.by === 'new-install'));
  assert.deepStrictEqual(bc.migrate().added, [], 'and the start-up migration then adds nothing');
});

test('server.js: the migration runs right after the team-guidance migration, in a try/catch, and logs the waiting ids', () => {
  const server = read('server.js');
  const a = server.indexOf("require('./lib/agents').migrateTeamGuidance()");
  const b = server.indexOf("require('./lib/behaviour-changes').migrate(");
  assert.ok(a > 0 && b > a && b - a < 900);
  assert.match(server, /\[behaviour\] \$\{bm\.added\.length\} change\(s\) waiting for the owner's decision: \$\{bm\.added\.join\(', '\)\}/);
});

// ── the gates ──
const grab = (head) => {
  const i = SDK.indexOf(head);
  assert.ok(i >= 0, head);
  let depth = 0;
  for (let k = SDK.indexOf(') {', i) + 2; k < SDK.length; k++) { if (SDK[k] === '{') depth++; else if (SDK[k] === '}') { depth--; if (depth === 0) return SDK.slice(i, k + 1); } }
  throw new Error('unbalanced ' + head);
};

test('gate team-guidance: teamGuidanceTextFor is empty for every agent, the lead included, unless the entry is on', async () => {
  assert.match(grab('async function teamGuidanceTextFor('), /^async function teamGuidanceTextFor\(agentName\) \{\n\s+try \{\n[^\n]*\n\s+if \(!require\('\.\/behaviour-changes'\)\.isOn\('team-guidance'\)\) return '';/);
  let on = false;
  const ctx = {
    require: (p) => {
      if (p === './behaviour-changes') return { isOn: (id) => on && id === 'team-guidance' };
      if (p === './team-guidance') return { textFor: () => 'TEAM TEXT' };
      throw new Error('unexpected ' + p);
    },
    temporalWorkers: { isVirtual: () => false },
    getAgents: async () => [{ name: 'maestro', lead: true }, { name: 'sam' }],
    adminIdSet: () => new Set(), isLeadAgent: (n) => n === 'maestro',
  };
  vm.createContext(ctx);
  vm.runInContext(grab('async function teamGuidanceTextFor(') + '\nthis.f = teamGuidanceTextFor;', ctx);
  for (const n of ['maestro', 'sam']) assert.strictEqual(await ctx.f(n), '', `${n}: off`);
  on = true;
  for (const n of ['maestro', 'sam']) assert.strictEqual(await ctx.f(n), 'TEAM TEXT', `${n}: on`);
});

test('gate starter-team: cardState stops at "not turned on" before the ledger, the agents or any model lookup', async () => {
  const boom = () => { throw new Error('must not be called'); };
  const deps = { getAgents: boom, getAvailableModels: boom, welcomeUnfinished: boom, team: { readLedger: boom, planTeam: boom } };
  const card = L('team-card');
  // the real module, on this install's own state file (an earlier test seeded it on): turned off by a decision
  await bc.decide('starter-team', 'off');
  assert.deepStrictEqual(await card.cardState({}, deps), { status: 200, body: { ok: true, show: false, plan: [], reason: 'not turned on' } });
  assert.strictEqual((await card.cardState({ again: true }, deps)).body.reason, 'not turned on', 'also when asked again');
  assert.deepStrictEqual((await card.cardState({}, { ...deps, isOn: () => false })).body.reason, 'not turned on');
  assert.match(read('lib/team-card.js'), /async function cardState\([^\n]*\n[^\n]*\n[^\n]*\n[^\n]*isOn\('starter-team'\)[\s\S]{0,200}return \{ status: 200, body: \{ ok: true, show: false, plan: \[\], reason: 'not turned on' \} \};\n  const ledger = /);
});

test('gate member-worker-models: no limit only while off, pending or not recorded; on or an unreadable file keeps the limit', () => {
  // Review r1 (GPT-6 B3): a limit the owner turned on never fails open when the state file can't be read.
  assert.match(grab('function memberWorkerModels('), /lim = require\('\.\/behaviour-changes'\)\.stateOf\('member-worker-models'\);[\s\S]*?if \(lim === 'off' \|\| lim === 'pending' \|\| lim === 'missing'\) return null;/);
  let state = 'off';
  const ctx = {
    require: (p) => {
      if (p === './behaviour-changes') return { stateOf: (id) => (id === 'member-worker-models' ? state : 'missing') };
      if (p === './agents') return { getAgentsSync: () => [{ name: 'sams_helper', model: 'a/x', owner: 'sam1' }] };
      if (p === './member-models') return { workerModels: (own) => [own] };
      throw new Error('unexpected ' + p);
    },
    resolveVirtualAgent: () => null, adminIdSet: () => new Set(['admin1']),
    temporalWorkers: { isSelfCheck: () => false },
    isMemberTurn: () => false,   // member origin (test/member-origin.test.js): no member's turn here
  };
  vm.createContext(ctx);
  vm.runInContext(grab('function memberWorkerModels(') + '\nthis.f = memberWorkerModels;', ctx);
  for (const s of ['off', 'pending', 'missing']) { state = s; assert.strictEqual(ctx.f('sams_helper'), null, s + ': no limit, as before'); }
  state = 'on';
  assert.deepStrictEqual([...ctx.f('sams_helper')], ['a/x']);
  assert.deepStrictEqual([...ctx.f('nobody')], [], 'on: fails closed as before');
  state = 'unreadable';
  assert.deepStrictEqual([...ctx.f('sams_helper')], ['a/x'], 'unreadable: the limit stays');
});

// ── routes, page, Settings ──
test('routes: both behaviour-changes routes and the page are admin only; the page is served and wired', () => {
  assert.deepStrictEqual(access.classifyRoute('/api/behaviour-changes', 'GET'), { kind: 'admin' });
  assert.deepStrictEqual(access.classifyRoute('/api/behaviour-changes/team-guidance', 'POST'), { kind: 'admin' });
  assert.deepStrictEqual(access.classifyRoute('/changes', 'GET'), { kind: 'admin', page: true });
  assert.deepStrictEqual(access.classifyRoute('/changes.html', 'GET'), { kind: 'admin', page: true });
  const server = read('server.js');
  assert.match(server, /pathname === '\/api\/behaviour-changes' && req\.method === 'GET'/);
  assert.match(server, /pathname\.match\(\/\^\\\/api\\\/behaviour-changes\\\/\(\[a-z\]\[a-z0-9-\]\{1,40\}\)\$\/\)/);
  assert.match(server, /pathname === '\/changes'\) \{\n\s+filePath = path\.join\(__dirname, 'changes\.html'\)/);
  assert.match(server, /\[behaviour\] \$\{m\[1\]\} turned \$\{b\.decision\} by /);
  for (const code of ['400', '404', '409']) assert.ok(server.includes(`jsonResponse(res, ${code}, `) );
  const sf = L('static-files');
  assert.strictEqual(sf.resolve('/changes.html', REAL), fs.realpathSync(path.join(REAL, 'changes.html')));
});

test('changes.html: pending first, then decided; each entry has the change id and its labelled paragraphs; text nodes only', () => {
  const html = read('changes.html');
  assert.match(html, /<title>Changes waiting for your decision<\/title>/);
  assert.ok(html.indexOf('Waiting for your decision</h2>') < html.indexOf('Decided</h2>'));
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(html), 'nothing from the server goes in as markup');
  assert.match(html, /el\.id = c\.id;/);
  for (const label of ['What it changes', 'Benefits', 'Costs', 'When on', 'When off']) assert.ok(html.includes(`'${label}'`), label);
  for (const text of ["'Waiting for your decision'", "'On (new install)'", "'On since '", "'Left off on '", "'Turn on'", "'Leave off'", "'Turn off'", "'Set up your team now'", "'/?team=setup'"]) assert.ok(html.includes(text), text);
  assert.match(html, /c\.id === 'starter-team' && c\.state === 'on'/);
  assert.match(html, /'\/api\/behaviour-changes\/' \+ encodeURIComponent\(c\.id\)/);
  assert.match(html, /location\.hash/);
  assert.match(html, /scrollIntoView/);
  assert.match(html, /--bg-dark: #090B0F;/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /flex-wrap: wrap/);
  // the page script, run against a tiny DOM: the entry carries the id, the state words and a button per state
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const mk = (tag) => { const el = { tag, children: [], _t: '', attrs: {}, listeners: {}, classList: { add() {}, remove() {}, contains: () => false },
    appendChild(c) { this.children.push(c); return c; }, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, f) { this.listeners[k] = f; }, scrollIntoView() {},
    set textContent(v) { this._t = String(v); if (v === '') this.children = []; }, get textContent() { return this._t + this.children.map((c) => c.textContent).join(''); } }; return el; };
  const byId = { msg: mk('div'), pending: mk('div'), decided: mk('div'), 'pending-sec': mk('section'), 'decided-sec': mk('section') };
  const sent = [];
  const doc = { getElementById: (id) => byId[id] || null, createElement: mk, createTextNode: (t) => ({ textContent: String(t), children: [] }) };
  const payload = { ok: true, changes: [
    { id: 'team-guidance', title: 'T1 <b>x</b>', changes: 'c1', benefits: 'b1', costs: 'k1', on: 'o1', off: 'f1', state: 'pending', by: 'update', at: '2026-01-02T00:00:00.000Z' },
    { id: 'starter-team', title: 'T2', changes: 'c2', benefits: 'b2', costs: 'k2', on: 'o2', off: 'f2', state: 'on', by: 'new-install', at: '2026-01-02T00:00:00.000Z' }] };
  const ctx = { document: doc, location: { hash: '' }, setTimeout() {}, decodeURIComponent, encodeURIComponent, Date, isNaN, String, Array, Promise,
    fetch: async (u, o) => { sent.push([u, o && o.method]); return { ok: true, status: 200, json: async () => payload }; } };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  return new Promise((resolve) => setTimeout(resolve, 20)).then(() => {
    assert.deepStrictEqual(sent[0], ['/api/behaviour-changes', undefined]);
    const [p] = byId.pending.children, [d] = byId.decided.children;
    assert.strictEqual(p.id, 'team-guidance');
    assert.strictEqual(d.id, 'starter-team');
    assert.ok(p.textContent.includes('T1 <b>x</b>'), 'shown as text');
    assert.ok(p.textContent.includes('Waiting for your decision') && p.textContent.includes('What it changes: c1'));
    assert.ok(d.textContent.includes('On (new install)'));
    const labels = (el) => { const out = []; const walk = (n) => { if (n.tag === 'button') out.push(n._t); (n.children || []).forEach(walk); }; walk(el); return out; };
    assert.deepStrictEqual(labels(p), ['Turn on', 'Leave off']);
    assert.deepStrictEqual(labels(d), ['Turn off']);
    assert.ok(d.textContent.includes('Set up your team now') && !p.textContent.includes('Set up your team now'));
    assert.strictEqual(byId['pending-sec'].hidden, false);
  });
});

test('Settings: the admin quick links carry the Changes link, counted when something is waiting', () => {
  const app = read('app.js');
  assert.match(app, /id="st-quick-links"[^\n]*<a href="\/changes" id="st-changes-link"[^\n]*>Changes to how agents behave<\/a>/);
  assert.match(app, /fetch\('\/api\/behaviour-changes'\)[\s\S]{0,300}c\.state === 'pending'[\s\S]{0,200}Changes waiting for your decision \(\$\{n\}\)/);
});

// Review r1 (Sonnet F1; GPT-6 B3; GPT-6 B1 / Sentinel F1).
// Review r2 (GPT-6 BLOCK): accounts say nothing about a new install (a single-password install has none). The release
// bundle ships no agents list, so a bundle install seeds one and is recorded as new; an install with an agents list and
// no state file is an existing one.
test('r2: an install with an agents list and no state file is existing, accounts or not; the bundle ships no agents list', () => {
  const d = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'bc-legacy-'));
  try {
    const agentsFile = path.join(d, 'agents.json'), stateFile = path.join(d, 'behaviour-reviews.json');
    fs.writeFileSync(agentsFile, '[{"name":"maestro","lead":true}]');
    const r = bc.migrate({ agentsFile, stateFile, manifestFile: bc.MANIFEST_FILE });
    assert.strictEqual(r.added.length, bc.manifest().length);
    assert.ok(bc.list({ stateFile }).every(e => e.state === 'pending'));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
  const bundle = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'clean-bundle.sh'), 'utf8').replace(/^#.*$/gm, '');
  assert.ok(!/agents\.json/.test(bundle), 'the bundle writes no agents list');
});
test('r1: stateOf tells on, off, pending, missing and unreadable apart; isOn only for on', () => {
  const d = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'bc-state-'));
  try {
    const f = path.join(d, 's.json');
    assert.strictEqual(bc.stateOf('team-guidance', { stateFile: f }), 'missing');
    const u = path.join(d, 'u.json');   // its own file: reads are cached for 2 seconds per file
    fs.writeFileSync(u, '{ broken');
    assert.strictEqual(bc.stateOf('team-guidance', { stateFile: u }), 'unreadable');
    const g = path.join(d, 't.json');
    fs.writeFileSync(g, JSON.stringify({ entries: { 'team-guidance': { state: 'pending' }, 'starter-team': { state: 'off' }, 'worker-proposals': { state: 'on' } } }));
    assert.deepStrictEqual(['team-guidance', 'starter-team', 'worker-proposals', 'ask-lead-for-workers'].map(id => bc.stateOf(id, { stateFile: g })), ['pending', 'off', 'on', 'missing']);
    assert.strictEqual(bc.isOn('worker-proposals', { stateFile: g }), true);
    assert.strictEqual(bc.isOn('team-guidance', { stateFile: g }), false);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
test('r1: the three decision routes take a signed-in admin browser session only (never the hub service, a token or an agent)', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const guard = "if (!require('./lib/access').isAdminSession(req)) return jsonResponse(res, 403";
  const cad = server.indexOf("pathname === '/api/behaviour-changes/worker-proposals/cadence' && req.method === 'POST'");
  const dec = server.indexOf("const m = pathname.match(/^\\/api\\/behaviour-changes\\/([a-z][a-z0-9-]{1,40})$/);");
  assert.ok(cad > 0 && dec > 0);
  assert.ok(server.indexOf(guard, cad) > cad && server.indexOf(guard, cad) < server.indexOf('authJson()', cad), 'cadence: guarded before the body is read');
  assert.ok(server.indexOf(guard, dec) > dec && server.indexOf(guard, dec) < server.indexOf('authJson()', dec), 'decision: guarded before the body is read');
  const ls = require(path.join(__dirname, '..', 'lib', 'access.js'));
  assert.strictEqual(ls.isAdminSession({ hubIdentKind: 'user', hubUser: { role: 'admin' } }), true);
  assert.strictEqual(ls.isAdminSession({ hubService: true, hubUser: null }), false);
  assert.strictEqual(ls.isAdminSession({ hubIdentKind: 'user', hubUser: { role: 'admin' }, hubToken: {} }), false);
  assert.strictEqual(ls.isAdminSession({ hubIdentKind: 'user', hubUser: { role: 'admin' }, hubPendingTotp: true }), false);
});
