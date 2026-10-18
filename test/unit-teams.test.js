'use strict';
// Behavioural unit tests for lib/teams.js. The module hard-codes the hub tree (data/agents.json,
// workspaces/, ../users/) and reads/writes agents.json with the plain fs module, so the test remaps
// every path under the hub home into a temp dir: via the fsImpl injection where the module offers it,
// and by wrapping fs.readFileSync / writeFileSync / existsSync (same function objects) for the rest.
// sdk-chat and agents are replaced in require.cache so no SDK, hub HTTP call or live registry is touched.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HUB_ROOT = path.resolve(__dirname, '..');
const HUB_HOME = path.resolve(HUB_ROOT, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-teams-'));
const TREES = [path.join(HUB_HOME, 'users'), path.join(HUB_ROOT, 'data'), path.join(HUB_ROOT, 'workspaces')];   // the only trees the module touches
const remap = (p) => (typeof p === 'string' && TREES.some(t => p === t || p.startsWith(t + path.sep)) ? path.join(TMP, p.slice(HUB_HOME.length)) : p);
const real = { readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync, existsSync: fs.existsSync };
fs.readFileSync = (p, ...r) => real.readFileSync(remap(p), ...r);
fs.writeFileSync = (p, ...r) => real.writeFileSync(remap(p), ...r);
fs.existsSync = (p) => real.existsSync(remap(p));
const fsImpl = {};
for (const k of ['mkdirSync', 'chmodSync', 'readdirSync', 'readFileSync', 'writeFileSync']) fsImpl[k] = (p, ...r) => fs[k](remap(p), ...r);
const sdkLog = {};
for (const [mod, exports] of [['../lib/sdk-chat', { loadConversationLog: (n) => sdkLog[n] || [], appendConversationLog: (n, role, t) => { (sdkLog[n] = sdkLog[n] || []).push({ role, t }); } }], ['../lib/agents', { getAgents: () => [] }]]) {
  const id = require.resolve(mod);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
const T = require('../lib/teams');
// Team templates are the owner's configuration (settings.teamTemplates); the tests supply their own.
T.useTemplates({ medical: { folder: 'medical', members: ['gp', 'labs', 'pharm', 'nutrition', 'sleep', 'vision', 'fitness', 'dental', 'secondopinion', 'wellness'], head: 'gp' }, legal: { folder: 'legal', members: ['contracts', 'counsel', 'benefits', 'property', 'taxes', 'business', 'legaldocs', 'legalreview', 'homefix'], head: 'counsel' } });
T.TEMPLATES = T.templates();

const DATA = path.join(TMP, path.basename(HUB_ROOT), 'data');
const WS = path.join(TMP, path.basename(HUB_ROOT), 'workspaces');
const readAgents = () => JSON.parse(real.readFileSync(path.join(DATA, 'agents.json'), 'utf8'));
const rd = (...p) => real.readFileSync(path.join(...p), 'utf8');
const ann = { id: 'u_ann1', login: 'Ann.Lee@example.com', name: 'Ann Lee' };

function seedHub() {
  fs.mkdirSync(DATA, { recursive: true });
  const list = [...T.TEMPLATES.medical.members, ...T.TEMPLATES.legal.members].map(n => ({ name: n, model: 'claude-sdk/x', category: n === 'gp' || n === 'counsel' ? 'primary' : 'specialist', lead: n === 'gp', sharedWith: ['u_x'], policy: { web: true }, display: n === 'gp' ? 'GP' : undefined }));
  list.push({ name: 'maestro', model: 'm' });
  real.writeFileSync(path.join(DATA, 'agents.json'), JSON.stringify(list));
  for (const n of T.TEMPLATES.medical.members) fs.mkdirSync(path.join(WS, n), { recursive: true });
  real.writeFileSync(path.join(WS, 'gp', 'SOUL.md'), `Head of the team. Consult labs and pharm; docs folder: ~/agent-hub/medical/patients and ${path.join(HUB_HOME, 'medical')}/inbox. The vision_specialist alias and "wellness." stay distinct.`);
  real.writeFileSync(path.join(WS, 'gp', 'notes.txt'), 'not copied');
  real.writeFileSync(path.join(WS, 'labs', 'IDENTITY.md'), 'labs reports to gp');
}

test('prefixFor: login local part, sanitised, 16 chars, must start with a letter, explicit prefix wins', () => {
  assert.strictEqual(T.prefixFor(ann), 'annlee');
  assert.strictEqual(T.prefixFor({ login: '123abc@x.com' }), 'm123abc');
  assert.strictEqual(T.prefixFor({ login: 'averyveryverylongloginname@x.com' }), 'averyveryverylon');
  assert.strictEqual(T.prefixFor({ name: 'Bob Smith' }), 'bobsmith', 'falls back to the name');
  assert.strictEqual(T.prefixFor({}), 'member');
  assert.strictEqual(T.prefixFor(ann, 'Team-One'), 'teamone');
  assert.strictEqual(T.prefixFor(ann, '!!!'), 'm', 'nothing left: just the m guard');
});

test('rewrite: teammate names on word boundaries, team folder paths in both spellings', () => {
  const nameMap = { doc: 'p_doc', labs: 'p_labs' };
  const out = T.rewrite('doc talks to labs; docs and labs_x and doc_y stay; ~/agent-hub/medical/x and ' + path.join(HUB_HOME, 'medical') + '/y', { nameMap, oldFolder: 'medical', newFolder: '/new/medical' });
  assert.strictEqual(out, 'p_doc talks to p_labs; docs and labs_x and doc_y stay; /new/medical/x and /new/medical/y');
  assert.strictEqual(T.rewrite(123, { nameMap: {}, oldFolder: 'legal', newFolder: '/n' }), '123', 'non-strings are stringified');
});

test('userFile: owner block, Files folder line, head/team variants', () => {
  const head = T.userFile(ann, { team: 'medical', head: true });
  assert.ok(head.includes('- **Name:** Ann Lee') && head.includes('- **Email:** Ann.Lee@example.com'));
  assert.ok(head.includes('This team is theirs; you are its head.'));
  assert.ok(head.includes(`- ${path.join(HUB_HOME, 'users', 'u_ann1', 'files')}`), 'Files folder line present');
  assert.ok(head.includes('Working folder for this team'));
  const member = T.userFile({ id: 7, login: 'x@y.z' });
  assert.ok(member.includes('- **Name:** x@y.z') && member.includes('You are one of their team.') && !member.includes('Working folder for this team'));
  assert.ok(member.includes(path.join(HUB_HOME, 'users', '7', 'files')));
});

test('assistantSoul and GREETING_PROMPT are personalised and name the tools', () => {
  const s = T.assistantSoul(ann);
  assert.ok(s.startsWith('# SOUL.md') && s.includes("You are Ann Lee's personal assistant") && s.includes('`rename_me`') && s.includes('`request_agent`') && s.includes('`spawn_workers`'));
  assert.ok(T.assistantSoul({ login: 'only@x.com' }).includes("only@x.com's personal assistant"));
  assert.ok(T.GREETING_PROMPT(ann).includes('created for Ann Lee') && T.GREETING_PROMPT({ login: 'l@x' }).includes('created for l@x'));
});

test('greetAgent: skipped with history, posts the greeting, appends the reply, empty reply is dropped', async () => {
  const calls = [];
  const post = async (name, prompt) => { calls.push([name, prompt]); return '  Hello from the head  '; };
  const append = (n, t) => calls.push(['append', n, t]);
  assert.strictEqual(await T.greetAgent('a1', ann, { post, append, hasHistory: () => true }), null);
  assert.strictEqual(calls.length, 0, 'nothing posted when the chat has history');
  assert.strictEqual(await T.greetAgent('a1', ann, { post, append, hasHistory: () => false }), 'Hello from the head');
  assert.deepStrictEqual(calls, [['a1', T.GREETING_PROMPT(ann)], ['append', 'a1', 'Hello from the head']]);
  assert.strictEqual(await T.greetAgent('a2', ann, { post: async () => '   ', append, hasHistory: () => false }), null);
  assert.strictEqual(calls.length, 2, 'empty reply: nothing appended');
  sdkLog.a3 = [{ role: 'user', t: 'hi' }];
  assert.strictEqual(await T.greetAgent('a3', ann, { post }), null, 'default history check uses the conversation log');
  assert.strictEqual(await T.greetAgent('a4', ann, { post }), 'Hello from the head');
  assert.deepStrictEqual(sdkLog.a4, [{ role: 'assistant', t: 'Hello from the head' }], 'default append writes to the conversation log');
  await assert.rejects(T.greetAgent('a5', ann, { post: async () => { throw new Error('down'); }, hasHistory: () => false }), /down/);
});

test('createTeamForUser: validation before any write', async () => {
  seedHub();
  assert.deepStrictEqual(await T.createTeamForUser({ template: 'medical', fsImpl }), { ok: false, error: 'user required' });
  assert.deepStrictEqual(await T.createTeamForUser({ user: {}, template: 'medical', fsImpl }), { ok: false, error: 'user required' });
  assert.match((await T.createTeamForUser({ user: ann, template: 'dental', fsImpl })).error, /^unknown template \(medical, legal\)$/);
  const list = readAgents().filter(a => a.name !== 'labs');
  real.writeFileSync(path.join(DATA, 'agents.json'), JSON.stringify(list));
  assert.match((await T.createTeamForUser({ user: ann, template: 'Medical', fsImpl })).error, /template agents missing on this hub: labs/);
  assert.ok(!real.existsSync(path.join(WS, 'annlee_gp')) && !real.existsSync(path.join(TMP, 'users')), 'nothing created');
});

test('createTeamForUser: copies .md files with names and folders rewritten, writes USER.md, registers owned agents', async () => {
  seedHub();
  const r = await T.createTeamForUser({ user: ann, template: 'medical', fsImpl });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.prefix, 'annlee');
  assert.strictEqual(r.head, 'annlee_gp');
  assert.deepStrictEqual(r.agents, T.TEMPLATES.medical.members.map(n => `annlee_${n}`));
  assert.strictEqual(r.folder, path.join(HUB_HOME, 'users', 'u_ann1', 'medical'), 'folder is the real (unremapped) path the agents will use');
  for (const sub of ['inbox', 'patients', 'matters', 'documents', 'reference']) assert.ok(real.existsSync(path.join(TMP, 'users', 'u_ann1', 'medical', sub)), sub);
  const soul = rd(WS, 'annlee_gp', 'SOUL.md');
  assert.strictEqual(soul, `Head of the team. Consult annlee_labs and annlee_pharm; docs folder: ${r.folder}/patients and ${r.folder}/inbox. The vision_specialist alias and "annlee_wellness." stay distinct.`);
  assert.strictEqual(rd(WS, 'annlee_labs', 'IDENTITY.md'), 'annlee_labs reports to annlee_gp');
  assert.ok(!real.existsSync(path.join(WS, 'annlee_gp', 'notes.txt')), 'only .md files are copied');
  const userMd = rd(WS, 'annlee_gp', 'USER.md');
  assert.ok(userMd.includes('you are its head') && userMd.includes(path.join(HUB_HOME, 'users', 'u_ann1', 'files')));
  assert.ok(rd(WS, 'annlee_labs', 'USER.md').includes('You are one of their team.'));
  assert.ok(real.existsSync(path.join(WS, 'annlee_vision', 'USER.md')), 'template agents with an empty workspace still get USER.md');
  const all = readAgents();
  const doc = all.find(a => a.name === 'annlee_gp'); const labs = all.find(a => a.name === 'annlee_labs');
  assert.strictEqual(all.length, 20 + 10, 'template agents kept, ten added');
  assert.deepStrictEqual(doc, { name: 'annlee_gp', model: 'claude-sdk/x', category: 'primary', owner: 'u_ann1', display: 'GP' }, 'lead/sharedWith/policy dropped, owner set');
  assert.strictEqual(labs.display, 'labs', 'display defaults to the template name');
  assert.ok(all.find(a => a.name === 'gp').lead === true, 'template record untouched');
  const again = await T.createTeamForUser({ user: ann, template: 'medical', fsImpl });
  assert.match(again.error, /^agents already exist: annlee_gp, .*choose another prefix\)$/);
  const legal = await T.createTeamForUser({ user: ann, template: 'legal', prefix: 'Lex 2', fsImpl });
  assert.ok(legal.ok && legal.head === 'lex2_counsel' && legal.agents.length === 9);
  assert.ok(real.existsSync(path.join(TMP, 'users', 'u_ann1', 'legal', 'matters')));
});

