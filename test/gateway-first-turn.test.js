'use strict';
// The gateway path keeps an in-memory conversation that is first loaded from the on-disk log.
// The loader marks a trailing user line as a reply a restart killed (placeholder "do not re-answer").
// handleChat writes the prompt to the log before the gateway loop loads the conversation, so the
// conversation must be primed in memory BEFORE that write, or the first turn to any gateway agent
// after a restart answers against its own prompt marked "interrupted" (seen live: Gemini answered "").
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');

test('handleChat primes the in-memory conversation before logging the user prompt', () => {
  const logWrite = src.indexOf("appendConversationLog(agent, 'user', message, false,");
  assert.ok(logWrite > 0, 'user prompt log write exists');
  const block = src.slice(Math.max(0, logWrite - 1200), logWrite);
  assert.ok(block.includes('getConversation(agent);'), 'getConversation(agent) is called just before the prompt is logged');
});

test('the restart placeholder is only added by the loader, never by the turn itself', () => {
  const marker = '[Response was delivered but interrupted by a server restart.';
  const first = src.indexOf(marker);
  const loaderStart = src.indexOf('function getConversation(');
  const loaderEnd = src.indexOf('\n}', loaderStart);
  assert.ok(first > loaderStart && first < loaderEnd, 'placeholder text lives inside getConversation');
  assert.strictEqual(src.indexOf(marker, loaderEnd), -1, 'no other code path writes the placeholder');
});
