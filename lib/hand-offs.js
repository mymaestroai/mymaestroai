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
const MAX_LATER = 5;            // shorter replies kept after the report (the latest ones)
const LATER_CHARS = 2000;       // each of them, cut to this
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
    `Keep ${r.folder}/STATUS.md current (done, next, blockers) so "${r.caller}" can check progress${r.briefFile === false ? '; make that folder first' : ''}.`,
    ...(r.briefFile === false ? [] : [`The brief is saved at ${r.folder}/brief.md.`]),
    `When the work is finished, end your turn with a short final report: it goes back to "${r.caller}" automatically.`,
    'A job you started that is still running (a test server, say) keeps the hand-off open until it ends; your report waits for it, and a shorter reply after it (on that job\'s end, say) is added below your report, never in its place.',
  );
  return lines.join('\n');
}

function noteMessage(r, notes) {
  const lines = [`[Note from agent "${r.caller}" on hand-off ${r.id} "${r.topic}" — not a message from the owner]`];
  for (const n of notes || []) lines.push(typeof n === 'string' ? n : n.text);
  lines.push('Carry on with the hand-off; keep STATUS.md current.');
  return lines.join('\n');
}

/** The target's fullest reply and the shorter replies after it, in order; null when nothing came after the fullest one. */
function repliesBlock(r) {
  const later = Array.isArray(r.resultLater) ? r.resultLater : [];
  if (!later.length) return null;
  const n = r.turns;
  const from = r.resultTurn ? `turn ${r.resultTurn} of ${n}` : `an earlier turn; ${n} in all`;
  return [
    `Its fullest reply (${from}):`,
    r.result || '(no reply text)',
    '',
    `Its later, shorter replies, in order${r.resultLaterLeftOut ? ` (the latest ${later.length}; ${r.resultLaterLeftOut} earlier left out)` : ''}:`,
    ...later.map((l) => `Turn ${l.turn}: ${l.text}`),
  ];
}

/** True when the report would pass on what the target wrote (its replies or its final report). */
function reportCarriesReplies(r) {
  const kind = (r.report && r.report.kind) || 'finished';
  if (kind === 'finished') return true;
  if (kind === 'interrupted' || kind === 'ended') return !!r.result;
  return false;
}

