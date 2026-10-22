'use strict';

/**
 * Codex CLI provider: `codex-cli/<model>` agents run on the owner's ChatGPT
 * subscription through the official OpenAI Codex CLI (`codex exec`), the way
 * `claude-sdk/<model>` agents run through the Claude client.
 *
 * The hub never touches the subscription credentials. It only spawns the CLI,
 * which reads its own login from ~/.codex (run `codex login --device-auth`
 * once on a headless box). `openai/` and `codex/` models are unaffected and
 * keep using the API key.
 *
 * This file holds the pure parts (binary lookup, argv, event parsing, session
 * map, model discovery); the streaming turn lives in sdk-chat.js
 * (streamViaCodex) and the hub-tool bridge in ./bridge.js + ./mcp-bridge.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const PREFIX = 'codex-cli/';
const HUB_DIR = path.resolve(__dirname, '..', '..');
const SESSION_MAP_FILE = process.env.HUB_CODEX_SESSIONS_FILE || path.join(HUB_DIR, 'data', 'codex-sessions.json');
const MCP_BRIDGE_SCRIPT = path.join(__dirname, 'mcp-bridge.js');

function isCodexCliModel(model) {
  return typeof model === 'string' && model.startsWith(PREFIX);
}
function modelId(model) {
  return String(model || '').slice(PREFIX.length);
}

// ── Binary ────────────────────────────────────────────────────────────────
// CODEX_CLI_PATH, then the npm-global install, then PATH. The hub runs under
// systemd with a thin PATH, so the npm-global location is checked explicitly.

function isExecutable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}

function resolveBinary(env = process.env) {
  if (env.CODEX_CLI_PATH) return isExecutable(env.CODEX_CLI_PATH) ? env.CODEX_CLI_PATH : null;
  const home = env.HOME || os.homedir();
  const candidates = [
    env.NPM_CONFIG_PREFIX && path.join(env.NPM_CONFIG_PREFIX, 'bin', 'codex'),
    path.join(home, '.npm-global', 'bin', 'codex'),
    path.join(home, '.local', 'bin', 'codex'),
    ...String(env.PATH || '').split(path.delimiter).filter(Boolean).map(d => path.join(d, 'codex')),
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
  ].filter(Boolean);
  return candidates.find(isExecutable) || null;
}

// ── Sandbox ───────────────────────────────────────────────────────────────
// Codex's own sandbox (bubblewrap on Linux) needs unprivileged user namespaces,
// which Ubuntu's AppArmor blocks by default; every shell command then fails.
// Hub agents therefore default to full access, the same access claude-sdk
// agents get through Bash. HUB_CODEX_SANDBOX=workspace-write|read-only opts
// in to Codex's sandbox on hosts where it works. Read-scoped temporal workers
// always get read-only: a sandbox that blocks everything is still a correct
// read-only, a full-access one is not.

const SANDBOXES = new Set(['read-only', 'workspace-write', 'danger-full-access']);

function sandboxFor({ toolScope = null, env = process.env } = {}) {
  if (toolScope === 'read' || toolScope === 'none') return 'read-only';
  const s = env.HUB_CODEX_SANDBOX;
  return SANDBOXES.has(s) ? s : 'danger-full-access';
}

// ── argv ──────────────────────────────────────────────────────────────────

// TOML basic string: JSON string escaping is a valid subset.
const tomlString = (s) => JSON.stringify(String(s));

/**
 * @param {object} o
 * @param {string} o.model           bare Codex model slug (no prefix)
 * @param {string} [o.resumeId]      thread id to continue
 * @param {string} o.cwd             agent workspace
 * @param {string} o.sandbox         read-only | workspace-write | danger-full-access
 * @param {string} [o.instructions]  agent context, sent as developer instructions
 * @param {object} [o.bridge]        { file, url } for the hub-tools MCP server
 * @param {string[]} [o.images]      image paths
 * @param {string} [o.nodePath]      node binary for the MCP bridge
 * @param {string} [o.effort]        model_reasoning_effort (lib/effort)
 * @param {string} [o.reasoningSummary]  model_reasoning_summary ('auto' while the reasoning panel is on)
 */
