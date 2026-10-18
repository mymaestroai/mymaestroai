'use strict';
// Behavioural unit tests for lib/access.js: route classification and who may see / reach which agent.
const { test } = require('node:test');
const assert = require('node:assert');
const X = require('../lib/access');

const admin = { id: 'u_admin', role: 'admin', name: 'Admin' };
const admin2 = { id: 'u_admin2', role: 'admin', name: 'Second' };
const ann = { id: 'u_ann', role: 'member', name: 'Ann' };
const bob = { id: 'u_bob', role: 'member', name: 'Bob' };
const agents = [
  { name: 'maestro' },                                   // infrastructure (no owner)
  { name: 'worker', owner: null },
  { name: 'gp', owner: 'u_admin' },                     // personal: owned by an admin
  { name: 'ann_assistant', owner: 'u_ann' },
  { name: 'ann_doc', owner: 'u_ann' },
  { name: 'bob_assistant', owner: 'u_bob', sharedWith: ['u_ann'] },
  { name: 'shared_infra', sharedWith: [123] },            // ids are stringified
];
const adminIds = new Set(['u_admin', 'u_admin2']);
const names = (list) => list.map(a => a.name);

test('classifyRoute: public exact and prefix, trailing slashes, empty path', () => {
  for (const p of ['/', '/login', '/sw.js', '/api/auth/login', '/api/auth/invite/accept', '/health', '/icons/hub-192.png']) {
    assert.deepStrictEqual(X.classifyRoute(p), { kind: 'public' }, p);
  }
  assert.deepStrictEqual(X.classifyRoute('/login/'), { kind: 'public' }, 'trailing slash stripped');
  assert.deepStrictEqual(X.classifyRoute('/api/me///'), { kind: 'session' });
  assert.deepStrictEqual(X.classifyRoute(''), { kind: 'public' }, 'empty path is the root');
  assert.deepStrictEqual(X.classifyRoute(undefined), { kind: 'public' });
  assert.deepStrictEqual(X.classifyRoute('/iconsx'), { kind: 'session', page: true }, 'prefix needs the slash');
});

test('classifyRoute: session routes, admin routes and pages, everything else under /api is admin', () => {
  for (const p of ['/api/me', '/api/agents', '/api/agents/status', '/api/events', '/api/files', '/api/files/upload', '/api/auth/totp/begin', '/api/auth/sessions/revoke']) {
    assert.deepStrictEqual(X.classifyRoute(p), { kind: 'session' }, p);
  }
  for (const p of ['/users', '/users.html', '/agent-settings', '/agent-settings.html', '/tiger-team']) {
    assert.deepStrictEqual(X.classifyRoute(p), { kind: 'admin', page: true }, p);
  }
  // First-run setup: the Welcome page and its state are public (the first account needs the setup code); the old
  // setup pages only redirect there; the Welcome actions are admin routes.
  for (const p of ['/welcome', '/api/welcome/state', '/setup', '/setup-admin']) assert.deepStrictEqual(X.classifyRoute(p), { kind: 'public' }, p);
  for (const p of ['/api/welcome/api-key', '/api/welcome/claude-check', '/api/welcome/local']) assert.deepStrictEqual(X.classifyRoute(p, 'POST'), { kind: 'admin' }, p);
  assert.deepStrictEqual(X.classifyRoute('/comms-panel.css'), { kind: 'session', page: true }, 'unknown static asset: any signed-in user');
  for (const p of ['/api/agents/create', '/api/agents/clone', '/api/agents/rename', '/api/agents/reload']) {
    assert.deepStrictEqual(X.classifyRoute(p), { kind: 'admin' }, `${p} is a fixed admin action, not agent "create"`);
  }
  for (const p of ['/api/settings', '/api/users', '/api/agents/status/extra', '/api/memory/x', '/api/auth/invite/create', '/api/history']) {
    assert.deepStrictEqual(X.classifyRoute(p, 'POST'), { kind: 'admin' }, p);
  }
});

