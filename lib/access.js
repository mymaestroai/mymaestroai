'use strict';
// Who may reach what. Three kinds of agent, one owner each:
//   infrastructure  owner null        admin-only (maestro, the worker pool, research/audit agents)
//   personal        owner = an admin  admin-only (GP, Counsel, Home Care and their specialists)
//   member-owned    owner = a member  that member and every admin
// A member sees ONLY the agents they own. Admins see everything and switch owners in the sidebar.
//
// Routes are classified once here (public / session / admin / agent-scoped) so server.js enforces
// one rule at the top instead of 180 ad-hoc checks. Agent-scoped routes name the agent in the path
// (/api/agents/<name>/..., /api/history/<name>, /api/session/<name>) or the body ({ agent }).

const PUBLIC_EXACT = new Set(['/', '/login', '/invite', '/setup-admin', '/setup', '/welcome', '/help', '/api/welcome/state', '/api/welcome/restore/upload', '/api/welcome/restore/prepare', '/api/welcome/restore/confirm', '/health', '/manifest.json', '/sw.js', '/favicon.ico', '/mobile', '/mobile.html', '/index.html', '/login.html', '/app.js', '/mobile.js', '/comms-panel.js', '/vendor/qrcode.min.js',
  '/api/auth/login', '/api/auth/logout', '/api/auth/status', '/api/auth/totp/verify', '/api/auth/invite', '/api/auth/invite/accept', '/api/auth/setup', '/api/chat/alert', '/api/codex-bridge/rpc']);
const PUBLIC_PREFIXES = ['/icons/'];

// API tokens (lib/auth createToken): the routes each scope may call. Anything not listed here is refused for a token.
const TOKEN_ROUTES = {
  chat: [['POST', '/api/chat'], ['POST', '/api/chat/stream']],
  interject: [['POST', '/api/chat/interject'], ['POST', '/api/chat/stop']],
  status: [['GET', '/api/health'], ['GET', '/api/hub/status'], ['GET', '/api/agents/status'], ['GET', /^\/api\/agents\/[^/]+\/turn$/]],
  'wallet-executor': [['POST', '/api/wallet/execute'], ['GET', '/api/wallet/executor']],
  'openai-api': [['GET', '/v1/models'], ['POST', '/v1/chat/completions']],
};
const AGENT_SCOPED = new Set(['chat', 'interject']);
/** tokenAllows(token, pathname, method, { agent }) -> { ok, scope } | { ok: false, reason } */
function tokenAllows(token, pathname, method = 'GET', { agent = null } = {}) {
  const p = String(pathname || '').replace(/\/+$/, '') || '/';
  const m = String(method || 'GET').toUpperCase();
  for (const scope of (token && token.scopes) || []) {
    for (const [mm, pat] of TOKEN_ROUTES[scope] || []) {
      if (mm !== m || !(typeof pat === 'string' ? pat === p : pat.test(p))) continue;
      if (AGENT_SCOPED.has(scope) && !(agent && (token.agents || []).includes(String(agent)))) return { ok: false, reason: `the token may not address agent "${agent || '?'}"` };
      return { ok: true, scope };
    }
  }
  return { ok: false, reason: 'outside the token\'s scopes' };
}

// Member-usable (any signed-in user; the handler filters by access where needed).
const SESSION_EXACT = new Set(['/api/me', '/api/me/timezone', '/api/agents', '/api/agents/status', '/api/events', '/api/push/vapid-public-key', '/api/push/subscribe', '/api/push/unsubscribe', '/api/push/test', '/api/push/status', '/api/hub/status', '/api/health', '/api/version', '/api/auth/totp/begin', '/api/auth/totp/confirm', '/api/auth/totp/disable', '/api/auth/password', '/api/auth/sessions', '/api/auth/sessions/revoke',
  '/api/files', '/api/files/upload', '/api/files/download', '/api/files/mkdir', '/api/files/rename',   // Files area: the handler resolves the owner (members: own folder only)
  '/api/recall', '/api/recall/context',   // transcript search: the handler checks access to the named agent
  '/api/workers',   // worker history across agents: the handler lists only agents this person may open
  '/api/recordings',   // call recordings: the agents whose list holds the caller (the handler filters; the other /api/recordings/* routes: SESSION_PATH and AGENT_BODY below)
  '/api/voice/status',   // voice: engine state for the pages (enable/disable stay admin-only; web files: SESSION_PATH below)
  '/api/faces']);   // character packs for the call face view: the list (their files: SESSION_PATH below)

