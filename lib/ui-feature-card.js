/**
 * ui-feature-card.js — the "new features are off until you say yes" card (shared by index.html and mobile.html).
 *
 * New features that arrive switched off reach the owner as ONE card in the lead agent's chat, with the switch on it.
 * The page asks GET /api/behaviour-changes/card on load, when it becomes visible again after 5+ minutes hidden, and when
 * the lead's chat opens. Admin only: a member's 403, a signed-out 401 or "show: false" shows nothing at all.
 * Each feature is a row (title, summary, "Cost: ...", the lead's recommendation) with "Turn on", "Leave off" and
 * "Ask me in a week"; quiet features that are already on are a row "<title> is now on. <line>" with "Turn off" and "OK".
 * A press sends POST /api/behaviour-changes/<id> { decision: 'on' | 'off' | 'snooze' | 'seen', rev } (rev: the state phrase the row was
 * drawn from; a 409 'already decided' means another device answered or snoozed first, so the card is fetched again; a 401/403 fetches it
 * again too: denied there clears the card, else the row shows the server's text; a row with canSwitch false has no buttons); the row's buttons give way
 * to a plain result line, and when every row is answered one closing line shows. Server text only goes in as text nodes.
 *
 * Where it sits: as the LAST child of the lead's message list (a message from the lead). The page calls
 *   FeatureCard.chatShown(agentName, listElement)
 * when a chat is opened or drawn (desktop: each chat panel's .messages list; phone: the one #messages list, called again
 * with the new agent name on every chat switch). A MutationObserver on that list puts the card back after the chat draws
 * its messages again (it only acts when the card is no longer the last child). Exactly one chat copy exists per page.
 *
 * For the Settings page:
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
  const FAILED = 'This could not be saved just now. Try again.';
  const HIDDEN_MS = 5 * 60 * 1000;     // back after this long hidden: ask again
  const STALE_MS = 10 * 1000;          // opening the lead's chat asks again when the last answer is older than this
  const OWNER_ONLY = 'Only the owner of this Maestro can switch this one.';
  const RESULT = { on: 'Turned on.', off: 'Left off.', snooze: 'I will ask again next week.' };
  const CSS = [
    '.feature-card { box-sizing: border-box; width: 100%; max-width: 640px; margin: 8px 0; padding: 12px 14px; border-radius: 12px; border: 1px solid var(--accent); background: var(--bg-card); color: var(--text); font-size: 14px; line-height: 1.4; text-align: left; align-self: flex-start; }',
    '.feature-card .fc-head { font-weight: 600; font-size: 15px; padding-bottom: 8px; }',
    '.feature-card .fc-row { padding: 10px 0; border-top: 1px solid var(--border); }',
    '.feature-card .fc-title { font-weight: 700; }',
    '.feature-card .fc-sum { margin-top: 2px; color: var(--text-dim); }',
    '.feature-card .fc-cost { margin-top: 2px; font-size: 13px; color: var(--text-dim); }',
    '.feature-card .fc-rec { margin-top: 2px; font-size: 13px; color: var(--text); }',
    '.feature-card .fc-done { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; }',
    '.feature-card .fc-done .fc-result { margin-top: 0; }',
    '.feature-card .fc-link { min-height: 0; padding: 0; border: none; background: none; color: var(--accent); text-decoration: underline; }',
    '.feature-card .fc-btns { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }',
    '.feature-card button { min-height: 36px; padding: 6px 14px; border-radius: 8px; border: 1px solid var(--border); background: none; color: var(--text); font: inherit; cursor: pointer; }',
    '.feature-card button.fc-go { background: var(--accent); color: var(--on-accent); border-color: var(--accent); font-weight: 600; }',
    '.feature-card button:disabled { opacity: .6; cursor: default; }',
    '.feature-card .fc-result, .feature-card .fc-closing { margin-top: 8px; color: var(--text-dim); }',
    '.feature-card .fc-result:focus { outline: none; }',
    '.feature-card .fc-error { margin-top: 8px; color: var(--warning); }',
    '.feature-card .fc-owner { margin-top: 8px; color: var(--text-dim); }',
    '.feature-card .fc-closing { padding-top: 10px; border-top: 1px solid var(--border); }',
    '.feature-card button.fc-toggle { display: block; width: 100%; min-height: 36px; padding: 0; border: none; background: none; color: var(--text); font-weight: 600; font-size: 15px; text-align: left; cursor: pointer; }',
    '.feature-card button.fc-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }',
  ].join('\n');

  // rows: { kind: 'entry' | 'notice', id, data, phase: 'open' | 'busy' | 'done' | 'gone', result, error }
  const st = { lead: '', leadDisplay: '', rows: [], fetchedAt: 0, denied: false, inflight: null, chat: null, lists: new Map(), seq: 0, target: null, observer: null, copies: [], hiddenAt: 0, styled: false, gen: 0, hold: 0, suspect: false };

  function tEl(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  const now = () => Date.now();
  const visible = () => st.hold === 0 && !st.suspect && st.rows.length > 0;   // suspect: a press was denied; only a 200 card answer clears it. hold: denied presses being checked again (a count: two at once both hold): nothing is drawn

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
  // fetchSeq: st.seq when the request started; a row answered after that is not reopened by this (older) answer.
  // The card answer names the lead; no lead (null) or another one: the chat copy leaves the old lead's list (settleChat/placeChat do the move).
  function setLead(b) {
    st.lead = typeof b.lead === 'string' ? b.lead : '';
    st.leadDisplay = typeof b.leadDisplay === 'string' ? b.leadDisplay : '';
  }
  function apply(b, fetchSeq = st.seq) {
    setLead(b);
    const wanted = [];
    for (const e of Array.isArray(b.entries) ? b.entries : []) if (e && e.id) wanted.push({ kind: 'entry', id: String(e.id), data: e });
    for (const n of Array.isArray(b.notices) ? b.notices : []) if (n && n.id) wanted.push({ kind: 'notice', id: String(n.id), data: n });
    const key = (k, id) => k + ':' + id;
    const byKey = new Map(wanted.map((w) => [key(w.kind, w.id), w]));
    const next = [];
    const have = new Set();
    for (const r of st.rows) {
      const w = byKey.get(key(r.kind, r.id));
      if (w) {
        // listed and actionable again (a snooze ended, a Restore) after being answered here: back to open with fresh data and buttons
        const again = (r.phase === 'done' || r.phase === 'gone') && (r.answeredSeq || 0) <= fetchSeq;
        if (r.phase === 'open' || r.refetch || again) { r.data = w.data; r.phase = 'open'; r.refetch = false; r.result = ''; r.error = ''; r.undoRev = ''; }
        next.push(r); have.add(key(r.kind, r.id));
      } else if (r.refetch) { /* it was answered elsewhere and is not listed any more: it goes */ }
      else if (r.phase !== 'open') next.push(r);   // answered here: it keeps its result line
    }
    for (const w of wanted) if (!have.has(key(w.kind, w.id))) next.push({ kind: w.kind, id: w.id, data: w.data, phase: 'open', result: '', error: '' });
    st.rows = next;
  }
  function clearOpen() { st.rows = st.rows.filter((r) => r.phase !== 'open' && !r.refetch); }
  /** Someone who lost access sees nothing: every row (answered too) and every copy (chat and Settings) goes. */
  function clearAll() {
    st.rows = [];
    for (const c of st.copies) { try { c.root.replaceChildren(); if (c.root.parentNode) c.root.parentNode.removeChild(c.root); } catch { /* gone */ } }
    st.copies = []; st.target = null; unwatch();
  }

  /** Ask the hub (one request at a time). Resolves to whether a card shows. A failed request keeps what is drawn. */
  function fetchCard() {
    if (st.inflight) return st.inflight;
    st.inflight = (async () => {
      const fetchSeq = st.seq; const gen = st.gen;
      const r = await call('GET', '/api/behaviour-changes/card');
      if (gen !== st.gen) return visible();   // superseded (access was in question when it began): its answer is not applied
      st.fetchedAt = now();
      if (r.status === 401 || r.status === 403) { st.denied = true; st.suspect = false; clearAll(); }
      else if (r.status === 200 && r.body && r.body.ok !== false && r.body.show === true) { st.denied = false; st.suspect = false; apply(r.body, fetchSeq); }
      else if (r.status === 200 && r.body) { st.denied = false; st.suspect = false; setLead(r.body); clearOpen(); }
      settleChat();
      paintAll();
      return visible();
    })().finally(() => { st.inflight = null; });
    return st.inflight;
  }

  // ---- drawing ----
  function headerText() {
    const open = (r) => r.phase === 'open' || r.phase === 'busy';
    const n = st.rows.filter((r) => r.kind === 'entry' && open(r)).length;
    if (!n) return st.rows.some((r) => r.kind === 'notice' && open(r)) ? 'New features were turned on for you.' : '';
    const w = n <= 10 ? WORDS[n] : String(n);
    // every open row is one this viewer may not switch (an admin who is not the owner) and nothing else is open: the owner is the one to say yes
    const locked = st.rows.every((r) => !open(r) || (r.kind === 'entry' && !!r.data && r.data.canSwitch === false));
    const who = locked ? 'the owner says' : 'you say';
    return n === 1 ? `${w} new feature is off until ${who} yes.` : `${w} new features are off until ${who} yes.`;
  }
  function recLine(rec) {
    if (!rec || (rec.decision !== 'on' && rec.decision !== 'off')) return '';
    return `${st.leadDisplay || 'Maestro'} recommends: ${rec.decision === 'on' ? 'Turn on' : 'Leave off'}: ${rec.why || ''}`.trim();
  }
  /** The closing line's link: the Changes page, in this tab (API.openChanges when the page sets one). */
  function openChanges() {
    if (typeof API.openChanges === 'function') { try { API.openChanges(); } catch { /* cosmetic */ } return; }
    try { if (typeof location !== 'undefined' && location && typeof location.assign === 'function') location.assign('/changes'); } catch { /* cosmetic */ }
  }
  function closingEl() {
    const el = tEl('div', 'fc-closing', 'All set. You can change these any time on the ');
    const b = tEl('button', 'fc-link', 'Changes page'); b.type = 'button'; b.setAttribute('type', 'button');
    b.addEventListener('click', openChanges);
    el.appendChild(b); el.appendChild(document.createTextNode ? document.createTextNode('.') : tEl('span', '', '.'));
    return el;
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
      const wrap = tEl('div', 'fc-done'); wrap.appendChild(res); refs.result = res;
      if (row.undoRev) {
        const u = tEl('button', 'fc-no', 'Undo'); u.type = 'button'; u.setAttribute('type', 'button'); u.disabled = !!row.undoing;
        u.addEventListener('click', () => { undo(copy, row); });
        wrap.appendChild(u);
      }
      el.appendChild(wrap);
      if (row.error) { const er = tEl('div', 'fc-error', row.error); er.setAttribute('role', 'alert'); el.appendChild(er); }
    } else {
      const locked = row.kind === 'entry' && d.canSwitch === false;   // the lead may not switch it and this person is not the owner
      if (row.error && !(locked && row.error === OWNER_ONLY)) { const er = tEl('div', 'fc-error', row.error); er.setAttribute('role', 'alert'); el.appendChild(er); }
      if (locked) el.appendChild(tEl('div', 'fc-owner', OWNER_ONLY));
      const bar = tEl('div', 'fc-btns');
      const list = row.kind === 'entry'
        ? [['Turn on', 'on', !!(d.recommendation && d.recommendation.decision === 'on')], ['Leave off', 'off', false], ['Ask me in a week', 'snooze', false]]
        : [['Turn off', 'off', false], ['OK', 'seen', false]];
      if (!locked) {
        for (const [label, dec, prim] of list) { const b = button(copy, row, label, dec, prim); bar.appendChild(b); if (!refs.first) refs.first = b; }
        if (row.phase === 'busy') bar.setAttribute('aria-busy', 'true');
        el.appendChild(bar);
      }
    }
    copy.refs[row.id + ':' + row.kind] = refs;
    return el;
  }
  function paintCopy(copy, focus) {
    copy.refs = {};
    const root = copy.root;
    if (!visible()) { root.replaceChildren(); if (copy.kind === 'page' && root.parentNode) root.parentNode.removeChild(root); return; }
    if (copy.kind === 'page' && copy.host && root.parentNode !== copy.host) copy.host.appendChild(root);
    const kids = []; const head = headerText();
    const foldable = copy.kind === 'chat';   // the Settings copy never folds
    if (foldable && copy.folded) {
      // folded: only the header line, as a button that opens the card again
      const t = tEl('button', 'fc-toggle', (head || 'New features') + ' \u25BE'); t.type = 'button'; t.setAttribute('type', 'button'); t.setAttribute('aria-expanded', 'false');
      t.addEventListener('click', () => { toggleFold(copy); });
      copy.toggle = t;
      root.replaceChildren(t);
      if (focus === 'toggle') { try { t.focus(); } catch { /* cosmetic */ } }
      return;
    }
    if (foldable && copy.wasFolded) {
      const t = tEl('button', 'fc-toggle fc-head', (head || 'New features') + ' \u25B4'); t.type = 'button'; t.setAttribute('type', 'button'); t.setAttribute('aria-expanded', 'true');
      t.addEventListener('click', () => { toggleFold(copy); });
      copy.toggle = t;
      kids.push(t);
    } else if (head) kids.push(tEl('div', 'fc-head', head));
    const rows = st.rows.filter((r) => r.phase !== 'gone');
    for (const r of rows) kids.push(rowEl(copy, r));
    if (rows.every((r) => r.phase === 'done') ) kids.push(closingEl());
    root.replaceChildren(...kids);
    if (focus && focus.id !== undefined) doFocus(copy, focus);
    else if (focus === 'first') {   // just unfolded: the first button of the first open row
      let done = false;
      for (const r of st.rows) { const f = (copy.refs[r.id + ':' + r.kind] || {}).first; if (f && !f.disabled) { try { f.focus(); } catch { /* cosmetic */ } done = true; break; } }
      if (!done && copy.toggle) { try { copy.toggle.focus(); } catch { /* cosmetic */ } }   // nothing to press (every row locked): the toggle keeps focus
    }
  }
  function toggleFold(copy) {
    copy.folded = !copy.folded; copy.wasFolded = true;
    paintCopy(copy, copy.folded ? 'toggle' : 'first');
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
    return { kind, root, host: host || null, refs: {}, folded: false, wasFolded: false };
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
    const pf = st.pendingFold;
    if (pf && st.chat && pf.list === st.chat.list && pf.agent === st.chat.agent && st.target === pf.list) {
      st.pendingFold = null;
      if (!c.folded) { c.folded = true; c.wasFolded = true; paintCopy(c); }   // a live message came first in this visit: arrive folded
    }
    placeAtEnd(st.target, c.root);
    if (!c.root.children.length) paintCopy(c);
    watch(st.target);
  }
  // Another part of the page may keep its own element at the very end of the same list (the phone's "busy" card does, with its own
  // MutationObserver). Two "stay last" observers would move each other back and forth for ever (one such loop grew a browser page to
  // hundreds of GB), so the card yields: it sits just above such an element. MOVES_PER_SEC is a backstop against any other pair.
  const MOVES_PER_SEC = 120;
  function isPinned(el) {
    if (!el) return false;
    const busy = el.classList && typeof el.classList.contains === 'function' && el.classList.contains('chat-busy-card');
    return !!(busy || (typeof el.hasAttribute === 'function' && el.hasAttribute('data-keep-last')));
  }
  /** The last direct child that keeps itself at the end, wherever it is now: the desktop's busy card has no observer, so a bubble
   *  can land after it until its next paint. */
  function pinnedIn(list, root) {
    const kids = list.children ? Array.from(list.children) : [];
    for (let i = kids.length - 1; i >= 0; i--) if (kids[i] !== root && isPinned(kids[i])) return kids[i];
    return null;
  }
  /** At most MOVES_PER_SEC moves a second. A tripped limit retries once a second later; two tripped seconds in a row and the card
   *  stops moving in this list until the next chat switch (something else keeps fighting for the end). */
  function mayMove() {
    if (st.gaveUp) return false;
    const t = now();
    if (!st.moveWindow || t - st.moveWindow >= 1000) {
      st.trips = st.windowTripped ? (st.trips || 0) : 0;
      st.moveWindow = t; st.moves = 0; st.windowTripped = false;
    }
    st.moves = (st.moves || 0) + 1;
    if (st.moves <= MOVES_PER_SEC) return true;
    if (!st.windowTripped) {
      st.windowTripped = true; st.trips = (st.trips || 0) + 1;
      if (st.trips >= 2) st.gaveUp = true;
      else if (!st.retryTimer && typeof setTimeout === 'function') st.retryTimer = setTimeout(() => { st.retryTimer = null; if (!st.gaveUp) placeChat(); }, 1000);
    }
    return false;
  }
  function placeAtEnd(list, root) {
    const pin = pinnedIn(list, root);
    if (pin) {
      const last = list.lastElementChild !== undefined ? list.lastElementChild : list.lastChild;
      if (last !== pin) { if (!mayMove()) return; list.appendChild(pin); }   // it keeps itself last: put it back there
      if (root.parentNode !== list || root.nextElementSibling !== pin) { if (mayMove()) list.insertBefore(root, pin); }
      return;
    }
    if (list.lastChild !== root && mayMove()) list.appendChild(root);
  }
  function watch(list) {
    if (st.observer && st.observer.list === list) return;
    unwatch();
    if (typeof MutationObserver !== 'function') return;
    const o = new MutationObserver((records) => {
      const copy = chatCopy();
      if (!st.target || !copy || !visible()) return;
      placeAtEnd(st.target, copy.root);
    });
    o.list = list;
    o.observe(list, { childList: true });
    st.observer = o;
  }
  /** The page calls this where a LIVE message is added to the open chat (the person's own sent message, the start of a live reply),
   *  never where saved history is drawn: the chat copy then folds to its header line so the message can be read. */
  function messageArrived(list) {
    const copy = chatCopy();
    if (!copy || !copy.root.parentNode || !visible() || !st.target) {
      // no card on screen yet (its first answer may still be on the way): remember the live message for this chat visit, so the
      // card starts folded when it attaches here; a switch to another chat forgets it (chatShown)
      if (st.chat && (!list || st.chat.list === list)) st.pendingFold = { list: st.chat.list, agent: st.chat.agent };
      return;
    }
    if (copy.folded) return;
    if (list ? st.target !== list : copy.root.parentNode !== st.target) return;
    let hadFocus = false;
    try {
      const a = typeof document !== 'undefined' ? document.activeElement : null;
      hadFocus = !!(a && copy.root && typeof copy.root.contains === 'function' && copy.root.contains(a));
    } catch { hadFocus = false; }
    copy.folded = true; copy.wasFolded = true;
    paintCopy(copy, hadFocus ? 'toggle' : null);
  }
  function unwatch() { if (st.observer) { try { st.observer.disconnect(); } catch { /* gone */ } st.observer = null; } }
  /** Work out whether the chat the page last showed is the lead's. */
  function settleChat() {
    for (const [name, l] of [...st.lists]) if (l && l.isConnected === false) st.lists.delete(name);   // a closed chat is forgotten
    const c = st.chat;
    const leadList = st.lead ? st.lists.get(st.lead) || null : null;
    // The card sits in the lead's list whichever chat was shown last (desktop: one panel per chat). The phone has one shared list:
    // when the chat now in it is not the lead's, the card leaves.
    if (leadList && !(c && c.list === leadList && c.agent !== st.lead)) st.target = leadList;
    else if (st.target) { st.target = null; unwatch(); }
  }

  /** The page shows (or draws) a chat: agentName's message list. Cheap; safe to call on every render. */
  function chatShown(agent, list) {
    if (!list) return;
    if (!st.chat || st.chat.agent !== String(agent || '') || st.chat.list !== list) { st.pendingFold = null; st.gaveUp = false; st.trips = 0; st.moves = 0; st.moveWindow = 0; st.windowTripped = false; if (st.retryTimer) { try { clearTimeout(st.retryTimer); } catch { /* gone */ } st.retryTimer = null; } }   // a chat switch: the move limit starts over
    st.chat = { agent: String(agent || ''), list };
    st.lists.set(st.chat.agent, list);
    settleChat();
    if (st.lead) placeChat();   // another agent's chat: the card leaves a list they share
    if (!st.denied && (!st.fetchedAt || now() - st.fetchedAt > STALE_MS) && !st.inflight) fetchCard().catch(() => {});
  }

  // ---- answering ----
  async function press(copy, row, decision) {
    if (row.phase !== 'open') return;
    row.phase = 'busy'; row.error = '';
    paintAll();
    // rev: the row's state phrase as the hub drew it (checked inside its write lock: a snooze or answer from another device makes this a 409);
    // a row without one (older hub) sends expect, the plain state.
    const r = await call('POST', '/api/behaviour-changes/' + encodeURIComponent(row.id), { decision, ...(typeof row.data.rev === 'string' ? { rev: row.data.rev } : { expect: row.kind === 'notice' ? 'on' : 'pending' }) });
    const body = r.body;
    const text = (body && typeof body.error === 'string' && body.error) || FAILED;
    if (r.status === 409 && body && body.error === 'already decided') {
      // answered elsewhere: ask again (after a fetch already running, so the answer reflects the other device); the row then shows the fresh state or goes
      row.refetch = true; row.error = '';
      paintAll();
      try { if (st.inflight) await st.inflight.catch(() => {}); await fetchCard(); } catch { /* handled below */ }
      if (row.refetch) { row.refetch = false; if (st.rows.includes(row)) { row.phase = 'open'; row.error = FAILED; } }
      paintAll({ copy, id: row.id, kind: row.kind });
      return;
    }
    if (r.status === 401 || r.status === 403) {
      // not allowed (the role may have been taken away): ask again. Denied there too: everything goes (fetchCard); else the row keeps the
      // server's text, and a fresh card that says canSwitch false turns the buttons into the owner-only line.
      // A GET already in flight began before this answer and may still carry the old rows: every copy is hidden at once (state kept),
      // that GET is marked superseded and waited for without applying its answer, and only a fresh GET draws.
      st.suspect = true;   // access in doubt: only a 200 card answer clears this
      row.refetch = true;   // the fresh answer replaces the row's data (canSwitch, rev) even though it is busy
      st.hold++; st.gen++; paintAll();
      try {
        try { if (st.inflight) await st.inflight.catch(() => {}); await fetchCard(); } catch { /* the row keeps its text */ }
        if (st.rows.includes(row)) { row.refetch = false; row.phase = 'open'; row.error = text; }
      } finally { st.hold = Math.max(0, st.hold - 1); }
      paintAll({ copy, id: row.id, kind: row.kind });
      return;
    }
    if (r.status === 200 && body && body.ok !== false) {
      row.error = ''; row.answeredSeq = ++st.seq;
      row.undoRev = row.kind === 'entry' && typeof body.rev === 'string' && body.rev ? body.rev : '';
      if (row.kind === 'notice' && decision === 'seen') { row.phase = 'gone'; }
      else { row.phase = 'done'; row.result = row.kind === 'notice' ? 'Turned off.' : (RESULT[decision] || ''); }
    } else {
      row.phase = 'open';
      row.error = text;
    }
    paintAll({ copy, id: row.id, kind: row.kind });
  }

  /** Undo a result: reopen the entry with the rev the press answered with. */
  async function undo(copy, row) {
    if (row.phase !== 'done' || !row.undoRev || row.undoing) return;
    row.undoing = true; row.error = '';
    paintAll();
    const r = await call('POST', '/api/behaviour-changes/' + encodeURIComponent(row.id), { decision: 'reopen', rev: row.undoRev });
    row.undoing = false;
    const body = r.body;
    if (r.status === 200 && body && body.ok !== false) {
      row.phase = 'open'; row.result = ''; row.error = ''; row.undoRev = ''; row.refetch = true;
      paintAll();
      try { if (st.inflight) await st.inflight.catch(() => {}); await fetchCard(); } catch { /* the row stays open with its old data */ }
      row.refetch = false;
    } else if (r.status === 409 && body && body.error === 'already decided') {
      row.refetch = true;
      paintAll();
      try { if (st.inflight) await st.inflight.catch(() => {}); await fetchCard(); } catch { /* handled below */ }
      if (row.refetch) { row.refetch = false; if (st.rows.includes(row)) { row.phase = 'open'; row.error = FAILED; } }
    } else if (r.status === 401 || r.status === 403) {
      // refused like a press: hide every copy until a fresh 200 card answer, and draw only from that answer
      const text = (body && typeof body.error === 'string' && body.error) || FAILED;
      st.suspect = true; row.refetch = true;
      st.hold++; st.gen++; paintAll();
      try {
        try { if (st.inflight) await st.inflight.catch(() => {}); await fetchCard(); } catch { /* the row keeps its text */ }
        if (st.rows.includes(row)) { row.refetch = false; row.error = text; }
      } finally { st.hold = Math.max(0, st.hold - 1); }
    } else {
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

  const API = { openSettings: null, start, refresh, renderInto, chatShown, messageArrived, autostart, state: st, CSS, headerText };
  return API;
});
