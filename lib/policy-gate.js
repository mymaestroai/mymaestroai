'use strict';
// The gate every path calls before a tool runs: Claude SDK PreToolUse hook, gateway tool loop,
// Codex MCP bridge and Codex command approvals. Decides allow / ask / deny from lib/tool-policy,
// parks "ask" on lib/approvals until the owner answers, and turns a refusal into text the agent
// can act on. Spend caps (lib/ledger) turn "allow" into "ask" for an agent over its cap.

const fs = require('fs');
const path = require('path');
const toolPolicy = require('./tool-policy');
const { BOXED_CLIENT_BUILTINS } = require('./client-isolation');

const BOXED_BLOCK_REASON = 'This tool is not available to an agent in a box.';
// The Claude client's built-in tools that write files: their policy 'allow' is passed on explicitly (see sdkHook).
/**
 * realTarget(p, cwd) -> the path a write to p really lands on: the real path of p when it exists (a symlink followed),
 * else the real path of its nearest existing folder plus the rest; null when p is empty or nothing can be resolved.
 */
function realTarget(p, cwd) {
  if (typeof p !== 'string' || !p) return null;
  const abs = path.resolve(cwd || '/', p);
  let probe = abs; const rest = [];
  for (let i = 0; i < 256; i++) {
    try { return path.join(fs.realpathSync(probe), ...rest.reverse()); }
    catch (e) {
      if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) return null;
      const up = path.dirname(probe);
      if (up === probe) return null;
      rest.push(path.basename(probe)); probe = up;
    }
  }
  return null;
}
const CLIENT_FILE_WRITERS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

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
function createGate({ getAgent, isWalletAgent = () => false, isMemberOwned = () => false, approvals, allowances, ledger = null, log = console.log, enabled = () => true, approvalsOn = () => true, approvalClasses = () => new Set(), auditRoot = defaultAuditRoot, rootGranted = () => null,
  lockboxFor = null, lockbox = null, lockboxAgentName = (n) => n } = {}) {
  // lockboxFor({ agentName, tool, command, cwd }) -> the command lockbox's decision (lib/lockbox/wire), or null for no lockbox.
  // lockbox: the lib/lockbox module (injectable for tests). lockboxAgentName(name): the name an approval is filed under
  // (a temporary worker's is its parent's: that is the folder its box is built for); falsy = the lockbox is off for it.
  const lockboxMod = () => lockbox || require('./lockbox');
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

  async function decideCheck({ agentName, tool, input, cwd, origin = null, notify = null, boxed = false }) {
    if (!enabled()) return { allowed: true, policyOff: true, decision: { decision: 'allow', cls: 'read', reason: 'policy disabled' } };
    let agent = null;
    try { agent = await getAgent(agentName); } catch {}
    if (!agent) agent = { name: agentName, category: 'worker' };
    let capped = false; let capReason = null;
    if (ledger) { try { const oc = ledger.overCap(agentName); capped = !!oc.capped; capReason = oc.reason; } catch {} }
    // The operator's time-limited root grant for this agent (lib/root-grants), if any.
    let grant = null; try { grant = await rootGranted(agentName); } catch {}
    // The turn knows whether the agent runs in a box (a temporary worker: its parent's box): that wins over the stored record.
    const dec = toolPolicy.decide({ agent, tool, input, cwd, allowances, isWalletAgent, isMemberOwned, capped, rootGranted: !!grant, ...(boxed === true ? { isBoxed: () => true } : {}) });
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
    if (r.decision === 'allow') {
      if (lockboxFor && r.by === 'owner') widenForApproval({ agent, agentName, tool, input, cwd });
      return { allowed: true, decision: dec, approvalId: id, by: r.by, grantId };
    }
    return { allowed: false, decision: dec, approvalId: id, by: r.by, grantId, text: toolPolicy.denialText(dec, { by: r.by === 'timeout' ? 'timeout' : 'owner' }) };
  }

  /**
   * A person approved a shell command on a card: the paths the checker judged above the agent's baseline widen the
   * command lockbox's box for that one command (lib/lockbox noteApproval). A new file widens its parent folder, because a
   * box rule needs something that exists. Approvals that time out, are cancelled or are allowed because cards are off
   * never get here.
   */
  function widenForApproval({ agent, agentName, tool, input, cwd }) {
    try {
      if (!['Bash', 'run_job'].includes(toolPolicy.stripMcp(tool))) return;
      const filedUnder = lockboxAgentName(agentName);
      if (!filedUnder) return;   // the lockbox is off for this agent: nothing to widen
      const command = String((input && input.command) || '');
      if (!command) return;
      const pol = toolPolicy.policyFor(agent, { isWalletAgent, isMemberOwned });
      const { writes, reads } = toolPolicy.pathsOf(command, { cwd: cwd || path.join(toolPolicy.HUB_ROOT, 'workspaces', agentName || ''), roots: pol.roots, agentName });
      if (!writes.length && !reads.length) return;
      const widenWrites = [];
      for (const p of writes) {
        if (fs.existsSync(p)) widenWrites.push(p);
        else { const d = path.dirname(p); if (fs.existsSync(d)) widenWrites.push(d); }
      }
      lockboxMod().noteApproval({ agent: filedUnder, command, writes: widenWrites, reads });
    } catch (e) { log(`[lockbox] could not note the approval for ${agentName}: ${e && e.message}`); }
  }

  /** Claude Agent SDK PreToolUse hook callback for one agent turn. */
  function sdkHook({ agentName, cwd, origin = null, notify = null, boxed = false }) {
    return async (hookInput) => {
      if (!hookInput || hookInput.hook_event_name !== 'PreToolUse') return {};
      // A boxed agent's client holds only the hub's MCP tools and the allow-listed built-ins: anything else that slipped
      // in (a server, a future built-in) is refused before any other check (allowedTools only auto-approves).
      if (boxed) {
        const t = String(hookInput.tool_name || '');
        if (!(t.startsWith('mcp__agent-hub__') || t.startsWith('mcp__hub__') || BOXED_CLIENT_BUILTINS.includes(t))) return { decision: 'block', reason: BOXED_BLOCK_REASON };
      }
      // The command lockbox lets a boxed command read back this session's own saved tool outputs: remember the session.
      if (lockboxFor && typeof hookInput.session_id === 'string') { try { lockboxMod().noteSession(agentName, hookInput.session_id); } catch { /* never blocks a call */ } }
      const r = await check({ agentName, tool: hookInput.tool_name, input: hookInput.tool_input, cwd, origin, notify, boxed });
      if (r.allowed) {
        // The Claude client's own Bash (mcp__hub__Bash is the hub tools' and is boxed there): box it, or refuse it, per the
        // lockbox. An agent in a sandbox box has no client Bash (refused above); its hands run in the box.
        if (lockboxFor && !boxed && hookInput.tool_name === 'Bash' && hookInput.tool_input && typeof hookInput.tool_input.command === 'string') {
          const d = await lockboxFor({ agentName, tool: 'client-bash', command: hookInput.tool_input.command, cwd });
          if (d && d.refuse) return { decision: 'block', reason: d.refuse };
          if (d && d.profile) {
            let wrapped;
            try { wrapped = lockboxMod().clientCommand(d.profile, hookInput.tool_input.command); }
            catch (e) {
              // A hook that throws lets the client run the call as written: enforce refuses instead, watch runs it as today.
              if (d.mode === 'enforce') return { decision: 'block', reason: 'The command lockbox could not wrap this command (' + (e && e.message) + '), so it was not run.' };
              return {};
            }
            return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...hookInput.tool_input, command: wrapped } } };
          }
        }
        // The client's own file-writing tools: in acceptEdits it accepts edits only inside its working folder (the install
        // root) and asks for anything else, an ask nobody can answer in a hub turn. The hub's policy is the judge of where
        // an agent may write: when it decided allow, say so explicitly (permissionDecision 'allow'). With the policy
        // switched off nothing changes (the client's own rules apply, as before).
        if (CLIENT_FILE_WRITERS.has(String(hookInput.tool_name || '')) && r.policyOff !== true) {
          // The policy judged the path as written; the client's write follows symlinks. Where the real target differs
          // (a link in the path), judge the real path too: only an allow for both gets the explicit allow.
          const input = hookInput.tool_input || {};
          const key = typeof input.notebook_path === 'string' && !input.file_path ? 'notebook_path' : 'file_path';
          const real = realTarget(input[key], cwd);
          if (real === null) return { decision: 'block', reason: 'This file path could not be checked, so it was not written.' };
          if (real !== path.resolve(cwd || '/', String(input[key] || ''))) {
            const r2 = await check({ agentName, tool: hookInput.tool_name, input: { ...input, [key]: real }, cwd, origin, notify, boxed });
            if (!r2.allowed) return { decision: 'block', reason: r2.text || 'The real target of this path is not allowed.' };
          }
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'allowed by the hub policy' } };
        }
        return {};
      }
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
    // Codex asks before any MCP tool not marked read-only. The hub's own bridge already runs this same policy on every
    // call (lib/codex-cli/bridge.js beforeCall), so its tools are accepted here; any other server stays refused.
    if (method === 'mcpServer/elicitation/request' && params.serverName === 'agent-hub') return { action: 'accept', content: {}, _meta: null };
    return null;   // not ours
  }

  return { check, sdkHook, codexServerRequest, HOOK_TIMEOUT_S };
}

module.exports = { createGate, HOOK_TIMEOUT_S, APPROVAL_CLASSES };
