/**
 * Codex app-server transport — one `codex app-server` process per hub turn,
 * spoken to over JSON-RPC (newline-delimited JSON on stdio).
 *
 * Why not `codex exec`: exec takes its prompt on stdin and has no way to add
 * input while it runs, so a mid-turn interjection could only become a
 * follow-up turn after the model had finished. The app-server keeps the turn
 * open: `turn/steer` adds the operator's text to the RUNNING turn, the model
 * sees it at its next step, and `turn/interrupt` stops it cleanly.
 *
 * Protocol used (codex-cli 0.156, schema `codex app-server generate-json-schema`):
 *   initialize {clientInfo} → initialized (notification)
 *   thread/start | thread/resume → {thread:{id}}
 *   turn/start {threadId, input} → {turn:{id}}   … notifications …   turn/completed {turn}
 *   turn/steer {threadId, expectedTurnId, input, clientUserMessageId} → {turnId}
 *     refused (-32600 "expected active turn id …") once the turn is over
 *   turn/interrupt {threadId, turnId}
 *
 * The mapper at the bottom turns notifications into the same action kinds
 * lib/codex-cli/index.js#eventToActions produces for exec, plus live text deltas.
 */

const { spawn } = require('child_process');
const readline = require('readline');
const crypto = require('crypto');
const codexCli = require('./index');

const PROTOCOL_TIMEOUT_MS = 30000;

/** HUB_CODEX_TRANSPORT=exec switches back to one `codex exec` per turn. */
function transportFor(env = process.env) {
  return String(env.HUB_CODEX_TRANSPORT || '').trim().toLowerCase() === 'exec' ? 'exec' : 'app-server';
}

// ── JSON-RPC client ───────────────────────────────────────────────────────

class RpcError extends Error {
  constructor(method, err) {
    super(`${method}: ${err?.message || JSON.stringify(err)}`);
    this.code = err?.code;
    this.rpcMessage = err?.message || '';
  }
}

class AppServerClient {
  /**
   * @param {object} o
   * @param {string} o.bin   codex binary
   * @param {string} o.cwd
   * @param {object} o.env
   * @param {string} [o.agentName]  for log lines
   * @param {Function} [o.onNotification]  (method, params) => void
   * @param {Function} [o.spawnImpl]  test hook
   */
  constructor({ bin, cwd, env, agentName = '?', onNotification = () => {}, onServerRequest = null, spawnImpl = spawn }) {
    this.onServerRequest = onServerRequest;
    this.agentName = agentName;
    this.onNotification = onNotification;
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
    this.stderrTail = '';
    this.exitWaiters = [];
    this.child = spawnImpl(bin, ['app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    this.child.stdin.on('error', () => {});
    readline.createInterface({ input: this.child.stdout }).on('line', (l) => this._onLine(l));
    this.child.stderr.on('data', (d) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-4000);
      for (const l of String(d).split('\n')) {
        // The bubblewrap warning repeats on every start on hosts without user namespaces: not worth a log line.
        if (/\bERROR\b|panicked/i.test(l) && !/bubblewrap|user namespaces/.test(l)) console.error(`[codex ${agentName} app-server] ${l.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 400)}`);
      }
    });
    this.child.on('error', (e) => { this.stderrTail += `\n${e.message}`; this._onExit(null); });
    this.child.on('close', (code) => this._onExit(code));
  }

