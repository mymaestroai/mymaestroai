'use strict';
// The starter team: Challenger, Scout, Builder and Researcher, created from templates/starter-team with the models
// lib/model-tiers.js pickTeam chooses. data/team.json is the ledger: a role created once is never created again, even when
// the owner later deletes or renames that agent. Nothing here checks who is asking; the routes that call it do.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TEMPLATES_DIR = path.join(ROOT, 'templates', 'starter-team');
const LEDGER_FILE = path.join(ROOT, 'data', 'team.json');
const FILE_KEYS = ['IDENTITY.md', 'SOUL.md', 'USER.md', 'TOOLS.md'];

const ROLES = [
  { role: 'challenger', name: 'challenger', display: 'Challenger', icon: '🥊', teamRole: 'challenger', blurb: 'Adversarial reviews and second opinions: finds what is wrong before it goes out.' },
  { role: 'scout', name: 'scout', display: 'Scout', icon: '🔍', teamRole: 'worker', blurb: 'Quick lookups, searches, summaries and reformatting.' },
  { role: 'builder', name: 'builder', display: 'Builder', icon: '🔨', teamRole: 'worker', blurb: 'Coding from a clear spec, multi-step file work and routine reviews.' },
  { role: 'researcher', name: 'researcher', display: 'Researcher', icon: '📚', teamRole: 'worker', blurb: 'Research and writing: sources, comparisons and drafts.' },
];

/** The ledger; a missing file is an empty one. A file that is there but can't be read or parsed is marked unreadable:
 *  createTeam then creates nothing, since an empty-looking ledger could bring back a starter the owner deleted. */
function readLedger(file = LEDGER_FILE) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { return e && e.code === 'ENOENT' ? { roles: {} } : { roles: {}, unreadable: true }; }
  try {
    const doc = JSON.parse(text);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { roles: {}, unreadable: true };
    const roles = doc.roles && typeof doc.roles === 'object' && !Array.isArray(doc.roles) ? doc.roles : {};
    return { roles, ...(typeof doc.skippedAt === 'string' ? { skippedAt: doc.skippedAt } : {}) };
  } catch { return { roles: {}, unreadable: true }; }
}

function writeLedger(ledger, file = LEDGER_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }
}

function planTeam({ agents, available, lead, ledger } = {}) {
  const list = Array.isArray(agents) ? agents : [];
  const roles = (ledger && ledger.roles) || {};
  const picks = require('./model-tiers').pickTeam({ available, lead });
  return ROLES.map((r) => {
    const p = picks[r.role] || {};
    const entry = { role: r.role, name: r.name, display: r.display, icon: r.icon, model: p.model || null, route: p.route || null, perUse: !!p.perUse, tier: p.tier == null ? null : p.tier, note: p.note || null };
    const shown = r.display.toLowerCase();
    if (roles[r.role]) return { ...entry, action: 'skip', reason: 'created before' };
    if (list.some((a) => a && (a.name === r.name || String(a.display || '').toLowerCase() === shown))) return { ...entry, action: 'skip', reason: 'name taken' };
    if (!entry.model) return { ...entry, action: 'skip', reason: 'no model' };
    return { ...entry, action: 'create', reason: null };
  });
}

let lock = Promise.resolve();

function readTemplates(dir, role) {
  const files = {};
  for (const f of FILE_KEYS) {
    const p = path.join(dir, role, f);
    try { files[f] = fs.readFileSync(p, 'utf8'); }
    catch { throw new Error(`template file missing: ${path.join(role, f)}`); }
  }
  return files;
}

async function run({ available, lead, only, deps }) {
  const agentsLib = (deps.createAgent && deps.getAgents) ? null : require('./agents');
  const createAgent = deps.createAgent || agentsLib.createAgent;
  const getAgents = deps.getAgents || agentsLib.getAgents;
  const ledgerFile = deps.ledgerFile || LEDGER_FILE;
  const templatesDir = deps.templatesDir || TEMPLATES_DIR;
  const now = deps.now || (() => new Date());
  const agents = await getAgents(true);
  const ledger = readLedger(ledgerFile);
  const plan = planTeam({ agents, available, lead, ledger });
  const created = [], skipped = [];
  if (ledger.unreadable) {
    const error = `the team ledger ${path.basename(ledgerFile)} can't be read, so no starter agent is created (fix or remove the file)`;
    return { created, skipped: plan.map((e) => (e.action === 'create' ? { ...e, action: 'skip', reason: 'failed', error } : e)) };
  }
  for (const entry of plan) {
    const wanted = !Array.isArray(only) || only.includes(entry.role);
    if (entry.action !== 'create' || !wanted) { skipped.push(entry); continue; }
    const r = ROLES.find((x) => x.role === entry.role);
    try {
      const files = readTemplates(templatesDir, entry.role);
      const res = await createAgent(r.name, entry.model, null, null, 'worker', null, { display: r.display, icon: r.icon, blurb: r.blurb, files, teamRole: r.teamRole, teamModelBy: 'hub' });
      if (!res || res.success !== true) throw new Error((res && res.error) || 'the agent was not created');
    } catch (e) {
      skipped.push({ ...entry, action: 'skip', reason: 'failed', error: e && e.message ? e.message : String(e) });
      continue;
    }
    // The agent exists from here on: a ledger that can't be written is reported with it, never as a failed create
    // (its name is then taken, so a later run skips it anyway).
    ledger.roles[entry.role] = { name: r.name, model: entry.model, createdAt: now().toISOString() };
    try {
      writeLedger(ledger, ledgerFile);
      created.push(entry);
    } catch (e) {
      created.push({ ...entry, warning: `created, but the team ledger could not be saved (${e && e.message ? e.message : e})` });
    }
  }
  return { created, skipped };
}

function createTeam({ available, lead, only = null, deps = {} } = {}) {
  const job = lock.then(() => run({ available, lead, only, deps: deps || {} }));
  lock = job.then(() => undefined, () => undefined);
  return job;
}

function markSkipped({ ledgerFile = LEDGER_FILE, now = () => new Date() } = {}) {
  const ledger = readLedger(ledgerFile);
  ledger.skippedAt = now().toISOString();
  writeLedger(ledger, ledgerFile);
  return ledger;
}

module.exports = { ROLES, TEMPLATES_DIR, LEDGER_FILE, readLedger, writeLedger, planTeam, createTeam, markSkipped };
