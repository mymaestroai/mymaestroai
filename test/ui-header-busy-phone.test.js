'use strict';
// The phone chat header says what the agent is doing in plain words (chatBusyWords), and a page opened mid-turn asks the hub
// once who started the turn (turnOriginFetch). Functions are cut out of mobile.js and run with stubs.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const V = require('../lib/ui-chat-view');

const js = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
const cut = (from, to) => { const a = js.indexOf(from); assert.ok(a >= 0, from); const b = js.indexOf(to, a + from.length); assert.ok(b > a, to); return js.slice(a, b); };
const displayName = (n) => ({ cnc: 'CNC', casework: 'Casework', sam: 'Sam' }[n] || n);

const STEP_NAMES = ['turnSteps', 'chatViewStepsNew', 'chatViewStepsOn', 'chatViewStepsEndTurn', 'chatViewStepsSnapshot', 'chatViewStepsNewest'];
const stepArgs = (turnSteps) => [turnSteps, V.chatViewStepsNew, V.chatViewStepsOn, V.chatViewStepsEndTurn, V.chatViewStepsSnapshot, V.chatViewStepsNewest];

function harness({ live = {}, turnOrigins = {}, openTurns = {}, turnSteps = {}, reply, elapsed, streamNames = [] } = {}) {
  const calls = [];
  const painted = [];
  const src = cut('function currentTurnOrigin(agent)', 'let busyCardEl = null');
  const busySrc = cut('function busyText(name)', 'function paintStatus()');
  const api = async (url, opts) => { calls.push({ url, opts }); return reply ? reply() : { ok: false }; };
  const S = { current: 'casework' };
  const noteSrc = cut('function noteTurnOrigin(agent', '// What the busy card says');
  const elapsedFn = elapsed || ((since) => (since ? '4m' : ''));
  const streams = new Set(streamNames);
  const mod = new Function('S', 'live', 'turnOrigins', 'openTurns', 'chatViewBusyText', 'chatViewIsHubOrigin', 'chatViewElapsed', 'chatViewWaiting', 'chatViewStep', 'displayName', 'api', 'AbortSignal', 'paintChatStatus', 'paintBusyCard', 'viewNow', 'ownTurnFor', 'elapsed', 'streams', 'screen', 'renderAgents', ...STEP_NAMES,
    `const current = S.current; ${noteSrc}; ${src}; ${busySrc}; return { chatBusyWords, chatBusyDetail, turnOriginFetch, busyText, noteTurnOrigin, noteTurnStep };`)(
    S, live, turnOrigins, openTurns, V.chatViewBusyText, V.chatViewIsHubOrigin, V.chatViewElapsed, V.chatViewWaiting, V.chatViewStep, displayName, api, { timeout: (ms) => ({ ms }) },
    () => painted.push('status'), () => painted.push('card'), () => 'main', () => false, elapsedFn, streams, 'chat', () => painted.push('list'), ...stepArgs(turnSteps));
  return { mod, calls, painted, turnSteps, live, turnOrigins, openTurns };
}
const tick = () => new Promise(r => setImmediate(r));
const handOffTurn = { ok: true, json: async () => ({ ok: true, agent: 'casework', active: true, turn: { turnId: 'T1', origin: { kind: 'hand_off', from: 'cnc', label: 'Hand-off from cnc: x' }, startedAt: '2026-11-20T10:00:00Z' } }) };

test('a hand-off known from turnOrigins is named in the header words', () => {
  const live = { casework: { busy: true, busySince: '2026-11-20T10:00:00Z', activity: 'hand-off' } };
  const turnOrigins = { casework: { turnId: 'T1', origin: { kind: 'hand_off', from: 'cnc', label: 'Hand-off from cnc: x' }, hub: true, since: 1 } };
  const h = harness({ live, turnOrigins, openTurns: { casework: ['T1'] } });
  assert.strictEqual(h.mod.chatBusyWords('casework'), 'Working on a task from CNC');
  // an origin of an older turn is not used
  const stale = harness({ live, turnOrigins, openTurns: { casework: ['T2'] } });
  assert.strictEqual(stale.mod.chatBusyWords('casework'), 'Working on a task');
});

