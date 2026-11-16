/**
 * ui-phone-layout.js — a phone opens the phone layout, in a browser tab and in an installed app, whichever page it was installed from.
 *
 * A phone that used Add to Home Screen while on "/" (for example Safari's "Request Desktop Website", whose user agent
 * says Macintosh and whose window is about 980 px wide) has an installed app that always opens the desktop layout.
 * This script is loaded first in index.html's <head>: on a phone-sized touch screen (browser tab or installed app, the
 * standalone mode is only reported, it does not gate the move) it moves to /mobile at once, before the layout draws.
 * Tablets and an unfolded Fold (short side 600 px or more) keep the full site.
 *
 * "Phone" is decided by the SCREEN (its short side is under 600 px and the device has touch, and its main pointer is not
 * a mouse or trackpad), never by the user agent or the window width, because both of those are exactly what "request
 * desktop site" changes. A link to one of the computer layout's own panels (?memory=1, ?connectors=1, ?backups=1)
 * stays on the computer layout, with the bar.
 *
 * Ways to stay on the computer layout: "/?desktop=1" once remembers it on this device (localStorage; the phone page's
 * "Use the full site" does this), "/?desktop=0" forgets it, "/?desktop=once" shows the desktop layout for this visit only (the phone page's "Full UI" links use it).
 * A move is not repeated within 30 s (sessionStorage) so a page that bounces back cannot loop.
 *
 * Functions:
 *   isPhoneScreen(info)          true for a touch device whose screen's short side is under 600 px (not a fine main pointer)
 *   desktopOnlyLink(search)      true when the address opens a computer-layout panel the phone page lacks
 *   desktopParam(search)         the "desktop" query parameter: '1' | '0' | 'once' | null
 *   phoneLayoutDecision(info)    { phone, keepDesktop, standalone, move, offer } from the screen, mode, stored choice and parameter
 *   phoneLayoutTarget(search, hash)  "/mobile" plus the other query parameters and the hash
 *   startPhoneLayout(win)        the browser part: reads the window, decides, moves; sets win.hubPhoneLayout; runs once
 *
 * Loaded in a page it runs by itself; required from Node (tests) it only exports the functions. Everything sits inside
 * one function so no name reaches the page's shared global scope (a clash there would stop app.js from loading).
 */
