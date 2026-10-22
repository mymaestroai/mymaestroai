'use strict';
// Web push for the mobile PWA. A phone is told only what its owner asked for or what waits on them:
//  - a reply is done, for the turns someone tapped "Notify me when done" on (the 🔔 next to Stop while it runs);
//  - a question (ask_user) or an approval still unanswered after a few minutes (settings.notify.questionAfterMinutes);
//  - rare hub notices: an agent asks for a new agent, provider pacing, the hub halted, Claude plan limits.
// Finished replies notify no one otherwise (they used to notify every device on every turn, consults included).
// Everything hangs off hub-events (one source of truth).  A payload NEVER carries message
// content: push services see only "<Agent> is done" and a deep link; the phone fetches the text
// itself once the app opens.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_DIR = path.join(__dirname, '..', 'data', 'push');
const MIN_GAP_MS = 20000;          // (kept for callers; replies no longer push on their own, so nothing coalesces)
const QUESTION_DELAY_MS = 3 * 60 * 1000;   // a question or approval notifies once it has waited this long unanswered
const MAX_FAILURES = 3;            // consecutive 404/410 answers before a subscription is dropped
const SEEN_CAP = 500;
const DEFAULT_SUBJECT = 'mailto:agent-hub@example.com';   // sent to push services; deliberately not the owner's own address

