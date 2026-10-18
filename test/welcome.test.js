'use strict';
// First-run setup (lib/welcome): the one-time setup code, "is there a way to think?", the provider checks behind the
// Welcome page, the version ranking, and the plain-language Claude sign-in fix (lib/claude-auth).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWelcome, versionScore } = require('../lib/welcome');
const claudeAuth = require('../lib/claude-auth');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'welcome-')); }
function fakeSettings(init = {}) {
  const s = { providers: {}, ...init };
  return {
    get: () => s,
    hasAnyApiKey: () => Object.values(s.providers).some(p => p && p.apiKey),
    getProviderKey: (p) => (s.providers[p] && s.providers[p].apiKey) || '',
    getProviderUrl: (p) => (s.providers[p] && s.providers[p].url) || { local: 'http://127.0.0.1:18080/v1', lmstudio: 'http://localhost:1234/v1', ollama: 'http://localhost:11434/v1' }[p] || '',
    updateSettings: (patch) => { if (patch.providers) for (const [k, v] of Object.entries(patch.providers)) s.providers[k] = { ...(s.providers[k] || {}), ...v }; for (const [k, v] of Object.entries(patch)) if (k !== 'providers') s[k] = v; },
    _s: s,
  };
}
const noClaude = { hasSdkCredentials: () => false };
const json = (status, body) => async () => ({ status, json: async () => body });

test('the setup code: created once (0600), checked in constant time, cleared after the first account; env override', () => {
  const dir = tmp();
  const w = createWelcome({ dataDir: dir, env: {}, settings: fakeSettings(), claudeAuth: noClaude });
  const code = w.ensureSetupToken();
  assert.match(code, /^[A-Za-z0-9_-]{32}$/);
  assert.strictEqual(w.ensureSetupToken(), code, 'stable until used');
  assert.strictEqual(fs.statSync(path.join(dir, 'setup-token')).mode & 0o777, 0o600);
  assert.ok(w.checkSetupToken(code));
  assert.ok(w.checkSetupToken(` ${code}\n`), 'surrounding blanks from a paste are fine');
  for (const bad of ['', null, undefined, code.slice(1), code + 'x', 'nope']) assert.ok(!w.checkSetupToken(bad), String(bad));
  w.clearSetupToken();
  assert.ok(!fs.existsSync(path.join(dir, 'setup-token')));
  assert.ok(!w.checkSetupToken(code), 'gone with the file');
  const w2 = createWelcome({ dataDir: dir, env: { HUB_SETUP_TOKEN: 'scripted-code-1234567890' }, settings: fakeSettings(), claudeAuth: noClaude });
  assert.ok(w2.checkSetupToken('scripted-code-1234567890') && w2.ensureSetupToken() === 'scripted-code-1234567890');
});

test('a way to think: an API key, the Claude client, or a local engine; an empty settings file is not one', () => {
  const dir = tmp();
  const s = fakeSettings();
  const w = createWelcome({ dataDir: dir, env: {}, settings: s, claudeAuth: noClaude });
  assert.strictEqual(w.hasProvider(), false);
  s._s.providers.openai = { apiKey: 'sk-x' }; assert.strictEqual(w.hasProvider(), true);
  delete s._s.providers.openai;
  assert.strictEqual(createWelcome({ dataDir: dir, env: {}, settings: s, claudeAuth: { hasSdkCredentials: () => true, hasSignIn: () => true } }).hasProvider(), true, 'signed in to Claude');
  assert.strictEqual(createWelcome({ dataDir: dir, env: {}, settings: s, claudeAuth: { hasSdkCredentials: () => true, hasSignIn: () => false } }).hasProvider(), false, 'Claude installed but signed out is not a way to think');
  assert.strictEqual(createWelcome({ dataDir: dir, env: { OLLAMA_URL: 'http://x' }, settings: s, claudeAuth: noClaude }).hasProvider(), true);
  fs.writeFileSync(path.join(dir, 'local-models.json'), JSON.stringify({ enabled: true }));
  assert.strictEqual(w.hasProvider(), true, 'the Local models proxy, switched on');
});

