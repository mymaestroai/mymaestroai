'use strict';

/**
 * OpenAI-Compatible API Endpoints
 *
 * Provides /v1/chat/completions, /v1/models, /health for external consumers.
 * Routes queries through multi-provider LLM routing.
 */

const fs = require('fs');
const path = require('path');
const { chatCompletionStream, parseSSEStream, chatCompletion, listModels } = require('./gateway-client');

// ── Constants ───────────────────────────────────────────────────────────

const MAX_BODY_SIZE = parseInt(process.env.MAX_BODY_SIZE || String(50 * 1024 * 1024), 10);
const HEARTBEAT_INTERVAL_MS = 15000;

// ── Guarded Writers ─────────────────────────────────────────────────────

function sendSSE(res, data) {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch { return false; }
}

function safeWrite(res, chunk) {
  if (res.writableEnded || res.destroyed) return false;
  try { res.write(chunk); return true; } catch { return false; }
}

function safeEnd(res, data) {
  if (res.writableEnded || res.destroyed) return;
  try { res.end(data); } catch {}
}

function sendError(res, status, message) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message } }));
}

/** Text of an OpenAI message content: string, array of parts (text parts joined), or null/undefined -> ''. */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => (c && typeof c === 'object' ? c.text || '' : String(c ?? ''))).join('\n');
  return content == null ? '' : String(content);
}

// ── Tool Helpers ────────────────────────────────────────────────────────

function summarizeToolInput(toolName, input) {
  try {
    switch (toolName) {
      case 'Read': return input.file_path || '';
      case 'Write': return input.file_path || '';
      case 'Edit': return input.file_path || '';
      case 'Bash': return (input.command || '').substring(0, 120);
      case 'Grep': return `${input.pattern || ''}${input.path ? ' in ' + input.path : ''}`;
      case 'Glob': return `${input.pattern || ''}${input.path ? ' in ' + input.path : ''}`;
      default: return input.file_path || input.command || input.path || input.query || '';
    }
  } catch { return ''; }
}

// ── Body Reading ────────────────────────────────────────────────────────

function readBody(req, maxSize) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxSize) {
        reject(new Error(`Request body exceeds ${maxSize} bytes`));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

// ── Image Helpers ───────────────────────────────────────────────────────

async function convertToGatewayContent(content) {
  if (!Array.isArray(content)) {
    return [{ type: 'text', text: contentToText(content) }];
  }

  const blocks = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url') {
      blocks.push({
        type: 'image_url',
        image_url: part.image_url,
      });
    }
  }
  return blocks;
}

// ── /v1/chat/completions ────────────────────────────────────────────────

async function handleChatCompletion(req, res) {
  let body;
  try {
    body = await readBody(req, MAX_BODY_SIZE);
  } catch (err) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: err.message } }));
    return;
  }

  let heartbeatTimer = null;

  try {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      return sendError(res, 400, `Invalid JSON body: ${e.message}`);
    }
    const { model, messages, stream, max_tokens, temperature } = parsed || {};
    if (!Array.isArray(messages)) {
      return sendError(res, 400, '"messages" must be an array');
    }
    // `tools` / `tool_choice` are not supported by this bridge: they are ignored, never an error.
    const lastMsg = messages.filter(m => m && m.role === 'user').pop();
    const preview = typeof lastMsg?.content === 'string' ? lastMsg.content.slice(0, 80) : '(multipart)';
    console.log(`[bridge] Request: model=${model} stream=${!!stream} msgs=${messages.length} "${preview}"`);

    // Build conversation
    let systemPrompt = '';
    const conversationParts = [];

    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;
      if (msg.role === 'system') {
        systemPrompt += contentToText(msg.content) + '\n';
      } else if (msg.role === 'user') {
        const content = await convertToGatewayContent(msg.content ?? '');
        conversationParts.push({ role: 'user', content });
      } else if (msg.role === 'assistant') {
        // content is null on a tool_calls turn: render the calls as text so the model keeps the context.
        const calls = Array.isArray(msg.tool_calls)
          ? msg.tool_calls.map(tc => `[tool call ${tc.id || ''}] ${tc.function?.name || ''}(${tc.function?.arguments || ''})`)
          : [];
        const text = [contentToText(msg.content), ...calls].filter(Boolean).join('\n');
        if (text) conversationParts.push({ role: 'assistant', content: text });
      } else if (msg.role === 'tool') {
        // Fold tool results into the conversation as user text (the gateway has no tool-result role).
        const tag = msg.tool_call_id ? `[tool result ${msg.tool_call_id}]` : '[tool result]';
        conversationParts.push({ role: 'user', content: `${tag} ${contentToText(msg.content)}` });
      }
    }

    // Flatten user content for simple text messages
    const finalMessages = conversationParts.map(part => {
      if (part.role === 'user' && Array.isArray(part.content) && part.content.length === 1 && part.content[0].type === 'text') {
        return { role: 'user', content: part.content[0].text };
      }
      return part;
    });

    // Map model names
    const gatewayModel = model || 'claude-sonnet-4-6';

    // A client that disconnects mid-call aborts the gateway call; a normal completion (res already ended) does not.
    const abortController = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abortController.abort(); });

    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      heartbeatTimer = setInterval(() => safeWrite(res, ': heartbeat\n\n'), HEARTBEAT_INTERVAL_MS);

      const gatewayResponse = await chatCompletionStream(finalMessages, {
        model: gatewayModel,
        system: systemPrompt.trim() || undefined,
        max_tokens,
        temperature,
        signal: abortController.signal,
      });

      const id = `chatcmpl-${Date.now()}`;

      for await (const chunk of parseSSEStream(gatewayResponse)) {
        if (res.writableEnded || res.destroyed) break;

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        if (choice.delta?.content) {
          sendSSE(res, {
            id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: gatewayModel,
            choices: [{
              index: 0,
              delta: { content: choice.delta.content },
              finish_reason: null,
            }],
          });
        }

        if (choice.finish_reason) {
          sendSSE(res, {
            id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: gatewayModel,
            choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }],
          });
        }
      }

      safeWrite(res, 'data: [DONE]\n\n');
      clearInterval(heartbeatTimer);
      safeEnd(res);

    } else {
      // Non-streaming
      const result = await chatCompletion(finalMessages, {
        model: gatewayModel,
        system: systemPrompt.trim() || undefined,
        max_tokens,
        temperature,
        signal: abortController.signal,
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }
  } catch (error) {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    const message = (error && error.message) || String(error);   // non-Error throws still get a JSON reply

    if (error?.name === 'AbortError' || message.includes('aborted')) {
      console.log('[bridge] Request aborted (client disconnect or timeout)');
      safeEnd(res);
      return;
    }

    console.error('[bridge] Error:', message);

    if (!res.headersSent) {
      sendError(res, 500, message);
    } else {
      sendSSE(res, { error: { message, type: 'server_error' } });
      safeWrite(res, 'data: [DONE]\n\n');
      safeEnd(res);
    }
  }
}

// ── /v1/models ──────────────────────────────────────────────────────────

async function handleModels(req, res) {
  try {
    const models = await listModels();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: models.map(id => ({ id, object: 'model', owned_by: 'agent-hub' })),
    }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: e.message } }));
  }
}

// ── /health ─────────────────────────────────────────────────────────────

function handleHealth(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    gateway: 'multi-provider',
    version: '5.0.0',
  }));
}

// ── Exports ─────────────────────────────────────────────────────────────

module.exports = {
  handleChatCompletion,
  handleModels,
  handleHealth,
};
