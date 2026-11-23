/**
 * ui-agent-dot.js — the one helper that decides an agent's dot and the words around it (shared by the pages).
 *
 * dotState({ busy, question, background })  'question' | 'busy' | 'background' | 'free' (question > busy > background > free;
 *                                           background means a number above 0)
 * dotLabel(state, { background, name })     the accessible text of the dot
 * bgLine(n)                                 "Free · 2 things in the background" (the blue line under a name)
 * CLASS                                     { background: 'bg-work' }
 * applyDot(el, state, { background, name }) sets/removes class bg-work and the title / aria-label; never touches other classes
 * headerCount({ working, workers, background }) -> { text, busyPart, bgPart } for the header count
 * phoneChip(names)                          "Hazel, Forge: background work" ('' when none)
 *
 * No DOM access at load. Browser: window.AgentDot. Node (tests): module.exports.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.AgentDot = api;
})(typeof window !== 'undefined' ? window : null, function () {
  const CLASS = { background: 'bg-work' };
  const num = (n) => { const v = Number(n); return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0; };
  const things = (n) => (n === 1 ? '1 thing' : n + ' things');

  const PREV_TITLE = 'data-bg-prev-title', PREV_ARIA = 'data-bg-prev-aria';
  const SET_TITLE = 'data-bg-set-title', SET_ARIA = 'data-bg-set-aria';   // the label applyDot last wrote
  const NONE = '␀none';   // the element had no such attribute
  const hasAttr = (el, k) => { const v = el.getAttribute(k); return v !== null && v !== undefined; };

  function dotState({ busy, question, background } = {}) {
    if (question) return 'question';
    if (busy) return 'busy';
    return num(background) > 0 ? 'background' : 'free';
  }

  function dotLabel(state, { background } = {}) {
    if (state === 'question') return 'Waiting for your answer';
    if (state === 'busy') return 'Replying';
    if (state === 'background') {
      const n = num(background);
      return n > 0 ? 'Free to talk · ' + things(n) + ' running in the background' : 'Free to talk';
    }
    return 'Free to talk';
  }

  function bgLine(n) { return 'Free · ' + things(num(n)) + ' in the background'; }

  function applyDot(el, state, opts = {}) {
    if (!el) return;
    const can = typeof el.setAttribute === 'function' && typeof el.getAttribute === 'function';
    if (state === 'background') {
      if (el.classList) el.classList.add(CLASS.background);
      const label = dotLabel(state, opts);
      if (typeof el.setAttribute === 'function') {
        // remember what the element said before (once), so leaving the background state can put it back
        const cur = (k) => { const v = el.getAttribute(k); return v === null || v === undefined ? NONE : v; };
        // each attribute on its own: remember it the first time, or again when a caller wrote its own text since our last write
        // (a painter that resets only the title must not make us save our own label as the earlier aria-label)
        if (can) {
          for (const [name, previous, written] of [['title', PREV_TITLE, SET_TITLE], ['aria-label', PREV_ARIA, SET_ARIA]]) {
            const current = cur(name);
            if (!hasAttr(el, previous) || current !== el.getAttribute(written)) el.setAttribute(previous, current);
          }
        }
        el.setAttribute('title', label); el.setAttribute('aria-label', label);
        if (can) { el.setAttribute(SET_TITLE, label); el.setAttribute(SET_ARIA, label); }
      }
    } else {
      if (el.classList) el.classList.remove(CLASS.background);
      if (can && (hasAttr(el, PREV_TITLE) || hasAttr(el, PREV_ARIA))) {
        // put the old text back only where the element still shows the label we wrote; a caller's newer text stays
        const restore = (name, key, setKey) => {
          if (!hasAttr(el, key)) return;
          const v = el.getAttribute(key);
          const mine = el.getAttribute(name) === el.getAttribute(setKey);
          if (mine) { if (v === NONE || v === null || v === undefined) { if (typeof el.removeAttribute === 'function') el.removeAttribute(name); } else el.setAttribute(name, v); }
          if (typeof el.removeAttribute === 'function') { el.removeAttribute(key); el.removeAttribute(setKey); }
        };
        restore('title', PREV_TITLE, SET_TITLE); restore('aria-label', PREV_ARIA, SET_ARIA);
      }
    }
  }

  function headerCount({ working, workers, background } = {}) {
    const busyPart = String(working || '');
    const n = num(background);
    const bgPart = n > 0 ? n + ' with background work' : '';
    const text = busyPart && bgPart ? busyPart + ' · ' + bgPart : (bgPart || busyPart);
    return { text, busyPart, bgPart };
  }

  function phoneChip(names) {
    const list = (Array.isArray(names) ? names : []).map((x) => String(x || '').trim()).filter(Boolean);
    return list.length ? list.join(', ') + ': background work' : '';
  }

  return { dotState, dotLabel, bgLine, applyDot, headerCount, phoneChip, CLASS };
});
