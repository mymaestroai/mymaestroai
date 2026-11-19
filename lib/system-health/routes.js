'use strict';
// The system health check's three HTTP routes as a pure handler (server.js calls it; tests call it directly). Admin only.
//   GET  /api/system-health           -> view()
//   POST /api/system-health/run       -> 202 { started: true } | 409 { error: 'running' | 'disabled' }
//   PUT  /api/system-health/settings  -> 200 { settings } | 400 { error }
// The health module is given by the caller as a function: health().


/**
 * handle({ method, pathname, admin, body, health, validateSettings, saveSettings, log })
 * -> { status, body } or null when the route is not ours. `body` is the parsed JSON (null = it did not parse).
 */
async function handle({ method, pathname, admin, body = {}, health, validateSettings, saveSettings, log = () => {} } = {}) {
  const p = String(pathname || '').replace(/\/+$/, '');
  if (p !== '/api/system-health' && p !== '/api/system-health/run' && p !== '/api/system-health/settings') return null;
  const m = String(method || 'GET').toUpperCase();
  const known = (p === '/api/system-health' && m === 'GET') || (p === '/api/system-health/run' && m === 'POST') || (p === '/api/system-health/settings' && m === 'PUT');
  if (!known) return null;
  if (admin !== true) return { status: 403, body: { error: 'admin_only' } };
  try {
    const sc = health();
    if (p === '/api/system-health') return { status: 200, body: sc.view() };
    if (p === '/api/system-health/run') {
      if (sc.isRunning()) return { status: 409, body: { error: 'running' } };
      if (!sc.settings().enabled) return { status: 409, body: { error: 'disabled' } };
      // Runs in the background; a failure is logged, never lost silently.
      Promise.resolve().then(() => sc.run({ trigger: 'manual' })).catch((e) => log(`[health] manual run failed: ${e && e.message}`));
      return { status: 202, body: { started: true } };
    }
    // settings: a partial object on top of what is saved; unknown keys and bad values are refused by validateSettings
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, body: { error: 'invalid JSON' } };
    const r = validateSettings({ ...sc.settings(), ...body });
    if (!r.ok) return { status: 400, body: { error: r.error } };
    saveSettings(r.value);
    return { status: 200, body: { settings: sc.settings() } };
  } catch (e) {
    log(`[health] ${m} ${p} failed: ${e && e.message}`);
    return { status: 500, body: { error: 'the health check could not answer' } };
  }
}

module.exports = { handle };
