'use strict';
// lib/ui-simple: Simple mode's shared helper (mode, theme, reasoning level, labels). Pure functions with fake doc/win/storage.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../lib/ui-simple');
const { resolve } = require('../lib/static-files');

function fakeDoc() {
  const set = new Set();
  return { set, documentElement: { classList: { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) } } };
}
function fakeWin(dark) {
  const mq = { matches: !!dark, listeners: new Set(),
    addEventListener(t, f) { if (t === 'change') this.listeners.add(f); },
    removeEventListener(t, f) { if (t === 'change') this.listeners.delete(f); } };
  return { mq, matchMedia: (q) => { mq.query = q; return mq; },
    flip(d) { mq.matches = d; for (const f of [...mq.listeners]) f({ matches: d }); } };
}
function fakeStorage(init) {
  const m = new Map(Object.entries(init || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, m };
}

test('modeOf: explicit value wins, else member -> simple and admin -> advanced', () => {
  assert.strictEqual(S.modeOf({ uiMode: 'advanced', role: 'member' }), 'advanced');
  assert.strictEqual(S.modeOf({ uiMode: 'simple', role: 'admin' }), 'simple');
  assert.strictEqual(S.modeOf({ role: 'member' }), 'simple');
  assert.strictEqual(S.modeOf({ role: 'admin' }), 'advanced');
  assert.strictEqual(S.modeOf({ uiMode: 'bogus', role: 'admin' }), 'advanced');
  assert.strictEqual(S.modeOf(null), 'simple');
});

test('themeOf: light and dark are fixed, auto follows the device', () => {
  assert.strictEqual(S.themeOf({ theme: 'light' }, true), 'light');
  assert.strictEqual(S.themeOf({ theme: 'dark' }, false), 'dark');
  assert.strictEqual(S.themeOf({ theme: 'auto' }, true), 'dark');
  assert.strictEqual(S.themeOf({ theme: 'auto' }, false), 'light');
  assert.strictEqual(S.themeOf({}, false), 'light');
  assert.strictEqual(S.themeOf(null, true), 'dark');
});

// Changed on purpose (one theme per account in both modes): the theme classes are set in Advanced too; only mm-simple is mode-specific.
test('apply: simple sets mm-simple, advanced clears it; the theme class is set in both', () => {
  const doc = fakeDoc(), win = fakeWin(false);
  S.apply({ uiMode: 'simple', theme: 'light' }, { doc, win });
  assert.deepStrictEqual([...doc.set].sort(), ['mm-light', 'mm-simple']);
  S.apply({ uiMode: 'advanced', theme: 'light' }, { doc, win });
  assert.deepStrictEqual([...doc.set], ['mm-light']);
  S.apply({ uiMode: 'simple', theme: 'dark' }, { doc, win });
  assert.deepStrictEqual([...doc.set].sort(), ['mm-dark', 'mm-simple']);
});

// Changed on purpose: Advanced now carries mm-light / mm-dark (exactly one); every mm-light rule is still prefixed html.mm-simple.
test('apply: advanced gets exactly one of mm-light / mm-dark and never mm-simple', () => {
  for (const [theme, dark, want] of [['light', false, 'mm-light'], ['dark', false, 'mm-dark'], ['auto', true, 'mm-dark'], ['auto', false, 'mm-light']]) {
    const doc = fakeDoc();
    S.apply({ uiMode: 'advanced', theme }, { doc, win: fakeWin(dark) });
    assert.deepStrictEqual([...doc.set], [want]);
  }
});

// Changed on purpose: the 'auto' listener keeps following the device in Advanced too (the theme is per account, not per mode).
test('apply: auto follows a matchMedia change in both modes', () => {
  const doc = fakeDoc(), win = fakeWin(true);
  S.apply({ uiMode: 'simple', theme: 'auto' }, { doc, win });
  assert.strictEqual(win.mq.query, '(prefers-color-scheme: dark)');
  assert.strictEqual(doc.set.has('mm-light'), false);
  win.flip(false);
  assert.strictEqual(doc.set.has('mm-light'), true);
  win.flip(true);
  assert.strictEqual(doc.set.has('mm-light'), false);
  S.apply({ uiMode: 'advanced', theme: 'auto' }, { doc, win });
  assert.strictEqual(win.mq.listeners.size, 1);
  assert.strictEqual(doc.set.has('mm-simple'), false);
  assert.strictEqual(doc.set.has('mm-dark'), true);
  win.flip(false);
  assert.deepStrictEqual([...doc.set], ['mm-light']);
  S.apply({ uiMode: 'advanced', theme: 'dark' }, { doc, win });
  assert.strictEqual(win.mq.listeners.size, 0);   // a fixed theme keeps no listener
});

test('apply: calling again replaces the previous listener; fixed themes keep none', () => {
  const doc = fakeDoc(), win = fakeWin(false);
  S.apply({ uiMode: 'simple', theme: 'auto' }, { doc, win });
  S.apply({ uiMode: 'simple', theme: 'auto' }, { doc, win });
  assert.strictEqual(win.mq.listeners.size, 1);
  S.apply({ uiMode: 'simple', theme: 'dark' }, { doc, win });
  assert.strictEqual(win.mq.listeners.size, 0);
  win.flip(false);
  assert.strictEqual(doc.set.has('mm-light'), false);
  S.apply({ uiMode: 'simple', theme: 'light' }, { doc, win });
  win.flip(true);
  assert.strictEqual(doc.set.has('mm-light'), true);
});

test('apply: a window without matchMedia does not throw (auto -> light)', () => {
  const doc = fakeDoc();
  S.apply({ uiMode: 'simple', theme: 'auto' }, { doc, win: {} });
  assert.deepStrictEqual([...doc.set].sort(), ['mm-light', 'mm-simple']);
});

test('EFFORTS: four plain-word levels with hints', () => {
  assert.deepStrictEqual(S.EFFORTS.map((e) => [e.id, e.level, e.label]), [
    ['quick', 'low', 'Quick'], ['balanced', 'medium', 'Balanced'], ['thorough', 'high', 'Thorough'], ['deepest', 'max', 'Deepest']]);
  assert.deepStrictEqual(S.EFFORTS.map((e) => e.hint), ['Fastest answers', 'Good for most questions', 'Takes more care', 'For the hardest questions']);
});

test('effort storage round trip, per agent, default medium', () => {
  const st = fakeStorage();
  assert.strictEqual(S.effortFor('agent-a', st), 'medium');
  assert.strictEqual(S.setEffort('agent-a', 'high', st), true);
  assert.strictEqual(S.effortFor('agent-a', st), 'high');
  assert.strictEqual(S.effortFor('agent-b', st), 'medium');
  assert.strictEqual(st.m.get('hub-simple-effort:agent-a'), 'high');
});

test('effort: an invalid stored value falls back to medium; an invalid level is not stored', () => {
  const st = fakeStorage({ 'hub-simple-effort:agent-a': 'turbo' });
  assert.strictEqual(S.effortFor('agent-a', st), 'medium');
  assert.strictEqual(S.setEffort('agent-a', 'turbo', st), false);
  assert.strictEqual(st.m.get('hub-simple-effort:agent-a'), 'turbo');
});

test('effort: a throwing storage is survived', () => {
  const bad = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.strictEqual(S.effortFor('agent-a', bad), 'medium');
  assert.strictEqual(S.setEffort('agent-a', 'low', bad), false);
  // no window in Node: default storage is absent, still no throw
  assert.strictEqual(S.effortFor('agent-a'), 'medium');
  assert.strictEqual(S.setEffort('agent-a', 'low'), false);
});

test('labelFor', () => {
  assert.strictEqual(S.labelFor('low'), 'Quick');
  assert.strictEqual(S.labelFor('medium'), 'Balanced');
  assert.strictEqual(S.labelFor('high'), 'Thorough');
  assert.strictEqual(S.labelFor('max'), 'Deepest');
  assert.strictEqual(S.labelFor('weird'), 'Balanced');
  assert.strictEqual(S.labelFor(undefined), 'Balanced');
});

test('reasoningTail: fewer lines, more lines, blank lines, partial last line, custom n', () => {
  assert.deepStrictEqual(S.reasoningTail('a\nb'), ['a', 'b']);
  assert.deepStrictEqual(S.reasoningTail('1\n2\n3\n4\n5\n6\n7'), ['3', '4', '5', '6', '7']);
  assert.deepStrictEqual(S.reasoningTail('1\n\n  \n2\n\n3\n'), ['1', '2', '3']);
  assert.deepStrictEqual(S.reasoningTail('first line\nsecond is part'), ['first line', 'second is part']);
  assert.deepStrictEqual(S.reasoningTail('1\n2\n3\n4', 2), ['3', '4']);
  const long = 'x'.repeat(500);
  assert.deepStrictEqual(S.reasoningTail('a\n' + long), ['a', long]);
  assert.deepStrictEqual(S.reasoningTail(''), []);
  assert.deepStrictEqual(S.reasoningTail(null), []);
});

test('consultLine: named agent, display name, temporal, and non-worker events', () => {
  assert.strictEqual(S.consultLine({ type: 'worker_started', agent_type: 'agent-a', description: 'Worker: Agent Health Helper' }), 'Asking Health Helper…');
  assert.strictEqual(S.consultLine({ type: 'worker_started', agent_type: 'agent-a' }), 'Asking agent-a…');
  assert.strictEqual(S.consultLine({ type: 'worker_started', agent_type: 'agent-a', description: 'something else' }), 'Asking agent-a…');
  assert.strictEqual(S.consultLine({ type: 'worker_started', agent_type: 'temporal', description: 'Worker: Agent X' }), 'Asking a helper…');
  assert.strictEqual(S.consultLine({ type: 'worker_started', agent_type: 'sdk-agent', description: 'SDK Worker: x' }), null);
  assert.strictEqual(S.consultLine({ type: 'worker_started' }), null);
  assert.strictEqual(S.consultLine({ type: 'worker_completed', agent_type: 'agent-a' }), null);
  assert.strictEqual(S.consultLine({ type: 'text_delta', text: 'hi' }), null);
  assert.strictEqual(S.consultLine(null), null);
});

test('autoNote: each hub-started prefix and ordinary text', () => {
  assert.deepStrictEqual(S.autoNote('[Scheduled task "x"] do it'), { label: 'Reminder' });
  assert.deepStrictEqual(S.autoNote('[Job finished] ok'), { label: 'Background job finished' });
  assert.deepStrictEqual(S.autoNote('[Job report] Agent "agent-a" ran job'), { label: 'Background job finished' });
  assert.deepStrictEqual(S.autoNote('[Delivery turn started by the hub: ...]'), { label: 'Update' });
  assert.deepStrictEqual(S.autoNote('[Consultation from agent "agent-a"]\n\nhi'), { label: 'Update' });
  const r = S.autoNote('[Resumed after compression, from the hub] ...');
  assert.strictEqual(r.label, null);
  assert.strictEqual(r.hide, true);
  assert.strictEqual(S.autoNote('Hello there'), null);
  assert.strictEqual(S.autoNote('see [Job finished] later'), null);
  assert.strictEqual(S.autoNote(''), null);
  assert.strictEqual(S.autoNote(undefined), null);
});

test('greeting: first name only, plain without a name', () => {
  assert.strictEqual(S.greeting('Sam Owner'), 'How can I help, Sam?');
  assert.strictEqual(S.greeting('  robin '), 'How can I help, robin?');
  assert.strictEqual(S.greeting(''), 'How can I help?');
  assert.strictEqual(S.greeting(null), 'How can I help?');
});

test('STARTERS', () => {
  assert.deepStrictEqual(S.STARTERS, ['What can you help me with?', 'Help me plan my day', 'Explain something in plain words']);
});

test('pickedEffort: the stored level, or null when never picked', () => {
  const mem = new Map();
  const st = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
  assert.strictEqual(S.pickedEffort('agent-a', st), null);
  assert.strictEqual(S.effortFor('agent-a', st), 'medium');   // effortFor keeps its default
  S.setEffort('agent-a', 'high', st);
  assert.strictEqual(S.pickedEffort('agent-a', st), 'high');
  mem.set('hub-simple-effort:agent-b', 'bogus');
  assert.strictEqual(S.pickedEffort('agent-b', st), null);
  assert.strictEqual(S.pickedEffort('agent-a', { getItem() { throw new Error('no'); } }), null);
});

test('labelForAgentEffort: the agent\'s own effort in plain words', () => {
  for (const [e, l] of [['low', 'Quick'], ['medium', 'Balanced'], ['default', 'Balanced'], [undefined, 'Balanced'], ['', 'Balanced'], ['high', 'Thorough'], ['xhigh', 'Thorough'], ['max', 'Deepest'], ['weird', 'Balanced']]) assert.strictEqual(S.labelForAgentEffort(e), l, String(e));
});

test('/ui-simple.js is served by lib/static-files from lib/ui-simple.js', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-simple-static-'));
  fs.mkdirSync(path.join(root, 'lib'));
  fs.writeFileSync(path.join(root, 'lib', 'ui-simple.js'), 'x');
  const got = resolve('/ui-simple.js', root);
  assert.strictEqual(got, fs.realpathSync(path.join(root, 'lib', 'ui-simple.js')));
  assert.strictEqual(resolve('/lib/ui-simple.js', root), null);
});
