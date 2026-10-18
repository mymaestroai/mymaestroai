'use strict';
// Parity of the hands across the three model paths: the gateway's built-in tool list, the "hub" MCP server the
// Claude client gets with tools=hub, and the Codex bridge list all carry the same eight tools with the same schemas;
// the Claude client's own built-ins are switched off in that mode; images reach the model on every path; the
// per-agent field and hub default exist. Source pins keep the wiring from regressing.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { BUILTIN_TOOLS } = require('../lib/provider-tools');
const { createHubTools, TOOL_NAMES, CLIENT_BUILTINS } = require('../lib/hub-tools');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const sdk = read('lib/sdk-chat.js');

test('the gateway built-ins and the hands specs are the same eight tools with identical schemas', () => {
  const t = createHubTools({ log: () => {} });
  const specs = t.specs();
  assert.deepStrictEqual(specs.map(s => s.name), TOOL_NAMES);
  for (const s of specs) {
    const g = BUILTIN_TOOLS[s.name];
    assert.ok(g, `${s.name} exists on the gateway`);
    assert.deepStrictEqual(g.parameters, s.parameters, `${s.name} parameters match`);
    assert.strictEqual(g.description, s.description, `${s.name} description matches`);
  }
  // the first eight gateway built-ins are exactly the hands, in order
  assert.deepStrictEqual(Object.keys(BUILTIN_TOOLS).slice(0, 8), TOOL_NAMES);
});

