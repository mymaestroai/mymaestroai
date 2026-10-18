'use strict';
const { preserve } = require('../tiger-team-artifacts');

/**
 * mcp-streamable-http.js — MCP Streamable HTTP transport client
 *
 * Connects to MCP servers using the Streamable HTTP transport.
 * Handles JSON-RPC over HTTP POST with optional SSE streaming.
 * Supports session management (Mcp-Session-Id header).
 * Used by hosted MCP services that support HTTP transport.
 */

const https = require('https');
const http = require('http');

// Session ID cache: keyed by base URL
const sessionIds = new Map();

/**
 * Send a JSON-RPC request to an MCP server via Streamable HTTP.
 * @param {string} url - The MCP endpoint URL
 * @param {string} method - JSON-RPC method name
 * @param {object} params - Method parameters
 * @param {object} options - { headers, timeout }
 * @returns {Promise<object>} JSON-RPC result
 */
async function mcpRequest(url, method, params = {}, options = {}) {
  const { headers = {}, timeout = 30000 } = options;

  const body = JSON.stringify({
    jsonrpc: '2.0',
    method,
    params,
    id: Date.now(),
  });

  const parsedUrl = new URL(url);
  const transport = parsedUrl.protocol === 'https:' ? https : http;

  // Add session ID if we have one for this URL
  const sessionId = sessionIds.get(url);
  const reqHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  };
  if (sessionId) {
    reqHeaders['Mcp-Session-Id'] = sessionId;
  }

  const isInternalHost = false;

  return new Promise((resolve, reject) => {
    const req = transport.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: reqHeaders,
      timeout,
      ...(isInternalHost ? { rejectUnauthorized: false } : {}),
    }, (res) => {
      // Capture session ID from response
      const newSessionId = res.headers['mcp-session-id'];
      if (newSessionId) {
        sessionIds.set(url, newSessionId);
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          // Handle SSE responses (some MCP servers stream)
          if (res.headers['content-type']?.includes('text/event-stream')) {
            // Parse SSE — extract data lines
            const lines = data.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const jsonStr = line.slice(6).trim();
                if (jsonStr && jsonStr !== '[DONE]') {
                  try {
                    const parsed = JSON.parse(jsonStr);
                    if (parsed.result || parsed.error) {
                      if (parsed.error) {
                        reject(new Error(`MCP error: ${parsed.error.message || JSON.stringify(parsed.error)}`));
                      } else {
                        resolve(parsed.result);
                      }
                      return;
                    }
                  } catch {}
                }
              }
            }
            reject(new Error('No valid JSON-RPC response in SSE stream'));
            return;
          }

          // Standard JSON response
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(`MCP error: ${parsed.error.message || JSON.stringify(parsed.error)}`));
          } else {
            resolve(parsed.result);
          }
        } catch (e) {
          reject(new Error(`Failed to parse MCP response: ${e.message}\nBody: ${data.slice(0, 500)}`));
        }
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`MCP request timed out after ${timeout}ms`));
    });

    req.write(body);
    req.end();
  });
}

/**
 * Initialize an MCP session and discover tools.
 * @param {string} url - The MCP endpoint URL
 * @param {object} options - { headers, timeout }
 * @returns {Promise<object>} { serverInfo, tools }
 */
async function initializeAndListTools(url, options = {}) {
  // Clear any stale session for this URL
  sessionIds.delete(url);

  // Initialize the MCP session
  const initResult = await mcpRequest(url, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'agent-hub', version: require('../../package.json').version },
  }, options);

  // Send initialized notification (no response expected, but best practice)
  try {
    await mcpRequest(url, 'notifications/initialized', {}, options);
  } catch {
    // Notifications may not return a response — that's fine
  }

  // List available tools
  const toolsResult = await mcpRequest(url, 'tools/list', {}, options);

  return {
    serverInfo: initResult?.serverInfo || {},
    tools: toolsResult?.tools || [],
  };
}

/**
 * Call an MCP tool.
 * @param {string} url - The MCP endpoint URL
 * @param {string} toolName - Name of the tool to call
 * @param {object} args - Tool arguments
 * @param {object} options - { headers, timeout }
 * @returns {Promise<string>} Tool result as string
 */
async function callTool(url, toolName, args = {}, options = {}) {
  const result = await mcpRequest(url, 'tools/call', {
    name: toolName,
    arguments: args,
  }, { ...options, timeout: options.timeout || 60000 });

  preserve(result, `mcp-http:${toolName}:raw`);

  // MCP tool results are { content: [{ type: 'text', text: '...' }] }
  if (result?.content) {
    return result.content
      .map(c => c.text || JSON.stringify(c))
      .join('\n');
  }

  return typeof result === 'string' ? result : JSON.stringify(result);
}

/**
 * Clear the session for a URL (force re-initialize on next call).
 */
function clearSession(url) {
  if (url) {
    sessionIds.delete(url);
  } else {
    sessionIds.clear();
  }
}

module.exports = {
  mcpRequest,
  initializeAndListTools,
  callTool,
  clearSession,
};
