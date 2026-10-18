'use strict';

/**
 * worker-policy.js — how agents delegate work.
 *
 * Claude SDK agents receive the whole Claude Code toolset, which includes the
 * SDK's built-in sub-agent tool ("Agent", formerly "Task"). Left alone, agents
 * reach for it first: it advertises itself for parallel and multi-step work,
 * while the hub's own consult_agent read like a way to "ask a question".
 * The owner's intent is the opposite: delegate to agents INSIDE the platform
 * (they have their own models, personalities, memory and show up as workers
 * in the UI), and keep SDK sub-workers as an option.
 *
 * Setting `sdkWorkers` (data/settings.json, /api/sdk_workers):
 *   'fallback' (default)  platform agents first; SDK sub-workers allowed only
 *                         when platform agents cannot do the job
 *   'allow'               no steering; the SDK tool competes freely (old behaviour)
 *   'off'                 SDK sub-agent tool is removed from the agent entirely
 */

const MODES = ['fallback', 'allow', 'off'];
const DEFAULT_MODE = 'fallback';
const SDK_SUBAGENT_TOOLS = ['Agent', 'Task'];   // current and legacy names of the SDK's built-in sub-agent tool

function normalizeMode(v) {
  const m = String(v || '').trim().toLowerCase();
  return MODES.includes(m) ? m : DEFAULT_MODE;
}

function getMode() {
  try { return normalizeMode(require('./settings').getSetting('sdkWorkers', DEFAULT_MODE)); }
  catch { return DEFAULT_MODE; }
}

/** One-line capability hint derived from the model id, so agents can pick a worker without a lookup. */
function strengthsFor(model) {
  const m = String(model || '').toLowerCase();
  if (!m) return 'model not configured';
  if (m.startsWith('local/')) return 'local model served by the hub\'s own proxy (llama-swap): private and free; one GPU, engines swapped on demand';
  if (m.startsWith('ninfer/')) return 'local model on the 5090: private and free to run, fast; good for bulk, drafts and sensitive text work';
  if (m.startsWith('lmstudio/') || m.startsWith('ollama/') || m.startsWith('omlx/')) return 'local model: private and free to run, slower; good for bulk or sensitive text work';
  if (m.startsWith('codex-cli/')) return 'OpenAI via Codex CLI (ChatGPT subscription), full tools: second-vendor coding, review, shell work';
  if (m.startsWith('codex/')) return 'OpenAI Codex: text-only (no tools); good for a second-vendor take on code or reasoning';
  if (m.startsWith('google/')) return 'Gemini: second-vendor perspective, very long context';
  if (m.startsWith('perplexity/')) return 'Perplexity: live web research with citations';
  if (m.includes('haiku')) return 'fast and cheap, full tools: searches, lookups, summaries, reformatting';
  if (m.includes('opus') || m.includes('fable') || m.includes('mythos')) return 'deepest reasoning, full tools: hard analysis, critique, review';
  if (m.includes('sonnet') || m.startsWith('claude-sdk/')) return 'strong general worker, full tools: coding, multi-step file work, research';
  if (m.startsWith('openai/')) return 'OpenAI model: second-vendor perspective';
  return 'general model';
}

/**
 * @param {Array<{name,display,model,category}>} agents
 * @param {object} o
 * @param {string} o.selfName            the delegating agent (excluded)
 * @param {(name:string)=>boolean} [o.isActive]  true if that agent is mid-turn right now
 */
function buildRoster(agents, { selfName, isActive = () => false } = {}) {
  return (agents || [])
    .filter(a => a && a.name && a.name !== selfName && a.category === 'worker')
    .map(a => ({ name: a.name, display: a.display || a.name, model: a.model || '', strengths: strengthsFor(a.model), busy: !!isActive(a.name) }));
}

function rosterLines(roster) {
  if (!roster.length) return '_(no agents are tagged category "worker" — call list_agents to see who you can consult)_';
  return roster.map(w => `- \`${w.name}\` (${w.model || 'no model'}) — ${w.strengths}${w.busy ? ' — **busy right now** (a consult runs on a temporary stand-in with the same model)' : ''}`).join('\n');
}

