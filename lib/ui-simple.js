/**
 * ui-simple.js — Simple mode's shared helper (desktop page and phone page).
 *
 * Functions:
 *   modeOf(me)                       'simple' | 'advanced' (me.uiMode, else by role: member -> simple, admin -> advanced)
 *   themeOf(me, prefersDark)         'light' | 'dark' (me.theme 'auto' follows prefersDark)
 *   apply(me, { doc, win })          sets/clears html.mm-simple; sets html.mm-light or mm-dark in both modes; caches the setting (mmTheme); keeps 'auto' live with matchMedia
 *   EFFORTS                          the four reasoning levels in plain words
 *   effortFor(agent, storage)        remembered level for a chat (default 'medium')
 *   pickedEffort(agent, storage)     the level the person picked for this agent, or null (never picked)
 *   labelForAgentEffort(effort)      button label for the agent's own effort (low Quick, medium/default Balanced, high/xhigh Thorough, max Deepest)
 *   setEffort(agent, level, storage) remember a level
 *   labelFor(level)                  'Quick' | 'Balanced' | 'Thorough' | 'Deepest'
 *   reasoningTail(text, n = 5)       the last n non-empty lines
 *   consultLine(evt)                 'Asking <Name>…' | 'Asking a helper…' | null for a worker_started event
 *   autoNote(userText)               { label } | { label:null, hide:true } | null for hub-started prompts
 *   greeting(name)                   'How can I help, <first name>?'
 *   STARTERS                         three generic starter prompts
 *
 * Pure; no network. Browser: window.hubSimple. Node (tests): module.exports.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.hubSimple = api;
})(typeof window !== 'undefined' ? window : null, function () {
  const EFFORTS = [
    { id: 'quick', level: 'low', label: 'Quick', hint: 'Fastest answers' },
    { id: 'balanced', level: 'medium', label: 'Balanced', hint: 'Good for most questions' },
    { id: 'thorough', level: 'high', label: 'Thorough', hint: 'Takes more care' },
    { id: 'deepest', level: 'max', label: 'Deepest', hint: 'For the hardest questions' },
  ];
  const STARTERS = ['What can you help me with?', 'Help me plan my day', 'Explain something in plain words'];
  const KEY = 'hub-simple-effort:';

  function modeOf(me) {
    const m = me && me.uiMode;
    if (m === 'simple' || m === 'advanced') return m;
    return me && me.role === 'admin' ? 'advanced' : 'simple';
  }

  function themeOf(me, prefersDark) {
    const t = me && me.theme;
    if (t === 'light' || t === 'dark') return t;
    return prefersDark ? 'dark' : 'light';
  }

  let _off = null;   // removes the previous matchMedia listener

  const THEME_KEY = 'mmTheme';   // this device's copy of the account's theme setting ('light' | 'dark' | 'auto'); lib/ui-looks.js reads it before first paint

  // Remember the account's setting on this device (so the next page load is dressed before first paint); an account
  // with no setting is stored as 'auto' (that is how apply resolves it); no account at all clears it. Sign-out and a 401 clear it (forgetTheme).
  function rememberTheme(me, st) {
    try {
      if (!st) return;
      const t = me && me.theme;
      if (t === 'light' || t === 'dark' || t === 'auto') st.setItem(THEME_KEY, t);
      else if (me) st.setItem(THEME_KEY, 'auto');   // a known account with no setting resolves as auto (themeOf)
      else if (typeof st.removeItem === 'function') st.removeItem(THEME_KEY);   // no account: nothing to remember
    } catch { /* blocked storage: the page still shows the right theme */ }
  }

  function apply(me, opts) {
    const o = opts || {};
    let doc = o.doc, win = o.win;
    if (!doc && typeof document !== 'undefined') doc = document;
    if (!win && typeof window !== 'undefined') win = window;
    if (_off) { try { _off(); } catch {} _off = null; }
    try { const L = (win && win.HubLooks) || (typeof window !== 'undefined' && window.HubLooks) || (typeof module === 'object' && typeof require === 'function' ? require('./ui-looks') : null); if (L && typeof L.stopThemeListener === 'function') L.stopThemeListener(); } catch { /* the early loader is optional */ }
    const cl = doc && doc.documentElement && doc.documentElement.classList;
    if (!cl) return;
    const simple = modeOf(me) === 'simple';
    if (simple) cl.add('mm-simple'); else cl.remove('mm-simple');
    // One theme per account in both modes: html.mm-light or html.mm-dark (exactly one once the account is known).
    // Every existing mm-light rule is prefixed html.mm-simple, so Advanced only gains the class for looks that read it.
    if (!me) return;
    let mq = null;
    try { mq = win && typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-color-scheme: dark)') : null; } catch { mq = null; }
    let st = o.storage;
    if (st === undefined) { try { st = win && win.localStorage; } catch { st = null; } }
    rememberTheme(me, st);
    const setClass = () => {
      const was = cl.contains('mm-dark') ? 'dark' : cl.contains('mm-light') ? 'light' : null;
      const now = themeOf(me, !!(mq && mq.matches));
      if (now === 'light') { cl.add('mm-light'); cl.remove('mm-dark'); } else { cl.add('mm-dark'); cl.remove('mm-light'); }
      // A page shows what depends on the resolved colours (the Quiet Page notice): told only when they changed.
      if (was !== now && doc && typeof doc.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
        try { doc.dispatchEvent(new CustomEvent('mm-theme-resolved', { detail: { resolved: now } })); } catch { /* a listener must not undo the change */ }
      }
    };
    setClass();
    if (me.theme === 'light' || me.theme === 'dark') return;
    if (mq) {
      if (typeof mq.addEventListener === 'function') {
        mq.addEventListener('change', setClass);
        _off = () => mq.removeEventListener('change', setClass);
      } else if (typeof mq.addListener === 'function') {
        mq.addListener(setClass);
        _off = () => mq.removeListener(setClass);
      }
    }
  }

  const THEME_CHOICES = [['light', 'Light'], ['dark', 'Dark'], ['auto', 'Match device']];   // same words, same order as Simple's settings
  const NOTICE_TEXT = 'Quiet Page now has a dark version and follows your theme.';
  const NOTICE_KEY = 'mm-theme-notice:';   // + the account id, in localStorage (as mm-voice-hint:<id>); there is no per-account server pref for one-time notices

  function noticeSeen(me, st) {
    try { return !st || st.getItem(NOTICE_KEY + ((me && me.user && me.user.id) || 'anon')) === '1'; } catch { return true; }   // storage blocked: it could never be dismissed for good, so it stays away
  }
  function markNoticeSeen(me, st) {
    try { if (st) st.setItem(NOTICE_KEY + ((me && me.user && me.user.id) || 'anon'), '1'); } catch { /* blocked */ }
  }
  // Normal mode only, Quiet Page, a dark theme in force, and not seen by this account.
  function noticeShows(o) {
    const x = o || {};
    return !x.simple && x.look === 'quiet' && x.resolved === 'dark' && !x.seen;
  }

  /**
   * The Appearance control for normal mode (and the notice's choices): Light / Dark / Match device.
   *   opts.me()            the account object (hubMe)
   *   opts.save(value)     saves the theme (the page's own prefs call); rejects or resolves false when it failed
   *   opts.onError(err)    tells the person it did not save
   *   opts.onPress()       optional; called when a button is pressed, before the save; its result is the second argument of onChosen
   *   opts.onChosen(value, pressed) after a successful save
   *   opts.title           false: no 'Appearance' heading; opts.line: false: no single-colour-set line
   * Returns { el, repaint }. The line under it follows the look ('mm-look-change').
   */
  function themeControl(doc, opts) {
    const o = opts || {};
    const el = doc.createElement('div');
    el.className = 'mm-theme-control';
    if (o.title !== false) { const h = doc.createElement('div'); h.className = 'mm-theme-title'; h.textContent = 'Appearance'; el.appendChild(h); }
    const seg = doc.createElement('div');
    seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Appearance');
    seg.className = 'mm-theme-seg'; seg.style.display = 'flex'; seg.style.gap = '6px'; seg.style.flexWrap = 'wrap';
    const btns = [];
    for (const [value, label] of THEME_CHOICES) {
      const b = doc.createElement('button');
      b.type = 'button'; b.dataset.theme = value; b.textContent = label;
      b.style.padding = '6px 12px'; b.style.borderRadius = '8px'; b.style.cursor = 'pointer'; b.style.font = 'inherit';
      b.style.color = 'var(--text)'; b.style.background = 'transparent';
      seg.appendChild(b); btns.push(b);
    }
    el.appendChild(seg);
    const line = doc.createElement('div');
    line.className = 'mm-theme-line'; line.style.fontSize = '0.8rem'; line.style.color = 'var(--text-dim)'; line.style.marginTop = '4px';
    line.hidden = true;
    if (o.line !== false) el.appendChild(line);
    const repaint = () => {
      const me = typeof o.me === 'function' ? o.me() : null;
      const cur = themeKey(me && me.theme);
      for (const b of btns) {
        const on = b.dataset.theme === cur;
        b.setAttribute('aria-pressed', String(on));
        b.style.border = on ? '2px solid var(--accent)' : '1px solid var(--border)';
      }
      const L = typeof window !== 'undefined' ? window.HubLooks : null;
      const text = L && typeof L.singleSetLine === 'function' ? L.singleSetLine(L.applied(doc)) : null;
      line.textContent = text || ''; line.hidden = !text;
    };
    let saving = false;
    for (const b of btns) b.addEventListener('click', async () => {
      if (saving) return;
      const me = typeof o.me === 'function' ? o.me() : null;
      if (!me) return;
      saving = true;
      let pressed = null;   // what the page reports at the moment of the press (before the save changes anything)
      try { if (typeof o.onPress === 'function') pressed = o.onPress(); } catch { pressed = null; }
      const before = me.theme, v = b.dataset.theme;
      me.theme = v; try { apply(me, { doc }); } catch { /* the page stays as it is */ } repaint();
      let ok = false, err = null;
      try { ok = (await o.save(v)) !== false; } catch (e) { ok = false; err = e; }
      saving = false;
      if (!ok) {
        me.theme = before; try { apply(me, { doc }); } catch { /* keep the page as it was */ } repaint();
        if (typeof o.onError === 'function') o.onError(err || new Error('not saved'));
        return;
      }
      repaint();
      try { doc.dispatchEvent(new CustomEvent('mm-theme-change', { detail: { theme: v } })); } catch { /* cosmetic */ }
      if (typeof o.onChosen === 'function') o.onChosen(v, pressed);
    });
    const again = () => { if (!el.isConnected) { doc.removeEventListener('mm-look-change', again); doc.removeEventListener('mm-theme-change', again); return; } repaint(); };
    doc.addEventListener('mm-look-change', again);
    doc.addEventListener('mm-theme-change', again);
    repaint();
    return { el, repaint };
  }

  /**
   * The one-time line: 'Quiet Page now has a dark version and follows your theme.' with the three choices and a close.
   * Returns the element (the page places it) or null when it must not show. A choice or the close marks it seen for good.
   *   opts.me, opts.save, opts.onError, opts.storage, opts.onGone (after it is dismissed)
   */
  function themeNotice(doc, opts) {
    const o = opts || {};
    const me = typeof o.me === 'function' ? o.me() : o.me;
    const cl = doc && doc.documentElement && doc.documentElement.classList;
    if (!me || !cl) return null;
    const L = typeof window !== 'undefined' ? window.HubLooks : null;
    const st = o.storage === undefined ? defaultStorage() : o.storage;
    if (!noticeShows({ simple: cl.contains('mm-simple'), look: L && L.applied ? L.applied(doc) : null, resolved: cl.contains('mm-dark') ? 'dark' : cl.contains('mm-light') ? 'light' : null, seen: noticeSeen(me, st) })) return null;
    const el = doc.createElement('div');
    el.className = 'mm-theme-notice'; el.setAttribute('role', 'status');
    el.style.display = 'flex'; el.style.flexWrap = 'wrap'; el.style.alignItems = 'center'; el.style.gap = '8px 12px';
    el.style.padding = '8px 12px'; el.style.boxSizing = 'border-box'; el.style.background = 'var(--bg-card, var(--bg))'; el.style.color = 'var(--text)';
    el.style.borderBottom = '1px solid var(--border)'; el.style.fontSize = '0.9rem';
    const text = doc.createElement('span'); text.textContent = NOTICE_TEXT; text.style.flex = '1 1 220px';
    el.appendChild(text);
    const gone = () => { markNoticeSeen(me, st); if (el.parentNode) el.parentNode.removeChild(el); if (typeof o.onGone === 'function') o.onGone(); };
    const ctl = themeControl(doc, { me: () => me, save: o.save, onError: o.onError, title: false, line: false, onChosen: () => gone() });
    el.appendChild(ctl.el);
    const x = doc.createElement('button');
    x.type = 'button'; x.className = 'mm-theme-notice-close'; x.setAttribute('aria-label', 'Close'); x.textContent = '×';
    x.style.background = 'none'; x.style.border = '0'; x.style.color = 'inherit'; x.style.fontSize = '1.2rem'; x.style.cursor = 'pointer';
    x.addEventListener('click', gone);
    el.appendChild(x);
    return el;
  }

  function defaultStorage() {
    try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
  }

  function effortFor(agent, storage) {
    try {
      const st = storage || defaultStorage();
      const v = st && st.getItem(KEY + agent);
      if (EFFORTS.some((e) => e.level === v)) return v;
    } catch {}
    return 'medium';
  }

  // The level the person picked for this agent, or null when they never did (then the agent's own setting applies).
  function pickedEffort(agent, storage) {
    try {
      const st = storage || defaultStorage();
      const v = st && st.getItem(KEY + agent);
      if (EFFORTS.some((e) => e.level === v)) return v;
    } catch {}
    return null;
  }

  // The button label for an agent's own effort: low Quick; medium/default/unset Balanced; high/xhigh Thorough; max Deepest.
  function labelForAgentEffort(effort) {
    const e = String(effort == null ? '' : effort).trim().toLowerCase();
    if (e === 'low') return 'Quick';
    if (e === 'high' || e === 'xhigh') return 'Thorough';
    if (e === 'max' || e === 'ultra') return 'Deepest';   // Simple never offers Ultra; an admin's stored one reads as Deepest
    return 'Balanced';
  }

  function setEffort(agent, level, storage) {
    if (!EFFORTS.some((e) => e.level === level)) return false;
    try {
      const st = storage || defaultStorage();
      if (!st) return false;
      st.setItem(KEY + agent, level);
      return true;
    } catch { return false; }
  }

  function labelFor(level) {
    const e = EFFORTS.find((x) => x.level === level);
    return e ? e.label : 'Balanced';
  }

  function reasoningTail(text, n) {
    const k = Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
    const lines = String(text == null ? '' : text).split('\n').filter((l) => l.trim());
    return lines.slice(-k);
  }

  function consultLine(evt) {
    if (!evt || evt.type !== 'worker_started') return null;
    const t = evt.agent_type;
    if (t === 'temporal') return 'Asking a helper…';
    if (typeof t !== 'string' || !t || t === 'sdk-agent') return null;
    const m = /^Worker: Agent (.+)$/.exec(String(evt.description || '').trim());
    const name = m && m[1].trim() ? m[1].trim() : t;
    return 'Asking ' + name + '…';
  }

  function autoNote(userText) {
    if (typeof userText !== 'string') return null;
    const s = userText.trimStart();
    if (s.startsWith('[Scheduled task')) return { label: 'Reminder' };
    if (s.startsWith('[Job finished]') || s.startsWith('[Job report]')) return { label: 'Background job finished' };
    if (s.startsWith('[Delivery turn') || s.startsWith('[Consultation')) return { label: 'Update' };
    if (s.startsWith('[Resumed after compression')) return { label: null, hide: true };
    return null;
  }

  function greeting(name) {
    const first = String(name == null ? '' : name).trim().split(/\s+/)[0];
    return first ? 'How can I help, ' + first + '?' : 'How can I help?';
  }

  // A question and its answer as the hub saves them in the conversation ("❓ Q [a / b]" and "↳ answer"), in plain words.
  // Anything else comes back unchanged.
  function askText(role, text) {
    if (typeof text !== 'string') return text;
    if (role === 'assistant' && text.startsWith('❓ ')) {
      let q = text.slice(2).replace(/ \(or any model from the list\)$/, '');
      q = q.replace(/ \[[^\[\]]*\]$/, '');
      return q.trim() || text;
    }
    if (role === 'user' && text.startsWith('↳ ')) {
      const a = text.slice(2).trim();
      if (a === '(skipped)') return 'You skipped this question.';
      if (a === '(no answer)') return 'No answer was given.';
      return a ? 'You chose: ' + a : text;
    }
    return text;
  }

  // The theme button on the main page cycles Light -> Dark -> Match device -> Light. Unknown counts as Match device.
  const THEMES = {
    light: { icon: '☀', label: 'Light' },
    dark: { icon: '☾', label: 'Dark' },
    auto: { icon: '◐', label: 'Match device' },
  };
  function themeKey(t) { return t === 'light' || t === 'dark' ? t : 'auto'; }
  function nextTheme(t) { const k = themeKey(t); return k === 'light' ? 'dark' : k === 'dark' ? 'auto' : 'light'; }
  function themeLabel(t) { return THEMES[themeKey(t)]; }

  // Simple's agent list: Primary agents always; the rest under "More agents" in plain-word groups.
  // With no Primary agent at all, everything is shown and there is nothing to fold away.
  const MORE_GROUPS = [
    { key: 'specialist', label: 'Specialists' },
    { key: 'worker', label: 'Helpers' },
    { key: 'experimental', label: 'Experimental' },
  ];
  const MORE_KEY = 'hub-simple-more';   // localStorage, per device: '1' when "More agents" is open
  // Order inside every group: the lead agent (the hub's Maestro) first, then alphabetically by the name shown.
  function byLeadThenName(a, b) {
    if (!!a.lead !== !!b.lead) return a.lead ? -1 : 1;
    return String(a.display || a.name || '').localeCompare(String(b.display || b.name || ''), undefined, { sensitivity: 'base' });
  }
  function agentGroups(list, catOf) {
    const cat0 = typeof catOf === 'function' ? catOf : (a) => (a && a.category) || 'specialist';
    const cat = (a) => (a && a.lead ? 'primary' : cat0(a));   // the lead agent is always among the ones shown
    const all = (Array.isArray(list) ? list.filter(Boolean) : []).slice().sort(byLeadThenName);
    const primary = all.filter((a) => cat(a) === 'primary');
    if (!primary.length) return { primary: all, more: [] };
    const more = [];
    for (const g of MORE_GROUPS) {
      const items = all.filter((a) => cat(a) === g.key);
      if (items.length) more.push({ key: g.key, label: g.label, items });
    }
    const known = new Set(['primary', ...MORE_GROUPS.map((g) => g.key)]);
    const other = all.filter((a) => !known.has(cat(a)));
    if (other.length) {
      const sp = more.find((g) => g.key === 'specialist');
      if (sp) sp.items = sp.items.concat(other); else more.unshift({ key: 'specialist', label: 'Specialists', items: other });
    }
    return { primary, more };
  }

  return { modeOf, themeOf, apply, rememberTheme, THEME_KEY, THEME_CHOICES, NOTICE_TEXT, NOTICE_KEY, noticeSeen, markNoticeSeen, noticeShows, themeControl, themeNotice, EFFORTS, effortFor, pickedEffort, labelForAgentEffort, setEffort, labelFor, reasoningTail, consultLine, autoNote, greeting, STARTERS, askText, THEMES, themeKey, nextTheme, themeLabel, MORE_GROUPS, MORE_KEY, agentGroups };
});
