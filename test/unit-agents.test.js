'use strict';
// Behavioural unit tests for lib/agents.js. agents.js has fixed paths (<hub>/data/agents.json, <hub>/workspaces) and no env override,
// so each test copies lib/ + package.json into a fresh temp "hub" dir and requires the copy. gateway-client is stubbed: no model is ever called.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const REAL_LIB = path.join(__dirname, '..', 'lib');
const REAL_ROOT = path.join(__dirname, '..');
const roots = [];
const saved = { mem: process.env.HUB_MEMORY_DB, auth: process.env.HUB_AUTH_DIR };

function load({ agents, example, llm } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-agents-'));
  roots.push(root);
  const hub = path.join(root, 'hub');                       // files.js puts share/, users/, medical/ next to the hub dir -> inside `root`
  fs.mkdirSync(path.join(root, 'share'));                   // an existing install's layout: share/ beside it keeps the hub home there (lib/hub-home)
  fs.cpSync(REAL_LIB, path.join(hub, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(REAL_ROOT, 'package.json'), path.join(hub, 'package.json'));
  fs.symlinkSync(path.join(REAL_ROOT, 'node_modules'), path.join(hub, 'node_modules'));
  fs.mkdirSync(path.join(hub, 'data'), { recursive: true });
  if (agents !== undefined) fs.writeFileSync(path.join(hub, 'data', 'agents.json'), typeof agents === 'string' ? agents : JSON.stringify(agents));
  if (example) fs.writeFileSync(path.join(hub, 'data', 'agents.example.json'), JSON.stringify(example));
  process.env.HUB_MEMORY_DB = path.join(hub, 'data', 'memory.db');
  process.env.HUB_AUTH_DIR = path.join(hub, 'data');
  const calls = [];
  const gw = new Module(path.join(hub, 'lib', 'gateway-client.js'));
  gw.filename = gw.id; gw.loaded = true;
  gw.exports = { listModels: async () => { calls.push('listModels'); return ['claude-sdk/x', 'text-embedding-3', 'whisper-1', 'gpt-5']; },
                 chatCompletion: async (...a) => { calls.push(a); if (llm instanceof Error) throw llm; return llm; } };
  require.cache[gw.id] = gw;
  const quiet = (fn) => async (...a) => { const e = console.error; console.error = () => {}; try { return await fn(...a); } finally { console.error = e; } };
  const ag = require(path.join(hub, 'lib', 'agents.js'));
  // A removal's box step would reach Docker: a stand-in that has no boxes (tests that need one set their own).
  const boxes = [], removed = [];
  ag.__archive.configure({ sandbox: () => ({ retire: async (agent) => { boxes.push(agent.name); return { result: 'no Docker here' }; }, remove: async (agent) => { removed.push({ ...agent }); } }), isBoxed: () => false, log: () => {} });
  ag.createAgent = quiet(ag.createAgent); ag.loadAgentContext = quiet(ag.loadAgentContext);
  const readJson = () => JSON.parse(fs.readFileSync(path.join(hub, 'data', 'agents.json'), 'utf8'));
  const auth = () => require(path.join(hub, 'lib', 'auth.js')).getAuth();
  const bundles = () => { try { return fs.readdirSync(path.join(hub, 'data', 'archived-agents')).sort(); } catch { return []; } };
  return { ag, hub, root, calls, readJson, auth, boxes, removed, bundles, ws: (n) => path.join(hub, 'workspaces', n) };
}
test.after(() => {
  for (const [k, v] of [['HUB_MEMORY_DB', saved.mem], ['HUB_AUTH_DIR', saved.auth]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});
const reply = (obj) => ({ choices: [{ message: { content: typeof obj === 'string' ? obj : JSON.stringify(obj) } }] });
const FOUR = { 'IDENTITY.md': '# I', 'SOUL.md': '# S', 'TOOLS.md': '# T', 'USER.md': '# U' };

test('first run: no agents.json seeds from agents.example.json, else a default maestro; both are written to disk', () => {
  const a = load({ example: [{ name: 'zed', model: 'm1' }, { name: 'abe' }] });
  assert.deepStrictEqual(a.ag.getAgentsSync().map(x => x.name), ['abe', 'zed']);
  assert.deepStrictEqual(a.readJson().map(x => x.name), ['zed', 'abe'], 'seed written as-is');
  const b = load();
  const [m] = b.ag.getAgentsSync();
  assert.deepStrictEqual([m.name, m.model, m.display, m.category], ['maestro', 'claude-sdk/default', 'Maestro', 'primary']);
  assert.strictEqual(b.readJson()[0].name, 'maestro');
});

test('a corrupt agents.json is never overwritten: the file is left for a human, the .bak copy is used if present, else an empty list', () => {
  const a = load({ agents: '{ not json' });
  const errs = []; const orig = console.error; console.error = (...x) => errs.push(x.join(' '));
  try {
    assert.deepStrictEqual(a.ag.getAgentsSync().map(x => x.name), []);
  } finally { console.error = orig; }
  assert.ok(errs.some(e => /unreadable/.test(e)), 'loud about it');
  assert.ok(fs.readFileSync(path.join(a.hub, 'data', 'agents.json'), 'utf8').includes('not json'), 'file preserved for repair');
  // Every save keeps the previous good file as .bak and writes atomically.
  const b = load({ agents: [{ name: 'one', model: 'm' }] });
  b.ag.getAgentsSync();
  fs.writeFileSync(path.join(b.hub, 'data', 'agents.json'), JSON.stringify([{ name: 'one', model: 'm' }, { name: 'two', model: 'm' }]));
  assert.ok(!fs.existsSync(path.join(b.hub, 'data', 'agents.json.tmp-' + process.pid)), 'no temp file left behind');
});

test('getAgentsSync normalises records, fills defaults, sorts by name and points workspace into the hub', () => {
  const a = load({ agents: [
    { name: 'zoe', owner: 42, sharedWith: [1, 'u_2'], blurb: 'x'.repeat(200), model: 'claude-opus-5', autoModel: 1, noTools: 1, contextBudget: 5000 },
    { name: 'alice' },
    { name: 'bob', lead: true, owner: '', sharedWith: 'nope', blurb: 7, policy: 'bad', category: 'primary' },
  ] });
  const [al, bo, zo] = a.ag.getAgentsSync();
  assert.deepStrictEqual([al.name, bo.name, zo.name], ['alice', 'bob', 'zoe']);
  assert.deepStrictEqual([al.model, al.display, al.type, al.category, al.owner, al.sharedWith, al.blurb, al.modelStatus],
    ['claude-sonnet-4-6', 'Alice', 'normal', 'specialist', null, [], '', 'no_model']);
  assert.ok(al.icon && typeof al.icon === 'string');
  assert.deepStrictEqual([bo.lead, bo.owner, bo.sharedWith, bo.blurb, bo.policy], [true, null, [], '', undefined]);
  assert.deepStrictEqual([zo.owner, zo.sharedWith, zo.blurb.length, zo.modelStatus, zo.autoModel, zo.noTools, zo.contextBudget], ['42', ['1', 'u_2'], 200, 'ok', true, true, 5000]);
  assert.strictEqual(zo.workspace, a.ws('zoe'));
});

test('cache: repeat reads return the same list until forceReload or a mutation; mutations persist to disk', async () => {
  const a = load({ agents: [{ name: 'a1' }] });
  const first = a.ag.getAgentsSync();
  fs.writeFileSync(path.join(a.hub, 'data', 'agents.json'), JSON.stringify([{ name: 'a1' }, { name: 'a2' }]));
  assert.strictEqual(a.ag.getAgentsSync(), first, 'cached for the TTL');
  assert.strictEqual(a.ag.getAgentsSync(true).length, 2, 'forceReload re-reads disk');
  assert.strictEqual((await a.ag.getAgents()).length, 2);
  assert.deepStrictEqual(await a.ag.setAgentModel('a1', 'gpt-5'), { success: true });
  assert.strictEqual(a.ag.getAgentsSync().find(x => x.name === 'a1').model, 'gpt-5', 'mutation invalidates the cache');
  assert.strictEqual(a.readJson().find(x => x.name === 'a1').model, 'gpt-5');
  assert.deepStrictEqual(await a.ag.setAgentModel('ghost', 'x'), { success: false, error: 'Agent not found' });
  assert.strictEqual(await a.ag.getAgentModel('a2'), 'claude-sonnet-4-6');
  assert.strictEqual(await a.ag.getAgentModel('ghost'), 'claude-sonnet-4-6');
});

test('lead agents: flagged leads win, else category primary, else the legacy "maestro" name', () => {
  const { ag } = load({ agents: [{ name: 'maestro' }] });
  const mk = (...xs) => xs.map(([name, extra]) => ({ name, ...extra }));
  assert.deepStrictEqual(ag.leadAgentNames(mk(['a', { lead: true }], ['b', { category: 'primary' }])), ['a']);
  assert.deepStrictEqual(ag.leadAgentNames(mk(['a', {}], ['b', { category: 'primary' }])), ['b']);
  assert.deepStrictEqual(ag.leadAgentNames(mk(['a', {}])), []);
  assert.strictEqual(ag.isLeadAgent('maestro', mk(['a', {}])), true, 'legacy fallback');
  assert.strictEqual(ag.isLeadAgent('a', mk(['a', {}])), false);
  assert.strictEqual(ag.isLeadAgent('', mk(['a', { lead: true }])), false);
  assert.strictEqual(ag.defaultLeadAgent(mk(['z', { lead: true }], ['maestro', { lead: true }])), 'maestro');
  assert.strictEqual(ag.defaultLeadAgent(mk(['z', { lead: true }])), 'z');
  assert.strictEqual(ag.defaultLeadAgent([]), 'maestro');
});

test('createAgent: validation, duplicates, default files, owner recorded, no model call without a personality', async () => {
  const a = load({ agents: [{ name: 'maestro' }] });
  for (const bad of ['', 'Bad', '1abc', 'a-b', 'a b', null]) assert.strictEqual((await a.ag.createAgent(bad)).success, false, String(bad));
  // an underscore is allowed: a member's agents are named <login>_<name> (lib/agent-requests)
  assert.strictEqual((await a.ag.createAgent('owner_helper', 'claude-sdk/x', '', null, 'specialist')).success, true);
  assert.deepStrictEqual(await a.ag.createAgent('maestro'), { success: false, error: 'Agent already exists' });
  assert.deepStrictEqual(await a.ag.createAgent('kid1', undefined, '', '', 'worker', 'u_7'), { success: true, name: 'kid1' });
  const rec = a.readJson().find(x => x.name === 'kid1');
  assert.deepStrictEqual([rec.owner, rec.category, rec.model, rec.display, rec.type], ['u_7', 'worker', 'claude-sonnet-4-6', 'Kid1', 'normal']);
  assert.match(fs.readFileSync(path.join(a.ws('kid1'), 'IDENTITY.md'), 'utf8'), /## Name\nKid1\n\n## Role\nA helpful AI assistant\./);
  assert.strictEqual(fs.readFileSync(path.join(a.ws('kid1'), 'SOUL.md'), 'utf8'), 'You are Kid1, a helpful AI assistant.\n');
  await a.ag.createAgent('plain');
  assert.ok(!('owner' in a.readJson().find(x => x.name === 'plain')), 'no owner key = infrastructure');
  assert.strictEqual(a.readJson().find(x => x.name === 'plain').category, 'specialist');
  assert.deepStrictEqual(a.calls, [], 'generatePersonalityFiles was never reached');
  // An explicit null model (a JSON API body without "model") means "the default", same as omitted.
  const nm = await a.ag.createAgent('nullmodel', null);
  assert.strictEqual(nm.success, true);
  assert.ok(a.readJson().some(x => x.name === 'nullmodel' && typeof x.model === 'string' && x.model));
});

test('createAgent with a personality: stubbed model output (also fenced JSON) becomes the workspace files; failures fall back to basic files', async () => {
  const ok = load({ agents: [], llm: reply(FOUR) });
  assert.strictEqual((await ok.ag.createAgent('gen', 'gpt-5', 'a poet', 'rhyme')).success, true);
  for (const [f, c] of Object.entries(FOUR)) assert.strictEqual(fs.readFileSync(path.join(ok.ws('gen'), f), 'utf8'), c);
  assert.strictEqual(ok.calls.length, 1);
  assert.strictEqual(ok.calls[0][1].model, 'claude-haiku-4-5');
  assert.match(ok.calls[0][0][0].content, /Internal name: gen[^]*LLM model: gpt-5[^]*a poet[^]*Specialty skills\/knowledge: rhyme/);
  const fenced = load({ agents: [], llm: reply('```json\n' + JSON.stringify(FOUR) + '\n```') });
  await fenced.ag.createAgent('fen', undefined, 'p');
  assert.strictEqual(fs.readFileSync(path.join(fenced.ws('fen'), 'TOOLS.md'), 'utf8'), '# T');
  const bad = { garbage: reply('not json'), empty: { choices: [] }, missing: reply({ 'IDENTITY.md': 'x' }), thrown: new Error('gateway down') };
  for (const [label, llm] of Object.entries(bad)) {
    const b = load({ agents: [], llm });
    assert.strictEqual((await b.ag.createAgent('fb', undefined, 'a pirate')).success, true, label);
    assert.match(fs.readFileSync(path.join(b.ws('fb'), 'IDENTITY.md'), 'utf8'), /## Role\na pirate/, label);
    assert.strictEqual(fs.readFileSync(path.join(b.ws('fb'), 'SOUL.md'), 'utf8'), 'You are Fb. a pirate\n', label);
    assert.ok(!fs.existsSync(path.join(b.ws('fb'), 'TOOLS.md')), label);
  }
});

test('setAgentDisplay trims, falls back to the capitalised name when blank, and reports unknown agents', async () => {
  const a = load({ agents: [{ name: 'dave', display: 'Old' }] });
  assert.deepStrictEqual(await a.ag.setAgentDisplay('dave', '  Dave the Great  '), { success: true, display: 'Dave the Great' });
  assert.strictEqual(a.readJson()[0].display, 'Dave the Great');
  assert.deepStrictEqual(await a.ag.setAgentDisplay('dave', '   '), { success: true, display: 'Dave' });
  assert.deepStrictEqual(await a.ag.setAgentDisplay('nobody', 'x'), { success: false, error: 'Agent not found' });
  assert.deepStrictEqual(await a.ag.setAgentIcon('dave', 'X'), { success: true, icon: 'X' });
  assert.ok((await a.ag.setAgentIcon('dave', '')).icon, 'blank icon is auto-generated');
});

test('getAgentWorkspace, getAgentFiles / saveAgentFile: only whitelisted file names, nothing outside the workspace', async () => {
  const a = load({ agents: [{ name: 'w1' }] });
  assert.strictEqual(await a.ag.getAgentWorkspace('w1'), a.ws('w1'));
  assert.strictEqual(await a.ag.getAgentWorkspace('unlisted'), a.ws('unlisted'), 'path only; does not require a record');
  assert.deepStrictEqual(await a.ag.getAgentFiles('w1'), {});
  assert.deepStrictEqual(await a.ag.saveAgentFile('w1', 'SOUL.md', 'hello'), { success: true });
  assert.deepStrictEqual(await a.ag.saveAgentFile('w1', '../../evil.md', 'x'), { success: false, error: 'Invalid filename' });
  assert.deepStrictEqual(await a.ag.saveAgentFile('w1', 'package.json', 'x'), { success: false, error: 'Invalid filename' });
  assert.deepStrictEqual(await a.ag.getAgentFiles('w1'), { 'SOUL.md': 'hello' });
  assert.ok(!fs.existsSync(path.join(a.hub, '..', 'evil.md')));
});

test('loadAgentContext: sections in order with the runtime model, Files folder and authoritative model line; channel context appended', async () => {
  const a = load({ agents: [{ name: 'ctx', model: 'claude-sdk/claude-opus-5', autoModel: true }] });
  const put = (f, c) => { fs.mkdirSync(a.ws('ctx'), { recursive: true }); fs.writeFileSync(path.join(a.ws('ctx'), f), c); };
  put('IDENTITY.md', 'I am ctx'); put('SOUL.md', 'be brief'); put('USER.md', '  the user  '); put('TOOLS.md', '');
  const out = await a.ag.loadAgentContext('ctx', 'hub');
  const idx = ['# Identity\nI am ctx', '## Model (runtime)\nclaude-sdk/claude-opus-5 (with auto-model routing)', '# Soul\nbe brief', '# User Context\nthe user', '## Files folder\n', '# AUTHORITATIVE MODEL INFO', '## Communication Channel'].map(s => out.indexOf(s));
  assert.ok(idx.every(i => i >= 0), JSON.stringify(idx));
  assert.deepStrictEqual([...idx].sort((x, y) => x - y), idx, 'order: identity, model, soul, user, files, model info, channel');
  assert.ok(!out.includes('# Tools & Environment'), 'empty TOOLS.md is skipped');
  assert.ok(out.includes(`## Files folder\n${path.join(a.root, 'share', 'ctx')}\n`));
  assert.match(out, /You are running as \*\*claude-sdk\/claude-opus-5\*\* \(opus-5\)\./);
  assert.ok(!(await a.ag.loadAgentContext('ctx')).includes('## Communication Channel'));
  assert.ok(!(await a.ag.loadAgentContext('ctx', 'nope')).includes('## Communication Channel'));
  assert.ok((await a.ag.loadAgentContext('ctx', 'api')).includes('OpenAI-compatible API'));
});

test('loadAgentContext lightweight / minimalContext: identity + soul only, no files folder; minimal also skips memory', async () => {
  const a = load({ agents: [{ name: 'lite', model: 'm1' }] });
  fs.mkdirSync(a.ws('lite'), { recursive: true });
  for (const [f, c] of [['IDENTITY.md', 'id'], ['SOUL.md', 'soul'], ['USER.md', 'usr'], ['TOOLS.md', 'tls']]) fs.writeFileSync(path.join(a.ws('lite'), f), c);
  require(path.join(a.hub, 'lib', 'memory-db.js')).writeLongTermMemory('lite', 'REMEMBERED');
  const light = await a.ag.loadAgentContext('lite', null, { lightweight: true });
  assert.ok(light.includes('# Identity') && light.includes('# Soul') && !light.includes('# User Context') && !light.includes('Files folder'));
  assert.ok(light.includes('REMEMBERED'), 'lightweight still loads memory');
  const min = await a.ag.loadAgentContext('lite', null, { minimalContext: true });
  assert.ok(min.includes('# Soul') && !min.includes('REMEMBERED') && !min.includes('# Tools & Environment'));
  const empty = await a.ag.loadAgentContext('nobody-here');
  assert.ok(empty.includes('AUTHORITATIVE MODEL INFO') && !empty.includes('# Identity'));
});

test('shared pool scoping (sharedPoolFor): infra and admin-owned agents see the admin pool, member-owned agents only their owner\'s', async () => {
  const a = load({ agents: [{ name: 'infra1' }, { name: 'adm' }, { name: 'kid' }, { name: 'ghosted' }] });
  const au = a.auth();
  const admin = au.createUser({ login: 'a@x.com', role: 'admin' }).user || au.createUser({ login: 'a2@x.com', role: 'admin' }).user;
  const member = au.createUser({ login: 'm@x.com', role: 'member' }).user;
  assert.ok(admin && member, 'users created');
  await a.ag.updateAgentField('adm', { owner: admin.id });
  await a.ag.updateAgentField('kid', { owner: member.id });
  await a.ag.updateAgentField('ghosted', { owner: 'u_deleted' });
  const mem = require(path.join(a.hub, 'lib', 'memory-db.js'));
  mem.writeSharedMemory('admin-topic', 'ADMINBODY '.repeat(8), 'x');
  mem.writeSharedMemory('member-topic', 'MEMBERBODY '.repeat(8), 'x', [], member.id);
  const ctx = (n) => a.ag.loadAgentContext(n);
  for (const n of ['infra1', 'adm']) { const c = await ctx(n); assert.ok(c.includes('admin-topic') && !c.includes('member-topic'), n); }
  const k = await ctx('kid');
  assert.ok(k.includes('member-topic') && !k.includes('admin-topic'));
  assert.ok(k.includes(`## Files folder\n${path.join(a.root, 'users', member.id, 'files')}\n`), 'member files root');
  const g = await ctx('ghosted');
  assert.ok(!g.includes('admin-topic') && !g.includes('member-topic'), 'unknown owner id is treated as its own (empty) pool');
});

test('updateAgentField: allowed fields only, normalisation of owner / sharedWith / blurb / policy / lead / contextBudget', async () => {
  const a = load({ agents: [{ name: 'u1', owner: 'u_1', blurb: 'old' }] });
  const get = () => a.readJson()[0];
  assert.deepStrictEqual(await a.ag.updateAgentField('nope', { lead: true }), { success: false, error: 'Agent not found' });
  await a.ag.updateAgentField('u1', { model: 'hijack', name: 'renamed', category: 'worker', autoModel: 'yes', lead: 'true', sharedWith: ['a', 'a', '', 7] });
  assert.deepStrictEqual([get().model, get().name, get().category, get().autoModel, get().lead, get().sharedWith], [undefined, 'u1', 'worker', true, true, ['a', '7']]);
  await a.ag.updateAgentField('u1', { owner: 'infra', lead: false, sharedWith: [], blurb: '   ' });
  assert.ok(!('owner' in get()) && !('lead' in get()) && !('sharedWith' in get()) && !('blurb' in get()));
  await a.ag.updateAgentField('u1', { policy: { overrides: { send: 'deny', bogus: 'allow', web: 'maybe' }, roots: [' /tmp/x ', '', 5] } });
  assert.deepStrictEqual(get().policy, { overrides: { send: 'deny' }, roots: ['/tmp/x', '5'] });
  await a.ag.updateAgentField('u1', { policy: {} });
  assert.ok(!('policy' in get()));
  assert.deepStrictEqual(await a.ag.updateAgentField('u1', { contextBudget: '12.5' }), { success: false, error: 'contextBudget must be a positive whole number of tokens' });
  await a.ag.updateAgentField('u1', { contextBudget: '8000' });
  assert.strictEqual(get().contextBudget, 8000);
  await a.ag.updateAgentField('u1', { contextBudget: null });
  assert.ok(!('contextBudget' in get()));
});

test('delete / clone / rename: main is protected, workspaces follow, name collisions are refused', async () => {
  const a = load({ agents: [{ name: 'main' }, { name: 'src', model: 'mm', category: 'worker', owner: 'u_1' }] });
  fs.mkdirSync(a.ws('src'), { recursive: true });
  fs.writeFileSync(path.join(a.ws('src'), 'IDENTITY.md'), '**Name:** Src\nrest');
  assert.strictEqual((await a.ag.deleteAgent('main')).success, false);
  assert.strictEqual((await a.ag.deleteAgent('ghost')).error, 'Agent not found');
  assert.strictEqual((await a.ag.cloneAgent('src', 'Bad Name')).success, false);
  assert.strictEqual((await a.ag.cloneAgent('src', 'main')).error, 'Agent already exists');
  assert.deepStrictEqual(await a.ag.cloneAgent('src', 'copy-1'), { success: true, name: 'copy-1' });
  assert.strictEqual(fs.readFileSync(path.join(a.ws('copy-1'), 'IDENTITY.md'), 'utf8'), '**Name:** Copy-1\nrest');
  const clone = a.readJson().find(x => x.name === 'copy-1');
  // A clone keeps category and owner (a member's agent stays that member's), never lead or sharedWith.
  assert.strictEqual(clone.name, 'copy-1'); assert.strictEqual(clone.model, 'mm'); assert.strictEqual(clone.display, 'Copy-1');
  assert.strictEqual(clone.owner, 'u_1');
  assert.ok(!('lead' in clone) && !('sharedWith' in clone));
  assert.deepStrictEqual(await a.ag.renameAgent('src', 'moved'), { success: true, newName: 'moved' });
  assert.ok(fs.existsSync(path.join(a.ws('moved'), 'IDENTITY.md')) && !fs.existsSync(a.ws('src')));
  assert.strictEqual(a.readJson().find(x => x.name === 'moved').owner, 'u_1');
  for (const [o, n] of [['main', 'x'], ['moved', 'moved'], ['moved', 'BAD'], ['ghost', 'fine'], ['moved', 'main']]) assert.strictEqual((await a.ag.renameAgent(o, n)).success, false, `${o}->${n}`);
  const del = await a.ag.deleteAgent('copy-1');
  assert.strictEqual(del.success, true); assert.ok(!del.unfinished, JSON.stringify(del));
  assert.match(del.keptIn, /^data\/archived-agents\/copy-1-\d{8}T\d{6}Z$/);
  assert.ok(!a.readJson().some(x => x.name === 'copy-1'));
  assert.ok(!fs.existsSync(a.ws('copy-1')) && fs.existsSync(path.join(a.hub, del.keptIn, 'workspace', 'IDENTITY.md')), 'its folder went into the bundle');
});

test('getAvailableModels filters non-chat models; seedDefaultWorkspaces never overwrites a customised file', async () => {
  const a = load({ agents: [] });
  assert.deepStrictEqual(await a.ag.getAvailableModels(), ['claude-sdk/x', 'gpt-5']);
  const tpl = path.join(a.root, 'tpl'), wsd = path.join(a.root, 'wsd');
  fs.mkdirSync(path.join(tpl, 'bot'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'bot', 'SOUL.md'), 'template'); fs.writeFileSync(path.join(tpl, 'bot', 'USER.md'), 'tpl-user');
  fs.mkdirSync(path.join(wsd, 'bot'), { recursive: true }); fs.writeFileSync(path.join(wsd, 'bot', 'SOUL.md'), 'customised');
  assert.deepStrictEqual(a.ag.seedDefaultWorkspaces(tpl, wsd), [path.join('bot', 'USER.md')]);
  assert.strictEqual(fs.readFileSync(path.join(wsd, 'bot', 'SOUL.md'), 'utf8'), 'customised');
  assert.deepStrictEqual(a.ag.seedDefaultWorkspaces(path.join(a.root, 'no-templates'), wsd), []);
});

test('context-management fields survive normalisation: compaction, contextWindow, recordsMaxBytes', () => {
  const a = load({ agents: [{ name: 'gp', model: 'm', compaction: { mode: 'dry', at: 0.9 }, contextWindow: 131072, recordsMaxBytes: 65536 }, { name: 'plain', model: 'm', contextWindow: 10 }] });
  const doc = a.ag.getAgentsSync().find(x => x.name === 'gp');
  assert.deepStrictEqual(doc.compaction, { mode: 'dry', at: 0.9 });
  assert.strictEqual(doc.contextWindow, 131072);
  assert.strictEqual(doc.recordsMaxBytes, 65536);
  const plain = a.ag.getAgentsSync().find(x => x.name === 'plain');
  assert.strictEqual(plain.compaction, undefined);
  assert.strictEqual(plain.contextWindow, null, 'below the minimum is ignored');
});

test('createAgent: agents created at the same time are all kept (the personality call no longer races the save)', async () => {
  const files = { 'IDENTITY.md': 'id', 'SOUL.md': 'soul', 'TOOLS.md': 'tools', 'USER.md': 'user' };
  const a = load({ agents: [{ name: 'maestro', model: 'claude-sdk/x' }], llm: reply(files) });
  const results = await Promise.all(['one', 'two', 'three'].map(n => a.ag.createAgent(n, 'openai/gpt-5', 'a test agent')));
  assert.deepStrictEqual(results.map(r => r.success), [true, true, true]);
  assert.deepStrictEqual(a.readJson().map(x => x.name).sort(), ['maestro', 'one', 'three', 'two']);
  const dup = await Promise.all([a.ag.createAgent('four', 'openai/gpt-5', 'x'), a.ag.createAgent('four', 'openai/gpt-5', 'x')]);
  assert.deepStrictEqual(dup.map(r => r.success).sort(), [false, true], 'the same name twice at once: one wins');
  assert.strictEqual(a.readJson().filter(x => x.name === 'four').length, 1);
});

test('ensureMaestroLead marks maestro once on an install that marks no lead, and leaves every other case alone', () => {
  const a = load({ agents: [{ name: 'maestro', category: 'primary' }, { name: 'doc', category: 'primary' }] });
  assert.ok(a.ag.leadAgentNames().includes('doc'), 'before: every primary agent counts as a lead');
  assert.deepStrictEqual(a.ag.ensureMaestroLead(), { changed: true });
  assert.strictEqual(a.readJson().find(x => x.name === 'maestro').lead, true, 'written to disk');
  assert.deepStrictEqual(a.ag.leadAgentNames(), ['maestro'], 'after: maestro only (the cache was dropped)');
  assert.strictEqual(a.ag.ensureMaestroLead().changed, false, 'the next start has nothing to do');

  const b = load({ agents: [{ name: 'maestro', category: 'primary' }, { name: 'doc', category: 'primary', lead: true }] });
  assert.strictEqual(b.ag.ensureMaestroLead().changed, false);
  assert.strictEqual(b.readJson().find(x => x.name === 'maestro').lead, undefined, "the owner's own mark is respected");

  const c = load({ agents: [{ name: 'maestro', category: 'primary', owner: 'u_member' }] });
  assert.strictEqual(c.ag.ensureMaestroLead().changed, false, "a member's maestro is never made the lead");

  const d = load({ agents: '{ not json' });
  assert.strictEqual(d.ag.ensureMaestroLead().changed, false);
  assert.strictEqual(fs.readFileSync(path.join(d.hub, 'data', 'agents.json'), 'utf8'), '{ not json', 'an unreadable agents.json is never rewritten');

  const e = load();
  assert.strictEqual(e.ag.ensureMaestroLead().changed, false, 'first run: the seed does it');
});

test('first run without a seed file: the default maestro is marked as the lead', () => {
  const b = load();
  assert.strictEqual(b.ag.getAgentsSync()[0].lead, true);
  assert.strictEqual(b.readJson()[0].lead, true);
});

test('ensureMaestroLead runs once per install: an untick sticks, and a non-list agents.json is left alone for next time', () => {
  const a = load({ agents: [{ name: 'maestro', category: 'primary' }, { name: 'doc', category: 'primary' }] });
  assert.strictEqual(a.ag.ensureMaestroLead().changed, true);
  const check = path.join(a.hub, 'data', 'lead-check.json');
  assert.strictEqual(JSON.parse(fs.readFileSync(check, 'utf8')).changed, true, 'the check is recorded');
  assert.strictEqual(fs.statSync(check).mode & 0o777, 0o600);
  const unticked = a.readJson().map(x => { const y = { ...x }; delete y.lead; return y; });
  fs.writeFileSync(path.join(a.hub, 'data', 'agents.json'), JSON.stringify(unticked));
  assert.deepStrictEqual(a.ag.ensureMaestroLead(), { changed: false, reason: 'already checked' });
  assert.strictEqual(a.readJson().find(x => x.name === 'maestro').lead, undefined, "the owner's untick sticks");

  const b = load({ agents: '{"maestro": {}}' });
  assert.strictEqual(b.ag.ensureMaestroLead().changed, false);
  assert.strictEqual(fs.readFileSync(path.join(b.hub, 'data', 'agents.json'), 'utf8'), '{"maestro": {}}', 'a non-list file is never rewritten');
  assert.ok(!fs.existsSync(path.join(b.hub, 'data', 'lead-check.json')), 'and is checked again next start');

  const c = load({ agents: [{ name: 'maestro', category: 'worker' }, { name: 'doc', category: 'primary' }] });
  assert.strictEqual(c.ag.ensureMaestroLead().changed, false, 'a repurposed maestro is not promoted');
  assert.ok(fs.existsSync(path.join(c.hub, 'data', 'lead-check.json')), 'a no is recorded too');
});

test('ensureMaestroLead: when the marker cannot be written it warns, and the check simply runs again next start', () => {
  const a = load({ agents: [{ name: 'maestro', category: 'primary', lead: true }] });
  const data = path.join(a.hub, 'data');
  const warns = []; const w = console.warn; console.warn = (...m) => warns.push(m.join(' '));
  fs.chmodSync(data, 0o555);
  try {
    assert.deepStrictEqual(a.ag.ensureMaestroLead(), { changed: false });
    assert.ok(!fs.existsSync(path.join(data, 'lead-check.json')), 'no marker');
    assert.ok(warns.some(m => /could not record the lead check/.test(m)), 'a warning says so');
  } finally { fs.chmodSync(data, 0o755); console.warn = w; }
  assert.deepStrictEqual(a.ag.ensureMaestroLead(), { changed: false }, 'next start: checked again, now recorded');
  assert.ok(fs.existsSync(path.join(data, 'lead-check.json')));
});

test('createAgent with the files the lead wrote (AGENT-PLAYBOOK.md): saved as given, Records too, no model call; list entry gets display, icon and blurb', async () => {
  const a = load({ agents: [], llm: reply(FOUR) });
  const soul = '# SOUL.md — Sage\n\nYou are Sage, a patient garden coach.\n';
  const res = await a.ag.createAgent('sage', 'claude-sdk/sonnet', 'ignored when files are given', null, 'primary', null, {
    display: '  Garden Coach ', icon: '🌱', blurb: 'Vegetable garden planning, planting and pests',
    files: { 'SOUL.md': soul, 'IDENTITY.md': '# IDENTITY.md\n\n## Name\nGarden Coach', 'USER.md': '# USER.md — Sam\n', 'TOOLS.md': '' },
    records: [{ name: 'garden.md', content: '# Garden\n\n## Beds\n(ask)' }, { name: 'frost-dates.md', content: 'Last frost: (ask)\n' }],
  });
  assert.deepStrictEqual(res, { success: true, name: 'sage' });
  assert.deepStrictEqual(a.calls, [], 'no model drafted anything');
  const rd = (f) => fs.readFileSync(path.join(a.ws('sage'), f), 'utf8');
  assert.strictEqual(rd('SOUL.md'), soul, 'byte for byte');
  assert.strictEqual(rd('IDENTITY.md'), '# IDENTITY.md\n\n## Name\nGarden Coach', 'nothing added, not even a final newline');
  assert.strictEqual(rd('USER.md'), '# USER.md — Sam\n');
  assert.ok(!fs.existsSync(path.join(a.ws('sage'), 'TOOLS.md')), 'an empty file is simply not written');
  assert.strictEqual(rd('records/garden.md'), '# Garden\n\n## Beds\n(ask)');
  assert.strictEqual(rd('records/frost-dates.md'), 'Last frost: (ask)\n');
  const rec = a.readJson().find(x => x.name === 'sage');
  assert.deepStrictEqual([rec.display, rec.icon, rec.blurb, rec.category, rec.model], ['Garden Coach', '🌱', 'Vegetable garden planning, planting and pests', 'primary', 'claude-sdk/sonnet']);
  // Only some files given: the core ones it left out get the basic text, under its display name.
  const b = await a.ag.createAgent('lean', undefined, '', null, null, null, { display: 'Lean One', files: { 'USER.md': '# U' } });
  assert.strictEqual(b.success, true);
  assert.strictEqual(fs.readFileSync(path.join(a.ws('lean'), 'SOUL.md'), 'utf8'), 'You are Lean One. A helpful AI assistant.\n');
  assert.match(fs.readFileSync(path.join(a.ws('lean'), 'IDENTITY.md'), 'utf8'), /## Name\nLean One\n/);
  assert.ok(!('blurb' in a.readJson().find(x => x.name === 'lean')), 'no blurb key unless one was given');
  // A family emoji (joined with zero-width joiners) is one icon; a typographic apostrophe is fine in a name.
  assert.strictEqual((await a.ag.createAgent('fam', undefined, '', null, null, null, { display: 'Sam’s Helper', icon: '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}' })).success, true);
  assert.deepStrictEqual(fs.readdirSync(path.join(a.hub, 'workspaces')).sort(), ['fam', 'lean', 'sage'], 'no staging folder is left behind');
});

test('createAgent: a bad display name, icon, blurb, file or Record is refused in plain words, and nothing is created', async () => {
  const a = load({ agents: [] });
  const big = 'x'.repeat(64 * 1024 + 1);
  const bad = {
    'display with <': { display: '<b>Bad</b>' }, 'display too long': { display: 'x'.repeat(41) }, 'display control char': { display: 'a\nb' },
    'display with a quote': { display: 'Bob "x" onmouseover' }, 'display with a straight apostrophe': { display: "Sam's" },
    'display with an ampersand': { display: 'Tom & Jerry' }, 'display run backwards': { display: 'Ma\u202eortsea' },
    'display with a zero-width space': { display: 'Mae\u200bstro' }, 'display with a soft hyphen': { display: 'Mae\u00adstro' },
    'display with a tag character': { display: 'Maestro\u{E0041}' }, 'display with a Hangul filler': { display: 'Mae\u3164stro' }, 'blurb with <': { blurb: 'a <b>bold</b> claim' },
    'blurb too long': { blurb: 'x'.repeat(121) }, 'blurb with a new line': { blurb: 'one\ntwo' }, 'icon with a backtick': { icon: '`' },
    'icon with a space': { icon: '🌱 🌻' }, 'two icons': { icon: '🌱🌻' }, 'icon too long': { icon: 'x'.repeat(17) }, 'icon run backwards': { icon: '\u202e🌱' },
    'unknown file': { files: { 'evil.md': 'x' } }, 'file path': { files: { '../SOUL.md': 'x' } }, 'file too big': { files: { 'SOUL.md': big } },
    'file not text': { files: { 'SOUL.md': 42 } }, 'files as a list': { files: ['SOUL.md'] },
    'record path': { records: [{ name: '../x.md', content: 'x' }] }, 'record capitals': { records: [{ name: 'X.md', content: 'x' }] },
    'record not .md': { records: [{ name: 'a.txt', content: 'x' }] }, 'record twice': { records: [{ name: 'a.md', content: 'x' }, { name: 'a.md', content: 'y' }] },
    'record no text': { records: [{ name: 'a.md' }] }, 'nine records': { records: Array.from({ length: 9 }, (_, i) => ({ name: `r${i}.md`, content: 'x' })) },
    'record too big': { records: [{ name: 'a.md', content: big }] },
    'records too big in all': { records: Array.from({ length: 4 }, (_, i) => ({ name: `r${i}.md`, content: 'x'.repeat(60 * 1024) })) },
    'records not a list': { records: { name: 'a.md', content: 'x' } },
  };
  for (const [label, extra] of Object.entries(bad)) {
    const r = await a.ag.createAgent('nope', undefined, '', null, null, null, extra);
    assert.strictEqual(r.success, false, label);
    assert.match(r.error, /^(display name|icon|blurb|files|SOUL\.md|records)/, `${label}: ${r.error}`);
  }
  assert.ok(!fs.existsSync(a.ws('nope')), 'no workspace was made');
  assert.ok(!a.readJson().some(x => x.name === 'nope'), 'no list entry');
  assert.deepStrictEqual(fs.existsSync(path.join(a.hub, 'workspaces')) ? fs.readdirSync(path.join(a.hub, 'workspaces')) : [], [], 'nothing staged either');
});

test('createAgent: a display name that reads like another agent in the same list is refused; another person’s list is separate', async () => {
  const a = load({ agents: [{ name: 'maestro', display: 'Maestro' }, { name: 'coach', display: 'Garden Coach' }, { name: 'kidbot', display: 'Homework Pal', owner: 'u_kid' }] });
  for (const d of ['Maestro', 'maestro', 'ＭＡＥＳＴＲＯ', 'garden coach', 'Coach']) {
    const r = await a.ag.createAgent('twin', undefined, '', null, null, null, { display: d });
    assert.strictEqual(r.success, false, d);
    assert.match(r.error, /^display name: another agent is already shown as "(Maestro|Garden Coach|coach)"/, d);
  }
  assert.strictEqual((await a.ag.createAgent('helper', undefined, '', null, null, 'u_kid', { display: 'Garden Coach' })).success, true, 'a member’s own list may reuse it');
  assert.strictEqual((await a.ag.createAgent('pal', undefined, '', null, null, null, { display: 'Homework Pal' })).success, true, 'and the admin side may reuse a member’s');
  assert.strictEqual((await a.ag.createAgent('pal2', undefined, '', null, null, 'u_kid', { display: 'homework pal' })).success, false, 'but not inside that member’s list');
  const vs = await a.ag.createAgent('vs', undefined, '', null, null, null, { display: 'Maestro\ufe0f' });
  assert.match(vs.error, /^display name: another agent is already shown as "Maestro"/, 'a variation selector does not make it a different name');
  // A vowel sign is part of a name: Ram and Ramu in Devanagari are two names. A Scotland flag in a blurb is fine.
  assert.strictEqual((await a.ag.createAgent('ram', undefined, '', null, null, null, { display: '\u0930\u093e\u092e' })).success, true);
  assert.strictEqual((await a.ag.createAgent('ramu', undefined, '', null, null, null, { display: '\u0930\u093e\u092e\u0942', blurb: 'Highland walks \u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}' })).success, true);
  // A stray tag letter (invisible outside a flag) doesn't make a different name, even in a name saved before these rules.
  const b = load({ agents: [{ name: 'maestro', display: 'Maestro\u{E0041}' }] });
  assert.match((await b.ag.createAgent('twin', undefined, '', null, null, null, { display: 'Maestro' })).error, /^display name: another agent is already shown as/);
  // Text that looks like a marker is just text (private-use characters are not stripped, nothing is substituted).
  const c = load({ agents: [{ name: 'pua', display: 'A\ue0007\ue001' }] });
  assert.strictEqual((await c.ag.createAgent('aundef', undefined, '', null, null, null, { display: 'Aundefined' })).success, true);
  // Two flags made of tag letters are two names.
  assert.strictEqual((await a.ag.createAgent('scot', undefined, '', null, null, null, { display: 'Team \u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}' })).success, true);
  assert.strictEqual((await a.ag.createAgent('wales', undefined, '', null, null, null, { display: 'Team \u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}' })).success, true);
});

test('createAgent: on the lead’s path the default display name counts too, and two creates at once can’t both take one display name', async () => {
  const a = load({ agents: [{ name: 'garden', display: 'Sage' }], llm: reply(FOUR) });
  assert.match((await a.ag.createAgent('sage', undefined, '', null, null, null, { files: { 'SOUL.md': 'x' } })).error, /^display name: another agent is already shown as "Sage"/);
  assert.strictEqual((await a.ag.createAgent('sage', undefined, '', null, null, null, null)).success, true, 'the Agents page is the person’s own choice');
  const both = await Promise.all(['one', 'two'].map(n => a.ag.createAgent(n, 'openai/gpt-5', 'a twin', null, null, null, { display: 'Twin' })));
  assert.deepStrictEqual(both.map(r => r.success).sort(), [false, true]);
  assert.match(both.find(r => !r.success).error, /^display name: another agent is already shown as "Twin"/);
  assert.strictEqual(a.readJson().filter(x => x.display === 'Twin').length, 1);
  assert.ok(!fs.readdirSync(path.join(a.hub, 'workspaces')).some(n => n.startsWith('.')), 'the loser left no staging folder');
});

test('createAgent never takes over what an earlier agent of the same name left: it is kept in a bundle first, and the new agent starts clean', async () => {
  const a = load({ agents: [] });
  const outside = path.join(a.root, 'outside.txt');
  fs.writeFileSync(outside, 'keep me\n');
  // A folder left behind by a delete from before bundles, here with a planted link where SOUL.md goes.
  fs.mkdirSync(a.ws('ghost'), { recursive: true });
  fs.symlinkSync(outside, path.join(a.ws('ghost'), 'SOUL.md'));
  fs.mkdirSync(path.join(a.ws('olds'), 'records'), { recursive: true });
  fs.writeFileSync(path.join(a.ws('olds'), 'records', 'secrets.md'), 'the earlier agent’s facts\n');
  const elsewhere = path.join(a.root, 'elsewhere'); fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, a.ws('lnk'));                                           // the folder itself a link
  fs.mkdirSync(path.join(a.hub, 'data', 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(a.hub, 'data', 'conversations', 'hist.jsonl'), '{"role":"user","content":"old"}\n');
  fs.writeFileSync(path.join(a.hub, 'data', 'agent-sessions.json'), JSON.stringify({ sess: { sessionId: 'abc' }, keep: { sessionId: 'k' } }));
  fs.writeFileSync(path.join(a.hub, 'data', 'codex-sessions.json'), JSON.stringify({ codexs: { threadId: 't1' } }));
  const mem = require(path.join(a.hub, 'lib', 'memory-db.js'));
  mem.writeLongTermMemory('memo', 'the earlier agent’s notes');
  fs.mkdirSync(path.join(a.hub, 'data', 'sessions', 'notes'), { recursive: true });
  const tr = require(path.join(a.hub, 'lib', 'transcript.js')).getTranscript();
  tr.record({ agent: 'trans', kind: 'user', text: 'something the earlier agent was told' });
  fs.mkdirSync(path.join(a.hub, 'data', 'context-refresh'), { recursive: true });
  fs.writeFileSync(path.join(a.hub, 'data', 'context-refresh', 'ctx.json'), '{"seen":1}');
  fs.mkdirSync(path.join(a.root, 'share', 'filer')); fs.writeFileSync(path.join(a.root, 'share', 'filer', 'report.pdf'), 'old report');
  fs.mkdirSync(path.join(a.root, 'share', 'common')); fs.writeFileSync(path.join(a.root, 'share', 'common', 'everyone.md'), 'shared');
  fs.writeFileSync(path.join(a.hub, 'data', 'context-refresh', 'common.json'), '{}');   // an agent named "common" never takes the shared folder
  const expect = { ghost: 'workspace', olds: 'workspace', lnk: 'workspace', hist: 'chat.jsonl', sess: 'sessions.json', codexs: 'sessions.json',
    memo: 'memory.json', notes: 'notes', trans: 'archive.db', ctx: 'context-refresh.json', filer: 'files', common: 'context-refresh.json' };
  for (const [name, kept] of Object.entries(expect)) {
    const r = await a.ag.createAgent(name, undefined, '', null, null, null, { files: { 'SOUL.md': 'new\n' } });
    assert.strictEqual(r.success, true, `${name}: ${r.error}`);
    assert.match(r.earlierAgentKept, new RegExp(`^data/archived-agents/${name}-\\d{8}T\\d{6}Z$`), name);
    const b = path.join(a.hub, r.earlierAgentKept);
    assert.ok(fs.existsSync(path.join(b, kept)), `${name}: ${kept} is in its bundle`);
    const m = JSON.parse(fs.readFileSync(path.join(b, 'manifest.json'), 'utf8'));
    assert.deepStrictEqual([m.name, m.reason, m.entry, !!m.finishedAt], [name, 'left by an earlier agent of that name', null, true]);
    assert.strictEqual(fs.readFileSync(path.join(a.ws(name), 'SOUL.md'), 'utf8'), 'new\n', `${name} starts with its own files`);
  }
  assert.deepStrictEqual(a.boxes, Object.keys(expect), 'each earlier agent’s box was looked for');
  // nothing was followed through a link; the shared folder and the files outside the hub are as they were
  assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'keep me\n');
  assert.deepStrictEqual(fs.readdirSync(elsewhere), []);
  assert.ok(fs.lstatSync(path.join(a.hub, 'data', 'archived-agents', a.bundles().find(n => n.startsWith('lnk-')), 'workspace')).isSymbolicLink(), 'the link itself was put aside');
  assert.ok(fs.lstatSync(a.ws('lnk')).isDirectory() && !fs.lstatSync(a.ws('lnk')).isSymbolicLink());
  assert.deepStrictEqual(fs.readdirSync(path.join(a.root, 'share', 'common')), ['everyone.md']);
  assert.ok(!fs.existsSync(path.join(a.root, 'share', 'filer')), 'the earlier agent’s Files folder went with it');
  // the new agents have none of it
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(a.hub, 'data', 'agent-sessions.json'), 'utf8')), { keep: { sessionId: 'k' } }, 'only that session left the map');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(a.hub, 'data', 'codex-sessions.json'), 'utf8')), {});
  assert.strictEqual(mem.getMemoryStats('memo').longTermSections, 0);
  assert.strictEqual(tr.stats('trans').entries, 0);
  assert.ok(!fs.existsSync(path.join(a.hub, 'data', 'conversations', 'hist.jsonl')));
  // what was kept can still be read and searched
  const kept = (n, f) => path.join(a.hub, 'data', 'archived-agents', a.bundles().find(x => x.startsWith(`${n}-`)), f);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(kept('sess', 'sessions.json'), 'utf8')), { 'Claude session': { sessionId: 'abc' } });
  assert.strictEqual(JSON.parse(fs.readFileSync(kept('memo', 'memory.json'), 'utf8')).long_term_memory[0].content, 'the earlier agent’s notes');
  const Database = require(path.join(a.hub, 'node_modules', 'better-sqlite3'));
  const db = new Database(kept('trans', 'archive.db'), { readonly: true });
  try { assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM entries_fts WHERE entries_fts MATCH 'told'").get().n, 1); } finally { db.close(); }
  assert.strictEqual(fs.readFileSync(kept('olds', path.join('workspace', 'records', 'secrets.md')), 'utf8'), 'the earlier agent’s facts\n');
  // An empty folder of that name holds nothing to inherit: it is simply replaced, and nothing is put aside.
  const before = a.bundles().length;
  fs.mkdirSync(a.ws('fresh'));
  const r = await a.ag.createAgent('fresh', undefined, '', null, null, null, { files: { 'SOUL.md': 'new\n' } });
  assert.deepStrictEqual([r.success, r.earlierAgentKept], [true, undefined]);
  assert.strictEqual(a.bundles().length, before);
  assert.ok(!fs.readdirSync(path.join(a.hub, 'workspaces')).some(n => n.startsWith('.')), 'no staging folder left behind');
});