function reportMessage(r) {
  const kind = (r.report && r.report.kind) || 'finished';
  const status = `Status: ${r.folder}/STATUS.md`;
  if (kind === 'interrupted') {
    // what it had replied in earlier turns is not lost with the turn the restart cut short
    const before = r.result ? (repliesBlock(r) || [r.result]) : null;
    return [
      `[Hand-off interrupted] "${r.topic}" (id ${r.id}): the hub restarted while agent "${r.target}" was working on it, so that turn ended unfinished.`,
      status,
      'Hand it off again if it still needs doing; the folder keeps the brief and the status.',
      ...(before ? ['', 'What it had replied before the restart:', ...before] : []),
    ].join('\n');
  }
  if (kind === 'withheld') {
    return `[Hand-off ended] "${r.topic}" (id ${r.id}): ${(r.report && r.report.why) || 'access changed'}, so what agent "${r.target}" replied is not passed on.`;
  }
  if (kind === 'ended') {
    // it had to stop part-way (the target removed or replaced, or the caller may no longer hand work to it)
    const before = r.result ? (repliesBlock(r) || [r.result]) : null;
    return [
      `[Hand-off interrupted] "${r.topic}" (id ${r.id}): it ended before agent "${r.target}" finished, because ${r.error}.`,
      status,
      'Hand it off again if it still needs doing; the folder keeps the brief and the status.',
      ...(before ? ['', 'What it had replied before it ended:', ...before] : []),
    ].join('\n');
  }
  if (kind === 'failed') {
    return `[Hand-off failed] "${r.topic}" (id ${r.id}): it could not start agent "${r.target}": ${r.error}.`;
  }
  const n = r.turns;
  // The fullest reply comes first; shorter replies after it (a note on a job's end, a short "done") follow, in order.
  const body = repliesBlock(r) || ['Its final report:', r.result || '(no reply text)'];
  return [
    `[Hand-off finished] "${r.topic}" (id ${r.id}): agent "${r.target}" finished after ${n} turn${n === 1 ? '' : 's'}.`,
    status,
    '',
    ...body,
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
    // what a waiting hand-off waits for: { kind: 'task', at } (earliest tagged scheduled task) | { kind: 'job' } | null
    this.nextStepOf = o.nextStepOf || (() => null);
    this.interject = o.interject || (() => false);
    this.stopTurn = o.stopTurn || (() => {});
    this.cancelContinuations = o.cancelContinuations || (() => {});
    this.filesFolderFor = o.filesFolderFor || (() => null);
    this.holds = o.holds || (() => false);
    // Review r1: who the caller and target are (an identity stamp, lib/agents agentStamp) and whether the caller may still
    // reach the target (the consult rule), checked again before every start and report; a report already in the caller's
    // conversation is never sent twice.
    // The stamp is the agent's identity (lib/agents agentIdentity: its box id, or its name for an agent from before box ids),
    // so an ordinary edit (a model switch) keeps the hand-off; sameAgent(stored, now) also reads a record's older stamp.
    this.stampOf = o.stampOf || null;
    this.sameAgent = o.sameAgent || ((stored, now) => !!stored && stored === now);
    this.ownerOf = o.ownerOf || (() => null);
    // a report no agent may receive (its caller is gone or is another agent now): the caller's owner is told instead
    this.notifyOwner = o.notifyOwner || (() => {});
    this.mayTarget = o.mayTarget || (async () => true);
    this.alreadyDelivered = o.alreadyDelivered || (() => false);
    // Folder work goes through /proc/self/fd where the system has it (Linux); elsewhere (macOS) through the folder helper
    // (lib/hand-off-folder.js), which is as safe. HUB_HANDOFF_NO_PROC=1 uses the helper on Linux too (tests, proofs).
    this.procFd = o.procFd !== undefined ? !!o.procFd
      : process.env.HUB_HANDOFF_NO_PROC === '1' ? false
        : (fs.constants.O_DIRECTORY !== undefined && fs.existsSync('/proc/self/fd'));
    this.folderHelper = o.folderHelper || require('./hand-off-folder');
    this.creating = new Map();   // caller -> hand-offs being created right now (memory only)
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
    let next = null;
    let nextKnown = true;
    if (r.state === 'waiting') { try { next = this.nextStepOf(r.id) || null; } catch { next = null; nextKnown = false; } }   // unknown: left out, so the page says "Working"
    return {
      ...(nextKnown ? { next } : {}),
      reported: !!(r.report && r.report.state === 'delivered'),
      reportedAt: (r.report && r.report.deliveredAt) || null,
      id: r.id, caller: r.caller, target: r.target, topic: r.topic, state: r.state, folder: r.folder,
      createdAt: r.createdAt, startedAt: r.startedAt, endedAt: r.endedAt, turns: r.turns,
      queuedNotes: (r.notes || []).filter((n) => !n.delivered).length,
      lastReply: r.lastReply ? cut(r.lastReply, LAST_REPLY_CHARS) : r.lastReply,
      error: r.error,
    };
  }

  get(id) { return this.items.get(id) || null; }
  /** The caller's hand-offs: of that name AND started by this agent (review r2), so an agent made again under the same name
   *  never sees, notes or cancels an earlier agent's. An identity that can't be read shows none of them. */
  forCaller(caller) {
    const mine = this._callerTest(caller);
    return [...this.items.values()].filter((r) => r.caller === caller && mine(r));
  }
  _callerTest(caller) {
    if (!this.stampOf) return () => true;
    let now = null;
    try { now = this.stampOf(caller); } catch { now = null; }
    // review r3: a record without a stamp is never taken for this agent (every record since hand-offs began carries one)
    return (r) => !!r.callerStamp && this.sameAgent(r.callerStamp, now);
  }
  /** True while the target is still the agent the hand-off was given to: only then is its turn stopped or a note handed
   *  to it (review r3), so a re-made agent of that name is never interrupted by an earlier agent's hand-off. */
  _targetSame(r) {
    if (!this.stampOf) return true;
    let now = null;
    try { now = this.stampOf(r.target); } catch { now = null; }
    return !!r.targetStamp && this.sameAgent(r.targetStamp, now);
  }

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

  /** What the caller is shown (the cards' API and hand_off_list): list() or listWithStatus(), and for a target the caller
   *  may no longer reach (or that can't be checked now) none of the target's words: no last reply, no STATUS.md (review r2). */
  async listShown(caller, { includeDone = false, withStatus = false } = {}) {
    const rows = withStatus ? await this.listWithStatus(caller, { includeDone }) : this.list(caller, { includeDone });
    const reach = new Map();
    for (const v of rows) {
      if (!reach.has(v.target)) {
        let why = 'access';
        try { why = (await this.mayTarget(caller, v.target)) ? '' : 'access'; } catch { why = 'unchecked'; }
        reach.set(v.target, why);
      }
      // review r3: no folder either, so no Status that would read STATUS.md another way
      if (reach.get(v.target)) { v.lastReply = null; if (withStatus) v.status = null; v.folder = null; v.withheld = reach.get(v.target); }
    }
    return rows;
  }

  /** list() with each hand-off's STATUS.md (hand_off_list). Without /proc/self/fd the files are read by the folder
   *  helper, one helper run per Files folder, so the hub never waits on a file the target controls. */
  async listWithStatus(caller, { includeDone = false } = {}) {
    if (this.procFd) return this.list(caller, { includeDone, withStatus: true });
    const rows = this.list(caller, { includeDone, withStatus: false });
    const byBase = new Map();
    for (const v of rows) {
      v.status = null;
      const r = this.items.get(v.id);
      if (!r || !r.base || path.dirname(r.folder) !== path.join(r.base, 'hand-offs') || !this._folderSafe(r)) continue;
      if (!byBase.has(r.base)) byBase.set(r.base, []);
      byBase.get(r.base).push({ v, name: path.basename(r.folder) });
    }
    for (const [base, list] of byBase) {
      let a = null;
      try { a = await this.folderHelper.run({ op: 'status', base, names: list.map((x) => x.name), maxBytes: STATUS_CHARS * 4, maxChars: STATUS_CHARS + 1 }); } catch { a = null; }
      if (!a || !a.ok || !a.status || typeof a.status !== 'object') continue;
      for (const x of list) {
        const t = Object.prototype.hasOwnProperty.call(a.status, x.name) ? a.status[x.name] : null;
        x.v.status = typeof t === 'string' ? cutEllipsis(t, STATUS_CHARS) : null;
      }
    }
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
      // only through an open folder (/proc/self/fd); without it listWithStatus reads through the folder helper
      if (!this.procFd || O_DIRECTORY === undefined) return null;
      dfd = fs.openSync(r.folder, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      const real = fs.realpathSync(`/proc/self/fd/${dfd}`);
      if (r.base && !real.startsWith(r.base + path.sep)) return null;
      const file = `/proc/self/fd/${dfd}/STATUS.md`;
      // a regular file with one link only (a hard link to a file elsewhere is refused, review r8), the same before and after the open
      const pre = fs.lstatSync(file, { bigint: true });
      if (!pre.isFile() || pre.nlink !== 1n) return null;
      fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
      const st = fs.fstatSync(fd, { bigint: true });
      if (!st.isFile() || st.nlink !== 1n || st.dev !== pre.dev || st.ino !== pre.ino) return null;
      const buf = Buffer.alloc(Math.min(Number(st.size), STATUS_CHARS * 4));
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
    // hand-offs being created count too: the folder helper is awaited, so two at once must not pass the cap (review r8)
    const open = this.forCaller(caller).filter(isOpen).length + (this.creating.get(caller) || 0);
    if (open >= MAX_OPEN_PER_CALLER) {
      throw new Error(`You have ${MAX_OPEN_PER_CALLER} hand-offs open (queued or running). Wait for one to finish or cancel one.`);
    }
    this.creating.set(caller, (this.creating.get(caller) || 0) + 1);
    try {
      return await this._make({ caller, target, topic, brief, member });
    } finally {
      const left = (this.creating.get(caller) || 1) - 1;
      if (left > 0) this.creating.set(caller, left); else this.creating.delete(caller);
    }
  }

  async _make({ caller, target, topic, brief, member }) {
    const base = this.filesFolderFor(target);
    if (!base) throw new Error(`Agent "${target}" has no Files folder, so it can't take a hand-off.`);

    let callerStamp = null, targetStamp = null;
    if (this.stampOf) {
      callerStamp = this.stampOf(caller); targetStamp = this.stampOf(target);
      if (!callerStamp || !targetStamp) throw new Error("Couldn't read the agents' records, so the hand-off was not started.");
    }
    let callerOwner = null;
    try { const o = this.ownerOf(caller); callerOwner = o ? String(o) : null; } catch { callerOwner = null; }

    // The job folder: never through a link (review r1). The Files folder itself is resolved once; hand-offs/ and the
    // job folder must be real directories inside it; brief.md is created new, never written through an existing file.
    fs.mkdirSync(base, { recursive: true });
    const baseReal = fs.realpathSync(base);
    const parent = path.join(baseReal, 'hand-offs');
    const notPlain = () => new Error(`Agent "${target}"'s hand-offs folder is not a plain folder, so the hand-off was not started.`);
    const slug = slugify(topic);
    const at = this.now();
    const briefText = `# ${topic}\n\nFrom agent ${caller}, ${new Date(at).toISOString()}\n\n${brief}\n`;
    const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = fs.constants;
    const viaFd = this.procFd && O_DIRECTORY !== undefined;
    const id = newId();
    let folder = null, made = null, briefSaved = false;
    if (!viaFd) {
      // Without /proc/self/fd (macOS): the folder helper makes hand-offs/ and the job folder and writes brief.md, stepping
      // into each folder and checking it is the same real directory once inside (lib/hand-off-folder.js).
      const a = await this.folderHelper.run({ op: 'make', base: baseReal, caller, slug, brief: briefText });
      if (!a || !a.ok) {
        if (a && a.code === 'not_plain') throw notPlain();
        if (a && a.code === 'too_many') throw new Error('Too many hand-off folders with that topic; choose another topic.');
        throw new Error(`Couldn't make the hand-off folder in agent "${target}"'s Files folder, so the hand-off was not started.`);
      }
      const name = String(a.name || '');
      if (!this.folderHelper.plainName(name) || (name !== `${caller}-${slug}` && !name.startsWith(`${caller}-${slug}-`))) throw notPlain();
      folder = path.join(parent, name);
      briefSaved = true;
    } else {
      // Through open folders (review r3): hand-offs/ is opened (never a link) and checked inside the Files folder; the job
      // folder is made and opened through it, and brief.md written through that, so swapping a folder for a link
      // meanwhile can't move them.
      try {
        const st = fs.lstatSync(parent);
        if (st.isSymbolicLink() || !st.isDirectory()) throw notPlain();
      } catch (e) { if (e.code === 'ENOENT') fs.mkdirSync(parent); else throw e; }
      let pfd;
      try {
        pfd = fs.openSync(parent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
        if (fs.realpathSync(`/proc/self/fd/${pfd}`) !== parent) throw notPlain();
        const at2 = `/proc/self/fd/${pfd}`;
        let name = null;
        for (let i = 1; i < 100 && !name; i++) {
          const n = i === 1 ? `${caller}-${slug}` : `${caller}-${slug}-${i}`;
          try { fs.mkdirSync(path.join(at2, n)); name = n; made = path.join(at2, n); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        }
        if (!name) throw new Error('Too many hand-off folders with that topic; choose another topic.');
        folder = path.join(parent, name);
        let cfd;
        try {
          cfd = fs.openSync(path.join(at2, name), O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
          if (fs.realpathSync(`/proc/self/fd/${cfd}`) !== folder) throw notPlain();
          fs.writeFileSync(`/proc/self/fd/${cfd}/brief.md`, briefText, { flag: 'wx' });
          briefSaved = true;
        } finally { if (cfd !== undefined) { try { fs.closeSync(cfd); } catch {} } }
      } catch (e) {
        // no empty job folder left behind (review r4): removed through the same open parent (rmdir: only an empty one)
        if (made && !briefSaved) { try { fs.rmdirSync(made); } catch {} }
        throw e;
      } finally { if (pfd !== undefined) { try { fs.closeSync(pfd); } catch {} } }
    }

    const r = {
      id, caller, target, topic, slug, folder, base: baseReal, brief, state: 'queued', createdAt: at, startedAt: null, endedAt: null,
      turns: 0, member: !!member, notes: [], result: null, lastReply: null, lastFull: null, error: null, report: null, callerStamp, targetStamp, callerOwner, briefFile: briefSaved,
    };
    this.items.set(r.id, r);
    if (!this._save()) { this.items.delete(r.id); throw new Error("Couldn't save the hand-off, so it was not started."); }
    this._soon();
    return this.view(r);
  }

  _own(caller, id) {
    const r = this.items.get(id);
    if (!r || r.caller !== caller || !this._callerTest(caller)(r)) throw new Error('No such hand-off.');
    if (!isOpen(r)) throw new Error(`That hand-off has ended (${r.state}).`);
    return r;
  }

  note({ caller, id, text } = {}) {
    const r = this._own(caller, id);
    if (!this._targetSame(r)) { this._soon(); throw new Error(`Agent "${r.target}" is not the agent it was handed to any more, so the note was not sent.`); }
    text = String(text == null ? '' : text);
    if (!text.trim()) throw new Error('A note needs some text.');
    if (text.length > MAX_NOTE) throw new Error(`The note is too long (at most ${MAX_NOTE} characters).`);
    const running = r.state === 'running';
    // on disk before it is acknowledged (review r4). A note for the running step is saved as delivered BEFORE it is
    // handed over, so a restart can never hand it over a second time; if the hand-over fails it is kept for the next step.
    const n = { at: this.now(), text, delivered: running };
    r.notes.push(n);
    if (!this._save()) { r.notes.pop(); throw new Error("Couldn't save the note, so it was not sent. Try again."); }
    if (running) {
      let ok = false;
      try { ok = !!this.interject(r.target, noteMessage(r, [n])); } catch { ok = false; }
      if (!ok) { n.delivered = false; this._save(); }
    }
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
    if (before.state === 'running' && this.isAgentActive(r.target) && this._targetSame(r)) {
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
      r.state = 'done'; r.endedAt = this.now(); this._settleResult(r);
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
      if (!this.sameAgent(r.callerStamp, c)) return `agent "${r.caller}" is not the agent that started it any more`;
      if (!this.sameAgent(r.targetStamp, t)) return `agent "${r.target}" is not the agent it was handed to any more`;
    }
    let ok = false;
    try { ok = !!(await this.mayTarget(r.caller, r.target)); } catch { ok = false; }
    return ok ? '' : this._accessWhy(r);
  }

  /** The reason a hand-off ends when its caller lost access to the target: then nothing the target wrote goes to it. */
  _accessWhy(r) { return `agent "${r.caller}" may no longer hand work to "${r.target}"`; }

  /** Ends an open hand-off that may not run any more: its turn stopped, its continuations cancelled, reported as failed. */
  _fail(r, why) {
    if (r.state === 'running' && this.isAgentActive(r.target) && this._targetSame(r)) { try { this.stopTurn(r.target); } catch {} }
    try { this.cancelContinuations(r.id); } catch {}
    r.state = 'failed'; r.error = why; r.endedAt = this.now();
    // what the target had replied goes with the notice, unless the caller may no longer reach it (review r1)
    if (why !== this._accessWhy(r) && (r.best || r.lastFull)) this._settleResult(r);
    r.report = { kind: 'ended', state: 'pending', attempts: 0, deliveredAt: null };
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
    // A record from before this rule (waiting through an update) has its earlier reply only in lastFull: it counts as the report
    // so far. Its turn is unknown; a text that was already cut has an unknown length, so no later reply takes its place (review r1).
    if (!r.best && r.lastFull && r.turns > 1) {
      const lf = String(r.lastFull);
      const wasCut = lf.length > RESULT_CHARS && lf.endsWith('…');
      r.best = { turn: null, size: wasCut ? Number.MAX_SAFE_INTEGER : lf.trim().length, text: lf };   // finite: it is saved as JSON
    }
    if (reply.trim()) { r.lastFull = cutEllipsis(reply, RESULT_CHARS); this._keepReply(r, reply); }
    let more = false;
    try { more = !!this.hasContinuation(id); } catch (e) { more = true; this.log(`can't tell whether ${id} has more to do (${e.message}): it keeps waiting`); }   // the reconcile looks again
    if (more || r.notes.some((n) => !n.delivered)) {
      r.state = 'waiting';
    } else {
      r.state = 'done';
      r.endedAt = this.now();
      this._settleResult(r);
      r.report = { kind: 'finished', state: 'pending', attempts: 0, deliveredAt: null };
    }
    this._save();
    this._soon();
  }

  /** A turn's reply (not empty). The report is the longest reply so far (a reply at least as long takes its place); a
   *  shorter reply after it, such as the note on a test server's job ending, is kept after it in order, never in its place. */
  _keepReply(r, reply) {
    const text = cutEllipsis(reply, RESULT_CHARS);
    const size = String(reply).trim().length;
    if (!r.best || size >= r.best.size) {
      r.best = { turn: r.turns, size, text };
      r.later = [];
      r.laterLeftOut = 0;
      return;
    }
    // The newest later reply is kept whole (it may be the real, short final report); the ones before it are cut to LATER_CHARS.
    const earlier = (r.later || []).map((l) => ({ turn: l.turn, text: cutEllipsis(l.text, LATER_CHARS) }));
    r.later = [...earlier, { turn: r.turns, text: cutEllipsis(String(reply).trim(), RESULT_CHARS) }];
    if (r.later.length > MAX_LATER) { r.laterLeftOut = (r.laterLeftOut || 0) + (r.later.length - MAX_LATER); r.later = r.later.slice(-MAX_LATER); }
  }

  /** What the finished report says: the report and the replies added after it. A record from before this rule (it was
   *  waiting through an update) has only its last reply. */
  _settleResult(r) {
    if (r.best) {
      r.result = r.best.text;
      r.resultTurn = r.best.turn;
      r.resultLater = (r.later || []).slice();
      r.resultLaterLeftOut = r.laterLeftOut || 0;
    } else {
      r.result = r.lastFull || '';
      r.resultTurn = null;
      r.resultLater = [];
      r.resultLaterLeftOut = 0;
    }
  }

  async _deliver(r) {
    let callerNow = null;
    if (this.stampOf) { try { callerNow = this.stampOf(r.caller); } catch { callerNow = null; } }
    if (!(await this.agentExists(r.caller)) || (this.stampOf && !this.sameAgent(r.callerStamp, callerNow))) {
      // the caller is gone, or another agent now has its name: the report is not given to it
      this.log(`report for ${r.id} dropped: agent "${r.caller}" is gone or is another agent now; its owner is told`);
      r.report.state = 'dropped';   // saved first: the notice goes out once, even if the hub stops right after it
      this._save();
      let told = null;
      try { told = await this.notifyOwner(r, `agent "${r.caller}" is gone or is another agent now`); } catch (e) { this.log('owner notice failed for', r.id, e && e.message); }
      r.report.ownerTold = { at: this.now(), sent: told && typeof told.sent === 'number' ? told.sent : null };
      this._save();
      return;
    }
    // Delivered at most once: 'delivering' is on disk before the turn, and a report the caller's conversation already
    // holds (a crash after delivery) is only marked delivered (review r1).
    // a report that carries what the target wrote goes only to a caller that may still reach it (review r1); an answer
    // that can't be had now is tried again later, a refusal passes the report on without the target's words
    if (reportCarriesReplies(r)) {
      let ok;
      try { ok = !!(await this.mayTarget(r.caller, r.target)); } catch { ok = null; }
      if (ok === null) { this.notBefore.set(r.id, this.now() + this.retryMs); return; }
      if (!ok) {
        r.result = null; r.resultLater = []; r.resultLaterLeftOut = 0;
        r.report.kind = 'withheld'; r.report.why = this._accessWhy(r);
        this._save();
      }
    }
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
        if (r.best || r.lastFull) this._settleResult(r);   // what it had replied before the cut-short turn goes with the notice
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
