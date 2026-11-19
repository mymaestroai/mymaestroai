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
    `The brief is saved at ${r.folder}/brief.md.`,
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
      if (e.code !== 'ENOENT') this.log('could not read state:', e.message);
    }
  }

  _save() {
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
    } catch (e) { this.log('could not save state:', e.message); }
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

  _status(r) {
    try { return cutEllipsis(fs.readFileSync(path.join(r.folder, 'STATUS.md'), 'utf8'), STATUS_CHARS); } catch { return null; }
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
    if (!(await this.agentExists(target))) throw new Error(`There is no agent named "${target}".`);
    const open = this.forCaller(caller).filter(isOpen).length;
    if (open >= MAX_OPEN_PER_CALLER) {
      throw new Error(`You have ${MAX_OPEN_PER_CALLER} hand-offs open (queued or running). Wait for one to finish or cancel one.`);
    }
    const base = this.filesFolderFor(target);
    if (!base) throw new Error(`Agent "${target}" has no Files folder, so it can't take a hand-off.`);

    const slug = slugify(topic);
    const parent = path.join(base, 'hand-offs');
    let folder = path.join(parent, `${caller}-${slug}`);
    for (let i = 2; fs.existsSync(folder); i++) folder = path.join(parent, `${caller}-${slug}-${i}`);
    fs.mkdirSync(folder, { recursive: true });
    const at = this.now();
    fs.writeFileSync(path.join(folder, 'brief.md'), `# ${topic}\n\nFrom agent ${caller}, ${new Date(at).toISOString()}\n\n${brief}\n`);

    const r = {
      id: newId(), caller, target, topic, slug, folder, brief, state: 'queued', createdAt: at, startedAt: null, endedAt: null,
      turns: 0, member: !!member, notes: [], result: null, lastReply: null, error: null, report: null,
    };
    this.items.set(r.id, r);
    this._save();
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
    if (r.state === 'running' && this.isAgentActive(r.target)) {
      try { this.stopTurn(r.target); } catch (e) { this.log('stopTurn failed:', e.message); }
    }
    try { this.cancelContinuations(r.id); } catch (e) { this.log('cancelContinuations failed:', e.message); }
    r.state = 'cancelled';
    r.endedAt = this.now();
    this._save();
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
    const now = this.now();
    for (const r of [...this.items.values()]) {
      if (!r.report || r.report.state !== 'pending') continue;
      if (this.holds(r.caller, r)) continue;
      if ((this.notBefore.get(r.id) || 0) > now) continue;
      try { await this._deliver(r); } catch (e) { this.log('deliver failed for', r.id, e.message); }
    }
  }

  async _startTurn(r, previous, message) {
    let included = [];
    if (message === null) {
      included = r.notes.filter((n) => !n.delivered);
      message = noteMessage(r, included);
    } else {
      included = r.notes.filter((n) => !n.delivered);
    }
    r.state = 'running';
    if (!r.startedAt) r.startedAt = this.now();
    this._save();
    const origin = {
      kind: 'hand_off', from: r.caller, handOffId: r.id, label: `Hand-off from ${r.caller}: ${r.topic}`,
      ...(r.member ? { member: true } : {}),
    };
    let turn;
    try {
      turn = await this.startTurn(r.target, message, { origin });
    } catch (e) {
      if (r.state !== 'running') return;   // cancelled while starting
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
    for (const n of included) n.delivered = true;
    this._save();
    const done = turn && turn.done ? Promise.resolve(turn.done) : Promise.resolve('');
    done.then((reply) => this.turnEnded(r.id, reply), () => this.turnEnded(r.id, ''));
  }

  turnStarted(id) {
    const r = this.items.get(id);
    if (!r || !isOpen(r)) return;
    if (r.state === 'waiting') { r.state = 'running'; this._save(); }
  }

  turnEnded(id, replyText) {
    const r = this.items.get(id);
    if (!r || !isOpen(r)) return;
    const reply = String(replyText == null ? '' : replyText);
    r.turns++;
    r.lastReply = cut(reply, LAST_REPLY_CHARS);
    let more = false;
    try { more = !!this.hasContinuation(id); } catch { more = false; }
    if (more || r.notes.some((n) => !n.delivered)) {
      r.state = 'waiting';
    } else {
      r.state = 'done';
      r.endedAt = this.now();
      r.result = cutEllipsis(reply, RESULT_CHARS);
      r.report = { kind: 'finished', state: 'pending', attempts: 0, deliveredAt: null };
    }
    this._save();
    this._soon();
  }

  async _deliver(r) {
    if (!(await this.agentExists(r.caller))) {
      r.report.state = 'dropped';
      this._save();
      return;
    }
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
      r.report.attempts++;
      this.notBefore.set(r.id, this.now() + this.retryMs);
    }
    this._save();
  }

  // ---- lifecycle ----------------------------------------------------------------------------------------------
  start() {
    const at = this.now();
    for (const r of this.items.values()) {
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
