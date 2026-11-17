'use strict';
// remote-desktop.html: zoom + pan. The pure view math (rdView), and the page driven in a vm with the REAL MeshCentral viewer scripts
// and a canvas/scroller stub that behaves like a browser (CSS size from the page, scroll clamped, rect from both).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const viewer = fs.readFileSync(path.join(__dirname, '..', 'remote-desktop.html'), 'utf8');
const dir = '/opt/mymaestro-remote/runtime/node_modules/meshcentral/public/scripts/';
const scripts = ['common-0.0.1.js', 'agent-redir-ws-0.1.1.js', 'agent-desktop-0.0.2.js'].map(n => dir + n);
const haveScripts = scripts.every(f => fs.existsSync(f));
const mathSrc = viewer.match(/<script>\n(var rdView[\s\S]*?)<\/script>/)[1];
const mainSrc = viewer.match(/<script>\n\(function[\s\S]*?<\/script>/)[0].replace(/^<script>|<\/script>$/g, '');
const pre = viewer.match(/<script>(var urlargs = \{\};[\s\S]*?)<\/script>/)[1];

const mathCtx = vm.createContext({ Math, Number, isFinite });
vm.runInContext(mathSrc, mathCtx);
const V = mathCtx.rdView;
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} !~ ${b}`);

// What SendMouseMsg (agent-desktop-0.0.2.js lines 582-600) computes from a page position.
const sendMouseFormula = (off, clientW, clientH, cw, ch, pageX, pageY) => ({ X: (pageX - off[0]) * (cw / clientW), Y: (pageY - off[1]) * (ch / clientH) });

test('rdView.toDesktop: zoom 1, 2 and 4 with a scrolled, offset rectangle', () => {
  // Desktop 1920x1080 shown 800x450 at (10, 50).
  assert.deepEqual({ ...V.toDesktop({ left: 10, top: 50, width: 800, height: 450 }, 1920, 1080, 410, 275) }, { x: 960, y: 540 });
  // Zoom 2 (1600x900) scrolled 300 right and 100 down: left = 10-300, top = 50-100.
  const r2 = { left: -290, top: -50, width: 1600, height: 900 };
  assert.deepEqual({ ...V.toDesktop(r2, 1920, 1080, 110, 150) }, { x: Math.floor(400 * 1.2), y: Math.floor(200 * 1.2) });
  // Zoom 4 (3200x1800) scrolled 1000 / 700.
  const r4 = { left: -990, top: -650, width: 3200, height: 1800 };
  assert.deepEqual({ ...V.toDesktop(r4, 1920, 1080, 500, 400) }, { x: Math.floor(1490 * 0.6), y: Math.floor(1050 * 0.6) });
});

test('rdView.toDesktop: edges and outside points clamp to 0..size-1', () => {
  const r = { left: 100, top: 100, width: 960, height: 540 };
  assert.deepEqual({ ...V.toDesktop(r, 1920, 1080, 0, 0) }, { x: 0, y: 0 });
  assert.deepEqual({ ...V.toDesktop(r, 1920, 1080, 5000, 5000) }, { x: 1919, y: 1079 });
  assert.deepEqual({ ...V.toDesktop(r, 1920, 1080, 1060, 640) }, { x: 1919, y: 1079 });
  assert.deepEqual({ ...V.toDesktop(r, 1920, 1080, 100, 100) }, { x: 0, y: 0 });
});

test('rdView round trip: toDesktop -> toPage -> SendMouseMsg formula gives the same pixel at every zoom', () => {
  for (const [w, h, left, top] of [[800, 450, 10, 50], [1600, 900, -290, -50], [3200, 1800, -990, -650], [333, 187, 4, 9]]) {
    const rect = { left, top, width: w, height: h };
    for (const [cx, cy] of [[0, 0], [111, 222], [400, 300], [799, 449], [1000, 900]]) {
      const d = V.toDesktop(rect, 1920, 1080, cx, cy);
      const off = [17, 61];
      const p = V.toPage(off, w, h, 1920, 1080, d.x, d.y);
      const m = sendMouseFormula(off, w, h, 1920, 1080, p.pageX, p.pageY);
      assert.equal(Math.floor(m.X), d.x); assert.equal(Math.floor(m.Y), d.y);
      assert.equal(m.X & 0xFF, d.x & 0xFF); assert.equal((m.X / 256) & 0xFF, (d.x >> 8) & 0xFF);
    }
  }
});

test('rdView.fitSize: contain for landscape and portrait views and desktops', () => {
  assert.deepEqual({ ...V.fitSize(800, 600, 1920, 1080) }, { w: 800, h: 450 });
  assert.deepEqual({ ...V.fitSize(390, 700, 1920, 1080) }, { w: 390, h: 219.375 });
  const a = V.fitSize(390, 700, 1080, 1920);   // portrait desktop on a phone: height limits... 390/1080 = .361, 700/1920 = .365
  near(a.w, 390); near(a.h, 390 * 1920 / 1080);
  const b = V.fitSize(1000, 300, 1080, 1920);
  near(b.h, 300); near(b.w, 300 * 1080 / 1920);
  assert.deepEqual({ ...V.fitSize(0, 0, 1920, 1080) }, { w: 0, h: 0 });
});

test('rdView.maxZoom: at least 4, or twice actual size', () => {
  assert.equal(V.maxZoom(1920, 1080, 1920, 1080), 4);
  near(V.maxZoom(390, 700, 1920, 1080), 2 * 1920 / 390);   // 9.85x
  assert.ok(V.maxZoom(390, 700, 1920, 1080) > 4);
});

test('rdView.zoomAbout: the anchor stays fixed, zoom clamps to 1..max, scroll clamps', () => {
  const view = { w: 800, h: 600, fitW: 800, fitH: 450, max: 4 };
  const content = (s, z, ax, ay) => ({ u: (s.scrollLeft + ax - Math.max(0, (800 - 800 * z) / 2)) / (800 * z), v: (s.scrollTop + ay - Math.max(0, (600 - 450 * z) / 2)) / (450 * z) });
  let s = { zoom: 1, scrollLeft: 0, scrollTop: 0 };
  const before = content(s, 1, 600, 300);
  const a = V.zoomAbout(s, 2, 600, 300, view);
  assert.equal(a.zoom, 2);
  const after = content(a, 2, 600, 300);
  near(after.u, before.u); near(after.v, before.v);
  // again from the zoomed state, new anchor
  const b = V.zoomAbout(a, 3, 100, 500, view);
  const cb = content(a, 2, 100, 500), cb2 = content(b, 3, 100, 500);
  near(cb.u, cb2.u); near(cb.v, cb2.v);
  // clamps
  assert.equal(V.zoomAbout(s, 99, 0, 0, view).zoom, 4);
  assert.equal(V.zoomAbout(b, 0.1, 400, 300, view).zoom, 1);
  const z1 = V.zoomAbout(b, 0.1, 400, 300, view);
  assert.equal(z1.scrollLeft, 0); assert.equal(z1.scrollTop, 0);
  const far = V.zoomAbout(s, 4, 800, 600, view);
  assert.equal(far.scrollLeft, 800 * 4 - 800); assert.equal(far.scrollTop, 450 * 4 - 600);
  // pan: same zoom, anchor moves
  const pan = V.zoomAbout(a, 2, 400, 300, view, 300, 300);
  near(pan.scrollLeft, a.scrollLeft + 100);
  // fit size changed (rotation): the centre fraction is kept through oldW/oldH
  const rot = V.zoomAbout({ zoom: 2, scrollLeft: 400, scrollTop: 0 }, 2, 200, 150, { w: 400, h: 300, fitW: 400, fitH: 225, max: 4, oldW: 1600, oldH: 900 });
  near((rot.scrollLeft + 200) / 800, (400 + 200) / 1600);
});

// ---- the page with the real viewer scripts ----
function boot(opts = {}) {
  const dw = 1920, dh = 1080, BAR = 40;
  let VW = opts.vw || 800, VH = opts.vh || 600, roCb = null;
  const docL = {};
  const els = {};
  const sent = [];
  let now = 5000;
  const timers = [];
  const mk = (id) => ({ id, style: {}, textContent: '', disabled: false, value: '', offsetHeight: BAR, listeners: {}, classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(n, f) { (this.listeners[n] = this.listeners[n] || []).push(f); }, setPointerCapture() {}, focus() {}, blur() {} });
  const el = (id) => els[id] || (els[id] = mk(id));
  const scroller = el('scroller'), canvas = el('Desk');
  let sl = 0, st = 0;
  const cw = () => parseFloat(canvas.style.width) || dw, ch = () => parseFloat(canvas.style.height) || dh;
  Object.defineProperty(scroller, 'clientWidth', { get: () => VW });
  Object.defineProperty(scroller, 'clientHeight', { get: () => VH });
  Object.defineProperty(scroller, 'scrollLeft', { get: () => sl, set: (v) => { sl = Math.max(0, Math.min(v, Math.max(0, cw() - VW))); } });
  Object.defineProperty(scroller, 'scrollTop', { get: () => st, set: (v) => { st = Math.max(0, Math.min(v, Math.max(0, ch() - VH))); } });
  Object.defineProperty(scroller, 'scrollWidth', { get: () => Math.max(cw(), VW) });
  Object.defineProperty(scroller, 'scrollHeight', { get: () => Math.max(ch(), VH) });
  scroller.getBoundingClientRect = () => ({ left: 0, top: BAR, width: VW, height: VH });
  canvas.width = dw; canvas.height = dh;
  Object.defineProperty(canvas, 'clientWidth', { get: cw });
  Object.defineProperty(canvas, 'clientHeight', { get: ch });
  canvas.offsetLeft = 17; canvas.offsetTop = 61; canvas.offsetParent = { offsetLeft: 5, offsetTop: 3, offsetParent: null };
  canvas.getBoundingClientRect = () => ({ left: Math.max(0, (VW - cw()) / 2) - sl, top: BAR + Math.max(0, (VH - ch()) / 2) - st, width: cw(), height: ch() });
  canvas.getContext = () => new Proxy({ canvas }, { get: (t, k) => (k in t ? t[k] : () => {}) });
  el('rd-boot').textContent = JSON.stringify({ nodeid: 'n', name: 'pc', until: 9e12, endUrl: '/e' });
  const sandbox = { console, JSON, Math, Number, isNaN, String, Uint8Array, Array, Object, Error, parseInt, parseFloat, isFinite, setInterval() { return 1; }, clearInterval() {},
    Date: { now: () => now }, setTimeout: (f, ms) => { timers.push({ f, ms, live: true }); return timers.length; }, clearTimeout: (i) => { if (timers[i - 1]) timers[i - 1].live = false; },
    navigator: { platform: 'Linux' }, location: { protocol: 'https:', host: 'h', pathname: '/remote-desktop/s/' }, WebSocket: Object.assign(function () { this.readyState = 0; this.close = () => {}; this.send = () => {}; }, { OPEN: 1 }), fetch: () => Promise.resolve({ ok: true }) };
  sandbox.window = sandbox; sandbox.addEventListener = (n, f) => { (el('win').listeners[n] = el('win').listeners[n] || []).push(f); };
  sandbox.ResizeObserver = function (cb) { roCb = cb; this.observe = () => {}; };
  sandbox.document = { getElementById: el, addEventListener(n, f) { (docL[n] = docL[n] || []).push(f); }, querySelector: () => ({ setAttribute() {} }), title: '', activeElement: null, visibilityState: 'visible' };
  vm.createContext(sandbox);
  vm.runInContext(pre, sandbox);
  for (const f of scripts) vm.runInContext(fs.readFileSync(f, 'utf8'), sandbox, { filename: f });
  vm.runInContext(mathSrc, sandbox);
  vm.runInContext(mainSrc, sandbox);
  const d = vm.runInContext('desktop', sandbox);
  d.send = (x) => sent.push(x); d.State = 3; d.m.State = 3;
  const decode = (s) => ({ type: s.charCodeAt(1), len: s.charCodeAt(3), b: s.charCodeAt(5), x: s.charCodeAt(6) * 256 + s.charCodeAt(7), y: s.charCodeAt(8) * 256 + s.charCodeAt(9), dh: s.charCodeAt(10), dl: s.charCodeAt(11) });
  const fire = (target, type, e) => (target.listeners[type] || []).forEach(f => f({ preventDefault() {}, stopPropagation() {}, type, ...e }));
  const ptr = (type, id, x, y) => fire(scroller, type, { pointerType: 'touch', pointerId: id, clientX: x, clientY: y });
  const ptrE = (type, id, x, y, extra) => fire(scroller, type, { pointerType: 'touch', pointerId: id, clientX: x, clientY: y, ...extra });
  const hide = () => { sandbox.document.visibilityState = 'hidden'; (docL.visibilitychange || []).forEach(f => f({})); };
  const setView = (w, h) => { VW = w; VH = h; };
  return { ptrE, hide, setView, ro: () => roCb && roCb(), docL, sandbox, els, sent, d, decode, fire, ptr, scroller, canvas, rect: () => canvas.getBoundingClientRect(), setNow: (n) => { now = n; }, timers, click: (id) => el(id).listeners.click[0](), size: () => [cw(), ch()], scrollPos: () => [sl, st] };
}
const skip = haveScripts ? false : 'MeshCentral viewer scripts are not installed here';

test('page: initial view shows the whole desktop, contained and centred', { skip }, () => {
  const p = boot();
  assert.deepEqual(p.size(), [800, 450]);
  assert.equal(p.rect().top, 40 + 75);
});

test('page + REAL SendMouseMsg: a tap at a known client point sends exactly the expected desktop X,Y at zoom 1 and zoom 2 with a scroll', { skip }, () => {
  const p = boot();
  p.ptr('pointerdown', 1, 400, 40 + 75 + 225); p.ptr('pointerup', 1, 400, 40 + 75 + 225);
  assert.equal(p.sent.length, 3, 'move, down, up');
  assert.deepEqual(p.sent.map(s => [p.decode(s).x, p.decode(s).y]), [[960, 540], [960, 540], [960, 540]]);
  assert.deepEqual(p.sent.map(s => p.decode(s).b), [0, 2, 4]);   // none, LEFT down, LEFT up (2*2)
  // Zoom to 2 about the centre, then scroll right/down by a known amount.
  p.sent.length = 0;
  p.click('zin'); p.click('zin');   // 2.25
  const [w, h] = p.size();
  near(w, 1800); near(h, 1012.5);
  p.scroller.scrollLeft = 300; p.scroller.scrollTop = 100;
  const r = p.rect();
  near(r.left, -300); near(r.top, 40 - 100);
  const cx = 250, cy = 333;
  const ex = Math.floor((cx - r.left) * 1920 / r.width), ey = Math.floor((cy - r.top) * 1080 / r.height);
  p.ptr('pointerdown', 2, cx, cy); p.ptr('pointerup', 2, cx, cy);
  const m = p.sent.map(p.decode);
  assert.equal(m.length, 3);
  for (const x of m) { assert.equal(x.x, ex); assert.equal(x.y, ey); }
  assert.ok(ex > 0 && ex < 1919 && ey > 0 && ey < 1079);
});

test('page + REAL SendMouseMsg: mouse down/up/move/dblclick on the canvas are mapped through the view, edges clamp', { skip }, () => {
  const p = boot();
  p.click('zin'); p.scroller.scrollLeft = 123; p.scroller.scrollTop = 45;
  const r = p.rect();
  const ex = Math.floor((600 - r.left) * 1920 / r.width), ey = Math.floor((300 - r.top) * 1080 / r.height);
  for (const n of ['mousemove', 'mousedown', 'mouseup']) p.fire(p.canvas, n, { clientX: 600, clientY: 300, button: 0, buttons: 1, which: 1 });
  p.fire(p.canvas, 'dblclick', { clientX: 600, clientY: 300, button: 0, buttons: 1, which: 1 });
  const m = p.sent.map(p.decode);
  assert.equal(m.length, 4);
  for (const x of m) { assert.equal(x.x, ex); assert.equal(x.y, ey); }
  assert.equal(m[3].len, 0x0A);
  p.sent.length = 0;
  p.fire(p.canvas, 'mousedown', { clientX: -500, clientY: 9999, button: 0, buttons: 1, which: 1 });
  assert.deepEqual([p.decode(p.sent[0]).x, p.decode(p.sent[0]).y], [0, 1079]);
});

test('page: Zoom in / Zoom out step x1.5 about the view centre, Fit returns to 1, zoom stays within 1..max', { skip }, () => {
  const p = boot();
  p.click('zin'); near(p.size()[0], 1200);
  // the desktop point under the view centre stays under it
  const centreBefore = (cx) => { const r = p.rect(); return (cx - r.left) / r.width; };
  const f = centreBefore(400);
  p.click('zin'); near(centreBefore(400), f, 1e-3);
  p.click('zout'); p.click('zout'); p.click('zout'); near(p.size()[0], 800);
  for (let i = 0; i < 20; i++) p.click('zin');
  near(p.size()[0], 800 * 2 * 1920 / 800);   // twice actual size (4.8x) beats 4x here
  p.click('fit'); near(p.size()[0], 800); assert.deepEqual(p.scrollPos(), [0, 0]);
  assert.equal(p.els.zout.attributes, undefined);
});

test('page: pinch zooms about the midpoint (the desktop point under it stays under it); moving the midpoint pans', { skip }, () => {
  const p = boot();
  const at = (r, x, y) => ({ u: (x - r.left) / r.width, v: (y - r.top) / r.height });
  const mx = 400, my = 340;
  const u0 = at(p.rect(), mx, my);
  p.ptr('pointerdown', 1, mx - 50, my); p.ptr('pointerdown', 2, mx + 50, my);
  p.ptr('pointermove', 1, mx - 100, my); p.ptr('pointermove', 2, mx + 100, my);   // spread x2
  near(p.size()[0], 1600, 1);
  const u1 = at(p.rect(), mx, my);
  near(u1.u, u0.u, 1e-3); near(u1.v, u0.v, 1e-3);
  // move both fingers 80px left: the view pans (content follows the fingers)
  const before = p.rect();
  p.ptr('pointermove', 1, mx - 180, my); p.ptr('pointermove', 2, mx + 20, my);
  near(p.rect().left, before.left - 80, 1);
  assert.equal(p.sent.length, 0, 'a two-finger gesture sends nothing to the PC');
  p.ptr('pointerup', 1, mx - 180, my); p.ptr('pointerup', 2, mx + 20, my);
  assert.equal(p.sent.length, 0);
});

test('page: a second finger during a drag releases the button first, then pinches; no click is sent', { skip }, () => {
  const p = boot();
  p.ptr('pointerdown', 1, 300, 300); p.ptr('pointermove', 1, 340, 330);
  const n = p.sent.length;
  assert.ok(n >= 2, 'drag pressed the button');
  p.ptr('pointerdown', 2, 500, 300);
  const rel = p.sent.slice(n).map(p.decode);
  assert.equal(rel.length, 1); assert.equal(rel[0].b, 4, 'left button released');
  p.ptr('pointermove', 2, 600, 300);
  p.ptr('pointerup', 2, 600, 300); p.ptr('pointerup', 1, 340, 330);
  assert.equal(p.sent.length, n + 1, 'nothing else sent');
  // second finger during a plain press: no click at all
  const q = boot();
  q.ptr('pointerdown', 1, 300, 300); q.ptr('pointerdown', 2, 500, 300);
  q.ptr('pointerup', 2, 500, 300); q.ptr('pointerup', 1, 300, 300);
  assert.equal(q.sent.length, 0);
});

test('page: long press = right click; a two-finger double tap toggles 1x <-> 2x', { skip }, () => {
  const p = boot();
  p.ptr('pointerdown', 1, 400, 300);
  p.timers.filter(t => t.live && t.ms === 600).forEach(t => t.f());
  assert.deepEqual(p.sent.map(s => p.decode(s).b), [8, 16]);   // RIGHT down, RIGHT up
  p.ptr('pointerup', 1, 400, 300);
  assert.equal(p.sent.length, 2);
  const tap2 = (t) => { p.setNow(t); p.ptr('pointerdown', 1, 380, 250); p.ptr('pointerdown', 2, 420, 250); p.setNow(t + 60); p.ptr('pointerup', 1, 380, 250); p.ptr('pointerup', 2, 420, 250); };
  tap2(10000); near(p.size()[0], 800);
  tap2(10150); near(p.size()[0], 1600, 1);
  tap2(11000); near(p.size()[0], 1600, 1);   // too late: counts as a first tap
  tap2(11150); near(p.size()[0], 800, 1);
  assert.equal(p.sent.length, 2);
});

test('page: wheel — Ctrl+wheel zooms about the cursor and is not sent; plain wheel pans when zoomed; at zoom 1 it goes to the PC', { skip }, () => {
  const p = boot();
  const w = (e) => { let prevented = false; p.fire(p.scroller, 'wheel', { clientX: 300, clientY: 200, deltaY: 0, deltaX: 0, deltaMode: 0, preventDefault() { prevented = true; }, ...e }); return prevented; };
  assert.ok(w({ deltaY: 100, wheelDelta: -120 }));
  assert.equal(p.sent.length, 1);
  const m = p.decode(p.sent[0]); assert.equal(m.len, 0x0C);
  assert.equal(m.x, Math.floor((300 - p.rect().left) * 1920 / 800)); assert.equal(m.y, Math.floor((200 - p.rect().top) * 1080 / 450));
  const u0 = (300 - p.rect().left) / p.rect().width;
  assert.ok(w({ ctrlKey: true, deltaY: -30 }));
  for (let i = 0; i < 4; i++) w({ ctrlKey: true, deltaY: -30 });   // smooth steps: zoomed far enough that the view scrolls on both axes
  assert.equal(p.sent.length, 1, 'ctrl+wheel not sent');
  assert.ok(p.size()[0] > 800);
  near((300 - p.rect().left) / p.rect().width, u0, 1e-3);
  const left = p.rect().left, top = p.rect().top;
  assert.ok(w({ deltaY: 40, deltaX: 25 }));
  assert.equal(p.sent.length, 1, 'plain wheel pans when zoomed, not sent');
  near(p.rect().left, left - 25, 1e-6); near(p.rect().top, top - 40, 1e-6);
});

test('page: re-fit on resize keeps the point under the view centre; a remote screen change refits', { skip }, () => {
  const p = boot();
  p.click('zin'); p.click('zin'); p.scroller.scrollLeft = 200;
  const r = p.rect();
  const f = (400 - r.left) / r.width;
  p.d.m.onScreenSizeChange(p.d.m, 1920, 1080);
  near((400 - p.rect().left) / p.rect().width, f, 1e-3);
  p.canvas.width = 1280; p.canvas.height = 1024;   // the remote screen changed shape
  p.d.m.onScreenSizeChange(p.d.m, 1280, 1024);
  const [w, h] = p.size();
  near(w / h, 1280 / 1024, 1e-3);
  near((400 - p.rect().left) / p.rect().width, f, 1e-3);
  (p.els.win.listeners.resize || []).forEach(g => g());
  (p.els.win.listeners.orientationchange || []).forEach(g => g());
  near((400 - p.rect().left) / p.rect().width, f, 1e-3);
});

test('page text: bar buttons, viewport lock, touch-action, no inline handlers, line budget', () => {
  assert.match(viewer, /id="zout"[^>]*aria-label="Zoom out"[^>]*>−</);
  assert.match(viewer, /id="zin"[^>]*aria-label="Zoom in"[^>]*>\+</);
  assert.match(viewer, /id="fit"[^>]*>Fit</);
  assert.match(viewer, /user-scalable=no, maximum-scale=1|maximum-scale=1, user-scalable=no/);
  assert.match(viewer, /#scroller \{[^}]*touch-action: none/);
  assert.match(viewer, /#Desk \{[^}]*touch-action: none/);
  assert.match(viewer, /\{ passive: false \}/);
  assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(viewer));
  assert.ok(viewer.split('\n').length < 500);
  assert.ok(viewer.indexOf('var rdView') < viewer.indexOf('<script>\n(function'));
});

// ---- review r1 fixes ----
const bandY = 40 + 20, canvasY = 40 + 75 + 225, lowBandY = 40 + 75 + 450 + 30;   // black band above, the canvas middle, the band below (zoom 1, 800x600 view)
const noMouse = (p) => assert.equal(p.sent.length, 0, 'nothing is sent to the PC');
const fireTimers = (p) => p.timers.filter(t => t.live && t.ms === 600).forEach(t => t.f());

test('page: a pinch with the first finger in the black band and the second on the canvas zooms and sends no mouse message', { skip }, () => {
  const p = boot();
  p.ptr('pointerdown', 1, 300, bandY); p.ptr('pointerdown', 2, 500, canvasY);
  fireTimers(p);
  p.ptr('pointermove', 2, 700, canvasY + 100);
  assert.ok(p.size()[0] > 900, 'zoomed');
  p.ptr('pointerup', 2, 700, canvasY + 100); p.ptr('pointerup', 1, 300, bandY);
  noMouse(p);
});

test('page: a pinch with the first finger on the canvas and the second in the band zooms and sends no mouse message', { skip }, () => {
  const p = boot();
  p.ptr('pointerdown', 1, 300, canvasY); p.ptr('pointerdown', 2, 500, lowBandY);
  fireTimers(p);
  p.ptr('pointermove', 2, 700, lowBandY + 50);
  assert.ok(p.size()[0] > 900, 'zoomed');
  p.ptr('pointerup', 1, 300, canvasY); p.ptr('pointerup', 2, 700, lowBandY + 50);
  noMouse(p);
});

test('page: a pinch with both fingers in the bands zooms at zoom 1; a lone finger in a band does nothing', { skip }, () => {
  const p = boot();
  p.ptr('pointerdown', 1, 300, bandY); p.ptr('pointerdown', 2, 500, lowBandY);
  p.ptr('pointermove', 2, 700, lowBandY + 60); p.ptr('pointermove', 1, 100, bandY - 10);
  assert.ok(p.size()[0] > 900, 'zoomed');
  p.ptr('pointerup', 1, 100, bandY); p.ptr('pointerup', 2, 700, lowBandY);
  noMouse(p);
  p.click('fit');
  p.ptr('pointerdown', 3, 300, bandY); fireTimers(p); p.ptr('pointermove', 3, 400, bandY + 5); p.ptr('pointerup', 3, 400, bandY);
  noMouse(p);
});

test('page: a new primary finger ends ghost pointers: a held button is released and the old state is cleared', { skip }, () => {
  const p = boot();
  p.ptr('pointerdown', 1, 300, 300); p.ptr('pointermove', 1, 340, 330);
  const n = p.sent.length;
  p.ptrE('pointerdown', 7, 400, canvasY, { isPrimary: true });
  const rel = p.sent.slice(n).map(p.decode);
  assert.deepEqual(rel.map(x => x.b), [4], 'LEFT released by the ghost cleanup');
  p.sent.length = 0;
  p.ptr('pointerup', 7, 400, canvasY);
  assert.equal(p.sent.length, 3, 'the new finger is a normal tap');
  p.sent.length = 0;
  // an old finger whose up never came would make the next finger a "second finger"; a primary down starts clean
  p.ptr('pointerdown', 8, 300, 300);
  p.ptrE('pointerdown', 9, 400, canvasY, { isPrimary: true }); p.ptr('pointerup', 9, 400, canvasY);
  assert.equal(p.sent.length, 3);
  assert.equal(p.size()[0], 800, 'no pinch started');
});

test('page: hidden page, window blur and lost pointer capture release the held button; hidden/blur also release held keys', { skip }, () => {
  const drag = (p) => { p.ptr('pointerdown', 1, 300, 300); p.ptr('pointermove', 1, 340, 330); const n = p.sent.length; p.sent.length = 0; return n; };
  let p = boot(); let rel = 0; p.d.m.handleReleaseKeys = () => { rel++; };
  drag(p); p.hide();
  assert.deepEqual(p.sent.map(s => p.decode(s).b), [4]); assert.equal(rel, 1);
  p.sent.length = 0; p.ptr('pointerup', 1, 340, 330); assert.equal(p.sent.length, 0, 'the finger is forgotten');
  p = boot(); rel = 0; p.d.m.handleReleaseKeys = () => { rel++; };
  drag(p); p.fire(p.els.win, 'blur', {});
  assert.deepEqual(p.sent.map(s => p.decode(s).b), [4]); assert.equal(rel, 1);
  p = boot();
  drag(p); p.ptr('lostpointercapture', 1, 340, 330);
  assert.deepEqual(p.sent.map(s => p.decode(s).b), [4]);
  p.sent.length = 0; p.ptr('pointerup', 1, 340, 330); p.ptr('lostpointercapture', 1, 340, 330);
  assert.equal(p.sent.length, 0, 'no click from the late up');
  // a plain tap: the capture release that follows pointerup does nothing
  { const q = boot(); q.ptr('pointerdown', 1, 300, 300); q.fire(q.scroller, 'lostpointercapture', { pointerType: 'touch', pointerId: 1, clientX: 300, clientY: 300, target: { id: 'Desk' } }); q.ptr('pointermove', 1, 360, 300); assert.ok(q.sent.length > 0, 'a lostpointercapture bubbling from the canvas does not end the finger: the drag still runs'); }
  p = boot(); p.ptr('pointerdown', 1, 300, 300); p.ptr('pointerup', 1, 300, 300); p.ptr('lostpointercapture', 1, 300, 300);
  assert.equal(p.sent.length, 3);
});

test('page: a real viewport size change (800x400 -> 400x800) keeps the desktop pixel at the view centre, at zoom 1 and zoomed', { skip }, () => {
  for (const zin of [0, 4]) {   // 4 clicks: zoomed enough to fill the narrow view on both axes, so the centre pixel can be kept
    const p = boot({ vw: 800, vh: 400 });
    for (let i = 0; i < zin; i++) p.click('zin');
    if (zin) { p.scroller.scrollLeft = 1000; p.scroller.scrollTop = 800; }
    const px = () => { const r = p.rect(); return [(p.scroller.getBoundingClientRect().left + p.scroller.clientWidth / 2 - r.left) * 1920 / r.width, (p.scroller.getBoundingClientRect().top + p.scroller.clientHeight / 2 - r.top) * 1080 / r.height]; };
    const before = px();
    p.setView(400, 800);
    (p.els.win.listeners.resize || []).forEach(g => g());
    const after = px();
    assert.ok(Math.abs(after[0] - before[0]) <= 1 && Math.abs(after[1] - before[1]) <= 1, `zin=${zin}: ${before} -> ${after}`);
    assert.equal(p.sent.length, 0);
  }
});

test('page: wheel on the scroller — Ctrl+wheel over the black band zooms, a plain wheel there never reaches the PC; small steps leave Fit, near 1 on the way out snaps, a mouse notch is 1.15x', { skip }, () => {
  const p = boot();
  const w = (e) => { let prevented = false; p.fire(p.scroller, 'wheel', { clientX: 300, clientY: canvasY, deltaY: 0, deltaX: 0, deltaMode: 0, preventDefault() { prevented = true; }, ...e }); return prevented; };
  assert.ok(w({ ctrlKey: true, clientY: bandY, deltaY: -50 }));
  assert.ok(p.size()[0] > 800, 'zoomed from the band');
  assert.equal(p.sent.length, 0);
  p.click('fit');
  assert.ok(w({ clientY: bandY, deltaY: 100, wheelDelta: -120 }));
  assert.equal(p.sent.length, 0, 'plain wheel over the band is not sent');
  assert.ok(w({ clientY: canvasY, deltaY: 100, wheelDelta: -120 }));
  assert.equal(p.sent.length, 1, 'over the canvas with nothing to scroll it goes to the PC');
  // small trackpad steps must leave Fit (no snap on the way in): 100 events of deltaY -3 zoom in well past 1.5x
  for (let i = 0; i < 100; i++) w({ ctrlKey: true, deltaY: -3 });
  assert.ok(p.size()[0] > 1200, 'repeated small steps zoom in');
  // on the way back out, close to 1 snaps to exactly 1
  p.click('fit'); w({ ctrlKey: true, deltaY: -5 }); assert.ok(p.size()[0] > 800);
  w({ ctrlKey: true, deltaY: 4.9 }); assert.equal(p.size()[0], 800, 'zooming out near 1 snaps to Fit');
  // a mouse notch (line mode, or a pixel step of 40 or more) is one step of 1.15x
  w({ ctrlKey: true, deltaY: -1, deltaMode: 1 }); assert.ok(Math.abs(p.size()[0] - 920) < 1, 'line-mode notch: 1.15x');
  p.click('fit'); w({ ctrlKey: true, deltaY: -100 }); assert.ok(Math.abs(p.size()[0] - 920) < 1, 'a 100 px notch: 1.15x, not 1.8x');
  // the view can scroll in one direction only: still a pan, not the PC
  p.click('fit'); p.sent.length = 0;
  p.setView(800, 450); p.click('zin');
  assert.ok(p.scroller.scrollWidth > p.scroller.clientWidth);
  w({ deltaY: 30 }); assert.equal(p.sent.length, 0);
});

test('page: Safari gesture events zoom about the gesture point by scale relative to the start; the pointer pinch does not double it', { skip }, () => {
  const p = boot();
  let prevented = 0;
  const g = (n, e) => p.fire(p.scroller, n, { preventDefault() { prevented++; }, clientX: 400, clientY: 40 + 300, ...e });
  const u0 = (400 - p.rect().left) / p.rect().width;
  g('gesturestart', { scale: 1 });
  g('gesturechange', { scale: 2 });
  near(p.size()[0], 1600, 1);
  near((400 - p.rect().left) / p.rect().width, u0, 1e-3);
  g('gesturechange', { scale: 1.5 }); near(p.size()[0], 1200, 1);
  g('gestureend', { scale: 1.5 });
  assert.equal(prevented, 4);
  // with the pointer pinch running at the same time, only the gesture zooms
  const q = boot();
  q.ptr('pointerdown', 1, 300, 300); q.ptr('pointerdown', 2, 500, 300);
  q.fire(q.scroller, 'gesturestart', { scale: 1, clientX: 400, clientY: 340 });
  q.ptr('pointermove', 2, 700, 300);
  near(q.size()[0], 800, 1e-6);
  q.fire(q.scroller, 'gesturechange', { scale: 2, clientX: 400, clientY: 340 });
  near(q.size()[0], 1600, 1);
  assert.equal(q.sent.length, 0);
});

test('page: the scroller follows the bar height (ResizeObserver on #bar)', { skip }, () => {
  const p = boot();
  assert.equal(p.scroller.style.top, '40px');
  p.els.bar.offsetHeight = 92; p.ro();
  assert.equal(p.scroller.style.top, '92px');
  p.els.bar.offsetHeight = 40; p.ro();
  assert.equal(p.scroller.style.top, '40px');
});

test('page text: iOS and mouse-user CSS (touch-action on body, no callout, scrollbars for fine pointers)', () => {
  assert.match(viewer, /body \{ touch-action: manipulation; \}/);
  assert.match(viewer, /#scroller \{[^}]*-webkit-touch-callout: none/);
  assert.match(viewer, /#Desk \{[^}]*-webkit-touch-callout: none/);
  assert.match(viewer, /#scroller \{[^}]*scrollbar-width: none/);
  assert.match(viewer, /@media \(pointer: fine\) \{[^}]*scrollbar-width: auto[^}]*\}[^}]*::-webkit-scrollbar \{ display: block/);
  assert.match(viewer, /gesturestart/); assert.match(viewer, /lostpointercapture/); assert.match(viewer, /visibilitychange/);
});

test('page: wheel — a Windows display-scaled notch (|deltaY| 40..100, e.g. 66 or 80) is one 1.15x step, never about 2x; trackpad steps stay smooth', { skip }, () => {
  const p = boot();
  const w = (e) => p.fire(p.scroller, 'wheel', { clientX: 300, clientY: canvasY, deltaY: 0, deltaX: 0, deltaMode: 0, ctrlKey: true, preventDefault() {}, ...e });
  for (const dy of [-66, -80, -40, -99]) { p.click('fit'); w({ deltaY: dy }); assert.ok(Math.abs(p.size()[0] - 920) < 1, `deltaY ${dy}: one 1.15x step, got ${p.size()[0] / 800}`); }
  for (const dy of [66, 80]) { p.click('fit'); w({ deltaY: -100 }); const z = p.size()[0]; w({ deltaY: dy }); assert.ok(Math.abs(z / p.size()[0] - 1.15) < 0.01, `deltaY ${dy}: one step out`); }
  // trackpad: -3 is exp(0.03) about 1.03 per event, -39 is still smooth (exp(0.39)), not a notch
  p.click('fit'); w({ deltaY: -3 }); assert.ok(Math.abs(p.size()[0] / 800 - Math.exp(0.03)) < 0.005, 'a small step zooms smoothly');
  p.click('fit'); w({ deltaY: -39 }); assert.ok(Math.abs(p.size()[0] / 800 - Math.exp(0.39)) < 0.01, '39 is the last smooth step');
  assert.match(viewer, /Math\.exp\(-Math\.max\(-40, Math\.min\(40, dy\)\) \* 0\.01\)/, 'the smooth branch is clamped to 40');
  assert.equal(p.sent.length, 0);
});
