'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  AUTO_STACK_MIN, autoKindOfOrigin, autoInfoOf, autoFirstLine, autoGroupHistory, autoCardKind, autoSummaryOf,
} = require('../lib/ui-auto-turns.js');

const u = (content, extra = {}) => ({ role: 'user', content, ts: '2026-11-11T10:00:00Z', ...extra });
const a = (content, extra = {}) => ({ role: 'assistant', content, ts: '2026-11-11T10:01:00Z', ...extra });
const consult = (n = 'lead') => u(`[Consultation from agent "${n}"]\n\nPlease check`);

test('markers and constant', () => {
  const src = fs.readFileSync(path.join(__dirname, '../lib/ui-auto-turns.js'), 'utf8');
  assert.ok(src.includes('// ── auto-turn helpers (begin) ──'));
  assert.ok(src.includes('// ── auto-turn helpers (end) ──'));
  const body = src.split('// ── auto-turn helpers (begin) ──')[1].split('// ── auto-turn helpers (end) ──')[0];
  assert.ok(!/require\(/.test(body));
  assert.equal(AUTO_STACK_MIN, 3);
});

test('autoKindOfOrigin maps each kind', () => {
  assert.equal(autoKindOfOrigin({ kind: 'consultation' }), 'consultation');
  assert.equal(autoKindOfOrigin({ kind: 'schedule' }), 'schedule');
  for (const k of ['job_notice', 'job_report', 'task', 'consult_reply', 'alert', 'whatever']) assert.equal(autoKindOfOrigin({ kind: k }), 'notice');
  for (const o of [{ kind: 'user' }, { kind: 'comms' }, {}, null, undefined, { kind: '' }]) assert.equal(autoKindOfOrigin(o), null);
});

test('autoCardKind', () => {
  assert.equal(autoCardKind('consultation'), 'consult');
  assert.equal(autoCardKind('schedule'), 'schedule');
  assert.equal(autoCardKind('notice'), 'notice');
});

test('origin labels', () => {
  assert.deepEqual(autoInfoOf(u('x', { origin: { kind: 'consultation', from: 'lead' } })), { kind: 'consultation', from: 'lead', label: 'Consultation from lead' });
  assert.equal(autoInfoOf(u('x', { origin: { kind: 'consultation' } })).label, 'Consultation from another agent');
  assert.deepEqual(autoInfoOf(u('x', { origin: { kind: 'schedule', from: 'Daily review' } })), { kind: 'schedule', from: 'Daily review', label: 'Scheduled task: Daily review' });
  assert.equal(autoInfoOf(u('x', { origin: { kind: 'schedule' } })).label, 'Scheduled task');
  assert.equal(autoInfoOf(u('x', { origin: { kind: 'job_notice', jobName: 'suite 1' } })).label, 'Job finished: suite 1');
  assert.equal(autoInfoOf(u('x', { origin: { kind: 'job_notice' } })).label, 'Job finished');
  assert.equal(autoInfoOf(u('x', { origin: { kind: 'job_report', jobName: 'nightly' } })).label, 'Job report: nightly');
  assert.equal(autoInfoOf(u('x', { origin: { kind: 'job_report' } })).label, 'Job report');
  assert.equal(autoInfoOf(u('x', { origin: { kind: 'task', label: 'context compression' } })).label, 'Resumed after compression');
  assert.equal(autoInfoOf(u('x', { origin: { kind: 'task', label: 'cleanup' } })).label, 'Hub task: cleanup');
  assert.equal(autoInfoOf(u('x', { origin: { kind: 'task' } })).label, 'Hub task');
  assert.equal(autoInfoOf(u('x', { origin: { kind: 'consult_reply' } })).label, 'Consultation replies delivered');
  assert.equal(autoInfoOf(u('x', { origin: { kind: 'alert' } })).label, 'Monitor alert');
  assert.equal(autoInfoOf(u('x', { origin: { kind: 'mystery' } })).label, 'Hub turn');
  assert.equal(autoInfoOf(u('x', { origin: { kind: 'mystery' } })).kind, 'notice');
});

test('origin wins over content; null origin kind is owner', () => {
  assert.equal(autoInfoOf(u('[Consultation from agent "lead"] hi', { origin: { kind: 'comms' } })), null);
  assert.equal(autoInfoOf(u('[Consultation from agent "lead"] hi', { origin: { kind: 'user' } })), null);
});

test('content prefixes without origin', () => {
  assert.deepEqual(autoInfoOf(consult()), { kind: 'consultation', from: 'lead', label: 'Consultation from lead' });
  assert.deepEqual(autoInfoOf(u('  \n[Consultation from agent "sam"] hi')), { kind: 'consultation', from: 'sam', label: 'Consultation from sam' });
  assert.deepEqual(autoInfoOf(u('team question', { tiger_team: true })), { kind: 'consultation', from: null, label: 'Consultation from another agent' });
  const sched = u('[Scheduled task — started by the hub scheduler, NOT a message typed by the owner] "Daily review" (id st-1), set by agent "lead" on 2026-11-10');
  assert.deepEqual(autoInfoOf(sched), { kind: 'schedule', from: 'Daily review', label: 'Scheduled task: Daily review' });
  const sched2 = u('[Scheduled task — started by the hub scheduler from TASKS.md, NOT typed by the owner] "Weekly sweep" (id t-2)');
  assert.equal(autoInfoOf(sched2).from, 'Weekly sweep');
  assert.equal(autoInfoOf(u('[Scheduled task — started by the hub scheduler] no label here')).from, null);
  assert.equal(autoInfoOf(u('[Scheduled task — started by the hub scheduler] no label here')).label, 'Scheduled task');
  const fin = autoInfoOf(u('[Job finished] Job "suite 1" (id ab12), which you started ...'));
  assert.deepEqual(fin, { kind: 'notice', from: 'suite 1', label: 'Job finished: suite 1' });
  assert.equal(autoInfoOf(u('[Job ended] Job "suite 2" (id cd34) stopped')).label, 'Job ended: suite 2');
  assert.equal(autoInfoOf(u('[Job finished] done')).label, 'Job finished');
  const res = autoInfoOf(u('[Resumed after compression, from the hub] Your previous session ...'));
  assert.deepEqual(res, { kind: 'notice', from: null, label: 'Resumed after compression' });
  assert.equal(autoInfoOf(u('[Delivery turn started by the hub: replies ...]')).label, 'Consultation replies delivered');
  const q = autoInfoOf(u('[Queued consultation reply from agent "helper" (ok)]: result'));
  assert.deepEqual(q, { kind: 'notice', from: 'helper', label: 'Consultation replies delivered' });
});

test('owner messages are not automatic', () => {
  assert.equal(autoInfoOf(u('hello there')), null);
  assert.equal(autoInfoOf(u('[Owner (delivered mid-session)]: change it')), null);
  assert.equal(autoInfoOf(u('')), null);
  assert.equal(autoInfoOf(u(undefined)), null);
  assert.equal(autoInfoOf(a('[Consultation from agent "lead"] x')), null);
  assert.equal(autoInfoOf(u('[Consultation from agent "lead"] x', { ask: true })), null);
  assert.equal(autoInfoOf(null), null);
});

test('autoFirstLine', () => {
  assert.equal(autoFirstLine('\n\n  ## Heading here\nmore'), 'Heading here');
  assert.equal(autoFirstLine('- item one\n- two'), 'item one');
  assert.equal(autoFirstLine('> quoted  text'), 'quoted text');
  assert.equal(autoFirstLine('* **Bold** point'), 'Bold point');
  assert.equal(autoFirstLine('**All bold**'), 'All bold');
  assert.equal(autoFirstLine('---\nreal'), 'real');
  assert.equal(autoFirstLine('a   b \t c'), 'a b c');
  assert.equal(autoFirstLine(''), '');
  assert.equal(autoFirstLine(null), '');
  const cut = autoFirstLine('x'.repeat(200));
  assert.equal(cut.length, 140);
  assert.ok(cut.endsWith('…'));
  assert.equal(autoFirstLine('abcdefghij', 5), 'abcd…');
  assert.equal(autoFirstLine('abcde', 5), 'abcde');
});

test('owner exchange, consultation card, owner exchange stay entries around a card', () => {
  const h = [u('hi'), a('hello'), consult(), a('## Checked it\nall fine'), u('thanks'), a('welcome')];
  const items = autoGroupHistory(h);
  assert.equal(items.length, 5);
  assert.deepEqual(items[0], { type: 'entry', index: 0 });
  assert.deepEqual(items[1], { type: 'entry', index: 1 });
  assert.equal(items[2].type, 'card');
  assert.equal(items[2].kind, 'consultation');
  assert.equal(items[2].from, 'lead');
  assert.equal(items[2].label, 'Consultation from lead');
  assert.deepEqual(items[2].indexes, [2, 3]);
  assert.deepEqual(items[2].open, []);
  assert.equal(items[2].firstLine, 'Checked it');
  assert.equal(items[2].ts, h[2].ts);
  assert.deepEqual(items[3], { type: 'entry', index: 4 });
  assert.deepEqual(items[4], { type: 'entry', index: 5 });
});

test('queued replies + delivery note + reply form one card', () => {
  const h = [
    u('[Queued consultation reply from agent "helper" (ok)]: result', { ts: 't1' }),
    u('[Queued consultation reply from agent "sam" (ok)]: other', { ts: 't2' }),
    u('[Delivery turn started by the hub: replies ...]', { ts: 't3' }),
    a('Both agents answered.'),
  ];
  const items = autoGroupHistory(h);
  assert.equal(items.length, 1);
  const c = items[0];
  assert.equal(c.type, 'card');
  assert.deepEqual(c.indexes, [0, 1, 2, 3]);
  assert.equal(c.label, 'Consultation replies delivered');
  assert.equal(c.from, null);
  assert.equal(c.ts, 't1');
  assert.equal(c.firstLine, 'Both agents answered.');
});

test('automatic user entry after an assistant entry starts the next card', () => {
  const h = [consult('lead'), a('one'), consult('sam'), a('two')];
  const items = autoGroupHistory(h);
  assert.equal(items.length, 2);
  assert.equal(items[0].from, 'lead');
  assert.equal(items[1].from, 'sam');
  assert.deepEqual(items[1].indexes, [2, 3]);
});

test('firstLine: prefers non-owner reply, falls back to prompt without tag', () => {
  const h = [u('[Scheduled task — started by the hub scheduler] "Daily review" (id st-1)'), a('Needs you', { for_owner: true }), a('Summary line'), a('Late owner note', { for_owner: true })];
  const c = autoGroupHistory(h)[0];
  assert.equal(c.firstLine, 'Summary line');
  // a reply shown open below its card is not repeated in the card: the line comes from the prompt (its Task: text when there is one)
  const only = autoGroupHistory([h[0], a('Only owner', { for_owner: true })])[0];
  assert.equal(only.firstLine, '"Daily review" (id st-1)');
  const withTask = autoGroupHistory([u('[Scheduled task — started by the hub scheduler, NOT a message typed by the owner] "Order check" (id st-2), set by agent "sam".\n\nTask:\nCheck whether the order shipped.'), a('It has not shipped.', { for_owner: true })])[0];
  assert.equal(withTask.firstLine, 'Check whether the order shipped.');
  const noReply = autoGroupHistory([consult()])[0];
  assert.equal(noReply.firstLine, 'Please check');
});

test('scheduled card with for_owner reply lists it in open and is never stacked', () => {
  const sched = u('[Scheduled task — started by the hub scheduler] "Daily review" (id st-1)');
  const h = [consult(), a('a'), consult(), a('b'), consult(), a('b2'), sched, a('needs you', { for_owner: true }), consult(), a('c'), consult(), a('d'), consult(), a('e')];
  const items = autoGroupHistory(h);
  assert.deepEqual(items.map((x) => x.type), ['stack', 'card', 'stack']);
  assert.equal(items[0].cards.length, 3);
  assert.equal(items[1].kind, 'schedule');
  assert.deepEqual(items[1].open, [7]);
  assert.equal(items[2].cards.length, 3);
});

test('open card alone', () => {
  const sched = u('[Scheduled task — started by the hub scheduler] "Daily review" (id st-1)');
  const items = autoGroupHistory([sched, a('needs you', { for_owner: true })]);
  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'card');
  assert.deepEqual(items[0].open, [1]);
  assert.deepEqual(items[0].indexes, [0, 1]);
  assert.equal(items[0].kind, 'schedule');
});

