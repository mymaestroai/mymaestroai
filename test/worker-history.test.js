'use strict';
// The worker history (lib/transcript workers / workerRun): the workers an agent called, read back from the rows its
// turns kept, newest first, with each one's brief, answer and end, filters, search and pages that never skip or
// repeat a worker (also when several started in the same millisecond); and one worker opened again with its steps.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTranscript } = require('../lib/transcript');

const sse = (ev) => `data: ${JSON.stringify({ gateway: ev })}\n\n`;
function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-history-'));
  let t = Date.parse('2026-11-05T10:00:00.000Z');
  const clock = { now: () => t, set: (iso) => { t = Date.parse(iso); }, add: (ms) => { t += ms; } };
  const tr = createTranscript({ file: path.join(dir, 'transcript.db'), dir: path.join(dir, 'transcripts'), now: clock.now, log: () => {} });
  return { tr, clock, dir };
}
function turn(tr, agent, turnId, events) {
  const res = { write() { return true; } };
  const tap = tr.tap(res, { agent, turnId });
  for (const ev of events) { if (typeof ev === 'function') ev(res); else res.write(sse(ev)); }
  tap.finish(true);
}

test('the workers an agent called come back newest first, with brief, answer, outcome and duration; a late answer is found', () => {
  const { tr, clock, dir } = rig();
  turn(tr, 'boss', 't1', [
    { type: 'worker_started', worker_id: 'w1', agent_type: 'temporal', description: 'Worker: Fable review r8', model: 'claude-fable-5-1', prompt: 'Review the packet and end with ACCEPT or REJECT.' },
    { type: 'worker_tool_use', worker_id: 'w1', tool: 'Read', input: { file_path: 'x.md' }, tool_call_id: 'c1' },
    { type: 'worker_tool_result', worker_id: 'w1', output: 'packet text', tool_call_id: 'c1' },
    { type: 'worker_text_delta', worker_id: 'w1', text: 'Verdict: ACCEPT.' },
    () => clock.add(83000),
    { type: 'worker_completed', worker_id: 'w1' },
  ]);
  clock.add(60000);
  turn(tr, 'boss', 't2', [
    { type: 'worker_started', worker_id: 'w2', agent_type: 'watchman', description: 'Watchman', model: 'claude-sdk/claude-sonnet-5-5', prompt: 'Is anyone at the front door?' },
    () => clock.add(4000),
    { type: 'worker_failed', worker_id: 'w2', error: 'Docker is not answering' },
  ]);
  clock.add(60000);
  // a Claude sub-agent: its answer reaches the archive through the caller's tool result, after its finished row
  turn(tr, 'boss', 't3', [
    { type: 'worker_started', worker_id: 'w3', agent_type: 'sdk-agent', description: 'Explore the repo', prompt: 'Find the worker code.' },
    { type: 'worker_completed', worker_id: 'w3' },
    (res) => res.archiveToolOutput('call-9', 'It is in app.js around line 10868.', { worker_id: 'w3', worker_event: 'answer' }),
    { type: 'tool_result', tool_call_id: 'call-9', output: 'It is in app.js' },
  ]);
  const { workers, next } = tr.workers('boss');
  assert.strictEqual(next, null);
  assert.deepStrictEqual(workers.map(w => [w.workerId, w.kind, w.outcome]), [['w3', 'sub-agent', 'done'], ['w2', 'agent', 'failed'], ['w1', 'temporary', 'done']]);
  const [w3, w2, w1] = workers;
  assert.strictEqual(w3.answer, 'It is in app.js around line 10868.', 'the answer that came after the finished row');
  assert.deepStrictEqual([w1.description, w1.prompt, w1.model, w1.durationMs, w1.answer, w1.caller], ['Worker: Fable review r8', 'Review the packet and end with ACCEPT or REJECT.', 'claude-fable-5-1', 83000, 'Verdict: ACCEPT.', 'boss']);
  assert.deepStrictEqual([w2.error, w2.answer, w2.durationMs], ['Docker is not answering', null, 4000]);
  assert.match(w1.startedAt, /^2026-11-05T10:00:00/);
  // filters and search
  assert.deepStrictEqual(tr.workers('boss', { filter: 'failed' }).workers.map(w => w.workerId), ['w2']);
  assert.deepStrictEqual(tr.workers('boss', { filter: 'named' }).workers.map(w => w.workerId), ['w2']);
  assert.deepStrictEqual(tr.workers('boss', { filter: 'temporary' }).workers.map(w => w.workerId), ['w3', 'w1']);
  assert.deepStrictEqual(tr.workers('boss', { q: 'front door' }).workers.map(w => w.workerId), ['w2'], 'words in the brief');
  assert.deepStrictEqual(tr.workers('boss', { q: 'ACCEPT verdict' }).workers.map(w => w.workerId), ['w1'], 'words in the answer');
  assert.deepStrictEqual(tr.workers('boss', { q: 'nothing like this' }).workers, []);
  // one worker opened again, as it ran
  const run = tr.workerRun('boss', 'w1');
  assert.strictEqual(run.worker.workerId, 'w1');
  assert.deepStrictEqual(run.rows.map(r => [r.kind, r.tool, r.event]), [['system', 'worker', 'started'], ['tool_use', 'Read', null], ['tool_result', null, null], ['tool_result', 'worker_answer', 'answer'], ['system', 'worker', 'finished']]);
  assert.strictEqual(tr.workerRun('boss', 'nope'), null);
  assert.deepStrictEqual(tr.workers('nobody'), { workers: [], next: null }, 'an agent with no archive yet');
  tr.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('pages never skip or repeat a worker, also when several started in the same millisecond; a running one has no outcome', () => {
  const { tr, clock, dir } = rig();
  const events = [];
  for (let i = 1; i <= 7; i++) events.push({ type: 'worker_started', worker_id: `p${i}`, agent_type: 'temporal', description: `Worker ${i}` });   // all at one instant
  for (let i = 1; i <= 6; i++) events.push({ type: 'worker_completed', worker_id: `p${i}` });
  const res = { write() { return true; } };
  const tap = tr.tap(res, { agent: 'boss', turnId: 'tt' });
  for (const ev of events) res.write(sse(ev));   // p7 still running: no finish yet
  const seen = [];
  let before = null, pages = 0;
  do {
    const page = tr.workers('boss', { limit: 3, before });
    seen.push(...page.workers.map(w => w.workerId));
    before = page.next; pages++;
  } while (before && pages < 10);
  assert.deepStrictEqual(seen.slice().sort(), ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
  assert.strictEqual(new Set(seen).size, 7, 'no repeats');
  assert.strictEqual(tr.workers('boss').workers.find(w => w.workerId === 'p7').outcome, null);
  tap.finish(true);
  assert.strictEqual(tr.workers('boss').workers.find(w => w.workerId === 'p7').outcome, 'unfinished', 'a turn that ended with it running');
  assert.deepStrictEqual(tr.workers('boss', { filter: 'failed' }).workers.map(w => w.workerId), ['p7']);
  clock.add(1);
  tr.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('the history routes: one agent\'s workers need access to that agent; the list across agents is for anyone signed in (it filters)', () => {
  const { classifyRoute } = require('../lib/access');
  assert.deepStrictEqual(classifyRoute('/api/agents/maestro/workers', 'GET').kind, 'agent');
  assert.deepStrictEqual(classifyRoute('/api/agents/maestro/workers/tw-123', 'GET').kind, 'agent');
  assert.strictEqual(classifyRoute('/api/workers', 'GET').kind, 'session');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /names = all\.filter\(a => access\.isAdmin\(who\) \|\| access\.canAccessAgent\(who, a\.name, \{ agents: all \}\)\)/, 'across agents: only agents this person may open');
});

test('the combined archive of earlier versions holds every agent: one agent\'s history never shows another\'s workers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-history-combined-'));
  fs.writeFileSync(path.join(dir, 'transcript.db'), '');   // the combined file (before the split, or a split that failed)
  let t = Date.parse('2026-11-05T10:00:00.000Z');
  const tr = createTranscript({ file: path.join(dir, 'transcript.db'), dir: path.join(dir, 'transcripts'), now: () => (t += 1000), log: () => {} });
  turn(tr, 'alice_gp', 'ta', [{ type: 'worker_started', worker_id: 'mine', agent_type: 'temporal', description: 'Mine', prompt: 'about the shared word' }, { type: 'worker_completed', worker_id: 'mine' }]);
  turn(tr, 'maestro', 'tm', [{ type: 'worker_started', worker_id: 'theirs', agent_type: 'temporal', description: 'Theirs', prompt: 'a secret brief with the shared word' }, { type: 'worker_text_delta', worker_id: 'theirs', text: 'secret answer' }, { type: 'worker_completed', worker_id: 'theirs' }]);
  assert.deepStrictEqual(tr.workers('alice_gp').workers.map(w => w.workerId), ['mine']);
  assert.deepStrictEqual(tr.workers('alice_gp', { q: 'shared word' }).workers.map(w => w.workerId), ['mine']);
  assert.strictEqual(tr.workerRun('alice_gp', 'theirs'), null);
  assert.deepStrictEqual(tr.workerRun('alice_gp', 'mine').rows.map(r => r.event), ['started', 'finished']);
  assert.deepStrictEqual(tr.workers('maestro').workers.map(w => w.workerId), ['theirs']);
  tr.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('a filter or a search whose matches lie beyond what one page looks at still reaches them, page after page', () => {
  const { tr, clock, dir } = rig();
  turn(tr, 'boss', 'old', [{ type: 'worker_started', worker_id: 'the-old-failure', agent_type: 'temporal', description: 'Old', prompt: 'a needle in the brief' }, { type: 'worker_failed', worker_id: 'the-old-failure', error: 'boom' }]);
  for (let i = 0; i < 25; i++) { clock.add(1000); turn(tr, 'boss', `t${i}`, [{ type: 'worker_started', worker_id: `ok${i}`, agent_type: 'temporal', description: `Fine ${i}` }, { type: 'worker_completed', worker_id: `ok${i}` }]); }
  for (const opts of [{ filter: 'failed' }, { q: 'needle' }]) {
    let page = tr.workers('boss', { ...opts, scanMax: 10 });
    assert.deepStrictEqual(page.workers, [], 'the first page looked at only 10 workers');
    assert.ok(page.next, 'and says where to go on');
    const seen = [];
    for (let n = 0; page.next && n < 10; n++) { page = tr.workers('boss', { ...opts, scanMax: 10, before: page.next }); seen.push(...page.workers.map(w => w.workerId)); }
    assert.deepStrictEqual(seen, ['the-old-failure'], JSON.stringify(opts));
  }
  tr.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('several agents\' pages merge newest first without passing over what an agent has not looked at, or showing a worker twice', () => {
  const { mergeWorkerPages } = require('../lib/transcript');
  const w = (caller, ts, rowId) => ({ caller, startedAt: `2026-11-05T10:00:${String(ts).padStart(2, '0')}.000Z`, rowId, workerId: `${caller}${ts}` });
  // a: three workers and more behind them; b stopped looking at :40 (a scan that went far without a match)
  const a = { workers: [w('a', 50, 9), w('a', 45, 8), w('a', 30, 7)], next: '2026-11-05T10:00:30.000Z|a|7' };
  const b = { workers: [w('b', 48, 3)], next: '2026-11-05T10:00:40.000Z|b|2' };
  const c = { workers: [w('c', 49, 5), w('c', 10, 4)], next: null };
  const one = mergeWorkerPages([a, b, c], 50);
  assert.deepStrictEqual(one.workers.map(x => x.workerId), ['a50', 'c49', 'b48', 'a45'], 'nothing older than where b stopped looking');
  assert.strictEqual(one.next, '2026-11-05T10:00:40.000Z|b|2');
  // a full page ends at its last worker
  const two = mergeWorkerPages([a, c], 2);
  assert.deepStrictEqual([two.workers.map(x => x.workerId), two.next], [['a50', 'c49'], '2026-11-05T10:00:49.000Z|c|5']);
  assert.deepStrictEqual(mergeWorkerPages([{ workers: [w('a', 1, 1)], next: null }], 50).next, null);
});
