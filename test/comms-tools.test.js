'use strict';

// lib/comms/tools.js: the comms_channels/comms_send tool specs, the isCommsAgent
// gate (per-channel agents array, virtual/temporal-worker agents excluded), and
// runTool's DENIED/ERROR/success string contract. All service access goes through
// the injectable getService() parameter, so no real CommsService is needed here.

const { test } = require('node:test');
const assert = require('node:assert');
const { toolSpecs, runTool, isCommsAgent } = require('../lib/comms/tools');
const { createVirtual, releaseVirtual } = require('../lib/temporal-workers');

function fakeService(overrides = {}) {
  return {
    config: { channels: { telegram: { agents: ['maestro', 'cos'] } }, ...overrides.config },
    channelsInfo: overrides.channelsInfo || (async (agent) => ({ telegram: { enabled: true, canSend: true }, agent })),
    send: overrides.send || (async (a) => ({ ok: true, ...a })),
  };
}

// ── toolSpecs ────────────────────────────────────────────────────────────

test('toolSpecs returns comms_channels and comms_send with the expected shapes', () => {
  const specs = toolSpecs(() => fakeService());
  assert.strictEqual(specs.length, 2);

  const channels = specs.find((s) => s.name === 'comms_channels');
  assert.ok(channels);
  assert.strictEqual(typeof channels.description, 'string');
  assert.deepStrictEqual(channels.parameters, { type: 'object', properties: {} });
  assert.deepStrictEqual(channels.zod(), {});
  assert.strictEqual(typeof channels.run, 'function');

  const send = specs.find((s) => s.name === 'comms_send');
  assert.ok(send);
  assert.deepStrictEqual(send.parameters.required, ['channel', 'to', 'text']);
  assert.deepStrictEqual(Object.keys(send.parameters.properties).sort(), ['channel', 'text', 'to']);
  const zodShape = send.zod({ string: () => 'zstring' });
  assert.deepStrictEqual(Object.keys(zodShape).sort(), ['channel', 'text', 'to']);
});

// ── isCommsAgent ─────────────────────────────────────────────────────────

test('isCommsAgent is false for a missing/empty agent name', () => {
  assert.strictEqual(isCommsAgent(null, () => fakeService()), false);
  assert.strictEqual(isCommsAgent('', () => fakeService()), false);
  assert.strictEqual(isCommsAgent(undefined, () => fakeService()), false);
});

test('isCommsAgent is true when the agent is in some channel\'s agents array', () => {
  assert.strictEqual(isCommsAgent('maestro', () => fakeService()), true);
  assert.strictEqual(isCommsAgent('cos', () => fakeService()), true);
});

test('isCommsAgent is false when the agent is not in any channel\'s agents array', () => {
  assert.strictEqual(isCommsAgent('stranger', () => fakeService()), false);
});

test('isCommsAgent is false for a virtual/temporal-worker agent even if listed', async (t) => {
  const v = createVirtual({ parent: 'maestro' });
  t.after(() => releaseVirtual(v.id));
  const svc = fakeService({ config: { channels: { telegram: { agents: [v.id] } } } });
  assert.strictEqual(isCommsAgent(v.id, () => svc), false);
});

test('isCommsAgent is false (not throwing) when getService throws', () => {
  assert.strictEqual(isCommsAgent('maestro', () => { throw new Error('boom'); }), false);
});

// ── runTool ──────────────────────────────────────────────────────────────

test('runTool returns DENIED for an agent not authorised for any comms channel', async () => {
  const out = await runTool('comms_channels', {}, 'stranger', () => fakeService());
  assert.strictEqual(out, '[DENIED] Agent "stranger" is not authorised to use comms tools.');
});

test('runTool returns a COMMS ERROR for an unknown tool name', async () => {
  const out = await runTool('comms_nonexistent', {}, 'maestro', () => fakeService());
  assert.strictEqual(out, '[COMMS ERROR] Unknown tool "comms_nonexistent".');
});

test('runTool runs comms_channels and returns cleaned JSON', async () => {
  const svc = fakeService({ channelsInfo: async (agent) => ({ telegram: { enabled: true, canSend: true }, _internal: 'secret', agent }) });
  const out = await runTool('comms_channels', {}, 'maestro', () => svc);
  const parsed = JSON.parse(out);
  assert.deepStrictEqual(parsed, { telegram: { enabled: true, canSend: true }, agent: 'maestro' });
  assert.ok(!out.includes('_internal'));
  assert.ok(!out.includes('secret'));
});

test('runTool runs comms_send with the given args plus the calling agent name', async () => {
  let seen = null;
  const svc = fakeService({ send: async (a) => { seen = a; return { ok: true, id: '1' }; } });
  const out = await runTool('comms_send', { channel: 'telegram', to: 'owner', text: 'hi' }, 'maestro', () => svc);
  assert.deepStrictEqual(seen, { channel: 'telegram', to: 'owner', text: 'hi', agent: 'maestro' });
  assert.deepStrictEqual(JSON.parse(out), { ok: true, id: '1' });
});

test('runTool returns a COMMS ERROR (never a stack trace) when the handler throws', async () => {
  const svc = fakeService({ send: async () => { throw new Error('not an allow-listed recipient'); } });
  const out = await runTool('comms_send', { channel: 'telegram', to: 'nobody', text: 'hi' }, 'maestro', () => svc);
  assert.strictEqual(out, '[COMMS ERROR] not an allow-listed recipient');
  assert.ok(!out.includes('at '));
});

test('runTool defaults args to {} when none are given', async () => {
  let seen = 'unset';
  const svc = fakeService({ channelsInfo: async (agent) => { seen = agent; return {}; } });
  await runTool('comms_channels', undefined, 'maestro', () => svc);
  assert.strictEqual(seen, 'maestro');
});
