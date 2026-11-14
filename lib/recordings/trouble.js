'use strict';

// lib/recordings/trouble.js: the "Recording stopped" notice. When a recorded call's recording fails to start or stops mid-call, the
// users on that agent's allowed list get ONE web-push notice per call, on their own devices. One record per call id is shared by every
// way the trouble is found (the page's report, a start failure, a segment the store could not save), so a call never sends twice.
// The notice carries the agent's display name and a local time only; never audio, text or the consent line.

const { recordingsOf } = require('./settings');

const SEEN_CAP = 500;
const seen = new Set();   // "<agent>|<callId>"
function resetForTests() { seen.clear(); }

const REASONS = ['start_failed', 'upload_failed'];

/** The time of day (HH:MM) in the first admin's time zone, the hub's own zone. */
function clockText(ms) {
  try { const tz = require('../timezone'); return tz.localHm(tz.hubZone(), ms); } catch { return new Date(ms).toISOString().slice(11, 16); }
}

/**
 * notifyTrouble({ agent, callId, rec (the agent's record), now, push?, reason? ('start_failed' | 'upload_failed') }) -> Promise<{ ok: true, sent: boolean }>. Never throws.
 * sent is false when this call already had its notice (or there was nobody to tell).
 */
async function notifyTrouble({ agent, callId, rec, now = Date.now(), push, reason = 'start_failed' } = {}) {
  if (!REASONS.includes(reason)) reason = 'start_failed';
  const key = `${agent}|${callId}|${reason}`;   // once per call per reason
  if (seen.has(key)) return { ok: true, sent: false };
  seen.add(key);
  if (seen.size > SEEN_CAP) seen.delete(seen.values().next().value);
  try {
    const ids = recordingsOf(rec).allowed;
    if (!ids.length) return { ok: true, sent: false };
    const p = push || require('../push').getPush();
    const display = (rec && rec.display) || agent;
    await p.notifyUsers({
      title: reason === 'upload_failed' ? 'Recording delayed' : 'Not recording',
      body: reason === 'upload_failed'
        ? `${display}: part of the call at ${clockText(now)} could not be saved yet. Recording goes on, and the page keeps trying to send what it missed.`
        : `${display}: the call at ${clockText(now)} is not being recorded. The conversation text is still saved in the chat.`,
      tag: `rec-${agent}`,
    }, ids);
    return { ok: true, sent: true };
  } catch {
    return { ok: true, sent: false };
  }
}

module.exports = { notifyTrouble, resetForTests, REASONS };
