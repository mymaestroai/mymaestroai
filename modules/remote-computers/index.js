'use strict';

const oneLine = (e) => String((e && e.message) || e).slice(0, 300);
const LINUX_ONLY = 'Remote computers needs My Maestro on Linux for now.';

module.exports = {
  checks: {
    // ctx: { callTool(name, args) -> text, settings, parse(text) -> object|null }
    async server(ctx) {
      if ((ctx && ctx.platform || process.platform) !== 'linux') return { ok: false, summary: LINUX_ONLY };
      try {
        const text = await ctx.callTool('health', {});
        const h = ctx.parse(text);
        if (!h || typeof h !== 'object') return { ok: false, summary: String(text || 'The server sent a reply that could not be read.').slice(0, 300) };
        const warnings = Array.isArray(h.warnings) ? h.warnings.filter((w) => typeof w === 'string').slice(0, 5) : [];
        if (h.waiting) return { ok: false, summary: String(h.waiting).slice(0, 300), warnings };
        if (h.reason && h.message) {   // service mode: the service is not installed, or not answering; the message already holds the command
          const command = typeof h.command === 'string' ? h.command.slice(0, 500) : '';
          return { ok: false, summary: String(h.message).slice(0, 800), reason: String(h.reason).slice(0, 40), ...(command ? { command, lines: [command] } : {}), warnings };
        }
        if (!h.running) return { ok: false, summary: h.lastError ? `The server is not running (${String(h.lastError).slice(0, 200)}).` : 'The server is not running.', warnings };
        if (!h.group) return { ok: false, summary: 'The server runs, but its device group is not ready yet.', warnings };
        if (h.ok !== true) return { ok: false, summary: String(h.lastError || warnings[0] || 'The control connection is not ready.').slice(0, 300), warnings };
        const n = Number(h.computers) || 0, on = Number(h.online) || 0;
        return { ok: true, summary: n ? `The server is running. ${n} computer${n === 1 ? '' : 's'} registered, ${on} online.` : 'The server is running. No computer has been added yet.', warnings };
      } catch (e) {
        return { ok: false, summary: oneLine(e) };
      }
    },

    // A one-time download address for the helper. The address is the secret, so it is shown once and never saved.
    async installer(ctx) {
      try {
        const text = await ctx.callTool('installer_link', {});
        const a = ctx.parse(text);
        if (!a || typeof a.url !== 'string' || !/^https:\/\//.test(a.url)) return { ok: false, summary: String(text || 'The link could not be made.').slice(0, 300) };
        return {
          ok: true,
          once: true,
          summary: 'The installer link is ready. It works once.',
          lines: [
            `On the PC, open this address in a browser within 15 minutes (the whole address, including the part after the ? mark): ${a.url}`,
            'It downloads MyMaestro-RemoteAgent.exe. Run it and choose Install. Windows Defender or SmartScreen may warn that it is a remote-access tool; that is expected for this kind of software.',
            'If the link runs out, run this step again for a new one.',
          ],
        };
      } catch (e) {
        return { ok: false, summary: oneLine(e) };
      }
    },

    // Passes when at least one registered computer is online.
    async computer(ctx) {
      const none = 'No computer has connected yet. Run the installer on the PC, then check again.';
      try {
        const text = await ctx.callTool('computers_status', {});
        const list = ctx.parse(text);
        if (!Array.isArray(list)) return { ok: false, summary: String(text || none).slice(0, 300) };
        const pcs = list.filter((c) => c && typeof c === 'object' && typeof c.name === 'string');
        const on = pcs.filter((c) => c.online === true);
        if (!on.length) {
          return { ok: false, summary: pcs.length ? `${pcs.length === 1 ? pcs[0].name.slice(0, 80) : `${pcs.length} computers`} registered, but none is online. Check that the PC is on and Tailscale is running, then check again.` : none };
        }
        const first = on[0];
        const os = typeof first.os === 'string' && first.os.trim() ? ` (${first.os.trim().slice(0, 60)})` : '';
        const extra = on.length > 1 ? ` (and ${on.length - 1} more online)` : '';
        return { ok: true, summary: `${first.name.slice(0, 80)} is connected${os}${extra}` };
      } catch (e) {
        return { ok: false, summary: oneLine(e) };
      }
    },
  },
};
