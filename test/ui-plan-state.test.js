'use strict';
// How a weekly Claude plan window looks (lib/ui-plan-state.js), shared by the desktop and phone pages.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const L = require('../lib/ui-plan-state');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const BEGIN = '// ── plan state helpers (begin) ──';
const END = '// ── plan state helpers (end) ──';
function helperBlock(src, indent) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  assert.ok(a > 0 && b > a, 'helper markers present');
  return src.slice(a + BEGIN.length, b).split('\n').map(l => (indent && l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n').trim();
}

test('the plan state helpers are byte-identical in lib/ui-plan-state.js, app.js and mobile.js', () => {
  const lib = helperBlock(read('lib/ui-plan-state.js'), '');
  assert.strictEqual(helperBlock(read('app.js'), '    '), lib, 'app.js copy differs');
  assert.strictEqual(helperBlock(read('mobile.js'), ''), lib, 'mobile.js copy differs');
});

test('extra usage paying at 100%: warning, not refused; words say so', () => {
  const w = { utilization: 100, rejected: false, extraUsage: true };
  assert.deepStrictEqual(L.planState(w, [75, 90]), { pct: 100, extra: true, cls: 'warn' });
  assert.strictEqual(L.planPctText(w, [75, 90]), '100% · extra usage');
});

test('refused: rejected, or 100% without extra usage; rejected beats extraUsage', () => {
  assert.strictEqual(L.planState({ utilization: 60, rejected: true }, [75]).cls, 'refused');
  assert.strictEqual(L.planState({ utilization: 100 }, [75, 90]).cls, 'refused');
  const both = L.planState({ utilization: 100, rejected: true, extraUsage: true }, [75]);
  assert.deepStrictEqual([both.cls, both.extra], ['refused', false]);
  assert.strictEqual(L.planPctText({ utilization: 100, rejected: true, extraUsage: true }, []), '100%');
});

test('levels: all passed -> hot, some -> warn, none -> empty', () => {
  assert.strictEqual(L.planState({ utilization: 95 }, [75, 90]).cls, 'hot');
  assert.strictEqual(L.planState({ utilization: 80 }, [75, 90]).cls, 'warn');
  assert.strictEqual(L.planState({ utilization: 40 }, [75, 90]).cls, '');
  assert.strictEqual(L.planState({ utilization: 40 }).cls, '');
  assert.strictEqual(L.planPctText({ utilization: 89.6 }, [75]), '90%');
});
