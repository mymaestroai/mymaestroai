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
 *     snooze = { suggestionId: untilMs } (this browser's 'hub-review-snooze', see readSnooze); securityDismissed is no longer used
 *   -> { problems: [{ id, tier: 'fix'|'worth'|'suggest', level: 'critical'|'warn', title, text, fix?: { label, href?|api?, method?, kind? }, detailsSection,
 *          snoozed?, snoozedUntil? }]  (all of them, fix first), fix / worth / suggestions / snoozedSuggestions (the same items by tier),
 *        features: [{ id, title, text, snoozed, snoozedUntil? }], count = the 'fix' items only, worst: 'critical' when any fix else 'none', notes: [string] }
 *   Tiers (P4-14): 'fix' = Red "Fix now" (agents cannot answer or data is exposed today), 'worth' = Amber "Worth doing" (hardening), 'suggest' =
 *   Grey "Suggestions" (advice, each can be snoozed a week). Only 'fix' counts, colours the gear and makes the one banner (bannerOf).
 *   load(fetchFn, { accounts }) -> Promise of build()'s input (every read fails on its own; a failed one is listed in `failed`)
 *   register(source) -> true; source = { id, load(fetchFn) -> Promise<{ problems?: [], features?: [] }> } (same item shapes as build(); a problem
 *     without a tier is 'worth';
 *     loadSources(fetchFn) asks each one, a failing one is { id, failed: true }; merge(build(...), answers) adds them to build()'s
 *     result and adds a note "Could not check <id>." for a failed one). Exported on window.hubReview.
 *   summaryText(r) -> "3 to fix · 10 suggestions · 12 new features" ("Nothing to fix" first when no red item)
 *   gearLabel(r) -> "Settings, 3 things to fix" (just "Settings" when count is 0)
 *   badgeKind(r) -> 'critical' (red) when count > 0, else ''
 *   bannerOf(r) -> { text, title, more, fix, count } for the one banner, or null when nothing needs fixing
 *   readSnooze(storage, now) / snoozeSuggestion(storage, id, now): this browser's snooze of suggestions (7 days), key 'hub-review-snooze'
 *   decisionLine(decision, snoozedUntil, locale) -> "Turned on." | "Left off." | "I'll ask again on <date>."
 *   askedAgainLine(ms, locale) -> "I'll ask again on <date>."
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

  // ── Tiers (P4-14). Every problem is one of: 'fix' (Red, "Fix now": agents cannot answer or data is exposed today), 'worth'
  // (Amber, "Worth doing": hardening) or 'suggest' (Grey, "Suggestions": advice). Only 'fix' counts and only 'fix' makes the banner.
  const TIERS = ['fix', 'worth', 'suggest'];
  const SNOOZE_KEY = 'hub-review-snooze';   // this browser: suggestion id -> ms until it is asked again
  const TWO_FACTOR = new Set(['totp', 'admin-2fa-optional', 'member-totp']);   // hardening, even when the hub is reachable (the 'bind' item says the exposure)
  const READY_ADVICE = new Set(['search', 'push-devices', 'supervisor', 'browser-render']);   // setup advice: a warn here is a suggestion
  /** Which tier a checklist, health or security item belongs to, or '' when it is not listed (ok and info items). src: ready | health | sec. */
  function tierFor(src, rawId, lvl) {
    const id = String(rawId || '');
    if (src === 'health') {
      if (id === 'health-backups' && lvl === 'info') return 'suggest';   // nightly backups are off: advice
      return lvl === 'critical' ? 'fix' : lvl === 'warn' ? 'worth' : '';
    }
    if (!level(lvl)) return '';
    if (lvl === 'critical') return 'fix';   // a critical item is always Fix now (two-factor and setup advice too); only a warning can be hardening or advice
    if (TWO_FACTOR.has(id)) return 'worth';
    if (src === 'ready' && READY_ADVICE.has(id)) return 'suggest';
    return 'worth';
  }
  const tierOk = (t) => (TIERS.includes(t) ? t : '');
  const tierRank = (p) => TIERS.indexOf(p.tier);

  /** The security warn items' key: what SEC_DISMISS_KEY stored (the sorted ids joined). Kept for an old stored value; warnings no longer hide behind it. */
  function securityWarnKey(items) { return (items || []).map((i) => i.id).sort().join(','); }

  /** What this browser stored under SNOOZE_KEY, as { id: until } without what has already passed. storage = anything with getItem. */
  function readSnooze(storage, now) {
    const t = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    let raw = null;
    try { raw = JSON.parse(storage && storage.getItem ? storage.getItem(SNOOZE_KEY) || 'null' : 'null'); } catch (e) { raw = null; }
    const out = {};
    if (raw && typeof raw === 'object') for (const k of Object.keys(raw)) if (Number(raw[k]) > t) out[k] = Number(raw[k]);
    return out;
  }
  /** "Ask me in a week" for a suggestion: stores id -> now + 7 days (expired ones are dropped on the way). Returns the time it is asked again. */
  function snoozeSuggestion(storage, id, now) {
    const t = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const all = readSnooze(storage, t);
    all[String(id)] = t + SNOOZE_MS;
    try { storage.setItem(SNOOZE_KEY, JSON.stringify(all)); } catch (e) { /* blocked storage: it is asked again next time */ }
    return all[String(id)];
  }

  /** Sorts the problems by tier and works out everything the pages read: fix / worth / suggestions / snoozed, count (fix only), worst. */
  function finish(problems, features, notes, snooze, now) {
    const sn = snooze || {};
    const list = problems.map((p) => {
      const until = Number(sn[p.id]);
      return p.tier === 'suggest' && Number.isFinite(until) && until > now ? { ...p, snoozed: true, snoozedUntil: until } : p;
    });
    const order = new Map(list.map((p, i) => [p, i]));
    list.sort((a, c) => (tierRank(a) - tierRank(c)) || (a.level === c.level ? 0 : a.level === 'critical' ? -1 : 1) || order.get(a) - order.get(c));
    const fix = list.filter((p) => p.tier === 'fix');
    return {
      problems: list, fix, worth: list.filter((p) => p.tier === 'worth'),
      suggestions: list.filter((p) => p.tier === 'suggest' && !p.snoozed), snoozedSuggestions: list.filter((p) => p.tier === 'suggest' && p.snoozed),
      features, count: fix.length, worst: fix.length ? 'critical' : 'none', notes, snooze: sn, now,
    };
  }

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
      add({ id: 'accounts', tier: 'fix', level: 'critical', title: 'This hub has no login yet',
        text: 'Anyone who can reach it has full control until an admin account exists.',
        fix: { label: 'Create the admin account', href: '/welcome' }, detailsSection: 'st-ready-section' });
    }
    // no AI provider
    if (o.setup && o.setup.setupNeeded === true) {
      add({ id: 'provider', tier: 'fix', level: 'critical', title: 'No AI provider is connected',
        text: 'Agents cannot answer until a Claude or ChatGPT subscription, an API key or a local model is connected.',
        fix: { label: 'Open the Welcome page', href: '/welcome' }, detailsSection: 'st-ready-section' });
    }
    // setup checklist. The provider and health-* rows may repeat what their own source says (setup/status for the provider, system-health
    // for health-*): every candidate is listed here and one per condition is kept at the end (dedupe: fresh beats stale, then the higher severity).
    for (const i of (o.readiness && o.readiness.items) || []) {
      if (!i) continue;
      const id = String(i.id || ''), tier = tierFor('ready', id, i.level);
      if (!tier || id === 'accounts') continue;
      add({ id: 'ready:' + id, tier, level: level(i.level), title: clean(i.title), text: oneLine(i.detail || i.fix), fix: fixOf(i.action), detailsSection: 'st-ready-section' });
    }
    // health
    for (const i of (o.health && o.health.items) || []) {
      if (!i) continue;
      const tier = tierFor('health', i.id, i.level);
      if (!tier) continue;
      const p = { id: 'health:' + String(i.id || ''), tier, level: level(i.level) || 'warn', title: clean(i.title), text: oneLine(i.detail || i.fix), detailsSection: 'st-health-section' };
      if (i.action === 'claude-signin') p.fix = { label: 'Sign in again', kind: 'claude-signin' };
      else if (i.action && typeof i.action === 'object') { const f = fixOf(i.action); if (f) p.fix = f; }
      add(p);
    }
    // security (no-accounts has its own line). A warning is "Worth doing" and never hides behind a dismissal: it does not count, so it needs none.
    for (const i of (o.security && o.security.items) || []) {
      if (!i || i.id === 'accounts') continue;
      const tier = tierFor('sec', i.id, i.level);
      if (!tier) continue;
      add({ id: 'sec:' + String(i.id || ''), tier, level: level(i.level), title: clean(i.title), text: oneLine(i.detail || i.fix), fix: fixOf(i.action), detailsSection: 'st-sec-section' });
    }
    // backups (what GET /api/backups says). A paused restore needs the owner whatever the key says; the others only count once backups are set up.
    const b = o.backups;
    if (b) {
      const rec = b.recovery, ni = b.nightly || {};
      if (rec && !rec.resumedAt) add({ id: 'backup:paused', tier: 'fix', level: 'critical', title: 'Agents are paused after a restore', text: `Agents and schedules start no new work until you press Resume${Array.isArray(rec.held) && rec.held.length ? `; ${plural(rec.held.length, 'item waits', 'items wait')} for Run or Skip` : ''}.`, fix: { label: 'Resume', api: '/api/backups/recovery/resume', method: 'POST' }, detailsSection: 'st-backups-section' });
      if (b.key && b.key.configured) {
        if (b.needsPassword) add({ id: 'backup:password', tier: 'worth', level: 'warn', title: 'Choose a new backup password', text: 'This setup was restored with the recovery key; a new password is needed before the next backup.', detailsSection: 'st-backups-section' });
        if (b.lastError && !b.running) add({ id: 'backup:failed', tier: 'worth', level: 'warn', title: 'The last backup failed', text: oneLine(b.lastError.message) || 'Open the backups to see why.', detailsSection: 'st-backups-section' });
        else if (ni.lastError && !b.running) add({ id: 'backup:nightly', tier: 'worth', level: 'warn', title: 'The nightly backup failed', text: oneLine(ni.lastError.message) || 'Open the backups to see why.', detailsSection: 'st-backups-section' });
      } else if (b.key && b.key.configured === false) {
        add({ id: 'backup:off', tier: 'suggest', level: 'warn', title: 'Backups are not set up', text: 'Without a backup, a lost disk loses your agents, chats and settings.', detailsSection: 'st-backups-section' });
      }
    }

    // new features waiting for a yes or no
    const features = [];
    for (const c of (o.changes && o.changes.changes) || []) {
      if (!c || c.state !== 'pending') continue;
      const until = untilMs(c.snoozedUntil);   // the hub's ISO date string (a number from old data) -> ms
      const snoozed = Number.isFinite(until) && until > now;
      features.push({ id: String(c.id), title: clean(c.title || c.id), text: oneLine(c.changes || c.summary || c.text), snoozed, ...(snoozed ? { snoozedUntil: until } : {}) });
    }

    // A read that failed keeps what the last good result said about it, marked stale, so the banner, the gear and Fix now do not drop for a
    // network blip. With no earlier result (first read) there is nothing to keep: only the note below.
    for (const k of o.failed || []) {
      const mine = STALE_OF[k];
      if (!mine) continue;
      for (const p of carried(o.previous, (x) => mine(String(x.id || '')))) if (!problems.some((q) => q.id === p.id)) problems.push(p);
    }

    const notes = (o.failed || []).map((k) => `Could not check ${WHAT[k] || clean(k)}.`);
    return finish(dedupe(problems), features, notes, o.snooze, now);
  }

  /** The condition an item speaks about: the provider, a health-<x> check (from the health read or the checklist), else the item itself. */
  function conditionOf(p) {
    const id = String(p.id || '');
    if (id === 'provider' || id === 'ready:provider') return 'provider';
    if (CLAUDE_SIGNIN.has(id)) return 'claude-signin';   // three producers, one condition: the Claude client is signed out
    if (id.startsWith('health:health-')) return id.slice(7);
    if (id.startsWith('ready:health-')) return id.slice(6);
    if (id === 'ready:totp' || id === 'sec:totp') return 'two-factor-admins';   // checklist and security check both say it
    return id;
  }
  const CLAUDE_SIGNIN = new Set(['ready:claude-signin', 'health:health-signin-claude', 'health:health-claude-signedout']);
  /** How many agents a Claude sign-in item names ("3 agents use the Claude client…", "…3 agents can't answer", old "3 agent(s)"), or 0. */
  function agentsIn(p) { const m = /(\d+)\s+agent/i.exec(String(p.title || '')); return m ? Number(m[1]) : 0; }
  /** One item per condition: a fresh item beats a stale one; between two of the same freshness the higher severity (tier, then critical over warn);
   *  a tie goes to the condition's own source (provider / health:*) and then the first listed. Order of the survivors is kept. */
  function dedupe(problems) {
    const score = (p) => (p.stale ? 0 : 1000) + (2 - Math.max(0, tierRank(p))) * 100 + (p.level === 'critical' ? 10 : 0) + (/^ready:/.test(String(p.id)) ? 0 : 1);
    const best = new Map();
    for (const p of problems) {
      const k = conditionOf(p), cur = best.get(k);
      if (!cur || score(p) > score(cur)) best.set(k, p);
    }
    const kept = problems.filter((p) => best.get(conditionOf(p)) === p);
    // The survivor keeps the most severe tier/level (it won on them) and borrows the useful fix and text of what it replaced; the Claude
    // sign-in problem says how many agents cannot answer (the largest count any of the three named) with the Sign in again fix.
    return kept.map((p) => {
      const k = conditionOf(p), group = problems.filter((q) => conditionOf(q) === k);
      if (group.length < 2) return p;
      const out = { ...p };
      const withFix = (k === 'claude-signin' && group.find((q) => q.fix && q.fix.kind === 'claude-signin')) || group.find((q) => q.fix);
      if (withFix) out.fix = withFix.fix;
      if (!out.text) { const t = group.find((q) => q.text); if (t) out.text = t.text; }
      if (k === 'claude-signin') {
        const n = Math.max(0, ...group.map(agentsIn));
        out.title = n ? `Claude is not signed in: ${plural(n, 'agent', 'agents')} can't answer` : 'Claude is signed out on this computer: agents on Claude can\'t answer';
        const t = group.find((q) => q.id === 'health:health-claude-signedout' && q.text) || group.find((q) => q.text);
        if (t) out.text = t.text;
      }
      return out;
    });
  }

  // Which of the last result's items each read is the source of (by id).
  const STALE_OF = {
    readiness: (id) => id.startsWith('ready:'), health: (id) => id.startsWith('health:'), security: (id) => id.startsWith('sec:'),
    backups: (id) => id.startsWith('backup:'), setup: (id) => id === 'provider',
  };
  const STALE_LINE = 'Could not check just now; this was the last result.';
  /** The items of an earlier result that pass `keep`, as stale copies (not snoozed: finish() works that out again). */
  function carried(previous, keep) {
    const out = [];
    for (const p of (previous && Array.isArray(previous.problems) ? previous.problems : [])) {
      if (!p || !keep(p)) continue;
      const { snoozed, snoozedUntil, ...rest } = p;
      out.push(p.stale ? rest : { ...rest, stale: true, staleSince: Number(previous.now) || undefined, text: rest.text ? `${rest.text} ${STALE_LINE}` : STALE_LINE });
    }
    return out;
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
  function merge(result, answers, previous) {
    const problems = [...result.problems], features = [...result.features], notes = [...result.notes];
    for (const a of answers || []) {
      if (!a) continue;
      if (a.failed) {
        notes.push(`Could not check ${clean(a.id)}.`);
        // what this source said last time stays, marked stale (items carry `source` from the read that listed them)
        const have = new Set(problems.map((q) => q.id));
        for (const p of carried(previous, (x) => x.source === a.id)) if (!have.has(p.id)) problems.push(p);
        continue;
      }
      for (const p of a.problems || []) {
        if (!p || !clean(p.title)) continue;
        // a source's problem is "Worth doing" unless it says otherwise (tier: 'fix' | 'worth' | 'suggest')
        problems.push({ ...p, id: String(p.id || `${a.id}:${problems.length}`), source: a.id, tier: tierOk(p.tier) || (p.level === 'critical' ? 'fix' : 'worth'), level: level(p.level) || 'warn', title: clean(p.title), text: clean(p.text) });
      }
      for (const f of a.features || []) {
        if (!f || !clean(f.title || f.id)) continue;
        features.push({ ...f, id: String(f.id || `${a.id}:${features.length}`), title: clean(f.title || f.id), text: clean(f.text), snoozed: !!f.snoozed });
      }
    }
    return finish(problems, features, notes, result.snooze, Number.isFinite(Number(result.now)) ? Number(result.now) : Date.now());
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  /** "3 to fix · 10 suggestions · 12 new features"; "Nothing to fix" first when no red item. Worth-doing items are not in the line. */
  function summaryText(r) {
    if (!r) return '';
    const feats = r.features.filter((f) => !f.snoozed).length, sugg = (r.suggestions || []).length;
    // no red item but a check failed: "Nothing to fix" would be a claim nobody checked
    const parts = [r.count > 0 ? `${r.count} to fix` : (r.notes || []).length ? 'Could not check everything' : 'Nothing to fix'];
    if (sugg) parts.push(plural(sugg, 'suggestion', 'suggestions'));
    if (feats) parts.push(plural(feats, 'new feature', 'new features'));
    return parts.join(' · ');
  }
  function gearLabel(r) {
    return r && r.count > 0 ? `Settings, ${r.count} ${r.count === 1 ? 'thing' : 'things'} to fix` : 'Settings';
  }
  /** The colour of the count: 'critical' (red) when something needs fixing, else '' (no count). Features, worth-doing items and suggestions never count. */
  function badgeKind(r) {
    return r && r.count > 0 ? 'critical' : '';
  }
  /** The one banner (P4-15): { text, fix, count } for the first thing to fix, or null when nothing is. "<title> (and N more to fix). Open For your review" */
  function bannerOf(r) {
    const list = r && r.fix ? r.fix : [];
    if (!list.length) return null;
    const first = list[0], more = list.length - 1;
    return { id: first.id, title: first.title, more, text: `${first.title}${more > 0 ? ` (and ${more} more to fix)` : ''}. Open For your review`, fix: first.fix || null, count: list.length };
  }
  function dateText(ms, locale) {
    try { return new Date(ms).toLocaleDateString(locale || undefined, { month: 'long', day: 'numeric' }); } catch (e) { return new Date(ms).toDateString(); }
  }
  /** A snooze date as the hub keeps it (ISO string; a number is old data) -> ms, NaN when it is neither. */
  function untilMs(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v) return Date.parse(v);
    return NaN;
  }
  function decisionLine(decision, snoozedUntil, locale) {
    if (decision === 'on') return 'Turned on.';
    if (decision === 'off') return 'Left off.';
    if (decision === 'snooze') { const ms = untilMs(snoozedUntil); return Number.isFinite(ms) ? `I'll ask again on ${dateText(ms, locale)}.` : "I'll ask again in a week."; }
    return '';
  }
  const askedAgainLine = (when, locale) => `I'll ask again on ${dateText(untilMs(when), locale)}.`;   // one wording for the snooze everywhere

  return { SNOOZE_MS, SNOOZE_KEY, TIERS, ROUTES, build, load, register, unregister, loadSources, merge, summaryText, gearLabel, badgeKind, bannerOf, readSnooze, snoozeSuggestion, decisionLine, askedAgainLine, securityWarnKey, oneLine };
});