(function () {
'use strict';

const PHONE_MAX_SHORT_SIDE = 600;
const KEEP_DESKTOP_KEY = 'hub-keep-desktop';
const MOVED_AT_KEY = 'hub-phone-moved-at';
const MOVE_GUARD_MS = 30000;

function isPhoneScreen(info) {
  const i = info || {};
  const w = i.screenWidth, h = i.screenHeight;
  if (typeof w !== 'number' || typeof h !== 'number' || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return false;
  if (Math.min(w, h) >= PHONE_MAX_SHORT_SIDE) return false;
  // A touchscreen computer's main pointer is a mouse or trackpad (pointer: fine), even when high display scaling makes
  // its screen look small; a phone's is the finger (pointer: coarse).
  if (i.finePointer === true && i.coarsePointer !== true) return false;
  return Number(i.maxTouchPoints) > 0 || i.coarsePointer === true;
}

// Links to the computer layout's own panels, which the phone page does not have (notifications and in-page links
// open them: memory health, data connector access, backups). A phone opening one stays on the computer layout.
const DESKTOP_ONLY_PARAMS = ['memory', 'connectors', 'backups'];

function desktopOnlyLink(search) {
  try {
    const p = new URLSearchParams(search || '');
    return DESKTOP_ONLY_PARAMS.some(k => p.get(k) === '1');
  } catch (e) { return false; }
}

function desktopParam(search) {
  let v = null;
  try { v = new URLSearchParams(search || '').get('desktop'); } catch (e) { return null; }
  return v === '1' || v === '0' || v === 'once' ? v : null;
}

function phoneLayoutDecision(info) {
  const i = info || {};
  const phone = isPhoneScreen(i);
  const keepDesktop = i.param === '1' ? true : i.param === '0' ? false : !!i.keepDesktop;
  const recentlyMoved = Number.isFinite(i.movedAt) && Number.isFinite(i.now) && i.now >= i.movedAt && i.now - i.movedAt < MOVE_GUARD_MS;
  const standalone = i.standalone === true;
  const move = phone && !keepDesktop && i.param !== 'once' && i.desktopLink !== true && !recentlyMoved;
  const offer = phone && !move;
  return { phone, keepDesktop, standalone, move, offer };
}

function phoneLayoutTarget(search, hash) {
  let rest = '';
  let h = hash || '';
  try {
    const p = new URLSearchParams(search || '');
    p.delete('desktop');
    // "/?agent=<name>" (a notification tapped in an app installed from "/": sw.js desktopTarget) is "#chat=<name>" on
    // the phone page.
    const agent = p.get('agent');
    if (agent && !h) { p.delete('agent'); h = '#chat=' + encodeURIComponent(agent); }
    rest = p.toString();
  } catch (e) { rest = ''; }
  return '/mobile' + (rest ? '?' + rest : '') + h;
}

function startPhoneLayout(win) {
  if (win.hubPhoneLayout) return win.hubPhoneLayout;
  let screenWidth, screenHeight, maxTouchPoints = 0, coarsePointer = false, finePointer = false, standalone = false;
  let keepDesktop = false, movedAt = null, param = null, desktopLink = false;
  const now = Date.now();
  try { screenWidth = win.screen.width; screenHeight = win.screen.height; } catch (e) { /* unknown screen: not a phone */ }
  try { maxTouchPoints = win.navigator.maxTouchPoints; } catch (e) { /* none */ }
  try { coarsePointer = win.matchMedia('(pointer: coarse)').matches === true; } catch (e) { /* none */ }
  try { finePointer = win.matchMedia('(pointer: fine)').matches === true; } catch (e) { /* none */ }
  try { standalone = win.matchMedia('(display-mode: standalone)').matches === true || win.navigator.standalone === true; } catch (e) { /* none */ }
  try { keepDesktop = win.localStorage.getItem(KEEP_DESKTOP_KEY) === '1'; } catch (e) { /* none */ }
  try {
    const raw = win.sessionStorage.getItem(MOVED_AT_KEY);
    movedAt = raw === null || raw === undefined || raw === '' ? null : Number(raw);
  } catch (e) { /* none */ }
  try { param = desktopParam(win.location.search); } catch (e) { /* none */ }
  try { desktopLink = desktopOnlyLink(win.location.search); } catch (e) { /* none */ }

  const d = phoneLayoutDecision({ screenWidth, screenHeight, maxTouchPoints, coarsePointer, finePointer, standalone, keepDesktop, param, desktopLink, movedAt, now });

  try { if (param === '1') win.localStorage.setItem(KEEP_DESKTOP_KEY, '1'); } catch (e) { /* none */ }
  try { if (param === '0') win.localStorage.removeItem(KEEP_DESKTOP_KEY); } catch (e) { /* none */ }

  if (param !== null && !d.move) {
    try {
      const p = new URLSearchParams(win.location.search);
      p.delete('desktop');
      const q = p.toString();
      win.history.replaceState(win.history.state, '', win.location.pathname + (q ? '?' + q : '') + (win.location.hash || ''));
    } catch (e) { /* the address keeps the parameter */ }
  }

  let moving = d.move;
  if (moving) {
    try { win.sessionStorage.setItem(MOVED_AT_KEY, String(now)); } catch (e) { /* none */ }
    try {
      win.document.documentElement.style.visibility = 'hidden';
      win.setTimeout(() => { win.document.documentElement.style.visibility = ''; }, 5000);
    } catch (e) { /* none */ }
    try {
      win.location.replace(phoneLayoutTarget(win.location.search, win.location.hash));
    } catch (e) {
      // The move failed: show the desktop page as it is, with the bar offering the phone layout.
      moving = false;
      try { win.document.documentElement.style.visibility = ''; } catch (e2) { /* none */ }
    }
  }

  win.hubPhoneLayout = { phone: d.phone, keepDesktop: d.keepDesktop, standalone: d.standalone, moving, offer: d.offer || (d.move && !moving) };
  return win.hubPhoneLayout;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PHONE_MAX_SHORT_SIDE, KEEP_DESKTOP_KEY, MOVED_AT_KEY, MOVE_GUARD_MS, DESKTOP_ONLY_PARAMS, isPhoneScreen, desktopOnlyLink, desktopParam, phoneLayoutDecision, phoneLayoutTarget, startPhoneLayout };
}
if (typeof window !== 'undefined' && typeof document !== 'undefined') startPhoneLayout(window);
})();
