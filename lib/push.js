'use strict';
// Web push for the mobile PWA: tells a phone when an agent has replied or has a question.
// Everything hangs off hub-events (one source of truth).  A payload NEVER carries message
// content: push services see only "<Agent> replied" and a deep link; the phone fetches the text
// itself once the app opens.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_DIR = path.join(__dirname, '..', 'data', 'push');
const MIN_GAP_MS = 20000;          // at most one push per agent per 20 s (later ones coalesce into one trailing push)
const MAX_FAILURES = 3;            // consecutive 404/410 answers before a subscription is dropped
const SEEN_CAP = 500;
const DEFAULT_SUBJECT = 'mailto:agent-hub@example.com';   // sent to push services; deliberately not the owner's own address

function createPush({
  dir = DEFAULT_DIR,
  webpush = null,
  sender = null,                   // (subscription, payloadString, options) => Promise; injected by tests
  now = Date.now,
  displayName = null,              // (agent) => display name
  minGapMs = MIN_GAP_MS,
  subject = process.env.HUB_PUSH_SUBJECT || DEFAULT_SUBJECT,
  log = (...a) => console.log('[push]', ...a),
} = {}) {
  const vapidFile = path.join(dir, 'vapid.json');
  const subsFile = path.join(dir, 'subscriptions.json');
  let vapid = null;
  let subs = null;
  const seenTurns = new Set();
  const lanes = new Map();         // agent -> { last, timer, pending }

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
    else if (origin?.kind === 'schedule') title = `Scheduled task ran: ${agent}`;
    else title = `${nameOf(agent)} replied`;
    return { title, body: 'Tap to open', url: `/mobile#chat=${encodeURIComponent(agent)}`, tag: `agent-${agent}`, ts: now() };
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
  function notify(payload, { urgency = 'normal', adminsOnly = false } = {}) {
    const filter = (s) => !adminsOnly || !s.user || s.user.role === 'admin';
    if (!load().some(filter)) { log(`notice "${String(payload && payload.title || '').slice(0, 80)}": no device registered`); return Promise.resolve({ sent: 0, failed: 0, removed: 0 }); }
    return sendToAll({ ts: now(), ...payload }, urgency, filter)
      .then(r => { log(`notice "${String(payload && payload.title || '').slice(0, 80)}": sent ${r.sent}, failed ${r.failed}`); return r; })
      .catch(e => { log(`notice failed: ${e.message}`); return { sent: 0, failed: 0, removed: 0 }; });
  }

  // One lane per agent: first push goes at once, anything within the next minGapMs coalesces into a single trailing push (a question outranks a reply).
  function queue(agent, kind, origin) {
    if (!load().some(s => wants(s, agent))) return;
    const lane = lanes.get(agent) || { last: 0, timer: null, pending: null };
    lanes.set(agent, lane);
    const fire = (job) => {
      lane.last = now(); lane.pending = null;
      return sendToAll(payloadFor(job.kind, agent, job.origin), job.kind === 'ask' ? 'high' : 'normal', s => wants(s, agent))
        .then(r => log(`${job.kind} push for ${agent}: sent ${r.sent}, failed ${r.failed}${r.removed ? `, removed ${r.removed}` : ''}`))
        .catch(() => {});
    };
    const wait = lane.last + minGapMs - now();
    if (wait <= 0 && !lane.timer) { fire({ kind, origin }); return; }
    if (!lane.pending || kind === 'ask' || lane.pending.kind !== 'ask') lane.pending = { kind, origin };
    if (!lane.timer) {
      lane.timer = setTimeout(() => { lane.timer = null; if (lane.pending) fire(lane.pending); }, Math.max(wait, 0));
      lane.timer.unref?.();
    }
  }

  function onEvent(ev) {
    if (ev && ev.type === 'agent_request') {
      sendToAll({ title: `${nameOf(ev.byAgent)} asks for a new ${ev.kind}`, body: `${String(ev.description || '').slice(0, 120)} · open Users to approve`, url: '/users', tag: `agent-request-${ev.id}`, ts: now() }, 'normal').catch(() => {});
      return;
    }
    if (ev && ev.type === 'approval_request') {
      const what = { send: 'wants to send something', write_outside: 'wants to write outside its folders', admin: 'wants to change hub data', destroy: 'wants to run a destructive command', money: 'wants to move money' }[ev.cls] || `needs approval (${ev.cls})`;
      sendToAll({ title: `${nameOf(ev.agent)} ${what}`, body: `${String(ev.summary || '').slice(0, 120)} · tap to approve or deny`, url: '/mobile', tag: `approval-${ev.id}`, ts: now() }, 'high').catch(() => {});
      return;
    }
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
    if (ev.type === 'ask_user') return queue(ev.agent, 'ask', null);
    if (ev.type !== 'turn_end') return;
    if (ev.error === 'stopped') return;
    if (seenTurns.has(ev.turnId)) return;
    seenTurns.add(ev.turnId);
    if (seenTurns.size > SEEN_CAP) seenTurns.delete(seenTurns.values().next().value);
    queue(ev.agent, 'reply', ev.origin);
  }

  async function test() {
    const r = await sendToAll({ title: 'My Maestro AI test', body: 'Push notifications are working', url: '/mobile', tag: 'hub-test', ts: now(), force: true }, 'normal');
    log(`test push: sent ${r.sent}, failed ${r.failed}, removed ${r.removed} (${count()} on file)`);
    return r;
  }

  function start(events) {
    return events.onPublish(onEvent);
  }

  return { getVapid, publicKey: () => getVapid().publicKey, subscribe, unsubscribe, has, count, onEvent, test, start, subscriptions: () => load().slice(), payloadFor, notify };
}

let singleton = null;
function getPush() {
  if (!singleton) {
    singleton = createPush({
      displayName: (agent) => { try { return require('./agents').getAgentsSync().find(a => a.name === agent)?.display || agent; } catch { return agent; } },
    });
  }
  return singleton;
}

module.exports = { createPush, getPush, MIN_GAP_MS, MAX_FAILURES };
