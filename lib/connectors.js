'use strict';
// Data connectors: outside services (MyChart, a bank, a CRM, any MCP server) plugged into the hub as DATA, not code.
//
//   data/connectors.json   { version, groups: { <gid>: { label, kdf, check } }, connectors: [ <connector> ] }
//   <connector>            { id, label, kind: 'mcp'|'skill', command, args, skillId, group, protect: 'none'|'own'|'group',
//                            own: { kdf, check } (protect=own), secrets: { NAME: <enc> }, agents: [names]|null,
//                            tools: { <tool>: { cls: 'read'|'write'|'send' } }, sensitive, enabled, dataHome, notes,
//                            createdAt, updatedAt, lastOk, lastError }
//
// Owner-controlled on the Connectors page:
//   ACCESS    agents: null = every agent may use it; a list = only those agents, and only on their own turns
//             (a consulting agent never reaches another agent's connectors, same rule as wallet tools).
//   PASSWORD  protect 'own'   = this connector has its own passphrase;
//             protect 'group' = unlocked with the passphrase of its group (e.g. "medical");
//             protect 'none'  = always on (secrets still encrypted at rest, with a key derived from the hub key).
//             Secrets are AES-256-GCM under an scrypt key from the passphrase; the derived key lives in memory only
//             while unlocked and is gone on lock, on the idle timeout, or on restart. Lowering protection needs the
//             current passphrase and is logged.
//   CLASSES   each tool is classified for the tool policy: read (read_outside), write (write_outside) or send;
//             a 'sensitive' connector (patient data, money) classifies its reads as admin, so the owner's policy for
//             the agent decides, and workers and members never get them silently.
//   DATA HOME a folder the connector's data lands in; the agent firewall rules of that folder apply.
//
// kind 'mcp'   = a stdio MCP server the hub starts with a MINIMAL environment plus the decrypted secrets.
// kind 'skill' = one of the built-in skills (skill-manager) wrapped as a connector; once wrapped, the skill leaves the
//                ungated skill path and is reachable only through this connector's grants.
// Tool names are "<connector id>__<tool>". Nothing here knows about any particular service.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'connectors.json');
const DEFAULT_KEY_FILE = path.join(__dirname, '..', 'data', '.auth-key');
const KDF = { N: 1 << 15, r: 8, p: 1 };
const MIN_PASSPHRASE = 8;
const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const CHECK = 'agent-hub-connector-v1';
const PROTECT = ['none', 'own', 'group'];
const KINDS = ['mcp', 'skill'];
const TOOL_CLASSES = ['read', 'write', 'send', 'money'];   // money: exchange/wallet actions (wallet agents only; the module's own guard sets the limits)
const DEFAULT_UNLOCK_TTL_MS = 4 * 60 * 60 * 1000;
const CHILD_ENV_KEEP = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP', 'NODE_OPTIONS', 'SHELL', 'USER', 'LOGNAME', 'TZ', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];
const READ_RE = /(^|_)(list|get|read|search|fetch|query|check|preview|describe|find|lookup|history|status|show|view)(_|$)/i;
const SEND_RE = /send|post|reply|comment|create_issue|create_pull|merge|push|share|invite|publish|email|message|notify|webhook/i;

