'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LIVE = new Set(['running', 'retrying', 'stopping']);
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(id);

class CheckpointStore {
  constructor(dir = path.join(__dirname, '..', 'data', 'tiger-team-checkpoints')) { this.dir = dir; }
  read(id) {
    if (!validId(id)) return null;
    try {
      const state = JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), 'utf8'));
      for (const event of this.events(id)) {
        if (event.seq <= (state.eventSeq || 0)) continue;
        if (event.type === 'model_chunk') {
          const call = state.calls?.[event.callKey];
          const text = event.chunk.choices?.[0]?.delta?.content;
          if (call && text) { call.fullResponse = (call.fullResponse || '') + text; call.partialText = (call.partialText || '') + text; }
        }
        state.eventSeq = event.seq;
      }
      return state;
    }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  save(id, state) {
    if (!validId(id)) throw new Error('Invalid Tiger Team checkpoint ID');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const data = snapshot(id, state);
    const file = path.join(this.dir, `${id}.json`);
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(tmp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(data));
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(tmp, file);
      syncDirectory(this.dir);
    } catch (cause) {
      throw Object.assign(new Error('Tiger Team checkpoint persistence failed: ' + cause.message, { cause }), { code: 'TT_PERSISTENCE_FAILED' });
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(tmp); } catch {}
    }
    return data;
  }
  // One fsync per event, before it can be displayed or acknowledged.
  append(id, state, event) {
    if (!validId(id)) throw new Error('Invalid Tiger Team checkpoint ID');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, `${id}.events.jsonl`);
    let fd;
    try {
      fd = fs.openSync(file, 'a', 0o600);
      // A killed write may leave an unacknowledged partial last record.
      // Remove only that tail before appending another committed event.
      const size = fs.fstatSync(fd).size;
      if (size) {
        const readFd = fs.openSync(file, 'r');
        try {
          const last = Buffer.alloc(1); fs.readSync(readFd, last, 0, 1, size - 1);
          if (last[0] !== 10) {
            let pos = size, cut = 0; const tail = Buffer.alloc(65536);
            while (pos > 0) {
              const len = Math.min(pos, tail.length); pos -= len;
              fs.readSync(readFd, tail, 0, len, pos);
              const newline = tail.subarray(0, len).lastIndexOf(10);
              if (newline !== -1) { cut = pos + newline + 1; break; }
            }
            fs.ftruncateSync(fd, cut);
          }
        } finally { fs.closeSync(readFd); }
      }
      const record = { ...event, seq: (state.eventSeq || 0) + 1, at: new Date().toISOString() };
      fs.writeFileSync(fd, JSON.stringify(record) + '\n');
      fs.fsyncSync(fd);
      if (!size) syncDirectory(this.dir);
      state.eventSeq = record.seq;
      return record;
    } catch (cause) {
      throw Object.assign(new Error('Tiger Team journal persistence failed: ' + cause.message, { cause }), { code: 'TT_PERSISTENCE_FAILED' });
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  *events(id) {
    if (!validId(id)) throw new Error('Invalid Tiger Team checkpoint ID');
    const file = path.join(this.dir, `${id}.events.jsonl`);
    let fd;
    try { fd = fs.openSync(file, 'r'); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }
    try {
      const decoder = new (require('node:string_decoder').StringDecoder)('utf8');
      const buffer = Buffer.alloc(65536); let pending = '', n;
      while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) {
        pending += decoder.write(buffer.subarray(0, n));
        let end;
        while ((end = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          if (line) yield JSON.parse(line);
        }
      }
      // An incomplete tail was never acknowledged.  Do not invent its contents.
    } finally { fs.closeSync(fd); }
  }
  artifact(id, value) {
    if (!validId(id)) throw new Error('Invalid Tiger Team checkpoint ID');
    const text = typeof value === 'string' ? value : JSON.stringify(value) ?? 'null';
    const hash = crypto.createHash('sha256').update(text).digest('hex');
    const dir = path.join(this.dir, id + '.artifacts');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, hash + '.txt');
    if (!fs.existsSync(file)) {
      const tmp = file + '.' + crypto.randomUUID() + '.tmp'; let fd;
      try {
        fd = fs.openSync(tmp, 'wx', 0o600); fs.writeFileSync(fd, text); fs.fsyncSync(fd);
        fs.closeSync(fd); fd = undefined; fs.renameSync(tmp, file); syncDirectory(dir); syncDirectory(this.dir);
      } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(tmp); } catch {} }
    }
    return { hash, chars: text.length, bytes: Buffer.byteLength(text) };
  }
  readArtifact(id, hash) {
    if (!validId(id) || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid artifact identifier');
    const text = fs.readFileSync(path.join(this.dir, id + '.artifacts', hash + '.txt'), 'utf8');
    if (crypto.createHash('sha256').update(text).digest('hex') !== hash) throw new Error('Artifact checksum mismatch');
    return text;
  }
  list() {
    try { return fs.readdirSync(this.dir).filter(f => f.endsWith('.json')).map(f => {
      try { return this.read(f.slice(0, -5)); } catch { return null; }
    }).filter(Boolean); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }
}

function syncDirectory(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function attachSession(state, session) {
  state.pendingMessages ||= session?.pendingMessages || [];
  state.session = session || null;
  if (session) session.pendingMessages = state.pendingMessages;
}
function queueDirective(store, id, state, message) {
  if (typeof message !== 'string' || !message.trim()) throw new Error('Message is required');
  state.pendingMessages ||= state.session?.pendingMessages || [];
  state.userDirectives ||= [];
  const record = { kind: 'injection', message, at: new Date().toISOString() };
  state.pendingMessages.push(message); state.userDirectives.push(record);
  try { store.save(id, state); }
  catch (e) { state.pendingMessages.pop(); state.userDirectives.pop(); throw e; }
  if (state.session) state.session.pendingMessages = state.pendingMessages;
}

function unresolved(state) {
  return Object.values(state.calls || {}).flatMap(call => Object.entries(call.tools || {})
    .filter(([, t]) => ['in_flight', 'unknown', 'source_blocked'].includes(t.status) && t.name !== 'consult_agent')
    .map(([toolId, t]) => ({ callKey: call.key, toolId, name: t.name })));
}
function requireReconciled(state) {
  const pending = unresolved(state);
  if (pending.length) throw Object.assign(new Error('Recovery blocked: tool outcome needs explicit reconciliation: ' + JSON.stringify(pending)), { code: 'TT_RECONCILIATION_REQUIRED' });
}
function reconcile(state, { callKey, toolId, result, evidence }) {
  if (state.executing || state.apiReserved) throw new Error('Stop the investigation before reconciliation');
  const tool = state.calls?.[callKey]?.tools?.[toolId];
  if (!tool || !['in_flight', 'unknown', 'source_blocked'].includes(tool.status)) throw new Error('No unknown tool outcome at that ID');
  if (typeof result !== 'string' || !result.trim() || typeof evidence !== 'string' || !evidence.trim()) throw new Error('Verified result and reconciliation evidence are required');
  (tool.priorOutcomes ||= []).push({ status: tool.status, result: tool.result, error: tool.error, at: new Date().toISOString() });
  Object.assign(tool, { status: 'completed', result, reconciliation: { evidence, at: new Date().toISOString() } });
}

// Large context stays intact on disk.  Readers page exact text, never a summary.
function displayTranscript(state) {
  const calls = Object.values(state.calls || {});
  if (!calls.length) return state.plainTranscript || '';
  return calls.map(c => '\n\n### ' + c.agent + ' (' + c.status + ')\n' + (c.fullResponse || c.result || '')).join('');
}

function archivePage(store, id, state, { call_key, tool_id, artifact, events_after, offset = 0, limit = 20000 } = {}) {
  offset = Math.max(0, Math.trunc(Number(offset) || 0));
  limit = Math.min(60000, Math.max(1, Math.trunc(Number(limit) || 20000)));
  let value, next_event_seq;
  if (events_after !== undefined) {
    // One exact event at a time, paged if large.  Advance the sequence only
    // after consuming every text page of the current event.
    const after = Math.max(0, Number(events_after) || 0);
    let event;
    for (const candidate of store.events(id)) { if (candidate.seq > after) { event = candidate; break; } }
    value = JSON.stringify(event || null); next_event_seq = event?.seq ?? null;
  } else if (artifact) value = store.readArtifact(id, artifact);
  else if (call_key) {
    const call = state.calls?.[call_key];
    if (!call) throw new Error('Unknown archived call');
    if (tool_id && !call.tools?.[tool_id]) throw new Error('Unknown archived tool');
    value = JSON.stringify(tool_id ? call.tools[tool_id] : call);
  } else value = JSON.stringify({ objective: state.objective, context: state.context,
    directives: state.userDirectives || [], pendingMessages: state.pendingMessages || [],
    unresolved: unresolved(state), last_event_seq: state.eventSeq || 0,
    calls: Object.values(state.calls || {}).map(c => ({ key: c.key, agent: c.agent, status: c.status,
      responseChars: (c.fullResponse || c.result || '').length,
      tools: Object.entries(c.tools || {}).map(([id, t]) => ({ id, name: t.name, status: t.status, resultChars: t.result?.length, artifacts: t.artifacts || [] })) })) });
  return { id, offset, next_event_seq, total_chars: value.length, next_offset: offset + limit < value.length ? offset + limit : null, text: value.slice(offset, offset + limit) };
}

function snapshot(id, state) {
  const { session, abortController, apiReserved, executing, ...data } = state;
  return { ...data, pendingMessages: data.pendingMessages || session?.pendingMessages || [], id, schemaVersion: 2, updated_at: new Date().toISOString() };
}

function restore(data) {
  const state = structuredClone(data);
  if (LIVE.has(state.status)) {
    state.status = 'interrupted';
    state.error = 'The previous process ended before this investigation completed.';
  }
  // Legacy field means execution has ended, not successful completion.
  // All success checks must use status === 'completed'.
  state.completedAt = state.completedAt || Date.now();
  state.session = null;
  state.abortController = new AbortController();
  state.executing = false;
  return state;
}

function classify(error) {
  if (error?.code === 'TT_SOURCE_BLOCKED') return 'blocked';
  if (error?.code === 'TT_BUSY') return 'transient';
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return 'stopped';
  const text = `${error?.code || ''} ${error?.message || error || ''} ${error?.cause?.code || ''}`;
  if (/\b(400|401|403|404|422)\b|unauthori[sz]ed|forbidden|invalid.*(?:key|credential)|context.{0,20}(?:length|limit)|content_filter/i.test(text)) return 'blocked';
  if (/\b(408|409|425|429|500|502|503|504)\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR|fetch failed|socket hang up|network|terminated|truncat|premature|incomplete stream/i.test(text)) return 'transient';
  return 'blocked';
}

function abortError() { return Object.assign(new Error('Tiger Team stopped'), { name: 'AbortError' }); }
function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

// One budget for the entire agent call, not a fresh budget per model turn.
// Tool execution is deliberately outside this retry loop.
async function retry(operation, { budget, signal, onRetry = () => {}, wait = sleep, random = Math.random, now = Date.now } = {}) {
  budget ||= { used: 0, max: 3, maxWaitMs: 90000, waitedMs: 0 };
  for (;;) {
    if (signal?.aborted) throw abortError();
    try { return await operation(); }
    catch (error) {
      if (signal?.aborted) throw abortError();
      if (classify(error) !== 'transient' || budget.used >= budget.max) throw error;
      const retryAfter = Math.max(0, Number(error.retryAfterMs) || 0);
      const delay = Math.max(retryAfter, Math.round(Math.min(20000, 2000 * 2 ** budget.used) * (0.8 + random() * 0.4)));
      if ((budget.waitedMs || 0) + delay > budget.maxWaitMs) throw error;
      budget.used++;
      budget.waitedMs = (budget.waitedMs || 0) + delay;
      budget.lastRetryAt = now();
      await onRetry({ attempt: budget.used, max_attempts: budget.max, delay_ms: delay, message: `Model connection failed.  Retrying ${budget.used}/${budget.max} in ${Math.ceil(delay / 1000)}s.`, error: error.message });
      await wait(delay, signal);
    }
  }
}

// An in-flight tool after a crash has an unknown outcome.  Never replay it
// automatically.  Agent consultations are resumable through their own journal.
function unknownToolResult(name) {
  return `RECOVERY: The previous process stopped while ${name} was in flight.  Its outcome is UNKNOWN.  This tool was NOT replayed.  Verify the actual state using read-only tools before proceeding.  Do not repeat a potentially mutating operation without explicit user approval.`;
}

module.exports = { CheckpointStore, snapshot, restore, validId, classify, retry, sleep, abortError, unknownToolResult, LIVE, unresolved, requireReconciled, reconcile, archivePage, attachSession, queueDirective, displayTranscript };
