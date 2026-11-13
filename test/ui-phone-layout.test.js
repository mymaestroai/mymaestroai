'use strict';
// lib/ui-phone-layout: an installed app on a phone screen opens the phone layout. "Phone" is decided by the screen
// (short side, touch), never by user agent or window width.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const L = require(path.join(__dirname, '..', 'lib', 'ui-phone-layout.js'));

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// The user agent and the window width are NOT inputs: "request desktop website" changes both (Macintosh, ~980 px)
// but not the screen, so an iPhone with the desktop site requested is the same input as a normal iPhone.
const DEVICES = [
  { name: 'iPhone normal', screenWidth: 390, screenHeight: 844, maxTouchPoints: 5, coarsePointer: true, phone: true },
  { name: 'iPhone with desktop site requested', screenWidth: 390, screenHeight: 844, maxTouchPoints: 5, coarsePointer: false, phone: true },
  { name: 'Android phone', screenWidth: 412, screenHeight: 915, maxTouchPoints: 5, coarsePointer: true, phone: true },
  { name: 'iPhone landscape', screenWidth: 844, screenHeight: 390, maxTouchPoints: 5, coarsePointer: true, phone: true },
  { name: 'iPad', screenWidth: 820, screenHeight: 1180, maxTouchPoints: 5, coarsePointer: true, phone: false },
  { name: 'touch laptop', screenWidth: 1920, screenHeight: 1080, maxTouchPoints: 10, coarsePointer: false, phone: false },
  { name: 'desktop (a small window is not an input)', screenWidth: 1920, screenHeight: 1080, maxTouchPoints: 0, coarsePointer: false, phone: false },
];

for (const d of DEVICES) {
  test(`device: ${d.name}`, () => {
    const base = { screenWidth: d.screenWidth, screenHeight: d.screenHeight, maxTouchPoints: d.maxTouchPoints, coarsePointer: d.coarsePointer, param: null, keepDesktop: false, movedAt: null, now: 1e12 };
    assert.strictEqual(L.isPhoneScreen(base), d.phone);
    const inApp = L.phoneLayoutDecision({ ...base, standalone: true });
    assert.deepStrictEqual(inApp, { phone: d.phone, keepDesktop: false, move: d.phone, offer: false });
    const inTab = L.phoneLayoutDecision({ ...base, standalone: false });
    assert.deepStrictEqual(inTab, { phone: d.phone, keepDesktop: false, move: false, offer: d.phone });
  });
}

const PHONE = { screenWidth: 390, screenHeight: 844, maxTouchPoints: 5, coarsePointer: true, standalone: true, keepDesktop: false, param: null, movedAt: null, now: 1e12 };

test('stored keepDesktop: no move, no offer', () => {
  assert.deepStrictEqual(L.phoneLayoutDecision({ ...PHONE, keepDesktop: true }), { phone: true, keepDesktop: true, move: false, offer: false });
});
test('param 1 keeps the desktop and stores it', () => {
  const r = L.phoneLayoutDecision({ ...PHONE, param: '1' });
  assert.strictEqual(r.keepDesktop, true);
  assert.strictEqual(r.move, false);
  assert.strictEqual(r.offer, false);
});
test('param 0 with a stored keep clears it and moves when standalone on a phone', () => {
  const r = L.phoneLayoutDecision({ ...PHONE, param: '0', keepDesktop: true });
  assert.strictEqual(r.keepDesktop, false);
  assert.strictEqual(r.move, true);
});
test('param once: no move, offer on a phone', () => {
  const r = L.phoneLayoutDecision({ ...PHONE, param: 'once' });
  assert.strictEqual(r.move, false);
  assert.strictEqual(r.offer, true);
});
test('bounce guard: moved 5 s ago no move; 31 s ago moves; in the future moves', () => {
  const now = 1e12;
  assert.strictEqual(L.phoneLayoutDecision({ ...PHONE, movedAt: now - 5000 }).move, false);
  assert.strictEqual(L.phoneLayoutDecision({ ...PHONE, movedAt: now - 31000 }).move, true);
  assert.strictEqual(L.phoneLayoutDecision({ ...PHONE, movedAt: now + 5000 }).move, true);
  assert.strictEqual(L.phoneLayoutDecision({ ...PHONE, movedAt: NaN }).move, true);
});
test('garbage sizes are not a phone', () => {
  for (const v of [0, NaN, undefined, -5, Infinity, '390']) {
    assert.strictEqual(L.isPhoneScreen({ ...PHONE, screenWidth: v }), false, String(v));
    assert.strictEqual(L.isPhoneScreen({ ...PHONE, screenHeight: v }), false, String(v));
  }
  assert.strictEqual(L.isPhoneScreen(), false);
});
test('a small screen without touch is not a phone', () => {
  assert.strictEqual(L.isPhoneScreen({ screenWidth: 390, screenHeight: 844, maxTouchPoints: 0, coarsePointer: false }), false);
  assert.strictEqual(L.isPhoneScreen({ screenWidth: 390, screenHeight: 844, maxTouchPoints: 0, coarsePointer: true }), true);
});

