'use strict';
/**
 * Security check: the hub reviews its own security configuration and says, in plain words, what is risky and how to
 * fix it on this machine. Same shape as the Setup checklist (lib/readiness), but about security:
 *   accounts and login · network exposure · secrets and file permissions · agents and policy · sandboxes ·
 *   tokens and root · this machine · code and updates.
 *
 * check() -> { checkedAt, platform, mac, critical, warnings, infos, items, skipped, groups }
 *   items:   [{ id, group, level, title, detail, fix, action? }]  level 'ok' | 'info' | 'warn' | 'critical'
 *   action:  { label, href } for a page, { label, api, method } for a one-click route (Settings page)
 *   skipped: [{ id, reason }] for checks that could not run here (tool missing, file unreadable, needs root)
 *
 * It runs on the Settings page (Security check box, GET /api/security-check), every night inside the hub, and from a
 * terminal with no hub process and no agent: `node scripts/security-check.js`. Every dependency is injectable so a
 * test can describe any installation; defaultDeps() reads the real files and asks the real tools. Nothing needs root
 * or the network, and nothing here prints a secret: the checks report names, modes and counts, never contents.
 *
 * The list was reviewed by the security agent (2026-10-17): the host account that can become root (sudo without a
 * password, the docker group) is the finding that turns every other issue into root, so it is checked explicitly and
 * combined with the agents that have a host shell.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const HUB_ROOT = path.resolve(__dirname, '..');

const GROUPS = {
  accounts: 'Accounts and login',
  exposure: 'Network exposure',
  secrets: 'Secrets and file permissions',
  agents: 'Agents and policy',
  sandbox: 'Sandboxes',
  tokens: 'Tokens and root',
  host: 'This machine',
  code: 'Code and updates',
};

// Services worth naming when they listen on every network interface of the machine.
const KNOWN_PORTS = {
  22: { name: 'SSH', level: 'info', fix: '' },
  139: { name: 'NetBIOS (file sharing)', level: 'warn', fix: 'Disable SMB/NetBIOS file sharing if nothing on your network needs it.' },
  445: { name: 'SMB file sharing', level: 'warn', fix: 'If nothing on your network needs it, stop and disable the smbd service (on a Mac: System Settings → Sharing → File Sharing off).' },
  631: { name: 'printing (CUPS)', level: 'info', fix: '' },
  2375: { name: 'Docker API without TLS', level: 'critical', fix: 'Anyone who reaches it is root on this machine. Remove the tcp:// listener from the Docker daemon configuration now.' },
  2376: { name: 'Docker API', level: 'critical', fix: 'Root on this machine for anyone with the client certificate; keep it off unless you run a remote Docker setup on purpose.' },
  3306: { name: 'MySQL/MariaDB', level: 'warn', fix: 'Bind the database to 127.0.0.1 (bind-address) unless other machines must use it.' },
  3389: { name: 'Remote Desktop (RDP)', level: 'warn', fix: 'Turn remote desktop off, or allow it only from your tailnet or VPN with a firewall rule.' },
  5432: { name: 'PostgreSQL', level: 'warn', fix: 'Bind the database to 127.0.0.1 (listen_addresses) unless other machines must use it.' },
  5900: { name: 'VNC / screen sharing', level: 'warn', fix: 'Turn screen sharing off, or allow it only from your tailnet or VPN.' },
  6379: { name: 'Redis', level: 'warn', fix: 'Bind Redis to 127.0.0.1 and set a password; it is open to the network with no login.' },
  9090: { name: 'Prometheus or a web console', level: 'warn', fix: 'Bind it to 127.0.0.1 or put a login in front of it.' },
  9200: { name: 'Elasticsearch/OpenSearch', level: 'warn', fix: 'Bind it to 127.0.0.1; it serves every document to anyone who reaches it.' },
  10250: { name: 'kubelet', level: 'warn', fix: 'Restrict the kubelet API to the cluster network.' },
  27017: { name: 'MongoDB', level: 'warn', fix: 'Bind MongoDB to 127.0.0.1 and turn authentication on.' },
  1234: { name: 'LM Studio server', level: 'warn', fix: 'LM Studio: turn off "Serve on local network" so it listens on this machine only; it has no login.' },
  4000: { name: 'LM Studio server', level: 'warn', fix: 'LM Studio: turn off "Serve on local network"; it has no login.' },
  8080: { name: 'a model or web server', level: 'warn', fix: 'Bind it to 127.0.0.1 (NInfer: --host 127.0.0.1) unless other machines must use it.' },
  11434: { name: 'Ollama', level: 'warn', fix: 'Ollama has no login: anyone on the network can run your models. Set OLLAMA_HOST=127.0.0.1 for its service (`systemctl edit ollama` → Environment=OLLAMA_HOST=127.0.0.1) and restart it.' },
  18080: { name: 'the local-models proxy (llama-swap)', level: 'warn', fix: 'The hub starts the proxy on 127.0.0.1; one on all interfaces was started by hand. Stop it and start it from the Local models page.' },
};

// Last security releases per Node.js line (bump when Node publishes a security release). Older patch versions miss fixes.
// NODE_SECURITY_RELEASE describes the newest one: a release Node rated HIGH or CRITICAL makes the finding critical (the
// admin's red banner), and the lead agent's brief asks it to raise the upgrade with the owner (lib/hub-map).
const NODE_FLOORS = { 22: '22.23.4', 24: '24.22.1', 26: '26.12.1' };
const NODE_SECURITY_RELEASE = { rated: 'HIGH', date: '2026-10-21', url: 'https://nodejs.org/en/blog/vulnerability/october-2026-security-releases' };
const NODE_MIN_MAJOR = 22;

// Hosts that deliver web push for the browsers the phone app runs in; any other endpoint host is not a browser.
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/i;
const TUNNEL_PROGRAMS = new Set(['cloudflared', 'ngrok', 'frpc', 'zrok', 'bore', 'lt', 'localtunnel', 'pinggy', 'pagekite']);

const TAILNET_V4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;   // 100.64.0.0/10
const TAILNET_V6 = /^fd7a:115c:a1e0:/i;
const PRIVATE_V4 = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|127\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

function ifaceOf(addr) {
  const a = String(addr || '').replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (a === '0.0.0.0' || a === '*' || a === '::' || a === '') return 'all';
  if (/^127\./.test(a) || a === '::1' || a === 'localhost') return 'loopback';
  if (TAILNET_V4.test(a) || TAILNET_V6.test(a)) return 'tailnet';
  return 'lan';
}

/** "0.0.0.0:22", "[::]:445", "*:3389", "127.0.0.53%lo:53" -> { addr, port, iface } */
function parseListener(local) {
  const m = String(local || '').trim().match(/^(.*):(\d+)$/);
  if (!m) return null;
  const addr = m[1].replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  return { addr, port: parseInt(m[2], 10), iface: ifaceOf(addr) };
}

/** Output of `tailscale serve status` / `tailscale funnel status` -> [{ url, funnel, target: { raw, port } }] */
function parseTailscaleServe(text) {
  const serves = [];
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    const head = line.match(/^(https?:\/\/\S+)\s+\((tailnet only|Funnel on)\)/i);
    if (head) { cur = { url: head[1], funnel: /funnel on/i.test(head[2]), target: null }; serves.push(cur); continue; }
    const tgt = line.match(/^\s*\|--\s+\S+\s+proxy\s+(\S+)/);
    if (tgt && cur && !cur.target) { const pm = tgt[1].match(/:(\d+)(\/|$)/); cur.target = { raw: tgt[1], port: pm ? parseInt(pm[1], 10) : null }; }
  }
  return serves;
}

/** cloudflared config.yml text -> [{ hostname, service }] from its ingress list. */
function parseTunnelConfig(text) {
  const out = [];
  let cur = null, inIngress = false;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/#.*$/, '').trimEnd();
    if (/^ingress:\s*$/.test(line.trim())) { inIngress = true; continue; }
    if (!inIngress) continue;
    if (/^\S/.test(line) && !/^\s*-/.test(line)) { inIngress = false; continue; }   // next top-level key
    const item = line.match(/^\s*-\s*(.*)$/);
    if (item) { cur = { hostname: null, service: null }; out.push(cur); const kv = item[1].match(/^(hostname|service):\s*(.+)$/); if (kv) cur[kv[1]] = kv[2].trim(); continue; }
    const kv = line.match(/^\s+(hostname|service):\s*(.+)$/);
    if (kv && cur) cur[kv[1]] = kv[2].trim();
  }
  return out.filter(e => e.hostname || e.service);
}

/** First effective value of an sshd_config keyword (drop-in files first, as sshd's Include puts them first). */
function sshdValue(text, keyword) {
  const re = new RegExp(`^\\s*${keyword}\\s+(\\S+)`, 'im');
  const m = String(text || '').match(re);
  return m ? m[1].toLowerCase() : null;
}

/** A word for a POSIX shell, single-quoted: spaces, $, backticks and quotes in it stay literal. */
function shQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

/**
 * Is the Node.js running this hub missing a security release? { behind, version, floor, rated, date, url, managed, how }.
 * A prerelease of the floor version does not count as patched. managed: the installer's own Node.js (in
 * ~/.mymaestroai/node, or MM_STATE_DIR); then re-running the one-line installer is the fix, but only on the stable or
 * experimental branch (it would move any other checkout to stable, so that case gets manual steps instead). Otherwise
 * the computer's own Node.js has to be updated. how: the fix in one sentence, with a quoted command where there is one.
 */
