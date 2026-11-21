'use strict';
/**
 * ui-interjection.js - how a page reads an interjection back from the hub's saved history (GET /api/history/<agent>).
 * A message sent while the agent is mid-reply is saved the moment it is sent, as a user line marked `interjection`
 * ({ id, transport, priority? }) whose content is "[OPERATOR INTERJECTION]: <words>" (or "[EMERGENCY INTERJECTION]: ").
 * The pages draw it as the person's own bubble, with the words only, marked as an interjection (an emergency one keeps
 * a visible emergency marker). The pages carry byte-identical copies between the markers below (app.js, mobile.js);
 * test/ui-interjection.test.js proves the copies match and tests the behaviour here.
 *
 *   interjectionView(entry)  { text, emergency } for an interjection entry, null for any other entry
 */
// ── interjection helpers (begin) ──
function interjectionView(entry) {
  if (!entry || entry.role !== 'user' || !entry.interjection || typeof entry.content !== 'string') return null;
  const m = /^\[([^\]\n]*)\]: ?([\s\S]*)$/.exec(entry.content);
  const emergency = entry.interjection.priority === 'emergency' || (!!m && /^EMERGENCY/i.test(m[1]));
  return { text: m ? m[2] : entry.content, emergency };
}
// ── interjection helpers (end) ──

module.exports = { interjectionView };
