'use strict';
// A person's message to an agent that is answering another agent waits its turn (queue_behind_consult) instead of being refused
// or sent into the consultation; the consultation queue yields to it; the person can take over (pause the consultation, which
// is queued again at the front with what it had written); a person's interjection into a consultation is refused.
// Everything runs in a throwaway install (nothing under the real data/ is touched); the turns are a test streamer.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('owner-queue-consult-');
const B = 'zz_oq_target', C = 'zz_oq_other';   // agents of this install
const A = 'zz_oq_caller', A2 = 'zz_oq_caller2';   // callers (not in the agents list: no delivery turns for them)
fs.writeFileSync(path.join(ISO.data, 'agents.json'), JSON.stringify([
  { name: B, model: 'claude-sdk/default', display: 'Target', category: 'primary' },
  { name: C, model: 'claude-sdk/default', display: 'Other', category: 'primary' },
]));

let server, sdkChat, T, cq;
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const until = async (fn, what, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await tick(10); } assert.fail(`timed out: ${what}`); };

// How each message behaves: a turn whose message has a gate waits for it (or for its abort); the rest end at once.
const revoked = new Set(); // accounts that lost access while their message waited
const admins = new Set();  // accounts that are admins right now (read again when a held message is released)
let handled = 0;           // route handlers that finished
const gates = new Map();   // message -> { open(), opened }
const starts = [];         // { agent, message, kind } in the order the turns began
const aborted = new Set(); // messages whose turn was aborted
function gate(message) { let open; const p = new Promise(r => { open = r; }); const g = { open, p, opened: false }; gates.set(message, g); const o = g.open; g.open = () => { g.opened = true; o(); }; return g; }

async function boot() {
  const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  process.env.PORT = String(port);
  sdkChat = require(path.join(ISO.lib, 'sdk-chat'));
  cq = require(path.join(ISO.lib, 'consult-queue'));
  T = sdkChat.__turn;
  T.setTestStreamer(async ({ agent, res, signal, message: full, ownerTurn, admin }) => {
    const message = full.replace(/^\[Consultation from agent "[^"]*"\]\n\n/, '').replace(/^\[This request was sent at[^\]]*\]\n\n/, '');
    const t = T.turnRegistry.get(agent);
    starts.push({ agent, message, kind: t && t.origin ? t.origin.kind : null, ownerTurn, admin });
    const consult = t && t.origin && t.origin.kind === 'consultation';
    if (consult && /partial/.test(message)) T.sendSSE(res, T.makeChunk('partial text ', 'm'));
    const g = [...gates].filter(([k]) => message.startsWith(k)).map(([, v]) => v).pop();
    if (g) {
      await new Promise(done => { if (signal.aborted) done(); else { signal.addEventListener('abort', done, { once: true }); g.p.then(done); } });
      if (signal.aborted) { aborted.add(message); return; }
      if (consult) T.sendSSE(res, T.makeChunk('final answer', 'm'));
    } else if (consult) T.sendSSE(res, T.makeChunk('quick answer', 'm'));
  });
  const hubAuth = require(path.join(ISO.lib, 'auth'));
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', async () => {
      const body = JSON.parse(raw || '{}');
      const service = !!req.headers[hubAuth.SERVICE_HEADER];   // the hub's own loopback call
      const token = !!req.headers['x-test-token'];
      const userId = req.headers['x-test-user'] || null;   // the signed-in account of this request (the real route takes it from the session)
      const session = req.headers['x-test-session'] || null;   // one browser session of the account (two sessions of one account can differ)
      const ctx = { service, person: !token && !service, userId, admin: !!userId && admins.has(userId), ...(userId ? { recheck: () => !revoked.has(userId) && !(session && revoked.has(`session:${session}`)), ownerTurnNow: () => admins.has(userId), refresh: () => ({ admin: admins.has(userId) }) } : {}) };
      await sdkChat.handleChatStream(body, res, ctx);
      handled++;
      if (!res.writableEnded) res.end();
    });
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
}
after(() => { try { T.setTestStreamer(null); } catch {} try { server.close(); server.closeAllConnections && server.closeAllConnections(); } catch {} });

/** A client of /api/chat/stream: events (parsed data lines), status, raw text, and whether it ended. */
function client(body, { token = false, user = null, session = null } = {}) {
  const c = { events: [], status: null, raw: '', ended: false, pings: 0 };
  const data = JSON.stringify(body);
  c.req = http.request({ hostname: '127.0.0.1', port: Number(process.env.PORT), path: '/api/chat/stream', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(token ? { 'x-test-token': '1' } : {}), ...(user ? { 'x-test-user': user } : {}), ...(session ? { 'x-test-session': session } : {}) } }, (res) => {
    c.status = res.statusCode;
    res.on('data', (chunk) => {
      c.raw += chunk;
      for (const line of chunk.toString().split('\n')) {
        if (line.startsWith('data: ')) { try { c.events.push(JSON.parse(line.slice(6))); } catch { /* [DONE] */ } }
        if (line.startsWith(': ping')) c.pings++;
      }
    });
    res.on('end', () => { c.ended = true; });
    res.on('close', () => { c.ended = true; });
  });
  c.req.on('error', () => { c.ended = true; });
  c.req.end(data);
  c.queued = () => c.events.filter(e => e.type === 'queued' || e.gateway && e.gateway.type === 'queued');
  return c;
}
const ofType = (c, type) => c.events.filter(e => e && e.type === type);
const person = (agent, message, extra = {}, opts = {}) => client({ agent, message, queue_behind_consult: true, ...extra }, opts);
const startedMessages = () => starts.map(s => s.message);

