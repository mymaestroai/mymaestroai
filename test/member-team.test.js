'use strict';
// Members and the team (owner's rule: a member's assistant uses temporary workers and gets the team guidance; no
// permanent starter team per member). A member's agent gets the light text; its temporary workers may run only on its own
// model and the models an admin lets members choose (the same rule as moving their own agents, lib/member-models); the
// member caps (never Ultra, Standard speed) reach those workers through the parent agent. Admin agents are unchanged.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SDK = fs.readFileSync(path.join(ROOT, 'lib', 'sdk-chat.js'), 'utf8');
const grab = (head) => {
  const i = SDK.indexOf(head);
  assert.ok(i >= 0, head);
  let depth = 0, j = SDK.indexOf(') {', i) + 2;   // the body's brace, not one in a default parameter (opts = {})
  for (let k = j; k < SDK.length; k++) { if (SDK[k] === '{') depth++; else if (SDK[k] === '}') { depth--; if (depth === 0) return SDK.slice(i, k + 1); } }
  throw new Error('unbalanced ' + head);
};
const tg = require('../lib/team-guidance');
const mm = require('../lib/member-models');

test('a member-owned agent gets the light team text; an agent switched off still gets none', () => {
  assert.strictEqual(tg.textFor({ agent: { model: 'claude-sdk/claude-sonnet-5-5' }, isLead: false, level: 'full', member: true }), tg.LIGHT_TEXT + tg.MEMBER_LINE);
  assert.match(tg.MEMBER_LINE, /only the models your spawn_workers description lists/);
  assert.strictEqual(tg.textFor({ agent: { model: 'claude-sdk/claude-sonnet-5-5' }, isLead: false, level: 'full' }), tg.CORE_TEXT);
  assert.strictEqual(tg.textFor({ agent: { teamGuidance: 'off' }, member: true, level: 'full' }), '');
  assert.strictEqual(tg.textFor({ agent: {}, member: true, level: 'off' }), '');
  // the prompt builder passes it, judged on the agent's owner against the admins
  assert.match(SDK, /const member = !!\(rec && rec\.owner && !adminIdSet\(\)\.has\(String\(rec\.owner\)\)\);\n\s+return require\('\.\/team-guidance'\)\.textFor\(\{ agent: rec, isLead: isLeadAgent\(agentName, agents\), member \}\);/);
});

test('member-models: one list for a member\'s own model choice and their temporary workers', () => {
  const s = (v) => () => v;
  assert.deepStrictEqual(mm.list(s(['a/x', 'b/y', 3])), ['a/x', 'b/y']);
  assert.deepStrictEqual(mm.list(s(undefined)), []);
  assert.strictEqual(mm.memberMayUse('a/x', s(['a/x'])), true);
  assert.strictEqual(mm.memberMayUse('c/z', s(['a/x'])), false);
  assert.strictEqual(mm.memberMayUse('a/x', s(null)), false, 'unset: a member may choose none');
  assert.deepStrictEqual(mm.workerModels('own/m', s(['a/x', 'own/m'])), ['own/m', 'a/x']);
  assert.deepStrictEqual(mm.workerModels('own/m', s(null)), ['own/m'], 'unset: only the agent\'s own model');
  // the route that moves a member's agent uses the same module
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /const mm = require\('\.\/lib\/member-models'\);[\s\S]{0,120}if \(!mm\.memberMayUse\(body\.model\)\)/);
});

function sandbox({ agents, memberModels, admins = ['admin1'], virtual = {}, selfCheck = [] }) {
  const tw = require('../lib/temporal-workers');
  const ctx = {
    require: (p) => {
      if (p === './agents') return { getAgentsSync: () => { if (agents instanceof Error) throw agents; return agents; } };
      // The behaviour-change gate (lib/behaviour-changes) is open here: these tests check the limit itself; the gate has its own tests (behaviour-changes.test.js).
      if (p === './behaviour-changes') return { isOn: (id) => id === 'member-worker-models' };
      if (p === './member-models') return { workerModels: (own) => mm.workerModels(own, () => memberModels) };
      throw new Error('unexpected require ' + p);
    },
    resolveVirtualAgent: (n) => virtual[n] || null,
    adminIdSet: () => new Set(admins),
    temporalWorkers: { ...tw, isSelfCheck: (n) => selfCheck.includes(n) },
    _twCatalog: { text: 'ALL MODELS', available: ['claude-sdk/claude-opus-5-5', 'claude-sdk/claude-haiku-5-5', 'openai/gpt-6'], sdkInfo: [] },
    workerCatalogText: () => 'ALL MODELS',
  };
  vm.createContext(ctx);
  vm.runInContext(grab('function memberWorkerModels(') + '\n' + grab('function workerCatalogTextFor(') + '\nthis.mwm = memberWorkerModels; this.cat = workerCatalogTextFor;', ctx);
  return ctx;
}
const AGENTS = [
  { name: 'boss', model: 'claude-sdk/claude-opus-5-5', owner: 'admin1' },
  { name: 'infra', model: 'claude-sdk/claude-opus-5-5' },
  { name: 'sams_helper', model: 'claude-sdk/claude-haiku-5-5', owner: 'sam1' },
];

