'use strict';
// Per-agent tool policy: every tool call on every path (Claude SDK hook, gateway loop, Codex
// approval requests, run_job commands) is classified into an action class and decided per agent:
//
//   read          reads, searches, web GETs, hub read tools                       always allow
//   write_inside  writes under the agent's own roots (workspace, team folder, /tmp) always allow
//   delegate      consult, spawn workers, schedule, run_job, tiger team             always allow
//   write_outside writes anywhere else on this machine                             per policy
//   send          anything that leaves the box: email, Telegram, git push, POST to a non-local host,
//                 scp/ssh/rsync to a remote, mutating skill tools (Slack, GitHub, Google...)
//   admin         hub data/, .env, agents.json, another agent's workspace, create_agent
//   destroy       rm -r / rm -f, service stop/restart/kill, reboot, git reset --hard, force push...
//   money         wallet / exchange tools: the wallet firewall decides for wallet agents, deny for all others
//
// Decisions are allow | ask | deny. Defaults come from the agent's role (worker, head, lead, wallet);
// `policy.overrides` in agents.json changes a class, `policy.roots` adds writable roots. An "ask" that
// the owner approved "for 1 hour" is remembered by (agent, class) so one approval covers that kind of
// action for the hour; for send and money the destination is part of the key (same host, same recipient),
// because "email this person" is not "email anyone". (Keying every class by destination meant a shell
// command in a new folder, or one starting with a new word, asked again every time.)
//
// Honest limits: this classifies what the model asks a tool to do. A script that writes files or
// opens sockets from inside `python -c` is seen only as "python". It stops accidents and injection-
// driven attempts; a deliberately adversarial agent needs OS-level isolation (next step).

const path = require('path');
const os = require('os');
const fs = require('fs');

const HUB_ROOT = path.resolve(__dirname, '..');                 // the hub source tree
const { HUB_HOME } = require('./hub-home');   // share/, users/, medical/, legal/: see lib/hub-home
const HOME = os.homedir();

// read_outside: reads of files outside the agent's roots (members: deny; admin-side agents: allow)
// web: WebFetch / WebSearch (members: deny until granted)
const CLASSES = ['read', 'write_inside', 'delegate', 'read_outside', 'web', 'write_outside', 'send', 'admin', 'destroy', 'money'];
const SEVERITY = Object.fromEntries(CLASSES.map((c, i) => [c, i]));
const DECIDED = new Set(['read_outside', 'web', 'write_outside', 'send', 'admin', 'destroy', 'money']);
const DEST_KEYED = new Set(['send', 'money']);   // "approve for 1 hour" is per destination for these, per class for the rest

const ROLE_DEFAULTS = {
  // workers, specialists, experimental, temporary workers: nothing leaves the box, nothing outside their roots
  worker: { read_outside: 'allow', web: 'allow', write_outside: 'deny', send: 'deny', admin: 'deny', destroy: 'deny', money: 'deny' },
  // team heads (category primary, not lead): ask before sending or writing outside; never destroy
  head:   { read_outside: 'allow', web: 'allow', write_outside: 'ask', send: 'ask', admin: 'ask', destroy: 'deny', money: 'deny' },
  // lead agent(s): ask for everything decided, including destructive actions
  lead:   { read_outside: 'allow', web: 'allow', write_outside: 'ask', send: 'ask', admin: 'ask', destroy: 'ask', money: 'deny' },
  // wallet agents: the wallet firewall governs money; everything else is a worker
  wallet: { read_outside: 'allow', web: 'allow', write_outside: 'deny', send: 'deny', admin: 'deny', destroy: 'deny', money: 'firewall' },
  // agents owned by a member: nothing leaves the box, writes only in their own folders; grants (phase 3) widen this
  member: { read_outside: 'deny', web: 'deny', write_outside: 'deny', send: 'deny', admin: 'deny', destroy: 'deny', money: 'deny' },
};

// Sensitive team folders under the hub home. Which agents use them is data, not code: an agent is on a team when
// its own folder grants (policy.roots) include the team folder (set on the agent settings page or by Create team).
const TEAM_FOLDERS = ['medical', 'legal'];
/** 'medical' | 'legal' | null, from the agent's own folder grants. */
function teamFolderOf(agent) {
  const roots = (agent && agent.policy && Array.isArray(agent.policy.roots)) ? agent.policy.roots.map(r => path.resolve(String(r).replace(/^~(?=\/|$)/, HOME))) : [];
  for (const t of TEAM_FOLDERS) if (roots.includes(path.join(HUB_HOME, t))) return t;
  return null;
}

const LOCAL_HOST_RE = /^(127\.|10\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|localhost$|::1$|0\.0\.0\.0$|hubhost\b|[a-z0-9-]+\.tail[a-z0-9]+\.ts\.net$)/i;

function roleOf(agent, { isWalletAgent = () => false, isMemberOwned = () => false } = {}) {
  if (!agent) return 'worker';
  if (isWalletAgent(agent.name)) return 'wallet';
  if (agent.owner && isMemberOwned(agent)) return 'member';
  if (agent.lead === true) return 'lead';
  if (agent.category === 'primary') return 'head';
  return 'worker';
}

