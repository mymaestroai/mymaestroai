'use strict';

/**
 * sdk-chat.js — Chat engine for My Maestro AI
 *
 * Routes all LLM traffic through multi-provider LLM routing.
 * Handles streaming, tool calling, conversation management, agent consultation,
 * and auto-memory. No direct vendor API keys — everything via gateway.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { chatCompletionStream, parseSSEStream, chatCompletion, supportsImages } = require('./gateway-client');
const { accumulateToolCallDelta } = require('./tool-call-deltas');
const consultQueue = require('./consult-queue');                   // a consult to a busy agent is queued, not dropped
const contextWindow = require('./context-window');                 // real window per SDK model (200K vs 1M)
const walletTools = require('./wallet/tools');             // on-chain wallet: only for agents in settings.walletAgents (default: trader)
const commsTools = require('./comms/tools');              // messaging channels (Telegram etc): only for agents listed per-channel
const temporalWorkers = require('./temporal-workers');
const contextRefresh = require('./context-refresh');
const effortLib = require('./effort');   // per-agent reasoning effort, translated per route
async function agentEffort(agentName) { try { const a = (await getAgents()).find(x => x.name === agentName); return a ? a.effort : 'default'; } catch { return 'default'; } }   // resumed Claude-client sessions: send what changed in their context   // ephemeral workers on any reachable model (spawn_workers)
const SDK_PERMISSION_MODE = ['acceptEdits', 'bypassPermissions'].includes(process.env.HUB_AGENT_PERMISSION_MODE)
  ? process.env.HUB_AGENT_PERMISSION_MODE : 'acceptEdits';
const jobs = require('./jobs');                          // detached jobs that outlive a turn and wake the agent when done (run_job)
const hubHalt = require('./hub-halt');                 // hub-wide kill switch flag (data/hub-halt.json)
const consultImages = require('./consult-images');     // images attached to consult_agent / spawn_workers
const scheduledTasks = require('./scheduled-tasks');     // one-off / recurring tasks that wake an agent later (schedule_task)
const codexCli = require('./codex-cli');                // codex-cli/<model>: OpenAI models on the owner's ChatGPT subscription via the Codex CLI
const codexBridge = require('./codex-cli/bridge');      // hub tools for Codex, served over a per-turn MCP bridge
const appServer = require('./codex-cli/app-server');    // `codex app-server` transport: live turn/steer + turn/interrupt
const HUB_PKG_VERSION = require('../package.json').version;
const { spawn } = require('child_process');
const hubEvents = require('./hub-events');               // SSE stream of hub-initiated turns for open browser windows (/api/events)
const providerPacing = require('./provider-pacing');
const errorHelp = require('./error-help');   // provider errors in plain words for the reply text
const modelHealth = require('./model-health').getModelHealth();   // what each model has done here: marks in the pickers
const hubAuthMod = require('./auth');                   // service token for the hub's own loopback calls
const agentRequestsMod = require('./agent-requests');   // members' agents ask the admin for more agents
const access = require('./access');                     // owner scoping (members' agents only see their own)     // parallel delegation paced per provider: trip to serial on failure, retry, ramp back
// One pacing instance for every fan-out path (consult_agent, spawn_workers, stand-ins). Its events go on
// /api/events (desktop + mobile banners, web push) and its state into /api/hub/status and status_snapshot.
const pacing = providerPacing.getPacing({ onEvent: (ev) => { try { hubEvents.events.publish(ev.type, ev); } catch {} } });
const pacingLimiter = { run: (provider, fn, opts) => pacing.run(provider, fn, opts) };
// Per-agent tool policy + action-level approvals + spend ledger (lib/tool-policy, lib/approvals, lib/ledger,
// lib/policy-gate). One gate for every path: Claude SDK PreToolUse hook, gateway tool loop, Codex bridge and
// Codex command approvals. Approval events go on /api/events (cards on desktop and mobile, web push).
const toolPolicy = require('./tool-policy');
const planUsage = require('./plan-usage');   // subscription usage windows + automatic model fallback at the weekly limit
const approvalsMod = require('./approvals');
const ledgerMod = require('./ledger');
const policyGate = require('./policy-gate');
const allowances = toolPolicy.createAllowances();
const approvals = approvalsMod.getApprovals({ allowances, onEvent: (ev) => { try { hubEvents.events.publish(ev.type, ev); } catch {} },
  timeoutMs: () => { let m = 60; try { m = Number(require('./settings').getSetting('approvalTimeoutMinutes', 60)); } catch {} return (Number.isFinite(m) && m > 0 ? m : 60) * 60000; } });
const ledger = ledgerMod.getLedger({ getCaps: () => { try { return require('./settings').getSetting('ledger', {}) || {}; } catch { return {}; } } });
const sessionCostSeen = new Map();   // `${agent}|${sessionId}` -> last total_cost_usd the SDK reported (session running total)
const transcript = require('./transcript').getTranscript();   // every turn of every agent, searchable (lib/transcript)
const records = require('./records');                            // always-loaded per-agent documents (lib/records)
// Agent-authored context compression (lib/compaction): the agent writes its own carry-forward; the hub
// resets the provider session only when the agent's compaction mode is 'on'.
const contextBudget = require('./context-budget');                 // elastic prompt assembly for gateway/local models
const compaction = require('./compaction').getCompaction({
  post: (agent, message) => postHubTurn(agent, message, { origin: { kind: 'task', from: 'hub', label: 'context compression' } }),
  resetSession: async (agent) => { clearAgentSessionId(agent); },   // gateway agents have no session: their recent window restarts at compactedAt
  getAgent: (name) => { try { return require('./agents').getAgentsSync().find(a => a.name === name) || null; } catch { return null; } },
  getSetting: (k) => { try { return require('./settings').getSetting(k); } catch { return undefined; } },
  onEvent: (ev) => { try { hubEvents.events.publish(ev.type, ev); } catch {} },
  // A session is only closed when the agent's brief was really written during the compression run.
  briefStatus: async (agent) => { try { const st = fs.statSync(path.join(records.folderFor(agent), require('./compaction').BRIEF_FILE)); return { exists: true, bytes: st.size, mtimeMs: st.mtimeMs }; } catch { return { exists: false, bytes: 0, mtimeMs: 0 }; } },
  // Assisted mode: the recent transcript since the last compression, oldest first, and slice size from the model's window.
  getRecentRows: async (agent, { since = null } = {}) => transcript.search(agent, '', { kinds: ['user', 'assistant'], from: since, limit: 100 }).reverse(),
  chunkCharsFor: async (agent) => {
    try {
      const rec = require('./agents').getAgentsSync().find(a => a.name === agent) || {};
      const { window } = await contextBudget.windowForAgent(rec, rec.model, { lmStudioUrl: (() => { try { return require('./settings').getProviderUrl('lmstudio'); } catch { return null; } })(), ninferUrl: (() => { try { return require('./settings').getProviderUrl('ninfer'); } catch { return null; } })() });
      return contextBudget.tokensToChars(Math.round(window * 0.35));
    } catch { return 12000; }
  },
});
/** A hub-started, non-ephemeral turn for an agent over the loopback chat endpoint; resolves with the reply text. */
function postHubTurn(agent, message, { origin = { kind: 'task', from: 'hub' } } = {}) {
  return new Promise((resolve, reject) => {
    const auth = require('./auth');
    const body = JSON.stringify({ agent, message, origin });
    const req = require('http').request({ hostname: '127.0.0.1', port: parseInt(process.env.PORT || '8888', 10), path: '/api/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), [auth.SERVICE_HEADER]: auth.SERVICE_TOKEN } }, (res) => {
      let data = ''; res.on('data', c => { data += c; }); res.on('end', () => { try { resolve(JSON.parse(data).response || ''); } catch { resolve(''); } });
    });
    req.on('error', reject); req.setTimeout(30 * 60 * 1000, () => req.destroy(new Error('hub turn timed out')));
    req.write(body); req.end();
  });
}
const agentRequests = agentRequestsMod.getAgentRequests({
  onEvent: (ev) => { try { hubEvents.events.publish(ev.type, ev); } catch {} },
  createTeam: (o) => require('./teams').createTeamForUser(o),
  createAgent: (name, model, personality, skills, category, owner) => require('./agents').createAgent(name, model, personality, skills, category, owner),
  appendLog: (agent, role, text) => appendConversationLog(agent, role, text),
  getUser: (id) => { try { return hubAuthMod.getAuth().getUser(id); } catch { return null; } },
  defaultModel: () => { try { return require('./settings').getSetting('memberDefaultModel', 'claude-sdk/claude-sonnet-5-5'); } catch { return 'claude-sdk/claude-sonnet-5-5'; } },
});
const REQUEST_AGENT_DESC = 'Ask the hub administrator for a new permanent agent or a whole team (medical or legal) for the person you work for. You cannot create agents yourself; for a short parallel task use spawn_workers instead. Give a clear description of what it is for; the administrator approves or declines and a hub notice appears in your chat.';
const RENAME_ME_DESC = 'Change your own display name (what the person you work for sees). Use it when they tell you what to call you.';
async function handleRequestAgent(agentName, { kind, name, description }) {
  const r = agentRequests.create({ byAgent: agentName, ownerId: await ownerOfAgent(agentName), kind, name, description });
  return r.ok ? `Request filed (${r.request.id}). The administrator will approve or decline it; you will see a hub notice here. Tell the person it is in and carry on.` : `Could not file the request: ${r.error}`;
}
// generate_image: a picture from an image model (Google / OpenAI), saved in the agent's Files folder (lib/image-gen).
async function filesRootFor(agentName) {
  const agents = await getAgents();
  const rec = agents.find(a => a.name === agentName) || { name: agentName };
  const owner = await ownerOfAgent(agentName).catch(() => null);
  const memberOwned = !!(owner && !adminIdSet().has(String(owner)));
  return require('./files').getFiles().rootForAgent(rec, { memberOwned });
}
async function handleGenerateImage(agentName, args = {}) {
  const imageGen = require('./image-gen');
  try {
    const root = await filesRootFor(agentName);
    const r = await imageGen.getImageGen({ getProviderKey: (p) => require('./settings').getProviderKey(p), getSetting: (k, d) => require('./settings').getSetting(k, d) })
      .generate({ agentName, root, extraRoots: [await getAgentWorkspace(agentName)], prompt: args.prompt, provider: args.provider, quality: args.quality, size: args.size, reference: args.reference || null, filename: args.filename || null, log: console.log });
    try { require('./hub-events').events.publish('image_made', { agent: agentName, path: r.path, provider: r.provider, model: r.model, bytes: r.bytes, ms: r.ms }); } catch {}
    return imageGen.describe(r);
  } catch (e) {
    return `[NO IMAGE] ${e.message}`;
  }
}
const GENERATE_IMAGE_DESC = 'Make a picture (photo, illustration, icon, concept art) from a description with an image model, or edit a reference image from your Files folder or workspace. The file is saved in your Files folder and the reply gives you the markdown line to paste so the chat shows it. Google (Gemini image) by default; provider "openai" for the GPT image model. quality "best" for the top tier. Not for charts or diagrams: draw those yourself (chart / mermaid / svg blocks or matplotlib).';
const GENERATE_IMAGE_PROPS = {
  prompt: { type: 'string', description: 'What the picture should show: subject, style, composition, lighting, text to include. Be concrete.' },
  provider: { type: 'string', enum: ['google', 'openai'], description: 'Image model vendor. Default google.' },
  quality: { type: 'string', enum: ['fast', 'best'], description: 'fast (default, cheap, seconds) or best (top model, slower, dearer).' },
  size: { type: 'string', enum: ['square', 'landscape', 'portrait'], description: 'Aspect. Default square.' },
  reference: { type: 'string', description: 'Absolute path of an image in your Files folder or workspace to edit or use as the base (optional).' },
  filename: { type: 'string', description: 'Base name for the saved file (optional; a timestamp and the prompt are used otherwise).' },
};
/** The pictures/charts/diagrams guidance for an agent's instructions (lib/visuals-policy), with its own folder named. */
async function visualsTextFor(agentName) {
  try {
    const root = await filesRootFor(agentName);
    const hasImageTool = !!(require('./settings').getProviderKey('google') || require('./settings').getProviderKey('openai'));
    return require('./visuals-policy').policyText({ filesFolder: root, workspace: await getAgentWorkspace(agentName), hasShell: true, hasImageTool });
  } catch { return require('./visuals-policy').policyText({}); }
}
/** The lead agent's standing brief about this hub (lib/hub-map): a few lines of live facts and where the complete map is. */
async function hubBriefTextFor(agentName) {
  try { return await require('./hub-map').getHubMap().briefFor(agentName); } catch { return ''; }
}
async function handleRenameMe(agentName, { display }) {
  const d = String(display || '').trim().slice(0, 40);
  if (!d) return 'Give a name.';
  const r = await require('./agents').setAgentDisplay(agentName, d);
  return r.success ? `You are now called "${d}".` : `Could not rename: ${r.error}`;
}
const gate = policyGate.createGate({
  getAgent: async (name) => {
    try {
      const all = await getAgents();
      const own = all.find(a => a.name === name);
      if (own) return own;
      // A temporary worker keeps the worker role but carries its parent's OWNER, so a member's workers are bound
      // like the member's own agents (review F16). Roots are not inherited: a worker stays a worker.
      const v = temporalWorkers.getVirtual(name);
      const parent = v && v.parent ? all.find(a => a.name === v.parent) : null;
      return parent ? { name, category: 'worker', owner: parent.owner || null, virtualOf: parent.name } : { name, category: 'worker' };
    } catch { return { name, category: 'worker' }; }
  },
  isWalletAgent: (name) => { try { return walletTools.isWalletAgent(name); } catch { return false; } },
  isMemberOwned: (agent) => !!(agent && agent.owner && !adminIdSet().has(String(agent.owner))),
  approvals, allowances, ledger,
  enabled: () => { try { return require('./settings').getSetting('toolPolicy', true) !== false; } catch { return true; } },
  // Approval cards are OFF unless the owner turns them on in Settings: an "ask" is allowed silently.
  approvalsOn: () => { try { return require('./settings').getSetting('approvalsEnabled', false) === true; } catch { return false; } },
  // ...except for the classes the owner lists (e.g. ['sudo', 'money']): those get a card even while cards are off overall.
  approvalClasses: () => { try { const a = require('./settings').getSetting('approvalClasses', []); return new Set(Array.isArray(a) ? a : []); } catch { return new Set(); } },
  // The operator's time-limited root grant for an agent (lib/root-grants): without one, root is the lead agent's alone.
  rootGranted: (name) => { try { return require('./root-grants').getRootGrants().active(name); } catch { return null; } },
});
const { loadAgentContext, getAgentModel, isAutoModel, getAgentWorkspace, getAgents, createAgent, isLeadAgent, leadAgentNames } = require('./agents');
const { selectModel, selectModelAndTools, noticeFor } = require('./auto-model');
const { BUILTIN_TOOLS, executeToolCall } = require('./provider-tools');
const memoryDb = require('./memory-db');
const { getSkillTools } = require('./skills/skill-manager');
const connectorsLib = require('./connectors');
const sandboxLib = require('./sandbox');
const hubToolsLib = require('./hub-tools');
const clientWatch = require('./client-watch');                 // the hub spawns the Claude client and reaps shell commands that outlive the reply                   // the hub's own hands: Bash/Read/Write/Edit/Glob/Grep/Web*, one implementation for every path                      // per-agent containers: shell and files inside, hub tools outside                 // data connectors: outside services with per-agent grants and passphrases
function connectorsTextFor(agentName) { try { const t = connectorsLib.getConnectors().contextTextFor(agentName); return t ? `\n\n${t}\n` : ''; } catch { return ''; } }
const { recordToolError, getToolGuidance, getInlineErrorGuidance, cacheSchema } = require('./tool-learning');
const { saveUploadedImage, imagesToAnthropicFormat, imagePathsToUrls, parseMediaLines } = require('./images');
const ttRecovery = require('./tiger-team-recovery');
const ttArtifacts = require('./tiger-team-artifacts');
const { isConcurrencySafe, executeToolCallsBatched } = require('./tool-concurrency');
const ttStore = new ttRecovery.CheckpointStore();
function checkpointTeam(id) { const state = activeTigerTeams.get(id); if (state) ttStore.save(id, state); }

// ── Constants ───────────────────────────────────────────────────────────

const HUB_DIR = path.join(__dirname, '..');
const CONV_DIR = path.join(HUB_DIR, 'data', 'conversations');
const CONV_MAX_MESSAGES = 200;
const MAX_TOOL_TURNS = 200;
const MAX_LENGTH_CONTINUATIONS = 5;
const MAX_CONTEXT_MESSAGES_DEFAULT = 40;
const HEARTBEAT_INTERVAL_MS = 15000;

// Hub port for self-calls (consultation)
const HUB_PORT = parseInt(process.env.PORT || '8888', 10);

// ── Network Resilience ──────────────────────────────────────────────────

function isRetryableLocalError(err) {
  if (!err) return false;
  const msg = err.message || '';
  return msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED') ||
    msg.includes('ETIMEDOUT') || msg.includes('socket hang up') ||
    msg.includes('EPIPE');
}

// ── Claude SDK (OAuth) ──────────────────────────────────────────────────
// When an agent's model starts with "claude-sdk/", we use the Claude Agent SDK
// directly instead of the gateway. The SDK uses OAuth credentials from
// ~/.claude/.credentials.json (Claude Pro/Max subscription).

// Resolved via lib/sdk-loader.js so the hub always runs the newest SDK copy
// installed on this machine (hub-local, npm-global, or CLAUDE_SDK_PATH).
const { loadSdk, cliOptions } = require('./sdk-loader');

// NOTE: SDK uses OAuth by default when running under Claude Code license.
// We no longer delete ANTHROPIC_API_KEY because the gateway-client needs it
// for non-SDK agents and for SDK agent consultations routed through the gateway.

// Session persistence — map agent names to SDK session IDs
const SESSION_MAP_FILE = process.env.HUB_AGENT_SESSIONS_FILE || path.join(HUB_DIR, 'data', 'agent-sessions.json');
const SDK_SESSION_DIR = path.join(
  process.env.HOME || '',
  '.claude/projects',
  '-' + path.resolve(__dirname, '..').replace(/\//g, '-').replace(/^-/, '').replace(/\./g, '-')
);

function loadSessionMap() {
  try { return JSON.parse(fs.readFileSync(SESSION_MAP_FILE, 'utf8')); }
  catch { return {}; }
}
function saveSessionMap(map) {
  try {
    fs.mkdirSync(path.dirname(SESSION_MAP_FILE), { recursive: true });
    fs.writeFileSync(SESSION_MAP_FILE, JSON.stringify(map, null, 2));
  } catch (e) { console.error('[SDK] Failed to save session map:', e.message); }
}
function getAgentSessionId(agentName) {
  return loadSessionMap()[agentName]?.sessionId || null;
}
function setAgentSessionId(agentName, sessionId) {
  const map = loadSessionMap();
  map[agentName] = { sessionId, timestamp: new Date().toISOString() };
  saveSessionMap(map);
}
function clearAgentSessionId(agentName) {
  const map = loadSessionMap();
  delete map[agentName];
  saveSessionMap(map);
  promptCounts.delete(agentName);
}

function isClaudeSdkModel(model) {
  return model && model.startsWith('claude-sdk/');
}

// ── In-Memory State ─────────────────────────────────────────────────────

const conversations = new Map();    // agentName → [{ role, content, tool_calls?, tool_call_id? }]
const activeWorkers = new Map();    // workerId → { abortController, agentName, description, status, startedAt }
const activeResponses = new Map();  // agentName → { fullResponse, startTs, lastSavedLength }
const promptCounts = new Map();  // agentName → number of user prompts in session
const INCREMENTAL_SAVE_INTERVAL_MS = 3000; // Save partial response every 3 seconds
const pendingQuestions = new Map(); // requestId → { resolve, reject }
const ASK_USER_TIMEOUT_MS = 10 * 60 * 1000;
const ASK_USER_UNAVAILABLE = 'ask_user is unavailable in this turn (no live user); state your assumption and continue.';
const ASK_USER_DESCRIPTION = "Ask the person you are talking to ONE question and wait for the answer, inside the current turn. Use it for live interviews: one question at a time, adapt the next question to the answer. Returns the answer text, or 'SKIPPED' if they skipped, or 'NO_ANSWER' if nobody answered within the timeout (then stop asking and wrap up). Not available when you were consulted by another agent.";
const ASK_USER_PARAMS = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'The single question to ask' },
    options: { type: 'array', items: { type: 'string' }, description: 'Optional 2-6 short choices shown as buttons; the person can always type something else' },
    header: { type: 'string', description: 'Optional short label (max 30 chars) shown above the question, e.g. "Residence"' },
    allow_skip: { type: 'boolean', description: 'Add a Skip choice (default true)' },
  },
  required: ['question'],
};
const pendingToolConfirms = new Map(); // requestId → { resolve, agent }
const TOOL_CONFIRM_ATTACHED_AUTO_APPROVE_MS = 2 * 60 * 1000;   // a live browser that never answers: approve (long-standing behaviour)
const TOOL_CONFIRM_DETACHED_TIMEOUT_MS = 10 * 60 * 1000;        // nobody is watching: never auto-approve, deny after 10 minutes
// agentName → { turnId, origin, startedAt, detached, abortController }; one entry per running non-ephemeral turn,
// set in handleChatStreamReserved and removed in its finally.
const turnRegistry = new Map();
const ephemeralTurns = new Set();   // abort controllers of running ephemeral turns (workers), which have no turnRegistry entry: the kill switch aborts them too
const questionAgents = new Map();   // ask_user request_id → agentName
let testStreamer = null;            // tests only: replaces the model call inside handleChatStreamReserved
const interjectionQueues = new Map(); // agentName → [{ message, ts }]
const codexTurns = new Set(); // agents with a Codex CLI turn running (interjections become follow-up turns)
// SDK agents: the live input channel of the running turn, so a new interjection can be pushed into it.
const sdkInterject = require('./sdk-interject');
const workerPolicy = require('./worker-policy');   // platform agents first; SDK sub-workers per the sdkWorkers setting
const { SdkWorkerTracker } = require('./sdk-workers');   // which SDK message belongs to which sub-agent, and when one finishes
const sdkInterjectChannels = new Map(); // agentName → SdkInterjectionChannel
const codexSteerChannels = new Map();   // agentName → SteerPump of the running Codex app-server turn

// ── Tool Confirmation ──────────────────────────────────────────────────

// Read-only tools that never need confirmation
const READ_ONLY_PATTERNS = [
  /^(Read|Glob|Grep|WebSearch|WebFetch)$/,
  /^read_memory$/, /^write_memory$/, /^append_memory$/, /^write_session_notes$/,
  /^read_session_notes$/, /^read_shared_memory$/, /^write_shared_memory$/, /^search_shared_memory$/,
  /^list_agents$/,
  /^google_workspace__list_/, /^google_workspace__get_/, /^google_workspace__read_/,
  /^google_workspace__search_/,
  /^slack__slack_read_/, /^slack__slack_search_/,
  /^github__get_/, /^github__list_/, /^github__search_/, /^github__pull_request_read$/,
  /^github__issue_read$/,
  /^sequential_thinking__/,
];

function isReadOnlyTool(toolName) {
  return READ_ONLY_PATTERNS.some(p => p.test(toolName));
}

function resolveToolConfirm(requestId, approved) {
  const pending = pendingToolConfirms.get(requestId);
  if (pending) {
    pending.resolve(approved);
    pendingToolConfirms.delete(requestId);
  }
}

// ── Conversation Management ─────────────────────────────────────────────

function getConversation(agentName) {
  if (!conversations.has(agentName)) {
    // Restore from disk — preserve ts for age annotation
    const log = loadConversationLog(agentName);
    const msgs = log.filter(m => m && m.role).map(m => ({ role: m.role, content: m.content, ts: m.ts, ...(m.tiger_team ? { tiger_team: true } : {}) }));
    // If the last message is from the user with no assistant reply, a restart
    // killed the response mid-stream.  Insert a placeholder so the model doesn't
    // re-answer the old prompt on the next turn.
    if (msgs.length > 0 && msgs[msgs.length - 1].role === 'user') {
      msgs.push({ role: 'assistant', content: '[Response was delivered but interrupted by a server restart.  Do not re-answer this prompt.]', ts: new Date().toISOString() });
      // Persist the placeholder so it's there on subsequent loads too
      appendConversationLog(agentName, 'assistant', '[Response was delivered but interrupted by a server restart.  Do not re-answer this prompt.]');
    }
    conversations.set(agentName, msgs);
  }
  return conversations.get(agentName);
}

// "New Session": drop the chat log AND the stored SDK session / Codex thread.
// Clearing only the log left the session map in place, so the next turn
// auto-resumed the old session with its full history.
function clearConversation(agentName) {
  conversations.delete(agentName);
  clearConversationLog(agentName);
  clearAgentSessionId(agentName);
  codexCli.clearSession(agentName);
}

// Trim conversation to fit context window
function trimConversation(messages, agentMaxCtx) {
  // First: merge consecutive same-role user messages (Vertex AI rejects these)
  let merged = [];
  for (const msg of messages) {
    if (merged.length > 0 && msg.role === 'user' && merged[merged.length - 1].role === 'user') {
      // Merge consecutive user messages
      const prev = merged[merged.length - 1];
      const prevText = typeof prev.content === 'string' ? prev.content : JSON.stringify(prev.content);
      const curText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      // Skip exact duplicates
      if (prevText === curText) continue;
      merged[merged.length - 1] = { ...prev, content: prevText + '\n\n' + curText };
    } else {
      merged.push(msg);
    }
  }

  const maxCtx = agentMaxCtx || global.__maxContextMessages || MAX_CONTEXT_MESSAGES_DEFAULT;
  if (merged.length <= maxCtx) return merged;
  // Keep recent messages, but never break tool_call/tool_result pairs
  let trimmed = merged.slice(-maxCtx);
  // If the first message is a tool result, it's orphaned — walk forward until we
  // find a non-tool message or reach a matching assistant tool_call
  while (trimmed.length > 1 && trimmed[0].role === 'tool') {
    trimmed = trimmed.slice(1);
  }
  // If the first message is an assistant with tool_calls but no following tool results,
  // also remove it to avoid dangling references
  if (trimmed.length > 1 && trimmed[0].role === 'assistant' &&
      trimmed[0].tool_calls && trimmed[0].tool_calls.length > 0) {
    const nextIsToolResult = trimmed[1] && trimmed[1].role === 'tool';
    if (!nextIsToolResult) {
      trimmed = trimmed.slice(1);
    }
  }
  return trimmed;
}

// Annotate historical messages with age labels and wrap current message
// Time label for a past message. ABSOLUTE ("[Oct 14 13:05]"), never relative: "[5m ago]" changed on every turn,
// which made every past message different on every call, so no provider could reuse the conversation from
// its prompt cache (Anthropic, OpenAI, Gemini, NInfer/LM Studio prefix caches). The current request carries
// the time now, so the model can still tell how old each message is.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function stampLabel(ms, withYear = false) {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${withYear ? ` ${d.getFullYear()}` : ''} ${hm}`;
}

// annotateForContext(messages, { hubContext, now }): past messages get their time; the last one (the current
// request) is wrapped, stamped with the current time and preceded by hubContext (per-message search hits),
// which therefore never sits in the system prompt where it would break caching of everything after it.
function annotateForContext(messages, { hubContext = '', now = Date.now() } = {}) {
  if (messages.length === 0) return messages;
  const result = [];
  // All messages except the last are historical context
  for (let i = 0; i < messages.length - 1; i++) {
    const m = messages[i];
    if (!m || !m.role) continue;
    const annotated = { role: m.role };
    const t = m.ts ? new Date(m.ts).getTime() : NaN;
    const ageLabel = Number.isFinite(t) && t < now ? `[${stampLabel(t)}]` : '';
    // Annotate text content with its time
    if (typeof m.content === 'string') {
      annotated.content = ageLabel ? `${ageLabel} ${m.content}` : m.content;
    } else if (Array.isArray(m.content)) {
      // Multipart — annotate first text part only
      annotated.content = m.content.map((part, idx) => {
        if (part.type === 'text' && idx === 0 && ageLabel) {
          return { ...part, text: `${ageLabel} ${part.text}` };
        }
        return part;
      });
    } else {
      annotated.content = m.content;
    }
    // Preserve tool_calls if present
    if (m.tool_calls) annotated.tool_calls = m.tool_calls;
    if (m.tool_call_id) annotated.tool_call_id = m.tool_call_id;
    result.push(annotated);
  }
  // Last message is the CURRENT request — wrap with XML boundary, the time now, and the hub's context for it
  const current = messages[messages.length - 1];
  const wrapped = { role: current.role };
  const pre = hubContext ? `<hub_context>\n${hubContext}\n</hub_context>\n` : '';
  const open = `<current_request sent="${stampLabel(now, true)}">`;
  if (typeof current.content === 'string') {
    wrapped.content = `${pre}${open}\n${current.content}\n</current_request>`;
  } else if (Array.isArray(current.content)) {
    let first = true;
    wrapped.content = current.content.map(part => {
      if (part.type === 'text') {
        const out = { ...part, text: `${first ? pre : ''}${open}\n${part.text}\n</current_request>` };
        first = false;
        return out;
      }
      return part;
    });
    if (first && pre) wrapped.content = [{ type: 'text', text: pre.trim() }, ...wrapped.content];
  } else {
    wrapped.content = current.content;
  }
  if (current.tool_calls) wrapped.tool_calls = current.tool_calls;
  if (current.tool_call_id) wrapped.tool_call_id = current.tool_call_id;
  result.push(wrapped);
  return result;
}

// Drop old messages in blocks, not one per turn: a window that slides by one message each turn changes the
// start of the conversation every time and defeats prompt caching. Aligning the first kept message to a
// multiple of CACHE_TRIM_STEP keeps the same opening for several turns; it only ever drops MORE (so budgets
// still hold), and the window still starts on a user message.
const CACHE_TRIM_STEP = 12;
function stableTrim(trimmed, totalCount, step = CACHE_TRIM_STEP) {
  const start = totalCount - trimmed.length;
  if (start <= 0 || trimmed.length <= 1) return trimmed;
  const aligned = Math.ceil(start / step) * step;
  let out = trimmed.slice(Math.min(aligned - start, trimmed.length - 1));
  while (out.length > 1 && (out[0].role !== 'user')) out = out.slice(1);
  return out.length ? out : trimmed.slice(-1);
}

// ── Conversation Log (Disk Persistence) ─────────────────────────────────

if (!fs.existsSync(CONV_DIR)) fs.mkdirSync(CONV_DIR, { recursive: true });

// The origin fields worth keeping in the conversation log (short strings only).
function logOriginOf(origin) {
  const out = {};
  for (const k of ['kind', 'from', 'jobName', 'taskId']) if (typeof origin[k] === 'string' && origin[k]) out[k] = origin[k].slice(0, 200);
  return out;
}

function loadConversationLog(agentName, limit = 50) {
  const logFile = path.join(CONV_DIR, `${agentName}.jsonl`);
  try {
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
    const recent = lines.slice(-limit);
    return recent.map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/** Recall hits / context rows as text an agent can read: one entry per line with id, time, kind, tool. */
function formatRecall(rows) {
  if (!Array.isArray(rows) || !rows.length) return '(no matches)';
  return rows.map(r => {
    const when = String(r.ts || '').replace('T', ' ').slice(0, 16);
    const body = r.snippet && !r.hit && r.kind !== 'assistant' ? r.snippet : (r.text || r.snippet || '');
    return `#${r.id} ${when} ${r.kind}${r.tool ? ` (${r.tool})` : ''}${r.hit ? ' <-- hit' : ''}\n${String(body).trim()}`;
  }).join('\n\n');
}

// Text that resumes after a tool call starts a new paragraph (in the stream, the saved reply and the hub's turn
// view alike), so "Checked.<tool>Found it." is never saved as "Checked.Found it.".
function paragraphAfterTool(fullResponse) {
  return fullResponse && !/\n\s*$/.test(fullResponse) ? '\n\n' : '';
}

// The turn's tool calls and workers, kept with the saved reply so history shows them where they happened (the
// pages lay them out like the live stream). Offsets are the hub's (the streamed text's length at each call),
// matched onto the saved text by the text just before each call; capped so a long turn stays a small log line.
const ACTIVITY_SAVE_MAX = 120;
function activityForSave(agentName, savedText) {
  let turn = null;
  try { turn = hubEvents.events.turnFor(agentName); } catch { return null; }
  if (!turn || !Array.isArray(turn.activity) || !turn.activity.length) return null;
  const streamed = String(turn.text || '');
  const saved = String(savedText || '');
  const clipS = (v, n) => { const t = typeof v === 'string' ? v : (v == null ? '' : JSON.stringify(v)); return t.length > n ? t.slice(0, n) + '…' : t; };
  const out = [];
  let lastStream = 0; let lastSaved = 0;
  for (const a of turn.activity) {
    if (!a || (a.kind !== 'tool' && a.kind !== 'worker')) continue;
    let at;
    if (Number.isFinite(a.at)) {
      if (streamed === saved) at = a.at;
      else {
        const before = streamed.slice(lastStream, a.at).slice(-80);
        const i = before ? saved.indexOf(before, lastSaved) : lastSaved;
        if (i >= 0) at = i + before.length;
      }
      if (at !== undefined) { lastSaved = at; lastStream = a.at; }
    }
    const e = { id: a.id, kind: a.kind, status: a.status, ...(at !== undefined ? { at } : {}), ...(a.ts ? { ts: a.ts } : {}), ...(a.doneTs ? { doneTs: a.doneTs } : {}) };
    if (a.kind === 'tool') { e.tool = a.tool; if (a.summary) e.summary = clipS(a.summary, 300); if (a.output) e.output = clipS(a.output, 400); }
    else { e.workerId = a.workerId; if (a.description) e.description = clipS(a.description, 200); if (a.model) e.model = a.model; if (a.agent) e.agent = a.agent; if (a.error) e.error = clipS(a.error, 200); }
    out.push(e);
    if (out.length >= ACTIVITY_SAVE_MAX) break;
  }
  return out.length ? out : null;
}
function activityMeta(agentName, savedText, extra = undefined) {
  const activity = activityForSave(agentName, savedText);
  return activity || extra ? { ...(extra || {}), ...(activity ? { activity } : {}) } : undefined;
}
// A saved piece (after an ask_user question) carries the activity of its own text: offsets past `base`.
function metaForPiece(metadata, base) {
  if (!metadata || !base || !Array.isArray(metadata.activity)) return metadata || {};
  const activity = metadata.activity.filter(a => !Number.isFinite(a.at) || a.at >= base).map(a => (Number.isFinite(a.at) ? { ...a, at: a.at - base } : a));
  return { ...metadata, activity };
}

function appendConversationLog(agentName, role, content, overwriteLast = false, metadata = undefined) {
  if (!content || !content.trim()) return;
  const logFile = path.join(CONV_DIR, `${agentName}.jsonl`);
  const entry = JSON.stringify({ ts: new Date().toISOString(), role, content, ...(metadata || {}) });
  
  if (overwriteLast) {
    // Replace the last line (used for incremental saves of in-progress responses).
    // `content` is always the FULL response so far. When an ask_user question/answer
    // (entries tagged ask) sits between the earlier partial save and now, the earlier
    // text stays where it is and only the text after it is written, as a new entry
    // carrying `base` = how many characters of the response were already logged before it.
    try {
      const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length > 0) {
        try {
          const lastEntry = JSON.parse(lines[lines.length - 1]);
          if (lastEntry.role === 'assistant' && !lastEntry.ask) {
            const base = lastEntry.base || 0;
            const piece = base ? content.slice(base) : content;
            if (!piece.trim()) return;
            lines[lines.length - 1] = JSON.stringify({ ts: new Date().toISOString(), role, content: piece, ...metaForPiece(metadata, base), ...(base ? { base } : {}) });
            fs.writeFileSync(logFile, lines.join('\n') + '\n', 'utf8');
            return;
          }
          if (lastEntry.ask) {
            // Walk back over the question/answer lines to the partial save of this same response.
            let prev = null;
            for (let i = lines.length - 2; i >= 0; i--) {
              const e = JSON.parse(lines[i]);
              if (e.ask) continue;
              prev = e.role === 'assistant' ? e : null;
              break;
            }
            if (prev) {
              const base = (prev.base || 0) + prev.content.length;
              const matches = prev.base ? content.length >= base : content.startsWith(prev.content);
              if (matches) {
                const piece = content.slice(base);
                if (!piece.trim()) return;
                fs.appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), role, content: piece, ...(metadata || {}), base }) + '\n', 'utf8');
                return;
              }
            }
          }
        } catch {}
      }
      // Fallback: just append if we can't parse or last line isn't assistant
      fs.appendFileSync(logFile, entry + '\n', 'utf8');
    } catch {
      fs.appendFileSync(logFile, entry + '\n', 'utf8');
    }
    return;
  }
  
  fs.appendFileSync(logFile, entry + '\n', 'utf8');

  // Periodic trim
  try {
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    if (lines.length > CONV_MAX_MESSAGES * 1.5) {
      const trimmed = lines.slice(-CONV_MAX_MESSAGES);
      fs.writeFileSync(logFile, trimmed.join('\n') + '\n', 'utf8');
    }
  } catch {}
}

function clearConversationLog(agentName) {
  const logFile = path.join(CONV_DIR, `${agentName}.jsonl`);
  try { fs.unlinkSync(logFile); } catch {}
}

// ── SSE Helpers ─────────────────────────────────────────────────────────

function sendSSE(res, data) {
  if (res.ttArchiveId) {
    const state = activeTigerTeams.get(res.ttArchiveId);
    if (state) ttStore.append(res.ttArchiveId, state, { type: 'team_event', data });
  }
  if (res.writableEnded || res.destroyed) {
    // The browser is gone (turn detached): keep the hub event tap fed so the reply still reaches /api/events and push.
    if (typeof res.observeClosed === 'function') { try { res.observeClosed(data); } catch {} }
    return false;
  }
  try {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch (e) { if (e.code === 'TT_PERSISTENCE_FAILED') throw e; return false; }
}

function makeChunk(content, model, gatewayEvent) {
  const chunk = {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta: content ? { content } : {},
      finish_reason: null,
    }],
  };
  if (gatewayEvent) chunk.gateway = gatewayEvent;
  return chunk;
}

function sendSSEHeartbeat(res) {
  if (res.writableEnded || res.destroyed) return;
  try {
    const ok = res.write(': heartbeat\n\n');
    // If write returns false, the buffer is full - client may be gone.
    // Don't destroy yet (backpressure is normal), but if the socket itself
    // errored we'll catch it below.
  } catch (err) {
    // Write failed (EPIPE, ECONNRESET, etc.) - client is gone.
    // Destroy the response to trigger the 'close' event → AbortController fires.
    console.log(`[chat] heartbeat write failed: ${err.code || err.message} - destroying response`);
    try { res.destroy(); } catch {}
  }
}