test('status feed only: vague words, one fetch per turn, then the caller is named', async () => {
  const live = { casework: { busy: true, busySince: '2026-11-20T10:00:00Z', activity: 'hand-off' } };
  const turnOrigins = {};
  const h = harness({ live, turnOrigins, reply: () => handOffTurn });
  assert.strictEqual(h.mod.chatBusyWords('casework'), 'Working on a task');
  h.mod.turnOriginFetch('casework');
  h.mod.turnOriginFetch('casework');   // in flight: no second request
  await tick(); await tick();
  assert.strictEqual(h.calls.length, 1);
  assert.strictEqual(h.calls[0].url, '/api/agents/casework/turn');
  assert.ok(turnOrigins.casework, 'origin noted');
  assert.strictEqual(h.mod.chatBusyWords('casework'), 'Working on a task from CNC');
  assert.deepStrictEqual(h.painted, ['status', 'card']);
  // same busySince again after the origin went: never asked twice
  delete turnOrigins.casework;
  await h.mod.turnOriginFetch('casework');
  assert.strictEqual(h.calls.length, 1);
  // a new turn (new busySince) is asked again
  live.casework.busySince = '2026-11-20T11:00:00Z';
  await h.mod.turnOriginFetch('casework');
  assert.strictEqual(h.calls.length, 2);
});

test('a failed or empty answer is left alone and not retried', async () => {
  const live = { casework: { busy: true, busySince: 'a', activity: 'hand-off' } };
  const h = harness({ live, reply: () => ({ ok: true, json: async () => ({ ok: true, active: false, turn: null }) }) });
  await h.mod.turnOriginFetch('casework'); await h.mod.turnOriginFetch('casework');
  assert.strictEqual(h.calls.length, 1);
  assert.deepStrictEqual(h.painted, []);
  const bad = harness({ live: { sam: { busy: true, busySince: 'b' } }, reply: () => { throw new Error('down'); } });
  await bad.mod.turnOriginFetch('sam');
  assert.strictEqual(bad.calls.length, 1);
});

test('a pending question says so', () => {
  const live = { casework: { busy: true, busySince: 'a', activity: 'hand-off', pendingQuestion: { id: 1 } } };
  const h = harness({ live });
  assert.strictEqual(h.mod.chatBusyWords('casework'), 'Waiting for your answer');
});

// (d) was: busyText pinned to the bare status word ('⏳ hand-off · 4m'). New rule: a named agent's row says what it does now
// (the header's words + elapsed + detail); question rows and temporary-worker rows keep their old text.
test('(d) the agent list row text: agents say what they do now, workers and questions keep the old text', () => {
  const h = harness({ live: {
    casework: { busy: true, busySince: 'a', activity: 'hand-off' },
    sam: { busy: true, busySince: 'a', pendingQuestion: true },
    owner: { busy: true },
    wk1: { busy: true, busySince: 'a', worker: true, parent: 'sam', label: 'RULES coder', activity: 'working' },
    wk2: { busy: true, worker: true, parent: 'sam' },
  } });
  assert.strictEqual(h.mod.busyText('casework'), '⏳ Working on a task · 4m');
  assert.strictEqual(h.mod.busyText('sam'), '❓ waiting for your answer · 4m');
  assert.notStrictEqual(h.mod.busyText('owner'), '⏳ working');
  assert.match(h.mod.busyText('owner'), /^⏳ Working/);
  assert.strictEqual(h.mod.busyText('wk1'), '⏳ working · 4m');
  assert.strictEqual(h.mod.busyText('wk2'), '⏳ working');
  // this phone streams the reply
  const own = harness({ live: { casework: { busy: true, busySince: 'a', activity: 'replying to you' } }, streamNames: ['casework'] });
  assert.strictEqual(own.mod.busyText('casework'), '⏳ Replying to your message · 4m');
});

