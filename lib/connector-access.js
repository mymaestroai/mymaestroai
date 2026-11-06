'use strict';
// Who may use which data connector, changed by a lead agent at the owner's request (hub tool connector_access).
//
// A lead agent always has every connector. Any other agent needs to be named in the connector's `agents` list.
// This module only edits that list, and only for plain connectors: anything with a money tool or marked
// sensitive stays with the owner in Settings. Module connectors go through the modules layer (it validates the
// list), hand-made ones through the connectors store. Every change is logged to a file and sent to the owner's phone.

const fs = require('fs');
const path = require('path');

const HUB = path.join(__dirname, '..');
const NOT_CONFIRMED = "The owner didn't confirm, so nothing changed.";
const OWNER_ONLY = (name) => `Only the owner can change access to ${name}, in Settings, Data connectors.`;

function createConnectorAccess({
  connectors = () => require('./connectors').getConnectors(),
  modules = () => require('./modules').getModules(),
  agents = () => { try { return require('./agents').getAgentsSync(); } catch { return []; } },
  // flagged leads owned by the owner or an admin, never leadAgentNames()'s fallback to every admin-side primary agent
  leadNames = () => { try { return require('./agents').ownerLeadNames(); } catch { return []; } },
  isMemberOwned = (a) => {
    try { const admins = new Set(require('./auth').getAuth().admins().map(u => String(u.id))); return !!(a && a.owner && !admins.has(String(a.owner))); }
    catch { return !!(a && a.owner); }   // accounts unreadable: any owned agent counts as a member's (fail closed)
  },
  isVirtual = (name) => { try { return require('./temporal-workers').isVirtual(name); } catch { return false; } },
  push = () => require('./push').getPush(),
  auditFile = path.join(HUB, 'data', 'connector-access.jsonl'),
  now = Date.now,
} = {}) {
  const get = (x) => (typeof x === 'function' ? x() : x);

  function rows() { return (get(connectors).list().connectors) || []; }
  const classesOf = (c) => [...new Set(Object.values(c.tools || {}).map(t => t && t.cls).filter(Boolean))];

  function list() {
    return rows().map(c => {
      const classes = classesOf(c);
      return { id: c.id, name: c.label || c.id, module: c.module || null, classes, money: classes.includes('money'), sensitive: !!c.sensitive, agents: Array.isArray(c.agents) ? c.agents.slice() : [] };
    });
  }

  function audit(rec) {
    fs.mkdirSync(path.dirname(auditFile), { recursive: true });
    fs.appendFileSync(auditFile, JSON.stringify(rec) + '\n', { mode: 0o600 });
    try { fs.chmodSync(auditFile, 0o600); } catch { /* best effort */ }
  }

  function notice(by, action, agent, name) {
    const body = action === 'grant' ? `${by} gave ${agent} access to ${name}` : `${by} removed ${agent}'s access to ${name}`;
    try {
      const r = get(push).notify({ title: 'Data connector access changed', body, url: '/?connectors=1' }, { adminsOnly: true });
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch { /* a failed notice never undoes the change */ }
  }

  async function change(action, { connector, agent, by, confirm } = {}) {
    const who = String(by || 'a lead agent');
    const c = rows().find(x => x.id === connector);
    if (!c) throw new Error(`No data connector "${connector || ''}". Use action "list" to see them.`);
    const name = c.label || c.id;
    const classes = classesOf(c);
    if (classes.includes('money') || c.sensitive) throw new Error(OWNER_ONLY(name));
    if (!agent) throw new Error('Say which agent.');
    const rec = get(agents).find(a => a && a.name === agent);
    if (!rec) throw new Error(`No agent named "${agent}".`);
    if (isVirtual(agent)) throw new Error(`${agent} is a temporary worker and cannot be given connector access.`);
    if (isMemberOwned(rec)) throw new Error(`${agent} belongs to a member; only the owner can change its access, in Settings, Data connectors.`);
    if (get(leadNames).includes(agent)) throw new Error(`${agent} is a lead agent and already has access to every connector; nothing changed.`);

    if (action === 'grant' && typeof confirm !== 'function') throw new Error(NOT_CONFIRMED);   // a grant needs the owner's yes

    const before = Array.isArray(c.agents) ? c.agents.slice() : [];
    const after = action === 'grant' ? (before.includes(agent) ? before : [...before, agent]) : before.filter(n => n !== agent);
    if (action === 'grant' ? before.includes(agent) : !before.includes(agent)) return { ok: true, agents: before };   // already so: nothing to change, log or announce
    if (action === 'grant') {
      let yes = false;
      try { yes = (await confirm(`Give ${agent} access to ${name}?`)) === true; } catch { yes = false; }
      if (!yes) throw new Error(NOT_CONFIRMED);
    }
    // Written before the change, so a change can never happen unrecorded.
    const rec2 = (state, extra) => ({ at: new Date(now()).toISOString(), by: who, action, connector: c.id, agent, agentsBefore: before, agentsAfter: after, state, ...extra });
    try { audit(rec2('requested')); }
    catch (e) { console.warn(`[connector-access] audit write failed: ${e.message}`); throw new Error("Couldn't record the change, so nothing changed."); }
    try {
      if (c.module) get(modules).setAgents(c.module, after, { by: who });
      else get(connectors).setGrants(c.id, after);
    } catch (e) {
      try { audit(rec2('failed', { error: e.message })); } catch { /* best effort */ }
      throw e;
    }
    try { audit(rec2('done')); } catch (e) { console.warn(`[connector-access] audit write failed: ${e.message}`); }
    notice(who, action, agent, name);
    return { ok: true, agents: after };
  }

  return { list, grant: (o) => change('grant', o), revoke: (o) => change('revoke', o) };
}

const TOOL = {
  name: 'connector_access',
  description: 'Lists the data connectors and which agents may use them, and gives or removes an agent\'s access. Use it only when the owner asks you to in their own message. Every change is logged and the owner gets a phone notice.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'grant', 'revoke'], description: 'list, grant or revoke' },
      connector: { type: 'string', description: 'Connector id (grant, revoke)' },
      agent: { type: 'string', description: 'Agent name (grant, revoke)' },
    },
    required: ['action'],
  },
};

/** Run the tool for `by` (the lead agent). Always plain text: the result, or the refusal message.
 *  `confirm(question) -> Promise<boolean>` puts the grant question to the owner. */
async function runTool(access, args, by, confirm) {
  const a = args || {};
  try {
    if (a.action === 'list') {
      const rows = access.list();
      if (!rows.length) return 'No data connectors.';
      return rows.map(r => `${r.id} (${r.name})${r.module ? ` [module ${r.module}]` : ''}: ${r.money || r.sensitive ? 'owner only' : `agents: ${r.agents.length ? r.agents.join(', ') : 'none besides the leads'}`}`).join('\n');
    }
    if (a.action === 'grant' || a.action === 'revoke') {
      const r = await access[a.action]({ connector: a.connector, agent: a.agent, by, confirm });
      return `Done. ${a.connector} now allows: ${r.agents.length ? r.agents.join(', ') : 'no one besides the leads'}.`;
    }
    return 'Action must be list, grant or revoke.';
  } catch (e) { return e.message; }
}

let singleton = null;
function getConnectorAccess() { if (!singleton) singleton = createConnectorAccess(); return singleton; }

module.exports = { createConnectorAccess, getConnectorAccess, runTool, TOOL, OWNER_ONLY, NOT_CONFIRMED };
