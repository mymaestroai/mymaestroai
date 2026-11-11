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
const TOOL_CLASSES = ['read', 'write', 'send', 'money', 'off', 'hub'];    // off = never shown to an agent; hub = called by the hub itself, never shown to an agent
const BACKUP_TOOLS = ['backup_put', 'backup_list', 'backup_delete', 'backup_get'];
const SETTING_TYPES = ['boolean', 'number', 'string', 'list', 'choice'];
const STEP_TYPES = ['explain', 'outside', 'install', 'secrets', 'check', 'settings', 'grant', 'signin', 'finish'];
const STEP_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
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
    if (s.background !== undefined && typeof s.background !== 'boolean') p.push('server.background must be true or false');
    if (s.callTimeoutSec !== undefined && !(Number.isInteger(s.callTimeoutSec) && s.callTimeoutSec >= 10 && s.callTimeoutSec <= 300)) p.push('server.callTimeoutSec must be a whole number from 10 to 300');
    if (s.callerIdentity !== undefined && typeof s.callerIdentity !== 'boolean') p.push('server.callerIdentity must be true or false');
  }
  for (const k of ['notify', 'approvals']) if (m[k] !== undefined && typeof m[k] !== 'boolean') p.push(`${k} must be true or false`);
  if (m.media !== undefined && typeof m.media !== 'boolean' && m.media !== 'common') p.push('media must be true or false (or "common" for the shared folder)');
  validateRuntimeShape(m, p);
  validateReceiver(m, p);
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
  validateLevels(m, p);
  if (!m.tools || typeof m.tools !== 'object') p.push('tools is required (tool name -> read | write | send | money | off | hub)');
  else for (const [t, cls] of Object.entries(m.tools)) if (!TOOL_CLASSES.includes(cls)) p.push(`tool ${t}: class must be one of ${TOOL_CLASSES.join(', ')}`);
  if (m.backup !== undefined && typeof m.backup !== 'boolean') p.push('backup must be true or false');
  else if (m.backup === true && m.tools && typeof m.tools === 'object') {
    for (const t of BACKUP_TOOLS) {
      if (!(t in m.tools)) p.push(`a backup module must declare the tool ${t} (class "hub")`);
      else if (m.tools[t] !== 'hub') p.push(`tool ${t}: a backup tool must have class "hub"`);
    }
  }
  if (m.tools && m.risk !== 'money' && Object.values(m.tools).includes('money')) p.push('a module with money tools must declare risk "money"');
  validateCatalog(m, p);
  validateOauth(m, p, secretNames);
  if (m.rotatingSecret !== undefined) {
    const sec = (m.secrets || []).find(x => x && x.name === m.rotatingSecret);
    if (typeof m.rotatingSecret !== 'string' || !secretNames.has(m.rotatingSecret)) p.push(`rotatingSecret: "${m.rotatingSecret}" is not declared in secrets`);
    else if (sec.optional !== true) p.push(`rotatingSecret: "${m.rotatingSecret}" must be an optional secret`);
  }
  return { problems: p, secretNames, settingKeys, hasOauth: !!m.oauth, protectedKeys: new Set(protectedSettingKeys(m)) };
}

const https = (u) => { try { return new URL(String(u)).protocol === 'https:'; } catch { return false; } };
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

const LEVEL_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const LEVEL_ENTRY_RE = /^([^:\s,]{1,64}):([^:\s]{1,32})$/;   // "agent:level"; the agent part never holds a colon, a space or a comma

/**
 * levels (optional): per-agent permission levels kept in two list settings, edited only through the permission editor
 * ({ setting, choices: [lowest ... highest], default, sessionApproval?: { setting, levels } }). `setting` holds "agent:level"
 * entries; `sessionApproval.setting` lists the agents that run without asking at the listed levels (default: nobody, so
 * every session is asked). Both settings are protected: the generic settings save and the setup steps never write them.
 */
