'use strict';
// HTTP side of the per-person notification settings (lib/notify-prefs):
//   GET  /api/notify/prefs     -> { ok, prefs: { default: { questions, requested, other, security }, agents }, away }
//   PUT  /api/notify/prefs     body { default: {...} } | { agent, prefs: {...}|null }  -> the same as GET
//   POST /api/notify/presence  body { page, visible }  -> { ok: true }   (also from navigator.sendBeacon)
// The person is never named by the request: server.js passes the signed-in user's id ('*' on a hub without accounts).
// Same-origin (Origin / Sec-Fetch-Site) is enforced for every /api request by lib/origin-guard before this runs.

/**
 * handle({ method, pathname, body, userId, service, token, prefs, agentExists, agentVisible })
 *   body: the parsed JSON object, or null when the body was not valid JSON.
 *   agentExists(name) / agentVisible(name): booleans (visible = this person may open the agent).
 * -> { status, json } | null when the path is not one of ours.
 */
function handle({ method, pathname, body, userId, service = false, token = null, prefs, agentExists = () => true, agentVisible = () => true } = {}) {
  const isPrefs = pathname === '/api/notify/prefs';
  const isPresence = pathname === '/api/notify/presence';
  if (!isPrefs && !isPresence) return null;
  if (service || token) return { status: 403, json: { ok: false, error: 'session_only', detail: 'notification settings belong to a person on a page' } };
  if (typeof userId !== 'string' || !userId) return { status: 401, json: { ok: false, error: 'unauthorized' } };
  const view = () => ({ ok: true, prefs: prefs.get(userId), away: prefs.isAway(userId) });
  const fail = (e) => (e && e.code === 'bad_request' ? { status: 400, json: { ok: false, error: e.message } } : { status: 500, json: { ok: false, error: 'could not save' } });

  if (isPresence) {
    if (method !== 'POST') return { status: 405, json: { ok: false, error: 'method_not_allowed' } };
    if (!body || typeof body !== 'object') return { status: 400, json: { ok: false, error: 'invalid JSON' } };
    try { prefs.touch(userId, body.page, body.visible); } catch (e) { return fail(e); }
    return { status: 200, json: { ok: true } };
  }

  if (method === 'GET') return { status: 200, json: view() };
  if (method !== 'PUT') return { status: 405, json: { ok: false, error: 'method_not_allowed' } };
  if (!body || typeof body !== 'object') return { status: 400, json: { ok: false, error: 'invalid JSON' } };
  const hasDefault = Object.prototype.hasOwnProperty.call(body, 'default');
  const hasAgent = Object.prototype.hasOwnProperty.call(body, 'agent');
  if (hasDefault === hasAgent) return { status: 400, json: { ok: false, error: 'send either default or agent with prefs' } };
  try {
    if (hasDefault) prefs.setDefault(userId, body.default);
    else {
      if (typeof body.agent !== 'string' || !body.agent) return { status: 400, json: { ok: false, error: 'agent must be a name' } };
      if (!Object.prototype.hasOwnProperty.call(body, 'prefs')) return { status: 400, json: { ok: false, error: 'prefs is required (an object, or null to remove)' } };
      // Validate the shape first (a bad mode is a 400 whatever the agent), then check the agent exists and is theirs to see.
      const probe = body.prefs;
      if (probe !== null && (typeof probe !== 'object' || Array.isArray(probe))) return { status: 400, json: { ok: false, error: 'settings must be an object or null' } };
      if (probe) for (const k of Object.keys(probe)) {
        if (k === 'security') return { status: 400, json: { ok: false, error: 'security is set for all agents at once' } };
        if (k !== 'questions' && k !== 'requested' && k !== 'other') return { status: 400, json: { ok: false, error: 'kind must be questions, requested or other' } };
        if (probe[k] !== null && !prefs.MODES.includes(probe[k])) return { status: 400, json: { ok: false, error: 'mode must be on, off or away' } };
      }
      // Removing an override is always allowed (it only deletes the caller's own entry, so a deleted agent's leftover can be cleared
      // and nothing is learned about agents they cannot see); setting one needs an agent that exists and that they may open.
      if (body.prefs !== null && (!agentExists(body.agent) || !agentVisible(body.agent))) return { status: 404, json: { ok: false, error: 'no such agent' } };
      prefs.setAgent(userId, body.agent, body.prefs);
    }
  } catch (e) { return fail(e); }
  return { status: 200, json: view() };
}

module.exports = { handle };