function sendSSEDone(res) {
  if (res.writableEnded || res.destroyed) return;
  try {
    sendSSE(res, {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'gateway',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    });
    res.write('data: [DONE]\n\n');
  } catch {}
}

function safeEnd(res) {
  if (res.writableEnded || res.destroyed) return;
  try { res.end(); } catch {}
}

// ── Workspace Tools (Memory, Agents) ────────────────────────────────────

function getWorkspaceTools(agentName, sseRes, consultationDepth = 0, tigerTeam = false, signal = null, tigerTeamId = null, consultedBy = null) {
  return [
    ...(tigerTeam && tigerTeamId ? [{
      name: 'read_tiger_team_archive',
      description: 'Read the durable record of THIS Tiger Team, including earlier calls, full tool results, and raw artifacts.  Omit selectors for an index.  Page exact text using next_offset until null.  Prefer saved evidence over repeating completed work.',
      parameters: { type: 'object', properties: {
        call_key: { type: 'string' }, tool_id: { type: 'string' }, artifact: { type: 'string' },
        offset: { type: 'integer' }, limit: { type: 'integer' },
        events_after: { type: 'integer', description: 'Get the next raw journal event after this sequence.  Finish all next_offset pages, then advance to next_event_seq.  Includes model request artifacts and raw stream deltas.' },
      }, required: [] },
      handler: async args => JSON.stringify(ttRecovery.archivePage(ttStore, tigerTeamId, getTigerTeamState(tigerTeamId), args)),
    }] : []),
    {
      name: 'recall',
      description: 'Search your own full transcript archive: every past message, reply, tool call and tool result, kept by the hub in full (not a summary). Use it whenever an answer depends on something from an earlier conversation that is not in your Records or current context; never assume, look. Returns the best matches newest-first with ids for recall_context.',
      parameters: { type: 'object', properties: {
        query: { type: 'string', description: 'Words to search for (names, dates, values, topics)' },
        from: { type: 'string', description: 'Optional start date/time (ISO) to limit the search' },
        to: { type: 'string', description: 'Optional end date/time (ISO)' },
        kinds: { type: 'array', items: { type: 'string', enum: ['user', 'assistant', 'tool_use', 'tool_result', 'system'] }, description: 'Optional: only these kinds of entries' },
        limit: { type: 'integer', description: 'Max matches (default 20, max 100)' },
      }, required: ['query'] },
      handler: async ({ query, from, to, kinds, limit }) => formatRecall(transcript.search(agentName, query, { from, to, kinds, limit })),
    },
    {
      name: 'recall_context',
      description: 'Show the entries around one recall hit (by id): what was said before and after, in full.',
      parameters: { type: 'object', properties: { id: { type: 'integer', description: 'The id from a recall result' }, before: { type: 'integer' }, after: { type: 'integer' } }, required: ['id'] },
      handler: async ({ id, before, after }) => formatRecall(transcript.context(id, { before, after, agents: [agentName] })),
    },
    {
      name: 'compress_context',
      description: 'Ask the hub to run YOUR context compression after this turn: you update your Records and write your working brief; only if your compaction mode is "on" does the hub then start you a fresh session (seeded with Records, recent turns verbatim, and recall). Use it when you judge your working context has grown stale or bloated. Returns what will happen.',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => compaction.request(agentName, 'agent'),
    },
    {
      name: 'record_list',
      description: 'List your Records: documents the hub loads in full into your context on every turn (your source of truth, never searched or trimmed).',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => records.describe(agentName),
    },
    {
      name: 'record_write',
      description: 'Create or replace one of your Records (markdown). Keep them current: facts, numbers, dates, decisions and the reasons for them. Use append=true to add to the end instead of replacing.',
      parameters: { type: 'object', properties: { name: { type: 'string', description: 'File name, e.g. "pat.md" or "positions.md"' }, content: { type: 'string' }, append: { type: 'boolean' } }, required: ['name', 'content'] },
      handler: async ({ name, content, append }) => records.write(agentName, name, content, { append: !!append }),
    },
    {
      name: 'generate_image',
      description: GENERATE_IMAGE_DESC,
      parameters: { type: 'object', properties: GENERATE_IMAGE_PROPS, required: ['prompt'] },
      handler: async (args) => handleGenerateImage(agentName, args),
    },
    {
      name: 'read_memory',
      description: 'Read your long-term memory from the SQLite database. Optionally specify a section to read only that section, or omit to read all sections.',
      parameters: {
        type: 'object',
        properties: {
          section: { type: 'string', description: 'Optional section name to read (e.g. "general", "decisions", "preferences"). Omit to read all.' },
        },
        required: [],
      },
      handler: async ({ section }) => {
        if (section) {
          return memoryDb.readLongTermMemory(agentName, section) || `(no content in section "${section}")`;
        }
        return memoryDb.readLongTermMemory(agentName);
      },
    },
    {
      name: 'write_memory',
      description: 'Replace the content of a memory section in the SQLite database. Use append_memory for incremental additions instead of rewriting everything.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'New content (replaces existing content in the section)' },
          section: { type: 'string', description: 'Section name (default: "general"). Use sections to organize: "general", "decisions", "preferences", "architecture", etc.' },
        },
        required: ['content'],
      },
      handler: async ({ content, section }) => {
        return memoryDb.writeLongTermMemory(agentName, content, section || 'general');
      },
    },
    {
      name: 'append_memory',
      description: 'Append a note to a memory section in the SQLite database. Fast and incremental — use this for quick saves instead of rewriting entire memory.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Content to append' },
          section: { type: 'string', description: 'Section name (default: "general"). Examples: "decisions", "preferences", "bugs", "architecture"' },
        },
        required: ['content'],
      },
      handler: async ({ content, section }) => {
        return memoryDb.appendLongTermMemory(agentName, content, section || 'general');
      },
    },
    {
      name: 'read_session_notes',
      description: 'Read session notes for today or a specific date (YYYY-MM-DD format).',
      parameters: {
        type: 'object',
        properties: { date: { type: 'string', description: 'Date in YYYY-MM-DD format (default: today)' } },
        required: [],
      },
      handler: async ({ date }) => {
        return memoryDb.readSessionNotes(agentName, date);
      },
    },
    {
      name: 'write_session_notes',
      description: 'Append a note to today\'s session memory file.',
      parameters: {
        type: 'object',
        properties: { note: { type: 'string', description: 'The note to append' } },
        required: ['note'],
      },
      handler: async ({ note }) => {
        return memoryDb.writeSessionNote(agentName, note);
      },
    },
    {
      name: 'read_shared_memory',
      description: 'Read from the shared memory pool — a cross-agent knowledge base that all agents can read and write. Pass a topic to search, or omit to list all topics.',
      parameters: {
        type: 'object',
        properties: { topic: { type: 'string', description: 'Topic to search for (optional — omit to list all)' } },
        required: [],
      },
      handler: async ({ topic }) => {
        return memoryDb.readSharedMemory(topic, await sharedPoolOf(agentName));
      },
    },
    {
      name: 'write_shared_memory',
      description: 'Write to the shared memory pool — a cross-agent knowledge base. Other agents can read what you write. Use topics to organize knowledge (e.g. "project-architecture", "user-preferences", "coding-standards").',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Topic name (e.g. "project-architecture", "user-preferences")' },
          content: { type: 'string', description: 'The knowledge to store' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional tags for searchability (e.g. ["typescript", "backend"])',
          },
        },
        required: ['topic', 'content'],
      },
      handler: async ({ topic, content, tags }) => {
        return memoryDb.writeSharedMemory(topic, content, agentName, tags || [], await sharedPoolOf(agentName));
      },
    },
    {
      name: 'search_shared_memory',
      description: 'Search the shared memory pool by keyword. Searches across all topics, content, and tags.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query' } },
        required: ['query'],
      },
      handler: async ({ query }) => {
        return memoryDb.searchSharedMemory(query, await sharedPoolOf(agentName));
      },
    },
    {
      name: 'list_agents',
      description: 'List all agents with name, model, category, busy state and queued consults.',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => describeAgents(agentName),
    },
    {
      name: 'request_agent',
      description: REQUEST_AGENT_DESC,
      parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['agent', 'team'], description: 'agent = one specialist; team = a whole medical or legal team' }, name: { type: 'string', description: 'Short name for the agent (optional)' }, description: { type: 'string', description: 'What it is for, in a few sentences' } }, required: ['kind', 'description'] },
      handler: async (args) => handleRequestAgent(agentName, args || {}),
    },
    {
      name: 'rename_me',
      description: RENAME_ME_DESC,
      parameters: { type: 'object', properties: { display: { type: 'string', description: 'The new display name' } }, required: ['display'] },
      handler: async (args) => handleRenameMe(agentName, args || {}),
    },
    // Wallet tools: only the owner's designated trading agent, only on its OWN turns. When another
    // agent consults it (depth > 0) the tools are withheld, so no agent can trade by asking it to.
    ...((walletTools.isWalletAgent(agentName) && consultationDepth === 0)
      ? walletTools.toolSpecs().map(spec => ({ name: spec.name, description: spec.description, parameters: spec.parameters, handler: (args) => walletTools.runTool(spec, args, agentName) }))
      : []),
    // Comms tools: only agents listed on a channel, only on their own turns (same gating as wallet tools).
    ...((commsTools.isCommsAgent(agentName) && consultationDepth === 0)
      ? commsTools.toolSpecs().map(spec => ({ name: spec.name, description: spec.description, parameters: spec.parameters, handler: (args) => commsTools.runTool(spec.name, args, agentName) }))
      : []),
    // Detached jobs: a temporal worker has no chat to be woken in, so it gets none.
    ...(temporalWorkers.isVirtual(agentName) ? [] : jobs.TOOL_SPECS.map(spec => ({
      name: spec.name, description: spec.description, parameters: jobs.jsonSchema(spec),
      handler: (args) => jobs.runTool(getJobRunner(), spec, agentName, args, { consultedBy }),
    }))),
    ...(temporalWorkers.isVirtual(agentName) ? [] : scheduledTasks.TOOL_SPECS.map(spec => ({
      name: spec.name, description: spec.description, parameters: jobs.jsonSchema(spec),
      handler: (args) => scheduledTasks.runTool(getScheduledTasks(), spec, agentName, args, { consultedBy }),
    }))),
    {
      name: 'ask_user',
      description: ASK_USER_DESCRIPTION,
      parameters: ASK_USER_PARAMS,
      handler: (args) => runAskUser(agentName, sseRes, args, { consultationDepth, signal }),
    },
    {
      name: 'spawn_workers',
      description: temporalWorkers.toolDescription(workerCatalogText()),
      parameters: {
        type: 'object',
        properties: {
          workers: {
            type: 'array', description: 'One entry per worker. They run in parallel.',
            items: {
              type: 'object',
              properties: {
                task: { type: 'string', description: 'Complete, self-contained brief for this worker' },
                model: { type: 'string', description: 'Model id to run this worker on, e.g. "google/gemini-2.5-pro". Omit to use your own model.' },
                tools: { type: 'string', enum: ['read', 'full', 'none'], description: `${temporalWorkers.DEFAULT_SCOPE} (default); one of read, full, none` },
                label: { type: 'string', description: 'Short name shown to the user' },
                images: { type: 'array', items: { type: 'string' }, description: consultImages.IMAGES_DESCRIPTION },
              },
              required: ['task'],
            },
          },
        },
        required: ['workers'],
      },
      handler: async ({ workers }) => {
        if (consultationDepth >= 1) return '[BLOCKED] Workers cannot spawn further workers. Complete the task with the tools you have.';
        return runSpawnWorkers(agentName, workers, sseRes, signal);
      },
    },
    {
      name: 'consult_agent',
      description: workerPolicy.consultDescription(workerPolicy.getMode()),
      parameters: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Name of the agent to consult' },
          prompt: { type: 'string', description: 'The question or task for the agent' },
          images: { type: 'array', items: { type: 'string' }, description: consultImages.IMAGES_DESCRIPTION },
        },
        required: ['agent', 'prompt'],
      },
      handler: async ({ agent, prompt: rawPrompt, images }, recoveryMeta = {}) => {
        // Prevent recursive consultation chains — max depth 1
        if (consultationDepth >= 1) {
          return '[BLOCKED] Cannot consult another agent from within a consultation. Only the original agent can spawn workers. Complete your task with the tools you have.';
        }
        const haltedMsg = hubHalt.getHubHalt().refusal();
        if (haltedMsg) return `[consult_agent] ${haltedMsg}`;
        const imgPrep = prepareConsultImages(images, agentName);
        if (imgPrep.error) return imgPrep.error;
        const prompt = imgPrep.paths.length ? rawPrompt + imgPrep.note : rawPrompt;
        const imageOpts = imgPrep.paths.length ? { imageFiles: imgPrep.paths } : {};
        const workerId = `consult-${agent}-${Date.now()}`;
        try {
          // Get consulted agent's display name and model
          let consultModel = 'unknown';
          let displayName = agent.charAt(0).toUpperCase() + agent.slice(1);
          try { consultModel = await getAgentModel(agent); } catch {}
          try {
            const allAgents = await getAgents();
            const found = allAgents.find(a => a.name === agent);
            if (found && found.display) displayName = found.display;
          } catch {}

          if (tigerTeam && sseRes) {
            // Tiger Team mode: emit structured dispatch event with turn counter
            const ttId2 = tigerTeamId || coordinatorToTigerTeam.get(agentName);
            const ttState2 = ttId2 ? activeTigerTeams.get(ttId2) : null;
            if (ttState2) ttState2.dispatchCount = (ttState2.dispatchCount || 0) + 1;
            sendSSE(sseRes, makeChunk('', 'gateway', {
              type: 'tt_dispatch',
              agent: agent,
              agent_display: displayName,
              model: consultModel,
              task: prompt.slice(0, 200),
              turn: ttState2 ? ttState2.dispatchCount : 0,
              max_rounds: ttState2 ? ttState2.maxRounds : 0,
            }));
          } else if (sseRes) {
            // Normal consultation: create a visible worker tab
            sendSSE(sseRes, makeChunk('', 'gateway', {
              type: 'worker_started',
              worker_id: workerId,
              agent_type: agent,
              description: `Worker: Agent ${displayName}`,
              model: consultModel,
              prompt: prompt,
            }));
          }

          // For Tiger Team: look up the tigerTeamId and pass it through
          const ttId = tigerTeam ? (tigerTeamId || coordinatorToTigerTeam.get(agentName)) : null;

          const result = await consultViaHub(agent, prompt, workerId, sseRes, agentName, 
            tigerTeam ? { inline: true, tigerTeam: true, tigerTeamId: ttId, signal, recoveryKey: recoveryMeta.recoveryKey, ...imageOpts } : imageOpts
          );

          // Accumulate findings in Tiger Team state so subsequent participants see prior results
          if (tigerTeam && ttId) {
            const ttState = activeTigerTeams.get(ttId);
            if (ttState) {
              // Take first ~2000 chars as a summary of findings (longer = better memory on continuation)
              const summary = result.length > 2000 ? result.slice(0, 2000) + '...' : result;
              const dispatchKey = recoveryMeta.recoveryKey || workerId;
              if (!ttState.findings.some(f => f.dispatchKey === dispatchKey)) {
                ttState.findings.push({ agent: displayName, summary, dispatchKey });
                if (!ttState.plainTranscript) ttState.plainTranscript = '';
                ttState.plainTranscript += `\n\n--- ${displayName} ---\n${result}`;
              }
              checkpointTeam(ttId);

              // Pending user messages (mid-run injection) are no longer appended to this
              // tool result.  They are drained from the durable team.pendingMessages queue
              // at the top of the coordinator's tool loop in streamViaGateway() instead.
            }
          }

          if (tigerTeam && sseRes) {
            // Tiger Team mode: emit structured dispatch complete event
            sendSSE(sseRes, makeChunk('', 'gateway', {
              type: 'tt_dispatch_complete',
              agent: agent,
              agent_display: displayName,
            }));
          } else if (sseRes) {
            // Normal consultation: emit worker_completed
            sendSSE(sseRes, makeChunk('', 'gateway', {
              type: 'worker_completed',
              worker_id: workerId,
            }));
          }

          return result;
        } catch (e) {
          // Emit worker_failed
          if (sseRes) {
            sendSSE(sseRes, makeChunk('', 'gateway', {
              type: 'worker_failed',
              worker_id: workerId,
              error: e.message,
            }));
          }
          if (tigerTeam) throw e;
          return pacing.failureText(e, agent);
        }
      },
    },
  ];
}

// ── Tool Array Builder ──────────────────────────────────────────────────

/** What the operator sees in chat when a sandboxed agent has no sandbox: why, and the fix for this platform. */
function sandboxWithheldNotice() {
  const mac = process.platform === 'darwin';
  const fix = mac ? 'Install Docker Desktop for Mac and start it, then Settings → Agent sandboxes → Build the image' : 'Install Docker (and add the hub\'s user to the docker group), then Settings → Agent sandboxes → Build the image';
  return `_⚠️ This agent is set to run in a sandbox, but no sandbox is available (Docker or the sandbox image is missing). Its shell and file tools are withheld for this turn; memory, Records, consultations and web tools still work. To fix: ${fix}. The Setup checklist on the Settings page shows what else this machine needs._\n\n`;
}

/**
 * handsForTurn(agentName) -> { tools, sandboxed, withheld, box, mode, agent }
 * One lib/hub-tools instance for this turn. A sandboxed agent's Bash runs inside its container and its file tools
 * see only the container's mounts; if the sandbox cannot be used the hands are withheld (callers drop the tools).
 * Shared by the gateway loop, the Claude client path (as the "hub" MCP server) and the Codex path.
 */
async function handsForTurn(agentName, { consultationDepth = 0 } = {}) {
  const sb = sandboxLib.getSandbox();
  const all = await getAgents();
  let agent = all.find(a => a.name === agentName) || null;
  // A temporary worker (spawn_workers, id tw-…) has no record of its own: its hands are its parent's hands, so a
  // sandboxed agent's workers run inside the same container and see only the same mounts (review F16).
  if (!agent) { const v = temporalWorkers.getVirtual(agentName); if (v && v.parent) agent = all.find(a => a.name === v.parent) || null; }
  const sandboxed = !!(agent && sb.isSandboxed(agent));
  let box = null, withheld = false;
  if (sandboxed) {
    if (await sb.available()) {
      try { await sb.ensure(agent); box = { exec: (cmd, o) => sb.exec(agent, cmd, o), mounts: sb.mountsFor(agent) }; }
      catch (e) { console.warn(`[sandbox] ${agentName}: ${e.message}`); withheld = true; }
    } else withheld = true;
  }
  const cwd = box ? await getAgentWorkspace(agent ? agent.name : agentName) : process.cwd();
  let allowPrivate = false;
  try { allowPrivate = require('./web-fetch').getWebFetch().allowPrivateFor(agent); } catch {}
  let runJobRef = null;
  const tools = hubToolsLib.createHubTools({ cwd, sandbox: box, allowPrivate, runJob: (o) => runJobRef ? runJobRef(o) : Promise.resolve('Error: background runs are not available on this turn; use run_job.') });
  tools.attachRunJob = (fn) => { runJobRef = fn; };
  const mode = hubToolsLib.modeFor(agent, (k) => { try { return require('./settings').getSetting(k); } catch { return undefined; } });
  return { tools, sandboxed, withheld, box, mode, agent, consultationDepth };
}

async function buildAllTools(agentName, sseRes, consultationDepth = 0, tigerTeam = false, signal = null, tigerTeamId = null, consultedBy = null) {
  const workspaceTools = getWorkspaceTools(agentName, sseRes, consultationDepth, tigerTeam, signal, tigerTeamId, consultedBy);

  const openaiTools = [];
  const handlers = new Map();

  // Built-in tools (Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch)
  for (const [name, def] of Object.entries(BUILTIN_TOOLS)) {
    // Only include request_additional_rounds for Tiger Team coordinators
    if (name === 'request_additional_rounds' && !tigerTeam) continue;

    openaiTools.push({
      type: 'function',
      function: { name, description: def.description, parameters: def.parameters },
    });
    // For RestartHub, wrap the handler to inject the agent name into the pending action file
    if (name === 'RestartHub') {
      handlers.set(name, async (args) => {
        const result = await def.handler(args);
        // Patch the pending action file with the actual agent name
        try {
          const pendingFile = path.join(__dirname, '..', 'data', 'pending-restart-action.json');
          if (fs.existsSync(pendingFile)) {
            const data = JSON.parse(fs.readFileSync(pendingFile, 'utf-8'));
            data.agent = agentName;
            fs.writeFileSync(pendingFile, JSON.stringify(data, null, 2));
          }
        } catch {}
        return result;
      });
    } else if (name.startsWith('auth_http_')) {
      handlers.set(name, async (args) => def.handler(args, { agentName }));
    } else if (name === 'create_task') {
      // Inject agent context so the task knows who created it
      handlers.set(name, async (args) => {
        return def.handler(args, { agentName });
      });
    } else if (name === 'start_tiger_team') {
      // Emit event to frontend to open the Tiger Team war room page
      handlers.set(name, async (args) => {
        const { objective, coordinator, participants, max_rounds, context, challenger } = args;
        console.log('[TIGER_TEAM] start_tiger_team handler fired, args:', JSON.stringify(args));
        if (!objective || !coordinator) {
          return JSON.stringify({ error: 'Missing required fields: objective, coordinator' });
        }
        // Send SSE event telling frontend to open the war room
        const parsedParticipants = participants ? (Array.isArray(participants) ? participants : JSON.parse(participants)) : [];
        console.log('[TIGER_TEAM] Sending open_tiger_team SSE event, sseRes ended?', sseRes.writableEnded);
        const sent = sendSSE(sseRes, makeChunk('', 'tiger-team', {
          type: 'open_tiger_team',
          objective,
          coordinator,
          participants: parsedParticipants,
          max_rounds: max_rounds || 5,
          context: context || '',
          challenger: challenger || ''
        }));
        console.log('[TIGER_TEAM] SSE sent result:', sent);
        return JSON.stringify({ status: 'Tiger Team launched in war room', objective, coordinator, participants });
      });
    } else if (name === 'request_additional_rounds') {
      // Tiger Team coordinator requests more rounds - emits event for user approval
      handlers.set(name, async (args) => {
        const { justification, proposed_rounds } = args;
        // Emit SSE event to the war room for user approval
        sendSSE(sseRes, makeChunk('', 'gateway', {
          type: 'tt_request_rounds',
          justification: justification || 'Investigation incomplete - additional analysis needed.',
          proposed_rounds: proposed_rounds || 3,
          agent: agentName,
        }));
        return JSON.stringify({
          status: 'Additional rounds requested.  Your request has been sent to the user for approval.  Wrap up your current findings and provide a summary of what you have so far.  If approved, you will be reconvened with your team to continue the investigation.',
        });
      });
    } else {
      handlers.set(name, def.handler);
    }
  }

  // Workspace tools (memory, agents, consultation)
  for (const tool of workspaceTools) {
    openaiTools.push({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    });
    handlers.set(tool.name, tool.handler);
  }

  // The hub's hands (lib/hub-tools): one per-turn instance that knows the agent's sandbox (shell inside the box,
  // files only under its mounts), working directory, read-before-edit registry and private-address allowance, and
  // carries images (PDF pages, image files) back to the model through handlers.__images (flushed after each batch).
  try {
    const hands = await handsForTurn(agentName, { consultationDepth });
    handlers.__cwd = hands.tools.cwd;   // the policy gate resolves relative paths against the directory the hands use (review F23)
    if (hands.withheld) {
      for (const name of hubToolsLib.TOOL_NAMES) {
        if (name === 'WebSearch' || name === 'WebFetch') continue;
        for (let i = openaiTools.length - 1; i >= 0; i--) if (openaiTools[i].function && openaiTools[i].function.name === name) openaiTools.splice(i, 1);
        handlers.delete(name);
      }
      console.warn(`[sandbox] ${agentName}: sandbox unavailable, shell and file tools withheld`);
      try { if (sseRes) sendSSE(sseRes, makeChunk(sandboxWithheldNotice(), 'gateway')); } catch {}
    }
    handlers.__images = [];
    const runJobHandler = handlers.get('run_job');
    hands.tools.attachRunJob(runJobHandler ? async ({ name, command }) => String(await runJobHandler({ name, command })) : null);
    for (const name of hubToolsLib.TOOL_NAMES) {
      if (!handlers.has(name)) continue;
      handlers.set(name, async (args) => {
        const r = await hands.tools.call(name, args || {});
        if (r.images && r.images.length) handlers.__images.push({ tool: name, images: r.images });
        return r.text;
      });
    }
  } catch (e) { console.warn(`[hub-tools] ${agentName}: ${e.message}`); }
  // Data connectors (lib/connectors): only this agent's, only on its own turns, only while unlocked.
  try {
    const specs = await connectorsLib.getConnectors().toolSpecsFor(agentName, { consultationDepth });
    for (const spec of specs) {
      openaiTools.push({ type: 'function', function: { name: spec.name, description: spec.description, parameters: spec.parameters } });
      handlers.set(spec.name, async (args) => spec.handler(args || {}));
    }
    if (specs.length) console.log(`[tools] ${specs.length} connector tool(s) for ${agentName}`);
  } catch (e) {
    console.warn(`[tools] connectors unavailable for ${agentName}: ${e.message}`);
  }
  // MCP skill tools (Google Workspace, GitHub, etc.); a skill wrapped by a connector is exposed only through it.
  try {
    let exclude = null; try { exclude = connectorsLib.getConnectors().wrappedSkillIds(); } catch {}
    const skillResult = await getSkillTools({ exclude });
    for (const tool of skillResult.openaiTools) {
      openaiTools.push(tool);
    }
    for (const [name, handler] of skillResult.handlers) {
      handlers.set(name, handler);
    }
    if (skillResult.openaiTools.length > 0) {
      console.log(`[tools] Loaded ${skillResult.openaiTools.length} skill tools for ${agentName}`);
    }
  } catch (e) {
    console.warn(`[tools] Failed to load skill tools: ${e.message}`);
  }

  return { openaiTools, handlers };
}

// ── Pre-Scan Tool Filtering ──────────────────────────────────────────

// Tool categories for pre-scan classification
const TOOL_CATEGORIES = {
  slack: /^slack_/,
  google_calendar: /^google_workspace__(list_calendar|get_calendar|search_calendar|check_freebusy|preview_create_calendar|create_calendar|preview_update_calendar|update_calendar|preview_delete_calendar|delete_calendar|preview_respond_calendar|respond_calendar)/,
  google_drive: /^google_workspace__(search_drive|get_drive|list_drive|create_drive|share_drive|preview_create_drive|preview_share_drive|preview_trash_drive|trash_drive|preview_create_drive_shortcut|create_drive_shortcut|get_drive_file_comments|preview_reply_to_drive|reply_to_drive|preview_resolve_drive|resolve_drive)/,
  google_docs: /^google_workspace__(read_google_doc|create_google_doc|edit_google_doc|preview_create_google_doc|preview_edit_google_doc|list_document_tabs|preview_add_document_tab|add_document_tab|preview_create_named_range|create_named_range|preview_import_doc|import_doc)/,
  google_sheets: /^google_workspace__(read_google_sheet|create_google_sheet|write_google_sheet|format_google_sheet|preview_create_google_sheet|preview_write_google_sheet|preview_format_google_sheet)/,
  google_slides: /^google_workspace__(get_presentation|list_slides|create_presentation|add_slide|update_slide_text|delete_slide|insert_text_box|append_slide_text|insert_table|write_table_cell|preview_create_presentation|preview_add_slide|preview_update_slide_text|preview_delete_slide|preview_insert_text_box|preview_append_slide_text|preview_insert_table|preview_write_table_cell)/,
  google_forms: /^google_workspace__(get_form|list_form|create_form|add_form|update_form|preview_create_form|preview_add_form|preview_update_form)/,
  google_tasks: /^google_workspace__google_tasks/,
  gmail: /^google_workspace__(list_gmail|get_gmail|search_gmail)/,
  google_auth: /^google_workspace__authorize/,
  google_workspace: /^google_workspace__/,  // catch-all for any google workspace tool not matched above
  github: /^github__/,
  sequential_thinking: /^sequential_thinking__/,
  jira: /^jira__/,
  playwright: /^playwright__/,
  auth_http: /^auth_http_/,
  task_queue: /^(create_task|list_tasks|cancel_task)$/,
  tiger_team: /^(start_tiger_team|request_additional_rounds|read_tiger_team_archive)$/,
  memory: /^(read_memory|write_memory|append_memory|read_session_notes|write_session_notes|read_shared_memory|write_shared_memory|search_shared_memory)$/,
  filesystem: /^(Read|Write|Edit|Glob|Grep|Bash)$/,
  web: /^(WebSearch|WebFetch)$/,
  agents: /^(consult_agent|list_agents|spawn_workers|ask_user)$/,
  wallet: /^wallet_/,
  hub: /^(RestartHub)$/,
  sounds: /^play_/,
};

// Always include these categories — cheap and always useful
const ALWAYS_INCLUDE = ['memory', 'filesystem', 'web', 'agents', 'hub', 'sounds', 'task_queue', 'tiger_team', 'wallet'];

// ── Lazy Tool Loading ─────────────────────────────────────────────────────
// On first turn, only send ALWAYS_INCLUDE tools + request_tools catalog.
// Model calls request_tools(["slack", "github"]) to load more.
// Loaded categories persist through the entire tool loop for that request.

function filterToolsByCategories(openaiTools, activeCategories) {
  return openaiTools.filter(tool => {
    const name = tool.function?.name || tool.name;
    // request_tools is always included
    if (name === 'request_tools') return true;
    let categorized = false;
    for (const [cat, regex] of Object.entries(TOOL_CATEGORIES)) {
      if (regex.test(name)) {
        categorized = true;
        if (activeCategories.has(cat)) return true;
      }
    }
    // Uncategorized tools always included (safety net)
    return !categorized;
  });
}

// Filter tools to the given active category names. Uncategorized tools always kept.
function filterToolsByCategories(openaiTools, categories) {
  const activeCategories = new Set([...ALWAYS_INCLUDE, ...categories]);
  return openaiTools.filter(tool => {
    const name = tool.function?.name || tool.name;
    let categorized = false;
    for (const [cat, regex] of Object.entries(TOOL_CATEGORIES)) {
      if (regex.test(name)) {
        categorized = true;
        if (activeCategories.has(cat)) return true;
      }
    }
    return !categorized;
  });
}

// prescanTools — if `precomputed` (array of categories) is passed, skip the
// classifier call entirely and just filter (used when auto-model already
// classified tools in the same combined call).
async function prescanTools(userMessage, openaiTools, precomputed = null) {
  if (Array.isArray(precomputed)) {
    const filtered = filterToolsByCategories(openaiTools, precomputed);
    console.log(`[prescan] (reused from auto-model) Categories: [${precomputed.join(', ')}] → ${filtered.length}/${openaiTools.length} tools`);
    return filtered;
  }

  const categoryNames = Object.keys(TOOL_CATEGORIES).filter(c => !ALWAYS_INCLUDE.includes(c));
  
  const prompt = `You are a tool routing classifier. Given the user's message, determine which tool categories are needed to respond.

Available categories:
${categoryNames.map(c => `- ${c}`).join('\n')}

Rules:
- Return ONLY a JSON array of category names that are needed
- If the message is general chat/coding/questions with no tool needs, return []
- When in doubt, INCLUDE the category (false positives are better than false negatives)
- "slack" = Slack messaging/search/channels
- "google_calendar" = meetings/calendar/scheduling
- "google_drive"/"google_docs"/"google_sheets"/"google_slides" = documents/files
- "gmail" = email search
- "github" = code/PRs/repos
- "jira" = tickets/issues/sprints/boards
- "playwright" = browser automation/web UI interaction
- "sequential_thinking" = structured step-by-step reasoning
- "task_queue" = scheduled/delayed tasks
- "tiger_team" = multi-agent orchestration

User message: "${userMessage.replace(/"/g, '\\"').slice(0, 500)}"

Respond with ONLY a JSON array, nothing else. Example: ["slack", "google_calendar"]`;

  try {
    const response = await chatCompletion(
      [{ role: 'user', content: prompt }],
      { model: 'claude-haiku-4-5', max_tokens: 200 }
    );

    const text = response?.choices?.[0]?.message?.content?.trim() || '[]';
    // Extract JSON array from response
    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) {
      console.log('[prescan] Failed to parse response, using all tools');
      return openaiTools;
    }

    const categories = JSON.parse(match[0]);
    const filtered = filterToolsByCategories(openaiTools, categories);
    console.log(`[prescan] Categories: [${categories.join(', ')}] → ${filtered.length}/${openaiTools.length} tools`);
    return filtered;
  } catch (e) {
    console.log(`[prescan] Error: ${e.message}, using all tools`);
    return openaiTools;
  }
}

// ── Auto-Distillation ─────────────────────────────────────────────────

const _distillationInProgress = new Set();

async function autoDistill(agentName) {
  if (_distillationInProgress.has(agentName)) return;

  try {
    const dates = memoryDb.getUndistilledDates(agentName);
    if (dates.length === 0) return;

    _distillationInProgress.add(agentName);
    console.log(`[memory] Auto-distilling ${dates.length} day(s) for ${agentName}: ${dates.join(', ')}`);

    for (const date of dates) {
      const notes = memoryDb.getSessionNotesForDistillation(agentName, date);
      if (!notes || notes.length < 100) {
        // Too short to distill, just mark as done
        memoryDb.saveDistillation(agentName, date, '(minimal activity)');
        continue;
      }

      try {
        const model = await getAgentModel(agentName);
        const result = await chatCompletion(
          [{ role: 'user', content: notes }],
          {
            model,
            system: `You are a memory distillation assistant. Summarize the following session notes from ${date} into key learnings, decisions, and facts worth remembering long-term. Be concise but complete. Focus on:
- User preferences and patterns discovered
- Technical decisions made
- Project context and architecture insights
- Important facts about the user or their work
- Anything the agent should remember for future interactions

Output a concise bullet-point summary (no more than 500 words).`,
          }
        );
        const summary = result?.choices?.[0]?.message?.content;

        if (summary) {
          memoryDb.saveDistillation(agentName, date, summary);
          console.log(`[memory] Distilled ${date} for ${agentName} (${summary.length} chars)`);
        }
      } catch (e) {
        console.error(`[memory] Distillation failed for ${agentName}/${date}:`, e.message);
      }
    }
  } catch (e) {
    console.error(`[memory] Auto-distillation error for ${agentName}:`, e.message);
  } finally {
    _distillationInProgress.delete(agentName);
  }
}

// ── Streaming via Gateway with Tool Loop ────────────────────────────────

