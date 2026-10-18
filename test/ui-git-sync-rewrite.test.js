'use strict';
// Update dialog: a rewritten GitHub history gets its own explanation and button (lib/git-sync runRewriteUpdate).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('app.js');
const server = read('server.js');

test('dialog explains a rewritten history, lists commits with no copy and needs a tick for them', () => {
  assert.match(app, /if \(s\.rewritten\) \{[\s\S]*?GitHub's history was rewritten/);
  assert.match(app, /no copy on GitHub<\/strong>[\s\S]*?id="gs-rewrite-ok"/);
  assert.match(app, /id="gs-rewrite" data-confirm="\$\{s\.localOnlyCount \|\| 0\}" \$\{s\.localOnlyCount \? 'disabled' : ''\}/);
  assert.match(app, /force === 'rewrite' \? '\/api\/git-sync\/rewrite-update'/);
  assert.match(app, /body: JSON\.stringify\(\{ confirmLocalOnly: Number\(rw\.dataset\.confirm\) \|\| 0 \}\)/);
});

test('server route passes the confirmation through', () => {
  assert.match(server, /pathname === '\/api\/git-sync\/rewrite-update' && req\.method === 'POST'/);
  assert.match(server, /runRewriteUpdate\(\{ confirmLocalOnly: body && body\.confirmLocalOnly \}\)/);
});
