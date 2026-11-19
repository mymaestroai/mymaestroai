'use strict';
// lib/model-offers-service: stand-in dependencies only (nothing reads the install's data/).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createModelOffers } = require('../lib/model-offers-service');
const { createOffersStore } = require('../lib/model-offers-store');

const LEAD = 'claude-sdk/claude-opus-5-5';
const AVAIL = ['claude-sdk/claude-opus-5-5', 'claude-sdk/claude-opus-6'];
function tmpStore() { return createOffersStore({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mo-svc-')), 'offers.json') }); }
function make(over = {}) {
  return createModelOffers({
    agents: async () => [
      { name: 'owner-a', display: 'Owner A', model: LEAD, lead: true },
      { name: 'helper-b', model: 'claude-sdk/claude-opus-5-5' },
      { name: 'sam', model: 'claude-sdk/claude-opus-5-5', modelPinned: true },
    ],
    available: async () => AVAIL,
    isLead: (n) => n === 'owner-a',
    enabled: () => true,
    store: tmpStore(),
    isSensitive: () => false,
    isVirtual: () => false,
    teamOfferNames: async () => new Set(),
    ...over,
  });
}

test('list: offers with display, pinned agents left out', async () => {
  const l = await make().list();
  assert.deepEqual(l.map((o) => o.name).sort(), ['helper-b', 'owner-a']);
  const o = l.find((x) => x.name === 'owner-a');
  assert.equal(o.display, 'Owner A');
  assert.equal(o.to, 'claude-sdk/claude-opus-6');
  assert.equal(l.find((x) => x.name === 'helper-b').display, 'helper-b');
});

test('list: off, failing deps and skips give fewer offers, never a throw', async () => {
  assert.deepEqual(await make({ enabled: () => false }).list(), []);
  assert.deepEqual(await make({ agents: async () => { throw new Error('x'); } }).list(), []);
  assert.deepEqual(await make({ available: async () => { throw new Error('x'); } }).list(), []);
  assert.deepEqual((await make({ isVirtual: (n) => n === 'helper-b' }).list()).map((o) => o.name), ['owner-a']);
  assert.deepEqual((await make({ teamOfferNames: async () => new Set(['owner-a']) }).list()).map((o) => o.name), ['helper-b']);
  assert.equal((await make({ teamOfferNames: async () => { throw new Error('x'); } }).list()).length, 2);
});

test('offerFor, decline and forget', async () => {
  const svc = make();
  assert.equal((await svc.offerFor('helper-b')).to, 'claude-sdk/claude-opus-6');
  assert.equal(await svc.offerFor('nobody'), null);
  assert.equal(svc.decline('helper-b', 'claude-sdk/claude-opus-6').ok, true);
  assert.equal(await svc.offerFor('helper-b'), null);
  assert.equal(svc.forget('helper-b').ok, true);
  assert.ok(await svc.offerFor('helper-b'));
});