function createPush({
  dir = DEFAULT_DIR,
  webpush = null,
  sender = null,                   // (subscription, payloadString, options) => Promise; injected by tests
  now = Date.now,
  displayName = null,              // (agent) => display name
  minGapMs = MIN_GAP_MS,           // unused since replies push only on request; accepted for older callers
  questionDelayMs = () => QUESTION_DELAY_MS,   // ms a question/approval waits before a push; null = never
  ownerOf = () => null,            // (agent) => member user id that owns it, or null (the household's agents)
  subject = process.env.HUB_PUSH_SUBJECT || DEFAULT_SUBJECT,
  log = (...a) => console.log('[push]', ...a),
} = {}) {
  const vapidFile = path.join(dir, 'vapid.json');
  const subsFile = path.join(dir, 'subscriptions.json');
  let vapid = null;
  let subs = null;
  const seenTurns = new Set();
  const waiting = new Map();       // 'q:<request id>' | 'a:<approval id>' -> { timer, agent }

  const wp = () => webpush || (webpush = require('web-push'));
  const sendFn = sender || ((sub, body, opts) => wp().sendNotification(sub, body, opts));

  function writePrivate(file, data) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  }

  function getVapid() {
    if (vapid) return vapid;
    try {
      const v = JSON.parse(fs.readFileSync(vapidFile, 'utf8'));
      if (v.publicKey && v.privateKey) { fs.chmodSync(vapidFile, 0o600); return (vapid = v); }
    } catch {}
    const keys = wp().generateVAPIDKeys();
    vapid = { publicKey: keys.publicKey, privateKey: keys.privateKey, createdAt: new Date(now()).toISOString() };
    writePrivate(vapidFile, vapid);
    return vapid;
  }

  function load() {
    if (subs) return subs;
    try { const a = JSON.parse(fs.readFileSync(subsFile, 'utf8')); subs = Array.isArray(a) ? a : []; }
    catch { subs = []; }
    return subs;
  }
  const save = () => writePrivate(subsFile, load());

  const cleanAgents = (a) => (Array.isArray(a) ? [...new Set(a.map(String).filter(Boolean))] : null);

  // user: { id, role } of the account that registered the device (recorded since plan warnings go to admins only).
  function subscribe(subscription, agents = null, user = null) {
    const endpoint = subscription?.endpoint;
    const keys = subscription?.keys;
    if (typeof endpoint !== 'string' || !/^https:\/\//i.test(endpoint) || endpoint.length > 2048) return { ok: false, error: 'invalid subscription endpoint' };
    if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return { ok: false, error: 'invalid subscription keys' };
    const list = load();
    const stamp = new Date(now()).toISOString();
    let rec = list.find(s => s.endpoint === endpoint);
    if (rec) {
      rec.keys = { p256dh: keys.p256dh, auth: keys.auth };
      rec.agents = cleanAgents(agents);
      if (user && user.id) rec.user = { id: String(user.id), role: String(user.role || '') };
      rec.lastSeen = stamp;
      rec.failures = 0;
      log(`subscription renewed (${hostOf(endpoint)}); ${list.length} on file`);
    } else {
      rec = { id: crypto.randomUUID(), endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, agents: cleanAgents(agents), ...(user && user.id ? { user: { id: String(user.id), role: String(user.role || '') } } : {}), createdAt: stamp, lastSeen: stamp, failures: 0 };
      list.push(rec);
      log(`new subscription (${hostOf(endpoint)}); ${list.length} on file`);
    }
    save();
    return { ok: true, id: rec.id };
  }

  function unsubscribe(endpoint) {
    const list = load();
    const i = list.findIndex(s => s.endpoint === endpoint);
    if (i >= 0) { list.splice(i, 1); save(); log(`subscription removed (${hostOf(endpoint)}); ${list.length} on file`); }
    return { ok: true };
  }

  // The phone asks whether the hub still knows its browser subscription (the two can drift: the browser keeps its
  // subscription while the hub's file is lost or the registration call failed) and re-registers when not.
  const has = (endpoint) => load().some(s => s.endpoint === endpoint);
  const count = () => load().length;
  function hostOf(endpoint) { try { return new URL(endpoint).host; } catch { return '?'; } }

  function nameOf(agent) {
    try { return (displayName && displayName(agent)) || agent; } catch { return agent; }
  }

  function payloadFor(kind, agent, origin) {
    let title;
    if (kind === 'ask') title = `${nameOf(agent)} has a question`;
    else if (kind === 'done') title = `${nameOf(agent)} is done`;
    else if (kind === 'failed') title = `${nameOf(agent)} stopped with an error`;
    else if (origin?.kind === 'schedule') title = `Scheduled task ran: ${agent}`;
    else title = `${nameOf(agent)} replied`;
    return { title, body: 'Tap to open', url: `/mobile#chat=${encodeURIComponent(agent)}`, tag: `agent-${agent}`, ts: now() };
  }

  // Whose devices may hear about an agent: a member's own agents notify that member's devices only; the household's
  // agents (no member owner) notify admins' devices and devices registered before accounts were recorded.
  function deviceSees(sub, agent) {
    let owner = null;
    try { owner = ownerOf(agent) || null; } catch { owner = null; }
    if (owner) return !!(sub.user && sub.user.id === String(owner));
    return !sub.user || sub.user.role === 'admin';
  }

  async function deliver(sub, payload, urgency) {
    const v = getVapid();
    try {
      await sendFn({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), {
        TTL: 300, urgency, vapidDetails: { subject, publicKey: v.publicKey, privateKey: v.privateKey },
      });
      sub.failures = 0; sub.lastSeen = new Date(now()).toISOString();
      return { ok: true };
    } catch (e) {
      const code = e?.statusCode;
      if (code === 404 || code === 410) sub.failures = (sub.failures || 0) + 1;
      log(`delivery failed (${hostOf(sub.endpoint)}): ${code || 'no status'} ${String(e?.body || e?.message || e).slice(0, 160)}`);
      return { ok: false, status: code || null, error: e?.message || String(e) };
    }
  }

  async function sendToAll(payload, urgency, filter = () => true) {
    const targets = load().filter(filter);
    const results = await Promise.all(targets.map(s => deliver(s, payload, urgency)));
    const before = load().length;
    subs = load().filter(s => (s.failures || 0) < MAX_FAILURES);
    if (targets.length) save();
    return { sent: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, removed: before - subs.length };
  }

  function wants(sub, agent) { return sub.agents == null || sub.agents.includes(agent); }

  /** A hub notice that is not an agent's turn (plan warnings): every device, or only admins' (and devices registered
   * before the account was recorded). No coalescing: callers announce once. */
  /** notify(), answered per device: { results: [{ id, ok }], sent, failed }. id is a short hash of the device's
   *  endpoint (safe to keep); skip(id) leaves out devices that already have this notice. The update check uses it to
   *  reach every admin device once per version: a device that failed, or one registered later, gets the next try. */
  async function notifyEach(payload, { urgency = 'normal', adminsOnly = false, skip = () => false } = {}) {
    const idOf = (s) => crypto.createHash('sha256').update(String(s.endpoint || '')).digest('hex').slice(0, 16);
    const targets = load().filter(s => (!adminsOnly || !s.user || s.user.role === 'admin') && !skip(idOf(s)));
    const title = String(payload && payload.title || '').slice(0, 80);
    if (!targets.length) return { results: [], sent: 0, failed: 0 };
    const results = await Promise.all(targets.map(async s => ({ id: idOf(s), ok: !!(await deliver(s, { ts: now(), ...payload }, urgency)).ok })));
    subs = load().filter(s => (s.failures || 0) < MAX_FAILURES);
    save();
    const sent = results.filter(r => r.ok).length;
    log(`notice "${title}": sent ${sent}, failed ${results.length - sent}`);
    return { results, sent, failed: results.length - sent };
  }

  function notify(payload, { urgency = 'normal', adminsOnly = false } = {}) {
    const filter = (s) => !adminsOnly || !s.user || s.user.role === 'admin';
    if (!load().some(filter)) { log(`notice "${String(payload && payload.title || '').slice(0, 80)}": no device registered`); return Promise.resolve({ sent: 0, failed: 0, removed: 0 }); }
    return sendToAll({ ts: now(), ...payload }, urgency, filter)
      .then(r => { log(`notice "${String(payload && payload.title || '').slice(0, 80)}": sent ${r.sent}, failed ${r.failed}`); return r; })
      .catch(e => { log(`notice failed: ${e.message}`); return { sent: 0, failed: 0, removed: 0 }; });
  }

  // "Notify me when done": a finished turn notifies only the people who tapped the 🔔 on it, on their own devices
  // (devices registered before accounts were recorded count as an admin's; '*' = a hub without accounts).
  function donePush(ev) {
    const who = Array.isArray(ev.notify) ? ev.notify.filter(n => n && n.id) : [];
    if (!who.length) return null;
    const ids = new Set(who.map(n => String(n.id)));
    const anyAdmin = who.some(n => n.role === 'admin' || n.id === '*');
    const filter = (sub) => ids.has('*') || (sub.user ? ids.has(sub.user.id) : anyAdmin);
    if (!load().some(filter)) { log(`done push for ${ev.agent}: no device registered for whoever asked`); return null; }
    const payload = { ...payloadFor(ev.ok === false ? 'failed' : 'done', ev.agent), body: 'Tap to open the reply', tag: `done-${ev.agent}` };
    return sendToAll(payload, 'high', filter)
      .then(r => log(`done push for ${ev.agent}: sent ${r.sent}, failed ${r.failed}${r.removed ? `, removed ${r.removed}` : ''}`))
      .catch(() => {});
  }

  // A question (ask_user) or an approval waits for an answer: push only once it is still open after the delay
  // (settings.notify.questionAfterMinutes, default 3; empty = never). Answered, skipped or timed out sooner: nothing.
  function remind(key, agent, payload, label) {
    if (waiting.has(key)) return;
    let delay;
    try { delay = questionDelayMs(); } catch { delay = QUESTION_DELAY_MS; }
    if (delay === null || delay === undefined || !(delay >= 0)) return;
    const filter = (sub) => wants(sub, agent) && deviceSees(sub, agent);
    const mins = Math.round(delay / 60000);
    const fire = () => {
      if (!waiting.has(key)) return;
      waiting.delete(key);
      if (!load().some(filter)) { log(`${label} reminder for ${agent}: no device registered`); return; }
      const body = payload.body !== undefined ? payload.body : (mins >= 1 ? `Waiting for your answer for ${mins} min. Tap to answer` : 'Tap to answer');
      sendToAll({ ...payload, body, ts: now() }, 'high', filter)
        .then(r => log(`${label} reminder for ${agent}: sent ${r.sent}, failed ${r.failed}${r.removed ? `, removed ${r.removed}` : ''}`))
        .catch(() => {});
    };
    const timer = setTimeout(fire, delay);
    timer.unref?.();
    waiting.set(key, { timer, agent });
  }
  function settle(key) { const w = waiting.get(key); if (w) { clearTimeout(w.timer); waiting.delete(key); } }
  // A turn that ended took its questions with it (ask_user_done normally settles them first).
  function settleQuestions(agent) { for (const [key, w] of [...waiting]) if (key.startsWith('q:') && w.agent === agent) settle(key); }

  function onEvent(ev) {
    if (ev && ev.type === 'agent_request') {
      sendToAll({ title: `${nameOf(ev.byAgent)} asks for a new ${ev.kind}`, body: `${String(ev.description || '').slice(0, 120)} · open Users to approve`, url: '/users', tag: `agent-request-${ev.id}`, ts: now() }, 'normal').catch(() => {});
      return;
    }
    if (ev && ev.type === 'approval_request') {
      const what = { send: 'wants to send something', write_outside: 'wants to write outside its folders', admin: 'wants to change hub data', destroy: 'wants to run a destructive command', money: 'wants to move money' }[ev.cls] || `needs approval (${ev.cls})`;
      remind(`a:${ev.id}`, ev.agent, { title: `${nameOf(ev.agent)} ${what}`, body: `${String(ev.summary || '').slice(0, 120)} · tap to approve or deny`, url: '/mobile', tag: `approval-${ev.id}` }, 'approval');
      return;
    }
    if (ev && ev.type === 'approval_resolved') { settle(`a:${ev.id}`); return; }
    if (ev && ev.type === 'provider_paced') {
      const who = { 'claude-sdk': 'Claude', anthropic: 'Claude API', openai: 'OpenAI', google: 'Gemini', 'codex-cli': 'Codex', codex: 'Codex', lmstudio: 'LM Studio' }[ev.provider] || ev.provider;
      const why = { rate_limit: 'rate limit', overloaded: 'provider overloaded', timeout: 'network timeouts' }[ev.reason] || ev.reason;
      sendToAll({ title: `My Maestro AI pacing: ${who}`, body: `${why}: ${who} agents now run one at a time and ramp back up as calls succeed. Tap to open`, url: '/mobile', tag: `pacing-${ev.provider}`, ts: now() }, 'high').catch(() => {});
      return;
    }
    if (ev && ev.type === 'hub_halted') {
      sendToAll({ title: 'My Maestro AI halted', body: 'All agents were stopped. Tap to open', url: '/mobile', tag: 'hub-halt', ts: now() }, 'high').catch(() => {});
      return;
    }
    if (!ev || !ev.agent) return;
    if (ev.type === 'ask_user') {
      const { ts: _ts, ...ask } = payloadFor('ask', ev.agent, null);
      remind(`q:${ev.request_id || ev.agent}`, ev.agent, { ...ask, body: undefined, tag: `question-${ev.agent}` }, 'question');
      return;
    }
    if (ev.type === 'ask_user_done') { settle(`q:${ev.request_id || ev.agent}`); return; }
    if (ev.type !== 'turn_end') return;
    settleQuestions(ev.agent);
    if (ev.error === 'stopped') return;
    if (seenTurns.has(ev.turnId)) return;
    seenTurns.add(ev.turnId);
    if (seenTurns.size > SEEN_CAP) seenTurns.delete(seenTurns.values().next().value);
    donePush(ev);
  }

  async function test() {
    const r = await sendToAll({ title: 'My Maestro AI test', body: 'Push notifications are working', url: '/mobile', tag: 'hub-test', ts: now(), force: true }, 'normal');
    log(`test push: sent ${r.sent}, failed ${r.failed}, removed ${r.removed} (${count()} on file)`);
    return r;
  }

  function start(events) {
    return events.onPublish(onEvent);
  }

  // Devices that a "Notify me when done" from this person reaches (the bell warns when there are none).
  function devicesFor(user) {
    if (!user || !user.id) return 0;
    if (user.id === '*') return load().length;
    return load().filter(sub => (sub.user ? sub.user.id === String(user.id) : user.role === 'admin')).length;
  }

  return { getVapid, publicKey: () => getVapid().publicKey, subscribe, unsubscribe, has, count, onEvent, test, start, subscriptions: () => load().slice(), payloadFor, notify, notifyEach, devicesFor, waitingCount: () => waiting.size };
}