  _onLine(line) {
    const s = String(line || '').trim();
    if (!s || s[0] !== '{') return;
    let m;
    try { m = JSON.parse(s); } catch { return; }
    if (m.id != null && !m.method) {                 // response
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new RpcError(p.method, m.error)); else p.resolve(m.result);
      return;
    }
    if (m.id != null && m.method) {                  // server → client request
      this._answerServerRequest(m);
      return;
    }
    if (m.method) {
      try { this.onNotification(m.method, m.params || {}); }
      catch (e) { console.error(`[codex ${this.agentName}] notification handler: ${e.message}`); }
    }
  }

  /**
   * Hub turns run with approvalPolicy "never", so approvals and questions should
   * not arrive. If one does, refuse it: an unanswered request would hang the turn.
   */
  _answerServerRequest(m) {
    // Approval requests (approvalPolicy "untrusted": shell commands and file changes outside Codex's trusted set)
    // are decided by the hub's tool policy; anything else is refused so the turn never hangs.
    if (this.onServerRequest) {
      Promise.resolve().then(() => this.onServerRequest(m.method, m.params || {})).then((result) => {
        if (result === null || result === undefined) {
          console.error(`[codex ${this.agentName}] refusing server request ${m.method}`);
          this._write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `My Maestro AI does not handle ${m.method}` } });
        } else this._write({ jsonrpc: '2.0', id: m.id, result });
      }).catch((e) => this._write({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: `My Maestro AI: ${e.message}` } }));
      return;
    }
    console.error(`[codex ${this.agentName}] refusing server request ${m.method}`);
    this._write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `My Maestro AI does not handle ${m.method}` } });
  }

  _write(obj) {
    if (this.closed) return false;
    try { this.child.stdin.write(JSON.stringify(obj) + '\n'); return true; } catch { return false; }
  }

  _onExit(code) {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code;
    const why = new Error(`codex app-server exited${code != null ? ` (code ${code})` : ''}: ${this.stderrTail.trim().split('\n').pop() || 'no output'}`);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(why); }
    this.pending.clear();
    for (const w of this.exitWaiters.splice(0)) w(why);
  }

  /** Resolves with an Error when the process exits. */
  whenExited() { return new Promise((r) => { if (this.closed) r(new Error('codex app-server exited')); else this.exitWaiters.push(r); }); }

  request(method, params, { timeoutMs = PROTOCOL_TIMEOUT_MS } = {}) {
    if (this.closed) return Promise.reject(new Error(`codex app-server is not running (${method})`));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => { this.pending.delete(id); reject(new Error(`${method}: no reply in ${timeoutMs / 1000}s`)); }, timeoutMs) : null;
      this.pending.set(id, { resolve, reject, timer, method });
      this._write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) { this._write(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params }); }

  async initialize(version = '0') {
    const r = await this.request('initialize', { clientInfo: { name: 'agent-hub', title: 'My Maestro AI', version: String(version) } });
    this.notify('initialized');
    return r;
  }

  /** SIGTERM the process group, SIGKILL after 5s. */
  close() {
    const pid = this.child?.pid;
    if (!pid || this.killed) return;
    this.killed = true;
    try { this.child.stdin.end(); } catch {}
    try { process.kill(-pid, 'SIGTERM'); } catch { try { this.child.kill('SIGTERM'); } catch {} }
    const t = setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch {} }, 5000);
    t.unref?.();
  }
}

// ── Thread config ─────────────────────────────────────────────────────────

/** thread/start + thread/resume params: the same settings buildArgs puts on the exec command line. */
function threadParams({ model, cwd, sandbox, approvalPolicy = 'never', instructions, bridge, nodePath = process.execPath, ephemeral = false, effort = null, reasoningSummary = null }) {
  const p = {
    cwd,
    sandbox: sandbox || 'read-only',
    approvalPolicy: approvalPolicy || 'never',
  };
  if (model) p.model = model;
  if (instructions) p.developerInstructions = instructions;
  if (bridge) {
    p.config = {
      mcp_servers: {
        'agent-hub': {
          command: nodePath,
          args: [codexCli.MCP_BRIDGE_SCRIPT],
          env: { HUB_CODEX_BRIDGE_FILE: bridge.file },
          tool_timeout_sec: 3600,
          supports_parallel_tool_calls: true,
        },
      },
    };
  }
  if (effort) p.config = { ...(p.config || {}), model_reasoning_effort: effort };   // lib/effort
  // The reasoning panel (settings.showReasoning): Codex streams its reasoning summary only when asked for one.
  if (reasoningSummary) p.config = { ...(p.config || {}), model_reasoning_summary: reasoningSummary };
  if (ephemeral) p.ephemeral = true;
  return p;
}

/** turn/start input items: text plus local images. */
function turnInput(text, images = []) {
  const input = [];
  if (text) input.push({ type: 'text', text });
  for (const p of images || []) input.push({ type: 'localImage', path: p });
  return input;
}

/** Did turn/steer fail because no turn is running (as opposed to a transport failure)? */
function isSteerRefusal(err) {
  return /expected active turn|no active turn|not steerable|turn .*(completed|finished|not running)/i.test(err?.rpcMessage || err?.message || '');
}

// ── Notification → hub actions ────────────────────────────────────────────

