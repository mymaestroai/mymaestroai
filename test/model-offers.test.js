'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { familyOf, findOffers, newestPerFamily, strongestOtherVendor, safeId } = require('../lib/model-offers');
const { createOffersStore } = require('../lib/model-offers-store');
require('../lib/model-tiers');

const LEAD = 'claude-sdk/claude-opus-5-5';
const plain = (r) => JSON.parse(JSON.stringify(r));   // read() answers with a prototype-free declined map
const one = (agent, available, extra = {}) => findOffers({ agents: [{ name: 'helper-b', ...agent }], available, lead: LEAD, ...extra });

test('familyOf examples', () => {
  const cases = {
    'claude-sdk/claude-opus-5-5': 'claude-sdk/claude-opus',
    'claude-sdk/claude-opus-6': 'claude-sdk/claude-opus',
    'codex-cli/gpt-6-astra': 'codex-cli/gpt-astra',
    'codex-cli/gpt-6.1-astra': 'codex-cli/gpt-astra',
    'codex-cli/gpt-6-astra-mini': 'codex-cli/gpt-astra-mini',
    'claude-sdk/claude-fable-5-1[1m]': 'claude-sdk/claude-fable[1m]',
    'anthropic/claude-sonnet-5-5-20261001': 'anthropic/claude-sonnet',
    'google/gemini-2.5-pro': 'google/gemini-pro',
    'openrouter/x-ai/grok-4.7': 'openrouter/x-ai/grok',
    'local/qwen3.8-27b': 'local/qwen3.8-27b',
    'opus': '',
    'claude-sdk/': '',
  };
  for (const [id, fam] of Object.entries(cases)) assert.equal(familyOf(id), fam, id);
  assert.equal(familyOf(null), '');
});

test('newer version', () => {
  const o = one({ model: 'claude-sdk/claude-opus-5-5' }, ['claude-sdk/claude-opus-5-5', 'claude-sdk/claude-opus-6', 'claude-sdk/claude-opus-5-6']);
  assert.equal(o.length, 1);
  assert.equal(o[0].to, 'claude-sdk/claude-opus-6');
  assert.equal(o[0].kind, 'newer');
  assert.equal(o[0].why, 'a newer version of the same model');
  assert.equal(o[0].cost, 'same subscription');
  assert.equal(o[0].agent.name, 'helper-b');
  assert.deepEqual(one({ model: 'claude-sdk/claude-opus-5-5' }, ['anthropic/claude-opus-6']), []);
  assert.deepEqual(one({ model: 'claude-sdk/opus' }, ['claude-sdk/claude-opus-6']), []);
  assert.deepEqual(one({ model: 'claude-sdk/claude-sonnet-5-5' }, ['claude-sdk/claude-opus-6']), []);
  const g = one({ model: 'codex-cli/gpt-6-astra' }, ['codex-cli/gpt-6.1-astra']);
  assert.equal(g[0].to, 'codex-cli/gpt-6.1-astra');
  assert.deepEqual(one({ model: 'codex-cli/gpt-6-astra' }, ['codex-cli/gpt-7-astra-mini']), []);
  assert.deepEqual(one({ model: 'local/qwen3.8-27b' }, ['local/qwen3.9-27b']), []);
  assert.deepEqual(one({ model: 'anthropic/claude-sonnet-5-5-20261001' }, ['anthropic/claude-sonnet-5-5']), []);
});

test('stronger, other vendor', () => {
  const ch = { model: 'codex-cli/gpt-6-astra', teamRole: 'challenger' };
  const o = one(ch, ['codex-cli/gpt-6-pro']);
  assert.equal(o.length, 1);
  assert.equal(o[0].to, 'codex-cli/gpt-6-pro');
  assert.equal(o[0].kind, 'stronger');
  assert.equal(o[0].why, 'a stronger model from another vendor, for a real second opinion');
  assert.deepEqual(one({ model: 'codex-cli/gpt-6-astra' }, ['codex-cli/gpt-6-pro']), []);
  assert.deepEqual(one(ch, ['openai/gpt-6-pro']), []);
  const api = one({ model: 'anthropic/claude-sonnet-5-5', teamRole: 'challenger' }, ['codex-cli/gpt-6-pro']);
  assert.equal(api.length, 1);
  assert.equal(api[0].cost, 'on a subscription instead of billed per use');
  assert.deepEqual(one({ model: 'local/qwen3.8-27b', teamRole: 'challenger' }, ['codex-cli/gpt-6-pro']), []);
  assert.deepEqual(one(ch, ['codex-cli/gpt-6-pro'], { isSensitive: () => true }), []);
  assert.deepEqual(one({ model: 'codex-cli/gpt-6-astra-mini', teamRole: 'challenger' }, ['claude-sdk/claude-opus-6']), []);   // lead vendor
  assert.deepEqual(one({ model: 'codex-cli/gpt-6-pro', teamRole: 'challenger' }, ['codex-cli/gpt-7-pro-x', 'codex-cli/gpt-5-pro']), []);   // equal tier
  const both = one(ch, ['codex-cli/gpt-6-pro', 'codex-cli/gpt-6.1-astra']);
  assert.equal(both[0].kind, 'newer');
  assert.equal(both[0].to, 'codex-cli/gpt-6.1-astra');
  // no lead: another vendor than the agent's own
  const nolead = findOffers({ agents: [{ name: 'a', model: 'claude-sdk/claude-sonnet-5-5', teamRole: 'challenger' }], available: ['claude-sdk/claude-opus-5-5', 'codex-cli/gpt-6-pro'] });
  assert.equal(nolead[0].to, 'codex-cli/gpt-6-pro');
  // subscription before api at the same tier
  const pref = findOffers({ agents: [{ name: 'a', model: 'anthropic/claude-sonnet-5-5', teamRole: 'challenger' }], available: ['openai/gpt-6-pro', 'codex-cli/gpt-5-pro'], lead: LEAD });
  assert.equal(pref[0].to, 'codex-cli/gpt-5-pro');
});