function nodeSecurity({ nodeVersion = process.version, execPath = process.execPath, env = process.env, home = os.homedir(), root = HUB_ROOT, platform = process.platform, branch,
  lookupBranch = (dir) => execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: dir, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null } = {}) {
  const v = String(nodeVersion);
  const major = parseInt(v.replace(/^v/, ''), 10);
  const num = v.replace(/^v/, '').replace(/-.*$/, '');
  const pre = /^v?\d+\.\d+\.\d+-/.test(v);
  const floor = NODE_FLOORS[major] || null;
  const behind = !!(floor && (versionBelow(num, floor) || (pre && !versionBelow(floor, num))));
  const stateDir = path.resolve(env.MM_STATE_DIR || path.join(home, '.mymaestroai'));
  const managed = path.resolve(String(execPath || '')).startsWith(path.join(stateDir, 'node') + path.sep);
  let branchLookupFailed = false;
  if (branch === undefined) {
    try { branch = lookupBranch(root); }
    catch (e) { branch = null; branchLookupFailed = typeof (e && e.status) !== 'number'; }   // exit status = detached; none = git did not run
  }
  // The installer knows exactly these two branches (--channel stable|experimental → main|dev).
  const stableBranch = 'main', experimentalBranch = 'dev';
  const target = floor || 'the newest LTS';
  let how;
  if (managed && (branch === stableBranch || branch === experimentalBranch)) {
    how = `run the one-line installer again, which updates this install in place to the newest version of its channel (Node.js included), keeps settings, agents and data, and restarts the hub at the end: curl -fsSL https://mymaestroai.ai/install.sh | bash -s -- --yes${branch === experimentalBranch ? ' --channel experimental' : ''} --dir ${shQuote(path.resolve(root))}`;
  } else if (managed && branchLookupFailed) {
    how = `git could not run here, and the one-line installer needs it: get git working and check which branch this install is on before re-running the installer, or replace the Node.js in ${stateDir}/node with Node.js ${target} from nodejs.org by hand (keep a copy of the old folder), then restart the hub`;
  } else if (managed) {
    how = `this install is on ${branch ? `the branch ${branch}` : 'a detached checkout'}, which the installer would move to the stable channel, so do not re-run it: replace the Node.js in ${stateDir}/node with Node.js ${target} from nodejs.org by hand (keep a copy of the old folder), then restart the hub`;
  } else if (platform === 'darwin') {
    how = `update the Mac's Node.js to ${target} or later the way it was installed (Homebrew: brew upgrade node@${major}, or brew upgrade node; nvm: nvm install ${target}, then point the hub's service at that new Node.js; otherwise the installer from nodejs.org), then restart the hub and check that it reports Node.js ${target}`;
  } else {
    how = `update the computer's Node.js to ${target} or later the way it was installed (the NodeSource packages: sudo apt-get update && sudo apt-get install --only-upgrade nodejs; nvm: nvm install ${target}, then point the hub's service at that new Node.js; otherwise the package from nodejs.org), then restart the hub and check that it reports Node.js ${target}`;
  }
  return { behind, version: v, floor, ...NODE_SECURITY_RELEASE, managed, branch, how };
}

function versionBelow(v, floor) {
  const a = String(v).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const b = String(floor).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if (a[i] < b[i]) return true; if (a[i] > b[i]) return false; }
  return false;
}

function defaultStat(p) {
  try { const s = fs.statSync(p); return { mode: s.mode, uid: s.uid, isDir: s.isDirectory(), mtimeMs: s.mtimeMs }; } catch { return null; }
}

function safe(fn, fallback) { try { const v = fn(); return v === undefined ? fallback : v; } catch { return fallback; } }

function summarizeBy(entries, key) {
  const counts = {};
  for (const e of entries) counts[e[key] || '?'] = (counts[e[key] || '?'] || 0) + 1;
  return Object.entries(counts).map(([k, n]) => `${k} ×${n}`).join(', ') || 'none';
}

