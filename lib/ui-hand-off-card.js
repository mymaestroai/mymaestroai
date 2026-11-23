/**
 * ui-hand-off-card.js — the hand-off strip above the message box of the caller's chat
 * (shared by index.html and mobile.html).
 *
 * A primary agent can hand a long job to another agent (tool hand_off, lib/hand-offs). The owner looking at the
 * caller's chat sees ONE compact line ("Tasks: 1 running · 2 done") that expands into one card per hand-off.
 * The list comes from GET /api/hand-offs?agent=<caller>.
 *
 * Pure functions (tested in Node):
 *   stateLabel(view | state, { fmt })  'Queued' | 'Running' | 'Waiting for its next step (3:05 PM)' | 'Running a job' | 'Finishing up'
 *                                      | 'Done' | 'Done (report sent)' | 'Failed' | 'Cancelled' | 'Interrupted by a restart'
 *   pillState(view)              the state the pill is coloured by (waiting without a pending task uses the running colour)
 *   cardModel(view, { now })     { title, topic, state, label, ago, open }
 *   visible(views, { now })      open ones plus those ended in the last 10 minutes (after the report, else after the end; at most 3
 *                                of those), at most 5 in all: open first, then newest first
 *   summaryLine(views, { now })  "Tasks: 1 running · 1 waiting · 2 done" ('' when nothing shows); counts everything kept
 * Browser part:
 *   render(container, views)     builds the strip (text nodes only, never markup): a header button with the summary and a chevron,
 *                                then the list (an open hand-off is a card, an ended one a single line). Collapsed by default;
 *                                the choice is kept in localStorage "handoffStrip.expanded". Empty -> container emptied and hidden
 *   track({ getAgent, getContainer })  keeps the strip of the open chat current: fetches when the agent (or its box) changes, on
 *                                      refreshSoon() (a reply ended) and every 20 s while any hand-off is open
 *   refreshSoon()                a reply finished: fetch again shortly (calls close together become one request)
 *   openStatus(view, opts)       the "Status" button: opens ONE <dialog class="ho-sheet"> inside the page (made once per document) with a
 *                                header (who · job, state, updated) and the target's STATUS.md rendered as Markdown through
 *                                opts.renderMarkdown (track's renderMarkdown: the page's formatContent); no STATUS.md yet: "No status
 *                                written yet. The brief:" and the brief, read through the files API of the target's Files folder.
 *   statusSheetModel(answer, { now, view })  { title, state, updated, body } for that sheet (pure)
 *
 * The "Working on" panel (replaces the Tasks strip in every chat; reads GET /api/agents/<name>/working-on):
 *   panelModel(answer, { now, fmt, everHad })  { show: 'hidden'|'quiet'|'full', summary, nextCheckText, rows, count } (pure)
 *   renderPanel(container, answer, opts)       header (.ho-strip with .wo-ring) + rows (.wo-row), or the quiet line (.wo-quiet)
 *   track({ getAgent, getContainer, renderMarkdown, isAdmin, stopJob, stopWorker })  fetches the answer and keeps the panel current
 *   onBackground(agent)                        the hub's `background` event arrived: look again if it is the open chat's agent
 *   open(agent)                                expand the panel (a click on a ring or line in a list)
 *
 * No DOM access at load. Browser: window.HandOffCard. Node (tests): module.exports.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.HandOffCard = api;
})(typeof window !== 'undefined' ? window : null, function () {
  const RECENT_MS = 10 * 60 * 1000;   // an ended hand-off stays on the strip this long after its report (or its end)
  const FLASH_MS = 4000;
  const STORE_KEY = 'handoffStrip.expanded';
  const MAX_ENDED = 3;   // ended ones are single lines; at most three, so the stack never crowds a phone's chat
  const POLL_MS = 20000;
  const TICK_MS = 1500;
  const SOON_MS = 1200;
  const OPEN = new Set(['queued', 'running', 'waiting']);
  const DONE_LIKE = new Set(['done', 'failed', 'interrupted']);
  const LABELS = {
    queued: 'Queued', running: 'Running', waiting: 'Waiting for its next step', done: 'Done',
    failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted by a restart',
  };

  const isOpen = (state) => OPEN.has(String(state));
  const ms = (v) => { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : null; };
  const nextOf = (v) => (v && v.next && typeof v.next === 'object') ? v.next : null;
  function clock(at) {
    try { return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); } catch { return ''; }
  }

  /** stateLabel(view | state, { fmt }): a plain state string still works (old callers). fmt(ms) formats the time a waiting task runs. */
  function stateLabel(view, { fmt, now = Date.now() } = {}) {
    if (view === null || typeof view !== 'object') return LABELS[String(view)] || String(view || '');
    const state = String(view.state || '');
    if (state === 'waiting') {
      const n = nextOf(view);
      if (n && n.kind === 'task') {
        const at = ms(n.at);
        // a time already past (a paused or held task) is left out rather than shown as if it were coming (review r1)
        const t = at === null || at < now ? '' : String((fmt || clock)(at) || '');
        return t ? 'Waiting for its next step (' + t + ')' : LABELS.waiting;
      }
      // a server that doesn't say what it waits for (no next field): it is still working; with next null, nothing is pending
      if (!view || !Object.prototype.hasOwnProperty.call(view, 'next')) return 'Working';
      return n && n.kind === 'job' ? 'Running a job' : 'Finishing up';
    }
    if (state === 'done') return view.reported ? 'Done (report sent)' : 'Done';
    return LABELS[state] || state;
  }

  /** The state the pill is coloured by: waiting with no pending task (a job, or finishing up) uses the running colour. */
  function pillState(view) {
    const state = String((view && view.state) || '');
    if (state === 'waiting') { const n = nextOf(view); return n && n.kind === 'task' ? 'waiting' : 'running'; }
    return state;
  }

  function agoText(from, now) {
    const t = ms(from);
    if (t === null) return '';
    const s = Math.max(0, Math.floor((now - t) / 1000));
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return m + ' min ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' h ago';
    return Math.floor(h / 24) + ' d ago';
  }

  /** cardModel(view, { now }) -> what one card shows. ago counts from startedAt, else createdAt. */
  function cardModel(view, { now = Date.now() } = {}) {
    const v = view || {};
    return {
      title: 'Task for ' + String(v.target || ''),
      topic: String(v.topic || ''),
      state: String(v.state || ''),
      label: stateLabel(v, { now }),
      ago: agoText(v.startedAt || v.createdAt, now),
      open: isOpen(v.state),
    };
  }

  /** statusHref(view) -> a link that opens the target's STATUS.md (the job folder is <target Files>/hand-offs/<name>/), or null. */
  function statusHref(view) {
    const v = view || {};
    const folder = String(v.folder || '');
    const i = folder.lastIndexOf('/hand-offs/');
    const name = i >= 0 ? folder.slice(i + '/hand-offs/'.length) : '';
    if (!v.target || !name || name.includes('/') || name.includes('..')) return null;
    return '/api/files/download?agent=' + encodeURIComponent(String(v.target)) + '&path=' + encodeURIComponent('hand-offs/' + name + '/STATUS.md') + '&inline=1';
  }

  /** When an ended hand-off leaves the strip: RECENT_MS after its report was delivered, else after it ended. null: no time known. */
  function leavesAt(v) {
    const t = ms(v.reportedAt);
    const base = t !== null ? t : ms(v.endedAt);
    return base === null ? null : base + RECENT_MS;
  }

  /** kept(views, { now }) -> everything the strip counts: open ones plus recently ended ones (at most MAX_ENDED), open first, then newest first. */
  function kept(views, { now = Date.now() } = {}) {
    const list = (Array.isArray(views) ? views : []).filter((v) => {
      if (!v || typeof v !== 'object') return false;
      if (isOpen(v.state)) return true;
      const gone = leavesAt(v);
      return gone !== null && now < gone;
    });
    const stamp = (v) => ms(v.createdAt) || ms(v.startedAt) || 0;
    // open ones first (review r1: five finished cards must never hide a running one), then newest first
    let ended = 0;
    return list.map((v, i) => ({ v, i })).sort((a, b) => (Number(isOpen(b.v.state)) - Number(isOpen(a.v.state))) || (stamp(b.v) - stamp(a.v)) || (a.i - b.i))
      .filter((x) => isOpen(x.v.state) || ++ended <= MAX_ENDED).map((x) => x.v);
  }

  /** visible(views, { now }) -> what the list shows: every open hand-off (the header counts them all, review r1) and at most
   *  MAX_ENDED ended ones. */
  function visible(views, opts) { return kept(views, opts); }

  /** summaryLine(views, { now }) -> "Tasks: 1 running · 1 waiting · 2 done" (counts everything kept, not only the shown); '' when nothing. */
  function summaryLine(views, { now = Date.now() } = {}) {
    const c = { queued: 0, running: 0, waiting: 0, done: 0, failed: 0, cancelled: 0 };
    for (const v of kept(views, { now })) {
      const s = String(v.state);
      if (s === 'queued') c.queued++;
      else if (s === 'running') c.running++;
      else if (s === 'waiting') { const n = nextOf(v); if (n && n.kind === 'task') c.waiting++; else c.running++; }
      else if (s === 'done') c.done++;
      else if (s === 'failed' || s === 'interrupted') c.failed++;
      else if (s === 'cancelled') c.cancelled++;
    }
    const parts = ['queued', 'running', 'waiting', 'done', 'failed', 'cancelled'].filter((k) => c[k] > 0).map((k) => c[k] + ' ' + k);
    return parts.length ? 'Tasks: ' + parts.join(' · ') : '';
  }

  // Per container: the last state seen of each hand-off (for the highlight) and the running flash.
  const boxes = new WeakMap();
  function boxState(container) {
    let b = boxes.get(container);
    if (!b) { b = { seen: null, flash: false, timer: null, header: null }; boxes.set(container, b); }
    return b;
  }
  function storeOf(storage) { return storage !== undefined ? storage : (typeof localStorage !== 'undefined' ? localStorage : null); }
  function readExpanded(storage) { try { const s = storeOf(storage); return !!s && s.getItem(STORE_KEY) === '1'; } catch { return false; } }
  function writeExpanded(storage, on) { try { const s = storeOf(storage); if (s) s.setItem(STORE_KEY, on ? '1' : '0'); } catch { /* storage refused: keep going */ } }

  /** The highlight: a hand-off that became done, failed or interrupted since the previous render (the first render shows none). */
  function noteFlash(box, all, { setTimer, clearTimer } = {}) {
    const seen = new Map();
    let flashNow = false;
    for (const v of all) {
      if (v.id === undefined || v.id === null) continue;
      const id = String(v.id), state = String(v.state);
      seen.set(id, state);
      if (box.seen && box.seen.has(id) && box.seen.get(id) !== state && DONE_LIKE.has(state)) flashNow = true;
    }
    box.seen = seen;
    if (flashNow) {
      const clear = clearTimer || ((h) => clearTimeout(h));
      const set = setTimer || ((f, t) => setTimeout(f, t));
      if (box.timer !== null) clear(box.timer);
      box.flash = true;
      box.timer = set(() => {
        box.flash = false; box.timer = null;
        if (box.header && box.header.classList) box.header.classList.remove('ho-flash');
      }, FLASH_MS);
    }
  }

  /**
   * render(container, views, { now, storage, setTimer, clearTimer }): the strip (summary header) and the list under it, replacing
   * what was there. Text nodes only. storage/setTimer/clearTimer are for tests.
   */
  function render(container, views, opts = {}) {
    if (!container) return;
    const { now = Date.now(), storage, setTimer, clearTimer, expanded } = opts;
    const doc = container.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc) return;
    const box = boxState(container);
    const all = (Array.isArray(views) ? views : []).filter((v) => v && typeof v === 'object');

    noteFlash(box, all, { setTimer, clearTimer });

    while (container.firstChild) container.removeChild(container.firstChild);
    box.header = null;
    const shown = visible(all, { now });
    if (!shown.length) { container.hidden = true; return; }
    const open = expanded !== undefined ? !!expanded : readExpanded(storage);
    const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.appendChild(doc.createTextNode(text)); return e; };
    // "Status" opens the sheet inside the app (openStatus): a button, no link, no new tab
    const statusButton = (view) => {
      const b = el('button', 'ho-status', 'Status');
      b.setAttribute('type', 'button');
      b.addEventListener('click', () => { openStatus(view, { document: doc }); });
      return b;
    };
    const canStatus = (v) => !!v.target && !!jobFolderName(v);   // its job folder is where the status is read

    const header = el('button', 'ho-strip' + (box.flash ? ' ho-flash' : ''));
    header.setAttribute('type', 'button');
    header.setAttribute('aria-expanded', open ? 'true' : 'false');
    header.appendChild(el('span', 'ho-sum', summaryLine(all, { now })));
    header.appendChild(el('span', 'ho-chev'));   // drawn by CSS
    header.addEventListener('click', () => {
      writeExpanded(storage, !open);
      render(container, views, { ...opts, now: Date.now(), expanded: !open });
      // the button was replaced: keyboard focus goes to the new one (review r1)
      const h = boxState(container).header;
      try { if (h && typeof h.focus === 'function') h.focus(); } catch { /* no focus here */ }
    });
    box.header = header;
    container.appendChild(header);

    const list = el('div', 'ho-list');
    list.hidden = !open;
    for (const v of shown) {
      const m = cardModel(v, { now });
      const ps = pillState(v);
      const pillClass = 'ho-pill ho-' + (/^[a-z]+$/.test(ps) ? ps : 'other');
      if (!m.open) {
        // an ended hand-off: one line, so finished ones never push the conversation off a phone's screen
        const row = el('div', 'ho-card ho-ended');
        row.appendChild(el('span', 'ho-line', String(v.target || '') + (m.topic ? ' · ' + m.topic : '')));
        row.appendChild(el('span', pillClass, m.label));
        if (canStatus(v)) row.appendChild(statusButton(v));
        list.appendChild(row);
        continue;
      }
      const card = el('div', 'ho-card');
      const head = el('div', 'ho-head');
      head.appendChild(el('span', 'ho-title', m.title));
      head.appendChild(el('span', pillClass, m.label));
      card.appendChild(head);
      if (m.topic) card.appendChild(el('div', 'ho-topic', m.topic));
      const foot = el('div', 'ho-time', m.ago || undefined);
      const hasStatus = canStatus(v);
      if (hasStatus) {
        if (m.ago) foot.appendChild(doc.createTextNode(' · '));
        foot.appendChild(statusButton(v));
      }
      if (m.ago || hasStatus) card.appendChild(foot);
      list.appendChild(card);
    }
    container.appendChild(list);
    container.hidden = false;
  }

  // ── The "Working on" panel: hand-offs, background jobs and temporary workers of the agent in one place ──
  const QUIET_MS = 10 * 60 * 1000;   // after the last item ends, "Nothing running in the background now." stays this long
  const QUIET_TEXT = 'Nothing running in the background now.';
  const countOf = (n) => { const v = Number(n); return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0; };
  const thingsOf = (n) => (n === 1 ? '1 thing' : n + ' things');

  /**
   * panelModel(answer, { now, fmt, everHad }) -> { show: 'hidden' | 'quiet' | 'full', summary, nextCheckText, rows }
   * answer = GET /api/agents/<name>/working-on. fmt(ms) formats a clock time (default: the browser's local hour:minute).
   * everHad = when the agent last had something running (ms or ISO), for the quiet line.
   */
  function panelModel(answer, { now = Date.now(), fmt, everHad } = {}) {
    const a = answer && typeof answer === 'object' ? answer : {};
    const f = (t) => String((fmt || clock)(t) || '');
    const handOffs = (Array.isArray(a.handOffs) ? a.handOffs : []).filter((v) => v && typeof v === 'object');
    const jobs = Array.isArray(a.jobs) ? a.jobs.filter((j) => j && typeof j === 'object') : null;
    const jobCount = jobs ? jobs.length : countOf(a.jobCount);
    const workers = (Array.isArray(a.workers) ? a.workers : []).filter((w) => w && typeof w === 'object');
    const shown = visible(handOffs, { now });
    const count = handOffs.filter((v) => isOpen(v.state)).length + jobCount + workers.length;

    const rows = [];
    for (const v of shown) {
      const m = cardModel(v, { now });
      const line = typeof v.statusLine === 'string' ? v.statusLine.trim() : '';
      const changed = ms(v.changedAt) !== null ? 'changed ' + agoText(v.changedAt, now) : '';
      rows.push({
        kind: 'handoff', kindLabel: 'Handed to ' + String(v.targetDisplay || v.targetName || v.target || ''), title: String(m.topic || v.topic || m.title || ''),   // the work itself ("Write the spring newsletter"), not "Task for <agent>"
        sub: [stateLabel(v, { now, fmt }), line ? '"' + line + '"' : '', changed].filter(Boolean).join(' · '),
        buttons: ['status'], view: v,
      });
    }
    if (jobs) {
      for (const j of jobs) {
        const at = ms(j.startedAt);
        rows.push({ kind: 'job', kindLabel: 'Background job', title: String(j.name || ''), sub: at === null ? '' : 'Running since ' + f(at), buttons: ['stop'], jobId: j.id });
      }
    } else if (jobCount > 0) {
      rows.push({ kind: 'jobs', kindLabel: 'Background jobs', title: jobCount === 1 ? '1 background job' : jobCount + ' background jobs', sub: '', buttons: [] });
    }
    if (workers.length) {
      const starts = workers.map((w) => ms(w.startedAt)).filter((t) => t !== null);
      const parts = workers.map((w) => String(w.label || w.id || '')).filter(Boolean);
      if (starts.length) parts.push('since ' + f(Math.min(...starts)));
      rows.push({
        kind: 'workers', kindLabel: 'Helpers', title: workers.length === 1 ? '1 temporary worker' : workers.length + ' temporary workers',
        sub: parts.join(' · '), buttons: ['stop'], workers: workers.map((w) => ({ id: w.id, label: String(w.label || '') })),
      });
    }

    const nc = a.nextCheck && typeof a.nextCheck === 'object' ? ms(a.nextCheck.at) : null;
    const nextCheckText = nc === null ? '' : 'next check ' + f(nc);
    const summary = 'Working on: ' + (count > 0 ? thingsOf(count) : 'nothing now') + (nextCheckText ? ' · ' + nextCheckText : '');
    const t = ms(everHad);
    let show = 'hidden';
    if (count > 0 || shown.length) show = 'full';
    else if (t !== null && now - t < QUIET_MS) show = 'quiet';
    return { show, summary, nextCheckText, rows, count };
  }

  /**
   * renderPanel(container, answer, { now, storage, expanded, everHad, fmt, agent, isAdmin, stopJob, stopWorker, onStopped }):
   * the "Working on" panel (full: header button + rows; quiet: one muted line; hidden: emptied). Text nodes only.
   */
  function renderPanel(container, answer, opts = {}) {
    if (!container) return;
    const { now = Date.now(), storage, setTimer, clearTimer, expanded } = opts;
    const doc = container.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc) return;
    const box = boxState(container);
    const all = answer && Array.isArray(answer.handOffs) ? answer.handOffs.filter((v) => v && typeof v === 'object') : [];
    noteFlash(box, all, { setTimer, clearTimer });
    const model = panelModel(answer, { now, fmt: opts.fmt, everHad: opts.everHad });

    while (container.firstChild) container.removeChild(container.firstChild);
    box.header = null;
    if (model.show === 'hidden') { container.hidden = true; return model; }
    const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.appendChild(doc.createTextNode(text)); return e; };
    if (model.show === 'quiet') {
      container.appendChild(el('div', 'wo-quiet', QUIET_TEXT));
      container.hidden = false;
      return model;
    }

    const open = expanded !== undefined ? !!expanded : readExpanded(storage);
    const header = el('button', 'ho-strip' + (box.flash ? ' ho-flash' : ''));
    header.setAttribute('type', 'button');
    header.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (model.count > 0) header.appendChild(el('span', 'wo-ring'));   // the hollow ring, drawn by CSS; not when nothing runs any more
    header.appendChild(el('span', 'ho-sum', model.summary));
    header.appendChild(el('span', 'ho-chev'));   // drawn by CSS
    header.addEventListener('click', () => {
      writeExpanded(storage, !open);
      renderPanel(container, answer, { ...opts, now: Date.now(), expanded: !open });
      const h = boxState(container).header;
      try { if (h && typeof h.focus === 'function') h.focus(); } catch { /* no focus here */ }
    });
    box.header = header;
    container.appendChild(header);

    const stopped = (p) => {
      const done = () => { if (typeof opts.onStopped === 'function') opts.onStopped(); };
      if (p && typeof p.then === 'function') p.then(done, done); else done();
    };
    const list = el('div', 'ho-list');
    list.hidden = !open;
    for (const r of model.rows) {
      const row = el('div', 'wo-row wo-' + r.kind);
      row.appendChild(el('span', 'wo-kind', r.kindLabel));
      row.appendChild(el('span', 'wo-title', r.title));
      if (r.sub) row.appendChild(el('div', 'wo-sub', r.sub));
      for (const b of r.buttons) {
        if (b === 'status') {
          if (!r.view || !r.view.target || !jobFolderName(r.view)) continue;
          const sb = el('button', 'ho-status', 'Status');
          sb.setAttribute('type', 'button');
          sb.addEventListener('click', () => { openStatus(r.view, { document: doc }); });
          row.appendChild(sb);
        } else if (b === 'stop') {
          const can = r.kind === 'job' ? (typeof opts.stopJob === 'function' && (typeof opts.isAdmin !== 'function' || opts.isAdmin())) : typeof opts.stopWorker === 'function';
          if (!can) continue;
          const sb = el('button', 'wo-stop', 'Stop');
          sb.setAttribute('type', 'button');
          sb.addEventListener('click', () => {
            try {
              if (r.kind === 'job') stopped(opts.stopJob(r.jobId));
              else stopped(Promise.all(r.workers.map((w) => opts.stopWorker(w.id, opts.agent))));
            } catch { stopped(null); }
          });
          row.appendChild(sb);
        }
      }
      list.appendChild(row);
    }
    container.appendChild(list);
    container.hidden = false;
    return model;
  }

  // ── The Status sheet (opens inside the app: a bottom sheet on the phone, a centred panel on the desktop) ──
  const NO_STATUS = 'No status written yet';
  const LOAD_FAILED = "Couldn't load the status. Try again.";

  /** 'Updated 3 min ago' (under an hour) | 'Updated 6:12 AM' (today) | 'Updated Nov 18, 6:12 AM' | 'No status written yet'. */
  function updatedText(at, now) {
    const t = ms(at);
    if (t === null) return NO_STATUS;
    const age = Math.max(0, now - t);
    if (age < 60 * 60 * 1000) return 'Updated ' + agoText(t, now);
    let sameDay = false;
    try { sameDay = new Date(t).toDateString() === new Date(now).toDateString(); } catch { sameDay = true; }
    if (sameDay) return 'Updated ' + clock(t);
    let day = '';
    try { day = new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch { day = ''; }
    return 'Updated ' + (day ? day + ', ' : '') + clock(t);
  }

  /**
   * statusSheetModel(answer, { now, view }) -> { title, state, updated, body } for the sheet.
   * answer = the route's { handOff, status, statusAt, brief }; null/odd (a failed fetch) gives the plain failure message.
   * body is Markdown: the status text, or "No status written yet. The brief:" and the brief when none is written.
   */
  function statusSheetModel(answer, { now = Date.now(), view } = {}) {
    const a = answer && typeof answer === 'object' && answer.handOff && typeof answer.handOff === 'object' ? answer : null;
    const v = (a ? a.handOff : view) || {};
    const title = String(v.target || '') + ' · ' + String(v.topic || '');
    if (!a) return { title, state: v.state ? stateLabel(v, { now }) : '', updated: '', body: LOAD_FAILED };
    const text = typeof a.status === 'string' ? a.status : null;
    let body;
    if (text !== null && text.trim()) body = text;
    else {
      const brief = typeof a.brief === 'string' ? a.brief.trim() : '';
      body = brief ? NO_STATUS + '. The brief:\n\n' + brief : NO_STATUS + '.';
    }
    const has = text !== null && text.trim();
    return { title, state: stateLabel(v, { now }), updated: has ? updatedText(a.statusAt, now) : NO_STATUS, body };
  }

  const sheets = new WeakMap();   // document -> its one sheet
  function sheetOf(doc) {
    let s = sheets.get(doc);
    if (s) return s;
    const el = (tag, cls) => { const e = doc.createElement(tag); if (cls) e.className = cls; return e; };
    const dialog = el('dialog', 'ho-sheet');
    const inner = el('div', 'ho-sheet-inner');
    const head = el('div', 'ho-sheet-head');
    const titles = el('div', 'ho-sheet-titles');
    const title = el('div', 'ho-sheet-title');
    const sub = el('div', 'ho-sheet-sub');
    titles.appendChild(title); titles.appendChild(sub);
    const close = el('button', 'ho-sheet-close');
    close.setAttribute('type', 'button');
    close.appendChild(doc.createTextNode('Close'));
    const body = el('div', 'ho-sheet-body');
    head.appendChild(titles); head.appendChild(close);
    inner.appendChild(head); inner.appendChild(body);
    dialog.appendChild(inner);
    const shut = () => { try { if (typeof dialog.close === 'function') dialog.close(); } catch { /* already closed */ } };
    close.addEventListener('click', shut);
    dialog.addEventListener('click', (e) => { if (e && e.target === dialog) shut(); });   // the backdrop (the dialog's own box has no padding)
    (doc.body || doc.documentElement).appendChild(dialog);
    s = { dialog, title, sub, body, seq: 0 };
    sheets.set(doc, s);
    return s;
  }
  const setText = (node, text) => {
    while (node.firstChild) node.removeChild(node.firstChild);
    if (text) node.appendChild(node.ownerDocument.createTextNode(String(text)));
  };

  /** The chat renderers draw inline Markdown and line breaks, not headings: a heading line becomes a bold line, so a status
   *  file's "# Title" reads as a title instead of a hash mark. */
  function sheetMarkdown(text) {
    return String(text || '').replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, (m0, t) => '**' + t.replace(/\*\*/g, '') + '**');
  }

  function fillSheet(s, m, renderMarkdown) {
    setText(s.title, m.title);
    setText(s.sub, [m.state, m.updated].filter(Boolean).join(' · '));
    let done = false;
    if (typeof renderMarkdown === 'function') {
      try { s.body.innerHTML = String(renderMarkdown(sheetMarkdown(m.body))); done = true; } catch { done = false; }
    }
    if (!done) { s.body.innerHTML = ''; setText(s.body, m.body); }
  }

  /**
   * openStatus(view, { document, now, fetchFn, renderMarkdown }): opens the one Status sheet (made once per document) for this
   * hand-off, fetches GET /api/hand-offs/status and fills it. A failed fetch shows a short plain message, never JSON.
   */
  /** The job folder's name (<target Files>/hand-offs/<name>/), or '' when the record doesn't give a safe one. */
  function jobFolderName(view) {
    const folder = String((view && view.folder) || '');
    const i = folder.lastIndexOf('/hand-offs/');
    const name = i >= 0 ? folder.slice(i + '/hand-offs/'.length) : '';
    return name && !name.includes('/') && !name.includes('..') ? name : '';
  }

  /**
   * loadStatusAnswer(view, fetchFn) -> { handOff, status, statusAt, brief } read through the existing files API of the
   * target agent's Files folder (no new server route): STATUS.md and its time from the folder listing, and brief.md when no
   * status is written yet. null when the folder can't be read at all (network or access): the sheet then says so plainly.
   */
  async function loadStatusAnswer(view, fetchFn) {
    const name = jobFolderName(view);
    if (!view || !view.target || !name) return null;
    const q = (p) => 'agent=' + encodeURIComponent(String(view.target)) + '&path=' + encodeURIComponent('hand-offs/' + name + (p ? '/' + p : ''));
    // a file the listing shows (or, without a listing, any answer but 404 "not there") that can't be read is a failure the
    // sheet reports plainly, never "No status written yet" (review s1)
    const text = async (p, listed) => {
      const r = await fetchFn('/api/files/download?' + q(p), { credentials: 'same-origin' });
      if (r && r.ok) { const t = await r.text(); return typeof t === 'string' ? t.slice(0, 20000) : ''; }
      if (!listed && r && r.status === 404) return null;
      throw new Error('could not read ' + p);
    };
    let entries = null;
    try {
      const r = await fetchFn('/api/files?' + q(''), { credentials: 'same-origin' });
      if (r && r.ok) { const j = await r.json(); entries = j && Array.isArray(j.entries) ? j.entries : null; }
    } catch { entries = null; }
    const has = (n) => !!(entries && entries.some((e) => e && e.name === n && e.type === 'file'));
    let status = null, statusAt = null, brief = null;
    if (!entries || has('STATUS.md')) {
      status = await text('STATUS.md', has('STATUS.md'));
      const e = entries && entries.find((x) => x && x.name === 'STATUS.md');
      statusAt = e && e.mtime ? e.mtime : null;
    }
    if (status !== null && !status.trim()) { status = null; statusAt = null; }   // an empty STATUS.md: the brief is shown (review s1)
    if (status === null && (!entries || has('brief.md'))) brief = await text('brief.md', has('brief.md'));
    if (entries === null && status === null && brief === null) return null;
    return { handOff: view, status, statusAt, brief };
  }

  /**
   * openStatus(view, { document, now, fetchFn, renderMarkdown }): opens the one Status sheet (made once per document) for this
   * hand-off and fills it from the target's Files folder. Nothing it can't read is shown raw: a plain message instead.
   */
  async function openStatus(view, opts = {}) {
    const doc = opts.document || (typeof document !== 'undefined' ? document : null);
    if (!doc || !view || view.withheld) return null;   // the target's words are not shown for this hand-off
    const s = sheetOf(doc);
    const seq = ++s.seq;
    const render = opts.renderMarkdown || st.renderMarkdown;
    const nowOf = () => (opts.now !== undefined ? opts.now : Date.now());
    setText(s.title, String(view.target || '') + ' · ' + String(view.topic || ''));
    setText(s.sub, view.state ? stateLabel(view, { now: nowOf() }) : '');
    s.body.innerHTML = ''; setText(s.body, 'Loading…');
    if (!s.dialog.open && typeof s.dialog.showModal === 'function') { try { s.dialog.showModal(); } catch { /* already open */ } }
    let model;
    try {
      const answer = await loadStatusAnswer(view, opts.fetchFn || st.fetchFn || fetch);
      model = statusSheetModel(answer, { now: nowOf(), view });
    } catch { model = statusSheetModel(null, { now: nowOf(), view }); }
    if (seq !== s.seq) return model;   // another hand-off's sheet was opened meanwhile
    fillSheet(s, model, render);
    return model;
  }

  // ── Keeping it current (browser) ──
  const st = {
    getAgent: null, getContainer: null, agent: null, box: null, open: false, last: 0, seq: 0, timer: null, soon: null, age: null,
    fetchFn: null, answer: null, renderMarkdown: null, opts: {}, everHad: new Map(),
  };

  /** The first moment the panel changes by itself (ms): a shown ended hand-off leaving, or the quiet line running out. null: none. */
  function nextChange(answer, now, everHad) {
    let best = null;
    const take = (t) => { if (t !== null && (best === null || t < best)) best = t; };
    const views = answer && Array.isArray(answer.handOffs) ? answer.handOffs : [];
    for (const v of kept(views, { now })) { if (!isOpen(v.state)) take(leavesAt(v)); }
    const t = ms(everHad);
    if (t !== null && now - t < QUIET_MS) take(t + QUIET_MS);
    return best;
  }

  const everOf = () => (st.agent ? st.everHad.get(st.agent) : undefined);
  function paint(now, expanded) {
    if (!st.box) return null;
    return renderPanel(st.box, st.answer, {
      ...st.opts, now, expanded, everHad: everOf(), agent: st.agent, onStopped: refreshSoon,
    });
  }

  function clearAge() { if (st.age) { clearTimeout(st.age); st.age = null; } }
  /** When something shown is due to go (an ended hand-off, the quiet line): re-render from the last answer (so it goes even if
   *  the network fails then), arm the next one, and look again. */
  function armAge(now) {
    clearAge();
    const leave = st.answer ? nextChange(st.answer, now, everOf()) : null;
    if (leave === null) return;
    st.age = setTimeout(() => {
      st.age = null;
      if (!st.agent || !st.box || !st.answer) return;
      const t = Date.now();
      paint(t);
      armAge(t);
      load();
    }, Math.max(1000, leave - now + 500));
  }

  function hide(box) { st.open = false; st.answer = null; clearAge(); if (box) renderPanel(box, null); }

  async function load() {
    const agent = st.agent, box = st.box, seq = ++st.seq;
    st.last = Date.now();
    if (!agent || !box) { hide(box); return; }
    try {
      const res = await (st.fetchFn || fetch)('/api/agents/' + encodeURIComponent(agent) + '/working-on');
      if (seq !== st.seq) return;   // another chat was opened meanwhile
      if (res.status === 403 || res.status === 404) { hide(box); return; }
      if (!res.ok) return;   // keep what is shown (its timer stays armed); try again next time
      const data = await res.json();
      if (seq !== st.seq) return;
      const now = Date.now();
      st.answer = data && typeof data === 'object' ? data : {};
      const model = panelModel(st.answer, { now, everHad: everOf() });
      if (model.count > 0) st.everHad.set(agent, now);
      paint(now);
      st.open = model.count > 0;   // polling follows everything running
      armAge(now);
    } catch { /* offline or a bad answer: keep what is shown; its timer stays armed */ }
  }

  function tick() {
    let agent = null, box = null;
    try { agent = st.getAgent() || null; box = st.getContainer() || null; } catch { /* page not ready */ }
    if (agent !== st.agent || box !== st.box) {
      if (st.box && st.box !== box) renderPanel(st.box, null);
      st.agent = agent; st.box = box; st.open = false; st.answer = null; clearAge();
      return load();
    }
    if (agent && box && st.open && Date.now() - st.last >= POLL_MS) return load();
  }

  /** track({ getAgent, getContainer, renderMarkdown, isAdmin, stopJob, stopWorker }): keeps the panel of the open chat current. */
  function track({ getAgent, getContainer, fetchFn, renderMarkdown, isAdmin, stopJob, stopWorker, storage } = {}) {
    st.getAgent = getAgent; st.getContainer = getContainer; st.fetchFn = fetchFn || null;
    st.renderMarkdown = typeof renderMarkdown === 'function' ? renderMarkdown : null;
    st.opts = { isAdmin, stopJob, stopWorker, storage };
    if (st.timer) return;
    st.timer = setInterval(tick, TICK_MS);
    tick();
  }

  function refreshSoon() {
    if (!st.getAgent || st.soon) return;
    st.soon = setTimeout(() => { st.soon = null; if (st.agent && st.box) load(); }, SOON_MS);
  }

  /** The hub's `background` event for an agent arrived: look again when it is the open chat's agent. */
  function onBackground(agent) {
    if (!agent || agent === st.agent) refreshSoon();
  }

  /** open(agent): expand the panel (the person clicked a ring or line in the list). Kept per device, so it also holds when
   *  that chat is opened a moment later. */
  function open(agent) {
    writeExpanded(st.opts.storage, true);
    if (st.box && st.answer && (!agent || agent === st.agent)) paint(Date.now(), true);
  }

  return {
    stateLabel, pillState, cardModel, statusHref, statusSheetModel, openStatus, loadStatusAnswer, sheetMarkdown, visible, summaryLine,
    panelModel, renderPanel, render, track, refreshSoon, onBackground, open, POLL_MS, RECENT_MS, QUIET_MS, STORE_KEY,
  };
});
