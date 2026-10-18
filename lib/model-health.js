'use strict';
/**
 * Model health: what this hub has seen each model do. A real reply or a model test that fails for a reason that
 * belongs to the model or to its provider account (blocked by the privacy setting, can't use tools, gone, key
 * refused, out of credit, local server not running…) marks the model; the next success clears the mark. Passing
 * trouble (rate limits, busy servers, the network) and trouble that belongs to one conversation (too long,
 * moderation) leaves the record as it was. The pickers show the mark, and a model that has answered here before
 * needs no test before an agent is switched to it. One small file, data/model-health.json:
 *   { [model]: { state: 'ok'|'warn'|'fail', kind, short, what, fix, at, okAt, source } }
 *
 *   record(model, { ok, kind, what, fix, source })
 *   view() -> that map (for /api/models)
 *   test(model, opts) -> { ok, toolCall, ms, costUsd, kind, title, what, fix, detail }: one tiny request through the
 *     same route an agent's reply takes (lib/gateway-client: key, address, privacy routing) with one tool to call.
 *     A fraction of a cent on paid models, nothing when the provider refuses. The answer is kept for 10 minutes.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'model-health.json');
// The kinds that mark a model, with the few words the pickers show (kinds from lib/error-help).
const MARK = {
  privacy: 'blocked by the privacy setting', no_tools: "can't use tools", not_found: 'not available',
  forbidden: 'not allowed for this key', verification: 'needs a verified organization', key_limit: 'key limit reached',
  credit: 'out of credit', auth: 'key refused', local_down: 'server not running', no_tool_call: "didn't use the test tool",
};
const UNTESTED = /^(claude-sdk|codex-cli|codex)\//;   // subscription routes: their limits are the plan's, not per request
const MAX_ENTRIES = 500;
const TEST_TTL_MS = 10 * 60 * 1000;
const PING = { type: 'function', function: { name: 'ping', description: 'Answer the connection test.', parameters: { type: 'object', properties: { x: { type: 'integer' } }, required: ['x'] } } };

function createModelHealth({ file = FILE, now = Date.now } = {}) {
  let mem = null;
  const tests = new Map();   // model -> { at, result }

  function load() {
    if (mem) return mem;
    try { mem = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { mem = {}; }
    if (!mem || typeof mem !== 'object' || Array.isArray(mem)) mem = {};
    return mem;
  }
  function save() {
    try {
      const keys = Object.keys(mem);
      if (keys.length > MAX_ENTRIES) keys.sort((a, b) => String(mem[a].at).localeCompare(String(mem[b].at))).slice(0, keys.length - MAX_ENTRIES).forEach(k => delete mem[k]);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(mem, null, 1), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) { console.error('[model-health] could not save:', e.message); }
  }

  function record(model, r = {}) {
    const id = String(model || '').trim();
    if (!id) return null;
    const m = load(); const at = new Date(now()).toISOString(); const cur = m[id] || null;
    if (r.ok) { m[id] = { state: 'ok', at, okAt: at, source: r.source || 'reply' }; save(); return m[id]; }
    if (!MARK[r.kind]) return cur;   // passing, or about one conversation: the record stays as it was
    m[id] = {
      state: r.kind === 'no_tool_call' ? 'warn' : 'fail', kind: r.kind, short: MARK[r.kind],
      what: String(r.what || '').slice(0, 300), fix: String(r.fix || '').slice(0, 400), at,
      ...(cur && cur.okAt ? { okAt: cur.okAt } : {}), source: r.source || 'reply',
    };
    save(); return m[id];
  }

  function view() { return { ...load() }; }

  async function test(model, { gateway = require('./gateway-client'), errorHelp = require('./error-help'), ledger = null, timeoutMs = 60000, force = false } = {}) {
    const id = String(model || '').trim();
    if (!id.includes('/')) return { ok: false, kind: 'error', what: 'No model given.' };
    if (UNTESTED.test(id)) return { ok: true, skipped: true, toolCall: null };
    const hit = tests.get(id);
    if (!force && hit && now() - hit.at < TEST_TTL_MS) return { ...hit.result, cached: true };
    const name = errorHelp.nameOf(id);
    const started = now(); const ctl = new AbortController(); let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
    let result; let usage = null;
    try {
      const response = await gateway.chatCompletionStream(
        [{ role: 'user', content: 'This is a connection test from My Maestro AI. Call the ping tool with x set to 1, and write nothing else.' }],
        { model: id, system: 'You are being tested by the hub you run in. When asked, call the ping tool.', tools: [PING], max_tokens: 400, noRetries: true, signal: ctl.signal, agent: 'model-test' });
      let toolCall = false;
      for await (const chunk of gateway.parseSSEStream(response, {})) {
        if (chunk && chunk.usage && typeof chunk.usage === 'object') usage = chunk.usage;
        const ch = chunk && Array.isArray(chunk.choices) ? chunk.choices[0] : null;
        const d = ch && (ch.delta || ch.message);
        if (d && Array.isArray(d.tool_calls) && d.tool_calls.some(tc => tc && tc.function && tc.function.name === 'ping')) toolCall = true;
      }
      const ms = now() - started;
      const costUsd = usage && typeof usage.cost === 'number' ? usage.cost : null;
      result = toolCall
        ? { ok: true, toolCall: true, ms, costUsd }
        : { ok: true, toolCall: false, ms, costUsd, kind: 'no_tool_call', title: `${name} answered but didn't call the test tool.`,
          what: 'It may not manage the hub\'s tools (reading files, running commands, searching), which agents here rely on.',
          fix: 'Switch anyway to try it in a chat, or pick a model that does tool calling.' };
    } catch (e) {
      const ms = now() - started;
      if (timedOut) {
        result = { ok: false, ms, kind: 'timeout', title: `${name} didn't answer the test.`, what: `No answer within ${Math.round(timeoutMs / 1000)} seconds.`,
          fix: 'Free and busy models can be slow. Try again later, or pick another model.', detail: 'Test timed out' };
      } else {
        const x = errorHelp.explain(e, { model: id });
        result = { ok: false, ms, kind: x.kind, title: x.title, what: x.what, fix: x.fix, detail: x.detail };
      }
    } finally { clearTimeout(timer); }
    record(id, result.ok && result.toolCall ? { ok: true, source: 'test' } : { ok: false, kind: result.kind, what: result.what, fix: result.fix, source: 'test' });
    if (ledger) {
      try {
        ledger.record({ agent: 'model-test', origin: 'model-test', model: id, durationMs: result.ms, ok: result.ok,
          ...(usage ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens } : {}),
          ...(result.costUsd != null ? { costUsd: result.costUsd } : {}) });
      } catch { /* the ledger is optional here */ }
    }
    tests.set(id, { at: now(), result });
    return result;
  }

  return { record, view, test, _reset: () => { mem = null; tests.clear(); } };
}

let instance = null;
function getModelHealth() { return instance || (instance = createModelHealth()); }

module.exports = { createModelHealth, getModelHealth, MARK };
