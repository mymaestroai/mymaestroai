'use strict';
// The bar above a chat must shrink with the window: the name/model/effort/badge group wraps inside itself,
// the name truncates, the picker shrinks, and the usage badge keeps its full words.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function rule(sel) {
  const i = html.indexOf(sel + ' {');
  assert.ok(i >= 0, 'rule not found: ' + sel);
  return html.slice(i, html.indexOf('}', i));
}

test('chat bar wraps', () => {
  assert.match(rule('.chat-actions'), /flex-wrap:\s*wrap/);
});
test('name group wraps and can shrink', () => {
  const r = rule('.chat-actions .agent-name');
  assert.match(r, /flex-wrap:\s*wrap/);
  assert.match(r, /min-width:\s*0/);
  assert.match(r, /max-width:\s*100%/);
});
test('agent name truncates with an ellipsis, keeping 8 characters', () => {
  const r = rule('.chat-actions .agent-name-text');
  assert.match(r, /text-overflow:\s*ellipsis/);
  assert.match(r, /overflow:\s*hidden/);
  assert.match(r, /white-space:\s*nowrap/);
  assert.match(r, /min-width:\s*8ch/);
});
test('model and effort pickers shrink', () => {
  const m = rule('.chat-actions .model-pick');
  assert.match(m, /min-width:\s*7rem/);
  assert.match(m, /flex:\s*0 1 auto/);
  assert.match(m, /text-overflow:\s*ellipsis/);
  assert.match(rule('.chat-actions .effort-pick'), /min-width:\s*0/);
});
test('usage badge keeps its full words', () => {
  assert.match(rule('.chat-actions .plan-badge'), /white-space:\s*nowrap/);
});