test('createAgent: when what an earlier agent left can’t be checked, the name is not taken as free', async () => {
  const a = load({ agents: [] });
  const mem = require(path.join(a.hub, 'lib', 'memory-db.js'));
  const tr = require(path.join(a.hub, 'lib', 'transcript.js')).getTranscript();
  const real = { stats: mem.getMemoryStats, tstats: tr.stats };
  try {
    mem.getMemoryStats = () => { throw new Error('SQLITE_BUSY: database is locked'); };
    const r1 = await a.ag.createAgent('locked', undefined, '', null, null, null, { files: { 'SOUL.md': 'x' } });
    assert.strictEqual(r1.error, 'Could not check or put away what an earlier agent named "locked" may have left (SQLITE_BUSY: database is locked). Nothing was created; try again in a moment.');
    mem.getMemoryStats = real.stats;
    tr.stats = () => null;   // the archive could not be opened
    assert.match((await a.ag.createAgent('locked', undefined, '', null, null, null, null)).error, /^Could not check .*the conversation archive could not be opened/);
    tr.stats = real.tstats;
    fs.writeFileSync(path.join(a.hub, 'data', 'agent-sessions.json'), '{"half-writ');
    assert.match((await a.ag.createAgent('locked', undefined, '', null, null, null, null)).error, /^Could not check .*agent-sessions\.json can't be read/);
    fs.writeFileSync(path.join(a.hub, 'data', 'agent-sessions.json'), '{}');
    // A folder that can't be looked into is not an empty one (chat history of an earlier agent may sit there).
    const conv = path.join(a.hub, 'data', 'conversations');
    fs.mkdirSync(conv, { recursive: true }); fs.chmodSync(conv, 0o000);
    try {
      if (process.getuid && process.getuid() !== 0) assert.match((await a.ag.createAgent('locked', undefined, '', null, null, null, null)).error, /^Could not check .*EACCES/);
    } finally { fs.chmodSync(conv, 0o755); }
  } finally { mem.getMemoryStats = real.stats; tr.stats = real.tstats; }
  assert.ok(!fs.existsSync(a.ws('locked')) && !a.readJson().length, 'nothing was created');
  assert.strictEqual((await a.ag.createAgent('locked', undefined, '', null, null, null, null)).success, true, 'once the stores answer, the name is free');
});

test('createAgent: the folder appears whole or not at all; a failed write or a lost race leaves nothing behind', async () => {
  const a = load({ agents: [] });
  const ws = path.join(a.hub, 'workspaces');
  const realRename = fs.renameSync, realWrite = fs.writeFileSync;
  try {
    // Another create claimed the name while this one was writing.
    fs.renameSync = (from, to) => { if (String(to).endsWith(`${path.sep}raced`)) { const e = new Error('ENOTEMPTY: directory not empty'); e.code = 'ENOTEMPTY'; throw e; } return realRename(from, to); };
    assert.deepStrictEqual(await a.ag.createAgent('raced', undefined, '', null, null, null, { files: { 'SOUL.md': 'x' } }), { success: false, error: 'Agent already exists' });
    fs.renameSync = realRename;
    // The disk fills up on the second file.
    let n = 0;
    fs.writeFileSync = (file, ...rest) => { if (String(file).includes(`${path.sep}.new-full-`) && ++n === 2) { const e = new Error('ENOSPC: no space left on device'); e.code = 'ENOSPC'; throw e; } return realWrite(file, ...rest); };
    const r = await a.ag.createAgent('full', undefined, '', null, null, null, { files: { 'SOUL.md': 'x', 'USER.md': 'y' } });
    assert.strictEqual(r.success, false);
    assert.match(r.error, /^could not write the agent's files \(ENOSPC/);
  } finally { fs.renameSync = realRename; fs.writeFileSync = realWrite; }
  assert.deepStrictEqual(fs.readdirSync(ws), [], 'no half-made folder, no staging folder');
  assert.deepStrictEqual(a.readJson(), [], 'no list entries');
  assert.strictEqual((await a.ag.createAgent('full', undefined, '', null, null, null, { files: { 'SOUL.md': 'x' } })).success, true, 'the name is still free afterwards');
  // The agent list can't be saved: the folder is taken back out, and the name stays free.
  try {
    fs.renameSync = (from, to) => { if (String(to).endsWith('agents.json')) { const e = new Error('ENOSPC: no space left on device'); e.code = 'ENOSPC'; throw e; } return realRename(from, to); };
    assert.deepStrictEqual(await a.ag.createAgent('unsaved', undefined, '', null, null, null, { files: { 'SOUL.md': 'x' } }), { success: false, error: 'could not save the agent list (ENOSPC: no space left on device); nothing was created' });
    // And when the folder can't be taken back out either, it says so instead of "nothing was created".
    const realRm = fs.rmSync;
    fs.rmSync = (p, ...rest) => { if (String(p).endsWith(`${path.sep}stuck`)) { const e = new Error('EBUSY: resource busy'); e.code = 'EBUSY'; throw e; } return realRm(p, ...rest); };
    try {
      assert.match((await a.ag.createAgent('stuck', undefined, '', null, null, null, { files: { 'SOUL.md': 'x' } })).error, /^could not save the agent list \(ENOSPC[^)]*\); its folder workspaces\/stuck could not be taken back out \(EBUSY: resource busy\); the next agent given that name finds it put aside with an earlier agent's things$/);
    } finally { fs.rmSync = realRm; }
  } finally { fs.renameSync = realRename; }
  assert.ok(!fs.existsSync(a.ws('unsaved')), 'its folder was taken back out');
  assert.strictEqual((await a.ag.createAgent('unsaved', undefined, '', null, null, null, null)).success, true);
});

test('availableModelsNow: the last list fetched, at once, refreshed in the background; with none yet, the full list', async () => {
  const a = load({ agents: [] });
  const gw = require.cache[path.join(a.hub, 'lib', 'gateway-client.js')].exports;
  assert.deepStrictEqual(await a.ag.availableModelsNow(), ['claude-sdk/x', 'gpt-5'], 'no list yet: the full wait (and only chat models)');
  assert.deepStrictEqual(a.calls, ['listModels']);
  gw.cachedModels = () => ['openai/gpt-y', 'whisper-1'];
  assert.deepStrictEqual(await a.ag.availableModelsNow(), ['openai/gpt-y'], 'the last list, at once');
  await new Promise(r => setImmediate(r));
  assert.deepStrictEqual(a.calls, ['listModels', 'listModels'], 'and a refresh started for next time');
});

test('createAgent with a personality: only the four known files the model returns are written; a made-up path never is', async () => {
  const a = load({ agents: [], llm: reply({ ...FOUR, '../escape.md': 'x', 'notes.md': 'y' }) });
  assert.strictEqual((await a.ag.createAgent('gen2', 'gpt-5', 'a poet')).success, true);
  assert.deepStrictEqual(fs.readdirSync(a.ws('gen2')).sort(), Object.keys(FOUR).sort());
  assert.ok(!fs.existsSync(path.join(a.hub, 'workspaces', 'escape.md')), 'nothing outside the workspace');
});

// The hub's chat engine, as deleteAgent sees it: who is at work, the scheduled tasks, and what it remembers by name.
function chatStandIn(a, { busy = new Set(), tasks = [], compaction = null } = {}) {
  const forgot = [];
  const st = { list: tasks,
    tasksOf: (n) => st.list.filter(t => t.agent === n).map(t => JSON.parse(JSON.stringify(t))),
    action: (id, who, act) => { assert.deepStrictEqual([who, act], ['owner', 'delete']); st.list = st.list.filter(t => t.id !== id); },
    retarget: (from, to) => { let n = 0; for (const t of st.list) if (t.agent === from) { t.agent = to; n++; } return n; } };
  const m = new Module(path.join(a.hub, 'lib', 'sdk-chat.js'));
  m.filename = m.id; m.loaded = true;
  m.exports = { isAgentActive: (n) => busy.has(n), getScheduledTasks: () => st, forgetAgent: (n) => forgot.push(n), ...(compaction ? { getCompaction: () => compaction } : {}) };
  require.cache[m.id] = m;
  return { st, forgot };
}

test('deleteAgent keeps everything the agent left in one bundle; its name is free at once and a new agent of that name starts clean', async () => {
  const a = load({ agents: [{ name: 'maestro' }, { name: 'scout', display: 'Scout', model: 'claude-sdk/x' }] });
  const chat = chatStandIn(a, { tasks: [{ id: 't1', agent: 'scout', label: 'daily' }, { id: 't2', agent: 'maestro', label: 'other' }, { id: 't3', agent: 'scout', label: 'once' }] });
  const d = (...p) => path.join(a.hub, 'data', ...p);
  fs.mkdirSync(path.join(a.ws('scout'), 'records'), { recursive: true });
  fs.writeFileSync(path.join(a.ws('scout'), 'SOUL.md'), 'scout soul\n');
  fs.writeFileSync(path.join(a.ws('scout'), 'records', 'facts.md'), 'facts\n');
  fs.mkdirSync(d('conversations'), { recursive: true });
  fs.writeFileSync(d('conversations', 'scout.jsonl'), '{"role":"user","content":"hi"}\n');
  fs.writeFileSync(d('conversations', 'maestro.jsonl'), '{"role":"user","content":"stay"}\n');
  fs.writeFileSync(d('agent-sessions.json'), JSON.stringify({ scout: { sessionId: 's1' }, maestro: { sessionId: 'm1' } }));
  fs.chmodSync(d('agent-sessions.json'), 0o640);
  fs.writeFileSync(d('codex-sessions.json'), JSON.stringify({ scout: { threadId: 'c1' } }));
  const mem = require(path.join(a.hub, 'lib', 'memory-db.js'));
  mem.writeLongTermMemory('scout', 'long term'); mem.writeSessionNote('scout', 'a note'); mem.saveDistillation('scout', '2026-11-01', 'sum');
  mem.writeLongTermMemory('maestro', 'mine');
  fs.mkdirSync(d('sessions', 'scout'), { recursive: true }); fs.writeFileSync(d('sessions', 'scout', 'n.md'), 'n');
  fs.mkdirSync(d('context-refresh'), { recursive: true }); fs.writeFileSync(d('context-refresh', 'scout.json'), '{}');
  const tr = require(path.join(a.hub, 'lib', 'transcript.js')).getTranscript();
  tr.record({ agent: 'scout', kind: 'user', text: 'scout was told this' });
  tr.record({ agent: 'maestro', kind: 'user', text: 'maestro keeps this' });
  fs.mkdirSync(path.join(a.root, 'share', 'scout')); fs.writeFileSync(path.join(a.root, 'share', 'scout', 'out.pdf'), 'pdf');

  const had = mem.getMemoryStats('scout');
  const r = await a.ag.deleteAgent('scout');
  assert.strictEqual(r.success, true); assert.strictEqual(r.unfinished, undefined, JSON.stringify(r));
  assert.match(r.keptIn, /^data\/archived-agents\/scout-\d{8}T\d{6}Z$/);
  const b = path.join(a.hub, r.keptIn);
  assert.deepStrictEqual(fs.readdirSync(b).sort(), ['archive.db', 'chat.jsonl', 'context-refresh.json', 'files', 'manifest.json', 'memory.json', 'notes', 'scheduled-tasks.json', 'sessions.json', 'workspace']);
  const m = JSON.parse(fs.readFileSync(path.join(b, 'manifest.json'), 'utf8'));
  assert.deepStrictEqual([m.name, m.reason, m.entry.display, !!m.finishedAt], ['scout', 'deleted', 'Scout', true]);
  assert.ok(Object.values(m.steps).every(s => s.done), JSON.stringify(m.steps));
  assert.ok(!a.readJson().some(x => x.name === 'scout'));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(b, 'scheduled-tasks.json'), 'utf8')).map(t => t.id), ['t1', 't3']);
  assert.deepStrictEqual(chat.st.list.map(t => t.id), ['t2'], 'another agent’s task stays');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(b, 'sessions.json'), 'utf8')), { 'Claude session': { sessionId: 's1' }, 'Codex session': { threadId: 'c1' } });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(d('agent-sessions.json'), 'utf8')), { maestro: { sessionId: 'm1' } });
  assert.strictEqual(fs.statSync(d('agent-sessions.json')).mode & 0o777, 0o640, 'the map keeps its permissions');
  const memo = JSON.parse(fs.readFileSync(path.join(b, 'memory.json'), 'utf8'));
  assert.deepStrictEqual([memo.long_term_memory.length, memo.session_notes.length, memo.distillation_log.length], [had.longTermSections, had.sessionNotes, had.distilledDays]);
  assert.ok(had.longTermSections && had.sessionNotes && had.distilledDays);
  const ms = mem.getMemoryStats('scout');
  assert.deepStrictEqual([ms.longTermSections, ms.sessionNotes, ms.distilledDays, mem.getMemoryStats('maestro').longTermSections], [0, 0, 0, 1]);
  assert.deepStrictEqual([tr.stats('scout').entries, tr.stats('maestro').entries], [0, 1]);
  assert.strictEqual(fs.readFileSync(path.join(b, 'workspace', 'records', 'facts.md'), 'utf8'), 'facts\n');
  assert.strictEqual(fs.readFileSync(path.join(b, 'files', 'out.pdf'), 'utf8'), 'pdf');
  assert.ok(fs.existsSync(d('conversations', 'maestro.jsonl')));
  assert.deepStrictEqual(chat.forgot, ['scout']);
  assert.deepStrictEqual(a.boxes, ['scout']);
  // the name is free: a new scout starts clean, with nothing more put aside
  const again = await a.ag.createAgent('scout', undefined, '', null, null, null, { files: { 'SOUL.md': 'new scout\n' } });
  assert.deepStrictEqual([again.success, again.earlierAgentKept], [true, undefined]);
  assert.strictEqual(fs.readFileSync(path.join(a.ws('scout'), 'SOUL.md'), 'utf8'), 'new scout\n');
  assert.ok(!fs.existsSync(path.join(a.ws('scout'), 'records')));
  assert.strictEqual(a.bundles().length, 1);
});