/** A consultation of `target` by `from` through the hub's own call path: the caller's promise, once the target's turn is running. */
const consultStart = async (from, message, workerId, target = B) => {
  const p = sdkChat.consultViaHub(target, message, workerId, null, from, {});
  await until(() => { const t = T.turnRegistry.get(target); return t && t.origin && t.origin.kind === 'consultation'; }, `consultation of ${target} running`);
  return { p };   // wrapped: returning the promise itself from an async function would wait for the whole call
};
const idle = async (agent) => { await until(() => !sdkChat.isAgentActive(agent), `${agent} idle`); };

test('boot', async () => { await boot(); });

test('(a) a person message waits behind a consultation: queued event at once, runs only after the consultation ends', async () => {
  const g = gate('consult-a'); starts.length = 0;
  const consultP = (await consultStart(A, 'consult-a', 'w-a')).p;
  const c = person(B, 'owner-a', { client_id: 'ca' });
  await until(() => c.queued().length >= 1, 'queued event');
  assert.strictEqual(c.status, 200);
  assert.deepStrictEqual(c.queued()[0], { type: 'queued', agent: B, behind: { kind: 'consultation', from: A }, position: 1, client_id: 'ca' });
  assert.strictEqual(sdkChat.ownerWaitersFor(B), 1);
  await tick(150);
  assert.ok(!startedMessages().includes('owner-a'), 'not started while the consultation runs');
  g.open();
  assert.match(await consultP, /final answer/);
  await until(() => startedMessages().includes('owner-a'), 'owner turn started');
  await until(() => c.ended, 'owner response ended');
  assert.strictEqual(sdkChat.ownerWaitersFor(B), 0);
  assert.deepStrictEqual(startedMessages(), ['consult-a', 'owner-a'], 'consultation first, then the owner');
  await idle(B);
});

test('(b) two waiters run in order, and the second waits for the first to finish', async () => {
  const g = gate('consult-b'), g1 = gate('owner-b1'); starts.length = 0;
  const consultP = (await consultStart(A, 'consult-b', 'w-b')).p;
  const c1 = person(B, 'owner-b1', { client_id: 'cb1' });
  await until(() => c1.queued().length >= 1, 'first queued');
  const c2 = person(B, 'owner-b2', { client_id: 'cb2' });
  await until(() => c2.queued().length >= 1, 'second queued');
  assert.strictEqual(c1.queued().at(-1).position, 1);
  assert.strictEqual(c2.queued().at(-1).position, 2);
  g.open(); await consultP;
  await until(() => startedMessages().includes('owner-b1'), 'first owner turn');
  await tick(150);
  assert.ok(!startedMessages().includes('owner-b2'), 'the second waits while the first runs');
  assert.strictEqual(c2.queued().at(-1).position, 1, 'its position moved up');
  g1.open();
  await until(() => c1.ended && c2.ended, 'both answered');
  assert.deepStrictEqual(starts.filter(s => /^owner-/.test(s.message)).map(s => s.message), ['owner-b1', 'owner-b2']);
  await idle(B);
});

test('(c) unchanged without the flag, from a token, and when the running turn is not a consultation', async () => {
  const g = gate('consult-c'); starts.length = 0;
  const consultP = (await consultStart(A, 'consult-c', 'w-c')).p;
  const plain = client({ agent: B, message: 'plain-c' });
  await until(() => plain.status !== null, 'plain answered');
  assert.strictEqual(plain.status, 409);
  const tok = client({ agent: B, message: 'token-c', queue_behind_consult: true, client_id: 'tk' }, { token: true });
  await until(() => tok.status !== null, 'token answered');
  assert.strictEqual(tok.status, 409);
  assert.strictEqual(sdkChat.ownerWaitersFor(B), 0);
  g.open(); await consultP; await idle(B);
  // the person's own turn is running: a second flagged message is refused as before
  const own = gate('own-c');
  const first = client({ agent: B, message: 'own-c' });
  await until(() => T.turnRegistry.get(B) && T.turnRegistry.get(B).origin.kind !== 'consultation', 'own turn running');
  const second = person(B, 'second-c', { client_id: 'c-second' });
  await until(() => second.status !== null, 'second answered');
  assert.strictEqual(second.status, 409);
  own.open(); await until(() => first.ended, 'own turn ended'); await idle(B);
});

