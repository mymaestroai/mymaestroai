'use strict';
/**
 * Hub job runner: long-running commands that outlive an agent's turn.
 *
 * Why this exists. The hub starts a fresh SDK process for every reply and that process, with
 * every child it spawned, dies when the reply ends. A command an agent started with `&`, `nohup`
 * or the Bash tool's run_in_background flag is killed the moment the agent stops talking, and
 * nobody is told (2026-09-22: auditor's backtest died 18 s after its turn ended; the agent had
 * reported it as running). Even a correctly detached job could not wake its agent when it ended.
 *
 * What this does. `run()` writes the command to a script under data/jobs/<id>/ and launches it
 * through a small bash wrapper that records the pid and, on exit, the exit code. The wrapper is
 * started as a transient systemd user scope (`systemd-run --user --scope`) so it sits in its own
 * cgroup: it survives the agent's turn AND a hub restart (the hub unit has KillMode=control-group).
 * Where scopes cannot be made (no user bus, linger off, no systemd) it falls back to `setsid`, which survives the turn only:
 * such a job stops if the hub restarts, and says so (restartWarning, the restart route, the readiness list). The scope probe
 * runs with the user bus variables derived when missing, and is asked again at a job start after a failure. A poll
 * loop notices the exit file and hands a "[Job finished]" message to the `notify` callback, which
 * the hub wires to POST /api/chat so the notified agent wakes in a NEW turn with the exit code and
 * output tail, and reports in its own chat. Delivery waits while that agent is busy.
 *
 * Hand-back. A job carries `reportTo`: the agent that consulted the owner (set by the hub from the
 * consultation, or by the tool call). The owner is always the one woken with the raw result, so it
 * can analyse it; when that wake-up turn ends, the hub forwards the owner's reply to `reportTo` as
 * a new turn in the master's chat. If the hub restarts mid-turn the master still gets a notice.
 *
 * On start-up the registry is reloaded: jobs that ended while the hub was down are finalized and
 * announced; jobs whose process is gone without an exit file are marked `lost` and announced too,
 * so a killed job is never silently forgotten.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync, execFile } = require('child_process');
const { DOCKER_KEEP } = require('./child-env');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,79}$/;
const MAX_COMMAND = 20000;
const MAX_RUNNING_PER_OWNER = 4;
const DEFAULT_TIMEOUT_MIN = 6 * 60;
const MAX_TIMEOUT_MIN = 24 * 60;
const TAIL_LINES = 40;
const TAIL_BYTES = 6000;
const RETRY_MS = 15000;
const MAX_DELIVERY_ATTEMPTS = 240; // 1 h of retries at RETRY_MS, per notification
const FOR_OWNER_REMINDER = 'If the person you work for must see your reply, call for_owner; otherwise it stays folded in their chat.';
const TERMINAL = new Set(['finished', 'failed', 'cancelled', 'timed_out', 'lost']);
const START_GRACE_MS = 30000;   // a job without a pid file this long after its start (or 10 polls, if longer) never started
// systemd-run --scope --unit=hub-job-<id> makes hub-job-<id>.scope; systemctl reads a bare name as a .service.
function scopeUnit(unit) { return /\.(scope|service)$/.test(unit) ? unit : `${unit}.scope`; }
// Shown on a job while systemd can't say whether its scope is still running; cleared when it answers again.
const UNKNOWN_NOTE = "Status unknown: this computer's service manager (systemd) isn't answering, so your Maestro can't tell yet whether this job is still running.";

function newId() { return crypto.randomBytes(4).toString('hex'); }
function sq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return `${m}m ${r}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Read the last `lines` lines (at most `bytes` bytes) of a file. */
function tailFile(file, lines = TAIL_LINES, bytes = TAIL_BYTES) {
  let fd;
  try {
    const size = fs.statSync(file).size;
    if (size === 0) return '';
    fd = fs.openSync(file, 'r');
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let text = buf.toString('utf8');
    if (len < size) text = text.slice(text.indexOf('\n') + 1);
    if (!(lines > 0)) return '';
    const arr = text.replace(/\n+$/, '').split('\n');
    return (arr.length > lines ? arr.slice(-lines) : arr).join('\n');
  } catch { return ''; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

const RESTART_WARNING = 'stops if your Maestro restarts';
const PROBE_BACKOFF_MS = 60000;   // after a failed scope probe, the next job start may ask again once this has passed

/**
 * The environment systemd-run --user needs to find the user's service manager. A hub started from a boot-time user
 * service may lack XDG_RUNTIME_DIR / DBUS_SESSION_BUS_ADDRESS: derive them (only when missing, only when the path exists).
 */
function probeEnv(env = process.env, { uid = (process.getuid ? process.getuid() : null), exists = fs.existsSync } = {}) {
  const out = { ...env };
  if (!out.XDG_RUNTIME_DIR && uid !== null && exists(`/run/user/${uid}`)) out.XDG_RUNTIME_DIR = `/run/user/${uid}`;
  if (!out.DBUS_SESSION_BUS_ADDRESS && out.XDG_RUNTIME_DIR && exists(`${out.XDG_RUNTIME_DIR}/bus`)) out.DBUS_SESSION_BUS_ADDRESS = `unix:path=${out.XDG_RUNTIME_DIR}/bus`;
  return out;
}

/** Probe whether transient user scopes can be created from this process. */
function detectSpawnMode({ env = process.env, uid, exists, spawn = spawnSync } = {}) {
  try {
    const r = spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', 'true'], { stdio: 'ignore', timeout: 5000, env: probeEnv(env, { uid, exists }) });
    return r.status === 0 ? 'systemd' : 'setsid';
  } catch { return 'setsid'; }
}

/** Is linger on for this user (read-only: loginctl show-user)? 'yes' | 'no' | null when it can't be read. */
function lingerState(user, run = spawnSync) {
  try {
    const r = run('loginctl', ['show-user', user, '-p', 'Linger'], { encoding: 'utf8', timeout: 3000 });
    const m = r && r.status === 0 && /Linger=(yes|no)/.exec(String(r.stdout || ''));
    return m ? m[1] : null;
  } catch { return null; }
}

/** The same probe without blocking: resolves 'systemd' or 'setsid' (a timeout or any failure is 'setsid'). */
function detectSpawnModeAsync({ env = process.env, uid, exists, execFile: ef = execFile } = {}) {
  return new Promise((resolve) => {
    try {
      ef('systemd-run', ['--user', '--scope', '--quiet', '--collect', 'true'], { timeout: 5000, killSignal: 'SIGKILL', env: probeEnv(env, { uid, exists }) }, (err) => resolve(err ? 'setsid' : 'systemd'));
    } catch { resolve('setsid'); }
  });
}

/** The same linger read without blocking: 'yes' | 'no' | null. */
function lingerStateAsync(user, ef = execFile) {
  return new Promise((resolve) => {
    try {
      ef('loginctl', ['show-user', user, '-p', 'Linger'], { encoding: 'utf8', timeout: 3000, killSignal: 'SIGKILL' }, (err, stdout) => {
        const m = !err && /Linger=(yes|no)/.exec(String(stdout || ''));
        resolve(m ? m[1] : null);
      });
    } catch { resolve(null); }
  });
}

const LINGER_TTL_MS = 10 * 60 * 1000;
const RESTARTING_REFUSAL = 'Your Maestro is restarting; start it again in a minute.';

/**
 * The restart route's gate: null when nothing is at risk or the person confirmed exactly the jobs now at risk; else the answer
 * that lists the jobs. A confirmation is { confirm: true, jobs: [ids the page showed] } and covers only those jobs (order does
 * not matter). { confirm: true } without a list counts only when no unprotected job is running.
 */
function restartGate(runner, body) {
  const jobs = runner.runningUnprotected();
  if (!jobs.length) return null;
  if (body && body.confirm === true && Array.isArray(body.jobs)) {
    const named = new Set(body.jobs.map(String));
    if (named.size === jobs.length && jobs.every(j => named.has(j.id))) return null;
  }
  const names = jobs.map(j => `"${j.name}" (${j.id})`).join(', ');
  return {
    status: 'confirm', needsConfirm: true, jobs,
    message: `${jobs.length === 1 ? 'This job' : 'These jobs'} ${jobs.length === 1 ? 'is' : 'are'} running and will stop if your Maestro restarts: ${names}. Restart anyway?`,
  };
}

class JobRunner {
  /**
   * @param {object} o
   * @param {string} [o.dataDir]
   * @param {(agent:string, message:string, onReply?:(text:string)=>void)=>Promise<void>} o.notify
   *        wake an agent with a message in a new turn; resolve once accepted, reject to retry later;
   *        call onReply (when given) with the agent's full reply when that turn ends
   * @param {(agent:string)=>boolean} [o.isAgentActive]                 delivery waits while this is true
   * @param {(agent:string)=>Promise<boolean>} [o.agentExists]
   * @param {(agent:string)=>Promise<string>} [o.defaultCwd]            per-agent default working directory
   * @param {()=>(string|null)} [o.haltRefusal]   non-null (the refusal text) while the hub is halted: run() refuses and notices wait
   * @param {'auto'|'systemd'|'setsid'} [o.spawnMode]
   * @param {(owner:string)=>object} [o.envFor]   the environment a job's process gets (default: the hub's own)
   */
  constructor(o = {}) {
    this.dataDir = o.dataDir || DEFAULT_DATA_DIR;
    this.dir = path.join(this.dataDir, 'jobs');
    this.indexFile = path.join(this.dir, 'index.json');
    this.notify = o.notify || (async () => {});
    this.isAgentActive = o.isAgentActive || (() => false);
    this.agentExists = o.agentExists || (async () => true);
    // mayReport(from, to, { consultedBy }) -> { ok, reason }: may the job owner's report wake agent `to`? (default: yes)
    this.mayReport = o.mayReport || (async () => ({ ok: true }));
    this.haltRefusal = o.haltRefusal || (() => null);
    this.defaultCwd = o.defaultCwd || (async () => process.cwd());
    // boxFor(owner) -> null (the job runs on the host) or { name, mounts } for a sandboxed owner: the job then runs
    // inside that container (docker exec), never on the host (2026-10-16 review, F05).
    this.boxFor = o.boxFor || (async () => null);
    this.envFor = typeof o.envFor === 'function' ? o.envFor : null;
    // lockboxFor({ agentName, tool, command, cwd, sandboxed }) -> the command lockbox's decision (lib/lockbox/wire); null = no lockbox.
    this.lockboxFor = o.lockboxFor || null;
    this.spawnMode = o.spawnMode && o.spawnMode !== 'auto' ? o.spawnMode : null;
    this._fixedMode = !!this.spawnMode;                  // an explicit mode is never probed again
    this._probe = o.probe || (() => detectSpawnMode());   // the first probe (start-up, before any job) stays synchronous
    this._probeAsync = o.probeAsync || (o.probe ? async () => o.probe() : () => detectSpawnModeAsync());   // retries never block
    this.probeBackoffMs = o.probeBackoffMs === undefined ? PROBE_BACKOFF_MS : o.probeBackoffMs;
    this._probedAt = null;
    this._probing = null;    // the one retry probe in flight (concurrent callers share it)
    this._lingerAsync = o.lingerAsync || ((user) => lingerStateAsync(user));
    this.lingerTtlMs = o.lingerTtlMs === undefined ? LINGER_TTL_MS : o.lingerTtlMs;
    this._linger = null;     // { value, at }: the last linger answer
    this._lingering = null;  // the linger read in flight
    this._refuseJobs = false;   // set once a restart is accepted: no new job may start
    this.pollMs = o.pollMs || 3000;
    // unitActive(unit) -> (a promise of) is the job's systemd scope active? true, false (systemctl says inactive or no such
    // unit), or null when it can't tell (no user bus, a timeout). Asked only while a job has no pid file yet, and never in a
    // way that blocks the hub: a systemctl that hangs is killed after 5 s and counts as "can't tell".
    this.unitActive = o.unitActive || ((unit) => new Promise((resolve) => {
      try {
        execFile('systemctl', ['--user', 'is-active', '--quiet', unit], { timeout: 5000, killSignal: 'SIGKILL', env: probeEnv() }, (err) => {
          if (!err) return resolve(true);
          resolve(err.code === 3 || err.code === 4 ? false : null);   // a timeout or a missing systemctl has no numeric code
        });
      } catch { resolve(null); }
    }));
    this.retryMs = o.retryMs || RETRY_MS;
    this.now = o.now || (() => Date.now());
    this.log = o.log || ((...a) => console.log('[jobs]', ...a));
    this.jobs = new Map();
    this.pending = [];       // notifications waiting for delivery: { jobId, agent, message, attempts, notBefore }
    this._timer = null;
    this._polling = false;
    // Agents on a voice call (lib/voice/call): a job notice or report for such an agent waits in `pending` until the call
    // ends or the person says now (it does not count toward MAX_DELIVERY_ATTEMPTS). "Skip" never drops one (that would break
    // the job's report chain): lib/voice/call treats skip as "after the call" (state 'later'), so there is no onSkip here.
    this.voiceCall = o.voiceCall || null;
    if (this.voiceCall) {
      this.voiceCall.registerProducer('job_notice', { kick: () => this._tick() });
      this.voiceCall.registerProducer('job_report', { kick: () => this._tick() });
    }
    fs.mkdirSync(this.dir, { recursive: true });
    this._load();
  }

  // 'systemd' once seen is kept for good. A 'setsid' answer may only mean the probe ran too early (user bus not up yet), so with
  // { retry: true } (a job start, the readiness check) it is asked again once the back-off has passed.
  // The first probe (before any job, at start-up) is synchronous. A retry never blocks: it runs in the background and the NEXT
  // caller sees its answer; this call answers with what is known now.
  mode({ retry = false } = {}) {
    if (!this.spawnMode) { this.spawnMode = this._probe(); this._probedAt = this.now(); }
    else if (retry && !this._fixedMode && this.spawnMode !== 'systemd' && this.now() - this._probedAt >= this.probeBackoffMs) {
      this.retryProbe();
    }
    return this.spawnMode;
  }

  /** The background retry of the scope probe. Concurrent callers get the same promise (one probe in flight). Never rejects. */
  retryProbe() {
    if (this._probing) return this._probing;
    this._probedAt = this.now();
    const p = (async () => {
      let m = null;
      try { m = await this._probeAsync(); } catch { m = null; }
      if ((m === 'systemd' || m === 'setsid') && !this._fixedMode && this.spawnMode !== 'systemd') this.spawnMode = m;
      this._probedAt = this.now();
    })().finally(() => { if (this._probing === p) this._probing = null; });
    this._probing = p;
    return p;
  }

  /** The last known linger answer ('yes' | 'no' | null); asks again in the background when it is older than 10 minutes. */
  lingerCached(user) {
    if (!this._linger || this.now() - this._linger.at >= this.lingerTtlMs) this.refreshLinger(user);
    return this._linger ? this._linger.value : null;
  }

  /** One linger read in flight at a time; its answer is kept for 10 minutes. Never rejects. */
  refreshLinger(user) {
    if (this._lingering) return this._lingering;
    const p = (async () => {
      let v = null;
      try { v = await this._lingerAsync(user); } catch { v = null; }
      this._linger = { value: v === 'yes' || v === 'no' ? v : null, at: this.now() };
    })().finally(() => { if (this._lingering === p) this._lingering = null; });
    this._lingering = p;
    return p;
  }

  /** From now on no new job starts (a restart was accepted); allowNewJobs() undoes it when the restart could not be started. */
  refuseNewJobs() { this._refuseJobs = true; }
  allowNewJobs() { this._refuseJobs = false; }

  /** Running jobs that a restart of your Maestro would stop (setsid mode). */
  runningUnprotected() {
    return [...this.jobs.values()].filter(j => j.status === 'running' && j.mode !== 'systemd')
      .map(j => ({ id: j.id, name: j.name, owner: j.owner }));
  }

  /** The one readiness line when jobs cannot be made to survive a restart; [] where scopes work. */
  readinessItems({ linger, user = (() => { try { return os.userInfo().username; } catch { return ''; } })(), platform = process.platform } = {}) {
    if (this.mode({ retry: true }) === 'systemd') return [];
    const l = linger === undefined ? this.lingerCached(user) : linger;   // last known answer; a refresh runs in the background
    let fix;
    if (platform !== 'linux') fix = 'This computer has no systemd, so wait for running jobs to finish before you restart your Maestro.';
    else if (l === 'no') fix = `Run once in a terminal: sudo loginctl enable-linger ${user} — then restart your Maestro.`;
    else fix = 'Your Maestro cannot reach this account\'s systemd user bus: start it with XDG_RUNTIME_DIR=/run/user/<your user id> (and DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/<your user id>/bus) set, or run `loginctl enable-linger` for this account, then restart your Maestro.';
    return [{ id: 'jobs-restart', level: 'warn', title: `Background jobs ${RESTART_WARNING}`, detail: 'Jobs agents start with run_job cannot be kept outside your Maestro here, so a restart (the Restart button, an update, a reboot) ends them.', fix }];
  }

  // ── persistence ──────────────────────────────────────────────────────
  _load() {
    try {
      const doc = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      for (const j of doc.jobs || []) this.jobs.set(j.id, j);
      for (const p of doc.pending || []) this.pending.push({ ...p, notBefore: 0 });
    } catch {}
  }
  _save() {
    if (this._stopped) return;
    // in-memory flags and statusNote (a live observation) are never saved
    const doc = { jobs: [...this.jobs.values()].map(({ _spawnFailed, _childExited, _childCode, _deadSince, _stopping, _signaled, statusNote, ...j }) => j), pending: this.pending.map(p => ({ kind: p.kind, jobId: p.jobId, agent: p.agent, message: p.message, attempts: p.attempts })) };
    const tmp = this.indexFile + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(doc, null, 1)); fs.renameSync(tmp, this.indexFile); }
    catch (e) { this.log(`could not save the job registry: ${e.message}`); }   // never let a timer tick throw
  }
  _jobDir(id) { return path.join(this.dir, id); }

  // ── lifecycle ─────────────────────────────────────────────────────────
  /** Reconcile jobs that changed while the hub was down, then start polling. */
  start() {
    this._stopped = false;
    this._reconcile();
    if (!this._timer) {
      this._timer = setInterval(() => this._tick().catch(e => this.log('tick error:', e.message)), this.pollMs);
      if (this._timer.unref) this._timer.unref();
    }
    return this;
  }
  stop() { if (this._timer) clearInterval(this._timer); this._timer = null; this._stopped = true; }

  _reconcile() {
    let changed = false;
    for (const j of this.jobs.values()) {
      if (j.reportTo && j.notifiedAt && !j.replyAt && !j.reportedAt && !this.pending.some(p => p.jobId === j.id)) {
        // The owner was woken before the restart but its reply never came back: tell the master anyway.
        j.replyAt = new Date(this.now()).toISOString();
        this.pending.push({ kind: 'report', jobId: j.id, agent: j.reportTo, message: this.reportMessage(j, null), attempts: 0, notBefore: 0 });
        changed = true;
      }
      if (j.status !== 'running' && j.status !== 'cancelling') continue;
      if (this._finalizeIfExited(j)) { changed = true; continue; }
      // start-up never waits for systemctl: a job that needs systemd's answer is "can't tell" here, and the polls decide
      if (this._judge(j, this._needsScope(j) ? null : false) === false) {
        if (j.status === 'cancelling') { this._finish(j, { status: 'cancelled', exitCode: null, note: 'Cancelled on request.' }); changed = true; continue; }
        this._finish(j, { status: 'lost', exitCode: null, note: 'The process disappeared without an exit code (most likely killed by a hub restart or the OS).' });
        changed = true;
      }
    }
    if (changed) this._save();
  }

  async _tick() {
    if (this._polling || this._stopped) return; this._polling = true;
    try {
      // systemd's answers first, all at once and without blocking the hub (the next tick waits for this one: _polling);
      // the pass below then runs in one go, so nothing (a cancel, a finish) can land in the middle of a decision
      const asked = [...this.jobs.values()].filter(j => (j.status === 'running' || j.status === 'cancelling') && this._needsScope(j));
      const answers = new Map(await Promise.all(asked.map(async j => [j.id, await this._scope(j)])));
      let changed = false;
      for (const j of this.jobs.values()) {
        if (j.status !== 'running' && j.status !== 'cancelling') continue;
        if (this._finalizeIfExited(j)) { changed = true; continue; }
        if (j.status === 'cancelling') this._kill(j);   // the pid file may not have existed when cancel() ran
        if (j.status === 'running' && this.now() - Date.parse(j.startedAt) > j.timeoutMinutes * 60000) {
          this._kill(j);
          this._finish(j, { status: 'timed_out', exitCode: null, note: `Killed by the hub after the ${j.timeoutMinutes}-minute limit.` });
          changed = true;
          continue;
        }
        // an answer counts only while it is still needed: a pid file that appeared meanwhile decides on its own
        const needs = this._needsScope(j);
        if (needs && !answers.has(j.id)) continue;   // started during the wait: asked on the next tick
        const scope = needs ? answers.get(j.id) : false;
        // the note says exactly what is true now: systemd's answer is needed and it couldn't give one
        if (needs && scope === null) j.statusNote = UNKNOWN_NOTE; else delete j.statusNote;
        const alive = this._judge(j, scope);
        if (alive !== false) { delete j._deadSince; continue; }   // alive, or not started yet (a cancel keeps stopping it above)
        // Give the wrapper one poll interval to write the exit file before calling it lost.
        j._deadSince = j._deadSince || this.now();
        if (this.now() - j._deadSince > this.pollMs) {
          if (j.status === 'cancelling') this._finish(j, { status: 'cancelled', exitCode: null, note: 'Cancelled on request.' });
          else this._finish(j, { status: 'lost', exitCode: null, note: 'The process disappeared without an exit code.' });
          changed = true;
        }
      }
      if (changed) this._save();
      await this._deliver();
    } finally { this._polling = false; }
  }

  _pid(j) { try { return parseInt(fs.readFileSync(path.join(this._jobDir(j.id), 'pid'), 'utf8'), 10) || null; } catch { return null; } }

  // Does deciding this job need systemd's answer about its scope? Only a systemd job with no pid file and no proof yet.
  _needsScope(j) {
    if (j.mode !== 'systemd' || !j.unit || j._spawnFailed || this._pid(j)) return false;
    return !(j._childExited && Number.isInteger(j._childCode) && j._childCode > 0);
  }

  // systemd's answer about the job's scope (true / false / null), asked without blocking the hub: systemctl runs as a child
  // process with a time limit, and a check that hangs or fails is null ("can't tell").
  async _scope(j) {
    try { const v = await this.unitActive(scopeUnit(j.unit)); return v === true || v === false ? v : null; } catch { return null; }
  }

  async _alive(j) { return this._judge(j, this._needsScope(j) ? await this._scope(j) : false); }

  // Is the job's process still there? true or false; null while it may not have started yet. run() returns before the
  // wrapper writes its pid, and on a busy computer that can take longer than a poll: until the start grace has passed, a
  // job without a pid file is neither alive nor dead (it used to be reported lost, or "cancelled" and never stopped).
  // `scope` is systemd's answer about the job's scope (true / false / null), false when it wasn't asked.
  _judge(j, scope) {
    const pid = this._pid(j);
    if (pid) return pidAlive(pid);
    if (j._spawnFailed) return false;
    // systemd-run (spawned detached, so setsid forks the wrapper off) exits 0 once the job is handed to its scope; an exit
    // code above 0 with no pid file means the launch itself failed (no user bus, a bad unit): proof, whatever systemctl can
    // answer. A signal is not: setsid may already have forked the wrapper, so that case goes through the scope check below.
    if (j.mode === 'systemd' && j._childExited && Number.isInteger(j._childCode) && j._childCode > 0) return false;
    if (scope === true) return true;
    if (scope === null) return null;   // systemd could not answer: no evidence either way, so never "gone" (a cancel keeps trying)
    if (j._childExited && scope === false) return false;   // the child is gone and systemd confirms no scope
    return this.now() - Date.parse(j.startedAt) < Math.max(START_GRACE_MS, 10 * this.pollMs) ? null : false;
  }

  _finalizeIfExited(j) {
    let code;
    try { code = parseInt(fs.readFileSync(path.join(this._jobDir(j.id), 'exit'), 'utf8'), 10); } catch { return false; }
    if (Number.isNaN(code)) return false;
    if (j.status === 'cancelling') this._finish(j, { status: 'cancelled', exitCode: code, note: 'Cancelled on request.' });
    else this._finish(j, { status: code === 0 ? 'finished' : 'failed', exitCode: code });
    return true;
  }

  _finish(j, { status, exitCode, note }) {
    j.status = status; j.exitCode = exitCode; j.endedAt = new Date(this.now()).toISOString();
    if (note) j.note = note;
    delete j._deadSince; delete j.statusNote;
    this.log(`job ${j.id} "${j.name}" (${j.owner}) ${status}${exitCode !== null && exitCode !== undefined ? ` exit ${exitCode}` : ''}`);
    this.pending.push({ kind: 'result', jobId: j.id, agent: j.owner, message: this.completionMessage(j), attempts: 0, notBefore: 0 });
  }

  /** The owner's wake-up turn ended: forward its reply to the master it was working for. */
  _onReply(j, reply) {
    if (!j.reportTo || j.replyAt) return;
    j.replyAt = new Date(this.now()).toISOString();
    this.pending.push({ kind: 'report', jobId: j.id, agent: j.reportTo, message: this.reportMessage(j, reply), attempts: 0, notBefore: 0 });
    this._save();
  }

  reportMessage(j, reply) {
    const head = `[Job report] Agent "${j.owner}" ran job "${j.name}" (id ${j.id}) for you; it ${j.status === 'finished' ? 'finished (exit 0)' : j.status.replace('_', ' ') + (j.exitCode !== null && j.exitCode !== undefined ? ` (exit ${j.exitCode})` : '')} at ${j.endedAt}.`;
    const body = reply && reply.trim()
      ? `Here is ${j.owner}'s report:

${reply.length > 12000 ? reply.slice(0, 12000) + '\n…(truncated; the full reply is in ' + j.owner + "'s chat)" : reply}`
      : `${j.owner} was woken with the result but its report did not come back (the hub restarted or the turn failed). Consult ${j.owner} for its reading, or read the raw output yourself.`;
    return [head, '', body, '', `Raw output: ${path.join(this._jobDir(j.id), 'out.log')} (job_status with tail_lines shows it)`, '',
      'This is an automatic notice from the hub. Continue the task this job was started for and tell the user in this chat.', FOR_OWNER_REMINDER].join('\n');
  }

  completionMessage(j) {
    const tail = tailFile(path.join(this._jobDir(j.id), 'out.log'));
    const dur = fmtDuration(Date.parse(j.endedAt || new Date(this.now()).toISOString()) - Date.parse(j.startedAt));
    const verb = { finished: 'finished (exit 0)', failed: `FAILED (exit ${j.exitCode})`, cancelled: 'was cancelled', timed_out: 'TIMED OUT', lost: 'was LOST' }[j.status] || j.status;
    return [
      `[Job ${j.status === 'finished' ? 'finished' : 'ended'}] Job "${j.name}" (id ${j.id}), which you started at ${j.startedAt}, ${verb} after ${dur}.`,
      j.note ? j.note : null,
      `Command: ${j.command.length > 300 ? j.command.slice(0, 300) + '…' : j.command}`,
      `Working directory: ${j.cwd}`,
      `Full output: ${path.join(this._jobDir(j.id), 'out.log')} (use job_status with tail_lines for more)`,
      '',
      tail ? `Output (last ${TAIL_LINES} lines):\n\`\`\`\n${tail}\n\`\`\`` : 'Output: (empty)',
      '',
      j.reportTo
        ? `This is an automatic notice from the hub. You ran this job for agent "${j.reportTo}". Read the results, then write this reply AS YOUR REPORT TO ${j.reportTo}: when you finish, the hub forwards your whole reply to ${j.reportTo} automatically, so do not consult it yourself. State the verdict, the numbers that matter, and where the files are.`
        : 'This is an automatic notice from the hub. Read the results the job produced, say what they mean for the task it was started for, and report to the user in this chat.',
      FOR_OWNER_REMINDER,
    ].filter(l => l !== null).join('\n');
  }

  /** What a waiting notification is called among the items held for a voice call. */
  _holdItem(p) {
    const j = this.jobs.get(p.jobId);
    const report = p.kind === 'report';
    return { id: report ? `job:${p.jobId}:report` : `job:${p.jobId}`, kind: report ? 'job_report' : 'job_notice', label: j ? j.name : p.jobId, from: j ? j.owner : null };
  }

  async _deliver() {
    const now = this.now();
    if (this.haltRefusal()) return;   // notices and reports wait; they are delivered after the hub is resumed
    for (const p of [...this.pending]) {
      if (this._stopped) return;
      if (p.notBefore > now) continue;
      if (this.voiceCall && this.voiceCall.holds(p.agent, this._holdItem(p))) continue;   // the person's decision or the end of the call kicks _tick()
      if (this.isAgentActive(p.agent)) { p.notBefore = now + this.retryMs; continue; }
      if (p.kind === 'report') {
        // Owners and grants can change while a job runs: check again right before the report wakes anyone.
        const rj = this.jobs.get(p.jobId);
        let ok;
        try { ok = rj ? await this.mayReport(rj.owner, rj.reportTo, { consultedBy: rj.reportViaConsult ? rj.reportTo : null }) : { ok: false, reason: 'the job record is missing' }; }   // no record to check against: nothing is delivered
        catch (e) { ok = { ok: false, reason: `the permission check failed: ${e.message}` }; }
        if (!ok || !ok.ok) {
          const reason = (ok && ok.reason) || 'not allowed';
          const at = this.pending.indexOf(p); if (at >= 0) this.pending.splice(at, 1);
          if (rj) rj.note = (rj.note ? rj.note + ' ' : '') + `Report to ${rj.reportTo} not delivered: ${reason}`;
          this.log(`report for job ${p.jobId} to ${p.agent} dropped: ${reason}`);
          if (this.voiceCall) this.voiceCall.release(p.agent, this._holdItem(p).id);
          this._save();
          continue;
        }
      }
      p.attempts++;
      try {
        const j = this.jobs.get(p.jobId);
        const onReply = (p.kind === 'result' && j && j.reportTo) ? (reply) => this._onReply(j, reply) : undefined;
        await this.notify(p.agent, p.message, onReply, {
          kind: p.kind === 'report' ? 'job_report' : 'job_notice',
          jobId: p.jobId, jobName: j ? j.name : null,
          from: j ? (p.kind === 'report' ? j.owner : null) : null,
          ...(j && j.member === true ? { member: true } : {}),
          ...(j && j.handOff && p.kind !== 'report' ? { handOff: j.handOff } : {}),
        });
        this.pending.splice(this.pending.indexOf(p), 1);
        if (this.voiceCall) this.voiceCall.release(p.agent, this._holdItem(p).id);
        if (j) { if (p.kind === 'report') j.reportedAt = new Date(this.now()).toISOString(); else j.notifiedAt = new Date(this.now()).toISOString(); }
        this._save();
      } catch (e) {
        this.log(`could not wake ${p.agent} for job ${p.jobId} (attempt ${p.attempts}): ${e.message}`);
        if (p.attempts >= MAX_DELIVERY_ATTEMPTS) {
          this.pending.splice(this.pending.indexOf(p), 1);
          const j = this.jobs.get(p.jobId); if (j) j.note = (j.note ? j.note + ' ' : '') + `Could not wake ${p.agent} after ${p.attempts} attempts: ${e.message}`;
          this._save();
        } else p.notBefore = this.now() + this.retryMs;
      }
    }
  }

  // ── public API (tools + routes) ───────────────────────────────────────
  /** Start a job. Rejects with a plain Error whose message is meant for the agent. */
  async run({ owner, name, command, cwd, reportTo, timeoutMinutes, consultedBy = null, member = false, handOff = null } = {}) {
    if (!owner) throw new Error('owner is required');
    { const halted = this.haltRefusal(); if (halted) throw new Error(halted); }
    if (this._refuseJobs) throw new Error(RESTARTING_REFUSAL);
    name = String(name || '').trim();
    if (!NAME_RE.test(name)) throw new Error('name: 1-80 characters, letters, digits, space, _ . : -');
    command = String(command || '');
    if (!command.trim()) throw new Error('command is empty');
    if (command.length > MAX_COMMAND) throw new Error(`command is longer than ${MAX_COMMAND} characters; put it in a script file and run that`);
    reportTo = String(reportTo || '').trim() || null;
    if (reportTo === owner) reportTo = null;
    if (reportTo && !(await this.agentExists(reportTo))) throw new Error(`report_to: no agent named "${reportTo}"`);
    let reportViaConsult = false;
    if (reportTo) {
      let ok = { ok: false, reason: 'the permission check failed' };
      try { ok = await this.mayReport(owner, reportTo, { consultedBy }); } catch (e) { ok = { ok: false, reason: `the permission check failed: ${e.message}` }; }
      if (!ok || !ok.ok) throw new Error(`report_to: ${(ok && ok.reason) || 'not allowed'}`);
      reportViaConsult = !!(consultedBy && reportTo === consultedBy);
    }
    cwd = path.resolve(String(cwd || await this.defaultCwd(owner)));
    let st; try { st = fs.statSync(cwd); } catch {}
    if (!st || !st.isDirectory()) throw new Error(`cwd does not exist: ${cwd}`);
    const tm = timeoutMinutes === undefined || timeoutMinutes === null || timeoutMinutes === '' ? DEFAULT_TIMEOUT_MIN : Number(timeoutMinutes);
    if (!Number.isFinite(tm) || tm < 1 || tm > MAX_TIMEOUT_MIN) throw new Error(`timeout_minutes must be 1-${MAX_TIMEOUT_MIN}`);
    const running = [...this.jobs.values()].filter(j => j.owner === owner && j.status === 'running');
    if (running.length >= MAX_RUNNING_PER_OWNER) throw new Error(`you already have ${running.length} running jobs (${running.map(j => j.id).join(', ')}); wait for one or cancel it`);

    // A sandboxed owner's job runs inside its container: the working directory must be one of the box's folders.
    const box = await this.boxFor(owner);
    if (box) {
      const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
      const rc = real(cwd);
      if (!(box.mounts || []).some(m => rc === real(m) || rc.startsWith(real(m) + path.sep))) throw new Error(`cwd is outside your folders (your sandbox sees: ${(box.mounts || []).join(', ')})`);
    }

    // The command lockbox (lib/lockbox), host jobs only: refuse writes nothing and spawns nothing; a profile boxes the job script.
    let boxed = null;
    if (!box && this.lockboxFor) {
      const d = await this.lockboxFor({ agentName: owner, tool: 'run_job', command, cwd, sandboxed: false });
      if (d && d.refuse) throw new Error(d.refuse);
      if (d && d.profile) boxed = d;
    }

    if (this._refuseJobs) throw new Error(RESTARTING_REFUSAL);   // a restart was accepted while the checks above ran
    let id = newId(); while (this.jobs.has(id)) id = newId();
    const dir = this._jobDir(id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'job.sh'), command.endsWith('\n') ? command : command + '\n', { mode: 0o700 });
    const wrapper = path.join(dir, 'wrapper.sh');
    const lines = box ? [
      '#!/bin/bash',
      `D=${sq(dir)}`,
      'echo $$ > "$D/pid"',
      // The script is fed to a shell inside the container over stdin (the job folder is not mounted there); the
      // inner shell records its pid in the container's /tmp so a cancel or timeout can stop it in there too.
      // Killing this wrapper (or the docker client) does not stop a process inside the container, and the inner shell may
      // start after a cancel has already looked for its pid. So a cancel first leaves a mark ($M), then looks for the
      // pid; the inner shell first writes its pid, then looks for the mark and leaves before running the script. Each
      // side writes before it reads, so at least one of them sees the other: the job is either stopped or never runs.
      `C=${sq(box.name)}; P=${sq(`/tmp/hub-job-${id}.pid`)}; M=${sq(`/tmp/hub-job-${id}.cancel`)}`,
      // The cancel is done only with proof: it left its mark, it stopped a pid it found, or Docker says the box isn't running
      // (nothing can start in it). Until then (a full /tmp, a slow or unanswering daemon) it keeps trying, 1 s apart growing
      // to 10 s, ignoring the TERMs meanwhile, and the job shows as cancelling. The inner shell runs nothing if it can't
      // record its pid.
      // Each docker call has a time limit (a hung daemon is no proof either; SIGKILL backs it up, since the call inherits the
      // ignored TERM). "Isn't running" is only `false` from a successful inspect, or Docker's own "no such container" for
      // this box: a missing socket or any other error is not proof.
      'lim() { if command -v timeout >/dev/null 2>&1; then timeout -k 5 "$@"; else shift; "$@"; fi; }',
      'term() { trap \'\' TERM; d=1; while :; do lim 20 docker exec "$C" bash -c "ok=; touch $M && ok=1; p=\\$(cat $P 2>/dev/null); if [ -n \\"\\$p\\" ]; then kill -TERM -- -\\$p 2>/dev/null; kill -TERM \\$p 2>/dev/null; rm -f $M $P; ok=1; fi; [ -n \\"\\$ok\\" ]" >/dev/null 2>&1 && break; s=$(lim 10 docker inspect --type container -f "{{.State.Running}}" "$C" 2>&1); r=$?; if [ $r -eq 0 ]; then [ "$s" = false ] && break; else case "$s" in *"o such container: $C"*|*"o such object: $C"*) break;; esac; fi; sleep $d; [ $d -lt 10 ] && d=$((d * 2 > 10 ? 10 : d * 2)); done; echo 143 > "$D/exit.tmp" && mv "$D/exit.tmp" "$D/exit"; exit 143; }',
      'trap term TERM',
      `docker exec -i -w ${sq(cwd)} "$C" bash -c "echo \\$\\$ > $P || { echo hub: the job could not record its process id in /tmp inside the box, so it was not started >&2; exit 143; }; if [ -e $M ]; then rm -f $M $P; exit 143; fi; exec bash -s" < "$D/job.sh" > "$D/out.log" 2>&1 &`,
      'w=$!; wait $w; rc=$?',
      'echo $rc > "$D/exit.tmp" && mv "$D/exit.tmp" "$D/exit"',
      'exit $rc',
    ] : [
      '#!/bin/bash',
      `D=${sq(dir)}`,
      'echo $$ > "$D/pid"',
      // A cancel or timeout SIGTERMs the whole process group; still record an exit code.
      'trap \'echo 143 > "$D/exit.tmp" && mv "$D/exit.tmp" "$D/exit"; exit 143\' TERM',
      `cd ${sq(cwd)} || { echo "cannot cd to ${cwd}" > "$D/out.log"; echo 127 > "$D/exit"; exit 127; }`,
      (boxed ? require('./lockbox').jobLine(boxed.profile) : 'bash "$D/job.sh"') + ' > "$D/out.log" 2>&1',
      'rc=$?',
      'echo $rc > "$D/exit.tmp" && mv "$D/exit.tmp" "$D/exit"',
      'exit $rc',
    ];
    fs.writeFileSync(wrapper, lines.join('\n') + '\n', { mode: 0o700 });

    const job = {
      id, name, owner, reportTo, reportViaConsult, command, cwd, timeoutMinutes: tm,
      status: 'running', startedAt: new Date(this.now()).toISOString(), endedAt: null, exitCode: null,
      notifiedAt: null, replyAt: null, reportedAt: null,
      mode: this.mode({ retry: true }), unit: `hub-job-${id}`, box: box ? box.name : null,
      ...(boxed ? { lockbox: boxed.mode } : {}),
      // started in a member's turn (lib/sdk-chat isMemberTurn; never from tool arguments): its notice and report turns are a member's too
      ...(member === true ? { member: true } : {}),
      // started in a turn of a hand-off (lib/hand-offs; from the hub's context, never tool arguments): its notice stays part of it
      ...(typeof handOff === 'string' && /^ho-[0-9a-f]{8}$/.test(handOff) ? { handOff } : {}),
    };
    const args = job.mode === 'systemd'
      ? ['systemd-run', ['--user', '--scope', '--quiet', '--collect', `--unit=${job.unit}`, '--description', `My Maestro AI job ${id} (${owner}: ${name})`, 'setsid', 'bash', wrapper]]
      // detached:true already calls setsid(2); the setsid(1) binary is Linux-only (absent on macOS).
      : ['bash', [wrapper]];
    let jobEnv = this.envFor ? this.envFor(job.owner) : process.env;
    if (box && this.envFor) {
      // The boxed wrapper runs `docker exec` on the host: it needs the Docker endpoint. docker exec does not forward host
      // variables into the container, so this never reaches the agent's own command.
      jobEnv = { ...jobEnv };
      for (const k of DOCKER_KEEP) if (process.env[k] !== undefined) jobEnv[k] = process.env[k];
    }
    if (job.mode === 'systemd') jobEnv = probeEnv(jobEnv);   // systemd-run --user finds the user's manager through these (only added when missing)
    const child = spawn(args[0], args[1], { detached: true, stdio: 'ignore', env: jobEnv, cwd });
    child.on('error', (e) => { this.log(`spawn failed for job ${id}: ${e.message}`); job._spawnFailed = true; });   // never started: no start grace
    // The spawned child is the wrapper itself (setsid mode) or systemd-run, which exits only once the scope exists: after
    // it has gone, a job with no pid file and no active scope is gone too (stopped before it began, or died at once).
    job._childExited = false;
    child.on('exit', (code) => { job._childExited = true; job._childCode = code; });   // code null: ended by a signal
    child.unref();
    this.jobs.set(id, job);
    this._save();
    this.log(`job ${id} "${name}" started by ${owner} (${job.mode}${box ? `, inside ${box.name}` : ''}${reportTo ? `, report to ${reportTo}` : ''}, cwd ${cwd})`);
    return this.status(id, owner);
  }

  _visible(j, requester) { return !requester || j.owner === requester || j.reportTo === requester; }

  status(id, requester, { tailLines = 20 } = {}) {
    const j = this.jobs.get(String(id || '').trim());
    if (!j || !this._visible(j, requester)) throw new Error(`no job with id "${id}"` + (requester ? ' (you can only see jobs you started or are notified for)' : ''));
    const lines = Math.max(0, Math.min(400, Number(tailLines) || 0));
    const { _deadSince, _spawnFailed, _childExited, _childCode, _stopping, _signaled, ...rec } = j;
    return {
      ...rec,
      runningFor: j.status === 'running' ? fmtDuration(this.now() - Date.parse(j.startedAt)) : undefined,
      ...(j.status === 'running' && j.mode !== 'systemd' ? { restartWarning: RESTART_WARNING } : {}),
      log: path.join(this._jobDir(j.id), 'out.log'),
      outputTail: lines ? tailFile(path.join(this._jobDir(j.id), 'out.log'), lines, 60000) : undefined,
    };
  }

  /** The jobs of a hand-off that are still open: running, or with their notice not yet delivered (lib/hand-offs). */
  openFor(handOff) {
    if (!handOff) return [];
    return [...this.jobs.values()].filter(j => j.handOff === handOff && (j.status === 'running' || this.pending.some(p => p.jobId === j.id && p.kind !== 'report')));
  }

  list(requester) {
    return [...this.jobs.values()].filter(j => this._visible(j, requester))
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .map(j => ({ id: j.id, name: j.name, owner: j.owner, reportTo: j.reportTo, status: j.status, exitCode: j.exitCode, startedAt: j.startedAt, endedAt: j.endedAt, notifiedAt: j.notifiedAt, reportedAt: j.reportedAt, command: j.command.length > 120 ? j.command.slice(0, 120) + '…' : j.command, runningFor: j.status === 'running' ? fmtDuration(this.now() - Date.parse(j.startedAt)) : undefined, ...(j.statusNote ? { statusNote: j.statusNote } : {}), ...(j.status === 'running' && j.mode !== 'systemd' ? { restartWarning: RESTART_WARNING } : {}) }));
  }

  cancel(id, requester) {
    const j = this.jobs.get(String(id || '').trim());
    if (!j || !this._visible(j, requester)) throw new Error(`no job with id "${id}"`);
    if (TERMINAL.has(j.status)) return this.status(j.id, requester);
    j.status = 'cancelling';
    this._kill(j);
    this._save();
    return this.status(j.id, requester);
  }

  /** Kill switch: cancel every running job regardless of owner. Returns the ids asked to stop. */
  cancelAll() {
    const ids = [];
    for (const j of [...this.jobs.values()]) {
      if (j.status !== 'running') continue;
      try { this.cancel(j.id); ids.push(j.id); } catch (e) { this.log(`cancelAll: ${j.id}: ${e.message}`); }
    }
    return ids;
  }

  _kill(j) {
    const pid = this._pid(j);
    // Stopping the scope never blocks the hub: systemctl runs as a child process (killed after 10 s), at most one per job
    // at a time, while the signals below go out at once. A boxed job whose wrapper is up is stopped by its own term() only:
    // systemd would SIGKILL the scope (term() included) after its stop timeout, while term() may still need to keep trying.
    if (j.mode === 'systemd' && j.unit && !j._stopping && !(j.box && pid)) {
      j._stopping = true;
      try { execFile('systemctl', ['--user', 'stop', scopeUnit(j.unit)], { timeout: 10000, killSignal: 'SIGKILL', env: probeEnv() }, () => { delete j._stopping; }); }
      catch { delete j._stopping; }
    }
    // A boxed job's wrapper gets SIGTERM once per pid (repeated on every poll only until the pid appears): signalling it again
    // would hit its own cancel at work (term() and its docker exec into the box). A host job's group is signalled on every
    // poll, as before (a signal that lands while the job starts can be missed).
    if (pid && (!j.box || j._signaled !== pid)) { j._signaled = pid; try { process.kill(-pid, 'SIGTERM'); } catch {} try { process.kill(pid, 'SIGTERM'); } catch {} }
  }

  /** Drop terminal jobs older than `days` (registry + directories). */
  prune(days = 14) {
    const cutoff = this.now() - days * 86400000;
    let n = 0;
    for (const j of [...this.jobs.values()]) {
      if (!TERMINAL.has(j.status) || Date.parse(j.endedAt || j.startedAt) > cutoff) continue;
      if (this.pending.some(p => p.jobId === j.id)) continue;
      this.jobs.delete(j.id); n++;
      try { fs.rmSync(this._jobDir(j.id), { recursive: true, force: true }); } catch {}
    }
    if (n) this._save();
    return n;
  }
}

