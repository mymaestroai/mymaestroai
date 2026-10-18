'use strict';

// Single source of truth for which hub tools may run concurrently when one assistant message
// carries several calls. Every model path reads it: the Claude SDK path (MCP readOnlyHint), the
// gateway tool loop (OpenAI via gateway, Gemini, LM Studio/Ollama) and the Codex MCP bridge.
const CONCURRENCY_SAFE_TOOLS = new Set([
  'consult_agent',        // each consult is an independent turn on another agent; the hub queues if that agent is busy
  'spawn_workers',        // spawns independent ephemeral workers and shares no state with sibling calls
  'list_agents',          // pure read of the agent catalogue
  'read_memory',          // pure read
  'read_session_notes',   // pure read
  'read_shared_memory',   // pure read
  'search_shared_memory', // pure read
  'run_job',              // starts an independent detached job; returns at once
  'job_status',           // pure read of a job
  'job_cancel',           // acts on one named job; idempotent
  'list_jobs',            // pure read
  // The hub's hands (lib/hub-tools), as Claude Code treats its own: reads and searches in parallel, writers serial.
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
]);

function bareToolName(name) {
  return String(name || '').replace(/^mcp__.+?__/, '');
}

function isConcurrencySafe(name) {
  return CONCURRENCY_SAFE_TOOLS.has(bareToolName(name));
}

// Consecutive safe calls form one concurrent batch; each unsafe call is a batch of its own.
function planBatches(toolCalls, nameOf = (tc) => tc.function?.name ?? tc.name) {
  const batches = [];
  let open = null;
  for (const tc of toolCalls) {
    if (isConcurrencySafe(nameOf(tc))) {
      if (!open) { open = []; batches.push(open); }
      open.push(tc);
    } else {
      open = null;
      batches.push([tc]);
    }
  }
  return batches;
}

// Runs a message's tool calls under the shared concurrency rules.
// ctx.begin(tc)            optional; serial pre-step per call (UI events, confirmation). Returns undefined to
//                          proceed, or a string result to short-circuit (e.g. user denial).
// ctx.execute(tc)          runs the call, emits its own tool_result as it finishes, returns the result.
// ctx.finishDenied(tc, r)  optional; emits the tool_result for a short-circuited call.
// ctx.onResult(tc, result) called in ORIGINAL call order after each batch settles.
// ctx.isAborted()/ctx.abortError()  checked before every batch and before every begin.
// ctx.nameOf(tc)           optional name accessor.
// An abort or failure mid-batch lets in-flight calls settle, flushes the ones that succeeded, then throws.
async function executeToolCallsBatched(toolCalls, ctx) {
  const nameOf = ctx.nameOf || ((tc) => tc.function?.name ?? tc.name);
  const abort = () => { throw (ctx.abortError ? ctx.abortError() : new Error('Aborted')); };
  for (const batch of planBatches(toolCalls, nameOf)) {
    if (ctx.isAborted?.()) abort();
    const pre = new Array(batch.length);
    for (let i = 0; i < batch.length; i++) {
      if (ctx.isAborted?.()) abort();
      pre[i] = ctx.begin ? await ctx.begin(batch[i]) : undefined;
    }
    const settled = await Promise.allSettled(batch.map((tc, i) => (pre[i] !== undefined
      ? Promise.resolve(ctx.finishDenied ? ctx.finishDenied(tc, pre[i]) : undefined).then(() => pre[i])
      : ctx.execute(tc))));
    let failure = null;
    for (let i = 0; i < batch.length; i++) {
      if (settled[i].status === 'fulfilled') { if (!failure) await ctx.onResult(batch[i], settled[i].value); }
      else if (!failure) failure = settled[i];
    }
    if (failure) throw failure.reason;
  }
}

// Arrival-ordered gate for transports that deliver calls concurrently (the Codex MCP bridge): safe calls share
// the gate, an unsafe call waits for everything admitted before it and holds the gate alone, and calls that
// arrive behind it wait their turn. This reproduces the batch rule without a per-message batch to look at.
function createOrderedGate() {
  let readers = 0;
  let writer = false;
  const queue = [];
  const drain = () => {
    while (queue.length) {
      const head = queue[0];
      const ok = head.shared ? !writer : (!writer && readers === 0);
      if (!ok) return;
      queue.shift();
      if (head.shared) readers++; else writer = true;
      head.grant();
    }
  };
  return {
    async run(name, fn) {
      const shared = isConcurrencySafe(name);
      await new Promise((grant) => { queue.push({ shared, grant }); drain(); });
      try { return await fn(); }
      finally { if (shared) readers--; else writer = false; drain(); }
    },
  };
}

module.exports = { CONCURRENCY_SAFE_TOOLS, isConcurrencySafe, bareToolName, planBatches, executeToolCallsBatched, createOrderedGate };