function validateLevels(m, p) {
  if (m.levels === undefined) return;
  const l = m.levels;
  if (!isObj(l)) { p.push('levels must be an object'); return; }
  for (const k of Object.keys(l)) if (!['setting', 'choices', 'default', 'sessionApproval'].includes(k)) p.push(`levels.${k}: unknown field`);
  const defs = new Map((Array.isArray(m.settings) ? m.settings : []).filter(isObj).map(x => [x.key, x]));
  const choices = l.choices;
  let choicesOk = Array.isArray(choices) && choices.length >= 2 && choices.length <= 8 && choices.every(x => typeof x === 'string' && LEVEL_NAME_RE.test(x)) && new Set(choices).size === choices.length;
  if (!choicesOk) p.push('levels.choices must be 2 to 8 different short lowercase names, lowest first');
  if (!choicesOk || !choices.includes(l.default)) p.push('levels.default must be one of levels.choices');
  const backing = (field, what) => {
    if (!str(field)) { p.push(`${what} must name a setting`); return null; }
    const d = defs.get(field);
    if (!d) { p.push(`${what}: "${field}" is not a declared setting`); return null; }
    if (d.type !== 'list') { p.push(`${what}: setting ${field} must be of type list`); return null; }
    return d;
  };
  const ld = backing(l.setting, 'levels.setting');
  if (ld && choicesOk) {
    if (!Array.isArray(ld.default)) p.push(`levels.setting: setting ${l.setting} needs a list as its default`);
    else for (const e of ld.default) if (!parseLevelEntry(e, choices)) p.push(`levels.setting: default entry "${String(e).slice(0, 40)}" is not agent:level with a level from levels.choices`);
  }
  if (l.sessionApproval === undefined) return;
  const sa = l.sessionApproval;
  if (!isObj(sa)) { p.push('levels.sessionApproval must be an object'); return; }
  for (const k of Object.keys(sa)) if (!['setting', 'levels'].includes(k)) p.push(`levels.sessionApproval.${k}: unknown field`);
  const sd = backing(sa.setting, 'levels.sessionApproval.setting');
  if (sd && sa.setting === l.setting) p.push('levels.sessionApproval.setting must differ from levels.setting');
  if (sd && !(Array.isArray(sd.default) && sd.default.length === 0)) p.push(`levels.sessionApproval.setting: setting ${sa.setting} must default to an empty list (every session is asked until the owner says otherwise)`);
  if (!(Array.isArray(sa.levels) && sa.levels.length >= 1 && new Set(sa.levels).size === sa.levels.length && choicesOk && sa.levels.every(x => choices.includes(x)))) p.push('levels.sessionApproval.levels must be a non-empty list of different levels.choices');
}

/** "agent:level" -> { agent, level } when the level is one of `choices`, else null. */
function parseLevelEntry(entry, choices) {
  const m = LEVEL_ENTRY_RE.exec(typeof entry === 'string' ? entry.trim() : '');
  return m && Array.isArray(choices) && choices.includes(m[2]) ? { agent: m[1], level: m[2] } : null;
}

/** The normalized levels block of a VALID manifest ({ setting, choices, default, ask: { setting, levels } | null }), else null. */
function levelsOf(manifest) {
  if (!isObj(manifest) || manifest.levels === undefined) return null;
  const p = []; validateLevels(manifest, p);
  if (p.length) return null;
  const l = manifest.levels, sa = l.sessionApproval;
  return { setting: l.setting, choices: l.choices.slice(), default: l.default, ask: sa ? { setting: sa.setting, levels: sa.levels.slice() } : null };
}

/** Setting keys only the permission editor may write. Tolerant of an invalid block: whatever names it gives are still protected. */
function protectedSettingKeys(manifest) {
  const l = isObj(manifest) && isObj(manifest.levels) ? manifest.levels : null;
  if (!l) return [];
  return [l.setting, isObj(l.sessionApproval) ? l.sessionApproval.setting : undefined].filter(k => typeof k === 'string' && k);
}

/**
 * Effective permissions from the stored settings: Map agent -> { level, asks } (an agent with no entry has the default level;
 * listed twice, the lower level counts, as the module's own gate reads it). `asks` is false only when the agent is in the
 * no-ask list AND its level is one of sessionApproval.levels.
 */
function effectivePermissions(lv, settings = {}) {
  const rank = (x) => lv.choices.indexOf(x);
  const table = new Map();
  for (const e of Array.isArray(settings[lv.setting]) ? settings[lv.setting] : []) {
    const pe = parseLevelEntry(e, lv.choices); if (!pe) continue;
    if (!table.has(pe.agent) || rank(pe.level) < rank(table.get(pe.agent))) table.set(pe.agent, pe.level);
  }
  const noAsk = new Set(lv.ask && Array.isArray(settings[lv.ask.setting]) ? settings[lv.ask.setting].map(x => String(x).trim()) : []);
  const levelOf = (agent) => table.get(agent) || lv.default;
  const asks = (agent) => !(lv.ask && noAsk.has(agent) && lv.ask.levels.includes(levelOf(agent)));
  return { levelOf, asks, table, noAsk };
}

