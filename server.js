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

// A restore (or its undo) waiting for this start is carried out first: before .env is read and before anything opens a
// database (lib/backup/apply). If it can neither be finished nor rolled back, stop here rather than start on a
// half-swapped install; the next start tries again, and the set-aside copies are kept.
let restoredAtBoot = { state: 'none' };
try { restoredAtBoot = require('./lib/backup/apply').applyAtBoot({ root: __dirname, log: (m) => console.log(m) }); }
catch (e) { console.error(`[restore] the restore could not be finished or rolled back, so My Maestro AI stops here to keep your data safe: ${e.message}`); process.exit(1); }

// The hub is the one process that may run the real Claude client, its installer and its supervised worker (lib/claude-signin-guard).
require('./lib/claude-signin-guard').allowRealEffects();

// Load .env BEFORE any other requires — skill-manager reads env at import time
// Secret values (keys, tokens, passwords) go to a private in-memory store (lib/hub-secrets), not process.env, so no
// child process the hub starts carries them in its start environment.
const hubSecrets = require('./lib/hub-secrets');
try { hubSecrets.loadEnvFile(path.join(__dirname, '.env')); } catch {}

// Agents' boxes a backup paused and couldn't let go (the process stopped mid-copy): let them go now, after .env (it may say
// how to reach Docker). Their record sits in .restore/, which a restore never moves; it stays until each box is let go.
try {
  const pausedFile = path.join(__dirname, '.restore', 'backup-paused.json');
  if (fs.existsSync(pausedFile) && !require('./lib/backup/create').letGoRecorded(pausedFile)) console.error(`[backup] agent boxes a backup paused are still paused, or their record (${pausedFile}) can't be read; tried again at the next start`);
} catch (e) { console.error('[backup] could not let paused agent boxes go:', e.message); }

// A restored setup starts paused: agents start no new work and what was due or queued in the backup is held for Run or
// Skip (lib/backup/recovery). It runs until it has completed for this restore; if it can't, stop rather than run unpaused.
if (restoredAtBoot.state === 'applied') {
  try { require('./lib/backup/recovery').enterOnce(__dirname, restoredAtBoot.journal); }
  catch (e) { console.error(`[restore] could not pause agents after the restore, so My Maestro AI stops here: ${e.message}`); process.exit(1); }
}

