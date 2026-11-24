'use strict';
// Build Team (hub tools team_plan and team_set), modelled on lib/model-offer-switch.
//
// A person presses Build Team on a main agent; the hub starts a turn for the lead (origin kind 'build_team') and the lead
// proposes a team with team_plan. The proposal is shown as a card with one ticked line per change; nothing changes before
// Do it. After Do it the hub applies the lines between agents that already exist and the approved model changes itself, and
// tells the lead which new agents to create (create_agent) and which lines to set afterwards (team_set). A line the person
// approved in THIS turn goes through team_set without a second question; any other line asks once.
//
// Offered only to a flagged lead, only in a turn a signed-in admin started (lib/sdk-chat decides the offer and re-checks it at
// call time). Every change is logged in data/team-changes-log.jsonl ({at, by, action, agent, from, to}, mode 0600).
//
// The facts for the lead's turn (buildFacts / buildMessage) are counts and short labels only, wrapped as data; never message text.

const fs = require('fs');
const path = require('path');
const teams = require('./ui-teams');

const HUB = path.join(__dirname, '..');
const TOOL_PLAN = 'team_plan';
const TOOL_SET = 'team_set';
const NOT_NOW = 'Nothing was changed.';
const CHANGE = 'The person wants changes; ask what to change (ask_user), then call team_plan again.';
const TURN_ENDED = 'The turn ended before the person answered, so nothing changed.';
const NOT_OFFERED = 'This can only be done in a turn the owner started.';
const OPTIONS = ['Do it', 'Change something', 'Not now'];
const LIMITS = { newAgents: 10, lines: 20, models: 15, specialists: 10, setLines: 30 };
const NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const TIERS = ['top', 'strong', 'cost-effective', 'local'];
const ROLES = ['leader', 'worker'];