/** The delegation text every model path gets (SDK, gateway, Codex): one constant, bare tool names, true everywhere. */
function platformPolicyText(roster) {
  return `

## DELEGATION POLICY (set by the hub owner)
When you hand work to another agent, use agents INSIDE this platform via the \`consult_agent\` tool. They run on their own models, carry their own personality and memory, and appear to the user as named workers.

Platform workers available to you:
${rosterLines(roster)}
Any other named agent can be consulted too (\`list_agents\`).

How to delegate well:
- Give the worker a complete, self-contained brief: goal, exact paths, constraints, and the shape of the answer you want back. It does not see your conversation.
- For parallel work, issue several \`consult_agent\` calls to DIFFERENT workers in the same message. One agent handles one job at a time. If the agent you consult is busy, your request is QUEUED, not lost: the hub runs it when that agent is free and delivers the reply at the start of your next turn. If the job cannot wait, send it to a free worker instead.
- Tool calls in one message run together when they are \`consult_agent\`, \`spawn_workers\`, \`list_agents\`, the read/search memory tools or the job tools (\`run_job\`, \`job_status\`, \`job_cancel\`, \`list_jobs\`). Any other tool, such as a memory write or \`ask_user\`, runs alone and in the order you gave. Do not put a call in the same message as another call whose result it depends on.
- Match the job to the worker: cheap lookups to a fast model, hard review to a strong one, a second opinion to a different vendor.
- Need several hands at once, or a specific model, and no named agent's personality or memory matters? Use \`spawn_workers\`: it creates temporary workers in parallel, each on a model YOU pick from everything this install can reach (Claude, OpenAI, Gemini, local...). A worker on a Claude model gets the full Claude Code harness, so this covers everything the SDK sub-agent tool does, without being tied to one vendor.
- Workers cannot consult further workers. Verify what comes back before relying on it.`;
}

/** Markdown block appended to an SDK agent's system prompt. Empty for 'allow'. */
function policyText(mode, roster) {
  mode = normalizeMode(mode);
  if (mode === 'allow') return '';

  const head = platformPolicyText(roster);

  if (mode === 'off') {
    return head + `

The SDK's built-in sub-agent tool ("Agent"/"Task") is DISABLED on this hub. Platform agents are the only way to delegate. If they cannot do a job, do it yourself or tell the user what is blocking you.`;
  }

  return head + `

The SDK's built-in sub-agent tool ("Agent"/"Task") is a FALLBACK, not the default. Use it only when neither named platform agents nor \`spawn_workers\` can do the job, for example:
- the job needs an isolated git worktree,
- \`spawn_workers\` failed or the model you need is unreachable through it.
When you do fall back, say so in one line and give the reason, so the user can see why platform agents were not used.`;
}

function disallowedToolsFor(mode) {
  return normalizeMode(mode) === 'off' ? [...SDK_SUBAGENT_TOOLS] : [];
}

/** Description for the consult_agent tool. In 'allow' mode this is the historical wording. */
function consultDescription(mode) {
  if (normalizeMode(mode) === 'allow') {
    return 'Ask another named Hub agent a question. The agent uses its own personality, model, and tools. Use for different perspectives or specialized knowledge.';
  }
  return 'Delegate a task or question to another agent inside this platform. This is the PRIMARY way to hand off work: the agent runs on its own model with its own personality, memory and tools, and shows up to the user as a named worker. Send a complete, self-contained brief. For parallel work, call this several times in one message with DIFFERENT agents (each agent runs one job at a time). Also good for a second opinion from a different model or vendor.';
}

/** What a consult returns when the target agent is mid-turn, instead of an empty "(no response)". */
function busyMessage(target, roster) {
  const idle = (roster || []).filter(w => !w.busy && w.name !== target);
  const alt = idle.length
    ? `Free platform workers right now: ${idle.map(w => `\`${w.name}\` (${w.strengths.split(':')[0].split(',')[0]})`).join(', ')}. Re-send this brief to one of them.`
    : 'No other platform worker is free right now. Wait and retry, do the task yourself, or (if the hub allows it) fall back to an SDK sub-worker and say why.';
  return `[AGENT BUSY] "${target}" is in the middle of another turn and cannot take this job now. Nothing was run. ${alt}`;
}

module.exports = {
  platformPolicyText, MODES, DEFAULT_MODE, SDK_SUBAGENT_TOOLS,
  normalizeMode, getMode, strengthsFor, buildRoster, policyText, disallowedToolsFor, consultDescription, busyMessage,
};
