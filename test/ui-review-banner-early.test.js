'use strict';
// The red review banner's place is held from the first paint on every load after the first (lib/ui-looks.js applyCachedBanner).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const L = require('../lib/ui-looks.js');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function fakeDoc() {
  const classes = new Set(), props = {}, calls = [];
  return {
    classes, props, calls,
    documentElement: {
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
      style: { setProperty: (k, v) => { props[k] = v; calls.push([k, v]); } },
    },
  };
}
function fakeStore(init) {
  const m = new Map(Object.entries(init || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, m };
}
const put = (o) => fakeStore({ mmReviewBanner: typeof o === 'string' ? o : JSON.stringify(o) });

test('a stored desk entry sets the class, the text as a CSS string, the height and --banner-h', () => {
  const d = fakeDoc();
  const got = L.applyCachedBanner(d, put({ desk: { t: 'Sign in needed. Open', h: 41 } }), 'desk');
  assert.deepEqual(got, { t: 'Sign in needed. Open', h: 41 });
  assert.ok(d.classes.has('mm-rvb-cached'));
  assert.equal(d.props['--mm-rvb-text'], '"Sign in needed. Open"');
  assert.equal(d.props['--mm-rvb-h'], '41px');
  assert.equal(d.props['--banner-h'], '41px');
});

test('a phone entry does not set --banner-h', () => {
  const d = fakeDoc();
  assert.ok(L.applyCachedBanner(d, put({ phone: { t: 'x', h: 30 } }), 'phone'));
  assert.equal(d.props['--mm-rvb-h'], '30px');
  assert.equal('--banner-h' in d.props, false);
  const d2 = fakeDoc();
  assert.equal(L.applyCachedBanner(d2, put({ phone: { t: 'x', h: 30 } }), 'desk'), null);
  assert.equal(d2.classes.size, 0);
});

test('bad JSON, wrong types, empty or too long text, bad heights do nothing', () => {
  const bad = ['{nope', '[]', 'null', '"s"', { desk: 'x' }, { desk: { t: 5, h: 41 } }, { desk: { t: 'a', h: '41' } },
    { desk: { t: '', h: 41 } }, { desk: { t: 'a'.repeat(401), h: 41 } }, { desk: { t: 'a', h: 0 } }, { desk: { t: 'a', h: 500 } }, { phone: { t: 'a', h: 41 } }];
  for (const v of bad) {
    const d = fakeDoc();
    assert.equal(L.applyCachedBanner(d, put(v), 'desk'), null, JSON.stringify(v));
    assert.equal(d.classes.size, 0);
    assert.equal(d.calls.length, 0);
  }
  assert.equal(L.applyCachedBanner(fakeDoc(), fakeStore(), 'desk'), null);
  assert.ok(L.applyCachedBanner(fakeDoc(), put({ desk: { t: 'a'.repeat(400), h: 400 } }), 'desk'));
});

test('control characters and backslashes are stripped from the text', () => {
  const d = fakeDoc();
  L.applyCachedBanner(d, put({ desk: { t: 'a\\b\nc\u0001d"e', h: 20 } }), 'desk');
  assert.equal(d.props['--mm-rvb-text'], JSON.stringify('abcd"e'));
  assert.equal(L.applyCachedBanner(fakeDoc(), put({ desk: { t: '\\\n', h: 20 } }), 'desk'), null);
});

test('rememberBanner keeps the other kind, removes the key when empty', () => {
  const s = fakeStore();
  L.rememberBanner(s, 'desk', { t: 'a', h: 10 });
  L.rememberBanner(s, 'phone', { t: 'b', h: 20 });
  assert.deepEqual(JSON.parse(s.m.get('mmReviewBanner')), { desk: { t: 'a', h: 10 }, phone: { t: 'b', h: 20 } });
  L.rememberBanner(s, 'desk', null);
  assert.deepEqual(JSON.parse(s.m.get('mmReviewBanner')), { phone: { t: 'b', h: 20 } });
  L.rememberBanner(s, 'phone', null);
  assert.equal(s.m.has('mmReviewBanner'), false);
  L.rememberBanner(s, 'desk', { t: 'a', h: 10 });
  L.forgetBanner(s);
  assert.equal(s.m.has('mmReviewBanner'), false);
});

test('rememberBanner and forgetBanner never throw with blocked storage', () => {
  const boom = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
  assert.doesNotThrow(() => L.rememberBanner(boom, 'desk', { t: 'a', h: 10 }));
  assert.doesNotThrow(() => L.rememberBanner(boom, 'desk', null));
  assert.doesNotThrow(() => L.forgetBanner(boom));
  assert.doesNotThrow(() => L.rememberBanner(null, 'desk', { t: 'a', h: 10 }));
  assert.doesNotThrow(() => L.forgetBanner(null));
});

test('pageKind: /mobile is the phone, everything else the desktop', () => {
  assert.equal(L.pageKind({ location: { pathname: '/mobile.html' } }), 'phone');
  assert.equal(L.pageKind({ location: { pathname: '/mobile' } }), 'phone');
  assert.equal(L.pageKind({ location: { pathname: '/' } }), 'desk');
  assert.equal(L.pageKind({}), 'desk');
  assert.equal(L.BANNER_KEY, 'mmReviewBanner');
});

function loadInVm(pathname, stored) {
  const d = fakeDoc();
  d.getElementById = () => null;
  d.addEventListener = () => {};
  const win = { location: { pathname }, localStorage: fakeStore({ mmReviewBanner: JSON.stringify(stored) }), document: d };
  win.window = win;
  vm.runInNewContext(read('lib/ui-looks.js'), win);
  return d;
}

test('loading ui-looks.js applies the cached banner at once', () => {
  const d = loadInVm('/', { desk: { t: 'Fix me', h: 41 }, phone: { t: 'P', h: 30 } });
  assert.ok(d.classes.has('mm-rvb-cached'));
  assert.equal(d.props['--mm-rvb-text'], '"Fix me"');
  assert.equal(d.props['--banner-h'], '41px');
  const p = loadInVm('/mobile.html', { desk: { t: 'Fix me', h: 41 }, phone: { t: 'P', h: 30 } });
  assert.equal(p.props['--mm-rvb-text'], '"P"');
  assert.equal('--banner-h' in p.props, false);
});

test('page sources: the placeholder rules, the calls and the unsettled early return', () => {
  const idx = read('index.html'), mob = read('mobile.html'), app = read('app.js'), mjs = read('mobile.js');
  assert.match(idx, /html\.mm-rvb-cached body::before \{[^}]*var\(--mm-rvb-text\)[^}]*var\(--mm-rvb-h\)/);
  assert.match(idx, /#hub-review-banner\.mm-rvb-enter/);
  assert.match(mob, /html\.mm-rvb-cached #review-banner\[hidden\] \{[^}]*var\(--mm-rvb-h\)/);
  assert.match(mob, /#review-banner\[hidden\]::before \{ content: var\(--mm-rvb-text\)/);
  for (const src of [app, mjs]) { assert.match(src, /rememberBanner\(/); assert.match(src, /forgetBanner\(/); }
  assert.ok(app.includes('if (!(window.hubMe || window.hubNoAccounts === true)) return;   // not settled'));
  assert.ok(mjs.includes('if (!(hubMe || window.hubNoAccounts === true)) return;   // not settled'));
  assert.match(read('lib/ui-looks.js'), /api\.applyCachedBanner\(root\.document, store, api\.pageKind\(root\)\)/);
});

test('desktop layoutBanners keeps the early stand-in last in the notice stack (its top and its height in --banner-h)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'app.js'), 'utf8');
  const body = src.slice(src.indexOf('function layoutBanners()'), src.indexOf('function layoutBanners()') + 1200);
  assert.ok(/!document\.getElementById\('hub-review-banner'\) && html\.classList\.contains\('mm-rvb-cached'\)/.test(body), 'checks for the stand-in');
  assert.ok(/--mm-rvb-top/.test(body) && /--mm-rvb-h/.test(body), 'sets its top and adds its height');
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(/html\.mm-rvb-cached body::before \{[^}]*top: var\(--mm-rvb-top, 0px\)/.test(html), 'the stand-in sits at --mm-rvb-top');
});