/** System-prompt text for every agent (SDK and gateway paths, consulted agents included). */
function policyText() {
  return `

## BACKGROUND WORK (MANDATORY)
Your shell dies with your turn. The hub starts a fresh process for each reply and kills it, with every child, when the reply ends. A command started with \`&\`, \`nohup\`, \`setsid\`, or the Bash tool's run_in_background flag is killed the moment you stop talking, and nobody is told. Never report such a run as "in progress".
For anything that must outlive this reply (a backtest, a long fetch, a build, a scan), use the \`run_job\` tool: the hub runs the command detached, keeps its log, and when it exits the hub wakes the notified agent in a new turn with the exit code and the output tail. So: start the job, end your reply with the job id and the sentence "I will report when it completes", and stop. Do not poll or sleep waiting for it. Check with \`job_status\`, stop with \`job_cancel\`, see yours with \`list_jobs\`. If another agent consulted you, the hub records it as the job's \`report_to\`: you are woken with the result, and when that reply ends the hub forwards it to that agent as your report. Commands that finish within about a minute still belong in Bash.`;
}

const TOOL_SPECS = [
  {
    name: 'run_job',
    description: 'Run a shell command DETACHED from your turn. Use it for anything that must outlive this reply (backtests, long fetches, builds). The hub keeps the log and wakes the notified agent in a new turn when the command exits, with the exit code and output tail. Returns the job id at once; end your reply after starting it, do not wait or poll.',
    params: {
      name: { type: 'string', description: 'Short label, e.g. "audit-07 full run"' },
      command: { type: 'string', description: 'Bash command(s). Runs via bash in cwd; stdout+stderr go to the job log.' },
      cwd: { type: 'string', description: 'Working directory (default: your workspace)', optional: true },
      report_to: { type: 'string', description: 'Master agent that gets your reply as a report after you are woken with the result. Default: the agent that consulted you, if any.', optional: true },
      timeout_minutes: { type: 'number', description: 'Kill the job after this many minutes (default 360, max 1440)', optional: true },
    },
    run: (runner, agent, a, ctx) => runner.run({ owner: agent, name: a.name, command: a.command, cwd: a.cwd, reportTo: a.report_to || ctx.consultedBy || null, timeoutMinutes: a.timeout_minutes, consultedBy: ctx.consultedBy || null, member: ctx.member === true, handOff: ctx.handOff || null }),
  },
  {
    name: 'job_status',
    description: 'Status, exit code and output tail of a job you started or that reports to you.',
    params: { id: { type: 'string', description: 'Job id' }, tail_lines: { type: 'number', description: 'Lines of output to include (default 20, max 400)', optional: true } },
    run: (runner, agent, a) => runner.status(a.id, agent, { tailLines: a.tail_lines === undefined ? 20 : a.tail_lines }),
  },
  {
    name: 'job_cancel',
    description: 'Stop a running job you started or that reports to you.',
    params: { id: { type: 'string', description: 'Job id' } },
    run: (runner, agent, a) => runner.cancel(a.id, agent),
  },
  {
    name: 'list_jobs',
    description: 'List your jobs (running and recent) with their status.',
    params: {},
    run: (runner, agent) => runner.list(agent),
  },
];