test('classifyRoute: agent-scoped routes name the agent in the body or the path', () => {
  for (const p of ['/api/chat', '/api/chat/stream', '/api/chat/interject', '/api/chat/stop', '/api/ask_response', '/api/cancel-worker']) {
    assert.deepStrictEqual(X.classifyRoute(p, 'POST'), { kind: 'agent', from: 'body' }, p);
  }
  const path = (p) => X.classifyRoute(p);
  assert.deepStrictEqual(path('/api/history/gp'), { kind: 'agent', from: 'path', agent: 'gp' });
  assert.deepStrictEqual(path('/api/session/ann_doc'), { kind: 'agent', from: 'path', agent: 'ann_doc' });
  assert.deepStrictEqual(path('/api/agents/gp'), { kind: 'agent', from: 'path', agent: 'gp' });
  assert.deepStrictEqual(path('/api/agents/gp/files'), { kind: 'agent', from: 'path', agent: 'gp' });
  assert.deepStrictEqual(path('/api/agents/gp/files/SOUL.md'), { kind: 'agent', from: 'path', agent: 'gp' });
  assert.deepStrictEqual(path('/api/agents/gp/model'), { kind: 'agent', from: 'path', agent: 'gp' });
  assert.deepStrictEqual(path('/api/agents/gp/display'), { kind: 'agent', from: 'path', agent: 'gp' });
  assert.deepStrictEqual(path('/api/agents/gp/icon'), { kind: 'agent', from: 'path', agent: 'gp' });
  assert.deepStrictEqual(path('/api/agents/gp/filesystem'), { kind: 'admin' }, 'only the listed sub-resources are agent-scoped');
  assert.deepStrictEqual(path('/api/agents/gp/delete'), { kind: 'admin' });
  assert.deepStrictEqual(path('/api/memory/gp/stats'), { kind: 'agent', from: 'path', agent: 'gp' });
  assert.deepStrictEqual(path('/api/memory/gp/clear'), { kind: 'admin' });
  assert.deepStrictEqual(path('/api/image/gp/abc.png'), { kind: 'agent', from: 'path', agent: 'gp' });
  assert.deepStrictEqual(path('/api/history/a%20b'), { kind: 'agent', from: 'path', agent: 'a b' }, 'path segment is decoded');
  assert.deepStrictEqual(path('/api/history/gp/extra'), { kind: 'admin' }, 'history takes exactly one segment');
  assert.ok(X.PUBLIC_EXACT.has('/login') && X.SESSION_EXACT.has('/api/me') && X.AGENT_BODY.has('/api/chat') && X.ADMIN_PAGES.has('/users') && Array.isArray(X.AGENT_PATH));
});

test('isAdmin / ownerOf / sharedWith / memberMayUse', () => {
  assert.ok(X.isAdmin(admin) && !X.isAdmin(ann) && !X.isAdmin(null) && !X.isAdmin({}));
  assert.strictEqual(X.ownerOf({ name: 'x' }), null);
  assert.strictEqual(X.ownerOf({ name: 'x', owner: '' }), null, 'empty owner is infrastructure');
  assert.strictEqual(X.ownerOf({ name: 'x', owner: 42 }), '42', 'owner ids are strings');
  assert.strictEqual(X.ownerOf(null), null);
  assert.deepStrictEqual(X.sharedWith(agents[6]), ['123']);
  assert.deepStrictEqual(X.sharedWith({ sharedWith: 'u_ann' }), [], 'non-array sharedWith is ignored');
  assert.deepStrictEqual(X.sharedWith(undefined), []);
  assert.ok(X.memberMayUse(ann, agents[3]), 'owner');
  assert.ok(X.memberMayUse(ann, agents[5]), 'shared with');
  assert.ok(!X.memberMayUse(bob, agents[3]));
  assert.ok(!X.memberMayUse(ann, agents[0]), 'infrastructure is not a member\'s');
  assert.ok(!X.memberMayUse(null, agents[3]) && !X.memberMayUse(ann, null));
});

test('canAccessAgent: admins everything, members their own + shared, virtual tw-* workers follow their parent', () => {
  const resolveVirtual = (n) => (n === 'tw-123' ? { parent: 'ann_doc' } : n === 'tw-orphan' ? { parent: null } : n === 'tw-bob' ? { parent: 'bob_assistant' } : null);
  const opts = { agents, resolveVirtual };
  assert.ok(X.canAccessAgent(admin, 'ann_doc', opts) && X.canAccessAgent(admin, 'nonexistent', opts) && X.canAccessAgent(admin, 'tw-123', opts));
  assert.ok(X.canAccessAgent(ann, 'ann_doc', opts) && X.canAccessAgent(ann, 'bob_assistant', opts));
  assert.ok(!X.canAccessAgent(ann, 'maestro', opts) && !X.canAccessAgent(ann, 'gp', opts) && !X.canAccessAgent(bob, 'ann_doc', opts));
  assert.ok(X.canAccessAgent(ann, 'tw-123', opts), 'worker of her own agent');
  assert.ok(X.canAccessAgent(ann, 'tw-bob', opts), 'worker of an agent shared with her');
  assert.ok(!X.canAccessAgent(bob, 'tw-123', opts), 'worker of someone else\'s agent');
  assert.ok(!X.canAccessAgent(ann, 'tw-orphan', opts), 'virtual without a parent is looked up by its own name and not found');
  assert.ok(!X.canAccessAgent(ann, 'tw-unknown', opts));
  assert.ok(!X.canAccessAgent(null, 'ann_doc', opts) && !X.canAccessAgent(ann, 'ann_doc') && !X.canAccessAgent(ann, undefined, opts));
});

