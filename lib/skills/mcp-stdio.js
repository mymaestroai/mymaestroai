/**
 * MCP Stdio Transport Client
 * Manages a long-lived subprocess that speaks JSON-RPC over stdin/stdout.
 * Used for local MCP servers.
 */

const { spawn } = require('child_process');
const { EventEmitter } = require('events');

class McpStdioClient extends EventEmitter {
  constructor(command, args = [], options = {}) {
    super();
    this.command = command;
    this.args = args;
    const baseEnv = options.env || process.env;
    // Propagate --use-system-ca to Node-based MCP subprocesses so they trust
    // the macOS System keychain (needed for Cloudflare WARP TLS interception).
    if (!baseEnv.NODE_OPTIONS?.includes('--use-system-ca') && process.execArgv?.includes('--use-system-ca')) {
      this.env = { ...baseEnv, NODE_OPTIONS: [baseEnv.NODE_OPTIONS, '--use-system-ca'].filter(Boolean).join(' ') };
    } else {
      this.env = baseEnv;
    }

    this.process = null;
    this.initialized = false;
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.buffer = '';
    this.timeout = options.timeout || 30000; // 30s default per request
    this.redact = typeof options.redact === 'function' ? options.redact : (s) => s;   // connectors: strip secret values from logged stderr
  }

  /**
   * Spawn the subprocess and initialize the MCP protocol
   */
  async connect() {
    if (this.process && !this.process.killed) {
      return; // already connected
    }

    return new Promise((resolve, reject) => {
      // detached:true puts the child in its OWN process group, so we can kill
      // the whole tree (uvx -> python -> ...) with kill(-pid).  Without this,
      // killing uvx leaves the python grandchild running forever — the source
      // of the accumulated orphan MCP processes.
      this.process = spawn(this.command, this.args, {
        env: this.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
      this.pgid = this.process.pid;

      this.process.stdout.on('data', (chunk) => {
        this.buffer += chunk.toString();
        this._processBuffer();
      });

      this.process.stderr.on('data', (chunk) => {
        const msg = chunk.toString().trim();
        if (msg) {
          // Suppress routine INFO chatter (calendar polls alone produced 193k
          // log entries / 80MB).  Real errors and warnings still pass through.
          if (/\[INFO\]|INFO\s+Processing request/.test(msg) && !/error|fail|warn/i.test(msg)) return;
          // Log stderr but don't treat as errors — MCP servers log info here
          console.log(`[MCP-stdio] ${this.command}: ${this.redact(msg)}`);
        }
      });

      this.process.on('error', (err) => {
        console.error(`[MCP-stdio] Process error: ${err.message}`);
        this._rejectAll(err);
        if (!this.initialized) reject(err);
      });

      this.process.on('close', (code) => {
        console.log(`[MCP-stdio] Process exited with code ${code}`);
        this.initialized = false;
        this.process = null;
        this._rejectAll(new Error(`MCP process exited with code ${code}`));
      });

      // Send initialize handshake
      this._send({
        jsonrpc: '2.0',
        id: this._nextId(),
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'agent-hub', version: '1.0' },
        },
      }).then((result) => {
        // Send initialized notification
        this._write({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        });
        this.initialized = true;
        this.serverInfo = result.serverInfo;
        resolve(result);
      }).catch(reject);
    });
  }

  /**
   * Process the stdout buffer for complete JSON-RPC messages (newline-delimited)
   */
  _processBuffer() {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop(); // keep incomplete last line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        this._handleMessage(msg);
      } catch (e) {
        // Not JSON — ignore (could be log output mixed in)
      }
    }
  }

  /**
   * Handle an incoming JSON-RPC message
   */
  _handleMessage(msg) {
    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (timer) clearTimeout(timer);

      if (msg.error) {
        reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
      } else {
        resolve(msg.result);
      }
    } else if (msg.method) {
      // Server-initiated notification or request
      this.emit('notification', msg);
    }
  }

  /**
   * Write a JSON-RPC message to stdin
   */
  _write(msg) {
    if (!this.process || this.process.killed) {
      throw new Error('MCP process is not running');
    }
    this.process.stdin.write(JSON.stringify(msg) + '\n');
  }

  /**
   * Send a request and wait for response
   */
  _send(msg, timeoutMs = this.timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.id);
        reject(new Error(`MCP request timed out after ${timeoutMs}ms: ${msg.method}`));
      }, timeoutMs);

      this.pending.set(msg.id, { resolve, reject, timer });
      this._write(msg);
    });
  }

  _nextId() {
    return this.nextId++;
  }

  /**
   * List available tools
   */
  async listTools() {
    await this.connect();

    // Some MCP servers (e.g. slack-mcp) are bridges that connect to upstream
    // services asynchronously. They initially report a placeholder tool like
    // "_initializing" and then send notifications/tools/list_changed once the
    // real tools are available.  Retry a few times if we only get 1 tool.
    let tools = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await this._send({
        jsonrpc: '2.0',
        id: this._nextId(),
        method: 'tools/list',
      });
      tools = result.tools || [];
      // If we got more than 1 tool, the upstream is ready
      if (tools.length > 1) break;
      // Wait a bit for upstream to connect
      await new Promise((r) => setTimeout(r, 1500));
    }
    return tools;
  }

  /**
   * Call a tool
   */
  async callTool(name, args = {}, options = {}) {
    await this.connect();

    // Ensure the bridge is ready (upstream connected) before calling tools.
    // The bridge initially has 0–1 placeholder tools until upstream connects.
    if (!this._toolsReady) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const result = await this._send({
          jsonrpc: '2.0',
          id: this._nextId(),
          method: 'tools/list',
        });
        const tools = result.tools || [];
        if (tools.length > 1) {
          this._toolsReady = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    }

    const result = await this._send({
      jsonrpc: '2.0',
      id: this._nextId(),
      method: 'tools/call',
      params: { name, arguments: args },
    }, options.timeout ?? this.timeout);
    return result;
  }

  /**
   * Reject all pending requests
   */
  _rejectAll(err) {
    for (const [id, { reject, timer }] of this.pending) {
      if (timer) clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }

  /**
   * Gracefully shut down the subprocess
   */
  async disconnect() {
    if (this.process && !this.process.killed) {
      this._rejectAll(new Error('Disconnecting'));
      try { this.process.stdin.end(); } catch {}
      this._killGroup('SIGTERM');

      // Force kill after 2s if it doesn't exit (5s x N skills stalled shutdown)
      await new Promise((resolve) => {
        const forceKill = setTimeout(() => {
          this._killGroup('SIGKILL');
          resolve();
        }, 2000);

        if (this.process) {
          this.process.on('close', () => {
            clearTimeout(forceKill);
            resolve();
          });
        } else {
          clearTimeout(forceKill);
          resolve();
        }
      });
    }
    this.initialized = false;
    this.process = null;
  }

  /**
   * Kill the child AND its whole process group (uvx -> python grandchildren).
   */
  _killGroup(signal) {
    const pid = this.pgid || (this.process && this.process.pid);
    if (!pid) return;
    // Group kill first — reaps grandchildren that would otherwise orphan.
    try { process.kill(-pid, signal); } catch {}
    try { if (this.process && !this.process.killed) this.process.kill(signal); } catch {}
  }

  /**
   * Check if the client is connected and alive
   */
  isConnected() {
    return this.process != null && !this.process.killed && this.initialized;
  }
}

module.exports = McpStdioClient;
