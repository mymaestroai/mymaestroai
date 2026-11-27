/**
 * ui-agent-card-access.js — the live rows of the agent card's Access section (admins only; members never see Access).
 *
 * Registers a rowDef (see lib/ui-agent-card.js) for the records that used to be doors to the agent page:
 *   - the six permission classes OPT-0008..OPT-0013 (web, read outside, write outside, send, admin, destroy) and the live
 *     summary OPT-0015, read from GET /api/policy/<name>; saved with PATCH {policy:{overrides, roots}} (the server REPLACES the
 *     whole policy, so overrides AND roots always go together, built from a fresh read of the agent);
 *   - folders: OPT-0017 (shared folders, checkboxes from GET /api/folders?agent=) and OPT-0018 (typed paths, one per line);
 *   - the box OPT-0053 (PATCH {sandbox}; the default word from GET /api/sandbox/status);
 *   - the command lockbox OPT-0054, kept variables OPT-0055 (PATCH {lockbox}, {lockboxEnv}) and recently blocked OPT-0056
 *     (GET /api/lockbox/watch). The server lets only an admin's own browser session use these; its message is shown as it is.
 * A change that LOOSENS a protection (a class towards allow, a folder added, outside a box, a looser lockbox) asks with the
 * window's confirm first (as the voice save in basics.js does); declining sends nothing and the row shows the old value again.
 * Any box change says it restarts the agent's current session.
 *
 * Load it after ui-agent-card-more.js: these rows replace its door rows for the same ids.
 * Text is set by the card with textContent. Node (tests): module.exports.
 */
