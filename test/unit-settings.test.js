'use strict';
// Behavioural unit tests for lib/settings.js. The module hard-codes <lib>/../data/settings.json with no
// override, so each test copies settings.js into a throwaway hub dir (tmp/lib/settings.js) and requires
// THAT copy: the file it reads and writes is tmp/data/settings.json, never the real data/ folder.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname, '..', 'lib', 'settings.js');
const ENV = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'PERPLEXITY_API_KEY', 'LM_STUDIO_URL', 'OLLAMA_URL', 'OMLX_URL'];
const GLOBALS = ['__cavemanMode', '__prescanToolsEnabled', '__confirmToolsEnabled', '__lazyToolsEnabled', '__maxCompletionTokens', '__maxContextMessages'];
const dirs = [];
let savedEnv, savedGlobals;

test.beforeEach(() => {
  savedEnv = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
  savedGlobals = Object.fromEntries(GLOBALS.map(k => [k, global[k]]));
  for (const k of ENV) delete process.env[k];
});
test.afterEach(() => {
  for (const k of ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  for (const k of GLOBALS) { if (savedGlobals[k] === undefined) delete global[k]; else global[k] = savedGlobals[k]; }
});
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/** Fresh module instance over a temp data dir; `initial` (string or object) pre-seeds settings.json. */
function load(initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-settings-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'lib'));
  const lib = path.join(dir, 'lib', 'settings.js');
  fs.copyFileSync(SRC, lib);
  const file = path.join(dir, 'data', 'settings.json');
  if (initial !== undefined) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof initial === 'string' ? initial : JSON.stringify(initial));
  }
  const log = console.log; console.log = () => {};
  try { return { s: require(lib), file, dir }; } finally { console.log = log; }
}
const onDisk = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('getSetting: default when unset, stored value (including false/0/null) wins over the default', () => {
  const { s } = load({ flag: false, zero: 0, nothing: null, name: 'x' });
  assert.strictEqual(s.getSetting('missing', 'dflt'), 'dflt');
  assert.strictEqual(s.getSetting('missing'), undefined);
  assert.strictEqual(s.getSetting('flag', true), false);
  assert.strictEqual(s.getSetting('zero', 9), 0);
  assert.strictEqual(s.getSetting('nothing', 'd'), null);   // null is a value, not "unset"
  assert.strictEqual(s.getSetting('name', 'd'), 'x');
});

test('missing, empty or corrupt settings.json loads as {} with an empty providers object', () => {
  for (const initial of [undefined, '', '{not json']) {
    const { s } = load(initial);
    assert.deepStrictEqual(s.get(), { providers: {} });
  }
  const { s } = load({ a: 1 });   // an existing file without providers gets the key added
  assert.deepStrictEqual(s.get(), { a: 1, providers: {} });
});

test('a settings.json that is valid JSON but not an object', () => {
  for (const initial of ['null', '[1,2]', '"str"', '42', 'true']) {
    assert.deepStrictEqual(load(initial).s.get(), { providers: {} }, initial);   // behaves as empty settings
  }
  assert.deepStrictEqual(load({ providers: 'oops', a: 1 }).s.get(), { providers: {}, a: 1 });
});

test('updateSettings: creates the data dir, persists JSON, and a fresh load reads it back', () => {
  const { s, file, dir } = load();
  assert.ok(!fs.existsSync(path.join(dir, 'data')));
  s.updateSettings({ theme: 'dark', walletAgents: ['trader'] });
  assert.deepStrictEqual(onDisk(file), { providers: {}, theme: 'dark', walletAgents: ['trader'] });
  assert.strictEqual(s.getSetting('theme'), 'dark');
  // second instance over the same file sees the data
  const lib2 = path.join(dir, 'lib', 'again.js');
  fs.copyFileSync(SRC, lib2);
  const log = console.log; console.log = () => {};
  try { assert.strictEqual(require(lib2).getSetting('theme'), 'dark'); } finally { console.log = log; }
});

test('updateSettings: top-level keys shallow-merge; arrays are replaced, not merged; undefined removes the key', () => {
  const { s, file } = load({ keep: 1, walletAgents: ['a', 'b'], drop: 'x', nested: { p: 1, q: 2 } });
  s.updateSettings({ walletAgents: ['c'], nested: { p: 9 } });
  assert.deepStrictEqual(s.getSetting('walletAgents'), ['c']);
  assert.deepStrictEqual(s.getSetting('nested'), { p: 9 });   // non-provider objects are replaced wholesale
  assert.strictEqual(s.getSetting('keep'), 1);
  s.updateSettings({ drop: undefined });
  assert.strictEqual(s.getSetting('drop', 'gone'), 'gone');
  assert.ok(!('drop' in onDisk(file)), 'undefined is dropped by JSON on save');
  s.updateSettings({ keep: null });
  assert.strictEqual(s.getSetting('keep', 'd'), null);
  assert.strictEqual(onDisk(file).keep, null);
});

