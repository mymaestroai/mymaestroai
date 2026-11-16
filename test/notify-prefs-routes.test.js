'use strict';
// /api/notify/prefs and /api/notify/presence: the handler (lib/notify-prefs-routes) that server.js calls with the
// signed-in person's id, plus the wiring that makes sure server.js and the route classes use it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createNotifyPrefs } = require('../lib/notify-prefs');
const { handle } = require('../lib/notify-prefs-routes');
const access = require('../lib/access');

const AGENTS = ['helper', 'coach'];
function rig(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-routes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prefs = createNotifyPrefs({ file: path.join(root, 'prefs.json') });
  // owner sees both agents; sam sees only coach
  const call = (userId, method, pathname, body, extra = {}) => handle({
    method, pathname, body, userId, prefs, agentExists: (n) => AGENTS.includes(n),
    agentVisible: (n) => userId === 'owner' || n === 'coach', ...extra,
  });
  return { prefs, call };
}
const P = '/api/notify/prefs';

test('GET returns the caller\'s own settings with defaults filled and the away state', (t) => {
  const { call } = rig(t);
  const r = call('owner', 'GET', P, {});
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, prefs: { default: { questions: 'on', other: 'on' }, agents: {} }, away: true });
});

test('PUT by one person is never visible to another', (t) => {
  const { call } = rig(t);
  assert.equal(call('owner', 'PUT', P, { default: { questions: 'off' } }).status, 200);
  assert.equal(call('owner', 'PUT', P, { agent: 'helper', prefs: { other: 'away' } }).status, 200);
  assert.deepEqual(call('owner', 'GET', P, {}).json.prefs, { default: { questions: 'off', other: 'on' }, agents: { helper: { other: 'away' } } });
  assert.deepEqual(call('sam', 'GET', P, {}).json.prefs, { default: { questions: 'on', other: 'on' }, agents: {} });
});

test('the person comes from the session: a user id in the body or URL is ignored', (t) => {
  const { call, prefs } = rig(t);
  call('sam', 'PUT', P, { default: { other: 'off' }, userId: 'owner', user: 'owner' });
  assert.equal(prefs.mode('owner', null, 'other'), 'on');
  assert.equal(prefs.mode('sam', null, 'other'), 'off');
});

test('PUT shapes: default, agent kinds, null back to my default, prefs null removes the agent', (t) => {
  const { call } = rig(t);
  call('owner', 'PUT', P, { agent: 'helper', prefs: { questions: 'off', other: 'away' } });
  const r = call('owner', 'PUT', P, { agent: 'helper', prefs: { questions: null } });
  assert.deepEqual(r.json.prefs.agents, { helper: { other: 'away' } });
  assert.deepEqual(call('owner', 'PUT', P, { agent: 'helper', prefs: null }).json.prefs.agents, {});
});

test('bad mode, kind or body is 400 and changes nothing', (t) => {
  const { call } = rig(t);
  for (const body of [
    { default: { questions: 'loud' } }, { default: { questions: null } }, { default: { nope: 'on' } }, { default: 'on' },
    { agent: 'helper', prefs: { other: 'loud' } }, { agent: 'helper', prefs: { nope: 'on' } }, { agent: 'helper', prefs: 'on' },
    { agent: 'helper' }, { agent: 7, prefs: null }, { agent: 'helper', prefs: { other: 'on' }, default: { other: 'on' } }, {},
  ]) {
    const r = call('owner', 'PUT', P, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.ok, false);
    assert.equal(typeof r.json.error, 'string');
  }
  assert.equal(call('owner', 'PUT', P, null).status, 400);              // unparseable JSON
  assert.deepEqual(call('owner', 'GET', P, {}).json.prefs, { default: { questions: 'on', other: 'on' }, agents: {} });
});

test('an agent that does not exist or that the caller cannot see is 404 (and sets nothing)', (t) => {
  const { call, prefs } = rig(t);
  assert.equal(call('owner', 'PUT', P, { agent: 'ghost', prefs: { other: 'off' } }).status, 404);
  assert.equal(call('sam', 'PUT', P, { agent: 'helper', prefs: { other: 'off' } }).status, 404);   // exists, not sam's to see
  assert.equal(call('sam', 'PUT', P, { agent: '../x', prefs: { other: 'off' } }).status, 404);
  assert.deepEqual(prefs.get('sam').agents, {});
  assert.equal(call('sam', 'PUT', P, { agent: 'coach', prefs: { other: 'off' } }).status, 200);
});

test('presence: 200 for page and visible, 400 for anything else; it drives "away"', (t) => {
  const { call } = rig(t);
  const pr = '/api/notify/presence';
  assert.deepEqual(call('owner', 'POST', pr, { page: 'abc', visible: true }), { status: 200, json: { ok: true } });
  assert.equal(call('owner', 'GET', P, {}).json.away, false);
  assert.equal(call('sam', 'GET', P, {}).json.away, true);
  assert.equal(call('owner', 'POST', pr, { page: 'abc', visible: false }).status, 200);   // a beacon on pagehide
  assert.equal(call('owner', 'GET', P, {}).json.away, true);
  for (const body of [{ page: '', visible: true }, { page: 'x'.repeat(65), visible: true }, { page: 'a', visible: 'yes' }, { page: 'a' }, { visible: true }, null]) {
    assert.equal(call('owner', 'POST', pr, body).status, 400, JSON.stringify(body));
  }
  assert.equal(call('owner', 'GET', pr, {}).status, 405);
});

test('service tokens and API tokens get 403; no person at all gets 401', (t) => {
  const { call } = rig(t);
  for (const [m, p, b] of [['GET', P, {}], ['PUT', P, { default: { other: 'off' } }], ['POST', '/api/notify/presence', { page: 'a', visible: true }]]) {
    assert.equal(call('owner', m, p, b, { service: true }).status, 403);
    assert.equal(call('owner', m, p, b, { token: { id: 't' } }).status, 403);
    assert.equal(call(null, m, p, b).status, 401);
  }
});

test('other paths are not ours', (t) => {
  const { call } = rig(t);
  assert.equal(call('owner', 'GET', '/api/notify', {}), null);
});

test('wiring: both routes are session routes (any signed-in person) and server.js passes the session user only', () => {
  for (const p of [P, '/api/notify/presence']) assert.deepEqual(access.classifyRoute(p, 'GET'), { kind: 'session' });
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const at = src.indexOf("pathname === '/api/notify/prefs'");
  assert.ok(at > 0, 'server.js handles the routes');
  const block = src.slice(at, at + 1400);
  assert.match(block, /userId: who \? String\(who\.id\) : \(accounts \? null : '\*'\)/);
  assert.match(block, /service: req\.hubService, token: req\.hubToken/);
  assert.ok(!/body\.(userId|user)\b/.test(block), 'never a user id from the request');
});
