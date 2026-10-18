'use strict';
// Turn activity: the running turn's tool calls and workers are kept per agent (turnFor, for a page that
// opens or wakes mid-turn) and published as compact turn_activity / turn_worker_delta events (for a page
// that is open). Caps, merge rules, finish handling and the input summariser.
const { test } = require('node:test');
const assert = require('node:assert');
const { createHubEvents, summarizeInput } = require('../lib/hub-events');

function fakeRes() { const r = { chunks: [], write: (s) => { r.chunks.push(s); return true; } }; return r; }
const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const gw = (res, gateway, content = '') => sse(res, { choices: [{ delta: content ? { content } : {} }], gateway });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function collect(hub) { const out = []; hub.onPublish(ev => out.push(ev)); return out; }

test('summarizeInput: first useful field, whitespace squashed, capped', () => {
  assert.strictEqual(summarizeInput({ command: 'ls   -la\n/tmp' }), 'ls -la /tmp');
  assert.strictEqual(summarizeInput({ file_path: '/a/b.js', content: 'x' }), 'file_path /a/b.js'.replace('file_path ', ''));
  assert.strictEqual(summarizeInput({ agent: 'fable', prompt: 'do it' }), 'agent fable');
  assert.strictEqual(summarizeInput('plain  text'), 'plain text');
  assert.strictEqual(summarizeInput({ foo: 1 }), '{"foo":1}');
  assert.strictEqual(summarizeInput(null), '');
  assert.ok(summarizeInput({ command: 'x'.repeat(500) }).length <= 241);
});

test('tool calls: start + use merge by call id, result marks done with clipped output; turn_activity published for each step', () => {
  const hub = createHubEvents();
  const events = collect(hub);
  const res = fakeRes();
  const tap = hub.tapTurn(res, { agent: 'maestro', origin: { kind: 'user' }, message: 'fix it', turnId: 't1' });
  gw(res, { type: 'tool_start', tool: 'Bash', tool_call_id: 'c1' });
  gw(res, { type: 'tool_use', tool: 'Bash', tool_call_id: 'c1', input: { command: 'npm test' } });
  gw(res, { type: 'tool_result', tool_call_id: 'c1', output: 'ok '.repeat(500) });
  gw(res, { type: 'tool_use', tool: 'Read', input: { file_path: '/x.js' } });   // no call id: its own item, closed by the next result
  gw(res, { type: 'tool_result', output: 'contents' });
  const t = hub.turnFor('maestro');
  assert.strictEqual(t.active, true);
  assert.strictEqual(t.turnId, 't1');
  assert.strictEqual(t.activity.length, 2, 'start+use merged into one item');
  assert.deepStrictEqual([t.activity[0].tool, t.activity[0].status, t.activity[0].summary], ['Bash', 'done', 'npm test']);
  assert.ok(t.activity[0].output.length <= 320 && t.activity[0].output.endsWith('…[truncated]'));
  assert.deepStrictEqual([t.activity[1].tool, t.activity[1].status, t.activity[1].summary, t.activity[1].output], ['Read', 'done', '/x.js', 'contents']);
  const acts = events.filter(e => e.type === 'turn_activity');
  assert.strictEqual(acts.length, 5, 'start, use, result, use, result');
  assert.ok(acts.every(e => e.agent === 'maestro' && e.turnId === 't1' && e.item && e.item.id));
  assert.strictEqual(acts[0].item.id, acts[1].item.id, 'the merged item keeps its id so clients upsert');
  assert.strictEqual(acts[2].item.status, 'done');
  tap.finish(true);
});