/** OpenAI-style JSON schema for the gateway tool loop. */
function jsonSchema(spec) {
  const properties = {}, required = [];
  for (const [k, v] of Object.entries(spec.params)) { properties[k] = { type: v.type, description: v.description }; if (!v.optional) required.push(k); }
  return { type: 'object', properties, required };
}
/** zod shape for the SDK MCP server. */
function zodShape(spec, z) {
  const shape = {};
  for (const [k, v] of Object.entries(spec.params)) { let t = v.type === 'number' ? z.number() : z.string(); t = t.describe(v.description); shape[k] = v.optional ? t.optional() : t; }
  return shape;
}
async function runTool(runner, spec, agent, args, ctx = {}) {
  try { return JSON.stringify(await spec.run(runner, agent, args || {}, ctx), null, 1); }
  catch (e) { return `[${spec.name} error] ${e.message}`; }
}

let _runner = null;
/** The runner if one has been created (never creates an unwired one). */
function peekJobRunner() { return _runner; }
function getJobRunner(opts) {
  if (!_runner) _runner = new JobRunner({ lockboxFor: (a) => require('./lockbox/wire').lockboxFor(a), ...opts });
  return _runner;
}

module.exports = { JobRunner, getJobRunner, peekJobRunner, policyText, TOOL_SPECS, jsonSchema, zodShape, runTool, tailFile, detectSpawnMode, detectSpawnModeAsync, probeEnv, lingerState, lingerStateAsync, restartGate, RESTART_WARNING, MAX_RUNNING_PER_OWNER, DEFAULT_TIMEOUT_MIN, MAX_TIMEOUT_MIN };
