'use strict';

module.exports = {
  checks: {
    // ctx: { callTool(name, args) -> text, parse(text) -> object|null }
    async drive(ctx) {
      try {
        // A probe install id: this only proves the sign-in works; it finds no folder and creates none.
        const text = await ctx.callTool('backup_list', { install: '0000000000000000' });
        const out = ctx.parse(text);
        const n = out && Array.isArray(out.files) ? out.files.length : null;
        if (n === null) return { ok: false, summary: String(text || 'Google Drive sent a reply that could not be read.').slice(0, 300) };
        return { ok: true, summary: 'Signed in to Google Drive.' };
      } catch (e) {
        return { ok: false, summary: String((e && e.message) || e) };
      }
    },
  },
};
