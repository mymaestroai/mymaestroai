'use strict';
// Members cannot create agents: their assistant files a request; approving creates the agent or team.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAgentRequests } = require('../lib/agent-requests');
const teams = require('../lib/teams');

function make(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'areq-'));
  const events = []; const logs = []; const createdAgents = []; const createdTeams = [];
  const ar = createAgentRequests({ file: path.join(dir, 'r.json'), onEvent: (e) => events.push(e), log: () => {},
    createTeam: async (o) => { createdTeams.push(o); return { ok: true, agents: ['sam_doc', 'sam_labs'], head: 'sam_doc' }; },
    createAgent: async (name, model, personality, skills, category, owner) => { createdAgents.push({ name, model, category, owner }); return { success: true, name }; },
    appendLog: (agent, role, text) => logs.push([agent, role, text]),
    getUser: (id) => (id === 'u_k' ? { id: 'u_k', login: 'sam@example.com', name: 'Sam' } : null), ...extra });
  return { ar, events, logs, createdAgents, createdTeams };
}

test('request -> event; approve an agent request creates it under the owner with a prefixed name; the chat gets a notice', async () => {
  const { ar, events, logs, createdAgents } = make();
  assert.strictEqual(ar.create({ byAgent: 'sam_assistant', ownerId: 'u_k', kind: 'agent', description: '' }).ok, false);
  const r = ar.create({ byAgent: 'sam_assistant', ownerId: 'u_k', kind: 'agent', name: 'Tutor', description: 'A patient math tutor for a 14 year old' });
  assert.ok(r.ok); assert.strictEqual(r.request.status, 'pending');
  assert.strictEqual(events[0].type, 'agent_request');
  assert.strictEqual(ar.all('pending').length, 1);
  const a = await ar.resolve(r.request.id, { action: 'approve', by: 'u_admin', note: 'enjoy' });
  assert.ok(a.ok);
  assert.deepStrictEqual(createdAgents[0], { name: 'sam_tutor', model: 'claude-sdk/claude-sonnet-5-5', category: 'specialist', owner: 'u_k' });
  assert.strictEqual(ar.get(r.request.id).status, 'approved');
  assert.match(logs[0][2], /approved the request for a agent "Tutor".*sam_tutor.*Note from the administrator: enjoy/);
  assert.strictEqual((await ar.resolve(r.request.id, { action: 'approve' })).ok, false, 'cannot resolve twice');
});

test('team requests pick a template from the wording; decline sends a note; pending cap', async () => {
  const { ar, logs, createdTeams } = make();
  const t = ar.create({ byAgent: 'sam_assistant', ownerId: 'u_k', kind: 'team', description: 'a legal team to review a lease' });
  assert.strictEqual(t.request.template, 'legal');
  const d = await ar.resolve(t.request.id, { action: 'decline', by: 'u_admin', note: 'not yet' });
  assert.ok(d.ok); assert.match(logs[0][2], /declined the request for a team\. Note: not yet/);
  const t2 = ar.create({ byAgent: 'sam_assistant', ownerId: 'u_k', kind: 'team', description: 'a medical team for my health' });
  const ap = await ar.resolve(t2.request.id, { action: 'approve', by: 'u_admin' });
  assert.deepStrictEqual(ap.created, { kind: 'team', agents: ['sam_doc', 'sam_labs'], head: 'sam_doc' });
  assert.strictEqual(createdTeams[0].template, 'medical');
  for (let i = 0; i < 5; i++) ar.create({ byAgent: 'sam_assistant', ownerId: 'u_k', kind: 'agent', description: `helper ${i}` });
  assert.match(ar.create({ byAgent: 'sam_assistant', ownerId: 'u_k', kind: 'agent', description: 'one more' }).error, /already 5 requests/);
});

test('default assistant: SOUL names the member, explains rename_me, request_agent and spawn_workers; wired into member creation', () => {
  const soul = teams.assistantSoul({ id: 'u_k', login: 'sam@example.com', name: 'Sam' });
  for (const s of ["Sam's personal assistant", 'rename_me', 'request_agent', 'spawn_workers', 'cannot send email']) assert.ok(soul.includes(s), s);
  const sdk = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.ok(sdk.includes("sdk.tool('request_agent', REQUEST_AGENT_DESC,") && sdk.includes("name: 'request_agent',"), 'tool on both paths');
  assert.ok(sdk.includes("sdk.tool('rename_me', RENAME_ME_DESC,") && sdk.includes("name: 'rename_me',"));
  assert.ok(sdk.includes("workerPolicy.disallowedToolsFor(memberOwned ? 'off' : workerMode)"), 'member agents get no SDK sub-agent tool');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.strictEqual((server.match(/createDefaultAssistant\(/g) || []).length, 2, 'invite acceptance and admin creation both create the assistant');
  assert.ok(server.includes("pathname === '/api/agent-requests' && req.method === 'GET'"));
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'lib', 'push.js'), 'utf8').includes("ev.type === 'agent_request'"));
});
