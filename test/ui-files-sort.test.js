'use strict';
// Files panel sorting (desktop app.js, phone mobile.js). Offline: the list code is cut out of the page source and run with
// stubs, and localStorage is a plain object. Names in here are made up.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const mjs = fs.readFileSync(path.join(root, 'mobile.js'), 'utf8');
const cut = (src, from, to) => { const a = src.indexOf(from); assert.ok(a >= 0, from); const b = src.indexOf(to, a + from.length); assert.ok(b > a, to); return src.slice(a, b); };
const esc = (s) => String(s);
const store = () => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } }; };
const ENTRIES = () => [
  { name: 'old.txt', type: 'file', size: 300, mtime: '2026-01-01T00:00:00Z' },
  { name: 'b-folder', type: 'dir', size: 0, mtime: '2026-01-02T00:00:00Z' },
  { name: 'new.txt', type: 'file', size: 10, mtime: '2026-06-01T00:00:00Z' },
  { name: 'a-folder', type: 'dir', size: 0, mtime: '2026-05-01T00:00:00Z' },
  { name: 'mid.txt', type: 'file', size: 20, mtime: '2026-03-01T00:00:00Z' },
];

function desktop(localStorage) {
  const src = cut(app, 'function filesRenderList()', 'async function filesCopy(');
  const list = { innerHTML: '', className: '' };
  const state = { path: '', entries: ENTRIES() };
  const run = new Function('document', 'filesState', 'humanSize', 'filesJoin', 'esc', 'shareLinksOn', 'localStorage',
    `${src}; return { render: filesRenderList, sortBy: filesSortBy };`)({ getElementById: () => list }, state, String, (d, n) => n, esc, () => false, localStorage);
  run.render();
  const names = () => state.entries.map(e => e.name);
  return { names, list, sortBy: run.sortBy };
}

function phone(localStorage) {
  const src = cut(mjs, 'function filesRenderList()', 'async function onFilesListClick(');
  const list = { innerHTML: '' };
  const state = { path: '', openRow: -1, entries: [] };
  const run = new Function('$', 'filesState', 'humanSize', 'esc', 'shareLinksOn', 'localStorage',
    `${src}; return { apply: filesSortApply, sortBy: filesSortBy, render: filesRenderList };`)(() => list, state, String, esc, () => false, localStorage);
  state.entries = run.apply(ENTRIES());
  run.render();
  const names = () => state.entries.map(e => e.name);
  return { names, list, sortBy: run.sortBy };
}

for (const [label, make] of [['desktop', desktop], ['phone', phone]]) {
  test(`${label}: newest first by default, folders on top`, () => {
    const v = make(store());
    assert.deepStrictEqual(v.names(), ['a-folder', 'b-folder', 'new.txt', 'mid.txt', 'old.txt']);
    assert.ok(v.list.innerHTML.includes('▼'));
  });
  test(`${label}: a click sorts by that column, a second click reverses it, and the choice is kept`, () => {
    const ls = store();
    const v = make(ls);
    v.sortBy('name');
    assert.deepStrictEqual(v.names(), ['a-folder', 'b-folder', 'mid.txt', 'new.txt', 'old.txt']);
    v.sortBy('name');
    assert.deepStrictEqual(v.names(), ['b-folder', 'a-folder', 'old.txt', 'new.txt', 'mid.txt']);
    v.sortBy('size');
    assert.deepStrictEqual(v.names().slice(2), ['old.txt', 'mid.txt', 'new.txt']);
    assert.deepStrictEqual(JSON.parse(ls.getItem('hub-files-sort')), { key: 'size', dir: 'desc' });
    assert.deepStrictEqual(make(ls).names().slice(2), ['old.txt', 'mid.txt', 'new.txt']);
  });
  test(`${label}: a broken stored choice falls back to newest first`, () => {
    const ls = store(); ls.setItem('hub-files-sort', '{"key":"evil","dir":"sideways"}');
    assert.deepStrictEqual(make(ls).names().slice(2), ['new.txt', 'mid.txt', 'old.txt']);
  });
}

const broken = () => { const s = store(); s.setItem = () => { throw new Error('QuotaExceededError'); }; return s; };
for (const [label, make] of [['desktop', desktop], ['phone', phone]]) {
  test(`${label}: sorting still works when localStorage.setItem throws (private mode)`, () => {
    const v = make(broken());
    v.sortBy('name');
    assert.deepStrictEqual(v.names(), ['a-folder', 'b-folder', 'mid.txt', 'new.txt', 'old.txt']);
    v.sortBy('name');
    assert.deepStrictEqual(v.names(), ['b-folder', 'a-folder', 'old.txt', 'new.txt', 'mid.txt']);
  });
}

test('desktop: after sorting by size, each row\'s data-i points at the entry whose name the row shows', () => {
  const v = desktop(store());
  v.sortBy('size');
  const html = v.list.innerHTML;
  const rows = [...html.matchAll(/<tr data-i="(\d+)">\s*<td class="name">(.*?)<\/td>/gs)];
  assert.strictEqual(rows.length, 5);
  const names = v.names();
  for (const [, i, cell] of rows) {
    assert.ok(cell.includes(names[Number(i)]), `row ${i} shows "${cell}" but entries[${i}] is ${names[Number(i)]}`);
    // the action handlers of that row use the same index
    const row = html.slice(html.indexOf(`<tr data-i="${i}">`)).split('</tr>')[0];
    assert.ok(row.includes(`filesRename(${i})`) && row.includes(`filesDelete(${i})`));
  }
  assert.deepStrictEqual(rows.map(r => r[2].replace(/<[^>]*>/g, '').replace(/^\S+\s/, '').trim()), names);
});

test('markup: desktop headers are buttons with aria-sort; phone chips have aria-pressed and a 40px touch height', () => {
  const d = desktop(store()).list.innerHTML;
  assert.ok(d.includes('<button'), 'header button');
  assert.ok(d.includes('aria-sort="descending"') && d.includes('aria-sort="none"'));
  assert.ok(d.includes('class="fs-sort-btn"'));
  const p = phone(store()).list.innerHTML;
  assert.ok(p.includes('aria-pressed="true"') && p.includes('aria-pressed="false"'));
  assert.ok(p.includes('min-height:40px'));
  assert.ok(p.includes('flex-wrap:wrap'));
});
