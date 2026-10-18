'use strict';
// Who pays for a model (lib/billing): subscription vs API credits vs local by id prefix; the Claude client never
// receives the Anthropic API key; pickers and the agent list say which is which.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const B = require('../lib/billing');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('billingOf by prefix', () => {
  assert.deepStrictEqual(B.billingOf('claude-sdk/claude-fable-5-1'), { kind: 'subscription', via: 'Claude sign-in', label: 'subscription', long: B.KINDS.subscription.long, vendor: 'Anthropic', route: 'Subscription', name: 'claude-fable-5-1', display: 'claude-fable-5-1 · Subscription (Claude sign-in)', short: 'claude-fable-5-1 · Subscription' });
  assert.strictEqual(B.billingOf('anthropic/claude-opus-5-5').display, 'claude-opus-5-5 · API');
  assert.strictEqual(B.billingOf('anthropic/claude-opus-5-5').short, 'claude-opus-5-5 · API $');
  assert.strictEqual(B.billingOf('codex-cli/gpt-6-astra').display, 'gpt-6-astra · Subscription (ChatGPT)');
  assert.strictEqual(B.billingOf('ninfer/qwen3.8-27b').display, 'qwen3.8-27b · Local (ninfer)');
  assert.strictEqual(B.billingOf('ninfer/qwen3.8-27b').short, 'qwen3.8-27b · Local');
  assert.deepStrictEqual(['claude-sdk/x', 'anthropic/x', 'openai/x', 'codex-cli/x', 'google/x', 'ninfer/x', 'foo/x'].map(m => B.billingOf(m).vendor), ['Anthropic', 'Anthropic', 'OpenAI', 'OpenAI', 'Google', 'Local', 'Foo']);
  assert.deepStrictEqual(['Anthropic', 'Local', 'Foo'].map(B.vendorRank), [0, 4, 5]);
  assert.strictEqual(B.billingOf('codex-cli/gpt-6-astra').via, 'ChatGPT');
  assert.strictEqual(B.billingOf('codex/gpt-5.5').kind, 'subscription');
  assert.deepStrictEqual([B.billingOf('anthropic/claude-opus-5-5').kind, B.billingOf('openai/gpt-5.6-sol').kind, B.billingOf('google/gemini-pro-latest').kind, B.billingOf('perplexity/sonar').kind], ['api', 'api', 'api', 'api']);
  assert.strictEqual(B.billingOf('anthropic/claude-opus-5-5').via, 'anthropic API key');
  assert.strictEqual(B.billingOf('ninfer/qwen3.8-27b').kind, 'local');
  assert.strictEqual(B.billingOf('lmstudio/x').label, 'local');
  assert.strictEqual(B.billingOf('mystery/x').kind, 'unknown');
  assert.strictEqual(B.billingOf('').kind, 'unknown');
  assert.strictEqual(B.groupLabel('claude-sdk'), 'claude-sdk · subscription (Claude sign-in)');
  assert.strictEqual(B.groupLabel('anthropic'), 'anthropic · API credits');
});

test('clientEnvWithoutApiKey strips only the Anthropic key and token', () => {
  const env = B.clientEnvWithoutApiKey({ PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant', ANTHROPIC_AUTH_TOKEN: 't', OPENAI_API_KEY: 'sk-o', HOME: '/h' });
  assert.deepStrictEqual(env, { PATH: '/bin', OPENAI_API_KEY: 'sk-o', HOME: '/h' });
});

test('wiring: the Claude client env has no API key; /api/models carries billing; pickers and the agent list label it', () => {
  const sdk = read('lib/sdk-chat.js');
  assert.match(sdk, /: \{ \.\.\.require\('\.\/billing'\)\.clientEnvWithoutApiKey\(process\.env\), CLAUDE_CODE_AUTO_COMPACT_WINDOW: String\(autoCompactWindow\) \},/);
  const server = read('server.js');
  assert.match(server, /billing\[m\] = require\('\.\/lib\/billing'\)\.billingOf\(m\);/);
  assert.match(server, /billing,\s+\/\/ \{ modelId: \{ kind/);
  const app = read('app.js');
  assert.match(app, /function billingDisplay\(model, compact = false\)[\s\S]*'Subscription \(Claude sign-in\)'[\s\S]*'API \$'[\s\S]*`Local \(\$\{p\}\)`/, 'the page can say the route from the id alone');
  assert.match(app, /return `\$\{name\} · \$\{compact \? short : full\}`;/, 'model first');
  assert.match(app, /rank: vendorRank\(v\) \* 10 \+ ROUTE_ORDER\.indexOf\(r\)[\s\S]*function groupModels\(models\)/, 'groups are vendor + route, in a fixed order');
  assert.match(app, /for \(const \[label, rows\] of groupModels\(models\)\) \{\s*\n\s*html \+= `<optgroup label="\$\{esc\(label\)\}">/, 'chat header picker uses the groups');
  assert.match(app, /\(billing\[m\] && billing\[m\]\.short\) \|\| billingDisplay\(m, true\)/, 'header options are "model · route", compact');
  assert.match(app, /selected>\$\{chat\.autoModel \? 'Auto' : esc\(billingDisplay\(chat\.model, true\)\)\}<\/option>/, 'the header shows model then route before the list loads');
  assert.match(app, /class="cyber-tag billing-api" title="This agent runs on a provider API key/, 'agent list badge');
  assert.match(app, /sel\.innerHTML = groupModels\(models\)\.map\(\(\[label, rows\]\) =>/, 'create-agent select uses the same groups');
  const page = read('agent-settings.html');
  assert.match(page, /function billingDisplay\(modelId\)/);
  assert.match(page, /opt\.textContent = `✅ \$\{billingDisplay\(m\)\} \(\$\{health\.latency\}ms\)`;/);
  assert.match(page, /const FAMILY_ORDER = \['Anthropic · Subscription \(Claude sign-in\)', 'Anthropic · API \$', 'OpenAI · Subscription \(ChatGPT\)', 'OpenAI · API \$', 'Google · API \$', 'Perplexity · API \$', 'Local'\];/);
  assert.match(page, /return `\$\{vendor\} · \$\{route\}`;/, 'settings page families are vendor + route');
  assert.match(read('index.html'), /\.cyber-tag\.billing-api \{/);
});
