'use strict';
// The Claude sign-in's four HTTP routes as a pure handler (server.js calls it; tests call it directly).
//   GET  /api/claude-signin         any signed-in person: { canSignIn, signedIn, adminName?, words, attempt? }
//   POST /api/claude-signin/start   admin browser session only -> { ok, reason?, attempt }
//   POST /api/claude-signin/code    admin browser session only, body { code } -> { ok, reason?, attempt } (never echoes the code)
//   POST /api/claude-signin/cancel  admin browser session only -> { ok, attempt }
// Nothing here logs a body, a code, a link or the client's output.
const MAX_CODE_BODY = 8 * 1024;
const NOT_ADMIN = 'Sign in with an admin account in your browser to do this.';

/** The display name of the earliest active admin (never a login or an email), or null. */
function adminDisplayName(auth) {
  try {
    const list = (auth && typeof auth.admins === 'function' ? auth.admins() : []).slice()
      .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    const a = list[0];
    return (a && typeof a.name === 'string' && a.name.trim()) ? a.name.trim() : null;
  } catch { return null; }
}

/**
 * handle({ method, pathname, req, isAdminSession, readBody, auth, signIn, words, hasSignIn, onDone })
 * -> { status, body } or null when the route is not ours.
 *   readBody(req) -> Promise<string> (only called after the admin check); signIn() -> the engine; onDone() is called once per
 *   attempt that reached 'done' (the caller refreshes the hub's own view).
 */
const refreshed = new WeakMap();   // engine -> startedAt already announced
async function handle({ method, pathname, req, isAdminSession, readBody, auth, signIn, words, hasSignIn, onDone }) {
  const p = String(pathname || '');
  if (p !== '/api/claude-signin' && !/^\/api\/claude-signin\/(start|code|cancel)$/.test(p)) return null;
  const m = String(method || 'GET').toUpperCase();
  const post = p !== '/api/claude-signin';
  if (post !== (m === 'POST') || (!post && m !== 'GET')) return { status: 405, body: { ok: false, error: 'Not allowed.' } };
  const admin = !!isAdminSession(req);
  if (post && !admin) return { status: 403, body: { ok: false, error: NOT_ADMIN } };
  try {
    const eng = signIn();
    const view = () => {
      const a = eng.state();
      if (a && a.state === 'done' && typeof onDone === 'function' && refreshed.get(eng) !== a.startedAt) {
        refreshed.set(eng, a.startedAt);
        try { onDone(); } catch { /* the hub's own view catches up at its next check */ }
      }
      return a;
    };
    if (!post) {
      let signedIn = null;
      try { signedIn = hasSignIn() ? true : null; } catch { signedIn = null; }
      const body = { canSignIn: admin, signedIn, adminName: admin ? null : adminDisplayName(auth), words };
      if (admin) body.attempt = view();
      return { status: 200, body };
    }
    if (p.endsWith('/start')) {
      const r = await eng.start();
      return { status: 200, body: { ...r, attempt: view() } };
    }
    if (p.endsWith('/cancel')) {
      const r = eng.cancel();
      return { status: 200, body: { ...r, attempt: view() } };
    }
    // /code
    let text = '';
    try { text = await readBody(req); } catch { return { status: 413, body: { ok: false, reason: 'format', attempt: view() } }; }
    if (String(text || '').length > MAX_CODE_BODY) return { status: 413, body: { ok: false, reason: 'format', attempt: view() } };
    let b = null;
    try { b = JSON.parse(text || '{}'); } catch { b = null; }
    if (!b || typeof b !== 'object' || typeof b.code !== 'string') return { status: 400, body: { ok: false, reason: 'format', attempt: view() } };
    const r = eng.submitCode(b.code);
    return { status: 200, body: { ...r, attempt: view() } };
  } catch {
    return { status: 500, body: { ok: false, reason: 'error', error: 'The sign-in could not answer.' } };
  }
}

module.exports = { handle, adminDisplayName, MAX_CODE_BODY, NOT_ADMIN };
