'use strict';
/**
 * backup/create.js — make one backup: snapshot (collect.js) → manifest first → tar → gzip → age (format.js) → a
 * temporary file beside its final name in the first place → fsync → rename; then a copy into every other place the same
 * way. The index (data/backups.json) records it. The snapshot folder sits in this computer's backup folder and is
 * removed afterwards, whatever happens.
 *
 *   createBackup(opts) → { id, name, size, sha256, places: [{ kind, dir, file }], manifest }
 * opts: { root, hubHome, home, platform, places: [{ kind: 'local'|'folder', dir } | { kind: 'module', id, label }], modulePlaces (a stand-in for tests), reason: 'manual'|'nightly'|'cli',
 *         working: [agent names busy when it started], hub: { version, commit, channel }, settings, now, onProgress }
 */
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const fmt = require('./format');
const { spawnSync } = require('child_process');

// Can this system say where an opened file really is (Linux's /proc/self/fd)? The snapshot relies on it to keep a boxed agent
// from swapping a folder for a link mid-copy.
function procWorks() {
  if (process.platform !== 'linux') return false;
  let fd; try { fd = fs.openSync(__filename, 'r'); return fs.realpathSync(`/proc/self/fd/${fd}`) === fs.realpathSync(__filename); } catch { return false; } finally { if (fd != null) fs.closeSync(fd); }
}
// Where that check isn't available, hold the boxed agents still while the snapshot copies: the hub's launch gate is taken
// first (starts under way finish, new ones wait), running boxes are written down durably and then paused, and afterwards any
// agent box running that wasn't paused, a failed listing, or a hold that ran past its time limit spoils the copy. The record
// (outside data/, so a restore can't move it) stays until the boxes are verified let go; server.js retries at a start. A
// backup from a terminal (no gate) is refused wherever Docker is present. On a Mac where Docker is installed but not running
// (see dockerDown), there are no running boxes to pause: the gate is still taken, Docker is asked again once it is held and at
// the end of the copy, and if Docker answers at the end the copy is not kept. Elsewhere a Docker that doesn't answer refuses.
function writeDurable(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  fmt.syncDir(path.dirname(file));
}
// Boxes an earlier backup paused and never let go (named in its record): let them go, and say whether they all are. Only an
// explicit "no such container" for that id counts as gone; any other failure (Docker not running yet) keeps the record.
function letGoRecorded(stateFile, run = spawnSync) {
  if (!fs.existsSync(stateFile)) return true;
  // a record that can't be read or doesn't make sense is kept, never taken as "nothing was paused"
  let ids;
  try {
    const rec = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (!rec || !Array.isArray(rec.ids) || !rec.ids.every(x => typeof x === 'string' && /^[0-9a-f]{6,64}$/.test(x))) return false;
    ids = rec.ids;
  } catch { return false; }
  if (ids.length) run('docker', ['unpause', ...ids], { encoding: 'utf8', timeout: 30000 });
  const still = ids.filter(id => {
    const r = run('docker', ['inspect', '-f', '{{.State.Paused}}', id], { encoding: 'utf8', timeout: 10000 });
    if (r.error) return true;
    if (r.status === 0) return String(r.stdout).trim() !== 'false';
    const stderr = String(r.stderr || '').trim();
    return !(r.status === 1 && [`Error: No such object: ${id}`, `Error: No such container: ${id}`, `Error response from daemon: No such container: ${id}`].includes(stderr));
  });
  if (still.length) return false;
  fs.rmSync(stateFile, { force: true });
  return true;
}
// Why `docker ps` failed, for the WORDING of the message only: 'timeout', 'denied' (the text says permission denied) or
// 'other'. Whether Docker is down is never decided from this text (it differs by version and language): see dockerDown().
function dockerFailure(r) {
  if (r && r.error) return r.error.code === 'ETIMEDOUT' ? 'timeout' : 'other';
  const text = `${(r && r.stderr) || ''}\n${(r && r.stdout) || ''}`;
  if (/permission denied/i.test(text)) return 'denied';
  return 'other';
}
function checkFailedText(r, socket = null) {
  const kind = socket === 'denied' ? 'denied' : dockerFailure(r);
  const said = String((r && (r.stderr || (r.error && r.error.message))) || '').trim().split('\n')[0].slice(0, 200);
  if (kind === 'denied') return 'The agents\' boxes could not be checked, so the backup was not made: this user may not use Docker (permission denied on its socket). Give the hub\'s user access to Docker (on Linux, the docker group) or run the hub as a user that has it, then try again.';
  if (kind === 'timeout') return 'The agents\' boxes could not be checked, so the backup was not made: Docker didn\'t answer within 15 seconds. Wait until Docker has finished starting (or restart it), then try again.';
  return `The agents' boxes could not be checked, so the backup was not made${said ? ` (Docker said: ${said})` : ''}. Check that \`docker ps\` works in a terminal, then try again.`;
}

