'use strict';

/**
 * bind-host.js — decide which network interface the hub listens on.
 *
 * The hub can run shell commands, read files and spend API credit on behalf
 * of whoever reaches it, so it listens on LOOPBACK ONLY by default.
 *
 * Exposing it beyond this machine is a deliberate opt-in:
 *   HUB_BIND_HOST=0.0.0.0          (or a specific LAN address)
 * and is honoured ONLY when Basic auth is fully configured
 * (HUB_AUTH_USERNAME and HUB_AUTH_PASSWORD). Without both, the request is
 * ignored and the hub stays on 127.0.0.1 — an unauthenticated hub is never
 * reachable from the network.
 */

const LOOPBACK = '127.0.0.1';

function isLoopbackHost(h) {
  const v = String(h || '').trim().toLowerCase();
  return v === 'localhost' || v === '::1' || v === '[::1]' || /^127(\.\d{1,3}){3}$/.test(v);
}

/**
 * @param {object} env  defaults to process.env
 * @returns {{host: string, exposed: boolean, warning: string|null}}
 */
function resolveBindHost(env = process.env, { hasUsers = () => false, hasSecuredAdmin = () => false } = {}) {
  const requested = String(env.HUB_BIND_HOST || '').trim();

  if (!requested) return { host: LOOPBACK, exposed: false, warning: null };

  if (isLoopbackHost(requested)) {
    // Normalise "localhost" to IPv4 loopback: the UI, MCP bridge and health
    // checks all dial 127.0.0.1, and "localhost" may resolve to ::1 only.
    const v = requested.toLowerCase();
    const host = (v === 'localhost') ? LOOPBACK : v.replace(/^\[|\]$/g, '');
    return { host, exposed: false, warning: null };
  }

  // Network exposure needs a real login. Once accounts exist that means an admin with two-factor; before that (older
  // single-user installs) the HUB_AUTH_USERNAME/PASSWORD pair still counts. The pair alone never exposes a hub with accounts:
  // it would be an admin door without a second factor.
  const hasAuth = !!(String(env.HUB_AUTH_USERNAME || '').trim() && String(env.HUB_AUTH_PASSWORD || '').trim());
  const accounts = !!hasUsers();
  const ok = accounts ? !!hasSecuredAdmin() : hasAuth;
  if (!ok) {
    return {
      host: LOOPBACK,
      exposed: false,
      warning: accounts
        ? `HUB_BIND_HOST=${requested} IGNORED: network exposure requires an admin account with two-factor enabled. Listening on ${LOOPBACK} only.`
        : `HUB_BIND_HOST=${requested} IGNORED: network exposure requires HUB_AUTH_USERNAME and HUB_AUTH_PASSWORD (or, once accounts exist, an admin with two-factor). Listening on ${LOOPBACK} only.`,
    };
  }

  return {
    host: requested,
    exposed: true,
    warning: `Hub is reachable from the network on ${requested} (${accounts ? 'account sign-in with two-factor' : 'Basic auth enabled'}). Unset HUB_BIND_HOST to return to localhost-only.`,
  };
}

/**
 * Same-origin guard for the browser event stream (/api/events).
 * The peer must be loopback. The Host must be the hub's own loopback address,
 * a Tailscale name (*.ts.net: `tailscale serve` forwards the browser's Host and
 * connects over loopback, the names lib/origin-guard.js accepts too), or a name
 * listed in HUB_ALLOWED_HOSTS (comma-separated). Any Origin must match that
 * Host; proxied requests arrive over HTTPS. Before the Tailscale names were
 * accepted here, every phone and second computer using the tailnet address was
 * refused the stream and silently fell back to polling: no live tool calls.
 *
 * @returns {boolean}
 */
function isSameOriginStreamRequest(req, port, env = process.env) {
  const peer = req.socket && req.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;

  const host = String(req.headers.host || '').toLowerCase();
  const origin = req.headers.origin;
  if (host === `127.0.0.1:${port}` || host === `localhost:${port}`) {
    return !origin || origin === `http://${host}`;
  }
  const name = host.replace(/:\d+$/, '');
  const extra = String(env.HUB_ALLOWED_HOSTS || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
  if (!(/^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(name) || extra.includes(host))) return false;
  return !origin || String(origin).toLowerCase() === `https://${host}`;
}

/**
 * Tailnet identity gate. Requests that arrive through `tailscale serve` carry a
 * non-loopback Host and a Tailscale-User-Login header that Serve sets itself
 * (client-supplied copies are stripped). When HUB_TAILNET_USERS is set
 * (comma-separated logins), only those users get in; direct loopback requests
 * are always allowed and non-loopback peers are refused. Unset = no gate.
 *
 * @returns {boolean}
 */
function isTailnetUserAllowed(req, port, env = process.env) {
  const allowed = String(env.HUB_TAILNET_USERS || '').split(',').map(u => u.trim().toLowerCase()).filter(Boolean);
  if (allowed.length === 0) return true;
  // Host and Tailscale-User-Login are only trustworthy from Serve itself, which connects
  // over loopback. Off-box peers (HUB_BIND_HOST exposure) could forge either header.
  const peer = req.socket && req.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)) return false;
  const host = String(req.headers.host || '').toLowerCase();
  if (host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`) return true;
  const login = String(req.headers['tailscale-user-login'] || '').trim().toLowerCase();
  return !!login && allowed.includes(login);
}

module.exports = { resolveBindHost, isLoopbackHost, isSameOriginStreamRequest, isTailnetUserAllowed, LOOPBACK };
