'use strict';
// The one journal for every settings change (data/settings-journal.jsonl, owner-only, one JSON line per changed key).
//
// Every writer of a settings store goes through the hooks in lib/settings.js (settings.json), lib/agents.js (agents.json) and
// lib/auth.js (a person's preferences in users.json); each hook diffs the old and new state and calls recordChange() BEFORE it
// writes. A change the journal cannot record is refused (recordChange throws; the caller does not write).
//
// Entry: { id: "sj-xxxxxxxxxx", at: ms, who: { kind: person|lead|hub|update|cli|outside|restore, user?, agent?, turn? },
//          store: "settings"|"agents"|"prefs", key: dotted path, record: "OPT-xxxx"|null, before, after, why, restorable }.
// `before` / `after` are left out when the key did not exist. Secrets are never written: see isSecretKey().
// A line {"marker":true,"store","stamp","at"} says "the file now has this stamp and I already journaled that write": the command
// line (another process) writes one after its own write, so the running hub does not journal the same change again as "outside".
//
// Edits from outside the hub (a program or person that edits the file directly) are found when the store re-reads its file and the
// stamp (mtimeMs:size:ino) is not the one of the hub's own last write: the diff is journaled with who.kind "outside", and the
// owner gets one batched notice (see noteOutside).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage, AsyncResource } = require('async_hooks');

const MAX_VALUE_BYTES = 4096;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const BATCH_MS = 60 * 1000;
const NOTICE_GAP_MS = 10 * 60 * 1000;
const KINDS = ['person', 'lead', 'hub', 'update', 'cli', 'outside', 'restore'];

// ── Secrets ───────────────────────────────────────────────────────────────
// A key (dotted path) is secret when it is a provider key, a web-search key, anything of the backup, or its last segment looks like
// a key, token, secret, password, passphrase, seed or private key. These names match the words but hold no secret.
const SECRET_WORDS = /key|token|secret|password|passphrase|seed|private/i;
const NOT_SECRET = new Set([
  'maxCompletionTokens', 'maxOutputTokens', 'maxTokens', 'maxContextTokens', 'tokenBudget', 'contextBudget',   // sizes
  'keyHint', 'keySource', 'hasKey', 'keyId',                                                                    // what the pages show about a key
  'allowPrivate',                                                                                               // webFetch.allowPrivate: a yes/no about private addresses
]);
function isSecretName(name) { const n = String(name || ''); return !NOT_SECRET.has(n) && SECRET_WORDS.test(n); }
function isSecretKey(key, record, store = 'settings') {
  const k = String(key || '');
  if ((store === 'agents' || store === 'prefs') && k.split('.').length <= 2) return false;   // "agents.<name>": the name is not a field
  if (/^providers\.[^.]+\.apiKey$/.test(k) || /^webSearch\.keys(\.|$)/.test(k) || /^backup(\.|$)/.test(k)) return true;
  const last = k.split('.').pop();
  if (isSecretName(last)) return true;
  if (record && typeof record.storedAs === 'string' && /(api ?key|secret|password|passphrase|private key|\btoken\b)/i.test(record.storedAs)) return true;
  return false;
}
/** A copy of a value with every field whose name is secret removed (at any depth). */
function stripSecrets(v, depth = 0) {
  if (Array.isArray(v)) return depth > 8 ? [] : v.map((x) => stripSecrets(x, depth + 1));
  if (v && typeof v === 'object') {
    if (depth > 8) return {};
    const o = {};
    for (const [k, x] of Object.entries(v)) if (!isSecretName(k)) o[k] = stripSecrets(x, depth + 1);
    return o;
  }
  return v;
}

// ── Equality and diff ─────────────────────────────────────────────────────
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
function same(a, b) {
  if (a === undefined || b === undefined) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}
/** Per-key changes between two objects, down to `depth` levels of keys (a deeper object, and any array, is compared as one value).
 *  Returns [{ key, before, after }] sorted by key; a missing side is undefined. A key that exists on one side only, as an object, is
 *  walked into too, so the one entry per changed key rule also holds for a whole provider added or removed. */