test('(d) a repeated client_id moves the connection but keeps the first message; an id that already ran answers already_sent', async () => {
  const g = gate('consult-d'); starts.length = 0;
  const consultP = (await consultStart(A, 'consult-d', 'w-d')).p;
  const old = person(B, 'owner-d-old', { client_id: 'cd' });
  await until(() => old.queued().length >= 1, 'first queued');
  const other = person(B, 'owner-d-other', { client_id: 'cd-other' });
  await until(() => other.queued().length >= 1, 'other queued');
  const fresh = person(B, 'owner-d-new', { client_id: 'cd' });
  await until(() => fresh.queued().length >= 1, 'replacement queued');
  assert.strictEqual(fresh.queued()[0].position, 1, 'the new connection takes the same place');
  await until(() => ofType(old, 'replaced').length === 1 && old.ended, 'old response replaced and ended');
  assert.strictEqual(sdkChat.ownerWaitersFor(B), 2);
  g.open(); await consultP;
  await until(() => fresh.ended && other.ended, 'both ran');
  assert.deepStrictEqual(starts.filter(s => /^owner-/.test(s.message)).map(s => s.message), ['owner-d-old', 'owner-d-other'], 'the first message runs (its body is kept); the resend only carried the connection');
  const again = person(B, 'owner-d-again', { client_id: 'cd' });
  await until(() => again.ended, 'already_sent answered');
  assert.deepStrictEqual(ofType(again, 'already_sent'), [{ type: 'already_sent', client_id: 'cd' }]);
  assert.ok(!startedMessages().includes('owner-d-again'));
  await idle(B);
});

test('(e) the consultation queue yields to a waiting owner message', async () => {
  starts.length = 0;
  const job = cq.getConsultQueue().enqueue({ from: A2, to: B, prompt: 'queued-e' });
  assert.ok(job.ok);
  const fake = { agent: B, clientId: 'fake', res: { write() {}, end() {}, writableEnded: false }, dead: true };
  T.ownerWaiters.set(B, [fake]);
  T.drainConsultQueue(0);
  await tick(100);   // short: the 1 s poll must not release the stand-in waiter (it has no connection) inside this window
  assert.ok(!startedMessages().some(m => /queued-e/.test(m)), 'not started while an owner message waits');
  assert.strictEqual(cq.getConsultQueue().pendingFor(B).length, 1);
  T.ownerWaiters.delete(B);
  T.drainConsultQueue(0);
  await until(() => startedMessages().some(m => /queued-e/.test(m)), 'ran once nobody waits');
  await until(() => cq.getConsultQueue().pendingFor(B).length === 0, 'job done');
  cq.getConsultQueue().takeMailbox(A2);
  await idle(B);
});

