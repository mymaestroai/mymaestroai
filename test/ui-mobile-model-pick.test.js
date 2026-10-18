'use strict';
// Phone app: change an agent's model from the chat header (a native select over the model line), like the desktop picker.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const html = read('mobile.html'), js = read('mobile.js');

test('the model line carries a transparent native select (16px so iOS does not zoom)', () => {
  assert.match(html, /<span class="sub-wrap"><span class="sub" id="chat-model"><\/span><select id="chat-model-pick" aria-label="Change this agent's model" hidden><\/select><\/span>/);
  assert.match(html, /#chat-model-pick \{ position: absolute; inset: 0;[^}]*opacity: 0; font-size: 16px;/);
  assert.match(html, /#chat-title \.sub-wrap\.pickable::after \{ content: '\\25BE'; flex: none;/, 'the arrow sits outside the truncated text, so it always shows');
});

test('filled from /api/models, grouped by vendor and who pays; admins only; refreshed on open and on agent_updated', () => {
  assert.match(js, /async function fillModelPick\(\)/);
  assert.match(js, /if \(!a \|\| !isAdmin\(\)\) \{ sel\.hidden = true;/);
  assert.match(js, /const key = v === 'Local' \? 'Local' : `\$\{v\} · \$\{mpRoute\(m, true\)\}`;/);
  assert.match(js, /await api\('\/api\/models'\)/);
  assert.match(js, /\$\(.chat-model.\)\.textContent = shortModel\(a\?\.model\);\n  fillModelPick\(\); fillEffortPick\(\);/);
  assert.match(js, /paintChatStatus\(\); fillModelPick\(\); fillEffortPick\(\); paintPlan\(\); \};/);
});

test('changing it posts to the same route as the desktop and reverts on failure', () => {
  assert.match(js, /\$\('chat-model-pick'\)\?\.addEventListener\('change', changeModelFromPick\);/);
  assert.match(js, /api\(`\/api\/agents\/\$\{encodeURIComponent\(name\)\}\/model`, \{ method: 'POST'/);
  assert.match(js, /if \(!r\.ok \|\| !d\.success\) \{ sel\.value = a\.model; toast\(`Could not change the model/);
  assert.match(js, /switches to \$\{mpLabel\(model\)\} after this reply/);
});

test('hidden header buttons really hide (the Stop button showed on idle agents)', () => {
  assert.match(html, /\.iconbtn\[hidden\] \{ display: none !important; \}/);
});
