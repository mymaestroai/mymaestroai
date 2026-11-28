'use strict';
// POST /api/chat/stream and POST /api/chat must hand the chat handler the identity of the authenticated caller
// (req.hubUser, req.hubService, hubAuth.hasUsers(), and whether the account is an admin), never anything the request body claims.
// The real route blocks are extracted from server.js and run in a vm.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
function block(head) {
  const start = source.indexOf(head);
  assert.ok(start > 0, 'route missing: ' + head);
  const end = source.indexOf('\n    }\n', start) + '\n    }\n'.length;
  return source.slice(start, end);
}
const streamRoute = block("if (pathname === '/api/chat/stream' && req.method === 'POST') {");
const chatRoute = block("if (pathname === '/api/chat' && req.method === 'POST') {");

const users = {};   // the accounts as they are now (changed by a test after a message was held)
const liveSessions = new Map();   // session id -> account id: the sign-ins that still stand (a test ends one after a message was held)
function build(route, { accounts = true } = {}) {
  const calls = [];
  const sandbox = {
    readBody: async (req) => req.body,
    stripHubOnlyChatFields: (b) => b,
    access: { isAdmin: (u) => !!u && u.role === 'admin', canAccessAgent: (u, name, o) => !!u && o.agents.some(a => a.name === name && a.owner === u.id) },
    hubAuth: { setTimeZone() {}, hasUsers: () => accounts, getUser: (id) => users[id] || null, sessionStillValid: (sid, uid) => liveSessions.get(sid) === uid },
    temporalWorkersLib: { getVirtual: () => null }, require: () => ({ getAgentsSync: () => [{ name: 'a', owner: 'u1' }, { name: 'b', owner: 'u3' }] }),
    // the stream route also hands over functions (recheck, ownerTurnNow: access is checked again when a waiting message is released); data keys are compared here
    handleChatStream: async (body, res, ctx) => { const data = {}; for (const [k, v] of Object.entries(ctx)) if (typeof v !== 'function') data[k] = v; calls.push({ body, ctx: data, fns: ctx }); return 'streamed'; },
    handleChat: async (body, res, ctx) => { calls.push({ body, ctx }); return 'chatted'; },
  };
  vm.createContext(sandbox);
  vm.runInContext(`this.route = async (pathname, req, res) => { ${route} return 'unhandled'; };`, sandbox);
  return { route: sandbox.route, calls };
}

const req = (user, body, extra = {}) => { if (user) liveSessions.set(`s-${user.id}`, user.id); return { method: 'POST', headers: {}, hubUser: user, hubIdentKind: user ? 'user' : null, hubSessionId: user ? `s-${user.id}` : null, body: JSON.stringify(body), ...extra }; };

// the stream route also tells the handler whether the caller is a person (a browser session) or a program (owner queue)
const withPerson = (label, ctx, person) => (label === '/api/chat/stream' ? { ...ctx, person } : ctx);
for (const [label, route, url, ret] of [['/api/chat/stream', streamRoute, '/api/chat/stream', 'streamed'], ['/api/chat', chatRoute, '/api/chat', 'chatted']]) {
  describe(`POST ${label} identity`, () => {
    it('passes each signed-in account its own id, not a service caller, with accounts present', async () => {
      const h = build(route);
      assert.strictEqual(await h.route(url, req({ id: 'u1', role: 'member' }, { agent: 'a', message: 'hi' }), {}), ret);
      await h.route(url, req({ id: 'u2', role: 'admin' }, { agent: 'a', message: 'hi' }), {});
      assert.deepEqual(h.calls.map(c => c.ctx), [withPerson(label, { userId: 'u1', service: false, accounts: true, admin: false }, true), withPerson(label, { userId: 'u2', service: false, accounts: true, admin: true }, true)]);
    });

    it('a service-token caller is its own identity (never folded into "no account"), even with accounts', async () => {
      const h = build(route);
      await h.route(url, req(null, { agent: 'a', message: 'hi' }, { hubService: true }), {});
      assert.deepEqual(h.calls[0].ctx, withPerson(label, { userId: null, service: true, accounts: true, admin: false }, false));
    });

    it('no account and no accounts on the install: userId null, accounts false (from the server, not the body)', async () => {
      const h = build(route, { accounts: false });
      await h.route(url, req(null, { agent: 'a', message: 'hi' }), {});
      assert.deepEqual(h.calls[0].ctx, withPerson(label, { userId: null, service: false, accounts: false, admin: false }, true));
    });

    it('ignores identity forged in the request body', async () => {
      const h = build(route);
      const forged = { agent: 'a', message: 'hi', userId: 'u2', user_id: 'u2', service: true, accounts: false, admin: true, ctx: { userId: 'u2', service: true, accounts: false }, hubUser: { id: 'u2' } };
      await h.route(url, req({ id: 'u1', role: 'member' }, forged), {});
      await h.route(url, req(null, forged), {});
      assert.deepEqual(h.calls[0].ctx, withPerson(label, { userId: 'u1', service: false, accounts: true, admin: false }, true));
      assert.deepEqual(h.calls[1].ctx, withPerson(label, { userId: null, service: false, accounts: true, admin: false }, true));
    });
  });
}

