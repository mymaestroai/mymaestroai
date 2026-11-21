'use strict';
// One theme save at a time: a second tap while a save is in flight does nothing, so a late failure can never roll
// the page back over a newer choice (review r1, both pages).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function fnSource(src, name) {
  const i = src.search(new RegExp('(async )?function ' + name + '\\('));
  assert.ok(i >= 0, name);
  let depth = 0; let j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}') { depth--; if (!depth) break; } }
  return src.slice(i, j + 1);
}
const S = require('../lib/ui-simple.js');

test('desktop: a second theme tap while the first save is pending is ignored; the failure restores the first value only', async () => {
  let release; const pending = new Promise((r) => { release = r; });
  const calls = [];
  const ctx = {
    window: { hubMe: { theme: 'light' }, hubSimple: { nextTheme: S.nextTheme, apply() {} } },
    simpleTopSync() {}, hubToast() {},
    simplePrefs: (b) => { calls.push(b.theme); return pending.then(() => { throw new Error('HTTP 500'); }); },
  };
  vm.createContext(ctx);
  vm.runInContext('let simpleThemeSaving = false;\n' + fnSource(read('app.js'), 'simpleThemeNext') + '\nthis.next = simpleThemeNext;', ctx);
  const first = ctx.next();
  await ctx.next();   // ignored while the first save is in flight
  assert.deepStrictEqual(calls, ['dark']);
  assert.strictEqual(ctx.window.hubMe.theme, 'dark');
  release(); await first;
  assert.strictEqual(ctx.window.hubMe.theme, 'light', 'the failed save puts back the value from before it');
  await ctx.next();   // free again after the save settles
  assert.deepStrictEqual(calls, ['dark', 'dark']);
});

test('phone: a second theme tap while the first save is pending is ignored', async () => {
  let release; const pending = new Promise((r) => { release = r; });
  const calls = [];
  const ctx = {
    window: { hubSimple: { nextTheme: S.nextTheme, apply() {} } },
    hubMe: { theme: 'auto' }, simpleOn: () => true, simpleToggleSync() {}, toast() {},
    simplePrefsPost: (b) => { calls.push(b.theme); return pending.then(() => true); },
  };
  vm.createContext(ctx);
  vm.runInContext('let simpleThemeSaving = false;\n' + fnSource(read('mobile.js'), 'simpleThemeTap') + '\nthis.tap = simpleThemeTap;', ctx);
  const first = ctx.tap();
  await ctx.tap();
  assert.deepStrictEqual(calls, ['light']);
  release(); await first;
  assert.strictEqual(ctx.hubMe.theme, 'light');
  await ctx.tap();
  assert.deepStrictEqual(calls, ['light', 'dark']);
});

test('both settings sheets share the same one-at-a-time flag', () => {
  assert.match(read('app.js'), /if \(simpleThemeSaving\) return;   \/\/ one theme save at a time \(shared with the theme button\)/);
  assert.match(read('mobile.js'), /if \(simpleThemeSaving\) return;   \/\/ one theme save at a time \(shared with the theme button\)/);
});
