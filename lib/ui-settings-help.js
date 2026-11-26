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

  const FORM_TAGS = ['INPUT', 'SELECT', 'TEXTAREA'];
  const isFormCtl = (e) => FORM_TAGS.includes(tag(e)) && String((e.getAttribute && e.getAttribute('type')) || '').toLowerCase() !== 'hidden';
  const holdsFormCtl = (e) => isFormCtl(e) || (e.querySelectorAll ? [...e.querySelectorAll('input, select, textarea')].some(isFormCtl) : false);
  const words = (e) => String(ownText(e) || '').replace(/\s+/g, ' ').trim();

  /** A container anchored as a whole (a section): its first element child when that is a heading (H2-H6) or a title element with words; that is its label. Never for a control, a label or a row. */
  function sectionHeading(el) {
    if (!el || isFormCtl(el) || ['LABEL', 'BUTTON', 'A', 'SPAN'].includes(tag(el)) || isRow(el)) return null;
    const k = el.children && el.children[0];
    if (!k) return null;
    const isTitle = /^H[2-6]$/.test(tag(k)) || cls(k).split(/\s+/).some((x) => x === 'ss-title' || /-title$/.test(x));
    return isTitle && words(k) ? k : null;
  }
  /**
   * The control's own label, or null. Never: a label that points at another id, one that belongs to another control in the
   * same row (the nearest label before a control is that control's), an empty one, or a section's heading for a control
   * deep inside the section.
   */
  function findLabel(ctl, root) {
    return findLabelBase(ctl, root) || (closestRow(ctl, root) ? prevTextLabel(ctl, root) : null);   // only inside a settings row or section: a control in a header or a bare block keeps its ⓘ after it
  }
  const PREV_TEXT_TAGS = ['SPAN', 'DIV', 'P', 'B', 'STRONG', 'SMALL', 'H2', 'H3', 'H4', 'H5', 'H6'];
  /** Last rule: the control's previous element sibling when it is a plain text element (words, no control, button or link inside) that is not the label of another control. */
  function prevTextLabel(ctl, root) {
    const sibs = ctl.parentNode && ctl.parentNode.children ? [...ctl.parentNode.children] : [];
    const p = sibs[sibs.indexOf(ctl) - 1];
    if (!p || !PREV_TEXT_TAGS.includes(tag(p)) || hasCls(p, 'st-info') || !words(p) || isLabelCandidate(p)) return null;   // a title or heading that labels by its own words (labelIndex) stays free for the record anchored on those words
    if (holdsFormCtl(p) || (p.querySelectorAll && [...p.querySelectorAll('button, a')].some((x) => !hasCls(x, 'st-info')))) return null;
    const pid = p.getAttribute && p.getAttribute('id');
    if (pid && root.querySelectorAll) for (const l of root.querySelectorAll('label')) if (l.getAttribute('for') === pid) return null;
    return p;
  }
  function findLabelBase(ctl, root) {
    const head = sectionHeading(ctl);
    if (head) return head;
    const id = ctl.getAttribute && ctl.getAttribute('id');
    if (id) for (const l of root.querySelectorAll('label')) if (l.getAttribute('for') === id) return words(l) ? l : null;
    const wrap = closestTag(ctl, 'LABEL', root);
    if (wrap) { const f = wrap.getAttribute('for'); return (!f || f === id) && words(wrap) ? wrap : null; }
    const row = closestRow(ctl, root);
    if (!row) return null;
    const sectionRow = hasCls(row, 'section');
    const ok = (c) => !sectionRow || c.parentNode === ctl.parentNode;   // a heading label does not speak for a control deep in the section
    // 1. labels, in document order: the nearest one before the control (a later control resets it), else the first after it
    let before = null, after = null, passed = false, stop = false;
    const visit = (n) => {
      for (const c of n.children || []) {
        if (stop) return;
        if (c === ctl) { passed = true; continue; }
        if (tag(c) === 'LABEL') {
          if (contains(c, ctl)) continue;
          if (holdsFormCtl(c)) { if (passed) { stop = true; return; } before = null; continue; }   // wraps another control: its label
          const f = c.getAttribute('for');
          if ((f && f !== id) || !words(c) || !ok(c)) continue;
          if (!passed) before = c; else if (!after) after = c;
          continue;
        }
        if (isFormCtl(c)) { if (passed) { stop = true; return; } before = null; continue; }
        visit(c);
      }
    };
    visit(row);
    if (before || after) return before || after;
    // 2. the row's text-bearing child (a span or div with the words), with the same rule about other controls
    let cand = null, seen = false;
    for (const c of row.children || []) {
      if (c === ctl || contains(c, ctl)) { if (cand) return cand; seen = true; continue; }
      if (['BUTTON', 'A'].includes(tag(c))) continue;
      if (holdsFormCtl(c)) { if (seen) return null; cand = null; continue; }
      if (tag(c) === 'LABEL') continue;
      if (!cand && ok(c) && (hasCls(c, 'st-info') ? false : String(c.textContent || '').trim())) { if (seen) return c; cand = c; }
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
  const lastKid = (at) => { const k = at.children; return k && k.length ? k[k.length - 1] : null; };
  const hasInfoIn = (at) => { const n = lastKid(at); return !!(n && tag(n) === 'BUTTON' && hasCls(n, 'st-info')); };
  const hasInfo = (at) => hasInfoAfter(at) || hasInfoIn(at);
  /** The ⓘ already beside this element (inside it as its last child, or right after it), or null. */
  const infoOf = (at) => (hasInfoIn(at) ? lastKid(at) : (hasInfoAfter(at) ? at.nextSibling : null));
  const NO_ENTER = ['LABEL', 'BUTTON', 'A', 'SUMMARY', 'INPUT', 'SELECT', 'TEXTAREA', 'TABLE', 'TR', 'TD', 'UL', 'OL', 'LI', 'FORM', 'FIELDSET'];
  /** A plain text block: the ⓘ goes inside it, as its last child, so it flows after the words (never a label, a button, a link, a row, or anything holding a control or another button). */
  function enterable(el) {
    if (!el || NO_ENTER.includes(tag(el)) || isRow(el) || holdsFormCtl(el)) return false;
    if (el.parentNode && hasCls(el.parentNode, 'st-row')) return false;   // the desktop Settings rows are flex rows: their ⓘ stays a sibling, where it is today
    const inner = el.querySelectorAll ? [...el.querySelectorAll('button, a')] : [];
    return !inner.some((x) => !hasCls(x, 'st-info'));
  }
  /** The element's computed display, or '' when this window cannot say. */
  function displayOf(el, opts) {
    const W = (opts && opts.win) || (el.ownerDocument && el.ownerDocument.defaultView) || win();
    try { return W && typeof W.getComputedStyle === 'function' ? String((W.getComputedStyle(el) || {}).display || '') : ''; } catch { return ''; }
  }
  /** A LABEL that wraps its control and holds a text span: the span, where the ⓘ goes at the end of the words. */
  function textSpanOf(lab) {
    if (tag(lab) !== 'LABEL' || !holdsFormCtl(lab)) return null;
    let found = null;
    for (const c of lab.children || []) {
      if (tag(c) !== 'SPAN' || holdsFormCtl(c) || hasCls(c, 'st-info') || !String(c.textContent || '').trim()) continue;
      found = c;   // the last text span
    }
    return found;
  }
  /** Put the ⓘ beside `at`: inside a text block, else right after it (a block LABEL then carries st-has-info so label and ⓘ share a line; a flex label keeps its own layout). */
  function putInfo(at, btn, canEnter, opts) {
    if (canEnter && enterable(at)) { at.appendChild(btn); return; }
    at.parentNode.insertBefore(btn, at.nextSibling);
    if (tag(at) === 'LABEL' && !hasCls(at, 'st-has-info') && displayOf(at, opts) === 'block') at.setAttribute('class', (cls(at) + ' st-has-info').trim());
  }
  /** Only settings and indicators get an ⓘ, and records merged into another (they open the target's help); never doors or actions. */
  const wantsInfo = (rec) => !rec.kind || rec.kind === 'setting' || rec.kind === 'indicator' || !!rec.mergedInto;
  function makeInfo(d, rec, labText, opts) {
    const b = d.createElement('button');
    b.setAttribute('type', 'button');
    b.setAttribute('class', 'st-info');
    b.setAttribute('data-rec', rec.id);
    b.setAttribute('aria-label', 'About ' + (rec.name || labText || 'this setting'));
    b.setAttribute('aria-haspopup', 'dialog');
    const g = d.createElement('span');   // the character is decoration: the button's name is its aria-label, and the block's words stay words
    g.setAttribute('aria-hidden', 'true');
    g.textContent = 'ⓘ';
    b.appendChild(g);
    b.addEventListener('click', (e) => { if (e && e.preventDefault) e.preventDefault(); if (e && e.stopPropagation) e.stopPropagation(); open(rec.id, b, opts); });
    labelOf.set(b, labText);
    return b;
  }

  /**
   * The rows of this surface that records anchor, resolved once for attach() and for the search index:
   * [{ rec, ctl }] for a selector anchor (the control), [{ rec, at }] for a label anchor (the one label-like element
   * carrying the words; none or several: not listed). Selector anchors first. all=false: only the records that get an ⓘ.
   */
  function anchorRows(root, surface, all) {
    const out = [], labelRows = [];
    let index = null;
    for (const rec of recs.values()) {
      if (!all && !wantsInfo(rec)) continue;
      for (const a of Array.isArray(rec.anchors) ? rec.anchors : []) {
        if (!a || a.surface !== surface) continue;
        if (a.selector) {
          let hits;
          try { hits = root.querySelectorAll(a.selector); } catch { continue; }   // a selector this page cannot read: no row
          for (const ctl of hits) if (ctl) out.push({ rec, ctl });
        } else if (typeof a.label === 'string') {
          const key = normLabel(a.label).toLowerCase();
          if (!key) continue;
          if (!index) index = labelIndex(root);
          const hits = index.get(key) || [];
          if (hits.length === 1) labelRows.push({ rec, at: hits[0] });   // none, or ambiguous: no row
        }
      }
    }
    return out.concat(labelRows);
  }

  function attach(root, surface, opts) {
    const d = dc(opts) || (root && root.ownerDocument) || null;
    if (!root || !d || !root.querySelectorAll) return 0;
    let added = 0;
    for (const row of anchorRows(root, surface, false)) {
      const rec = row.rec;
      if (row.at) {   // anchored by label text: the ⓘ goes right after that element
        const at = row.at;
        if (!at.parentNode || hasInfo(at)) continue;
        const labText = normLabel(ownText(at)).slice(0, 120);
        putInfo(at, makeInfo(d, rec, labText, opts), true, opts);
        added++;
        continue;
      }
      const ctl = row.ctl;
      if (ctl.getAttribute && ctl.getAttribute('data-help-rec')) continue;   // marked: never twice
      let lab = findLabel(ctl, root);
      let labText = lab ? words(lab).slice(0, 120) : '';   // the label's own words: never the ⓘ's character
      let at = lab || ctl;   // no label of its own: right after the control
      // never inside a wrapping label or a button: go up to the outermost one and insert after it
      for (let n = at.parentNode; n && n !== root; n = n.parentNode) if (tag(n) === 'LABEL' || tag(n) === 'BUTTON') at = n;
      let canEnter = !!lab && at === lab;   // only a text block found as the label is entered; a control, or the outside of a wrapping label, is not
      if (canEnter && contains(lab, ctl)) {   // a label that wraps its control and holds a text span: the ⓘ ends that span (a button inside a label does not toggle the control)
        const sp = textSpanOf(lab);
        if (sp) at = sp;
      }
      const mine = (x) => { const i = infoOf(x); return !!i && i.getAttribute('data-rec') === rec.id; };
      if (lab && hasInfo(at) && !mine(at)) { at = ctl; labText = ''; canEnter = false; for (let n = at.parentNode; n && n !== root; n = n.parentNode) if (tag(n) === 'LABEL' || tag(n) === 'BUTTON') at = n; }   // one label, one ⓘ: this record's goes after its own control
      if (!at.parentNode) continue;
      if (mine(at)) { ctl.setAttribute('data-help-rec', rec.id); continue; }
      putInfo(at, makeInfo(d, rec, labText, opts), canEnter, opts);
      ctl.setAttribute('data-help-rec', rec.id);
      added++;
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
    let timer = null, last = 0, dirty = false;
    const mo = new MO((muts) => {
      if (root.isConnected === false) { mo.disconnect(); watching.delete(root); return; }   // the dialog is gone
      if (!relevant(muts)) return;   // only our own ⓘ or panel, or text: nothing new that could carry an anchor
      dirty = true;
      if (timer) return;
      // at most one pass per WATCH_GAP_MS, however many bursts arrive; the first one soon
      timer = setTimeout(() => {
        timer = null;
        if (root.isConnected === false) { mo.disconnect(); watching.delete(root); return; }   // the dialog is gone
        if (!dirty) return;
        dirty = false; last = Date.now();
        attach(root, surface, opts);
      }, Math.max(40, WATCH_GAP_MS - (Date.now() - last)));
    });
    mo.observe(root, { childList: true, subtree: true });
    return mo;
  }
  const WATCH_GAP_MS = 250;
  const isOurs = (n) => hasCls(n, 'st-info') || hasCls(n, 'st-help-panel') || hasCls(n, 'st-help-scrim');
  /** Did the mutations add an element (not our own) that could hold an anchor? A record without addedNodes is taken as yes. */
  function relevant(muts) {
    if (!muts || !muts.length) return true;
    for (const m of muts) {
      if (!m || !m.addedNodes) return true;
      for (const n of m.addedNodes) if (n && (n.nodeType === 1 || (n.nodeType === undefined && n.tagName)) && !isOurs(n)) return true;
    }
    return false;
  }

  // ── the panel ───────────────────────────────────────────────────────────────────────────────────────────
  function whoLines(rec, lead) {
    const lines = [];
    const scope = String((rec && rec.scope) || '');
    const who = rec && rec.who, logged = rec && rec.danger === 'dangerous';
    if (/^per-person\b/i.test(scope)) lines.push('Each person sets their own.');
    else if (who === 'admin') lines.push(logged ? 'Only an admin, on this screen, and the change is logged.' : 'An admin, on this screen.');   // "Only an admin" is said only of admin records
    else if (who === 'member') lines.push(logged ? 'Any member, on this screen, and the change is logged.' : 'Any member, on this screen.');
    else lines.push(logged ? 'Anyone who can open this screen, and the change is logged.' : 'Anyone who can open this screen.');
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
    if (sheet) el.setAttribute('aria-modal', 'true');   // the bottom sheet has a scrim and holds focus; the popover stays non-modal
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
    const onDoc = (e) => {
      const t = e && e.target;
      if (scrim && t === scrim) return;   // the scrim's own click closes the sheet and returns focus to the ⓘ, like Escape
      if (!contains(el, t) && !contains(button, t)) close(false);
    };
    const width0 = W ? W.innerWidth : 0;
    const onResize = () => { if (!W || W.innerWidth !== width0) close(false); };   // a width change only: the phone's address bar changes the height
    const onScroll = () => { if (button.isConnected === false) close(false); else place(p, sheet, W); };
    d.addEventListener('pointerdown', onDoc, true);
    if (scrim) scrim.addEventListener('click', () => close(true));
    if (W && W.addEventListener) { W.addEventListener('resize', onResize); W.addEventListener('scroll', onScroll, true); }
    // the ⓘ that opened it left the page (a redraw): nothing to point at, so the panel goes too
    const MO = (opts && opts.MutationObserver) || (W && W.MutationObserver);
    let mo = null;
    if (MO) { try { mo = new MO(() => { if (button.isConnected === false) close(false); }); mo.observe(d.body || d.documentElement || d, { childList: true, subtree: true }); } catch { mo = null; } }
    p.off = () => { d.removeEventListener('pointerdown', onDoc, true); if (W && W.removeEventListener) { W.removeEventListener('resize', onResize); W.removeEventListener('scroll', onScroll, true); } if (mo) { try { mo.disconnect(); } catch { /* gone */ } } };
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
  /**
   * Ask a dialog to close through its guard and say whether it really did. requestClose(el) is the guard's own call
   * (ui-dialog.js requestClose returns 'closed', or 'confirm' while "Discard changes?" is up, 'busy', 'kept'): 'closed' is
   * answered at once; while the question is up this waits for it to go away and then looks whether the dialog is still there
   * (Keep editing = still there = false). A dialog the guard does not know ('none') is not held back.
   */
  async function closeGuarded(el, requestClose, opts) {
    if (!el) return true;
    const d = dc(opts) || el.ownerDocument;
    const present = () => el.isConnected !== false && (tag(el) !== 'DIALOG' || el.open !== false);
    let how;
    try { how = requestClose(el); } catch { return false; }
    if (!present()) return true;
    if (how === 'none') return true;
    if (how !== 'confirm') return false;
    const question = () => (d && d.querySelector ? d.querySelector('.dlg-discard') : null);
    const give = (opts && opts.waitMs) || 600000;
    for (let t = 0; question() && t < give; t += 50) await new Promise((r) => setTimeout(r, 50));
    return !present();
  }

  /** Open the lead's chat and put the text in its message box. Never sends, never replaces what is already typed there. env: { findLead() -> { name }, openChat(name), getBox(name) -> element, beforeOpen?() -> (promise of) false when Settings stayed open } */
  async function askFill(text, env) {
    if (!text || !env) return false;
    const lead = env.findLead && env.findLead();
    if (!lead) return false;
    if (env.beforeOpen) {   // only once Settings has really closed; Keep editing at "Discard changes?" = nothing else happens
      let closed = false;
      try { closed = (await env.beforeOpen()) !== false; } catch { closed = false; }
      if (!closed) return false;
    }
    await env.openChat(lead.name);
    let box = null;
    for (let i = 0, n = env.tries || 20; i < n && !box; i++) {
      box = env.getBox(lead.name);
      if (!box) await new Promise((r) => setTimeout(r, 50));
    }
    if (!box) return false;
    const have = String(box.value == null ? '' : box.value);
    const mine = have.trim();
    if (mine === text.trim() || mine.endsWith('\n' + text.trim())) { if (box.focus) box.focus(); return true; }   // the question is already there
    box.value = mine ? have.replace(/\s+$/, '') + '\n' + text : text;   // a draft stays; the question goes after it on a new line
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
    const secCls = (sectionSel || 'st-section').replace(/^\./, '');
    for (const r of anchorRows(root, surface, true)) {   // the same resolved rows attach() uses: selector anchors and label anchors alike
      const rec = r.rec;
      const text = [rec.name, ...(Array.isArray(rec.labels) ? rec.labels : []), ...(Array.isArray(rec.words) ? rec.words : []), rec.what].filter(Boolean).join(' ').toLowerCase();
      if (!text) continue;
      const ctl = r.ctl || r.at;
      let sec = null;
      for (let n = ctl; n && n !== root; n = n.parentNode) if (hasCls(n, secCls)) { sec = n; break; }
      if (!sec) continue;
      const row = closestRow(ctl, sec) || ctl;
      if (!out.has(sec)) out.set(sec, []);
      out.get(sec).push({ row, text });
    }
    return out;
  }

  // ── doors: #settings-for=OPT-xxxx (Settings) and #rec=OPT-xxxx (agent-settings.html) ──────────────────────────────
  const DOOR_RE = /^#(settings-for|rec)=(OPT-[A-Za-z0-9_-]{1,40})$/;
  /** { kind, id } for a door address, or null. which = 'settings-for' | 'rec' to accept only that one. */
  function parseDoorHash(hash, which) {
    const m = DOOR_RE.exec(String(hash || ''));
    if (!m || (which && m[1] !== which)) return null;
    return { kind: m[1], id: m[2] };
  }
  /** The row of a record on this surface: { rec, ctl, row, info } (info = its ⓘ button when it has one), or null (no anchor here). */
  function doorFind(root, surface, id) {
    if (!root || !root.querySelectorAll) return null;
    const hit = anchorRows(root, surface, true).find((r) => r.rec.id === id);
    if (!hit) return null;
    const ctl = hit.ctl || hit.at;
    let info = null;
    try { info = root.querySelector('button.st-info[data-rec="' + id + '"]'); } catch { info = null; }
    return { rec: hit.rec, ctl, row: closestRow(ctl, root) || ctl, info };
  }
  /**
   * Take the person to the record's row: opts.open(found) opens whatever holds it (the group), then the row scrolls into view,
   * gets the highlight class st-door-hit for 2 s, and its ⓘ (else the control) takes focus. Returns the found row, or null.
   */
  function doorGo(root, surface, id, opts) {
    const f = doorFind(root, surface, id);
    if (!f) return null;
    const o = opts || {};
    if (o.open) { try { o.open(f); } catch { /* the row is still reached */ } }
    const row = f.row;
    // Scroll now and again once a group that was just opened has been laid out (as openSettingsAt waits), so the row ends in view.
    // If the person scrolls meanwhile (wheel, touch, a key, or a scroll the door did not cause), the later scrolls are skipped.
    const doc = o.doc || (row && row.ownerDocument) || null;
    const view = (doc && doc.defaultView) || null;
    // The scroll events the door's own scrollIntoView causes arrive after it returns (and a smooth scroll runs on), so a scroll event
    // counts as the person's only when the door has not scrolled in the last 400 ms; input events (wheel, touch, key, press) always count.
    let moved = false, ourAt = 0;
    const mine = () => { moved = true; };
    const notOurs = () => { if (Date.now() - ourAt > 400) moved = true; };
    const evs = ['wheel', 'touchstart', 'touchmove', 'keydown', 'mousedown'];
    const listen = (on) => {
      for (const t of [doc, view]) {
        if (!t || !t.addEventListener) continue;
        try {
          for (const ev of evs) on ? t.addEventListener(ev, mine, true) : t.removeEventListener(ev, mine, true);
          on ? t.addEventListener('scroll', notOurs, true) : t.removeEventListener('scroll', notOurs, true);
        } catch { /* ignore */ }
      }
    };
    const toRow = () => {
      try {
        if (row.scrollIntoView && row.isConnected !== false) { ourAt = Date.now(); row.scrollIntoView({ block: 'center' }); }
      } catch { /* no scrolling here */ }
    };
    listen(true);
    toRow();
    // The listeners come off at the last timer, and at once when the row is gone (the group was re-drawn, the page changed): no later
    // timer is then needed, and a row that never comes back must not leave them on the document.
    let off = false;
    const stop = () => { if (!off) { off = true; listen(false); } };
    const again = (ms, last) => (o.setTimeout || setTimeout)(() => {
      try {
        if (row.isConnected === false) { stop(); return; }
        if (!moved) toRow();
      } finally { if (last) stop(); }
    }, ms);
    again(150, false);
    again(450, true);
    if (row.classList) {
      row.classList.add('st-door-hit');
      (o.setTimeout || setTimeout)(() => { try { row.classList.remove('st-door-hit'); } catch { /* gone */ } }, 2000);
    }
    const target = f.info || (f.ctl && f.ctl.focus ? f.ctl : null);
    if (target && target.focus) { try { target.focus({ preventScroll: true }); } catch { target.focus(); } }
    return f;
  }
  /** A door address on a page: load the records, put the ⓘ in, go to the row; no row here = env.notHere(record or null). Resolves true when the row was reached. */
  async function doorFollow(hash, root, surface, env, kind) {
    const d = parseDoorHash(hash, kind);
    if (!d) return false;
    const e = env || {};
    await load(false, e.fetch);
    attach(root, surface, e.opts);
    const f = doorGo(root, surface, d.id, { open: e.open, setTimeout: e.setTimeout });
    if (!f && e.notHere) e.notHere(recs.get(d.id) || null);
    return !!f;
  }
  const hereIs = (rec) => 'That setting is on ' + ((rec && rec.home) || 'its own screen');

  // ── what the journal shows ──────────────────────────────────────────────────────────────────────────────────
  /** A journal value as words: nothing = "not set", true/false = on/off, long things cut. */
  function showValue(v) {
    if (v === undefined || v === null || v === '') return 'not set';
    if (v === true) return 'on';
    if (v === false) return 'off';
    if (typeof v === 'string') return v.length > 120 ? v.slice(0, 117) + '...' : v;
    if (Array.isArray(v) && v.every((x) => typeof x !== 'object' || x === null)) return showValue(v.map(String).join(', '));
    let s = '';
    try { s = JSON.stringify(v); } catch { s = String(v); }
    return s.length > 120 ? s.slice(0, 117) + '...' : s;
  }
  /** "Changed <name>[ for <agent>]: <before> → <after>." for a by=lead entry. */
  function changeLine(e) {
    const name = (e && (e.name || e.record || e.key)) || 'a setting';
    return 'Changed ' + name + (e && e.agentName ? ' for ' + e.agentName : '') + ': ' + showValue(e && e.before) + ' → ' + showValue(e && e.after) + '.';
  }
  const STRIP_MAX = 5;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const DISMISS_KEY = 'mm-settings-strip-dismissed';
  const putBack = new Set();   // journal ids put back from the strip in this page
  function dismissedSet(store) {
    try { const a = JSON.parse(store.getItem(DISMISS_KEY) || '[]'); return new Set(Array.isArray(a) ? a.map(String) : []); } catch { return new Set(); }
  }
  function dismissSave(store, ids) {
    try { store.setItem(DISMISS_KEY, JSON.stringify([...ids].slice(-200))); } catch { /* storage blocked: closed for now */ }
  }
  /** What the strip shows: { lines: [{ id, text, restorable }] (newest first, at most 5), more } from the entries of the last 24 h that are not dismissed. */
  function stripModel(entries, now, dismissed) {
    const gone = dismissed || new Set();
    const live = (Array.isArray(entries) ? entries : []).filter((e) => e && e.id && !gone.has(String(e.id)) && (!Number.isFinite(e.at) || e.at >= now - DAY_MS))
      .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
    return { lines: live.slice(0, STRIP_MAX).map((e) => ({ id: String(e.id), text: changeLine(e), restorable: e.restorable !== false })), more: Math.max(0, live.length - STRIP_MAX), all: live.map((e) => String(e.id)) };
  }
  function errText(j, fallback) { return (j && (j.error || j.message)) ? String(j.error || j.message) : fallback; }
  /** Put one change back (POST /api/settings-journal/<id>/restore): { ok, text }. */
  async function undoChange(id, env) {
    const f = (env && env.fetch) || (win() && win().fetch ? win().fetch.bind(win()) : null);
    if (!f) return { ok: false, text: 'Could not put it back.' };
    try {
      const r = await f('/api/settings-journal/' + encodeURIComponent(id) + '/restore', { method: 'POST', credentials: 'include' });
      let j = null; try { j = await r.json(); } catch { j = null; }
      if (r.ok && !(j && j.ok === false)) return { ok: true, text: 'Put back.' };
      return { ok: false, text: errText(j, 'Could not put it back.') };
    } catch { return { ok: false, text: 'Could not put it back.' }; }
  }
  /** Paint the strip into host (a block element, hidden when there is nothing to say). env: { doc, fetch, storage, now, reload() }. */
  function stripPaint(host, entries, env) {
    const e = env || {};
    const d = e.doc || (host && host.ownerDocument);
    if (!host || !d) return;
    const now = e.now ? e.now() : Date.now();
    const store = e.storage || (win() && win().localStorage) || null;
    const gone = store ? dismissedSet(store) : new Set();
    const m = stripModel(entries, now, gone);
    host.textContent = '';
    if (!m.lines.length) { host.hidden = true; return; }
    host.hidden = false;
    host.setAttribute('class', 'change-strip');
    host.setAttribute('role', 'region');
    host.setAttribute('aria-label', 'Changes your Maestro made');
    const mk = (t, c) => { const x = d.createElement(t); if (c) x.setAttribute('class', c); return x; };
    for (const ln of m.lines) {
      const row = mk('div', 'change-line');
      const txt = mk('span', 'change-text');
      const put = putBack.has(ln.id);
      txt.textContent = put ? 'Put back.' : ln.text;
      row.appendChild(txt);
      if (!put && ln.restorable) {
        const b = mk('button', 'change-undo');
        b.setAttribute('type', 'button');
        b.textContent = 'Undo';
        b.addEventListener('click', async () => {
          b.disabled = true;
          const r = await undoChange(ln.id, e);
          if (r.ok) { putBack.add(ln.id); txt.textContent = 'Put back.'; if (b.parentNode) b.parentNode.removeChild(b); if (e.after) e.after(ln.id); }
          else { b.disabled = false; msg.textContent = r.text; }
        });
        row.appendChild(b);
      }
      const msg = mk('span', 'change-msg');
      msg.setAttribute('role', 'status');
      row.appendChild(msg);
      host.appendChild(row);
    }
    if (m.more) { const mo = mk('div', 'change-more'); mo.textContent = 'and ' + m.more + ' more in Settings, Recent changes'; host.appendChild(mo); }
    const x = mk('button', 'change-x');
    x.setAttribute('type', 'button');
    x.setAttribute('aria-label', 'Dismiss these changes');
    x.textContent = '×';
    x.addEventListener('click', () => { if (store) { const all = dismissedSet(store); for (const id of m.all) all.add(id); dismissSave(store, all); } host.textContent = ''; host.hidden = true; });
    host.appendChild(x);
  }
  /** Fetch the lead's changes of the last 24 h and paint them. */
  async function stripLoad(host, env) {
    const e = env || {};
    const f = e.fetch || (win() && win().fetch ? win().fetch.bind(win()) : null);
    if (!host || !f) return false;
    const now = e.now ? e.now() : Date.now();
    try {
      const r = await f('/api/settings-journal?by=lead&since=' + (now - DAY_MS), { credentials: 'include' });
      const j = r && r.ok ? await r.json() : null;
      if (!j) return false;
      stripPaint(host, Array.isArray(j) ? j : j.entries, e);
      return true;
    } catch { return false; }
  }

  // ── Recent changes (Settings) ───────────────────────────────────────────────────────────────────────────────
  /** Who made a change, in words. env.userName(id) gives a person's name; env.agentName(name) an agent's display name. */
  function whoText(entry, env) {
    const w = (entry && entry.who) || {};
    const e = env || {};
    const person = () => (w.user && e.userName ? e.userName(w.user) : '') || 'A person';
    const agent = () => (w.agent ? (e.agentName ? e.agentName(w.agent) : w.agent) : '');
    switch (w.kind) {
      case 'person': return person();
      case 'lead': return 'Maestro';
      case 'agent': return agent() || 'An agent';
      case 'restore': return person() + ' (put back)';
      case 'update': return 'an update';
      case 'cli': case 'outside': return 'a program on this computer';
      default: return 'your Maestro on start-up';
    }
  }
  /** What changed: the record's name (else the key) and the agent it was for. */
  function whatText(entry, env) {
    const e = env || {};
    const rec = entry && entry.record ? (e.recordName ? e.recordName(entry.record) : '') : '';
    const key = String((entry && entry.key) || '');
    const parts = key.split('.');
    const agent = entry && entry.agentName ? entry.agentName : (entry && entry.store === 'agents' && parts[1] ? (e.agentName ? e.agentName(parts[1]) : parts[1]) : '');
    return { name: (entry && entry.name) || rec || key || 'a setting', agent };
  }
  function whenText(at, now) {
    const t = Number(at);
    if (!Number.isFinite(t)) return '';
    const ago = Math.max(0, (now || Date.now()) - t);
    if (ago < 60000) return 'just now';
    if (ago < 3600000) return Math.floor(ago / 60000) + ' min ago';
    if (ago < DAY_MS) return Math.floor(ago / 3600000) + ' h ago';
    try { return new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return String(new Date(t).toISOString()); }
  }
  /** One row of Recent changes. */
  function recentRow(d, entry, env) {
    const e = env || {};
    const mk = (t, c) => { const x = d.createElement(t); if (c) x.setAttribute('class', c); return x; };
    const row = mk('div', 'st-recent-row');
    row.setAttribute('data-id', String(entry.id));
    const what = whatText(entry, e);
    const head = mk('div', 'st-recent-what');
    head.textContent = what.name + (what.agent ? ' (' + what.agent + ')' : '');
    const change = mk('div', 'st-recent-change');
    change.textContent = showValue(entry.before) + ' → ' + showValue(entry.after);
    const meta = mk('div', 'st-recent-meta');
    meta.textContent = whenText(entry.at, e.now ? e.now() : Date.now()) + ' · ' + whoText(entry, e);
    row.appendChild(head); row.appendChild(change); row.appendChild(meta);
    const msg = mk('span', 'st-recent-msg');
    msg.setAttribute('role', 'status');
    if (entry.restorable) {
      const b = mk('button', 'st-test-btn st-recent-restore');
      b.setAttribute('type', 'button');
      b.textContent = 'Restore';
      b.addEventListener('click', async () => {
        b.disabled = true;
        const r = await undoChange(entry.id, e);
        if (r.ok) { msg.textContent = 'Put back.'; if (b.parentNode) b.parentNode.removeChild(b); } else { msg.textContent = r.text; b.disabled = false; }
      });
      row.appendChild(b);
    }
    row.appendChild(msg);
    return row;
  }
  /**
   * Fill the Recent changes list (host): the newest 30, "Load more" by `before`. env: { doc, fetch, now, userName, agentName, recordName }.
   * Resolves true when the list was drawn.
   */
  async function recentLoad(host, env, before) {
    const e = env || {};
    const d = e.doc || (host && host.ownerDocument);
    const f = e.fetch || (win() && win().fetch ? win().fetch.bind(win()) : null);
    if (!host || !d || !f) return false;
    let j = null;
    try {
      const r = await f('/api/settings-journal?limit=30' + (before ? '&before=' + encodeURIComponent(before) : ''), { credentials: 'include' });
      j = r && r.ok ? await r.json() : null;
    } catch { j = null; }
    const old = host.querySelector ? host.querySelector('.st-recent-more') : null;
    if (old && old.parentNode) old.parentNode.removeChild(old);
    if (!j) { if (!before) host.textContent = 'Could not load the changes.'; return false; }
    const list = Array.isArray(j.entries) ? j.entries : [];
    if (!before) host.textContent = '';
    if (!before && !list.length) { host.textContent = 'Nothing has been changed yet.'; return true; }
    for (const en of list) if (en && en.id) host.appendChild(recentRow(d, en, e));
    if (list.length >= 30 && j.next) {
      const more = d.createElement('button');
      more.setAttribute('type', 'button');
      more.setAttribute('class', 'st-test-btn st-recent-more');
      more.textContent = 'Load more';
      more.addEventListener('click', () => { more.disabled = true; recentLoad(host, e, j.next); });
      host.appendChild(more);
    }
    return true;
  }

  // ── the confirm card the hub builds for a change (ask_user with fixed: true) ─────────────────────────────────
  /** The rows of the card: [[label, text]] (Setting, For, Now, After, What it means, and the restart note). */
  function fixedRows(change) {
    const c = change && typeof change === 'object' ? change : {};
    const rows = [['Setting', String(c.name == null ? '' : c.name)]];
    if (c.agent) rows.push(['For', String(c.agent)]);
    rows.push(['Now', showValue(c.before)], ['After', showValue(c.after)]);
    if (c.meaning) rows.push(['What it means', String(c.meaning)]);
    if (c.restart) rows.push(['', 'Needs a restart to take effect']);
    return rows;
  }
  /** true for a card the hub made for a change: no typed answer. */
  function isFixedCard(data) { return !!(data && data.fixed === true && data.change && typeof data.change === 'object'); }

  return { HEADINGS, load, mount, attach, watch, open, close, isOpen, resolve, whoLines, normLabel, ownText, askText, askLead, parseAskHash, askFill, closeGuarded, handleAskHash, sectionWords, sheetMode, setRecords, ready: () => ready, records: () => recs, leadTool: () => leadTool,
    parseDoorHash, doorFind, doorGo, doorFollow, hereIs, showValue, changeLine, stripModel, stripPaint, stripLoad, undoChange, putBack, whoText, whatText, recentRow, recentLoad, fixedRows, isFixedCard, STRIP_MAX };
});
