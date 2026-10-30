'use strict';
/**
 * Readiness: the hub checks its own machine and tells the operator, in plain words, what is missing and what to do
 * about it on THIS platform (macOS or Linux), instead of leaving them to find out when something fails quietly.
 *
 * check() -> { platform, checkedAt, critical, warnings, items: [{ id, level, title, detail, fix, action? }] }
 *   level: 'ok' | 'info' | 'warn' | 'critical'
 *   action: { label, href } for a page or { label, api, method } for a one-click route
 *
 * Shown on the Settings page (Setup checklist), as a banner when anything is critical, on the Users page before an
 * invite (sandbox prerequisites for members), and in chat when a sandboxed agent's shell is withheld.
 */
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function createReadiness({
  platform = process.platform,
  moduleItems = () => [],
  localModelItems = () => [],
  backupItems = () => [],
  legacyAuth = () => false,
  hasUsers = () => false,
  listUsers = () => [],
  setupNeeded = () => false,
  hasSdkCredentials = () => false,
  agents = async () => [],
  isMemberOwned = () => false,
  getSetting = () => undefined,
  sandboxStatus = async () => ({ docker: false, imageReady: false }),
  fetchStatus = async () => ({ renderer: false, pdftotext: false }),
  searchChain = () => ['duckduckgo'],
  supervisor = () => 'none',          // 'systemd' | 'launchd' | 'none'
  restartTail = () => ({}),
  exposed = () => false,
  which = defaultWhich,
  now = () => new Date(),
} = {}) {
  const mac = platform === 'darwin';
  const pkg = (macCmd, linuxCmd) => (mac ? macCmd : linuxCmd);

  async function check() {
    const items = [];
    const push = (id, level, title, detail, fix = '', action = null) => items.push({ id, level, title, detail, fix, ...(action ? { action } : {}) });
    const all = await agents().catch(() => []);
    const members = all.filter(a => isMemberOwned(a));
    const sandboxedAgents = all.filter(a => a.sandbox === 'container' || (a.sandbox !== 'off' && isMemberOwned(a) && (getSetting('sandboxDefaults') || {}).member !== 'off'));
    const clientAgents = all.filter(a => /^claude-sdk\//.test(String(a.model || '')));

    // 1. Accounts and login
    if (!hasUsers()) {
      push('accounts', 'critical', 'No admin account yet',
        'The hub runs with no login: anyone who can reach it has full control, and multi-user features (members, sharing, the account menu, member sandboxes) stay off.',
        'Create the admin account. Admins need two-factor; have an authenticator app ready.', { label: 'Create the admin account', href: '/welcome' });
    } else {
      const admins = listUsers().filter(u => u.role === 'admin' && !u.disabled);
      const noTotp = admins.filter(u => !u.totpEnabled);
      if (noTotp.length) push('totp', 'warn', `${noTotp.length} admin account(s) without two-factor`, `Admins without two-factor: ${noTotp.map(u => u.login || u.name).join(', ')}.`, 'Each admin: account menu (bottom of the agent list), Security, set up two-factor.');
      else push('accounts', 'ok', 'Admin account with two-factor', `${admins.length} admin account(s), all with two-factor.`);
    }
    if (exposed() && !hasUsers()) push('exposed', 'critical', 'Reachable from the network with no login', 'The hub listens on a network address and has no accounts.', 'Create the admin account now, or bind to localhost until you do.', { label: 'Create the admin account', href: '/welcome' });

    // 2. A way to run models
    if (setupNeeded()) push('provider', 'critical', 'No AI provider configured', 'No provider key, no Claude sign-in, no local model: agents cannot answer.', 'Add a provider key or point the hub at a local model.', { label: 'Open the setup wizard', href: '/welcome' });
    else push('provider', 'ok', 'AI provider configured', 'At least one provider key, Claude sign-in or local model is set.');
    if (clientAgents.length && !hasSdkCredentials()) push('claude-signin', 'critical', `${clientAgents.length} agent(s) use the Claude client but it is not signed in`, 'Agents on claude-sdk/ models run through the Claude Code client, which needs a Claude sign-in on this machine.', mac ? 'In Terminal: `claude login`, sign in with the account that has the subscription, then restart the hub.' : 'As the hub\'s user: `claude login`, then restart the hub.');

    // 3. Sandboxes (Docker + image)
    const sb = await sandboxStatus().catch(() => ({ docker: false, imageReady: false }));
    const needSandbox = members.length > 0 || sandboxedAgents.length > 0;
    if (!sb.docker) {
      push('docker', needSandbox ? 'critical' : 'info', needSandbox ? `Docker is missing and ${sandboxedAgents.length || members.length} agent(s) need a sandbox` : 'Docker not installed (needed before you invite members)',
        needSandbox ? 'Member-owned and sandboxed agents run their shell and file tools in a Docker container. Without Docker they get NO shell or file tools (memory, Records, consultations and web tools still work).' : 'Member-owned agents are sandboxed in a Docker container by default. Without Docker a member\'s agents will have no shell or file tools.',
        mac ? 'Install Docker Desktop for Mac (docker.com/products/docker-desktop), start it once so it finishes its setup, then come back and build the sandbox image.' : 'Install Docker (`sudo apt install docker.io` on Debian/Ubuntu, or docs.docker.com), add the hub\'s user to the docker group, log out and in, then build the sandbox image.');
    } else if (!sb.imageReady) {
      push('sandbox-image', needSandbox ? 'critical' : 'warn', 'Sandbox image not built', 'Docker works, but the agent-hub-sandbox image does not exist yet, so sandboxed agents get no shell or file tools.', 'Build it once (about 650 MB, a few minutes).', { label: 'Build the sandbox image', api: '/api/sandbox/build', method: 'POST' });
    } else push('sandbox', 'ok', 'Sandboxes ready', `Docker is up and the sandbox image is built${sb.containers && sb.containers.length ? `; ${sb.containers.length} container(s)` : ''}.`);
    if ((members.length > 0 || sandboxedAgents.some(a => /^claude-sdk\//.test(String(a.model || '')))) && (getSetting('toolsDefault') || 'client') !== 'hub') {
      push('tools-default', 'warn', 'Sandboxed Claude agents carry your Claude sign-in into their container', 'With Tools = client, a sandboxed Claude agent runs the whole Claude client inside its box with a copy of this machine\'s Claude sign-in, which a shell inside the box can read.', 'Settings, Agent sandboxes, "Tools, Claude/Codex agents": set to hub. The client then stays on this machine and only its hands work inside the box.');
    }

    // 4. Document and web reading
    const wf = await fetchStatus().catch(() => ({}));
    if (!wf.pdftotext) push('poppler', 'warn', 'PDF reading unavailable (pdftotext missing)', 'Agents cannot read PDF files or fetch PDF pages until poppler-utils is installed.', mac ? 'In Terminal: `brew install poppler` (Homebrew from brew.sh if you do not have it).' : 'Debian/Ubuntu: `sudo apt install poppler-utils`.');
    else push('poppler', 'ok', 'PDF reading ready', 'pdftotext and pdftoppm are installed.');
    if (!wf.renderer) push('browser-render', 'info', 'JavaScript-only web pages cannot be rendered', 'Pages that only work with JavaScript (many apps, Reddit) come back empty; ordinary pages are fine.', mac ? 'Optional: `pip3 install playwright && playwright install firefox`.' : 'Optional: `pip3 install playwright && playwright install firefox` (or in a venv).');
    const chain = searchChain();
    if (!chain.length || (chain.length === 1 && chain[0] === 'duckduckgo')) push('search', 'info', 'Web search runs on DuckDuckGo only', 'It works with no key, but can be rate-limited. A keyed backend or a self-hosted SearXNG is steadier.', 'Settings, Web search and fetch: add a Brave, Serper or Tavily key, or press "Run SearXNG here" (needs Docker).');
    else push('search', 'ok', 'Web search ready', `Backends in order: ${chain.join(', ')}.`);

    // 5. Restart and updates
    const sup = supervisor();
    const tail = restartTail();
    const last = String((tail.restart && tail.restart.tail) || '').split('\n').filter(l => /\[relaunch\].*(✅|❌)/.test(l)).pop() || '';
    if (sup === 'none') push('supervisor', last.includes('❌') ? 'warn' : 'info', `Started by hand (no ${mac ? 'launchd' : 'systemd'} service)`, `Restart and Update work through the hub's relauncher${last ? `; last restart: ${last.replace(/^\[relaunch\] \S+ \S+ /, '')}` : ''}. Nothing restarts the hub if the machine reboots or the process dies.`, mac ? 'Optional: install the service so the hub starts at login and comes back by itself: mymaestro service install.' : 'Optional: install the service so the hub starts at boot and comes back by itself: mymaestro service install.');
    else push('supervisor', 'ok', `Supervised by ${sup}`, 'Restart and Update hand the job to the service manager, which brings the hub back on the new code.');

    // 6. The old single-password login: ignored once accounts exist, but a secret left in .env
    if (legacyAuth() && hasUsers()) push('legacy-auth', 'warn', 'Old password login still configured', 'HUB_AUTH_USERNAME/HUB_AUTH_PASSWORD in .env are ignored now that accounts exist, but they are a secret sitting in a file.', 'Remove the two lines from .env. Programs and bots sign in with API tokens (Users page → API tokens).');

    // 6. Modules: optional capabilities (lib/modules) started but not finished, or needing attention
    try { for (const it of (await moduleItems()) || []) push(it.id, it.level, it.title, it.detail, it.fix, it.action); } catch {}
    try { for (const it of (await localModelItems()) || []) push(it.id, it.level, it.title, it.detail, it.fix, it.action); } catch {}
    try { for (const it of (await backupItems()) || []) push(it.id, it.level, it.title, it.detail, it.fix, it.action); } catch {}

    const critical = items.filter(i => i.level === 'critical').length;
    const warnings = items.filter(i => i.level === 'warn').length;
    return { platform, mac, checkedAt: now().toISOString(), critical, warnings, items };
  }
  return { check };
}

async function defaultWhich(bin) {
  try { await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [bin], { timeout: 3000 }); return true; } catch { return false; }
}

let singleton = null;
function getReadiness(deps = {}) {
  if (!singleton) {
    const settings = require('./settings');
    let auth = null; try { auth = require('./auth').getAuth(); } catch {}
    const adminIds = () => { try { return new Set(auth.admins().map(u => u.id)); } catch { return new Set(); } };
    singleton = createReadiness({
      hasUsers: () => { try { return auth.hasUsers(); } catch { return false; } },
      listUsers: () => { try { return auth.listUsers(); } catch { return []; } },
      hasSdkCredentials: () => { try { return require('./claude-auth').hasSdkCredentials(); } catch { return false; } },
      agents: () => require('./agents').getAgents(),
      isMemberOwned: (a) => !!(a && a.owner && !adminIds().has(String(a.owner))),
      getSetting: (k) => settings.getSetting(k),
      sandboxStatus: () => require('./sandbox').getSandbox().status(),
      fetchStatus: () => require('./web-fetch').getWebFetch().status(),
      searchChain: () => { try { return require('./web-search').getWebSearch().chain(); } catch { return []; } },
      supervisor: () => { const R = require('./restart'); return R.underSystemd() ? 'systemd' : R.launchdLabel() ? 'launchd' : 'none'; },
      restartTail: () => { try { return require('./restart').restartLogTail(path.join(__dirname, '..'), { lines: 60 }); } catch { return {}; } },
      moduleItems: () => { try { return require('./modules').getModules().readinessItems(); } catch { return []; } },
      legacyAuth: () => !!(process.env.HUB_AUTH_USERNAME && process.env.HUB_AUTH_PASSWORD),
      localModelItems: () => { try { return require('./local-models').getLocalModels().readinessItems(); } catch { return []; } },
      backupItems: () => { const s = require('./backup/schedule').current(); return s ? s.readinessItems() : []; },
      ...deps,
    });
  }
  return singleton;
}

module.exports = { createReadiness, getReadiness };
