'use strict';

/**
 * mythos-client.js — Direct Anthropic API client for Claude Mythos
 *
 * This client bypasses the LLM Gateway and calls Anthropic's
 * Messages API directly using a dedicated API key. It is ONLY used for
 * Mythos model access (Project Glasswing).
 *
 * Returns responses in OpenAI-compatible streaming format so it integrates
 * seamlessly with the existing parseSSEStream pipeline in sdk-chat.js.
 *
 * RATE LIMITING: Org limit is 3,000,000 input tokens/min. This client
 * tracks usage and delays requests to stay under budget.
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MYTHOS_MODEL = 'claude-mythos-preview';

// ─── Rate Limiter ───────────────────────────────────────────────────────────
const RATE_LIMIT_TOKENS_PER_MIN = 3_000_000;
const RATE_LIMIT_SAFETY_MARGIN = 0.85; // Use at most 85% of budget to leave headroom
const RATE_LIMIT_BUDGET = Math.floor(RATE_LIMIT_TOKENS_PER_MIN * RATE_LIMIT_SAFETY_MARGIN);
const MIN_DELAY_BETWEEN_CALLS_MS = 10000; // Minimum 10s between Mythos calls (3M/min budget is tight)

// Sliding window of recent requests: [{timestamp, tokens}]
const requestLog = [];
let lastCallTime = 0;

/**
 * Estimate input token count from a request body.
 * ~4 chars per token is a rough approximation; system + messages + tools.
 */
function estimateInputTokens(body) {
  let chars = 0;
  if (body.system) chars += (typeof body.system === 'string' ? body.system.length : JSON.stringify(body.system).length);
  if (body.messages) chars += JSON.stringify(body.messages).length;
  if (body.tools) chars += JSON.stringify(body.tools).length;
  return Math.ceil(chars / 3.5); // Slightly conservative (3.5 chars/token)
}

/**
 * Get current token usage in the last 60 seconds.
 */
function getRecentUsage() {
  const cutoff = Date.now() - 60_000;
  // Prune old entries
  while (requestLog.length > 0 && requestLog[0].timestamp < cutoff) {
    requestLog.shift();
  }
  return requestLog.reduce((sum, r) => sum + r.tokens, 0);
}

/**
 * Wait until there's enough budget to send a request with the given token count.
 * Returns the number of ms waited.
 */
async function waitForBudget(estimatedTokens) {
  // Enforce minimum gap between calls
  const timeSinceLast = Date.now() - lastCallTime;
  if (timeSinceLast < MIN_DELAY_BETWEEN_CALLS_MS) {
    const gap = MIN_DELAY_BETWEEN_CALLS_MS - timeSinceLast;
    console.log(`[mythos-rate] Enforcing ${gap}ms minimum gap between calls`);
    await new Promise(r => setTimeout(r, gap));
  }

  let waited = 0;
  while (true) {
    const currentUsage = getRecentUsage();
    const available = RATE_LIMIT_BUDGET - currentUsage;

    if (available >= estimatedTokens) {
      if (waited > 0) {
        console.log(`[mythos-rate] Budget available after ${waited}ms wait (used ${currentUsage.toLocaleString()}/${RATE_LIMIT_BUDGET.toLocaleString()} tokens in window)`);
      }
      return waited;
    }

    // Calculate how long until enough budget frees up
    // Find the oldest entry that, once it drops out of the window, gives us enough
    const needed = estimatedTokens - available;
    let freedSoFar = 0;
    let waitUntil = Date.now() + 5000; // Default 5s wait

    for (const entry of requestLog) {
      freedSoFar += entry.tokens;
      if (freedSoFar >= needed) {
        waitUntil = entry.timestamp + 60_000 + 500; // 500ms buffer
        break;
      }
    }

    const delay = Math.max(1000, Math.min(waitUntil - Date.now(), 30000)); // 1s-30s
    console.log(`[mythos-rate] Budget exhausted (${currentUsage.toLocaleString()}/${RATE_LIMIT_BUDGET.toLocaleString()} tokens). Need ${estimatedTokens.toLocaleString()} more. Waiting ${Math.ceil(delay/1000)}s...`);
    await new Promise(r => setTimeout(r, delay));
    waited += delay;
  }
}

