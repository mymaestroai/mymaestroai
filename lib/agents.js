'use strict';

/**
 * agents.js — Agent discovery, context loading, and CRUD
 *
 * Self-contained agent management using a local config file (data/agents.json).
 * Model routing is handled by gateway-client.js (multi-provider).
 */

const fs = require('fs');
const path = require('path');
const { listModels, chatCompletion } = require('./gateway-client');

// ── Paths ───────────────────────────────────────────────────────────────

const HUB_DIR = path.join(__dirname, '..');
const AGENTS_FILE = path.join(HUB_DIR, 'data', 'agents.json');
const AGENTS_EXAMPLE = path.join(HUB_DIR, 'data', 'agents.example.json');
const WORKSPACES_DIR = path.join(HUB_DIR, 'workspaces');
const WORKSPACE_TEMPLATES_DIR = path.join(HUB_DIR, 'templates', 'workspaces');
// Text fields shown in the pages (display name, icon, blurb): see validateDisplayName / validateIcon / cleanText.
const MARKUP_CHARS_RE = /[<>"'&`]/;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const DISPLAY_MAX = 40;
const BLURB_MAX = 200;
const ICON_MAX_UNITS = 8;

/**
 * Agent workspaces are USER DATA: personalities get edited, memory accumulates.
 * They are therefore not tracked in git and never touched by an update. The
 * defaults ship as templates; on startup any template workspace that does not
 * exist yet is created from its template. Existing files are NEVER overwritten,
 * so a customised IDENTITY/SOUL/USER.md survives every upgrade.
 * @returns {string[]} relative paths of files that were created
 */
function seedDefaultWorkspaces(templatesDir = WORKSPACE_TEMPLATES_DIR, workspacesDir = WORKSPACES_DIR) {
  const created = [];
  let agentsWithTemplates = [];
  try { agentsWithTemplates = fs.readdirSync(templatesDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
  catch { return created; }                        // no templates shipped: nothing to do
  for (const agent of agentsWithTemplates) {
    const src = path.join(templatesDir, agent), dst = path.join(workspacesDir, agent);
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src, { withFileTypes: true })) {
      if (!f.isFile()) continue;
      const target = path.join(dst, f.name);
      if (fs.existsSync(target)) continue;         // the user's copy always wins
      fs.copyFileSync(path.join(src, f.name), target);
      created.push(path.join(agent, f.name));
    }
  }
  return created;
}
const EDITABLE_FILES = ['SOUL.md', 'IDENTITY.md', 'MEMORY.md', 'TOOLS.md', 'USER.md', 'TASKS.md'];

// ── Agent Icons ─────────────────────────────────────────────────────────

// Auto-assign an icon based on agent name or model
function autoGenerateIcon(name, model = '') {
  const n = name.toLowerCase();
  const m = model.toLowerCase();

  // Known agent name mappings
  const nameIcons = {
    main: '🎯', opus: '🎯', primary: '🎯',
    open: '🟢', openai: '🟢',
    gemini: '♊', google: '♊',
    claude: '🟣', anthropic: '🟣',
    code: '💻', coder: '💻', dev: '💻', engineer: '💻',
    debug: '🔧', fix: '🔧',
    research: '🔬', researcher: '🔬', science: '🔬',
    writer: '✍️', write: '✍️', content: '✍️',
    security: '🛡️', guard: '🛡️', secure: '🛡️',
    data: '📊', analyst: '📊', analytics: '📊',
    creative: '🎨', art: '🎨', design: '🎨',
    math: '🧮', calc: '🧮',
    sage: '🦉', wise: '🦉', mentor: '🦉',
    fast: '⚡', quick: '⚡', speed: '⚡',
    test: '🧪', tester: '🧪', qa: '🧪',
    cos: '⚡', bolt: '⚡', chief: '⚡',
    plan: '📋', planner: '📋', manager: '📋',
    search: '🔍', find: '🔍',
    chat: '💬', talk: '💬',
    think: '🧠', reason: '🧠', brain: '🧠',
    nova: '⭐', star: '⭐',
    grok: '🤘',
  };

  // Check name matches
  for (const [key, icon] of Object.entries(nameIcons)) {
    if (n === key || n.startsWith(key) || n.endsWith(key)) return icon;
  }

  // Model-based fallbacks
  if (m.includes('claude') || m.includes('anthropic')) return '🟣';
  if (m.includes('gpt') || m.includes('openai') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) return '🟢';
  if (m.includes('gemini') || m.includes('google')) return '♊';
  if (m.includes('grok')) return '🤘';
  if (m.includes('nova')) return '⭐';
  if (m.includes('llama') || m.includes('meta')) return '🦙';
  if (m.includes('mistral')) return '🌀';

  // Default
  return '🤖';
}

// ── Agent Cache ─────────────────────────────────────────────────────────

let _agentsCache = null;
let _agentsCacheTime = 0;
const AGENT_CACHE_TTL = 10; // seconds

/** Shared-memory pool of an agent: null for infrastructure and admin-owned agents, the owner's id for a member's agents. */
function sharedPoolFor(agentName) {
  try {
    const a = loadAgentsFromDisk().find(x => x.name === agentName);
    const owner = a && a.owner ? String(a.owner) : null;
    if (!owner) return null;
    const admins = new Set(require('./auth').getAuth().admins().map(u => u.id));
    return admins.has(owner) ? null : owner;
  } catch { return null; }
}

function loadAgentsFromDisk() {
  if (fs.existsSync(AGENTS_FILE)) {
    // An existing but unreadable/corrupt file is NEVER overwritten with the defaults: that would wipe
    // every agent record. Keep the last good copy in memory and shout.
    try {
      const parsed = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('agents.json is not an array');
      _lastGoodAgents = parsed;
      return parsed;
    } catch (e) {
      console.error(`[agents] ${AGENTS_FILE} is unreadable (${e.message}); keeping the last good copy in memory, NOT rewriting the file. Fix the file by hand.`);
      if (_lastGoodAgents) return _lastGoodAgents;
      try { const bak = JSON.parse(fs.readFileSync(AGENTS_FILE + '.bak', 'utf8')); if (Array.isArray(bak)) return bak; } catch {}
      return [];
    }
  }
  {
    // First run: seed from the template, or fall back to a minimal default.
    let defaults;
    try {
      defaults = JSON.parse(fs.readFileSync(AGENTS_EXAMPLE, 'utf8'));
    } catch {
      defaults = [{ name: 'maestro', model: 'claude-sdk/default', display: 'Maestro', category: 'primary', lead: true }];
    }
    saveAgentsToDisk(defaults);
    return defaults;
  }
}

let _lastGoodAgents = null;
function saveAgentsToDisk(agents) {
  const dir = path.dirname(AGENTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Keep the previous good file as .bak and write atomically (temp + rename), so a crash mid-write
  // or a bad write never leaves agents.json half-written.
  try { if (fs.existsSync(AGENTS_FILE)) fs.copyFileSync(AGENTS_FILE, AGENTS_FILE + '.bak'); } catch {}
  const tmp = `${AGENTS_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(agents, null, 2), 'utf8');
  fs.renameSync(tmp, AGENTS_FILE);
  _lastGoodAgents = agents;
}

// ── Agent Discovery ─────────────────────────────────────────────────────

function getAgents(forceReload = false) {
  return Promise.resolve(getAgentsSync(forceReload));
}

// Same list as getAgents(), for callers that must decide synchronously (permission checks).
function getAgentsSync(forceReload = false) {
  const now = Date.now() / 1000;
  if (!forceReload && _agentsCache && (now - _agentsCacheTime) < AGENT_CACHE_TTL) {
    return _agentsCache;
  }

  const raw = loadAgentsFromDisk();
  const agents = raw.map(a => ({
    name: a.name,
    model: a.model || 'claude-sonnet-4-6',
    display: a.display || a.name.charAt(0).toUpperCase() + a.name.slice(1),
    icon: a.icon || autoGenerateIcon(a.name, a.model),
    type: a.type || 'normal',
    category: a.category || 'specialist',
    lead: a.lead === true,
    owner: a.owner ? String(a.owner) : null,   // user id of the owner; null = infrastructure (admins only)
    sharedWith: Array.isArray(a.sharedWith) ? a.sharedWith.map(String) : [],   // members an admin shared this agent with
    policy: a.policy && typeof a.policy === 'object' ? a.policy : undefined,   // hub-wide powers (schedule for others, manage their tasks); set in agent settings
    blurb: typeof a.blurb === 'string' ? a.blurb.slice(0, BLURB_MAX) : '',   // one-line 'what this agent does' (hover tooltip)
    workspace: getWorkspacePath(a.name),
    modelStatus: a.model ? 'ok' : 'no_model',
    // 'OPENAI_CYBER' when the model bypasses the LLM Gateway (direct OpenAI key)
    transport: require('./cyber-models').transportTag(a.model),
    noTools: !!a.noTools,
    minimalContext: !!a.minimalContext,
    toolWhitelist: a.toolWhitelist || null,
    // allowedSkills removed — all agents use lazy loading
    maxContextMessages: a.maxContextMessages || null,
    maxOutputTokens: a.maxOutputTokens || null,
    contextBudget: a.contextBudget || null,   // SDK agents: working context window in tokens (null = model's full window)
    autoModel: !!a.autoModel,
    autoModelAllowedModels: a.autoModelAllowedModels || null,
    fallbackModel: a.fallbackModel || null,   // plan-limit substitute: a model id, "none" to opt out, null = the hub's family map (lib/plan-usage)
    minModel: a.minModel || null,             // Auto model never routes below this model's family (lib/classifier)
    sandbox: a.sandbox || 'inherit',          // 'inherit' (settings.sandboxDefaults by owner kind) | 'off' | 'container' (lib/sandbox)
    effort: require('./effort').normalize(a.effort),   // reasoning effort: 'default' | low | medium | high | xhigh | max (lib/effort)
    tools: a.tools || 'inherit',              // Claude/Codex client agents: 'inherit' (settings.toolsDefault) | 'client' (the client's own built-ins) | 'hub' (lib/hub-tools)
    // Context management (lib/compaction, lib/context-budget, lib/records): per-agent overrides.
    compaction: a.compaction && typeof a.compaction === 'object' ? { ...a.compaction } : undefined,
    contextWindow: Number(a.contextWindow) >= 2048 ? Math.round(Number(a.contextWindow)) : null,
    recordsMaxBytes: Number(a.recordsMaxBytes) >= 4096 ? Math.round(Number(a.recordsMaxBytes)) : null,
  }));

  agents.sort((a, b) => a.name.localeCompare(b.name));
  _agentsCache = agents;
  _agentsCacheTime = now;
  return agents;
}

// ── Lead Agent ──────────────────────────────────────────────────────────
// Lead agents may schedule tasks for any agent, see/edit/cancel other agents' tasks, and are the
// default comms route. The owner marks them with `lead: true` in agent settings (one or several).
// Category is only sidebar grouping: 'primary' = the agents the owner talks to (team heads).
// Fallbacks for installs that never set the flag: the 'primary' agents; else 'maestro'.

const LEGACY_LEAD = 'maestro';

function leadAgentNames(agents = getAgentsSync()) {
  const flagged = agents.filter(a => a.lead === true).map(a => a.name);
  if (flagged.length) return flagged;
  // Installs that never set the flag: the admin-side primary agents. Never a member's own assistants, which are
  // 'primary' too (sidebar grouping) but must not gain lead privileges by default (review F31).
  const admins = adminIdSet();
  return agents.filter(a => a.category === 'primary' && (!a.owner || admins.has(String(a.owner)))).map(a => a.name);
}

function adminIdSet() {
  try { return new Set(require('./auth').getAuth().admins().map(u => String(u.id))); } catch { return new Set(); }
}

function isLeadAgent(name, agents) {
  if (!name) return false;
  const leads = leadAgentNames(agents);
  return leads.length ? leads.includes(name) : name === LEGACY_LEAD;
}

/** The one agent to default to (e.g. comms routing): maestro if it is a lead, else the first lead. */
function defaultLeadAgent(agents) {
  const leads = leadAgentNames(agents);
  return leads.includes(LEGACY_LEAD) ? LEGACY_LEAD : (leads[0] || LEGACY_LEAD);
}

/** Should maestro be marked as the lead? Only when no agent is marked at all, maestro is the owner's (no owner, or an
 *  admin's; never a member's), the owner hasn't set lead: false on it, and maestro already counts as a lead under the
 *  defaults for unmarked installs (an admin-side primary agent, or the legacy name when there is no such agent), so
 *  nothing gains rights it didn't have. New installs are seeded with the mark; this covers installs from before that. */
function shouldMarkMaestroLead(agents, adminIds) {
  if (!Array.isArray(agents) || agents.some(a => a && a.lead === true)) return false;
  const m = agents.find(a => a && typeof a === 'object' && a.name === LEGACY_LEAD);
  if (!m || m.lead === false) return false;
  if (m.owner && !adminIds.has(String(m.owner))) return false;
  const primaries = agents.filter(a => a && a.category === 'primary' && (!a.owner || adminIds.has(String(a.owner))));
  return primaries.length ? primaries.includes(m) : true;
}

const LEAD_CHECK_FILE = path.join(path.dirname(AGENTS_FILE), 'lead-check.json');
/** Startup, once per install: an install whose agents.json marks no lead gets maestro marked (shouldMarkMaestroLead).
 *  Until now such installs counted every admin-side primary agent as a lead. data/lead-check.json records that the
 *  check ran, so a later untick sticks. An unreadable or non-list agents.json is left alone and checked again next start. */
function ensureMaestroLead() {
  if (fs.existsSync(LEAD_CHECK_FILE)) return { changed: false, reason: 'already checked' };
  if (!fs.existsSync(AGENTS_FILE)) return { changed: false, reason: 'first run (the seed marks maestro)' };
  let raw, agents;
  try { raw = fs.readFileSync(AGENTS_FILE, 'utf8'); agents = JSON.parse(raw); } catch { return { changed: false, reason: 'agents.json unreadable' }; }
  if (!Array.isArray(agents)) return { changed: false, reason: 'agents.json is not a list' };
  let changed = false;
  if (shouldMarkMaestroLead(agents, adminIdSet())) {
    agents.find(a => a && typeof a === 'object' && a.name === LEGACY_LEAD).lead = true;
    // Write only if nothing changed the file since it was read (another process sharing this data folder, say).
    let current = null;
    try { current = fs.readFileSync(AGENTS_FILE, 'utf8'); } catch {}
    if (current !== raw) return { changed: false, reason: 'agents.json changed while checking' };
    saveAgentsToDisk(agents);
    _agentsCache = null;
    changed = true;
  }
  try {
    const tmp = `${LEAD_CHECK_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ checkedAt: new Date().toISOString(), changed }) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, LEAD_CHECK_FILE);
  } catch (e) { console.warn(`[agents] could not record the lead check (${e.message}); it runs again on the next start`); }
  return { changed };
}

