'use strict';
/**
 * ui-turn-reply.js — a turn's whole reply, read back from the hub's saved history (GET /api/history/<agent>), for a
 * page that lost the reply's live stream and re-attached to the turn (desktop and phone re-attach checks).
 * The pages carry byte-identical copies between the markers below (app.js, mobile.js); test/ui-turn-reply.test.js
 * proves the copies match and tests the behaviour here.
 *
 * A reply that asks a question is saved in pieces (lib/sdk-chat.js appendConversationLog): the text before the
 * question, then the text after the answer, with the question and the answer between them as entries marked `ask`.
 * A reply's first piece has no `base`; each later piece has `base` = the length of the reply saved before it. The
 * reply is its pieces joined, without the question lines. Taking the first assistant entry instead showed the
 * question as the reply. The reply ends at the person's next message, or at an assistant entry that does not
 * continue it: one without `base` begins another reply, and a `base` that does not match what is joined so far
 * does not belong to this one. (The hub's other way of saving, the whole reply again without `base`, happens only
 * when the text no longer starts with what was saved, so it can never be told apart from another reply; it ends
 * this one.)
 *
 *   turnReplyFrom(history, start, minTs)  the reply in history[start…] (start = just after the person's message);
 *                                           entries saved before minTs (ms, optional) are skipped
 *   turnReplySince(history, sinceTs)      the newest reply begun since sinceTs (ms), for a turn whose message the
 *                                           page cannot find (it began before the page loaded)
 * Both return the newest piece's entry with `content` set to the joined text (so inProgress and reasoning come from
 * the newest save), or null when no piece is saved yet.
 */
// ── turn-reply helpers (begin) ──
function turnReplyFrom(history, start, minTs) {
  let reply = null, content = '';
  for (let i = Math.max(0, start); i < history.length; i++) {
    const m = history[i];
    if (!m) continue;
    if (m.role === 'user' && !m.ask) break;                                  // the next turn
    if (m.role !== 'assistant' || m.ask || typeof m.content !== 'string') continue;
    if (minTs && m.ts && Date.parse(m.ts) < minTs) continue;
    if (!reply) { reply = m; content = m.content; continue; }                 // the reply's first piece
    if (m.base > 0 && m.base === content.length) { reply = m; content += m.content; continue; }   // the next piece
    break;                                                                    // another reply: not this turn's
  }
  return reply ? { ...reply, content } : null;
}
function turnReplySince(history, sinceTs) {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!m || (m.role === 'user' && !m.ask) || !m.ts || !(Date.parse(m.ts) >= sinceTs)) return null;
    if (m.role === 'assistant' && !m.ask && typeof m.content === 'string' && !(m.base > 0)) return turnReplyFrom(history, i, sinceTs);
  }
  return null;
}
// ── turn-reply helpers (end) ──

module.exports = { turnReplyFrom, turnReplySince };
