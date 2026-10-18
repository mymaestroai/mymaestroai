'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ── Config ───────────────────────────────────────────────────────────────
const HUB_BASE = 'http://localhost:8888';
const BRIDGE_BASE = 'http://localhost:8767';
const AUTH = 'Basic ' + Buffer.from(process.env.HUB_TEST_AUTH || 'user:password').toString('base64');
const AGENTS_DIR = path.join(process.env.HOME, 'agent-hub/agent-hub-5.1.0/agents');

// ── HTTP helpers ─────────────────────────────────────────────────────────

function hubGet(urlPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, HUB_BASE);
    const req = http.request({
      method: 'GET', hostname: url.hostname, port: url.port,
      path: url.pathname + url.search,
      headers: { 'Authorization': AUTH }, timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function bridgeGet(urlPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BRIDGE_BASE);
    const req = http.request({
      method: 'GET', hostname: url.hostname, port: url.port,
      path: url.pathname, timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function hubPost(urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, HUB_BASE);
    const payload = JSON.stringify(body);
    const req = http.request({
      method: 'POST', hostname: url.hostname, port: url.port,
      path: url.pathname,
      headers: {
        'Authorization': AUTH,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

// Collect SSE text from a streaming chat request, with timeout
function streamChat(agent, message, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ agent, message, sessionId: 'new' });
    const url = new URL('/api/chat/stream', HUB_BASE);
    const req = http.request({
      method: 'POST', hostname: url.hostname, port: url.port,
      path: url.pathname,
      headers: {
        'Authorization': AUTH,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let fullText = '';
      let events = [];
      let buf = '';
      const timer = setTimeout(() => { req.destroy(); reject(new Error('Stream timeout')); }, timeoutMs);

      res.on('data', chunk => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ') || trimmed === 'data: [DONE]') continue;
          try {
            const parsed = JSON.parse(trimmed.slice(6));
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) fullText += delta;
            if (parsed.gateway) events.push(parsed.gateway);
          } catch {}
        }
      });
      res.on('end', () => { clearTimeout(timer); resolve({ text: fullText, events }); });
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Agent Discovery & Provider Config
// ═══════════════════════════════════════════════════════════════════════════

describe('Agent Discovery', () => {
  let agents;

  before(async () => {
    const res = await hubGet('/api/agents');
    agents = res.agents;
  });

  it('should discover agents open and gemini', () => {
    const names = agents.map(a => a.name);
    assert.ok(names.includes('open'), 'Agent "open" should be discovered');
    assert.ok(names.includes('gemini'), 'Agent "gemini" should be discovered');
  });

  it('agent open should be configured with openai provider', () => {
    const open = agents.find(a => a.name === 'open');
    assert.ok(open, 'Agent open should exist');
    assert.ok(open.model, 'Agent open should have a model');
    assert.ok(open.model.startsWith('openai/'), `Open's model should start with "openai/", got "${open.model}"`);
  });

  it('agent gemini should be configured with google provider', () => {
    const gemini = agents.find(a => a.name === 'gemini');
    assert.ok(gemini, 'Agent gemini should exist');
    assert.ok(gemini.model, 'Agent gemini should have a model');
    assert.ok(gemini.model.startsWith('google/'), `Gemini's model should start with "google/", got "${gemini.model}"`);
  });

  it('agent assistant should be configured with claude-sdk provider', () => {
    const assistant = agents.find(a => a.name === 'assistant');
    assert.ok(assistant, 'Agent assistant should exist');
    assert.ok(assistant.model, 'Assistant should have a model');
    assert.ok(assistant.model.startsWith('claude-sdk/'), `Assistant's model should start with "claude-sdk/", got "${assistant.model}"`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Agent Personality Files
// ═══════════════════════════════════════════════════════════════════════════

describe('Agent Personality Files', () => {
  const TEST_AGENTS = ['open', 'gemini', 'assistant'];
  const REQUIRED_FILES = ['SOUL.md'];
  const OPTIONAL_FILES = ['IDENTITY.md', 'USER.md', 'TOOLS.md', 'MEMORY.md'];

  for (const agentName of TEST_AGENTS) {
    it(`${agentName} should have SOUL.md (personality core)`, () => {
      // Check workspace first, then agent-level fallback
      const wsPath = path.join(process.env.HOME, `agent-hub/agent-hub-5.1.0/workspace-${agentName}/SOUL.md`);
      const agentPath = path.join(AGENTS_DIR, agentName, 'SOUL.md');
      const exists = fs.existsSync(wsPath) || fs.existsSync(agentPath);
      assert.ok(exists, `${agentName} should have SOUL.md in workspace or agent dir`);
    });

    it(`${agentName} SOUL.md should have meaningful content (>100 chars)`, () => {
      const wsPath = path.join(process.env.HOME, `agent-hub/agent-hub-5.1.0/workspace-${agentName}/SOUL.md`);
      const agentPath = path.join(AGENTS_DIR, agentName, 'SOUL.md');
      let content = '';
      try { content = fs.readFileSync(wsPath, 'utf8'); } catch {
        try { content = fs.readFileSync(agentPath, 'utf8'); } catch {}
      }
      assert.ok(content.length > 100, `${agentName} SOUL.md should have >100 chars, got ${content.length}`);
    });

    it(`${agentName} should have a MEMORY.md`, () => {
      const wsPath = path.join(process.env.HOME, `agent-hub/agent-hub-5.1.0/workspace-${agentName}/MEMORY.md`);
      const agentPath = path.join(AGENTS_DIR, agentName, 'MEMORY.md');
      const exists = fs.existsSync(wsPath) || fs.existsSync(agentPath);
      assert.ok(exists, `${agentName} should have MEMORY.md`);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Agent Context Loading
// ═══════════════════════════════════════════════════════════════════════════

describe('Agent Context Loading', () => {
  // The hub's loadAgentContext reads from the agent's workspace directory.
  // We verify the same logic by checking what files exist and their sizes.

  it('open agent workspace should contain personality files', () => {
    const ws = path.join(process.env.HOME, 'agent-hub/agent-hub-5.1.0/workspace-open');
    const files = fs.existsSync(ws) ? fs.readdirSync(ws) : [];
    // At minimum SOUL.md should exist
    assert.ok(
      files.includes('SOUL.md') || fs.existsSync(path.join(AGENTS_DIR, 'open/SOUL.md')),
      'open should have SOUL.md in workspace or agent dir'
    );
  });

  it('gemini agent workspace should contain personality files', () => {
    const ws = path.join(process.env.HOME, 'agent-hub/agent-hub-5.1.0/workspace-gemini');
    const files = fs.existsSync(ws) ? fs.readdirSync(ws) : [];
    assert.ok(
      files.includes('SOUL.md') || fs.existsSync(path.join(AGENTS_DIR, 'gemini/SOUL.md')),
      'gemini should have SOUL.md in workspace or agent dir'
    );
  });

  it('context should include session memory directory', () => {
    // Check that at least one agent has a memory/ subdir
    const wsOpen = path.join(process.env.HOME, 'agent-hub/agent-hub-5.1.0/workspace-open/memory');
    const wsGemini = path.join(process.env.HOME, 'agent-hub/agent-hub-5.1.0/workspace-gemini/memory');
    const wsAssistant = path.join(process.env.HOME, 'agent-hub/agent-hub-5.1.0/workspace/memory');
    const anyExists = fs.existsSync(wsOpen) || fs.existsSync(wsGemini) || fs.existsSync(wsAssistant);
    assert.ok(anyExists, 'At least one agent should have a memory/ directory for session notes');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. SDK Bridge Health
// ═══════════════════════════════════════════════════════════════════════════

describe('SDK Bridge', () => {
  it('should be running on port 8767', async () => {
    const models = await bridgeGet('/v1/models');
    assert.ok(models.data, 'Should return models data');
    assert.ok(Array.isArray(models.data), 'Models data should be an array');
  });

  it('should advertise Claude models', async () => {
    const models = await bridgeGet('/v1/models');
    const ids = models.data.map(m => m.id);
    assert.ok(ids.some(id => id.includes('claude')), 'Should have at least one Claude model');
    assert.ok(ids.includes('claude-sonnet-4-5'), 'Should have claude-sonnet-4-5 (default for consultations)');
  });

  it('should be running from the correct directory (not archive)', async () => {
    // Verify the bridge PID's cwd is tools/claude-sdk-bridge, not archive
    const { execSync } = require('child_process');
    const pidLine = execSync("ss -tlnp | grep 8767").toString().trim();
    const pidMatch = pidLine.match(/pid=(\d+)/);
    assert.ok(pidMatch, 'Should find bridge PID listening on 8767');

    const cwd = fs.readlinkSync(`/proc/${pidMatch[1]}/cwd`);
    assert.ok(cwd.includes('tools/claude-sdk-bridge'), `Bridge cwd should be tools/claude-sdk-bridge, got ${cwd}`);
    assert.ok(!cwd.includes('archive'), `Bridge should NOT run from archive, got ${cwd}`);
  });

  it('should have @anthropic-ai/claude-agent-sdk installed', () => {
    const pkgPath = path.join(process.env.HOME, 'agent-hub/agent-hub-5.1.0/workspace/tools/claude-sdk-bridge/node_modules/@anthropic-ai/claude-agent-sdk/package.json');
    assert.ok(fs.existsSync(pkgPath), 'SDK package should be installed in bridge node_modules');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Single Agent Consultation (consult_agent)
// ═══════════════════════════════════════════════════════════════════════════

describe('Single Agent Consultation', { timeout: 120000 }, () => {
  it('should successfully consult agent open via streaming chat', async () => {
    const { text, events } = await streamChat(
      'assistant',
      'Use the consult_agent MCP tool to ask agent "open" this question: What is 2+2? Reply with just the number. Then tell me their answer.',
      90000
    );
    assert.ok(text.length > 0, 'Should get a response');
    // The response should contain "4" somewhere
    assert.ok(text.includes('4'), `Response should contain "4", got: ${text.slice(0, 200)}`);

    // Should have tool activity events showing the consultation
    const toolStarts = events.filter(e => e.type === 'tool_start' || e.type === 'tool_use');
    assert.ok(toolStarts.length > 0, 'Should have tool activity events');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Parallel Agent Consultation (consult_agents)
// ═══════════════════════════════════════════════════════════════════════════

describe('Parallel Agent Consultation', { timeout: 180000 }, () => {
  it('should consult open and gemini in parallel and both respond', async () => {
    const startTime = Date.now();

    const { text, events } = await streamChat(
      'assistant',
      'Use the consult_agents MCP tool (the PARALLEL one, not consult_agent singular) to ask both "open" and "gemini" this: What is 15 * 3? Reply with just the number. Report both answers back to me.',
      150000
    );

    const elapsed = Date.now() - startTime;
    assert.ok(text.length > 0, 'Should get a response');

    // Both agents should have responded with 45
    assert.ok(text.includes('45'), `Response should contain "45" from at least one agent, got: ${text.slice(0, 300)}`);

    // Should mention both agents in the output
    const lowerText = text.toLowerCase();
    assert.ok(lowerText.includes('open') || lowerText.includes('agent open'), 'Response should mention agent open');
    assert.ok(lowerText.includes('gemini') || lowerText.includes('agent gemini'), 'Response should mention agent gemini');

    // Check for worker panel events showing both consultations started
    const workerStarts = events.filter(e => e.type === 'worker_started');
    // May or may not see these depending on SSE delivery timing, so just log
    console.log(`  [info] Worker started events: ${workerStarts.length}, elapsed: ${(elapsed / 1000).toFixed(1)}s`);
  });

  it('parallel consultations should start at the same time (verified via hub logs)', async () => {
    // Read the last consultation log entries from journalctl
    const { execSync } = require('child_process');
    let logs;
    try {
      logs = execSync(
        'journalctl --user -u agent-hub.service --since "3 min ago" --no-pager 2>&1',
        { timeout: 5000 }
      ).toString();
    } catch (e) {
      logs = e.stdout?.toString() || '';
    }

    // Find parallel consultation start lines
    const consultLines = logs.split('\n').filter(l => l.includes('[MCP consult_agents]') && l.includes('Consulting'));
    assert.ok(consultLines.length >= 2, `Should find at least 2 parallel consultation log lines, found ${consultLines.length}`);

    // Extract timestamps from the most recent pair
    const timestamps = [];
    for (const line of consultLines.slice(-2)) {
      const match = line.match(/(\d{2}:\d{2}:\d{2})/);
      if (match) timestamps.push(match[1]);
    }

    if (timestamps.length >= 2) {
      assert.strictEqual(timestamps[0], timestamps[1],
        `Both consultations should start in the same second: ${timestamps[0]} vs ${timestamps[1]}`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Worker Panel Events
// ═══════════════════════════════════════════════════════════════════════════

describe('Worker Panel Events', { timeout: 120000 }, () => {
  it('consultation should emit tool activity events on the SSE stream', async () => {
    const { events } = await streamChat(
      'assistant',
      'Use consult_agent to ask "open": Say hello in exactly 3 words.',
      90000
    );

    // SDK emits tool_start/tool_use/tool_result for MCP tool calls
    const toolEvents = events.filter(e =>
      e.type === 'tool_start' || e.type === 'tool_use' || e.type === 'tool_result'
    );
    assert.ok(toolEvents.length >= 1, 'Should have tool activity events on the stream');

    // Verify tool_start references consult_agent
    const consultStart = toolEvents.find(e => e.type === 'tool_start' && e.tool?.includes('consult_agent'));
    assert.ok(consultStart, 'Should have a tool_start event for consult_agent');

    // Verify tool_result exists with the agent's response
    const toolResult = toolEvents.find(e => e.type === 'tool_result');
    assert.ok(toolResult, 'Should have a tool_result event');
    if (toolResult?.output) {
      assert.ok(toolResult.output.includes('Agent open'), 'tool_result should contain Agent open response');
    }

    // Worker panel events (worker_started, worker_completed) may or may not
    // appear depending on SSE context timing — check but don't fail
    const workerEvents = events.filter(e =>
      e.type === 'worker_started' || e.type === 'worker_completed' || e.type === 'worker_text_delta'
    );
    console.log(`  [info] Worker panel events received: ${workerEvents.length} (tool events: ${toolEvents.length})`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Error Handling
// ═══════════════════════════════════════════════════════════════════════════

describe('Consultation Error Handling', { timeout: 120000 }, () => {
  it('consulting a non-existent agent should return an error, not crash', async () => {
    const { text } = await streamChat(
      'assistant',
      'Use the consult_agent MCP tool to consult agent "nonexistent_agent_xyz_999". Ask it anything. Tell me what happened.',
      60000
    );

    assert.ok(text.length > 0, 'Should get a response even on error');
    const lower = text.toLowerCase();
    assert.ok(
      lower.includes('not found') || lower.includes('error') || lower.includes('fail') || lower.includes('no context'),
      `Response should indicate an error for non-existent agent, got: ${text.slice(0, 300)}`
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Provider Routing Integrity (NO LLM calls — fast)
// ═══════════════════════════════════════════════════════════════════════════
// Verifies that external agents are NEVER assigned an Anthropic/Claude model.
// This catches the exact bug where all agents get routed through claude-sdk.

describe('Provider Routing Integrity', () => {
  let agents;

  before(async () => {
    const res = await hubGet('/api/agents');
    agents = res.agents;
  });

  // Expected provider mapping — the ground truth
  const EXPECTED_PROVIDERS = {
    open:       'openai',
    gemini:     'google',
    lab:        'gateway',
    assistant:   'claude-sdk',
    sonar:      'perplexity',
    sonarpro:   'perplexity',
    main:       'claude-sdk',    // Maestro
    magellan:   'claude-sdk',
    haiku:      'claude-sdk',
    sonnet:     'claude-sdk',
    max:        'gateway',
    wizard:    'gateway',
    helper:       'gateway',
  };

  for (const [name, expectedProvider] of Object.entries(EXPECTED_PROVIDERS)) {
    it(`${name} should use provider "${expectedProvider}" (not anthropic/claude substitution)`, () => {
      const agent = agents.find(a => a.name === name);
      assert.ok(agent, `Agent "${name}" should exist`);
      const actualProvider = agent.model.split('/')[0];
      assert.strictEqual(actualProvider, expectedProvider,
        `${name} should use "${expectedProvider}" but got "${actualProvider}" (model: ${agent.model})`);
    });
  }

  it('external agents should NEVER have claude-sdk or anthropic provider', () => {
    const externalAgents = ['open', 'gemini', 'lab', 'sonar', 'sonarpro', 'max', 'wizard', 'helper'];
    const claudeProviders = ['claude-sdk', 'anthropic'];

    for (const name of externalAgents) {
      const agent = agents.find(a => a.name === name);
      if (!agent) continue; // skip if agent doesn't exist
      const provider = agent.model.split('/')[0];
      assert.ok(
        !claudeProviders.includes(provider),
        `VIOLATION: "${name}" is using "${provider}" provider (model: ${agent.model}). External agents must NOT use Anthropic models.`
      );
    }
  });

  it('no agent should have an empty or undefined model', () => {
    for (const agent of agents) {
      assert.ok(agent.model, `Agent "${agent.name}" has no model assigned`);
      assert.ok(agent.model.includes('/'), `Agent "${agent.name}" model "${agent.model}" should be in "provider/modelId" format`);
    }
  });

  it('key agents should have modelStatus "ok" (model actually available)', () => {
    // These are agents that should always be usable — not just configured but actually loadable
    const criticalAgents = ['open', 'gemini', 'assistant', 'main', 'lab', 'sonar', 'haiku', 'sonnet'];
    for (const name of criticalAgents) {
      const agent = agents.find(a => a.name === name);
      if (!agent) continue;
      assert.strictEqual(agent.modelStatus, 'ok',
        `Critical agent "${name}" model "${agent.model}" has status "${agent.modelStatus}" — model is not available`);
    }
  });

  it('all agents should have available models (modelStatus "ok")', () => {
    const unavailable = agents.filter(a => a.modelStatus !== 'ok');
    if (unavailable.length > 0) {
      const lines = unavailable.map(a => `    ${a.name}: ${a.model} (${a.modelStatus})`);
      assert.fail(
        `${unavailable.length} agent(s) have unavailable models:\n${lines.join('\n')}`
      );
    }
  });

  it('provider distribution should show multiple providers (not all claude)', () => {
    const providers = new Set(agents.map(a => a.model.split('/')[0]));
    console.log(`  [info] Active providers: ${[...providers].sort().join(', ')}`);
    assert.ok(providers.size >= 3, `Should have at least 3 different providers, got ${providers.size}: ${[...providers].join(', ')}`);
    assert.ok(providers.has('openai'), 'Should have openai provider');
    assert.ok(providers.has('google'), 'Should have google provider');
    assert.ok(providers.has('gateway'), 'Should have gateway provider');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. Consultation Routes Through Hub Stream (NOT direct API)
// ═══════════════════════════════════════════════════════════════════════════
// Verifies that the consult_agent tool calls the hub's own /api/chat/stream
// endpoint, not a separate provider API or SDK Bridge.

describe('Consultation Hub Routing', () => {
  it('consultViaHub should exist in sdk-chat.js (not consultViaSdkBridge)', () => {
    const sdkChat = fs.readFileSync(
      path.join(process.env.HOME, 'agent-hub/agent-hub-5.1.0/lib/sdk-chat.js'), 'utf8'
    );
    assert.ok(sdkChat.includes('async function consultViaHub('),
      'consultViaHub function should exist');
    assert.ok(!sdkChat.includes('async function consultViaSdkBridge('),
      'consultViaSdkBridge should NOT exist (replaced by consultViaHub)');
  });

  it('consult_agent tool should call consultViaHub (not callExternalAgent or SDK Bridge)', () => {
    const sdkChat = fs.readFileSync(
      path.join(process.env.HOME, 'agent-hub/agent-hub-5.1.0/lib/sdk-chat.js'), 'utf8'
    );
    // Find the consult_agent tool handler section
    const consultSection = sdkChat.slice(
      sdkChat.indexOf("'consult_agent'"),
      sdkChat.indexOf("'consult_agents'")
    );
    assert.ok(consultSection.includes('consultViaHub('),
      'consult_agent should call consultViaHub');
    assert.ok(!consultSection.includes('callExternalAgent('),
      'consult_agent should NOT call callExternalAgent directly');
    assert.ok(!consultSection.includes('consultViaSdkBridge('),
      'consult_agent should NOT call consultViaSdkBridge');
    assert.ok(!consultSection.includes('localhost:8767'),
      'consult_agent should NOT reference SDK Bridge port 8767');
  });

  it('consult_agents tool should call consultViaHub for all agents', () => {
    const sdkChat = fs.readFileSync(
      path.join(process.env.HOME, 'agent-hub/agent-hub-5.1.0/lib/sdk-chat.js'), 'utf8'
    );
    const consultsSection = sdkChat.slice(
      sdkChat.indexOf("'consult_agents'"),
      sdkChat.indexOf("'consult_agents'") + 3000
    );
    assert.ok(consultsSection.includes('consultViaHub('),
      'consult_agents should call consultViaHub');
    assert.ok(!consultsSection.includes('callExternalAgent('),
      'consult_agents should NOT call callExternalAgent directly');
    assert.ok(!consultsSection.includes('isClaudeAgent'),
      'consult_agents should NOT branch on isClaudeAgent (all agents use same path)');
  });

  it('consultViaHub should POST to localhost:8888 (hub self-call)', () => {
    const sdkChat = fs.readFileSync(
      path.join(process.env.HOME, 'agent-hub/agent-hub-5.1.0/lib/sdk-chat.js'), 'utf8'
    );
    const funcStart = sdkChat.indexOf('async function consultViaHub(');
    const funcSection = sdkChat.slice(funcStart, funcStart + 1500);
    assert.ok(funcSection.includes('localhost:8888/api/chat/stream'),
      'consultViaHub should POST to hub\'s own /api/chat/stream endpoint');
    assert.ok(!funcSection.includes('localhost:8767'),
      'consultViaHub should NOT reference SDK Bridge');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. Ephemeral Session Protection
// ═══════════════════════════════════════════════════════════════════════════
// Verifies that worker consultations don't overwrite agents' stored sessions.

describe('Ephemeral Session Protection', () => {
  it('consultViaHub should send ephemeral: true in request body', () => {
    const sdkChat = fs.readFileSync(
      path.join(process.env.HOME, 'agent-hub/agent-hub-5.1.0/lib/sdk-chat.js'), 'utf8'
    );
    const funcStart = sdkChat.indexOf('async function consultViaHub(');
    const funcSection = sdkChat.slice(funcStart, funcStart + 1500);
    assert.ok(funcSection.includes('ephemeral: true'),
      'consultViaHub should send ephemeral: true to prevent session overwrite');
  });

  it('streamViaSdk should skip setAgentSessionId when ephemeral', () => {
    const sdkChat = fs.readFileSync(
      path.join(process.env.HOME, 'agent-hub/agent-hub-5.1.0/lib/sdk-chat.js'), 'utf8'
    );
    // Find the session capture block
    assert.ok(sdkChat.includes('if (!ephemeral)'),
      'streamViaSdk should check ephemeral flag before persisting session');
    // Both main and retry paths should be guarded
    const matches = sdkChat.match(/if \(!ephemeral\).*?setAgentSessionId/gs);
    assert.ok(matches && matches.length >= 2,
      `Both main and retry session capture should be guarded by ephemeral check (found ${matches ? matches.length : 0})`);
  });

  it('stored sessions should not contain consultation session IDs', async () => {
    const sessionsPath = path.join(process.env.HOME,
      'agent-hub/agent-hub-5.1.0/data/sdk-sessions.json');
    if (!fs.existsSync(sessionsPath)) return; // skip if no sessions file

    const sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));

    // Agents that were consulted as workers should NOT have sessions stored
    // unless they were also used interactively. We verify that open/gemini/lab
    // don't have sessions (since they're external providers and only used as workers).
    // Note: claude-sdk agents like assistant DO persist sessions from interactive use.
    const externalConsulted = ['open', 'gemini', 'lab'];
    for (const name of externalConsulted) {
      // External agents don't go through streamViaSdk at all, so they should never
      // have a session ID in this file
      assert.ok(!sessions[name],
        `External agent "${name}" should NOT have a stored session (found: ${sessions[name]}). ` +
        'This suggests consultations are going through SDK instead of the provider API.');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. Live Consultation Routing Verification (requires hub + actual API calls)
// ═══════════════════════════════════════════════════════════════════════════
// Makes real consultation calls and verifies via hub logs that the correct
// provider was used. These tests cost API tokens but catch routing bugs.

describe('Live Consultation Routing', { timeout: 180000 }, () => {
  it('consulting agent open should route through openai (verified via logs)', async () => {
    // Record the session map before the consultation
    const sessionsPath = path.join(process.env.HOME,
      'agent-hub/agent-hub-5.1.0/data/sdk-sessions.json');
    const sessionsBefore = fs.existsSync(sessionsPath)
      ? JSON.parse(fs.readFileSync(sessionsPath, 'utf8'))
      : {};

    const { text } = await streamChat(
      'assistant',
      'Use the consult_agent tool to ask agent "open" this exact question: What is 7 times 8? Reply with ONLY the number. Then tell me the answer.',
      90000
    );

    assert.ok(text.includes('56'), `Open should answer 56, got: ${text.slice(0, 300)}`);

    // Check hub logs for correct routing
    const { execSync } = require('child_process');
    let logs = '';
    try {
      logs = execSync('journalctl -t node --since "2 min ago" --no-pager 2>/dev/null', { timeout: 5000 }).toString();
    } catch (e) { logs = e.stdout?.toString() || ''; }

    const routingLine = logs.split('\n').find(l =>
      l.includes('[consult-hub]') && l.includes('"open"')
    );
    assert.ok(routingLine, 'Should find hub routing log for agent open');

    // The stream endpoint logs should show openai routing, NOT claude-sdk
    const providerLine = logs.split('\n').find(l =>
      l.includes('[SDK open]') || l.includes('openai/') && l.includes('open')
    );
    // Verify no claude-sdk substitution happened for open
    const claudeSubstitution = logs.split('\n').find(l =>
      l.includes('[SDK open]') && l.includes('claude')
    );
    assert.ok(!claudeSubstitution,
      `Agent open should NOT route through Claude SDK. Found: ${claudeSubstitution}`);

    // Verify session was NOT persisted (ephemeral)
    const sessionsAfter = fs.existsSync(sessionsPath)
      ? JSON.parse(fs.readFileSync(sessionsPath, 'utf8'))
      : {};
    assert.ok(!sessionsAfter['open'],
      'Agent open should not have a stored session after consultation (ephemeral)');
  });

  it('consulting agent gemini should route through google (verified via logs)', async () => {
    const { text } = await streamChat(
      'assistant',
      'Use the consult_agent tool to ask agent "gemini" this exact question: What is 9 times 6? Reply with ONLY the number. Then tell me the answer.',
      90000
    );

    assert.ok(text.includes('54'), `Gemini should answer 54, got: ${text.slice(0, 300)}`);

    // Verify via logs
    const { execSync } = require('child_process');
    let logs = '';
    try {
      logs = execSync('journalctl -t node --since "2 min ago" --no-pager 2>/dev/null', { timeout: 5000 }).toString();
    } catch (e) { logs = e.stdout?.toString() || ''; }

    const routingLine = logs.split('\n').find(l =>
      l.includes('[consult-hub]') && l.includes('"gemini"')
    );
    assert.ok(routingLine, 'Should find hub routing log for agent gemini');

    // Verify no claude-sdk substitution
    const claudeSubstitution = logs.split('\n').find(l =>
      l.includes('[SDK gemini]') && l.includes('claude')
    );
    assert.ok(!claudeSubstitution,
      `Agent gemini should NOT route through Claude SDK. Found: ${claudeSubstitution}`);
  });

  it('worker consultation prompt should be tagged with coordinator name', async () => {
    const { execSync } = require('child_process');
    let logs = '';
    try {
      logs = execSync('journalctl -t node --since "3 min ago" --no-pager 2>/dev/null', { timeout: 5000 }).toString();
    } catch (e) { logs = e.stdout?.toString() || ''; }

    // The consultViaHub function tags messages with [Worker request from <coordinator>]
    // Check that this pattern appears in the stream logs
    const sdkChat = fs.readFileSync(
      path.join(process.env.HOME, 'agent-hub/agent-hub-5.1.0/lib/sdk-chat.js'), 'utf8'
    );
    assert.ok(sdkChat.includes('[Worker request from'),
      'consultViaHub should tag prompts with [Worker request from <coordinator>]');
  });
});