test('deleteAgent: an agent at work is not deleted', async () => {
  const a = load({ agents: [{ name: 'busy', display: 'Busy Bee' }] });
  chatStandIn(a, { busy: new Set(['busy']) });
  fs.mkdirSync(a.ws('busy'), { recursive: true }); fs.writeFileSync(path.join(a.ws('busy'), 'SOUL.md'), 's');
  assert.deepStrictEqual(await a.ag.deleteAgent('busy'), { success: false, error: 'Busy Bee is working right now (a reply or a background job). Stop it or wait until it finishes, then delete it.' });
  assert.deepStrictEqual(a.readJson().map(x => x.name), ['busy']);
  assert.deepStrictEqual(a.bundles(), []);
  assert.ok(fs.existsSync(path.join(a.ws('busy'), 'SOUL.md')));
});

test('deleteAgent: what can’t be moved now is finished later; a box left for later doesn’t hold the name, anything else does', async () => {
  const a = load({ agents: [{ name: 'boxy' }, { name: 'held' }] });
  let docker = 'down', memoryFails = true;
  const retired = [];
  const mem = require(path.join(a.hub, 'lib', 'memory-db.js'));
  a.ag.__archive.configure({ log: () => {}, isBoxed: () => true,
    sandbox: () => ({ retire: async (agent) => { if (docker === 'down') throw new Error('Docker is not answering (Cannot connect to the Docker daemon)'); retired.push(agent.box || agent.name); return { result: 'removed' }; } }),
    memory: () => ({ exportAgentMemory: (n) => { if (memoryFails) throw new Error('SQLITE_BUSY: database is locked'); return mem.exportAgentMemory(n); }, deleteAgentMemoryRows: mem.deleteAgentMemoryRows }) });
  fs.mkdirSync(a.ws('boxy'), { recursive: true }); fs.writeFileSync(path.join(a.ws('boxy'), 'SOUL.md'), 's');
  const r = await a.ag.deleteAgent('boxy');
  assert.strictEqual(r.success, true);
  assert.deepStrictEqual(r.unfinished, ['sandbox box: Docker is not answering (Cannot connect to the Docker daemon)', 'memory: SQLITE_BUSY: database is locked']);
  assert.match(r.keptIn, /^data\/archived-agents\/boxy-\d{8}T\d{6}Z\.partial$/);
  assert.ok(fs.existsSync(path.join(a.hub, r.keptIn, 'workspace', 'SOUL.md')), 'the other steps were done');
  // memory still to move: the name stays taken, and a create tries again (still failing) without a second bundle
  const blocked = await a.ag.createAgent('boxy', undefined, '', null, null, null, null);
  assert.match(blocked.error, /^Could not check or put away what an earlier agent named "boxy" may have left \(its unfinished removal could not be moved yet/);
  assert.strictEqual(a.bundles().length, 1);
  // only the box left: the name is free (the new agent has a box of its own), and the earlier box is finished later
  memoryFails = false;
  const ok = await a.ag.createAgent('boxy', undefined, '', null, null, null, null);
  assert.deepStrictEqual([ok.success, ok.earlierAgentKept], [true, r.keptIn]);
  const newBox = a.readJson().find(x => x.name === 'boxy').box;
  assert.match(newBox, /^[0-9a-f]{12}$/);
  assert.ok(a.bundles()[0].endsWith('.partial'), 'the earlier box is still to remove');
  docker = 'up';
  const done = await a.ag.finishArchivingAgents();
  assert.deepStrictEqual(done.map(x => x.finished), [true], 'for a name in use again only the box step runs, which was all that was left');
  assert.deepStrictEqual(retired, ['boxy'], 'the earlier agent’s own box (no id), not the new one’s');
  assert.deepStrictEqual(a.bundles(), [r.keptIn.replace(/^data\/archived-agents\//, '').replace(/\.partial$/, '')]);
  const m = JSON.parse(fs.readFileSync(path.join(a.hub, 'data', 'archived-agents', a.bundles()[0], 'manifest.json'), 'utf8'));
  assert.ok(Object.values(m.steps).every(s => s.done) && m.finishedAt);
  // A delete that stopped before the agent left the list (the hub stopped between the two): nothing had moved, the
  // agent is still listed with the same box, so the bundle is undone and the agent's box is never touched.
  fs.mkdirSync(a.ws('held'), { recursive: true }); fs.writeFileSync(path.join(a.ws('held'), 'SOUL.md'), 'the agent called held');
  const stale = a.ag.getAgentArchive().begin({ name: 'held', entry: { name: 'held' } });
  await a.ag.finishArchivingAgents();
  assert.strictEqual(fs.readFileSync(path.join(a.ws('held'), 'SOUL.md'), 'utf8'), 'the agent called held');
  assert.ok(!fs.existsSync(stale), 'the undone bundle is gone');
  assert.deepStrictEqual(retired, ['boxy'], 'the box of the agent listed was not retired');
  // Steps already done and the same agent listed again (a restore put it back): left as it is, its box untouched.
  const restored = a.ag.getAgentArchive().begin({ name: 'held', entry: { name: 'held' } });
  const mf = path.join(restored, 'manifest.json');
  fs.writeFileSync(mf, JSON.stringify({ ...JSON.parse(fs.readFileSync(mf, 'utf8')), steps: { workspace: { done: true, result: 'moved' } } }));
  await a.ag.finishArchivingAgents();
  assert.ok(fs.existsSync(restored));
  assert.deepStrictEqual(retired, ['boxy']);
});

test('the finisher never retires the box of the agent listed under that name; a new agent’s box is never an earlier one', async () => {
  const a = load({ agents: [{ name: 'twin', box: 'cccccccccccc' }] });
  const retired = [];
  a.ag.__archive.configure({ log: () => {}, isBoxed: () => true, sandbox: () => ({ retire: async (agent) => { retired.push(agent.box || agent.name); return { result: 'removed' }; } }) });
  const arch = a.ag.getAgentArchive();
  // an earlier twin, deleted while Docker wasn't answering: its own box (no id) still to remove
  const early = arch.begin({ name: 'twin', entry: { name: 'twin' } });
  const mf = path.join(early, 'manifest.json');
  const STEPS = ['box', 'workspace', 'files', 'chat', 'notes', 'contextRefresh', 'tasks', 'sessions', 'memory', 'archive'];
  fs.writeFileSync(mf, JSON.stringify({ ...JSON.parse(fs.readFileSync(mf, 'utf8')), steps: Object.fromEntries(STEPS.filter(x => x !== 'box').map(x => [x, { done: true }])) }));
  // and one whose entry had the listed twin's own box (a copy of the same agent): never retired
  const same = arch.begin({ name: 'twin', entry: { name: 'twin', box: 'cccccccccccc' } });
  fs.writeFileSync(path.join(same, 'manifest.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(same, 'manifest.json'), 'utf8')), steps: { workspace: { done: true } } }));
  await a.ag.finishArchivingAgents();
  assert.deepStrictEqual(retired, ['twin'], 'only the earlier agent box (hub-agent-twin), not hub-agent-twin-cccccccccccc');
  assert.ok(!fs.existsSync(early) && fs.existsSync(same));
  // inside the run too: a box-only run handed the listed agent never retires its box
  const again = arch.begin({ name: 'twin', entry: { name: 'twin', box: 'cccccccccccc' } });
  const r = await arch.run(again, { only: ['box'], live: { name: 'twin', box: 'cccccccccccc' } });
  assert.match(r.unfinished.find(u => u.step === 'box').error, /^the agent now called twin uses this box$/);
  assert.deepStrictEqual(retired, ['twin']);
  const { containerNameFor } = require(path.join(a.hub, 'lib', 'sandbox.js'));
  const { homeVolumeFor } = require(path.join(a.hub, 'lib', 'sandbox.js'));
  assert.deepStrictEqual([containerNameFor({ name: 'twin' }), containerNameFor({ name: 'twin', box: 'cccccccccccc' }), containerNameFor({ name: 'other', box: 'cccccccccccc' })],
    ['hub-agent-twin', 'hub-agent-twin-cccccccccccc', 'hub-agent-other-cccccccccccc'], 'a renamed agent gets a box for its new folders');
  assert.deepStrictEqual([homeVolumeFor({ name: 'twin' }), homeVolumeFor({ name: 'twin', box: 'cccccccccccc' }), homeVolumeFor({ name: 'other', box: 'cccccccccccc' })],
    ['hub-agent-twin-home', 'hub-agent-cccccccccccc-home', 'hub-agent-cccccccccccc-home'], 'and keeps its home folder');
});

test('deleteAgent: a delete cut short after its bundle was made is finished at the next start; never on a guess about who exists', async () => {
  const a = load({ agents: [{ name: 'cut' }] });
  fs.mkdirSync(a.ws('cut'), { recursive: true }); fs.writeFileSync(path.join(a.ws('cut'), 'SOUL.md'), 's');
  const b = a.ag.getAgentArchive().begin({ name: 'cut', entry: { name: 'cut' } });
  fs.writeFileSync(path.join(a.hub, 'data', 'agents.json'), '[]');   // the list was saved; then the hub stopped
  const [r] = await a.ag.finishArchivingAgents();
  assert.strictEqual(r.finished, true);
  assert.ok(!fs.existsSync(b) && fs.existsSync(path.join(r.dir, 'workspace', 'SOUL.md')) && !fs.existsSync(a.ws('cut')));
  const b2 = a.ag.getAgentArchive().begin({ name: 'later', entry: null });
  fs.writeFileSync(path.join(a.hub, 'data', 'agents.json'), '{"half');
  const e = console.error; console.error = () => {};
  try { assert.deepStrictEqual(await a.ag.finishArchivingAgents(), []); } finally { console.error = e; }
  assert.deepStrictEqual(fs.readdirSync(b2), ['manifest.json'], 'an unreadable agent list moves nothing');
});

test('deleteAgent: with the combined archive of earlier versions, the agent’s rows move to its bundle and the others stay', async () => {
  const a = load({ agents: [{ name: 'gone' }, { name: 'stay' }] });
  fs.writeFileSync(path.join(a.hub, 'data', 'transcript.db'), '');   // the combined file, before the split
  const tr = require(path.join(a.hub, 'lib', 'transcript.js')).getTranscript();
  tr.record({ agent: 'gone', kind: 'user', text: 'gone was told' });
  tr.record({ agent: 'gone', kind: 'assistant', text: 'gone said' });
  tr.record({ agent: 'stay', kind: 'user', text: 'stay was told' });
  const r = await a.ag.deleteAgent('gone');
  assert.strictEqual(r.unfinished, undefined, JSON.stringify(r));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(a.hub, r.keptIn, 'manifest.json'), 'utf8')).steps.archive.result, 'moved 2 rows');
  assert.deepStrictEqual([tr.stats('gone').entries, tr.stats('stay').entries], [0, 1]);
  assert.ok(fs.existsSync(path.join(a.hub, 'data', 'transcript.db')), 'still the one combined file');
  const Database = require(path.join(a.hub, 'node_modules', 'better-sqlite3'));
  const db = new Database(path.join(a.hub, r.keptIn, 'archive.db'), { readonly: true });
  try { assert.deepStrictEqual(db.prepare('SELECT text FROM entries ORDER BY id').all().map(x => x.text), ['gone was told', 'gone said']); } finally { db.close(); }
});

test('a name an admin granted something to stays taken after its agent is deleted, and the message says what to remove', async () => {
  const a = load({ agents: [{ name: 'priv' }, { name: 'free' }] });
  const d = (...p) => path.join(a.hub, 'data', ...p);
  for (const n of ['priv', 'free']) { const r = await a.ag.deleteAgent(n); assert.strictEqual(r.success, true, r.error); }
  fs.writeFileSync(d('settings.json'), JSON.stringify({ walletAgents: ['priv'] }));
  require(path.join(a.hub, 'lib', 'root-grants.js')).getRootGrants().grant('priv', { minutes: 15, by: 'owner' });
  fs.writeFileSync(d('connectors.json'), JSON.stringify({ version: 1, groups: {}, connectors: [{ id: 'mail', kind: 'mcp', agents: ['priv'], protect: 'none', enabled: true, secrets: {}, tools: {} }, { id: 'web', kind: 'mcp', agents: null, protect: 'none', enabled: true, secrets: {}, tools: {} }] }));
  const tok = a.auth().createToken({ name: 'priv-bot', scopes: ['chat'], agents: ['priv'] });
  a.auth().createToken({ name: 'everyone', scopes: ['status'] });
  const r = await a.ag.createAgent('priv', undefined, '', null, null, null, null);
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error, 'Could not check or put away what an earlier agent named "priv" may have left (the name "priv" still has wallet access (walletAgents in data/settings.json), a root grant (until it ends), access to the connector mail and the API token priv-bot, which a new agent of that name would get too: remove them first, or choose another name). Nothing was created; try again in a moment.');
  assert.strictEqual((await a.ag.cloneAgent('free', 'priv')).success, false, 'clone is held the same way');
  assert.strictEqual((await a.ag.createAgent('free', undefined, '', null, null, null, null)).success, true, 'a token or connector for every agent is not a grant by name');
  require(path.join(a.hub, 'lib', 'root-grants.js')).getRootGrants().revoke('priv');
  fs.writeFileSync(d('settings.json'), '{}');
  fs.writeFileSync(d('connectors.json'), JSON.stringify({ version: 1, groups: {}, connectors: [] }));
  a.auth().revokeToken(tok.id || tok.token?.id || a.auth().listTokens().find(t => t.name === 'priv-bot').id);
  for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(a.hub, 'lib', 'connectors')) || k.startsWith(path.join(a.hub, 'lib', 'settings'))) delete require.cache[k];
  assert.strictEqual((await a.ag.createAgent('priv', undefined, '', null, null, null, null)).success, true);
});

