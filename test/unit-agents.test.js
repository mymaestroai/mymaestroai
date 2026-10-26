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
  ag.createAgent = quiet(ag.createAgent); ag.loadAgentContext = quiet(ag.loadAgentContext);
  const readJson = () => JSON.parse(fs.readFileSync(path.join(hub, 'data', 'agents.json'), 'utf8'));
  const auth = () => require(path.join(hub, 'lib', 'auth.js')).getAuth();
  return { ag, hub, root, calls, readJson, auth, ws: (n) => path.join(hub, 'workspaces', n) };
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
  for (const bad of ['', 'Bad', '1abc', 'a-b', 'a_b', null]) assert.strictEqual((await a.ag.createAgent(bad)).success, false, String(bad));
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
  assert.deepStrictEqual(await a.ag.deleteAgent('copy-1'), { success: true });
  assert.ok(!a.readJson().some(x => x.name === 'copy-1'));
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
