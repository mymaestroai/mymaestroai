'use strict';
// A Claude-client reply that uses all its tool steps (the client's maxTurns) stops with error_max_turns and the
// client then exits with code 1. That used to read "The agent's process stopped unexpectedly"; it is said plainly now.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sdk = fs.readFileSync(path.join(__dirname, '../lib/sdk-chat.js'), 'utf8');

test('the step limit is one named constant, passed to the client', () => {
  assert.match(sdk, /^const CLIENT_MAX_TURNS = 200;/m);
  assert.match(sdk, /maxTurns: CLIENT_MAX_TURNS,/);
  assert.doesNotMatch(sdk, /maxTurns: \d/);
});

test('error_max_turns is reported in plain words, kept in the reply, and is not called a crash', () => {
  const r = sdk.slice(sdk.indexOf("if (msg.subtype === 'error_max_turns') {"), sdk.indexOf("if (msg.subtype === 'error_max_turns') {") + 900);
  assert.match(r, /stepLimitHit = true;/);
  assert.match(r, /Stopped at the step limit\.\*\* This reply used all \$\{CLIENT_MAX_TURNS\} tool steps/);
  assert.match(r, /send "continue" and it picks up where it stopped/);
  assert.match(r, /fullResponse \+= note;/, 'saved with the reply, so a reload shows it');
  const at = sdk.indexOf('} else if (stepLimitHit) {');
  assert.ok(at > 0 && at < sdk.indexOf("The agent's process stopped unexpectedly"), 'the step-limit exit is handled before the generic "stopped unexpectedly" text');
  const c = sdk.slice(at, sdk.indexOf('} else {', at));
  assert.doesNotMatch(c, /type: 'turn_error'/, 'no second error for the same stop');
});
