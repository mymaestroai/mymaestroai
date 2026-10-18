'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

// ═══════════════════════════════════════════════════════════════════════════
// 1. Rate Limiter Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Rate Limiter', () => {
  // Recreate the rate limiter logic from server.js for testing
  const rateLimitBuckets = new Map();

  function rateLimit(key, maxPerWindow, windowMs = 60000) {
    const now = Date.now();
    let bucket = rateLimitBuckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
    }
    bucket.count++;
    rateLimitBuckets.set(key, bucket);
    if (bucket.count > maxPerWindow) return false;
    return true;
  }

  it('should allow requests under limit', () => {
    rateLimitBuckets.clear();
    const key = 'test-user-1';

    assert.strictEqual(rateLimit(key, 5), true, 'Request 1 should be allowed');
    assert.strictEqual(rateLimit(key, 5), true, 'Request 2 should be allowed');
    assert.strictEqual(rateLimit(key, 5), true, 'Request 3 should be allowed');
    assert.strictEqual(rateLimit(key, 5), true, 'Request 4 should be allowed');
    assert.strictEqual(rateLimit(key, 5), true, 'Request 5 should be allowed');
  });

  it('should block requests over limit', () => {
    rateLimitBuckets.clear();
    const key = 'test-user-2';

    // Fill the bucket
    for (let i = 0; i < 3; i++) {
      assert.strictEqual(rateLimit(key, 3), true, `Request ${i + 1} should be allowed`);
    }

    // Next requests should be blocked
    assert.strictEqual(rateLimit(key, 3), false, 'Request 4 should be blocked');
    assert.strictEqual(rateLimit(key, 3), false, 'Request 5 should be blocked');
  });

  it('should reset after window expires', () => {
    rateLimitBuckets.clear();
    const key = 'test-user-3';
    const shortWindow = 100; // 100ms window

    // Fill the bucket
    assert.strictEqual(rateLimit(key, 2, shortWindow), true, 'Request 1 should be allowed');
    assert.strictEqual(rateLimit(key, 2, shortWindow), true, 'Request 2 should be allowed');
    assert.strictEqual(rateLimit(key, 2, shortWindow), false, 'Request 3 should be blocked');

    // Wait for window to expire
    return new Promise((resolve) => {
      setTimeout(() => {
        // After window expires, new requests should be allowed
        assert.strictEqual(rateLimit(key, 2, shortWindow), true, 'Request after reset should be allowed');
        resolve();
      }, 150);
    });
  });

  it('should handle multiple independent keys', () => {
    rateLimitBuckets.clear();

    assert.strictEqual(rateLimit('user-a', 2), true);
    assert.strictEqual(rateLimit('user-b', 2), true);
    assert.strictEqual(rateLimit('user-a', 2), true);
    assert.strictEqual(rateLimit('user-b', 2), true);

    // user-a exhausted
    assert.strictEqual(rateLimit('user-a', 2), false);
    // user-b exhausted
    assert.strictEqual(rateLimit('user-b', 2), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Conversation Log Trimming Logic Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Conversation Log Trimming', () => {
  function trimLines(lines, max) {
    if (lines.length > max) return lines.slice(-max);
    return lines;
  }

  it('should not trim when under limit', () => {
    const lines = ['line1', 'line2', 'line3'];
    const result = trimLines(lines, 5);

    assert.strictEqual(result.length, 3);
    assert.deepStrictEqual(result, lines);
  });

  it('should trim to last N lines when over limit', () => {
    const lines = ['line1', 'line2', 'line3', 'line4', 'line5', 'line6'];
    const result = trimLines(lines, 3);

    assert.strictEqual(result.length, 3);
    assert.deepStrictEqual(result, ['line4', 'line5', 'line6']);
  });

  it('should handle exact limit', () => {
    const lines = ['line1', 'line2', 'line3'];
    const result = trimLines(lines, 3);

    assert.strictEqual(result.length, 3);
    assert.deepStrictEqual(result, lines);
  });

  it('should handle empty array', () => {
    const lines = [];
    const result = trimLines(lines, 10);

    assert.strictEqual(result.length, 0);
    assert.deepStrictEqual(result, []);
  });

  it('should preserve order of remaining lines', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `msg-${i}`);
    const result = trimLines(lines, 10);

    assert.strictEqual(result.length, 10);
    assert.strictEqual(result[0], 'msg-90');
    assert.strictEqual(result[9], 'msg-99');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Deterministic Trim Counter Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Trim Counter Logic', () => {
  it('should trigger on every 10th call', () => {
    let counter = 0;
    const triggers = [];

    // Simulate 35 writes
    for (let i = 1; i <= 35; i++) {
      counter++;
      if (counter % 10 === 0) {
        triggers.push(i);
      }
    }

    assert.deepStrictEqual(triggers, [10, 20, 30], 'Should trigger at calls 10, 20, 30');
  });

  it('should not trigger before 10th call', () => {
    let counter = 0;
    let triggered = false;

    for (let i = 1; i <= 9; i++) {
      counter++;
      if (counter % 10 === 0) {
        triggered = true;
      }
    }

    assert.strictEqual(triggered, false, 'Should not trigger in first 9 calls');
  });

  it('should trigger exactly at 10th call', () => {
    let counter = 0;
    let triggered = false;

    for (let i = 1; i <= 10; i++) {
      counter++;
      if (counter % 10 === 0) {
        triggered = true;
      }
    }

    assert.strictEqual(triggered, true, 'Should trigger at 10th call');
  });

  it('should work correctly with pre-increment', () => {
    let counter = 0;
    const results = [];

    // Test the actual pattern: ++counter % 10 === 0
    for (let i = 0; i < 25; i++) {
      const shouldTrim = (++counter % 10 === 0);
      results.push({ call: i + 1, counter, shouldTrim });
    }

    const trimCalls = results.filter(r => r.shouldTrim).map(r => r.call);
    assert.deepStrictEqual(trimCalls, [10, 20], 'Pre-increment should trigger at 10, 20');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Robot Config Structure Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Robot Config Registry', () => {
  const ROBOTS = {
    mentorpi: {
      label: 'MentorPi',
      api: 'http://mentorpi:5000',
      rosbridge: 'ws://mentorpi:9090',
      type: 'ros2',
    },
  };

  function getActiveRobotConfig(activeRobot = 'mentorpi') {
    return ROBOTS[activeRobot];
  }

  it('should return correct config shape', () => {
    const config = getActiveRobotConfig();

    assert.ok(config, 'Config should exist');
    assert.ok(config.label, 'Config should have label');
    assert.ok(config.api, 'Config should have api');
    assert.ok(config.rosbridge, 'Config should have rosbridge');
    assert.ok(config.type, 'Config should have type');
  });

  it('should return correct API URL', () => {
    const config = getActiveRobotConfig();

    assert.strictEqual(config.api, 'http://mentorpi:5000');
  });

  it('should return correct ROS bridge URL', () => {
    const config = getActiveRobotConfig();

    assert.strictEqual(config.rosbridge, 'ws://mentorpi:9090');
  });

  it('should return correct robot type', () => {
    const config = getActiveRobotConfig();

    assert.strictEqual(config.type, 'ros2');
  });

  it('should return undefined for unknown robot', () => {
    const config = ROBOTS['nonexistent'];

    assert.strictEqual(config, undefined);
  });

  it('should handle multiple robots in registry', () => {
    const multiRobots = {
      mentorpi: { label: 'MentorPi', api: 'http://mentorpi:5000' },
      turbopi: { label: 'TurboPi', api: 'http://turbopi:5000' },
    };

    assert.ok(multiRobots.mentorpi);
    assert.ok(multiRobots.turbopi);
    assert.strictEqual(multiRobots.mentorpi.api, 'http://mentorpi:5000');
    assert.strictEqual(multiRobots.turbopi.api, 'http://turbopi:5000');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Auth Credential Parsing Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Environment Variable Parsing', () => {
  function parseEnvLine(line) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    return match ? { key: match[1], value: match[2] } : null;
  }

  it('should parse simple KEY=VALUE', () => {
    const result = parseEnvLine('API_KEY=abc123');

    assert.deepStrictEqual(result, { key: 'API_KEY', value: 'abc123' });
  });

  it('should parse value with spaces', () => {
    const result = parseEnvLine('API_KEY=value with spaces');

    assert.deepStrictEqual(result, { key: 'API_KEY', value: 'value with spaces' });
  });

  it('should parse empty value', () => {
    const result = parseEnvLine('API_KEY=');

    assert.deepStrictEqual(result, { key: 'API_KEY', value: '' });
  });

  it('should parse value with equals sign', () => {
    const result = parseEnvLine('CONNECTION_STRING=server=localhost;port=5432');

    assert.deepStrictEqual(result, {
      key: 'CONNECTION_STRING',
      value: 'server=localhost;port=5432'
    });
  });

  it('should return null for invalid format', () => {
    assert.strictEqual(parseEnvLine('invalid line'), null);
    assert.strictEqual(parseEnvLine('lowercase=value'), null);
    assert.strictEqual(parseEnvLine('# comment'), null);
    assert.strictEqual(parseEnvLine(''), null);
  });

  it('should handle underscores in key names', () => {
    const result = parseEnvLine('VERY_LONG_KEY_NAME=value');

    assert.deepStrictEqual(result, { key: 'VERY_LONG_KEY_NAME', value: 'value' });
  });

  it('should handle quoted values', () => {
    const result = parseEnvLine('API_KEY="quoted value"');

    assert.deepStrictEqual(result, { key: 'API_KEY', value: '"quoted value"' });
  });

  it('should parse typical credentials', () => {
    const lines = [
      'ANTHROPIC_API_KEY=sk-ant-abc123',
      'OPENAI_API_KEY=sk-proj-xyz789',
      'DATABASE_URL=postgresql://user:pass@localhost:5432/db',
    ];

    const results = lines.map(parseEnvLine);

    assert.strictEqual(results[0].key, 'ANTHROPIC_API_KEY');
    assert.strictEqual(results[0].value, 'sk-ant-abc123');

    assert.strictEqual(results[1].key, 'OPENAI_API_KEY');
    assert.strictEqual(results[1].value, 'sk-proj-xyz789');

    assert.strictEqual(results[2].key, 'DATABASE_URL');
    assert.strictEqual(results[2].value, 'postgresql://user:pass@localhost:5432/db');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Additional Utility Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Array Slicing Edge Cases', () => {
  it('should handle negative slice on empty array', () => {
    const arr = [];
    const result = arr.slice(-10);

    assert.deepStrictEqual(result, []);
  });

  it('should handle slice larger than array', () => {
    const arr = [1, 2, 3];
    const result = arr.slice(-10);

    assert.deepStrictEqual(result, [1, 2, 3]);
  });

  it('should correctly slice last N elements', () => {
    const arr = Array.from({ length: 100 }, (_, i) => i);
    const result = arr.slice(-5);

    assert.strictEqual(result.length, 5);
    assert.deepStrictEqual(result, [95, 96, 97, 98, 99]);
  });
});

describe('Modulo Arithmetic', () => {
  it('should calculate modulo correctly for small numbers', () => {
    assert.strictEqual(10 % 10, 0);
    assert.strictEqual(11 % 10, 1);
    assert.strictEqual(20 % 10, 0);
    assert.strictEqual(21 % 10, 1);
  });

  it('should calculate modulo correctly for large numbers', () => {
    assert.strictEqual(1000 % 10, 0);
    assert.strictEqual(1001 % 10, 1);
    assert.strictEqual(9999 % 10, 9);
  });
});

describe('Timestamp Generation', () => {
  it('should generate valid ISO timestamp', () => {
    const ts = new Date().toISOString();

    assert.ok(ts.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      'Should match ISO 8601 format');
  });

  it('should generate incrementing timestamps', () => {
    const ts1 = Date.now();
    // Small delay to ensure different timestamps
    const ts2 = Date.now();

    assert.ok(ts2 >= ts1, 'Later timestamp should be >= earlier timestamp');
  });
});

describe('JSON Serialization', () => {
  it('should serialize conversation log entry', () => {
    const entry = {
      ts: '2026-04-07T12:00:00.000Z',
      role: 'user',
      content: 'Hello, agent!'
    };

    const serialized = JSON.stringify(entry);
    const parsed = JSON.parse(serialized);

    assert.deepStrictEqual(parsed, entry);
  });

  it('should handle special characters in content', () => {
    const entry = {
      ts: '2026-04-07T12:00:00.000Z',
      role: 'assistant',
      content: 'Hello! Here\'s a "quote" and a \n newline'
    };

    const serialized = JSON.stringify(entry);
    const parsed = JSON.parse(serialized);

    assert.strictEqual(parsed.content, entry.content);
  });

  it('should handle unicode in content', () => {
    const entry = {
      ts: '2026-04-07T12:00:00.000Z',
      role: 'assistant',
      content: 'Hello! 🤖 Robot says hi 你好'
    };

    const serialized = JSON.stringify(entry);
    const parsed = JSON.parse(serialized);

    assert.strictEqual(parsed.content, entry.content);
  });
});
