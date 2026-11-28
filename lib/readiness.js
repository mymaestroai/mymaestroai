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
const { requiredFrom } = require('./admin-2fa');
const { plural, word } = require('./plural');

const execFileAsync = promisify(execFile);

const SEARCH_FIX = 'Add a search key for much better research: Settings, Tools and data, Web search and fetch. A Brave Search key costs $5 per 1,000 searches with $5 of free credit each month (about 1,000 searches); a Perplexity key you use for models counts too.';

function createReadiness({
  platform = process.platform,
  moduleItems = () => [],
  connectorItems = () => [],
  localModelItems = () => [],
  backupItems = () => [],
  memoryItems = () => [],
  selfCheckItems = () => [],
  sandboxItems = () => [],
  jobItems = () => [],                // background jobs that would stop if your Maestro restarts (lib/jobs readinessItems)
  healthItems = () => [],             // the health check's warnings and critical problems (lib/system-health)
  adminPushDevices = () => null,      // devices registered for admins' notices (an admin's, or one from before accounts); null = unknown
  legacyAuth = () => false,
  hasUsers = () => false,
  listUsers = () => [],
  setupNeeded = () => false,
  hasSdkCredentials = () => false,
  hasCodexSignIn = () => false,
  hasCodexBinary = () => true,
  agents = async () => [],
  isMemberOwned = () => false,
  getSetting = () => undefined,
  sandboxStatus = async () => ({ docker: false, imageReady: false }),
  fetchStatus = async () => ({ renderer: false, pdftotext: false }),
  searchChain = () => ['duckduckgo'],
  searchSummary = null,               // () => { inUse, inUseLabel, fallbackOnly, chain }; null = derive from searchChain
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
      if (noTotp.length && !requiredFrom(getSetting('requireAdmin2fa'))) push('admin-2fa-optional', 'info', 'Two-factor sign-in is optional for admins', `Admins without two-factor: ${noTotp.map(u => u.login || u.name).join(', ')}.`, 'Settings, Security');
      else if (noTotp.length) push('totp', 'warn', `${plural(noTotp.length, 'admin account')} without two-factor`, `Admins without two-factor: ${noTotp.map(u => u.login || u.name).join(', ')}.`, 'Each admin: account menu (bottom of the agent list), Security, set up two-factor.');
      else push('accounts', 'ok', 'Admin account with two-factor', `${plural(admins.length, 'admin account')}, all with two-factor.`);
    }
    // Notices: security notices, self-check problems and finished work go to admins' phones and browsers. With none set
    // up they reach nobody, and a sender can't tell (its log says "no device registered").
    try {
      const n = await adminPushDevices();
      if (n === 0) push('push-devices', 'warn', 'No phone or browser is set up to receive notices',
        "Your Maestro's notices for admins (security notices, self-check problems, finished work) reach nobody until a phone or browser is set up for them.",
        "Turn on notifications in the phone app's menu.");
    } catch {}
    if (exposed() && !hasUsers()) push('exposed', 'critical', 'Reachable from the network with no login', 'The hub listens on a network address and has no accounts.', 'Create the admin account now, or bind to localhost until you do.', { label: 'Create the admin account', href: '/welcome' });

    // 2. A way to run models
    if (setupNeeded()) push('provider', 'critical', 'No AI provider configured', 'No provider key, no Claude or ChatGPT sign-in, no local model: agents cannot answer.', 'Add a provider key or point the hub at a local model.', { label: 'Open the setup wizard', href: '/welcome' });
    else push('provider', 'ok', 'AI provider configured', 'At least one provider key, Claude or ChatGPT sign-in or local model is set.');
    if (clientAgents.length && !hasSdkCredentials()) push('claude-signin', 'critical', `${plural(clientAgents.length, 'agent')} ${word(clientAgents.length, 'uses', 'use')} the Claude client but it is not signed in`, 'Agents on claude-sdk/ models run through the Claude Code client, which needs a Claude sign-in on this machine.', mac ? 'Press Sign in again in Settings → Status, or in Terminal on this Mac type `mymaestro connect claude`. No restart is needed.' : 'Press Sign in again in Settings → Status, or in a terminal on that computer type `mymaestro connect claude` as the user that runs your Maestro. No restart is needed.');

    const codexAgents = all.filter(a => /^codex-cli\//.test(String(a.model || '')));
    // Codex itself missing (an update of the installer's Node.js used to remove a Codex installed with that Node's npm):
    // say so, with the one command that installs it where the hub looks and signs it in.
    if (codexAgents.length && !hasCodexBinary()) push('chatgpt-signin', 'critical', `${plural(codexAgents.length, 'agent')} ${word(codexAgents.length, 'uses', 'use')} ChatGPT through Codex but Codex is not installed`, 'Agents on codex-cli/ models run through the Codex client, which is not on this computer (or not where the hub looks for it).', 'In a terminal on this computer: `mymaestro connect chatgpt` (it installs Codex and checks the sign-in), then press Check.');
    else if (codexAgents.length && !(await hasCodexSignIn())) push('chatgpt-signin', 'critical', `${plural(codexAgents.length, 'agent')} ${word(codexAgents.length, 'uses', 'use')} ChatGPT through Codex but it is not signed in`, 'Agents on codex-cli/ models run through the Codex client, which needs a ChatGPT sign-in on this machine.', 'In a terminal on this computer: `mymaestro connect chatgpt`.');

    // 3. Sandboxes (Docker + image)
    const sb = await sandboxStatus().catch(() => ({ docker: false, imageReady: false }));
    const needSandbox = members.length > 0 || sandboxedAgents.length > 0;
    if (!sb.docker) {
      push('docker', needSandbox ? 'critical' : 'info', needSandbox ? `Docker is missing and ${plural(sandboxedAgents.length || members.length, 'agent')} ${word(sandboxedAgents.length || members.length, 'needs', 'need')} a sandbox` : 'Docker not installed (needed before you invite members)',
        needSandbox ? 'Member-owned and sandboxed agents run their shell and file tools in a Docker container. Without Docker they get NO shell or file tools (memory, Records, consultations and web tools still work).' : 'Member-owned agents are sandboxed in a Docker container by default. Without Docker a member\'s agents will have no shell or file tools.',
        mac ? 'Install Docker Desktop for Mac (docker.com/products/docker-desktop), start it once so it finishes its setup, then come back and build the sandbox image.' : 'Install Docker (`sudo apt install docker.io` on Debian/Ubuntu, or docs.docker.com), add the hub\'s user to the docker group, log out and in, then build the sandbox image.');
    } else if (!sb.imageReady) {
      push('sandbox-image', needSandbox ? 'critical' : 'warn', 'Sandbox image not built', 'Docker works, but the agent-hub-sandbox image does not exist yet, so sandboxed agents get no shell or file tools.', 'Build it once (about 650 MB, a few minutes).', { label: 'Build the sandbox image', api: '/api/sandbox/build', method: 'POST' });
    } else push('sandbox', 'ok', 'Sandboxes ready', `Docker is up and the sandbox image is built${sb.containers && sb.containers.length ? `; ${plural(sb.containers.length, 'container')}` : ''}.`);
    if ((members.length > 0 || sandboxedAgents.some(a => /^claude-sdk\//.test(String(a.model || '')))) && (getSetting('toolsDefault') || 'client') !== 'hub') {
      push('tools-default', 'warn', 'Sandboxed Claude agents carry your Claude sign-in into their container', 'With Tools = client, a sandboxed Claude agent runs the whole Claude client inside its box with a copy of this machine\'s Claude sign-in, which a shell inside the box can read.', 'Settings, Agent sandboxes, "Tools, Claude/Codex agents": set to hub. The client then stays on this machine and only its hands work inside the box.');
    }

    // 4. Document and web reading
    const wf = await fetchStatus().catch(() => ({}));
    if (!wf.pdftotext) push('poppler', 'warn', 'PDF reading unavailable (pdftotext missing)', 'Agents cannot read PDF files or fetch PDF pages until poppler-utils is installed.', mac ? 'In Terminal: `brew install poppler` (Homebrew from brew.sh if you do not have it).' : 'Debian/Ubuntu: `sudo apt install poppler-utils`.');
    else push('poppler', 'ok', 'PDF reading ready', 'pdftotext and pdftoppm are installed.');
    if (!wf.renderer) push('browser-render', 'info', 'JavaScript-only web pages cannot be rendered', 'Pages that only work with JavaScript (many apps, Reddit) come back empty; ordinary pages are fine.', mac ? 'Optional: `pip3 install playwright && playwright install firefox`.' : 'Optional: `pip3 install playwright && playwright install firefox` (or in a venv).');
    let ss = null;
    try { ss = searchSummary(); } catch { ss = null; }
    if (!ss) {
      const c = searchChain() || [];
      ss = { inUse: c[0] || null, inUseLabel: require('./web-search').LABELS[c[0]] || c[0] || null, fallbackOnly: c.length === 0 || (c.length === 1 && c[0] === 'duckduckgo'), chain: c };
    }
    const schain = Array.isArray(ss.chain) ? ss.chain : (ss.inUse ? [ss.inUse] : []);
    const searchAction = { label: 'Open web search settings', href: '/?websearch=1' };
    if (!schain.length) {
      push('search', 'warn', 'Web search is off', 'No search service is available, so agents that search through your Maestro get no results.', 'Add a search key (Brave, Serper or Tavily) in Settings → Web search and fetch, or ask your lead agent to switch DuckDuckGo back on.', searchAction);
    } else if (ss.fallbackOnly) {
      push('search', 'warn', 'Web search is using the free fallback; results are thin',
        `Agents on API keys, OpenRouter, Gemini and local models search through your Maestro, and no search key or SearXNG is turned on, so every search goes to ${ss.inUseLabel}: a few thin results, sometimes none. Agents on the Claude client use Claude's own search.`,
        SEARCH_FIX, searchAction);
    } else {
      const labels = require('./web-search').LABELS;
      const rest = schain.slice(1).map(b => labels[b] || b);
      push('search', 'ok', 'Web search ready', `In use: ${ss.inUseLabel}${rest.length ? ` (then ${rest.join(', ')})` : ''}.`);
    }

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
    try { for (const it of (await connectorItems()) || []) push(it.id, it.level, it.title, it.detail, it.fix, it.action); } catch {}
    try { for (const it of (await localModelItems()) || []) push(it.id, it.level, it.title, it.detail, it.fix, it.action); } catch {}
    try { for (const it of (await backupItems()) || []) push(it.id, it.level, it.title, it.detail, it.fix, it.action); } catch {}
    try { for (const it of (await memoryItems()) || []) push(it.id, it.level, it.title, it.detail, it.fix, it.action); } catch {}
    try { for (const it of (await selfCheckItems()) || []) push(it.id, it.level, it.title, it.detail, it.fix, it.action); } catch {}   // a missing or failing self-check adds nothing
    try { for (const it of (await sandboxItems()) || []) push(it.id, it.level, it.title, it.detail, it.fix, it.action); } catch {}   // boxes waiting to be rebuilt
    try { for (const it of (await jobItems()) || []) push(it.id, it.level, it.title, it.detail, it.fix, it.action); } catch {}
    try { for (const it of (await healthItems()) || []) push(it.id, it.level, it.title, it.detail, it.fix, { label: 'Open Health', href: '/?health=1' }); } catch {}   // a full disk, a damaged database...

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
      hasCodexSignIn: async () => { try { return (await require('./codex-cli').loginStatus()).loggedIn; } catch { return false; } },
      hasCodexBinary: () => { try { const c = require('./codex-cli'); return !!c.resolveBinary(c.withNode(process.env)); } catch { return false; } },
      agents: () => require('./agents').getAgents(),
      isMemberOwned: (a) => !!(a && a.owner && !adminIds().has(String(a.owner))),
      getSetting: (k) => settings.getSetting(k),
      sandboxStatus: () => require('./sandbox').getSandbox().status(),
      fetchStatus: () => require('./web-fetch').getWebFetch().status(),
      searchSummary: () => { try { const w = require('./web-search').getWebSearch(); return { ...w.summary(), chain: w.chain() }; } catch { return null; } },
      searchChain: () => { try { return require('./web-search').getWebSearch().chain(); } catch { return []; } },
      supervisor: () => { const R = require('./restart'); return R.underSystemd() ? 'systemd' : R.launchdLabel() ? 'launchd' : 'none'; },
      restartTail: () => { try { return require('./restart').restartLogTail(path.join(__dirname, '..'), { lines: 60 }); } catch { return {}; } },
      moduleItems: () => { try { return require('./modules').getModules().readinessItems(); } catch { return []; } },
      connectorItems: () => { try { return require('./connectors').getConnectors().readinessItems(); } catch { return []; } },
      legacyAuth: () => (() => { const hs = require('./hub-secrets'); return !!(hs.get('HUB_AUTH_USERNAME') && hs.get('HUB_AUTH_PASSWORD')); })(),
      localModelItems: () => { try { return require('./local-models').getLocalModels().readinessItems(); } catch { return []; } },
      backupItems: () => { const s = require('./backup/schedule').current(); return s ? s.readinessItems() : []; },
      memoryItems: () => require('./memory-health').getMemoryHealth().readinessItems(),
      selfCheckItems: () => { try { return require('./selfcheck').getSelfCheck().readinessItems(); } catch { return []; } },
      sandboxItems: () => { try { return require('./sandbox').getSandbox().readinessItems(); } catch { return []; } },
      jobItems: () => { try { const r = require('./jobs').peekJobRunner(); return r ? r.readinessItems() : []; } catch { return []; } },
      healthItems: () => { try { return require('./system-health/wire').getSystemHealth().readinessItems(); } catch { return []; } },
      adminPushDevices: () => { try { return require('./push').getPush().subscriptions().filter(s => !s.user || s.user.role === 'admin').length; } catch { return null; } },
      ...deps,
    });
  }
  return singleton;
}

module.exports = { createReadiness, getReadiness };
