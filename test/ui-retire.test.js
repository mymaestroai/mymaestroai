'use strict';
// Lines that have done their job leave the chat a few seconds later (2026-10-28): an answered question's "❓" line
// (desktop) or box (phone), and a finished worker's "✅ … is Complete" line (desktop). In a long reply they sat under
// the reply and piled up, pushing the reply itself up the screen. A failed or stopped worker's line stays.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { retireSoon, RETIRE_AFTER_MS, RETIRE_FOLD_MS } = require('../lib/ui-retire');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const BEGIN = '// ── retire helpers (begin) ──';
const END = '// ── retire helpers (end) ──';
function helperBlock(src, indent) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  assert.ok(a > 0 && b > a, 'helper markers present');
  return src.slice(a + BEGIN.length, b).split('\n').map(l => (indent && l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n').trim();
}
function block(src, from, to) {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `${from} not found`);
  const b = src.indexOf(to, a + from.length);
  assert.ok(b > a, `${to} not found after ${from}`);
  return src.slice(a, b);
}
function element() {
  const el = { dataset: {}, style: {}, isConnected: true, offsetHeight: 38, classes: [], removed: false };
  el.classList = { add: (c) => el.classes.push(c) };
  el.remove = () => { el.removed = true; el.isConnected = false; };
  return el;
}

test('the retire helpers are byte-identical in lib/ui-retire.js, app.js and mobile.js', () => {
  const lib = helperBlock(read('lib/ui-retire.js'), '');
  assert.strictEqual(helperBlock(read('app.js'), '    '), lib, 'app.js copy differs from lib/ui-retire.js');
  assert.strictEqual(helperBlock(read('mobile.js'), ''), lib, 'mobile.js copy differs from lib/ui-retire.js');
});

test('retireSoon: a few seconds, then it folds away and is removed; once per element', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.strictEqual(RETIRE_AFTER_MS, 4000);
  const el = element();
  assert.strictEqual(retireSoon(el), true);
  assert.strictEqual(retireSoon(el), false, 'a second call does not schedule it again');
  t.mock.timers.tick(RETIRE_AFTER_MS - 1);
  assert.deepStrictEqual(el.classes, [], 'still there just before');
  t.mock.timers.tick(1);
  assert.deepStrictEqual(el.classes, ['retiring']);
  assert.strictEqual(el.style.maxHeight, '38px', 'folds from its own height');
  assert.strictEqual(el.removed, false);
  t.mock.timers.tick(RETIRE_FOLD_MS);
  assert.strictEqual(el.removed, true);
});

test('retireSoon: an element gone from the page by then is left alone; nothing to retire is fine', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const el = element();
  retireSoon(el, 1000);
  el.isConnected = false;                 // the chat was redrawn or closed meanwhile
  t.mock.timers.tick(5000);
  assert.deepStrictEqual(el.classes, []);
  assert.strictEqual(el.removed, false);
  assert.strictEqual(el.dataset.retiring, undefined, 'it can be scheduled again if it comes back');
  el.isConnected = true;
  assert.strictEqual(retireSoon(el, 1000), true);
  t.mock.timers.tick(1000);
  t.mock.timers.tick(RETIRE_FOLD_MS);   // the fold's own timer is set when the first one fires
  assert.strictEqual(el.removed, true);
  assert.strictEqual(retireSoon(null), false);
  assert.strictEqual(retireSoon(undefined), false);
});

