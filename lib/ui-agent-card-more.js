/**
 * ui-agent-card-more.js — the rows of the agent card's Memory, Access and Schedule and background work sections.
 *
 * Registers a rowDef (see lib/ui-agent-card.js) for every record homed on those three sections that has a control today, and
 * sets the rows shown first in each section (FIRST_ROWS: memory, access, schedule). Every save goes through the route the
 * agent page uses, so the server's own checks and the settings journal apply:
 *   - PATCH /api/agents/<name> (through ctx.patch) for tools, tool lists, working memory, limits, compaction threshold, notes
 *     of what to keep, "no tools", the commands' settings;
 *   - POST /api/agents/<name>/compaction/run (Compress now); POST and DELETE /api/root-grants (administrator access).
 * The records, the notes files (SOUL, IDENTITY, MEMORY, TOOLS, USER) and the task list (TASKS.md) are edited in place with the
 * frame's 'editor' control: GET/PUT/DELETE /api/agents/<name>/records[/<record>], GET /api/agents/<name>/files and PUT .../files/<file>.
 * The records the phase-2 rule marks dangerous (policy classes, folders, the box, the command lockbox) are rows of lib/ui-agent-card-access.js.
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
  const enc = encodeURIComponent;

  // ── reading the hub's other routes, kept for a few seconds per agent ─────────────────────────────────────────
  const cache = new Map();   // "<agent>|<kind>" -> { data, error, status, at, pending }
  function resetCache(name) {
    for (const k of [...cache.keys()]) if (!name || k.startsWith(name + '|')) cache.delete(k);
    if (!name) { for (const p of [...polls.values()]) { try { p.stop(); } catch { /* gone */ } } polls.clear(); compactNow.clear(); recChosen.clear(); }   // forget everything (tests, a new session of the page)
  }
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
  // ── Compress now: what it says while it runs, the 5-second re-read, and "Done, read the brief" ──────────────────────────
  const POLL_MS = 5000;
  const LOCAL_HINT = 'Local model: assisted mode at 60% is the default.';
  const BRIEF_FILE = 'working-brief.md';
  const compactNow = new Map();   // agent name -> { note: { text, tone }|null, brief: bool, briefFile }: what the last compression said
  const polls = new Map();        // agent name -> the one re-read running for that agent's open card
  const compactOf = (name) => { let s = compactNow.get(name); if (!s) { s = { note: null, brief: false, briefFile: BRIEF_FILE }; compactNow.set(name, s); } return s; };
  const compactUrl = (ctx) => '/api/agents/' + enc(ctx.name) + '/compaction';
  const MODE_WORDS = { off: 'off', dry: 'dry run', on: 'on', assisted: 'assisted' };
  const modeWord = (m) => MODE_WORDS[m] || String(m || 'off');
  /** The question before Compress now: the same words per mode as the agent page asked. */
  function compressQuestion(name, mode) {
    const what = mode === 'on'
      ? name + ' will write its working brief (working-brief.md), then its session is reset and seeded from Records, recent turns and recall.'
      : mode === 'assisted'
        ? name + ' gets its transcript in slices sized to its window, extracts into its Records from each slice, writes its working brief on a fixed template, then starts fresh (assisted).'
        : mode === 'dry'
          ? name + ' will write its working brief (working-brief.md); the session goes on unchanged (dry run).'
          : 'Compression is off for ' + name + '. The hub will run it as a dry run: the brief only, the session goes on unchanged.';
    return 'Compress now?\n\n' + what + '\n\nThis takes a turn of the agent (it can run for minutes).';
  }
  /** Keeps reading the compression status every 5 s, only while this card is open and the row is on screen; says how it ended. */
  function pollStart(ctx, from) {
    const name = ctx.name;
    if (polls.has(name) || typeof ctx.later !== 'function') return;
    const p = { timer: null, seen: true, from: from == null ? Date.now() - POLL_MS : from, stop: null };
    const stop = () => { if (p.timer != null && typeof ctx.cancelLater === 'function') ctx.cancelLater(p.timer); p.timer = null; if (polls.get(name) === p) polls.delete(name); };
    p.stop = stop;
    polls.set(name, p);
    if (typeof ctx.onClose === 'function') ctx.onClose(stop);   // the card closed: no more reads
    const alive = () => (typeof ctx.alive === 'function' ? ctx.alive() : true);
    const tick = async () => {
      p.timer = null;
      if (polls.get(name) !== p) return;
      if (!alive() || !p.seen) { stop(); return; }   // closed, or the row was not drawn since the last read (its section is shut)
      p.seen = false;
      const r = await call(ctx, 'GET', compactUrl(ctx));
      if (polls.get(name) !== p) return;
      if (!alive()) { stop(); return; }
      const d = r.ok && r.data && r.data.ok !== false ? r.data : null;
      let done = false;
      if (d) p.fails = 0;
      else {   // refused (401/403) or failed: say so and stop at once if refused, else after 3 in a row
        p.fails = (p.fails || 0) + 1;
        if (r.status === 401 || r.status === 403 || p.fails >= 3) { compactOf(name).note = { tone: 'error', text: 'Could not check the progress.' }; done = true; }
      }
      if (d) {
        cache.set(name + '|compaction', { data: d, error: null, status: 200, at: Date.now(), pending: false });
        const s = compactOf(name);
        const last = Array.isArray(d.runs) && d.runs.length ? d.runs[d.runs.length - 1] : null;
        const raw = last ? last.at : d.lastRunAt, at = typeof raw === 'number' ? raw : Date.parse(raw);   // when the newest result was made
        if (d.running) { /* still going */ }
        else if (d.lastBusy && last && Date.parse(last.at) >= p.from) { done = true; s.note = { tone: 'ok', text: '⏸ Postponed: ' + (d.lastError || 'the agent stayed busy') }; }   // kept for the agent's next turn
        else if (d.requested) { /* asked, not started yet */ }
        else if (!(Number.isFinite(at) && at >= p.from)) { /* a result older than this run: not this run's Done */ }
        else {
          done = true;
          if (d.lastOk === false) s.note = { tone: 'error', text: '❌ Compression failed: ' + (d.lastError || 'unknown error') };
          else { s.note = { tone: 'ok', text: d.lastReset ? '✅ Done: brief written, fresh session started' : '✅ Done, read the brief' }; s.brief = true; if (d.briefFile) s.briefFile = d.briefFile; }
        }
      }
      if (done) stop();
      try { await ctx.refresh(); } catch { /* the card is gone */ }
      if (!done && polls.get(name) === p && alive()) p.timer = ctx.later(tick, POLL_MS);
    };
    p.timer = ctx.later(tick, POLL_MS);
  }
  /** "Done, read the brief": choose working-brief.md in the records picker and open the records editor on it. */
  async function openBrief(ctx) {
    const s = compactOf(ctx.name);
    const file = s.briefFile || BRIEF_FILE;
    resetCache(ctx.name);
    const r = await call(ctx, 'GET', '/api/agents/' + enc(ctx.name) + '/records');
    const list = r.ok && r.data && Array.isArray(r.data.records) ? r.data.records : [];
    if (!list.some((x) => x && x.name === file)) { s.note = { tone: 'error', text: '❌ No record ' + file + ' yet.' }; try { await ctx.refresh(); } catch { /* gone */ } return; }
    recChosen.set(ctx.name, { name: file, isNew: false });
    if (typeof ctx.openMore === 'function') ctx.openMore('memory');
    try { await ctx.refresh(); } catch { /* gone */ }   // the picker now lists it and shows it chosen
    if (typeof ctx.openEditor === 'function') ctx.openEditor('OPT-0021');
  }
  /** The Compress now control: the button, what it is doing or how it ended, and "Done, read the brief" after a run. */
  function compressBuild({ mk, ctx, got, send, busy }) {
    const e = memoryNow(ctx);
    const d = ready(e) ? e.data : null;
    const running = !!(d && (d.running || d.requested));
    const s = compactOf(ctx.name);
    const p = polls.get(ctx.name);
    if (p) p.seen = true;
    if (running) pollStart(ctx);
    const wrap = mk('div', 'ac-compress');
    const btn = mk('button', 'ac-action', running ? '⚙ Compressing…' : '⚙ Compress now'); btn.setAttribute('type', 'button');
    if (running) { btn.disabled = true; btn.setAttribute('disabled', ''); }
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const w = ctx.win;
      const mode = (d && d.mode) || (ctx.agent && ctx.agent.compaction && ctx.agent.compaction.mode) || 'off';
      if (!(w && typeof w.confirm === 'function' && w.confirm(compressQuestion(ctx.name, mode)))) return;
      send(true);
    });
    wrap.appendChild(btn);
    if (s.brief && !running) {
      const b = mk('button', 'ac-action ac-brief', 'Done, read the brief'); b.setAttribute('type', 'button');
      if (busy) { b.disabled = true; b.setAttribute('disabled', ''); }
      b.addEventListener('click', () => { if (!b.disabled) openBrief(ctx); });
      wrap.appendChild(b);
    }
    const line = running ? { tone: 'ok', text: '⚙ Compression running… the agent is writing its working brief.' } : s.note;
    if (line) { const m = mk('div', 'ac-note ac-compress-msg', line.text); m.setAttribute('role', line.tone === 'error' ? 'alert' : 'status'); wrap.appendChild(m); }
    return wrap;
  }
  const recordUrl = (ctx, name) => '/api/agents/' + enc(ctx.name) + '/records/' + enc(name);
  const recChosen = new Map();   // agent name -> { name, isNew }: the record the person chose on that agent's card
  /** Why a new record's name is refused (the agent page's rules), or '' when it is fine. */
  function recordNameProblem(name, records) {
    if (!name) return 'Give the record a name.';
    if (/[\/\\]/.test(name)) return 'A record name cannot contain slashes.';
    if (name.charAt(0) === '.') return 'A record name cannot start with a dot.';
    if ((records || []).some((r) => r && r.name === name)) return name + ' already exists; choose it from the list.';
    return '';
  }
  /** The picker above the records editor: a select of the agent's records, "New record", and Delete for an existing one. */
  function recordsToolbar(t) {
    const { mk, ctx, busy, isOpen, open, close, fail, run } = t;
    const bar = mk('div', 'ac-editor-tools');
    const e = recordsOf(ctx);
    if (!ready(e)) { bar.appendChild(mk('span', 'ac-value', e.error ? 'Not available' : 'Checking…')); return bar; }
    const list = Array.isArray(e.data.records) ? e.data.records : [];
    const cur = recChosen.get(ctx.name) || null;
    const sel = mk('select', 'ac-select'); sel.setAttribute('aria-label', 'Record');
    const add = (value, label) => { const o = mk('option', '', label); o.setAttribute('value', value); o.value = value; sel.appendChild(o); };
    add('', list.length ? 'Choose a record…' : 'No records yet');
    for (const r of list) add(r.name, r.name);
    if (cur && !list.some((r) => r.name === cur.name)) add(cur.name, cur.name + ' (new)');
    sel.value = cur ? cur.name : '';
    if (busy || isOpen) { sel.disabled = true; sel.setAttribute('disabled', ''); }
    sel.addEventListener('change', () => {
      if (!sel.value) { recChosen.delete(ctx.name); try { ctx.refreshOpen(); } catch { /* gone */ } return; }
      recChosen.set(ctx.name, { name: sel.value, isNew: false });
      open();
    });
    bar.appendChild(sel);
    const make = mk('button', 'ac-action ac-new', 'New record'); make.setAttribute('type', 'button');
    if (busy || isOpen) { make.disabled = true; make.setAttribute('disabled', ''); }
    make.addEventListener('click', () => {
      const w = ctx.win;
      if (!w || typeof w.prompt !== 'function') { fail('Name the new record on a page that can ask for it.'); return; }
      const raw = w.prompt('Name for the new record (a file name, e.g. clients.md):', '');
      if (raw === null || raw === undefined) return;
      const name = String(raw).trim();
      if (!name) return;
      const bad = recordNameProblem(name, list);
      if (bad) { fail(bad); return; }
      recChosen.set(ctx.name, { name, isNew: true });
      open();
    });
    bar.appendChild(make);
    if (cur && !cur.isNew) {
      const del = mk('button', 'ac-action ac-remove ac-delete', 'Delete'); del.setAttribute('type', 'button'); del.setAttribute('aria-label', 'Delete the record ' + cur.name);
      if (busy) { del.disabled = true; del.setAttribute('disabled', ''); }
      del.addEventListener('click', () => {
        const w = ctx.win;
        if (!(w && typeof w.confirm === 'function' && w.confirm('Delete the record "' + cur.name + '"? The agent will no longer see it.'))) return;
        run(async () => {
          const r = await call(ctx, 'DELETE', recordUrl(ctx, cur.name));
          if (!r.ok) return { ok: false, error: r.error };
          if (r.data && r.data.ok === false) return { ok: false, error: r.data.error || 'Could not delete ' + cur.name + '.' };
          recChosen.delete(ctx.name);
          resetCache(ctx.name);
          close();
          return { ok: true };
        });
      });
      bar.appendChild(del);
    }
    return bar;
  }
  /** A notes file of the agent (its workspace file), edited in place: the list GET holds every file's text; PUT writes one. */
  const CHARACTER_FILES = ['SOUL.md', 'IDENTITY.md'];
  function fileRow(file, desc) {
    return {
      desc,
      get: () => ({ value: '', display: '' }),
      control: { type: 'editor' },
      confirm: CHARACTER_FILES.includes(file) ? (agent) => 'Change ' + (agent.display || agent.name) + '\'s character file ' + file + '? It takes effect on its next turn.' : undefined,
      load: async (agent, ctx) => {
        const r = await call(ctx, 'GET', '/api/agents/' + enc(ctx.name) + '/files');
        if (!r.ok) throw new Error(r.error);
        const f = r.data && r.data.files;
        return f && typeof f[file] === 'string' ? f[file] : '';
      },
      save: async (agent, text, ctx) => {
        const r = await call(ctx, 'PUT', '/api/agents/' + enc(ctx.name) + '/files/' + enc(file), { content: String(text) });
        if (!r.ok) return { ok: false, error: r.error };
        if (r.data && r.data.success === false) return { ok: false, error: r.data.error || 'Could not save ' + file + '.' };
        return { ok: true };
      },
    };
  }

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
    'OPT-0021': {   // a record: choose one (or make a new one), edit it in place; GET/PUT/DELETE /api/agents/<n>/records/<name>
      desc: 'Choose a record to read and change, or make a new one. The agent reads all its records in full on every turn.',
      get: () => ({ value: '', display: '' }),
      control: { type: 'editor' },
      canEdit: (agent, ctx) => !!recChosen.get(ctx.name),
      toolbar: recordsToolbar,
      load: async (agent, ctx) => {
        const s = recChosen.get(ctx.name);
        if (!s) throw new Error('Choose a record first.');
        if (s.isNew) return '';
        const r = await call(ctx, 'GET', recordUrl(ctx, s.name));
        if (!r.ok || (r.data && r.data.ok === false)) throw new Error((r.ok ? r.data.error : r.error) || 'Could not open ' + s.name + '.');
        return r.data && typeof r.data.content === 'string' ? r.data.content : '';
      },
      save: async (agent, text, ctx) => {
        const s = recChosen.get(ctx.name);
        if (!s) return { ok: false, error: 'Choose a record first.' };
        const r = await call(ctx, 'PUT', recordUrl(ctx, s.name), { content: String(text) });
        if (!r.ok) return { ok: false, error: r.error };
        if (r.data && r.data.ok === false) return { ok: false, error: r.data.error || 'Could not save ' + s.name + '.' };
        // The hub answers 200 with a text in `result`: only "Record <name> written (...)" says it was saved; any other text is why it was not.
        const said = r.data ? r.data.result : undefined;
        const m = typeof said === 'string' ? /^Record (.+?) (?:written|appended) \(/.exec(said) : null;
        if (typeof said === 'string' && !m) return { ok: false, error: said };
        if (m) s.name = m[1];   // the name the hub used (it adds .md)
        s.isNew = false;
        resetCache(ctx.name);
        return { ok: true };
      },
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
      control: { type: 'custom', build: compressBuild },   // the button, the "running…" line, how it ended and "Done, read the brief"
      save: async (agent, v, ctx) => {
        const s = compactOf(ctx.name);
        const r = await call(ctx, 'POST', '/api/agents/' + enc(ctx.name) + '/compaction/run', {});
        resetCache(ctx.name);
        if (r.ok && !(r.data && r.data.ok === false)) {
          s.brief = false;
          s.note = { tone: 'ok', text: '⚙ Started (' + modeWord((r.data && r.data.mode) || (agent.compaction && agent.compaction.mode)) + ')… this card checks every 5 s.' };
          pollStart(ctx);   // from now on, re-read every 5 s while the card is open and this row is showing
          return { ok: true };
        }
        const msg = r.ok ? ((r.data && r.data.error) || 'Could not start.') : (r.status === 409 ? 'It is already being compressed.' : r.error);
        s.note = { tone: 'error', text: '❌ Could not start: ' + msg };
        return { ok: false, error: msg };
      },
    },
  };
  // the notes files, edited in place (SOUL.md and IDENTITY.md change the agent's character: the save asks first)
  Object.assign(ROWS, {
    'OPT-0068': fileRow('SOUL.md', 'Its character, tone and values, written in plain words (SOUL.md).'),
    'OPT-0069': fileRow('IDENTITY.md', 'Who it is: its name, role and what it is for (IDENTITY.md).'),
    'OPT-0070': fileRow('MEMORY.md', 'Its own notes of things worth remembering between chats (MEMORY.md).'),
    'OPT-0071': fileRow('TOOLS.md', 'Notes about the tools and services it uses (TOOLS.md).'),
    'OPT-0072': fileRow('USER.md', 'What it knows about you: your name, habits and preferences (USER.md).'),
  });

  // ── Access ──────────────────────────────────────────────────────────────────────────────────────────────────
  /** Records the phase-2 rule marks dangerous: never changed on the card. */
  const DANGEROUS_IDS = ['OPT-0008', 'OPT-0009', 'OPT-0010', 'OPT-0011', 'OPT-0012', 'OPT-0013', 'OPT-0017', 'OPT-0018', 'OPT-0053', 'OPT-0054', 'OPT-0055', 'OPT-0056'];
  const POLICY_ROWS = { 'OPT-0008': 'web', 'OPT-0009': 'read_outside', 'OPT-0010': 'write_outside', 'OPT-0011': 'send', 'OPT-0012': 'admin', 'OPT-0013': 'destroy' };
  const POLICY_WORDS = { allow: 'Allowed', ask: 'Asks you first', deny: 'Refused' };
  const overridesOf = (a) => (a && a.policy && a.policy.overrides && typeof a.policy.overrides === 'object' ? a.policy.overrides : {});
  // The six power rows (OPT-0008..0013), folders (0017, 0018), the box and the command lockbox (0053..0055) are live rows of lib/ui-agent-card-access.js.
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
    'OPT-0073': fileRow('TASKS.md', 'The jobs it has been asked to do on a schedule or keep working on (TASKS.md). Scheduled tasks are re-read when you save.'),
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
    // "When the conversation gets long" (the mode row lives in ui-agent-card.js): the local-model hint under it, from the same status read the other Memory rows use
    const mode = typeof card.getRow === 'function' ? card.getRow('OPT-0040') : null;
    if (mode) card.register('OPT-0040', Object.assign({}, mode, { hint: (agent, ctx) => { const e = memoryNow(ctx); return ready(e) && e.data.local ? LOCAL_HINT : ''; } }));
    if (typeof card.setFirstRows === 'function') { for (const [k, ids] of Object.entries(FIRST_ROWS)) card.setFirstRows(k, ids); }
    else if (card.FIRST_ROWS) Object.assign(card.FIRST_ROWS, FIRST_ROWS);
    return true;
  }
  install();

  return { ROWS, FIRST_ROWS, DANGEROUS_IDS, POLICY_ROWS, recordNameProblem, resetCache, install, LOCAL_HINT, compressQuestion };
});