function getWorkspacePath(agentName) {
  return path.join(WORKSPACES_DIR, agentName);
}

async function getAgentModel(agentName) {
  const virt = require('./temporal-workers').getVirtual(agentName);   // ephemeral worker: model chosen by the calling agent
  if (virt) return virt.model;
  const agents = await getAgents();
  const agent = agents.find(a => a.name === agentName);
  return agent?.model || 'claude-sonnet-4-6';
}

async function isAutoModel(agentName) {
  if (require('./temporal-workers').isVirtual(agentName)) return false;
  const agents = await getAgents();
  const agent = agents.find(a => a.name === agentName);
  return !!agent?.autoModel;
}

async function getAgentWorkspace(agentName) {
  const virt = require('./temporal-workers').getVirtual(agentName);
  if (virt) return getWorkspacePath(virt.parent || agentName);   // a worker has no workspace of its own
  return getWorkspacePath(agentName);
}

// ── Context Loading ─────────────────────────────────────────────────────

function readFileSection(filePath, label) {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8').trim();
      if (content) {
        return label ? `# ${label}\n${content}` : content;
      }
    }
  } catch {}
  return '';
}

// Channel context — tells the agent HOW they're being communicated with
const CHANNEL_CONTEXT = {
  hub: `## Communication Channel
You are chatting via **My Maestro AI** — a web-based chat interface running in the user's browser on their local desktop. The user sees formatted markdown, images, and interactive UI elements. This is NOT a terminal — but you DO have full tool access (bash, file ops, web search) since the hub runs on the same machine. The user may have multiple agent tabs open simultaneously.

**Markdown rendering**: The Hub renders GitHub-flavored markdown including **bold**, *italic*, \`code\`, code blocks, bullet lists, numbered lists, headers, and **tables**.

## Consulting Named Agents
You can consult any named agent by using the consult_agent tool. The system will route to the agent's configured model through the configured LLM provider and load its full personality context.`,

  api: `## Communication Channel
You are being accessed via the **OpenAI-compatible API** (/v1/chat/completions). Respond in plain text or markdown as appropriate.`,
};

