'use strict';
// Agent sandboxes: an agent's shell and file system live in a container of its own, built from sandbox/Dockerfile.
//
//   agent.sandbox            'inherit' (default) | 'off' | 'container'
//   settings.sandboxDefaults { member: 'container', admin: 'off' }   what 'inherit' means, by who owns the agent
//
// What the container holds: the agent's own folders (its workspace, its Files folder, its owner's user tree, the
// medical/legal folders when it is on those teams, and any policy.roots), mounted at the SAME paths as on the host
// so the policy gate's path rules keep working; a private home volume for the Claude client's session files; and
// nothing else. No hub data directory, no keys, no other agents. Read-only root, no capabilities, pid and memory
// limits. Gateway-path agents get no network at all (the hub makes their model calls); Claude-client agents get
// the default network because the client itself must reach Anthropic.
//
// How the hub uses it:
//   - Claude-client agents: the SDK is pointed at a wrapper script (data/sandbox/<agent>.sh) that runs the client
//     with `docker exec -i` inside the container, forwarding only the handful of variables the client needs. The
//     hub's own tools (memory, consult, records, the policy gate) stay in the hub process, outside the box.
//   - Gateway-path agents: the hub's shell tool runs its command with `docker exec` instead of on the host.
// Memory, the shared pool, Records and recall are hub tools and are unaffected.
//
// Nothing here is on unless an owner turns it on (or the member default applies and Docker is present).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const HUB_ROOT = path.resolve(__dirname, '..');
const HUB_HOME = path.resolve(HUB_ROOT, '..');
const IMAGE = process.env.HUB_SANDBOX_IMAGE || 'agent-hub-sandbox:latest';
const DEFAULT_WRAPPER_DIR = path.join(HUB_ROOT, 'data', 'sandbox');
const CONTAINER_HOME = '/home/agent';
const MODES = ['inherit', 'off', 'container'];
const DEFAULTS = { member: 'container', admin: 'off' };
// Environment the Claude client needs inside the box; everything else in the hub's environment stays out.
const CLIENT_ENV_FORWARD = ['CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_AGENT_SDK_VERSION', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'NO_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'];