test('visibleAgents: members see own + shared; admins see all or one owner via ownerFilter', () => {
  assert.deepStrictEqual(names(X.visibleAgents(ann, agents)), ['ann_assistant', 'ann_doc', 'bob_assistant']);
  assert.deepStrictEqual(names(X.visibleAgents(bob, agents)), ['bob_assistant']);
  assert.deepStrictEqual(X.visibleAgents(null, agents), []);
  assert.deepStrictEqual(X.visibleAgents(ann, undefined), []);
  assert.strictEqual(X.visibleAgents(admin, agents), agents, 'no filter: the same array');
  assert.deepStrictEqual(X.visibleAgents(admin, undefined), []);
  assert.deepStrictEqual(names(X.visibleAgents(admin, agents, { ownerFilter: 'infra' })), ['maestro', 'worker', 'shared_infra']);
  assert.deepStrictEqual(names(X.visibleAgents(admin, agents, { ownerFilter: 'mine' })), ['maestro', 'worker', 'gp', 'shared_infra'], 'mine = infrastructure + my own');
  assert.deepStrictEqual(names(X.visibleAgents(admin2, agents, { ownerFilter: 'mine' })), ['maestro', 'worker', 'shared_infra']);
  assert.deepStrictEqual(names(X.visibleAgents(admin, agents, { ownerFilter: 'u_ann' })), ['ann_assistant', 'ann_doc']);
  assert.deepStrictEqual(names(X.visibleAgents(admin, agents, { ownerFilter: 'u_nobody' })), []);
  assert.deepStrictEqual(names(X.visibleAgents(ann, agents, { ownerFilter: 'infra' })), ['ann_assistant', 'ann_doc', 'bob_assistant'], 'ownerFilter ignored for members');
});

test('peersOf / sameOwner: admin-owned and infrastructure form one pool, a member\'s agents see only that member\'s', () => {
  const opts = { adminIds, resolveVirtual: (n) => (n === 'tw-9' ? { parent: 'ann_doc' } : null) };
  const adminPool = ['maestro', 'worker', 'gp', 'shared_infra'];
  assert.deepStrictEqual(names(X.peersOf('maestro', agents, opts)), adminPool, 'infrastructure caller');
  assert.deepStrictEqual(names(X.peersOf('gp', agents, opts)), adminPool, 'admin-owned caller sees the admin side');
  assert.deepStrictEqual(names(X.peersOf('ann_doc', agents, opts)), ['ann_assistant', 'ann_doc'], 'member-owned caller: that member\'s agents only');
  assert.deepStrictEqual(names(X.peersOf('bob_assistant', agents, opts)), ['bob_assistant'], 'sharing does not widen a member pool');
  assert.deepStrictEqual(names(X.peersOf('tw-9', agents, opts)), ['ann_assistant', 'ann_doc'], 'virtual worker inherits its parent\'s pool');
  assert.deepStrictEqual(names(X.peersOf('unknown', agents, opts)), adminPool, 'unknown caller is treated as infrastructure');
  assert.deepStrictEqual(names(X.peersOf('gp', agents)), ['gp'], 'without adminIds an admin-owned agent is treated as a member pool of its own');
  assert.deepStrictEqual(X.peersOf('maestro', undefined, opts), []);
  assert.ok(X.sameOwner('ann_assistant', 'ann_doc', agents, opts));
  assert.ok(X.sameOwner('maestro', 'gp', agents, opts));
  assert.ok(!X.sameOwner('ann_doc', 'maestro', agents, opts) && !X.sameOwner('ann_doc', 'bob_assistant', agents, opts) && !X.sameOwner('maestro', 'ann_doc', agents, opts));
  assert.ok(!X.sameOwner('maestro', undefined, agents, opts));
});

test('ownerEntries counts agents per owner for the admin switcher', () => {
  const users = [admin, ann, bob, { id: 'u_new', name: 'New', role: 'member' }];
  const e = X.ownerEntries(agents, users);
  assert.strictEqual(e.infraCount, 3);
  assert.deepStrictEqual(e.owners, [
    { id: 'u_admin', name: 'Admin', role: 'admin', count: 1 },
    { id: 'u_ann', name: 'Ann', role: 'member', count: 2 },
    { id: 'u_bob', name: 'Bob', role: 'member', count: 1 },
    { id: 'u_new', name: 'New', role: 'member', count: 0 },
  ]);
  assert.deepStrictEqual(X.ownerEntries(undefined, undefined), { infraCount: 0, owners: [] });
  assert.deepStrictEqual(X.ownerEntries([{ name: 'x', owner: 7 }], [{ id: '7', name: 'Seven', role: 'member' }]).owners[0].count, 1, 'numeric owner matches string id');
});
