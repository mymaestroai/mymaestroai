/**
 * ui-hand-off-card.js — the small "Handed off to <agent>: <topic>" cards above the message box of the caller's chat
 * (shared by index.html and mobile.html).
 *
 * A primary agent can hand a long job to another agent (tool hand_off, lib/hand-offs). The owner looking at the
 * caller's chat sees one card per hand-off with its state. The list comes from GET /api/hand-offs?agent=<caller>.
 *
 * Pure functions (tested in Node):
 *   stateLabel(state)            'Queued' | 'Running' | 'Waiting for its next step' | 'Done' | 'Failed' | 'Cancelled' | 'Interrupted by a restart'
 *   cardModel(view, { now })     { title, topic, state, label, ago, open }
 *   visible(views, { now })      open ones plus those ended in the last 24 hours, at most 5: open first, then newest first
 * Browser part:
 *   render(container, views)     builds the stack (text nodes only, never markup); empty -> container emptied and hidden
 *   track({ getAgent, getContainer })  keeps the stack of the open chat current: fetches when the agent (or its box) changes, on
 *                                      refreshSoon() (a reply ended) and every 20 s while any shown hand-off is open
 *   refreshSoon()                a reply finished: fetch again shortly (calls close together become one request)
 *
 * No DOM access at load. Browser: window.HandOffCard. Node (tests): module.exports.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.HandOffCard = api;
})(typeof window !== 'undefined' ? window : null, function () {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const MAX_SHOWN = 5;
  const POLL_MS = 20000;
  const TICK_MS = 1500;
  const SOON_MS = 1200;
  const OPEN = new Set(['queued', 'running', 'waiting']);
  const LABELS = {
    queued: 'Queued', running: 'Running', waiting: 'Waiting for its next step', done: 'Done',
    failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted by a restart',
  };

  const isOpen = (state) => OPEN.has(String(state));
  function stateLabel(state) { return LABELS[String(state)] || String(state || ''); }
  const ms = (v) => { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : null; };

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
      title: 'Handed off to ' + String(v.target || ''),
      topic: String(v.topic || ''),
      state: String(v.state || ''),
      label: stateLabel(v.state),
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

  /** visible(views, { now }) -> open ones plus those ended in the last 24 hours, newest first, at most 5. */
  function visible(views, { now = Date.now() } = {}) {
    const list = (Array.isArray(views) ? views : []).filter((v) => {
      if (!v || typeof v !== 'object') return false;
      if (isOpen(v.state)) return true;
      const end = ms(v.endedAt);
      return end !== null && now - end <= DAY_MS;
    });
    const stamp = (v) => ms(v.createdAt) || ms(v.startedAt) || 0;
    // open ones first (review r1: five finished cards must never hide a running one), then newest first
    return list.map((v, i) => ({ v, i })).sort((a, b) => (Number(isOpen(b.v.state)) - Number(isOpen(a.v.state))) || (stamp(b.v) - stamp(a.v)) || (a.i - b.i)).slice(0, MAX_SHOWN).map((x) => x.v);
  }

  /** render(container, views): the stack of cards, replacing what was there. Text nodes only. */
  function render(container, views, { now = Date.now() } = {}) {
    if (!container) return;
    const doc = container.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc) return;
    while (container.firstChild) container.removeChild(container.firstChild);
    const shown = visible(views, { now });
    if (!shown.length) { container.hidden = true; return; }
    const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.appendChild(doc.createTextNode(text)); return e; };
    for (const v of shown) {
      const m = cardModel(v, { now });
      const card = el('div', 'ho-card');
      const head = el('div', 'ho-head');
      head.appendChild(el('span', 'ho-title', m.title));
      head.appendChild(el('span', 'ho-pill ho-' + (/^[a-z]+$/.test(m.state) ? m.state : 'other'), m.label));
      card.appendChild(head);
      if (m.topic) card.appendChild(el('div', 'ho-topic', m.topic));
      const foot = el('div', 'ho-time', m.ago || undefined);
      const href = statusHref(v);
      if (href) {
        const a = el('a', 'ho-status', 'Status');
        a.setAttribute('href', href); a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener');
        if (m.ago) foot.appendChild(doc.createTextNode(' · '));
        foot.appendChild(a);
      }
      if (m.ago || href) card.appendChild(foot);
      container.appendChild(card);
    }
    container.hidden = false;
  }

  // ── Keeping it current (browser) ──
  const st = { getAgent: null, getContainer: null, agent: null, box: null, open: false, last: 0, seq: 0, timer: null, soon: null, fetchFn: null };

  async function load() {
    const agent = st.agent, box = st.box, seq = ++st.seq;
    st.last = Date.now();
    if (!agent || !box) { if (box) render(box, []); st.open = false; return; }
    try {
      const res = await (st.fetchFn || fetch)('/api/hand-offs?agent=' + encodeURIComponent(agent));
      if (seq !== st.seq) return;   // another chat was opened meanwhile
      if (res.status === 403 || res.status === 404) { render(box, []); st.open = false; return; }
      if (!res.ok) return;   // keep what is shown; try again next time
      const data = await res.json();
      if (seq !== st.seq) return;
      const all = (data && Array.isArray(data.handOffs)) ? data.handOffs : [];
      render(box, visible(all));
      st.open = all.some((v) => v && isOpen(v.state));   // polling follows every open one, shown or not
    } catch { /* offline or a bad answer: keep what is shown */ }
  }

  function tick() {
    let agent = null, box = null;
    try { agent = st.getAgent() || null; box = st.getContainer() || null; } catch { /* page not ready */ }
    if (agent !== st.agent || box !== st.box) {
      if (st.box && st.box !== box) render(st.box, []);
      st.agent = agent; st.box = box; st.open = false;
      return load();
    }
    if (agent && box && st.open && Date.now() - st.last >= POLL_MS) return load();
  }

  function track({ getAgent, getContainer, fetchFn } = {}) {
    st.getAgent = getAgent; st.getContainer = getContainer; st.fetchFn = fetchFn || null;
    if (st.timer) return;
    st.timer = setInterval(tick, TICK_MS);
    tick();
  }

  function refreshSoon() {
    if (!st.getAgent || st.soon) return;
    st.soon = setTimeout(() => { st.soon = null; if (st.agent && st.box) load(); }, SOON_MS);
  }

  return { stateLabel, cardModel, statusHref, visible, render, track, refreshSoon, POLL_MS };
});