function encrypt(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return { iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), ct: ct.toString('hex') };
}
function decrypt(key, rec, aad) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(rec.iv, 'hex'));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(rec.tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(rec.ct, 'hex')), d.final()]).toString('utf8');
}
function derive(passphrase, kdf) {
  return crypto.scryptSync(String(passphrase), Buffer.from(kdf.salt, 'hex'), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 });
}
function newLock(passphrase) {
  if (String(passphrase || '').length < MIN_PASSPHRASE) throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE} characters.`);
  const kdf = { ...KDF, salt: crypto.randomBytes(16).toString('hex') };
  const key = derive(passphrase, kdf);
  return { lock: { kdf, check: encrypt(key, CHECK, 'check') }, key };
}
function openLock(lock, passphrase) {
  if (!lock || !lock.kdf) throw new Error('No lock.');
  const key = derive(passphrase, lock.kdf);
  try { if (decrypt(key, lock.check, 'check') !== CHECK) throw new Error('x'); } catch { throw new Error('Wrong passphrase.'); }
  return key;
}
/** AAD binds a secret to its connector, name and protection scope: a ciphertext cannot be relabelled by editing the file. */
const aadFor = (c, name) => `secret:${c.id}:${name}:${c.protect}:${c.protect === 'group' ? c.group : ''}`;

/**
 * createConnectors({ file, keyFile, skills, McpClient, now, log, publish, unlockTtlMs, setTimer, clearTimer })
 *   skills    = { SKILLS, discoverTools, executeMcpTool } (skill-manager) for kind 'skill'
 *   McpClient = stdio MCP client class (command, args, { env, timeout, redact }) with connect/listTools/callTool/disconnect
 */
function createConnectors({
  file = DEFAULT_FILE,
  keyFile = DEFAULT_KEY_FILE,
  skills = null,
  McpClient = null,
  now = Date.now,
  log = (...a) => console.log('[connectors]', ...a),
  publish = () => {},
  unlockTtlMs = DEFAULT_UNLOCK_TTL_MS,
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimer = (t) => clearTimeout(t),
  baseEnv = process.env,
} = {}) {
  let doc = null;
  const keys = new Map();        // scope ('own:<id>' | 'group:<gid>') -> { key, timer }
  const clients = new Map();     // connector id -> { client, tools }
  const toolCache = new Map();   // connector id -> [mcp tools]
  let hubKey = null;

  // ── storage ──
  function hubKeyBuf() {
    if (hubKey) return hubKey;
    let raw;
    try { raw = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex'); }
    catch { raw = crypto.randomBytes(32); fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 }); fs.writeFileSync(keyFile, raw.toString('hex'), { mode: 0o600 }); }
    // Not the hub key itself (it also protects TOTP secrets): a purpose-bound derivation of it.
    hubKey = Buffer.from(crypto.hkdfSync('sha256', raw, Buffer.alloc(0), 'agent-hub connectors v1', 32));
    return hubKey;
  }
  function load() {
    if (doc) return doc;
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { doc = null; }
    if (!doc || typeof doc !== 'object') doc = { version: 1, groups: {}, connectors: [] };
    doc.groups = doc.groups || {}; doc.connectors = Array.isArray(doc.connectors) ? doc.connectors : [];
    return doc;
  }
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(load(), null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  }
  const stamp = () => new Date(now()).toISOString();
  const find = (id) => load().connectors.find(c => c.id === id) || null;
  const must = (id) => { const c = find(id); if (!c) throw new Error(`No connector "${id}".`); return c; };

  // ── locks (keys in memory, idle timeout) ──
  function scopeOf(c) { return c.protect === 'own' ? `own:${c.id}` : c.protect === 'group' ? `group:${c.group}` : 'hub'; }
  function holdKey(scope, key) {
    const prev = keys.get(scope); if (prev && prev.timer) clearTimer(prev.timer);
    const timer = unlockTtlMs > 0 ? setTimer(() => { if (keys.has(scope)) { log(`${scope} locked again after ${Math.round(unlockTtlMs / 60000)} min idle`); dropKey(scope); publish('connectors_changed', { scope }); } }, unlockTtlMs) : null;
    keys.set(scope, { key, timer, since: stamp() });
  }
  function dropKey(scope) {
    const rec = keys.get(scope); if (!rec) return;
    if (rec.timer) clearTimer(rec.timer);
    keys.delete(scope);
    for (const c of load().connectors) if (scopeOf(c) === scope) stop(c.id);
  }
  function keyFor(c) {
    if (c.protect === 'none') return hubKeyBuf();
    const rec = keys.get(scopeOf(c)); return rec ? rec.key : null;
  }
  const isUnlocked = (c) => c.protect === 'none' || keys.has(scopeOf(c));

  function createGroup(id, label, passphrase) {
    if (!ID_RE.test(String(id))) throw new Error('Group id: lowercase letters, digits and dashes, 2-32 characters.');
    const g = load().groups;
    if (g[id]) throw new Error(`Group "${id}" already exists.`);
    const { lock, key } = newLock(passphrase);
    g[id] = { label: String(label || id), ...lock, createdAt: stamp() };
    holdKey(`group:${id}`, key);
    save(); log(`group "${id}" created and unlocked`); publish('connectors_changed', { group: id });
    return publicGroup(id);
  }
  function deleteGroup(id, passphrase) {
    const g = load().groups;
    if (!g[id]) throw new Error(`No group "${id}".`);
    openLock(g[id], passphrase);
    const users = load().connectors.filter(c => c.group === id && c.protect === 'group');
    if (users.length) throw new Error(`Group "${id}" still protects ${users.map(c => c.id).join(', ')}. Move them first.`);
    delete g[id]; dropKey(`group:${id}`); save(); log(`group "${id}" deleted`); publish('connectors_changed', { group: id });
    return { ok: true };
  }
  function unlockGroup(id, passphrase) {
    const g = load().groups[id]; if (!g) throw new Error(`No group "${id}".`);
    holdKey(`group:${id}`, openLock(g, passphrase));
    const gains = load().connectors.filter(c => c.protect === 'group' && c.group === id && c.enabled);
    log(`group "${id}" unlocked: ${gains.map(c => `${c.id} -> ${c.agents ? c.agents.join('/') : 'all agents'}`).join('; ') || 'no enabled connectors'}`);
    publish('connectors_changed', { group: id });
    return publicGroup(id);
  }
  function lockGroup(id) { dropKey(`group:${id}`); log(`group "${id}" locked`); publish('connectors_changed', { group: id }); return publicGroup(id); }
  function unlock(id, passphrase) {
    const c = must(id);
    if (c.protect === 'group') { unlockGroup(c.group, passphrase); return publicConnector(c); }
    if (c.protect === 'own') { holdKey(`own:${id}`, openLock(c.own, passphrase)); log(`"${id}" unlocked -> ${c.agents ? c.agents.join('/') : 'all agents'}`); publish('connectors_changed', { id }); }
    return publicConnector(c);
  }
  function lock(id) {
    const c = must(id);
    if (c.protect === 'group') { lockGroup(c.group); return publicConnector(c); }
    dropKey(`own:${id}`); stop(id); publish('connectors_changed', { id });
    return publicConnector(c);
  }
  function lockAll() { for (const s of [...keys.keys()]) dropKey(s); for (const id of [...clients.keys()]) stop(id); publish('connectors_changed', {}); }

  // ── public views ──
  function publicGroup(id) {
    const g = load().groups[id]; if (!g) return null;
    const rec = keys.get(`group:${id}`);
    return { id, label: g.label, unlocked: !!rec, unlockedSince: rec ? rec.since : null, connectors: load().connectors.filter(c => c.group === id).map(c => c.id), createdAt: g.createdAt };
  }
  function publicConnector(c) {
    const live = clients.get(c.id);
    return {
      id: c.id, label: c.label, kind: c.kind, command: c.command || null, args: c.args || [], skillId: c.skillId || null,
      group: c.group || null, protect: c.protect, unlocked: isUnlocked(c), enabled: !!c.enabled, agents: c.agents,
      tools: c.tools || {}, sensitive: !!c.sensitive, dataHome: c.dataHome || null, notes: c.notes || '',
      secretNames: Object.keys(c.secrets || {}), running: !!live, module: c.module || null, toolCount: toolCache.has(c.id) ? toolCache.get(c.id).length : null,
      createdAt: c.createdAt, updatedAt: c.updatedAt, lastOk: c.lastOk || null, lastError: c.lastError || null,
    };
  }
  function list() { return { connectors: load().connectors.map(publicConnector), groups: Object.keys(load().groups).map(publicGroup) }; }
  const wrappedSkillIds = () => new Set(load().connectors.filter(c => c.kind === 'skill' && c.skillId).map(c => c.skillId));

  // ── create / update ──
  function reencrypt(c, oldKey, apply) {
    const plain = {};
    for (const [k, v] of Object.entries(c.secrets || {})) plain[k] = decrypt(oldKey, v, aadFor(c, k));
    apply();
    const nk = keyFor(c); if (!nk) throw new Error('The new protection scope is locked.');
    c.secrets = {}; for (const [k, v] of Object.entries(plain)) c.secrets[k] = encrypt(nk, v, aadFor(c, k));
  }
  /**
   * upsert(spec, { passphrase, newPassphrase }) — create or update. Secrets arrive in clear in spec.secrets and are
   * stored encrypted; changing secrets needs the connector unlocked. Changing protection or group needs `passphrase`
   * for the CURRENT lock (when there is one) and `newPassphrase` for a new 'own' lock.
   */
  function upsert(spec, { passphrase = null, newPassphrase = null, byModule = false } = {}) {
    const id = String(spec.id || '').trim();
    if (!ID_RE.test(id)) throw new Error('Connector id: lowercase letters, digits and dashes, 2-32 characters.');
    const d = load();
    let c = find(id);
    // A module's connector runs its guard (lib/modules/mcp-guard): only the module may change what it runs, which
    // tools it exposes, who gets it, its secrets or whether it is on. Edits here would bypass the module's limits.
    if (c && c.module && !byModule) {
      const locked = ['command', 'args', 'tools', 'agents', 'module', 'kind', 'secrets', 'enabled', 'skillId', 'dataHome'].filter(k => spec[k] !== undefined);
      if (locked.length) throw new Error(`"${id}" belongs to the ${c.label || id} module; change it on the Modules page (${locked.join(', ')}).`);
    }
    if (!c && spec.module && !byModule) throw new Error('Only a module can create a module connector.');
    const fresh = !c;
    if (fresh) c = { id, createdAt: stamp(), secrets: {}, agents: null, enabled: false, protect: 'none', tools: {} };
    if (spec.label !== undefined) c.label = String(spec.label || id);
    if (!c.label) c.label = id;
    if (spec.kind !== undefined) { if (!KINDS.includes(spec.kind)) throw new Error(`kind must be ${KINDS.join(' or ')}.`); c.kind = spec.kind; }
    if (!c.kind) c.kind = 'mcp';
    if (c.kind === 'mcp') {
      if (spec.command !== undefined) c.command = String(spec.command || '');
      if (spec.args !== undefined) c.args = Array.isArray(spec.args) ? spec.args.map(String) : String(spec.args || '').split(/\s+/).filter(Boolean);
    } else {
      if (spec.skillId !== undefined) c.skillId = String(spec.skillId);
      if (!c.skillId || !(skills && skills.SKILLS && skills.SKILLS[c.skillId])) throw new Error(`Unknown built-in skill "${c.skillId || ''}".`);
      if (d.connectors.some(o => o.id !== id && o.kind === 'skill' && o.skillId === c.skillId)) throw new Error(`Skill "${c.skillId}" is already wrapped by another connector.`);
    }
    if (spec.agents !== undefined) c.agents = spec.agents == null ? null : [...new Set((Array.isArray(spec.agents) ? spec.agents : String(spec.agents).split(',')).map(s => String(s).trim()).filter(Boolean))];
    if (spec.enabled !== undefined) c.enabled = !!spec.enabled;
    if (spec.sensitive !== undefined) c.sensitive = !!spec.sensitive;
    if (spec.dataHome !== undefined) c.dataHome = spec.dataHome ? String(spec.dataHome) : null;
    if (spec.notes !== undefined) c.notes = String(spec.notes || '').slice(0, 2000);
    if (spec.module !== undefined) c.module = spec.module ? String(spec.module) : null;   // owned by a hub module (lib/modules)
    if (spec.tools !== undefined && spec.tools && typeof spec.tools === 'object') {
      const t = {};
      for (const [name, v] of Object.entries(spec.tools)) { const cls = v && v.cls; if (!TOOL_CLASSES.includes(cls)) throw new Error(`Tool "${name}": class must be ${TOOL_CLASSES.join(', ')}.`); t[String(name).slice(0, 80)] = { cls }; }
      c.tools = t;
    }
    // protection / group changes: the current lock must be opened with its passphrase (lowering protection is never silent)
    const wantProtect = spec.protect !== undefined ? spec.protect : c.protect;
    const wantGroup = spec.group !== undefined ? (spec.group || null) : (c.group || null);
    if (wantProtect !== c.protect || (c.protect === 'group' && wantGroup !== c.group)) {
      if (!PROTECT.includes(wantProtect)) throw new Error(`protect must be ${PROTECT.join(', ')}.`);
      if (!fresh && c.protect !== 'none') { if (c.protect === 'own') openLock(c.own, passphrase); else openLock(d.groups[c.group] || null, passphrase); }
      const oldKey = fresh ? null : keyFor(c);
      if (!fresh && !oldKey && c.protect !== 'none') holdKey(scopeOf(c), c.protect === 'own' ? openLock(c.own, passphrase) : openLock(d.groups[c.group], passphrase));
      const before = `${c.protect}${c.group ? `/${c.group}` : ''}`;
      const apply = () => {
        if (wantProtect === 'own') { const { lock: l, key } = newLock(newPassphrase); c.own = l; holdKey(`own:${id}`, key); }
        else delete c.own;
        if (wantProtect === 'group') { if (!d.groups[wantGroup]) throw new Error(`No group "${wantGroup}".`); if (!keys.has(`group:${wantGroup}`)) throw new Error(`Unlock group "${wantGroup}" first.`); }
        c.group = wantGroup; c.protect = wantProtect;
      };
      if (fresh || !Object.keys(c.secrets || {}).length) apply(); else reencrypt(c, keyFor(c), apply);
      if (!fresh) log(`AUDIT "${id}" protection changed ${before} -> ${wantProtect}${wantProtect === 'group' ? `/${wantGroup}` : ''}`);
    } else if (spec.group !== undefined) c.group = wantGroup;
    if (spec.secrets && typeof spec.secrets === 'object') {
      const k = keyFor(c); if (!k) throw new Error(`Unlock "${id}" before changing its secrets.`);
      for (const [name, value] of Object.entries(spec.secrets)) {
        if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) throw new Error(`Secret name "${name}": UPPER_CASE environment-variable style.`);
        if (value === null || value === '') delete c.secrets[name];
        else c.secrets[name] = encrypt(k, String(value), aadFor(c, name));
      }
    }
    c.updatedAt = stamp();
    if (fresh) d.connectors.push(c);
    stop(id);           // restarts with the new settings on next use
    save(); publish('connectors_changed', { id });
    log(`${fresh ? 'created' : 'updated'} "${id}" (${c.kind}, protect ${c.protect}${c.group ? `/${c.group}` : ''}, agents ${c.agents ? c.agents.join('/') : 'all'}, ${c.enabled ? 'enabled' : 'disabled'})`);
    return publicConnector(c);
  }
  /** Internal write-back (e.g. a rotated OAuth refresh token): needs the connector unlocked. */
  function setSecret(id, name, value) { return upsert({ id, secrets: { [name]: value } }); }
  function remove(id, { byModule = false } = {}) {
    const d = load(); const i = d.connectors.findIndex(c => c.id === id);
    if (i < 0) throw new Error(`No connector "${id}".`);
    if (d.connectors[i].module && !byModule) throw new Error(`"${id}" belongs to a module; remove it on the Modules page.`);
    stop(id); dropKey(`own:${id}`); d.connectors.splice(i, 1); toolCache.delete(id); save(); log(`removed "${id}"`); publish('connectors_changed', { id });
    return { ok: true };
  }
  function setGrants(id, agents) { return upsert({ id, agents }); }   // module connectors refuse this (see upsert)

  // ── access ──
  function granted(c, agentName) { return c.agents == null || c.agents.includes(String(agentName)); }
  function availableFor(agentName, { consultationDepth = 0 } = {}) {
    if (consultationDepth > 0) return [];
    return load().connectors.filter(c => c.enabled && granted(c, agentName) && isUnlocked(c));
  }
  function grantedFor(agentName) { return load().connectors.filter(c => c.enabled && granted(c, agentName)); }

  // ── tool classes for the policy ──
  function classOf(c, toolName, mcpTool = null) {
    const declared = c.tools && c.tools[toolName] && c.tools[toolName].cls;
    let cls = declared || null;
    if (!cls && mcpTool && mcpTool.annotations) { if (mcpTool.annotations.readOnlyHint) cls = 'read'; }
    if (!cls) cls = READ_RE.test(toolName) ? 'read' : SEND_RE.test(toolName) ? 'send' : 'write';
    return cls;
  }
  /**
   * classifyToolCall({ tool, input }) -> policy class record for "<id>__<tool>" names, or null when not a connector tool.
   * read -> read_outside (admin when the connector is sensitive), write -> write_outside, send -> send. destKey = connector id.
   */
  function classifyToolCall({ tool, input = {} }) {
    const name = String(tool || '');
    const m = name.match(/^([a-z][a-z0-9-]{1,31})__(.+)$/);
    if (!m) return null;
    const c = find(m[1]); if (!c) return null;
    const mt = (toolCache.get(c.id) || []).find(t => sanitize(t.name) === m[2]) || null;
    const toolName = mt ? mt.name : m[2];
    const cls = classOf(c, toolName, mt);
    const summary = `${c.label}: ${toolName} ${Object.values(input || {}).filter(v => typeof v === 'string').map(v => v.slice(0, 60)).slice(0, 3).join(' ')}`.trim().slice(0, 200);
    const detail = { connector: c.id, tool: toolName, input: JSON.stringify(input || {}).slice(0, 2000) };
    if (cls === 'money') return { cls: 'money', summary, detail, destKey: c.id };
    if (cls === 'send') return { cls: 'send', summary, detail, destKey: c.id };
    if (cls === 'write') return { cls: 'write_outside', summary, detail, destKey: c.id };
    return { cls: c.sensitive ? 'admin' : 'read_outside', summary, detail, destKey: c.id };
  }

  // ── running an MCP connector ──
  const sanitize = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
  function secretsEnv(c) {
    const k = keyFor(c); if (!k) throw new Error(`"${c.id}" is locked.`);
    const env = {}; for (const [name, v] of Object.entries(c.secrets || {})) env[name] = decrypt(k, v, aadFor(c, name));
    return env;
  }
  function redactor(c) {
    let values = [];
    try { values = Object.values(secretsEnv(c)).filter(v => v && v.length >= 6); } catch {}
    return (s) => { let out = String(s); for (const v of values) out = out.split(v).join('[secret]'); return out; };
  }
  // One start at a time per connector: two first calls at once used to spawn two servers (for a module, two
  // guards with separate spending queues).
  const starting = new Map();
  function start(c) {
    const live = clients.get(c.id); if (live) return Promise.resolve(live);
    if (starting.has(c.id)) return starting.get(c.id);
    const p = startNow(c).finally(() => starting.delete(c.id));
    starting.set(c.id, p);
    return p;
  }
  async function startNow(c) {
    const live = clients.get(c.id); if (live) return live;
    if (c.kind !== 'mcp') return null;
    if (!McpClient) throw new Error('No MCP client available.');
    if (!c.command) throw new Error(`"${c.id}" has no command.`);
    const env = {};
    for (const k of CHILD_ENV_KEEP) if (baseEnv[k] !== undefined) env[k] = baseEnv[k];
    Object.assign(env, secretsEnv(c), { CONNECTOR_ID: c.id }, c.dataHome ? { CONNECTOR_DATA_HOME: c.dataHome } : {});
    const redact = redactor(c);
    const client = new McpClient(c.command, c.args || [], { env, timeout: 60000, redact });
    try {
      await client.connect();
      const tools = await client.listTools();
      const rec = { client, tools };
      clients.set(c.id, rec); toolCache.set(c.id, tools);
      c.lastOk = stamp(); c.lastError = null; save();
      log(`"${c.id}" started: ${tools.length} tool(s)`);
      return rec;
    } catch (e) {
      try { const p = client.disconnect && client.disconnect(); if (p && p.catch) p.catch(() => {}); } catch {}
      c.lastError = `${stamp()} ${redact(e.message || e)}`.slice(0, 300); save();
      throw new Error(redact(e.message || String(e)));
    }
  }
  function stop(id) {
    const live = clients.get(id); if (!live) return;
    clients.delete(id);
    try { const p = live.client.disconnect(); if (p && p.catch) p.catch(() => {}); } catch {}
    log(`"${id}" stopped`);
  }
  async function tools(c) {
    if (c.kind === 'skill') { if (!skills) return []; const t = await skills.discoverTools(c.skillId); toolCache.set(c.id, t); return t; }
    return (await start(c)).tools;
  }
  async function call(c, toolName, args) {
    if (c.kind === 'skill') return skills.executeMcpTool(c.skillId, toolName, args);
    const live = await start(c);
    const r = await live.client.callTool(toolName, args || {});
    if (r && Array.isArray(r.content)) return r.content.map(p => (p.type === 'text' ? p.text : JSON.stringify(p))).join('\n');
    return typeof r === 'string' ? r : JSON.stringify(r);
  }
  /** callTool(id, tool, args): one call outside any agent turn (a module's setup check). Same path as an agent's call. */
  async function callTool(id, toolName, args) {
    const c = must(id);
    if (!isUnlocked(c)) throw new Error(`"${id}" is locked.`);
    return call(c, toolName, args);
  }
  /** test(id): start (or discover) and list the tools with their policy classes; the Connectors page's "Test" button. */
  async function test(id) {
    const c = must(id);
    if (!isUnlocked(c)) throw new Error(`"${id}" is locked.`);
    const t = await tools(c);
    return { ok: true, id, tools: t.map(x => ({ name: x.name, cls: classOf(c, x.name, x), description: String(x.description || '').slice(0, 200) })) };
  }

  /**
   * toolSpecsFor(agentName, { consultationDepth }) -> [{ name, connector, tool, description, parameters, handler }]
   * One entry per tool of every connector the agent may use right now (enabled, granted, unlocked). A connector that
   * cannot start contributes nothing and records lastError. Tool names: "<connector id>__<tool>"; a sanitised name
   * that collides with another is refused rather than shadowed.
   */
  async function toolSpecsFor(agentName, { consultationDepth = 0 } = {}) {
    const out = []; const seen = new Set();
    for (const c of availableFor(agentName, { consultationDepth })) {
      let t = [];
      try { t = await tools(c); } catch (e) { log(`"${c.id}" unavailable for ${agentName}: ${e.message}`); continue; }
      for (const mt of t) {
        const name = `${c.id}__${sanitize(mt.name)}`;
        if (seen.has(name)) { log(`"${c.id}": tool name collision on ${name}; the later one is not exposed`); continue; }
        seen.add(name);
        out.push({
          name, connector: c.id, tool: mt.name, cls: classOf(c, mt.name, mt),
          description: `[${c.label}] ${String(mt.description || mt.name).slice(0, 800)}`,
          parameters: mt.inputSchema || { type: 'object', properties: {} },
          handler: (args) => call(c, mt.name, args),
        });
      }
    }
    return out;
  }

  /** One short block for the agent's context: which connectors it may use and which are locked right now. */
  function contextTextFor(agentName) {
    const mine = grantedFor(agentName);
    if (!mine.length) return '';
    const lines = mine.map(c => `- ${c.label} (tools "${c.id}__*"): ${isUnlocked(c) ? 'available' : `LOCKED by the owner's passphrase${c.protect === 'group' ? ` (group "${c.group}")` : ''}; ask the owner to unlock it on the Connectors page`}${c.dataHome ? `; its data lives in ${c.dataHome}` : ''}`);
    return `## DATA CONNECTORS (outside services you may use)\n${lines.join('\n')}\nA connector's tools are yours only on your own turns; an agent that consults you cannot reach them through you.`;
  }

  function shutdown() { lockAll(); }

  return {
    list, upsert, setSecret, remove, setGrants, test, callTool, stop, unlock, lock, lockAll,
    createGroup, deleteGroup, unlockGroup, lockGroup, group: publicGroup,
    availableFor, grantedFor, toolSpecsFor, contextTextFor, classifyToolCall, wrappedSkillIds,
    isUnlocked: (id) => isUnlocked(must(id)), shutdown, MIN_PASSPHRASE, ID_RE,
  };
}

