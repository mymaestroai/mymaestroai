'use strict';
// POST /api/chat/stream must hand handleChatStream the identity of the authenticated session (req.hubUser),
// never anything the request body claims. The real route block is extracted from server.js and run in a vm.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const start = source.indexOf("if (pathname === '/api/chat/stream' && req.method === 'POST') {");
assert.ok(start > 0, 'route missing');
const end = source.indexOf('\n    }\n', start) + '\n    }\n'.length;
const route = source.slice(start, end);

function build() {
  const calls = [];
  const sandbox = {
    readBody: async (req) => req.body,
    stripHubOnlyChatFields: (b) => b,
    access: { isAdmin: (u) => !!u && u.role === 'admin' },
    hubAuth: { setTimeZone() {} },
    handleChatStream: async (body, res, ctx) => { calls.push({ body, ctx }); return 'streamed'; },
  };
  vm.createContext(sandbox);
  vm.runInContext(`this.route = async (pathname, req, res) => { ${route} return 'unhandled'; };`, sandbox);
  return { route: sandbox.route, calls };
}

const req = (user, body) => ({ method: 'POST', headers: {}, hubUser: user, hubIdentKind: user ? 'user' : null, body: JSON.stringify(body) });

describe('POST /api/chat/stream identity', () => {
  it('passes each signed-in account its own id', async () => {
    const h = build();
    assert.strictEqual(await h.route('/api/chat/stream', req({ id: 'u1', role: 'member' }, { agent: 'a', message: 'hi' }), {}), 'streamed');
    await h.route('/api/chat/stream', req({ id: 'u2', role: 'admin' }, { agent: 'a', message: 'hi' }), {});
    assert.deepEqual(h.calls.map(c => c.ctx), [{ userId: 'u1' }, { userId: 'u2' }]);
  });

  it('passes userId null when nobody is signed in (service / no account)', async () => {
    const h = build();
    await h.route('/api/chat/stream', req(null, { agent: 'a', message: 'hi' }), {});
    assert.deepEqual(h.calls[0].ctx, { userId: null });
  });

  it('ignores identity forged in the request body', async () => {
    const h = build();
    const forged = { agent: 'a', message: 'hi', userId: 'u2', user_id: 'u2', ctx: { userId: 'u2' }, hubUser: { id: 'u2' } };
    await h.route('/api/chat/stream', req({ id: 'u1', role: 'member' }, forged), {});
    await h.route('/api/chat/stream', req(null, forged), {});
    assert.deepEqual(h.calls[0].ctx, { userId: 'u1' });
    assert.deepEqual(h.calls[1].ctx, { userId: null });
  });

  it('only the stream route was given a ctx: no other handleChatStream call in server.js', () => {
    const all = source.match(/handleChatStream\(/g) || [];
    assert.strictEqual(all.length, 1);
  });
});
