/**
 * ui-settings-help.js — the ⓘ help beside a setting, and search by other words (shared by the desktop page, the phone page,
 * the phone's Settings frame, agent-settings.html and users.html).
 *
 * The records come from GET /api/settings-records ({ version, leadTool, records: [...] }); each record carries the help
 * text and a list of anchors { surface, selector }. After a screen is drawn, attach() finds each anchored control and puts
 * ONE ⓘ button right after its label. The screens' own markup is never touched.
 *
 *   load(force)                          the records (fetched once per page load; force = fetch again, e.g. when Settings opens)
 *   mount(root, surface, { refetch })    load, attach, and watch root for rows added later (stops when root leaves the page)
 *   attach(root, surface)                insert the ⓘ buttons now (idempotent); returns how many were added
 *   open(recordId, button, opts)         the panel (wide screens) or bottom sheet (phone frame, narrow, phone page)
 *   close(restoreFocus)                  close the open panel
 *   whoLines(record, leadTool)           the "Who can change it" lines
 *   sectionWords(root, surface, sel)     Map(section -> [{ row, text }]) of what each anchored control is also known as
 *   askText(name), parseAskHash(hash), askFill(text, env), handleAskHash(hash, env)   "Ask Maestro about this"
 *
 * Text is always set with textContent. Colours come from CSS variables in each page. Browser: window.hubSettingsHelp.
 * Node (tests): module.exports (every function takes the document / window it should use through opts, or uses the globals).
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.hubSettingsHelp = api;
})(typeof window !== 'undefined' ? window : null, function (rootWin) {
  'use strict';
  const HEADINGS = { what: 'What it does', when: 'When to change it', risk: 'Cost or risk', def: 'Default and our recommendation', restart: 'Restart needed' };
  const ASK_MAX = 600;
  let recs = new Map();       // id -> record
  let leadTool = false;
  let ready = false;
  let pending = null;         // the fetch in flight
  let panel = null;           // the open panel: { el, scrim, button, off }
  const labelOf = new WeakMap();   // ⓘ button -> the label text it sits after

  function win() { return rootWin || (typeof window !== 'undefined' ? window : null); }
  function dc(opts) { return (opts && opts.doc) || (typeof document !== 'undefined' ? document : null); }

  // ── records ─────────────────────────────────────────────────────────────────────────────────────────────
  function setRecords(json) {
    const m = new Map();
    const list = json && Array.isArray(json.records) ? json.records : [];
    for (const r of list) if (r && typeof r.id === 'string' && r.id) m.set(r.id, r);
    recs = m; leadTool = !!(json && json.leadTool === true); ready = true;
  }
  function load(force, fetchFn) {
    const f = fetchFn || (win() && win().fetch ? win().fetch.bind(win()) : null);
    if (pending && !force) return pending;
    if (ready && !force) return Promise.resolve(recs);
    if (!f) return Promise.resolve(recs);
    const p = Promise.resolve().then(() => f('/api/settings-records', { credentials: 'include' }))
      .then((r) => (r && r.ok ? r.json() : null))
      .then((j) => { if (j) setRecords(j); return recs; })
      .catch(() => recs)   // no help this time; the screens work as they did
      .then((v) => { if (pending === p) pending = null; return v; });
    pending = p;
    return p;
  }
  /** A record that was merged into another shows its target's help under its own name. */
  function resolve(id) {
    let r = recs.get(id);
    if (!r) return null;
    const own = r;
    for (let i = 0; i < 5 && r && r.mergedInto && recs.get(r.mergedInto); i++) r = recs.get(r.mergedInto);
    return r === own ? own : Object.assign({}, r, { id: own.id, name: own.name || r.name, labels: own.labels || r.labels, anchors: own.anchors });
  }

  // ── attach ──────────────────────────────────────────────────────────────────────────────────────────────
  const cls = (el) => String((el && el.getAttribute && el.getAttribute('class')) || el.className || '');
  const hasCls = (el, c) => (' ' + cls(el) + ' ').indexOf(' ' + c + ' ') >= 0;
  const tag = (el) => String((el && el.tagName) || '').toUpperCase();
  const ROW_CLASSES = ['st-row', 'row', 'as-row', 'field', 'form-row', 'section'];   // 'section': agent-settings.html's blocks (label, then the control)
  function isRow(el) { return ROW_CLASSES.some((c) => hasCls(el, c)); }
  function closestTag(el, t, stop) { for (let n = el; n && n !== stop; n = n.parentNode) if (tag(n) === t) return n; return null; }
  function closestRow(el, stop) { for (let n = el; n && n !== stop; n = n.parentNode) if (n !== el && isRow(n)) return n; return null; }
  function contains(a, b) { for (let n = b; n; n = n.parentNode) if (n === a) return true; return false; }

  /** The control's label: label[for=id]; else the label that wraps it; else the closest row's first label; else the row's first text-bearing child. */
  function findLabel(ctl, root) {
    const id = ctl.getAttribute && ctl.getAttribute('id');
    if (id) for (const l of root.querySelectorAll('label')) if (l.getAttribute('for') === id) return l;
    const wrap = closestTag(ctl, 'LABEL', root);
    if (wrap) return wrap;
    const row = closestRow(ctl, root);
    if (!row) return null;
    const first = row.querySelector('label');
    if (first && !contains(first, ctl)) return first;
    for (const c of row.children || []) {
      if (c === ctl || contains(c, ctl) || ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A'].includes(tag(c))) continue;
      if (hasCls(c, 'st-info') || String(c.textContent || '').trim()) return c;
    }
    return null;
  }

  /** A label as the records spell it: trim, collapse spaces, drop a leading emoji/symbol run, a trailing ":" or "…", and a trailing (note) when the label is longer than 40 characters with it. The generator and attach() share this. */
  function normLabel(s) {
    let t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    t = t.replace(/^[\p{Extended_Pictographic}\p{S}\uFE0F\u200D\s]+/u, '');
    const tail = (x) => x.replace(/(?:[\s:…]|\.{3})+$/u, '');
    t = tail(t);
    if (t.length > 40) t = tail(t.replace(/\s*\([^()]*\)$/, ''));
    return t;
  }
  /** The element's own words: its text without the text of any input, select, button or textarea inside it. */
  function ownText(el) {
    let t = String(el.textContent || '');
    const inner = el.querySelectorAll ? el.querySelectorAll('input, select, button, textarea') : [];
    for (const c of inner) { const ct = String(c.textContent || ''); if (ct) t = t.replace(ct, ''); }
    return t;
  }
  const LABEL_TAGS = ['LABEL', 'LEGEND', 'SUMMARY', 'H3', 'H4'];
  const LABEL_CLASSES = ['ss-title', 'sm-lab'];
  function isLabelCandidate(e) {
    const t = tag(e);
    if (LABEL_TAGS.includes(t)) return true;
    const c = cls(e).split(/\s+/).filter(Boolean);
    if (c.some((x) => LABEL_CLASSES.includes(x) || /-label$/.test(x) || /-title$/.test(x))) return true;
    const p = e.parentNode;
    if (t === 'SPAN' && p && hasCls(p, 'st-row')) return true;
    if (t === 'LABEL' && p && hasCls(p, 'vs-row')) return true;
    return false;
  }
  /** Where an ⓘ goes for a label-like element: right after it, or after the outermost label or button around it (never inside a wrapping label or a button). */
  function insertionPoint(el, root) {
    let out = el;
    for (let n = el.parentNode; n && n !== root; n = n.parentNode) if (tag(n) === 'LABEL' || tag(n) === 'BUTTON') out = n;
    return out;
  }
  /** Map(lower-case normalised text -> [insertion points]) of every label-like element in root (the open help panel excluded). */
  function labelIndex(root) {
    const idx = new Map();
    let all = [];
    try { all = root.querySelectorAll('*'); } catch { return idx; }
    for (const e of all) {
      if (!isLabelCandidate(e)) continue;
      let inPanel = false;
      for (let n = e; n && n !== root; n = n.parentNode) if (hasCls(n, 'st-help-panel')) { inPanel = true; break; }
      if (inPanel) continue;
      const key = normLabel(ownText(e)).toLowerCase();
      if (!key) continue;
      const at = insertionPoint(e, root);
      const list = idx.get(key) || [];
      if (!list.includes(at)) list.push(at);
      idx.set(key, list);
    }
    return idx;
  }
  const hasInfoAfter = (at) => { const n = at.nextSibling; return !!(n && tag(n) === 'BUTTON' && hasCls(n, 'st-info')); };
  /** Only settings and indicators get an ⓘ, and records merged into another (they open the target's help); never doors or actions. */
  const wantsInfo = (rec) => !rec.kind || rec.kind === 'setting' || rec.kind === 'indicator' || !!rec.mergedInto;
  function makeInfo(d, rec, labText, opts) {
    const b = d.createElement('button');
    b.setAttribute('type', 'button');
    b.setAttribute('class', 'st-info');
    b.setAttribute('data-rec', rec.id);
    b.setAttribute('aria-label', 'About ' + (rec.name || labText || 'this setting'));
    b.setAttribute('aria-haspopup', 'dialog');
    b.textContent = 'ⓘ';
    b.addEventListener('click', (e) => { if (e && e.preventDefault) e.preventDefault(); if (e && e.stopPropagation) e.stopPropagation(); open(rec.id, b, opts); });
    labelOf.set(b, labText);
    return b;
  }

  function attach(root, surface, opts) {
    const d = dc(opts) || (root && root.ownerDocument) || null;
    if (!root || !d || !root.querySelectorAll) return 0;
    let added = 0;
    for (const rec of recs.values()) {
      if (!wantsInfo(rec)) continue;
      for (const a of Array.isArray(rec.anchors) ? rec.anchors : []) {
        if (!a || a.surface !== surface || !a.selector) continue;
        let hits;
        try { hits = root.querySelectorAll(a.selector); } catch { continue; }   // a selector this page cannot read: no ⓘ
        for (const ctl of hits) {
          if (!ctl || (ctl.getAttribute && ctl.getAttribute('data-help-rec'))) continue;   // marked: never twice
          let lab = findLabel(ctl, root);
          if (!lab) continue;
          const labText = String(lab.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
          // never inside a wrapping label or a button: go up to the outermost one and insert after it
          for (let n = lab.parentNode; n && n !== root; n = n.parentNode) if (tag(n) === 'LABEL' || tag(n) === 'BUTTON') lab = n;
          const after = lab.nextSibling;
          if (after && tag(after) === 'BUTTON' && after.getAttribute('data-rec') === rec.id) { ctl.setAttribute('data-help-rec', rec.id); continue; }
          lab.parentNode.insertBefore(makeInfo(d, rec, labText, opts), after);
          ctl.setAttribute('data-help-rec', rec.id);
          added++;
        }
      }
    }
    // anchors by label: used where the row has no id. Exactly one label-like element in root must carry the words.
    let index = null;
    for (const rec of recs.values()) {
      if (!wantsInfo(rec)) continue;
      for (const a of Array.isArray(rec.anchors) ? rec.anchors : []) {
        if (!a || a.surface !== surface || typeof a.label !== 'string' || a.selector) continue;
        const key = normLabel(a.label).toLowerCase();
        if (!key) continue;
        if (!index) index = labelIndex(root);
        const hits = index.get(key) || [];
        if (hits.length !== 1) continue;   // none, or ambiguous: no ⓘ
        const at = hits[0];
        if (!at.parentNode || hasInfoAfter(at)) continue;
        const labText = normLabel(ownText(at)).slice(0, 120);
        at.parentNode.insertBefore(makeInfo(d, rec, labText, opts), at.nextSibling);
        added++;
      }
    }
    return added;
  }

  /** Load the records, put the ⓘ buttons in, and keep doing so while rows are added to root. */
  function mount(root, surface, opts) {
    const o = opts || {};
    return load(!!o.refetch, o.fetch).then(() => {
      if (!root) return 0;
      const n = attach(root, surface, o);
      watch(root, surface, o);
      return n;
    });
  }
  const watching = new WeakSet();
  function watch(root, surface, opts) {
    const W = (opts && opts.win) || win();
    const MO = (opts && opts.MutationObserver) || (W && W.MutationObserver);
    if (!MO || !root || watching.has(root)) return null;
    watching.add(root);
    let timer = null;
    const mo = new MO(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (root.isConnected === false) { mo.disconnect(); watching.delete(root); return; }   // the dialog is gone
        attach(root, surface, opts);
      }, 40);
    });
    mo.observe(root, { childList: true, subtree: true });
    return mo;
  }

  // ── the panel ───────────────────────────────────────────────────────────────────────────────────────────
  function whoLines(rec, lead) {
    const lines = [];
    const scope = String((rec && rec.scope) || '');
    if (/^per-person\b/i.test(scope)) lines.push('Each person sets their own.');
    else if (rec && rec.danger === 'dangerous') lines.push('Only an admin, on this screen, and the change is logged.');
    else if (rec && rec.who === 'admin') lines.push('An admin, on this screen.');
    else lines.push('Anyone who can open this screen.');
    if (lead === true && rec) {   // the record's own lead field: apply (with undo), confirm (a card first), screen or none (no line)
      if (rec.lead === 'apply') lines.push('You can also ask your Maestro to change it.');
      else if (rec.lead === 'confirm') lines.push('Your Maestro can change it after you confirm.');
    }
    return lines;
  }
  function askText(name) { return 'Tell me about the setting “' + name + '”: what it does here and whether I should change it.'; }

  function sheetMode(opts) {
    if (opts && typeof opts.sheet === 'boolean') return opts.sheet;
    const W = (opts && opts.win) || win();
    try {
      const d = dc(opts);
      if (d && d.documentElement && d.documentElement.classList && d.documentElement.classList.contains('mm-settings-only')) return true;
      if (W && W.location && /^\/mobile(\/|$)/.test(W.location.pathname || '')) return true;
      if (W && W.innerWidth && W.innerWidth < 700) return true;
    } catch { /* wide */ }
    return false;
  }

  function close(restoreFocus) {
    const p = panel;
    if (!p) return;
    panel = null;
    try { p.off(); } catch { /* listeners already gone */ }
    if (p.scrim && p.scrim.parentNode) p.scrim.parentNode.removeChild(p.scrim);
    if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
    if (p.button.setAttribute) p.button.setAttribute('aria-expanded', 'false');
    if (restoreFocus !== false && p.button.focus) { try { p.button.focus(); } catch { /* gone from the page */ } }
  }

  function place(p, sheet, W) {
    if (sheet || !W) return;
    const r = p.button.getBoundingClientRect ? p.button.getBoundingClientRect() : { left: 0, right: 0, top: 0, bottom: 0 };
    const vw = W.innerWidth || 1024, vh = W.innerHeight || 768;
    const w = Math.min(360, vw - 16), h = p.el.offsetHeight || 0;
    const right = r.right + 10;
    let left = right + w <= vw - 8 ? right : (r.left - 10 - w >= 8 ? r.left - 10 - w : Math.max(8, Math.min(r.left, vw - w - 8)));   // beside it, flipped to the left, else clamped
    let top = Math.max(8, Math.min(r.top - 8, vh - h - 8));
    p.el.style.left = Math.round(left) + 'px';
    p.el.style.top = Math.round(top) + 'px';
  }

  function open(recordId, button, opts) {
    const d = dc(opts) || (button && button.ownerDocument);
    const W = (opts && opts.win) || win();
    const rec = resolve(recordId);
    if (!d || !rec || !button) return null;
    const same = panel && panel.button === button;
    if (panel) close(false);
    if (same) { if (button.focus) button.focus(); return null; }   // pressing the same ⓘ again closes it
    const sheet = sheetMode(opts);
    const el = d.createElement('div');
    el.setAttribute('class', 'st-help-panel' + (sheet ? ' st-help-sheet' : ''));
    el.setAttribute('role', 'dialog');
    el.setAttribute('tabindex', '-1');
    el.setAttribute('data-rec', rec.id);
    const titleId = 'st-help-title';
    el.setAttribute('aria-labelledby', titleId);
    const head = d.createElement('div'); head.setAttribute('class', 'st-help-head');
    const title = d.createElement('div'); title.setAttribute('class', 'st-help-title'); title.setAttribute('id', titleId);
    const name = String(rec.name || labelOf.get(button) || '');
    title.textContent = name;
    const today = labelOf.get(button);
    if (today && today.toLowerCase() !== name.toLowerCase()) {
      const small = d.createElement('small'); small.setAttribute('class', 'st-help-today'); small.textContent = ' ' + today;
      title.appendChild(small);
    }
    const x = d.createElement('button'); x.setAttribute('type', 'button'); x.setAttribute('class', 'st-help-x'); x.setAttribute('aria-label', 'Close'); x.textContent = '×';
    head.appendChild(title); head.appendChild(x); el.appendChild(head);
    const section = (heading, lines) => {
      const arr = (Array.isArray(lines) ? lines : [lines]).filter((t) => String(t || '').trim());
      if (!arr.length) return;
      const h = d.createElement('div'); h.setAttribute('class', 'st-help-h'); h.textContent = heading; el.appendChild(h);
      for (const t of arr) { const p = d.createElement('p'); p.setAttribute('class', 'st-help-p'); p.textContent = String(t); el.appendChild(p); }
    };
    section(HEADINGS.what, rec.what);
    section(HEADINGS.when, rec.when);
    section(HEADINGS.risk, rec.risk);
    section(HEADINGS.def, rec.def);
    section(HEADINGS.restart, rec.restart === true ? 'Yes. Saved now; it takes effect after your Maestro restarts.' : 'No.');
    section('Who can change it', whoLines(rec, leadTool));
    const ask = d.createElement('button'); ask.setAttribute('type', 'button'); ask.setAttribute('class', 'st-help-ask'); ask.textContent = 'Ask Maestro about this';
    el.appendChild(ask);

    const host = closestOpenDialog(button) || d.body;   // inside a modal <dialog>, or it would sit under it
    let scrim = null;
    if (sheet) { scrim = d.createElement('div'); scrim.setAttribute('class', 'st-help-scrim'); host.appendChild(scrim); }
    host.appendChild(el);
    button.setAttribute('aria-expanded', 'true');

    const p = { el, scrim, button, off: null };
    const onKey = (e) => {
      if (e.key === 'Escape' || e.key === 'Esc') { if (e.preventDefault) e.preventDefault(); if (e.stopPropagation) e.stopPropagation(); close(true); return; }
      if (e.key === 'Tab') {   // kept inside the panel; the Settings dialog's own Tab handling stays out of it
        if (e.stopPropagation) e.stopPropagation();
        const f = [x, ask], a = d.activeElement, i = f.indexOf(a);
        if (e.preventDefault) { if (e.shiftKey ? (i <= 0) : (i === f.length - 1 || i < 0)) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0].focus(); } }
      }
    };
    el.addEventListener('keydown', onKey);
    x.addEventListener('click', () => close(true));
    ask.addEventListener('click', () => {
      const text = askText(name);
      close(false);
      askLead(text, opts);
    });
    const onDoc = (e) => { const t = e && e.target; if (!contains(el, t) && !contains(button, t)) close(false); };
    const onResize = () => close(false);
    const onScroll = () => place(p, sheet, W);
    d.addEventListener('pointerdown', onDoc, true);
    if (scrim) scrim.addEventListener('click', () => close(true));
    if (W && W.addEventListener) { W.addEventListener('resize', onResize); W.addEventListener('scroll', onScroll, true); }
    p.off = () => { d.removeEventListener('pointerdown', onDoc, true); if (W && W.removeEventListener) { W.removeEventListener('resize', onResize); W.removeEventListener('scroll', onScroll, true); } };
    panel = p;
    place(p, sheet, W);
    if (el.focus) el.focus();
    return el;
  }
  function closestOpenDialog(el) { for (let n = el && el.parentNode; n; n = n.parentNode) if (tag(n) === 'DIALOG') return n; return null; }
  function isOpen() { return !!panel; }

  // ── Ask Maestro about this ──────────────────────────────────────────────────────────────────────────────
  /** Where the lead's chat lives, from here: this page fills its own box (window.mmAskLead, set by app.js / mobile.js); a separate page or the phone's frame sends the top window there. */
  function askLead(text, opts) {
    const W = (opts && opts.win) || win();
    if (!W) return false;
    if (typeof W.mmAskLead === 'function') { try { W.mmAskLead(text); return true; } catch { return false; } }
    const d = dc(opts);
    const phone = !!(d && d.documentElement && d.documentElement.classList && d.documentElement.classList.contains('mm-settings-only'));
    const url = (phone ? '/mobile' : '/') + '#ask-lead=' + encodeURIComponent(text);
    try { (W.top || W).location.href = url; return true; } catch { try { W.location.href = url; return true; } catch { return false; } }
  }
  function parseAskHash(hash) {
    const m = /^#ask-lead=(.*)$/.exec(String(hash || ''));
    if (!m) return null;
    let t;
    try { t = decodeURIComponent(m[1]); } catch { return null; }
    t = t.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, ASK_MAX);
    return t || null;
  }
  /** Open the lead's chat and put the text in its message box. Never sends. env: { findLead() -> { name }, openChat(name), getBox(name) -> element, beforeOpen?() } */
  async function askFill(text, env) {
    if (!text || !env) return false;
    const lead = env.findLead && env.findLead();
    if (!lead) return false;
    if (env.beforeOpen) { try { env.beforeOpen(); } catch { /* a dialog that would not close */ } }
    await env.openChat(lead.name);
    let box = null;
    for (let i = 0, n = env.tries || 20; i < n && !box; i++) {
      box = env.getBox(lead.name);
      if (!box) await new Promise((r) => setTimeout(r, 50));
    }
    if (!box) return false;
    box.value = text;
    try { box.dispatchEvent(new (win() && win().Event ? win().Event : Event)('input', { bubbles: true })); } catch { /* no events here */ }
    if (box.focus) box.focus();
    return true;
  }
  /** A #ask-lead=<text> address: fill the lead's box, then drop the hash. Returns the promise (false when the hash is not ours). */
  function handleAskHash(hash, env) {
    const text = parseAskHash(hash);
    if (text === null) return Promise.resolve(false);
    if (env && env.clearHash) { try { env.clearHash(); } catch { /* the hash stays */ } }
    return askFill(text, env);
  }

  // ── search by other words ───────────────────────────────────────────────────────────────────────────────
  /** Map(section element -> [{ row, text }]): for each record anchored inside a section, its name, labels, words and what (lower case). */
  function sectionWords(root, surface, sectionSel) {
    const out = new Map();
    if (!root || !root.querySelectorAll) return out;
    for (const rec of recs.values()) {
      const text = [rec.name, ...(Array.isArray(rec.labels) ? rec.labels : []), ...(Array.isArray(rec.words) ? rec.words : []), rec.what].filter(Boolean).join(' ').toLowerCase();
      if (!text) continue;
      for (const a of Array.isArray(rec.anchors) ? rec.anchors : []) {
        if (!a || a.surface !== surface || !a.selector) continue;
        let hits;
        try { hits = root.querySelectorAll(a.selector); } catch { continue; }
        for (const ctl of hits) {
          let sec = null;
          for (let n = ctl; n && n !== root; n = n.parentNode) if (hasCls(n, (sectionSel || 'st-section').replace(/^\./, ''))) { sec = n; break; }
          if (!sec) continue;
          const row = closestRow(ctl, sec) || ctl;
          if (!out.has(sec)) out.set(sec, []);
          out.get(sec).push({ row, text });
        }
      }
    }
    return out;
  }

  return { HEADINGS, load, mount, attach, watch, open, close, isOpen, resolve, whoLines, normLabel, askText, askLead, parseAskHash, askFill, handleAskHash, sectionWords, sheetMode, setRecords, ready: () => ready, records: () => recs, leadTool: () => leadTool };
});
