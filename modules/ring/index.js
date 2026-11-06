'use strict';

const PATHS = ['link', 'token', 'events', 'done'];

// The address people reach this Maestro on from outside: https only, no login, query or fragment in it.
function publicBase(value) {
  let u;
  try { u = new URL(String(value || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || !u.hostname) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}
function zoneOf(settings) {
  const z = settings && settings.time_zone;
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return z; } catch { return 'UTC'; }
}
function when(ms, zone) {
  return new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(ms));
}
const oneLine = (e) => String((e && e.message) || e).slice(0, 300);

module.exports = {
  checks: {
    // ctx: { callTool(name, args) -> text, settings, parse(text) -> object|null }
    async ring(ctx) {
      try {
        const text = await ctx.callTool('health', {});
        const h = ctx.parse(text);
        if (!h || typeof h !== 'object') return { ok: false, summary: String(text || 'Ring sent a reply that could not be read.').slice(0, 300) };
        if (h.unreadable_state) {   // before any 'not connected' answer: re-linking cannot help while a state file is unreadable
          const names = Array.isArray(h.unreadable_files) ? h.unreadable_files.filter((n) => typeof n === 'string').slice(0, 4).join(', ') : '';
          return { ok: false, summary: `A Ring module state file${names ? ` (${names})` : ''} cannot be read. Connecting the Ring account again will not help until that file is fixed or removed.` };
        }
        if (!h.secrets_present) return { ok: false, summary: 'The Client ID, Client secret or signing key is missing. Save them again in the setup.' };
        if (!h.linked) return { ok: false, summary: 'No Ring account is connected yet. Use the connect step in the setup.' };
        if (h.needs_relink) return { ok: false, summary: 'The Ring connection was lost. Open the setup and connect your Ring account again.' };
        const warnings = [];
        if (h.unsaved_write_failed) warnings.push('Ring renewed the sign-in, and it could not be written to this computer\'s disk either. Free some disk space; until it is saved, a restart would mean connecting again.');
        if (h.unsaved_token) warnings.push('Ring renewed the sign-in but it has not been saved yet. It works for now and is retried; if this stays, the connection may need to be made again after a restart.');
        if (h.ring_reachable === false) return { ok: false, summary: 'Ring could not be reached just now.', warnings };
        return { ok: true, summary: 'Connected to Ring.', warnings };   // no camera names, pictures or event details: they are not kept in check results
      } catch (e) {
        return { ok: false, summary: oneLine(e) };
      }
    },

    // Opens the link page for a short time and shows the one-time code.
    async link(ctx) {
      try {
        const text = await ctx.callTool('arm_link', { minutes: 30 });
        const a = ctx.parse(text);
        if (!a || typeof a.code !== 'string') return { ok: false, summary: String(text || 'The connection could not be opened.').slice(0, 300) };
        const until = Date.parse(a.expires_at);
        const zone = zoneOf(ctx.settings);
        return {
          ok: true,
          once: true,   // the hub stores this result's lines nowhere and returns them only in this step's answer (the code stays out of the summary)
          summary: 'The connection is open. Start it from the Ring app now.',
          lines: [
            `One-time code: ${a.code}`,
            `Valid until ${Number.isFinite(until) ? when(until, zone) : `${a.minutes} minutes from now`}.`,
            'Start connecting from the Ring app. The page that opens asks for this code.',
            'If the code runs out, run this step again for a new one.',
          ],
        };
      } catch (e) {
        return { ok: false, summary: oneLine(e) };
      }
    },

    // The four addresses to give Ring, built from the saved public address.
    async urls(ctx) {
      const base = publicBase(ctx.settings && ctx.settings.public_url);
      if (!base) return { ok: false, summary: 'Save your public https address (for example https://maestro.example.com) in the settings step first.' };
      return { ok: true, summary: 'Enter these four addresses in Ring\'s developer console.', lines: PATHS.map((p) => `${p}: ${base}/hooks/ring/${p}`) };
    },
  },
};
