'use strict';
// The owner's wording (11-20): while an agent works on a hand-off, the status says "Working on a task", and a report
// turn says "Reading a task report". The hand-off line above the message box ("Hand-offs: 1 running"), the hand_off
// tool, ids, API fields and event names keep their names.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const V = require('../lib/ui-chat-view');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const nameOf = (n) => ({ 'peer-a': 'Peer A', lead: 'Lead' }[n] || '');

test('a hand-off turn reads "Working on a task" in the status words', () => {
  assert.strictEqual(V.chatViewBusyText({ kind: 'hand_off', from: 'peer-a', label: 'Hand-off from peer-a: tidy the parts list' }, null, nameOf), 'Working on a task from Peer A');
  assert.strictEqual(V.chatViewBusyText({ kind: 'hand_off', from: 'peer-a' }, null, nameOf), 'Working on a task from Peer A');
  assert.strictEqual(V.chatViewBusyText({ kind: 'hand_off' }), 'Working on a task');
  assert.strictEqual(V.chatViewBusyText({ kind: 'hand_off', label: 'something else' }), 'Working on a task');
});

test('a hand-off report turn reads "Reading a task report"', () => {
  assert.strictEqual(V.chatViewBusyText({ kind: 'hand_off', from: 'lead', label: 'Hand-off done: tidy the parts list' }, null, nameOf), 'Reading a task report from Lead');
  assert.strictEqual(V.chatViewBusyText({ kind: 'hand_off', label: 'Hand-off failed: x' }), 'Reading a task report');
  assert.strictEqual(V.chatViewBusyText({ kind: 'hand_off_report', from: 'lead' }, null, nameOf), 'Reading a task report from Lead');
  assert.strictEqual(V.chatViewBusyText({ kind: 'hand_off_report' }), 'Reading a task report');
});

test('the status feed words (the hub\'s and the pages\' own) read as tasks', () => {
  const cases = [
    ['hand-off', 'Working on a task'], ['Hand-off', 'Working on a task'], ['hand-off finished', 'Reading a task report'],
    ['task from peer-a', 'Working on a task from Peer A'], ['task finished: lead', 'Reading a task report from Lead'],
    ['task', 'Working on a task'], ['task finished', 'Reading a task report'],
  ];
  for (const [a, want] of cases) assert.strictEqual(V.chatViewBusyText(null, a, nameOf), want, a);
  // other words keep their meaning
  assert.strictEqual(V.chatViewBusyText(null, 'scheduled task: Nightly'), 'Working on a scheduled task: Nightly');
  assert.strictEqual(V.chatViewBusyText(null, 'consulted by peer-a', nameOf), 'Answering a consultation from Peer A');
  assert.strictEqual(V.chatViewBusyText(null, 'working'), 'Working on a hub task');
});

test('chatViewActivityWord: the short word shown for a hand-off is "task" / "task finished"; others pass through', () => {
  assert.strictEqual(V.chatViewActivityWord('hand-off'), 'task');
  assert.strictEqual(V.chatViewActivityWord('hand-off finished'), 'task finished');
  assert.strictEqual(V.chatViewActivityWord('hand-off from peer-a'), 'task from peer-a');
  assert.strictEqual(V.chatViewActivityWord('hand-off finished: lead'), 'task finished: lead');
  assert.strictEqual(V.chatViewActivityWord('consulted by peer-a'), 'consulted by peer-a');
  assert.strictEqual(V.chatViewActivityWord('scheduled task: Nightly'), 'scheduled task: Nightly');
  assert.strictEqual(V.chatViewActivityWord(null), '');
  assert.strictEqual(V.chatViewActivityWord(undefined), '');
});

test('no status line can say "hand-off": every origin and every hub word', () => {
  const kinds = ['user', 'comms', 'consultation', 'schedule', 'job_notice', 'hand_off', 'hand_off_report', 'job_report', 'consult_reply', 'alert', 'task', 'other'];
  const labels = [undefined, '', 'Hand-off from peer-a: x', 'Hand-off done: x', 'Hand-off waiting: x'];
  for (const kind of kinds) for (const label of (kind === 'hand_off' ? labels : [undefined])) for (const from of [undefined, 'peer-a']) {
    const t = V.chatViewBusyText({ kind, label, from }, null, nameOf);
    assert.ok(!/hand-off/i.test(t), `${kind} ${label} ${from}: ${t}`);
  }
  for (const a of ['hand-off', 'hand-off finished', 'Hand-off', 'task from peer-a', 'task finished: lead']) {
    assert.ok(!/hand-off/i.test(V.chatViewBusyText(null, a, nameOf)), a);
    assert.ok(!/hand-off/i.test(V.chatViewActivityWord(a)), a);
  }
});

