'use strict';
// The lead agent reviews behaviour changes that are waiting for the owner (lib/behaviour-changes), and, while "worker-proposals" is
// on, looks at how the install is used once a week. Both are scheduled tasks created by "the hub" (lib/scheduled-tasks HUB): the
// hub only asks the lead to explain; nothing here, and no tool, can switch a change on (only the owner, on /changes).
const bc = require('./behaviour-changes');

const MAX_PROMPT = 8000;
const REVIEW_LABEL = 'Changes to how agents behave: review';
const REVIEW_NOTE = 'a change to how agents behave is waiting for review';
const PROPOSALS_LABEL = 'Weekly team review';
const PROPOSALS_NOTE = 'the weekly team review';
const PROPOSALS_WHEN = 'every monday at 9am';
const PROPOSALS_ID = 'worker-proposals';
const PROPOSALS_PROMPT = "Look at how this install's agents were used in the last 7 days: call team_usage. If a recurring kind of work would be better served by a permanent worker or specialist (or an agent keeps spending a top-tier model on routine jobs), propose ONE to the person you work for: its name, its job, the model and why, and what it would save or improve. Keep it short. Build it only if they say yes, following AGENT-PLAYBOOK.md. If nothing is worth proposing, say nothing to them (end the turn without for_owner). For members' agents you have counts only; a proposal that would help a member says 'a member's assistant keeps needing X', without anything from their conversations, and never uses recall on a member's agent.";
const PROPOSALS_LINE = 'If team_usage shows a clear case for a new worker now, you may include one proposal at the end, after the change messages.';

function agentsNow() { try { return require('./agents').getAgentsSync() || []; } catch { return []; } }
function adminsNow() { try { return require('./auth').getAuth().admins().map((u) => String(u.id)); } catch { return []; } }

/** The first admin-side lead agent's name, or null. deps.leads() (names) overrides, for tests. */
function leadName(deps = {}) {
  try {
    if (typeof deps.leads === 'function') return (deps.leads() || [])[0] || null;
    const agents = deps.agents || agentsNow();
    const admins = new Set((deps.adminIds || adminsNow()).map(String));
    const A = require('./agents');
    for (const n of A.leadAgentNames(agents, admins)) {
      const rec = agents.find((a) => a && a.name === n);
      if (rec && (!rec.owner || admins.has(String(rec.owner)))) return n;
    }
  } catch { /* no lead */ }
  return null;
}

