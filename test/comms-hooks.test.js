'use strict';

// Confirms the small set of touch points the comms module needs inside the
// existing hub core (sdk-chat.js, server.js, index.html, app.js, .gitignore).
// Plain source-text assertions only (fs.readFileSync + string/regex checks) —
// this file does not execute those modules.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// ── lib/sdk-chat.js ─────────────────────────────────────────────────────────

test('sdk-chat.js requires lib/comms/tools', () => {
  const src = read('lib/sdk-chat.js');
  assert.match(src, /require\(['"]\.\/comms\/tools['"]\)/);
});

test('sdk-chat.js wires comms tools into both tool-spec sites, gated by isCommsAgent and consultationDepth', () => {
  const src = read('lib/sdk-chat.js');
  const matches = src.match(/commsTools\.isCommsAgent\(agentName\)\s*&&\s*consultationDepth === 0/g) || [];
  assert.strictEqual(matches.length, 2);
  assert.match(src, /commsTools\.toolSpecs\(\)/);
  assert.match(src, /commsTools\.runTool\(/);
});

test('sdk-chat.js excludeTools loop exists for withholding tools (e.g. wallet tools) from comms turns', () => {
  const src = read('lib/sdk-chat.js');
  assert.match(src, /for \(const t of \(options\.excludeTools \|\| \[\]\)\)/);
});

// ── server.js ────────────────────────────────────────────────────────────

test('server.js routes /api/comms/* to lib/comms/routes', () => {
  const src = read('server.js');
  assert.match(src, /pathname\.startsWith\(['"]\/api\/comms\/['"]\)/);
  assert.match(src, /require\(['"]\.\/lib\/comms\/routes['"]\)\.handle\(/);
});

test('server.js starts the comms service with attach()/start() and catches startup errors', () => {
  const src = read('server.js');
  assert.match(src, /require\(['"]\.\/lib\/comms\/service['"]\)\.getCommsService\(\)\.attach\(/);
  assert.match(src, /catch \(e\) \{ console\.error\(['"]\[comms\] service failed to start:['"]/);
});

// ── index.html ───────────────────────────────────────────────────────────

test('index.html has a comms header button and loads comms-panel.js', () => {
  const src = read('index.html');
  assert.match(src, /id="comms-btn"/);
  assert.match(src, /<script src="comms-panel\.js"><\/script>/);
});

// ── app.js ───────────────────────────────────────────────────────────────

test('app.js labels the comms notification case', () => {
  const src = read('app.js');
  assert.match(src, /case 'comms': return 'message from a messaging channel';/);
});

// ── .gitignore ───────────────────────────────────────────────────────────

test('.gitignore excludes the comms data directory', () => {
  const src = read('.gitignore');
  assert.match(src, /^data\/comms\/$/m);
});