// Which Docker the docker command talks to, asked of the docker CLI itself (`docker context inspect`, which applies
// DOCKER_HOST, DOCKER_CONTEXT and the current context the same way `docker ps` does), without the daemon.
// { local: true, path } for a unix socket on this computer; { local: false } for anything else: tcp://, ssh://, npipe://,
// Windows, or an answer that can't be had (failed or empty), which is never guessed.
function unixPath(host) {
  const h = String(host || '').trim();
  if (!/^unix:\/\//i.test(h)) return null;
  const p = h.slice('unix://'.length);
  return p ? p : null;
}
function dockerEndpoint(run = spawnSync, { env = process.env, platform = process.platform } = {}) {
  if (platform === 'win32') return { local: false, from: 'platform' };
  let r;
  try { r = run('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8', timeout: 5000, env }); } catch { r = null; }
  const out = r && !r.error && r.status === 0 ? String(r.stdout || '').trim() : '';
  if (!out) return { local: false, from: 'unknown' };
  const p = unixPath(out);
  return p ? { local: true, path: p, from: 'cli' } : { local: false, from: 'cli' };
}
// Is anything listening on that socket? 'listening' | 'dead' (missing or refused) | 'denied' | 'unknown' (anything else, or
// no answer within the time). Never throws.
function probeSocket(socketPath, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let done = false, sock = null, timer = null;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { sock && sock.destroy(); } catch {} resolve(v); };
    try {
      sock = require('net').createConnection({ path: socketPath });
      sock.once('connect', () => finish('listening'));
      sock.once('error', (e) => {
        const c = e && e.code;
        finish(c === 'ENOENT' || c === 'ECONNREFUSED' ? 'dead' : (c === 'EACCES' || c === 'EPERM' ? 'denied' : 'unknown'));
      });
      timer = setTimeout(() => finish('unknown'), timeoutMs);
    } catch { finish('unknown'); }
  });
}
// The docker command ran and ended with a non-zero exit code. A spawn error or a null status (killed by a signal) is not that.
function ranAndFailed(r) { return !!r && !r.error && typeof r.status === 'number' && r.status !== 0; }
// Docker is DOWN exactly when, on a Mac, `docker ps` ran and failed, it was asking a unix socket on this computer, and
// nothing is listening there. The error text takes no part. { down, socket }: socket is the probe's answer (or null).
async function dockerDown(r, endpoint, probe, platform) {
  if (platform !== 'darwin' || !ranAndFailed(r)) return { down: false, socket: null };
  if (!endpoint || !endpoint.local || !endpoint.path) return { down: false, socket: null };
  let socket = 'unknown';
  try { socket = await probe(endpoint.path); } catch { socket = 'unknown'; }
  return { down: socket === 'dead', socket };
}

