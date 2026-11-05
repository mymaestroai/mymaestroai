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
const { HUB_HOME } = require('./hub-home');   // share/, users/, medical/, legal/: see lib/hub-home
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
  pauseRecord = path.join(HUB_ROOT, '.restore', 'backup-paused.json'),   // the boxes a backup paused (lib/backup/create)
} = {}) {
  const run = docker || ((args, opts = {}) => new Promise((resolve, reject) => {
    // a test must never reach this computer's real Docker (node --test marks its child processes)
    if (process.env.NODE_TEST_CONTEXT && process.env.MM_TEST_REAL_DOCKER !== '1') return reject(new Error('A test tried to use the real Docker: give createSandbox a docker stand-in.'));
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
    if (docker) { try { const r = await run(['ps', '-a', '--filter', 'name=^hub-agent-', '--format', '{{.Names}}\t{{.Status}}\t{{.Label "agent-hub.agent"}}'], { timeout: 10000 }); containers = r.stdout.trim().split('\n').filter(Boolean).map(l => { const [name, st, label] = l.split('\t'); return { agent: label || name.replace(/^hub-agent-/, ''), container: name, status: st }; }); } catch {} }
    return { docker, imageReady, image, error, defaults: defaults(), containers };
  }

  // ── containers ──
  const containerName = containerNameFor;
  const homeVolume = homeVolumeFor;

  function mountsFor(agent) {
    const ws = workspaceFor(agent);
    const set = new Set([ws]);
    for (const r of rootsFor(agent) || []) {
      const abs = path.resolve(String(r));
      // Never the hub tree, the data directory, the whole share folder or the host temp dirs. Workspaces and the hub
      // home are fine: on new installs the hub home (share/, medical/, legal/...) sits inside the install (lib/hub-home).
      const inHubHomeInsideTree = HUB_HOME.startsWith(HUB_ROOT + path.sep) && abs.startsWith(HUB_HOME + path.sep);
      if ((abs === HUB_ROOT || abs.startsWith(HUB_ROOT + path.sep)) && !abs.startsWith(path.join(HUB_ROOT, 'workspaces') + path.sep) && !inHubHomeInsideTree) continue;
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
  // The host folders a stopped box would mount when started: a box made for other folders (the agent was renamed, its
  // folders changed while a removal failed) is made again rather than started with what it had.
  async function mountedFolders(name) {
    try {
      const r = await run(['inspect', '--format', '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}\n{{end}}{{end}}', name], { timeout: 10000 });
      return r.stdout.split('\n').map(x => x.trim()).filter(Boolean).sort();
    } catch { return null; }
  }

  async function pausedByBackup(name) {
    let ids;
    try { ids = JSON.parse(fs.readFileSync(pauseRecord, 'utf8')).ids; } catch { return false; }
    if (!Array.isArray(ids)) return false;
    let id = '';
    try { id = (await run(['inspect', '--format', '{{.Id}}', name], { timeout: 10000 })).stdout.trim(); } catch { return false; }
    return /^[0-9a-f]{12,64}$/.test(id) && ids.some(x => typeof x === 'string' && /^[0-9a-f]{6,64}$/.test(x) && id.startsWith(x));
  }

  /** ensure(agent, { network }) -> container name; creates and starts the container when missing. */
  async function ensure(agent, opts = {}) { return withLaunch(() => ensureNow(agent, opts)); }   // waits while a backup holds launches
  async function ensureNow(agent, { network = null } = {}) {
    const name = containerName(agent);
    let pending;
    while ((pending = removing.get(name))) await pending.catch(() => {});
    const st = await exists(agent);
    if (st === 'running') return name;
    // outside a backup's hold, a box that backup recorded pausing was left behind: let it go. One paused by someone else
    // (an operator freezing an agent) stays paused: the agent can't start until it is let go by hand.
    if (st === 'paused' && !launchHold) {
      if (await pausedByBackup(name)) { await run(['unpause', name], { timeout: 30000 }); return name; }
      throw Object.assign(new Error(`The agent's box ${name} is paused, and not by a backup. Let it go with "docker unpause ${name}" when that is intended.`), { code: 'EPAUSED' });
    }
    if (st) {
      const had = await mountedFolders(name), want = [...mountsFor(agent)].sort();
      if (had && had.join('\n') === want.join('\n')) { await run(['start', name], { timeout: 30000 }); return name; }
      log(`${name} was made for other folders; making it again`);
      await run(['rm', '-f', name], { timeout: 60000 });
    }
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
  /**
   * remove(agent, { home }) stops and deletes the container; home=true also deletes the client's session volume. A box
   * being removed is known by name from the moment remove() is called, and ensure() for that name waits for the removal
   * (an agent renamed away and straight back must not have its new box removed by the first rename's clean-up).
   */
  const removing = new Map();   // container name -> the removal in progress
  function remove(agent, { home = false } = {}) {
    const name = containerName(agent);
    const prior = removing.get(name);
    const p = (async () => {
      if (prior) await prior.catch(() => {});
      await stop(agent);
      let failed = null;
      try { await run(['rm', '-f', name], { timeout: 30000 }); }
      catch (e) { if (!/no such (container|object)/i.test(`${e.stderr || ''} ${e.message || ''}`)) failed = e; }
      if (home) { try { await run(['volume', 'rm', homeVolume(agent)], { timeout: 30000 }); } catch {} }
      prepared.delete(agent.name);
      if (failed) log(`could not remove ${name}: ${String(failed.stderr || failed.message || '').trim().split('\n')[0]}`);
      else log(`removed ${name}${home ? ' and its home volume' : ''}`);
    })();
    removing.set(name, p);
    const done = () => { if (removing.get(name) === p) removing.delete(name); };
    p.then(done, done);
    return p;
  }
  /**
   * retire(agent, intoDir, { boxed }) -> { result }: a deleted agent's box is removed, and its home folder (the client's
   * sessions) is kept in intoDir as box-home.tar, without the sign-ins copied into it, before the volume goes
   * (lib/agent-archive). Docker not installed: there can be no box. Docker not answering, or not usable by this account
   * (permissions can change back): throws, so the hub tries again later, unless the agent is known to have had no box.
   * A file the copy can't read fails it: the volume is never removed with anything left out.
   */
  async function retire(agent, intoDir, { boxed = null, keepHome = false } = {}) {
    try { await run(['version', '--format', '{{.Server.Version}}'], { timeout: 15000 }); }
    catch (e) {
      if (e.code === 'ENOENT') return { result: 'no Docker here' };
      if (boxed === false) return { result: 'Docker not answering; the agent had no box' };
      throw new Error(`Docker is not answering (${String(e.stderr || e.message || '').trim().split('\n')[0]})`);
    }
    const name = containerName(agent);
    const absent = (e) => /no such (container|volume|object)/i.test(`${e.stderr || ''} ${e.message || ''}`);
    // the box's own image, kept for the copy below (a tag can be rebuilt or pruned between tries)
    const imageNote = path.join(intoDir, '.box-image');
    let box = true;
    try {
      const id = (await run(['container', 'inspect', '--format', '{{.Image}}', name], { timeout: 15000 })).stdout.trim();
      if (/^sha256:[0-9a-f]{64}$/.test(id)) fs.writeFileSync(imageNote, id);
    } catch (e) { if (!absent(e)) throw e; box = false; }
    if (box) await run(['rm', '-f', name], { timeout: 60000 });
    prepared.delete(agent.name);
    const vol = homeVolume(agent);
    let home = !keepHome;   // keepHome: another listed agent has the same box id, so the home folder is still in use
    if (home) { try { await run(['volume', 'inspect', '--format', '{{.Name}}', vol], { timeout: 15000 }); } catch (e) { if (!absent(e)) throw e; home = false; } }
    if (home) {
      // A box of this agent under an earlier name (a rename whose clean-up failed) still uses the volume: it goes first,
      // so nothing writes to the home folder while it is copied.
      const users = (await run(['ps', '-a', '--filter', `volume=${vol}`, '--format', '{{.Names}}'], { timeout: 15000 })).stdout.split('\n').map(x => x.trim()).filter(Boolean);
      for (const u of users) {
        if (!/^hub-agent-/.test(u)) continue;
        const pend = removing.get(u);
        if (pend) await pend.catch(() => {});
        try { await run(['rm', '-f', u], { timeout: 60000 }); }
        catch (e) { if (!/no such (container|object)|already in progress/i.test(`${e.stderr || ''} ${e.message || ''}`)) throw e; }
      }
    }
    const copied = path.join(intoDir, '.box-home-copied');   // a try that copied the home but could not remove the volume
    if (home) {
      let tar = null;
      try { tar = fs.readFileSync(copied, 'utf8').trim(); } catch {}
      if (tar && !/[\\/]/.test(tar) && fs.existsSync(path.join(intoDir, tar))) home = 'copied';
    }
    if (home === true) {
      let noted = null;
      try { const id = fs.readFileSync(imageNote, 'utf8').trim(); if (/^sha256:[0-9a-f]{64}$/.test(id)) noted = id; } catch {}
      const tmp = path.join(intoDir, `box-home.tar.${process.pid}.tmp`);
      const copy = (from) => run(['run', '--rm', '--network', 'none', '--user', `${uid}:${gid}`, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '-v', `${vol}:/box-home:ro`, '-v', `${intoDir}:/bundle`, '--entrypoint', 'tar', from,
        '-C', '/box-home', '--exclude', './.claude/.credentials.json', '--exclude', './.codex/auth.json', '-cf', `/bundle/${path.basename(tmp)}`, '.'], { timeout: 30 * 60 * 1000 });
      try {
        try { await copy(noted || image); }
        catch (e) {
          // the box's own image was pruned since it was noted: the current one has tar as well
          if (!noted || !/no such image|unable to find image|pull access denied/i.test(`${e.stderr || ''} ${e.message || ''}`)) throw e;
          try { fs.unlinkSync(tmp); } catch {}
          await copy(image);
        }
      } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
      let out = path.join(intoDir, 'box-home.tar');
      for (let i = 2; fs.existsSync(out); i++) out = path.join(intoDir, `box-home-${i}.tar`);
      fs.renameSync(tmp, out);
      fs.writeFileSync(copied, path.basename(out));
    }
    if (home) await run(['volume', 'rm', vol], { timeout: 60000 });
    try { fs.unlinkSync(imageNote); } catch {}
    try { fs.unlinkSync(copied); } catch {}
    log(`retired ${name}${box ? '' : ' (no box)'}${home ? '; its home folder is kept with the agent\'s other things' : ''}`);
    return { result: box || home ? `removed${home ? '; home kept as box-home.tar' : ''}` : 'none' };
  }
  async function buildImage({ version = null } = {}) {
    const args = ['build', '-t', image];
    if (version) args.push('--build-arg', `CLAUDE_CODE_VERSION=${version}`);
    args.push(path.join(HUB_ROOT, 'sandbox'));
    const r = await run(args, { timeout: 30 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 });
    dockerOk = null;
    return r;
  }

  return { MODES, DEFAULTS, IMAGE: image, CLIENT_ENV_FORWARD, mode, isSandboxed, defaults, available, status, containerName, mountsFor, ensure, syncCredentials, wrapperPath, prepare, exec, stop, remove, retire, buildImage };
}

/**
 * An agent's box and its home folder (a volume). An agent made since boxes carry its own id (agent.box) has
 * hub-agent-<name>-<id>, so no agent, earlier or later, of the same name ever starts in it, and a renamed agent gets a
 * new box for its new folders on its next turn; its home folder hub-agent-<id>-home goes with it (the client's sessions
 * stay). An older agent keeps hub-agent-<name> and hub-agent-<name>-home.
 */
const boxIdOf = (agent) => { const id = String((agent && agent.box) || ''); return /^[0-9a-f]{8,32}$/.test(id) ? id : null; };
function containerNameFor(agent) {
  const base = `hub-agent-${String(agent.name).replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
  const id = boxIdOf(agent);
  return id ? `${base}-${id}` : base;
}
function homeVolumeFor(agent) {
  const id = boxIdOf(agent);
  return id ? `hub-agent-${id}-home` : `${containerNameFor(agent)}-home`;
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

// Starting agents' boxes can be held while a backup copies their folders on a system that can't check where an opened file
// really is (no /proc): new starts wait, starts already under way finish first (drained), one hold at a time, and never
// longer than its time limit (the backup then counts as spoiled: letGo.timedOut).
let launchHold = null, activeLaunches = 0, drained = null;
async function withLaunch(fn) {
  while (launchHold) await launchHold.wait;
  activeLaunches++;
  try { return await fn(); }
  finally { if (--activeLaunches === 0 && drained) { const r = drained; drained = null; r(); } }
}
// (Never call withLaunch from inside withLaunch: a nested start would wait on a hold that waits for the outer one.)
async function holdLaunches({ timeoutMs = 30 * 60 * 1000, onTimeout = null } = {}) {
  if (launchHold) throw Object.assign(new Error('Another backup is already holding the agents\' boxes.'), { code: 'EBUSY' });
  let release;
  launchHold = { wait: new Promise((r) => { release = r; }) };
  let done = false;
  const letGo = () => { if (done) return; done = true; clearTimeout(timer); launchHold = null; release(); };
  // the limit covers the wait for starts under way too; on time-out the holder's onTimeout lets its paused boxes go at once
  const timer = setTimeout(() => {
    letGo.timedOut = true;
    try { if (onTimeout) onTimeout(); } catch { /* best effort */ }
    letGo();
    if (drained) { const r = drained; drained = null; r(); }
  }, timeoutMs);
  if (timer.unref) timer.unref();
  if (activeLaunches) await new Promise((r) => { drained = r; });
  return letGo;
}

module.exports = { createSandbox, getSandbox, holdLaunches, withLaunch, containerNameFor, homeVolumeFor, MODES, DEFAULTS, IMAGE, CLIENT_ENV_FORWARD };