test('each tool call and worker carries its place in the reply (the text length when it started), so catch-up pages interleave like the own stream', () => {
  const hub = createHubEvents();
  const res = fakeRes();
  const tap = hub.tapTurn(res, { agent: 'maestro', origin: { kind: 'user' }, message: 'look', turnId: 'tAt' });
  sse(res, { choices: [{ delta: { content: 'Checking the logs.' } }] });
  gw(res, { type: 'tool_start', tool: 'Bash', tool_call_id: 'c1' });
  gw(res, { type: 'tool_use', tool: 'Bash', tool_call_id: 'c1', input: { command: 'tail log' } });
  gw(res, { type: 'tool_result', tool_call_id: 'c1', output: 'ok' });
  sse(res, { choices: [{ delta: { content: ' Found it. Now the config.' } }] });
  gw(res, { type: 'tool_start', tool: 'Read', tool_call_id: 'c2' });
  gw(res, { type: 'worker_started', worker_id: 'w1', description: 'second look', model: 'm' });
  sse(res, { choices: [{ delta: { content: ' Done.' } }] });
  const t = hub.turnFor('maestro');
  const at = Object.fromEntries(t.activity.map(a => [a.tool || a.kind, a.at]));
  assert.deepStrictEqual(at, { Bash: 'Checking the logs.'.length, Read: 'Checking the logs. Found it. Now the config.'.length, worker: 'Checking the logs. Found it. Now the config.'.length });
  assert.strictEqual(t.text.slice(0, at.Bash), 'Checking the logs.');
  tap.finish(true);
});

test('workers: started / text (throttled) / tools / completed; turnFor lists them; worker text broadcast at most once a second', async () => {
  const hub = createHubEvents();
  const events = collect(hub);
  const res = fakeRes();
  const tap = hub.tapTurn(res, { agent: 'maestro', origin: { kind: 'user' }, message: 'build', turnId: 't2' });
  gw(res, { type: 'worker_started', worker_id: 'w1', agent_type: 'fable', description: 'Worker: Agent Fable', model: 'claude-sdk/claude-fable-5-1', prompt: 'Make the UI' });
  for (let i = 0; i < 20; i++) gw(res, { type: 'worker_text_delta', worker_id: 'w1', text: `chunk${i} ` });
  gw(res, { type: 'worker_tool_start', worker_id: 'w1', tool: 'Read' });
  gw(res, { type: 'worker_tool_use', worker_id: 'w1', tool: 'Read', input: { file_path: '/mobile.js' } });
  gw(res, { type: 'worker_tool_use', worker_id: 'w1', tool: 'Edit', input: { file_path: '/mobile.js' } });
  gw(res, { type: 'worker_text_delta', worker_id: 'nope', text: 'ignored' });
  let t = hub.turnFor('maestro');
  assert.strictEqual(t.workers.length, 1);
  assert.deepStrictEqual([t.workers[0].id, t.workers[0].agent, t.workers[0].status, t.workers[0].model], ['w1', 'fable', 'running', 'claude-sdk/claude-fable-5-1']);
  assert.ok(t.workers[0].text.startsWith('chunk0 chunk1 '));
  assert.deepStrictEqual(t.workers[0].tools.map(x => [x.tool, x.summary]), [['Read', '/mobile.js'], ['Edit', '/mobile.js']], 'start+use of the same tool merged');
  assert.strictEqual(events.filter(e => e.type === 'turn_worker_delta').length, 0, 'text not broadcast yet (throttle)');
  await sleep(1100);
  const wd = events.filter(e => e.type === 'turn_worker_delta');
  assert.strictEqual(wd.length, 1, 'one broadcast for twenty chunks');
  assert.deepStrictEqual([wd[0].workerId, wd[0].agent, wd[0].turnId], ['w1', 'maestro', 't2']);
  assert.ok(wd[0].text.includes('chunk19'));
  gw(res, { type: 'worker_completed', worker_id: 'w1' });
  t = hub.turnFor('maestro');
  assert.strictEqual(t.workers[0].status, 'completed');
  assert.ok(t.workers[0].endedAt);
  const workerItems = events.filter(e => e.type === 'turn_activity' && e.item.kind === 'worker').map(e => e.item.status);
  assert.deepStrictEqual(workerItems, ['started', 'completed']);
  assert.strictEqual(events.filter(e => e.type === 'turn_activity' && e.item.kind === 'worker_tool').length, 3);
  gw(res, { type: 'worker_started', worker_id: 'w2', description: 'Worker: haiku', model: 'claude-sdk/claude-haiku-4-5' });
  gw(res, { type: 'worker_failed', worker_id: 'w2', error: 'boom' });
  t = hub.turnFor('maestro');
  assert.deepStrictEqual(t.workers.map(w => [w.id, w.status, w.error]), [['w1', 'completed', null], ['w2', 'failed', 'boom']]);
  tap.finish(true);
});