function defaultRoots(agent) {
  const name = agent && agent.name ? String(agent.name) : '';
  const roots = [os.tmpdir(), '/tmp', path.join(HUB_HOME, 'share')];
  if (name) roots.push(path.join(HUB_ROOT, 'workspaces', name));
  if (agent && agent.owner) roots.push(path.join(HUB_HOME, 'users', String(agent.owner)));   // the owner's own tree (files, team folders)
  if (agent && agent.lead === true) {
    // Maintaining the hub is the lead's job: the source tree and ~/agent-hub are writable without asking.
    // data/, .env and other agents' workspaces stay "admin" (see classifyPath) even inside these roots.
    roots.push(HUB_ROOT, HUB_HOME);
  }
  return [...new Set(roots.map(r => path.resolve(r)))];
}

/** Effective policy for an agent record ({name, category, lead, policy}). */
// ── Member grants ────────────────────────────────────────────────────
// What an admin may open up for member-owned agents, in three layers, each overriding the one before:
//   1. hub default for every member agent   settings.memberPolicy            { web: 'ask', ... }
//   2. per member (all of that member's)    user.grants.policy                { web: 'allow', ... }
//   3. per agent                            agent.policy.overrides            { send: 'ask', ... }
// Only these classes can be granted; changing the hub, destroying things and moving money stay denied for members.
const MEMBER_GRANTABLE = ['web', 'read_outside', 'write_outside', 'send'];
const MEMBER_NEVER = ['admin', 'destroy', 'money'];
const DECISIONS = ['allow', 'ask', 'deny'];

/** Keep only grantable classes with valid decisions; consult = list of agent names (strings, trimmed, unique). */
function sanitizeGrants(g) {
  const out = {};
  if (!g || typeof g !== 'object') return out;
  if (g.policy && typeof g.policy === 'object') {
    const pol = {};
    for (const [k, v] of Object.entries(g.policy)) if (MEMBER_GRANTABLE.includes(k) && DECISIONS.includes(v)) pol[k] = v;
    out.policy = pol;
  }
  if (Array.isArray(g.consult)) out.consult = [...new Set(g.consult.map(x => String(x).trim().toLowerCase()).filter(x => /^[a-z][a-z0-9_-]{0,63}$/.test(x)))];
  return out;
}

// Providers for the hub default and per-member grants; lazily read from settings and auth, injectable for tests.
let memberProviders = null;
function defaultMemberProviders() {
  return {
    memberDefaults: () => { try { return require('./settings').getSetting('memberPolicy') || {}; } catch { return {}; } },
    ownerGrants: (ownerId) => { try { const u = require('./auth').getAuth().getUser(String(ownerId)); return (u && u.grants) || {}; } catch { return {}; } },
  };
}
function setMemberProviders(p) { memberProviders = p; }

function policyFor(agent, opts = {}) {
  const role = roleOf(agent, opts);
  const base = { ...ROLE_DEFAULTS[role] };
  const source = {};
  for (const k of Object.keys(base)) source[k] = 'role';
  const ov = (agent && agent.policy && agent.policy.overrides) || {};
  if (role === 'member') {
    const prov = opts.memberDefaults || opts.ownerGrants ? { memberDefaults: opts.memberDefaults || (() => ({})), ownerGrants: opts.ownerGrants || (() => ({})) } : (memberProviders || defaultMemberProviders());
    const layers = [['hub', prov.memberDefaults() || {}], ['member', ((prov.ownerGrants(agent.owner) || {}).policy) || {}], ['agent', ov]];
    for (const [src, layer] of layers) for (const [k, v] of Object.entries(layer || {})) if (MEMBER_GRANTABLE.includes(k) && DECISIONS.includes(v)) { base[k] = v; source[k] = src; }
    for (const k of MEMBER_NEVER) { base[k] = 'deny'; source[k] = 'role'; }
  } else {
    for (const [k, v] of Object.entries(ov)) if (DECIDED.has(k) && DECISIONS.includes(v)) { base[k] = v; source[k] = 'agent'; }
  }
  const extraRoots = Array.isArray(agent && agent.policy && agent.policy.roots) ? agent.policy.roots.map(r => path.resolve(String(r).replace(/^~(?=\/|$)/, HOME))) : [];
  return { role, rules: base, source, roots: [...new Set([...defaultRoots(agent), ...extraRoots])] };
}

/** Agents outside its own owner that a member's agent may consult: the member's grant (lower-case names). */
function consultGrantsFor(agent, opts = {}) {
  if (!agent || !agent.owner) return [];
  const prov = opts.ownerGrants ? { ownerGrants: opts.ownerGrants } : (memberProviders || defaultMemberProviders());
  const g = sanitizeGrants(prov.ownerGrants(agent.owner) || {});
  return g.consult || [];
}

// ── Path classification ─────────────────────────────────────────────

