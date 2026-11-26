'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeIsolatedInstall } = require('./helpers/isolated-install');

test('registry sees foreground work and running or cancelling jobs owned by the agent', async t => {
  const { lib, data } = makeIsolatedInstall();
  const registry = require(path.join(lib, 'agents'));
  const runner = { jobs: new Map([['job-a', { owner: 'worker', status: 'running' }]]) };
  const sdk = { isAgentActive: n => n === 'foreground', getJobRunner: () => runner };
  const sdkPath = require.resolve(path.join(lib, 'sdk-chat'));
  assert.equal(registry.agentBusy('agent', true), true);
  require.cache[sdkPath] = { exports: sdk };
  t.after(() => { delete require.cache[sdkPath]; });
  assert.equal(registry.agentBusy('foreground', true), true);
  assert.equal(registry.agentBusy('worker', true), true);
  assert.equal(registry.agentBusy('idle', true), false);
  runner.jobs.get('job-a').status = 'cancelling';
  assert.equal(registry.agentBusy('worker', true), true);
  runner.jobs.get('job-a').status = 'completed';
  assert.equal(registry.agentBusy('worker', true), false);
  sdk.getJobRunner = () => { throw Error('unavailable'); };
  assert.equal(registry.agentBusy('idle', true), true);
});

test('manual rollback invalidates a grouped offer and fresh approval publishes once', async () => {
  const { lib, data } = makeIsolatedInstall();
  const registry = require(path.join(lib, 'agents'));
  const from = 'codex-cli/gpt-6-astra', to = 'codex-cli/gpt-6.1-astra';
  fs.writeFileSync(path.join(data, 'agents.json'), JSON.stringify([{ name: 'alpha', box: 'alpha-box', model: from }]));
  const read = () => registry.readAgentsFileStrict()[0];
  const store = require(path.join(lib, 'model-offers-store')).createOffersStore({ file: path.join(data, 'offers.json') });
  const offers = require(path.join(lib, 'model-offers-service')).createModelOffers({
    agents: registry.readAgentsFileStrict, available: () => [to], enabled: () => true,
    isVirtual: () => false, isSensitive: () => false, isLead: () => false, teamOfferNames: () => new Set(), store,
  });
  const events = [];
  const svc = require(path.join(lib, 'model-offer-groups')).createModelOfferGroups({
    file: path.join(data, 'groups.json'), store, offers: () => offers, records: registry.readAgentsFileStrict,
    stamp: registry.stampOf, enabled: () => true, ownerAllowed: () => true,
    setModel: (...args) => registry.setAgentModel(...args, (...event) => events.push(event)),
  });
  const ctx = { stillAllowed: () => true, isBusy: () => false };
  const [old] = await svc.list();
  await registry.setAgentModel('alpha', from);
  assert.equal(read().modelAssignmentRevision, undefined);
  await registry.setAgentModel('alpha', to);
  const first = read().modelAssignmentRevision;
  assert.ok(first);
  await registry.setAgentModel('alpha', from);
  const reverted = read().modelAssignmentRevision;
  assert.ok(reverted);
  assert.notEqual(reverted, first);
  assert.equal((await svc.answer(old.id, 'apply', ctx)).results[0].status, 'changed');
  assert.deepEqual(events, []);
  const [fresh] = await svc.list();
  assert.notEqual(fresh.id, old.id);
  assert.equal((await svc.answer(fresh.id, 'apply', ctx)).results[0].status, 'switched');
  const approved = read();
  assert.ok(approved.modelOfferApproval);
  assert.notEqual(approved.modelAssignmentRevision, reverted);
  await registry.setAgentModel('alpha', to);
  assert.deepEqual(read(), approved);
  await registry.setAgentModel('alpha', from);
  assert.equal(read().modelOfferApproval, approved.modelOfferApproval);
  await svc.answer(fresh.id, 'apply', ctx);
  assert.equal(read().model, from);
  assert.deepEqual(events, [['alpha', ['model']]]);
});