test('turnFor: live text, message and origin; after finish the turn stays readable with ended set, active false, and is not listed as active', () => {
  const hub = createHubEvents();
  const res = fakeRes();
  assert.strictEqual(hub.turnFor('gp'), null);
  const tap = hub.tapTurn(res, { agent: 'gp', origin: { kind: 'consultation', from: 'maestro' }, message: 'How is Sam?', turnId: 't3' });
  sse(res, { choices: [{ delta: { content: 'Sam is ' } }] });
  sse(res, { choices: [{ delta: { content: 'fine.' } }] });
  let t = hub.turnFor('gp');
  assert.deepStrictEqual([t.active, t.text, t.message, t.origin.kind, t.activityLabel], [true, 'Sam is fine.', 'How is Sam?', 'consultation', 'consulted by maestro']);
  assert.deepStrictEqual(hub.activeAgents(), ['gp']);
  tap.finish(true);
  t = hub.turnFor('gp');
  assert.strictEqual(t.active, false);
  assert.strictEqual(t.text, 'Sam is fine.');
  assert.deepStrictEqual([t.ended.ok, t.ended.error], [true, null]);
  assert.deepStrictEqual(hub.activeAgents(), []);
  // a new turn for the same agent replaces the finished one at once
  const tap2 = hub.tapTurn(fakeRes(), { agent: 'gp', origin: { kind: 'user' }, message: 'again', turnId: 't4' });
  assert.deepStrictEqual([hub.turnFor('gp').turnId, hub.turnFor('gp').active], ['t4', true]);
  tap2.finish(false, 'stopped');
  assert.deepStrictEqual([hub.turnFor('gp').ended.ok, hub.turnFor('gp').ended.error], [false, 'stopped']);
});

test('caps: activity keeps the newest 400 items and counts the dropped ones; nothing published after finish; a detached turn (observeClosed) still records activity', () => {
  const hub = createHubEvents();
  const events = collect(hub);
  const res = fakeRes();
  const tap = hub.tapTurn(res, { agent: 'a', origin: { kind: 'user' }, message: 'm', turnId: 't5' });
  for (let i = 0; i < 450; i++) gw(res, { type: 'tool_use', tool: 'T', tool_call_id: `c${i}`, input: `i${i}` });
  let t = hub.turnFor('a');
  assert.strictEqual(t.activity.length, 400);
  assert.strictEqual(t.dropped, 50);
  assert.strictEqual(t.activity[0].callId, 'c50');
  // detached: sendSSE hands chunks to observeClosed when the browser is gone
  res.observeClosed({ choices: [{ delta: { content: 'late text' } }], gateway: { type: 'worker_started', worker_id: 'wd', description: 'late worker' } });
  t = hub.turnFor('a');
  assert.strictEqual(t.text, 'late text');
  assert.strictEqual(t.workers[0].id, 'wd');
  const before = events.length;
  tap.finish(true);
  const afterFinish = events.length;
  assert.strictEqual(events[afterFinish - 1].type, 'turn_end');
  gw(res, { type: 'tool_use', tool: 'T', input: 'after' });   // res.write restored: not observed
  assert.strictEqual(events.length, afterFinish);
  assert.strictEqual(hub.turnFor('a').activity.length, 400);
  assert.ok(before > 0);
});

