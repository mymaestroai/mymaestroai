'use strict';
// The red review banner's place is reserved from the first paint on every load after the first (lib/ui-looks.js applyCachedBanner).
// Only its height is remembered, never its text: a shared browser must not show one person's banner to the next before the page
// knows who is signed in, and a problem fixed since the last visit must not flash its old title.
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

test('a stored desk height sets the class, --mm-rvb-h and --banner-h, and no text', () => {
  const d = fakeDoc();
  const got = L.applyCachedBanner(d, put({ desk: { h: 41 } }), 'desk');
  assert.deepEqual(got, { h: 41 });
  assert.ok(d.classes.has('mm-rvb-cached'));
  assert.equal(d.props['--mm-rvb-h'], '41px');
  assert.equal(d.props['--banner-h'], '41px');
  assert.deepEqual(Object.keys(d.props).sort(), ['--banner-h', '--mm-rvb-h']);
});

test('a phone entry does not set --banner-h; a desk page ignores a phone-only entry', () => {
  const d = fakeDoc();
  assert.ok(L.applyCachedBanner(d, put({ phone: { h: 30 } }), 'phone'));
  assert.equal(d.props['--mm-rvb-h'], '30px');
  assert.equal('--banner-h' in d.props, false);
  const d2 = fakeDoc();
  assert.equal(L.applyCachedBanner(d2, put({ phone: { h: 30 } }), 'desk'), null);
  assert.equal(d2.classes.size, 0);
});

test('bad JSON, wrong types and bad heights do nothing', () => {
  const bad = ['{nope', '[]', 'null', '"s"', { desk: 'x' }, { desk: { h: '41' } }, { desk: { h: 0 } }, { desk: { h: 500 } }, { desk: { h: NaN } }, { desk: {} }, { phone: { h: 41 } }];
  for (const v of bad) {
    const d = fakeDoc();
    assert.equal(L.applyCachedBanner(d, put(v), 'desk'), null, JSON.stringify(v));
    assert.equal(d.classes.size, 0);
    assert.equal(d.calls.length, 0);
  }
  assert.equal(L.applyCachedBanner(fakeDoc(), fakeStore(), 'desk'), null);
  assert.ok(L.applyCachedBanner(fakeDoc(), put({ desk: { h: 400 } }), 'desk'));
});

test('the banner text is never stored nor shown (an old stored text is ignored)', () => {
  const s = fakeStore();
  L.rememberBanner(s, 'desk', { t: 'Admin-only problem title', h: 41 });
  assert.equal(s.m.get('mmReviewBanner').includes('Admin'), false, 'only the height is written');
  assert.deepEqual(JSON.parse(s.m.get('mmReviewBanner')), { desk: { h: 41 } });
  const d = fakeDoc();
  L.applyCachedBanner(d, put({ desk: { t: 'Old title', h: 41 } }), 'desk');
  assert.equal(JSON.stringify(d.props).includes('Old title'), false);
});

test('rememberBanner keeps the other kind, rounds the height, removes the key when empty', () => {
  const s = fakeStore();
  L.rememberBanner(s, 'desk', { h: 10.6 });
  L.rememberBanner(s, 'phone', { h: 20 });
  assert.deepEqual(JSON.parse(s.m.get('mmReviewBanner')), { desk: { h: 11 }, phone: { h: 20 } });
  L.rememberBanner(s, 'desk', null);
  assert.deepEqual(JSON.parse(s.m.get('mmReviewBanner')), { phone: { h: 20 } });
  L.rememberBanner(s, 'phone', null);
  assert.equal(s.m.has('mmReviewBanner'), false);
  L.rememberBanner(s, 'desk', { h: 10 });
  L.forgetBanner(s);
  assert.equal(s.m.has('mmReviewBanner'), false);
});

