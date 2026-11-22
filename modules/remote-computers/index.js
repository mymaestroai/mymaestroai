'use strict';

const oneLine = (e) => String((e && e.message) || e).slice(0, 300);
const LINUX_ONLY = 'Remote computers can\'t run on this system yet. It runs on Linux and Mac.';
const MIN_DISK_MB = 300;
const DEFAULT_PORTS = [9971, 9972];
const PORT_SPAN = 50;
const SERVICE_NEEDS_ADMIN = 'Starting the server as its own locked-down service needs an administrator password once.';
const MODE_SERVICE = 'The server is running as its own locked-down service.';
const MODE_HUB = 'The server is running under your Maestro\'s own account.';
const WILL_SERVICE = 'It will run as its own locked-down service.';
const WILL_HUB = 'It will run under your Maestro\'s own account. The server then has the same access to files as your Maestro.';

const GETTING_READY = 'The server is getting ready. This page shows it when it is ready.';
const INSTALLER_NOT_READY = 'The server is still getting ready. Come back to this step when Set it up says it is done.';
const NOT_READY_RE = /server is not ready yet\. Try again in a minute/i;
const NAMES = { win32: 'Windows', freebsd: 'FreeBSD', openbsd: 'OpenBSD', aix: 'AIX', sunos: 'SunOS', android: 'Android' };
const empty = (v) => v === undefined || v === null || String(v).trim() === '';
const ipsOf = (facts) => (facts && facts.tailscale && Array.isArray(facts.tailscale.ips) ? facts.tailscale.ips.filter((x) => typeof x === 'string') : []);

// ctx: { facts, settings, platform } -> { ok, summary, lines, blocker }. Runs before anything is installed.
function prereqs(ctx) {
  const facts = (ctx && ctx.facts) || {};
  const os = String(facts.os || (ctx && ctx.platform) || process.platform);
  const ts = facts.tailscale || {};
  const stop = (blocker, summary, lines = []) => ({ ok: false, summary, lines, blocker });
  if (os !== 'linux' && os !== 'darwin') {
    const name = NAMES[os] || os;
    return stop('unsupported', `Remote computers can't run on ${name} yet. It runs on Linux and Mac.`);
  }
  if (ts.state === 'not-installed') {
    return stop('tailscale-missing', 'Tailscale isn\'t installed on the computer your Maestro runs on.', ['Install it from https://tailscale.com/download and sign in.', 'Then come back to this page.']);
  }
  const ips = ipsOf(facts);
  if (ts.state === 'not-running' || ts.state === 'unknown') {
    return stop('tailscale-not-running', 'Tailscale is installed on the computer your Maestro runs on, but it isn\'t running. Start Tailscale on it, then come back.');
  }
  if (ts.state !== 'running' || !ips.length) {
    return stop('tailscale-off', 'Tailscale is installed but not signed in on the computer your Maestro runs on.', ['Open Tailscale on it and sign in.', 'Then come back to this page.']);
  }
  if (ts.userspace === true) {
    return stop('tailscale-userspace', 'Tailscale on the computer your Maestro runs on is the command-line-only kind, which other programs can\'t use. Install the Tailscale app from tailscale.com/download instead.');
  }
  const free = facts.free_disk_mb;
  if (typeof free === 'number' && Number.isFinite(free) && free < MIN_DISK_MB) {
    return stop('disk', `There is not enough free disk space on the computer your Maestro runs on: ${Math.max(0, Math.floor(free))} MB free, and it needs about ${MIN_DISK_MB} MB.`, ['Free some space.', 'Then come back to this page.']);
  }
  const found = ts.host ? `${ts.host} (${ips[0]})` : ips[0];
  const lines = [`Found this computer on your private network: ${found}.`];
  if (ips.length > 1) lines.push(`It has ${ips.length} addresses on your private network. You will be asked which one to use.`);
  if (os === 'darwin') lines.push('New: Remote computers on a Mac is not yet proven on a real Mac.');
  return { ok: true, summary: 'The computer your Maestro runs on is ready.', lines, blocker: null };
}