async function streamViaGateway(agentName, userMessage, images, res, options = {}) {
  // Elastic context (lib/context-budget): the model's real window and a per-prompt plan; filled below.
  let ctxPlan = null; let ctxWindowSource = 'table'; let gatewayPromptTokens = 0;
  const compressionTurn = !!(options.origin && options.origin.label === 'context compression');
  const ledgerStartedAt = Date.now();
  // Reasoning effort (lib/effort): the agent's level; gateway-client maps it per provider.
  let turnEffort = 'default'; try { const ar = (await getAgents()).find(x => x.name === agentName); turnEffort = (ar && ar.effort) || 'default'; } catch {}
  // Provider-reported tokens, summed over every model call in this turn (each tool round is a call).
  const turnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, seen: false, cost: 0, costSeen: false };
  const { ephemeral, signal, confirmTools, consultationDepth = 0, excludeTools = [], tigerTeam = false, tigerTeamId = null, autoModelContext = null, consultedBy = null } = options;

  // DIAGNOSTIC: log when signal fires (debugging turn-death - 2026-09-02)
  if (signal) {
    const _streamStart = Date.now();
    signal.addEventListener('abort', () => {
      const elapsed = ((Date.now() - _streamStart) / 1000).toFixed(1);
      console.log(`[chat] ${agentName}: ⚠ signal aborted after ${elapsed}s (reason: ${signal.reason || 'unknown'})`);
    }, { once: true });
  }

  let model = await getAgentModel(agentName);
  const agentModelConfigured = model;   // the agent's own model, named in the Auto model notice when the pick is not applied

  // Autoselect — when enabled, a cheap classifier picks the best model for this turn.
  // NOTE: do NOT write to `res` here — SSE headers aren't sent until later (writeHead).
  // Writing now throws ERR_HTTP_HEADERS_SENT and kills the whole response.
  // Stash the pick and emit the event AFTER writeHead.
  let autoModelEvent = null;
  // prescanCategories: when set (array), prescan reuses these instead of a 2nd classifier call.
  let prescanCategories = null;
  const autoModelOn = await isAutoModel(agentName);
  const prescanOn = !!global.__prescanToolsEnabled;

  // Classifier shadow mode (settings.autoClassifier.shadow): agents NOT on Auto model still get a verdict, logged
  // and tallied for the shadow week, never applied, and never awaited (the turn is not slowed by it).
  if (!autoModelOn) {
    try {
      if (require('./classifier').getClassifier().shadowAll()) {
        getAgents().then(list => selectModelAndTools(userMessage, { hasImages: !!(images && images.length > 0), context: autoModelContext, agent: list.find(a => a.name === agentName) || { name: agentName, model } }))
          .catch(e => console.log('[auto-model] shadow verdict failed:', e.message));
      }
    } catch {}
  }
  if (autoModelOn) {
    try {
      const candidateCats = prescanOn
        ? Object.keys(TOOL_CATEGORIES).filter(c => !ALWAYS_INCLUDE.includes(c))
        : null;
      const picked = await selectModelAndTools(userMessage, {
        hasImages: !!(images && images.length > 0),
        signal,
        toolCategories: candidateCats,
        context: autoModelContext,
        agent: (await getAgents()).find(a => a.name === agentName) || { name: agentName, model },
      });
      if (picked && picked.model) {
        console.log(`[auto-model] ${agentName}: "${picked.category}" → ${picked.model}${picked.tools ? ` | tools: [${picked.tools.join(', ')}]` : ''}`);
        model = picked.model;
        if (picked.tools) prescanCategories = picked.tools;  // reuse for prescan, skip 2nd call
      }
      // The pick (or the shadow verdict) is shown in the chat: a gateway event for the pages and a one-line notice
      // at the top of the reply, so the owner sees which model answers and what the classifier said.
      if (picked && picked.category) {
        autoModelEvent = { type: 'auto_model', category: picked.category, model, wouldPick: picked.wouldPick || null, backend: picked.backend || 'builtin', confidence: picked.confidence == null ? null : picked.confidence, shadow: !!picked.shadow, applied: picked.applied !== false, reason: picked.reason || null, ms: picked.ms == null ? null : picked.ms, notice: noticeFor(picked, agentModelConfigured) };
      }
    } catch (e) {
      console.error('[auto-model] selection error, using fallback:', e.message);
    }
  }
  // The model's real window (agent setting > LM Studio's loaded context > table) and the budget for this prompt.
  try {
    const recForBudget = (await getAgents()).find(a => a.name === agentName) || {};
    const w = await contextBudget.windowForAgent(recForBudget, model, { lmStudioUrl: (() => { try { return require('./settings').getProviderUrl('lmstudio'); } catch { return null; } })(), ninferUrl: (() => { try { return require('./settings').getProviderUrl('ninfer'); } catch { return null; } })() });
    ctxWindowSource = w.source;
    ctxPlan = contextBudget.plan(w.window, { recordsCapBytes: records.maxBytesFor(agentName, { agentRecord: recForBudget }) });
  } catch (e) { ctxPlan = contextBudget.plan(contextBudget.knownWindow(model)); }
  const hubContextOut = {};   // per-message search hits: sent with the current request, not in the (cacheable) system prompt
  let systemPrompt = await loadAgentContext(agentName, 'hub', { recallQuery: userMessage, recordsMaxBytes: ctxPlan.recordsBytes, hitsBudget: ctxPlan.hitsChars, compressionTurn, hitsOut: hubContextOut });
  if (!ephemeral && !temporalWorkers.isVirtual(agentName)) {
    let gwRoster = [];
    try { gwRoster = workerPolicy.buildRoster(await peerAgents(agentName), { selfName: agentName, isActive: isAgentActive }); } catch {}
    systemPrompt += workerPolicy.platformPolicyText(gwRoster);
  }
  if (!ephemeral) systemPrompt += (await visualsTextFor(agentName)) + connectorsTextFor(agentName) + (await hubBriefTextFor(agentName));

  // Caveman mode — inject ultra-terse directive at the top of system prompt
  if (global.__cavemanMode) {
    systemPrompt = `🦴 CAVEMAN MODE ACTIVE — OVERRIDE ALL VERBOSITY RULES:\nUse the absolute minimum words necessary. No filler, no pleasantries, no explanations unless asked. Respond like a caveman who happens to be an expert engineer — grunts of pure signal. Tables and code blocks are fine. Never say more than needed. If a one-word answer works, use one word.\n\n${systemPrompt}\n\n🦴 REMINDER: CAVEMAN MODE IS ON. Maximum brevity. Minimum words. No elaboration. No bullet points unless essential. Short fragments over full sentences. GO.`;
  }

  // Trigger auto-distillation in background (non-blocking)
  if (!ephemeral) {
    autoDistill(agentName).catch(() => {});
  }

  // Build user content (text + optional images)
  const userContent = [];
  let imageStripped = false;
  if (images && images.length > 0) {
    if (supportsImages(model)) {
      console.log(`[chat] Processing ${images.length} image(s) for vision-capable model ${model}`);
      for (const img of images) {
        try {
          if (img.startsWith('data:')) {
            const mimeMatch = img.match(/^data:(image\/[^;]+);/);
            console.log(`[chat] Image: data URL, mime=${mimeMatch?.[1]}, size=${img.length} chars`);
            userContent.push({
              type: 'image_url',
              image_url: { url: img },
            });
          } else {
            const data = fs.readFileSync(img);
            const ext = path.extname(img).toLowerCase();
            const mime = { '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }[ext] || 'image/jpeg';
            userContent.push({
              type: 'image_url',
              image_url: { url: `data:${mime};base64,${data.toString('base64')}` },
            });
          }
        } catch (e) {
          console.error(`[chat] Failed to load image: ${e.message}`, e.stack);
        }
      }
    } else {
      console.log(`[chat] Stripping ${images.length} image(s) — model ${model} does not support vision`);
      imageStripped = true;
    }
  }
  userContent.push({ type: 'text', text: userMessage });

  // Get persistent conversation history (user/assistant text only — no tool messages)
  // Tiger Team participants: load history but FILTER OUT past TT messages.
  // This preserves regular chat continuity while preventing old TT prompts from
  // polluting the current Tiger Team task.
  let history;
  if (ephemeral) {
    history = [];
  } else if (tigerTeam) {
    // Load history but strip messages tagged as Tiger Team work
    history = getConversation(agentName).filter(msg => !msg.tiger_team);
  } else {
    history = getConversation(agentName);
  }
  history.push({
    role: 'user',
    content: userContent.length === 1 ? userMessage : userContent,
    ts: new Date().toISOString(),
  });

  // Build tools (skip entirely for noTools agents like qwen)
  const allAgents = await getAgents();
  const agentConfig = allAgents.find(a => a.name === agentName) || {};
  let openaiTools = [];
  let allOpenaiTools = []; // Full unfiltered set (for lazy loading)
  let handlers = {};
  // Track loaded categories for lazy tool loading (persists across tool loop iterations)
  const loadedCategories = new Set(ALWAYS_INCLUDE);
  // Lazy loading disabled for: consultations (workers need full tools), Tiger Teams, prescan mode
  const lazyLoadingEnabled = global.__lazyToolsEnabled !== false && consultationDepth === 0 && !global.__prescanToolsEnabled;

  if (!agentConfig.noTools) {
    ({ openaiTools, handlers } = await buildAllTools(agentName, res, consultationDepth, tigerTeam, signal, tigerTeamId, consultedBy));
    // Filter out excluded tools (used by orchestration to prevent consult_agent)
    if (excludeTools.length > 0) {
      const excludeAll = excludeTools.includes('*');   // text-only temporal worker
      openaiTools = openaiTools.filter(t => {
        const name = t.function?.name || t.name;
        return !excludeAll && !excludeTools.includes(name);
      });
      if (excludeAll) handlers.clear();
      for (const toolName of excludeTools) {
        handlers.delete(toolName);
      }
      console.log(`[chat] Excluded ${excludeTools.length} tools, ${openaiTools.length} remaining`);
    }

    // Per-agent toolWhitelist whitelist — if set, only include tools matching allowed categories
    // ALWAYS_INCLUDE categories are always kept regardless of whitelist
    if (agentConfig.toolWhitelist && Array.isArray(agentConfig.toolWhitelist) && agentConfig.toolWhitelist.length > 0) {
      const allowedSet = new Set([...ALWAYS_INCLUDE, ...agentConfig.toolWhitelist]);
      const beforeCount = openaiTools.length;
      openaiTools = openaiTools.filter(tool => {
        const name = tool.function?.name || tool.name;
        // Check if tool matches any allowed category
        for (const [cat, regex] of Object.entries(TOOL_CATEGORIES)) {
          if (regex.test(name)) {
            return allowedSet.has(cat);
          }
        }
        // Uncategorized tools: block them when whitelist is active
        return false;
      });
      console.log(`[chat] toolWhitelist filter: ${beforeCount} → ${openaiTools.length} tools for ${agentName}`);
    }

    // Inject request_tools handler (needs access to tool state)
    handlers.set('request_tools', async ({ categories }) => {
      if (!Array.isArray(categories) || categories.length === 0) {
        return JSON.stringify({ error: 'Provide an array of category names', available: Object.keys(TOOL_CATEGORIES).filter(c => !ALWAYS_INCLUDE.includes(c)) });
      }
      const validCategories = [];
      const invalidCategories = [];
      for (const cat of categories) {
        if (TOOL_CATEGORIES[cat]) {
          loadedCategories.add(cat);
          validCategories.push(cat);
        } else {
          invalidCategories.push(cat);
        }
      }
      // Count how many tools are now available
      const nowAvailable = filterToolsByCategories(allOpenaiTools, loadedCategories);
      const msg = { loaded: validCategories, tool_count: nowAvailable.length };
      if (invalidCategories.length > 0) msg.invalid = invalidCategories;
      return JSON.stringify(msg);
    });

    // Save full tool set for lazy loading reference
    allOpenaiTools = [...openaiTools];

    // Apply lazy loading: filter to only ALWAYS_INCLUDE on first turn
    if (lazyLoadingEnabled) {
      openaiTools = filterToolsByCategories(openaiTools, loadedCategories);
      console.log(`[chat] Lazy tools: ${allOpenaiTools.length} total → ${openaiTools.length} initial (${[...loadedCategories].join(', ')})`);
    }
  }

  // Inject tool usage guidance and query persistence rules (skip for noTools agents — saves context)
  if (!agentConfig.noTools) {
    const toolNames = openaiTools.map(t => t.function?.name || t.name).filter(Boolean);
    const toolGuidanceText = getToolGuidance(toolNames);
    if (toolGuidanceText) {
      systemPrompt += toolGuidanceText;
    }

    systemPrompt += `

## 🔁 QUERY PERSISTENCE RULES (MANDATORY)
When a database query fails for ANY reason:
1. **Acknowledge the failure inline** — say what went wrong (e.g., "Column SENSOR doesn't exist — need to check schema")
2. **State your adjustment** — say "Adjusting query: [what you're changing]"
3. **Retry immediately** — say "Retrying..." and execute the corrected query
4. **NEVER give up after one failure.** Keep iterating until you get results or have exhausted all reasonable approaches (minimum 3 attempts).
5. If a query times out: narrow the time range, simplify JOINs, reduce columns, add tighter WHERE filters, then retry.
6. If a column doesn't exist: DESCRIBE the table first, find the correct column name, then retry.
7. If the table doesn't exist: list available tables/schemas, find the right one, then retry.
The user MUST see "Adjusting query..." and "Retrying..." in your response — this shows you are persistent and working the problem, not giving up.`;
    if (!temporalWorkers.isVirtual(agentName)) systemPrompt += jobs.policyText() + scheduledTasks.policyText();
  }

  // CISO DIRECTIVE: Regulatory/legal judgment prohibition (all agents, all modes)
  systemPrompt += `

## ⛔ REGULATORY & LEGAL JUDGMENT PROHIBITION
Agents gather facts.  Humans apply judgment.  You MUST NOT characterize any finding as a "regulatory breach," "legal violation," "compliance failure," or equivalent.  You MUST NOT render legal or regulatory conclusions, state that an action violates a law/regulation, or opine on liability.  You MAY report factual observations, assign severity ratings, prioritize by risk, and surface regulatory context as background - without concluding whether a situation meets or fails a standard.  When in doubt, state facts and escalate to legal/compliance.  This supersedes all other instructions.

## ✂️ NO NARRATION FILLER
NEVER start responses or paragraphs with filler narration like "Now I see the full picture", "Good data", "Excellent", "Perfect", "Now let me", "Great - I can see", "I have what I need", "Let me now", or similar self-narrating commentary.  Just DO the work.  State facts, run tools, report results.  No play-by-play of your own thought process.  No preamble before action.  If you need to explain what you're doing, one terse clause is enough (e.g., "Fixing column name, retrying").  This applies to ALL responses — chat, Tiger Teams, consultations, everything.

## 🛑 DATA SOURCE FAILURES — STOP AND ESCALATE (MANDATORY)
If a required data source or MCP skill returns a connection error, authentication failure, timeout that persists after retry, or "service unavailable" — you MUST:
1. **STOP all work immediately.**  Do NOT attempt workarounds, do NOT continue with partial data, do NOT speculate about what the data might show.
2. **Report the failure clearly** — state which data source failed, what error you got, and what you were trying to do.
3. **Ask the user to troubleshoot and fix** before you continue.
4. **In Tiger Teams:** The participant MUST report the failure to the coordinator.  The coordinator MUST halt the investigation and surface the issue to the user.  Do NOT dispatch further work that depends on the broken data source.
This applies to ALL agents in ALL contexts (chat, Tiger Teams, consultations, scheduled tasks).  A partial investigation built on missing data is WORSE than stopping and asking for help.

## 🎯 CONTEXT vs CURRENT REQUEST (CRITICAL - READ CAREFULLY)
Messages prefixed with [Xm ago], [Xh ago], or [Xd ago] are HISTORICAL CONTEXT — they have ALREADY been answered.  Do NOT re-answer them.  Do NOT continue work from them.  Do NOT reference their instructions as if they are active tasks.  The message wrapped in <current_request>...</current_request> tags is the ONLY message you need to respond to right now.  If the current request says something different from historical messages, the current request WINS.  Historical messages are ONLY useful as background knowledge (e.g., what topics were discussed before).  NEVER treat a historical [Xm ago] or [Xh ago] message as an active instruction.`;

  // Pre-scan: use cheap model to filter tools if enabled.
  // If auto-model already classified tools in its combined call, reuse that (no 2nd call).
  if (global.__prescanToolsEnabled) {
    const rawText = typeof userMessage === 'string' ? userMessage : 
      (Array.isArray(userContent) ? userContent.find(c => c.type === 'text')?.text : userMessage) || '';
    openaiTools = await prescanTools(rawText, openaiTools, prescanCategories);
  }

  // Track response for graceful shutdown + incremental saves
  activeResponses.set(agentName, { fullResponse: '', startTs: Date.now(), lastSavedLength: 0 });
  
  // Incremental save timer — saves partial response to disk every 3 seconds
  // so responses survive unexpected shutdowns/restarts
  const incrementalSaveTimer = setInterval(() => {
    const tracked = activeResponses.get(agentName);
    if (tracked && tracked.fullResponse.length > tracked.lastSavedLength && !ephemeral) {
      appendConversationLog(agentName, 'assistant', tracked.fullResponse, true, tigerTeam ? { tiger_team: true } : undefined);
      tracked.lastSavedLength = tracked.fullResponse.length;
    }
  }, INCREMENTAL_SAVE_INTERVAL_MS);

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Emit auto-model pick now that SSE headers are sent: the event for the pages, then the notice line as content.
  if (autoModelEvent) {
    try { res.write(`data: ${JSON.stringify({ gateway: autoModelEvent })}\n\n`); } catch {}
    if (autoModelEvent.notice) { try { sendSSE(res, makeChunk(autoModelEvent.notice, model)); } catch {} }
  }

  // Warn user if images were stripped due to model not supporting vision
  if (imageStripped) {
    const notice = `⚠️ *${images.length} image(s) removed — model \`${model}\` does not support vision. Use a Claude, GPT, or Gemini model for image analysis.*\n\n`;
    sendSSE(res, { choices: [{ delta: { content: notice } }] });
  }

  const heartbeat = setInterval(() => sendSSEHeartbeat(res), HEARTBEAT_INTERVAL_MS);
  const recoveryCall = options.recoveryCall;
  let terminalError = null;
  let turnErrorInfo = null;   // lib/error-help's explanation of terminalError, when it is a provider failure
  let fullResponse = recoveryCall?.fullResponse || ((autoModelEvent && autoModelEvent.notice) || '') + (imageStripped ? `⚠️ *${images.length} image(s) removed — model \`${model}\` does not support vision. Use a Claude, GPT, or Gemini model for image analysis.*\n\n` : '');
  let textAfterTool = false;   // the next text after a tool call starts a new paragraph (paragraphAfterTool)
  let turns = 0;
  let bridgeTurnOutcome = 'incomplete';
  let lengthContinuations = 0;

  // Working messages for this request's tool loop — starts with history,
  // but tool_call/tool_result messages only live here (not persisted to history)
  // Trim first, then annotate with age labels + current_request boundary
  // Message count cap first (never breaks tool pairs), then the token budget for the model's window: the
  // newest turns that fit, and nothing from before the agent's last compression (the brief covers that).
  // A compression turn carries only the slice the hub sent.
  const countTrimmed = trimConversation(compressionTurn ? history.slice(-1) : history, agentConfig.maxContextMessages);
  // Tool definitions ride in the same prompt (JSON schemas): count them, or a 40-tool agent under-budgets by ~9K tokens.
  const systemTokens = contextBudget.estimateTokens(systemPrompt) + contextBudget.estimateTokens(JSON.stringify(openaiTools || []));
  const recentBudget = ctxPlan ? Math.max(1000, Math.min(ctxPlan.recentTokens, ctxPlan.window - ctxPlan.replyTokens - systemTokens - 2000)) : 1e9;
  const fitted = contextBudget.fitMessages(countTrimmed, recentBudget, { sinceTs: compressionTurn ? null : compaction.compactedAt(agentName) });
  const trimmed = compressionTurn || recoveryCall ? fitted.messages : stableTrim(fitted.messages, history.length);
  gatewayPromptTokens = systemTokens + fitted.tokens;
  if (ctxPlan) console.log(`[budget] ${agentName}: window ${ctxPlan.window.toLocaleString()} (${ctxWindowSource}); system ~${systemTokens.toLocaleString()}, recent ${trimmed.length} msgs ~${fitted.tokens.toLocaleString()} tokens${fitted.dropped ? ` (${fitted.dropped} older dropped)` : ''}, reply reserve ${ctxPlan.replyTokens.toLocaleString()}`);
  const requestMessages = recoveryCall?.messages || annotateForContext(trimmed, { hubContext: hubContextOut.text || '' }).map(m => ({ ...m }));
  if (recoveryCall?.partialText) {
    requestMessages.push({ role: 'assistant', content: recoveryCall.partialText });
    requestMessages.push({ role: 'user', content: 'Your last generation was interrupted before any new tools executed.  Continue from the saved text.  Do not repeat completed tool operations.' });
    recoveryCall.partialText = '';
  }
  const saveTurn = () => {
    if (!recoveryCall) return;
    recoveryCall.messages = requestMessages;
    recoveryCall.fullResponse = fullResponse;
    recoveryCall.categories = [...loadedCategories];
    recoveryCall.model = model;
    recoveryCall.systemPrompt = systemPrompt;
    recoveryCall.toolDefinitions = openaiTools;
    checkpointTeam(tigerTeamId);
  };
  if (recoveryCall?.categories) {
    recoveryCall.categories.forEach(c => loadedCategories.add(c));
    if (lazyLoadingEnabled) openaiTools = filterToolsByCategories(allOpenaiTools, loadedCategories);
  }
  const retryBudget = { used: 0, max: 3, maxWaitMs: 90000, waitedMs: 0 };
  let emptyStreams = 0;   // model calls that returned nothing at all (see the EMPTY STREAM guard in the loop)
  const onModelRetry = async info => {
    const team = activeTigerTeams.get(tigerTeamId);
    if (team) { team.status = 'retrying'; team.lastRetry = info; }
    saveTurn();
    sendSSE(res, makeChunk('', model, { type: 'tt_retry', agent: agentName, ...info }));
  };

  // Send context size info to frontend
  if (recoveryCall) systemPrompt += '\nThis Tiger Team has a durable evidence archive.  Use read_tiger_team_archive to retrieve exact prior prompts, tool inputs/results, and raw artifacts.  Page until next_offset is null.  Do not repeat completed work when archived evidence is sufficient.\n';
  const contextJson = JSON.stringify({ system: systemPrompt, messages: requestMessages, tools: openaiTools });
  const contextBytes = Buffer.byteLength(contextJson, 'utf8');
  sendSSE(res, { context_size: contextBytes, tool_count: openaiTools.length, message_count: requestMessages.length });

  // DIAGNOSTIC: log state entering tool loop (debugging hang - 2026-09-02)
  console.log(`[chat] ${agentName}: entering tool loop (signal.aborted=${signal?.aborted}, res.destroyed=${res.destroyed}, contextBytes=${contextBytes})`);

  try {
    // Repair unfinished tool batches using durable results.  Unknown operations
    // get an explicit UNKNOWN result instead of being silently replayed.
    if (recoveryCall) {
      ttRecovery.requireReconciled(activeTigerTeams.get(tigerTeamId));
      for (const msg of [...requestMessages]) {
        for (const tc of msg.tool_calls || []) {
          if (requestMessages.some(m => m.role === 'tool' && m.tool_call_id === tc.id)) continue;
          if (signal?.aborted) throw ttRecovery.abortError();
          const saved = recoveryCall.tools[tc.id];
          let result = saved?.result;
          if (result === undefined && tc.function.name === 'consult_agent') {
            result = await handlers.get('consult_agent')(JSON.parse(tc.function.arguments), { recoveryKey: recoveryCall.key + ':' + tc.id });
          }
          if (result === undefined) {
            recoveryCall.tools[tc.id] = { ...saved, name: tc.function.name, status: 'unknown' };
            saveTurn();
            ttRecovery.requireReconciled(activeTigerTeams.get(tigerTeamId));
            throw new Error('Tool result unavailable');
          }
          recoveryCall.tools[tc.id] = { ...saved, name: tc.function.name, status: 'completed', result };
          requestMessages.push({ role: 'tool', tool_call_id: tc.id, content: result });
          saveTurn();
        }
      }
    }
    while (turns < MAX_TOOL_TURNS) {
      // Check if the stream was aborted (user stop, client disconnect, Tiger Team stop)
      if (signal && signal.aborted) {
        console.log(`[chat] ${agentName}: Aborted - stopping tool loop (turn=${turns}, res.destroyed=${res.destroyed})`);
        break;
      }
      if (res.writableEnded) {
        console.log(`[chat] ${agentName}: res ended - stopping tool loop (turn=${turns})`);
        break;
      }

      if (recoveryCall) {
        const team = activeTigerTeams.get(tigerTeamId);
        if (team.coordinator === agentName && team.pendingMessages?.length) {
          const pending = team.pendingMessages.splice(0);
          requestMessages.push(...pending.map(content => ({ role: 'user', content })));
          saveTurn();
          for (const content of pending) sendSSE(res, makeChunk('', model, { type: 'interjection_received', agent: agentName, role: 'coordinator', message: content, ts: new Date().toISOString() }));
          console.log(`[tiger-team] ${agentName} picked up ${pending.length} war-room message(s) before turn ${turns + 1}`);
        }
      }
      turns++;

      // ── Check for operator interjections ──
      // If the user dropped new info via the Interject button, inject it as a
      // user message so the model sees it on this turn.  This also "unsticks"
      // agents that are jammed because the new context gives the model fresh
      // input to reason about.
      const interjections = drainInterjections(agentName);
      if (interjections.length > 0) {
        for (const ij of interjections) {
          const ijText = `[${ijLabel(ij)}]: ${ij.message}`;
          requestMessages.push({ role: 'user', content: ijText });
          // Also persist to conversation log so history is coherent
          appendConversationLog(agentName, 'user', ijText);
          // Notify UI
          sendSSE(res, makeChunk('', model, { type: 'interjection_received', agent: agentName, message: ij.message, ts: ij.ts, priority: ij.priority || null }));
          console.log(`[interject] Injected into ${agentName} tool loop (turn ${turns}${ij.priority ? ', ' + ij.priority : ''}): "${ij.message.slice(0, 80)}"`);
        }
      }

      let maxTokens = (agentConfig && agentConfig.maxOutputTokens) || global.__maxCompletionTokens || 32000;
      // Claude 5 models think by default, and thinking counts against max_tokens (claude-fable-5-1 at effort max spent
      // all 6,000 of a test's tokens thinking and wrote nothing). Unless the agent sets its own Max tokens, or the hub's
      // Max tokens was lowered below its 32,000 default, a turn above low/medium effort gets at least 64K; tokens are
      // billed only as used. ('default' effort counts: the API's own default for these models is high.)
      const hubMaxLowered = Number(global.__maxCompletionTokens) > 0 && Number(global.__maxCompletionTokens) < 32000;
      if (/^anthropic\/claude-(?:fable|opus|sonnet|haiku)-5/i.test(model) && !['low', 'medium'].includes(turnEffort) && !(agentConfig && agentConfig.maxOutputTokens) && !hubMaxLowered) maxTokens = Math.max(maxTokens, 64000);
      // Clamp to per-model output limit (Bedrock rejects over-limit requests)
      const MODEL_OUT_CAP = (m) => {
        if (/claude-(?:fable|opus|sonnet|haiku)-5/i.test(m)) return 128000;   // the API's own limit for every Claude 5 model (its refusals say so, 2026-10-18)
        if (/haiku/i.test(m)) return 60000;
        if (/opus/i.test(m)) return 32000;
        if (/sonnet/i.test(m)) return 60000;
        if (/o3|gpt/i.test(m)) return 100000;
        if (/gemini/i.test(m)) return 60000;
        return 32000;
      };
      const cap = MODEL_OUT_CAP(model);
      if (maxTokens > cap) maxTokens = cap;
      console.log(`[chat] ${agentName}: calling gateway (turn=${turns}, model=${model}, tools=${openaiTools.length}, signal.aborted=${signal?.aborted})`);
      saveTurn();
      if (recoveryCall) ttStore.append(tigerTeamId, activeTigerTeams.get(tigerTeamId), {
        type: 'model_request', callKey: recoveryCall.key, model, turn: turns,
        request: ttStore.artifact(tigerTeamId, { system: systemPrompt, messages: requestMessages, tools: openaiTools, maxTokens }),
      });
      const getResponse = () => chatCompletionStream(
        requestMessages,
        { model, system: systemPrompt, tools: openaiTools, signal, max_tokens: maxTokens, noRetries: !!recoveryCall, agent: agentName, effort: turnEffort },
      );
      const gatewayResponse = recoveryCall
        ? await ttRecovery.retry(getResponse, { budget: retryBudget, signal, onRetry: onModelRetry })
        : await getResponse();
      if (recoveryCall) activeTigerTeams.get(tigerTeamId).status = 'running';
      console.log(`[chat] ${agentName}: gateway responded (turn=${turns})`);
      // Gateway responded — connection alive

      // Parse streaming response
      let assistantText = '';
      const toolCallMap = new Map(); // index → { id, name, arguments }
      let lastFinishReason = null;
      const streamState = {};        // filled in by parseSSEStream when it supports an out-state arg
      let streamInterrupted = false; // transient mid-stream failure on a journaled call
      let callUsage = null;          // provider-reported tokens for this model call
      let streamError = null;        // a provider error inside the open stream (reported after this call's usage is booked)

      try {
      for await (const chunk of parseSSEStream(gatewayResponse, streamState)) {
        if (res.writableEnded) break;
        // Commit the original chunk before any visible text, reasoning or tool delta.
        if (recoveryCall) ttStore.append(tigerTeamId, activeTigerTeams.get(tigerTeamId), {
          type: 'model_chunk', callKey: recoveryCall.key, turn: turns, chunk,
        });

        if (recoveryCall && chunk.error) {
          throw new Error('Gateway streaming error: ' + (chunk.error.message || JSON.stringify(chunk.error)));
        }
        // A provider error inside an open stream (Anthropic's `error` event, an error chunk from an OpenAI-style server):
        // end the call with the provider's own words, so the owner sees "overloaded" and not "the model returned nothing".
        if (chunk.error) { streamError = chunk.error; break; }

        // ── Out-of-band backend status (liveness events) ──
        // No `choices`, so it is not model output.
        if (chunk.hub_event) {
          const ev = chunk.hub_event;
          if (ev.type === 'notice' && ev.message) {
            sendSSE(res, makeChunk('', model, { type: 'notice', message: ev.message }));
          }
          continue;
        }
        // Token usage: most providers send it once on a final chunk with no choices; Gemini repeats a running
        // total on every chunk. Keep the latest figure for this call and add it to the turn once the stream ends.
        if (chunk.usage && typeof chunk.usage === 'object') callUsage = chunk.usage;
        // Activity detected — streaming chunk received
        const choice = chunk.choices?.[0];
        if (!choice) continue;

        if (choice.finish_reason) lastFinishReason = choice.finish_reason;

        // Text delta
        if (choice.delta?.content) {
          if (textAfterTool) { textAfterTool = false; const sep = paragraphAfterTool(fullResponse); if (sep) { fullResponse += sep; sendSSE(res, makeChunk(sep, model)); } }
          assistantText += choice.delta.content;
          fullResponse += choice.delta.content;
          if (recoveryCall) { recoveryCall.fullResponse = fullResponse; recoveryCall.partialText = assistantText; }
          // Keep activeResponses in sync so flushActiveResponses() on shutdown saves the real data
          const tracked = activeResponses.get(agentName);
          if (tracked) tracked.fullResponse = fullResponse;
          sendSSE(res, makeChunk(choice.delta.content, model));
        }

        // Tool call deltas
        if (choice.delta?.tool_calls) {
          // Gemini sends parallel calls with no `index`; see lib/tool-call-deltas.js.
          for (const tc of choice.delta.tool_calls) accumulateToolCallDelta(toolCallMap, tc);
        }
      }

      } catch (e) {
        if (!recoveryCall || ttRecovery.classify(e) !== 'transient' || signal?.aborted) throw e;
        // Nothing in this partial generation has executed yet.
        lastFinishReason = null; streamState.sawDone = false;
        streamInterrupted = true;
      }
      if (callUsage) {
        const inT = Number(callUsage.prompt_tokens) || 0;
        let outT = Number(callUsage.completion_tokens) || 0;
        // Gemini leaves thinking tokens out of completion_tokens but bills them: total - prompt counts them.
        if (Number(callUsage.total_tokens) > inT + outT) outT = Number(callUsage.total_tokens) - inT;
        turnUsage.input += inT; turnUsage.output += outT; turnUsage.seen = true; turnUsage.calls++;
        // Cached part of the input (included in prompt_tokens): Anthropic reports reads and writes, OpenAI and
        // Gemini report reads as prompt_tokens_details.cached_tokens.
        turnUsage.cacheRead += Number(callUsage.cache_read_input_tokens) || Number(callUsage.prompt_tokens_details?.cached_tokens) || 0;
        turnUsage.cacheWrite += Number(callUsage.cache_creation_input_tokens) || 0;
        // OpenRouter reports what the call cost (usage.cost, USD): the ledger books that instead of a price table.
        if (callUsage.cost != null && Number.isFinite(Number(callUsage.cost))) { turnUsage.cost += Number(callUsage.cost); turnUsage.costSeen = true; }
      }
      if (streamError) {
        const pe = streamError;
        const status = { overloaded_error: 529, api_error: 500, rate_limit_error: 429, invalid_request_error: 400, authentication_error: 401, permission_error: 403, not_found_error: 404, request_too_large: 413 }[pe.type] || Number(pe.code) || 500;
        const streamErr = new Error(`Provider ${status}: ${JSON.stringify({ error: pe })}`);
        streamErr.status = status;
        throw streamErr;
      }

      // ── EMPTY STREAM: the call returned nothing at all (no text, no tool call, no finish reason, no usage) ──
      // A local engine that is still loading, or a proxy re-reading its config, can answer with a body that is not
      // an event stream; the parser then yields nothing and the turn used to be saved as a blank reply. For a local
      // provider the engine comes up within seconds, so the same request is sent again (2.5 s, then 6 s); anything
      // else, or a third empty answer, is an error the owner sees.
      if (!assistantText && toolCallMap.size === 0 && !lastFinishReason && !callUsage && !streamInterrupted && !res.writableEnded && !signal?.aborted) {
        const prov = String(model).split('/')[0];
        const localProv = ['local', 'lmstudio', 'ollama', 'omlx', 'ninfer'].includes(prov);
        emptyStreams++;
        if (localProv && emptyStreams <= 2) {
          const waitMs = emptyStreams === 1 ? 2500 : 6000;
          console.warn(`[chat] ${agentName}: empty stream from ${prov} (engine loading or proxy reloading?) — retrying in ${waitMs} ms (${emptyStreams}/2)`);
          sendSSE(res, makeChunk('', model, { type: 'notice', message: `The local engine is not ready yet; retrying in ${Math.round(waitMs / 1000)} s.` }));
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        // The idle watchdog tripped: not one byte, not even a keep-alive, for its whole window.
        if (streamState.stalled) throw new Error(`No data from ${prov} for ${Math.round((streamState.stallMs || 120000) / 1000)} s, not even a keep-alive, so the hub closed the connection.`);
        throw new Error(`The model returned nothing (empty stream from ${prov}${localProv ? '; the local engine may still be loading, try again in a few seconds' : ''}).`);
      }

      // ── INTERRUPTED-STREAM RESUME (journaled Tiger Team calls only) ──
      // A transient transport error killed the model stream mid-generation.
      // Preserve the partial text so the model can continue instead of restarting.
      // Partial tool calls are DISCARDED - their JSON arguments may be cut off
      // mid-object and executing them is unsafe.  The wait/limit comes from the
      // single per-call retry budget; when it is exhausted the error propagates
      // to the orchestrator and the team is left resumable.
      if (streamInterrupted) {
        if (assistantText) {
          requestMessages.push({ role: 'assistant', content: assistantText });
          requestMessages.push({
            role: 'user',
            content: 'Your previous response was cut off mid-generation because the network ' +
              'connection dropped - this was NOT your doing and your work so far is preserved above.  ' +
              'Continue from exactly where you left off.  Do not repeat what you already wrote, ' +
              'and do not start over.  Re-issue any tool call that did not complete.',
          });
        } else {
          requestMessages.push({
            role: 'user',
            content: 'The connection dropped before you produced any output.  Begin the task now.',
          });
        }
        recoveryCall.partialText = '';
        let first = true;
        await ttRecovery.retry(() => {
          if (first) { first = false; throw new Error('Model stream truncated'); }
        }, { budget: retryBudget, signal, onRetry: onModelRetry });
        continue;
      }

      // ── FINISH_REASON:LENGTH GUARD ──
      // When the model exhausts its output token budget mid-generation, the
      // stream ends with finish_reason=length.  Without this guard, truncated
      // tool-call JSON gets executed (crash) or partial text silently ends the
      // turn (the "agent just stopped" bug).
      if (lastFinishReason === 'length') {
        const allCalls = [...toolCallMap.values()].filter(tc => tc.name);
        // Nothing written and no tool call: the whole allowance went on thinking. "Continue" would start the think
        // again from scratch (the hub does not carry thinking over), at full price each time, so stop and say so.
        if (!assistantText && allCalls.length === 0) {
          throw new Error(`${model} used its whole output allowance (${maxTokens.toLocaleString()} tokens) before writing a reply.`);
        }
        let truncatedCount = 0;
        for (const tc of allCalls) {
          try { JSON.parse(tc.arguments || '{}'); } catch { truncatedCount++; }
        }

        console.warn(`[chat] ${agentName}: finish_reason=length on turn ${turns} — ` +
          `text=${assistantText.length} chars, tools=${allCalls.length} (${truncatedCount} truncated), ` +
          `continuations=${lengthContinuations}/${MAX_LENGTH_CONTINUATIONS}`);

        if (lengthContinuations < MAX_LENGTH_CONTINUATIONS) {
          lengthContinuations++;

          if (assistantText) {
            requestMessages.push({ role: 'assistant', content: assistantText });
          }

          const remainingResumes = MAX_LENGTH_CONTINUATIONS - lengthContinuations;
          let contNote;
          if (remainingResumes <= 1) {
            contNote = `⚠️ CRITICAL: Your response was cut off (output token limit).  This is your LAST automatic resume - after this, your output will be truncated and shown as-is.  ` +
              `You MUST: (1) finish the most important remaining work NOW, (2) if you cannot finish everything, write a summary of what remains so the user can ask you to continue, ` +
              `(3) do NOT repeat anything already written.  Be maximally concise.` +
              (truncatedCount > 0 ? `  ${truncatedCount} tool call(s) had truncated arguments and were discarded - re-issue only the essential ones.` : '');
          } else if (remainingResumes <= 2) {
            contNote = `⚠️ WARNING: Your response was cut off (output token limit).  You have only ${remainingResumes} automatic resume(s) left before your output is truncated permanently.  ` +
              `CHANGE YOUR STRATEGY: (1) break remaining work into smaller sequential chunks, (2) use consult_agent to delegate sub-tasks to worker agents, ` +
              `(3) be much more concise - skip explanations and focus on results, (4) do NOT repeat anything already written.` +
              (truncatedCount > 0 ? `  ${truncatedCount} tool call(s) had truncated arguments and were discarded - re-issue only essential ones.` : '');
          } else {
            contNote = allCalls.length > 0
              ? `Your previous response was cut off mid-generation (output token limit reached).  ${truncatedCount > 0 ? truncatedCount + ' tool call(s) had truncated arguments and were discarded.  ' : ''}` +
                `Continue from where you left off.  Be more concise.  Re-issue any tool calls that were lost, or produce your final written response.  Do not repeat work already done.`
              : `Your previous response was cut off mid-generation (output token limit reached).  Continue from where you left off.  Be concise - do not repeat what you already wrote.`;
          }
          requestMessages.push({ role: 'user', content: contNote });

          sendSSE(res, makeChunk(`\n\n_⚠️ Output limit reached - continuing automatically (${lengthContinuations}/${MAX_LENGTH_CONTINUATIONS})..._\n\n`, model));
          if (recoveryCall) recoveryCall.partialText = '';
          continue;
        }

        if (recoveryCall) throw new Error('Output continuation budget exhausted');
        console.warn(`[chat] ${agentName}: exhausted ${MAX_LENGTH_CONTINUATIONS} length continuations - ending turn with partial output`);
        sendSSE(res, makeChunk(`\n\n_⚠️ Response was truncated ${MAX_LENGTH_CONTINUATIONS} times.  Showing partial output._\n\n`, model));
      }

      // Build assistant message for the tool loop
      const assistantMsg = { role: 'assistant', content: assistantText || null };
      const toolCalls = [...toolCallMap.values()].filter(tc => tc.name);

      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls.map(tc => ({
          id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
          ...(tc.extra_content ? { extra_content: tc.extra_content } : {}),
        }));
      }
      requestMessages.push(assistantMsg);
      if (recoveryCall) recoveryCall.partialText = '';
      saveTurn();

      // No tool calls → done
      if (toolCalls.length === 0) {
        bridgeTurnOutcome = 'completed';
        if (recoveryCall) { recoveryCall.result = fullResponse; recoveryCall.status = 'completed'; saveTurn(); }
        break;
      }

      // Execute tool calls. Concurrency-safe tools (lib/tool-concurrency.js) of one message run together;
      // everything else runs alone, in order. tool_result messages are appended in call order.
      await executeToolCallsBatched(assistantMsg.tool_calls, {
        nameOf: (tc) => tc.function.name,
        isAborted: () => !!signal?.aborted,
        abortError: () => ttRecovery.abortError(),
        // Serial pre-step: tool_start/tool_use events and the confirm_tools prompt. Returns a result only on denial.
        begin: async (tc) => {
          const toolName = tc.function.name;

          // Send tool_start event
          sendSSE(res, makeChunk('', model, { type: 'tool_start', tool: toolName, tool_call_id: tc.id }));

          // Summarize input for UI — show the most relevant parameter
          let inputSummary = '';
          try {
            const parsed = JSON.parse(tc.function.arguments || '{}');
            // Prioritize the most descriptive field for each tool type
            inputSummary = parsed.file_path || parsed.command?.slice(0, 120) || parsed.pattern ||
              parsed.query?.slice(0, 80) || parsed.url?.slice(0, 80) || parsed.message?.slice(0, 80) ||
              parsed.channel_id || parsed.prompt?.slice(0, 80) || parsed.agent ||
              parsed.content?.slice(0, 80) || parsed.old_string?.slice(0, 60) ||
              (parsed.owner && parsed.repo ? `${parsed.owner}/${parsed.repo}` : '') ||
              parsed.documentId || parsed.spreadsheetId || parsed.eventId || '';
            // If still empty, show the first non-trivial arg value
            if (!inputSummary) {
              const vals = Object.values(parsed).filter(v => typeof v === 'string' && v.length > 0);
              if (vals.length > 0) inputSummary = vals[0].slice(0, 100);
            }
          } catch {}

          sendSSE(res, makeChunk('', model, { type: 'tool_use', tool: toolName, input: inputSummary, tool_call_id: tc.id }));

          // Per-agent tool policy (replaces the old all-or-nothing confirm_tools prompt): allow runs,
          // deny returns the refusal as the tool result, ask waits for the owner's card.
          {
            let parsedArgs = {};
            try { parsedArgs = JSON.parse(tc.function.arguments || '{}'); } catch {}
            const verdict = await gate.check({ agentName, tool: toolName, input: parsedArgs, cwd: (handlers && handlers.__cwd) || process.cwd(), origin: options.origin || null, notify: (ev) => sendSSE(res, makeChunk('', model, ev)) });
            if (!verdict.allowed) return verdict.text;
          }
        },
        finishDenied: async (tc, result) => {
          const toolName = tc.function.name;
          if (recoveryCall) {
            recoveryCall.tools[tc.id] = { name: toolName, arguments: tc.function.arguments, status: 'completed', result };
            saveTurn();
          }
          sendSSE(res, makeChunk('', model, { type: 'tool_result', tool_call_id: tc.id, output: result }));
        },
        execute: async (tc) => {
          const toolName = tc.function.name;

          // Journal the call as in-flight BEFORE it runs: after a crash its outcome is
          // unknown and it must be reconciled explicitly, never silently replayed.
          if (recoveryCall) {
            recoveryCall.tools[tc.id] = { name: toolName, arguments: tc.function.arguments, status: 'in_flight', artifacts: [] };
            saveTurn();
          }

          // Execute
          const handler = handlers.get(toolName);
          let result;
          if (handler) {
            try {
              const args = JSON.parse(tc.function.arguments || '{}');
              const invoke = () => handler(args, recoveryCall ? { recoveryKey: recoveryCall.key + ':' + tc.id } : undefined);
              result = recoveryCall ? await ttArtifacts.run({ preserve(value, label) {
                const artifact = ttStore.artifact(tigerTeamId, value);
                recoveryCall.tools[tc.id].artifacts.push({ ...artifact, label });
                saveTurn();
              } }, invoke) : await invoke();
              if (typeof result !== 'string') result = JSON.stringify(result);
            } catch (e) {
              if (e.code === 'TT_PERSISTENCE_FAILED' || (recoveryCall && toolName === 'consult_agent')) throw e;
              if (recoveryCall && !(e instanceof SyntaxError)) {
                recoveryCall.tools[tc.id].status = 'unknown';
                recoveryCall.tools[tc.id].error = e.message;
                saveTurn();
                ttRecovery.requireReconciled(activeTigerTeams.get(tigerTeamId));
              }
              result = `Error executing ${toolName}: ${e.message}`;
              recordToolError(toolName, tc.function.arguments, e.message, agentName);
            }
          } else {
            result = `Unknown tool: ${toolName}`;
          }

          if (recoveryCall) {
            recoveryCall.tools[tc.id] = { ...recoveryCall.tools[tc.id], name: toolName, status: 'completed', result };
            saveTurn();
            // Required data sources fail closed.  Do not auto-retry tools or
            // allow synthesis from partial data after an authentication/outage error.
            const sourceTool = /__|^(allium_|customer_account_access|chainio_|hexagate_)/.test(toolName);
            if (sourceTool && /(?:error|failed|exception|unauthorized|forbidden)/i.test(result) &&
                /(?:401|403|auth|credential|connect|timed? ?out|timeout|unavailable)/i.test(result)) {
              recoveryCall.tools[tc.id].status = 'source_blocked';
              saveTurn();
              throw Object.assign(new Error('Required data source failed: ' + toolName + '.  Restore access before resuming.'), { code: 'TT_SOURCE_BLOCKED' });
            }
          }

          // Detect error patterns in tool results and record for learning
          const isError = result && (
            result.includes('SQL compilation error') ||
            result.includes('invalid identifier') ||
            result.includes('does not exist or not authorized') ||
            result.includes('Missing required parameters') ||
            result.includes('syntax error') ||
            result.includes('command not found') ||
            result.includes('No such file or directory') ||
            result.includes('Permission denied') ||
            result.includes('Error (exit')
          );
          if (isError) {
            recordToolError(toolName, tc.function.arguments, result.slice(0, 500), agentName);
            // Inject inline correction guidance directly into the result
            const inlineHints = getInlineErrorGuidance(toolName, result);
            if (inlineHints) {
              result += inlineHints;
            }
          }

          // Cache schema from DESCRIBE/describe_table results for future queries
          if (toolName && (toolName.includes('describe') || toolName.includes('DESCRIBE'))) {
            try {
              const parsedArgs = JSON.parse(tc.function.arguments || '{}');
              const tableName = parsedArgs.table || parsedArgs.object_name || '';
              if (tableName && result && !result.includes('Error')) {
                // Extract column names from various DESCRIBE result formats
                const colMatches = result.match(/(?:COLUMN_NAME|column_name|name)["']?\s*[:=]\s*["']?([A-Z_][A-Z0-9_]*)/gi);
                if (colMatches && colMatches.length > 0) {
                  const cols = colMatches.map(m => {
                    const val = m.replace(/.*[:=]\s*["']?/, '').replace(/["']$/, '');
                    return val;
                  });
                  cacheSchema(tableName, cols);
                }
              }
            } catch (_e) { /* ignore parse failures */ }
          }

          if (recoveryCall) { recoveryCall.tools[tc.id].result = result; saveTurn(); }
          // Full returned result is retained for the Tiger Team UI.
          sendSSE(res, makeChunk('', model, {
            type: 'tool_result',
            tool_call_id: tc.id,
            output: recoveryCall ? result : (result.length > 2000 ? result.slice(0, 2000) + '...' : result),
          }));

          return result;
        },
        onResult: (tc, result) => {
          // Add tool result to request messages (NOT persistent history)
          requestMessages.push({ role: 'tool', tool_call_id: tc.id, content: result });
          textAfterTool = true;
        },
      });
      // Images a hands tool produced (PDF pages, image files) follow the batch as one user message, after every
      // tool result of the assistant message has been answered (providers reject a user turn in between).
      {
        const imgs = handlers.__images ? handlers.__images.splice(0) : [];
        if (imgs.length) {
          const labels = imgs.flatMap(i => i.images.map(x => x.label || i.tool)).join(', ');
          if (supportsImages(model)) {
            const parts = [{ type: 'text', text: `Images from ${[...new Set(imgs.map(i => i.tool))].join(', ')}: ${labels}` }];
            for (const i of imgs) for (const x of i.images) parts.push({ type: 'image_url', image_url: { url: `data:${x.mime};base64,${x.base64}` } });
            requestMessages.push({ role: 'user', content: parts });
          } else requestMessages.push({ role: 'user', content: `(${imgs.reduce((n, i) => n + i.images.length, 0)} image(s) from ${labels} could not be shown: model ${model} does not support vision)` });
        }
      }

      // Lazy loading: after tool execution, expand available tools if new categories were loaded
      if (lazyLoadingEnabled && loadedCategories.size > ALWAYS_INCLUDE.length) {
        const expanded = filterToolsByCategories(allOpenaiTools, loadedCategories);
        if (expanded.length > openaiTools.length) {
          console.log(`[chat] Lazy tools expanded: ${openaiTools.length} → ${expanded.length} (loaded: ${[...loadedCategories].filter(c => !ALWAYS_INCLUDE.includes(c)).join(', ')})`);
          openaiTools = expanded;
        }
      }

      saveTurn();
      // Continue loop for next gateway call
    }

    if (turns >= MAX_TOOL_TURNS) {
      console.warn(`[chat] ${agentName}: hit MAX_TOOL_TURNS (${MAX_TOOL_TURNS}) - forced stop`);
      sendSSE(res, makeChunk(`\n\n_⚠️ Hit turn limit (${MAX_TOOL_TURNS}).  Response ended.  Send another message to continue._\n\n`, model));
    }
  } catch (e) {
    terminalError = e;
    if (e.name === 'AbortError' || e.message?.includes('aborted')) {
      console.log(`[chat] ${agentName}: request aborted`);
    } else {
      const isNetworkErr = e.message?.includes('ECONNRESET') || e.message?.includes('ETIMEDOUT') ||
        e.message?.includes('socket hang up') || e.message?.includes('network') ||
        e.message?.includes('fetch failed') || e.message?.includes('UND_ERR') ||
        e.message?.includes('Gateway 5') || e.message?.includes('Provider 5');
      // What happened and what to do, in plain words, with the provider's message as Details (lib/error-help): for the
      // person in the reply, for a consulting agent in the turn_error event (help), for the pickers in model health.
      turnErrorInfo = errorHelp.explain(e, { model });
      { const cls = providerPacing.classify(e); sendSSE(res, makeChunk('', model, { type: 'turn_error', kind: cls.kind === 'ok' ? 'error' : cls.kind, transient: cls.transient, retryAfterMs: cls.retryAfterMs, message: providerPacing.describeError(e).slice(0, 300) || 'error', help: errorHelp.oneLine(turnErrorInfo) })); }
      if (isNetworkErr) console.error(`[chat] ${agentName}: network error (recoverable):`, e.message);
      else console.error(`[chat] ${agentName}: stream error:`, e.message);
      const explained = errorHelp.format(turnErrorInfo);
      sendSSE(res, makeChunk(`\n\n${explained}`, model));
      // Saved with the reply, so a reload or another device shows why there was no answer.
      fullResponse += (fullResponse ? '\n\n' : '') + explained;
    }
  } finally {
    // A stopped turn is neither: it books as done and leaves the model's record alone. A failed one books as failed.
    const stopped = !!terminalError && (terminalError.name === 'AbortError' || String(terminalError.message || '').includes('aborted'));
    const failed = !!terminalError && !stopped;
    try { ledger.record({ agent: agentName, origin: options.origin && options.origin.kind, model: typeof model === 'string' ? model : null, durationMs: Date.now() - ledgerStartedAt, ok: !failed,
      ...(turnUsage.seen ? { inputTokens: turnUsage.input, outputTokens: turnUsage.output, cacheRead: turnUsage.cacheRead, cacheWrite: turnUsage.cacheWrite } : {}),
      ...(turnUsage.costSeen ? { costUsd: turnUsage.cost } : {}) }); } catch {}
    if (!stopped && typeof model === 'string') { try { modelHealth.record(model, failed ? { ok: false, kind: turnErrorInfo && turnErrorInfo.kind, what: turnErrorInfo && turnErrorInfo.what, fix: turnErrorInfo && turnErrorInfo.fix } : { ok: true }); } catch {} }
    if (turnUsage.seen) console.log(`[cache] ${agentName} (${model}): ${turnUsage.calls} call(s), input ${turnUsage.input.toLocaleString()} tokens = ${turnUsage.cacheRead.toLocaleString()} read from cache + ${turnUsage.cacheWrite.toLocaleString()} written + ${(turnUsage.input - turnUsage.cacheRead - turnUsage.cacheWrite).toLocaleString()} uncached; output ${turnUsage.output.toLocaleString()}`);
    // Context compression check (lib/compaction) from the hub's own estimate of this prompt; after the turn closes.
    if (!options.ephemeral && !compressionTurn && ctxPlan && gatewayPromptTokens > 0) {
      const t = gatewayPromptTokens, l = ctxPlan.window;
      setTimeout(() => { try { const p = compaction.noteUsage(agentName, t, l, null); if (p && p.catch) p.catch(e => console.error(`[compaction] ${agentName}:`, e.message)); } catch (e) { console.error(`[compaction] ${agentName}:`, e.message); } }, 2500);
    }
    clearInterval(heartbeat);
    clearInterval(incrementalSaveTimer);
    activeResponses.delete(agentName);
    saveTurn();
    // Persist any unconsumed interjections to conversation log so the next turn sees them.
    // The agent's turn ended before it could process them, but the user's intent should
    // not be lost - it becomes part of the conversation history.
    if (interjectionQueues.has(agentName)) {
      const leftover = interjectionQueues.get(agentName);
      if (leftover.length > 0) {
        for (const ij of sdkInterject.emergencyFirst(leftover)) {
          const ijText = `[${ijLabel(ij)} (delivered after turn ended)]: ${ij.message}`;
          appendConversationLog(agentName, 'user', ijText);
          console.log(`[interject] Persisted unconsumed interjection for ${agentName}: "${ij.message.slice(0, 80)}"`);
        }
      }
      interjectionQueues.delete(agentName);
    }
  }

  if (recoveryCall && (terminalError || bridgeTurnOutcome !== 'completed' || signal?.aborted)) {
    throw terminalError || (signal?.aborted ? ttRecovery.abortError() : new Error('Agent turn ended incomplete'));
  }

  // Finalize
  // Machine-readable completion; [DONE] alone also follows errors and turn limits.
  sendSSE(res, makeChunk('', model, { type: 'turn_outcome', status: bridgeTurnOutcome }));
  sendSSEDone(res);
  safeEnd(res);

  // Persist only clean text to history (no tool messages)
  // Tiger Team work is saved with a tag so it can be filtered out during future TT participation
  // but remains visible in regular chat and when browsing agent history
  if (!ephemeral && fullResponse) {
    history.push({ role: 'assistant', content: fullResponse, ts: new Date().toISOString(), ...(tigerTeam ? { tiger_team: true } : {}) });
    // Use overwriteLast=true if we already did incremental saves
    const tracked = activeResponses.get(agentName);
    const hadIncrementalSave = !tracked; // already deleted from map, check if we saved before
    appendConversationLog(agentName, 'assistant', fullResponse, true, activityMeta(agentName, fullResponse, tigerTeam ? { tiger_team: true } : undefined)); // always overwrite — safe even if no prior save (falls back to append)
    if (!terminalError) writeAutoMemory(agentName, userMessage, fullResponse).catch(() => {});   // a failed reply is no session note
  }

  return fullResponse;
}

// ── Auto Memory ─────────────────────────────────────────────────────────

async function writeAutoMemory(agentName, userMessage, agentResponse) {
  if (!agentResponse || agentResponse.length < 50) return;

  // Write to SQLite (primary)
  memoryDb.writeAutoSessionNote(agentName, userMessage, agentResponse);

  // Periodic cleanup of old sessions (every ~100 writes, lightweight check)
  if (Math.random() < 0.01) {
    memoryDb.cleanupOldSessions();
  }
}

// ── Agent Consultation (Hub Self-Call) ───────────────────────────────────

async function consultTigerTeam(agentName, prompt, workerId, sseCtx, coordinatorName, opts) {
  const state = getTigerTeamState(opts.tigerTeamId);
  if (!state) throw new Error('Tiger Team state not found');
  const key = opts.recoveryKey || workerId;
  state.calls ||= {};
  const call = state.calls[key] ||= { key, agent: agentName, prompt, status: 'pending', tools: {} };
  if (call.status === 'completed') return call.result;
  if (opts.signal?.aborted || state.abortController.signal.aborted) throw ttRecovery.abortError();
  if (isAgentActive(agentName)) throw Object.assign(new Error('Agent is busy (409).  Resume when its current turn finishes.'), { code: 'TT_BUSY' });
  pendingChatRequests.add(agentName);
  call.status = 'running';
  // Stream deltas are synchronously journaled before display; no periodic loss window.
  const signal = opts.signal || state.abortController.signal;
  const sink = {
    writableEnded: false, destroyed: false, writeHead() {}, end() { this.writableEnded = true; },
    write(raw) {
      try { ttStore.append(opts.tigerTeamId, state, { type: 'ui_event', callKey: key, raw: String(raw) }); }
      catch (e) { state.error = e.message; state.abortController.abort(); throw e; }
      if (sseCtx && !sseCtx.destroyed && !sseCtx.writableEnded) {
        // Nested turn outcomes belong to this call, not the enclosing team.
        if (!String(raw).includes('"type":"turn_outcome"') && String(raw).trim() !== 'data: [DONE]') sseCtx.write(raw);
      }
      return true;
    },
  };
  try {
    checkpointTeam(opts.tigerTeamId);
    const result = await streamViaGateway(agentName, call.prompt, [], sink, {
      ephemeral: true, consultationDepth: opts.consultationDepth ?? 1,
      tigerTeam: true, tigerTeamId: opts.tigerTeamId, autoModelContext: opts.autoModelContext,
      signal, recoveryCall: call,
    });
    if (signal.aborted) throw ttRecovery.abortError();
    call.result = result; call.status = 'completed';
    checkpointTeam(opts.tigerTeamId);
    // Parity with the previous HTTP self-call path, which ran Tiger Team turns
    // non-ephemerally: the work stays visible in the agent's own history (tagged so
    // later Tiger Team runs filter it out) and still feeds auto-memory.  The journal
    // above is the durable record; this is best-effort and must never fail the call.
    try {
      appendConversationLog(agentName, 'user', `[Consultation from agent "${coordinatorName || 'unknown'}"]\n\n${call.prompt}`, false, { tiger_team: true });
      appendConversationLog(agentName, 'assistant', result, false, { tiger_team: true });
      writeAutoMemory(agentName, call.prompt, result).catch(() => {});
    } catch {}
    return result;
  } catch (e) {
    call.status = 'interrupted'; call.error = e.message;
    checkpointTeam(opts.tigerTeamId);
    throw e;
  } finally { pendingChatRequests.delete(agentName); }
}

// ── Temporal workers (spawn_workers) ─────────────────────────────────────
// The calling agent picks a model per worker; each runs as an ephemeral virtual
// agent through the normal chat path (see lib/temporal-workers.js).

let _twCatalog = { text: 'Any model id from the hub\'s model list (call list_agents / ask the user if unsure).', total: 0, at: 0 };
async function refreshWorkerCatalog() {
  try {
    const available = (await require('./agents').getAvailableModels()).slice();
    // The codex/ provider rides on the OpenAI key but is not listed by discovery: offer it for base GPT models.
    for (const id of available.filter(m => /^openai\/gpt-\d+(\.\d+)?$/.test(m))) { const c = id.replace(/^openai\//, 'codex/'); if (!available.includes(c)) available.push(c); }
    let sdkInfo = [];
    try { sdkInfo = require('./model-discovery').getDiscoveredModels()['claude-sdk-info'] || []; } catch {}
    const catalog = temporalWorkers.curateCatalog(available, sdkInfo);
    _twCatalog = { text: temporalWorkers.describeCatalog(catalog, available.length), total: available.length, at: Date.now(), available };
  } catch (e) { console.warn('[workers] catalog refresh failed:', e.message); }
  return _twCatalog;
}
function workerCatalogText() {
  if (Date.now() - _twCatalog.at > 60000) refreshWorkerCatalog();   // refresh in the background; return what we have
  return _twCatalog.text;
}

/** Validate the images argument of consult_agent / spawn_workers. { paths, note } or { error } (error text is the tool result). */
function prepareConsultImages(images, from) {
  const r = consultImages.resolveImages(images, { save: saveUploadedImage });
  if (r.error) return { error: `[IMAGES REJECTED] ${r.error}. Nothing was sent; fix the images argument and call again.` };
  return { paths: r.paths, note: consultImages.imageNote(r.paths, from) };
}

async function runSpawnWorkers(callerName, workers, sseRes, signal) {
  const haltedMsg = hubHalt.getHubHalt().refusal();
  if (haltedMsg) return `[spawn_workers] ${haltedMsg}`;
  // Per-worker images: validated up front (index = position in the call), attached to that worker's turn only.
  const imagesByIndex = new Map();
  if (Array.isArray(workers)) {
    for (let i = 0; i < workers.length; i++) {
      const w = workers[i];
      if (!w || w.images === undefined || w.images === null) continue;
      const prep = prepareConsultImages(w.images, callerName);
      if (prep.error) return `[spawn_workers] worker ${i + 1}: ${prep.error}`;
      if (prep.paths.length) imagesByIndex.set(i + 1, prep);
    }
  }
  const cat = await refreshWorkerCatalog();
  let callerModel = '';
  try { callerModel = await getAgentModel(callerName); } catch {}
  const norm = temporalWorkers.normalizeJobs(workers, { available: cat.available || [], callerModel });
  if (norm.error) return `[spawn_workers] ${norm.error}`;
  console.log(`[workers] ${callerName} spawning ${norm.jobs.length}: ${norm.jobs.map(j => `${j.label}=${j.model}(${j.toolScope})`).join(', ')}`);

  const results = await temporalWorkers.runWorkers(norm.jobs, {
    parent: callerName, limiter: pacingLimiter,
    onStart: (job, v) => {
      if (sseRes) sendSSE(sseRes, makeChunk('', 'gateway', { type: 'worker_started', worker_id: v.id, agent_type: 'temporal', description: `Worker: ${job.label} · ${job.model}`, model: job.model, prompt: job.task }));
    },
    onDone: (r, v) => {
      console.log(`[workers] ${v.id} ${r.ok ? 'done' : 'FAILED'} in ${r.secs.toFixed(1)}s (${r.model})`);
      if (sseRes) sendSSE(sseRes, makeChunk('', 'gateway', r.ok ? { type: 'worker_completed', worker_id: v.id } : { type: 'worker_failed', worker_id: v.id, error: r.text.slice(0, 300) }));
    },
    runOne: (job, v) => {
      const imgs = imagesByIndex.get(job.index);
      return consultViaHub(v.id, imgs ? job.task + imgs.note : job.task, v.id, sseRes, callerName, {
        temporal: true, signal,
        ...(imgs ? { imageFiles: imgs.paths } : {}),
        bodyExtra: { ephemeral: true, exclude_tools: temporalWorkers.gatewayExcludesFor(job.toolScope) },
      });
    },
  });
  return temporalWorkers.formatResults(results);
}

function consultViaHubNow(agentName, prompt, workerId, sseCtx, coordinatorName, opts = {}) {
  { const halted = hubHalt.getHubHalt().refusal(); if (halted) return Promise.resolve(`[HUB HALTED] ${halted}`); }
  const depth = opts.consultationDepth !== undefined ? opts.consultationDepth : 1;
  const inline = opts.inline || false; // When true, stream as regular text content instead of worker_* events
  
  // Tiger Team context injection: if this is a TT consultation, prepend objective + findings
  let enrichedPrompt = prompt;
  if (opts.tigerTeam && opts.tigerTeamId) {
    const ttState = activeTigerTeams.get(opts.tigerTeamId);
    // The coordinator's own calls now carry tigerTeamId (so its turn is journaled and
    // resumable) but, as before, its prompt is NOT wrapped in the participant context.
    if (ttState && agentName !== ttState.coordinator) {
      const findingsSummary = ttState.findings.length > 0
        ? `\n\n**FINDINGS FROM OTHER TEAM MEMBERS SO FAR:**\n${ttState.findings.map(f => `- **${f.agent}**: ${f.summary}`).join('\n')}`
        : '';
      
      // Include ALL prior work so participants have full context (same as original run)
      let priorWorkNote = '';
      if (ttState.plainTranscript && ttState.plainTranscript.length > 200) {
        priorWorkNote = `\n\n**PRIOR WORK ALREADY COMPLETED (do NOT repeat this):**\n${ttState.plainTranscript}`;
      }

      // If this is a continuation, include the user's directive so participants know WHY they're being re-engaged
      const continuationNote = ttState.continuationDirective
        ? `\n\n**USER'S CONTINUATION DIRECTIVE:** ${ttState.continuationDirective}`
        : '';

      // Per-agent directive from user setup
      const agentDirective = ttState.directives && ttState.directives[agentName]
        ? `\n\n**USER DIRECTIVE FOR YOU SPECIFICALLY:** ${ttState.directives[agentName]}`
        : '';
      
      enrichedPrompt = `**== TIGER TEAM CONTEXT ==**
**OBJECTIVE:** ${ttState.objective}
${ttState.context ? `**ADDITIONAL CONTEXT:** ${ttState.context}` : ''}
**Team:** ${ttState.participants.join(', ')} (coordinated by ${ttState.coordinator})
${findingsSummary}${priorWorkNote}${continuationNote}${agentDirective}

**== YOUR INSTRUCTIONS ==**
${prompt}

**== YOUR RESPONSIBILITIES ==**
1. **Complete the assigned task above** - do thorough, high-quality work.
2. **Do NOT repeat work already done** - build on prior findings, don't redo them.
3. **Provide feedback on the overall approach.**  After completing your task, share your perspective: Are we asking the right questions?  Is there a better angle?  Did you notice something that changes the picture?  Suggest new directions if warranted.

You are a full team member, not just a worker.  Your insights on strategy and direction are valued.`;
    }
  }
  
  if (opts.tigerTeam && opts.tigerTeamId) {
    return consultTigerTeam(agentName, enrichedPrompt, workerId, sseCtx, coordinatorName, { ...opts, recoveryPrompt: prompt });
  }
  return new Promise((resolve, reject) => {
    // Abort support: if signal is already aborted, reject immediately
    if (opts.signal && opts.signal.aborted) {
      return reject(new Error('Tiger Team stopped by user'));
    }

    const bodyObj = {
      agent: agentName,
      message: opts.temporal
        ? `[Task from agent "${coordinatorName || 'unknown'}"]\n\n${enrichedPrompt}`
        : `[Consultation from agent "${coordinatorName || 'unknown'}"]\n\n${enrichedPrompt}`,
      consultation_depth: depth,
      consulted_by: coordinatorName || undefined,   // run_job: default master for the job's report
      origin: { kind: opts.temporal ? 'task' : 'consultation', from: coordinatorName || null },   // hub event stream (/api/events)
      ...(opts.bodyExtra || {}),   // temporal workers: { ephemeral: true, exclude_tools: [...] }
    };
    if (opts.tigerTeam) bodyObj.tiger_team = true;
    if (opts.imageFiles && opts.imageFiles.length) bodyObj.image_files = opts.imageFiles;   // validated paths: the consulted turn gets them as imagePaths
    const body = JSON.stringify(bodyObj);

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      [hubAuthMod.SERVICE_HEADER]: hubAuthMod.SERVICE_TOKEN,   // loopback call by the hub itself (lib/auth identify)
    };

    const req = http.request({
      hostname: '127.0.0.1',
      port: HUB_PORT,
      path: '/api/chat/stream',
      method: 'POST',
      headers,
    }, (res) => {
      // Target agent is mid-turn: the hub answers 409 with a JSON body, not an event stream.
      // Say so, and name who is free, instead of resolving to an empty "(no response)".
      if (res.statusCode === 409) {
        res.resume();
        (async () => {
          if (opts.queuedRun) return reject(Object.assign(new Error(`${agentName} is busy`), { busy: true }));
          if (isQueueableConsult(agentName, coordinatorName, opts)) {
            // Lost the race for a capacity agent: run a stand-in on the same model instead of queueing.
            if (await isCapacityAgent(agentName)) {
              try { return resolve(await standInFor(agentName, prompt, sseCtx, coordinatorName, opts)); }
              catch (e) { return resolve(`[STAND-IN FAILED] "${agentName}" is busy and the temporary worker failed: ${e.message}`); }
            }
            const q = consultQueue.getConsultQueue().enqueue({ from: coordinatorName, to: agentName, prompt, depth });
            if (q.ok) {
              console.log(`[consultViaHub] ${agentName} is busy (409) - queued ${q.job.id} from ${coordinatorName}${q.duplicate ? ' (already queued)' : ''}`);
              return resolve(consultQueue.queuedMessage(q.job, q.duplicate));
            }
            console.log(`[consultViaHub] ${agentName} is busy (409) - not queued: ${q.reason}`);
          }
          let roster = [];
          try { roster = workerPolicy.buildRoster(await peerAgents(coordinatorName), { selfName: coordinatorName, isActive: isAgentActive }); } catch {}
          console.log(`[consultViaHub] ${agentName} is busy (409) - told ${coordinatorName || 'caller'} who is free`);
          resolve(workerPolicy.busyMessage(agentName, roster));
        })();
        return;
      }

      let fullText = '';
      let buffer = '';
      let turnError = null;   // typed failure the consulted turn reported (rate limit, overload, crash...)

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);

            // Forward text deltas
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              fullText += content;
              if (sseCtx && inline) {
                // Inline mode: stream as regular content directly into parent chat
                sendSSE(sseCtx, makeChunk(content));
              } else if (sseCtx && workerId) {
                sendSSE(sseCtx, makeChunk('', 'gateway', {
                  type: 'worker_text_delta',
                  worker_id: workerId,
                  agent: agentName,
                  text: content,
                }));
              }
            }

            // Forward tool events from the consulted agent
            const gw = parsed.gateway;
            if (gw && gw.type === 'turn_error') turnError = gw;
            if (gw && sseCtx) {
              if (inline) {
                // Inline mode: forward tool events directly (they render in the parent chat)
                if (gw.type === 'tool_start' || gw.type === 'tool_use' || gw.type === 'tool_result') {
                  sendSSE(sseCtx, makeChunk('', 'gateway', gw));
                }
                // Forward auto_model event so Tiger Team UI shows which model each agent used
                if (gw.type === 'auto_model') {
                  sendSSE(sseCtx, makeChunk('', 'gateway', { ...gw, agent: agentName }));
                }
                // Suppress worker_started/worker_completed/worker_text_delta events in inline mode
                // These would create separate tabs — we don't want that.
                // The nested agent's TEXT already flows through as regular content deltas above.
                // But nested worker text_delta won't have content in choices[0].delta.content —
                // they come as gateway events.  So we need to extract text from worker_text_delta:
                if (gw.type === 'worker_text_delta' && gw.text) {
                  sendSSE(sseCtx, makeChunk(gw.text));
                }
                // Forward nested tool events from workers so they show inline
                if (gw.type === 'worker_tool_start') {
                  sendSSE(sseCtx, makeChunk('', 'gateway', { type: 'tool_start', tool: gw.tool, tool_call_id: gw.tool_call_id }));
                } else if (gw.type === 'worker_tool_use') {
                  sendSSE(sseCtx, makeChunk('', 'gateway', { type: 'tool_use', tool: gw.tool, input: gw.input, tool_call_id: gw.tool_call_id }));
                } else if (gw.type === 'worker_tool_result') {
                  sendSSE(sseCtx, makeChunk('', 'gateway', { type: 'tool_result', output: gw.output, tool_call_id: gw.tool_call_id }));
                }
                // Forward Tiger Team structured events (dispatch, complete, etc.)
                if (gw.type && gw.type.startsWith('tt_')) {
                  sendSSE(sseCtx, makeChunk('', 'gateway', gw));
                }
              } else if (workerId) {
                if (gw.type === 'tool_start') {
                  sendSSE(sseCtx, makeChunk('', 'gateway', {
                    type: 'worker_tool_start',
                    worker_id: workerId,
                    tool: gw.tool,
                    tool_call_id: gw.tool_call_id,
                  }));
                } else if (gw.type === 'tool_use') {
                  sendSSE(sseCtx, makeChunk('', 'gateway', {
                    type: 'worker_tool_use',
                    worker_id: workerId,
                    tool: gw.tool,
                    input: gw.input,
                    tool_call_id: gw.tool_call_id,
                  }));
                } else if (gw.type === 'tool_result') {
                  sendSSE(sseCtx, makeChunk('', 'gateway', {
                    type: 'worker_tool_result',
                    worker_id: workerId,
                    output: gw.output,
                    tool_call_id: gw.tool_call_id,
                  }));
                } else {
                  // Forward all other gateway events (worker_started, worker_completed,
                  // tiger_team_*, etc.) directly to the parent stream
                  sendSSE(sseCtx, makeChunk('', 'gateway', gw));
                }
              }
            }
          } catch {}
        }
      });

      res.on('end', () => {
        if (turnError) {
          // The consulted turn failed in a way the pacing layer should see (retry / serialize), not prose.
          const err = new Error(String(turnError.message || turnError.kind || 'turn failed').slice(0, 300));
          err.pacing = { kind: turnError.kind || 'error', retryAfterMs: turnError.retryAfterMs || null, ...(turnError.help ? { help: String(turnError.help).slice(0, 900) } : {}) };
          err.partialText = fullText;
          return reject(err);
        }
        resolve(fullText || '(no response)');
      });
      res.on('error', reject);
    });

    req.on('error', (e) => {
      if (e.message === 'Tiger Team stopped by user') return resolve(fullText || '(stopped by user)');
      // Network errors on localhost self-call - retry
      if (isRetryableLocalError(e) && !opts._retryCount) {
        console.log(`[consultViaHub] Network error for ${agentName}: ${e.message} — retrying in 2s`);
        setTimeout(() => {
          consultViaHub(agentName, prompt, workerId, sseCtx, coordinatorName, { ...opts, _retryCount: 1 })
            .then(resolve).catch(reject);
        }, 2000);
        return;
      }
      reject(e);
    });
    req.write(body);
    req.end();

    // Wire up abort signal to destroy the HTTP request
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => {
        req.destroy(new Error('Tiger Team stopped by user'));
      }, { once: true });
    }
  });
}