function expandPath(p, cwd) {
  let s = String(p || '').trim().replace(/^['"]|['"]$/g, '');
  if (!s) return null;
  if (s.startsWith('~/') || s === '~') s = path.join(HOME, s.slice(1));
  if (!path.isAbsolute(s)) s = path.resolve(cwd || HUB_ROOT, s);
  return path.resolve(s);
}

function isUnder(p, root) {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Class of a write to `p` for an agent with `roots`: write_inside | write_outside | admin. */
function classifyPath(p, { roots = [], agentName = '' } = {}) {
  if (!p) return 'write_inside';
  const abs = path.resolve(p);
  // Hub-owned secrets and state, and other agents' workspaces, are "admin" wherever the roots say.
  const adminRoots = [path.join(HUB_ROOT, 'data'), path.join(HUB_ROOT, '.env'), path.join(HUB_ROOT, '.env.local'),
    path.join(HOME, '.ssh'), path.join(HOME, '.gnupg'), path.join(HOME, '.config', 'gog'), path.join(HOME, '.claude'), path.join(HOME, '.codex')];
  if (adminRoots.some(r => isUnder(abs, r))) return 'admin';
  const ws = path.join(HUB_ROOT, 'workspaces');
  if (isUnder(abs, ws)) {
    const rel = path.relative(ws, abs).split(path.sep)[0];
    if (rel && rel !== agentName) return 'admin';
  }
  if (abs === '/' || /^\/(etc|usr|bin|sbin|lib|lib64|boot|dev|proc|sys|var|root)(\/|$)/.test(abs)) return 'admin';
  return roots.some(r => isUnder(abs, r)) ? 'write_inside' : 'write_outside';
}

/** Secrets and other agents' private state: reading them is an admin action for everyone. */
const SENSITIVE_READ = [
  path.join(HUB_ROOT, '.env'), path.join(HUB_ROOT, 'data', 'users.json'), path.join(HUB_ROOT, 'data', 'auth.db'), path.join(HUB_ROOT, 'data', '.auth-key'),
  path.join(HUB_ROOT, 'data', 'push'), path.join(HUB_ROOT, 'data', 'memory.db'), path.join(HUB_ROOT, 'data', 'conversations'), path.join(HUB_ROOT, 'data', 'ledger.db'),
  path.join(HUB_ROOT, 'data', 'settings.json'), path.join(HOME, '.claude'), path.join(HOME, '.codex'), path.join(HOME, '.ssh'), path.join(HOME, '.gnupg'), path.join(HOME, '.config', 'gog'),
];
function isSensitiveRead(abs) {
  // Key files by name as well: a bot's `agent-key`, `private.key`, `*.secret` or `id_ed25519` in any workspace is a
  // secret for every agent but its owner (its owner's reads are inside its roots and never reach here as admin).
  return SENSITIVE_READ.some(r => isUnder(abs, r) || abs.startsWith(r)) || /wallet.*keystore|\.env(\.|$)/.test(abs)
    || /(^|\/)([^/]*(private|secret|agent|signing|api)[-_.]?key[^/]*|[^/]+\.(pem|secret|key)|id_(rsa|ed25519|ecdsa)[^/]*)$/i.test(abs);
}
/** Class of a READ of path p: read (inside roots), read_outside, or admin (secrets, other agents' state). */
function classifyReadPath(p, { roots = [], agentName = '' } = {}) {
  if (!p) return 'read';
  const abs = path.resolve(p);
  if (isSensitiveRead(abs)) {
    // an agent may read its own conversation log / memory via the hub tools, not the raw files
    return 'admin';
  }
  const ws = path.join(HUB_ROOT, 'workspaces');
  if (isUnder(abs, ws)) { const rel = path.relative(ws, abs).split(path.sep)[0]; if (rel && rel !== agentName) return 'read_outside'; }
  return roots.some(r => isUnder(abs, r)) ? 'read' : 'read_outside';
}
/** Every path-like token in a command (for read classification). */
function allPathsIn(seg, cwd) {
  const out = [];
  const re = /(?:^|[\s='"])((?:\/|~\/|\.\.\/)[^\s'"|;&<>)]+)/g;
  let m;
  while ((m = re.exec(seg))) { const t = m[1]; if (/^\/\//.test(t)) continue; out.push(expandPath(t, cwd)); }
  return out.filter(Boolean);
}

// ── Shell command classification ─────────────────────────────────────

const DESTROY_RE = [
  /\brm\s+(-[a-zA-Z]*[rRf][a-zA-Z]*\s+|--recursive|--force)/,
  /\b(systemctl|service)\b[^|;&]*\b(stop|restart|disable|kill|mask|daemon-reload)\b/,
  /\b(kill|pkill|killall)\b/,
  /\b(shutdown|reboot|poweroff|halt)\b/,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*[fd]|push\b[^|;&]*(--force|-f\b|\+))/,
  /\bgit\s+branch\s+-D\b/,
  /\b(mkfs|fdisk|parted|dd\s+if=)/,
  /\btruncate\s+-s\s*0\b/,
  /\b(drop|truncate)\s+table\b/i,
  /\bdocker\s+(rm|stop|kill|system\s+prune)\b/,
  /\bcrontab\s+-r\b/,
  /\bchmod\s+(-R\s+)?[0-7]*0{2}\b\s+\//,
  /\bcurl\b[^|;&]*\/api\/(restart|hub\/halt)\b/,
  /\btailscale\s+(down|logout)\b/,
];
const SEND_RE = [
  /\bgog\s+gmail\s+send\b/, /\bgog\s+\S+\s+(send|share|create|update|delete|reply|forward|insert|remove)\b/,
  /\b(sendmail|mail|mailx|mutt|msmtp|swaks)\b/,
  /\bgit\s+push\b/, /\bgh\s+(pr\s+(create|merge|comment|review|close)|issue\s+(create|comment|close)|release\s+(create|upload)|repo\s+(create|delete)|api\s+(-X\s*(POST|PUT|PATCH|DELETE)|--method|-f\s|-F\s))/,
  /\b(ssh|scp|sftp|rsync)\b[^|;&]*\S+@\S+/, /\brsync\b[^|;&]*\s\S+:\S*/, /\bscp\b[^|;&]*\s\S+:\S*/,
  /\btailscale\s+(file\s+cp|send)\b/,
  /\b(nc|ncat|netcat|socat|telnet)\b/,
  /\bhttp\s+(POST|PUT|PATCH|DELETE)\b/,
  /\btelegram|\bslack\b.*\b(post|send)\b/i,
  /\b(aws|gcloud|az)\s+\S+\s+(put|cp|sync|upload|publish|send|create|delete)\b/,
  /\bnpm\s+publish\b/, /\bpip\s+upload\b|\btwine\s+upload\b/,
];
const WRITE_VERB_RE = /(^|\s)(cp|mv|mkdir|touch|tee|ln|install|rmdir|chmod|chown|truncate|unzip|tar\s+(-?x|--extract)|git\s+(checkout|clone|worktree|init|apply|am|stash)|sed\s+-i|patch)\b/;
const RM_PLAIN_RE = /(^|\s)rm\s+(?!-)/;

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

function curlClass(seg) {
  // POST/PUT/PATCH/DELETE or a body means "send" unless every URL in the segment is local.
  const mutating = /\s-X\s*(POST|PUT|PATCH|DELETE)\b|\s--request\s+(POST|PUT|PATCH|DELETE)\b|\s(-d|--data(-\w+)?|-F|--form|-T|--upload-file|--json)\b/i.test(seg);
  if (!mutating) return 'read';
  const urls = seg.match(/https?:\/\/[^\s'"]+/gi) || [];
  if (!urls.length) return 'send';
  const hosts = urls.map(hostOf).filter(Boolean);
  if (hosts.length && hosts.every(h => LOCAL_HOST_RE.test(h))) return 'write_inside';
  return 'send';
}

// Only the ARGUMENTS of a write verb and the TARGETS of a redirection count as written paths. Scanning a
// whole segment for slash-tokens flagged awk/sed/grep regex literals ("/class=/") and comparisons
// ("NR>s") as writes outside the roots, which parked the lead's read-only commands on approval cards.

/** Quoted ranges [start, end) of single/double quoted strings in seg. */
function quotedRanges(seg) {
  const out = [];
  const re = /'[^']*'|"[^"]*"/g;
  let m;
  while ((m = re.exec(seg))) out.push([m.index, m.index + m[0].length]);
  return out;
}
function insideQuotes(ranges, i) { return ranges.some(([a, b]) => i > a && i < b); }

/** Shell words of seg with quotes removed (quoted words stay whole). */
function words(seg) {
  const out = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(seg))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Targets of > and >> that are not inside quotes and not fd duplications (2>&1). */
function redirectTargets(seg, cwd) {
  const ranges = quotedRanges(seg);
  const out = [];
  const re = /(^|[\s\d])>{1,2}\s*('([^']*)'|"([^"]*)"|([^\s|;&<>]+))/g;
  let m;
  while ((m = re.exec(seg))) {
    const at = m.index + m[1].length;
    if (insideQuotes(ranges, at)) continue;
    const t = m[3] ?? m[4] ?? m[5];
    if (!t || /^&/.test(t) || t === '/dev/null') continue;
    out.push(expandPath(t, cwd));
  }
  return out.filter(Boolean);
}

const LAST_ARG_VERBS = new Set(['cp', 'mv', 'install', 'ln', 'rsync']);
const ALL_ARG_VERBS = new Set(['mkdir', 'touch', 'tee', 'rmdir', 'truncate', 'rm', 'unzip', 'patch']);
const SKIP_FIRST_VERBS = new Set(['chmod', 'chown', 'chgrp']);

/** Paths written by the write verbs in seg (verb arguments only). */
function verbTargets(seg, cwd) {
  const ws = words(seg);
  const out = [];
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    let args = ws.slice(i + 1);
    const nonFlags = (a) => a.filter(x => !/^-/.test(x));
    if (LAST_ARG_VERBS.has(w)) {
      const a = nonFlags(args).filter(x => !/^\S+@\S+:/.test(x));
      if (a.length >= 2) out.push(expandPath(a[a.length - 1], cwd));
      else if (a.length === 1) out.push(expandPath(a[0], cwd));
      break;
    }
    if (ALL_ARG_VERBS.has(w)) { for (const a of nonFlags(args)) out.push(expandPath(a, cwd)); break; }
    if (SKIP_FIRST_VERBS.has(w)) { for (const a of nonFlags(args).slice(1)) out.push(expandPath(a, cwd)); break; }
    if (w === 'sed' && args.some(a => /^-[a-zA-Z]*i/.test(a))) { const a = nonFlags(args); for (const f of a.slice(1)) out.push(expandPath(f, cwd)); break; }
    if (w === 'tar' && args.some(a => /^-?[a-zA-Z]*x|^--extract/.test(a))) { const ci = args.indexOf('-C'); if (ci >= 0 && args[ci + 1]) out.push(expandPath(args[ci + 1], cwd)); else out.push(cwd); break; }
    if (w === 'git' && /^(clone|worktree|init)$/.test(args[0] || '')) { const a = nonFlags(args.slice(1)).filter(x => !/^(https?:|git@|ssh:)/.test(x) && !/^(add|remove|prune|list)$/.test(x)); if (a.length) out.push(expandPath(a[a.length - 1], cwd)); else out.push(cwd); break; }
  }
  return out.filter(Boolean);
}

function pathsIn(seg, cwd) {
  return [...redirectTargets(seg, cwd), ...verbTargets(seg, cwd)];
}

/** seg with quoted strings blanked, for verb/pattern tests that must not fire on string contents. */
function unquotedText(seg) { return seg.replace(/'[^']*'|"[^"]*"/g, ' '); }

// Quoted strings are data (a grep pattern, an echo, a commit message) unless the segment hands them to an
// interpreter or shell, in which case they are code and the whole text is inspected.
const INTERPRETER_RE = /(^|\s|\|)(bash|sh|zsh|dash|eval|exec|xargs|node\s+-e|node\s+--eval|python3?\s+-c|perl\s+-e|ruby\s+-e|osascript|sudo|env|nohup|timeout|watch|su)\b/;
function codeText(s) { return INTERPRETER_RE.test(s) ? s : unquotedText(s); }

// Privilege escalation at the head of a segment (after any VAR=value prefixes): sudo, doas, pkexec, su.
const SUDO_HEAD_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(sudo|doas|pkexec|su)(?=\s|$)/;
const SUDO_STRIP_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:sudo|doas|pkexec)(?:\s+--?[A-Za-z][-A-Za-z]*(?:=\S+|\s+(?!-)\S+)?)*\s*/;

function classifySegment(seg, { cwd, roots, agentName }) {
  const s = seg.trim();
  if (!s || /^#/.test(s)) return { cls: 'read' };
  // Running as root is at least an admin action, whatever the command behind it does; the inner command may make it
  // worse (sudo rm -rf / is destroy). `su` opens a root shell: admin with nothing to look inside. The decision
  // layer reserves root for the lead agent (2026-10-16 review, H01/F24; the owner keeps root through the lead).
  const sm = s.match(SUDO_HEAD_RE);
  if (sm) {
    const tool = sm[1];
    const inner = tool === 'su' ? '' : s.replace(SUDO_STRIP_RE, '');
    const r = inner && inner !== s ? classifySegment(inner, { cwd, roots, agentName }) : { cls: 'read' };
    const cls = SEVERITY[r.cls] > SEVERITY.admin ? r.cls : 'admin';
    return { ...r, cls, sudo: true, reason: `runs as root (${tool})${r.reason ? ': ' + r.reason : ''}` };
  }
  const code = codeText(s);
  for (const re of DESTROY_RE) if (re.test(code)) return { cls: 'destroy', reason: 'destructive command' };
  if (RM_PLAIN_RE.test(s)) {
    const ps = pathsIn(s, cwd);
    const worst = ps.map(p => classifyPath(p, { roots, agentName })).sort((a, b) => SEVERITY[b] - SEVERITY[a])[0] || 'write_inside';
    return { cls: worst === 'write_inside' ? 'write_inside' : worst, reason: 'rm', paths: ps };
  }
  for (const re of SEND_RE) if (re.test(code)) return { cls: 'send', reason: 'leaves the machine' };
  if (/(^|\s)(curl|wget|http|xh)\b/.test(s)) {
    if (/\bwget\b/.test(s) && /--post|--method=(POST|PUT|DELETE)/i.test(s)) return { cls: 'send', reason: 'HTTP write' };
    const c = curlClass(s);
    if (c !== 'read') return { cls: c, reason: 'HTTP write' };
  }
  const ps0 = pathsIn(s, cwd);
  const writes = ps0.length > 0 || WRITE_VERB_RE.test(unquotedText(s));
  if (writes) {
    const ps = ps0;
    if (!ps.length) return { cls: 'write_inside', reason: 'write in cwd' };
    const classes = ps.map(p => classifyPath(p, { roots, agentName }));
    const worst = classes.sort((a, b) => SEVERITY[b] - SEVERITY[a])[0];
    return { cls: worst, reason: `writes ${ps.length} path(s)`, paths: ps };
  }
  // A read: secrets are admin for everyone; outside the roots is read_outside (members are denied, others allowed).
  const rp = allPathsIn(unquotedText(s), cwd).concat(allPathsIn(s, cwd));
  if (rp.length) {
    const classes = rp.map(p => classifyReadPath(p, { roots, agentName }));
    const worst = classes.sort((a, b) => SEVERITY[b] - SEVERITY[a])[0];
    if (worst !== 'read') return { cls: worst, reason: 'reads outside the allowed folders', paths: rp };
  }
  return { cls: 'read' };
}

/** Classify a shell command for an agent. Returns { cls, reason, paths } for the worst segment. */
function classifyCommand(command, { cwd = HUB_ROOT, roots = [], agentName = '' } = {}) {
  let text = String(command || '');
  // A heredoc body (python3 - <<'EOF' ... EOF) is data for the program, not shell: classify only the
  // command line that introduces it. (Paths the program itself writes are a known limit, see the header.)
  const hd = text.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?[^\n]*\n/);
  if (hd) text = text.slice(0, hd.index + hd[0].length);
  // split on pipes and chains but not inside quotes (good enough for classification)
  const segs = text.split(/\s*(?:&&|\|\||;|\|)\s*(?=(?:[^'"]|'[^']*'|"[^"]*")*$)/);
  let worst = { cls: 'read' };
  let sudo = false;
  for (const seg of segs) {
    const r = classifySegment(seg, { cwd, roots, agentName });
    if (r.sudo) sudo = true;
    if (SEVERITY[r.cls] > SEVERITY[worst.cls]) worst = r;
  }
  return sudo ? { ...worst, sudo: true, reason: worst.sudo ? worst.reason : `${worst.reason ? worst.reason + '; ' : ''}runs as root (sudo)` } : worst;
}

// ── Tool classification (all paths) ──────────────────────────────────

const HUB_READ = new Set(['read_memory', 'read_session_notes', 'read_shared_memory', 'search_shared_memory', 'list_agents', 'read_tiger_team_archive', 'recall', 'recall_context', 'record_list',
  'list_jobs', 'job_status', 'list_scheduled_tasks', 'comms_channels', 'wallet_status', 'wallet_balances', 'wallet_read_contract', 'wallet_quote_swap']);
const HUB_WRITE_INSIDE = new Set(['write_memory', 'append_memory', 'write_session_notes', 'write_shared_memory', 'ask_user', 'request_agent', 'rename_me', 'record_write', 'compress_context', 'generate_image']);
const HUB_DELEGATE = new Set(['consult_agent', 'spawn_workers', 'schedule_task', 'cancel_scheduled_task', 'job_cancel', 'start_tiger_team', 'create_task', 'continue_tiger_team']);
const SKILL_READ_RE = /(^|_)(list|get|read|search|fetch|query|check|preview|describe|find|lookup|history|status|show|view)(_|$)/i;
const SKILL_SEND_RE = /send|post|reply|comment|create_issue|create_pull|merge|push|share|invite|publish|email|message|notify|webhook/i;

// Pluggable classifiers (lib/connectors registers one for "<connector>__<tool>" names): consulted before the
// generic skill-name heuristics, first non-null answer wins.
const EXTRA_CLASSIFIERS = [];
function registerToolClassifier(fn) { if (typeof fn === 'function' && !EXTRA_CLASSIFIERS.includes(fn)) EXTRA_CLASSIFIERS.push(fn); return () => { const i = EXTRA_CLASSIFIERS.indexOf(fn); if (i >= 0) EXTRA_CLASSIFIERS.splice(i, 1); }; }

function stripMcp(name) {
  const m = String(name || '').match(/^mcp__[^_]+(?:_[^_]+)*__(.+)$/);
  return m ? m[1] : String(name || '');
}

function summarize(input, keys) {
  for (const k of keys) { const v = input && input[k]; if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 160); }
  return '';
}

/**
 * classifyTool({ tool, input, agent, policy, cwd }) -> { cls, summary, detail, destKey }
 * tool: SDK built-in name (Bash, Write...), hub MCP name (mcp__agent-hub__consult_agent or consult_agent),
 * or a skill tool (slack__send_message, github__create_issue).
 */
function classifyTool({ tool, input = {}, agentName = '', policy, cwd }) {
  const name = String(tool || '');
  const bare = stripMcp(name);
  const roots = (policy && policy.roots) || [];
  const wsCwd = cwd || path.join(HUB_ROOT, 'workspaces', agentName || '');
  const inp = input && typeof input === 'object' ? input : {};
  // The hub's own hands (lib/hub-tools) reach a Claude-client agent as the MCP server "hub": mcp__hub__Bash is
  // the same shell as Bash and is classified the same way. (Found by the 2026-10-16 security review, F04: before
  // this the names fell through to the "read" default and hub-hands agents were never gated.)
  const builtin = /^mcp__hub__/.test(name) ? bare : name;

  // Claude client built-ins (and the hub's hands under the same names)
  if (['WebSearch', 'WebFetch'].includes(builtin)) return { cls: 'web', summary: summarize(inp, ['url', 'query']), destKey: hostOf(inp.url || '') || 'search' };
  if (['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'].includes(builtin)) {
    const p = inp.file_path || inp.notebook_path || inp.path || '';
    const abs = p ? expandPath(p, wsCwd) : '';
    const cls = abs ? classifyReadPath(abs, { roots, agentName }) : 'read';
    return { cls, summary: abs || summarize(inp, ['pattern', 'query']), detail: abs ? { path: abs } : undefined, destKey: abs ? path.dirname(abs) : '' };
  }
  if (['TodoWrite', 'TodoRead', 'ToolSearch', 'Monitor', 'ListAgents', 'Skill'].includes(builtin)) return { cls: 'read', summary: '' };
  if (['Agent', 'Task', 'SendMessage', 'Workflow'].includes(builtin)) return { cls: 'delegate', summary: summarize(inp, ['description', 'prompt']) };
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(builtin)) {
    const p = expandPath(inp.file_path || inp.notebook_path || '', wsCwd);
    const cls = classifyPath(p, { roots, agentName });
    return { cls, summary: p || '(no path)', detail: { path: p }, destKey: p ? path.dirname(p) : '' };
  }
  // Restarting the hub ends every agent's turn: an admin action, never a plain read (review F50).
  if (bare === 'RestartHub') return { cls: 'admin', summary: 'restart the hub', detail: { reason: summarize(inp, ['reason', 'resume']) }, destKey: 'RestartHub' };
  if (builtin === 'Bash') {
    const cmd = String(inp.command || '');
    const r = classifyCommand(cmd, { cwd: wsCwd, roots, agentName });
    const dest = r.cls === 'send' ? (hostOf((cmd.match(/https?:\/\/[^\s'"]+/) || [''])[0]) || (cmd.match(/--to\s+(\S+)/) || [])[1] || (cmd.match(/\b(\S+@\S+)\b/) || [])[1] || cmd.split(/\s+/)[0]) :
      r.paths && r.paths.length ? path.dirname(r.paths[0]) : cmd.split(/\s+/)[0];
    return { cls: r.cls, summary: cmd.slice(0, 200), detail: { command: cmd.slice(0, 2000), reason: r.reason, paths: r.paths, ...(r.sudo ? { sudo: true } : {}) }, destKey: dest };
  }

  // Hub tools
  if (HUB_READ.has(bare)) return { cls: 'read', summary: summarize(inp, ['section', 'topic', 'query', 'id']) };
  if (HUB_WRITE_INSIDE.has(bare)) return { cls: 'write_inside', summary: summarize(inp, ['section', 'topic', 'question']) };
  if (HUB_DELEGATE.has(bare)) return { cls: 'delegate', summary: summarize(inp, ['agent', 'label', 'prompt', 'objective']) };
  if (bare === 'run_job') {
    const cmd = String(inp.command || '');
    const r = classifyCommand(cmd, { cwd: wsCwd, roots, agentName });
    const cls = SEVERITY[r.cls] > SEVERITY.delegate ? r.cls : 'delegate';
    return { cls, summary: `${inp.name || 'job'}: ${cmd.slice(0, 160)}`, detail: { command: cmd.slice(0, 2000), reason: r.reason, paths: r.paths, ...(r.sudo ? { sudo: true } : {}) }, destKey: r.paths && r.paths.length ? path.dirname(r.paths[0]) : cmd.split(/\s+/)[0] };
  }
  if (bare === 'create_agent') return { cls: 'admin', summary: `create agent ${inp.name || ''}`, detail: { name: inp.name, model: inp.model }, destKey: 'create_agent' };
  if (bare === 'comms_send') return { cls: 'send', summary: `${inp.channel || 'message'} to ${inp.to || '?'}: ${String(inp.text || '').slice(0, 120)}`, detail: { channel: inp.channel, to: inp.to, text: String(inp.text || '').slice(0, 2000) }, destKey: `${inp.channel || ''}:${inp.to || ''}` };
  if (/^wallet_|^hl_/.test(bare)) return { cls: 'money', summary: summarize(inp, ['coin', 'to', 'amount']), destKey: bare };

  for (const fn of EXTRA_CLASSIFIERS) { try { const r = fn({ tool: bare, input: inp, agentName }); if (r && r.cls) return r; } catch {} }
  // Skill tools (slack__, github__, google_workspace__, ...)
  if (/__/.test(bare) || /^(slack|github|google|gmail|notion|jira|linear)/i.test(bare)) {
    if (SKILL_READ_RE.test(bare)) return { cls: 'read_outside', summary: `${bare} ${summarize(inp, ['query', 'channel_id', 'owner'])}`.trim(), destKey: bare };   // the admin's external accounts
    if (SKILL_SEND_RE.test(bare)) return { cls: 'send', summary: summarize(inp, ['channel_id', 'to', 'title', 'text', 'body']), detail: { tool: bare, input: JSON.stringify(inp).slice(0, 2000) }, destKey: `${bare}:${inp.channel_id || inp.to || inp.owner || ''}` };
    return { cls: 'write_outside', summary: summarize(inp, ['title', 'documentId', 'spreadsheetId', 'name']), detail: { tool: bare, input: JSON.stringify(inp).slice(0, 2000) }, destKey: bare };
  }
  return { cls: 'read', summary: '' };
}

// ── Decision ─────────────────────────────────────────────────────────

/**
 * decide({ agent, tool, input, cwd, allowances, isWalletAgent }) ->
 *   { decision: 'allow'|'ask'|'deny', cls, summary, detail, destKey, allowKey, reason, role }
 */
function decide({ agent, tool, input, cwd, allowances = null, isWalletAgent = () => false, isMemberOwned = () => false, capped = false, rootGranted = false }) {
  const pol = policyFor(agent, { isWalletAgent, isMemberOwned });
  const c = classifyTool({ tool, input, agentName: agent && agent.name, policy: pol, cwd });
  const allowKey = DEST_KEYED.has(c.cls) ? `${agent && agent.name}|${c.cls}|${c.destKey || ''}` : `${agent && agent.name}|${c.cls}`;
  // Root is the lead agent's alone (the owner keeps root on the machine through the lead): every other role is refused
  // outright, whatever its admin rule says, unless the operator granted that agent root for a while (lib/root-grants;
  // never for a member's agent). For the lead, and for a granted agent, it is an admin action: audited by the gate,
  // a card when the owner asks for one (settings.approvalClasses).
  if (c.detail && c.detail.sudo && pol.role !== 'lead') {
    if (!rootGranted || pol.role === 'member') return { decision: 'deny', ...c, allowKey, role: pol.role, reason: `${pol.role} policy: running a command as root (sudo) is reserved for the lead agent${pol.role === 'member' ? '' : '; the operator can grant it for a while on this agent\'s settings page'}` };
    if (allowances && allowances.has(allowKey)) return { decision: 'allow', ...c, allowKey, role: pol.role, reason: 'root granted by the operator; approved earlier for this kind of action' };
    return { decision: 'ask', ...c, allowKey, role: pol.role, reason: `${pol.role} policy: root granted by the operator for a limited time` };
  }
  if (!DECIDED.has(c.cls)) return { decision: 'allow', ...c, allowKey, role: pol.role, reason: 'always allowed' };
  let rule = pol.rules[c.cls];
  if (c.cls === 'money') {
    if (rule === 'firewall') return { decision: 'allow', ...c, allowKey, role: pol.role, reason: 'wallet firewall governs' };
    return { decision: 'deny', ...c, allowKey, role: pol.role, reason: 'no wallet access' };
  }
  if (capped && rule === 'allow') rule = 'ask';   // over a spend cap: everything decided needs a nod
  if (rule === 'ask' && allowances && allowances.has(allowKey)) return { decision: 'allow', ...c, allowKey, role: pol.role, reason: DEST_KEYED.has(c.cls) ? 'approved earlier for this destination' : 'approved earlier for this kind of action' };
  return { decision: rule, ...c, allowKey, role: pol.role, reason: `${pol.role} policy: ${c.cls} = ${rule}` };
}

/** Text the agent sees when a call is refused or not approved. */
function denialText({ decision, cls, role, reason, summary }, { by = 'policy' } = {}) {
  const what = /as root/.test(String(reason || '')) ? 'running a command as root (sudo)'
    : ({ read_outside: 'reading outside your own folders', web: 'web access', write_outside: 'writing outside your allowed folders', send: 'sending anything off this machine', admin: 'reading or changing hub data, credentials or another agent\'s files', destroy: 'a destructive action', money: 'wallet or exchange tools' }[cls] || cls);
  if (by === 'timeout') return `[NOT APPROVED] The owner did not answer the approval request for ${what} within the time limit, so it was not done (${summary}). Say so in your reply and continue without it.`;
  if (by === 'owner') return `[DENIED BY OWNER] The owner declined ${what} (${summary}). Do not retry it; say so in your reply and continue without it.`;
  return `[DENIED BY POLICY] ${what} is not allowed for this agent (${reason}; ${summary}). Do not work around it: report what you need to the agent that asked you, or to the owner.`;
}

// ── Allowances: "approve this kind for 1 hour" ────────────────────────
function createAllowances({ now = Date.now } = {}) {
  const map = new Map();   // allowKey -> expiresAt
  return {
    add(key, ttlMs = 60 * 60 * 1000) { map.set(key, now() + ttlMs); return map.get(key); },
    has(key) { const t = map.get(key); if (!t) return false; if (t <= now()) { map.delete(key); return false; } return true; },
    list() { const t = now(); return [...map.entries()].filter(([, e]) => e > t).map(([key, expiresAt]) => ({ key, expiresAt: new Date(expiresAt).toISOString() })); },
    clear(key) { if (key) map.delete(key); else map.clear(); },
  };
}

module.exports = {
  CLASSES, DECIDED, ROLE_DEFAULTS, HUB_ROOT, HUB_HOME, TEAM_FOLDERS, teamFolderOf,
  roleOf, policyFor, defaultRoots, sanitizeGrants, consultGrantsFor, setMemberProviders, MEMBER_GRANTABLE, MEMBER_NEVER, classifyPath, classifyReadPath, isSensitiveRead, classifyCommand, classifyTool, decide, denialText, createAllowances, stripMcp, registerToolClassifier,
};
