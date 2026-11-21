'use strict';
// "Need a worker?" (behaviour change 'ask-lead-for-workers'): askLeadTextFor in lib/sdk-chat.js, run in a small sandbox with fake agents,
// next to teamGuidanceTextFor (the two are independent) and appended at the same three prompt sites.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SDK = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
const grab = (head) => {
  const i = SDK.indexOf(head);
  assert.ok(i >= 0, head);
  let depth = 0;
  for (let k = SDK.indexOf(') {', i) + 2; k < SDK.length; k++) { if (SDK[k] === '{') depth++; else if (SDK[k] === '}') { depth--; if (depth === 0) return SDK.slice(i, k + 1); } }
  throw new Error('unbalanced ' + head);
};

const AGENTS = [
  { name: 'maestro', category: 'primary', lead: true },
  { name: 'ana_main', category: 'primary', owner: 'u-admin' },
  { name: 'ana_helper', category: 'worker', owner: 'u-admin' },
  { name: 'unowned_main', category: 'primary' },
  { name: 'unowned_specialist', category: 'specialist' },
  { name: 'kim_main', category: 'primary', owner: 'u-kim' },
  { name: 'kim_second_main', category: 'primary', owner: 'u-kim' },
  { name: 'kim_helper', category: 'specialist', owner: 'u-kim' },
  { name: 'lee_helper', category: 'worker', owner: 'u-lee' },        // a member with no primary agent
  { name: 'kim_lead', category: 'primary', owner: 'u-kim', lead: true },   // flagged a lead, but a member's
];
function sandbox({ on = { 'ask-lead-for-workers': true }, virtual = [], agents = AGENTS, teamText = 'TEAM TEXT' } = {}) {
  const ctx = {
    require: (p) => {
      if (p === './behaviour-changes') return { isOn: (id) => !!on[id] };
      if (p === './team-guidance') return { textFor: () => teamText };
      throw new Error('unexpected ' + p);
    },
    temporalWorkers: { isVirtual: (n) => virtual.includes(n) },
    getAgents: async () => agents,
    adminIdSet: () => new Set(['u-admin']),
    isLeadAgent: (n) => agents.some((a) => a.name === n && a.lead === true),
    leadAgentNames: () => agents.filter((a) => a.lead === true).map((a) => a.name),
  };
  vm.createContext(ctx);
  vm.runInContext(`${grab('async function teamGuidanceTextFor(')}\n${grab('async function askLeadTextFor(')}\nthis.ask = askLeadTextFor; this.guidance = teamGuidanceTextFor;`, ctx);
  return ctx;
}
const SPEC = 'with the job, a proposed name and the model tier you think it needs';

test('an admin-side primary agent is told to consult the lead by name', async () => {
  const s = sandbox();
  for (const n of ['ana_main', 'unowned_main']) {
    assert.strictEqual(await s.ask(n), `\n\n## NEED A WORKER?\nWhen you need a worker or a specialist you don't have, consult maestro ${SPEC}. maestro decides with the person you work for.`, n);
  }
});

test("a member's primary agent is told to use request_agent, and never hears of the admin's agents", async () => {
  const s = sandbox();
  const t = await s.ask('kim_main');
  assert.strictEqual(t, `\n\n## NEED A WORKER?\nWhen you need a worker or a specialist you don't have, use request_agent ${SPEC}; an admin decides.`);
  assert.doesNotMatch(t, /maestro|ana_main|consult/);
});

test("a member's other agents ask that member's first primary agent; none: the request_agent line", async () => {
  const s = sandbox();
  const t = await s.ask('kim_helper');
  assert.strictEqual(t, `\n\n## NEED A WORKER?\nWhen you need a worker or a specialist you don't have, ask kim_main (consult_agent) ${SPEC}; it asks for the agent through its own request.`);
  assert.doesNotMatch(t, /maestro|ana_/);
  assert.strictEqual(await s.ask('lee_helper'), `\n\n## NEED A WORKER?\nWhen you need a worker or a specialist you don't have, use request_agent ${SPEC}; an admin decides.`);
});

test('nothing for a lead (a member\'s flagged lead too), a temporary worker, an admin-side non-primary agent, or an unknown agent', async () => {
  const s = sandbox({ virtual: ['tw-maestro-1-ab12'] });
  for (const n of ['maestro', 'kim_lead', 'tw-maestro-1-ab12', 'ana_helper', 'unowned_specialist', 'nobody']) assert.strictEqual(await s.ask(n), '', n);
});

test('gated off (pending, off or missing) it is empty for everyone', async () => {
  for (const on of [{}, { 'ask-lead-for-workers': false }, { 'team-guidance': true }]) {
    const s = sandbox({ on });
    for (const a of AGENTS) assert.strictEqual(await s.ask(a.name), '', `${a.name} ${JSON.stringify(on)}`);
  }
});

test('no admin-side lead: an admin-side primary agent gets nothing (never a made-up name)', async () => {
  const s = sandbox({ agents: AGENTS.filter((a) => a.name !== 'maestro') });
  assert.strictEqual(await s.ask('ana_main'), '');
  assert.strictEqual(await s.ask('kim_main') === '' ? 'x' : 'ok', 'ok', "a member's line does not need a lead");
});

test('independent of the team guidance: either one on without the other', async () => {
  const guidanceOnly = sandbox({ on: { 'team-guidance': true } });
  assert.strictEqual(await guidanceOnly.guidance('ana_main'), 'TEAM TEXT');
  assert.strictEqual(await guidanceOnly.ask('ana_main'), '');
  const askOnly = sandbox({ on: { 'ask-lead-for-workers': true } });
  assert.strictEqual(await askOnly.guidance('ana_main'), '', 'team guidance off');
  assert.match(await askOnly.ask('ana_main'), /NEED A WORKER\?/, 'the line survives');
  // a guidance that throws (or is empty for this agent) does not take the line with it
  const broken = sandbox({ on: { 'team-guidance': true, 'ask-lead-for-workers': true }, teamText: '' });
  assert.strictEqual(await broken.guidance('ana_main'), '');
  assert.match(await broken.ask('ana_main'), /consult maestro/);
});

test('the line is appended at the gateway, SDK and Codex sites, after the team guidance', () => {
  assert.strictEqual((SDK.match(/\(await teamGuidanceTextFor\(agentName\)\) \+ \(await askLeadTextFor\(agentName\)\)/g) || []).length, 3);
  assert.strictEqual((SDK.match(/await askLeadTextFor\(agentName\)/g) || []).length, 3);
  assert.match(grab('async function askLeadTextFor('), /^async function askLeadTextFor\(agentName\) \{\n\s+try \{\n\s+if \(!require\('\.\/behaviour-changes'\)\.isOn\('ask-lead-for-workers'\)\) return '';\n\s+if \(temporalWorkers\.isVirtual\(agentName\)\) return '';/);
});