function buildArgs({ model, resumeId, cwd, sandbox, instructions, bridge, images = [], nodePath = process.execPath, effort = null, reasoningSummary = null }) {
  const args = ['exec'];
  if (resumeId) args.push('resume', resumeId);
  args.push('--json', '--skip-git-repo-check');
  if (model) args.push('-m', model);
  // `exec resume` has no -s/-C: sandbox goes through config, cwd through spawn().
  if (!resumeId && cwd) args.push('-C', cwd);
  if (sandbox === 'danger-full-access') args.push('--dangerously-bypass-approvals-and-sandbox');
  else args.push('-c', `sandbox_mode=${tomlString(sandbox || 'read-only')}`, '-c', 'approval_policy="never"');
  if (instructions) args.push('-c', `developer_instructions=${tomlString(instructions)}`);
  if (effort) args.push('-c', `model_reasoning_effort=${tomlString(effort)}`);   // lib/effort
  if (reasoningSummary) args.push('-c', `model_reasoning_summary=${tomlString(reasoningSummary)}`);   // the reasoning panel
  if (bridge) {
    args.push(
      '-c', `mcp_servers.agent-hub.command=${tomlString(nodePath)}`,
      '-c', `mcp_servers.agent-hub.args=[${tomlString(MCP_BRIDGE_SCRIPT)}]`,
      '-c', `mcp_servers.agent-hub.env={HUB_CODEX_BRIDGE_FILE=${tomlString(bridge.file)}}`,
      '-c', 'mcp_servers.agent-hub.tool_timeout_sec=3600',
      '-c', 'mcp_servers.agent-hub.supports_parallel_tool_calls=true',
    );
  }
  for (const img of images) args.push('-i', img);
  args.push('-');   // prompt on stdin: no argv size limit, no shell quoting
  return args;
}

// Linux caps a single argv string at 128 KiB (MAX_ARG_STRLEN). Agent context
// larger than this goes into the prompt instead of developer_instructions.
const MAX_INSTRUCTIONS_ARG = 120 * 1024;

// ── Event parsing ─────────────────────────────────────────────────────────
// `codex exec --json` prints one JSON object per line:
//   thread.started {thread_id} | turn.started | turn.completed {usage} |
//   turn.failed {error} | error {message} |
//   item.started / item.updated / item.completed {item}
// item.type: agent_message {text} | reasoning {text} |
//   command_execution {command, aggregated_output, exit_code, status} |
//   mcp_tool_call {server, tool, arguments, result, error, status} |
//   file_change {changes} | web_search {query} | todo_list {items} | error {message}

function parseLine(line) {
  const s = String(line || '').trim();
  if (!s || s[0] !== '{') return null;
  try { return JSON.parse(s); } catch { return null; }
}

function toolNameOf(item) {
  switch (item.type) {
    case 'command_execution': return 'Bash';
    case 'mcp_tool_call': return item.server === 'agent-hub' ? item.tool : `${item.server}__${item.tool}`;
    case 'file_change': return 'Edit';
    case 'web_search': return 'WebSearch';
    default: return item.type;
  }
}

function toolInputOf(item) {
  if (item.type === 'command_execution') return String(item.command || '').slice(0, 160);
  if (item.type === 'web_search') return String(item.query || '');
  if (item.type === 'file_change') return (item.changes || []).map(c => `${c.kind || 'edit'} ${c.path}`).join(', ').slice(0, 160);
  if (item.type === 'mcp_tool_call') {
    const a = item.arguments || {};
    return String(a.agent || a.query || a.section || a.topic || a.name || JSON.stringify(a)).slice(0, 160);
  }
  return '';
}

function toolOutputOf(item) {
  if (item.type === 'command_execution') {
    const out = String(item.aggregated_output || '');
    return (item.exit_code && item.exit_code !== 0 ? `exit ${item.exit_code}\n` : '') + out.slice(-2000);
  }
  if (item.type === 'mcp_tool_call') {
    if (item.error) return `Error: ${item.error.message || JSON.stringify(item.error)}`;
    const content = item.result?.content || [];
    return content.map(c => c.text || '').join('\n').slice(0, 2000) || 'Done';
  }
  if (item.type === 'file_change') return (item.changes || []).map(c => `${c.kind || 'edit'} ${c.path}`).join('\n') || 'Done';
  return 'Done';
}

const TOOL_ITEMS = new Set(['command_execution', 'mcp_tool_call', 'file_change', 'web_search']);

/**
 * Turn one Codex event into zero or more hub actions:
 *   {kind:'session', id} | {kind:'text', text} | {kind:'tool_start', id, tool, input}
 *   {kind:'tool_result', id, tool, output} | {kind:'usage', usage} | {kind:'error', message}
 *   {kind:'thinking'} | {kind:'reasoning', text}
 */