test('updateSettings: providers merge per provider and per field; "" clears a field', () => {
  const { s, file } = load({ providers: { openai: { apiKey: 'sk-openai-0000', url: 'http://o' } } });
  s.updateSettings({ providers: { openai: { apiKey: 'sk-openai-1111' }, google: { url: 'http://g' } } });
  const p = onDisk(file).providers;
  assert.deepStrictEqual(p.openai, { apiKey: 'sk-openai-1111', url: 'http://o' });   // url untouched
  assert.deepStrictEqual(p.google, { url: 'http://g' });
  s.updateSettings({ providers: { openai: { apiKey: '' } } });
  assert.strictEqual(s.getProviderKey('openai'), '', '"" falls through to env, which is unset');
  s.updateSettings({ providers: { openai: {} } });   // empty conf changes nothing
  assert.strictEqual(onDisk(file).providers.openai.url, 'http://o');
});

test('updateSettings consumes patch.providers (mutates the caller\'s object)', () => {
  const { s } = load();
  const patch = { providers: { openai: { apiKey: 'k' } }, x: 1 };
  s.updateSettings(patch);
  assert.ok(!('providers' in patch), 'providers is deleted from the patch');
  assert.strictEqual(patch.x, 1);
});

test('updateSettings: a null provider config removes that provider; a non-object config is ignored', () => {
  const { s, file } = load({ providers: { openai: { apiKey: 'k', url: 'http://o' }, google: { url: 'http://g' } } });
  assert.doesNotThrow(() => s.updateSettings({ providers: { openai: null, google: 'junk', ollama: null } }));
  assert.deepStrictEqual(onDisk(file).providers, { google: { url: 'http://g' } });
  assert.strictEqual(s.getProviderKey('openai'), '');
});

test('provider key: settings.json beats the env var, env beats nothing, unknown provider is ""', () => {
  process.env.ANTHROPIC_API_KEY = 'env-anthropic-key';
  const { s } = load({ providers: { openai: { apiKey: 'file-openai-key' } } });
  assert.strictEqual(s.getProviderKey('anthropic'), 'env-anthropic-key');
  s.updateSettings({ providers: { anthropic: { apiKey: 'file-anthropic-key' } } });
  assert.strictEqual(s.getProviderKey('anthropic'), 'file-anthropic-key');
  assert.strictEqual(s.getProviderKey('openai'), 'file-openai-key');
  assert.strictEqual(s.getProviderKey('google'), '');
  assert.strictEqual(s.getProviderKey('ollama'), '', 'local providers have no env key map');
  assert.strictEqual(s.getProviderKey('nope'), '');
});

test('provider url: settings > env (local providers only) > built-in default > ""', () => {
  process.env.LM_STUDIO_URL = 'http://lan:1234/v1';
  process.env.ANTHROPIC_API_KEY = 'x';
  const { s } = load({ providers: { ollama: { url: 'http://file:11434/v1' } } });
  assert.strictEqual(s.getProviderUrl('lmstudio'), 'http://lan:1234/v1');
  assert.strictEqual(s.getProviderUrl('ollama'), 'http://file:11434/v1');
  assert.strictEqual(s.getProviderUrl('omlx'), s.PROVIDER_DEFAULTS.omlx.url);
  assert.strictEqual(s.getProviderUrl('anthropic'), 'https://api.anthropic.com');
  assert.strictEqual(s.getProviderUrl('nope'), '');
  s.updateSettings({ providers: { lmstudio: { url: 'http://override/v1' } } });
  assert.strictEqual(s.getProviderUrl('lmstudio'), 'http://override/v1');
});

test('hasAnyApiKey: false with nothing, true for any one of the four hosted providers, not for local ones', () => {
  const { s } = load();
  assert.strictEqual(s.hasAnyApiKey(), false);
  s.updateSettings({ providers: { ollama: { apiKey: 'local' }, lmstudio: { apiKey: 'local' } } });
  assert.strictEqual(s.hasAnyApiKey(), false);
  for (const p of ['anthropic', 'openai', 'google', 'perplexity']) {
    const t = load();
    t.s.updateSettings({ providers: { [p]: { apiKey: 'k' } } });
    assert.strictEqual(t.s.hasAnyApiKey(), true, p);
  }
  process.env.GEMINI_API_KEY = 'from-env';
  assert.strictEqual(load().s.hasAnyApiKey(), true);
});