test('desktop: a question\'s "❓" lines leave once the hub confirms the answer, or closes the question', () => {
  const app = read('app.js');
  assert.ok(app.includes("if (chatId) questionNotices.set(request_id, questions.map(q => appendSystemNotice(chatId, '❓ ' + q.question)).filter(Boolean));"));
  assert.match(block(app, 'function retireQuestionNotices(requestId) {', '\n    }'), /for \(const n of questionNotices\.get\(requestId\) \|\| \[\]\) retireSoon\(n\);\s*questionNotices\.delete\(requestId\);/);
  assert.match(block(app, 'function closeQuestion(requestId) {', '\n    }'), /retireQuestionNotices\(requestId\);/, 'closed by the hub (answered elsewhere, no answer in time)');
  const submit = block(app, 'function submitAnswers(answers) {', '\n        }');
  assert.ok(submit.includes('}).then(r => { if (r.ok) retireQuestionNotices(request_id); })'), 'answered here: only once the hub took the answer');
  assert.strictEqual(submit.split('retireQuestionNotices').length - 1, 1, 'and nowhere else in the submit (a failed send keeps the line)');
});

test('desktop: a finished worker\'s line leaves; a failed or stopped one stays', () => {
  const app = read('app.js');
  const done = block(app, "if (oc.type === 'worker_completed') {", '// ── Tiger Team Events ──');
  assert.match(done, /run\.noticeEl\.className = 'system-notice notice-complete';\s*retireSoon\(run\.noticeEl\);/);
  assert.ok(done.includes("retireSoon(appendSystemNotice(chatId, `${doneIcon} ${label} is Complete`, 'complete'));"));
  assert.doesNotMatch(block(app, "if (oc.type === 'worker_failed') {", 'return false;\n    }'), /retireSoon/);
  assert.doesNotMatch(block(app, 'function markWorkerRunCancelled(chat, run) {', '\n    }'), /retireSoon/);
});

test('phone: an answered or closed question box leaves', () => {
  const m = read('mobile.js');
  // the phone's own closeQuestion, run against a stand-in box: what it says, and that it leaves
  const close = block(m, 'function closeQuestion(requestId, how) {', '\n}') + '\n}';
  const run = (html, how) => {
    const box = { innerHTML: html, querySelector: (sel) => (sel === '.done' && box.innerHTML.includes('class="done"') ? {} : null) };
    const boxes = new Map([['q', box]]); const retired = [];
    new Function('questionBoxes', 'retireSoon', `${close}; return closeQuestion;`)(boxes, (b) => retired.push(b))('q', how);
    return { text: box.innerHTML.replace(/<[^>]+>/g, ''), gone: !boxes.has('q') && retired[0] === box };
  };
  const sent = '<div class="done">Answered: Yes</div>', open = '<div class="qt">Go on?</div>';
  assert.deepStrictEqual(run(sent, 'answered'), { text: 'Answered: Yes', gone: true }, 'sent from here and confirmed: keeps its text');
  assert.deepStrictEqual(run(sent, 'no_answer'), { text: 'No answer in time; the agent carried on', gone: true }, 'the send failed and it timed out: the hub\'s outcome');
  assert.deepStrictEqual(run(sent, 'skipped'), { text: 'Skipped', gone: true });
  assert.deepStrictEqual(run(open, 'answered'), { text: 'Answered elsewhere', gone: true });
  assert.deepStrictEqual(run(open, 'no_answer'), { text: 'No answer in time; the agent carried on', gone: true });
  const show = block(m, 'function showQuestion(data, onAnswered) {', 'const selected = {};');
  assert.ok(show.includes('}).then(r => { if (r.ok) { questionBoxes.delete(request_id); retireSoon(box); } })'), 'answered here: only once the hub took the answer');
  assert.strictEqual(show.split('questionBoxes.delete(').length - 1, 1, 'kept in questionBoxes until then, so the hub\'s close still finds it after a failed send');
  assert.strictEqual(show.split('retireSoon').length - 1, 1, 'and nowhere else (a failed send keeps the box)');
});

test('both pages fold a retiring line away (and skip the motion when asked to)', () => {
  for (const page of ['index.html', 'mobile.html']) {
    const css = read(page);
    assert.match(css, /\.retiring \{[^}]*opacity: 0;[^}]*max-height: 0 !important;[^}]*transition: [^}]*\}/, page);
    assert.ok(css.includes('@media (prefers-reduced-motion: reduce) { .retiring { transition: none; } }'), page);
  }
});
