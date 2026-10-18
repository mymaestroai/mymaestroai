'use strict';
// Model health (lib/model-health): what the hub has seen each model do. Failures that belong to the model mark it in
// the pickers, the next success clears the mark, passing trouble leaves it alone; a tiny test request runs before an
// agent switches to a model the hub has not seen answer. Plus the spend log's true outcome for failed replies and the
// plain explanation reaching an agent that consulted a failing one.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createModelHealth, MARK } = require('../lib/model-health');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mh-')), 'model-health.json');
let clock = Date.parse('2026-10-18T12:00:00Z');
const now = () => clock;

test('a failure that belongs to the model marks it, the next success clears it, passing trouble leaves it alone', () => {
  const file = tmpFile(); const h = createModelHealth({ file, now });
  const M = 'openrouter/nvidia/nemotron-3.5-super-vl:free';
  assert.deepStrictEqual(h.view(), {});
  h.record(M, { ok: false, kind: 'privacy', what: 'blocked', fix: 'switch' });
  assert.deepStrictEqual(h.view()[M], { state: 'fail', kind: 'privacy', short: 'blocked by the privacy setting', what: 'blocked', fix: 'switch', at: '2026-10-18T12:00:00.000Z', source: 'reply' });
  h.record(M, { ok: false, kind: 'rate_limit' });
  assert.strictEqual(h.view()[M].kind, 'privacy', 'a rate limit says nothing about the model');
  h.record(M, { ok: false, kind: 'context' });
  assert.strictEqual(h.view()[M].kind, 'privacy', 'too long is about the conversation, not the model');
  clock += 1000; h.record(M, { ok: true });
  assert.deepStrictEqual(h.view()[M], { state: 'ok', at: '2026-10-18T12:00:01.000Z', okAt: '2026-10-18T12:00:01.000Z', source: 'reply' });
  clock += 1000; h.record(M, { ok: false, kind: 'credit', what: 'empty' });
  assert.strictEqual(h.view()[M].state, 'fail');
  assert.strictEqual(h.view()[M].okAt, '2026-10-18T12:00:01.000Z', 'when it last worked is kept');
  assert.strictEqual(h.record('x/y', { ok: false, kind: 'overloaded' }), null, 'no record is made for passing trouble');
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(disk[M].kind, 'credit', 'saved to the file');
  assert.strictEqual((fs.statSync(file).mode & 0o777).toString(8), '600');
  assert.ok(MARK.no_tool_call && MARK.local_down && MARK.auth);
});

// A stand-in for lib/gateway-client: chatCompletionStream answers what `reply` says, parseSSEStream yields its chunks.
function fakeGateway(reply) {
  const calls = [];
  return {
    calls,
    chatCompletionStream: async (messages, opts) => { calls.push({ messages, opts }); if (reply.throws) throw reply.throws; return { chunks: reply.chunks || [] }; },
    parseSSEStream: async function* (response) { for (const c of response.chunks) yield c; },
  };
}
const toolChunks = [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'ping', arguments: '' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":1}' } }] }, finish_reason: 'tool_calls' }] },
  { choices: [], usage: { prompt_tokens: 120, completion_tokens: 9, cost: 0.000054 } },
];

