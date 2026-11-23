'use strict';
// The wide-screen sidebar (phone page) is rebuilt only when what it shows changes; a status change only repaints the
// dots, so a row under a finger is never replaced and the list keeps its scroll position (review r3 BLOCK).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const js = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');

function fnSource(name) {
  const i = js.search(new RegExp('function ' + name + '\\('));
  assert.ok(i >= 0, name);
  let depth = 0; let j = js.indexOf('{', i);
  for (; j < js.length; j++) { if (js[j] === '{') depth++; else if (js[j] === '}') { depth--; if (!depth) break; } }
  return js.slice(i, j + 1);
}

function setup() {
  const calls = { fill: 0, dots: 0 };
  const listEl = { dataset: {}, scrollTop: 0 };
  const side = { querySelector: (sel) => (sel === '.ssd-list' ? listEl : { textContent: '' }) };
  const ctx = {
    calls, listEl,
    agents: [{ name: 'guide', display: 'Trip Guide', category: 'primary', lead: true }, { name: 'helper', display: 'Health Helper', category: 'specialist' }],
    current: 'guide', hubMe: { user: { name: 'Owner' } }, more: false,
    simpleOn: () => true, simpleSideEnsure: () => side, simpleMoreGet: () => ctx.more, isBusy: () => false, bgCountOf: () => 0, simpleInitial: () => 'O',
    simpleAgentListFill: () => { calls.fill++; listEl.scrollTop = 0; },
    simpleDotsIn: () => { calls.dots++; },
    simpleAgentSheetModel: (list, cur, open) => ({ primary: list.filter((a) => a.category === 'primary' || a.name === cur), groups: open ? [{ key: 'specialist', items: list.filter((a) => a.category === 'specialist') }] : [], hasMore: true, open: !!open }),
  };
  vm.createContext(ctx);
  vm.runInContext(fnSource('simpleSidePaint') + '\nthis.paint = simpleSidePaint;', ctx);
  return ctx;
}

test('the first paint builds the rows; a repaint with nothing changed only repaints the dots', () => {
  const ctx = setup();
  ctx.paint();
  assert.deepStrictEqual(ctx.calls, { fill: 1, dots: 0 });
  ctx.paint(); ctx.paint();
  assert.deepStrictEqual(ctx.calls, { fill: 1, dots: 2 });
});

test('a real change (open chat, More agents, a renamed agent) rebuilds, and the scroll position is kept', () => {
  const ctx = setup();
  ctx.paint();
  ctx.listEl.scrollTop = 120;
  ctx.current = 'helper'; ctx.paint();
  assert.strictEqual(ctx.calls.fill, 2);
  assert.strictEqual(ctx.listEl.scrollTop, 120);
  ctx.more = true; ctx.paint();
  assert.strictEqual(ctx.calls.fill, 3);
  ctx.agents[0].display = 'Guide'; ctx.paint();
  assert.strictEqual(ctx.calls.fill, 4);
  ctx.paint();
  assert.strictEqual(ctx.calls.fill, 4);
});