/**
 * A restore must never bring back "run without asking", and never keeps today's list either: for every module the staged state
 * holds, the declared no-ask setting (levels.sessionApproval.setting) and any existing conventional `no_ask_agents` key become an
 * empty list, so every agent asks again. The restored levels are left as they are. `staged` is a parsed data/modules.json object;
 * `modulesRoot` holds the modules' folders. A module whose manifest cannot be read is treated as having the default no-ask key.
 * Returns true when staged changed.
 */
function holdNoAskSettings(staged, modulesRoot) {
  if (!isObj(staged) || !isObj(staged.modules)) return false;
  let changed = false;
  for (const [id, st] of Object.entries(staged.modules)) {
    if (!isObj(st)) continue;
    const keys = [];
    let readable = false;
    if (ID_RE.test(id)) {
      const man = readJson(path.join(modulesRoot, id, 'module.json'));
      if (!man.error && isObj(man.value)) {
        readable = true;
        const l = man.value.levels;
        if (isObj(l) && isObj(l.sessionApproval) && typeof l.sessionApproval.setting === 'string') keys.push(l.sessionApproval.setting);
      }
    }
    // the conventional key is emptied wherever it exists, declared or not; with no readable manifest it is always written
    if (!keys.includes('no_ask_agents') && (!readable || (isObj(st.settings) && 'no_ask_agents' in st.settings))) keys.push('no_ask_agents');
    for (const k of keys) {
      if (!isObj(st.settings)) { st.settings = {}; }
      if (JSON.stringify(st.settings[k]) !== '[]') { st.settings[k] = []; changed = true; }
    }
  }
  return changed;
}

/** runtime { lockfile, timeoutSec? }: optional. The shape only; the folder and its lockfile are checked against the module folder by validateRuntime. */
function validateRuntimeShape(m, p) {
  if (m.runtime === undefined) return;
  const r = m.runtime;
  if (!isObj(r)) { p.push('runtime must be an object'); return; }
  if (!str(r.lockfile) || path.isAbsolute(r.lockfile) || /^[A-Za-z]:/.test(r.lockfile) || r.lockfile.split(/[\\/]/).includes('..')) p.push('runtime.lockfile must be a folder inside the module folder (no .. and no absolute path)');
  if (r.timeoutSec !== undefined && !(Number.isInteger(r.timeoutSec) && r.timeoutSec >= 60 && r.timeoutSec <= 1800)) p.push('runtime.timeoutSec must be a whole number from 60 to 1800');
}

/** runtimeTimeoutMs(runtime) -> the npm ci time limit in ms (default 900 s). */
function runtimeTimeoutMs(runtime) {
  const s = runtime && Number.isInteger(runtime.timeoutSec) ? runtime.timeoutSec : 900;
  return Math.min(1800, Math.max(60, s)) * 1000;
}

/**
 * validateRuntime(moduleDir, runtime) -> [problems]: the lockfile folder exists inside the module folder (a link out of it is
 * refused), holds package.json and package-lock.json, and the lockfile is version 2 or 3 with an integrity string on every
 * package that has a resolved address.
 */
