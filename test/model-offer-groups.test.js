'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createModelOfferGroups } = require('../lib/model-offer-groups');
const { createModelOffers } = require('../lib/model-offers-service');
const { createOffersStore } = require('../lib/model-offers-store');

const from = 'codex-cli/gpt-6-astra', to = 'codex-cli/gpt-6.1-astra';
const row = name => ({ name, model: from, box: 'box-' + name });
const ctx = { stillAllowed: () => true, isBusy: () => false };

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'groups-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'groups.json');
  const records = ['alpha', 'beta', 'declined', 'member', 'pinned'].map(row);
  records[3].owner = 'member';
  records[4].modelPinned = true;
  const state = { source: 'account-a', enabled: true, available: [from, to], writes: [], beforeWrite() {} };
  const store = createOffersStore({ file: path.join(dir, 'individual.json') });
  store.decline('declined', to);
  const offers = createModelOffers({
    agents: () => records, available: () => state.available, enabled: () => state.enabled,
    isVirtual: () => false, isSensitive: () => false, isLead: () => false, teamOfferNames: () => new Set(), store,
  });
  const open = () => createModelOfferGroups({
    file, store, source: () => state.source, offers: () => offers, records: () => records, enabled: () => state.enabled,
    ownerAllowed: a => !a.owner || a.owner === 'admin', stamp: a => a.box,
    setModel(name, model, check) {
      const a = records.find(r => r.name === name);
      state.beforeWrite(a);
      const status = check(a, a.box);
      if (status !== null) return { success: false, status };
      a.model = model;
      state.writes.push(name);
      return { success: true };
    },
  });
  return { open, state, records, offers, file };
}

test('first inventory, legacy declines, stable membership, mixed results and restart retry', async t => {
  const { open, state, records } = fixture(t);
  const svc = open();
  const [group] = await svc.list();
  assert.deepEqual(group.rows.map(r => r.name), ['alpha', 'beta']);
  assert.deepEqual(await open().list(), [group]);
  records.push(row('later'));
  assert.notEqual((await svc.list())[0].id, group.id);
  const first = await svc.answer(group.id, 'apply', { ...ctx, isBusy: n => n === 'beta' });
  assert.deepEqual(first.results.map(r => r.status), ['switched', 'busy']);
  const retry = open();
  const answers = await Promise.all([retry.answer(group.id, 'apply', ctx), retry.answer(group.id, 'apply', ctx)]);
  for (const answer of answers) assert.deepEqual(answer.results.map(r => r.status), ['switched', 'switched']);
  assert.deepEqual(state.writes, ['alpha', 'beta']);
  assert.deepEqual((await retry.list())[0].rows.map(r => r.name), ['later']);
});

test('new inventory triggers offer, dismissal reaches individual flow and survives restart', async t => {
  const { open, state, offers } = fixture(t);
  const svc = open();
  state.available = [from, 'openai/gpt-6.1-astra'];
  assert.deepEqual(await svc.list(), []);
  state.available.push(to);
  const [group] = await svc.list();
  offers.decline('beta', to);
  const answer = await svc.answer(group.id, 'dismiss', ctx);
  assert.deepEqual(answer.results.map(r => r.status), ['dismissed', 'changed']);
  assert.equal(await offers.offerFor('alpha'), null);
  assert.deepEqual(await open().list(), []);
  assert.deepEqual(state.writes, []);
});

test('guard checks fresh owner, identity, settings and caller at the write', async t => {
  const { open, state, records } = fixture(t);
  const svc = open();
  const [g] = await svc.list();
  await assert.rejects(svc.answer(g.id, 'apply', {}));
  state.beforeWrite = a => {
    if (a.name === 'alpha') a.owner = 'member';
    else a.box = 'replacement';
  };
  assert.deepEqual((await svc.answer(g.id, 'apply', ctx)).results.map(r => r.status), ['changed', 'changed']);
  assert.deepEqual((await svc.list())[0].rows.map(r => r.name), ['beta']);
  records[0].owner = undefined;
  state.beforeWrite = () => { state.enabled = false; };
  assert.equal((await svc.answer(g.id, 'apply', ctx)).results[0].status, 'failed');
  assert.deepEqual(await svc.list(), []);
  assert.deepEqual(state.writes, []);
});