/** app-server items are camelCase; the exec helpers expect snake_case. */
function normalizeItem(it) {
  if (!it || typeof it !== 'object') return {};
  const type = String(it.type || '').replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
  const out = { ...it, type };
  if (it.aggregatedOutput !== undefined) out.aggregated_output = it.aggregatedOutput;
  if (it.exitCode !== undefined) out.exit_code = it.exitCode;
  if (Array.isArray(it.changes)) {
    out.changes = it.changes.map((c) => ({ ...c, kind: c && typeof c.kind === 'object' ? (c.kind.type || 'edit') : c?.kind }));
  }
  return out;
}

/** Per-turn mapper state. */
function newMapperState() {
  return { streamed: new Set(), usage: { input: 0, cached: 0, output: 0 }, lastInput: 0 };
}

/**
 * Turn one app-server notification into hub actions. Kinds:
 *   text_begin {id} | text {text} | tool_start | tool_result | thinking | reasoning {text} |
 *   user_message {id, clientId, text} | usage {usage, perTurn:true} |
 *   error {message, soft?} | turn_done {status, turnId, error?}
 */
function notificationToActions(method, params, state) {
  const p = params || {};
  switch (method) {
    case 'item/started': {
      const it = normalizeItem(p.item);
      if (it.type === 'agent_message') return [{ kind: 'text_begin', id: it.id }];
      if (it.type === 'reasoning') return [{ kind: 'thinking' }];
      if (it.type === 'user_message') {
        const text = (p.item.content || []).filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
        return [{ kind: 'user_message', id: it.id, clientId: p.item.clientId || null, text }];
      }
      if (codexCli.TOOL_ITEMS.has(it.type)) return [{ kind: 'tool_start', id: it.id, tool: codexCli.toolNameOf(it), input: codexCli.toolInputOf(it) }];
      return [];
    }
    case 'item/agentMessage/delta':
      if (!p.delta) return [];
      state.streamed.add(p.itemId);
      return [{ kind: 'text', text: p.delta, delta: true }];
    // Reasoning (the panel above the reply): the summary Codex shows, streamed; a new summary part starts a paragraph.
    case 'item/reasoning/summaryTextDelta':
      if (!p.delta) return [];
      state.streamed.add(p.itemId);
      return [{ kind: 'reasoning', text: p.delta, item: p.itemId }];
    case 'item/reasoning/summaryPartAdded':
      return state.streamed.has(p.itemId) ? [{ kind: 'reasoning', text: '\n\n', item: p.itemId }] : [];
    case 'item/completed': {
      const it = normalizeItem(p.item);
      if (it.type === 'agent_message') {
        // Deltas already carried the text; send the whole message only if none arrived.
        return !state.streamed.has(it.id) && it.text ? [{ kind: 'text', text: it.text }] : [];
      }
      if (it.type === 'reasoning' && !state.streamed.has(it.id)) {
        // No summary streamed for it: the whole summary (or the reasoning text) at once. Parts are strings (the
        // protocol's shape); { text } parts are read too.
        const raw = p.item || {};
        const textOf = (s) => (typeof s === 'string' ? s : s && typeof s.text === 'string' ? s.text : '');
        const pick = (a) => (Array.isArray(a) ? a.map(textOf).filter(Boolean) : []);
        const parts = pick(raw.summary).length ? pick(raw.summary) : pick(raw.content);
        return parts.length ? [{ kind: 'reasoning', text: parts.join('\n\n'), item: it.id }] : [];
      }
      if (codexCli.TOOL_ITEMS.has(it.type)) return [{ kind: 'tool_result', id: it.id, tool: codexCli.toolNameOf(it), input: codexCli.toolInputOf(it), output: codexCli.toolOutputOf(it) }];
      return [];
    }
    case 'thread/tokenUsage/updated': {
      const last = p.tokenUsage?.last || {};
      state.usage.input += last.inputTokens || 0;
      state.usage.cached += last.cachedInputTokens || 0;
      state.usage.output += last.outputTokens || 0;
      state.lastInput = last.inputTokens || state.lastInput;
      return [];
    }
    case 'error': {
      const message = p.error?.message || 'Codex error';
      return [{ kind: 'error', message, soft: !!p.willRetry }];
    }
    case 'turn/completed': {
      const turn = p.turn || {};
      const acts = [{ kind: 'usage', perTurn: true, usage: { input_tokens: state.usage.input, cached_input_tokens: state.usage.cached, output_tokens: state.usage.output, context_tokens: state.lastInput } }];
      if (turn.status === 'failed') acts.push({ kind: 'error', message: turn.error?.message || 'Codex turn failed' });
      acts.push({ kind: 'turn_done', status: turn.status || 'completed', turnId: turn.id, error: turn.error?.message || null });
      return acts;
    }
    default: return [];
  }
}

