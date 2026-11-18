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
// Security and spending limits stay with the owner whatever the manifest file says (review r6, Sentinel).
const PAGE_ONLY = new Set(['member-worker-models']);

function createBehaviourSwitch({
  changes = () => require('./behaviour-changes'),
  agents = () => { try { return require('./agents').getAgentsSync(); } catch { return []; } },
  // Who an agent is beyond its name (box id, read fresh from disk); the write itself refuses another agent of that name.
  stampOf = (name) => require('./agents').agentStamp(name),
  // check(agent) runs on the record the write itself reads (review r7: ownership may change while the change turns on)
  setAgentGuidance = async (name, value, stamp, check) => require('./agents').updateAgentField(name, { teamGuidance: value }, { expectStamp: stamp, check }),
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

  // What was done, in words: the change itself and/or the named agents.
  function done(who, action, title, entry, names) {
    const parts = [];
    if (entry) parts.push(`turned ${action} "${title}"`);
    if (names.length) parts.push(`${entry ? 'and switched it' : `switched "${title}"`} ${action} for ${names.join(', ')}`);
    return `${who} ${parts.join(' ')}`;
  }
  function notice(text, id) {
    const body = `${text}. Undo it at /changes.`;
    try {
      // the security kind, like connector_access: a switch made on the owner's behalf is announced like a grant
      const r = get(push).notify({ title: 'Changes to how agents behave', body, url: `/changes#${id}` }, { adminsOnly: true, kind: 'security' });
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch { /* a failed notice never undoes the change */ }
  }

  // Every rule a change must pass, read fresh: run before the question and again after the answer.
  function vet(id, names) {
    const c = get(changes).list().find(x => x.id === id);
    if (!c) throw new Error(`No behaviour change "${id || ''}". Use action "list" to see them.`);
    const title = c.title || c.id;
    if (c.leadMay !== true || PAGE_ONLY.has(c.id)) throw new Error(OWNER_ONLY(title));
    if (c.unreadable) throw new Error('The behaviour changes file could not be read, so nothing changed.');
    if (names.length && id !== 'team-guidance') throw new Error('Agents can be named only for team-guidance.');
    const all = get(agents);
    const stamps = {};
    for (const n of names) {
      const rec = all.find(a => a && a.name === n);
      if (!rec) throw new Error(`No agent named "${n}".`);
      if (isVirtual(n)) throw new Error(`${n} is a temporary worker.`);
      if (isMemberOwned(rec)) throw new Error(`${n} belongs to a member; only the owner can change its settings.`);
      const stamp = stampOf(n);
      if (!stamp) throw new Error(`Couldn't read ${n}'s record, so nothing changed.`);
      stamps[n] = { stamp, guidance: rec.teamGuidance || 'inherit' };
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
    // Naming agents while the change itself is off turns the change on too: the question says so (review r6, GPT-6).
    const alsoEntry = list0.length && entryNeeded ? ` This also turns the change itself on: the lead and new agents get it too.` : '';
    const question = `${who} wants to turn ${want} "${title}"${forWhom}.${alsoEntry} ${want === 'on' ? 'Turn it on?' : 'Turn it off?'}`;
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
    for (const n of list0) if (again.stamps[n].stamp !== stamps[n].stamp) throw new Error(CHANGED);   // same name, a different agent (removed and made again)
    const entryNow = list0.length ? (want === 'on' && again.c.state !== 'on') : again.c.state !== want;
    if (entryNow && !entryNeeded) throw new Error(CHANGED);   // the change was switched off meanwhile: the owner wasn't asked about turning it on
    ({ c, title, stamps } = again);
    const doEntry = entryNow;
    const doAgents = list0.filter(n => stamps[n].guidance !== want);
    const rec = (state, extra) => ({ at: new Date(now()).toISOString(), by: who, action: want, id, entryBefore: c.state, entryAfter: doEntry ? want : c.state, agents: doAgents, state, ...extra });
    // Written before the change, so a change can never happen unrecorded.
    try { audit(rec('requested')); }
    catch (e) { console.warn(`[behaviour-switch] log write failed: ${e.message}`); throw new Error("Couldn't record the change, so nothing changed."); }
    // Each step is counted as it succeeds: a failure part-way is logged, announced and reported with what did change.
    const made = { entry: false, agents: [] };
    const after = async () => { if (made.entry) { try { await afterChange(id); } catch (e) { console.warn(`[behaviour-switch] after ${id}: ${e.message}`); } } };
    try {
      if (doEntry) { await get(changes).decide(id, want, { agent: who }); made.entry = true; }
      for (const n of doAgents) {
        const check = (a) => (isMemberOwned(a) ? `${n} belongs to a member; only the owner can change its settings.` : null);
        const r = await setAgentGuidance(n, want, stamps[n].stamp, check);
        if (!r || r.success !== true) throw new Error(`Couldn't change ${n}: ${(r && r.error) || 'unknown error'}`);
        made.agents.push(n);
      }
    } catch (e) {
      try { audit(rec('failed', { error: e.message, entryDone: made.entry, agentsDone: made.agents })); } catch { /* best effort */ }
      if (made.entry || made.agents.length) {
        await after();
        const text = done(who, want, title, made.entry, made.agents);
        notice(`${text}; the rest failed`, id);
        throw new Error(`${String(e.message).replace(/\.$/, '')}. Done before that: ${text.slice(who.length + 1)}. The owner can undo it at /changes.`);
      }
      throw e;
    }
    try { audit(rec('done')); } catch (e) { console.warn(`[behaviour-switch] log write failed: ${e.message}`); }
    await after();
    notice(`${done(who, want, title, doEntry, doAgents)} at your request`, id);
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
