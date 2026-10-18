'use strict';
// Multi-user wiring: the access gate in server.js, account and user routes, owner-filtered listings,
// per-user event streams, service token on internal calls, owner scoping in sdk-chat, team templates.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const teams = require('../lib/teams');
const { createHubEvents } = require('../lib/hub-events');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const server = read('server.js');
const sdk = read('lib/sdk-chat.js');

test('server: one access gate before the routes; signed-out pages go to /login, APIs get 401/403', () => {
  assert.ok(server.includes("const route = access.classifyRoute(pathname, req.method);"));
  assert.ok(server.includes("const ident = hubAuth.identify(req, { legacyCheck: (r) => !!AUTH_USERNAME && !hubAuth.hasUsers() && checkAuth(r) });"), 'legacy pair only while no accounts exist');
  assert.ok(server.includes("Location: `/login?next=${encodeURIComponent(req.url || '/')}`"));
  assert.ok(server.includes("return jsonResponse(res, 401, { error: req.hubPendingTotp ? 'totp_required' : 'unauthorized' });"));
  assert.ok(server.includes("return jsonResponse(res, 403, { error: 'admin_only' });"));
  assert.ok(server.includes("return jsonResponse(res, 403, { error: 'no_access_to_agent' });"));
  assert.ok(!server.includes("const noAuthPaths = ['/health', '/v1/models'];"), 'old basic-auth-only block removed');
  // body is read once and cached so the gate and the handler both see it
  assert.ok(server.includes("if (req._bodyText !== undefined) return Promise.resolve(req._bodyText);"));
});

test('server: account, user-management, me, filtered agents/status/events, login page', () => {
  for (const r of ["'/api/auth/status'", "'/api/auth/setup'", "'/api/auth/login'", "'/api/auth/totp/verify'", "'/api/auth/logout'", "'/api/auth/invite'", "'/api/auth/invite/accept'",
    "'/api/auth/totp/begin'", "'/api/auth/totp/confirm'", "'/api/auth/totp/disable'", "'/api/auth/password'", "'/api/auth/sessions'", "'/api/me'", "'/api/users'", "'/api/users/audit'"]) assert.ok(server.includes(r), r);
  assert.ok(server.includes("/^\\/api\\/users\\/([^/]+)\\/team$/.test(pathname)"));
  assert.ok(server.includes("access.visibleAgents(req.hubUser, all, { ownerFilter: access.isAdmin(req.hubUser) ? ownerFilter : null })"));
  assert.ok(server.includes("events.subscribe(req, res, { isAdmin, visibleAgent: visible, filter: (ev) => visible(ev.agent) })"));
  assert.ok(server.includes("createAgent(body.name, body.model, body.personality, body.skills, body.category, body.owner || null)"));
  assert.ok(server.includes("pathname === '/login' || pathname === '/invite' || pathname === '/setup-admin'"));
  assert.ok(server.includes("['index.html', 'mobile.html'].includes(path.basename(filePath))"));
});

test('internal loopback calls carry the service token on every path', () => {
  assert.ok(sdk.includes("[hubAuthMod.SERVICE_HEADER]: hubAuthMod.SERVICE_TOKEN"));
  for (const f of ['lib/scheduler.js', 'lib/task-queue.js']) assert.ok(read(f).includes("require('./auth').SERVICE_TOKEN"), f);
});

