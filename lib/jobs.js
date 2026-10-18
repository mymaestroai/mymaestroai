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
 * Where systemd is not available it falls back to `setsid`, which survives the turn only. A poll
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
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

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
const TERMINAL = new Set(['finished', 'failed', 'cancelled', 'timed_out', 'lost']);

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

/** Probe once whether transient user scopes can be created from this process. */
function detectSpawnMode() {
  try {
    const r = spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', 'true'], { stdio: 'ignore', timeout: 5000 });
    return r.status === 0 ? 'systemd' : 'setsid';
  } catch { return 'setsid'; }
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
   */
  constructor(o = {}) {
    this.dataDir = o.dataDir || DEFAULT_DATA_DIR;
    this.dir = path.join(this.dataDir, 'jobs');
    this.indexFile = path.join(this.dir, 'index.json');
    this.notify = o.notify || (async () => {});
    this.isAgentActive = o.isAgentActive || (() => false);
    this.agentExists = o.agentExists || (async () => true);
    this.haltRefusal = o.haltRefusal || (() => null);
    this.defaultCwd = o.defaultCwd || (async () => process.cwd());
    // boxFor(owner) -> null (the job runs on the host) or { name, mounts } for a sandboxed owner: the job then runs
    // inside that container (docker exec), never on the host (2026-10-16 review, F05).
    this.boxFor = o.boxFor || (async () => null);
    this.spawnMode = o.spawnMode && o.spawnMode !== 'auto' ? o.spawnMode : null;
    this.pollMs = o.pollMs || 3000;
    this.retryMs = o.retryMs || RETRY_MS;
    this.now = o.now || (() => Date.now());
    this.log = o.log || ((...a) => console.log('[jobs]', ...a));
    this.jobs = new Map();
    this.pending = [];       // notifications waiting for delivery: { jobId, agent, message, attempts, notBefore }
    this._timer = null;
    this._polling = false;
    fs.mkdirSync(this.dir, { recursive: true });
    this._load();
  }

  mode() { if (!this.spawnMode) this.spawnMode = detectSpawnMode(); return this.spawnMode; }

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
    const doc = { jobs: [...this.jobs.values()], pending: this.pending.map(p => ({ kind: p.kind, jobId: p.jobId, agent: p.agent, message: p.message, attempts: p.attempts })) };
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
      const pid = this._pid(j);
      if (!pidAlive(pid)) {
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
        if (!pidAlive(this._pid(j))) {
          // Give the wrapper one poll interval to write the exit file before calling it lost.
          j._deadSince = j._deadSince || this.now();
          if (this.now() - j._deadSince > this.pollMs) {
            if (j.status === 'cancelling') this._finish(j, { status: 'cancelled', exitCode: null, note: 'Cancelled on request.' });
            else this._finish(j, { status: 'lost', exitCode: null, note: 'The process disappeared without an exit code.' });
            changed = true;
          }
        }
      }
      if (changed) this._save();
      await this._deliver();
    } finally { this._polling = false; }
  }

  _pid(j) { try { return parseInt(fs.readFileSync(path.join(this._jobDir(j.id), 'pid'), 'utf8'), 10) || null; } catch { return null; } }

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
    delete j._deadSince;
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
      'This is an automatic notice from the hub. Continue the task this job was started for and tell the user in this chat.'].join('\n');
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
    ].filter(l => l !== null).join('\n');
  }

  async _deliver() {
    const now = this.now();
    if (this.haltRefusal()) return;   // notices and reports wait; they are delivered after the hub is resumed
    for (const p of [...this.pending]) {
      if (this._stopped) return;
      if (p.notBefore > now) continue;
      if (this.isAgentActive(p.agent)) { p.notBefore = now + this.retryMs; continue; }
      p.attempts++;
      try {
        const j = this.jobs.get(p.jobId);
        const onReply = (p.kind === 'result' && j && j.reportTo) ? (reply) => this._onReply(j, reply) : undefined;
        await this.notify(p.agent, p.message, onReply, {
          kind: p.kind === 'report' ? 'job_report' : 'job_notice',
          jobId: p.jobId, jobName: j ? j.name : null,
          from: j ? (p.kind === 'report' ? j.owner : null) : null,
        });
        this.pending.splice(this.pending.indexOf(p), 1);
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
  async run({ owner, name, command, cwd, reportTo, timeoutMinutes } = {}) {
    if (!owner) throw new Error('owner is required');
    { const halted = this.haltRefusal(); if (halted) throw new Error(halted); }
    name = String(name || '').trim();
    if (!NAME_RE.test(name)) throw new Error('name: 1-80 characters, letters, digits, space, _ . : -');
    command = String(command || '');
    if (!command.trim()) throw new Error('command is empty');
    if (command.length > MAX_COMMAND) throw new Error(`command is longer than ${MAX_COMMAND} characters; put it in a script file and run that`);
    reportTo = String(reportTo || '').trim() || null;
    if (reportTo === owner) reportTo = null;
    if (reportTo && !(await this.agentExists(reportTo))) throw new Error(`report_to: no agent named "${reportTo}"`);
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
      `C=${sq(box.name)}; P=${sq(`/tmp/hub-job-${id}.pid`)}`,
      'term() { docker exec "$C" bash -c "p=\\$(cat $P 2>/dev/null); if [ -n \\"\\$p\\" ]; then kill -TERM -- -\\$p 2>/dev/null; kill -TERM \\$p 2>/dev/null; fi" >/dev/null 2>&1; echo 143 > "$D/exit.tmp" && mv "$D/exit.tmp" "$D/exit"; exit 143; }',
      'trap term TERM',
      `docker exec -i -w ${sq(cwd)} "$C" bash -c "echo \\$\\$ > $P; exec bash -s" < "$D/job.sh" > "$D/out.log" 2>&1 &`,
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
      'bash "$D/job.sh" > "$D/out.log" 2>&1',
      'rc=$?',
      'echo $rc > "$D/exit.tmp" && mv "$D/exit.tmp" "$D/exit"',
      'exit $rc',
    ];
    fs.writeFileSync(wrapper, lines.join('\n') + '\n', { mode: 0o700 });

    const job = {
      id, name, owner, reportTo, command, cwd, timeoutMinutes: tm,
      status: 'running', startedAt: new Date(this.now()).toISOString(), endedAt: null, exitCode: null,
      notifiedAt: null, replyAt: null, reportedAt: null,
      mode: this.mode(), unit: `hub-job-${id}`, box: box ? box.name : null,
    };
    const args = job.mode === 'systemd'
      ? ['systemd-run', ['--user', '--scope', '--quiet', '--collect', `--unit=${job.unit}`, '--description', `My Maestro AI job ${id} (${owner}: ${name})`, 'setsid', 'bash', wrapper]]
      // detached:true already calls setsid(2); the setsid(1) binary is Linux-only (absent on macOS).
      : ['bash', [wrapper]];
    const child = spawn(args[0], args[1], { detached: true, stdio: 'ignore', env: process.env, cwd });
    child.on('error', (e) => { this.log(`spawn failed for job ${id}: ${e.message}`); });
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
    const { _deadSince, ...rec } = j;
    return {
      ...rec,
      runningFor: j.status === 'running' ? fmtDuration(this.now() - Date.parse(j.startedAt)) : undefined,
      log: path.join(this._jobDir(j.id), 'out.log'),
      outputTail: lines ? tailFile(path.join(this._jobDir(j.id), 'out.log'), lines, 60000) : undefined,
    };
  }

  list(requester) {
    return [...this.jobs.values()].filter(j => this._visible(j, requester))
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .map(j => ({ id: j.id, name: j.name, owner: j.owner, reportTo: j.reportTo, status: j.status, exitCode: j.exitCode, startedAt: j.startedAt, endedAt: j.endedAt, notifiedAt: j.notifiedAt, reportedAt: j.reportedAt, command: j.command.length > 120 ? j.command.slice(0, 120) + '…' : j.command, runningFor: j.status === 'running' ? fmtDuration(this.now() - Date.parse(j.startedAt)) : undefined }));
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
    if (j.mode === 'systemd') { try { spawnSync('systemctl', ['--user', 'stop', j.unit], { stdio: 'ignore', timeout: 10000 }); } catch {} }
    const pid = this._pid(j);
    if (pid) { try { process.kill(-pid, 'SIGTERM'); } catch {} try { process.kill(pid, 'SIGTERM'); } catch {} }
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
    run: (runner, agent, a, ctx) => runner.run({ owner: agent, name: a.name, command: a.command, cwd: a.cwd, reportTo: a.report_to || ctx.consultedBy || null, timeoutMinutes: a.timeout_minutes }),
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
function getJobRunner(opts) { if (!_runner) _runner = new JobRunner(opts); return _runner; }

module.exports = { JobRunner, getJobRunner, policyText, TOOL_SPECS, jsonSchema, zodShape, runTool, tailFile, detectSpawnMode, MAX_RUNNING_PER_OWNER, DEFAULT_TIMEOUT_MIN, MAX_TIMEOUT_MIN };
