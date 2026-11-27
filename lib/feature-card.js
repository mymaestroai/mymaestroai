'use strict';
// The one card for features that arrive switched off (GET /api/behaviour-changes/card): the pending behaviour changes that are not
// snoozed, each in two short sentences with the lead's recommendation, plus one notice per quiet change that went on by itself.
// Pure data from lib/behaviour-changes and lib/behaviour-review's lead lookup; the route stays thin.
const bc = require('./behaviour-changes');

/** The first sentence of a text: up to the first ". " (or "." at the end), else the whole text, trimmed. '' for anything but text. */
function firstSentence(text) {
  if (typeof text !== 'string') return '';
  const t = text.trim();
  const m = /^[\s\S]*?(?:\.(?=\s)|\.$)/.exec(t);
  return (m ? m[0] : t).trim();
}

/** { lead, leadDisplay }: the install's lead agent (the one the review is scheduled for), or nulls. deps: leads(), agents, adminIds (tests). */
function leadOf(deps = {}) {
  let lead = null;
  try { lead = require('./behaviour-review').leadName(deps); } catch { lead = null; }
  if (!lead) return { lead: null, leadDisplay: null };
  let agents = deps.agents;
  if (!Array.isArray(agents)) { try { agents = require('./agents').getAgentsSync() || []; } catch { agents = []; } }
  const rec = agents.find((a) => a && a.name === lead);
  return { lead, leadDisplay: (rec && rec.display) || lead.charAt(0).toUpperCase() + lead.slice(1) };
}

/** The card's data. opts: stateFile, manifestFile, now (ms), deps (lead lookup). Unreadable state shows nothing. */
function cardState({ stateFile, manifestFile, now = Date.now(), deps = {}, isOwner = false } = {}) {
  const o = { ...(stateFile ? { stateFile } : {}), ...(manifestFile ? { manifestFile } : {}) };
  const all = bc.list(o);
  const { lead, leadDisplay } = leadOf(deps);
  if (all.some((c) => c.unreadable)) return { ok: true, show: false, lead, leadDisplay, entries: [], notices: [] };
  const raw = bc.readState(stateFile).entries;   // rev: the stored entry's journal phrase, what the hub compares inside its write lock
  const t = Number(now instanceof Date ? now.getTime() : now);
  const entries = all
    .filter((c) => c.state === 'pending' && !(c.snoozedUntil && Date.parse(c.snoozedUntil) > t))
    .map((c) => ({
      // summary: what turning it on does (the manifest's `on`), else the first sentence of `changes` (which can start with context
      // such as "Works together with ...", not with what the feature does)
      id: c.id, title: c.title || c.id, summary: firstSentence(c.on) || firstSentence(c.changes), cost: firstSentence(c.costs), leadMay: c.leadMay === true, canSwitch: c.leadMay === true || isOwner === true, rev: bc.revOf(raw[c.id]),
      recommendation: c.recommend === 'on' || c.recommend === 'off' ? { decision: c.recommend, why: c.recommendWhy || '' } : null,
    }));
  const notices = all
    .filter((c) => bc.isQuiet(c) && c.state === 'on' && c.by === 'quiet-update' && !c.noticeSeenAt)
    .map((c) => ({ id: c.id, title: c.title || c.id, line: firstSentence(c.on) || firstSentence(c.changes), rev: bc.revOf(raw[c.id]) }));
  return { ok: true, show: entries.length > 0 || notices.length > 0, lead, leadDisplay, entries, notices };
}

/** Titles of the entries the owner still has to decide (pending, not snoozed until later): the lead's brief. [] when the state is missing or unreadable. */
function waitingTitles(opts = {}) {
  const st = bc.readState(opts.stateFile);
  if (st.unreadable || st.missing) return [];
  return cardState({ ...opts, deps: opts.deps || {} }).entries.filter((e) => st.entries[e.id]).map((e) => e.title);
}

module.exports = { firstSentence, cardState, leadOf, waitingTitles };