test('the test: one tiny request with one tool, through the agents\' own route; a tool call means it works', async () => {
  const h = createModelHealth({ file: tmpFile(), now }); const gw = fakeGateway({ chunks: toolChunks }); const booked = [];
  const r = await h.test('openrouter/nvidia/nemotron-3.5-super-vl', { gateway: gw, ledger: { record: (x) => booked.push(x) } });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.toolCall, true); assert.strictEqual(r.costUsd, 0.000054);
  assert.strictEqual(gw.calls.length, 1);
  const o = gw.calls[0].opts;
  assert.strictEqual(o.model, 'openrouter/nvidia/nemotron-3.5-super-vl', 'the full id, routed like an agent\'s reply');
  assert.deepStrictEqual(o.tools.map(t => t.function.name), ['ping']);
  assert.strictEqual(o.noRetries, true); assert.ok(o.max_tokens <= 400);
  assert.strictEqual(h.view()['openrouter/nvidia/nemotron-3.5-super-vl'].state, 'ok');
  assert.deepStrictEqual({ agent: booked[0].agent, origin: booked[0].origin, costUsd: booked[0].costUsd, ok: booked[0].ok, inputTokens: booked[0].inputTokens }, { agent: 'model-test', origin: 'model-test', costUsd: 0.000054, ok: true, inputTokens: 120 });
  const again = await h.test('openrouter/nvidia/nemotron-3.5-super-vl', { gateway: gw });
  assert.strictEqual(again.cached, true); assert.strictEqual(gw.calls.length, 1, 'answered from the last ten minutes');
  clock += 11 * 60 * 1000;
  await h.test('openrouter/nvidia/nemotron-3.5-super-vl', { gateway: gw });
  assert.strictEqual(gw.calls.length, 2, 'asked again after ten minutes');
});

test('the test: an answer without the tool call is a warning, a refusal is explained and marks the model', async () => {
  const h = createModelHealth({ file: tmpFile(), now });
  const text = await h.test('openrouter/meta-llama/llama-4-maverick', { gateway: fakeGateway({ chunks: [{ choices: [{ delta: { content: 'pong' } }] }] }) });
  assert.strictEqual(text.ok, true); assert.strictEqual(text.toolCall, false); assert.strictEqual(text.kind, 'no_tool_call');
  assert.match(text.title, /answered but didn't call the test tool/);
  assert.strictEqual(h.view()['openrouter/meta-llama/llama-4-maverick'].state, 'warn');
  const refused = Object.assign(new Error('Provider 404: {"error":{"message":"No endpoints found matching your data policy (Free model training).","code":404}}'), { status: 404 });
  const r = await h.test('openrouter/acme/solo:free', { gateway: fakeGateway({ throws: refused }) });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.kind, 'privacy');
  assert.match(r.what, /privacy setting/); assert.match(r.fix, /privacy/);
  assert.strictEqual(h.view()['openrouter/acme/solo:free'].short, 'blocked by the privacy setting');
});

test('the test: subscription models are not tested per request; a model that never answers times out cleanly', async () => {
  const h = createModelHealth({ file: tmpFile(), now: Date.now });
  const gw = fakeGateway({});
  assert.deepStrictEqual(await h.test('claude-sdk/opus', { gateway: gw }), { ok: true, skipped: true, toolCall: null });
  assert.deepStrictEqual(await h.test('codex-cli/gpt-6-astra', { gateway: gw }), { ok: true, skipped: true, toolCall: null });
  assert.strictEqual(gw.calls.length, 0);
  const slow = {
    chatCompletionStream: (messages, opts) => new Promise((resolve, reject) => { opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))); }),
    parseSSEStream: async function* () {},
  };
  const r = await h.test('openrouter/slow/model', { gateway: slow, timeoutMs: 50 });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.kind, 'timeout');
  assert.match(r.what, /No answer within 0 seconds|No answer within/);
});

