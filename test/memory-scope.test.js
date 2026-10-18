'use strict';
// The startup prompt's "Shared Memory Pool" must come from the agent's own pool only (seen live: a member's
// assistant received the admin side's operating rules in its startup context).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memscope-'));
process.env.HUB_MEMORY_DB = path.join(dir, 'memory.db');
const memoryDb = require('../lib/memory-db');

test('getMemoryContext only embeds the shared pool of the requested owner', () => {
  memoryDb.writeSharedMemory('operating-rules', 'NEVER restart the hub without confirmation', 'maestro', [], null);
  memoryDb.writeSharedMemory('family-notes', 'Grandma visits on Sundays', 'sam_assistant', [], 'u_sam');
  const adminSide = memoryDb.getMemoryContext('maestro', 32768, { sharedPool: null });
  assert.ok(adminSide.includes('operating-rules'), 'admin side sees its own pool');
  assert.ok(!adminSide.includes('family-notes'), 'admin side prompt does not embed a member pool');
  const member = memoryDb.getMemoryContext('sam_assistant', 32768, { sharedPool: 'u_sam' });
  assert.ok(member.includes('family-notes'));
  assert.ok(!member.includes('operating-rules'), 'a member agent never sees the admin side notes in its prompt');
  assert.ok(!memoryDb.getMemoryContext('sam_assistant', 32768).includes('family-notes'), 'default pool is the admin side');
  assert.strictEqual(memoryDb.readSharedMemory('operating-rules', 'u_sam'), '(no shared memory matching "operating-rules")');
});

test('agents.js passes the owner pool when building the prompt', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agents.js'), 'utf8');
  assert.ok(src.includes("memoryDb.getMemoryContext(agentName, 32768, { sharedPool: sharedPoolFor(agentName) })"));
  assert.ok(src.includes('function sharedPoolFor(agentName)'));
});
