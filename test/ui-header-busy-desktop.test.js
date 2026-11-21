'use strict';
// Desktop page: the status line under the tabs (status-dot-/status-text-) follows the hub's status feed while this
// window is not streaming the turn itself. Page functions are cut out of app.js and run with fakes.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const V = require('../lib/ui-chat-view.js');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function extract(name) {
  let at = src.indexOf(`async function ${name}(`);
  if (at < 0) at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} present`);
  let p = src.indexOf('(', at); let pd = 0;
  for (; p < src.length; p++) { if (src[p] === '(') pd++; else if (src[p] === ')' && --pd === 0) break; }
  let i = src.indexOf('{', p); let depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(at, i + 1);
}
const NOW = 10 * 3600 * 1000;
const nameOf = (n) => (n === 'cnc' ? 'CNC' : n.charAt(0).toUpperCase() + n.slice(1));

function page({ status = {}, run = {}, chat = {}, fetchImpl = null } = {}) {
  const dot = { className: 'status-dot idle' };
  const text = { textContent: 'Idle', dataset: {} };
  const tab = { className: 'status idle' };
  const fetches = [];
  const chatObj = { id: 'c1', agent: 'casework', status: 'idle', ...chat };
  const chats = { c1: chatObj };
  const doc = {
    getElementById: (id) => (id === 'status-dot-c1' ? dot : id === 'status-text-c1' ? text : null),
    querySelector: (sel) => (sel === '#tab-c1 .status' ? tab : null),
  };
  const fetchFn = (url, opts) => { fetches.push({ url, opts }); return fetchImpl ? fetchImpl(url, opts) : Promise.reject(new Error('no fetch')); };
  const body = `${V.chatViewActivityWord}\nconst busyOriginMemo = new Set(); const busyOriginFlight = new Set(); const agentSteps = {}; const turnStepLast = {}; let agentRowTicker = null; let busyCardTimer = null;\n${['busyOriginFetch', 'headerBusyPaint', 'busyCardState', 'busyCardRefresh', 'busyCardRefreshAll', 'agentDoingNow', 'turnStepRepaintNow', 'turnStepRepaint', 'paintAgentStatus', 'agentRowTick', 'busyAgentNames', 'elapsedLabel'].map(extract).join('\n')}\nreturn { headerBusyPaint, busyOriginFetch, busyCardRefresh, agentDoingNow, turnStepRepaint, paintAgentStatus, agentSteps, agentRowTick, tickerOn: () => !!agentRowTicker };`;
  class FakeDate extends Date { static now() { return NOW; } }
  const timers = [];
  const fakeSetTimeout = (f, ms) => { timers.push({ f, ms }); return timers.length; };
  const fakeSetInterval = (f, ms) => { timers.push({ f, ms, interval: true }); return timers.length; };
  const rowEls = {};
  const rowDot = { className: '', textContent: '', title: '' };
  const rowLine = { className: 'agent-busy-line', textContent: '', title: '', classList: { toggle() {} }, removeAttribute() { this.title = ''; }, remove() { rowEls.line = null; } };
  rowEls.line = null;
  const rowBtn = { classList: { toggle() {} }, querySelector: (s) => (s === '.agent-busy-line' ? rowEls.line : s === '.agent-info' ? { appendChild: (l) => { rowEls.line = rowLine; } } : null) };
  const rowDoc = { ...doc, createElement: () => rowLine, getElementById: (id) => (id === 'agent-status-casework' || id === 'agent-status-sam' ? rowDot : id === 'agent-btn-casework' || id === 'agent-btn-sam' ? rowBtn : doc.getElementById(id)) };
  const fn = new Function('busyRun', 'agentStatus', 'document', 'chats', 'fetch', 'Date', 'chatViewBusyText', 'chatViewElapsed', 'chatViewIsHubOrigin', 'chatViewGet', 'localStorage', 'localBusy', 'agentDisplayName', 'findSoloChat', 'AbortSignal', 'chatViewWaiting', 'chatViewStep', 'chatViewStepsNew', 'chatViewStepsOn', 'chatViewStepsSnapshot', 'chatViewStepsNewest', 'setTimeout', 'setInterval', 'clearInterval', 'statusKnown', body);
  const api = fn(run, status, rowDoc, chats, fetchFn, FakeDate, V.chatViewBusyText, V.chatViewElapsed, V.chatViewIsHubOrigin, V.chatViewGet, { getItem: () => null }, new Map(), nameOf, (a) => Object.values(chats).find(c => c.agent === a) || null, AbortSignal, V.chatViewWaiting, V.chatViewStep, V.chatViewStepsNew, V.chatViewStepsOn, V.chatViewStepsSnapshot, V.chatViewStepsNewest, fakeSetTimeout, fakeSetInterval, () => {}, true);
  // the turn_activity listener of app.js: feed the agent's step state, repaint when it changed
  const onActivity = (ev) => { if (ev.agent && V.chatViewStepsOn(api.agentSteps[ev.agent] ||= V.chatViewStepsNew(), ev.turnId, ev.item)) api.turnStepRepaint(ev.agent); };
  return { ...api, onActivity, dot, text, tab, chat: chatObj, fetches, run, status, rowDot, rowLine, rowEls, timers };
}
const flush = () => new Promise(r => setImmediate(r));
const min = (n) => NOW - n * 60000;

test('(a) a hand-off turn known from busyRun: header says who and how long; chat.status is untouched', () => {
  const p = page({
    status: { casework: { busy: true, busySince: new Date(min(4)).toISOString(), activity: 'hand-off' } },
    run: { casework: { turnId: 't1', origin: { kind: 'hand_off', from: 'cnc', label: 'Hand-off from cnc: x' }, since: min(4), own: false } },
  });
  assert.strictEqual(p.headerBusyPaint(p.chat), true);
  assert.strictEqual(p.text.textContent, 'Working on a task from CNC · 4 min');
  assert.strictEqual(p.dot.className, 'status-dot thinking');
  assert.strictEqual(p.tab.className, 'status thinking');
  assert.strictEqual(p.text.dataset.hubBusy, '1');
  assert.strictEqual(p.chat.status, 'idle', 'the chat state is not touched');
  assert.strictEqual(p.fetches.length, 0, 'the turn is known: nothing to ask');
});

test('(b) status feed only: the words show, one fetch names the caller, the same turn is never asked twice', async () => {
  const since = new Date(min(2)).toISOString();
  const p = page({
    status: { casework: { busy: true, busySince: since, activity: 'hand-off' } },
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, agent: 'casework', active: true, turn: { turnId: 't9', origin: { kind: 'hand_off', from: 'cnc', label: 'Hand-off from cnc: x' }, startedAt: new Date(min(2)).toISOString() } }) }),
  });
  assert.strictEqual(p.headerBusyPaint(p.chat), true);
  assert.strictEqual(p.text.textContent, 'Working on a task · 2 min');
  p.headerBusyPaint(p.chat);   // a second paint while the request is in flight
  assert.strictEqual(p.fetches.length, 1);
  assert.strictEqual(p.fetches[0].url, '/api/agents/casework/turn');
  assert.strictEqual(p.fetches[0].opts.credentials, 'include');
  assert.ok(p.fetches[0].opts.signal, 'a timeout signal');
  await flush();
  assert.strictEqual(p.run.casework.turnId, 't9');
  assert.strictEqual(p.run.casework.own, false);
  assert.strictEqual(p.run.casework.since, min(2));
  p.busyCardRefresh(p.chat);   // what the 5 s timer does
  assert.strictEqual(p.text.textContent, 'Working on a task from CNC · 2 min');
  p.headerBusyPaint(p.chat); p.busyOriginFetch('casework');
  delete p.run.casework;       // even if the run were forgotten, the same busySince is not asked again
  p.headerBusyPaint(p.chat);
  await flush();
  assert.strictEqual(p.fetches.length, 1, 'no second fetch for the same busySince');
});

test('(b2) a failed fetch is not retried for the same turn and leaves the words', async () => {
  const p = page({ status: { casework: { busy: true, busySince: new Date(min(1)).toISOString(), activity: 'hand-off' } } });
  p.headerBusyPaint(p.chat);
  await flush();
  p.headerBusyPaint(p.chat);
  await flush();
  assert.strictEqual(p.fetches.length, 1);
  assert.strictEqual(p.text.textContent, 'Working on a task · 1 min');
});

test('(c) the agent goes idle: the line says Idle again and the marker is gone', () => {
  const p = page({
    status: { casework: { busy: true, busySince: new Date(min(4)).toISOString(), activity: 'hand-off' } },
    run: { casework: { turnId: 't1', origin: { kind: 'hand_off', from: 'cnc' }, since: min(4), own: false } },
  });
  p.headerBusyPaint(p.chat);
  assert.strictEqual(p.text.dataset.hubBusy, '1');
  p.status.casework.busy = false;
  assert.strictEqual(p.headerBusyPaint(p.chat), false);
  assert.strictEqual(p.text.textContent, 'Idle');
  assert.strictEqual(p.dot.className, 'status-dot idle');
  assert.strictEqual(p.tab.className, 'status idle');
  assert.ok(!('hubBusy' in p.text.dataset));
});

test('(c2) going idle never overwrites a line this window owns (marker absent)', () => {
  const p = page({ status: { casework: { busy: false } } });
  p.text.textContent = 'Processing...'; p.dot.className = 'status-dot thinking';
  assert.strictEqual(p.headerBusyPaint(p.chat), false);
  assert.strictEqual(p.text.textContent, 'Processing...');
});

test('(d) an own stream (controller, reattach) or thinking/paused chat: nothing is written', () => {
  for (const extra of [{ controller: {} }, { reattach: true }, { status: 'thinking' }, { status: 'paused' }, { isGroup: true }, { isWorker: true }, { isHistory: true }]) {
    const p = page({ status: { casework: { busy: true, busySince: new Date(min(1)).toISOString(), activity: 'hand-off' } }, chat: extra });
    assert.strictEqual(p.headerBusyPaint(p.chat), false, JSON.stringify(extra));
    assert.strictEqual(p.text.textContent, 'Idle');
    assert.strictEqual(p.dot.className, 'status-dot idle');
    assert.strictEqual(p.fetches.length, 0);
  }
});

test('(e) a pending question: "Waiting for your answer · time"', () => {
  const p = page({ status: { casework: { busy: false, pendingQuestion: true, busySince: new Date(min(3)).toISOString(), activity: 'consulted by cnc' } } });
  assert.strictEqual(p.headerBusyPaint(p.chat), true);
  assert.strictEqual(p.text.textContent, 'Waiting for your answer · 3 min');
  assert.strictEqual(p.dot.className, 'status-dot thinking');
});

test('busyCardRefresh returns true while only the header shows work (no panel), so the 5 s timer keeps running', () => {
  const p = page({ status: { casework: { busy: true, busySince: new Date(min(1)).toISOString(), activity: 'scheduled task: nightly' } } });
  assert.strictEqual(p.busyCardRefresh(p.chat), true);
  p.status.casework.busy = false;
  assert.strictEqual(p.busyCardRefresh(p.chat), false);
  assert.strictEqual(p.text.textContent, 'Idle');
});

// ── what the agent does NOW: the helper it waits on, or its current step ──
const handOffRun = { casework: { turnId: 't1', origin: { kind: 'hand_off', from: 'cnc', label: 'Hand-off from cnc: x' }, since: min(9), own: false } };
const waitingStatus = () => ({
  casework: { busy: true, busySince: new Date(min(9)).toISOString(), activity: 'hand-off' },
  w1: { busy: true, worker: true, parent: 'casework', label: 'RULES coder', busySince: new Date(min(9)).toISOString(), activity: 'working' },
});

test('(now-a) blocked on a helper: the header says who started the turn, how long and what it waits on', () => {
  const p = page({ status: waitingStatus(), run: handOffRun });
  assert.strictEqual(p.headerBusyPaint(p.chat), true);
  assert.strictEqual(p.text.textContent, 'Working on a task from CNC · 9 min · waiting on 1 helper (RULES coder, 9 min)');
});

test('(now-b) no helpers: the current tool step ends the line; its done item (same callId) clears it', () => {
  const p = page({ status: { casework: { busy: true, busySince: new Date(min(2)).toISOString(), activity: 'hand-off' } }, run: handOffRun });
  p.onActivity({ agent: 'casework', item: { kind: 'tool', tool: 'mcp__hub__Bash', summary: 'npm test', status: 'running', callId: 'k1' } });
  p.headerBusyPaint(p.chat);
  assert.match(p.text.textContent, /^Working on a task from CNC · 9 min · running a command: npm test$/);
  p.onActivity({ agent: 'casework', item: { kind: 'tool', tool: 'mcp__hub__Bash', status: 'done', callId: 'other' } });
  assert.ok(V.chatViewStepsNewest(p.agentSteps.casework), 'another call finishing does not clear the step');
  p.onActivity({ agent: 'casework', item: { kind: 'tool', tool: 'mcp__hub__Bash', status: 'done', callId: 'k1' } });
  assert.strictEqual(V.chatViewStepsNewest(p.agentSteps.casework), null);
  p.headerBusyPaint(p.chat);
  assert.strictEqual(p.text.textContent, 'Working on a task from CNC · 9 min');
});

test('(now-b2) a burst of steps repaints an agent at most once per 500 ms (one trailing call)', () => {
  const p = page({ status: { casework: { busy: true, busySince: new Date(min(2)).toISOString(), activity: 'hand-off' } }, run: handOffRun });
  for (let i = 0; i < 5; i++) p.onActivity({ agent: 'casework', item: { kind: 'tool', tool: 'Read', status: 'running', callId: 'r' + i } });
  assert.strictEqual(p.timers.filter(t => !t.interval && t.ms <= 500).length, 1, 'first paints at once, the rest share one trailing timer');
  assert.strictEqual(V.chatViewStepsNewest(p.agentSteps.casework).callId, 'r4');
});

test('(now-c) the agent list row says what it does now and is never just the status word', () => {
  const p = page({ status: waitingStatus(), run: handOffRun });
  p.paintAgentStatus('casework');
  const t = p.rowLine.textContent;
  assert.notStrictEqual(t, '⏳ hand-off · 9m');
  assert.ok(t.includes('Working on a task from CNC'), t);
  assert.ok(t.includes('waiting on 1 helper (RULES coder'), t);
  assert.strictEqual(t, '⏳ Working on a task from CNC · 9m · waiting on 1 helper (RULES coder, 9 min)');
  assert.strictEqual(p.rowLine.title, 'Working on a task from CNC · 9 min · waiting on 1 helper (RULES coder, 9 min)');
  assert.strictEqual(p.rowDot.title, p.rowLine.title);
  assert.ok(p.timers.some(t2 => t2.interval && t2.ms <= 15000), 'a ticker repaints busy rows at least every 15 s');
});

test('(now-d) a worker row and a question row keep their old text', () => {
  const p = page({ status: { sam: { busy: true, worker: true, parent: 'casework', label: 'RULES coder', busySince: new Date(min(3)).toISOString(), activity: 'working' } } });
  p.paintAgentStatus('sam');
  assert.strictEqual(p.rowLine.textContent, '⏳ working · 3m');
  const q = page({ status: { casework: { busy: true, pendingQuestion: true, busySince: new Date(min(3)).toISOString(), activity: 'hand-off' } } });
  q.paintAgentStatus('casework');
  assert.strictEqual(q.rowLine.textContent, '❓ waiting for your answer · 3m');
});

test('(now-e) busyOriginFetch sets the step from a fetched activity list: the last running tool no done item closes', async () => {
  const activity = [
    { kind: 'tool', tool: 'Read', summary: 'a.js', status: 'running', callId: 'a' },
    { kind: 'tool', tool: 'Read', status: 'done', callId: 'a' },
    { kind: 'tool', tool: 'mcp__hub__Bash', summary: 'npm test', status: 'running', callId: 'b' },
  ];
  const p = page({
    status: { casework: { busy: true, busySince: new Date(min(2)).toISOString(), activity: 'hand-off' } },
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, active: true, turn: { turnId: 't9', origin: { kind: 'hand_off', from: 'cnc' }, startedAt: new Date(min(2)).toISOString(), activity } }) }),
  });
  p.busyOriginFetch('casework');
  await flush();
  assert.strictEqual(V.chatViewStepsNewest(p.agentSteps.casework).callId, 'b');
  p.headerBusyPaint(p.chat);
  assert.strictEqual(p.text.textContent, 'Working on a task from CNC · 2 min · running a command: npm test');
});

test('wiring in app.js: the listener, turn_start/end, setAgentLive and the row ticker feed the step and the helper line', () => {
  assert.match(src, /addEventListener\('turn_activity', e => \{ const ev = parse\(e\); if \(ev\) \{ try \{ if \(ev\.agent && chatViewStepsOn\(agentSteps\[ev\.agent\] \|\|= chatViewStepsNew\(\), ev\.turnId, ev\.item\)\) turnStepRepaint\(ev\.agent\); \} catch \{\}/);
  assert.ok(!/agentSteps/.test(extract('onHubTurnStart')), 'a replayed turn_start must not wipe the live step');
  assert.match(extract('onHubTurnEnd'), /chatViewStepsEndTurn\(agentSteps\[ev\.agent\], ev\.turnId\)/);
  const s = extract('setAgentLive');
  assert.match(s, /repaintWaiters\(name, cur, next\);/);
  assert.match(extract('repaintWaiters'), /if \(r\.worker && r\.parent\) who\.add\(r\.parent\); if \(r\.consultedBy\) who\.add\(r\.consultedBy\);/);
  assert.match(extract('paintAgentStatus'), /setInterval\(agentRowTick, 15000\)/);
});

test('wiring in app.js: setStatus clears the marker on thinking and repaints at its end; switchToChat refreshes', () => {
  const s = extract('setStatus');
  assert.match(s, /textContent = statusText \|\| [^\n]*\n\s*delete statusTextEl\.dataset\.hubBusy; delete statusTextEl\.dataset\.hubPrev;/);   // any text setStatus writes is the chat's own
  assert.match(s, /status !== 'thinking'\) chats\[chatId\]\.ownEndedAt = Date\.now\(\)/);
  assert.match(s, /if \(status !== 'thinking' && status !== 'paused'\) \{ try \{ headerBusyPaint\(chats\[chatId\]\); \} catch \{\} \}\s*\}$/);
  assert.match(extract('switchToChat'), /busyCardRefresh\(opened\)/);
  assert.match(extract('busyCardRefresh'), /headerBusyPaint\(chat\)/);
});

// ── steps per call and per turn ──
const tool = (name, status, callId, summary) => ({ kind: 'tool', tool: name, status, callId, ...(summary ? { summary } : {}) });
const busyStatus = () => ({ casework: { busy: true, busySince: new Date(min(2)).toISOString(), activity: 'hand-off' } });

test('(steps-a) parallel calls: a long Bash then a Read; the Read finishing shows the Bash again', () => {
  const p = page({ status: busyStatus(), run: handOffRun });
  p.onActivity({ agent: 'casework', turnId: 't1', item: tool('Bash', 'running', 'b1', 'npm test') });
  p.onActivity({ agent: 'casework', turnId: 't1', item: tool('Read', 'running', 'r1', 'a.js') });
  p.headerBusyPaint(p.chat);
  assert.match(p.text.textContent, /reading a file: a\.js$/);
  p.onActivity({ agent: 'casework', turnId: 't1', item: tool('Read', 'done', 'r1') });
  p.headerBusyPaint(p.chat);
  assert.match(p.text.textContent, /running a command: npm test$/);
});

test('(steps-b) overlapping turns: one turn ending leaves the other turn\'s step', () => {
  const p = page({ status: busyStatus(), run: handOffRun });
  p.onActivity({ agent: 'casework', turnId: 'A', item: tool('Bash', 'running', 'x', 'build') });
  p.onActivity({ agent: 'casework', turnId: 'B', item: tool('Read', 'running', 'x', 'b.js') });
  assert.strictEqual(V.chatViewStepsEndTurn(p.agentSteps.casework, 'B'), true);
  p.headerBusyPaint(p.chat);
  assert.match(p.text.textContent, /running a command: build$/);
  V.chatViewStepsEndTurn(p.agentSteps.casework, 'A');
  p.headerBusyPaint(p.chat);
  assert.strictEqual(p.text.textContent, 'Working on a task from CNC · 9 min');
});

// ── a late answer of the origin fetch ──
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const turnAnswer = (activity, extra = {}) => ({ ok: true, json: async () => ({ ok: true, active: true, turn: { turnId: 't9', origin: { kind: 'hand_off', from: 'cnc' }, startedAt: new Date(min(2)).toISOString(), activity, ...extra } }) });

test('(late-a) a done event that arrives before the fetch answer keeps that call gone', async () => {
  const d = deferred();
  const p = page({ status: busyStatus(), fetchImpl: () => d.promise });
  p.busyOriginFetch('casework');
  p.onActivity({ agent: 'casework', turnId: 't9', item: tool('Bash', 'running', 'k1', 'npm test') });
  p.onActivity({ agent: 'casework', turnId: 't9', item: tool('Bash', 'done', 'k1') });
  d.resolve(turnAnswer([tool('Bash', 'running', 'k1', 'npm test')]));
  await flush();
  assert.strictEqual(V.chatViewStepsNewest(p.agentSteps.casework), null, 'the finished call is not brought back');
  assert.strictEqual(p.run.casework.turnId, 't9', 'the origin still applies');
});

test('(late-b) a fetch answered after busySince changed applies nothing', async () => {
  const d = deferred();
  const p = page({ status: busyStatus(), fetchImpl: () => d.promise });
  p.busyOriginFetch('casework');
  p.status.casework.busySince = new Date(min(1)).toISOString();   // a new turn began meanwhile
  d.resolve(turnAnswer([tool('Bash', 'running', 'k1', 'old')]));
  await flush();
  assert.strictEqual(p.agentSteps.casework, undefined);
  assert.strictEqual(p.run.casework, undefined);
  const q = page({ status: busyStatus(), fetchImpl: () => d.promise });
  const d2 = deferred(); q.busyOriginFetch('casework');
  q.status.casework.busy = false;   // or the turn ended
  await flush();
  assert.strictEqual(q.run.casework, undefined);
});

test('(late-c) the steps apply even when the fetched turn has no origin; busyRun stays unset', async () => {
  const p = page({ status: busyStatus(), fetchImpl: async () => turnAnswer([tool('Read', 'running', 'r1', 'a.js')], { origin: null }) });
  p.busyOriginFetch('casework');
  await flush();
  assert.strictEqual(V.chatViewStepsNewest(p.agentSteps.casework).callId, 'r1');
  assert.strictEqual(p.run.casework, undefined);
});

// ── the line after an error, the timer, the own-stream flicker ──
test('(err) the line shows what it said before a hub turn took it, once the agent is idle again', () => {
  const p = page({ status: busyStatus(), run: handOffRun, chat: { status: 'error' } });
  p.text.textContent = 'Error: x'; p.dot.className = 'status-dot error'; p.tab.className = 'status error';
  p.headerBusyPaint(p.chat);
  assert.match(p.text.textContent, /^Working on a task/);
  assert.strictEqual(p.text.dataset.hubPrev, 'Error: x');
  p.headerBusyPaint(p.chat);   // a second paint keeps the saved text
  assert.strictEqual(p.text.dataset.hubPrev, 'Error: x');
  p.status.casework.busy = false;
  p.headerBusyPaint(p.chat);
  assert.strictEqual(p.text.textContent, 'Error: x');
  assert.strictEqual(p.dot.className, 'status-dot error');
  assert.ok(!('hubBusy' in p.text.dataset) && !('hubPrev' in p.text.dataset));
  // no saved text: the status word
  for (const [st, word] of [['error', 'Error'], ['idle', 'Idle']]) {
    const q = page({ status: busyStatus(), chat: { status: st } });
    q.text.dataset.hubBusy = '1'; q.text.textContent = 'Working on something';
    q.status.casework.busy = false;
    q.headerBusyPaint(q.chat);
    assert.strictEqual(q.text.textContent, word);
  }
});

test('(timer) the 5 s timer starts when only the header shows work (no card panel)', () => {
  const p = page({ status: busyStatus(), run: handOffRun });
  assert.strictEqual(p.timers.filter(t => t.interval && t.ms === 5000).length, 0);
  assert.strictEqual(p.busyCardRefresh(p.chat), true);
  assert.strictEqual(p.timers.filter(t => t.interval && t.ms === 5000).length, 1);
  p.busyCardRefresh(p.chat);
  assert.strictEqual(p.timers.filter(t => t.interval && t.ms === 5000).length, 1, 'one timer only');
});

test('(flicker) no working text within 4 s of this window\'s own stream ending; normal painting after', () => {
  for (const setup of [{ run: { casework: { turnId: 't', origin: { kind: 'user' }, since: min(1), own: true } }, activity: 'working' }, { run: {}, activity: 'replying to you' }]) {
    const p = page({ status: { casework: { busy: true, busySince: new Date(min(1)).toISOString(), activity: setup.activity } }, run: setup.run, chat: { ownEndedAt: NOW - 1000 } });
    assert.strictEqual(p.headerBusyPaint(p.chat), true, 'still counts as working, so the timer runs');
    assert.strictEqual(p.text.textContent, 'Idle', 'no working text yet');
    p.chat.ownEndedAt = NOW - 4500;   // what the 5 s timer sees later
    p.headerBusyPaint(p.chat);
    assert.match(p.text.textContent, /^(Replying to your message|Working on|Replying)|·/);
    assert.notStrictEqual(p.text.textContent, 'Idle');
  }
  const h = page({ status: busyStatus(), run: handOffRun, chat: { ownEndedAt: NOW - 1000 } });   // a hand-off is not the person's own turn
  h.headerBusyPaint(h.chat);
  assert.match(h.text.textContent, /^Working on a task from CNC/);
});

// ── setAgentLive / applyStatusSnapshot / setStatus ──
function livePage() {
  const calls = [];
  const body = `const agentStatus = {}, openTurns = {}, agentSteps = {}, busyRun = {}; let statusKnown = false;
    const findSoloChat = (n) => ({ solo: n }), busyCardRefresh = (c) => calls.push('card:' + c.solo);
    const paintAgentStatus = (n) => calls.push('row:' + n), paintAgentsWorking = () => {}, paintAllAgentStatus = () => {}, reattachIfIdle = () => {};
    const busyIsWorker = (name, e) => e && typeof e.worker === 'boolean' ? e.worker : /^tw-/.test(name);
    ${extract('setAgentLive')}
    ${extract('repaintWaiters')}
    ${extract('dropGoneWorker')}
    ${extract('statusPatchOf')}
    const chats = {}; let workerGoneState = {}; const endWorkerRunUnreported = () => {};
    ${extract('workerGoneStep')}
    ${extract('applyStatusSnapshot')}
    return { agentStatus, agentSteps, busyRun, setAgentLive, applyStatusSnapshot };`;
  return { ...new Function('calls', body)(calls), calls };
}

test('(live-a) going idle drops the agent\'s steps and its old turn origin; going busy keeps them', () => {
  const p = livePage();
  p.setAgentLive('casework', { busy: true });
  p.agentSteps.casework = V.chatViewStepsNew(); p.busyRun.casework = { turnId: 't1' };
  p.setAgentLive('casework', { busy: true, activity: 'x' });
  assert.ok(p.agentSteps.casework && p.busyRun.casework);
  p.setAgentLive('casework', { busy: false });
  assert.ok(!('casework' in p.agentSteps) && !('casework' in p.busyRun));
});

test('(live-b) a helper that vanishes from a full snapshot repaints its parent and its consultedBy agent', () => {
  const p = livePage();
  p.applyStatusSnapshot({ lead: { busy: true }, 'tw-lead-1': { busy: true, worker: true, parent: 'lead', consultedBy: 'boss' } });
  p.calls.length = 0;
  p.applyStatusSnapshot({ lead: { busy: true } });
  assert.ok(!('tw-lead-1' in p.agentStatus));
  assert.ok(p.calls.includes('row:lead') && p.calls.includes('card:lead'), p.calls.join());
  assert.ok(p.calls.includes('row:boss') && p.calls.includes('card:boss'), p.calls.join());
});
