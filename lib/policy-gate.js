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
  const abs = path.resolve(cwd || '/', expandHome(p));
  let probe = abs; const rest = [];
  for (let i = 0; i < 256; i++) {
    try { return path.join(fs.realpathSync(probe), ...rest.reverse()); }
    catch (e) {
      if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) return null;
      // A link whose target doesn't exist (yet) is still a link: a write would create the file where it points, so it
      // can't be judged by the path as written: refuse.
      try { if (fs.lstatSync(probe).isSymbolicLink()) return null; } catch { /* nothing there: keep walking up */ }
      const up = path.dirname(probe);
      if (up === probe) return null;
      rest.push(path.basename(probe)); probe = up;
    }
  }
  return null;
}
/** '~' and '~/x' mean the home folder, as the policy reads them (tool-policy expandPath). */
function expandHome(p) {
  const s = String(p);
  return s === '~' || s.startsWith('~/') ? path.join(require('os').homedir(), s.slice(1)) : s;
}
const CLIENT_FILE_WRITERS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// The only tools a self-check agent (lib/selfcheck) may call: the six, as client built-ins or as the hub's hands, plus
// ToolSearch, which a client on the hub's hands needs to load them.
const SELFCHECK_SIX = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'];
const SELFCHECK_ALLOWED = new Set([...SELFCHECK_SIX, ...SELFCHECK_SIX.map(t => `mcp__hub__${t}`), 'ToolSearch']);
// The Claude client's built-in tools that read files: like the writers, the client asks for any path outside its working
// folder unless the hook answers allow (see sdkHook).
const CLIENT_FILE_READERS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
const CLIENT_DIR_SEARCHERS = new Set(['Glob', 'Grep', 'LS']);
const GLOB_PATTERN_MAX = 1024;
const GLOB_BRACES_MAX = 32;   // more brace groups than any real pattern: refused (bounds the expansion work)
const GLOB_META = /[*?[\]{}!()|]/;   // wildcards, braces, classes, and extglob groups such as @(a|b)

/**
 * readTarget(tool, input, cwd) -> { target, dir } for a client read: the file it reads, or the folder a search walks.
 * A search's folder is its path (default: the working folder); a Glob pattern that is absolute, starts with '~' or climbs
 * with '..' moves it: its literal leading segments are added. Returns null when it can't be told (a '..' after a wildcard).
 */
