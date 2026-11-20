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

function harness({ live = {}, turnOrigins = {}, openTurns = {}, reply, elapsed, streamNames = [] } = {}) {
  const calls = [];
  const painted = [];
  const src = cut('function currentTurnOrigin(agent)', 'let busyCardEl = null');
  const busySrc = cut('function busyText(name)', 'function paintStatus()');
  const api = async (url, opts) => { calls.push({ url, opts }); return reply ? reply() : { ok: false }; };
  const S = { current: 'casework' };
  const noteSrc = cut('function noteTurnOrigin(agent', '// What the busy card says');
  const elapsedFn = elapsed || ((since) => (since ? '4m' : ''));
  const streams = new Set(streamNames);
  const mod = new Function('S', 'live', 'turnOrigins', 'openTurns', 'chatViewBusyText', 'chatViewIsHubOrigin', 'chatViewElapsed', 'chatViewWaiting', 'chatViewStep', 'displayName', 'api', 'AbortSignal', 'paintChatStatus', 'paintBusyCard', 'viewNow', 'ownTurnFor', 'elapsed', 'streams', 'screen', 'renderAgents',
    `const current = S.current; ${noteSrc}; ${src}; ${busySrc}; return { chatBusyWords, chatBusyDetail, turnOriginFetch, busyText, noteTurnOrigin, noteTurnStep, turnStep };`)(
    S, live, turnOrigins, openTurns, V.chatViewBusyText, V.chatViewIsHubOrigin, V.chatViewElapsed, V.chatViewWaiting, V.chatViewStep, displayName, api, { timeout: (ms) => ({ ms }) },
    () => painted.push('status'), () => painted.push('card'), () => 'main', () => false, elapsedFn, streams, 'chat', () => painted.push('list'));
  return { mod, calls, painted };
}
const tick = () => new Promise(r => setImmediate(r));
const handOffTurn = { ok: true, json: async () => ({ ok: true, agent: 'casework', active: true, turn: { turnId: 'T1', origin: { kind: 'hand_off', from: 'cnc', label: 'Hand-off from cnc: x' }, startedAt: '2026-11-20T10:00:00Z' } }) };

test('a hand-off known from turnOrigins is named in the header words', () => {
  const live = { casework: { busy: true, busySince: '2026-11-20T10:00:00Z', activity: 'hand-off' } };
  const turnOrigins = { casework: { turnId: 'T1', origin: { kind: 'hand_off', from: 'cnc', label: 'Hand-off from cnc: x' }, hub: true, since: 1 } };
  const h = harness({ live, turnOrigins, openTurns: { casework: ['T1'] } });
  assert.strictEqual(h.mod.chatBusyWords('casework'), 'Working on a hand-off from CNC');
  // an origin of an older turn is not used
  const stale = harness({ live, turnOrigins, openTurns: { casework: ['T2'] } });
  assert.strictEqual(stale.mod.chatBusyWords('casework'), 'Working on a hand-off');
});

test('status feed only: vague words, one fetch per turn, then the caller is named', async () => {
  const live = { casework: { busy: true, busySince: '2026-11-20T10:00:00Z', activity: 'hand-off' } };
  const turnOrigins = {};
  const h = harness({ live, turnOrigins, reply: () => handOffTurn });
  assert.strictEqual(h.mod.chatBusyWords('casework'), 'Working on a hand-off');
  h.mod.turnOriginFetch('casework');
  h.mod.turnOriginFetch('casework');   // in flight: no second request
  await tick(); await tick();
  assert.strictEqual(h.calls.length, 1);
  assert.strictEqual(h.calls[0].url, '/api/agents/casework/turn');
  assert.ok(turnOrigins.casework, 'origin noted');
  assert.strictEqual(h.mod.chatBusyWords('casework'), 'Working on a hand-off from CNC');
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
  assert.strictEqual(h.mod.busyText('casework'), '⏳ Working on a hand-off · 4m');
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
  const mod = new Function('S', 'live', 'turnOrigins', 'openTurns', 'chatViewBusyText', 'chatViewIsHubOrigin', 'chatViewElapsed', 'chatViewWaiting', 'chatViewStep', 'displayName', 'api', 'AbortSignal', 'paintBusyCard', 'viewNow', 'ownTurnFor', 'streams', 'screen', 'renderAgents', '$', 'agentByName', 'modelText', 'isBusy', 'paintNotifyBtn', 'setSendMode',
    `const current = S.current; ${elapsedSrc}; ${noteSrc}; ${src}; ${busySrc}; ${fullSrc}; ${paintSrc}; return { paintChatStatus, chatStatusFull, noteTurnStep, turnOriginFetch, turnStep, chatBusyDetail };`)(
    S, live, turnOrigins, openTurns, V.chatViewBusyText, V.chatViewIsHubOrigin, V.chatViewElapsed, V.chatViewWaiting, V.chatViewStep, displayName, async () => ({ ok: false }), { timeout: () => ({}) },
    () => {}, () => 'main', () => false, new Set(), 'chat', () => {},
    (id) => (id === 'chat-busy' ? el : id === 'chat-model' ? { textContent: '' } : stub), () => ({}), () => 'model', (n) => !!(live[n] && live[n].busy), () => {}, () => {});
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
  assert.strictEqual(h.el.textContent, '⏳ Working on a hand-off from CNC · 9m · waiting on 1 helper (RULES coder, 9 min)');
  assert.strictEqual(h.el.hidden, false);
  assert.match(h.mod.chatStatusFull('casework'), /^Casework: Working on a hand-off from CNC · 9 min · waiting on 1 helper \(RULES coder, 9 min\)$/);
  // the helper is done: no more detail
  live.wk.busy = false;
  h.mod.paintChatStatus();
  assert.strictEqual(h.el.textContent, '⏳ Working on a hand-off from CNC · 9m');
});

