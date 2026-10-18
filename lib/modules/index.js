'use strict';
/**
 * Hub modules: optional capabilities (an exchange, a mail account, a search service...) that an admin adds with a
 * guided setup. Each module is one folder, modules/<id>/:
 *   module.json  what it is, its risk (read | write | send | money), what it needs, its secrets and settings,
 *                the tool server to run (an npm package at an exact version, or a script in the folder) and the
 *                class of every tool it exposes (unlisted tools stay hidden)
 *   setup.json   the guided setup: explain / outside / install / secrets / check / settings / grant / finish steps
 *   index.js     optional module code: checks used by "check" steps, guard() for per-call limits (lib/modules/mcp-guard)
 * A module runs as a data connector (lib/connectors) whose command is the guard: secrets live in the connector
 * vault, agent grants and the tool policy (lib/tool-policy) work exactly as for any connector. Money tools reach
 * wallet agents only (settings.walletAgents); the module's guard sets their limits.
 * State: data/modules.json { modules: { <id>: { settings, steps: { <stepId>: { doneAt } }, installed, lastCheck,
 * finishedAt, enabled } } }. Package installs and the module's own files: data/modules/<id>/.
 */

const fs = require('fs');
const path = require('path');
const manifestLib = require('./manifest');
const installer = require('./installer');

const HUB = path.join(__dirname, '..', '..');
const GUARD = path.join(__dirname, 'mcp-guard.js');

