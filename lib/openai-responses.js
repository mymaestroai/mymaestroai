'use strict';

/**
 * openai-responses.js - Chat-Completions <-> Responses API adapter.
 *
 * Used ONLY on the direct-OpenAI (OPENAI_CYBER) path.  The Hub speaks the
 * chat-completions dialect everywhere (sdk-chat tool loop, parseSSEStream,
 * telemetry).  api.openai.com, however:
 *   - refuses function tools on /v1/chat/completions for gateway-example,
 *     gpt-5.6-*, gpt-daybreak-* unless reasoning is disabled (and astra has
 *     no "off" setting), and
 *   - serves gpt-5.6-cyber, gpt-daybreak-red, *-pro and *-codex ONLY on
 *     /v1/responses.
 * Verified live 2026-09-08.  So every direct-key request is translated to
 * the Responses API on the way out and back to chat-completions shape on
 * the way in.  Callers never see the difference.
 *
 *   toResponsesBody(chatBody)        -> Responses request body
 *   fromResponsesJSON(json)          -> chat.completion object
 *   wrapResponsesStream(response)    -> Response whose body is chat-completions SSE
 */

// ── Request translation ─────────────────────────────────────────────────

function contentToInput(content, role) {
  if (content == null) return [];
  if (typeof content === 'string') {
    return [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: content }];
  }
  const out = [];
  for (const part of content) {
    if (!part) continue;
    if (part.type === 'text') {
      out.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text || '' });
    } else if (part.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      if (url) out.push({ type: 'input_image', image_url: url, detail: part.image_url?.detail || 'auto' });
    }
  }
  return out;
}

function toolsToResponses(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools.map(t => {
    if (t.type === 'function' && t.function) {
      return {
        type: 'function',
        name: t.function.name,
        description: t.function.description || '',
        parameters: t.function.parameters || { type: 'object', properties: {} },
      };
    }
    return t;
  });
}

function toolChoiceToResponses(tc) {
  if (!tc) return undefined;
  if (typeof tc === 'string') return tc; // auto | none | required
  if (tc.type === 'function' && tc.function?.name) return { type: 'function', name: tc.function.name };
  return undefined;
}

function toResponsesBody(body) {
  const out = {
    model: body.model,
    store: false,
    input: [],
  };

  const systemParts = [];
  for (const m of body.messages || []) {
    if (m.role === 'system' || m.role === 'developer') {
      systemParts.push(typeof m.content === 'string'
        ? m.content
        : (m.content || []).map(p => p.text || '').join('\n'));
      continue;
    }
    if (m.role === 'tool') {
      out.input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id,
        output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      });
      continue;
    }
    if (m.role === 'assistant') {
      const parts = contentToInput(m.content, 'assistant');
      if (parts.length) out.input.push({ role: 'assistant', content: parts });
      for (const tc of m.tool_calls || []) {
        out.input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.function?.name,
          arguments: tc.function?.arguments || '{}',
        });
      }
      continue;
    }
    // user
    const parts = contentToInput(m.content, 'user');
    if (parts.length) out.input.push({ role: 'user', content: parts });
  }
  if (systemParts.length) out.instructions = systemParts.join('\n\n');

  const tools = toolsToResponses(body.tools);
  if (tools && tools.length) out.tools = tools;
  const tc = toolChoiceToResponses(body.tool_choice);
  if (tc) out.tool_choice = tc;
  if (body.parallel_tool_calls !== undefined) out.parallel_tool_calls = body.parallel_tool_calls;

  // Responses API rejects max_output_tokens < 16, and reasoning models burn
  // hidden tokens before any visible output - a tiny budget yields status
  // "incomplete" with empty text.  Floor at 512 (same reasoning floor used
  // for gemini/sonnet-5 in model-quirks).
  const maxOut = body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens;
  if (maxOut !== undefined) out.max_output_tokens = Math.max(512, maxOut);
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.reasoning_effort) out.reasoning = { effort: body.reasoning_effort, summary: 'auto' };
  else out.reasoning = { summary: 'auto' };
  if (body.stream) out.stream = true;
  if (body.prompt_cache_key) out.prompt_cache_key = body.prompt_cache_key;
  return out;
}

// ── Response translation ────────────────────────────────────────────────

function usageFromResponses(u) {
  if (!u) return undefined;
  return {
    prompt_tokens: u.input_tokens || 0,
    completion_tokens: u.output_tokens || 0,
    total_tokens: u.total_tokens || ((u.input_tokens || 0) + (u.output_tokens || 0)),
    prompt_tokens_details: { cached_tokens: u.input_tokens_details?.cached_tokens || 0 },
    completion_tokens_details: { reasoning_tokens: u.output_tokens_details?.reasoning_tokens || 0 },
    cache_read_tokens: u.input_tokens_details?.cached_tokens || 0,
  };
}