// Free text from the lead or from display names: plain characters only before it is shown or logged.
const plain = (t, max = 60) => String(t == null ? '' : t).replace(/[^A-Za-z0-9 ._()',:+\/-]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
// Cleans text for a card; a text longer than max ends at a word with "…" so the person never reads a sentence cut mid-word.
const short = (t, max) => {
  const s = String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f`<>]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!max || s.length <= max) return s;
  const cut = s.slice(0, max - 1), sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, '') + '…';
};
const bossKey = (b) => (b == null || b === '' ? null : String(b));

/** The agents list with the lines applied (reports_to null clears the line): the graph as it will be once every line is set. */
function graphWith(list, lines) {
  const to = new Map(lines.map(l => [l.agent, l.reports_to]));
  return (list || []).filter(x => x && x.name).map(x => (to.has(x.name) ? Object.assign({}, x, to.get(x.name) ? { reportsTo: to.get(x.name) } : { reportsTo: undefined }) : x));
}
/**
 * Lines in the order they can be written: lines that clear a boss first, then lines whose boss is a main agent, then lines whose
 * boss is a leader (a boss whose own final line points to a main agent), so a boss is a leader before anyone is put under it.
 * finalGraph: the agents with every line applied. Stable within a rank.
 */
function orderLines(lines, finalGraph) {
  const byName = new Map((finalGraph || []).filter(x => x && x.name).map(x => [x.name, x]));
  const rank = (l) => {
    if (!l.reports_to) return 0;
    const b = byName.get(l.reports_to);
    return !b || teams.isMain(b) ? 1 : 2;
  };
  return lines.map((l, i) => ({ l, i, r: rank(l) })).sort((a, b) => a.r - b.r || a.i - b.i).map(x => x.l);
}

function createTeamPlan({
  agents = () => { try { return require('./agents').getAgentsSync() || []; } catch { return []; } },
  // Who an agent is (lib/agents.js agentIdentity: its box id, or its name for an agent from before box ids), read from the
  // agents file itself: the list above is the cached view, which carries no box id. null when there is no such agent.
  identitiesOf = (names) => { try { return require('./agents').agentIdentities(names); } catch { return new Map(); } },
  adminIds = () => { try { return new Set(require('./auth').getAuth().admins().map(u => String(u.id))); } catch { return new Set(); } },
  isVirtual = (name) => { try { return require('./temporal-workers').isVirtual(name); } catch { return /^tw-/.test(String(name)); } },
  availableModels = async () => require('./agents').availableModelsNow(),
  resolveModel = (m, avail) => require('./temporal-workers').resolveModel(m, avail),
  validName = (n) => { try { return require('./agents').isValidAgentName(n); } catch { return NAME_RE.test(n); } },
  setModel = async (name, model) => require('./agents').setAgentModel(name, model),
  updateField = async (name, fields, ctx) => require('./agents').updateAgentField(name, fields, ctx),
  notifyTeam = (text) => { try { return require('./push').getPush().notify({ title: 'Team changed', body: text, tag: 'team-change' }, { adminsOnly: true, kind: 'other' }); } catch { return null; } },
  published = (name, changed) => {
    try {
      const a = (require('./agents').getAgentsSync() || []).find(x => x && x.name === name);
      if (!a) return;
      require('./hub-events').events.publish('agent_updated', { agent: name, model: a.model || null, display: a.display || null, icon: a.icon || null, category: a.category || null, autoModel: !!a.autoModel, effort: a.effort || 'default', changed });
    } catch { /* events are best effort */ }
  },
  push = () => require('./push').getPush(),
  auditFile = path.join(HUB, 'data', 'team-changes-log.jsonl'),
  now = Date.now,
} = {}) {
  const get = (x) => (typeof x === 'function' ? x() : x);
  const approved = new Map();   // lead -> { lead, turnId, primary, items } (only the ticked items)

  function audit(rec) {
    fs.mkdirSync(path.dirname(auditFile), { recursive: true });
    fs.appendFileSync(auditFile, JSON.stringify({ at: new Date(now()).toISOString(), ...rec }) + '\n', { mode: 0o600 });
    try { fs.chmodSync(auditFile, 0o600); } catch { /* best effort */ }
  }
  function tryAudit(rec) { try { audit(rec); return true; } catch (e) { console.warn(`[team-plan] log write failed: ${e.message}`); return false; } }
  const allowedNow = (stillAllowed) => { try { return typeof stillAllowed === 'function' && stillAllowed() === true; } catch { return false; } };
  const memberOwned = (a) => { const o = a && a.owner ? String(a.owner) : ''; return !!o && !get(adminIds).has(o); };
  /**
   * The error for the first existing agent (not in `skip`) whose line passes on the agents as they are now (`before`) but no
   * longer on `graph`, or null. A line that was already invalid is not this plan's doing and never blocks it.
   */
  function brokenOther(graph, skip, admins, before) {
    const now = Array.isArray(before) ? before : [];
    for (const x of graph) {
      if (!x || !x.name || skip.has(x.name) || teams.isMain(x) || typeof x.reportsTo !== 'string' || !x.reportsTo) continue;
      const why = teams.checkReportsTo(x.name, x.reportsTo, graph, admins);
      if (why && teams.checkReportsTo(x.name, x.reportsTo, now, admins)) continue;
      if (why) return `line for ${x.name} would break: it reports to ${x.reportsTo}, which ${why}. Add a line for ${x.name} (a new boss or nobody).`;
    }
    return null;
  }
  /**
   * Who each named agent is right now (its box id, or its name for an agent from before box ids, as lib/agents.js
   * identityOf): taken when the person is asked and compared after the answer, so a rename, or an agent deleted and made
   * again under the same name while the question was open, never receives a line meant for the one that was shown.
   */
  function identities(names) {
    const want = [...new Set(names.filter(Boolean))];
    let got = new Map();
    try { got = identitiesOf(want) || new Map(); } catch { got = new Map(); }
    const out = new Map();
    for (const n of want) out.set(n, got.get(n) || null);
    return out;
  }
  function changedSince(snap) {
    const now = identities([...snap.keys()]);
    for (const [n, id] of snap) if (now.get(n) !== id) return n;
    return null;
  }
  /** The first of `names` that the snapshot `ids` knows and that is no longer the same agent, or null. Run right before a
   *  write, with no await in between, so the write reaches only the agent the person was shown. */
  function replacedOf(ids, names) {
    if (!ids) return null;
    const known = names.filter(n => n && ids.has(n));
    if (!known.length) return null;
    const now = identities(known);
    for (const n of known) if (now.get(n) !== ids.get(n)) return n;
    return null;
  }
  const REPLACED = (n) => `${plain(n, 64)} was renamed, removed or made again since the person was asked`;
  /**
   * Applies lines in passes: each pass tries every line not yet applied; a refused line is retried in the next pass, until a pass
   * applies nothing new. items: [{agent, reports_to}] in write order. -> { done: [item], failed: [{item, error}] }
   * A write that would break another agent's current line (the store would clear it in the same save) waits for a later pass,
   * when that agent has moved: no write ever clears a line, so a batch stopped half-way never leaves anyone without a boss
   * they were not given.
   */
  async function applyPasses(by, items, ended, ids = null) {
    let pending = items.slice();
    const done = [], failed = new Map();
    while (pending.length) {
      const next = []; let progress = false;
      for (const it of pending) {
        if (ended()) { failed.set(it, 'the turn ended first'); continue; }
        const nowList = get(agents) || [];
        const breaks = brokenOther(graphWith(nowList, [it]), new Set([it.agent]), get(adminIds), nowList);
        if (breaks) { failed.set(it, breaks); next.push(it); continue; }
        const gone = replacedOf(ids, [it.agent, it.reports_to]);
        if (gone) { failed.set(it, REPLACED(gone)); continue; }
        const r = await applyLine(by, it.agent, it.reports_to);
        if (r.ok) { done.push(it); failed.delete(it); progress = true; } else { failed.set(it, r.error); next.push(it); }
      }
      pending = next;
      if (!progress) break;
    }
    return { done, failed: items.filter(it => failed.has(it)).map(it => ({ item: it, error: failed.get(it) })) };
  }

  // ── the approved plan of a turn ──
  /** The approved items for this lead, only while it is still the turn the plan was approved in; else dropped and null. */
  function approvedFor(lead, turnId) {
    const p = approved.get(lead);
    if (!p) return null;
    if (!turnId || p.turnId !== turnId) { approved.delete(lead); return null; }
    return p;
  }
  function drop(lead) { approved.delete(lead); }

  // ── validation ──
  /** Returns { error } or { plan } (clean copy: lists of items with ids). Reads the agent list fresh. */
  async function validate(args, lead) {
    const a = args && typeof args === 'object' ? args : {};
    const list = (get(agents) || []).filter(x => x && x.name);
    const byName = new Map(list.map(x => [x.name, x]));
    const existing = (n) => { const r = byName.get(n); return r && !isVirtual(n) ? r : null; };
    const str = (v) => (typeof v === 'string' ? v.trim() : '');
    const arr = (v, max, what) => {
      if (v == null) return [];
      if (!Array.isArray(v)) return { error: `${what} must be a list.` };
      if (v.length > max) return { error: `${what}: at most ${max} entries.` };
      return v;
    };
    const primary = str(a.for);
    const prec = existing(primary);
    if (!prec) return { error: `"for" must be the name of an existing agent (${primary ? `no agent named "${plain(primary)}"` : 'missing'}).` };
    if (!teams.isMain(prec)) return { error: `${primary} is not a main agent; a team is built for a main agent.` };
    const summary = short(a.summary, 600);
    if (!summary) return { error: 'summary: say in a few words what you propose (or that no team is needed).' };

    const na = arr(a.new_agents, LIMITS.newAgents, 'new_agents'); if (na.error) return na;
    const ln = arr(a.lines, LIMITS.lines, 'lines'); if (ln.error) return ln;
    const mc = arr(a.model_changes, LIMITS.models, 'model_changes'); if (mc.error) return mc;
    const sp = arr(a.specialists, LIMITS.specialists, 'specialists'); if (sp.error) return sp;
    let avail = null;
    const modelCheck = async (m, what) => {
      if (!str(m)) return { error: `${what}: a model id is needed.` };
      if (avail === null) { try { avail = (await get(availableModels)) || []; } catch { avail = []; } }
      const r = resolveModel(str(m), avail);
      return r && r.model ? { model: r.model } : { error: `${what}: ${(r && r.error) || 'model not usable here'}` };
    };

    const newAgents = [], newNames = new Set();
    for (const [i, n] of na.entries()) {
      const w = `new_agents[${i}]`;
      if (!n || typeof n !== 'object') return { error: `${w} must be an object.` };
      const name = str(n.name);
      if (!NAME_RE.test(name) || !validName(name)) return { error: `${w}: "${plain(name)}" is not a usable agent name (lowercase letters, digits and _, starting with a letter).` };
      if (byName.has(name)) return { error: `${w}: an agent named ${name} already exists.` };
      if (newNames.has(name)) return { error: `${w}: ${name} is listed twice.` };
      if (!ROLES.includes(n.role)) return { error: `${w}: role must be leader or worker.` };
      if (!TIERS.includes(n.tier)) return { error: `${w}: tier must be one of ${TIERS.join(', ')}.` };
      const boss = str(n.reports_to);
      if (!boss) return { error: `${w}: reports_to is needed (a main agent, or a team leader).` };
      const m = await modelCheck(n.model, w + '.model'); if (m.error) return m;
      newNames.add(name);
      newAgents.push({ name, display: plain(n.display, 40) || (name[0].toUpperCase() + name.slice(1)), role: n.role, reports_to: boss, tier: n.tier, model: m.model, why: short(n.why, 200) });
    }
    for (const n of newAgents) if (!existing(n.reports_to) && !newNames.has(n.reports_to)) return { error: `new agent ${n.name}: reports_to "${plain(n.reports_to)}" is not an existing agent or a new one in this plan.` };

    const lines = [], seen = new Set();
    for (const [i, l] of ln.entries()) {
      const w = `lines[${i}]`;
      if (!l || typeof l !== 'object') return { error: `${w} must be an object.` };
      const agent = str(l.agent);
      if (newNames.has(agent)) return { error: `${w}: ${agent} is a new agent; put its line in new_agents.reports_to.` };
      if (!existing(agent)) return { error: `${w}: there is no agent named "${plain(agent)}".` };
      if (seen.has(agent)) return { error: `${w}: ${agent} has two lines.` };
      seen.add(agent);
      const boss = bossKey(l.reports_to == null ? null : str(l.reports_to));
      if (boss && !existing(boss) && !newNames.has(boss)) return { error: `${w}: there is no agent named "${plain(boss)}".` };
      lines.push({ agent, reports_to: boss, why: short(l.why, 200) });
    }
    for (const n of newAgents) if (seen.has(n.name)) return { error: `${n.name} has two lines.` };

    // Every line must pass the same rules as a PATCH, on the graph that holds the new agents (category worker) and every line.
    const owner = prec.owner ? String(prec.owner) : null;
    let graph = list.map(x => Object.assign({}, x));
    for (const n of newAgents) graph.push({ name: n.name, display: n.display, category: 'worker', owner, reportsTo: n.reports_to });
    for (const l of lines) graph = graph.map(x => (x.name === l.agent ? Object.assign({}, x, l.reports_to ? { reportsTo: l.reports_to } : { reportsTo: undefined }) : x));
    const admins = get(adminIds);
    for (const n of newAgents) { const why = teams.checkReportsTo(n.name, n.reports_to, graph, admins); if (why) return { error: `new agent ${n.name}: ${why}.` }; }
    for (const l of lines) { const why = l.reports_to ? teams.checkReportsTo(l.agent, l.reports_to, graph, admins) : null; if (why) return { error: `line for ${l.agent}: ${why}.` }; }
    // No silent cascade: an existing line that is not part of the plan must still hold on the final graph.
    const brokenErr = brokenOther(graph, new Set([...seen, ...newNames]), admins, get(agents) || []); if (brokenErr) return { error: brokenErr };

    const modelChanges = [], mseen = new Set();
    for (const [i, c] of mc.entries()) {
      const w = `model_changes[${i}]`;
      if (!c || typeof c !== 'object') return { error: `${w} must be an object.` };
      const agent = str(c.agent);
      const rec = existing(agent);
      if (!rec) return { error: `${w}: there is no agent named "${plain(agent)}".` };
      if (agent === lead) return { error: `${w}: your own model can't change while you are answering; mention it in your summary and the person can switch it on your settings page.` };
      if (memberOwned(rec)) return { error: `${w}: ${agent} belongs to a member; only its owner changes its model.` };
      if (mseen.has(agent)) return { error: `${w}: ${agent} is listed twice.` };
      mseen.add(agent);
      const m = await modelCheck(c.model, w + '.model'); if (m.error) return m;
      if (m.model === rec.model) return { error: `${w}: ${agent} already uses ${m.model}.` };
      modelChanges.push({ agent, model: m.model, from: String(rec.model || ''), why: short(c.why, 200) });
    }
    const specialists = [];
    for (const [i, s] of sp.entries()) {
      const w = `specialists[${i}]`;
      if (!s || typeof s !== 'object') return { error: `${w} must be an object.` };
      const agent = str(s.agent);
      if (!existing(agent)) return { error: `${w}: there is no agent named "${plain(agent)}".` };
      specialists.push({ agent, why: short(s.why, 200) });
    }
    const dispOf = (n) => { const x = byName.get(n); const nn = newAgents.find(y => y.name === n); return plain((nn && nn.display) || (x && x.display) || n, 40) || n; };

    // The checklist: one item per new agent, line, model change and specialist note (ids n1.., l1.., m1.., s1..).
    const items = [];
    newAgents.forEach((n, i) => items.push({ id: `n${i + 1}`, kind: 'new_agent', agent: n.name, display: n.display, role: n.role, reports_to: n.reports_to, tier: n.tier, model: n.model,
      label: `Create ${n.display} (${n.name}): ${n.role} under ${dispOf(n.reports_to)}`, detail: short(`${n.tier} tier, ${n.model}${n.why ? '. ' + n.why : ''}`, 300) }));
    lines.forEach((l, i) => items.push({ id: `l${i + 1}`, kind: 'line', agent: l.agent, reports_to: l.reports_to,
      label: l.reports_to ? `${dispOf(l.agent)} reports to ${dispOf(l.reports_to)}` : `${dispOf(l.agent)} reports to nobody`, detail: l.why }));
    modelChanges.forEach((c, i) => items.push({ id: `m${i + 1}`, kind: 'model', agent: c.agent, model: c.model, from: c.from,
      label: `${dispOf(c.agent)}: change model to ${c.model}`, detail: short(`from ${c.from || 'its current model'}${c.why ? '. ' + c.why : ''}`, 300) }));
    specialists.forEach((s, i) => items.push({ id: `s${i + 1}`, kind: 'specialist', agent: s.agent,
      label: `${dispOf(s.agent)} works with this team as a shared specialist`, detail: s.why }));
    return { plan: { primary, display: dispOf(primary), summary, items, newAgents, lines, modelChanges, specialists } };
  }

  // ── applying ──
  function ctxFor() { return { isOwner: false, userId: '', notifyTeam: (text) => notifyTeam(text) }; }

  async function applyLine(by, agent, boss) {
    const rec = (get(agents) || []).find(x => x && x.name === agent);
    const from = rec && rec.reportsTo ? rec.reportsTo : null;
    const r = await updateField(agent, { reportsTo: boss || '' }, ctxFor());
    if (!r || r.success !== true) return { ok: false, error: (r && r.error) || 'refused' };
    tryAudit({ by, action: 'reports_to', agent, from, to: boss || null });
    try { published(agent, ['reportsTo']); } catch { /* best effort */ }
    return { ok: true };
  }

  async function applyModel(by, agent, to, display) {
    const rec = (get(agents) || []).find(x => x && x.name === agent);
    if (!rec) return { ok: false, error: 'no such agent' };
    if (memberOwned(rec)) return { ok: false, error: 'it belongs to a member' };
    const from = String(rec.model || '');
    if (from === to) return { ok: true, same: true, from };
    const r = await setModel(agent, to);
    if (!r || r.success !== true) return { ok: false, error: (r && r.error) || 'refused' };
    if (!tryAudit({ by, action: 'model', agent, from, to })) { /* done; the log line is best effort once the change is made */ }
    try { published(agent, ['model']); } catch { /* best effort */ }
    try {
      const res = get(push).notify({
        title: 'Model changed',
        body: `Model changed for ${plain(display || agent, 40) || agent}: ${from} -> ${to}. To undo it, choose ${from} again on its settings page.`,
        url: `/agent-settings.html?agent=${encodeURIComponent(agent)}`,
      }, { adminsOnly: true, kind: 'security' });
      if (res && typeof res.catch === 'function') res.catch(() => {});
    } catch { /* a failed notice never undoes the change */ }
    return { ok: true, from };
  }

  // ── team_plan ──
  /**
   * lead: the agent running the turn; turnOf(): the turn id now (turnRegistry), ask(args): the plan card ->
   * { choice, checked } | text; stillAllowed(): the owner-turn offer still holds; forUser: the admin who started the turn.
   */
  async function runPlan(args, { lead, turnOf, ask, stillAllowed, forUser = null, forPrimary = null } = {}) {
    const turnId = typeof turnOf === 'function' ? turnOf() : null;
    if (!lead || !turnId || !allowedNow(stillAllowed)) return NOT_OFFERED;
    if (typeof forPrimary === 'string' && forPrimary) {
      const asked = args && typeof args === 'object' && typeof args.for === 'string' ? args.for.trim() : '';
      if (asked !== forPrimary) return `The plan was not shown. This Build Team turn is for ${plain(forPrimary, 40)}; propose a team for that agent only.`;
    }
    // Who every agent is before the plan is judged: an agent replaced while it is being judged (the model lookup awaits)
    // must never be shown on the card under the old agent's name.
    const before = identities((get(agents) || []).map(a => a && a.name).filter(Boolean));
    const v = await validate(args, lead);
    if (v.error) return `The plan was not shown. ${v.error} Fix it and call team_plan again.`;
    const p = v.plan;
    // Nothing to approve ("no team needed"): no card; the lead says it in its own reply.
    if (!p.items.length) return `Nothing to approve: no changes were proposed. Tell the person your summary (${p.summary.slice(0, 200)}) in your reply.`;
    const parts = [];
    if (p.newAgents.length) parts.push(`${p.newAgents.length} new agent${p.newAgents.length === 1 ? '' : 's'}`);
    if (p.lines.length) parts.push(`${p.lines.length} reporting line${p.lines.length === 1 ? '' : 's'}`);
    if (p.modelChanges.length) parts.push(`${p.modelChanges.length} model change${p.modelChanges.length === 1 ? '' : 's'}`);
    if (p.specialists.length) parts.push(`${p.specialists.length} specialist note${p.specialists.length === 1 ? '' : 's'}`);
    const leadRec = (get(agents) || []).find(x => x && x.name === lead);
    const question = short(`${plain((leadRec && leadRec.display) || lead, 40) || lead} proposes for ${p.display}: ${p.summary}${parts.length ? ` (${parts.join(', ')})` : ' (no team needed)'}. Untick anything you do not want, then choose.`, 900);
    const checklist = p.items.map(i => ({ id: i.id, label: short(i.label, 160), detail: short(i.detail, 300) }));
    let got;
    // Every existing agent the card names must be identified; a planned new agent is bound when the lead creates it.
    const proposed = new Set(p.newAgents.map(x => x.name));
    const required = new Set([p.primary, ...p.items.flatMap(i => [i.agent, i.reports_to])].filter(n => n && !proposed.has(n)));
    const shown = new Map();
    for (const n of required) {
      const id = before.get(n);
      if (!id) return `The plan was not shown: could not verify ${plain(n, 64)}. Call team_plan again.`;
      shown.set(n, id);
    }
    const movedBeforeCard = changedSince(shown);
    if (movedBeforeCard) return `The plan was not shown: ${plain(movedBeforeCard, 64)} changed while it was being prepared. Call team_plan again.`;
    try { got = await ask({ question, options: OPTIONS, header: 'Team plan', checklist, adminOnly: true, forUser, allow_skip: false }); } catch { got = null; }
    const choice = got && typeof got === 'object' ? got.choice : null;
    if (choice === 'Change something') return CHANGE;
    if (choice !== 'Do it') return NOT_NOW;
    // Do it with nothing ticked is the same as Not now.
    const itemIds = new Set(p.items.map(i => i.id));
    if (!(Array.isArray(got.checked) ? got.checked : []).some(c => itemIds.has(String(c)))) return NOT_NOW;
    if (!allowedNow(stillAllowed) || turnOf() !== turnId) return TURN_ENDED;
    // The agents may have changed while the person was answering: judged again, nothing applied when it no longer holds.
    const moved = changedSince(shown);
    if (moved) return `Nothing was changed: ${plain(moved, 64)} was renamed, removed or made again while the person was answering. Call team_plan again.`;
    const again = await validate(args, lead);
    if (again.error) return `Things changed while the person was answering, so nothing was applied. ${again.error}`;
    if (!allowedNow(stillAllowed) || turnOf() !== turnId) return TURN_ENDED;
    const ticked = new Set(Array.isArray(got.checked) ? got.checked.map(String) : []);
    const all = again.plan.items;
    const no = all.filter(i => !ticked.has(i.id));
    // The selection must stand on its own: the ticked items alone are judged as a plan, on the agents as they are now.
    const tk = all.filter(i => ticked.has(i.id)), ap = again.plan;
    const keep = (kind) => new Set(tk.filter(i => i.kind === kind).map(i => i.id));
    const kn = keep('new_agent'), kl = keep('line'), km = keep('model'), ks = keep('specialist');
    const subArgs = {
      for: ap.primary, summary: ap.summary,
      new_agents: ap.newAgents.filter((_, x) => kn.has(`n${x + 1}`)),
      lines: ap.lines.filter((_, x) => kl.has(`l${x + 1}`)),
      model_changes: ap.modelChanges.filter((_, x) => km.has(`m${x + 1}`)),
      specialists: ap.specialists.filter((_, x) => ks.has(`s${x + 1}`)),
    };
    const sub = await validate(subArgs, lead);
    if (sub.error) return `The person's selection does not stand on its own: ${sub.error} Nothing was changed. Ask the person what to change (ask_user), then call team_plan again.`;
    if (!allowedNow(stillAllowed) || turnOf() !== turnId) return TURN_ENDED;
    const yes = sub.plan.items;
    approved.set(lead, { lead, turnId, primary: p.primary, items: yes.map(i => ({ ...i })), ids: shown });

    const cur = get(agents) || [];
    const exists = (n) => cur.some(x => x && x.name === n);
    const done = [], failed = [], later = [], create = [], notes = [];
    const lineItems = yes.filter(i => i.kind === 'line');
    const ordered = orderLines(lineItems.map(i => ({ agent: i.agent, reports_to: i.reports_to, item: i })), graphWith(cur, lineItems)).map(x => x.item);
    const of = (k) => yes.filter(i => i.kind === k);
    const work = [...of('new_agent'), ...ordered, ...of('model'), ...of('specialist')];
    // Lines go in passes: a line refused in an intermediate state is retried once the others are in.
    for (const i of ordered) if (i.reports_to && !exists(i.reports_to)) later.push(i);   // the boss is a new agent: set with team_set once it exists
    const now = ordered.filter(i => !later.includes(i));
    const lr = await applyPasses(lead, now, () => !allowedNow(stillAllowed) || turnOf() !== turnId, shown);
    for (const i of lr.done) done.push(`${i.agent} now reports to ${i.reports_to || 'nobody'}`);
    for (const f of lr.failed) failed.push(`${f.item.label}: ${f.error}`);
    for (const i of work) {
      if (i.kind === 'specialist') { notes.push(`${i.agent}${i.detail ? ': ' + i.detail : ''}`); continue; }
      if (i.kind === 'line') continue;
      if (!allowedNow(stillAllowed) || turnOf() !== turnId) { failed.push(`${i.label}: the turn ended first`); continue; }
      if (i.kind === 'new_agent') { create.push(i); continue; }
      if (i.kind === 'model') {
        const gone = replacedOf(shown, [i.agent]);
        if (gone) { failed.push(`${i.label}: ${REPLACED(gone)}`); continue; }
        const r = await applyModel(lead, i.agent, i.model, i.agent);
        (r.ok ? done : failed).push(r.ok ? `${i.agent} model ${r.from} -> ${i.model}` : `${i.label}: ${r.error}`);
      }
    }
    const out = [`The person approved the plan (${yes.filter(i => i.kind !== 'specialist').length} of ${all.filter(i => i.kind !== 'specialist').length} items ticked).`];
    out.push(done.length ? `Applied now:\n${done.map(x => '- ' + x).join('\n')}` : 'Applied now: nothing.');
    if (failed.length) out.push(`Could not apply:\n${failed.map(x => '- ' + x).join('\n')}`);
    if (no.length) out.push(`Left unticked (not to be done):\n${no.map(i => '- ' + i.label).join('\n')}`);
    if (create.length) out.push(`New agents to create with create_agent (then set each line with team_set, exactly as approved):\n${create.map(i => `- ${i.agent} (${i.display}): ${i.role}, model ${i.model}, tier ${i.tier}, reports_to ${i.reports_to}`).join('\n')}`);
    if (later.length) out.push(`Lines to set with team_set once their boss exists:\n${later.map(i => `- ${i.agent} reports_to ${i.reports_to}`).join('\n')}`);
    if (notes.length) out.push(`Shared specialists for this team (information):\n${notes.map(x => '- ' + x).join('\n')}`);
    return out.join('\n\n');
  }

  // ── team_set ──
  /** lines: [{agent, reports_to|null}], at most 30. confirm(question, yesLabel) -> boolean. */
  async function runSet(args, { lead, turnOf, confirm, stillAllowed } = {}) {
    const turnId = typeof turnOf === 'function' ? turnOf() : null;
    if (!lead || !turnId || !allowedNow(stillAllowed)) return NOT_OFFERED;
    const raw = args && Array.isArray(args.lines) ? args.lines : null;
    if (!raw || !raw.length) return 'lines: give a list of {agent, reports_to} (reports_to may be null).';
    if (raw.length > LIMITS.setLines) return `lines: at most ${LIMITS.setLines} at a time.`;
    const lines = [];
    for (const [i, l] of raw.entries()) {
      if (!l || typeof l !== 'object' || typeof l.agent !== 'string' || !l.agent.trim()) return `lines[${i}]: agent is needed.`;
      if (l.reports_to != null && typeof l.reports_to !== 'string') return `lines[${i}]: reports_to must be a name or null.`;
      const agent = l.agent.trim();
      if (isVirtual(agent)) return `lines[${i}]: ${plain(agent)} is a temporary worker.`;
      if (lines.some(x => x.agent === agent)) return `lines[${i}]: ${plain(agent, 64)} is listed twice.`;
      lines.push({ agent, reports_to: bossKey(l.reports_to == null ? null : l.reports_to.trim()) });
    }
    // A line that would break another existing line is refused before anything is asked or applied.
    const brokenSet = brokenOther(graphWith(get(agents), lines), new Set(lines.map(l => l.agent)), get(adminIds), get(agents) || []);
    if (brokenSet) return brokenSet;
    // A plan from another turn or another agent never counts (approvedFor drops one whose turn is over).
    let setShown = null;
    const plan = approvedFor(lead, turnId);
    // Who the named agents are now: a line rides on the approval only while each is the agent that was bound (a planned agent
    // deleted and made again is asked about, not stuck).
    const nowIds = identities(lines.flatMap(l => [l.agent, l.reports_to]));
    // A line rides on the approval only when every agent it names was identified (on the card, or created by the lead
    // in this turn): any other line is put to the person.
    const match = (l) => !!plan && plan.items.some(i => (i.kind === 'line' || i.kind === 'new_agent') && i.agent === l.agent && bossKey(i.reports_to) === l.reports_to)
      && [l.agent, l.reports_to].filter(Boolean).every(n => plan.ids && plan.ids.has(n) && plan.ids.get(n) === nowIds.get(n));
    const free = lines.filter(match), ask = lines.filter(l => !match(l));
    let allowAsk = false;
    if (ask.length) {
      // The question lists every asked line and is never cut: when it would not fit, nothing is asked or applied.
      const qOf = (n) => { const s = ask.slice(0, n); return `${plain(lead, 40)} wants to set ${s.length === 1 ? 'a reporting line' : `${s.length} reporting lines`}: ${s.map(l => `${plain(l.agent, 64)} reports to ${l.reports_to ? plain(l.reports_to, 64) : 'nobody'}`).join('; ')}. These were not in a plan you approved.`; };
      const q = qOf(ask.length);
      if (q.length > 900) {
        let fit = 1;
        while (fit < ask.length && qOf(fit + 1).length <= 900) fit++;
        return `Too many lines to confirm in one question: send at most ${fit} lines that are not in the approved plan per team_set call.`;
      }
      setShown = identities(lines.flatMap(l => [l.agent, l.reports_to]));
      try { allowAsk = typeof confirm === 'function' && (await confirm(q, 'Set them')) === true; } catch { allowAsk = false; }
      if (allowAsk && (!allowedNow(stillAllowed) || turnOf() !== turnId)) return TURN_ENDED;
    }
    const orderedAll = orderLines(lines, graphWith(get(agents), lines));
    const go = orderedAll.filter(l => match(l) || allowAsk);
    // Judged again on the agents as they are now (the question may have been open while someone else changed them): every line
    // that goes through must hold on the final graph, and together they must not break a line outside them (declined lines
    // included, they stay as they are). Otherwise nothing is written, so no line is half-moved or cleared by a cascade.
    {
      // lines put to the person are judged by what the question showed; lines riding on the approval by the plan's ids
      const moved = (setShown && changedSince(setShown)) || (plan && replacedOf(plan.ids, go.filter(match).flatMap(l => [l.agent, l.reports_to])));
      if (moved) return `Nothing was set: ${plain(moved, 64)} was renamed, removed or made again while the question was open. Call team_set again.`;
      const nowList = get(agents) || [], admins = get(adminIds), final = graphWith(nowList, go);
      for (const l of go) {
        if (!nowList.some(x => x && x.name === l.agent)) return `Nothing was set: there is no agent named ${plain(l.agent, 64)} (renamed or deleted meanwhile?). Call team_set again.`;
        if (!l.reports_to) continue;
        const why = teams.checkReportsTo(l.agent, l.reports_to, final, admins);
        if (why) return `Nothing was set: the line for ${plain(l.agent, 64)} does not hold (${why}). Fix it and call team_set again.`;
      }
      const b = brokenOther(final, new Set(go.map(l => l.agent)), admins, nowList);
      if (b) return `Nothing was set: ${go.length < orderedAll.length ? 'the person did not confirm every line, and the rest alone' : 'these lines'} would break another. ${b}`;
    }
    const ids = new Map([...((plan && plan.ids) || new Map()), ...(setShown || new Map())]);
    const res = await applyPasses(lead, go, () => !allowedNow(stillAllowed) || turnOf() !== turnId, ids);
    const okSet = new Set(res.done), bad = new Map(res.failed.map(f => [f.item, f.error]));
    const out = orderedAll.map(l => {
      if (!go.includes(l)) return `- ${l.agent}: left as is (the person did not confirm)`;
      if (okSet.has(l)) return `- ${l.agent}: now reports to ${l.reports_to || 'nobody'}`;
      const e = bad.get(l);
      return e === 'the turn ended first' ? `- ${l.agent}: not set, the turn ended` : `- ${l.agent}: not set (${e})`;
    });
    return `Reporting lines (${free.length} approved in the plan, ${ask.length} asked):\n${out.join('\n')}`;
  }

  /**
   * The lead created one of the plan's new agents (create_agent, this turn): record who it is now, so a later team_set line
   * for it uses the approval only while it is that same agent. Called right after a successful create.
   */
  function noteCreated(lead, turnId, expectedPlan, name, createdIdentity) {
    const plan = approved.get(lead);
    // Write once, for the plan that was approved when the create began, with the identity of the record the store saved.
    if (!plan || plan !== expectedPlan || plan.turnId !== turnId || !plan.ids || !createdIdentity || plan.ids.has(name)
      || !plan.items.some(i => i.kind === 'new_agent' && i.agent === name)) return false;
    plan.ids.set(name, createdIdentity);
    return true;
  }

  return { validate, runPlan, runSet, approvedFor, drop, noteCreated, audit, applyLine, applyModel, _approved: approved };
}

