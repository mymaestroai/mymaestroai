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
