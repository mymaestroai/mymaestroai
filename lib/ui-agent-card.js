/**
 * ui-agent-card.js — the agent card: every setting of one agent in one place (shared by the desktop page and the phone page).
 *
 * A right-side panel on the desktop, a full-screen sheet on the phone and in narrow windows. Sections come from the settings
 * records whose home starts with "Agent card > " (Basics, Role and team, Memory, Access, Schedule and background work); each
 * row is a record. A row with a registered rowDef is live (a control that saves on change); a record with none is shown
 * read-only with a link to the agent page (admins) until every row has one.
 *
 *   rowDef = {
 *     get(agent, ctx)        -> { value, display, isDefault? }      isDefault true = "Using the default for all agents"
 *     control                -> { type: 'toggle'|'select'|'segmented'|'number'|'text'|'list'|'action'|'readonly',
 *                                 options?: (agent, ctx) => [{ value, label }], min?, max?, step? }
 *     save(agent, value, ctx)-> Promise<{ ok, error? }>             called on change; the card re-reads the agent after ok
 *     resetDefault?(agent, ctx) -> Promise<{ ok, error? }|void>     "Use default again" (shown when get() says isDefault false)
 *     visible?(agent, ctx)   -> bool                                false = the row is not drawn
 *     live?(agent, ctx)      -> bool                                false = read-only, with who can change it
 *     summary?(agent, ctx)   -> string                              a piece of the section's one-line summary
 *     label?: string | (agent, ctx) => string, desc?: string | (agent, ctx) => string     overrides of the record's name and first line
 *   }
 *   ctx = { agent, name, me, isAdmin, section, doc, win, fetch, patch(body) -> Promise<{ ok, error? }>, refresh() }
 *
 *   More on rowDef: members?(agent, ctx) -> true = a member may use this row though its record says admin (the server decides);
 *   bottom?: true = not in its section but alone at the very bottom (admins; save(agent, true, ctx) after def.confirm text);
 *   control.type 'custom' = control.build({ doc, mk, agent, ctx, got, label, send, busy }) returns the element; ctx.open(name, where), ctx.openMore().
 *   window.hubAgentCard: open(name, { row, section }), close(), isOpen(), refresh(), register(id, def), registerMany(map), setFirstRows(section, ids),
 *   sectionsFor(me, simple), configure({ guard, subscribe, agentsList, simple, me }), cardDoorStart(), parseCardHash(hash),
 *   FIRST_ROWS (the rows shown before "More" in each section), createCard(opts) (the pure core, used by the tests).
 *
 * Text is always set with textContent. Colours come from CSS variables in each page. Node (tests): module.exports.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.hubAgentCard = api;
})(typeof window !== 'undefined' ? window : null, function (rootWin) {
  'use strict';
  const SECTIONS = [
    { key: 'basics', title: 'Basics', home: 'Agent card > Basics' },
    { key: 'role', title: 'Role and team', home: 'Agent card > Role and team' },
    { key: 'memory', title: 'Memory', home: 'Agent card > Memory' },
    { key: 'access', title: 'Access', home: 'Agent card > Access', shield: true },
    { key: 'schedule', title: 'Schedule and background work', home: 'Agent card > Schedule and background work' },
  ];
  const MEMBER_SECTIONS = ['basics', 'memory'];
  /** The rows shown first in each section (record ids); every other record of the section sits under its closed "More". */
  const FIRST_ROWS = {
    basics: ['OPT-0047', 'OPT-0057', 'OPT-0168', 'OPT-0023', 'OPT-0063'],   // Model, Thinking effort, Notifications, Voice (its row), Call display
    role: [], memory: [], access: [], schedule: [],
  };
  const TEXT = {
    footer: 'You can also ask Maestro to change any of these.',
    defaultLine: 'Using the default for all agents',
    useDefault: 'Use default again',
    adminOnly: 'Only an admin can change this.',
    notHere: 'This can not be changed from here right now.',
    saveFailed: 'Could not save.',
    moreWord: 'More: ',
  };
  const SHIELD = String.fromCodePoint(0x1F6E1);   // no variation selector: the page's colour paints it
  const NAME_RE = /^[\w.@-]{1,64}$/;
  const HASH_RE = /^#agent-card=([^&]+)(?:&row=(OPT-[A-Za-z0-9_-]{1,40}))?(?:&section=(basics|role|memory|access|schedule))?$/;

  /** A section module sets the first rows of its section (record ids): setFirstRows('memory', ['OPT-0040', ...]). */
  function setFirstRows(section, ids) { if (SECTIONS.some((s) => s.key === section) && Array.isArray(ids)) FIRST_ROWS[section] = ids.filter((x) => typeof x === 'string'); }

  const registry = new Map();   // record id -> rowDef
  function register(id, def) { if (typeof id === 'string' && id && def && typeof def === 'object') registry.set(id, def); }
  function registerMany(map) {
    const entries = map instanceof Map ? [...map.entries()] : Object.entries(map || {});
    for (const [id, def] of entries) register(id, def);
  }

  // ── pure helpers ────────────────────────────────────────────────────────────────────────────────────────────
  const isAdminOf = (me) => !!me && me.isAdmin === true;
  const userIdOf = (me) => (me && me.user && me.user.id != null ? String(me.user.id) : '');
  /** The section keys this person gets: admins all five, everybody else (and Simple mode) Basics and Memory. */
  function sectionsFor(me, simple) {
    return isAdminOf(me) && !simple ? SECTIONS.map((s) => s.key) : MEMBER_SECTIONS.slice();
  }
  /** May this person open this agent's card? Admins any agent; others only agents they own or that are shared with them. */
  function mayOpen(agent, me) {
    if (!agent || !me) return false;
    if (isAdminOf(me)) return true;
    const id = userIdOf(me);
    if (!id) return false;
    if (agent.owner != null && String(agent.owner) === id) return true;
    return Array.isArray(agent.sharedWith) && agent.sharedWith.map(String).includes(id);
  }
  function parseCardHash(hash) {
    const m = HASH_RE.exec(String(hash || ''));
    if (!m) return null;
    let name = '';
    try { name = decodeURIComponent(m[1]); } catch { return null; }
    if (!NAME_RE.test(name)) return null;
    return { name, row: m[2] || null, section: m[3] || null };
  }
  /** The first sentence of a record's "what", cut to 90 characters. */
  function firstLine(text, max) {
    const lim = max || 90;
    let t = String(text || '').replace(/\s+/g, ' ').trim();
    const m = /^(.*?[.!?])(\s|$)/.exec(t);
    if (m) t = m[1];
    return t.length > lim ? t.slice(0, lim - 1).replace(/\s+\S*$/, '') + '…' : t;
  }
  /** The group name of a record under "More": the part of its home after "More", else its own name. */
  function groupName(rec) {
    const parts = String(rec.home || '').split(' > ');
    const i = parts.indexOf('More');
    return (i >= 0 && parts[i + 1]) || rec.name || rec.id;
  }
  /** "More: a, b, c, d and more" (at most four names). */
  function moreLine(recs) {
    const names = [];
    for (const r of recs) { const n = groupName(r); if (n && !names.includes(n)) names.push(n); }
    return TEXT.moreWord + names.slice(0, 4).join(', ') + (names.length > 4 ? ' and more' : '');
  }
  function sectionOfRecord(rec) {
    const home = String((rec && rec.home) || '');
    return SECTIONS.find((s) => home === s.home || home.startsWith(s.home + ' > ')) || null;
  }
  /** { first: [records], more: [records] } of one section, in the records' own order. */
  function splitSection(recs, sec, firstRows) {
    const mine = recs.filter((r) => { const s = sectionOfRecord(r); return s && s.key === sec.key; });
    const ids = (firstRows && firstRows[sec.key]) || [];
    const first = ids.map((id) => mine.find((r) => r.id === id)).filter(Boolean);
    return { first, more: mine.filter((r) => !first.includes(r)) };
  }
  function roleLine(agent, list) {
    const parts = [agent.lead === true ? 'Lead' : 'Solo'];
    if (agent.reportsTo) {
      const boss = (list || []).find((a) => a && a.name === agent.reportsTo);
      parts.push('reports to ' + ((boss && boss.display) || agent.reportsTo));
    }
    return parts.join(' · ');
  }
  async function readJson(r) { try { return await r.json(); } catch { return null; } }
  /** PATCH /api/agents/<name> with a body: { ok } or { ok:false, error }. */
  async function patchAgent(fetchFn, name, body) {
    try {
      const r = await fetchFn('/api/agents/' + encodeURIComponent(name), { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r && r.ok) return { ok: true };
      const j = r ? await readJson(r) : null;
      return { ok: false, error: (j && (j.error || j.message)) || (TEXT.saveFailed.replace(/\.$/, '') + ' (' + (r ? r.status : 'no answer') + ').') };
    } catch (e) { return { ok: false, error: (e && e.message) || TEXT.saveFailed }; }
  }

  // ── the two sample rows (the rest are added by their sections) ───────────────────────────────────────────────
  const COMPACTION_OPTIONS = [
    { value: '', label: 'Same as all agents' }, { value: 'off', label: 'Off' }, { value: 'dry', label: 'Practice only' },
    { value: 'on', label: 'On' }, { value: 'assisted', label: 'Ask first' },
  ];
  const compactionBody = (agent, mode) => {
    const c = (agent && agent.compaction) || {};
    const out = {};
    if (c.at != null) out.at = c.at;   // the PATCH replaces the whole object: keep the other half
    if (mode) out.mode = mode;
    return { compaction: out };
  };
  const SAMPLES = {
    'OPT-0005': {   // Short description (blurb): a members may also change it
      get: (agent) => ({ value: agent.blurb || '', display: agent.blurb || '' }),
      control: { type: 'text', max: 120 },
      save: (agent, value, ctx) => ctx.patch({ blurb: String(value == null ? '' : value).trim() }),
    },
    'OPT-0040': {   // When the conversation gets long (compaction mode): PATCH {compaction}, which members may use (the PUT route is admin-only)
      get: (agent) => {
        const mode = agent.compaction && agent.compaction.mode ? agent.compaction.mode : '';
        const opt = COMPACTION_OPTIONS.find((o) => o.value === mode);
        return { value: mode, display: opt ? opt.label : mode, isDefault: !mode };
      },
      control: { type: 'select', options: () => COMPACTION_OPTIONS },
      save: (agent, value, ctx) => ctx.patch(compactionBody(agent, value)),
      resetDefault: (agent, ctx) => ctx.patch(compactionBody(agent, '')),
      summary: (agent) => { const m = agent.compaction && agent.compaction.mode; return m === 'on' ? 'compression on' : (m === 'off' ? 'compression off' : (m ? 'compression ' + m : '')); },
    },
  };
  registerMany(SAMPLES);

  // ── the shared event stream, opened only while a card is open ────────────────────────────────────────────────
  function defaultSubscribe(W) {
    let es = null, n = 0;
    return (type, fn) => {
      if (!W || typeof W.EventSource !== 'function') return () => {};
      if (!es) es = new W.EventSource('/api/events');
      n++;
      const h = (e) => { let d = null; try { d = JSON.parse(e.data); } catch { return; } fn(d); };
      es.addEventListener(type, h);
      return () => { es.removeEventListener(type, h); if (--n <= 0 && es) { es.close(); es = null; n = 0; } };
    };
  }

  // ── the card ────────────────────────────────────────────────────────────────────────────────────────────────
  /**
   * createCard({ doc, win, fetch, records, me, agentsList, subscribe, help, guard, simple, rows, firstRows, setTimeout, phone })
   * records: () => Map|array|{records}; me / agentsList / simple: a value or a function. subscribe(type, fn) -> unsubscribe.
   */
  function createCard(opts) {
    const o = opts || {};
    const doc = o.doc || (typeof document !== 'undefined' ? document : null);
    const win = o.win || rootWin || (doc && doc.defaultView) || null;
    const fetchFn = o.fetch || (win && win.fetch ? win.fetch.bind(win) : null);
    const rows = o.rows || registry;
    const firstRows = o.firstRows || FIRST_ROWS;
    const later = o.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const val = (v) => (typeof v === 'function' ? v() : v);
    const helpOf = () => val(o.help) || (win && win.hubSettingsHelp) || null;
    const subscribeFn = o.subscribe || defaultSubscribe(win);
    let st = null;   // the open card

    async function loadRecords() {
      let src = null;
      if (o.records) src = val(o.records);
      else {
        const h = helpOf();
        if (h && typeof h.load === 'function') { try { await h.load(false); } catch { /* the help script goes on without */ } }
        if (h && typeof h.records === 'function') src = h.records();
        if ((!src || (src.size === 0)) && fetchFn) {
          try { const r = await fetchFn('/api/settings-records', { credentials: 'include' }); if (r && r.ok) src = await r.json(); } catch { /* none */ }
        }
      }
      if (src && !Array.isArray(src) && !(src instanceof Map) && Array.isArray(src.records)) src = src.records;
      const list = src instanceof Map ? [...src.values()] : (Array.isArray(src) ? src : []);
      return list.filter((r) => r && typeof r.id === 'string' && sectionOfRecord(r));
    }
    async function loadMe() {
      let me = val(o.me) || (win && win.hubMe) || null;
      if (!me && fetchFn) { try { const r = await fetchFn('/api/me', { credentials: 'include' }); if (r && r.ok) me = await r.json(); } catch { /* unknown */ } }
      return me;
    }
    const isSimple = () => {
      const s = val(o.simple);
      if (typeof s === 'boolean') return s;
      try { return !!(doc && doc.documentElement && doc.documentElement.classList && doc.documentElement.classList.contains('mm-simple')); } catch { return false; }
    };
    const isPhone = () => {
      if (typeof o.phone === 'boolean') return o.phone;
      try { if (win && win.location && /^\/mobile(\/|$)/.test(win.location.pathname || '')) return true; if (win && win.innerWidth && win.innerWidth < 700) return true; } catch { /* wide */ }
      return false;
    };
    const listNow = () => { try { const l = val(o.agentsList); return Array.isArray(l) ? l : []; } catch { return []; } };
    /** The agent record: the page's own list first (fresh=false), else GET /api/agents. */
    async function readAgent(name, fresh) {
      if (!fresh) { const a = listNow().find((x) => x && x.name === name); if (a) return { agent: a, list: listNow() }; }
      if (fetchFn) {
        try {
          const r = await fetchFn('/api/agents', { credentials: 'include' });
          if (r && r.ok) {
            const j = await r.json();
            const list = Array.isArray(j) ? j : (j && Array.isArray(j.agents) ? j.agents : []);
            return { agent: list.find((x) => x && x.name === name) || null, list };
          }
        } catch { /* fall back to the page's list */ }
      }
      return { agent: listNow().find((x) => x && x.name === name) || null, list: listNow() };
    }

    const mk = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.setAttribute('class', cls); if (text != null && text !== '') e.textContent = String(text); return e; };
    const setBusy = (e, on) => { e.disabled = !!on; if (on) e.setAttribute('disabled', ''); else if (e.attrs) delete e.attrs.disabled; else if (e.removeAttribute) e.removeAttribute('disabled'); };

    // ── drawing ────────────────────────────────────────────────────────────────────────────────────────────────
    function makeCtx(sec) {
      return {
        agent: st.agent, name: st.name, me: st.me, isAdmin: isAdminOf(st.me), section: sec ? sec.key : null, doc, win, fetch: fetchFn, agents: st.list,
        patch: (body) => patchAgent(fetchFn, st.name, body), refresh: () => refresh(),
        open: (n, w) => open(n, w), openMore: () => { if (sec && st) st.more.add(sec.key); },
      };
    }
    const call = (fn, fallback, ...args) => { try { return fn(...args); } catch { return fallback; } };

    function infoButton(rec, label) {
      const h = helpOf();
      if (!h || typeof h.open !== 'function') return null;
      const b = mk('button', 'st-info');
      b.setAttribute('type', 'button'); b.setAttribute('data-rec', rec.id);
      b.setAttribute('aria-label', 'About ' + (rec.name || label || 'this setting')); b.setAttribute('aria-haspopup', 'dialog');
      const g = mk('span', '', 'ⓘ'); g.setAttribute('aria-hidden', 'true'); b.appendChild(g);
      b.addEventListener('click', (e) => { if (e && e.preventDefault) e.preventDefault(); if (e && e.stopPropagation) e.stopPropagation(); h.open(rec.id, b, { doc, win }); });
      return b;
    }

    function control(rec, def, got, editable, label) {
      const c = def.control || { type: 'readonly' };
      const type = editable ? c.type : 'readonly';   // 'custom' also reads as plain text when not editable
      const busy = st.saving.has(rec.id);
      const send = (v) => commit(rec, def, v);
      let ctl;
      if (type === 'toggle') {
        ctl = mk('input', 'ac-switch'); ctl.setAttribute('type', 'checkbox'); ctl.setAttribute('role', 'switch');
        ctl.checked = !!got.value; ctl.setAttribute('aria-label', label);
        ctl.addEventListener('change', () => send(!!ctl.checked));
      } else if (type === 'select') {
        ctl = mk('select', 'ac-select'); ctl.setAttribute('aria-label', label);
        for (const op of call(c.options || (() => []), [], st.agent, makeCtx(null))) { const e = mk('option', '', op.label); e.setAttribute('value', String(op.value)); e.value = String(op.value); ctl.appendChild(e); }
        ctl.value = got.value == null ? '' : String(got.value);
        ctl.addEventListener('change', () => send(ctl.value));
      } else if (type === 'segmented') {
        ctl = mk('div', 'ac-seg'); ctl.setAttribute('role', 'radiogroup'); ctl.setAttribute('aria-label', label);
        for (const op of call(c.options || (() => []), [], st.agent, makeCtx(null))) {
          const on = String(op.value) === String(got.value);
          const b = mk('button', 'ac-seg-b' + (on ? ' on' : ''), op.label);
          b.setAttribute('type', 'button'); b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', on ? 'true' : 'false');
          b.addEventListener('click', () => { if (!on && !b.disabled) send(op.value); });
          ctl.appendChild(b);
        }
      } else if (type === 'number') {
        ctl = mk('input', 'ac-input'); ctl.setAttribute('type', 'number'); ctl.setAttribute('aria-label', label);
        for (const k of ['min', 'max', 'step']) if (c[k] != null) ctl.setAttribute(k, String(c[k]));
        ctl.value = got.value == null ? '' : String(got.value);
        ctl.addEventListener('change', () => {
          const n = Number(ctl.value);
          if (ctl.value === '' || !Number.isFinite(n)) { st.errors.set(rec.id, 'Enter a number.'); render(); return; }
          send(n);
        });
      } else if (type === 'text' || type === 'list') {
        ctl = mk('input', 'ac-input'); ctl.setAttribute('type', 'text'); ctl.setAttribute('aria-label', label);
        if (type === 'text' && c.max) ctl.setAttribute('maxlength', String(c.max));
        ctl.value = Array.isArray(got.value) ? got.value.join(', ') : (got.value == null ? '' : String(got.value));
        ctl.addEventListener('change', () => send(type === 'list' ? String(ctl.value).split(',').map((s) => s.trim()).filter(Boolean) : ctl.value));
      } else if (type === 'custom' && typeof c.build === 'function') {   // the row builds its own control (e.g. a switch and a select together)
        ctl = call(c.build, null, { doc, mk, agent: st.agent, ctx: makeCtx(null), got, label, send, busy });
        if (!ctl) ctl = mk('span', 'ac-value', got.display != null ? got.display : '');
      } else if (type === 'action') {
        ctl = mk('button', 'ac-action', got.display || label); ctl.setAttribute('type', 'button');
        ctl.addEventListener('click', () => send(true));
      } else {
        ctl = mk('span', 'ac-value', got.display != null && got.display !== '' ? got.display : (got.value == null ? '' : String(got.value)));
      }
      if (busy && type !== 'readonly') { setBusy(ctl, true); ctl.setAttribute('aria-busy', 'true'); if (ctl.children) for (const k of ctl.children) setBusy(k, true); }
      return ctl;
    }

    function renderRow(rec, sec) {
      const def = rows.get(rec.id) || null;
      const ctx = makeCtx(sec);
      if (def && def.visible && call(def.visible, true, st.agent, ctx) === false) return null;
      const admin = isAdminOf(st.me);
      const row = mk('div', 'ac-row'); row.setAttribute('data-rec', rec.id); row.setAttribute('data-ac-row', rec.id);
      const label = String(def && def.label != null ? (typeof def.label === 'function' ? call(def.label, '', st.agent, ctx) : def.label) : (rec.name || rec.id));
      const descRaw = def && def.desc != null ? (typeof def.desc === 'function' ? call(def.desc, '', st.agent, ctx) : def.desc) : firstLine(rec.what);
      const main = mk('div', 'ac-main');
      const head = mk('div', 'ac-head-line');
      head.appendChild(mk('span', 'ac-label', label));
      const info = infoButton(rec, label);
      if (info) { head.appendChild(info); st.infos.set(rec.id, info); }
      main.appendChild(head);
      if (descRaw) main.appendChild(mk('div', 'ac-desc', descRaw));
      row.appendChild(main);

      let why = '';
      let got = { value: '', display: '' };
      let editable = false;
      if (!def) {
        if (admin) {
          const p = mk('div', 'ac-note');
          p.appendChild(mk('span', '', 'Change it on '));
          const a = mk('a', 'ac-link', 'the agent page');
          a.setAttribute('href', '/agent-settings.html?agent=' + encodeURIComponent(st.name) + '#rec=' + encodeURIComponent(rec.id));
          p.appendChild(a);
          main.appendChild(p);
        }
      } else {
        got = call(def.get, { value: '', display: '' }, st.agent, ctx) || { value: '', display: '' };
        const memberOk = !admin && typeof def.members === 'function' && call(def.members, false, st.agent, ctx) === true;   // a row the server lets a member use (e.g. the model, from the admin's list)
        if (!admin && rec.who === 'admin' && !memberOk) why = TEXT.adminOnly;
        else if (def.live && call(def.live, true, st.agent, ctx) === false) why = admin ? TEXT.notHere : TEXT.adminOnly;
        editable = !why && typeof def.save === 'function' && !!def.control && def.control.type !== 'readonly';
        const ctl = control(rec, def, got, editable, label);
        const wrap = mk('div', 'ac-ctl'); wrap.appendChild(ctl);
        st.ctls.set(rec.id, ctl);
        row.appendChild(wrap);
        if (why) main.appendChild(mk('div', 'ac-note', why));
        if (got.isDefault === true && !why) main.appendChild(mk('div', 'ac-default', TEXT.defaultLine));
        else if (got.isDefault === false && !why && typeof def.resetDefault === 'function') {
          const b = mk('button', 'ac-reset', TEXT.useDefault); b.setAttribute('type', 'button');
          if (st.saving.has(rec.id)) setBusy(b, true);
          b.addEventListener('click', () => reset(rec, def));
          main.appendChild(b);
        }
      }
      const err = st.errors.get(rec.id);
      if (err) { const e = mk('div', 'ac-err', err); e.setAttribute('role', 'alert'); main.appendChild(e); }
      st.rowEls.set(rec.id, row);
      return row;
    }

    function sectionSummary(sec, recs) {
      const bits = [];
      for (const r of recs) {
        const d = rows.get(r.id);
        if (!d || typeof d.summary !== 'function') continue;
        const s = call(d.summary, '', st.agent, makeCtx(sec));
        if (s && String(s).trim()) bits.push(String(s).trim());
      }
      return bits.join(' · ');
    }

    /** A row with `bottom: true` (Remove this agent) is not in its section: it stands alone at the very bottom of the card. */
    const isBottom = (rec) => { const d = rows.get(rec.id); return !!(d && d.bottom); };
    function renderBottom() {
      if (!isAdminOf(st.me) || st.simple) return null;
      const rec = st.records.find((r) => isBottom(r));
      if (!rec) return null;
      const def = rows.get(rec.id);
      const ctx = makeCtx(sectionOfRecord(rec));
      if (def.visible && call(def.visible, true, st.agent, ctx) === false) return null;
      const box = mk('div', 'ac-bottom'); box.setAttribute('data-rec', rec.id); box.setAttribute('data-ac-row', rec.id);
      const label = String(typeof def.label === 'function' ? call(def.label, '', st.agent, ctx) : (def.label || rec.name || rec.id));
      const b = mk('button', 'ac-action ac-remove', label); b.setAttribute('type', 'button'); b.setAttribute('aria-label', label);
      if (st.saving.has(rec.id)) setBusy(b, true);
      b.addEventListener('click', async () => {
        if (!st || st.saving.has(rec.id)) return;
        const q = typeof def.confirm === 'function' ? call(def.confirm, '', st.agent, ctx) : def.confirm;
        if (q && win && typeof win.confirm === 'function' && !win.confirm(q)) return;
        st.saving.add(rec.id); st.errors.delete(rec.id); setBusy(b, true);
        let res;
        try { res = await def.save(st.agent, true, makeCtx(sectionOfRecord(rec))); } catch (e) { res = { ok: false, error: (e && e.message) || TEXT.saveFailed }; }
        if (!st) return;
        st.saving.delete(rec.id);
        if (res && res.ok === false) { st.errors.set(rec.id, String(res.error || TEXT.saveFailed)); render(); return; }
        close(false);   // the agent is gone: the page's own list follows its agent_updated / reload
      });
      box.appendChild(b);
      const err = st.errors.get(rec.id);
      if (err) { const e = mk('div', 'ac-err', err); e.setAttribute('role', 'alert'); box.appendChild(e); }
      st.rowEls.set(rec.id, box); st.ctls.set(rec.id, b);
      return box;
    }

    function renderSection(sec, allRecs) {
      const recs = allRecs.filter((r) => !isBottom(r));
      const { first, more } = splitSection(recs, sec, firstRows);
      if (!first.length && !more.length) return null;
      const open = st.open.has(sec.key);
      const box = mk('section', 'ac-sec' + (open ? ' open' : '')); box.setAttribute('data-sec', sec.key);
      const hb = mk('button', 'ac-sec-head'); hb.setAttribute('type', 'button'); hb.setAttribute('aria-expanded', open ? 'true' : 'false');
      const caret = mk('span', 'ac-caret', open ? '▾' : '▸'); caret.setAttribute('aria-hidden', 'true');
      hb.appendChild(caret);
      const title = mk('span', 'ac-sec-title', sec.title);
      if (sec.shield) {
        const sh = mk('span', 'ac-shield', SHIELD); sh.setAttribute('role', 'img'); sh.setAttribute('aria-label', 'Changed only by an admin'); sh.setAttribute('title', 'Changed only by an admin');
        title.appendChild(sh);
      }
      hb.appendChild(title);
      hb.appendChild(mk('span', 'ac-sec-sum', sectionSummary(sec, first.concat(more))));
      hb.addEventListener('click', () => { if (st.open.has(sec.key)) st.open.delete(sec.key); else st.open.add(sec.key); render(); });
      box.appendChild(hb);
      if (open) {
        const body = mk('div', 'ac-sec-body');
        for (const r of first) { const e = renderRow(r, sec); if (e) body.appendChild(e); }
        if (more.length) {
          const mopen = st.more.has(sec.key);
          const mb = mk('button', 'ac-more-head', moreLine(more)); mb.setAttribute('type', 'button'); mb.setAttribute('aria-expanded', mopen ? 'true' : 'false');
          mb.addEventListener('click', () => { if (st.more.has(sec.key)) st.more.delete(sec.key); else st.more.add(sec.key); render(); });
          body.appendChild(mb);
          if (mopen) { const mm = mk('div', 'ac-more-body'); for (const r of more) { const e = renderRow(r, sec); if (e) mm.appendChild(e); } body.appendChild(mm); }
        }
        box.appendChild(body);
      }
      return box;
    }

    function renderHead() {
      const h = st.head;
      h.textContent = '';
      const a = st.agent;
      const shown = a.display || a.name;
      const ic = mk('span', 'ac-icon');
      const icon = typeof a.icon === 'string' && a.icon.length <= 8 ? a.icon : '';
      if (icon) ic.textContent = icon; else ic.setAttribute('class', 'ac-icon ac-dot');
      ic.setAttribute('aria-hidden', 'true');
      const t = mk('div', 'ac-titles');
      const title = mk('h2', 'ac-title', 'Settings for ' + shown); title.setAttribute('id', 'ac-title');
      t.appendChild(title);
      t.appendChild(mk('div', 'ac-role', roleLine(a, st.list)));
      const x = mk('button', 'ac-x', '×'); x.setAttribute('type', 'button'); x.setAttribute('aria-label', 'Close');
      x.addEventListener('click', () => close());
      h.appendChild(ic); h.appendChild(t); h.appendChild(x);
    }

    function render() {
      if (!st) return;
      const panel = st.panel;
      const top = panel.scrollTop || 0;
      let focusId = null;
      const act = doc.activeElement;
      for (let n = act; n && n !== panel; n = n.parentNode) { const id = n.getAttribute && n.getAttribute('data-ac-row'); if (id) { focusId = id; break; } }
      st.rowEls.clear(); st.ctls.clear(); st.infos.clear();
      renderHead();
      st.body.textContent = '';
      const keys = sectionsFor(st.me, st.simple);
      for (const sec of SECTIONS) {
        if (!keys.includes(sec.key)) continue;
        const e = renderSection(sec, st.records);
        if (e) st.body.appendChild(e);
      }
      st.body.appendChild(mk('p', 'ac-foot', TEXT.footer));
      const bottom = renderBottom();
      if (bottom) st.body.appendChild(bottom);
      panel.scrollTop = top;
      if (focusId && st.ctls.get(focusId) && !st.ctls.get(focusId).disabled && st.ctls.get(focusId).focus) { try { st.ctls.get(focusId).focus({ preventScroll: true }); } catch { /* gone */ } }
    }

    // ── saving ─────────────────────────────────────────────────────────────────────────────────────────────────
    async function finish(rec, p) {
      let res;
      try { res = await p; } catch (e) { res = { ok: false, error: (e && e.message) || TEXT.saveFailed }; }
      if (!st) return;
      st.saving.delete(rec.id);
      if (res && res.ok === false) { st.errors.set(rec.id, String(res.error || TEXT.saveFailed)); render(); return; }
      st.errors.delete(rec.id);
      await refresh();
    }
    function commit(rec, def, value) {
      if (!st || st.saving.has(rec.id)) return Promise.resolve();
      st.saving.add(rec.id); st.errors.delete(rec.id);
      const ctl = st.ctls.get(rec.id);
      if (ctl) { setBusy(ctl, true); ctl.setAttribute('aria-busy', 'true'); for (const k of ctl.children || []) setBusy(k, true); }
      let p;
      try { p = Promise.resolve(def.save(st.agent, value, makeCtx(sectionOfRecord(rec)))); } catch (e) { p = Promise.reject(e); }
      return finish(rec, p);
    }
    function reset(rec, def) {
      if (!st || st.saving.has(rec.id)) return Promise.resolve();
      st.saving.add(rec.id); st.errors.delete(rec.id);
      let p;
      try { p = Promise.resolve(def.resetDefault(st.agent, makeCtx(sectionOfRecord(rec)))).then((r) => (r === undefined ? { ok: true } : r)); } catch (e) { p = Promise.reject(e); }
      return finish(rec, p);
    }

    // ── re-reading ─────────────────────────────────────────────────────────────────────────────────────────────
    async function refresh() {
      const mine = st;
      if (!mine) return;
      const ticket = ++mine.ticket;
      const got = await readAgent(mine.name, true);
      if (st !== mine || ticket !== mine.ticket) return;
      if (!got.agent || !mayOpen(got.agent, mine.me)) { close(); return; }   // renamed, deleted or no longer shared
      mine.agent = got.agent; mine.list = got.list;
      render();
    }
    function onAgentEvent(ev) {
      if (!st || !ev || ev.agent !== st.name) return;
      const renamed = ev.renamedTo || ev.newName || ev.renamed === true || (Array.isArray(ev.changed) && ev.changed.includes('name'));
      if (renamed) { close(); return; }
      refresh();
    }
    function onRenamed(ev) { if (st && ev && (ev.agent === st.name || ev.from === st.name || ev.oldName === st.name)) close(); }

    // ── the door: scroll the row into view once it is laid out, highlight it, focus its ⓘ ──────────────────────
    function goToRow(id) {
      const row = st.rowEls.get(id);
      if (!row) return null;
      let moved = false, ourAt = 0;
      const mine = () => { moved = true; };
      const notOurs = () => { if (Date.now() - ourAt > 400) moved = true; };
      const evs = ['wheel', 'touchstart', 'touchmove', 'keydown', 'mousedown'];
      const listen = (on) => {
        for (const t of [doc, win]) {
          if (!t || !t.addEventListener) continue;
          try { for (const ev of evs) on ? t.addEventListener(ev, mine, true) : t.removeEventListener(ev, mine, true); on ? t.addEventListener('scroll', notOurs, true) : t.removeEventListener('scroll', notOurs, true); } catch { /* ignore */ }
        }
      };
      const toRow = () => { try { const cur = st && st.rowEls.get(id) ? st.rowEls.get(id) : row; if (cur.scrollIntoView && cur.isConnected !== false) { ourAt = Date.now(); cur.scrollIntoView({ block: 'center' }); } } catch { /* no scrolling here */ } };
      listen(true);
      toRow();
      let off = false;
      const stop = () => { if (!off) { off = true; listen(false); } };
      const again = (ms, last) => later(() => { try { if (!st) { stop(); return; } if (!moved) toRow(); } finally { if (last) stop(); } }, ms);
      again(150, false); again(450, true);
      const cur = () => (st && st.rowEls.get(id)) || row;
      if (row.classList) { row.classList.add('st-door-hit'); later(() => { try { cur().classList.remove('st-door-hit'); row.classList.remove('st-door-hit'); } catch { /* gone */ } }, 2000); }
      const target = st.infos.get(id) || st.ctls.get(id);
      if (target && target.focus) { try { target.focus({ preventScroll: true }); } catch { target.focus(); } }
      return row;
    }

    // ── open / close ───────────────────────────────────────────────────────────────────────────────────────────
    function onKey(e) {
      if (!st || !(e.key === 'Escape' || e.key === 'Esc')) return;
      const h = helpOf();
      if (h && typeof h.isOpen === 'function' && h.isOpen()) return;   // the ⓘ panel closes first
      if (e.preventDefault) e.preventDefault();
      close();
    }
    function close(restoreFocus) {
      const s = st;
      if (!s) return;
      st = null;
      for (const off of s.offs) { try { if (typeof off === 'function') off(); } catch { /* gone */ } }
      try { doc.removeEventListener('keydown', onKey); } catch { /* gone */ }
      if (s.guard) { try { s.guard.closed(s.panel); } catch { /* no guard entry */ } }
      if (s.panel.parentNode) s.panel.parentNode.removeChild(s.panel);
      try { const h = win && win.location && win.location.hash; if (parseCardHash(h) && win.history && win.history.replaceState) win.history.replaceState(null, '', win.location.pathname + (win.location.search || '')); } catch { /* the address stays */ }
      if (restoreFocus !== false && s.opener && s.opener.focus && s.opener.isConnected !== false) { try { s.opener.focus(); } catch { /* gone */ } }
    }

    /** Open the card for an agent; resolves true when it is showing (false: no such agent, or this person may not open it). */
    async function open(name, where) {
      if (!doc || !name) return false;
      const w = where || {};
      const opener = doc.activeElement || null;
      const [records, me] = await Promise.all([loadRecords(), loadMe()]);
      const got = await readAgent(name, false);
      if (!got.agent || !mayOpen(got.agent, me)) return false;
      if (st && st.name === name && st.panel.isConnected !== false) { st.agent = got.agent; st.list = got.list; st.records = records; st.me = me; }
      else {
        if (st) close(false);
        const phone = isPhone();
        const panel = mk('div', 'ac-panel' + (phone ? ' ac-sheet' : ''));
        panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-labelledby', 'ac-title'); panel.setAttribute('tabindex', '-1'); panel.setAttribute('data-agent', name);
        if (phone) panel.setAttribute('aria-modal', 'true');
        const head = mk('header', 'ac-header');
        const body = mk('div', 'ac-body');
        panel.appendChild(head); panel.appendChild(body);
        const guard = phone ? (val(o.guard) || null) : null;
        st = {
          name, agent: got.agent, list: got.list, me, records, simple: isSimple(), panel, head, body, opener, guard, offs: [], ticket: 0,
          open: new Set(['basics']), more: new Set(), errors: new Map(), saving: new Set(), rowEls: new Map(), ctls: new Map(), infos: new Map(),
        };
        doc.body.appendChild(panel);
        if (guard) { try { guard.open(panel, { close: () => close() }); } catch { /* no guard here */ } }
        doc.addEventListener('keydown', onKey);
        st.offs.push(subscribeFn('agent_updated', onAgentEvent), subscribeFn('agent_renamed', onRenamed), subscribeFn('settings_changed', () => { refresh(); }));
      }
      // the door: the row's section and its More open first, so the row exists when the scroll starts
      let rec = null;
      if (w.row) rec = st.records.find((r) => r.id === w.row) || null;
      const secKey = rec && sectionOfRecord(rec) ? sectionOfRecord(rec).key : w.section;
      if (secKey && sectionsFor(st.me, st.simple).includes(secKey)) {
        st.open.add(secKey);
        if (rec && !isBottom(rec)) { const sp = splitSection(st.records, SECTIONS.find((s) => s.key === secKey), firstRows); if (sp.more.includes(rec)) st.more.add(secKey); }
      }
      render();
      if (st.panel.focus && !w.row) { try { st.panel.focus(); } catch { /* gone */ } }
      if (rec && st.rowEls.get(rec.id)) goToRow(rec.id);
      return true;
    }

    return {
      open, close, refresh, isOpen: () => !!st, register, registerMany, sectionsFor,
      state: () => st, el: () => (st ? st.panel : null),
    };
  }

  // ── the page's card ─────────────────────────────────────────────────────────────────────────────────────────
  const conf = {};
  let shared = null;
  const card = () => shared || (shared = createCard(Object.assign({ win: rootWin, doc: typeof document !== 'undefined' ? document : null }, conf)));
  function configure(o) { Object.assign(conf, o || {}); shared = null; }
  let doorOn = false;
  /** A page calls this once: follow #agent-card=<name>[&row=OPT-xxxx] now and on every hash change. Returns the follow function. */
  function cardDoorStart(env) {
    const e = env || {};
    const W = e.win || rootWin;
    const c = e.card || card();
    const run = () => { const h = parseCardHash(W && W.location ? W.location.hash : ''); if (h) return c.open(h.name, { row: h.row, section: h.section }); return Promise.resolve(false); };
    if (doorOn && !e.force) return run;
    doorOn = true;
    if (W && W.addEventListener) W.addEventListener('hashchange', () => { run(); });
    run();
    return run;
  }

  return {
    SECTIONS, FIRST_ROWS, TEXT, createCard, sectionsFor, mayOpen, parseCardHash, firstLine, groupName, moreLine, splitSection, roleLine, patchAgent, configure, cardDoorStart,
    open: (n, w) => card().open(n, w), close: (f) => (shared ? shared.close(f) : undefined), isOpen: () => !!(shared && shared.isOpen()),
    refresh: () => (shared ? shared.refresh() : Promise.resolve()), register, registerMany, setFirstRows,
  };
});