function createModules({
  root = path.join(HUB, 'modules'),
  dataDir = path.join(HUB, 'data', 'modules'),
  stateFile = path.join(HUB, 'data', 'modules.json'),
  connectorsFile = path.join(HUB, 'data', 'connectors.json'),
  connectors,
  isWalletAgent = () => false,
  isMemberOwned = () => false,
  listAgents = () => [],
  publish = () => {},
  log = (...a) => console.log('[modules]', ...a),
  runNpm,
  now = Date.now,
} = {}) {
  if (!connectors) throw new Error('modules need the connectors store');
  let cache = null;
  const all = () => { if (!cache) cache = manifestLib.discover(root); return cache; };
  const reload = () => { cache = null; return all(); };
  const find = (id) => all().find(m => m.id === id) || null;
  const must = (id) => {
    const m = find(id); if (!m) throw new Error(`No module "${id}".`);
    if (m.problems.length) throw new Error(`Module "${id}" is broken: ${m.problems.join('; ')}`);
    return m;
  };

  // ── state ──
  function loadState() { try { const s = JSON.parse(fs.readFileSync(stateFile, 'utf8')); return s && typeof s === 'object' && s.modules ? s : { modules: {} }; } catch { return { modules: {} }; } }
  function saveState(s) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 }); fs.renameSync(tmp, stateFile);
  }
  function stateOf(id) { return loadState().modules[id] || null; }
  function update(id, fn) { const s = loadState(); s.modules[id] = fn(s.modules[id] || { steps: {} }) || s.modules[id]; saveState(s); publish('modules_changed', { id }); return s.modules[id]; }
  const stamp = () => new Date(now()).toISOString();

  // ── connector glue ──
  const connectorOf = (id) => (connectors.list().connectors || []).find(c => c.id === id) || null;
  function ensureConnector(m) {
    const existing = connectorOf(m.id);
    if (existing && existing.module !== m.id) throw new Error(`A connector named "${m.id}" already exists and is not this module's; rename or remove it on the Connectors page first.`);
    const toolClasses = {};
    for (const [t, cls] of Object.entries(m.manifest.tools)) if (cls !== 'off') toolClasses[t] = { cls };
    return connectors.upsert({
      id: m.id, label: m.manifest.name, kind: 'mcp', module: m.id,
      command: process.execPath, args: [GUARD, m.id, '--root', root, '--data', dataDir, '--state', stateFile, '--connectors', connectorsFile],
      dataHome: path.join(dataDir, m.id, 'home'), tools: toolClasses, sensitive: false,
      notes: `Managed by the "${m.manifest.name}" module (Modules page). Edit it there.`,
      ...(existing ? {} : { enabled: false, agents: [] }),
    }, { byModule: true });
  }
  /** Keep every installed module's connector in step with its manifest (tool classes, guard arguments). */
  function syncConnectors() {
    for (const m of all()) {
      if (m.problems.length || !stateOf(m.id) || !connectorOf(m.id)) continue;
      try { ensureConnector(m); } catch (e) { log(`${m.id}: could not sync its connector: ${e.message}`); }
    }
  }

  // ── status ──
  function statusOf(m) {
    if (m.problems.length) return { state: 'broken', note: m.problems.join('; ') };
    const st = stateOf(m.id);
    if (!st) return { state: 'available' };
    const c = connectorOf(m.id);
    if (!st.finishedAt) {
      const steps = m.setup.steps; const next = steps.find(s => !(st.steps && st.steps[s.id]));
      return { state: 'setup', note: next ? `Next: ${next.title}` : 'Ready to finish', next: next ? next.id : null };
    }
    if (!c) return { state: 'attention', note: 'Its connector is missing; run the setup again.' };
    const missing = (m.manifest.secrets || []).filter(sec => !sec.optional && !c.secretNames.includes(sec.name)).map(sec => sec.label);
    if (missing.length) return { state: 'attention', note: `Missing: ${missing.join(', ')}` };
    if (m.manifest.server.npm && !installer.binPath(dataDir, m.id, m.manifest.server.npm)) return { state: 'attention', note: 'Its tool server is not installed; run the Install step again.' };
    if (st.lastCheck && !st.lastCheck.ok) return { state: 'attention', note: `Last check failed: ${st.lastCheck.summary}` };
    if (!c.enabled) return { state: 'off', note: 'Set up, switched off.' };
    return { state: 'ready', note: c.agents && c.agents.length ? `Used by ${c.agents.join(', ')}` : 'No agent has it yet.' };
  }

  function summary(m) {
    const man = m.manifest || {};
    return { id: m.id, name: man.name || m.id, category: man.category || 'Other', summary: man.summary || '', risk: man.risk || null, icon: man.icon || null, ...statusOf(m) };
  }
  function list() { return all().map(summary); }

  function detail(id) {
    const m = find(id); if (!m) throw new Error(`No module "${id}".`);
    const st = stateOf(id) || { steps: {} };
    const c = connectorOf(id);
    const settings = m.manifest ? manifestLib.safeSettings(m.manifest, st.settings || {}) : {};
    return {
      ...summary(m), problems: m.problems,
      manifest: m.manifest && { ...m.manifest, server: { ...m.manifest.server } },
      steps: (m.setup ? m.setup.steps : []).map(s => ({ ...s, done: !!(st.steps && st.steps[s.id]), doneAt: st.steps && st.steps[s.id] ? st.steps[s.id].doneAt : null })),
      settings, secretsSet: c ? c.secretNames : [], agents: c ? (c.agents || []) : [], enabled: !!(c && c.enabled),
      installed: m.manifest && m.manifest.server.npm ? !!installer.binPath(dataDir, id, m.manifest.server.npm) : true,
      lastCheck: st.lastCheck || null, finishedAt: st.finishedAt || null,
      candidates: grantCandidates(m),
    };
  }

  function grantCandidates(m) {
    const agents = listAgents().filter(a => a && a.name);
    return agents.filter(a => !isMemberOwned(a)).map(a => {
      const why = m.manifest && m.manifest.risk === 'money' && !isWalletAgent(a.name) ? 'not a wallet agent (settings.walletAgents)' : null;
      return { name: a.name, display: a.display || a.name, eligible: !why, why };
    });
  }

  const markDone = (id, stepId, extra = {}) => update(id, s => { s.steps = s.steps || {}; s.steps[stepId] = { doneAt: stamp(), ...extra }; return s; });

  // ── steps ──
  async function runStep(id, stepId, input = {}) {
    const m = must(id);
    const step = m.setup.steps.find(s => s.id === stepId);
    if (!step) throw new Error(`No step "${stepId}" in ${m.manifest.name}.`);
    let result = {};
    switch (step.type) {
      case 'explain':
      case 'outside':
        if (step.confirm && input.confirmed !== true) throw new Error(`Tick "${step.confirm}" to continue.`);
        break;
      case 'install': {
        if (m.manifest.server.npm) {
          const r = await installer.install({ dataDir, id, npm: m.manifest.server.npm, requires: m.manifest.requires || {}, runNpm });
          result = { installed: r.version, log: r.log };
        }
        ensureConnector(m);
        update(id, s => { s.installed = m.manifest.server.npm ? m.manifest.server.npm.version : 'script'; s.settings = manifestLib.safeSettings(m.manifest, s.settings || {}); return s; });
        log(`${id}: installed ${result.installed || 'script'}`);
        break;
      }
      case 'secrets': {
        if (!connectorOf(id)) throw new Error('Run the Install step first.');
        const values = {};
        if (input.keyFile && step.keyFile && step.keyFile.fields) {
          let j; try { j = JSON.parse(String(input.keyFile)); } catch { throw new Error('That key file is not valid JSON.'); }
          for (const [name, keys] of Object.entries(step.keyFile.fields)) { const k = keys.find(x => typeof j[x] === 'string' && j[x]); if (k) values[name] = j[k]; }
        }
        for (const f of step.fields || []) if (typeof (input.values || {})[f] === 'string' && input.values[f].trim()) values[f] = input.values[f].trim();
        const have = connectorOf(id).secretNames;
        const missing = (step.fields || []).filter(f => !values[f] && !have.includes(f) && !((m.manifest.secrets || []).find(s => s.name === f) || {}).optional);
        if (missing.length) throw new Error(`Still needed: ${missing.map(f => ((m.manifest.secrets || []).find(s => s.name === f) || {}).label || f).join(', ')}.`);
        if (Object.keys(values).length) connectors.upsert({ id, secrets: values }, { byModule: true });
        result = { saved: Object.keys(values) };
        log(`${id}: secrets saved (${Object.keys(values).join(', ') || 'unchanged'})`);
        break;
      }
      case 'settings': {
        const st = stateOf(id) || {};
        const next = manifestLib.coerceSettings(m.manifest, input.values || {}, manifestLib.safeSettings(m.manifest, st.settings || {}));
        update(id, s => { s.settings = next; return s; });
        result = { settings: next };
        break;
      }
      case 'check': {
        const r = await check(id, step.check);
        if (!r.ok) { const e = new Error(r.summary || 'The check failed.'); e.check = r; throw e; }
        if (r.ackRequired && input.acknowledged !== true) { const e = new Error(r.ackRequired); e.check = r; e.needsAck = true; throw e; }
        result = { check: r };
        break;
      }
      case 'grant': {
        const names = Array.isArray(input.agents) ? input.agents.map(String) : [];
        const cand = new Map(grantCandidates(m).map(c => [c.name, c]));
        for (const n of names) {
          const c = cand.get(n);
          if (!c) throw new Error(`"${n}" is not an agent this module can be given to (unknown, or owned by a member).`);
          if (!c.eligible) throw new Error(`"${n}" cannot use ${m.manifest.name}: ${c.why}.`);
        }
        if (!connectorOf(id)) throw new Error('Run the Install step first.');
        connectors.upsert({ id, agents: names }, { byModule: true });
        result = { agents: names };
        log(`${id}: granted to ${names.join(', ') || 'nobody'}`);
        break;
      }
      case 'finish': {
        const st = stateOf(id) || { steps: {} };
        const open = m.setup.steps.filter(s => s.type !== 'finish' && !s.optional && !(st.steps && st.steps[s.id]));
        if (open.length) throw new Error(`Not finished yet: ${open.map(s => s.title).join('; ')}.`);
        connectors.upsert({ id, enabled: true }, { byModule: true });
        update(id, s => { s.finishedAt = stamp(); return s; });
        log(`${id}: setup finished, switched on`);
        break;
      }
      default: throw new Error(`Unknown step type ${step.type}.`);
    }
    markDone(id, stepId);
    return { ok: true, step: stepId, result, module: detail(id) };
  }

  /** Run one of the module's checks through its connector (so through the guard, like an agent's call). */
  async function check(id, name) {
    const m = must(id);
    const fn = m.code.checks && m.code.checks[name || Object.keys(m.code.checks || {})[0]];
    if (typeof fn !== 'function') throw new Error(`${m.manifest.name} has no check "${name}".`);
    if (!connectorOf(id)) throw new Error('Run the Install step first.');
    let r;
    const st = stateOf(id) || {};
    try {
      r = await fn({ callTool: (tool, args) => connectors.callTool(id, tool, args), settings: manifestLib.safeSettings(m.manifest, st.settings || {}), parse: parseToolText });
    } catch (e) { r = { ok: false, summary: e.message }; }
    r = { ok: !!r.ok, summary: String(r.summary || (r.ok ? 'OK' : 'Failed')).slice(0, 500), lines: (r.lines || []).map(String).slice(0, 30), warnings: (r.warnings || []).map(String).slice(0, 10), ackRequired: r.ackRequired || null, at: stamp() };
    update(id, s => { s.lastCheck = r; return s; });
    return r;
  }

  function saveSettings(id, values) {
    const m = must(id);
    const st = stateOf(id) || {};
    const next = manifestLib.coerceSettings(m.manifest, values || {}, manifestLib.safeSettings(m.manifest, st.settings || {}));
    update(id, s => { s.settings = next; return s; });
    log(`${id}: settings changed`);
    return detail(id);
  }
  function setEnabled(id, on) {
    must(id);
    if (on && !(stateOf(id) || {}).finishedAt) throw new Error('Finish the setup first.');
    connectors.upsert({ id, enabled: !!on }, { byModule: true });
    publish('modules_changed', { id });
    return detail(id);
  }
  function remove(id, { keepPackage = false } = {}) {
    const m = find(id); if (!m) throw new Error(`No module "${id}".`);
    const c = connectorOf(id);
    if (c && c.module === id) connectors.remove(id, { byModule: true });
    if (!keepPackage) installer.uninstall(dataDir, id);
    const s = loadState(); delete s.modules[id]; saveState(s);
    publish('modules_changed', { id });
    log(`${id}: removed (audit log kept in ${path.join(dataDir, id)})`);
    return { ok: true };
  }
  function auditTail(id, n = 50) {
    try { return fs.readFileSync(path.join(dataDir, id, 'audit.jsonl'), 'utf8').trim().split('\n').slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse(); } catch { return []; }
  }
  /** Items for the Setup checklist (lib/readiness): modules started but not finished, or needing attention. */
  function readinessItems() {
    return list().filter(x => x.state === 'setup' || x.state === 'attention' || x.state === 'broken').map(x => ({
      id: `module-${x.id}`, level: x.state === 'broken' ? 'warn' : 'info',
      title: `${x.name}: ${x.state === 'setup' ? 'setup not finished' : x.state === 'broken' ? 'module files are broken' : 'needs attention'}`,
      detail: x.note || '', fix: 'Open the Modules page.', action: { href: `/modules#${x.id}` },
    }));
  }

  return { list, detail, runStep, check, saveSettings, setEnabled, remove, auditTail, readinessItems, reload, syncConnectors };
}

/** Tool results arrive as text; most servers send JSON text. */
function parseToolText(text) {
  if (text && typeof text === 'object') return text;
  const s = String(text || '').trim();
  try { return JSON.parse(s); } catch {}
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return JSON.parse(s.slice(i, j + 1)); } catch {} }
  return null;
}

let singleton = null;
function getModules() {
  if (!singleton) {
    const connectors = require('../connectors').getConnectors();
    let publish = () => {}; try { const ev = require('../hub-events').events; publish = (t, d) => ev.publish(t, d); } catch {}
    const adminIds = () => { try { return new Set(require('../auth').getAuth().admins().map(u => String(u.id))); } catch { return new Set(); } };
    singleton = createModules({
      connectors, publish,
      isWalletAgent: (name) => { try { return require('../wallet/tools').isWalletAgent(name); } catch { return false; } },
      isMemberOwned: (a) => !!(a && a.owner && !adminIds().has(String(a.owner))),
      listAgents: () => { try { return require('../agents').getAgentsSync(); } catch { return []; } },
    });
    singleton.syncConnectors();
  }
  return singleton;
}

module.exports = { createModules, getModules, parseToolText };
