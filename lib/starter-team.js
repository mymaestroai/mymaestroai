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

/** The ledger; a missing file is an empty one. Anything else that is not exactly a ledger (unreadable, not JSON, no
 *  `roles` object, a role entry without a name) is marked unreadable: createTeam and markSkipped then write and create
 *  nothing, since an empty-looking ledger could bring back a starter the owner deleted. */
function readLedger(file = LEDGER_FILE) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { return e && e.code === 'ENOENT' ? { roles: {} } : { roles: {}, unreadable: true }; }
  let doc;
  try { doc = JSON.parse(text); } catch { return { roles: {}, unreadable: true }; }
  const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!plain(doc) || !plain(doc.roles)) return { roles: {}, unreadable: true };
  for (const v of Object.values(doc.roles)) if (!plain(v) || typeof v.name !== 'string' || !v.name) return { roles: {}, unreadable: true };
  return {
    roles: doc.roles,
    ...(typeof doc.skippedAt === 'string' ? { skippedAt: doc.skippedAt } : {}),
    ...(typeof doc.cardAnsweredAt === 'string' ? { cardAnsweredAt: doc.cardAnsweredAt } : {}),
    ...(plain(doc.offers) ? { offers: doc.offers } : {}),
  };
}

function writeLedger(ledger, file = LEDGER_FILE) {
  if (!ledger || ledger.unreadable) throw new Error('the team ledger could not be read, so it is not overwritten');
  const out = {
    roles: ledger.roles || {},
    ...(ledger.skippedAt ? { skippedAt: ledger.skippedAt } : {}),
    ...(ledger.cardAnsweredAt ? { cardAnsweredAt: ledger.cardAnsweredAt } : {}),
    ...(ledger.offers && typeof ledger.offers === 'object' && !Array.isArray(ledger.offers) ? { offers: ledger.offers } : {}),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
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
    const had = roles[r.role];
    // A reservation that never became "created": a setup that stopped between the two. Whether the agent was made and
    // later deleted can't be told, so it is never made again by the hub.
    if (had) return { ...entry, action: 'skip', reason: had.status === 'reserved' && !list.some((a) => a && a.name === had.name) ? 'interrupted' : 'created before' };
    let twin = null;
    try { twin = require('./agents').twinOf(list, r.display, null); } catch { twin = null; }
    if (list.some((a) => a && a.name === r.name) || twin) return { ...entry, action: 'skip', reason: 'name taken' };
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

async function run({ available, lead, only, expect, deps }) {
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
  // `expect`: the roles and models a person was shown as "to create". If the plan differs now (another model, a role
  // added or gone), nothing is created and the new plan goes back for a new look.
  if (Array.isArray(expect)) {
    const want = new Map(expect.map((x) => [x.role, x.model]));
    const now = plan.filter((e) => e.action === 'create');
    if (now.length !== want.size || now.some((e) => want.get(e.role) !== e.model)) return { created, skipped, changed: true, plan };
  }
  if (ledger.unreadable) {
    const error = `the team ledger ${path.basename(ledgerFile)} can't be read, so no starter agent is created`;
    return { created, skipped: plan.map((e) => (e.action === 'create' ? { ...e, action: 'skip', reason: 'failed', error } : e)) };
  }
  const save = () => writeLedger(ledger, ledgerFile);
  for (const entry of plan) {
    const wanted = !Array.isArray(only) || only.includes(entry.role);
    if (entry.action !== 'create' || !wanted) { skipped.push(entry); continue; }
    const r = ROLES.find((x) => x.role === entry.role);
    const fail = (e) => skipped.push({ ...entry, action: 'skip', reason: 'failed', error: e && e.message ? e.message : String(e) });
    let files;
    try { files = readTemplates(templatesDir, entry.role); } catch (e) { fail(e); continue; }
    // 1. The role is reserved in the ledger before anything is made: a ledger that can't be saved means no agent.
    ledger.roles[entry.role] = { name: r.name, model: entry.model, status: 'reserved', reservedAt: now().toISOString() };
    try { save(); } catch (e) { delete ledger.roles[entry.role]; fail(new Error(`the team ledger could not be saved (${e.message}), so the agent was not created`)); continue; }
    // 2. The agent.
    let res, threw = null;
    try { res = await createAgent(r.name, entry.model, null, null, 'worker', null, { display: r.display, icon: r.icon, blurb: r.blurb, files, teamRole: r.teamRole, teamModelBy: 'hub' }); }
    catch (e) { threw = e; }
    let made = !threw && res && res.success === true;
    if (threw) {
      // Unknown outcome: made if the agent is there now; otherwise the reservation stays (an agent that is not there
      // may have been made and removed meanwhile), so the hub never makes this role again.
      try { made = (await getAgents(true)).some((a) => a && a.name === r.name); } catch { made = false; }
      if (!made) { fail(new Error(`${threw.message || threw}; the outcome is unknown, so its reservation stays in the team ledger`)); continue; }
    }
    if (!made) {
      // createAgent made nothing (it reported so, or the agent isn't there): the reservation is taken back. If that
      // can't be saved, the role stays reserved and is never made by the hub: the safe way round.
      delete ledger.roles[entry.role];
      let kept = '';
      try { save(); } catch { ledger.roles[entry.role] = { name: r.name, model: entry.model, status: 'reserved', reservedAt: now().toISOString() }; kept = '; its reservation stays in the team ledger'; }
      fail(new Error(`${(threw && threw.message) || (res && res.error) || 'the agent was not created'}${kept}`));
      continue;
    }
    // 3. Created. If this last save fails, the reservation already keeps the role from ever being made again.
    ledger.roles[entry.role] = { name: r.name, model: entry.model, status: 'created', createdAt: now().toISOString() };
    try { save(); created.push(entry); }
    catch (e) { created.push({ ...entry, warning: `created; the team ledger still lists it as reserved (${e.message})` }); }
  }
  return { created, skipped };
}

function createTeam({ available, lead, only = null, expect = null, deps = {} } = {}) {
  const job = lock.then(() => run({ available, lead, only, expect, deps: deps || {} }));
  lock = job.then(() => undefined, () => undefined);
  return job;
}

/** "Skip the team": recorded under the same lock as createTeam, so it never writes over a run's saves. */
function markSkipped({ ledgerFile = LEDGER_FILE, now = () => new Date() } = {}) {
  const job = lock.then(() => {
    const ledger = readLedger(ledgerFile);
    if (ledger.unreadable) throw new Error('the team ledger can\'t be read, so it is left as it is');
    ledger.skippedAt = now().toISOString();
    writeLedger(ledger, ledgerFile);
    return ledger;
  });
  lock = job.then(() => undefined, () => undefined);
  return job;
}

/** "Not now" on the Set up your team card: `cardAnsweredAt`, under the same lock (same refusal of an unreadable ledger). */
function markCardAnswered({ ledgerFile = LEDGER_FILE, now = () => new Date() } = {}) {
  const job = lock.then(() => {
    const ledger = readLedger(ledgerFile);
    if (ledger.unreadable) throw new Error('the team ledger can\'t be read, so it is left as it is');
    ledger.cardAnsweredAt = now().toISOString();
    writeLedger(ledger, ledgerFile);
    return ledger;
  });
  lock = job.then(() => undefined, () => undefined);
  return job;
}

/** Later model offers (lib/team-offers): `offers[role] = { model, since }` for each offer, under the same lock. */
function recordOffers(offers, { ledgerFile = LEDGER_FILE, now = () => new Date() } = {}) {
  const job = lock.then(() => {
    const ledger = readLedger(ledgerFile);
    if (ledger.unreadable) throw new Error('the team ledger can\'t be read, so it is left as it is');
    const list = Array.isArray(offers) ? offers.filter((o) => o && typeof o.role === 'string' && typeof o.to === 'string') : [];
    if (!list.length) return ledger;
    ledger.offers = { ...(ledger.offers || {}) };
    const at = now().toISOString();
    let changed = false;
    for (const o of list) {
      // Every model ever offered for a role is kept (seen), and checked here under the lock: a model is offered once,
      // even when the reachable models change back and forth.
      const had = ledger.offers[o.role] && typeof ledger.offers[o.role] === 'object' ? ledger.offers[o.role] : {};
      const seen = Array.isArray(had.seen) ? had.seen.filter((m) => typeof m === 'string') : (typeof had.model === 'string' ? [had.model] : []);
      if (seen.includes(o.to)) continue;
      ledger.offers[o.role] = { model: o.to, since: at, ...(typeof o.why === 'string' && o.why ? { why: o.why } : {}), seen: [...seen, o.to] };
      changed = true;
    }
    if (changed) writeLedger(ledger, ledgerFile);
    return ledger;
  });
  lock = job.then(() => undefined, () => undefined);
  return job;
}

module.exports = { ROLES, TEMPLATES_DIR, LEDGER_FILE, readLedger, writeLedger, planTeam, createTeam, markSkipped, markCardAnswered, recordOffers };