/**
 * Build full system prompt from agent workspace files
 */
async function loadAgentContext(agentName, channel, opts = {}) {
  const virt = require('./temporal-workers').getVirtual(agentName);
  if (virt) return require('./temporal-workers').workerContext(virt);   // lean generic prompt, no personality/memory files
  const ws = await getAgentWorkspace(agentName);
  const sections = [];

  // Lightweight mode for tiny-context models (noTools agents) — only IDENTITY + SOUL
  // minimalContext mode for expensive models (Mythos) — IDENTITY + SOUL only, no memory/user/tools
  const lightweight = opts.lightweight || opts.minimalContext || false;
  const files = lightweight ? [
    ['IDENTITY.md', 'Identity'],
    ['SOUL.md', 'Soul'],
  ] : [
    ['IDENTITY.md', 'Identity'],
    ['SOUL.md', 'Soul'],
    ['USER.md', 'User Context'],
    ['TOOLS.md', 'Tools & Environment'],
  ];

  // Get actual running model for injection
  const actualModel = await getAgentModel(agentName);
  const autoModel = await isAutoModel(agentName);

  for (const [fname, label] of files) {
    let text = readFileSection(path.join(ws, fname), label);
    if (text && fname === 'IDENTITY.md') {
      // Inject actual running model from config (never hardcode in IDENTITY.md)
      const modelLine = autoModel ? `${actualModel} (with auto-model routing)` : actualModel;
      text += `\n\n## Model (runtime)\n${modelLine}\n`;
    }
    if (text) sections.push(text);
  }

  // Where the owner's Files panel (upload / download) points for this agent. Team agents keep their
  // existing folders (medical/, legal/); everyone else gets a folder of their own on the share.
  let filesRoot = null; let agentRec = null;
  if (!lightweight) {
    try {
      agentRec = (await getAgents()).find(a => a.name === agentName) || { name: agentName };
      filesRoot = require('./files').getFiles().rootForAgent(agentRec, { memberOwned: !!sharedPoolFor(agentName) });
      sections.push(`## Files folder\n${filesRoot}\nFiles the owner uploads through the hub's Files panel (or attaches with the paperclip) land here${/\/(medical|legal)$/.test(filesRoot) ? ' (uploads at the top level or in inbox/)' : ''}; anything you save here they can download from the same panel. Keep deliverables for the owner here.`);
    } catch (e) { /* no files folder line */ }
  }

  // Records: the agent's own documents, in full, every turn (lib/records). Plus an index of the Files
  // folder so nothing uploaded goes unnoticed. Then, if a message is known, the best transcript hits for
  // it: labelled as search hits, never as the record.
  if (!lightweight) {
    try {
      const records = require('./records');
      const idx = filesRoot ? records.filesIndex(filesRoot, { max: opts.compressionTurn ? 40 : 150 }) : null;
      // A budget (lib/context-budget, gateway models) can cap the Records below the agent's own cap.
      const recCap = Number(opts.recordsMaxBytes);
      const recAgent = recCap > 0 ? { ...(agentRec || {}), recordsMaxBytes: Math.min(recCap, records.maxBytesFor(agentName, { agentRecord: agentRec })) } : agentRec;
      const rs = records.contextSection(agentName, { agentRecord: recAgent, filesIndex: idx });
      if (rs) sections.push(rs);
    } catch (e) { console.error(`[records] ${agentName}:`, e.message); }
    // A fresh provider session (after an agent-authored compression, or a New Session): the most recent
    // turns verbatim from the archive, so the agent resumes mid-thought rather than from a blank page.
    if (opts.recentFromArchive && !opts.compressionTurn) {   // a compression turn gets Records and the hub's slice, nothing else
      try {
        const want = Number(opts.recentChars) > 0 ? Number(opts.recentChars) : 24000;
        const rows = require('./transcript').getTranscript().search(agentName, '', { kinds: ['user', 'assistant'], limit: Math.max(40, Math.min(300, Math.round(want / 600))) }).reverse();
        if (rows.length) {
          let budget = want; const lines = [];
          for (const r of rows.slice().reverse()) {   // newest first while budgeting, then restore order
            const body = String(r.text || '').trim().slice(0, 4000);
            if (budget - body.length < 0) break; budget -= body.length;
            lines.unshift(`[${String(r.ts).replace('T', ' ').slice(0, 16)}] ${r.kind === 'user' ? 'Owner' : 'You'}: ${body}`);
          }
          sections.push(`## Recent conversation (verbatim, from your transcript archive)\nYour previous provider session was closed after you wrote your working brief (see Records). These are the most recent turns, word for word; everything older is one recall away.\n\n${lines.join('\n\n')}`);
        }
      } catch (e) { /* no recent section */ }
    }
    if (opts.recallQuery && !opts.compressionTurn) {
      try {
        const hits = require('./transcript').getTranscript().search(agentName, String(opts.recallQuery).slice(0, 400), { limit: opts.hitsBudget ? 12 : 8 });
        if (hits.length) {
          let budget = Number(opts.hitsBudget) > 0 ? Number(opts.hitsBudget) : 6000; const lines = [];
          for (const h of hits) {
            const body = String(h.kind === 'assistant' || h.kind === 'user' ? h.text : h.snippet || h.text).trim().slice(0, 1200);
            if (budget - body.length < 0) break; budget -= body.length;
            lines.push(`#${h.id} ${String(h.ts).replace('T', ' ').slice(0, 16)} ${h.kind}${h.tool ? ` (${h.tool})` : ''}: ${body}`);
          }
          const hitsText = `## Possibly relevant earlier exchanges (search hits for this message, NOT the record)\nFrom your transcript archive. Use recall / recall_context for more; these are hits, not a complete picture.\n\n${lines.join('\n\n')}`;
          // hitsOut: the caller sends the hits with the current message instead (they change every message and
          // would break prompt caching of everything after them in the system prompt).
          if (opts.hitsOut && typeof opts.hitsOut === 'object') opts.hitsOut.text = hitsText; else sections.push(hitsText);
        }
      } catch (e) { /* no recall section */ }
    }
  }

  // CRITICAL: Inject authoritative model declaration at the END of context
  // This overrides any stale model info from earlier in the prompt
  const modelShort = actualModel.replace('claude-sdk/', '').replace('claude-', '');
  sections.push(`---

# AUTHORITATIVE MODEL INFO (trust this, not earlier references)
You are running as **${actualModel}** (${modelShort}). If any earlier context says a different model, IGNORE it — this is your actual runtime model.`);


  // Load memory from SQLite (long-term + session notes + shared pool)
  // Skip for minimalContext agents — saves significant tokens
  if (!opts.minimalContext) {
    try {
      const memoryDb = require('./memory-db');

      // Auto-migrate from file-based memory on first load
      memoryDb.migrateFromFiles(agentName, ws);

      // Get full memory context (long-term + 7 days session + the OWNER's shared pool only)
      const memContext = memoryDb.getMemoryContext(agentName, 32768, { sharedPool: sharedPoolFor(agentName) });
      if (memContext) sections.push(memContext);
    } catch (e) {
      // Fallback to file-based MEMORY.md if SQLite fails
      console.error(`[memory] SQLite error for ${agentName}, falling back to files:`, e.message);
      const text = readFileSection(path.join(ws, 'MEMORY.md'), 'Long-Term Memory');
      if (text) sections.push(text);
    }
  }

  // Channel context
  if (channel && CHANNEL_CONTEXT[channel]) {
    sections.push(CHANNEL_CONTEXT[channel]);
  }

  if (sections.length === 0) {
    return `You are ${agentName}, a helpful AI assistant.`;
  }

  return sections.join('\n\n---\n\n');
}