const PLAN_PARAMS = {
  type: 'object',
  properties: {
    for: { type: 'string', description: 'The main agent the team is for (its name)' },
    summary: { type: 'string', description: 'The proposal in a few lines (at most 600 characters), or why no team is needed' },
    new_agents: { type: 'array', description: 'Agents to create (names are free, lowercase)', items: { type: 'object', properties: {
      name: { type: 'string' }, display: { type: 'string' }, role: { type: 'string', enum: ROLES }, reports_to: { type: 'string', description: 'A main agent or a team leader (existing or new in this plan)' },
      tier: { type: 'string', enum: TIERS }, model: { type: 'string', description: 'A model id from your hub brief' }, why: { type: 'string', description: 'One sentence, at most 200 characters' } }, required: ['name', 'role', 'reports_to', 'tier', 'model'] } },
    lines: { type: 'array', description: 'Reporting lines of agents that already exist (reports_to null clears the line)', items: { type: 'object', properties: { agent: { type: 'string' }, reports_to: { type: ['string', 'null'] }, why: { type: 'string', description: 'One sentence, at most 200 characters' } }, required: ['agent'] } },
    model_changes: { type: 'array', description: 'Models to change on existing agents', items: { type: 'object', properties: { agent: { type: 'string' }, model: { type: 'string' }, why: { type: 'string', description: 'One sentence, at most 200 characters' } }, required: ['agent', 'model'] } },
    specialists: { type: 'array', description: 'Existing shared specialists this team should use', items: { type: 'object', properties: { agent: { type: 'string' }, why: { type: 'string', description: 'One sentence, at most 200 characters' } }, required: ['agent'] } },
  },
  required: ['for', 'summary'],
};
const SET_PARAMS = {
  type: 'object',
  properties: { lines: { type: 'array', description: 'Up to 30 lines', items: { type: 'object', properties: { agent: { type: 'string' }, reports_to: { type: ['string', 'null'] } }, required: ['agent'] } } },
  required: ['lines'],
};
const PLAN_TOOL = {
  name: TOOL_PLAN,
  description: 'Build Team (follow TEAM-PLAYBOOK.md): submit the team you propose for a main agent. The person sees a card with every line ticked and chooses Do it, Change something or Not now; nothing changes before Do it. Afterwards you are told what was applied, and which new agents to create with create_agent.',
  parameters: PLAN_PARAMS,
};
const SET_TOOL = {
  name: TOOL_SET,
  description: 'Build Team: set reporting lines (agent reports to boss, or null for nobody), at most 30. Lines the person approved in this turn\'s plan are set at once; any other line asks the person first.',
  parameters: SET_PARAMS,
};