test('3 consecutive cards stack with summary; 2 stay cards', () => {
  const sched = u('[Scheduled task — started by the hub scheduler] "Daily review" (id st-1)');
  const note = u('[Job finished] Job "suite 1" (id ab12)');
  const h = [consult('lead'), a('1'), consult('sam'), a('2'), sched, a('3'), note, a('4')];
  const items = autoGroupHistory(h);
  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'stack');
  assert.equal(items[0].cards.length, 4);
  assert.equal(items[0].summary, '4 automatic turns: 2 consultations, 1 scheduled task, 1 hub notice');
  const two = autoGroupHistory(h.slice(0, 4));
  assert.deepEqual(two.map((x) => x.type), ['card', 'card']);
  const three = autoGroupHistory([consult(), a('1'), consult(), a('2'), consult(), a('3')]);
  assert.equal(three.length, 1);
  assert.equal(three[0].summary, '3 automatic turns: 3 consultations');
  const custom = autoGroupHistory(h.slice(0, 4), 0, { stackMin: 2 });
  assert.equal(custom[0].type, 'stack');
});

test('an entry between cards breaks a run', () => {
  const h = [consult(), a('1'), consult(), a('2'), u('owner'), a('ok'), consult(), a('3'), consult(), a('4')];
  assert.deepEqual(autoGroupHistory(h).map((x) => x.type), ['card', 'card', 'entry', 'entry', 'card', 'card']);
});