test('the hands MCP server for client agents exposes the same tools, with images as MCP image content', async () => {
  // A fake SDK that records tool registrations the way @anthropic-ai/claude-agent-sdk's tool()/createSdkMcpServer do.
  const made = [];
  const sdk = {
    tool: (name, description, shape, handler, extras) => ({ name, description, shape, handler, extras }),
    createSdkMcpServer: (cfg) => { made.push(cfg); return { name: cfg.name, tools: cfg.tools }; },
  };
  const build = require('../lib/sdk-chat').buildHandsMcpServer;
  const d = fs.mkdtempSync(path.join(require('os').tmpdir(), 'parity-'));
  fs.writeFileSync(path.join(d, 'i.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  const t = createHubTools({ cwd: d, log: () => {} });
  const server = build(sdk, t, { blocked: ['Bash'] });
  assert.strictEqual(server.name, 'hub');
  assert.deepStrictEqual(server.tools.map(x => x.name), TOOL_NAMES.filter(n => n !== 'Bash'), 'blocked names are left out');
  const readTool = server.tools.find(x => x.name === 'Read');
  assert.ok(readTool.shape.file_path && readTool.shape.pages, 'zod shape built from the schema');
  assert.deepStrictEqual(readTool.extras, { annotations: { readOnlyHint: true } }, 'reads are concurrency-safe');
  assert.deepStrictEqual(server.tools.find(x => x.name === 'Edit').extras, {}, 'writers run serially');
  const res = await readTool.handler({ file_path: path.join(d, 'i.png') });
  assert.strictEqual(res.content[0].type, 'text');
  assert.strictEqual(res.content[1].type, 'image');
  assert.strictEqual(res.content[1].mimeType, 'image/png');
  assert.strictEqual(made[0].alwaysLoad, true);
});

test('Claude client path: tools=hub disallows the client built-ins, allows only the two hub servers, adds the hands server and the note', () => {
  assert.match(sdk, /const hands = await handsForTurn\(agentName, \{ consultationDepth: options\.consultationDepth \|\| 0 \}\);\s*\n\s*const hubHands = hands\.mode === 'hub';/);
  assert.match(sdk, /allowedTools: hubHands \? \['mcp__agent-hub__\*', 'mcp__hub__\*'\] : sandboxWithheld \? \['mcp__agent-hub__\*'\] : \[/);
  assert.match(sdk, /\.\.\.\(hubHands \|\| sandboxWithheld \? \{ disallowedTools: \[\.\.\.hubToolsLib\.CLIENT_BUILTINS\] \} : \{\}\),/);
  assert.match(sdk, /queryOptions\.disallowedTools = \[\.\.\.new Set\(\[\.\.\.\(queryOptions\.disallowedTools \|\| \[\]\), \.\.\.blockedTools\]\)\];/, 'scope blocks merge instead of overwriting');
  assert.match(sdk, /if \(hubHands && !sandboxWithheld\) \{\s*\n\s*queryOptions\.mcpServers\.hub = buildHandsMcpServer\(sdk, hands\.tools, \{ blocked: blockedTools \}\);/);
  assert.match(sdk, /append: agentContext \+ workerPolicyText \+ jobsPolicyText \+ visualsText \+ handsNote \+ `/);
  assert.match(sdk, /## YOUR HANDS\nYour shell, file and web tools are the hub's/);
  // with tools=hub a sandboxed agent's client is NOT launched through the wrapper: prepare() only runs on the client path
  assert.match(sdk, /if \(hubHands\) \{\s*\n\s*sandboxWithheld = hands\.withheld;[\s\S]*?\} else \{\s*\n\s*sandboxOpts = await sb\.prepare\(recSb\)/);
});

test('Codex path: tools=hub appends the hands to the bridge list, confines its own shell to read-only, and says so', () => {
  assert.match(sdk, /const hubHands = hands\.mode === 'hub' && !hands\.withheld;\s*\n\s*if \(hubHands\) \{\s*\n\s*const h = buildHandsMcpServer\(codexBridge\.collectingSdk, hands\.tools, \{ blocked: twVirtual \? temporalWorkers\.sdkDisallowedFor\(twVirtual\.toolScope\) : \[\] \}\);\s*\n\s*for \(const t of h\.tools\) hubTools\.push\(t\);/);
  assert.match(sdk, /const sandbox = hubHands \? 'read-only' : codexCli\.sandboxFor\(/);
  assert.match(sdk, /your own shell is read-only here/);
});

test('gateway path: one hands instance per turn, withheld tools dropped, images flushed after each batch for vision models', () => {
  assert.match(sdk, /async function handsForTurn\(agentName, \{ consultationDepth = 0 \} = \{\}\) \{/);
  assert.match(sdk, /box = \{ exec: \(cmd, o\) => sb\.exec\(agent, cmd, o\), mounts: sb\.mountsFor\(agent\) \};/);
  assert.match(sdk, /handlers\.__images = \[\];/);
  assert.match(sdk, /if \(r\.images && r\.images\.length\) handlers\.__images\.push\(\{ tool: name, images: r\.images \}\);/);
  assert.match(sdk, /const imgs = handlers\.__images \? handlers\.__images\.splice\(0\) : \[\];\s*\n\s*if \(imgs\.length\) \{[\s\S]*?if \(supportsImages\(model\)\) \{[\s\S]*?parts\.push\(\{ type: 'image_url', image_url: \{ url: `data:\$\{x\.mime\};base64,\$\{x\.base64\}` \} \}\);[\s\S]*?requestMessages\.push\(\{ role: 'user', content: parts \}\);/);
  assert.match(sdk, /does not support vision\)` \}\);/);
  const at = sdk.indexOf('const imgs = handlers.__images');
  const batchEnd = sdk.lastIndexOf('await executeToolCallsBatched(assistantMsg.tool_calls, {', at);
  assert.ok(batchEnd > 0 && at > batchEnd, 'the flush comes after the batch, never between tool results');
});

test('the agent field, the hub default and both settings pages exist', () => {
  const agents = read('lib/agents.js');
  assert.match(agents, /tools: a\.tools \|\| 'inherit',/);
  assert.match(agents, /if \(!\['inherit', 'client', 'hub'\]\.includes\(v\)\) return \{ ok: false, error: 'tools must be inherit, client or hub' \};/);
  const page = read('agent-settings.html');
  assert.match(page, /<select id="tools-mode" onchange="saveToolsMode\(\)"/);
  assert.match(page, /body: JSON\.stringify\(\{ tools: v \}\)/);
  assert.match(page, /toolsSel\.value = agent\?\.tools \|\| 'inherit';/);
  assert.match(page, /const clientModel = \/\^\(claude-sdk\|codex-cli\)\\\/\/\.test\(/, 'the row shows only for client models');
  const app = read('app.js');
  assert.match(app, /selSb\('st-tools-default', \[\['client'/);
  assert.match(app, /toolsDefault: \(document\.getElementById\('st-tools-default'\) \|\| \{\}\)\.value === 'hub' \? 'hub' : 'client'/);
  assert.deepStrictEqual(CLIENT_BUILTINS.length, 9);
});
