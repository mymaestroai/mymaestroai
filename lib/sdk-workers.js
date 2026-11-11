'use strict';
// SDK sub-agent tracking for one SDK turn.
//
// When an SDK agent uses the SDK's built-in Agent tool, the hub shows the
// sub-agent as a worker panel. This module decides, per SDK message, whether
// the message belongs to the parent or to a sub-agent, and when a sub-agent
// has finished.
//
// Contract, from @anthropic-ai/claude-agent-sdk sdk.d.ts (0.3.270):
//  - parent_tool_use_id is non-null on a message that was produced INSIDE a
//    sub-agent, and equals that sub-agent's Agent tool_use id. It is null on
//    every top-level message.
//  - The Agent tool's own result arrives as a top-level user message whose
//    tool_result block has tool_use_id equal to the Agent tool_use id, with
//    tool_use_result carrying the sub-agent's final report.
//
// The previous inline code matched completion on parent_tool_use_id, which is
// never the Agent id on a top-level message, so a sub-agent was never released
// and every one was reported "Session ended while worker was active" when the
// turn ended. Meanwhile the parent's own streamed text was routed into the
// worker panel because the sub-agent still looked active.

const MAX_OUTPUT = 2000;

/** tool_use ids answered by the tool_result blocks of a user message. */
function toolResultIds(msg) {
  const content = msg && msg.message && msg.message.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter(b => b && b.type === 'tool_result' && typeof b.tool_use_id === 'string')
    .map(b => b.tool_use_id);
}

/** Plain text of one tool_result block (what the model reads), or ''. */
function toolResultText(msg, toolUseId) {
  const content = msg && msg.message && msg.message.content;
  if (!Array.isArray(content)) return '';
  const block = content.find(b => b && b.type === 'tool_result' && b.tool_use_id === toolUseId);
  if (!block) return '';
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) {
    return block.content.filter(p => p && p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
  }
  return '';
}

/** Short display form of a message's tool_use_result. */
function resultOutput(msg) {
  const r = msg && msg.tool_use_result;
  if (r === undefined || r === null) return '';
  const s = typeof r === 'string' ? r : JSON.stringify(r);
  return (s || '').substring(0, MAX_OUTPUT);
}

function toolResultBlock(msg, toolUseId) {
  const content = msg && msg.message && msg.message.content;
  if (!Array.isArray(content) || !toolUseId) return null;
  return content.find(b => b && b.type === 'tool_result' && b.tool_use_id === toolUseId) || null;
}

// Binary content (an image's base64) is never archived as text: it would fill the entry and the search index.
const binaryFree = (k, v) => ((k === 'data' || k === 'base64') && typeof v === 'string' && v.length > 200 && /^[A-Za-z0-9+/=\r\n]+$/.test(v) ? '[binary data]' : v);

/**
 * The whole result for the archive: the text the model read for that call (its tool_result block, an image part as
 * "[image]"), else the whole tool_use_result. Plain text rather than JSON keeps it searchable (an escaped newline
 * would glue two words).
 */
function resultFull(msg, toolUseId) {
  const block = toolResultBlock(msg, toolUseId);
  if (block) {
    const parts = typeof block.content === 'string' ? [block.content]
      : Array.isArray(block.content) ? block.content.map(p => (p && p.type === 'text' && typeof p.text === 'string') ? p.text : (p && p.type === 'image') ? '[image]' : '') : [];
    const t = parts.filter(Boolean).join('\n');
    if (t) return t;
  }
  const r = msg && msg.tool_use_result;
  if (r === undefined || r === null) return '';
  if (typeof r === 'string') return r;
  try { return JSON.stringify(r, binaryFree) || ''; } catch { return ''; }
}

/**
 * One step's output as the model read it: its tool_result block's text (an image part as "[image]"); a block that is
 * there but empty stays empty. Only a single-result message with no block falls back to the whole tool_use_result.
 */