test('the reply path: real replies record health, the spend log books a failed reply as failed, a stopped one as done', () => {
  const chat = read('lib/sdk-chat.js');
  assert.match(chat, /const modelHealth = require\('\.\/model-health'\)\.getModelHealth\(\);/);
  assert.match(chat, /const stopped = !!terminalError && \(terminalError\.name === 'AbortError' \|\| String\(terminalError\.message \|\| ''\)\.includes\('aborted'\)\);\n\s*const failed = !!terminalError && !stopped;/);
  assert.match(chat, /durationMs: Date\.now\(\) - ledgerStartedAt, ok: !failed,/, 'no more ok:true for every reply');
  assert.match(chat, /if \(!stopped && typeof model === 'string'\) \{ try \{ modelHealth\.record\(model, failed \? \{ ok: false, kind: turnErrorInfo && turnErrorInfo\.kind/);
});

test('an agent that consults a failing agent gets the plain explanation, not the raw provider text', () => {
  const chat = read('lib/sdk-chat.js');
  assert.match(chat, /type: 'turn_error', kind: cls\.kind === 'ok' \? 'error' : cls\.kind, transient: cls\.transient, retryAfterMs: cls\.retryAfterMs, message: providerPacing\.describeError\(e\)\.slice\(0, 300\) \|\| 'error', help: errorHelp\.oneLine\(turnErrorInfo\) \}/);
  assert.match(chat, /err\.pacing = \{ kind: turnError\.kind \|\| 'error', retryAfterMs: turnError\.retryAfterMs \|\| null, \.\.\.\(turnError\.help \? \{ help: String\(turnError\.help\)\.slice\(0, 900\) \} : \{\}\) \};/);
  const pacing = require('../lib/provider-pacing');
  const cls = pacing.classify({ pacing: { kind: 'error', help: 'Grok 4.7 couldn\'t reply. The OpenRouter account is out of credit. What to do: Add credit…' }, message: 'Provider 402: {}' });
  assert.strictEqual(cls.help, 'Grok 4.7 couldn\'t reply. The OpenRouter account is out of credit. What to do: Add credit…', 'the explanation survives the pacing layer');
  const src = read('lib/provider-pacing.js');
  assert.match(src, /if \(pc\.help\) return `\[FAILED\] "\$\{target\}" could not complete\. \$\{String\(pc\.help\)\.slice\(0, 900\)\} This does not look transient; do not retry blindly\.\$\{partial\}`;/);
});

test('the model test route: one route for the Test button and the pickers; admins only; health in the model list', () => {
  const srv = read('server.js');
  assert.strictEqual((srv.match(/pathname === '\/api\/models\/test' && req\.method === 'POST'/g) || []).length, 1, 'one route');
  assert.match(srv, /if \(!isMythosModel\(model\)\) \{\n\s*const r = await require\('\.\/lib\/model-health'\)\.getModelHealth\(\)\.test\(String\(model\)\.slice\(0, 200\), \{ ledger: getLedger\(\), force: !!body\.force \}\);/);
  assert.match(srv, /return jsonResponse\(res, 200, \{ success: !!r\.ok, model, latency: r\.ms,/, 'the agent settings page\'s Test button keeps its answer');
  assert.match(srv, /health: require\('\.\/lib\/model-health'\)\.getModelHealth\(\)\.view\(\),/);
  const { classifyRoute } = require('../lib/access');
  assert.strictEqual(classifyRoute('/api/models/test', 'POST').kind, 'admin');
  assert.match(read('agent-settings.html'), /if \(result\.success && result\.toolCall === false\) \{/, 'the Test button says when a model answered without using the tool');
});

// The pages: the same warnings for an OpenRouter row on the phone and the desktop, the mark in the pickers, and the
// test before switching in every place an agent's model is changed from the chat header.
function extract(src, name) {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} present`);
  let p = src.indexOf('(', at); let pd = 0;
  for (; p < src.length; p++) { if (src[p] === '(') pd++; else if (src[p] === ')' && --pd === 0) break; }
  let i = src.indexOf('{', p); let depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(at, i + 1);
}
const app = read('app.js'), mjs = read('mobile.js');
const pages = [['phone', mjs], ['desktop', app]].map(([label, src]) => [label, new Function(`${extract(src, 'orWarnings')}\n${extract(src, 'healthNote')}; return { orWarnings, healthNote };`)()]);

for (const [label, f] of pages) {
  test(`${label}: an OpenRouter row warns before you pick it`, () => {
    const ids = new Set(['nvidia/nemotron-3.5-super-vl', 'nvidia/nemotron-3.5-super-vl:free', 'acme/solo:free']);
    const health = { 'openrouter/x-ai/grok-4.7': { state: 'fail', short: 'out of credit' }, 'openrouter/deepseek/deepseek-v4.1-flash': { state: 'ok', okAt: 't' } };
    const w = (m, privacy = true) => f.orWarnings(m, { privacy, ids, health }).map(x => `${x.level}: ${x.text}`);
    assert.deepStrictEqual(w({ id: 'nvidia/nemotron-3.5-super-vl:free', tools: true, context: 1000000 }), ['block: ⛔ Blocked by your privacy setting; paid version: nvidia/nemotron-3.5-super-vl']);
    assert.deepStrictEqual(w({ id: 'acme/solo:free', tools: true, context: 64000 }), ['block: ⛔ Blocked by your privacy setting']);
    assert.deepStrictEqual(w({ id: 'acme/solo:free', tools: true, context: 64000 }, false), ['warn: Free version: may train on your prompts; low rate limits']);
    assert.deepStrictEqual(w({ id: 'gryphe/mythomax', tools: false, context: 4096 }), ["warn: ⚠ Can't use tools", "warn: ⚠ Small context window (4K): the hub's instructions alone take about 18K tokens"]);
    assert.deepStrictEqual(w({ id: 'x-ai/grok-4.7', tools: true, context: 500000 }), ['warn: ⚠ Last check here: out of credit']);
    assert.deepStrictEqual(w({ id: 'deepseek/deepseek-v4.1-flash', tools: true, context: 1000000 }), ['ok: ✓ Works here']);
    assert.deepStrictEqual(w({ id: 'new/model', tools: true, context: 200000 }), []);
  });
  test(`${label}: the picker shows the mark after a model's name`, () => {
    assert.strictEqual(f.healthNote({ state: 'fail', short: 'blocked by the privacy setting' }), ' — ⚠ blocked by the privacy setting');
    assert.strictEqual(f.healthNote({ state: 'warn', short: "didn't use the test tool" }), " — ⚠ didn't use the test tool");
    assert.strictEqual(f.healthNote({ state: 'ok', okAt: 't' }), '');
    assert.strictEqual(f.healthNote(undefined), '');
  });
}

test('every model change from the chat header tests a model the hub has not seen answer, and keeps the old one when told to', () => {
  for (const src of [app, mjs]) {
    const t = extract(src, 'testBeforeSwitch');
    assert.match(t, /\/\^\(claude-sdk\|codex-cli\|codex\)\\\/\/\.test\(model\)\) return true;/, 'subscription models are not tested');
    assert.match(t, /if \(h && h\.state === 'ok'\) return true;/, 'a model that answered here is not tested again');
    assert.match(t, /\/api\/models\/test'/);
    assert.match(t, /return confirm\(`\$\{r\.title \|\| `\$\{name\} may not work here\.`\} \$\{r\.what \|\| r\.error \|\| ''\}\\n\\nWhat to do: \$\{r\.fix \|\| 'pick another model\.'\}\\n\\nSwitch anyway\?`\);/);
    assert.match(t, /const passed = r\.ok !== undefined \? r\.ok : r\.success;/, 'a hub not yet restarted answers in the old shape');
  }
  assert.match(extract(app, 'changeChatModel'), /if \(!opts\.tested && !\(await testBeforeSwitch\(model\)\)\) \{ if \(sel\) sel\.value = chat\.model; return false; \}/);
  const choose = extract(app, 'chooseOrModel');
  assert.ok(choose.indexOf('await testBeforeSwitch(model)') < choose.indexOf("fetch('/api/openrouter', { method: 'POST'"), 'desktop search: tested before it joins the list');
  assert.match(extract(mjs, 'changeModelFromPick'), /if \(!\(await testBeforeSwitch\(model\)\)\) \{ sel\.value = a\.model; return; \}/);
  const click = extract(mjs, 'onOrSheetClick');
  assert.ok(click.indexOf('await testBeforeSwitch(model)') < click.indexOf("api('/api/openrouter', { method: 'POST'"), 'phone search: tested before it joins the list');
  assert.match(app, /\$\{esc\(\(\(billing\[m\] && billing\[m\]\.short\) \|\| billingDisplay\(m, true\)\) \+ healthNote\(health && health\[m\]\)\)\}/);
  assert.match(mjs, /\$\{esc\(mpLabel\(m\) \+ healthNote\(_modelHealth\[m\]\)\)\}/);
});