function finishReasonFor(resp, hadToolCalls) {
  if (resp.status === 'incomplete') {
    const why = resp.incomplete_details?.reason;
    if (why === 'max_output_tokens') return 'length';
    if (why === 'content_filter') return 'content_filter';
    return 'stop';
  }
  return hadToolCalls ? 'tool_calls' : 'stop';
}

function fromResponsesJSON(resp) {
  let text = '';
  let refusal = null;
  const toolCalls = [];
  for (const item of resp.output || []) {
    if (item.type === 'message') {
      for (const c of item.content || []) {
        if (c.type === 'output_text') text += c.text || '';
        else if (c.type === 'refusal') refusal = (refusal || '') + (c.refusal || '');
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id,
        type: 'function',
        function: { name: item.name, arguments: item.arguments || '{}' },
      });
    }
  }
  const message = { role: 'assistant', content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  if (refusal) message.refusal = refusal;
  return {
    id: resp.id,
    object: 'chat.completion',
    created: resp.created_at,
    model: resp.model,
    choices: [{ index: 0, message, finish_reason: refusal ? 'content_filter' : finishReasonFor(resp, toolCalls.length > 0) }],
    usage: usageFromResponses(resp.usage),
  };
}

// ── Streaming translation ───────────────────────────────────────────────
// Consumes Responses SSE and produces chat-completions SSE so the existing
// parseSSEStream() / sdk-chat tool loop work unchanged.

function chatChunk(id, model, delta, finish_reason = null, extra = {}) {
  return {
    id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason }],
    ...extra,
  };
}

function wrapResponsesStream(upstream, model) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const reader = upstream.body.getReader();
  let buffer = '';
  let respId = 'resp';
  let respModel = model;
  const fcIndex = new Map();   // item_id -> chat tool_call index
  let nextIdx = 0;
  let sawToolCall = false;
  let finished = false;

  const stream = new ReadableStream({
    async pull(controller) {
      const send = (obj) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const finish = (finish_reason, usage) => {
        if (finished) return;
        finished = true;
        send(chatChunk(respId, respModel, {}, finish_reason));
        if (usage) send({ id: respId, object: 'chat.completion.chunk', model: respModel, choices: [], usage });
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (!finished) finish(sawToolCall ? 'tool_calls' : 'stop');
          return;
        }
        buffer += dec.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        let emitted = false;
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let ev;
          try { ev = JSON.parse(line.slice(6)); } catch { continue; }
          const t = ev.type;

          if (t === 'response.created') {
            respId = ev.response?.id || respId;
            respModel = ev.response?.model || respModel;
            send(chatChunk(respId, respModel, { role: 'assistant', content: '' }));
            emitted = true;
          } else if (t === 'response.output_text.delta') {
            send(chatChunk(respId, respModel, { content: ev.delta || '' }));
            emitted = true;
          } else if (t === 'response.reasoning_summary_text.delta' || t === 'response.reasoning_text.delta') {
            send(chatChunk(respId, respModel, { reasoning_content: ev.delta || '' }));
            emitted = true;
          } else if (t === 'response.refusal.delta') {
            send(chatChunk(respId, respModel, { refusal: ev.delta || '' }));
            emitted = true;
          } else if (t === 'response.output_item.added' && ev.item?.type === 'function_call') {
            const idx = nextIdx++;
            fcIndex.set(ev.item.id, idx);
            sawToolCall = true;
            send(chatChunk(respId, respModel, {
              tool_calls: [{ index: idx, id: ev.item.call_id, type: 'function', function: { name: ev.item.name, arguments: '' } }],
            }));
            emitted = true;
          } else if (t === 'response.function_call_arguments.delta') {
            const idx = fcIndex.get(ev.item_id);
            if (idx !== undefined) {
              send(chatChunk(respId, respModel, { tool_calls: [{ index: idx, function: { arguments: ev.delta || '' } }] }));
              emitted = true;
            }
          } else if (t === 'response.completed' || t === 'response.incomplete') {
            const r = ev.response || {};
            const refused = (r.output || []).some(o => o.type === 'message' && (o.content || []).some(c => c.type === 'refusal'));
            finish(refused ? 'content_filter' : finishReasonFor(r, sawToolCall), usageFromResponses(r.usage));
            return;
          } else if (t === 'response.failed' || t === 'error') {
            const msg = ev.response?.error?.message || ev.error?.message || ev.message || 'Responses API stream failed';
            try { await reader.cancel(); } catch (_) { /* ignore */ }
            controller.error(new Error(`OpenAI responses: ${msg}`));
            return;
          }
        }
        if (emitted) return; // yield to consumer; pull() will be called again
      }
    },
    async cancel() {
      try { await reader.cancel(); } catch (_) { /* ignore */ }
    },
  });

  const wrapped = new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
  return wrapped;
}

module.exports = { toResponsesBody, fromResponsesJSON, wrapResponsesStream };
