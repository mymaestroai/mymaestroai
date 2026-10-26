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
const CHECKLIST_TTL_MS = 10 * 60 * 1000;
const SCAN_TTL_MS = 60 * 1000;

function fmt(d) { return new Date(d).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }

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
  gitInfo = null,                // override for tests; default reads `git log -1`
  gitBranch = null,              // override for tests; default reads `git rev-parse --abbrev-ref HEAD`
  version = null,
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
    return { version: versionText() || null, channel: channel || null, branch: b || null, commit: commit || null, commitDate: commitDate || null,
      startedAt: startedAt.toISOString(), node: process.versions.node, restartPending: !!codeChanged() };
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
    const lines = [
      `## THIS HUB (live facts for the lead agent; the complete map is ${MAP_REL})`,
      ...(ns && ns.behind ? [`- SECURITY (act on this): Node.js ${ns.version}, which runs this hub, misses the security fixes Node.js published on ${ns.date} (rated ${ns.rated}; fixed in ${ns.floor}). At the start of your next reply, tell the owner in plain words and offer to do the upgrade now. Only with the owner's OK: ${ns.how}. If that runs the one-line installer, say first that the hub restarts at the end (running replies are cut short), start it as a background job (run_job), and expect the job's result once the hub is back.`] : []),
      `- Software: My Maestro AI ${versionText()}${commit ? `, commit ${commit}` : ''}${branchText()}; process started ${fmt(startedAt)}; supervisor: ${sup}.${changed ? ` Code changed after the process started (${changed.file}, ${fmt(changed.mtimeMs)}): a restart is pending, and only the owner restarts.` : ''}`,
      `- Where: install ${root}; hub home ${hubHome} (share/, users/, medical/, legal/, backups/); runtime state in data/; agents' personality, memory files and Records in workspaces/<agent>/. Port ${opts.port}, ${exposed ? `reachable from the network on ${opts.host}` : 'localhost only'}.`,
      `- Accounts: ${accountsText()}. Agents: ${await agentsText()}.`,
      `- Providers with keys: ${providers.length ? providers.join(', ') : 'none'}. Claude client signed in: ${signedIn() ? 'yes' : 'no'}. Sandboxes: ${docker}. Setup checklist: ${cl.text}.`,
      ...(modelsText() ? [`- Models you can assign (create_agent's model, or the chat header): ${modelsText()}. claude-sdk/ uses the owner's Claude subscription; the others bill per use, except local ones, which are free.`] : []),
      '- Rules: data changes (agents, workspaces, Records, settings, accounts, tokens, connectors) apply at once; code changes (lib/, server.js) need a restart, which the owner does or approves explicitly; confirm live state with a command before stating it; never print secrets.',
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

module.exports = { createHubMap, getHubMap, newestCode, MAP_REL };
