'use strict';

/**
 * origin-guard.js — refuse browser requests that another website makes to the hub.
 *
 * The hub has no login by default and is published to the tailnet with
 * `tailscale serve`. It used to answer every request with
 * `Access-Control-Allow-Origin: *`, so JavaScript on ANY web page opened on a
 * tailnet device could POST to /api/chat (an agent with a shell) and read the
 * reply. The hub UI is served from the same origin as its API and needs no
 * CORS at all, so the rule is:
 *
 *   - no CORS headers are ever sent (a foreign page cannot read responses);
 *   - an API request (/api/*, /v1/*) or any non-GET/HEAD request is refused
 *     when it carries a browser marker of another site:
 *       Origin that is not http(s)://<the Host it arrived on>, or
 *       Sec-Fetch-Site: cross-site / same-site (another port counts as another site);
 *   - a request carrying an Origin must also arrive on a Host the hub knows
 *     (loopback, a *.ts.net name, or HUB_ALLOWED_HOSTS), which stops DNS
 *     rebinding (evil.example resolving to 127.0.0.1 would match its own Origin).
 *
 * Requests without browser markers (curl, agents, bots, codex bridge, the
 * scheduler) are unaffected. Plain page navigations (GET /, /setup, ...) stay
 * allowed so links and bookmarks keep working.
 */

function knownHost(host, env = process.env) {
  const h = String(host || '').toLowerCase();
  const name = h.replace(/:\d+$/, '');
  if (name === 'localhost' || name === '127.0.0.1' || name === '[::1]') return true;
  if (name.endsWith('.ts.net')) return true;
  const extra = String(env.HUB_ALLOWED_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return extra.includes(h) || extra.includes(name);
}

/**
 * @returns {string|null} refusal reason, or null when the request may proceed
 */
function crossOriginRefusal(req, pathname, env = process.env) {
  const method = String(req.method || 'GET').toUpperCase();
  const guarded = pathname.startsWith('/api/') || pathname.startsWith('/v1/') ||
    (method !== 'GET' && method !== 'HEAD');
  if (!guarded) return null;

  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site === 'cross-site' || site === 'same-site') return `sec-fetch-site ${site}`;

  const origin = req.headers.origin;
  if (origin === undefined) return null;
  const host = String(req.headers.host || '').toLowerCase();
  if (!knownHost(host, env)) return 'unknown host';
  const o = String(origin).toLowerCase();
  if (o !== `http://${host}` && o !== `https://${host}`) return 'foreign origin';
  return null;
}

module.exports = { crossOriginRefusal, knownHost };
