/**
 * ui-settings-expert.js: the Settings rows for values that used to need a file edit (shared by the desktop Settings dialog and its phone frame).
 *
 *   Expert values       the .env keys a person may change here (HUB_TZ, hours, delays ...): one control each, saved through POST /api/settings/env
 *   Set in the .env file  read-only .env keys: value + help + where to change it
 *   Protected settings  keys that stay file-only or on their own screen: read-only, a secret shows only "set" / "not set"
 *   Memory limit for background work (OPT-1095): one number in GB, saved through POST /api/settings as jobMemoryLimitGb (null = automatic)
 *
 * Server contract (lib/env-file.js, routes in server.js):
 *   GET  /api/settings/env -> { rows: [{ key, value (null for a secret), set, writable, readonly, danger, running, pending }] }
 *   POST /api/settings/env { key, value } ('' = back to default) -> { ok:true, key, value, restartNeeded:true } or 400/403 { error }
 *
 * Page API (hooks for app.js):
 *   render(host, { records, fetchJson, toast, confirmFn, settings? }) -> Promise   draws the three blocks into `host`, registers the review source
 *   renderMemoryLimit(host, { records, fetchJson, toast, settings? }) -> Promise   draws the OPT-1095 row (Upkeep, not More)
 *   registerReview(hubReview, fetchJson)   the For your review source (also done by render)
 * Pure (tested in node): KEYS, DANGER_SETTINGS, recordOf, rowModel, models, formatValue, pendingText, pendingCount, reviewItem, checkValue,
 *   memoryModel, memoryPayload, expertHtml, memoryHtml.
 * fetchJson(url, opts?) -> Promise of the parsed JSON; it may reject with an Error whose message is the server's words, or resolve { error }.
 * records = the array of records, or the answer { records: [...] } of /api/settings-records.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.hubSettingsExpert = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TAKES_EFFECT = 'Takes effect after a restart.';
  const SAVED_PENDING = 'Saved. Restart your Maestro to use it.';
  const FILE_HELP = "Change it in the .env file in your Maestro's folder; takes effect after a restart.";
  const SCREEN_HELP = 'Change it on its own screen.';
  const MEM_ID = 'OPT-1095';
  const REVIEW_ID = 'expert-values';

  // How each writable key is drawn. kind: number | text | select | switch. Ranges here only guide the box; the server decides what it accepts.
  const KEYS = {
    HUB_TZ: { kind: 'text', placeholder: 'Region/City, for example Europe/Berlin' },
    HUB_WORKER_DEFAULT_SCOPE: { kind: 'select', options: [['read', 'Read only'], ['full', 'Full'], ['none', 'None']] },
    HUB_SECURITY_CHECK_HOURS: { kind: 'number', min: 1, max: 8760, step: 1, unit: 'hours' },
    HUB_UPDATE_CHECK_HOURS: { kind: 'number', min: 1, max: 8760, step: 1, unit: 'hours' },
    HUB_UPDATE_CHECK_FIRST_SECONDS: { kind: 'number', min: 1, max: 86400, step: 1, unit: 'seconds' },
    HUB_COMMS_DISABLED: { kind: 'switch', on: '1', onText: 'Turned off' },
    HUB_MEMORY_HEALTH: { kind: 'switch', on: 'off', onText: 'Turned off' },
    HUB_SELFCHECK: { kind: 'switch', on: 'off', onText: 'Turned off' },
    HUB_CONSULT_BUSY_WAIT_MS: { kind: 'number', min: 1000, max: 600000, step: 100, unit: 'milliseconds' },
    HUB_DELIVERY_COOLDOWN_MS: { kind: 'number', min: 1000, max: 3600000, step: 100, unit: 'milliseconds' },
    HUB_PUSH_SUBJECT: { kind: 'text', placeholder: 'mailto:you@example.com or https://example.com' },
    HUB_CODEX_TRANSPORT: { kind: 'select', options: [['exec', 'exec'], ['app-server', 'app-server']] },
    MM_VOICE_NO_AUTO_INSTALL: { kind: 'switch', on: '1', onText: 'Turned off' },
    HUB_SDK_AUTO_COMPACT_WINDOW: { kind: 'number', min: 10000, max: 2000000, step: 1000, unit: 'tokens' },
  };
  // The settings.json keys that stay off these screens' controls (survey section 1): shown read-only, never changed here.
  const DANGER_SETTINGS = ['toolPolicy', 'teamTemplates', 'walletAgents', 'walletOwner', 'receiverAliases'];
  const COUNTED = { teamTemplates: ['template', 'templates'], receiverAliases: ['alias', 'aliases'], walletAgents: ['agent', 'agents'] };

  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const isSecretKey = (k) => /(PASSWORD|SECRET|TOKEN|API_?KEY|PRIVATE)/i.test(String(k || ''));
  const oneLine = (s) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); const m = s.match(/^.*?[.!?](?=\s|$)/); return m ? m[0] : s; };

  // ── records ───────────────────────────────────────────────────────────────────────────────────────────
  // records: an array, the route's answer { records: [...] }, or the page's loaded Map id -> record (window.hubSettingsHelp.load())
  function list(records) {
    if (records && !Array.isArray(records) && typeof records.values === 'function') return Array.from(records.values());
    return Array.isArray(records) ? records : (records && Array.isArray(records.records) ? records.records : []);
  }
  /** The record whose storedAs is `env:KEY` / `settings.key` (or whose id is given); null when none. */
  // The records route never sends storedAs (lib/settings-records HIDDEN), so a row finds its record by the key name the record
  // lists in its labels ("HUB_TZ", "walletAgents"), when exactly one record does; storedAs and the id still match where present.
  function recordOf(records, storedAs) {
    const all = list(records);
    for (const r of all) if (r && (r.storedAs === storedAs || r.id === storedAs)) return r;
    const key = String(storedAs || '').replace(/^(env|settings)[:.]/, '');
    const hits = all.filter((r) => r && Array.isArray(r.labels) && r.labels.includes(key));
    return hits.length === 1 ? hits[0] : null;
  }
  const helpOf = (rec) => (rec ? oneLine(rec.help || rec.what || '') : '');

  // ── pure row model ────────────────────────────────────────────────────────────────────────────────────
  /** A web address shown without a name and password and without its query string ("?…"); any other text stays as it is. */
  function safeUrl(s) {
    s = String(s == null ? '' : s);
    const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(s);
    if (!m) return s;
    const host = m[2].slice(m[2].lastIndexOf('@') + 1);
    return m[1] + host + m[3] + (m[4] ? '?…' : '') + (m[5] ? '#…' : '');
  }
  /** The words shown for a value. A secret is only "set" / "not set"; an empty value is the default. A web address loses user:pass@ and its query. */
  function formatValue(row, rec) {
    const key = row && row.key;
    if (isSecretKey(key)) return row && row.set ? 'set' : 'not set';
    const v = row && row.value;
    if (v == null || v === '') return (row && row.set) ? 'set' : 'not set';
    return safeUrl(v);
  }
  const OUTSIDE_TEXT = 'Set outside the .env file: ';
  const EXPORT_TEXT = 'This line starts with export, so it is not read.';
  const CRLF_TEXT = 'This line ends in a Windows line break, so it is not read.';
  /** The extra lines under a row: the value that runs although the file has no line, and the export warning. */
  function extraLines(m) {
    const out = [];
    if (m.outside != null && m.outside !== '') out.push(OUTSIDE_TEXT + m.outside);
    if (m.note === 'export') out.push(EXPORT_TEXT);
    if (m.note === 'crlf') out.push(CRLF_TEXT);
    return out;
  }
  /** "Saved. Restart your Maestro to use it." when the file differs from what runs, else "Takes effect after a restart." */
  function pendingText(row) { return row && row.pending ? SAVED_PENDING : TAKES_EFFECT; }
  const pendingCount = (rows) => (Array.isArray(rows) ? rows : []).filter((r) => r && r.writable && !r.danger && !r.readonly && r.pending).length;   // only values this page can change wait for a restart here

  function rowModel(row, records) {
    const key = String(row.key);
    const rec = recordOf(records, 'env:' + key);
    const secret = isSecretKey(key);
    const block = row.writable && !row.danger && KEYS[key] ? 'expert' : (row.danger ? 'protected' : 'file');
    return {
      key, block, rec, id: rec ? rec.id : '', name: (rec && rec.name) || key, help: helpOf(rec),
      def: rec ? String(rec.def || '') : '', control: block === 'expert' ? KEYS[key] : null,
      secret, value: secret ? null : (row.value == null ? '' : String(row.value)), set: !!row.set,
      shown: formatValue(row, rec), pending: !!row.pending, running: secret ? null : row.running,
      outside: secret || row.outside == null ? null : safeUrl(row.outside), note: row.note === 'export' ? 'export' : (row.note === 'crlf' ? 'crlf' : ''),
      where: block === 'protected' && rec && rec.lead === 'screen' && !/^env:/.test(rec.storedAs || 'env:') ? SCREEN_HELP : FILE_HELP,
    };
  }
  /** The protected settings.json keys as read-only models; `settings` = the answer of GET /api/settings (may be missing). */
  function settingsModels(records, settings) {
    const s = settings && typeof settings === 'object' ? settings : null;
    return DANGER_SETTINGS.map((k) => {
      const rec = recordOf(records, 'settings.' + k);
      const v = s ? s[k] : undefined;
      let shown = '';
      if (s) {
        if (COUNTED[k] && v != null) {
          const n = Array.isArray(v) ? v.length : (typeof v === 'object' ? Object.keys(v).length : 0);
          shown = n + ' ' + COUNTED[k][n === 1 ? 0 : 1];
        } else shown = v == null || v === '' || (typeof v === 'object' && !Object.keys(v).length) ? 'not set' : (typeof v === 'object' ? 'set' : String(v));
      }
      return { key: k, block: 'protected', rec, id: rec ? rec.id : '', name: (rec && rec.name) || k, help: helpOf(rec), shown, pending: false, where: SCREEN_HELP };
    });
  }
  /** { expert, file, protectedRows } from the server's rows, in the server's order (protected: env first, then the settings keys). */
  function models(rows, records, settings) {
    const all = (Array.isArray(rows) ? rows : []).filter((r) => r && r.key).map((r) => rowModel(r, records));
    return {
      expert: all.filter((m) => m.block === 'expert'),
      file: all.filter((m) => m.block === 'file'),
      protectedRows: all.filter((m) => m.block === 'protected').concat(settingsModels(records, settings)),
    };
  }

  /** The For your review item for pending rows, or null. */
  function reviewItem(rows) {
    const n = pendingCount(rows);
    if (!n) return null;
    return {
      id: 'expert-restart', tier: 'worth', level: 'warn',
      title: `Restart your Maestro to use the new expert values (${n})`,
      text: n === 1 ? 'One expert value is saved in the .env file but not in use yet.' : `${n} expert values are saved in the .env file but not in use yet.`,
      detailsSection: 'upkeep',
    };
  }
  /** The source for window.hubReview.register: asks the server on every load. */
  function reviewSource(fetchJson) {
    return {
      id: REVIEW_ID,
      // its own fetchJson first: the review list hands every source a plain fetch (a Response, not the JSON)
      load: (fetchFn) => Promise.resolve((fetchJson || fetchFn)('/api/settings/env')).then((j) => {
        const r = (j && j.error) ? null : reviewItem(j && j.rows);
        if (j && j.error) throw new Error(j.error);
        return { problems: r ? [r] : [] };
      }),
    };
  }
  function registerReview(hubReview, fetchJson) {
    if (!hubReview || typeof hubReview.register !== 'function') return false;
    return !!hubReview.register(reviewSource(fetchJson));
  }

  /** Client-side check before the request (the server checks again). Returns '' when fine, else plain words. */
  function checkValue(model, raw) {
    const v = String(raw == null ? '' : raw).trim();
    if (v === '') return '';
    const c = model.control || {};
    if (c.kind === 'number') {
      if (!/^\d+$/.test(v)) return 'Use a whole number.';
      const n = Number(v);
      if (c.min != null && n < c.min) return `Use ${c.min} or more.`;
      if (c.max != null && n > c.max) return `Use ${c.max} or less.`;
    }
    return '';
  }

  // ── OPT-1095 ──────────────────────────────────────────────────────────────────────────────────────────
  /** The memory-limit row from settings.jobMemoryLimitGb: blank / null / absent = Automatic, 0 = off. */
  function memoryModel(settings, records) {
    const rec = recordOf(records, MEM_ID) || recordOf(records, 'settings.jobMemoryLimitGb');
    const v = settings && typeof settings === 'object' ? settings.jobMemoryLimitGb : null;
    const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : null);
    const valid = n !== null && Number.isFinite(n) && n >= 0;
    return {
      id: (rec && rec.id) || MEM_ID, name: (rec && rec.name) || 'Memory limit for background work', help: helpOf(rec),
      value: valid ? String(n) : '', automatic: !valid, off: valid && n === 0,
      shown: !valid ? 'Automatic' : (n === 0 ? 'Off (no limit)' : n + ' GB'),
    };
  }
  /** The body for POST /api/settings: a number of GB, 0 = off, '' = Automatic (null removes the number). Returns { body } or { error }. */
  function memoryPayload(raw) {
    const v = String(raw == null ? '' : raw).trim();
    if (v === '') return { body: { jobMemoryLimitGb: null } };
    if (!/^\d+(\.\d+)?$/.test(v)) return { error: 'Use a number of GB, 0 to turn it off, or leave it empty for Automatic.' };
    const n = Number(v);
    if (n > 4096) return { error: 'Use 4096 GB or less.' };
    return { body: { jobMemoryLimitGb: n } };
  }

  // ── html ──────────────────────────────────────────────────────────────────────────────────────────────
  const rowHead = (m) => `<label>${esc(m.name)}</label>`;
  const info = (m) => (m.id ? ` data-setting="${esc(m.id)}"` : '');

  function controlHtml(m) {
    const c = m.control, k = esc(m.key), v = m.value;
    if (c.kind === 'number') return `<input type="number" inputmode="numeric" id="st-env-${k}" data-envin="${k}" min="${c.min}" max="${c.max}" step="${c.step}" value="${esc(v)}" placeholder="Default" style="width:9em"> <span class="st-hint">${esc(c.unit)}</span>`;
    if (c.kind === 'text') return `<input type="text" id="st-env-${k}" data-envin="${k}" value="${esc(v)}" placeholder="${esc(c.placeholder || 'Default')}" style="flex:1 1 180px;min-width:0;max-width:300px">`;
    const opts = c.kind === 'switch' ? [['', 'Default'], [c.on, c.onText]] : [['', 'Default']].concat(c.options);
    // a value the control does not know (HUB_COMMS_DISABLED=true ...) is its own selected option, so Save never drops it by accident
    if (v !== '' && v != null && !opts.some(([val]) => val === v)) opts.push([v, `${v} (now)`]);
    return `<select id="st-env-${k}" data-envin="${k}">${opts.map(([val, txt]) => `<option value="${esc(val)}"${val === v ? ' selected' : ''}>${esc(txt)}</option>`).join('')}</select>`;
  }
  function expertRowHtml(m) {
    const def = m.def ? `<div class="st-hint" data-for="${esc(m.key)}">${esc(m.def)}</div>` : '';
    const extra = extraLines(m).map((t) => `<div class="st-hint" style="flex-basis:100%" data-extra="${esc(m.key)}">${esc(t)}</div>`).join('');
    return `<div class="st-row" style="flex-wrap:wrap;row-gap:4px" data-expert="${esc(m.key)}"${info(m)}>${rowHead(m)}${controlHtml(m)} ` +
      `<button class="st-test-btn" data-act="save" data-key="${esc(m.key)}">Save</button> <button class="st-test-btn" data-act="default" data-key="${esc(m.key)}">Use default</button>` +
      `<div class="st-hint" style="flex-basis:100%" data-state="${esc(m.key)}">${esc(m.pending ? SAVED_PENDING : TAKES_EFFECT)}</div>${extra}${def}</div>`;
  }
  function readOnlyRowHtml(m) {
    const secretNote = extraLines(m).map((t) => `<div class="st-hint" style="flex-basis:100%" data-extra="${esc(m.key)}">${esc(t)}</div>`).join('');
    return `<div class="st-row" style="flex-wrap:wrap;row-gap:4px" data-readonly="${esc(m.key)}"${info(m)}>${rowHead(m)}<span class="st-value" id="st-ro-${esc(m.key)}">${esc(m.shown)}</span>${secretNote}` +
      (m.help ? `<div class="st-hint" style="flex-basis:100%">${esc(m.help)}</div>` : '') +
      `<div class="st-hint" style="flex-basis:100%">${esc(m.where)}</div></div>`;
  }
  const blockHtml = (id, title, body) => `<div class="st-sub" data-block="${id}"><div class="st-sub-title">${esc(title)}</div>${body}</div>`;
  /** The three blocks. Empty blocks are left out. */
  function expertHtml(mod) {
    const parts = [];
    if (mod.expert.length) parts.push(blockHtml('expert', 'Expert values', mod.expert.map(expertRowHtml).join('')));
    if (mod.file.length) parts.push(blockHtml('file', 'Set in the .env file', mod.file.map(readOnlyRowHtml).join('')));
    if (mod.protectedRows.length) parts.push(blockHtml('protected', 'Protected settings', mod.protectedRows.map(readOnlyRowHtml).join('')));
    return parts.join('');
  }
  function memoryHtml(m) {
    return `<div class="st-row" style="flex-wrap:wrap;row-gap:4px" data-memory-limit${m.id ? ` data-setting="${esc(m.id)}"` : ''}><label>${esc(m.name)}</label>` +
      `<input type="number" inputmode="decimal" id="st-mem-limit-in" data-memin min="0" max="4096" step="1" value="${esc(m.value)}" placeholder="Automatic" style="width:9em"> <span class="st-hint">GB, 0 = off</span> ` +
      `<button class="st-test-btn" data-act="mem-save">Save</button> <button class="st-test-btn" data-act="mem-default">Use default</button>` +
      `<div class="st-hint" style="flex-basis:100%" data-memstate>${esc('Now: ' + m.shown + '. Default: automatic, a quarter of this computer\'s memory, at least 4 GB and at most 64 GB.')}</div></div>`;
  }

  // ── page ──────────────────────────────────────────────────────────────────────────────────────────────
  const say = (o, text) => { try { if (o && typeof o.toast === 'function') o.toast(text); } catch { /* no toast */ } };
  const reason = (e) => String((e && e.message) || e || 'Could not save.');
  const fieldOf = (host, attr, key) => host.querySelector(`[${attr}="${key}"]`);
  async function getJson(fetchJson, url) {
    const j = await fetchJson(url);
    if (j && j.error) throw new Error(j.error);
    return j;
  }
  async function getSettings(o) {
    if (o.settings && typeof o.settings === 'object') return o.settings;
    try { return await getJson(o.fetchJson, '/api/settings'); } catch { return null; }
  }

  async function render(host, o) {
    o = o || {};
    if (!host) return null;
    try { registerReview(typeof window !== 'undefined' ? window.hubReview : null, o.fetchJson); } catch { /* review is optional */ }
    let rows;
    try { rows = (await getJson(o.fetchJson, '/api/settings/env')).rows; }
    catch (e) { host.innerHTML = `<div class="st-hint">${esc('Could not read the expert values: ' + reason(e))}</div>`; return null; }
    const settings = await getSettings(o);
    let state = Array.isArray(rows) ? rows : [];
    const fieldsIn = (el) => (el && typeof el.querySelectorAll === 'function' ? [...el.querySelectorAll('input, select, textarea')] : []);
    const loaded = (fields) => { try { if (typeof o.loaded === 'function') o.loaded(host, fields); } catch { /* no guard */ } };
    // The first draw: every row shows what the hub holds, so the page's dialog guard takes all of it as saved (o.loaded).
    // shown[key]: the value each row last showed; a save sends it as expect, so a change made elsewhere since this row was drawn
    // is refused instead of overwritten (state may be newer than a row: a read-back refreshes it all, only the saved row is redrawn)
    const shown = {};
    const remember = (rowsNow, only) => { for (const x of rowsNow) if (!only || x.key === only) shown[x.key] = x.value != null ? String(x.value) : null; };
    const draw = () => { host.innerHTML = expertHtml(models(state, o.records, settings)); remember(state); loaded(fieldsIn(host)); };
    draw();
    if (host.__expertBound) { host.__expertState = () => state; host.__expertDraw = draw; return state; }
    host.__expertBound = true;
    host.__expertState = () => state; host.__expertDraw = draw;
    const busy = {};
    host.addEventListener('click', async (ev) => {
      const t = ev && ev.target && ev.target.closest ? ev.target.closest('[data-act]') : ev && ev.target;
      const act = t && t.getAttribute && t.getAttribute('data-act');
      if (act !== 'save' && act !== 'default') return;
      const key = t.getAttribute('data-key');
      const m = models(state, o.records, settings).expert.find((x) => x.key === key);
      if (!m) return;
      if (busy[key]) return say(o, `${m.name}: still saving\u2026`);
      const input = fieldOf(host, 'data-envin', key);
      const value = act === 'default' ? '' : String(input && input.value != null ? input.value : '').trim();
      const bad = checkValue(m, value);
      if (bad) return say(o, bad);
      // While it saves, this row's controls are locked (no edit to it can be lost under the answer); afterwards only this row is
      // replaced by what the hub holds. Every other row keeps its own fields untouched, a value typed there included, so the
      // dialog guard still knows about it.
      const rowEl = typeof host.querySelector === 'function' ? host.querySelector(`[data-expert="${key}"]`) : null;
      const ctls = rowEl && typeof rowEl.querySelectorAll === 'function' ? [...rowEl.querySelectorAll('input, select, button')] : [];
      const doc = typeof document !== 'undefined' ? document : null;
      const hadFocus = !!(doc && rowEl && typeof rowEl.contains === 'function' && rowEl.contains(doc.activeElement));
      busy[key] = true;
      for (const c of ctls) c.disabled = true;
      if (rowEl && rowEl.setAttribute) rowEl.setAttribute('aria-busy', 'true');
      let replaced = false, unknown = false;
      try {
        // no answer within the limits: the row is unlocked again and the words say what is not known
        // (a request given up on is aborted, and the timer is cleared when the answer comes)
        const limit = (start, ms, words) => {
          const ac = typeof AbortController === 'function' ? new AbortController() : null;
          let t = null;
          return Promise.race([start(ac ? ac.signal : undefined), new Promise((_, no) => { t = setTimeout(() => { try { if (ac) ac.abort(); } catch { /* gone */ } no(new Error(words)); }, ms); })])
            .finally(() => clearTimeout(t));
        };
        // expect: the value this row showed; a save that reaches the hub after the value changed (this one, late, or another
        // admin's) is refused there instead of overwriting the newer value
        const expect = Object.prototype.hasOwnProperty.call(shown, key) ? shown[key] : null;
        const r = await limit((signal) => o.fetchJson('/api/settings/env', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value, expect }), signal }),
          o.saveMs || 20000, 'Your Maestro did not answer in time, so this may or may not be saved. Open Settings again to see.');
        if (r && r.error) throw new Error(r.error);
        // read the rows back: "waiting for a restart" is the hub's to say (a value put back to what it started with is not waiting)
        let fresh = null;
        try { fresh = (await limit((signal) => getJson((u, op) => o.fetchJson(u, Object.assign({}, op || {}, { signal })), '/api/settings/env'), o.readBackMs || 8000, 'no answer')).rows; } catch { fresh = null; }
        unknown = !Array.isArray(fresh);
        state = !unknown ? fresh : state.map((x) => (x.key === key ? Object.assign({}, x, { value: value === '' ? null : value, set: value !== '', pending: false }) : x));
        const fm = models(state, o.records, settings).expert.find((x) => x.key === key);
        if (fm && rowEl && rowEl.parentNode && typeof rowEl.insertAdjacentHTML === 'function') {
          rowEl.insertAdjacentHTML('afterend', expertRowHtml(fm));
          remember(state, key);
          const nu = rowEl.nextElementSibling;
          rowEl.remove();
          replaced = true;
          loaded(fieldsIn(nu));
          if (hadFocus && nu && (!doc.activeElement || doc.activeElement === doc.body)) {
            const b = nu.querySelector(`[data-act="${act}"]`) || nu.querySelector('[data-envin]');
            if (b && !b.hidden && typeof b.focus === 'function') b.focus();
          }
        }
        const now = state.find((x) => x.key === key);
        say(o, unknown ? 'Saved, but your Maestro could not be asked whether it waits for a restart.' : now && !now.pending ? 'Saved. It is what your Maestro uses now.' : 'Saved. Restart your Maestro to use it.');
        try { if (typeof window !== 'undefined' && window.hubReview && window.hubReview.refresh) window.hubReview.refresh(); } catch { /* optional */ }
      } catch (e) { say(o, reason(e)); }
      finally {
        delete busy[key];
        if (!replaced) { for (const c of ctls) c.disabled = false; if (rowEl && rowEl.removeAttribute) rowEl.removeAttribute('aria-busy'); }
      }
    });
    return state;
  }

  async function renderMemoryLimit(host, o) {
    o = o || {};
    if (!host) return null;
    let m = memoryModel(await getSettings(o), o.records);
    const loaded = () => { try { if (typeof o.loaded === 'function') o.loaded(host); } catch { /* no guard */ } };
    host.innerHTML = memoryHtml(m);
    loaded();
    if (host.__memBound) return m;
    host.__memBound = true;
    host.addEventListener('click', async (ev) => {
      const t = ev && ev.target && ev.target.closest ? ev.target.closest('[data-act]') : ev && ev.target;
      const act = t && t.getAttribute && t.getAttribute('data-act');
      if (act !== 'mem-save' && act !== 'mem-default') return;
      const input = host.querySelector('[data-memin]');
      const p = memoryPayload(act === 'mem-default' ? '' : (input && input.value));
      if (p.error) return say(o, p.error);
      try {
        const r = await o.fetchJson('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p.body) });
        if (r && r.error) throw new Error(r.error);
        m = memoryModel(p.body, o.records);
        host.innerHTML = memoryHtml(m);
        loaded();
        say(o, 'Saved.');
      } catch (e) { say(o, reason(e)); }
    });
    return m;
  }

  return { TAKES_EFFECT, SAVED_PENDING, FILE_HELP, SCREEN_HELP, KEYS, DANGER_SETTINGS, REVIEW_ID, recordOf, rowModel, settingsModels, models, formatValue, pendingText, pendingCount, reviewItem, reviewSource, registerReview, checkValue, safeUrl, memoryModel, memoryPayload, expertHtml, memoryHtml, render, renderMemoryLimit };
});