// ── Session: one process, one thread, one or more turns ──────────────────

class CodexAppSession {
  constructor(opts) {
    this.opts = opts;
    this.agentName = opts.agentName || '?';
    this.threadId = null;
    this.turnId = null;
    this.turnListener = null;
    this.client = new AppServerClient({ ...opts, onNotification: (m, p) => this._onNotification(m, p) });
  }

  /** Spawn + initialize. Throws if the app-server cannot start (caller falls back to exec). */
  static async open(opts) {
    const s = new CodexAppSession(opts);
    try {
      await Promise.race([s.client.initialize(opts.version), s.client.whenExited().then((e) => { throw e; })]);
    } catch (e) {
      s.close();
      throw e;
    }
    return s;
  }

  _onNotification(method, params) {
    if (this.turnListener && (!params.threadId || params.threadId === this.threadId)) this.turnListener(method, params);
  }

  /**
   * Resume the stored thread or start a new one.
   * @returns {{threadId:string, resumed:boolean, resumeError?:string}}
   */
  async openThread({ resumeId, ...cfg }) {
    const params = threadParams(cfg);
    if (resumeId) {
      try {
        const r = await this.client.request('thread/resume', { threadId: resumeId, ...params, excludeTurns: true });
        this.threadId = r?.thread?.id || resumeId;
        return { threadId: this.threadId, resumed: true };
      } catch (e) {
        if (this.client.closed) throw e;
        const r = await this.client.request('thread/start', params);
        this.threadId = r.thread.id;
        return { threadId: this.threadId, resumed: false, resumeError: e.message };
      }
    }
    const r = await this.client.request('thread/start', params);
    this.threadId = r.thread.id;
    return { threadId: this.threadId, resumed: false };
  }

  /**
   * Run one turn to completion.
   * @param {object} o
   * @param {Array} o.input          turnInput(...)
   * @param {Function} o.onAction    (action) => void
   * @param {AbortSignal} [o.signal] abort → turn/interrupt
   * @param {Function} [o.onStarted] (turnId) => void, once the turn is running (steer is possible)
   * @returns {Promise<{status:string, error:string|null}>}
   */
  async runTurn({ input, onAction, signal, onStarted }) {
    const state = newMapperState();
    let settle;
    const done = new Promise((r) => { settle = r; });
    let finished = false;
    const finish = (v) => { if (!finished) { finished = true; settle(v); } };

    this.turnListener = (method, params) => {
      if (this.turnId && params.turnId && params.turnId !== this.turnId && method !== 'turn/completed') return;
      if (method === 'turn/completed' && this.turnId && params.turn?.id && params.turn.id !== this.turnId) return;
      for (const a of notificationToActions(method, params, state)) {
        if (a.kind === 'turn_done') finish({ status: a.status, error: a.error });
        else onAction(a);
      }
    };

    let interruptTimer = null;
    const onAbort = () => {
      if (this.turnId) this.client.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, { timeoutMs: 5000 }).catch(() => {});
      // Give Codex a moment to close the turn itself; stop waiting either way.
      interruptTimer = setTimeout(() => finish({ status: 'interrupted', error: null }), 3000);
    };
    if (signal) {
      if (signal.aborted) return { status: 'interrupted', error: null };
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const exited = this.client.whenExited().then((e) => finish({ status: 'failed', error: e.message }));

    try {
      const r = await this.client.request('turn/start', { threadId: this.threadId, input });
      this.turnId = r?.turn?.id || null;
      if (signal?.aborted) onAbort();
      else if (onStarted) onStarted(this.turnId);
    } catch (e) {
      finish({ status: 'failed', error: e.message });
    }
    const result = await done;
    if (interruptTimer) clearTimeout(interruptTimer);
    if (signal) signal.removeEventListener('abort', onAbort);
    void exited;
    this.turnListener = null;
    this.turnId = null;
    return result;
  }

  /** Is a turn running that steer can reach? */
  get steerable() { return !!(this.turnId && !this.client.closed); }

