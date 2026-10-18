'use strict';
// Model picker in the desktop chat header (app.js renderSoloChatPanel + fillModelPick/changeChatModel/onAgentUpdated):
// the operator changes an agent's model from inside the session. Source-string tests in the ui-*.test.js pattern.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('app.js');
const index = read('index.html');

test('the solo chat header carries a model select showing the current model, filled on first open', () => {
  assert.match(app, /<span class="agent-name"><span class="agent-name-text">\$\{hubEsc\(chat\.display \|\| capName\(chat\.agent\)\)\}<\/span> <select class="model-pick" id="model-pick-\$\{chatId\}"/);
  assert.match(app, /onfocus="fillModelPick\('\$\{chatId\}'\)" onmousedown="fillModelPick\('\$\{chatId\}'\)" onchange="changeChatModel\('\$\{chatId\}', this\.value\)"/);
  assert.match(app, /<option value="\$\{esc\(chat\.model \|\| ''\)\}" selected>\$\{chat\.autoModel \? 'Auto' : esc\(billingDisplay\(chat\.model, true\)\)\}<\/option>/);
  assert.match(app, /title="Change this agent's model from here\. Claude to Claude keeps the session; another provider continues from the conversation history\./);
});

test('the list comes from /api/models once, grouped by provider, with the current model kept even when absent', () => {
  assert.match(app, /async function modelList\(\) \{[\s\S]*?fetch\('\/api\/models', \{ credentials: 'include' \}\)/);
  assert.match(app, /async function fillModelPick\(chatId\) \{[\s\S]*?if \(!chat \|\| !sel \|\| sel\.dataset\.filled\) return;/);
  assert.match(app, /<optgroup label="\$\{esc\(label\)\}">/, 'groups are vendor + route; the route is in each option too');
  assert.match(app, /\(current; not in the hub's list\)/);
});

test('a change posts to the same route the settings page uses and reverts the select on failure', () => {
  assert.match(app, /async function changeChatModel\(chatId, model, opts = \{\}\) \{[\s\S]*?fetch\(`\/api\/agents\/\$\{encodeURIComponent\(chat\.agent\)\}\/model`, \{ method: 'POST'[\s\S]*?body: JSON\.stringify\(\{ model \}\)/);
  assert.match(app, /if \(!r\.ok \|\| !d\.success\) \{ if \(sel\) sel\.value = chat\.model; alert\(/);
});

test('agent_updated relabels the name and sets the select value, inserting the model when the list lacks it', () => {
  const at = app.indexOf('function onAgentUpdated(ev)');
  const body = app.slice(at, at + 2500);
  assert.match(body, /const text = span\.querySelector\('\.agent-name-text'\);\s*\n\s*const sel = span\.querySelector\('\.model-pick'\);/);
  assert.match(body, /if \(m && !\[\.\.\.sel\.options\]\.some\(o => o\.value === m\)\) sel\.insertAdjacentHTML\('afterbegin'/);
  assert.match(body, /sel\.value = m;/);
  assert.match(body, /after this turn/, 'a change while busy is noted and applied when the turn ends');
});

test('styles exist for the picker', () => {
  assert.match(index, /\.chat-actions \.model-pick \{/);
  assert.match(index, /\.chat-actions \.agent-name \{[^}]*display: inline-flex/);
});
