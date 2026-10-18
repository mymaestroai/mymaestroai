'use strict';
// Reasoning effort (lib/effort): one per-agent level, translated per route; admins set it, members cannot.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const effort = require('../lib/effort');
const log = console.log; console.log = () => {};
const gw = require('../lib/gateway-client');
console.log = log;
const codexCli = require('../lib/codex-cli');
const appServer = require('../lib/codex-cli/app-server');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('levels map to what each provider accepts (checked against the live APIs)', () => {
  assert.strictEqual(effort.normalize('HIGH'), 'high');
  assert.strictEqual(effort.normalize('turbo'), 'default');
  assert.strictEqual(effort.forModel('claude-sdk/claude-fable-5-1', 'max'), 'max');
  assert.strictEqual(effort.forModel('anthropic/claude-sonnet-5-5', 'xhigh'), 'xhigh');
  assert.strictEqual(effort.forModel('openai/gpt-5.5', 'max'), 'xhigh', 'OpenAI tops out at xhigh');
  assert.strictEqual(effort.forModel('codex-cli/gpt-6-astra', 'max'), 'xhigh');
  assert.strictEqual(effort.forModel('google/gemini-flash-latest', 'xhigh'), 'high', 'Gemini tops out at high');
  assert.strictEqual(effort.forModel('openai/gpt-4.1', 'high'), null, 'non-reasoning OpenAI models reject the field');
  assert.strictEqual(effort.forModel('ninfer/qwen3.8-27b', 'high'), null, 'local servers get nothing');
  assert.strictEqual(effort.forModel('claude-sdk/claude-opus-5-5', 'default'), null, 'default sends nothing');
  assert.strictEqual(effort.supported('lmstudio/x'), false);
  assert.strictEqual(effort.supported('openai/gpt-6-sol'), true);
});

test('gateway: Anthropic gets output_config.effort, OpenAI/Gemini reasoning_effort; nothing when not applicable', () => {
  assert.deepStrictEqual(gw.applyEffort({}, 'anthropic/claude-sonnet-5-5', 'high', 'anthropic'), { output_config: { effort: 'high' } });
  assert.deepStrictEqual(gw.applyEffort({}, 'openai/gpt-5.5', 'max', 'chat'), { reasoning_effort: 'xhigh' });
  assert.deepStrictEqual(gw.applyEffort({}, 'google/gemini-flash-latest', 'max', 'chat'), { reasoning_effort: 'high' });
  assert.deepStrictEqual(gw.applyEffort({}, 'openai/gpt-4.1', 'high', 'chat'), {});
  assert.deepStrictEqual(gw.applyEffort({}, 'openai/gpt-5.5', 'default', 'chat'), {});
  assert.deepStrictEqual(require('../lib/openai-responses').toResponsesBody({ model: 'gpt-6', messages: [], reasoning_effort: 'xhigh' }).reasoning, { effort: 'xhigh', summary: 'auto' }, 'the Responses translation carries it');
});

test('Codex client: model_reasoning_effort on both transports', () => {
  const args = codexCli.buildArgs({ model: 'gpt-6-astra', cwd: '/tmp', sandbox: 'read-only', effort: 'high' });
  assert.ok(args.join(' ').includes('model_reasoning_effort="high"'));
  assert.ok(!codexCli.buildArgs({ model: 'gpt-6-astra', cwd: '/tmp', sandbox: 'read-only' }).join(' ').includes('model_reasoning_effort'));
  if (appServer.threadParams) {
    const p = appServer.threadParams({ model: 'gpt-6-astra', cwd: '/tmp', bridge: { file: '/x' }, effort: 'low' });
    assert.strictEqual(p.config.model_reasoning_effort, 'low');
    assert.ok(p.config.mcp_servers['agent-hub'], 'the hub bridge config is kept');
  }
});

test('wired: Claude client query option, gateway option, Codex; agent field validated; members cannot change it', () => {
  const chat = read('lib/sdk-chat.js');
  assert.match(chat, /const sdkEffort = effortLib\.forModel\(`claude-sdk\/\$\{sdkModel\}`, await agentEffort\(agentName\)\);/);
  assert.match(chat, /\.\.\.\(sdkEffort \? \{ effort: sdkEffort \} : \{\}\),/);
  assert.match(chat, /agent: agentName, effort: turnEffort \}/);
  assert.match(chat, /ephemeral: !!ephemeral, effort: codexEffort \}\);/);
  const agents = read('lib/agents.js');
  assert.match(agents, /effort: require\('\.\/effort'\)\.normalize\(a\.effort\)/);
  assert.match(agents, /'tools', 'effort'\];/);
  assert.match(agents, /effort must be default, low, medium, high, xhigh or max/);
  const server = read('server.js');
  assert.match(server, /const MEMBER_EDITABLE = new Set\(\['blurb', 'maxContextMessages', 'maxOutputTokens', 'contextBudget', 'compaction', 'minimalContext'\]\);/, 'effort is not member-editable');
  assert.match(server, /autoModel: !!a\.autoModel, effort: a\.effort \|\| 'default', changed:/);
});

test('pickers: desktop header next to the model (disabled for members), phone header, agent settings page', () => {
  const app = read('app.js'), idx = read('index.html'), mob = read('mobile.js'), mh = read('mobile.html'), as = read('agent-settings.html');
  assert.match(app, /esc\(billingDisplay\(chat\.model, true\)\)\}<\/option><\/select> \$\{effortPickHtml\(chat, chatId\)\}<span class="plan-badge"/, 'effort picker right after the model (then the plan usage badge)');
  assert.match(app, /\$\{isHubAdmin\(\) \? '' : ' disabled'\}/);
  assert.match(app, /method: 'PATCH', headers: \{ 'Content-Type': 'application\/json' \}, credentials: 'include', body: JSON\.stringify\(\{ effort: level \}\)/);
  assert.match(idx, /\.chat-actions \.effort-pick \{ max-width: 150px;/);
  assert.match(mh, /<select id="chat-effort-pick" aria-label="Reasoning effort"><\/select>/);
  assert.match(mob, /sel\.disabled = !isAdmin\(\);/);
  assert.match(mob, /\$\('chat-effort-pick'\)\?\.addEventListener\('change', changeEffortFromPick\);/);
  assert.match(as, /<select id="effort-mode" onchange="saveEffort\(\)"/);
});

test('OpenAI: an effort level with tools goes to /responses (chat/completions refuses the pair); otherwise the endpoint is kept', () => {
  const t = { api: 'chat', url: 'https://api.openai.com/v1/chat/completions' };
  assert.deepStrictEqual(gw.effortRoute(t, 'openai', { reasoning_effort: 'high', tools: [{}] }), { api: 'responses', url: 'https://api.openai.com/v1/responses' });
  assert.deepStrictEqual(gw.effortRoute(t, 'openai', { tools: [{}] }), { api: 'chat', url: t.url }, 'no effort: unchanged');
  assert.deepStrictEqual(gw.effortRoute(t, 'openai', { reasoning_effort: 'high' }), { api: 'chat', url: t.url }, 'no tools: unchanged');
  assert.deepStrictEqual(gw.effortRoute({ api: 'chat', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions' }, 'google', { reasoning_effort: 'high', tools: [{}] }).api, 'chat', 'Gemini accepts both on chat');
});
