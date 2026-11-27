'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHubEvents } = require('../lib/hub-events');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

function fakeClient(headers = {}) {
  const out = [];
  const handlers = {};
  const res = {
    writableLength: 0,
    writeHead(code, h) { out.push({ head: code, h }); },
    write(s) { out.push(s); return true; },
    on(ev, fn) { handlers[ev] = fn; },
    destroy() { handlers.close?.(); },
  };
  return { req: { headers }, res, out, close: () => handlers.close?.() };
}
const parseFrames = out => out.filter(s => typeof s === 'string' && s.startsWith('id: ')).map(s => JSON.parse(s.split('\ndata: ')[1]));
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('publish reaches subscribers as named SSE events and is kept for replay', () => {
  const hub = createHubEvents({ now: () => 1000 });
  const c = fakeClient();
  hub.subscribe(c.req, c.res);
  assert.equal(c.out[0].head, 200);
  assert.match(c.out[1], /^event: hello\n/);
  hub.publish('turn_start', { agent: 'worker', origin: { kind: 'job_notice' } });
  const frames = parseFrames(c.out);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, 'turn_start');
  assert.equal(frames[0].agent, 'worker');
  assert.equal(frames[0].id, 1);
  assert.match(c.out[2], /^event: status_snapshot\n/);
  assert.match(c.out[3], /^id: 1\nevent: turn_start\ndata: /);
  c.close();
  hub.publish('turn_end', { agent: 'worker' });
  assert.equal(parseFrames(c.out).length, 1, 'closed client gets nothing more');
  assert.equal(hub.clientCount(), 0);
});

test('reconnect with Last-Event-ID replays only what was missed', () => {
  const hub = createHubEvents();
  hub.publish('turn_start', { agent: 'a' });
  hub.publish('turn_end', { agent: 'a' });
  hub.publish('turn_start', { agent: 'b' });
  const c = fakeClient({ 'last-event-id': '1' });
  hub.subscribe(c.req, c.res);
  const frames = parseFrames(c.out);
  assert.deepEqual(frames.map(f => f.id), [2, 3]);
  const fresh = fakeClient();
  hub.subscribe(fresh.req, fresh.res);
  assert.equal(parseFrames(fresh.out).length, 0, 'a fresh client is not flooded with history');
  assert.match(fresh.out[1], /"lastId":3/);
});

test('eventFilter: applied to every delivered event, live and from the replay buffer, after the other filters; an error drops the event', () => {
  const hub = createHubEvents();
  hub.publish('research_progress', { agent: 'a', id: 'old-run' });
  hub.publish('research_progress', { agent: 'a', id: 'cur-run' });
  hub.publish('turn_start', { agent: 'a' });
  const seen = [];
  const eventFilter = (ev) => { seen.push(ev.seq); if (ev.id === 'boom') throw new Error('x'); return !(ev.type === 'research_progress' && ev.id === 'old-run'); };
  // replay: the first event is dropped by eventFilter, the rest pass
  const r = fakeClient({ 'last-event-id': '0' });
  hub.subscribe(r.req, r.res, { isAdmin: false, filter: () => true, eventFilter });
  assert.equal(parseFrames(r.out).length, 0, 'last-event-id 0 is a fresh client');
  const r2 = fakeClient();
  r2.req.url = '/api/events?since=1';
  hub.subscribe(r2.req, r2.res, { isAdmin: false, filter: () => true, eventFilter });
  assert.deepEqual(parseFrames(r2.out).map(f => f.id), ['cur-run', 3], 'replay goes through eventFilter');
  const r3 = fakeClient();
  r3.req.url = '/api/events?since=0.5';
  hub.subscribe(r3.req, r3.res, { isAdmin: false, filter: () => true, eventFilter });
  // the replay that does reach the dropped event (seq 1): only eventFilter keeps it out (review r4)
  assert.deepEqual(parseFrames(r3.out).map(f => f.id), ['cur-run', 3], 'replay drops the event eventFilter refuses');
  // live
  const c = fakeClient();
  hub.subscribe(c.req, c.res, { isAdmin: false, filter: () => true, eventFilter });
  hub.publish('research_progress', { agent: 'a', id: 'old-run' });
  hub.publish('research_progress', { agent: 'a', id: 'boom' });
  hub.publish('research_progress', { agent: 'a', id: 'cur-run' });
  assert.deepEqual(parseFrames(c.out).map(f => f.id), ['cur-run'], 'live events go through eventFilter; a throwing one is dropped');
  // the other filters still come first: an event the member's filter refuses never reaches eventFilter
  const calls = [];
  const d = fakeClient();
  hub.subscribe(d.req, d.res, { isAdmin: false, filter: () => false, eventFilter: (ev) => { calls.push(ev.seq); return true; } });
  hub.publish('turn_start', { agent: 'zz' });
  assert.deepEqual(calls, []);
  // a subscriber without opts, and one without an eventFilter, are unchanged
  const plain = fakeClient();
  hub.subscribe(plain.req, plain.res);
  const noF = fakeClient();
  hub.subscribe(noF.req, noF.res, { isAdmin: false, filter: () => true });
  hub.publish('research_progress', { agent: 'a', id: 'old-run' });
  assert.equal(parseFrames(plain.out).length, 1);
  assert.equal(parseFrames(noF.out).length, 1);
});