// ── The facts for the lead's Build Team turn (counts and short labels only; never any message text) ──
const FACTS_MAX = 6000;
const DAY_MS = 86400000;

// ── Working history: who a main agent already works with (counts only) ──
const SHARE_MIN = 0.7;     // a main agent's share of an agent's calls that makes the agent its own
const CALLS_MIN = 3;       // fewer calls than this is too little history to place an agent
const HISTORY_DAYS = 30;   // the window
const REVIEWER_RE = /review|challeng|audit|critic/i;

const toMs = (v) => (typeof v === 'number' ? v : Date.parse(v));
const isMainAgent = (a) => { try { return teams.isMain(a); } catch { return false; } };
const folderRoots = (a) => {
  const home = require('os').homedir(), tmp = require('os').tmpdir();
  const skip = new Set([path.parse(home).root, path.resolve(home), path.resolve(tmp), '/tmp']);
  const roots = a && a.policy && Array.isArray(a.policy.roots) ? a.policy.roots : [];
  return roots.map(r => path.resolve(String(r).replace(/^~(?=\/|$)/, home))).filter(r => !skip.has(r));
};
const teamFolderOf = (a) => { try { return require('./tool-policy').teamFolderOf(a); } catch { return null; } };

/**
 * workingHistory({ main, agentsList, handOffs, consultsOf, since }) -> [{ name, from_main: { hand_offs, consults }, total_calls, share, mains_using }]
 * for every other agent. handOffs: [{ caller, target, createdAt }]; consultsOf(agent) -> { target: n } over the window
 * (default: lib/transcript consultTargetsSince). total_calls counts hand-offs to the agent and consults of it from ALL agents in the window;
 * share is the main agent's part of that, 2 decimals; mains_using is how many main agents called it at least once.
 */
