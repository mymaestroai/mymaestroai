'use strict';
// One adapter between the hub's shell paths (hub Bash, run_job, the Claude client's Bash hook) and lib/lockbox:
// they all ask lockboxFor(...) and get the same decision. Every dependency is injectable; the default instance
// reads the real agents, temporary workers and settings, each lazily (so requiring this file loads nothing heavy).

const toolPolicy = require('../tool-policy');
const lockboxLib = require('./index');

function createWire({ getAgents, getVirtual, getSetting, lockbox = lockboxLib, toolPolicy: tp = toolPolicy, policyFor, isWalletAgent, isMemberOwned, decideExtra = {} } = {}) {
  const agentsNow = () => { try { const a = (getAgents || defaultGetAgents)(); return Array.isArray(a) ? a : []; } catch { return []; } };
  const virtualOf = (name) => { try { return (getVirtual || defaultGetVirtual)(name) || null; } catch { return null; } };
  const settingOf = (k) => { try { return (getSetting || defaultGetSetting)(k); } catch { return undefined; } };
  const walletOf = (name) => { try { return (isWalletAgent || defaultIsWalletAgent)(name); } catch { return false; } };
  const memberOf = (agent) => { try { return (isMemberOwned || defaultIsMemberOwned)(agent); } catch { return false; } };

  /**
   * Who the lockbox treats this name as: { mode record, folder name, rules record }.
   * A temporary worker takes its parent's mode and its parent's lockbox folder; its rules (role and roots) come from
   * the record the policy gate uses for it (sdk-chat's gate getAgent): a worker that carries its parent's owner.
   */
  function resolveAgent(agentName) {
    const all = agentsNow();
    const own = all.find(a => a && a.name === agentName);
    if (own) return { modeRecord: own, rulesRecord: own, folderName: own.name };
    const v = virtualOf(agentName);
    const parent = v && v.parent ? all.find(a => a && a.name === v.parent) : null;
    if (!parent) return null;
    return { modeRecord: parent, rulesRecord: { name: agentName, category: 'worker', owner: parent.owner || null, virtualOf: parent.name }, folderName: parent.name };
  }

  /** The name an approval is filed under: decide() takes approvals by the folder's name, so a worker's is its parent's. */
  function folderNameFor(agentName) { const r = resolveAgent(agentName); return r ? r.folderName : agentName; }

  /** For the gate: the name to file an approval under, or null when the lockbox is off for this agent (nothing to widen). */
  function approvalNameFor(agentName) {
    try {
      const r = resolveAgent(agentName);
      if (!r || lockbox.resolveMode(r.modeRecord, { getSetting: settingOf }) === 'off') return null;
      return r.folderName;
    } catch { return null; }
  }

  function lockboxFor(args = {}) {
    let mode = 'off';
    try {
      const r = resolveAgent(args.agentName);
      if (!r) {
        // A name with no record (a worker whose parent is gone, a name not in the agent list): the hub default decides,
        // and enforce refuses rather than run it unboxed.
        mode = lockbox.resolveMode(null, { getSetting: settingOf });
        if (mode === 'enforce') return { mode, refuse: 'The command lockbox is set to enforce, and this agent (' + String(args.agentName || '').slice(0, 64) + ') has no record it can be boxed by, so the command was not run.' };
        return mode === 'off' ? { mode } : { mode, plain: true };
      }
      mode = lockbox.resolveMode(r.modeRecord, { getSetting: settingOf });
      if (mode === 'off') return { mode: 'off' };
      return decideFor(r, args);
    } catch (e) {
      // Never throws. A failure after the mode is known: enforce refuses the command (never runs it unboxed), watch runs it plainly.
      const msg = e && e.message ? e.message : String(e);
      if (mode === 'enforce') return { mode, refuse: 'The command lockbox is set to enforce for this agent, but it failed (' + msg + '), so the command was not run.' };
      return { mode, plain: true };
    }
  }

  function decideFor(r, { agentName, tool, command, cwd, sandboxed = false }) {
    const policyOpts = { isWalletAgent: walletOf, isMemberOwned: memberOf };
    const policy = policyFor ? policyFor(r.rulesRecord, policyOpts) : tp.policyFor(r.rulesRecord, policyOpts);
    let sudo = false;
    try {
      const c = tp.classifyTool({ tool: 'Bash', input: { command: String(command == null ? '' : command) }, agentName: r.rulesRecord.name, policy, cwd });
      sudo = !!(c && c.detail && c.detail.sudo);
    } catch { sudo = false; }
    const agent = { ...r.modeRecord, name: r.folderName };
    // The Claude sessions this very agent (a temporary worker by its own name) ran tool calls in: only their saved tool
    // outputs become readable in the box (lib/lockbox buildProfile readAllow).
    const sessions = typeof lockbox.sessionsFor === 'function' ? lockbox.sessionsFor(agentName) : [];
    return lockbox.decide({ agent, tool, command, getSetting: settingOf, sandboxed: !!sandboxed, sudo, policy, sessions, ...decideExtra });
  }

  return { lockboxFor, folderNameFor, approvalNameFor, resolveAgent };
}

// ── the real things, loaded on first use ─────────────────────────────
function defaultGetAgents() { return require('../agents').getAgentsSync(); }
function defaultGetVirtual(name) { return require('../temporal-workers').getVirtual(name); }
function defaultGetSetting(k) { return require('../settings').getSetting(k); }
function defaultIsWalletAgent(name) { return require('../wallet/tools').isWalletAgent(name); }
function defaultIsMemberOwned(agent) {
  if (!agent || !agent.owner) return false;
  let admins;
  try { admins = new Set(require('../auth').getAuth().admins().map(u => u.id)); } catch { admins = new Set(); }
  return !admins.has(String(agent.owner));
}

const instance = createWire();

module.exports = { createWire, lockboxFor: instance.lockboxFor, folderNameFor: instance.folderNameFor, approvalNameFor: instance.approvalNameFor, instance };
