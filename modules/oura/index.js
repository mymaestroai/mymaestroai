'use strict';

module.exports = {
  checks: {
    // ctx: { callTool(name, args) -> text, parse(text) -> object|null }
    async oura(ctx) {
      try {
        const day = (ms) => new Date(ms).toISOString().slice(0, 10);
        const text = await ctx.callTool('oura_readiness', { start_date: day(Date.now() - 86400000), end_date: day(Date.now()) });
        const out = ctx.parse(text);
        if (!out || !Array.isArray(out.days)) return { ok: false, summary: String(text || 'Oura sent a reply that could not be read.').slice(0, 300) };
        const last = out.days.filter((d) => d && d.score !== null && d.score !== undefined).pop();
        return { ok: true, summary: last ? `Connected; latest readiness ${last.score} on ${last.date}.` : 'Connected; no readiness yet.' };
      } catch (e) {
        return { ok: false, summary: String((e && e.message) || e) };
      }
    },
  },
};