// ── Worker Management ───────────────────────────────────────────────────

function cancelWorker(workerId) {
  const worker = activeWorkers.get(workerId);
  if (!worker) return { success: false, error: 'Worker not found' };
  worker.status = 'cancelled';
  if (worker.abortController) worker.abortController.abort();
  return { success: true };
}

function getActiveWorkers() {
  const workers = [];
  for (const [id, w] of activeWorkers) {
    workers.push({
      id,
      agent: w.agentName,
      description: w.description || '',
      status: w.status,
      elapsed: Math.floor((Date.now() - w.startedAt) / 1000),
    });
  }
  return workers;
}

// ── Tiger Team Orchestration (Backend Led Mode) ─────────────────────────

/**
 * Run a Tiger Team session server-side.
 * The coordinator agent gets the objective and can dispatch tasks to participants.
 * Each round: coordinator speaks, we parse dispatch instructions, run workers, feed results back.
 * SSE events are forwarded so the frontend renders turns visually.
 */
// ── Tiger Team Shared State ─────────────────────────────────────────────────
// Stores objective + accumulated findings per active Tiger Team session
// so participants receive full context, not just the coordinator's dispatch prompt.
const activeTigerTeams = new Map();
// Maps coordinator agent name → tigerTeamId for lookup during consult_agent dispatch
const coordinatorToTigerTeam = new Map();