test('new and cloned agents get a box of their own; a clone waiting on an earlier agent’s things loses no change made meanwhile', async () => {
  const a = load({ agents: [{ name: 'src', model: 'mm', box: 'aaaaaaaaaaaa' }] });
  const made = await a.ag.createAgent('fresh', undefined, '', null, null, null, null);
  assert.strictEqual(made.success, true);
  fs.mkdirSync(a.ws('copy'), { recursive: true }); fs.writeFileSync(path.join(a.ws('copy'), 'SOUL.md'), 'an earlier copy');   // left by an earlier agent
  let waiting, release;
  const inSweep = new Promise(r => { waiting = r; });
  const gate = new Promise(r => { release = r; });
  a.ag.__archive.configure({ log: () => {}, isBoxed: () => false, sandbox: () => ({ retire: async (agent) => { if (agent.name === 'copy') { waiting(); await gate; } return { result: 'none' }; } }) });
  const cloning = a.ag.cloneAgent('src', 'copy');
  await inSweep;   // the clone waits on its sweep of copy; meanwhile someone deletes fresh and creates other
  assert.strictEqual((await a.ag.deleteAgent('fresh')).success, true);
  assert.strictEqual((await a.ag.createAgent('other', undefined, '', null, null, null, null)).success, true);
  release();
  const c = await cloning;
  assert.strictEqual(c.success, true, c.error);
  assert.match(c.earlierAgentKept, /^data\/archived-agents\/copy-/);
  const list = a.readJson();
  assert.deepStrictEqual(list.map(x => x.name).sort(), ['copy', 'other', 'src'], 'the delete and the create made meanwhile both stand');
  const boxes = list.map(x => x.box);
  assert.ok(boxes.every(b => /^[0-9a-f]{12}$/.test(b)) && new Set(boxes).size === 3, 'every box is its own; the clone never shares its source’s');
});

