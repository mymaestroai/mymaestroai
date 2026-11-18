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
// limits. Gateway-path agents get no network at all (the hub makes their model calls); claude-sdk agents get the
// default (bridge) network so their shell keeps the network it always had.
//
// How the hub uses it:
//   - The Claude client NEVER runs in a box, and the owner's Claude sign-in is never copied into one: the client runs
//     on the host, and a boxed Claude agent uses the hub's own tools (the MCP server "hub": Bash, Read, Write...), which
//     act inside the box through `exec` below. (Earlier versions copied ~/.claude/.credentials.json into the box;
//     purgeCredentials and sweepCredentials remove the copies that older versions left behind.)
//   - Gateway-path agents: the hub's shell tool runs its command with `docker exec` instead of on the host.
// Memory, the shared pool, Records and recall are hub tools and are unaffected.
//
// Nothing here is on unless an owner turns it on (or the member default applies and Docker is present).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const HUB_ROOT = path.resolve(__dirname, '..');
const { HUB_HOME } = require('./hub-home');   // share/, users/, medical/, legal/: see lib/hub-home
const { createHomes } = require('./sandbox-homes');   // the agents' home volumes and whose they are
const IMAGE = process.env.HUB_SANDBOX_IMAGE || 'agent-hub-sandbox:latest';
const CONTAINER_HOME = '/home/agent';
const MODES = ['inherit', 'off', 'container'];
const DEFAULTS = { member: 'container', admin: 'off' };
const OLD_CREDENTIALS = `${CONTAINER_HOME}/.claude/.credentials.json`;
// The old wrapper scripts earlier versions wrote for the Claude client in a box: data/sandbox/<agent>.sh
const OLD_WRAPPER_DIR = path.join(HUB_ROOT, 'data', 'sandbox');
const DATA_DIR = path.join(HUB_ROOT, 'data');
const IMAGE_ID_TTL = 60 * 1000;   // how long the sandbox image's id is trusted before Docker is asked again
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const INSTALL_ID = /^[0-9a-f]{32}$/;
const readInstallId = (file) => { try { const s = fs.readFileSync(file, 'utf8').trim(); return INSTALL_ID.test(s) ? s : null; } catch { return null; } };

