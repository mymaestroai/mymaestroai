'use strict';

// "New Session" (DELETE /api/session/:agent -> clearConversation) must drop the
// stored SDK session and Codex thread, not just the chat log; otherwise the next
// turn auto-resumes the old session with its full history.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sessreset-'));
const sdkMap = path.join(tmp, 'agent-sessions.json');
const codexMap = path.join(tmp, 'codex-sessions.json');
process.env.HUB_AGENT_SESSIONS_FILE = sdkMap;
process.env.HUB_CODEX_SESSIONS_FILE = codexMap;

const { clearConversation } = require('../lib/sdk-chat');

test('clearConversation drops the stored SDK session and Codex thread for that agent only', () => {
  const stamp = new Date().toISOString();
  fs.writeFileSync(sdkMap, JSON.stringify({
    zz_reset_a: { sessionId: 'old-a', timestamp: stamp },
    zz_reset_b: { sessionId: 'keep-b', timestamp: stamp },
  }));
  fs.writeFileSync(codexMap, JSON.stringify({
    zz_reset_a: { threadId: 't-a', model: 'gpt', timestamp: stamp },
    zz_reset_b: { threadId: 't-b', model: 'gpt', timestamp: stamp },
  }));

  clearConversation('zz_reset_a');

  const sdk = JSON.parse(fs.readFileSync(sdkMap, 'utf8'));
  const codex = JSON.parse(fs.readFileSync(codexMap, 'utf8'));
  assert.ok(!('zz_reset_a' in sdk), 'SDK session cleared');
  assert.ok(!('zz_reset_a' in codex), 'Codex thread cleared');
  assert.strictEqual(sdk.zz_reset_b.sessionId, 'keep-b', 'other agents untouched');
  assert.strictEqual(codex.zz_reset_b.threadId, 't-b', 'other agents untouched');
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
