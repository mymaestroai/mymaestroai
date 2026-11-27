/**
 * ui-review.js — "For your review" and the count on the gear (pure; no DOM, no fetch in build).
 *
 * One place says what needs the owner's attention: problems (setup, health, security, no AI provider, no login, backups) and
 * new features waiting for a yes or no (behaviour changes). The Settings group "For your review" lists them and the gear (desktop)
 * and the ⋮ menu (phone) show how many. Loaded by index.html and mobile.html before app.js / mobile.js. Node (tests): module.exports.
 *
 *   build({ readiness, health, security, setup, accounts, backups, changes, now, securityDismissed, failed })
 *     readiness / health / security / setup / backups / changes = the JSON answers of GET /api/readiness, /api/system-health,
 *       /api/security-check, /api/setup/status, /api/backups, /api/behaviour-changes (null or missing = not read)
 *     accounts = { none: true } when this hub has no login yet (what the page already knows), else anything else
 *     now = ms since epoch (default Date.now()); securityDismissed = what this browser stored under SEC_DISMISS_KEY
 *     failed = labels of reads that failed (load() gives them): each becomes a note "Could not check <what>."
 *   -> { problems: [{ id, level: 'critical'|'warn', title, text, fix?: { label, href?|api?, method?, kind? }, detailsSection }],
 *        features: [{ id, title, text, snoozed, snoozedUntil? }], count, worst: 'critical'|'warn'|'none', notes: [string] }
 *   load(fetchFn, { accounts }) -> Promise of build()'s input (every read fails on its own; a failed one is listed in `failed`)
 *   register(source) -> true; source = { id, load(fetchFn) -> Promise<{ problems?: [], features?: [] }> } (same item shapes as build();
 *     loadSources(fetchFn) asks each one, a failing one is { id, failed: true }; merge(build(...), answers) adds them to build()'s
 *     result and adds a note "Could not check <id>." for a failed one). Exported on window.hubReview.
 *   summaryText(r) -> "2 problems · 1 new feature" or "Nothing waiting"
 *   gearLabel(r) -> "Settings, 3 things for your review" (just "Settings" when count is 0)
 *   badgeKind(r) -> 'critical' | 'warn' | 'info' (the colour of the count; features alone are neutral) or '' when count is 0
 *   decisionLine(decision, snoozedUntil, locale) -> "Turned on." | "Left off." | "We'll ask again on <date>."
 *   askedAgainLine(ms, locale) -> "Asked again on <date>"
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.hubReview = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

  // What each read is called in "Could not check <what>."
  const WHAT = {
    readiness: 'the setup checklist', health: 'the health check', security: 'the security check',
    setup: 'whether an AI provider is connected', backups: 'the backups', changes: 'the new features waiting',
  };
  const ROUTES = {
    readiness: '/api/readiness', health: '/api/system-health', security: '/api/security-check',
    setup: '/api/setup/status', backups: '/api/backups', changes: '/api/behaviour-changes',
  };

  const clean = (s) => String(s == null ? '' : s).replace(/`/g, '').replace(/\s+/g, ' ').trim();
  /** The first sentence of a longer text (at most max characters), for one plain line. */
  function oneLine(s, max) {
    s = clean(s);
    if (!s) return '';
    const m = s.match(/^.*?[.!?](?=\s|$)/);
    let out = m ? m[0] : s;
    max = max || 160;
    if (out.length > max) out = out.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
    return out;
  }
  const level = (l) => (l === 'critical' ? 'critical' : l === 'warn' ? 'warn' : '');

  /** The security warn items' key: what SEC_DISMISS_KEY stores (the sorted ids joined). */
  function securityWarnKey(items) { return (items || []).map((i) => i.id).sort().join(','); }

  function fixOf(action) {
    if (!action || typeof action !== 'object' || !action.label) return undefined;
    if (action.href) return { label: String(action.label), href: String(action.href) };
    if (action.api) return { label: String(action.label), api: String(action.api), method: String(action.method || 'POST') };
    return undefined;
  }

  function build(input) {
    const o = input || {};
    const now = Number.isFinite(Number(o.now)) ? Number(o.now) : Date.now();
    const problems = [];
    const add = (p) => problems.push(p);

    // no login at all
    if (o.accounts && o.accounts.none === true) {
      add({ id: 'accounts', level: 'critical', title: 'This hub has no login yet',
        text: 'Anyone who can reach it has full control until an admin account exists.',
        fix: { label: 'Create the admin account', href: '/welcome' }, detailsSection: 'st-ready-section' });
    }
    // no AI provider
    if (o.setup && o.setup.setupNeeded === true) {
      add({ id: 'provider', level: 'critical', title: 'No AI provider is connected',
        text: 'Agents cannot answer until a Claude or ChatGPT subscription, an API key or a local model is connected.',
        fix: { label: 'Open the Welcome page', href: '/welcome' }, detailsSection: 'st-ready-section' });
    }
    // setup checklist (the items the other rules below already cover are left out)
    for (const i of (o.readiness && o.readiness.items) || []) {
      if (!i || !level(i.level)) continue;
      const id = String(i.id || '');
      if (id === 'accounts' || id === 'provider' || id.startsWith('health-')) continue;
      add({ id: 'ready:' + id, level: level(i.level), title: clean(i.title), text: oneLine(i.detail || i.fix), fix: fixOf(i.action), detailsSection: 'st-ready-section' });
    }
    // health
    for (const i of (o.health && o.health.items) || []) {
      if (!i || !level(i.level)) continue;
      const p = { id: 'health:' + String(i.id || ''), level: level(i.level), title: clean(i.title), text: oneLine(i.detail || i.fix), detailsSection: 'st-health-section' };
      if (i.action === 'claude-signin') p.fix = { label: 'Sign in again', kind: 'claude-signin' };
      else if (i.action && typeof i.action === 'object') { const f = fixOf(i.action); if (f) p.fix = f; }
      add(p);
    }
    // security (no-accounts has its own line; a warning set dismissed in this browser stops counting, a critical one never does)
    const secItems = ((o.security && o.security.items) || []).filter((i) => i && i.id !== 'accounts' && level(i.level));
    const warnKey = securityWarnKey(secItems.filter((i) => i.level === 'warn'));
    const dismissed = !!o.securityDismissed && String(o.securityDismissed) === warnKey;
    for (const i of secItems) {
      if (i.level === 'warn' && dismissed) continue;
      add({ id: 'sec:' + String(i.id || ''), level: level(i.level), title: clean(i.title), text: oneLine(i.detail || i.fix), fix: fixOf(i.action), detailsSection: 'st-sec-section' });
    }
    // backups (what GET /api/backups says; a hub with backups off is a choice, not a problem)
    const b = o.backups;
    if (b && b.key && b.key.configured) {
      const rec = b.recovery, ni = b.nightly || {};
      if (rec && !rec.resumedAt) add({ id: 'backup:paused', level: 'warn', title: 'Agents are paused after a restore', text: 'Agents and schedules start no new work until you press Resume.', fix: { label: 'Resume', api: '/api/backups/recovery/resume', method: 'POST' }, detailsSection: 'st-backups-section' });
      if (b.needsPassword) add({ id: 'backup:password', level: 'warn', title: 'Choose a new backup password', text: 'This setup was restored with the recovery key; a new password is needed before the next backup.', detailsSection: 'st-backups-section' });
      if (b.lastError && !b.running) add({ id: 'backup:failed', level: 'warn', title: 'The last backup failed', text: oneLine(b.lastError.message) || 'Open the backups to see why.', detailsSection: 'st-backups-section' });
      else if (ni.lastError && !b.running) add({ id: 'backup:nightly', level: 'warn', title: 'The nightly backup failed', text: oneLine(ni.lastError.message) || 'Open the backups to see why.', detailsSection: 'st-backups-section' });
    }
    problems.sort((a, c) => (a.level === c.level ? 0 : a.level === 'critical' ? -1 : 1));

    // new features waiting for a yes or no
    const features = [];
    for (const c of (o.changes && o.changes.changes) || []) {
      if (!c || c.state !== 'pending') continue;
      const until = Number(c.snoozedUntil);
      const snoozed = Number.isFinite(until) && until > now;
      features.push({ id: String(c.id), title: clean(c.title || c.id), text: oneLine(c.changes || c.summary || c.text), snoozed, ...(snoozed ? { snoozedUntil: until } : {}) });
    }

    const count = problems.length + features.filter((f) => !f.snoozed).length;
    const worst = problems.some((p) => p.level === 'critical') ? 'critical' : problems.length ? 'warn' : 'none';
    const notes = (o.failed || []).map((k) => `Could not check ${WHAT[k] || clean(k)}.`);
    return { problems, features, count, worst, notes };
  }

  /** Reads every answer build() needs; each read fails on its own (null in its place and its key in `failed`). */
  async function load(fetchFn, extra) {
    const out = { accounts: extra && extra.accounts, failed: [] };
    await Promise.all(Object.keys(ROUTES).map(async (k) => {
      try {
        const r = await fetchFn(ROUTES[k], { credentials: 'include' });
        if (!r || !r.ok) throw new Error('not ok');
        out[k] = await r.json();
        if (k === 'security' && (!out[k] || !Array.isArray(out[k].items))) throw new Error('no items');
      } catch (e) { out[k] = null; out.failed.push(k); }
    }));
    out.failed.sort();
    return out;
  }

  // ── Sources other modules plug in (a later module registers one; nothing here knows what it reports) ──
  const sources = [];
  /** register({ id, load(fetchFn) -> Promise<{ problems?: [], features?: [] }> }): same item shapes as build(); a source with the same id is replaced. */
  function register(source) {
    if (!source || typeof source.load !== 'function' || !clean(source.id)) return false;
    const id = clean(source.id), at = sources.findIndex((s) => s.id === id);
    const entry = { id, load: source.load };
    if (at >= 0) sources[at] = entry; else sources.push(entry);
    return true;
  }
  /** Takes a source out again (by id); true when there was one. */
  function unregister(id) {
    const at = sources.findIndex((s) => s.id === clean(id));
    if (at >= 0) sources.splice(at, 1);
    return at >= 0;
  }
  /** Asks every registered source (each on its own): [{ id, problems, features }] or [{ id, failed: true }]. */
  async function loadSources(fetchFn) {
    return Promise.all(sources.map(async (s) => {
      try {
        const r = await s.load(fetchFn);
        if (!r || typeof r !== 'object') throw new Error('no answer');
        return { id: s.id, problems: Array.isArray(r.problems) ? r.problems : [], features: Array.isArray(r.features) ? r.features : [] };
      } catch (e) { return { id: s.id, failed: true }; }
    }));
  }
  /** build()'s result plus what the sources said (from loadSources): problems and features added, count/worst recomputed, a failed source a note. */
  function merge(result, answers) {
    const r = { ...result, problems: [...result.problems], features: [...result.features], notes: [...result.notes] };
    for (const a of answers || []) {
      if (!a) continue;
      if (a.failed) { r.notes.push(`Could not check ${clean(a.id)}.`); continue; }
      for (const p of a.problems || []) {
        if (!p || !clean(p.title)) continue;
        r.problems.push({ ...p, id: String(p.id || `${a.id}:${r.problems.length}`), level: level(p.level) || 'warn', title: clean(p.title), text: clean(p.text) });
      }
      for (const f of a.features || []) {
        if (!f || !clean(f.title || f.id)) continue;
        r.features.push({ ...f, id: String(f.id || `${a.id}:${r.features.length}`), title: clean(f.title || f.id), text: clean(f.text), snoozed: !!f.snoozed });
      }
    }
    r.problems.sort((a, c) => (a.level === c.level ? 0 : a.level === 'critical' ? -1 : 1));
    r.count = r.problems.length + r.features.filter((f) => !f.snoozed).length;
    r.worst = r.problems.some((p) => p.level === 'critical') ? 'critical' : r.problems.length ? 'warn' : 'none';
    return r;
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  function summaryText(r) {
    if (!r) return '';
    const feats = r.features.filter((f) => !f.snoozed).length;
    const parts = [];
    if (r.problems.length) parts.push(plural(r.problems.length, 'problem', 'problems'));
    if (feats) parts.push(plural(feats, 'new feature', 'new features'));
    return parts.length ? parts.join(' · ') : 'Nothing waiting';
  }
  function gearLabel(r) {
    return r && r.count > 0 ? `Settings, ${r.count} ${r.count === 1 ? 'thing' : 'things'} for your review` : 'Settings';
  }
  function badgeKind(r) {
    if (!r || !(r.count > 0)) return '';
    return r.worst === 'critical' ? 'critical' : r.worst === 'warn' ? 'warn' : 'info';
  }
  function dateText(ms, locale) {
    try { return new Date(ms).toLocaleDateString(locale || undefined, { month: 'long', day: 'numeric' }); } catch (e) { return new Date(ms).toDateString(); }
  }
  function decisionLine(decision, snoozedUntil, locale) {
    if (decision === 'on') return 'Turned on.';
    if (decision === 'off') return 'Left off.';
    if (decision === 'later') return Number.isFinite(Number(snoozedUntil)) ? `We'll ask again on ${dateText(Number(snoozedUntil), locale)}.` : "We'll ask again in a week.";
    return '';
  }
  const askedAgainLine = (ms, locale) => `Asked again on ${dateText(ms, locale)}`;

  return { SNOOZE_MS, ROUTES, build, load, register, unregister, loadSources, merge, summaryText, gearLabel, badgeKind, decisionLine, askedAgainLine, securityWarnKey, oneLine };
});
