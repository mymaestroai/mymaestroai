'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyRoute, tokenAllows, TOKEN_ROUTES } = require('../lib/access');
const { crossOriginRefusal } = require('../lib/origin-guard');
const { routeModelOfferGroups: route } = require('../lib/model-offer-group-routes');
const routeModelOfferGroups = args => route({ isOwner: u => u.id === '1', ...args });
const { startGroupDiscovery } = require('../lib/model-offer-group-discovery');

const listPath = '/api/model-offer-groups';
const answerPath = listPath + '/answer';
const admin = { id: '1', role: 'admin' };
const makeRequest = method => ({ method, hubIdentKind: 'user', hubUser: admin });

test('both routes require a fully signed-in admin browser before touching offers', async () => {
  for (const [pathname, method] of [[listPath, 'GET'], [answerPath, 'POST']]) {
    assert.equal(classifyRoute(pathname, method).kind, 'admin');
    assert.equal(tokenAllows({ scopes: Object.keys(TOKEN_ROUTES) }, pathname, method).ok, false);
    assert.ok(crossOriginRefusal({ method, headers: { origin: 'https://foreign.example', host: 'localhost' } }, pathname));
    for (const override of [
      { hubIdentKind: null }, { hubIdentKind: 'legacy' }, { hubIdentKind: 'token' },
      { hubToken: {} }, { hubService: true }, { hubIdentKind: 'service' }, { hubPendingTotp: true },
      { hubUser: { id: '2', role: 'admin' } }, { hubUser: { id: '2', role: 'member' } }, { hubUser: null },
    ]) {
      const req = { ...makeRequest(method), ...override };
      assert.equal((await routeModelOfferGroups({ pathname, req })).status, 403);
    }
  }
});

test('validates answer and method before accessing the service', async () => {
  for (const raw of ['{', 'null', '{}', '{"action":"apply"}', '{"action":"switch","id":"group"}']) {
    const out = await routeModelOfferGroups({ req: makeRequest('POST'), pathname: answerPath, readBody: () => raw });
    assert.equal(out.status, 400);
  }
  for (const [pathname, method] of [[listPath, 'POST'], [answerPath, 'GET']]) {
    assert.equal((await routeModelOfferGroups({ pathname, req: makeRequest(method) })).status, 405);
  }
});

test('routes return service groups and outcomes, and hand the service a fresh authorization check per row', async () => {
  const rows = ['first', 'busy', 'revoked'];
  const groups = [{ id: 'group', names: rows }];
  let current = { kind: 'user', user: admin };
  const checked = [];
  const service = {
    list: () => groups,
    answer: (id, action, { stillAllowed, isBusy }) => {
      assert.deepEqual([id, action], ['group', 'apply']);
      const results = rows.map(name => {
        if (name === 'revoked') current = null;
        const result = stillAllowed() ? (isBusy(name) ? 'busy' : 'applied') : 'denied';
        checked.push(result);
        return { name, result };
      });
      return { results };
    },
  };
  const deps = { getService: () => service, identify: () => current, isBusy: name => name === 'busy' };
  assert.deepEqual((await routeModelOfferGroups({ ...deps, req: makeRequest('GET'), pathname: listPath })).body, { groups });
  const args = { ...deps, req: makeRequest('POST'), pathname: answerPath,
    readBody: () => JSON.stringify({ id: 'group', action: 'apply' }) };
  assert.equal((await routeModelOfferGroups(args)).status, 403);
  assert.deepEqual(checked, ['applied', 'busy', 'denied']);
  current = { kind: 'user', user: { id: 'different', role: 'admin' } };
  assert.equal((await routeModelOfferGroups(args)).status, 403);
  current = { kind: 'user', user: admin };
  service.answer = (id, action) => ({ results: [{ name: 'first', result: action }] });
  assert.deepEqual(await routeModelOfferGroups({ ...args, readBody: () => '{"id":"group","action":"dismiss"}' }),
    { status: 200, body: { results: [{ name: 'first', result: 'dismiss' }] } });
});

test('a discovery refresh persists a grouped offer before the browser opens, and one answer covers the displayed rows', async t => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'group-route-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'groups.json');
  const from = 'codex-cli/gpt-6-astra', to = 'codex-cli/gpt-6.1-astra';
  const agents = ['alpha', 'beta'].map(name => ({ name, model: from, box: 'box-' + name }));
  let cache = [from], changed;
  const offers = require('../lib/model-offers-service').createModelOffers({
    agents: () => agents, available: () => cache, enabled: () => true,
    isVirtual: () => false, isSensitive: () => false, isLead: () => false, teamOfferNames: () => new Set(),
    store: { read: () => ({ declined: {} }) },
  });
  const service = require('../lib/model-offer-groups').createModelOfferGroups({
    file, store: { read: () => ({ declined: {} }) }, offers: () => offers, records: () => agents, stamp: a => a.box, enabled: () => true, ownerAllowed: () => true,
    setModel(name, model, check) {
      const a = agents.find(item => item.name === name);
      const status = check(a, a.box);
      if (status) return { success: false, status };
      a.model = model;
      return { success: true };
    },
  });
  await startGroupDiscovery({ file: path.join(dir, 'discovered-models.json'), scan: service.list,
    watch: (_, __, callback) => { changed = callback; } });
  assert.equal(fs.existsSync(file), false);
  cache = [from, to];
  await changed();
  assert.equal(fs.existsSync(file), true);
  const deps = { getService: () => service, identify: () => ({ kind: 'user', user: admin }), isBusy: name => name === 'beta' };
  const { body: { groups: [offer] } } = await routeModelOfferGroups({ ...deps, req: makeRequest('GET'), pathname: listPath });
  assert.deepEqual(offer.rows.map(row => row.name), ['alpha', 'beta']);
  const out = await routeModelOfferGroups({ ...deps, req: makeRequest('POST'), pathname: answerPath,
    readBody: () => JSON.stringify({ id: offer.id, action: 'apply' }) });
  assert.deepEqual(out, { status: 200, body: { results: [{ name: 'alpha', status: 'switched' }, { name: 'beta', status: 'busy' }] } });
  assert.deepEqual(agents.map(a => a.model), [to, from]);
});

test('discovery processes the existing cache, repeats on refresh, and coalesces overlapping changes', async () => {
  let changed, release;
  let cache = ['codex-cli/gpt-5.3'];
  const observed = [];
  const first = startGroupDiscovery({
    file: '/stand-in/discovered-models.json',
    watch(file, opts, callback) {
      assert.equal(file, '/stand-in/discovered-models.json');
      changed = callback;
    },
    scan: async () => {
      observed.push([...cache]);
      if (observed.length === 1) await new Promise(resolve => { release = resolve; });
    },
  });
  await Promise.resolve();
  cache = ['codex-cli/gpt-5.3', 'codex-cli/gpt-5.4'];
  changed();
  changed();
  release();
  await first;
  assert.deepEqual(observed, [['codex-cli/gpt-5.3'], cache]);
  cache = [];
  await changed();
  assert.deepEqual(observed[2], []);
});
