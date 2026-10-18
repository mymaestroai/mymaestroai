'use strict';
// lib/root-grants: the operator's time-limited root grant for one agent, and how the gate honours it.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRootGrants } = require('../lib/root-grants');
const tp = require('../lib/tool-policy');
const { createGate } = require('../lib/policy-gate');
const { createApprovals } = require('../lib/approvals');

function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-grants-'));
  let t = Date.parse('2026-10-17T12:00:00Z');
  const rg = createRootGrants({ file: path.join(dir, 'root-grants.json'), auditFile: path.join(dir, 'root-commands.jsonl'), now: () => t, log: () => {} });
  return { rg, dir, tick: (ms) => { t += ms; }, audit: () => fs.readFileSync(path.join(dir, 'root-commands.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) };
}

test('grant, active, expiry, revoke; one grant per agent; persisted owner-only; audited', () => {
  const { rg, dir, tick, audit } = rig();
  assert.strictEqual(rg.active('auditor'), null);
  const g = rg.grant('auditor', { minutes: 15, by: 'u_owner', note: 'sshd review' });
  assert.match(g.id, /^[0-9a-f]{12}$/);
  assert.strictEqual(g.until, '2026-10-17T12:15:00.000Z');
  assert.strictEqual(rg.active('auditor').id, g.id);
  assert.strictEqual(rg.active('worker'), null);
  // a second grant replaces the first
  const g2 = rg.grant('auditor', { minutes: 60, by: 'u_owner' });
  assert.strictEqual(rg.list().length, 1);
  assert.strictEqual(rg.active('auditor').id, g2.id);
  // expiry
  tick(61 * 60 * 1000);
  assert.strictEqual(rg.active('auditor'), null);
  assert.strictEqual(rg.list().length, 0);
  // revoke
  rg.grant('worker', { by: 'u_owner' });
  assert.strictEqual(rg.revoke('worker', { by: 'u_owner' }), true);
  assert.strictEqual(rg.revoke('worker'), false);
  assert.strictEqual(rg.active('worker'), null);
  // persisted and reloaded
  rg.grant('haiku', { minutes: 5 });
  const again = createRootGrants({ file: path.join(dir, 'root-grants.json'), auditFile: path.join(dir, 'root-commands.jsonl'), now: () => Date.parse('2026-10-17T13:02:00Z'), log: () => {} });
  assert.strictEqual(again.active('haiku').agent, 'haiku');
  assert.strictEqual((fs.statSync(path.join(dir, 'root-grants.json')).mode & 0o077), 0, 'owner-only on disk');
  const kinds = audit().map(e => e.kind);
  assert.deepStrictEqual(kinds, ['grant', 'grant', 'grant', 'revoke', 'grant']);
  // validation
  assert.throws(() => rg.grant('', {}), /agent name/);
  assert.throws(() => rg.grant('x', { minutes: 0 }), /minutes/);
  assert.throws(() => rg.grant('x', { minutes: 100000 }), /minutes/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('decide: a granted head or worker gets the admin rule (ask) for root instead of a refusal; a member never; the lead unchanged', () => {
  const head = { name: 'auditor', category: 'primary' }, worker = { name: 'reviewer', category: 'worker' }, lead = { name: 'maestro', category: 'primary', lead: true };
  const member = { name: 'sam_doc', category: 'primary', owner: 'u_sam' };
  const cwd = (a) => path.join(tp.HUB_ROOT, 'workspaces', a.name);
  const d = (agent, extra = {}) => tp.decide({ agent, tool: 'Bash', input: { command: 'sudo -n sshd -T' }, cwd: cwd(agent), ...extra });
  assert.strictEqual(d(head).decision, 'deny');
  assert.match(d(head).reason, /operator can grant it/);
  assert.strictEqual(d(head, { rootGranted: true }).decision, 'ask');
  assert.match(d(head, { rootGranted: true }).reason, /root granted by the operator/);
  assert.strictEqual(d(worker, { rootGranted: true }).decision, 'ask', 'a worker with a grant is asked, not refused by its admin rule');
  assert.strictEqual(d(member, { rootGranted: true, isMemberOwned: () => true }).decision, 'deny');
  assert.strictEqual(d(lead).decision, 'ask');
  // an earlier "approve for 1 hour" on the card covers later root commands of a granted agent
  const al = tp.createAllowances();
  al.add(`auditor|admin`);
  assert.strictEqual(d(head, { rootGranted: true, allowances: al }).decision, 'allow');
});

test('gate: with a grant the root command runs (card only when sudo is listed) and the audit names the grant; after revoke it is refused again', async () => {
  const { rg, dir } = rig();
  const al = tp.createAllowances();
  const ap = createApprovals({ log: () => {}, allowances: al, timeoutMs: 60000 });
  const audit = [];
  const g = createGate({ getAgent: async () => ({ name: 'auditor', category: 'primary' }), approvals: ap, allowances: al, log: () => {}, approvalsOn: () => false, approvalClasses: () => new Set(), auditRoot: (e) => audit.push(e), rootGranted: (name) => rg.active(name) });
  const before = await g.check({ agentName: 'auditor', tool: 'Bash', input: { command: 'sudo -n sshd -T' } });
  assert.strictEqual(before.allowed, false);
  assert.strictEqual(audit[0].outcome, 'denied');
  const grant = rg.grant('auditor', { minutes: 30, by: 'u_owner', note: 'ssh review' });
  const during = await g.check({ agentName: 'auditor', tool: 'Bash', input: { command: 'sudo -n sshd -T' } });
  assert.strictEqual(during.allowed, true);
  assert.strictEqual(during.grantId, grant.id);
  assert.strictEqual(audit[1].outcome, 'allowed');
  assert.strictEqual(audit[1].grantId, grant.id);
  assert.strictEqual(ap.list().length, 0, 'no card: sudo is not in approvalClasses');
  // with 'sudo' listed, the granted agent gets a card
  const gc = createGate({ getAgent: async () => ({ name: 'auditor', category: 'primary' }), approvals: ap, allowances: al, log: () => {}, approvalsOn: () => false, approvalClasses: () => new Set(['sudo']), auditRoot: () => {}, rootGranted: (name) => rg.active(name) });
  const p = gc.check({ agentName: 'auditor', tool: 'Bash', input: { command: 'sudo -n ufw status' } });
  await new Promise(r => setImmediate(r));
  assert.strictEqual(ap.list().length, 1);
  ap.resolve(ap.list()[0].id, 'allow');
  assert.strictEqual((await p).allowed, true);
  rg.revoke('auditor', { by: 'u_owner' });
  const after = await g.check({ agentName: 'auditor', tool: 'Bash', input: { command: 'sudo -n sshd -T' } });
  assert.strictEqual(after.allowed, false);
  assert.match(after.text, /reserved for the lead agent/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('wiring: sdk-chat passes the grant lookup to the gate; server routes are admin-only and refuse the service identity; pages carry the controls', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const sdk = read('lib/sdk-chat.js'), server = read('server.js'), page = read('agent-settings.html'), app = read('app.js');
  assert.ok(sdk.includes("rootGranted: (name) => { try { return require('./root-grants').getRootGrants().active(name); } catch { return null; } },"));
  assert.ok(server.includes("if (pathname === '/api/root-grants' || /^\\/api\\/root-grants\\/[^/]+$/.test(pathname)) {"));
  assert.ok(server.includes("if (req.hubService) return jsonResponse(res, 403, { error: 'admin_only', detail: 'root grants are given by a signed-in admin, never by the hub itself' });"));
  assert.ok(server.includes("if (!access.isAdmin(req.hubUser) || req.hubPendingTotp) return jsonResponse(res, 403, { error: 'admin_only' });"));
  assert.ok(server.includes("hubAuth.audit(req.hubUser.id, 'root.grant'") && server.includes("hubAuth.audit(req.hubUser.id, 'root.revoke'"));
  assert.ok(server.includes("if (d.sandboxed) return jsonResponse(res, 400,") && server.includes("if (d.memberOwned) return jsonResponse(res, 400,") && server.includes("if (d.lead) return jsonResponse(res, 400,"));
  assert.ok(page.includes('id="root-grant-box"') && page.includes('async function grantRoot()') && page.includes('async function revokeRoot()') && page.includes('loadRootGrant();'));
  assert.ok(app.includes('id="st-root-grants"') && app.includes('async function loadRootGrants()') && app.includes('async function revokeRootGrant('));
});
