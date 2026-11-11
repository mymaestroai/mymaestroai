'use strict';

/**
 * agents.js — Agent discovery, context loading, and CRUD
 *
 * Self-contained agent management using a local config file (data/agents.json).
 * Model routing is handled by gateway-client.js (multi-provider).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { listModels, chatCompletion } = require('./gateway-client');

// ── Paths ───────────────────────────────────────────────────────────────

const HUB_DIR = path.join(__dirname, '..');
const AGENTS_FILE = path.join(HUB_DIR, 'data', 'agents.json');
const AGENTS_EXAMPLE = path.join(HUB_DIR, 'data', 'agents.example.json');
const WORKSPACES_DIR = path.join(HUB_DIR, 'workspaces');
const WORKSPACE_TEMPLATES_DIR = path.join(HUB_DIR, 'templates', 'workspaces');
const WORKSPACE_UPDATES_FILE = path.join(HUB_DIR, 'templates', 'workspace-updates.json');
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
/**
 * Hub-provided playbooks in a workspace (the setup interview, for one) get better over time, but seeding never
 * overwrites. A copy that is byte-identical to a version we shipped before was never edited, so it is replaced by the
 * current template; any other copy is the owner's and stays. templates/workspace-updates.json lists, per file, the
 * sha256 of every earlier shipped version. Symbolic links are never followed or replaced.
 * @returns {string[]} relative paths of files that were updated
 */