// The header: cut paintChatStatus / chatStatusFull and run them on a fake element.
function headerHarness({ live, turnOrigins = {}, openTurns = {}, now = Date.now() }) {
  const el = { textContent: '', hidden: true, label: '', classList: { toggle() {} }, setAttribute(k, v) { if (k === 'aria-label') this.label = v; } };
  const stub = { classList: { toggle() {} }, set textContent(v) {}, hidden: false };
  const base = harness({ live, turnOrigins, openTurns, elapsed: undefined });
  const elapsedSrc = cut('function elapsed(iso)', 'function setLive(name, patch)');
  const src = cut('function currentTurnOrigin(agent)', 'let busyCardEl = null');
  const noteSrc = cut('function noteTurnOrigin(agent', '// What the busy card says');
  const busySrc = cut('function busyText(name)', 'function paintStatus()');
  const fullSrc = cut('function chatStatusFull(name)', 'function showChatStatus');
  const paintSrc = cut('function paintChatStatus()', '// ── "Notify me when done"');
  const S = { current: 'casework' };
  const mod = new Function('S', 'live', 'turnOrigins', 'openTurns', 'chatViewBusyText', 'chatViewIsHubOrigin', 'chatViewElapsed', 'chatViewWaiting', 'chatViewStep', 'displayName', 'api', 'AbortSignal', 'paintBusyCard', 'viewNow', 'ownTurnFor', 'streams', 'screen', 'renderAgents', '$', 'agentByName', 'modelText', 'isBusy', 'paintNotifyBtn', 'setSendMode', ...STEP_NAMES,
    `const current = S.current; ${elapsedSrc}; ${noteSrc}; ${src}; ${busySrc}; ${fullSrc}; ${paintSrc}; return { paintChatStatus, chatStatusFull, noteTurnStep, turnOriginFetch, chatBusyDetail };`)(
    S, live, turnOrigins, openTurns, V.chatViewBusyText, V.chatViewIsHubOrigin, V.chatViewElapsed, V.chatViewWaiting, V.chatViewStep, displayName, async () => ({ ok: false }), { timeout: () => ({}) },
    () => {}, () => 'main', () => false, new Set(), 'chat', () => {},
    (id) => (id === 'chat-busy' ? el : id === 'chat-model' ? { textContent: '' } : stub), () => ({}), () => 'model', (n) => !!(live[n] && live[n].busy), () => {}, () => {}, ...stepArgs(base.turnSteps));
  return { mod, el, base };
}
const minsAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
const handOffOrigin = { turnId: 'T1', origin: { kind: 'hand_off', from: 'cnc', label: 'Hand-off from cnc: x' }, hub: true, since: Date.now() - 9 * 60000 };

test('(a) the header names what the turn waits on: a helper started with spawn_workers', () => {
  const live = {
    casework: { busy: true, busySince: minsAgo(9), activity: 'hand-off' },
    wk: { busy: true, busySince: minsAgo(9), worker: true, parent: 'casework', label: 'RULES coder' },
  };
  const h = headerHarness({ live, turnOrigins: { casework: handOffOrigin }, openTurns: { casework: ['T1'] } });
  h.mod.paintChatStatus();
  assert.strictEqual(h.el.textContent, '⏳ Working on a task from CNC · 9m · waiting on 1 helper (RULES coder, 9 min)');
  assert.strictEqual(h.el.hidden, false);
  assert.match(h.mod.chatStatusFull('casework'), /^Casework: Working on a task from CNC · 9 min · waiting on 1 helper \(RULES coder, 9 min\)$/);
  // the helper is done: no more detail
  live.wk.busy = false;
  h.mod.paintChatStatus();
  assert.strictEqual(h.el.textContent, '⏳ Working on a task from CNC · 9m');
});

