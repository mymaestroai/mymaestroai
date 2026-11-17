'use strict';
// A member's answer to an agent's question (ask_user) must reach the hub: the /api/ask_response route's access check
// judges body.agent, so the streamed question names its agent and both pages send it back with the answer.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('the streamed question names the asking agent', () => {
  const src = read('lib/sdk-chat.js');
  assert.match(src, /type: 'ask_user_question',\n\s+request_id: requestId,\n\s+agent: agentName,/);
});

test('the desktop and the phone send the agent back with the answer when the question named one', () => {
  assert.match(read('app.js'), /fetch\('\/api\/ask_response', \{[\s\S]{0,400}body: JSON\.stringify\(\{ request_id, answers, \.\.\.\(data && data\.agent \? \{ agent: data\.agent \} : \{\}\) \}\)/);
  assert.match(read('mobile.js'), /api\('\/api\/ask_response', \{[\s\S]{0,300}body: JSON\.stringify\(\{ request_id, answers, \.\.\.\(data\.agent \? \{ agent: data\.agent \} : \{\}\) \}\),/);
});

test('the route classifies /api/ask_response by the body agent (so the agent field is what lets a member answer)', () => {
  const access = require('../lib/access.js');
  assert.deepStrictEqual(access.classifyRoute('/api/ask_response', 'POST'), { kind: 'agent', from: 'body' });
});