test('renaming into a name an earlier agent left things under puts them aside first; an agent at work is not renamed', async () => {
  const a = load({ agents: [{ name: 'helper' }, { name: 'busy' }] });
  chatStandIn(a, { busy: new Set(['busy']) });
  fs.mkdirSync(path.join(a.hub, 'data', 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(a.hub, 'data', 'conversations', 'scout.jsonl'), '{"role":"user","content":"the earlier scout"}\n');
  fs.writeFileSync(path.join(a.hub, 'data', 'agent-sessions.json'), JSON.stringify({ scout: { sessionId: 'old' } }));
  assert.deepStrictEqual(await a.ag.renameAgent('helper', 'scout'), { success: true, newName: 'scout' });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(a.hub, 'data', 'agent-sessions.json'), 'utf8')), {}, 'the earlier scout’s session is not resumed');
  assert.ok(!fs.existsSync(path.join(a.hub, 'data', 'conversations', 'scout.jsonl')));
  assert.strictEqual(a.bundles().filter(n => n.startsWith('scout-')).length, 1);
  assert.match((await a.ag.renameAgent('busy', 'idle')).error, /^busy is working right now \(a reply or a background job\)\. Stop it or wait until it finishes, then rename it\.$/);
  const scout = a.readJson().find(x => x.name === 'scout');
  assert.match(scout.box, /^[0-9a-f]{12}$/, 'an agent from before box ids gets one when renamed');
  assert.deepStrictEqual(a.removed.map(x => [x.name, x.box]), [['helper', undefined]], 'its old box (named after the old name) is removed');
});

