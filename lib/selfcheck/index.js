'use strict';
// The self-check: after every start and nightly, one short real turn per kind of agent on a hidden check agent, and a
// verdict per action from what the hub itself saw (see verify.js). Notifies admins only when something fails.
// This file loads nothing heavy: getSelfCheck() requires the hub's own modules when it is first called.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createStore } = require('./store');
const { makeFixtures, verifyIntact } = require('./fixtures');
const { promptFor, stepOf, scriptedBash: bashFor } = require('./prompt');
const { verifyClass, shellWritePaths } = require('./verify');
const { createScheduler } = require('./schedule');

const CLASSES = ['lead', 'host', 'boxed', 'shared'];
const DEFAULTS = Object.freeze({ enabled: true, afterStart: true, nightlyAt: '03:45', classes: Object.freeze([...CLASSES]), model: 'auto' });
const LABELS = { lead: 'lead agents', host: 'ordinary agents on this computer', boxed: 'agents in a box', shared: 'agents shared with a member' };
const ACTION_WORDS = { read: 'read files', image: 'read pictures', write: 'write files', edit: 'edit files', glob: 'list files', grep: 'search files', bash: 'run commands', refuse: 'keep call recordings private' };
const FOLDER_WORDS = { install: 'in the install folder', home: 'outside the install folder' };
const NO_MODEL = 'There is no model to test with: sign in to Claude, or give your lead agent a model your Maestro runs itself.';
const OWN_TOOLS = /^(codex-cli|codex|perplexity)\//i;
const TURN_MS = 240000;
const HISTORY_MAX = 14;
const MODEL_RE = /^[a-z0-9][a-z0-9._:\/\[\]-]*$/i;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const warned = new Set();   // settings problems already logged (the settings are read often)

/** Settings: refuses what it does not know; returns the merged full object. */
function validateSettings(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'settings must be an object' };
  for (const k of Object.keys(obj)) if (!(k in DEFAULTS)) return { ok: false, error: `unknown setting "${k}"` };
  const v = { ...DEFAULTS, classes: [...DEFAULTS.classes], ...obj };
  if (typeof v.enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false' };
  if (typeof v.afterStart !== 'boolean') return { ok: false, error: 'afterStart must be true or false' };
  if (typeof v.nightlyAt !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.nightlyAt)) return { ok: false, error: 'nightlyAt must be a time like 03:45' };
  if (!Array.isArray(v.classes) || !v.classes.length || v.classes.some(c => !CLASSES.includes(c)) || new Set(v.classes).size !== v.classes.length) return { ok: false, error: `classes must be a list of different kinds from: ${CLASSES.join(', ')}` };
  if (typeof v.model !== 'string' || (v.model !== 'auto' && !(v.model.length >= 1 && v.model.length <= 120 && MODEL_RE.test(v.model)))) return { ok: false, error: 'model must be "auto" or a model id' };
  return { ok: true, value: { enabled: v.enabled, afterStart: v.afterStart, nightlyAt: v.nightlyAt, classes: [...v.classes], model: v.model } };
}

// "-latest" aliases first, then higher version numbers (the same order temporal-workers uses).
function versionKey(id) { return (String(id).match(/\d+(\.\d+)?/g) || []).map(Number).concat([0, 0, 0]).slice(0, 3); }
function newestFirst(a, b) {
  const la = /-latest$/i.test(a), lb = /-latest$/i.test(b);
  if (la !== lb) return la ? -1 : 1;
  const ka = versionKey(a), kb = versionKey(b);
  for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
  return a.length - b.length;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Tue 3:45 AM" in a zone. */
function whenIn(zone, ms) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
    return `${p.weekday} ${p.hour}:${p.minute} ${p.dayPeriod}`;
  } catch { return new Date(ms).toISOString(); }
}

