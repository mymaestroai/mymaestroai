'use strict';

/**
 * skill-manager.js — Central manager for MCP-based skills
 *
 * Manages MCP service connections, authentication, tool discovery,
 * and tool execution. Supports both Streamable HTTP and stdio transports.
 */

const fs = require('fs');
const path = require('path');
const McpStdioClient = require('./mcp-stdio');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const TOKENS_FILE = path.join(DATA_DIR, 'skill-tokens.json');

// ── Skill Registry ─────────────────────────────────────────────────────

const SKILLS = {
  'google-workspace': {
    label: 'Google Workspace',
    description: 'Calendar, Drive, Docs, Sheets, Gmail, Tasks, Slides, Forms',
    transport: 'stdio',
    command: process.env.GOOGLE_WORKSPACE_MCP_PATH || 'google-workspace-mcp',
    args: ['serve'],
    icon: '📅',
  },
  'github': {
    label: 'GitHub',
    description: 'Repos, PRs, issues, code, commits, security alerts, actions',
    transport: 'stdio',
    command: 'github-mcp',
    args: [],
    env: {
      GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_PERSONAL_ACCESS_TOKEN || '',
    },
    icon: '🐙',
  },
  'sequential-thinking': {
    label: 'Sequential Thinking',
    description: 'Step-by-step reasoning and analysis for complex problems',
    transport: 'stdio',
    command: 'sequential-thinking-mcp',
    args: [],
    icon: '🧠',
  },
  'playwright': {
    label: 'Playwright Browser',
    description: 'Browser automation: navigate web pages, click, type, screenshot, scrape.',
    transport: 'stdio',
    command: 'playwright-mcp',
    args: [],
    icon: '🌐',
  },
};

// ── Stdio Client Pool ──────────────────────────────────────────────────
// Long-lived subprocess clients, keyed by skill ID

const stdioClients = new Map();

function getStdioClient(skillId) {
  const skill = SKILLS[skillId];
  if (!skill || skill.transport !== 'stdio') return null;

  if (!stdioClients.has(skillId)) {
    const env = skill.env ? { ...process.env, ...skill.env } : process.env;
    const client = new McpStdioClient(skill.command, skill.args, {
      timeout: 60000,
      env,
    });
    stdioClients.set(skillId, client);
  }
  return stdioClients.get(skillId);
}

// ── OAuth Token Refresh ─────────────────────────────────────────────────

function refreshOAuthToken(skillId, tokenData) {
  const skill = SKILLS[skillId];
  if (!tokenData.refresh_token || !tokenData.token_endpoint) return null;

  try {
    // Synchronous HTTP request for token refresh (keeps getToken synchronous)
    const { execSync } = require('child_process');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokenData.refresh_token,
      client_id: tokenData.client_id || '',
    }).toString();

    const result = execSync(`curl -s -X POST "${tokenData.token_endpoint}" -H "Content-Type: application/x-www-form-urlencoded" -d '${body}'`, {
      timeout: 15000,
      encoding: 'utf8',
    });

    const newTokens = JSON.parse(result);
    if (newTokens.access_token) {
      // Merge new tokens into existing file
      const updated = {
        ...tokenData,
        access_token: newTokens.access_token,
        expires_in: newTokens.expires_in,
        expires_at: new Date(Date.now() + (newTokens.expires_in || 3600) * 1000).toISOString(),
      };
      if (newTokens.refresh_token) {
        updated.refresh_token = newTokens.refresh_token;
      }
      fs.writeFileSync(skill.tokenFile, JSON.stringify(updated, null, 2), { encoding: 'utf8', mode: 0o600 });
      try { fs.chmodSync(skill.tokenFile, 0o600); } catch { /* filesystem without modes */ }
      console.log(`[skills] ${skillId}: token refreshed successfully`);
      return newTokens.access_token;
    }
  } catch (e) {
    console.error(`[skills] ${skillId}: token refresh error: ${e.message}`);
  }
  return null;
}

// ── Token Management (for HTTP-based skills) ───────────────────────────

function loadTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveTokens(tokens) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), { encoding: 'utf8', mode: 0o600 });   // OAuth tokens: owner-only (review F44)
  try { fs.chmodSync(TOKENS_FILE, 0o600); } catch { /* filesystem without modes */ }
}

