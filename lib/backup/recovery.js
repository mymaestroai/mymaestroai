'use strict';
/**
 * backup/recovery.js — recovery mode. After a restore (or its undo) the restored hub runs, but agents start no new work
 * until the owner presses Resume, and work that was pending in the backup is held item by item, because it may
 * already have happened (an email sent, a payment made after the backup was taken).
 *
 *   enter(root, journal, now)   at the first start of a restored setup, before the modules load their files: due one-off
 *                               scheduled tasks and waiting deliveries, queued tasks and queued consultations are held;
 *                               jobs that were running are marked interrupted; pending interjections are dropped;
 *                               repeating schedules continue from now on, with no catch-up runs
 *   active(root)                true until Resume (checked by the turn gate, the scheduler and the task queue)
 *   resume(root)                new work may start again; held items stay held until decided
 *   state(root)                 the record: { kind, since, restoredFrom, held: [...], resumedAt, interrupted, dropped }
 * Deciding a held item (Run or Skip) goes through the modules that own them (server routes, a later step).
 */
const fs = require('fs');
const path = require('path');

const fileOf = (root) => path.join(root, 'data', 'recovery-mode.json');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
// Written to disk before going on (file and folder flushed): the record of held items must outlive a power cut.
function writeJson(f, v) {
  const tmp = `${f}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, JSON.stringify(v, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, f);
  let d; try { d = fs.openSync(path.dirname(f), 'r'); fs.fsyncSync(d); } catch (e) { if (!['EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM', 'ENOSYS', 'EBADF'].includes(e.code)) throw e; } finally { if (d != null) try { fs.closeSync(d); } catch {} }
}

let cache = { file: null, mtime: -1, value: null };
function state(root) {
  const f = fileOf(root);
  let m; try { const st = fs.statSync(f); m = `${st.mtimeMs}:${st.ino}:${st.size}`; } catch { cache = { file: f, mtime: -1, value: null }; return null; }
  if (cache.file !== f || cache.mtime !== m) cache = { file: f, mtime: m, value: readJson(f) };
  return cache.value;
}
function active(root) { const s = state(root); return !!(s && !s.resumedAt); }
function resume(root, now = Date.now) {
  const s = state(root);
  if (!s || s.resumedAt) return false;
  s.resumedAt = new Date(now()).toISOString();
  writeJson(fileOf(root), s);
  return true;
}

// Run at every start of a restored setup until it has run for this journal: the record is written first, so the pause holds
// even if this is interrupted, and items already held are kept when it runs again.
function enterOnce(root, journal = {}, now = Date.now) {
  const s = state(root);
  if (s && journal.id && s.journalId === journal.id && s.phase === 'done') return s;
  return enter(root, journal, now);
}
function enter(root, journal = {}, now = Date.now) {
  const D = (...p) => path.join(root, 'data', ...p);
  const t = now();
  const prev = state(root);
  const same = prev && journal.id && prev.journalId === journal.id;
  const rec = same ? prev : { kind: journal.kind || 'restore', journalId: journal.id || null, since: new Date(t).toISOString(), restoredFrom: journal.backup ? journal.backup.created : null, held: [], interrupted: [], dropped: { interjections: 0 }, resumedAt: null };
  rec.phase = 'holding';
  writeJson(fileOf(root), rec);   // paused from here on
  const held = rec.held, interrupted = rec.interrupted, dropped = rec.dropped;
  const hold = (item) => { if (!held.some(h => h.id === item.id)) held.push(item); };
  // Scheduled tasks: due one-offs held, waiting deliveries held, repeating ones moved on to their next time after now.
  const st = readJson(D('scheduled-tasks.json'));
  if (st && Array.isArray(st.tasks)) {
    let sched = null; try { sched = require('../scheduled-tasks'); } catch {}
    for (const task of st.tasks) {
      if (!task || task.status !== 'active' || !task.nextRunAt || Date.parse(task.nextRunAt) > t) continue;
      if (task.schedule && task.schedule.type === 'recurring' && sched) {
        try { const n = sched.nextCronRun(sched.parseCron(task.schedule.cron), t, task.schedule.tz); task.nextRunAt = n === null ? null : new Date(n).toISOString(); continue; } catch { /* hold it instead */ }
      }
      task.status = 'held'; task.note = 'held after a restore: Run or Skip';
    }
    for (const task of st.tasks) if (task && task.status === 'held') hold({ id: `schedule:${task.id}`, kind: 'schedule', taskId: task.id, agent: task.agent, label: task.label || null, due: task.nextRunAt });
    for (const p of Array.isArray(st.pending) ? st.pending : []) {
      const task = st.tasks.find(x => x && x.id === p.taskId);
      hold({ id: `delivery:${p.taskId}:${p.dueAt}`, kind: 'delivery', taskId: p.taskId, agent: p.agent, label: task ? task.label || null : null, due: p.dueAt, item: p });
    }
    writeJson(fileOf(root), rec);   // the held items are on record before they leave their queues
    st.pending = [];
    writeJson(D('scheduled-tasks.json'), st);
  }
  // Queued tasks (task-queue.db)
  if (fs.existsSync(D('task-queue.db'))) {
    try {
      const Database = require('better-sqlite3');
      const db = new Database(D('task-queue.db'));
      try {
        for (const r of db.prepare("SELECT id, target_agent, action_prompt, execute_at, status FROM tasks WHERE status IN ('pending', 'running', 'held')").all()) {
          hold({ id: `task:${r.id}`, kind: 'task', taskId: r.id, agent: r.target_agent, label: String(r.action_prompt || '').slice(0, 140), due: r.execute_at || null, wasRunning: r.status === 'running' });
        }
        writeJson(fileOf(root), rec);
        db.prepare("UPDATE tasks SET status = 'held' WHERE status IN ('pending', 'running')").run();
      } finally { db.close(); }
    } catch (e) { if (!/no such table/.test(String(e && e.message))) throw e; /* an older database without the queue: nothing to hold */ }
  }
  // Queued consultations
  const cq = readJson(D('consult-queue.json'));
  if (cq && Array.isArray(cq.jobs) && cq.jobs.length) {
    for (const [i, job] of cq.jobs.entries()) hold({ id: `consult:${job.id || i}`, kind: 'consult', agent: job.agent || job.to || null, label: String(job.prompt || job.message || '').slice(0, 140), item: job });
    writeJson(fileOf(root), rec);
    cq.jobs = [];
    writeJson(D('consult-queue.json'), cq);
  }
  // Interjections into turns that no longer exist
  const pi = readJson(D('pending-interjections.json'));
  if (pi && typeof pi === 'object') {
    dropped.interjections += Array.isArray(pi) ? pi.length : Object.values(pi).reduce((n, v) => n + (Array.isArray(v) ? v.length : 1), 0);
    if (dropped.interjections) writeJson(D('pending-interjections.json'), Array.isArray(pi) ? [] : {});
  }
  // Background jobs that were running when the backup was made
  const ji = readJson(D('jobs', 'index.json'));
  if (ji && Array.isArray(ji.jobs)) {
    let changed = false;
    for (const j of ji.jobs) if (j && j.status === 'running') { j.status = 'interrupted'; j.endedAt = new Date(t).toISOString(); j.note = 'interrupted by a restore'; if (!interrupted.includes(j.id)) interrupted.push(j.id); changed = true; }
    if (changed) writeJson(D('jobs', 'index.json'), ji);
  }
  rec.phase = 'done';
  writeJson(fileOf(root), rec);
  return rec;
}

// A held item was decided (Run or Skip): it leaves the list and is recorded with the choice.
function decided(root, id, action, now = Date.now) {
  const s = state(root);
  if (!s) return null;
  const i = (s.held || []).findIndex(h => h.id === id);
  if (i < 0) return null;
  const [item] = s.held.splice(i, 1);
  (s.decided = s.decided || []).push({ id: item.id, kind: item.kind, label: item.label || null, action, at: new Date(now()).toISOString() });
  writeJson(fileOf(root), s);
  return { item, action, remaining: s.held.length };
}

module.exports = { enter, enterOnce, active, resume, state, decided, fileOf };