// ── Agent CRUD ──────────────────────────────────────────────────────────

async function createAgent(name, model, personality, skills, category, owner = null) {
  if (model == null) model = '';   // null is "pick the default", same as omitted
  if (!name || !/^[a-z][a-z0-9]*$/.test(name)) {
    return { success: false, error: 'Invalid name (lowercase letters and numbers, starts with letter)' };
  }
  const agents = loadAgentsFromDisk();
  if (agents.find(a => a.name === name)) {
    return { success: false, error: 'Agent already exists' };
  }

  const ws = getWorkspacePath(name);
  if (!fs.existsSync(ws)) fs.mkdirSync(ws, { recursive: true });

  const capName = name.charAt(0).toUpperCase() + name.slice(1);
  const chosenModel = model || 'claude-sonnet-4-6';

  // Generate rich personality files if personality description provided
  if (personality) {
    try {
      const files = await generatePersonalityFiles(name, capName, chosenModel, personality, skills);
      for (const [filename, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(ws, filename), content, 'utf8');
      }
    } catch (err) {
      console.error(`[agents] Personality generation failed for ${name}, using defaults:`, err.message);
      // Fall back to basic files
      fs.writeFileSync(path.join(ws, 'IDENTITY.md'), `# IDENTITY.md\n\n## Name\n${capName}\n\n## Role\n${personality}\n\n## Platform\nMy Maestro AI\n`, 'utf8');
      fs.writeFileSync(path.join(ws, 'SOUL.md'), `You are ${capName}. ${personality}\n`, 'utf8');
    }
  } else {
    fs.writeFileSync(path.join(ws, 'IDENTITY.md'), `# IDENTITY.md\n\n## Name\n${capName}\n\n## Role\nA helpful AI assistant.\n\n## Platform\nMy Maestro AI\n`, 'utf8');
    fs.writeFileSync(path.join(ws, 'SOUL.md'), `You are ${capName}, a helpful AI assistant.\n`, 'utf8');
  }

  // Re-read: the personality step above awaits a model call for seconds, and saving the list read before it
  // dropped any agent created or changed meanwhile (two agents created at once -> only one survived).
  const current = loadAgentsFromDisk();
  if (current.find(a => a.name === name)) return { success: false, error: 'Agent already exists' };
  current.push({
    name,
    model: chosenModel,
    display: capName,
    icon: autoGenerateIcon(name, model),
    type: 'normal',
    category: category || 'specialist',
    ...(owner ? { owner: String(owner) } : {}),   // user id; absent = infrastructure (admin-only)
  });
  saveAgentsToDisk(current);
  _agentsCache = null;
  return { success: true, name };
}

