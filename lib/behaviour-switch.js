'use strict';
// The lead switches a behaviour change on or off at the owner's request (hub tool behaviour_change), modelled on
// lib/connector-access. Offered only to a flagged lead, only in a turn a signed-in admin typed (lib/sdk-chat decides
// the offer and re-checks it at call time). Only entries with leadMay true: anything about security or spending
// limits (member-worker-models) stays with the owner on /changes. Every change is put to the owner as a question in the
// same turn, logged before it happens, and announced on the admins' phones with the way to undo it.

const fs = require('fs');
const path = require('path');

const HUB = path.join(__dirname, '..');
const NOT_CONFIRMED = "The owner didn't confirm, so nothing changed.";
const TURN_ENDED = 'The turn ended before the owner answered, so nothing changed.';
const CHANGED = 'The change or an agent changed while the owner was answering, so nothing changed.';
const OWNER_ONLY = (title) => `Only the owner can switch "${title}", on the /changes page.`;

function createBehaviourSwitch({
  changes = () => require('./behaviour-changes'),
  agents = () => { try { return require('./agents').getAgentsSync(); } catch { return []; } },
  setAgentGuidance = async (name, value) => require('./agents').updateAgentField(name, { teamGuidance: value }),
  isMemberOwned = (a) => {
    try { const admins = new Set(require('./auth').getAuth().admins().map(u => String(u.id))); return !!(a && a.owner && !admins.has(String(a.owner))); }
    catch { return !!(a && a.owner); }   // accounts unreadable: any owned agent counts as a member's (fail closed)
  },
  isVirtual = (name) => { try { return require('./temporal-workers').isVirtual(name); } catch { return false; } },
  afterChange = async (id) => { if (id === 'worker-proposals') await require('./behaviour-review').syncProposalsTask(); },
  push = () => require('./push').getPush(),
  auditFile = path.join(HUB, 'data', 'behaviour-changes-log.jsonl'),
  now = Date.now,
} = {}) {
  const get = (x) => (typeof x === 'function' ? x() : x);

  function list() {
    return get(changes).list().map(c => ({ id: c.id, title: c.title || c.id, state: c.unreadable ? 'unreadable' : c.state, leadMay: c.leadMay === true }));
  }

  function audit(rec) {
    fs.mkdirSync(path.dirname(auditFile), { recursive: true });
    fs.appendFileSync(auditFile, JSON.stringify(rec) + '\n', { mode: 0o600 });
    try { fs.chmodSync(auditFile, 0o600); } catch { /* best effort */ }
  }

  function notice(who, action, title, id, names) {
    const forWhom = names.length ? ` for ${names.join(', ')}` : '';
    const body = `${who} turned ${action} "${title}"${forWhom} at your request. Undo it at /changes.`;
    try {
      const r = get(push).notify({ title: 'Changes to how agents behave', body, url: `/changes#${id}` }, { adminsOnly: true });
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch { /* a failed notice never undoes the change */ }
  }

  // Every rule a change must pass, read fresh: run before the question and again after the answer.
  function vet(id, names) {
    const c = get(changes).list().find(x => x.id === id);
    if (!c) throw new Error(`No behaviour change "${id || ''}". Use action "list" to see them.`);
    const title = c.title || c.id;
    if (c.leadMay !== true) throw new Error(OWNER_ONLY(title));
    if (c.unreadable) throw new Error('The behaviour changes file could not be read, so nothing changed.');
    if (names.length && id !== 'team-guidance') throw new Error('Agents can be named only for team-guidance.');
    const all = get(agents);
    const stamps = {};
    for (const n of names) {
      const rec = all.find(a => a && a.name === n);
      if (!rec) throw new Error(`No agent named "${n}".`);
      if (isVirtual(n)) throw new Error(`${n} is a temporary worker.`);
      if (isMemberOwned(rec)) throw new Error(`${n} belongs to a member; only the owner can change its settings.`);
      stamps[n] = { box: rec.box == null ? null : String(rec.box), guidance: rec.teamGuidance || 'inherit' };
    }
    return { c, title, stamps };
  }

  async function change(action, { id, agents: names = [], by, confirm, stillAllowed } = {}) {
    const who = String(by || 'The lead agent');
    const list0 = Array.isArray(names) ? [...new Set(names.map(String).filter(Boolean))] : [];
    if (list0.length > 50) throw new Error('Name at most 50 agents at a time.');
    let { c, title, stamps } = vet(id, list0);
    const want = action === 'on' ? 'on' : 'off';
    const entryNeeded = list0.length ? (want === 'on' && c.state !== 'on') : c.state !== want;
    const agentsNeeded = list0.filter(n => stamps[n].guidance !== want);
    if (!entryNeeded && !agentsNeeded.length) return { ok: true, state: c.state, unchanged: true };   // already so: nothing to ask, log or announce

    if (typeof confirm !== 'function') throw new Error(NOT_CONFIRMED);   // a change needs the owner's yes
    const forWhom = list0.length ? ` for ${list0.join(', ')}` : '';
    const question = `${who} wants to turn ${want} "${title}"${forWhom}. ${want === 'on' ? 'Turn it on?' : 'Turn it off?'}`;
    const yesLabel = want === 'on' ? 'Turn on' : 'Turn off';
    let yes = false;
    try { yes = (await confirm(question, yesLabel)) === true; } catch { yes = false; }
    if (!yes) throw new Error(NOT_CONFIRMED);
    if (typeof stillAllowed === 'function') {
      let ok = false;
      try { ok = stillAllowed() === true; } catch { ok = false; }
      if (!ok) throw new Error(TURN_ENDED);
    }
    // The owner may have taken a while: everything is read again.
    const again = vet(id, list0);
    for (const n of list0) if (again.stamps[n].box !== stamps[n].box) throw new Error(CHANGED);   // same name, a different agent (removed and made again)
    ({ c, title, stamps } = again);
    const doEntry = list0.length ? (want === 'on' && c.state !== 'on') : c.state !== want;
    const doAgents = list0.filter(n => stamps[n].guidance !== want);
    const rec = (state, extra) => ({ at: new Date(now()).toISOString(), by: who, action: want, id, entryBefore: c.state, entryAfter: doEntry ? want : c.state, agents: doAgents, state, ...extra });
    // Written before the change, so a change can never happen unrecorded.
    try { audit(rec('requested')); }
    catch (e) { console.warn(`[behaviour-switch] log write failed: ${e.message}`); throw new Error("Couldn't record the change, so nothing changed."); }
    try {
      if (doEntry) await get(changes).decide(id, want, { agent: who });
      for (const n of doAgents) {
        const r = await setAgentGuidance(n, want);
        if (r && r.success === false) throw new Error(`Couldn't change ${n}: ${r.error || 'unknown error'}`);
      }
    } catch (e) {
      try { audit(rec('failed', { error: e.message })); } catch { /* best effort */ }
      throw e;
    }
    try { audit(rec('done')); } catch (e) { console.warn(`[behaviour-switch] log write failed: ${e.message}`); }
    if (doEntry) { try { await afterChange(id); } catch (e) { console.warn(`[behaviour-switch] after ${id}: ${e.message}`); } }
    notice(who, want, title, id, doAgents);
    return { ok: true, state: doEntry ? want : c.state, agents: doAgents };
  }

  return { list, on: (o) => change('on', o), off: (o) => change('off', o) };
}

const TOOL = {
  name: 'behaviour_change',
  description: 'Lists the changes to how agents behave and switches one on or off. Use it only when the owner asks you to in their own message; the owner confirms each change, it is logged, and the owner gets a phone notice with the way to undo it at /changes. Changes about security or spending limits can only be switched by the owner on /changes.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'on', 'off'], description: 'list, on or off' },
      id: { type: 'string', description: 'The change id (on, off), as shown by list' },
      agents: { type: 'array', items: { type: 'string' }, description: 'team-guidance only: switch it for these agents (on also turns the change itself on)' },
    },
    required: ['action'],
  },
};