test('(b) with no helpers the header shows the running tool step; a done item with the same callId clears it', () => {
  const live = { casework: { busy: true, busySince: minsAgo(9), activity: 'hand-off' } };
  const h = headerHarness({ live, turnOrigins: { casework: handOffOrigin }, openTurns: { casework: ['T1'] } });
  h.mod.noteTurnStep('casework', 'T1', { kind: 'tool', tool: 'mcp__hub__Bash', summary: 'npm test', status: 'running', callId: 'c1' });
  h.mod.paintChatStatus();
  assert.match(h.el.textContent, /· running a command: npm test$/);
  h.mod.noteTurnStep('casework', 'T1', { kind: 'tool', tool: 'mcp__hub__Bash', status: 'done', callId: 'c0' });   // another call's end: kept
  assert.strictEqual(V.chatViewStepsNewest(h.base.turnSteps.casework).callId, 'c1');
  h.mod.noteTurnStep('casework', 'T1', { kind: 'tool', tool: 'mcp__hub__Bash', status: 'done', callId: 'c1' });
  assert.strictEqual(V.chatViewStepsNewest(h.base.turnSteps.casework), null);
  h.mod.paintChatStatus();
  assert.strictEqual(h.el.textContent, '⏳ Working on a task from CNC · 9m');
  // helpers win over the step
  live.wk = { busy: true, busySince: minsAgo(2), worker: true, parent: 'casework', label: 'RULES coder' };
  h.mod.noteTurnStep('casework', 'T1', { kind: 'tool', tool: 'spawn_workers', status: 'running', callId: 'c2' });
  assert.match(h.mod.chatBusyDetail('casework'), /^waiting on 1 helper/);
});