/**
 * Generate rich personality files for a new agent using LLM.
 * Uses claude-haiku for cost efficiency — this is a formatting/writing task.
 */
async function generatePersonalityFiles(name, displayName, model, personality, skills) {
  const prompt = `You are creating personality files for a new AI agent on the My Maestro AI platform.

AGENT DETAILS:
- Internal name: ${name}
- Display name: ${displayName}
- LLM model: ${model}
- User's personality description: ${personality}
${skills ? `- Specialty skills/knowledge: ${skills}` : ''}

USER CONTEXT:
- The user is a team member
- All work uses approved tooling
- The user prefers direct, action-oriented communication
- The user values agents that push back on bad ideas

Generate exactly 4 files as a JSON object. Each file should be rich, detailed, and production-ready.

CRITICAL RULES:
- Do NOT use any emoji characters in any file content. Use text descriptions instead.
- IDENTITY.md: Agent's name, role, icon (use a simple ASCII character or text label), and platform
- SOUL.md: Deep personality definition — communication style, values, anti-patterns, working style, delegation instructions (delegate searches/lookups/formatting to worker agent via consult_agent, save expensive compute for reasoning). Should be 80-150 lines.
- TOOLS.md: What tools/capabilities the agent has access to (all Hub tools: Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, memory tools, consult_agent, plus any configured MCP skills like Google Workspace, Slack, GitHub, Jira, Sequential Thinking). Include tool usage guidelines specific to this agent's role.
- USER.md: Context about the user's preferences (direct communication, action-oriented, tables for structured data, pushes back on bad ideas). Include relevant context for this agent's specialty.

Respond with ONLY a JSON object like:
{
  "IDENTITY.md": "file content...",
  "SOUL.md": "file content...",
  "TOOLS.md": "file content...",
  "USER.md": "file content..."
}

No markdown fences. No explanation. Just the JSON object.`;

  const result = await chatCompletion(
    [{ role: 'user', content: prompt }],
    {
      model: 'claude-haiku-4-5',
      max_tokens: 4096,
      temperature: 0.7,
    }
  );

  // Extract the response text
  const text = result?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty response from LLM');

  // Parse JSON — handle potential markdown fences
  let jsonStr = text.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  const files = JSON.parse(jsonStr);

  // Validate we got all 4 files
  const required = ['IDENTITY.md', 'SOUL.md', 'TOOLS.md', 'USER.md'];
  for (const f of required) {
    if (!files[f] || typeof files[f] !== 'string') {
      throw new Error(`Missing or invalid file: ${f}`);
    }
  }

  return files;
}