test('separate provider targets get separate approvals', async t => {
  const { open, state, records } = fixture(t);
  records.push({ ...row('api'), model: 'openai/gpt-6-astra' });
  state.available.push('openai/gpt-6.1-astra');
  const svc = open();
  const groups = await svc.list();
  assert.equal(groups.length, 2);
  const api = groups.find(g => g.rows[0].name === 'api');
  assert.deepEqual(api.rows, [{ name: 'api', from: 'openai/gpt-6-astra', to: 'openai/gpt-6.1-astra', route: 'API', cost: 'billed per use' }]);
  await svc.answer(api.id, 'apply', ctx);
  assert.deepEqual(state.writes, ['api']);
});

test('a decline, a busy turn or loss of authorization at the write prevents a switch', async t => {
  const { open, state, offers } = fixture(t);
  const svc = open();
  const [group] = await svc.list();
  let busy = false;
  state.beforeWrite = a => {
    if (a.name === 'alpha') offers.decline(a.name, to);
    else busy = true;
  };
  const result = await svc.answer(group.id, 'apply', { ...ctx, isBusy: () => busy });
  assert.deepEqual(result.results.map(r => r.status), ['changed', 'busy']);
  let allowed = true;
  state.beforeWrite = () => { allowed = false; };
  const retry = await svc.answer(group.id, 'apply', { ...ctx, stillAllowed: () => allowed });
  assert.equal(retry.results[1].status, 'failed');
  assert.deepEqual(state.writes, []);
});

test('unreadable group state fails closed', async t => {
  const { open, file } = fixture(t);
  const svc = open();
  const [g] = await svc.list();
  fs.writeFileSync(file, '{');
  assert.deepEqual(await svc.list(), []);
  await assert.rejects(svc.answer(g.id, 'apply', ctx));
  assert.equal(fs.readFileSync(file, 'utf8'), '{');
});

test('production discovery returns prefixed ids and grouped inventory filters by route, freshness and chat capability', t => {
  const inst = require('./helpers/isolated-install').makeIsolatedInstall();
  const mod = name => require(path.join(inst.lib, name));
  const file = path.join(inst.data, 'discovered-models.json');
  const model = 'openai/gpt-6.1-astra';
  const cache = { discoveredAt: new Date().toISOString(), openai: ['gpt-6.1-astra', 'gpt-audio'],
    anthropic: ['claude-opus-5'], 'codex-cli-info': [{ id: 'metadata' }] };
  cache.offerSources = { openai: { id: 'key-a', at: cache.discoveredAt } };
  fs.writeFileSync(file, JSON.stringify(cache));
  assert.deepEqual(mod('model-discovery').getDiscoveredModels(), ['anthropic/claude-opus-5', model, 'openai/gpt-audio']);
  let connected = true;
  mod('model-offer-accounts').source = p => p === 'openai' ? connected : null;
  connected = 'key-a';
  let warm = null;
  t.mock.method(mod('gateway-client'), 'cachedModels', () => warm);
  const inventory = mod('model-offer-groups').cachedOfferModels;
  assert.deepEqual(inventory(), [model]);
  warm = ['openai/gpt-audio'];
  assert.deepEqual(inventory(), []);
  warm = [model];
  connected = false;
  assert.deepEqual(inventory(), []);
  connected = 'rotated-key-or-endpoint';
  assert.deepEqual(inventory(), []);
  connected = 'key-a';
  cache.offerSources.openai.at = '2000-01-01';
  fs.writeFileSync(file, JSON.stringify(cache));
  assert.deepEqual(inventory(), []);
});

test('retry through the route recovers a committed registry write and distinguishes an external switch', async t => {
  const inst = require('./helpers/isolated-install').makeIsolatedInstall();
  const registry = require(path.join(inst.lib, 'agents'));
  const file = path.join(inst.data, 'groups.json');
  fs.writeFileSync(path.join(inst.data, 'agents.json'), JSON.stringify(['alpha', 'beta'].map(row)));
  const store = createOffersStore({ file: path.join(inst.data, 'individual.json') });
  const offers = createModelOffers({ agents: registry.readAgentsFileStrict, available: () => [to], enabled: () => true,
    isLead: () => false, isVirtual: () => false, isSensitive: () => false, teamOfferNames: () => new Set(), store });
  const open = () => createModelOfferGroups({ file, store, records: registry.readAgentsFileStrict, stamp: registry.stampOf,
    offers: () => offers, enabled: () => true, ownerAllowed: () => true, setModel: registry.setAgentModel });
  const svc = open();
  const [group] = await svc.list();
  await registry.setAgentModel('beta', to);
  const rename = fs.renameSync;
  const fault = t.mock.method(fs, 'renameSync', (source, dest) => {
    if (dest === file) throw new Error('ledger unavailable');
    return rename(source, dest);
  });
  await assert.rejects(svc.answer(group.id, 'apply', ctx), /ledger unavailable/);
  fault.mock.restore();
  assert.equal(registry.readAgentsFileStrict()[0].model, to);
  const user = { id: 'owner', role: 'admin' };
  const response = await require('../lib/model-offer-group-routes').routeModelOfferGroups({
    pathname: '/api/model-offer-groups/answer', req: { method: 'POST', hubIdentKind: 'user', hubUser: user },
    identify: () => ({ kind: 'user', user }), isOwner: u => u.id === user.id, getService: open, isBusy: () => false,
    readBody: () => JSON.stringify({ id: group.id, action: 'apply' }),
  });
  assert.deepEqual(response, { status: 200, body: { results: [
    { name: 'alpha', status: 'switched' }, { name: 'beta', status: 'changed' },
  ] } });
});

