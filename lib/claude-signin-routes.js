'use strict';
// The Claude sign-in's four HTTP routes as a pure handler (server.js calls it; tests call it directly).
//   GET  /api/claude-signin         any signed-in person: { canSignIn, signedIn, adminName?, words, attempt? }
//   POST /api/claude-signin/start   admin browser session only -> { ok, reason?, attempt }
//   POST /api/claude-signin/code    admin browser session only, body { code, id } -> { ok, reason?, attempt } (never echoes the code)
//   POST /api/claude-signin/cancel  admin browser session only, body { id } -> { ok, attempt }
//   /code and /cancel need the id of the attempt the panel opened: a missing or malformed one is a 400 with no effect, a stale one a 409.
// Nothing here logs a body, a code, a link or the client's output.
const MAX_CODE_BODY = 8 * 1024;
const NOT_ADMIN = 'Sign in with an admin account in your browser to do this. On the computer that runs your Maestro you can also type `mymaestro connect claude` in a terminal.';
const SIGNED_IN_TTL_MS = 60 * 1000;
let signedInCache = null;   // { at, value }

/** hasSignIn()'s answer (true or null, never false), kept for 60 s, a negative answer too. */
function cachedSignedIn(hasSignIn, now = Date.now()) {
  if (signedInCache && now - signedInCache.at < SIGNED_IN_TTL_MS && now >= signedInCache.at) return signedInCache.value;
  let value = null;
  try { value = hasSignIn() ? true : null; } catch { value = null; }
  signedInCache = { at: now, value };
  return value;
}
function resetSignedInCache() { signedInCache = null; }

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
async function handle({ method, pathname, req, res, isAdminSession, readBody, auth, signIn, words, hasSignIn, onDone, now }) {
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
        resetSignedInCache();   // a new sign-in just happened: the next read looks again
        try { onDone(); } catch { /* the hub's own view catches up at its next check */ }
      }
      return a;
    };
    if (!post) {
      // Only admins are told (a member's answer has signedIn null); and the answer, a negative one too, is kept for 60 s:
      // on a Mac a missing token makes hasSignIn read the Keychain with a blocking call.
      const signedIn = admin ? cachedSignedIn(hasSignIn, typeof now === 'function' ? now() : Date.now()) : null;
      const body = { canSignIn: admin, signedIn, adminName: admin ? null : adminDisplayName(auth), words };
      if (admin) body.attempt = view();
      return { status: 200, body };
    }
    if (p.endsWith('/start')) {
      const controller = new AbortController();
      const disconnected = () => controller.abort();
      // The request body can finish normally while the response is still waiting.
      res?.once('close', disconnected);
      try {
        if (res?.destroyed || req?.socket?.destroyed) disconnected();
        const r = await eng.start({ signal: controller.signal });
        return { status: 200, body: { ...r, attempt: view() } };
      } finally {
        res?.removeListener('close', disconnected);
      }
    }
    // /code and /cancel both carry the id of the attempt the panel opened; a malformed request has no side effect.
    let text;
    try {
      text = String(await readBody(req) || '');
    } catch {
      return { status: 413, body: { ok: false, reason: 'format' } };
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_CODE_BODY) {
      return { status: 413, body: { ok: false, reason: 'format' } };
    }

    let b;
    try { b = JSON.parse(text); } catch { b = null; }
    const cancel = p.endsWith('/cancel');
    if (!b || typeof b.id !== 'string' || !b.id ||
        (!cancel && typeof b.code !== 'string')) {
      return { status: 400, body: { ok: false, reason: 'format' } };
    }

    const result = cancel ? eng.cancel(b.id) : eng.submitCode(b.code, b.id);
    if (result.reason === 'stale') {
      return { status: 409, body: { ok: false, reason: 'stale' } };
    }
    return { status: 200, body: { ...result, attempt: view() } };
  } catch {
    return { status: 500, body: { ok: false, reason: 'error', error: 'The sign-in could not answer.' } };
  }
}

module.exports = { handle, adminDisplayName, resetSignedInCache, MAX_CODE_BODY, NOT_ADMIN };