test('(c) the list row says what the agent does now, never the bare status word', () => {
  const live = {
    casework: { busy: true, busySince: minsAgo(9), activity: 'hand-off' },
    wk: { busy: true, busySince: minsAgo(9), worker: true, parent: 'casework', label: 'RULES coder', activity: 'working' },
  };
  const h = headerHarness({ live, turnOrigins: { casework: handOffOrigin }, openTurns: { casework: ['T1'] } });
  const row = h.base.mod.busyText('casework');
  // the base harness shares live/turnOrigins/openTurns, so it sees the same state
  assert.match(row, /Working on a task from CNC/);
  assert.match(row, /waiting on 1 helper \(RULES coder/);
  assert.notStrictEqual(row, '⏳ hand-off · 9m');
  assert.doesNotMatch(row, /⏳ hand-off/);
});

test('(d2) a worker row keeps its old text even when it has a parent', () => {
  const live = { casework: { busy: true, busySince: minsAgo(9), activity: 'hand-off' }, wk: { busy: true, busySince: minsAgo(3), worker: true, parent: 'casework', label: 'RULES coder', activity: 'working' } };
  const h = headerHarness({ live });
  assert.strictEqual(h.base.mod.busyText('wk'), '⏳ working · 4m');   // the base harness's elapsed stub says 4m
});

test('(e) turnOriginFetch merges the fetched activity into the steps: the running tool without a later done', async () => {
  const activity = [
    { kind: 'tool', tool: 'mcp__hub__Read', status: 'running', callId: 'r1' },
    { kind: 'tool', tool: 'mcp__hub__Read', status: 'done', callId: 'r1' },
    { kind: 'tool', tool: 'mcp__hub__Bash', summary: 'npm test', status: 'running', callId: 'b1' },
  ];
  const reply = () => ({ ok: true, json: async () => ({ ok: true, active: true, turn: { turnId: 'T1', origin: { kind: 'hand_off', from: 'cnc' }, startedAt: '2026-11-20T10:00:00Z', activity } }) });
  const h = harness({ live: { casework: { busy: true, busySince: 'a', activity: 'hand-off' } }, reply });
  await h.mod.turnOriginFetch('casework');
  assert.strictEqual(V.chatViewStepsNewest(h.turnSteps.casework).callId, 'b1');
  assert.strictEqual(h.mod.chatBusyDetail('casework'), 'running a command: npm test');
  // a closed last call leaves nothing
  const closed = harness({ live: { casework: { busy: true, busySince: 'b', activity: 'hand-off' } }, reply: () => ({ ok: true, json: async () => ({ ok: true, active: true, turn: { turnId: 'T2', origin: { kind: 'hand_off', from: 'cnc' }, activity: activity.slice(0, 2) } }) }) });
  await closed.mod.turnOriginFetch('casework');
  assert.strictEqual(V.chatViewStepsNewest(closed.turnSteps.casework), null);
});

test('wiring: a second turn_activity handler, only the ended turn\'s steps go at turn_end, none at turn_start, helper changes repaint the waiters, 15 s tick', () => {
  assert.match(js, /on\('turn_activity', \(ev\) => \{ if \(ev && ev\.agent\) noteTurnStep\(ev\.agent, ev\.turnId, ev\.item\); \}\)/);
  assert.doesNotMatch(cut('function onTurnStart(ev)', 'if (ev.turnId && hubTurns'), /turnSteps/);
  assert.match(cut('function onTurnEnd(ev)', 'const reply ='), /chatViewStepsEndTurn\(turnSteps\[ev\.agent\], ev\.turnId\)/);   // after the context refresh (ui-compaction pins that within 400 characters)
  assert.match(cut('function setLive(name, patch)', 'if (!next.busy && typeof voiceCallHubIdle'), /repaintAgentStatus\(w\)/);
  assert.match(js, /const STATUS_TICK_MS = 15000/);
  assert.match(cut('function paintBusyCard()', 'A hub-started turn kept out'), /chatBusyDetail\(current\)/);
});

test('repaintAgentStatus: at most once per 500 ms per agent with a trailing call, list at most once per second', async () => {
  const src = cut('const statusPaintAt = {}', 'let busyCardEl = null');
  const log = [];
  const timers = [];
  const clock = { t: 10000 };
  const D = { now: () => clock.t };
  const st = (fn, ms) => { timers.push({ fn, at: clock.t + ms }); return timers.length; };
  const mod = new Function('Date', 'setTimeout', 'current', 'screen', 'paintChatStatus', 'renderAgents',
    `${src}; return { repaintAgentStatus };`)(D, st, 'casework', 'agents', () => log.push('chat'), () => log.push('list'));
  mod.repaintAgentStatus('casework');
  mod.repaintAgentStatus('casework'); mod.repaintAgentStatus('casework');   // throttled: one trailing timer
  assert.deepStrictEqual(log, ['chat', 'list']);
  assert.strictEqual(timers.length, 1);
  clock.t += 500; timers.shift().fn();   // trailing call: chat paints, the list waits for its second
  assert.deepStrictEqual(log, ['chat', 'list', 'chat']);
  assert.strictEqual(timers.length, 1);
  clock.t += 500; timers.shift().fn();
  assert.deepStrictEqual(log, ['chat', 'list', 'chat', 'list']);
});

test('the header paints the words and asks for the origin; the tap text uses them in every view', () => {
  const p = cut('function paintChatStatus()', 'const bell');
  assert.match(p, /chatBusyWords\(current\)/);
  assert.match(p, /turnOriginFetch\(current\)/);
  assert.doesNotMatch(p, /busyText\(current\)/);
  const f = cut('function chatStatusFull(name)', 'function showChatStatus');
  assert.match(f, /chatBusyWords\(name\)/);
  assert.doesNotMatch(f, /busyCardInfo/);
});

// ── steps per call and per turn ──
const tool = (tl, status, callId, summary) => ({ kind: 'tool', tool: tl, status, callId, summary });
const BASH = (status, callId = 'b1') => tool('mcp__hub__Bash', status, callId, 'sleep 60');
const READ = (status, callId = 'r1') => tool('mcp__hub__Read', status, callId);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const turnReply = (turn) => ({ ok: true, json: async () => ({ ok: true, active: true, turn }) });

test('parallel calls: a long Bash then a Read; the Read finishing brings the Bash step back', () => {
  const h = harness({ live: { casework: { busy: true, busySince: 'a', activity: 'working' } } });
  h.mod.noteTurnStep('casework', 'T1', BASH('running'));
  h.mod.noteTurnStep('casework', 'T1', READ('running'));
  assert.strictEqual(h.mod.chatBusyDetail('casework'), 'reading a file');
  h.mod.noteTurnStep('casework', 'T1', READ('done'));
  assert.strictEqual(h.mod.chatBusyDetail('casework'), 'running a command: sleep 60');
  h.mod.noteTurnStep('casework', 'T1', BASH('done'));
  assert.strictEqual(h.mod.chatBusyDetail('casework'), '');
});

test('overlapping turns: one turn ending leaves the other turn\'s step; turn_start keeps steps', () => {
  const h = harness({ live: { casework: { busy: true, busySince: 'a', activity: 'working' } } });
  h.mod.noteTurnStep('casework', 'A', BASH('running', 'x'));
  h.mod.noteTurnStep('casework', 'B', READ('running', 'y'));
  // the onTurnEnd line, as wired: only that turn's calls go
  assert.strictEqual(V.chatViewStepsEndTurn(h.turnSteps.casework, 'B'), true);
  assert.strictEqual(h.mod.chatBusyDetail('casework'), 'running a command: sleep 60');
  assert.strictEqual(V.chatViewStepsEndTurn(h.turnSteps.casework, 'A'), true);
  assert.strictEqual(h.mod.chatBusyDetail('casework'), '');
  // onTurnStart does not touch the steps (checked on the source: it names turnSteps nowhere)
  assert.doesNotMatch(cut('function onTurnStart(ev) {', 'function onTurnDelta'), /turnSteps/);
});

test('late fetch: a done event before the answer keeps the call gone', async () => {
  const d = deferred();
  const h = harness({ live: { casework: { busy: true, busySince: 'a', activity: 'working' } }, reply: () => d.promise });
  const p = h.mod.turnOriginFetch('casework');
  h.mod.noteTurnStep('casework', 'T1', BASH('done'));   // finished while the request was out
  d.resolve(turnReply({ turnId: 'T1', origin: { kind: 'hand_off', from: 'cnc' }, activity: [BASH('running')] }));
  await p;
  assert.strictEqual(h.mod.chatBusyDetail('casework'), '');
  assert.ok(h.turnOrigins.casework, 'the origin is still noted');
});

test('late fetch: an answer after busySince changed (or the agent went idle) applies nothing', async () => {
  const d = deferred();
  const live = { casework: { busy: true, busySince: 'a', activity: 'working' } };
  const h = harness({ live, reply: () => d.promise });
  const p = h.mod.turnOriginFetch('casework');
  live.casework = { busy: true, busySince: 'b', activity: 'working' };   // a new turn began
  d.resolve(turnReply({ turnId: 'T1', origin: { kind: 'hand_off', from: 'cnc' }, activity: [BASH('running')] }));
  await p;
  assert.deepStrictEqual(h.turnSteps, {});
  assert.deepStrictEqual(h.turnOrigins, {});
  assert.deepStrictEqual(h.painted, []);
  const d2 = deferred();
  const live2 = { sam: { busy: true, busySince: 'a' } };
  const h2 = harness({ live: live2, reply: () => d2.promise });
  const p2 = h2.mod.turnOriginFetch('sam');
  live2.sam = { busy: false, busySince: null };
  d2.resolve(turnReply({ turnId: 'T1', origin: { kind: 'hand_off', from: 'cnc' }, activity: [BASH('running')] }));
  await p2;
  assert.deepStrictEqual(h2.turnSteps, {});
  assert.deepStrictEqual(h2.turnOrigins, {});
});

test('late fetch: a turn without an origin object still gets its step; a known origin is kept', async () => {
  const h = harness({ live: { casework: { busy: true, busySince: 'a', activity: 'working' } }, reply: () => turnReply({ turnId: 'T1', activity: [BASH('running')] }) });
  await h.mod.turnOriginFetch('casework');
  assert.strictEqual(h.mod.chatBusyDetail('casework'), 'running a command: sleep 60');
  assert.deepStrictEqual(h.turnOrigins, {});
  // the origin came with turn_start already: the fetch leaves it alone but still adds the steps
  const known = { turnId: 'T1', origin: { kind: 'hand_off', from: 'sam' }, hub: true, since: 1 };
  const k = harness({ live: { casework: { busy: true, busySince: 'a' } }, turnOrigins: { casework: known }, openTurns: { casework: ['T1'] },
    reply: () => turnReply({ turnId: 'T1', origin: { kind: 'hand_off', from: 'cnc' }, activity: [BASH('running')] }) });
  await k.mod.turnOriginFetch('casework');   // origin known, steps not: one fetch
  assert.strictEqual(k.calls.length, 1);
  assert.strictEqual(k.turnOrigins.casework, known);
  assert.strictEqual(k.mod.chatBusyDetail('casework'), 'running a command: sleep 60');
  await k.mod.turnOriginFetch('casework');   // both known now
  assert.strictEqual(k.calls.length, 1);
});

// setLive / applySnapshot with the real source
function liveHarness(live = {}, extra = {}) {
  const repainted = [];
  const turnSteps = extra.turnSteps || {};
  const setLiveSrc = cut('function setLive(name, patch)', '// opts.namedOnly');
  const snapSrc = cut('function applySnapshot(map', 'let wkGoneState = {};');
  const turnOrigins = extra.turnOrigins || {};
  const mod = new Function('live', 'turnSteps', 'turnOrigins', 'openTurns', 'repaintAgentStatus', 'paintStatus', 'busyIsWorker', 'followedHubTurn', 'reattachIfIdle', 'wkSeen', 'workerGoneStep', 'wkInferEnd',
    `let statusKnown = false, wkGoneState = {}, current = null; ${setLiveSrc}; ${snapSrc}; return { setLive, applySnapshot };`)(
    live, turnSteps, turnOrigins, {}, (a) => repainted.push(a), () => {}, (n, e) => (e && typeof e.worker === 'boolean' ? e.worker : /^tw-/.test(n)), () => false, () => {}, new Map(), () => ({ gone: [], next: {} }), () => {});
  return { mod, repainted, live, turnSteps, turnOrigins };
}

test('setLive: a consultedBy change X -> Y repaints both X and Y; a helper repaints its parent', () => {
  const h = liveHarness({ forge: { busy: true, busySince: 'a', consultedBy: 'x' } });
  h.mod.setLive('forge', { consultedBy: 'y' });
  assert.deepStrictEqual([...h.repainted].sort(), ['x', 'y']);
  h.repainted.length = 0;
  h.mod.setLive('forge', { busy: false });   // idle: whoever waited says so
  assert.deepStrictEqual(h.repainted, ['y']);
  h.repainted.length = 0;
  h.mod.setLive('tw-1', { busy: true, worker: true, parent: 'casework', consultedBy: 'sam' });
  assert.deepStrictEqual([...h.repainted].sort(), ['casework', 'sam']);
  h.repainted.length = 0;
  h.mod.setLive('casework', { busy: true });   // not a helper, no waiter, never itself
  assert.deepStrictEqual(h.repainted, []);
});

test('setLive: an agent going idle drops its steps', () => {
  const h = liveHarness({ casework: { busy: true, busySince: 'a' } }, { turnSteps: { casework: V.chatViewStepsNew(), sam: V.chatViewStepsNew() } });
  h.mod.setLive('casework', { busy: false });
  assert.deepStrictEqual(Object.keys(h.turnSteps), ['sam']);
});

test('a full status snapshot that drops a running helper repaints its parent and consultedBy agent', () => {
  const h = liveHarness({
    casework: { busy: true, busySince: 'a' },
    'tw-1': { busy: true, busySince: 'a', worker: true, parent: 'casework', consultedBy: 'sam' },
  });
  h.mod.applySnapshot({ casework: { busy: true, busySince: 'a' } });
  assert.strictEqual(h.live['tw-1'], undefined);
  assert.deepStrictEqual([...h.repainted].sort(), ['casework', 'sam']);
  // the named-only feed leaves a helper alone
  const n = liveHarness({ casework: { busy: true, busySince: 'a' }, 'tw-2': { busy: true, worker: true, parent: 'casework' } });
  n.mod.applySnapshot({ casework: { busy: true, busySince: 'a' } }, true, { namedOnly: true });
  assert.ok(n.live['tw-2']);
});

test('review r2: going idle drops the old turn\'s origin, so a missed turn_end cannot name the next turn\'s caller', () => {
  const h = liveHarness({ casework: { busy: true, busySince: 'a' } }, { turnOrigins: { casework: { turnId: 'A', origin: { kind: 'hand_off', from: 'cnc' }, hub: true, since: 1 } } });
  h.mod.setLive('casework', { busy: true, activity: 'x' });
  assert.ok(h.turnOrigins.casework, 'busy keeps it');
  h.mod.setLive('casework', { busy: false });
  assert.ok(!('casework' in h.turnOrigins));
});
