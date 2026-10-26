'use strict';
// lib/agents.js lead-agent helpers. Lead = agents flagged `lead: true` (one or several). Category
// is only grouping ('primary' = the agents the owner talks to). Fallbacks when nothing is flagged:
// the primary agents, else maestro.
const { test } = require('node:test');
const assert = require('node:assert');
const { leadAgentNames, isLeadAgent, defaultLeadAgent } = require('../lib/agents');

// This hub: one flagged lead, several primaries (team heads), specialists.
const HUB = [
  { name: 'maestro', category: 'primary', lead: true },
  { name: 'gp', category: 'primary' },
  { name: 'counsel', category: 'primary' },
  { name: 'labs', category: 'specialist' },
  { name: 'haiku', category: 'worker' },
];
const TWO_LEADS = [{ name: 'alpha', category: 'primary', lead: true }, { name: 'beta', category: 'specialist', lead: true }, { name: 'gamma', category: 'primary' }];
const UNFLAGGED = [{ name: 'agent-lead', category: 'primary' }, { name: 'forge', category: 'specialist' }];
const LEGACY = [{ name: 'cos', category: 'specialist' }, { name: 'maestro', category: 'specialist' }];

test('flagged agents are the leads; primaries without the flag are not', () => {
  assert.deepStrictEqual(leadAgentNames(HUB), ['maestro']);
  assert.strictEqual(isLeadAgent('maestro', HUB), true);
  for (const n of ['gp', 'counsel', 'labs', 'haiku']) assert.strictEqual(isLeadAgent(n, HUB), false, n);
  assert.strictEqual(isLeadAgent('', HUB), false);
});

test('several agents may be flagged, in any category', () => {
  assert.deepStrictEqual(leadAgentNames(TWO_LEADS), ['alpha', 'beta']);
  assert.strictEqual(isLeadAgent('beta', TWO_LEADS), true);
  assert.strictEqual(isLeadAgent('gamma', TWO_LEADS), false);
  assert.strictEqual(defaultLeadAgent(TWO_LEADS), 'alpha');
});

test('no flag anywhere: primaries are leads; no primaries: legacy maestro', () => {
  assert.deepStrictEqual(leadAgentNames(UNFLAGGED), ['agent-lead']);
  assert.strictEqual(isLeadAgent('agent-lead', UNFLAGGED), true);
  assert.strictEqual(isLeadAgent('maestro', UNFLAGGED), false);
  assert.deepStrictEqual(leadAgentNames(LEGACY), []);
  assert.strictEqual(isLeadAgent('maestro', LEGACY), true);
  assert.strictEqual(isLeadAgent('cos', LEGACY), false);
});

test('defaultLeadAgent prefers maestro when it is a lead', () => {
  assert.strictEqual(defaultLeadAgent(HUB), 'maestro');
  assert.strictEqual(defaultLeadAgent([{ name: 'maestro', category: 'worker' }, ...TWO_LEADS]), 'alpha');
  assert.strictEqual(defaultLeadAgent([{ name: 'maestro', lead: true }, ...TWO_LEADS]), 'maestro');
  assert.strictEqual(defaultLeadAgent(LEGACY), 'maestro');
});

test('the flag only counts when it is exactly true', () => {
  assert.deepStrictEqual(leadAgentNames([{ name: 'x', category: 'primary', lead: 'yes' }, { name: 'y', category: 'worker', lead: 1 }]), ['x']);
});

test('agents expose a one-line blurb and the settings PATCH accepts it (UI shows it as a tooltip)', () => {
  const fs = require('fs'); const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agents.js'), 'utf8');
  assert.match(src, /blurb: typeof a\.blurb === 'string'/);
  assert.match(src, /allowedFields = \[[^\]]*'blurb'/);
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(app, /id="agent-btn-\$\{safeName\}" title="\$\{tip\}"/);   // name and tip are escaped (2026-10-16 XSS review)
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8'), /a\.blurb \|\| shortModel/);
});