test('autoSummaryOf singular and plural', () => {
  const k = (kind) => ({ kind });
  assert.equal(autoSummaryOf([k('notice'), k('notice'), k('schedule')]), '3 automatic turns: 1 scheduled task, 2 hub notices');
  assert.equal(autoSummaryOf([k('consultation')]), '1 automatic turn: 1 consultation');
});

test('an ask entry inside an automatic turn ends the card and shows as entries', () => {
  const h = [consult(), a('thinking'), a('which one?', { ask: true }), u('patient-a', { ask: true }), a('done')];
  const items = autoGroupHistory(h);
  assert.deepEqual(items.map((x) => x.type), ['card', 'entry', 'entry', 'entry']);
  assert.deepEqual(items[0].indexes, [0, 1]);
  assert.deepEqual(items.slice(1).map((x) => x.index), [2, 3, 4]);
});

test('inProgress entries are skipped entirely', () => {
  const h = [consult(), a('partial', { inProgress: true }), a('final')];
  const items = autoGroupHistory(h);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].indexes, [0, 2]);
  const tail = autoGroupHistory([u('hi'), a('running', { inProgress: true })]);
  assert.deepEqual(tail, [{ type: 'entry', index: 0 }]);
  const startsInProgress = autoGroupHistory([consult(), a('x'), u('sam msg', { inProgress: true })]);
  assert.equal(startsInProgress.length, 1);
});

test('from offset gives absolute indexes', () => {
  const h = [u('old'), a('old reply'), u('hi'), consult(), a('reply'), u('bye')];
  const items = autoGroupHistory(h, 2);
  assert.deepEqual(items[0], { type: 'entry', index: 2 });
  assert.deepEqual(items[1].indexes, [3, 4]);
  assert.deepEqual(items[2], { type: 'entry', index: 5 });
});

test('a card at the very end of history', () => {
  const items = autoGroupHistory([u('hi'), a('yo'), consult(), a('last reply')]);
  assert.equal(items.length, 3);
  assert.equal(items[2].type, 'card');
  assert.deepEqual(items[2].indexes, [2, 3]);
  const promptOnly = autoGroupHistory([u('hi'), consult()]);
  assert.equal(promptOnly[1].type, 'card');
  assert.deepEqual(promptOnly[1].indexes, [1]);
  assert.deepEqual(autoGroupHistory([]), []);
});