test('createDefaultAssistant: one personal agent, existed:true on the second call', async () => {
  seedHub();
  const r = await T.createDefaultAssistant(ann, { model: 'claude-sdk/test-model', fsImpl });
  assert.deepStrictEqual(r, { ok: true, name: 'annlee_assistant' });
  const rec = readAgents().find(a => a.name === 'annlee_assistant');
  assert.deepStrictEqual(rec, { name: 'annlee_assistant', model: 'claude-sdk/test-model', display: 'Assistant', icon: '🙂', type: 'normal', category: 'primary', owner: 'u_ann1', blurb: "Ann Lee's personal assistant" });
  assert.strictEqual(rd(WS, 'annlee_assistant', 'SOUL.md'), T.assistantSoul(ann));
  assert.ok(rd(WS, 'annlee_assistant', 'IDENTITY.md').includes("## Role\nAnn Lee's personal assistant on My Maestro AI."));
  assert.ok(rd(WS, 'annlee_assistant', 'USER.md').includes('you are its head'));
  assert.ok(real.existsSync(path.join(TMP, 'users', 'u_ann1', 'files')), 'Files folder created');
  assert.deepStrictEqual(await T.createDefaultAssistant(ann, { model: 'other', fsImpl }), { ok: true, name: 'annlee_assistant', existed: true });
  assert.strictEqual(readAgents().filter(a => a.name === 'annlee_assistant').length, 1);
  assert.deepStrictEqual(await T.createDefaultAssistant(null, { fsImpl }), { ok: false, error: 'user required' });
});

test('greetIfFresh: only primary agents, writes USER.md when missing, errors swallowed', async () => {
  seedHub();
  fs.mkdirSync(path.join(WS, 'counsel'), { recursive: true });
  const posted = [];
  const opts = { post: async (n) => { posted.push(n); return 'hi'; }, append: () => {}, hasHistory: () => false };
  assert.strictEqual(await T.greetIfFresh('labs', ann, opts), null, 'specialist: no greeting');
  assert.strictEqual(await T.greetIfFresh('nope', ann, opts), null);
  assert.strictEqual(await T.greetIfFresh('counsel', ann, opts), 'hi');
  assert.deepStrictEqual(posted, ['counsel']);
  assert.ok(rd(WS, 'counsel', 'USER.md').includes('- **Name:** Ann Lee'), 'USER.md written for the new owner');
  real.writeFileSync(path.join(WS, 'gp', 'USER.md'), 'keep me');
  await T.greetIfFresh('gp', ann, opts);
  assert.strictEqual(rd(WS, 'gp', 'USER.md'), 'keep me', 'an existing USER.md is left alone');
  assert.strictEqual(await T.greetIfFresh('gp', ann, { post: async () => { throw new Error('x'); }, hasHistory: () => false }), null, 'poster failure is swallowed');
});