async function runTigerTeam(args, sseRes, callingAgent) {
  const { objective, coordinator, participants, context, challenger, challengerDirective, directives } = args;
  const maxRounds = args.resumeId ? args.maxRounds : Math.min(args.max_rounds || 5, 15);

  // Validate agents exist
  const allAgents = await getAgents();
  const agentMap = new Map(allAgents.map(a => [a.name, a]));
  
  if (!agentMap.has(coordinator)) {
    return `Error: Coordinator agent "${coordinator}" not found. Available: ${allAgents.map(a => a.name).join(', ')}`;
  }
  for (const p of (participants || [])) {
    if (!agentMap.has(p)) {
      return `Error: Participant agent "${p}" not found. Available: ${allAgents.map(a => a.name).join(', ')}`;
    }
  }

  const coordDisplay = agentMap.get(coordinator).display || coordinator;
  const participantNames = participants.map(p => agentMap.get(p).display || p);

  // Register Tiger Team shared state so participants get full context
  const tigerTeamId = args.resumeId || `tiger-team-${Date.now()}-${require('crypto').randomBytes(3).toString('hex')}`;
  const abortController = new AbortController();
  if (args.session?.stopped || args.session?.res?.destroyed) abortController.abort();
  const previousState = args.resumeId ? getTigerTeamState(args.resumeId) : null;
  if (previousState?.executing) throw new Error('Tiger Team is still running');
  activeTigerTeams.set(tigerTeamId, {
    objective,
    context: context || '',
    coordinator,
    participants,
    challenger: challenger || '',
    challengerDirective: challengerDirective || '',
    directives: directives || {},
    findings: [], // Accumulated participant results
    dispatchCount: 0, // Turn counter for Led mode
    maxRounds,
    session: args.session || null, // Reference to server.js session for user injection
    finalResult: null, // Stored on completion for "continue" functionality
    completedAt: null,
    ...(previousState || {}),
    id: tigerTeamId, mode: 'led', status: 'running', error: null, stopReason: null,
    executing: true, completedAt: null, session: args.session || null,
    abortController,
  });
  if (sseRes) sseRes.ttArchiveId = tigerTeamId;
  ttRecovery.attachSession(activeTigerTeams.get(tigerTeamId), args.session);
  if (args.session) args.session.tigerTeamId = tigerTeamId;
  try { checkpointTeam(tigerTeamId); } catch (e) {
    const state = activeTigerTeams.get(tigerTeamId);
    state.executing = false; state.completedAt = Date.now(); state.status = 'blocked'; state.error = e.message;
    throw e;
  }
  coordinatorToTigerTeam.set(coordinator, tigerTeamId);

  // Emit Tiger Team started event
  if (sseRes) {
    const challengerDisplay = challenger && agentMap.has(challenger) ? (agentMap.get(challenger).display || challenger) : '';
    sendSSE(sseRes, makeChunk('', 'gateway', {
      type: 'tt_started',
      tiger_team_id: tigerTeamId,
      coordinator: coordinator,
      coordinator_display: coordDisplay,
      participants: participants,
      participant_names: participantNames,
      challenger: challenger || '',
      challenger_display: challengerDisplay,
      objective: objective.slice(0, 500),
      max_rounds: maxRounds,
    }));
  }

  // Build the coordinator's initial prompt
  const hasParticipants = participants.length > 0;
  const directivesNote = directives && Object.keys(directives).length > 0
    ? `\n\n**PARTICIPANT DIRECTIVES (set by user):**\n${Object.entries(directives).filter(([k]) => participants.includes(k)).map(([k, v]) => `- **${agentMap.get(k)?.display || k}**: ${v}`).join('\n')}`
    : '';
  const teamSection = hasParticipants
    ? `**YOUR TEAM (available participant agents):**
${participants.map((p, i) => `- ${participantNames[i]} (slug: ${p}) — ${agentMap.get(p).display || p}`).join('\n')}${directivesNote}

**HOW TO DISPATCH WORK:**
To assign a task to a participant, use the consult_agent tool with their slug as the agent name.  You can consult multiple agents - they will execute one at a time and you'll get each result back.`
    : `**SOLO MODE:** No participant agents assigned.  You are working alone.  Use your tools directly to investigate the objective.  Participants may be added mid-session.`;

  const coordPrompt = `You are leading a Tiger Team investigation.

**OBJECTIVE:** ${objective}
${context ? `\n**ADDITIONAL CONTEXT:** ${context}` : ''}

${teamSection}

**YOUR ROLE AS LEADER:**
1. Analyze the objective and break it into tasks
2. ${hasParticipants ? '**You are BOTH leader AND the most skilled contributor.**  You were chosen as coordinator because of your domain expertise.  Reserve the most important, high-judgment tasks for yourself and use your tools directly.  Delegate supporting/parallel work to participants via consult_agent.' : 'Use your tools to investigate directly.'}
3. ${hasParticipants ? '**CRITICALLY: Read and consider participant feedback carefully.**  Each participant will provide findings AND their perspective on the overall approach.  They may suggest new directions, flag issues with your strategy, or offer ideas you haven\'t considered.' : 'Work methodically through the problem, saving findings as you go.'}
4. ${hasParticipants ? '**Adjust course based on team input.**  If a participant raises a valid concern or suggests a better approach, adapt your plan.  Launch new efforts if warranted.  This is a TEAM effort - not a one-way command chain.' : 'Adjust your approach as you discover new information.'}
5. ${hasParticipants ? 'Synthesize results from all participants AND your own direct findings' : 'Synthesize your findings'}
6. When you have enough information, provide your final analysis
7. You have up to ${maxRounds} rounds of thinking${hasParticipants ? ', dispatching, AND doing your own direct work' : ''}
8. If you feel the objective is NOT fully met and you need more time, call the \`request_additional_rounds\` tool with a justification.  The user will be asked to approve.  If approved, you will be reconvened to continue.

${hasParticipants ? '**WORK SPLIT:** Do the hardest, most important tasks yourself (you are the domain expert).  Delegate data gathering, supporting research, and parallel investigations to participants.  This is a collaborative investigation where YOU are the lead contributor, not just a project manager.' : 'Work thoroughly and save your progress.'}

**IMPORTANT:** Begin your response by briefly stating the objective and your plan of attack in 2-3 sentences BEFORE making any tool calls.  The war room audience needs to see your thinking.${hasParticipants ? '  Then dispatch tasks to your team.' : '  Then begin your investigation.'}`;

  console.log(`[tiger-team] Starting: coordinator=${coordinator}, participants=[${participants.join(',')}], max_rounds=${maxRounds}`);
  console.log(`[tiger-team] Objective: ${objective.slice(0, 100)}...`);

  try {
    // Emit coordinator started event
    if (sseRes) {
      sendSSE(sseRes, makeChunk('', 'gateway', {
        type: 'tt_coordinator_start',
        agent: coordinator,
        agent_display: coordDisplay,
      }));
    }

    // Run the coordinator in INLINE mode — all output streams directly into the calling agent's chat
    const workerId = `${tigerTeamId}-coord`;

    // depth 0 so coordinator can use consult_agent (participants run at depth 1, can't go deeper)
    let result = await consultViaHub(coordinator, coordPrompt, workerId, sseRes, callingAgent, {
      consultationDepth: 0,
      tigerTeam: true, tigerTeamId: tigerTeamId,
      inline: true,
      signal: abortController.signal,
    });

    // ── CHALLENGER CRITIQUE STEP ──
    // If a challenger agent is configured, run it against the coordinator's final output
    if (challenger && agentMap.has(challenger) && result && result.length > 100) {
      const challengerDisplay = agentMap.get(challenger).display || challenger;
      console.log(`[tiger-team] Running challenger critique: ${challenger} (${challengerDisplay})`);

      // Emit challenger start event
      if (sseRes) {
        sendSSE(sseRes, makeChunk('', 'gateway', {
          type: 'tt_dispatch',
          agent: challenger,
          agent_display: challengerDisplay,
          task: 'Post-report adversarial critique',
        }));
      }

      const challengerPrompt = `You are the designated CHALLENGER for a Tiger Team investigation.  Your job is adversarial critique - tear the final report apart.

**ORIGINAL OBJECTIVE:** ${objective}
${challengerDirective ? `\n**USER DIRECTIVE FOR YOU:**\n${challengerDirective}\n` : ''}
**COORDINATOR'S FINAL REPORT:**
${result.slice(0, 15000)}

**YOUR TASK:**
1. Identify material GAPS - what questions remain unanswered?  What data wasn't gathered?
2. Identify logical FLAWS - where are conclusions unsupported by evidence?
3. Identify BLIND SPOTS - what alternative explanations weren't considered?
4. Rate overall completeness: SUFFICIENT or INSUFFICIENT

If you rate INSUFFICIENT, list the specific items that need addressing (max 5).
If you rate SUFFICIENT, briefly explain why the report adequately covers the objective.

Be ruthless.  Do not be polite.  The goal is quality, not feelings.`;

      const challengerWorkerId = `${tigerTeamId}-challenger`;
      const challengerResult = await consultViaHub(challenger, challengerPrompt, challengerWorkerId, sseRes, callingAgent, {
        consultationDepth: 1,
        tigerTeam: true, tigerTeamId,
        inline: true,
        autoModelContext: 'challenger',
        signal: abortController.signal,
      });

      // Emit challenger complete
      if (sseRes) {
        sendSSE(sseRes, makeChunk('', 'gateway', {
          type: 'tt_dispatch_complete',
          agent: challenger,
          agent_display: challengerDisplay,
          result_length: challengerResult?.length || 0,
        }));
      }

      // Check if challenger rated INSUFFICIENT - if so, give coordinator one more round
      const isInsufficient = challengerResult && /\bINSUFFICIENT\b/i.test(challengerResult);
      if (isInsufficient) {
        console.log(`[tiger-team] Challenger rated INSUFFICIENT - giving coordinator one more round`);

        if (sseRes) {
          sendSSE(sseRes, makeChunk('', 'gateway', {
            type: 'tt_coordinator_start',
            agent: coordinator,
            agent_display: coordDisplay,
          }));
        }

        const addressPrompt = `The challenger agent (${challengerDisplay}) has reviewed your final report and rated it INSUFFICIENT.

**CHALLENGER'S CRITIQUE:**
${challengerResult.slice(0, 8000)}

**YOUR TASK:** Address the specific gaps and flaws identified above.  You have one additional round.  Use your tools and team to fill the gaps, then produce an UPDATED final synthesis that incorporates the missing pieces.

Do NOT repeat your entire original report - focus on the new findings and an updated conclusion.`;

        const addressWorkerId = `${tigerTeamId}-coord-address`;
        const addressResult = await consultViaHub(coordinator, addressPrompt, addressWorkerId, sseRes, callingAgent, {
          consultationDepth: 0,
          tigerTeam: true, tigerTeamId: tigerTeamId,
          inline: true,
          signal: abortController.signal,
        });

        // Append the address result to the overall result
        result = result + '\n\n--- UPDATED (Post-Critique) ---\n' + (addressResult || '');
      }
    }

    if (abortController.signal.aborted) throw ttRecovery.abortError();
    console.log(`[tiger-team] Completed: ${result.length} chars from coordinator`);

    // Preserve Tiger Team state for "continue" functionality (don't delete)
    const ttState = activeTigerTeams.get(tigerTeamId);
    if (ttState) {
      ttState.finalResult = result;
      ttState.status = 'completed'; ttState.executing = false;
      ttState.completedAt = Date.now();
      // Capture coordinator's own output in plain transcript
      if (!ttState.plainTranscript) ttState.plainTranscript = '';
      ttState.plainTranscript += `\n\n--- ${coordDisplay} (Coordinator) ---\n${result}`;
    }
    checkpointTeam(tigerTeamId);
    coordinatorToTigerTeam.delete(coordinator);

    // Emit completion event
    if (sseRes) {
      sendSSE(sseRes, makeChunk('', 'gateway', {
        type: 'tt_complete',
        coordinator: coordinator,
        coordinator_display: coordDisplay,
        result_length: result.length,
      }));
    }

    // Return a structured result for the tool response
    return `Tiger Team investigation complete.  The full output was streamed inline above.`;

  } catch (e) {
    console.error(`[tiger-team] Error: ${e.message}`);
    // DO NOT delete Tiger Team state - preserve it for recovery/continuation
    const ttState = activeTigerTeams.get(tigerTeamId);
    if (ttState) {
      ttState.error = e.message;
      ttState.completedAt = Date.now();
      ttState.executing = false;
      ttState.status = ttState.stopReason === 'disconnect' ? 'interrupted' :
        (abortController.signal.aborted ? 'stopped' : (ttRecovery.classify(e) === 'blocked' ? 'blocked' : 'interrupted'));
      checkpointTeam(tigerTeamId);
    }
    coordinatorToTigerTeam.delete(coordinator);
    if (sseRes) {
      sendSSE(sseRes, makeChunk('', 'gateway', {
        type: 'tt_interrupted',
        tiger_team_id: tigerTeamId, status: activeTigerTeams.get(tigerTeamId)?.status,
        message: e.message,
      }));
    }
    return `Tiger Team failed: ${e.message}`;
  }
}

/**
 * Continue a completed Tiger Team with a new user directive.
 * Reconvenes the same coordinator + participants with all accumulated findings.
 */