test('tapTurn broadcasts start, throttled text snapshots and the final reply, then restores res.write', async () => {
  const hub = createHubEvents();
  const c = fakeClient();
  hub.subscribe(c.req, c.res);
  const written = [];
  const res = { write: s => { written.push(s); return true; } };
  const origWrite = res.write;
  const tap = hub.tapTurn(res, { agent: 'worker', origin: { kind: 'job_notice', jobId: 'j1' }, message: '[Job finished] …' });
  res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello ' } }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'world' } }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ gateway: { type: 'tool_start' } }) + '\n\n');   // no content: ignored
  res.write('data: [DONE]\n\n');
  assert.equal(written.length, 4, 'the real response still gets every chunk');
  await sleep(400);
  res.write('data: ' + JSON.stringify({ gateway: { type: 'tool_result' } }) + '\n\n');   // still no text: no delta
  await sleep(400);
  let all = parseFrames(c.out);
  // Tool chatter is published as compact turn_activity items (the live activity feed), never as text deltas.
  assert.deepEqual(all.filter(f => f.type === 'turn_activity').map(f => [f.item.kind, f.item.status]), [['tool', 'running'], ['tool', 'done']]);
  let frames = all.filter(f => f.type !== 'turn_activity');
  assert.deepEqual(frames.map(f => f.type), ['turn_start', 'turn_delta'], 'one delta for the text');
  assert.equal(frames[0].message, '[Job finished] …');
  assert.equal(frames[0].origin.jobId, 'j1');
  assert.equal(frames[1].text, 'Hello world');
  assert.equal(frames[1].turnId, frames[0].turnId);
  tap.finish(true);
  tap.finish(true);   // idempotent
  frames = parseFrames(c.out).filter(f => f.type !== 'turn_activity');
  assert.equal(frames.length, 3);
  assert.equal(frames[2].type, 'turn_end');
  assert.equal(frames[2].reply, 'Hello world');
  assert.equal(frames[2].ok, true);
  assert.equal(res.write, origWrite, 'wrapper removed after finish');
});

test('a failed turn ends with ok:false and the error text', () => {
  const hub = createHubEvents();
  const c = fakeClient();
  hub.subscribe(c.req, c.res);
  const tap = hub.tapTurn({ write: () => true }, { agent: 'x', origin: { kind: 'consultation', from: 'maestro' }, message: 'hi' });
  tap.finish(false, 'boom');
  const end = parseFrames(c.out).find(f => f.type === 'turn_end');
  assert.equal(end.ok, false);
  assert.equal(end.error, 'boom');
  assert.equal(end.reply, '');
});

test('wiring: chat handler taps hub-initiated turns and every hub caller tags its origin', () => {
  const chat = read('lib/sdk-chat.js');
  assert.match(chat, /const hubEvents = require\('\.\/hub-events'\)/);
  assert.match(chat, /consulted_by, origin, turn_link(, owner_turn)?(, voice)? \} = body;/);
  assert.match(chat, /hubEvents\.events\.tapTurn\(res, \{ agent, origin: turnOrigin, message, turnId, startedAt, images: uploadedPaths \}\)/);
  assert.match(chat, /tap\.finish\(!turnError && !stopped, turnError \? turnError\.message : stopped \? 'stopped' : null\)/);
  // member origin (test/member-origin.test.js): what a member's turn starts carries member
  assert.match(chat, /origin: \{ kind: opts\.temporal \? 'task' : 'consultation', from: coordinatorName \|\| null, \.\.\.\(consultMember \? \{ member: true \} : \{\}\) \}/);
  assert.match(chat, /function wakeAgent\(agentName, message, onReply, meta = null\)/);
  // hand-offs (lib/hand-offs): a wake-up in a hand-off runs at consult depth; the hand-off's own turns add body fields
  assert.match(chat, /handleChatStream\(\{ agent: agentName, message, origin, exclude_tools: meta\?\.exclude_tools, \.\.\.\(handOff \? \{ consultation_depth: 1 \} : \{\}\) \}, sink\)/);
  // startHubTurn also hands on an optional trusted context (Build Team: ctx.buildTeam, set only by lib/sdk-chat startBuildTeam; test/build-team-turn.test.js)
  assert.match(chat, /handleChatStream\(\{ agent: agentName, message, origin, \.\.\.\(extraBody \|\| \{\}\) \}, sink, ctx\)/);
  const jobs = read('lib/jobs.js');
  assert.match(jobs, /kind: p\.kind === 'report' \? 'job_report' : 'job_notice'/);
  const sched = read('lib/scheduler.js');
  assert.match(sched, /origin: \{ kind: 'schedule', from: taskId, by: 'TASKS\.md' \}/);   // names who started it (R6)
  const server = read('server.js');
  assert.match(server, /pathname === '\/api\/events' && req\.method === 'GET'/);
  assert.match(server, /require\('\.\/lib\/hub-events'\)\.events\.subscribe\(req, res\)/);
});

test('wiring: UI subscribes, opens one window per agent, and lands hub turns in it', () => {
  const app = read('app.js');
  assert.match(app, /new EventSource\('\/api\/events'/);
  assert.match(app, /startHubEventMonitor\(\);/);
  assert.match(app, /if \(existing\) \{ if \(!background\) switchToChat\(existing\.id\); return existing\.id; \}/);
  assert.match(app, /chats\[chatId\]\.historyLoaded = soloHistoryLoad\(chatId\)/);
  assert.match(app, /HUB_AUTO_OPEN = new Set\(\['job_notice', 'job_report', 'schedule'\]\)/);
  assert.match(app, /startSoloChat\(ev\.agent, [^)]*\{ background: true \}\)/, 'a job or scheduled turn opens its window in the background');
  assert.doesNotMatch(app, /kind === 'job_report'\) switchToChat/, 'a job report no longer takes the screen');
  assert.match(app, /classList\.remove\('unread'\)/);
  assert.match(read('index.html'), /\.chat-tab\.unread \.name::after/);
});