function validateRuntime(moduleDir, runtime) {
  const p = [];
  const shape = []; validateRuntimeShape({ runtime }, shape);
  if (shape.length) return shape;
  const base = path.resolve(moduleDir);
  const dir = path.resolve(base, runtime.lockfile);
  const rel = path.relative(base, dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return ['runtime.lockfile must be a folder inside the module folder'];
  try {
    const real = fs.realpathSync(dir), realBase = fs.realpathSync(base);
    const r2 = path.relative(realBase, real);
    if (r2.startsWith('..') || path.isAbsolute(r2)) return ['runtime.lockfile must be a folder inside the module folder'];
    if (!fs.statSync(real).isDirectory()) return [`runtime.lockfile "${runtime.lockfile}" is not a folder`];
  } catch { return [`runtime.lockfile "${runtime.lockfile}": the folder is missing`]; }
  for (const f of ['package.json', 'package-lock.json']) {
    try { if (!fs.statSync(path.join(dir, f)).isFile()) throw new Error('x'); } catch { p.push(`runtime: ${runtime.lockfile}/${f} is missing`); }
  }
  if (p.length) return p;
  let lock;
  try { lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8')); } catch (e) { return [`runtime: package-lock.json is not valid JSON (${e.message})`.slice(0, 200)]; }
  try { JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch (e) { return [`runtime: package.json is not valid JSON (${e.message})`.slice(0, 200)]; }
  if (!isObj(lock) || (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3)) return ['runtime: package-lock.json must be lockfileVersion 2 or 3'];
  if (!isObj(lock.packages)) return ['runtime: package-lock.json has no packages list'];
  const noHash = Object.entries(lock.packages).filter(([k, v]) => k !== '' && isObj(v) && typeof v.resolved === 'string' && v.resolved && !(typeof v.integrity === 'string' && v.integrity.trim())).map(([k]) => k);
  if (noHash.length) p.push(`runtime: package-lock.json has no integrity for ${noHash.slice(0, 3).join(', ')}${noHash.length > 3 ? ` and ${noHash.length - 3} more` : ''}`);
  return p;
}

/** receiver { paths, headers?, maxBody?, timeoutSec?, setupPaths? }: optional; the hub passes web calls on these paths to the module (hub/receive). setupPaths (1 to 8 names, each also in paths) are the few paths that answer while the module is installed but not yet enabled (a one-time installer link needed during setup). */
function validateReceiver(m, p) {
  if (m.receiver === undefined) return;
  const r = m.receiver;
  if (!isObj(r)) { p.push('receiver must be an object'); return; }
  const uniq = (a) => new Set(a).size === a.length;
  if (!(Array.isArray(r.paths) && r.paths.length >= 1 && r.paths.length <= 8 && r.paths.every(x => typeof x === 'string' && /^[a-z0-9][a-z0-9_-]{0,40}$/.test(x)) && uniq(r.paths))) p.push('receiver.paths must be 1 to 8 short lowercase names');
  if (r.headers !== undefined) {
    const bad = ['cookie', 'set-cookie', 'authorization', 'proxy-authorization', 'host'];
    if (!(Array.isArray(r.headers) && r.headers.length <= 8 && r.headers.every(x => typeof x === 'string' && /^[a-z0-9-]{1,40}$/.test(x) && !bad.includes(x)) && uniq(r.headers))) p.push('receiver.headers must be at most 8 lowercase header names (never cookie, set-cookie, authorization, proxy-authorization or host)');
  }
  if (r.maxBody !== undefined && !(Number.isInteger(r.maxBody) && r.maxBody >= 1024 && r.maxBody <= 4194304)) p.push('receiver.maxBody must be a whole number from 1024 to 4194304');
  if (r.timeoutSec !== undefined && !(Number.isInteger(r.timeoutSec) && r.timeoutSec >= 5 && r.timeoutSec <= 30)) p.push('receiver.timeoutSec must be a whole number from 5 to 30');
  if (r.setupPaths !== undefined) {
    const sp = r.setupPaths;
    if (!(Array.isArray(sp) && sp.length >= 1 && sp.length <= 8 && sp.every(x => typeof x === 'string' && Array.isArray(r.paths) && r.paths.includes(x)) && uniq(sp))) p.push('receiver.setupPaths must be a list of names that are also in receiver.paths');
  }
}

/** catalog { verified, api, official } and health { check }: all optional. (health.check is matched against index.js in loadModule.) */
function validateCatalog(m, p) {
  if (m.catalog !== undefined) {
    const c = m.catalog;
    if (!isObj(c)) p.push('catalog must be an object');
    else {
      if (c.verified !== undefined) {
        const t = typeof c.verified === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.verified) ? Date.parse(`${c.verified}T00:00:00Z`) : NaN;
        if (!(t > 0) || new Date(t).toISOString().slice(0, 10) !== c.verified) p.push('catalog.verified must be a real date, YYYY-MM-DD');
        else if (c.verified > new Date().toISOString().slice(0, 10)) p.push('catalog.verified cannot be in the future');
      }
      if (c.api !== undefined && !(typeof c.api === 'string' && c.api.trim() && c.api.length <= 40)) p.push('catalog.api must be text of at most 40 characters');
      if (c.official !== undefined && typeof c.official !== 'boolean') p.push('catalog.official must be true or false');
    }
  }
  if (m.health !== undefined && !(isObj(m.health) && str(m.health.check))) p.push('health must be { "check": "<name of a check in index.js>" }');
}

/** oauth for the signin step. flow 'device': { deviceUrl, tokenUrl, ... }; flow 'code': { authorizeUrl, tokenUrl, pkce?, rotatesRefreshToken?, ... }.
 *  Both: scopes, clientIdSecret, clientSecretSecret, refreshTokenSecret. */
function validateOauth(m, p, secretNames) {
  if (m.oauth === undefined) return;
  const o = m.oauth;
  if (!isObj(o)) { p.push('oauth must be an object'); return; }
  if (o.flow !== 'device' && o.flow !== 'code') p.push('oauth.flow must be "device" or "code"');
  for (const k of o.flow === 'code' ? ['authorizeUrl', 'tokenUrl'] : ['deviceUrl', 'tokenUrl']) if (!https(o[k])) p.push(`oauth.${k} must be an https address`);
  if (o.flow === 'code') for (const k of ['pkce', 'rotatesRefreshToken']) if (o[k] !== undefined && typeof o[k] !== 'boolean') p.push(`oauth.${k} must be true or false`);
  if (!(Array.isArray(o.scopes) && o.scopes.length && o.scopes.every(str))) p.push('oauth.scopes must be a non-empty list of text');
  for (const k of ['clientIdSecret', 'clientSecretSecret', 'refreshTokenSecret']) {
    if (!str(o[k])) p.push(`oauth.${k} is required`);
    else if (!secretNames.has(o[k])) p.push(`oauth.${k}: "${o[k]}" is not declared in secrets`);
  }
}

function validateSetup(setup, { secretNames, settingKeys, hasOauth, protectedKeys }, checks = {}) {
  const p = [];
  if (!setup || !Array.isArray(setup.steps) || !setup.steps.length) return ['setup.json needs a non-empty steps list'];
  const ids = new Set();
  for (const st of setup.steps) {
    if (!st || !str(st.id)) { p.push('a step has no id'); continue; }
    if (!STEP_ID_RE.test(st.id)) { p.push(`step id "${String(st.id).slice(0, 40)}": lowercase letters, digits and dashes, 1-32 characters, starting with a letter`); continue; }
    if (ids.has(st.id)) p.push(`step ${st.id}: duplicate id`);
    ids.add(st.id);
    if (!STEP_TYPES.includes(st.type)) p.push(`step ${st.id}: type must be one of ${STEP_TYPES.join(', ')}`);
    if (!str(st.title)) p.push(`step ${st.id}: title is required`);
    if (st.type === 'secrets') for (const f of st.fields || []) if (!secretNames.has(f)) p.push(`step ${st.id}: unknown secret ${f}`);
    if (st.type === 'settings') for (const f of st.fields || []) {
      if (!settingKeys.has(f)) p.push(`step ${st.id}: unknown setting ${f}`);
      else if (protectedKeys && protectedKeys.has(f)) p.push(`step ${st.id}: setting ${f} holds agent permissions and can only be changed in the permission editor`);
    }
    if (st.type === 'check' && !(st.check && typeof checks[st.check] === 'function')) p.push(`step ${st.id}: check "${st.check}" is not exported by the module's index.js`);
    if (st.type === 'signin' && !hasOauth) p.push(`step ${st.id}: a signin step needs an oauth block in module.json`);
    for (const l of st.links || []) if (!/^https:\/\//.test(String(l && l.url))) p.push(`step ${st.id}: links must be https`);
    if (st.confirm !== undefined && !(typeof st.confirm === 'string' && st.confirm.trim())) p.push(`step ${st.id}: confirm must be the text of the tick box`);
  }
  if (setup.steps[setup.steps.length - 1].type !== 'finish') p.push('the last step must be "finish"');
  return p;
}

/** Load one module folder: { id, dir, manifest, setup, code, problems[] }. Never throws. */
function loadModule(dir) {
  dir = path.resolve(dir);
  const dirName = path.basename(dir);
  const out = { id: dirName, dir, manifest: null, setup: null, code: {}, problems: [], hasGuide: fs.existsSync(path.join(dir, 'guide.md')) };
  const m = readJson(path.join(dir, 'module.json'));
  if (m.error) { out.problems.push(m.error); return out; }
  out.manifest = m.value;
  const v = validateManifest(m.value, dirName);
  out.problems.push(...v.problems);
  if (isObj(m.value) && m.value.runtime !== undefined && !v.problems.some(x => x.startsWith('runtime'))) out.problems.push(...validateRuntime(dir, m.value.runtime));
  if (fs.existsSync(path.join(dir, 'index.js'))) {
    try { out.code = require(path.join(dir, 'index.js')) || {}; }
    catch (e) { out.problems.push(`index.js: ${e.message}`); }
  }
  const hc = m.value && m.value.health && m.value.health.check;
  if (str(hc) && !(out.code.checks && typeof out.code.checks[hc] === 'function')) out.problems.push(`health.check "${hc}" is not exported by the module's index.js`);
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

module.exports = { validateLevels, parseLevelEntry, levelsOf, protectedSettingKeys, effectivePermissions, holdNoAskSettings, discover, loadModule, validateManifest, validateRuntime, runtimeTimeoutMs,validateSetup, coerceSettings, safeSettings, ID_RE, RISKS, TOOL_CLASSES, BACKUP_TOOLS, STEP_TYPES };