function createSandbox({
  docker = null,                 // (args, opts) => Promise<{ stdout, stderr }>; injected by tests
  getSetting = () => undefined,
  isMemberOwned = () => false,
  rootsFor = () => [],           // (agent) => policy roots on the host
  workspaceFor = (agent) => path.join(HUB_ROOT, 'workspaces', agent.name),
  wrapperDir = DEFAULT_WRAPPER_DIR,
  credentialsFile = path.join(os.homedir(), '.claude', '.credentials.json'),
  uid = typeof process.getuid === 'function' ? process.getuid() : 1000,
  gid = typeof process.getgid === 'function' ? process.getgid() : 1000,
  image = IMAGE,
  log = (...a) => console.log('[sandbox]', ...a),
  now = Date.now,
} = {}) {
  const run = docker || ((args, opts = {}) => new Promise((resolve, reject) => {
    execFile('docker', args, { timeout: opts.timeout || 60000, maxBuffer: opts.maxBuffer || 4 * 1024 * 1024, env: { PATH: process.env.PATH, HOME: process.env.HOME } }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; return reject(err); }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  }));

  let dockerOk = null;           // cached availability (re-probed on failure)
  const prepared = new Map();    // agent name -> { at, wrapper }

  // ── mode ──
  function defaults() {
    const s = getSetting('sandboxDefaults') || {};
    return { member: MODES.includes(s.member) && s.member !== 'inherit' ? s.member : DEFAULTS.member, admin: MODES.includes(s.admin) && s.admin !== 'inherit' ? s.admin : DEFAULTS.admin };
  }
  /** mode(agent) -> 'off' | 'container': the agent's own setting, else the default for who owns it. */
  function mode(agent) {
    if (!agent) return 'off';
    const own = String(agent.sandbox || 'inherit');
    if (own === 'off' || own === 'container') return own;
    const d = defaults();
    return isMemberOwned(agent) ? d.member : d.admin;
  }
  const isSandboxed = (agent) => mode(agent) === 'container';

  // ── availability ──
  async function available() {
    if (dockerOk === true) return true;
    try { await run(['image', 'inspect', image], { timeout: 15000 }); dockerOk = true; return true; }
    catch (e) { dockerOk = false; return false; }
  }
  async function status() {
    let docker = false, imageReady = false, error = null;
    try { await run(['version', '--format', '{{.Server.Version}}'], { timeout: 10000 }); docker = true; } catch (e) { error = 'Docker is not available to the hub user'; }
    if (docker) { try { await run(['image', 'inspect', image], { timeout: 10000 }); imageReady = true; } catch { error = `Sandbox image ${image} is not built (run the build from the Settings page or: docker build -t ${image} sandbox/)`; } }
    let containers = [];
    if (docker) { try { const r = await run(['ps', '-a', '--filter', 'name=^hub-agent-', '--format', '{{.Names}}\t{{.Status}}'], { timeout: 10000 }); containers = r.stdout.trim().split('\n').filter(Boolean).map(l => { const [name, st] = l.split('\t'); return { agent: name.replace(/^hub-agent-/, ''), container: name, status: st }; }); } catch {} }
    return { docker, imageReady, image, error, defaults: defaults(), containers };
  }

  // ── containers ──
  const containerName = (agent) => `hub-agent-${String(agent.name).replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
  const homeVolume = (agent) => `${containerName(agent)}-home`;

  function mountsFor(agent) {
    const ws = workspaceFor(agent);
    const set = new Set([ws]);
    for (const r of rootsFor(agent) || []) {
      const abs = path.resolve(String(r));
      // Never the hub tree, the data directory, the whole share folder or the host temp dirs.
      if (abs === HUB_ROOT || abs.startsWith(HUB_ROOT + path.sep) && !abs.startsWith(path.join(HUB_ROOT, 'workspaces') + path.sep)) continue;
      if (abs === path.join(HUB_HOME, 'share') || abs === os.tmpdir() || abs === '/tmp' || abs === HUB_HOME) continue;
      if (fs.existsSync(abs)) set.add(abs);
    }
    // The agent's own Files folder (share/<name>), the one place it may hand files to the owner.
    const files = path.join(HUB_HOME, 'share', String(agent.name));
    if (fs.existsSync(files)) set.add(files);
    // share/common: the owner's one folder every admin-side agent shares (members get only their own tree).
    const common = path.join(HUB_HOME, 'share', 'common');
    if (!isMemberOwned(agent) && fs.existsSync(common)) set.add(common);
    return [...set];
  }

  async function exists(agent) {
    try { const r = await run(['inspect', '--format', '{{.State.Status}}', containerName(agent)], { timeout: 10000 }); return r.stdout.trim() || 'unknown'; }
    catch { return null; }
  }

  /** ensure(agent, { network }) -> container name; creates and starts the container when missing. */
  async function ensure(agent, { network = null } = {}) {
    const name = containerName(agent);
    const st = await exists(agent);
    if (st === 'running') return name;
    if (st) { await run(['start', name], { timeout: 30000 }); return name; }
    const ws = workspaceFor(agent);
    fs.mkdirSync(ws, { recursive: true });
    const net = network || (String(agent.model || '').startsWith('claude-sdk/') ? 'bridge' : 'none');
    const args = ['create', '--name', name, '--user', `${uid}:${gid}`, '--workdir', ws,
      '--read-only', '--tmpfs', '/tmp:rw,size=512m', '--tmpfs', '/run:rw,size=16m',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '512',
      '--memory', String(getSetting('sandboxMemory') || '4g'), '--cpus', String(getSetting('sandboxCpus') || '2'),
      '--network', net,
      '--env', `HOME=${CONTAINER_HOME}`, '--env', `AGENT_HUB_SANDBOX=${agent.name}`,
      '--label', 'agent-hub=sandbox', '--label', `agent-hub.agent=${agent.name}`,
      '-v', `${homeVolume(agent)}:${CONTAINER_HOME}`];
    for (const m of mountsFor(agent)) args.push('-v', `${m}:${m}`);
    args.push(image);
    await run(args, { timeout: 60000 });
    await run(['start', name], { timeout: 30000 });
    log(`created ${name} (network ${net}; mounts: ${mountsFor(agent).join(', ')})`);
    return name;
  }

  /** The Claude client inside the box needs the owner's Claude sign-in: a private copy in the agent's home volume. */
  async function syncCredentials(agent) {
    if (!fs.existsSync(credentialsFile)) return false;
    const name = containerName(agent);
    const dest = `${CONTAINER_HOME}/.claude/.credentials.json`;
    let stale = true;
    try {
      const r = await run(['exec', name, 'stat', '-c', '%Y', dest], { timeout: 10000 });
      const inBox = Number(r.stdout.trim()) * 1000;
      stale = !(inBox > 0) || fs.statSync(credentialsFile).mtimeMs > inBox + 1000;
    } catch { stale = true; }
    if (!stale) return true;
    await run(['exec', name, 'mkdir', '-p', `${CONTAINER_HOME}/.claude`], { timeout: 10000 });
    await run(['cp', credentialsFile, `${name}:${dest}`], { timeout: 20000 });
    await run(['exec', name, 'chmod', '600', dest], { timeout: 10000 });
    return true;
  }

  /** The script the SDK launches instead of the Claude client: it runs the client inside the agent's container. */
  function wrapperPath(agent) {
    fs.mkdirSync(wrapperDir, { recursive: true, mode: 0o700 });
    const file = path.join(wrapperDir, `${String(agent.name).replace(/[^a-zA-Z0-9_.-]/g, '_')}.sh`);
    const ws = workspaceFor(agent);
    const envArgs = CLIENT_ENV_FORWARD.map(v => `-e ${v}`).join(' ');
    const body = `#!/bin/sh
# Generated by lib/sandbox.js for agent "${agent.name}": runs the Claude client inside its sandbox container.
# docker exec forwards only the listed variables; the hub's keys and the rest of its environment stay outside.
exec docker exec -i -w '${ws}' ${envArgs} '${containerName(agent)}' claude "$@"
`;
    fs.writeFileSync(file, body, { mode: 0o700 });
    fs.chmodSync(file, 0o700);
    return file;
  }

  /**
   * prepare(agent) -> { pathToClaudeCodeExecutable, cwd } for the SDK, or null when the sandbox cannot be used
   * (Docker or the image missing): the caller then withholds the shell rather than running unboxed.
   */
  async function prepare(agent) {
    if (!(await available())) return null;
    await ensure(agent);
    await syncCredentials(agent);
    const wrapper = wrapperPath(agent);
    prepared.set(agent.name, { at: now(), wrapper });
    return { pathToClaudeCodeExecutable: wrapper, cwd: workspaceFor(agent) };
  }

  /** exec(agent, command, { timeoutMs }) -> { stdout, stderr, code }: a shell command inside the agent's container. */
  async function exec(agent, command, { timeoutMs = 120000, cwd = null } = {}) {
    if (!(await available())) throw new Error('sandbox unavailable: Docker or the sandbox image is missing');
    const name = await ensure(agent);
    try {
      const r = await run(['exec', '-w', cwd || workspaceFor(agent), name, 'bash', '-lc', command], { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
      return { stdout: r.stdout, stderr: r.stderr, code: 0 };
    } catch (e) {
      return { stdout: String(e.stdout || ''), stderr: String(e.stderr || e.message || ''), code: typeof e.code === 'number' ? e.code : 1 };
    }
  }

  async function stop(agent) { try { await run(['stop', '-t', '5', containerName(agent)], { timeout: 30000 }); } catch {} }
  /** remove(agent, { home }) stops and deletes the container; home=true also deletes the client's session volume. */
  async function remove(agent, { home = false } = {}) {
    await stop(agent);
    try { await run(['rm', '-f', containerName(agent)], { timeout: 30000 }); } catch {}
    if (home) { try { await run(['volume', 'rm', homeVolume(agent)], { timeout: 30000 }); } catch {} }
    prepared.delete(agent.name);
    log(`removed ${containerName(agent)}${home ? ' and its home volume' : ''}`);
  }
  async function buildImage({ version = null } = {}) {
    const args = ['build', '-t', image];
    if (version) args.push('--build-arg', `CLAUDE_CODE_VERSION=${version}`);
    args.push(path.join(HUB_ROOT, 'sandbox'));
    const r = await run(args, { timeout: 30 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 });
    dockerOk = null;
    return r;
  }

  return { MODES, DEFAULTS, IMAGE: image, CLIENT_ENV_FORWARD, mode, isSandboxed, defaults, available, status, containerName, mountsFor, ensure, syncCredentials, wrapperPath, prepare, exec, stop, remove, buildImage };
}

let singleton = null;
function getSandbox() {
  if (!singleton) {
    const settings = require('./settings');
    const toolPolicy = require('./tool-policy');
    let adminIds = () => new Set();
    try { const auth = require('./auth'); adminIds = () => { try { return new Set(auth.getAuth().admins().map(u => u.id)); } catch { return new Set(); } }; } catch {}
    singleton = createSandbox({
      getSetting: (k) => settings.getSetting(k),
      isMemberOwned: (a) => !!(a && a.owner && !adminIds().has(String(a.owner))),
      rootsFor: (a) => { try { return toolPolicy.policyFor(a).roots; } catch { return []; } },
    });
  }
  return singleton;
}

module.exports = { createSandbox, getSandbox, MODES, DEFAULTS, IMAGE, CLIENT_ENV_FORWARD };