test('getForUI never returns a raw key: masked hint, hasKey flag, unknown providers dropped', () => {
  const longKey = 'sk-ant-api03-SECRETSECRETSECRET-wxyz';
  process.env.PERPLEXITY_API_KEY = 'pplx-env-SECRET-ENV-KEY';
  const { s } = load({ providers: { anthropic: { apiKey: longKey }, openai: { apiKey: 'short' }, custom: { apiKey: 'custom-SECRET-KEY' } }, theme: 'dark' });
  const ui = s.getForUI();
  assert.deepStrictEqual(ui.providers.anthropic, { hasKey: true, keyHint: 'sk-a...wxyz', url: 'https://api.anthropic.com', defaultUrl: 'https://api.anthropic.com' });
  assert.deepStrictEqual(ui.providers.openai.keyHint, '****', 'keys of 8 chars or fewer are fully masked');
  assert.strictEqual(ui.providers.google.hasKey, false);
  assert.strictEqual(ui.providers.google.keyHint, '');
  assert.strictEqual(ui.providers.perplexity.hasKey, true, 'env key counts');
  assert.deepStrictEqual(Object.keys(ui.providers).sort(), Object.keys(s.PROVIDER_DEFAULTS).sort());
  assert.strictEqual(ui.theme, 'dark', 'other settings pass through');
  const json = JSON.stringify(ui);
  for (const secret of ['SECRETSECRETSECRET', 'SECRET-ENV-KEY', 'custom-SECRET-KEY', 'apiKey']) assert.ok(!json.includes(secret), `leaked ${secret}`);
  assert.ok(s.get().providers.anthropic.apiKey === longKey, 'the stored key itself is untouched');
});

test('globals bridge: updateSettings refreshes the legacy global.__* flags with their defaults', () => {
  const { s } = load();
  assert.strictEqual(global.__lazyToolsEnabled, true, 'lazyTools defaults on');
  assert.strictEqual(global.__cavemanMode, false);
  assert.strictEqual(global.__maxCompletionTokens, 32000);
  assert.strictEqual(global.__maxContextMessages, 40);
  s.updateSettings({ cavemanMode: true, prescanTools: 1, confirmTools: true, lazyTools: false, maxCompletionTokens: 1000, maxContextMessages: 7 });
  assert.deepStrictEqual([global.__cavemanMode, global.__prescanToolsEnabled, global.__confirmToolsEnabled, global.__lazyToolsEnabled], [true, true, true, false]);
  assert.deepStrictEqual([global.__maxCompletionTokens, global.__maxContextMessages], [1000, 7]);
  s.updateSettings({ maxCompletionTokens: 0 });
  assert.strictEqual(global.__maxCompletionTokens, 32000, '0 falls back to the default');
});

test('a hand edit of settings.json is picked up and survives the next save from the hub', () => {
  const { s, file } = load({ cavemanMode: false, providers: {} });
  assert.strictEqual(s.getSetting('walletAgents'), undefined);
  const hand = { ...onDisk(file), walletAgents: ['trader'], walletOwner: { address: '0x1111111111111111111111111111111111111111', label: 'owner.eth' } };
  fs.writeFileSync(file, JSON.stringify(hand, null, 2));
  const t = Date.now() / 1000 + 5; fs.utimesSync(file, t, t);   // a distinct mtime even on coarse clocks
  const log = console.log; console.log = () => {};
  try {
    assert.deepStrictEqual(s.getSetting('walletAgents'), ['trader'], 'read from disk, no restart');
    s.updateSettings({ cavemanMode: true });
  } finally { console.log = log; }
  const after = onDisk(file);
  assert.deepStrictEqual(after.walletAgents, ['trader'], 'the save keeps the hand edit');
  assert.strictEqual(after.walletOwner.label, 'owner.eth');
  assert.strictEqual(after.cavemanMode, true);
});

test('a half-written settings.json during a hand edit keeps the loaded settings instead of wiping them', () => {
  const { s, file } = load({ name: 'kept', providers: {} });
  assert.strictEqual(s.getSetting('name'), 'kept');
  fs.writeFileSync(file, '{ "name": ');
  const t = Date.now() / 1000 + 5; fs.utimesSync(file, t, t);
  const warn = console.warn; let warned = 0; console.warn = () => { warned++; };
  try {
    assert.strictEqual(s.getSetting('name'), 'kept');
    assert.strictEqual(s.getSetting('name'), 'kept');
  } finally { console.warn = warn; }
  assert.strictEqual(warned, 1, 'warned once, not on every read');
});
