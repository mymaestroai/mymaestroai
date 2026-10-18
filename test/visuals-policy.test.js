'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const vp = require('../lib/visuals-policy');

test('the pictures guide names the agent\'s folder, the four drawn block types, the dark palette, and the image tool when a key exists', () => {
  const t = vp.policyText({ filesFolder: '/home/x/agent-hub/share/doc', workspace: '/home/x/hub/workspaces/doc', hasShell: true, hasImageTool: true });
  assert.match(t, /## PICTURES, CHARTS AND DIAGRAMS/);
  assert.ok(t.includes('/home/x/agent-hub/share/doc'));
  for (const b of ['`chart`', '`mermaid`', '`svg`', '`html`']) assert.ok(t.includes(b), b);
  assert.match(t, /#3987e5/); assert.match(t, /#d95926/);
  assert.match(t, /generate_image/); assert.match(t, /matplotlib/); assert.match(t, /pdftoppm/); assert.match(t, /google-chrome --headless/);
  assert.match(t, /!\[caption\]\(\/absolute\/path\/to\/file\.png\)/);
});

test('without a shell or an image key the shell recipes and the tool line are left out; defaults name generic folders', () => {
  const t = vp.policyText({ hasShell: false, hasImageTool: false });
  assert.ok(!t.includes('generate_image')); assert.ok(!t.includes('matplotlib')); assert.ok(!t.includes('pdftoppm'));
  assert.ok(t.includes('your Files folder'));
  assert.ok(t.includes('`chart`') && t.includes('`mermaid`'), 'drawn blocks need no shell');
});