test('rediscovery with identical models and label invalidates the old approval', async t => {
  const { open, state } = fixture(t);
  const svc = open();
  const [old] = await svc.list();
  state.source = 'account-b';
  const [fresh] = await svc.list();
  assert.deepEqual(fresh.rows, old.rows);
  assert.notEqual(fresh.id, old.id);
  assert.deepEqual((await svc.answer(old.id, 'dismiss', ctx)).results.map(r => r.status), ['changed', 'changed']);
  state.beforeWrite = () => { state.source = 'account-c'; };
  assert.deepEqual((await svc.answer(fresh.id, 'apply', ctx)).results.map(r => r.status), ['changed', 'changed']);
  assert.deepEqual(state.writes, []);
});

test('assignment rollback between scan and registry commit invalidates approval', async t => {
  const { open, state } = fixture(t);
  const svc = open();
  const [group] = await svc.list();
  state.beforeWrite = a => { a.modelAssignmentRevision = 'revision-after-rollback'; };
  assert.deepEqual((await svc.answer(group.id, 'apply', ctx)).results.map(r => r.status), ['changed', 'changed']);
  assert.deepEqual(state.writes, []);
});

test('group dismissal recovers its own receipt after ledger failure', async t => {
  const { open, offers, file } = fixture(t);
  const svc = open();
  const [group] = await svc.list();
  offers.decline('beta', to);
  const rename = fs.renameSync;
  const fault = t.mock.method(fs, 'renameSync', (source, dest) => {
    if (dest === file) throw new Error('ledger unavailable');
    return rename(source, dest);
  });
  await assert.rejects(svc.answer(group.id, 'dismiss', ctx), /ledger unavailable/);
  fault.mock.restore();
  assert.equal(await offers.offerFor('alpha'), null);
  assert.deepEqual((await open().answer(group.id, 'apply', ctx)).results.map(r => r.status), ['dismissed', 'changed']);
});

test('failed decline commit rolls back both dismissal and receipt, forget clears a committed receipt', async t => {
  const { open, offers, file } = fixture(t);
  const svc = open();
  const [group] = await svc.list();
  const target = path.join(path.dirname(file), 'individual.json');
  const before = fs.readFileSync(target, 'utf8');
  const rename = fs.renameSync;
  const fault = t.mock.method(fs, 'renameSync', (source, dest) => {
    if (dest === target) throw new Error('store unavailable');
    return rename(source, dest);
  });
  assert.deepEqual((await svc.answer(group.id, 'dismiss', ctx)).results.map(r => r.status), ['failed', 'failed']);
  assert.equal(fs.readFileSync(target, 'utf8'), before);
  fault.mock.restore();
  const crash = t.mock.method(fs, 'renameSync', (source, dest) => {
    if (dest === file) throw new Error('ledger unavailable');
    return rename(source, dest);
  });
  await assert.rejects(svc.answer(group.id, 'dismiss', ctx), /ledger unavailable/);
  crash.mock.restore();
  assert.equal(offers.forget('alpha').ok, true);
  assert.deepEqual((await open().answer(group.id, 'apply', ctx)).results.map(r => r.status), ['switched', 'switched']);
});

test('pending legacy snapshot without provider identity fails closed', async t => {
  const { open, state, file } = fixture(t);
  const [group] = await open().list();
  const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = ledger.groups[group.id].map(({ source, modelAssignmentRevision, ...legacy }) => legacy);
  const id = require('node:crypto').createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  ledger.groups = { [id]: rows };
  fs.writeFileSync(file, JSON.stringify(ledger));
  assert.deepEqual((await open().answer(id, 'apply', ctx)).results.map(r => r.status), ['changed', 'changed']);
  assert.deepEqual(state.writes, []);
});