// Agent-scoped: the handler is reached only if the user may access the named agent.
const AGENT_BODY = new Set(['/api/chat', '/api/chat/stream', '/api/chat/interject', '/api/chat/stop', '/api/ask_response', '/api/cancel-worker', '/api/voice/tts', '/api/voice/call', '/api/voice/call/decide',
  '/api/recordings/transcript', '/api/recordings/text', '/api/recordings/pause', '/api/recordings/consent', '/api/recordings/trouble']);   // call recordings, the person on the recorded call (lib/recordings/routes: also checks the call and its owner)
// Agent named in the query string (?agent=) or the X-Agent header: for routes whose body is not JSON (audio upload).
const AGENT_QUERY = new Set(['/api/voice/stt', '/api/recordings/segment']);
// Session routes with a variable tail: the six browser files of the speech detector (the handler serves only listed names).
const SESSION_PATH = [/^\/api\/voice\/web\/[^/]+$/,
  // Call recordings, for the allowed users: any signed-in user reaches the handler, which refuses (403 not_allowed) unless the caller's id is on that agent's list. Admins get no exception.
  /^\/api\/recordings\/[^/]+(?:\/[^/]+){1,3}$/, /^\/api\/faces\/[a-z0-9-]{1,40}\/(?:manifest\.json|[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,3})$/];   // + a character pack's files: safe relative segments (no "..", no hidden part, no encoding); the handler serves only the pack's own manifest-listed files (clips, tracks, beak, posters)
const AGENT_PATH = [/^\/api\/history\/([^/]+)$/, /^\/api\/session\/([^/]+)$/, /^\/api\/agents\/([^/]+)\/(files|model|display|icon|records|transcript|compaction|turn|notify|workers)(\/|$)/, /^\/api\/agents\/([^/]+)$/, /^\/api\/memory\/([^/]+)\/stats$/, /^\/api\/image\/([^/]+)/];

// Everything else under /api, and the admin pages, is admin-only.
const ADMIN_PAGES = new Set(['/tiger-team', '/agent-settings.html', '/users', '/users.html', '/agent-settings', '/modules', '/modules.html', '/modules.js', '/local-models', '/local-models.html']);

// Fixed agent-management routes that look like /api/agents/<name> but are admin actions.
const ADMIN_EXACT = new Set(['/api/agents/create', '/api/agents/clone', '/api/agents/rename', '/api/agents/reload']);

function classifyRoute(pathname, method = 'GET') {
  const p = String(pathname || '').replace(/\/+$/, '') || '/';
  if (p === '/v1' || p.startsWith('/v1/')) return { kind: 'api' };   // OpenAI-compatible endpoints: token or admin (server.js gate)
  if (PUBLIC_EXACT.has(p) || PUBLIC_PREFIXES.some(x => p.startsWith(x))) return { kind: 'public' };
  if (!p.startsWith('/api/')) {
    if (ADMIN_PAGES.has(p) || /^\/oauth\/callback\/[a-z][a-z0-9-]{1,31}$/.test(p)) return { kind: 'admin', page: true };   // a data connector's sign-in comes back here
    return { kind: 'session', page: true };   // other static assets and pages: any signed-in user
  }
  if (ADMIN_EXACT.has(p)) return { kind: 'admin' };
  if (SESSION_EXACT.has(p)) return { kind: 'session' };
  if (AGENT_BODY.has(p)) return { kind: 'agent', from: 'body' };
  if (AGENT_QUERY.has(p)) return { kind: 'agent', from: 'query' };
  if (SESSION_PATH.some(re => re.test(p))) return { kind: 'session' };
  for (const re of AGENT_PATH) { const m = p.match(re); if (m) return { kind: 'agent', from: 'path', agent: safeDecode(m[1]) }; }
  return { kind: 'admin' };
}

/** decodeURIComponent that never throws: a bad escape in a path is a bad agent name, not a crash (review F07). */
function safeDecode(s) { try { return decodeURIComponent(s); } catch { return String(s); } }

function isAdmin(user) { return !!user && user.role === 'admin'; }

/** ownerOf(agentRecord) -> user id | null (infrastructure) */
function ownerOf(agent) { return agent && agent.owner ? String(agent.owner) : null; }
/** Members an admin has shared this agent with (admins may share any agent, including infrastructure). */
function sharedWith(agent) { return Array.isArray(agent && agent.sharedWith) ? agent.sharedWith.map(String) : []; }
function memberMayUse(user, agent) { return !!user && !!agent && (ownerOf(agent) === user.id || sharedWith(agent).includes(user.id)); }

/**
 * canAccessAgent(user, agentName, { agents, resolveVirtual })
 * agents: array of agent records; resolveVirtual(name) -> { parent } for temporary workers (tw-*).
 */