function createSelfCheck(deps = {}) {
  const d = {
    now: () => Date.now(), log: () => {}, settings: () => undefined,
    models: async () => [], leadModel: async () => null, sandboxAvailable: async () => ({ ok: false }),
    notify: async () => ({ sent: 0, failed: 0 }), halted: () => null, zone: () => 'UTC',
    bashWritePaths: () => [], random: (n) => crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n),
    ...deps,
  };
  const hubRoot = d.hubRoot, hubHome = d.hubHome;
  const store = createStore({ dir: d.dataDir, now: d.now, log: d.log });
  let running = null, runningId = null, ctrl = null;

  function settings() {
    let raw; try { raw = d.settings(); } catch { raw = undefined; }
    const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    // Unknown keys are dropped; one bad value must not reset the others.
    const known = {};
    for (const k of Object.keys(obj)) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) known[k] = obj[k];
      else warnOnce(`unknown setting "${k}" ignored`);
    }
    const v = validateSettings(known);
    if (v.ok) return v.value;
    const out = { ...DEFAULTS, classes: [...DEFAULTS.classes] };
    for (const k of Object.keys(known)) {
      const one = validateSettings({ [k]: known[k] });
      if (one.ok) out[k] = one.value[k];
      else warnOnce(`${one.error}; the default is used for ${k}`);
    }
    return out;
  }
  function warnOnce(msg) { if (warned.has(msg)) return; warned.add(msg); d.log(`[selfcheck] settings: ${msg}`); }
  const iso = (ms) => new Date(ms).toISOString();
  const zone = () => { try { return d.zone() || 'UTC'; } catch { return 'UTC'; } };

  function recordFor(c, model) {
    const base = { name: `selfcheck-${c}`, model, effort: 'low', owner: null, policy: { roots: [path.join(hubHome, 'selfcheck', c)], overrides: { send: 'deny', web: 'deny', admin: 'deny', destroy: 'deny', money: 'deny' } } };
    switch (c) {
      case 'lead': return { ...base, category: 'primary', lead: true, tools: 'client', sandbox: 'off' };
      case 'boxed': return { ...base, category: 'specialist', tools: 'hub', sandbox: 'container' };
      case 'shared': return { ...base, category: 'specialist', sharedWith: ['selfcheck:member'], tools: 'client', sandbox: 'off' };
      default: return { ...base, category: 'specialist', tools: 'client', sandbox: 'off' };
    }
  }

  // ── Model choice ──
  async function chooseModel(set) {
    if (set.model !== 'auto') return OWN_TOOLS.test(set.model) ? { model: null, note: NO_MODEL } : { model: set.model, note: '' };
    let models = []; try { models = (await d.models()) || []; } catch { models = []; }
    models = models.map(m => (m && typeof m === 'object' ? m.id : m)).filter(m => typeof m === 'string');
    for (const re of [/^claude-sdk\/.*haiku/i, /^claude-sdk\/.*sonnet/i]) {
      const hit = models.filter(m => re.test(m)).sort(newestFirst)[0];
      if (hit) return { model: hit, note: '' };
    }
    let lead = null; try { lead = await d.leadModel(); } catch { lead = null; }
    if (lead && !/^(codex-cli|codex|perplexity|claude-sdk)\//i.test(lead) && models.includes(lead)) return { model: lead, note: '' };
    return { model: null, note: NO_MODEL };
  }

  function readFileSafe(file) {
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.size > 65536) return null;
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { return fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
    } catch { return null; }
  }

  // ── One class ──
  async function checkClass(c, model, signal) {
    if (c === 'boxed') {
      let sb; try { sb = await d.sandboxAvailable(); } catch { sb = { ok: false }; }
      if (!sb || !sb.ok) return { status: 'skipped', note: (sb && sb.note) || "Docker isn't available here, so agents in a box weren't checked.", actions: {} };
    }
    const fx = makeFixtures({ hubRoot, hubHome, cls: c, random: d.random });
    if (!fx.ok) return { status: 'error', note: fx.note, actions: {} };
    if (!verifyIntact(fx)) return { status: 'error', note: 'The check files were changed by something else before the check ran, so it was stopped.', actions: {} };
    const refusePath = path.join(hubHome, 'call-recordings', `selfcheck-${d.random(12)}.txt`);
    const record = recordFor(c, model);
    const scripted = { install: bashFor(fx.folders.install, fx.fixtures.install.B), home: bashFor(fx.folders.home, fx.fixtures.home.B) };
    const events = [];
    const observe = (e) => { try { if (e && typeof e === 'object') events.push(e); } catch { /* observing never stops a turn */ } };
    const turn = (steps) => d.runTurn({ name: `selfcheck-${c}`, record, model, prompt: promptFor({ folders: fx.folders, fixtures: fx.fixtures, refusePath, steps }), observe, signal, timeoutMs: TURN_MS });
    const check = (reply) => verifyClass({ events, reply, fixtures: fx.fixtures, folders: fx.folders, refusePath, scriptedBash: scripted, readFile: readFileSafe, bashWritePaths: d.bashWritePaths, clientTools: record.tools === 'client' && /^claude-sdk\//.test(model) });

    // A halt, or our own stop(), is nobody's failure: the class is skipped and never counts toward the stuck streak.
    const stopped = (r) => {
      if (!r || !r.errorKind) return null;
      if (r.errorKind === 'halted') return { status: 'skipped', note: 'Your Maestro was halted during the check.', actions: {} };
      if (r.errorKind === 'unavailable' && signal && signal.aborted) return { status: 'skipped', note: 'The check was stopped.', actions: {} };
      return null;
    };
    const errText = (r) => String(r.error || r.errorKind);

    let err = null;
    const r1 = await turn();
    const s1 = stopped(r1); if (s1) return s1;
    if (r1 && r1.errorKind) err = errText(r1);
    let reply = String((r1 && r1.reply) || '');
    let v = check(reply);
    if (!err) {
      const missing = Object.entries(v.actions).filter(([, a]) => !a.tried).map(([k]) => stepOf(k)).filter(Boolean);
      if (missing.length) {
        // Only what the model skipped, once more; then everything seen in both turns counts.
        const r2 = await turn(missing);
        // A halt or stop during the retry: what the first turn already settled still counts; otherwise skipped.
        const s2 = stopped(r2);
        if (s2) { const settledBad = Object.values(v.actions).some(a => a.tried && !a.ok && !a.cutOff && !a.needsReply) || v.extra.length; if (!settledBad) return s2; err = s2.note.replace(/\.$/, ''); }
        else if (r2 && r2.errorKind) err = errText(r2);
        reply += `\n${String((r2 && r2.reply) || '')}`;
        v = check(reply);
      }
    }
    // What is already settled: a step that was tried and failed, a write outside the folders (a refuse that saw an allow is a tried failure).
    // A step never tried says nothing, so it is never a failure.
    // After a turn error, a step whose allowed call was the last thing the turn did may just have been cut off: not tried.
    // So may the picture step, when only the reply's missing digits failed it (the answer never came).
    const settled = (a) => a.tried && !(err && (a.cutOff || a.needsReply));
    const tried = Object.entries(v.actions).filter(([, a]) => settled(a));
    const untried = Object.entries(v.actions).filter(([, a]) => !settled(a)).map(([k]) => k);
    const bad = tried.filter(([, a]) => !a.ok).length;
    if (bad || v.extra.length) {
      const actions = {};
      for (const [k, a] of tried) actions[k] = { ok: a.ok, reason: a.reason };
      const out = { status: 'fail', note: '', actions };
      if (v.extra.length) { out.outside = v.extra.map(x => x.path); out.note = `A check agent wrote outside its check folders: ${out.outside.join(', ')}.`; }
      else if (bad) out.note = plural(bad, 'problem');
      if (err) out.note = `The turn stopped early (${err}), but these had already failed.${out.note ? ` ${out.note}` : ''}`;
      return out;
    }
    if (err) return { status: 'error', note: `Couldn't run: ${err}`, actions: {} };
    if (untried.length) {
      const words = untried.map(k => { const [a, f] = k.split('@'); return `${ACTION_WORDS[a] || a}${f ? ` ${FOLDER_WORDS[f] || f}` : ''}`; });
      return { status: 'error', note: `The agent didn't do every step (${untried.length} not tried: ${words.join(', ')})`, actions: {} };
    }
    const actions = {};
    for (const [k, a] of tried) actions[k] = { ok: a.ok, reason: a.reason };
    return { status: 'pass', note: '', actions };
  }

  // ── Failures in words ──
  function failuresOf(lastRun) {
    const out = [];
    for (const [c, r] of Object.entries((lastRun && lastRun.classes) || {})) {
      if (r.status !== 'fail') continue;
      for (const [ak, a] of Object.entries(r.actions || {})) {
        if (a.ok) continue;
        const [action, folder] = ak.split('@');
        out.push({ key: `${c}/${ak}`, cls: c, action, folder: folder || null, reason: a.reason || '' });
      }
      if (r.outside && r.outside.length) out.push({ key: `${c}/outside`, cls: c, action: 'outside', folder: null, reason: r.note || '' });
    }
    return out;
  }
  const wordsOf = (f) => (f.action === 'outside' ? 'wrote outside their check folders' : `can't ${ACTION_WORDS[f.action] || f.action}${f.folder ? ` ${FOLDER_WORDS[f.folder]}` : ''}`);

  function nextFailing(prev, lastRun, startedAt) {
    const failing = failuresOf(lastRun);
    const since = {};
    for (const f of failing) since[f.key] = prev.failingSince[f.key] || iso(startedAt);
    // An old failure ends only when this run checked that same step and it passed. A class that could not run, a step it
    // didn't settle this time, and (until a complete clean run) a write outside the folders: they stay as they were.
    for (const [k, at] of Object.entries(prev.failingSince)) {
      if (since[k]) continue;
      const [c, ak] = k.split('/');
      const r = lastRun.classes[c];
      if (!r) continue;   // a kind no longer checked: dropped
      if (r.status === 'error' || r.status === 'skipped') { since[k] = at; continue; }
      if (ak === 'outside') { if (r.status !== 'pass') since[k] = at; continue; }
      const a = (r.actions || {})[ak];
      if (!a) since[k] = at;   // not settled this run (untried, cut off): still failing as far as anyone knows
    }
    return { failing, since };
  }

  async function notifyFresh(failing, since, prevNotified, lastRun) {
    const still = new Set(Object.keys(since));
    const kept = prevNotified.filter(k => still.has(k));
    const fresh = failing.filter(f => !kept.includes(f.key));
    if (!fresh.length) return kept;
    const z = zone();
    const title = fresh.length === 1
      ? `Self-check: ${LABELS[fresh[0].cls]} ${wordsOf(fresh[0])}`
      : `Self-check: ${fresh.length} problems with your agents`;
    const lines = fresh.slice(0, 3).map(f => `${cap(LABELS[f.cls])}: ${f.action === 'outside' ? 'a check agent wrote outside its check folders' : `${ACTION_WORDS[f.action]}${f.folder ? ` ${FOLDER_WORDS[f.folder]}` : ''}`}: ${f.reason} (since ${whenIn(z, Date.parse(since[f.key]))})`);
    let r;
    try { r = await d.notify({ title, body: [...lines, 'Open Settings → Status → Self-check.'].join('\n'), url: '/?selfcheck=1', tag: 'selfcheck' }); }
    catch (e) { r = { error: e && e.message }; }
    const delivered = !(r && (r.error || (r.sent === 0 && r.failed > 0)));
    // The log keeps what was said even when no phone is set up to hear it.
    d.log(`[selfcheck] notice "${title}" (${fresh.length} new): ${delivered ? `sent to ${(r && r.sent) || 0} device(s)` : `not delivered${r && r.error ? `: ${r.error}` : ''}`}`);
    return delivered ? [...kept, ...fresh.map(f => f.key)] : kept;
  }

  // ── A run ──
  function record(lastRun, prev, failing, since, notified, summary) {
    const history = [{ id: lastRun.id, at: lastRun.finishedAt, trigger: lastRun.trigger, summary }, ...prev.history].slice(0, HISTORY_MAX);
    store.set({ lastRun, failingSince: since, notified, history });
  }

  async function doRun(trigger, id) {
    const set = settings();
    const startedAt = d.now();
    const prev = store.get();
    const base = { id, trigger, startedAt: iso(startedAt), finishedAt: null, model: null, note: '', classes: {} };
    const halt = d.halted();
    if (halt) {
      const lastRun = { ...base, finishedAt: iso(d.now()), note: "Your Maestro was halted; the check didn't run." };
      // Only a line of history: the last real result, what is failing since when, and what was told all stay as they were.
      store.set({ history: [{ id, at: lastRun.finishedAt, trigger, summary: 'skipped (halted)' }, ...prev.history].slice(0, HISTORY_MAX) });
      return lastRun;
    }
    const pick = await chooseModel(set);
    const classes = {};
    ctrl = new AbortController();
    if (!pick.model) for (const c of set.classes) classes[c] = { status: 'skipped', note: pick.note, actions: {} };
    else for (const c of set.classes) {
      try { classes[c] = await checkClass(c, pick.model, ctrl.signal); }
      catch (e) { d.log(`[selfcheck] ${c} failed to run: ${e && e.message}`); classes[c] = { status: 'error', note: `Couldn't run: ${e && e.message}`, actions: {} }; }
    }
    const lastRun = { ...base, finishedAt: iso(d.now()), model: pick.model, note: pick.note, classes };
    const { failing, since } = nextFailing(prev, lastRun, startedAt);
    const fresh = failuresOf(lastRun);
    const notified = await notifyFresh(failing, since, prev.notified, lastRun);
    const stuck = await notifyStuck(nextStuck(prev.stuck, lastRun, startedAt, !pick.model));
    store.set({ stuck });
    const passed = Object.values(classes).some(c => c.status === 'pass');
    record(lastRun, prev, failing, since, notified, fresh.length || Object.values(classes).some(c => c.status === 'fail') ? plural(Math.max(1, fresh.length), 'problem') : passed ? 'all passed' : 'skipped');
    return lastRun;
  }

  // ── A check that keeps not running is a failure of its own ──
  // stuck: { <key>: { count, since, reason, told } }. A class whose turn couldn't run (status error) counts under its
  // own name, and a run with no model to test with counts under 'run'. A class that ran (pass or fail) starts again from
  // nothing. A halt is a person's choice and a missing Docker is a fact of the install: neither counts.
  const STUCK_AFTER = 3;
  function nextStuck(prevStuck, lastRun, startedAt, noModel) {
    const out = {};
    const bump = (key, reason) => {
      const p = (prevStuck && prevStuck[key]) || null;
      out[key] = { count: ((p && p.count) || 0) + 1, since: (p && p.since) || iso(startedAt), reason: String(reason || '').replace(/^Couldn't run: /, ''), told: !!(p && p.told) };
    };
    if (noModel) bump('run', lastRun.note || NO_MODEL);
    for (const [c, r] of Object.entries(lastRun.classes || {})) {
      if (r.status === 'error') bump(c, r.note);
      else if (r.status === 'skipped' && prevStuck && prevStuck[c]) out[c] = prevStuck[c];   // says nothing either way
    }
    return out;
  }
  async function notifyStuck(stuck) {
    const due = Object.entries(stuck).filter(([, s]) => s.count >= STUCK_AFTER && !s.told);
    if (!due.length) return stuck;
    const z = zone();
    const who = ([k]) => (k === 'run' ? 'The self-check' : `The check of ${LABELS[k] || k}`);
    const lines = due.slice(0, 3).map(([k, s]) => `${who([k])} hasn't been able to run since ${whenIn(z, Date.parse(s.since))} (${s.reason || 'no reason given'}).`);
    const title = due.length === 1 ? `Self-check: ${due[0][0] === 'run' ? 'it hasn\'t been able to run' : `${LABELS[due[0][0]] || due[0][0]} haven't been checked`}` : "Self-check: some checks haven't been able to run";
    let r;
    try { r = await d.notify({ title, body: [...lines, 'Open Settings → Status → Self-check.'].join('\n'), url: '/?selfcheck=1', tag: 'selfcheck' }); }
    catch (e) { r = { error: e && e.message }; }
    const delivered = !(r && (r.error || (r.sent === 0 && r.failed > 0)));
    d.log(`[selfcheck] notice "${title}" (${due.length} stuck): ${delivered ? `sent to ${(r && r.sent) || 0} device(s)` : `not delivered${r && r.error ? `: ${r.error}` : ''}`}`);
    if (!delivered) return stuck;
    const out = { ...stuck };
    for (const [k] of due) out[k] = { ...out[k], told: true };
    return out;
  }

  function run({ trigger = 'manual' } = {}) {
    if (running) return { running: true, id: runningId };
    if (!settings().enabled) {
      if (trigger === 'manual') throw Object.assign(new Error('The self-check is turned off.'), { code: 'disabled' });
      return null;
    }
    runningId = `sc-${d.random(8)}`;
    running = doRun(trigger, runningId).finally(() => { running = null; runningId = null; ctrl = null; });
    return running;
  }
  const isRunning = () => !!running;

  // ── What people see ──
  function stored() { return store.has() ? store.get() : null; }

  function readinessItems() {
    const s = store.get(), lr = s.lastRun;
    const standing = Object.entries(s.failingSince || {});
    if (!lr && !standing.length) return [];
    const cls = Object.entries((lr && lr.classes) || {});
    const fails = failuresOf(lr);
    // A key that is still standing (a halted run keeps them, or an earlier run had it) warns even when the last run shows no failure.
    // The reason is the last run's when it has one; otherwise just "since <time>".
    for (const [key, at] of standing) {
      if (fails.some(f => f.key === key)) continue;
      const [c, rest = ''] = key.split('/'), [action, folder] = rest.split('@');
      fails.push({ key, cls: c, action, folder: folder || null, reason: `since ${whenIn(zone(), Date.parse(at))}` });
    }
    const stamp = () => { try { return require('../timezone').stamp(Date.parse(lr.finishedAt), zone()); } catch { return lr && lr.finishedAt; } };
    if (fails.length) {
      const first = fails[0];
      return [{
        id: 'selfcheck', level: 'warn', title: `Self-check: ${LABELS[first.cls]} ${wordsOf(first)}`,
        detail: fails.slice(0, 3).map(f => `${cap(LABELS[f.cls])}: ${f.action === 'outside' ? 'wrote outside their check folders' : `${ACTION_WORDS[f.action]}${f.folder ? ` ${FOLDER_WORDS[f.folder]}` : ''}`}: ${f.reason}`).join('\n'),
        fix: 'Settings → Status → Self-check says what failed and since when.', action: { label: 'Open Self-check', href: '/?selfcheck=1' },
      }];
    }
    // Not able to run three times in a row: a warning like a failure (the push went out with it).
    const stuck = Object.entries(s.stuck || {}).filter(([, x]) => x && x.count >= STUCK_AFTER);
    if (stuck.length) {
      const words = ([k, x]) => `${k === 'run' ? 'The self-check' : `The check of ${LABELS[k] || k}`} hasn't been able to run since ${whenIn(zone(), Date.parse(x.since))} (${x.reason || 'no reason given'}).`;
      return [{ id: 'selfcheck', level: 'warn', title: `Self-check: ${stuck[0][0] === 'run' ? 'it hasn\'t been able to run' : `${LABELS[stuck[0][0]] || stuck[0][0]} haven't been checked`}`, detail: stuck.slice(0, 3).map(words).join('\n'), fix: 'Settings → Status → Self-check shows why.', action: { label: 'Open Self-check', href: '/?selfcheck=1' } }];
    }
    const passN = cls.filter(([, r]) => r.status === 'pass').length;
    const unrun = cls.filter(([, r]) => r.status === 'error' || r.status === 'skipped');
    if (!passN) {
      const note = String((unrun[0] && unrun[0][1].note) || lr.note || 'nothing was checked').replace(/^Couldn't run: /, '');
      return [{ id: 'selfcheck', level: 'info', title: `Self-check couldn't run: ${note}`, detail: `Last tried ${stamp()}.` }];
    }
    const more = unrun.map(([c, r]) => (r.status === 'skipped' ? `${cap(LABELS[c])} weren't checked: ${r.note}` : `${cap(LABELS[c])} couldn't be checked: ${r.note}`));
    return [{ id: 'selfcheck', level: 'ok', title: 'Self-check', detail: [`All ${passN} kinds of agent work (checked ${stamp()}).`, ...more].join(' ') }];
  }

  function view() {
    const s = store.get();
    return { settings: settings(), running: isRunning(), lastRun: s.lastRun, failingSince: s.failingSince, stuck: s.stuck || {}, history: s.history, readiness: readinessItems() };
  }

  const sched = createScheduler({
    now: () => d.now(), zone, settings, getStored: () => store.get(), setStored: (p) => store.set(p),
    isRunning, run: (a) => run(a), log: d.log,
  });

  return { run, isRunning, stored, view, readinessItems, settings, onStarted: sched.onStarted, schedule: sched.schedule, stop: () => { sched.stop(); if (ctrl) ctrl.abort(); }, _isDue: sched.isDue };
}

let shared = null;
function getSelfCheck() {
  if (shared) return shared;
  const L = (m) => require(m);
  const tp = L('../tool-policy');
  shared = createSelfCheck({
    hubRoot: tp.HUB_ROOT, hubHome: tp.HUB_HOME, dataDir: path.join(tp.HUB_ROOT, 'data'),
    log: (line) => console.log(line),
    settings: () => L('../settings').getSetting('selfCheck'),
    runTurn: (args) => L('../sdk-chat').runSelfCheckTurn(args),
    models: async () => L('../agents').getAvailableModels(),
    leadModel: async () => {
      const agents = L('../agents'), all = await agents.getAgents();
      const lead = agents.leadAgentNames(all)[0];
      const rec = all.find(a => a.name === lead);
      return (rec && rec.model) || null;
    },
    // available() also looks for the box image, so one call answers "can a box run here"
    sandboxAvailable: async () => {
      const sb = L('../sandbox').getSandbox();
      if (await sb.available()) return { ok: true };
      let note; try { const st = await sb.status(); note = st && st.error ? `${st.error}. Agents in a box weren't checked.` : undefined; } catch { /* the plain note stands */ }
      return { ok: false, note };
    },
    notify: (payload) => L('../push').getPush().notify(payload, { adminsOnly: true, kind: 'security' }),
    halted: () => L('../hub-halt').getHubHalt().refusal(),
    zone: () => { try { return L('../timezone').hubZone(); } catch { return 'UTC'; } },
    // tool-policy's pathsOf only lists writes that leave the agent's roots; the check needs every place a command could write
    bashWritePaths: shellWritePaths,
  });
  return shared;
}

module.exports = { createSelfCheck, getSelfCheck, DEFAULTS, validateSettings, CLASSES, LABELS };