/** The install's facts as plain text (names and counts only; whether an agent belongs to a member is yes or no). */
function installFacts(deps = {}) {
  const lines = [];
  const agents = deps.agents || agentsNow();
  const admins = new Set((deps.adminIds || adminsNow()).map(String));
  const agentLines = agents.filter((a) => a && a.name).map((a) => {
    const member = !!(a.owner && !admins.has(String(a.owner)));
    return `- ${a.name}: ${a.category || 'specialist'}, model ${a.model || 'default'}, owned by a member: ${member ? 'yes' : 'no'}${a.teamGuidance ? `, teamGuidance ${a.teamGuidance}` : ''}`;
  });
  lines.push(`Agents (${agentLines.length}):`, ...agentLines);
  let users = null;
  try { users = deps.users || require('./auth').getAuth().listUsers(); } catch { /* unknown */ }
  if (Array.isArray(users)) {
    const active = users.filter((u) => u && !u.disabled);
    lines.push(`People: ${active.filter((u) => u.role === 'admin').length} admin(s), ${active.filter((u) => u.role !== 'admin').length} member(s).`);
  }
  let mm = deps.memberModels;
  if (!Array.isArray(mm)) { try { mm = require('./member-models').list(); } catch { mm = []; } }
  lines.push(`Models members may choose for their agents: ${mm.length ? mm.join(', ') : 'none'}.`);
  let prov = deps.providers;
  if (!prov) { try { prov = require('./welcome').getWelcome().providerSummary(); } catch { prov = null; } }
  if (prov && typeof prov === 'object') {
    const on = Object.keys(prov).filter((k) => prov[k] === true);
    lines.push(`Providers connected: ${on.length ? on.join(', ') : 'none'}.`);
  }
  let usage = deps.usage;
  if (usage === undefined) { try { usage = require('./team-usage').usageSummary({ hours: 168 }, { agents, adminIds: admins }); } catch { usage = null; } }
  return { agentLines, head: lines.filter((l) => !l.startsWith('- ') && !/^Agents \(/.test(l)), count: agentLines.length, usage: usage || '' };
}

function entryBlock(e) {
  return [`### ${e.title || e.id} (id: ${e.id})`,
    `What it changes: ${e.changes || ''}`, `Benefits: ${e.benefits || ''}`, `Costs: ${e.costs || ''}`,
    `What to check here: ${e.check || ''}`, `When on: ${e.on || ''}`, `When off: ${e.off || ''}`].join('\n');
}

/** The review task's prompt, under 8000 characters: an entry's text is never cut, the facts are shortened to fit. facts: installFacts() or a plain string. */
function reviewPrompt({ entries = [], facts = '' } = {}) {
  const n = entries.length;
  const intro = `An update to My Maestro AI brought ${n} change${n === 1 ? '' : 's'} to how agents behave. Each is switched OFF on this install until its owner decides. Your job: for each change, check what it would mean for THIS install, then write the person you work for one clear message per change: what it is, what it would do for their agents specifically, any cost, and your recommendation (turn it on, leave it off, or turn it on only for some agents, naming them). End each with the link where they decide: [Decide](/changes#<id>). You cannot switch any of them on yourself and must not claim you did. Call for_owner once for this reply. Do not repeat these messages later; the hub's brief keeps a short reminder while they wait.`;
  const extra = entries.some((e) => e && e.id === PROPOSALS_ID) ? `\n\n${PROPOSALS_LINE}` : '';
  const top = `${intro}${extra}\n\nThe changes:\n\n${entries.map(entryBlock).join('\n\n')}\n\nThis install:\n`;
  const fit = (text) => (top + text).length <= MAX_PROMPT;
  if (typeof facts === 'string') {
    const room = Math.max(0, MAX_PROMPT - top.length);
    return top + (facts.length > room ? facts.slice(0, Math.max(0, room - 1)) + (room ? '…' : '') : facts);
  }
  const { agentLines = [], head = [], count = agentLines.length, usage = '' } = facts || {};
  const build = (shown, usageText) => [
    `Agents (${count}):`, ...agentLines.slice(0, shown), ...(shown < agentLines.length ? [`and ${agentLines.length - shown} more`] : []),
    ...head, ...(usageText ? [`Use over the last 7 days:\n${usageText}`] : []),
  ].join('\n');
  let shown = agentLines.length;
  let usageText = usage;
  if (!fit(build(shown, usageText))) usageText = usage.slice(0, 1200);
  while (!fit(build(shown, usageText)) && shown > 0) shown = shown > 10 ? Math.ceil(shown / 2) : shown - 1;
  if (!fit(build(shown, usageText))) usageText = '';
  let out = top + build(shown, usageText);
  if (out.length > MAX_PROMPT) out = top + build(0, '').slice(0, Math.max(0, MAX_PROMPT - top.length));
  return out;
}

function pendingUnreviewed(deps) {
  const st = bc.readState(deps.stateFile);
  if (st.unreadable || st.missing) return [];
  const manifest = bc.manifest(deps.manifestFile);
  return manifest.filter((e) => { const s = st.entries[e.id]; return s && s.state === 'pending' && !s.reviewAt; });
}

function schedulerOf(deps) { return deps.scheduler || require('./scheduled-tasks').getScheduledTasks(); }
function stateOpts(deps) { return { ...(deps.stateFile ? { stateFile: deps.stateFile } : {}), ...(deps.manifestFile ? { manifestFile: deps.manifestFile } : {}) }; }

/**
 * At start-up: ONE review task for the lead when entries are pending and not yet marked reviewed. Returns
 * { lead, taskId, ids } or { none: <reason> }. A restart before the turn ran adds nothing (the entries are marked).
 */
let chain = Promise.resolve();
/** One at a time: two start-up or route calls never both create the same task. */
function serial(fn) { const run = chain.then(fn); chain = run.then(() => {}, () => {}); return run; }

function scheduleReview(deps = {}) { return serial(() => scheduleReviewNow(deps)); }
async function scheduleReviewNow(deps) {
  const o = stateOpts(deps);
  const entries = pendingUnreviewed(o);
  if (!entries.length) return { none: 'nothing to review' };
  const lead = leadName(deps);
  if (!lead) return { none: 'no lead agent' };
  const st = schedulerOf(deps);
  const ids = entries.map((e) => e.id);
  // A review task made just before a crash (not yet marked): reuse it instead of adding a second.
  let existing = null;
  try { existing = st.list('hub', { includeDone: false }).find((t) => t.label === REVIEW_LABEL && t.createdBy === 'hub' && t.agent === lead && ids.every((id) => String(t.prompt).includes(`(id: ${id})`))) || null; } catch { /* none */ }
  let taskId;
  if (existing) taskId = existing.id;
  else {
    const prompt = reviewPrompt({ entries, facts: installFacts(deps) });
    const made = await st.create({ requester: 'hub', agent: lead, when: 'in 2 minutes', label: REVIEW_LABEL, prompt, byNote: REVIEW_NOTE });
    taskId = made.id;
  }
  await bc.markReviewed(ids, taskId, o);
  return { lead, taskId, ids };
}

/**
 * Keep exactly one weekly "team review" task for the lead while 'worker-proposals' is on and the setting workerProposals is
 * 'weekly'; otherwise cancel it. The task id is kept on the 'worker-proposals' state entry (proposalsTask). Returns { action, taskId? }.
 */
function syncProposalsTask(deps = {}) { return serial(() => syncProposalsTaskNow(deps)); }
async function syncProposalsTaskNow(deps) {
  const o = stateOpts(deps);
  const st = bc.readState(o.stateFile);
  if (st.unreadable) return { action: 'skipped', reason: 'unreadable' };
  const entry = st.entries[PROPOSALS_ID];
  let cadence = 'weekly';
  try { cadence = typeof deps.getSetting === 'function' ? deps.getSetting('workerProposals', 'weekly') : require('./settings').getSetting('workerProposals', 'weekly'); } catch { /* default */ }
  const on = !!entry && entry.state === 'on' && cadence !== 'off';
  const lead = on ? leadName(deps) : null;
  const sched = schedulerOf(deps);
  const mine = () => {
    let all = []; try { all = sched.list('hub', { includeDone: false }); } catch { /* none */ }
    return all.filter((t) => t.createdBy === 'hub' && t.label === PROPOSALS_LABEL || (entry && entry.proposalsTask && t.id === entry.proposalsTask));
  };
  const cancel = (t) => { try { sched.action(t.id, 'hub', 'cancel'); } catch { /* already gone */ } };
  const live = mine();
  if (!on || !lead) {
    for (const t of live) cancel(t);
    if (entry && entry.proposalsTask) await bc.setEntryField(PROPOSALS_ID, 'proposalsTask', null, o);
    return { action: live.length ? 'cancelled' : 'none' };
  }
  const keep = live.find((t) => t.agent === lead && (!entry.proposalsTask || t.id === entry.proposalsTask)) || live.find((t) => t.agent === lead);
  for (const t of live) if (t !== keep) cancel(t);
  if (keep) {
    if (entry.proposalsTask !== keep.id) await bc.setEntryField(PROPOSALS_ID, 'proposalsTask', keep.id, o);
    return { action: 'kept', taskId: keep.id };
  }
  const made = await sched.create({ requester: 'hub', agent: lead, when: PROPOSALS_WHEN, label: PROPOSALS_LABEL, prompt: PROPOSALS_PROMPT, byNote: PROPOSALS_NOTE });
  await bc.setEntryField(PROPOSALS_ID, 'proposalsTask', made.id, o);
  return { action: 'created', taskId: made.id, lead };
}

module.exports = { scheduleReview, reviewPrompt, installFacts, syncProposalsTask, leadName, REVIEW_LABEL, PROPOSALS_LABEL, PROPOSALS_PROMPT, PROPOSALS_LINE, PROPOSALS_WHEN, MAX_PROMPT };
