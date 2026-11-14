'use strict';
// The agent setting `recordings` (admin-only): whether calls with this agent are kept, who may open them, and how.
//   { keep: boolean, allowed: [user id], keepReplies: boolean, consentLine: string, mic: 'processed' | 'unprocessed',
//     announce: 'first' | 'every' | 'never' }   (announce: when the consent line is spoken: a person's first recorded call, every call, never)
// A record equal to all the defaults with an empty allowed list is "no setting": the field is removed.

const DEFAULT_CONSENT_LINE = 'This conversation is being recorded.';
const OLD_DEFAULT_CONSENT_LINE = 'This conversation is being recorded for the family.';   // read as the new default
const MAX_ALLOWED = 20;
const CONSENT_MAX = 300;
const USER_ID_RE = /^u_[0-9a-f]{12}$/;   // lib/auth newId()
const MICS = ['processed', 'unprocessed'];
const ANNOUNCE = ['first', 'every', 'never'];

/** cleanRecordings(v) -> the full cleaned record (never undefined). */
function cleanRecordingsFull(v) {
  const s = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const allowed = [];
  if (Array.isArray(s.allowed)) {
    for (const id of s.allowed) {
      if (typeof id === 'string' && USER_ID_RE.test(id) && !allowed.includes(id)) allowed.push(id);
      if (allowed.length >= MAX_ALLOWED) break;
    }
  }
  const line = typeof s.consentLine === 'string' ? s.consentLine.trim().slice(0, CONSENT_MAX).trim() : '';
  return {
    keep: s.keep === true,
    allowed,
    keepReplies: s.keepReplies === true,
    consentLine: !line || line === OLD_DEFAULT_CONSENT_LINE ? DEFAULT_CONSENT_LINE : line,
    mic: MICS.includes(s.mic) ? s.mic : 'processed',
    announce: ANNOUNCE.includes(s.announce) ? s.announce : 'first',
  };
}

/** cleanRecordings(v) -> the cleaned record, or undefined when it equals the defaults with no allowed users. */
function cleanRecordings(v) {
  const r = cleanRecordingsFull(v);
  if (!r.keep && !r.allowed.length && !r.keepReplies && r.consentLine === DEFAULT_CONSENT_LINE && r.mic === 'processed' && r.announce === 'first') return undefined;
  return r;
}

/** The full record of an agent (defaults filled in) for the server's own checks. */
function recordingsOf(agent) { return cleanRecordingsFull(agent && agent.recordings); }

/** Whether this user id is on the agent's allowed list. */
function isAllowedUser(agent, userId) {
  return typeof userId === 'string' && !!userId && recordingsOf(agent).allowed.includes(userId);
}

/**
 * The record as one caller may see it in GET /api/agents: an admin gets the whole record, anybody else gets
 * { keep, consentLine, keepReplies, mic } with no allowed list. Everybody gets canDownload (on the list or not).
 * An agent with no setting shows the defaults.
 */
function recordingsForViewer(agent, { admin = false, userId = '' } = {}) {
  const canDownload = isAllowedUser(agent, userId ? String(userId) : '');
  const stored = recordingsOf(agent);
  if (admin) return { ...stored, canDownload };
  const { keep, consentLine, keepReplies, mic } = stored;
  return { keep, consentLine, keepReplies, mic, canDownload };
}

/** The audit detail of a change: the agent, keep on or off, the allowed ids and the mic. No consent text. */
function auditDetail(agentName, rec) {
  const r = cleanRecordingsFull(rec);
  return `${agentName} keep=${r.keep ? 'on' : 'off'} allowed=${r.allowed.join(',') || '-'} mic=${r.mic} announce=${r.announce}`;
}

module.exports = { cleanRecordings, cleanRecordingsFull, recordingsOf, isAllowedUser, recordingsForViewer, auditDetail, DEFAULT_CONSENT_LINE, OLD_DEFAULT_CONSENT_LINE, ANNOUNCE, MAX_ALLOWED, CONSENT_MAX, USER_ID_RE, MICS };