test('renaming waits for nothing it shouldn’t: an agent that starts working while an earlier agent’s things are put away is not renamed', async () => {
  const a = load({ agents: [{ name: 'quick', box: 'dddddddddddd' }] });
  const busy = new Set();
  chatStandIn(a, { busy });
  fs.mkdirSync(path.join(a.hub, 'data', 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(a.hub, 'data', 'conversations', 'slow.jsonl'), '{}\n');   // an earlier slow left a chat
  a.ag.__archive.configure({ log: () => {}, isBoxed: () => false, sandbox: () => ({ retire: async () => { busy.add('quick'); return { result: 'none' }; }, remove: async () => {} }) });
  assert.match((await a.ag.renameAgent('quick', 'slow')).error, /^quick is working right now \(a reply or a background job\)\. Stop it or wait until it finishes, then rename it\.$/);
  assert.deepStrictEqual(a.readJson().map(x => x.name), ['quick']);
});

test('member teams and assistants go through the same door: an earlier agent’s things are put aside, each gets its own box, and an unreadable list is never written over', async () => {
  const a = load({ agents: [{ name: 'maestro' }] });
  const teams = require(path.join(a.hub, 'lib', 'teams.js'));
  const ann = { id: 'u_ann', login: 'ann@example.com', name: 'Ann' };
  fs.mkdirSync(path.join(a.hub, 'data', 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(a.hub, 'data', 'conversations', 'ann_assistant.jsonl'), '{"role":"user","content":"an earlier ann_assistant"}\n');
  fs.writeFileSync(path.join(a.hub, 'data', 'agent-sessions.json'), JSON.stringify({ ann_assistant: { sessionId: 'old' } }));
  const r = await teams.createDefaultAssistant(ann, { model: 'claude-sdk/x' });
  assert.deepStrictEqual(r, { ok: true, name: 'ann_assistant' });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(a.hub, 'data', 'agent-sessions.json'), 'utf8')), {}, 'the earlier session is not resumed');
  assert.ok(a.bundles().some(n => n.startsWith('ann_assistant-')));
  const rec = a.readJson().find(x => x.name === 'ann_assistant');
  assert.match(rec.box, /^[0-9a-f]{12}$/);
  // copies of a template keep nothing of its box
  a.ag.addAgentEntries([{ name: 'copy1', box: rec.box }, { name: 'copy2', box: rec.box }]);
  const boxes = a.readJson().filter(x => x.name.startsWith('copy')).map(x => x.box);
  assert.ok(boxes.every(b => b !== rec.box) && boxes[0] !== boxes[1]);
  // a list that can't be read: nothing is created, and the file is left for a person to look at
  fs.writeFileSync(path.join(a.hub, 'data', 'agents.json'), '[{"name": "maestro"}, {"half');
  const bob = { id: 'u_bob', login: 'bob@example.com', name: 'Bob' };
  const e = console.error; console.error = () => {};
  let r2; try { r2 = await teams.createDefaultAssistant(bob, { model: 'claude-sdk/x' }); } finally { console.error = e; }
  assert.strictEqual(r2.ok, false);
  assert.match(r2.error, /the agent list can't be read/);
  assert.strictEqual(fs.readFileSync(path.join(a.hub, 'data', 'agents.json'), 'utf8'), '[{"name": "maestro"}, {"half');
});

