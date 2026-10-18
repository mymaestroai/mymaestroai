'use strict';

// lib/comms/channels/telegram.js: thin Bot API client. Covers chunking, sendMessage,
// sendChatAction, getMe, and the long-poll loop against a fake Bot API server.

const { test } = require('node:test');
const assert = require('node:assert');
const { TelegramChannel, chunkText } = require('../lib/comms/channels/telegram');
const { fakeTelegramServer } = require('./helpers/fake-telegram-server');

const FAKE_TOKEN = 'FAKE:not-a-real-token';

function channel(apiBase) {
  return new TelegramChannel({ getToken: () => FAKE_TOKEN, apiBase, fetchImpl: global.fetch });
}

test('chunkText leaves short text untouched', () => {
  assert.deepStrictEqual(chunkText('hello'), ['hello']);
  assert.deepStrictEqual(chunkText(''), ['']);
});

test('chunkText splits long text at <=4096 chars on line boundaries', () => {
  const lines = [];
  for (let i = 0; i < 500; i++) lines.push(`line ${i} `.repeat(5));
  const text = lines.join('\n');
  const parts = chunkText(text);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 4096, `chunk too long: ${p.length}`);
  assert.strictEqual(parts.join('\n'), text);
});

test('chunkText forces a hard cut when a single line exceeds the limit', () => {
  const text = 'x'.repeat(9000);
  const parts = chunkText(text);
  assert.ok(parts.length >= 3);
  for (const p of parts) assert.ok(p.length <= 4096);
  assert.strictEqual(parts.join(''), text);
});

test('getMe returns the bot info from the fake server', async (t) => {
  const { apiBase, calls } = await fakeTelegramServer(t);
  const ch = channel(apiBase);
  const me = await ch.getMe();
  assert.strictEqual(me.username, 'fakebot');
  assert.strictEqual(calls.getMe.length, 1);
});

test('sendMessage sends a single call for short text', async (t) => {
  const { apiBase, calls } = await fakeTelegramServer(t);
  const ch = channel(apiBase);
  await ch.sendMessage('123', 'hi there');
  assert.strictEqual(calls.sendMessage.length, 1);
  assert.strictEqual(calls.sendMessage[0].chat_id, '123');
  assert.strictEqual(calls.sendMessage[0].text, 'hi there');
});

test('sendMessage chunks text over 4096 chars into multiple calls', async (t) => {
  const { apiBase, calls } = await fakeTelegramServer(t);
  const ch = channel(apiBase);
  const text = 'y'.repeat(9000);
  await ch.sendMessage('123', text);
  assert.ok(calls.sendMessage.length >= 3);
  for (const c of calls.sendMessage) assert.strictEqual(c.chat_id, '123');
  assert.strictEqual(calls.sendMessage.map((c) => c.text).join(''), text);
});

test('sendChatAction posts the action and never throws on failure', async (t) => {
  const { apiBase, calls } = await fakeTelegramServer(t);
  const ch = channel(apiBase);
  await ch.sendChatAction('123', 'typing');
  assert.strictEqual(calls.sendChatAction.length, 1);
  assert.strictEqual(calls.sendChatAction[0].action, 'typing');

  // no token -> _call throws synchronously inside sendChatAction; must be swallowed
  const noToken = new TelegramChannel({ getToken: () => null, apiBase, fetchImpl: global.fetch });
  await assert.doesNotReject(noToken.sendChatAction('123'));
});

test('start() long-polls and delivers updates to onMessage, advancing the offset', async (t) => {
  const upd1 = { update_id: 5, message: { chat: { id: 1 }, from: { id: 9 }, text: 'hi' } };
  const upd2 = { update_id: 6, message: { chat: { id: 1 }, from: { id: 9 }, text: 'again' } };
  const { apiBase, calls } = await fakeTelegramServer(t, { updates: [[upd1], [upd2], []] });
  const ch = channel(apiBase);
  const seen = [];
  await new Promise((resolve) => {
    ch.start(async (upd) => {
      seen.push(upd);
      if (seen.length === 2) { ch.stop(); resolve(); }
    });
  });
  assert.deepStrictEqual(seen, [upd1, upd2]);
  assert.strictEqual(calls.getUpdates[0].offset, 0);
  assert.ok(calls.getUpdates.some((c) => c.offset === 6));
});

test('start()/stop() is idempotent and status() reports polling state', async (t) => {
  const { apiBase } = await fakeTelegramServer(t, { updates: [[]] });
  const ch = channel(apiBase);
  ch.start(async () => {});
  ch.start(async () => {}); // second start() is a no-op while already polling
  assert.strictEqual(ch.status().polling, true);
  ch.stop();
  assert.strictEqual(ch.status().polling, false);
});