test('never offered', () => {
  const av = ['claude-sdk/claude-opus-5-5', 'claude-sdk/claude-opus-6', 'claude-sdk/claude-opus-5-6'];
  const a = { model: 'claude-sdk/claude-opus-5-5' };
  assert.deepEqual(one({ ...a, modelPinned: true }, av), []);
  assert.deepEqual(one(a, av, { enabled: false }), []);
  assert.deepEqual(one(a, av, { skip: (n) => n === 'helper-b' }), []);
  assert.deepEqual(one(a, av, { declined: { 'helper-b': ['claude-sdk/claude-opus-6'] } }), []);
  const again = one(a, av, { declined: { 'helper-b': ['claude-sdk/claude-opus-5-6'] } });
  assert.equal(again[0].to, 'claude-sdk/claude-opus-6');
  assert.deepEqual(one({ model: 'perplexity/sonar-2' }, ['perplexity/sonar-3']), []);
  assert.deepEqual(one({ model: 'codex/gpt-5' }, ['codex/gpt-6']), []);
  assert.deepEqual(one({ model: 'openai/text-embedding-3-small' }, ['openai/text-embedding-4-small']), []);
  assert.deepEqual(one(a, ['claude-sdk/claude-opus-6-embed']), []);
  // malformed inputs
  assert.deepEqual(findOffers({ agents: 'x', available: av }), []);
  assert.deepEqual(findOffers({}), []);
  assert.deepEqual(findOffers(), []);
  assert.deepEqual(findOffers({ agents: [null, 5, { name: 'x' }, { model: 'y' }, { name: 'ok', model: a.model }], available: av, declined: 'nope', lead: 7 }).map((o) => o.agent.name), ['ok']);
  assert.deepEqual(findOffers({ agents: [{ name: 'ok', model: a.model }], available: 'nope', declined: [1] }), []);
  assert.deepEqual(findOffers({ agents: [{ name: 'ok', model: a.model }], available: [1, null, 'claude-sdk/claude-opus-6', 'claude-sdk/claude-opus-6'] }).length, 1);
});

test('one offer per agent, in agent order', () => {
  const agents = [{ name: 'sam', model: 'claude-sdk/claude-opus-5-5' }, { name: 'reviewer-a', model: 'codex-cli/gpt-6-astra' }];
  const r = findOffers({ agents, available: ['claude-sdk/claude-opus-6', 'codex-cli/gpt-6.1-astra'] });
  assert.deepEqual(r.map((o) => o.agent.name), ['sam', 'reviewer-a']);
});

test('newestPerFamily and strongestOtherVendor', () => {
  const av = ['claude-sdk/claude-opus-5-5', 'claude-sdk/claude-opus-6', 'claude-sdk/opus', 'codex-cli/gpt-6-astra', 'codex-cli/gpt-6.1-astra', 'perplexity/sonar-9', 'local/qwen3.8-27b', 'local/qwen3.9-27b'];
  assert.deepEqual(newestPerFamily(av), [
    { family: 'claude-sdk/claude-opus', id: 'claude-sdk/claude-opus-6' },
    { family: 'codex-cli/gpt-astra', id: 'codex-cli/gpt-6.1-astra' },
    { family: 'local/qwen3.8-27b', id: 'local/qwen3.8-27b' },   // no pure-number token: each version is its own family
    { family: 'local/qwen3.9-27b', id: 'local/qwen3.9-27b' },
  ]);
  assert.deepEqual(newestPerFamily('x'), []);
  const pool = ['claude-sdk/claude-opus-6', 'codex-cli/gpt-6-astra', 'codex-cli/gpt-5-pro', 'openai/gpt-7-pro', 'local/qwen3.8-27b', 'perplexity/sonar-pro'];
  assert.equal(strongestOtherVendor(pool, 'Anthropic'), 'codex-cli/gpt-5-pro');
  assert.equal(strongestOtherVendor(pool, 'OpenAI'), 'claude-sdk/claude-opus-6');
  assert.equal(strongestOtherVendor(['local/qwen3.8-27b'], 'Anthropic'), null);
  assert.equal(strongestOtherVendor([], 'x'), null);
});

