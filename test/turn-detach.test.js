'use strict';
// A browser disconnect detaches a turn instead of aborting it; POST /api/chat/stop aborts it.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const sdkChat = require('../lib/sdk-chat');
const hubEvents = require('../lib/hub-events');
const { sendSSE, makeChunk, turnRegistry, pendingToolConfirms, setTestStreamer } = sdkChat.__turn;
const { runAskUser, questionAgents, pendingQuestions } = sdkChat.__askUser;

const AGENTS = ['zz_detach_a', 'zz_detach_b', 'zz_detach_c', 'zz_detach_d', 'zz_detach_e'];
const convDir = path.join(__dirname, '..', 'data', 'conversations');
fs.mkdirSync(convDir, { recursive: true });
after(() => { setTestStreamer(null); for (const a of AGENTS) try { fs.unlinkSync(path.join(convDir, `${a}.jsonl`)); } catch {} });

const events = [];
hubEvents.events.onPublish(ev => events.push(ev));
const of = (type, agent) => events.filter(e => e.type === type && e.agent === agent);
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

// a browser response whose 'close' the test fires by hand
function browserRes() {
  const handlers = {};
  const res = {
    writableEnded: false, destroyed: false, written: [],
    on(ev, fn) { (handlers[ev] ||= []).push(fn); },
    writeHead() {},
    write(s) { if (this.destroyed) throw new Error('write after destroy'); this.written.push(s); return true; },
    end() { this.writableEnded = true; (handlers.close || []).forEach(f => f()); },
    disconnect() { this.destroyed = true; (handlers.close || []).forEach(f => f()); },
  };
  return res;
}

// stands in for the model: streams text through sendSSE, waits for a gate, streams more, then ends
function gatedStreamer() {
  const gate = {}; gate.promise = new Promise(r => { gate.open = r; });
  const seen = { signal: null, afterClose: [] };
  setTestStreamer(async ({ res, signal }) => {
    seen.signal = signal;
    sendSSE(res, makeChunk('first ', 'm'));
    await Promise.race([gate.promise, new Promise(r => signal.addEventListener('abort', r, { once: true }))]);
    seen.afterClose.push(sendSSE(res, makeChunk('second', 'm')));
  });
  return { gate, seen };
}

test('browser close mid-turn detaches the turn: signal stays live, later writes are safe no-ops, the reply still reaches /api/events', async () => {
  const agent = AGENTS[0];
  const { gate, seen } = gatedStreamer();
  const res = browserRes();
  const run = sdkChat.handleChatStream({ agent, message: 'hello' }, res);
  await tick(20);
  const t = turnRegistry.get(agent);
  assert.ok(t, 'registered while running');
  assert.strictEqual(t.detached, false);

  res.disconnect();
  assert.strictEqual(t.detached, true);
  assert.strictEqual(seen.signal.aborted, false, 'close must not abort');

  assert.doesNotThrow(() => sendSSE(res, makeChunk('x', 'm')));
  assert.strictEqual(sendSSE(res, makeChunk('x', 'm')), false);
  res.write = () => { throw new Error('EPIPE'); };      // even a broken socket is swallowed
  res.destroyed = false;
  assert.doesNotThrow(() => sendSSE(res, makeChunk('y', 'm')));
  res.destroyed = true;

  gate.open();
  await run;
  assert.deepStrictEqual(seen.afterClose, [false]);
  assert.strictEqual(turnRegistry.has(agent), false, 'removed when the turn ends');
  const [end] = of('turn_end', agent);
  assert.ok(end, 'turn_end published');
  assert.strictEqual(end.ok, true);
  assert.strictEqual(end.reply, 'first xxsecond', 'text written after the browser left is still captured');
});

test('stopAgentTurn aborts a running turn, attached or detached, and reports it', async () => {
  const agent = AGENTS[1];
  const { seen } = gatedStreamer();
  const res = browserRes();
  const run = sdkChat.handleChatStream({ agent, message: 'long job' }, res);
  await tick(20);
  res.disconnect();
  assert.strictEqual(seen.signal.aborted, false);
  assert.deepStrictEqual(sdkChat.stopAgentTurn(agent), { ok: true, stopped: true });
  assert.strictEqual(seen.signal.aborted, true);
  await run;
  assert.deepStrictEqual(sdkChat.stopAgentTurn(agent), { ok: false, error: 'not running' });
  assert.strictEqual(turnRegistry.has(agent), false);
  const [end] = of('turn_end', agent);
  assert.strictEqual(end.ok, false);
  assert.strictEqual(end.error, 'stopped');
  assert.deepStrictEqual(sdkChat.stopAgentTurn('zz_never_ran'), { ok: false, error: 'not running' });
});

