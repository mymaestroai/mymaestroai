'use strict';
// Hub event stream: every agent turn (the owner's own, consultations, job notices,
// job reports, scheduled tasks) is invisible to a browser window that did not
// start it.  This module broadcasts the turns as Server-Sent Events so open
// windows and phones can show them live, plus ask_user questions and a status
// snapshot.  Events are kept in a small ring buffer and replayed after a reconnect
// (Last-Event-ID), so a short network blip loses nothing.

const RING = 300;
const DELTA_MS = 300;
const TEXT_CAP = 64000;
const MSG_CAP = 12000;
// Turn activity (what the agent is doing, not just what it says): tool calls and workers of the running
// turn are kept per agent so a page that opens or wakes mid-turn can catch up (turnFor), and published as
// compact `turn_activity` events so an open page follows live. Caps keep one busy turn small.
const ACTIVITY_CAP = 400;        // activity items kept per turn (oldest dropped, counted in `dropped`)
const SUMMARY_CAP = 240;         // chars of a tool input summary
const OUTPUT_CAP = 300;          // chars of a tool result kept
const WORKER_TEXT_CAP = 8000;    // chars of a worker's reply kept per worker
const WORKER_TOOLS_CAP = 60;     // tool lines kept per worker
const WORKER_DELTA_MS = 1000;    // worker text is broadcast at most this often
const KEEP_FINISHED_MS = 60000;  // a finished turn stays answerable for this long (race with turn_end)
const PING_MS = 15000;           // `ping` event cadence on /api/events (pages call the stream dead after 3 missed)
// What the own stream shows besides text and tool calls (the "Running Bash · 12s" bar, the token counter, the context
// reading) goes to pages that follow the turn as `turn_progress`, at most this often. Not kept for replay: stale.
const PROGRESS_MS = 2000;

/** One line for a tool input: the first string-ish field, or compact JSON. */
function summarizeInput(input, cap = SUMMARY_CAP) {
  if (input == null) return '';
  let s;
  if (typeof input === 'string') s = input;
  else if (typeof input === 'object') {
    const pick = ['command', 'file_path', 'notebook_path', 'path', 'url', 'query', 'pattern', 'agent', 'label', 'name', 'section', 'topic', 'prompt', 'description'];
    const k = pick.find(key => typeof input[key] === 'string' && input[key].trim());
    s = k ? (k === 'command' || k === 'query' || k === 'pattern' ? input[k] : `${k === 'agent' ? 'agent ' : ''}${input[k]}`) : JSON.stringify(input);
  } else s = String(input);
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > cap ? s.slice(0, cap) + '…' : s;
}

/** Short human label for what an agent is doing, from the origin of its turn. */
function activityOf(origin) {
  switch (origin?.kind) {
    case 'user': return 'replying to you';
    case 'consultation': return `consulted by ${origin.from || 'another agent'}`;
    case 'schedule': { const l = origin.label || origin.from; return l ? `scheduled task: ${l}` : 'scheduled task'; }
    case 'job_report': return 'job report';
    case 'job_notice': return 'job finished';
    case 'alert': return 'alert';
    default: return 'working';
  }
}

/** The origin as published: always {kind, from?, label?} plus whatever extra ids the caller supplied. */
function normalizeOrigin(origin) {
  const o = (origin && typeof origin === 'object' && origin.kind) ? { ...origin } : { kind: 'user' };
  if (o.kind === 'schedule' && !o.label && o.from) o.label = o.from;
  return o;
}