test('sdk-chat: list_agents, rosters, consults and shared memory are scoped by owner', () => {
  assert.ok(sdk.includes("async function peerAgents(agentName)"));
  assert.ok(sdk.includes("handler: async () => describeAgents(agentName),"));
  assert.ok(sdk.includes("async () => text(await describeAgents(agentName)),"));
  assert.strictEqual((sdk.match(/workerPolicy\.buildRoster\(await peerAgents\(/g) || []).length, 4);
  assert.strictEqual((sdk.match(/workerPolicy\.buildRoster\(await getAgents\(\)/g) || []).length, 0);
  assert.ok(sdk.includes("if (!opts.temporal && !(await consultAllowed(coordinatorName, agentName))) {"));
  assert.strictEqual((sdk.match(/await sharedPoolOf\(agentName\)/g) || []).length, 6, 'all six shared-memory handlers pass the pool');
  assert.ok(sdk.includes("isMemberOwned: (agent) => !!(agent && agent.owner && !adminIdSet().has(String(agent.owner)))"));
});

test('hub-events: a member client only gets its agents and no hub-wide events; snapshot is filtered', () => {
  const ev = createHubEvents();
  ev.setStatusProvider(() => ({ gp: { busy: true }, sam_doc: { busy: false } }));
  ev.setApprovalsProvider(() => [{ id: 'ap_1' }]);
  const mk = () => { const w = []; return { w, res: { writeHead() {}, write: (s) => w.push(s), on() {}, destroy() {}, writableLength: 0 } }; };
  const member = mk(); const admin = mk();
  ev.subscribe({ headers: {} }, member.res, { isAdmin: false, visibleAgent: (n) => n === 'sam_doc', filter: (e) => e.agent === 'sam_doc' });
  ev.subscribe({ headers: {} }, admin.res, { isAdmin: true, visibleAgent: () => true, filter: () => true });
  const snapM = JSON.parse(member.w.find(x => x.startsWith('event: status_snapshot')).split('\n')[1].slice(6));
  assert.deepStrictEqual(Object.keys(snapM.agents), ['sam_doc']);
  assert.deepStrictEqual(snapM.approvals, []);
  const snapA = JSON.parse(admin.w.find(x => x.startsWith('event: status_snapshot')).split('\n')[1].slice(6));
  assert.deepStrictEqual(Object.keys(snapA.agents).sort(), ['gp', 'sam_doc']);
  assert.strictEqual(snapA.approvals.length, 1);
  ev.publish('turn_start', { agent: 'gp', turnId: 't1' });
  ev.publish('turn_start', { agent: 'sam_doc', turnId: 't2' });
  ev.publish('approval_request', { id: 'ap_2' });
  const evLine = (x) => x.split('\n').find(l => l.startsWith('event: ')) || '';
  const names = (w) => w.map(evLine).filter(l => l === 'event: turn_start' || l === 'event: approval_request');
  assert.deepStrictEqual(names(member.w), ['event: turn_start']);
  assert.ok(member.w.some(x => x.includes('"agent":"sam_doc"')) && !member.w.some(x => x.includes('"agent":"gp"')));
  assert.deepStrictEqual(names(admin.w), ['event: turn_start', 'event: turn_start', 'event: approval_request']);
});

test('teams: rewrite swaps teammate names and folder paths; prefix derives from the login', () => {
  assert.strictEqual(teams.prefixFor({ login: 'sam@example.com' }), 'sam');
  assert.strictEqual(teams.prefixFor({ login: '42x@example.com' }), 'm42x');
  assert.strictEqual(teams.prefixFor({ login: 'sam@example.com' }, 'K-Team'), 'kteam');
  const out = teams.rewrite('Consult labs and pharm, never docs. Files live in ~/agent-hub/medical/patients/.', { nameMap: { labs: 'sam_labs', pharm: 'sam_pharm', doc: 'sam_doc' }, oldFolder: 'medical', newFolder: '/x/users/u1/medical' });
  assert.strictEqual(out, 'Consult sam_labs and sam_pharm, never docs. Files live in /x/users/u1/medical/patients/.');
  assert.deepStrictEqual(teams.templates.length, 0, 'templates come from settings, never code');
  teams.useTemplates({ medical: { folder: 'medical', members: ['a', 'b'], head: 'a' } });
  assert.deepStrictEqual(Object.keys(teams.templates()), ['medical']);
  teams.useTemplates(null);
});

test('teams: a member-owned head introduces itself once; USER.md names the member', async () => {
  const user = { id: 'u_k', login: 'sam@example.com', name: 'Sam', role: 'member' };
  const posted = []; const appended = [];
  const text = await teams.greetAgent('sam_doc', user, { post: async (agent, msg) => { posted.push([agent, msg]); return 'Hi Sam, I am GP.'; }, append: (n, t) => appended.push([n, t]), hasHistory: () => false });
  assert.strictEqual(text, 'Hi Sam, I am GP.');
  assert.strictEqual(posted[0][0], 'sam_doc');
  assert.match(posted[0][1], /created for Sam/);
  assert.deepStrictEqual(appended, [['sam_doc', 'Hi Sam, I am GP.']]);
  const again = await teams.greetAgent('sam_doc', user, { post: async () => 'x', append: () => { throw new Error('must not append'); }, hasHistory: () => true });
  assert.strictEqual(again, null, 'no greeting when the chat already has history');
  const uf = teams.userFile(user, { team: 'medical', head: true });
  assert.match(uf, /Name:\*\* Sam/); assert.match(uf, /This team is theirs/); assert.match(uf, /## First run/);
  assert.ok(server.includes("require('./lib/teams').greetIfFresh(name, u)"), 'owner switch to a member greets');
});

test('server: 2026-10-16 review fixes are wired (static allow-list, hub-only body fields, member model guard, /v1 needs finished 2FA, token-scoped turn, request wrapper, walletOwner strip)', () => {
  assert.ok(server.includes("require('./lib/static-files').resolve(pathname)"));
  assert.ok(!server.includes("const safePath = path.normalize(pathname)"), 'the old normalize-and-join fallback is gone');
  assert.strictEqual((server.match(/stripHubOnlyChatFields\(JSON\.parse\(await readBody\(req\)\), req\)/g) || []).length, 2, 'both chat routes strip hub-only fields');
  assert.ok(server.includes("const HUB_ONLY_CHAT_FIELDS = ['image_files', 'consulted_by', 'origin'];"));
  assert.ok(server.includes("const allowed = require('./lib/settings').getSetting('memberModels');"));
  assert.ok(server.includes("!(access.isAdmin(req.hubUser) && !req.hubPendingTotp)"));
  assert.ok(server.includes("if (req.hubToken && req.hubToken.agents && !req.hubToken.agents.includes(agentName)) return jsonResponse(res, 403, { error: 'token_scope'"));
  assert.ok(server.includes("handleHttpRequest(req, res).catch((err) => {"));
  assert.ok(server.includes("'walletOwner' in patch"));
  assert.ok(sdk.includes("handlers.__cwd = hands.tools.cwd;"), 'gateway gate and hands share a working directory');
  assert.ok(sdk.includes("cwd: (handlers && handlers.__cwd) || process.cwd()"));
  assert.ok(sdk.includes("const v = temporalWorkers.getVirtual(agentName); if (v && v.parent) agent = all.find(a => a.name === v.parent) || null;"), 'temporary workers use their parent\'s hands');
});