// ctx: { facts, settings, platform, choices, portFree(port, host) -> Promise<boolean>, saved? }.
// `saved` (optional) is the raw saved settings; without it a value equal to the manifest default counts as not saved.
// Returns { settings, lines, choose, stop }. Only keys with no saved value (or answered in choices) are ever returned.
async function prepare(ctx) {
  const facts = (ctx && ctx.facts) || {};
  const platform = String((ctx && ctx.platform) || facts.os || process.platform);
  const settings = (ctx && ctx.settings) || {};
  const saved = ctx && ctx.saved && typeof ctx.saved === 'object' ? ctx.saved : null;
  const choices = (ctx && ctx.choices && typeof ctx.choices === 'object') ? ctx.choices : {};
  const portFree = typeof (ctx && ctx.portFree) === 'function' ? ctx.portFree : async () => true;
  const out = { settings: {}, lines: [], choose: null, stop: null };
  const halt = (text) => { out.stop = text; out.settings = {}; return out; };
  const ts = facts.tailscale || {};
  const ips = ipsOf(facts);
  const isSaved = (key, dflt) => (saved ? !empty(saved[key]) : !empty(settings[key]) && (dflt === undefined || Number(settings[key]) !== dflt));

  if (!ips.length) return halt('Tailscale is not signed in on the computer your Maestro runs on. Sign in, then come back to this page.');

  // the address the server listens on: only ever one of this computer's own Tailscale addresses
  let ip = null;
  if (!empty(choices.listen_ip)) {
    if (!ips.includes(String(choices.listen_ip))) { out.choose = chooseIp(ips); return out; }
    ip = String(choices.listen_ip);
    out.settings.listen_ip = ip;
  } else if (!empty(settings.listen_ip) && isSaved('listen_ip')) {
    ip = String(settings.listen_ip);
    if (!ips.includes(ip)) return halt(`The saved address ${ip} is not this computer's Tailscale address now (${ips.join(', ')}). Change it under Advanced.`);
  } else if (ips.length > 1) {
    out.choose = chooseIp(ips);
    return out;
  } else {
    ip = ips[0];
    out.settings.listen_ip = ip;
  }

  // the name the computers connect to
  if (!empty(choices.address_name)) out.settings.address_name = String(choices.address_name);
  else if (empty(settings.address_name) || (saved && empty(saved.address_name))) {
    if (!ts.host) return halt('Tailscale did not give a name for the computer your Maestro runs on. Turn on MagicDNS in Tailscale, or type the name under Advanced.');
    out.settings.address_name = ts.host;
  }
  const hostShown = out.settings.address_name || settings.address_name;
  out.lines.push(`Found this computer on your private network: ${hostShown ? `${hostShown} (${ip})` : ip}.`);

  // the ports
  // A port named in the choices counts only when it is a whole number from 1 to 65535; anything else is treated as not given.
  const portChoice = (v) => { if (typeof v === 'boolean' || empty(v)) return null; const n = Number(v); return Number.isInteger(n) && n > 0 && n < 65536 ? n : null; };
  const cChoice = portChoice(choices.control_port), aChoice = portChoice(choices.agent_port);
  const cSaved = cChoice !== null ? false : isSaved('control_port', DEFAULT_PORTS[0]);
  const aSaved = aChoice !== null ? false : isSaved('agent_port', DEFAULT_PORTS[1]);
  const cVal = cSaved ? Number(settings.control_port) : cChoice !== null ? cChoice : DEFAULT_PORTS[0];
  const aVal = aSaved ? Number(settings.agent_port) : aChoice !== null ? aChoice : DEFAULT_PORTS[1];
  if (cSaved && aSaved) {
    out.lines.push(`Using the saved ports ${cVal} and ${aVal}.`);
  } else {
    let found = null;
    for (let i = 0; i <= PORT_SPAN && !found; i++) {
      const c = cSaved ? cVal : cVal + i, a = aSaved ? aVal : aVal + i;
      if (c === a || c > 65535 || a > 65535) continue;
      const okC = cSaved || await portFree(c, '127.0.0.1');
      const okA = aSaved || await portFree(a, ip);
      if (okC && okA) found = [c, a, i];
      if (cSaved && aSaved) break;
    }
    if (!found) return halt(`No free ports were found near ${cVal} and ${aVal} on the computer your Maestro runs on. Free them, or choose other ports under Advanced.`);
    if (!cSaved) out.settings.control_port = found[0];
    if (!aSaved) out.settings.agent_port = found[1];
    out.lines.push(found[2] ? `Ports ${cVal} and ${aVal} are in use, so it will use ${found[0]} and ${found[1]}.` : `It will use ports ${found[0]} and ${found[1]}.`);
  }

  // how it runs
  const asked = !empty(choices.run_as) ? String(choices.run_as) : empty(settings.run_as) ? '' : String(settings.run_as);
  if (empty(settings.run_as) || (saved && empty(saved.run_as)) || !empty(choices.run_as)) out.settings.run_as = asked || 'auto';
  const runAs = asked || 'auto';
  if (runAs === 'service' && platform !== 'linux') return halt('Running as its own service is not available on this system. Change "How the server runs" under Advanced.');
  const service = runAs === 'service' || (runAs === 'auto' && platform === 'linux' && facts.has_systemd === true);
  out.lines.push(service ? WILL_SERVICE : WILL_HUB);
  return out;
}