function eventToActions(ev) {
  if (!ev || typeof ev !== 'object') return [];
  switch (ev.type) {
    case 'thread.started': return ev.thread_id ? [{ kind: 'session', id: ev.thread_id }] : [];
    case 'turn.completed': return [{ kind: 'usage', usage: ev.usage || {} }];
    case 'turn.failed': return [{ kind: 'error', message: ev.error?.message || 'Codex turn failed' }];
    case 'error': return [{ kind: 'error', message: ev.message || 'Codex error' }];
    case 'item.started': {
      const it = ev.item || {};
      if (TOOL_ITEMS.has(it.type)) return [{ kind: 'tool_start', id: it.id, tool: toolNameOf(it), input: toolInputOf(it) }];
      if (it.type === 'reasoning') return [{ kind: 'thinking' }];
      return [];
    }
    case 'item.completed': {
      const it = ev.item || {};
      if (it.type === 'agent_message') return it.text ? [{ kind: 'text', text: it.text }] : [];
      if (it.type === 'reasoning') return it.text ? [{ kind: 'reasoning', text: it.text, item: it.id }] : [];
      if (TOOL_ITEMS.has(it.type)) return [{ kind: 'tool_result', id: it.id, tool: toolNameOf(it), input: toolInputOf(it), output: toolOutputOf(it) }];
      if (it.type === 'error') return [{ kind: 'error', message: it.message || 'Codex error', soft: true }];
      return [];
    }
    default: return [];
  }
}

/** Codex's usage block → context tokens actually sent on the last request. */
function contextTokensOf(usage) {
  return (usage?.input_tokens || 0);
}

// ── Session map (per agent; separate from the Claude one so a model switch
// never hands a Claude session id to Codex or the other way round) ─────────

function loadSessions(file = SESSION_MAP_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function saveSessions(map, file = SESSION_MAP_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(map, null, 2));
}
function getSession(agentName, model, file) {
  const s = loadSessions(file)[agentName];
  // A thread belongs to the model it started on; switching models starts fresh.
  return s && s.threadId && (!model || s.model === model) ? s.threadId : null;
}
function setSession(agentName, threadId, model, file) {
  const map = loadSessions(file);
  map[agentName] = { threadId, model, timestamp: new Date().toISOString() };
  saveSessions(map, file);
}
function clearSession(agentName, file) {
  const map = loadSessions(file);
  if (map[agentName]) { delete map[agentName]; saveSessions(map, file); }
}

// ── Discovery ─────────────────────────────────────────────────────────────

function run(bin, args, { timeoutMs = 20000, env = process.env } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, env, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** Logged in with a ChatGPT subscription? Never reads the credential file itself. */
async function loginStatus({ bin = resolveBinary(), env } = {}) {
  if (!bin) return { installed: false, loggedIn: false, mode: null, detail: 'codex CLI not found (npm i -g @openai/codex)' };
  const r = await run(bin, ['login', 'status'], { env });
  const text = (r.stdout + r.stderr).trim();
  const chatgpt = /ChatGPT/i.test(text);
  return { installed: true, loggedIn: r.ok && /logged in/i.test(text), mode: chatgpt ? 'chatgpt' : (/API key/i.test(text) ? 'apikey' : null), detail: text.split('\n')[0].slice(0, 200) };
}

/** Listable models from the CLI's own catalog. [] when not installed / not logged in. */
async function discoverModels({ bin = resolveBinary(), env } = {}) {
  if (!bin) return [];
  const status = await loginStatus({ bin, env });
  if (!status.loggedIn) return [];
  const r = await run(bin, ['debug', 'models'], { env });
  if (!r.ok) return [];
  try {
    const models = JSON.parse(r.stdout).models || [];
    return models
      .filter(m => m && m.slug && m.visibility !== 'hide')
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
      .map(m => ({ id: m.slug, display: m.display_name || m.slug, description: m.description || '', contextWindow: m.context_window || null }));
  } catch { return []; }
}

/** Approval policy for hub turns: 'untrusted' routes every non-trivial shell command and file change through the
 *  hub's tool policy (lib/policy-gate); HUB_CODEX_APPROVALS=never restores unprompted execution. */
function approvalPolicyFor(env = process.env) {
  const v = String(env.HUB_CODEX_APPROVALS || 'untrusted');
  return ['never', 'untrusted', 'on-request', 'on-failure'].includes(v) ? v : 'untrusted';
}

module.exports = {
  approvalPolicyFor,
  PREFIX, SESSION_MAP_FILE, MCP_BRIDGE_SCRIPT, MAX_INSTRUCTIONS_ARG,
  isCodexCliModel, modelId, resolveBinary, sandboxFor, buildArgs,
  parseLine, eventToActions, contextTokensOf,
  toolNameOf, toolInputOf, toolOutputOf, TOOL_ITEMS,
  getSession, setSession, clearSession, loadSessions,
  loginStatus, discoverModels,
};