describe('every chat entry forwards the trusted ctx', () => {
  it('handleChat forwards its ctx into handleChatStream; only these two routes call the handlers', () => {
    assert.strictEqual((source.match(/handleChatStream\(/g) || []).length, 1);
    assert.strictEqual((source.match(/handleChat\(/g) || []).length, 1);
    const sdk = fs.readFileSync(path.join(__dirname, '../lib/sdk-chat.js'), 'utf8');
    assert.match(sdk, /async function handleChat\(body, res, ctx\)/);
    assert.match(sdk, /await handleChatStream\(body, fakeRes, ctx\);/);
  });
});

describe('a held message checks access again when it is released (recheck / ownerTurnNow of the stream route)', () => {
  it('true only while the account exists, is enabled and may still use the agent; owner_turn is recomputed from the fresh account', async () => {
    const h = build(streamRoute);
    users.u1 = { id: 'u1', role: 'member' }; users.u2 = { id: 'u2', role: 'admin' };
    await h.route('/api/chat/stream', req({ id: 'u1', role: 'member' }, { agent: 'a', message: 'hi' }), {});
    const f = h.calls[0].fns;
    assert.strictEqual(f.recheck(), true);
    assert.strictEqual(f.ownerTurnNow(), false);
    users.u1 = { id: 'u1', role: 'member', disabled: true };
    assert.strictEqual(f.recheck(), false, 'disabled');
    delete users.u1;
    assert.strictEqual(f.recheck(), false, 'removed');
    users.u1 = { id: 'u1', role: 'member' };
    await h.route('/api/chat/stream', req({ id: 'u1', role: 'member' }, { agent: 'b', message: 'hi' }), {});
    assert.strictEqual(h.calls[1].fns.recheck(), false, 'no access to that agent');
    await h.route('/api/chat/stream', req({ id: 'u2', role: 'admin' }, { agent: 'b', message: 'hi' }), {});
    assert.strictEqual(h.calls[2].fns.recheck(), true);
    assert.strictEqual(h.calls[2].fns.ownerTurnNow(), true);
    users.u2 = { id: 'u2', role: 'member' };
    assert.strictEqual(h.calls[2].fns.ownerTurnNow(), false, 'no longer an admin');
  });

  it('refuses once the sign-in itself is gone (signed out, revoked, expired, waiting for a code), though the account is fine', async () => {
    const h = build(streamRoute);
    users.u1 = { id: 'u1', role: 'member' };
    const u = { id: 'u1', role: 'member' };
    await h.route('/api/chat/stream', req(u, { agent: 'a', message: 'hi' }), {});
    const f = h.calls[0].fns;
    assert.strictEqual(f.recheck(), true);
    liveSessions.delete('s-u1');
    assert.strictEqual(f.recheck(), false, 'the session was revoked');
    liveSessions.set('s-u1', 'someone-else');
    assert.strictEqual(f.recheck(), false, 'the session id now belongs to another account');
    // a request that carried no session id at all (accounts on) never passes
    await h.route('/api/chat/stream', req(u, { agent: 'a', message: 'hi' }, { hubSessionId: null }), {});
    assert.strictEqual(h.calls[1].fns.recheck(), false);
    // no accounts on the install: as before
    const open = build(streamRoute, { accounts: false });
    await open.route('/api/chat/stream', req(null, { agent: 'a', message: 'hi' }), {});
    assert.strictEqual(open.calls[0].fns.recheck(), true);
  });

  it('refresh() rebuilds the context from the account as it is now', async () => {
    const h = build(streamRoute);
    users.u2 = { id: 'u2', role: 'admin' };
    await h.route('/api/chat/stream', req({ id: 'u2', role: 'admin' }, { agent: 'a', message: 'hi' }), {});
    assert.strictEqual(h.calls[0].ctx.admin, true);
    assert.deepStrictEqual({ ...h.calls[0].fns.refresh() }, { userId: 'u2', accounts: true, admin: true });
    users.u2 = { id: 'u2', role: 'member' };
    assert.deepStrictEqual({ ...h.calls[0].fns.refresh() }, { userId: 'u2', accounts: true, admin: false });
  });
});

describe('expect_user passes through the chat field filter', () => {
  it('is in neither the hub-only nor the admin-only list, so a member\'s page can send it', () => {
    const lists = [...source.matchAll(/const (?:HUB_ONLY|ADMIN_ONLY)_CHAT_FIELDS = \[([^\]]*)\]/g)].map(m => m[1]);
    assert.strictEqual(lists.length, 2);
    for (const l of lists) assert.ok(!/expect_user/.test(l), l);
    const strip = source.slice(source.indexOf('function stripHubOnlyChatFields'), source.indexOf('\n}\n', source.indexOf('function stripHubOnlyChatFields')) + 2);
    const sandbox = { HUB_ONLY_CHAT_FIELDS: ['image_files', 'consulted_by', 'origin', 'owner_turn'], ADMIN_ONLY_CHAT_FIELDS: ['override', 'ephemeral', 'tiger_team', 'consultation_depth'], access: { isAdmin: () => false } };
    vm.createContext(sandbox);
    vm.runInContext(strip + '\nthis.f = stripHubOnlyChatFields;', sandbox);
    const out = sandbox.f({ agent: 'a', message: 'm', expect_user: 'sam', owner_turn: true, override: true }, { hubService: false, hubUser: { id: 'u1', role: 'member' } });
    assert.strictEqual(out.expect_user, 'sam');
    assert.strictEqual(out.owner_turn, undefined);
    assert.strictEqual(out.override, undefined);
  });
});
