'use strict';

// Fake Telegram Bot API server for comms tests. Serves /bot<token>/<method> the way
// the real Bot API does, records every call, and lets a test script a getUpdates
// queue. Not a *.test.js file itself, so `node --test test/*.test.js` never runs it.

const http = require('node:http');

async function fakeTelegramServer(t, { updates = [] } = {}) {
  const calls = { getMe: [], getUpdates: [], sendMessage: [], sendChatAction: [] };
  const queue = updates.slice();

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const m = req.url.match(/^\/bot([^/]+)\/(\w+)/);
      const method = m ? m[2] : null;
      let payload = {};
      try { payload = body ? JSON.parse(body) : {}; } catch { /* ignore */ }

      const ok = (result) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result }));
      };

      if (method === 'getMe') { calls.getMe.push(payload); return ok({ id: 1, username: 'fakebot', is_bot: true }); }
      if (method === 'sendMessage') { calls.sendMessage.push(payload); return ok({ message_id: calls.sendMessage.length, chat: { id: payload.chat_id }, text: payload.text }); }
      if (method === 'sendChatAction') { calls.sendChatAction.push(payload); return ok(true); }
      if (method === 'getUpdates') {
        calls.getUpdates.push(payload);
        return ok(queue.shift() || []);
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, description: 'not found' }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });

  const port = server.address().port;
  return { calls, queue, apiBase: `http://127.0.0.1:${port}`, server };
}

module.exports = { fakeTelegramServer };
