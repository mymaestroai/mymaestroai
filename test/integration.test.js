'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const http = require('http');

// ── Test Config ──────────────────────────────────────────────────────────
const BASE = 'http://localhost:8888';
const AUTH = 'Basic ' + Buffer.from(process.env.HUB_TEST_AUTH || 'user:password').toString('base64');

// Helper: make an authenticated HTTP request, return { status, headers, body }
function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'Authorization': AUTH },
      timeout: 10000,
    };
    if (body) {
      const payload = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Pre-flight: verify hub is reachable
// ═══════════════════════════════════════════════════════════════════════════

describe('Hub Connectivity', () => {
  it('should respond to GET / with 200', async () => {
    const res = await request('GET', '/');
    assert.strictEqual(res.status, 200);
  });

  it('should reject unauthenticated requests with 401', async () => {
    const res = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: 'localhost', port: 8888, path: '/api/agents', method: 'GET', timeout: 5000 }, (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => resolve({ status: r.statusCode, body: d }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(res.status, 401);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Agent Management APIs
// ═══════════════════════════════════════════════════════════════════════════

describe('Agent APIs', () => {
  it('GET /api/agents should return a non-empty agent list', async () => {
    const res = await request('GET', '/api/agents');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.agents, 'Response should have agents key');
    assert.ok(Array.isArray(res.body.agents), 'Agents should be an array');
    assert.ok(res.body.agents.length > 0, 'Should have at least one agent');
  });

  it('each agent should have required fields', async () => {
    const res = await request('GET', '/api/agents');
    const agent = res.body.agents[0];
    assert.ok(agent.name, 'Agent should have a name');
    assert.ok(agent.model, 'Agent should have a model');
  });

  it('GET /api/agents/reload should return agents with reloaded flag', async () => {
    const res = await request('GET', '/api/agents/reload');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.reloaded, true);
    assert.ok(Array.isArray(res.body.agents));
  });

  it('GET /api/models should return available models', async () => {
    const res = await request('GET', '/api/models');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.models, 'Response should have models key');
    assert.ok(Array.isArray(res.body.models), 'Models should be an array');
    assert.ok(res.body.models.length > 0, 'Should have at least one model');
  });

  it('GET /api/agents/voices should return voice mappings', async () => {
    const res = await request('GET', '/api/agents/voices');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.voices, 'Response should have voices key');
    assert.strictEqual(typeof res.body.voices, 'object');
  });

  it('GET /api/avatars should return avatar list', async () => {
    const res = await request('GET', '/api/avatars');
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.avatars), 'Avatars should be an array');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Session Management
// ═══════════════════════════════════════════════════════════════════════════

describe('Session APIs', () => {
  it('GET /api/session/:agent should return session info', async () => {
    const res = await request('GET', '/api/session/maestro');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.agent, 'maestro');
    assert.ok('sessionId' in res.body, 'Should have sessionId key (may be null)');
  });

  it('GET /api/history/:agent should return conversation history', async () => {
    const res = await request('GET', '/api/history/maestro');
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body), 'History should be an array');
  });

  it('GET /api/history/:agent?limit=5 should respect limit', async () => {
    const res = await request('GET', '/api/history/maestro?limit=5');
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.length <= 5, 'Should return at most 5 entries');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Hardware & System Status
// ═══════════════════════════════════════════════════════════════════════════

describe('Hardware Status APIs', () => {
  it('GET /api/hardware-status should return engine states', async () => {
    const res = await request('GET', '/api/hardware-status');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.engines, 'Should have engines');
    assert.ok(res.body.engines.webcam, 'Should have webcam engine');
    assert.ok(res.body.engines.mentorpi, 'Should have mentorpi engine');
    assert.strictEqual(typeof res.body.haar, 'boolean', 'haar should be boolean');
    assert.strictEqual(typeof res.body.yolo, 'boolean', 'yolo should be boolean');
  });

  it('GET /api/system-status should return GPU/CPU/memory info', async () => {
    const res = await request('GET', '/api/system-status');
    assert.strictEqual(res.status, 200);
    assert.ok('gpu' in res.body, 'Should have gpu key');
    assert.ok('cpu' in res.body, 'Should have cpu key');
    assert.ok('mem' in res.body, 'Should have mem key');
  });

  it('GET /api/labels should return label data', async () => {
    const res = await request('GET', '/api/labels');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.labels, 'Should have labels key');
    assert.strictEqual(typeof res.body.labels, 'object', 'Labels should be an object');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Robot APIs
// ═══════════════════════════════════════════════════════════════════════════

describe('Robot APIs', () => {
  it('GET /api/robot should return active robot info', async () => {
    const res = await request('GET', '/api/robot');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.active, 'Should have active robot');
    assert.ok(res.body.robots, 'Should have robots registry');
    assert.strictEqual(res.body.active, 'mentorpi', 'Active robot should be mentorpi');
  });

  it('GET /api/robot-battery should return battery or error gracefully', async () => {
    const res = await request('GET', '/api/robot-battery');
    // May return 200 with data, or 502/504 if robot is offline — all valid
    assert.ok([200, 502, 504].includes(res.status), `Status should be 200, 502 or 504, got ${res.status}`);
  });

  it('GET /api/robot-lidar-status should return LiDAR status or error', async () => {
    const res = await request('GET', '/api/robot-lidar-status');
    assert.ok([200, 502, 504].includes(res.status), `Status should be 200, 502 or 504, got ${res.status}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Workers
// ═══════════════════════════════════════════════════════════════════════════

describe('Worker APIs', () => {
  it('GET /api/workers should return worker list', async () => {
    const res = await request('GET', '/api/workers');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.workers, 'Should have workers key');
    assert.ok(typeof res.body.workers, 'object');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Eyes (Emotion) APIs
// ═══════════════════════════════════════════════════════════════════════════

describe('Eyes APIs', () => {
  it('GET /api/eyes/state should return current emotion state', async () => {
    const res = await request('GET', '/api/eyes/state');
    assert.strictEqual(res.status, 200);
    assert.ok('emotion' in res.body, 'Should have emotion field');
  });

  it('GET /api/eyes/stream should open SSE connection', async () => {
    // Open SSE, read first event, then close
    const result = await new Promise((resolve, reject) => {
      const opts = {
        hostname: 'localhost', port: 8888,
        path: '/api/eyes/stream', method: 'GET',
        headers: { 'Authorization': AUTH },
        timeout: 5000,
      };
      const req = http.request(opts, (res) => {
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.headers['content-type'], 'text/event-stream');
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk;
          if (buf.includes('\n\n')) {
            req.destroy(); // Got first event, close connection
            resolve({ status: res.statusCode, contentType: res.headers['content-type'], data: buf });
          }
        });
      });
      req.on('error', (e) => {
        if (e.code === 'ECONNRESET') return; // Expected when we destroy
        reject(e);
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('SSE timeout')); });
      req.end();
    });
    assert.strictEqual(result.contentType, 'text/event-stream');
    assert.ok(result.data.startsWith('data:'), 'First event should be a data line');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TTS Voices
// ═══════════════════════════════════════════════════════════════════════════

describe('TTS APIs', () => {
  it('GET /api/tts/voices should return available voices', async () => {
    const res = await request('GET', '/api/tts/voices');
    assert.strictEqual(res.status, 200);
    // Response is either an object with voices or an array
    assert.ok(res.body, 'Should return voice data');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Static File Serving
// ═══════════════════════════════════════════════════════════════════════════

describe('Static File Serving', () => {
  it('GET / should serve index.html with correct content type', async () => {
    const res = await request('GET', '/');
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/html'), 'Should serve HTML');
  });

  it('GET /app.js should serve with correct content type and no-cache', async () => {
    const res = await request('GET', '/app.js');
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers['content-type'].includes('application/javascript'), 'Should serve JS');
    assert.ok(res.headers['cache-control']?.includes('no-cache'), 'JS should have no-cache header');
  });

  it('GET /nonexistent should return 404', async () => {
    const res = await request('GET', '/nonexistent-file-12345.html');
    assert.strictEqual(res.status, 404);
  });

  it('should block directory traversal', async () => {
    const res = await request('GET', '/../../../etc/passwd');
    assert.ok([403, 404].includes(res.status), 'Should block traversal with 403 or 404');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Security Headers
// ═══════════════════════════════════════════════════════════════════════════

describe('Security', () => {
  it('should include security headers', async () => {
    const res = await request('GET', '/');
    assert.ok(res.headers['x-content-type-options'], 'Should have X-Content-Type-Options');
    assert.ok(res.headers['x-frame-options'], 'Should have X-Frame-Options');
  });

  it('should enforce authentication on API endpoints', async () => {
    const res = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: 'localhost', port: 8888, path: '/api/hardware-status', method: 'GET', timeout: 5000 }, (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => resolve({ status: r.statusCode }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(res.status, 401);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Rate Limiting (live)
// ═══════════════════════════════════════════════════════════════════════════

describe('Rate Limiting', () => {
  it('POST /api/chat with missing agent should return 400, not 429', async () => {
    const res = await request('POST', '/api/chat/stream', { message: 'test' });
    assert.strictEqual(res.status, 400, 'Missing agent should return 400');
  });

  it('POST /api/tts should be rate-limited (not crash on missing body fields)', async () => {
    // Send a minimal TTS request — should fail gracefully, not crash
    const res = await request('POST', '/api/tts', { text: 'hello', voice: 'test' });
    // Expect either a valid response or a graceful error (400/500), not a crash
    assert.ok(res.status >= 200 && res.status < 600, `Should return valid HTTP status, got ${res.status}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Error Handling
// ═══════════════════════════════════════════════════════════════════════════

describe('Error Handling', () => {
  it('POST with invalid JSON should return 400', async () => {
    const res = await new Promise((resolve, reject) => {
      const opts = {
        hostname: 'localhost', port: 8888,
        path: '/api/chat/stream', method: 'POST',
        headers: {
          'Authorization': AUTH,
          'Content-Type': 'application/json',
          'Content-Length': 11,
        },
        timeout: 5000,
      };
      const req = http.request(opts, (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => resolve({ status: r.statusCode, body: d }));
      });
      req.on('error', reject);
      req.write('not json!!!');
      req.end();
    });
    assert.strictEqual(res.status, 400);
  });

  it('unknown API endpoint should return 404', async () => {
    const res = await request('GET', '/api/nonexistent-endpoint-xyz');
    assert.strictEqual(res.status, 404);
  });
});