function createSandbox({
  docker = null,                 // (args, opts) => Promise<{ stdout, stderr }>; injected by tests
  getSetting = () => undefined,
  isMemberOwned = () => false,
  rootsFor = () => [],           // (agent) => policy roots on the host
  workspaceFor = (agent) => path.join(HUB_ROOT, 'workspaces', agent.name),
  uid = typeof process.getuid === 'function' ? process.getuid() : 1000,
  gid = typeof process.getgid === 'function' ? process.getgid() : 1000,
  image = IMAGE,
  log = (...a) => console.log('[sandbox]', ...a),
  now = Date.now,
  pauseRecord = path.join(HUB_ROOT, '.restore', 'backup-paused.json'),   // the boxes a backup paused (lib/backup/create)
  dataDir = DATA_DIR,            // holds install-id; its real path is this install's home label
  ownRoots = () => [path.join(HUB_ROOT, 'workspaces'), HUB_HOME],   // this hub's own folders (an unlabelled box: see ownerOf)
} = {}) {
  const run = docker || ((args, opts = {}) => new Promise((resolve, reject) => {
    // a test must never reach this computer's real Docker (node --test marks its child processes)
    if (process.env.NODE_TEST_CONTEXT && process.env.MM_TEST_REAL_DOCKER !== '1') return reject(new Error('A test tried to use the real Docker: give createSandbox a docker stand-in.'));
    const execOpts = { timeout: opts.timeout || 60000, maxBuffer: opts.maxBuffer || 4 * 1024 * 1024, env: { PATH: process.env.PATH, HOME: process.env.HOME } };
    if (opts.signal) execOpts.signal = opts.signal;   // Stop: ends the local docker client at once
    execFile('docker', args, execOpts, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; return reject(err); }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  }));

  let dockerOk = null;           // cached availability (re-probed on failure)
  const purged = new Set();      // box names already checked for an old sign-in copy in this process (see purgeCredentials)

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
  // folders changed while a removal failed) is made again rather than started with what it had. So is a stopped box made
  // without an init process. The home volume (homeVolume) is kept either way: rm -f does not take named volumes.
  async function mountedFolders(name) {
    try {
      const r = await run(['inspect', '--format', '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}\n{{end}}{{end}}', name], { timeout: 10000 });
      return r.stdout.split('\n').map(x => x.trim()).filter(Boolean).sort();
    } catch { return null; }
  }

  // Whether the box was made with an init process (docker create --init): without one PID 1 never reaps orphaned
  // children, zombies fill the pids limit and the box stops working. true or false from the box itself; null when
  // Docker did not answer (a timeout, a busy daemon): then the box is started as before rather than made again on a guess.
  async function madeWithInit(name) {
    let r;
    try { r = await run(['inspect', '--format', '{{.HostConfig.Init}}', name], { timeout: 10000 }); } catch { return null; }
    return r.stdout.trim() === 'true';
  }

  // ── whose box it is (labels) ──
  // Docker names are global: another copy of your Maestro on this computer (a test copy, a restore, a second install) can
  // hold a box under the same name. Every box this hub makes carries this install's id (data/install-id, made once), the
  // hash of the real path of its data folder (a copy or restore carrying data/ has the same id but another folder) and
  // the hash of the settings it was made with (agent-hub.args: the create flags, the home volume and the image's id; the
  // bind mounts are compared on their own, see driftOf).
  let ident = null, identFailed = null;   // identFailed: why the last try failed (a Status item until one succeeds)
  /** identity() -> { install, home }; throws EINSTALLID when data/install-id can't be read or made. */
  function identity() {
    if (ident) return ident;
    if (process.env.NODE_TEST_CONTEXT && dataDir === DATA_DIR) throw new Error('A test tried to use the real data folder: give createSandbox a dataDir.');
    const file = path.join(dataDir, 'install-id');
    try {
      let id = readInstallId(file);
      if (!id) {
        fs.mkdirSync(dataDir, { recursive: true });
        const made = crypto.randomBytes(16).toString('hex');
        // 'wx': two hubs starting at once on one data folder keep the first id; a damaged file is never overwritten
        try { fs.writeFileSync(file, `${made}\n`, { flag: 'wx', mode: 0o600 }); id = made; }
        catch (e) { if (e.code !== 'EEXIST') throw e; id = readInstallId(file); }
        if (!id) throw new Error(`${file} does not hold an install id`);
      }
      ident = { install: id, home: sha256(fs.realpathSync(dataDir)) };
      identFailed = null;
      return ident;
    } catch (e) {
      identFailed = { file, why: String(e.message || e).split('\n')[0] };
      throw Object.assign(new Error(`Your Maestro couldn't read or make its install id (${e.message}), so it can't tell its agents' boxes from another copy's; this agent's shell and file tools are off until it can.`), { code: 'EINSTALLID' });
    }
  }
  // the agents' home folders (volumes): labelled names, moving older homes into them (lib/sandbox-homes)
  const homes = createHomes({ run: (a, o) => run(a, o), identity, image, uid, gid, log, now, dataDir, legacyName: homeVolumeFor, getSetting,
    // whose a box is, by its id (an interrupted move's old box is looked at again before it goes)
    boxOwner: async (agent, id) => { const o = await ownerOf(agent, id); return o ? o.kind : null; } });
  let imageIdCache = null;   // { id, at }
  /** imageId() -> 'sha256:…' of the sandbox image, or null when Docker didn't say. */
  async function imageId() {
    if (imageIdCache && now() - imageIdCache.at < IMAGE_ID_TTL) return imageIdCache.id;
    let id = '';
    try { id = (await run(['image', 'inspect', '--format', '{{.Id}}', image], { timeout: 15000 })).stdout.trim(); } catch { return null; }
    if (!/^sha256:[0-9a-f]{64}$/.test(id)) return null;
    imageIdCache = { id, at: now() };
    return id;
  }
  const netFor = (agent, network = null) => network || (String(agent.model || '').startsWith('claude-sdk/') ? 'bridge' : 'none');
  // Everything a box is made with apart from its name, its labels, its bind mounts and its image. `home`: the volume it
  // mounts as its home folder (default: this install's labelled home for the agent).
  function boxFlags(agent, net, home = null) {
    return ['--init', '--user', `${uid}:${gid}`, '--workdir', workspaceFor(agent),
      '--read-only', '--tmpfs', '/tmp:rw,size=512m', '--tmpfs', '/run:rw,size=16m',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '512',
      '--memory', String(getSetting('sandboxMemory') || '4g'), '--cpus', String(getSetting('sandboxCpus') || '2'),
      '--network', net,
      '--env', `HOME=${CONTAINER_HOME}`, '--env', `AGENT_HUB_SANDBOX=${agent.name}`,
      '-v', `${home || homes.labelledName(agent)}:${CONTAINER_HOME}`];
  }
  const argsHash = (agent, net, imgId, home = null) => sha256(JSON.stringify([...boxFlags(agent, net, home), imgId]));
  /** labelsFor(agent) -> { labels, image } a box made now carries and is made from, or null when Docker didn't name the image. */
  async function labelsFor(agent, network = null, home = null) {
    const me = identity();
    const img = await imageId();
    if (!img) return null;
    return { image: img, labels: { 'agent-hub': 'sandbox', 'agent-hub.agent': String(agent.name), 'agent-hub.install': me.install, 'agent-hub.home': me.home, 'agent-hub.args': argsHash(agent, netFor(agent, network), img, home) } };
  }
  const absentErr = (e) => /no such container/i.test(`${e && e.stderr || ''} ${e && e.message || ''}`);
  /**
   * labelsOf(name) -> { id, labels }, 'absent' (no such box), or null (Docker didn't answer). The id is the box's own
   * (Docker's container id): whatever is done to the box after this check is done to that id, never to the name, which
   * another copy could give to a new box meanwhile.
   */
  async function labelsOf(name) {
    let r;
    try { r = await run(['inspect', '--type', 'container', '--format', '{{.Id}} {{json .Config.Labels}}', name], { timeout: 10000 }); }
    catch (e) { return absentErr(e) ? 'absent' : null; }
    const out = String(r.stdout || '').trim(), sp = out.indexOf(' ');
    if (sp < 1) return null;
    const id = out.slice(0, sp);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) return null;
    try {
      const o = JSON.parse(out.slice(sp + 1));
      if (o === null) return { id, labels: {} };
      return o && typeof o === 'object' && !Array.isArray(o) ? { id, labels: o } : null;
    } catch { return null; }
  }
  const under = (p, root) => p === root || p.startsWith(root + path.sep);
  /**
   * ownerOf(agent, name) -> null when Docker didn't answer, else { kind, why, other }:
   *   'absent'  no box of that name;
   *   'ours'    this install's box, made with the settings it would be made with now;
   *   'stale'   this install's box made with other settings or an older image, or a box with no install label (made
   *             before boxes were labelled) proved ours (see below): rebuilt when idle, held while busy;
   *   'foreign' another copy's box (another install id, or the same id at another data folder), or a box with no
   *             install label not proved ours: never used, stopped, removed or entered.
   * Every result but 'absent' carries `id`: what is done to the box after the check is done to that id.
   */
  async function ownerOf(agent, name) {
    const got = await labelsOf(name);
    if (got === 'absent') return { kind: 'absent' };
    if (!got) return null;
    const { id, labels } = got;
    const me = identity();
    const inst = labels['agent-hub.install'];
    if (inst !== undefined) {
      if (inst !== me.install) return { kind: 'foreign', id, why: 'it was made by another copy of your Maestro', other: INSTALL_ID.test(String(inst)) ? String(inst).slice(0, 8) : 'unknown' };
      if (labels['agent-hub.home'] !== me.home) return { kind: 'foreign', id, why: 'it was made by a copy of this Maestro that keeps its data in another folder (a test copy or a restore)', other: String(inst).slice(0, 8) };
      const img = await imageId();
      if (!img) return null;
      if (labels['agent-hub.args'] === argsHash(agent, netFor(agent), img)) return { kind: 'ours', id };
      // a box made on the agent's older home after a failed move counts as up to date until the move may be tried again
      const fallback = homes.backoffHome(agent);
      if (fallback && labels['agent-hub.args'] === argsHash(agent, netFor(agent), img, fallback)) return { kind: 'ours', id };
      return { kind: 'stale', id, why: 'it was made with other settings or an older sandbox image' };
    }
    // Made before boxes carried an install label: ours only with positive proof. Every box this hub made carries
    // agent-hub=sandbox and agent-hub.agent=<the agent's name> and mounts the agent's own workspace (which no other copy
    // shares), and each of its other folders is the agent's or this hub's.
    const binds = await mountedFolders(id);
    if (!binds) return null;
    const ws = workspaceFor(agent);
    if (labels['agent-hub'] !== 'sandbox' || labels['agent-hub.agent'] !== String(agent.name) || !binds.includes(ws)) {
      return { kind: 'foreign', id, why: `it has no install label, and nothing shows it is this Maestro's box for ${agent.name}`, other: null };
    }
    const want = mountsFor(agent), roots = (ownRoots() || []).map(r => path.resolve(String(r)));
    const outside = binds.filter(b => !want.includes(b) && !roots.some(r => under(b, r)));
    if (outside.length) return { kind: 'foreign', id, why: `it has no install label and a folder outside this Maestro's (${outside.join(', ')})`, other: null };
    return { kind: 'stale', id, why: 'it was made before boxes were labelled' };
  }
  const foreignBoxes = new Map();   // agent name -> { agent, box, why, other, since }
  const loggedForeign = new Set();
  function foreignError(agent, name, o) {
    const prior = foreignBoxes.get(agent.name);
    foreignBoxes.set(agent.name, { agent: agent.name, box: name, why: o.why, other: o.other, since: prior && prior.box === name ? prior.since : new Date(now()).toISOString() });
    if (once(loggedForeign, `${name}|${o.why}`)) log(`warning: ${name} is not this Maestro's box (${o.why}${o.other ? `; install ${o.other}` : ''}); left as it is, and agent ${agent.name}'s shell and file tools are off until it is gone`);
    return Object.assign(new Error(`The box named ${name} isn't this Maestro's: ${o.why}. Your Maestro doesn't use, stop or remove it, so this agent's shell and file tools are off until that box is gone.`), { code: 'EBOXFOREIGN' });
  }
  // A stopped box made again: plain rm, never -f, so Docker itself refuses to remove a box that is running or paused
  // (another launch started it meanwhile, or a backup froze it). Then the box is used as it is. 'gone' or 'running';
  // throws when the box is still there and not running (paused, or Docker would not remove it).
  async function removeStopped(name, why, target = name) {
    try { await run(['rm', target], { timeout: 60000 }); log(`${name} ${why}; making it again`); return 'gone'; }
    catch (e) {
      let now;
      try { now = (await run(['inspect', '--format', '{{.State.Status}}', target], { timeout: 10000 })).stdout.trim(); }
      catch (ie) {
        if (/no such (container|object)/i.test(`${ie.stderr || ''} ${ie.message || ''}`)) { log(`${name} ${why}; making it again`); return 'gone'; }
        throw e;
      }
      if (now === 'running') { log(`${name} is running again; left as it is`); return 'running'; }
      e.boxState = now;
      throw e;
    }
  }

  async function pausedByBackup(name) {
    let ids;
    try { ids = JSON.parse(fs.readFileSync(pauseRecord, 'utf8')).ids; } catch { return false; }
    if (!Array.isArray(ids)) return false;
    let id = '';
    try { id = (await run(['inspect', '--format', '{{.Id}}', name], { timeout: 10000 })).stdout.trim(); } catch { return false; }
    // the id itself: the box let go is the one the backup paused, even if the name changes hands meanwhile
    return /^[0-9a-f]{12,64}$/.test(id) && ids.some(x => typeof x === 'string' && /^[0-9a-f]{6,64}$/.test(x) && id.startsWith(x)) ? id : false;
  }

  /** ensure(agent, { network }) -> container name; creates and starts the container when missing. */
  async function ensure(agent, opts = {}) { return withLaunch(() => ensureNow(agent, opts)); }   // waits while a backup holds launches
  // One ensure per box at a time: a second caller (a job while a turn starts the box) waits for the first and shares
  // its result, so two callers can never both decide to make the same stopped box again. A removal of the box comes
  // first: a caller arriving while one is pending waits for it rather than sharing an ensure the removal will undo
  // (remove() itself waits for an ensure already in flight).
  async function ensureNow(agent, opts = {}) {
    const name = containerName(agent);
    // A turn-start recheck or a job start never shares another ensure's result (it may have been decided before the
    // folders were looked at, or without looking): it waits for it, then does its own.
    const own = !!(opts.recheck || opts.jobStart);
    for (;;) {
      const pending = removing.get(name);
      if (pending) { await pending.catch(() => {}); continue; }
      const earlier = own ? ensuring.get(name) : null;
      if (earlier) { await earlier.catch(() => {}); continue; }
      break;
    }
    const busy = ensuring.get(name);
    if (busy) return busy;
    const p = ensureOnce(agent, opts).finally(() => { if (ensuring.get(name) === p) ensuring.delete(name); });
    ensuring.set(name, p);
    return p;
  }
  // Every box this returns has had its old Claude sign-in copy removed (purgeCredentials): after a create, start or
  // unpause every time; for a box that was already running, once per process.
  async function ensureOnce(agent, opts = {}) {
    const state = { already: false };
    const name = await startBox(agent, opts, state);
    if (!state.already || !purged.has(name)) { purged.add(name); await purgeCredentials(agent); }
    // older homes kept 7 days after a move go once that time is up (at most hourly)
    try { await homes.prune(); } catch (e) { log(`could not check the older home folders: ${String(e && e.message || e).split('\n')[0]}`); }
    return name;
  }

  /**
   * purgeCredentials(agent) -> true when an old copy of the owner's Claude sign-in was found in the running box and removed.
   * Earlier versions copied ~/.claude/.credentials.json into the box's home; nothing does now. Runs as the box's own user,
   * which owns its home volume. Removes the copy and checks again; if a copy is still there or the check fails, it
   * throws ECREDPURGE, so ensure() rejects and the turn's hands are withheld (the box is checked again next turn).
   */
  async function purgeCredentials(agent) {
    const name = containerName(agent);
    const f = OLD_CREDENTIALS;
    // Remove, then look again: the script fails (exit 3) while a copy is still there, whatever rm said.
    const script = `if [ -e ${f} ] || [ -L ${f} ]; then rm -f ${f} && echo removed; fi; if [ -e ${f} ] || [ -L ${f} ]; then echo still-present; exit 3; fi`;
    try {
      const r = await run(['exec', name, 'sh', '-c', script], { timeout: 15000 });
      const removed = /removed/.test(String(r && r.stdout || ''));
      if (removed) log(`removed an old Claude sign-in copy from ${name}`);
      return removed;
    } catch (e) {
      purged.delete(name);   // looked at again on the next turn
      const why = String(e && (e.stderr || e.stdout || e.message) || e).trim().split('\n')[0];
      log(`could not remove an old Claude sign-in copy from ${name}: ${why}`);
      // Never hand out a box that may still hold the owner's sign-in: ensure() fails, so the turn's hands are withheld.
      throw Object.assign(new Error(`An old copy of the Claude sign-in could not be removed from ${name} (${why}); this agent's tools stay off until it is.`), { code: 'ECREDPURGE' });
    }
  }

  /**
   * sweepCredentials(agents) -> { checked, removed: [names], failed: [{ name, reason }] }: the same removal in the home
   * volumes of the listed agents' boxes (a name, or an agent record when its box has an id of its own), with a throwaway
   * container that has no network, a read-only root and no capabilities. Only the volumes of the agents passed in:
   * another install may share this Docker daemon. A volume that does not exist is skipped.
   */
  async function sweepCredentials(agents = []) {
    const out = { checked: 0, removed: [], failed: [] };
    const seen = new Set();
    const absent = (e) => /no such (container|volume|object)/i.test(`${e && e.stderr || ''} ${e && e.message || ''}`);
    // Remove each copy, then look again: the script fails (exit 3) while any copy is still there.
    const script = 'left=0; for f in /box-home/.claude/.credentials.json /box-home/.claude/.credentials.json.*; do if [ -e "$f" ] || [ -L "$f" ]; then rm -f "$f" && echo removed; fi; if [ -e "$f" ] || [ -L "$f" ]; then left=1; fi; done; if [ "$left" = 1 ]; then echo still-present; exit 3; fi';
    for (const a of agents || []) {
      const rec = typeof a === 'string' ? { name: a } : a;
      if (!rec || !rec.name) continue;
      // this install's labelled home and the older one without labels; never another copy's labelled home
      let vols;
      try { vols = [homes.labelledName(rec), homeVolumeFor(rec)]; } catch { vols = [homeVolumeFor(rec)]; }
      for (const vol of vols) {
        if (seen.has(vol)) continue;
        seen.add(vol);
        try {
          const v = await homes.volumeOwner(vol);
          if (!v) throw new Error(`Docker did not say whose ${vol} is`);
          if (v.kind === 'absent' || v.kind === 'foreign') continue;
          out.checked++;
          const r = await run(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--user', `${uid}:${gid}`, '-v', `${vol}:/box-home`, '--entrypoint', 'sh', image, '-c', script], { timeout: 120000 });
          if (/removed/.test(String(r && r.stdout || '')) && !out.removed.includes(rec.name)) out.removed.push(rec.name);
        } catch (e) {
          out.failed.push({ name: rec.name, reason: String(e && (e.stderr || e.message) || e).trim().split('\n')[0] });
        }
      }
    }
    if (out.removed.length) log(`removed old Claude sign-in copies from ${out.removed.length} box(es): ${out.removed.join(', ')}`);
    else log('no old Claude sign-in copies in boxes');
    if (out.failed.length) log(`could not check ${out.failed.length} box home volume(s): ${out.failed.map(f => `${f.name} (${f.reason})`).join('; ')}`);
    return out;
  }

  // ── a running box with the wrong folders ──
  const inFlight = new Map();    // box name -> exec() calls of this process running in it
  const held = new Map();        // agent name -> { agent, box, extra, holder, since }: boxes kept because work runs in them
  // `${name}|${drift}` keys already logged, per kind of message
  const safe = (fn) => { try { return !!fn(); } catch { return true; } };   // a callback that throws counts as busy
  const loggedWarn = new Set();
  const loggedLacks = new Set();
  const loggedUnchecked = new Set();
  /** driftOf(agent, name) -> null (Docker did not answer) or { missing, extra }, both sorted. */
  async function driftOf(agent, name) {
    const had = await mountedFolders(name);
    if (!had) return null;
    const want = mountsFor(agent);
    return { missing: want.filter(w => !had.includes(w)).sort(), extra: had.filter(h => !want.includes(h)).sort() };
  }
  /** boxIdle(name) -> { idle, holder }: idle only when nothing but the init and the keep-alive runs in the box. */
  async function boxIdle(name) {
    let out;
    try { out = (await run(['top', name, '-eo', 'pid,args'], { timeout: 15000 })).stdout; }
    catch { return { idle: false, holder: 'Docker did not say what runs in it' }; }
    // Idle: exactly the box's own two processes, matched whole: the init docker create --init starts (as PID 1 it shows
    // its whole command line) and the image's keep-alive. Anything else, a second copy of either, or no list at all is work.
    const lines = String(out || '').split('\n').map(l => l.trim()).filter(Boolean).slice(1);
    // The real box shows "/sbin/docker-init -- docker-entrypoint.sh sleep infinity" (the base image's entrypoint script).
    const INIT = /^(?:\/sbin\/docker-init|\/sbin\/tini|\/usr\/bin\/tini|docker-init|tini)(?: -- (?:docker-entrypoint\.sh )?sleep infinity)?$/;
    let inits = 0, keeps = 0;
    for (const l of lines) {
      const args = l.replace(/^\d+\s+/, '');
      if (INIT.test(args) && inits === 0) { inits++; continue; }
      if (args === 'sleep infinity' && keeps === 0) { keeps++; continue; }
      return { idle: false, holder: holderText(args) };
    }
    if (!lines.length) return { idle: false, holder: 'Docker listed nothing running in it' };
    // Both, exactly once: a list with only one of them is not the box as it was made (review r2).
    if (inits !== 1 || keeps !== 1) return { idle: false, holder: 'Docker showed an unexpected process list' };
    return { idle: true, holder: '' };
  }
  // A process's command line as shown in the log and on Status: control characters out, at most 80 characters.
  const holderText = (s) => String(s || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 80);
  const once = (set, key) => { if (set.has(key)) return false; set.add(key); return true; };
  const list = (a) => a.length ? a.join(', ') : 'none';
  function readinessItems() {
    const items = [...held.values()].map(h => ({
      id: 'sandbox-held-' + h.agent, level: 'warn', title: `${h.agent}'s box is waiting to be rebuilt`,
      detail: `${h.reason || `It still has a folder it may no longer use (${h.extra.join(', ')})`}, and something is running in it (${h.holder}), since ${h.since}. Its shell and file tools are off until that work ends; the box is then rebuilt.`,
      fix: 'Stop the job or command running in that box, or wait for it to end.',
    }));
    for (const f of foreignBoxes.values()) items.push({
      id: 'sandbox-foreign-' + f.agent, level: 'warn', title: `${f.agent}'s box isn't this Maestro's`,
      detail: `The box ${f.box} isn't this Maestro's: ${f.why}${f.other ? ` (install ${f.other})` : ''}, since ${f.since}. Your Maestro doesn't use, stop or remove it, so ${f.agent}'s shell and file tools are off until it is gone.`,
      fix: `Stop the other copy of your Maestro that uses this computer's Docker, or, if that copy is gone, remove the box with "docker rm -f ${f.box}". ${f.agent} gets a new box at its next turn.`,
    });
    try { items.push(...homes.readinessItems()); } catch { /* the record is read again next time */ }
    if (identFailed) items.push({
      id: 'sandbox-install-id', level: 'warn', title: "Your Maestro can't read its install id",
      detail: `${identFailed.file} can't be read or made (${identFailed.why}), so your Maestro can't tell its agents' boxes from another copy's, and the shell and file tools of every agent that works in a box are off.`,
      fix: `Restore ${identFailed.file} from a backup. Without one, remove the file: your Maestro makes a new id, and Settings → Status then lists each agent's existing box as not this Maestro's, with the command that removes it (the agents' home folders stay); each agent gets a new box at its next turn.`,
    });
    return items;
  }

  async function startBox(agent, { network = null, recheck = false, jobStart = false, busy = null } = {}, state = {}) {
    const name = containerName(agent);
    let pending;
    while ((pending = removing.get(name))) await pending.catch(() => {});
    // a move of the agent's home a restart interrupted: started over, or finished (lib/sandbox-homes resume)
    await homes.resume(agent);
    let st = await exists(agent);
    // A box whose folders can't be read could still hold one the agent may no longer use: no new work starts in it.
    const unchecked = () => {
      if (once(loggedUnchecked, name)) log(`${name}: could not check its folders (Docker did not answer); no new work starts in it until they can be checked`);
      return Object.assign(new Error("Your Maestro couldn't check this agent's box (Docker didn't answer), so nothing new starts in it until it can; work already running in it goes on. It is checked again at the next turn or job."), { code: 'EBOXUNCHECKED' });
    };
    // Whose box it is, read before anything is done to it: another copy's box is never used, stopped, removed or entered.
    // (a paused box is let go or refused below without a check, except while a backup holds launches)
    let o = null;
    if (st && (st !== 'running' || jobStart || recheck) && (st !== 'paused' || launchHold)) {
      o = await ownerOf(agent, name);
      if (!o) throw unchecked();
      if (o.kind === 'absent') st = null;
      else if (o.kind === 'foreign') throw foreignError(agent, name, o);
      else foreignBoxes.delete(agent.name);
    }
    const stale = !!o && o.kind === 'stale';
    // Before an old box goes: the home it mounts. An older home without labels is moved into this install's labelled
    // one (the box is already stopped) -> 'moved', the old box gone. When the move fails or waits out its back-off, the
    // new box is made on that older home, untouched (homeOverride) -> null, and the caller removes the old box.
    let homeOverride = null;
    const moveHomeOf = async (id) => {
      const from = await homes.homeOfBox(id);
      if (from === null) throw unchecked();
      if (!from || from === homes.labelledName(agent)) return null;
      const v = await homes.volumeOwner(from);
      if (!v) throw unchecked();
      if (v.kind !== 'unlabelled') return null;
      if (homes.mayTry(agent) && (await homes.adopt(agent, { id, name }, from)) === 'moved') return 'moved';
      homeOverride = from;
      return null;
    };
    if (st === 'running' && jobStart) {
      const d = await driftOf(agent, name); if (d) loggedUnchecked.delete(name);
      if (!d) throw unchecked();
      if (d.extra.length) throw Object.assign(new Error(`This agent's box still has a folder it may no longer use (${d.extra.join(', ')}), so new background jobs can't start in it until the box is rebuilt with its current folders at the agent's next turn after the work running in it ends.`), { code: 'EBOXHELD' });
      if (stale) throw Object.assign(new Error(`This agent's box needs to be rebuilt (${o.why}), so new background jobs can't start in it until it is rebuilt at the agent's next turn after the work running in it ends.`), { code: 'EBOXHELD' });
    } else if (st === 'running' && recheck) {
      const d = await driftOf(agent, name); if (d) loggedUnchecked.delete(name);
      if (!d) {
        throw unchecked();
      } else if (!d.missing.length && !d.extra.length && !stale) {
        held.delete(agent.name);
      } else {
        let idle = (inFlight.get(name) || 0) === 0;
        if (idle && busy && safe(busy)) idle = false;
        let holder = '';
        if (idle) { const t = await boxIdle(name); idle = t.idle; holder = t.holder; }
        else holder = (inFlight.get(name) || 0) > 0 ? 'a command is running' : 'a temporary worker of this agent is running';
        const key = `${name}|${JSON.stringify(d)}|${stale ? o.why : ''}`;
        if (idle) {
          if (d.missing.length || d.extra.length) log(`${name} has other folders than agent ${agent.name} should (missing: ${list(d.missing)}; extra: ${list(d.extra)}); making it again`);
          else log(`${name} needs to be rebuilt for agent ${agent.name} (${o.why}); making it again`);
          try { await run(['stop', '-t', '5', o.id], { timeout: 30000 }); } catch {}
          if ((await moveHomeOf(o.id)) !== 'moved') await run(['rm', '-f', o.id], { timeout: 60000 });
          held.delete(agent.name);
          purged.delete(name);
          st = null;
        } else if (d.extra.length || stale) {
          // what makes it wait: a folder it may no longer use, or the settings it was made with
          const reason = d.extra.length ? `It still has a folder it may no longer use (${d.extra.join(', ')})` : `It needs to be rebuilt: ${o.why}`;
          const prior = held.get(agent.name);
          held.set(agent.name, { agent: agent.name, box: name, extra: d.extra, reason, holder, since: prior && prior.box === name ? prior.since : new Date(now()).toISOString() });
          if (d.extra.length) {
            if (once(loggedWarn, key)) log(`warning: ${name} still has folders agent ${agent.name} may no longer use (extra: ${list(d.extra)}); something runs in it (${holder}); its shell and file tools are held until it is idle`);
            throw Object.assign(new Error(`This agent's box still has a folder it may no longer use (${d.extra.join(', ')}), and something is running in it (${holder}), so its shell and file tools are off for this turn. The box is rebuilt with its current folders at its first turn after that work ends.`), { code: 'EBOXHELD' });
          }
          if (once(loggedWarn, key)) log(`warning: ${name} needs to be rebuilt for agent ${agent.name} (${o.why}); something runs in it (${holder}); its shell and file tools are held until it is idle`);
          throw Object.assign(new Error(`This agent's box needs to be rebuilt (${o.why}), and something is running in it (${holder}), so its shell and file tools are off for this turn. The box is rebuilt at its first turn after that work ends.`), { code: 'EBOXHELD' });
        } else {
          held.delete(agent.name);
          if (once(loggedLacks, key)) log(`${name} lacks folders agent ${agent.name} should have (missing: ${list(d.missing)}); left as it is while something runs in it (${holder}); rebuilt at a later turn`);
        }
      }
    }
    if (st === 'running') { state.already = true; return name; }
    // outside a backup's hold, a box that backup recorded pausing was left behind: let it go. One paused by someone else
    // (an operator freezing an agent) stays paused: the agent can't start until it is let go by hand.
    if (st === 'paused' && !launchHold) {
      const pausedId = await pausedByBackup(name);
      if (pausedId) { await run(['unpause', pausedId], { timeout: 30000 }); return name; }
      throw Object.assign(new Error(`The agent's box ${name} is paused, and not by a backup. Let it go with "docker unpause ${name}" when that is intended.`), { code: 'EPAUSED' });
    }
    if (st) {
      const had = await mountedFolders(o.id), want = [...mountsFor(agent)].sort();
      const same = !!had && had.join('\n') === want.join('\n');
      if (same && !stale && (await madeWithInit(o.id)) !== false) { await run(['start', o.id], { timeout: 30000 }); return name; }
      let left = (await moveHomeOf(o.id)) === 'moved' ? 'gone' : null;
      if (!left) try { left = await removeStopped(name, !same ? 'was made for other folders' : stale ? `needs to be rebuilt (${o.why})` : 'was made without an init process', o.id); }
      catch (e) {
        // a box made with other settings or an older image is never started as it is
        if (!same || stale || e.boxState === 'paused' || e.boxState === undefined) throw e;
        // the old box won't go, but it has the right folders: start it as before (still without init) rather than
        // leave the agent with no box at all
        log(`${name} was made without an init process but could not be removed (${String(e.stderr || e.message || '').trim().split('\n')[0]}); starting it as it is`);
        await run(['start', o.id], { timeout: 30000 });
        return name;
      }
      if (left === 'running') { state.already = true; return name; }
    }
    const ws = workspaceFor(agent);
    fs.mkdirSync(ws, { recursive: true });
    const net = netFor(agent, network);
    // made from the image's id, so the box is exactly the image its label names (a tag can be rebuilt meanwhile)
    // the home folder: this install's labelled one (made now when missing), or the older one a failed move left in use
    let home = homeOverride;
    // a failed move not yet done: the box goes back on that older home (even when a create failed after it, or the hub
    // stopped), never on the emptied labelled one, until a move succeeds
    if (!home) {
      const f = homes.failedFrom(agent);
      if (f) { const fv = await homes.volumeOwner(f); if (!fv) throw unchecked(); if (fv.kind === 'unlabelled') home = f; }
    }
    if (!home) {
      const before = await homes.volumeOwner(homes.labelledName(agent));
      if (!before) throw unchecked();
      home = await homes.ensureHome(agent);
      // a new home while an older one without labels is there, with no box to show whose it is: left alone, on Status
      if (before.kind === 'absent' && !homes.pending(agent)) await homes.noteOrphan(agent);
    }
    const made = await labelsFor(agent, network, home);
    if (!made) throw unchecked();
    const args = ['create', '--name', name, ...boxFlags(agent, net, home)];
    for (const [k, v] of Object.entries(made.labels)) args.push('--label', `${k}=${v}`);
    for (const m of mountsFor(agent)) args.push('-v', `${m}:${m}`);
    args.push(made.image);
    await run(args, { timeout: 60000 });
    await run(['start', name], { timeout: 30000 });
    log(`created ${name} (network ${net}; home ${home}; mounts: ${mountsFor(agent).join(', ')})`);
    homes.finish(agent);   // a move of its home that got this far is done: the older home is kept 7 days
    held.delete(agent.name);   // a new box has the agent's current folders: nothing is held any more
    foreignBoxes.delete(agent.name);
    return name;
  }

  /** exec(agent, command, { timeoutMs }) -> { stdout, stderr, code }: a shell command inside the agent's container. */
  async function exec(agent, command, { timeoutMs = 120000, cwd = null, signal = null } = {}) {
    if (!(await available())) throw new Error('sandbox unavailable: Docker or the sandbox image is missing');
    if (signal && signal.aborted) return { stdout: '', stderr: '', code: null, aborted: true };
    const name = await ensure(agent);
    if (signal && signal.aborted) return { stdout: '', stderr: '', code: null, aborted: true };
    // The command runs as the leader of its own process group inside the box and records that pid, so a Stop can
    // kill the whole group in there (ending the local docker client alone leaves the command running).
    const execId = crypto.randomBytes(6).toString('hex');
    const pidFile = `/tmp/.hub-exec-${execId}.pid`;
    const cancelFile = `/tmp/.hub-exec-${execId}.cancel`;
    // A Stop that comes before the wrapper wrote its pid leaves the cancel marker: the wrapper looks for it right after
    // writing its pid and before it runs the command, and then exits without running anything.
    const script = `echo $$ > ${pidFile}; if [ -e ${cancelFile} ]; then rm -f ${pidFile} ${cancelFile}; exit 130; fi; bash -lc "$0"; rc=$?; rm -f ${pidFile} ${cancelFile}; exit $rc`;
    // setsid -w: when the exec'd process already leads a group, setsid forks; -w makes it wait and pass the exit code on.
    const args = ['exec', '-w', cwd || workspaceFor(agent), name, 'setsid', '-w', 'bash', '-c', script, command];
    let onAbort = null;
    const aborting = new Promise((resolve) => {
      if (!signal) return;
      onAbort = () => {
        // best effort, never throws; not awaited: Stop should not wait for the two-second grace
        // First the cancel marker, then up to 2 s (20 x 0.1 s) for a wrapper that has not written its pid yet.
        const kill = `touch ${cancelFile}; i=0; while [ ! -s ${pidFile} ] && [ $i -lt 20 ]; do sleep 0.1; i=$((i+1)); done; p=$(cat ${pidFile} 2>/dev/null); if [ -n "$p" ]; then kill -TERM -- -$p 2>/dev/null; sleep 2; kill -KILL -- -$p 2>/dev/null; fi; rm -f ${pidFile}`;
        // bash, not sh: dash's kill does not take "--" before a negative process-group id (a real Docker run showed it)
        try { Promise.resolve(run(['exec', name, 'bash', '-c', kill], { timeout: 15000 })).catch(() => {}); } catch {}
        resolve('aborted');
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    inFlight.set(name, (inFlight.get(name) || 0) + 1);
    try {
      const done = run(args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, signal }).then(r => ({ r }), e => ({ e }));
      const first = await Promise.race([done, aborting]);
      if (first === 'aborted') return { stdout: '', stderr: '', code: null, aborted: true };
      if (first.e) {
        if (signal && signal.aborted) return { stdout: String(first.e.stdout || ''), stderr: String(first.e.stderr || ''), code: null, aborted: true };
        const e = first.e;
        return { stdout: String(e.stdout || ''), stderr: String(e.stderr || e.message || ''), code: typeof e.code === 'number' ? e.code : 1 };
      }
      return { stdout: first.r.stdout, stderr: first.r.stderr, code: 0 };
    } finally {
      const left = (inFlight.get(name) || 1) - 1;
      if (left > 0) inFlight.set(name, left); else inFlight.delete(name);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  // Before a box is stopped or removed: whose it is. Another copy's box: EBOXFOREIGN, left as it is. Docker didn't
  // answer: EBOXUNCHECKED, left as it is. Otherwise 'absent', 'ours' or 'stale'.
  async function mayTouch(agent, name) {
    const o = await ownerOf(agent, name);
    if (!o) throw Object.assign(new Error(`Your Maestro couldn't check whose box ${name} is (Docker didn't answer), so it left the box as it is.`), { code: 'EBOXUNCHECKED' });
    if (o.kind === 'foreign') throw foreignError(agent, name, o);
    return o;
  }
  const stopNow = async (name) => { try { await run(['stop', '-t', '5', name], { timeout: 30000 }); } catch {} };
  async function stop(agent) {
    const name = containerName(agent);
    const o = await mayTouch(agent, name);
    if (o.kind !== 'absent') await stopNow(o.id);
  }
  /**
   * remove(agent, { home }) stops and deletes the container; home=true also deletes the client's session volume. A box
   * being removed is known by name from the moment remove() is called, and ensure() for that name waits for the removal
   * (an agent renamed away and straight back must not have its new box removed by the first rename's clean-up).
   */
  const removing = new Map();   // container name -> the removal in progress
  const ensuring = new Map();   // container name -> the ensure in progress (ensureNow)
  function remove(agent, { home = false } = {}) {
    const name = containerName(agent);
    const prior = removing.get(name);
    const starting = ensuring.get(name);   // an ensure already past its removal wait: let it finish, then remove its box
    const p = (async () => {
      if (prior) await prior.catch(() => {});
      if (starting) await starting.catch(() => {});
      let o;
      try { o = await mayTouch(agent, name); }
      catch (e) { log(`left ${name} as it is: ${String(e.message || e).split('\n')[0]}`); throw e; }
      let failed = null, boxHome = null;
      if (o.kind !== 'absent') {
        if (home) boxHome = await homes.homeOfBox(o.id);   // the home this box (proved this hub's) mounts
        await stopNow(o.id);
        try { await run(['rm', '-f', o.id], { timeout: 30000 }); }
        catch (e) { if (!/no such (container|object)/i.test(`${e.stderr || ''} ${e.message || ''}`)) failed = e; }
      }
      foreignBoxes.delete(agent.name);
      if (home) {
        // this install's labelled home; an older home without labels only when the box proved this hub's mounted it;
        // the older homes kept after a move. Never another copy's home, never an orphan nothing proves.
        const rmVol = async (v) => { try { await run(['volume', 'rm', v], { timeout: 30000 }); } catch (e) { log(`could not remove ${v}: ${String(e.stderr || e.message || '').trim().split('\n')[0]}`); } };
        const lab = homes.labelledName(agent);
        const lv = await homes.volumeOwner(lab);
        if (lv && lv.kind === 'ours') await rmVol(lab);
        if (boxHome && boxHome !== lab) { const bv = await homes.volumeOwner(boxHome); if (bv && bv.kind === 'unlabelled') await rmVol(boxHome); }
        await homes.dropRetired(agent);
      }
      purged.delete(name);
      if (failed) log(`could not remove ${name}: ${String(failed.stderr || failed.message || '').trim().split('\n')[0]}`);
      else { held.delete(agent.name); log(`removed ${name}${home ? ' and its home volume' : ''}`); }   // a held box that is gone holds nothing
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
    // Another copy's box under this name is left as it is, and so is the home folder it uses.
    const whose = await ownerOf(agent, name);
    if (!whose) throw new Error(`Docker did not say whose box ${name} is`);
    if (whose.kind === 'foreign') {
      log(`retired agent ${agent.name} without touching ${name}: ${whose.why}`);
      return { result: `left: the box ${name} isn't this Maestro's (${whose.why}); it and its home folder stay as they are` };
    }
    // the box's own image, kept for the copy below (a tag can be rebuilt or pruned between tries)
    const imageNote = path.join(intoDir, '.box-image');
    // No box when it was checked: nothing to remove (a box another copy makes under the name meanwhile is not looked at).
    let box = whose.kind !== 'absent';
    if (box) {
      try {
        const id = (await run(['container', 'inspect', '--format', '{{.Image}}', whose.id], { timeout: 15000 })).stdout.trim();
        if (/^sha256:[0-9a-f]{64}$/.test(id)) fs.writeFileSync(imageNote, id);
      } catch (e) { if (!absent(e)) throw e; box = false; }
    }
    // the home the box (proved this hub's) mounts, noted for a later try once the box is gone
    const homeNote = path.join(intoDir, '.box-home-volume');
    if (box) {
      const bh = await homes.homeOfBox(whose.id);
      if (bh === null) throw new Error(`Docker did not say which home folder ${name} uses`);
      if (bh) fs.writeFileSync(homeNote, bh);
    }
    let boxHome = null;
    try { const v = fs.readFileSync(homeNote, 'utf8').trim(); if (/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v)) boxHome = v; } catch {}
    if (box) await run(['rm', '-f', whose.id], { timeout: 60000 });
    purged.delete(name);
    // The home to keep: the one the box used, when it is this install's or an older one without labels (the box proved
    // it); else this install's labelled home. Never another copy's, never an orphan nothing proves (left, logged).
    const lab = homes.labelledName(agent);
    const owner = async (v) => { const o2 = await homes.volumeOwner(v); if (!o2) throw new Error(`Docker did not say whose ${v} is`); return o2.kind; };
    let vol = null;
    if (boxHome && ['ours', 'unlabelled'].includes(await owner(boxHome))) vol = boxHome;
    else if ((await owner(lab)) === 'ours') vol = lab;
    const spare = vol !== lab && (await owner(lab)) === 'ours' ? lab : null;   // an empty labelled home a failed move left
    if (!vol && (await owner(homeVolume(agent))) === 'unlabelled') log(`left ${homeVolume(agent)} as it is: nothing shows it is ${agent.name}'s home folder in this Maestro`);
    let home = !keepHome && !!vol;   // keepHome: another listed agent has the same box id, so the home folder is still in use
    if (home) {
      // A box of this agent under an earlier name (a rename whose clean-up failed) still uses the volume: it goes first,
      // so nothing writes to the home folder while it is copied.
      const users = (await run(['ps', '-a', '--filter', `volume=${vol}`, '--format', '{{.Names}}'], { timeout: 15000 })).stdout.split('\n').map(x => x.trim()).filter(Boolean);
      for (const u of users) {
        if (!/^hub-agent-/.test(u)) continue;
        const pend = removing.get(u);
        if (pend) await pend.catch(() => {});
        const o = await ownerOf(agent, u);
        if (!o) throw new Error(`Docker did not say whose box ${u} is`);
        if (o.kind === 'absent') continue;
        // another copy's box still uses the home folder: both stay as they are
        if (o.kind === 'foreign') { log(`kept ${vol}: ${u} uses it and ${o.why}`); home = false; continue; }
        try { await run(['rm', '-f', o.id], { timeout: 60000 }); }
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
    if (!keepHome) {
      if (spare) { try { await run(['volume', 'rm', spare], { timeout: 60000 }); } catch (e) { if (!absent(e)) throw e; } }
      await homes.dropRetired(agent);   // older homes kept after a move go with the agent
    }
    try { fs.unlinkSync(imageNote); } catch {}
    try { fs.unlinkSync(homeNote); } catch {}
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

  return { MODES, DEFAULTS, IMAGE: image, mode, isSandboxed, defaults, available, status, containerName, mountsFor, labelsFor, ensure, purgeCredentials, sweepCredentials, exec, readinessItems, stop, remove, retire, buildImage };
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
    // the policy protects the box's own sign-in folders (/home/agent/.claude) for the agents this says are boxed
    const made = singleton;
    try { toolPolicy.setBoxedProvider((a) => made.isSandboxed(a)); } catch { /* the policy still knows agents that say container */ }
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

/**
 * removeOldWrappers(dir) -> number: deletes the <agent>.sh scripts earlier versions wrote to data/sandbox for the Claude
 * client in a box. Only regular files directly in that folder, named like an agent's wrapper (*.sh), and owned by this user.
 */
function removeOldWrappers(dir = OLD_WRAPPER_DIR) {
  let n = 0, names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  const me = typeof process.getuid === 'function' ? process.getuid() : null;
  for (const f of names) {
    if (!/^[a-zA-Z0-9_.-]+\.sh$/.test(f)) continue;
    const file = path.join(dir, f);
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || (me !== null && st.uid !== me)) continue;
      fs.unlinkSync(file);
      n++;
    } catch { /* best effort */ }
  }
  return n;
}

module.exports = { createSandbox, getSandbox, holdLaunches, withLaunch, containerNameFor, homeVolumeFor, removeOldWrappers, OLD_WRAPPER_DIR, MODES, DEFAULTS, IMAGE };
