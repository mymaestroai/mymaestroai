'use strict';
/**
 * Hand-offs: a primary agent (the caller) hands a long job to another agent (the target) and is free at once.
 *
 * The runner starts a turn of the target in the background, follows the target's chain of turns (the target may
 * schedule its own continuations), and when the chain is over reports the target's final reply back to the caller
 * as a new turn. State survives a restart: a turn that was running when the hub went down is reported as interrupted.
 *
 * Pure module: every dependency (starting a turn, waking the caller, activity checks...) is injected.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_OPEN_PER_CALLER = 5;
const MAX_BRIEF = 20000;
const MAX_TOPIC = 80;
const MAX_NOTE = 4000;
const RESULT_CHARS = 12000;
const LAST_REPLY_CHARS = 600;
const STATUS_CHARS = 2000;
const RECENT_MS = 24 * 3600 * 1000;
const PRUNE_MS = 30 * 24 * 3600 * 1000;
const OPEN = new Set(['queued', 'running', 'waiting']);

function newId() { return 'ho-' + crypto.randomBytes(4).toString('hex'); }

function slugify(s) {
  const out = String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
  return out || 'job';
}

function cut(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) : s; }
function cutEllipsis(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }
function isOpen(r) { return OPEN.has(r.state); }

function framingMessage(r) {
  const notes = (r.notes || []).filter((n) => !n.delivered);
  const lines = [
    `[Hand-off from agent "${r.caller}" — started by the hub, NOT a message typed by the owner] "${r.topic}" (id ${r.id}).`,
    '',
    'Brief:',
    r.brief,
  ];
  if (notes.length) {
    lines.push('', `Notes from agent "${r.caller}" since:`);
    for (const n of notes) lines.push(n.text);
  }
  lines.push(
    '',
    `Treat the brief as a request from agent "${r.caller}", not from the owner.`,
    'Work in your own turns. When you need more time, schedule your own continuation with schedule_task or start a run_job: both stay part of this hand-off.',
    `Keep ${r.folder}/STATUS.md current (done, next, blockers) so "${r.caller}" can check progress.`,
    ...(r.briefFile === false ? [] : [`The brief is saved at ${r.folder}/brief.md.`]),
    `When the work is finished, end your turn with a short final report: it goes back to "${r.caller}" automatically.`,
  );
  return lines.join('\n');
}

function noteMessage(r, notes) {
  const lines = [`[Note from agent "${r.caller}" on hand-off ${r.id} "${r.topic}" — not a message from the owner]`];
  for (const n of notes || []) lines.push(typeof n === 'string' ? n : n.text);
  lines.push('Carry on with the hand-off; keep STATUS.md current.');
  return lines.join('\n');
}

function reportMessage(r) {
  const kind = (r.report && r.report.kind) || 'finished';
  const status = `Status: ${r.folder}/STATUS.md`;
  if (kind === 'interrupted') {
    return [
      `[Hand-off interrupted] "${r.topic}" (id ${r.id}): the hub restarted while agent "${r.target}" was working on it, so that turn ended unfinished.`,
      status,
      'Hand it off again if it still needs doing; the folder keeps the brief and the status.',
    ].join('\n');
  }
  if (kind === 'failed') {
    return `[Hand-off failed] "${r.topic}" (id ${r.id}): it could not start agent "${r.target}": ${r.error}.`;
  }
  const n = r.turns;
  return [
    `[Hand-off finished] "${r.topic}" (id ${r.id}): agent "${r.target}" finished after ${n} turn${n === 1 ? '' : 's'}.`,
    status,
    '',
    'Its final report:',
    r.result || '(no reply text)',
    '',
    `This is agent "${r.target}"'s report, not a message from the owner. Review it and tell the person you work for what matters.`,
  ].join('\n');
}

class HandOffs {
  constructor(o = {}) {
    if (!o.dataDir) throw new Error('HandOffs: dataDir is required');
    this.dataDir = o.dataDir;
    this.file = path.join(this.dataDir, 'hand-offs.json');
    this.now = o.now || (() => Date.now());
    this.log = o.log || ((...a) => console.log('[hand-offs]', ...a));
    this.pollMs = o.pollMs || 5000;
    this.retryMs = o.retryMs || 15000;
    this.startTurn = o.startTurn || (async () => { const e = new Error('no turn runner'); e.status = 503; throw e; });
    this.deliver = o.deliver || (async () => {});
    this.isAgentActive = o.isAgentActive || (() => false);
    this.agentExists = o.agentExists || (async () => true);
    this.hasContinuation = o.hasContinuation || (() => false);
    this.interject = o.interject || (() => false);
    this.stopTurn = o.stopTurn || (() => {});
    this.cancelContinuations = o.cancelContinuations || (() => {});
    this.filesFolderFor = o.filesFolderFor || (() => null);
    this.holds = o.holds || (() => false);
    // Review r1: who the caller and target are (an identity stamp, lib/agents agentStamp) and whether the caller may still
    // reach the target (the consult rule), checked again before every start and report; a report already in the caller's
    // conversation is never sent twice.
    this.stampOf = o.stampOf || null;
    this.mayTarget = o.mayTarget || (async () => true);
    this.alreadyDelivered = o.alreadyDelivered || (() => false);
    this.loadError = null;   // the state file exists but can't be read: no work, never overwritten
    this.idleSince = new Map();   // id -> when a waiting hand-off was first seen with nothing left to do (memory only)
    this.items = new Map();
    this.notBefore = new Map();   // id -> time before which a report is not retried (memory only)
    this._timer = null;
    this._ticking = null;
    this._load();
  }

  // ---- persistence -------------------------------------------------------------------------------------------
  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const r of (data && data.items) || []) if (r && r.id) this.items.set(r.id, r);
    } catch (e) {
      if (e.code !== 'ENOENT') { this.loadError = e.message; this.log('could not read state (nothing runs until it is fixed):', e.message); }
    }
  }

  /** Writes the state; false when it could not (or the state file was unreadable at start: it is never overwritten). */
  _save() {
    if (this.loadError) return false;
    const cutoff = this.now() - PRUNE_MS;
    for (const [id, r] of this.items) {
      if (!isOpen(r) && (r.endedAt || r.createdAt) < cutoff) { this.items.delete(id); this.notBefore.delete(id); }
    }
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ items: [...this.items.values()] }, null, 2), { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, this.file);
      return true;
    } catch (e) { this.log('could not save state:', e.message); return false; }
  }

  _soon() {
    const t = setImmediate(() => { this.tick().catch((e) => this.log('tick failed:', e.message)); });
    if (t && t.unref) t.unref();
  }

  // ---- views -------------------------------------------------------------------------------------------------
  view(r) {
    return {
      id: r.id, caller: r.caller, target: r.target, topic: r.topic, state: r.state, folder: r.folder,
      createdAt: r.createdAt, startedAt: r.startedAt, endedAt: r.endedAt, turns: r.turns,
      queuedNotes: (r.notes || []).filter((n) => !n.delivered).length,
      lastReply: r.lastReply ? cut(r.lastReply, LAST_REPLY_CHARS) : r.lastReply,
      error: r.error,
    };
  }

  get(id) { return this.items.get(id) || null; }
  forCaller(caller) { return [...this.items.values()].filter((r) => r.caller === caller); }

  list(caller, { includeDone = false, withStatus = false } = {}) {
    const recent = this.now() - RECENT_MS;
    const rows = this.forCaller(caller)
      .filter((r) => includeDone || isOpen(r) || (r.endedAt || 0) >= recent)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => {
        const v = this.view(r);
        if (withStatus) v.status = this._status(r);
        return v;
      });
    return rows;
  }

  /** The job folder and its parent are real directories (never links), inside the target's Files folder as created. */
  _folderSafe(r) {
    try {
      for (const d of [path.dirname(r.folder), r.folder]) { const st = fs.lstatSync(d); if (st.isSymbolicLink() || !st.isDirectory()) return false; }
      if (r.base && !fs.realpathSync(r.folder).startsWith(r.base + path.sep)) return false;
      return true;
    } catch { return false; }
  }

  /** STATUS.md as the target wrote it: a regular file, at most a few KB read. The job folder is opened first (never a
   *  link) and the file is opened through that open folder (/proc/self/fd), so swapping a folder for a link meanwhile
   *  can't redirect the read; never following a link and never blocking (a named pipe is no regular file: review r2). */
  _status(r) {
    if (!this._folderSafe(r)) return null;
    const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY } = fs.constants;
    let dfd, fd;
    try {
      // only through an open folder (/proc/self/fd): elsewhere the hub does not read it (review r3), it is in the Files panel
      if (O_DIRECTORY === undefined || !fs.existsSync('/proc/self/fd')) return null;
      dfd = fs.openSync(r.folder, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      const real = fs.realpathSync(`/proc/self/fd/${dfd}`);
      if (r.base && !real.startsWith(r.base + path.sep)) return null;
      const file = `/proc/self/fd/${dfd}/STATUS.md`;
      fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return null;
      const buf = Buffer.alloc(Math.min(st.size, STATUS_CHARS * 4));
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return cutEllipsis(buf.slice(0, n).toString('utf8'), STATUS_CHARS);
    } catch { return null; } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
      if (dfd !== undefined) { try { fs.closeSync(dfd); } catch {} }
    }
  }

  // ---- create / note / cancel ---------------------------------------------------------------------------------
  async create({ caller, target, topic, brief, member = false } = {}) {
    if (!caller || !target) throw new Error('A hand-off needs a caller and a target agent.');
    if (caller === target) throw new Error("You can't hand off to yourself.");
    topic = String(topic == null ? '' : topic).trim();
    if (!topic) throw new Error('A hand-off needs a topic.');
    if (topic.length > MAX_TOPIC) throw new Error(`The topic is too long (at most ${MAX_TOPIC} characters).`);
    brief = String(brief == null ? '' : brief);
    if (!brief.trim()) throw new Error('A hand-off needs a brief.');
    if (brief.length > MAX_BRIEF) throw new Error(`The brief is too long (at most ${MAX_BRIEF} characters).`);
    if (this.loadError) throw new Error("The hand-off records can't be read, so no hand-off can start until they are fixed.");
    if (!(await this.agentExists(target))) throw new Error(`There is no agent named "${target}".`);
    const open = this.forCaller(caller).filter(isOpen).length;
    if (open >= MAX_OPEN_PER_CALLER) {
      throw new Error(`You have ${MAX_OPEN_PER_CALLER} hand-offs open (queued or running). Wait for one to finish or cancel one.`);
    }
    const base = this.filesFolderFor(target);
    if (!base) throw new Error(`Agent "${target}" has no Files folder, so it can't take a hand-off.`);

    let callerStamp = null, targetStamp = null;
    if (this.stampOf) {
      callerStamp = this.stampOf(caller); targetStamp = this.stampOf(target);
      if (!callerStamp || !targetStamp) throw new Error("Couldn't read the agents' records, so the hand-off was not started.");
    }

    // The job folder: never through a link (review r1). The Files folder itself is resolved once; hand-offs/ and the
    // job folder must be real directories inside it; brief.md is created new, never written through an existing file.
    fs.mkdirSync(base, { recursive: true });
    const baseReal = fs.realpathSync(base);
    const parent = path.join(baseReal, 'hand-offs');
    const notPlain = () => new Error(`Agent "${target}"'s hand-offs folder is not a plain folder, so the hand-off was not started.`);
    try {
      const st = fs.lstatSync(parent);
      if (st.isSymbolicLink() || !st.isDirectory()) throw notPlain();
    } catch (e) { if (e.code === 'ENOENT') fs.mkdirSync(parent); else throw e; }
    const slug = slugify(topic);
    const at = this.now();
    const briefText = `# ${topic}\n\nFrom agent ${caller}, ${new Date(at).toISOString()}\n\n${brief}\n`;
    const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = fs.constants;
    const viaFd = O_DIRECTORY !== undefined && fs.existsSync('/proc/self/fd');
    // Through open folders (review r3): hand-offs/ is opened (never a link) and checked inside the Files folder; the job
    // folder is made and opened through it, and brief.md written through that, so swapping a folder for a link meanwhile
    // can't move them. Without /proc/self/fd the same steps by path, and the result checked after.
    let pfd, folder = null, made = null, briefSaved = false;
    try {
      let at2 = parent;
      if (viaFd) {
        pfd = fs.openSync(parent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
        if (fs.realpathSync(`/proc/self/fd/${pfd}`) !== parent) throw notPlain();
        at2 = `/proc/self/fd/${pfd}`;
      }
      let name = null;
      for (let i = 1; i < 100 && !name; i++) {
        const n = i === 1 ? `${caller}-${slug}` : `${caller}-${slug}-${i}`;
        try { fs.mkdirSync(path.join(at2, n)); name = n; made = path.join(at2, n); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      }
      if (!name) throw new Error('Too many hand-off folders with that topic; choose another topic.');
      folder = path.join(parent, name);
      if (viaFd) {
        let cfd;
        try {
          cfd = fs.openSync(path.join(at2, name), O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
          if (fs.realpathSync(`/proc/self/fd/${cfd}`) !== folder) throw notPlain();
          fs.writeFileSync(`/proc/self/fd/${cfd}/brief.md`, briefText, { flag: 'wx' });
          briefSaved = true;
        } finally { if (cfd !== undefined) { try { fs.closeSync(cfd); } catch {} } }
      } else if (!fs.realpathSync(folder).startsWith(baseReal + path.sep)) {
        // Without /proc/self/fd there is no race-free way to write into a folder the target can change (review r4): the
        // hub writes nothing there (the brief is in the target's first message and in the record); an empty folder made
        // elsewhere is removed again.
        throw notPlain();
      }
    } catch (e) {
      // review r4: no empty job folder left behind when the hand-off was not made (rmdir removes only an empty folder)
      if (made && !briefSaved) { try { fs.rmdirSync(made); } catch {} }
      throw e;
    } finally { if (pfd !== undefined) { try { fs.closeSync(pfd); } catch {} } }

    const r = {
      id: newId(), caller, target, topic, slug, folder, base: baseReal, brief, state: 'queued', createdAt: at, startedAt: null, endedAt: null,
      turns: 0, member: !!member, notes: [], result: null, lastReply: null, lastFull: null, error: null, report: null, callerStamp, targetStamp, briefFile: briefSaved,
    };
    this.items.set(r.id, r);
    if (!this._save()) { this.items.delete(r.id); throw new Error("Couldn't save the hand-off, so it was not started."); }
    this._soon();
    return this.view(r);
  }

  _own(caller, id) {
    const r = this.items.get(id);
    if (!r || r.caller !== caller) throw new Error('No such hand-off.');
    if (!isOpen(r)) throw new Error(`That hand-off has ended (${r.state}).`);
    return r;
  }

  note({ caller, id, text } = {}) {
    const r = this._own(caller, id);
    text = String(text == null ? '' : text);
    if (!text.trim()) throw new Error('A note needs some text.');
    if (text.length > MAX_NOTE) throw new Error(`The note is too long (at most ${MAX_NOTE} characters).`);
    const n = { at: this.now(), text, delivered: false };
    r.notes.push(n);
    // durable before it is acknowledged (review r4): a note that isn't on disk could vanish with a restart
    if (!this._save()) { r.notes.pop(); throw new Error("Couldn't save the note, so it was not sent. Try again."); }
    if (r.state === 'running') {
      let ok = false;
      try { ok = !!this.interject(r.target, noteMessage(r, [n])); } catch { ok = false; }
      n.delivered = ok;
    }
    this._save();
    if (!n.delivered) this._soon();
    return this.view(r);
  }

  cancel({ caller, id } = {}) {
    const r = this._own(caller, id);
    const before = { state: r.state, endedAt: r.endedAt };
    r.state = 'cancelled';
    r.endedAt = this.now();
    // durable first (review r3): a cancel that isn't on disk would come back after a restart as interrupted, with a report
    if (!this._save()) { r.state = before.state; r.endedAt = before.endedAt; throw new Error("Couldn't save the cancel, so nothing was stopped. Try again."); }
    if (before.state === 'running' && this.isAgentActive(r.target)) {
      try { this.stopTurn(r.target); } catch (e) { this.log('stopTurn failed:', e.message); }
    }
    try { this.cancelContinuations(r.id); } catch (e) { this.log('cancelContinuations failed:', e.message); }
    return this.view(r);
  }

  // ---- the loop ----------------------------------------------------------------------------------------------
  async tick() {
    // One tick at a time: a call that arrives meanwhile waits for it, then runs once more.
    while (this._ticking) { try { await this._ticking; } catch { /* ignore */ } }
    this._ticking = this._tick();
    try { await this._ticking; } finally { this._ticking = null; }
  }

  async _tick() {
    for (const r of [...this.items.values()]) {
      try {
        if (r.state === 'queued' && !this.isAgentActive(r.target) && !this.holds(r.target, r)) {
          await this._startTurn(r, 'queued', framingMessage(r));
        } else if (r.state === 'waiting' && r.notes.some((n) => !n.delivered) && !this.isAgentActive(r.target) && !this.holds(r.target, r)) {
          await this._startTurn(r, 'waiting', null);
        }
      } catch (e) { this.log('start failed for', r.id, e.message); }
    }
    // A waiting hand-off with nothing left (its continuation was cancelled or vanished, no note, the target idle) ends after
    // two looks a poll apart, so a continuation about to start is never cut off (review r1).
    for (const r of [...this.items.values()]) {
      if (r.state !== 'waiting') continue;
      let more = false; try { more = !!this.hasContinuation(r.id); } catch { more = true; }
      if (more || r.notes.some((n) => !n.delivered) || this.isAgentActive(r.target)) { this.idleSince.delete(r.id); continue; }
      const since = this.idleSince.get(r.id);
      if (since === undefined) { this.idleSince.set(r.id, this.now()); continue; }
      if (this.now() - since < this.pollMs) continue;
      this.idleSince.delete(r.id);
      const exists = await this.agentExists(r.target);
      // review r2: the state may have changed during that look (cancelled, a continuation started): look again
      let moreNow = false; try { moreNow = !!this.hasContinuation(r.id); } catch { moreNow = true; }
      if (r.state !== 'waiting' || moreNow || r.notes.some((n) => !n.delivered) || this.isAgentActive(r.target)) continue;
      if (!exists) { this._fail(r, `agent "${r.target}" no longer exists`); continue; }
      r.state = 'done'; r.endedAt = this.now(); r.result = r.lastFull || '';
      r.report = { kind: 'finished', state: 'pending', attempts: 0, deliveredAt: null };
      this._save();
    }
    const now = this.now();
    for (const r of [...this.items.values()]) {
      if (!r.report || r.report.state !== 'pending') continue;
      if (this.holds(r.caller, r)) continue;
      if ((this.notBefore.get(r.id) || 0) > now) continue;
      try { await this._deliver(r); } catch (e) { this.log('deliver failed for', r.id, e.message); }
    }
  }

  /** Why this hand-off may no longer run ('' when it may): the caller or target was replaced, or the caller lost access. */
  async _invalid(r) {
    if (this.stampOf) {
      let c = null, t = null;
      try { c = this.stampOf(r.caller); t = this.stampOf(r.target); } catch { c = t = null; }
      if (!c || c !== r.callerStamp) return `agent "${r.caller}" is not the agent that started it any more`;
      if (!t || t !== r.targetStamp) return `agent "${r.target}" is not the agent it was handed to any more`;
    }
    let ok = false;
    try { ok = !!(await this.mayTarget(r.caller, r.target)); } catch { ok = false; }
    return ok ? '' : `agent "${r.caller}" may no longer hand work to "${r.target}"`;
  }

  /** Ends an open hand-off that may not run any more: its turn stopped, its continuations cancelled, reported as failed. */
  _fail(r, why) {
    if (r.state === 'running' && this.isAgentActive(r.target)) { try { this.stopTurn(r.target); } catch {} }
    try { this.cancelContinuations(r.id); } catch {}
    r.state = 'failed'; r.error = why; r.endedAt = this.now();
    r.report = { kind: 'failed', state: 'pending', attempts: 0, deliveredAt: null };
    this._save();
    this._soon();
  }

  async _startTurn(r, previous, message) {
    const why = await this._invalid(r);
    if (!isOpen(r)) return;   // cancelled meanwhile
    if (why) { this._fail(r, why); return; }
    let included = [];
    if (message === null) {
      included = r.notes.filter((n) => !n.delivered);
      message = noteMessage(r, included);
    } else {
      included = r.notes.filter((n) => !n.delivered);
    }
    const wasStarted = r.startedAt;
    r.state = 'running';
    if (!r.startedAt) r.startedAt = this.now();
    if (!this._save()) { r.state = previous; r.startedAt = wasStarted; return; }   // no work before the state is on disk
    const origin = {
      kind: 'hand_off', from: r.caller, handOffId: r.id, label: `Hand-off from ${r.caller}: ${r.topic}`,
      ...(r.member ? { member: true } : {}),
    };
    let turn;
    try {
      turn = await this.startTurn(r.target, message, { origin });
    } catch (e) {
      if (r.state !== 'running') return;   // cancelled while starting: nothing was admitted
      if (e && (e.status === 409 || e.status === 503)) {
        r.state = previous;
        this._save();
        return;
      }
      r.state = 'failed';
      r.error = (e && e.message) || String(e);
      r.endedAt = this.now();
      r.report = { kind: 'failed', state: 'pending', attempts: 0, deliveredAt: null };
      this._save();
      this._soon();
      return;
    }
    if (r.state !== 'running') {
      // cancelled (or failed) while the hub was admitting the turn: that turn is stopped at once (review r1)
      try { this.stopTurn(r.target); } catch {}
      return;
    }
    for (const n of included) n.delivered = true;
    this._save();
    const done = turn && turn.done ? Promise.resolve(turn.done) : Promise.resolve('');
    done.then((reply) => this.turnEnded(r.id, reply), () => this.turnEnded(r.id, ''));
  }

  /** Before a continuation turn (the target's scheduled task or job notice) starts (review r3): true when it may run.
   *  Over, unknown or not this agent's: false. A replaced caller or target, or lost access: the hand-off fails, false. */
  async mayContinue(id, agent) {
    const r = this.items.get(id);
    if (!r || !isOpen(r) || (agent !== undefined && agent !== r.target)) return false;
    const why = await this._invalid(r);
    if (!isOpen(r)) return false;
    if (why) { this._fail(r, why); return false; }
    return true;
  }

  /** A continuation turn (the target's scheduled task or job notice) was admitted. false: the hand-off is over or isn't
   *  this agent's, so the caller (lib/sdk-chat) stops that turn. A stale caller or target fails the hand-off. */
  turnStarted(id, agent) {
    const r = this.items.get(id);
    if (!r || !isOpen(r)) return false;
    if (agent !== undefined && agent !== r.target) return false;
    this.idleSince.delete(id);
    if (r.state === 'waiting') { r.state = 'running'; this._save(); }
    this._invalid(r).then((why) => { if (why && isOpen(r)) this._fail(r, why); }, () => {});
    return true;
  }

  turnEnded(id, replyText, agent) {
    const r = this.items.get(id);
    if (!r || !isOpen(r)) return;
    if (agent !== undefined && agent !== r.target) return;
    this.idleSince.delete(id);
    const reply = String(replyText == null ? '' : replyText);
    r.turns++;
    r.lastReply = cut(reply, LAST_REPLY_CHARS);
    if (reply.trim()) r.lastFull = cutEllipsis(reply, RESULT_CHARS);
    let more = false;
    try { more = !!this.hasContinuation(id); } catch (e) { more = true; this.log(`can't tell whether ${id} has more to do (${e.message}): it keeps waiting`); }   // the reconcile looks again
    if (more || r.notes.some((n) => !n.delivered)) {
      r.state = 'waiting';
    } else {
      r.state = 'done';
      r.endedAt = this.now();
      r.result = reply.trim() ? cutEllipsis(reply, RESULT_CHARS) : (r.lastFull || '');
      r.report = { kind: 'finished', state: 'pending', attempts: 0, deliveredAt: null };
    }
    this._save();
    this._soon();
  }

  async _deliver(r) {
    let callerNow = null;
    if (this.stampOf) { try { callerNow = this.stampOf(r.caller); } catch { callerNow = null; } }
    if (!(await this.agentExists(r.caller)) || (this.stampOf && callerNow !== r.callerStamp)) {
      // the caller is gone, or another agent now has its name: the report is not given to it
      this.log(`report for ${r.id} dropped: agent "${r.caller}" is gone or is another agent now`);
      r.report.state = 'dropped';
      this._save();
      return;
    }
    // Delivered at most once: 'delivering' is on disk before the turn, and a report the caller's conversation already
    // holds (a crash after delivery) is only marked delivered (review r1).
    let already = false; try { already = !!this.alreadyDelivered(r.caller, r.id); } catch { already = false; }
    if (already) { r.report.state = 'delivered'; r.report.deliveredAt = r.report.deliveredAt || this.now(); this._save(); return; }
    r.report.state = 'delivering';
    if (!this._save()) { r.report.state = 'pending'; return; }
    const kind = r.report.kind;
    const meta = {
      kind: 'hand_off', from: r.target, handOffId: r.id, label: `Hand-off ${kind}: ${r.topic}`,
      ...(r.member ? { member: true } : {}),
    };
    try {
      await this.deliver(r.caller, reportMessage(r), meta);
      r.report.state = 'delivered';
      r.report.deliveredAt = this.now();
      this.notBefore.delete(r.id);
    } catch (e) {
      r.report.state = 'pending';
      r.report.attempts++;
      this.notBefore.set(r.id, this.now() + this.retryMs);
    }
    this._save();
  }

  // ---- lifecycle ----------------------------------------------------------------------------------------------
  start() {
    const at = this.now();
    if (this.loadError) { this.log('not started: the state file could not be read'); return; }
    for (const r of this.items.values()) {
      // a delivery the restart cut short: tried again; the caller's conversation tells whether it already arrived
      if (r.report && r.report.state === 'delivering') r.report.state = 'pending';
      if (r.state === 'running') {
        r.state = 'interrupted';
        r.endedAt = at;
        r.report = { kind: 'interrupted', state: 'pending', attempts: 0, deliveredAt: null };
        // its scheduled continuations would wake the target for a hand-off that no longer reports: cancel them
        try { this.cancelContinuations(r.id); } catch (e) { this.log('cancelContinuations failed:', e.message); }
      }
    }
    this._save();
    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(() => { this.tick().catch((e) => this.log('tick failed:', e.message)); }, this.pollMs);
    if (this._timer.unref) this._timer.unref();
    this._soon();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

let singleton = null;
function getHandOffs(opts) {
  if (!singleton) singleton = new HandOffs(opts);
  return singleton;
}

module.exports = {
  HandOffs, getHandOffs, slugify, MAX_OPEN_PER_CALLER, MAX_BRIEF, MAX_TOPIC, RESULT_CHARS,
  framingMessage, noteMessage, reportMessage,
};