function createSecurityCheck({
  platform = process.platform,
  installDir = HUB_ROOT,
  dataDir = path.join(HUB_ROOT, 'data'),
  hubHome = path.resolve(HUB_ROOT, '..'),
  homeDir = os.homedir(),
  env = process.env,
  port = null,                       // the hub's port when known
  host = null,                       // the address the hub binds to, for the exposure line
  exposed = () => false,             // true when the hub listens on a non-loopback address
  hasUsers = () => false,
  listUsers = () => [],
  listTokens = () => [],
  agents = async () => [],
  isMemberOwned = () => false,
  isLeadAgent = (a) => !!(a && a.lead === true),
  walletAgents = () => [],
  getSetting = () => undefined,
  rootGrants = () => [],
  rootAudit = () => [],
  connectors = () => null,
  sandboxStatus = async () => ({ docker: false, imageReady: false, containers: [] }),
  containerHardening = async () => [],
  listeners = async () => null,       // [{ addr, port, iface }] | null when the tool is missing
  tailscale = async () => null,       // [{ url, funnel, target }] | null when not installed
  tailscaleExtra = async () => null,  // { lockEnabled: bool|null, keyExpiry: iso|null } | null
  sshdConfig = async () => null,      // text | null when unreadable or absent
  tunnelConfig = async () => null,    // { text, path } | { unreadable: path } | null
  processes = async () => null,       // [command names] | null
  backupTimers = async () => null,    // names | [] | null when there is no scheduler to inspect
  git = async () => null,             // { branch, dirty, tracked, historySecrets, fetchAgeDays } | null
  sudoStatus = async () => null,      // { nopasswd } | null when sudo is absent or cannot be asked
  dockerGroup = async () => null,     // { inGroup, rootless } | null on macOS / without docker
  otherAccounts = async () => null,   // number of other human accounts | null
  unitInfo = async () => null,        // { kind: 'systemd-user'|'systemd-system'|'launchd'|'none', unit, noNewPrivileges }
  hubStartedAt = () => null,          // Date | null when the hub is not running
  codeNewestMtime = () => null,       // Date of the newest server.js / lib file
  publicAddress = () => null,         // a public IPv4 on an interface (a VPS), else null
  pushEndpoints = () => [],           // hosts of the stored web-push subscriptions
  claudeSettings = () => null,        // { projectAllow, userBroad }
  stat = defaultStat,
  readdir = (p) => { try { return fs.readdirSync(p); } catch { return []; } },
  chmod = (p, mode) => fs.chmodSync(p, mode),
  nodeVersion = process.version,
  lockfilePresent = () => fs.existsSync(path.join(installDir, 'package-lock.json')),
  now = () => new Date(),
  log = console.log,
} = {}) {
  const mac = platform === 'darwin';
  const resultFile = path.join(dataDir, 'security-check.json');
  const rel = (p) => { const r = path.relative(installDir, p); return r && !r.startsWith('..') ? r : p.replace(homeDir, '~'); };

  // Files that must stay private to the hub's user. Directories want 700, files 600.
  function secretFiles() {
    const list = [
      { p: path.join(installDir, '.env'), what: 'provider keys and settings', key: true },
      { p: dataDir, dir: true, what: 'all runtime data' },
      { p: path.join(homeDir, '.claude', '.credentials.json'), what: 'the Claude sign-in token', key: true },
      { p: path.join(hubHome, 'users'), dir: true, what: "members' files" },
    ];
    for (const f of ['settings.json', 'users.json', 'auth.db', 'auth.db-wal', '.auth-key', 'alert-secret', 'root-grants.json', 'root-commands.jsonl', 'connectors.json', 'modules.json', 'security-check.json', 'push/vapid.json', 'push/subscriptions.json', 'local-models.json']) {
      list.push({ p: path.join(dataDir, f), key: /auth-key|alert-secret|settings\.json|connectors|vapid/.test(f) });
    }
    return list;
  }
  function looseFiles() {
    const loose = [];
    for (const f of secretFiles()) {
      const st = stat(f.p);
      if (!st) continue;
      const mode = st.mode & 0o777;
      if (mode & 0o077) loose.push({ ...f, mode, isDir: !!st.isDir });
    }
    return loose;
  }
  // Personal credentials in the hub user's home: everything with a host shell runs as that user and can read them.
  function homeSecretFiles() {
    const out = [];
    const add = (p, what) => { const st = stat(p); if (st) out.push({ p, what, mode: st.mode & 0o777, isDir: !!st.isDir }); };
    for (const f of readdir(path.join(homeDir, '.ssh'))) if (/^id_/.test(f) && !f.endsWith('.pub')) add(path.join(homeDir, '.ssh', f), 'SSH private key');
    add(path.join(homeDir, '.aws'), 'AWS credentials');
    add(path.join(homeDir, '.config', 'gog'), 'Google sign-in (gog)');
    add(path.join(homeDir, '.codex'), 'Codex sign-in');
    add(path.join(homeDir, '.claude', '.credentials.json'), 'Claude sign-in');
    add(path.join(homeDir, '.netrc'), 'netrc passwords');
    add(path.join(homeDir, '.npmrc'), 'npm token');
    add(path.join(homeDir, '.docker', 'config.json'), 'registry logins');
    add(path.join(homeDir, '.kube', 'config'), 'Kubernetes credentials');
    return out;
  }

  async function check() {
    const items = [];
    const skipped = [];
    const push = (id, group, level, title, detail, fix = '', action = null) => items.push({ id, group, level, title, detail: detail || '', fix: fix || '', ...(action ? { action } : {}) });
    const skip = (id, reason) => skipped.push({ id, reason });
    const nowMs = now().getTime();

    const all = await agents().catch(() => []);
    const users = safe(() => listUsers(), []) || [];
    const admins = users.filter(u => u.role === 'admin' && !u.disabled);
    const members = users.filter(u => u.role === 'member' && !u.disabled);
    const userIds = new Set(users.map(u => String(u.id)));
    const securedAdmins = admins.filter(u => u.totpEnabled);
    const isExposed = !!safe(() => exposed(), false);
    const memberAgents = all.filter(a => safe(() => isMemberOwned(a), false));
    const leads = all.filter(a => safe(() => isLeadAgent(a), false));
    const sbDefaults = getSetting('sandboxDefaults') || {};
    const toolsDefault = getSetting('toolsDefault') || 'client';
    const sandboxModeOf = (a) => {
      if (a.sandbox === 'container' || a.sandbox === 'off') return a.sandbox;
      return memberAgents.includes(a) ? (sbDefaults.member || 'container') : (sbDefaults.admin || 'off');
    };
    const handsOf = (a) => (a.tools === 'hub' || a.tools === 'client') ? a.tools : toolsDefault;
    const isClaudeClient = (a) => /^claude-sdk\//.test(String(a.model || ''));
    const hostAgents = all.filter(a => !memberAgents.includes(a) && sandboxModeOf(a) === 'off');
    const hostNonLead = hostAgents.filter(a => !leads.includes(a));
    const pub = safe(() => publicAddress(), null);

    // The slow probes run together.
    const [sb, ls, ts, tsx, sshd, tunnel, procs, timers, gitInfo, sudo, dg, others, unit] = await Promise.all([
      sandboxStatus().catch(e => ({ docker: false, imageReady: false, containers: [], error: e.message })),
      listeners().catch(() => null), tailscale().catch(() => null), tailscaleExtra().catch(() => null), sshdConfig().catch(() => null),
      tunnelConfig().catch(() => null), processes().catch(() => null), backupTimers().catch(() => null), git().catch(() => null),
      sudoStatus().catch(() => null), dockerGroup().catch(() => null), otherAccounts().catch(() => null), unitInfo().catch(() => null),
    ]);
    const canBecomeRoot = !!((sudo && sudo.nopasswd) || (dg && dg.inGroup && !dg.rootless));

    // ── 1. Accounts and login ──
    if (!hasUsers()) {
      push('accounts', 'accounts', 'critical', 'No admin account: anyone who reaches the hub has full control',
        'There is no login. Every page and every API route answer to whoever can open the port, and multi-user features stay off.',
        'Create the admin account; have an authenticator app ready for two-factor.', { label: 'Create the admin account', href: '/welcome' });
    } else {
      const noTotp = admins.filter(u => !u.totpEnabled);
      if (noTotp.length) push('totp', 'accounts', isExposed ? 'critical' : 'warn', `${noTotp.length} admin account(s) without two-factor`,
        `A password alone opens an admin account${isExposed ? ', and the hub is reachable from the network' : ''}: ${noTotp.map(u => u.login || u.name).join(', ')}.`,
        'Each admin: account menu → Security → set up two-factor. Disable admin accounts nobody uses.');
      else push('accounts', 'accounts', 'ok', `${admins.length} admin account(s), all with two-factor`, `${members.length} member account(s).`);
      const mNoTotp = members.filter(u => !u.totpEnabled);
      if (mNoTotp.length) push('member-totp', 'accounts', isExposed || (ts && ts.some(s => port && s.target && s.target.port === port)) ? 'warn' : 'info', `${mNoTotp.length} member account(s) without two-factor`,
        `${mNoTotp.map(u => u.login || u.name).join(', ')}: a password alone opens their agents and files.`, 'Ask each member to set up two-factor (account menu → Security).');
    }
    if (env.HUB_AUTH_USERNAME && env.HUB_AUTH_PASSWORD) {
      push('legacy-login', 'accounts', 'warn', 'Old single-password login still in .env',
        hasUsers() ? 'HUB_AUTH_USERNAME/HUB_AUTH_PASSWORD are ignored now that accounts exist, but the password sits in a file.' : 'The old single password is the only protection: no two-factor, shared by everyone who uses the hub.',
        'Remove the two lines from .env. Programs sign in with API tokens (Users page → API tokens).');
    }

    // ── 2. Network exposure ──
    if (isExposed) {
      if (!securedAdmins.length) push('bind', 'exposure', 'critical', 'Reachable from the network without an admin protected by two-factor',
        `The hub listens on ${host || 'a network address'}. ${hasUsers() ? 'No admin account has two-factor set up.' : 'There are no accounts at all.'}`,
        'Set up two-factor for an admin (or create the admin account). Until then set HOST=127.0.0.1 in .env and restart.');
      else push('bind', 'exposure', 'warn', 'Reachable from the network over plain HTTP', `The hub listens on ${host || 'a network address'}; logins need a password and two-factor, but pages and session cookies travel unencrypted on that network${pub ? ', which includes the internet on this machine' : ''}.${env.HUB_TAILNET_USERS ? ` Tailnet users limited to ${env.HUB_TAILNET_USERS}.` : ''}`,
        'Bind to localhost (HOST=127.0.0.1) and reach the hub through Tailscale Serve or a TLS reverse proxy instead. Never forward the port from the internet.');
    } else {
      push('bind', 'exposure', 'ok', 'Listens on this machine only', `The hub binds to localhost${port ? ` port ${port}` : ''}; other devices reach it only through a tunnel you set up (Tailscale Serve, a reverse proxy).`);
    }
    if (ts) {
      const hubServes = ts.filter(s => port && s.target && s.target.port === port);
      const funnel = hubServes.filter(s => s.funnel);
      if (funnel.length) push('tailscale', 'exposure', 'critical', 'Reachable from the public internet through Tailscale Funnel',
        `Funnel publishes ${funnel.map(s => s.url).join(', ')} to everyone on the internet, pointed at the hub.`,
        'Turn Funnel off for the hub (`tailscale funnel --https=443 off`, or the port it uses); Serve keeps it inside your tailnet.');
      else if (hubServes.length) push('tailscale', 'exposure', 'info', 'Reachable inside your tailnet through Tailscale Serve',
        `${hubServes.map(s => s.url).join(', ')} → the hub, for devices signed into your Tailscale network only.${env.HUB_TAILNET_USERS ? ` Allowed tailnet users: ${env.HUB_TAILNET_USERS}.` : ' Every member of the tailnet can reach the login page.'}`,
        env.HUB_TAILNET_USERS ? '' : 'Optional: HUB_TAILNET_USERS=you@example.com in .env limits which tailnet identities may even see the login page.');
      else push('tailscale', 'exposure', 'ok', 'Not published through Tailscale', 'Tailscale runs here but does not serve the hub.');
      const otherFunnel = ts.filter(s => s.funnel && !hubServes.includes(s));
      if (otherFunnel.length) push('tailscale-funnel', 'exposure', 'warn', 'Tailscale Funnel publishes other services to the internet',
        otherFunnel.map(s => `${s.url} → ${s.target ? s.target.raw : '?'}`).join('; '), 'Check that each one is meant to be public: `tailscale funnel status`.');
      if (tsx) {
        const notes = [];
        if (tsx.lockEnabled === false) notes.push('Tailnet Lock is off: a compromised Tailscale account or control plane could add a device to your tailnet');
        if (tsx.keyExpiry === null) notes.push('this node\'s key never expires (expiry disabled)');
        if (notes.length) push('tailnet-lock', 'exposure', 'info', 'Tailscale account hygiene', notes.join('; ') + '.', 'Optional: enable Tailnet Lock (tailscale.com/kb/1226) and keep key expiry on for nodes that are not servers.');
      }
    } else skip('tailscale', 'Tailscale is not installed or not readable');
    const tunnelRunning = (procs || []).filter(p => TUNNEL_PROGRAMS.has(p));
    if (tunnel && tunnel.text !== undefined) {
      const entries = parseTunnelConfig(tunnel.text);
      const real = entries.filter(e => e.hostname && e.service && !/^http_status:/.test(e.service));
      if (real.length) {
        const toHub = real.filter(e => port && new RegExp(`:${port}(/|$)`).test(e.service));
        push('tunnel', 'exposure', toHub.length ? 'critical' : 'warn', toHub.length ? 'A public tunnel points at the hub' : 'A public tunnel exposes services on this machine',
          real.map(e => `${e.hostname} → ${e.service}`).join('; '),
          'Every hostname in the tunnel config is reachable by anyone on the internet. Remove the ones you do not need; never point one at the hub without a login in front of it.');
      } else push('tunnel', 'exposure', 'ok', 'Tunnel configured with no public hostnames', `${rel(tunnel.path)} forwards nothing to a service.`);
    } else if (tunnel && tunnel.unreadable) {
      push('tunnel', 'exposure', tunnelRunning.length ? 'warn' : 'info', 'A tunnel is configured but its config is not readable here', `${tunnel.unreadable} exists and ${tunnelRunning.length ? `${tunnelRunning.join(', ')} is running` : 'no tunnel program is running'}; what it publishes cannot be checked without root.`, 'Read it as root: every ingress hostname is public. Keep only what must be public and never the hub.');
    } else if (tunnelRunning.length) {
      push('tunnel', 'exposure', 'warn', `${tunnelRunning.join(', ')} is running`, 'A tunnel program publishes something on this machine to the internet, and no config file says what.', 'Check what it exposes (`cloudflared tunnel ingress validate`, the ngrok dashboard); never point one at the hub without a login in front of it.');
    } else skip('tunnel', 'no tunnel program or config found');
    const pushHosts = safe(() => pushEndpoints(), []) || [];
    const oddPush = pushHosts.filter(h => !PUSH_HOSTS.test(h));
    if (oddPush.length) push('push-endpoints', 'exposure', 'warn', `${oddPush.length} notification subscription(s) point at an unknown service`, `Hosts: ${[...new Set(oddPush)].join(', ')}. Notification pushes carry agent names and reply snippets.`, 'Users page / phone menu: remove subscriptions you do not recognise (data/push/subscriptions.json).');

    // ── 3. Secrets and file permissions ──
    const loose = looseFiles();
    if (loose.length) {
      const worldKey = loose.some(f => f.key && (f.mode & 0o007));
      push('file-modes', 'secrets', worldKey ? 'critical' : 'warn', `${loose.length} secret file(s) readable by other accounts on this machine`,
        loose.map(f => `${rel(f.p)} is ${f.mode.toString(8)}${f.what ? ` (${f.what})` : ''}`).join('; '),
        `Only the hub's user should read them: directories 700, files 600.`, { label: 'Tighten them now', api: '/api/security-check/fix-modes', method: 'POST' });
    } else push('file-modes', 'secrets', 'ok', "Secret files are private to the hub's user", '.env, data/ and the Claude sign-in token are mode 600/700.');
    const shared = [];
    for (const p of [path.join(installDir, 'workspaces'), path.join(hubHome, 'share'), path.join(hubHome, 'medical'), path.join(hubHome, 'legal')]) {
      const st = stat(p); if (st && (st.mode & 0o005)) shared.push(`${rel(p)} (${(st.mode & 0o777).toString(8)})`);
    }
    if (shared.length) push('private-folders', 'secrets', others > 0 ? 'warn' : 'info', 'Agent folders readable by every account on this machine', `${shared.join(', ')}: agents' memory, notes and files.${others > 0 ? ` This machine has ${others} other account(s).` : ''}`, '`chmod 750` those folders (the hub\'s user keeps full access).');
    const hs = homeSecretFiles();
    if (hs.length) {
      const looseHs = hs.filter(f => !f.isDir && (f.mode & 0o077));   // a 755 folder with 600 files inside is fine
      push('home-secrets', 'secrets', looseHs.length ? 'warn' : 'info', `${hs.length} personal credential file(s) in the hub user's home`,
        `${hs.map(f => `${rel(f.p)} (${f.what}${!f.isDir && (f.mode & 0o077) ? `, mode ${f.mode.toString(8)}` : ''})`).join('; ')}. Every agent with a host shell runs as this user and can read them.`,
        `${looseHs.length ? 'Make them private (`chmod 600`, directories 700). ' : ''}Keep agents that need a host shell to the trusted few, or run the hub as a dedicated service user that owns nothing else.`);
    }
    if (gitInfo) {
      if (gitInfo.historySecrets && gitInfo.historySecrets.length) push('git-history-secrets', 'secrets', 'critical', 'Secret files were committed to git at some point', `${gitInfo.historySecrets.join(', ')} appear in the repository history, so every clone and the remote hold them.`,
        'Rotate every key and password they held, then rewrite the history (git filter-repo) and force-push; tell everyone who cloned.');
      else if (gitInfo.tracked && gitInfo.tracked.length) push('git-secrets', 'secrets', 'critical', 'Secret files are tracked by git', `${gitInfo.tracked.join(', ')} would travel with the code on a push.`,
        '`git rm --cached <file>`, add it to .gitignore, rotate every key it held, purge the history before any push.');
      else push('git-secrets', 'secrets', 'ok', '.env and data/ are not tracked by git', 'Not now and not in the history.');
    }
    const strays = [];
    for (const dir of [installDir, dataDir]) for (const f of readdir(dir)) if (/\.(tar\.gz|tgz|zip|tar\.zst|bak)$|\.bak[.-]/i.test(f) && !/\.json\.bak$/.test(f)) strays.push(rel(path.join(dir, f)));   // *.json.bak are the hub's own safety copies
    if (strays.length) push('stray-archives', 'secrets', 'info', `${strays.length} archive or backup file(s) in the hub folders`, strays.slice(0, 8).join(', ') + (strays.length > 8 ? ', …' : ''), 'Archives and .bak files hold copies of secrets; move them to your backup location or delete them.');
    if (env.ANTHROPIC_API_KEY && all.some(isClaudeClient)) push('api-key-and-client', 'secrets', 'info', 'An Anthropic API key is set while agents use the Claude client',
      'The hub strips ANTHROPIC_API_KEY from the Claude client so those agents stay on the subscription; anthropic/ models bill the key.', '');
    const wo = getSetting('walletOwner');
    if (wo && wo.address && !env.HUB_WALLET_OWNER) push('wallet-owner-source', 'secrets', 'warn', 'The wallet owner address comes from an editable settings file', 'settings.walletOwner is the address the wallet may send funds to; data/settings.json can be changed by anything that writes there.', 'Put it in .env as HUB_WALLET_OWNER=0x… (and HUB_WALLET_OWNER_LABEL); .env wins and is only read at start.');
    const cx = safe(() => connectors(), null);
    if (cx && Array.isArray(cx.connectors) && cx.connectors.length) {
      const weak = cx.connectors.filter(c => c.sensitive && c.protect === 'none');
      const broad = cx.connectors.filter(c => c.sensitive && c.agents == null);
      if (weak.length || broad.length) push('connectors', 'secrets', 'warn', 'Sensitive data connectors with weak protection',
        [weak.length ? `no passphrase: ${weak.map(c => c.id).join(', ')}` : '', broad.length ? `open to every agent: ${broad.map(c => c.id).join(', ')}` : ''].filter(Boolean).join('; '),
        'Settings → Data connectors: protect sensitive connectors with their own passphrase or a group, and grant them to named agents.');
      else push('connectors', 'secrets', 'ok', `${cx.connectors.length} data connector(s) protected`, 'Sensitive connectors have a passphrase and a named list of agents.');
    }

    // ── 4. Agents and policy ──
    if (!leads.length) push('lead', 'agents', 'info', 'No lead agent', 'Commands as root (sudo) are refused for every agent and nobody receives the hub brief.', 'Optional: tick "Lead agent" on your main assistant\'s settings page.');
    else {
      const memberLead = leads.filter(a => memberAgents.includes(a));
      if (memberLead.length) push('lead', 'agents', 'critical', 'A member-owned agent is the lead agent', `${memberLead.map(a => a.name).join(', ')}: lead agents may run commands as root and operate the hub.`, 'Untick Lead on that agent; the lead must be admin-side.');
      else push('lead', 'agents', 'ok', `Lead agent: ${leads.map(a => a.name).join(', ')}`, 'The only role allowed to run commands as root; every root command is written to data/root-commands.jsonl.');
    }
    const risky = [], loosened = [];
    for (const a of all) {
      if (leads.includes(a)) continue;
      const ov = (a.policy && a.policy.overrides) || {};
      const bad = ['admin', 'destroy', 'money'].filter(k => ov[k] === 'allow');
      const wide = ['send', 'write_outside'].filter(k => ov[k] === 'allow');
      if (bad.length) risky.push(`${a.name}: ${bad.join(', ')}`);
      if (wide.length) loosened.push(`${a.name}: ${wide.join(', ')}`);
    }
    if (risky.length) push('policy-overrides', 'agents', 'warn', `${risky.length} agent(s) allowed admin, destructive or money actions without asking`, risky.join('; '), 'Agent settings → Tool policy: set those classes back to ask or deny.');
    else push('policy-overrides', 'agents', 'ok', 'No agent is allowed destructive, admin or money actions outright', loosened.length ? `Allowed to send or write outside their own folders without asking: ${loosened.join('; ')}.` : 'Role defaults apply.');
    const sensitiveRoots = [installDir, dataDir, hubHome, homeDir, path.parse(homeDir).root].map(p => path.resolve(p));
    const wideAdmin = [], wideMember = [];
    for (const a of all) {
      if (leads.includes(a)) continue;
      const roots = (a.policy && Array.isArray(a.policy.roots) ? a.policy.roots : []).map(r => path.resolve(String(r).replace(/^~(?=\/|$)/, homeDir)));
      const hit = roots.filter(r => sensitiveRoots.some(s => r === s || s.startsWith(r.endsWith(path.sep) ? r : r + path.sep)));
      if (!hit.length) continue;
      (memberAgents.includes(a) ? wideMember : wideAdmin).push(`${a.name}: ${hit.map(rel).join(', ')}`);
    }
    if (wideMember.length) push('roots-member', 'agents', 'critical', 'Member-owned agents may reach the hub\'s own folders', wideMember.join('; '), 'Agent settings → Shared folders: remove those paths; members get only their own tree.');
    if (wideAdmin.length) push('roots', 'agents', 'info', `${wideAdmin.length} agent(s) may read and write the hub's own code or data folders`, wideAdmin.join('; '), 'Expected for maintenance workers you trust; narrow the folders of any other agent (Agent settings → Shared folders).');
    const orphans = all.filter(a => a.owner && !userIds.has(String(a.owner)));
    if (users.length && orphans.length) push('orphan-owner', 'agents', 'warn', `${orphans.length} agent(s) belong to an account that no longer exists`, `${orphans.map(a => a.name).join(', ')}: with no owner on record they count as admin-side and lose the member sandbox defaults.`, 'Delete them, or give them to an existing account (agent settings → Owner).');
    const teamShared = [];
    for (const a of all) {
      if (!Array.isArray(a.sharedWith) || !a.sharedWith.length) continue;
      const roots = (a.policy && Array.isArray(a.policy.roots) ? a.policy.roots : []).map(r => path.resolve(String(r).replace(/^~(?=\/|$)/, homeDir)));
      const team = roots.filter(r => [path.join(hubHome, 'medical'), path.join(hubHome, 'legal')].some(t => r === t || r.startsWith(t + path.sep)));
      const gone = a.sharedWith.filter(id => !userIds.has(String(id)));
      if (team.length) teamShared.push(`${a.name} (${team.map(rel).join(', ')}) with ${a.sharedWith.length} account(s)`);
      else if (gone.length && users.length) teamShared.push(`${a.name} shared with ${gone.length} account(s) that no longer exist`);
    }
    if (teamShared.length) push('shared-team-folders', 'agents', 'warn', 'Shared agents that reach a team folder', `${teamShared.join('; ')}. Sharing an agent grants its whole Files root, including writing and deleting.`, 'Share only agents whose folders hold nothing the other account must not see (agent settings → Sharing).');
    const memberHost = memberAgents.filter(a => sandboxModeOf(a) === 'off');
    if (memberHost.length) push('member-host', 'agents', 'critical', `${memberHost.length} member-owned agent(s) run on this machine, not in a container`, memberHost.map(a => a.name).join(', '), 'Agent settings → Sandbox: container; Settings → Agent sandboxes → member default: container.');
    else if (memberAgents.length) push('member-host', 'agents', 'ok', 'Member-owned agents are sandboxed', `${memberAgents.length} agent(s) owned by members run in containers.`);
    push('host-agents', 'agents', hostNonLead.length > 2 ? 'info' : 'ok', `${hostAgents.length} agent(s) run on this machine with no container`,
      hostAgents.slice(0, 40).map(a => a.name).join(', ') + (hostAgents.length > 40 ? ', …' : ''),
      hostNonLead.length ? 'Keep this to the lead agent and the few you trust with the machine; everyone else gets a container (Agent settings → Sandbox).' : '');
    if (canBecomeRoot && hostNonLead.length) push('root-reach', 'tokens', 'warn', `${hostNonLead.length} agent(s) besides the lead have a shell on an account that can become root`,
      `${sudo && sudo.nopasswd ? 'sudo needs no password' : ''}${sudo && sudo.nopasswd && dg && dg.inGroup && !dg.rootless ? ' and ' : ''}${dg && dg.inGroup && !dg.rootless ? 'the user is in the docker group' : ''}. The policy gate refuses sudo and docker for them, but it is a filter on command text, not a kernel boundary.`,
      'Put those agents in containers (Agent settings → Sandbox: container), or run the hub as a user without sudo and without docker access.');
    const codex = all.filter(a => /^codex-cli\//.test(String(a.model || '')) && handsOf(a) !== 'hub');
    if (codex.length && !env.HUB_CODEX_SANDBOX) push('codex-shell', 'agents', codex.some(a => memberAgents.includes(a)) ? 'critical' : 'info', `${codex.length} Codex agent(s) use Codex's own shell on this machine`,
      `${codex.map(a => a.name).join(', ')}: Codex runs commands as the hub's user with its own sandbox bypassed (a member-owned one is refused at turn time).`,
      'Agent settings → Tools: hub (the shell then runs inside the agent\'s container), or set HUB_CODEX_SANDBOX to use Codex\'s own sandbox.');
    const mm = getSetting('memberModels');
    if (members.length || memberAgents.length) {
      if (Array.isArray(mm) && mm.some(m => /^codex-cli\//.test(String(m)))) push('member-models', 'agents', 'warn', 'Members may pick a Codex model', `memberModels includes ${mm.filter(m => /^codex-cli\//.test(String(m))).join(', ')}: Codex brings its own shell on this machine unless the agent uses hub hands.`, 'Remove codex-cli/ models from Settings → Member agents → models, or keep Tools = hub for member agents.');
      else if (!Array.isArray(mm) || !mm.length) push('member-models', 'agents', 'info', 'Members cannot change their agents\' models', 'settings.memberModels is empty: a member\'s model change is refused until an admin lists the allowed models.', 'Optional: Settings → Member agents → models.');
    }
    const wa = safe(() => walletAgents(), []) || [];
    if (wa.length) {
      const mw = wa.filter(n => memberAgents.some(a => a.name === n));
      push('wallet-agents', 'agents', mw.length ? 'critical' : 'info', `Wallet tools: ${wa.join(', ')}`,
        mw.length ? `${mw.join(', ')} is member-owned and can move money.` : 'These agents can sign transactions through the wallet firewall; every other agent is refused.',
        mw.length ? 'Remove member-owned agents from walletAgents in data/settings.json.' : '');
    }
    const approvalsOn = !!getSetting('approvalsEnabled');
    const classes = getSetting('approvalClasses');
    if (!approvalsOn && !(Array.isArray(classes) && classes.length)) push('approvals', 'agents', hostNonLead.length ? 'warn' : 'info', hostNonLead.length ? `Approval cards are off while ${hostNonLead.length} agent(s) have a host shell` : 'Approval cards are off',
      'Actions a policy marks "ask" (root and destructive commands, sending, writing outside an agent\'s folders) run without a card; the lead agent\'s root commands are still written to the audit file.',
      'Settings → Approval cards → "Always ask for": pick the classes (root commands, money, destructive) that must always show a card.');
    else push('approvals', 'agents', 'ok', approvalsOn ? 'Approval cards are on' : `Approval cards always for: ${classes.join(', ')}`, '');
    const wf = getSetting('webFetch') || {};
    if (wf.allowPrivate === 'all') push('webfetch-private', 'agents', 'warn', 'Every agent may fetch private network addresses', 'WebFetch reaches the LAN, the tailnet, other containers and local services with no login (model servers, printers, routers).', 'Settings → Web search and fetch → private addresses: none (or admin, for admin-side agents only).');
    else if (wf.allowPrivate === 'admin') push('webfetch-private', 'agents', 'info', 'Admin-side agents may fetch private network addresses', 'Member agents are refused; admin-side agents can reach LAN and tailnet services with WebFetch.', 'Set it to none if no agent needs internal services.');
    if (String(env.HUB_AGENT_PERMISSION_MODE || '') === 'bypassPermissions') push('permission-mode', 'agents', 'warn', 'Claude client agents run with permission prompts bypassed', 'HUB_AGENT_PERMISSION_MODE=bypassPermissions lets the client act without its own confirmation step; the hub\'s policy gate is the only check left.', 'Remove the line from .env (the default, acceptEdits, keeps the client\'s confirmation for destructive actions).');
    const cs = safe(() => claudeSettings(), null);
    if (cs && (cs.projectAllow || cs.userBroad)) push('claude-settings', 'agents', 'info', 'Claude Code permission rules apply to the client agents', `${cs.projectAllow ? `${cs.projectAllow} allow rule(s) in the hub folder's .claude/settings; ` : ''}${cs.userBroad ? 'a broad Bash allow rule in ~/.claude/settings.json' : ''}`.replace(/; $/, '') + '.', 'They pre-approve tool calls for every Claude client run from here; keep them to what every agent may do.');
    const grants = [];
    for (const u of members) {
      const p = (u.grants && u.grants.policy) || {};
      const g = Object.entries(p).filter(([, v]) => v === 'allow').map(([k]) => k);
      if (g.length) grants.push(`${u.login || u.name}: ${g.join(', ')}`);
    }
    if (grants.length) push('member-grants', 'agents', 'info', 'Member agents with widened permissions', grants.join('; '), 'Users page → Agent permissions. Web and sending reach outside the member\'s sandbox.');

    // ── 5. Sandboxes ──
    const needBox = all.filter(a => sandboxModeOf(a) === 'container');
    if (!sb.docker) {
      if (needBox.length) push('docker', 'sandbox', 'critical', `Docker is not available and ${needBox.length} agent(s) are set to run in a container`,
        'Those agents get no shell and no file tools at all (safe), so nothing they are meant to do with files works.', 'Install Docker and build the sandbox image (Settings → Agent sandboxes).');
      else skip('containers', 'Docker is not available');
    } else {
      const names = (sb.containers || []).map(c => c.container).filter(Boolean);
      const hard = names.length ? await containerHardening(names).catch(() => []) : [];
      const weak = hard.filter(c => !(c.readonly && c.capDropAll && c.noNewPrivileges && c.user && !/^(0|root)(:|$)/.test(String(c.user))));
      if (weak.length) push('containers', 'sandbox', 'warn', `${weak.length} agent container(s) are not hardened`,
        weak.map(c => `${c.container}: ${[!c.readonly && 'writable root filesystem', !c.capDropAll && 'capabilities kept', !c.noNewPrivileges && 'may gain privileges', (!c.user || /^(0|root)(:|$)/.test(String(c.user))) && 'runs as root'].filter(Boolean).join(', ')}`).join('; '),
        'Remove the container (`docker rm -f <name>`); the hub recreates it hardened on the agent\'s next turn.');
      else if (hard.length) push('containers', 'sandbox', 'ok', `${hard.length} agent container(s) hardened`, 'Read-only root filesystem, no capabilities, non-root user, no new privileges.');
      else push('containers', 'sandbox', 'ok', 'No agent containers yet', 'A container is created on an agent\'s first sandboxed turn.');
    }
    const boxedClient = all.filter(a => isClaudeClient(a) && sandboxModeOf(a) === 'container' && handsOf(a) !== 'hub');
    if (boxedClient.length) push('client-in-box', 'sandbox', 'warn', `${boxedClient.length} sandboxed Claude agent(s) carry the Claude sign-in into their container`,
      `${boxedClient.map(a => a.name).join(', ')}: with Tools = client the whole Claude client runs inside the box with a copy of this machine's sign-in token, readable by a shell inside.`,
      'Agent settings → Tools: hub (or Settings → Agent sandboxes → Tools default: hub). The client stays on this machine; only its hands work inside the box.');

    // ── 6. Tokens and root ──
    const toks = (safe(() => listTokens(), []) || []).filter(t => !t.revokedAt && !(t.expiresAt && Date.parse(t.expiresAt) <= nowMs));
    const anyHost = toks.filter(t => !t.loopbackOnly);
    const noExpiry = toks.filter(t => !t.expiresAt);
    const stale = toks.filter(t => t.lastUsed && nowMs - Date.parse(t.lastUsed) > 60 * 86400000);
    if (anyHost.length) push('tokens-anyhost', 'tokens', 'warn', `${anyHost.length} API token(s) accepted from any machine`, anyHost.map(t => `${t.name} (${(t.scopes || []).join('+')})`).join('; '),
      'Unless a remote program needs it, revoke the token and create one for this machine only (Users page → API tokens).');
    if (toks.length) push('tokens', 'tokens', 'ok', `${toks.length} active API token(s)`,
      `${noExpiry.length ? `${noExpiry.length} never expire; ` : ''}${stale.length ? `${stale.length} unused for over 60 days (${stale.map(t => t.name).join(', ')}); ` : ''}scopes: ${[...new Set(toks.flatMap(t => t.scopes || []))].join(', ') || 'none'}.`,
      stale.length ? 'Revoke tokens nothing uses.' : '');
    else push('tokens', 'tokens', 'ok', 'No API tokens', 'Programs that need the hub sign in with a token you create on the Users page.');
    if (sudo || dg) {
      const ways = [];
      if (sudo && sudo.nopasswd) ways.push('sudo needs no password (NOPASSWD in sudoers)');
      if (dg && dg.inGroup && !dg.rootless) ways.push('the user is in the docker group, which is root in all but name (a container can mount the whole disk)');
      if (ways.length) push('root-account', 'tokens', 'warn', "The hub's user can become root", `${ways.join('; ')}. The lead agent uses sudo on purpose and every root command is audited; anything else that runs as this user could become root too.`,
        'Keep every other agent in a container (Agent settings → Sandbox). Stronger: limit the sudoers line to the commands the lead agent needs, and rootless Docker (docs.docker.com/engine/security/rootless) or a socket proxy instead of the docker group.');
      else push('root-account', 'tokens', 'ok', "The hub's user cannot become root on its own", `${sudo ? 'sudo asks for a password' : 'no sudo'}${dg ? (dg.rootless ? '; Docker runs rootless' : '; not in the docker group') : ''}.`);
    } else skip('root-account', 'sudo and docker group membership could not be checked');
    const rg = safe(() => rootGrants(), []) || [];
    if (rg.length) push('root-grants', 'tokens', 'info', `${rg.length} agent(s) currently granted root`, rg.map(g => `${g.agent} until ${g.until}${g.by ? ` (by ${g.by})` : ''}${g.note ? `: ${g.note}` : ''}`).join('; '),
      'Revoke when the job is done (agent settings → Root, or Settings → Approval cards → Root grants).');
    else push('root-grants', 'tokens', 'ok', 'No root grants active', 'Only the lead agent may run commands as root.');
    const audit = (safe(() => rootAudit(), []) || []).filter(e => e && e.outcome && e.ts && nowMs - Date.parse(e.ts) < 7 * 86400000);
    if (audit.length) {
      const ran = audit.filter(e => e.outcome === 'allowed');
      const refused = audit.filter(e => e.outcome !== 'allowed');
      push('root-audit', 'tokens', 'info', `Root commands in the last 7 days: ${ran.length} ran, ${refused.length} refused`,
        `Ran: ${summarizeBy(ran, 'agent')}${refused.length ? `; refused: ${summarizeBy(refused, 'agent')}` : ''}. Details in data/root-commands.jsonl.`, '');
    }

    // ── 7. This machine ──
    if (ls) {
      const open = ls.filter(l => l.iface === 'all' || l.iface === 'lan');
      const findings = [];
      const seen = new Set();
      for (const l of open) {
        if (port && l.port === port) continue;
        if (seen.has(l.port)) continue;
        seen.add(l.port);
        const k = KNOWN_PORTS[l.port];
        let level = k ? k.level : 'info';
        if (pub && level === 'warn') level = 'critical';   // a public address: 0.0.0.0 is the internet unless a firewall says otherwise
        findings.push({ ...l, name: k ? k.name : `port ${l.port}`, level, fix: k ? k.fix : '' });
      }
      const crit = findings.filter(f => f.level === 'critical');
      const warn = findings.filter(f => f.level === 'warn');
      const rest = findings.filter(f => f.level === 'info');
      const firewallNote = pub ? ` This machine has a public address (${pub}); unless a firewall in front of it says otherwise, these are open to the internet.` : '';
      if (crit.length) push('lan-services-critical', 'host', 'critical', `${crit.length} service(s) open to the network that hand out control of this machine${pub ? ' or your data' : ''}`, crit.map(f => `${f.name} on ${f.addr}:${f.port}`).join('; ') + firewallNote, crit.map(f => f.fix).filter(Boolean).join(' ') + ' Note: ports published by Docker bypass ufw; bind them to 127.0.0.1.');
      if (warn.length) push('lan-services', 'host', 'warn', `${warn.length} service(s) open to every network this machine is on`, warn.map(f => `${f.name} on ${f.addr}:${f.port}`).join('; ') + firewallNote, warn.map(f => f.fix).filter(Boolean).join(' ') + ' Note: ports published by Docker bypass ufw; bind them to 127.0.0.1.');
      if (rest.length) push('lan-other', 'host', 'info', `${rest.length} other service(s) listen on network interfaces`, rest.map(f => `${f.name} (${f.addr}:${f.port})`).join('; '), 'Each one is reachable by other devices on your network; close what you do not use.');
      if (!findings.length) push('lan-services', 'host', 'ok', 'No services open to the network besides the hub', 'Everything else listens on this machine or your tailnet only.');
    } else skip('listeners', 'could not list listening sockets (ss or lsof missing)');
    if (sshd !== null && sshd !== undefined) {
      const sshListening = !ls || ls.some(l => l.port === 22);
      if (sshListening) {
        const pa = sshdValue(sshd, 'PasswordAuthentication');
        const prl = sshdValue(sshd, 'PermitRootLogin');
        const problems = [];
        if (pa !== 'no') problems.push(pa ? 'accepts passwords' : 'accepts passwords (the default)');
        if (prl === 'yes') problems.push('allows root to log in with a password');
        if (!problems.length) push('ssh', 'host', 'ok', 'SSH accepts keys only', `PasswordAuthentication no${prl ? `, PermitRootLogin ${prl}` : ''}.`);
        else push('ssh', 'host', 'warn', `SSH ${problems.join(' and ')}`,
          'A guessed or reused password is enough to log into this machine, where the hub\'s user holds the provider keys and the Claude sign-in.',
          'Put your public key in ~/.ssh/authorized_keys, then set PasswordAuthentication no and PermitRootLogin prohibit-password in /etc/ssh/sshd_config (or a file in sshd_config.d/) and restart ssh.');
      }
    } else skip('ssh', 'sshd configuration not readable');
    if (others !== null && others !== undefined && others > 0) push('other-accounts', 'host', 'info', `${others} other account(s) on this machine`, 'Other people who log into this computer can read any hub file whose mode lets them (see the folder items above).', 'Keep hub folders at 700/750 and the hub\'s home private.');
    if (unit) {
      if (unit.kind === 'systemd-user') push('supervisor', 'host', 'info', `Runs as your login user under a systemd user service${unit.unit ? ` (${unit.unit})` : ''}`, 'Everything the hub and its host agents can reach is everything your account can reach.', 'The stronger setup is a dedicated user with a system unit and only the hub folders; ProtectHome/NoNewPrivileges hardening is for installs whose lead agent does not need sudo.');
      else if (unit.kind === 'systemd-system') push('supervisor', 'host', unit.noNewPrivileges === false ? 'info' : 'ok', `Runs under a system service${unit.unit ? ` (${unit.unit})` : ''}`, unit.noNewPrivileges === false ? 'The unit has no NoNewPrivileges=yes; a dedicated user and hardening directives (ProtectSystem, ProtectHome) keep the hub to its own folders.' : '', unit.noNewPrivileges === false ? 'Add hardening directives to the unit if the hub\'s user never needs sudo.' : '');
      else if (unit.kind === 'launchd') push('supervisor', 'host', 'info', 'Runs under launchd as your login user', 'Everything the hub and its host agents can reach is everything your account can reach.', '');
    }
    if (timers) {
      if (timers.length) push('backups', 'host', 'ok', `Backup schedule: ${timers.join(', ')}`, 'A scheduled job copies the hub\'s data.');
      else push('backups', 'host', 'info', 'No backup schedule found', 'No timer, launchd job or cron line with "backup" in its name runs on this machine; data/, workspaces/ and the hub home live only here.', 'Schedule a nightly copy of data/, workspaces/ and the hub home folders to another disk or machine.');
    } else skip('backups', 'no scheduler to inspect');

    // ── 8. Code and updates ──
    const major = parseInt(String(nodeVersion).replace(/^v/, ''), 10);
    const floor = NODE_FLOORS[major];
    if (major < NODE_MIN_MAJOR) push('node', 'code', 'warn', `Node.js ${nodeVersion} is older than the hub needs`, `The hub is tested on Node.js ${NODE_MIN_MAJOR}; older lines no longer receive security fixes.`, 'Install Node.js 22 LTS and restart the hub.');
    else if (floor && nodeSecurity({ nodeVersion, branch: null }).behind) {
      const ns = nodeSecurity({ nodeVersion });
      push('node', 'code', /^(HIGH|CRITICAL)$/i.test(ns.rated) ? 'critical' : 'warn', `Node.js ${nodeVersion} is missing security fixes rated ${ns.rated} (fixed in ${floor})`,
        `Node.js published security fixes for this line on ${ns.date} (${ns.url}); this hub still runs ${nodeVersion}.`, `To fix it, ${ns.how}.`);
    }
    else if (!floor) push('node', 'code', 'warn', `Node.js ${nodeVersion} is on a line with no security support here`, 'Odd-numbered and end-of-life Node.js lines stop getting security fixes; the hub is tested on the 22 LTS line.', 'Install Node.js 22 or 24 LTS and restart the hub.');
    else push('node', 'code', 'ok', `Node.js ${nodeVersion}`, '');
    const started = safe(() => hubStartedAt(), null);
    const newest = safe(() => codeNewestMtime(), null);
    if (started && newest && newest.getTime() > started.getTime() + 2000) push('restart-pending', 'code', 'warn', 'The running hub is older than the code on disk', `Code changed ${newest.toLocaleString()}; the hub process started ${started.toLocaleString()}. Fixes in lib/ or server.js are not active until a restart.`, 'Restart the hub (account menu → Restart hub) when nobody is mid-turn.');
    else if (started) push('restart-pending', 'code', 'ok', 'The running hub matches the code on disk', '');
    if (gitInfo) {
      if (gitInfo.dirty && gitInfo.dirty.length) push('git-dirty', 'code', 'info', `${gitInfo.dirty.length} hub code file(s) modified locally`, gitInfo.dirty.slice(0, 10).join(', ') + (gitInfo.dirty.length > 10 ? ', …' : ''), 'Local edits block the Update button and are not what the tests cover; commit or revert them.');
      else push('git', 'code', 'ok', `Code matches the ${gitInfo.branch || 'checked-out'} branch`, 'No local modifications to tracked files.');
      if (gitInfo.fetchAgeDays !== null && gitInfo.fetchAgeDays !== undefined && gitInfo.fetchAgeDays > 30) push('fetch-age', 'code', 'info', `No update check in ${gitInfo.fetchAgeDays} days`, 'The last fetch from GitHub is that old; security fixes may be waiting.', 'Press Update (it checks before changing anything).');
    } else skip('git', 'not a git checkout');
    if (!safe(() => lockfilePresent(), true)) push('lockfile', 'code', 'warn', 'package-lock.json is missing', 'Without the lock file an install picks whatever versions of the dependencies are newest, not the ones the code was tested with.', 'Restore package-lock.json from the repository (git checkout -- package-lock.json) and run `npm ci --omit=dev`.');

    const critical = items.filter(i => i.level === 'critical').length;
    const warnings = items.filter(i => i.level === 'warn').length;
    const infos = items.filter(i => i.level === 'info').length;
    return { checkedAt: now().toISOString(), platform, mac, critical, warnings, infos, items, skipped, groups: GROUPS };
  }

  // ── results kept for the Settings page and the banner ──
  let last = null;
  function readStored() {
    try { const j = JSON.parse(fs.readFileSync(resultFile, 'utf8')); if (j && j.checkedAt && Array.isArray(j.items)) return j; } catch {}
    return null;
  }
  async function run() {
    const r = await check();
    last = r;
    try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(resultFile, JSON.stringify(r, null, 2), { mode: 0o600 }); try { fs.chmodSync(resultFile, 0o600); } catch {} } catch {}
    return r;
  }
  /** The last result when it is younger than maxAgeMs, else a fresh run. */
  async function latest({ maxAgeMs = 60 * 60 * 1000 } = {}) {
    const r = last || readStored();
    if (r && now().getTime() - Date.parse(r.checkedAt) < maxAgeMs) return { ...r, cached: true };
    return { ...(await run()), cached: false };
  }
  let timer = null, first = null;
  /** Run after a short delay, then every `hours` (0 = off). */
  function schedule(hours = 24, { onResult = () => {}, firstDelayMs = 90 * 1000 } = {}) {
    stop();
    const h = Number(hours);
    if (!(h > 0)) return false;
    const tick = async () => {
      try { const r = await run(); log(`[security] ${r.critical} critical, ${r.warnings} warning(s), ${r.infos} note(s); next check in ${h} h`); onResult(r); }
      catch (e) { log(`[security] check failed: ${e.message}`); }
    };
    first = setTimeout(tick, firstDelayMs); if (first.unref) first.unref();
    timer = setInterval(tick, h * 3600 * 1000); if (timer.unref) timer.unref();
    return true;
  }
  function stop() { if (first) clearTimeout(first); if (timer) clearInterval(timer); first = timer = null; }
  /** Tighten the modes of the secret files the check flags (never loosens anything). */
  function fixModes() {
    const fixed = [], failed = [];
    for (const f of looseFiles()) {
      const to = f.isDir ? 0o700 : 0o600;
      try { chmod(f.p, to); fixed.push({ path: rel(f.p), from: f.mode.toString(8), to: to.toString(8) }); }
      catch (e) { failed.push({ path: rel(f.p), error: e.message }); }
    }
    last = null;
    return { fixed, failed };
  }

  return { check, run, latest, schedule, stop, fixModes, looseFiles, GROUPS };
}

// ── The real installation ──
function defaultDeps(overrides = {}) {
  const installDir = HUB_ROOT;
  const dataDir = path.join(HUB_ROOT, 'data');
  const hubHome = path.resolve(HUB_ROOT, '..');
  const home = os.homedir();
  const mac = process.platform === 'darwin';
  let auth = null;
  const getAuthSafe = () => { if (auth) return auth; try { auth = require('./auth').getAuth(); } catch {} return auth; };
  const adminIds = () => { try { return new Set(getAuthSafe().admins().map(u => u.id)); } catch { return new Set(); } };
  const settings = require('./settings');
  const execText = async (bin, args, timeout = 8000) => { const r = await execFileAsync(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024 }); return r.stdout; };
  const readIf = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
  const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
  const tailscaleBin = async () => {
    for (const b of ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) { try { await execFileAsync(b, ['version'], { timeout: 5000 }); return b; } catch {} }
    return null;
  };
  // The hub process: pid, start time and cgroup, found without the hub's help (the script runs outside it).
  const hubProcess = () => {
    if (process.env.HUB_SECURITY_CHECK_INHUB === '1') return { pid: process.pid, started: new Date(Date.now() - process.uptime() * 1000) };
    try {
      if (!mac) {
        for (const pid of fs.readdirSync('/proc').filter(d => /^\d+$/.test(d))) {
          let cmd = ''; try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { continue; }
          if (!/\bnode\b.*server\.js/.test(cmd)) continue;
          let cwd = ''; try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch { continue; }
          if (path.resolve(cwd) !== installDir) continue;
          return { pid: Number(pid), started: new Date(fs.statSync(`/proc/${pid}`).mtimeMs) };
        }
      }
    } catch {}
    return null;
  };
  const newestCode = () => {
    let newest = 0;
    const consider = (p) => { try { const s = fs.statSync(p); if (s.mtimeMs > newest) newest = s.mtimeMs; } catch {} };
    consider(path.join(installDir, 'server.js')); consider(path.join(installDir, 'package.json'));
    const walk = (dir, depth) => { if (depth > 4) return; for (const f of (safe(() => fs.readdirSync(dir, { withFileTypes: true }), []) || [])) { const p = path.join(dir, f.name); if (f.isDirectory()) walk(p, depth + 1); else if (f.name.endsWith('.js')) consider(p); } };
    walk(path.join(installDir, 'lib'), 0);
    return newest ? new Date(newest) : null;
  };

  return {
    installDir, dataDir, hubHome,
    hasUsers: () => safe(() => getAuthSafe().hasUsers(), false),
    listUsers: () => safe(() => getAuthSafe().listUsers(), []),
    // listTokens opens auth.db (and would create it on a fresh install): only when it exists
    listTokens: () => (exists(path.join(dataDir, 'auth.db')) ? safe(() => getAuthSafe().listTokens(), []) : []),
    agents: () => require('./agents').getAgents(),
    isMemberOwned: (a) => !!(a && a.owner && !adminIds().has(String(a.owner))),
    isLeadAgent: (a) => { try { return require('./agents').isLeadAgent(a.name); } catch { return !!(a && a.lead === true); } },
    walletAgents: () => { const w = settings.getSetting('walletAgents'); return Array.isArray(w) ? w : []; },
    getSetting: (k) => settings.getSetting(k),
    rootGrants: () => safe(() => require('./root-grants').getRootGrants().list(), []),
    rootAudit: () => {
      const text = readIf(path.join(dataDir, 'root-commands.jsonl'));
      if (!text) return [];
      return text.slice(-256 * 1024).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    },
    connectors: () => { const t = readIf(path.join(dataDir, 'connectors.json')); if (!t) return null; try { return JSON.parse(t); } catch { return null; } },
    sandboxStatus: () => require('./sandbox').getSandbox().status(),
    containerHardening: async (names) => {
      if (!names.length) return [];
      const out = await execText('docker', ['inspect', '--format', '{{.Name}}\t{{.HostConfig.ReadonlyRootfs}}\t{{json .HostConfig.CapDrop}}\t{{.Config.User}}\t{{json .HostConfig.SecurityOpt}}', ...names], 15000);
      return out.split('\n').filter(Boolean).map(line => {
        const [name, ro, capDrop, user, secOpt] = line.split('\t');
        const caps = safe(() => JSON.parse(capDrop), []) || [];
        const opts = safe(() => JSON.parse(secOpt), []) || [];
        return { container: String(name || '').replace(/^\//, ''), readonly: ro === 'true', capDropAll: caps.includes('ALL'), user: user || '', noNewPrivileges: opts.includes('no-new-privileges') };
      });
    },
    listeners: async () => {
      if (mac) {
        const out = await execText('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], 10000).catch(() => null);
        if (out === null) return null;
        return out.split('\n').slice(1).map(l => { const cols = l.trim().split(/\s+/); const name = cols[cols.length - 2] || ''; return parseListener(name); }).filter(Boolean);
      }
      const out = await execText('ss', ['-ltnH'], 8000).catch(() => null);
      if (out === null) return null;
      return out.split('\n').filter(Boolean).map(l => { const cols = l.trim().split(/\s+/); return parseListener(cols[3]); }).filter(Boolean);
    },
    tailscale: async () => {
      const bin = await tailscaleBin();
      if (!bin) return null;
      const serve = await execText(bin, ['serve', 'status'], 8000).catch(() => null);
      if (serve === null) return null;
      const funnel = await execText(bin, ['funnel', 'status'], 8000).catch(() => '');
      const byUrl = new Map();
      for (const s of [...parseTailscaleServe(serve), ...parseTailscaleServe(funnel)]) {
        const prev = byUrl.get(s.url);
        if (!prev) byUrl.set(s.url, s); else if (s.funnel) prev.funnel = true;
      }
      return [...byUrl.values()];
    },
    tailscaleExtra: async () => {
      const bin = await tailscaleBin();
      if (!bin) return null;
      const lock = await execText(bin, ['lock', 'status'], 8000).catch(() => null);
      const lockEnabled = lock === null ? null : !/NOT enabled/i.test(lock);
      let keyExpiry;
      try { const j = JSON.parse(await execText(bin, ['status', '--json'], 8000)); keyExpiry = j && j.Self && j.Self.KeyExpiry ? j.Self.KeyExpiry : null; } catch { keyExpiry = undefined; }
      return { lockEnabled, keyExpiry };
    },
    sshdConfig: async () => {
      const parts = [];
      try { for (const f of fs.readdirSync('/etc/ssh/sshd_config.d').filter(f => f.endsWith('.conf')).sort()) { const t = readIf(path.join('/etc/ssh/sshd_config.d', f)); if (t) parts.push(t); } } catch {}
      const main = readIf('/etc/ssh/sshd_config');
      if (main) parts.push(main);
      return parts.length ? parts.join('\n') : null;
    },
    tunnelConfig: async () => {
      for (const p of ['/etc/cloudflared/config.yml', path.join(home, '.cloudflared', 'config.yml'), '/usr/local/etc/cloudflared/config.yml']) {
        if (!exists(p)) continue;
        const text = readIf(p);
        return text === null ? { unreadable: p } : { text, path: p };
      }
      return null;
    },
    processes: async () => {
      const out = await execText('ps', ['-eo', 'comm='], 8000).catch(() => null);
      if (out === null) return null;
      return [...new Set(out.split('\n').map(l => path.basename(l.trim())).filter(Boolean))];
    },
    backupTimers: async () => {
      const names = new Set();
      let any = false;
      if (mac) {
        const out = await execText('launchctl', ['list'], 8000).catch(() => null);
        if (out !== null) { any = true; for (const l of out.split('\n')) { const label = l.trim().split(/\s+/).pop(); if (label && /backup/i.test(label)) names.add(label); } }
      } else {
        for (const args of [['--user', 'list-timers', '--all', '--no-legend', '--plain'], ['list-timers', '--all', '--no-legend', '--plain']]) {
          const out = await execText('systemctl', args, 8000).catch(() => null);
          if (out === null) continue;
          any = true;
          for (const l of out.split('\n')) for (const w of l.trim().split(/\s+/)) if (/\.timer$/.test(w) && /backup/i.test(w)) names.add(w);
        }
      }
      const cron = await execText('crontab', ['-l'], 5000).catch(() => null);
      if (cron !== null) { any = true; if (cron.split('\n').some(l => l.trim() && !l.trim().startsWith('#') && /backup/i.test(l))) names.add('crontab'); }
      return any ? [...names] : null;
    },
    git: async () => {
      const g = (args) => execText('git', ['-C', installDir, ...args], 10000);
      let branch = null;
      try { branch = (await g(['rev-parse', '--abbrev-ref', 'HEAD'])).trim(); } catch { return null; }
      const dirty = (await g(['status', '--porcelain', '--untracked-files=no']).catch(() => '')).split('\n').filter(Boolean).map(l => l.slice(3).trim());
      const tracked = (await g(['ls-files', '.env', 'data']).catch(() => '')).split('\n').filter(Boolean).filter(f => f !== 'data/agents.example.json');
      const historySecrets = [...new Set((await g(['log', '--all', '--diff-filter=A', '--name-only', '--format=', '--', '.env', 'data/settings.json', 'data/users.json', 'data/auth.db', 'data/.auth-key']).catch(() => '')).split('\n').filter(Boolean))];
      let fetchAgeDays = null;
      try { const common = (await g(['rev-parse', '--git-common-dir'])).trim(); const fh = path.resolve(installDir, common, 'FETCH_HEAD'); const s = fs.statSync(fh); fetchAgeDays = Math.floor((Date.now() - s.mtimeMs) / 86400000); } catch {}
      return { branch, dirty, tracked, historySecrets, fetchAgeDays };
    },
    sudoStatus: async () => {
      try {
        const r = await execFileAsync('sudo', ['-n', '-l'], { timeout: 6000, maxBuffer: 1024 * 1024 });
        return { nopasswd: /NOPASSWD/.test(r.stdout) };
      } catch (e) {
        if (e && e.code === 'ENOENT') return null;
        const text = `${(e && e.stdout) || ''}${(e && e.stderr) || ''}`;
        if (/password is required|a terminal is required/i.test(text)) return { nopasswd: false };
        return null;
      }
    },
    dockerGroup: async () => {
      if (mac) return null;
      let groups = [];
      try { groups = (await execText('id', ['-nG'], 5000)).trim().split(/\s+/); } catch { return null; }
      const inGroup = groups.includes('docker');
      let rootless = false;
      if (inGroup) { try { rootless = (await execText('docker', ['info', '--format', '{{.Rootless}}'], 10000)).trim() === 'true'; } catch {} }
      return { inGroup, rootless };
    },
    otherAccounts: async () => {
      const me = os.userInfo().username;
      if (mac) {
        const out = await execText('dscl', ['.', '-list', '/Users', 'UniqueID'], 8000).catch(() => null);
        if (out === null) return null;
        return out.split('\n').map(l => l.trim().split(/\s+/)).filter(c => c.length === 2 && Number(c[1]) >= 501 && c[0] !== me && !c[0].startsWith('_')).length;
      }
      const passwd = readIf('/etc/passwd');
      if (passwd === null) return null;
      return passwd.split('\n').map(l => l.split(':')).filter(c => c.length >= 7 && Number(c[2]) >= 1000 && Number(c[2]) < 65534 && c[0] !== me && !/nologin|false$/.test(c[6])).length;
    },
    unitInfo: async () => {
      const R = safe(() => require('./restart'), null);
      if (mac) return R && R.launchdLabel() ? { kind: 'launchd', unit: R.launchdLabel(), noNewPrivileges: null } : null;
      const hp = hubProcess();
      let cg = null;
      try { cg = fs.readFileSync(`/proc/${hp ? hp.pid : 'self'}/cgroup`, 'utf8'); } catch {}
      // the last *.service segment is the unit; user@<uid>.service before it is the user manager
      const segs = cg ? cg.split('\n')[0].split('/').filter(s => /\.service$/.test(s)) : [];
      const m = segs.length ? [null, segs[segs.length - 1]] : null;
      if (!m) return null;
      const userScope = /user\.slice|user@/.test(cg);
      let text = null;
      try { text = await execText('systemctl', userScope ? ['--user', 'cat', m[1]] : ['cat', m[1]], 6000); } catch {}
      return { kind: userScope ? 'systemd-user' : 'systemd-system', unit: m[1], noNewPrivileges: text === null ? null : /^\s*NoNewPrivileges\s*=\s*(yes|true|1)/im.test(text) };
    },
    hubStartedAt: () => { const hp = hubProcess(); return hp ? hp.started : null; },
    codeNewestMtime: newestCode,
    publicAddress: () => {
      for (const list of Object.values(os.networkInterfaces())) for (const a of list) if (a.family === 'IPv4' && !a.internal && !PRIVATE_V4.test(a.address)) return a.address;
      return null;
    },
    pushEndpoints: () => {
      const t = readIf(path.join(dataDir, 'push', 'subscriptions.json'));
      if (!t) return [];
      const arr = safe(() => JSON.parse(t), []);
      return (Array.isArray(arr) ? arr : []).map(s => { try { return new URL(String(s.endpoint)).hostname; } catch { return 'invalid'; } });
    },
    claudeSettings: () => {
      let projectAllow = 0;
      for (const f of ['settings.json', 'settings.local.json']) { const j = safe(() => JSON.parse(readIf(path.join(installDir, '.claude', f)) || 'null'), null); if (j && j.permissions && Array.isArray(j.permissions.allow)) projectAllow += j.permissions.allow.length; }
      const u = safe(() => JSON.parse(readIf(path.join(home, '.claude', 'settings.json')) || 'null'), null);
      const userBroad = !!(u && u.permissions && Array.isArray(u.permissions.allow) && u.permissions.allow.some(r => /^Bash(\(\*?\))?$|^Bash\(\*\)$/.test(String(r))));
      return { projectAllow, userBroad };
    },
    ...overrides,
  };
}

let singleton = null;
function getSecurityCheck(opts = {}) {
  if (!singleton) {
    process.env.HUB_SECURITY_CHECK_INHUB = '1';   // the hub itself is the process whose start time matters
    singleton = createSecurityCheck(defaultDeps(opts));
  }
  return singleton;
}

/** Plain-text report for the terminal. */
function renderText(r) {
  const icon = { ok: '  ok ', info: 'note ', warn: 'WARN ', critical: 'CRIT ' };
  const lines = [`Security check — ${new Date(r.checkedAt).toLocaleString()} on ${r.mac ? 'macOS' : r.platform}: ${r.critical} critical, ${r.warnings} warning(s), ${r.infos} note(s)`];
  for (const [gid, label] of Object.entries(r.groups || GROUPS)) {
    const items = (r.items || []).filter(i => i.group === gid);
    if (!items.length) continue;
    lines.push('', label);
    for (const i of items) {
      lines.push(`  ${icon[i.level] || '     '} ${i.title}`);
      if (i.detail) lines.push(`         ${i.detail}`);
      if (i.fix && i.level !== 'ok') lines.push(`         fix: ${i.fix}`);
    }
  }
  if (r.skipped && r.skipped.length) lines.push('', `Not checked here: ${r.skipped.map(s => s.reason).join('; ')}.`);
  return lines.join('\n');
}

module.exports = { createSecurityCheck, defaultDeps, getSecurityCheck, renderText, GROUPS, KNOWN_PORTS, NODE_FLOORS, NODE_SECURITY_RELEASE, nodeSecurity, parseListener, parseTailscaleServe, parseTunnelConfig, sshdValue, ifaceOf, versionBelow };
