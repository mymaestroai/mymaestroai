'use strict';

/**
 * service-manager.js — run the hub as a background service that starts on its own and comes back after a restart:
 * a systemd user unit on Linux (with "linger", so it starts at boot), a launchd agent on macOS (starts at login).
 * Used by the installer (through `mymaestro service install`) and by `mymaestro start|stop|restart|status`.
 *
 * Install facts are kept in data/install.json: { product, dir, port, node, service, unit, label, bin, stateDir, channel }.
 * Hubs installed before the installer existed have no such file; their service is found by looking for a unit or a
 * launchd agent whose command runs this folder's server.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const HUB_DIR = path.join(__dirname, '..');
const DEFAULT_UNIT = 'mymaestroai.service';
const DEFAULT_LABEL = 'ai.mymaestro.hub';
const RESTART_EXIT = 75;   // lib/restart.js: the hub exits with 75 to be restarted by its supervisor

// A hub started by `mymaestro start` (the installer starts it that way too) gets an allow-listed environment from the
// shell that started it: where things are, language and time zone, proxies and certificates. Not that shell's provider
// keys (OPENAI_API_KEY from ~/.zshrc), tokens, HUB_* settings (an agent's shell carries HUB_AGENT_PERMISSION_MODE=
// bypassPermissions from the hub running it), CLAUDE_CODE_* or NODE_OPTIONS: a hub's settings come from its own .env and
// data/settings.json. Kept: the user's SSH agent (git over SSH for Update when the key lives only in the agent) and where
// the Claude and Codex sign-ins are kept (CLAUDE_CONFIG_DIR, CODEX_HOME): paths of the same user, not secrets. The
// services (plist, unit) set their own short environment and never see the caller's.
const START_ENV_KEEP = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_\w+|TZ|TMPDIR|TMP|TEMP|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|SSL_CERT_(FILE|DIR)|NODE_EXTRA_CA_CERTS|XDG_(CONFIG|CACHE|DATA|STATE)_HOME|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|SSH_AUTH_SOCK|CLAUDE_CONFIG_DIR|CODEX_HOME)$/;
function startEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (START_ENV_KEEP.test(k) && v !== undefined) out[k] = v;
  return out;
}

// What people may have relied on their shell for before starts were allow-listed: provider and web-search keys, the
// port, the shared folder. Each one the caller's shell has but the hub's own config (data/settings.json, .env) lacks gets
// a plain notice naming the variable, never its value, so `mymaestro start` doesn't silently lose a working setup.
const KEY_LABELS = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Gemini', perplexity: 'Perplexity', openrouter: 'OpenRouter',
                     brave: 'Brave Search', serper: 'Serper', tavily: 'Tavily' };
// The variable names lib/settings.js reads (copied, not required: loading settings.js logs, and `mymaestro start` should
// print only what matters; test/service-manager.test.js keeps the copies equal).
const ENV_KEY_MAP = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GEMINI_API_KEY', perplexity: 'PERPLEXITY_API_KEY', openrouter: 'OPENROUTER_API_KEY' };
const SEARCH_ENV_KEY_MAP = { brave: 'BRAVE_SEARCH_API_KEY', serper: 'SERPER_API_KEY', tavily: 'TAVILY_API_KEY' };
function envNotices({ env = process.env, dir = HUB_DIR, fsImpl = fs } = {}) {
  let settings = {};
  try { settings = JSON.parse(fsImpl.readFileSync(path.join(dir, 'data', 'settings.json'), 'utf8')) || {}; } catch { /* none yet */ }
  const envFile = new Set();
  try {
    for (const line of fsImpl.readFileSync(path.join(dir, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);   // the rule server.js loads .env by
      if (m && m[2].trim()) envFile.add(m[1]);
    }
  } catch { /* no .env */ }
  const has = (k) => typeof env[k] === 'string' && env[k].trim() !== '' && !START_ENV_KEEP.test(k);
  const lead = "My Maestro AI no longer passes your shell's settings to the hub";
  const out = [];
  for (const [kind, map, where] of [['providers', ENV_KEY_MAP, 'Settings → LLM Providers'], ['search', SEARCH_ENV_KEY_MAP, 'Settings → Web search']]) {
    for (const [id, name] of Object.entries(map)) {
      if (!has(name) || envFile.has(name)) continue;
      const saved = kind === 'providers' ? settings.providers?.[id]?.apiKey : settings.webSearch?.keys?.[id];
      if (saved) continue;
      out.push(`Your ${KEY_LABELS[id] || id} key (${name}) is only set in this shell. ${lead}, so it won't see it: add the key in ${where}.`);
    }
  }
  const envPath = path.join(dir, '.env');
  if (has('PORT') && !envFile.has('PORT')) out.push(`Your shell sets PORT. ${lead}, so it uses the port in its own .env (8888 when it has none): put PORT=<port> in ${envPath} to keep yours.`);
  if (has('HUB_HOME') && !envFile.has('HUB_HOME')) out.push(`Your shell sets HUB_HOME. ${lead}, so it uses its usual shared folder: put HUB_HOME=<folder> in ${envPath} to keep yours.`);
  return out;
}