async function holdBoxes(platform, run = spawnSync, { gate = null, stateFile = null, procOk = platform === 'linux' && procWorks(), log = (m) => console.log(m), env = process.env, probeSocket: probe = probeSocket } = {}) {
  if (procOk) return async () => {};
  // a test must never pause this computer's real agent boxes (node --test marks its child processes)
  if (run === spawnSync && process.env.NODE_TEST_CONTEXT) throw Object.assign(new Error('A test tried to pause real agent boxes: give createBackup a _holdBoxes stand-in.'), { code: 'EBOXES' });
  const fail = (m) => Object.assign(new Error(m), { code: 'EBOXES' });
  const docker = (args, o) => run('docker', args, { ...o, env });   // every docker call sees the same environment
  const ps = (...extra) => docker(['ps', '-q', ...extra, '--filter', 'name=^hub-agent-'], { encoding: 'utf8', timeout: 15000 });
  let socketSaid = null, endpoint = null;
  // once the endpoint is known, later checks ask that same socket, whatever the context says meanwhile
  const pinnedPs = (...extra) => docker(['-H', `unix://${endpoint.path}`, 'ps', '-q', ...extra, '--filter', 'name=^hub-agent-'], { encoding: 'utf8', timeout: 15000 });
  const NO_GATE = 'This computer runs agents in boxes: make the backup from Settings → Backups, which holds their boxes still while it copies.';
  const listed = (r) => { if (r.error || r.status !== 0) throw fail(checkFailedText(r, socketSaid)); return String(r.stdout || '').split('\n').map(x => x.trim()).filter(Boolean); };
  const first = ps('-a');
  if (first.error && first.error.code === 'ENOENT') return async () => {};   // no Docker at all: no boxed agents
  if (platform === 'darwin' && ranAndFailed(first)) {
    endpoint = dockerEndpoint(run, { env, platform });
    const d = await dockerDown(first, endpoint, probe, platform);
    socketSaid = d.socket;
    if (d.down) {
      if (!gate) throw fail(NO_GATE);
      return downHold();
    }
  }
  return upHold(first);

  // On a Mac, Docker is installed but isn't running (its socket is gone or refuses): there are no running boxes to pause.
  // The launch gate is held for the whole copy, Docker is asked again right after taking it, and again at the end of the
  // copy on the same socket; if it answers at the end, the copy is not kept.
  // Not proven, and taken as given: a dead socket on a Mac means Docker's VM is stopped (a VM still running behind a dead
  // socket would not be seen); with the gate held this hub starts no box, and boxes are made without a restart policy
  // (lib/sandbox.js), so none starts by itself when Docker does.
  async function downHold() {
    let letGo = null, released = false;
    const release = () => { if (released) return; released = true; if (letGo) letGo(); };
    try {
      letGo = await gate({ onTimeout: () => ({ status: 0 }) });   // nothing is paused, so nothing to let go at the limit
      if (letGo.timedOut) throw fail('The agents\' boxes were busy starting for too long, so the backup was not made. Try again.');
      // Docker may have started between the first look and taking the gate: ask the same socket again before relying on
      // "down". If it answers now, refuse rather than switch to the normal path, which asks whichever Docker is current then.
      const again = pinnedPs('-a');
      if (!again.error && again.status === 0) throw fail('Docker started just as the backup began, so the backup was not made. Try again.');
      const d = await dockerDown(again, endpoint, probe, platform);
      if (!d.down) { socketSaid = d.socket; throw fail(checkFailedText(again, d.socket)); }
      const unsettled = !!(stateFile && fs.existsSync(stateFile));
      log(`[backup] Docker isn't running on this Mac, so there are no running agent boxes to pause; the backup checks again at the end of the copy.${unsettled ? ` (A record of boxes an earlier backup paused is kept for when Docker starts: ${stateFile})` : ''}`);
    } catch (e) { release(); throw e; }
    return async () => {
      let spoiled = null;
      try { spoiled = await endCheck(); } catch (e) { spoiled = fail(COULD_NOT_CHECK); }
      finally { release(); }
      if (letGo && letGo.timedOut) throw fail('The backup took longer than agents can be kept waiting, so it was not kept.');
      if (spoiled) throw spoiled;
    };
  }
  // End of a copy made while Docker was down: still down on the same socket = keep (null); Docker answering at all, or
  // anything else = not kept.
  async function endCheck() {
    const r = pinnedPs('-a');
    if (ranAndFailed(r) && (await dockerDown(r, endpoint, probe, platform)).down) return null;
    if (!r.error && r.status === 0) return fail('Docker started while the backup was copying, so agent activity during the copy could not be ruled out and this backup was not kept. Try again.');
    return fail(COULD_NOT_CHECK);
  }

  async function upHold(firstListing) {
    listed(firstListing);
    if (!gate) throw fail(NO_GATE);
    let running = [], paused = false, unpaused = false;
    const unpauseNow = () => {   // once; the record goes only when it worked
      if (!paused || unpaused) return { status: 0 };
      unpaused = true;
      const r = docker(['unpause', ...running], { encoding: 'utf8', timeout: 30000 });
      if (r.status === 0 && !r.error && stateFile) fs.rmSync(stateFile, { force: true });
      return r;
    };
    const letGo = await gate({ onTimeout: unpauseNow });
    try {
      if (letGo.timedOut) throw fail('The agents\' boxes were busy starting for too long, so the backup was not made. Try again.');
      // an earlier record that can't be settled yet is never overwritten (its boxes would be forgotten)
      if (stateFile && !letGoRecorded(stateFile, (c, a, o) => run(c, a, { ...o, env }))) throw fail(`An earlier backup left agents' boxes paused that can't be let go yet (record: ${stateFile}). Is Docker running? (My Maestro tries again when it starts.)`);
      running = listed(ps('--filter', 'status=running'));
      if (stateFile && running.length) writeDurable(stateFile, { ids: running, at: new Date().toISOString() });   // before pausing
      if (running.length) { paused = true; if (docker(['pause', ...running], { encoding: 'utf8', timeout: 30000 }).status !== 0) throw fail('The agents\' boxes could not be paused for the backup, so it was not made.'); }
    } catch (e) {
      try { unpauseNow(); } finally { letGo(); }
      throw e;
    }
    return async () => {
      let spoiled = null;
      try { const started = listed(ps('--filter', 'status=running')).filter(id => !running.includes(id)); if (started.length) spoiled = fail('An agent\'s box started while the backup was copying, so this backup was not kept. Try again.'); }
      catch (e) { spoiled = e; }
      let u;
      try { u = unpauseNow(); } finally { letGo(); }
      if (u.status !== 0 || u.error) throw fail(`The agents' boxes could not be let go after the backup (My Maestro tries again when it starts). From a terminal: docker unpause ${running.join(' ')}`);
      if (letGo.timedOut) throw fail('The backup took longer than agents can be kept waiting, so it was not kept.');
      if (spoiled) throw spoiled;
    };
  }
}
const COULD_NOT_CHECK = 'Docker started while the backup was copying and the agents\' boxes could not be checked, so this backup was not kept. Try again once Docker has finished starting.';
const keys = require('./keys');
const collect = require('./collect');
const { tarStream } = require('./tar');
const places = require('./places');
const { getModulePlaces } = require('./module-places');

