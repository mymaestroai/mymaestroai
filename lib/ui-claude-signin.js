/**
 * ui-claude-signin.js — "Claude is signed out": the notice under a chat reply, the guided sign-in panel and the
 * "Sign in again" button of the health lists (shared by index.html and mobile.html).
 *
 * Talks to the routes in the part 2 contract:
 *   GET  /api/claude-signin          { canSignIn, adminName, words, attempt? }   (any signed-in person)
 *   POST /api/claude-signin/start    admins only
 *   POST /api/claude-signin/code     { code }, admins only; the code is never kept in the page after it is sent
 *   POST /api/claude-signin/cancel   admins only
 *
 *   notice(el, { detail, onResend })   appends the card (class cs-notice) to el; once per el. Returns the card.
 *   openPanel({ onResend, pollMs })    the modal "Sign in to Claude again" (one at a time)
 *   healthButton(item)                 a "Sign in again" button for a health item with action 'claude-signin', else null
 *
 * Every string from the server goes in with textContent, never as markup.
 * Browser: window.ClaudeSignin. Node (tests): module.exports.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.ClaudeSignin = api;
})(typeof window !== 'undefined' ? window : null, function () {
  const ENDPOINT = '/api/claude-signin';
  const CACHE_MS = 30 * 1000;
  const POLL_MS = 1500;
  const RUNNING = new Set(['starting', 'link', 'checking']);
  const TEXT = {
    signedOut: 'Claude is signed out on the computer that runs your Maestro.',
    openLink: 'Open this link on any computer or phone, sign in with the Claude account that has your plan, and approve.',
    pasteCode: 'The page then shows a code. Copy all of it and paste it here.',
    checking: 'Checking that Claude answers…',
    done: 'Signed in. Claude answers again. Send your message again.',
    terminal: 'Or on that computer, in a terminal: mymaestro connect claude',
    format: "That doesn't look like the whole code. Copy all of it and paste it again.",
    noLink: "The sign-in page link didn't look right. Start again.",
    unreachable: "Couldn't reach Maestro. Try again.",
    refused: 'Sign in with an admin account in your browser to do this.',
  };
  const STYLE = [
    '.cs-notice{box-sizing:border-box;max-width:100%;margin:8px 0;padding:10px 12px;border:1px solid var(--border,#444);border-left:3px solid var(--accent,#6aa9ff);border-radius:8px;background:var(--bg-card,#1e1e1e);color:var(--text,#eee);font-size:14px;line-height:1.4;overflow-wrap:anywhere}',
    '.cs-notice [hidden],.cs-overlay [hidden]{display:none!important}',
    '.cs-title{font-weight:600;margin:0 0 6px}',
    '.cs-small{font-size:12px;color:var(--text-dim,#9aa);margin:6px 0 0;overflow-wrap:anywhere}',
    '.cs-actions{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 0}',
    '.cs-btn{box-sizing:border-box;font:inherit;font-size:14px;padding:8px 14px;min-height:36px;border-radius:8px;border:1px solid var(--border,#444);background:var(--bg-input,#2a2a2a);color:var(--text,#eee);cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}',
    '.cs-btn-main{background:var(--accent,#6aa9ff);border-color:var(--accent,#6aa9ff);color:#000;font-weight:600}',
    '.cs-btn-link{background:none;border:none;color:var(--text-dim,#9aa);padding:4px 0;min-height:0;text-decoration:underline;font-size:12px}',
    '.cs-btn-small{padding:2px 10px;min-height:26px;font-size:13px;margin-left:10px}',
    '.cs-detail{margin:6px 0 0;padding:8px;border-radius:6px;background:var(--bg-input,#2a2a2a);color:var(--text,#eee);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:160px;overflow:auto}',
    '.cs-overlay{position:fixed;left:0;top:0;right:0;bottom:0;z-index:10050;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box}',
    '.cs-dialog{box-sizing:border-box;width:100%;max-width:460px;max-height:100%;overflow:auto;padding:18px;border:1px solid var(--border,#444);border-radius:12px;background:var(--bg-card,#1e1e1e);color:var(--text,#eee);font-size:15px;line-height:1.45}',
    '.cs-dialog h2{margin:0 0 10px;font-size:18px;color:var(--text,#eee)}',
    '.cs-dialog p{margin:8px 0;overflow-wrap:anywhere}',
    '.cs-input{box-sizing:border-box;width:100%;max-width:100%;font:inherit;padding:9px 10px;border-radius:8px;border:1px solid var(--border,#444);background:var(--bg-input,#2a2a2a);color:var(--text,#eee);margin:6px 0}',
    '.cs-err{color:var(--text,#eee);border-left:3px solid #e5534b;padding-left:8px}',
    '@media (max-width:480px){.cs-btn{width:100%}.cs-btn-link{width:auto}.cs-btn-small{width:auto}.cs-actions{flex-direction:column}.cs-dialog{padding:14px}}',
  ].join('\n');

  let infoCache = null;     // { at, value } for GET /api/claude-signin
  let infoPending = null;
  let current = null;       // the open panel's close function

  function ensureStyle() {
    if (typeof document === 'undefined') return;
    if (document.getElementById && document.getElementById('cs-style')) return;
    const st = document.createElement('style');
    st.id = 'cs-style';
    st.textContent = STYLE;
    (document.head || document.body).appendChild(st);
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }
  function button(label, cls, onClick) {
    const b = el('button', 'cs-btn' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    b.setAttribute('type', 'button');
    b.addEventListener('click', onClick);
    return b;
  }
  const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); };

  async function call(method, path, body) {
    try {
      const init = { method, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
      if (method === 'POST') { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body || {}); }
      const r = await fetch(path, init);
      let j = null;
      try { j = await r.json(); } catch { j = null; }
      return { status: r.status, json: (j && typeof j === 'object') ? j : {} };
    } catch { return { status: 0, json: {} }; }
  }

  /** GET /api/claude-signin, cached ~30 s (fresh: true skips the cache). Resolves to the answer or null. */
  function loadInfo(fresh) {
    if (!fresh && infoCache && Date.now() - infoCache.at < CACHE_MS) return Promise.resolve(infoCache.value);
    if (!fresh && infoPending) return infoPending;
    const p = call('GET', ENDPOINT).then((r) => {
      infoPending = null;
      const v = (r.status >= 200 && r.status < 300) ? r.json : null;
      if (v) infoCache = { at: Date.now(), value: v };
      return v;
    });
    if (!fresh) infoPending = p;
    return p;
  }

  const wordsOf = (info) => Object.assign({}, TEXT, (info && info.words && typeof info.words === 'object') ? info.words : {});
  const askAdmin = (info) => (info && info.adminName)
    ? 'Ask ' + info.adminName + ' to sign in again.'
    : 'Ask an admin of your Maestro to sign in again.';

  // ---- the notice ----
  function notice(parent, opts) {
    if (!parent || typeof document === 'undefined') return null;
    if (parent.__csNotice) return parent.__csNotice;
    opts = opts || {};
    ensureStyle();
    const card = el('div', 'cs-notice');
    card.setAttribute('role', 'status');
    parent.__csNotice = card;
    const title = el('div', 'cs-title', TEXT.signedOut);
    const body = el('div', 'cs-body');
    card.appendChild(title);
    card.appendChild(body);
    const detail = typeof opts.detail === 'string' ? opts.detail.trim() : '';
    if (detail) {
      const area = el('div', 'cs-detail', detail);
      area.hidden = true;
      const tog = button('What Claude said', 'cs-btn-link', () => {
        area.hidden = !area.hidden;
        tog.setAttribute('aria-expanded', area.hidden ? 'false' : 'true');
      });
      tog.setAttribute('aria-expanded', 'false');
      card.appendChild(tog);
      card.appendChild(area);
    }
    parent.appendChild(card);
    loadInfo().then((info) => {
      const w = wordsOf(info);
      title.textContent = w.signedOut;
      clear(body);
      if (info && info.canSignIn === true) {
        const row = el('div', 'cs-actions');
        row.appendChild(button('Sign in again', 'cs-btn-main', () => openPanel({ onResend: opts.onResend })));
        body.appendChild(row);
        body.appendChild(el('div', 'cs-small', TEXT.terminal));
      } else if (info) {
        body.appendChild(el('div', null, askAdmin(info)));
      } else {
        body.appendChild(el('div', 'cs-small', TEXT.terminal));
      }
    });
    return card;
  }

  // ---- the panel ----
  function openPanel(opts) {
    if (typeof document === 'undefined' || current) return;
    opts = opts || {};
    const pollMs = opts.pollMs > 0 ? opts.pollMs : POLL_MS;
    ensureStyle();
    const opener = document.activeElement || null;
    const overlay = el('div', 'cs-overlay');
    const dlg = el('div', 'cs-dialog');
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-labelledby', 'cs-title');
    dlg.tabIndex = -1;
    const h = el('h2', null, 'Sign in to Claude again');
    h.id = 'cs-title';
    const body = el('div', 'cs-panel-body');
    dlg.appendChild(h);
    dlg.appendChild(body);
    overlay.appendChild(dlg);

    let words = Object.assign({}, TEXT);
    let attempt = null;
    let closed = false;
    let timer = null;
    let lastKey = null;
    let inline = null;       // a line shown under the input (format error and the like)
    let refused = null;      // text of a 403
    let inputEl = null;
    let sending = false;

    const stateOf = () => (attempt && attempt.state) || 'idle';
    const running = () => RUNNING.has(stateOf());

    function stopPolling() { if (timer) { clearTimeout(timer); timer = null; } }
    function schedule() {
      stopPolling();
      if (closed || !running()) return;
      timer = setTimeout(tick, pollMs);
    }
    async function tick() {
      timer = null;
      if (closed) return;
      const r = await call('GET', ENDPOINT);
      if (closed) return;
      if (r.status >= 200 && r.status < 300 && r.json.attempt) apply(r.json.attempt);
      schedule();
    }

    function close(opt) {
      if (closed) return;
      closed = true;
      stopPolling();
      const wasWaiting = stateOf() === 'starting' || stateOf() === 'link';
      document.removeEventListener('keydown', onKey, true);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      current = null;
      if (wasWaiting && !refused) call('POST', ENDPOINT + '/cancel', {});
      if (opener && typeof opener.focus === 'function') { try { opener.focus(); } catch { /* gone */ } }
    }
    function onKey(e) {
      if (e.key === 'Escape') { if (e.preventDefault) e.preventDefault(); if (e.stopPropagation) e.stopPropagation(); close(); return; }
      if (e.key === 'Tab' && dlg.querySelectorAll) {
        const f = Array.prototype.filter.call(dlg.querySelectorAll('button, a[href], input'), (n) => !n.disabled && !n.hidden);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !dlg.contains(active))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (active === last || !dlg.contains(active))) { e.preventDefault(); first.focus(); }
      }
    }

    function apply(a) {
      if (a && typeof a === 'object') {
        const was = stateOf();
        attempt = a;
        if (stateOf() !== was && stateOf() !== 'link') inline = null;
      }
      render();
    }

    async function start() {
      inline = null;
      attempt = { state: 'starting' };
      render();
      const r = await call('POST', ENDPOINT + '/start', {});
      if (closed) return;
      if (r.status === 403) { refused = r.json.error || TEXT.refused; render(); return; }
      if (r.json.attempt) attempt = r.json.attempt;
      else if (!(r.status >= 200 && r.status < 300)) { attempt = { state: 'failed', message: r.json.error || TEXT.unreachable }; }
      render();
      schedule();
    }

    async function submit() {
      if (!inputEl || sending) return;
      const code = String(inputEl.value || '').trim();
      if (!code) return;
      inputEl.value = '';
      sending = true;
      inline = null;
      const r = await call('POST', ENDPOINT + '/code', { code });
      sending = false;
      if (closed) return;
      if (r.status === 403) { refused = r.json.error || TEXT.refused; render(); return; }
      if (r.json.ok === false && r.json.reason === 'format') inline = TEXT.format;
      else if (r.json.ok === false && r.status !== 200 && !r.json.attempt) inline = TEXT.unreachable;
      if (r.json.attempt) attempt = r.json.attempt;
      lastKey = null;   // repaint even when the state is unchanged, to show the line
      render();
      schedule();
    }

    function copyLink(btn, link) {
      const done = () => { btn.textContent = 'Copied'; setTimeout(() => { if (!closed) btn.textContent = 'Copy link'; }, 1500); };
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(link).then(done, () => {});
          return;
        }
      } catch { /* fall through */ }
      try {
        const ta = el('textarea');
        ta.value = link;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        done();
      } catch { /* the link is also shown as a button */ }
    }

    function render() {
      if (closed) return;
      const st = stateOf();
      const key = refused ? 'refused:' + refused : st + '|' + (attempt && attempt.link || '') + '|' + (attempt && attempt.message || '') + '|' + (inline || '') + '|' + (opts.onResend ? 'r' : '');
      if (key === lastKey) return;
      lastKey = key;
      clear(body);
      inputEl = null;
      const actions = el('div', 'cs-actions');
      const closeBtn = button('Close', '', () => close());
      if (refused) {
        body.appendChild(el('p', 'cs-err', refused));
        actions.appendChild(closeBtn);
        body.appendChild(actions);
        return;
      }
      if (st === 'starting') {
        body.appendChild(el('p', null, 'Starting…'));
        actions.appendChild(closeBtn);
      } else if (st === 'link') {
        const link = attempt && typeof attempt.link === 'string' && attempt.link.indexOf('https://') === 0 ? attempt.link : '';
        body.appendChild(el('p', null, words.openLink));
        if (link) {
          const a = el('a', 'cs-btn cs-btn-main', 'Open the sign-in page');
          a.setAttribute('href', link);
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
          actions.appendChild(a);
          const cp = button('Copy link', '', () => copyLink(cp, link));
          actions.appendChild(cp);
          body.appendChild(actions);
        } else {
          body.appendChild(el('p', 'cs-err', TEXT.noLink));
        }
        body.appendChild(el('p', null, words.pasteCode));
        const inp = el('input', 'cs-input');
        inp.type = 'text';
        inp.setAttribute('type', 'text');
        inp.setAttribute('name', 'claude-code');
        inp.setAttribute('autocomplete', 'off');
        inp.setAttribute('autocapitalize', 'off');
        inp.setAttribute('autocorrect', 'off');
        inp.setAttribute('spellcheck', 'false');
        inp.setAttribute('aria-label', 'Code from the sign-in page');
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { if (e.preventDefault) e.preventDefault(); submit(); } });
        inputEl = inp;
        body.appendChild(inp);
        if (inline) body.appendChild(el('p', 'cs-err', inline));
        const row2 = el('div', 'cs-actions');
        row2.appendChild(button('Continue', 'cs-btn-main', submit));
        row2.appendChild(closeBtn);
        body.appendChild(row2);
        if (typeof inp.focus === 'function') { try { inp.focus(); } catch { /* not shown */ } }
        return;
      } else if (st === 'checking') {
        body.appendChild(el('p', null, words.checking));
        actions.appendChild(closeBtn);
      } else if (st === 'done') {
        body.appendChild(el('p', null, words.done));
        if (typeof opts.onResend === 'function') {
          actions.appendChild(button('Send my message again', 'cs-btn-main', () => { const f = opts.onResend; close(); try { f(); } catch { /* the page reports its own errors */ } }));
        }
        actions.appendChild(closeBtn);
      } else if (st === 'failed') {
        body.appendChild(el('p', 'cs-err', (attempt && attempt.message) || TEXT.unreachable));
        actions.appendChild(button('Start again', 'cs-btn-main', start));
        actions.appendChild(closeBtn);
      } else {   // cancelled, idle
        body.appendChild(el('p', null, 'The sign-in was stopped.'));
        actions.appendChild(button('Start again', 'cs-btn-main', start));
        actions.appendChild(closeBtn);
      }
      body.appendChild(actions);
    }

    current = close;
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    body.appendChild(el('p', null, 'Starting…'));
    if (typeof dlg.focus === 'function') { try { dlg.focus(); } catch { /* ignore */ } }

    (async () => {
      const info = await loadInfo(true);
      if (closed) return;
      words = wordsOf(info);
      if (!info) { attempt = { state: 'failed', message: TEXT.unreachable }; render(); return; }
      if (info.canSignIn !== true) { refused = askAdmin(info); render(); return; }
      if (info.attempt && RUNNING.has(info.attempt.state)) { attempt = info.attempt; render(); schedule(); return; }
      await start();
    })();
  }

  function healthButton(item) {
    if (!item || item.action !== 'claude-signin' || typeof document === 'undefined') return null;
    ensureStyle();
    return button('Sign in again', 'cs-btn-small cs-btn-main', () => openPanel({}));
  }

  function _reset() { infoCache = null; infoPending = null; if (current) current(); current = null; }

  return { notice, openPanel, healthButton, _reset };
});
