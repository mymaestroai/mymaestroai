#!/usr/bin/env node
'use strict';

/**
 * My Maestro AI (multi-provider)
 *
 * Single-process Node.js server for multi-agent chat.
 * Routes LLM traffic to Anthropic, OpenAI, LM Studio, Google, etc.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Load .env BEFORE any other requires — skill-manager reads env at import time
try {
  const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of envFile.split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) process.env[match[1]] = match[2].trim();
  }
} catch {}

const {
  getAgents, getAgentFiles, saveAgentFile, createAgent, cloneAgent,
  deleteAgent, renameAgent, getAvailableModels, setAgentModel, setAgentDisplay, setAgentIcon, EDITABLE_FILES,
} = require('./lib/agents');
const {
  handleChatStream, handleChat, handleAskResponse, handleInterjection, handleAlert, ensureAlertSecret, resolveToolConfirm, stopAgentTurn, haltHub, resumeHub, getAgentStatuses, getJobRunner, getScheduledTasks, getPacing, getApprovals, getLedger, getAllowances, getEffectivePolicy, getAgentRequests, getCompaction,
  cancelWorker, getActiveWorkers, loadConversationLog, clearConversationLog,
  clearConversation, flushActiveResponses, runTigerTeam, runRoundtable,
  continueTigerTeam, resumeTigerTeam, getTigerTeamState, reconstituteTigerTeam, stopTigerTeam, listTigerTeams,
  activeTigerTeams, isAgentActive, wakeAgent,
} = require('./lib/sdk-chat');
const { serveImage } = require('./lib/images');
// Tell open pages that an agent's settings changed (model, name, icon, category...) so their open chats follow
// without a reload: hub event 'agent_updated' { agent, model, display, icon, category, autoModel, changed }.
// The server already resolves the model at the start of every turn, so the next turn uses the new one.
async function publishAgentUpdate(name, changed = []) {
  try {
    const a = (await getAgents()).find(x => x.name === name);
    if (!a) return;
    require('./lib/hub-events').events.publish('agent_updated', { agent: name, model: a.model || null, display: a.display || null, icon: a.icon || null, category: a.category || null, autoModel: !!a.autoModel, effort: a.effort || 'default', changed: Array.isArray(changed) ? changed : [] });
  } catch { /* events are best effort */ }
}
const { chatCompletion } = require('./lib/gateway-client');
const { isMythosModel, mythosCompletion } = require('./lib/mythos-client');
const openaiCompat = require('./lib/openai-compat');
const { getSkillStatus, setToken, getToken, discoverTools, clearToolCache, SKILLS, shutdown: shutdownSkills } = require('./lib/skills/skill-manager');
const { startScheduler, stopScheduler, reloadScheduler, getSchedulerStatus, getTaskLogs } = require('./lib/scheduler');
const scheduledTasksLib = require('./lib/scheduled-tasks');
const { startTaskQueue, stopTaskQueue, listTasks: listQueuedTasks } = require('./lib/task-queue');
const { startDiscovery, runDiscovery, loadCache: loadDiscoveryCache } = require('./lib/model-discovery');

// Tiger Team persistence is owned by sdk-chat, including tool/call journals.
const ttRecovery = require('./lib/tiger-team-recovery');
const ttStore = new ttRecovery.CheckpointStore();
const ttValidId = ttRecovery.validId;
const ttReadCheckpoint = id => getTigerTeamState(id);
const ttListCheckpoints = () => ttStore.list().map(cp => {
  const live = activeTigerTeams.get(cp.id);
  return live ? ttRecovery.snapshot(cp.id, live) : ttRecovery.snapshot(cp.id, ttRecovery.restore(cp));
});
const ttGetDurableState = id => getTigerTeamState(id);
// ── Setup Detection ──────────────────────────────────────────────────────
const ENV_FILE = path.join(__dirname, '.env');
function isSetupNeeded() {
  // First-run setup (the Welcome page, lib/welcome) is needed until the hub has an admin account and at least one way
  // for agents to think: an API key, a Claude sign-in or a local model. An .env file alone no longer counts.
  if (!hubAuth.hasUsers()) return true;
  return !require('./lib/welcome').getWelcome().hasProvider();
}

// ── Persistent Settings ──────────────────────────────────────────────────
const hubSettings = require('./lib/settings');
const hubAuth = require('./lib/auth').getAuth();          // accounts, sessions, TOTP, invites (lib/auth)
const access = require('./lib/access');                   // route classes + agent ownership/sharing (lib/access)
const temporalWorkersLib = require('./lib/temporal-workers');

function loadSettings() { /* handled by lib/settings.js at require time */ }
function saveSettings() {
  hubSettings.updateSettings({
    cavemanMode: !!global.__cavemanMode,
    prescanTools: !!global.__prescanToolsEnabled,
    confirmTools: !!global.__confirmToolsEnabled,
    lazyTools: global.__lazyToolsEnabled !== false,
    maxCompletionTokens: global.__maxCompletionTokens || 32000,
    maxContextMessages: global.__maxContextMessages || 40,
  });
}