function workingHistory({ main, agentsList, handOffs = [], consultsOf = null, since, now = Date.now() } = {}) {
  const list = (agentsList || []).filter(a => a && a.name && !/^tw-/.test(a.name));
  const mainName = main && typeof main === 'object' ? main.name : String(main || '');
  const sinceIso = since || new Date(now - HISTORY_DAYS * DAY_MS).toISOString();
  const sinceMs = toMs(sinceIso);
  const consults = typeof consultsOf === 'function' ? consultsOf : ((agent) => {
    try { return require('./transcript').getTranscript().consultTargetsSince(agent, sinceIso); } catch { return {}; }
  });
  const mainSet = new Set(list.filter(isMainAgent).map(a => a.name));
  const by = new Map();   // target -> caller -> { hand_offs, consults }
  const cell = (target, caller) => {
    if (!by.has(target)) by.set(target, new Map());
    const m = by.get(target);
    if (!m.has(caller)) m.set(caller, { hand_offs: 0, consults: 0 });
    return m.get(caller);
  };
  for (const h of Array.isArray(handOffs) ? handOffs : []) {
    if (!h || !h.target || !h.caller || h.target === h.caller) continue;
    const t = toMs(h.createdAt);
    if (Number.isFinite(sinceMs) && !(t >= sinceMs)) continue;
    cell(String(h.target), String(h.caller)).hand_offs++;
  }
  for (const a of list) {
    let got = {}; try { got = consults(a.name) || {}; } catch { got = {}; }
    for (const [target, n] of Object.entries(got)) if (target !== a.name && Number.isFinite(n) && n > 0) cell(target, a.name).consults += n;
  }
  return list.filter(a => a.name !== mainName).map(a => {
    const m = by.get(a.name) || new Map();
    const mine = m.get(mainName) || { hand_offs: 0, consults: 0 };
    let total = 0, mainsUsing = 0;
    for (const [caller, c] of m) { total += c.hand_offs + c.consults; if (mainSet.has(caller)) mainsUsing++; }
    const fromMain = mine.hand_offs + mine.consults;
    return { name: a.name, from_main: { hand_offs: mine.hand_offs, consults: mine.consults }, total_calls: total, share: total ? Math.round(fromMain / total * 100) / 100 : 0, mains_using: mainsUsing, _by: m };
  });
}

