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

  return { modeOf, themeOf, apply, EFFORTS, effortFor, pickedEffort, labelForAgentEffort, setEffort, labelFor, reasoningTail, consultLine, autoNote, greeting, STARTERS, askText, THEMES, themeKey, nextTheme, themeLabel, MORE_GROUPS, MORE_KEY, agentGroups };
});