/** Words of a command line as a shell splits them (quotes, backslashes; no expansion); ; & | ( ) become separators. */
function shellWords(line) {
  const out = []; let cur = ''; let word = false; let q = null;
  const end = () => { if (word) out.push(cur); cur = ''; word = false; };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q === "'") { if (c === "'") q = null; else cur += c; continue; }
    if (q === '"') { if (c === '"') q = null; else if (c === '\\' && '"\\$`'.includes(line[i + 1] || '')) cur += line[++i]; else cur += c; continue; }
    if (c === "'" || c === '"') { q = c; word = true; continue; }
    if (c === '\\' && i + 1 < line.length) { cur += line[++i]; word = true; continue; }
    if (/\s/.test(c)) { end(); continue; }
    if (';&|()'.includes(c)) { end(); out.push({ op: c }); continue; }
    cur += c; word = true;
  }
  end();
  return out;
}
const SHELL_NAMES = /^(sh|bash|dash|zsh|ksh)$/;
const NODE_VALUE_OPTS = /^(-r|--require|--import|--loader|--experimental-loader|--title|--env-file|-C|--conditions|--input-type)$/;
// Commands that start nothing: a hub can't be behind them. Anything else the parser doesn't know makes the answer
// "can't tell" rather than being skipped.
const HARMLESS = new Set(['source', '.', 'export', 'set', 'unset', 'true', 'false', ':', 'echo', 'printf', 'ulimit', 'umask', 'sleep', 'wait', 'trap', 'test', '[', '[[', 'exit', 'return', 'shift', 'local', 'declare', 'typeset', 'readonly', 'mkdir', 'touch', 'chmod', 'cat', 'tee', 'logger']);
// Commands that run the rest of the line as the command, after their own options (and, for some, one argument).
const PREFIX_ARGS = { setsid: 0, nohup: 0, time: 0, command: 0, exec: 0, nice: 0, ionice: 0, stdbuf: 0, chrt: 1, timeout: 1, flock: 1, taskset: 1 };
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'fi', 'done']);
/** $HOME, ${HOME} and a leading ~ as the shell would expand them; anything else with $ or ` stays as it is. */
function expandHome(w, home) { return w.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, home).replace(/^~(?=\/|$)/, home); }
/** What a command runs as the hub: the scripts node is given (through env, exec, nohup, setsid, nice, `bash -c '…'`, a
 *  start script, after a `cd <folder>`), the folders `npm start` runs in, and whether anything could not be read (a
 *  command it doesn't know, node -e, sudo, a lost cd, a variable): then the caller can only say "can't tell". */