test('a bundle is never seen half-made, and the combined archive’s copy staged by a split that stopped goes with the agent', async () => {
  const a = load({ agents: [{ name: 'gone' }] });
  const arch = a.ag.getAgentArchive();
  fs.mkdirSync(path.join(a.hub, 'data', 'archived-agents', '.gone-20261105T000000Z.partial.123.new'), { recursive: true });   // a begin cut short
  assert.deepStrictEqual(arch.pendingFor('gone'), []);
  assert.strictEqual((await arch.finishPending()).length, 0);
  // the combined file is in use, and a split that stopped had already copied gone's rows into its own file
  fs.writeFileSync(path.join(a.hub, 'data', 'transcript.db'), '');
  const T = require(path.join(a.hub, 'lib', 'transcript.js'));
  const tr = T.getTranscript();
  tr.record({ agent: 'gone', kind: 'user', text: 'gone was told' });
  const staged = T.createTranscript({ file: path.join(a.root, 'none.db'), dir: path.join(a.hub, 'data', 'transcripts'), log: () => {} });
  staged.record({ agent: 'gone', kind: 'user', text: 'gone was told' }); staged.close();
  const r = await a.ag.deleteAgent('gone');
  assert.strictEqual(r.unfinished, undefined, JSON.stringify(r));
  assert.ok(fs.existsSync(path.join(a.hub, r.keptIn, 'archive.db')) && fs.existsSync(path.join(a.hub, r.keptIn, 'archive-staged.db')));
  assert.ok(!fs.existsSync(tr.fileFor('gone')), 'no staged copy left for a later split to hand to a new agent of that name');
  assert.deepStrictEqual(await a.ag.createAgent('gone', undefined, '', null, null, null, null).then(x => [x.success, x.earlierAgentKept]), [true, undefined]);
});