async function deleteAgent(name) {
  if (name === 'main') return { success: false, error: 'Cannot delete main agent' };
  const agents = loadAgentsFromDisk();
  const idx = agents.findIndex(a => a.name === name);
  if (idx === -1) return { success: false, error: 'Agent not found' };

  agents.splice(idx, 1);
  saveAgentsToDisk(agents);
  _agentsCache = null;
  return { success: true };
}

async function cloneAgent(sourceName, newName) {
  if (!newName || !/^[a-z][a-z0-9_-]*$/.test(newName)) {
    return { success: false, error: 'Invalid name (lowercase letters, numbers, hyphens, underscores only)' };
  }
  const agents = loadAgentsFromDisk();
  const source = agents.find(a => a.name === sourceName);
  if (!source) return { success: false, error: 'Source agent not found' };
  if (agents.find(a => a.name === newName)) {
    return { success: false, error: 'Agent already exists' };
  }

  const srcWs = getWorkspacePath(sourceName);
  const dstWs = getWorkspacePath(newName);
  if (!fs.existsSync(dstWs)) fs.mkdirSync(dstWs, { recursive: true });

  for (const file of EDITABLE_FILES) {
    const srcPath = path.join(srcWs, file);
    if (fs.existsSync(srcPath)) {
      let content = fs.readFileSync(srcPath, 'utf8');
      if (file === 'IDENTITY.md') {
        const capName = newName.charAt(0).toUpperCase() + newName.slice(1);
        content = content.replace(/\*\*Name:\*\*\s*\w+/g, `**Name:** ${capName}`);
      }
      fs.writeFileSync(path.join(dstWs, file), content, 'utf8');
    }
  }

  const capName = newName.charAt(0).toUpperCase() + newName.slice(1);
  // A clone keeps what makes the source what it is: category, owner (a member's agent stays that
  // member's), blurb, icon, policy. Never the lead flag or sharing list.
  agents.push({
    name: newName,
    model: source.model,
    display: capName,
    type: source.type || 'normal',
    ...(source.category ? { category: source.category } : {}),
    ...(source.owner ? { owner: source.owner } : {}),
    ...(source.blurb ? { blurb: source.blurb } : {}),
    ...(source.icon ? { icon: source.icon } : {}),
    ...(source.policy ? { policy: JSON.parse(JSON.stringify(source.policy)) } : {}),
  });
  saveAgentsToDisk(agents);
  _agentsCache = null;
  return { success: true, name: newName };
}

async function renameAgent(oldName, newName) {
  if (oldName === 'main') return { success: false, error: 'Cannot rename main agent' };
  if (oldName === newName) return { success: false, error: 'Names are the same' };
  if (!newName || !/^[a-z][a-z0-9_-]*$/.test(newName)) {
    return { success: false, error: 'Invalid name (lowercase letters, numbers, hyphens, underscores only)' };
  }

  const agents = loadAgentsFromDisk();
  const agent = agents.find(a => a.name === oldName);
  if (!agent) return { success: false, error: 'Agent not found' };
  if (agents.find(a => a.name === newName)) return { success: false, error: 'Agent with that name already exists' };

  // Rename workspace folder
  const srcWs = getWorkspacePath(oldName);
  const dstWs = getWorkspacePath(newName);
  if (fs.existsSync(srcWs)) {
    fs.renameSync(srcWs, dstWs);
  }

  // Rename conversation file
  const convDir = path.join(__dirname, '..', 'data', 'conversations');
  const srcConv = path.join(convDir, `${oldName}.json`);
  const dstConv = path.join(convDir, `${newName}.json`);
  if (fs.existsSync(srcConv)) {
    fs.renameSync(srcConv, dstConv);
  }

  // Rename memory DB file
  const memDir = path.join(__dirname, '..', 'data', 'memory');
  const srcMem = path.join(memDir, `${oldName}.sqlite`);
  const dstMem = path.join(memDir, `${newName}.sqlite`);
  if (fs.existsSync(srcMem)) {
    fs.renameSync(srcMem, dstMem);
  }

  // Rename session notes folder
  const notesDir = path.join(__dirname, '..', 'data', 'sessions');
  const srcNotes = path.join(notesDir, oldName);
  const dstNotes = path.join(notesDir, newName);
  if (fs.existsSync(srcNotes)) {
    fs.renameSync(srcNotes, dstNotes);
  }

  // Update agents.json entry
  agent.name = newName;
  saveAgentsToDisk(agents);
  _agentsCache = null;

  return { success: true, newName };
}

