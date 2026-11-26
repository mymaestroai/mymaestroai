'use strict';
/**
 * hub-map.js — the lead agent's standing brief about THIS hub: a dozen lines on every turn, plus the pointer to the
 * complete map, docs/HUB-MAP.md, which is read on demand. The owner's rule (2026-10-16): the full map is NOT loaded
 * into every session; the lead agent gets a standing instruction on where the details are and a short reminder with
 * live context each time.
 *
 * Who gets it: agents with the lead flag (lib/agents isLeadAgent) unless settings.hubBrief === false. Temporary
 * workers never do (the call sites skip ephemeral agents).
 *
 * What it says, facts only: software version and commit; when the process started and whether code changed since
 * (a restart is pending); where the install and the hub home are; port and exposure; the supervisor; accounts;
 * agents by category; providers with keys; Claude sign-in; sandboxes; the setup checklist summary; the operating
 * rules in one line; the map's table of contents. The text is STABLE between state changes (no clock, no uptime),
 * so a resumed Claude session (lib/context-refresh) is re-sent the block only when something actually changed.
 *
 * Costs: the checklist is refreshed in the background at most every 10 minutes (it probes Docker and the renderer);
 * the code-change scan stats ~100 files at most once a minute; everything else is in-memory.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MAP_REL = path.join('docs', 'HUB-MAP.md');
// Shipped in templates/workspaces/maestro and copied into the lead's workspace at start-up when it isn't there yet.
const PLAYBOOK_REL = path.join('workspaces', 'maestro', 'AGENT-PLAYBOOK.md');
const CHECKLIST_TTL_MS = 10 * 60 * 1000;
const SCAN_TTL_MS = 60 * 1000;

function fmt(d, zone) { return require('./timezone').stamp(d, zone); }   // local time, zone named (lib/timezone)

/** Newest mtime under the code paths (server.js, package.json, lib/**\/*.js), skipping node_modules. */
function newestCode(root) {
  let best = null;
  const consider = (p) => { try { const st = fs.statSync(p); if (!best || st.mtimeMs > best.mtimeMs) best = { file: path.relative(root, p), mtimeMs: st.mtimeMs }; } catch {} };
  for (const f of ['server.js', 'package.json']) consider(path.join(root, f));
  const walk = (dir, depth) => {
    let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 4) walk(p, depth + 1); } else if (e.isFile() && e.name.endsWith('.js')) consider(p);
    }
  };
  walk(path.join(root, 'lib'), 0);
  return best;
}