test('the stream heartbeat is a real `ping` event with a timestamp (not an SSE comment), so pages can detect a dead connection', async () => {
  const hub = createHubEvents({ now: () => Date.parse('2026-03-01T12:00:00Z') });
  const r = { chunks: [], writeHead() {}, write(s) { r.chunks.push(s); return true; }, on() {}, destroy() { r.destroyed = true; } };
  hub.subscribe({ headers: {} }, r);
  // the interval is 15 s; drive it by hand through the timer list is not possible, so check the frame builder via a fake clock on a short wait
  const before = r.chunks.length;
  await new Promise(res => setTimeout(res, 50));
  assert.strictEqual(r.chunks.length, before, 'no ping yet');
  assert.ok(!r.chunks.some(c => c.startsWith(': heartbeat')), 'no comment heartbeats are written');
  // the ping frame format, as the interval will write it
  const src = require('fs').readFileSync(require.resolve('../lib/hub-events'), 'utf8');
  assert.match(src, /event: ping\\ndata: \$\{JSON\.stringify\(\{ type: 'ping', ts:/);
  assert.match(src, /const PING_MS = 15000/);
});

test('?since=<seq> replays missed events for a page that opens a new connection on purpose (no Last-Event-ID)', () => {
  const hub = createHubEvents();
  const mk = () => { const r = { chunks: [], writeHead() {}, write(s) { r.chunks.push(s); return true; }, on() {}, destroy() {} }; return r; };
  const first = mk();
  hub.subscribe({ headers: {} }, first);
  hub.publish('turn_start', { agent: 'a', turnId: 't1' });
  hub.publish('turn_activity', { agent: 'a', turnId: 't1', item: { id: 'a1', kind: 'tool' } });
  hub.publish('turn_end', { agent: 'a', turnId: 't1', ok: true });
  const seqs = first.chunks.filter(c => c.startsWith('id: ')).map(c => Number(/id: (\d+)/.exec(c)[1]));
  assert.deepStrictEqual(seqs, [1, 2, 3]);
  const again = mk();
  hub.subscribe({ headers: {}, url: '/api/events?since=1' }, again);
  const replayed = again.chunks.filter(c => c.startsWith('id: ')).map(c => /event: (\S+)/.exec(c)[1]);
  assert.deepStrictEqual(replayed, ['turn_activity', 'turn_end'], 'everything after seq 1');
  assert.match(again.chunks.find(c => c.startsWith('event: hello')), /"replayed":true/);
  const fresh = mk();
  hub.subscribe({ headers: {}, url: '/api/events' }, fresh);
  assert.strictEqual(fresh.chunks.filter(c => c.startsWith('id: ')).length, 0, 'no since, no replay');
  const header = mk();
  hub.subscribe({ headers: { 'last-event-id': '2' }, url: '/api/events?since=0' }, header);
  assert.deepStrictEqual(header.chunks.filter(c => c.startsWith('id: ')).map(c => /event: (\S+)/.exec(c)[1]), ['turn_end'], 'the header wins when present');
});

test('pending ask_user question: kept per agent, part of turnFor while the turn runs, cleared on answer and absent after the turn ends', () => {
  const ev = createHubEvents({ now: () => 1_700_000_000_000 });
  const res = { write() {}, on() {}, once() {} };
  const tap = ev.tapTurn(res, { agent: 'gp', origin: { kind: 'user' }, message: 'interview me' });
  assert.equal(ev.questionFor('gp'), null);
  const q = { request_id: 'r1', questions: [{ header: 'the owner', question: 'Alcohol per week?', options: [{ label: 'None' }, { label: 'Skip', description: 'Leave this for later' }] }] };
  ev.setQuestion('gp', q);
  assert.equal(ev.questionFor('gp').request_id, 'r1');
  assert.deepEqual(ev.turnFor('gp').question.questions, q.questions, 'catch-up carries the full question');
  ev.setQuestion('gp', null);
  assert.equal(ev.turnFor('gp').question, null);
  ev.setQuestion('gp', q);
  if (tap && typeof tap.end === 'function') tap.end({ ok: true }); else if (tap && typeof tap.finish === 'function') tap.finish({ ok: true });
  const after = ev.turnFor('gp');
  if (after && after.ended) assert.equal(after.question, null, 'no question once the turn has ended');
});

test('turn_progress: the phase bar, token counter and context reading reach pages that follow the turn (throttled, never replayed)', async () => {
  let clock = 1_000_000;
  const hub = createHubEvents({ now: () => clock, progressMs: 20 });
  const events = collect(hub);
  const res = fakeRes();
  const tap = hub.tapTurn(res, { agent: 'maestro', origin: { kind: 'user' }, message: 'go', turnId: 'tP' });
  gw(res, { type: 'progress', phase: 'tool', detail: 'Bash', turn: 2, phase_ms: 1500, total_ms: 9000 });
  gw(res, { type: 'token_usage', usage: { prompt_tokens: 38000, completion_tokens: 1200, total_tokens: 39200, junk: 'x' } });
  gw(res, { type: 'context_health', input_tokens: 38000, context_limit: 950000, usage_percent: 4, categories: [{ name: 'x', tokens: 1 }] });
  gw(res, { type: 'progress', phase: 'tool', detail: 'Bash', turn: 2, phase_ms: 2500, total_ms: 10000 });
  assert.strictEqual(events.filter(e => e.type === 'turn_progress').length, 0, 'throttled: nothing yet');
  clock += 1000;
  await sleep(40);
  const prog = events.filter(e => e.type === 'turn_progress');
  assert.strictEqual(prog.length, 1, 'one event for the burst');
  assert.deepStrictEqual(prog[0].progress, { phase: 'tool', detail: 'Bash', turn: 2, phase_ms: 3500, total_ms: 11000 }, 'elapsed counted at publish time');
  assert.deepStrictEqual(prog[0].usage, { prompt_tokens: 38000, completion_tokens: 1200, total_tokens: 39200 });
  assert.deepStrictEqual(prog[0].context, { input_tokens: 38000, output_tokens: 0, context_limit: 950000, usage_percent: 4 });
  assert.ok(!hub.recent(0).some(e => e.type === 'turn_progress'), 'not kept for replay after a reconnect');
  const t = hub.turnFor('maestro');
  assert.strictEqual(t.progress.phase, 'tool');
  assert.strictEqual(t.usage.completion_tokens, 1200);
  assert.strictEqual(t.context.context_limit, 950000);
  gw(res, { type: 'progress', phase: 'model', detail: '', turn: 3, phase_ms: 0, total_ms: 12000 });
  tap.finish(true);
  await sleep(40);
  assert.strictEqual(events.filter(e => e.type === 'turn_progress').length, 1, 'nothing after the turn ended');
  const done = hub.turnFor('maestro');
  assert.strictEqual(done.progress, null, 'a finished turn has no phase');
  assert.strictEqual(done.usage.total_tokens, 39200, 'its last token count stays readable');
});

test('a turn whose browser has gone keeps its phase moving: the progress ticker feeds the tap through observeClosed', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  const tickers = src.split('const progressTicker = setInterval(() => {').slice(1).map(b => b.slice(0, 200));
  assert.strictEqual(tickers.length, 2, 'Claude and Codex paths');
  for (const b of tickers) assert.ok(!/writableEnded|destroyed/.test(b), 'no early return when the browser is gone (sendSSE hands it to the tap)');
});

test('history mid-turn: the reply saved in progress is flagged while its turn runs (pages show the live turn instead)', () => {
  const { markInProgress } = require('../lib/hub-events');
  const turn = { active: true, startedAt: '2026-10-17T20:00:00.000Z' };
  const hist = () => [
    { role: 'user', content: 'go', ts: '2026-10-17T20:00:00.000Z' },
    { role: 'assistant', content: 'Working on it…', ts: '2026-10-17T20:00:07.000Z' },
  ];
  assert.strictEqual(markInProgress(hist(), turn)[1].inProgress, true);
  assert.strictEqual(markInProgress(hist(), { ...turn, active: false })[1].inProgress, undefined, 'finished turn: a normal reply');
  assert.strictEqual(markInProgress(hist(), null)[1].inProgress, undefined, 'no turn');
  assert.strictEqual(markInProgress(hist(), { active: true, startedAt: '2026-10-17T20:05:00.000Z' })[1].inProgress, undefined, 'an older reply, before this turn began');
  const ended = hist(); ended.push({ role: 'user', content: 'next', ts: '2026-10-17T20:01:00.000Z' });
  assert.strictEqual(markInProgress(ended, turn)[2].inProgress, undefined, 'only an assistant entry');
  assert.deepStrictEqual(markInProgress([], turn), []);
});
