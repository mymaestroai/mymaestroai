'use strict';
// The shared dot helper (lib/ui-agent-dot.js) and its web name.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../lib/ui-agent-dot');
const staticFiles = require('../lib/static-files');

test('dotState: question beats busy beats background beats free', () => {
  assert.equal(D.dotState({ busy: true, question: true, background: 3 }), 'question');
  assert.equal(D.dotState({ busy: true, question: false, background: 3 }), 'busy');
  assert.equal(D.dotState({ busy: false, question: false, background: 2 }), 'background');
  assert.equal(D.dotState({ busy: false, question: false, background: 0 }), 'free');
  assert.equal(D.dotState({}), 'free');
  assert.equal(D.dotState({ background: undefined }), 'free');
  assert.equal(D.dotState({ background: -1 }), 'free');
  assert.equal(D.dotState({ background: '2' }), 'background');
  assert.equal(D.dotState(), 'free');
});

test('dotLabel and bgLine: the exact words', () => {
  assert.equal(D.dotLabel('busy', { name: 'Hazel' }), 'Replying');
  assert.equal(D.dotLabel('question', {}), 'Waiting for your answer');
  assert.equal(D.dotLabel('free', {}), 'Free to talk');
  assert.equal(D.dotLabel('background', { background: 1 }), 'Free to talk · 1 thing running in the background');
  assert.equal(D.dotLabel('background', { background: 2 }), 'Free to talk · 2 things running in the background');
  assert.equal(D.bgLine(1), 'Free · 1 thing in the background');
  assert.equal(D.bgLine(5), 'Free · 5 things in the background');
});

test('applyDot: sets bg-work, title and aria-label for background; removes bg-work otherwise; leaves other classes alone', () => {
  const mk = (cls) => {
    const e = { className: cls, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; },
      classList: { add: (c) => { if (!e.className.split(' ').includes(c)) e.className = (e.className + ' ' + c).trim(); }, remove: (c) => { e.className = e.className.split(' ').filter((x) => x && x !== c).join(' '); } } };
    return e;
  };
  assert.deepEqual(D.CLASS, { background: 'bg-work' });
  const el = mk('dot idle');
  D.applyDot(el, 'background', { background: 2, name: 'Hazel' });
  assert.equal(el.className, 'dot idle bg-work');
  assert.equal(el.attrs.title, 'Free to talk · 2 things running in the background');
  assert.equal(el.attrs['aria-label'], 'Free to talk · 2 things running in the background');
  D.applyDot(el, 'busy', { background: 2 });
  assert.equal(el.className, 'dot idle', 'bg-work removed, the other classes untouched');
  D.applyDot(el, 'free', {});
  assert.equal(el.className, 'dot idle');
  D.applyDot(null, 'background', {});   // no element: nothing happens
});

test('headerCount: no background leaves today\'s text; both joined; background alone', () => {
  assert.deepEqual(D.headerCount({ working: '2 agents working', background: 0 }), { text: '2 agents working', busyPart: '2 agents working', bgPart: '' });
  assert.deepEqual(D.headerCount({ working: '1 agent · 6 workers working', workers: 6 }), { text: '1 agent · 6 workers working', busyPart: '1 agent · 6 workers working', bgPart: '' });
  assert.deepEqual(D.headerCount({ working: '', background: 0 }), { text: '', busyPart: '', bgPart: '' });
  assert.deepEqual(D.headerCount({ working: '2 agents working', background: 1 }), { text: '2 agents working · 1 with background work', busyPart: '2 agents working', bgPart: '1 with background work' });
  assert.equal(D.headerCount({ working: '1 agent working', background: 3 }).text, '1 agent working · 3 with background work');
  assert.deepEqual(D.headerCount({ working: '', background: 2 }), { text: '2 with background work', busyPart: '', bgPart: '2 with background work' });
});

test('phoneChip: names, then "background work"; empty when none', () => {
  assert.equal(D.phoneChip(['Hazel', 'Forge']), 'Hazel, Forge: background work');
  assert.equal(D.phoneChip(['Hazel']), 'Hazel: background work');
  assert.equal(D.phoneChip([]), '');
  assert.equal(D.phoneChip(null), '');
});

test('the file loads without a DOM and is served as /ui-agent-dot.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ui-agent-dot.js'), 'utf8');
  assert.match(src, /root\.AgentDot = api/);
  assert.ok(!src.includes(String.fromCharCode(0xFE0F)));
  const real = staticFiles.resolve('/ui-agent-dot.js');
  assert.equal(real, fs.realpathSync(path.join(__dirname, '..', 'lib', 'ui-agent-dot.js')));
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'lib', 'static-files.js'), 'utf8').includes("['ui-agent-dot.js', 'lib/ui-agent-dot.js']"));
});
