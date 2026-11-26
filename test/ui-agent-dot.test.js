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
  // changed (the owner 2026-11-24 07:48: "Everything should alwasy be consistent."): one short line on every list; the full sentence stays in dotLabel
  assert.equal(D.bgLine(1), 'Free · 1 in background');
  assert.equal(D.bgLine(5), 'Free · 5 in background');
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

// ── review r1: labels are never left behind ──
function fakeEl(attrs = {}) {
  const a = { ...attrs }; let cls = '';
  return { attrs: a, setAttribute: (k, v) => { a[k] = String(v); }, getAttribute: (k) => (k in a ? a[k] : null), removeAttribute: (k) => { delete a[k]; },
    classList: { add: (c) => { cls = c; }, remove: (c) => { if (cls === c) cls = ''; }, has: (c) => cls === c } };
}

test('applyDot: background then busy restores the earlier title and removes the aria-label', () => {
  const el = fakeEl({ title: 'Hazel' });
  D.applyDot(el, 'background', { background: 2 });
  assert.equal(el.attrs.title, 'Free to talk · 2 things running in the background');
  assert.ok(el.classList.has('bg-work'));
  D.applyDot(el, 'busy', {});
  assert.equal(el.attrs.title, 'Hazel');
  assert.ok(!('aria-label' in el.attrs));
  assert.ok(!el.classList.has('bg-work'));
  assert.deepEqual(Object.keys(el.attrs), ['title'], 'the memory is cleared');
});

test('applyDot: background then free restores both earlier values, or removes them when there were none', () => {
  const el = fakeEl({ title: 'Old', 'aria-label': 'Old aria' });
  D.applyDot(el, 'background', { background: 1 });
  D.applyDot(el, 'background', { background: 3 });   // a second background call keeps the first memory
  D.applyDot(el, 'free', {});
  assert.deepEqual(el.attrs, { title: 'Old', 'aria-label': 'Old aria' });
  const bare = fakeEl();
  D.applyDot(bare, 'background', { background: 1 });
  D.applyDot(bare, 'free', {});
  assert.deepEqual(bare.attrs, {});
});

test('applyDot: a caller\'s newer title set while the state stays non-background is not overwritten', () => {
  const el = fakeEl({ title: 'Hazel' });
  D.applyDot(el, 'background', { background: 1 });
  D.applyDot(el, 'busy', {});
  el.setAttribute('title', 'Hazel · typing');
  D.applyDot(el, 'busy', {});
  D.applyDot(el, 'free', {});
  assert.equal(el.attrs.title, 'Hazel · typing');
});

test('r3 applyDot: a painter that resets only the title never leaves the background aria-label behind', () => {
  // the desktop row painter writes title on every paint but never aria-label
  const el = fakeEl({});
  D.applyDot(el, 'background', { background: 1 });   // ring + both labels
  el.setAttribute('title', 'Idle');                    // routine repaint: only the title
  D.applyDot(el, 'background', { background: 1 });   // ring again
  el.setAttribute('title', 'Waiting for your answer'); // the agent asks
  D.applyDot(el, 'question', {});
  assert.equal(el.attrs.title, 'Waiting for your answer');
  assert.ok(!('aria-label' in el.attrs), 'no background aria-label left: ' + el.attrs['aria-label']);
});

test('r2 applyDot: leaving background restores only its own label; a caller\'s newer title stays', () => {
  const el = fakeEl({ title: 'Hazel' });
  D.applyDot(el, 'background', { background: 1 });
  el.setAttribute('title', 'Waiting for your answer');   // the caller wrote its own text meanwhile
  D.applyDot(el, 'question', {});
  assert.equal(el.attrs.title, 'Waiting for your answer');
  assert.ok(!('data-bg-prev-title' in el.attrs) && !('data-bg-set-title' in el.attrs), 'the memory is cleared');
});