function chooseIp(ips) {
  return { key: 'listen_ip', label: 'This computer has more than one address on your private network. Which one should the server use?', options: ips.map((v) => ({ value: v, label: v })) };
}

module.exports = {
  prechecks: { prereqs },
  setup: { prepare },
  checks: {
    // ctx: { callTool(name, args) -> text, settings, parse(text) -> object|null }
    async server(ctx) {
      const platform = (ctx && ctx.platform) || process.platform;
      if (platform !== 'linux' && platform !== 'darwin') return { ok: false, summary: LINUX_ONLY };
      try {
        // Health only looks; a failed helper download is started again only when the person pressed Try again (ctx.tryAgain).
        const text = await ctx.callTool('health', ctx.tryAgain === true ? { retry: true } : {});
        const h = ctx.parse(text);
        if (!h || typeof h !== 'object') return { ok: false, summary: String(text || 'The server sent a reply that could not be read.').slice(0, 300) };
        const warnings = Array.isArray(h.warnings) ? h.warnings.filter((w) => typeof w === 'string').slice(0, 5) : [];
        const mode = h.mode === 'service' || h.mode === 'hub' ? { mode: h.mode } : {};
        // retry: true = a state that resolves by itself (starting, first start downloading, the device group not ready); the setup looks again.
        // "Reinstall needed" and "Waiting for setup" need a person, so they are not retried.
        if (h.waiting) return { ok: false, ...(/^(Reinstall needed|Waiting for setup)/.test(String(h.waiting)) ? {} : { retry: true }), summary: String(h.waiting).slice(0, 300), warnings, ...mode };
        // The helper programs for the other computers (downloaded once from GitHub): said plainly while they come, and when they could not.
        const helpers = h.helpers && typeof h.helpers === 'object' ? h.helpers : null;
        if (!h.ok && helpers && helpers.state === 'downloading') {
          const mb = (n) => (Math.round((Number(n) || 0) / 1048576 * 10) / 10).toString();
          return { ok: false, retry: true, summary: `Getting the helper programs for the other computers: ${mb(helpers.bytes)} of ${mb(helpers.totalBytes)} MB. How long it takes depends on your connection.`, warnings, ...mode };
        }
        if (!h.ok && helpers && helpers.state === 'failed') {
          const why = String(helpers.error || 'unknown reason').replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, 100) || 'unknown reason';
          return { ok: false, tryAgain: true, summary: `The helper programs for the other computers could not be downloaded from GitHub (${why}). Check that the computer your Maestro runs on can reach github.com, then press Try again. What was already downloaded is kept.`, warnings, ...mode };
        }
        if (h.reason && h.message) {   // service mode: the service is not installed, or not answering; it needs a person, so no retry
          const command = typeof h.command === 'string' ? h.command.slice(0, 500) : '';
          return { ok: false, summary: SERVICE_NEEDS_ADMIN, reason: String(h.reason).slice(0, 40), ...(command ? { command } : {}), warnings, ...mode };
        }
        if (!h.running) return { ok: false, ...(h.lastError ? {} : { retry: true }), summary: h.lastError ? `The server is not running (${String(h.lastError).slice(0, 200)}).` : GETTING_READY, warnings, ...mode };
        if (!h.group) return { ok: false, retry: true, summary: GETTING_READY, warnings, ...mode };
        if (h.ok !== true) return { ok: false, ...(h.lastError ? {} : { retry: true }), summary: String(h.lastError || warnings[0] || GETTING_READY).slice(0, 300), warnings, ...mode };
        const n = Number(h.computers) || 0, on = Number(h.online) || 0;
        const how = h.mode === 'service' ? MODE_SERVICE : h.mode === 'hub' ? MODE_HUB : 'The server is running.';
        return { ok: true, summary: `${how} ${n ? `${n} computer${n === 1 ? '' : 's'} registered, ${on} online.` : 'No computer has been added yet.'}`, warnings, ...mode };
      } catch (e) {
        return { ok: false, summary: oneLine(e) };
      }
    },

    // A one-time download address for the helper. The address is the secret, so it is shown once and never saved.
    async installer(ctx) {
      try {
        const os = ctx.choice === 'linux' || ctx.choice === 'mac' ? ctx.choice : 'windows';
        const text = await ctx.callTool('installer_link', { os });
        const a = ctx.parse(text);
        if (!a || typeof a.url !== 'string' || !/^https:\/\//.test(a.url)) return { ok: false, summary: NOT_READY_RE.test(String(text)) ? INSTALLER_NOT_READY : String(text || 'The link could not be made.').slice(0, 300) };
        // An older connector ignores the system and always answers the Windows link.
        if ((typeof a.os === 'string' ? a.os : 'windows') !== os) return { ok: false, summary: 'This version can only make a Windows link.' };
        const last = 'If the link runs out, make a new one.';
        if (os === 'linux') {
          return {
            ok: true,
            once: true,
            summary: 'The install command is ready. It works once.',
            lines: [
              'On the Linux computer, open a terminal and run this command within 15 minutes. It asks for your password once.',
              `Command: f=$(mktemp) && curl -fsSL '${a.url}' -o "$f" && sudo sh "$f"; rm -f "$f"`,
              'It sets up the remote-control agent: as a service where the computer uses systemd, otherwise in that terminal until you close it. If you are already root, or the computer has no sudo, leave out the word sudo.',
              'If the download fails, nothing is installed: make a new link.',
              last,
            ],
          };
        }
        if (os === 'mac') {
          return {
            ok: true,
            once: true,
            summary: 'The Mac install command is ready. It works once.',
            lines: [
              'On the Mac, open Terminal and run this command within 15 minutes. It asks for your password once.',
              `Command: d=$(mktemp -d) && curl -fsSL '${a.url}' -o "$d/agent.zip" && unzip -q "$d/agent.zip" -d "$d" && sudo installer -pkg "$d/MeshAgent.pkg" -target /; rm -rf "$d"`,
              'It downloads the remote-control agent for this link only and installs it. If the download fails, nothing is installed: make a new link.',
              'For agents to see the screen: System Settings, Privacy & Security, Screen Recording: switch on meshagent. New on a Mac: not yet proven on a real Mac.',
              last,
            ],
          };
        }
        return {
          ok: true,
          once: true,
          qr: a.url,
          summary: 'The installer link is ready. It works once.',
          lines: [
            `On the computer you want to control, open this address in a browser within 15 minutes (the whole address, including the part after the ? mark): ${a.url}`,
            'It downloads MyMaestro-RemoteAgent.exe. Run it and choose Install. Windows Defender or SmartScreen may warn that it is a remote-access tool; that is expected for this kind of software.',
            last,
          ],
        };
      } catch (e) {
        return { ok: false, summary: NOT_READY_RE.test(oneLine(e)) ? INSTALLER_NOT_READY : oneLine(e) };
      }
    },

    // Passes when at least one registered computer is online. When none is, it says why from what the server knows.
    async computer(ctx) {
      const none = 'No computer has connected yet. Run the link\'s download or command on that computer, then check again.';
      try {
        const text = await ctx.callTool('computers_status', {});
        const list = ctx.parse(text);
        if (!Array.isArray(list)) return { ok: false, summary: String(text || none).slice(0, 300) };
        const pcs = list.filter((c) => c && typeof c === 'object' && typeof c.name === 'string');
        const on = pcs.filter((c) => c.online === true);
        if (!on.length) {
          if (pcs.length) return { ok: false, summary: `${pcs.length === 1 ? pcs[0].name.slice(0, 80) : `${pcs.length} computers`} registered, but ${pcs.length === 1 ? 'it is' : 'none is'} offline. Check that the computer is on and signed in to Tailscale with the same account, then check again.` };
          let helper = null;
          try { const h = ctx.parse(await ctx.callTool('health', {})); helper = h && typeof h === 'object' && h.helper && typeof h.helper === 'object' ? h.helper : null; } catch { /* not known */ }
          if (!helper) return { ok: false, summary: none };
          if (!helper.made) return { ok: false, summary: 'No link has been made yet. Make one in the step above, then use it on the computer you want to control.' };
          if (!helper.used) return { ok: false, summary: 'The last link has not been used yet. Use it on the computer you want to control within 15 minutes, or make a new one in the step above.' };
          return { ok: false, summary: 'The link was used, but no computer has connected yet. Run the link\'s download or command on that computer, then check again.' };
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