test('rememberBanner and forgetBanner never throw with blocked storage', () => {
  const boom = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
  assert.doesNotThrow(() => L.rememberBanner(boom, 'desk', { h: 10 }));
  assert.doesNotThrow(() => L.rememberBanner(boom, 'desk', null));
  assert.doesNotThrow(() => L.forgetBanner(boom));
  assert.doesNotThrow(() => L.rememberBanner(null, 'desk', { h: 10 }));
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

test('loading ui-looks.js reserves the remembered height at once', () => {
  const d = loadInVm('/', { desk: { h: 41 }, phone: { h: 30 } });
  assert.ok(d.classes.has('mm-rvb-cached'));
  assert.equal(d.props['--banner-h'], '41px');
  const p = loadInVm('/mobile.html', { desk: { h: 41 }, phone: { h: 30 } });
  assert.equal(p.props['--mm-rvb-h'], '30px');
  assert.equal('--banner-h' in p.props, false);
});

test('page sources: the reserved place is empty, the calls, the unsettled early return', () => {
  const idx = read('index.html'), mob = read('mobile.html'), app = read('app.js'), mjs = read('mobile.js');
  assert.equal(/mm-rvb-text|body::before/.test(idx), false, 'desktop: no stand-in drawn, only the padding (--banner-h)');
  assert.match(idx, /#hub-review-banner\.mm-rvb-enter/);
  assert.match(mob, /html\.mm-rvb-cached #review-banner\[hidden\] \{ display: block; visibility: hidden; min-height: var\(--mm-rvb-h\); \}/);
  assert.equal(/mm-rvb-text/.test(mob), false);
  for (const src of [app, mjs]) { assert.match(src, /rememberBanner\(/); assert.match(src, /forgetBanner\(/); assert.equal(/textContent[^\n]*rememberBanner|rememberBanner[^\n]*textContent/.test(src), false, 'no text is remembered'); }
  assert.ok(app.includes('if (!(window.hubMe || window.hubNoAccounts === true)) return;   // not settled'));
  assert.ok(mjs.includes('if (!(hubMe || window.hubNoAccounts === true)) return;   // not settled'));
  assert.match(read('lib/ui-looks.js'), /api\.applyCachedBanner\(root\.document, store, api\.pageKind\(root\)\)/);
});

test('desktop layoutBanners counts the reserved place until the real bar exists, and remembers the real bar height', () => {
  const body = read('app.js').slice(read('app.js').indexOf('function layoutBanners()'), read('app.js').indexOf('function layoutBanners()') + 1400);
  assert.ok(/if \(!rb && html\.classList\.contains\('mm-rvb-cached'\)\) top \+= parseFloat\(html\.style\.getPropertyValue\('--mm-rvb-h'\)\)/.test(body));
  assert.ok(/if \(rb && rb\.offsetHeight > 0\) \{ try \{ if \(window\.HubLooks\) window\.HubLooks\.rememberBanner\(window\.HubLooks\.storageOf\(window\), 'desk', \{ h: rb\.offsetHeight \}\)/.test(body));
});

// The phone's reviewPaintBanner, run for real on a small fake page.
function phonePaint() {
  const src = read('mobile.js');
  const i = src.indexOf('function reviewPaintBanner(r) {');
  const fn = src.slice(i, src.indexOf('\n}\n', i) + 2);
  const classes = new Set(['mm-rvb-cached']);
  const store = fakeStore({ mmReviewBanner: JSON.stringify({ phone: { h: 47 } }) });
  const bar = { hidden: true, textContent: 'x', offsetHeight: 0 };
  const ctx = {
    hubMe: null, store, bar, classes,
    $: (id) => (id === 'review-banner' ? bar : null),
    document: { documentElement: { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) } } },
    setTimeout: () => 0,
  };
  ctx.window = { hubReview: { bannerOf: () => null }, HubLooks: { storageOf: () => store, rememberBanner: L.rememberBanner }, hubNoAccounts: false };
  vm.runInNewContext(fn + '\nthis.paint = reviewPaintBanner;', ctx);
  return ctx;
}

test('phone reviewPaintBanner: before the page knows who is signed in nothing changes; a settled "nothing to fix" drops the reserved place and its memory', () => {
  const c = phonePaint();
  c.paint(null);
  assert.ok(c.classes.has('mm-rvb-cached'), 'unsettled: the reserved place stays');
  assert.ok(c.store.m.has('mmReviewBanner'), 'unsettled: the memory stays');
  c.hubMe = { user: { id: 'owner' }, isAdmin: false };
  c.paint({ fix: [] });
  assert.equal(c.classes.has('mm-rvb-cached'), false, 'settled: the place goes');
  assert.equal(c.store.m.has('mmReviewBanner'), false, 'settled: the memory goes');
  assert.equal(c.bar.hidden, true);
});

test('the backstop (no settled answer in 15 s) also forgets the remembered height on both pages', () => {
  const app = read('app.js'), mjs = read('mobile.js');
  const a = app.slice(app.indexOf('const reviewBannerBackstop = setTimeout('), app.indexOf('const reviewBannerBackstop = setTimeout(') + 500);
  assert.ok(/rememberBanner\(window\.HubLooks\.storageOf\(window\), 'desk', null\)/.test(a));
  const m = mjs.slice(mjs.indexOf('const reviewBannerBackstop = setTimeout('), mjs.indexOf('const reviewBannerBackstop = setTimeout(') + 400);
  assert.ok(/rememberBanner\(window\.HubLooks\.storageOf\(window\), 'phone', null\)/.test(m));
});
