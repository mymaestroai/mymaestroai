'use strict';
// The self-check's three HTTP routes as a pure handler (server.js calls it; tests call it directly). Admin only: server.js
// already sends members away (access.classifyRoute puts every unlisted /api route in the admin class), and this checks it
// again, so a change to that table can never open these routes.
//   GET  /api/selfcheck           -> view()
//   POST /api/selfcheck/run       -> 202 { started: true } | 409 { error: 'running' | 'disabled' }
//   PUT  /api/selfcheck/settings  -> 200 { settings } | 400 { error }
// The self-check module is given by the caller (server.js requires lib/selfcheck lazily).

/**
 * handle({ method, pathname, admin, body, selfCheck, validateSettings, saveSettings, log })
 * -> { status, body } or null when the route is not ours. `body` is the parsed JSON (null = it did not parse).
 */
async function handle({ method, pathname, admin, body = {}, selfCheck, validateSettings, saveSettings, log = () => {} } = {}) {
  const p = String(pathname || '').replace(/\/+$/, '');
  if (p !== '/api/selfcheck' && p !== '/api/selfcheck/run' && p !== '/api/selfcheck/settings') return null;
  const m = String(method || 'GET').toUpperCase();
  const known = (p === '/api/selfcheck' && m === 'GET') || (p === '/api/selfcheck/run' && m === 'POST') || (p === '/api/selfcheck/settings' && m === 'PUT');
  if (!known) return null;
  if (admin !== true) return { status: 403, body: { error: 'admin_only' } };
  try {
    const sc = selfCheck();
    if (p === '/api/selfcheck') return { status: 200, body: sc.view() };
    if (p === '/api/selfcheck/run') {
      if (sc.isRunning()) return { status: 409, body: { error: 'running' } };
      if (!sc.settings().enabled) return { status: 409, body: { error: 'disabled' } };
      // Runs in the background; a failure is logged, never lost silently.
      Promise.resolve().then(() => sc.run({ trigger: 'manual' })).catch((e) => log(`[selfcheck] manual run failed: ${e && e.message}`));
      return { status: 202, body: { started: true } };
    }
    // settings: a partial object on top of what is saved; unknown keys and bad values are refused by validateSettings
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, body: { error: 'invalid JSON' } };
    const r = validateSettings({ ...sc.settings(), ...body });
    if (!r.ok) return { status: 400, body: { error: r.error } };
    saveSettings(r.value);
    return { status: 200, body: { settings: sc.settings() } };
  } catch (e) {
    log(`[selfcheck] ${m} ${p} failed: ${e && e.message}`);
    return { status: 500, body: { error: 'the self-check could not answer' } };
  }
}

module.exports = { handle };
