'use strict';
// Member grants (lib/tool-policy): admins open up web, reads/writes outside, and sending for member-owned agents in
// three layers (hub default, per member, per agent); changing the hub, destroying and money stay denied for members
// whatever is set. Members may not edit their own agents' permissions. Consultation can be widened per member.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const P = require('../lib/tool-policy');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const member = (over = {}) => ({ name: 'kidbot', owner: 'm1', ...over });
const isMemberOwned = (a) => a.owner === 'm1';

test('a member agent with no grants: everything decided is denied', () => {
  const pol = P.policyFor(member(), { isMemberOwned, memberDefaults: () => ({}), ownerGrants: () => ({}) });
  assert.strictEqual(pol.role, 'member');
  for (const k of ['web', 'read_outside', 'write_outside', 'send', 'admin', 'destroy', 'money']) assert.strictEqual(pol.rules[k], 'deny', k);
});

test('three layers, each overriding the one before, with the source of every rule', () => {
  const pol = P.policyFor(member({ policy: { overrides: { send: 'ask' } } }), {
    isMemberOwned,
    memberDefaults: () => ({ web: 'ask', read_outside: 'allow' }),
    ownerGrants: () => ({ policy: { web: 'allow', write_outside: 'ask' } }),
  });
  assert.deepStrictEqual([pol.rules.web, pol.source.web], ['allow', 'member'], 'member grant beats hub default');
  assert.deepStrictEqual([pol.rules.read_outside, pol.source.read_outside], ['allow', 'hub']);
  assert.deepStrictEqual([pol.rules.write_outside, pol.source.write_outside], ['ask', 'member']);
  assert.deepStrictEqual([pol.rules.send, pol.source.send], ['ask', 'agent'], 'agent override beats both');
});

test('hub change, destruction and money are never grantable to member agents, at any layer', () => {
  const pol = P.policyFor(member({ policy: { overrides: { admin: 'allow', destroy: 'allow', money: 'allow' } } }), {
    isMemberOwned,
    memberDefaults: () => ({ admin: 'allow', destroy: 'allow' }),
    ownerGrants: () => ({ policy: { money: 'allow', admin: 'ask' } }),
  });
  for (const k of ['admin', 'destroy', 'money']) assert.strictEqual(pol.rules[k], 'deny', k);
  const bad = P.policyFor(member(), { isMemberOwned, memberDefaults: () => ({ web: 'sure' }), ownerGrants: () => ({}) });
  assert.strictEqual(bad.rules.web, 'deny', 'invalid decisions are ignored');
});

test('admin-side agents ignore member defaults and keep their own overrides', () => {
  const pol = P.policyFor({ name: 'fable', category: 'specialist', policy: { overrides: { send: 'ask' } } }, { isMemberOwned, memberDefaults: () => ({ web: 'deny' }), ownerGrants: () => ({}) });
  assert.strictEqual(pol.role, 'worker');
  assert.strictEqual(pol.rules.web, 'allow');
  assert.deepStrictEqual([pol.rules.send, pol.source.send], ['ask', 'agent']);
});

test('decide() applies a member grant: web allowed, then denied again when the grant goes', () => {
  const providers = { memberDefaults: () => ({}), ownerGrants: () => ({ policy: { web: 'allow' } }) };
  P.setMemberProviders(providers);
  try {
    let d = P.decide({ agent: member(), tool: 'WebSearch', input: { query: 'ACR 2013 criteria' }, isMemberOwned });
    assert.deepStrictEqual([d.cls, d.decision], ['web', 'allow']);
    providers.ownerGrants = () => ({});
    d = P.decide({ agent: member(), tool: 'WebFetch', input: { url: 'https://example.org/' }, isMemberOwned });
    assert.deepStrictEqual([d.cls, d.decision], ['web', 'deny']);
  } finally { P.setMemberProviders(null); }
});

test('sanitizeGrants keeps grantable classes, valid decisions and clean agent names only', () => {
  assert.deepStrictEqual(P.sanitizeGrants({ policy: { web: 'allow', admin: 'allow', send: 'maybe', read_outside: 'ask' }, consult: [' Maestro ', 'maestro', 'bad name!', 7, 'gp'], other: 1 }),
    { policy: { web: 'allow', read_outside: 'ask' }, consult: ['maestro', 'gp'] });
  assert.deepStrictEqual(P.sanitizeGrants(null), {});
  assert.deepStrictEqual(P.MEMBER_GRANTABLE, ['web', 'read_outside', 'write_outside', 'send']);
});

test('consultGrantsFor reads the owner grant; admin-side or unowned agents have none', () => {
  assert.deepStrictEqual(P.consultGrantsFor(member(), { ownerGrants: () => ({ consult: ['Maestro'] }) }), ['maestro']);
  assert.deepStrictEqual(P.consultGrantsFor({ name: 'x' }, { ownerGrants: () => ({ consult: ['maestro'] }) }), []);
});

test('wiring: member edits limited, grants sanitised and audited, consult widened, three admin surfaces', () => {
  const server = read('server.js');
  assert.match(server, /const MEMBER_EDITABLE = new Set\(\['blurb', 'maxContextMessages', 'maxOutputTokens', 'contextBudget', 'compaction', 'minimalContext'\]\);/);
  assert.match(server, /if \(refused\.length\) return jsonResponse\(res, 403, \{ error: `only an admin can change: \$\{refused\.join\(', '\)\}` \}\);/);
  assert.match(server, /if \(b\.grants !== undefined\) b\.grants = require\('\.\/lib\/tool-policy'\)\.sanitizeGrants\(b\.grants\);/);
  assert.match(server, /patch\.memberPolicy = require\('\.\/lib\/tool-policy'\)\.sanitizeGrants\(\{ policy: patch\.memberPolicy \}\)\.policy \|\| \{\};/);
  assert.match(read('lib/auth.js'), /audit\(by \|\| id, 'user\.grants'/);
  const sdk = read('lib/sdk-chat.js');
  assert.match(sdk, /return \(await consultGrantsOf\(coordinatorName\)\)\.includes\(String\(target\)\.toLowerCase\(\)\);/);
  assert.match(sdk, /return peers\.concat\(agents\.filter\(a => extra\.has\(a\.name\) && !have\.has\(a\.name\)\)\);/);
  const users = read('users.html');
  assert.match(users, /data-act="grants"/);
  assert.match(users, /body: \{ grants: \{ policy, consult \} \}/);
  assert.match(users, /Everyone with the <b>admin<\/b> role manages this hub with you/);
  const app = read('app.js');
  assert.match(app, /<div class="st-section" id="st-mp-section"><h4>Member agents: permissions<\/h4>/);
  assert.match(app, /body: JSON\.stringify\(\{ memberPolicy \}\)/);
  const page = read('agent-settings.html');
  assert.match(page, /const MEMBER_GRANTABLE = \['web', 'read_outside', 'write_outside', 'send'\];/);
  assert.match(page, /member: \{ web: 'deny', read_outside: 'deny', write_outside: 'deny', send: 'deny', admin: 'deny', destroy: 'deny', money: 'deny' \},/);
  assert.match(page, /never for member agents/);
});