function getToken(skillId) {
  const skill = SKILLS[skillId];
  if (!skill) return null;

  // 1. Check environment variable
  if (skill.tokenEnvVar && process.env[skill.tokenEnvVar]) {
    return process.env[skill.tokenEnvVar];
  }

  // 2. Check OAuth token file
  if (skill.tokenFile) {
    try {
      const tokenData = JSON.parse(fs.readFileSync(skill.tokenFile, 'utf8'));
      if (tokenData.access_token) {
        // Check if token is expired (with 5-minute buffer)
        if (tokenData.expires_at) {
          // Handle both Unix ms timestamps and ISO date strings
          const expiresAt = typeof tokenData.expires_at === 'number'
            ? tokenData.expires_at
            : new Date(tokenData.expires_at).getTime();
          if (Date.now() > expiresAt - 5 * 60 * 1000) {
            console.log(`[skills] ${skillId}: token expired, attempting refresh...`);
            const refreshed = refreshOAuthToken(skillId, tokenData);
            if (refreshed) return refreshed;
            console.warn(`[skills] ${skillId}: token refresh failed — token may be expired`);
          }
        }
        return tokenData.access_token;
      }
    } catch (e) {
      // File doesn't exist or isn't valid JSON — fall through
    }
  }

  // 3. Check skill-tokens.json store
  const tokens = loadTokens();
  return tokens[skillId]?.token || null;
}

function setToken(skillId, token) {
  const tokens = loadTokens();
  tokens[skillId] = { token, savedAt: new Date().toISOString() };
  saveTokens(tokens);
}

// ── Tool Cache ──────────────────────────────────────────────────────────

const toolCache = new Map();
const TOOL_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

async function discoverTools(skillId) {
  const skill = SKILLS[skillId];
  if (!skill) return [];

  // Check cache
  const cached = toolCache.get(skillId);
  if (cached && (Date.now() - cached.discoveredAt) < TOOL_CACHE_TTL) {
    return cached.tools;
  }

  try {
    let tools = [];

    if (skill.transport === 'stdio') {
      const client = getStdioClient(skillId);
      tools = await client.listTools();
    } else if (skill.transport === 'http') {
      const token = getToken(skillId);
      if (!token && skill.authType !== 'none') {
        console.log(`[skills] ${skillId}: no auth token — skipping`);
        return [];
      }
      const { initializeAndListTools } = require('./mcp-streamable-http');
      const headers = {};
      if (token) {
        if (skill.authType === 'custom-header' && skill.customAuthHeader) {
          headers[skill.customAuthHeader] = token;
        } else {
          headers['Authorization'] = `Bearer ${token}`;
        }
      }
      const result = await initializeAndListTools(skill.mcpUrl, { headers, timeout: 15000 });
      tools = result.tools;
    }

    console.log(`[skills] ${skillId}: discovered ${tools.length} tools`);
    toolCache.set(skillId, { tools, discoveredAt: Date.now() });
    return tools;
  } catch (e) {
    console.error(`[skills] ${skillId}: tool discovery failed: ${e.message}`);
    return [];
  }
}

// ── Build OpenAI-compatible tools from MCP tools ────────────────────────

function mcpToolToOpenAI(skillId, mcpTool) {
  const skill = SKILLS[skillId];
  // Normalize hyphens to underscores for LLM-compatible tool names
  const toolName = `${skillId}__${mcpTool.name}`.replace(/-/g, '_');

  return {
    type: 'function',
    function: {
      name: toolName,
      description: `[${skill?.icon || '🔧'} ${skill?.label || skillId}] ${mcpTool.description || mcpTool.name}`,
      parameters: mcpTool.inputSchema || { type: 'object', properties: {} },
    },
  };
}

/**
 * Execute an MCP tool call via the appropriate transport.
 */