/**
 * Record that a request consumed tokens.
 */
function recordUsage(tokens) {
  requestLog.push({ timestamp: Date.now(), tokens });
  lastCallTime = Date.now();
}

function getAnthropicHeaders() {
  const key = process.env.ANTHROPIC_MYTHOS_API_KEY;
  if (!key) throw new Error('ANTHROPIC_MYTHOS_API_KEY not set in .env');
  return {
    'Content-Type': 'application/json',
    'x-api-key': key,
    'anthropic-version': ANTHROPIC_VERSION,
  };
}

/**
 * Convert OpenAI-format messages to Anthropic Messages API format.
 * Extracts system message, converts tool_calls/tool results.
 */
function convertMessages(messages, systemPrompt) {
  let system = systemPrompt || '';
  const anthropicMessages = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      // Append system messages to the system prompt
      system += (system ? '\n\n' : '') + (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
      continue;
    }

    if (msg.role === 'user') {
      // Handle string or structured content (images, etc.)
      if (typeof msg.content === 'string') {
        anthropicMessages.push({ role: 'user', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        // Convert OpenAI image_url format to Anthropic format
        const parts = msg.content.map(part => {
          if (part.type === 'text') return { type: 'text', text: part.text };
          if (part.type === 'image_url' && part.image_url?.url) {
            const url = part.image_url.url;
            if (url.startsWith('data:')) {
              const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
              if (match) {
                return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
              }
            }
            return { type: 'image', source: { type: 'url', url } };
          }
          return { type: 'text', text: JSON.stringify(part) };
        });
        anthropicMessages.push({ role: 'user', content: parts });
      } else {
        anthropicMessages.push({ role: 'user', content: String(msg.content) });
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const content = [];
      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function?.name || tc.name,
            input: typeof tc.function?.arguments === 'string'
              ? (() => { try { return JSON.parse(tc.function.arguments); } catch { return { _raw: tc.function.arguments }; } })()
              : (tc.function?.arguments || {}),
          });
        }
      }
      if (content.length > 0) {
        anthropicMessages.push({ role: 'assistant', content });
      }
      continue;
    }

    if (msg.role === 'tool') {
      // Anthropic expects tool results as user messages with tool_result content blocks
      anthropicMessages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        }],
      });
      continue;
    }
  }

  return { system, messages: anthropicMessages };
}

/**
 * Convert OpenAI tool definitions to Anthropic format.
 */
function convertTools(openaiTools) {
  if (!openaiTools || openaiTools.length === 0) return undefined;
  return openaiTools.map(t => ({
    name: t.function.name,
    description: t.function.description || '',
    input_schema: t.function.parameters || { type: 'object', properties: {} },
  }));
}

/**
 * Stream a Mythos completion. Returns a Response-like object with a readable
 * body that emits OpenAI-compatible SSE chunks.
 *
 * This matches the interface of chatCompletionStream from gateway-client.js.
 */