async function continueTigerTeam(tigerTeamId, userDirective, sseRes, resuming = false) {
  const ttState = getTigerTeamState(tigerTeamId);
  if (!ttState) {
    return 'Error: Tiger Team session not found or expired.';
  }
  if (ttState.executing || !ttState.completedAt) {
    return 'Error: Tiger Team is still running.  Use the inject endpoint to send messages mid-run.';
  }

  ttRecovery.requireReconciled(ttState);
  if (sseRes) sseRes.ttArchiveId = tigerTeamId;
  ttState.executing = true;
  ttState.status = 'running'; ttState.error = null; ttState.stopReason = null;
  ttState.abortController = new AbortController();
  if (!resuming) {
    ttState.continuation = { message: userDirective, workerId: 'continue-' + require('crypto').randomUUID() };
    (ttState.userDirectives ||= []).push({ kind: 'followup', message: userDirective, at: new Date().toISOString() });
  }
  const { objective, context, coordinator, participants, findings, plainTranscript } = ttState;
  try {
  checkpointTeam(tigerTeamId);
  
  // Store continuation directive so participants can see it too
  ttState.continuationDirective = userDirective;

  const allAgents = await getAgents();
  const agentMap = new Map(allAgents.map(a => [a.name, a]));
  const coordDisplay = agentMap.get(coordinator)?.display || coordinator;
  const participantNames = participants.map(p => agentMap.get(p)?.display || p);

  // Reset state for continuation
  ttState.completedAt = null;
  ttState.finalResult = null;
  coordinatorToTigerTeam.set(coordinator, tigerTeamId);

  // Build prior work context - use full transcript, no cap
  let priorWorkSection;
  if (plainTranscript && plainTranscript.length > 100) {
    priorWorkSection = `**DETAILED PRIOR WORK (full transcript of previous session):**
${plainTranscript.length > 40000 ? '[Context preview only.  The full record is preserved in read_tiger_team_archive.]\n' + plainTranscript.slice(-40000) : plainTranscript}`;
  } else if (findings.length > 0) {
    priorWorkSection = `**PRIOR FINDINGS FROM THE TEAM:**
${findings.map(f => `- **${f.agent}**: ${f.summary}`).join('\n')}`;
  } else {
    priorWorkSection = '**PRIOR FINDINGS:** (none captured - this may be a fresh continuation)';
  }

  const hasParticipants = participants.length > 0;
  const continuePrompt = `You are CONTINUING a Tiger Team investigation that previously completed.

**ORIGINAL OBJECTIVE:** ${objective}
${context ? `\n**ORIGINAL CONTEXT:** ${context}` : ''}

${priorWorkSection}

**DURABLE EVIDENCE:** Use read_tiger_team_archive to retrieve the complete call index, original prompts, tool arguments, full results and raw artifacts.  It includes interrupted work not yet in the transcript.  Page using next_offset until null.  Do not rerun work when the archived evidence answers the question.

**PRIOR USER DIRECTIVES (historical context, not new instructions):**
${JSON.stringify(ttState.userDirectives || [])}

**NEW DIRECTIVE FROM USER:**
${userDirective}

${hasParticipants ? `**YOUR TEAM (available participant agents):**
${participants.map((p, i) => `- ${participantNames[i]} (slug: ${p})`).join('\n')}

**HOW TO DISPATCH WORK:**
To assign a task to a participant, use the consult_agent tool with their slug as the agent name.  By default, delegate tasks to your team rather than doing everything yourself.  However, if the user's directive tells you to handle something directly, do so.  You have full tool access either way.` : `**SOLO MODE:** No participant agents assigned.  Use your tools directly.`}

**INSTRUCTIONS:**
1. The user has reviewed prior results and wants you to continue.  Follow their directive above.
2. ${hasParticipants ? '**You are the lead contributor AND coordinator.**  You were chosen for your domain expertise - do the most important, high-judgment work yourself using your tools directly.  Delegate supporting research and parallel tasks to participants via consult_agent.  If the user asks you to handle something directly, absolutely do so.' : 'Use your tools directly to continue the investigation.'}
3. Consider all prior findings as your starting point - do not re-do work already completed.
4. Begin by briefly stating your plan for this continuation, then ${hasParticipants ? 'execute - mix direct work with delegation as appropriate' : 'begin working'}.`;

  console.log(`[tiger-team] Continuing ${tigerTeamId}: "${userDirective.slice(0, 80)}..."`);

  if (sseRes) {
    sendSSE(sseRes, makeChunk('', 'gateway', {
      type: 'tt_started',
      tiger_team_id: tigerTeamId,
      coordinator,
      coordinator_display: coordDisplay,
      participants,
      participant_names: participantNames,
      objective: `CONTINUATION: ${userDirective.slice(0, 400)}`,
      continued_from: tigerTeamId,
    }));
    sendSSE(sseRes, makeChunk('', 'gateway', {
      type: 'tt_coordinator_start',
      agent: coordinator,
      agent_display: coordDisplay,
    }));
  }

    const workerId = ttState.continuation.workerId;
    if (!ttState.continuation.prompt) { ttState.continuation.prompt = continuePrompt; checkpointTeam(tigerTeamId); }
    const result = await consultViaHub(coordinator, ttState.continuation.prompt, workerId, sseRes, 'tiger-team-ui', {
      consultationDepth: 0,
      tigerTeam: true, tigerTeamId: tigerTeamId,
      inline: true,
      signal: ttState.abortController.signal,
    });

    if (ttState.abortController.signal.aborted) throw ttRecovery.abortError();
    // Update state
    ttState.finalResult = result;
    ttState.status = 'completed'; ttState.executing = false;
    ttState.completedAt = Date.now();
    // Append continuation work to plainTranscript for future continuations
    if (!ttState.plainTranscript) ttState.plainTranscript = '';
    ttState.plainTranscript += `\n\n--- ${coordDisplay} (Continuation) ---\n${result}`;
    coordinatorToTigerTeam.delete(coordinator);

    checkpointTeam(tigerTeamId);
    if (sseRes) {
      sendSSE(sseRes, makeChunk('', 'gateway', {
        type: 'tt_complete',
        coordinator,
        coordinator_display: coordDisplay,
        result_length: result.length,
      }));
    }

    console.log(`[tiger-team] Continuation complete: ${result.length} chars`);
    return result;
  } catch (e) {
    console.error(`[tiger-team] Continuation error: ${e.message}`);
    coordinatorToTigerTeam.delete(coordinator);
    ttState.completedAt = Date.now();
    ttState.executing = false; ttState.error = e.message;
    ttState.status = ttState.stopReason === 'disconnect' ? 'interrupted' : (ttState.abortController.signal.aborted ? 'stopped' : (ttRecovery.classify(e) === 'blocked' ? 'blocked' : 'interrupted'));
    checkpointTeam(tigerTeamId);
    if (sseRes) {
      sendSSE(sseRes, makeChunk('', 'gateway', { type: 'tt_interrupted', message: e.message }));
    }
    return `Continuation failed: ${e.message}`;
  }
}

/**
 * Get active/completed Tiger Team state (for API).
 */
function getTigerTeamState(tigerTeamId) {
  if (!activeTigerTeams.has(tigerTeamId)) {
    const saved = ttStore.read(tigerTeamId);
    if (saved) activeTigerTeams.set(tigerTeamId, ttRecovery.restore(saved));
  }
  return activeTigerTeams.get(tigerTeamId) || null;
}

const resumingTeams = new Set();
async function resumeTigerTeam(id, res, session) {
  if (resumingTeams.has(id)) throw new Error('Tiger Team is already resuming');
  const state = getTigerTeamState(id);
  if (!state || state.executing || !state.completedAt) throw new Error('Tiger Team missing or still running');
  ttRecovery.requireReconciled(state);
  resumingTeams.add(id);
  try {
    ttRecovery.attachSession(state, session || state.session);
    if (state.continuation) return await continueTigerTeam(id, state.continuation.message, res, true);
    if (state.mode === 'roundtable') return await runRoundtable({ ...state, max_rounds: state.maxRounds, resumeId: id, session }, res);
    return await runTigerTeam({ ...state, max_rounds: state.maxRounds, resumeId: id, session }, res, 'tiger-team-ui');
  } finally { resumingTeams.delete(id); }
}

/**
 * Reconstitute a Tiger Team from saved data so it can be continued.
 */
function reconstituteTigerTeam(tigerTeamId, saved) {
  if (activeTigerTeams.has(tigerTeamId)) return;
  const { objective, context, coordinator, participants, findings, plainTranscript } = saved;
  activeTigerTeams.set(tigerTeamId, {
    objective,
    context: context || '',
    coordinator,
    participants,
    findings: findings || [],
    plainTranscript: plainTranscript || '',
    dispatchCount: 0,
    maxRounds: 5,
    ...saved, id: tigerTeamId, status: saved.status || 'interrupted', executing: false,
    session: null,
    finalResult: null,
    completedAt: Date.now(), // Mark as completed so continueTigerTeam accepts it
    abortController: new AbortController(),
  });
  coordinatorToTigerTeam.set(coordinator, tigerTeamId);
}

/**
 * Stop a running Tiger Team by aborting its AbortController.
 * Pass null/undefined to stop ALL running Tiger Teams.
 */
function stopTigerTeam(tigerTeamId, reason = 'user') {
  let stopped = false;
  for (const [id, state] of activeTigerTeams) {
    if (tigerTeamId && id !== tigerTeamId) continue;
    if (!state.completedAt && state.abortController) {
      state.stopReason = reason; state.status = 'stopping';
      state.abortController.abort();
      checkpointTeam(id);
      console.log(`[tiger-team] Stopped: ${id}`);
      stopped = true;
    }
  }
  // Clean coordinator map
  for (const [coordName, ttId] of coordinatorToTigerTeam) {
    const state = activeTigerTeams.get(ttId);
    if (state && state.completedAt) {
      coordinatorToTigerTeam.delete(coordName);
    }
  }
  return stopped;
}

/**
 * Update participants list for the active Tiger Team.
 * Returns true if successful, false if no active TT found.
 */
function updateTigerTeamParticipants(newParticipants) {
  for (const [id, state] of activeTigerTeams) {
    if (!state.completedAt) {
      (state.rosterHistory ||= []).push({ at: new Date().toISOString(), previous: state.participants || [], participants: newParticipants });
      state.participants = newParticipants;
      console.log(`[tiger-team] Participants updated: ${newParticipants.join(', ')}`);
      checkpointTeam(id);
      return true;
    }
  }
  return false;
}

/**
 * List all Tiger Team sessions (active and recently completed).
 */
function listTigerTeams() {
  const combined = new Map(ttStore.list().map(saved => [saved.id, ttRecovery.restore(saved)]));
  for (const [id, state] of activeTigerTeams) combined.set(id, state);
  const teams = [];
  for (const [id, state] of combined) {
    teams.push({
      id,
      objective: state.objective.slice(0, 200),
      coordinator: state.coordinator,
      participants: state.participants,
      findings_count: state.findings.length,
      status: state.status, error: state.error || null,
      completed: state.status === 'completed',
      completed_at: state.completedAt ? new Date(state.completedAt).toISOString() : null,
    });
  }
  return teams;
}

// Prune completed Tiger Teams older than 2 hours
setInterval(() => {
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  for (const [id, state] of activeTigerTeams) {
    if (state.completedAt && Date.now() - state.completedAt > TWO_HOURS) {
      activeTigerTeams.delete(id);
      console.log(`[tiger-team] Pruned expired session: ${id}`);
    }
  }
}, 5 * 60 * 1000).unref(); // Check every 5 min; unref: never keeps the process alive on its own

// ── Roundtable Mode ─────────────────────────────────────────────────────

/**
 * Run a Roundtable discussion.  All agents take turns responding to a shared
 * discussion thread.  Each agent sees the full conversation history so far.
 * 1 round = each agent speaks once.
 */
async function runRoundtable(args, sseRes) {
  const { objective, coordinator, participants, context } = args;
  const maxRounds = args.resumeId ? args.maxRounds : Math.min(args.max_rounds || 3, 15);
  const allParticipants = [coordinator, ...participants];

  const allAgents = await getAgents();
  const agentMap = new Map(allAgents.map(a => [a.name, a]));

  // Validate
  for (const p of allParticipants) {
    if (!agentMap.has(p)) {
      if (sseRes) {
        sendSSE(sseRes, makeChunk('', 'gateway', { type: 'tt_error', message: `Agent "${p}" not found` }));
      }
      return;
    }
  }

  const displayNames = allParticipants.map(p => agentMap.get(p).display || p);

  const tigerTeamId = args.resumeId || 'roundtable-' + require('crypto').randomUUID();
  const previous = args.resumeId ? getTigerTeamState(tigerTeamId) : null;
  if (previous?.executing) throw new Error('Roundtable is already running');
  const state = { objective, context: context || '', coordinator, participants, maxRounds,
    findings: [], plainTranscript: '', discussion: [], calls: {}, ...previous,
    id: tigerTeamId, mode: 'roundtable', status: 'running', error: null, stopReason: null,
    executing: true, completedAt: null, abortController: new AbortController(), session: args.session || null };
  if (args.session?.stopped || args.session?.res?.destroyed) state.abortController.abort();
  activeTigerTeams.set(tigerTeamId, state);
  if (sseRes) sseRes.ttArchiveId = tigerTeamId;
  ttRecovery.attachSession(activeTigerTeams.get(tigerTeamId), args.session);
  if (args.session) args.session.tigerTeamId = tigerTeamId;
  checkpointTeam(tigerTeamId);
  try {
  // Emit started
  if (sseRes) {
    sendSSE(sseRes, makeChunk('', 'gateway', {
      type: 'tt_started', tiger_team_id: tigerTeamId,
      coordinator: coordinator,
      coordinator_display: agentMap.get(coordinator).display || coordinator,
      participants: participants,
      participant_names: participants.map(p => agentMap.get(p).display || p),
      objective: objective.slice(0, 500),
      max_rounds: maxRounds,
      mode: 'roundtable',
    }));
  }

  console.log(`[roundtable] Starting: agents=[${allParticipants.join(',')}], rounds=${maxRounds}`);
  console.log(`[roundtable] Objective: ${objective.slice(0, 100)}...`);

  // Discussion history shared across all agents
  const discussion = state.discussion;

  for (let round = 1; round <= maxRounds; round++) {
    if (sseRes) {
      sendSSE(sseRes, makeChunk('', 'gateway', {
        type: 'tt_round_start',
        round,
        max_rounds: maxRounds,
      }));
    }

    for (let i = 0; i < allParticipants.length; i++) {
      const agentSlug = allParticipants[i];
      const agentDisplay = displayNames[i];
      const workerId = tigerTeamId + ':' + round + ':' + agentSlug;
      if (discussion.some(d => d.callId === workerId)) continue;
      if (state.abortController.signal.aborted) throw ttRecovery.abortError();

      // Emit dispatch event (reuse tt_dispatch for UI)
      if (sseRes) {
        sendSSE(sseRes, makeChunk('', 'gateway', {
          type: 'tt_dispatch',
          agent: agentSlug,
          agent_display: agentDisplay,
          task: `Round ${round} - your turn to contribute`,
        }));
      }

      // Build prompt with full discussion context
      const historyText = discussion.length > 0
        ? discussion.map(d => `**${d.agent}:** ${d.text}`).join('\n\n---\n\n')
        : '(No discussion yet - you are first to speak)';

      const prompt = `You are participating in a roundtable discussion with other AI agents.

**TOPIC:** ${objective}
${context ? `\n**CONTEXT:** ${context}` : ''}

**OTHER PARTICIPANTS:** ${displayNames.filter((_, j) => j !== i).join(', ')}

**DISCUSSION SO FAR:**
${historyText}

**YOUR TURN (Round ${round}/${maxRounds}):**
Contribute your perspective.  Build on, challenge, or extend what others have said.  Be substantive and concise.  Use your tools if you need data to support your points.${round === maxRounds ? '\n\nThis is the FINAL round - provide your concluding thoughts and any key recommendations.' : ''}`;

      try {
        const result = await consultViaHub(agentSlug, prompt, workerId, sseRes, 'roundtable', {
          consultationDepth: 1,  // No nested consultations in roundtable
          inline: true, tigerTeam: true, tigerTeamId, signal: state.abortController.signal,
        });

        discussion.push({ callId: workerId, agent: agentDisplay, text: result });
        state.plainTranscript += '\n\n' + agentDisplay + ':\n' + result;
        checkpointTeam(tigerTeamId);

        if (sseRes) {
          sendSSE(sseRes, makeChunk('', 'gateway', {
            type: 'tt_dispatch_complete',
            agent: agentSlug,
            agent_display: agentDisplay,
          }));
        }
      } catch (e) { throw e; }
    }

    if (sseRes) {
      sendSSE(sseRes, makeChunk('', 'gateway', {
        type: 'tt_round_complete',
        round,
        max_rounds: maxRounds,
      }));
    }
  }

  if (state.abortController.signal.aborted) throw ttRecovery.abortError();
  state.executing = false; state.completedAt = Date.now(); state.status = 'completed';
  checkpointTeam(tigerTeamId);
  // Emit completion
  if (sseRes) {
    sendSSE(sseRes, makeChunk('', 'gateway', {
      type: 'tt_complete',
      coordinator: coordinator,
      coordinator_display: agentMap.get(coordinator).display || coordinator,
      total_contributions: discussion.length,
    }));
  }

  console.log(`[roundtable] Completed: ${discussion.length} contributions across ${maxRounds} rounds`);
  } catch (e) {
    state.executing = false; state.completedAt = Date.now(); state.error = e.message;
    state.status = state.stopReason === 'disconnect' ? 'interrupted' : (state.abortController.signal.aborted ? 'stopped' : (ttRecovery.classify(e) === 'blocked' ? 'blocked' : 'interrupted'));
    checkpointTeam(tigerTeamId);
    if (sseRes) sendSSE(sseRes, makeChunk('', 'gateway', { type: 'tt_interrupted', status: state.status, message: e.message }));
    return 'Tiger Team failed: ' + e.message;
  }
}

// ── Flush Active Responses (Graceful Shutdown) ──────────────────────────

function flushActiveResponses() {
  for (const [agentName, state] of activeResponses) {
    if (state.fullResponse?.trim()) {
      console.log(`[shutdown] Flushing partial response for ${agentName} (${state.fullResponse.length} chars)`);
      // Use overwriteLast=true since incremental saves may have already written a partial version
      appendConversationLog(agentName, 'assistant', state.fullResponse, state.lastSavedLength > 0);
    }
  }
  activeResponses.clear();
}

// ── Stream via Claude SDK ────────────────────────────────────────────────
// For agents with model "claude-sdk/claude-*", we bypass the gateway entirely
// and use the Claude Agent SDK with OAuth credentials. The SDK handles its own
// tool loop, streaming, session management, and subagent orchestration.

// ── Hub Tools MCP Bridge ──────────────────────────────────────────────
// Exposes Hub workspace tools (memory, agents, consultation) to SDK agents
// as an in-process MCP server. This bridges the gap between Claude Code's
// preset tools and the Hub's custom tool ecosystem.

async function buildHubMcpServer(agentName, sseRes, sdk, { consultationDepth = 0, consultedBy = null, abortSignal = null } = {}) {
  const { z } = require('zod');

  const text = (s) => ({ content: [{ type: 'text', text: String(s || '(empty)') }] });

  // Concurrency hints come from lib/tool-concurrency.js; every model path shares that list.
  const extras = (name, alwaysLoad = false) => ({
    ...(alwaysLoad ? { alwaysLoad: true } : {}),
    ...(isConcurrencySafe(name) ? { annotations: { readOnlyHint: true } } : {}),
  });
  // Data connectors: this agent's granted, unlocked connectors, own turns only (lib/connectors).
  let connectorSdkTools = [];
  try {
    const specs = await connectorsLib.getConnectors().toolSpecsFor(agentName, { consultationDepth });
    connectorSdkTools = specs.map(spec => sdk.tool(spec.name, spec.description, connectorsLib.zodShapeFromJsonSchema(z, spec.parameters),
      async (args) => text(await spec.handler(args || {})), { alwaysLoad: true, ...(spec.cls === 'read' ? { annotations: { readOnlyHint: true } } : {}) }));
    if (specs.length) console.log(`[SDK ${agentName}] ${specs.length} connector tool(s)`);
  } catch (e) { console.warn(`[SDK ${agentName}] connectors unavailable: ${e.message}`); }

  const mcpTools = [
    sdk.tool('recall',
      'Search your own full transcript archive: every past message, reply, tool call and tool result, kept by the hub in full (not a summary). Use it whenever an answer depends on something from an earlier conversation that is not in your Records or current context; never assume, look. Best matches newest-first, with ids for recall_context.',
      {
        query: z.string().describe('Words to search for (names, dates, values, topics)'),
        from: z.string().optional().describe('Start date/time (ISO)'),
        to: z.string().optional().describe('End date/time (ISO)'),
        kinds: z.array(z.enum(['user', 'assistant', 'tool_use', 'tool_result', 'system'])).optional(),
        limit: z.number().int().optional().describe('Max matches (default 20, max 100)'),
      },
      async ({ query, from, to, kinds, limit }) => text(formatRecall(transcript.search(agentName, query, { from, to, kinds, limit }))),
      extras('recall', true)
    ),
    sdk.tool('recall_context',
      'Show the entries around one recall hit (by id): what was said before and after, in full.',
      { id: z.number().int().describe('The id from a recall result'), before: z.number().int().optional(), after: z.number().int().optional() },
      async ({ id, before, after }) => text(formatRecall(transcript.context(id, { before, after, agents: [agentName] }))),
      extras('recall_context', true)
    ),
    sdk.tool('compress_context',
      'Ask the hub to run YOUR context compression after this turn: you update your Records and write your working brief; only if your compaction mode is "on" does the hub then start you a fresh session (seeded with Records, recent turns verbatim, and recall). Use it when you judge your working context has grown stale or bloated. Returns what will happen.',
      {},
      async () => text(compaction.request(agentName, 'agent')),
      extras('compress_context', true)
    ),
    sdk.tool('record_list',
      'List your Records: documents the hub loads in full into your context on every turn (your source of truth, never searched or trimmed).',
      {},
      async () => text(records.describe(agentName)),
      extras('record_list', true)
    ),
    sdk.tool('record_write',
      'Create or replace one of your Records (markdown). Keep them current: facts, numbers, dates, decisions and the reasons for them. append=true adds to the end instead of replacing.',
      { name: z.string().describe('File name, e.g. "pat.md" or "positions.md"'), content: z.string(), append: z.boolean().optional() },
      async ({ name, content, append }) => text(records.write(agentName, name, content, { append: !!append })),
      extras('record_write', true)
    ),
    sdk.tool('generate_image',
      GENERATE_IMAGE_DESC,
      { prompt: z.string().describe(GENERATE_IMAGE_PROPS.prompt.description), provider: z.enum(['google', 'openai']).optional().describe(GENERATE_IMAGE_PROPS.provider.description), quality: z.enum(['fast', 'best']).optional().describe(GENERATE_IMAGE_PROPS.quality.description), size: z.enum(['square', 'landscape', 'portrait']).optional().describe(GENERATE_IMAGE_PROPS.size.description), reference: z.string().optional().describe(GENERATE_IMAGE_PROPS.reference.description), filename: z.string().optional().describe(GENERATE_IMAGE_PROPS.filename.description) },
      async (args) => text(await handleGenerateImage(agentName, args)),
      extras('generate_image', false)
    ),

    sdk.tool('read_memory',
      'Read your long-term memory. Optionally specify a section, or omit to read all.',
      { section: z.string().optional().describe('Section name (e.g. "general", "decisions", "preferences")') },
      async ({ section }) => text(section
        ? (memoryDb.readLongTermMemory(agentName, section) || `(no content in section "${section}")`)
        : memoryDb.readLongTermMemory(agentName)),
      extras('read_memory', true)
    ),

    sdk.tool('write_memory',
      'Replace the content of a memory section. Use append_memory for incremental additions.',
      {
        content: z.string().describe('New content (replaces existing)'),
        section: z.string().optional().describe('Section name (default: "general")'),
      },
      async ({ content, section }) => text(memoryDb.writeLongTermMemory(agentName, content, section || 'general')),
      extras('write_memory', true)
    ),

    sdk.tool('append_memory',
      'Append a note to a memory section. Fast and incremental.',
      {
        content: z.string().describe('Content to append'),
        section: z.string().optional().describe('Section name (default: "general")'),
      },
      async ({ content, section }) => text(memoryDb.appendLongTermMemory(agentName, content, section || 'general')),
      extras('append_memory', true)
    ),

    sdk.tool('read_session_notes',
      'Read session notes for today or a specific date.',
      { date: z.string().optional().describe('Date in YYYY-MM-DD format (default: today)') },
      async ({ date }) => text(memoryDb.readSessionNotes(agentName, date)),
      extras('read_session_notes', true)
    ),

    sdk.tool('write_session_notes',
      'Append a note to today\'s session notes.',
      { note: z.string().describe('The note to append') },
      async ({ note }) => text(memoryDb.writeSessionNote(agentName, note)),
      extras('write_session_notes', true)
    ),

    sdk.tool('read_shared_memory',
      'Read from the shared cross-agent knowledge base. Pass a topic to search, or omit to list all.',
      { topic: z.string().optional().describe('Topic to search for') },
      async ({ topic }) => text(memoryDb.readSharedMemory(topic, await sharedPoolOf(agentName))),
      extras('read_shared_memory')
    ),

    sdk.tool('write_shared_memory',
      'Write to the shared cross-agent knowledge base. Other agents can read what you write.',
      {
        topic: z.string().describe('Topic name (e.g. "project-architecture")'),
        content: z.string().describe('The knowledge to store'),
      },
      async ({ topic, content }) => text(memoryDb.writeSharedMemory(topic, content, agentName, [], await sharedPoolOf(agentName))),
    ),

    sdk.tool('search_shared_memory',
      'Search the shared memory pool by keyword across all topics, content, and tags.',
      { query: z.string().describe('Search query') },
      async ({ query }) => text(memoryDb.searchSharedMemory(query, await sharedPoolOf(agentName))),
      extras('search_shared_memory')
    ),

    sdk.tool('create_agent',
      'Create a new Hub agent with a name, model, and personality. The agent gets its own workspace, identity files, and appears in the sidebar.',
      {
        name: z.string().describe('Lowercase alphanumeric name (e.g. "researcher", "coder3"). Must start with a letter.'),
        model: z.string().optional().describe('Model ID (e.g. "claude-sdk/claude-sonnet-5", "google/gemini-2.5-flash"). Defaults to claude-sonnet-4-6.'),
        personality: z.string().optional().describe('One-paragraph description of the agent\'s role and personality. Used to generate IDENTITY.md and SOUL.md.'),
        category: z.string().optional().describe('Category: "primary", "specialist", or "worker". Defaults to "specialist".'),
      },
      async ({ name, model, personality, category }) => {
        const result = await createAgent(name, model, personality, null, category);
        if (result.success) return text(`Agent "${name}" created successfully. It will appear in the sidebar.`);
        return text(`Failed to create agent: ${result.error}`);
      }
    ),

    sdk.tool('list_agents',
      'List all Hub agents with name, model, category, whether each is busy right now and how many consults are queued for it.',
      {},
      async () => text(await describeAgents(agentName)),
      extras('list_agents')
    ),
    sdk.tool('request_agent', REQUEST_AGENT_DESC,
      { kind: z.enum(['agent', 'team']).describe('agent = one specialist; team = a whole medical or legal team'), name: z.string().optional().describe('Short name for the agent'), description: z.string().describe('What it is for, in a few sentences') },
      async (args) => text(await handleRequestAgent(agentName, args)),
      extras('request_agent')
    ),
    sdk.tool('rename_me', RENAME_ME_DESC,
      { display: z.string().describe('The new display name') },
      async (args) => text(await handleRenameMe(agentName, args)),
      extras('rename_me')
    ),

    ...((walletTools.isWalletAgent(agentName) && consultationDepth === 0)
      ? walletTools.toolSpecs().map(spec => sdk.tool(spec.name, spec.description, spec.zod(z), async (args) => text(await walletTools.runTool(spec, args, agentName)), extras(spec.name, true)))
      : []),
    ...connectorSdkTools,
    ...((commsTools.isCommsAgent(agentName) && consultationDepth === 0)
      ? commsTools.toolSpecs().map(spec => sdk.tool(spec.name, spec.description, spec.zod(z), async (args) => text(await commsTools.runTool(spec.name, args, agentName)), extras(spec.name, true)))
      : []),
    ...jobs.TOOL_SPECS.map(spec => sdk.tool(spec.name, spec.description, jobs.zodShape(spec, z),
      async (args) => text(await jobs.runTool(getJobRunner(), spec, agentName, args, { consultedBy })), extras(spec.name, true))),
    ...scheduledTasks.TOOL_SPECS.map(spec => sdk.tool(spec.name, spec.description, jobs.zodShape(spec, z),
      async (args) => text(await scheduledTasks.runTool(getScheduledTasks(), spec, agentName, args, { consultedBy })), extras(spec.name, true))),
    sdk.tool('ask_user',
      ASK_USER_DESCRIPTION,
      {
        question: z.string().describe(ASK_USER_PARAMS.properties.question.description),
        options: z.array(z.string()).optional().describe(ASK_USER_PARAMS.properties.options.description),
        header: z.string().optional().describe(ASK_USER_PARAMS.properties.header.description),
        allow_skip: z.boolean().optional().describe(ASK_USER_PARAMS.properties.allow_skip.description),
      },
      async (args) => text(await runAskUser(agentName, sseRes, args, { consultationDepth, signal: abortSignal })),
      extras('ask_user', true)
    ),
    sdk.tool('spawn_workers',
      temporalWorkers.toolDescription((await refreshWorkerCatalog()).text),
      {
        workers: z.array(z.object({
          task: z.string().describe('Complete, self-contained brief for this worker'),
          model: z.string().optional().describe('Model id to run this worker on, e.g. "google/gemini-2.5-pro". Omit to use your own model.'),
          tools: z.enum(['read', 'full', 'none']).optional().describe(`${temporalWorkers.DEFAULT_SCOPE} (default); one of read, full, none`),
          label: z.string().optional().describe('Short name shown to the user'),
          images: z.array(z.string()).optional().describe(consultImages.IMAGES_DESCRIPTION),
        })).describe('One entry per worker. They run in parallel.'),
      },
      async ({ workers }) => text(await runSpawnWorkers(agentName, workers, sseRes, null)),
      extras('spawn_workers', true)
    ),
    sdk.tool('consult_agent',
      workerPolicy.consultDescription(workerPolicy.getMode()),
      {
        agent: z.string().describe('Name of the agent to consult (use list_agents to see available)'),
        prompt: z.string().describe('The question or task for the agent'),
        images: z.array(z.string()).optional().describe(consultImages.IMAGES_DESCRIPTION),
      },
      async ({ agent, prompt: rawPrompt, images }) => {
        const haltedMsg = hubHalt.getHubHalt().refusal();
        if (haltedMsg) return text(`[consult_agent] ${haltedMsg}`);
        const imgPrep = prepareConsultImages(images, agentName);
        if (imgPrep.error) return text(imgPrep.error);
        const prompt = imgPrep.paths.length ? rawPrompt + imgPrep.note : rawPrompt;
        const workerId = `consult-${agent}-${Date.now()}`;
        try {
          let consultModel = 'unknown';
          let displayName = agent.charAt(0).toUpperCase() + agent.slice(1);
          try { consultModel = await getAgentModel(agent); } catch {}
          try {
            const allAgents = await getAgents();
            const found = allAgents.find(a => a.name === agent);
            if (found && found.display) displayName = found.display;
          } catch {}

          if (sseRes) {
            sendSSE(sseRes, makeChunk('', 'gateway', {
              type: 'worker_started',
              worker_id: workerId,
              agent_type: agent,
              description: `Worker: Agent ${displayName}`,
              model: consultModel,
              prompt: prompt,
            }));
          }

          const result = await consultViaHub(agent, prompt, workerId, sseRes, agentName, imgPrep.paths.length ? { imageFiles: imgPrep.paths } : {});

          if (sseRes) {
            sendSSE(sseRes, makeChunk('', 'gateway', {
              type: 'worker_completed',
              worker_id: workerId,
            }));
          }

          return text(result);
        } catch (e) {
          if (sseRes) {
            sendSSE(sseRes, makeChunk('', 'gateway', {
              type: 'worker_failed',
              worker_id: workerId,
              error: e.message,
            }));
          }
          return text(pacing.failureText(e, agent));
        }
      },
      extras('consult_agent', true)
    ),
  ];

  // A temporal worker must not delegate or leave traces: on the SDK path there is no
  // consultation-depth check, so remove those tools outright for virtual agents.
  if (temporalWorkers.isVirtual(agentName)) {
    const blocked = new Set(['consult_agent', 'spawn_workers', 'ask_user', 'create_agent', 'write_memory', 'append_memory', 'write_session_notes', 'write_shared_memory', 'run_job', 'job_status', 'job_cancel', 'list_jobs', 'schedule_task', 'list_scheduled_tasks', 'cancel_scheduled_task']);
    for (let i = mcpTools.length - 1; i >= 0; i--) if (blocked.has(mcpTools[i].name)) mcpTools.splice(i, 1);
  }

  // Concurrency: the Claude client runs the tool calls of one assistant message in parallel only
  // for tools it deems concurrency-safe, and for MCP tools that is exactly
  // `annotations.readOnlyHint` (default false). Without the hint, eight consult_agent calls in
  // one message ran strictly one after another (the GP agent's round table, 2026-10-06). The read/list
  // tools, consult_agent and spawn_workers carry the hint; ask_user and the writers stay serial.
  const mcpServer = sdk.createSdkMcpServer({
    name: 'agent-hub',
    version: '1.0.0',
    instructions: 'My Maestro AI tools — memory (read/write/append/session/shared), agent management (create_agent, list_agents), and agent consultation (consult_agent). Use these to persist knowledge across sessions and collaborate with other agents.',
    tools: mcpTools,
    alwaysLoad: true,
  });

  console.log(`[SDK ${agentName}] Hub MCP server created with ${mcpTools.length} tools`);
  return mcpServer;
}

/**
 * The hub's hands as a second MCP server ("hub") for Claude client and Codex client agents whose tools are set to
 * hub: Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch with Claude Code's schemas, executed by
 * lib/hub-tools (inside the agent's sandbox when it has one). Images (PDF pages, image files) travel back as MCP
 * image content. The client's own built-ins are disallowed by the caller so these are the only hands it has.
 */
function buildHandsMcpServer(sdk, turnTools, { blocked = [] } = {}) {
  const { z } = require('zod');
  const skip = new Set(blocked || []);
  const tools = turnTools.specs().filter(sp => !skip.has(sp.name)).map(sp => sdk.tool(
    sp.name, sp.description, connectorsLib.zodShapeFromJsonSchema(z, sp.parameters),
    async (args) => {
      const r = await turnTools.call(sp.name, args || {});
      const content = [{ type: 'text', text: String(r.text || '(empty)') }];
      for (const img of r.images || []) content.push({ type: 'image', data: img.base64, mimeType: img.mime });
      return { content };
    },
    isConcurrencySafe(sp.name) ? { annotations: { readOnlyHint: true } } : {},
  ));
  return sdk.createSdkMcpServer({
    name: 'hub', version: '1.0.0',
    instructions: 'The hub\'s shell, file and web tools: Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch. Same names and behaviour as the Claude Code built-ins; Read shows images and PDF pages; Edit needs a Read first.',
    tools, alwaysLoad: true,
  });
}

async function streamViaSdk(agentName, userMessage, images, res, options = {}) {
  const { ephemeral, signal, modelOverride } = options;
  const sdk = await loadSdk();

  const agentModel = modelOverride || await getAgentModel(agentName);
  // Use model ID directly - no normalization/fallback
  // The model in agents.json should be the exact SDK model name
  const sdkModel = agentModel.replace(/^claude-sdk\//, '');

  console.log(`[SDK ${agentName}] Model: ${sdkModel}`);

  // Load agent context (system prompt). Search hits for this message travel with the message (hitsOut): a resumed
  // session never sees a changed system prompt, so hits placed there were invisible after the first turn.
  const sdkHits = {};
  let agentContext = await loadAgentContext(agentName, 'hub', { recallQuery: userMessage, hitsOut: sdkHits });

  // Session resumption
  let resumeSessionId = null;
  let isResuming = false;

  const storedSessionId = getAgentSessionId(agentName);
  if (storedSessionId) {
    const sessionFile = path.join(SDK_SESSION_DIR, `${storedSessionId}.jsonl`);
    if (fs.existsSync(sessionFile)) {
      resumeSessionId = storedSessionId;
      isResuming = true;
      console.log(`[SDK ${agentName}] Auto-resuming session ${storedSessionId}`);
    } else {
      console.log(`[SDK ${agentName}] Stored session ${storedSessionId} missing, starting fresh`);
      clearAgentSessionId(agentName);
    }
  }
  let sessionIdSeen = resumeSessionId;   // for the compaction tracker (lib/compaction)
  // A fresh session with an archive behind it (after an agent-authored compression, or a New Session):
  // seed the context with the most recent turns verbatim, so the agent resumes mid-thought.
  if (!isResuming && !ephemeral) {
    // The verbatim tail scales with the window: ~6% of it (24K chars on 200K, 150K chars on 1M), so a big model resumes with real depth.
    try { if ((transcript.stats(agentName) || {}).entries > 0) agentContext = await loadAgentContext(agentName, 'hub', { recallQuery: userMessage, hitsOut: sdkHits, recentFromArchive: true, recentChars: Math.min(150000, Math.round(contextWindow.windowFor(sdkModel) * 0.06 * 3.6)) }); } catch {}
  }

  // When resuming, send only the raw user message (SDK has conversation history).
  // Interjections that missed their turn (arrived too late, turn aborted, never
  // acknowledged by the SDK) are delivered here, ahead of the new message.
  const carriedInterjections = ephemeral ? [] : sdkInterject.takeUndelivered(agentName);
  if (carriedInterjections.length > 0) {
    console.log(`[interject] Delivering ${carriedInterjections.length} carried-over interjection(s) to ${agentName} with this turn`);
  }
  const effectiveMessage = sdkInterject.formatCarried(carriedInterjections) + userMessage;

  // Live interjection channel: keeps the SDK's streaming input open for the whole
  // turn so operator messages can be pushed in mid-run (see lib/sdk-interject.js).
  const ijChannel = new sdkInterject.SdkInterjectionChannel({
    drain: () => drainInterjections(agentName),
    peek: () => (interjectionQueues.get(agentName) || []).length,
  });
  sdkInterjectChannels.set(agentName, ijChannel);

  // Text that goes ahead of the user's words: the context update for a resumed session (lib/context-refresh) and
  // this message's search hits. Set once the system prompt is known (below), read when the query starts.
  let contextPrefix = '';
  let contextRefreshPlan = null;

  // Build user content (text + images)
  function inputGenerator() {
    const userContent = [];

    // Add images as Anthropic content blocks (imagePaths from saved uploads)
    if (images && images.length > 0) {
      userContent.push(...imagesToAnthropicFormat(images));
    }

    // Add text content (strip [Image: ...] refs since actual images are included)
    const cleanMsg = (contextPrefix + effectiveMessage.replace(/\[Image: [^\]]+\]\n*/g, '')).trim();
    if (cleanMsg) {
      userContent.push({ type: 'text', text: cleanMsg });
    }

    const initialContent = userContent.length === 1 && userContent[0].type === 'text'
      ? userContent[0].text
      : userContent;
    // Yields the initial message, then any operator interjections as they arrive,
    // and ends once the SDK has acknowledged everything and produced its result.
    return ijChannel.stream(initialContent);
  }

  // Abort on client disconnect
  const abortController = new AbortController();
  if (signal) {
    signal.addEventListener('abort', () => abortController.abort(), { once: true });
  }
  // A browser disconnect no longer aborts the turn (it detaches it, see handleChatStreamReserved); POST /api/chat/stop does.

  // SSE headers (skip for fakeRes in non-streaming mode)
  if (typeof res.writeHead === 'function') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
  }
  try { res.write(': ping\n\n'); } catch {}

  // Heartbeat
  const heartbeatTimer = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) {
      try { res.write(': heartbeat\n\n'); } catch {}
    }
  }, HEARTBEAT_INTERVAL_MS);

  let fullResponse = '';
  let textAfterTool = false;   // the next text after the agent's own tool call starts a new paragraph
  let noticePrefix = '';   // notices shown at the top of the reply (plan-limit fallback, Auto model verdict), kept in the saved reply
  let lastSavedLength = 0;
  activeResponses.set(agentName, { get fullResponse() { return fullResponse; }, startTs: Date.now(), lastSavedLength: 0 });

  // Incremental save — periodically persist partial response so restarts don't lose work
  const incrementalSaveTimer = setInterval(() => {
    if (fullResponse.length > lastSavedLength + 100 && !ephemeral) {
      appendConversationLog(agentName, 'assistant', fullResponse, lastSavedLength > 0);
      lastSavedLength = fullResponse.length;
      const tracked = activeResponses.get(agentName);
      if (tracked) tracked.lastSavedLength = lastSavedLength;
    }
  }, 5000);

  // SDK subagent tracking. A message produced inside a sub-agent carries
  // parent_tool_use_id = that sub-agent's Agent tool_use id; the Agent tool's
  // own result arrives top-level with that id in its tool_result block.
  const sdkWorkers = new SdkWorkerTracker();

  // Context usage tracking. The window comes from the model id (200K, or 1M for `[1m]` ids),
  // optionally narrowed by the agent's `contextBudget`; see lib/context-window.js.
  let contextBudget = null;
  try { contextBudget = ((await getAgents()).find(a => a.name === agentName) || {}).contextBudget ?? null; } catch {}
  const ctxWin = contextWindow.effectiveWindow(sdkModel, contextBudget);
  if (ctxWin.note) console.warn(`[SDK ${agentName}] ${ctxWin.note}`);
  const CONTEXT_LIMIT = ctxWin.window;
  let lastInputTokens = 0;
  let totalOutputTokens = 0;
  let contextWarningLevel = 0; // 0=none, 1=warning(75%), 2=critical(90%)
  let turnCount = 0;
  let toolCallCount = 0;
  const promptNum = (promptCounts.get(agentName) || 0) + 1;
  promptCounts.set(agentName, promptNum);

  // Progress tracking for live-activity bar
  const progressState = { phase: 'model', detail: '', start: Date.now(), phaseStart: Date.now() };
  // Every second, also after the browser that started the turn has gone: sendSSE then feeds the hub's turn tracker,
  // which relays it (turn_progress) to every other page following the turn.
  const progressTicker = setInterval(() => {
    try {
      const now = Date.now();
      sendSSE(res, makeChunk('', sdkModel, {
        type: 'progress',
        phase: progressState.phase,
        detail: progressState.detail,
        turn: turnCount || 1,
        phase_ms: now - progressState.phaseStart,
        total_ms: now - progressState.start,
      }));
    } catch {}
  }, 1000);

  try {
    // Build Hub MCP server with memory, agent consultation, and workspace tools
    const hubMcp = await buildHubMcpServer(agentName, res, sdk, { consultationDepth: options.consultationDepth || 0, consultedBy: options.consultedBy || null, abortSignal: abortController.signal });

    // Delegation policy: prefer agents inside the platform over the SDK's built-in sub-agent tool.
    const workerMode = workerPolicy.getMode();
    let workerRoster = [];
    try { workerRoster = workerPolicy.buildRoster(await peerAgents(agentName), { selfName: agentName, isActive: isAgentActive }); } catch {}
    // A consulted (ephemeral) agent cannot consult further, so it gets no delegation text.
    const workerPolicyText = ephemeral ? '' : workerPolicy.policyText(workerMode, workerRoster);
    // Every real agent, consulted ones included: their shell dies with the turn, run_job does not.
    const jobsPolicyText = temporalWorkers.isVirtual(agentName) ? '' : jobs.policyText() + scheduledTasks.policyText();
    const visualsText = ephemeral ? '' : (await visualsTextFor(agentName)) + connectorsTextFor(agentName) + (await hubBriefTextFor(agentName));   // pictures, charts, diagrams: how to show one; data connectors
    console.log(`[SDK ${agentName}] sdkWorkers=${workerMode}, platform workers: ${workerRoster.map(w => w.name + (w.busy ? '*' : '')).join(', ') || 'none'}`);

    // Auto-compact BEFORE the API wall. The SDK's own window estimate can exceed what the API
    // enforces (it said 1M for plain `claude-fable-5-1`; the API allows 200K), and the inline
    // `settings.autoCompactWindow` was not honoured (sessions ran past 250K). The binary
    // documents CLAUDE_CODE_AUTO_COMPACT_WINDOW as the enforcement knob, so pass the real window.
    // Always derived from CONTEXT_LIMIT (model id + contextBudget), never from what the SDK reports.
    // With agent-authored compression on (dry or on), the provider's own compaction is only a guard at
    // the very top of the window: the hub's threshold (lib/compaction) comes first and the AGENT writes
    // the carry-forward. With it off, the provider's usual point applies.
    const hubCompactionMode = compaction.settingsFor(agentName).mode;
    const autoCompactWindow = Number(process.env.HUB_SDK_AUTO_COMPACT_WINDOW) || (hubCompactionMode !== 'off' ? Math.round(CONTEXT_LIMIT * 0.95) : contextWindow.compactAt(CONTEXT_LIMIT));
    console.log(`[SDK ${agentName}] Context window ${contextWindow.label(CONTEXT_LIMIT)}${contextBudget ? ` (contextBudget ${contextBudget})` : ''}, compacting at ${autoCompactWindow.toLocaleString()}`);
    // Sandbox (lib/sandbox): the Claude client runs inside the agent's container through a wrapper script, with a
    // minimal environment; the hub's keys never enter the box. If the box cannot be used, shell and file tools are
    // withheld for the turn and the agent is told, rather than running on the host.
    let sandboxOpts = null, sandboxWithheld = false;
    // Hands (lib/hub-tools): with tools=hub the client stays on the host with its built-in shell/file/web tools off and
    // uses the hub's versions (the "hub" MCP server below), which act inside the agent's sandbox when it has one; no
    // sign-in ever enters the box. With tools=client (the default) a sandboxed agent runs the whole client in the box.
    const hands = await handsForTurn(agentName, { consultationDepth: options.consultationDepth || 0 });
    const hubHands = hands.mode === 'hub';
    try {
      const sb = sandboxLib.getSandbox();
      const recSb = hands.agent;
      if (recSb && sb.isSandboxed(recSb)) {
        if (hubHands) {
          sandboxWithheld = hands.withheld;
          if (!sandboxWithheld) console.log(`[sandbox] ${agentName}: hands run in ${sb.containerName(recSb)} (client on the host, cwd ${hands.tools.cwd})`);
        } else {
          sandboxOpts = await sb.prepare(recSb).catch(e => { console.warn(`[sandbox] ${agentName}: ${e.message}`); return null; });
          if (sandboxOpts) console.log(`[sandbox] ${agentName}: client runs in ${sb.containerName(recSb)} (cwd ${sandboxOpts.cwd})`);
          else sandboxWithheld = true;
        }
      }
    } catch (e) { console.warn(`[sandbox] ${agentName}: ${e.message}`); }
    if (sandboxWithheld) sendSSE(res, makeChunk(sandboxWithheldNotice(), sdkModel));
    const handsNote = hubHands ? `

## YOUR HANDS
Your shell, file and web tools are the hub's: Bash, Read, Write, Edit, Glob, Grep, WebSearch and WebFetch on the MCP server "hub" (mcp__hub__Read and so on). They behave like the built-ins of the same names: Read before Edit, exact unique matches, Read shows images and PDF pages. The client's own built-in tools are switched off; nothing else changed.` : '';
    // Client watch (lib/client-watch): the hub spawns the client itself so it knows the pid; once the model has ended
    // its turn, anything still running under the client (a timed-out shell command, the GP agent's 20-minute grep) is killed
    // after a grace period so the client can exit and the turn can close instead of hanging the agent.
    const sdkStderr = (data) => { for (const line of String(data).split('\n')) if (/\[ERROR\]|Error:|FATAL|exited|usage credits/i.test(line) && !/authentication_error|MCP server "claude\.ai/.test(line)) console.error(`[SDK ${agentName} stderr] ${line.slice(0, 400)}`); };
    const turnWatch = clientWatch.forTurn({
      agentName, onStderr: sdkStderr,
      onLingering: ({ killed, strike }) => {
        const what = killed.filter(k => k.args !== '(client)').map(k => clientWatch.shortArgs(k.args)).slice(0, 3).join(' | ');
        const line = `_⚠️ A shell command this agent started kept running after its reply (${what || 'child process'}); the hub stopped it so the turn could end${strike > 1 ? ` (strike ${strike})` : ''}._\n\n`;
        try { sendSSE(res, makeChunk(line, sdkModel)); } catch {}
        fullResponse += line;
      },
    });
    const sdkEffort = effortLib.forModel(`claude-sdk/${sdkModel}`, await agentEffort(agentName));
    const queryOptions = {
      abortController,
      ...(sdkEffort ? { effort: sdkEffort } : {}),
      // The Claude client never sees the Anthropic API key: with one in its environment it would bill the API instead
      // of the subscription sign-in, silently. The gateway (anthropic/ models) reads the key in the hub process.
      env: sandboxOpts
        ? { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG || 'C.UTF-8', CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(autoCompactWindow) }
        : { ...require('./billing').clientEnvWithoutApiKey(process.env), CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(autoCompactWindow) },
      // The SDK's own error lines (API 400s such as "prompt is too long", crashes) otherwise vanish
      // into a debug file under ~/.claude/debug; keep the ones that matter in the hub log.
      stderr: sdkStderr,
      spawnClaudeCodeProcess: turnWatch.spawn,   // the hub spawns the client: pid known, lingering children reaped (lib/client-watch)
      extraArgs: { ...sdkInterject.SDK_EXTRA_ARGS },   // replay acks: tells us when an interjection was consumed
      model: sdkModel,
      includePartialMessages: true,
      // Per-agent tool policy: every tool call (built-ins, hub MCP tools, skills) is classified and decided
      // in the PreToolUse hook; "ask" parks the call on an approval card for up to 10 minutes.
      hooks: { PreToolUse: [{ hooks: [gate.sdkHook({ agentName, cwd: sandboxOpts ? sandboxOpts.cwd : process.cwd(), origin: options.origin || null, notify: (ev) => sendSSE(res, makeChunk('', sdkModel, ev)) })], timeout: Math.ceil(approvals.timeoutMs / 1000) + 120 }] },
      // acceptEdits by default. HUB_AGENT_PERMISSION_MODE=bypassPermissions in .env gives agents
      // unprompted full access to this machine (trusted single-user installs only).
      permissionMode: SDK_PERMISSION_MODE,
      ...(SDK_PERMISSION_MODE === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      allowedTools: hubHands ? ['mcp__agent-hub__*', 'mcp__hub__*'] : sandboxWithheld ? ['mcp__agent-hub__*'] : [
        'Bash(*)',
        'Read(*)',
        'Write(*)',
        'Edit(*)',
        'Glob(*)',
        'Grep(*)',
        'NotebookEdit(*)',
        'WebFetch(*)',
        'WebSearch(*)',
        'mcp__agent-hub__*',
      ],
      ...(hubHands || sandboxWithheld ? { disallowedTools: [...hubToolsLib.CLIENT_BUILTINS] } : {}),
      maxTurns: 200,
      tools: { type: 'preset', preset: 'claude_code' },
      mcpServers: {
        'agent-hub': hubMcp,
      },
      settings: {
        autoMemoryEnabled: false,
      },
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: agentContext + workerPolicyText + jobsPolicyText + visualsText + handsNote + `

## CONTEXT MANAGEMENT (MANDATORY)
You are running inside My Maestro AI. Your session has a finite context window (~${contextWindow.label(CONTEXT_LIMIT)} tokens). When context fills up, the session DIES — the user sees frozen workers and no explanation. To prevent this:
1. **When you notice context compaction** (the system summarizes earlier messages), this means you're approaching limits. Proactively save important state to memory files.
2. **For long multi-step tasks**, periodically save progress to memory so a new session can continue where you left off.
3. **If you see a context warning** (75% or 90%), immediately: (a) save critical state to memory, (b) finish the current task as concisely as possible, (c) tell the user they should start a fresh conversation soon.
4. **Prefer concise tool output** — use head/tail/limit options on file reads, keep bash output short.
5. **Don't re-read files** you've already read unless absolutely necessary.
6. **Never tell the user the session is full or near its limit on a guess.** Say it only after you have actually seen compaction or a context warning.`,
      },
    };

    // Member-owned agents never get the Claude client's own sub-agent tool: their parallel help is the hub's
    // temporary workers (spawn_workers), which run on any provider inside the same sandbox.
    const memberOwned = await (async () => { try { const o = await ownerOfAgent(agentName); return !!(o && !adminIdSet().has(String(o))); } catch { return false; } })();
    const blockedTools = workerPolicy.disallowedToolsFor(memberOwned ? 'off' : workerMode);
    const twVirtual = temporalWorkers.getVirtual(agentName);   // temporal worker: enforce its tool scope, never nest
    if (twVirtual) for (const t of temporalWorkers.sdkDisallowedFor(twVirtual.toolScope)) if (!blockedTools.includes(t)) blockedTools.push(t);
    for (const t of (options.excludeTools || [])) {   // e.g. comms turns withholding wallet tools
      const mcpName = `mcp__agent-hub__${t}`;
      if (!blockedTools.includes(mcpName)) blockedTools.push(mcpName);
    }
    if (blockedTools.length > 0) queryOptions.disallowedTools = [...new Set([...(queryOptions.disallowedTools || []), ...blockedTools])];   // sdkWorkers=off
    // The hub's hands for a tools=hub agent, minus anything its scope blocks (a read-only temporal worker gets no Bash/Write/Edit).
    if (hubHands && !sandboxWithheld) {
      queryOptions.mcpServers.hub = buildHandsMcpServer(sdk, hands.tools, { blocked: blockedTools });
      console.log(`[SDK ${agentName}] hands: hub tools (client built-ins off${hands.box ? ', inside the sandbox' : ''})`);
    }

    // Resumed sessions keep their original system prompt: send what changed since this session last saw it.
    if (!ephemeral) {
      try {
        contextRefreshPlan = contextRefresh.getContextRefresh().plan({ agent: agentName, sessionId: resumeSessionId, resumed: !!resumeSessionId, context: queryOptions.systemPrompt.append });
        if (contextRefreshPlan.block) console.log(`[context-refresh] ${agentName}: ${contextRefreshPlan.summary}`);
      } catch (e) { console.error(`[context-refresh] ${agentName}:`, e.message); contextRefreshPlan = null; }
    }
    contextPrefix = (contextRefreshPlan && contextRefreshPlan.block ? contextRefreshPlan.block : '') + (sdkHits.text ? `<hub_context>\n${sdkHits.text}\n</hub_context>\n\n` : '');
    if (resumeSessionId) {
      queryOptions.resume = resumeSessionId;
    }

    let sessionCaptured = false;

    const queryIterator = sdk.query({
      prompt: inputGenerator(),
      // cliOptions() pins the external Claude client — see lib/sdk-loader.js
      options: { ...queryOptions, ...cliOptions(), ...(sandboxOpts ? { pathToClaudeCodeExecutable: sandboxOpts.pathToClaudeCodeExecutable, cwd: sandboxOpts.cwd } : {}) },
    });

    // The plan-limit fallback is visible in the chat, once per turn, before anything else streams.
    if (options.planFallback) {
      const fb = options.planFallback;
      const when = fb.resetsAt ? new Date(fb.resetsAt).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'the window resets';
      const line = `_⚠️ ${String(fb.from).split('/').pop()} is at ${fb.reason}; this turn runs on ${String(fb.model).split('/').pop()} until ${when}._\n\n`;
      sendSSE(res, makeChunk('', sdkModel, { type: 'model_fallback', from: fb.from, to: fb.model, utilization: fb.utilization, resetsAt: fb.resetsAt }));
      sendSSE(res, makeChunk(line, sdkModel));
      noticePrefix += line;
    }
    // Plan warning (lib/plan-usage warningFor): text only, no event chunk; saved with the reply like the other notices.
    if (options.planWarning && options.planWarning.line) {
      sendSSE(res, makeChunk(options.planWarning.line, sdkModel));
      noticePrefix += options.planWarning.line;
    }
    // Auto model: the classifier's verdict and the model answering, as an event and a one-line notice.
    if (options.autoPicked) {
      const p = options.autoPicked;
      const running = `claude-sdk/${sdkModel}`;
      const ev = { type: 'auto_model', category: p.category, model: running, wouldPick: p.wouldPick || null, backend: p.backend || 'builtin', confidence: p.confidence == null ? null : p.confidence, shadow: !!p.shadow, applied: p.applied !== false, reason: p.reason || null, ms: p.ms == null ? null : p.ms };
      const notice = noticeFor(p, agentModel);
      // Event and notice go as two chunks: the pages act on the event and `continue` before reading that chunk's
      // text, so a combined chunk loses the line. The notice is part of the saved reply (noticePrefix).
      sendSSE(res, makeChunk('', sdkModel, ev));
      if (notice) { sendSSE(res, makeChunk(notice, sdkModel)); noticePrefix += notice; }
    }

    for await (const msg of queryIterator) {
      // The client compacted the conversation: context updates sent in earlier messages may be summarised away,
      // so the next turn gets the full current context again (lib/context-refresh).
      if (msg && msg.type === 'system' && msg.subtype === 'compact_boundary') {
        try { contextRefresh.getContextRefresh().forget(agentName); contextRefreshPlan = null; } catch {}
        console.log(`[context-refresh] ${agentName}: client compacted the conversation; full context goes with the next turn`);
      }
      if (abortController.signal.aborted) break;

      // Capture session ID
      if (msg.session_id && !sessionCaptured) {
        sessionCaptured = true;
        sessionIdSeen = msg.session_id;
        if (!ephemeral) {
          setAgentSessionId(agentName, msg.session_id);
        }
        console.log(`[SDK ${agentName}] Session: ${msg.session_id}${isResuming ? ' (resumed)' : ' (new)'}`);
        sendSSE(res, makeChunk('', sdkModel, {
          type: 'session_id',
          session_id: msg.session_id,
          resumed: isResuming,
        }));
      }

      // Plan usage: the client reports the subscription's windows as they change; a "rejected" is the limit biting.
      if (msg.type === 'rate_limit_event') {
        try { planUsage.getPlanUsage().noteEvent(msg.rate_limit_info, sdkModel, agentName); } catch {}
        const ri = msg.rate_limit_info || {};
        if (ri.status === 'rejected') {
          let auto = false; try { auto = planUsage.getPlanUsage().policy().enabled; } catch {}
          const until = ri.resetsAt ? `, resets ${planUsage.whenText(new Date(Number(ri.resetsAt) * (Number(ri.resetsAt) < 1e12 ? 1000 : 1)).toISOString())}` : '';
          const next = auto ? 'The next turn falls back to the substitute model.' : 'Pick another model for this agent in the chat header; this one answers again after the reset.';
          sendSSE(res, makeChunk(`\n\n_⚠️ The Claude plan refused ${sdkModel} (${ri.rateLimitType || 'limit'} reached${until}). ${next}_\n\n`, sdkModel));
        }
        continue;
      }

      // Replay ack: the SDK has just consumed one of OUR user messages.
      if (msg.type === 'user' && msg.isReplay) {
        const ij = ijChannel.ack(msg.uuid);
        if (ij) {
          console.log(`[interject] Delivered to ${agentName} mid-session (${ijChannel.results === 0 ? 'inside running turn' : 'follow-up turn'}): "${ij.message.slice(0, 80)}"`);
          // A follow-up turn continues in the same chat bubble: separate it visibly.
          if (ijChannel.results > 0 && fullResponse && !fullResponse.endsWith('\n\n')) {
            fullResponse += '\n\n';
            sendSSE(res, makeChunk('\n\n', sdkModel));
          }
          sendSSE(res, makeChunk('', sdkModel, { type: 'interjection_received', message: ij.message, ts: ij.ts }));
        }
        continue;
      }

      // Stream events (text deltas, tool use, etc.)
      if (msg.type === 'stream_event') {
        const evt = msg.event;

        // Text delta
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
          const text = evt.delta.text || '';
          if (text) {
            // Update progress to streaming phase
            if (progressState.phase !== 'stream') {
              progressState.phase = 'stream';
              progressState.detail = 'Writing';
              progressState.phaseStart = Date.now();
            }
            // If produced inside a subagent, route text to the worker display
            const worker = sdkWorkers.workerFor(msg);
            if (worker) {
              sendSSE(res, makeChunk('', sdkModel, {
                type: 'worker_text_delta',
                worker_id: worker.workerId,
                text,
              }));
            } else {
              if (textAfterTool) { textAfterTool = false; const sep = paragraphAfterTool(fullResponse); if (sep) { fullResponse += sep; sendSSE(res, makeChunk(sep, sdkModel)); } }
              fullResponse += text;
              sendSSE(res, makeChunk(text, sdkModel));
            }
          }
        }

        // Tool use start
        else if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
          const toolName = evt.content_block.name || 'unknown';
          toolCallCount++;
          // Update progress to tool phase
          progressState.phase = 'tool';
          progressState.detail = toolName;
          progressState.phaseStart = Date.now();
          // If produced inside a subagent, emit as worker tool event
          const worker = sdkWorkers.workerFor(msg);
          if (!worker) textAfterTool = true;   // the agent's own call: its next text starts a new paragraph
          if (worker) {
            sendSSE(res, makeChunk('', sdkModel, {
              type: 'worker_tool_start',
              worker_id: worker.workerId,
              tool: toolName,
            }));
          } else {
            sendSSE(res, makeChunk('', sdkModel, {
              type: 'tool_start',
              tool: toolName,
              tool_call_id: evt.content_block.id,
            }));
          }
        }

        // Tool block complete
        else if (evt.type === 'content_block_stop') {
          // Tool result will be surfaced via assistant/user messages below
        }

        // Message start — track turn count and get detailed context usage from SDK
        else if (evt.type === 'message_start') {
          turnCount++;
          // Reset progress to thinking phase
          progressState.phase = 'model';
          progressState.detail = '';
          progressState.phaseStart = Date.now();
          console.log(`[SDK ${agentName}] message_start event received, turn ${turnCount}`);

          // Query SDK for detailed context breakdown (tools, memory, messages, etc.)
          try {
            const ctxUsage = await queryIterator.getContextUsage();
            const toolsCategory = ctxUsage.categories?.find(c => c.name === 'Tools' || c.name === 'tools');
            const mcpToolsCount = ctxUsage.mcpTools?.length || 0;
            const toolTokens = toolsCategory?.tokens || 0;

            console.log(`[SDK ${agentName}] Context: ${ctxUsage.totalTokens?.toLocaleString()}/${ctxUsage.maxTokens?.toLocaleString()} tokens (${ctxUsage.percentage}%) — ${mcpToolsCount} MCP tools, ${toolTokens.toLocaleString()} tool tokens`);
            console.log(`[SDK ${agentName}] Categories:`, ctxUsage.categories?.map(c => `${c.name}:${c.tokens}`).join(', '));

            sendSSE(res, makeChunk('', sdkModel, {
              type: 'context_health',
              input_tokens: ctxUsage.totalTokens || 0,
              output_tokens: totalOutputTokens,
              // ctxUsage.maxTokens/percentage are relative to the compact window we set, not the real window
              context_limit: CONTEXT_LIMIT,
              usage_percent: Math.round(((ctxUsage.totalTokens || 0) / CONTEXT_LIMIT) * 100),
              prompt_num: promptNum,
              tool_calls: toolCallCount,
              tool_tokens: toolTokens,
              mcp_tools: mcpToolsCount,
              categories: ctxUsage.categories,
            }));

            lastInputTokens = ctxUsage.totalTokens || 0;
          } catch (e) {
            // Fallback to basic usage from message_start if getContextUsage fails
            console.log(`[SDK ${agentName}] getContextUsage failed:`, e.message || e);
            if (evt.message?.usage) {
              const u = evt.message.usage;
              const contextTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
              lastInputTokens = contextTokens;
              const usagePercent = Math.round((contextTokens / CONTEXT_LIMIT) * 100);
              console.log(`[SDK ${agentName}] Context (fallback): ${contextTokens.toLocaleString()} tokens (${usagePercent}%)`);
              sendSSE(res, makeChunk('', sdkModel, {
                type: 'context_health',
                input_tokens: contextTokens,
                output_tokens: totalOutputTokens,
                context_limit: CONTEXT_LIMIT,
                usage_percent: usagePercent,
                prompt_num: promptNum,
                tool_calls: toolCallCount,
              }));
            }
          }
        }

        // Message delta — contains cumulative output token count
        else if (evt.type === 'message_delta' && evt.usage) {
          totalOutputTokens = evt.usage.output_tokens || totalOutputTokens;
          // Send live token usage update to frontend for the token bar
          sendSSE(res, makeChunk('', sdkModel, {
            type: 'token_usage',
            usage: {
              prompt_tokens: lastInputTokens,
              completion_tokens: totalOutputTokens,
              total_tokens: lastInputTokens + totalOutputTokens,
            },
          }));
        }
      }

      // Full assistant message — extract tool_use blocks with input
      else if (msg.type === 'assistant' && msg.message?.content) {
        if (msg.message.stop_reason === 'end_turn') turnWatch.expectExit();   // the model is done: the client must exit soon
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            toolCallCount++;
            const inputStr = typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {});
            const inp = (() => { try { return typeof block.input === 'object' ? block.input : JSON.parse(inputStr); } catch { return {}; } })();

            // Produced inside a subagent: emit as worker tool events
            const innerWorker = sdkWorkers.workerFor(msg);
            if (innerWorker) {
              const worker = innerWorker;
              let inputSummary = inp.file_path || inp.command?.substring(0, 120) || inp.pattern || inp.query || inputStr.substring(0, 120);
              sendSSE(res, makeChunk('', sdkModel, {
                type: 'worker_tool_start',
                worker_id: worker.workerId,
                tool: block.name,
              }));
              sendSSE(res, makeChunk('', sdkModel, {
                type: 'worker_tool_use',
                worker_id: worker.workerId,
                tool: block.name,
                input: inputSummary,
              }));
              continue;
            }

            // Top-level SDK Agent (subagent) tool call: open a worker panel
            if (block.name === 'Agent') {
              const w = sdkWorkers.register({ id: block.id, input: inp });
              console.log(`[SDK ${agentName}] Subagent spawned: ${w.description} (model: ${w.model}, id: ${w.workerId})`);
              sendSSE(res, makeChunk('', sdkModel, {
                type: 'worker_started',
                worker_id: w.workerId,
                agent_type: 'sdk-agent',
                description: `SDK Worker: ${w.description}`,
                model: w.model,
                prompt: w.prompt || w.description,
              }));
              sendSSE(res, makeChunk('', sdkModel, {
                type: 'tool_use',
                tool: `Agent (${w.model})`,
                input: w.description,
                tool_call_id: block.id,
              }));
              continue;
            }

            let inputSummary = inp.file_path || inp.command?.substring(0, 120) || inp.pattern || inp.query || inputStr.substring(0, 120);
            sendSSE(res, makeChunk('', sdkModel, {
              type: 'tool_use',
              tool: block.name,
              input: inputSummary,
              tool_call_id: block.id,
            }));
          }
        }
      }

      // Tool result — comes back as a user message with tool_use_result
      else if (msg.type === 'user' && msg.tool_use_result !== undefined) {
        const r = sdkWorkers.resolveResult(msg);

        // A tool result produced inside a subagent
        if (r.kind === 'inner') {
          sendSSE(res, makeChunk('', sdkModel, {
            type: 'worker_tool_result',
            worker_id: r.worker.workerId,
            output: r.output,
          }));
        }
        // The Agent tool's own result: the subagent has finished
        else if (r.kind === 'completed') {
          for (const c of r.completed) {
            console.log(`[SDK ${agentName}] Subagent completed: ${c.worker.description} (${c.elapsedMs}ms)`);
            sendSSE(res, makeChunk('', sdkModel, {
              type: 'worker_completed',
              worker_id: c.worker.workerId,
            }));
            sendSSE(res, makeChunk('', sdkModel, {
              type: 'tool_result',
              tool_call_id: c.toolUseId,
              output: c.output || `SDK Worker completed: ${c.worker.description}`,
            }));
          }
        }
        else {
          sendSSE(res, makeChunk('', sdkModel, {
            type: 'tool_result',
            tool_call_id: r.toolUseIds[0] || '',
            output: r.output,
          }));
        }
      }

      // Tool use summary — alternative tool result event
      else if (msg.type === 'tool_use_summary') {
        const summaryToolId = msg.preceding_tool_use_ids?.[0] || '';
        // A summary covering an Agent tool call means that subagent has finished
        for (const c of sdkWorkers.completeByIds(msg.preceding_tool_use_ids)) {
          console.log(`[SDK ${agentName}] Subagent completed (summary): ${c.worker.description} (${c.elapsedMs}ms)`);
          sendSSE(res, makeChunk('', sdkModel, {
            type: 'worker_completed',
            worker_id: c.worker.workerId,
          }));
        }
        sendSSE(res, makeChunk('', sdkModel, {
          type: 'tool_result',
          tool_call_id: summaryToolId,
          output: msg.summary || 'Done',
        }));
      }

      // Result
      else if (msg.type === 'result') {
        turnWatch.clear();
        if (contextRefreshPlan && !msg.is_error) { try { contextRefreshPlan.commit(sessionIdSeen || msg.session_id); } catch {} contextRefreshPlan = null; }
        // SDK has finished — result text may differ from streamed text
        // Use streamed fullResponse since it was already sent to browser
        if (msg.result && !fullResponse) {
          fullResponse = msg.result;
          sendSSE(res, makeChunk(msg.result, sdkModel));
        }
        if (noticePrefix && fullResponse && !fullResponse.startsWith(noticePrefix)) fullResponse = noticePrefix + fullResponse;
        // A failed result (rate limit after the client's own retries, overload, crash) is a typed
        // event for the pacing layer, not an answer: a coordinator must not file "API Error: 429"
        // as a specialist's finding.
        try {
          const u = msg.usage || {};
          // msg.total_cost_usd is the SESSION's running total (a resumed session keeps adding), not this
          // turn's cost: booking it per turn multiplied the day's spend by the number of turns. Use the
          // increase since the last result of the same session when known, else price this turn's usage
          // (cache reads at 10%, cache writes at 125% of the input rate).
          let costUsd = null;
          if (typeof msg.total_cost_usd === 'number') {
            const key = `${agentName}|${msg.session_id || ''}`;
            const prev = sessionCostSeen.get(key);
            if (prev != null && msg.total_cost_usd >= prev) costUsd = msg.total_cost_usd - prev;
            sessionCostSeen.set(key, msg.total_cost_usd);
          }
          if (costUsd == null) costUsd = ledger.estimateCost(agentModel, u.input_tokens || 0, u.output_tokens || 0, { cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 });
          ledger.record({ agent: agentName, origin: options.origin && options.origin.kind, model: agentModel,
            inputTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), outputTokens: u.output_tokens || 0,
            costUsd, durationMs: msg.duration_ms, tools: null, ok: !msg.is_error });
        } catch {}
        if (msg.is_error || (msg.subtype && msg.subtype !== 'success')) {
          const cls = providerPacing.classify(new Error(String(msg.result || msg.subtype || 'error')));
          console.log(`[SDK ${agentName}] result is_error (${msg.subtype || 'error'}) -> turn_error ${cls.kind}`);
          sendSSE(res, makeChunk('', sdkModel, { type: 'turn_error', kind: cls.kind === 'ok' ? 'error' : cls.kind, transient: cls.transient, retryAfterMs: cls.retryAfterMs, message: String(msg.result || msg.subtype || 'error').slice(0, 300) }));
          { const fix = require('./claude-auth').signInFixText(msg.result); if (fix) { sendSSE(res, makeChunk(fix, sdkModel)); fullResponse += fix; } }   // the sign-in, in plain words
        }
        // Close the input stream only when every message we sent has been
        // acknowledged; otherwise the SDK still owes a follow-up turn.
        const runOver = ijChannel.onResult();
        if (!runOver) console.log(`[interject] ${agentName}: result #${ijChannel.results} received, interjection outstanding - holding session open for follow-up turn`);
      }
    }
  } catch (err) {
    console.error(`[SDK ${agentName}] Error:`, err.message);
    if (!res.writableEnded) {
      // A full context and a plain crash need different messages: the session survives a crash
      // (the next message resumes it), so never announce "Session ended" for one.
      const exit = contextWindow.classifyExit({ message: err.message, usedTokens: lastInputTokens, limit: CONTEXT_LIMIT });
      const isContextDeath = exit.kind === 'context';
      if (!isContextDeath) console.log(`[SDK ${agentName}] Process stopped (${exit.why}) at ${lastInputTokens}/${CONTEXT_LIMIT} tokens; session is intact and resumes on the next message`);

      if (isContextDeath) {
        const usagePercent = Math.round((lastInputTokens / CONTEXT_LIMIT) * 100);
        console.log(`[SDK ${agentName}] Context exhaustion detected: ${lastInputTokens}/${CONTEXT_LIMIT} (${usagePercent}%)`);
        sendSSE(res, makeChunk('', sdkModel, {
          type: 'context_exhausted',
          input_tokens: lastInputTokens,
          context_limit: CONTEXT_LIMIT,
          usage_percent: usagePercent,
          turns_completed: turnCount,
        }));
        sendSSE(res, makeChunk(
          `\n\n🛑 **Session ended — context window full** ` +
          `(${lastInputTokens.toLocaleString()} tokens used over ${turnCount} turns). ` +
          `Start a new conversation to continue — memory and session notes are preserved.`,
          sdkModel
        ));
      } else {
        { const cls = providerPacing.classify(err); sendSSE(res, makeChunk('', sdkModel, { type: 'turn_error', kind: cls.kind === 'ok' || cls.kind === 'error' ? 'crash' : cls.kind, transient: cls.transient, retryAfterMs: cls.retryAfterMs, message: String(err.message || 'process stopped').slice(0, 300) })); }
        sendSSE(res, makeChunk('', sdkModel, { type: 'session_interrupted', error: err.message, input_tokens: lastInputTokens, context_limit: CONTEXT_LIMIT, usage_percent: Math.round((lastInputTokens / CONTEXT_LIMIT) * 100), turns_completed: turnCount }));
        sendSSE(res, makeChunk(`\n\n⚠️ The agent's process stopped unexpectedly (${err.message.slice(0, 160)}). Your session is intact: send your next message and it resumes where it left off. Anything the agent was in the middle of may need to be repeated.`, sdkModel));
        { const fix = require('./claude-auth').signInFixText(err.message); if (fix) sendSSE(res, makeChunk(fix, sdkModel)); }
      }
    }
  } finally {
    clearInterval(heartbeatTimer);
    try { turnWatch.clear(); } catch {}
    clearInterval(incrementalSaveTimer);
    clearInterval(progressTicker);

    // Clean up any frozen SDK workers — emit worker_failed for each
    if (sdkWorkers.size > 0) {
      console.log(`[SDK ${agentName}] Cleaning up ${sdkWorkers.size} orphaned worker(s)`);
      for (const worker of sdkWorkers.drain()) {
        sendSSE(res, makeChunk('', sdkModel, {
          type: 'worker_failed',
          worker_id: worker.workerId,
          error: 'Session ended while worker was active',
        }));
      }
    }

    activeResponses.delete(agentName);

    // Context compression check (lib/compaction): at the agent's threshold, or on its own request, the
    // agent's compression turn runs once THIS turn has fully closed (a couple of seconds later), so the
    // hub does not see the agent as busy. Never for ephemeral (consulted) turns.
    if (!ephemeral && lastInputTokens > 0) {
      const tokensAtEnd = lastInputTokens, limitAtEnd = CONTEXT_LIMIT, sessAtEnd = sessionIdSeen;
      setTimeout(() => { try { const p = compaction.noteUsage(agentName, tokensAtEnd, limitAtEnd, sessAtEnd); if (p && p.catch) p.catch(e => console.error(`[compaction] ${agentName}:`, e.message)); } catch (e) { console.error(`[compaction] ${agentName}:`, e.message); } }, 2500);
    }

    // Persist response (overwrite if we did incremental saves), with the turn's tool calls in place
    if (fullResponse.trim() && !ephemeral) {
      appendConversationLog(agentName, 'assistant', fullResponse, lastSavedLength > 0, activityMeta(agentName, fullResponse));
    }

    // Interjections.  Close the live channel, then account for every message:
    //  - delivered (SDK acknowledged it)  -> history only
    //  - not provably delivered            -> stashed on disk and prepended to the
    //    agent's NEXT turn, so nothing the operator typed is ever silently dropped.
    // History entries are written after the assistant save above so the
    // overwrite-last incremental save cannot clobber them.
    ijChannel.close();
    if (sdkInterjectChannels.get(agentName) === ijChannel) sdkInterjectChannels.delete(agentName);
    const ijMissed = ijChannel.undelivered().concat(drainInterjections(agentName));
    if (!ephemeral) {
      for (const ij of ijChannel.delivered()) {
        appendConversationLog(agentName, 'user', `[${ijLabel(ij)} (delivered mid-session)]: ${ij.message}`);
      }
      for (const ij of ijMissed) {
        appendConversationLog(agentName, 'user', `[${ijLabel(ij)} (not delivered in time - will be delivered with your next message)]: ${ij.message}`);
      }
    }
    if (ijMissed.length > 0) {
      try {
        sdkInterject.stashUndelivered(agentName, ijMissed);
        console.log(`[interject] ${ijMissed.length} interjection(s) for ${agentName} missed this turn - stashed for next-turn delivery`);
        sendSSE(res, makeChunk('', sdkModel, { type: 'interjection_deferred', count: ijMissed.length }));
      } catch (e) {
        console.error(`[interject] Failed to stash undelivered interjections for ${agentName}:`, e.message);
      }
    }

    // Send [DONE] and close
    sendSSEDone(res);
    if (!res.writableEnded) res.end();
  }
}

