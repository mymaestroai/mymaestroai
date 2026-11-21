'use strict';
// Output-token ceiling for one model call. Hosted models have a fixed per-model limit; a local model (LM Studio,
// ollama, oMLX, NInfer, the hub's own proxy) has no such limit, only its context window, so an agent that sets its own
// Max output tokens may go above the hosted table up to the room its window leaves after the prompt.
const contextBudget = require('./context-budget');

const LOCAL_PROMPT_MARGIN = 1024;

// Clamp to per-model output limit (Bedrock rejects over-limit requests)
function hostedOutputCap(m) {
  if (/claude-(?:fable|opus|sonnet|haiku)-5/i.test(m)) return 128000;   // the API's own limit for every Claude 5 model (its refusals say so, 2026-10-18)
  if (/haiku/i.test(m)) return 60000;
  if (/opus/i.test(m)) return 32000;
  if (/sonnet/i.test(m)) return 60000;
  if (/o3|gpt/i.test(m)) return 100000;
  if (/gemini/i.test(m)) return 60000;
  return 32000;
}

function effectiveOutputTokens({ model, maxTokens, explicit, window, promptTokens } = {}) {
  let cap = hostedOutputCap(model);
  let source = 'model';
  const ex = (explicit === null || explicit === undefined || explicit === '') ? NaN : Number(explicit);   // agents.json may hold it as text
  const win = typeof window === 'number' ? window : NaN;
  if (contextBudget.isLocal(model) && Number.isSafeInteger(ex) && ex > 0 && ex > cap && Number.isFinite(win) && win > 0) {
    let prompt = typeof promptTokens === 'function' ? promptTokens() : promptTokens;
    prompt = (typeof prompt === 'number' && Number.isFinite(prompt) && prompt >= 0) ? prompt : 0;
    const room = Math.floor(win - prompt - LOCAL_PROMPT_MARGIN);
    if (room > cap) { cap = room; source = 'local-window'; }
  }
  return { maxTokens: Math.min(Number(maxTokens), cap), cap, source };
}

module.exports = { hostedOutputCap, effectiveOutputTokens, LOCAL_PROMPT_MARGIN };