/**
 * zodShapeFromJsonSchema(z, schema) -> a zod shape ({ key: zodType }) for sdk.tool() from an MCP tool's JSON-schema
 * input. Handles object properties of string/number/integer/boolean/enum/array/object; everything else is z.any().
 * Unknown or non-object schemas become { input: z.any().optional() } so the tool is still callable.
 */
function zodShapeFromJsonSchema(z, schema) {
  const one = (sc, depth = 0) => {
    if (!sc || typeof sc !== 'object' || depth > 4) return z.any();
    let t;
    if (Array.isArray(sc.enum) && sc.enum.length && sc.enum.every(v => typeof v === 'string')) t = z.enum(sc.enum);
    else {
      const type = Array.isArray(sc.type) ? sc.type.find(x => x !== 'null') : sc.type;
      if (type === 'string') t = z.string();
      else if (type === 'number' || type === 'integer') t = z.number();
      else if (type === 'boolean') t = z.boolean();
      else if (type === 'array') t = z.array(one(sc.items, depth + 1));
      else if (type === 'object' && sc.properties && typeof sc.properties === 'object') {
        const shape = {}; const req = new Set(Array.isArray(sc.required) ? sc.required : []);
        for (const [k, v] of Object.entries(sc.properties)) { const f = one(v, depth + 1); shape[k] = req.has(k) ? f : f.optional(); }
        t = z.object(shape).passthrough();
      } else t = z.any();
    }
    return sc.description ? t.describe(String(sc.description).slice(0, 500)) : t;
  };
  if (!schema || schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object') return { input: z.any().optional().describe('Arguments object for the tool') };
  const shape = {}; const req = new Set(Array.isArray(schema.required) ? schema.required : []);
  for (const [k, v] of Object.entries(schema.properties)) { const f = one(v); shape[k] = req.has(k) ? f : f.optional(); }
  return shape;
}

let singleton = null;
function getConnectors() {
  if (!singleton) {
    let skills = null; try { skills = require('./skills/skill-manager'); } catch {}
    let McpClient = null; try { McpClient = require('./skills/mcp-stdio'); } catch {}
    let publish = () => {}; try { const ev = require('./hub-events').events; publish = (t, d) => ev.publish(t, d); } catch {}
    let ttl = DEFAULT_UNLOCK_TTL_MS; try { const v = Number(require('./settings').getSetting('connectorsUnlockMinutes', 240)); if (Number.isFinite(v) && v >= 0) ttl = v * 60000; } catch {}
    singleton = createConnectors({ skills, McpClient, publish, unlockTtlMs: ttl });
    try { require('./tool-policy').registerToolClassifier((q) => singleton.classifyToolCall(q)); } catch {}
  }
  return singleton;
}

module.exports = { createConnectors, getConnectors, zodShapeFromJsonSchema, MIN_PASSPHRASE, ID_RE, PROTECT, KINDS, TOOL_CLASSES, CHILD_ENV_KEEP };