function refreshShippedWorkspaceFiles(templatesDir = WORKSPACE_TEMPLATES_DIR, workspacesDir = WORKSPACES_DIR, updatesFile = WORKSPACE_UPDATES_FILE) {
  const updated = [];
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(updatesFile, 'utf8')) || {}; } catch { return updated; }
  for (const [rel, info] of Object.entries(manifest)) {
    if (!/^[a-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(rel) || !info || !Array.isArray(info.previous)) continue;
    const src = path.join(templatesDir, rel), dst = path.join(workspacesDir, rel);
    let tmp = null;
    try {
      // Only a real agent folder and a regular file: a linked folder or file could lead outside the workspaces.
      if (!fs.lstatSync(path.dirname(dst)).isDirectory()) continue;
      const st = fs.lstatSync(dst);
      if (!st.isFile()) continue;
      const have = fs.readFileSync(dst), next = fs.readFileSync(src);
      if (have.equals(next)) continue;
      if (!info.previous.includes(crypto.createHash('sha256').update(have).digest('hex'))) continue;   // edited: theirs
      const t = `${dst}.update-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      const fd = fs.openSync(t, 'wx', st.mode & 0o777);   // exclusive: never through an existing name
      tmp = t;                                             // ours from here on: removed below if anything fails
      try { fs.writeFileSync(fd, next); } finally { fs.closeSync(fd); }
      fs.renameSync(t, dst);
      tmp = null;
      updated.push(rel);
    } catch { /* no copy yet (seeding makes it), no template, or a name in the way: nothing to do */ }
    if (tmp) try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
  return updated;
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

/** Flagged leads (lead: true) whose owner is empty or an admin. Never leadAgentNames()'s fallback to primary agents. */
function ownerLeadNames(agents = getAgentsSync()) {
  const admins = adminIdSet();
  return (agents || []).filter(a => a && a.lead === true && a.name && (!a.owner || admins.has(String(a.owner)))).map(a => a.name);
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
    try { forgetModulePermissions([LEGACY_LEAD]); }
    catch (e) { return { changed: false, reason: `module permissions could not be cleared (${e.message}); it runs again on the next start` }; }
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
      const idx = filesRoot ? records.filesIndex(filesRoot, { max: opts.compressionTurn ? 40 : 150, zone: require('./timezone').zoneForAgent(agentName) }) : null;
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
          const tzLib = require('./timezone'); const zone = tzLib.zoneForAgent(agentName);   // local time of the person it works for
          for (const r of rows.slice().reverse()) {   // newest first while budgeting, then restore order
            const body = String(r.text || '').trim().slice(0, 4000);
            if (budget - body.length < 0) break; budget -= body.length;
            lines.unshift(`[${tzLib.stamp(r.ts, zone)}] ${r.kind === 'user' ? 'Owner' : 'You'}: ${body}`);
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
          const tzLib = require('./timezone'); const zone = tzLib.zoneForAgent(agentName);   // local time of the person it works for
          for (const h of hits) {
            const body = String(h.kind === 'assistant' || h.kind === 'user' ? h.text : h.snippet || h.text).trim().slice(0, 1200);
            if (budget - body.length < 0) break; budget -= body.length;
            lines.push(`#${h.id} ${tzLib.stamp(h.ts, zone)} ${h.kind}${h.tool ? ` (${h.tool})` : ''}: ${body}`);
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

// Names that settings maps keyed by agent name would drop (they reach an object's prototype): never an agent's name.
const RESERVED_NAMES = new Set(['constructor', 'prototype', '__proto__']);

// Underscore is allowed: member-owned agents are named <login>_<name>.
function isValidAgentName(name) {
  return typeof name === 'string' && /^[a-z][a-z0-9_]*$/.test(name) && !RESERVED_NAMES.has(name);
}
// What create_agent may set besides name, model and personality: the agent list's display name, icon and one-line
// blurb, and the workspace files and Records the lead wrote itself after interviewing the person (AGENT-PLAYBOOK.md).
// The files are saved as given; no model rewrites them. The list fields follow the rules of the pages' own editors
// (validateDisplayName, validateIcon, cleanText), except that anything those would strip or cut is refused, so the
// lead can fix it. Returns the cleaned values, or { error } in plain words.
const AGENT_FILE_KEYS = ['SOUL.md', 'IDENTITY.md', 'USER.md', 'TOOLS.md'];
const MAX_AGENT_FILE = 64 * 1024, MAX_RECORDS = 8, MAX_RECORDS_TOTAL = 200 * 1024;
const NEW_BLURB_MAX = 120;   // what the agent settings page lets a person type
const RECORD_NAME = /^[a-z0-9][a-z0-9_-]{0,47}\.md$/;
const HAS_CONTROL_RE = new RegExp(CONTROL_CHARS_RE.source);   // the shared one is global, and .test() on it keeps state
// Invisible characters that make a name look like another one, or run text backwards: every format character (soft
// hyphen, zero-width space, direction marks and overrides, tags...) except the joiners emoji need, plus the invisible
// letters and marks outside that class. An icon only refuses the direction ones (validateIcon keeps it to one emoji).
const INVISIBLE_RE = /(?![\u200c\u200d])\p{Cf}|[\u034f\u115f\u1160\u3164\uffa0]/u;
const DIRECTION_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const SHOWN_CHARS = 'without < > " \' & ` or invisible characters (write ’ for an apostrophe)';
const TAG_FLAG_RE = /\u{1F3F4}[\u{E0061}-\u{E007A}]{2,6}\u{E007F}/gu;   // England, Scotland, Wales: a flag made of tag characters
const shownOk = (v, max) => typeof v === 'string' && !!v.trim() && v.trim().length <= max && !HAS_CONTROL_RE.test(v) && !MARKUP_CHARS_RE.test(v) && !INVISIBLE_RE.test(v.replace(TAG_FLAG_RE, ''));
// How a shown name reads to a person: case, compatibility forms, invisible characters and variation selectors don't make
// it a different name. (Other combining marks do: a vowel sign in Devanagari or Thai is part of the name. So do the tag
// letters of a flag: Scotland and Wales are two flags.)
const FLAG_SPLIT_RE = new RegExp(`(${TAG_FLAG_RE.source})`, 'u');
const shownKey = (v) => String(v || '').normalize('NFKC').split(FLAG_SPLIT_RE)
  .map((part, i) => (i % 2 ? part : part.replace(/[\p{Cf}\u034f\u115f\u1160\u3164\uffa0\u180b-\u180d\u180f\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu, '')))
  .join('').trim().toLowerCase();
const twinOf = (agents, display, owner) => { const key = shownKey(display); return agents.find(a => String(a.owner || '') === String(owner || '') && (shownKey(a.display || a.name) === key || shownKey(a.name) === key)); };
function agentSpec(extra) {
  const x = extra && typeof extra === 'object' ? extra : {};
  const out = {};
  if (x.display != null && x.display !== '') {
    if (!shownOk(x.display, DISPLAY_MAX)) return { error: `display name: 1 to ${DISPLAY_MAX} characters, ${SHOWN_CHARS}` };
    out.display = x.display.trim();
  }
  if (x.icon != null && x.icon !== '') {
    const v = typeof x.icon === 'string' && !HAS_CONTROL_RE.test(x.icon) && !DIRECTION_RE.test(x.icon) ? validateIcon(x.icon) : { ok: false };
    if (!v.ok || !v.icon) return { error: 'icon: one emoji' };
    out.icon = v.icon;
  }
  if (x.blurb != null && x.blurb !== '') {
    if (!shownOk(x.blurb, NEW_BLURB_MAX)) return { error: `blurb: one line, up to ${NEW_BLURB_MAX} characters, ${SHOWN_CHARS}` };
    out.blurb = x.blurb.trim();
  }
  if (x.files != null) {
    if (typeof x.files !== 'object' || Array.isArray(x.files)) return { error: 'files: file name to text' };
    const files = {};
    for (const [k, v] of Object.entries(x.files)) {
      if (!AGENT_FILE_KEYS.includes(k)) return { error: `files: only ${AGENT_FILE_KEYS.join(', ')}` };
      if (v == null || v === '') continue;
      if (typeof v !== 'string' || Buffer.byteLength(v, 'utf8') > MAX_AGENT_FILE) return { error: `${k}: text, up to 64 KB` };
      files[k] = v;
    }
    if (Object.keys(files).length) out.files = files;
  }
  if (x.records != null) {
    if (!Array.isArray(x.records) || x.records.length > MAX_RECORDS) return { error: `records: a list of up to ${MAX_RECORDS}, each { name, content }` };
    const seen = new Set(); const recs = []; let total = 0;
    for (const r of x.records) {
      const n = r && typeof r.name === 'string' ? r.name.trim() : '';
      if (!RECORD_NAME.test(n) || seen.has(n)) return { error: 'records: each name like "garden.md" (lowercase letters, digits, - or _), used once' };
      if (typeof r.content !== 'string') return { error: `records: ${n} needs its text` };
      const size = Buffer.byteLength(r.content, 'utf8'); total += size;
      if (size > MAX_AGENT_FILE || total > MAX_RECORDS_TOTAL) return { error: 'records: up to 64 KB each and 200 KB in all' };
      seen.add(n); recs.push({ name: n, content: r.content });
    }
    if (recs.length) out.records = recs;
  }
  return out;
}
// What an agent keeps under its name: its folder (files, Records), chat history, Claude or Codex session, memory,
// session notes, conversation archive, context notes, scheduled tasks and sandbox box. A new agent of the same name
// would pick them all up (the session is resumed; memory and archive hits go into its prompt; the box keeps the old
// mounts). Deleting an agent moves all of them into one bundle, data/archived-agents/<name>-<when>/ (lib/agent-archive),
// so the name is free at once; a name still holding any of them (an unfinished removal, or a delete from before
// bundles) is cleared the same way before it is given to a new agent. A store that can't be read throws: the name is
// never taken as free on trust.
const SESSION_MAP_FILES = [[process.env.HUB_AGENT_SESSIONS_FILE || path.join(HUB_DIR, 'data', 'agent-sessions.json'), 'Claude session'],
  [process.env.HUB_CODEX_SESSIONS_FILE || path.join(HUB_DIR, 'data', 'codex-sessions.json'), 'Codex session']];
const SCHEDULED_TASKS_FILE = path.join(HUB_DIR, 'data', 'scheduled-tasks.json');
const present = (p) => { try { fs.lstatSync(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
// A module this process has already loaded, or null (the hub's chat engine isn't loaded in tests and tools).
const loadedModule = (m) => { const c = require.cache[require.resolve(m)]; return c ? c.exports : null; };
const contextNotesFile = (name) => path.join(HUB_DIR, 'data', 'context-refresh', `${String(name).replace(/[^a-z0-9_-]/gi, '_')}.json`);
function scheduledTasksFor(name) {
  const sc = loadedModule('./sdk-chat');
  if (sc && sc.getScheduledTasks) return sc.getScheduledTasks().tasksOf(name).length;
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(SCHEDULED_TASKS_FILE, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return 0; throw new Error('scheduled-tasks.json can\'t be read'); }
  return ((doc && doc.tasks) || []).filter(t => t && t.agent === name).length;
}
function leftoversOf(name) {
  const found = [];
  if (getAgentArchive().pendingFor(name).length) found.push('unfinished removal');
  const ws = getWorkspacePath(name);
  try { if (!fs.lstatSync(ws).isDirectory() || fs.readdirSync(ws).length) found.push('folder'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (present(path.join(HUB_DIR, 'data', 'conversations', `${name}.jsonl`))) found.push('chat history');
  for (const [file, what] of SESSION_MAP_FILES) {
    let raw = null;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (raw === null) continue;
    let m; try { m = JSON.parse(raw); } catch { throw new Error(`${path.basename(file)} can't be read`); }
    if (m && typeof m === 'object' && Object.prototype.hasOwnProperty.call(m, name)) found.push(what);
  }
  const st = require('./memory-db').getMemoryStats(name);
  if (st.longTermSections || st.sessionNotes || st.distilledDays) found.push('memory');
  if (present(path.join(HUB_DIR, 'data', 'sessions', name))) found.push('notes folder');
  if (present(contextNotesFile(name))) found.push('context notes');
  if (scheduledTasksFor(name)) found.push('scheduled tasks');
  const files = ownFilesFolder(name, null);
  try { if (files && (!fs.lstatSync(files).isDirectory() || fs.readdirSync(files).length)) found.push('Files folder'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const transcript = require('./transcript').getTranscript();
  const tr = transcript.stats(name);
  if (!tr) throw new Error('the conversation archive could not be opened; the hub log says why (a damaged archive needs an admin to look at it)');
  // its own file counts even when the rows are still in the combined file (a split that stopped part-way copied them)
  if (tr.entries || present(transcript.fileFor(name))) found.push('conversation archive');
  return found;
}

// What an admin granted an agent by name: a new agent given the name would have it too. Not moved with the rest (they
// are the admin's settings), so the name stays taken while one is there, and the message says which.
function grantsOf(name) {
  const found = [];
  const wallet = require('./settings').getSetting('walletAgents');
  if (Array.isArray(wallet) && wallet.includes(name)) found.push('wallet access (walletAgents in data/settings.json)');
  if (require('./root-grants').getRootGrants().active(name)) found.push('a root grant (until it ends)');
  const conns = require('./connectors').getConnectors().list().connectors.filter(c => Array.isArray(c.agents) && c.agents.includes(name));
  if (conns.length) found.push(`access to the connector${conns.length === 1 ? '' : 's'} ${conns.map(c => c.id).join(', ')}`);
  const now = Date.now();
  const tokens = require('./auth').getAuth().listTokens().filter(t => !t.revokedAt && !(t.expiresAt && Date.parse(t.expiresAt) <= now) && Array.isArray(t.agents) && t.agents.includes(name));
  if (tokens.length) found.push(`the API token${tokens.length === 1 ? '' : 's'} ${tokens.map(t => t.name).join(', ')}`);
  return found;
}

// The agent's own Files folder, share/<name> (lib/files rootForAgent); a member's agent uses the member's folder and a
// team agent its team's, which stay. The folder every admin-side agent shares is never an agent's own.
function ownFilesFolder(name, entry) {
  const safe = String(name).replace(/[^a-zA-Z0-9_.-]/g, '_');
  if (!safe || safe === 'common' || /^\.+$/.test(safe)) return null;
  if (entry) {
    let memberOwned = false;
    try { memberOwned = !!entry.owner && !require('./auth').getAuth().admins().some(u => String(u.id) === String(entry.owner)); } catch {}
    if (memberOwned) return null;
    let team = null; try { team = require('./tool-policy').teamFolderOf(entry); } catch {}
    if (team) return null;
  }
  return path.join(require('./hub-home').HUB_HOME, 'share', safe);
}

// A new agent's own sandbox box id (lib/sandbox containerName): no other agent, earlier or later, of the same name shares it.
const newBoxId = () => crypto.randomBytes(6).toString('hex');

// One change at a time per name, from putting aside what an earlier agent of that name left to saving the list
// (create, clone, rename, delete, member teams, the start-up finisher): a second request for a name never moves what
// the first one just made. Callers queue in arrival order; several names are taken together, so no two wait on each other.
const nameLocks = new Map();
const heldNames = new (require('async_hooks').AsyncLocalStorage)();
async function withNames(names, fn) {
  const keys = [...new Set(names.map(String))];
  // A request takes all the names it needs at once: one that already holds names and asks for more could wait on a
  // request waiting for it (two names, two orders), so that is refused too.
  // (Work a locked section starts and leaves running sees an empty set once the section ends, so it is never refused.)
  const store = heldNames.getStore();
  if (store && store.size) throw new Error(`a change of agent names is already under way in this request (${keys.join(', ')} asked for again)`);
  const before = keys.map(k => nameLocks.get(k) || Promise.resolve());
  let release;
  const mine = new Promise(r => { release = r; });
  for (const k of keys) nameLocks.set(k, mine);
  const held = new Set(keys);
  try {
    await Promise.all(before.map(p => p.catch(() => {})));
    return await heldNames.run(held, fn);
  } finally { held.clear(); release(); for (const k of keys) if (nameLocks.get(k) === mine) nameLocks.delete(k); }
}
// At work: a turn of its own, or a background job (run_job) still running, which removing its box would kill.
function agentBusy(name) {
  const sc = loadedModule('./sdk-chat');
  if (!sc) return false;
  if (sc.isAgentActive && sc.isAgentActive(name)) return true;
  try { const jr = sc.getJobRunner && sc.getJobRunner(); return !!(jr && jr.jobs && [...jr.jobs.values()].some(j => j.owner === name && (j.status === 'running' || j.status === 'cancelling'))); } catch { return false; }
}

let _archive = null, _archiveOverrides = null;
const sandboxOf = () => (_archiveOverrides && _archiveOverrides.sandbox ? _archiveOverrides.sandbox() : require('./sandbox').getSandbox());
function getAgentArchive() {
  if (_archive) return _archive;
  _archive = require('./agent-archive').createAgentArchive({
    dataDir: path.join(HUB_DIR, 'data'),
    workspaceFor: getWorkspacePath,
    filesFolderFor: ownFilesFolder,
    sessionMapFiles: SESSION_MAP_FILES,
    scheduledTasksFile: SCHEDULED_TASKS_FILE,
    memory: () => require('./memory-db'),
    transcript: () => require('./transcript').getTranscript(),
    scheduler: () => { const sc = loadedModule('./sdk-chat'); return sc && sc.getScheduledTasks ? sc.getScheduledTasks() : null; },
    sandbox: () => require('./sandbox').getSandbox(),
    isBoxed: (entry) => require('./sandbox').getSandbox().isSandboxed(entry),
    boxNameOf: (entry) => require('./sandbox').containerNameFor(entry),
    forget: (name) => { const sc = loadedModule('./sdk-chat'); if (sc && sc.forgetAgent) sc.forgetAgent(name); },
    ..._archiveOverrides,
  });
  return _archive;
}

/**
 * clearEarlierAgent(name) -> the bundle the things went to, or null: before a name is given to a new agent, whatever an
 * earlier agent of that name left is kept in a bundle (an unfinished removal is finished). Only for a name the agent
 * list, read from the file itself, doesn't have. Throws when something can't be checked or moved; the name is then
 * not used.
 */
// The agent list as the file has it (no remembered copy, no defaults): for decisions that move things.
function readAgentListStrict() {
  let list;
  try { list = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return []; throw new Error('the agent list can\'t be read'); }
  if (!Array.isArray(list)) throw new Error('the agent list can\'t be read');
  return list;
}
async function clearEarlierAgent(name) {
  if (readAgentListStrict().some(a => a && a.name === name)) throw new Error(`an agent named "${name}" exists`);
  const grants = grantsOf(name);
  if (grants.length) throw new Error(`the name "${name}" still has ${listOf(grants)}, which a new agent of that name would get too: remove ${grants.length === 1 ? 'it' : 'them'} first, or choose another name`);
  const archive = getAgentArchive();
  const stillFree = () => { if (readAgentListStrict().some(a => a && a.name === name)) throw new Error(`an agent named "${name}" exists`); };
  let bundle = null;
  for (const x of archive.pendingFor(name)) { const r = await archive.run(x.dir); bundle = r.dir; stillFree(); }
  let left = leftoversOf(name);
  if (left.some(w => w !== 'unfinished removal')) {
    stillFree();
    const r = await archive.run(archive.begin({ name, entry: null, reason: 'left by an earlier agent of that name' }));
    bundle = r.dir;
    stillFree();
    left = leftoversOf(name);
  }
  if (left.length) throw new Error(`its ${listOf(left)} could not be moved yet; the hub log says why`);
  return bundle;
}
const listOf = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

// Module permissions (a level, "start without asking") are kept by agent NAME in the modules' settings (lib/modules). A name that
// changes hands (deleted, renamed, reused) or an agent whose standing changes (lead flag, owner) must not carry them over: they are
// cleared BEFORE the change, and a change whose clearing fails is not made. Lazy: lib/modules loads lib/agents, never the reverse at start.
let _forgetPermissions = null;
function forgetModulePermissions(names) {
  const list = (Array.isArray(names) ? names : [names]).filter(n => typeof n === 'string' && n);
  if (!list.length) return;
  (_forgetPermissions || require('./modules').forgetAgentPermissions)(list);
}
function permissionsError(e, what) { return `Could not clear the module permissions kept under this agent's name (${e.message}). ${what}`; }

async function createAgent(name, ...rest) { return withNames([name], () => createAgentNow(name, ...rest)); }
async function createAgentNow(name, model, personality, skills, category, owner = null, extra = null) {
  if (model == null) model = '';   // null is "pick the default", same as omitted
  if (!isValidAgentName(name)) {
    return { success: false, error: RESERVED_NAMES.has(name) ? `"${name}" can't be an agent's name. Choose another.` : 'Invalid name (lowercase letters, numbers and _, starts with a letter)' };
  }
  const spec = agentSpec(extra);
  if (spec.error) return { success: false, error: spec.error };
  const agents = loadAgentsFromDisk();
  if (agents.find(a => a.name === name)) {
    return { success: false, error: 'Agent already exists' };
  }
  let earlier = null;
  try { earlier = await clearEarlierAgent(name); }
  catch (e) { return { success: false, error: `Could not check or put away what an earlier agent named "${name}" may have left (${e.message}). Nothing was created; try again in a moment.` }; }
  try { forgetModulePermissions([name]); }
  catch (e) { return { success: false, error: permissionsError(e, 'Nothing was created; try again in a moment.') }; }

  const ws = getWorkspacePath(name);
  const capName = name.charAt(0).toUpperCase() + name.slice(1);
  const displayName = spec.display || capName;
  const chosenModel = model || 'claude-sonnet-4-6';
  // Two agents in one person's list that read the same: one could pass for the other. Checked for what the lead asks
  // for (create_agent), where a request can be steered; again just before the list is saved, for a create meanwhile.
  const twinError = (t) => `display name: another agent is already shown as "${t.display || t.name}"; choose a different one`;
  if (extra) { const t = twinOf(agents, displayName, owner); if (t) return { success: false, error: twinError(t) }; }

  // The files are written into a new hidden folder and moved into place in one step, so the agent's folder appears
  // whole or not at all. Nothing can be waiting in a folder this call just made ('wx' would refuse it anyway).
  let stage = null, current = null;
  const put = (f, content) => fs.writeFileSync(path.join(stage, f), content, { encoding: 'utf8', flag: 'wx' });
  try {
    fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
    stage = fs.mkdtempSync(path.join(WORKSPACES_DIR, `.new-${name}-`));
    if (spec.files) {
      // Written by the lead after its interview (AGENT-PLAYBOOK.md): saved as given. A core file it left out
      // gets the basic one, so the agent always has a name and a role.
      const role = personality || 'A helpful AI assistant.';
      const basic = { 'IDENTITY.md': `# IDENTITY.md\n\n## Name\n${displayName}\n\n## Role\n${role}\n\n## Platform\nMy Maestro AI\n`, 'SOUL.md': `You are ${displayName}. ${role}\n` };
      for (const f of AGENT_FILE_KEYS) { const c = spec.files[f] || basic[f]; if (c) put(f, c); }
    } else if (personality) {
      // Generate rich personality files if personality description provided
      let files = null;
      try {
        files = await generatePersonalityFiles(name, capName, chosenModel, personality, skills);
      } catch (err) {
        console.error(`[agents] Personality generation failed for ${name}, using defaults:`, err.message);
      }
      if (files) {
        // Only the four known files: a name the model made up (say "../x.js") is never written anywhere.
        for (const f of AGENT_FILE_KEYS) if (typeof files[f] === 'string') put(f, files[f]);
      } else {
        // Fall back to basic files
        put('IDENTITY.md', `# IDENTITY.md\n\n## Name\n${capName}\n\n## Role\n${personality}\n\n## Platform\nMy Maestro AI\n`);
        put('SOUL.md', `You are ${capName}. ${personality}\n`);
      }
    } else {
      put('IDENTITY.md', `# IDENTITY.md\n\n## Name\n${capName}\n\n## Role\nA helpful AI assistant.\n\n## Platform\nMy Maestro AI\n`);
      put('SOUL.md', `You are ${capName}, a helpful AI assistant.\n`);
    }
    if (spec.records) {
      fs.mkdirSync(path.join(stage, 'records'));
      for (const r of spec.records) put(path.join('records', r.name), r.content);
    }
    // Re-read: the personality step above awaits a model call for seconds, and saving the list read before it
    // dropped any agent created or changed meanwhile (two agents created at once -> only one survived). From here to
    // the save nothing awaits, so another create in this process can't slip in between the checks and the save.
    current = loadAgentsFromDisk();
    if (current.find(a => a.name === name)) return { success: false, error: 'Agent already exists' };
    if (extra) { const t = twinOf(current, displayName, owner); if (t) return { success: false, error: twinError(t) }; }
    // An empty folder of that name is replaced; one with anything in it (or a file or link) means another create, or
    // something else, got there while this one was writing.
    try { fs.renameSync(stage, ws); stage = null; }
    catch (err) { if (['ENOTEMPTY', 'EEXIST', 'ENOTDIR', 'EISDIR'].includes(err.code)) return { success: false, error: 'Agent already exists' }; throw err; }
  } catch (err) {
    return { success: false, error: `could not write the agent's files (${err.message})` };
  } finally {
    if (stage) { try { fs.rmSync(stage, { recursive: true, force: true }); } catch {} }
  }

  current.push({
    name,
    model: chosenModel,
    display: displayName,
    icon: spec.icon || autoGenerateIcon(name, model),
    type: 'normal',
    box: newBoxId(),
    category: category || 'specialist',
    ...(spec.blurb ? { blurb: spec.blurb } : {}),
    ...(owner ? { owner: String(owner) } : {}),   // user id; absent = infrastructure (admin-only)
  });
  try { saveAgentsToDisk(current); }
  catch (err) {
    // The list is written to a temp file and renamed, so a failure leaves it as it was: take the new folder back out,
    // and the name is free for another try.
    let left = null; try { fs.rmSync(ws, { recursive: true, force: true }); } catch (e) { left = e; }
    return { success: false, error: `could not save the agent list (${err.message}); ` + (left ? `its folder workspaces/${name} could not be taken back out (${left.message}); the next agent given that name finds it put aside with an earlier agent's things` : 'nothing was created') };
  }
  _agentsCache = null;
  // What an earlier agent of this name left is kept, out of the new agent's way (said so the lead can tell the person).
  return { success: true, name, ...(earlier ? { earlierAgentKept: path.relative(HUB_DIR, earlier) } : {}) };
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

/**
 * Deleting an agent takes it off the list and moves everything it left into one bundle, data/archived-agents/
 * <name>-<when>/ (lib/agent-archive): nothing is lost, nothing is left for anyone to clear, and the name is free at once.
 * The bundle is made before the agent leaves the list. A step that can't be done now (Docker not answering, say) leaves
 * the bundle unfinished and the name taken; the hub finishes it at its next start, or when the name is wanted again.
 */
async function deleteAgent(name) { return withNames([name], () => deleteAgentNow(name)); }
async function deleteAgentNow(name) {
  if (name === 'main') return { success: false, error: 'Cannot delete main agent' };
  const agents = loadAgentsFromDisk();
  const idx = agents.findIndex(a => a.name === name);
  if (idx === -1) return { success: false, error: 'Agent not found' };
  const entry = agents[idx];
  if (agentBusy(name)) {
    return { success: false, error: `${entry.display || name} is working right now (a reply or a background job). Stop it or wait until it finishes, then delete it.` };
  }
  try { forgetModulePermissions([name]); }
  catch (e) { return { success: false, error: permissionsError(e, 'Nothing was deleted.') }; }
  const archive = getAgentArchive();
  // another listed agent with the same box id (a hand-copied entry) still uses that box's home folder: it stays
  const sharesHome = !!entry.box && agents.some((a, i) => i !== idx && a && a.box === entry.box);
  let bundle;
  try { bundle = archive.begin({ name, entry, reason: 'deleted', ...(sharesHome ? { keepHome: true } : {}) }); }
  catch (e) { return { success: false, error: `Nothing was deleted: the folder that keeps a deleted agent's things could not be made (${e.message}).` }; }
  agents.splice(idx, 1);
  try { saveAgentsToDisk(agents); }
  catch (e) { try { fs.rmSync(bundle, { recursive: true, force: true }); } catch {} return { success: false, error: `Nothing was deleted: the agent list could not be saved (${e.message}).` }; }
  _agentsCache = null;
  const r = await archive.run(bundle);
  return { success: true, keptIn: path.relative(HUB_DIR, r.dir), ...(r.unfinished.length ? { unfinished: r.unfinished.map(u => `${u.label}: ${u.error}`) } : {}) };
}

/** At start: removals a stop or a failure left unfinished are finished (a name in use again is left alone). */
async function finishArchivingAgents() {
  // who exists is read again for each bundle, just before it runs; an unreadable list makes that bundle wait
  return getAgentArchive().finishPending({ inUse: (n) => readAgentListStrict().find(a => a && a.name === n) || null, guard: (n, fn) => withNames([n], fn) });
}

/**
 * addAgentEntries(entries) -> their names: list entries made outside this file (lib/teams). Each gets a box of its own
 * (never one copied from a template); the list is read from the file itself, so a list that can't be read throws
 * instead of being written over, and it is saved the way every other change is (temp file + rename, .bak kept).
 */
function addAgentEntries(entries) {
  const list = readAgentListStrict();
  for (const e of entries) if (list.some(a => a && a.name === e.name)) throw new Error(`an agent named "${e.name}" exists`);
  forgetModulePermissions(entries.map(e => e && e.name));   // throws: nothing is added
  for (const e of entries) list.push({ ...e, box: newBoxId() });
  saveAgentsToDisk(list);
  _agentsCache = null;
  return entries.map(e => e.name);
}

async function cloneAgent(sourceName, newName) { return withNames([newName], () => cloneAgentNow(sourceName, newName)); }
async function cloneAgentNow(sourceName, newName) {
  if (!newName || !/^[a-z][a-z0-9_-]*$/.test(newName) || RESERVED_NAMES.has(newName)) {
    return { success: false, error: RESERVED_NAMES.has(newName) ? `"${newName}" can't be an agent's name. Choose another.` : 'Invalid name (lowercase letters, numbers, hyphens, underscores only)' };
  }
  let agents = loadAgentsFromDisk();
  let source = agents.find(a => a.name === sourceName);
  if (!source) return { success: false, error: 'Source agent not found' };
  if (agents.find(a => a.name === newName)) {
    return { success: false, error: 'Agent already exists' };
  }
  let earlier = null;
  try { earlier = await clearEarlierAgent(newName); }
  catch (e) { return { success: false, error: `Could not check or put away what an earlier agent named "${newName}" may have left (${e.message}). Nothing was created; try again in a moment.` }; }
  try { forgetModulePermissions([newName]); }
  catch (e) { return { success: false, error: permissionsError(e, 'Nothing was created; try again in a moment.') }; }
  // The list as it is now (the wait above let other changes in): nothing below waits until it is saved.
  agents = loadAgentsFromDisk();
  source = agents.find(a => a.name === sourceName);
  if (!source) return { success: false, error: 'Source agent not found' };
  if (agents.find(a => a.name === newName)) return { success: false, error: 'Agent already exists' };

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
    box: newBoxId(),   // its own box, never the source's
    ...(source.category ? { category: source.category } : {}),
    ...(source.owner ? { owner: source.owner } : {}),
    ...(source.blurb ? { blurb: source.blurb } : {}),
    ...(source.icon ? { icon: source.icon } : {}),
    ...(source.policy ? { policy: JSON.parse(JSON.stringify(source.policy)) } : {}),
  });
  saveAgentsToDisk(agents);
  _agentsCache = null;
  return { success: true, name: newName, ...(earlier ? { earlierAgentKept: path.relative(HUB_DIR, earlier) } : {}) };
}

async function renameAgent(oldName, newName) { return withNames([oldName, newName], () => renameAgentNow(oldName, newName)); }
async function renameAgentNow(oldName, newName) {
  if (oldName === 'main') return { success: false, error: 'Cannot rename main agent' };
  if (oldName === newName) return { success: false, error: 'Names are the same' };
  if (!newName || !/^[a-z][a-z0-9_-]*$/.test(newName) || RESERVED_NAMES.has(newName)) {
    return { success: false, error: RESERVED_NAMES.has(newName) ? `"${newName}" can't be an agent's name. Choose another.` : 'Invalid name (lowercase letters, numbers, hyphens, underscores only)' };
  }

  let agents = loadAgentsFromDisk();
  let agent = agents.find(a => a.name === oldName);
  if (!agent) return { success: false, error: 'Agent not found' };
  if (agents.find(a => a.name === newName)) return { success: false, error: 'Agent with that name already exists' };
  if (agentBusy(oldName)) return { success: false, error: `${agent.display || oldName} is working right now (a reply or a background job). Stop it or wait until it finishes, then rename it.` };
  // What an admin granted it by name (wallet access, a root grant, connectors, API tokens) is the admin's setting and
  // doesn't move by itself: the agent is renamed once they are removed, and then granted again under the new name.
  let grants;
  try { grants = grantsOf(oldName); } catch (e) { return { success: false, error: `Could not check what was granted to ${agent.display || oldName} (${e.message}). Nothing was renamed.` }; }
  if (grants.length) return { success: false, error: `${agent.display || oldName} has ${listOf(grants)} under its name. Remove ${grants.length === 1 ? 'it' : 'them'}, rename it, then grant ${grants.length === 1 ? 'it' : 'them'} again to ${newName}.` };
  // What an earlier agent of the new name left is put aside first, as for a new agent (lib/agent-archive).
  try { await clearEarlierAgent(newName); }
  catch (e) { return { success: false, error: `Could not check or put away what an earlier agent named "${newName}" may have left (${e.message}). Nothing was renamed; try again in a moment.` }; }
  agents = loadAgentsFromDisk();
  agent = agents.find(a => a.name === oldName);
  if (!agent) return { success: false, error: 'Agent not found' };
  if (agents.find(a => a.name === newName)) return { success: false, error: 'Agent with that name already exists' };
  if (agentBusy(oldName)) return { success: false, error: `${agent.display || oldName} is working right now (a reply or a background job). Stop it or wait until it finishes, then rename it.` };
  const before = { ...agent };
  // Neither the old name (about to be free for another agent) nor the new one (maybe used by an earlier agent) carries module permissions.
  try { forgetModulePermissions([oldName, newName]); }
  catch (e) { return { success: false, error: permissionsError(e, 'Nothing was renamed.') }; }

  // Everything the agent keeps under its name goes with it (the same stores a delete bundles, lib/agent-archive), so its
  // chat, session, memory, notes, archive, tasks and compression history carry on, and the old name is free. One step
  // at a time; if one fails, the steps already done are put back and nothing is renamed.
  const sc = loadedModule('./sdk-chat');
  const undo = [];
  const move = (from, to) => {
    if (!from || !to || !present(from)) return;
    let emptyDir = false, mode = 0o755, moved = false;
    if (present(to)) {   // an empty folder of that name is nothing of anyone's; anything else is never replaced
      try { const st = fs.lstatSync(to); emptyDir = st.isDirectory() && !fs.readdirSync(to).length; mode = st.mode & 0o7777; } catch {}
      if (!emptyDir) throw new Error(`${path.relative(HUB_DIR, to) || to} is already there`);
      fs.rmdirSync(to);
    }
    undo.push(() => { if (moved) fs.renameSync(to, from); if (emptyDir) fs.mkdirSync(to, { mode }); });   // registered first: a failed rename gets its empty folder back too
    fs.renameSync(from, to);
    moved = true;
  };
  const writeMap = (file, map, mode) => { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(map, null, 2), { mode }); fs.renameSync(tmp, file); };
  try {
    move(getWorkspacePath(oldName), getWorkspacePath(newName));
    move(ownFilesFolder(oldName, agent), ownFilesFolder(newName, agent));
    const data = (...p) => path.join(HUB_DIR, 'data', ...p);
    move(data('conversations', `${oldName}.jsonl`), data('conversations', `${newName}.jsonl`));
    move(data('conversations', `${oldName}.json`), data('conversations', `${newName}.json`));   // the chat file of old versions
    move(data('memory', `${oldName}.sqlite`), data('memory', `${newName}.sqlite`));
    move(data('sessions', oldName), data('sessions', newName));
    move(contextNotesFile(oldName), contextNotesFile(newName));
    for (const [file, what] of SESSION_MAP_FILES) {   // the Claude or Codex session it resumes
      let raw = null;
      try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (raw === null) continue;
      let map; try { map = JSON.parse(raw); } catch { throw new Error(`${path.basename(file)} can't be read`); }   // never rewritten on a guess
      if (!map || typeof map !== 'object' || !Object.prototype.hasOwnProperty.call(map, oldName)) continue;
      if (Object.prototype.hasOwnProperty.call(map, newName)) throw new Error(`there is already a ${what} for ${newName}`);
      const mode = fs.statSync(file).mode & 0o777;
      map[newName] = map[oldName]; delete map[oldName];
      writeMap(file, map, mode);
      undo.push(() => { const m = JSON.parse(fs.readFileSync(file, 'utf8')); m[oldName] = m[newName]; delete m[newName]; writeMap(file, m, mode); });
    }
    const mem = require('./memory-db');
    if (mem.renameAgentMemory(oldName, newName)) undo.push(() => mem.renameAgentMemory(newName, oldName));
    const tr = require('./transcript').getTranscript();
    tr.rename(oldName, newName);
    undo.push(() => tr.rename(newName, oldName));
    const sched = sc && sc.getScheduledTasks ? sc.getScheduledTasks() : null;
    if (sched && typeof sched.retarget === 'function') { if (sched.retarget(oldName, newName)) undo.push(() => sched.retarget(newName, oldName)); }
    else if (scheduledTasksFor(oldName)) throw new Error('its scheduled tasks can only be moved while the hub runs');
    const comp = sc && sc.getCompaction ? sc.getCompaction() : null;
    if (comp && comp.rename && comp.rename(oldName, newName)) undo.push(() => comp.rename(newName, oldName));
    // The list last. An agent from before boxes carried an id gets one now, so it never shares a box named after its
    // new name with an earlier agent of that name.
    agent.name = newName;
    if (!agent.box) agent.box = newBoxId();
    saveAgentsToDisk(agents);
    _agentsCache = null;
  } catch (e) {
    const stuck = [];
    for (const u of undo.reverse()) { try { u(); } catch (x) { stuck.push(x.message); } }
    if (stuck.length) console.error(`[agents] rename ${oldName} -> ${newName}: could not put back: ${stuck.join('; ')}`);
    return { success: false, error: `${before.display || oldName} was not renamed (${e.message}).${stuck.length ? ' Some of what had moved could not be put back; the hub log says what.' : ''}` };
  }
  try { if (sc && sc.forgetAgent) { sc.forgetAgent(oldName); sc.forgetAgent(newName); } } catch {}   // nothing kept in memory under either name
  // The new name has a box of its own (lib/sandbox: hub-agent-<name>-<id>), made with the new folders on its next turn;
  // the home folder (hub-agent-<id>-home) goes with it. The box of the old name is removed.
  try { Promise.resolve(sandboxOf().remove(before)).catch(() => {}); } catch {}

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

/**
 * The model list for something a person is looking at (a question card's drop-down): the last list fetched, at once,
 * refreshed in the background for next time; only when none was fetched since the hub started, the full wait.
 */
async function availableModelsNow() {
  let cached = null;
  try { cached = require('./gateway-client').cachedModels(); } catch {}
  if (Array.isArray(cached) && cached.length) { getAvailableModels().catch(() => {}); return cached.filter(isChatModel); }
  return getAvailableModels();
}

// Update arbitrary agent fields (category, etc.)
async function updateAgentField(agentName, fields) {
  const agents = loadAgentsFromDisk();
  const agent = agents.find(a => a.name === agentName);
  if (!agent) return { success: false, error: 'Agent not found' };

  const wasLead = agent.lead === true, wasOwner = agent.owner ? String(agent.owner) : '';
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

  // A lead flag or an owner that changes can make the agent a lead or a member's agent: what it was given as one (a module level, no asking) does not come back.
  if ((agent.lead === true) !== wasLead || (agent.owner ? String(agent.owner) : '') !== wasOwner) {
    try { forgetModulePermissions([agentName]); }
    catch (e) { return { success: false, error: permissionsError(e, 'Nothing was changed.') }; }
  }
  fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2));
  _agentsCache = null;
  return { success: true };
}

// ── Exports ─────────────────────────────────────────────────────────────

module.exports = {
  isValidAgentName,
  seedDefaultWorkspaces,
  refreshShippedWorkspaceFiles,
  getAgents,
  getAgentsSync,
  leadAgentNames,
  ownerLeadNames,
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
  finishArchivingAgents,
  getAgentArchive,
  clearEarlierAgent,
  addAgentEntries,
  withNames,
  renameAgent,
  getAvailableModels,
  availableModelsNow,
  setAgentModel,
  setAgentDisplay,
  setAgentIcon,
  validateDisplayName,
  validateIcon,
  cleanText,
  autoGenerateIcon,
  updateAgentField,
  agentBusy,
  CHANNEL_CONTEXT,
  EDITABLE_FILES,
  // tests: the clearing of module permissions before a name or standing changes (null = the real one in lib/modules)
  __permissions: { configure(fn) { _forgetPermissions = typeof fn === 'function' ? fn : null; } },
  // tests: stand-ins for the parts of a removal that reach outside the hub's folders (Docker)
  __archive: { configure(o) { _archiveOverrides = o || null; _archive = null; } },
};
