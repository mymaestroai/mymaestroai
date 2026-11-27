/**
 * ui-feature-card.js — the "new features are off until you say yes" card (shared by index.html and mobile.html).
 *
 * New features that arrive switched off reach the owner as ONE card in the lead agent's chat, with the switch on it.
 * The page asks GET /api/behaviour-changes/card on load, when it becomes visible again after 5+ minutes hidden, and when
 * the lead's chat opens. Admin only: a member's 403, a signed-out 401 or "show: false" shows nothing at all.
 * Each feature is a row (title, summary, "Cost: ...", the lead's recommendation) with "Turn on", "Leave off" and
 * "Ask me in a week"; quiet features that are already on are a row "<title> is now on. <line>" with "Turn off" and "OK".
 * A press sends POST /api/behaviour-changes/<id> { decision: 'on' | 'off' | 'snooze' | 'seen' }; the row's buttons give way
 * to a plain result line, and when every row is answered one closing line shows. Server text only goes in as text nodes.
 *
 * Where it sits: as the LAST child of the lead's message list (a message from the lead). The page calls
 *   FeatureCard.chatShown(agentName, listElement)
 * when a chat is opened or drawn (desktop: each chat panel's .messages list; phone: the one #messages list, called again
 * with the new agent name on every chat switch). A MutationObserver on that list puts the card back after the chat draws
 * its messages again (it only acts when the card is no longer the last child). Exactly one chat copy exists per page.
 *
 * For the Settings page ("For your review"):
 *   FeatureCard.renderInto(containerElement) -> Promise<boolean>  draws the same card (same rows, buttons, behaviour) into
 *                                                that element (empty when there is nothing to show);
 *   FeatureCard.refresh()                    -> Promise<boolean>  refetches and redraws every copy (the chat's and each
 *                                                renderInto one); rows already answered keep their result line.
 * Answering in one copy updates all the others.
 *
 * Browser: window.FeatureCard (starts itself). Node (tests): module.exports (does not start itself; call start()).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (typeof document !== 'undefined' && typeof fetch === 'function') api.autostart();
  if (root) root.FeatureCard = api;
})(typeof window !== 'undefined' ? window : null, function () {
  const WORDS = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
  const CLOSING = 'All set. You can change these any time in Settings, For your review.';
  const FAILED = 'This could not be saved just now. Try again.';
  const HIDDEN_MS = 5 * 60 * 1000;     // back after this long hidden: ask again
  const STALE_MS = 10 * 1000;          // opening the lead's chat asks again when the last answer is older than this
  const RESULT = { on: 'Turned on.', off: 'Left off.', snooze: 'I will ask again next week.' };
  const CSS = [
    '.feature-card { box-sizing: border-box; width: 100%; max-width: 640px; margin: 8px 0; padding: 12px 14px; border-radius: 12px; border: 1px solid var(--border); background: var(--bg-card); color: var(--text); font-size: 14px; line-height: 1.4; text-align: left; align-self: flex-start; }',
    '.feature-card .fc-head { font-weight: 600; font-size: 15px; padding-bottom: 8px; }',
    '.feature-card .fc-row { padding: 10px 0; border-top: 1px solid var(--border); }',
    '.feature-card .fc-title { font-weight: 700; }',
    '.feature-card .fc-sum { margin-top: 2px; color: var(--text-dim); }',
    '.feature-card .fc-cost, .feature-card .fc-rec { margin-top: 2px; font-size: 13px; color: var(--text-dim); }',
    '.feature-card .fc-btns { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }',
    '.feature-card button { min-height: 36px; padding: 6px 14px; border-radius: 8px; border: 1px solid var(--border); background: none; color: var(--text); font: inherit; cursor: pointer; }',
    '.feature-card button.fc-go { background: var(--accent); color: var(--on-accent); border-color: var(--accent); font-weight: 600; }',
    '.feature-card button:disabled { opacity: .6; cursor: default; }',
    '.feature-card .fc-result, .feature-card .fc-closing { margin-top: 8px; color: var(--text-dim); }',
    '.feature-card .fc-result:focus { outline: none; }',
    '.feature-card .fc-error { margin-top: 8px; color: var(--warning); }',
    '.feature-card .fc-closing { padding-top: 10px; border-top: 1px solid var(--border); }',
  ].join('\n');

  // rows: { kind: 'entry' | 'notice', id, data, phase: 'open' | 'busy' | 'done' | 'gone', result, error }
  const st = { lead: '', leadDisplay: '', rows: [], fetchedAt: 0, denied: false, inflight: null, chat: null, target: null, observer: null, copies: [], hiddenAt: 0, styled: false };

  function tEl(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  const now = () => Date.now();
  const visible = () => st.rows.length > 0;

  async function call(method, url, body) {
    try {
      const init = { method, headers: { 'Content-Type': 'application/json' } };
      if (body !== undefined) init.body = JSON.stringify(body);
      const res = await fetch(url, init);
      let data = null; try { data = await res.json(); } catch { data = null; }
      return { status: res.status, body: data };
    } catch { return { status: 0, body: null }; }
  }

  function injectStyle() {
    if (st.styled) return;
    st.styled = true;
    const s = tEl('style', '', CSS); s.setAttribute('data-feature-card', '1');
    (document.head || document.body || document.documentElement).appendChild(s);
  }

  // ---- state from the server ----
  function apply(b) {
    st.lead = typeof b.lead === 'string' ? b.lead : st.lead; st.leadDisplay = typeof b.leadDisplay === 'string' ? b.leadDisplay : '';
    const wanted = [];
    for (const e of Array.isArray(b.entries) ? b.entries : []) if (e && e.id) wanted.push({ kind: 'entry', id: String(e.id), data: e });
    for (const n of Array.isArray(b.notices) ? b.notices : []) if (n && n.id) wanted.push({ kind: 'notice', id: String(n.id), data: n });
    const key = (k, id) => k + ':' + id;
    const byKey = new Map(wanted.map((w) => [key(w.kind, w.id), w]));
    const next = [];
    const have = new Set();
    for (const r of st.rows) {
      const w = byKey.get(key(r.kind, r.id));
      if (w) { if (r.phase === 'open') r.data = w.data; next.push(r); have.add(key(r.kind, r.id)); }
      else if (r.phase !== 'open') next.push(r);   // answered here: it keeps its result line
    }
    for (const w of wanted) if (!have.has(key(w.kind, w.id))) next.push({ kind: w.kind, id: w.id, data: w.data, phase: 'open', result: '', error: '' });
    st.rows = next;
  }
  function clearOpen() { st.rows = st.rows.filter((r) => r.phase !== 'open'); }

  /** Ask the hub (one request at a time). Resolves to whether a card shows. A failed request keeps what is drawn. */
  function fetchCard() {
    if (st.inflight) return st.inflight;
    st.inflight = (async () => {
      const r = await call('GET', '/api/behaviour-changes/card');
      st.fetchedAt = now();
      if (r.status === 401 || r.status === 403) { st.denied = true; clearOpen(); }
      else if (r.status === 200 && r.body && r.body.ok !== false && r.body.show === true) { st.denied = false; apply(r.body); }
      else if (r.status === 200 && r.body) { st.denied = false; if (typeof r.body.lead === 'string') st.lead = r.body.lead; clearOpen(); }
      settleChat();
      paintAll();
      return visible();
    })().finally(() => { st.inflight = null; });
    return st.inflight;
  }

  // ---- drawing ----
  function headerText() {
    const n = st.rows.filter((r) => r.kind === 'entry').length;
    if (!n) return 'New features were turned on for you.';
    const w = n <= 10 ? WORDS[n] : String(n);
    return n === 1 ? `${w} new feature is off until you say yes.` : `${w} new features are off until you say yes.`;
  }
  function recLine(rec) {
    if (!rec || (rec.decision !== 'on' && rec.decision !== 'off')) return '';
    return `${st.leadDisplay || 'Maestro'} recommends: ${rec.decision === 'on' ? 'Turn on' : 'Leave off'}: ${rec.why || ''}`.trim();
  }
  function button(copy, row, label, decision, primary) {
    const b = tEl('button', primary ? 'fc-go' : 'fc-no', label); b.type = 'button'; b.setAttribute('type', 'button');
    b.disabled = row.phase === 'busy';
    b.addEventListener('click', () => { press(copy, row, decision); });
    return b;
  }
  function rowEl(copy, row) {
    const d = row.data || {};
    const el = tEl('div', 'fc-row'); el.setAttribute('role', 'group'); el.setAttribute('aria-label', String(d.title || row.id));
    const refs = {};
    if (row.kind === 'entry') {
      el.appendChild(tEl('strong', 'fc-title', String(d.title || row.id)));
      if (d.summary) el.appendChild(tEl('div', 'fc-sum', String(d.summary)));
      if (d.cost) el.appendChild(tEl('div', 'fc-cost', 'Cost: ' + d.cost));
      const rec = recLine(d.recommendation); if (rec) el.appendChild(tEl('div', 'fc-rec', rec));
    } else {
      const line = tEl('div', 'fc-sum');
      line.appendChild(tEl('strong', 'fc-title', String(d.title || row.id)));
      line.appendChild(tEl('span', 'fc-line', ` is now on. ${d.line || ''}`.trimEnd()));
      el.appendChild(line);
    }
    if (row.phase === 'done') {
      const res = tEl('div', 'fc-result', row.result); res.setAttribute('role', 'status'); res.setAttribute('tabindex', '-1');
      el.appendChild(res); refs.result = res;
    } else {
      if (row.error) { const er = tEl('div', 'fc-error', row.error); er.setAttribute('role', 'alert'); el.appendChild(er); }
      const bar = tEl('div', 'fc-btns');
      const list = row.kind === 'entry'
        ? [['Turn on', 'on', true], ['Leave off', 'off', false], ['Ask me in a week', 'snooze', false]]
        : [['Turn off', 'off', false], ['OK', 'seen', false]];
      for (const [label, dec, prim] of list) { const b = button(copy, row, label, dec, prim); bar.appendChild(b); if (!refs.first) refs.first = b; }
      if (row.phase === 'busy') bar.setAttribute('aria-busy', 'true');
      el.appendChild(bar);
    }
    copy.refs[row.id + ':' + row.kind] = refs;
    return el;
  }
  function paintCopy(copy, focus) {
    copy.refs = {};
    const root = copy.root;
    if (!visible()) { root.replaceChildren(); if (copy.kind === 'page' && root.parentNode) root.parentNode.removeChild(root); return; }
    if (copy.kind === 'page' && copy.host && root.parentNode !== copy.host) copy.host.appendChild(root);
    const kids = [tEl('div', 'fc-head', headerText())];
    const rows = st.rows.filter((r) => r.phase !== 'gone');
    for (const r of rows) kids.push(rowEl(copy, r));
    if (rows.every((r) => r.phase === 'done') ) kids.push(tEl('div', 'fc-closing', CLOSING));
    root.replaceChildren(...kids);
    if (focus) doFocus(copy, focus);
  }
  function doFocus(copy, focus) {
    const refs = copy.refs[focus.id + ':' + focus.kind] || {};
    let target = refs.result || refs.first;
    if (!target) {   // the row is gone: the next open row's first button, else the card itself
      for (const r of st.rows) { const f = (copy.refs[r.id + ':' + r.kind] || {}).first; if (f && !f.disabled) { target = f; break; } }
      if (!target) { copy.root.setAttribute('tabindex', '-1'); target = copy.root; }
    }
    try { if (target && target.focus) target.focus(); } catch { /* cosmetic */ }
  }
  function newCopy(kind, host) {
    const root = tEl('div', 'feature-card'); root.setAttribute('role', 'region'); root.setAttribute('aria-label', 'New features');
    return { kind, root, host: host || null, refs: {} };
  }
  function paintAll(focus) {
    injectStyle();
    st.copies = st.copies.filter((c) => c.kind === 'chat' || !c.host || c.host.isConnected !== false);
    for (const c of st.copies) paintCopy(c, focus && focus.copy === c ? focus : null);
    placeChat();
  }

  // ---- the lead's chat ----
  function chatCopy() { return st.copies.find((c) => c.kind === 'chat') || null; }
  function placeChat() {
    const copy = chatCopy();
    if (!st.target || !visible()) { if (copy && copy.root.parentNode) copy.root.parentNode.removeChild(copy.root); return; }
    const c = copy || (() => { const n = newCopy('chat'); st.copies.push(n); paintCopy(n); return n; })();
    if (st.target.lastChild !== c.root) st.target.appendChild(c.root);
    if (!c.root.children.length) paintCopy(c);
    watch(st.target);
  }
  function watch(list) {
    if (st.observer && st.observer.list === list) return;
    unwatch();
    if (typeof MutationObserver !== 'function') return;
    const o = new MutationObserver(() => {
      const copy = chatCopy();
      if (!st.target || !copy || !visible()) return;
      if (st.target.lastChild !== copy.root) st.target.appendChild(copy.root);
    });
    o.list = list;
    o.observe(list, { childList: true });
    st.observer = o;
  }
  function unwatch() { if (st.observer) { try { st.observer.disconnect(); } catch { /* gone */ } st.observer = null; } }
  /** Work out whether the chat the page last showed is the lead's. */
  function settleChat() {
    const c = st.chat;
    if (c && st.lead && c.agent === st.lead) st.target = c.list;
    else if (c && st.target === c.list) { st.target = null; unwatch(); }
  }

  /** The page shows (or draws) a chat: agentName's message list. Cheap; safe to call on every render. */
  function chatShown(agent, list) {
    if (!list) return;
    st.chat = { agent: String(agent || ''), list };
    const known = !!st.lead;
    settleChat();
    if (known && st.target !== list) { placeChat(); }   // another agent's chat: the card leaves a list they share
    else if (known) placeChat();
    if (!st.denied && (!st.fetchedAt || now() - st.fetchedAt > STALE_MS) && !st.inflight) fetchCard().catch(() => {});
  }

  // ---- answering ----
  async function press(copy, row, decision) {
    if (row.phase !== 'open') return;
    row.phase = 'busy'; row.error = '';
    paintAll();
    const r = await call('POST', '/api/behaviour-changes/' + encodeURIComponent(row.id), { decision });
    const body = r.body;
    if (r.status === 200 && body && body.ok !== false) {
      row.error = '';
      if (row.kind === 'notice' && decision === 'seen') { row.phase = 'gone'; }
      else { row.phase = 'done'; row.result = row.kind === 'notice' ? 'Turned off.' : (RESULT[decision] || ''); }
    } else {
      row.phase = 'open';
      row.error = (body && typeof body.error === 'string' && body.error) || FAILED;
    }
    paintAll({ copy, id: row.id, kind: row.kind });
  }

  // ---- public ----
  async function start() { return fetchCard(); }
  async function refresh() { return fetchCard(); }
  /** Draw the card into a Settings element; resolves to whether there is anything to show. */
  async function renderInto(container) {
    if (!container) return false;
    let copy = st.copies.find((c) => c.host === container);
    if (!copy) { copy = newCopy('page', container); st.copies.push(copy); }
    return fetchCard();
  }

  function autostart() {
    const go = () => { start().catch(() => {}); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { st.hiddenAt = now(); return; }
      if (st.hiddenAt && now() - st.hiddenAt >= HIDDEN_MS && !st.denied) refresh().catch(() => {});
      st.hiddenAt = 0;
    });
  }

  return { start, refresh, renderInto, chatShown, autostart, state: st, CSS, headerText };
});