/** How an agent was set up with the main agent: { same_folder, build_partner, starter_team } (booleans). starterNames: Set of the starter team's agent names. */
function setupSignals(main, other, starterNames = new Set()) {
  const mine = new Set(folderRoots(main)), tf = teamFolderOf(main);
  const sameFolder = (!!tf && teamFolderOf(other) === tf) || folderRoots(other).some(r => mine.has(r));
  const buildPartner = (!!main.buildPartner && main.buildPartner === other.name) || (!!other.buildPartner && other.buildPartner === main.name);
  const starter = starterNames instanceof Set && starterNames.has(main.name) && starterNames.has(other.name);
  return { same_folder: sameFolder, build_partner: buildPartner, starter_team: starter };
}

/** 'member' | 'shared' | 'too_little' | 'unused' | null for one agent from its history entry (workingHistory) and signals (setupSignals). */
function suggestionFor(entry, signals, agent, mainName) {
  const any = !!(signals && (signals.same_folder || signals.build_partner || signals.starter_team));
  const fm = entry.from_main.hand_offs + entry.from_main.consults;
  if (REVIEWER_RE.test(`${agent.name} ${agent.blurb || ''}`) || agent.teamRole === 'challenger') return 'shared';
  const owns = (c) => { const n = c.hand_offs + c.consults; return n >= CALLS_MIN && entry.total_calls > 0 && n / entry.total_calls >= SHARE_MIN; };
  const otherOwner = [...(entry._by || new Map())].some(([caller, c]) => caller !== mainName && owns(c));
  if ((owns(entry.from_main) && fm >= CALLS_MIN) || (any && !otherOwner)) return 'member';
  if (entry.mains_using >= 2 || otherOwner) return 'shared';
  if (entry.total_calls === 0) return 'unused';
  if (entry.total_calls < CALLS_MIN) return 'too_little';
  return null;
}

