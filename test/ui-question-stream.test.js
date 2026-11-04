'use strict';
// A question card must not stop the desktop page from reading the reply. The hub keeps the reply's
// stream open while the agent waits for the answer; the page used to await the card inside its read
// loop, so nothing was read, and after 90 s its stall check cancelled the reader. The answer then went
// through and the agent carried on, but the page showed nothing more until a reload (2026-10-28).
// These tests run the page's own stream readers from app.js against a scripted stream and a fake clock. While the
// agent waits for an answer the hub keeps sending a heartbeat every 15 s on the reply's stream (lib/sdk-chat.js, every
// route), so a page that keeps reading never sees a stall; a stream with no bytes at all is a dead connection, card or not.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function extract(src, name) {
  let start = src.indexOf(`async function ${name}(`);
  if (start < 0) start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found in app.js`);
  let depth = 0;
  let i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(start, i + 1);
}

const flush = () => new Promise((r) => setImmediate(r));
// The reader's outcome, caught at once (a rejection must not go unhandled while the clock runs), with a time limit.
const outcome = (p) => p.then((value) => ({ value }), (error) => ({ error }));
const within = (o, ms = 2000) => Promise.race([o, new Promise((r) => setTimeout(() => r({ error: new Error('TIMEOUT: the reader never finished') }), ms))]);
const value = (r) => { if (r.error) throw r.error; return r.value; };

// The page's helpers and readers, compiled against stubs: a fake clock and interval timer, a question
// card that stays open until answered, and no-ops for everything that only paints.
function page() {
  let clock = 1e6;
  const timers = new Map();
  let nextTimer = 1;
  const questionOverlays = {};
  const shown = [];
  const stubs = {
    Date: { now: () => clock },
    setInterval: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms, due: clock + ms }); return id; },
    clearInterval: (id) => { timers.delete(id); },
    setTimeout: () => 0,
    console: { log() {}, warn() {}, error() {} },
    document: { getElementById: () => null },
    chats: {},
    questionOverlays,
    parseThinking: () => ({ thinking: '', stillThinking: false }),
    // Like the real card: on screen (in questionOverlays) until answered; answering removes it and resolves.
    showQuestionModal: (data) => new Promise((resolve) => {
      if (questionOverlays[data.request_id]) return resolve();
      questionOverlays[data.request_id] = { resolve };
      shown.push(data.request_id);
    }),
  };
  const env = new Proxy(stubs, {
    has: (t, k) => typeof k === 'string' && (k in t || !(k in globalThis)),
    get: (t, k) => (k in t ? t[k] : () => undefined),
  });
  const helpers = ['askFromStream'].filter((n) => APP.includes(`function ${n}(`));
  // Declared inside the block, so the readers find them before the stubs (an \`env.x = …\` here would hit the stub proxy).
  const body = `with (env) {\n${helpers.map((n) => `const ${n} = (${extract(APP, n)});`).join('\n')}\n` +
    `return { solo: (${extract(APP, 'streamResponseSolo')}), group: (${extract(APP, 'streamResponseGroup')}) }; }`;
  const fns = new Function('env', body)(env);
  return {
    ...fns,
    shown,
    // Move the clock in 1 s steps, running each interval when due and letting the reader react.
    async advance(ms) {
      const end = clock + ms;
      while (clock < end) {
        clock += 1000;
        for (const [id, t] of [...timers]) if (timers.has(id) && clock >= t.due) { t.due += t.ms; t.fn(); }
        await flush();
      }
    },
    answer(id) { const o = questionOverlays[id]; delete questionOverlays[id]; o.resolve(); },
    closedElsewhere(id) { delete questionOverlays[id]; },   // answered on the phone: the hub closes the card, nothing resolves it
  };
}

// A reply stream the test writes to. A cancelled reader reports done and drops what was queued (as in browsers).
function stream() {
  const enc = new TextEncoder();
  const queue = [];
  let waiter = null, ended = false, cancelled = false;
  const settle = (r) => { const w = waiter; waiter = null; w(r); };
  const reader = {
    read: () => (queue.length && !cancelled) ? Promise.resolve({ done: false, value: queue.shift() })
      : (ended || cancelled) ? Promise.resolve({ done: true, value: undefined })
      : new Promise((r) => { waiter = r; }),
    cancel: () => { cancelled = true; queue.length = 0; if (waiter) settle({ done: true, value: undefined }); return Promise.resolve(); },
  };
  return {
    response: { body: { getReader: () => reader } },
    get cancelled() { return cancelled; },
    beat() {   // the hub's heartbeat: an SSE comment
      if (cancelled || ended) return;
      const v = enc.encode(': heartbeat\n\n');
      if (waiter) settle({ done: false, value: v }); else queue.push(v);
    },
    send(obj) {
      if (cancelled || ended) return;
      const v = enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
      if (waiter) settle({ done: false, value: v }); else queue.push(v);
    },
    end() { ended = true; if (waiter && !queue.length) settle({ done: true, value: undefined }); },
  };
}
const text = (t) => ({ choices: [{ delta: { content: t } }] });
// Time passes with the card open and the connection alive: a heartbeat every 15 s, as the hub sends.
async function heartbeats(p, s, ms) { for (let t = 0; t < ms; t += 15000) { s.beat(); await p.advance(15000); } }
const question = (id) => ({ type: 'ask_user_question', request_id: id, questions: [{ question: 'Release it?', options: [{ label: 'Yes' }] }] });

test('app.js never waits for a question card inside a reply stream', () => {
  assert.doesNotMatch(APP, /await\s+showQuestionModal\(/);
  for (const fn of ['streamResponse', 'streamResponseSolo', 'streamResponseGroup']) {
    assert.match(extract(APP, fn), /askFromStream\(\w+, chatId\);/, `${fn}: questions go through askFromStream`);
  }
  assert.match(extract(APP, 'askFromStream'), /^function askFromStream\(data, chatId\) \{\s*showQuestionModal\(data, chatId\)\.catch\(\(\) => \{\}\);\s*\}$/);
});

test('a question answered after more than 90 s: the rest of the reply still shows (desktop chat)', async () => {
  const p = page(); const s = stream();
  const reply = outcome(p.solo(s.response, 'm1', 'c1', 'agent'));
  s.send(text('Before the question. '));
  s.send({ gateway: { type: 'ask_user_question', ...question('q1') } });
  await flush();
  assert.deepStrictEqual(p.shown, ['q1']);
  await heartbeats(p, s, 210_000);                // the card stays open 3½ minutes; the hub's heartbeats keep coming
  assert.strictEqual(s.cancelled, false, 'the stall check must not cut the reply while the card is open');
  p.answer('q1');
  s.send(text('After the answer.'));
  s.end();
  const out = value(await within(reply));
  assert.strictEqual(out.text, 'Before the question. After the answer.');
  assert.strictEqual(out.partial, false);
});

test('a question answered on another device: the reply still shows here', async () => {
  const p = page(); const s = stream();
  const reply = outcome(p.solo(s.response, 'm1', 'c1', 'agent'));
  s.send(question('q2'));
  await flush();
  await heartbeats(p, s, 30_000);
  p.closedElsewhere('q2');                         // the hub closes the card; nothing resolves its promise
  s.send(text('Answered on the phone.'));
  s.end();
  const out = value(await within(reply));
  assert.strictEqual(out.text, 'Answered on the phone.');
});

test('a real stall (no data, no open question) is reported as a lost connection, not a finished reply', async () => {
  const p = page(); const s = stream();
  const reply = outcome(p.solo(s.response, 'm1', 'c1', 'agent'));
  s.send(text('Partial '));
  await flush();
  await p.advance(100_000);
  assert.strictEqual(s.cancelled, true);
  // sendSoloMessage treats this message as a lost connection and re-attaches to the hub's turn
  const r = await within(reply);
  assert.match(String(r.error && r.error.message), /stall detected - stream died/);
});

test('a connection that dies while a card is open is still caught (the card stays; the page re-attaches)', async () => {
  const p = page(); const s = stream();
  const reply = outcome(p.solo(s.response, 'm1', 'c1', 'agent'));
  s.send(question('q3'));
  await flush();
  await heartbeats(p, s, 45_000);
  await p.advance(100_000);                       // then nothing at all: no heartbeat, no answer, no ask_user_done
  assert.strictEqual(s.cancelled, true, 'an open card must not keep a dead connection alive');
  const r = await within(reply);
  assert.match(String(r.error && r.error.message), /stall detected/);
});

test('a question answered after more than 90 s: the rest of the reply still shows (group chat)', async () => {
  const p = page(); const s = stream();
  const reply = outcome(p.group(s.response, 'm1', 'agent', 0, 'c1'));
  s.send(text('Before. '));
  s.send(question('q4'));
  await flush();
  assert.deepStrictEqual(p.shown, ['q4']);
  await heartbeats(p, s, 210_000);
  assert.strictEqual(s.cancelled, false);
  p.answer('q4');
  s.send(text('After.'));
  s.end();
  assert.strictEqual(value(await within(reply)), 'Before. After.');
});

test('group chat: a reply the stall check ended says it may be cut off instead of passing as complete', async () => {
  const p = page(); const s = stream();
  const reply = outcome(p.group(s.response, 'm1', 'agent', 0, 'c1'));
  s.send(text('Partial'));
  await flush();
  await p.advance(100_000);
  assert.strictEqual(s.cancelled, true);
  assert.strictEqual(value(await within(reply)), 'Partial\n\n⚠ The connection went quiet for 90 seconds, so this reply may be cut off.');
});