async function executeMcpTool(skillId, toolName, args) {
  const skill = SKILLS[skillId];
  if (!skill) throw new Error(`Unknown skill: ${skillId}`);

  if (skill.transport === 'stdio') {
    const client = getStdioClient(skillId);
    const result = await client.callTool(toolName, args);

    // Extract text content from MCP response
    if (result?.content) {
      const texts = result.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text);
      return texts.join('\n');
    }
    return JSON.stringify(result);
  } else if (skill.transport === 'http') {
    const token = getToken(skillId);
    if (!token && skill.authType !== 'none') throw new Error(`Not authenticated with ${skill.label}`);
    const { callTool } = require('./mcp-streamable-http');
    const headers = {};
    if (token) {
      if (skill.authType === 'custom-header' && skill.customAuthHeader) {
        headers[skill.customAuthHeader] = token;
      } else {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }
    return callTool(skill.mcpUrl, toolName, args, { headers, timeout: 60000 });
  }

  throw new Error(`Unknown transport for ${skillId}: ${skill.transport}`);
}

/**
 * Get all available skill tools in OpenAI format, plus handlers.
 */
async function getSkillTools({ exclude = null } = {}) {
  const openaiTools = [];
  const handlers = new Map();

  // Discover tools from all skills IN PARALLEL (not sequentially)
  // This eliminates 20-30s cold-start latency when caches expire
  // `exclude`: skill ids wrapped by a data connector (lib/connectors) are NOT exposed here; the connector's grants decide.
  const skillEntries = Object.entries(SKILLS).filter(([skillId, skill]) => {
    if (exclude && exclude.has && exclude.has(skillId)) return false;
    if (skill.transport === 'http' && skill.authType !== 'none' && !getToken(skillId)) return false;
    return true;
  });

  const startTime = Date.now();
  const results = await Promise.allSettled(
    skillEntries.map(async ([skillId]) => {
      const mcpTools = await discoverTools(skillId);
      return { skillId, mcpTools };
    })
  );

  for (const result of results) {
    if (result.status === 'rejected') {
      console.error(`[skills] Failed to load tools: ${result.reason?.message}`);
      continue;
    }
    const { skillId, mcpTools } = result.value;
    for (const mcpTool of mcpTools) {
      const openaiTool = mcpToolToOpenAI(skillId, mcpTool);
      const realToolName = mcpTool.name;
      handlers.set(openaiTool.function.name, async (toolArgs) => {
        return executeMcpTool(skillId, realToolName, toolArgs);
      });
      openaiTools.push(openaiTool);
    }
  }

  const elapsed = Date.now() - startTime;
  console.log(`[skills] Tool budget: ${openaiTools.length} tools sent to LLM (handlers: ${handlers.size}) [${elapsed}ms]`);
  return { openaiTools, handlers };
}

/**
 * Pre-warm the tool cache on server startup.
 * Call this once after server is ready — runs in background, non-blocking.
 */
async function warmToolCache() {
  console.log('[skills] Pre-warming tool cache...');
  const start = Date.now();
  try {
    await getSkillTools();
    console.log(`[skills] Cache warmed in ${Date.now() - start}ms`);
  } catch (e) {
    console.error(`[skills] Cache warm failed: ${e.message}`);
  }
}

// ── Status & Management ─────────────────────────────────────────────────

function getSkillStatus() {
  const status = {};
  for (const [skillId, skill] of Object.entries(SKILLS)) {
    const cached = toolCache.get(skillId);
    const stdioClient = stdioClients.get(skillId);

    let authenticated = false;
    if (skill.transport === 'stdio') {
      authenticated = stdioClient?.isConnected() || true; // stdio uses local creds
    } else if (skill.authType === 'none') {
      authenticated = true; // No auth needed
    } else {
      authenticated = !!getToken(skillId);
    }

    status[skillId] = {
      label: skill.label,
      description: skill.description,
      icon: skill.icon,
      transport: skill.transport,
      authenticated,
      connected: stdioClient?.isConnected() || false,
      toolCount: cached?.tools?.length || 0,
    };
  }
  return status;
}

function clearToolCache(skillId) {
  if (skillId) {
    toolCache.delete(skillId);
  } else {
    toolCache.clear();
  }
}

/**
 * Shut down all stdio clients (call on server shutdown)
 */
async function shutdown() {
  for (const [skillId, client] of stdioClients) {
    console.log(`[skills] Shutting down ${skillId}...`);
    await client.disconnect();
  }
  stdioClients.clear();
}

module.exports = {
  SKILLS,
  getToken,
  setToken,
  discoverTools,
  getSkillTools,
  getSkillStatus,
  clearToolCache,
  executeMcpTool,
  shutdown,
  // Exposed for troubleshooter
  _stdioClients: stdioClients,
  _toolCache: toolCache,
};
