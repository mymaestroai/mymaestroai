/**
 * ui-team-card.js — the one-time "Set up your team" card (shared by index.html and mobile.html).
 *
 * An install that existed before the starter team is offered it here, never added without a tap. On load the page asks
 * GET /api/team/card (admin only: a member's 403, a signed-out 401 or "show: false" shows nothing at all). The card is
 * fixed at the bottom right on wide screens and a bottom sheet on narrow ones. "Create these agents" sends
 * POST /api/welcome/team with the roles and models shown (`expect`); "Not now" records the answer; the x only closes it for
 * this page load. Everything that comes from the server goes in as text nodes, never as markup.
 *
 * Browser: window.TeamCard (starts itself). Node (tests): module.exports (does not start itself; call start()).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (typeof document !== 'undefined' && typeof fetch === 'function') api.autostart();
  if (root) root.TeamCard = api;
})(typeof window !== 'undefined' ? window : null, function () {
  const JOBS = { challenger: 'Checks important work and finds what is wrong', scout: 'Lookups, searches and summaries', builder: 'Coding and multi-step work', researcher: 'Research and writing' };
  const INTRO = 'Your lead agent can work with a small team: a Challenger that checks important work, and helpers on cheaper models for the volume. Nothing is added unless you choose it.';
  const CHANGED = 'The team changed since it was shown. Check it, then press Create these agents.';
  const CSS = [
    '#team-card { position: fixed; right: 16px; bottom: 16px; width: 380px; max-height: 80vh; overflow-y: auto; z-index: 900; box-sizing: border-box; padding: 14px 16px; border-radius: 12px; border: 1px solid var(--border); background: var(--bg-card, #1a1a19); color: var(--text); box-shadow: 0 6px 24px rgba(0,0,0,.35); font-size: 14px; }',
    '@media (max-width: 520px) { #team-card { left: 0; right: 0; bottom: 0; width: auto; max-height: 70vh; border-radius: 14px 14px 0 0; } }',
    '#team-card .tc-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }',
    '#team-card .tc-title { font-weight: 600; font-size: 15px; }',
    '#team-card .tc-x { background: none; border: none; color: var(--text-dim); font-size: 18px; cursor: pointer; padding: 2px 6px; }',
    '#team-card .tc-intro { margin-top: 6px; color: var(--text-dim); font-size: 13px; }',
    '#team-card .tc-row { display: flex; gap: 10px; align-items: flex-start; margin-top: 10px; }',
    '#team-card .tc-ico { flex: none; width: 22px; text-align: center; }',
    '#team-card .tc-nm { font-weight: 600; } #team-card .tc-job { color: var(--text-dim); font-size: 13px; }',
    '#team-card .tc-mdl { font-size: 12px; color: var(--text-dim); margin-top: 2px; word-break: break-all; }',
    '#team-card .tc-pay.tc-per-use { color: var(--warning); font-weight: 600; }',
    '#team-card .tc-note, #team-card .tc-why { font-size: 12px; color: var(--text-dim); margin-top: 2px; }',
    '#team-card .tc-msg { margin-top: 10px; font-size: 13px; color: var(--text-dim); }',
    '#team-card .tc-btns { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }',
    '#team-card button.tc-go { background: var(--accent); color: #fff; border: none; border-radius: 8px; padding: 8px 14px; cursor: pointer; }',
    '#team-card button.tc-later { background: none; color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 8px 14px; cursor: pointer; }',
    '#team-card button:disabled { opacity: .6; cursor: default; }',
    '#team-card a { color: var(--accent); }',
  ].join('\n');

  const st = { plan: null, card: null, rows: null, msg: null, go: null, later: null, busy: false, done: false, closed: false };

  function tEl(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function modelPart(id) { const s = String(id || ''); const i = s.indexOf('/'); return i >= 0 ? s.slice(i + 1) : s; }
  function payText(e) { return e.perUse ? 'billed per use' : (e.tier === 'local' || String(e.route || '').toLowerCase() === 'local') ? 'local' : 'subscription'; }
  function modelLine(e) { const m = tEl('div', 'tc-mdl', modelPart(e.model) + ' · '); m.appendChild(tEl('span', e.perUse ? 'tc-pay tc-per-use' : 'tc-pay', payText(e))); return m; }
  function skipReason(e) {
    if (e.reason === 'name taken') return `You already have an agent called ${e.display}: it is kept as it is`;
    if (e.reason === 'created before') return 'Already set up';
    if (e.reason === 'interrupted') return 'An earlier setup of this agent stopped halfway: add it yourself if you want it';
    if (e.reason === 'no model') return e.note || 'No suitable model is connected for this one yet';
    return e.error || e.reason || 'Not created';
  }
  function row(e, extra) {
    const r = tEl('div', 'tc-row'); r.appendChild(tEl('span', 'tc-ico', e.icon || ''));
    const body = tEl('div'); const head = tEl('div');
    head.appendChild(tEl('span', 'tc-nm', e.display || e.name));
    head.appendChild(document.createTextNode(' '));
    head.appendChild(tEl('span', 'tc-job', JOBS[e.role] || ''));
    body.appendChild(head);
    if (extra) body.appendChild(extra);
    else if (e.action === 'create') {
      body.appendChild(modelLine(e));
      if (e.note) body.appendChild(tEl('div', 'tc-note', e.note));
    } else body.appendChild(tEl('div', 'tc-why', skipReason(e)));
    r.appendChild(body); return r;
  }
  const toCreate = () => (st.plan || []).filter((e) => e.action === 'create');

  async function call(method, url, body) {
    try {
      const init = { method, headers: { 'Content-Type': 'application/json' } };
      if (body !== undefined) init.body = JSON.stringify(body);
      const res = await fetch(url, init);
      let data = null; try { data = await res.json(); } catch { data = null; }
      return { status: res.status, body: data };
    } catch { return { status: 0, body: null }; }
  }

  function setBusy(b) { st.busy = b; if (st.go) st.go.disabled = b; if (st.later) st.later.disabled = b; }
  function close() { st.closed = true; if (st.card && st.card.parentNode) st.card.parentNode.removeChild(st.card); st.card = null; }

  function render() {
    if (!st.card) return;
    st.rows.replaceChildren();
    for (const e of st.plan || []) st.rows.appendChild(row(e));
    const any = !st.done && toCreate().length > 0;
    st.go.hidden = !any; st.later.hidden = st.done;
  }

  function build() {
    const style = tEl('style', '', CSS);
    const card = tEl('div'); card.id = 'team-card'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', 'Set up your team');
    card.appendChild(style);
    const head = tEl('div', 'tc-head'); head.appendChild(tEl('span', 'tc-title', 'Set up your team'));
    const x = tEl('button', 'tc-x', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Close'); x.addEventListener('click', close);
    head.appendChild(x); card.appendChild(head);
    card.appendChild(tEl('div', 'tc-intro', INTRO));
    st.rows = tEl('div'); card.appendChild(st.rows);
    st.msg = tEl('div', 'tc-msg'); card.appendChild(st.msg);
    const btns = tEl('div', 'tc-btns');
    st.go = tEl('button', 'tc-go', 'Create these agents'); st.go.type = 'button'; st.go.addEventListener('click', () => { create(); });
    st.later = tEl('button', 'tc-later', 'Not now'); st.later.type = 'button'; st.later.addEventListener('click', () => { notNow(); });
    btns.appendChild(st.go); btns.appendChild(st.later); card.appendChild(btns);
    st.card = card;
    (document.body || document.documentElement).appendChild(card);
  }

  /** Ask the hub; show the card only when it says so. Never throws; a non-200 answer (a member's 403) shows nothing. */
  async function start() {
    let again = false;
    try { again = /(^|[?&])team=setup(&|$)/.test(String(location.search || '')); } catch { again = false; }
    const r = await call('GET', '/api/team/card' + (again ? '?again=1' : ''));
    if (r.status !== 200 || !r.body || r.body.show !== true || !Array.isArray(r.body.plan)) return false;
    st.plan = r.body.plan; st.done = false; st.closed = false;
    if (!st.card) build();
    st.msg.textContent = '';
    render();
    return true;
  }

  async function create() {
    if (st.busy || st.done || !st.card) return;
    const shown = toCreate();
    if (!shown.length) return;
    setBusy(true);
    try {
      const r = await call('POST', '/api/welcome/team', { expect: shown.map((e) => ({ role: e.role, model: e.model })) });
      if (!st.card) return;
      if (r.status === 409 && r.body && r.body.changed && Array.isArray(r.body.plan)) {
        st.plan = r.body.plan; render(); st.msg.textContent = CHANGED; return;
      }
      if (r.status !== 200 || !r.body || !Array.isArray(r.body.created)) { st.msg.textContent = 'The team could not be created just now. Press Create these agents to try again.'; return; }
      const failed = (r.body.skipped || []).filter((e) => e.reason === 'failed');
      if (!r.body.created.length && failed.length) { st.msg.textContent = `The team could not be created: ${failed[0].error || 'an error'}. Press Create these agents to try again.`; return; }
      st.done = true; st.msg.textContent = '';
      st.rows.replaceChildren();
      // In the plan's order (the role order), created and skipped alike.
      const order = (e) => { const i = (st.plan || []).findIndex((p) => p.role === e.role); return i < 0 ? 99 : i; };
      r.body.created.sort((a, b) => order(a) - order(b));
      if (Array.isArray(r.body.skipped)) r.body.skipped.sort((a, b) => order(a) - order(b));
      const made = new Map();
      for (const e of r.body.created) {
        const extra = tEl('div'); extra.appendChild(modelLine(e));
        const done = tEl('div', 'tc-why', 'Created. '); extra.appendChild(done);
        const a = tEl('a', '', 'Change'); a.href = '/agent-settings.html?agent=' + encodeURIComponent(e.name); a.target = '_blank'; a.rel = 'noopener'; done.appendChild(a);
        if (e.warning) done.appendChild(document.createTextNode(' ' + e.warning));
        made.set(e.role, row(e, extra));
      }
      for (const e of (r.body.skipped || [])) made.set(e.role, row(e, e.reason === 'failed' ? tEl('div', 'tc-why', skipReason(e)) : null));
      for (const [, el] of [...made.entries()].sort((x, y) => order({ role: x[0] }) - order({ role: y[0] }))) st.rows.appendChild(el);
      st.go.hidden = true; st.later.hidden = true;
    } finally { setBusy(false); }
  }

  /** "Not now": record the answer, then close (closed even when the answer could not be recorded: it comes back next load). */
  async function notNow() {
    if (st.busy || !st.card) return;
    setBusy(true);
    try { await call('POST', '/api/team/card/answer', { answer: 'later' }); }
    finally { setBusy(false); close(); }
  }

  function autostart() {
    const go = () => { start().catch(() => {}); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
  }

  return { start, create, notNow, close, render, autostart, state: st, skipReason, payText, modelPart };
});
