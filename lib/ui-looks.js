/**
 * ui-looks.js — the look registry and the early loader (shared by every page).
 *
 * A "look" is how the app is dressed on one device: Engineering (today's look, the default, no stylesheet) or a stylesheet
 * /looks/<id>.css scoped to html[data-look="<id>"]. Adding a look = one CSS file under looks/ plus one entry in LOOKS.
 * Simple mode (me.theme light/dark/auto) is a separate switch; under a light look the look's own palette decides the colours
 * (the account's theme stays stored and applies again in Engineering).
 *
 *   LOOKS                         [{ id, label, blurb, css, preview: { bg, panel, ink, accent, font } }], Engineering first
 *   STORE_KEY 'mmLook'            this device's choice (localStorage)
 *   DEFAULT_KEY 'mmLookDefault'   the person's default (from the server), cached on the device
 *   byId(id)                      the entry or null
 *   resolve({ choice, personDefault })  a valid id: the choice, else the person's default, else 'engineering'
 *   current(storage)              the id in force on this device (blocked storage -> 'engineering')
 *   choose(id, storage)           remembers the choice on this device; an unknown id is refused (returns null)
 *   apply(doc, id, opts)          sets <html data-look>, adds/replaces/removes <link id="mm-look-css">; returns the id.
 *                                 opts.parsing (the loader only): while the page is still parsing, the link is written into
 *                                 the head by the parser, so it holds the first paint until the look's colours are in.
 *                                 When the look in force changes (and only then; browser only) it dispatches
 *                                 'mm-look-change' on the document, detail { id }, so a page can repaint what depends on it.
 *   applied(doc)                  the look in force on the page (<html data-look>), else 'engineering'
 *   storageOf(win)                win.localStorage, or null when reading it throws (blocked storage)
 *   rememberDefault(id, storage)  the person's default from the server: a valid id is cached and applied when this device
 *                                 has no choice of its own; none (an account without one) clears the cache, so a shared
 *                                 browser never keeps the last person's default. Returns the look in force afterwards.
 *
 *   singleSetLine(id)             'Engineering is always dark' / 'Broadsheet House is always light'; null for a look with both (sets: 'dark'|'light'|'both')
 *   applyCachedTheme(doc, win, storage)  early loader: the cached account theme (mmTheme) -> html.mm-light / mm-dark
 *   stopThemeListener()           removes the loader's device listener for 'auto' (hubSimple.apply calls it first)
 *   forgetTheme(storage)          clears mmTheme (sign-out); hubSimple.apply clears/overwrites it on every account load
 *
 * Loaded in <head> before the first <style>: it applies the stored look at once, so the page is never painted in the
 * wrong look. Browser: window.HubLooks. Node (tests): module.exports.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) {
    root.HubLooks = api;
    const store = api.storageOf(root);   // blocked storage: null, Engineering
    try { api.apply(root.document, api.current(store), { parsing: true }); } catch { /* no document: stay as is */ }
    try { api.applyCachedTheme(root.document, root, store); } catch { /* blocked storage: no theme classes, as before */ }
  }
})(typeof window !== 'undefined' ? window : null, function () {
  const STORE_KEY = 'mmLook';
  const DEFAULT_KEY = 'mmLookDefault';
  const LINK_ID = 'mm-look-css';
  const FALLBACK = 'engineering';
  const THEME_KEY = 'mmTheme';

  const LOOKS = [
    { id: 'engineering', label: 'Engineering', blurb: 'Dark, dense, built for long sessions (the original interface style).', css: null, sets: 'dark',
      preview: { bg: '#090B0F', panel: '#14171F', ink: '#F3F4F6', accent: '#3D7BFF', font: 'sans' } },
    { id: 'broadsheet', label: 'Broadsheet House', blurb: 'Warm paper, dark ink, serif headings, replies as plain writing.', css: '/looks/broadsheet.css', sets: 'light',
      preview: { bg: '#F4EFE6', panel: '#FBF8F2', ink: '#1F1B16', accent: '#9E1B1B', font: 'serif' } },
    { id: 'quiet', label: 'Quiet Page', blurb: 'A calm notebook, light or dark.', css: '/looks/quiet.css', sets: 'both',
      preview: { bg: '#FBF9F4', panel: '#FFFFFF', ink: '#2A2722', accent: '#3E6B4F', font: 'sans' } },
  ];

  function byId(id) {
    if (typeof id !== 'string') return null;
    return LOOKS.find(l => l.id === id) || null;
  }

  function resolve(o) {
    const x = o || {};
    if (byId(x.choice)) return x.choice;
    if (byId(x.personDefault)) return x.personDefault;
    return FALLBACK;
  }

  function read(storage, key) {
    try { const v = storage && storage.getItem(key); return typeof v === 'string' ? v : null; } catch { return null; }
  }

  function current(storage) {
    return resolve({ choice: read(storage, STORE_KEY), personDefault: read(storage, DEFAULT_KEY) });
  }

  function choose(id, storage) {
    if (!byId(id)) return null;
    try { if (storage) storage.setItem(STORE_KEY, id); } catch { /* blocked: applies for this page only */ }
    return id;
  }

  function storageOf(win) {
    try { return (win && win.localStorage) || null; } catch { return null; }
  }

  function applied(doc) {
    try { const v = doc && doc.documentElement && doc.documentElement.dataset.look; return byId(v) ? v : FALLBACK; } catch { return FALLBACK; }
  }

  function apply(doc, id, opts) {
    const before = applied(doc);
    const got = applyLook(doc, id, opts);
    // Pages repaint what depends on the style (Simple's settings sheet): fired after the look has changed, never when it stays.
    if (doc && doc.documentElement && before !== got && typeof doc.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      try { doc.dispatchEvent(new CustomEvent('mm-look-change', { detail: { id: got } })); } catch { /* a listener must not undo the change */ }
    }
    return got;
  }

  function applyLook(doc, id, opts) {
    const look = byId(id) || byId(FALLBACK);
    if (!doc || !doc.documentElement) return look.id;
    doc.documentElement.dataset.look = look.id;
    const head = doc.head || doc.getElementsByTagName('head')[0] || doc.documentElement;
    const old = doc.getElementById ? doc.getElementById(LINK_ID) : null;
    if (!look.css) {
      if (old && old.parentNode) old.parentNode.removeChild(old);
      return look.id;
    }
    if (old && old.getAttribute('href') === look.css) return look.id;
    if (old && old.parentNode) old.parentNode.removeChild(old);
    if (opts && opts.parsing && doc.readyState === 'loading' && typeof doc.write === 'function') {
      // A parser-inserted stylesheet in <head> blocks rendering (a script-inserted one does not): no flash of Engineering.
      // look.css comes from the registry above, never from storage.
      doc.write('<link rel="stylesheet" id="' + LINK_ID + '" href="' + look.css + '">');
      return look.id;
    }
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.id = LINK_ID;
    link.href = look.css;
    head.appendChild(link);
    return look.id;
  }

  /** The server's default for this person (none = Engineering): cached, and shown at once when this device has no choice
   *  of its own. Called on every account load, so an account without a default clears the one the last person left. */
  function rememberDefault(id, storage, doc) {
    const valid = byId(id) ? id : null;
    try {
      if (storage) { if (valid) storage.setItem(DEFAULT_KEY, valid); else if (storage.removeItem) storage.removeItem(DEFAULT_KEY); }
    } catch { /* blocked: this page still shows the right look below */ }
    const d = doc || (typeof document !== 'undefined' ? document : null);
    const own = read(storage, STORE_KEY);
    const inForce = byId(own) ? own : (valid || FALLBACK);   // this device's own choice wins over any default
    if (d && !byId(own)) apply(d, inForce);
    return inForce;
  }

  /** Before first paint: this device's copy of the account theme ('light' | 'dark' | 'auto', written by hubSimple.apply)
   *  becomes html.mm-light or html.mm-dark; hubSimple.apply takes over once the account is known. Nothing cached or
   *  blocked storage: no class (the page as before). Returns 'light' | 'dark' | null. */
  let stopTheme = null;   // removes the early loader's prefers-color-scheme listener
  /** Drops the early loader's device listener; hubSimple.apply calls it first, so the account's own listener is the only one. */
  function stopThemeListener() { if (stopTheme) { try { stopTheme(); } catch { /* already gone */ } stopTheme = null; } }

  function applyCachedTheme(doc, win, storage) {
    stopThemeListener();
    const v = read(storage, THEME_KEY);
    const cl = doc && doc.documentElement && doc.documentElement.classList;
    if (!cl || (v !== 'light' && v !== 'dark' && v !== 'auto')) return null;
    let mq = null;
    if (v === 'auto') { try { mq = win && typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-color-scheme: dark)') : null; } catch { mq = null; } }
    const paint = (dark) => { if (dark) { cl.add('mm-dark'); cl.remove('mm-light'); } else { cl.add('mm-light'); cl.remove('mm-dark'); } return dark ? 'dark' : 'light'; };
    const now = () => { try { return !!(mq && mq.matches); } catch { return false; } };
    const got = paint(v === 'dark' || (v === 'auto' && now()));
    // A page without ui-simple.js (login, agent settings) keeps following the device while it is open.
    if (mq) {
      const on = () => { paint(now()); };
      if (typeof mq.addEventListener === 'function') { mq.addEventListener('change', on); stopTheme = () => mq.removeEventListener('change', on); }
      else if (typeof mq.addListener === 'function') { mq.addListener(on); stopTheme = () => mq.removeListener(on); }
    }
    return got;
  }

  /** The one line under Appearance when the look has a single colour set ('Engineering is always dark'); null when it has both. */
  function singleSetLine(id) {
    const look = byId(id);
    return look && (look.sets === 'dark' || look.sets === 'light') ? look.label + ' is always ' + look.sets : null;
  }

  /** Sign-out: forget the cached theme (the next person's account load writes their own). */
  function forgetTheme(storage) { try { if (storage && storage.removeItem) storage.removeItem(THEME_KEY); } catch { /* blocked */ } }

  return { LOOKS, THEME_KEY, singleSetLine, applyCachedTheme, stopThemeListener, forgetTheme, STORE_KEY, DEFAULT_KEY, LINK_ID, byId, resolve, current, choose, apply, applied, storageOf, rememberDefault };
});