test('(b) with no helpers the header shows the running tool step; a done item with the same callId clears it', () => {
  const live = { casework: { busy: true, busySince: minsAgo(9), activity: 'hand-off' } };
  const h = headerHarness({ live, turnOrigins: { casework: handOffOrigin }, openTurns: { casework: ['T1'] } });
  h.mod.noteTurnStep('casework', { kind: 'tool', tool: 'mcp__hub__Bash', summary: 'npm test', status: 'running', callId: 'c1' });
  h.mod.paintChatStatus();
  assert.match(h.el.textContent, /· running a command: npm test$/);
  h.mod.noteTurnStep('casework', { kind: 'tool', tool: 'mcp__hub__Bash', status: 'done', callId: 'c0' });   // another call's end: kept
  assert.strictEqual(h.mod.turnStep.casework.callId, 'c1');
  h.mod.noteTurnStep('casework', { kind: 'tool', tool: 'mcp__hub__Bash', status: 'done', callId: 'c1' });
  assert.strictEqual(h.mod.turnStep.casework, undefined);
  h.mod.paintChatStatus();
  assert.strictEqual(h.el.textContent, '⏳ Working on a hand-off from CNC · 9m');
  // helpers win over the step
  live.wk = { busy: true, busySince: minsAgo(2), worker: true, parent: 'casework', label: 'RULES coder' };
  h.mod.noteTurnStep('casework', { kind: 'tool', tool: 'spawn_workers', status: 'running', callId: 'c2' });
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
  assert.match(row, /Working on a hand-off from CNC/);
  assert.match(row, /waiting on 1 helper \(RULES coder/);
  assert.notStrictEqual(row, '⏳ hand-off · 9m');
  assert.doesNotMatch(row, /⏳ hand-off/);
});

test('(d2) a worker row keeps its old text even when it has a parent', () => {
  const live = { casework: { busy: true, busySince: minsAgo(9), activity: 'hand-off' }, wk: { busy: true, busySince: minsAgo(3), worker: true, parent: 'casework', label: 'RULES coder', activity: 'working' } };
  const h = headerHarness({ live });
  assert.strictEqual(h.base.mod.busyText('wk'), '⏳ working · 4m');   // the base harness's elapsed stub says 4m
});

test('(e) turnOriginFetch sets turnStep from the fetched activity: the last running tool without a later done', async () => {
  const activity = [
    { kind: 'tool', tool: 'mcp__hub__Read', status: 'running', callId: 'r1' },
    { kind: 'tool', tool: 'mcp__hub__Read', status: 'done', callId: 'r1' },
    { kind: 'tool', tool: 'mcp__hub__Bash', summary: 'npm test', status: 'running', callId: 'b1' },
  ];
  const reply = () => ({ ok: true, json: async () => ({ ok: true, active: true, turn: { turnId: 'T1', origin: { kind: 'hand_off', from: 'cnc' }, startedAt: '2026-11-20T10:00:00Z', activity } }) });
  const h = harness({ live: { casework: { busy: true, busySince: 'a', activity: 'hand-off' } }, reply });
  await h.mod.turnOriginFetch('casework');
  assert.strictEqual(h.mod.turnStep.casework.callId, 'b1');
  assert.strictEqual(h.mod.chatBusyDetail('casework'), 'running a command: npm test');
  // a closed last call leaves nothing
  const closed = harness({ live: { casework: { busy: true, busySince: 'b', activity: 'hand-off' } }, reply: () => ({ ok: true, json: async () => ({ ok: true, active: true, turn: { turnId: 'T2', origin: { kind: 'hand_off', from: 'cnc' }, activity: activity.slice(0, 2) } }) }) });
  await closed.mod.turnOriginFetch('casework');
  assert.strictEqual(closed.mod.turnStep.casework, undefined);
});

test('wiring: a second turn_activity handler, step cleared at turn start/end, helper changes repaint the parent, 15 s tick', () => {
  assert.match(js, /on\('turn_activity', \(ev\) => \{ if \(ev && ev\.agent\) noteTurnStep\(ev\.agent, ev\.item\); \}\)/);
  assert.match(cut('function onTurnStart(ev)', 'if (ev.turnId && hubTurns'), /delete turnStep\[ev\.agent\]/);
  assert.match(cut('function onTurnEnd(ev)', 'if (!activeTurnEnd'), /delete turnStep\[ev\.agent\]/);
  assert.match(cut('function setLive(name, patch)', 'if (!next.busy && typeof voiceCallHubIdle'), /repaintAgentStatus\(waiter\)/);
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