function diff(beforeObj, afterObj, prefix = '', depth = 3) {
  const out = [];
  const walk = (b, a, pre, level) => {
    const keys = new Set([...Object.keys(isObj(b) ? b : {}), ...Object.keys(isObj(a) ? a : {})]);
    for (const k of keys) {
      if (k === '__proto__') continue;
      const kb = isObj(b) ? b[k] : undefined, ka = isObj(a) ? a[k] : undefined;
      const full = pre ? `${pre}.${k}` : k;
      if (same(kb, ka)) continue;
      const walkable = level < depth && (isObj(kb) || kb === undefined) && (isObj(ka) || ka === undefined) && (isObj(kb) || isObj(ka));
      if (walkable) walk(kb, ka, full, level + 1);
      else out.push({ key: full, before: kb, after: ka });
    }
  };
  walk(beforeObj, afterObj, prefix, 1);
  return out.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
}

/** Changes between two agent lists: an agent added or removed is one entry ("agents.<name>", the whole record without secrets);
 *  an agent in both is compared field by field ("agents.<name>.<field>[.<sub>]", down to depth 3). */
function diffAgents(beforeList, afterList) {
  const byName = (l) => { const m = new Map(); for (const a of Array.isArray(l) ? l : []) if (a && typeof a === 'object' && typeof a.name === 'string') m.set(a.name, a); return m; };
  const b = byName(beforeList), a = byName(afterList);
  const out = [];
  for (const name of new Set([...b.keys(), ...a.keys()])) {
    const kb = b.get(name), ka = a.get(name);
    if (!kb) out.push({ key: `agents.${name}`, before: undefined, after: ka });
    else if (!ka) out.push({ key: `agents.${name}`, before: kb, after: undefined });
    else out.push(...diff(kb, ka, `agents.${name}`, 3));
  }
  return out.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
}

// ── Actor context ─────────────────────────────────────────────────────────
const als = new AsyncLocalStorage();
/** Runs fn with an actor: { kind, user, agent, turn, why }. Without a context the kind is "hub". */
function withActor(ctx, fn) { return als.run(normaliseActor(ctx), fn); }
/** Sets the actor for the rest of the current async flow (the request handler uses it once the caller is known). */
function enterActor(ctx) { als.enterWith(normaliseActor(ctx)); }
function normaliseActor(ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const o = { kind: KINDS.includes(c.kind) ? c.kind : 'hub' };
  for (const k of ['user', 'agent', 'turn', 'why']) if (c[k] !== undefined && c[k] !== null && c[k] !== '') o[k] = String(c[k]);
  return o;
}
function current() { return als.getStore() || { kind: 'hub' }; }
/** An http request's 'data' and 'end' listeners run in the http parser's context, not the handler's: bind them to the current actor. */
function bindRequest(req) {
  for (const m of ['on', 'once', 'addListener']) {
    const orig = req[m];
    if (typeof orig !== 'function') continue;
    req[m] = function (ev, fn, ...rest) { return orig.call(this, ev, typeof fn === 'function' ? AsyncResource.bind(fn) : fn, ...rest); };
  }
}