test('desktopParam', () => {
  assert.strictEqual(L.desktopParam('?desktop=1&agent=x'), '1');
  assert.strictEqual(L.desktopParam('?agent=x&desktop=0'), '0');
  assert.strictEqual(L.desktopParam('?desktop=once'), 'once');
  assert.strictEqual(L.desktopParam('?desktop=yes'), null);
  assert.strictEqual(L.desktopParam('?desktop='), null);
  assert.strictEqual(L.desktopParam('?agent=x'), null);
  assert.strictEqual(L.desktopParam(''), null);
  assert.strictEqual(L.desktopParam(undefined), null);
});

test('phoneLayoutTarget', () => {
  assert.strictEqual(L.phoneLayoutTarget('', ''), '/mobile');
  assert.strictEqual(L.phoneLayoutTarget('', '#x'), '/mobile#x');
  assert.strictEqual(L.phoneLayoutTarget('?desktop=0', ''), '/mobile');
  assert.strictEqual(L.phoneLayoutTarget('?agent=sam&desktop=0', '#x'), '/mobile?agent=sam#x');
  // A notification for an app installed from "/" opens "/?agent=<name>"; the phone page's chat address is "#chat=<name>".
  assert.strictEqual(L.phoneLayoutTarget('?agent=sam', ''), '/mobile#chat=sam');
  assert.strictEqual(L.phoneLayoutTarget('?agent=patient%20a&update=1', ''), '/mobile?update=1#chat=patient%20a');
  assert.strictEqual(L.phoneLayoutTarget('?wallet=unlock', ''), '/mobile?wallet=unlock');
  assert.strictEqual(L.phoneLayoutTarget('?a=1&desktop=1&b=2', ''), '/mobile?a=1&b=2');
});