function canAccessAgent(user, agentName, { agents = [], resolveVirtual = () => null } = {}) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  let name = String(agentName || '');
  // A worker of a worker resolves up to the named agent (a few levels at most).
  for (let i = 0; i < 5; i++) {
    const v = resolveVirtual(name);
    if (!(v && v.parent)) break;
    name = String(v.parent);
  }
  const a = agents.find(x => x.name === name);
  if (!a) return false;
  return memberMayUse(user, a);
}

const CALLER_HIDDEN = 'consulted by another agent';
/** redactCaller(entry, mayUse) -> a copy of a status entry without the caller's name unless mayUse(caller) is true. */
function redactCaller(entry, mayUse) {
  const copy = { ...entry };
  if (copy.consultedBy && !mayUse(copy.consultedBy)) {
    delete copy.consultedBy;
    if (typeof copy.activity === 'string' && copy.activity.startsWith('consulted by ')) copy.activity = CALLER_HIDDEN;
  }
  return copy;
}

/** redactTurnForViewer(turn, mayUse) -> the turn, with a consultation's caller name hidden when mayUse(caller) is false. */
function redactTurnForViewer(turn, mayUse) {
  const o = turn && turn.origin;
  if (!o || o.kind !== 'consultation' || !o.from || mayUse(o.from)) return turn;
  const copy = { ...turn, origin: { kind: 'consultation' } };
  if (typeof copy.activity === 'string' && copy.activity.startsWith('consulted by ')) copy.activity = CALLER_HIDDEN;
  return copy;
}

/**
 * statusForViewer(user, statuses, { agents, resolveVirtual }) -> a new status map for this viewer.
 * Admin: every entry. Member: entries for agents (and workers of agents) they may use; consultedBy is dropped when the caller is not theirs.
 */
function statusForViewer(user, statuses, { agents = [], resolveVirtual = () => null } = {}) {
  const out = {};
  if (!user) return out;
  const admin = isAdmin(user);
  const opts = { agents, resolveVirtual };
  for (const [name, entry] of Object.entries(statuses || {})) {
    if (admin) { out[name] = { ...entry }; continue; }
    if (!canAccessAgent(user, name, opts)) continue;
    out[name] = redactCaller(entry, (n) => canAccessAgent(user, n, opts));
  }
  return out;
}

/** Agents a user may see. Admins: all (optionally one owner's: ownerFilter 'mine' | 'infra' | <userId>). */
function visibleAgents(user, agents, { ownerFilter = null } = {}) {
  if (!user) return [];
  if (!isAdmin(user)) return (agents || []).filter(a => memberMayUse(user, a));
  if (!ownerFilter) return agents || [];
  if (ownerFilter === 'infra') return agents.filter(a => !ownerOf(a));
  if (ownerFilter === 'mine') return agents.filter(a => !ownerOf(a) || ownerOf(a) === user.id);
  return agents.filter(a => ownerOf(a) === ownerFilter);
}

/**
 * Agents an agent may consult / see in list_agents. Infrastructure agents (no owner) and agents owned by
 * admins form one pool, the admin side; a member's agents see only that member's agents.
 * adminIds: Set of admin user ids (so "owned by an admin" can be told from "owned by a member").
 */
function peersOf(callerName, agents, { resolveVirtual = () => null, adminIds = new Set() } = {}) {
  let name = String(callerName || '');
  const v = resolveVirtual(name);
  if (v && v.parent) name = String(v.parent);
  const me = (agents || []).find(a => a.name === name);
  const owner = ownerOf(me);
  const adminSide = (a) => !ownerOf(a) || adminIds.has(ownerOf(a));
  if (!owner || adminIds.has(owner)) return (agents || []).filter(adminSide);
  return (agents || []).filter(a => ownerOf(a) === owner);
}
function sameOwner(callerName, targetName, agents, opts = {}) {
  return peersOf(callerName, agents, opts).some(a => a.name === String(targetName || ''));
}

/** Owner switcher entries for an admin. */
function ownerEntries(agents, users) {
  const byOwner = new Map();
  for (const a of agents || []) { const o = ownerOf(a) || 'infra'; byOwner.set(o, (byOwner.get(o) || 0) + 1); }
  const out = [];
  for (const u of users || []) out.push({ id: u.id, name: u.name, role: u.role, count: byOwner.get(u.id) || 0 });
  return { infraCount: byOwner.get('infra') || 0, owners: out };
}

module.exports = { classifyRoute, tokenAllows, TOKEN_ROUTES, isAdmin, ownerOf, sharedWith, memberMayUse, canAccessAgent, redactCaller, redactTurnForViewer, statusForViewer, visibleAgents, peersOf, sameOwner, ownerEntries, PUBLIC_EXACT, SESSION_EXACT, AGENT_BODY, AGENT_QUERY, SESSION_PATH, AGENT_PATH, ADMIN_PAGES };
