'use strict';
// A model (or name, icon, settings) change on the settings page reaches open windows: the server publishes
// 'agent_updated' from every agent-change route, and both pages relabel the open chat, after the current turn
// when one is running. The server resolves the model per turn already, so the next turn uses the new model.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const { createHubEvents } = require('../lib/hub-events');

test('server publishes agent_updated after model, display, icon and PATCH changes', () => {
  const s = read('server.js');
  assert.match(s, /async function publishAgentUpdate\(name, changed = \[\]\)/);
  assert.match(s, /events\.publish\('agent_updated', \{ agent: name, model: a\.model/);
  assert.match(s, /setAgentModel\(name, body\.model\);\s*\n\s*if \(result\.success\) await publishAgentUpdate\(name, \['model'\]\)/);
  assert.match(s, /setAgentDisplay\(name, body\.display\);\s*\n\s*if \(result\.success\) await publishAgentUpdate\(name, \['display'\]\)/);
  assert.match(s, /setAgentIcon\(name, body\.icon\);\s*\n\s*if \(result\.success\) await publishAgentUpdate\(name, \['icon'\]\)/);
  assert.match(s, /if \(result\.success\) await publishAgentUpdate\(name, Object\.keys\(body \|\| \{\}\)\)/);
});

test('the event carries the agent name, so a member only sees updates for agents they may see', () => {
  const hub = createHubEvents();
  const seen = [];
  const res = { chunks: [], writeHead() {}, write(s) { res.chunks.push(s); return true; }, on() {}, destroy() {} };
  hub.subscribe({ headers: {} }, res, { isAdmin: false, visibleAgent: (n) => n === 'sam_doc', filter: (ev) => ev.agent === 'sam_doc' });
  hub.publish('agent_updated', { agent: 'maestro', model: 'x' });
  hub.publish('agent_updated', { agent: 'sam_doc', model: 'y' });
  const got = res.chunks.filter(c => c.startsWith('id: ')).map(c => JSON.parse(/data: (.*)\n/.exec(c)[1]).agent);
  assert.deepStrictEqual(got, ['sam_doc']);
});

test('both pages listen for agent_updated and relabel the open chat, waiting for a running turn to end', () => {
  const a = read('app.js');
  assert.match(a, /addEventListener\('agent_updated', e => \{ const ev = parse\(e\); if \(ev\) onAgentUpdated\(ev\); \}\)/);
  assert.match(a, /function onAgentUpdated\(ev\)/);
  assert.match(a, /after this turn/);
  assert.match(a, /chat\._agentUpdateTimer = setInterval/);
  const m = read('mobile.js');
  assert.match(m, /on\('agent_updated', onAgentUpdated\)/);
  assert.match(m, /async function onAgentUpdated\(ev\)/);
  assert.match(m, /_agentUpdateTimer = setInterval/);
});
