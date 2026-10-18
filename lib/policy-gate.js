'use strict';
// The gate every path calls before a tool runs: Claude SDK PreToolUse hook, gateway tool loop,
// Codex MCP bridge and Codex command approvals. Decides allow / ask / deny from lib/tool-policy,
// parks "ask" on lib/approvals until the owner answers, and turns a refusal into text the agent
// can act on. Spend caps (lib/ledger) turn "allow" into "ask" for an agent over its cap.

const fs = require('fs');
const path = require('path');
const toolPolicy = require('./tool-policy');

const HOOK_TIMEOUT_S = 11 * 60;   // fallback; sdk-chat sizes the hook timeout from the approval window

/** The classes settings.approvalClasses may name: a card for these even while approval cards are off overall. */
const APPROVAL_CLASSES = ['sudo', 'destroy', 'money', 'admin', 'send', 'write_outside', 'web', 'read_outside'];

/** Every root (sudo) command any agent asked for, with the outcome: data/root-commands.jsonl, owner-only. */
function defaultAuditRoot(entry) {
  const file = path.join(toolPolicy.HUB_ROOT, 'data', 'root-commands.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
}

// approvalsOn(): when false (the default install), an "ask" is simply allowed and no card is shown; denies
// (member sandbox, wallet rules) still apply. Approval cards are opt-in via settings.approvalsEnabled, or per class
// via settings.approvalClasses (approvalClasses()): e.g. ['sudo', 'money'] shows a card for root commands and wallet
// actions only, while everything else keeps running without one.
function createGate({ getAgent, isWalletAgent = () => false, isMemberOwned = () => false, approvals, allowances, ledger = null, log = console.log, enabled = () => true, approvalsOn = () => true, approvalClasses = () => new Set(), auditRoot = defaultAuditRoot, rootGranted = () => null } = {}) {
  /**
   * check({ agentName, tool, input, cwd, origin, notify }) -> { allowed, decision, text }
   * notify(event) is called with the approval_request so the agent's own stream can show the card.
   */
  async function check(args) {
    const r = await decideCheck(args);
    // Root commands leave a trail whatever happened to them.
    const dec = r && r.decision;
    if (dec && dec.detail && dec.detail.sudo) {
      const outcome = r.allowed ? 'allowed' : (r.by ? `refused by ${r.by}` : 'denied');
      log(`[AUDIT] root command by ${args.agentName}: ${outcome}${r.grantId ? ` (grant ${r.grantId})` : ''} (${String(dec.detail.command || dec.summary || '').slice(0, 200).replace(/\s+/g, ' ')})`);
      try { auditRoot({ ts: new Date().toISOString(), agent: args.agentName, role: dec.role, outcome, approvalId: r.approvalId || null, grantId: r.grantId || null, command: String(dec.detail.command || dec.summary || '').slice(0, 2000) }); } catch (e) { log(`[AUDIT] root-commands log failed: ${e.message}`); }
    }
    return r;
  }

  function wantsCard(dec) {
    if (approvalsOn()) return true;
    let classes; try { classes = approvalClasses(); } catch { classes = null; }
    if (!classes) return false;
    const has = (c) => typeof classes.has === 'function' ? classes.has(c) : Array.isArray(classes) && classes.includes(c);
    return has(dec.cls) || !!(dec.detail && dec.detail.sudo && has('sudo'));
  }

  async function decideCheck({ agentName, tool, input, cwd, origin = null, notify = null }) {
    if (!enabled()) return { allowed: true, decision: { decision: 'allow', cls: 'read', reason: 'policy disabled' } };
    let agent = null;
    try { agent = await getAgent(agentName); } catch {}
    if (!agent) agent = { name: agentName, category: 'worker' };
    let capped = false; let capReason = null;
    if (ledger) { try { const oc = ledger.overCap(agentName); capped = !!oc.capped; capReason = oc.reason; } catch {} }
    // The operator's time-limited root grant for this agent (lib/root-grants), if any.
    let grant = null; try { grant = await rootGranted(agentName); } catch {}
    const dec = toolPolicy.decide({ agent, tool, input, cwd, allowances, isWalletAgent, isMemberOwned, capped, rootGranted: !!grant });
    const grantId = grant && dec.detail && dec.detail.sudo ? grant.id : null;
    if (dec.decision === 'allow') return { allowed: true, decision: dec, grantId };
    if (dec.decision === 'deny') {
      log(`[policy] ${agentName}: DENY ${dec.cls} via ${toolPolicy.stripMcp(tool)} (${String(dec.summary || '').slice(0, 100)})`);
      return { allowed: false, decision: dec, text: toolPolicy.denialText(dec) };
    }
    // ask
    if (!wantsCard(dec)) return { allowed: true, decision: { ...dec, decision: 'allow', reason: 'approval cards are off for this kind of action (Settings)' }, grantId };
    const { id, promise } = approvals.request({
      agent: agentName, tool: toolPolicy.stripMcp(tool), input, cls: dec.cls, summary: dec.summary, detail: dec.detail || null,
      allowKey: dec.allowKey, role: dec.role, origin, capReason,
    });
    if (notify) { try { notify({ type: 'approval_request', id, agent: agentName, tool: toolPolicy.stripMcp(tool), cls: dec.cls, summary: dec.summary, detail: dec.detail || null, allowKey: dec.allowKey, expiresAt: new Date(Date.now() + approvals.timeoutMs).toISOString(), capReason }); } catch {} }
    const r = await promise;
    if (notify) { try { notify({ type: 'approval_resolved', id, agent: agentName, decision: r.decision, by: r.by }); } catch {} }
    if (r.decision === 'allow') return { allowed: true, decision: dec, approvalId: id, by: r.by, grantId };
    return { allowed: false, decision: dec, approvalId: id, by: r.by, grantId, text: toolPolicy.denialText(dec, { by: r.by === 'timeout' ? 'timeout' : 'owner' }) };
  }

  /** Claude Agent SDK PreToolUse hook callback for one agent turn. */
  function sdkHook({ agentName, cwd, origin = null, notify = null }) {
    return async (hookInput) => {
      if (!hookInput || hookInput.hook_event_name !== 'PreToolUse') return {};
      const r = await check({ agentName, tool: hookInput.tool_name, input: hookInput.tool_input, cwd, origin, notify });
      if (r.allowed) return {};
      // 'block' refuses this one call and hands the reason to the model as the tool result, so the agent
      // carries on. permissionDecision 'deny' would be read by the Claude harness as "the user said stop"
      // and end the whole turn (seen live: long jobs died when an approval was denied or timed out).
      return { decision: 'block', reason: r.text };
    };
  }

  /** Codex app-server approval requests (shell commands, file changes) -> accept / decline. */
  async function codexServerRequest({ agentName, cwd, origin = null, notify = null }, method, params = {}) {
    if (method === 'item/commandExecution/requestApproval') {
      const raw = params.command ?? params.item?.command ?? params.cmd ?? '';
      const command = Array.isArray(raw) ? raw.map(String).join(' ') : String(raw || '');
      const r = await check({ agentName, tool: 'Bash', input: { command }, cwd: params.cwd || cwd, origin, notify });
      return { decision: r.allowed ? 'accept' : 'decline' };
    }
    if (method === 'item/fileChange/requestApproval') {
      const changes = params.changes || params.item?.changes || [];
      const paths = Array.isArray(changes) ? changes.map(c => c && (c.path || c.file || c.filePath)).filter(Boolean) : Object.keys(changes || {});
      for (const p of paths) {
        const r = await check({ agentName, tool: 'Write', input: { file_path: p }, cwd: params.cwd || cwd, origin, notify });
        if (!r.allowed) return { decision: 'decline' };
      }
      return { decision: 'accept' };
    }
    return null;   // not ours
  }

  return { check, sdkHook, codexServerRequest, HOOK_TIMEOUT_S };
}

module.exports = { createGate, HOOK_TIMEOUT_S, APPROVAL_CLASSES };