test('an API key is proven by listing models (no tokens spent), saved only when it works, and a sensible default is suggested', async () => {
  const s = fakeSettings();
  const bad = createWelcome({ dataDir: tmp(), env: {}, settings: s, claudeAuth: noClaude, fetch: json(401, { error: { message: 'invalid x-api-key' } }) });
  const r1 = await bad.connectApiKey('anthropic', 'sk-ant-api03-' + 'x'.repeat(40));
  assert.strictEqual(r1.ok, false); assert.match(r1.error, /refused this key/); assert.strictEqual(s._s.providers.anthropic, undefined, 'a refused key is not saved');
  assert.match((await bad.connectApiKey('anthropic', 'short')).error, /does not look like a complete key/);
  assert.match((await bad.connectApiKey('perplexity', 'x'.repeat(30))).error, /Anthropic, OpenAI or Google/);
  const openai = createWelcome({ dataDir: tmp(), env: {}, settings: s, claudeAuth: noClaude, fetch: json(200, { data: [
    { id: 'gpt-4-0613' }, { id: 'text-embedding-3-large' }, { id: 'gpt-5.5' }, { id: 'gpt-5.5-mini' }, { id: 'gpt-6' }, { id: 'gpt-realtime' }, { id: 'gpt-5.4-2026-03-05' }, { id: 'tts-1' }] }) });
  const r2 = await openai.connectApiKey('openai', '  sk-proj-' + 'y'.repeat(40) + '\n');
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.suggested, 'openai/gpt-6', 'newest full model first');
  assert.ok(!r2.models.includes('openai/text-embedding-3-large') && !r2.models.includes('openai/tts-1') && !r2.models.includes('openai/gpt-realtime'), 'chat models only');
  assert.strictEqual(s._s.providers.openai.apiKey, 'sk-proj-' + 'y'.repeat(40), 'saved without the pasted blanks');
  assert.strictEqual(s._s.welcome.provider, 'openai');
  const google = createWelcome({ dataDir: tmp(), env: {}, settings: fakeSettings(), claudeAuth: noClaude, fetch: json(200, { data: [{ id: 'models/gemini-3.8-flash' }, { id: 'models/gemini-4-argon' }, { id: 'models/gemini-2.5-pro-preview-tts' }] }) });
  assert.strictEqual((await google.connectApiKey('google', 'AIza' + 'z'.repeat(35))).suggested, 'google/gemini-4-argon');
});

test('local engines: found with their models; using one records it so the hub counts it as configured', async () => {
  const s = fakeSettings();
  const fetch = async (url) => url.startsWith('http://localhost:11434') ? { status: 200, json: async () => ({ data: [{ id: 'llama3.3' }] }) } : (() => { throw new Error('ECONNREFUSED'); })();
  const w = createWelcome({ dataDir: tmp(), env: {}, settings: s, claudeAuth: noClaude, fetch });
  const found = await w.findLocal();
  assert.deepStrictEqual(found.map(e => [e.provider, e.models]), [['ollama', ['ollama/llama3.3']]]);
  assert.strictEqual(w.connectLocal('ollama', found[0].url).ok, true);
  assert.strictEqual(s._s.providers.ollama.url, 'http://localhost:11434/v1');
  assert.strictEqual(w.hasProvider(), true);
  assert.strictEqual(w.connectLocal('evil', 'http://x').ok, false);
});

