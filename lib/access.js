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
  '/api/recall', '/api/recall/context']);   // transcript search: the handler checks access to the named agent

// Agent-scoped: the handler is reached only if the user may access the named agent.
const AGENT_BODY = new Set(['/api/chat', '/api/chat/stream', '/api/chat/interject', '/api/chat/stop', '/api/ask_response', '/api/cancel-worker']);
const AGENT_PATH = [/^\/api\/history\/([^/]+)$/, /^\/api\/session\/([^/]+)$/, /^\/api\/agents\/([^/]+)\/(files|model|display|icon|records|transcript|compaction|turn|notify)(\/|$)/, /^\/api\/agents\/([^/]+)$/, /^\/api\/memory\/([^/]+)\/stats$/, /^\/api\/image\/([^/]+)/];

// Everything else under /api, and the admin pages, is admin-only.
const ADMIN_PAGES = new Set(['/tiger-team', '/agent-settings.html', '/users', '/users.html', '/agent-settings', '/modules', '/modules.html', '/modules.js', '/local-models', '/local-models.html']);

// Fixed agent-management routes that look like /api/agents/<name> but are admin actions.
const ADMIN_EXACT = new Set(['/api/agents/create', '/api/agents/clone', '/api/agents/rename', '/api/agents/reload']);

function classifyRoute(pathname, method = 'GET') {
  const p = String(pathname || '').replace(/\/+$/, '') || '/';
  if (p === '/v1' || p.startsWith('/v1/')) return { kind: 'api' };   // OpenAI-compatible endpoints: token or admin (server.js gate)
  if (PUBLIC_EXACT.has(p) || PUBLIC_PREFIXES.some(x => p.startsWith(x))) return { kind: 'public' };
  if (!p.startsWith('/api/')) {
    if (ADMIN_PAGES.has(p)) return { kind: 'admin', page: true };
    return { kind: 'session', page: true };   // other static assets and pages: any signed-in user
  }
  if (ADMIN_EXACT.has(p)) return { kind: 'admin' };
  if (SESSION_EXACT.has(p)) return { kind: 'session' };
  if (AGENT_BODY.has(p)) return { kind: 'agent', from: 'body' };
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
  const v = resolveVirtual(name);
  if (v && v.parent) name = String(v.parent);
  const a = agents.find(x => x.name === name);
  if (!a) return false;
  return memberMayUse(user, a);
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

module.exports = { classifyRoute, tokenAllows, TOKEN_ROUTES, isAdmin, ownerOf, sharedWith, memberMayUse, canAccessAgent, visibleAgents, peersOf, sameOwner, ownerEntries, PUBLIC_EXACT, SESSION_EXACT, AGENT_BODY, AGENT_PATH, ADMIN_PAGES };