let singleton = null;
function getPush() {
  if (!singleton) {
    singleton = createPush({
      displayName: (agent) => { try { return require('./agents').getAgentsSync().find(a => a.name === agent)?.display || agent; } catch { return agent; } },
      ownerOf: (agent) => { try { return require('./agents').getAgentsSync().find(a => a.name === agent)?.owner || null; } catch { return null; } },
      questionDelayMs: () => questionDelayFrom(require('./settings').get()),
    });
  }
  return singleton;
}

/** settings.notify.questionAfterMinutes -> ms (unset: 3 min; null, false or '' = never; 0 = at once). */
function questionDelayFrom(settings) {
  const n = settings && settings.notify ? settings.notify.questionAfterMinutes : undefined;
  if (n === null || n === false || n === '') return null;
  const v = Number(n);
  return Number.isFinite(v) && v >= 0 ? Math.round(v * 60000) : QUESTION_DELAY_MS;
}
/** The settings box writes { questionAfterMinutes }: a number 0..120 (minutes) or null (never). */
function cleanNotifySettings(v) {
  const n = v && typeof v === 'object' ? v.questionAfterMinutes : undefined;
  if (n === null || n === false || n === '' || n === 'off') return { questionAfterMinutes: null };
  const x = Number(n);
  return { questionAfterMinutes: Number.isFinite(x) ? Math.min(120, Math.max(0, Math.round(x * 100) / 100)) : 3 };
}

module.exports = { createPush, getPush, questionDelayFrom, cleanNotifySettings, MIN_GAP_MS, MAX_FAILURES, QUESTION_DELAY_MS };