// ── runner ──
function store(init, throws) {
  const m = new Map(Object.entries(init || {}));
  const calls = { set: [], remove: [] };
  return {
    calls, m,
    getItem(k) { if (throws) throw new Error('blocked'); return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { if (throws) throw new Error('blocked'); calls.set.push([k, v]); m.set(k, String(v)); },
    removeItem(k) { if (throws) throw new Error('blocked'); calls.remove.push(k); m.delete(k); },
  };
}
function fakeWin(o) {
  o = o || {};
  const dev = o.screen || { width: 390, height: 844 };
  const replaceCalls = [], stateCalls = [], timeouts = [];
  const win = {
    screen: dev,
    navigator: { maxTouchPoints: o.touch === undefined ? 5 : o.touch, standalone: o.navStandalone },
    matchMedia(q) {
      if (q.includes('pointer: coarse')) return { matches: o.coarse === undefined ? true : o.coarse };
      if (q.includes('display-mode: standalone')) return { matches: !!o.standalone };
      return { matches: false };
    },
    localStorage: store(o.local, o.storageThrows),
    sessionStorage: store(o.session, o.storageThrows),
    location: {
      pathname: '/', search: o.search || '', hash: o.hash || '',
      replace(u) { replaceCalls.push(u); if (o.replaceThrows) throw new Error('nope'); },
    },
    history: { state: null, replaceState(...a) { stateCalls.push(a); } },
    document: { documentElement: { style: { visibility: '' } } },
    setTimeout(fn, ms) { timeouts.push([fn, ms]); return timeouts.length; },
  };
  return { win, replaceCalls, stateCalls, timeouts };
}

test('runner: standalone iPhone moves to /mobile once', () => {
  const { win, replaceCalls, timeouts } = fakeWin({ standalone: true });
  const r = L.startPhoneLayout(win);
  assert.deepStrictEqual(replaceCalls, ['/mobile']);
  assert.ok(win.sessionStorage.m.has(L.MOVED_AT_KEY));
  assert.strictEqual(r.moving, true);
  assert.strictEqual(win.hubPhoneLayout, r);
  assert.strictEqual(win.document.documentElement.style.visibility, 'hidden');
  assert.strictEqual(timeouts.length, 1);
  assert.strictEqual(timeouts[0][1], 5000);
  timeouts[0][0]();
  assert.strictEqual(win.document.documentElement.style.visibility, '');
  const again = L.startPhoneLayout(win);
  assert.strictEqual(again, r);
  assert.strictEqual(replaceCalls.length, 1);
});

test('runner: navigator.standalone (iOS) counts as standalone and the other params are kept', () => {
  const { win, replaceCalls } = fakeWin({ navStandalone: true, search: '?agent=sam', hash: '#x' });
  L.startPhoneLayout(win);
  assert.deepStrictEqual(replaceCalls, ['/mobile?agent=sam#x']);
});

test('runner: same iPhone in a browser tab is offered the phone layout', () => {
  const { win, replaceCalls } = fakeWin({ standalone: false });
  const r = L.startPhoneLayout(win);
  assert.strictEqual(replaceCalls.length, 0);
  assert.deepStrictEqual(r, { phone: true, keepDesktop: false, moving: false, offer: true });
  assert.strictEqual(win.document.documentElement.style.visibility, '');
});

test('runner: ?desktop=1 is stored, stripped from the address, no move', () => {
  const { win, replaceCalls, stateCalls } = fakeWin({ standalone: true, search: '?desktop=1' });
  const r = L.startPhoneLayout(win);
  assert.strictEqual(replaceCalls.length, 0);
  assert.deepStrictEqual(win.localStorage.calls.set, [[L.KEEP_DESKTOP_KEY, '1']]);
  assert.strictEqual(stateCalls.length, 1);
  assert.strictEqual(stateCalls[0][2], '/');
  assert.strictEqual(r.keepDesktop, true);
  assert.strictEqual(r.offer, false);
});

test('runner: ?desktop=0 removes the stored choice and (standalone phone) moves', () => {
  const { win, replaceCalls } = fakeWin({ standalone: true, search: '?desktop=0', local: { [L.KEEP_DESKTOP_KEY]: '1' } });
  const r = L.startPhoneLayout(win);
  assert.deepStrictEqual(win.localStorage.calls.remove, [L.KEEP_DESKTOP_KEY]);
  assert.deepStrictEqual(replaceCalls, ['/mobile']);
  assert.strictEqual(r.keepDesktop, false);
});

test('runner: ?desktop=0 in a browser tab removes the choice and cleans the address', () => {
  const { win, replaceCalls, stateCalls } = fakeWin({ standalone: false, search: '?desktop=0&a=1', local: { [L.KEEP_DESKTOP_KEY]: '1' } });
  L.startPhoneLayout(win);
  assert.strictEqual(replaceCalls.length, 0);
  assert.deepStrictEqual(win.localStorage.calls.remove, [L.KEEP_DESKTOP_KEY]);
  assert.strictEqual(stateCalls[0][2], '/?a=1');
});

test('runner: ?desktop=once shows the desktop for this visit', () => {
  const { win, replaceCalls, stateCalls } = fakeWin({ standalone: true, search: '?desktop=once' });
  const r = L.startPhoneLayout(win);
  assert.strictEqual(replaceCalls.length, 0);
  assert.strictEqual(stateCalls[0][2], '/');
  assert.strictEqual(r.offer, true);
});

test('runner: storage that throws still decides and moves', () => {
  const { win, replaceCalls } = fakeWin({ standalone: true, storageThrows: true });
  const r = L.startPhoneLayout(win);
  assert.deepStrictEqual(replaceCalls, ['/mobile']);
  assert.strictEqual(r.moving, true);
});

test('runner: a location.replace that throws restores the page and does not throw', () => {
  const { win, replaceCalls } = fakeWin({ standalone: true, replaceThrows: true });
  assert.doesNotThrow(() => L.startPhoneLayout(win));
  assert.strictEqual(replaceCalls.length, 1);
  assert.strictEqual(win.document.documentElement.style.visibility, '');
  assert.strictEqual(win.hubPhoneLayout.moving, false, 'not moving after all');
  assert.strictEqual(win.hubPhoneLayout.offer, true, 'so the bar offers the phone layout');
});

test('runner: a desktop computer does nothing', () => {
  const { win, replaceCalls, stateCalls, timeouts } = fakeWin({ standalone: true, screen: { width: 1920, height: 1080 }, touch: 0, coarse: false });
  const r = L.startPhoneLayout(win);
  assert.strictEqual(replaceCalls.length, 0);
  assert.strictEqual(stateCalls.length, 0);
  assert.strictEqual(timeouts.length, 0);
  assert.strictEqual(win.localStorage.calls.set.length, 0);
  assert.strictEqual(win.sessionStorage.calls.set.length, 0);
  assert.deepStrictEqual(r, { phone: false, keepDesktop: false, moving: false, offer: false });
});

test('runner: a fresh window with a move 2 s ago does not move again (bounce guard)', () => {
  const { win, replaceCalls } = fakeWin({ standalone: true, session: { [L.MOVED_AT_KEY]: String(Date.now() - 2000) } });
  const r = L.startPhoneLayout(win);
  assert.strictEqual(replaceCalls.length, 0);
  assert.strictEqual(r.moving, false);
  assert.strictEqual(r.offer, true);
});

// ── wiring ──
test('wiring: the file is served and loaded first by index.html', () => {
  const { resolve } = require('../lib/static-files');
  const r = resolve('/ui-phone-layout.js');
  assert.ok(r && r.endsWith(path.join('lib', 'ui-phone-layout.js')));
  const html = read('index.html');
  const tag = '<script src="/ui-phone-layout.js"></script>';
  const at = html.indexOf(tag);
  assert.ok(at > -1);
  assert.strictEqual(html.indexOf(tag, at + 1), -1, 'loaded once');
  const css = html.indexOf('rel="stylesheet"');
  if (css > -1) assert.ok(at < css);
  assert.ok(at < html.indexOf('<body'));
  assert.ok(html.indexOf('<meta name="viewport"') < at);
});

test('wiring: mobile page links to the desktop with ?desktop=once and never sends a phone back on its own', () => {
  const html = read('mobile.html');
  assert.ok(!html.includes('href="/"'));
  assert.strictEqual(html.split('href="/?desktop=once"').length - 1, 2);
  const js = read('mobile.js');
  assert.ok(!js.includes("location.replace('/')"));
  assert.ok(!js.includes("location.href = '/'"));
  assert.ok(!js.includes("location.assign('/')"));
});

test('wiring: the desktop banner and the help text', () => {
  const app = read('app.js');
  assert.ok(app.includes('This is the computer layout.'));
  assert.ok(app.includes("try { localStorage.setItem('hub-mobile-banner', 'off'); }"), 'the bar closes even when storage is blocked');
  assert.ok(app.includes('Open the phone layout'));
  assert.ok(app.includes('window.hubPhoneLayout'));
  assert.ok(!app.includes('Phone? Try the mobile view'));
  assert.ok(read('help.html').includes('/?desktop=1'));
});
