'use strict';
// lib/sdk-chat forgetAgent: the chat the running hub keeps in memory under a name goes too, so a later agent of that
// name (after a delete or a rename) reads its own file, never the earlier agent's messages.
const { test } = require('node:test');
const assert = require('node:assert');
const sc = require('../lib/sdk-chat');

test('forgetAgent drops the chat kept in memory under that name', () => {
  const name = `zzforget${process.pid}`;
  const conv = sc.getConversation(name);
  conv.push({ role: 'user', content: 'from the earlier agent' });
  assert.strictEqual(sc.getConversation(name).length, conv.length, 'kept in memory');
  sc.forgetAgent(name);
  assert.ok(!sc.getConversation(name).some(m => m.content === 'from the earlier agent'), 'gone after forgetAgent');
});