  /**
   * Add input to the running turn.
   * @returns {Promise<{ok:true, clientId:string}|{ok:false, refused:boolean, error:string}>}
   */
  async steer(text) {
    if (!this.steerable) return { ok: false, refused: true, error: 'no running turn' };
    const clientId = crypto.randomUUID();
    try {
      await this.client.request('turn/steer', { threadId: this.threadId, expectedTurnId: this.turnId, input: [{ type: 'text', text }], clientUserMessageId: clientId }, { timeoutMs: 15000 });
      return { ok: true, clientId };
    } catch (e) {
      return { ok: false, refused: isSteerRefusal(e), error: e.message };
    }
  }

  close() { this.turnListener = null; this.client.close(); }
}

// ── Steering interjections into the running turn ─────────────────────────

/**
 * Moves queued interjections into the running turn with turn/steer.
 *
 * An interjection counts as delivered only when Codex echoes it back as a
 * userMessage item (matched by clientUserMessageId, or by text). Anything
 * refused, failed, or accepted but never echoed before the turn ends comes back
 * from finish() so the caller can requeue it for a follow-up turn: nothing is
 * dropped.
 */
class SteerPump {
  /**
   * @param {object} o
   * @param {{steerable:boolean, steer:Function}} o.session
   * @param {Function} o.drain        () => items taken from the hub queue
   * @param {Function} o.format       (item) => text sent to Codex
   * @param {Function} o.onDelivered  (item) => void, once Codex has it
   * @param {Function} [o.log]
   */
  constructor({ session, drain, format, onDelivered, log = () => {} }) {
    Object.assign(this, { session, drain, format, onDelivered, log });
    this.active = false;
    this.chain = Promise.resolve();
    this.inFlight = [];              // steer request sent, no reply yet
    this.awaiting = new Map();       // clientId → {item, text}: accepted, not echoed yet
    this.failed = [];                // refused or errored
    this.seen = { ids: new Set(), texts: [] };  // echoes that arrived before the steer reply
  }

  /** The turn is running: steer whatever is queued now and whatever arrives later. */
  start() { this.active = true; this.notify(); }

  notify() {
    if (!this.active) return;
    this.chain = this.chain.then(() => this._pump()).catch((e) => this.log(`steer pump: ${e.message}`));
  }

  async _pump() {
    while (this.active && this.session.steerable) {
      const items = this.drain();
      if (!items || items.length === 0) return;
      for (const item of items) {
        if (!this.active || !this.session.steerable) { this.failed.push(item); continue; }
        const text = this.format(item);
        this.inFlight.push(item);
        const r = await this.session.steer(text);
        this.inFlight.splice(this.inFlight.indexOf(item), 1);
        if (!r.ok) {
          this.log(`steer ${r.refused ? 'refused' : 'failed'} (${String(r.error).slice(0, 120)}); will run as a follow-up turn`);
          this.failed.push(item);
          continue;
        }
        const ti = this.seen.texts.indexOf(text);
        if (this.seen.ids.has(r.clientId) || ti >= 0) {
          this.seen.ids.delete(r.clientId);
          if (ti >= 0) this.seen.texts.splice(ti, 1);
          this.onDelivered(item);
        } else {
          this.awaiting.set(r.clientId, { item, text });
        }
      }
    }
  }

  /** A userMessage item appeared in the turn. */
  onUserMessage({ clientId, text }) {
    if (clientId && this.awaiting.has(clientId)) {
      const { item } = this.awaiting.get(clientId);
      this.awaiting.delete(clientId);
      this.onDelivered(item);
      return;
    }
    for (const [id, a] of this.awaiting) {
      if (a.text === text) { this.awaiting.delete(id); this.onDelivered(a.item); return; }
    }
    if (clientId) this.seen.ids.add(clientId);
    if (text) this.seen.texts.push(text);
  }

  /** The turn is over. Returns the items Codex never received. */
  async finish() {
    this.active = false;
    await this.chain;
    const left = this.undelivered();
    this.failed = []; this.inFlight = []; this.awaiting.clear();
    this.seen = { ids: new Set(), texts: [] };
    return left;
  }

  /** Items taken from the queue but not yet confirmed (for alert status checks). */
  undelivered() { return [...this.failed, ...this.inFlight, ...[...this.awaiting.values()].map((a) => a.item)]; }
}

module.exports = {
  transportFor,
  SteerPump,
  AppServerClient,
  CodexAppSession,
  threadParams,
  turnInput,
  isSteerRefusal,
  normalizeItem,
  newMapperState,
  notificationToActions,
};