// Identifies this server process; pages compare it across reconnects and reload after a hub restart, so the
// browser never keeps running page code from before an update.
const BOOT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function createHubEvents({ now = Date.now, bootId = BOOT_ID, progressMs = PROGRESS_MS } = {}) {
  const clients = new Map();   // res -> { filter(ev) -> bool, snapshot(agents) -> agents, approvals: bool }
  const ring = [];
  const turns = new Map();     // agent -> state of its running (or just-finished) turn, see tapTurn / turnFor
  const listeners = new Set();
  let nextId = 1;
  let statusProvider = null;
  let haltProvider = null;
  let pacingProvider = null;
  let approvalsProvider = null;

  const clip = (v, max) => { const s = String(v ?? ''); return s.length > max ? s.slice(0, max) + '\n…[truncated]' : s; };
  // A turn's latest progress, token counter and context reading, in the own stream's shapes (phase_ms/total_ms
  // counted now, so a page's clock does not matter).
  const liveOf = (s) => {
    const p = s.progress;
    return {
      progress: p ? { phase: p.phase, detail: p.detail, turn: p.turn, phase_ms: Math.max(0, now() - p.phaseAt), total_ms: Math.max(0, now() - p.startAt) } : null,
      usage: s.usage ? { ...s.usage } : null,
      context: s.context ? { ...s.context } : null,
    };
  };

  // The wire id (SSE `id:` line, Last-Event-ID replay, recent()) is the sequence number `seq`. The
  // payload's `id` is the caller's own id when it has one (approval ids, agent-request ids), else seq:
  // spreading caller data over the event used to overwrite the sequence, so those events never replayed.
  function frame(ev) { return `id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`; }

  // keep: false = a point-in-time reading (turn_progress) that a page reconnecting later must not replay.
  function publish(type, data, { keep = true } = {}) {
    const seq = nextId++;
    const ev = { ...(data || {}), seq, id: (data && data.id != null) ? data.id : seq, ts: new Date(now()).toISOString(), type };
    if (keep) {
      ring.push(ev);
      if (ring.length > RING) ring.splice(0, ring.length - RING);
    }
    const text = frame(ev);
    for (const [res, opts] of clients) {
      try {
        // A signed-in member gets only events about agents they may see; hub-wide events (approvals,
        // pacing, halt) go to admins and to the hub's own subscribers.
        if (opts) {
          if (ev.agent) { if (opts.filter && !opts.filter(ev)) continue; }
          else if (!opts.isAdmin) continue;
        }
        if (res.writableLength > 2 * 1024 * 1024) { res.destroy(); clients.delete(res); continue; }
        res.write(text);
      } catch { clients.delete(res); }
    }
    for (const fn of listeners) { try { fn(ev); } catch {} }
    return ev;
  }

  /** Observe every published event (web push hangs off this). Returns an unsubscribe function. */
  function onPublish(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  /** fn() -> { <agent>: {busy, busySince, activity, pendingQuestion} }, sent to every new connection. */
  function setStatusProvider(fn) { statusProvider = fn; }
  function statusSnapshot() { try { return statusProvider ? statusProvider() : {}; } catch { return {}; } }
  /** fn() -> {halted, at, reason}: the hub-wide kill switch state, included in every status_snapshot. */
  function setHaltProvider(fn) { haltProvider = fn; }
  function haltState() { try { return (haltProvider && haltProvider()) || { halted: false }; } catch { return { halted: false }; } }
  /** fn() -> { providers, paced }: provider pacing (serial / ramping after failures), included in every status_snapshot. */
  function setPacingProvider(fn) { pacingProvider = fn; }
  /** fn() -> [pending approval cards], included in every status_snapshot so a fresh page shows them. */
  function setApprovalsProvider(fn) { approvalsProvider = fn; }
  function approvalsState() { try { return (approvalsProvider && approvalsProvider()) || []; } catch { return []; } }
  function pacingState() { try { return (pacingProvider && pacingProvider()) || { providers: {}, paced: [] }; } catch { return { providers: {}, paced: [] }; } }

  /** opts: { filter(ev) -> bool, visibleAgent(name) -> bool, isAdmin } for a signed-in user; omit for the hub itself. */
  function subscribe(req, res, opts = null) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    clients.set(res, opts ? { ...opts, adminOnly: false } : null);
    // A real `ping` event, not an SSE comment: comments never reach page script, so a page could not tell a
    // quiet connection from one that died while the laptop lid was shut (the browser keeps reporting OPEN).
    // Pages treat 45 s without any event as dead, reconnect and catch up. Pings are not kept in the ring.
    const heartbeat = setInterval(() => { try { if (!res.write(`event: ping\ndata: ${JSON.stringify({ type: 'ping', ts: new Date(now()).toISOString() })}\n\n`)) res.destroy(); } catch { res.destroy(); } }, PING_MS);
    heartbeat.unref();
    res.on('close', () => { clearInterval(heartbeat); clients.delete(res); });
    // Replay what a reconnecting client missed. The browser sends Last-Event-ID only on its own automatic
    // reconnect; a page that deliberately opens a new connection (after sleep, or a re-sync) passes the last
    // sequence it saw as ?since=<seq> and gets the same replay. A fresh client gets only a hello.
    let since = 0;
    try { since = Number(new URL(req.url || '/', 'http://x').searchParams.get('since') || 0); } catch {}
    const last = Number(req.headers['last-event-id'] || 0) || (since > 0 ? since : 0);
    if (last > 0) for (const ev of ring) if (ev.seq > last && (!opts || !opts.filter || !ev.agent || opts.filter(ev))) res.write(frame(ev));
    res.write(`event: hello\ndata: ${JSON.stringify({ lastId: nextId - 1, replayed: last > 0, boot: bootId })}\n\n`);
    // Current busy/idle picture, so a fresh page needs no extra request (not stored in the ring: it is a point-in-time view).
    let agentsSnap = statusSnapshot();
    if (opts && opts.visibleAgent) agentsSnap = Object.fromEntries(Object.entries(agentsSnap).filter(([name]) => opts.visibleAgent(name)));
    const approvalsSnap = (opts && !opts.isAdmin) ? [] : approvalsState();
    res.write(`event: status_snapshot\ndata: ${JSON.stringify({ type: 'status_snapshot', ts: new Date(now()).toISOString(), halted: !!haltState().halted, haltedAt: haltState().at || null, haltReason: haltState().reason || null, pacing: { paced: pacingState().paced || [] }, approvals: approvalsSnap, agents: agentsSnap })}\n\n`);
  }

  /**
   * Observe one turn on a response object: wraps res.write so the assistant text is
   * accumulated and broadcast (throttled) while the agent writes; call finish() when
   * the turn is over.  Works after the browser has gone: sendSSE hands chunks it can no
   * longer write to res.observeClosed, so a detached turn keeps feeding the stream.
   * origin: { kind: 'user'|'consultation'|'job_notice'|'job_report'|'schedule'|'task'|'consult_reply'|'alert', from?, label?, jobId? }
   */
  function tapTurn(res, { agent, origin, message, turnId: givenId = null, startedAt = null }) {
    origin = normalizeOrigin(origin);
    const turnId = givenId || `${agent}-${nextId}-${now().toString(36)}`;
    const started = startedAt || new Date(now()).toISOString();
    let text = '';
    let timer = null;
    let finished = false;
    // What the agent is doing, for catch-up and the live activity feed.
    // notify: who tapped "Notify me when done" (the 🔔 next to Stop) on this turn: user id -> { id, role, at }.
    const state = { turnId, agent, origin, startedAt: started, message: clip(message, MSG_CAP), activity: [], dropped: 0, workers: new Map(), nextItem: 1, liveText: () => text, notify: new Map() };
    turns.set(agent, state);
    publish('turn_start', { turnId, agent, origin, startedAt: started, activity: activityOf(origin), message: clip(message, MSG_CAP) });

    const flush = () => { timer = null; if (!finished) publish('turn_delta', { turnId, agent, text: clip(text, TEXT_CAP) }); };
    const ingest = (c) => {
      if (typeof c !== 'string' || !c) return;
      text += c;
      if (!timer && !finished) { timer = setTimeout(flush, DELTA_MS); timer.unref?.(); }
    };

    // ── activity ──
    const ts = () => new Date(now()).toISOString();
    const addItem = (item) => {
      item.id = item.id || `a${state.nextItem++}`;
      item.ts = item.ts || ts();
      // Where in the reply it happened (length of the text so far): pages that catch up place the row between the
      // text before and after it, as the own stream shows it.
      if (item.at === undefined) item.at = text.length;
      state.activity.push(item);
      if (state.activity.length > ACTIVITY_CAP) { state.activity.splice(0, state.activity.length - ACTIVITY_CAP); state.dropped++; }
      return item;
    };
    const emitItem = (item) => { if (!finished) publish('turn_activity', { turnId, agent, item }); };
    const findTool = (callId) => callId ? state.activity.find(a => a.kind === 'tool' && a.callId === callId) : null;

    // ── progress: phase bar, token counter, context reading (latest of each; throttled) ──
    let progressTimer = null;
    const flushProgress = () => {
      progressTimer = null;
      if (!finished) publish('turn_progress', { turnId, agent, ...liveOf(state) }, { keep: false });
    };
    const noteProgress = () => {
      if (!progressTimer && !finished) { progressTimer = setTimeout(flushProgress, progressMs); progressTimer.unref?.(); }
    };
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const workerTimers = new Map();   // workerId -> throttle timer for worker text
    const flushWorker = (id) => {
      workerTimers.delete(id);
      const w = state.workers.get(id);
      if (w && !finished) publish('turn_worker_delta', { turnId, agent, workerId: id, text: clip(w.text, WORKER_TEXT_CAP) });
    };
    const observe = (ev) => {
      if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') return;
      switch (ev.type) {
        case 'tool_start': {
          if (findTool(ev.tool_call_id)) return;
          emitItem(addItem({ kind: 'tool', tool: String(ev.tool || 'tool'), callId: ev.tool_call_id || null, status: 'running', summary: '' }));
          return;
        }
        case 'tool_use': {
          const existing = findTool(ev.tool_call_id);
          const summary = summarizeInput(ev.input);
          if (existing) { existing.tool = String(ev.tool || existing.tool); if (summary) existing.summary = summary; emitItem(existing); return; }
          emitItem(addItem({ kind: 'tool', tool: String(ev.tool || 'tool'), callId: ev.tool_call_id || null, status: 'running', summary }));
          return;
        }
        case 'tool_result': {
          const out = typeof ev.output === 'string' ? ev.output : (ev.output == null ? '' : JSON.stringify(ev.output));
          const existing = findTool(ev.tool_call_id) || [...state.activity].reverse().find(a => a.kind === 'tool' && a.status === 'running');
          if (existing) { existing.status = 'done'; existing.output = clip(out, OUTPUT_CAP); existing.doneTs = ts(); emitItem(existing); return; }
          emitItem(addItem({ kind: 'tool', tool: String(ev.tool || 'tool'), callId: ev.tool_call_id || null, status: 'done', summary: '', output: clip(out, OUTPUT_CAP) }));
          return;
        }
        case 'worker_started': {
          const id = String(ev.worker_id || `w${state.nextItem}`);
          const w = { id, agent: ev.agent_type || null, description: String(ev.description || 'Worker'), model: ev.model || '', prompt: clip(ev.prompt || '', SUMMARY_CAP * 2), status: 'running', startedAt: ts(), text: '', tools: [], error: null, endedAt: null };
          state.workers.set(id, w);
          emitItem(addItem({ kind: 'worker', workerId: id, status: 'started', description: w.description, model: w.model, agent: w.agent }));
          return;
        }
        case 'worker_text_delta': {
          const id = String(ev.worker_id || ''); const w = state.workers.get(id);
          if (!w || typeof ev.text !== 'string') return;
          if (w.text.length < WORKER_TEXT_CAP) w.text += ev.text;
          if (!workerTimers.has(id) && !finished) { const t = setTimeout(() => flushWorker(id), WORKER_DELTA_MS); t.unref?.(); workerTimers.set(id, t); }
          return;
        }
        case 'worker_tool_start':
        case 'worker_tool_use': {
          const id = String(ev.worker_id || ''); const w = state.workers.get(id);
          if (!w) return;
          const tool = String(ev.tool || 'tool'); const summary = summarizeInput(ev.input);
          const last = w.tools[w.tools.length - 1];
          if (last && last.tool === tool && (!last.summary || !summary) && ev.type === 'worker_tool_use') { if (summary) last.summary = summary; emitItem({ ...last, kind: 'worker_tool', workerId: id }); return; }
          const line = { id: `${id}-t${w.tools.length + 1}`, tool, summary, ts: ts() };
          w.tools.push(line);
          if (w.tools.length > WORKER_TOOLS_CAP) w.tools.splice(0, w.tools.length - WORKER_TOOLS_CAP);
          emitItem({ ...line, kind: 'worker_tool', workerId: id });
          return;
        }
        case 'worker_completed':
        case 'worker_failed': {
          const id = String(ev.worker_id || ''); const w = state.workers.get(id);
          if (!w) return;
          w.status = ev.type === 'worker_completed' ? 'completed' : 'failed';
          w.error = ev.error ? clip(ev.error, 300) : null;
          w.endedAt = ts();
          if (workerTimers.has(id)) { clearTimeout(workerTimers.get(id)); flushWorker(id); }
          emitItem(addItem({ kind: 'worker', workerId: id, status: w.status, description: w.description, model: w.model, agent: w.agent, error: w.error }));
          return;
        }
        case 'progress': {
          const t = now();
          state.progress = { phase: String(ev.phase || 'model').slice(0, 40), detail: clip(ev.detail || '', 200), turn: num(ev.turn) || 1, phaseAt: t - num(ev.phase_ms), startAt: t - num(ev.total_ms) };
          noteProgress();
          return;
        }
        case 'token_usage': {
          const u = ev.usage;
          if (!u || typeof u !== 'object') return;
          state.usage = { prompt_tokens: num(u.prompt_tokens), completion_tokens: num(u.completion_tokens), total_tokens: num(u.total_tokens) };
          for (const k of ['reasoning_tokens', 'cache_read_tokens']) if (num(u[k])) state.usage[k] = num(u[k]);
          noteProgress();
          return;
        }
        case 'context_health': {
          if (!num(ev.input_tokens)) return;
          state.context = { input_tokens: num(ev.input_tokens), output_tokens: num(ev.output_tokens), context_limit: num(ev.context_limit), usage_percent: num(ev.usage_percent) };
          noteProgress();
          return;
        }
        default: return;
      }
    };
    const seen = (data) => {
      try { ingest(data?.choices?.[0]?.delta?.content); } catch {}
      try { if (data && data.gateway) observe(data.gateway); } catch {}
    };

    const origWrite = res.write;
    res.write = (chunk, ...rest) => {
      if (typeof chunk === 'string' && chunk.startsWith('data: ')) {
        const json = chunk.slice(6).trim();
        if (json && json !== '[DONE]') {
          try { seen(JSON.parse(json)); } catch {}
        }
      }
      return origWrite.call(res, chunk, ...rest);
    };
    res.observeClosed = (data) => { seen(data); };

    return {
      turnId,
      origin,
      finish(ok = true, error = null) {
        if (finished) return;
        finished = true;
        if (timer) { clearTimeout(timer); timer = null; }
        if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
        for (const t of workerTimers.values()) clearTimeout(t);
        workerTimers.clear();
        res.write = origWrite;
        delete res.observeClosed;
        const endedAt = new Date(now()).toISOString();
        publish('turn_end', { turnId, agent, origin, ok: !!ok, error: error ? clip(error, 500) : null, reply: clip(text, TEXT_CAP), endedAt,
          notify: [...state.notify.values()].map(n => ({ id: n.id, role: n.role })) });
        // Keep the finished turn answerable briefly: a page that asks "turn so far" just as the turn ends
        // still gets the whole picture instead of nothing.
        state.ended = { ok: !!ok, error: error ? clip(error, 500) : null, endedAt };
        state.text = text;
        if (turns.get(agent) === state) {
          const t = setTimeout(() => { if (turns.get(agent) === state) turns.delete(agent); }, KEEP_FINISHED_MS);
          t.unref?.();
        }
      },
      get text() { return text; },
      get state() { return state; },
    };
  }

  /**
   * turnFor(agent) -> the running (or just-finished) turn of an agent as a plain object, or null:
   * { active, turnId, agent, origin, startedAt, message, text, activity: [...], dropped, workers: [...],
   *   progress, usage, context (as in turn_progress), ended? }.
   * This is what a page that opens or wakes mid-turn fetches to catch up before following /api/events.
   */
  // The question an agent is waiting on (ask_user), kept here so a page that loads or reconnects after the chat
  // stream dropped can still show it. Set by runAskUser, cleared when answered, timed out or the turn ends.
  const questions = new Map();   // agent -> { request_id, questions, ts }
  function setQuestion(agent, q) { const a = String(agent || ''); if (q) questions.set(a, { ...q, ts: new Date().toISOString() }); else questions.delete(a); }
  function questionFor(agent) { return questions.get(String(agent || '')) || null; }

  function turnFor(agent) {
    const s = turns.get(String(agent || ''));
    if (!s) return null;
    return {
      active: !s.ended,
      question: s.ended ? null : (questions.get(String(agent || '')) || null),
      turnId: s.turnId, agent: s.agent, origin: s.origin, startedAt: s.startedAt, message: s.message,
      activityLabel: activityOf(s.origin),
      text: clip(s.ended ? s.text : (s.liveText ? s.liveText() : s.text || ''), TEXT_CAP),
      activity: s.activity.map(a => ({ ...a })),
      dropped: s.dropped,
      workers: [...s.workers.values()].map(w => ({ ...w, text: clip(w.text, WORKER_TEXT_CAP), tools: w.tools.map(t => ({ ...t })) })),
      ...(s.ended ? { progress: null, usage: s.usage ? { ...s.usage } : null, context: s.context ? { ...s.context } : null } : liveOf(s)),
      ended: s.ended || null,
      notify: s.ended ? [] : [...s.notify.keys()],   // user ids that asked for a notification when this turn ends
    };
  }

  /**
   * "Notify me when done" (the 🔔 next to Stop while a reply runs): turn a notification on or off for one person when
   * this agent's running turn ends. user: { id, role } ({ id: '*' } on a hub without accounts). turnId (optional) must
   * match the running turn. Publishes turn_notify so every page of that person shows the bell's state. Returns
   * { turnId, on, users } or null when the agent is not working on a turn.
   */
  function setTurnNotify(agent, { on = true, user = null, turnId = null } = {}) {
    const s = turns.get(String(agent || ''));
    if (!s || s.ended || (turnId && s.turnId !== turnId) || !user || !user.id) return null;
    const id = String(user.id);
    if (on) s.notify.set(id, { id, role: String(user.role || ''), at: new Date(now()).toISOString() });
    else s.notify.delete(id);
    publish('turn_notify', { turnId: s.turnId, agent: s.agent, userId: id, on: !!on }, { keep: false });
    return { turnId: s.turnId, on: !!on, users: [...s.notify.keys()] };
  }
  /** Names of agents with a running turn. */
  function activeAgents() { return [...turns.entries()].filter(([, s]) => !s.ended).map(([name]) => name); }

  function recent(afterId = 0) { return ring.filter(ev => ev.seq > afterId); }
  function clientCount() { return clients.size; }

  return { publish, subscribe, tapTurn, turnFor, setTurnNotify, setQuestion, questionFor, activeAgents, recent, clientCount, onPublish, setStatusProvider, setHaltProvider, haltState, setPacingProvider, pacingState, setApprovalsProvider, approvalsState, statusSnapshot };
}

/**
 * markInProgress(history, turn): while an agent's turn runs, its reply is saved to the conversation log every 5 s as
 * plain text (so a restart loses nothing). That last entry is not a finished reply: flag it `inProgress`, so a page
 * that loads history mid-turn shows the live turn (text and tool calls) in its place instead of a text-only copy.
 * turn: turnFor(agent). Returns the history (changed in place).
 */
function markInProgress(history, turn) {
  const last = Array.isArray(history) ? history[history.length - 1] : null;
  if (turn && turn.active && last && last.role === 'assistant' && Date.parse(last.ts) >= Date.parse(turn.startedAt) - 1000) last.inProgress = true;
  return history;
}

module.exports = { createHubEvents, activityOf, normalizeOrigin, summarizeInput, markInProgress, BOOT_ID, events: createHubEvents() };
