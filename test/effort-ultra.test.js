'use strict';
// Codex "Ultra": max reasoning with parallel helpers. Sent only to a Codex model whose catalog lists it, only on an
// admin's (or the hub's own) turn, with one fallback to Max when Codex refuses it. Never from Simple, never to other routes.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function fresh() { delete require.cache[require.resolve('../lib/effort.js')]; return require('../lib/effort.js'); }
const CATALOG = [
  { id: 'gpt-6-astra', levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { id: 'gpt-6-luna', levels: ['low', 'medium', 'high', 'xhigh', 'max'] },
];

test('ultra is a hub level and normalizes', () => {
  const e = fresh();
  assert.strictEqual(e.LEVELS[e.LEVELS.length - 1], 'ultra');
  assert.strictEqual(e.LABELS.ultra, 'Ultra');
  assert.strictEqual(e.normalize('ULTRA'), 'ultra');
});

test('Codex: ultra only for catalog-listed models; Luna and no catalog data get max / xhigh', () => {
  const e = fresh();
  assert.strictEqual(e.forModel('codex-cli/gpt-6-astra', 'ultra'), 'max', 'no catalog read yet: the family rule');
  e.setCodexLevels(CATALOG);
  assert.strictEqual(e.forModel('codex-cli/gpt-6-astra', 'ultra'), 'ultra');
  assert.strictEqual(e.forModel('codex-cli/gpt-6-astra', 'max'), 'max');
  assert.strictEqual(e.forModel('codex-cli/gpt-6-luna', 'ultra'), 'max', 'catalog without ultra');
  assert.strictEqual(e.forModel('codex-cli/gpt-5.5-codex', 'ultra'), 'xhigh', 'no catalog data, GPT-5.5 family');
  assert.strictEqual(e.forModel('codex-cli/gpt-6-sol', 'ultra'), 'max', 'no catalog data, GPT-6 family');
  e.setCodexLevels([{ id: 'gpt-old', levels: ['medium', 'high', 'ultra'] }]);
  assert.strictEqual(e.forModel('codex-cli/gpt-old', 'ultra'), 'ultra');
  e.setCodexLevels([{ id: 'gpt-old', levels: ['medium', 'high'] }]);
  assert.strictEqual(e.forModel('codex-cli/gpt-old', 'ultra'), 'high', 'a model with a lower top: fit');
});

test('ultra never reaches another route', () => {
  const e = fresh();
  e.setCodexLevels(CATALOG);
  assert.strictEqual(e.forModel('claude-sdk/claude-opus-5-5', 'ultra'), 'max');
  assert.strictEqual(e.forModel('anthropic/claude-sonnet-5-5', 'ultra'), 'max');
  assert.strictEqual(e.forModel('openai/gpt-6-astra', 'ultra'), 'max', 'OpenAI API: its top');
  assert.strictEqual(e.forModel('openai/gpt-5.5', 'ultra'), 'xhigh');
  assert.strictEqual(e.forModel('openai/gpt-5.5-pro', 'ultra'), 'xhigh');
  assert.strictEqual(e.forModel('google/gemini-flash-latest', 'ultra'), 'high');
  assert.strictEqual(e.forModel('ninfer/qwen3.8-27b', 'ultra'), null);
  assert.strictEqual(e.forModel('openai/gpt-4.1', 'ultra'), null);
  // the same agent level on every other model of the list, whatever the catalog says
  for (const m of ['claude-sdk/claude-opus-5-5', 'anthropic/claude-sonnet-5-5', 'openai/gpt-6-astra', 'google/gemini-flash-latest', 'codex-cli/gpt-6-luna']) {
    assert.notStrictEqual(e.forModel(m, 'ultra'), 'ultra', m);
  }
});

test('ultraFor: true only for a codex-cli model whose catalog lists ultra', () => {
  const e = fresh();
  assert.strictEqual(e.ultraFor('codex-cli/gpt-6-astra'), false, 'no catalog yet');
  e.setCodexLevels(CATALOG);
  assert.strictEqual(e.ultraFor('codex-cli/gpt-6-astra'), true);
  assert.strictEqual(e.ultraFor('codex-cli/GPT-6-Astra'), true, 'case-blind');
  assert.strictEqual(e.ultraFor('codex-cli/gpt-6-luna'), false);
  assert.strictEqual(e.ultraFor('openai/gpt-6-astra'), false, 'same name on the API route');
  assert.strictEqual(e.ultraFor('claude-sdk/claude-opus-5-5'), false);
  assert.strictEqual(e.ultraFor(''), false);
  assert.strictEqual(e.ultraFor(undefined), false);
});

test('a single turn can never ask for ultra', () => {
  const e = fresh();
  e.setCodexLevels(CATALOG);
  assert.deepStrictEqual(e.TURN_LEVELS, ['low', 'medium', 'high', 'max']);
  assert.strictEqual(e.requestedLevel('ultra'), null);
  assert.strictEqual(e.forTurn('codex-cli/gpt-6-astra', 'ultra', 'high'), 'high', 'ignored: the agent\'s level');
  assert.strictEqual(e.forTurn('codex-cli/gpt-6-astra', 'max', 'ultra'), 'max', 'a Simple pick replaces the agent\'s Ultra');
  assert.strictEqual(e.forTurn('codex-cli/gpt-6-astra', undefined, 'ultra'), 'ultra', 'hub-started turn: the agent\'s level');
});

test('agent field: ultra is accepted, the error text names it, members cannot change effort', () => {
  const agents = read('lib/agents.js');
  assert.match(agents, /require\('\.\/effort'\)\.LEVELS\.includes\(v\)/);
  assert.match(agents, /effort must be default, low, medium, high, xhigh, max or ultra/);
  const server = read('server.js');
  const m = server.match(/const MEMBER_EDITABLE = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'MEMBER_EDITABLE found');
  assert.ok(!/effort/.test(m[1]), 'effort is not member-editable');
});

test('members never send Ultra: the server passes admin, the turn marks memberTurn, Codex maps ultra to max', () => {
  const server = read('server.js');
  assert.match(server, /return handleChatStream\(body, res, \{ userId: [^\n]*accounts: hubAuth\.hasUsers\(\), admin: access\.isAdmin\(req\.hubUser\) \}\);/);
  const chat = read('lib/sdk-chat.js');
  assert.match(chat, /const trustedAdmin = !!\(ctx && typeof ctx === 'object' && ctx\.admin === true\);/);
  assert.match(chat, /memberTurn: !!\(trustedUserId && !trustedAdmin\),/);
  assert.match(chat, /if \(codexEffort === 'ultra' && options\.memberTurn\) codexEffort = 'max';/);
  assert.match(chat, /let codexEffort = options/);
});

test('fallback decision: only Ultra, before any output, once, on a refusal-looking error', () => {
  const { codexUltraFallback: f } = require('../lib/sdk-chat.js');
  const base = { effort: 'ultra', sawOutput: false, already: false };
  for (const error of ['unsupported value: ultra', 'Invalid value for reasoning_effort', 'model does not support this reasoning effort', 'Ultra is not available for your plan', 'not allowed', 'unsupported', 'invalid value']) {
    assert.strictEqual(f({ ...base, error }), true, error);
  }
  assert.strictEqual(f({ ...base, error: 'connection reset by peer' }), false, 'an unrelated failure is not an Ultra refusal');
  assert.strictEqual(f({ ...base, error: '' }), false);
  assert.strictEqual(f({ ...base }), false);
  assert.strictEqual(f({ ...base, error: 'ultra refused', effort: 'max' }), false, 'only for Ultra');
  assert.strictEqual(f({ ...base, error: 'ultra refused', sawOutput: true }), false, 'not after output');
  assert.strictEqual(f({ ...base, error: 'ultra refused', already: true }), false, 'one fallback per turn');
  assert.strictEqual(f(), false);
});

test('fallback wiring: both branches retry the round once at Max with the notice', () => {
  const chat = read('lib/sdk-chat.js');
  assert.match(chat, /Ultra isn't available for this account or model, so this answer uses Max\.\\n\\n/);
  assert.match(chat, /Ultra refused \(\$\{String\(why \|\| ''\)\.slice\(0, 160\)\}\); answering at Max/);
  assert.match(chat, /\(r\.status === 'failed' \|\| rs\.turnError\) && codexUltraFallback\(\{ effort: codexEffort, sawOutput: rs\.sawOutput, error: rs\.turnError \|\| r\.error, already: ultraFellBack \}\)/);
  assert.match(chat, /\(result\.code !== 0 \|\| rs\.turnError\) && codexUltraFallback\(\{ effort: codexEffort, sawOutput: rs\.sawOutput, error: rs\.turnError \|\| result\.stderrTail, already: ultraFellBack \}\)/);
  assert.strictEqual((chat.match(/ultraFellBack = startUltraFallback\(/g) || []).length, 2);
  assert.strictEqual((chat.match(/round--;\n\s+continue;/g) || []).length, 1, 'app-server: the same round runs again');
  assert.match(chat, /session\.close\(\); session = null;\n\s+round--;/, 'app-server: the retry runs on codex exec');
  // exec: retried in place at Max, BEFORE the resume check (a refusal must not throw away the stored thread)
  const fb = chat.indexOf('result = await runOnce();   // runOnce builds its arguments now, so it asks for Max');
  const resume = chat.indexOf("A stored thread that no longer resumes (deleted, other machine): start fresh once.", chat.indexOf('let result = await runOnce();'));
  assert.ok(fb > 0 && resume > fb, 'the Ultra fallback comes before the resume retry');
  assert.match(chat, /codexEffort = 'max';\n\s+console\.log\(`\[codex \$\{agentName\}\] Ultra refused/);
});

test('pickers: the Ultra option only with effortUltra; the agents list carries it; Simple has none', () => {
  const server = read('server.js');
  assert.match(server, /effortUltra: require\('\.\/lib\/effort'\)\.ultraFor\(a\.model\)/);
  const app = read('app.js'), mob = read('mobile.js');
  assert.match(app, /const EFFORT_ULTRA = \['ultra', 'Ultra \(uses several helpers; uses much more of the ChatGPT plan\)'\];/);
  assert.match(app, /a\.effortUltra === true/);
  assert.match(app, /\(effortUltraOf\(chat\) \? \[\.\.\.EFFORT_LEVELS, EFFORT_ULTRA\] : EFFORT_LEVELS\)/);
  assert.ok(!/\['max', 'Max effort'\], \['ultra'/.test(app), 'not in the fixed list');
  assert.match(app, /l === 'ultra' && !effortUltraOf\(chat\) \? 'max' : l/, 'a stored Ultra the model lost shows as Max');
  assert.match(mob, /const ultraOk = a\.effortUltra === true;/);
  assert.match(mob, /\(ultraOk \? `<option value="ultra">\$\{esc\(EFFORT_ULTRA_OPTION\)\}<\/option>` : ''\)/);
  assert.match(mob, /a\.effort === 'ultra' && !ultraOk \? 'max'/);
  const simple = require('../lib/ui-simple.js');
  assert.strictEqual(simple.labelForAgentEffort('ultra'), 'Deepest');
  assert.ok(!simple.EFFORTS.some((x) => x.level === 'ultra'), 'Simple offers no Ultra');
});
