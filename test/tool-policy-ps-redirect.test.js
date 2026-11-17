'use strict';
// tool-policy: ps with a redirection. Classification strings only, never run.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const tp = require('../lib/tool-policy');
tp.setMemberProviders({ memberDefaults: () => ({}), ownerGrants: () => ({}) });   // no data/ reads

test('ps: a redirection target containing "e" is not the BSD e option; a real e option before a redirect still is', () => {
  const ws = path.join(tp.HUB_ROOT, 'workspaces', 'haiku');
  const o = { cwd: ws, roots: [ws], agentName: 'haiku' };
  const c = (cmd) => tp.classifyCommand(cmd, o).cls;
  for (const cmd of ['ps aux > events', 'ps aux >events.txt', 'ps aux 2> errors', 'ps aux > events 2>&1']) assert.notStrictEqual(c(cmd), 'admin', cmd);
  for (const cmd of ['ps eww > out', 'ps auxe >out', 'ps e > out']) assert.strictEqual(c(cmd), 'admin', cmd);
});