// ── Codex CLI agents (ChatGPT subscription) ─────────────────────────────
// `codex-cli/<model>` agents run through the official Codex CLI, which uses the
// owner's ChatGPT login instead of an API key (see lib/codex-cli/index.js).
// Each turn runs one `codex app-server` process (JSON-RPC over stdio, see
// lib/codex-cli/app-server.js); the thread id is stored per agent and resumed
// next turn. Hub tools reach Codex through a per-turn MCP bridge.
// Interjections that arrive mid-turn go into the running turn with turn/steer;
// any Codex refuses or never confirms run as a follow-up turn in the same
// response. Stop maps to turn/interrupt. HUB_CODEX_TRANSPORT=exec (or an
// app-server that fails to start) uses the older `codex exec` path, where every
// interjection runs as a follow-up turn.

const CODEX_MAX_FOLLOWUPS = 5;

/** Run one `codex exec` process; calls onEvent(parsedJson) per line. Resolves {code, stderrTail}. */
function runCodexProcess({ bin, args, cwd, env, input, signal, onEvent, agentName }) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let stderrTail = '';
    let killTimer = null;
    const kill = () => {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
      killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000);
    };
    if (signal) {
      if (signal.aborted) kill();
      else signal.addEventListener('abort', kill, { once: true });
    }
    const rl = require('readline').createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const ev = codexCli.parseLine(line);
      if (ev) { try { onEvent(ev); } catch (e) { console.error(`[codex ${agentName}] event handler: ${e.message}`); } }
    });
    child.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-4000);
      for (const l of String(d).split('\n')) if (/\bERROR\b|error:|panicked/i.test(l)) console.error(`[codex ${agentName} stderr] ${l.slice(0, 400)}`);
    });
    child.on('error', (e) => { stderrTail += `\n${e.message}`; });
    child.on('close', (code) => {
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener('abort', kill);
      resolve({ code, stderrTail });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);   // stdin must close, or codex waits for more input
  });
}

async function streamViaCodex(agentName, userMessage, images, res, options = {}) {
  const { ephemeral, signal } = options;
  const agentModel = options.modelOverride || await getAgentModel(agentName);
  const model = codexCli.modelId(agentModel);
  const codexEffort = effortLib.forModel(agentModel, await agentEffort(agentName));   // lib/effort -> model_reasoning_effort
  const bin = codexCli.resolveBinary();

  const abortController = new AbortController();
  if (signal) signal.addEventListener('abort', () => abortController.abort(), { once: true });
  // A browser disconnect no longer aborts the turn; POST /api/chat/stop does.

  if (typeof res.writeHead === 'function') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  }
  try { res.write(': ping\n\n'); } catch {}

  if (!bin) {
    sendSSE(res, makeChunk('⚠️ The Codex CLI is not installed on this machine. Install it with `npm i -g @openai/codex`, run `codex login --device-auth` once, and try again.', agentModel));
    sendSSEDone(res);
    if (!res.writableEnded) res.end();
    return;
  }

  const heartbeatTimer = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) { try { res.write(': heartbeat\n\n'); } catch {} }
  }, HEARTBEAT_INTERVAL_MS);

  let fullResponse = '';
  let lastSavedLength = 0;
  activeResponses.set(agentName, { get fullResponse() { return fullResponse; }, startTs: Date.now(), lastSavedLength: 0 });
  const incrementalSaveTimer = setInterval(() => {
    if (fullResponse.length > lastSavedLength + 100 && !ephemeral) {
      appendConversationLog(agentName, 'assistant', fullResponse, lastSavedLength > 0);
      lastSavedLength = fullResponse.length;
      const tracked = activeResponses.get(agentName);
      if (tracked) tracked.lastSavedLength = lastSavedLength;
    }
  }, 5000);

  let turnCount = 0;
  const progressState = { phase: 'model', detail: '', start: Date.now(), phaseStart: Date.now() };
  const setPhase = (phase, detail = '') => { progressState.phase = phase; progressState.detail = detail; progressState.phaseStart = Date.now(); };
  const progressTicker = setInterval(() => {   // also once the browser has gone: pages following the turn get it via the hub
    try {
      const now = Date.now();
      sendSSE(res, makeChunk('', agentModel, { type: 'progress', phase: progressState.phase, detail: progressState.detail, turn: turnCount || 1, phase_ms: now - progressState.phaseStart, total_ms: now - progressState.start }));
    } catch {}
  }, 1000);

  const carried = ephemeral ? [] : sdkInterject.takeUndelivered(agentName);
  if (carried.length > 0) console.log(`[interject] Delivering ${carried.length} carried-over interjection(s) to ${agentName} with this turn`);
  const delivered = [];
  const steered = [];   // interjections Codex accepted into the running turn (turn/steer)
  let bridge = null;
  let session = null;   // CodexAppSession, or null when this turn runs on `codex exec`
  let activePump = null;
  codexTurns.add(agentName);

  try {
    // Hub tools: the same set (and gating) a Claude SDK agent gets, collected rather than served in-process.
    const collected = await buildHubMcpServer(agentName, res, codexBridge.collectingSdk, { consultationDepth: options.consultationDepth || 0, consultedBy: options.consultedBy || null, abortSignal: abortController.signal });
    const twVirtual = temporalWorkers.getVirtual(agentName);
    const excluded = new Set(options.excludeTools || []);
    if (twVirtual) for (const t of temporalWorkers.gatewayExcludesFor(twVirtual.toolScope)) excluded.add(t);
    const hubTools = collected.tools.filter(t => !excluded.has(t.name));
    // Hands (lib/hub-tools): with tools=hub Codex gets the hub's Bash/Read/Write/Edit/Glob/Grep/Web* through the same
    // bridge and its own shell is confined to read-only; a sandboxed agent's hands act inside its container.
    const hands = await handsForTurn(agentName, { consultationDepth: options.consultationDepth || 0 });
    const hubHands = hands.mode === 'hub' && !hands.withheld;
    if (hubHands) {
      const h = buildHandsMcpServer(codexBridge.collectingSdk, hands.tools, { blocked: twVirtual ? temporalWorkers.sdkDisallowedFor(twVirtual.toolScope) : [] });
      for (const t of h.tools) hubTools.push(t);
      console.log(`[codex ${agentName}] hands: hub tools (${h.tools.length}, own shell read-only${hands.box ? ', inside the sandbox' : ''})`);
    }
    bridge = codexBridge.register(agentName, hubTools, { url: `http://127.0.0.1:${HUB_PORT}`,
      beforeCall: (name, args) => gate.check({ agentName, tool: name, input: args, cwd, origin: options.origin || null, notify: (ev) => sendSSE(res, makeChunk('', agentModel, ev)) }) });

    const agentContext = await loadAgentContext(agentName, 'hub', { recallQuery: userMessage });
    let workerRoster = [];
    try { workerRoster = workerPolicy.buildRoster(await peerAgents(agentName), { selfName: agentName, isActive: isAgentActive }); } catch {}
    // Codex has no SDK sub-agent tool: it gets only the shared platform delegation text.
    const workerPolicyText = ephemeral ? '' : workerPolicy.platformPolicyText(workerRoster);
    const jobsPolicyText = twVirtual ? '' : jobs.policyText() + scheduledTasks.policyText();
    const visualsText = ephemeral ? '' : (await visualsTextFor(agentName)) + connectorsTextFor(agentName) + (await hubBriefTextFor(agentName));
    let instructions = agentContext + workerPolicyText + jobsPolicyText + visualsText + `

## HUB TOOLS
My Maestro AI's tools (memory, shared memory, consult_agent, spawn_workers, run_job and the rest) are available to you as the MCP server "agent-hub". Your shell dies with your turn: anything that must outlive it goes through run_job.` + (hubHands ? `

## YOUR HANDS
Your shell, file and web tools are the hub's: Bash, Read, Write, Edit, Glob, Grep, WebSearch and WebFetch on the same "agent-hub" MCP server. Use them for every command, read, search and edit; your own shell is read-only here. Read before Edit; Edit needs an exact, unique match; Read shows images and PDF pages.` : '');
    const fullInstructions = instructions;   // app-server takes them over stdin: no argv size limit
    let promptPreamble = '';
    if (Buffer.byteLength(instructions) > codexCli.MAX_INSTRUCTIONS_ARG) {
      // Too big for one argv string: keep the tail (policies) as instructions, move the rest into the prompt.
      promptPreamble = `<agent_context>\n${agentContext}\n</agent_context>\n\n`;
      instructions = instructions.slice(agentContext.length);
    }

    const sandbox = hubHands ? 'read-only' : codexCli.sandboxFor({ toolScope: twVirtual ? twVirtual.toolScope : null });
    // Codex's own shell with its sandbox bypassed is the host as the hub's user: never for a member's agent. Members get
    // Codex through hub hands (tools=hub) or where HUB_CODEX_SANDBOX makes Codex's sandbox work (review F22/F35).
    if (sandbox === 'danger-full-access') {
      const rec = (await getAgents()).find(a => a.name === (twVirtual && twVirtual.parent ? twVirtual.parent : agentName));
      if (rec && rec.owner && !adminIdSet().has(String(rec.owner))) throw new Error('Codex models run with full host access on this hub, which a member\'s agent may not have. Ask the owner to set this agent\'s tools to "hub" or choose another model.');
    }
    const cwd = await getAgentWorkspace(agentName);
    // Never let an API key in the hub's environment switch Codex off the subscription.
    const env = { ...process.env };
    delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY; delete env.OPENAI_BASE_URL;

    let threadId = ephemeral ? null : codexCli.getSession(agentName, model);
    let lastCumulative = { input: 0, output: 0 };
    let prompt = sdkInterject.formatCarried(carried) + userMessage.replace(/\[Image: [^\]]+\]\n*/g, '').trim();
    let turnImages = images || [];

    const announceThread = (id, resumed) => {
      if (id !== threadId) {
        threadId = id;
        lastCumulative = { input: 0, output: 0 };
        if (!ephemeral) codexCli.setSession(agentName, id, model);
      }
      console.log(`[codex ${agentName}] Thread: ${id}${resumed ? ' (resumed)' : ' (new)'}`);
      sendSSE(res, makeChunk('', agentModel, { type: 'session_id', session_id: id, resumed }));
    };
    const stopWith = (why) => {
      why = String(why).slice(0, 300);
      const loginHint = /login|auth|401|unauthori[sz]ed|token/i.test(why) ? ' Run `codex login --device-auth` on the hub machine to sign in again.' : '';
      { const cls = providerPacing.classify(new Error(why)); sendSSE(res, makeChunk('', agentModel, { type: 'turn_error', kind: cls.kind === 'ok' || cls.kind === 'error' ? 'crash' : cls.kind, transient: cls.transient, retryAfterMs: cls.retryAfterMs, message: why })); }
      sendSSE(res, makeChunk('', agentModel, { type: 'session_interrupted', error: why, turns_completed: turnCount }));
      sendSSE(res, makeChunk(`\n\n⚠️ Codex stopped: ${why}.${loginHint}`, agentModel));
    };

    // One handler for both transports. `rs` is per-round state: {turnError, sawOutput, needSep, pump}.
    const handleAction = (a, rs) => {
      if (a.kind === 'text_begin') {
        rs.needSep = true;
      } else if (a.kind === 'text') {
        rs.sawOutput = true;
        setPhase('stream', 'Writing');
        // exec sends whole messages; app-server streams deltas, separated at each new message.
        const sep = (!a.delta || rs.needSep) && fullResponse && !fullResponse.endsWith('\n') ? '\n\n' : '';
        rs.needSep = false;
        fullResponse += sep + a.text;
        sendSSE(res, makeChunk(sep + a.text, agentModel));
      } else if (a.kind === 'tool_start') {
        rs.sawOutput = true;
        setPhase('tool', a.tool);
        sendSSE(res, makeChunk('', agentModel, { type: 'tool_start', tool: a.tool, tool_call_id: a.id }));
        sendSSE(res, makeChunk('', agentModel, { type: 'tool_use', tool: a.tool, input: a.input, tool_call_id: a.id }));
      } else if (a.kind === 'tool_result') {
        setPhase('model');
        sendSSE(res, makeChunk('', agentModel, { type: 'tool_result', tool_call_id: a.id, output: a.output }));
      } else if (a.kind === 'thinking') {
        setPhase('model', 'Thinking');
      } else if (a.kind === 'user_message') {
        if (rs.pump) rs.pump.onUserMessage(a);
      } else if (a.kind === 'usage') {
        const u = a.usage;
        let input = u.input_tokens || 0, output = u.output_tokens || 0;
        if (!a.perTurn) {
          // exec reports thread-cumulative totals: show this turn's share.
          input = Math.max(0, input - lastCumulative.input);
          output = Math.max(0, output - lastCumulative.output);
          lastCumulative = { input: u.input_tokens || 0, output: u.output_tokens || 0 };
        }
        sendSSE(res, makeChunk('', agentModel, { type: 'token_usage', usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } }));
        try { ledger.record({ agent: agentName, origin: options.origin && options.origin.kind, model: agentModel, inputTokens: input, outputTokens: output, durationMs: null, ok: true }); } catch {}
      } else if (a.kind === 'error') {
        if (!a.soft) rs.turnError = a.message;
        console.error(`[codex ${agentName}] ${a.soft ? 'warning' : 'error'}: ${a.message}`);
      }
    };

    if (appServer.transportFor() === 'app-server') {
      try {
        session = await appServer.CodexAppSession.open({ bin, cwd, env, agentName, version: HUB_PKG_VERSION,
          // Shell commands and file changes outside Codex's trusted set come back as approval requests: the hub decides.
          onServerRequest: (method, params) => gate.codexServerRequest({ agentName, cwd, origin: options.origin || null, notify: (ev) => sendSSE(res, makeChunk('', agentModel, ev)) }, method, params) });
        const t = await session.openThread({ resumeId: threadId, model, cwd, sandbox, approvalPolicy: codexCli.approvalPolicyFor(), instructions: fullInstructions, bridge: { file: bridge.file }, ephemeral: !!ephemeral, effort: codexEffort });
        if (t.resumeError) console.log(`[codex ${agentName}] Resume of ${threadId} failed (${t.resumeError.slice(0, 160)}); started a new thread`);
        announceThread(t.threadId, t.resumed);
      } catch (e) {
        console.error(`[codex ${agentName}] app-server unavailable (${e.message.slice(0, 200)}); using codex exec for this turn`);
        if (session) session.close();
        session = null;
      }
    }

    for (let round = 0; round <= CODEX_MAX_FOLLOWUPS; round++) {
      const rs = { turnError: null, sawOutput: false, needSep: false, pump: null };

      if (session) {
        // app-server: interjections are steered into the running turn.
        const pump = new appServer.SteerPump({
          session,
          drain: () => (ephemeral ? [] : drainInterjections(agentName)),
          format: (ij) => `[${ijLabel(ij)}]: ${ij.message}`,
          onDelivered: (ij) => {
            steered.push(ij);
            sendSSE(res, makeChunk('', agentModel, { type: 'interjection_received', message: ij.message, ts: ij.ts }));
            console.log(`[interject] ${agentName}: steered into the running Codex turn: "${ij.message.slice(0, 80)}"`);
          },
          log: (m) => console.log(`[interject] ${agentName}: ${m}`),
        });
        rs.pump = pump;
        activePump = pump;
        if (!ephemeral) codexSteerChannels.set(agentName, pump);
        turnCount++;
        setPhase('model');
        const r = await session.runTurn({
          input: appServer.turnInput(prompt, turnImages),
          onAction: (a) => handleAction(a, rs),
          signal: abortController.signal,
          onStarted: () => pump.start(),
        });
        const left = await pump.finish();
        activePump = null;
        if (codexSteerChannels.get(agentName) === pump) codexSteerChannels.delete(agentName);
        // Refused or unconfirmed steers: back to the front of the queue, for the follow-up turn below.
        if (left.length > 0) requeueInterjections(agentName, left);
        if (abortController.signal.aborted || r.status === 'interrupted') break;
        if (r.status === 'failed' || rs.turnError) { stopWith(rs.turnError || r.error || 'Codex turn failed'); break; }
      } else {
        const resumed = !!threadId;
        const runOnce = () => runCodexProcess({
          bin, cwd, env, agentName, signal: abortController.signal, input: (threadId ? '' : promptPreamble) + prompt,
          args: codexCli.buildArgs({ model, resumeId: threadId, cwd, sandbox, instructions, bridge: { file: bridge.file }, images: turnImages, effort: codexEffort }),
          onEvent: (ev) => {
            for (const a of codexCli.eventToActions(ev)) {
              if (a.kind === 'session') announceThread(a.id, resumed);
              else handleAction(a, rs);
            }
          },
        });

        turnCount++;
        setPhase('model');
        let result = await runOnce();
        // A stored thread that no longer resumes (deleted, other machine): start fresh once.
        if (!abortController.signal.aborted && resumed && !rs.sawOutput && (result.code !== 0 || rs.turnError)) {
          console.log(`[codex ${agentName}] Resume of ${threadId} failed (${(rs.turnError || result.stderrTail).slice(0, 160)}); starting a new thread`);
          if (!ephemeral) codexCli.clearSession(agentName);
          threadId = null;
          rs.turnError = null;
          result = await runOnce();
        }
        if (abortController.signal.aborted) break;
        if (result.code !== 0 || rs.turnError) {
          stopWith(rs.turnError || result.stderrTail.trim().split('\n').pop() || `exit ${result.code}`);
          break;
        }
      }

      // Interjections sent while Codex was working: answer them now, in the same thread and bubble.
      const pending = ephemeral ? [] : drainInterjections(agentName);
      if (pending.length === 0) break;
      if (round === CODEX_MAX_FOLLOWUPS) { sdkInterject.stashUndelivered(agentName, pending); sendSSE(res, makeChunk('', agentModel, { type: 'interjection_deferred', count: pending.length })); break; }
      for (const ij of pending) {
        delivered.push(ij);
        sendSSE(res, makeChunk('', agentModel, { type: 'interjection_received', message: ij.message, ts: ij.ts }));
      }
      console.log(`[interject] ${agentName}: running Codex follow-up turn for ${pending.length} interjection(s)`);
      prompt = pending.map(ij => `[${ijLabel(ij)}]: ${ij.message}`).join('\n\n');
      turnImages = [];
    }
  } catch (err) {
    console.error(`[codex ${agentName}] Error:`, err.message);
    if (!res.writableEnded) {
      { const cls = providerPacing.classify(err); sendSSE(res, makeChunk('', agentModel, { type: 'turn_error', kind: cls.kind === 'ok' || cls.kind === 'error' ? 'crash' : cls.kind, transient: cls.transient, retryAfterMs: cls.retryAfterMs, message: String(err.message || 'error').slice(0, 300) })); }
      sendSSE(res, makeChunk('', agentModel, { type: 'session_interrupted', error: err.message, turns_completed: turnCount }));
      sendSSE(res, makeChunk(`\n\n⚠️ Codex turn failed: ${err.message.slice(0, 200)}`, agentModel));
    }
  } finally {
    clearInterval(heartbeatTimer);
    clearInterval(incrementalSaveTimer);
    clearInterval(progressTicker);
    if (activePump) {
      // The turn threw mid-round: whatever the pump held goes back to the queue, then to the stash below.
      if (codexSteerChannels.get(agentName) === activePump) codexSteerChannels.delete(agentName);
      const held = activePump.undelivered();
      if (held.length > 0) requeueInterjections(agentName, held);
    }
    if (session) session.close();
    if (bridge) bridge.release();
    codexTurns.delete(agentName);
    activeResponses.delete(agentName);
    if (fullResponse.trim() && !ephemeral) appendConversationLog(agentName, 'assistant', fullResponse, lastSavedLength > 0);
    if (!ephemeral) for (const ij of steered) appendConversationLog(agentName, 'user', `[${ijLabel(ij)} (delivered mid-turn)]: ${ij.message}`);
    if (!ephemeral) for (const ij of delivered) appendConversationLog(agentName, 'user', `[${ijLabel(ij)} (delivered as a follow-up turn)]: ${ij.message}`);
    // Anything still queued (abort, error) goes with the agent's next message.
    const missed = drainInterjections(agentName);
    if (missed.length > 0) {
      if (!ephemeral) for (const ij of missed) appendConversationLog(agentName, 'user', `[${ijLabel(ij)} (not delivered in time - will be delivered with your next message)]: ${ij.message}`);
      try { sdkInterject.stashUndelivered(agentName, missed); sendSSE(res, makeChunk('', agentModel, { type: 'interjection_deferred', count: missed.length })); } catch (e) { console.error(`[interject] stash failed for ${agentName}:`, e.message); }
    }
    sendSSEDone(res);
    if (!res.writableEnded) res.end();
  }
}

// ── Queued consultations ────────────────────────────────────────────────
// Consulting a BUSY named agent: wait briefly (short turns just finish), otherwise the request is
// queued and run when the agent is free; see lib/consult-queue.js for why it is never injected
// into the agent's running turn. Workers, Tiger Teams and queued runs themselves are not queued.
const CONSULT_BUSY_WAIT_MS = Number(process.env.HUB_CONSULT_BUSY_WAIT_MS || 20000);
function isQueueableConsult(agentName, coordinatorName, opts) {
  return !!coordinatorName && !opts.temporal && !opts.tigerTeam && !opts.queuedRun
    && !temporalWorkers.isVirtual(agentName) && !temporalWorkers.isVirtual(coordinatorName);
}
async function consultViaHub(agentName, prompt, workerId, sseCtx, coordinatorName, opts = {}) {
  // Owner boundary first: a member's agents may only consult that member's agents (lib/access). Before anything
  // else, so a busy capacity agent is never replaced by a stand-in worker for a caller who may not use it (review F16).
  if (!opts.temporal && !(await consultAllowed(coordinatorName, agentName))) {
    return `[NO ACCESS] "${agentName}" is not one of the agents available to you. Use list_agents to see who you can consult, or ask the owner.`;
  }
  if (isQueueableConsult(agentName, coordinatorName, opts)) {
    const stored = consultQueue.getConsultQueue().takeAnswer(coordinatorName, agentName, prompt);
    if (stored) return `[REPLY TO YOUR QUEUED REQUEST - "${agentName}" ran it after it became free (${stored.status})]\n\n${stored.result}`;
    // Capacity agents (category "worker") have no identity worth waiting for: a busy one is
    // replaced at once by a temporary worker on the same model. Identity agents keep the wait+queue.
    if (isAgentActive(agentName) && await isCapacityAgent(agentName)) return standInFor(agentName, prompt, sseCtx, coordinatorName, opts);
    const until = Date.now() + CONSULT_BUSY_WAIT_MS;
    while (isAgentActive(agentName) && Date.now() < until && !(opts.signal && opts.signal.aborted)) await new Promise(r => setTimeout(r, 1000));
  }
  // Tiger Team runs have their own journaled recovery; temporal workers are paced by runWorkers.
  if (opts.tigerTeam || opts.temporal) return consultViaHubNow(agentName, prompt, workerId, sseCtx, coordinatorName, opts);
  let provider = 'default';
  try { provider = temporalWorkers.providerOf(await getAgentModel(agentName)); } catch {}
  return pacing.run(provider, () => consultViaHubNow(agentName, prompt, workerId, sseCtx, coordinatorName, opts), { label: agentName });
}

// ── Capacity agents: stand-in instead of busy ──────────────────────────
// Agents tagged category "worker" (worker, haiku, gemini, open, challenger, qwen36...) are capacity,
// not identity: nothing in their memory is needed for the request. When one is busy the hub runs the
// request on a temporary worker with the SAME model and full tools, so the caller never sees
// "[AGENT BUSY]" for them and nothing waits in the queue. The temporary worker is ephemeral: it
// carries no memory, no skills and no conversation of the named agent, and the reply says so.
async function isCapacityAgent(agentName) {
  try { return (await getAgents()).some(a => a.name === agentName && a.category === 'worker'); } catch { return false; }
}
/** list_agents text: name, model, category, live busy state and queue depth, so callers can route around a busy agent. */
// ── Owner scoping ──────────────────────────────────────────────────────
// Infrastructure agents (no owner) and admin-owned agents form one pool; a member's agents see only
// that member's agents. Temporary workers follow their parent. (lib/access)
function adminIdSet() { try { return new Set(hubAuthMod.getAuth().admins().map(u => u.id)); } catch { return new Set(); } }
const resolveVirtualAgent = (name) => { try { return temporalWorkers.getVirtual(name); } catch { return null; } };
async function peerAgents(agentName) {
  const agents = await getAgents();
  const peers = access.peersOf(agentName, agents, { resolveVirtual: resolveVirtualAgent, adminIds: adminIdSet() });
  // A member's agents also see the outside agents an admin granted that member (users page, "May consult").
  const extra = new Set(await consultGrantsOf(agentName));
  if (!extra.size) return peers;
  const have = new Set(peers.map(a => a.name));
  return peers.concat(agents.filter(a => extra.has(a.name) && !have.has(a.name)));
}
async function consultGrantsOf(agentName) {
  try {
    const v = resolveVirtualAgent(agentName);
    const name = v && v.parent ? v.parent : agentName;
    const rec = (await getAgents()).find(a => a.name === name);
    if (!rec || !rec.owner || adminIdSet().has(String(rec.owner))) return [];
    return toolPolicy.consultGrantsFor(rec);
  } catch { return []; }
}
async function ownerOfAgent(agentName) {
  const v = resolveVirtualAgent(agentName);
  const name = v && v.parent ? v.parent : agentName;
  const a = (await getAgents()).find(x => x.name === name);
  return access.ownerOf(a);
}
/** The admin side shares one shared-memory pool (null); each member's agents share their own. */
async function sharedPoolOf(agentName) {
  const owner = await ownerOfAgent(agentName);
  return owner && !adminIdSet().has(owner) ? owner : null;
}
async function consultAllowed(coordinatorName, targetName) {
  if (!coordinatorName) return true;
  const tv = resolveVirtualAgent(targetName);
  const target = tv && tv.parent ? tv.parent : targetName;
  const agents = await getAgents();
  if (!agents.some(a => a.name === target)) return true;   // unknown names are handled downstream
  if (access.sameOwner(coordinatorName, target, agents, { resolveVirtual: resolveVirtualAgent, adminIds: adminIdSet() })) return true;
  return (await consultGrantsOf(coordinatorName)).includes(String(target).toLowerCase());   // granted by an admin
}

async function describeAgents(callerName = null) {
  const agents = callerName ? await peerAgents(callerName) : await getAgents();
  const q = consultQueue.getConsultQueue();
  const lines = agents.map(a => {
    const cat = a.category || 'specialist';
    const busy = isAgentActive(a.name);
    const queued = q.pendingFor(a.name).length;
    let line = `- ${a.name} (${a.model}) [${cat}]${a.display ? ` — ${a.display}` : ''}`;
    if (busy) line += cat === 'worker' ? ' — busy (a consult now runs on a temporary stand-in with the same model)' : ' — busy';
    if (queued) line += ` — ${queued} queued request${queued === 1 ? '' : 's'}`;
    return line;
  });
  lines.push('', 'Busy identity agents ([primary]/[specialist]) queue your consult and answer when free; busy [worker] agents are replaced by a stand-in at once.');
  return lines.join('\n');
}
function standInPrefix(target, model, ok) {
  return ok
    ? `[STAND-IN] "${target}" was busy, so a temporary worker on the same model (${model}, tools: full) ran this request instead. It has no memory of "${target}"'s earlier conversations or skills.\n\n`
    : `[STAND-IN FAILED] "${target}" was busy and the temporary worker on the same model (${model}) failed:\n\n`;
}
async function standInFor(target, prompt, sseCtx, coordinatorName, opts = {}) {
  let model = '';
  try { model = await getAgentModel(target); } catch {}
  if (!model) return `[AGENT BUSY] "${target}" is busy and its model could not be resolved for a stand-in. Try again in a minute.`;
  const job = { label: `stand-in for ${target}`, model, provider: temporalWorkers.providerOf(model), toolScope: 'full', task: prompt };
  console.log(`[consultViaHub] ${target} is busy - stand-in worker on ${model} for ${coordinatorName || 'caller'}`);
  const results = await temporalWorkers.runWorkers([job], {
    parent: coordinatorName || target, limiter: pacingLimiter,
    onStart: (j, v) => {
      if (sseCtx) sendSSE(sseCtx, makeChunk('', 'gateway', { type: 'worker_started', worker_id: v.id, agent_type: 'temporal', description: `Stand-in for ${target} · ${j.model}`, model: j.model, prompt: j.task }));
    },
    onDone: (r, v) => {
      console.log(`[consultViaHub] stand-in ${v.id} for ${target} ${r.ok ? 'done' : 'FAILED'} in ${r.secs.toFixed(1)}s`);
      if (sseCtx) sendSSE(sseCtx, makeChunk('', 'gateway', r.ok ? { type: 'worker_completed', worker_id: v.id } : { type: 'worker_failed', worker_id: v.id, error: r.text.slice(0, 300) }));
    },
    runOne: (j, v) => consultViaHub(v.id, j.task, v.id, sseCtx, coordinatorName, {
      temporal: true, signal: opts.signal,
      ...(opts.imageFiles && opts.imageFiles.length ? { imageFiles: opts.imageFiles } : {}),
      bodyExtra: { ephemeral: true, exclude_tools: temporalWorkers.gatewayExcludesFor('full') },
    }),
  });
  const r = results[0] || { ok: false, text: '(no result)' };
  return standInPrefix(target, model, r.ok) + r.text;
}

