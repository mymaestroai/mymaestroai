'use strict';
// The "Active" section of the agent list (lib/ui-active-agents.js), shared by the desktop and phone pages: who is
// active, the order, the 3-second linger, holding membership still under the pointer, the off switch and the access filter.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const L = require('../lib/ui-active-agents');

const ROOT = path.join(__dirname, '..');
const BEGIN = '// ── active agents helpers (begin) ──';
const END = '// ── active agents helpers (end) ──';
function helperBlock(src, indent) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  assert.ok(a > 0 && b > a, 'helper markers present');
  return src.slice(a + BEGIN.length, b).split('\n').map(l => (indent && l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n').trim();
}

for (const [file, indent] of [['app.js', '    '], ['mobile.js', '']]) {
  test(`the active-agents helpers in ${file} are byte-identical to lib/ui-active-agents.js`, () => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const lib = helperBlock(fs.readFileSync(path.join(ROOT, 'lib/ui-active-agents.js'), 'utf8'), '');
    assert.strictEqual(helperBlock(src, indent), lib, `${file} copy differs`);
  });
}

test('the helper block is plain browser JavaScript', () => {
  const block = helperBlock(fs.readFileSync(path.join(ROOT, 'lib/ui-active-agents.js'), 'utf8'), '');
  assert.ok(!/\b(require|module|process|Buffer)\b/.test(block));
});

const T0 = Date.parse('2026-01-01T10:00:00.000Z');
const iso = (s) => new Date(T0 + s * 1000).toISOString();
const names = (st) => st.rows.map(r => r.name + (r.doneAt == null ? '' : '(done)'));

test('activeBusyFrom: busy and waiting-for-answer agents count; idle ones and agents this person cannot see do not', () => {
  const map = {
    owner: { busy: true, busySince: iso(10) },
    sam: { busy: false, pendingQuestion: true, busySince: iso(20) },
    idle: { busy: false },
    hidden: { busy: true, busySince: iso(5) },
  };
  const b = L.activeBusyFrom(map, new Map(), ['owner', 'sam', 'idle']);
  assert.deepStrictEqual(Object.keys(b).sort(), ['owner', 'sam']);
  assert.strictEqual(b.owner, T0 + 10000);
});

test('activeBusyFrom: a temporary worker is not its own row; the agent that started it counts as working', () => {
  const map = {
    'tw-abc': { busy: true, busySince: iso(30), parent: 'owner' },
    helper: { busy: true, busySince: iso(40), worker: true, parent: 'sam' },
    'tw-orphan': { busy: true, busySince: iso(50) },
    'tw-named': { busy: true, busySince: iso(60), worker: false },
  };
  const b = L.activeBusyFrom(map, null, ['owner', 'sam', 'tw-named', 'tw-abc', 'helper']);
  assert.deepStrictEqual(Object.keys(b).sort(), ['owner', 'sam', 'tw-named']);
  assert.strictEqual(b.owner, T0 + 30000);
});

test('activeBusyFrom: a reply this page streams counts even before the hub says so; the earliest start wins', () => {
  const b = L.activeBusyFrom({ owner: { busy: true, busySince: iso(20) } }, new Map([['owner', iso(5)], ['sam', iso(7)], ['tw-x', iso(1)]]), ['owner', 'sam']);
  assert.deepStrictEqual(b, { owner: T0 + 5000, sam: T0 + 7000 });
  const obj = L.activeBusyFrom({}, { sam: iso(3) }, ['sam']);
  assert.deepStrictEqual(obj, { sam: T0 + 3000 });
});

test('activeStep: first fill is ordered longest-running first; a newcomer joins at the bottom; rows never swap', () => {
  let st = L.activeStep(L.activeInitial(), { busy: { sam: T0 + 20000, owner: T0 + 10000 }, now: T0 + 30000 });
  assert.deepStrictEqual(names(st), ['owner', 'sam']);
  st = L.activeStep(st, { busy: { sam: T0 + 20000, owner: T0 + 10000, early: T0 + 1000 }, now: T0 + 31000 });
  assert.deepStrictEqual(names(st), ['owner', 'sam', 'early'], 'joins at the bottom even with an older start');
});

