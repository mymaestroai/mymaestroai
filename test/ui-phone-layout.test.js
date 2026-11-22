'use strict';
// lib/ui-phone-layout: a phone screen opens the phone layout, in a browser tab and in an installed app. "Phone" is decided by the screen
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
  // 1920x1080 at 200 % display scaling reports a 960x540 screen; its main pointer is the trackpad (pointer: fine).
  { name: 'touch laptop at 200 % scaling', screenWidth: 960, screenHeight: 540, maxTouchPoints: 10, coarsePointer: false, finePointer: true, phone: false },
  { name: 'phone with a fine pointer as well as touch (coarse wins)', screenWidth: 390, screenHeight: 844, maxTouchPoints: 5, coarsePointer: true, finePointer: true, phone: true },
  { name: 'desktop (a small window is not an input)', screenWidth: 1920, screenHeight: 1080, maxTouchPoints: 0, coarsePointer: false, phone: false },
];

for (const d of DEVICES) {
  test(`device: ${d.name}`, () => {
    const base = { screenWidth: d.screenWidth, screenHeight: d.screenHeight, maxTouchPoints: d.maxTouchPoints, coarsePointer: d.coarsePointer, finePointer: d.finePointer, param: null, keepDesktop: false, movedAt: null, now: 1e12 };
    assert.strictEqual(L.isPhoneScreen(base), d.phone);
    const inApp = L.phoneLayoutDecision({ ...base, standalone: true });
    assert.deepStrictEqual(inApp, { phone: d.phone, keepDesktop: false, standalone: true, move: d.phone, offer: false });
    const inTab = L.phoneLayoutDecision({ ...base, standalone: false });
    assert.deepStrictEqual(inTab, { phone: d.phone, keepDesktop: false, standalone: false, move: d.phone, offer: false });
  });
}

const PHONE = { screenWidth: 390, screenHeight: 844, maxTouchPoints: 5, coarsePointer: true, standalone: true, keepDesktop: false, param: null, movedAt: null, now: 1e12 };