const {
  getAgents, getAgentFiles, saveAgentFile, createAgent, cloneAgent, agentBusy,
  deleteAgent, renameAgent, getAvailableModels, setAgentModel, setAgentDisplay, setAgentIcon, EDITABLE_FILES,
} = require('./lib/agents');
const {
  handleChatStream, handleChat, handleAskResponse, handleInterjection, handleAlert, ensureAlertSecret, resolveToolConfirm, stopAgentTurn, haltHub, resumeHub, getAgentStatuses, getJobRunner, getScheduledTasks, getPacing, getApprovals, getLedger, getAllowances, getEffectivePolicy, getAgentRequests, getCompaction,
  cancelWorker, loadConversationLog, clearConversationLog,
  clearConversation, flushActiveResponses, runTigerTeam, runRoundtable,
  continueTigerTeam, resumeTigerTeam, getTigerTeamState, reconstituteTigerTeam, stopTigerTeam, listTigerTeams,
  activeTigerTeams, isAgentActive, wakeAgent, startBuildTeam, teamModelFacts, buildTeamRuns, startTeamSetup, teamSetupRuns,
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

let modelOfferGroups;
function groupedModelOffers() {
  return modelOfferGroups ||= require('./lib/model-offer-groups').createModelOfferGroups({
    setModel: (name, model, guard, token) => setAgentModel(name, model, guard, token, publishAgentUpdate),
  });
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
// A run writes to its own stream, not to the page that started it: pages attach, drop and replay (lib/tiger-team-live).
const ttLive = require('./lib/tiger-team-live');
const ttNewStream = () => new ttLive.TeamStream({ store: ttStore, getState: id => activeTigerTeams.get(id) || null });
/** The team a war-room request is about: its tiger_team_id, else the team of the session that started it (older pages). */
function ttTeamOf(body) {
  if (body && typeof body.tiger_team_id === 'string' && ttValidId(body.tiger_team_id)) return body.tiger_team_id;
  const s = body && global.__tigerTeamSessions && global.__tigerTeamSessions[body.session_id];
  return (s && s.tigerTeamId) || null;
}
// ── Setup Detection ──────────────────────────────────────────────────────
const ENV_FILE = path.join(__dirname, '.env');
// API keys live in one place, Settings (data/settings.json). Keys still typed into .env move there once, with a
// copy of the old .env kept beside it (lib/settings adoptEnvFileKeys; HUB_KEEP_ENV_KEYS=1 leaves them in .env).
try {
  const r = require('./lib/settings').adoptEnvFileKeys({ envFile: ENV_FILE });
  const names = [...r.moved, ...r.duplicates, ...r.unused];
  if (r.error) console.warn(`[settings] API keys in .env were not moved: ${r.error}`);
  else if (r.kept) console.log('[settings] HUB_KEEP_ENV_KEYS is set: API keys stay in .env');
  else if (names.length) console.log(`[settings] moved ${names.join(', ')} from .env into Settings (the old .env is kept as ${path.basename(r.backup)})`);
} catch (e) { console.warn('[settings] could not move API keys out of .env:', e.message); }
function isSetupNeeded() {
  // First-run setup (the Welcome page, lib/welcome) is needed until the hub has an admin account and at least one way
  // for agents to think: an API key, a Claude or ChatGPT sign-in or a local model. An .env file alone no longer counts.
  if (!hubAuth.hasUsers()) return true;
  return !require('./lib/welcome').getWelcome().hasProvider();
}

// ── Persistent Settings ──────────────────────────────────────────────────
const hubSettings = require('./lib/settings');
const hubAuth = require('./lib/auth').getAuth();          // accounts, sessions, TOTP, invites (lib/auth)
const admin2fa = require('./lib/admin-2fa').createAdmin2fa({   // "Require two-factor sign-in for admins" (lib/admin-2fa)
  getSetting: hubSettings.getSetting, updateSettings: hubSettings.updateSettings, auth: hubAuth,
  notify: (p) => require('./lib/push').getPush().notify(p, { adminsOnly: true, kind: 'security' }), log: (m) => console.log(m),   // a security notice (the person's Security and access setting)
});
// Five wrong second-factor codes lock that account's codes for a minute (lib/auth): one security notice to that person and every admin.
hubAuth.setTotpLockNotifier(({ user }) => {
  const ids = [...new Set([user.id, ...hubAuth.admins().map(a => a.id)].filter(Boolean).map(String))];
  console.log(`[auth] two-factor locked for a minute: ${user.login}`);
  Promise.resolve(require('./lib/push').getPush().notifyUsers({
    title: 'Two-factor sign-in locked for a minute',
    body: `5 wrong two-factor codes for ${user.name || user.login}. Codes are refused for a minute. If this wasn't ${user.name || user.login}, someone knows the password: change it.`,
    url: '/', tag: 'totp-lock',
  }, ids, { kind: 'security' })).catch(() => {});
});
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
  try { getCompaction().flush(); } catch {}   // context readings waiting to be written (lib/memory-health reads them)
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
const BIND = require('./lib/bind-host').resolveBindHost(hubSecrets.envView(), {
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
// Component watch (lib/component-watch): the software the hub relies on (the Codex client, the Claude client), what is
// installed and what is out; one instance, made with the hub's deps (is Codex in use; which Claude client a pending
// My Maestro update would bring) and started once after the server listens (GET /api/components, Settings → Status).
let _componentWatch = null;
function componentWatch() {
  if (!_componentWatch) {
    _componentWatch = require('./lib/component-watch').createComponentWatch({
      codexInUse: () => require('./lib/sdk-chat').codexInUse(),
      claudeOffered: () => require('./lib/claude-offered').claudeOffered({ root: __dirname, updateStatus: () => require('./lib/update-check').getUpdateCheck().status(null) }),
    });
  }
  return _componentWatch;
}
/** The step-up: this signed-in account's password (and two-factor code when the account has it) from a request body.
 *  Returns null when right, else the message to show. Used by the backup routes and the module permission routes. */
function accountStepUp(user, b, ip) {
  const u = user;
  b = b && typeof b === 'object' ? b : {};
  const r = hubAuth.login(u.login, String(b.password || ''), { ip });
  if (!r.ok) return r.locked ? r.error : 'That password is not right.';
  if (r.needsTotp) { const t = hubAuth.totpCheck(u.id, String(b.code || '').replace(/\s+/g, '')); if (!t || !t.ok) return (t && t.locked) ? t.error : 'That two-factor code is not right.'; }
  return null;
}
// Backups (lib/backup/service): one instance for the routes; download links last two minutes and work once.
let backupSvc = null;
const backupDownloads = new Map();
const rotationTickets = new Map();   // "it may have leaked", step two within 10 minutes of step one, by the same admin
function backupService() {
  if (backupSvc) return backupSvc;
  backupSvc = require('./lib/backup/service').createBackupService({
    root: __dirname, hubHome: require('./lib/hub-home').HUB_HOME,
    hubInfo: () => { try { return require('./lib/hub-map').getHubMap().versionInfo(); } catch { return {}; } },
    busyAgents: () => { try { return require('./lib/hub-events').events.activeAgents(); } catch { return []; } },
    restart: (reason) => require('./lib/restart').requestRestart({ projectDir: __dirname, reason, by: 'owner' }),
    scheduled: () => require('./lib/scheduled-tasks').getScheduledTasks(),
    consult: () => require('./lib/consult-queue').getConsultQueue(),
    hasAccounts: () => hubAuth.hasUsers(),
    log: (m) => console.log(m),
  });
  return backupSvc;
}
const MAX_BODY_SIZE = 50 * 1024 * 1024; // 50MB to accommodate large screenshot pastes
// Local models (lib/local-models): the hub's llama-swap proxy for every local engine.
const localModels = () => require('./lib/local-models').getLocalModels();
// The lead agent's per-turn brief about this hub (lib/hub-map): needs the port and the exposure decision.
require('./lib/hub-map').getHubMap().init({ port: PORT, host: HOST, exposed: () => !!BIND.exposed, setupNeeded: () => isSetupNeeded() });
require('./lib/hub-map').getHubMap().init({ components: () => componentWatch().items() });   // the brief reads this server's component watch

// Model health cache (populated by /api/models/health and /api/models/test)
const _modelHealthCache = {};
let _modelHealthLastRun = 0;

// Basic Auth (optional)
const AUTH_USERNAME = hubSecrets.get('HUB_AUTH_USERNAME') || '';
const AUTH_PASSWORD = hubSecrets.get('HUB_AUTH_PASSWORD') || '';
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

/** The agent a non-JSON request names: ?agent=<name> or the X-Agent header (audio upload to /api/voice/stt). */
function agentFromQuery(req) {
  try { return new URL(req.url, 'http://x').searchParams.get('agent') || String(req.headers['x-agent'] || '') || null; } catch { return null; }
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
const HUB_ONLY_CHAT_FIELDS = ['image_files', 'consulted_by', 'origin', 'owner_turn'];
const ADMIN_ONLY_CHAT_FIELDS = ['override', 'ephemeral', 'tiger_team', 'consultation_depth'];
function stripHubOnlyChatFields(body, req) {
  if (!body || typeof body !== 'object' || req.hubService) return body;
  for (const k of HUB_ONLY_CHAT_FIELDS) delete body[k];
  if (!access.isAdmin(req.hubUser)) for (const k of ADMIN_ONLY_CHAT_FIELDS) delete body[k];
  return body;
}

// Share links: the store and the routes are made once, on first use (the store loads data/share-links.json and prunes daily).
let _shareLinkRoutes = null;
function shareLinkRoutes() {
  if (!_shareLinkRoutes) {
    const SL = require('./lib/share-links');
    const store = SL.createStore({ file: path.join(__dirname, 'data', 'share-links.json'), log: (m) => console.warn(m) });
    store.startPruneTimer();
    _shareLinkRoutes = require('./lib/share-links-routes').createShareLinkRoutes({
      store, access, hubAuth, log: (m) => console.warn(m),
      getFiles: () => require('./lib/files').getFiles({ getUser: (id) => hubAuth.getUser(id), isAdminUser: (u) => access.isAdmin(u),
        maxUploadBytes: () => Math.max(1, Number(hubSettings.getSetting('filesMaxUploadMb')) || 512) * 1048576 }),
      getAgents: () => getAgents(),
      settings: () => hubSettings.getSetting('shareLinks'),
      push: () => require('./lib/push').getPush(),
    });
  }
  return _shareLinkRoutes;
}

// A share token must never reach a log line (also when URL-encoded inside next=).
const redactShareToken = (s) => String(s).replace(/\/s\/[A-Za-z0-9_-]{43}/g, '/s/<token>').replace(/%2[Ff]s%2[Ff][A-Za-z0-9_-]{43}/g, '%2Fs%2F<token>');

// A request can never take the process down: whatever throws before or outside the route try-block below (cookie
// or URL decoding, identity, the bridge) answers 400 and the hub carries on (review F07).
const server = http.createServer((req, res) => {
  handleHttpRequest(req, res).catch((err) => {
    console.error(`[server] ${req.method} ${redactShareToken(String(req.url || '')).slice(0, 200)}: ${redactShareToken(err && err.message ? err.message : err)}`);
    try {
      if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad_request' }));
    } catch { /* socket gone */ }
  });
});
// Open desktop (Remote computers): routes, session map and the websocket relay (lib/remote-desktop). Only while the module is on.
let _remoteDesktop = null;
function remoteDesktop() {
  if (!_remoteDesktop) {
    const modsOf = () => require('./lib/modules').getModules();
    const identifyReq = (req) => {
      // A request that went through the gate in handleHttpRequest already carries its identity; an upgrade does not, so it is worked out here.
      if (req.hubIdentKind !== undefined) return { user: req.hubUser, pendingTotp: req.hubPendingTotp, service: req.hubService, token: req.hubToken };
      const ident = hubAuth.identify(req, { legacyCheck: (r) => !!AUTH_USERNAME && !hubAuth.hasUsers() && checkAuth(r) });
      return {
        user: ident && (ident.kind === 'user' || ident.kind === 'legacy') ? ident.user : null,
        pendingTotp: !!(ident && ident.kind === 'user' && ident.pendingTotp),
        service: !!(ident && ident.kind === 'service'),
        token: ident && ident.kind === 'token' ? ident.token : null,
      };
    };
    _remoteDesktop = require('./lib/remote-desktop').createRemoteDesktop({
      callTool: (tool, args) => require('./lib/connectors').getConnectors().callTool('remote-computers', tool, args, { hub: true, timeoutMs: 30000 }),
      parse: (t) => require('./lib/modules').parseToolText(t),
      identify: identifyReq,
      isAdmin: (u) => access.isAdmin(u),
      isOwner: (u) => hubAuth.isOwner(u),
      // The current account record, not the one seen when the session opened: it still exists, is not disabled and is still an admin.
      // (The legacy single-password sign-in has no account record: it counts while the hub has no accounts.)
      stillAdmin: (userId) => {
        if (String(userId) === 'legacy') return !hubAuth.hasUsers();
        const u = hubAuth.getUser(String(userId));
        return !!u && !u.disabled && access.isAdmin(u);
      },
      tailnetOk: (req) => isTailnetUserAllowed(req, PORT),
      enabled: () => { try { return !!modsOf().detail('remote-computers').enabled; } catch { return false; } },
      settings: () => { try { return modsOf().detail('remote-computers').settings || {}; } catch { return {}; } },
      readPage: () => fs.readFileSync(path.join(__dirname, 'remote-desktop.html'), 'utf8'),
      log: (line) => console.log(line),
      audit: (rec) => {
        try {
          const dir = path.join(__dirname, 'data', 'modules', 'remote-computers');
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          fs.appendFileSync(path.join(dir, 'audit.jsonl'), JSON.stringify(rec) + '\n', { mode: 0o600 });
        } catch (e) { console.error('[remote-desktop] audit:', e.message); }
      },
    });
  }
  return _remoteDesktop;
}
/** Ends desktop sessions that must no longer run, right after a change to the module (only when the desktop instance exists). Never throws. */
function sweepRemoteDesktop(moduleId) {
  if (moduleId !== 'remote-computers' || !_remoteDesktop) return;
  try { _remoteDesktop.sweep().catch(() => {}); } catch { /* the 15 s sweep follows */ }
}
// Websocket upgrades: only the desktop relay is answered; every other path keeps today's behaviour (the socket is closed).
server.on('upgrade', (req, socket, head) => {
  let handled = false;
  try { handled = remoteDesktop().upgrade(req, socket, head); } catch (e) { console.error('[remote-desktop] upgrade:', e && e.message ? e.message : e); }
  if (!handled) { try { socket.destroy(); } catch { /* gone */ } }
});
// Public receivers (/hooks/<id>/<sub>): lib/modules/receivers checks every request itself, so they are answered before the tailnet gate.
let _receivers = null;
function receivers() {
  if (!_receivers) {
    const cxOf = () => require('./lib/connectors').getConnectors();
    _receivers = require('./lib/modules/receivers').createReceivers({
      manifestOf: (id) => require('./lib/modules').getModules().manifestOf(id),
      connectorFor: (id) => cxOf().list().connectors.find(c => c.id === id) || null,
      request: (...a) => cxOf().request(...a),
      getSetting: hubSettings.getSetting,
      log: (m) => console.log(m),
    });
  }
  return _receivers;
}
// Passkey (Face ID / fingerprint) unlock of the wallet keystore (lib/wallet/passkey-routes).
let _pkRoutes = null;
const passkeyRoutes = () => _pkRoutes || (_pkRoutes = require('./lib/wallet/passkey-routes').createPasskeyRoutes({ svc: require('./lib/wallet/service').getWalletService(), getSetting: (k) => hubSettings.getSetting(k), notify: (p) => require('./lib/push').getPush().notifyEach(p, { adminsOnly: true, urgency: 'high', kind: 'security' }) }));   // passkey added/removed: a security notice
// Notices from data connectors to their notice agent (lib/modules/notices); registered with the connectors at start-up.
let _notices = null;
function notices() {
  if (!_notices) {
    const mods = require('./lib/modules').getModules();
    _notices = require('./lib/modules/notices').createNotices({
      connectorFor: (id) => require('./lib/connectors').getConnectors().list().connectors.find(c => c.id === id) || null,
      manifestOf: (id) => mods.manifestOf(id),
      noticeAgentOf: (id) => mods.noticeAgentOf(id),
      mediaDirFor: (id) => mods.mediaDirFor(id),
      isAgentActive, interject: handleInterjection, wake: wakeAgent,
      auditDir: path.join(__dirname, 'data', 'modules'),
      log: (m) => console.log(m),
    });
  }
  return _notices;
}
try { require('./lib/connectors').getConnectors().setNotifyHandler((id, params) => notices().deliver(id, params)); }
catch (e) { console.error('[modules] notify handler:', e.message); }
async function handleHttpRequest(req, res) {
  const hookHit = receivers().match(String(req.url || '').split('?')[0]);
  if (hookHit) return receivers().handle(req, res, hookHit);
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
  req.hubIdentKind = ident ? ident.kind : null;
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
    if (route.from === 'query') agentName = agentFromQuery(req);
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
        if (route.from === 'query') agentName = agentFromQuery(req);
        const allowed = agentName && access.canAccessAgent(req.hubUser, agentName, { agents: await getAgents(), resolveVirtual: (n) => temporalWorkersLib.getVirtual(n) });
        if (!allowed) return jsonResponse(res, 403, { error: 'no_access_to_agent' });
      }
    }
  }

  try {
    // ── Share links (lib/share-links, lib/share-links-routes): /api/share-links*, /s/<token>. A person on a browser session only. ──
    if (pathname.startsWith('/api/share-links') || pathname.startsWith('/s/')) {
      if (await shareLinkRoutes().handle(req, res, pathname)) return;
    }
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
    // null when the account changed between the password check and the session (deleted, turned off, or a new password set from the
    // terminal): no cookie, and the caller answers that sign-in failed.
    const finishSignIn = (user, { totpOk }) => {
      let sess;
      try { sess = hubAuth.createSession(user, { req, totpOk }); }
      catch (e) { if (e && e.message === 'the account changed; sign in again') return null; throw e; }
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
      if (!finishSignIn(hubAuth.getUser(r.user.id), { totpOk: true })) return jsonResponse(res, 409, { ok: false, error: 'The account changed a moment ago; sign in again.' });
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
        out.interview = lead ? welcome.interviewStatus(lead.name) : 'unknown';   // 'complete' | 'in-progress' | 'unknown'
      }
      return jsonResponse(res, 200, out);
    }
    if (pathname === '/api/welcome/finish' && req.method === 'POST') {
      // Setup done (Maestro answered) or skipped: "/" stops sending this admin back to the Welcome page.
      const b = (await authJson()) || {};
      require('./lib/welcome').getWelcome().markFinished(b.how === 'skip' ? 'skip' : 'done');
      return jsonResponse(res, 200, { ok: true });
    }
    // The starter team (lib/welcome-team): admin only. lib/access classifies these as admin because they are not in PUBLIC_EXACT.
    if (pathname === '/api/welcome/team' && req.method === 'GET') {
      const out = await require('./lib/welcome-team').plan({ lead: new URL(req.url, 'http://x').searchParams.get('lead') || '' });
      return jsonResponse(res, out.status, out.body);
    }
    if (pathname === '/api/welcome/team' && req.method === 'POST') {
      const b = (await authJson()) || {};
      const out = await require('./lib/welcome-team').create(b);
      return jsonResponse(res, out.status, out.body);
    }
    if (pathname === '/api/welcome/team/plan' && req.method === 'POST') {
      const b = (await authJson()) || {};
      const out = await require('./lib/welcome-team').plan({ lead: typeof b.lead === 'string' ? b.lead : '', models: b.models });
      return jsonResponse(res, out.status, out.body);
    }
    if (pathname === '/api/welcome/team/skip' && req.method === 'POST') {
      const out = await require('./lib/welcome-team').skip();
      return jsonResponse(res, out.status, out.body);
    }
    // The "Set up your team" card for existing installs (lib/team-card): admin only (lib/access: not in PUBLIC_EXACT).
    if (pathname === '/api/team/card' && req.method === 'GET') {
      const out = await require('./lib/team-card').cardState({ again: new URL(req.url, 'http://x').searchParams.get('again') === '1' });
      return jsonResponse(res, out.status, out.body);
    }
    // Behaviour changes waiting for the owner (lib/behaviour-changes): admin only (lib/access: not in PUBLIC_EXACT, not a session route).
    if (pathname === '/api/behaviour-changes' && req.method === 'GET') {
      const bc = require('./lib/behaviour-changes');
      const changes = bc.list();
      let cadence = 'weekly'; try { cadence = require('./lib/settings').getSetting('workerProposals', 'weekly') === 'off' ? 'off' : 'weekly'; } catch { /* default */ }
      return jsonResponse(res, 200, { ok: true, changes, workerProposals: cadence, ...(changes.some((c) => c.unreadable) ? { unreadable: true } : {}) });
    }
    // How often the lead looks at how the install is used (worker-proposals): saves the setting, then makes the weekly task match.
    if (pathname === '/api/behaviour-changes/worker-proposals/cadence' && req.method === 'POST') {
      // Only the owner decides: a signed-in admin's own browser session (never the hub's service identity, a token or an agent).
      if (!require('./lib/access').isAdminSession(req)) return jsonResponse(res, 403, { ok: false, error: 'Sign in with an admin account in your browser to decide this.' });
      const b = (await authJson()) || {};
      if (b.cadence !== 'weekly' && b.cadence !== 'off') return jsonResponse(res, 400, { ok: false, error: 'cadence must be "weekly" or "off"' });
      try {
        require('./lib/settings').updateSettings({ workerProposals: b.cadence });
        const r = await require('./lib/behaviour-review').syncProposalsTask();
        console.log(`[behaviour] worker proposals set to ${b.cadence} by ${(req.hubUser && req.hubUser.id) || 'unknown'} (${r.action})`);
        return jsonResponse(res, 200, { ok: true, cadence: b.cadence });
      } catch (e) { return jsonResponse(res, 409, { ok: false, error: e && e.message ? e.message : String(e) }); }
    }
    {
      const m = pathname.match(/^\/api\/behaviour-changes\/([a-z][a-z0-9-]{1,40})$/);
      if (m && req.method === 'POST') {
        // Only the owner decides: a signed-in admin's own browser session (never the hub's service identity, a token or an agent).
        if (!require('./lib/access').isAdminSession(req)) return jsonResponse(res, 403, { ok: false, error: 'Sign in with an admin account in your browser to decide this.' });
        const b = (await authJson()) || {};
        if (b.decision !== 'on' && b.decision !== 'off') return jsonResponse(res, 400, { ok: false, error: 'decision must be "on" or "off"' });
        const bc = require('./lib/behaviour-changes');
        if (!bc.manifest().some((e) => e.id === m[1])) return jsonResponse(res, 404, { ok: false, error: 'no such change' });
        try {
          await bc.decide(m[1], b.decision, { user: req.hubUser && req.hubUser.id });
          console.log(`[behaviour] ${m[1]} turned ${b.decision} by ${(req.hubUser && req.hubUser.id) || 'unknown'}`);
          if (m[1] === 'worker-proposals') {
            try { await require('./lib/behaviour-review').syncProposalsTask(); } catch (e) { console.warn('[behaviour] could not update the weekly team review:', e.message); }
          }
          return jsonResponse(res, 200, { ok: true, change: bc.list().find((c) => c.id === m[1]) });
        } catch (e) { return jsonResponse(res, 409, { ok: false, error: e && e.message ? e.message : String(e) }); }
      }
    }
    if (pathname === '/api/team/card/answer' && req.method === 'POST') {
      const b = (await authJson()) || {};
      const out = await require('./lib/team-card').answerCard({ answer: b.answer });
      return jsonResponse(res, out.status, out.body);
    }
    if (pathname === '/api/welcome/api-key' && req.method === 'POST') {
      const b = (await authJson()) || {};
      return jsonResponse(res, 200, await require('./lib/welcome').getWelcome().connectApiKey(b.provider, b.apiKey));
    }
    if (pathname === '/api/welcome/claude-check' && req.method === 'POST') {
      return jsonResponse(res, 200, await require('./lib/welcome').getWelcome().checkClaude());
    }
    if (pathname === '/api/welcome/chatgpt-check' && req.method === 'POST') {
      return jsonResponse(res, 200, await require('./lib/welcome').getWelcome().checkChatGPT());
    }
    if (pathname === '/api/welcome/chatgpt-status' && req.method === 'GET') {
      return jsonResponse(res, 200, await require('./lib/welcome').getWelcome().chatgptStatus());
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
      if (!finishSignIn(r.user, { totpOk: !r.needsTotp || trusted })) return jsonResponse(res, 401, { ok: false, error: 'Wrong login or password' });
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
      if (!r.ok && r.locked) return jsonResponse(res, 429, { ok: false, locked: true, error: r.error });
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
      if (r.user.role === 'member') require('./lib/teams').createDefaultAssistant(r.user).then(a => { if (!a || !a.ok) console.error('[users] default assistant not made:', a && a.error); }, e => console.error('[users] default assistant:', e.message));
      if (!finishSignIn(r.user, { totpOk: true })) return jsonResponse(res, 409, { ok: false, error: 'The account changed a moment ago; sign in again.' });
      return jsonResponse(res, 200, { ok: true, user: hubAuth.publicUser(r.user), needsTotpEnrol: r.user.role === 'admin' && admin2fa.required() });
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
      if (!u) return jsonResponse(res, 401, { error: 'password check failed' });
      const adminAccount = access.isAdmin(u);   // the account as stored now, read after the body arrived
      if (adminAccount && admin2fa.required()) return jsonResponse(res, 403, { error: require('./lib/admin-2fa').REQUIRED_MESSAGE, code: 'admin_2fa_required' });
      if (!hubAuth.login(u.login, b.password).ok) return jsonResponse(res, 401, { error: 'password check failed' });
      if (adminAccount && u.totp && u.totp.enabled) { const t = hubAuth.totpCheck(u.id, String(b.code || '').replace(/\s+/g, '')); if (!t || !t.ok) return jsonResponse(res, (t && t.locked) ? 429 : 403, { error: (t && t.locked) ? t.error : 'That two-factor code is not right.' }); }
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
      if (req.hubUser) out.admin2faRequired = admin2fa.required();
      out.isOwner = !!(req.hubUser && !req.hubService && !req.hubPendingTotp && hubAuth.isOwner(req.hubUser));
      if (isAdmin) { const oe = access.ownerEntries(await getAgents(), hubAuth.listUsers()); out.owners = oe.owners; out.infraCount = oe.infraCount; }
      out.timeZone = u ? require('./lib/timezone').zoneForUser(u.id) : require('./lib/timezone').hubZone();   // what this person's agents use
      // This person's look (Simple mode): the saved choice, else by role (a member starts in Simple, an admin in Advanced).
      out.uiMode = (u && u.uiMode) || (isAdmin ? 'advanced' : 'simple');
      out.theme = (u && u.theme) || 'auto';
      { const rec = req.hubUser ? hubAuth.getUser(req.hubUser.id) : null; if (rec && rec.look) out.look = rec.look; if (rec && rec.planBadge) out.planBadge = rec.planBadge; }   // this person's default look (the pages call HubLooks.rememberDefault); absent for accounts made before looks existed
      return jsonResponse(res, 200, out);
    }
    // This person's page mode and theme: { uiMode?: 'simple'|'advanced', theme?: 'light'|'dark'|'auto' }. A signed-in
    // person only (the hub's own calls and API tokens have no person); bad values get a plain 400.
    if (pathname === '/api/me/prefs' && req.method === 'POST') {
      if (!req.hubUser || req.hubService || req.hubToken || req.hubPendingTotp) return jsonResponse(res, 401, { error: 'Sign in first' });
      let body = {};
      try { body = JSON.parse(await readBody(req) || '{}') || {}; } catch { return jsonResponse(res, 400, { error: 'Bad request' }); }
      const r = hubAuth.setPrefs(req.hubUser.id, { uiMode: body.uiMode, theme: body.theme, planBadge: body.planBadge });
      if (!r.ok) return jsonResponse(res, 400, { error: r.error });
      return jsonResponse(res, 200, { ok: true, uiMode: r.user.uiMode || (access.isAdmin(req.hubUser) ? 'advanced' : 'simple'), theme: r.user.theme || 'auto', planBadge: (hubAuth.getUser(req.hubUser.id) || {}).planBadge || null });
    }
    // This person's deep research choice (lib/research-prefs): ask | always | never, theirs only. on: the behaviour change
    // 'deep-research' is on. A signed-in person's own session ('owner' on an install with no accounts); never a token or the hub.
    if (pathname === '/api/research-pref' && (req.method === 'GET' || req.method === 'POST')) {
      if (req.hubService || req.hubToken || req.hubPendingTotp) return jsonResponse(res, 401, { error: 'Sign in first' });
      const key = hubAuth.hasUsers()
        ? (req.hubUser && req.hubIdentKind === 'user' && req.hubUser.id != null ? String(req.hubUser.id).slice(0, 64) : null)
        : 'owner';
      if (!key) return jsonResponse(res, 401, { error: 'Sign in first' });
      const prefs = require('./lib/research-prefs').getResearchPrefs();
      let on = false;
      try { on = require('./lib/behaviour-changes').isOn('deep-research'); } catch { on = false; }
      if (req.method === 'GET') return jsonResponse(res, 200, { on, choice: prefs.choiceOf(key), alwaysLevel: prefs.alwaysLevelOf(key) });
      if (!on) return jsonResponse(res, 403, { error: 'Deep research is off on this Maestro.' });
      let body = {};
      try { body = JSON.parse(await readBody(req) || '{}') || {}; } catch { return jsonResponse(res, 400, { error: 'Bad request' }); }
      // each part is checked before anything is saved; choice and alwaysLevel may come together
      const hasChoice = body && body.choice !== undefined, hasLevel = body && body.alwaysLevel !== undefined;
      if (!hasChoice && !hasLevel) return jsonResponse(res, 400, { error: 'choice or alwaysLevel is required' });
      const prefsMod = require('./lib/research-prefs');
      if (hasChoice && !prefsMod.CHOICES.includes(body.choice)) return jsonResponse(res, 400, { error: `choice must be one of: ${prefsMod.CHOICES.join(', ')}` });
      if (hasLevel && !prefsMod.LEVELS.includes(body.alwaysLevel)) return jsonResponse(res, 400, { error: `alwaysLevel must be one of: ${prefsMod.LEVELS.join(', ')}` });
      try {
        // both together: one write, so a failure saves neither
        if (hasChoice && hasLevel) prefs.setChoiceAndLevel(key, body.choice, body.alwaysLevel);
        else if (hasChoice) prefs.setChoice(key, body.choice);
        else prefs.setAlwaysLevel(key, body.alwaysLevel);
        return jsonResponse(res, 200, { ok: true, choice: prefs.choiceOf(key), alwaysLevel: prefs.alwaysLevelOf(key) });
      }
      catch (e) { return jsonResponse(res, e && e.code === 'bad_request' ? 400 : 500, { error: e && e.code === 'bad_request' ? e.message : 'Could not save that' }); }
    }
    // This person's time zone (lib/timezone): the page in use reports its own ({tz, auto: true}; the zone follows the
    // device unless pinned); the Profile pins one ({tz, pinned: true}) or follows the device again ({tz, pinned: false}).
    if (pathname === '/api/me/timezone' && req.method === 'POST') {
      if (!req.hubUser) return jsonResponse(res, 401, { error: 'Sign in first' });
      let body = {};
      try { body = JSON.parse(await readBody(req) || '{}') || {}; } catch { return jsonResponse(res, 400, { error: 'Bad request' }); }
      const tz = typeof body.tz === 'string' && body.tz.trim() ? body.tz.trim() : null;
      const r = hubAuth.setTimeZone(req.hubUser.id, tz, { auto: body.auto === true, pinned: body.pinned === true });
      if (!r.ok) return jsonResponse(res, 400, { error: r.error });
      return jsonResponse(res, 200, { ok: true, changed: r.changed, user: r.user, timeZone: require('./lib/timezone').zoneForUser(req.hubUser.id) });
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
      if (r.ok && r.user.role === 'member') require('./lib/teams').createDefaultAssistant(hubAuth.getUser(r.user.id)).then(a => { if (!a || !a.ok) console.error('[users] default assistant not made:', a && a.error); }, e => console.error('[users] default assistant:', e.message));
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
    // Worker history (lib/transcript workers / workerRun): the workers an agent called, read back from its archive.
    // One agent's (/api/agents/<name>/workers[/<id>]: the access check is the route's) or every agent this person
    // may open (/api/workers), newest first, 50 at a time.
    {
      const wm = pathname.match(/^\/api\/agents\/([^/]+)\/workers(?:\/([^/]+))?$/);
      if ((wm || pathname === '/api/workers') && req.method === 'GET') {
        const q = new URL(req.url, 'http://x').searchParams;
        const tr = require('./lib/transcript').getTranscript();
        const opts = { before: q.get('before') || null, q: q.get('q') || '', filter: q.get('filter') || 'all', limit: Number(q.get('limit')) || 50 };
        if (wm && wm[2]) {
          const run = tr.workerRun(decodeURIComponent(wm[1]), decodeURIComponent(wm[2]));
          return run ? jsonResponse(res, 200, { ok: true, ...run }) : jsonResponse(res, 404, { error: 'no such worker in that agent\'s history' });
        }
        let names;
        if (wm) names = [decodeURIComponent(wm[1])];
        else {
          const who = req.hubUser || { id: 'service', role: 'admin' };
          const all = await getAgents();
          names = all.filter(a => access.isAdmin(who) || access.canAccessAgent(who, a.name, { agents: all })).map(a => a.name);
        }
        const lists = names.map(n => tr.workers(n, opts)).filter(Boolean);
        const { workers: page, next } = require('./lib/transcript').mergeWorkerPages(lists, opts.limit);
        return jsonResponse(res, 200, { ok: true, workers: page, next });
      }
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
        let turn = require('./lib/hub-events').events.turnFor(agentName);
        if (!access.isAdmin(who)) {
          const ctx = { agents: await getAgents(), resolveVirtual: (n) => temporalWorkersLib.getVirtual(n) };
          turn = access.redactTurnForViewer(turn, (n) => access.canAccessAgent(who, n, ctx));
        }
        return jsonResponse(res, 200, { ok: true, agent: agentName, active: !!(turn && turn.active), turn });
      }
    }
    // Notification settings per person and agent, and the presence pings that decide "only when I'm away" (lib/notify-prefs-routes).
    // The person is always the signed-in user ('*' on a hub without accounts), never a parameter.
    if (pathname === '/api/notify/prefs' || pathname === '/api/notify/presence') {
      const body = req.method === 'GET' ? {} : await authJson();   // a beacon's Blob body arrives as plain text: JSON either way
      const accounts = hubAuth.hasUsers();
      const who = req.hubUser || null;
      // A hub without accounts (also its single-password sign-in, whose session user is 'legacy') has one person, '*':
      // lib/push maps devices without an account to '*', so the settings must be kept there too.
      const all = (req.method === 'PUT' && (who || !accounts)) ? await getAgents() : [];
      const out = require('./lib/notify-prefs-routes').handle({
        method: req.method, pathname, body, service: req.hubService, token: req.hubToken,
        userId: !accounts ? '*' : (who ? String(who.id) : null),
        prefs: require('./lib/notify-prefs').getNotifyPrefs(),
        beforeSecurityOff: (uid) => { require('./lib/push').getPush().notifyUsers({ title: 'Security and access notifications turned off', body: 'Changed from a signed-in page. Turn them back on in Notification settings.', url: '/mobile', tag: 'security-off' }, [uid], { kind: 'security', ignorePrefs: true }).catch(() => {}); },   // one last notice to the person's own devices, sent before the setting is saved
        agentExists: (n) => all.some(a => a.name === n),
        agentVisible: (n) => !who || access.isAdmin(who) || access.canAccessAgent(who, n, { agents: all, resolveVirtual: (v) => temporalWorkersLib.getVirtual(v) }),
      });
      return jsonResponse(res, out.status, out.json);
    }
    // "Notify me when done": the 🔔 next to Stop while a reply runs. One push to this person's devices when that turn
    // ends (lib/push); every page of theirs shows the bell's state (turn_notify). A person on a page, not a program.
    {
      const nm = pathname.match(/^\/api\/agents\/([^/]+)\/notify$/);
      if (nm && req.method === 'POST') {
        const agentName = decodeURIComponent(nm[1]);
        if (req.hubToken || req.hubService) return jsonResponse(res, 403, { error: 'session_only', detail: 'turned on by a person from a page' });
        const who = req.hubUser || null;
        if (who && !access.isAdmin(who) && !access.canAccessAgent(who, agentName, { agents: await getAgents(), resolveVirtual: (n) => temporalWorkersLib.getVirtual(n) })) return jsonResponse(res, 403, { error: 'no_access_to_agent' });
        const b = await authJson(); if (!b) return jsonResponse(res, 400, { error: 'invalid JSON' });
        const user = who ? { id: who.id, role: who.role } : { id: '*', role: 'admin' };   // a hub without accounts
        const r = require('./lib/hub-events').events.setTurnNotify(agentName, { on: b.on !== false, user, turnId: typeof b.turnId === 'string' ? b.turnId : null });
        if (!r) return jsonResponse(res, 409, { error: 'not_running', detail: `${agentName} is not working on a reply right now` });
        let devices = 0;
        try { devices = require('./lib/push').getPush().devicesFor(user); } catch {}
        // The person's effective "Requests you made" mode for this agent, from the server's own settings (a page's cached copy may be stale).
        let requested;
        try { requested = require('./lib/notify-prefs').getNotifyPrefs().mode(!hubAuth.hasUsers() ? '*' : (who ? String(who.id) : null), agentName, 'requested'); } catch { requested = undefined; }
        return jsonResponse(res, 200, { ok: true, agent: agentName, turnId: r.turnId, on: r.on, devices, ...(requested ? { requested } : {}) });
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
      const filesLib = require('./lib/files');
      const files = filesLib.getFiles({ getUser: (id) => hubAuth.getUser(id), isAdminUser: (u) => access.isAdmin(u),
        maxUploadBytes: () => Math.max(1, Number(hubSettings.getSetting('filesMaxUploadMb')) || 512) * 1048576, dataDir: path.join(__dirname, 'data') });
      const q = new URL(req.url, 'http://x').searchParams;
      let jsonBody = null;
      if (req.method === 'POST' && pathname !== '/api/files/upload') { jsonBody = await authJson(); if (!jsonBody) return jsonResponse(res, 400, { error: 'invalid JSON' }); }
      const want = (k) => (jsonBody && jsonBody[k] !== undefined) ? jsonBody[k] : q.get(k);
      const who = req.hubUser || { id: 'service', role: 'admin' };
      // Per agent when the page names an agent (the person must be allowed that agent); otherwise the owner's general folder.
      // scopeFor(agentName, ownerReq, agents?) -> { own } | { code, error }: the one owner/agent rule, run once per request here
      // and per item in /resolve.
      const scopeFor = async (agentName, ownerReq, agentsList) => {
        if (agentName) {
          const agents = agentsList || await getAgents();
          const rec = agents.find(a => a.name === String(agentName));
          if (!rec) return { code: 404, error: 'no such agent' };
          if (!access.isAdmin(who) && !access.canAccessAgent(who, rec.name, { agents })) return { code: 403, error: 'no_access_to_agent' };
          const memberOwned = !!(rec.owner && !hubAuth.listUsers().some(u => u.id === String(rec.owner) && u.role === 'admin'));
          return { own: files.resolveAgent(who, rec, { memberOwned }) };
        }
        const own = files.resolveOwner(who, ownerReq);
        return own ? { own } : { code: 403, error: 'no such owner' };
      };
      // POST /api/files/resolve { items }: Files-folder paths an agent wrote (abs, spaces allowed), download links ({agent|owner, path}) or a bare
      // file name an agent mentioned ({name, agent}: searched only in that agent's own folder, answered only when exactly one file has it) -> file facts + download URLs.
      // Anything outside the folders this person may read answers { ok:false, error:'not found' }, same as a missing file.
      if (pathname === '/api/files/resolve' && req.method === 'POST') {
        const items = jsonBody && jsonBody.items;
        if (!Array.isArray(items) || items.length > 12) return jsonResponse(res, 400, { error: 'items must be a list of at most 12' });
        const nf = { ok: false, error: 'not found' };
        const agents = await getAgents();
        let roots = null;   // the roots this person may read, agent roots first, then their folders: built once, only for { abs } items
        const rootsFor = async () => {
          if (roots) return roots;
          roots = [];
          for (const a of agents) {
            const s = await scopeFor(a.name, null, agents);
            if (s.own) roots.push({ root: s.own.root, agent: s.own.agent, owner: null });
          }
          const owners = access.isAdmin(who) ? ['mine', ...hubAuth.listUsers().map(u => u.id)] : [null];
          for (const o of owners) { const s = await scopeFor(null, o, agents); if (s.own) roots.push({ root: s.own.root, agent: null, owner: s.own.ownerId }); }
          return roots;
        };
        const out = [];
        const nameIdx = new Map();   // folder -> files.nameIndex(), for { name, agent } items
        for (const it of items) {
          if (!it || typeof it !== 'object' || Array.isArray(it)) { out.push(nf); continue; }
          let r = null;
          try {
            if (typeof it.abs === 'string') {
              for (const c of await rootsFor()) {
                const hit = files.resolveAbs(c.root, it.abs);
                const info = hit && files.fileInfo(c.root, hit.rel, c);
                if (info) { r = info; break; }
              }
            } else if (typeof it.path === 'string') {
              const s = await scopeFor(it.agent ? String(it.agent) : null, it.owner, agents);
              if (s.own) r = files.fileInfo(s.own.root, it.path, { agent: s.own.agent || null, owner: s.own.ownerId });
            } else if (typeof it.name === 'string' && typeof it.agent === 'string') {
              // A bare file name: only in that agent's own folder (scopeFor refuses an agent this person may not open), and only when
              // exactly one file there has the name.
              const s = await scopeFor(it.agent, null, agents);
              if (s.own) {
                const rootKey = String(s.own.root);
                if (!nameIdx.has(rootKey)) nameIdx.set(rootKey, files.nameIndex(s.own.root));   // one walk per folder per request
                const rel = files.findByName(s.own.root, it.name, { index: nameIdx.get(rootKey) });
                r = rel ? files.fileInfo(s.own.root, rel, { agent: s.own.agent || null, owner: s.own.ownerId }) : null;
              }
            }
          } catch { r = null; }
          out.push(r || nf);
        }
        return jsonResponse(res, 200, { ok: true, items: out });
      }
      const sc = await scopeFor(want('agent'), want('owner'));
      if (!sc.own) return jsonResponse(res, sc.code, { error: sc.error });
      const own = sc.own;
      const rel = String(want('path') || '');
      const fail = (r) => jsonResponse(res, r.code || 400, { error: r.error });
      // GET /api/files/recent: the newest files agents wrote under this folder (uploads left out).
      if (pathname === '/api/files/recent' && req.method === 'GET') {
        const r = files.recent(own.root, { limit: q.get('limit') });
        const where = { agent: own.agent || null, owner: own.agent ? null : own.ownerId };
        return jsonResponse(res, 200, { ok: true, truncated: r.truncated, files: r.files.map(f => ({ ...f,
          download: filesLib.downloadUrl({ ...where, path: f.path }),
          inline: filesLib.isActiveName(f.name) ? null : filesLib.downloadUrl({ ...where, path: f.path }, { inline: true }) })) });
      }
      // GET /api/files/zip: a folder as one .zip (check=1: only the access checks and the size scan, answered as JSON).
      if (pathname === '/api/files/zip' && req.method === 'GET') {
        const lim = filesLib.zipLimits(hubSettings.getSetting('filesZipMaxMb'), hubSettings.getSetting('filesZipMaxFiles'));
        const plan = files.zipPlan(own.root, rel, lim);
        if (!plan.ok) return fail(plan);
        if (plan.tooBig) return jsonResponse(res, 413, { error: plan.error, files: plan.count, bytes: plan.bytes, maxFiles: plan.maxFiles, maxBytes: plan.maxBytes });
        if (q.get('check') === '1') return jsonResponse(res, 200, { ok: true, files: plan.count, bytes: plan.bytes, maxFiles: plan.maxFiles, maxBytes: plan.maxBytes });
        console.log(`[files] ${who.id} zipped ${rel || '(root)'} (${plan.count} files) from ${own.agent || (own.ownerId === 'mine' ? 'share' : own.ownerId)}`);
        return files.streamZip(own.root, plan, res, { maxBytes: plan.maxBytes });
      }
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
      if (String(id) === String(req.hubUser.id)) return jsonResponse(res, 400, { error: 'To change your own two-factor sign-in, use Security in your account menu.' });
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
      let status = getAgentStatuses();
      // A member never learns the caller of a consultation they may not use (consultedBy, the activity text).
      if (!req.hubService && !access.isAdmin(req.hubUser)) status = access.statusForViewer(req.hubUser, status, { agents: all, resolveVirtual: (n) => temporalWorkersLib.getVirtual(n) });
      const idle = { busy: false, busySince: null, activity: null, pendingQuestion: false };
      // keptOnBox: this agent's data is meant to stay on this computer (medical/legal folders or the keep-on-box list): the voice settings warn before a cloud engine.
      const kept = require('./lib/voice/cloud').keptOnBox;
      // Who confirmed a cloud engine, and when, is for admins only.
      const isAdm = !!req.hubService || access.isAdmin(req.hubUser);
      const stripVoice = (a) => require('./lib/voice/cloud').publicAgentVoice(a, isAdm);
      // reportsTo / buildPartner naming an agent this viewer cannot see are left out (a signed-in admin and the hub's own service see all).
      const seeAll = !!req.hubService || (access.isAdmin(req.hubUser) && !req.hubPendingTotp);
      const visibleNames = new Set(agents.map(x => x && x.name));
      const hideUnseen = (a) => seeAll ? {} : {
        ...(a.reportsTo && !visibleNames.has(a.reportsTo) ? { reportsTo: undefined } : {}),
        ...(a.buildPartner && !visibleNames.has(a.buildPartner) ? { buildPartner: undefined } : {}),
      };
      // Call recordings: a signed-in admin sees the whole setting; everybody else (members, the hub's own service calls that agents' tools use) gets it without the allowed list. canDownload: is this caller on the list.
      const recView = { admin: access.isAdmin(req.hubUser) && !req.hubPendingTotp, userId: req.hubUser && !req.hubPendingTotp ? String(req.hubUser.id) : '' };
      const recordingsFor = require('./lib/recordings/settings').recordingsForViewer;
      return jsonResponse(res, 200, { agents: agents.map(a => ({ ...stripVoice(a), ...hideUnseen(a), ...(recView.admin ? {} : { envKeep: undefined }), recordings: recordingsFor(a, recView), keptOnBox: kept(a, hubSettings.getSetting), effortUltra: require('./lib/effort').ultraFor(a.model), tierOptions: require('./lib/tier').tiersFor(a.model), tierLabels: require('./lib/tier').labelsFor(a.model), ...(status[a.name] || idle) })) });
    }

    if (pathname === '/api/agents/status' && req.method === 'GET') {
      const h = require('./lib/hub-halt').getHubHalt().status();
      let agents = getAgentStatuses();
      if (req.hubToken) {
        // A program's token: the agents it is scoped to, or every agent for a status-only token (a dashboard).
        if (req.hubToken.agents) agents = Object.fromEntries(Object.entries(agents).filter(([name]) => req.hubToken.agents.includes(name)).map(([name, e]) => [name, access.redactCaller(e, (n) => req.hubToken.agents.includes(n))]));
      } else if (!req.hubService && !access.isAdmin(req.hubUser)) {
        const all = await getAgents();
        agents = access.statusForViewer(req.hubUser, agents, { agents: all, resolveVirtual: (n) => temporalWorkersLib.getVirtual(n) });
      }
      return jsonResponse(res, 200, { halted: h.halted, haltedAt: h.at, haltReason: h.reason, agents });
    }

    // Hub-wide kill switch (owner only: Basic auth + same-origin guard apply to every /api route).
    if (pathname === '/api/hub/status' && req.method === 'GET') {
      const pacingStatus = getPacing().status();
      const capProviders = new Set(['claude-sdk', 'codex-cli', ...Object.keys(pacingStatus.providers || {})]);
      try { for (const a of await getAgents()) if (a && a.model) capProviders.add(temporalWorkersLib.providerOf(a.model)); } catch {}
      const capList = [...capProviders].filter(Boolean).sort((a, b) => { const r = (p) => p === 'claude-sdk' ? 0 : p === 'codex-cli' ? 1 : 2; return r(a) - r(b) || a.localeCompare(b); });
      return jsonResponse(res, 200, { ...require('./lib/hub-halt').getHubHalt().status(), pacing: { ...pacingStatus, caps: require('./lib/provider-pacing').capsView(hubSettings.getSetting('workersAtOnce'), capList) } });
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
      return jsonResponse(res, 200, { ...l.today(), caps: l.caps(), credits: l.credits() });
    }
    // Monthly API credit per provider (e.g. the API credit with a Claude Max plan): { provider, monthlyUsd, resetDay }.
    if (pathname === '/api/ledger/credits' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}') || {}; } catch { return jsonResponse(res, 400, { error: 'invalid JSON' }); }
      const { CREDIT_PROVIDERS, cleanCredit } = require('./lib/ledger');
      const provider = String(body.provider || '');
      if (!CREDIT_PROVIDERS.includes(provider)) return jsonResponse(res, 400, { error: `Credits can be tracked for ${CREDIT_PROVIDERS.join(', ')}.` });
      let c;
      try { c = cleanCredit(body); } catch (e) { return jsonResponse(res, 400, { error: e.message }); }
      const next = { ...(hubSettings.getSetting('apiCredits', {}) || {}) };
      if (c) next[provider] = c; else delete next[provider];
      hubSettings.updateSettings({ apiCredits: next });
      return jsonResponse(res, 200, { credits: getLedger().credits() });
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

    // The ChatGPT plan's usage as Codex reports it (lib/codex-usage; admins). POST .../refresh asks Codex now (no turn,
    // at most once a minute): 409 with the reason when it was refused or failed.
    if ((pathname === '/api/codex-usage' && req.method === 'GET') || (pathname === '/api/codex-usage/refresh' && req.method === 'POST')) {
      if (!access.isAdmin(req.hubUser || { role: 'admin' })) return jsonResponse(res, 403, { error: 'admin_only' });
      const cu = require('./lib/codex-usage').getCodexUsage();
      if (req.method === 'GET') return jsonResponse(res, 200, cu.snapshot());
      const r = await cu.readNow();
      return jsonResponse(res, r && r.ok ? 200 : 409, { ...(r || { ok: false, error: 'Unknown error' }), snapshot: (r && r.snapshot) || cu.snapshot() });
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
        health: require('./lib/model-health').getModelHealth().view(),   // marks for the pickers (lib/model-health)
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

      // API, OpenRouter and local models: one tiny request through the same route an agent's reply takes, with one
      // tool to call (lib/model-health). It catches refusals (privacy setting, key, credit), models that can't use
      // tools and servers that aren't running, explains them in plain words, and marks the model for the pickers.
      // Also used before an agent is switched to a model the hub has not seen answer.
      if (!isMythosModel(model)) {
        const r = await require('./lib/model-health').getModelHealth().test(String(model).slice(0, 200), { ledger: getLedger(), force: !!body.force });
        _modelHealthCache[model] = r.ok ? { working: true, latency: r.ms, testedAt: Date.now() } : { working: false, error: `${r.title} ${r.what}`.slice(0, 300), testedAt: Date.now() };
        return jsonResponse(res, 200, { success: !!r.ok, model, latency: r.ms,
          ...(r.ok ? { response: r.toolCall ? 'called the test tool' : 'answered without calling the test tool' } : { error: `${r.title} ${r.what} What to do: ${r.fix}` }), ...r });
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
      if (!cache) return jsonResponse(res, 200, { status: 'no_cache' });
      const { offerSources, ...models } = cache;
      return jsonResponse(res, 200, models);
    }

    if (pathname === '/api/agents/create' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const result = await createAgent(body.name, body.model, body.personality, body.skills, body.category, body.owner || null);
      const { identity: _identity, ...shown } = result;   // the box id stays on the server (lib/team-plan uses it)
      return jsonResponse(res, result.success ? 200 : 400, shown);
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
        // lib/member-models: the same rule decides which models a member's temporary workers (spawn_workers) may use.
        const mm = require('./lib/member-models');
        const allowed = mm.list();
        if (!mm.memberMayUse(body.model)) {
          return jsonResponse(res, 403, { error: 'admin_only', detail: 'only an admin can change this agent\'s model' + (allowed.length ? ` (members may choose: ${allowed.join(', ')})` : '') });
        }
      }
      const result = await setAgentModel(name, body.model);
      if (result.success) await publishAgentUpdate(name, ['model']);
      return jsonResponse(res, result.success ? 200 : 400, result);
    }

    if (pathname === '/api/model-offer-groups' || pathname === '/api/model-offer-groups/answer') {
      const out = await require('./lib/model-offer-group-routes').routeModelOfferGroups({
        req, pathname, readBody, identify: (request) => hubAuth.identify(request), isBusy: name => agentBusy(name, true),
        getService: groupedModelOffers,
      });
      res.setHeader('Cache-Control', 'no-store');
      return jsonResponse(res, out.status, out.body);
    }

    // /api/agents/:name/model-offer: the newer (or stronger) model on offer for this agent, or null (lib/model-offers-service)
    // Admins only, like the settings page itself (the access gate classifies both model-offer routes as admin routes).
    if (/^\/api\/agents\/([^/]+)\/model-offer$/.test(pathname) && req.method === 'GET') {
      if (!req.hubService && !access.isAdmin(req.hubUser)) return jsonResponse(res, 403, { error: 'admin_only' });
      let name; try { name = decodeURIComponent(pathname.split('/')[3]); } catch { return jsonResponse(res, 400, { error: 'bad agent name' }); }
      const o = await require('./lib/model-offers-service').getModelOffers().offerFor(name);
      if (!o) return jsonResponse(res, 200, { offer: null });
      return jsonResponse(res, 200, { offer: { from: o.from, to: o.to, kind: o.kind, why: o.why, route: o.route, cost: o.cost } });
    }

    // /api/agents/:name/model-offer/decline: "Not now" (admin only); the model must be the current offer
    if (/^\/api\/agents\/([^/]+)\/model-offer\/decline$/.test(pathname) && req.method === 'POST') {
      if (!req.hubService && !access.isAdmin(req.hubUser)) return jsonResponse(res, 403, { error: 'admin_only' });
      let name; try { name = decodeURIComponent(pathname.split('/')[3]); } catch { return jsonResponse(res, 400, { error: 'bad agent name' }); }
      let body; try { body = JSON.parse(await readBody(req)); } catch { return jsonResponse(res, 400, { error: 'invalid JSON' }); }
      const svc = require('./lib/model-offers-service').getModelOffers();
      const o = await svc.offerFor(name);
      if (!o || !body || o.to !== body.model) return jsonResponse(res, 409, { error: 'That suggestion is no longer current.' });
      const r = svc.decline(name, o.to);
      return r && r.ok ? jsonResponse(res, 200, { ok: true }) : jsonResponse(res, 500, { error: (r && r.error) || 'Could not save.' });
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

    // POST /api/agents/:name/build-team: start the lead's Build Team turn for a main agent (lib/team-plan, lib/sdk-chat startBuildTeam).
    // Only an admin's own signed-in browser session (the same test as owner_turn in /api/chat); the cross-origin refusal applies to every /api route.
    if (/^\/api\/agents\/([^/]+)\/build-team$/.test(pathname) && req.method === 'POST') {
      let name; try { name = decodeURIComponent(pathname.split('/')[3]); } catch { return jsonResponse(res, 400, { error: 'bad agent name' }); }
      const teamPlanLib = require('./lib/team-plan'), agentsLib = require('./lib/agents');
      const out = await teamPlanLib.routeBuildTeam({
        adminSession: req.hubIdentKind === 'user' && !req.hubPendingTotp && !req.hubToken && !req.hubService && access.isAdmin(req.hubUser),
        name, agents: await getAgents(), ownerLeadNames: agentsLib.ownerLeadNames, defaultLeadAgent: agentsLib.defaultLeadAgent,
        runs: buildTeamRuns, halted: () => require('./lib/hub-halt').getHubHalt().isHalted(), isBusy: isAgentActive,
        makeMessage: async (primary, all) => teamPlanLib.buildMessage({ primary, agentsList: all, adminIds: new Set(hubAuth.admins().map(u => String(u.id))),
          counts: teamPlanLib.transcriptCounts(30), models: await teamModelFacts(), tierOf: require('./lib/model-tiers').tierOf, ...teamPlanLib.historySources() }),
        start: startBuildTeam, userId: req.hubUser && req.hubUser.id != null ? String(req.hubUser.id) : null,
      });
      return jsonResponse(res, out.status, out.body);
    }

    // Set up teams (lib/team-setup): GET /api/team-setup, POST /api/team-setup/offer | start | undo. Only an admin's own signed-in browser
    // session (the build-team gate); the cross-origin refusal applies to every /api route.
    if (/^\/api\/team-setup(\/(offer|start|undo))?$/.test(pathname) && (req.method === 'POST' || (req.method === 'GET' && pathname === '/api/team-setup'))) {
      const teamSetupLib = require('./lib/team-setup'), teamPlanLib = require('./lib/team-plan'), agentsLib = require('./lib/agents');
      const action = req.method === 'GET' ? 'get' : pathname.split('/')[3];
      let body = {}; if (req.method === 'POST') { try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return jsonResponse(res, 400, { error: 'bad JSON' }); } }
      const out = await teamSetupLib.routeTeamSetup(action, {
        adminSession: req.hubIdentKind === 'user' && !req.hubPendingTotp && !req.hubToken && !req.hubService && access.isAdmin(req.hubUser),
        svc: teamSetupLib.getTeamSetup(), agents: await getAgents(), body,
        ownerLeadNames: agentsLib.ownerLeadNames, defaultLeadAgent: agentsLib.defaultLeadAgent,
        running: () => teamSetupRuns.size > 0, halted: () => require('./lib/hub-halt').getHubHalt().isHalted(), isBusy: isAgentActive,
        makeMessage: async (all) => teamSetupLib.setupMessage({ agentsList: all, adminIds: new Set(hubAuth.admins().map(u => String(u.id))),
          tierOf: require('./lib/model-tiers').tierOf, ...teamPlanLib.historySources() }),
        start: startTeamSetup, userId: req.hubUser && req.hubUser.id != null ? String(req.hubUser.id) : null,
      });
      return jsonResponse(res, out.status, out.body);
    }

    // Works alone (lib/team-setup): GET /api/team-alone -> { alone: { name: { at, reason } } }, POST /api/team-alone { agent, reason }, DELETE /api/team-alone/:agent.
    // The Set up teams gate: only an admin's own signed-in browser session; any other caller (a member, a token, a service) gets 403 and never an entry.
    if (/^\/api\/team-alone(\/[^/]+)?$/.test(pathname) && ((req.method === 'GET' || req.method === 'POST') ? pathname === '/api/team-alone' : req.method === 'DELETE' && pathname !== '/api/team-alone')) {
      const teamSetupLib = require('./lib/team-setup');
      const action = req.method === 'GET' ? 'get' : req.method === 'POST' ? 'set' : 'clear';
      let body = {}; if (req.method === 'POST') { try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return jsonResponse(res, 400, { error: 'bad JSON' }); } }
      let agent = ''; if (req.method === 'DELETE') { try { agent = decodeURIComponent(pathname.split('/')[3]); } catch { return jsonResponse(res, 400, { error: 'bad agent name' }); } }
      const out = await teamSetupLib.routeTeamAlone(action, {
        adminSession: req.hubIdentKind === 'user' && !req.hubPendingTotp && !req.hubToken && !req.hubService && access.isAdmin(req.hubUser),
        svc: teamSetupLib.getTeamSetup(), agents: await getAgents(), adminIds: new Set(hubAuth.admins().map(u => String(u.id))), body, agent,
        userId: req.hubUser && req.hubUser.id != null ? String(req.hubUser.id) : null,
      });
      return jsonResponse(res, out.status, out.body);
    }

    // POST /api/agents/:name/optimize-team: start the review of a main agent's team (lib/team-review, lib/sdk-chat startOptimizeTeam).
    // The same gate as build-team: only an admin's own signed-in browser session. The lead runs it, or the boss itself when its content stays on its own service.
    // GET /api/agents/:name/optimize-team/estimate: the counts the menu entry shows ({ days, turns, handOffs }), same gate.
    if (/^\/api\/agents\/([^/]+)\/optimize-team(\/estimate)?$/.test(pathname) && (req.method === 'POST' || req.method === 'GET')) {
      const isEstimate = pathname.endsWith('/estimate');
      if (isEstimate !== (req.method === 'GET')) return jsonResponse(res, 405, { error: 'method not allowed' });
      let name; try { name = decodeURIComponent(pathname.split('/')[3]); } catch { return jsonResponse(res, 400, { error: 'bad agent name' }); }
      const reviewLib = require('./lib/team-review'), agentsLib = require('./lib/agents'), sdkChatLib = require('./lib/sdk-chat');
      const adminSession = req.hubIdentKind === 'user' && !req.hubPendingTotp && !req.hubToken && !req.hubService && access.isAdmin(req.hubUser);
      const adminIdSet = () => new Set(hubAuth.admins().map(u => String(u.id)));
      // When the team was built: the same for the review and its menu estimate.
      const teamBuiltAtFor = (boss, all) => {
        let setups = [], audit = [];
        try { setups = require('./lib/team-setup').getTeamSetup().list(); } catch { /* no setups */ }
        try { audit = reviewLib.readReportsToAudit(); } catch { /* no audit */ }
        return reviewLib.teamBuiltAt({ boss, agentsList: all, setups, audit });
      };
      if (isEstimate) {
        const out = reviewLib.routeOptimizeEstimate({
          adminSession, name, agents: await getAgents(),
          makeEstimate: (boss, all) => reviewLib.estimate({ builtAt: teamBuiltAtFor(boss, all), boss, agentsList: all, transcript: require('./lib/transcript').getTranscript(), handOffs: sdkChatLib.handOffRecordsNow }),
        });
        return jsonResponse(res, out.status, out.body);
      }
      const out = await reviewLib.routeOptimizeTeam({
        adminSession, name, agents: await getAgents(), ownerLeadNames: agentsLib.ownerLeadNames, defaultLeadAgent: agentsLib.defaultLeadAgent,
        runs: sdkChatLib.optimizeTeamRuns, halted: () => require('./lib/hub-halt').getHubHalt().isHalted(), isBusy: isAgentActive,
        keepOnBox: (rec) => sdkChatLib.researchKeptOnBox(rec),
        makeMessage: async (boss, all, own) => reviewLib.reviewMessage(reviewLib.reviewFacts({
          builtAt: teamBuiltAtFor(boss, all),
          boss, agentsList: all, adminIds: adminIdSet(), transcript: require('./lib/transcript').getTranscript(), handOffs: sdkChatLib.handOffRecordsNow,
          telemetryRows: require('./lib/team-usage').readRows(reviewLib.REVIEW_DAYS * 24), models: await teamModelFacts(), tierOf: require('./lib/model-tiers').tierOf,
          now: Date.now(), keepOnBox: own === true,
        })),
        start: sdkChatLib.startOptimizeTeam, userId: req.hubUser && req.hubUser.id != null ? String(req.hubUser.id) : null,
      });
      return jsonResponse(res, out.status, out.body);
    }

    // PATCH /api/agents/:name — update agent fields (category, etc.)
    if (/^\/api\/agents\/([^/]+)$/.test(pathname) && req.method === 'PATCH') {
      const name = decodeURIComponent(pathname.split('/')[3]);
      const body = JSON.parse(await readBody(req));
      // A member may tune their own agent's conversation settings, never its permissions, folders, sandbox, tools,
      // owner or sharing: those are admin decisions (member grants: Users page, Settings page, agent settings page).
      // Call recordings are switched and shared by a signed-in admin only: never a member (not in MEMBER_EDITABLE below) and never the hub's own service calls (agents' tools).
      // Only the owner (the earliest admin) does: who may download a family's recordings is not any admin's call.
      const recordingsChange = !!body && typeof body === 'object' && 'recordings' in body;
      if (recordingsChange && (req.hubService || req.hubToken || !req.hubUser || !hubAuth.isOwner(req.hubUser) || req.hubPendingTotp)) return jsonResponse(res, 403, { error: 'only the owner can change: recordings' });
      // Which environment variables an agent's commands keep is a signed-in admin's call: never a member, and never the hub's own service calls (an agent could widen itself).
      if (body && typeof body === 'object' && 'envKeep' in body && (req.hubService || req.hubToken || !req.hubUser || !access.isAdmin(req.hubUser) || req.hubPendingTotp)) return jsonResponse(res, 403, { error: 'only an admin can change: envKeep' });
      // Who an agent reports to is an admin's call (or the lead's team tool): never the hub's own service calls (an agent's tools).
      if (body && typeof body === 'object' && 'reportsTo' in body && (req.hubService || req.hubToken || !req.hubUser || !access.isAdmin(req.hubUser) || req.hubPendingTotp)) return jsonResponse(res, 403, { error: 'reportsTo is set by an admin or through the team tool' });
      // The command lockbox changes what an agent's commands may touch: a signed-in admin's own browser session only (never a member, a token, the hub's own service or an agent).
      if (!!body && typeof body === 'object' && ('lockbox' in body || 'lockboxEnv' in body) && !require('./lib/lockbox/settings').isAdminSession(req)) return jsonResponse(res, 403, { error: 'Sign in with an admin account in your browser to change the command lockbox.' });
      const recSettings = require('./lib/recordings/settings');
      const allowedBefore = recordingsChange ? recSettings.recordingsOf((await getAgents()).find(a => a.name === name)).allowed : [];
      if (!req.hubService && !access.isAdmin(req.hubUser)) {
        const MEMBER_EDITABLE = new Set(['blurb', 'maxContextMessages', 'maxOutputTokens', 'contextBudget', 'compaction', 'minimalContext']);
        const refused = Object.keys(body || {}).filter(k => !MEMBER_EDITABLE.has(k));
        if (refused.length) return jsonResponse(res, 403, { error: `only an admin can change: ${refused.join(', ')}` });
      }
      const { updateAgentField } = require('./lib/agents');
      // Voice: a cloud engine for an agent kept on this computer needs the owner (the earliest admin), not just any admin.
      const result = await updateAgentField(name, body, { isOwner: !req.hubService && !!req.hubUser && hubAuth.isOwner(req.hubUser), userId: req.hubUser ? String(req.hubUser.id) : '',
        // Changes to the call-recordings setting are audited (agent.recordings): who, which agent, keep on/off, the allowed ids, the mic.
        audit: (action, detail) => hubAuth.audit(req.hubUser ? String(req.hubUser.id) : null, action, detail, hubAuth.clientIp(req)),
        // A lockbox change is told to the admins in plain words (a security notice), like the admin 2-factor rule.
        userName: req.hubUser ? String(req.hubUser.name || req.hubUser.login || req.hubUser.id || '') : '',
        notifyAdmins: (text) => require('./lib/push').getPush().notify({ title: 'Command lockbox changed', body: text, tag: 'lockbox-change' }, { adminsOnly: true, kind: 'security' }),
        // Reporting lines cleared because the team no longer fits are a team notice, not a security one (own title and tag).
        notifyTeam: (text) => require('./lib/push').getPush().notify({ title: 'Team changed', body: text, tag: 'team-change' }, { adminsOnly: true, kind: 'other' }) });
      if (!result.success && result.status) return jsonResponse(res, result.status, { error: result.error });
      // Handing a head agent to a member: it introduces itself in its (still empty) chat.
      if (result.success && body && body.owner) { const u = hubAuth.getUser(String(body.owner)); if (u && u.role === 'member') require('./lib/teams').greetIfFresh(name, u).catch(() => {}); }
      // A change of who may download this agent's recordings is told to everybody on the old and the new list.
      if (result.success && recordingsChange) {
        try {
          const rec = (await getAgents()).find(a => a.name === name);
          const allowedAfter = recSettings.recordingsOf(rec).allowed;
          if (allowedBefore.length !== allowedAfter.length || allowedBefore.some(id => !allowedAfter.includes(id))) {
            await require('./lib/push').getPush().notifyUsers({
              title: 'Recording access changed',
              body: `${(rec && rec.display) || name}: the list of people who can download its recordings was changed.`,
              tag: `rec-access-${name}`,
            }, [...new Set([...allowedBefore, ...allowedAfter])], { kind: 'security' });
          }
        } catch {}
      }
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
      // The page sends its device's zone with each message (lib/timezone): saved before the turn reads it, so the first
      // message after travelling is already in the new local time. Ignored while the person has pinned a zone.
      const deviceZone = req.headers['x-hub-time-zone'];
      if (req.hubUser && typeof deviceZone === 'string' && deviceZone) { try { hubAuth.setTimeZone(req.hubUser.id, deviceZone.trim(), { auto: true }); } catch {} }
      const body = stripHubOnlyChatFields(JSON.parse(await readBody(req)), req);
      // The owner's own message (same test as /api/chat below): lets connector_access be offered in this turn.
      if (body && typeof body === 'object') body.owner_turn = req.hubIdentKind === 'user' && !req.hubPendingTotp && !req.hubToken && !req.hubService && access.isAdmin(req.hubUser);
      // Identity comes only from the authenticated session (req.hubUser), never from the body.
      return handleChatStream(body, res, { userId: (req.hubUser && req.hubUser.id) || null, service: !!req.hubService, accounts: hubAuth.hasUsers(), admin: access.isAdmin(req.hubUser) });
    }

    if (pathname === '/api/chat' && req.method === 'POST') {
      const body = stripHubOnlyChatFields(JSON.parse(await readBody(req)), req);
      // The owner's own message: a signed-in admin's browser session (never an API token, the hub itself or legacy credentials).
      if (body && typeof body === 'object') body.owner_turn = req.hubIdentKind === 'user' && !req.hubPendingTotp && !req.hubToken && !req.hubService && access.isAdmin(req.hubUser);
      // Same trusted identity as the stream route (never from the body), so the voice call match works here too.
      return handleChat(body, res, { userId: (req.hubUser && req.hubUser.id) || null, service: !!req.hubService, accounts: hubAuth.hasUsers(), admin: access.isAdmin(req.hubUser) });
    }

    // Stop button: a browser disconnect no longer ends a turn, so stopping is explicit.
    if (pathname === '/api/chat/stop' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const result = stopAgentTurn(String(body?.agent || ''));
      return jsonResponse(res, 200, result);
    }

    if (pathname === '/api/ask_response' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      // personKey: the account answering (as lib/sdk-chat records the person of a turn), for cards only one person may answer
      const personKey = !hubAuth.hasUsers() ? 'owner' : (req.hubUser && req.hubIdentKind === 'user' && !req.hubPendingTotp && req.hubUser.id != null ? String(req.hubUser.id).slice(0, 64) : null);
      const result = handleAskResponse(body, { isAdmin: access.isAdmin(req.hubUser), personKey });
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
    // ── Call recordings (lib/recordings): uploads from the person on the call, and list/play/download/delete for the allowed users only ──
    if (pathname === '/api/recordings' || pathname.startsWith('/api/recordings/')) return require('./lib/recordings/routes').handle(pathname, req, res, { readBody, jsonResponse, getAgents });
    // ── Voice: local speech-to-text and text-to-speech (lib/voice) ─────────────────────────
    if (pathname.startsWith('/api/voice/')) return require('./lib/voice/routes').handle(pathname, req, res, { readBody, jsonResponse, getAgents, getSetting: hubSettings.getSetting, updateSettings: hubSettings.updateSettings, adminName: () => require('./lib/claude-signin-routes').adminDisplayName(hubAuth) });
    // ── Character packs for the call face view (lib/faces; packs live in <hub home>/faces) ──
    if (pathname === '/api/faces' || pathname.startsWith('/api/faces/')) return require('./lib/faces/routes').handle(pathname, req, res, { readBody, jsonResponse });

    // ── Trading wallet (owner controls; agents only ever get the wallet_* tools) ──────────
    if (pathname.startsWith('/api/wallet/')) {
      const svc = require('./lib/wallet/service').getWalletService();
      const ks = svc.keystore;
      try {
        if (pathname.startsWith('/api/wallet/passkey/')) {
          let body = {};
          if (req.method === 'POST') {
            try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return jsonResponse(res, 400, { error: 'Bad JSON.' }); }
          }
          const out = await passkeyRoutes().handle({ pathname, method: req.method, body, origin: req.headers.origin, host: req.headers.host, user: req.hubUser, ownerBrowser: req.hubIdentKind === 'user' && !req.hubPendingTotp && !req.hubToken && !req.hubService && access.isAdmin(req.hubUser) });
          return jsonResponse(res, out.status, out.json);
        }
        if (pathname === '/api/wallet/status' && req.method === 'GET') {
          return jsonResponse(res, 200, passkeyRoutes().status());
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

    // Team guidance level: 'full' (default) | 'light' | 'off'  — see lib/team-guidance.js (admin only, like /api/sdk_workers)
    if (pathname === '/api/team_guidance' && req.method === 'GET') {
      const tg = require('./lib/team-guidance');
      return jsonResponse(res, 200, { level: tg.getLevel(), levels: tg.LEVELS, default: tg.DEFAULT_LEVEL });
    }
    if (pathname === '/api/team_guidance' && req.method === 'POST') {
      const tg = require('./lib/team-guidance');
      const body = JSON.parse(await readBody(req));
      const requested = String(body.level || '').trim().toLowerCase();
      if (!tg.LEVELS.includes(requested)) return jsonResponse(res, 400, { error: `level must be one of: ${tg.LEVELS.join(', ')}` });
      hubSettings.updateSettings({ teamGuidance: requested });
      console.log(`[settings] teamGuidance = ${requested}`);
      return jsonResponse(res, 200, { level: tg.getLevel() });
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
      // "Move now" on Settings -> Status (admins only, like every /api/sandbox route): one try of a home move that failed
      const mh = pathname.match(/^\/api\/sandbox\/agents\/([^/]+)\/move-home$/);
      if (mh && req.method === 'POST') {
        let nm; try { nm = decodeURIComponent(mh[1]); } catch { nm = mh[1]; }
        const a = (await getAgents()).find(x => x.name === nm);
        if (!a) return jsonResponse(res, 404, { error: 'unknown agent' });
        const r = await sb.moveHomeNow(a, { busy: () => temporalWorkersLib.listVirtual().some(v => v && v.parent === a.name) });
        return jsonResponse(res, r.ok ? 200 : 409, r);
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
    // ── Command lockbox (lib/lockbox): host state with each agent's mode, and the latest would-block lines. Admin session only. ──
    if (pathname.startsWith('/api/lockbox/')) {
      const handled = await require('./lib/lockbox/settings').handle(pathname, req, res, {
        jsonResponse, getAgents, getSetting: (k) => hubSettings.getSetting(k), lockbox: require('./lib/lockbox'),
        sandboxedOf: (a) => require('./lib/sandbox').getSandbox().isSandboxed(a),
        handsOf: (a) => require('./lib/hub-tools').modeFor(a, (k) => hubSettings.getSetting(k)),
      });
      if (handled) return;
      return jsonResponse(res, 404, { error: 'unknown lockbox route' });
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
    // ── Claude sign-in (lib/claude-signin-routes): GET is for any signed-in person (members only learn who to ask); the three
    // POSTs are admin routes and refuse anything but an admin's own browser session first (no token, service identity, half-signed-in 2FA). ──
    if (pathname === '/api/claude-signin' || pathname.startsWith('/api/claude-signin/')) {
      const csi = require('./lib/claude-signin');
      const r = await require('./lib/claude-signin-routes').handle({
        method: req.method, pathname, req, res,
        isAdminSession: (q) => require('./lib/access').isAdminSession(q),
        readBody, auth: hubAuth, signIn: () => csi.getSignIn(), words: csi.WORDS,
        hasSignIn: () => require('./lib/claude-auth').hasSignIn(),
        // after a sign-in, the hub's own health view catches up now (claude-auth's token cache is cleared by the engine)
        onDone: () => {
          const sh = require('./lib/system-health/wire').getSystemHealth();
          if (!sh.isRunning() && sh.settings().enabled) Promise.resolve().then(() => sh.run({ trigger: 'manual' })).catch(() => {});
        },
      });
      if (res.destroyed) return;
      if (r) return jsonResponse(res, r.status, r.body);
    }
    // ── Health check (lib/system-health): admin-only (the route class above, checked again in the handler). GET the last
    // result, POST /run checks now in the background, PUT /settings saves the systemHealth settings. ──
    if (pathname === '/api/system-health' || pathname.startsWith('/api/system-health/')) {
      const hlBody = req.method === 'PUT' ? await authJson() : {};
      const r = await require('./lib/system-health/routes').handle({
        method: req.method, pathname, admin: !!req.hubService || (access.isAdmin(req.hubUser) && !req.hubPendingTotp), body: hlBody,
        health: () => require('./lib/system-health/wire').getSystemHealth(),
        validateSettings: (o) => require('./lib/system-health').validateSettings(o),
        saveSettings: (v) => hubSettings.updateSettings({ systemHealth: v }),
        log: (m) => console.warn(m),
      });
      if (r) return jsonResponse(res, r.status, r.body);
    }
    // ── Self-check (lib/selfcheck, lib/selfcheck-routes): admin-only (the route class above, checked again in the handler).
    // GET the last result, POST /run starts one in the background, PUT /settings saves the selfCheck settings. ──
    if (pathname === '/api/selfcheck' || pathname.startsWith('/api/selfcheck/')) {
      const scBody = req.method === 'PUT' ? await authJson() : {};
      const r = await require('./lib/selfcheck-routes').handle({
        method: req.method, pathname, admin: !!req.hubService || (access.isAdmin(req.hubUser) && !req.hubPendingTotp), body: scBody,
        selfCheck: () => require('./lib/selfcheck').getSelfCheck(),
        validateSettings: (o) => require('./lib/selfcheck').validateSettings(o),
        saveSettings: (v) => hubSettings.updateSettings({ selfCheck: v }),
        log: (m) => console.warn(m),
      });
      if (r) return jsonResponse(res, r.status, r.body);
    }
    // ── Component watch (lib/component-watch): admin-only (the route class above). GET the items and the Codex setting,
    // POST /check looks now (a look only: updates run on the schedule or with the button), POST /codex/update starts the
    // Codex client update and answers 202 at once (409 when it is refused at once); the outcome is the item's lastUpdate. ──
    if (pathname === '/api/components' && req.method === 'GET') {
      return jsonResponse(res, 200, { items: componentWatch().items(), setting: { codex: (hubSettings.getSetting('componentUpdates', {}) || {}).codex || 'auto' } });
    }
    if (pathname === '/api/components/check' && req.method === 'POST') {
      try { await componentWatch().check({ reason: 'manual', allowUpdate: false }); } catch (e) { return jsonResponse(res, 500, { error: e.message }); }
      return jsonResponse(res, 200, { items: componentWatch().items() });
    }
    if (pathname === '/api/components/codex/update' && req.method === 'POST') {
      const can = componentWatch().canUpdateCodexNow();
      if (!can || !can.ok) return jsonResponse(res, 409, { ok: false, error: (can && can.error) || 'the update did not run' });
      componentWatch().updateCodexNow().catch((e) => console.warn(`[component-watch] Codex update failed: ${e && e.message}`));   // not awaited: it takes minutes
      return jsonResponse(res, 202, { started: true });
    }
    // ── Memory health (lib/memory-health): admin-only. GET answers with the last result while it is under 26 hours old
    // (else checks now); run checks now. Nightly from the schedule at start.
    if (pathname === '/api/memory-health' && req.method === 'GET') {
      const mh = require('./lib/memory-health').getMemoryHealth();
      // ?stored=1 (the phone menu): the last result only, never a new check
      const r = new URL(req.url, 'http://x').searchParams.get('stored') === '1' ? (mh.stored() || { agents: [], checkedAt: null }) : await mh.latest();
      return jsonResponse(res, 200, { ok: true, ...r });
    }
    if (pathname === '/api/memory-health/action' && req.method === 'POST') {
      // One action an admin pressed in Settings → Status → Memory (lib/memory-health act): checked against what it
      // applies to now; the deletes need the typed word. Admin-only (an unlisted /api route).
      const b = await authJson(); if (!b) return jsonResponse(res, 400, { error: 'invalid JSON' });
      const r = await require('./lib/memory-health').getMemoryHealth().act({ action: String(b.action || ''), agent: b.agent || null, folder: b.folder || null, file: b.file || null, confirm: b.confirm == null ? null : String(b.confirm) });
      return jsonResponse(res, r.ok ? 200 : 400, r);
    }
    if (pathname === '/api/memory-health/run' && req.method === 'POST') {
      const r = await require('./lib/memory-health').getMemoryHealth().run();
      return jsonResponse(res, 200, { ok: true, ...r, cached: false });
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
      const userHasTotp = () => !!(req.hubUser && ((req.hubUser.totp && req.hubUser.totp.enabled) || req.hubUser.totpEnabled));
      const fail = (e) => jsonResponse(res, [403, 409, 500].includes(e.status) ? e.status : 400, { error: e.message, ...(e.check ? { check: e.check } : {}), ...(e.choose ? { choose: e.choose } : {}), ...(e.admin ? { admin: e.admin } : {}), ...(e.needsAck ? { needsAck: true } : {}), ...(e.needsStepUp ? { needsStepUp: true, totp: e.totp !== undefined ? !!e.totp : userHasTotp() } : {}) });
      // Asking less needs the account password (and code) in the body. They are taken out before the module sees the input; steppedUp comes only from this check.
      const takeStepUp = (b) => {
        const input = b && typeof b === 'object' && !Array.isArray(b) ? { ...b } : b;
        if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.password !== 'string') {
          if (input && typeof input === 'object' && !Array.isArray(input)) { delete input.password; delete input.code; }
          return { input, steppedUp: false, denied: null };
        }
        const given = { password: input.password, code: input.code };
        delete input.password; delete input.code;
        const no = accountStepUp(req.hubUser, given, req.socket && req.socket.remoteAddress);
        return no ? { input, steppedUp: false, denied: no } : { input, steppedUp: true, denied: null };
      };
      // Changes come from a person on the page, never from the hub's internal service identity (agents' calls back into the hub).
      if (req.method !== 'GET' && req.hubService) return jsonResponse(res, 403, { error: 'Module changes need a signed-in admin.' });
      try {
        if (pathname === '/api/modules' && req.method === 'GET') return jsonResponse(res, 200, { ok: true, modules: mods.list() });
        let m = pathname.match(/^\/api\/modules\/([a-z][a-z0-9-]{1,31})$/);
        if (m && req.method === 'GET') return jsonResponse(res, 200, { ok: true, module: mods.detail(m[1]) });
        if (m && req.method === 'DELETE') return jsonResponse(res, 200, mods.remove(m[1]));
        m = pathname.match(/^\/api\/modules\/([a-z][a-z0-9-]{1,31})\/signin\/(start|poll|cancel)$/);
        if (m && m[2] === 'start' && req.method === 'POST') {
          // The address the provider sends the browser back to is built from this request, and only when the hub already accepts the Host.
          let codeFlow = false; try { codeFlow = mods.detail(m[1]).oauthFlow === 'code'; } catch { /* unknown module: signinStart says so */ }
          if (!codeFlow) return jsonResponse(res, 200, await mods.signinStart(m[1]));
          const host = String(req.headers.host || '');
          if (!require('./lib/origin-guard').knownHost(host)) return jsonResponse(res, 400, { error: "Open this page at your Maestro's usual address." });
          const fwd = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
          let origin = `${fwd === 'https' || fwd === 'http' ? fwd : (req.socket && req.socket.encrypted ? 'https' : 'http')}://${host}`;
          // The page sends the address it is open at; it is used only when its host is this request's Host (one the hub accepts) and it is http(s).
          const sent = (await bodyJson()).origin;
          if (sent !== undefined && sent !== null && sent !== '') {
            let u = null; try { u = new URL(String(sent)); } catch { /* refused below */ }
            if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:') || u.host.toLowerCase() !== host.toLowerCase()) return jsonResponse(res, 400, { error: "Open this page at your Maestro's usual address." });
            origin = u.origin;
          }
          return jsonResponse(res, 200, await mods.signinStart(m[1], { origin, userId: req.hubUser ? req.hubUser.id : null }));
        }
        if (m && req.method === 'POST') return jsonResponse(res, 200, m[2] === 'cancel' ? mods.signinCancel(m[1]) : await mods.signinPoll(m[1]));
        m = pathname.match(/^\/api\/modules\/([a-z][a-z0-9-]{1,31})\/notice-agent$/);
        if (m && req.method === 'POST') {
          const r = mods.setNoticeAgent(m[1], String((await bodyJson()).agent || ''), { by: req.hubUser.id });
          return r && r.ok ? jsonResponse(res, 200, { ok: true, noticeAgent: r.noticeAgent }) : jsonResponse(res, 400, { error: (r && r.error) || 'Could not set the agent.' });
        }
        m = pathname.match(/^\/api\/modules\/([a-z][a-z0-9-]{1,31})\/agent-permissions$/);
        if (m && req.method === 'POST') {
          // What agents may do on a module (and whether each session is asked): a signed-in admin's own browser session only. Never the hub service,
          // an API token, a session still owing its two-factor code, a member or the legacy single password; nothing in the body says who is asking.
          if (!(req.hubIdentKind === 'user' && !req.hubPendingTotp && !req.hubToken && !req.hubService && access.isAdmin(req.hubUser))) return jsonResponse(res, 403, { error: 'Sign in with an admin account in your browser to change agent permissions.' });
          const su = takeStepUp(await bodyJson());
          if (su.denied) return jsonResponse(res, 403, { error: su.denied, stepUp: true });
          return jsonResponse(res, 200, mods.setAgentPermissions(m[1], su.input, { adminBrowser: true, userId: String(req.hubUser.id), name: req.hubUser.name || req.hubUser.login || undefined, steppedUp: su.steppedUp }));
        }
        m = pathname.match(/^\/api\/modules\/([a-z][a-z0-9-]{1,31})\/approval-policy$/);
        if (m && (req.method === 'GET' || req.method === 'POST')) {
          // How long one approval lasts and which agents are never asked, per computer: the same signed-in admin's own browser as the permission editor.
          if (!(req.hubIdentKind === 'user' && !req.hubPendingTotp && !req.hubToken && !req.hubService && access.isAdmin(req.hubUser))) return jsonResponse(res, 403, { error: 'Sign in with an admin account in your browser to change agent permissions.' });
          // The computers as the module reports them (never names from the request), or null when they can't be read.
          const computersOf = async (timeoutMs) => {
            try {
              const raw = await require('./lib/connectors').getConnectors().callTool(m[1], 'computers_status', {}, { hub: true, timeoutMs });
              const parsed = require('./lib/modules').parseToolText(raw);
              const rows = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.computers) ? parsed.computers : null);
              if (!rows || (parsed && !Array.isArray(parsed) && parsed.error)) return null;
              return rows.filter((x) => x && typeof x === 'object' && typeof x.nodeid === 'string' && x.nodeid)
                .map((x) => ({ id: x.nodeid.split('/').pop(), nodeid: x.nodeid, name: String(x.name || '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, 80), online: !!x.online }));
            } catch { return null; }
          };
          if (req.method === 'POST') {
            const su = takeStepUp(await bodyJson());
            if (su.denied) return jsonResponse(res, 403, { error: su.denied, stepUp: true });
            const body = su.input;
            const listed = body && typeof body.computer === 'string' ? await computersOf(10000) : null;
            const known = listed ? listed.find((x) => x.id === body.computer) : null;
            // Asking less needs a computer the module lists right now (computerKnown true); an unlisted one (false) or an unreadable or empty list (null) is refused then. Asking more works for any id (setApprovalPolicy decides).
            const computerKnown = listed && listed.length ? !!known : null;
            return jsonResponse(res, 200, mods.setApprovalPolicy(m[1], body, { adminBrowser: true, userId: String(req.hubUser.id), name: req.hubUser.name || req.hubUser.login || undefined, steppedUp: su.steppedUp }, { computerName: known ? known.name : '', computerKnown }));
          }
          const out = { ok: true, ...mods.approvalPolicy(m[1]), computers: [] };
          const list = await computersOf(30000);
          if (list) out.computers = list; else out.computersError = 'Could not load the computers.';
          return jsonResponse(res, 200, out);
        }
        // Facts about the computer the hub runs on (the precheck, the suggested settings): a signed-in admin only, never the hub's service identity or a member, and never offered to anyone else.
        m = pathname.match(/^\/api\/modules\/([a-z][a-z0-9-]{1,31})\/(?:precheck\/([A-Za-z0-9_-]{1,40})|suggestions)$/);
        if (m && req.method === 'GET') {
          if (req.hubService || (req.hubUser && !access.isAdmin(req.hubUser))) return jsonResponse(res, 403, { error: 'Only a signed-in admin can see this.' });
          // ?fresh=1 (the "Check again" button) looks again instead of using the answer kept for a few seconds.
          if (m[2] !== undefined) return jsonResponse(res, 200, await mods.precheck(m[1], m[2], { fresh: new URL(req.url, 'http://x').searchParams.get('fresh') === '1' }));
          return jsonResponse(res, 200, { suggestions: await mods.suggestions(m[1]) });
        }
        m = pathname.match(/^\/api\/modules\/([a-z][a-z0-9-]{1,31})\/help$/);
        if (m && req.method === 'GET') { const q = new URL(req.url, 'http://x').searchParams; return jsonResponse(res, 200, mods.help(m[1], { step: q.get('step') || '', error: q.get('error') || '' })); }
        m = pathname.match(/^\/api\/modules\/([a-z][a-z0-9-]{1,31})\/(step|check|settings|enable|disable|audit)$/);
        if (m) {
          const id = m[1], act = m[2];
          if (act === 'audit' && req.method === 'GET') return jsonResponse(res, 200, { ok: true, entries: mods.auditTail(id, 100) });
          if (req.method === 'POST') {
            const b = await bodyJson();
            if (act === 'step') return jsonResponse(res, 200, await mods.runStep(id, String(b.step || ''), b.input || {}));
            if (act === 'check') return jsonResponse(res, 200, { ok: true, check: await mods.check(id, b.check), module: mods.detail(id) });
            if (act === 'settings') {
              // Who may open a computer's desktop, and the address it opens at, are the owner's to change (compared with what is stored now).
              if (id === 'remote-computers' && b.values && typeof b.values === 'object' && !(req.hubUser && !req.hubService && !req.hubToken && !req.hubPendingTotp && hubAuth.isOwner(req.hubUser))) {
                const cur = mods.detail(id).settings || {};
                for (const k of ['desktop_who', 'desktop_address']) {
                  if (Object.prototype.hasOwnProperty.call(b.values, k) && String(b.values[k] === null || b.values[k] === undefined ? '' : b.values[k]) !== String(cur[k] === undefined || cur[k] === null ? '' : cur[k])) {
                    return jsonResponse(res, 403, { error: 'Only the owner can change who may open a desktop and its address.' });
                  }
                }
              }
              const saved = await mods.saveSettings(id, b.values || {});
              sweepRemoteDesktop(id);
              return jsonResponse(res, 200, { ok: true, module: saved });
            }
            if (act === 'enable' || act === 'disable') {
              const changed = mods.setEnabled(id, act === 'enable');
              sweepRemoteDesktop(id);
              return jsonResponse(res, 200, { ok: true, module: changed });
            }
          }
        }
        return jsonResponse(res, 404, { error: 'unknown modules route' });
      } catch (e) { return fail(e); }
    }

    // ── Open desktop (Remote computers): /api/remote-desktop and /remote-desktop/<session>/ (lib/remote-desktop checks sign-in, role, session and origin itself) ──
    if (pathname === '/api/remote-desktop' || pathname.startsWith('/api/remote-desktop/') || pathname.startsWith('/remote-desktop/')) {
      if (await remoteDesktop().handle(req, res)) return;
    }

    if (pathname.startsWith('/api/connector')) {
      const cx = require('./lib/connectors').getConnectors();
      const reply = (fn) => { try { const r = fn(); return r && typeof r.then === 'function' ? r.then(v => jsonResponse(res, 200, { ok: true, ...(v && typeof v === 'object' && !Array.isArray(v) ? v : { result: v }) })).catch(e => jsonResponse(res, 400, { error: e.message })) : jsonResponse(res, 200, { ok: true, ...(r && typeof r === 'object' ? r : {}) }); } catch (e) { return jsonResponse(res, 400, { error: e.message }); } };
      const bodyJson = async () => { try { return JSON.parse((await readBody(req)) || '{}'); } catch { return {}; } };
      if (pathname === '/api/connectors' && req.method === 'GET') return jsonResponse(res, 200, { ok: true, ...cx.list(), leads: (() => { try { return require('./lib/agents').ownerLeadNames(); } catch { return []; } })() });
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
      return require('./lib/hub-events').events.subscribe(req, res, { isAdmin, visibleAgent: visible, redact: isAdmin ? null : (ev) => access.redactTeamTurn(ev), statusView: (m) => isAdmin ? m : access.statusForViewer(req.hubUser, m, { agents: allAgents, resolveVirtual: (n) => temporalWorkersLib.getVirtual(n) }), filter: (ev) => ev.type === 'background' ? require('./lib/background-work').backgroundEventVisible(req.hubUser, ev, { agents: require('./lib/agents').getAgentsSync(), resolveVirtual: (n) => temporalWorkersLib.getVirtual(n), access }) : visible(ev.agent), eventFilter: (ev) => require('./lib/sdk-chat').researchEventVisible(ev, req.hubUser, isAdmin) });
    }

    // ── Worker Routes ───────────────────────────────────────────────
    // (GET /api/workers is the worker history across agents, handled above with /api/agents/<name>/workers.)
    if (pathname === '/api/cancel-worker' && req.method === 'POST') {
      // ⏹ Stop on a worker card. The page names the worker and the agent it belongs to (the caller); a member may stop
      // only calls of their own agents (the agent check above, then cancelWorker's).
      const body = JSON.parse(await readBody(req));
      const result = cancelWorker(body.worker_id || body.workerId, { agent: String(body.agent || ''), admin: !!req.hubService || access.isAdmin(req.hubUser) });
      return jsonResponse(res, result.success ? 200 : (result.status || 400), result);
    }

    // Hand-offs (lib/hand-offs): the jobs this agent handed to others, for the cards above its chat. The access check is the
    // route's (agent in the query, classified in lib/access like the chat history): an admin any agent, a member their own.
    if (pathname === '/api/hand-offs' && req.method === 'GET') {
      const name = agentFromQuery(req);
      if (!name || !(await getAgents()).some(a => a.name === name)) return jsonResponse(res, 404, { error: 'unknown agent' });
      // listShown: only this agent's own hand-offs, and no target's words where it may no longer reach that target
      const handOffs = await require('./lib/sdk-chat').getHandOffRunner().listShown(name, { includeDone: false, withStatus: false });
      return jsonResponse(res, 200, { ok: true, handOffs });   // no folderLink: the Files panel has no link that opens a folder
    }

    // Background work of one agent (lib/background-work): hand-offs it gave, its jobs (named for admins only), its temporary
    // workers, and the next check. Access is the route's (lib/access AGENT_PATH): an admin any agent, a member their own or shared.
    {
      const wm = pathname.match(/^\/api\/agents\/([^/]+)\/working-on$/);
      if (wm && req.method === 'GET') {
        let name = ''; try { name = decodeURIComponent(wm[1]); } catch {}
        // isAdmin from the trusted session (as /api/cancel-worker has it), never from the request
        const woAgents = await getAgents();
        const woAdmin = !!req.hubService || access.isAdmin(req.hubUser);
        // canSee: the hub's own rule for this person (a member reads only the words of agents they may see)
        const r = await require('./lib/background-work').workingOnResponse(name, { agentNames: woAgents.map(a => a.name), viewer: { isAdmin: woAdmin, canSee: (n) => woAdmin || access.canAccessAgent(req.hubUser, n, { agents: woAgents, resolveVirtual: (v) => temporalWorkersLib.getVirtual(v) }) } });
        return jsonResponse(res, r.status, r.body);
      }
    }

    // Deep research progress (lib/sdk-chat researchStatusFor): the active runs of ONE agent, for the line above its chat.
    // Signed-in only (the gate above); a person who may not see that agent gets the same 404 as an unknown one.
    if (pathname === '/api/research/status' && req.method === 'GET') {
      const name = agentFromQuery(req);
      const allAgents = await getAgents();
      if (!name || !allAgents.some(a => a.name === name)) return jsonResponse(res, 404, { error: 'unknown agent' });
      if (!req.hubService && !access.isAdmin(req.hubUser) && !access.canAccessAgent(req.hubUser, name, { agents: allAgents, resolveVirtual: (n) => temporalWorkersLib.getVirtual(n) })) return jsonResponse(res, 404, { error: 'unknown agent' });
      let runs = [];
      try { const fn = require('./lib/sdk-chat').researchStatusFor; if (typeof fn === 'function') runs = fn(name); } catch { runs = []; }
      return jsonResponse(res, 200, { runs: Array.isArray(runs) ? runs : [] });
    }
    // Stop a deep research run, or make an agent-started quick run thorough (lib/sdk-chat researchStop / researchUpgrade). Signed-in
    // by a person (the hub's own service calls are refused: 403); a run that does not exist and a run on an agent the person may
    // not use both answer the same 404. { ok, run } / { ok, run, newId }.
    if ((pathname === '/api/research/stop' || pathname === '/api/research/upgrade') && req.method === 'POST') {
      if (req.hubPendingTotp) return jsonResponse(res, 401, { error: 'Sign in first' });
      if (!req.hubUser) return jsonResponse(res, 403, { error: 'Sign in first.' });
      let body = {};
      try { body = JSON.parse(await readBody(req) || '{}') || {}; } catch { return jsonResponse(res, 400, { error: 'Bad request' }); }
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      if (!/^dr-[0-9a-f]{8}$/.test(id)) return jsonResponse(res, 400, { error: 'id must be the id of a research run' });
      const sdkChat = require('./lib/sdk-chat');
      const runAgent = sdkChat.researchRunAgent(id);
      if (!runAgent) return jsonResponse(res, 404, { error: 'No such research run.' });
      const allAgents = await getAgents();
      if (!access.isAdmin(req.hubUser) && !access.canAccessAgent(req.hubUser, runAgent, { agents: allAgents, resolveVirtual: (n) => temporalWorkersLib.getVirtual(n) })) return jsonResponse(res, 404, { error: 'No such research run.' });
      const by = req.hubUser.id != null ? String(req.hubUser.id).slice(0, 64) : 'person';
      const out = pathname === '/api/research/stop' ? sdkChat.researchStop(id, by) : sdkChat.researchUpgrade(id, by);
      if (!out.ok) return jsonResponse(res, out.status === 404 ? 404 : out.status === 409 ? 409 : 500, { error: out.error });
      return jsonResponse(res, 200, pathname === '/api/research/stop' ? { ok: true, run: out.run } : { ok: true, run: out.run, newId: out.newId });
    }
    // The daily limits on runs agents start without a person's yes, and today's count (admin only: the default class of this path).
    if (pathname === '/api/research/caps' && req.method === 'GET') {
      const sdkChat = require('./lib/sdk-chat');
      let out;
      try { out = sdkChat.researchCapsToday(); } catch {
        // the day's count can't be read: say so, never zeros
        let caps = { perAgent: 3, install: 10 };
        try { caps = sdkChat.researchAgentCaps(); } catch { /* the defaults */ }
        out = { caps, today: null, error: 'Could not read today\'s count.' };
      }
      return jsonResponse(res, 200, out);
    }

    // ── Session/History Routes ──────────────────────────────────────
    if (/^\/api\/history\/([^/]+)$/.test(pathname) && req.method === 'GET') {
      const name = pathname.split('/')[3];
      const hq = new URL(req.url, 'http://x').searchParams;
      if (hq.has('view') || hq.has('limit') || hq.has('before')) {
        // Paged, filtered history (lib/chat-history): the whole chat log, then the transcript archive behind it.
        if (hq.get('view') === 'run') {
          // One run of hub-started turns (the summary line's body): the same entries the all view shows for that time.
          const hubEvR = require('./lib/hub-events');
          const trR = require('./lib/transcript').getTranscript();
          try {
            const run = require('./lib/chat-history').runPage({
              logEntries: loadConversationLog(name, 0),
              archive: { rowsBefore: (o) => trR.rowsBefore(name, o), forOwnerTurns: (ids) => trR.forOwnerTurns(name, ids), lastMarkTs: (tool) => trR.lastMarkTs(name, tool) },
              from: hq.get('from'), to: hq.get('to'), rank: hq.get('rank'), turn: hq.has('turn') ? hq.get('turn') : null,
              inProgressMark: (entries) => hubEvR.markInProgress(entries, hubEvR.events.turnFor(name)),
            });
            return jsonResponse(res, 200, run.incomplete ? { history: [], more: false, incomplete: true } : { history: run.history, more: run.more, ...(run.partial ? { partial: true } : {}) });
          } catch (e) {
            if (e && e.message === 'bad_range') return jsonResponse(res, 400, { error: 'bad_range' });
            if (e && e.message === 'bad_turn') return jsonResponse(res, 400, { error: 'bad_turn' });
            throw e;
          }
        }
        const view = hq.get('view') === 'all' ? 'all' : 'main';
        const before = hq.get('before') || null;
        if (before !== null && !require('./lib/chat-history').parseCursor(before)) return jsonResponse(res, 400, { error: 'bad_cursor' });
        const hubEv = require('./lib/hub-events');
        const tr = require('./lib/transcript').getTranscript();
        const page = require('./lib/chat-history').historyPage({
          logEntries: loadConversationLog(name, 0),
          archive: { rowsBefore: (o) => tr.rowsBefore(name, o), forOwnerTurns: (ids) => tr.forOwnerTurns(name, ids), lastMarkTs: (tool) => tr.lastMarkTs(name, tool) },
          view, before, limit: hq.get('limit'),
          inProgressMark: (entries) => hubEv.markInProgress(entries, hubEv.events.turnFor(name)),
        });
        return jsonResponse(res, 200, { history: page.history, next: page.next, view });
      }
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
      const s = { ...hubSettings.getForUI() }; delete s.backup;   // backups have their own routes (and the key never leaves)
      return jsonResponse(res, 200, s);
    }

    // The settings records (templates/settings-records.json): every option's help and who may change it. Signed-in people;
    // members get only the records a member may see, and never the facts note or storage key (lib/settings-records).
    if (pathname === '/api/settings-records' && req.method === 'GET') {
      const isAdmin = access.isAdmin(req.hubUser) || !hubAuth.hasUsers();   // a hub without accounts has one person: the owner
      try { return jsonResponse(res, 200, require('./lib/settings-records').routeBody(req.hubUser || null, { isAdmin })); }
      catch (e) { console.warn('[settings-records]', e.message); return jsonResponse(res, 500, { error: 'settings records unavailable' }); }
    }

    // "Require two-factor sign-in for admins": a signed-in admin's own browser session only (no token, no service, no half-signed-in session).
    if (pathname === '/api/security/admin-2fa' && req.method === 'POST') {
      if (!(req.hubIdentKind === 'user' && !req.hubPendingTotp && !req.hubToken && !req.hubService && access.isAdmin(req.hubUser))) return jsonResponse(res, 403, { error: 'admin_only' });
      const b = await authJson(); if (!b) return jsonResponse(res, 400, { error: 'invalid JSON' });
      const r = admin2fa.setRequired({ actorId: req.hubUser.id, isAdmin: true, want: b.required, password: b.password, code: b.code, ip: req.socket && req.socket.remoteAddress });
      return r.ok ? jsonResponse(res, 200, { ok: true, required: r.required, changed: r.changed }) : jsonResponse(res, r.status, { error: r.error });
    }

    if (pathname === '/api/settings' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const patch = JSON.parse(body, (k, v) => (k === '__proto__' || k === 'constructor' || k === 'prototype') ? undefined : v);   // never a key that reaches a prototype
          // The wallet-agent list is not a UI setting: widening it hands signing tools to another agent. Owner edits data/settings.json by hand.
          // Backups (key, folders) change only through /api/backups/*, which asks for the password and two-factor code again.
          if (patch && typeof patch === 'object' && 'backup' in patch) { console.warn('[settings] ignored backup in /api/settings patch (use Settings → Backups)'); delete patch.backup; }
          if (patch && typeof patch === 'object' && 'walletAgents' in patch) { console.warn('[settings] ignored walletAgents in /api/settings patch (edit data/settings.json directly)'); delete patch.walletAgents; }
          // The owner's receiving address decides where wallet value may go: not a UI setting either (review F10). HUB_WALLET_OWNER in .env, or data/settings.json by hand.
          if (patch && typeof patch === 'object' && 'walletOwner' in patch) { console.warn('[settings] ignored walletOwner in /api/settings patch (set HUB_WALLET_OWNER or edit data/settings.json directly)'); delete patch.walletOwner; }
          // The admin two-factor rule changes only through /api/security/admin-2fa, which asks for the password (and code) again.
          if (patch && typeof patch === 'object' && 'requireAdmin2fa' in patch) { console.warn('[settings] ignored requireAdmin2fa in /api/settings patch (use Settings → Security)'); delete patch.requireAdmin2fa; }
          // receiverAliases makes paths public (lib/modules/receivers): set only by hand in data/settings.json.
          if (patch && typeof patch === 'object' && 'receiverAliases' in patch) { console.warn('[settings] ignored receiverAliases in /api/settings patch (edit data/settings.json directly)'); delete patch.receiverAliases; }
          // The command lockbox hub default (off | watch | enforce): a signed-in admin's own browser session only; a change is audited and told to the admins.
          const lockboxCheck = require('./lib/lockbox/settings').checkDefaultPatch(patch, req, (k) => hubSettings.getSetting(k));
          if (!lockboxCheck.ok) return jsonResponse(res, lockboxCheck.status, { error: lockboxCheck.error });
          const lockboxChange = lockboxCheck.change;
          // Hub default for every member agent: grantable classes and valid decisions only (lib/tool-policy).
          if (patch && patch.memberPolicy !== undefined) patch.memberPolicy = require('./lib/tool-policy').sanitizeGrants({ policy: patch.memberPolicy }).policy || {};
          // Per-class approval cards: known class names only (lib/policy-gate APPROVAL_CLASSES).
          if (patch && patch.approvalClasses !== undefined) { const ok = require('./lib/policy-gate').APPROVAL_CLASSES; patch.approvalClasses = Array.isArray(patch.approvalClasses) ? [...new Set(patch.approvalClasses.map(String).filter(c => ok.includes(c)))] : []; }
          // The look a new member starts with: one of the registry's ids (lib/ui-looks); anything else is refused.
          if (patch && typeof patch === 'object' && patch.lookDefaultForNewMembers !== undefined && !require('./lib/ui-looks').byId(patch.lookDefaultForNewMembers)) return jsonResponse(res, 400, { error: 'lookDefaultForNewMembers must be one of: ' + require('./lib/ui-looks').LOOKS.map(l => l.id).join(', ') });
          // Claude plan: warning levels, and the optional automatic switch (merged onto the stored policy, so its map survives).
          if (patch && patch.planWarn !== undefined) patch.planWarn = require('./lib/plan-usage').cleanWarn(patch.planWarn);
          if (patch && patch.notify !== undefined) patch.notify = require('./lib/push').cleanNotifySettings(patch.notify);
          if (patch && patch.openrouter !== undefined) patch.openrouter = require('./lib/openrouter').cleanOpenRouterSettings(patch.openrouter);
          if (patch && patch.planFallback !== undefined) patch.planFallback = require('./lib/plan-usage').cleanPolicy(patch.planFallback, hubSettings.getSetting('planFallback'));
          // The reasoning panel (lib/sdk-chat showReasoning): on unless turned off.
          // Share links: enabled, defaultHours, maxHours (hard maximum 168), merged onto the stored value (lib/share-links cleanSettings).
          if (patch && patch.shareLinks !== undefined) patch.shareLinks = require('./lib/share-links').cleanSettings(patch.shareLinks, hubSettings.getSetting('shareLinks'));
          if (patch && patch.showReasoning !== undefined) patch.showReasoning = patch.showReasoning !== false;
          if (patch && patch.modelOffers !== undefined) patch.modelOffers = patch.modelOffers !== false;
          // Deep research (lib/research): how often a person who chose Never is reminded that it is off, in days 0..365 (0 = never).
          if (patch && patch.researchReminderDays !== undefined) {
            const d = Number(patch.researchReminderDays);
            if (!Number.isInteger(d) || d < 0 || d > 365) return jsonResponse(res, 400, { error: 'researchReminderDays must be a whole number of days from 0 to 365' });
            patch.researchReminderDays = d;
          }
          // Deep research, how long a question waits for the person before a quick run starts by itself, in seconds 0..600 (0 = no card, start at once).
          if (patch && patch.researchOfferWaitSeconds !== undefined) {
            const v = patch.researchOfferWaitSeconds;
            const n = typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : v;
            if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 600) return jsonResponse(res, 400, { error: 'researchOfferWaitSeconds must be a whole number of seconds from 0 to 600' });
            patch.researchOfferWaitSeconds = n;
          }
          // Deep research started by agents without a yes: the daily limits per agent (0..100) and for the install (0..1000), 0 = no limit; merged onto the stored value.
          if (patch && patch.researchAgentCaps !== undefined) {
            const v = patch.researchAgentCaps;
            if (!v || typeof v !== 'object' || Array.isArray(v)) return jsonResponse(res, 400, { error: 'researchAgentCaps must be an object' });
            const ranges = { perAgent: [0, 100], install: [0, 1000] };
            const merged = { ...(hubSettings.getSetting('researchAgentCaps') || {}) };
            for (const [k, val] of Object.entries(v)) {
              if (!ranges[k]) return jsonResponse(res, 400, { error: `researchAgentCaps.${k} is not a setting` });
              const [lo, hi] = ranges[k];
              const n = typeof val === 'string' && /^\s*\d+\s*$/.test(val) ? Number(val) : val;
              if (typeof n !== 'number' || !Number.isInteger(n) || n < lo || n > hi) return jsonResponse(res, 400, { error: `researchAgentCaps.${k} must be a whole number from ${lo} to ${hi}` });
              merged[k] = n;
            }
            patch.researchAgentCaps = merged;
          }
          // Thorough deep research caps (admin): known fields only, each in its range (lib/research-thorough); merged onto the stored value.
          if (patch && patch.researchThorough !== undefined) {
            const v = patch.researchThorough;
            if (!v || typeof v !== 'object' || Array.isArray(v)) return jsonResponse(res, 400, { error: 'researchThorough must be an object' });
            const ranges = { maxSources: [1, 40], readersAtOnce: [1, 12], reviewRounds: [0, 5], timeLimitMinutes: [10, 240],
              leadSteps: [5, 300], leadWallMinutes: [10, 1440], leadReaderCalls: [1, 400], leadReviewRounds: [0, 50], leadTopicSearches: [0, 20], leadSourcesPerSub: [0, 20], leadTopNewPerSub: [0, 10], leadPdfMaxMB: [4, 64], leadReaderTextMax: [20000, 2000000], leadReaderTopTextMax: [20000, 2000000] };
            const modelKeys = ['leadModel', 'leadReaderModel', 'leadReaderTopModel'];
            const known = [...Object.keys(ranges), 'pdf', 'readerModel', 'engine', ...modelKeys];
            const merged = { ...(hubSettings.getSetting('researchThorough') || {}) };
            for (const [k, val] of Object.entries(v)) {
              if (!known.includes(k)) return jsonResponse(res, 400, { error: `researchThorough.${k} is not a setting` });
              if (ranges[k]) {
                const [lo, hi] = ranges[k];
                const n = typeof val === 'string' && /^\s*-?\d+\s*$/.test(val) ? Number(val) : val;
                if (typeof n !== 'number' || !Number.isInteger(n) || n < lo || n > hi) return jsonResponse(res, 400, { error: `researchThorough.${k} must be a whole number from ${lo} to ${hi}` });
                merged[k] = n;
              } else if (k === 'pdf') {
                if (typeof val !== 'boolean') return jsonResponse(res, 400, { error: 'researchThorough.pdf must be true or false' });
                merged[k] = val;
              } else if (k === 'engine') {
                if (val !== 'lead' && val !== 'pipeline') return jsonResponse(res, 400, { error: "researchThorough.engine must be 'lead' or 'pipeline'" });
                merged[k] = val;
              } else if (modelKeys.includes(k)) {
                if (typeof val !== 'string' || !(val === 'auto' || (val.length >= 1 && val.length <= 120 && /^[A-Za-z0-9._:/@[\]-]+$/.test(val)))) return jsonResponse(res, 400, { error: `researchThorough.${k} must be 'auto' or a model id` });
                merged[k] = val;
              } else {
                if (val !== 'own' && val !== 'helper') return jsonResponse(res, 400, { error: "researchThorough.readerModel must be 'own' or 'helper'" });
                merged[k] = val;
              }
            }
            patch.researchThorough = merged;
          }
          // Which search the research helpers use: their usual one (default) or also the hub's (a test option).
          if (patch && patch.researchHelperSearch !== undefined && patch.researchHelperSearch !== 'default' && patch.researchHelperSearch !== 'both') return jsonResponse(res, 400, { error: "researchHelperSearch must be 'default' or 'both'" });
          // Subscription usage (lib/codex-usage, Settings → Subscriptions): on unless turned off.
          if (patch && patch.subscriptionUsage !== undefined) patch.subscriptionUsage = patch.subscriptionUsage !== false;
          if (patch && patch.componentUpdates !== undefined) patch.componentUpdates = { codex: ['auto', 'notify', 'off'].includes(patch.componentUpdates && patch.componentUpdates.codex) ? patch.componentUpdates.codex : 'auto' };
          if (patch && patch.walletLockedNotice !== undefined) patch.walletLockedNotice = patch.walletLockedNotice !== false;
          // Workers allowed at once per AI service: integers 1..32 only (lib/provider-pacing); applied to the running hub below.
          if (patch && patch.workersAtOnce !== undefined) patch.workersAtOnce = require('./lib/provider-pacing').cleanWorkersAtOnce(patch.workersAtOnce);
          // Long waits on workers (lib/long-waits): minutes 0..240 (0 = off, junk = the default 10); the lead notice is on unless false.
          if (patch && patch.handOffWaitMinutes !== undefined) patch.handOffWaitMinutes = require('./lib/long-waits').cleanMinutes(patch.handOffWaitMinutes);
          if (patch && patch.buildPartnerNotice !== undefined) patch.buildPartnerNotice = patch.buildPartnerNotice !== false;
          // Sidebar sections that are off until switched on: true only for a real true.
          if (patch && patch.sidebarTigerTeam !== undefined) patch.sidebarTigerTeam = patch.sidebarTigerTeam === true;
          if (patch && patch.sidebarGuide !== undefined) patch.sidebarGuide = patch.sidebarGuide === true;
          if (patch && patch.sidebarTeams !== undefined) patch.sidebarTeams = patch.sidebarTeams !== false;   // the Teams tab is on unless switched off
          // Voice: known keys only, merged onto the stored value (lib/voice/manifest cleanVoiceSettings). "enabled" changes
          // only through /api/voice/enable and /disable, which also install the engines and stop or resume the worker.
          if (patch && patch.voice !== undefined) {
            const storedVoice = hubSettings.getSetting('voice');
            // updateSettings replaces the whole voice object, so an unset switch must stay absent from it (cleanVoicePatch).
            patch.voice = require('./lib/voice/manifest').cleanVoicePatch(patch.voice, storedVoice);
          }
          const providersChanged = !!(patch && patch.providers);
          hubSettings.updateSettings(patch);
          if (lockboxChange) {
            try { hubAuth.audit(String(req.hubUser.id), 'settings.lockboxDefault', lockboxChange, hubAuth.clientIp(req)); } catch {}
            try { Promise.resolve(require('./lib/push').getPush().notify({ title: 'Command lockbox changed', body: lockboxChange, tag: 'lockbox-change' }, { adminsOnly: true, kind: 'security' })).catch(() => {}); } catch {}
          }
          if (patch && patch.workersAtOnce !== undefined) getPacing().setCaps(hubSettings.getSetting('workersAtOnce'));
          // A new key or URL changes which models exist — rediscover now
          // rather than waiting for the 6-hour cycle.
          if (providersChanged) {
            runDiscovery({ again: true }).catch(e => console.error('[settings] Rediscovery failed:', e.message));
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

          if (provider === 'openrouter') {   // the free key check (account details), never a paid request
            const c = await require('./lib/openrouter').getOpenRouter().checkKey(testKey);
            return jsonResponse(res, 200, { ok: c.ok, status: c.status || (c.ok ? 200 : 0), ...(c.ok ? { remaining: c.remaining, freeTier: c.freeTier } : { error: c.error }) });
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

    // ── OpenRouter: the catalogue, the models the pickers offer, the privacy switch (Settings → OpenRouter) ──
    if (pathname === '/api/openrouter' && req.method === 'GET') {
      const or = require('./lib/openrouter').getOpenRouter();
      if (new URL(req.url, 'http://x').searchParams.get('refresh') === '1') await or.refresh({ force: true });
      else if (!or.catalog().length) await or.refresh();
      return jsonResponse(res, 200, { ok: true, ...or.view() });
    }
    if (pathname === '/api/openrouter' && req.method === 'POST') {
      const b = await authJson(); if (!b) return jsonResponse(res, 400, { error: 'invalid JSON' });
      const cur = hubSettings.get().openrouter || {};
      const next = { ...cur, ...require('./lib/openrouter').cleanOpenRouterSettings(b) };
      if (next.models === null) delete next.models;   // back to the default offer
      hubSettings.updateSettings({ openrouter: next });
      try { require('./lib/model-discovery').runDiscovery({ again: true }).catch(() => {}); } catch {}   // the pickers follow the new offer (a run already going may predate it: one more run)
      return jsonResponse(res, 200, { ok: true, ...require('./lib/openrouter').getOpenRouter().view() });
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

    // Put the local changes aside (git stash, never put back by the hub), then update. The old name "force-update" stays for pages opened before.
    if (pathname === '/api/git-sync/force-update' && req.method === 'POST') {
      const { runPutAsideUpdate } = require('./lib/git-sync');
      try {
        let body = {}; try { body = JSON.parse((await readBody(req)) || '{}') || {}; } catch {}
        return jsonResponse(res, 200, await runPutAsideUpdate({ channel: body && body.channel ? String(body.channel) : null }));
      } catch (e) {
        return jsonResponse(res, 500, { success: false, error: e.message });
      }
    }

    // Put the local changes aside without updating.
    if (pathname === '/api/git-sync/put-aside' && req.method === 'POST') {
      const { putAsideOnly } = require('./lib/git-sync');
      try {
        return jsonResponse(res, 200, await putAsideOnly());
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

    // ── Version (lib/hub-map versionInfo): the sidebar's version label and the About box. Any signed-in user (lib/access
    // SESSION_EXACT); not public, so a visitor cannot read which version (and so which known fixes) a hub has. ──
    if (pathname === '/api/version' && req.method === 'GET') {
      try { return jsonResponse(res, 200, require('./lib/hub-map').getHubMap().versionInfo()); }
      catch (e) { console.warn('[version] could not read the version:', e.message); return jsonResponse(res, 500, { error: 'Could not read the version' }); }   // no paths in the answer
    }

    // ── Update check (lib/update-check.js): the daily look at GitHub behind the "Update available" card. Admin
    // routes (lib/access classes every /api path not listed elsewhere as admin-only). ──
    if (pathname === '/api/update-check' && req.method === 'GET') {
      try { return jsonResponse(res, 200, await require('./lib/update-check').getUpdateCheck().status(req.hubUser)); }
      catch (e) { return jsonResponse(res, 500, { error: e.message }); }
    }

    // ── Backups (lib/backup): admin only. Restoring, undoing and downloading ask for the password and two-factor code
    // again (stepUp). The Welcome-page restore further below is for a fresh install with no account yet. ──
    if (pathname === '/api/backups' || pathname.startsWith('/api/backups/')) {
      if (!access.isAdmin(req.hubUser) || req.hubPendingTotp) return jsonResponse(res, 403, { error: 'admin_only' });
      const svc = backupService();
      const body = async () => { try { return JSON.parse((await readBody(req)) || '{}'); } catch { return {}; } };
      const stepUp = (b) => accountStepUp(req.hubUser, b, req.socket && req.socket.remoteAddress);
      try {
        if (pathname === '/api/backups' && req.method === 'GET') { const st = svc.status(); const sch = require('./lib/backup/schedule').current(); return jsonResponse(res, 200, { ...st, nightly: sch ? sch.info(st) : null, backups: await svc.list() }); }
        // Nightly backups: turning them off or keeping fewer would let older backups go, so the step-up first
        if (pathname === '/api/backups/schedule' && req.method === 'POST') {
          const b = await body(); const no = stepUp(b); if (no) return jsonResponse(res, 403, { error: no });
          const v = svc.setSchedule(b.schedule);
          const sch = require('./lib/backup/schedule').current(); if (sch) sch.rescheduled();
          return jsonResponse(res, 200, { schedule: v, nightly: sch ? sch.info() : null });
        }
        // Choosing the backup key and where copies go decides who can read everything: the step-up first, every time
        if (pathname === '/api/backups/setup' && req.method === 'POST') {
          const b = await body(); const no = stepUp(b); if (no) return jsonResponse(res, 403, { error: no });
          const made = await svc.setup(b.newBackupPassword || b.newPassword, { replace: b.replace === true });
          return jsonResponse(res, 200, { keyId: made.keyId });   // the recovery key stays out of the answer: Settings shows it on request
        }
        if (pathname === '/api/backups/recovery' && req.method === 'GET') { const st = svc.status(); return jsonResponse(res, 200, { recovery: st.recovery, lastRestore: st.lastRestore }); }
        if (pathname === '/api/backups/folders' && req.method === 'POST') {
          const b = await body(); const no = stepUp(b); if (no) return jsonResponse(res, 403, { error: no });
          return jsonResponse(res, 200, { folders: svc.setFolders(b.folders, { create: !!b.create }) });
        }
        if (pathname === '/api/backups/run' && req.method === 'POST') { const b = await body(); return jsonResponse(res, 200, await svc.backupNow({ now: !!b.now, reason: 'manual' })); }
        if (pathname === '/api/backups/upload' && req.method === 'POST') { const q = new URL(req.url, 'http://x').searchParams; return jsonResponse(res, 200, await svc.acceptUpload(req, { expected: Number(req.headers['content-length']) || 0, uploadId: q.get('id') || null, offset: Number(q.get('offset') || 0), done: q.get('done') !== '0' })); }
        if (pathname === '/api/backups/restore/prepare' && req.method === 'POST') { const b = await body(); return jsonResponse(res, 200, await svc.prepareRestore({ name: b.name, uploadId: b.uploadId, password: b.backupPassword, recoveryKey: b.recoveryKey, mode: 'existing' })); }
        if (pathname === '/api/backups/restore/confirm' && req.method === 'POST') {
          const b = await body();
          if (b.confirm !== 'RESTORE') return jsonResponse(res, 400, { error: 'Type RESTORE to confirm.' });
          const no = stepUp(b); if (no) return jsonResponse(res, 403, { error: no });
          return jsonResponse(res, 200, { ...(await svc.confirmRestore({ id: b.id })), restarting: true });
        }
        if (pathname === '/api/backups/restore/cancel' && req.method === 'POST') return jsonResponse(res, 200, { ok: await svc.cancelRestore() });
        if (pathname === '/api/backups/undo' && req.method === 'POST') { const b = await body(); const no = stepUp(b); if (no) return jsonResponse(res, 403, { error: no }); return jsonResponse(res, 200, { ...(await svc.undo()), restarting: true }); }
        // The backup password and key: the account password and two-factor code again, then the backup secrets
        if (pathname === '/api/backups/password' && req.method === 'POST') {
          const b = await body(); const no = stepUp(b); if (no) return jsonResponse(res, 403, { error: no });
          return jsonResponse(res, 200, await svc.changePassword({ password: b.backupPassword, recoveryKey: b.recoveryKey, newPassword: b.newBackupPassword }));
        }
        if (pathname === '/api/backups/rotate' && req.method === 'POST') {
          const b = await body(); const no = stepUp(b); if (no) return jsonResponse(res, 403, { error: no });
          const r = await svc.startRotation({ password: b.backupPassword, recoveryKey: b.recoveryKey, newPassword: b.newBackupPassword });
          const ticket = require('crypto').randomBytes(18).toString('hex');
          rotationTickets.set(ticket, { user: req.hubUser.id, until: Date.now() + 10 * 60 * 1000 });
          return jsonResponse(res, 200, { ...r, ticket });
        }
        if (pathname === '/api/backups/recovery-key' && req.method === 'POST') {
          const b = await body(); const no = stepUp(b); if (no) return jsonResponse(res, 403, { error: no });
          return jsonResponse(res, 200, await svc.recoveryKey({ password: b.backupPassword }));
        }
        if (pathname === '/api/backups/rotate/finish' && req.method === 'POST') {
          const b = await body();
          // the ticket from step one (same admin, 10 minutes) stands in for the step-up; it is used up only by a finish that worked
          const t = b.ticket ? rotationTickets.get(String(b.ticket)) : null;
          const ticketOk = !!(t && t.user === req.hubUser.id && t.until > Date.now());
          if (!ticketOk) { const no = stepUp(b); if (no) return jsonResponse(res, 403, { error: no, stepUp: true }); }
          const out = await svc.finishRotation({ oldPassword: b.oldBackupPassword, oldRecoveryKey: b.oldRecoveryKey, newPassword: b.newBackupPassword, action: b.action });
          if (ticketOk) rotationTickets.delete(String(b.ticket));
          return jsonResponse(res, 200, out);
        }
        if (pathname === '/api/backups/recovery/resume' && req.method === 'POST') return jsonResponse(res, 200, { resumed: svc.resume() });
        if (pathname === '/api/backups/recovery/decide' && req.method === 'POST') { const b = await body(); return jsonResponse(res, 200, svc.decide(b.id, b.action)); }
        if (pathname === '/api/backups/download-link' && req.method === 'POST') {
          const b = await body(); const no = stepUp(b); if (no) return jsonResponse(res, 403, { error: no });
          const file = svc.filePath(b.name);
          const token = require('crypto').randomBytes(18).toString('hex');
          backupDownloads.set(token, { file, name: b.name, user: req.hubUser.id, until: Date.now() + 120000 });
          return jsonResponse(res, 200, { url: `/api/backups/file/${token}` });
        }
        const dl = /^\/api\/backups\/file\/([0-9a-f]{36})$/.exec(pathname);
        if (dl && req.method === 'GET') {
          const t = backupDownloads.get(dl[1]); backupDownloads.delete(dl[1]);
          if (!t || t.until < Date.now() || t.user !== req.hubUser.id) return jsonResponse(res, 404, { error: 'That download link has expired.' });
          let st; try { st = fs.lstatSync(t.file); } catch { st = null; }
          if (!st || !st.isFile()) return jsonResponse(res, 404, { error: 'That backup is gone.' });
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Content-Disposition': `attachment; filename="${t.name}"`, 'Cache-Control': 'no-store' });
          return require('stream').pipeline(fs.createReadStream(t.file), res, () => {});
        }
        return jsonResponse(res, 404, { error: 'not found' });
      } catch (e) { return jsonResponse(res, e.code === 'EBUSY' ? 409 : 400, { error: e.message, code: e.code || null }); }
    }
    // The Welcome-page restore: only while no account exists, and only with the installer's one-time setup code.
    if (pathname.startsWith('/api/welcome/restore/') && req.method === 'POST') {
      const welcome = require('./lib/welcome').createWelcome({ dataDir: path.join(__dirname, 'data') });
      if (hubAuth.hasUsers()) return jsonResponse(res, 403, { error: 'This My Maestro is already set up. Restore from Settings → Backups instead.' });
      // the setup code comes in a header and is checked before any body is read
      if (!welcome.checkSetupToken(String(req.headers['x-setup-token'] || ''))) return jsonResponse(res, 403, { error: 'setup_code' });
      const svc = backupService();
      try {
        if (pathname === '/api/welcome/restore/upload') {
          const q = new URL(req.url, 'http://x').searchParams;
          return jsonResponse(res, 200, await svc.acceptUpload(req, { expected: Number(req.headers['content-length']) || 0, uploadId: q.get('id') || null, offset: Number(q.get('offset') || 0), done: q.get('done') !== '0' }));
        }
        let b = {}; try { b = JSON.parse((await readBody(req)) || '{}'); } catch {}
        if (pathname === '/api/welcome/restore/prepare') return jsonResponse(res, 200, await svc.prepareRestore({ uploadId: b.uploadId, password: b.backupPassword, recoveryKey: b.recoveryKey, mode: 'fresh' }));
        if (pathname === '/api/welcome/restore/confirm') {
          if (b.confirm !== 'RESTORE') return jsonResponse(res, 400, { error: 'Type RESTORE to confirm.' });
          const who = svc.checkStagedAdmin({ login: b.login, password: b.password, code: b.code });
          return jsonResponse(res, 200, { ...(await svc.confirmRestore({ id: b.id })), restarting: true, signInAs: who.login });
        }
        return jsonResponse(res, 404, { error: 'not found' });
      } catch (e) { return jsonResponse(res, 400, { error: e.message, code: e.code || null }); }
    }
    if (pathname === '/api/update-check/now' && req.method === 'POST') {
      try { const uc = require('./lib/update-check').getUpdateCheck(); await uc.check({ reason: 'manual' }); return jsonResponse(res, 200, await uc.status(req.hubUser)); }
      catch (e) { return jsonResponse(res, 500, { error: e.message }); }
    }
    if (pathname === '/api/update-check/later' && req.method === 'POST') {
      let body = {}; try { body = JSON.parse((await readBody(req)) || '{}') || {}; } catch {}
      // Later names the version the card showed; without it a newer version found meanwhile could be hidden unseen.
      const remote = body && typeof body.remote === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(body.remote) ? body.remote : null;
      if (!remote) return jsonResponse(res, 400, { error: 'remote (the commit the card shows) is required' });
      try { return jsonResponse(res, 200, await require('./lib/update-check').getUpdateCheck().later(req.hubUser, remote)); }
      catch (e) { return jsonResponse(res, 500, { error: e.message }); }
    }
    if (pathname === '/api/update-check/settings' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}') || {}; } catch { return jsonResponse(res, 400, { error: 'invalid JSON' }); }
      if (typeof body.enabled !== 'boolean') return jsonResponse(res, 400, { error: 'enabled must be true or false' });
      try {
        const settingsLib = require('./lib/settings');
        settingsLib.updateSettings({ updateCheck: { ...(settingsLib.getSetting('updateCheck', {}) || {}), enabled: body.enabled } });
        const uc = require('./lib/update-check').getUpdateCheck();
        uc.start();
        return jsonResponse(res, 200, await uc.status(req.hubUser));
      } catch (e) { return jsonResponse(res, 500, { error: e.message }); }
    }

    // ── Manual restart via UI button ──
    if (pathname === '/api/restart' && req.method === 'POST') {
      // Jobs that would stop with the restart (no systemd scope): without { confirm: true } answer with the list, restart nothing.
      let restartBody = {}; try { restartBody = JSON.parse((await readBody(req)) || '{}') || {}; } catch {}
      const gate = require('./lib/jobs').restartGate(getJobRunner(), restartBody);
      if (gate) return jsonResponse(res, 409, gate);
      // The confirmation covered the jobs running now: no new job may start until this process exits.
      const attempt = require('crypto').randomUUID();   // admission belongs to this attempt: an earlier one never re-opens a later one
      getJobRunner().refuseNewJobs(attempt);
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
      if (r.error) { getJobRunner().allowNewJobs(attempt); return jsonResponse(res, 500, { error: r.error }); }
      // Admission stays closed until this process exits; no timer re-opens it.
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
      if ((!session_id && !body.tiger_team_id) || !message) return jsonResponse(res, 400, { error: 'Missing tiger_team_id or message' });
      if (!global.__tigerTeamSessions) global.__tigerTeamSessions = {};
      // A page names its team (tiger_team_id); older pages name the session that started it.
      const session = global.__tigerTeamSessions[session_id] || null;
      const ttId = ttTeamOf(body);
      if (!session && !ttId) return jsonResponse(res, 404, { error: 'Session not found' });
      const state = ttId && getTigerTeamState(ttId);
      if (!state) return jsonResponse(res, 409, { error: 'Team is still starting.  Retry after it is ready.' });
      // A team that has ended (completed, stopped, failed, interrupted) has nobody to hear it: Continue or Resume it instead.
      if (state.completedAt) return jsonResponse(res, 409, { error: 'This team is not running.' });
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
      if (target === 'team' || target === 'coordinator') { ttRecovery.queueDirective(ttStore, ttId, state, message); delivered.push({ agent: state.coordinator, how: 'queued' }); }
      // The label names who it is for: the whole team, or the one member it was sent to.
      let addressee = 'the whole team';
      if (target !== 'team') {
        let display = target;
        try { const found = (await getAgents()).find(a => a.name === target); if (found && found.display) display = found.display; } catch {}
        addressee = display;
      }
      for (const agent of live) { const r = ttInterject({ agent, message: `[Interjection from the war room, addressed to ${addressee}]: ${message}` }); if (r.success) delivered.push({ agent, how: 'live' }); }
      try { ttStore.append(ttId, state, { type: 'tt_interjection', message, target, delivered, at: new Date().toISOString() }); } catch {}
      console.log(`[tiger-team] interjection for ${ttId} (${target}): ${delivered.map(d => `${d.agent}:${d.how}`).join(', ') || 'nobody'}`);
      // Every page on this team sees the interjection (and a page that replays later draws it too).
      const frame = `data: ${JSON.stringify({ gateway: { type: 'tt_user_message', message, target, delivered } })}\n\n`;
      const stream = ttLive.get(ttId);
      try {
        if (stream) stream.write(frame);
        else if (session && session.res && !session.res.destroyed && !session.res.writableEnded) session.res.write(frame);
      } catch {}
      return jsonResponse(res, 200, { ok: true, target, delivered, queued: (state.pendingMessages || []).length });
    }

    // Tiger Team update participants
    if (pathname === '/api/tiger-team/update-participants' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const { participants } = body;
      if (!Array.isArray(participants)) return jsonResponse(res, 400, { error: 'participants must be an array' });
      // Update the active Tiger Team state in sdk-chat
      const { updateTigerTeamParticipants } = require('./lib/sdk-chat');
      const updated = updateTigerTeamParticipants(participants, ttTeamOf(body));
      if (!updated) return jsonResponse(res, 404, { error: 'No active Tiger Team found' });
      return jsonResponse(res, 200, { ok: true, participants });
    }

    // Tiger Team stop
    if (pathname === '/api/tiger-team/stop' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const { session_id } = body;
      if (!global.__tigerTeamSessions) global.__tigerTeamSessions = {};
      // A page names its team (tiger_team_id, which works after a reload too); older pages name their session.
      const session = global.__tigerTeamSessions[session_id] || null;
      const ttId = ttTeamOf(body);
      if (!session && !ttId) return jsonResponse(res, 404, { error: 'Session not found' });
      if (session) session.stopped = true;
      // Target ONLY this team, not every running TT - stopTigerTeam(null) previously killed every concurrent
      // investigation. The run then ends itself and tells every attached page (tt_interrupted, status stopped).
      let stopped = true;
      if (ttId) {
        for (const s of Object.values(global.__tigerTeamSessions)) if (s.tigerTeamId === ttId) s.stopped = true;
        stopped = stopTigerTeam(ttId);
      } else session.abortController?.abort();
      if (!stopped) return jsonResponse(res, 409, { error: 'This team has already ended.' });
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
      const liveStream = ttLive.get(state.id);
      return jsonResponse(res, 200, {
        id: state.id,
        status: state.status,
        error: state.error,
        unresolved: ttRecovery.unresolved(state),
        completedAt: state.completedAt,
        objective: (state.objective || '').slice(0, 300),
        coordinator: state.coordinator,
        participants: state.participants,
        challenger: state.challenger || '',
        mode: state.mode,
        // Live replay: a page follows the team with /api/tiger-team/stream (has_stream: its events were journaled).
        live: !!liveStream, viewers: liveStream ? liveStream.viewerCount : 0,
        has_stream: !!(state.hasStream || liveStream), last_seq: state.eventSeq || 0,
        team_folder: state.teamFolder || null,
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
      // As at start: the run writes to the team's stream and this page is one viewer of it, so closing the page
      // leaves the team working. The new events continue the team's journal after the ones already there.
      const stream = ttNewStream().bind(id);
      try {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('data: ' + JSON.stringify({ gateway: { type: 'tt_session', session_id: sessionId } }) + '\n\n');
        stream.attach(res);
        if (resume && !state.legacyRecovery) {
          // An optional note rides along: queued for the coordinator like an interjection (durable, picked up before its next model call).
          if (typeof message === 'string' && message.trim()) {
            ttRecovery.queueDirective(ttStore, id, state, message.trim());
            stream.write('data: ' + JSON.stringify({ gateway: { type: 'tt_user_message', message: message.trim(), target: 'coordinator', kind: 'resume_note', delivered: [{ agent: state.coordinator, how: 'queued' }] } }) + '\n\n');
          }
          await resumeTigerTeam(id, stream, session);
        } else {
          if (resume) {
            stream.write('data: ' + JSON.stringify({ gateway: { type: 'tt_notice', message: 'Legacy save: recovering from transcript only.  In-flight tool outcomes are unknown and must be verified before repeating actions.' } }) + '\n\n');
            const note = typeof message === 'string' && message.trim() ? `\n\nA note from the owner: ${message.trim()}` : '';
            message = 'Resume the interrupted investigation using the saved findings.  Do not repeat completed work.  This is a legacy transcript without a tool journal: verify uncertain actions using read-only checks before repeating anything that changes state.' + note;
          }
          await continueTigerTeam(id, message, stream);
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
        stream.write('data: ' + JSON.stringify({ gateway: { type: 'tt_interrupted', message: e.message } }) + '\n\n');
      } finally {
        state.apiReserved = false;
        const current = getTigerTeamState(id);
        if (current) current.apiReserved = false;
        delete global.__tigerTeamSessions[sessionId];
        stream.end();   // [DONE] to every page still attached, this one included
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

      // The team runs on its own stream; this page is only its first viewer. Closing, reloading or losing the page
      // no longer stops the team (it used to, eight seconds after the page went away): the page re-attaches through
      // /api/tiger-team/stream and replays what it missed. Only Stop ends a team early.
      const stream = ttNewStream();
      stream.attach(res);

      // Send session ID to client (this page only: not part of the team's journal)
      if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify({ gateway: { type: 'tt_session', session_id: sessionId } })}\n\n`);

      try {
        let result;
        if (mode === 'roundtable') {
          result = await runRoundtable(
            { objective, coordinator, participants: effectiveParticipants, max_rounds: max_rounds || 3, context: context || '', session },
            stream
          );
        } else {
          result = await runTigerTeam(
            { objective, coordinator, participants: effectiveParticipants, max_rounds, context: context || '', challenger: challenger || '', challengerDirective: challengerDirective || '', directives: directives || {}, session },
            stream,
            'tiger-team-ui'
          );
        }
        // A run that got going reports its own end (tt_complete or tt_interrupted). Only a refusal before it
        // started (an unknown agent) comes back as text with no team behind it.
        const runState = session.tigerTeamId ? getTigerTeamState(session.tigerTeamId) : null;
        if (!runState && typeof result === 'string' && /^(Error:|Tiger Team failed:)/.test(result)) {
          console.error('[tiger-team-api] Validation error:', result);
          stream.write(`data: ${JSON.stringify({ gateway: { type: 'tt_error', message: result } })}\n\n`);
        } else if (runState && runState.status !== 'completed') {
          console.log(`[tiger-team-api] ${session.tigerTeamId} ended ${runState.status}${runState.error ? `: ${runState.error}` : ''}`);
        }
      } catch (e) {
        console.error('[tiger-team-api] Error:', e.message);
        stream.write(`data: ${JSON.stringify({ gateway: { type: 'tt_error', message: e.message } })}\n\n`);
      } finally {
        session.stopped = true;
        delete global.__tigerTeamSessions[sessionId];
        stream.end();   // [DONE] to every page still attached, this one included
        // Stop may already have ended this response.  Guard writes explicitly;
        // write-after-end emits an asynchronous error that try/catch cannot catch.
        try {
          if (!res.destroyed && !res.writableEnded) res.write('data: [DONE]\n\n');
          if (!res.destroyed && !res.writableEnded) res.end();
        } catch {}
      }
      return;
    }

    // Follow a team from any page: replay its journaled events after ?since=<tt_seq>, then stay attached while it
    // runs. A team from before the stream journal answers 404 { legacy: true } and the page shows its saved transcript.
    if (pathname === '/api/tiger-team/stream' && req.method === 'GET') {
      const params = new URL(req.url, 'http://127.0.0.1').searchParams;
      const id = params.get('id');
      const since = Math.max(0, Math.trunc(Number(params.get('since')) || 0));
      if (!ttValidId(id)) return jsonResponse(res, 400, { error: 'Missing or invalid id' });
      const state = getTigerTeamState(id);
      if (!state) return jsonResponse(res, 404, { error: 'Tiger Team not found' });
      const live = ttLive.get(id);
      if (!state.hasStream && !live) return jsonResponse(res, 404, { error: 'This team was saved before live replay existed', legacy: true });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      // A running team: attach first, holding its new events for this page, and note where the journal ends at that
      // moment (all synchronous, so nothing falls between). Then replay up to there at the connection's pace, then
      // send what was held and follow live. No event is lost or repeated, and a slow page never piles up memory.
      const following = !!(live && live.attach(res, { hold: true }));
      const until = following ? (state.eventSeq || 0) : Infinity;
      try { await ttLive.replay(ttStore, id, res, since, until); }
      catch (e) { if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify({ gateway: { type: 'tt_notice', message: 'Part of this team\'s history could not be read: ' + e.message } })}\n\n`); }
      if (following) { await live.release(res); return; }
      if (res.destroyed || res.writableEnded) return;
      // Not running: say how it ended, for runs that stopped without a final event (a hub restart mid-run).
      res.write(`data: ${JSON.stringify({ gateway: { type: 'tt_state', status: state.status, error: state.error || null, unresolved: ttRecovery.unresolved(state).length } })}\n\n`);
      res.write('data: [DONE]\n\n'); res.end();
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
    } else if (pathname === '/changes') {
      filePath = path.join(__dirname, 'changes.html');   // admin page (lib/access ADMIN_PAGES)
    } else if (pathname === '/recordings') {
      filePath = path.join(__dirname, 'recordings.html');   // any signed-in user may load the page; the data routes refuse anyone not on an agent's list
    } else if (/^\/oauth\/callback\/[a-z][a-z0-9-]{1,31}$/.test(pathname)) {
      // A data connector's sign-in comes back here (lib/modules signinCallback). A signed-in admin only, never the hub service or a token.
      const id = pathname.split('/')[3];
      const q = new URL(req.url, 'http://x').searchParams;
      const CODES = ['state', 'user', 'expired', 'declined', 'exchange', 'other'];
      const back = (ok, code) => {
        const loc = ok ? `/modules?signin=ok#${id}` : `/modules?signin=error&code=${CODES.includes(code) ? code : 'other'}#${id}`;
        res.writeHead(302, { Location: loc, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); return res.end();
      };
      if (req.hubService || req.hubToken || !req.hubUser || req.hubPendingTotp) { res.writeHead(302, { Location: `/login?next=${encodeURIComponent('/modules')}` }); return res.end(); }
      if (!access.isAdmin(req.hubUser)) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Only an admin can finish this sign-in.'); }
      try {
        const str = (k) => { const v = q.get(k); return v === null ? undefined : v; };
        await require('./lib/modules').getModules().signinCallback(id, { code: str('code'), state: str('state'), error: str('error') }, { userId: req.hubUser.id });
        return back(true);
      } catch (e) { return back(false, e && e.signinCode); }
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
      if (pathname === '/login' || pathname === '/invite') headers['Referrer-Policy'] = 'no-referrer';   // a share link's token rides in ?next=: it never goes to another site
      res.writeHead(200, headers);
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // 404
    jsonResponse(res, 404, { error: 'Not found' });

  } catch (err) {
    console.error(`[server] ${req.method} ${redactShareToken(pathname)}: ${redactShareToken(err.message)}`);
    if (!res.headersSent) {
      jsonResponse(res, 500, { error: err.message });
    }
  }
}

// ── Start ───────────────────────────────────────────────────────────────

// "Protect your Maestro's own code" (lib/code-protect): the policy asks this server's instance, which reads the owner's
// choice (behaviour change 'protect-own-code'). Registered before any agent can run.
try { require('./lib/tool-policy').setCodeProtectProvider(() => require('./lib/code-protect').getCodeProtect()); }
catch (e) { console.error('[code-protect] could not register:', e.message); }

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
  const refreshed = require('./lib/agents').refreshShippedWorkspaceFiles();   // unedited copies of improved playbooks
  if (refreshed.length) console.log(`[workspaces] Updated to this version (they had not been changed): ${refreshed.join(', ')}`);
} catch (e) { console.warn('[workspaces] Template seeding failed:', e.message); }

// Shared secret for POST /api/chat/alert (data/alert-secret, mode 0600, created once).
try { ensureAlertSecret(); } catch (e) { console.warn('[alert] Could not create alert secret:', e.message); }
// data/ holds every secret the hub keeps; a fresh install creates it with the shell's umask (often 775). Private, always.
try { fs.chmodSync(path.join(__dirname, 'data'), 0o700); } catch {}

try { require('./lib/push').getPush().start(require('./lib/hub-events').events); } catch (e) { console.error('[push] not started:', e.message); }

server.listen(PORT, HOST, () => {
  // The conversation archive of earlier versions (one file for every agent) is split into one file per agent, once.
  // Only now: this process holds the port, so no older hub on it is still writing; and first, before any turn can
  // write (lib/transcript splitCombined; the old file is kept as transcript.db.pre-split).
  try { require('./lib/transcript').getTranscript().migrate(); } catch (e) { console.error('[transcript] split not run:', e.message); }
  // A hub restart during the voice download leaves the setting on and nothing installing: pick the install up again.
  setTimeout(() => { try { if (process.env.NODE_TEST_CONTEXT || process.env.MM_TEST_NO_REAL_CLAUDE === '1' || process.env.MM_VOICE_NO_AUTO_INSTALL === '1') return; require('./lib/voice/routes').resumeIfNeeded({ getSetting: hubSettings.getSetting, log: (m) => console.log(m) }); } catch (e) { console.error('[voice] resume:', e.message); } }, 10000).unref();
  // Voice is on by default: about 20 s after the start, fetch the speech engines when they are missing (never under tests; never when voice was turned off).
  setTimeout(() => {
    try {
      if (process.env.NODE_TEST_CONTEXT || process.env.MM_TEST_NO_REAL_CLAUDE === '1' || process.env.MM_VOICE_NO_AUTO_INSTALL === '1') return;
      const vr = require('./lib/voice/routes');
      vr.ensureEngines({ engine: vr.getVoice().engine, getSetting: hubSettings.getSetting, now: Date.now, log: (m) => console.log(m) });
    } catch (e) { console.error('[voice] auto install:', e.message); }
  }, 20000).unref();
  // After a restart the Remote computers module may still hold desktop sessions this hub no longer knows; they block agent input until ended.
  // Once, 30 s after the start (the module is up by then), only while the module is on; never throws.
  setTimeout(() => {
    try {
      if (!require('./lib/modules').getModules().detail('remote-computers').enabled) return;
      remoteDesktop().reconcile().catch(() => {});
    } catch { /* the Computers box ends them when it is opened */ }
  }, 30000).unref();
  // A restored setup that has run for 30 s counts as healthy: its 7-day undo clock starts (lib/backup/apply).
  setTimeout(() => { try { if (require('./lib/backup/apply').markHealthy({ root: __dirname })) console.log('[restore] the restored setup started fine; it can be undone for 7 days'); } catch (e) { console.error('[restore]', e.message); } }, 30000).unref();
  // once a day: set-aside copies past their 7 days, a checked restore nobody confirmed, old uploads (not only at a start)
  setInterval(() => { backupService().pruneDaily().catch((e) => console.error('[restore] cleanup:', e.message)); }, 24 * 3600 * 1000).unref();
  // Nightly backups at the set time in the owner's zone, the keep rules after each, and a warning to the admins' phones
  // when one fails or none was made for 3 days (lib/backup/schedule). Nothing runs until backups are set up.
  try {
    require('./lib/backup/schedule').createScheduler({ service: backupService(), root: __dirname, zone: () => require('./lib/timezone').hubZone(),
      notify: (p) => require('./lib/push').getPush().notifyEach(p, { adminsOnly: true, urgency: 'high', kind: 'security' }), log: (m) => console.log(m) }).start();   // data safety: a security notice
  } catch (e) { console.error('[backup] nightly backups not started:', e.message); }
  // Maestro is the lead agent. New installs are seeded with the mark; an older install that marks no lead (and so
  // counted every admin-side primary agent as one) gets maestro marked once (lib/agents ensureMaestroLead). It runs
  // here, once this process owns the port, so a second copy started on the same data never gets this far; it is
  // synchronous, so no request is handled before it finishes.
  try {
    if (require('./lib/agents').ensureMaestroLead().changed) console.log('[agents] marked maestro as the lead agent (no agent was marked)');
  } catch (e) { console.warn('[agents] could not mark the lead agent:', e.message); }
  // Team guidance (lib/team-guidance): agents that existed before this update keep their old prompt (switched off once); lead agents get it.
  try {
    const tg = require('./lib/agents').migrateTeamGuidance();
    if (tg.changed > 0) console.log(`[agents] team guidance switched off for ${tg.changed} agents that existed before this update (lead agents keep it)`);
  } catch (e) { console.warn('[agents] could not migrate team guidance:', e.message); }
  // Behaviour changes (lib/behaviour-changes): on an install that already has agents each one waits, off, for the owner's decision.
  try {
    const bm = require('./lib/behaviour-changes').migrate({ agentsFile: path.join(__dirname, 'data', 'agents.json') });
    if (bm.added && bm.added.length) console.log(`[behaviour] ${bm.added.length} change(s) waiting for the owner's decision: ${bm.added.join(', ')}`);
  } catch (e) { console.warn('[behaviour] could not check the behaviour changes:', e.message); }
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

  // Memory health: a look at every agent's memory each night (Settings → Status → Memory); HUB_MEMORY_HEALTH=off turns
  // the nightly check off (Check now still works).
  try { if (process.env.HUB_MEMORY_HEALTH !== 'off') require('./lib/memory-health').getMemoryHealth().schedule(); }
  catch (e) { console.warn(`[memory-health] ${e.message}`); }
  // Health check (lib/system-health): the computer itself (disk, memory, databases, backups, sign-ins...) a minute after
  // each start and each night; it only reports. The backup facts come from this server's backup service and scheduler.
  try {
    require('./lib/system-health/wire').init({
      backupState: () => {
        const st = backupService().status();
        if (!st.key || !st.key.configured || st.needsPassword || (st.recovery && !st.recovery.resumedAt)) return null;   // not set up or paused: the backup page's own item says so
        const sched = require('./lib/backup/schedule').current();
        const lastOk = Math.max(Date.parse(st.last && st.last.created) || 0, Date.parse(sched && sched.info(st).lastOkAt) || 0);
        return { enabled: !!(st.schedule && st.schedule.enabled), lastOkAt: lastOk ? new Date(lastOk).toISOString() : null, setUpAt: st.key.createdAt || null };
      },
      backupFolders: () => (backupService().status().folders || []).map(f => (typeof f === 'string' ? f : f && f.dir)).filter(Boolean),
    }).start();
  } catch (e) { console.warn(`[health] ${e.message}`); }
  // Self-check: real turns on hidden check agents 60 s after start and each night (Settings → Status → Self-check);
  // HUB_SELFCHECK=off turns both off (Run now still works). Never delays startup.
  try { if (process.env.HUB_SELFCHECK !== 'off') { const sc = require('./lib/selfcheck').getSelfCheck(); sc.onStarted(); sc.schedule(); } }
  catch (e) { console.warn(`[selfcheck] ${e.message}`); }
  // Data connector health: a nightly check of every switched-on module that declares one (lib/modules/health).
  try { require('./lib/modules/health').getModulesHealth().start(); }
  catch (e) { console.warn(`[modules-health] ${e.message}`); }
  // Background modules (those that receive webhooks or poll) start a few seconds later.
  // The module list is loaded first: its one-time sync rewrites each module's connector, which would restart a running one.
  // The notices start before the modules so that notices kept from before a restart are delivered without waiting for a new one.
  setTimeout(() => { try { require('./lib/modules').getModules(); } catch (e) { console.error('[modules] background start:', e.message); } try { notices(); } catch (e) { console.error('[notices] start:', e.message); } try { require('./lib/connectors').getConnectors().startBackground(); } catch (e) { console.error('[modules] background start:', e.message); } }, 3000).unref();

  // The keystore is locked after every restart: a minute later the admins' phones get "Your wallet is locked" (Settings turns it off).
  try {
    setTimeout(() => { require('./lib/wallet/locked-notice').walletLockedNotice({ getSetting: (k) => hubSettings.getSetting(k), keystore: require('./lib/wallet/service').getWalletService().keystore, notifyEach: (p, o) => require('./lib/push').getPush().notifyEach(p, { ...o, kind: 'security' }) }).catch(() => {}); }, require('./lib/wallet/locked-notice').LOCKED_NOTICE_DELAY_MS).unref();
  } catch (e) { console.warn(`[wallet] locked notice not scheduled: ${e.message}`); }

  // Update check: a look at GitHub soon after start and then daily; admins get the "Update available" card and one
  // push per new version (lib/update-check.js; Settings → Updates turns it off, HUB_UPDATE_CHECK_HOURS=0 too).
  try { require('./lib/update-check').getUpdateCheck().start(); } catch (e) { console.warn(`[update-check] ${e.message}`); }

  // Component watch: a look at the software the hub relies on soon after start and then on its own schedule (lib/component-watch).
  try { componentWatch().start(); } catch (e) { console.warn(`[component-watch] ${e.message}`); }

  // Detached jobs: reconcile jobs that ended while the hub was down, announce them, start polling.
  try { const jr = getJobRunner().start(); console.log(`[jobs] runner started (${jr.mode()}; ${jr.list(null).filter(j => j.status === 'running').length} running)`); }
  catch (e) { console.error('[jobs] runner failed to start:', e.message); }

  // Scheduled tasks: queue anything that came due while the hub was down (fires once, marked late), start polling.
  try { const st = getScheduledTasks().start(); st.prune(30); console.log(`[sched-tasks] started (${st.list(scheduledTasksLib.OWNER).filter(t => t.status === 'active').length} active, ${st.pending.length} due now)`); }
  catch (e) { console.error('[sched-tasks] failed to start:', e.message); }
  // Hand-offs (lib/hand-offs): a hand-off whose turn died with the restart is reported to its caller as interrupted.
  try { require('./lib/sdk-chat').getHandOffRunner().start(); } catch (e) { console.error('[hand-offs] could not start:', e.message); }
  // Deep research (lib/research): a run the restart cut short is reported to its agent.
  try { require('./lib/sdk-chat').startResearch(); } catch (e) { console.error('[research] could not start:', e.message); }
  // Behaviour changes waiting for the owner: the lead is asked to review them (one task, never twice for an entry), and the weekly
  // team review follows the worker-proposals decision. After the scheduler exists; the hub creates these, the owner decides on /changes.
  (async () => {
    try {
      const review = require('./lib/behaviour-review');
      const r = await review.scheduleReview({ scheduler: getScheduledTasks() });
      if (r.taskId) console.log(`[behaviour] review scheduled for ${r.lead} (${r.taskId}): ${r.ids.join(', ')}`);
      const p = await review.syncProposalsTask({ scheduler: getScheduledTasks() });
      if (p.action === 'created') console.log(`[behaviour] weekly team review scheduled for ${p.lead} (${p.taskId})`);
    } catch (e) { console.warn('[behaviour] could not schedule the review:', e.message); }
  })();
  // A deleted agent whose things were not all moved into its bundle (a stop part-way, Docker not answering) is finished
  // now (lib/agent-archive); after the scheduler, so the tasks that would wake it can leave the list too.
  require('./lib/agents').finishArchivingAgents().catch((e) => console.error('[agents] unfinished removals:', e.message));
  // The owner's Claude sign-in is never copied into an agent's box any more. Earlier versions did: remove the copies they
  // left in the agents' home volumes (lib/sandbox sweepCredentials), and the old client wrapper scripts in data/sandbox.
  // Asynchronous and never awaited here: starting the hub does not wait for Docker. Only the agents listed in agents.json.
  try {
    const n = require('./lib/sandbox').removeOldWrappers();
    if (n) console.log(`[sandbox] removed ${n} old client wrapper script(s) from data/sandbox`);
  } catch (e) { console.warn(`[sandbox] old wrapper scripts not removed: ${e.message}`); }
  (async () => {
    const sb = require('./lib/sandbox').getSandbox();
    if (!(await sb.available())) return;
    await sb.sweepCredentials(await getAgents());
  })().catch((e) => console.error('[sandbox] sign-in copy sweep failed:', e.message));

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
      require('./lib/model-offer-group-discovery').startGroupDiscovery({
        file: path.join(__dirname, 'data', 'discovered-models.json'),
        scan: () => groupedModelOffers().list(),
      });
      startDiscovery();
      // Subscription usage windows (5-hour, 7-day, per-model weekly) polled through the Claude client; drives the plan-limit fallback.
      try { require('./lib/plan-usage').getPlanUsage().start(); } catch (e) { console.error('[plan-usage] not started:', e.message); }
      // The ChatGPT plan: one no-token reading about 30 s after start, so Codex agents' chats show it before any turn runs.
      try { require('./lib/codex-usage').getCodexUsage().start(); } catch (e) { console.error('[codex-usage] not started:', e.message); }
    } catch (e) {
      console.error('[model-discovery] Failed to start:', e.message);
    }
    serverReady = true;
    console.log('  Ready:    ✓ all systems initialized\n');
  }, 10000);
});