test('a member\'s agent (and its temporary workers) may use its own model plus memberModels; admin agents are unchanged', () => {
  const c = sandbox({ agents: AGENTS, memberModels: ['openai/gpt-6'], virtual: { 'tw-1': { parent: 'sams_helper' } } });
  assert.deepStrictEqual([...c.mwm('sams_helper')], ['claude-sdk/claude-haiku-5-5', 'openai/gpt-6']);
  assert.deepStrictEqual([...c.mwm('tw-1')], ['claude-sdk/claude-haiku-5-5', 'openai/gpt-6'], 'a temporary worker counts as its parent');
  assert.strictEqual(c.mwm('boss'), null, 'an admin\'s agent');
  assert.strictEqual(c.mwm('infra'), null, 'an infrastructure agent');
  assert.deepStrictEqual([...sandbox({ agents: AGENTS, memberModels: undefined }).mwm('sams_helper')], ['claude-sdk/claude-haiku-5-5'], 'memberModels unset: only its own model');
});

test('the spawn_workers catalogue a member\'s agent sees lists only those models; an admin\'s agent sees all', () => {
  const c = sandbox({ agents: AGENTS, memberModels: ['openai/gpt-6'] });
  const member = c.cat('sams_helper');
  assert.match(member, /Models your temporary workers may use \(an admin chooses them\): claude-sdk\/claude-haiku-5-5, openai\/gpt-6\./);
  assert.ok(!member.includes('claude-opus-5-5'), 'a model members may not use is not listed');
  assert.strictEqual(c.cat('boss'), 'ALL MODELS');
  // both tool descriptions go through it
  assert.match(SDK, /description: temporalWorkers\.toolDescription\(workerCatalogTextFor\(agentName\)\)/);
  assert.match(SDK, /temporalWorkers\.toolDescription\(workerCatalogTextFor\(agentName, await refreshWorkerCatalog\(\)\)\)/);
});

test('spawn_workers refuses a member\'s worker on another model before anything starts, naming what is allowed', () => {
  const body = grab('async function runSpawnWorkers(');
  const at = (s) => body.indexOf(s);
  assert.ok(at('const memberAllowed = memberWorkerModels(callerName);') > at('temporalWorkers.normalizeJobs('), 'judged on the final models (an omitted model is the caller\'s own)');
  assert.ok(at('const memberAllowed = memberWorkerModels(callerName);') < at('temporalWorkers.runWorkers('), 'before any worker starts');
  assert.match(body, /\? `\[spawn_workers\] Nothing was started: a member's agent may start workers only on \$\{memberAllowed\.join\(', '\)\} \(an admin chooses these\)\. Not allowed: \$\{refused\.join\(', '\)\}\.`\n/);
});

test('the member caps reach a member\'s temporary workers: the worker\'s turn names its parent as consulted_by', () => {
  // consultViaHubNow sends consulted_by = the coordinator (the parent agent for spawn_workers) ...
  assert.match(grab('function consultViaHubNow('), /consulted_by: coordinatorName \|\| undefined/);
  assert.match(grab('async function runSpawnWorkers('), /return consultViaHub\(v\.id, [^,]+, v\.id, sseRes, callerName, \{/);
  // ... and the turn's member origin (never Ultra, Standard speed) is judged on those names
  assert.match(SDK, /const memberOrigin = originFromMemberAgent\(\[turnOrigin && turnOrigin\.from, turnOrigin && turnOrigin\.by, turnOrigin && turnOrigin\.agent, consulted_by,/);
  assert.match(SDK, /const turnTier = \(memberTurn \|\| memberOrigin\) \? 'standard' : await agentTier\(agent\);/);
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(grab('function originFromMemberAgent(') + '\nthis.f = originFromMemberAgent;', ctx);
  const users = { sam1: { role: 'member' }, admin1: { role: 'admin' } };
  assert.strictEqual(ctx.f([undefined, undefined, undefined, 'sams_helper', null], AGENTS, (id) => users[id]), true, 'a member\'s worker');
  assert.strictEqual(ctx.f([undefined, undefined, undefined, 'boss', null], AGENTS, (id) => users[id]), false, 'an admin\'s worker');
});

// Review r1 (GPT-6 BLOCK; Sonnet follow-ups): the check fails closed; an empty list has its own text; a member's catalogue
// never says that any other id is accepted.
test('r1: a record that cannot be found or read allows nothing; only a hub-internal check agent is unlimited', () => {
  assert.deepStrictEqual([...sandbox({ agents: AGENTS, memberModels: ['openai/gpt-6'] }).mwm('nobody')], [], 'no record');
  assert.deepStrictEqual([...sandbox({ agents: new Error('EIO'), memberModels: ['openai/gpt-6'] }).mwm('sams_helper')], [], 'the list could not be read');
  assert.deepStrictEqual([...sandbox({ agents: AGENTS, memberModels: [], virtual: { 'tw-x': { parent: 'gone' } } }).mwm('tw-x')], [], 'a worker whose parent is gone');
  assert.strictEqual(sandbox({ agents: AGENTS, memberModels: [], virtual: { 'chk-1': {} }, selfCheck: ['chk-1'] }).mwm('chk-1'), null, 'a self-check agent');
  const none = sandbox({ agents: new Error('EIO'), memberModels: [] }).cat('sams_helper');
  assert.match(none, /No model is open to your temporary workers right now/);
  const member = sandbox({ agents: AGENTS, memberModels: ['openai/gpt-6'] }).cat('sams_helper');
  assert.match(member, /No other model is accepted\./);
  assert.ok(!/any exact id/.test(member));
  const body = grab('async function runSpawnWorkers(');
  assert.match(body, /: `\[spawn_workers\] Nothing was started: no model is open to this agent's temporary workers right now\. Do the work yourself\.`;/);
});