test('the pages carry the new wording and show the status word through chatViewActivityWord', () => {
  for (const f of ['lib/ui-chat-view.js', 'app.js', 'mobile.js']) {
    const src = read(f);
    for (const old of ['Working on a hand-off', 'Reading a hand-off report']) assert.ok(!src.includes(old), `${f} still says "${old}"`);
    assert.ok(src.includes('function chatViewActivityWord(activity)'), f);
  }
  for (const f of ['app.js', 'mobile.js']) {
    const src = read(f);
    assert.ok(!src.includes('return `hand-off from ${'), `${f}: origin label`);
    assert.ok(!src.includes('return `hand-off finished: ${'), `${f}: origin label`);
    assert.ok(src.includes("case 'hand_off': return `task from ${origin.from || 'another agent'}`;"), f);
    assert.ok(src.includes("case 'hand_off_report': return `task finished: ${origin.from || 'another agent'}`;"), f);
  }
  const app = read('app.js'), mob = read('mobile.js');
  assert.ok(app.includes("turnStatusText(ra) || chatViewActivityWord(live?.activity) || 'still working'"), 'desktop reattach line');
  assert.ok(app.includes("previous message (${chatViewActivityWord(live.activity) || 'working'}"), 'desktop still-working notice');
  assert.ok(mob.includes("(s && chatViewActivityWord(s.activity)) || 'working'"), 'phone reattach line');
  assert.ok(mob.includes("previous message (${chatViewActivityWord(s.activity) || 'working'}"), 'phone still-working notice');
});

test('the line above the message box and its cards say task: "Tasks: 1 running", "Task for <agent>"', () => {
  const H = require('../lib/ui-hand-off-card');
  const NOW = Date.parse('2026-11-20T12:00:00Z');
  assert.strictEqual(H.summaryLine([{ id: '1', state: 'running', createdAt: NOW - 60000 }, { id: '2', state: 'done', createdAt: NOW - 60000, endedAt: NOW - 1000 }], { now: NOW }), 'Tasks: 1 running · 1 done');
  assert.strictEqual(H.cardModel({ target: 'scout', topic: 'Find prices', state: 'running' }, { now: NOW }).title, 'Task for scout');
  const src = read('lib/ui-hand-off-card.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/'[^'\n]*Hand-offs?\b[^'\n]*'|'Handed off/.test(src), 'no visible hand-off wording left in the strip or its Status sheet');
});

test('the agent list tooltip, a worker row and the chat history labels show "task" too', () => {
  const app = read('app.js'), mob = read('mobile.js');
  assert.ok(app.includes("const activity = chatViewActivityWord(s && s.activity) || (mine ? 'replying to you' : 'working');"), 'desktop status dot tooltip');
  assert.ok(mob.includes("const activity = chatViewActivityWord(s.activity) || 'working';"), 'phone worker row');
  const A = require('../lib/ui-auto-turns');
  const info = (o) => A.autoInfoOf({ role: 'user', origin: o }).label;
  assert.strictEqual(info({ kind: 'hand_off', from: 'lead', label: 'Hand-off from lead: tidy' }), 'Task from lead: tidy');
  assert.strictEqual(info({ kind: 'hand_off_report', from: 'scout', label: 'Hand-off done: tidy' }), 'Task done: tidy');
  assert.strictEqual(info({ kind: 'hand_off', from: 'lead' }), 'Task from lead');
  assert.strictEqual(info({ kind: 'hand_off_report' }), 'Task finished');
});

test('a running hand_off step reads "handing over a task"', () => {
  assert.match(V.chatViewStep({ kind: 'tool', tool: 'hand_off', status: 'running' }) || '', /^handing over a task/);
});

test('the tool, ids, API fields and the hub\'s own words keep their names', () => {
  assert.ok(read('lib/hub-events.js').includes("case 'hand_off': return 'hand-off';"), 'the hub\'s status word is unchanged (the pages show it as "task")');
  assert.ok(read('lib/ui-hand-off-card.js').includes("'/api/agents/' + encodeURIComponent(agent) + '/working-on'"), 'the API path');
});
