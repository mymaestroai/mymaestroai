'use strict';
// Every Maestro ships with a playbook for building agents with people (templates/workspaces/maestro/AGENT-PLAYBOOK.md):
// an interview first, then files the lead writes itself, saved as written by create_agent, then a test. The template
// SOUL.md and the setup interview point to it, the lead's hub brief names it (for installs whose SOUL.md was edited),
// and the shipped-files manifest lists it so an unedited copy is refreshed when it improves.
const { test, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The create_agent tool itself, on the Codex path: sign-ins come from a throwaway store, and createAgent is a stand-in
// (taken by sdk-chat when it loads), so nothing is written into this install's agents or workspaces.
// lib/ comes from a throwaway install, so nothing under the real data/ is touched.
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('agent-playbook-iso-');
const L = (p) => require(path.join(ISO.lib, p));
const AUTH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'playbook-auth-'));
process.env.HUB_AUTH_DIR = AUTH_DIR;
after(() => fs.rmSync(AUTH_DIR, { recursive: true, force: true }));
const created = [];
L('agents').createAgent = async (...args) => { created.push(args); return { success: true, name: args[0] }; };

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const PLAYBOOK = 'templates/workspaces/maestro/AGENT-PLAYBOOK.md';

test('the playbook: the interview starts with straightforward or personality, covers the job, knowledge, interests and limits, then files, create_agent and a test', () => {
  const p = read(PLAYBOOK);
  const steps = ['## Step 1 — Straightforward or with personality', '## Step 2 — The job', '## Step 3 — Personality (only if they chose it)',
    '## Step 4 — Which AI runs it (one question)', '## Step 5 — What you decide yourself', '## Step 6 — Check the plan', '## Step 7 — Write the files and create it',
    '## Step 8 — Test it, then hand it over'];
  let at = -1;
  for (const s of steps) { const i = p.indexOf(s); assert.ok(i > at, `${s} (in order)`); at = i; }
  for (const s of ['**Straightforward** / **With personality**', "What it's for, and who it's for", 'What it must know', 'special skills or knowledge', "what they're interested in",
    "Don't spend a question on limits", 'Name, icon and character, in one offer', 'Voice.', 'One question at a time', 'ask_user', 'never more than eight, counting the model and the plan check',
    'Never ask for passwords', 'Facts come only from them', 'Never work it out from an email address, an account or anything else you happen to see', 'Always ask this first, before anything else', '"(ask)"', 'NO_ANSWER', 'not a substitute for a professional', 'pass the email they sign in with as `for_user`', 'spell its limits out in full here', 'deleted or renamed',
    'soul_md, identity_md, user_md, tools_md, records, and for_user', 'up to 120 characters', 'consult_agent the new agent', "can't be consulted (it's theirs)",
    'belonged to an earlier agent', 'Changing an agent later'])
    assert.ok(p.includes(s), s);
  // The listed questions fit the cap: Step 1, three for the job, two for a personality, the model, the plan check.
  const numbered = (from, to) => (p.slice(p.indexOf(from), p.indexOf(to)).match(/^\d+\. \*\*/gm) || []).length;
  assert.strictEqual(1 + numbered('## Step 2', '## Step 3') + numbered('## Step 3', '## Step 4') + 1 + 1, 8);
  // The person chooses the model: a fair comparison, a recommendation, the buttons and the drop-down of every model.
  const model = p.slice(p.indexOf('## Step 4'), p.indexOf('## Step 5'));
  for (const s of ['They choose the model', "Whatever model you run on yourself, don't favour its maker", 'one strength, one weak point, and what it costs here',
    'Take the cost from your hub brief', 'can still send information out', 'Say only what you know', 'Write "no view"', 'point to the drop-down',
    'The question names your pick and why', "I'd pick <model>: <why, for this job>", 'in descriptions', '**You pick for me**', 'choose_model: true', 'every model this hub can use',
    'use a picked id exactly as it came'])
    assert.ok(model.includes(s), `model step: ${s}`);
  for (const s of ['keep everything on this computer', 'slower and less capable']) assert.ok(!p.includes(s), `no blanket claim: ${s}`);
  for (const f of ['# IDENTITY.md', '# SOUL.md — <display name>', '# USER.md — <person>', '# TOOLS.md — what <display name> works with', '(record of fact: from <person>; never assume)'])
    assert.ok(p.includes(f), `skeleton: ${f}`);
  // Every agent it builds gets the two standing sections.
  for (const s of ["## The hub's code is off limits", '## Written work: no notes about how it was made']) assert.ok(p.includes(s), s);
});