test('two requests for one name at once: the second waits, never sweeps away what the first just made, and finds the name taken', async () => {
  const a = load({ agents: [] });
  fs.mkdirSync(path.join(a.hub, 'data', 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(a.hub, 'data', 'conversations', 'scout.jsonl'), '{"role":"user","content":"an earlier scout"}\n');
  let release;
  const gate = new Promise(r => { release = r; });
  a.ag.__archive.configure({ log: () => {}, isBoxed: () => false, sandbox: () => ({ retire: async () => { await gate; return { result: 'none' }; }, remove: async () => {} }) });
  const first = a.ag.createAgent('scout', undefined, '', null, null, null, { files: { 'SOUL.md': 'the first scout\n' } });
  const second = a.ag.createAgent('scout', undefined, '', null, null, null, { files: { 'SOUL.md': 'the second scout\n' } });
  await new Promise(r => setTimeout(r, 30));
  release();
  const [r1, r2] = await Promise.all([first, second]);
  assert.strictEqual(r1.success, true, r1.error);
  assert.strictEqual(r2.success, false);
  assert.match(r2.error, /exists|already exists/);
  assert.strictEqual(fs.readFileSync(path.join(a.ws('scout'), 'SOUL.md'), 'utf8'), 'the first scout\n', 'the first scout keeps its folder');
  assert.strictEqual(a.bundles().filter(n => n.startsWith('scout-')).length, 1, 'one bundle: the earlier scout\'s');
});

test('two members whose assistants would share a name: the second waits and writes nothing into the first one\'s folder', async () => {
  const a = load({ agents: [{ name: 'maestro' }] });
  const teams = require(path.join(a.hub, 'lib', 'teams.js'));
  fs.mkdirSync(path.join(a.hub, 'data', 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(a.hub, 'data', 'conversations', 'ann_assistant.jsonl'), '{}\n');   // makes the first one wait in the sweep
  let release;
  const gate = new Promise(r => { release = r; });
  a.ag.__archive.configure({ log: () => {}, isBoxed: () => false, sandbox: () => ({ retire: async () => { await gate; return { result: 'none' }; }, remove: async () => {} }) });
  const one = teams.createDefaultAssistant({ id: 'u_1', login: 'ann@one.example', name: 'Ann One' }, { model: 'claude-sdk/x' });
  const two = teams.createDefaultAssistant({ id: 'u_2', login: 'ann@two.example', name: 'Ann Two' }, { model: 'claude-sdk/x' });
  await new Promise(r => setTimeout(r, 30));
  release();
  const [r1, r2] = await Promise.all([one, two]);
  assert.deepStrictEqual(r1, { ok: true, name: 'ann_assistant' });
  assert.deepStrictEqual(r2, { ok: false, error: 'an agent named ann_assistant belongs to someone else; this member needs an assistant under another name' }, 'never another member\'s assistant passed off as this one\'s');
  const user = fs.readFileSync(path.join(a.ws('ann_assistant'), 'USER.md'), 'utf8');
  assert.ok(user.includes('Ann One') && !user.includes('Ann Two'), 'the first member\'s assistant knows only its own person');
  assert.strictEqual(a.readJson().filter(x => x.name === 'ann_assistant').length, 1);
});

test('deleteAgent: a background job still running in the agent counts as at work; two agents sharing a box id keep their home folder', async () => {
  const a = load({ agents: [{ name: 'jobby' }, { name: 'one', box: 'abababababab' }, { name: 'two', box: 'abababababab' }] });
  const chat = chatStandIn(a);
  const jobs = new Map([['j1', { owner: 'jobby', status: 'running' }], ['j2', { owner: 'one', status: 'finished' }]]);
  require.cache[path.join(a.hub, 'lib', 'sdk-chat.js')].exports.getJobRunner = () => ({ jobs });
  assert.match((await a.ag.deleteAgent('jobby')).error, /^jobby is working right now \(a reply or a background job\)/);
  jobs.get('j1').status = 'cancelling';   // stopping, but its process is still alive
  assert.match((await a.ag.deleteAgent('jobby')).error, /^jobby is working right now/);
  const retires = [];
  a.ag.__archive.configure({ log: () => {}, isBoxed: () => true, sandbox: () => ({ retire: async (agent, into, o) => { retires.push([agent.name, agent.box, !!o.keepHome]); return { result: 'removed' }; }, remove: async () => {} }) });
  const r = await a.ag.deleteAgent('one');
  assert.strictEqual(r.success, true, r.error);
  assert.deepStrictEqual(retires, [['one', 'abababababab', true]], 'two still uses that home folder: it stays');
  assert.ok(chat);
});

test('withNames: a request that already holds a name and asks for it again is refused instead of waiting on itself; errors release the name', async () => {
  const a = load({ agents: [] });
  await assert.rejects(a.ag.withNames(['x'], () => a.ag.withNames(['y', 'x'], async () => 1)), /^Error: a change of agent names is already under way in this request \(y, x asked for again\)$/);
  await assert.rejects(a.ag.withNames(['x'], () => a.ag.withNames(['z'], async () => 1)), /already under way in this request/, 'more names later could wait on a request waiting for this one: refused too');
  await assert.rejects(a.ag.withNames(['x'], async () => { throw new Error('boom'); }), /boom/);
  assert.strictEqual(await a.ag.withNames(['x'], async () => 'released after a throw'), 'released after a throw');
  // work a locked section starts and leaves running may take names once the section is over
  let later;
  await a.ag.withNames(['x'], async () => { later = new Promise(r => setTimeout(r, 10)).then(() => a.ag.withNames(['x'], async () => 'later')); });
  assert.strictEqual(await later, 'later');
  const order = [];
  await Promise.all([a.ag.withNames(['p', 'q'], async () => { order.push('pq'); await new Promise(r => setTimeout(r, 20)); }), a.ag.withNames(['q', 'p'], async () => { order.push('qp'); })]);
  assert.deepStrictEqual(order, ['pq', 'qp'], 'callers with the same names in any order wait their turn, without a deadlock');
});

test('renaming an agent takes everything it keeps under its name along (it carries on, and the old name is free); a step that fails puts everything back', async () => {
  const a = load({ agents: [{ name: 'maestro' }, { name: 'scout', display: 'Scout', model: 'claude-sdk/x' }] });
  const comp = { names: new Set(['scout']), fail: null, rename(from, to) { if (this.fail) throw this.fail; if (!this.names.has(from)) return false; this.names.delete(from); this.names.add(to); return true; } };
  const chat = chatStandIn(a, { tasks: [{ id: 't1', agent: 'scout', label: 'daily' }, { id: 't2', agent: 'maestro', label: 'other' }], compaction: comp });
  const d = (...p) => path.join(a.hub, 'data', ...p);
  fs.mkdirSync(path.join(a.ws('scout'), 'records'), { recursive: true });
  fs.writeFileSync(path.join(a.ws('scout'), 'records', 'facts.md'), 'facts\n');
  fs.mkdirSync(d('conversations'), { recursive: true });
  fs.writeFileSync(d('conversations', 'scout.jsonl'), '{"role":"user","content":"hi"}\n');
  fs.writeFileSync(d('conversations', 'maestro.jsonl'), '{"role":"user","content":"stay"}\n');
  fs.writeFileSync(d('agent-sessions.json'), JSON.stringify({ scout: { sessionId: 's1' }, maestro: { sessionId: 'm1' } }));
  fs.chmodSync(d('agent-sessions.json'), 0o640);
  fs.writeFileSync(d('codex-sessions.json'), JSON.stringify({ scout: { threadId: 'c1' } }));
  const mem = require(path.join(a.hub, 'lib', 'memory-db.js'));
  mem.writeLongTermMemory('scout', 'long term'); mem.writeSessionNote('scout', 'a note'); mem.saveDistillation('scout', '2026-11-01', 'sum');
  mem.writeLongTermMemory('maestro', 'mine');
  fs.mkdirSync(d('sessions', 'scout'), { recursive: true }); fs.writeFileSync(d('sessions', 'scout', 'n.md'), 'n');
  fs.mkdirSync(d('context-refresh'), { recursive: true }); fs.writeFileSync(d('context-refresh', 'scout.json'), '{}');
  const tr = require(path.join(a.hub, 'lib', 'transcript.js')).getTranscript();
  tr.record({ agent: 'scout', kind: 'user', text: 'scout was told this' });
  tr.record({ agent: 'maestro', kind: 'user', text: 'maestro keeps this' });
  fs.mkdirSync(path.join(a.root, 'share', 'scout')); fs.writeFileSync(path.join(a.root, 'share', 'scout', 'out.pdf'), 'pdf');
  const had = mem.getMemoryStats('scout');
  const json = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

  assert.deepStrictEqual(await a.ag.renameAgent('scout', 'ranger'), { success: true, newName: 'ranger' });
  assert.strictEqual(fs.readFileSync(path.join(a.ws('ranger'), 'records', 'facts.md'), 'utf8'), 'facts\n');
  assert.ok(fs.existsSync(d('conversations', 'ranger.jsonl')) && !fs.existsSync(d('conversations', 'scout.jsonl')) && fs.existsSync(d('conversations', 'maestro.jsonl')));
  assert.deepStrictEqual(json(d('agent-sessions.json')), { ranger: { sessionId: 's1' }, maestro: { sessionId: 'm1' } }, 'its Claude session resumes under the new name');
  assert.strictEqual(fs.statSync(d('agent-sessions.json')).mode & 0o777, 0o640);
  assert.deepStrictEqual(json(d('codex-sessions.json')), { ranger: { threadId: 'c1' } });
  assert.deepStrictEqual(mem.getMemoryStats('ranger'), had, 'its memory rows');
  assert.deepStrictEqual(mem.getMemoryStats('scout'), mem.getMemoryStats('nobody'), 'none left under the old name');
  assert.ok(fs.existsSync(d('sessions', 'ranger', 'n.md')) && fs.existsSync(d('context-refresh', 'ranger.json')));
  assert.ok(fs.existsSync(path.join(a.root, 'share', 'ranger', 'out.pdf')) && !fs.existsSync(path.join(a.root, 'share', 'scout')));
  assert.strictEqual(tr.search('ranger', 'told').length, 1, 'its archive is found under the new name');
  assert.strictEqual(tr.stats('scout').entries, 0);
  assert.strictEqual(tr.search('maestro', 'keeps').length, 1, 'another agent\'s archive untouched');
  assert.deepStrictEqual(chat.st.list.map(t => [t.id, t.agent]), [['t1', 'ranger'], ['t2', 'maestro']], 'its scheduled tasks wake it under the new name');
  assert.deepStrictEqual([...comp.names], ['ranger'], 'its compression history');
  assert.deepStrictEqual(chat.forgot, ['scout', 'ranger'], 'nothing kept in memory under either name');
  assert.deepStrictEqual(a.readJson().map(x => [x.name, x.display || null]), [['maestro', null], ['ranger', 'Scout']]);
  const fresh = await a.ag.createAgent('scout', 'claude-sdk/x', 'a new scout', null, 'specialist');
  assert.strictEqual(fresh.success, true, fresh.error);
  assert.strictEqual(fresh.earlierAgentKept, undefined, 'the old name is free: nothing was left under it');

  // a step near the end fails: everything that moved goes back, and the agent keeps its name
  comp.fail = new Error('disk full');
  const r = await a.ag.renameAgent('ranger', 'trail');
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error, 'Scout was not renamed (disk full).');
  assert.ok(fs.existsSync(path.join(a.ws('ranger'), 'records', 'facts.md')) && !fs.existsSync(a.ws('trail')));
  assert.ok(fs.existsSync(d('conversations', 'ranger.jsonl')) && !fs.existsSync(d('conversations', 'trail.jsonl')));
  assert.deepStrictEqual(json(d('agent-sessions.json')), { ranger: { sessionId: 's1' }, maestro: { sessionId: 'm1' } });
  assert.deepStrictEqual(mem.getMemoryStats('ranger'), had);
  assert.strictEqual(tr.search('ranger', 'told').length, 1);
  assert.deepStrictEqual(chat.st.list.map(t => [t.id, t.agent]), [['t1', 'ranger'], ['t2', 'maestro']]);
  assert.ok(a.readJson().some(x => x.name === 'ranger') && !a.readJson().some(x => x.name === 'trail'));
});

test('an agent the admin granted something by name (wallet access, a root grant, connectors, API tokens) is renamed only once that is removed', async () => {
  const a = load({ agents: [{ name: 'maestro' }, { name: 'degen', display: 'Degen' }] });
  chatStandIn(a);
  fs.writeFileSync(path.join(a.hub, 'data', 'settings.json'), JSON.stringify({ walletAgents: ['degen'] }));
  const r = await a.ag.renameAgent('degen', 'trader');
  assert.deepStrictEqual(r, { success: false, error: 'Degen has wallet access (walletAgents in data/settings.json) under its name. Remove it, rename it, then grant it again to trader.' });
  assert.ok(a.readJson().some(x => x.name === 'degen'));
});

test('renaming onto an empty folder of the new name works (nothing of anyone\'s is there); a folder with something in it is never replaced', async () => {
  const a = load({ agents: [{ name: 'maestro' }, { name: 'scout' }, { name: 'other' }] });
  chatStandIn(a);
  fs.mkdirSync(path.join(a.ws('scout'), 'records'), { recursive: true }); fs.writeFileSync(path.join(a.ws('scout'), 'records', 'f.md'), 'f');
  fs.mkdirSync(a.ws('ranger'), { recursive: true });   // empty
  fs.mkdirSync(path.join(a.hub, 'data', 'sessions', 'scout'), { recursive: true }); fs.writeFileSync(path.join(a.hub, 'data', 'sessions', 'scout', 'n.md'), 'n');
  assert.deepStrictEqual(await a.ag.renameAgent('scout', 'ranger'), { success: true, newName: 'ranger' });
  assert.ok(fs.existsSync(path.join(a.ws('ranger'), 'records', 'f.md')) && fs.existsSync(path.join(a.hub, 'data', 'sessions', 'ranger', 'n.md')));
});

test('call recordings block a rename and a delete only when a real session folder is there: a stray folder does not', async () => {
  const a = load({ agents: [{ name: 'maestro' }, { name: 'stray' }, { name: 'kept' }, { name: 'stray2' }] });
  chatStandIn(a);
  const rec = (agent, ...parts) => fs.mkdirSync(path.join(a.root, 'call-recordings', agent, ...parts), { recursive: true });
  rec('stray', 'notes-folder');   // not the store's session pattern
  rec('kept', '20261113-220000-0a0b0c');
  const r = await a.ag.renameAgent('stray', 'stray-moved');
  assert.deepStrictEqual(r, { success: true, newName: 'stray-moved' }, 'only a stray folder: no block');
  const blocked = await a.ag.renameAgent('kept', 'kept2');
  assert.strictEqual(blocked.success, false);
  assert.match(blocked.error, /has call recordings/);
  assert.match((await a.ag.deleteAgent('kept')).error, /has call recordings/);
  rec('stray2', 'something-else');
  const del = await a.ag.deleteAgent('stray2');
  assert.strictEqual(del.success, true, JSON.stringify(del));
});