/** Run the tool for `by` (the lead agent). Always plain text: the result, or the refusal message.
 *  `confirm(question, yesLabel) -> Promise<boolean>` puts the question to the owner; `stillAllowed() -> boolean`
 *  says whether the owner's turn is still on after the answer. */
async function runTool(sw, args, by, confirm, stillAllowed) {
  const a = args || {};
  try {
    if (a.action === 'list') {
      const rows = sw.list();
      if (!rows.length) return 'No behaviour changes.';
      return rows.map(r => `${r.id} (${r.title}): ${r.state}${r.leadMay ? '' : ' (only the owner switches this, on /changes)'}`).join('\n');
    }
    if (a.action === 'on' || a.action === 'off') {
      const r = await sw[a.action]({ id: a.id, agents: a.agents, by, confirm, stillAllowed });
      if (r.unchanged) return `Nothing to change: ${a.id} is already ${r.state}${Array.isArray(a.agents) && a.agents.length ? ' for those agents' : ''}.`;
      return `Done. ${a.id} is ${r.state}${r.agents && r.agents.length ? `; switched ${a.action} for ${r.agents.join(', ')}` : ''}. The owner can undo it at /changes.`;
    }
    return 'Action must be list, on or off.';
  } catch (e) { return e.message; }
}

let singleton = null;
function getBehaviourSwitch() { if (!singleton) singleton = createBehaviourSwitch(); return singleton; }

module.exports = { createBehaviourSwitch, getBehaviourSwitch, runTool, TOOL, OWNER_ONLY, CHANGED, NOT_CONFIRMED, TURN_ENDED };