test('the template SOUL, the setup interview and the hub brief all point to the playbook; the tool takes the files', () => {
  assert.match(read('templates/workspaces/maestro/SOUL.md'), /## Building agents\n\nWhen someone asks for a new agent, or you suggest one, follow `AGENT-PLAYBOOK.md`/);
  const si = read('templates/workspaces/maestro/SETUP-INTERVIEW.md');
  assert.match(si, /## Step 3 — Build each one \(one at a time\)\n\nBuild each agent with `AGENT-PLAYBOOK.md`/);
  assert.match(si, /call create_agent with a lowercase name[^\n]*a display name, an icon, a one-line blurb and those files/);
  assert.ok(!/and a personality paragraph covering the role/.test(si), 'no longer built from a paragraph');
  assert.match(read('lib/hub-map.js'), /const PLAYBOOK_REL = path\.join\('workspaces', 'maestro', 'AGENT-PLAYBOOK\.md'\);/);
  const src = read('lib/sdk-chat.js');
  const tool = src.slice(src.indexOf("sdk.tool('create_agent'"), src.indexOf("sdk.tool('list_agents'"));
  for (const p of ['display:', 'icon:', 'blurb:', 'soul_md:', 'identity_md:', 'user_md:', 'tools_md:', 'records: z.array(z.object({', 'for_user:', 'AGENT-PLAYBOOK.md'])
    assert.ok(tool.includes(p), `create_agent: ${p}`);
  assert.match(tool, /await createAgent\(name, model, personality, null, category, member \? member\.id : null, \{ display, icon, blurb, files, records \}\)/);
  assert.match(tool, /\['SOUL\.md', soul_md\], \['IDENTITY\.md', identity_md\], \['USER\.md', user_md\], \['TOOLS\.md', tools_md\]/);
});

test('the shipped-files manifest lists the playbook at its current version', () => {
  const m = JSON.parse(read('templates/workspace-updates.json'));
  const e = m['maestro/AGENT-PLAYBOOK.md'];
  assert.ok(e && Array.isArray(e.previous), 'listed');
  assert.strictEqual(e.current, sha(fs.readFileSync(path.join(ROOT, PLAYBOOK))), 'AGENT-PLAYBOOK.md changed: move the old "current" into "previous" and set the new one');
  assert.ok(!e.previous.includes(e.current));
});

test('a fresh or existing install gets the playbook at start-up: seeding copies a missing template file and keeps an edited one', () => {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playbook-seed-'));
  try {
    const tpl = path.join(tmp, 'templates'), ws = path.join(tmp, 'workspaces');
    fs.mkdirSync(path.join(tpl, 'maestro'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, PLAYBOOK), path.join(tpl, 'maestro', 'AGENT-PLAYBOOK.md'));
    fs.mkdirSync(path.join(ws, 'maestro'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'maestro', 'SOUL.md'), 'their own soul\n');   // an existing install's edited files stay
    const { seedDefaultWorkspaces } = L('agents');
    assert.deepStrictEqual(seedDefaultWorkspaces(tpl, ws), [path.join('maestro', 'AGENT-PLAYBOOK.md')]);
    assert.strictEqual(fs.readFileSync(path.join(ws, 'maestro', 'AGENT-PLAYBOOK.md'), 'utf8'), read(PLAYBOOK));
    fs.writeFileSync(path.join(ws, 'maestro', 'AGENT-PLAYBOOK.md'), 'their own playbook\n');
    assert.deepStrictEqual(seedDefaultWorkspaces(tpl, ws), [], 'an existing copy is never overwritten by seeding');
    assert.strictEqual(fs.readFileSync(path.join(ws, 'maestro', 'SOUL.md'), 'utf8'), 'their own soul\n');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

function fakeRes() { return { events: [], writableEnded: false, destroyed: false, on() {}, write() { return true; } }; }

test('create_agent on the Codex path: the bridge lists every field, nested Records included; for_user gives the agent to a member, and only a member', async () => {
  const sdkChat = L('sdk-chat');
  const teams = L('teams');
  const greeted = [];
  teams.greetIfFresh = async (name, user) => { greeted.push([name, user.id]); return 'hello'; };
  const sdk = { tool: (name, description, shape, handler, opts) => ({ name, description, shape, handler, opts }), createSdkMcpServer: (cfg) => cfg };
  const server = await sdkChat.__askUser.buildHubMcpServer('zz_playbook_lead', fakeRes(), sdk, {});
  const tool = server.tools.find(t => t.name === 'create_agent');
  assert.ok(tool, 'create_agent registered');

  // What a Codex model is shown: the same fields, the Records as a list of { name, content } (not an empty object).
  const bridge = L('codex-cli/bridge');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playbook-bridge-'));
  const reg = bridge.register('zz_playbook_lead', server.tools, { url: 'http://127.0.0.1:1', dir });
  try {
    const listed = bridge.listTools(bridge._sessions.get(reg.token)).find(t => t.name === 'create_agent');
    const props = listed.inputSchema.properties;
    assert.deepStrictEqual(Object.keys(props).sort(), ['blurb', 'category', 'display', 'for_user', 'icon', 'identity_md', 'model', 'name', 'personality', 'records', 'soul_md', 'tools_md', 'user_md']);
    assert.deepStrictEqual(listed.inputSchema.required, ['name']);
    assert.strictEqual(props.records.type, 'array');
    assert.deepStrictEqual(Object.keys(props.records.items.properties).sort(), ['content', 'name']);
    assert.deepStrictEqual([...props.records.items.required].sort(), ['content', 'name']);
    // ask_user's two new fields reach a Codex model too: a line per option, and the model drop-down.
    const ask = bridge.listTools(bridge._sessions.get(reg.token)).find(t => t.name === 'ask_user').inputSchema.properties;
    assert.deepStrictEqual([ask.descriptions.type, ask.descriptions.items.type, ask.choose_model.type], ['array', 'string', 'boolean']);
  } finally { reg.release(); fs.rmSync(dir, { recursive: true, force: true }); }

  const auth = L('auth').getAuth();
  const robin = auth.createUser({ login: 'robin@example.com', name: 'Robin', role: 'member' }).user;
  auth.createUser({ login: 'boss@example.com', name: 'Boss', role: 'admin' });
  const gone = auth.createUser({ login: 'gone@example.com', name: 'Gone', role: 'member' }).user;
  auth.updateUser(gone.id, { disabled: true });
  const run = async (args) => (await tool.handler({ name: 'helper', ...args })).content[0].text;
  assert.match(await run({ for_user: 'nobody@example.com' }), /^Failed to create agent: no one on this hub signs in as "nobody@example.com"\. Leave for_user out, or ask an admin to invite them first/);
  assert.match(await run({ for_user: 'boss@example.com' }), /^Failed to create agent: Boss is an admin, and admins see every agent: leave for_user out\.$/);
  assert.match(await run({ for_user: 'gone@example.com' }), /^Failed to create agent: Gone's account is turned off\./);
  assert.deepStrictEqual(created, [], 'refused before anything was made');

  const forRobin = await run({ for_user: 'Robin@Example.com', category: 'primary', display: 'Homework Pal', soul_md: '# SOUL.md' });
  assert.match(forRobin, /^Agent "helper" created with SOUL\.md as written\. It belongs to Robin now: it is in their agent list, and it has been asked to write them a hello in its chat \(not checked yet: an admin can open that chat to see it\)\. You can't consult it/);
  assert.strictEqual(created[0][5], robin.id, 'the owner is the member');
  assert.deepStrictEqual(created[0][6].files, { 'SOUL.md': '# SOUL.md' });
  assert.strictEqual(created[0][1], L('settings').getSetting('memberDefaultModel', 'claude-sdk/claude-sonnet-5-5'), 'no model given: the member default, not the API fallback');
  assert.deepStrictEqual(greeted, [['helper', robin.id]], 'a head agent says hello to them');
  assert.match(await run({ name: 'quiet', for_user: 'robin@example.com' }), /It belongs to Robin now: it is in their agent list\. You can't consult it/);
  assert.strictEqual(greeted.length, 1, 'a specialist does not greet');
  assert.match(await run({ name: 'mine' }), /^Agent "mine" created\. It is in the agent list now; no restart is needed\.$/);
  assert.strictEqual(created[2][1], undefined, 'for the admin side the model stays as given');
  assert.strictEqual(created[2][5], null, 'without for_user: no owner (the admin side)');
});