function readTarget(tool, input, cwd) {
  const inp = input || {};
  if (!CLIENT_DIR_SEARCHERS.has(tool)) {
    const p = typeof inp.file_path === 'string' && inp.file_path ? inp.file_path : inp.notebook_path;
    return typeof p === 'string' && p ? { target: p, dir: false } : null;
  }
  const base = typeof inp.path === 'string' && inp.path ? expandHome(inp.path) : (cwd || '/');
  if (tool === 'Glob' && typeof inp.pattern === 'string' && inp.pattern) {
    // A backslash escapes the next character for the glob engine (\} keeps a brace group open, \.\. is a '..' step),
    // which a text check can't follow: refused, as is a very long pattern (the brace scan is quadratic in its length).
    if (inp.pattern.includes('\\') || inp.pattern.length > GLOB_PATTERN_MAX || (inp.pattern.match(/\{/g) || []).length > GLOB_BRACES_MAX) return null;
    const pat = expandHome(inp.pattern);
    const g = globRoot(pat, base);
    if (!g) return null;
    // Braces expand to literal text before matching ({a,../x} becomes ../x, {a,/etc} becomes /etc): every expansion
    // must stay inside the folder judged for the pattern as written.
    const alts = expandBraces(pat);
    if (!alts) return null;
    const root = path.resolve('/', g);
    for (const alt of alts) {
      if (alt === pat) continue;
      const a = globRoot(expandHome(alt), base);
      if (!a) return null;
      const r = path.resolve('/', a);
      if (r !== root && !r.startsWith(root === '/' ? '/' : root + '/')) return null;
    }
    return { target: g, dir: true };
  }
  return { target: base, dir: true };
}

/** The folder a Glob pattern walks from base: its literal leading segments added; null when a '..' step follows a wildcard. */
function globRoot(pat, base) {
  const segs = pat.split('/');
  const lead = [];
  let i = 0;
  for (; i < segs.length && !GLOB_META.test(segs[i]); i++) lead.push(segs[i]);
  // After the literal start a '..' step (also inside an extglob such as @(..|x), or a single-item group {..} that an
  // engine may collapse) would climb out of the folder walked. A '..' inside a name (report..md) or a range ({1..3}) is
  // not a step.
  // Pieces can also build the step: .{.} or {.}{.} become '..' once an engine drops the single-item braces.
  if (segs.slice(i).some(s => s.split(/[(){}|,]/).some(t => t.replace(/^[@!+*?]+/, '') === '..')
    || s.replace(/[(){}|,]/g, '') === '..')) return null;
  // the last literal segment may be the file name itself: the folder walked is its parent
  if (i >= segs.length) lead.pop();
  if (path.isAbsolute(pat)) return path.join('/', ...lead);
  return lead.length ? path.join(base, ...lead) : base;
}

/**
 * expandBraces(s) -> every expansion of the comma groups in s ({a,b}, nested too), or null past 256 of them.
 * Groups without a comma ({1..3}, {x}) are left as written.
 */
function expandBraces(s, limit = 256) {
  const out = []; const stack = [s];
  while (stack.length) {
    const cur = stack.pop();
    const g = firstCommaGroup(cur);
    if (!g) { out.push(cur); if (out.length > limit) return null; continue; }
    for (const p of g.parts) stack.push(cur.slice(0, g.start) + p + cur.slice(g.end + 1));
    if (stack.length + out.length > limit) return null;
  }
  return out;
}
function firstCommaGroup(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0; let last = i + 1; const parts = [];
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (c === '{') depth++;
      else if (c === ',' && depth === 1) { parts.push(s.slice(last, j)); last = j + 1; }
      else if (c === '}') {
        depth--;
        if (depth === 0) { parts.push(s.slice(last, j)); if (parts.length > 1) return { start: i, end: j, parts }; break; }
      }
    }
  }
  return null;
}

/** Does the folder `dir` contain (or equal) a protected path: a search there would walk into it. */
function holdsProtected(dir) {
  const inside = (p) => p === dir || p.startsWith(dir.endsWith('/') ? dir : dir + '/');
  // /proc: every process's start environment (environ) lies below it, so a search at or under it is refused too
  // each protected path as written and as its real path (an install or home folder reached through a link)
  const listed = toolPolicy.SENSITIVE_READ.flatMap(p => { const r = realTarget(p, '/'); return r && r !== p ? [p, r] : [p]; });
  return listed.some(inside) || inside('/proc') || dir.startsWith('/proc/');
}

const NAME_SCAN_LIMIT = 50000;
// Folders a package manager, version control or a tool cache writes, never the owner: installed dependencies, a
// repository's object store, Python and tool caches. A secret of the owner's is not kept there, and their test keys and
// sample .env files belong to the packages. The scan does not descend into them, so a repository with its dependencies
// installed can be searched. The scan still covers everything else in the folder.
const NAME_SCAN_SKIP = new Set(['node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache']);
/**
 * protectedByName(dir) -> the first file under dir that the policy protects by its name (a key file, an .env file:
 * tool-policy isSensitiveRead), 'too-many' when the folder has more than NAME_SCAN_LIMIT entries outside the skipped
 * folders, or null. Links are not followed (the client's Grep doesn't follow them either). Hidden files are included.
 */
