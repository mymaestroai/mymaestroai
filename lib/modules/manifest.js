'use strict';
/**
 * Module manifests: modules/<id>/module.json (what the module is, what it needs, which tools it exposes and how
 * risky each is) and modules/<id>/setup.json (the guided setup). Validated here so a broken module is reported
 * on the Modules page instead of half-working. No module is named in this file: everything is data.
 */

const fs = require('fs');
const path = require('path');

const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const RISKS = ['read', 'write', 'send', 'money'];
const TOOL_CLASSES = ['read', 'write', 'send', 'money', 'off'];    // off = never shown to an agent
const SETTING_TYPES = ['boolean', 'number', 'string', 'list', 'choice'];
const STEP_TYPES = ['explain', 'outside', 'install', 'secrets', 'check', 'settings', 'grant', 'finish'];
const SECRET_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const str = (v) => typeof v === 'string' && v.trim().length > 0;

function readJson(file) {
  try { return { value: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch (e) { return { error: `${path.basename(file)}: ${e.code === 'ENOENT' ? 'missing' : e.message}` }; }
}

/** validateManifest(m, dirName) -> { problems: [] (empty = valid), secretNames, settingKeys } */
function validateManifest(m, dirName) {
  const p = [];
  if (!m || typeof m !== 'object') return { problems: ['module.json is not an object'], secretNames: new Set(), settingKeys: new Set() };
  if (!ID_RE.test(String(m.id || ''))) p.push('id: lowercase letters, digits and dashes, 2-32 characters');
  if (dirName && m.id !== dirName) p.push(`id "${m.id}" must match the folder name "${dirName}"`);
  for (const k of ['name', 'category', 'summary']) if (!str(m[k])) p.push(`${k} is required`);
  if (!RISKS.includes(m.risk)) p.push(`risk must be one of ${RISKS.join(', ')}`);
  const s = m.server;
  if (!s || typeof s !== 'object') p.push('server is required');
  else {
    if (s.type !== 'mcp-stdio') p.push('server.type must be "mcp-stdio"');
    if (s.npm) {
      if (!str(s.npm.package)) p.push('server.npm.package is required');
      if (!EXACT_VERSION_RE.test(String(s.npm.version || ''))) p.push('server.npm.version must be an exact version (no ranges): updates are deliberate');
      if (!str(s.npm.bin)) p.push('server.npm.bin is required');
    } else if (!str(s.script)) p.push('server needs npm {package, version, bin} or a script inside the module folder');
    else if (path.isAbsolute(s.script) || s.script.split(/[\\/]/).includes('..')) p.push('server.script must be a file inside the module folder');
    if (s.args !== undefined && !Array.isArray(s.args)) p.push('server.args must be a list');
    if (s.env !== undefined && (typeof s.env !== 'object' || Array.isArray(s.env))) p.push('server.env must be an object');
    if (s.dataEnv !== undefined && !SECRET_RE.test(s.dataEnv)) p.push('server.dataEnv must be an environment variable name');
  }
  const secretNames = new Set();
  for (const sec of m.secrets || []) {
    if (!SECRET_RE.test(String(sec && sec.name))) p.push(`secret name "${sec && sec.name}": UPPER_CASE`);
    else secretNames.add(sec.name);
    if (!str(sec && sec.label)) p.push(`secret ${sec && sec.name}: label is required`);
  }
  const settingKeys = new Set();
  for (const st of m.settings || []) {
    if (!str(st && st.key)) { p.push('a setting has no key'); continue; }
    settingKeys.add(st.key);
    if (!SETTING_TYPES.includes(st.type)) p.push(`setting ${st.key}: type must be one of ${SETTING_TYPES.join(', ')}`);
    if (!str(st.label)) p.push(`setting ${st.key}: label is required`);
    if (st.type === 'choice' && !(Array.isArray(st.options) && st.options.length)) p.push(`setting ${st.key}: choice needs options`);
    if (st.default === undefined) p.push(`setting ${st.key}: default is required (setups must be safe without edits)`);
  }
  if (!m.tools || typeof m.tools !== 'object') p.push('tools is required (tool name -> read | write | send | money | off)');
  else for (const [t, cls] of Object.entries(m.tools)) if (!TOOL_CLASSES.includes(cls)) p.push(`tool ${t}: class must be one of ${TOOL_CLASSES.join(', ')}`);
  if (m.tools && m.risk !== 'money' && Object.values(m.tools).includes('money')) p.push('a module with money tools must declare risk "money"');
  return { problems: p, secretNames, settingKeys };
}

function validateSetup(setup, { secretNames, settingKeys }, checks = {}) {
  const p = [];
  if (!setup || !Array.isArray(setup.steps) || !setup.steps.length) return ['setup.json needs a non-empty steps list'];
  const ids = new Set();
  for (const st of setup.steps) {
    if (!st || !str(st.id)) { p.push('a step has no id'); continue; }
    if (ids.has(st.id)) p.push(`step ${st.id}: duplicate id`);
    ids.add(st.id);
    if (!STEP_TYPES.includes(st.type)) p.push(`step ${st.id}: type must be one of ${STEP_TYPES.join(', ')}`);
    if (!str(st.title)) p.push(`step ${st.id}: title is required`);
    if (st.type === 'secrets') for (const f of st.fields || []) if (!secretNames.has(f)) p.push(`step ${st.id}: unknown secret ${f}`);
    if (st.type === 'settings') for (const f of st.fields || []) if (!settingKeys.has(f)) p.push(`step ${st.id}: unknown setting ${f}`);
    if (st.type === 'check' && !(st.check && typeof checks[st.check] === 'function')) p.push(`step ${st.id}: check "${st.check}" is not exported by the module's index.js`);
    for (const l of st.links || []) if (!/^https:\/\//.test(String(l && l.url))) p.push(`step ${st.id}: links must be https`);
  }
  if (setup.steps[setup.steps.length - 1].type !== 'finish') p.push('the last step must be "finish"');
  return p;
}

/** Load one module folder: { id, dir, manifest, setup, code, problems[] }. Never throws. */
function loadModule(dir) {
  dir = path.resolve(dir);
  const dirName = path.basename(dir);
  const out = { id: dirName, dir, manifest: null, setup: null, code: {}, problems: [] };
  const m = readJson(path.join(dir, 'module.json'));
  if (m.error) { out.problems.push(m.error); return out; }
  out.manifest = m.value;
  const v = validateManifest(m.value, dirName);
  out.problems.push(...v.problems);
  if (fs.existsSync(path.join(dir, 'index.js'))) {
    try { out.code = require(path.join(dir, 'index.js')) || {}; }
    catch (e) { out.problems.push(`index.js: ${e.message}`); }
  }
  const s = readJson(path.join(dir, 'setup.json'));
  if (s.error) out.problems.push(s.error);
  else { out.setup = s.value; out.problems.push(...validateSetup(s.value, v, out.code.checks || {})); }
  return out;
}

/** Every folder under root that has a module.json. */
function discover(root) {
  let names = [];
  try { names = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort(); } catch { return []; }
  return names.filter(n => fs.existsSync(path.join(root, n, 'module.json'))).map(n => loadModule(path.join(root, n)));
}

/** Settings with defaults applied and types enforced; throws on an invalid value. */
function coerceSettings(manifest, values = {}, current = {}) {
  const out = {};
  for (const st of manifest.settings || []) {
    let v = values[st.key] !== undefined ? values[st.key] : current[st.key] !== undefined ? current[st.key] : st.default;
    if (st.type === 'boolean') v = v === true || v === 'true' || v === 'on';
    else if (st.type === 'number') {
      v = Number(v);
      if (!Number.isFinite(v)) throw new Error(`${st.label}: a number is needed`);
      if (st.min !== undefined && v < st.min) throw new Error(`${st.label}: at least ${st.min}`);
      if (st.max !== undefined && v > st.max) throw new Error(`${st.label}: at most ${st.max}`);
    } else if (st.type === 'list') {
      v = (Array.isArray(v) ? v : String(v || '').split(/[,\n]/)).map(x => String(x).trim()).filter(Boolean);
      if (st.pattern) { const re = new RegExp(st.pattern); for (const x of v) if (!re.test(x)) throw new Error(`${st.label}: "${x}" is not valid`); }
    } else if (st.type === 'choice') {
      const opts = st.options.map(o => (typeof o === 'object' ? o.value : o));
      if (st.multiple) { v = (Array.isArray(v) ? v : [v]).filter(x => opts.includes(x)); }
      else if (!opts.includes(v)) throw new Error(`${st.label}: choose one of ${opts.join(', ')}`);
    } else v = String(v == null ? '' : v);
    out[st.key] = v;
  }
  return out;
}

/** Stored settings for reading (the guard, the page): a missing or invalid value becomes the manifest default. */
function safeSettings(manifest, raw = {}) {
  const out = {};
  for (const st of (manifest && manifest.settings) || []) {
    try { Object.assign(out, coerceSettings({ settings: [st] }, {}, { [st.key]: raw[st.key] })); }
    catch { Object.assign(out, coerceSettings({ settings: [st] }, {}, {})); }
  }
  return out;
}

module.exports = { discover, loadModule, validateManifest, validateSetup, coerceSettings, safeSettings, ID_RE, RISKS, TOOL_CLASSES, STEP_TYPES };
