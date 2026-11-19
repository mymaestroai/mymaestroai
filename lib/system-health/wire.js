'use strict';
// The health check as this server runs it: the real probes, paths, sign-ins, local models and notices, and one instance
// that server.js (routes, start), the setup checklist (lib/readiness) and the lead's brief (lib/hub-map) all read.
// server.js adds what only it knows through init(): the backup state and the backup folders.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSystemHealth } = require('./index');
const { createProbes } = require('./probes');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');

let opts = { backupState: () => null, backupFolders: () => [] };
let singleton = null;

/** server.js: { backupState: () => ({ enabled, lastOkAt, setUpAt }) | null, backupFolders: () => [dir...] } */
function init(o = {}) { opts = { ...opts, ...o }; return getSystemHealth(); }

const home = () => process.env.HOME || os.homedir();
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(home(), '.claude');
const codexDir = () => process.env.CODEX_HOME || path.join(home(), '.codex');
const hubHome = () => { try { return require('../hub-home').HUB_HOME; } catch { return path.join(ROOT, 'hub-home'); } };

/** SQLite files in data/ and one level below it (not their -wal / -shm companions). */
function databases() {
  const out = [];
  const look = (dir, depth) => {
    let list = []; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(dir, e.name);
      if (e.isFile() && /\.(db|sqlite3?)$/.test(e.name)) out.push(p);
      else if (e.isDirectory() && depth < 1) look(p, depth + 1);
    }
  };
  look(DATA, 0);
  return out.sort();
}

function logs() {
  const out = [path.join(ROOT, 'server.log'), path.join(DATA, 'restart.log')];
  try { for (const n of fs.readdirSync(DATA)) if (n.endsWith('.log') && n !== 'restart.log') out.push(path.join(DATA, n)); } catch { /* no data folder */ }
  return out;
}

function localModelFolders() {
  try {
    const lm = require('../local-models').getLocalModels();
    if (!lm.state().enabled) return [];
    const dirs = [lm.files.dir, ...(lm.defaultModelsDirs() || [])].filter(Boolean);
    return [...new Set(dirs)].map((d, i) => ({ label: i === 0 ? 'local models (engine)' : `local models ${i}`, path: d }));
  } catch { return []; }
}

function paths() {
  let folders = []; try { folders = (opts.backupFolders() || []).filter(d => typeof d === 'string' && d); } catch { folders = []; }
  const hh = hubHome();
  return {
    disk: [
      { label: 'install', path: ROOT }, { label: 'data', path: DATA }, { label: 'hub home', path: hh },
      { label: 'Claude', path: claudeDir() }, { label: 'Codex', path: codexDir() }, { label: 'temp', path: os.tmpdir() },
      ...folders.map((d, i) => ({ label: folders.length > 1 ? `backup folder ${i + 1}` : 'backup folder', path: d })),
    ],
    bigFolders: [
      { label: 'data', path: DATA }, { label: 'workspaces', path: path.join(ROOT, 'workspaces') },
      { label: 'backups', path: path.join(hh, 'backups') }, { label: 'share', path: path.join(hh, 'share') },
      { label: 'Claude projects', path: path.join(claudeDir(), 'projects') }, ...localModelFolders(),
    ],
    databases: databases(),
    logs: logs(),
  };
}

/** The clients agents use, and whether each is signed in (no paid turn: a stored sign-in, `codex login status`). */
async function signIns() {
  const agents = await require('../agents').getAgents();
  const count = (re) => agents.filter(a => re.test(String((a && a.model) || ''))).length;
  const out = [];
  const nc = count(/^claude-sdk\//);
  if (nc) {
    const ca = require('../claude-auth');
    // a sign-in it can read is "signed in"; nothing at all is "not signed in" (what the setup checklist says too);
    // anything else (macOS may refuse a background read of the keychain) can't be told from here
    const s = ca.hasSignIn() ? true : ca.hasSdkCredentials() ? null : false;
    out.push({ id: 'claude', name: 'Claude', agents: nc, signedIn: s });
  }
  const nx = count(/^codex-cli\//);
  if (nx) {
    const st = await require('../codex-cli').loginStatus();
    out.push({ id: 'codex', name: 'ChatGPT (Codex)', agents: nx, signedIn: !!(st && st.installed && st.loggedIn) });
  }
  return out;
}

/** Only when the install runs local models (switched on, proxy installed): does the proxy answer? */
async function localModels() {
  const lm = require('../local-models').getLocalModels();
  if (!lm.state().enabled) return { installed: false, answers: null };
  if (!lm.detect().llamaSwap.path) return { installed: false, answers: null };   // the setup checklist says it is missing
  return { installed: true, answers: !!(await lm.healthy()) };
}

/** Admins' phones and browsers, kind "security" (on by default). A send that reached no device because of an error is a
 *  failure, so the next check tries again. */
async function notify(payload, { urgency = 'normal' } = {}) {
  const r = await require('../push').getPush().notify(payload, { adminsOnly: true, kind: 'security', urgency });
  if (r && r.error) throw new Error(r.error);
  if (r && r.failed > 0 && !r.sent) throw new Error(`${r.failed} device(s) refused it`);
  return r;
}

function getSystemHealth() {
  if (!singleton) {
    singleton = createSystemHealth({
      probes: createProbes(),
      stateFile: path.join(DATA, 'system-health.json'),
      settings: () => { try { return require('../settings').getSetting('systemHealth'); } catch { return undefined; } },
      zone: () => require('../timezone').hubZone(),
      paths,
      backupState: () => { try { return opts.backupState(); } catch { return null; } },
      signIns, localModels, notify,
      nodeSecurity: () => { try { return require('../security-check').nodeSecurity(); } catch { return null; } },
      log: (m) => console.log(m),
    });
  }
  return singleton;
}

module.exports = { init, getSystemHealth, paths, databases };