function protectedByName(dir) {
  let st; try { st = fs.statSync(dir); } catch { return null; }
  if (!st.isDirectory()) return toolPolicy.isSensitiveRead(dir) ? dir : null;
  const stack = [dir]; let seen = 0;
  while (stack.length) {
    const d = stack.pop();
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (++seen > NAME_SCAN_LIMIT) return 'too-many';
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!NAME_SCAN_SKIP.has(e.name)) stack.push(p); }
      else if (!e.isSymbolicLink() && toolPolicy.isSensitiveRead(p)) return p;
    }
  }
  return null;
}

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
  onDecision = null, isSelfCheck = () => false } = {}) {
  // onDecision({ agentName, tool, input, decision, cls, reason }) sees every decision (the self-check watches them); it
  // never changes one, and a failure in it is ignored. isSelfCheck(name): the hub's own check agents never get an
  // approval card: an "ask" is a deny for them.
  const tell = (args, r) => {
    if (typeof onDecision !== 'function') return;
    try {
      const d = (r && r.decision) || {};
      // The outcome, not the rule: an "ask" a person approved ran (allow), one refused or timed out didn't (deny).
      // rule: what the policy itself said (allow, deny or ask). A check agent's ask is turned into a deny, so the outcome alone hides it.
      onDecision({ agentName: args.agentName, tool: args.tool, input: args.input, decision: r && r.allowed ? 'allow' : 'deny', rule: d.selfCheckAsk ? 'ask' : d.decision, cls: d.cls || null, reason: d.reason || d.summary || '' });
    } catch { /* a watcher never blocks a call */ }
  };
  const selfCheck = (name) => { try { return !!isSelfCheck(name); } catch { return false; } };
  /**
   * check({ agentName, tool, input, cwd, origin, notify }) -> { allowed, decision, text }
   * notify(event) is called with the approval_request so the agent's own stream can show the card.
   */
  async function check(args) {
    const r = await decideCheck(args);
    tell(args, r);
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
    // A self-check agent has exactly six tools, enforced here too (before anything else, the policy switch included): a
    // tool the client or the hub offers that its lists didn't remove is refused, whatever it is.
    if (selfCheck(agentName) && !SELFCHECK_ALLOWED.has(String(tool || ''))) {
      return { allowed: false, decision: { decision: 'deny', cls: 'admin', reason: 'a self-check agent has only Read, Write, Edit, Glob, Grep and Bash', summary: String(tool || '') }, text: 'This tool is not available to a self-check agent.' };
    }
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
    // A check agent never asks: no card, no allowance, nothing sent to a person. The self-check must see a plain deny.
    if (selfCheck(agentName)) {
      const d = { ...dec, decision: 'deny', reason: 'self-check agents never ask', selfCheckAsk: true };
      return { allowed: false, decision: d, text: toolPolicy.denialText(d) };
    }
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

  /**
   * Would this agent's policy stop a read of a protected file (hub data, sign-ins, keys)? Judged on the install's .env, an
   * 'admin' read: refused for workers, wallet and member agents; for the lead and admin agents it is an ask, which stops
   * the read only when it would show an approval card (cards off: the ask is allowed, as for a direct Read). Used for
   * whole-folder searches, which can't show a card for files they don't know they will open.
   */
  async function refusesProtectedReads(agentName, cwd, boxed) {
    let agent = null;
    try { agent = await getAgent(agentName); } catch {}
    if (!agent) agent = { name: agentName, category: 'worker' };
    try {
      const dec = toolPolicy.decide({ agent, tool: 'Read', input: { file_path: path.join(toolPolicy.HUB_ROOT, '.env') }, cwd, allowances, isWalletAgent, isMemberOwned, ...(boxed === true ? { isBoxed: () => true } : {}) });
      if (dec.decision === 'deny') return true;
      return dec.decision === 'ask' && wantsCard(dec);
    } catch { return true; }
  }

  /** Claude Agent SDK PreToolUse hook callback for one agent turn. */
  function sdkHook({ agentName, cwd, origin = null, notify = null, boxed = false }) {
    return async (hookInput) => {
      if (!hookInput || hookInput.hook_event_name !== 'PreToolUse') return {};
      // A boxed agent's client holds only the hub's MCP tools and the allow-listed built-ins: anything else that slipped
      // in (a server, a future built-in) is refused before any other check (allowedTools only auto-approves).
      if (boxed) {
        const t = String(hookInput.tool_name || '');
        if (!(t.startsWith('mcp__agent-hub__') || t.startsWith('mcp__hub__') || BOXED_CLIENT_BUILTINS.includes(t))) {
          tell({ agentName, tool: t, input: hookInput.tool_input }, { allowed: false, decision: { decision: 'deny', cls: null, reason: BOXED_BLOCK_REASON } });
          return { decision: 'block', reason: BOXED_BLOCK_REASON };
        }
      }
      const r = await check({ agentName, tool: hookInput.tool_name, input: hookInput.tool_input, cwd, origin, notify, boxed });
      if (r.allowed) {
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
        // The client's own file-reading tools: the same ask outside the working folder. The policy judged the path as
        // written (a search: its path, or nothing when it searches the working folder); judge the real file or the real
        // folder walked too. A search over a folder that holds protected files (sign-ins, hub data, /proc) gets no
        // explicit allow: inside the working folder the client's own rule applies as before, outside it is refused.
        const tool = String(hookInput.tool_name || '');
        if (CLIENT_FILE_READERS.has(tool) && r.policyOff !== true) {
          const input = hookInput.tool_input || {};
          const t = readTarget(tool, input, cwd);
          if (t === null) {
            if (!CLIENT_DIR_SEARCHERS.has(tool)) return {};   // no path at all: the client reports its own error
            return { decision: 'block', reason: 'This search pattern could not be checked (a ".." step, braces that lead out of its folder, a backslash, more than 32 braces or 1,024 characters), so it was not run. Give the folder as path and a plain pattern.' };
          }
          const real = realTarget(t.target, cwd);
          if (real === null) return { decision: 'block', reason: 'This path could not be checked, so it was not read.' };
          const key = t.dir ? 'path' : (typeof input.file_path === 'string' && input.file_path ? 'file_path' : 'notebook_path');
          const judged = typeof input[key] === 'string' && input[key] ? path.resolve(cwd || '/', expandHome(input[key])) : null;
          if (real !== judged) {
            const r2 = await check({ agentName, tool: hookInput.tool_name, input: { [key]: real }, cwd, origin, notify, boxed });
            if (!r2.allowed) return { decision: 'block', reason: r2.text || 'The real target of this path is not allowed.' };
          }
          // A Grep opens every file in its folder; an agent whose policy would stop a protected read (a worker, a wallet
          // or member agent; the lead or an admin agent while approval cards are on for it) may not Grep a folder that
          // holds any. Glob and LS only list names.
          const grepRefused = tool === 'Grep' && await refusesProtectedReads(agentName, cwd, boxed);
          if (t.dir && holdsProtected(real)) {
            let home = null; try { home = fs.realpathSync(cwd || '/'); } catch { /* unresolvable: treat as outside */ }
            if (!grepRefused && home && (real === home || real.startsWith(home.endsWith('/') ? home : home + '/'))) return {};
            return { decision: 'block', reason: 'This folder holds protected files (sign-ins or hub data), so it can\'t be searched as a whole. Search a narrower folder inside it.' };
          }
          if (grepRefused) {
            const hit = protectedByName(real);
            if (hit === 'too-many') return { decision: 'block', reason: 'This folder is too large to check for protected files (keys, .env files), so it was not searched. Search a narrower folder inside it.' };
            if (hit) return { decision: 'block', reason: 'This folder holds a protected file (a key or .env file), so it can\'t be searched as a whole. Search a narrower folder, or the files you need by name.' };
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