// ── Crash Handlers ──────────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  const msg = err.stack || String(err);
  if (/EPIPE|ECONNRESET|aborted/.test(msg)) {
    console.warn(`[warn] ${msg.split('\n')[0]}`);
    return;
  }
  console.error(`[fatal] uncaughtException: ${msg}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
  if (/EPIPE|ECONNRESET|aborted/.test(msg)) {
    console.warn(`[warn] ${msg.split('\n')[0]}`);
    return;
  }
  console.error(`[fatal] unhandledRejection: ${msg}`);
  process.exit(1);
});

// Graceful shutdown — flush in-flight responses so they survive restarts
function gracefulShutdown(signal, code = 0) {
  console.log(`[shutdown] ${signal} received, flushing active responses...${code ? ` (exit ${code}: restart requested)` : ''}`);
  try { flushActiveResponses(); } catch (e) { console.error('[shutdown] flush error:', e.message); }
  try { shutdownSkills(); } catch {}
  try { require('./lib/connectors').getConnectors().shutdown(); } catch {}
  try { stopTaskQueue(); } catch {}
  process.exit(code);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
// A restart request (UI button, RestartHub tool, scripts/restart.sh on a systemd install): exit with code 75 so
// systemd restarts the unit under Restart=always AND Restart=on-failure (lib/restart).
process.on('SIGUSR2', () => gracefulShutdown('SIGUSR2', require('./lib/restart').EXIT_RESTART));

process.on('exit', () => {
  // Last-resort sync flush (exit handler can only do sync ops)
  try { flushActiveResponses(); } catch {}
  try { shutdownSkills(); } catch {}
});

// ── Config ──────────────────────────────────────────────────────────────

// Loopback only by default. Network exposure is an explicit opt-in
// (HUB_BIND_HOST) that is refused unless Basic auth is configured — see
// lib/bind-host.js.
const { isSameOriginStreamRequest, isTailnetUserAllowed } = require('./lib/bind-host');
const BIND = require('./lib/bind-host').resolveBindHost(process.env, {
  hasUsers: () => hubAuth.hasUsers(),
  hasSecuredAdmin: () => hubAuth.admins().some(u => u.totp && u.totp.enabled),
});
const { crossOriginRefusal } = require('./lib/origin-guard');
const HOST = BIND.host;
const URL_HOST = HOST.includes(':') ? `[${HOST}]` : HOST; // IPv6 literals need brackets inside URLs
const PORT = parseInt(process.env.PORT || '8888', 10);
// Security check (lib/security-check): the hub reviews its own security configuration (Settings → Security check,
// GET /api/security-check, nightly). Wired with how this process actually listens.
function securityCheck() { return require('./lib/security-check').getSecurityCheck({ exposed: () => !!BIND.exposed, port: PORT, host: HOST }); }
const MAX_BODY_SIZE = 50 * 1024 * 1024; // 50MB to accommodate large screenshot pastes
// Local models (lib/local-models): the hub's llama-swap proxy for every local engine.
const localModels = () => require('./lib/local-models').getLocalModels();
// The lead agent's per-turn brief about this hub (lib/hub-map): needs the port and the exposure decision.
require('./lib/hub-map').getHubMap().init({ port: PORT, host: HOST, exposed: () => !!BIND.exposed, setupNeeded: () => isSetupNeeded() });

// Model health cache (populated by /api/models/health and /api/models/test)
const _modelHealthCache = {};
let _modelHealthLastRun = 0;

// Basic Auth (optional)
const AUTH_USERNAME = process.env.HUB_AUTH_USERNAME || '';
const AUTH_PASSWORD = process.env.HUB_AUTH_PASSWORD || '';
if (AUTH_USERNAME && hubAuth.hasUsers()) console.warn('[auth] HUB_AUTH_USERNAME/HUB_AUTH_PASSWORD are set but accounts exist: the old password login is ignored. Remove the two lines from .env; scripts and bots use API tokens (Users page).');

// ── Helpers ─────────────────────────────────────────────────────────────

function readBody(req) {
  if (req._bodyText !== undefined) return Promise.resolve(req._bodyText);
  return readBodyRaw(req).then((t) => { req._bodyText = t; return t; });
}
function readBodyRaw(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) { reject(new Error('Body too large')); req.destroy(); }
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function jsonResponse(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// The legacy single-password login (HUB_AUTH_USERNAME/PASSWORD): accepted only while the hub has no accounts at all
// (see the identify call below). Compared in constant time.
function checkAuth(req) {
  if (!AUTH_USERNAME) return true;
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) return false;
  const decoded = Buffer.from(auth.slice(6), 'base64').toString();
  const i = decoded.indexOf(':');
  const user = i < 0 ? decoded : decoded.slice(0, i), pass = i < 0 ? '' : decoded.slice(i + 1);
  const crypto = require('crypto');
  const eq = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());
  return eq(user, AUTH_USERNAME) && eq(pass, AUTH_PASSWORD);
}

function parseUrl(url) {
  const qIdx = url.indexOf('?');
  const pathname = qIdx >= 0 ? url.slice(0, qIdx) : url;
  return { pathname: pathname.replace(/\/+$/, ''), query: qIdx >= 0 ? url.slice(qIdx + 1) : '' };
}

// ── Server ──────────────────────────────────────────────────────────────

let serverReady = false;

// Chat body fields the hub sets for its own loopback turns (consults, workers, bridges). A browser or a token may not
// set them: image_files reads any image on the host, consulted_by/origin forge provenance, override skips the kill
// switch, ephemeral hides a turn from the transcript (review F08/F35).
const HUB_ONLY_CHAT_FIELDS = ['image_files', 'consulted_by', 'origin'];
const ADMIN_ONLY_CHAT_FIELDS = ['override', 'ephemeral', 'tiger_team', 'consultation_depth'];
function stripHubOnlyChatFields(body, req) {
  if (!body || typeof body !== 'object' || req.hubService) return body;
  for (const k of HUB_ONLY_CHAT_FIELDS) delete body[k];
  if (!access.isAdmin(req.hubUser)) for (const k of ADMIN_ONLY_CHAT_FIELDS) delete body[k];
  return body;
}

// A request can never take the process down: whatever throws before or outside the route try-block below (cookie
// or URL decoding, identity, the bridge) answers 400 and the hub carries on (review F07).
const server = http.createServer((req, res) => {
  handleHttpRequest(req, res).catch((err) => {
    console.error(`[server] ${req.method} ${String(req.url || '').slice(0, 200)}: ${err && err.message ? err.message : err}`);
    try {
      if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad_request' }));
    } catch { /* socket gone */ }
  });
});
async function handleHttpRequest(req, res) {
  // Tailnet identity gate (HUB_TAILNET_USERS): only listed Tailscale logins may use the hub via Serve.
  if (!isTailnetUserAllowed(req, PORT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden: this Tailscale user is not allowed on this hub.');
    return;
  }
  // Baseline headers on every response (review F33): no MIME sniffing, no referrer leakage, framing only by the hub's
  // own pages, no plugins, <base> and forms only to the hub. Scripts are not restricted yet (the pages still use
  // inline handlers); a script policy follows with the page clean-up. Routes that set their own headers override these.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "base-uri 'self'; form-action 'self'; object-src 'none'");

  const { pathname } = parseUrl(req.url);

  // No CORS: the UI is same-origin. Requests another website makes from a
  // tailnet browser are refused (lib/origin-guard.js).
  const crossOrigin = crossOriginRefusal(req, pathname);
  if (crossOrigin) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden_origin' }));
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Codex hub-tool bridge: authenticated by its own per-turn token and
  // loopback-only (lib/codex-cli/bridge.js), so it bypasses the hub login.
  if (pathname === '/api/codex-bridge/rpc') {
    return require('./lib/codex-cli/bridge').handle(req, res);
  }

  // ── Identity and access (lib/auth + lib/access) ──
  // Every request is identified once: the hub's own loopback calls (service token), a signed-in user
  // (session cookie; a session that still owes a TOTP code may only finish signing in), or the legacy
  // HUB_AUTH basic credentials (older integrations; acts as an admin). Routes are classified as public,
  // session (any user), agent-scoped (the user must be allowed that agent) or admin.
  const route = access.classifyRoute(pathname, req.method);
  const ident = hubAuth.identify(req, { legacyCheck: (r) => !!AUTH_USERNAME && !hubAuth.hasUsers() && checkAuth(r) });
  req.hubService = !!(ident && ident.kind === 'service');
  req.hubToken = ident && ident.kind === 'token' ? ident.token : null;   // a program's API token (lib/auth tokens, lib/access tokenAllows)
  req.hubUser = ident && (ident.kind === 'user' || ident.kind === 'legacy') ? ident.user : null;
  req.hubPendingTotp = !!(ident && ident.kind === 'user' && ident.pendingTotp);
  if (ident && ident.kind === 'bad-token' && route.kind !== 'public') return jsonResponse(res, 401, { error: 'unauthorized', detail: ident.reason });
  if (route.kind === 'api') {
    // OpenAI-compatible endpoints (/v1/*): an API token with the openai-api scope, a signed-in admin, or the hub itself.
    // Open only while the hub has no accounts at all (older single-user installs).
    // An admin session that still owes its two-factor code is not an admin yet (review F28).
    if (hubAuth.hasUsers() && !req.hubService && !(access.isAdmin(req.hubUser) && !req.hubPendingTotp) && !(req.hubToken && access.tokenAllows(req.hubToken, pathname, req.method).ok)) {
      return jsonResponse(res, 401, { error: 'unauthorized', hint: 'use an API token with the openai-api scope (Users page)' });
    }
  } else if (route.kind !== 'public' && req.hubToken) {
    // A token may call only what its scopes list, and chat/interject only for its own agents.
    let agentName = route.agent || null;
    if (route.from === 'body') { try { agentName = JSON.parse((await readBody(req)) || '{}').agent; } catch {} }
    const allow = access.tokenAllows(req.hubToken, pathname, req.method, { agent: agentName });
    if (!allow.ok) return jsonResponse(res, 403, { error: 'token_scope', detail: allow.reason });
  } else if (route.kind !== 'public') {
    const wantsHtml = route.page || String(req.headers.accept || '').includes('text/html');
    if ((!req.hubService && !req.hubUser) || req.hubPendingTotp) {
      if (wantsHtml && req.method === 'GET') { res.writeHead(302, { Location: `/login?next=${encodeURIComponent(req.url || '/')}` }); return res.end(); }
      return jsonResponse(res, 401, { error: req.hubPendingTotp ? 'totp_required' : 'unauthorized' });
    }
    if (!req.hubService) {
      if (route.kind === 'admin' && !access.isAdmin(req.hubUser)) {
        if (route.page) { res.writeHead(302, { Location: '/' }); return res.end(); }
        return jsonResponse(res, 403, { error: 'admin_only' });
      }
      if (route.kind === 'agent' && !access.isAdmin(req.hubUser)) {
        let agentName = route.agent;
        if (route.from === 'body') { try { agentName = JSON.parse((await readBody(req)) || '{}').agent; } catch {} }
        const allowed = agentName && access.canAccessAgent(req.hubUser, agentName, { agents: await getAgents(), resolveVirtual: (n) => temporalWorkersLib.getVirtual(n) });
        if (!allowed) return jsonResponse(res, 403, { error: 'no_access_to_agent' });
      }
    }
  }

  try {
    // ── OpenAI-Compatible Routes ────────────────────────────────────
    if (pathname === '/v1/chat/completions' && req.method === 'POST') {
      return openaiCompat.handleChatCompletion(req, res);
    }
    if (pathname === '/v1/models' && req.method === 'GET') {
      return openaiCompat.handleModels(req, res);
    }
    if (pathname === '/health') {
      return openaiCompat.handleHealth(req, res);
    }

    // ── Accounts: sign-in, two-factor, invites, self-service (lib/auth) ──
    const authJson = async () => { try { return JSON.parse((await readBody(req)) || '{}') || {}; } catch { return null; } };
    const finishSignIn = (user, { totpOk }) => {
      const sess = hubAuth.createSession(user, { req, totpOk });
      res.setHeader('Set-Cookie', sess.cookie);
      return sess;
    };
    // ── Local models (lib/local-models): one proxy (llama-swap) for every local engine; admin only ──
    if (pathname === '/api/local-models' && req.method === 'GET') return jsonResponse(res, 200, { ok: true, ...(await localModels().status()) });
    if (pathname === '/api/local-models/default-dirs' && req.method === 'GET') return jsonResponse(res, 200, { ok: true, dirs: localModels().defaultModelsDirs() });
    if (pathname === '/api/local-models/logs' && req.method === 'GET') { const n = parseInt(new URL(req.url, 'http://x').searchParams.get('n') || '200', 10); return jsonResponse(res, 200, { ok: true, text: await localModels().logs(Math.min(2000, Math.max(20, n || 200))) }); }
    if (pathname.startsWith('/api/local-models') && req.method !== 'GET') {
      if (req.hubService) return jsonResponse(res, 403, { error: 'Local models are configured by a signed-in admin.' });
      const lm = localModels(); const b = (await authJson()) || {};
      try {
        if (pathname === '/api/local-models/settings' && req.method === 'POST') { const before = lm.state().port; const s = lm.update(b); const r = await lm.apply(); return jsonResponse(res, 200, { ok: true, settings: s, problems: r.problems, note: before !== s.port && r.running ? 'Port changed: press Restart.' : '' }); }
        if (pathname === '/api/local-models/models' && req.method === 'POST') { const model = lm.models.upsert(b); const r = await lm.apply(); return jsonResponse(res, 200, { ok: true, model, running: r.running, problems: r.problems }); }
        { const m = pathname.match(/^\/api\/local-models\/models\/([^/]+)$/); if (m && req.method === 'DELETE') { lm.models.remove(decodeURIComponent(m[1])); const r = await lm.apply(); return jsonResponse(res, 200, { ok: true, problems: r.problems }); } }
        if (pathname === '/api/local-models/scan' && req.method === 'POST') { const dirs = Array.isArray(b.dirs) && b.dirs.length ? b.dirs : (lm.state().modelsDirs.length ? lm.state().modelsDirs : lm.defaultModelsDirs()); return jsonResponse(res, 200, { ok: true, dirs, found: lm.scan(dirs) }); }
        if (pathname === '/api/local-models/install/llama-swap' && req.method === 'POST') return jsonResponse(res, 200, { ok: true, ...(await lm.installLlamaSwap()) });
        if (pathname === '/api/local-models/install/llama-cpp' && req.method === 'POST') {
          const job = await getJobRunner().run({ owner: (req.hubUser && req.hubUser.id) || 'maestro', name: 'build llama.cpp (llama-server)', command: lm.llamaCppBuildCommand(), cwd: __dirname, timeoutMinutes: 90 });
          return jsonResponse(res, 200, { ok: true, jobId: job && job.id ? job.id : null });
        }
        if (pathname === '/api/local-models/start' && req.method === 'POST') return jsonResponse(res, 200, { ok: true, ...(await lm.start()) });
        if (pathname === '/api/local-models/stop' && req.method === 'POST') return jsonResponse(res, 200, { ok: true, ...(await lm.stop()) });
        if (pathname === '/api/local-models/restart' && req.method === 'POST') return jsonResponse(res, 200, { ok: true, ...(await lm.restart()) });
        if (pathname === '/api/local-models/apply' && req.method === 'POST') return jsonResponse(res, 200, { ok: true, ...(await lm.apply()) });
        if (pathname === '/api/local-models/unload' && req.method === 'POST') { const r = await lm.unload(b.id || null); return jsonResponse(res, r.status < 400 ? 200 : 502, { ok: r.status < 400, status: r.status, text: r.text.slice(0, 200) }); }
        if ((pathname === '/api/local-models/load' || pathname === '/api/local-models/test') && req.method === 'POST') {
          const id = String(b.id || ''); if (!lm.models.get(id)) return jsonResponse(res, 404, { error: 'no such model' });
          const test = pathname.endsWith('/test'); const t0 = Date.now();
          const r = await fetch(`${lm.baseUrl()}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer local' }, body: JSON.stringify({ model: id, messages: [{ role: 'user', content: test ? String(b.prompt || 'Say hello in one short sentence.') : 'hi' }], max_tokens: test ? 1024 : 1, stream: false }), signal: AbortSignal.timeout((lm.state().healthCheckTimeout + 60) * 1000) });
          const j = await r.json().catch(() => ({})); const ms = Date.now() - t0;
          if (!r.ok) return jsonResponse(res, 502, { error: `proxy answered HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)}` });
          const msg = ((j.choices || [])[0] || {}).message || {};   // thinking models may spend the budget before answering: show that, not a blank
          const text = msg.content || ((msg.reasoning_content || msg.reasoning) ? `[thinking only, no final answer within ${test ? 1024 : 1} tokens] ${String(msg.reasoning_content || msg.reasoning).slice(0, 200)}` : ''); const out = (j.usage || {}).completion_tokens;
          return jsonResponse(res, 200, { ok: true, ms, text: String(text).trim().slice(0, 600), tokensPerSec: out && ms ? Math.round(out * 1000 / ms) : null });
        }
        if (pathname === '/api/local-models/discover' && req.method === 'POST') { const r = await require('./lib/model-discovery').runDiscovery(); return jsonResponse(res, 200, { ok: true, count: ((r && r.local) || []).length }); }
      } catch (e) { return jsonResponse(res, 400, { error: e.message }); }
    }

    // ── API tokens for programs (admin only; never from the hub's own service identity) ──
    if (pathname === '/api/tokens' && req.method === 'GET') return jsonResponse(res, 200, { ok: true, tokens: hubAuth.listTokens(), scopes: hubAuth.TOKEN_SCOPES });
    if (pathname === '/api/tokens' && req.method === 'POST') {
      if (req.hubService) return jsonResponse(res, 403, { error: 'Tokens are created by a signed-in admin.' });
      const b = (await authJson()) || {};
      try { return jsonResponse(res, 200, { ok: true, ...hubAuth.createToken({ ...b, by: req.hubUser && req.hubUser.id }) }); }
      catch (e) { return jsonResponse(res, 400, { error: e.message }); }
    }
    { const m = pathname.match(/^\/api\/tokens\/([a-f0-9]{12})$/);
      if (m && req.method === 'DELETE') {
        if (req.hubService) return jsonResponse(res, 403, { error: 'Tokens are revoked by a signed-in admin.' });
        try { return jsonResponse(res, 200, { ok: true, token: hubAuth.revokeToken(m[1], { by: req.hubUser && req.hubUser.id }) }); }
        catch (e) { return jsonResponse(res, 400, { error: e.message }); }
      } }
    if (pathname === '/api/auth/status' && req.method === 'GET') {
      return jsonResponse(res, 200, { setupNeeded: !hubAuth.hasUsers(), signedIn: !!req.hubUser, pendingTotp: req.hubPendingTotp, user: req.hubUser ? hubAuth.publicUser(hubAuth.getUser(req.hubUser.id)) || { id: req.hubUser.id, name: req.hubUser.name, role: req.hubUser.role } : null });
    }
    if (pathname === '/api/auth/setup' && req.method === 'POST') {
      // First run only: create the first admin. Refused once any user exists, and without the one-time setup code
      // the installer printed (data/setup-token; `mymaestro setup-link` shows it again), so no other program on this
      // machine can claim the hub before its owner does.
      if (hubAuth.hasUsers()) return jsonResponse(res, 403, { error: 'setup already done' });
      const b = await authJson(); if (!b) return jsonResponse(res, 400, { error: 'invalid JSON' });
      const welcome = require('./lib/welcome').getWelcome();
      if (!welcome.checkSetupToken(b.setupToken)) return jsonResponse(res, 403, { error: 'setup_code', detail: 'Open the setup link the installer printed, or run "mymaestro setup-link" on this computer to see it again.' });
      const r = hubAuth.createUser({ login: b.login, name: b.name, role: 'admin', password: b.password });
      if (!r.ok) return jsonResponse(res, 400, r);
      welcome.clearSetupToken();
      welcome.markStarted();   // "/" brings this admin back to /welcome until setup is finished or skipped
      finishSignIn(hubAuth.getUser(r.user.id), { totpOk: true });
      return jsonResponse(res, 200, { ok: true, user: r.user });
    }
    // ── First-run setup (the Welcome page; lib/welcome) ──
    if (pathname === '/api/welcome/state' && req.method === 'GET') {
      // Public: the page needs to know where to start. Before the first account exists it only learns whether its
      // setup code is right; provider details are for a signed-in admin.
      const welcome = require('./lib/welcome').getWelcome();
      const q = new URL(req.url, 'http://x').searchParams;
      const accounts = hubAuth.hasUsers();
      const admin = access.isAdmin(req.hubUser) && !req.hubPendingTotp;
      const out = { ok: true, product: welcome.PRODUCT, accounts, signedIn: !!req.hubUser && !req.hubPendingTotp, isAdmin: admin };
      if (!accounts) out.codeOk = welcome.checkSetupToken(q.get('token'));
      if (admin) {
        const u = hubAuth.getUser(req.hubUser.id);
        out.totp = !!(u && u.totp && u.totp.enabled);
        out.providers = welcome.providerSummary();
        out.hasProvider = welcome.hasProvider();
        out.unfinished = welcome.unfinished();
        const lead = (await getAgents()).find(a => a.name === 'maestro') || (await getAgents())[0] || null;
        out.lead = lead ? { name: lead.name, display: lead.display || lead.name, model: lead.model } : null;
      }
      return jsonResponse(res, 200, out);
    }
    if (pathname === '/api/welcome/finish' && req.method === 'POST') {
      // Setup done (Maestro answered) or skipped: "/" stops sending this admin back to the Welcome page.
      const b = (await authJson()) || {};
      require('./lib/welcome').getWelcome().markFinished(b.how === 'skip' ? 'skip' : 'done');
      return jsonResponse(res, 200, { ok: true });
    }
    if (pathname === '/api/welcome/api-key' && req.method === 'POST') {
      const b = (await authJson()) || {};
      return jsonResponse(res, 200, await require('./lib/welcome').getWelcome().connectApiKey(b.provider, b.apiKey));
    }
    if (pathname === '/api/welcome/claude-check' && req.method === 'POST') {
      return jsonResponse(res, 200, await require('./lib/welcome').getWelcome().checkClaude());
    }
    if (pathname === '/api/welcome/local' && req.method === 'GET') {
      return jsonResponse(res, 200, { ok: true, engines: await require('./lib/welcome').getWelcome().findLocal() });
    }
    if (pathname === '/api/welcome/local' && req.method === 'POST') {
      const b = (await authJson()) || {};
      return jsonResponse(res, 200, require('./lib/welcome').getWelcome().connectLocal(b.provider, b.url));
    }
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const b = await authJson(); if (!b) return jsonResponse(res, 400, { error: 'invalid JSON' });
      const r = hubAuth.login(b.login, b.password, { ip: hubAuth.clientIp(req) });
      if (!r.ok) return jsonResponse(res, r.locked ? 429 : 401, { ok: false, error: r.error });
      const cookies = hubAuth.parseCookies(req);
      const trusted = r.needsTotp && hubAuth.isTrusted(r.user, cookies[hubAuth.TRUST_COOKIE]);
      finishSignIn(r.user, { totpOk: !r.needsTotp || trusted });
      return jsonResponse(res, 200, { ok: true, needsTotp: r.needsTotp && !trusted, user: hubAuth.publicUser(r.user) });
    }
    if (pathname === '/api/auth/totp/verify' && req.method === 'POST') {
      // Second step of sign-in: the session exists but owes a code.
      const cookies = hubAuth.parseCookies(req);
      const sess = hubAuth.getSession(cookies[hubAuth.SESSION_COOKIE]);
      if (!sess) return jsonResponse(res, 401, { error: 'sign in first' });
      const b = await authJson(); if (!b) return jsonResponse(res, 400, { error: 'invalid JSON' });
      const user = hubAuth.getUser(sess.user_id);
      const r = hubAuth.totpCheck(user.id, b.code);
      if (!r.ok) return jsonResponse(res, 401, { ok: false, error: r.error });
      hubAuth.markTotpOk(sess.id);
      const cookiesOut = [];
      if (b.trust) cookiesOut.push(hubAuth.trustDevice(user, req).cookie);
      if (cookiesOut.length) res.setHeader('Set-Cookie', cookiesOut);
      return jsonResponse(res, 200, { ok: true, recovery: !!r.recovery, remaining: r.remaining, user: hubAuth.publicUser(user) });
    }
    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      const cookies = hubAuth.parseCookies(req);
      hubAuth.destroySession(cookies[hubAuth.SESSION_COOKIE]);
      res.setHeader('Set-Cookie', [hubAuth.cookieHeader(hubAuth.SESSION_COOKIE, '', { req, maxAgeMs: 0 })]);
      return jsonResponse(res, 200, { ok: true });
    }
    if (pathname === '/api/auth/invite' && req.method === 'GET') {
      const token = new URL(req.url, 'http://x').searchParams.get('token') || '';
      const inv = hubAuth.getInvite(token);
      return inv ? jsonResponse(res, 200, { ok: true, invite: inv }) : jsonResponse(res, 404, { ok: false, error: 'This invite link is invalid or has expired' });
    }
    if (pathname === '/api/auth/invite/accept' && req.method === 'POST') {
      const b = await authJson(); if (!b) return jsonResponse(res, 400, { error: 'invalid JSON' });
      const r = hubAuth.acceptInvite(b.token, { password: b.password, name: b.name });
      if (!r.ok) return jsonResponse(res, 400, r);
      if (r.user.role === 'member') require('./lib/teams').createDefaultAssistant(r.user).catch(e => console.error('[users] default assistant:', e.message));
      finishSignIn(r.user, { totpOk: true });
      return jsonResponse(res, 200, { ok: true, user: hubAuth.publicUser(r.user), needsTotpEnrol: r.user.role === 'admin' });
    }
    // Self-service (any signed-in user)
    if (pathname === '/api/auth/totp/begin' && req.method === 'POST') {
      const r = hubAuth.totpBegin(req.hubUser.id);
      return jsonResponse(res, r.ok ? 200 : 400, r);
    }
    if (pathname === '/api/auth/totp/confirm' && req.method === 'POST') {
      const b = await authJson(); if (!b) return jsonResponse(res, 400, { error: 'invalid JSON' });
      const r = hubAuth.totpConfirm(req.hubUser.id, b.code);
      if (r.ok) { const cookies = hubAuth.parseCookies(req); const sess = hubAuth.getSession(cookies[hubAuth.SESSION_COOKIE]); if (sess) hubAuth.markTotpOk(sess.id); }
      return jsonResponse(res, r.ok ? 200 : 400, r);
    }
    if (pathname === '/api/auth/totp/disable' && req.method === 'POST') {
      const b = await authJson(); if (!b) return jsonResponse(res, 400, { error: 'invalid JSON' });
      const u = hubAuth.getUser(req.hubUser.id);
      if (!u || !hubAuth.login(u.login, b.password).ok) return jsonResponse(res, 401, { error: 'password check failed' });
      return jsonResponse(res, 200, hubAuth.totpDisable(u.id));
    }
    if (pathname === '/api/auth/password' && req.method === 'POST') {
      const b = await authJson(); if (!b) return jsonResponse(res, 400, { error: 'invalid JSON' });
      const u = hubAuth.getUser(req.hubUser.id);
      if (!u || !hubAuth.login(u.login, b.current).ok) return jsonResponse(res, 401, { error: 'current password is wrong' });
      const r = hubAuth.setPassword(u.id, b.next, { by: u.id });
      return jsonResponse(res, r.ok ? 200 : 400, r);
    }
    if (pathname === '/api/auth/sessions' && req.method === 'GET') {
      return jsonResponse(res, 200, { sessions: hubAuth.listSessions(req.hubUser.id) });
    }
    if (pathname === '/api/auth/sessions/revoke' && req.method === 'POST') {
      hubAuth.revokeSessions(req.hubUser.id);
      res.setHeader('Set-Cookie', [hubAuth.cookieHeader(hubAuth.SESSION_COOKIE, '', { req, maxAgeMs: 0 })]);
      return jsonResponse(res, 200, { ok: true });
    }
    // Who am I, and (for admins) the owner switcher entries.
    if (pathname === '/api/me' && req.method === 'GET') {
      const u = req.hubUser ? (hubAuth.publicUser(hubAuth.getUser(req.hubUser.id)) || { id: req.hubUser.id, name: req.hubUser.name, role: req.hubUser.role }) : null;
      const isAdmin = access.isAdmin(req.hubUser);
      // accounts: false = no admin account exists yet (an updated older install): no login, multi-user features off.
      const out = { user: u, isAdmin, accounts: hubAuth.hasUsers() };
      if (isAdmin) { const oe = access.ownerEntries(await getAgents(), hubAuth.listUsers()); out.owners = oe.owners; out.infraCount = oe.infraCount; }
      return jsonResponse(res, 200, out);
    }
    // ── Users (admin) ──
    if (pathname === '/api/users' && req.method === 'GET') {
      const agents = await getAgents();
      const users = hubAuth.listUsers().map(u => ({ ...u, agents: agents.filter(a => a.owner === u.id).map(a => a.name), shared: agents.filter(a => (a.sharedWith || []).includes(u.id)).map(a => a.name) }));
      return jsonResponse(res, 200, { users, invites: hubAuth.listInvites() });
    }
    if (pathname === '/api/users' && req.method === 'POST') {
      const b = await authJson(); if (!b) return jsonResponse(res, 400, { error: 'invalid JSON' });
      if (b.invite) {
        const r = hubAuth.createInvite({ login: b.login, name: b.name, role: b.role, by: req.hubUser.id });
        if (!r.ok) return jsonResponse(res, 400, r);
        const base = `${(String(req.headers['x-forwarded-proto'] || '').split(',')[0] || (req.socket.encrypted ? 'https' : 'http'))}://${req.headers.host}`;
        return jsonResponse(res, 200, { ok: true, login: r.login, expiresAt: r.expiresAt, link: `${base}/invite?token=${r.token}` });
      }
      const r = hubAuth.createUser({ login: b.login, name: b.name, role: b.role, password: b.password });
      if (r.ok && r.user.role === 'member') require('./lib/teams').createDefaultAssistant(hubAuth.getUser(r.user.id)).catch(e => console.error('[users] default assistant:', e.message));
      return jsonResponse(res, r.ok ? 200 : 400, r);
    }
    if (pathname === '/api/users/invite' && req.method === 'DELETE') {
      const b = await authJson(); if (!b) return jsonResponse(res, 400, { error: 'invalid JSON' });
      return jsonResponse(res, 200, hubAuth.revokeInvite(b.login));
    }
    // ── Transcript archive (lib/transcript) and Records (lib/records) ──
    if ((pathname === '/api/recall' || pathname === '/api/recall/context') && req.method === 'GET') {
      const q = new URL(req.url, 'http://x').searchParams;
      const agentName = String(q.get('agent') || '');
      const who = req.hubUser || { id: 'service', role: 'admin' };
      if (!agentName) return jsonResponse(res, 400, { error: 'agent required' });
      if (!access.isAdmin(who) && !access.canAccessAgent(who, agentName, { agents: await getAgents() })) return jsonResponse(res, 403, { error: 'no_access_to_agent' });
      const tr = require('./lib/transcript').getTranscript();
      if (pathname === '/api/recall') {
        const kinds = q.get('kinds') ? String(q.get('kinds')).split(',').filter(Boolean) : null;
        return jsonResponse(res, 200, { ok: true, agent: agentName, hits: tr.search(agentName, q.get('q') || '', { from: q.get('from') || null, to: q.get('to') || null, kinds, limit: Number(q.get('limit')) || 30 }), stats: tr.stats(agentName) });
      }
      return jsonResponse(res, 200, { ok: true, agent: agentName, rows: tr.context(Number(q.get('id')), { before: Number(q.get('before')) || 6, after: Number(q.get('after')) || 6, agents: [agentName] }) });
    }
    // The turn so far: what a busy agent has done and said in its running turn (tool calls, workers,
    // partial reply), so a page that opens or wakes mid-turn can catch up, then follow /api/events.
    {
      const tm = pathname.match(/^\/api\/agents\/([^/]+)\/turn$/);
      if (tm && req.method === 'GET') {
        const agentName = decodeURIComponent(tm[1]);
        // A program's token sees only the agents it is scoped to (a status token with no agent list sees all, like /api/agents/status) (review F48).
        if (req.hubToken && req.hubToken.agents && !req.hubToken.agents.includes(agentName)) return jsonResponse(res, 403, { error: 'token_scope', detail: 'this token is not scoped to that agent' });
        const who = req.hubUser || { id: 'service', role: 'admin' };
        if (!access.isAdmin(who) && !access.canAccessAgent(who, agentName, { agents: await getAgents(), resolveVirtual: (n) => temporalWorkersLib.getVirtual(n) })) return jsonResponse(res, 403, { error: 'no_access_to_agent' });
        const turn = require('./lib/hub-events').events.turnFor(agentName);
        return jsonResponse(res, 200, { ok: true, agent: agentName, active: !!(turn && turn.active), turn });
      }
    }
    {
      const cm = pathname.match(/^\/api\/agents\/([^/]+)\/compaction(?:\/(run))?$/);
      if (cm) {
        const agentName = decodeURIComponent(cm[1]);
        const comp = getCompaction();
        if (req.method === 'GET' && !cm[2]) return jsonResponse(res, 200, { ok: true, ...comp.get(agentName), records: require('./lib/records').list(agentName).map(r => r.name) });
        if (req.method === 'PUT' && !cm[2]) {
          if (!access.isAdmin(req.hubUser || { role: 'admin' })) return jsonResponse(res, 403, { error: 'admin_only' });
          const b = await authJson(); if (!b) return jsonResponse(res, 400, { error: 'invalid JSON' });
          const r = await require('./lib/agents').updateAgentField(agentName, { compaction: { mode: b.mode, at: b.at } });
          return jsonResponse(res, r.success ? 200 : 400, { ...r, ...(r.success ? comp.get(agentName) : {}) });
        }
        if (req.method === 'POST' && cm[2] === 'run') {
          // The agent's compression turn takes minutes: start it, answer at once, progress on /api/events.
          const st = comp.get(agentName);
          if (st.running) return jsonResponse(res, 409, { error: 'already running' });
          comp.run(agentName, 'owner').catch(e => console.error(`[compaction] ${agentName}:`, e.message));
          return jsonResponse(res, 202, { ok: true, started: true, mode: st.mode === 'off' ? 'dry' : st.mode });
        }
      }
      const rm = pathname.match(/^\/api\/agents\/([^/]+)\/records(?:\/([^/]+))?$/);
      if (rm) {
        const agentName = decodeURIComponent(rm[1]); const file = rm[2] ? decodeURIComponent(rm[2]) : null;
        const records = require('./lib/records');
        if (req.method === 'GET' && !file) return jsonResponse(res, 200, { ok: true, agent: agentName, folder: records.folderFor(agentName), records: records.list(agentName), maxBytes: records.maxBytesFor(agentName, { agentRecord: (await getAgents()).find(a => a.name === agentName) || null }) });
        if (req.method === 'GET' && file) { const c = records.read(agentName, file); return c == null ? jsonResponse(res, 404, { error: 'no such record' }) : jsonResponse(res, 200, { ok: true, name: file, content: c }); }
        if (req.method === 'PUT' && file) { const b = await authJson(); if (!b || typeof b.content !== 'string') return jsonResponse(res, 400, { error: 'content required' }); return jsonResponse(res, 200, { ok: true, result: records.write(agentName, file, b.content, { append: !!b.append }) }); }
        if (req.method === 'DELETE' && file) { const gone = records.remove(agentName, file); return jsonResponse(res, gone ? 200 : 404, gone ? { ok: true } : { ok: false, error: 'no such record' }); }
      }
    }

    // ── Files area: upload / download / browse one folder per owner (lib/files) ──
    if (pathname === '/api/files' || pathname.startsWith('/api/files/')) {
      const files = require('./lib/files').getFiles({ getUser: (id) => hubAuth.getUser(id), isAdminUser: (u) => access.isAdmin(u),
        maxUploadBytes: () => Math.max(1, Number(hubSettings.getSetting('filesMaxUploadMb')) || 512) * 1048576 });
      const q = new URL(req.url, 'http://x').searchParams;
      let jsonBody = null;
      if (req.method === 'POST' && pathname !== '/api/files/upload') { jsonBody = await authJson(); if (!jsonBody) return jsonResponse(res, 400, { error: 'invalid JSON' }); }
      const want = (k) => (jsonBody && jsonBody[k] !== undefined) ? jsonBody[k] : q.get(k);
      const who = req.hubUser || { id: 'service', role: 'admin' };
      // Per agent when the page names the active chat's agent (the user must be allowed that agent);
      // otherwise the owner's general folder.
      let own = null;
      const agentName = want('agent');
      if (agentName) {
        const agents = await getAgents();
        const rec = agents.find(a => a.name === String(agentName));
        if (!rec) return jsonResponse(res, 404, { error: 'no such agent' });
        if (!access.isAdmin(who) && !access.canAccessAgent(who, rec.name, { agents })) return jsonResponse(res, 403, { error: 'no_access_to_agent' });
        const memberOwned = !!(rec.owner && !hubAuth.listUsers().some(u => u.id === String(rec.owner) && u.role === 'admin'));
        own = files.resolveAgent(who, rec, { memberOwned });
      } else {
        own = files.resolveOwner(who, want('owner'));
      }
      if (!own) return jsonResponse(res, 403, { error: 'no such owner' });
      const rel = String(want('path') || '');
      const fail = (r) => jsonResponse(res, r.code || 400, { error: r.error });
      if (pathname === '/api/files' && req.method === 'GET') {
        const r = files.list(own.root, rel);
        if (!r.ok) return fail(r);
        return jsonResponse(res, 200, { ok: true, root: { owner: own.ownerId, agent: own.agent || null, label: own.label, absPath: own.root }, path: r.path, absPath: r.absPath, entries: r.entries, maxUploadBytes: files.maxUploadBytes() });
      }
      if (pathname === '/api/files/upload' && req.method === 'POST') {
        const target = files.uploadTarget(own.root, rel, q.get('name'), { overwrite: q.get('overwrite') === '1' });
        if (!target.ok) { req.resume(); return fail(target); }
        const declared = Number(req.headers['content-length'] || 0);
        if (declared > files.maxUploadBytes()) { req.resume(); return jsonResponse(res, 413, { error: `file is larger than ${Math.round(files.maxUploadBytes() / 1048576)} MB` }); }
        const r = await files.saveStream(target, req);
        if (!r.ok) return fail(r);
        console.log(`[files] ${who.id} uploaded ${target.rel} (${r.entry && r.entry.size} bytes) to ${own.ownerId === 'mine' ? 'share' : own.ownerId}`);
        return jsonResponse(res, 200, r);
      }
      if (pathname === '/api/files/download' && req.method === 'GET') {
        const s = files.stat(own.root, rel);
        if (!s.ok) return fail(s);
        if (s.isDir) return jsonResponse(res, 400, { error: 'that is a folder' });
        const name = path.basename(s.abs);
        // An uploaded HTML/SVG/XML/script file shown inline would run as the hub's own origin: those are always
        // attachments, and inline text documents are sandboxed; images, audio, video and PDFs display as before (review F20).
        const mime = files.mimeOf(name);
        const active = /\.(html?|xhtml|svg|xml|js|mjs)$/i.test(name);
        const inline = q.get('inline') === '1' && !active;
        const headers = { 'Content-Type': mime, 'Content-Length': s.st.size, 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`, 'X-Content-Type-Options': 'nosniff' };
        if (inline && !/^(image|audio|video)\/|^application\/pdf$/.test(mime)) headers['Content-Security-Policy'] = 'sandbox';
        res.writeHead(200, headers);
        const stream = fs.createReadStream(s.abs);
        stream.on('error', () => { try { res.destroy(); } catch {} });
        return stream.pipe(res);
      }
      if (pathname === '/api/files' && req.method === 'DELETE') {
        const r = files.remove(own.root, rel);
        if (!r.ok) return fail(r);
        console.log(`[files] ${who.id} deleted ${rel} in ${own.ownerId === 'mine' ? 'share' : own.ownerId}`);
        return jsonResponse(res, 200, { ok: true });
      }
      if (pathname === '/api/files/mkdir' && req.method === 'POST') {
        const r = files.mkdir(own.root, rel, jsonBody.name);
        return r.ok ? jsonResponse(res, 200, r) : fail(r);
      }
      if (pathname === '/api/files/rename' && req.method === 'POST') {
        const r = files.rename(own.root, rel, jsonBody.newName);
        return r.ok ? jsonResponse(res, 200, r) : fail(r);
      }
      return jsonResponse(res, 404, { error: 'unknown files route' });
    }
    if (pathname === '/api/agent-requests' && req.method === 'GET') {
      const status = new URL(req.url, 'http://x').searchParams.get('status') || null;
      return jsonResponse(res, 200, { requests: getAgentRequests().all(status) });
    }
    if (/^\/api\/agent-requests\/([^/]+)$/.test(pathname) && req.method === 'POST') {
      const id = pathname.split('/')[3];
      const b = await authJson(); if (!b) return jsonResponse(res, 400, { error: 'invalid JSON' });
      const r = await getAgentRequests().resolve(id, { action: b.action, by: req.hubUser.id, note: b.note, template: b.template, model: b.model, name: b.name });
      return jsonResponse(res, r.ok ? 200 : 400, r);
    }
    if (pathname === '/api/users/audit' && req.method === 'GET') {
      return jsonResponse(res, 200, { audit: hubAuth.auditRecent(200) });
    }
    if (/^\/api\/users\/([^/]+)$/.test(pathname) && req.method === 'PATCH') {
      const id = pathname.split('/')[3];
      const b = await authJson(); if (!b) return jsonResponse(res, 400, { error: 'invalid JSON' });
      // Grants: only grantable classes and valid decisions; "May consult" is a list of agent names.
      if (b.grants !== undefined) b.grants = require('./lib/tool-policy').sanitizeGrants(b.grants);
      const r = hubAuth.updateUser(id, b, { by: req.hubUser.id });
      return jsonResponse(res, r.ok ? 200 : 400, r);
    }
    if (/^\/api\/users\/([^/]+)$/.test(pathname) && req.method === 'DELETE') {
      const id = pathname.split('/')[3];
      if (id === req.hubUser.id) return jsonResponse(res, 400, { error: 'you cannot delete yourself' });
      // Their agents become infrastructure (admin-only) rather than vanishing.
      for (const a of await getAgents()) if (a.owner === id) await require('./lib/agents').updateAgentField(a.name, { owner: null });
      const r = hubAuth.deleteUser(id, { by: req.hubUser.id });
      return jsonResponse(res, r.ok ? 200 : 400, r);
    }
    if (/^\/api\/users\/([^/]+)\/password$/.test(pathname) && req.method === 'POST') {
      const id = pathname.split('/')[3];
      const b = await authJson(); if (!b) return jsonResponse(res, 400, { error: 'invalid JSON' });
      const r = hubAuth.setPassword(id, b.password, { by: req.hubUser.id });
      return jsonResponse(res, r.ok ? 200 : 400, r);
    }
    if (/^\/api\/users\/([^/]+)\/totp\/reset$/.test(pathname) && req.method === 'POST') {
      const id = pathname.split('/')[3];
      return jsonResponse(res, 200, hubAuth.totpDisable(id, { by: req.hubUser.id }));
    }
    if (/^\/api\/users\/([^/]+)\/team$/.test(pathname) && req.method === 'POST') {
      const id = pathname.split('/')[3];
      const b = await authJson(); if (!b) return jsonResponse(res, 400, { error: 'invalid JSON' });
      const u = hubAuth.getUser(id); if (!u) return jsonResponse(res, 404, { error: 'no such user' });
      const r = await require('./lib/teams').createTeamForUser({ user: u, template: b.template, prefix: b.prefix });
      return jsonResponse(res, r.ok ? 200 : 400, r);
    }

    // ── Agent Routes ────────────────────────────────────────────────
    if (pathname === '/api/agents' && req.method === 'GET') {
      const all = await getAgents();
      const ownerFilter = new URL(req.url, 'http://x').searchParams.get('owner') || null;
      const agents = req.hubService ? all : access.visibleAgents(req.hubUser, all, { ownerFilter: access.isAdmin(req.hubUser) ? ownerFilter : null });
      const status = getAgentStatuses();
      const idle = { busy: false, busySince: null, activity: null, pendingQuestion: false };
      return jsonResponse(res, 200, { agents: agents.map(a => ({ ...a, ...(status[a.name] || idle) })) });
    }

    if (pathname === '/api/agents/status' && req.method === 'GET') {
      const h = require('./lib/hub-halt').getHubHalt().status();
      let agents = getAgentStatuses();
      if (req.hubToken) {
        // A program's token: the agents it is scoped to, or every agent for a status-only token (a dashboard).
        if (req.hubToken.agents) agents = Object.fromEntries(Object.entries(agents).filter(([name]) => req.hubToken.agents.includes(name)));
      } else if (!req.hubService && !access.isAdmin(req.hubUser)) {
        const all = await getAgents();
        agents = Object.fromEntries(Object.entries(agents).filter(([name]) => access.canAccessAgent(req.hubUser, name, { agents: all, resolveVirtual: (n) => temporalWorkersLib.getVirtual(n) })));
      }
      return jsonResponse(res, 200, { halted: h.halted, haltedAt: h.at, haltReason: h.reason, agents });
    }

    // Hub-wide kill switch (owner only: Basic auth + same-origin guard apply to every /api route).
    if (pathname === '/api/hub/status' && req.method === 'GET') {
      return jsonResponse(res, 200, { ...require('./lib/hub-halt').getHubHalt().status(), pacing: getPacing().status() });
    }
    // Provider pacing: owner override back to full parallel, and a test hook that makes the next N
    // delegations to a provider fail with a synthetic rate limit (proves the fallback on the live hub).
    // Action-level approvals, tool policy and the spend ledger.
    if (pathname === '/api/approvals' && req.method === 'GET') {
      const ap = getApprovals();
      return jsonResponse(res, 200, { pending: ap.list(), recent: ap.recent(), allowances: getAllowances().list(), timeoutMs: ap.timeoutMs });
    }
    if (pathname.startsWith('/api/approvals/') && req.method === 'POST') {
      const id = decodeURIComponent(pathname.slice('/api/approvals/'.length));
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}') || {}; } catch { return jsonResponse(res, 400, { error: 'invalid JSON' }); }
      const r = getApprovals().resolve(id, body.decision, { remember: ['1h', 'session'].includes(body.remember) ? body.remember : null });
      return jsonResponse(res, r.ok ? 200 : 404, r);
    }
    if (pathname === '/api/approvals/allowances' && req.method === 'DELETE') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}') || {}; } catch {}
      getAllowances().clear(typeof body.key === 'string' && body.key ? body.key : null);
      return jsonResponse(res, 200, { allowances: getAllowances().list() });
    }
    if (pathname.startsWith('/api/policy/') && req.method === 'GET') {
      const name = decodeURIComponent(pathname.slice('/api/policy/'.length));
      const p = await getEffectivePolicy(name);
      return p ? jsonResponse(res, 200, p) : jsonResponse(res, 404, { error: 'unknown agent' });
    }
    if (pathname === '/api/ledger/today' && req.method === 'GET') {
      const l = getLedger();
      return jsonResponse(res, 200, { ...l.today(), caps: l.caps() });
    }
    if (pathname === '/api/ledger/days' && req.method === 'GET') {
      return jsonResponse(res, 200, { days: getLedger().days(30) });
    }
    if (pathname === '/api/ledger/caps' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}') || {}; } catch { return jsonResponse(res, 400, { error: 'invalid JSON' }); }
      const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
      hubSettings.updateSettings({ ledger: { perAgentDailyUsd: num(body.perAgentDailyUsd), hubDailyUsd: num(body.hubDailyUsd) } });
      return jsonResponse(res, 200, { caps: getLedger().caps() });
    }
    if (pathname === '/api/hub/pacing/reset' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}') || {}; } catch { return jsonResponse(res, 400, { error: 'invalid JSON' }); }
      console.log(`[pacing] manual reset${body.provider ? ` for ${body.provider}` : ' (all)'}`);
      return jsonResponse(res, 200, getPacing().reset(typeof body.provider === 'string' && body.provider ? body.provider : null));
    }
    if (pathname === '/api/hub/pacing/fault' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}') || {}; } catch { return jsonResponse(res, 400, { error: 'invalid JSON' }); }
      if (!body.provider) return jsonResponse(res, 400, { error: 'provider required' });
      console.log(`[pacing] TEST fault armed: ${body.provider} x${body.count || 1}`);
      return jsonResponse(res, 200, getPacing().fault(String(body.provider), Number(body.count) || 1));
    }
    if (pathname === '/api/hub/halt' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}') || {}; } catch { return jsonResponse(res, 400, { error: 'invalid JSON' }); }
      const r = haltHub(typeof body.reason === 'string' ? body.reason : null);
      return jsonResponse(res, 200, r);
    }
    if (pathname === '/api/hub/resume' && req.method === 'POST') {
      return jsonResponse(res, 200, resumeHub());
    }

    if (pathname === '/api/agents/reload' && req.method === 'POST') {
      const agents = await getAgents(true);
      return jsonResponse(res, 200, { agents });
    }

    // Subscription usage windows and the plan-limit fallback state (admins). POST .../refresh re-reads them now.
    if ((pathname === '/api/plan-usage' && req.method === 'GET') || (pathname === '/api/plan-usage/refresh' && req.method === 'POST')) {
      if (!access.isAdmin(req.hubUser || { role: 'admin' })) return jsonResponse(res, 403, { error: 'admin_only' });
      const pu = require('./lib/plan-usage').getPlanUsage();
      if (req.method === 'POST') await pu.refresh();
      // Every agent on the Claude client, with its model family, so the Settings box can offer a picker per agent.
      const agentsOnPlan = (await getAgents()).filter(a => /^claude-sdk\//.test(String(a.model || ''))).map(a => ({ name: a.name, display: a.display || null, icon: a.icon || null, model: a.model, family: pu.familyOf(a.model) }));
      return jsonResponse(res, 200, { ok: true, ...pu.snapshot(), agents: agentsOnPlan });
    }

    if (pathname === '/api/models' && req.method === 'GET') {
      const models = await getAvailableModels();
      console.log(`[api/models] Returning ${models.length} models:`, models.slice(0, 5));
      // Tag transport per model so pickers can visibly separate direct-key models
      const cm = require('./lib/cyber-models');
      const transport = {};
      for (const m of models) transport[m] = cm.transportTag(m);
      // Who pays: subscription (Claude sign-in / ChatGPT), API credits (provider key), or local. Pickers label by it.
      const billing = {};
      for (const m of models) billing[m] = require('./lib/billing').billingOf(m);
      // Rebuild state: a page can say "model list is rebuilding" and refetch instead of showing a short list.
      const md = require('./lib/model-discovery');
      const dcache = (() => { try { return loadDiscoveryCache() || {}; } catch { return {}; } })();
      return jsonResponse(res, 200, {
        models,
        transport,                       // { modelId: 'gateway' | 'OPENAI_CYBER' }
        billing,                         // { modelId: { kind: 'subscription'|'api'|'local', via, label } }
        cyber: models.filter(cm.isCyberModel),
        cyberTag: cm.CYBER_TAG,
        discovering: md.isDiscovering(),
        stale: !!dcache.stale,
        discoveredAt: dcache.discoveredAt || null,
      });
    }

    if (pathname === '/api/models/test' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const model = body.model;
      if (!model) return jsonResponse(res, 400, { success: false, error: 'No model specified' });

      // Claude SDK models use OAuth and can't be tested via HTTP gateway
      if (model.startsWith('claude-sdk/')) {
        _modelHealthCache[model] = { working: true, latency: 0, testedAt: Date.now() };
        return jsonResponse(res, 200, { success: true, model, latency: 0, response: 'Claude SDK (OAuth)' });
      }

      // Codex CLI models run on the ChatGPT subscription; "working" = CLI installed and logged in
      if (model.startsWith('codex-cli/')) {
        const st = await require('./lib/codex-cli').loginStatus();
        const err = st.detail || 'Codex CLI not logged in';
        _modelHealthCache[model] = st.loggedIn ? { working: true, latency: 0, testedAt: Date.now() } : { working: false, error: err, testedAt: Date.now() };
        return jsonResponse(res, 200, st.loggedIn ? { success: true, model, latency: 0, response: `Codex CLI (${st.mode === 'chatgpt' ? 'ChatGPT subscription' : st.mode || 'logged in'})` } : { success: false, model, error: err });
      }

      try {
        const t0 = Date.now();
        let text;
        if (isMythosModel(model)) {
          // Route Mythos through direct Anthropic API, not the gateway
          const result = await mythosCompletion(
            [{ role: 'user', content: 'Reply with exactly: OK' }],
            { max_tokens: 10 }
          );
          text = result.choices?.[0]?.message?.content || '';
        } else {
          const result = await chatCompletion(
            [{ role: 'user', content: 'Reply with exactly: OK' }],
            { model, max_tokens: 10 }
          );
          text = result.choices?.[0]?.message?.content || '';
        }
        const latency = Date.now() - t0;
        // Cache result
        _modelHealthCache[model] = { working: true, latency, testedAt: Date.now() };
        return jsonResponse(res, 200, { success: true, model, latency, response: text.slice(0, 100) });
      } catch (e) {
        _modelHealthCache[model] = { working: false, error: e.message.slice(0, 300), testedAt: Date.now() };
        return jsonResponse(res, 200, { success: false, model, error: e.message.slice(0, 300) });
      }
    }

    // Model health status — marks all discovered models as available without
    // sending test prompts (the old approach hammered every LM Studio model).
    // Individual models can still be tested via POST /api/models/test.
    if (pathname === '/api/models/health' && req.method === 'GET') {
      const now = Date.now();
      const models = await getAvailableModels();
      const { hasSdkCredentials } = require('./lib/claude-auth');
      const sdkCredsExist = hasSdkCredentials();
      let codexStatus = null;
      for (const model of models) {
        if (_modelHealthCache[model]) continue;
        if (model.startsWith('claude-sdk/')) {
          _modelHealthCache[model] = sdkCredsExist
            ? { working: true, latency: 0, testedAt: now }
            : { working: false, error: 'Claude SDK credentials not found', testedAt: now };
        } else if (model.startsWith('codex-cli/')) {
          if (!codexStatus) codexStatus = await require('./lib/codex-cli').loginStatus();
          _modelHealthCache[model] = codexStatus.loggedIn
            ? { working: true, latency: 0, testedAt: now }
            : { working: false, error: codexStatus.detail || 'Codex CLI not logged in', testedAt: now };
        } else {
          _modelHealthCache[model] = { working: true, latency: 0, testedAt: now };
        }
      }
      _modelHealthLastRun = now;
      return jsonResponse(res, 200, { models: _modelHealthCache, cached: false, testedAt: now });
    }

    // Trigger a fresh model discovery run across all providers
    if (pathname === '/api/models/discover' && req.method === 'POST') {
      runDiscovery()
        .then(result => console.log('[api] Manual discovery complete'))
        .catch(e => console.error('[api] Manual discovery failed:', e.message));
      return jsonResponse(res, 200, { status: 'discovery_started' });
    }

    // Return the current discovery cache (no network calls)
    if (pathname === '/api/models/discovered' && req.method === 'GET') {
      const cache = loadDiscoveryCache();
      return jsonResponse(res, 200, cache || { status: 'no_cache' });
    }

    if (pathname === '/api/agents/create' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const result = await createAgent(body.name, body.model, body.personality, body.skills, body.category, body.owner || null);
      return jsonResponse(res, result.success ? 200 : 400, result);
    }

    if (pathname === '/api/agents/clone' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const result = await cloneAgent(body.source, body.name);
      return jsonResponse(res, result.success ? 200 : 400, result);
    }

    if (pathname === '/api/agents/rename' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const result = await renameAgent(body.oldName, body.newName);
      return jsonResponse(res, result.success ? 200 : 400, result);
    }

    // /api/agents/:name/model
    if (/^\/api\/agents\/([^/]+)\/model$/.test(pathname) && req.method === 'POST') {
      const name = pathname.split('/')[3];
      const body = JSON.parse(await readBody(req));
      // The model decides which code path and which hands an agent gets (a Codex model is a host shell on this box),
      // so a member may only pick from the admin's list, settings.memberModels (review F22/F35).
      if (!req.hubService && !access.isAdmin(req.hubUser)) {
        const allowed = require('./lib/settings').getSetting('memberModels');
        if (!Array.isArray(allowed) || !allowed.includes(String(body.model || ''))) {
          return jsonResponse(res, 403, { error: 'admin_only', detail: 'only an admin can change this agent\'s model' + (Array.isArray(allowed) && allowed.length ? ` (members may choose: ${allowed.join(', ')})` : '') });
        }
      }
      const result = await setAgentModel(name, body.model);
      if (result.success) await publishAgentUpdate(name, ['model']);
      return jsonResponse(res, result.success ? 200 : 400, result);
    }

    // /api/agents/:name/display
    if (/^\/api\/agents\/([^/]+)\/display$/.test(pathname) && req.method === 'POST') {
      const name = pathname.split('/')[3];
      const body = JSON.parse(await readBody(req));
      const result = await setAgentDisplay(name, body.display);
      if (result.success) await publishAgentUpdate(name, ['display']);
      return jsonResponse(res, result.success ? 200 : 400, result);
    }

    // /api/agents/:name/icon
    if (/^\/api\/agents\/([^/]+)\/icon$/.test(pathname) && req.method === 'POST') {
      const name = pathname.split('/')[3];
      const body = JSON.parse(await readBody(req));
      const result = await setAgentIcon(name, body.icon);
      if (result.success) await publishAgentUpdate(name, ['icon']);
      return jsonResponse(res, result.success ? 200 : 400, result);
    }

    // PATCH /api/agents/:name — update agent fields (category, etc.)
    if (/^\/api\/agents\/([^/]+)$/.test(pathname) && req.method === 'PATCH') {
      const name = decodeURIComponent(pathname.split('/')[3]);
      const body = JSON.parse(await readBody(req));
      // A member may tune their own agent's conversation settings, never its permissions, folders, sandbox, tools,
      // owner or sharing: those are admin decisions (member grants: Users page, Settings page, agent settings page).
      if (!req.hubService && !access.isAdmin(req.hubUser)) {
        const MEMBER_EDITABLE = new Set(['blurb', 'maxContextMessages', 'maxOutputTokens', 'contextBudget', 'compaction', 'minimalContext']);
        const refused = Object.keys(body || {}).filter(k => !MEMBER_EDITABLE.has(k));
        if (refused.length) return jsonResponse(res, 403, { error: `only an admin can change: ${refused.join(', ')}` });
      }
      const { updateAgentField } = require('./lib/agents');
      const result = await updateAgentField(name, body);
      // Handing a head agent to a member: it introduces itself in its (still empty) chat.
      if (result.success && body && body.owner) { const u = hubAuth.getUser(String(body.owner)); if (u && u.role === 'member') require('./lib/teams').greetIfFresh(name, u).catch(() => {}); }
      if (result.success) await publishAgentUpdate(name, Object.keys(body || {}));
      // Folders, sandbox mode or hands changed: the container is rebuilt with the new mounts on the agent's next turn
      // (and removed when the sandbox was switched off). The session volume stays.
      if (result.success && body && ['policy', 'sandbox', 'tools'].some(k => k in body)) {
        try { const rec = (await getAgents()).find(a => a.name === name); if (rec) require('./lib/sandbox').getSandbox().remove(rec).catch(() => {}); } catch {}
      }
      return jsonResponse(res, result.success ? 200 : 400, result);
    }

    // GET /api/auto-model/routes — return the routing table models
    if (pathname === '/api/auto-model/routes' && req.method === 'GET') {
      const { routesFor, ALL_SELECTABLE_MODELS } = require('./lib/auto-model');
      let classifier = { backend: 'builtin', shadow: false };
      try { const c = require('./lib/classifier').getClassifier().config(); classifier = { backend: c.backend, shadow: !!c.shadow }; } catch {}
      return jsonResponse(res, 200, { routes: routesFor(false), sdkRoutes: routesFor(true), models: ALL_SELECTABLE_MODELS, classifier });
    }
    // The optional classifier behind Auto model (lib/classifier): config + tallies, save, and a side-by-side try-out.
    if (pathname === '/api/auto-model/classifier' && (req.method === 'GET' || req.method === 'POST')) {
      if (!access.isAdmin(req.hubUser || { role: 'admin' })) return jsonResponse(res, 403, { error: 'admin_only' });
      const cl = require('./lib/classifier').getClassifier();
      if (req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}');
        const cur = hubSettings.getSetting('autoClassifier') || {};
        const patch = {};
        if (b.backend !== undefined) patch.backend = String(b.backend);
        if (b.localProvider !== undefined) patch.localProvider = String(b.localProvider);
        if (b.localModel !== undefined) patch.localModel = String(b.localModel);
        if (b.localThinking !== undefined) patch.localThinking = !!b.localThinking;
        if (b.confidenceFloor !== undefined) patch.confidenceFloor = Number(b.confidenceFloor);
        if (b.shadow !== undefined) patch.shadow = !!b.shadow;
        if (b.keepOnBox !== undefined) patch.keepOnBox = Array.isArray(b.keepOnBox) ? b.keepOnBox.map(String) : (String(b.keepOnBox || '').split(',').map(s => s.trim()).filter(Boolean));
        hubSettings.updateSettings({ autoClassifier: { ...cur, ...patch } });
        if (b.resetStats) cl.resetStats();
        console.warn(`[classifier] settings changed: ${JSON.stringify(cl.config())}`);
      }
      const local = await cl.localServer(cl.config()).catch(() => null);
      return jsonResponse(res, 200, { ok: true, ...cl.stats(), localServer: local, perplexityKey: !!hubSettings.getProviderKey('perplexity') });
    }
    if (pathname === '/api/auto-model/classify' && req.method === 'POST') {
      if (!access.isAdmin(req.hubUser || { role: 'admin' })) return jsonResponse(res, 403, { error: 'admin_only' });
      const b = JSON.parse((await readBody(req)) || '{}');
      const text = String(b.text || '').slice(0, 4000);
      if (!text.trim()) return jsonResponse(res, 400, { error: 'text required' });
      const am = require('./lib/auto-model');
      const cl = require('./lib/classifier').getClassifier();
      const agentRec = b.agent ? ((await getAgents()).find(a => a.name === b.agent) || null) : null;
      const probes = await cl.probeAll({ text, agent: agentRec });
      const routes = am.routesFor(true);
      const builtin = am.classifyByKeywords(text, false);
      const result = { text, builtin: { category: builtin, model: routes[builtin] } };
      for (const [k, v] of Object.entries(probes)) result[k] = v.category ? { ...v, model: routes[v.category] } : v;
      return jsonResponse(res, 200, result);
    }

    // /api/agents/:name/files
    if (/^\/api\/agents\/([^/]+)\/files$/.test(pathname) && req.method === 'GET') {
      const name = pathname.split('/')[3];
      const files = await getAgentFiles(name);
      return jsonResponse(res, 200, { files });
    }

    // /api/agents/:name/files/:file
    if (/^\/api\/agents\/([^/]+)\/files\/([^/]+)$/.test(pathname) && req.method === 'PUT') {
      const parts = pathname.split('/');
      const name = parts[3];
      const file = parts[5];
      const body = JSON.parse(await readBody(req));
      const result = await saveAgentFile(name, file, body.content);
      // Reload scheduler if TASKS.md was updated
      if (file === 'TASKS.md' && result.success) {
        try { reloadScheduler(); } catch (e) { console.error('[scheduler] Reload failed:', e.message); }
      }
      return jsonResponse(res, result.success ? 200 : 400, result);
    }

    // DELETE /api/agents/:name
    if (/^\/api\/agents\/([^/]+)$/.test(pathname) && req.method === 'DELETE') {
      const name = pathname.split('/')[3];
      const result = await deleteAgent(name);
      return jsonResponse(res, result.success ? 200 : 400, result);
    }

    // ── Chat Routes ─────────────────────────────────────────────────
    if (pathname === '/api/chat/stream' && req.method === 'POST') {
      const body = stripHubOnlyChatFields(JSON.parse(await readBody(req)), req);
      return handleChatStream(body, res);
    }

    if (pathname === '/api/chat' && req.method === 'POST') {
      const body = stripHubOnlyChatFields(JSON.parse(await readBody(req)), req);
      return handleChat(body, res);
    }

    // Stop button: a browser disconnect no longer ends a turn, so stopping is explicit.
    if (pathname === '/api/chat/stop' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const result = stopAgentTurn(String(body?.agent || ''));
      return jsonResponse(res, 200, result);
    }

    if (pathname === '/api/ask_response' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const result = handleAskResponse(body);
      return jsonResponse(res, result.success ? 200 : 400, result);
    }

    // Operator interjection - inject a message into a running agent turn
    if (pathname === '/api/chat/interject' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const result = handleInterjection(body);
      return jsonResponse(res, result.success ? 200 : 400, result);
    }

    // Emergency alert from a local monitor: fixed id + shared secret, hub-composed
    // message. Preempts a running turn (emergency interjection) or starts a new one.
    if (pathname === '/api/chat/alert' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const result = await handleAlert(body);
      return jsonResponse(res, result.status, result.body);
    }

    // Global max_completion_tokens setting
    if (pathname === '/api/max_completion_tokens' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const val = parseInt(body.value, 10);
      if (!val || val < 256 || val > 128000) {
        return jsonResponse(res, 400, { error: 'value must be between 256 and 128000' });
      }
      global.__maxCompletionTokens = val;
      saveSettings();
      return jsonResponse(res, 200, { value: global.__maxCompletionTokens });
    }
    if (pathname === '/api/max_completion_tokens' && req.method === 'GET') {
      return jsonResponse(res, 200, { value: global.__maxCompletionTokens || 32000 });
    }

    // ── Messaging channels (Telegram etc); all logic lives in lib/comms ────────────────────
    if (pathname.startsWith('/api/comms/')) return require('./lib/comms/routes').handle(pathname, req, res, { readBody, jsonResponse, getAgents });

    // ── Trading wallet (owner controls; agents only ever get the wallet_* tools) ──────────
    if (pathname.startsWith('/api/wallet/')) {
      const svc = require('./lib/wallet/service').getWalletService();
      const ks = svc.keystore;
      try {
        if (pathname === '/api/wallet/status' && req.method === 'GET') {
          return jsonResponse(res, 200, { ...svc.status(), walletAgents: require('./lib/wallet/tools').walletAgents() });
        }
        // Scoped executor: registered actions for scripts, under owner caps (lib/wallet/executor.js).
        const wx = require('./lib/wallet/executor');
        if (pathname === '/api/wallet/execute' && req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}');
          try {
            const out = await wx.getWalletExecutor().execute({ ...body, token: req.headers['x-executor-token'] });
            return jsonResponse(res, 200, out);
          } catch (e) {
            const status = e instanceof wx.ExecutorError ? e.status : 500;
            console.log(`[executor] ${body.action || '?'} refused (${status}): ${e.message}`);
            return jsonResponse(res, status, { ok: false, action: body.action || null, refusedBecause: e.message });
          }
        }
        if (pathname === '/api/wallet/executor' && req.method === 'GET') return jsonResponse(res, 200, wx.getWalletExecutor().settings());
        if ((pathname === '/api/wallet/executor/config' || pathname === '/api/wallet/executor/token') && req.method === 'POST') {
          const { passphrase, ...body } = JSON.parse((await readBody(req)) || '{}');
          const ex = wx.getWalletExecutor();
          try { ex.ownerGate({ passphrase }); }
          catch (e) { svc.audit('owner', 'EXECUTOR_OWNER_CHECK', { route: pathname }, { ok: false, error: e.message }); console.warn(`[executor] owner check FAILED on ${pathname}`); return jsonResponse(res, 401, { error: e.message }); }
          if (pathname === '/api/wallet/executor/token') {
            const token = ex.regenerateToken(); svc.audit('owner', 'EXECUTOR_TOKEN', {}, { ok: true }); console.warn('[executor] NEW TOKEN generated by the owner');
            return jsonResponse(res, 200, { token, note: 'Shown once. Only its hash is stored.' });
          }
          const out = ex.configure(body); svc.audit('owner', 'EXECUTOR_CONFIG', body, { ok: true }); console.warn(`[executor] settings changed: enabled=${out.enabled} wallet=${out.wallet} actions=${JSON.stringify(Object.fromEntries(Object.entries(out.actions).map(([k, a]) => [k, { enabled: a.enabled, dryRun: a.dryRun }])))}`);
          return jsonResponse(res, 200, out);
        }
        // Hyperliquid account (lib/wallet/hyperliquid.js): owner settings + agent-key setup.
        const hlMod = require('./lib/wallet/hyperliquid');
        if (pathname === '/api/wallet/hl' && req.method === 'GET') return jsonResponse(res, 200, await hlMod.getHyperliquidService().status());
        if ((pathname === '/api/wallet/hl/config' || pathname === '/api/wallet/hl/agent' || pathname === '/api/wallet/hl/approve-agent') && req.method === 'POST') {
          const { passphrase, ...body } = JSON.parse((await readBody(req)) || '{}');
          const hl = hlMod.getHyperliquidService();
          const proof = passphrase ? 'passphrase' : 'none';
          try { hl.ownerGate({ passphrase }); }
          catch (e) { svc.audit('owner', 'HL_OWNER_CHECK', { route: pathname, proof }, { ok: false, error: e.message }); console.warn(`[hyperliquid] owner check FAILED on ${pathname} (${proof})`); return jsonResponse(res, 401, { error: e.message }); }
          try {
            if (pathname === '/api/wallet/hl/agent') { const a = await hl.setupAgent(); svc.audit('owner', 'HL_AGENT_SETUP', { proof }, { ok: true, agent: a.address, env: hl.settings().env }); console.warn(`[hyperliquid] agent key approved for ${a.main} on ${hl.settings().env}: ${a.address} (${proof})`); return jsonResponse(res, 200, { agent: a, status: await hl.status() }); }
            if (pathname === '/api/wallet/hl/approve-agent') {
              // An external agent (API) wallet, by address and name: a bot's own key, outside the keystore. Trades only, no withdrawals.
              const a = await hl.approveExternalAgent({ agentAddress: body.agentAddress, agentName: body.agentName });
              console.warn(`[hyperliquid] EXTERNAL agent "${a.name}" ${a.address} approved for ${a.main} on ${a.env} (${proof}); listed by the exchange: ${a.verified}`);
              return jsonResponse(res, 200, { agent: a, status: await hl.status() });
            }
            const out = hl.configure(body); svc.audit('owner', 'HL_CONFIG', { ...body, proof }, { ok: true }); console.warn(`[hyperliquid] settings changed: env=${out.env} enabled=${out.enabled} wallet=${out.wallet} (${proof})`);
            return jsonResponse(res, 200, out);
          } catch (e) {
            svc.audit('owner', pathname === '/api/wallet/hl/agent' ? 'HL_AGENT_SETUP' : pathname === '/api/wallet/hl/approve-agent' ? 'HL_EXTERNAL_AGENT_SETUP' : 'HL_CONFIG', { proof }, { ok: false, error: e.message });
            return jsonResponse(res, e.status || 400, { error: e.message });
          }
        }
        if (pathname === '/api/wallet/audit.csv' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="wallet-audit.csv"' });
          return res.end(svc.auditCsv());
        }
        // Signing-firewall address book (lib/wallet/firewall.js): read freely; add / deactivate need the
        // keystore passphrase every time (records are HMAC-signed with it). Never exposed as an agent tool.
        if (pathname === '/api/wallet/allowlist' && req.method === 'GET') {
          const fwMod = require('./lib/wallet/firewall'), roles = fwMod.ROLES.filter(r => r !== 'owner');
          return jsonResponse(res, 200, { file: svc.allowlistFile, owner: require('./lib/wallet/service').OWNER, entries: svc.firewall.list(),
            roles, allowedFor: Object.fromEntries(roles.map(r => [r, fwMod.allowedFor(r)])) });
        }
        if (req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}');
          if (pathname === '/api/wallet/allowlist' || pathname === '/api/wallet/allowlist/add' || pathname === '/api/wallet/allowlist/deactivate') {
            const deact = pathname.endsWith('/deactivate'), action = deact ? 'ALLOWLIST_DEACTIVATE' : 'ALLOWLIST_ADD';
            // Only the named fields reach the firewall; the passphrase is used for the HMAC and never stored or logged.
            const passphrase = body.passphrase, pick = k => body[k] === undefined ? {} : { [k]: body[k] };
            const rest = deact ? { ...pick('address'), ...pick('chainId'), ...pick('reason'), by: 'owner-panel' }
              : { ...pick('address'), ...pick('chainId'), ...pick('label'), ...pick('role'), ...pick('verifiedBy'), anySelector: body.anySelector === true, allowValue: body.allowValue === true, by: 'owner-panel' };
            if (!String(passphrase || '')) { svc.audit('owner', action, rest, { ok: false, error: 'empty passphrase' }); return jsonResponse(res, 400, { error: 'The keystore passphrase is required for every allow-list change.' }); }
            let rec; try { rec = deact ? svc.firewall.deactivate(rest, passphrase) : svc.firewall.add(rest, passphrase); }
            catch (e) { svc.audit('owner', action, rest, { ok: false, error: e.message }); console.warn(`[firewall] ${action} refused: ${e.message}`); return jsonResponse(res, /passphrase/i.test(e.message) ? 401 : 400, { error: e.message }); }
            const { sig, ...shown } = rec;
            svc.audit('owner', action, shown, { ok: true }); console.warn(`[firewall] ${action}: ${rec.address} chain ${rec.chainId}${rec.label ? ' ' + rec.label : ''}`);
            return jsonResponse(res, 200, { record: shown, entries: svc.firewall.list() });
          }
          if (pathname === '/api/wallet/init')   { ks.init(body.passphrase); svc.audit('owner', 'KEYSTORE_CREATED', {}, { ok: true }); return jsonResponse(res, 200, svc.status()); }
          if (pathname === '/api/wallet/unlock') {
            if (!String(body.passphrase || '')) { svc.audit('owner', 'UNLOCK', {}, { ok: false, error: 'empty passphrase' }); return jsonResponse(res, 400, { error: 'No passphrase was sent. Type it in the Unlock box (not the Executor or Hyperliquid box) and try again.' }); }
            try { ks.unlock(body.passphrase); }
            catch (e) { svc.audit('owner', 'UNLOCK', {}, { ok: false, error: e.message }); console.warn('[wallet] unlock FAILED: wrong passphrase'); return jsonResponse(res, 401, { error: e.message }); }
            svc.audit('owner', 'UNLOCK', {}, { ok: true }); return jsonResponse(res, 200, svc.status());
          }
          if (pathname === '/api/wallet/lock')   { ks.lock(); svc.audit('owner', 'LOCK', {}, { ok: true }); return jsonResponse(res, 200, svc.status()); }
          // Owner proof (the keystore passphrase) for everything that adds signing keys or resumes trading.
          const ownerProof = (action, extra = {}) => {
            if (ks.exists() && !ks.verify(String(body.passphrase || ''))) { svc.audit('owner', action, extra, { ok: false, error: 'owner check failed' }); console.warn(`[wallet] ${action} REFUSED: wrong or missing passphrase`); return jsonResponse(res, 401, { error: `Owner check failed: the keystore passphrase is required to ${action.toLowerCase().replace(/_/g, ' ')}.` }); }
            return null;
          };
          if (pathname === '/api/wallet/pause') {
            const paused = !!body.paused;
            const pwallet = String(body.wallet || '').trim().toLowerCase() || null;   // null = every wallet
            if (!paused) { const r = ownerProof('UNPAUSE', pwallet ? { wallet: pwallet } : {}); if (r) return r; }   // anyone may pause; only the owner resumes
            try { svc.setPaused(paused, 'owner', pwallet); } catch (e) { return jsonResponse(res, 400, { error: e.message }); }
            return jsonResponse(res, 200, svc.status());
          }
          if (pathname === '/api/wallet/create') {
            const name = String(body.name || '').trim().toLowerCase();
            const tierOpts = { tier: body.tier || 'guarded', fundingCapUsd: body.fundingCapUsd };
            { const r = ownerProof('WALLET_CREATE', { wallet: name, ...tierOpts }); if (r) return r; }
            let w; try { w = ks.createWallet(name, tierOpts); }
            catch (e) { svc.audit('owner', 'WALLET_CREATED', { wallet: name, ...tierOpts }, { ok: false, error: e.message }); return jsonResponse(res, 400, { error: e.message }); }
            svc.audit('owner', 'WALLET_CREATED', { wallet: w.name, tier: w.tier, fundingCapUsd: w.fundingCapUsd }, { ok: true, address: w.address });
            if (w.tier === 'open') console.warn(`[wallet] OPEN wallet "${w.name}" created (no signing firewall, funding cap $${w.fundingCapUsd}): ${w.address}`);
            return jsonResponse(res, 200, { ...svc.status(), created: w });
          }
          if (pathname === '/api/wallet/import') {
            const name = String(body.name || '').trim().toLowerCase();
            { const r = ownerProof('WALLET_IMPORT', { wallet: name }); if (r) return r; }
            const tierOpts = { tier: body.tier || 'guarded', fundingCapUsd: body.fundingCapUsd };
            let w; try { w = ks.importWallet(name, body.secret, { index: body.index === undefined || body.index === '' ? 0 : body.index, ...tierOpts }); }
            catch (e) { svc.audit('owner', 'WALLET_IMPORTED', { wallet: name, ...tierOpts }, { ok: false, error: e.message }); return jsonResponse(res, 400, { error: e.message }); }
            svc.audit('owner', 'WALLET_IMPORTED', { wallet: w.name, source: w.source, tier: w.tier, fundingCapUsd: w.fundingCapUsd }, { ok: true, address: w.address }); console.warn(`[wallet] wallet "${w.name}" imported (${w.source}, tier ${w.tier}): ${w.address}`);
            return jsonResponse(res, 200, { ...svc.status(), imported: w });
          }
          // The one route that hands a key back to the owner. Passphrase every time; audited; never a tool.
          if (pathname === '/api/wallet/reveal') {
            const name = String(body.name || '').trim().toLowerCase();
            let out; try { out = ks.reveal(name, String(body.passphrase || '')); }
            catch (e) { svc.audit('owner', 'KEY_REVEALED', { wallet: name }, { ok: false, error: e.message }); console.warn(`[wallet] key reveal for "${name}" REFUSED: ${e.message}`); return jsonResponse(res, /passphrase/i.test(e.message) ? 401 : 400, { error: e.message }); }
            svc.audit('owner', 'KEY_REVEALED', { wallet: name }, { ok: true, address: out.address, seed: !!out.mnemonic }); console.warn(`[wallet] PRIVATE KEY of "${name}" (${out.address}) shown to the owner`);
            return jsonResponse(res, 200, out);
          }
          if (pathname === '/api/wallet/backup') { const file = ks.backup(); if (!file) return jsonResponse(res, 400, { error: 'No keystore to back up.' }); svc.audit('owner', 'KEYSTORE_BACKUP', {}, { ok: true, file }); return jsonResponse(res, 200, { file, ...svc.status() }); }
        }
        return jsonResponse(res, 404, { error: 'Unknown wallet endpoint' });
      } catch (e) {
        return jsonResponse(res, 400, { error: e.message });
      }
    }

    // SDK sub-workers policy: 'fallback' (default) | 'allow' | 'off'  — see lib/worker-policy.js
    if (pathname === '/api/sdk_workers' && req.method === 'GET') {
      const wp = require('./lib/worker-policy');
      return jsonResponse(res, 200, { mode: wp.getMode(), modes: wp.MODES, default: wp.DEFAULT_MODE });
    }
    if (pathname === '/api/sdk_workers' && req.method === 'POST') {
      const wp = require('./lib/worker-policy');
      const body = JSON.parse(await readBody(req));
      const requested = String(body.mode || '').trim().toLowerCase();
      if (!wp.MODES.includes(requested)) return jsonResponse(res, 400, { error: `mode must be one of: ${wp.MODES.join(', ')}` });
      hubSettings.updateSettings({ sdkWorkers: requested });
      console.log(`[settings] sdkWorkers = ${requested}`);
      return jsonResponse(res, 200, { mode: wp.getMode() });
    }

    // Detached jobs started by agents with run_job (owner view: every job)
    if (pathname === '/api/jobs' && req.method === 'GET') {
      const runner = getJobRunner();
      const params = new URL(req.url, `http://${URL_HOST}`).searchParams;
      const id = params.get('id');
      if (id) { try { return jsonResponse(res, 200, runner.status(id, null, { tailLines: Number(params.get('tail') || 40) })); } catch (e) { return jsonResponse(res, 404, { error: e.message }); } }
      return jsonResponse(res, 200, { mode: runner.mode(), jobs: runner.list(null) });
    }
    if (pathname === '/api/jobs/cancel' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      try { return jsonResponse(res, 200, getJobRunner().cancel(body.id, null)); } catch (e) { return jsonResponse(res, 404, { error: e.message }); }
    }

    // Scheduled tasks (schedule_task + owner panel). The owner sees and controls every task;
    // TASKS.md tasks (lib/scheduler.js) are listed read-only alongside with their recent runs.
    if (pathname === '/api/scheduled-tasks' && req.method === 'GET') {
      const st = getScheduledTasks();
      const now = Date.now();
      const tasksMd = getSchedulerStatus().tasks.map(t => {
        let nextRunAt = null;
        if (t.enabled && t.triggerType === 'cron' && t.expression) {
          try { const n = scheduledTasksLib.nextCronRun(t.expression, now, t.timezone || scheduledTasksLib.DEFAULT_TZ); nextRunAt = n ? new Date(n).toISOString() : null; } catch {}
        }
        return { ...t, nextRunAt, nextRunLocal: nextRunAt ? scheduledTasksLib.fmtLocal(Date.parse(nextRunAt)) : null };
      });
      const day = (ms) => new Date(ms).toISOString().split('T')[0];
      const tasksMdRuns = [...getTaskLogs(day(now - 86400000)), ...getTaskLogs(day(now))].reverse().slice(0, 30);
      return jsonResponse(res, 200, {
        tz: scheduledTasksLib.DEFAULT_TZ, limits: { perAgent: scheduledTasksLib.MAX_TASKS_PER_AGENT, minIntervalMinutes: scheduledTasksLib.MIN_INTERVAL_MS / 60000 },
        tasks: st.list(scheduledTasksLib.OWNER), runs: st.recentRuns(30), tasksMd, tasksMdRuns,
      });
    }
    if (pathname === '/api/scheduled-tasks' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      try { return jsonResponse(res, 200, await getScheduledTasks().create({ requester: scheduledTasksLib.OWNER, agent: body.agent, when: body.when, prompt: body.prompt, label: body.label })); }
      catch (e) { return jsonResponse(res, 400, { error: e.message }); }
    }
    if (pathname === '/api/scheduled-tasks/update' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      try { return jsonResponse(res, 200, await getScheduledTasks().update(body.id, scheduledTasksLib.OWNER, { when: body.when, prompt: body.prompt, label: body.label, agent: body.agent })); }
      catch (e) { return jsonResponse(res, 400, { error: e.message }); }
    }
    if (pathname === '/api/scheduled-tasks/action' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      try { return jsonResponse(res, 200, getScheduledTasks().action(body.id, scheduledTasksLib.OWNER, String(body.action || ''))); }
      catch (e) { return jsonResponse(res, 400, { error: e.message }); }
    }
    if (pathname === '/api/scheduled-tasks/preview' && req.method === 'POST') {
      // Parse a "when" without creating anything (panel shows the next run before saving).
      const body = JSON.parse(await readBody(req));
      try { const now = Date.now(); const r = scheduledTasksLib.checkSchedule(scheduledTasksLib.parseWhen(body.when, now), now); return jsonResponse(res, 200, { ...r.schedule, nextRunAt: new Date(r.nextRunAt).toISOString(), nextRunLocal: scheduledTasksLib.fmtLocal(r.nextRunAt) }); }
      catch (e) { return jsonResponse(res, 400, { error: e.message }); }
    }

    // Context messages setting
    if (pathname === '/api/max_context_messages' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const val = parseInt(body.value, 10);
      if (!val || val < 5 || val > 200) {
        return jsonResponse(res, 400, { error: 'value must be between 5 and 200' });
      }
      global.__maxContextMessages = val;
      saveSettings();
      return jsonResponse(res, 200, { value: global.__maxContextMessages });
    }
    if (pathname === '/api/max_context_messages' && req.method === 'GET') {
      return jsonResponse(res, 200, { value: global.__maxContextMessages || 40 });
    }

    // Caveman mode toggle — ultra-terse responses
    if (pathname === '/api/caveman_mode' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      global.__cavemanMode = !!body.enabled;
      saveSettings();
      return jsonResponse(res, 200, { enabled: global.__cavemanMode });
    }
    if (pathname === '/api/caveman_mode' && req.method === 'GET') {
      return jsonResponse(res, 200, { enabled: !!global.__cavemanMode });
    }

    // Pre-scan toggle — use cheap model to filter tools per prompt
    if (pathname === '/api/prescan_tools' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      global.__prescanToolsEnabled = !!body.enabled;
      saveSettings();
      return jsonResponse(res, 200, { enabled: global.__prescanToolsEnabled });
    }
    if (pathname === '/api/prescan_tools' && req.method === 'GET') {
      return jsonResponse(res, 200, { enabled: !!global.__prescanToolsEnabled });
    }

    // Global confirm-tools toggle — frontend can update mid-stream
    if (pathname === '/api/confirm_tools_toggle' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      global.__confirmToolsEnabled = !!body.enabled;
      saveSettings();
      return jsonResponse(res, 200, { enabled: global.__confirmToolsEnabled });
    }
    if (pathname === '/api/confirm_tools_toggle' && req.method === 'GET') {
      return jsonResponse(res, 200, { enabled: !!global.__confirmToolsEnabled });
    }

    // Lazy tools toggle
    if (pathname === '/api/lazy_tools' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      global.__lazyToolsEnabled = !!body.enabled;
      saveSettings();
      return jsonResponse(res, 200, { enabled: global.__lazyToolsEnabled });
    }
    if (pathname === '/api/lazy_tools' && req.method === 'GET') {
      return jsonResponse(res, 200, { enabled: global.__lazyToolsEnabled !== false });
    }

    if (pathname === '/api/tool_confirm' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const { request_id, approved } = body;
      if (!request_id) {
        return jsonResponse(res, 400, { error: 'Missing request_id' });
      }
      resolveToolConfirm(request_id, !!approved);
      return jsonResponse(res, 200, { success: true });
    }

    // ── Web push (mobile PWA) ───────────────────────────────────────
    if (pathname === '/api/push/vapid-public-key' && req.method === 'GET') {
      return jsonResponse(res, 200, { key: require('./lib/push').getPush().publicKey() });
    }
    if (pathname === '/api/push/subscribe' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const r = require('./lib/push').getPush().subscribe(body.subscription, body.agents, req.hubUser ? { id: req.hubUser.id, role: req.hubUser.role } : null);
      return jsonResponse(res, r.ok ? 200 : 400, r);
    }
    if (pathname === '/api/push/unsubscribe' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      return jsonResponse(res, 200, require('./lib/push').getPush().unsubscribe(String(body?.endpoint || '')));
    }
    // ── Shared folders an agent can be granted (lib/folders; the picker on the agent settings page): admin-only
    //    (unknown /api paths are admin by default, lib/access classifyRoute). ?agent=<name> adds `granted`: that
    //    agent's policy.roots resolved to absolute paths, in order, so the page can pre-tick the list. ──
    // ── Root grants (lib/root-grants): the operator hands one agent root for a while. Admin only, by a signed-in
    //    person: the hub's own service identity is refused so no agent can grant itself root through a loopback call. ──
    if (pathname === '/api/root-grants' || /^\/api\/root-grants\/[^/]+$/.test(pathname)) {
      if (req.hubService) return jsonResponse(res, 403, { error: 'admin_only', detail: 'root grants are given by a signed-in admin, never by the hub itself' });
      if (!access.isAdmin(req.hubUser) || req.hubPendingTotp) return jsonResponse(res, 403, { error: 'admin_only' });
      const rg = require('./lib/root-grants').getRootGrants();
      const sb = require('./lib/sandbox').getSandbox();
      const describe = async (name) => {
        const a = (await getAgents()).find(x => x.name === name);
        if (!a) return null;
        const memberOwned = !!(a.owner && !hubAuth.admins().some(u => String(u.id) === String(a.owner)));
        return { agent: name, lead: require('./lib/agents').isLeadAgent(name), memberOwned, sandboxed: sb.isSandboxed(a), grant: rg.active(name) };
      };
      if (req.method === 'GET' && pathname === '/api/root-grants') {
        const who = new URL(req.url, 'http://localhost').searchParams.get('agent');
        if (who) { const d = await describe(who); return d ? jsonResponse(res, 200, { ok: true, ...d, defaultMinutes: rg.DEFAULT_MINUTES, maxMinutes: rg.MAX_MINUTES }) : jsonResponse(res, 404, { error: 'unknown agent' }); }
        return jsonResponse(res, 200, { ok: true, grants: rg.list(), defaultMinutes: rg.DEFAULT_MINUTES, maxMinutes: rg.MAX_MINUTES });
      }
      if (req.method === 'POST' && pathname === '/api/root-grants') {
        const b = JSON.parse((await readBody(req)) || '{}');
        const d = await describe(String(b.agent || ''));
        if (!d) return jsonResponse(res, 404, { error: 'unknown agent' });
        if (d.lead) return jsonResponse(res, 400, { error: 'the lead agent always has root; nothing to grant' });
        if (d.memberOwned) return jsonResponse(res, 400, { error: 'a member\'s agent never gets root' });
        if (d.sandboxed) return jsonResponse(res, 400, { error: 'this agent\'s shell runs inside a container, where there is no sudo; switch its sandbox off first if it must run on the host' });
        try {
          const g = rg.grant(d.agent, { minutes: b.minutes === undefined ? undefined : Number(b.minutes), by: req.hubUser.id, note: b.note });
          hubAuth.audit(req.hubUser.id, 'root.grant', `${g.agent} ${g.minutes}min until ${g.until}${g.note ? ` ${g.note}` : ''}`, hubAuth.clientIp(req));
          try { require('./lib/hub-events').events.publish('root_grant', { agent: g.agent, until: g.until, by: g.by }); } catch {}
          return jsonResponse(res, 200, { ok: true, grant: g });
        } catch (e) { return jsonResponse(res, 400, { error: e.message }); }
      }
      if (req.method === 'DELETE') {
        const name = decodeURIComponent(pathname.split('/')[3] || '');
        const had = rg.revoke(name, { by: req.hubUser.id });
        if (had) { hubAuth.audit(req.hubUser.id, 'root.revoke', name, hubAuth.clientIp(req)); try { require('./lib/hub-events').events.publish('root_grant', { agent: name, until: null, by: req.hubUser.id }); } catch {} }
        return jsonResponse(res, 200, { ok: true, revoked: had });
      }
      return jsonResponse(res, 405, { error: 'method not allowed' });
    }
    if (pathname === '/api/folders' && req.method === 'GET') {
      const { listFolders, resolveRoots } = require('./lib/folders');
      const agents = await getAgents();
      const adminIds = new Set(hubAuth.admins().map(u => String(u.id)));
      const out = { ok: true, folders: listFolders({ agents, adminIds }) };
      const who = new URL(req.url, 'http://localhost').searchParams.get('agent');
      if (who) {
        const a = agents.find(x => x.name === who);
        if (!a) return jsonResponse(res, 404, { error: 'unknown agent' });
        out.granted = resolveRoots(a.policy && a.policy.roots);
      }
      return jsonResponse(res, 200, out);
    }
    // ── Agent sandboxes (lib/sandbox): admin-only. ──
    if (pathname.startsWith('/api/sandbox')) {
      const sb = require('./lib/sandbox').getSandbox();
      if (pathname === '/api/sandbox/status' && req.method === 'GET') return jsonResponse(res, 200, { ok: true, ...(await sb.status()) });
      if (pathname === '/api/sandbox/build' && req.method === 'POST') {
        // The image build takes minutes: run it as a detached job so the owner can watch it in the jobs list.
        const b = JSON.parse((await readBody(req)) || '{}');
        const ver = b.version ? String(b.version).replace(/[^0-9A-Za-z.-]/g, '') : '';
        const runner = getJobRunner();
        const cmd = `cd ${JSON.stringify(__dirname)} && docker build${ver ? ` --build-arg CLAUDE_CODE_VERSION=${ver}` : ''} -t ${sb.IMAGE} sandbox/ 2>&1 | tail -30 && docker images ${sb.IMAGE.split(':')[0]} --format '{{.Repository}}:{{.Tag}} {{.Size}}'`;
        const job = await runner.run({ owner: 'maestro', name: 'build sandbox image', command: cmd, cwd: __dirname, timeoutMinutes: 30 });
        return jsonResponse(res, 200, { ok: true, job: job && job.id ? job.id : null });
      }
      const m = pathname.match(/^\/api\/sandbox\/agents\/([^/]+)\/(reset|stop)$/);
      if (m && req.method === 'POST') {
        const a = (await getAgents()).find(x => x.name === m[1]);
        if (!a) return jsonResponse(res, 404, { error: 'unknown agent' });
        const b = JSON.parse((await readBody(req)) || '{}');
        try { if (m[2] === 'stop') await sb.stop(a); else await sb.remove(a, { home: !!b.home }); return jsonResponse(res, 200, { ok: true }); }
        catch (e) { return jsonResponse(res, 400, { error: e.message }); }
      }
      return jsonResponse(res, 404, { error: 'unknown sandbox route' });
    }
    // ── Readiness (lib/readiness): what this machine is missing and what to do about it; admin-only. ──
    if (pathname === '/api/readiness' && req.method === 'GET') {
      const r = await require('./lib/readiness').getReadiness({ exposed: () => !!BIND.exposed, setupNeeded: () => isSetupNeeded() }).check();
      return jsonResponse(res, 200, { ok: true, ...r });
    }
    // ── Security check (lib/security-check): admin-only. GET answers with the last result while it is under an hour
    // old, POST /run runs it now, POST /fix-modes tightens the file permissions it flagged (never loosens). ──
    if (pathname === '/api/security-check' && req.method === 'GET') {
      const r = await securityCheck().latest({ maxAgeMs: 60 * 60 * 1000 });
      return jsonResponse(res, 200, { ok: true, ...r });
    }
    if (pathname === '/api/security-check/run' && req.method === 'POST') {
      const r = await securityCheck().run();
      return jsonResponse(res, 200, { ok: true, ...r, cached: false });
    }
    if (pathname === '/api/security-check/fix-modes' && req.method === 'POST') {
      if (req.hubService) return jsonResponse(res, 403, { ok: false, error: 'an admin session is required' });
      const r = securityCheck().fixModes();
      console.log(`[security] file modes tightened by ${req.hubUser && req.hubUser.login ? req.hubUser.login : 'an admin'}: ${r.fixed.map(f => f.path).join(', ') || 'nothing to do'}`);
      return jsonResponse(res, 200, { ok: true, ...r });
    }
    // ── Web search and fetch (lib/web-search, lib/web-fetch): admin-only. ──
    if (pathname.startsWith('/api/websearch')) {
      const ws = require('./lib/web-search').getWebSearch();
      const wf = require('./lib/web-fetch').getWebFetch();
      if (pathname === '/api/websearch/status' && req.method === 'GET') {
        return jsonResponse(res, 200, { ok: true, search: await ws.status(), fetch: await wf.status() });
      }
      if (pathname === '/api/websearch/config' && req.method === 'POST') {
        // Merge, never replace: an empty key field means "unchanged", null means "clear".
        const b = JSON.parse((await readBody(req)) || '{}');
        const cur = hubSettings.getSetting('webSearch') || {};
        const next = { ...cur, keys: { ...(cur.keys || {}) }, searxng: { ...(cur.searxng || {}) } };
        if (Array.isArray(b.order)) next.order = b.order.filter(x => ws.BACKENDS.includes(String(x)));
        if (Array.isArray(b.disabled)) next.disabled = b.disabled.filter(x => ws.BACKENDS.includes(String(x)));
        if (b.maxResults !== undefined) next.maxResults = Math.max(1, Math.min(Number(b.maxResults) || 10, 25));
        if (b.keys && typeof b.keys === 'object') for (const [k, v] of Object.entries(b.keys)) { if (!(k in ws.ENV_KEYS)) continue; if (v === null) delete next.keys[k]; else if (typeof v === 'string' && v.trim()) next.keys[k] = v.trim(); }
        if (b.searxng && typeof b.searxng === 'object' && b.searxng.url !== undefined) next.searxng.url = String(b.searxng.url || '').trim();
        const patch = { webSearch: next };
        if (b.fetch && typeof b.fetch === 'object') {
          const f = { ...(hubSettings.getSetting('webFetch') || {}) };
          if (['admin', 'none', 'all'].includes(b.fetch.allowPrivate)) f.allowPrivate = b.fetch.allowPrivate;
          if (['auto', 'off', 'always'].includes(b.fetch.render)) f.render = b.fetch.render;
          if (b.fetch.jina !== undefined) f.jina = !!b.fetch.jina;
          if (b.fetch.cacheMinutes !== undefined) f.cacheMinutes = Math.max(0, Math.min(Number(b.fetch.cacheMinutes) || 0, 1440));
          patch.webFetch = f;
          wf.clearCache();
        }
        hubSettings.updateSettings(patch);
        return jsonResponse(res, 200, { ok: true, search: await ws.status(), fetch: await wf.status() });
      }
      if (pathname === '/api/websearch/test' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}');
        const r = await ws.search(String(b.query || ''), { maxResults: b.maxResults || 5, freshness: b.freshness, backend: b.backend || undefined });
        return jsonResponse(res, 200, { ok: true, ...r, rendered: ws.render(r) });
      }
      if (pathname === '/api/websearch/fetch-test' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}');
        try {
          const p = await wf.fetchPage(String(b.url || ''), { allowPrivate: wf.config().allowPrivate !== 'none', render: !!b.render, maxLength: Math.min(Number(b.maxLength) || 1500, 20000) });
          return jsonResponse(res, 200, { ok: true, ...p });
        } catch (e) { return jsonResponse(res, 200, { ok: false, error: e.message }); }
      }
      if (pathname === '/api/websearch/searxng/start' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}');
        const port = Math.max(1024, Math.min(Number(b.port) || ws.searxng.port, 65535));
        const runner = getJobRunner();
        const job = await runner.run({ owner: 'maestro', name: 'start SearXNG search container', command: ws.searxng.startCommand(port), cwd: __dirname, timeoutMinutes: 15 });
        const cur = hubSettings.getSetting('webSearch') || {};
        hubSettings.updateSettings({ webSearch: { ...cur, searxng: { ...(cur.searxng || {}), url: `http://127.0.0.1:${port}` } } });
        return jsonResponse(res, 200, { ok: true, job: job && job.id ? job.id : null, url: `http://127.0.0.1:${port}` });
      }
      if (pathname === '/api/websearch/searxng/stop' && req.method === 'POST') {
        return jsonResponse(res, 200, { ok: await ws.searxng.stop() });
      }
      return jsonResponse(res, 404, { error: 'unknown websearch route' });
    }
    // ── Data connectors (lib/connectors): admin-only (every /api route not listed in lib/access is admin). ──
    // ── Modules: optional capabilities with a guided setup (lib/modules, modules/<id>/) ──
    if (pathname === '/api/modules' || pathname.startsWith('/api/modules/')) {
      const mods = require('./lib/modules').getModules();
      const bodyJson = async () => { try { return JSON.parse((await readBody(req)) || '{}'); } catch { return {}; } };
      const fail = (e) => jsonResponse(res, 400, { error: e.message, ...(e.check ? { check: e.check } : {}), ...(e.needsAck ? { needsAck: true } : {}) });
      // Changes come from a person on the page, never from the hub's internal service identity (agents' calls back into the hub).
      if (req.method !== 'GET' && req.hubService) return jsonResponse(res, 403, { error: 'Module changes need a signed-in admin.' });
      try {
        if (pathname === '/api/modules' && req.method === 'GET') return jsonResponse(res, 200, { ok: true, modules: mods.list() });
        let m = pathname.match(/^\/api\/modules\/([a-z][a-z0-9-]{1,31})$/);
        if (m && req.method === 'GET') return jsonResponse(res, 200, { ok: true, module: mods.detail(m[1]) });
        if (m && req.method === 'DELETE') return jsonResponse(res, 200, mods.remove(m[1]));
        m = pathname.match(/^\/api\/modules\/([a-z][a-z0-9-]{1,31})\/(step|check|settings|enable|disable|audit)$/);
        if (m) {
          const id = m[1], act = m[2];
          if (act === 'audit' && req.method === 'GET') return jsonResponse(res, 200, { ok: true, entries: mods.auditTail(id, 100) });
          if (req.method === 'POST') {
            const b = await bodyJson();
            if (act === 'step') return jsonResponse(res, 200, await mods.runStep(id, String(b.step || ''), b.input || {}));
            if (act === 'check') return jsonResponse(res, 200, { ok: true, check: await mods.check(id, b.check), module: mods.detail(id) });
            if (act === 'settings') return jsonResponse(res, 200, { ok: true, module: mods.saveSettings(id, b.values || {}) });
            if (act === 'enable' || act === 'disable') return jsonResponse(res, 200, { ok: true, module: mods.setEnabled(id, act === 'enable') });
          }
        }
        return jsonResponse(res, 404, { error: 'unknown modules route' });
      } catch (e) { return fail(e); }
    }

    if (pathname.startsWith('/api/connector')) {
      const cx = require('./lib/connectors').getConnectors();
      const reply = (fn) => { try { const r = fn(); return r && typeof r.then === 'function' ? r.then(v => jsonResponse(res, 200, { ok: true, ...(v && typeof v === 'object' && !Array.isArray(v) ? v : { result: v }) })).catch(e => jsonResponse(res, 400, { error: e.message })) : jsonResponse(res, 200, { ok: true, ...(r && typeof r === 'object' ? r : {}) }); } catch (e) { return jsonResponse(res, 400, { error: e.message }); } };
      const bodyJson = async () => { try { return JSON.parse((await readBody(req)) || '{}'); } catch { return {}; } };
      if (pathname === '/api/connectors' && req.method === 'GET') return jsonResponse(res, 200, { ok: true, ...cx.list() });
      if (pathname === '/api/connectors' && req.method === 'POST') { const b = await bodyJson(); const { passphrase, newPassphrase, ...spec } = b; return reply(() => ({ connector: cx.upsert(spec, { passphrase, newPassphrase }) })); }
      if (pathname === '/api/connectors/lock-all' && req.method === 'POST') return reply(() => { cx.lockAll(); return {}; });
      let m = pathname.match(/^\/api\/connectors\/([^/]+)$/);
      if (m && req.method === 'DELETE') return reply(() => cx.remove(m[1]));
      m = pathname.match(/^\/api\/connectors\/([^/]+)\/(unlock|lock|test|grants)$/);
      if (m && req.method === 'POST') {
        const id = m[1], act = m[2]; const b = await bodyJson();
        if (act === 'unlock') return reply(() => ({ connector: cx.unlock(id, String(b.passphrase || '')) }));
        if (act === 'lock') return reply(() => ({ connector: cx.lock(id) }));
        if (act === 'grants') return reply(() => ({ connector: cx.setGrants(id, b.agents === undefined ? null : b.agents) }));
        if (act === 'test') return reply(() => cx.test(id));
      }
      if (pathname === '/api/connector-groups' && req.method === 'GET') return jsonResponse(res, 200, { ok: true, groups: cx.list().groups });
      if (pathname === '/api/connector-groups' && req.method === 'POST') { const b = await bodyJson(); return reply(() => ({ group: cx.createGroup(String(b.id || ''), b.label, String(b.passphrase || '')) })); }
      m = pathname.match(/^\/api\/connector-groups\/([^/]+)(?:\/(unlock|lock))?$/);
      if (m && req.method === 'DELETE') { const b = await bodyJson(); return reply(() => cx.deleteGroup(m[1], String(b.passphrase || ''))); }
      if (m && m[2] && req.method === 'POST') { const b = await bodyJson(); return reply(() => ({ group: m[2] === 'unlock' ? cx.unlockGroup(m[1], String(b.passphrase || '')) : cx.lockGroup(m[1]) })); }
      return jsonResponse(res, 404, { error: 'unknown connectors route' });
    }
    if (pathname === '/api/push/status' && req.method === 'GET') {
      // The phone checks that the hub still knows its browser subscription; known=false means re-register.
      const ep = String(new URL(req.url, `http://${URL_HOST}:${PORT}`).searchParams.get('endpoint') || '');
      const push = require('./lib/push').getPush();
      return jsonResponse(res, 200, { ok: true, subscriptions: push.count(), known: ep ? push.has(ep) : null });
    }
    if (pathname === '/api/push/test' && req.method === 'POST') {
      const r = await require('./lib/push').getPush().test();
      return jsonResponse(res, 200, { ok: true, ...r });
    }

    // Browser-only observer, behind Hub auth and strict same-origin transport.
    // No bridge bearer token is exposed to the UI.
    // Hub event stream: hub-initiated turns (consultations, job notices/reports, scheduled tasks)
    if (pathname === '/api/events' && req.method === 'GET') {
      if (!isSameOriginStreamRequest(req, PORT)) {
        return jsonResponse(res, 403, { error: 'forbidden_origin' });
      }
      res.removeHeader('Access-Control-Allow-Origin');
      if (req.hubService) return require('./lib/hub-events').events.subscribe(req, res);
      const allAgents = await getAgents();
      const isAdmin = access.isAdmin(req.hubUser);
      const visible = (name) => isAdmin || access.canAccessAgent(req.hubUser, name, { agents: allAgents, resolveVirtual: (n) => temporalWorkersLib.getVirtual(n) });
      return require('./lib/hub-events').events.subscribe(req, res, { isAdmin, visibleAgent: visible, filter: (ev) => visible(ev.agent) });
    }

    // ── Worker Routes ───────────────────────────────────────────────
    if (pathname === '/api/workers' && req.method === 'GET') {
      return jsonResponse(res, 200, { workers: getActiveWorkers() });
    }

    if (pathname === '/api/cancel-worker' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const result = cancelWorker(body.workerId);
      return jsonResponse(res, result.success ? 200 : 400, result);
    }

    // ── Session/History Routes ──────────────────────────────────────
    if (/^\/api\/history\/([^/]+)$/.test(pathname) && req.method === 'GET') {
      const name = pathname.split('/')[3];
      const history = loadConversationLog(name);
      // The running turn's reply is saved every 5 s as plain text (so a restart loses nothing); it is not a finished
      // reply. Flagged, pages show the live turn in its place (text and tool calls) instead of a text-only copy.
      const hubEv = require('./lib/hub-events');
      hubEv.markInProgress(history, hubEv.events.turnFor(name));
      return jsonResponse(res, 200, { history });
    }

    if (/^\/api\/session\/([^/]+)$/.test(pathname) && req.method === 'DELETE') {
      const name = pathname.split('/')[3];
      clearConversation(name);
      return jsonResponse(res, 200, { success: true });
    }

    // ── Memory Routes ────────────────────────────────────────────────
    if (pathname === '/api/memory/stats' && req.method === 'GET') {
      const memoryDb = require('./lib/memory-db');
      const agents = await getAgents();
      const stats = {};
      for (const a of agents) {
        stats[a.name] = memoryDb.getMemoryStats(a.name);
      }
      return jsonResponse(res, 200, { stats });
    }

    if (/^\/api\/memory\/([^/]+)\/stats$/.test(pathname) && req.method === 'GET') {
      const memoryDb = require('./lib/memory-db');
      const name = pathname.split('/')[3];
      return jsonResponse(res, 200, memoryDb.getMemoryStats(name));
    }

    if (pathname === '/api/memory/shared' && req.method === 'GET') {
      const memoryDb = require('./lib/memory-db');
      return jsonResponse(res, 200, { content: memoryDb.readSharedMemory() });
    }

    if (pathname === '/api/memory/shared/search' && req.method === 'POST') {
      const memoryDb = require('./lib/memory-db');
      const body = JSON.parse(await readBody(req));
      return jsonResponse(res, 200, { content: memoryDb.searchSharedMemory(body.query) });
    }

    if (pathname === '/api/memory/distill' && req.method === 'POST') {
      const memoryDb = require('./lib/memory-db');
      const body = JSON.parse(await readBody(req));
      const agent = body.agent;
      const dates = memoryDb.getUndistilledDates(agent);
      return jsonResponse(res, 200, { agent, undistilledDates: dates });
    }

    // ── Skills Routes ────────────────────────────────────────────────

    // List all skills with their status
    if (pathname === '/api/skills' && req.method === 'GET') {
      return jsonResponse(res, 200, { skills: getSkillStatus() });
    }

    // Set auth token for a skill
    if (/^\/api\/skills\/([^/]+)\/token$/.test(pathname) && req.method === 'POST') {
      const skillId = pathname.split('/')[3];
      if (!SKILLS[skillId]) return jsonResponse(res, 404, { error: `Unknown skill: ${skillId}` });
      const body = JSON.parse(await readBody(req));
      if (!body.token) return jsonResponse(res, 400, { error: 'Missing token' });
      setToken(skillId, body.token);
      clearToolCache(skillId);
      // Trigger tool discovery
      try {
        const tools = await discoverTools(skillId);
        return jsonResponse(res, 200, { success: true, skillId, toolCount: tools.length });
      } catch (e) {
        return jsonResponse(res, 200, { success: true, skillId, warning: `Token saved but tool discovery failed: ${e.message}` });
      }
    }

    // Discover/refresh tools for a skill
    if (/^\/api\/skills\/([^/]+)\/discover$/.test(pathname) && req.method === 'POST') {
      const skillId = pathname.split('/')[3];
      if (!SKILLS[skillId]) return jsonResponse(res, 404, { error: `Unknown skill: ${skillId}` });
      clearToolCache(skillId);
      try {
        const tools = await discoverTools(skillId);
        return jsonResponse(res, 200, {
          success: true,
          skillId,
          tools: tools.map(t => ({ name: t.name, description: t.description })),
        });
      } catch (e) {
        return jsonResponse(res, 500, { success: false, error: e.message });
      }
    }

    // OAuth callback handler for Google Workspace
    if (pathname === '/api/skills/google-workspace/oauth-callback' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      if (!body.token) return jsonResponse(res, 400, { error: 'Missing token' });
      setToken('google-workspace', body.token);
      clearToolCache('google-workspace');
      try {
        const tools = await discoverTools('google-workspace');
        return jsonResponse(res, 200, { success: true, toolCount: tools.length });
      } catch (e) {
        return jsonResponse(res, 200, { success: true, warning: `Token saved but discovery failed: ${e.message}` });
      }
    }

    // ── Scheduler API ──────────────────────────────────────────────

    if (pathname === '/api/scheduler' && req.method === 'GET') {
      return jsonResponse(res, 200, getSchedulerStatus());
    }

    if (pathname === '/api/scheduler/reload' && req.method === 'POST') {
      reloadScheduler();
      return jsonResponse(res, 200, getSchedulerStatus());
    }

    if (pathname === '/api/scheduler/logs' && req.method === 'GET') {
      const date = new URL(req.url, `http://${URL_HOST}`).searchParams.get('date')
        || new Date().toISOString().split('T')[0];
      return jsonResponse(res, 200, { date, logs: getTaskLogs(date) });
    }

    // ── Task Queue ───────────────────────────────────────────────
    if (pathname === '/api/task-queue' && req.method === 'GET') {
      const params = new URL(req.url, `http://${URL_HOST}`).searchParams;
      const tasks = listQueuedTasks({
        status: params.get('status') || undefined,
        agent: params.get('agent') || undefined,
      });
      return jsonResponse(res, 200, { tasks });
    }

    // ── Tool Learning ─────────────────────────────────────────────
    if (pathname === '/api/tool-learning/guidance' && req.method === 'GET') {
      const { getAllGuidance } = require('./lib/tool-learning');
      return jsonResponse(res, 200, { guidance: getAllGuidance() });
    }
    if (pathname === '/api/tool-learning/errors' && req.method === 'GET') {
      const { getRecentErrors } = require('./lib/tool-learning');
      return jsonResponse(res, 200, { errors: getRecentErrors() });
    }
    if (pathname === '/api/tool-learning/guidance' && req.method === 'POST') {
      const body = await readBody(req);
      const { tool_pattern, guidance, priority } = JSON.parse(body);
      const { addGuidance } = require('./lib/tool-learning');
      addGuidance(tool_pattern, guidance, priority || 5);
      return jsonResponse(res, 200, { ok: true });
    }

    // ── Model Telemetry ───────────────────────────────────────────
    if (pathname === '/api/model-telemetry' && req.method === 'GET') {
      const tel = require('./lib/model-telemetry');
      const hours = parseInt(new URL(req.url, `http://${URL_HOST}`).searchParams.get('hours') || '168', 10);
      return jsonResponse(res, 200, {
        hours,
        models: tel.modelReport(hours),
        unhealthy: tel.unhealthyModels(hours),
      });
    }
    if (pathname === '/api/model-telemetry/tools' && req.method === 'GET') {
      const tel = require('./lib/model-telemetry');
      const _p = new URL(req.url, `http://${URL_HOST}`).searchParams;
      const hours = parseInt(_p.get('hours') || '168', 10);
      const model = _p.get('model') || null;
      return jsonResponse(res, 200, { hours, model, tools: tel.toolReport(hours, model) });
    }
    // Connection reuse / keep-alive efficacy (P1)
    if (pathname === '/api/model-telemetry/connections' && req.method === 'GET') {
      const tel = require('./lib/model-telemetry');
      const httpAgent = require('./lib/http-agent');
      const _p = new URL(req.url, `http://${URL_HOST}`).searchParams;
      const hours = parseInt(_p.get('hours') || '24', 10);
      const model = _p.get('model') || null;
      return jsonResponse(res, 200, {
        hours, model,
        pool: httpAgent.stats(),
        ...tel.connReport(hours, model),
      });
    }

    // ── System endpoints continue below ──



    // ── Agent Dreaming ─────────────────────────────────────────────
    if (pathname === '/api/dream' && req.method === 'POST') {
      const { runDreamCycle, getDreamStatus } = require('./lib/dream');
      const currentStatus = getDreamStatus();
      if (currentStatus.status === 'running') {
        return jsonResponse(res, 409, { error: 'Dream cycle already running', status: currentStatus });
      }
      const agents = await getAgents();
      // Don't await — run async, client polls status
      runDreamCycle(agents).catch(e => console.error('[dream] Error:', e.message));
      return jsonResponse(res, 202, { status: 'started', message: 'Dream cycle initiated' });
    }

    if (pathname === '/api/dream/status' && req.method === 'GET') {
      const { getDreamStatus } = require('./lib/dream');
      return jsonResponse(res, 200, getDreamStatus());
    }

    // ── System Status ───────────────────────────────────────────────
    // ── Pending Restart Action ─────────────────────────────────────
    // ── Health check (for restart polling) ──
    if (pathname === '/api/health' && req.method === 'GET') {
      if (!serverReady) return jsonResponse(res, 503, { status: 'starting' });
      // bootId changes on every process start: the page compares it before and after a restart to prove one happened.
      return jsonResponse(res, 200, { status: 'ok', bootId: require('./lib/hub-events').BOOT_ID, pid: process.pid });
    }

    // ── Settings API ───────────────────────────────────────────────
    if (pathname === '/api/settings' && req.method === 'GET') {
      return jsonResponse(res, 200, hubSettings.getForUI());
    }

    if (pathname === '/api/settings' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const patch = JSON.parse(body);
          // The wallet-agent list is not a UI setting: widening it hands signing tools to another agent. Owner edits data/settings.json by hand.
          if (patch && typeof patch === 'object' && 'walletAgents' in patch) { console.warn('[settings] ignored walletAgents in /api/settings patch (edit data/settings.json directly)'); delete patch.walletAgents; }
          // The owner's receiving address decides where wallet value may go: not a UI setting either (review F10). HUB_WALLET_OWNER in .env, or data/settings.json by hand.
          if (patch && typeof patch === 'object' && 'walletOwner' in patch) { console.warn('[settings] ignored walletOwner in /api/settings patch (set HUB_WALLET_OWNER or edit data/settings.json directly)'); delete patch.walletOwner; }
          // Hub default for every member agent: grantable classes and valid decisions only (lib/tool-policy).
          if (patch && patch.memberPolicy !== undefined) patch.memberPolicy = require('./lib/tool-policy').sanitizeGrants({ policy: patch.memberPolicy }).policy || {};
          // Per-class approval cards: known class names only (lib/policy-gate APPROVAL_CLASSES).
          if (patch && patch.approvalClasses !== undefined) { const ok = require('./lib/policy-gate').APPROVAL_CLASSES; patch.approvalClasses = Array.isArray(patch.approvalClasses) ? [...new Set(patch.approvalClasses.map(String).filter(c => ok.includes(c)))] : []; }
          // Claude plan: warning levels, and the optional automatic switch (merged onto the stored policy, so its map survives).
          if (patch && patch.planWarn !== undefined) patch.planWarn = require('./lib/plan-usage').cleanWarn(patch.planWarn);
          if (patch && patch.planFallback !== undefined) patch.planFallback = require('./lib/plan-usage').cleanPolicy(patch.planFallback, hubSettings.getSetting('planFallback'));
          const providersChanged = !!(patch && patch.providers);
          hubSettings.updateSettings(patch);
          // A new key or URL changes which models exist — rediscover now
          // rather than waiting for the 6-hour cycle.
          if (providersChanged) {
            runDiscovery().catch(e => console.error('[settings] Rediscovery failed:', e.message));
          }
          return jsonResponse(res, 200, { ok: true });
        } catch (e) {
          return jsonResponse(res, 400, { error: e.message });
        }
      });
      return;
    }

    if (pathname === '/api/settings/test-provider' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { provider, url, apiKey } = JSON.parse(body);
          const testUrl = url || hubSettings.getProviderUrl(provider);
          const testKey = apiKey || hubSettings.getProviderKey(provider);

          if (provider === 'lmstudio' || provider === 'ollama' || provider === 'omlx') {
            const r = await fetch(`${testUrl}/models`, {
              signal: AbortSignal.timeout(5000),
            });
            if (!r.ok) return jsonResponse(res, 200, { ok: false, error: `HTTP ${r.status}` });
            const data = await r.json();
            const count = (data.data || []).length;
            return jsonResponse(res, 200, { ok: true, models: count });
          }

          if (provider === 'anthropic') {
            const r = await fetch('https://api.anthropic.com/v1/models?limit=1', {
              headers: { 'x-api-key': testKey, 'anthropic-version': '2023-06-01' },
              signal: AbortSignal.timeout(5000),
            });
            return jsonResponse(res, 200, { ok: r.ok, status: r.status });
          }

          if (provider === 'openai') {
            const r = await fetch('https://api.openai.com/v1/models', {
              headers: { 'Authorization': `Bearer ${testKey}` },
              signal: AbortSignal.timeout(5000),
            });
            return jsonResponse(res, 200, { ok: r.ok, status: r.status });
          }

          if (provider === 'google') {
            const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/openai/models`, {
              headers: { 'Authorization': `Bearer ${testKey}` },
              signal: AbortSignal.timeout(5000),
            });
            return jsonResponse(res, 200, { ok: r.ok, status: r.status });
          }

          if (provider === 'perplexity') {
            const r = await fetch('https://api.perplexity.ai/chat/completions', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${testKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: 'sonar', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
              signal: AbortSignal.timeout(8000),
            });
            return jsonResponse(res, 200, { ok: r.ok || r.status === 400, status: r.status });
          }

          return jsonResponse(res, 400, { error: `Unknown provider: ${provider}` });
        } catch (e) {
          return jsonResponse(res, 200, { ok: false, error: e.message });
        }
      });
      return;
    }

    // ── Update from GitHub (pull only — see lib/git-sync.js) ────────
    if (pathname === '/api/git-sync/status' && req.method === 'GET') {
      const { getSyncStatus } = require('./lib/git-sync');
      try {
        return jsonResponse(res, 200, await getSyncStatus());
      } catch (e) {
        return jsonResponse(res, 500, { ok: false, error: e.message });
      }
    }

    if (pathname === '/api/git-sync/update' && req.method === 'POST') {
      const { runUpdate } = require('./lib/git-sync');
      try {
        // { channel: 'stable' | 'experimental' } switches branches first (the Update dialog asks every time).
        let body = {}; try { body = JSON.parse((await readBody(req)) || '{}') || {}; } catch {}
        return jsonResponse(res, 200, await runUpdate({ channel: body && body.channel ? String(body.channel) : null }));
      } catch (e) {
        return jsonResponse(res, 500, { success: false, error: e.message });
      }
    }

    if (pathname === '/api/git-sync/force-update' && req.method === 'POST') {
      const { runForceUpdate } = require('./lib/git-sync');
      try {
        return jsonResponse(res, 200, await runForceUpdate());
      } catch (e) {
        return jsonResponse(res, 500, { success: false, error: e.message });
      }
    }

    if (pathname === '/api/git-sync/rewrite-update' && req.method === 'POST') {
      const { runRewriteUpdate } = require('./lib/git-sync');
      try {
        let body = {}; try { body = JSON.parse((await readBody(req)) || '{}') || {}; } catch {}
        return jsonResponse(res, 200, await runRewriteUpdate({ confirmLocalOnly: body && body.confirmLocalOnly }));
      } catch (e) {
        return jsonResponse(res, 500, { success: false, error: e.message });
      }
    }

    // ── Manual restart via UI button ──
    if (pathname === '/api/restart' && req.method === 'POST') {
      console.log('[Server] Manual restart triggered via UI button');
      // Flush all active agent responses to disk before restarting
      try {
        flushActiveResponses();
        console.log('[Server] Active responses flushed successfully');
      } catch (e) {
        console.error('[Server] Flush error before restart:', e.message);
      }
      // systemd installs: the process exits with code 75 and systemd restarts it; others: safe-restart.sh with a visible log.
      const r = require('./lib/restart').requestRestart({ projectDir: __dirname, port: PORT, reason: 'UI button', by: 'owner' });
      if (r.error) return jsonResponse(res, 500, { error: r.error });
      return jsonResponse(res, 200, { status: 'restarting', bootId: require('./lib/hub-events').BOOT_ID, pid: process.pid, ...r });
    }
    // The page shows this when a restart left the same process running (boot id unchanged): what the relauncher
    // and the server logged, so a failed restart is never silent again.
    if (pathname === '/api/restart/log' && req.method === 'GET') {
      return jsonResponse(res, 200, { ok: true, bootId: require('./lib/hub-events').BOOT_ID, pid: process.pid, ...require('./lib/restart').restartLogTail(__dirname) });
    }

    if (pathname === '/api/restart/pending' && req.method === 'GET') {
      const pendingFile = path.join(__dirname, 'data', 'pending-restart-action.json');
      try {
        if (fs.existsSync(pendingFile)) {
          const data = JSON.parse(fs.readFileSync(pendingFile, 'utf-8'));
          return jsonResponse(res, 200, data);
        }
      } catch (e) {
        console.error(`[Server] Error reading pending restart action: ${e.message}`);
      }
      return jsonResponse(res, 204, null); // No pending action
    }

    if (pathname === '/api/restart/pending' && req.method === 'DELETE') {
      const pendingFile = path.join(__dirname, 'data', 'pending-restart-action.json');
      try {
        if (fs.existsSync(pendingFile)) {
          fs.unlinkSync(pendingFile);
        }
      } catch (e) {
        console.error(`[Server] Error deleting pending restart action: ${e.message}`);
      }
      return jsonResponse(res, 200, { ok: true });
    }

    if (pathname === '/api/system-status' && req.method === 'GET') {
      const cpus = os.cpus();
      const loadAvg = os.loadavg();
      return jsonResponse(res, 200, {
        platform: os.platform(),
        arch: os.arch(),
        hostname: os.hostname(),
        uptime: Math.floor(os.uptime()),
        cpuCount: cpus.length,
        cpuModel: cpus[0]?.model || 'unknown',
        loadAvg: loadAvg.map(v => v.toFixed(2)),
        memTotal: Math.round(os.totalmem() / 1024 / 1024 / 1024 * 10) / 10,
        memFree: Math.round(os.freemem() / 1024 / 1024 / 1024 * 10) / 10,
        nodeVersion: process.version,
        gateway: 'multi-provider (direct)',
      });
    }

    // ── Tiger Team API ──────────────────────────────────────────────
    // Tiger Team user message injection
    if (pathname === '/api/tiger-team/inject' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const { session_id, message } = body;
      if (!session_id || !message) return jsonResponse(res, 400, { error: 'Missing session_id or message' });
      if (!global.__tigerTeamSessions) global.__tigerTeamSessions = {};
      const session = global.__tigerTeamSessions[session_id];
      if (!session) return jsonResponse(res, 404, { error: 'Session not found' });
      const state = session.tigerTeamId && getTigerTeamState(session.tigerTeamId);
      if (!state) return jsonResponse(res, 409, { error: 'Team is still starting.  Retry after it is ready.' });
      // Interject: the coordinator gets it durably (journaled; picked up before its next model
      // call, survives resume). With target "team" (default) every participant working RIGHT NOW
      // also gets it live, at its next tool boundary, so nobody keeps working on stale
      // instructions while the coordinator waits on them. A named participant can be targeted too.
      const { isAgentActive: ttIsActive, handleInterjection: ttInterject } = require('./lib/sdk-chat');
      const target = String(body.target || 'team');
      const running = Object.values(state.calls || {}).filter(c => c.status === 'running' && c.agent !== state.coordinator && ttIsActive(c.agent)).map(c => c.agent);
      const live = target === 'team' ? [...new Set(running)] : (target !== 'coordinator' && running.includes(target)) ? [target] : [];
      if (target !== 'team' && target !== 'coordinator' && !live.length) return jsonResponse(res, 409, { error: `"${target}" is not working right now; send it to the team or the coordinator instead.` });
      const delivered = [];
      if (target === 'team' || target === 'coordinator') { ttRecovery.queueDirective(ttStore, session.tigerTeamId, state, message); delivered.push({ agent: state.coordinator, how: 'queued' }); }
      for (const agent of live) { const r = ttInterject({ agent, message: `[Interjection from the war room, addressed to the whole team]: ${message}` }); if (r.success) delivered.push({ agent, how: 'live' }); }
      try { ttStore.append(session.tigerTeamId, state, { type: 'tt_interjection', message, target, delivered, at: new Date().toISOString() }); } catch {}
      console.log(`[tiger-team] interjection for ${session.tigerTeamId} (${target}): ${delivered.map(d => `${d.agent}:${d.how}`).join(', ') || 'nobody'}`);
      try {
        if (!session.res.destroyed && !session.res.writableEnded) session.res.write(`data: ${JSON.stringify({ gateway: { type: 'tt_user_message', message, target, delivered } })}\n\n`);
      } catch {}
      return jsonResponse(res, 200, { ok: true, target, delivered, queued: (session.pendingMessages || []).length });
    }

    // Tiger Team update participants
    if (pathname === '/api/tiger-team/update-participants' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const { participants } = body;
      if (!Array.isArray(participants)) return jsonResponse(res, 400, { error: 'participants must be an array' });
      // Update the active Tiger Team state in sdk-chat
      const { updateTigerTeamParticipants } = require('./lib/sdk-chat');
      const updated = updateTigerTeamParticipants(participants);
      if (!updated) return jsonResponse(res, 404, { error: 'No active Tiger Team found' });
      return jsonResponse(res, 200, { ok: true, participants });
    }

    // Tiger Team stop
    if (pathname === '/api/tiger-team/stop' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const { session_id } = body;
      if (!global.__tigerTeamSessions) global.__tigerTeamSessions = {};
      const session = global.__tigerTeamSessions[session_id];
      if (!session) return jsonResponse(res, 404, { error: 'Session not found' });
      session.stopped = true;
      // Target ONLY this session's own Tiger Team, not every running TT -
      // stopTigerTeam(null) previously killed every concurrent investigation.
      if (session.tigerTeamId) stopTigerTeam(session.tigerTeamId);
      else session.abortController?.abort();
      try {
        if (!session.res.destroyed && !session.res.writableEnded) session.res.write(`data: ${JSON.stringify({ gateway: { type: 'tt_interrupted', reason: 'User stopped the session' } })}\n\n`);
        if (!session.res.destroyed && !session.res.writableEnded) session.res.write('data: [DONE]\n\n');
        if (!session.res.destroyed && !session.res.writableEnded) session.res.end();
      } catch {}
      return jsonResponse(res, 200, { ok: true });
    }

    // Tiger Team save (manual - prompts for title)
    if (pathname === '/api/tiger-team/save' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const { session_id, save_id, title, objective, coordinator, participants, transcript, findings, mode } = body;
      // Reuse existing save_id if provided (overwrite), otherwise generate new
      const saveId = save_id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
      // Pull plainTranscript from active state if available (richer context for continuations)
      const { activeTigerTeams } = require('./lib/sdk-chat');
      const activeState = session_id ? activeTigerTeams?.get(session_id) : null;
      const plainTranscript = activeState?.plainTranscript || '';
      const saveData = {
        id: saveId,
        title: title || objective?.slice(0, 80) || 'Untitled',
        objective,
        coordinator,
        participants,
        mode: mode || 'led',
        findings: findings || [],
        transcript: transcript || '',
        plainTranscript,
        saved_at: new Date().toISOString(),
        session_id,
      };
      const savePath = require('path').join(__dirname, 'data', 'tiger-teams', `${saveId}.json`);
      require('fs').writeFileSync(savePath, JSON.stringify(saveData, null, 2));
      return jsonResponse(res, 200, { ok: true, id: saveId, title: saveData.title });
    }

    // Tiger Team auto-save (idempotent - overwrites using session_id as save key)
    if (pathname === '/api/tiger-team/autosave' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const { session_id, objective, coordinator, participants, transcript, findings, mode, status } = body;
      if (!session_id) return jsonResponse(res, 400, { error: 'Missing session_id' });
      const fs = require('fs');
      const path = require('path');
      const dir = path.join(__dirname, 'data', 'tiger-teams');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // Use session_id-based filename for idempotent overwrites
      const saveId = `auto_${session_id}`;
      const savePath = path.join(dir, `${saveId}.json`);
      // Pull plainTranscript from active state
      const { activeTigerTeams } = require('./lib/sdk-chat');
      const activeState = activeTigerTeams?.get(session_id);
      const plainTranscript = activeState?.plainTranscript || '';
      const saveData = {
        id: saveId,
        title: (objective || 'Untitled').slice(0, 80),
        objective,
        coordinator,
        participants,
        mode: mode || 'led',
        findings: findings || activeState?.findings || [],
        transcript: transcript || '',
        plainTranscript,
        saved_at: new Date().toISOString(),
        session_id,
        auto_saved: true,
        status: status || (activeState?.completedAt ? 'complete' : 'in_progress'),
      };
      fs.writeFileSync(savePath, JSON.stringify(saveData, null, 2));
      return jsonResponse(res, 200, { ok: true, id: saveId });
    }

    // Full, local-only investigation record.  Never reconstruct evidence from HTML.
    if (pathname.startsWith('/api/tiger-team/archive/') && req.method === 'GET') {
      const id = pathname.split('/').pop();
      if (!ttValidId(id)) return jsonResponse(res, 400, { error: 'Invalid id' });
      const state = getTigerTeamState(id);
      if (!state) return jsonResponse(res, 404, { error: 'Investigation not found' });
      const params = new URL(req.url, 'http://127.0.0.1').searchParams;
      if (!params.has('download')) {
        try { return jsonResponse(res, 200, ttRecovery.archivePage(ttStore, id, state, Object.fromEntries(params))); }
        catch (e) { return jsonResponse(res, 400, { error: e.message }); }
      }
      // Streaming export keeps event history out of one giant JS array.
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="${id}-full-record.json"` });
      try {
        const write = async text => {
          if (res.destroyed || res.writableEnded) throw new Error('Download disconnected');
          if (!res.write(text)) await new Promise((resolve, reject) => {
            const cleanup = () => { res.off('drain', done); res.off('close', closed); res.off('error', failed); };
            const done = () => { cleanup(); resolve(); };
            const closed = () => { cleanup(); reject(new Error('Download disconnected')); };
            const failed = e => { cleanup(); reject(e); };
            res.once('drain', done); res.once('close', closed); res.once('error', failed);
          });
        };
        const captured = ttRecovery.snapshot(id, state);
        // Serialize before yielding, so live state changes do not mutate this snapshot.
        await write('{"state":' + JSON.stringify(captured) + ',"events":[');
        let comma = '';
        for (const event of ttStore.events(id)) {
          if (event.seq > (captured.eventSeq || 0)) break;
          await write(comma + JSON.stringify(event)); comma = ',';
        }
        await write('],"artifacts":{'); comma = '';
        const dir = path.join(ttStore.dir, id + '.artifacts');
        for (const file of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
          if (!/^[a-f0-9]{64}\.txt$/.test(file)) continue;
          const hash = file.slice(0, -4);
          await write(comma + JSON.stringify(hash) + ':' + JSON.stringify(ttStore.readArtifact(id, hash))); comma = ',';
        }
        await write('}}'); res.end();
      } catch (e) { if (!res.destroyed) res.destroy(); }
      return;
    }

    // Only an explicit operator submission can resolve an uncertain tool outcome.
    if (pathname === '/api/tiger-team/reconcile' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      if (!ttValidId(body.session_id)) return jsonResponse(res, 400, { error: 'Invalid id' });
      const state = getTigerTeamState(body.session_id);
      if (!state) return jsonResponse(res, 404, { error: 'Investigation not found' });
      const copy = structuredClone(ttRecovery.snapshot(body.session_id, state));
      try {
        if (state.executing || state.apiReserved) throw new Error('Investigation is still active');
        ttRecovery.reconcile(copy, body);
        ttStore.save(body.session_id, copy);
        state.calls = copy.calls;
        return jsonResponse(res, 200, { ok: true, unresolved: ttRecovery.unresolved(state) });
      } catch (e) { return jsonResponse(res, 409, { error: e.message }); }
    }

    // Tiger Team load specific - legacy save file first, durable checkpoint fallback.
    if (pathname.startsWith('/api/tiger-team/saved/') && req.method === 'GET') {
      const saveId = pathname.split('/').pop();
      if (!ttValidId(saveId)) return jsonResponse(res, 400, { error: 'Invalid id' });
      const savePath = require('path').join(__dirname, 'data', 'tiger-teams', `${saveId}.json`);
      try {
        const data = JSON.parse(require('fs').readFileSync(savePath, 'utf8'));
        const canonical = data.tiger_team_id || data.session_id;
        const current = ttValidId(canonical) ? getTigerTeamState(canonical) : null;
        return jsonResponse(res, 200, current ? { ...data, tiger_team_id: canonical, status: current.status, error: current.error, plainTranscript: ttRecovery.displayTranscript(current), transcript: '', durable: true, unresolved: ttRecovery.unresolved(current) } : data);
      } catch {
        // Legacy save file missing - fall back to a durable checkpoint if one exists
        // (e.g. session was interrupted by a restart before it was ever manually saved).
        const cp = ttReadCheckpoint(saveId);
        if (cp) {
          return jsonResponse(res, 200, {
            id: cp.id,
            title: (cp.objective || 'Recovered Tiger Team').slice(0, 80),
            objective: cp.objective || '',
            coordinator: cp.coordinator,
            participants: cp.participants || [],
            mode: cp.mode || 'led',
            findings: cp.findings || [],
            transcript: '', // no HTML transcript for durable-only entries - UI renders plainTranscript as text
            plainTranscript: ttRecovery.displayTranscript(cp),
            unresolved: ttRecovery.unresolved(cp),
            error: cp.error || null,
            saved_at: cp.updated_at,
            session_id: cp.id,
            auto_saved: true,
            status: cp.status || 'interrupted',
            durable: true,
          });
        }
        return jsonResponse(res, 404, { error: 'Saved session not found' });
      }
    }

    // Tiger Team list saved - merges legacy save files with durable checkpoints
    // not already covered by a legacy file, so recoverable teams are findable
    // in the Load panel even if the process restarted before an autosave ran.
    if (pathname === '/api/tiger-team/saved' && req.method === 'GET') {
      const dir = require('path').join(__dirname, 'data', 'tiger-teams');
      const fs = require('fs');
      const legacyIds = new Set();
      let sessions = [];
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
        sessions = files.map(f => {
          try {
            const data = JSON.parse(fs.readFileSync(require('path').join(dir, f), 'utf8'));
            if (ttValidId(data.session_id) && getTigerTeamState(data.session_id)) return null;
            data.id ||= f.slice(0, -5);
            data.title ||= (data.objective || 'Saved Tiger Team').slice(0, 80);
            legacyIds.add(data.id);
            return { id: data.id, title: data.title, objective: data.objective?.slice(0, 200), coordinator: data.coordinator, participants: data.participants, saved_at: data.saved_at, auto_saved: data.auto_saved || false, status: data.status || 'complete' };
          } catch { return null; }
        }).filter(Boolean);
      }
      const checkpoints = ttListCheckpoints();
      for (const cp of checkpoints) {
        if (legacyIds.has(cp.id)) continue; // legacy save already covers this id
        sessions.push({
          id: cp.id,
          title: (cp.objective || 'Recovered Tiger Team').slice(0, 200),
          objective: (cp.objective || '').slice(0, 200),
          coordinator: cp.coordinator,
          participants: cp.participants || [],
          saved_at: cp.updated_at,
          auto_saved: true,
          status: cp.status || 'interrupted',
          durable: true,
        });
      }
      // Sort by saved_at descending (most recent first)
      sessions.sort((a, b) => (b.saved_at || '').localeCompare(a.saved_at || ''));
      return jsonResponse(res, 200, { sessions });
    }

    // Tiger Team delete saved
    if (pathname.startsWith('/api/tiger-team/saved/') && req.method === 'DELETE') {
      const saveId = pathname.split('/').pop();
      if (!ttValidId(saveId)) return jsonResponse(res, 400, { error: 'Invalid id' });
      const state = getTigerTeamState(saveId);
      if (state?.executing || state?.apiReserved) return jsonResponse(res, 409, { error: 'Cannot delete a running investigation' });
      const savePath = require('path').join(__dirname, 'data', 'tiger-teams', `${saveId}.json`);
      try { require('fs').unlinkSync(savePath); } catch {}
      try { fs.unlinkSync(path.join(ttStore.dir, `${saveId}.json`)); } catch {}
      try { fs.unlinkSync(path.join(ttStore.dir, `${saveId}.events.jsonl`)); } catch {}
      fs.rmSync(path.join(ttStore.dir, `${saveId}.artifacts`), { recursive: true, force: true });
      activeTigerTeams.delete(saveId);
      return jsonResponse(res, 200, { ok: true });
    }

    // Tiger Team list sessions
    if (pathname === '/api/tiger-team/list' && req.method === 'GET') {
      return jsonResponse(res, 200, { sessions: listTigerTeams() });
    }

    // Tiger Team status - GET so the UI (or a resume click) can check whether
    // a team is still running BEFORE issuing resume/continue, avoiding
    // duplicate-launch races.  Merges durable checkpoint state.
    if (pathname === '/api/tiger-team/status' && req.method === 'GET') {
      const parsedUrl = new URL(req.url, `http://${URL_HOST}:${PORT}`);
      const id = parsedUrl.searchParams.get('id');
      if (!id || !ttValidId(id)) return jsonResponse(res, 400, { error: 'Missing or invalid id' });
      let state = ttGetDurableState(id);
      if (!state) {
        try {
          const legacy = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'tiger-teams', id + '.json'), 'utf8'));
          const canonical = legacy.tiger_team_id || legacy.session_id;
          state = (ttValidId(canonical) && getTigerTeamState(canonical)) || { ...legacy, id, status: ['complete', 'completed'].includes(legacy.status) ? 'completed' : 'interrupted', legacyRecovery: true };
        } catch {}
      }
      if (!state) return jsonResponse(res, 404, { error: 'Tiger Team not found (no live state or checkpoint)' });
      return jsonResponse(res, 200, {
        id: state.id,
        status: state.status,
        error: state.error,
        unresolved: ttRecovery.unresolved(state),
        completedAt: state.completedAt,
        objective: (state.objective || '').slice(0, 300),
        coordinator: state.coordinator,
        participants: state.participants,
        mode: state.mode,
      });
    }

    // Resume preserves the original call journal.  Continue starts a new directive.
    if (['/api/tiger-team/continue', '/api/tiger-team/resume'].includes(pathname) && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      let { session_id: id, message } = body;
      const resume = pathname.endsWith('/resume');
      if (!ttValidId(id) || (!resume && (typeof message !== 'string' || !message.trim()))) {
        return jsonResponse(res, 400, { error: 'Missing or invalid session_id/message' });
      }
      let state = getTigerTeamState(id);
      if (!state) {
        // Older saves have transcripts but no execution journal.  Preserve the
        // original metadata and clearly label their weaker recovery guarantee.
        let saved;
        try { saved = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'tiger-teams', id + '.json'), 'utf8')); }
        catch { return jsonResponse(res, 404, { error: 'No saved Tiger Team found' }); }
        const canonical = saved.tiger_team_id || saved.session_id;
        if (ttValidId(canonical) && getTigerTeamState(canonical)) {
          id = canonical; state = getTigerTeamState(id);
        } else {
          reconstituteTigerTeam(id, { ...saved, legacyRecovery: true });
          state = getTigerTeamState(id);
        }
      }
      if (!state || !state.coordinator) return jsonResponse(res, 400, { error: 'Saved team has no coordinator' });
      if (state.apiReserved || state.executing || !state.completedAt) {
        return jsonResponse(res, 409, { error: 'Tiger Team is still running or stopping', id });
      }
      if (resume && state.status === 'completed') {
        return jsonResponse(res, 409, { error: 'This team completed.  Use Continue for new work.', id });
      }
      const unresolved = ttRecovery.unresolved(state);
      if (unresolved.length) return jsonResponse(res, 409, { error: 'Verify uncertain tool outcomes before resuming or continuing.', unresolved, id });
      state.apiReserved = true;
      const sessionId = require('crypto').randomUUID();
      const session = { res, stopped: false, pendingMessages: [], tigerTeamId: id };
      global.__tigerTeamSessions ||= {};
      global.__tigerTeamSessions[sessionId] = session;
      ttRecovery.attachSession(state, session);
      let closed = false;
      let heartbeat;
      try {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('data: ' + JSON.stringify({ gateway: { type: 'tt_session', session_id: sessionId } }) + '\n\n');
        res.on('close', () => {
          if (closed || res.writableEnded || session.stopped) return;
          session.stopped = true;
          stopTigerTeam(id, 'disconnect');
        });
        heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n'); }, 15000);
        if (resume && !state.legacyRecovery) {
          await resumeTigerTeam(id, res, session);
        } else {
          if (resume) {
            res.write('data: ' + JSON.stringify({ gateway: { type: 'tt_notice', message: 'Legacy save: recovering from transcript only.  In-flight tool outcomes are unknown and must be verified before repeating actions.' } }) + '\n\n');
            message = 'Resume the interrupted investigation using the saved findings.  Do not repeat completed work.  This is a legacy transcript without a tool journal: verify uncertain actions using read-only checks before repeating anything that changes state.';
          }
          await continueTigerTeam(id, message, res);
        }
      } catch (e) {
        const current = getTigerTeamState(id);
        if (current) {
          current.executing = false; current.completedAt = Date.now();
          current.status = 'blocked'; current.error = e.message;
          try { ttStore.save(id, current); } catch (storageError) {
            console.error('[tiger-team] Terminal state could not be saved:', storageError.message);
            e = new Error(e.message + '.  STORAGE FAILURE: ' + storageError.message);
          }
        }
        if (!res.destroyed && !res.writableEnded) res.write('data: ' + JSON.stringify({ gateway: { type: 'tt_interrupted', message: e.message } }) + '\n\n');
      } finally {
        closed = true;
        state.apiReserved = false;
        const current = getTigerTeamState(id);
        if (current) current.apiReserved = false;
        clearInterval(heartbeat);
        delete global.__tigerTeamSessions[sessionId];
        if (!res.destroyed && !res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
      }
      return;
    }

    // Store TT launch params server-side (avoids URL length limits for large context)
    if (!global.__ttPendingLaunches) global.__ttPendingLaunches = {};
    if (pathname === '/api/tiger-team/stage' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const launchId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      global.__ttPendingLaunches[launchId] = body;
      // Auto-expire after 5 minutes
      setTimeout(() => { delete global.__ttPendingLaunches[launchId]; }, 5 * 60 * 1000);
      return jsonResponse(res, 200, { launchId });
    }
    if (pathname.startsWith('/api/tiger-team/staged/') && req.method === 'GET') {
      const launchId = pathname.split('/').pop();
      const params = global.__ttPendingLaunches[launchId];
      if (!params) return jsonResponse(res, 404, { error: 'Launch params expired or not found' });
      return jsonResponse(res, 200, params);
    }

    if (pathname === '/api/tiger-team/start' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const { coordinator, participants, objective, max_rounds, context, mode, challenger, challengerDirective, directives } = body;
      console.log(`[tiger-team-api] Received: mode=${mode || 'led'}, coordinator=${coordinator}, participants=${JSON.stringify(participants)}, challenger=${challenger || 'none'}, objective="${(objective||'').slice(0,80)}"`);
      if (!coordinator || !objective) {
        console.error('[tiger-team-api] Missing required fields');
        return jsonResponse(res, 400, { error: 'Missing coordinator or objective' });
      }
      // Allow empty participants array (coordinator solo mode)
      const effectiveParticipants = participants || [];

      // Session tracking for user injection/stop
      const sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      if (!global.__tigerTeamSessions) global.__tigerTeamSessions = {};

      // Set up SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const session = { res, stopped: false, pendingMessages: [], abortController: new AbortController() };
      global.__tigerTeamSessions[sessionId] = session;

      // Handle client disconnect.  Distinguishes an intentional /stop (which
      // sets session.stopped BEFORE closing the SSE response itself) from an
      // unannounced disconnect (page refresh / network blip): unannounced
      // disconnects get a short grace window before aborting, so a refresh
      // can reconnect (via Resume) without killing in-flight work instantly.
      // Only THIS session's own Tiger Team is targeted - never all running
      // teams - so concurrent investigations in other tabs are unaffected.
      res.on('close', () => {
        if (session.stopped || session.completed || res.writableEnded) {
          // Already an intentional stop (handled by /api/tiger-team/stop) -
          // that endpoint already aborted and checkpointed; nothing more to do.
          clearInterval(heartbeat);
          delete global.__tigerTeamSessions[sessionId];
          return;
        }
        const graceMs = 8000;
        setTimeout(() => {
          const stillTracked = global.__tigerTeamSessions[sessionId];
          if (!stillTracked || stillTracked.stopped) return; // stopped/finished normally during grace window
          console.log(`[tiger-team-api] Client disconnected (session ${sessionId}${session.tigerTeamId ? `, tt ${session.tigerTeamId}` : ''}), grace window expired - stopping this TT only`);
          session.stopped = true;
          stopTigerTeam(session.tigerTeamId || sessionId, 'disconnect');
          session.abortController?.abort();
          delete global.__tigerTeamSessions[sessionId];
        }, graceMs);
      });

      // Send session ID to client
      if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify({ gateway: { type: 'tt_session', session_id: sessionId } })}\n\n`);

      // Heartbeat to keep connection alive
      const heartbeat = setInterval(() => {
        try { if (!res.destroyed && !res.writableEnded) res.write(':\n\n'); } catch {}
      }, 15000);

      try {
        let result;
        if (mode === 'roundtable') {
          result = await runRoundtable(
            { objective, coordinator, participants: effectiveParticipants, max_rounds: max_rounds || 3, context: context || '', session },
            res
          );
        } else {
          result = await runTigerTeam(
            { objective, coordinator, participants: effectiveParticipants, max_rounds: max_rounds || 5, context: context || '', challenger: challenger || '', challengerDirective: challengerDirective || '', directives: directives || {}, session },
            res,
            'tiger-team-ui'
          );
        }
        // Mark completed IMMEDIATELY so the res.on('close') handler treats this as a normal finish
        const runState = session.tigerTeamId ? getTigerTeamState(session.tigerTeamId) : null;
        const runFailed = runState ? runState.status !== 'completed' : (typeof result === 'string' && /^(Error:|Tiger Team failed:)/.test(result));
        if (!runFailed) {
          session.completed = true;
        }
        // Stop may already have ended this stream.  Guard writes explicitly;
        // write-after-end emits an asynchronous error that try/catch cannot catch.
        // Surface validation errors that are returned as strings
        if (runFailed) {
          console.error('[tiger-team-api] Validation error:', result);
          try {
            if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify({ gateway: { type: 'tt_error', message: result } })}\n\n`);
          } catch {}
        }
      } catch (e) {
        console.error('[tiger-team-api] Error:', e.message);
        try {
          if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify({ gateway: { type: 'tt_error', message: e.message } })}\n\n`);
        } catch {}
      } finally {
        // Mark this session's own close-handler grace window as moot - the
        // run reached a real terminal state normally (completed or errored
        // above), so the delayed disconnect-abort must not fire for it.
        session.stopped = true;
        clearInterval(heartbeat);
        delete global.__tigerTeamSessions[sessionId];
        try {
          if (!res.destroyed && !res.writableEnded) res.write('data: [DONE]\n\n');
          if (!res.destroyed && !res.writableEnded) res.end();
        } catch {}
      }
      return;
    }

    // ── Image Routes ────────────────────────────────────────────────
    if (pathname.startsWith('/api/image/') && req.method === 'GET') {
      // serveImage takes the base64-encoded path (the rest of the URL), not the request: passing `req` here
      // made every embedded image a 500 since the first release, so no chat image ever rendered.
      let encoded = pathname.slice('/api/image/'.length);
      try { encoded = decodeURIComponent(encoded); } catch { /* keep as is */ }
      return serveImage(encoded, res);
    }

    // ── Setup status (the desktop page's provider notice) ──────────
    if (pathname === '/api/setup/status' && req.method === 'GET') {
      return jsonResponse(res, 200, { setupNeeded: isSetupNeeded() });
    }

    // ── Static Files ────────────────────────────────────────────────
    let filePath;
    if (pathname === '' || pathname === '/') {
      // First run: until the first admin account exists, the home page is the Welcome page (lib/welcome). Once it
      // exists, "/" is the hub; the page shows a notice linking to /welcome while no AI provider is configured.
      if (!hubAuth.hasUsers()) { res.writeHead(302, { Location: '/welcome' }); return res.end(); }
      // Setup started on the Welcome page and not finished (its tab was closed, or Claude's sign-in page replaced it):
      // the administrator goes back there, to the step they had reached. The installer's Desktop shortcut opens "/".
      if (access.isAdmin(req.hubUser) && !req.hubPendingTotp && require('./lib/welcome').getWelcome().unfinished()) {
        res.writeHead(302, { Location: '/welcome' }); return res.end();
      }
      filePath = path.join(__dirname, 'index.html');
    } else if (pathname === '/setup' || pathname === '/setup-admin') {
      // The old provider wizard and first-admin form are now steps of the Welcome page.
      const qs = new URL(req.url, `http://${URL_HOST}:${PORT}`).search;
      res.writeHead(302, { Location: '/welcome' + qs }); return res.end();
    } else if (pathname === '/welcome') {
      filePath = path.join(__dirname, 'welcome.html');
    } else if (pathname === '/help') {
      filePath = path.join(__dirname, 'help.html');
    } else if (pathname === '/login' || pathname === '/invite') {
      filePath = path.join(__dirname, 'login.html');
    } else if (pathname === '/users') {
      filePath = path.join(__dirname, 'users.html');
    } else if (pathname === '/modules') {
      filePath = path.join(__dirname, 'modules.html');
    } else if (pathname === '/local-models') {
      filePath = path.join(__dirname, 'local-models.html');
    } else if (pathname === '/mobile') {
      filePath = path.join(__dirname, 'mobile.html');
    } else if (pathname === '/slack-queue' || pathname === '/incidents') {
      // Removed — redirect to home
      res.writeHead(302, { Location: '/' });
      return res.end();
    } else if (pathname === '/tiger-team') {
      filePath = path.join(__dirname, 'tiger-team.html');
    } else {
      // Only the pages and assets the UI uses are web resources (lib/static-files: allow-list, real path inside the
      // install). Everything else under the install folder (.env, data/, workspaces/, lib/, the release tarball) is
      // not, whoever asks (review F01/V2).
      filePath = require('./lib/static-files').resolve(pathname);
      if (!filePath) return jsonResponse(res, 404, { error: 'Not found' });
    }

    // The app pages are useless without a session: send a signed-out browser to the login page.
    if (!req.hubUser && !req.hubService && ['index.html', 'mobile.html'].includes(path.basename(filePath))) {
      if (hubAuth.hasUsers() || process.env.HUB_REQUIRE_LOGIN === '1') { res.writeHead(302, { Location: `/login?next=${encodeURIComponent(req.url || '/')}` }); return res.end(); }
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.webmanifest': 'application/manifest+json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
      };
      const headers = { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' };
      if (ext === '.html') headers['Cache-Control'] = 'no-store, no-cache, must-revalidate';
      res.writeHead(200, headers);
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // 404
    jsonResponse(res, 404, { error: 'Not found' });

  } catch (err) {
    console.error(`[server] ${req.method} ${pathname}: ${err.message}`);
    if (!res.headersSent) {
      jsonResponse(res, 500, { error: err.message });
    }
  }
}