async function mythosCompletionStream(messages, options = {}) {
  const { model, system, tools, signal, max_tokens = 128000 } = options;

  const converted = convertMessages(messages, system);
  const anthropicTools = convertTools(tools);

  const body = {
    model: MYTHOS_MODEL,
    max_tokens,
    stream: true,
    messages: converted.messages,
  };
  if (converted.system) body.system = converted.system;
  if (anthropicTools && anthropicTools.length > 0) body.tools = anthropicTools;

  // Rate limiting: estimate tokens and wait for budget
  const estimatedTokens = estimateInputTokens(body);
  console.log(`[mythos-rate] Streaming request: ~${estimatedTokens.toLocaleString()} estimated input tokens`);
  await waitForBudget(estimatedTokens);

  // Retry loop for 429 rate limits
  const MAX_RETRIES = 5;
  let response;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error('Request aborted');

    response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: getAnthropicHeaders(),
      body: JSON.stringify(body),
      signal,
    });

    if (response.status === 429) {
      const text = await response.text();
      // Parse retry-after header if available
      const retryAfter = response.headers.get('retry-after');
      const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : Math.min(30000 * Math.pow(2, attempt), 120000);
      console.log(`[mythos-rate] 429 rate limited (attempt ${attempt + 1}/${MAX_RETRIES + 1}). Waiting ${Math.round(waitMs / 1000)}s before retry...`);
      
      if (attempt === MAX_RETRIES) {
        recordUsage(estimatedTokens);
        throw new Error(`Anthropic Mythos 429 (rate limited after ${MAX_RETRIES + 1} attempts): ${text.slice(0, 300)}`);
      }
      
      // Wait then retry
      await new Promise(r => setTimeout(r, waitMs));
      // Also wait for budget to clear
      await waitForBudget(estimatedTokens);
      continue;
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Anthropic Mythos ${response.status}: ${text.slice(0, 500)}`);
    }

    // Success - break out of retry loop
    break;
  }

  // Record actual usage (use estimate since we don't get exact input count before stream ends)
  recordUsage(estimatedTokens);

  // Return a transformed stream that converts Anthropic SSE → OpenAI SSE format
  const transformedStream = transformAnthropicToOpenAI(response.body);
  return { body: transformedStream, ok: true, status: 200 };
}

/**
 * Transform Anthropic SSE stream to OpenAI-compatible SSE format.
 * Anthropic events: message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop
 * OpenAI format: data: {"choices":[{"delta":{"content":"..."}}]}
 */
function transformAnthropicToOpenAI(inputStream) {
  const reader = inputStream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buffer = '';
  let toolCallIndex = -1;
  let currentToolId = '';
  let currentToolName = '';

  const readable = new ReadableStream({
    async pull(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // Send [DONE]
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
            return;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          let enqueued = false;
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (!data || data === '[DONE]') continue;

            let event;
            try { event = JSON.parse(data); } catch { continue; }

            const openaiChunks = convertAnthropicEvent(event);
            for (const chunk of openaiChunks) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              enqueued = true;
            }
          }

          // Only return to consumer when we've enqueued data; otherwise keep reading
          if (enqueued) return;
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      reader.cancel();
    },
  });

  // State tracking for conversion
  let inThinkingBlock = false;

  function convertAnthropicEvent(event) {
    const chunks = [];
    const type = event.type;

    if (type === 'content_block_start') {
      const block = event.content_block;
      if (block.type === 'thinking') {
        // Skip thinking blocks entirely (extended thinking / signatures)
        inThinkingBlock = true;
      } else if (block.type === 'tool_use') {
        inThinkingBlock = false;
        toolCallIndex++;
        currentToolId = block.id;
        currentToolName = block.name;
        chunks.push({
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: toolCallIndex,
                id: block.id,
                type: 'function',
                function: { name: block.name, arguments: '' },
              }],
            },
          }],
        });
      } else {
        // text block
        inThinkingBlock = false;
      }
    } else if (type === 'content_block_delta') {
      if (inThinkingBlock) return chunks; // skip thinking/signature deltas
      const delta = event.delta;
      if (delta.type === 'text_delta') {
        chunks.push({
          choices: [{
            index: 0,
            delta: { content: delta.text },
          }],
        });
      } else if (delta.type === 'input_json_delta') {
        chunks.push({
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: toolCallIndex,
                function: { arguments: delta.partial_json },
              }],
            },
          }],
        });
      }
      // Skip signature_delta, thinking_delta — they're part of thinking blocks
    } else if (type === 'content_block_stop') {
      inThinkingBlock = false;
    } else if (type === 'message_delta') {
      // Contains stop_reason, usage — emit finish_reason
      if (event.delta?.stop_reason) {
        const reason = event.delta.stop_reason;
        const finishReason = reason === 'tool_use' ? 'tool_calls' : 'stop';
        chunks.push({
          choices: [{
            index: 0,
            delta: {},
            finish_reason: finishReason,
          }],
        });
      }
    } else if (type === 'message_stop') {
      // Don't emit duplicate — message_delta already sent finish_reason
    }
    // Skip: ping, message_start

    return chunks;
  }

  return readable;
}

/**
 * Non-streaming completion for Mythos (used by auto-model classifier if needed).
 */
async function mythosCompletion(messages, options = {}) {
  const { system, tools, signal, max_tokens = 64000 } = options;

  const converted = convertMessages(messages, system);
  const anthropicTools = convertTools(tools);

  const body = {
    model: MYTHOS_MODEL,
    max_tokens,
    stream: false,
    messages: converted.messages,
  };
  if (converted.system) body.system = converted.system;
  if (anthropicTools && anthropicTools.length > 0) body.tools = anthropicTools;

  // Rate limiting: estimate tokens and wait for budget
  const estimatedTokens = estimateInputTokens(body);
  console.log(`[mythos-rate] Non-streaming request: ~${estimatedTokens.toLocaleString()} estimated input tokens`);
  await waitForBudget(estimatedTokens);

  // Retry loop for 429 rate limits
  const MAX_RETRIES = 5;
  let response;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error('Request aborted');

    response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: getAnthropicHeaders(),
      body: JSON.stringify(body),
      signal,
    });

    if (response.status === 429) {
      const text = await response.text();
      const retryAfter = response.headers.get('retry-after');
      const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : Math.min(30000 * Math.pow(2, attempt), 120000);
      console.log(`[mythos-rate] 429 rate limited (attempt ${attempt + 1}/${MAX_RETRIES + 1}). Waiting ${Math.round(waitMs / 1000)}s before retry...`);
      
      if (attempt === MAX_RETRIES) {
        recordUsage(estimatedTokens);
        throw new Error(`Anthropic Mythos 429 (rate limited after ${MAX_RETRIES + 1} attempts): ${text.slice(0, 300)}`);
      }
      
      await new Promise(r => setTimeout(r, waitMs));
      await waitForBudget(estimatedTokens);
      continue;
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Anthropic Mythos ${response.status}: ${text.slice(0, 500)}`);
    }

    break;
  }

  const result = await response.json();

  // Record actual usage from response if available, else use estimate
  const actualInputTokens = result.usage?.input_tokens || estimatedTokens;
  recordUsage(actualInputTokens);
  if (result.usage?.input_tokens) {
    console.log(`[mythos-rate] Actual input tokens: ${actualInputTokens.toLocaleString()} (estimated: ${estimatedTokens.toLocaleString()})`);
  }

  // Convert Anthropic response to OpenAI format
  const content = result.content || [];
  let text = '';
  const toolCalls = [];

  for (const block of content) {
    if (block.type === 'text') text += block.text;
    else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      });
    }
    // Skip 'thinking' blocks — extended thinking / signatures
  }

  const stopReason = result.stop_reason;
  const finishReason = stopReason === 'tool_use' ? 'tool_calls' : 'stop';

  return {
    choices: [{
      message: {
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: finishReason,
    }],
    usage: result.usage ? {
      prompt_tokens: result.usage.input_tokens,
      completion_tokens: result.usage.output_tokens,
      total_tokens: (result.usage.input_tokens || 0) + (result.usage.output_tokens || 0),
    } : undefined,
  };
}

/**
 * Check if a model name is a Mythos model that should route through this client.
 */
function isMythosModel(model) {
  return model === 'claude-mythos-preview' || (model || '').startsWith('claude-mythos');
}

/**
 * Get current rate limiter status (for diagnostics/logging).
 */
function getMythosRateStatus() {
  const currentUsage = getRecentUsage();
  return {
    tokensUsedInWindow: currentUsage,
    budgetRemaining: RATE_LIMIT_BUDGET - currentUsage,
    budgetTotal: RATE_LIMIT_BUDGET,
    requestsInWindow: requestLog.length,
    lastCallTime: lastCallTime ? new Date(lastCallTime).toISOString() : null,
  };
}

module.exports = {
  mythosCompletionStream,
  mythosCompletion,
  isMythosModel,
  getMythosRateStatus,
  MYTHOS_MODEL,
};