let _consultDrainTimer = null;
/** Run queued consultations for agents that are free. Called when a turn ends and by a slow sweep. */
function drainConsultQueue(delayMs = 1500) {
  if (_consultDrainTimer) return;
  _consultDrainTimer = setTimeout(async () => {
    _consultDrainTimer = null;
    if (hubHalt.getHubHalt().isHalted()) return;   // queued consults wait for resumeHub()
    try {
      const q = consultQueue.getConsultQueue();
      const names = new Set((await getAgents()).map(a => a.name));
      if (q.targets().length) await q.drain({
        isActive: isAgentActive,
        exists: async (name) => names.has(name),
        run: (job) => consultViaHubNow(job.to, consultQueue.queuedPromptNote(job) + job.prompt, null, null, job.from, { consultationDepth: job.depth, queuedRun: true }),
      });
    } catch (e) { console.error('[consult-queue] drain error:', e.message); }
    try { await deliverMailboxes(); } catch (e) { console.error('[consult-queue] delivery error:', e.message); }
  }, delayMs);
  if (_consultDrainTimer.unref) _consultDrainTimer.unref();
}

// ── Push delivery ───────────────────────────────────────────────────────
// A queued reply used to wait in the caller's mailbox until the owner's next message. Now, when the
// caller is idle, the hub starts a delivery turn for it: an owner-level turn whose only content is the
// note below; handleChatStreamReserved prepends the mailbox exactly as it does for any owner turn, so
// the replies still arrive labelled as agent replies (information), never as the owner's words.
// A busy caller is left alone (delivered at the start of its next turn, as before).
const DELIVERY_NOTE = '[Delivery turn started by the hub: replies to consultations you queued earlier (or hub notices) arrived while you were idle. There is no new message from the owner. Act on them if your earlier task needs it; if the result was for another agent that asked you, pass it on with consult_agent; otherwise reply in one or two lines.]';
const DELIVERY_COOLDOWN_MS = Number(process.env.HUB_DELIVERY_COOLDOWN_MS || 60000);
const _lastDelivery = new Map();   // caller -> last delivery-turn start (ms)
async function deliverMailboxes() {
  const q = consultQueue.getConsultQueue();
  const owners = q.mailboxOwners();
  if (!owners.length) return 0;
  const names = new Set((await getAgents()).map(a => a.name));
  let started = 0;
  for (const owner of owners) {
    if (!names.has(owner) || temporalWorkers.isVirtual(owner) || isAgentActive(owner)) continue;
    const last = _lastDelivery.get(owner) || 0;
    if (Date.now() - last < DELIVERY_COOLDOWN_MS) continue;
    _lastDelivery.set(owner, Date.now());
    console.log(`[consult-queue] ${owner} is idle with ${q.mailboxCount(owner)} waiting repl${q.mailboxCount(owner) === 1 ? 'y' : 'ies'} - starting a delivery turn`);
    started++;
    // Not awaited: the turn runs like any hub-initiated turn; the mailbox stays intact if the hub refuses it.
    wakeAgent(owner, DELIVERY_NOTE, null, { kind: 'consult_reply', from: 'hub' })
      .catch(e => console.error(`[consult-queue] delivery turn for ${owner} not started: ${e.message}`));
  }
  return started;
}
const _consultSweep = setInterval(() => drainConsultQueue(0), 30000); _consultSweep.unref();   // also picks up requests that survived a restart
if (_consultSweep.unref) _consultSweep.unref();

// ── Request Handlers ────────────────────────────────────────────────────
// Reserve HTTP turns before asynchronous model/tool setup can expose a race.
const pendingChatRequests = new Set();
async function handleChatStream(body, res) {
  const agent = body?.agent;
  // Kill switch: while halted no new turn starts (HTTP routes, scheduled tasks, job notices, consults...). Only the owner's explicit override passes.
  if (hubHalt.getHubHalt().isHalted() && body?.override !== true) {
    const st = hubHalt.getHubHalt().status();
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'hub halted', reason: st.reason || null, at: st.at || null }));
    return;
  }
  if (agent && isAgentActive(agent)) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Agent is busy; use interject or wait for the current turn.' }));
    return;
  }
  if (agent) pendingChatRequests.add(agent);
  try {
    return await handleChatStreamReserved(body, res);
  } finally {
    pendingChatRequests.delete(agent);
    drainConsultQueue();   // this agent may now be free for consultations that were queued while it was busy
  }
}

async function handleChatStreamReserved(body, res) {
  const { agent, images, image_files, ephemeral, confirm_tools, consultation_depth, exclude_tools, tiger_team, consulted_by, origin } = body;
  // A pasted screenshot with no words is a valid message: the picture is the message.
  const hasAttachment = (Array.isArray(images) && images.length > 0) || (Array.isArray(image_files) && image_files.length > 0);
  const message = typeof body.message === 'string' && body.message.trim() ? body.message : (hasAttachment ? '(see the attached image)' : '');

  if (!agent || !message) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: !agent ? 'Missing agent' : 'Type a message or attach an image' }));
    return;
  }

  // An agent that does not exist is an error. It used to run on a default model under that name, which hid
  // a lost agent record (the agent seemed to answer, on a model nobody chose).
  if (!testStreamer && !temporalWorkers.isVirtual(agent) && !(await getAgents()).some(a => a.name === agent) && !(await getAgents(true)).some(a => a.name === agent)) {
    console.warn(`[chat] refused: no agent named "${String(agent).slice(0, 60)}"`);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `No agent named "${String(agent).slice(0, 60)}". It may have been deleted or renamed.` }));
    return;
  }

  console.log(`[chat] ${agent}: "${message.slice(0, 80)}"${images?.length ? ` (${images.length} images)` : ''}${exclude_tools?.length ? ` (excluding: ${exclude_tools.join(',')})` : ''}`);

  // Save uploaded images to disk and get file paths
  const imagePaths = [];
  if (images && images.length > 0) {
    for (const imgData of images) {
      const p = saveUploadedImage(imgData);
      if (p) imagePaths.push(p);
    }
  }
  // Files named by a consulting agent (consult_agent images): already on disk, re-validated here, never data URLs.
  if (image_files !== undefined && image_files !== null) {
    const r = consultImages.resolveImages(image_files, { allowData: false, label: 'image_files' });
    if (r.error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: r.error }));
      return;
    }
    for (const p of r.paths) if (!imagePaths.includes(p)) imagePaths.push(p);
  }

  // Prepend image refs to message so it's visible in conversation context
  let finalMessage = message;
  if (imagePaths.length > 0) {
    const refs = imagePaths.map(p => `[Image: ${p}]`).join('\n');
    finalMessage = `${refs}\n\n${message}`;
  }

  // Replies to consultations this agent queued earlier are delivered on its next OWNER turn,
  // labelled as replies from agents (information), never as the owner's words.
  if (!ephemeral && !consultation_depth && !tiger_team) {
    const replies = consultQueue.getConsultQueue().takeMailbox(agent);
    if (origin?.kind === 'consult_reply' && !replies.length) {
      // Delivery turn that lost a race (the owner's own turn already took the mailbox): nothing to
      // deliver, so end without running the model and without logging anything.
      console.log(`[consult-queue] delivery turn for ${agent}: mailbox already empty, skipped`);
      if (typeof res.writeHead === 'function') res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      try { res.write('data: [DONE]\n\n'); } catch {}
      try { res.end(); } catch {}
      return;
    }
    if (replies.length) {
      finalMessage = consultQueue.formatMailbox(replies) + finalMessage;
      for (const r of replies) appendConversationLog(agent, 'user', `[Queued consultation reply from agent "${r.to}" (${r.status})]: ${r.result}`);
      console.log(`[consult-queue] delivered ${replies.length} queued repl${replies.length === 1 ? 'y' : 'ies'} to ${agent}`);
    }
  }

  // Log user message
  if (!ephemeral) {
    // Load the on-disk history into memory BEFORE this prompt is written to it. The loader treats a
    // trailing user line as a reply the last restart killed and appends a "do not re-answer" placeholder;
    // on an agent's first gateway turn after a restart that would hit this very prompt (and the model
    // would then see the prompt twice). A cached conversation makes this a no-op.
    getConversation(agent);
    // Hub-started turns keep their origin so a reloaded chat can still show who started them and when.
    const logOrigin = (origin && typeof origin === 'object' && origin.kind) ? { origin: logOriginOf(origin) } : undefined;
    appendConversationLog(agent, 'user', message, false, (tiger_team || logOrigin) ? { ...(tiger_team ? { tiger_team: true } : {}), ...logOrigin } : undefined);
  }

  // Every non-ephemeral turn is broadcast on /api/events and tracked in turnRegistry (live status, Stop).
  // The turn's origin is the hub's own (consultation, job, schedule...) or, with none, the owner at a browser.
  const turnOrigin = (origin && typeof origin === 'object' && origin.kind) ? origin
    : consulted_by ? { kind: 'consultation', from: consulted_by } : { kind: 'user' };
  const abortController = new AbortController();
  let turnTrack = null;
  let tap = null;
  let transcriptTap = null;
  if (ephemeral) ephemeralTurns.add(abortController);
  if (!ephemeral) {
    const startedAt = new Date().toISOString();
    const turnId = `${agent}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    turnTrack = { turnId, origin: turnOrigin, startedAt, detached: false, abortController };
    turnRegistry.set(agent, turnTrack);
    if (!tiger_team) tap = hubEvents.events.tapTurn(res, { agent, origin: turnOrigin, message, turnId, startedAt });
    // Transcript archive: the user message now, the reply and every tool call/result as they stream.
    if (!tiger_team) {
      try {
        const originKind = turnOrigin && turnOrigin.kind ? String(turnOrigin.kind) : 'user';
        const ownerId = await ownerOfAgent(agent).catch(() => null);
        transcript.record({ agent, kind: 'user', text: message, turnId, origin: originKind, owner: ownerId });
        transcriptTap = transcript.tap(res, { agent, turnId, origin: originKind, owner: ownerId });
      } catch (e) { try { console.error(`[transcript] ${agent}: tap failed: ${e.message}`); } catch {} }
    }
  }
  let turnError = null;
  try {

  // The turn runs until it completes or POST /api/chat/stop aborts it (no server-side timeout).
  // A browser disconnect only DETACHES it: the turn keeps running and logging; its output goes to /api/events and push.
  if (typeof res.on === 'function') {
    res.on('close', () => {
      if (res.writableEnded || !turnTrack || turnRegistry.get(agent) !== turnTrack) return;
      turnTrack.detached = true;
      console.log(`[chat] ${agent}: client disconnected - turn continues detached`);
    });
  }

  if (testStreamer) { await testStreamer({ agent, res, signal: abortController.signal, message, imagePaths, finalMessage }); return; }

  // Route to SDK or gateway based on agent's model
  const agentModel = await getAgentModel(agent);

  // Tiger Team calls go through gateway for tool coordination.
  // Regular consultations can stay in SDK if the target is an SDK model — the MCP
  // bridge now provides consult_agent, list_agents, and memory tools to SDK agents.
  const forceGateway = !!tiger_team;

  if (codexCli.isCodexCliModel(agentModel)) {
    // The gateway cannot call a subscription model, so Tiger Team turns run through Codex too (without TT coordination tools).
    if (forceGateway) console.log(`[chat] ${agent}: codex-cli model cannot use gateway Tiger Team tools; running through Codex`);
    console.log(`[chat] ${agent}: routing to Codex CLI (${agentModel})${imagePaths.length ? ` (${imagePaths.length} images)` : ''}`);
    await streamViaCodex(agent, finalMessage, imagePaths, res, {
      origin: turnOrigin,
      ephemeral: !!ephemeral,
      signal: abortController.signal,
      consultationDepth: consultation_depth || 0,
      consultedBy: consulted_by || null,
      excludeTools: exclude_tools || [],
    });
  } else if (isClaudeSdkModel(agentModel) && !forceGateway) {
    // Auto-model for SDK agents
    let sdkModelOverride = null;
    const autoModelOn = await isAutoModel(agent);
    if (!autoModelOn) {
      // Classifier shadow mode: a logged, tallied, never-applied verdict for agents not on Auto model; not awaited.
      try {
        if (require('./classifier').getClassifier().shadowAll()) {
          const { selectModelAndTools } = require('./auto-model');
          getAgents().then(list => selectModelAndTools(message, { hasImages: imagePaths.length > 0, sdk: true, agent: list.find(a => a.name === agent) || { name: agent, model: agentModel } }))
            .catch(e => console.log('[auto-model] shadow verdict failed:', e.message));
        }
      } catch {}
    }
    let autoPicked = null;   // the classifier's verdict for this turn, shown at the top of the reply (streamViaSdk)
    if (autoModelOn) {
      try {
        const { selectModelAndTools } = require('./auto-model');
        const picked = await selectModelAndTools(message, {
          hasImages: imagePaths.length > 0,
          signal: abortController.signal,
          sdk: true,
          agent: (await getAgents()).find(a => a.name === agent) || { name: agent, model: agentModel },
        });
        if (picked && picked.category) autoPicked = picked;
        if (picked?.model) {
          console.log(`[auto-model] ${agent}: "${picked.category}" → ${picked.model} (SDK)`);
          sdkModelOverride = picked.model;
        }
      } catch (e) {
        console.error('[auto-model] SDK selection error, using default:', e.message);
      }
    }
    // Plan limits: a family at its weekly limit runs this turn on the owner's substitute (lib/plan-usage). Per turn only:
    // the agent's configured model stays, and the next turn after the window resets is back on it.
    let planFallback = null; let planWarning = null;
    try {
      const agentRec = (await getAgents()).find(a => a.name === agent) || {};
      planFallback = planUsage.getPlanUsage().fallbackFor(sdkModelOverride || agentModel, agentRec);
      if (planFallback) {
        sdkModelOverride = planFallback.model;
        const first = planUsage.getPlanUsage().announce(agent, planFallback);
        console.warn(`[plan-usage] ${agent}: ${planFallback.from} -> ${planFallback.model} for this turn (${planFallback.reason}${planFallback.resetsAt ? `, resets ${planFallback.resetsAt}` : ''})${first ? '' : ' [again]'}`);
      } else if (!ephemeral && !(Number(consultation_depth) > 0) && !String(agent).startsWith('tw-')) {
        // A weekly window past a warning level: one line in this agent's reply, once per level (the owner picks models).
        planWarning = planUsage.getPlanUsage().warningFor(sdkModelOverride || agentModel, agent);
      }
    } catch (e) { console.error('[plan-usage] fallback check failed:', e.message); }
    console.log(`[chat] ${agent}: routing to Claude SDK (${sdkModelOverride || agentModel})${imagePaths.length ? ` (${imagePaths.length} images)` : ''}`);
    await streamViaSdk(agent, finalMessage, imagePaths, res, {
      origin: turnOrigin,
      ephemeral: !!ephemeral,
      signal: abortController.signal,
      modelOverride: sdkModelOverride,
      planFallback,
      planWarning,
      autoPicked,
      consultationDepth: consultation_depth || 0,
      consultedBy: consulted_by || null,
      excludeTools: exclude_tools || [],
    });
  } else {
    if (forceGateway && isClaudeSdkModel(agentModel)) {
      console.log(`[chat] ${agent}: SDK model forced to gateway for tiger_team/consultation support`);
    }
    await streamViaGateway(agent, finalMessage, imagePaths, res, {
      origin: turnOrigin,
      ephemeral: !!ephemeral,
      signal: abortController.signal,
      confirmTools: !!confirm_tools,
      consultationDepth: consultation_depth || 0,
      excludeTools: exclude_tools || [],
      tigerTeam: !!tiger_team,
      consultedBy: consulted_by || null,
    });
  }
  } catch (e) { turnError = e; throw e; }
  finally {
    const stopped = abortController.signal.aborted;
    ephemeralTurns.delete(abortController);
    if (turnTrack && turnRegistry.get(agent) === turnTrack) turnRegistry.delete(agent);
    if (tap) { try { tap.finish(!turnError && !stopped, turnError ? turnError.message : stopped ? 'stopped' : null); } catch (e) { console.error(`[chat] ${agent}: turn_end publish failed: ${e.message}`); } }
    if (transcriptTap) { try { transcriptTap.finish(!turnError && !stopped, turnError ? turnError.message : stopped ? 'stopped' : null); } catch (e) { try { console.error(`[transcript] ${agent}: finish failed: ${e.message}`); } catch {} } }
  }
}

async function handleChat(body, res) {
  // Non-streaming: collect SSE chunks and return JSON.
  // A non-2xx from the stream handler (409 agent busy, 4xx validation) is passed
  // through as-is: callers must never mistake a refused turn for an empty reply.
  const chunks = [];
  let status = 200;
  let rawEnd = '';
  const fakeRes = {
    writableEnded: false,
    destroyed: false,
    writeHead(code) { if (typeof code === 'number') status = code; },
    write(data) { if (typeof data === 'string' && data.startsWith('data: ')) { const json = data.slice(6).trim(); if (json !== '[DONE]') { try { const parsed = JSON.parse(json); const content = parsed.choices?.[0]?.delta?.content; if (content) chunks.push(content); } catch {} } } },
    end(data) { this.writableEnded = true; if (typeof data === 'string') rawEnd = data; },
  };
  await handleChatStream(body, fakeRes);
  if (status < 200 || status >= 300) {
    let upstream = null;
    try { upstream = JSON.parse(rawEnd); } catch { upstream = rawEnd ? { error: rawEnd } : null; }
    const payload = status === 409
      ? { error: 'agent busy', detail: upstream?.error || null, agent: body?.agent || null }
      : (upstream && typeof upstream === 'object' ? upstream : { error: `hub refused the turn (${status})` });
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }
  const text = chunks.join('');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ response: text }));
}

function askAnswerText(answers) {
  const v = (answers && typeof answers === 'object' && !Array.isArray(answers)) ? Object.values(answers)[0] : answers;
  if (Array.isArray(v)) return v.map(String).join(', ').trim();
  return v == null ? '' : String(v).trim();
}

// The ask_user tool: one question on the user's live stream, wait for POST /api/ask_response.
async function runAskUser(agentName, sseRes, args, { consultationDepth = 0, signal = null, timeoutMs = ASK_USER_TIMEOUT_MS } = {}) {
  // A destroyed response is still "live" here: a detached turn (browser gone) can ask, and the owner
  // answers from /api/events or push via POST /api/ask_response.  Only a finished response has no one to ask.
  const live = sseRes && typeof sseRes.on === 'function' && !sseRes.writableEnded;
  if (consultationDepth >= 1 || !live) return ASK_USER_UNAVAILABLE;
  const question = String(args?.question || '').trim();
  if (!question) return 'ask_user needs a non-empty question.';
  if (signal?.aborted) return 'NO_ANSWER';

  const allowSkip = args.allow_skip !== false;
  const header = args.header ? String(args.header).slice(0, 30) : undefined;
  const options = (Array.isArray(args.options) ? args.options : [])
    .map(o => String(o).trim().slice(0, 120)).filter(o => o && o.toLowerCase() !== 'skip').slice(0, 6);
  const requestId = crypto.randomUUID();

  const answered = new Promise((resolve, reject) => {
    pendingQuestions.set(requestId, { resolve, reject });
    questionAgents.set(requestId, agentName);
  });
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs); });
  let onAbort;
  const aborted = new Promise(resolve => {
    if (!signal) return;
    onAbort = () => resolve({ timedOut: true });
    signal.addEventListener('abort', onAbort, { once: true });
  });

  const event = {
    type: 'ask_user_question',
    request_id: requestId,
    questions: [{
      ...(header ? { header } : {}),
      question,
      options: [...options.map(label => ({ label })), ...(allowSkip ? [{ label: 'Skip', description: 'Leave this for later' }] : [])],
    }],
  };
  appendConversationLog(agentName, 'assistant', '❓ ' + question + (options.length ? ' [' + options.join(' / ') + ']' : ''), false, { ask: true });
  sendSSE(sseRes, makeChunk('', 'agent-hub', event));
  // Also on the hub event stream, in full, and remembered per agent: a page whose chat stream has dropped (phone in the
  // background, reload, sleep) shows the question from the event or from GET /api/agents/:name/turn on catch-up.
  try { hubEvents.events.setQuestion(agentName, { request_id: requestId, questions: event.questions }); } catch {}
  hubEvents.events.publish('ask_user', { agent: agentName, request_id: requestId, question, options: event.questions[0].options.map(o => o.label), questions: event.questions });

  let result;
  try {
    const got = await Promise.race([answered, timeout, aborted]);
    if (got && got.timedOut) result = 'NO_ANSWER';
    else {
      const text = askAnswerText(got);
      result = (!text || (allowSkip && text.toLowerCase() === 'skip')) ? 'SKIPPED' : text;
    }
  } catch {
    result = 'NO_ANSWER';
  } finally {
    clearTimeout(timer);
    pendingQuestions.delete(requestId);
    questionAgents.delete(requestId);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    try { hubEvents.events.setQuestion(agentName, null); } catch {}
    hubEvents.events.publish('ask_user_done', { agent: agentName, request_id: requestId, result: result === 'NO_ANSWER' ? 'no_answer' : result === 'SKIPPED' ? 'skipped' : 'answered' });
  }
  appendConversationLog(agentName, 'user', '↳ ' + (result === 'SKIPPED' ? '(skipped)' : result === 'NO_ANSWER' ? '(no answer)' : result), false, { ask: true });
  return result;
}

function handleAskResponse(body) {
  const { request_id, answers } = body;
  if (!request_id || !answers) return { success: false, error: 'Missing request_id or answers' };

  const pending = pendingQuestions.get(request_id);
  if (!pending) return { success: false, error: 'No pending question' };

  pending.resolve(answers);
  return { success: true };
}

// ── Interjection (operator injects a message into a running turn) ────────

function handleInterjection(body) {
  const { agent, message } = body;
  if (!agent || !message) return { success: false, error: 'Missing agent or message' };

  // Check the agent is actually active
  if (!activeResponses.has(agent)) {
    return { success: false, error: `Agent "${agent}" is not currently processing a request` };
  }

  const q = queueInterjection(agent, { message, ts: new Date().toISOString() });
  return { success: true, queued: q.queued, transport: q.transport };
}

/** Queue an interjection item for a running agent and wake its live SDK channel, if any. */
function queueInterjection(agent, item) {
  if (!interjectionQueues.has(agent)) interjectionQueues.set(agent, []);
  interjectionQueues.get(agent).push(item);
  console.log(`[interject] Queued ${ijLabel(item).toLowerCase()} for ${agent}: "${item.message.slice(0, 80)}"`);
  const queued = interjectionQueues.get(agent).length;
  const liveSdkChannel = sdkInterjectChannels.get(agent);
  if (liveSdkChannel) liveSdkChannel.notify();
  const steerChannel = codexSteerChannels.get(agent);
  if (steerChannel) steerChannel.notify();
  const transport = liveSdkChannel ? 'sdk-live' : steerChannel ? 'codex-steer' : codexTurns.has(agent) ? 'codex-followup' : 'gateway-loop';
  return { queued, transport };
}

/** Put items back at the front of an agent's queue (steers Codex refused or never confirmed). */
function requeueInterjections(agent, items) {
  if (!items || items.length === 0) return;
  if (!interjectionQueues.has(agent)) interjectionQueues.set(agent, []);
  interjectionQueues.get(agent).unshift(...sdkInterject.emergencyFirst(items));
  console.log(`[interject] ${items.length} interjection(s) for ${agent} not taken mid-turn; requeued for a follow-up turn`);
}

function ijLabel(ij) { return sdkInterject.isEmergency(ij) ? 'EMERGENCY INTERJECTION' : 'OPERATOR INTERJECTION'; }

// Drain all pending interjections for an agent (called inside the tool loop)
function drainInterjections(agentName) {
  const queue = interjectionQueues.get(agentName);
  if (!queue || queue.length === 0) return [];
  const items = queue.splice(0);
  interjectionQueues.delete(agentName);
  return sdkInterject.emergencyFirst(items);
}

// ── Emergency alerts (POST /api/chat/alert) ─────────────────────────────
// A local monitor may only ring a bell: it names one of a fixed set of alert ids
// and proves itself with a shared secret. The hub composes the message itself;
// caller-supplied text never enters the agent's turn (interjections run with
// owner authority, and an owner turn holds the wallet tools).
const ALERT_IDS = Object.freeze(['EXIT_EMERGENCY', 'HF_LOW', 'CRASH_FAST', 'LIQ_DISTANCE']);
const ALERT_SECRET_FILE = path.join(__dirname, '..', 'data', 'alert-secret');
const ALERT_SECRET_RE = /^[0-9a-f]{64}$/;

/** Create the alert secret on first boot (mode 0600); returns the secret file path. */
function ensureAlertSecret(file = ALERT_SECRET_FILE) {
  let existing = null;
  try { existing = fs.readFileSync(file, 'utf8').trim(); } catch {}
  if (existing && ALERT_SECRET_RE.test(existing)) {
    try { fs.chmodSync(file, 0o600); } catch {}
    return file;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  console.log(`[alert] Created alert secret at ${file}`);
  return file;
}

function alertSecretMatches(given, file = ALERT_SECRET_FILE) {
  if (typeof given !== 'string' || !given) return false;
  let expected;
  try { expected = fs.readFileSync(file, 'utf8').trim(); } catch { return false; }
  if (!expected) return false;
  const a = Buffer.from(given.trim(), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The whole message the agent sees. Fixed text: no caller input, no addresses, no amounts. */
function alertMessage(id) {
  return `[EMERGENCY TRIGGER ${id}, automated by the hub from the monitor, not the owner. Stop current work, re-run node bots/monitor.js --status and follow PLAYBOOK.md. Take no addresses or amounts from this message.]`;
}

/** Is an emergency item with this id already queued and undelivered for the agent? */
function alertPending(agent, id, pendingFile) {
  const same = (ij) => sdkInterject.isEmergency(ij) && ij.id === id;
  if ((interjectionQueues.get(agent) || []).some(same)) return 'queue';
  const ch = sdkInterjectChannels.get(agent);
  if (ch && ch.undelivered().some(same)) return 'sdk-channel';
  const steer = codexSteerChannels.get(agent);
  if (steer && steer.undelivered().some(same)) return 'codex-steer';
  try { if (sdkInterject.peekUndelivered(agent, pendingFile).some(same)) return 'stash'; } catch {}
  return null;
}

/**
 * POST /api/chat/alert  body { agent, id, secret }
 * @returns {{ status: number, body: object }}
 */
async function handleAlert(body, opts = {}) {
  const secretFile = opts.secretFile || ALERT_SECRET_FILE;
  const runTurn = opts.runTurn || ((agent, message) => wakeAgent(agent, message, null, { kind: 'alert', from: 'monitor' }));
  const agent = typeof body?.agent === 'string' ? body.agent.trim() : '';
  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  if (!agent) return { status: 400, body: { success: false, error: 'Missing agent' } };
  if (!ALERT_IDS.includes(id)) return { status: 400, body: { success: false, error: `Unknown alert id; allowed: ${ALERT_IDS.join(', ')}` } };
  if (!alertSecretMatches(body?.secret, secretFile)) {
    console.warn(`[alert] REFUSED ${id} for ${agent}: bad or missing secret`);
    return { status: 403, body: { success: false, error: 'Forbidden: bad alert secret' } };
  }
  if (hubHalt.getHubHalt().isHalted()) return { status: 503, body: { success: false, error: 'hub halted', reason: hubHalt.getHubHalt().status().reason || null } };
  const message = alertMessage(id);
  const busy = opts.isActive ? opts.isActive(agent) : isAgentActive(agent);

  const queueIt = () => {
    const where = alertPending(agent, id, opts.pendingFile);
    if (where) {
      console.log(`[alert] ${id} for ${agent} already pending (${where}); deduped`);
      return { status: 200, body: { success: true, path: 'deduped', deduped: true, queued: true, id, agent, pending: where } };
    }
    const q = queueInterjection(agent, { message, ts: new Date().toISOString(), priority: 'emergency', id });
    console.log(`[alert] ${id} for ${agent}: agent busy -> emergency interjection queued (${q.transport}, ${q.queued} queued)`);
    return { status: 202, body: { success: true, path: 'interjected', queued: true, id, agent, transport: q.transport, position: q.queued } };
  };

  if (busy) return queueIt();
  try {
    await runTurn(agent, message);
    console.log(`[alert] ${id} for ${agent}: agent idle -> started a new turn`);
    return { status: 200, body: { success: true, path: 'turn', queued: false, id, agent } };
  } catch (e) {
    // Lost the race: the agent went busy between the check and the turn start.
    console.warn(`[alert] ${id} for ${agent}: new turn refused (${e.message}); falling back to interjection`);
    return queueIt();
  }
}

// ── Exports ─────────────────────────────────────────────────────────────

module.exports = {
  activityForSave, paragraphAfterTool, metaForPiece,   // saved replies keep their tool calls (tests)
  getAgentRequests: () => agentRequests,
  getPacing: () => pacing,
  getApprovals: () => approvals,
  getLedger: () => ledger,
  getCompaction: () => compaction,
  getTranscript: () => transcript,
  getAllowances: () => allowances,
  getEffectivePolicy: async (name) => { const a = (await getAgents()).find(x => x.name === name); return a ? { agent: name, ...toolPolicy.policyFor(a, { isWalletAgent: (n) => { try { return walletTools.isWalletAgent(n); } catch { return false; } }, isMemberOwned: (ag) => !!(ag && ag.owner && !adminIdSet().has(String(ag.owner))) }), overrides: (a.policy && a.policy.overrides) || {}, extraRoots: (a.policy && a.policy.roots) || [] } : null; },
  getJobRunner,
  getScheduledTasks,
  appendConversationLog,
  handleChatStream,
  handleChat,
  handleAskResponse,
  __askUser: { runAskUser, buildHubMcpServer, pendingQuestions, questionAgents, ASK_USER_TIMEOUT_MS, ASK_USER_UNAVAILABLE, appendConversationLog, pendingToolConfirms },
  __turn: { sendSSE, makeChunk, turnRegistry, pendingToolConfirms, setTestStreamer: (fn) => { testStreamer = fn; } },
  __cache: { annotateForContext, stableTrim, stampLabel, CACHE_TRIM_STEP },
  handleInterjection,
  haltHub,
  resumeHub,
  handleAlert,
  ensureAlertSecret,
  ALERT_IDS,
  ALERT_SECRET_FILE,
  resolveToolConfirm,
  stopAgentTurn,
  getAgentStatuses,
  turnRegistry,
  isTurnDetached,
  cancelWorker,
  getActiveWorkers,
  isAgentActive,
  wakeAgent,
  loadConversationLog,
  buildHandsMcpServer, handsForTurn,
  clearConversationLog,
  clearConversation,
  flushActiveResponses,
  consultViaHub,
  runTigerTeam,
  runRoundtable,
  continueTigerTeam,
  resumeTigerTeam,
  getTigerTeamState,
  reconstituteTigerTeam,
  stopTigerTeam,
  listTigerTeams,
  updateTigerTeamParticipants,
  activeTigerTeams,
};

function isTurnDetached(agentName) {
  return !!turnRegistry.get(agentName)?.detached;
}

/** Abort an agent's running turn (the Stop button). Also denies any tool confirm it is waiting on. */
function stopAgentTurn(agent) {
  const t = turnRegistry.get(agent);
  if (!t) return { ok: false, error: 'not running' };
  console.log(`[chat] ${agent}: stop requested (turn ${t.turnId}${t.detached ? ', detached' : ''})`);
  for (const [id, p] of pendingToolConfirms) if (p.agent === agent) { pendingToolConfirms.delete(id); p.resolve(false); }
  try { approvals.cancelFor(agent); } catch {}
  t.abortController.abort();
  return { ok: true, stopped: true };
}

/**
 * Kill switch. Sets the persistent flag FIRST (so nothing new starts while we tear down), then aborts every running turn
 * (registered and ephemeral), tiger teams, pending tool confirms and detached jobs, then announces it on /api/events (push follows).
 */
function haltHub(reason, deps = {}) {
  const flag = hubHalt.getHubHalt().halt(reason);
  const stop = deps.stopAgentTurn || stopAgentTurn;
  const stoppedAgents = [];
  for (const agent of [...turnRegistry.keys()]) {
    try { if (stop(agent)?.ok !== false) stoppedAgents.push(agent); } catch (e) { console.error(`[halt] stop ${agent} failed: ${e.message}`); }
  }
  let stoppedWorkers = 0;
  for (const ac of [...ephemeralTurns]) { try { ac.abort(); stoppedWorkers++; } catch {} }
  try { (deps.stopTigerTeam || stopTigerTeam)(null, 'halt'); } catch (e) { console.error(`[halt] tiger teams: ${e.message}`); }
  for (const [id, p] of [...pendingToolConfirms]) { pendingToolConfirms.delete(id); try { p.resolve(false); } catch {} }
  let cancelledJobs = [];
  try { cancelledJobs = (deps.jobRunner || getJobRunner()).cancelAll() || []; } catch (e) { console.error(`[halt] jobs: ${e.message}`); }
  console.log(`[halt] hub halted${flag.reason ? ` (${flag.reason})` : ''}: ${stoppedAgents.length} turn(s), ${stoppedWorkers} worker(s), ${cancelledJobs.length} job(s) stopped`);
  if (!flag.already) hubEvents.events.publish('hub_halted', { at: flag.at, reason: flag.reason });
  return { halted: true, at: flag.at, reason: flag.reason, already: !!flag.already, stoppedAgents, stoppedWorkers, cancelledJobs };
}

function resumeHub() {
  const r = hubHalt.getHubHalt().resume();
  if (r.was) hubEvents.events.publish('hub_resumed', { at: new Date().toISOString() });
  console.log(`[halt] hub resumed${r.was ? '' : ' (was not halted)'}`);
  drainConsultQueue();
  return { halted: false, was: r.was };
}

/** Live per-agent picture { <name>: {busy, busySince, activity, pendingQuestion} }: every known agent (10 s cached list) plus any busy one. */
function getAgentStatuses() {
  const out = {};
  const asking = new Set(questionAgents.values());
  let known = [];
  try { known = require('./agents').getAgentsSync().map(a => a.name); } catch {}
  const pending = new Set([...known, ...turnRegistry.keys(), ...pendingChatRequests, ...activeResponses.keys(), ...asking]);
  for (const name of pending) {
    const t = turnRegistry.get(name);
    const busy = !!t || pendingChatRequests.has(name) || activeResponses.has(name);
    const startTs = activeResponses.get(name)?.startTs;
    out[name] = {
      busy,
      busySince: t ? t.startedAt : busy ? new Date(startTs || Date.now()).toISOString() : null,
      activity: t ? hubEvents.activityOf(t.origin) : busy ? 'working' : null,
      pendingQuestion: asking.has(name),
    };
  }
  return out;
}

hubEvents.events.setStatusProvider(() => getAgentStatuses());
hubEvents.events.setHaltProvider(() => hubHalt.getHubHalt().status());
hubEvents.events.setPacingProvider(() => pacing.status());
hubEvents.events.setApprovalsProvider(() => approvals.list());

/**
 * Check if an agent currently has an active response in progress.
 */
function isAgentActive(agentName) {
  return pendingChatRequests.has(agentName) || activeResponses.has(agentName);
}

// ── Detached jobs (run_job) ─────────────────────────────────────────────
// Wake an agent with a hub-generated message in a NEW, saved turn. Resolves as soon as the turn is
// accepted (the message is in the conversation), rejects if the agent is busy or the hub refused.
function wakeAgent(agentName, message, onReply, meta = null) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks = [];
    const sink = {
      writableEnded: false, destroyed: false,
      writeHead(code) { if (settled) return; settled = true; if (code >= 200 && code < 300) resolve(); else reject(new Error(`hub refused the wake-up turn (${code})`)); },
      write(data) {
        if (typeof data !== 'string' || !data.startsWith('data: ')) return;
        const json = data.slice(6).trim(); if (json === '[DONE]') return;
        try { const c = JSON.parse(json).choices?.[0]?.delta?.content; if (c) chunks.push(c); } catch {}
      },
      end() { this.writableEnded = true; if (!settled) { settled = true; resolve(); } },
      on() {}, once() {}, setHeader() {}, flushHeaders() {},
    };
    const origin = { kind: meta?.kind || 'job_notice', from: meta?.from || null, jobId: meta?.jobId || null, jobName: meta?.jobName || null, ...(meta?.taskId ? { taskId: meta.taskId } : {}) };
    handleChatStream({ agent: agentName, message, origin, exclude_tools: meta?.exclude_tools }, sink)
      .then(() => { console.log(`[${origin.kind === 'schedule' ? 'sched-tasks' : 'jobs'}] ${agentName} handled a ${origin.kind === 'schedule' ? 'scheduled task' : 'job notice'} (${chunks.join('').length} chars)`); if (onReply) onReply(chunks.join('')); })
      .catch(e => { console.error(`[jobs] wake-up turn for ${agentName} failed: ${e.message}`); if (!settled) { settled = true; reject(e); } else if (onReply) onReply(''); });
  });
}

function getScheduledTasks() {
  return scheduledTasks.getScheduledTasks({
    notify: wakeAgent,
    isAgentActive,
    agentExists: async (name) => (await getAgents()).some(a => a.name === name),
    isPrivileged: isLeadAgent,
    leadNames: leadAgentNames,
    haltRefusal: () => hubHalt.getHubHalt().refusal(),
  });
}

function getJobRunner() {
  return jobs.getJobRunner({
    haltRefusal: () => hubHalt.getHubHalt().refusal(),
    notify: wakeAgent,
    isAgentActive,
    agentExists: async (name) => (await getAgents()).some(a => a.name === name),
    defaultCwd: (owner) => getAgentWorkspace(owner),
    // A sandboxed agent's jobs run inside its container (temporary workers inside their parent's); refused when the
    // sandbox is unavailable rather than falling back to the host (review F05).
    boxFor: async (owner) => {
      const sb = sandboxLib.getSandbox();
      const all = await getAgents();
      let agent = all.find(a => a.name === owner) || null;
      if (!agent) { const v = temporalWorkers.getVirtual(owner); if (v && v.parent) agent = all.find(a => a.name === v.parent) || null; }
      if (!agent || !sb.isSandboxed(agent)) return null;
      if (!(await sb.available())) throw new Error('your sandbox is not available (Docker or the sandbox image is missing), so background jobs cannot run; ask the owner');
      const name = await sb.ensure(agent);
      return { name, mounts: sb.mountsFor(agent) };
    },
  });
}