// ── Start ───────────────────────────────────────────────────────────────

// Leaked-key detector: if ETH leaves a trading wallet and the hub sent nothing, say so loudly.
setInterval(() => {
  try { const svc = require('./lib/wallet/service').getWalletService(); if (svc.keystore.list().length) svc.checkOutflows('base').catch(() => {}); }
  catch { /* wallet feature unused */ }
}, 60 * 1000).unref();

// First run (or a new default agent in this release): create missing workspaces from
// templates. Never overwrites - workspaces are user data and are not tracked in git.
try {
  const seeded = require('./lib/agents').seedDefaultWorkspaces();
  if (seeded.length) console.log(`[workspaces] Created from templates: ${seeded.join(', ')}`);
} catch (e) { console.warn('[workspaces] Template seeding failed:', e.message); }

// Shared secret for POST /api/chat/alert (data/alert-secret, mode 0600, created once).
try { ensureAlertSecret(); } catch (e) { console.warn('[alert] Could not create alert secret:', e.message); }
// data/ holds every secret the hub keeps; a fresh install creates it with the shell's umask (often 775). Private, always.
try { fs.chmodSync(path.join(__dirname, 'data'), 0o700); } catch {}

try { require('./lib/push').getPush().start(require('./lib/hub-events').events); } catch (e) { console.error('[push] not started:', e.message); }

