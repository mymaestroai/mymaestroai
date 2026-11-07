'use strict';

const oneLine = (e) => String((e && e.message) || e).slice(0, 300);

module.exports = {
  checks: {
    // ctx: { callTool(name, args) -> text, settings, parse(text) -> object|null }
    async server(ctx) {
      try {
        const text = await ctx.callTool('health', {});
        const h = ctx.parse(text);
        if (!h || typeof h !== 'object') return { ok: false, summary: String(text || 'The server sent a reply that could not be read.').slice(0, 300) };
        const warnings = Array.isArray(h.warnings) ? h.warnings.filter((w) => typeof w === 'string').slice(0, 5) : [];
        if (h.waiting) return { ok: false, summary: String(h.waiting).slice(0, 300), warnings };
        if (!h.running) return { ok: false, summary: h.lastError ? `The server is not running (${String(h.lastError).slice(0, 200)}).` : 'The server is not running.', warnings };
        if (!h.group) return { ok: false, summary: 'The server runs, but its device group is not ready yet.', warnings };
        const n = Number(h.computers) || 0;
        return { ok: true, summary: n ? `The server is running. ${n} computer${n === 1 ? '' : 's'} connected.` : 'The server is running. No computer has been added yet.', warnings };
      } catch (e) {
        return { ok: false, summary: oneLine(e) };
      }
    },
  },
};