test('the Claude check reads the client\'s own answer: signed out, limit, missing, network', async () => {
  const w = createWelcome({ dataDir: tmp(), env: {}, settings: fakeSettings(), claudeAuth: noClaude });
  assert.strictEqual(w.classifyClaude('Invalid API key · Please run /login').state, 'signed-out');
  assert.strictEqual(w.classifyClaude('Claude AI usage limit reached|1760000000').state, 'limit');
  assert.strictEqual(w.classifyClaude('spawn claude ENOENT').state, 'missing');
  assert.strictEqual(w.classifyClaude('getaddrinfo ENOTFOUND api.anthropic.com').state, 'network');
  let seen = null;
  const sdkOk = { loadSdk: async () => ({ query: ({ options }) => { seen = options; return (async function* () { yield { type: 'result', is_error: false, result: 'OK' }; })(); } }), cliOptions: () => ({}) };
  const ok = await createWelcome({ dataDir: tmp(), env: { ANTHROPIC_API_KEY: 'sk-should-be-stripped', PATH: '/bin' }, settings: fakeSettings(), claudeAuth: noClaude, sdkLoader: sdkOk }).checkClaude();
  assert.strictEqual(ok.ok, true);
  assert.ok(seen && !seen.env.ANTHROPIC_API_KEY && seen.env.PATH === '/bin', 'the subscription, never the API key');
  assert.deepStrictEqual([seen.model, seen.maxTurns, seen.tools], ['haiku', 1, []], 'one tiny question, no tools');
  const broken = await createWelcome({ dataDir: tmp(), env: {}, settings: fakeSettings(), claudeAuth: noClaude, sdkLoader: sdkOk, clientEnv: () => { throw new Error('boom'); } }).checkClaude();
  assert.strictEqual(broken.ok, false, 'a setup failure answers at once (no 90-second timer left behind)');
  const sdkOut = { loadSdk: async () => ({ query: () => (async function* () { yield { type: 'result', is_error: true, result: 'Invalid API key · Please run /login' }; })() }), cliOptions: () => ({}) };
  const out = await createWelcome({ dataDir: tmp(), env: {}, settings: fakeSettings(), claudeAuth: noClaude, sdkLoader: sdkOut }).checkClaude();
  assert.strictEqual(out.state, 'signed-out'); assert.match(out.error, /not signed in/);
});

test('version ranking ignores dates and snapshot numbers', () => {
  assert.ok(versionScore('gpt-6') > versionScore('gpt-5.6-sol'));
  assert.ok(versionScore('gpt-5.6-sol') > versionScore('gpt-5.5'));
  assert.ok(versionScore('claude-opus-5-5') > versionScore('claude-opus-5'));
  assert.strictEqual(versionScore('gpt-5.4-2026-03-05'), versionScore('gpt-5.4'));
  assert.strictEqual(versionScore('gpt-5-2025-08-07'), versionScore('gpt-5'), 'a date after a one-digit version (seen on the real OpenAI list)');
  assert.ok(versionScore('gpt-4-0613') < versionScore('gpt-5'));
  assert.ok(versionScore('gemini-4-argon') > versionScore('gemini-2.5-computer-use-preview-10-2025'));
});

test('a failed Claude turn caused by the sign-in gets the fix in plain words; other failures do not', () => {
  for (const t of ['Invalid API key · Please run /login', 'OAuth token has expired. Please obtain a new token or refresh your existing token.', 'authentication_error', 'Not logged in']) {
    assert.match(claudeAuth.signInFixText(t), /type `claude`[\s\S]*sign in[\s\S]*`\/exit`[\s\S]*No restart is needed/, t);
  }
  for (const t of ['API Error: 529 overloaded', 'Claude AI usage limit reached', 'context window exceeded', '']) assert.strictEqual(claudeAuth.signInFixText(t), '', t);
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.match(src, /signInFixText\(msg\.result\); if \(fix\) \{ sendSSE\(res, makeChunk\(fix, sdkModel\)\); fullResponse \+= fix; \}/, 'a failed result shows and keeps the fix');
  assert.match(src, /signInFixText\(err\.message\); if \(fix\) sendSSE\(res, makeChunk\(fix, sdkModel\)\);/, 'so does a crashed client');
});

