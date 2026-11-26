/**
 * ui-agent-card-more.js — the rows of the agent card's Memory, Access and Schedule and background work sections.
 *
 * Registers a rowDef (see lib/ui-agent-card.js) for every record homed on those three sections that has a control today, and
 * sets the rows shown first in each section (FIRST_ROWS: memory, access, schedule). Every save goes through the route the
 * agent page uses, so the server's own checks and the settings journal apply:
 *   - PATCH /api/agents/<name> (through ctx.patch) for tools, tool lists, working memory, limits, compaction threshold, notes
 *     of what to keep, "no tools", the commands' settings;
 *   - POST /api/agents/<name>/compaction/run (Compress now); POST and DELETE /api/root-grants (administrator access).
 * A record the phase-2 rule marks dangerous (a policy class, folders, the box, the command lockbox and its settings) is never
 * changed on the card: its row says what it is now and "Change it on the agent page", with a button to that record's door.
 * Data the agent record does not carry (records, memory fullness, root grant, blocked commands, scheduled tasks, background
 * work) is read once per agent, kept for a few seconds, and the card is redrawn when it arrives.
 *
 * Text is set by the card with textContent. Node (tests): module.exports.
 */
(function (root, factory) {
  const card = (typeof module === 'object' && module && module.exports && typeof require === 'function') ? require('./ui-agent-card.js') : (root && root.hubAgentCard) || null;
  const api = factory(card);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.hubAgentCardMore = api;
})(typeof window !== 'undefined' ? window : null, function (card) {
  'use strict';
  const TTL_MS = 5000;
  const SCREEN = 'the agent page';
  const enc = encodeURIComponent;
  const doorUrl = (name, id) => '/agent-settings.html?agent=' + enc(name) + '#rec=' + enc(id);

  // ── reading the hub's other routes, kept for a few seconds per agent ─────────────────────────────────────────
  const cache = new Map();   // "<agent>|<kind>" -> { data, error, status, at, pending }
  function resetCache(name) { for (const k of [...cache.keys()]) if (!name || k.startsWith(name + '|')) cache.delete(k); }
  const plainError = (j, status) => {
    const e = j && (j.error || j.message);
    if (e === 'admin_only') return 'Only an admin can change this.';
    if (e && j.detail && typeof j.detail === 'string') return String(e) + ': ' + j.detail;
    return e ? String(e) : 'Could not do that (' + (status || 'no answer') + ').';
  };
  async function call(ctx, method, url, body) {
    if (!ctx || typeof ctx.fetch !== 'function') return { ok: false, error: 'This can not be done from here right now.' };
    try {
      const init = { method, credentials: 'include' };
      if (body !== undefined) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body); }
      const r = await card.request(ctx, url, init);   // bounded: headers and body
      const j = r.json;
      if (r && r.ok) return { ok: true, data: j, status: r.status };
      return { ok: false, status: r ? r.status : 0, error: plainError(j, r ? r.status : 0) };
    } catch (e) { return { ok: false, error: (e && e.message) || 'Could not do that.' }; }
  }
  /** The kept answer for one kind of data (starts a read when there is none or it is old; redraws the card when it changes). */
  function need(ctx, kind, url) {
    const key = ctx.name + '|' + kind;
    let e = cache.get(key);
    if (!e) { e = { data: undefined, error: null, status: 0, at: 0, pending: false }; cache.set(key, e); }
    if (!e.pending && (!e.at || Date.now() - e.at > TTL_MS)) {
      e.pending = true;
      call(ctx, 'GET', url).then((r) => {
        e.pending = false; e.at = Date.now();
        const before = JSON.stringify([e.data, e.error]);
        if (r.ok) { e.data = r.data; e.error = null; e.status = 200; } else { e.error = r.error; e.status = r.status || 0; }
        const again = ctx.refreshOpen || ctx.refresh;   // whichever card is open now, not only the one that started the read
        if (before !== JSON.stringify([e.data, e.error]) && typeof again === 'function') { try { again(); } catch { /* the card is gone */ } }
      });
    }
    return e;
  }
  const ready = (e) => e.data !== undefined && e.data !== null;
  const nf = (n) => Number(n).toLocaleString('en-US');
  const when = (iso) => { const d = new Date(iso); return isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }); };
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));

  /** Open the agent page at a record (a new tab). */
  function openDoor(ctx, id) {
    const w = ctx && ctx.win;
    const url = doorUrl(ctx.name, id);
    try {
      if (w && typeof w.open === 'function') { w.open(url, '_blank', 'noopener'); return { ok: true }; }
      if (w && w.location) { w.location.href = url; return { ok: true }; }
    } catch { /* below */ }
    return { ok: false, error: 'Open the agent page for ' + ctx.name + ' to change this.' };
  }
  /** Open the desktop task scheduler (scheduled tasks and background jobs of every agent). */
  function openScheduler(ctx) {
    const w = ctx && ctx.win;
    try {
      if (w && typeof w.openSchedulePanel === 'function') { w.openSchedulePanel(); return { ok: true }; }
      const b = w && w.document && typeof w.document.getElementById === 'function' ? w.document.getElementById('schedule-btn') : null;
      if (b && typeof b.click === 'function') { b.click(); return { ok: true }; }
    } catch { /* below */ }
    return { ok: false, error: 'The task scheduler is on the desktop page (the calendar button at the top).' };
  }

  // ── row factories ───────────────────────────────────────────────────────────────────────────────────────────
  const clientModel = (a) => /^(claude-sdk|codex-cli)\//.test(String((a && a.model) || ''));
  /** Only the half this row owns is sent; the server merges it into the stored {mode, at}, and null removes that half. */
  const dropAt = (agent, ctx) => ctx.patch({ compaction: { at: null } });
  function numberRow(field, o) {
    const bad = (n) => !Number.isFinite(n) || n < o.min || n > o.max || (o.whole !== false && !Number.isInteger(n));
    return {
      get: (agent) => { const v = agent[field]; const has = v != null && v !== ''; return { value: has ? v : '', display: has ? nf(v) : '', isDefault: !has }; },
      control: { type: 'number', min: o.min, max: o.max, step: o.step },
      save: async (agent, value, ctx) => {
        const n = Number(value);
        if (bad(n)) return { ok: false, error: o.hint };
        return ctx.patch({ [field]: n });
      },
      resetDefault: (agent, ctx) => ctx.patch({ [field]: null }),
      summary: o.summary,
    };
  }
  /** A record changed only on the agent page: what it is now, the line "Change it on the agent page", and a button to its door. */
  function doorRow(id, o) {
    return {
      desc: (agent, ctx) => { const v = o.show ? o.show(agent, ctx) : ''; return (v ? v + ' · ' : '') + 'Change it on ' + SCREEN + '.'; },
      get: () => ({ value: '', display: 'Open ' + SCREEN }),
      control: { type: 'action' },
      save: async (agent, v, ctx) => openDoor(ctx, id),
      summary: o.summary,
    };
  }
  const listOf = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
  const readonly = (show, extra) => Object.assign({ get: (agent, ctx) => { const s = show(agent, ctx); return { value: s, display: s }; }, control: { type: 'readonly' } }, extra || {});

  // ── Memory ──────────────────────────────────────────────────────────────────────────────────────────────────
  const AT_OPTIONS = [{ value: '', label: 'Same as all agents' }].concat([0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9].map((n) => ({ value: String(n), label: Math.round(n * 100) + '%' })));
  const recordsOf = (ctx) => need(ctx, 'records', '/api/agents/' + enc(ctx.name) + '/records');
  const memoryNow = (ctx) => need(ctx, 'compaction', '/api/agents/' + enc(ctx.name) + '/compaction');
  const fullness = (ctx, words) => {
    const e = memoryNow(ctx);
    if (!ready(e)) return e.error ? 'Not available' : 'Checking…';
    const d = e.data; const pct = Math.round(Number(d.pct) || 0);
    return Number(d.limit) ? words(pct, d) : 'No session yet';
  };
  const NOTE_FILES = [['OPT-0068', 'Personality notes'], ['OPT-0069', 'Identity notes'], ['OPT-0070', 'Long-term memory notes'], ['OPT-0071', 'Tool notes'], ['OPT-0072', 'Notes about you']];

  const ROWS = {
    'OPT-0019': readonly((agent, ctx) => { const e = recordsOf(ctx); return ready(e) ? plural((e.data.records || []).length, 'record') : (e.error ? 'Not available' : 'Checking…'); },
      { summary: () => 'Records' }),
    'OPT-0020': readonly((agent, ctx) => {
      const e = recordsOf(ctx);
      if (!ready(e)) return e.error ? 'Not available' : 'Checking…';
      const used = (e.data.records || []).reduce((s, r) => s + (Number(r.bytes) || 0), 0);
      const kb = (n) => nf(Math.round(n / 1024)) + ' KB';
      return Number(e.data.maxBytes) ? kb(used) + ' of ' + kb(e.data.maxBytes) : kb(used);
    }),
    'OPT-0021': {   // reading and editing a record's text is the agent page's editor: a button to it
      get: () => ({ value: '', display: 'Open the records' }), control: { type: 'action' },
      save: async (agent, v, ctx) => openDoor(ctx, 'OPT-0021'),
    },
    'OPT-0041': {   // How full before it acts: PATCH {compaction:{mode, at}} (members may; the PUT route is admin-only)
      get: (agent) => {
        const at = agent.compaction && agent.compaction.at;
        return { value: at == null ? '' : String(at), display: at == null ? '' : Math.round(Number(at) * 100) + '%', isDefault: at == null };
      },
      control: { type: 'select', options: (agent) => {
        const at = agent && agent.compaction && agent.compaction.at;
        return at != null && !AT_OPTIONS.some((o) => o.value === String(at)) ? AT_OPTIONS.concat([{ value: String(at), label: Math.round(Number(at) * 100) + '%' }]) : AT_OPTIONS;
      } },
      save: async (agent, value, ctx) => {
        if (value === '') return dropAt(agent, ctx);
        const n = Number(value);
        if (!(n >= 0.3 && n <= 0.95)) return { ok: false, error: 'Pick a level between 30% and 95%.' };
        return ctx.patch({ compaction: { at: n } });
      },
      resetDefault: (agent, ctx) => dropAt(agent, ctx),
    },
    'OPT-0042': numberRow('contextWindow', { min: 2048, max: 4000000, step: 1000, hint: 'Enter a whole number from 2,048 to 4,000,000 tokens, or use the default.' }),
    'OPT-0043': readonly((agent, ctx) => fullness(ctx, (pct, d) => pct + '% full (' + nf(d.tokens) + ' of ' + nf(d.limit) + ' tokens)')),
    'OPT-0044': readonly((agent, ctx) => {
      const e = memoryNow(ctx);
      if (!ready(e)) return e.error ? 'Not available' : 'Checking…';
      if (e.data.running || e.data.requested) return 'Compressing now';
      if (!e.data.lastRunAt) return 'Never';
      const d = new Date(Number(e.data.lastRunAt));
      return isNaN(d.getTime()) ? 'Never' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    }),
    'OPT-0065': numberRow('maxContextMessages', { min: 1, max: 200, step: 1, hint: 'Enter a whole number from 1 to 200, or use the default.' }),
    'OPT-0067': numberRow('contextBudget', { min: 125000, max: 1000000, step: 1000, hint: 'Enter a whole number from 125,000 to 1,000,000 tokens, or use the default.' }),
    'OPT-0077': {
      get: (agent) => ({ value: !!agent.minimalContext, display: agent.minimalContext ? 'On' : 'Off' }),
      control: { type: 'toggle' },
      save: (agent, value, ctx) => ctx.patch({ minimalContext: !!value }),
      summary: (agent) => (agent.minimalContext ? 'shortest background' : 'recall on'),
    },
    'OPT-0081': numberRow('recordsMaxBytes', { min: 4096, max: 2 * 1024 * 1024, step: 1024, hint: 'Enter a whole number of bytes from 4,096 to 2,097,152, or use the default.' }),
    'OPT-0183': readonly((agent, ctx) => fullness(ctx, (pct) => 'Context ' + pct + '% full')),
    'OPT-0882': readonly((agent, ctx) => fullness(ctx, (pct) => pct + '% context')),
    'OPT-0833': {   // Compress now: POST .../compaction/run (409 = already running)
      get: (agent, ctx) => { const e = memoryNow(ctx); const run = ready(e) && (e.data.running || e.data.requested); return { value: '', display: run ? 'Compressing…' : 'Compress now' }; },
      control: { type: 'action' },
      live: (agent, ctx) => { const e = memoryNow(ctx); return !(ready(e) && (e.data.running || e.data.requested)); },
      save: async (agent, v, ctx) => {
        const r = await call(ctx, 'POST', '/api/agents/' + enc(ctx.name) + '/compaction/run');
        resetCache(ctx.name);
        if (r.ok) return { ok: true };
        return { ok: false, error: r.status === 409 ? 'It is already being compressed.' : r.error };
      },
    },
  };
  for (const [id] of NOTE_FILES) {   // the notes files are edited in the agent page's editor
    ROWS[id] = { get: () => ({ value: '', display: 'Open the notes' }), control: { type: 'action' }, save: async (agent, v, ctx) => openDoor(ctx, id) };
  }

  // ── Access ──────────────────────────────────────────────────────────────────────────────────────────────────
  /** Records the phase-2 rule marks dangerous: never changed on the card. */
  const DANGEROUS_IDS = ['OPT-0008', 'OPT-0009', 'OPT-0010', 'OPT-0011', 'OPT-0012', 'OPT-0013', 'OPT-0017', 'OPT-0018', 'OPT-0053', 'OPT-0054', 'OPT-0055', 'OPT-0056'];
  const POLICY_ROWS = { 'OPT-0008': 'web', 'OPT-0009': 'read_outside', 'OPT-0010': 'write_outside', 'OPT-0011': 'send', 'OPT-0012': 'admin', 'OPT-0013': 'destroy' };
  const POLICY_WORDS = { allow: 'Allowed', ask: 'Asks you first', deny: 'Refused' };
  const overridesOf = (a) => (a && a.policy && a.policy.overrides && typeof a.policy.overrides === 'object' ? a.policy.overrides : {});
  const rootsOf = (a) => listOf(a && a.policy && a.policy.roots);
  const BOX_WORDS = { inherit: 'Same as all agents', off: 'Not kept in a box', container: 'Kept in its own box' };
  const LOCKBOX_WORDS = { inherit: 'Same as all agents', off: 'Off', watch: 'Only reports what it would block', enforce: 'Blocks' };
  for (const [id, cls] of Object.entries(POLICY_ROWS)) {
    ROWS[id] = doorRow(id, { show: (agent) => { const v = overridesOf(agent)[cls]; return POLICY_WORDS[v] || 'Follows its role'; } });
  }
  const rootGrant = (ctx) => need(ctx, 'root', '/api/root-grants?agent=' + enc(ctx.name));
  const ROOT_MINUTES = [15, 60, 240, 1440];
  const rootWhy = (d) => (d.lead ? 'The lead agent always has administrator access.' : d.memberOwned ? 'A member\'s agent never gets administrator access.' : d.sandboxed ? 'Its box has no administrator access; switch the box off first.' : '');
  Object.assign(ROWS, {
    'OPT-0015': readonly((agent) => {
      const o = overridesOf(agent); const n = Object.keys(POLICY_ROWS).filter((k) => ['allow', 'ask', 'deny'].includes(o[POLICY_ROWS[k]])).length;
      return n ? plural(n, 'power') + ' of 6 set for this agent; the rest follow its role' : 'All six follow its role';
    }),
    'OPT-0016': {   // Administrator access: POST /api/root-grants {agent, minutes}; DELETE /api/root-grants/<name>
      get: (agent, ctx) => {
        const e = rootGrant(ctx);
        if (!ready(e)) return { value: '', display: e.error ? 'Not available' : 'Checking…' };
        const g = e.data.grant;
        return g ? { value: 'active', display: g.until ? 'Given until ' + when(g.until) : 'Given' } : { value: '', display: 'Not given' };
      },
      control: { type: 'select', options: (agent, ctx) => {
        const e = ctx && ctx.name ? rootGrant(ctx) : null;
        const max = e && ready(e) && Number(e.data.maxMinutes) > 0 ? Number(e.data.maxMinutes) : Infinity;
        const out = [{ value: '', label: 'Not given' }];
        if (e && ready(e) && e.data.grant) out.push({ value: 'active', label: e.data.grant.until ? 'Given until ' + when(e.data.grant.until) : 'Given' });
        for (const m of ROOT_MINUTES) if (m <= max) out.push({ value: String(m), label: m >= 60 ? 'For ' + plural(m / 60, 'hour') : 'For ' + m + ' minutes' });
        return out;
      } },
      desc: (agent, ctx) => { const e = rootGrant(ctx); if (e.error) return e.error; return ready(e) ? rootWhy(e.data) : ''; },
      live: (agent, ctx) => { const e = rootGrant(ctx); return !(ready(e) && rootWhy(e.data)); },
      save: async (agent, value, ctx) => {
        let r;
        if (value === 'active') return { ok: true };
        if (value === '') r = await call(ctx, 'DELETE', '/api/root-grants/' + enc(ctx.name));
        else {
          const m = Number(value);
          if (!ROOT_MINUTES.includes(m)) return { ok: false, error: 'Pick how long it may have administrator access.' };
          r = await call(ctx, 'POST', '/api/root-grants', { agent: ctx.name, minutes: m });
        }
        resetCache(ctx.name);
        return r.ok ? { ok: true } : { ok: false, error: r.error };
      },
    },
    'OPT-0017': doorRow('OPT-0017', { show: (agent) => { const n = rootsOf(agent).length; return n ? plural(n, 'folder') + ' beyond its own' : 'Its own folders only'; }, summary: (agent) => { const n = rootsOf(agent).length; return n ? plural(n, 'folder') : ''; } }),
    'OPT-0018': doorRow('OPT-0018', { show: (agent) => { const r = rootsOf(agent); return r.length ? r.join(', ') : 'None'; } }),
    'OPT-0053': doorRow('OPT-0053', { show: (agent) => BOX_WORDS[agent.sandbox || 'inherit'] || String(agent.sandbox), summary: (agent) => (agent.sandbox === 'container' ? 'kept in its own box' : '') }),
    'OPT-0054': doorRow('OPT-0054', { show: (agent) => LOCKBOX_WORDS[agent.lockbox || 'inherit'] || String(agent.lockbox), summary: (agent) => (agent.lockbox === 'watch' ? 'commands watched' : (agent.lockbox === 'enforce' ? 'commands blocked' : '')) }),
    'OPT-0055': doorRow('OPT-0055', { show: (agent) => { const n = listOf(agent.lockboxEnv); return n.length ? n.join(', ') : 'None'; } }),
    'OPT-0056': readonly((agent, ctx) => {
      const e = need(ctx, 'blocked', '/api/lockbox/watch?agent=' + enc(ctx.name) + '&limit=5');
      if (!ready(e)) return e.error ? e.error : 'Checking…';
      const n = Array.isArray(e.data.entries) ? e.data.entries.length : 0;
      return n ? plural(n, 'recent line') + ' in the lockbox log' : 'Nothing recently';
    }),
    'OPT-0064': {   // Tools it can use: PATCH {tools}; only for Claude Code and Codex agents, fixed while boxed
      get: (agent) => { const v = agent.tools || 'inherit'; return { value: v, display: ({ inherit: 'Same as all agents', hub: 'Maestro\'s tools', client: 'Its own tools' })[v] || v, isDefault: v === 'inherit' }; },
      control: { type: 'select', options: () => [{ value: 'inherit', label: 'Same as all agents' }, { value: 'hub', label: 'Maestro\'s tools' }, { value: 'client', label: 'Its own tools' }] },
      visible: (agent) => clientModel(agent),
      live: (agent) => agent.sandbox !== 'container',
      desc: (agent) => (agent.sandbox === 'container' ? 'Kept in its box, so it uses Maestro\'s tools.' : 'Whether it works with Maestro\'s tools or its own built-in ones.'),
      save: (agent, value, ctx) => ctx.patch({ tools: String(value || 'inherit') }),
      resetDefault: (agent, ctx) => ctx.patch({ tools: 'inherit' }),
      summary: (agent) => { if (agent.noTools) return 'no tools'; const n = listOf(agent.toolWhitelist).length; return n ? plural(n, 'tool') : ''; },
    },
    'OPT-0078': {
      get: (agent) => { const l = listOf(agent.toolWhitelist); return { value: l, display: l.join(', '), isDefault: !l.length }; },
      control: { type: 'list' },
      save: (agent, value, ctx) => { const l = listOf(value); return ctx.patch({ toolWhitelist: l.length ? l : null }); },
      resetDefault: (agent, ctx) => ctx.patch({ toolWhitelist: null }),
    },
    'OPT-0079': {
      get: (agent) => ({ value: !!agent.noTools, display: agent.noTools ? 'On' : 'Off' }),
      control: { type: 'toggle' },
      save: (agent, value, ctx) => ctx.patch({ noTools: !!value }),
    },
    'OPT-0080': {   // the server lets only a signed-in admin's own call change it, and says so
      get: (agent) => { const l = listOf(agent.envKeep); return { value: l, display: l.join(', '), isDefault: !l.length }; },
      control: { type: 'list' },
      save: (agent, value, ctx) => { const l = listOf(value); return ctx.patch({ envKeep: l.length ? l : null }); },
      resetDefault: (agent, ctx) => ctx.patch({ envKeep: null }),
    },
  });

  // ── Schedule and background work ─────────────────────────────────────────────────────────────────────────
  const tasksOf = (ctx) => need(ctx, 'tasks', '/api/scheduled-tasks');
  const workOf = (ctx) => need(ctx, 'work', '/api/agents/' + enc(ctx.name) + '/working-on');
  /** { n, next } of this agent's active scheduled tasks, or null while unread. */
  function scheduled(ctx) {
    const e = tasksOf(ctx);
    if (!ready(e)) return null;
    const mine = (e.data.tasks || []).filter((t) => t && t.agent === ctx.name && (t.status === undefined || t.status === 'active'));
    const md = (e.data.tasksMd || []).filter((t) => t && t.agent === ctx.name && t.enabled !== false);
    const times = mine.map((t) => t.nextRunAt).concat(md.map((t) => t.nextRunAt)).filter(Boolean).sort();
    return { n: mine.length + md.length, next: times[0] || null };
  }
  const workWords = (d) => {
    const parts = [];
    const open = (d.handOffs || []).filter((h) => h && ['queued', 'running', 'working', 'waiting', 'open'].includes(h.state)).length;
    if (open) parts.push(plural(open, 'hand-off'));
    if (Number(d.jobCount)) parts.push(plural(Number(d.jobCount), 'job'));
    if ((d.workers || []).length) parts.push(plural(d.workers.length, 'worker'));
    return parts.join(' · ');
  };
  const HIDDEN = { visible: () => false };   // the scheduler's own form fields and view choice: not settings of this agent
  Object.assign(ROWS, {
    'OPT-0073': { get: () => ({ value: '', display: 'Open the task list' }), control: { type: 'action' }, save: async (agent, v, ctx) => openDoor(ctx, 'OPT-0073') },
    'OPT-0736': {
      get: () => ({ value: '', display: 'Open the task scheduler' }), control: { type: 'action' },
      desc: (agent, ctx) => {
        if (!ctx.isAdmin) return '';
        const s = scheduled(ctx);
        if (!s) return tasksOf(ctx).error ? 'Not available' : 'Checking…';
        return s.n ? plural(s.n, 'task') + ' scheduled' + (s.next ? ' · next run ' + when(s.next) : '') : 'Nothing scheduled';
      },
      save: async (agent, v, ctx) => openScheduler(ctx),
      summary: (agent, ctx) => { if (!ctx.isAdmin) return ''; const s = scheduled(ctx); return s ? s.n + ' scheduled' : ''; },
    },
    'OPT-0742': {
      get: () => ({ value: '', display: 'Open the task scheduler' }), control: { type: 'action' },
      desc: (agent, ctx) => {
        if (!ctx.isAdmin) return '';
        const e = workOf(ctx);
        if (!ready(e)) return e.error ? 'Not available' : 'Checking…';
        const n = Number(e.data.count) || 0;
        return n ? n + ' running · ' + (workWords(e.data) || 'background work') : 'Nothing running';
      },
      save: async (agent, v, ctx) => openScheduler(ctx),
      summary: (agent, ctx) => { if (!ctx.isAdmin) return ''; const e = workOf(ctx); return ready(e) ? (Number(e.data.count) || 0) + ' running' : ''; },
    },
  });
  for (const id of ['OPT-0089', 'OPT-0090', 'OPT-0091', 'OPT-0737', 'OPT-0738', 'OPT-0739', 'OPT-0740', 'OPT-0741']) ROWS[id] = Object.assign({ get: () => ({ value: '', display: '' }), control: { type: 'readonly' } }, HIDDEN);

  /** The rows shown before "More" (the order is the order of the section's summary line). */
  const FIRST_ROWS = {
    memory: ['OPT-0019', 'OPT-0040', 'OPT-0043', 'OPT-0833'],
    access: ['OPT-0064', 'OPT-0017', 'OPT-0053', 'OPT-0054'],
    schedule: ['OPT-0736', 'OPT-0742'],
  };

  function install() {
    if (!card) return false;
    card.registerMany(ROWS);
    if (typeof card.setFirstRows === 'function') { for (const [k, ids] of Object.entries(FIRST_ROWS)) card.setFirstRows(k, ids); }
    else if (card.FIRST_ROWS) Object.assign(card.FIRST_ROWS, FIRST_ROWS);
    return true;
  }
  install();

  return { ROWS, FIRST_ROWS, DANGEROUS_IDS, POLICY_ROWS, doorUrl, resetCache, install };
});