test('no flag: a member\'s own primary assistant is never a lead by default (review F31)', () => {
  const mixed = [{ name: 'sam_doc', category: 'primary', owner: 'u_member_who_is_not_an_admin' }, { name: 'agent-lead', category: 'primary' }, { name: 'forge', category: 'specialist' }];
  assert.deepStrictEqual(leadAgentNames(mixed), ['agent-lead']);
  assert.strictEqual(isLeadAgent('sam_doc', mixed), false);
  assert.strictEqual(isLeadAgent('agent-lead', mixed), true);
  // a flagged lead is a lead whoever owns it: the flag is the owner's explicit choice
  assert.deepStrictEqual(leadAgentNames([{ name: 'sam_doc', category: 'primary', owner: 'u_x', lead: true }]), ['sam_doc']);
});

test('shouldMarkMaestroLead: only when no agent is marked and maestro is the owner\'s', () => {
  const { shouldMarkMaestroLead } = require('../lib/agents');
  const admins = new Set(['u_admin']);
  assert.strictEqual(shouldMarkMaestroLead([{ name: 'maestro', category: 'primary' }, { name: 'doc', category: 'primary' }], admins), true, 'an install that marks no lead');
  assert.strictEqual(shouldMarkMaestroLead([{ name: 'maestro', category: 'primary', owner: 'u_admin' }], admins), true, 'an admin owns maestro');
  assert.strictEqual(shouldMarkMaestroLead(HUB, admins), false, 'maestro is already marked');
  assert.strictEqual(shouldMarkMaestroLead([{ name: 'maestro' }, { name: 'doc', lead: true }], admins), false, 'the owner marked another agent');
  assert.strictEqual(shouldMarkMaestroLead([{ name: 'maestro', owner: 'u_member' }], admins), false, "a member's own maestro");
  assert.strictEqual(shouldMarkMaestroLead(UNFLAGGED, admins), false, 'no maestro on this install');
  assert.strictEqual(shouldMarkMaestroLead(null, admins), false);
  assert.strictEqual(shouldMarkMaestroLead([{ name: 'maestro', lead: 'yes' }], admins), true, 'only an exact true counts as a mark');
});

test('new installs: the seed marks maestro as the lead, and server.js runs the one-time check at start', () => {
  const fs = require('fs'); const path = require('path');
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'agents.example.json'), 'utf8'));
  assert.strictEqual(seed.find(a => a.name === 'maestro').lead, true);
  assert.deepStrictEqual(leadAgentNames(seed), ['maestro']);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /require\('\.\/lib\/agents'\)\.ensureMaestroLead\(\)/);
});

test('shouldMarkMaestroLead never promotes a repurposed maestro, and respects an explicit lead: false', () => {
  const { shouldMarkMaestroLead } = require('../lib/agents');
  const admins = new Set();
  assert.strictEqual(shouldMarkMaestroLead([{ name: 'maestro', category: 'worker' }, { name: 'doc', category: 'primary' }], admins), false, 'a worker maestro next to primary agents was never a lead');
  assert.strictEqual(shouldMarkMaestroLead([{ name: 'maestro', category: 'specialist' }], admins), true, 'no primary agents: maestro is already the lead by its name');
  assert.strictEqual(shouldMarkMaestroLead([{ name: 'maestro', category: 'primary', lead: false }], admins), false, "the owner's explicit choice");
});

test('server.js runs the lead check inside the listen callback, so a second copy that cannot get the port never runs it', () => {
  const fs = require('fs'); const path = require('path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const listen = server.indexOf('server.listen(PORT, HOST, () => {');
  const call = server.indexOf("require('./lib/agents').ensureMaestroLead()");
  assert.ok(listen > 0 && call > listen, 'the check comes after the port is bound');
  assert.ok(!server.slice(0, listen).includes('ensureMaestroLead'), 'and nowhere before it');
});
