'use strict';
// API keys still typed into .env move into Settings (lib/settings adoptEnvFileKeys). Each test copies settings.js
// into a throwaway hub dir and requires THAT copy, so it reads and writes tmp/data/settings.json and tmp/.env,
// never the real ones. The process environment passed in is a plain object, so nothing leaks between tests.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname, '..', 'lib', 'settings.js');
const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function hub({ settings, envText, envMode = 0o600 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-env-keys-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.copyFileSync(SRC, path.join(dir, 'lib', 'settings.js'));
  const file = path.join(dir, 'data', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (settings !== undefined) fs.writeFileSync(file, JSON.stringify(settings));
  const envFile = path.join(dir, '.env');
  if (envText !== undefined) fs.writeFileSync(envFile, envText, { mode: envMode });
  const log = console.log; console.log = () => {};
  try { return { s: require(path.join(dir, 'lib', 'settings.js')), file, envFile, dir }; } finally { console.log = log; }
}
const onDisk = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const NOW = new Date(2026, 9, 22, 9, 5, 7);   // local time: stamps read 20261022-090507

test('provider and web-search keys move from .env into settings; other lines stay; a copy of the old .env is kept', () => {
  const envText = 'PORT=9999\nOPENAI_API_KEY=sk-test-openai-not-real\n# a comment\nGEMINI_API_KEY=test-gemini-not-real\nGITHUB_TOKEN=test-gh-not-real\nSERPER_API_KEY=test-serper-not-real\nUSER_EMAIL=owner@example.com\n';
  const { s, file, envFile } = hub({ settings: { providers: {}, webSearch: { order: ['serper'] } }, envText });
  const env = { OPENAI_API_KEY: 'sk-test-openai-not-real', GEMINI_API_KEY: 'test-gemini-not-real', GITHUB_TOKEN: 'test-gh-not-real', PORT: '9999' };
  const r = s.adoptEnvFileKeys({ envFile, env, now: NOW });
  assert.strictEqual(r.error, null);
  assert.deepStrictEqual(r.moved.sort(), ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'SERPER_API_KEY']);
  const d = onDisk(file);
  assert.strictEqual(d.providers.openai.apiKey, 'sk-test-openai-not-real');
  assert.strictEqual(d.providers.google.apiKey, 'test-gemini-not-real');
  assert.strictEqual(d.webSearch.keys.serper, 'test-serper-not-real');
  assert.deepStrictEqual(d.webSearch.order, ['serper'], 'the rest of webSearch is kept');
  const after = fs.readFileSync(envFile, 'utf8');
  assert.ok(!/^OPENAI_API_KEY=/m.test(after) && !/^GEMINI_API_KEY=/m.test(after) && !/^SERPER_API_KEY=/m.test(after));
  assert.match(after, /^# OPENAI_API_KEY is kept in Settings \(data\/settings\.json\) since 2026-10-22; change it in Settings → AI models → LLM Providers\.$/m);
  assert.match(after, /^# SERPER_API_KEY is kept in Settings .*Web search\.$/m);
  for (const keep of ['PORT=9999', '# a comment', 'GITHUB_TOKEN=test-gh-not-real', 'USER_EMAIL=owner@example.com']) assert.ok(after.includes(keep), keep);
  assert.strictEqual(after.split('\n').length, envText.split('\n').length, 'one line out, one comment in');
  assert.strictEqual(path.basename(r.backup), '.env.bak-20261022-090507');
  assert.strictEqual(fs.readFileSync(r.backup, 'utf8'), envText);
  assert.strictEqual(fs.statSync(r.backup).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(envFile).mode & 0o777, 0o600, '.env stays owner-only');
  assert.ok(!('OPENAI_API_KEY' in env) && !('GEMINI_API_KEY' in env), 'moved keys leave the environment');
  assert.strictEqual(env.GITHUB_TOKEN, 'test-gh-not-real', 'other variables stay');
  assert.strictEqual(s.getProviderKey('openai'), 'sk-test-openai-not-real');
  assert.strictEqual(s.keySource('openai'), 'settings');
});

test('a key Settings already has: same value is just removed from .env, a different one is noted as unused', () => {
  const envText = 'OPENAI_API_KEY=sk-same-not-real\nGEMINI_API_KEY=old-gemini-not-real\n';
  const { s, file, envFile } = hub({ settings: { providers: { openai: { apiKey: 'sk-same-not-real' }, google: { apiKey: 'new-gemini-not-real' } } }, envText });
  const r = s.adoptEnvFileKeys({ envFile, env: {}, now: NOW });
  assert.deepStrictEqual(r.moved, []);
  assert.deepStrictEqual(r.duplicates, ['OPENAI_API_KEY']);
  assert.deepStrictEqual(r.unused, ['GEMINI_API_KEY']);
  assert.strictEqual(onDisk(file).providers.google.apiKey, 'new-gemini-not-real', 'the key in use is not touched');
  const after = fs.readFileSync(envFile, 'utf8');
  assert.match(after, /^# GEMINI_API_KEY removed from here on 2026-10-22: Settings has a different key for this, and that is the one in use\. The old line is in \.env\.bak-20261022-090507\.$/m);
  assert.ok(fs.readFileSync(r.backup, 'utf8').includes('GEMINI_API_KEY=old-gemini-not-real'), 'the old value stays in the copy');
});

test('nothing to do: no .env, no key lines, empty values, comments and export lines are left alone, no copy is made', () => {
  const none = hub({ settings: {} });
  assert.deepStrictEqual(none.s.adoptEnvFileKeys({ envFile: none.envFile, env: {} }).moved, []);
  const envText = 'OPENAI_API_KEY=\n# ANTHROPIC_API_KEY=sk-commented-not-real\nexport GEMINI_API_KEY=not-loaded-by-the-hub\nPORT=1\n';
  const { s, envFile, dir } = hub({ settings: {}, envText });
  const r = s.adoptEnvFileKeys({ envFile, env: {}, now: NOW });
  assert.deepStrictEqual([r.moved, r.duplicates, r.unused, r.backup], [[], [], [], null]);
  assert.strictEqual(fs.readFileSync(envFile, 'utf8'), envText);
  assert.deepStrictEqual(fs.readdirSync(dir).filter(f => f.startsWith('.env.bak')), []);
});

test('HUB_KEEP_ENV_KEYS keeps keys in .env', () => {
  const envText = 'OPENAI_API_KEY=sk-keep-not-real\n';
  const { s, file, envFile } = hub({ settings: {}, envText });
  const r = s.adoptEnvFileKeys({ envFile, env: { HUB_KEEP_ENV_KEYS: '1', OPENAI_API_KEY: 'sk-keep-not-real' }, now: NOW });
  assert.strictEqual(r.kept, true);
  assert.strictEqual(fs.readFileSync(envFile, 'utf8'), envText);
  assert.strictEqual(onDisk(file).providers?.openai, undefined);
});

test('runs once: a second start finds nothing and makes no second copy', () => {
  const { s, envFile, dir } = hub({ settings: {}, envText: 'PERPLEXITY_API_KEY=pplx-test-not-real\n' });
  assert.deepStrictEqual(s.adoptEnvFileKeys({ envFile, env: {}, now: NOW }).moved, ['PERPLEXITY_API_KEY']);
  const again = s.adoptEnvFileKeys({ envFile, env: {}, now: new Date(2026, 9, 22, 9, 6, 0) });
  assert.deepStrictEqual([again.moved, again.duplicates, again.unused, again.backup], [[], [], [], null]);
  assert.strictEqual(fs.readdirSync(dir).filter(f => f.startsWith('.env.bak')).length, 1);
});

test('the same variable twice: the last line wins, as when the hub loads .env, and both lines go', () => {
  const { s, file, envFile } = hub({ settings: {}, envText: 'OPENAI_API_KEY=sk-first-not-real\nPORT=2\nOPENAI_API_KEY=sk-second-not-real\n' });
  s.adoptEnvFileKeys({ envFile, env: {}, now: NOW });
  assert.strictEqual(onDisk(file).providers.openai.apiKey, 'sk-second-not-real');
  const after = fs.readFileSync(envFile, 'utf8');
  assert.ok(!/^OPENAI_API_KEY=/m.test(after) && after.includes('PORT=2'));
  assert.match(after, /^# \(an earlier OPENAI_API_KEY line was here\)$/m);
});

test('a key that could not be saved leaves .env exactly as it was', () => {
  const envText = 'OPENAI_API_KEY=sk-unsaved-not-real\n';
  const { s, file, envFile } = hub({ settings: {}, envText });
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  fs.writeFileSync(path.dirname(file), 'a file where the data folder should be');   // settings.json cannot be written
  const err = console.error; console.error = () => {};
  let r;
  try { r = s.adoptEnvFileKeys({ envFile, env: {}, now: NOW }); } finally { console.error = err; }
  assert.match(r.error, /OPENAI_API_KEY could not be saved/);
  assert.strictEqual(fs.readFileSync(envFile, 'utf8'), envText);
  assert.strictEqual(r.backup, null);
});

test('keySource and the masked view say where a key comes from', () => {
  const { s } = hub({ settings: { providers: { anthropic: { apiKey: 'sk-ant-test-not-real' } } } });
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-env-test-not-real';
  try {
    assert.strictEqual(s.keySource('anthropic'), 'settings');
    assert.strictEqual(s.keySource('openai'), 'environment');
    assert.strictEqual(s.keySource('perplexity'), process.env.PERPLEXITY_API_KEY ? 'environment' : '');
    const ui = s.getForUI();
    assert.strictEqual(ui.providers.anthropic.keySource, 'settings');
    assert.strictEqual(ui.providers.openai.keySource, 'environment');
    assert.ok(!JSON.stringify(ui).includes('sk-env-test-not-real') && !JSON.stringify(ui).includes('sk-ant-test-not-real'), 'keys stay masked');
  } finally { if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved; }
});

test('the web-search names match the ones lib/web-search.js reads', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'web-search.js'), 'utf8');
  const { s } = hub({ settings: {} });
  for (const [id, name] of Object.entries(s.SEARCH_ENV_KEY_MAP)) assert.match(src, new RegExp(`${id}: '${name}'`));
});

test('a quoted key is saved without its quotes, and leaves the environment it was loaded into', () => {
  const { s, file, envFile } = hub({ settings: {}, envText: 'OPENAI_API_KEY="sk-quoted-not-real"\nGEMINI_API_KEY=\'gemini-quoted-not-real\'\n' });
  const env = { OPENAI_API_KEY: '"sk-quoted-not-real"', GEMINI_API_KEY: "'gemini-quoted-not-real'" };   // server.js keeps the quotes
  s.adoptEnvFileKeys({ envFile, env, now: NOW });
  const d = onDisk(file);
  assert.strictEqual(d.providers.openai.apiKey, 'sk-quoted-not-real');
  assert.strictEqual(d.providers.google.apiKey, 'gemini-quoted-not-real');
  assert.ok(!('OPENAI_API_KEY' in env) && !('GEMINI_API_KEY' in env));
});

test('the rewritten .env is owner-only even when it was not', () => {
  const { s, envFile } = hub({ settings: {}, envText: 'OPENAI_API_KEY=sk-mode-not-real\nGITHUB_TOKEN=test-gh-not-real\n', envMode: 0o644 });
  fs.chmodSync(envFile, 0o644);
  s.adoptEnvFileKeys({ envFile, env: {}, now: NOW });
  assert.strictEqual(fs.statSync(envFile).mode & 0o777, 0o600);
});