// ── Records (which settings record a key belongs to) ─────────────────────
let _index = null;
function recordIndex() {
  if (_index) return _index;
  const idx = new Map();
  let all = [];
  try { all = require('./settings-records').all(); } catch { all = []; }
  const add = (k, r) => { if (!idx.has(k)) idx.set(k, r); };
  for (const r of all) {
    if (r.mergedInto || typeof r.storedAs !== 'string') continue;
    for (const m of r.storedAs.matchAll(/settings\.([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)/g)) add(`settings:${m[1]}`, r);
    for (const m of r.storedAs.matchAll(/agents\[\]\.([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)/g)) add(`agents:${m[1]}`, r);
    for (const m of r.storedAs.matchAll(/(?:prefs|users\[\])\.([A-Za-z][A-Za-z0-9_]*)/g)) add(`prefs:${m[1]}`, r);
  }
  _index = idx;
  return idx;
}
function splitKey(store, key) {
  const parts = String(key).split('.');
  if (store === 'agents') return { owner: parts[1] || null, rest: parts.slice(2) };
  if (store === 'prefs') return { owner: parts[1] || null, rest: parts.slice(2) };
  return { owner: null, rest: parts };
}
/** The settings record a key belongs to (looked up through the records' storedAs), or null. */
function recordFor(store, key) {
  const { rest } = splitKey(store, key);
  const idx = recordIndex();
  for (let n = rest.length; n >= 1; n--) {
    const r = idx.get(`${store}:${rest.slice(0, n).join('.')}`);
    if (r) return r;
  }
  return null;
}
/** True when restoring this key could loosen a protection: it needs an admin's own browser session. */
function needsOwnSession(store, key, record) {
  if (/lockbox|sandbox|policy|approval|requireAdmin2fa|wallet/i.test(String(key))) return true;
  if (record && record.danger === 'dangerous') return true;
  if (record && record.danger === 'care' && /safety/i.test(String(record.home || ''))) return true;
  return false;
}

// ── Value shaping ─────────────────────────────────────────────────────────
function shape(v) {
  if (v === undefined) return { value: undefined, big: false };
  let s; try { s = JSON.stringify(v); } catch { s = ''; }
  const bytes = Buffer.byteLength(s || '');
  if (bytes <= MAX_VALUE_BYTES) return { value: JSON.parse(s === undefined ? 'null' : s), big: false };
  const what = Array.isArray(v) ? `a list of ${v.length}` : isObj(v) ? `an object of ${Object.keys(v).length} fields` : typeof v === 'string' ? 'a long text' : 'a large value';
  return { value: `(${what}, ${bytes} bytes: not kept in the journal)`, big: true };
}
const PREF_RESTORABLE = new Set(['uiMode', 'theme', 'planBadge']);
function buildEntry({ store, key, before, after, actor, why, now }) {
  const record = recordFor(store, key);
  const secret = isSecretKey(key, record, store);
  let b, a, big = false;
  if (secret) {
    b = before === undefined ? undefined : 'set';
    a = after === undefined ? 'removed' : before === undefined ? 'set' : 'replaced';
    // a whole object that holds a secret field below the walked depth is still only a word
  } else {
    const sb = shape(stripSecrets(before)), sa = shape(stripSecrets(after));
    b = sb.value; a = sa.value; big = sb.big || sa.big;
  }
  const last = String(key).split('.').pop();
  const entry = {
    id: `sj-${crypto.randomBytes(5).toString('hex')}`,
    at: now(),
    who: whoOf(actor),
    store, key, record: record ? record.id : null,
  };
  if (b !== undefined) entry.before = b;
  if (a !== undefined) entry.after = a;
  entry.why = why || actor.why || null;
  let restorable = !secret && !big;
  if (store === 'prefs' && !PREF_RESTORABLE.has(last)) restorable = false;
  if (store === 'agents' && splitKey(store, key).rest.length === 0) restorable = false;   // an agent added or removed as a whole
  if (store === 'agents' && /^(owner|lead|sharedWith)$/.test(splitKey(store, key).rest[0] || '')) restorable = false;   // these move permissions: use the agent's screen
  entry.restorable = restorable;
  return entry;
}
function whoOf(actor) {
  const w = { kind: actor.kind };
  for (const k of ['user', 'agent', 'turn']) if (actor[k]) w[k] = actor[k];
  return w;
}
const sameValue = (x, y) => same(x, y);

// ── The journal ───────────────────────────────────────────────────────────
function createJournal({ file, clock = Date.now, timers = { setTimeout, clearTimeout }, notify = null } = {}) {
  let _file = file;
  let _clock = clock, _timers = timers, _notify = notify;
  const fileOf = () => _file;
  const now = () => _clock();
  let chmodded = false;

  function append(entries) {
    if (!entries || !entries.length) return;
    const text = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.mkdirSync(path.dirname(_file), { recursive: true });
    fs.appendFileSync(_file, text, { mode: 0o600 });
    if (!chmodded) { try { fs.chmodSync(_file, 0o600); chmodded = true; } catch { /* filesystem without modes */ } }
    rotate();
  }
  // Past 5 MB the newest half is kept (temp file in the same folder, then rename). Best effort: a failed rotation never refuses a change.
  function rotate() {
    try {
      const st = fs.statSync(_file);
      if (st.size <= MAX_FILE_BYTES) return;
      const lines = fs.readFileSync(_file, 'utf8').split('\n').filter(Boolean);
      let keep = [], size = 0;
      for (let i = lines.length - 1; i >= 0; i--) { size += Buffer.byteLength(lines[i]) + 1; if (size > MAX_FILE_BYTES / 2) break; keep.push(lines[i]); }
      keep.reverse();
      const tmp = `${_file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, keep.join('\n') + '\n', { mode: 0o600 });
      fs.renameSync(tmp, _file);
    } catch { /* keep the long file */ }
  }

  /** changes: [{key, before, after}] from diff(). Builds the entries and appends them all at once; throws when it cannot write. */
  function recordChange(store, changes, { actor = null, why = null } = {}) {
    if (!changes || !changes.length) return [];
    const who = normaliseActor(actor || current());
    const entries = changes.map((c) => buildEntry({ store, key: c.key, before: c.before, after: c.after, actor: who, why, now }));
    append(entries);
    return entries;
  }

  function readAll() {
    let text;
    try { text = fs.readFileSync(_file, 'utf8'); } catch { return []; }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { const e = JSON.parse(line); if (e && typeof e === 'object') out.push(e); } catch { /* a torn line */ }
    }
    return out;
  }
  const isEntry = (e) => e && !e.marker && typeof e.id === 'string';

  /** Newest first. `before` is an entry id (older than it) or a time in ms; `filter(entry)` keeps what it returns true for. */
  function list({ limit = 50, before = null, store = null, key = null, user = null, filter = null } = {}) {
    let all = readAll().filter(isEntry);
    if (before !== null && before !== undefined && before !== '') {
      if (/^\d+$/.test(String(before))) all = all.filter((e) => e.at < Number(before));
      else { const i = all.findIndex((e) => e.id === String(before)); if (i >= 0) all = all.slice(0, i); }
    }
    if (store) all = all.filter((e) => e.store === store);
    if (key) all = all.filter((e) => e.key === key || e.key.startsWith(`${key}.`));
    if (user) all = all.filter((e) => (e.who && e.who.user === user) || e.key.startsWith(`prefs.${user}.`));
    if (typeof filter === 'function') all = all.filter(filter);
    const n = Math.max(1, Math.min(500, Number(limit) || 50));
    return all.reverse().slice(0, n);
  }
  function get(id) { return readAll().filter(isEntry).find((e) => e.id === String(id)) || null; }

  // ── The command line writes a marker after its own write ────────────────
  function mark(store, stamp) {
    if (!stamp) return;
    try { append([{ marker: true, store, stamp, at: now() }]); } catch { /* best effort: the worst case is one outside entry */ }
  }
  /** After a store's own write: only the command line (another process) leaves a marker. */
  function afterWrite(store, stamp) { if (current().kind === 'cli') mark(store, stamp); }
  function isMarked(store, stamp) {
    try {
      const st = fs.statSync(_file);
      const len = Math.min(st.size, 256 * 1024);
      const fd = fs.openSync(_file, 'r');
      const buf = Buffer.alloc(len);
      try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.includes('"marker"')) continue;
        try { const m = JSON.parse(line); if (m && m.marker && m.store === store && m.stamp === stamp) return true; } catch { /* partial first line */ }
      }
    } catch { /* no journal yet */ }
    return false;
  }

  // ── Outside edits: journal + one batched notice per file ────────────────
  const pending = new Map();   // label -> { keys: Map(key -> secret?), firstAt, timer, invalid, lastSentAt }
  function stateOf(label) { let s = pending.get(label); if (!s) { s = { keys: new Map(), firstAt: null, timer: null, invalid: false, lastSentAt: null }; pending.set(label, s); } return s; }
  function schedule(label, s, delay) {
    if (s.timer) return;
    s.timer = _timers.setTimeout(() => { s.timer = null; flush(label); }, delay);
    if (s.timer && typeof s.timer.unref === 'function') s.timer.unref();
  }
  function flush(label) {
    const s = stateOf(label);
    if (!s.keys.size && !s.invalid) return;
    if (s.lastSentAt !== null && now() - s.lastSentAt < NOTICE_GAP_MS) { schedule(label, s, Math.max(1000, NOTICE_GAP_MS - (now() - s.lastSentAt))); return; }
    const text = noticeText(label, s);
    s.keys = new Map(); s.invalid = false; s.firstAt = null; s.lastSentAt = now();
    sendNotice(label, text);
  }
  function noticeText(label, s) {
    const when = new Date(s.firstAt || now());
    const at = when.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });
    const who = 'a program on this computer, not your Maestro\'s screens or Maestro';
    const parts = [];
    if (s.keys.size) {
      const names = [...s.keys.entries()].slice(0, 8).map(([k, secret]) => (secret ? `${k} (an API key or other secret was replaced)` : k));
      const more = s.keys.size > 8 ? ` and ${s.keys.size - 8} more` : '';
      parts.push(`Changed: ${names.join(', ')}${more}.`);
    }
    if (s.invalid) parts.push('The file is not valid JSON right now, so Maestro keeps its own copy of the settings and ignores the file until it is fixed.');
    return `${label} was edited by ${who}, at ${at}. ${parts.join(' ')} You can restore a change in Settings.`;
  }
  function sendNotice(label, text) {
    const payload = { title: 'Settings changed outside your Maestro', body: text, url: '/', tag: `settings-outside-${label}` };
    try {
      if (_notify) { Promise.resolve(_notify(payload)).catch(() => {}); return; }
      Promise.resolve(require('./push').getPush().notify(payload, { adminsOnly: true, kind: 'security' })).catch(() => {});
    } catch { /* no push set up: the journal still has the entries */ }
  }
  /** A store found its file changed by someone else: `changes` is the diff old copy -> new file. Journals it (who.kind "outside")
   *  and queues one notice (collected for 60 s; at most one per file per 10 minutes). Never throws. */
  function noteOutside(store, label, changes) {
    try {
      const entries = recordChange(store, changes, { actor: { kind: 'outside' }, why: 'file changed outside the hub' });
      const s = stateOf(label);
      for (const e of entries) s.keys.set(e.key, isSecretKey(e.key, recordFor(store, e.key), store));
      if (entries.length && s.firstAt === null) s.firstAt = now();
      if (entries.length) schedule(label, s, BATCH_MS);
      return entries;
    } catch (e) { console.warn(`[settings-journal] could not journal an outside edit of ${label}: ${e.message}`); return []; }
  }
  /** The changed file could not be parsed: the store keeps its copy. One notice says so. */
  function noteOutsideInvalid(label) {
    try { const s = stateOf(label); if (s.firstAt === null) s.firstAt = now(); s.invalid = true; schedule(label, s, BATCH_MS); } catch { /* ignore */ }
  }

  // ── Restore ─────────────────────────────────────────────────────────────
  // actor: { user, isAdmin, isAdminSession }. The caller (the route) has already checked that this person may touch the entry's
  // store; this function checks the entry and the protection rule.
  function restore(id, actor = {}) {
    const e = get(id);
    if (!e) return { ok: false, status: 404, error: 'No such journal entry.' };
    if (!e.restorable) return { ok: false, status: 400, error: isSecretKey(e.key, e.record ? safeById(e.record) : null, e.store) ? 'This one holds a secret, so it is never kept and cannot be restored here. Enter it again where it belongs.' : 'This change cannot be restored from the journal.' };
    const record = e.record ? safeById(e.record) : recordFor(e.store, e.key);
    if (needsOwnSession(e.store, e.key, record) && !(actor && actor.isAdminSession)) {
      return { ok: false, status: 403, error: 'This change touches a protection (access, spending, safety or sign-in). Restore it from Settings, signed in as an admin in your own browser.' };
    }
    const io = adapters(e);
    if (!io) return { ok: false, status: 400, error: 'This change cannot be restored from the journal.' };
    let cur;
    try { cur = io.read(); } catch (err) { return { ok: false, status: 500, error: `Could not read the current value: ${err.message}` }; }
    if (!sameValue(cur, e.after)) return { ok: false, status: 409, error: 'The value has changed since, so nothing was restored.', current: cur === undefined ? null : cur };
    try {
      const r = withActor({ kind: 'restore', user: actor && actor.user, why: `restored ${e.id}` }, () => io.write(e.before));
      if (r && r.ok === false) return { ok: false, status: 400, error: r.error || 'Could not restore.' };
    } catch (err) { return { ok: false, status: 500, error: `Nothing was restored: ${err.message}` }; }
    return { ok: true, id: e.id, key: e.key, value: e.before === undefined ? null : e.before };
  }
  // ── What each person may see and restore (the routes in server.js call these) ──
  // agents: [{ name, owner }]. An admin sees everything; a member only their own preferences and the agents they own.
  const mineOf = (user, agents) => new Set((agents || []).filter((a) => a && user && a.owner === user).map((a) => a.name));
  function listFor({ user = null, isAdmin = false, agents = [], limit = 50, before = null } = {}) {
    if (isAdmin) return list({ limit, before });
    if (!user) return [];
    const mine = mineOf(user, agents);
    return list({ limit, before, filter: (e) => (e.store === 'prefs' && e.key.startsWith(`prefs.${user}.`)) || (e.store === 'agents' && mine.has(e.key.split('.')[1])) });
  }
  function restoreFor(id, { user = null, isAdmin = false, isAdminSession = false, agents = [] } = {}) {
    const e = get(id);
    if (!e) return { ok: false, status: 404, error: 'No such journal entry.' };
    if (!isAdmin) {
      let allowed = false;
      if (user && e.store === 'prefs') allowed = e.key.startsWith(`prefs.${user}.`);
      else if (user && e.store === 'agents') {
        const rec = recordFor('agents', e.key);
        allowed = mineOf(user, agents).has(e.key.split('.')[1]) && !!rec && rec.danger === 'everyday' && !needsOwnSession('agents', e.key, rec);
      }
      if (!allowed) return { ok: false, status: 403, error: 'Only an admin can restore this change.' };
    }
    return restore(id, { user, isAdmin, isAdminSession });
  }
  function safeById(id) { try { return require('./settings-records').byId(id); } catch { return null; } }
  function adapters(e) {
    const { owner, rest } = splitKey(e.store, e.key);
    if (e.store === 'settings') {
      const st = require('./settings');
      return { read: () => st.getPath(e.key), write: (v) => { st.setPath(e.key, v, { remove: v === undefined }); return { ok: true }; } };
    }
    if (e.store === 'agents') {
      const ag = require('./agents');
      if (!owner || !rest.length) return null;
      return { read: () => ag.readAgentValue(owner, rest.join('.')), write: (v) => ag.writeAgentValue(owner, rest.join('.'), v, { remove: v === undefined }) };
    }
    if (e.store === 'prefs') {
      const au = require('./auth').getAuth();
      if (!owner || rest.length !== 1) return null;
      return {
        read: () => { const u = au.getUser(owner); return u && u[rest[0]] !== null ? u[rest[0]] : undefined; },
        write: (v) => (v === undefined ? { ok: false, error: 'There was no value before, so there is nothing to put back.' } : au.setPrefs(owner, { [rest[0]]: v })),
      };
    }
    return null;
  }

  return {
    append, recordChange, list, get, restore, listFor, restoreFor, mark, afterWrite, isMarked, noteOutside, noteOutsideInvalid, flush, fileOf,
    /** Tests: another clock, timers or notice function. */
    configure(o = {}) { if (o.clock) _clock = o.clock; if (o.timers) _timers = o.timers; if (o.notify !== undefined) _notify = o.notify; if (o.file) _file = o.file; },
    _pending: pending,
  };
}

// One journal per data folder; the default one is this install's data/settings-journal.jsonl.
const instances = new Map();
function forDir(dataDir) {
  const f = path.join(dataDir, 'settings-journal.jsonl');
  let j = instances.get(f);
  if (!j) { j = createJournal({ file: f }); instances.set(f, j); }
  return j;
}
const DATA_DIR = path.join(__dirname, '..', 'data');
const def = forDir(DATA_DIR);

module.exports = {
  ...def, createJournal, forDir, diff, diffAgents, withActor, enterActor, current, bindRequest,
  isSecretKey, isSecretName, stripSecrets, recordFor, needsOwnSession, same,
  MAX_VALUE_BYTES, MAX_FILE_BYTES, BATCH_MS, NOTICE_GAP_MS, KINDS,
};