server.listen(PORT, HOST, () => {
  console.log(`\n  My Maestro AI v${require('./package.json').version} (multi-provider)`);
  console.log(`  Server:   http://${URL_HOST}:${PORT}  (${BIND.exposed ? 'NETWORK-EXPOSED' : 'localhost only'})`);
  if (BIND.warning) console.warn(`  WARNING:  ${BIND.warning}`);
  console.log(`  Auth:     ${AUTH_USERNAME ? 'enabled' : 'disabled'}`);
  console.log(`  User:     ${process.env.USER_EMAIL || process.env.USER || '(not set)'}\n`);

  // First run: no account yet. The Welcome page needs the one-time setup code (lib/welcome), which the installer
  // also prints; `mymaestro setup-link` shows the link again. The log file is readable by this user only.
  if (!hubAuth.hasUsers()) {
    try {
      const code = require('./lib/welcome').getWelcome().ensureSetupToken();
      console.log(`  First-time setup: http://localhost:${PORT}/welcome?token=${code}\n`);
    } catch (e) { console.warn(`[welcome] could not create the setup code: ${e.message}`); }
  }

  // Local models: bring the proxy up when it is switched on (it runs detached, so it may already be up from before).
  try { const lm = localModels(); if (lm.state().enabled) lm.start().then(r => { if (!r.ok) console.warn('[local-models] proxy did not come up; see data/local-models/llama-swap.log'); }).catch(e => console.warn(`[local-models] ${e.message}`)); } catch (e) { console.warn(`[local-models] ${e.message}`); }

  // Security check: a nightly review of this installation's security configuration (Settings → Security check and
  // the admin banner read the result). HUB_SECURITY_CHECK_HOURS sets the interval; 0 turns the schedule off.
  try {
    securityCheck().schedule(process.env.HUB_SECURITY_CHECK_HOURS === undefined ? 24 : Number(process.env.HUB_SECURITY_CHECK_HOURS), {
      onResult: (r) => { try { require('./lib/hub-events').events.publish('security_check', { critical: r.critical, warnings: r.warnings, checkedAt: r.checkedAt }); } catch {} },
    });
  } catch (e) { console.warn(`[security] ${e.message}`); }

  // Detached jobs: reconcile jobs that ended while the hub was down, announce them, start polling.
  try { const jr = getJobRunner().start(); console.log(`[jobs] runner started (${jr.mode()}; ${jr.list(null).filter(j => j.status === 'running').length} running)`); }
  catch (e) { console.error('[jobs] runner failed to start:', e.message); }

  // Scheduled tasks: queue anything that came due while the hub was down (fires once, marked late), start polling.
  try { const st = getScheduledTasks().start(); st.prune(30); console.log(`[sched-tasks] started (${st.list(scheduledTasksLib.OWNER).filter(t => t.status === 'active').length} active, ${st.pending.length} due now)`); }
  catch (e) { console.error('[sched-tasks] failed to start:', e.message); }

  // Messaging channels (Telegram etc): opt out with HUB_COMMS_DISABLED=1.
  if (process.env.HUB_COMMS_DISABLED !== '1') {
    try { require('./lib/comms/service').getCommsService().attach({ wakeAgent, isAgentActive, getAgents }).start(); console.log('[comms] service started'); }
    catch (e) { console.error('[comms] service failed to start:', e.message); }
  }

  // Start the task scheduler after a brief delay to let MCP skills initialize
  setTimeout(() => {
    try {
      startScheduler();
    } catch (e) {
      console.error('[scheduler] Failed to start:', e.message);
    }
    try {
      startTaskQueue();
    } catch (e) {
      console.error('[task-queue] Failed to start:', e.message);
    }
    try {
      startDiscovery();
      // Subscription usage windows (5-hour, 7-day, per-model weekly) polled through the Claude client; drives the plan-limit fallback.
      try { require('./lib/plan-usage').getPlanUsage().start(); } catch (e) { console.error('[plan-usage] not started:', e.message); }
    } catch (e) {
      console.error('[model-discovery] Failed to start:', e.message);
    }
    serverReady = true;
    console.log('  Ready:    ✓ all systems initialized\n');
  }, 10000);
});