test('server: the first account needs the setup code; the code is printed at start while no account exists', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /if \(!welcome\.checkSetupToken\(b\.setupToken\)\) return jsonResponse\(res, 403, \{ error: 'setup_code'/);
  assert.match(src, /welcome\.clearSetupToken\(\);\s*\n\s*welcome\.markStarted\(\);[^\n]*\n\s*finishSignIn\(hubAuth\.getUser\(r\.user\.id\), \{ totpOk: true \}\);/);
  assert.match(src, /First-time setup: http:\/\/localhost:\$\{PORT\}\/welcome\?token=\$\{code\}/);
  assert.match(src, /function isSetupNeeded\(\) \{[\s\S]*?if \(!hubAuth\.hasUsers\(\)\) return true;\s*\n\s*return !require\('\.\/lib\/welcome'\)\.getWelcome\(\)\.hasProvider\(\);/);
  assert.ok(!src.includes("'/api/setup/save'") && !src.includes("'/api/setup/test-gateway'"), 'the old wizard routes (one rewrote .env wholesale) are gone');
  for (const r of ["'/api/welcome/state'", "'/api/welcome/api-key'", "'/api/welcome/claude-check'", "'/api/welcome/local'"]) assert.ok(src.includes(r), r);
});

test('setup progress: started with the first account, finished at the first hello or a skip; kept 0600; never restarts', () => {
  const dir = tmp();
  const w = createWelcome({ dataDir: dir, env: {}, settings: fakeSettings(), claudeAuth: noClaude });
  assert.strictEqual(w.unfinished(), false, 'an install that never used the Welcome page (or an upgraded hub) is not "unfinished"');
  w.markStarted();
  const started = w.progress().startedAt;
  assert.ok(started && w.unfinished());
  assert.strictEqual(fs.statSync(w.progressFile).mode & 0o777, 0o600);
  w.markStarted();
  assert.strictEqual(w.progress().startedAt, started, 'a second start keeps the first time');
  w.markFinished('skip');
  assert.strictEqual(w.unfinished(), false);
  assert.strictEqual(w.progress().how, 'skip');
  w.markFinished('done');
  assert.strictEqual(w.progress().how, 'skip', 'the first finish is the one recorded');
  const w2 = createWelcome({ dataDir: tmp(), env: {}, settings: fakeSettings(), claudeAuth: noClaude });
  w2.markStarted(); w2.markFinished('anything else');
  assert.strictEqual(w2.progress().how, 'done');
});

test('resume: "/" sends an admin with unfinished setup back to /welcome; the page says how to get back and checks Claude on return', () => {
  const root = path.join(__dirname, '..');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.ok(server.includes("welcome.markStarted();   // \"/\" brings this admin back to /welcome until setup is finished or skipped"), 'started with the first account');
  assert.match(server, /if \(access\.isAdmin\(req\.hubUser\) && !req\.hubPendingTotp && require\('\.\/lib\/welcome'\)\.getWelcome\(\)\.unfinished\(\)\) \{\s*res\.writeHead\(302, \{ Location: '\/welcome' \}\);/, 'the redirect');
  assert.ok(server.includes("if (pathname === '/api/welcome/finish' && req.method === 'POST') {"), 'finish route');
  assert.ok(server.includes('out.unfinished = welcome.unfinished();'));
  const access = fs.readFileSync(path.join(root, 'lib', 'access.js'), 'utf8');
  assert.ok(!/'\/api\/welcome\/finish'/.test(access), 'finish is not public: admins only, like the other Welcome writes');

  const page = fs.readFileSync(path.join(root, 'welcome.html'), 'utf8');
  assert.ok(page.includes('<p class="resume" id="resume" hidden>Bookmark this page. If it gets closed or replaced, open <b class="origin">'), 'how to get back, on every setup step');
  assert.ok(page.includes("Claude's sign-in opens in your browser and may take over this page."), 'the warning in the Claude card');
  assert.ok(page.includes("window.addEventListener('pageshow', (e) => { if (e.persisted) route(); });"), 'Back after the sign-in: the hub decides the step');
  assert.match(page, /if \(leftForSignIn && claudeCardOpen\(\)\) \{ leftForSignIn = false; claudeCheck\(\); \}/, 'checks Claude by itself on return');
  assert.ok(page.includes("await finishSetup('done');   // the interview has started"), 'finished at the first answer');
  assert.ok((page.match(/data-skip/g) || []).length >= 3, 'skip on the AI and Meet steps (and its handler)');
  assert.ok(page.includes("if (state.unfinished === false) return show('s-done', 0);"), 'a finished setup shows "You\'re all set"');

  const installer = fs.readFileSync(path.join(root, 'install', 'install.sh'), 'utf8');
  assert.ok(installer.includes('shortcut is on your Desktop. If the setup page gets closed or replaced'), 'the installer says where to go back');
});

test('Claude counts as ready only when really signed in or a Welcome check passed; the summary still says it is on this computer', async () => {
  const dir = tmp();
  const signedOut = { hasSdkCredentials: () => true, hasSignIn: () => false };
  const w = createWelcome({ dataDir: dir, env: {}, settings: fakeSettings(), claudeAuth: signedOut });
  assert.strictEqual(w.claudeReady(), false);
  assert.deepStrictEqual([w.providerSummary().claude, w.providerSummary().claudeReady], [true, false], 'the card opens (and checks) because Claude Code is here');
  const sdk = { query: () => (async function* () { yield { type: 'result', is_error: false, result: 'OK' }; })() };
  const w2 = createWelcome({ dataDir: dir, env: {}, settings: fakeSettings(), claudeAuth: signedOut, sdkLoader: { loadSdk: async () => sdk, cliOptions: () => ({}) }, clientEnv: (e) => e });
  const r = await w2.checkClaude({ timeoutMs: 5000 });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.ok(w2.progress().claudeOkAt, 'a passed check is remembered');
  assert.strictEqual(w2.claudeReady(), true);
  assert.strictEqual(w2.hasProvider(), true);
  assert.strictEqual(w2.providerSummary().local, false, 'a Claude check is not a local engine');
  const before = createWelcome({ dataDir: tmp(), env: {}, settings: fakeSettings({ welcome: { provider: 'claude', at: 'x' } }), claudeAuth: signedOut });
  assert.deepStrictEqual([before.claudeReady(), before.localConfigured(), before.hasProvider()], [true, false, true], 'a check that passed before this update still counts');
  const proxy = createWelcome({ dataDir: tmp(), env: {}, settings: fakeSettings({ welcome: { provider: 'local', at: 'x' } }), claudeAuth: signedOut });
  assert.deepStrictEqual([proxy.claudeReady(), proxy.localConfigured()], [false, true], 'the hub\'s own proxy, connected on the Welcome page, is a local engine');
});

test('the Welcome page checks Claude by itself when Claude Code is found (no Check press needed)', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'welcome.html'), 'utf8');
  assert.match(page, /if \(p\.claude\) \{[\s\S]{0,400}claudeCheck\('Claude Code is on this computer: checking that it is signed in…'\);/);
  assert.ok(page.includes("$('claude-check').addEventListener('click', () => claudeCheck());"), 'the button passes no event as the message');
  assert.ok(!page.includes('Press Check to confirm it is signed in'), 'the old "press Check" note is gone');
  assert.ok(page.includes("say('claude-msg', adviceText(res, 'Claude did not answer.')") && page.includes("say('key-msg', adviceText(res, 'The key did not work.')"), 'a failed check shows the advice, the raw text under Details');
  assert.match(page, /function adviceText\(res, fallback\) \{ return \(res\.body && \(res\.body\.error \|\| res\.body\.detail\)\) \|\| fallback; \}/);
});
