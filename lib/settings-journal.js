'use strict';
// The one journal for every settings change (data/settings-journal.jsonl, owner-only, one JSON line per changed key).
//
// Every writer of a settings store goes through the hooks in lib/settings.js (settings.json), lib/agents.js (agents.json) and
// lib/auth.js (a person's preferences in users.json); each hook diffs the old and new state and calls recordChange() BEFORE it
// writes. A change the journal cannot record is refused (recordChange throws; the caller does not write).
//
// Entry: { id: "sj-xxxxxxxxxx", at: ms, who: { kind: person|lead|agent|hub|update|cli|outside|restore, user?, agent?, turn? },
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
const FILES_LABEL = 'protected files';   // the batched notice for the files the stamp watch covers
const KINDS = ['person', 'lead', 'agent', 'hub', 'update', 'cli', 'outside', 'restore'];   // agent: any other agent's tool (model_offer, team_set, create_agent, rename_me...)

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

// ── Redaction ─────────────────────────────────────────────────────────────
// A credential inside a URL (scheme://user:pass@host, or scheme://token@host) is never kept: values and notices show scheme://***@host.
// A credential in a query parameter or fragment (?api_key=..., &token=..., #access_token=...; the name in any case) shows as name=***.
const URL_CREDS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi;
const QUERY_CREDS = /([?&#](?:api[_-]?key|key|token|access[_-]?token|secret|password|pass|sig|signature|auth)=)[^&#\s"'<>]*/gi;
function redactUrlText(s) { return String(s).replace(URL_CREDS, '$1***@').replace(QUERY_CREDS, '$1***'); }
/** A copy of a value with the credentials of every URL string in it removed (at any depth). */
function redactUrls(v, depth = 0) {
  if (typeof v === 'string') return v.includes('://') || /[?&#][^=\s]+=/.test(v) ? redactUrlText(v) : v;
  if (Array.isArray(v)) return depth > 8 ? v : v.map((x) => redactUrls(x, depth + 1));
  if (v && typeof v === 'object') {
    if (depth > 8) return v;
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = redactUrls(x, depth + 1);
    return o;
  }
  return v;
}
// Text that may carry a secret (a reason, a note): well-known key shapes, "password: value" pairs, bearer tokens and long mixed tokens.
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}/g, /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, /\bgithub_pat_[A-Za-z0-9_]{16,}/g, /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /\bAKIA[0-9A-Z]{12,}/g, /\bAIza[0-9A-Za-z_-]{16,}/g, /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:api[_ -]?key|token|secret|pass(?:word|phrase)?|seed(?: phrase)?|private[_ -]?key)\b\s*(?:is|=|:)\s*\S+/gi,
  /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g,
];
/** Text with URL credentials and anything that looks like a secret replaced by "(redacted)". */
function scrubText(s) {
  if (s === undefined || s === null) return s;
  let t = redactUrlText(String(s));
  for (const re of SECRET_PATTERNS) t = t.replace(re, '(redacted)');
  return t;
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
function withActor(ctx, fn) { return als.run(newScope(ctx), fn); }
// Every scope also collects the ids of the entries that were recorded inside it (not enumerable: an actor copy never carries them).
function newScope(ctx) { const o = normaliseActor(ctx); Object.defineProperty(o, '_ids', { value: [], enumerable: false }); return o; }
/** Like withActor, resolves { result, ids }: ids are the entries recorded by THIS operation's own flow, in order (never another
 *  request's write that happened meanwhile). */
async function withActorCollect(ctx, fn) {
  const scope = newScope(ctx);
  const result = await als.run(scope, fn);
  return { result, ids: scope._ids.slice() };
}
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
    for (const m of r.storedAs.matchAll(/settings\.([A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)*)/g)) add(`settings:${m[1]}`, r);   // a hyphen is part of a key (workersAtOnce.claude-sdk)
    for (const m of r.storedAs.matchAll(/agents\[\]\.([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)/g)) add(`agents:${m[1]}`, r);
    for (const m of r.storedAs.matchAll(/(?:prefs|users\[\])\.([A-Za-z][A-Za-z0-9_]*)/g)) add(`prefs:${m[1]}`, r);
  }
  // The preference stores that have their own files (research choice, notify modes, voice reminder): found through the same
  // reading of a record that the lead's tool uses (lib/settings-apply target), so a journal line can name its record.
  try {
    const sa = require('./settings-apply');
    for (const r of all) {
      if (r.mergedInto) continue;
      const t = sa.target(r);
      if (t.kind !== 'prefs') continue;
      if (t.store === 'research') add(`prefs:research.${t.field}`, r);
      else if (t.store === 'voice') add(`prefs:voice.${t.field}`, r);
      else if (t.store === 'notify') add(t.scope === 'default' ? `prefs:notify.default.${t.field}` : `prefs:notify.agents.*.${t.field}`, r);
    }
  } catch { /* the records are optional here */ }
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
  let { rest } = splitKey(store, key);
  if (store === 'prefs' && rest[0] === 'notify' && rest[1] === 'agents' && rest.length >= 4) rest = ['notify', 'agents', '*', rest[3]];   // the agent's name is not part of the record's key
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
// A person's preferences: the page ones in users.json (prefs.<user>.<field>) and the ones with their own files, which the
// setters journal as prefs.<user>.research.<choice|alwaysLevel>, prefs.<user>.notify.default.<kind>,
// prefs.<user>.notify.agents.<agent>.<kind> and prefs.<user>.voice.interruptReminder.
const NOTIFY_KINDS = ['questions', 'requested', 'other', 'security'];
function prefRestorable(key) {
  const { rest } = splitKey('prefs', key);
  if (rest.length === 1) return PREF_RESTORABLE.has(rest[0]);
  if (rest[0] === 'research') return rest.length === 2 && (rest[1] === 'choice' || rest[1] === 'alwaysLevel');
  if (rest[0] === 'voice') return rest.length === 2 && rest[1] === 'interruptReminder';
  if (rest[0] === 'notify') {
    if (rest[1] === 'default') return rest.length === 3 && NOTIFY_KINDS.includes(rest[2]);
    if (rest[1] === 'agents') return rest.length === 4 && NOTIFY_KINDS.includes(rest[3]) && rest[3] !== 'security';
  }
  return false;
}
// Keys no restore ever writes: each has its own screen that asks for the password or a code again (the bulk settings route drops the
// same keys), and they are not journaled as restorable. Compared by the top key.
// The list is the bulk route's dropped keys (lib/settings-apply DROPPED_KEYS: one list, read when needed) plus requireAdmin2fa.
const NEVER_RESTORE_FALLBACK = ['requireAdmin2fa', 'backup', 'walletAgents', 'walletOwner', 'receiverAliases'];   // only when lib/settings-apply cannot be loaded
function neverRestoreKeys() {
  let dropped = NEVER_RESTORE_FALLBACK;
  try { dropped = Object.keys(require('./settings-apply').DROPPED_KEYS); } catch { /* a copy of this file alone */ }
  return new Set([...dropped, 'requireAdmin2fa']);
}
function neverRestorable(store, key) { return store === 'settings' && neverRestoreKeys().has(String(key).split('.')[0]); }
function buildEntry({ store, key, before, after, actor, why, now, agentMeta = null }) {
  const record = recordFor(store, key);
  const secret = isSecretKey(key, record, store);
  let b, a, big = false, redacted = false;
  if (secret) {
    b = before === undefined ? undefined : 'set';
    a = after === undefined ? 'removed' : before === undefined ? 'set' : 'replaced';
    // a whole object that holds a secret field below the walked depth is still only a word
  } else {
    const cb = stripSecrets(before), ca = stripSecrets(after);
    const rb = redactUrls(cb), ra = redactUrls(ca);
    redacted = !same(cb, rb) || !same(ca, ra);   // a value with a credential in a URL is not kept as it was, so it cannot be put back
    const sb = shape(rb), sa = shape(ra);
    b = sb.value; a = sa.value; big = sb.big || sa.big;
  }
  // (a key that is itself a URL with a credential is shown without it, and cannot be put back by that name)
  const shownKey = redactUrlText(key);
  if (shownKey !== key) redacted = true;
  const entry = {
    id: `sj-${crypto.randomBytes(5).toString('hex')}`,
    at: now(),
    who: whoOf(actor),
    store, key: shownKey, record: record ? record.id : null,
  };
  if (b !== undefined) entry.before = b;
  if (a !== undefined) entry.after = a;
  // The reason is scrubbed with the secret patterns before it is written (a person's or an agent's words can carry a key).
  const rawWhy = why || actor.why || null;
  entry.why = rawWhy === null ? null : scrubText(rawWhy);
  // An agent's entry says which agent it was (its stamp) and who owned it then, so a later agent of the same name never inherits it.
  if (store === 'agents') {
    const name = splitKey(store, key).owner;
    const m = agentMeta && name ? agentMeta[name] : null;
    entry.stamp = m && m.stamp ? m.stamp : null;
    entry.owner = m && m.owner ? m.owner : null;
  }
  let restorable = !secret && !big && !redacted;
  if (neverRestorable(store, key)) restorable = false;
  if (store === 'prefs' && !prefRestorable(key)) restorable = false;
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

// ── What a person reads: a value in words ─────────────────────────────────
/** A journal value as short display text. A secret was already stored as a word ("set", "replaced", "removed"); a long value is cut. */
function displayValue(v) {
  if (v === undefined || v === null) return 'not set';
  if (v === true) return 'on';
  if (v === false) return 'off';
  if (typeof v === 'string') return v.length > 160 ? `${v.slice(0, 157)}...` : v;
  let s; try { s = JSON.stringify(v); } catch { s = String(v); }
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
}
const UNDO_MS = 24 * 60 * 60 * 1000;
/** One journal entry as the pages show it: name (the record's name, else the key), agentName (display name of the agent it was
 *  for, or null), before and after as display text (secrets masked: they are words in the journal), undoUntil (at + 24 h).
 *  agents: [{ name, display }] to turn an agent's short name into its display name. */
function viewEntry(e, agents = []) {
  const record = e.record ? safeRecord(e.record) : recordFor(e.store, e.key);
  let agent = null;
  if (e.store === 'agents') agent = e.key.split('.')[1] || null;
  else if (e.store === 'prefs') { const r = splitKey('prefs', e.key).rest; if (r[0] === 'notify' && r[1] === 'agents') agent = r[2] || null; }
  const found = agent ? (agents || []).find((a) => a && a.name === agent) : null;
  const agentName = agent ? ((found && found.display) || agent) : null;
  return {
    id: e.id, at: e.at, who: e.who, store: e.store, key: e.key, record: e.record || null,
    name: record ? record.name : e.key, agent, agentName,
    before: displayValue(e.before), after: displayValue(e.after),
    why: e.why || null, restorable: e.restorable === true, undoUntil: e.at + UNDO_MS,
  };
}
function safeRecord(id) { try { return require('./settings-records').byId(id); } catch { return null; } }

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

  /** changes: [{key, before, after}] from diff(). Builds the entries and appends them all at once; throws when it cannot write.
   *  pending: true is the first phase of a write the caller is about to make: the entries carry pending:true and nobody sees them
   *  (list, get, Restore, the change strip) until commit(entries) appends the commit lines after the file write succeeded; a crash
   *  in between leaves invisible pending entries. Without pending the entries are visible at once (a change that is only noted,
   *  such as an outside edit). */
  function recordChange(store, changes, { actor = null, why = null, agents = null, pending: isPending = false } = {}) {
    if (!changes || !changes.length) return [];
    const who = normaliseActor(actor || current());
    const entries = changes.map((c) => buildEntry({ store, key: c.key, before: c.before, after: c.after, actor: who, why, now, agentMeta: agents }));
    if (isPending) for (const e of entries) e.pending = true;
    append(entries);
    // The running operation's own entries (withActorCollect): only those of its own actor, never an outside edit found on the way.
    const scope = als.getStore();
    if (scope && scope._ids) for (const e of entries) if (e.who.kind === scope.kind && (e.who.user || null) === (scope.user || null)) scope._ids.push(e.id);
    return entries;
  }
  /** Second phase: the file write the pending entries announced succeeded. One commit line per entry; the entries are visible from now on.
   *  Never throws (the file is written already; the worst case is an entry that stays invisible). */
  function commit(entries) {
    try { append((entries || []).filter((e) => e && e.id && e.pending).map((e) => ({ commitOf: e.id, at: now() }))); }
    catch (e) { console.warn(`[settings-journal] could not commit the journal entries of a saved change: ${e.message}`); }
  }
  /** The write the entries announced did not happen (the file could not be written): one line per entry says so, and list(), get()
   *  and Restore skip those entries from then on; the operation's id collector drops them. Never throws. */
  function recordFailure(entries) {
    const ids = (entries || []).filter((e) => e && e.id).map((e) => e.id);
    const scope = als.getStore();
    if (scope && scope._ids) for (const id of ids) { const i = scope._ids.indexOf(id); if (i >= 0) scope._ids.splice(i, 1); }
    try { append(ids.map((id) => ({ failedOf: id, at: now() }))); } catch { /* best effort */ }
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
  /** Every real entry (no markers, no failure or commit lines) whose write did happen: a pending entry counts once its commit line is there. */
  function liveEntries() {
    const lines = readAll();
    const failed = new Set(lines.filter((e) => e && typeof e.failedOf === 'string').map((e) => e.failedOf));
    const committed = new Set(lines.filter((e) => e && typeof e.commitOf === 'string').map((e) => e.commitOf));
    return lines.filter((e) => isEntry(e) && !failed.has(e.id) && (!e.pending || committed.has(e.id)));
  }

  /** Newest first. `before` is an entry id (older than it) or a time in ms; `filter(entry)` keeps what it returns true for. */
  function list({ limit = 50, before = null, store = null, key = null, user = null, filter = null } = {}) {
    let all = liveEntries();
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
  function get(id) { return liveEntries().find((e) => e.id === String(id)) || null; }

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
    const text = redactUrlText(noticeText(label, s));
    s.keys = new Map(); s.invalid = false; s.firstAt = null; s.lastSentAt = now();
    sendNotice(label, text);
  }
  function noticeText(label, s) {
    const when = new Date(s.firstAt || now());
    const at = when.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });
    const who = 'a program on this computer, not your Maestro\'s screens or Maestro';
    const parts = [];
    if (label === FILES_LABEL) {
      // File-level notice: the values are not kept, so there is nothing to restore here: the person checks the files.
      const names = [...s.keys.keys()].slice(0, 8);
      const more = s.keys.size > 8 ? ` and ${s.keys.size - 8} more` : '';
      return `Some of Maestro's protected files were edited by ${who}, at ${at}. Changed: ${names.join(', ')}${more}. The values are not kept in the change history, so check these files if you did not expect this.`;
    }
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
  function noteOutside(store, label, changes, { agents = null } = {}) {
    try {
      const entries = recordChange(store, changes, { actor: { kind: 'outside' }, why: 'file changed outside the hub', agents });
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
  /** A protected file the hub keeps no per-key journal of (users, connectors, modules, local models, research / voice / push
   *  preferences, behaviour reviews, wallet files) changed and the hub did not write it. One file-level entry (store "files", key
   *  "files/<name>", no values: these files hold secrets and accounts) and the name joins the batched notice. Never throws. */
  function noteOutsideFile(name) {
    try {
      const entry = { id: `sj-${crypto.randomBytes(5).toString('hex')}`, at: now(), who: { kind: 'outside' }, store: 'files', key: `files/${name}`, record: null,
        why: 'file changed outside the hub', restorable: false };
      append([entry]);
      const s = stateOf(FILES_LABEL);
      s.keys.set(name, false);
      if (s.firstAt === null) s.firstAt = now();
      schedule(FILES_LABEL, s, BATCH_MS);
      return entry;
    } catch (e) { console.warn(`[settings-journal] could not journal an outside edit of ${name}: ${e.message}`); return null; }
  }

  // ── Restore ─────────────────────────────────────────────────────────────
  // actor: { user, isAdmin, isAdminSession }. The caller (the route) has already checked that this person may touch the entry's
  // store; this function checks the entry and the protection rule.
  function restore(id, actor = {}) {
    const e = get(id);
    if (!e) return { ok: false, status: 404, error: 'No such journal entry.' };
    // A protection with its own screen (the admin two-factor rule, backups, wallet agents and owner, receiver aliases) is never put back
    // from here, whatever an older entry says: those screens ask for the password or a code again.
    if (neverRestorable(e.store, e.key)) return { ok: false, status: 400, error: 'This is a protection with its own screen (it asks for your password or a code), so it cannot be restored from the change history. Change it on that screen.' };
    if (!e.restorable) return { ok: false, status: 400, error: isSecretKey(e.key, e.record ? safeById(e.record) : null, e.store) ? 'This one holds a secret, so it is never kept and cannot be restored here. Enter it again where it belongs.' : 'This change cannot be restored from the journal.' };
    // An agent's entry is put back only while it is still the agent the entry was made on (a deleted agent made again under the same name is another agent).
    if (e.store === 'agents' && !sameAgentAs(e, agentRecord(splitKey(e.store, e.key).owner))) {
      if (typeof e.stamp !== 'string' || e.stamp === '') return { ok: false, status: 409, error: 'This is an older entry from before agents were tracked, so it cannot be put back from here. Change the agent on its own screen.' };
      return { ok: false, status: 409, error: 'That agent is no longer the one this change was made on, so it was left as it is.' };
    }
    const record = e.record ? safeById(e.record) : recordFor(e.store, e.key);
    if (needsOwnSession(e.store, e.key, record) && !(actor && actor.isAdminSession)) {
      return { ok: false, status: 403, error: 'This change touches a protection (access, spending, safety or sign-in). Restore it from Settings, signed in as an admin in your own browser.' };
    }
    const io = adapters(e, actor || {});
    if (!io) return { ok: false, status: 400, error: 'This change cannot be restored from the journal.' };
    let cur;
    try { cur = io.read(); } catch (err) { return { ok: false, status: 500, error: `Could not read the current value: ${err.message}` }; }
    if (!sameValue(cur, e.after)) return { ok: false, status: 409, error: 'It has changed since, so it was left as it is.', current: cur === undefined ? null : cur };
    try {
      const r = withActor({ kind: 'restore', user: actor && actor.user, why: `restored ${e.id}` }, () => io.write(e.before));
      if (r && r.ok === false) return { ok: false, status: 400, error: r.error || 'Could not restore.' };
    } catch (err) { return { ok: false, status: 500, error: `Nothing was restored: ${err.message}` }; }
    return { ok: true, id: e.id, key: e.key, value: e.before === undefined ? null : e.before };
  }
  // ── What each person may see and restore (the routes in server.js call these) ──
  // agents: [{ name, owner, box? }]. An admin sees everything; a member only their own preferences and the agents they own: an agent's
  // entry only when it was recorded with them as the owner AND the agent it was made on is still the current agent of that name.
  const sameOwner = (a, b) => a !== undefined && a !== null && b !== undefined && b !== null && String(a) === String(b);
  function mineEntry(e, user, agents) {
    const name = splitKey('agents', e.key).owner;
    const a = (agents || []).find((x) => x && x.name === name);
    return !!a && sameOwner(a.owner, user) && sameOwner(e.owner, user) && sameAgentAs(e, a);
  }
  // filter(entry): an extra condition (by=lead, since=...) applied before the limit.
  function listFor({ user = null, isAdmin = false, agents = [], limit = 50, before = null, filter = null } = {}) {
    if (isAdmin) return list({ limit, before, filter });
    if (!user) return [];
    return list({ limit, before, filter: (e) => ((e.store === 'prefs' && e.key.startsWith(`prefs.${user}.`)) || (e.store === 'agents' && mineEntry(e, user, agents))) && (typeof filter !== 'function' || filter(e)) });
  }
  /** The ids of entries that were put back (a later "restore" entry says "restored <id>"): the chat's change strip shows "Put back." for them. */
  function restoredIds(sinceMs = 0) {
    const out = new Set();
    for (const e of liveEntries()) {
      if (!e.who || e.who.kind !== 'restore' || e.at < sinceMs) continue;
      const m = /^restored (sj-[0-9a-f]{10})$/.exec(String(e.why || ''));
      if (m) out.add(m[1]);
    }
    return out;
  }
  function restoreFor(id, { user = null, isAdmin = false, isAdminSession = false, agents = [] } = {}) {
    const e = get(id);
    if (!e) return { ok: false, status: 404, error: 'No such journal entry.' };
    if (!isAdmin) {
      let allowed = false;
      if (user && e.store === 'prefs') allowed = e.key.startsWith(`prefs.${user}.`);
      else if (user && e.store === 'agents') {
        const rec = recordFor('agents', e.key);
        allowed = mineEntry(e, user, agents) && !!rec && rec.danger === 'everyday' && !needsOwnSession('agents', e.key, rec);
      }
      if (!allowed) return { ok: false, status: 403, error: 'Only an admin can restore this change.' };
    }
    return restore(id, { user, isAdmin, isAdminSession });
  }
  function safeById(id) { try { return require('./settings-records').byId(id); } catch { return null; } }
  /** The agent's record now (read from its file), or null. */
  function agentRecord(name) {
    try { return require('./agents').loadAgentsFromDisk().find((x) => x && x.name === name) || null; } catch { return null; }
  }
  /** Is `rec` (the agent's record now) the agent this entry was recorded on? An entry with no stamp (an older line) never matches. */
  function sameAgentAs(e, rec) { return !!rec && typeof e.stamp === 'string' && e.stamp !== '' && e.stamp === agentIdentity(rec); }
  function adapters(e, actor = {}) {
    const { owner, rest } = splitKey(e.store, e.key);
    if (e.store === 'settings') {
      const st = require('./settings');
      // Through lib/settings-apply (restoreSetting): the same validated setter and runtime follow-ups as the original change
      // (setGlobalSetting for the one-value globals, updateSettings + afterSettingsWrite otherwise), never setPath alone.
      return { read: () => st.getPath(e.key), write: (v) => require('./settings-apply').restoreSetting(e.key, v, actor) };
    }
    if (e.store === 'agents') {
      const ag = require('./agents');
      if (!owner || !rest.length) return null;
      // Through updateAgentField with the same guards and follow-ups as PATCH /api/agents/:name (lib/settings-apply restoreAgentField).
      return { read: () => ag.readAgentValue(owner, rest.join('.')), write: (v) => require('./settings-apply').restoreAgentField(owner, rest.join('.'), v, actor) };
    }
    if (e.store === 'prefs' && owner && rest.length >= 2 && prefRestorable(e.key)) {
      // The preferences that have their own files are restored through their own setters (which journal the restore again).
      if (rest[0] === 'research') {
        const rp = require('./research-prefs').getResearchPrefs();
        return rest[1] === 'choice'
          ? { read: () => rp.choiceOf(owner), write: (v) => { if (v === undefined) return { ok: false, error: 'There was no value before, so there is nothing to put back.' }; rp.setChoice(owner, v); return { ok: true }; } }
          : { read: () => rp.alwaysLevelOf(owner), write: (v) => { if (v === undefined) return { ok: false, error: 'There was no value before, so there is nothing to put back.' }; rp.setAlwaysLevel(owner, v); return { ok: true }; } };
      }
      if (rest[0] === 'voice') {
        const vp = require('./voice-person-prefs').getVoicePersonPrefs();
        return { read: () => vp.interruptReminder(owner), write: (v) => { if (typeof v !== 'boolean') return { ok: false, error: 'There was no value before, so there is nothing to put back.' }; vp.setInterruptReminder(owner, v); return { ok: true }; } };
      }
      if (rest[0] === 'notify') {
        const np = require('./notify-prefs').getNotifyPrefs();
        if (rest[1] === 'default') return { read: () => np.get(owner).default[rest[2]], write: (v) => { if (v === undefined) return { ok: false, error: 'There was no value before, so there is nothing to put back.' }; np.setDefault(owner, { [rest[2]]: v }); return { ok: true }; } };
        const agent = rest[2], kind = rest[3];
        return { read: () => { const a = np.get(owner).agents[agent]; return a ? a[kind] : undefined; }, write: (v) => { np.setAgent(owner, agent, { [kind]: v === undefined ? null : v }); return { ok: true }; } };
      }
      return null;
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
    append, recordChange, commit, recordFailure, list, get, restore, listFor, restoreFor, restoredIds, mark, afterWrite, isMarked, noteOutside, noteOutsideInvalid, noteOutsideFile, flush, fileOf,
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

/** The data folder a preference file belongs to: its own folder, or the one above when it sits in data/push/. */
function prefsDir(file) {
  const d = path.dirname(String(file));
  return path.basename(d) === 'push' ? path.dirname(d) : d;
}
/** The setters of research-prefs, notify-prefs and voice-person-prefs journal their change BEFORE they write, with this: changes is
 *  [{ key: "prefs.<user>.<store>.<field>", before, after }]. Throws (the setter then writes nothing) when the journal cannot be written. */
function recordPrefs(file, changes) {
  if (!changes || !changes.length) return [];
  try { return forDir(prefsDir(file)).recordChange('prefs', changes); }
  catch (e) { throw new Error(`Nothing was changed: the change journal could not be written (${e.message}).`); }
}
/** The two-phase way a preference setter writes: journals `changes` as pending entries (nobody sees them yet), runs writeFn (the file
 *  write), then commits them; when writeFn throws the entries are marked failed (list and Restore skip them) and the error propagates,
 *  so a setter never reports a change that was not written. Returns writeFn's result. */
function journaledWrite(file, changes, writeFn) {
  const j = forDir(prefsDir(file));
  let entries = [];
  if (changes && changes.length) {
    try { entries = j.recordChange('prefs', changes, { pending: true }); }
    catch (e) { throw new Error(`Nothing was changed: the change journal could not be written (${e.message}).`); }
  }
  let r;
  try { r = writeFn(); }
  catch (e) { if (entries.length) j.recordFailure(entries); throw e; }
  if (entries.length) j.commit(entries);
  return r;
}

/** Who an agent is beyond its name: its box id, or its name for an agent from before box ids (the same as lib/agents identityOf).
 *  An agent deleted and made again under the same name has another box id. null for no agent. */
function agentIdentity(rec) { return rec && rec.name ? (rec.box ? `box:${rec.box}` : `name:${rec.name}`) : null; }
/** { [agent name]: { stamp, owner } } for the agents in these lists (the first list that has the name wins): what an agent entry records. */
function agentMetaOf(...lists) {
  const m = {};
  for (const l of lists) {
    for (const a of Array.isArray(l) ? l : []) {
      if (!a || typeof a !== 'object' || typeof a.name !== 'string' || m[a.name]) continue;
      m[a.name] = { stamp: agentIdentity(a), owner: a.owner !== undefined && a.owner !== null && a.owner !== '' ? String(a.owner) : null };
    }
  }
  return m;
}

// ── A stamp watch of the other protected files ────────────────────────────
// These files hold accounts, connectors, modules, wallet data and preferences. The hub journals the keys of some of them through their
// stores; for all of them a once-a-minute stamp watch notices a change the hub did not make (an interpreter or a program writing the
// file) and journals it as a file-level "outside" entry without values; the names join one batched notice. The hub's own writes must not
// trigger it: a hook on the file writes of this process (rename, write, append, copy) records the stamp the hub's write left (ownWrite).
// auth.db is left out (sqlite changes it all the time). The settings and agents files have their own per-key detection above.
const WATCH_FILES = ['users.json', 'connectors.json', 'modules.json', 'local-models.json', 'research-prefs.json', 'voice-person-prefs.json', 'push/prefs.json', 'behaviour-reviews.json'];
const WATCH_WALLET = /^wallet-.+/;
const fileStamp = (f) => { try { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}:${s.ino}`; } catch { return null; } };
// A watcher is { covers(path), pre(path), post(path) }: pre runs right BEFORE this process writes (or deletes) a covered file, post right
// after it succeeded.
const watchers = new Set();
function watchTargets(dataDir) {
  const out = WATCH_FILES.map((n) => path.join(dataDir, ...n.split('/')));
  try { for (const n of fs.readdirSync(dataDir)) if (WATCH_WALLET.test(n)) out.push(path.join(dataDir, n)); } catch { /* no data folder yet */ }
  return out;
}
const relIn = (root, f) => path.relative(root, f).split(path.sep).join('/');
const coversIn = (root) => (f) => { const rel = relIn(root, f); return WATCH_FILES.includes(rel) || (!rel.includes('/') && WATCH_WALLET.test(rel)); };
/** Tells the watchers that this process is about to touch (phase "pre") or just touched (phase "post") a file. Never throws. */
function hubTouched(file, phase) {
  try {
    if (typeof file !== 'string' && !(file instanceof URL)) return;
    const f = path.resolve(file instanceof URL ? require('url').fileURLToPath(file) : file);
    for (const w of watchers) if (w.covers(f)) w[phase](f);
  } catch { /* best effort */ }
}
/** The hub wrote (or deleted) this file itself: the watch takes its stamp as the hub's. Never throws; ignores every file the watch does not cover. */
function ownWrite(file) { hubTouched(file, 'post'); }
let hooked = false;
function installOwnWriteHook() {
  if (hooked) return;
  hooked = true;
  const wrap = (obj, name, destIdx, kind) => {
    const orig = obj[name];
    if (typeof orig !== 'function' || orig.__sjHooked) return;
    let w;
    if (kind === 'sync') w = function (...a) { hubTouched(a[destIdx], 'pre'); const r = orig.apply(this, a); ownWrite(a[destIdx]); return r; };
    else if (kind === 'promise') w = function (...a) { hubTouched(a[destIdx], 'pre'); return orig.apply(this, a).then((r) => { ownWrite(a[destIdx]); return r; }); };
    else w = function (...a) {
      hubTouched(a[destIdx], 'pre');
      const i = a.length - 1;
      if (typeof a[i] === 'function') { const cb = a[i]; a[i] = function (...r) { if (!r[0]) ownWrite(a[destIdx]); return cb.apply(this, r); }; }
      return orig.apply(this, a);
    };
    w.__sjHooked = true;
    obj[name] = w;
  };
  wrap(fs, 'renameSync', 1, 'sync'); wrap(fs, 'writeFileSync', 0, 'sync'); wrap(fs, 'appendFileSync', 0, 'sync'); wrap(fs, 'copyFileSync', 1, 'sync');
  wrap(fs, 'rename', 1, 'callback'); wrap(fs, 'writeFile', 0, 'callback'); wrap(fs, 'appendFile', 0, 'callback'); wrap(fs, 'copyFile', 1, 'callback');
  // A deletion by the hub is the hub's own change (the stamp becomes "gone" and that is what the watch expects next).
  wrap(fs, 'unlinkSync', 0, 'sync'); wrap(fs, 'rmSync', 0, 'sync'); wrap(fs, 'unlink', 0, 'callback'); wrap(fs, 'rm', 0, 'callback');
  if (fs.promises) {
    wrap(fs.promises, 'rename', 1, 'promise'); wrap(fs.promises, 'writeFile', 0, 'promise'); wrap(fs.promises, 'appendFile', 0, 'promise'); wrap(fs.promises, 'copyFile', 1, 'promise');
    wrap(fs.promises, 'unlink', 0, 'promise'); wrap(fs.promises, 'rm', 0, 'promise');
  }
}
/** The command line (another process) marks its own writes to the protected files, like the marker lines of settings and agents: after a
 *  write the file's new stamp goes into the journal as { marker, store: "files/<name>", stamp }, so the running hub's watch does not
 *  report it as outside. Returns { stop }. */
function startCliMarking({ dataDir = DATA_DIR } = {}) {
  installOwnWriteHook();
  const j = forDir(dataDir);
  const root = path.resolve(dataDir);
  const w = { covers: coversIn(root), pre() {}, post(f) { const st = fileStamp(f); if (st) j.mark(`files/${relIn(root, f)}`, st); } };
  watchers.add(w);
  return { stop() { watchers.delete(w); } };
}
/** Starts the watch on a data folder. intervalMs 0 starts no timer (tests call tick()). Returns { tick, stop }. The first look is the
 *  baseline: a file that is already different from its last stamp when the hub starts is not reported. */
function startWatch({ dataDir = DATA_DIR, intervalMs = 60 * 1000 } = {}) {
  installOwnWriteHook();
  const j = forDir(dataDir);
  const last = new Map();   // file -> the stamp the watch last observed (a look, or the hub's own write)
  const root = path.resolve(dataDir);
  // One look at a file: a stamp that is not the last observed one is an outside edit (journaled, with the notice) unless the command
  // line marked it. Used by the once-a-minute tick AND right before the hub's own write (pre): an outside edit that the tick has not
  // seen yet is recorded first, so the hub's write cannot hide it.
  function look(f) {
    const cur = fileStamp(f);
    const prev = last.has(f) ? last.get(f) : null;
    if (cur === prev) return;
    last.set(f, cur);
    const rel = relIn(root, f);
    if (cur !== null && j.isMarked(`files/${rel}`, cur)) return;   // the command line's own write
    j.noteOutsideFile(rel);
  }
  const w = { covers: coversIn(root), pre: look, post: (f) => { last.set(f, fileStamp(f)); } };   // after the hub's own write (or deletion) the stamp is the hub's
  watchers.add(w);
  for (const f of watchTargets(dataDir)) last.set(f, fileStamp(f));
  function tick() { for (const f of new Set([...watchTargets(dataDir), ...last.keys()])) look(f); }
  let timer = null;
  if (intervalMs > 0) { timer = setInterval(() => { try { tick(); } catch { /* the next look tries again */ } }, intervalMs); if (timer.unref) timer.unref(); }
  return { tick, stop() { if (timer) clearInterval(timer); watchers.delete(w); } };
}

module.exports = {
  ...def, createJournal, forDir, diff, diffAgents, withActor, withActorCollect, enterActor, current, bindRequest,
  recordPrefs, viewEntry, displayValue, prefRestorable, UNDO_MS,
  agentIdentity, agentMetaOf, neverRestorable, scrubText, redactUrls, redactUrlText, startWatch, startCliMarking, ownWrite, journaledWrite,
  isSecretKey, isSecretName, stripSecrets, recordFor, needsOwnSession, same,
  MAX_VALUE_BYTES, MAX_FILE_BYTES, BATCH_MS, NOTICE_GAP_MS, KINDS,
};