const ADDON_LINE_MAX = 900;   // the add-ons line of the lead's brief (paid for on every turn)
const SYSTEM_NAMES = { linux: 'Linux', darwin: 'a Mac', win32: 'Windows' };   // a module's manifest "platforms" values, as the add-ons line names them
function createHubMap({
  root = ROOT,
  startedAt = new Date(Date.now() - process.uptime() * 1000),
  isLead = () => false,
  getSetting = (k, d) => d,
  auth = () => null,
  agents = async () => [],
  providersWithKeys = () => [],
  hasSdkCredentials = () => false,
  models = () => [],             // discovered model ids ("provider/model"), for the "models you can assign" line
  supervisor = () => 'unknown',
  readiness = null,              // (deps) => { check(): Promise<{critical, warnings, items}> } or null
  nodeSecurity = () => { try { return require('./security-check').nodeSecurity(); } catch { return null; } },   // lib/security-check
  zone = () => require('./timezone').hubZone(),   // the hub's local time zone (lib/timezone) for the times in the brief
  gitInfo = null,                // override for tests; default reads `git log -1`
  gitBranch = null,              // override for tests; default reads `git rev-parse --abbrev-ref HEAD`
  version = null,
  // { ledger, level, roles } for the "Starter team" line; any error omits the line
  teamInfo = () => { const st = require('./starter-team'); return { ledger: st.readLedger(), level: require('./team-guidance').getLevel(), roles: st.ROLES }; },
  // Later model offers for the starter team (lib/team-offers): the hub's model list, and where new offers are recorded
  availableModels = () => require('./agents').availableModelsNow(),   // the last list fetched, at once (refreshed in the background): never a wait on a lead's turn
  recordOffers = (offers, o) => require('./starter-team').recordOffers(offers, o),
  // Titles of the behaviour changes waiting for the owner's decision (lib/behaviour-changes); any error or an unreadable state omits the line
  pendingChanges = () => { const bc = require('./behaviour-changes'); const st = bc.readState(); if (st.unreadable || st.missing) return []; return bc.manifest().filter((c) => st.entries[c.id] && st.entries[c.id].state === 'pending').map((c) => c.title || c.id); },
  // The model offers (lib/model-offers-service): [{ name, display, from, to, kind, why, route, cost }]; any error omits the lines
  modelOffers = () => require('./model-offers-service').getModelOffers(),
  // The component watch's items (lib/component-watch): software the hub relies on, what is installed, what is out
  components = () => require('./component-watch').getComponentWatch().items(),
  // The health check's warnings and critical problems (lib/system-health): [{ id, level, title, detail, fix, since }]
  health = () => require('./system-health/wire').getSystemHealth().briefItems(),
  // One line with the Claude and ChatGPT plans' weekly use (lib/codex-usage briefLine); '' or any error omits it
  subscriptions = () => require('./codex-usage').getCodexUsage().briefLine({ claude: require('./plan-usage').getPlanUsage().snapshot() }),
  // The add-ons the install ships, as this agent should know them (lib/modules addonFacts): { notSetUp, off, noAccess }, each [{ name, purpose }]; any error omits the line
  addons = (agentName) => require('./modules').getModules().addonFacts(agentName),
  now = () => new Date(),
  log = () => {},
} = {}) {
  const hubHome = require('./hub-home').resolveHubHome({ root });   // lib/hub-home: inside the install on new installs
  let opts = { port: process.env.PORT || '8888', host: '127.0.0.1', exposed: () => false, setupNeeded: () => false };
  let git = gitInfo;
  let ver = version;
  let scan = { at: 0, newest: null };
  let checklist = { at: 0, result: null, inflight: null };
  let creds = { at: 0, value: null };
  let toc = { mtimeMs: -1, text: '' };

  function init(o = {}) { opts = { ...opts, ...o }; return api; }

  function versionText() {
    if (ver == null) { try { ver = String(require(path.join(root, 'package.json')).version || ''); } catch { ver = ''; } }
    return ver;
  }
  function commitText() {
    if (git === null) {
      try { git = execFileSync('git', ['log', '-1', '--format=%h %cs'], { cwd: root, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || ''; }
      catch { git = ''; }
    }
    return git;
  }
  // The branch this install follows and its update channel (stable = main, experimental = dev), read once.
  let branch = gitBranch;
  function branchInfo() {
    if (!commitText()) return { branch: '', channel: null };   // no git, no branch (tests inject an empty gitInfo)
    if (branch === null) {
      try { branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || ''; }
      catch { branch = ''; }
      if (branch === 'HEAD') branch = '';
    }
    if (!branch) return { branch: '', channel: null };
    let channel = null; try { channel = require('./git-sync').channelOf(branch); } catch {}
    return { branch, channel };
  }
  function branchText() {
    const { branch: b, channel } = branchInfo();
    return b ? `, branch ${b}${channel ? ` (${channel} channel)` : ''}` : '';
  }
  /** What GET /api/version returns: the same facts as the Software line of the brief, as fields. Nothing else: no
   *  paths, host names, accounts or keys. Cheap: git is read once, the code-change scan is cached for a minute. */
  function versionInfo() {
    const [commit = '', commitDate = ''] = commitText().split(' ');
    const { branch: b, channel } = branchInfo();
    let restartPending = null;   // unknown when the scan of the code fails (never a false "no")
    try { restartPending = !!codeChanged(); } catch (e) { log(`[version] restart check failed: ${e.message}`); }
    return { version: versionText() || null, channel: channel || null, branch: b || null, commit: commit || null, commitDate: commitDate || null,
      startedAt: startedAt.toISOString(), node: process.versions.node, restartPending };
  }
  function codeChanged() {
    const now = Date.now();
    if (now - scan.at > SCAN_TTL_MS) { scan = { at: now, newest: newestCode(root) }; }
    const n = scan.newest;
    return n && n.mtimeMs > startedAt.getTime() + 1000 ? n : null;
  }
  function signedIn() {
    const now = Date.now();
    if (now - creds.at > SCAN_TTL_MS) { let v = false; try { v = !!hasSdkCredentials(); } catch {} creds = { at: now, value: v }; }
    return creds.value;
  }
  function refreshChecklist() {
    if (!readiness || checklist.inflight) return checklist.inflight;
    let r; try { r = readiness({ exposed: () => { try { return !!opts.exposed(); } catch { return false; } }, setupNeeded: () => { try { return !!opts.setupNeeded(); } catch { return false; } } }); } catch { return null; }
    if (!r || typeof r.check !== 'function') return null;
    checklist.inflight = Promise.resolve().then(() => r.check()).then((res) => { checklist = { at: Date.now(), result: res, inflight: null }; return res; })
      .catch((e) => { log(`[hub-map] checklist failed: ${e.message}`); checklist = { at: Date.now(), result: null, inflight: null }; return null; });
    return checklist.inflight;
  }
  function checklistText() {
    if (Date.now() - checklist.at > CHECKLIST_TTL_MS) refreshChecklist();   // background; this turn uses what is cached
    const r = checklist.result;
    if (!r) return { text: 'not checked yet (Settings → Setup checklist, or GET /api/readiness)', levels: {} };
    const levels = {}; for (const it of r.items || []) levels[it.id] = it.level;
    const bad = (r.items || []).filter(it => it.level === 'critical' || it.level === 'warn').map(it => `${it.id}${it.level === 'critical' ? '!' : ''}`);
    return { text: `${r.critical || 0} critical, ${r.warnings || 0} warnings${bad.length ? ` (${bad.join(', ')})` : ''}`, levels };
  }
  function tocText() {
    const p = path.join(root, MAP_REL);
    let st = null; try { st = fs.statSync(p); } catch { return ''; }
    if (st.mtimeMs !== toc.mtimeMs) {
      let heads = [];
      try { heads = fs.readFileSync(p, 'utf8').split('\n').filter(l => /^## \d+\. /.test(l)).map(l => l.replace(/^## (\d+)\. /, '$1 ').trim()); } catch {}
      toc = { mtimeMs: st.mtimeMs, text: heads.join(' · ') };
    }
    return toc.text;
  }
  function accountsText() {
    let a = null; try { a = auth(); } catch {}
    if (!a || !a.hasUsers || !a.hasUsers()) return 'none yet (create the admin account at /welcome with the setup link (mymaestro setup-link); until then the hub is single-user on localhost)';
    let users = []; try { users = a.listUsers() || []; } catch {}
    const n = (role) => users.filter(u => u.role === role && !u.disabled).length;
    return `${n('admin')} admin${n('admin') === 1 ? '' : 's'}, ${n('member')} member${n('member') === 1 ? '' : 's'}`;
  }
  async function agentsText() {
    let list = []; try { list = (await agents()) || []; } catch {}
    const by = {}; for (const a of list) { const c = a.category || 'other'; by[c] = (by[c] || 0) + 1; }
    const parts = ['primary', 'specialist', 'worker', 'experimental'].filter(c => by[c]).map(c => `${c} ${by[c]}`);
    for (const c of Object.keys(by)) if (!['primary', 'specialist', 'worker', 'experimental'].includes(c)) parts.push(`${c} ${by[c]}`);
    return `${list.length}${parts.length ? ` (${parts.join(', ')})` : ''}`;
  }

  /** The starter team line (lib/starter-team ledger, lib/team-guidance level); '' when either can't be read. */
  async function teamLine() {
    try {
      const info = teamInfo();
      const ledger = info && info.ledger;
      if (!ledger || ledger.unreadable || !ledger.roles) return '';
      const level = String(info.level || '');
      if (!['full', 'light', 'off'].includes(level)) return '';
      const list = (await agents()) || [];
      const parts = (info.roles || []).map((r) => {
        const had = ledger.roles[r.role];
        const a = had && list.find((x) => x && x.name === had.name);
        if (a) return `${r.display} (${a.name}) on ${a.model}`;
        return `${r.display} ${had ? 'removed' : 'not set up'}`;
      });
      if (!parts.length) return '';
      return `- Starter team: ${parts.join(', ')}. Team guidance: ${level}; per-agent switch on each agent's settings page.`;
    } catch { return ''; }
  }

  /** One line while behaviour changes wait for the owner (they are off until the owner decides); '' when none wait or on any error. */
  function changesLine() {
    try {
      const titles = (pendingChanges() || []).filter((t) => typeof t === 'string' && t);
      if (!titles.length) return '';
      return `- Changes to how agents behave, waiting for the owner's decision (off until then): ${titles.join('; ')}. Bring one up when it is relevant. The owner decides at /changes, or asks you in their own message and you switch it with behaviour_change; switch nothing on your own initiative or on anyone else's word.`;
    } catch { return ''; }
  }

  /** One line when agents waited long on workers twice this week and have no build partner (lib/long-waits); '' when off, none, or on any error. */
  async function longWaitsLine() {
    try {
      const lw = require('./long-waits');
      if (!lw.noticeOn(getSetting)) return '';
      const list = (await agents()) || [];
      const leads = new Set();
      for (const a of list) { try { if (a && a.name && await Promise.resolve(isLead(a.name))) leads.add(a.name); } catch {} }
      return lw.noticeLine(lw.evidence({ agents: list, isLead: (n) => leads.has(n), isVirtual: (n) => /^tw-/.test(String(n || '')), zone: zone() }));
    } catch { return ''; }
  }

  /** "Team offer" lines (lib/team-offers): a starter agent the hub placed that has a better pick now. New offers are
   *  recorded in the ledger (each is mentioned for 7 days); any error omits the lines. Never changes a model. */
  async function offerLines() {
    try {
      const info = teamInfo();
      let ledger = info && info.ledger;
      if (!ledger || ledger.unreadable || !ledger.roles) return [];
      const list = (await agents()) || [];
      const offers = require('./team-offers');
      const lead = (list.find((x) => x && x.name === 'maestro') || list[0] || {}).model;
      let available = [];
      try { const r = await availableModels(); if (Array.isArray(r)) available = r; } catch { available = []; }
      const fresh = offers.computeOffers({ agents: list, available, lead, ledger });
      if (fresh.length) {
        const written = await recordOffers(fresh, { now });
        if (written && written.offers) ledger = written;
      }
      return offers.pendingOffers(ledger, list, now(), { available, lead }).map((o) => `- Team offer (mention once to the person you work for, then not again): ${o.display} (${o.name}) could use ${o.to} instead of ${o.from}: ${o.why}. They change it on the agent's settings page.`);
    } catch { return []; }
  }

  /** "Model suggestion" lines (lib/model-offers-service): up to 5, then one "and N more" line. Never changes a model. */
  async function modelOfferLines() {
    try {
      const svc = modelOffers();
      const all = await svc.list();
      if (!Array.isArray(all) || !all.length) return [];
      const clean = (t) => String(t == null ? '' : t).replace(/[^A-Za-z0-9 ._()-]/g, '').slice(0, 40);
      const lines = all.slice(0, 5).map((o) => `- Model suggestion: ${clean(o.display || o.name)} (${o.name}) could move from ${o.from} to ${o.to}: ${o.why}; ${o.route}${o.cost ? `, ${o.cost}` : ''}. Bring it up with the person you work for when it is relevant: explain it plainly and recommend; they switch it on the agent's settings page (Switch or Not now), or ask you in their own message and you use model_offer. Never switch on your own initiative.`);
      const n = all.length - 5;
      if (n > 0) lines.push(`- And ${n} more model suggestion${n === 1 ? '' : 's'}: model_offer list shows them all.`);
      return lines;
    } catch { return []; }
  }

  /** "HEALTH" lines (lib/system-health): a critical problem (a full disk, a damaged database) the lead raises at the start
   *  of its next reply, a warning it mentions when it fits. One line each, at most 8; any error: no lines. */
  function healthLines() {
    try {
      const items = (opts.health || health)();
      if (!Array.isArray(items)) return [];
      const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
      const out = [];
      for (const it of items) {
        if (out.length >= 8) break;
        if (!it || (it.level !== 'critical' && it.level !== 'warn')) continue;
        if (it.id === 'health-node') continue;   // the SECURITY line above already tells the lead about Node.js
        const t = Date.parse(it.since);
        const since = Number.isFinite(t) ? ` (since ${fmt(t, zone())})` : '';
        const text = clean(`${clean(it.title, 160)}${since}. ${clean(it.detail, 300)} ${clean(it.fix, 200)}`, 700);
        out.push(it.level === 'critical'
          ? `- HEALTH (act on this): ${text} Tell the person you work for at the start of your next reply, once, in plain words, with what to do. Your Maestro never deletes or moves anything by itself; don't either unless they ask.`
          : `- Health warning: ${text} Mention it to the person you work for when it fits; the details are in Settings → Status → Health.`);
      }
      return out;
    } catch { return []; }
  }

  /** "Software update" / "Newer software" lines (lib/component-watch): a recent update or failure, or a client that is
   *  behind. Every printed value is checked; a value that does not fit leaves its line out. Any error: no lines. */
  function componentLines() {
    try {
      const items = (opts.components || components)();
      if (!Array.isArray(items)) return [];
      const NAME = /^[0-9A-Za-z .+()'-]{1,60}$/, VER = /^v?[0-9][0-9A-Za-z.+-]{0,40}$/, ID = /^[0-9A-Za-z.+/:\[\]-]{1,60}$/;
      const okName = (s) => typeof s === 'string' && NAME.test(s);
      const okVer = (s) => typeof s === 'string' && VER.test(s);
      const out = [];
      for (const it of items) {
        try {
          if (!it || !okName(it.name)) continue;
          const lu = it.lastUpdate;
          let fresh = false;
          if (lu && typeof lu === 'object') {
            const at = new Date(lu.at).getTime();
            const age = now().getTime() - at;
            if (Number.isFinite(at) && age < 7 * 24 * 3600 * 1000) {
              if (lu.ok) {
                const ul = Array.isArray(lu.unlocks) ? lu.unlocks : [];
                const unlocks = ul.filter((u) => typeof u === 'string' && ID.test(u));
                if (okVer(lu.from) && okVer(lu.to) && unlocks.length === ul.length) {
                  out.push(`- Software update: ${it.name} was updated from ${lu.from} to ${lu.to} on ${fmt(at, zone())}${unlocks.length ? `; it unlocked ${unlocks.join(', ')}` : ''}. Tell the person you work for once, plainly, and suggest where the new models help.`);
                  fresh = true;
                }
              } else if (okVer(lu.to)) {
                const back = !!lu.rolledBack;
                if (back && !okVer(lu.from)) continue;
                out.push(`- Software update failed: ${it.name} ${lu.to} failed its check${back ? `, so ${lu.from} was put back` : ''}. Tell the person you work for and suggest checking Settings → Status.`);
                fresh = true;
              }
            }
          }
          if (fresh || !it.behind) continue;
          if (!okVer(it.installed) || !okVer(it.latest)) continue;
          const TXT = /^[0-9A-Za-z .,;:+()'\/-]{1,200}$/;
          if (it.how != null && !(typeof it.how === 'string' && TXT.test(it.how))) continue;
          if (it.waiting && !(typeof it.waiting === 'string' && TXT.test(it.waiting))) continue;
          const how = it.how || '', waiting = it.waiting || '';
          out.push(`- Newer software: ${it.name} ${it.installed} is installed; ${it.latest} is out. ${how ? `${how} ` : ''}${waiting ? `(${waiting}.) ` : ''}Raise it with the person you work for when it is relevant: newer clients can unlock newer models.`);
        } catch { /* this item leaves its line out */ }
      }
      return out;
    } catch { return []; }
  }

  /** A short list of models worth assigning, per provider: what the lead agent offers when it creates an agent. */
  function modelsText() {
    let ids = []; try { ids = models() || []; } catch { return ''; }
    if (!ids.length) return '';
    const noise = /(audio|realtime|transcribe|tts|image|search|embed|instruct|vision|live|moderation|dall-e|whisper|babbage|davinci|computer-use|preview|exp\b|^gpt-(3|4)|^o1|-\d{4}-\d{2}-\d{2}|-\d{4}$|\d{8})/;
    const { versionScore } = require('./welcome');
    const by = new Map();
    for (const id of ids) {
      const i = String(id).indexOf('/'); if (i < 1) continue;
      const prov = id.slice(0, i), name = id.slice(i + 1);
      if (prov !== 'claude-sdk' && prov !== 'local' && noise.test(name)) continue;
      if (!by.has(prov)) by.set(prov, []);
      by.get(prov).push(name);
    }
    const order = ['claude-sdk', 'anthropic', 'openai', 'codex-cli', 'google', 'perplexity', 'openrouter', 'local', 'lmstudio', 'ollama', 'omlx', 'ninfer'];
    const provs = [...by.keys()].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
    const parts = provs.map(prov => {
      let names = by.get(prov);
      if (prov === 'claude-sdk') names = names.filter(n => /^(default|opus|sonnet|haiku|fable)$/.test(n)).concat(names.filter(n => !/^(default|opus|sonnet|haiku|fable)$/.test(n))).slice(0, 5);
      else if (!['local', 'lmstudio', 'ollama', 'omlx', 'ninfer'].includes(prov)) names = names.slice().sort((a, b) => versionScore(b) - versionScore(a)).slice(0, 5);
      else names = names.slice(0, 5);
      return names.map(n => `${prov}/${n}`).join(', ');
    });
    return parts.join(' · ');
  }

  /** What each kind of model on that list costs, from lib/billing (one source with the pickers and the model drop-down). */
  function costText() {
    let ids = []; try { ids = models() || []; } catch { return ''; }
    const billing = require('./billing');
    // A "local" provider can be pointed at another machine (its URL in settings): then it is free, but not here; and
    // when its address can't be read, where it runs isn't known either.
    const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|\[::ffff:7f00:1\]|host\.docker\.internal)$/i;
    const elsewhere = (prov) => {
      try {
        const raw = String(require('./settings').getProviderUrl(prov) || '').trim();
        if (!raw) return 'machine not known';
        const h = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`).hostname;
        return !h ? 'machine not known' : LOOPBACK.test(h) ? '' : `on ${h}`;
      } catch { return 'machine not known'; }
    };
    const by = { subscription: [], api: [], local: [] };
    for (const prov of [...new Set(ids.map(id => String(id).split('/')[0]).filter(Boolean))]) {
      const b = billing.billingOf(`${prov}/x`);
      if (!by[b.kind]) continue;
      const host = b.kind === 'local' ? elsewhere(prov) : '';
      const item = b.kind === 'subscription' ? `${prov}/ (${b.via})` : host ? `${prov}/ (${host})` : `${prov}/`;
      if (!by[b.kind].includes(item)) by[b.kind].push(item);
    }
    const order = (list) => list.sort((a, b) => billing.vendorRank(billing.billingOf(a.split(' ')[0] + 'x').vendor) - billing.vendorRank(billing.billingOf(b.split(' ')[0] + 'x').vendor));
    return [
      by.subscription.length ? `${order(by.subscription).join(' and ')}: a subscription the owner already pays for, no bill per use` : '',
      by.api.length ? `${order(by.api).join(', ')}: billed per use to an API key` : '',
      by.local.length ? `${by.local.join(', ')}: free to run, ${by.local.some(x => x.includes(' (')) ? 'on this computer unless another machine is named' : 'on this computer'}` : '',
    ].filter(Boolean).join('; ');
  }

  /** One line on the add-ons in modules/ that this lead cannot use yet: not set up, switched off, or set up without access for it. Names and
   *  purposes come from each module.json, so a new module appears by itself. '' when there are none or on any error. At most ADDON_LINE_MAX
   *  characters: purposes are dropped first, then names past the cap become "and N more". */
  async function addonLine(agentName) {
    let f; try { f = await addons(agentName); } catch { return ''; }
    if (!f || typeof f !== 'object') return '';
    const clean = (s, n) => String(typeof s === 'string' ? s : '').replace(/[\p{C}\p{Zl}\p{Zp}<>`]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
    const items = (k) => (Array.isArray(f[k]) ? f[k] : []).map((x) => ({ name: clean(x && x.name, 40), purpose: clean(x && x.purpose, 80) })).filter((x) => x.name);
    const groups = { notSetUp: items('notSetUp'), off: items('off'), attention: items('attention'), noAccess: items('noAccess'),
      unsupported: (Array.isArray(f.unsupported) ? f.unsupported : []).map((x) => ({ name: clean(x && x.name, 40), needs: [...new Set((Array.isArray(x && x.needs) ? x.needs : []).map((p) => SYSTEM_NAMES[p]).filter(Boolean))] })).filter((x) => x.name && x.needs.length) };
    if (!Object.values(groups).some((g) => g.length)) return '';
    const build = (withPurpose, keep) => {
      const list = (arr) => { const shown = arr.slice(0, keep); const more = arr.length - shown.length; return shown.map((x) => withPurpose && x.purpose ? `${x.name} (${x.purpose})` : x.name).join(', ') + (more > 0 ? ` and ${more} more` : ''); };
      const parts = [];
      if (groups.notSetUp.length) parts.push(`Included but not set up: ${list(groups.notSetUp)}.`);
      if (groups.off.length) parts.push(`Set up but switched off: ${list(groups.off)}.`);
      if (groups.attention.length) parts.push(`Set up but needs attention: ${list(groups.attention)} (its Data connectors page says what).`);
      if (groups.noAccess.length) parts.push(`Set up, but you have no access: ${list(groups.noAccess)} (an admin gives access on its Data connectors page).`);
      if (groups.unsupported.length) parts.push(`Not available on this system yet: ${list(groups.unsupported.map((x) => ({ name: x.name, purpose: `needs My Maestro on ${x.needs.join(' or ')}` })))}; say so plainly if someone asks for one of these.`);
      const guide = groups.notSetUp.length || groups.off.length || groups.attention.length
        ? ` When someone asks for something one of these does, offer it and walk them through Settings → Data connectors (an admin sets it up or switches it on there; those steps are theirs); do not build a substitute with other software. ${MAP_REL} section 9 has each one.`
        : '';
      return `- Add-ons: ${parts.join(' ')}${guide}`;
    };
    for (const keep of [12, 8, 4]) for (const wp of [true, false]) { const l = build(wp, keep); if (l.length <= ADDON_LINE_MAX) return l; }
    return '';
  }

  /** The brief for one agent, or '' when it is not a lead agent or the setting is off. */
  async function briefFor(agentName) {
    try { if (getSetting('hubBrief', true) === false) return ''; } catch {}
    let lead = false; try { lead = !!(await Promise.resolve(isLead(agentName))); } catch {}
    if (!lead) return '';
    const changed = codeChanged();
    const cl = checklistText();
    let providers = []; try { providers = providersWithKeys() || []; } catch {}
    const docker = cl.levels.docker ? (cl.levels.docker === 'ok' ? (cl.levels['sandbox-image'] === 'ok' || cl.levels['sandbox-image'] === undefined ? 'Docker yes, image ready' : 'Docker yes, image not built') : 'Docker missing') : 'unknown until the checklist runs';
    const sup = (() => { try { return supervisor(); } catch { return 'unknown'; } })();
    const exposed = (() => { try { return !!opts.exposed(); } catch { return false; } })();
    const commit = commitText();
    // A Node.js security release this hub misses: the lead agent raises it with the owner, and offers to do the upgrade.
    let ns = null; try { ns = nodeSecurity(); } catch {}
    const team = await teamLine();
    const offers = await offerLines();
    const waits = await longWaitsLine();
    const modelLines = await modelOfferLines();
    const addonsText = await addonLine(agentName);
    let subsLine = '';
    try { const s = (opts.subscriptions || subscriptions)(); subsLine = typeof s === 'string' && s.startsWith('- Subscriptions: ') && s.length <= 600 && !s.includes('\n') ? s : ''; } catch { subsLine = ''; }
    const lines = [
      `## THIS HUB (live facts for the lead agent; the complete map is ${MAP_REL})`,
      ...(ns && ns.behind ? [`- SECURITY (act on this): Node.js ${ns.version}, which runs this hub, misses the security fixes Node.js published on ${ns.date} (rated ${ns.rated}; fixed in ${ns.floor}). At the start of your next reply, tell the owner in plain words and offer to do the upgrade now. Only with the owner's OK: ${ns.how}. If that runs the one-line installer, say first that the hub restarts at the end (running replies are cut short), start it as a background job (run_job), and expect the job's result once the hub is back.`] : []),
      ...healthLines(),
      ...componentLines(),
      `- Software: My Maestro AI ${versionText()}${commit ? `, commit ${commit}` : ''}${branchText()}; process started ${fmt(startedAt, zone())}; supervisor: ${sup}.${changed ? ` Code changed after the process started (${changed.file}, ${fmt(changed.mtimeMs, zone())}): a restart is pending, and only the owner restarts.` : ''}`,
      `- Where: install ${root}; hub home ${hubHome} (share/, users/, medical/, legal/, backups/); runtime state in data/; agents' personality, memory files and Records in workspaces/<agent>/. Port ${opts.port}, ${exposed ? `reachable from the network on ${opts.host}` : 'localhost only'}.`,
      `- Accounts: ${accountsText()}. Agents: ${await agentsText()}.`,
      ...(team ? [team] : []),
      ...offers,
      ...modelLines,
      ...(subsLine ? [subsLine] : []),
      ...(changesLine() ? [changesLine()] : []),
      ...(waits ? [waits] : []),
      ...(addonsText ? [addonsText] : []),
      `- Providers with keys: ${providers.length ? providers.join(', ') : 'none'}. Claude client signed in: ${signedIn() ? 'yes' : 'no'}. Sandboxes: ${docker}. Setup checklist: ${cl.text}.`,
      ...(modelsText() ? [`- Models you can assign (create_agent's model, or the chat header; listed by provider, not ranked): ${modelsText()}. ${costText()}.`] : []),
      `- New agents: when someone asks for one, or you suggest one, follow ${PLAYBOOK_REL}: a short interview, then you write its files and create it with create_agent, then a quick test before you hand it over.`,
      '- Rules: data changes (agents, workspaces, Records, accounts, tokens, connectors) apply at once; settings are changed with the change_setting tool, never by editing data/ files (settings.json, agents.json, users.json and the like are refused for every agent, you included); for a setting that tool cannot change, tell the person which screen to open; code changes (lib/, server.js) need a restart, which the owner does or approves explicitly; confirm live state with a command before stating it; never print secrets.',
      `- The map, ${MAP_REL}${tocText() ? `: ${tocText()}` : ''}. Read the section that applies before any setup, configuration or repair work; its facts beat memory.`,
    ];
    return `\n\n---\n\n${lines.join('\n')}`;
  }

  const api = { init, briefFor, refreshChecklist, tocText, codeChanged, versionInfo, MAP_REL };
  return api;
}

let singleton = null;
function getHubMap() {
  if (!singleton) {
    singleton = createHubMap({
      root: ROOT,
      isLead: (name) => { try { const A = require('./agents'); return typeof A.isLeadAgent === 'function' ? A.isLeadAgent(name) : false; } catch { return false; } },
      getSetting: (k, d) => { try { return require('./settings').getSetting(k, d); } catch { return d; } },
      auth: () => { try { return require('./auth').getAuth(); } catch { return null; } },
      agents: () => require('./agents').getAgents(),
      providersWithKeys: () => { const s = require('./settings'); return ['anthropic', 'openai', 'google', 'perplexity', 'openrouter'].filter(p => { try { return !!s.getProviderKey(p); } catch { return false; } }); },
      hasSdkCredentials: () => { try { return require('./claude-auth').hasSdkCredentials(); } catch { return false; } },
      models: () => { try { return require('./model-discovery').getDiscoveredModels() || []; } catch { return []; } },
      supervisor: () => { try { const R = require('./restart'); return R.underSystemd() ? 'systemd user service (the Restart button exits and the unit restarts it)' : R.launchdLabel() ? 'launchd service' : 'none (the Restart button relaunches the process itself)'; } catch { return 'unknown'; } },
      readiness: (deps) => require('./readiness').getReadiness(deps),
      log: (...a) => console.log(...a),
    });
  }
  return singleton;
}

module.exports = { createHubMap, getHubMap, newestCode, MAP_REL, ADDON_LINE_MAX };