async function setAgentModel(agentName, model) {
  const agents = loadAgentsFromDisk();
  const agent = agents.find(a => a.name === agentName);
  if (!agent) return { success: false, error: 'Agent not found' };

  agent.model = model;
  saveAgentsToDisk(agents);
  _agentsCache = null;
  return { success: true };
}

// ── Text fields shown in the pages (display name, icon, blurb) ─────────────
// These end up in the sidebar, tab titles and tooltips of every user's browser. The pages escape them, and
// the server refuses or strips anything that is markup-shaped, so a stored name can never be a payload.
// (The limits and character classes are defined at the top of this file.)

/** cleanText(value, max): control characters out, markup characters out, trimmed, capped. Never throws. */
function cleanText(value, max) {
  return String(value ?? '').replace(CONTROL_CHARS_RE, '').replace(/[<>"'&`]/g, '').trim().slice(0, max);
}
/** validateDisplayName(value) -> { ok, display } | { ok:false, error }: refuses markup characters, strips controls, caps at 40. */
function validateDisplayName(value) {
  const raw = String(value ?? '').replace(CONTROL_CHARS_RE, '').trim();
  if (MARKUP_CHARS_RE.test(raw)) return { ok: false, error: 'A display name cannot contain < > " \' & or ` characters.' };
  return { ok: true, display: raw.slice(0, DISPLAY_MAX) };
}
/** validateIcon(value) -> { ok, icon } | { ok:false, error }: one grapheme cluster (an emoji, possibly with modifiers), at most 8 UTF-16 units, no markup. */
function validateIcon(value) {
  const raw = String(value ?? '').replace(CONTROL_CHARS_RE, '').trim();
  if (!raw) return { ok: true, icon: '' };
  if (MARKUP_CHARS_RE.test(raw)) return { ok: false, error: 'An icon cannot contain < > " \' & or ` characters.' };
  if (raw.length > ICON_MAX_UNITS) return { ok: false, error: `An icon is a single emoji (at most ${ICON_MAX_UNITS} UTF-16 code units).` };
  let clusters = 0;
  try { clusters = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(raw)].length; }
  catch { clusters = [...raw].length; }
  if (clusters !== 1) return { ok: false, error: 'An icon is a single emoji or character.' };
  return { ok: true, icon: raw };
}

async function setAgentDisplay(agentName, display) {
  const agents = loadAgentsFromDisk();
  const agent = agents.find(a => a.name === agentName);
  if (!agent) return { success: false, error: 'Agent not found' };

  const v = validateDisplayName(display);
  if (!v.ok) return { success: false, error: v.error };
  agent.display = v.display || agentName.charAt(0).toUpperCase() + agentName.slice(1);
  saveAgentsToDisk(agents);
  _agentsCache = null;
  return { success: true, display: agent.display };
}

async function setAgentIcon(agentName, icon) {
  const agents = loadAgentsFromDisk();
  const agent = agents.find(a => a.name === agentName);
  if (!agent) return { success: false, error: 'Agent not found' };

  const v = validateIcon(icon);
  if (!v.ok) return { success: false, error: v.error };
  agent.icon = v.icon || autoGenerateIcon(agentName, agent.model);
  saveAgentsToDisk(agents);
  _agentsCache = null;
  return { success: true, icon: agent.icon };
}

// ── Personality File Management ─────────────────────────────────────────

async function getAgentFiles(agentName) {
  const ws = await getAgentWorkspace(agentName);
  const files = {};
  for (const file of EDITABLE_FILES) {
    const filePath = path.join(ws, file);
    try {
      if (fs.existsSync(filePath)) {
        files[file] = fs.readFileSync(filePath, 'utf8');
      }
    } catch {}
  }
  return files;
}

async function saveAgentFile(agentName, filename, content) {
  if (!EDITABLE_FILES.includes(filename)) {
    return { success: false, error: 'Invalid filename' };
  }
  const ws = await getAgentWorkspace(agentName);
  if (!fs.existsSync(ws)) fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, filename), content, 'utf8');
  return { success: true };
}

// ── Model Listing (via Gateway) ─────────────────────────────────────────

// Patterns that indicate non-chat models (embeddings, image gen, rerankers, whisper, etc.)
const NON_CHAT_PATTERNS = [
  /rerank/i,
  /embedding/i,
  /^dall-e/i,
  /gpt-image/i,
  /chatgpt-image/i,
  /^imagen/i,
  /-image-preview$/i,
  /-image$/i,
  /^whisper/i,
  /gpt-audio/i,
  /gpt-realtime/i,
  /transcribe/i,
  /-tts/i,
  /-instruct/i,
  /-codex/i,
  /search-api/i,
  /translate/i,
  /^self_hosted\/.*embedding/i,
  /^openai-model-router$/i,
  /#cx$/i,
  /#raid$/i,
  /#priority-cx$/i,
  /-sweden$/i,
  /-codex-sweden$/i,
  /^parakeet/i,
  /^text-embedding/i,
];

function isChatModel(modelId) {
  return !NON_CHAT_PATTERNS.some(re => re.test(modelId));
}

