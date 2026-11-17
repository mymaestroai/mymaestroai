/**
 * ui-simple.js — Simple mode's shared helper (desktop page and phone page).
 *
 * Functions:
 *   modeOf(me)                       'simple' | 'advanced' (me.uiMode, else by role: member -> simple, admin -> advanced)
 *   themeOf(me, prefersDark)         'light' | 'dark' (me.theme 'auto' follows prefersDark)
 *   apply(me, { doc, win })          sets/clears html classes mm-simple / mm-light; keeps 'auto' live with matchMedia
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

  function apply(me, opts) {
    const o = opts || {};
    let doc = o.doc, win = o.win;
    if (!doc && typeof document !== 'undefined') doc = document;
    if (!win && typeof window !== 'undefined') win = window;
    if (_off) { try { _off(); } catch {} _off = null; }
    const cl = doc && doc.documentElement && doc.documentElement.classList;
    if (!cl) return;
    const simple = modeOf(me) === 'simple';
    if (simple) cl.add('mm-simple'); else cl.remove('mm-simple');
    if (!simple) { cl.remove('mm-light'); return; }
    let mq = null;
    try { mq = win && typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-color-scheme: dark)') : null; } catch { mq = null; }
    const setLight = () => {
      if (themeOf(me, !!(mq && mq.matches)) === 'light') cl.add('mm-light'); else cl.remove('mm-light');
    };
    setLight();
    if (me && (me.theme === 'light' || me.theme === 'dark')) return;
    if (mq) {
      if (typeof mq.addEventListener === 'function') {
        mq.addEventListener('change', setLight);
        _off = () => mq.removeEventListener('change', setLight);
      } else if (typeof mq.addListener === 'function') {
        mq.addListener(setLight);
        _off = () => mq.removeListener(setLight);
      }
    }
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
    if (e === 'max') return 'Deepest';
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

  return { modeOf, themeOf, apply, EFFORTS, effortFor, pickedEffort, labelForAgentEffort, setEffort, labelFor, reasoningTail, consultLine, autoNote, greeting, STARTERS };
});