test('safeId', () => {
  assert.equal(safeId('claude-sdk/claude-fable-5-1[1m]'), true);
  assert.equal(safeId('opus'), false);
  assert.equal(safeId('a/b c'), false);
  assert.equal(safeId(5), false);
});

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offers-'));
  const file = path.join(dir, 'sub', 'model-offers.json');
  return { dir, file, store: createOffersStore({ file }) };
}

test('store: decline, read, twice, forget, mode, no tmp left', () => {
  const { dir, file, store } = tmpStore();
  assert.deepEqual(plain(store.read()), { declined: {} });
  assert.deepEqual(store.decline('helper-b', 'claude-sdk/claude-opus-6'), { ok: true });
  assert.deepEqual(plain(store.read()), { declined: { 'helper-b': ['claude-sdk/claude-opus-6'] } });
  store.decline('helper-b', 'claude-sdk/claude-opus-6');
  store.decline('sam', 'codex-cli/gpt-7');
  assert.deepEqual(store.read().declined['helper-b'], ['claude-sdk/claude-opus-6']);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['model-offers.json']);
  assert.deepEqual(store.forget('helper-b'), { ok: true });
  assert.deepEqual(plain(store.read()), { declined: { sam: ['codex-cli/gpt-7'] } });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['model-offers.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('store: bad name or id refused', () => {
  const { dir, store } = tmpStore();
  const bad = { ok: false, error: 'Bad agent name or model id.' };
  assert.deepEqual(store.decline('../x', 'claude-sdk/claude-opus-6'), bad);
  assert.deepEqual(store.decline('', 'claude-sdk/claude-opus-6'), bad);
  assert.deepEqual(store.decline('sam', 'opus'), bad);
  assert.deepEqual(store.decline('sam', 5), bad);
  assert.deepEqual(store.forget('a b'), bad);
  assert.deepEqual(plain(store.read()), { declined: {} });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('store: a malformed file is never overwritten', () => {
  const { dir, file, store } = tmpStore();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const junk = '{ not json';
  fs.writeFileSync(file, junk);
  assert.equal(store.read().unreadable, true);
  const r = store.decline('sam', 'codex-cli/gpt-7');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'The model offers file could not be read, so nothing changed.');
  assert.equal(store.forget('sam').ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), junk);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['model-offers.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('store: at most 50 ids per agent, oldest dropped', () => {
  const { dir, store } = tmpStore();
  for (let i = 0; i < 51; i++) store.decline('sam', `codex-cli/gpt-${i}`);
  const l = store.read().declined.sam;
  assert.equal(l.length, 50);
  assert.equal(l[0], 'codex-cli/gpt-1');
  assert.equal(l[49], 'codex-cli/gpt-50');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('review: agent names like "constructor" and a "__proto__" key are plain keys; another subscription says which', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mo-'));
  const file = path.join(dir, 'model-offers.json');
  fs.writeFileSync(file, '{"declined":{"__proto__":["claude-sdk/claude-opus-6"],"constructor":["claude-sdk/claude-opus-6"]}}');
  const s = createOffersStore({ file });
  const r = s.read();
  assert.equal(r.unreadable, undefined);
  assert.deepEqual(r.declined.constructor, ['claude-sdk/claude-opus-6']);
  assert.deepEqual(Object.keys(r.declined).sort(), ['__proto__', 'constructor']);
  assert.deepEqual(s.decline('toString', 'claude-sdk/claude-opus-6'), { ok: true });
  assert.deepEqual(createOffersStore({ file }).read().declined.toString, ['claude-sdk/claude-opus-6']);
  // findOffers: an agent called "constructor" with no declines of its own still gets its offer
  const o = findOffers({ agents: [{ name: 'constructor', model: 'claude-sdk/claude-opus-5-5' }, { name: 'hasOwnProperty', model: 'claude-sdk/claude-opus-5-5' }], available: ['claude-sdk/claude-opus-6'], declined: {} });
  assert.deepEqual(o.map((x) => x.agent.name), ['constructor', 'hasOwnProperty']);
  // a stronger model on another subscription names it
  const sub = findOffers({ agents: [{ name: 'reviewer-a', model: 'claude-sdk/claude-sonnet-5-5', teamRole: 'challenger' }], available: ['codex-cli/gpt-6-pro'], lead: 'claude-sdk/claude-haiku-5-5' });
  assert.equal(sub.length, 1);
  assert.equal(sub[0].cost, 'on the ChatGPT subscription');
  const sub2 = findOffers({ agents: [{ name: 'reviewer-a', model: 'claude-sdk/claude-sonnet-5-5', teamRole: 'challenger' }], available: ['codex-cli/gpt-6-pro'], lead: 'codex-cli/gpt-6-astra' });
  assert.equal(sub2.length, 0, 'never the lead\'s own vendor');
});