(function (root, factory) {
  const card = (typeof module === 'object' && module && module.exports && typeof require === 'function') ? require('./ui-agent-card.js') : (root && root.hubAgentCard) || null;
  const api = factory(card);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.hubAgentCardAccess = api;
})(typeof window !== 'undefined' ? window : null, function (card) {
  'use strict';
  const TTL_MS = 5000;
  const enc = encodeURIComponent;

  // ── reading the hub's routes, kept for a few seconds per agent ───────────────────────────────────────────────
  const cache = new Map();   // "<agent>|<kind>" -> { data, error, status, raw, at, pending }
  const drafts = new Map();  // "<agent>|<id>" -> text typed in the folders box and not saved
  function resetCache(name) {
    for (const k of [...cache.keys()]) if (!name || k.startsWith(name + '|')) cache.delete(k);
    for (const k of [...drafts.keys()]) if (!name || k.startsWith(name + '|')) drafts.delete(k);
  }
  async function call(ctx, method, url) {
    if (!ctx || typeof ctx.fetch !== 'function') return { ok: false, error: 'This can not be done from here right now.' };
    try {
      const r = await card.request(ctx, url, { method, credentials: 'include' });   // bounded: headers and body
      const j = r.json;
      if (r && r.ok) return { ok: true, data: j, status: r.status };
      const raw = j && (j.error || j.message) ? String(j.error || j.message) : '';
      return { ok: false, status: r ? r.status : 0, raw, error: raw || 'Could not read that (' + (r && r.status ? r.status : 'no answer') + ').' };
    } catch (e) { return { ok: false, error: (e && e.message) || 'Could not read that.' }; }
  }
  const entryFor = (ctx, kind) => {
    const key = ctx.name + '|' + kind;
    let e = cache.get(key);
    if (!e) { e = { data: undefined, error: null, status: 0, raw: '', at: 0, pending: false }; cache.set(key, e); }
    return e;
  };
  const apply = (e, r) => {
    e.pending = false; e.at = Date.now();
    if (r.ok) { e.data = r.data; e.error = null; e.status = 200; e.raw = ''; } else { e.error = r.error; e.status = r.status || 0; e.raw = r.raw || ''; }
  };
  /** The kept answer for one kind of data (starts a read when there is none or it is old; redraws the card when it changes). */
  function need(ctx, kind, url) {
    const e = entryFor(ctx, kind);
    if (!e.pending && (!e.at || Date.now() - e.at > TTL_MS)) {
      e.pending = true;
      call(ctx, 'GET', url).then((r) => {
        const before = JSON.stringify([e.data, e.error]);
        apply(e, r);
        const again = ctx.refreshOpen || ctx.refresh;   // whichever card is open now
        if (before !== JSON.stringify([e.data, e.error]) && typeof again === 'function') { try { again(); } catch { /* the card is gone */ } }
      });
    }
    return e;
  }
  /** Read it again now (after a save, or before a save that builds on it) and keep the answer. */
  async function reread(ctx, kind, url) {
    const e = entryFor(ctx, kind);
    apply(e, await call(ctx, 'GET', url));
    return e;
  }
  const ready = (e) => e.data !== undefined && e.data !== null;
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
  const listOf = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
  const nameOf = (agent, ctx) => String((agent && agent.display) || (ctx && ctx.name) || (agent && agent.name) || 'this agent');
  const overridesOf = (a) => (a && a.policy && a.policy.overrides && typeof a.policy.overrides === 'object' ? a.policy.overrides : {});
  const rootsOf = (a) => listOf(a && a.policy && a.policy.roots);
  /** The window's confirm (as the voice save does): no confirm available or "no" = nothing is changed. */
  const ask = (ctx, text) => { const w = ctx && ctx.win; return !!(w && typeof w.confirm === 'function' && w.confirm(text)); };
  const NOT_READ = 'The card could not read this agent just now, so nothing was changed. Try again.';
  const DECLINED = () => ({ ok: true, declined: true });   // a confirm answered no: nothing was sent; the card says "Not changed."
  const asStored = (a) => (a && a.policy && typeof a.policy === 'object' ? a.policy : {});
  /** Every policy write: sends the policy of the agent read it was built from (policyIfMatch). The hub answers 409 when someone else
   *  changed it meanwhile; the card then reads the policy, the folders and the agent again and shows the hub's message. */
  async function writePolicy(ctx, cur, policy) {
    const r = await ctx.patch({ policy, policyIfMatch: asStored(cur) });
    if (r && r.ok === false && r.status === 409) {
      await reread(ctx, 'policy', policyUrl(ctx)); await reread(ctx, 'folders', foldersUrl(ctx));
      if (typeof ctx.refresh === 'function') { try { await ctx.refresh(); } catch { /* the card is gone */ } }
    }
    return r;
  }

  const policyUrl = (ctx) => '/api/policy/' + enc(ctx.name);
  const policyOf = (ctx) => need(ctx, 'policy', policyUrl(ctx));

  // ── the six permission classes ───────────────────────────────────────────────────────────────────────────────
  const CLASSES = { 'OPT-0008': 'web', 'OPT-0009': 'read_outside', 'OPT-0010': 'write_outside', 'OPT-0011': 'send', 'OPT-0012': 'admin', 'OPT-0013': 'destroy' };
  const ORDER = ['web', 'read_outside', 'write_outside', 'send', 'admin', 'destroy'];
  // A member's agent can be given only these; the rest stay refused whatever is set (as on the agent page).
  const MEMBER_GRANTABLE = ['web', 'read_outside', 'write_outside', 'send'];
  // Mirror of ROLE_DEFAULTS in lib/tool-policy.js (the agent page keeps the same copy), for the "Role default" word.
  const ROLE_DEFAULTS = {
    worker: { web: 'allow', read_outside: 'allow', write_outside: 'deny', send: 'deny', admin: 'deny', destroy: 'deny' },
    head: { web: 'allow', read_outside: 'allow', write_outside: 'ask', send: 'ask', admin: 'ask', destroy: 'deny' },
    lead: { web: 'allow', read_outside: 'allow', write_outside: 'ask', send: 'ask', admin: 'ask', destroy: 'ask' },
    wallet: { web: 'allow', read_outside: 'allow', write_outside: 'deny', send: 'deny', admin: 'deny', destroy: 'deny' },
    member: { web: 'deny', read_outside: 'deny', write_outside: 'deny', send: 'deny', admin: 'deny', destroy: 'deny' },
  };
  const CHOICE = { allow: 'Allow', ask: 'Ask first', deny: 'Never' };
  const SHORT = { allow: 'allow', ask: 'ask first', deny: 'never' };
  const NOW = { allow: 'Allowed', ask: 'Asks you first', deny: 'Never' };
  const SOURCES = { role: 'its role', hub: 'the hub\'s member default', member: 'the member\'s own grant', agent: 'this agent\'s own setting' };
  const RANK = { deny: 0, ask: 1, allow: 2 };
  const DOES = {
    web: 'search the web', read_outside: 'read files outside its own folder', write_outside: 'change files outside its own folder',
    send: 'send things off this computer', admin: 'change Maestro\'s data or other agents', destroy: 'delete files, stop programs or undo work for good',
  };
  const SHORT_NAME = { web: 'Web', read_outside: 'Reading outside', write_outside: 'Writing outside', send: 'Sending', admin: 'Changing Maestro', destroy: 'Destroying' };
  const roleDefault = (p, cls) => ((p && ROLE_DEFAULTS[p.role]) || ROLE_DEFAULTS.worker)[cls];
  const memberOwned = (ctx) => { const e = policyOf(ctx); return ready(e) && e.data.role === 'member'; };
  const policyNow = (agent, ctx, cls) => {   // the stored override of one class: the policy route's own copy once read, else the agent's
    const e = policyOf(ctx);
    const ov = ready(e) && e.data.overrides && typeof e.data.overrides === 'object' ? e.data.overrides : overridesOf(agent);
    return Object.prototype.hasOwnProperty.call(CHOICE, ov[cls]) ? ov[cls] : '';
  };
  function classRow(cls) {
    return {
      get: (agent, ctx) => { const v = policyNow(agent, ctx, cls); return { value: v, display: v ? CHOICE[v] : 'Role default' }; },
      control: { type: 'select', options: (agent, ctx) => {
        const e = ctx && ctx.name ? policyOf(ctx) : null;
        const d = e && ready(e) ? roleDefault(e.data, cls) : null;
        return [{ value: '', label: 'Role default' + (d ? ' (' + SHORT[d] + ')' : '') }, { value: 'allow', label: CHOICE.allow }, { value: 'ask', label: CHOICE.ask }, { value: 'deny', label: CHOICE.deny }];
      } },
      desc: (agent, ctx) => {
        const e = policyOf(ctx);
        if (!ready(e)) return e.error ? 'Not available' : 'Checking…';
        const eff = e.data.rules && e.data.rules[cls];
        if (!eff) return '';
        const src = e.data.source && e.data.source[cls];
        return 'Right now: ' + (NOW[eff] || eff) + (src && SOURCES[src] ? ', from ' + SOURCES[src] : '') + '.';
      },
      live: (agent, ctx) => ready(policyOf(ctx)) && !(memberOwned(ctx) && !MEMBER_GRANTABLE.includes(cls)),   // not before the policy was read
      whyNot: (agent, ctx) => {
        const e = policyOf(ctx);
        if (!ready(e)) return e.error ? 'Could not read the permissions: ' + e.error : 'Checking…';
        return 'A member\'s agent can never be given this; it stays refused whatever is set.';
      },
      save: async (agent, value, ctx) => {
        const v = String(value == null ? '' : value);
        if (v !== '' && !Object.prototype.hasOwnProperty.call(CHOICE, v)) return { ok: false, error: 'Pick Role default, Allow, Ask first or Never.' };
        const cur = await ctx.fresh();   // the server replaces the whole policy: build it from what the hub has now
        if (!cur) return { ok: false, error: NOT_READ };
        const ov = Object.assign({}, overridesOf(cur));
        const before = Object.prototype.hasOwnProperty.call(CHOICE, ov[cls]) ? ov[cls] : '';
        if (before === v) return { ok: true };
        if (v) ov[cls] = v; else delete ov[cls];
        const e = policyOf(ctx);
        const p = ready(e) ? e.data : null;
        const was = (p && p.rules && p.rules[cls]) || before || roleDefault(p, cls);
        const n = nameOf(cur, ctx);
        if (v === '') {
          // Clearing an override hands the choice to what is inherited (role, hub default, member grant): ask unless it is allowed now anyway.
          const now = p && p.rules && p.rules[cls];
          if (now !== 'allow' && !ask(ctx, 'Stop using this agent\'s own setting and use the inherited one? It may let ' + n + ' ' + DOES[cls] + '.')) return DECLINED();
        } else if (RANK[v] > RANK[was]) {
          const text = v === 'allow' ? 'Let ' + n + ' ' + DOES[cls] + ' without asking?' : 'Let ' + n + ' ' + DOES[cls] + ', asking you first each time?';
          if (!ask(ctx, text)) return DECLINED();
        }
        const r = await writePolicy(ctx, cur, { overrides: ov, roots: rootsOf(cur) });   // overrides AND roots, always together
        if (r && r.ok) await reread(ctx, 'policy', policyUrl(ctx));
        return r;
      },
    };
  }
  const summaryLine = (ctx) => {
    const e = policyOf(ctx);
    if (!ready(e)) return e.error ? 'Not available' : 'Checking…';
    const rules = e.data.rules || {};
    return ORDER.filter((c) => rules[c]).map((c) => SHORT_NAME[c] + ': ' + (NOW[rules[c]] || rules[c]).toLowerCase()).join(' · ');
  };

  // ── folders ──────────────────────────────────────────────────────────────────────────────────────────────────
  const FOLDER_GROUPS = [['common', 'Common'], ['files', 'Files folders'], ['team', 'Team folders'], ['workspace', 'Workspaces']];
  const foldersUrl = (ctx) => '/api/folders?agent=' + enc(ctx.name);
  const foldersOf = (ctx) => need(ctx, 'folders', foldersUrl(ctx));
  const MAX_PATH = 400;
  /** Split an agent's roots into the ones a checkbox shows (by resolved path) and the typed ones. data = the folders route's answer (or null). */
  function partition(roots, data) {
    const shown = new Set(data && Array.isArray(data.folders) ? data.folders.map((f) => f.path) : []);
    const granted = data && Array.isArray(data.granted) ? data.granted : [];
    const aligned = granted.length === roots.length;   // the route resolves every root in order; a stale pair is compared as typed
    const checked = [], typed = [], checkedRaw = [];
    roots.forEach((r, i) => {
      const resolved = aligned ? granted[i] : r;
      if (shown.has(resolved)) { checked.push(resolved); checkedRaw.push(r); } else typed.push(r);
    });
    return { shown, checked, checkedRaw, typed };
  }
  const foldersLive = (ctx) => { const e = foldersOf(ctx); return ready(e); };
  const foldersWhy = (ctx) => { const e = foldersOf(ctx); return e.error ? 'Could not load the folder list: ' + e.error : 'Checking…'; };
  const labelOf = (data, path) => { const f = data && Array.isArray(data.folders) ? data.folders.find((x) => x.path === path) : null; return f && f.label ? f.label : path; };
  async function foldersAndAgent(ctx) {
    const cur = await ctx.fresh();
    if (!cur) return { error: NOT_READ };
    const f = await reread(ctx, 'folders', foldersUrl(ctx));
    if (!ready(f) || f.error) return { error: 'Could not read the folder list just now, so nothing was changed. Try again.' };
    return { cur, data: f.data };
  }
  const writeRoots = async (ctx, cur, roots) => {
    const r = await writePolicy(ctx, cur, { overrides: overridesOf(cur), roots: [...new Set(roots)] });   // roots AND overrides together
    if (r && r.ok) { await reread(ctx, 'policy', policyUrl(ctx)); await reread(ctx, 'folders', foldersUrl(ctx)); }
    return r;
  };
  const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

  // ── the box and the command lockbox ──────────────────────────────────────────────────────────────────────────
  const sandboxOf = (ctx) => need(ctx, 'sandbox', '/api/sandbox/status');
  const BOX_WORD = { container: 'in a box', off: 'outside a box' };
  /** What "Same as the default" means for this agent now: 'container', 'off', or null when not known yet. */
  function defaultBox(ctx) {
    const e = sandboxOf(ctx);
    const d = ready(e) && e.data.defaults && typeof e.data.defaults === 'object' ? e.data.defaults : null;
    if (!d) return null;
    const v = memberOwned(ctx) ? d.member : d.admin;
    return v === 'container' || v === 'off' ? v : null;
  }
  const boxNow = (agent, ctx) => { const s = String((agent && agent.sandbox) || 'inherit'); return s === 'container' || s === 'off' ? s : defaultBox(ctx); };

  const lockStatus = (ctx) => need(ctx, 'lockstatus', '/api/lockbox/status');
  const SIGN_IN = 'Sign in with an admin account in your browser to see or change the command lockbox.';
  /** Why the lockbox rows can not be used (the server's own words when it gave some), '' when they can. */
  function lockWhy(e) {
    if (ready(e)) return '';
    if (!e.at) return 'Checking…';
    if (e.status === 403) return e.raw && e.raw !== 'admin_only' ? e.raw : SIGN_IN;
    return e.error || 'Not available';
  }
  const LB_WORD = { off: 'Off', watch: 'Watch', enforce: 'Enforce' };
  const LB_RANK = { off: 0, watch: 1, enforce: 2 };
  const LB_EFFECT = {
    off: 'Commands run as they do today.',
    watch: 'Commands run as today; anything the lockbox would have blocked is listed below.',
    enforce: 'Commands can write only in this agent\'s folders, can\'t read secret files, and can\'t use docker, systemd or other local services. Git over SSH and signed commits fail inside it.',
  };
  const LB_LEAD = 'The lead needs sudo for crontab, systemctl --user and docker.';
  const LB_RULES = { 'write-outside': 'write outside its folders', 'secret-read': 'read a secret file', 'unix-socket': 'local socket', io_uring: 'io_uring', 'sudo-unconfined': 'ran with sudo, outside the box', 'watch-unavailable': 'watch not possible' };
  const lbEffective = (setting, hubDefault) => (setting === 'inherit' ? (Object.prototype.hasOwnProperty.call(LB_RANK, hubDefault) ? hubDefault : 'off') : setting);   // an unknown default counts as off
  /** The line under the select (the same words as the agent page). */
  function lbLine(mode, coverage, host, lead) {
    if (coverage === 'container') return 'This agent\'s commands already run in its own container.';
    if (coverage === 'codex-client') return 'This agent uses Codex\'s own tools, which the lockbox can\'t box; switch it to the hub\'s hands.';
    if (coverage === 'unavailable') return 'Not available on this computer: ' + String((host && host.reason) || 'unknown reason').replace(/[.\s]+$/, '') + '.';
    const base = LB_EFFECT[mode] || LB_EFFECT.off;
    return mode === 'enforce' && lead ? base + ' ' + LB_LEAD : base;
  }
  const lbWhen = (iso) => { const d = new Date(iso); return isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  const blockedOf = (ctx) => need(ctx, 'blocked', '/api/lockbox/watch?agent=' + enc(ctx.name) + '&limit=10');

  // ── the rows ─────────────────────────────────────────────────────────────────────────────────────────────────
  const ROWS = {};
  for (const [id, cls] of Object.entries(CLASSES)) ROWS[id] = classRow(cls);
  Object.assign(ROWS, {
    'OPT-0015': {   // read-only: what will really happen, from the policy route
      get: (agent, ctx) => { const s = summaryLine(ctx); return { value: s, display: s }; },
      control: { type: 'readonly' },
    },

    'OPT-0017': {   // shared folders: one checkbox per folder the hub lists
      get: (agent, ctx) => {
        const e = foldersOf(ctx);
        if (!ready(e)) return { value: [], display: e.error ? 'Not available' : 'Checking…' };
        const part = partition(rootsOf(agent), e.data);
        return { value: part.checked, display: part.checked.length ? plural(part.checked.length, 'folder') : 'None' };
      },
      control: {
        type: 'custom',
        build: ({ mk, ctx, got, label, send: go }) => {
          const e = foldersOf(ctx);
          const wrap = mk('div', 'ac-folders'); wrap.setAttribute('role', 'group'); wrap.setAttribute('aria-label', label);
          const list = ready(e) && Array.isArray(e.data.folders) ? e.data.folders : [];
          const on = new Set(Array.isArray(got.value) ? got.value : []);
          const boxes = [];
          for (const [kind, title] of FOLDER_GROUPS) {
            const items = list.filter((f) => f.kind === kind);
            if (!items.length) continue;
            const g = mk('div', 'ac-folder-group');
            g.appendChild(mk('div', 'ac-folder-title', title));
            for (const f of items) {
              const lab = mk('label', 'ac-folder'); lab.setAttribute('title', String(f.path));
              const cb = mk('input', ''); cb.setAttribute('type', 'checkbox'); cb.setAttribute('value', String(f.path)); cb.checked = on.has(f.path);
              cb.addEventListener('change', () => go(boxes.filter((b) => b.checked).map((b) => b.getAttribute('value'))));
              boxes.push(cb); lab.appendChild(cb); lab.appendChild(mk('span', '', f.label || f.path)); g.appendChild(lab);
            }
            wrap.appendChild(g);
          }
          if (!boxes.length) wrap.appendChild(mk('span', 'ac-value', 'No shared folders on this hub yet.'));
          return wrap;
        },
      },
      live: (agent, ctx) => foldersLive(ctx),
      whyNot: (agent, ctx) => foldersWhy(ctx),
      save: async (agent, value, ctx) => {
        const got = await foldersAndAgent(ctx);
        if (got.error) return { ok: false, error: got.error };
        const part = partition(rootsOf(got.cur), got.data);
        const picks = [...new Set(listOf(value).filter((p) => part.shown.has(p)))];
        if (sameSet(picks, part.checked)) return { ok: true };
        const added = picks.filter((p) => !part.checked.includes(p));
        if (added.length && !ask(ctx, 'Give ' + nameOf(got.cur, ctx) + ' write access to ' + added.map((p) => labelOf(got.data, p)).join(', ') + '?')) return DECLINED();
        return writeRoots(ctx, got.cur, part.typed.concat(picks));
      },
      summary: (agent) => { const n = rootsOf(agent).length; return n ? plural(n, 'folder') : ''; },
    },
    'OPT-0018': {   // other folders: typed paths, one per line (a multi-line box that saves when it loses the focus)
      get: (agent, ctx) => {
        const e = foldersOf(ctx);
        const part = partition(rootsOf(agent), ready(e) ? e.data : null);   // folders not loaded: every root counts as typed, as on the agent page
        return { value: part.typed, display: part.typed.length ? part.typed.join(', ') : 'None' };
      },
      control: {
        type: 'custom',
        build: ({ doc, mk, ctx, got, label, send: go }) => {
          const key = ctx.name + '|OPT-0018';
          const base = (Array.isArray(got.value) ? got.value : []).join('\n');
          const ta = mk('textarea', 'ac-input ac-area');
          ta.setAttribute('rows', '3'); ta.setAttribute('aria-label', label); ta.setAttribute('spellcheck', 'false'); ta.setAttribute('autocomplete', 'off');
          ta.setAttribute('placeholder', '/path/to/folder (one per line, ~ is allowed)');
          ta.value = drafts.has(key) ? drafts.get(key) : base;   // text typed and not saved stays across a redraw
          let sent = base;
          ta.addEventListener('input', () => { if (ta.value === base) drafts.delete(key); else drafts.set(key, ta.value); });
          const fire = () => {
            const text = ta.value;
            if (text === sent) return false;
            sent = text; drafts.delete(key);
            return go(text.split('\n'));
          };
          ta.addEventListener('change', fire); ta.addEventListener('blur', fire);
          return ta;
        },
      },
      live: (agent, ctx) => { const e = foldersOf(ctx); return ready(e) || !!e.error; },
      whyNot: () => 'Checking…',
      save: async (agent, value, ctx) => {
        const lines = [...new Set((Array.isArray(value) ? value : String(value || '').split('\n')).map((s) => String(s).trim()).filter(Boolean))];
        const key = ctx.name + '|OPT-0018';
        if (lines.some((l) => l.length >= MAX_PATH)) { drafts.set(key, lines.join('\n')); return { ok: false, error: 'Each path must be shorter than ' + MAX_PATH + ' characters.' }; }
        const cur = await ctx.fresh();
        if (!cur) { drafts.set(key, lines.join('\n')); return { ok: false, error: NOT_READ }; }
        const f = await reread(ctx, 'folders', foldersUrl(ctx));
        // Without the folder list the checked folders can't be told from typed paths: saving would drop them, so nothing is saved and the draft stays.
        if (!ready(f) || f.error) { drafts.set(key, lines.join('\n')); return { ok: false, error: 'Could not read the folder list just now, so nothing was changed. Try again.' }; }
        const part = partition(rootsOf(cur), f.data);
        if (sameSet(lines, part.typed)) return { ok: true };
        const added = lines.filter((l) => !part.typed.includes(l));
        if (added.length && !ask(ctx, 'Give ' + nameOf(cur, ctx) + ' write access to ' + added.join(', ') + '?')) { drafts.set(key, lines.join('\n')); return DECLINED(); }   // the typed text stays
        const r = await writeRoots(ctx, cur, part.checkedRaw.concat(lines));
        if (!r || r.ok === false) drafts.set(key, lines.join('\n'));   // a refused save keeps what was typed, with the error
        return r;
      },
    },

    'OPT-0053': {   // the box: PATCH {sandbox}; every change restarts the agent's session, so it always asks
      get: (agent) => { const v = String(agent.sandbox || 'inherit'); return { value: v, display: v === 'container' ? 'In a box' : (v === 'off' ? 'Outside a box' : 'Same as the default') }; },
      control: { type: 'select', options: (agent, ctx) => {
        const d = ctx && ctx.name ? defaultBox(ctx) : null;
        return [{ value: 'inherit', label: 'Same as the default' + (d ? ' (' + BOX_WORD[d] + ')' : '') }, { value: 'container', label: 'In a box' }, { value: 'off', label: 'Outside a box' }];
      } },
      desc: (agent, ctx) => {
        const now = boxNow(agent, ctx);
        const e = sandboxOf(ctx);
        const err = ready(e) && e.data.error && now === 'container' ? ' ' + String(e.data.error) : '';
        return (now ? 'It runs ' + BOX_WORD[now] + ' now.' : (e.error ? '' : 'Checking…')) + err;
      },
      save: async (agent, value, ctx) => {
        const v = String(value || '');
        if (!['inherit', 'container', 'off'].includes(v)) return { ok: false, error: 'Pick the default, In a box or Outside a box.' };
        if (v === String(agent.sandbox || 'inherit')) return { ok: true };
        const n = nameOf(agent, ctx);
        const was = boxNow(agent, ctx);
        const will = v === 'inherit' ? defaultBox(ctx) : v;
        const looser = was === 'container' && will === 'off';
        const head = v === 'container' ? 'Keep ' + n + ' in a box?' : (v === 'off' ? 'Run ' + n + ' outside a box?' : 'Make ' + n + ' follow the default box setting?');
        let text = head + (looser ? ' Its commands and file work would then run directly on this computer.' : '') + ' This restarts ' + n + '\'s current session.';
        if (was === 'off' && will === 'container') text += ' ' + n + ' runs outside a box now; boxing it restarts its session.';
        if (!ask(ctx, text)) return DECLINED();
        const r = await ctx.patch({ sandbox: v });
        if (r && r.ok) await reread(ctx, 'lockstatus', '/api/lockbox/status');   // the lockbox row says whether the box already covers it
        return r;
      },
      summary: (agent) => (agent.sandbox === 'container' ? 'kept in its own box' : ''),
    },

    'OPT-0054': {   // the command lockbox: PATCH {lockbox} (an admin's own browser session only; the server's refusal is shown as it is)
      get: (agent) => { const v = String(agent.lockbox || 'inherit'); return { value: v, display: v === 'inherit' ? 'Same as the default' : (LB_WORD[v] || v) }; },
      control: { type: 'select', options: (agent, ctx) => {
        const e = ctx && ctx.name ? lockStatus(ctx) : null;
        const d = e && ready(e) ? String(e.data.default || 'off') : '';
        return [{ value: 'inherit', label: 'Same as the default' + (d ? ' (' + (LB_WORD[d] || d).toLowerCase() + ')' : '') }, { value: 'off', label: 'Off' }, { value: 'watch', label: 'Watch (report only)' }, { value: 'enforce', label: 'Enforce (block)' }];
      } },
      desc: (agent, ctx) => {
        const e = lockStatus(ctx);
        if (!ready(e)) return '';
        const mode = lbEffective(String(agent.lockbox || 'inherit'), e.data.default);
        const row = (e.data.agents || []).find((a) => a && a.name === ctx.name) || {};
        return lbLine(mode, row.coverage || 'covered', e.data.host, agent.lead === true);
      },
      live: (agent, ctx) => ready(lockStatus(ctx)),
      whyNot: (agent, ctx) => lockWhy(lockStatus(ctx)),
      save: async (agent, value, ctx) => {
        const v = String(value || '');
        if (!['inherit', 'off', 'watch', 'enforce'].includes(v)) return { ok: false, error: 'Pick the default, Off, Watch or Enforce.' };
        if (v === String(agent.lockbox || 'inherit')) return { ok: true };
        const e = lockStatus(ctx);
        const hub = ready(e) ? e.data.default : 'off';
        const was = lbEffective(String(agent.lockbox || 'inherit'), hub);
        const will = lbEffective(v, hub);
        if ((LB_RANK[will] || 0) < (LB_RANK[was] || 0)) {
          const n = nameOf(agent, ctx);
          const text = will === 'off' ? 'Turn the command lockbox off for ' + n + '? Its commands would then run with nothing limiting what they can touch.'
            : 'Let ' + n + '\'s commands through, with the lockbox only reporting what it would block?';
          if (!ask(ctx, text)) return DECLINED();
        }
        const r = await ctx.patch({ lockbox: v });   // a refusal (403) carries the server's own message
        await reread(ctx, 'lockstatus', '/api/lockbox/status');
        return r;
      },
      summary: (agent) => (agent.lockbox === 'watch' ? 'commands watched' : (agent.lockbox === 'enforce' ? 'commands blocked' : '')),
    },
    'OPT-0055': {   // kept variables: PATCH {lockboxEnv:[names]}
      get: (agent) => { const l = listOf(agent.lockboxEnv); return { value: l, display: l.join(', ') || 'None' }; },
      control: { type: 'list' },
      desc: 'Names, separated by commas. Inside the lockbox this agent\'s commands see only a short list of ordinary variables (PATH, HOME, LANG and the like) plus these.',
      live: (agent, ctx) => ready(lockStatus(ctx)),
      whyNot: (agent, ctx) => lockWhy(lockStatus(ctx)),
      save: async (agent, value, ctx) => {
        const names = listOf(value);
        const kept = listOf(agent.lockboxEnv);
        const added = names.filter((x) => !kept.includes(x));
        // Kept variables are visible to the agent's commands inside the lockbox: adding any asks first, naming them.
        if (added.length && !ask(ctx, 'Let ' + nameOf(agent, ctx) + '\'s commands see ' + (added.length === 1 ? 'this variable' : 'these variables') + ' inside the lockbox: ' + added.join(', ') + '?')) return DECLINED();
        const r = await ctx.patch({ lockboxEnv: names });
        await reread(ctx, 'lockstatus', '/api/lockbox/status');
        return r;
      },
    },
    'OPT-0056': {   // read-only list of the last blocked (or would-be-blocked) commands
      get: (agent, ctx) => {
        const e = blockedOf(ctx);
        if (!ready(e)) return { value: null, display: e.error ? (e.status === 403 ? lockWhy(e) : e.error) : 'Checking…' };
        const list = Array.isArray(e.data.entries) ? e.data.entries.slice(0, 10) : [];
        return { value: list, display: list.length ? plural(list.length, 'line') : 'Nothing blocked recently' };
      },
      control: {
        type: 'custom',
        build: ({ mk, got }) => {
          const box = mk('div', 'ac-blocked');
          if (!Array.isArray(got.value)) { box.appendChild(mk('span', 'ac-value', got.display)); return box; }
          if (!got.value.length) { box.appendChild(mk('span', 'ac-value', 'Nothing blocked recently')); return box; }
          for (const x of got.value) {
            const item = mk('div', 'ac-blocked-item');
            const t = lbWhen(x && x.ts);
            const rule = x && Object.prototype.hasOwnProperty.call(LB_RULES, x.rule) ? LB_RULES[x.rule] : String((x && x.rule) || '');
            item.appendChild(mk('div', 'ac-blocked-when', (t ? t + ' · ' : '') + rule));
            if (x && x.path) item.appendChild(mk('div', 'ac-blocked-what', String(x.path)));
            if (x && x.cmd) item.appendChild(mk('div', 'ac-blocked-what', String(x.cmd).slice(0, 80)));
            box.appendChild(item);
          }
          return box;
        },
      },
      save: async () => ({ ok: true }),   // nothing to change: the custom control is only a list
    },
  });

  function install() {
    if (!card) return false;
    card.registerMany(ROWS);
    return true;
  }
  install();

  return { ROWS, CLASSES, ROLE_DEFAULTS, MEMBER_GRANTABLE, partition, resetCache, install };
});