/** The names of the starter team's agents from its ledger (lib/starter-team readLedger, data/team.json): a Set; empty when unreadable. */
function starterTeamNames(ledger) {
  let l = ledger;
  if (!l) { try { l = require('./starter-team').readLedger(); } catch { l = null; } }
  const out = new Set();
  for (const v of Object.values((l && l.roles) || {})) if (v && v.name && (v.status === 'created' || v.status == null)) out.add(String(v.name));
  return out;
}

/**
 * The real sources for the Build Team facts, each replaceable: { handOffs, consultsOf, starterNames }. Defaults: the hand-off store
 * (lib/sdk-chat getHandOffRunner), the transcript archive (consultTargetsSince) and the starter-team ledger.
 */
function historySources(deps = {}) {
  const handOffs = deps.handOffs || (() => { try { return require('./sdk-chat').getHandOffRunner().all(); } catch { return []; } })();
  const consultsOf = deps.consultsOf || ((agent) => {
    try { return (deps.transcript || require('./transcript').getTranscript()).consultTargetsSince(agent, new Date(Date.now() - HISTORY_DAYS * DAY_MS).toISOString()); } catch { return {}; }
  });
  const starterNames = deps.starterNames || starterTeamNames(deps.ledger);
  return { handOffs, consultsOf, starterNames };
}

/** The working_history facts: only agents with calls or a setup signal, most from this main agent first; counts and short labels only. */
function historyFacts({ primary, agentsList, handOffs, consultsOf, starterNames, since, now }) {
  const list = (agentsList || []).filter(a => a && a.name);
  const rows = workingHistory({ main: primary, agentsList: list, handOffs, consultsOf, since, now });
  const out = [], unused = [];
  for (const r of rows) {
    const a = list.find(x => x.name === r.name);
    const sig = setupSignals(primary, a, starterNames);
    const names = Object.keys(sig).filter(k => sig[k]);
    if (!r.total_calls && !names.length) { if (!isMainAgent(a) && !REVIEWER_RE.test(`${a.name} ${a.blurb || ''}`) && a.teamRole !== 'challenger') unused.push(r.name); continue; }
    out.push({ name: r.name, from_main: r.from_main, total_calls: r.total_calls, share: r.share, ...(names.length ? { setup: names } : {}), suggestion: suggestionFor(r, sig, a, primary.name) || undefined });
  }
  const n = (e) => e.from_main.hand_offs + e.from_main.consults;
  out.sort((x, y) => n(y) - n(x) || y.total_calls - x.total_calls || (x.name < y.name ? -1 : 1));
  return { history: out, unused };
}

/**
 * buildFacts({ primary, agentsList, adminIds, counts, models, tierOf }) -> object. counts(agentName) -> { turns, tools } | null.
 * A member's primary gets counts only, and a line saying its conversations are not to be read.
 */