async function getAvailableModels() {
  try {
    const all = await listModels();
    return all.filter(isChatModel);
  } catch (e) {
    // Return nothing rather than a hardcoded guess. A fabricated list shows
    // models the user can't reach and hides ones they can — an empty
    // dropdown is a visible bug, a wrong one is an invisible one.
    console.error('Failed to list models:', e.message);
    return [];
  }
}

// Update arbitrary agent fields (category, etc.)
async function updateAgentField(agentName, fields) {
  const agents = loadAgentsFromDisk();
  const agent = agents.find(a => a.name === agentName);
  if (!agent) return { success: false, error: 'Agent not found' };

  const allowedFields = ['owner', 'sharedWith', 'policy', 'category', 'lead', 'blurb', 'maxContextMessages', 'maxOutputTokens', 'contextBudget', 'autoModel', 'autoModelAllowedModels', 'minimalContext', 'toolWhitelist', 'noTools', 'compaction', 'recordsMaxBytes', 'contextWindow', 'fallbackModel', 'minModel', 'sandbox', 'tools', 'effort'];
  for (const [key, value] of Object.entries(fields)) {
    if (allowedFields.includes(key)) {
      if (key === 'sandbox') {
        const v = String(value || 'inherit');
        if (!['inherit', 'off', 'container'].includes(v)) return { ok: false, error: 'sandbox must be inherit, off or container' };
        agent.sandbox = v; continue;
      }
      if (key === 'effort') {
        const v = String(value || 'default').toLowerCase();
        if (v !== 'default' && !require('./effort').LEVELS.includes(v)) return { ok: false, error: 'effort must be default, low, medium, high, xhigh or max' };
        if (v === 'default') delete agent.effort; else agent.effort = v;
        continue;
      }
      if (key === 'tools') {
        const v = String(value || 'inherit');
        if (!['inherit', 'client', 'hub'].includes(v)) return { ok: false, error: 'tools must be inherit, client or hub' };
        agent.tools = v; continue;
      }
      if (key === 'autoModel') {
        agent.autoModel = !!value;
      } else if (key === 'contextWindow') {
        // tokens; the real window of a gateway/local model when the hub cannot learn it. Empty -> auto.
        const n = Number(value); if (n >= 2048 && n <= 4000000) agent.contextWindow = Math.round(n); else delete agent.contextWindow;
      } else if (key === 'compaction') {
        // { mode: off|dry|on|assisted, at: 0.3..0.95 }; empty -> hub defaults (settings.compactionMode / compactionAt)
        const src = value && typeof value === 'object' ? value : {};
        const out = {};
        if (['off', 'dry', 'on', 'assisted'].includes(src.mode)) out.mode = src.mode;
        const at = Number(src.at); if (at >= 0.3 && at <= 0.95) out.at = Math.round(at * 100) / 100;
        if (Object.keys(out).length) agent.compaction = out; else delete agent.compaction;
      } else if (key === 'recordsMaxBytes') {
        const n = Number(value); if (n >= 4096 && n <= 2 * 1024 * 1024) agent.recordsMaxBytes = Math.round(n); else delete agent.recordsMaxBytes;
      } else if (key === 'blurb') {
        const b = cleanText(value, BLURB_MAX);
        if (b) agent.blurb = b; else delete agent.blurb;
      } else if (key === 'sharedWith') {
        const ids = (Array.isArray(value) ? value : []).map(v => String(v).slice(0, 40)).filter(Boolean);
        if (ids.length) agent.sharedWith = [...new Set(ids)]; else delete agent.sharedWith;
      } else if (key === 'owner') {
        if (value === null || value === '' || value === 'infra') delete agent.owner; else agent.owner = String(value).slice(0, 40);
      } else if (key === 'policy') {
        // { overrides: { write_outside|send|admin|destroy: allow|ask|deny }, roots: [paths] }; empty -> role defaults
        const ov = {}; const roots = [];
        const src = value && typeof value === 'object' ? value : {};
        for (const [k, v] of Object.entries(src.overrides || {})) if (['read_outside', 'web', 'write_outside', 'send', 'admin', 'destroy'].includes(k) && ['allow', 'ask', 'deny'].includes(v)) ov[k] = v;
        for (const r of (Array.isArray(src.roots) ? src.roots : [])) { const t = String(r || '').trim(); if (t && t.length < 400) roots.push(t); }
        if (Object.keys(ov).length || roots.length) agent.policy = { ...(Object.keys(ov).length ? { overrides: ov } : {}), ...(roots.length ? { roots } : {}) }; else delete agent.policy;
      } else if (key === 'lead') {
        if (value === true || value === 'true') agent.lead = true; else delete agent.lead;
      } else if (key === 'contextBudget' && value !== null && value !== '') {
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0) return { success: false, error: 'contextBudget must be a positive whole number of tokens' };
        agent.contextBudget = n;
      } else if (value === null || value === '') {
        delete agent[key];
      } else {
        agent[key] = value;
      }
    }
  }

  fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2));
  _agentsCache = null;
  return { success: true };
}

// ── Exports ─────────────────────────────────────────────────────────────

module.exports = {
  seedDefaultWorkspaces,
  getAgents,
  getAgentsSync,
  leadAgentNames,
  isLeadAgent,
  defaultLeadAgent,
  shouldMarkMaestroLead,
  ensureMaestroLead,
  getAgentModel,
  isAutoModel,
  getAgentWorkspace,
  loadAgentContext,
  getAgentFiles,
  saveAgentFile,
  createAgent,
  cloneAgent,
  deleteAgent,
  renameAgent,
  getAvailableModels,
  setAgentModel,
  setAgentDisplay,
  setAgentIcon,
  validateDisplayName,
  validateIcon,
  cleanText,
  autoGenerateIcon,
  updateAgentField,
  CHANNEL_CONTEXT,
  EDITABLE_FILES,
};