test('activeStep: a finished agent stays 3 s marked done, then leaves; working again inside the 3 s keeps one row', () => {
  let st = L.activeStep(L.activeInitial(), { busy: { owner: T0, sam: T0 }, now: T0 });
  st = L.activeStep(st, { busy: { sam: T0 }, now: T0 + 1000 });
  assert.deepStrictEqual(names(st), ['owner(done)', 'sam']);
  st = L.activeStep(st, { busy: { sam: T0 }, now: T0 + 3999 });
  assert.deepStrictEqual(names(st), ['owner(done)', 'sam']);
  st = L.activeStep(st, { busy: { sam: T0 }, now: T0 + 4000 });
  assert.deepStrictEqual(names(st), ['sam']);
  // back-to-back: done, then busy again inside the linger: one row, not done
  st = L.activeStep(st, { busy: {}, now: T0 + 5000 });
  st = L.activeStep(st, { busy: { sam: T0 + 6000 }, now: T0 + 6000 });
  assert.deepStrictEqual(names(st), ['sam']);
  assert.strictEqual(st.rows.length, 1);
});

test('activeStep: while held nothing joins or leaves; done marks still update; release applies the changes', () => {
  let st = L.activeStep(L.activeInitial(), { busy: { owner: T0 }, now: T0 });
  st = L.activeStep(st, { busy: { sam: T0 + 1000 }, now: T0 + 1000, held: true });
  assert.deepStrictEqual(names(st), ['owner(done)'], 'sam waits, owner is marked done but stays');
  st = L.activeStep(st, { busy: { sam: T0 + 1000 }, now: T0 + 9000, held: true });
  assert.deepStrictEqual(names(st), ['owner(done)'], 'the linger does not end while held');
  st = L.activeStep(st, { busy: { sam: T0 + 1000 }, now: T0 + 9500, held: false });
  assert.deepStrictEqual(names(st), ['sam']);
});

test('activeStep: the switch off shows nothing, and on again starts fresh', () => {
  let st = L.activeStep(L.activeInitial(), { busy: { owner: T0 }, now: T0 });
  st = L.activeStep(st, { busy: { owner: T0 }, now: T0 + 1, enabled: false });
  assert.deepStrictEqual(st.rows, []);
  st = L.activeStep(st, { busy: { owner: T0 }, now: T0 + 2, enabled: true });
  assert.deepStrictEqual(names(st), ['owner']);
});

test('activeStep: an agent that drops out of this person\'s list leaves like a finished one', () => {
  const map = { owner: { busy: true, busySince: iso(0) } };
  let st = L.activeStep(L.activeInitial(), { busy: L.activeBusyFrom(map, null, ['owner']), now: T0 });
  st = L.activeStep(st, { busy: L.activeBusyFrom(map, null, []), now: T0 + 3000 });
  assert.deepStrictEqual(names(st), ['owner(done)']);
  st = L.activeStep(st, { busy: L.activeBusyFrom(map, null, []), now: T0 + 6000 });
  assert.deepStrictEqual(st.rows, []);
});

test('activeChanged and activeTitle', () => {
  const a = { rows: [{ name: 'owner', since: 1, doneAt: null }] };
  assert.strictEqual(L.activeChanged(a, { rows: [{ name: 'owner', since: 5, doneAt: null }] }), false, 'a start-time change does not redraw');
  assert.strictEqual(L.activeChanged(a, { rows: [{ name: 'owner', since: 1, doneAt: 9 }] }), true);
  assert.strictEqual(L.activeChanged(a, { rows: [] }), true);
  assert.strictEqual(L.activeTitle(a), 'Active 1');
  assert.strictEqual(L.activeTitle(L.activeInitial()), 'Active 0');
});