test('Stop also denies a tool confirm the turn is waiting on', async () => {
  const agent = AGENTS[2];
  gatedStreamer();
  const res = browserRes();
  const run = sdkChat.handleChatStream({ agent, message: 'm' }, res);
  await tick(20);
  const answer = new Promise(resolve => pendingToolConfirms.set('tc_test_stop', { resolve, agent }));
  sdkChat.stopAgentTurn(agent);
  assert.strictEqual(await answer, false);
  assert.strictEqual(pendingToolConfirms.has('tc_test_stop'), false);
  await run;
});

test('getAgentStatuses: busy, busySince, activity and pendingQuestion', async () => {
  const idle = sdkChat.getAgentStatuses()[AGENTS[3]];
  assert.deepStrictEqual(idle || { busy: false, busySince: null, activity: null, pendingQuestion: false }, { busy: false, busySince: null, activity: null, pendingQuestion: false });

  const { gate } = gatedStreamer();
  const res = browserRes();
  const user = sdkChat.handleChatStream({ agent: AGENTS[3], message: 'm' }, res);
  await tick(20);
  let st = sdkChat.getAgentStatuses()[AGENTS[3]];
  assert.deepStrictEqual(Object.keys(st).sort(), ['activity', 'busy', 'busySince', 'pendingQuestion']);
  assert.strictEqual(st.busy, true);
  assert.strictEqual(st.activity, 'replying to you');
  assert.ok(!isNaN(Date.parse(st.busySince)));
  assert.strictEqual(st.pendingQuestion, false);

  const ask = runAskUser(AGENTS[3], res, { question: 'Sure?', options: ['y', 'n'] });
  await tick();
  assert.strictEqual(sdkChat.getAgentStatuses()[AGENTS[3]].pendingQuestion, true);
  const rid = [...questionAgents].find(([, a]) => a === AGENTS[3])[0];
  sdkChat.handleAskResponse({ request_id: rid, answers: { 0: 'y' } });
  assert.strictEqual(await ask, 'y');
  assert.strictEqual(sdkChat.getAgentStatuses()[AGENTS[3]].pendingQuestion, false);
  gate.open();
  await user;
  assert.strictEqual(!!sdkChat.getAgentStatuses()[AGENTS[3]]?.busy, false);

  for (const [origin, label] of [
    [{ kind: 'consultation', from: 'maestro' }, 'consulted by maestro'],
    [{ kind: 'schedule', from: 'Nightly check' }, 'scheduled task: Nightly check'],
    [{ kind: 'job_report', from: 'w' }, 'job report'],
    [{ kind: 'job_notice' }, 'job finished'],
    [{ kind: 'alert', from: 'monitor' }, 'alert'],
    [{ kind: 'task' }, 'working'],
  ]) {
    const g = gatedStreamer();
    const p = sdkChat.handleChatStream({ agent: AGENTS[4], message: 'm', origin }, { ...browserRes(), on() {} });
    await tick(20);
    assert.strictEqual(sdkChat.getAgentStatuses()[AGENTS[4]].activity, label);
    g.gate.open(); await p;
  }
});

test('a detached turn can still ask: the question is published and answerable; an ended response cannot ask', async () => {
  const agent = AGENTS[0];
  const res = browserRes();
  res.disconnect();                                   // destroyed, never ended
  const before = of('ask_user', agent).length;
  const p = runAskUser(agent, res, { question: 'Still there?' });
  await tick();
  const [ev] = of('ask_user', agent).slice(before);
  assert.ok(ev && ev.request_id && pendingQuestions.has(ev.request_id));
  sdkChat.handleAskResponse({ request_id: ev.request_id, answers: { 0: 'yes' } });
  assert.strictEqual(await p, 'yes');

  const ended = browserRes(); ended.writableEnded = true;
  assert.match(await runAskUser(agent, ended, { question: 'x' }), /unavailable/);
});