function stepOutput(msg, toolUseId, single) {
  const block = toolResultBlock(msg, toolUseId);
  if (!block) return single ? resultOutput(msg) : '';
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) return block.content.map(p => (p && p.type === 'text' && typeof p.text === 'string') ? p.text : (p && p.type === 'image') ? '[image]' : '').filter(Boolean).join('\n');
  return '';
}

/** What the text alone doesn't say: the call failed (is_error) or was interrupted. Kept with the archived result. */
function resultMeta(msg, toolUseId) {
  const block = toolResultBlock(msg, toolUseId);
  const r = msg && msg.tool_use_result;
  const m = {};
  if (block && block.is_error) m.is_error = true;
  if (r && typeof r === 'object' && r.interrupted === true) m.interrupted = true;
  return Object.keys(m).length ? m : null;
}

class SdkWorkerTracker {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.workers = new Map();   // Agent tool_use id → { workerId, description, model, startedAt }
    this.counter = 0;
  }

  get size() { return this.workers.size; }

  /** Register the sub-agent started by an Agent tool_use block. */
  register(block) {
    const inp = block && typeof block.input === 'object' && block.input ? block.input : {};
    this.counter++;
    const worker = {
      workerId: `sdk-worker-${this.now()}-${this.counter}`,
      description: inp.description || (typeof inp.prompt === 'string' && inp.prompt.substring(0, 80)) || 'SDK Worker',
      model: inp.model || 'sonnet',
      prompt: typeof inp.prompt === 'string' ? inp.prompt.substring(0, 500) : '',
      startedAt: this.now(),
    };
    this.workers.set(block.id, worker);
    return worker;
  }

  /** The registered sub-agent a message was produced inside, or null for top-level messages. */
  workerFor(msg) {
    const id = msg && msg.parent_tool_use_id;
    return (id && this.workers.get(id)) || null;
  }

  /**
   * Classify a user message that carries tool results.
   *  - inner:     produced inside a sub-agent (its own tool results)
   *  - completed: top-level result(s) answering Agent tool_use(s); those workers are released
   *  - top:       an ordinary top-level tool result
   */
  resolveResult(msg) {
    const toolUseIds = toolResultIds(msg);
    const inner = this.workerFor(msg);
    // output: the short form the pages show; full: the whole result for the archive
    // results: one per tool_result block (a sub-agent's parallel calls come back in one message), each with its id
    if (inner) return { kind: 'inner', worker: inner, toolUseIds, output: resultOutput(msg), full: resultFull(msg, toolUseIds[0]),
      results: toolUseIds.length ? toolUseIds.map(id => ({ id, output: stepOutput(msg, id, toolUseIds.length === 1).substring(0, MAX_OUTPUT) })) : [{ id: null, output: resultOutput(msg) }] };
    const completed = this.completeByIds(toolUseIds).map(c => ({
      ...c,
      output: (toolResultText(msg, c.toolUseId) || resultOutput(msg)).substring(0, MAX_OUTPUT),
      full: resultFull(msg, c.toolUseId),
      meta: resultMeta(msg, c.toolUseId),
    }));
    if (completed.length) return { kind: 'completed', completed, toolUseIds, output: resultOutput(msg), full: resultFull(msg, toolUseIds[0]) };
    return { kind: 'top', toolUseIds, output: resultOutput(msg), full: resultFull(msg, toolUseIds[0]), meta: resultMeta(msg, toolUseIds[0]) };
  }

  /** Release the sub-agents whose Agent tool_use ids are listed. Returns what was released. */
  completeByIds(ids) {
    const completed = [];
    for (const id of ids || []) {
      const worker = this.workers.get(id);
      if (!worker) continue;
      this.workers.delete(id);
      completed.push({ toolUseId: id, worker, elapsedMs: this.now() - worker.startedAt });
    }
    return completed;
  }

  /** Remove and return every sub-agent still registered (the turn is over). */
  drain() {
    const left = [...this.workers.values()];
    this.workers.clear();
    return left;
  }
}

module.exports = { SdkWorkerTracker, toolResultIds, toolResultText, resultFull, resultMeta };