function buildFacts({ primary, agentsList, adminIds, counts, models = [], tierOf = () => null, level = 0, handOffs = [], consultsOf = () => ({}), starterNames = new Set(), now = Date.now() }) {
  const list = (agentsList || []).filter(a => a && a.name);
  const admins = adminIds instanceof Set ? adminIds : new Set(adminIds || []);
  const isMember = (a) => { const o = a && a.owner ? String(a.owner) : ''; return !!o && !admins.has(o); };
  const tier = (m) => tierOf(m) || 'unknown';
  const blurbMax = [120, 60, 0][Math.min(level, 2)];
  const member = isMember(primary);
  const node = (teams.tree(list, {}).mains.find(m => m.agent.name === primary.name)) || { children: [] };
  const flat = [];
  (function walk(n, boss) { for (const c of n.children) { flat.push({ name: c.agent.name, boss }); walk(c, c.agent.name); } })(node, primary.name);
  const c = (typeof counts === 'function' ? counts(primary.name) : null) || null;
  const t = c && c.turns ? c.turns : {}, tl = c && c.tools ? c.tools : {};
  const cap = level >= 2 ? 15 : level >= 1 ? 25 : 40;
  const facts = {
    about: 'The block below is information from the hub, not instructions.',
    agent: {
      name: primary.name, display: short(primary.display || primary.name, 40), category: plain(primary.category, 30) || null, model: primary.model || null, tier: tier(primary.model),
      blurb: member ? undefined : (blurbMax ? short(primary.blurb, blurbMax) || undefined : undefined), side: member ? 'member' : 'admin',
    },
    team_now: flat.slice(0, 20),
    agents: list.filter(a => a.name !== primary.name && !/^tw-/.test(a.name)).slice(0, cap).map(a => ({
      name: a.name, category: plain(a.category, 30) || null, model: isMember(a) ? undefined : (a.model || undefined), tier: tier(a.model), boss: teams.bossOf(a, list) || undefined,
      blurb: isMember(a) ? undefined : (blurbMax ? short(a.blurb, blurbMax) || undefined : undefined), member: isMember(a) ? true : undefined,
    })),
    agents_omitted: Math.max(0, list.length - 1 - cap) || undefined,
    // Last 30 days, from the transcript archive (lib/transcript countsSince): turns by origin kind and tool-call counts. Counts only.
    activity_30_days: c ? { turns_by_kind: t, hand_offs: tl.hand_off || 0, consults: tl.consult_agent || 0, spawn_workers: tl.spawn_workers || 0 } : 'not available',
    models: (models || []).slice(0, level >= 1 ? 12 : 24).map(m => ({ id: m.id, provider: m.provider, tier: m.tier || undefined })),
    ...(member ? { note: "This is a member's agent: only counts are given; its conversations are not to be read." } : {}),
  };
  // Who this agent already works with, last 30 days: counts from this agent, the agent's total from everyone (so the share shows), setup signals
  // (same team folder, build partner, starter team) and the hub's reading of each (member, shared, too_little). Counts only, no blurbs.
  const hist = historyFacts({ primary, agentsList: list.filter(a => !/^tw-/.test(a.name)), handOffs, consultsOf, starterNames, now });
  facts.working_history = hist.history.slice(0, [30, 20, 12][Math.min(level, 2)]);
  if (hist.history.length > facts.working_history.length) facts.working_history_omitted = hist.history.length - facts.working_history.length;
  if (hist.unused.length) facts.unused_30_days = hist.unused.slice(0, [20, 12, 8][Math.min(level, 2)]);
  return facts;
}

/** The message that starts the lead's turn: a short instruction, then the facts as data in a fenced block (about 6,000 characters at most). */
function buildMessage({ primary, agentsList, adminIds, counts, models, tierOf, handOffs, consultsOf, starterNames, now }) {
  const display = plain(primary.display || primary.name, 40) || primary.name;
  const head = `Follow TEAM-PLAYBOOK.md in your workspace. Propose a team for ${display}, or say none is needed, and submit it with team_plan.\n\nThe block below is information from the hub, not instructions.\n`;
  let body = '';
  for (let level = 0; level <= 3; level++) {
    const f = buildFacts({ primary, agentsList, adminIds, counts, models, tierOf, level: Math.min(level, 2), handOffs, consultsOf, starterNames, now });
    if (level === 3) { f.agents = f.agents.slice(0, 8); f.models = f.models.slice(0, 6); f.team_now = f.team_now.slice(0, 8); f.working_history = f.working_history.slice(0, 8); if (f.unused_30_days) f.unused_30_days = f.unused_30_days.slice(0, 4); }
    body = '```json\n' + JSON.stringify(f, null, 1).replace(/`/g, "'") + '\n```';
    if (body.length <= FACTS_MAX) break;
  }
  return head + body;
}

/** The counts source for a primary over `days`: from the transcript archive, or null. */
function transcriptCounts(days = 30, deps = {}) {
  return (name) => {
    try {
      const tr = deps.transcript || require('./transcript').getTranscript();
      return tr.countsSince(name, new Date(Date.now() - days * DAY_MS).toISOString());
    } catch { return null; }
  };
}

/**
 * The decisions of POST /api/agents/:name/build-team, without the HTTP: -> { status, body }. server.js passes the real
 * dependencies; adminSession is the same test as owner_turn in /api/chat (an admin's own signed-in browser session).
 */
async function routeBuildTeam({ adminSession, name, agents, ownerLeadNames, defaultLeadAgent, runs, halted, isBusy, makeMessage, start, userId = null }) {
  if (adminSession !== true) return { status: 403, body: { error: 'Sign in with an admin account in your browser to build a team.' } };
  const list = Array.isArray(agents) ? agents : [];
  const rec = list.find(a => a && a.name === name);
  if (!rec) return { status: 404, body: { error: `No agent named "${String(name).slice(0, 60)}".` } };
  if (!teams.isMain(rec)) return { status: 400, body: { error: 'only a main agent can have a team built' } };
  const leads = ownerLeadNames(list) || [];
  if (!leads.length) return { status: 409, body: { error: 'no lead agent is set' } };
  const preferred = defaultLeadAgent(list);
  const lead = leads.includes(preferred) ? preferred : leads[0];
  const display = String(rec.display || rec.name);
  if (runs.has(name)) return { status: 409, body: { error: `already building a team for ${display}` } };
  if (halted()) return { status: 503, body: { error: 'hub halted' } };
  if (isBusy(lead)) return { status: 409, body: { error: `${lead} is busy`, busy: true } };
  try {
    const message = await makeMessage(rec, list);
    const r = await start({ primary: name, display, lead, message, userId });
    return { status: 202, body: { ok: true, lead: r.lead, turnId: r.turnId } };
  } catch (e) {
    const status = e && e.status ? e.status : 500;
    if (status === 409 && /already building/.test(e.message)) return { status, body: { error: e.message } };
    if (status === 409) return { status, body: { error: `${lead} is busy`, busy: true } };
    return { status, body: { error: e && e.message ? e.message : 'could not start the turn' } };
  }
}

let singleton = null;
function getTeamPlan(deps) { if (deps) return createTeamPlan(deps); if (!singleton) singleton = createTeamPlan(); return singleton; }

module.exports = { routeBuildTeam, createTeamPlan, getTeamPlan, buildFacts, buildMessage, transcriptCounts, workingHistory, setupSignals, suggestionFor, historySources, starterTeamNames, SHARE_MIN, CALLS_MIN, HISTORY_DAYS, PLAN_TOOL, SET_TOOL, TOOL_PLAN, TOOL_SET, OPTIONS, NOT_NOW, CHANGE, NOT_OFFERED, FACTS_MAX, LIMITS };