const FORMAT = 'my-maestro-backup';
const FORMAT_VERSION = 1;

function stampFor(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
function freeBytes(dir) { try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return Infinity; } }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
async function syncDir(dir) { let fh; try { fh = await fsp.open(dir, 'r'); await fh.sync(); } catch { /* not every system syncs a folder */ } finally { if (fh) await fh.close().catch(() => {}); } }
async function syncFile(file) { const fh = await fsp.open(file, 'r+'); try { await fh.sync(); } finally { await fh.close(); } }

async function copyInto(src, dir, name) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${name}.partial`);
  try {
    await pipeline(fs.createReadStream(src), fs.createWriteStream(tmp, { flags: 'w', mode: 0o600 }));
    await syncFile(tmp);
    await fsp.rename(tmp, path.join(dir, name));
  } catch (e) { await fsp.rm(tmp, { force: true }).catch(() => {}); throw e; }
  await syncDir(dir);
  return path.join(dir, name);
}

async function createBackup(opts) {
  const { root, hubHome, home = os.homedir(), platform = process.platform, reason = 'manual', working = [], hub = {}, onProgress, gate = null } = opts;
  const settings = opts.settings || keys.hubSettings();
  const now = opts.now || new Date();
  const key = keys.current({ settings });
  if (!key) throw Object.assign(new Error('Backups aren\'t set up yet: choose a backup password first.'), { code: 'ENOKEY' });
  const targets = (opts.places && opts.places.length ? opts.places : [places.localPlace(hubHome)]);
  const first = targets[0];
  await fsp.mkdir(first.dir, { recursive: true, mode: 0o700 });
  // a name no place holds and this computer's record doesn't know (a backup kept only in a folder
  // that is away keeps its name: a new one taking it would replace its record)
  const known = new Set(places.index(root).map(b => b && b.name));
  let name = `my-maestro-ai-${stampFor(now)}.age`;
  for (let n = 2; known.has(name) || targets.some(t => t.kind !== 'module' && fs.existsSync(path.join(t.dir, name))); n++) name = `my-maestro-ai-${stampFor(now)}-${n}.age`;
  const id = name.replace(/\.age$/, '');
  const snapDir = path.join(first.dir, `.snapshot-${id}`);
  const partial = path.join(first.dir, `.${name}.partial`);
  try {
    if (onProgress) onProgress({ step: 'snapshot' });
    const procOk = opts._procOk !== undefined ? opts._procOk : (platform === 'linux' && procWorks());
    const release = await (opts._holdBoxes || holdBoxes)(platform, undefined, { gate, procOk, stateFile: path.join(root, '.restore', 'backup-paused.json') });
    let snap;
    try { snap = await collect.snapshot({ root, hubHome, home, platform }, snapDir, { procOk, ...(opts._snapshot || {}) }); } finally { await release(); }
    const room = freeBytes(first.dir);
    if (room < snap.bytes * 0.7 + 256 * 1024 * 1024) throw Object.assign(new Error(`Not enough free space in ${first.dir} for this backup.`), { code: 'ENOSPC' });
    const agents = readJson(path.join(root, 'data', 'agents.json'));
    const users = readJson(path.join(root, 'data', 'users.json'));
    const manifest = {
      format: FORMAT, formatVersion: FORMAT_VERSION, created: now.toISOString(), reason,
      hub: { version: hub.version || null, commit: hub.commit || null, channel: hub.channel || null },
      platform, arch: process.arch,
      origin: { installDir: root, hubHome, homeDir: home, layout: path.resolve(hubHome) === path.resolve(root, 'hub-home') ? 'inside' : 'beside' },
      label: working.length || snap.unsettled.length ? 'taken while agents worked' : 'taken while agents were idle',
      working, unsettled: snap.unsettled, linksOutside: snap.linksOutside, skipped: snap.skipped || [],
      counts: { agents: Array.isArray(agents) ? agents.length : 0, accounts: Array.isArray(users) ? users.length : (users && Array.isArray(users.users) ? users.users.length : 0), files: snap.files, bytes: snap.bytes },
      keyId: key.keyId,
      notCovered: ['the program, Node and packages (the installer)', 'local AI model files (re-download)', 'Tailscale on a new computer', platform === 'darwin' ? 'the Claude sign-in in the Mac Keychain' : null, 'tools installed outside My Maestro, and their cron jobs'].filter(Boolean),
      entries: snap.entries,
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    if (!key.originKey) throw Object.assign(new Error('This backup key comes from an older test version. Choose "It may have leaked…" in Settings → Backups to make a new one.'), { code: 'EOLDKEY' });
    const info = { created: manifest.created, version: manifest.hub.version, channel: manifest.hub.channel, bytes: snap.bytes, agents: manifest.counts.agents, keyId: key.keyId, label: manifest.label, reason };
    if (onProgress) onProgress({ step: 'archive', bytes: snap.bytes });
    const entryStream = (function* () {
      yield { path: 'manifest.json', type: 'file', data: manifestBytes, mode: 0o600, mtime: now.getTime() };
      for (const e of snap.entries) {
        if (e.type === 'dir') yield { path: e.path, type: 'dir', mode: e.mode, mtime: e.mtime };
        else if (e.type === 'link') yield { path: e.path, type: 'link', linkname: e.linkname, mtime: e.mtime };
        else yield { path: e.path, type: 'file', source: path.join(snapDir, ...e.path.split('/')), size: e.size, mode: e.mode, mtime: e.mtime };
      }
    })();
    // md5 is only what a module's copy is checked against; a FIPS-mode Node refuses it, so it is made only then
    const hash = crypto.createHash('sha256'), md5 = targets.some(t => t.kind === 'module') ? crypto.createHash('md5') : null;
    let size = 0;
    const tee = new Transform({ transform(c, _e, cb) { hash.update(c); if (md5) md5.update(c); size += c.length; cb(null, c); } });
    await pipeline(Readable.from(tarStream(entryStream)), zlib.createGzip({ level: 6 }),
      fmt.createEncryptStream({ recipient: key.pub, stanzas: [key.envelope, fmt.infoStanza(info)], origin: { macKey: key.originKey, manifestSha256: crypto.createHash('sha256').update(manifestBytes).digest('hex') } }), tee,
      fs.createWriteStream(partial, { flags: 'wx', mode: 0o600 }));
    await syncFile(partial);
    const finalPath = path.join(first.dir, name), md5Hex = md5 ? md5.digest('hex') : null, sha256 = hash.digest('hex');
    await fsp.rename(partial, finalPath);
    await syncDir(first.dir);
    const written = [{ kind: first.kind, dir: first.dir, file: finalPath }];
    const record = () => places.recordInIndex(root, { id, name, created: manifest.created, size, sha256, ...(md5Hex ? { md5: md5Hex } : {}), keyId: key.keyId, label: manifest.label, reason, skipped: (manifest.skipped || []).length, version: manifest.hub.version, channel: manifest.hub.channel, agents: manifest.counts.agents, places: written.filter(Boolean) });
    // computer and folder copies first, then the record, then the modules' (long) uploads: a crash during an upload
    // never leaves a local backup unrecorded
    const slots = targets.slice(1).map(() => null);
    for (let i = 0; i < slots.length; i++) {
      const t = targets[i + 1];
      if (t.kind === 'module') continue;
      if (onProgress) onProgress({ step: 'copy', place: t });
      try { slots[i] = { kind: t.kind, dir: t.dir, file: await copyInto(finalPath, t.dir, name) }; }
      catch (e) { slots[i] = { kind: t.kind, dir: t.dir, error: e.message }; }
    }
    const withSlots = () => { written.length = 1; written.push(...slots.filter(Boolean)); };
    withSlots();
    record();
    if (md5) {
      for (let i = 0; i < slots.length; i++) {
        const t = targets[i + 1];
        if (t.kind !== 'module') continue;
        if (onProgress) onProgress({ step: 'copy', place: t });
        try {
          const r = await (opts.modulePlaces || getModulePlaces()).put(t.id, finalPath, name);
          if (r.size !== size) throw new Error(`${t.label || t.id} stored ${r.size} bytes, not ${size}.`);
          if (r.md5 !== md5Hex) throw new Error(`${t.label || t.id} stored a copy that does not match.`);
          slots[i] = { kind: 'module', id: t.id, label: t.label, name, size, fileId: r.id, keyId: key.keyId };
        } catch (e) { slots[i] = { kind: 'module', id: t.id, label: t.label, error: e.message }; }
      }
      withSlots();
      record();
    }
    return { id, name, size, sha256, places: written, manifest };
  } finally {
    await fsp.rm(snapDir, { recursive: true, force: true });
    await fsp.rm(partial, { force: true });
  }
}

module.exports = { holdBoxes, letGoRecorded, dockerFailure, dockerEndpoint, probeSocket, dockerDown, ranAndFailed, procWorks, createBackup, stampFor, FORMAT, FORMAT_VERSION, copyInto };