function commandEntries(words, depth = 0, cwd = null, opts = {}) {
  const { home = os.homedir(), readScript = null } = opts;
  const found = { scripts: [], npmStart: [], opaque: false };
  const cmds = [[]];
  for (const w of words) { if (typeof w === 'object') cmds.push([]); else cmds[cmds.length - 1].push(expandHome(w, home)); }
  const LOST = false;   // a cd the parser could not follow (relative to an unknown folder, a variable, `cd -`)
  for (let cmd of cmds) {
    for (;;) {   // FOO=bar, env [-i] [VAR=…], shell keywords, setsid / nice / timeout 5 …: what follows is the real command
      const w = cmd[0];
      if (w === undefined) break;
      if (/^[A-Za-z_]\w*=/.test(w) || KEYWORDS.has(w)) { cmd = cmd.slice(1); continue; }
      const b = path.basename(w);
      if (b === 'env') { cmd = cmd.slice(1); while (cmd.length && (cmd[0].startsWith('-') || /^[A-Za-z_]\w*=/.test(cmd[0]))) cmd = cmd.slice(1); continue; }
      if (b in PREFIX_ARGS) {
        let i = 1;
        while (i < cmd.length && cmd[i].startsWith('-')) i += /^(-n|-c|-o|-e|-i|--adjustment|--class|--classdata|-k|--kill-after|-s|--signal|-w|--timeout)$/.test(cmd[i]) ? 2 : 1;
        cmd = cmd.slice(i + PREFIX_ARGS[b]);
        continue;
      }
      break;
    }
    if (!cmd.length) continue;
    if (cmd[0] === 'cd') {
      const to = cmd[1] === undefined ? home : cmd[1];
      cwd = /[$`]/.test(to) || to === '-' ? LOST : path.isAbsolute(to) ? to : (typeof cwd === 'string' ? path.join(cwd, to) : LOST);
      continue;
    }
    const at = (f) => (path.isAbsolute(f) ? f : typeof cwd === 'string' ? path.join(cwd, f) : cwd === LOST ? null : f);
    const prog = path.basename(cmd[0]);
    let npmArgs = null;
    if (/^(node|nodejs|node\d+)$/.test(prog)) {
      if (cmd.some((w, i) => i > 0 && /^(-e|--eval|-p|--print)$/.test(w))) { found.opaque = true; continue; }
      let i = 1;
      while (i < cmd.length && cmd[i].startsWith('-')) i += NODE_VALUE_OPTS.test(cmd[i]) ? 2 : 1;
      if (i >= cmd.length) { found.opaque = true; continue; }
      if (/^(npm|npm-cli\.js)$/.test(path.basename(cmd[i]))) npmArgs = cmd.slice(i + 1);   // node …/npm-cli.js start
      else { const f = at(cmd[i]); if (f === null || /[$`%]/.test(f)) found.opaque = true; else found.scripts.push(f); continue; }
    } else if (prog === 'npm') npmArgs = cmd.slice(1);
    else if (SHELL_NAMES.test(prog)) {
      const c = cmd.findIndex((w, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(w));
      let inner = null;
      if (c > 0 && c + 1 < cmd.length && depth < 3) inner = commandEntries(shellWords(cmd[c + 1]), depth + 1, cwd, opts);
      else if (c < 0 && cmd[1] && depth < 3) inner = scriptEntries(at(cmd[1]), depth, cwd, opts);   // bash start.sh
      if (inner) { found.scripts.push(...inner.scripts); found.npmStart.push(...inner.npmStart); found.opaque = found.opaque || inner.opaque; } else found.opaque = true;
      continue;
    } else if (HARMLESS.has(prog) || HARMLESS.has(cmd[0])) continue;
    else if (cmd[0].includes('/') && depth < 3) {   // a start script, run directly
      const inner = scriptEntries(at(cmd[0]), depth, cwd, opts);
      if (inner) { found.scripts.push(...inner.scripts); found.npmStart.push(...inner.npmStart); found.opaque = found.opaque || inner.opaque; } else found.opaque = true;
      continue;
    } else { found.opaque = true; continue; }
    // npm: start (or run start) runs that folder's start script; install / ci / rebuild start nothing; anything else can't be read
    const rest = []; let dir = cwd;
    for (let i = 0; i < npmArgs.length; i++) {
      const w = npmArgs[i];
      const m = w.match(/^(?:--prefix|-C|--workspace|-w)(?:=(.*))?$/);
      if (m) { const v = m[1] !== undefined ? m[1] : npmArgs[++i]; dir = v && !/[$`]/.test(v) ? (path.isAbsolute(v) ? v : typeof cwd === 'string' ? path.join(cwd, v) : LOST) : LOST; continue; }
      if (!w.startsWith('-')) rest.push(w);
    }
    if (rest[0] === 'start' || ((rest[0] === 'run' || rest[0] === 'run-script') && rest[1] === 'start')) {
      if (dir === LOST) found.opaque = true; else found.npmStart.push(typeof dir === 'string' ? dir : '');
    } else if (!['install', 'i', 'ci', 'rebuild'].includes(rest[0])) found.opaque = true;
  }
  return found;
}
/** A start script's commands (a shell script, read through opts.readScript), as commandEntries finds them; null when it
 *  can't be read or isn't a shell script. `$(dirname "$0")` and the like are the script's own folder. */
function scriptEntries(file, depth, cwd, opts) {
  if (!file || !path.isAbsolute(file) || !opts.readScript || /[$`%]/.test(file)) return null;
  let txt; try { txt = opts.readScript(file); } catch { return null; }
  if (typeof txt !== 'string' || txt.length > 65536) return null;
  const first = txt.split('\n', 1)[0];
  if (first.startsWith('#!') && !/(^#!\s*\S*\/(sh|bash|dash|zsh|ksh)\b)|(^#!\s*\S*\/env\s+(sh|bash|dash|zsh|ksh)\b)/.test(first)) return null;
  const dir = path.dirname(file);
  const own = txt
    .replace(/\$\(\s*cd\s+"?\$\(\s*dirname\s+(?:--\s+)?"?\$(?:0|\{0\}|\{BASH_SOURCE(?:\[0\])?\})"?\s*\)"?\s*(?:&&|;)\s*pwd(?:\s+-P)?\s*\)/g, dir)
    .replace(/\$\(\s*dirname\s+(?:--\s+)?"?\$(?:0|\{0\}|\{BASH_SOURCE(?:\[0\])?\})"?\s*\)/g, dir)
    .replace(/\$\{0%\/\*\}/g, dir);
  const words = [];
  for (const line of own.split('\n')) { const l = line.replace(/^\s*#.*$/, ''); if (l.trim()) { words.push(...shellWords(l), { op: ';' }); } }
  return commandEntries(words, depth + 1, cwd, opts);
}
/** The commands a launchd plist or systemd unit runs (each an argv) and its working directory. */
function serviceCommands(txt, home = os.homedir()) {
  const unxml = (v) => v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  if (/<plist[\s>]/.test(txt)) {
    const list = txt.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
    const prog = txt.match(/<key>Program<\/key>\s*<string>([^<]*)<\/string>/);
    const wd = txt.match(/<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/);
    const workdir = wd ? unxml(wd[1]) : null;
    if (list) return { commands: [[...list[1].matchAll(/<string>([^<]*)<\/string>/g)].map(m => unxml(m[1]))], workdir, loose: [] };
    if (prog) return { commands: [[unxml(prog[1])]], workdir, loose: [] };
    // no argument list at all: any string that is a server.js path still names it
    return { commands: [], workdir, loose: [...txt.matchAll(/<string>([^<]*)<\/string>/g)].map(m => unxml(m[1])).filter(v => v === 'server.js' || v.endsWith('/server.js')) };
  }
  const spec = (v) => v.replace(/%(.)/g, (m, c) => (c === 'h' ? home : c === '%' ? '%' : m));
  const lines = txt.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  let commands = []; let workdir = null;
  for (const line of lines) {
    let m = line.match(/^\s*ExecStart\s*=\s*(.*)$/);
    if (m) {
      const v = m[1].trim();
      if (!v) { commands = []; continue; }   // an empty ExecStart= (a drop-in) clears the list
      commands.push(shellWords(spec(v.replace(/^[-@:+!]+/, ''))));
      continue;
    }
    m = line.match(/^\s*WorkingDirectory\s*=\s*-?(.*?)\s*$/);
    if (m) workdir = m[1] === '~' ? home : spec(m[1]);
  }
  return { commands, workdir, loose: [] };
}
const realFile = (p) => { try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch { return path.resolve(p); } };
/** Whose hub a plist or unit runs: 'ours' when every entry point it names is this folder's server.js (npm start in
 *  this folder counts) and nothing in it is unreadable, 'other' when it names another, 'unknown' otherwise. A start
 *  script it names is read too when opts.readScript is given. */
function serviceOwnership(txt, dir, { home = os.homedir(), real = realFile, readScript = null } = {}) {
  const { commands, workdir, loose } = serviceCommands(String(txt || ''), home);
  const wd = workdir && path.isAbsolute(workdir) && !/[$`%]/.test(workdir) ? workdir : null;
  const mine = real(path.join(dir, 'server.js'));
  const targets = [...loose];
  let opaque = false;
  for (const argv of commands) {
    const e = commandEntries(argv, 0, wd, { home, readScript });
    targets.push(...e.scripts, ...e.npmStart.map(d => path.join(d || wd || '', 'server.js')));   // npm start runs that folder's start script
    opaque = opaque || e.opaque;
  }
  const full = targets.map(t => (path.isAbsolute(t) ? t : wd ? path.join(wd, t) : null));
  if (full.some(f => f !== null && real(f) !== mine)) return 'other';
  if (!full.length || opaque || full.some(f => f === null)) return 'unknown';
  return 'ours';
}
/** Reads a start script for serviceOwnership: a regular file of at most 64 KB. */
function readStartScript(file, fsImpl = fs) {
  const st = fsImpl.statSync(file);
  if (!st.isFile() || st.size > 65536) throw new Error('not a small file');
  return fsImpl.readFileSync(file, 'utf8');
}
/** Whether a launchd plist or systemd unit runs the hub in this folder (and nothing else). */
function runsFolder(txt, dir) {
  return serviceOwnership(txt, dir, { real: (p) => p }) === 'ours' || serviceOwnership(txt, dir) === 'ours';
}
/** A unit's file and drop-ins as systemd would load them, read from disk (for when systemd itself can't be asked). */
function serviceFileText(unit, scope, { home = os.homedir(), uid = (process.getuid ? process.getuid() : 0), runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`, fsImpl = fs } = {}) {
  if (!/^(?:[\w@.:-]|\\x[0-9a-fA-F]{2})+\.service$/.test(String(unit))) return '';   // systemd escapes like \x2d allowed
  // systemd's own search order (systemd.unit(5)): the first file found wins; drop-ins from every directory apply
  const dirs = scope === 'user'
    ? [path.join(home, '.config/systemd/user.control'), path.join(runtimeDir, 'systemd/user.control'), path.join(runtimeDir, 'systemd/transient'), path.join(home, '.config/systemd/user'), '/etc/systemd/user', path.join(runtimeDir, 'systemd/user'), '/run/systemd/user', path.join(home, '.local/share/systemd/user'), '/usr/local/lib/systemd/user', '/usr/lib/systemd/user', '/lib/systemd/user']
    : ['/etc/systemd/system.control', '/run/systemd/system.control', '/run/systemd/transient', '/etc/systemd/system', '/run/systemd/system', '/usr/local/lib/systemd/system', '/usr/lib/systemd/system', '/lib/systemd/system'];
  const names = [unit]; const t = unit.match(/^([\w.:-]+@)[^.]*(\.service)$/); if (t) names.push(t[1] + t[2]);   // a template's instance
  let main = '';
  for (const d of dirs) { for (const n of names) { try { main = fsImpl.readFileSync(path.join(d, n), 'utf8'); break; } catch { /* not here */ } } if (main) break; }
  // drop-ins: applied in file-name order across all directories; a name in a higher directory hides the same name below
  const drops = new Map();
  for (const d of dirs) { for (const n of names) { try { for (const f of fsImpl.readdirSync(path.join(d, `${n}.d`))) if (f.endsWith('.conf') && !drops.has(f)) drops.set(f, path.join(d, `${n}.d`, f)); } catch { /* none */ } } }
  let drop = '';
  for (const f of [...drops.keys()].sort()) { try { drop += '\n' + fsImpl.readFileSync(drops.get(f), 'utf8'); } catch { /* unreadable */ } }
  return main + drop;
}

/** A per-install suffix, so a second hub on this computer gets its own service instead of replacing the first one's. */
function installSuffix(dir) { return require('crypto').createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 8); }

function servicePath(nodeBin, home, platform) {
  const dirs = [path.dirname(nodeBin), path.join(home, '.local', 'bin')];
  if (platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin');
  else dirs.push('/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin');
  return [...new Set(dirs)].join(':');
}

/** The systemd user unit. Output goes to server.log in the program folder, like every other way of running it. */
function renderSystemdUnit({ dir, node, home = os.homedir(), product = 'My Maestro AI' }) {
  return [
    '[Unit]',
    `Description=${product}`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${dir}`,
    `ExecStart=${node} ${path.join(dir, 'server.js')}`,
    'Restart=always',
    'RestartSec=2',
    `Environment=PATH=${servicePath(node, home, 'linux')}`,
    `Environment=HOME=${home}`,
    'Environment=NODE_ENV=production',
    `StandardOutput=append:${path.join(dir, 'server.log')}`,
    `StandardError=append:${path.join(dir, 'server.log')}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function xml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
/** The launchd agent: starts at login, restarted whenever it exits (the hub's own restart exits with 75). */
function renderLaunchdPlist({ label = DEFAULT_LABEL, dir, node, home = os.homedir() }) {
  const log = path.join(dir, 'server.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(path.join(dir, 'server.js'))}</string></array>
  <key>WorkingDirectory</key><string>${xml(dir)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${xml(servicePath(node, home, 'darwin'))}</string>
    <key>HOME</key><string>${xml(home)}</string>
    <key>NODE_ENV</key><string>production</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

function createServiceManager(opts = {}) {
  const dir = opts.dir || HUB_DIR;
  const home = opts.home || os.homedir();
  const platform = opts.platform || process.platform;
  const uid = opts.uid !== undefined ? opts.uid : (process.getuid ? process.getuid() : 0);
  const run = opts.exec || ((cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }));
  const tryRun = (cmd, args) => { try { return { ok: true, out: String(run(cmd, args) || '') }; } catch (e) { return { ok: false, out: String((e.stdout || '') + (e.stderr || '') || e.message) }; } };
  const installFile = path.join(dir, 'data', 'install.json');
  const unitDir = path.join(home, '.config', 'systemd', 'user');
  const agentsDir = path.join(home, 'Library', 'LaunchAgents');

  function readInstall() { try { return JSON.parse(fs.readFileSync(installFile, 'utf8')); } catch { return {}; } }
  function writeInstall(patch) {
    const next = { ...readInstall(), ...patch };
    fs.mkdirSync(path.dirname(installFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(installFile, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    return next;
  }

  /** Which service runs this folder: { kind: 'systemd'|'launchd'|'none', unit?, label? }. */
  function detect() {
    const inst = readInstall();
    if (inst.service === 'systemd' && inst.unit) return { kind: 'systemd', unit: inst.unit };
    if (inst.service === 'launchd' && inst.label) return { kind: 'launchd', label: inst.label };
    if (platform === 'darwin') {
      try {
        for (const f of fs.readdirSync(agentsDir)) {
          if (!f.endsWith('.plist')) continue;
          let txt = '';
          try { txt = fs.readFileSync(path.join(agentsDir, f), 'utf8'); } catch { continue; }   // a broken link or an unreadable file: skip it
          if (runsFolder(txt, dir)) return { kind: 'launchd', label: f.replace(/\.plist$/, '') };
        }
      } catch { /* no agents folder */ }
      return { kind: 'none' };
    }
    try {
      for (const f of fs.readdirSync(unitDir)) {
        if (!f.endsWith('.service')) continue;
        let txt = '';
        try { txt = fs.readFileSync(path.join(unitDir, f), 'utf8'); } catch { continue; }   // a broken link (a removed service) must not end the search
        if (runsFolder(txt, dir)) return { kind: 'systemd', unit: f };
      }
    } catch { /* no user units */ }
    return { kind: 'none' };
  }

  function state() {
    const s = detect();
    if (s.kind === 'systemd') {
      const r = tryRun('systemctl', ['--user', 'is-active', s.unit]);
      const enabled = tryRun('systemctl', ['--user', 'is-enabled', s.unit]);
      return { ...s, active: r.out.trim() === 'active', status: r.out.trim() || 'unknown', enabled: enabled.out.trim() === 'enabled' };
    }
    if (s.kind === 'launchd') {
      const r = tryRun('launchctl', ['print', `gui/${uid}/${s.label}`]);
      return { ...s, active: r.ok && /state = running/.test(r.out), status: r.ok ? ((r.out.match(/state = (\w+)/) || [])[1] || 'loaded') : 'not loaded', enabled: fs.existsSync(path.join(agentsDir, `${s.label}.plist`)) };
    }
    return { kind: 'none', active: false, status: 'no service', enabled: false };
  }

  /** Install and start the service. Returns { ok, kind, notes[] }. */
  /** The service name for this folder: the one it was installed under, else the default unless another folder's hub
   *  already uses it, else the default with this folder's suffix (ai.mymaestro.hub.1a2b3c4d, mymaestroai-1a2b3c4d.service). */
  function serviceName(kind) {
    // the one recorded in data/install.json, or a service already running this folder under any name (the legacy
    // com.agent-hub, a hand-made unit): a reinstall replaces it rather than adding a second service for the same hub
    const found = detect();
    if (found.kind === kind && (found.label || found.unit)) return found.label || found.unit;
    const [file, def, alt] = kind === 'launchd'
      ? [(n) => path.join(agentsDir, `${n}.plist`), DEFAULT_LABEL, `${DEFAULT_LABEL}.${installSuffix(dir)}`]
      : [(n) => path.join(unitDir, n), DEFAULT_UNIT, DEFAULT_UNIT.replace(/\.service$/, `-${installSuffix(dir)}.service`)];
    let txt = null;
    try { txt = fs.readFileSync(file(def), 'utf8'); } catch { return def; }
    return runsFolder(txt, dir) ? def : alt;
  }

  function install({ node = process.execPath, unit = null, label = null } = {}) {
    const notes = [];
    if (platform === 'darwin') {
      label = label || serviceName('launchd');
      fs.mkdirSync(agentsDir, { recursive: true });
      const plist = path.join(agentsDir, `${label}.plist`);
      tryRun('launchctl', ['bootout', `gui/${uid}/${label}`]);   // an older copy of this agent, if loaded
      fs.writeFileSync(plist, renderLaunchdPlist({ label, dir, node, home }), { mode: 0o644 });
      let r = tryRun('launchctl', ['bootstrap', `gui/${uid}`, plist]);
      if (!r.ok) r = tryRun('launchctl', ['load', '-w', plist]);   // older macOS
      if (!r.ok) return { ok: false, kind: 'launchd', error: `launchctl could not load the agent: ${r.out.trim().slice(0, 300)}` };
      writeInstall({ service: 'launchd', label, node, dir });
      notes.push('Starts when you log in to this Mac, and comes back by itself if it stops.');
      return { ok: true, kind: 'launchd', label, notes };
    }
    if (!tryRun('systemctl', ['--user', '--version']).ok) return { ok: false, kind: 'none', error: 'systemd is not available for this user (no "systemctl --user"). Start the hub with: mymaestro start' };
    unit = unit || serviceName('systemd');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(path.join(unitDir, unit), renderSystemdUnit({ dir, node, home }), { mode: 0o644 });
    const steps = [['--user', 'daemon-reload'], ['--user', 'enable', unit], ['--user', 'restart', unit]];
    for (const a of steps) { const r = tryRun('systemctl', a); if (!r.ok) return { ok: false, kind: 'systemd', error: `systemctl ${a.join(' ')} failed: ${r.out.trim().slice(0, 300)}` }; }
    const user = os.userInfo().username;
    const linger = tryRun('loginctl', ['enable-linger', user]);
    if (linger.ok) notes.push('Starts when this computer starts, even before anyone logs in, and comes back by itself if it stops.');
    else notes.push(`Starts when you log in. To start it at boot without logging in, run once: sudo loginctl enable-linger ${user}`);
    writeInstall({ service: 'systemd', unit, node, dir });
    return { ok: true, kind: 'systemd', unit, notes };
  }

  function remove() {
    const s = detect();
    if (s.kind === 'systemd') {
      tryRun('systemctl', ['--user', 'disable', '--now', s.unit]);
      try { fs.unlinkSync(path.join(unitDir, s.unit)); } catch { /* gone */ }
      tryRun('systemctl', ['--user', 'daemon-reload']);
    } else if (s.kind === 'launchd') {
      tryRun('launchctl', ['bootout', `gui/${uid}/${s.label}`]);
      try { fs.unlinkSync(path.join(agentsDir, `${s.label}.plist`)); } catch { /* gone */ }
    }
    writeInstall({ service: 'none', unit: undefined, label: undefined });
    return { ok: true, removed: s };
  }

  const pidFile = path.join(dir, '.server.pid');
  function readPid() { try { const p = Number(fs.readFileSync(pidFile, 'utf8').trim()); return p > 0 ? p : null; } catch { return null; } }
  function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

  function start({ node = readInstall().node || process.execPath } = {}) {
    const s = detect();
    if (s.kind === 'systemd') { const r = tryRun('systemctl', ['--user', 'start', s.unit]); return { ok: r.ok, kind: s.kind, error: r.ok ? null : r.out.trim() }; }
    if (s.kind === 'launchd') {
      const plist = path.join(agentsDir, `${s.label}.plist`);
      let r = tryRun('launchctl', ['bootstrap', `gui/${uid}`, plist]);
      if (!r.ok) r = tryRun('launchctl', ['kickstart', `gui/${uid}/${s.label}`]);
      return { ok: r.ok, kind: s.kind, error: r.ok ? null : r.out.trim() };
    }
    const pid = readPid();
    if (pid && alive(pid)) return { ok: true, kind: 'none', already: true, pid };
    const log = fs.openSync(path.join(dir, 'server.log'), 'a', 0o600);
    const callerEnv = opts.env || process.env;
    const child = (opts.spawn || spawn)(node, [path.join(dir, 'server.js')], { cwd: dir, detached: true, stdio: ['ignore', log, log], env: startEnv(callerEnv) });
    child.unref();
    fs.writeFileSync(pidFile, String(child.pid), { mode: 0o600 });
    let notices = [];
    try { notices = envNotices({ env: callerEnv, dir }); } catch { /* a notice must never stop a start */ }
    return { ok: true, kind: 'none', pid: child.pid, notices };
  }

  async function stop() {
    const s = detect();
    if (s.kind === 'systemd') { const r = tryRun('systemctl', ['--user', 'stop', s.unit]); return { ok: r.ok, kind: s.kind, error: r.ok ? null : r.out.trim() }; }
    if (s.kind === 'launchd') { const r = tryRun('launchctl', ['bootout', `gui/${uid}/${s.label}`]); return { ok: r.ok || /No such process|Could not find/i.test(r.out), kind: s.kind }; }
    const pid = readPid();
    if (!pid || !alive(pid)) return { ok: true, kind: 'none', already: true };
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 60 && alive(pid); i++) await new Promise(r => setTimeout(r, 250));
    if (alive(pid)) process.kill(pid, 'SIGKILL');
    try { fs.unlinkSync(pidFile); } catch { /* gone */ }
    return { ok: true, kind: 'none' };
  }

  async function restart() {
    const s = detect();
    if (s.kind === 'systemd') { const r = tryRun('systemctl', ['--user', 'restart', s.unit]); return { ok: r.ok, kind: s.kind, error: r.ok ? null : r.out.trim() }; }
    if (s.kind === 'launchd') { const r = tryRun('launchctl', ['kickstart', '-k', `gui/${uid}/${s.label}`]); return { ok: r.ok, kind: s.kind, error: r.ok ? null : r.out.trim() }; }
    await stop();
    return start();
  }

  return { dir, home, platform, readInstall, writeInstall, detect, state, install, remove, start, stop, restart, serviceName, unitDir, agentsDir };
}

module.exports = { createServiceManager, renderSystemdUnit, renderLaunchdPlist, servicePath, startEnv, envNotices, ENV_KEY_MAP, SEARCH_ENV_KEY_MAP, runsFolder, serviceOwnership, serviceCommands, commandEntries, shellWords, serviceFileText, readStartScript, installSuffix, START_ENV_KEEP, DEFAULT_UNIT, DEFAULT_LABEL, RESTART_EXIT };
