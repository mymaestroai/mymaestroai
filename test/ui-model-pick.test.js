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
  assert.match(app, /onfocus="fillModelPick\('\$\{chatId\}'\)" onmousedown="return modelPickDown\(event, '\$\{chatId\}'\)" onchange="changeChatModel\('\$\{chatId\}', this\.value\)"/);
  // Filled when the chat opens, so the first click finds the whole list (a list filled while open jumped and was cut off).
  assert.match(app, /panels\.appendChild\(panel\);\n\s*\/\/ Fill the model picker now[^\n]*\n\s*setTimeout\(\(\) => fillModelPick\(chatId\), 0\);/);
  // A click that still comes first is held (preventDefault) until the list is there, then the list opens.
  assert.match(app, /function modelPickDown\(ev, chatId\) \{[\s\S]*?if \(!sel \|\| sel\.dataset\.filled === 'done'\) return true;\s*ev\.preventDefault\(\);\s*fillModelPick\(chatId\)\.then\(\(\) => \{ sel\.focus\(\); try \{ if \(sel\.showPicker\) sel\.showPicker\(\);/);
  assert.match(app, /<option value="\$\{esc\(chat\.model \|\| ''\)\}" selected>\$\{chat\.autoModel \? 'Auto' : esc\(billingDisplay\(chat\.model, true\)\)\}<\/option>/);
  assert.match(app, /title="Change this agent's model from here\. Claude to Claude keeps the session; another provider continues from the conversation history\./);
});

test('the list comes from /api/models once, grouped by provider, with the current model kept even when absent', () => {
  assert.match(app, /async function modelList\(\) \{[\s\S]*?fetch\('\/api\/models', \{ credentials: 'include' \}\)/);
  // One fill at a time per chat; 'done' only after the list is in (a failed fill is tried again on the next open).
  assert.match(app, /function fillModelPick\(chatId\) \{[\s\S]*?sel\.dataset\.filled === 'done'\) return Promise\.resolve\(\);\s*if \(!modelPickFilling\[chatId\]\) modelPickFilling\[chatId\] = fillModelPickNow\(chatId, sel\)/);
  assert.match(app, /async function fillModelPickNow\(chatId, sel\) \{[\s\S]*?sel\.dataset\.filled = 'pending';[\s\S]*?if \(html\) \{ sel\.innerHTML = html; sel\.value = cur; \}\s*sel\.dataset\.filled = 'done';\s*\} catch \(e\) \{ delete sel\.dataset\.filled;/);
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