test('stored keepDesktop on a phone: no move, the way back is offered', () => {
  assert.deepStrictEqual(L.phoneLayoutDecision({ ...PHONE, keepDesktop: true }), { phone: true, keepDesktop: true, standalone: true, move: false, offer: true });
  assert.deepStrictEqual(L.phoneLayoutDecision({ ...PHONE, keepDesktop: true, standalone: false }), { phone: true, keepDesktop: true, standalone: false, move: false, offer: true });
});
test('stored keepDesktop on a desktop: no offer', () => {
  const desk = { ...PHONE, screenWidth: 1920, screenHeight: 1080, maxTouchPoints: 0, coarsePointer: false, keepDesktop: true };
  assert.deepStrictEqual(L.phoneLayoutDecision(desk), { phone: false, keepDesktop: true, standalone: true, move: false, offer: false });
});
test('param 1 keeps the desktop and stores it', () => {
  const r = L.phoneLayoutDecision({ ...PHONE, param: '1' });
  assert.strictEqual(r.keepDesktop, true);
  assert.strictEqual(r.move, false);
  assert.strictEqual(r.offer, true, 'the computer layout on a phone keeps a way back');
});
test('param 0 with a stored keep clears it and moves on a phone, tab or app', () => {
  const r = L.phoneLayoutDecision({ ...PHONE, param: '0', keepDesktop: true });
  assert.strictEqual(r.keepDesktop, false);
  assert.strictEqual(r.move, true);
  assert.strictEqual(L.phoneLayoutDecision({ ...PHONE, standalone: false, param: '0', keepDesktop: true }).move, true);
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
      if (q.includes('pointer: fine')) return { matches: !!o.fine };
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

test('runner: an iPhone in a browser tab moves to /mobile once', () => {
  const { win, replaceCalls } = fakeWin({ standalone: false });
  const r = L.startPhoneLayout(win);
  assert.deepStrictEqual(replaceCalls, ['/mobile']);
  assert.ok(win.sessionStorage.m.has(L.MOVED_AT_KEY));
  assert.strictEqual(win.document.documentElement.style.visibility, 'hidden');
  assert.strictEqual(r.moving, true);
  assert.strictEqual(r.standalone, false);
  assert.strictEqual(win.hubPhoneLayout.standalone, false);
  L.startPhoneLayout(win);
  assert.strictEqual(replaceCalls.length, 1);
});

test('runner: an installed app reports standalone true', () => {
  const { win } = fakeWin({ standalone: true });
  assert.strictEqual(L.startPhoneLayout(win).standalone, true);
});

test('runner: a stored "use the full site" on a phone in a tab: no move, the bar is offered', () => {
  const { win, replaceCalls } = fakeWin({ standalone: false, local: { [L.KEEP_DESKTOP_KEY]: '1' } });
  const r = L.startPhoneLayout(win);
  assert.strictEqual(replaceCalls.length, 0);
  assert.deepStrictEqual(r, { phone: true, keepDesktop: true, standalone: false, moving: false, offer: true });
});

test('runner: a stored choice on a desktop offers nothing', () => {
  const { win } = fakeWin({ screen: { width: 1920, height: 1080 }, touch: 0, coarse: false, local: { [L.KEEP_DESKTOP_KEY]: '1' } });
  assert.strictEqual(L.startPhoneLayout(win).offer, false);
});

test('runner: a tablet in a browser tab does not move', () => {
  const { win, replaceCalls } = fakeWin({ standalone: false, screen: { width: 820, height: 1180 } });
  const r = L.startPhoneLayout(win);
  assert.strictEqual(replaceCalls.length, 0);
  assert.strictEqual(r.phone, false);
});

test('runner: ?desktop=1 is stored, stripped from the address, no move', () => {
  const { win, replaceCalls, stateCalls } = fakeWin({ standalone: true, search: '?desktop=1' });
  const r = L.startPhoneLayout(win);
  assert.strictEqual(replaceCalls.length, 0);
  assert.deepStrictEqual(win.localStorage.calls.set, [[L.KEEP_DESKTOP_KEY, '1']]);
  assert.deepStrictEqual(win.sessionStorage.calls.remove, ['hub-mobile-banner-kept'], 'choosing the full site again brings back a bar closed this session');
  assert.strictEqual(stateCalls.length, 1);
  assert.strictEqual(stateCalls[0][2], '/');
  assert.strictEqual(r.keepDesktop, true);
  assert.strictEqual(r.offer, true);
});

test('runner: ?desktop=0 removes the stored choice and (standalone phone) moves', () => {
  const { win, replaceCalls } = fakeWin({ standalone: true, search: '?desktop=0', local: { [L.KEEP_DESKTOP_KEY]: '1' } });
  const r = L.startPhoneLayout(win);
  assert.deepStrictEqual(win.localStorage.calls.remove, [L.KEEP_DESKTOP_KEY]);
  assert.deepStrictEqual(replaceCalls, ['/mobile']);
  assert.strictEqual(r.keepDesktop, false);
});

test('runner: ?desktop=0 in a browser tab removes the choice and moves to the phone layout', () => {
  const { win, replaceCalls } = fakeWin({ standalone: false, search: '?desktop=0&a=1', local: { [L.KEEP_DESKTOP_KEY]: '1' } });
  L.startPhoneLayout(win);
  assert.deepStrictEqual(replaceCalls, ['/mobile?a=1']);
  assert.deepStrictEqual(win.localStorage.calls.remove, [L.KEEP_DESKTOP_KEY]);
});
test('runner: ?desktop=0 on a desktop in a tab removes the choice and cleans the address', () => {
  const { win, replaceCalls, stateCalls } = fakeWin({ screen: { width: 1920, height: 1080 }, touch: 0, coarse: false, search: '?desktop=0&a=1', local: { [L.KEEP_DESKTOP_KEY]: '1' } });
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

test('desktopOnlyLink: the computer layout panels the phone page lacks', () => {
  assert.deepStrictEqual(L.DESKTOP_ONLY_PARAMS, ['memory', 'selfcheck', 'connectors', 'backups', 'health', 'websearch', 'settings-only']);   // settings-only: the phone app's Settings sheet
  for (const s of ['?memory=1', '?selfcheck=1', '?connectors=1', '?backups=1', '?a=2&memory=1']) assert.strictEqual(L.desktopOnlyLink(s), true, s);
  for (const s of ['', '?memory=0', '?update=1', '?security=1', '?wallet=unlock', '?agent=sam', null, undefined]) assert.strictEqual(L.desktopOnlyLink(s), false, String(s));
});

test('every target the computer layout opens is either kept on it or handled by the phone page', () => {
  // A new computer-only panel added to parseOpenTarget must be added to DESKTOP_ONLY_PARAMS (or to the phone page),
  // or a phone would move to /mobile and show nothing.
  const { parseOpenTarget } = require('../lib/ui-open-target');
  const keys = Object.keys(parseOpenTarget({ type: 'open-target', url: '/' }, 'http://x'));
  const PHONE_HANDLES = ['agent', 'update', 'security', 'wallet'];   // mobile.js: #chat (from ?agent), ?update, ?security, ?wallet
  const js = read('mobile.js');
  for (const k of ['update', 'security', 'wallet']) assert.ok(js.includes(`.get('${k}')`), `mobile.js reads ?${k}`);
  for (const k of keys) assert.ok(L.DESKTOP_ONLY_PARAMS.includes(k) || PHONE_HANDLES.includes(k), `open target "${k}" is neither kept on the computer layout nor handled by the phone page`);
});

test('runner: a phone tab opening a computer-layout panel link stays, with the bar', () => {
  for (const search of ['?memory=1', '?connectors=1', '?backups=1']) {
    const { win, replaceCalls } = fakeWin({ standalone: false, search });
    const r = L.startPhoneLayout(win);
    assert.strictEqual(replaceCalls.length, 0, search);
    assert.strictEqual(r.moving, false);
    assert.strictEqual(r.offer, true, 'the bar still offers the phone layout');
  }
  // Links the phone page handles still move.
  const { win, replaceCalls } = fakeWin({ standalone: false, search: '?update=1' });
  L.startPhoneLayout(win);
  assert.deepStrictEqual(replaceCalls, ['/mobile?update=1']);
});

test('runner: a touchscreen laptop at high scaling (fine main pointer) stays on the full site', () => {
  const { win, replaceCalls } = fakeWin({ screen: { width: 960, height: 540 }, touch: 10, coarse: false, fine: true });
  const r = L.startPhoneLayout(win);
  assert.strictEqual(replaceCalls.length, 0);
  assert.strictEqual(r.phone, false);
  assert.strictEqual(r.offer, false);
});

test('runner: a desktop computer does nothing', () => {
  const { win, replaceCalls, stateCalls, timeouts } = fakeWin({ standalone: true, screen: { width: 1920, height: 1080 }, touch: 0, coarse: false });
  const r = L.startPhoneLayout(win);
  assert.strictEqual(replaceCalls.length, 0);
  assert.strictEqual(stateCalls.length, 0);
  assert.strictEqual(timeouts.length, 0);
  assert.strictEqual(win.localStorage.calls.set.length, 0);
  assert.strictEqual(win.sessionStorage.calls.set.length, 0);
  assert.deepStrictEqual(r, { phone: false, keepDesktop: false, standalone: true, moving: false, offer: false });
});

test('runner: the bounce guard also stops a second move in a browser tab', () => {
  const { win, replaceCalls } = fakeWin({ standalone: false, session: { [L.MOVED_AT_KEY]: String(Date.now() - 2000) } });
  const r = L.startPhoneLayout(win);
  assert.strictEqual(replaceCalls.length, 0);
  assert.strictEqual(r.offer, true);
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
  assert.strictEqual(html.split('id="use-full-site"').length - 1, 1);
  const menu = html.slice(html.indexOf('<div id="menu">'));
  assert.ok(menu.includes('<a id="use-full-site" href="/?desktop=1">Use the full site</a>'), 'inside the menu');
  assert.ok(menu.indexOf('use-full-site') > menu.indexOf('Open full UI') && menu.indexOf('use-full-site') > menu.indexOf('menu-reload'));   // phone-menu reorder: Reload app is in the top group, the desktop links under Advanced > Other views
  const js = read('mobile.js');
  assert.ok(!js.includes("location.replace('/')"));
  assert.ok(!js.includes("location.href = '/'"));
  assert.ok(!js.includes("location.assign('/')"));
});

test('wiring: the desktop banner and the help text', () => {
  const app = read('app.js');
  assert.ok(app.includes('This is the computer layout.'));
  assert.ok(app.includes("try { closeStore.setItem(closeKey, 'off'); }"), 'the bar closes even when storage is blocked');
  // A phone on the full site by choice has its own close switch, kept only for the session: the way back never goes for good.
  assert.ok(app.includes("const closeKey = pl.phone && pl.keepDesktop ? 'hub-mobile-banner-kept' : 'hub-mobile-banner';"));
  assert.ok(app.includes("closeStore = closeKey === 'hub-mobile-banner-kept' ? sessionStorage : localStorage;"));
  assert.ok(app.includes("if (closeStore && closeStore.getItem(closeKey) === 'off') return;"));
  assert.ok(app.includes("for (const id of ['hub-phone-layout-notice', 'hub-no-accounts-notice',"), 'the bar is the first notice in the stack, so it covers none of them');
  const fn = app.slice(app.indexOf('function showMobileBanner()'), app.indexOf('// ── Hub Health Monitor'));
  assert.ok(fn.includes("bar.id = 'hub-phone-layout-notice'") && fn.includes('bar.remove(); layoutBanners();') && /appendChild\(bar\);\n\s*layoutBanners\(\);/.test(fn), 'drawn and dismissed through layoutBanners');
  assert.ok(app.includes('Open the phone layout'));
  assert.ok(fn.includes('id="hub-phone-layout-open"'), 'the link has an id');
  assert.match(fn, /querySelector\('#hub-phone-layout-open'\)\.addEventListener\('click', \(\) => \{ try \{ localStorage\.removeItem\('hub-keep-desktop'\); \}/, 'choosing the phone layout undoes "Use the full site"');
  assert.ok(!fn.includes('preventDefault'));
  assert.ok(app.includes('window.hubPhoneLayout'));
  assert.ok(!app.includes('Phone? Try the mobile view'));
  assert.ok(read('help.html').includes('/?desktop=1'));
});

test('wiring: login destination no longer tests the user agent and returns / without next', () => {
  const html = read('login.html');
  const fn = html.slice(html.indexOf('function destination()'), html.indexOf('function show('));
  assert.ok(fn.includes("return '/';"));
  assert.ok(!fn.includes('userAgent') && !/Android\|iPhone/.test(fn) && !fn.includes('/mobile'));
});