test('(f) takeover: refused without a waiter and for a hand-off caller; otherwise the call is re-queued at the front and the answer reaches the caller\'s mailbox', async () => {
  starts.length = 0;
  assert.deepStrictEqual(sdkChat.takeoverConsultation(B, { clientId: 'x' }), { ok: false, error: 'This agent is not answering another agent right now.' });
  const g = gate('consult-f partial');
  const consultP = (await consultStart(A, 'consult-f partial', 'w-f')).p;
  // no waiter yet
  const none = sdkChat.takeoverConsultation(B, { clientId: 'cf' });
  assert.strictEqual(none.ok, false); assert.match(none.error, /nothing of yours is waiting/i);
  const gOwner = gate('owner-f');
  const c = person(B, 'owner-f', { client_id: 'cf' });
  await until(() => c.queued().length >= 1, 'owner waiting');
  const wrong = sdkChat.takeoverConsultation(B, { clientId: 'someone-else' });
  assert.strictEqual(wrong.ok, false);
  // a job already waiting for B is behind the paused one
  cq.getConsultQueue().enqueue({ from: A2, to: B, prompt: 'older-job-f' });
  await tick(100);   // the consultation has written its first words
  T.activeResponses.set(B, { fullResponse: '', startTs: Date.now(), lastSavedLength: 0, ephemeral: true });   // (the test streamer keeps no live record)
  const r = sdkChat.takeoverConsultation(B, { clientId: 'cf' });
  assert.deepStrictEqual(r, { ok: true, from: A });
  T.activeResponses.delete(B);
  const text = await consultP;
  assert.match(text, /^\[QUEUED\] "zz_oq_target" paused your request to answer the owner first; it resumes right after and the answer comes to you like any queued request \(ticket cq-[0-9a-f]{8}\)\.$/);
  assert.ok(!T.isStoppedResult(text), 'not the stopped text');
  assert.ok(aborted.has('consult-f partial'), 'the paused turn was aborted');
  const jobs = cq.getConsultQueue().pendingFor(B);
  assert.strictEqual(jobs[0].from, A, 'at the front');
  assert.strictEqual(jobs[1].prompt, 'older-job-f');
  assert.match(jobs[0].prompt, /^consult-f partial\n\n\[You were answering this when the owner asked you something first; it was paused and now resumes\. What you had written so far:\npartial text/);
  assert.strictEqual(T.pausedForOwner.size, 0, 'the mark is cleared');
  // the owner's waiting message runs next, before any queued consultation
  await until(() => startedMessages().includes('owner-f'), 'owner turn started');
  assert.strictEqual(startedMessages().filter(m => /older-job-f|consult-f/.test(m)).length, 1, 'no queued consultation started before the owner turn is done');
  gOwner.open(); await until(() => c.ended, 'owner done');
  // now the queue runs: the paused request first; its answer lands in the caller's mailbox
  g.open();
  gate('older-job-f');   // never opened: the second job must not matter for this check
  T.drainConsultQueue(0);
  await until(() => cq.getConsultQueue().mailboxCount(A) === 1, 'answer in the caller mailbox', 6000);
  const box = cq.getConsultQueue().takeMailbox(A);
  assert.strictEqual(box[0].to, B); assert.strictEqual(box[0].status, 'answered'); assert.match(box[0].result, /final answer/);
  const ran = starts.find(s => s.message.startsWith('consult-f partial') && /owner asked you something first/.test(s.message));
  assert.ok(ran, 'the resumed request carried the note');
  // the other caller's older job is next; clear it
  gates.get('older-job-f').open();
  await until(() => cq.getConsultQueue().pendingFor(B).length === 0, 'queue empty', 8000);
  cq.getConsultQueue().takeMailbox(A2);
  await idle(B);
});

test('(f2) takeover is refused when the caller is in a hand-off turn', async () => {
  const g = gate('consult-f2');
  T.handOffTurnAgents.set(A, 'ho-0123abcd');   // what a hand-off's turn records while it runs (the test streamer returns before that point)
  try {
    const consultP = (await consultStart(A, 'consult-f2', 'w-f2')).p;
    const c = person(B, 'owner-f2', { client_id: 'cf2' });
    await until(() => c.queued().length >= 1, 'owner waiting');
    T.activeResponses.set(B, { fullResponse: '', startTs: Date.now(), lastSavedLength: 0, ephemeral: true });
    const r = sdkChat.takeoverConsultation(B, { clientId: 'cf2' });
    T.activeResponses.delete(B);
    assert.strictEqual(r.ok, false); assert.match(r.error, /cannot be paused/);
    assert.strictEqual(T.turnRegistry.get(B).abortController.signal.aborted, false, 'nothing was stopped');
    assert.strictEqual(T.pausedForOwner.size, 0);
    g.open(); await consultP; await until(() => c.ended, 'owner ran after');
  } finally { T.handOffTurnAgents.delete(A); }
  await idle(B);
});

test('(g) takeover of a queued run annotates the job and keeps it queued (first)', async () => {
  starts.length = 0;
  const g = gate('queued-g partial');
  const job = cq.getConsultQueue().enqueue({ from: A, to: B, prompt: 'queued-g partial' });
  assert.ok(job.ok);
  T.drainConsultQueue(0);
  await until(() => T.turnRegistry.get(B) && T.turnRegistry.get(B).origin.kind === 'consultation', 'queued run started');
  const gOwner = gate('owner-g');
  const c = person(B, 'owner-g', { client_id: 'cg' });
  await until(() => c.queued().length >= 1, 'owner waiting');
  await tick(100);
  T.activeResponses.set(B, { fullResponse: '', startTs: Date.now(), lastSavedLength: 0, ephemeral: true });
  assert.deepStrictEqual(sdkChat.takeoverConsultation(B, { clientId: 'cg' }), { ok: true, from: A });
  T.activeResponses.delete(B);
  await until(() => startedMessages().includes('owner-g'), 'owner turn started');
  const pending = cq.getConsultQueue().pendingFor(B);
  assert.strictEqual(pending.length, 1, 'still queued');
  assert.strictEqual(pending[0].id, job.job.id);
  assert.match(pending[0].prompt, /queued-g partial\n\n\[You were answering this when the owner asked you something first; it was paused and now resumes\. What you had written so far:\npartial text/);
  assert.strictEqual((pending[0].prompt.match(/owner asked you something first/g) || []).length, 1, 'the note is added once');
  assert.strictEqual(cq.getConsultQueue().mailboxCount(A), 0, 'the caller was told nothing');
  assert.strictEqual(cq.getConsultQueue().annotate(job.job.id, pending[0].prompt.slice(pending[0].prompt.indexOf('\n\n[You were'))), true);
  assert.strictEqual((cq.getConsultQueue().pendingFor(B)[0].prompt.match(/owner asked you something first/g) || []).length, 1, 'annotating twice with the same note adds nothing');
  gOwner.open(); await until(() => c.ended, 'owner done');
  g.open();
  T.drainConsultQueue(0);
  await until(() => cq.getConsultQueue().mailboxCount(A) === 1, 'answer delivered', 6000);
  assert.match(cq.getConsultQueue().takeMailbox(A)[0].result, /final answer|quick answer/);
  await idle(B);
});

test('(h) a person\'s interjection into a consultation is refused with consultation:true; own turn, programs and no context unchanged', async () => {
  const mark = (on) => { if (on) T.activeResponses.set(B, { fullResponse: '', startTs: Date.now(), lastSavedLength: 0, ephemeral: true }); else T.activeResponses.delete(B); };
  const g = gate('consult-h');
  const consultP = (await consultStart(A, 'consult-h', 'w-h')).p;
  mark(true);
  const refused = sdkChat.handleInterjection({ agent: B, message: 'hello' }, { person: true });
  assert.deepStrictEqual(refused, { success: false, consultation: true, error: 'This agent is answering another agent; send your message normally and it runs next.' });
  const viaToken = sdkChat.handleInterjection({ agent: B, message: 'from a program' }, { person: false });
  assert.strictEqual(viaToken.success, true, 'a program token is unchanged');
  assert.strictEqual(sdkChat.handleInterjection({ agent: B, message: 'no context' }).success, true, 'internal callers are unchanged');
  mark(false);
  g.open(); await consultP; await idle(B);
  // the person's own turn: the interjection goes in as before
  const own = gate('own-h');
  const first = client({ agent: B, message: 'own-h' });
  await until(() => T.turnRegistry.get(B) && T.turnRegistry.get(B).origin.kind !== 'consultation', 'own turn running');
  mark(true);
  const ok = sdkChat.handleInterjection({ agent: B, message: 'steer' }, { person: true });
  assert.strictEqual(ok.success, true); assert.ok(!ok.consultation);
  mark(false);
  own.open(); await until(() => first.ended, 'own turn ended'); await idle(B);
});

// ── review fixes ──
const startedFile = () => path.join(ISO.data, 'owner-queue-started.json');

test('(i) a waiter and a receipt belong to a person: the same client_id from another person is a new request, takeover finds only its own', async () => {
  const g = gate('consult-i'); starts.length = 0;
  const consultP = (await consultStart(A, 'consult-i', 'w-i')).p;
  const sam = person(B, 'owner-i-sam', { client_id: 'ci' }, { user: 'sam' });
  await until(() => sam.queued().length >= 1, 'sam queued');
  const lee = person(B, 'owner-i-lee', { client_id: 'ci' }, { user: 'lee' });
  await until(() => lee.queued().length >= 1, 'lee queued');
  assert.strictEqual(sdkChat.ownerWaitersFor(B), 2, 'two waiters, nothing replaced');
  assert.strictEqual(ofType(sam, 'replaced').length, 0);
  assert.ok(!sam.ended);
  const refused = sdkChat.takeoverConsultation(B, { clientId: 'ci', userId: 'zed' });
  assert.strictEqual(refused.ok, false); assert.match(refused.error, /nothing of yours is waiting/i);
  assert.strictEqual(T.pausedForOwner.size, 0);
  g.open(); await consultP;
  await until(() => sam.ended && lee.ended, 'both ran');
  assert.deepStrictEqual(starts.filter(s => /^owner-/.test(s.message)).map(s => s.message), ['owner-i-sam', 'owner-i-lee']);
  const again = person(B, 'owner-i-again', { client_id: 'ci' }, { user: 'sam' });
  await until(() => again.ended, 'sam repeat answered');
  assert.strictEqual(ofType(again, 'already_sent').length, 1);
  // a third person with the same client_id is not told "already sent": it is a new request and runs
  const zed = person(B, 'owner-i-zed', { client_id: 'ci' }, { user: 'zed' });
  await until(() => zed.ended, 'zed ran');
  assert.strictEqual(ofType(zed, 'already_sent').length, 0);
  assert.ok(startedMessages().includes('owner-i-zed'));
  await idle(B);
});

test('(j) access is checked again when a held message is released: a person who lost access gets a 403 error and nothing starts; the next waiter runs', async () => {
  const g = gate('consult-j'); starts.length = 0;
  const consultP = (await consultStart(A, 'consult-j', 'w-j')).p;
  const lee = person(B, 'owner-j-lee', { client_id: 'cj1' }, { user: 'lee' });
  await until(() => lee.queued().length >= 1, 'lee queued');
  const sam = person(B, 'owner-j-sam', { client_id: 'cj2' }, { user: 'sam' });
  await until(() => sam.queued().length >= 1, 'sam queued');
  revoked.add('lee');
  try {
    g.open(); await consultP;
    await until(() => lee.ended && sam.ended, 'both answered');
    assert.deepStrictEqual(ofType(lee, 'error'), [{ type: 'error', error: 'You no longer have access to this agent.', status: 403 }]);
    assert.ok(!startedMessages().includes('owner-j-lee'), 'lee\'s message never started');
    assert.ok(startedMessages().includes('owner-j-sam'));
    assert.strictEqual(sdkChat.ownerWaitersFor(B), 0);
  } finally { revoked.delete('lee'); }
  await idle(B);
});

test('(k) a repeat with the same person and client_id keeps the first body and only moves the connection', async () => {
  const g = gate('consult-k'); starts.length = 0;
  const consultP = (await consultStart(A, 'consult-k', 'w-k')).p;
  const first = person(B, 'owner-k-first', { client_id: 'ck' }, { user: 'sam' });
  await until(() => first.queued().length >= 1, 'first queued');
  const second = person(B, 'owner-k-second', { client_id: 'ck', images: ['x'] }, { user: 'sam' });
  await until(() => second.queued().length >= 1 && ofType(first, 'replaced').length === 1 && first.ended, 'connection moved');
  assert.strictEqual(sdkChat.ownerWaitersFor(B), 1);
  g.open(); await consultP;
  await until(() => second.ended, 'second connection carried the turn');
  assert.deepStrictEqual(starts.filter(s => /^owner-/.test(s.message)).map(s => s.message), ['owner-k-first']);
  await idle(B);
});

test('(l) the started receipt lasts hours, is kept in data/owner-queue-started.json (0600) and survives a restart; stale or damaged files are handled', async () => {
  starts.length = 0;
  const c = person(B, 'owner-l', { client_id: 'cl' }, { user: 'sam' });
  await until(() => c.ended, 'ran');
  const list = JSON.parse(fs.readFileSync(startedFile(), 'utf8'));
  const mine = list.find(e => e.key === `${B}\0sam\0cl`);
  assert.ok(mine && Number.isFinite(mine.at), 'the receipt is on disk');
  assert.strictEqual(fs.statSync(startedFile()).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(startedFile() + '.tmp'), 'written atomically');
  // a restart: memory is gone, the file is read
  T.resetOwnerStarted();
  const again = person(B, 'owner-l-again', { client_id: 'cl' }, { user: 'sam' });
  await until(() => again.ended, 'repeat answered');
  assert.strictEqual(ofType(again, 'already_sent').length, 1, 'known again after a restart');
  // 5 hours old still counts, 7 hours old is dropped
  fs.writeFileSync(startedFile(), JSON.stringify([{ key: `${B}\0sam\0c5h`, at: Date.now() - 5 * 3600 * 1000 }, { key: `${B}\0sam\0c7h`, at: Date.now() - 7 * 3600 * 1000 }]));
  T.resetOwnerStarted();
  const c5 = person(B, 'owner-l-5h', { client_id: 'c5h' }, { user: 'sam' });
  await until(() => c5.ended, '5h answered');
  assert.strictEqual(ofType(c5, 'already_sent').length, 1, 'a receipt of 5 hours still answers already_sent');
  const c7 = person(B, 'owner-l-7h', { client_id: 'c7h' }, { user: 'sam' });
  await until(() => c7.ended, '7h ran');
  assert.strictEqual(ofType(c7, 'already_sent').length, 0);
  // a damaged file is kept as .bad and the store is unusable: nothing runs until it is repaired (see (p))
  fs.writeFileSync(startedFile(), '{not json');
  T.resetOwnerStarted();
  const bad = person(B, 'owner-l-bad', { client_id: 'cl' }, { user: 'sam' });
  await until(() => bad.ended, 'refused with a damaged file');
  assert.strictEqual(ofType(bad, 'already_sent').length, 0);
  assert.strictEqual(ofType(bad, 'error')[0].status, 503);
  assert.ok(!startedMessages().includes('owner-l-bad'));
  assert.strictEqual(fs.readFileSync(startedFile() + '.bad', 'utf8'), '{not json');
  fs.writeFileSync(startedFile(), '[]');
  T.resetOwnerStarted();
  await idle(B);
});

test('(m) a held request whose client disconnects settles its handler, leaves the queue, and no turn starts', async () => {
  const g = gate('consult-m'); starts.length = 0;
  const consultP = (await consultStart(A, 'consult-m', 'w-m')).p;
  const before = handled;
  const c = person(B, 'owner-m', { client_id: 'cm' }, { user: 'sam' });
  await until(() => c.queued().length >= 1, 'queued');
  c.req.destroy();
  await until(() => sdkChat.ownerWaitersFor(B) === 0, 'left the queue');
  await until(() => handled === before + 1, 'the route handler settled');
  g.open(); await consultP; await idle(B);
  await tick(150);
  assert.ok(!startedMessages().includes('owner-m'), 'no turn started');
});

test('(n) annotate keeps one pause note: a new one replaces the old one', () => {
  const q = new cq.ConsultQueue({ file: path.join(ISO.data, 'annotate-test.json') });
  const job = q.enqueue({ from: A, to: B, prompt: 'do the thing' });
  const note = (t) => `\n\n[You were answering this when the owner asked you something first; it was paused and now resumes. What you had written so far:\n${t}]`;
  assert.strictEqual(q.annotate(job.job.id, note('one')), true);
  assert.strictEqual(q.annotate(job.job.id, note('two')), true);
  assert.strictEqual(q.annotate(job.job.id, note('three')), true);
  const p = q.pendingFor(B)[0].prompt;
  assert.strictEqual(p, 'do the thing' + note('three'));
  assert.strictEqual((p.match(/owner asked you something first/g) || []).length, 1);
  assert.strictEqual(q.annotate(job.job.id, note('three')), true);
  assert.strictEqual(q.pendingFor(B)[0].prompt, p, 'the same note twice changes nothing');
});

test('(o) takeover is refused when the turn has already finished writing (no live record)', async () => {
  const g = gate('consult-o'); starts.length = 0;
  const consultP = (await consultStart(A, 'consult-o', 'w-o')).p;
  const c = person(B, 'owner-o', { client_id: 'co' }, { user: 'sam' });
  await until(() => c.queued().length >= 1, 'queued');
  T.activeResponses.delete(B);
  const r = sdkChat.takeoverConsultation(B, { clientId: 'co', userId: 'sam' });
  assert.deepStrictEqual(r, { ok: false, error: 'This request is just finishing; your message runs in a moment.' });
  assert.strictEqual(T.turnRegistry.get(B).abortController.signal.aborted, false, 'nothing was stopped');
  assert.strictEqual(T.pausedForOwner.size, 0);
  g.open(); await consultP;
  await until(() => c.ended, 'owner ran after');
  await idle(B);
});

const REFUSED = { type: 'error', error: 'Your Maestro could not record this message, so it was not run. Try again in a moment.', status: 503, retry: true };

test('(p) a corrupt receipts file refuses (503, retry) and runs nothing until it is repaired; a missing file is just empty', async () => {
  starts.length = 0;
  fs.rmSync(startedFile(), { force: true });
  T.resetOwnerStarted();
  const fine = person(B, 'owner-p-enoent', { client_id: 'cp0' }, { user: 'sam' });
  await until(() => fine.ended, 'ran with no file');
  assert.deepStrictEqual(ofType(fine, 'error'), []);
  assert.ok(startedMessages().includes('owner-p-enoent'), 'a missing file is empty, not an error');
  for (const damaged of ['{"a":1}', '[1,', '']) {
    starts.length = 0;
    fs.writeFileSync(startedFile(), damaged);
    T.resetOwnerStarted();
    const c = person(B, 'owner-p-bad', { client_id: 'cp1' }, { user: 'sam' });
    await until(() => c.ended, `refused (${damaged})`);
    assert.deepStrictEqual(ofType(c, 'error'), [REFUSED]);
    assert.strictEqual(startedMessages().length, 0, 'no turn ran');
    // still refused at once while the file is damaged (the load is tried again at most once a minute)
    const c2 = person(B, 'owner-p-bad', { client_id: 'cp1' }, { user: 'sam' });
    await until(() => c2.ended, 'refused again');
    assert.deepStrictEqual(ofType(c2, 'error'), [REFUSED]);
    // repaired: the next request after the retry window clears the mark and runs
    fs.writeFileSync(startedFile(), '[]');
    T.ownerStartedRetryNow();
    const ok = person(B, 'owner-p-ok', { client_id: 'cp1' }, { user: 'sam' });
    await until(() => ok.ended, 'ran after repair');
    assert.deepStrictEqual(ofType(ok, 'error'), []);
    assert.deepStrictEqual(startedMessages(), ['owner-p-ok']);
    assert.strictEqual(T.ownerStartedUnusable(), false);
  }
  await idle(B);
});

test('(q) a receipt that cannot be written refuses (503, retry), runs no turn, and a repeat is a new message, not already_sent', async () => {
  starts.length = 0;
  fs.writeFileSync(startedFile(), '[]');
  T.resetOwnerStarted();
  // the data folder's receipt path is made unwritable: a directory sits where the temporary file goes
  const tmp = startedFile() + '.tmp';
  fs.mkdirSync(tmp);
  try {
    const c = person(B, 'owner-q', { client_id: 'cq1' }, { user: 'sam' });
    await until(() => c.ended, 'refused');
    assert.deepStrictEqual(ofType(c, 'error'), [REFUSED]);
    assert.strictEqual(startedMessages().length, 0);
    const again = person(B, 'owner-q', { client_id: 'cq1' }, { user: 'sam' });
    await until(() => again.ended, 'refused again');
    assert.strictEqual(ofType(again, 'already_sent').length, 0, 'nothing was recorded');
    assert.deepStrictEqual(ofType(again, 'error'), [REFUSED]);
  } finally { fs.rmdirSync(tmp); }
  const ok = person(B, 'owner-q', { client_id: 'cq1' }, { user: 'sam' });
  await until(() => ok.ended, 'ran once writable');
  assert.deepStrictEqual(startedMessages(), ['owner-q']);
  await idle(B);
});

test('(r) a held message whose receipt cannot be written gets the 503 error and the next waiter stays in place and runs', async () => {
  const g = gate('consult-r'); starts.length = 0;
  fs.writeFileSync(startedFile(), '[]');
  T.resetOwnerStarted();
  const consultP = (await consultStart(A, 'consult-r', 'w-r')).p;
  const first = person(B, 'owner-r-first', { client_id: 'cr1' }, { user: 'sam' });
  await until(() => first.queued().length >= 1, 'first queued');
  const second = person(B, 'owner-r-second', { client_id: 'cr2' }, { user: 'lee' });
  await until(() => second.queued().length >= 1, 'second queued');
  const tmp = startedFile() + '.tmp';
  fs.mkdirSync(tmp);
  g.open(); await consultP;
  try {
    await until(() => first.ended, 'first refused');
    assert.deepStrictEqual(ofType(first, 'error'), [REFUSED]);
    assert.ok(!startedMessages().includes('owner-r-first'));
    assert.strictEqual(sdkChat.ownerWaitersFor(B), 1, 'the next waiter stays in place');
  } finally { fs.rmdirSync(tmp); }
  await until(() => second.ended, 'second ran once the store could be written');
  assert.ok(startedMessages().includes('owner-r-second'));
  assert.ok(!startedMessages().includes('owner-r-first'));
  await idle(B);
});

test('(s) expect_user: another account signed in since gets a 409 error, nothing held or run, not even already_sent', async () => {
  starts.length = 0;
  fs.writeFileSync(startedFile(), '[]');
  T.resetOwnerStarted();
  const g = gate('consult-s');
  const consultP = (await consultStart(A, 'consult-s', 'w-s')).p;
  const wrong = person(B, 'owner-s-wrong', { client_id: 'cs1', expect_user: 'sam' }, { user: 'lee' });
  await until(() => wrong.ended, 'refused');
  assert.deepStrictEqual(ofType(wrong, 'error'), [{ type: 'error', error: 'Signed in as someone else: this message was not sent.', status: 409 }]);
  assert.strictEqual(sdkChat.ownerWaitersFor(B), 0, 'not held');
  // the same account (and "no accounts" = '') is held as usual
  const mine = person(B, 'owner-s-mine', { client_id: 'cs2', expect_user: 'lee' }, { user: 'lee' });
  await until(() => mine.queued().length >= 1, 'queued');
  const blank = person(B, 'owner-s-blank', { client_id: 'cs3', expect_user: '' }, { user: 'lee' });
  await until(() => blank.ended, 'blank refused');
  assert.strictEqual(ofType(blank, 'error')[0].status, 409, "'' is a person too: an account is signed in now");
  g.open(); await consultP;
  await until(() => mine.ended, 'mine ran');
  assert.deepStrictEqual(starts.filter(s => /^owner-/.test(s.message)).map(s => s.message), ['owner-s-mine']);
  // already_sent is not shown to the wrong account either
  const stale = person(B, 'owner-s-mine', { client_id: 'cs2', expect_user: 'sam' }, { user: 'lee' });
  await until(() => stale.ended, 'stale answered');
  assert.deepStrictEqual(ofType(stale, 'already_sent'), []);
  assert.strictEqual(ofType(stale, 'error')[0].status, 409);
  await idle(B);
});

test('(t) release uses the account as it is now: an admin demoted while the message waited runs as a member with owner_turn false', async () => {
  const g = gate('consult-t'); starts.length = 0;
  fs.writeFileSync(startedFile(), '[]');
  T.resetOwnerStarted();
  admins.add('ada');
  const consultP = (await consultStart(A, 'consult-t', 'w-t')).p;
  const held = person(B, 'owner-t-ada', { client_id: 'ct1' }, { user: 'ada' });
  await until(() => held.queued().length >= 1, 'queued');
  admins.delete('ada');   // demoted, but still allowed to use the agent
  g.open(); await consultP;
  await until(() => held.ended, 'ran');
  const run = starts.find(s => s.message === 'owner-t-ada');
  assert.ok(run, 'it still runs');
  assert.strictEqual(run.admin, false, 'the context is the fresh account');
  assert.strictEqual(run.ownerTurn, false);
  // control: an admin who stays an admin keeps both
  admins.add('ada');
  const g2 = gate('consult-t2');
  const consult2 = (await consultStart(A, 'consult-t2', 'w-t2')).p;
  const held2 = person(B, 'owner-t-ada2', { client_id: 'ct2' }, { user: 'ada' });
  await until(() => held2.queued().length >= 1, 'queued 2');
  g2.open(); await consult2;
  await until(() => held2.ended, 'ran 2');
  const run2 = starts.find(s => s.message === 'owner-t-ada2');
  assert.strictEqual(run2.admin, true); assert.strictEqual(run2.ownerTurn, true);
  admins.delete('ada');
  await idle(B);
});

test('(u) the receipt is claimed at dispatch: a retry queued while the store was unreadable, store back with the original receipt before release -> already_sent, no turn', async () => {
  starts.length = 0;
  fs.writeFileSync(startedFile(), '[1,');
  T.resetOwnerStarted();
  const g = gate('consult-u');
  const consultP = (await consultStart(A, 'consult-u', 'w-u')).p;
  const retry = person(B, 'owner-u', { client_id: 'cu1' }, { user: 'sam' });
  await until(() => retry.queued().length >= 1, 'queued although the store is unreadable');
  assert.strictEqual(T.ownerStartedUnusable(), true);
  // the store comes back, holding the receipt of the original send
  fs.writeFileSync(startedFile(), JSON.stringify([{ key: `${B}\0sam\0cu1`, at: Date.now() }]));
  T.ownerStartedRetryNow();
  g.open(); await consultP;
  await until(() => retry.ended, 'released and answered');
  assert.deepStrictEqual(ofType(retry, 'already_sent'), [{ type: 'already_sent', client_id: 'cu1' }]);
  assert.deepStrictEqual(ofType(retry, 'error'), []);
  assert.ok(!startedMessages().includes('owner-u'), 'no turn ran');
  assert.strictEqual(sdkChat.ownerWaitersFor(B), 0);
  await idle(B);
});

test('(v) a same-person reconnect carries the new session: the new session revoked -> release refused (403), no turn', async () => {
  starts.length = 0;
  fs.writeFileSync(startedFile(), '[]');
  T.resetOwnerStarted();
  const g = gate('consult-v');
  const consultP = (await consultStart(A, 'consult-v', 'w-v')).p;
  const first = person(B, 'owner-v', { client_id: 'cv1' }, { user: 'sam', session: 'sA' });
  await until(() => first.queued().length >= 1, 'first queued');
  const second = person(B, 'owner-v', { client_id: 'cv1' }, { user: 'sam', session: 'sB' });
  await until(() => second.queued().length >= 1 && ofType(first, 'replaced').length === 1, 'connection moved');
  revoked.add('session:sB');
  try {
    g.open(); await consultP;
    await until(() => second.ended, 'second answered');
    assert.deepStrictEqual(ofType(second, 'error'), [{ type: 'error', error: 'You no longer have access to this agent.', status: 403 }]);
    assert.ok(!startedMessages().includes('owner-v'), 'no turn ran');
  } finally { revoked.delete('session:sB'); }
  await idle(B);
});

test('(w) a same-person reconnect carries the new session: the original session revoked -> the message runs for the new one', async () => {
  starts.length = 0;
  fs.writeFileSync(startedFile(), '[]');
  T.resetOwnerStarted();
  const g = gate('consult-w');
  const consultP = (await consultStart(A, 'consult-w', 'w-w')).p;
  const first = person(B, 'owner-w', { client_id: 'cw1' }, { user: 'sam', session: 'sA' });
  await until(() => first.queued().length >= 1, 'first queued');
  const second = person(B, 'owner-w', { client_id: 'cw1' }, { user: 'sam', session: 'sB' });
  await until(() => second.queued().length >= 1 && ofType(first, 'replaced').length === 1, 'connection moved');
  revoked.add('session:sA');
  try {
    g.open(); await consultP;
    await until(() => second.ended, 'second answered');
    assert.deepStrictEqual(ofType(second, 'error'), []);
    assert.ok(startedMessages().includes('owner-w'), 'the message ran');
  } finally { revoked.delete('session:sA'); }
  await idle(B);
});
