'use strict';
// The lead lists the model suggestions for the owner's agents and switches one, or puts it aside, at the owner's
// request (hub tool model_offer), modelled on lib/behaviour-switch. Offered only to a flagged lead, only in a turn a
// signed-in admin typed (lib/sdk-chat decides the offer and re-checks it at call time). Every switch is put to the owner
// as a question in the same turn, logged before it happens, and announced on the admins' phones with the way to undo it.

const fs = require('fs');
const path = require('path');

const HUB = path.join(__dirname, '..');
const NOT_CONFIRMED = "The owner didn't confirm, so nothing changed.";
const TURN_ENDED = 'The turn ended before the owner answered, so nothing changed.';
const CHANGED = 'The agent or its suggestion changed while the owner was answering, so nothing changed.';

function createModelOfferSwitch({
  offers = () => require('./model-offers-service').getModelOffers(),
  agents = () => { try { return require('./agents').getAgentsSync(); } catch { return []; } },
  stampOf = (name) => require('./agents').agentStamp(name),
  isMemberOwned = (a) => {
    try { const admins = new Set(require('./auth').getAuth().admins().map(u => String(u.id))); return !!(a && a.owner && !admins.has(String(a.owner))); }
    catch { return !!(a && a.owner); }   // accounts unreadable: any owned agent counts as a member's (fail closed)
  },
  isVirtual = (name) => { try { return require('./temporal-workers').isVirtual(name); } catch { return false; } },
  isBusy = () => false,
  setModel = async (name, model) => require('./agents').setAgentModel(name, model),
  published = (name) => {
    try {
      const a = (require('./agents').getAgentsSync() || []).find(x => x && x.name === name);
      if (!a) return;
      require('./hub-events').events.publish('agent_updated', { agent: name, model: a.model || null, display: a.display || null, icon: a.icon || null, category: a.category || null, autoModel: !!a.autoModel, effort: a.effort || 'default', changed: ['model'] });
    } catch { /* events are best effort */ }
  },
  push = () => require('./push').getPush(),
  auditFile = path.join(HUB, 'data', 'model-offers-log.jsonl'),
  now = Date.now,
} = {}) {
  const get = (x) => (typeof x === 'function' ? x() : x);

  async function list() {
    const rows = await get(offers).list();
    return Array.isArray(rows) ? rows : [];
  }

  function audit(rec) {
    fs.mkdirSync(path.dirname(auditFile), { recursive: true });
    fs.appendFileSync(auditFile, JSON.stringify(rec) + '\n', { mode: 0o600 });
    try { fs.chmodSync(auditFile, 0o600); } catch { /* best effort */ }
  }

  function notice(who, name, from, to) {
    try {
      const r = get(push).notify({
        title: 'Model switched',
        body: `${who} switched ${name} from ${from} to ${to} at your request. To undo it, choose ${from} again on its settings page.`,
        url: `/agent-settings.html?agent=${encodeURIComponent(name)}`,
      }, { adminsOnly: true, kind: 'security' });
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch { /* a failed notice never undoes the change */ }
  }

  async function offerOf(name) {
    const o = await get(offers).offerFor(name);
    if (!o) throw new Error(`${name} has no model suggestion right now.`);
    return o;
  }

  // Every rule a switch must pass, read fresh: run before the question and again after the answer. The offer is awaited
  // FIRST; everything after it is synchronous, so the record judged (owner, model, stamp, busy) is the one the caller
  // writes next, with no await in between (review r1, GPT-6: ownership could change during the offer lookup).
  async function vet(name, { needIdle = true } = {}) {
    const offer = await get(offers).offerFor(name);
    const rec = (get(agents) || []).find(a => a && a.name === name);
    if (!rec) throw new Error(`No agent named "${name}".`);
    if (isVirtual(name)) throw new Error(`${name} is a temporary worker.`);
    if (isMemberOwned(rec)) throw new Error(`${name} belongs to a member; only the owner can change its model.`);
    if (!offer || offer.from !== rec.model) throw new Error(`${name} has no model suggestion right now.`);   // none, or its model changed since
    if (needIdle && isBusy(name)) throw new Error(`${name} is busy right now; try again when it's free.`);
    const stamp = stampOf(name);
    if (!stamp) throw new Error(`Couldn't read ${name}'s record, so nothing changed.`);
    return { rec, offer, stamp };
  }
  const allowedNow = (stillAllowed) => { try { return typeof stillAllowed === 'function' && stillAllowed() === true; } catch { return false; } };
  // Agent display names are free text: only plain characters reach the owner's question.
  const plain = (t) => String(t == null ? '' : t).replace(/[^A-Za-z0-9 ._()-]/g, '').slice(0, 40);

  async function switchTo({ agent, by, confirm, stillAllowed } = {}) {
    const who = String(by || 'The lead agent');
    const name = String(agent || '');
    // The lead's own model can't change during its own turn: the owner switches it on its settings page.
    if (by && name === String(by)) throw new Error(`Your own model can't change while you are answering; the owner can switch it on your settings page (Switch).`);
    const first = await vet(name);
    if (typeof confirm !== 'function') throw new Error(NOT_CONFIRMED);
    const { from, to, why, route, cost } = first.offer;
    const display = plain(first.offer.display || first.rec.display || name) || name;
    const question = `${who} wants to switch ${display} (${name}) from ${from} to ${to}: ${why}; ${route}${cost ? ', ' + cost : ''}. Switch?`;
    let yes = false;
    try { yes = (await confirm(question, 'Switch')) === true; } catch { yes = false; }
    if (!yes) throw new Error(NOT_CONFIRMED);
    if (!allowedNow(stillAllowed)) throw new Error(TURN_ENDED);
    const again = await vet(name);
    if (again.stamp !== first.stamp || again.offer.to !== to) throw new Error(CHANGED);
    // The turn may have ended while the offer was looked up again: checked once more, right before the write (review r1, GPT-6).
    if (!allowedNow(stillAllowed)) throw new Error(TURN_ENDED);
    const rec = (state, extra) => ({ at: new Date(now()).toISOString(), by: who, action: 'switch', agent: name, from, to, state, ...extra });
    try { audit(rec('requested')); }
    catch (e) { console.warn(`[model-offer-switch] log write failed: ${e.message}`); throw new Error("Couldn't record the change, so nothing changed."); }
    let r;
    try {
      r = await setModel(name, to);
      if (!r || r.success !== true) throw new Error(`Couldn't change ${name}: ${(r && r.error) || 'unknown error'}`);
    } catch (e) {
      try { audit(rec('failed', { error: e.message })); } catch { /* best effort */ }
      throw e;
    }
    try { audit(rec('done')); } catch (e) { console.warn(`[model-offer-switch] log write failed: ${e.message}`); }
    try { published(name); } catch { /* best effort */ }
    notice(who, name, from, to);
    return { ok: true, name, from, to };
  }

  async function notNow({ agent, by, stillAllowed } = {}) {
    const who = String(by || 'The lead agent');
    const name = String(agent || '');
    const { offer } = await vet(name, { needIdle: false });
    if (!allowedNow(stillAllowed)) throw new Error(TURN_ENDED);   // same rule as a switch: only while the owner's turn is on (review r1, Sonnet)
    const r = get(offers).decline(name, offer.to);
    if (!r || r.ok !== true) throw new Error((r && r.error) || `Couldn't put the suggestion for ${name} aside.`);
    try { audit({ at: new Date(now()).toISOString(), by: who, action: 'not_now', agent: name, from: offer.from, to: offer.to, state: 'declined' }); }
    catch (e) { console.warn(`[model-offer-switch] log write failed: ${e.message}`); }
    return { ok: true, name, to: offer.to };
  }

  return { list, switchTo, notNow };
}

const TOOL = {
  name: 'model_offer',
  description: 'Lists the model suggestions for your agents (a newer version of a model an agent uses, or a stronger model from another vendor for a challenger) and switches one or puts it aside. Use switch or not_now only when the owner asks you to in their own message; the owner confirms each switch, it is logged, and the owner gets a phone notice with the way to undo it. Never switch on your own initiative.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'switch', 'not_now'] },
      agent: { type: 'string', description: 'The agent name (switch, not_now)' },
    },
    required: ['action'],
  },
};

/** Run the tool for `by` (the lead agent). Always plain text: the result, or the refusal message. */
async function runTool(sw, args, by, confirm, stillAllowed) {
  const a = args || {};
  try {
    if (a.action === 'list') {
      const rows = await sw.list();
      if (!rows.length) return 'No model suggestions right now.';
      return rows.map(o => `${o.name}: ${o.from} -> ${o.to} (${o.why}; ${o.route}${o.cost ? ', ' + o.cost : ''})`).join('\n');
    }
    if (a.action === 'switch') {
      const r = await sw.switchTo({ agent: a.agent, by, confirm, stillAllowed });
      return `Done. ${r.name} now uses ${r.to}. The owner can undo it on its settings page.`;
    }
    if (a.action === 'not_now') {
      const r = await sw.notNow({ agent: a.agent, by, stillAllowed });
      return `Put aside: ${r.name} will not be offered ${r.to} again.`;
    }
    return 'Action must be list, switch or not_now.';
  } catch (e) { return e && e.message ? e.message : String(e); }
}

let singleton = null;
function getModelOfferSwitch() { if (!singleton) singleton = createModelOfferSwitch(); return singleton; }

module.exports = { createModelOfferSwitch, getModelOfferSwitch, runTool, TOOL };
