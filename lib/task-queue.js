'use strict';

/**
 * task-queue.js — Persistent One-Shot Task Queue for Agents
 *
 * Agents can create tasks that fire once when a condition is met:
 *   - at_time: execute at a specific datetime
 *   - delay: execute after N minutes
 *   - when_agent_idle: execute when a target agent finishes current work
 *   - when_condition: periodically evaluate a condition (future)
 *
 * Tasks are stored in SQLite and checked every 10 seconds.
 * Completed tasks are pruned after 7 days.
 */

const Database = require('better-sqlite3');
const path = require('path');
const http = require('http');
const { isAgentActive } = require('./sdk-chat');

const DB_PATH = path.join(__dirname, '..', 'data', 'task-queue.db');
const HUB_PORT = parseInt(process.env.PORT || '8888', 10);

let db;
let checkInterval = null;

// ── Database Setup ──────────────────────────────────────────────────────

function initDB() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      creator_agent TEXT NOT NULL,
      target_agent TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      trigger_value TEXT,
      action_prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      execute_at TEXT,
      executed_at TEXT,
      result TEXT,
      error TEXT
    )
  `);

  // Prune completed tasks older than 7 days
  db.exec(`
    DELETE FROM tasks
    WHERE status IN ('completed', 'failed')
    AND executed_at < datetime('now', '-7 days')
  `);
}

// ── Task Creation ───────────────────────────────────────────────────────

function createTask({ creator_agent, target_agent, trigger_type, trigger_value, action_prompt }) {
  if (!db) initDB();

  const valid_triggers = ['at_time', 'delay', 'when_agent_idle'];
  if (!valid_triggers.includes(trigger_type)) {
    throw new Error(`Invalid trigger_type: ${trigger_type}.  Valid: ${valid_triggers.join(', ')}`);
  }

  let execute_at = null;

  if (trigger_type === 'at_time') {
    const d = new Date(trigger_value);
    if (!trigger_value || isNaN(d.getTime())) throw new Error(`at_time trigger_value must be a parseable datetime (ISO 8601), got: ${JSON.stringify(trigger_value)}`);
    execute_at = d.toISOString();
  } else if (trigger_type === 'delay') {
    const minutes = parseInt(trigger_value, 10);
    if (isNaN(minutes) || minutes < 1) throw new Error('delay trigger_value must be minutes (integer >= 1)');
    const d = new Date(Date.now() + minutes * 60000);
    execute_at = d.toISOString();
  }

  const stmt = db.prepare(`
    INSERT INTO tasks (creator_agent, target_agent, trigger_type, trigger_value, action_prompt, execute_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(creator_agent, target_agent, trigger_type, trigger_value || null, action_prompt, execute_at);
  console.log(`[task-queue] Created task #${result.lastInsertRowid}: ${trigger_type} → ${target_agent}`);
  return { id: result.lastInsertRowid, status: 'pending', trigger_type, execute_at };
}

// ── Task Checking Loop ──────────────────────────────────────────────────

async function checkPendingTasks() {
  if (!db) initDB();

  const pending = db.prepare(`SELECT * FROM tasks WHERE status = 'pending'`).all();
  if (pending.length === 0) return;

  for (const task of pending) {
    let shouldFire = false;

    switch (task.trigger_type) {
      case 'at_time':
      case 'delay': {
        if (task.execute_at && new Date(task.execute_at) <= new Date()) {
          shouldFire = true;
        }
        break;
      }
      case 'when_agent_idle': {
        const watchAgent = task.trigger_value;
        if (watchAgent && !isAgentActive(watchAgent)) {
          shouldFire = true;
        }
        break;
      }
    }

    if (shouldFire) {
      // Mark as running to prevent double-fire
      db.prepare(`UPDATE tasks SET status = 'running' WHERE id = ?`).run(task.id);
      console.log(`[task-queue] Firing task #${task.id}: ${task.trigger_type} → ${task.target_agent}`);

      try {
        const outcome = await executeTask(task);
        if (outcome && outcome.busy) continue;   // re-queued as pending; nothing ran
        db.prepare(`UPDATE tasks SET status = 'completed', executed_at = datetime('now') WHERE id = ?`).run(task.id);
        console.log(`[task-queue] Task #${task.id} completed`);
      } catch (e) {
        db.prepare(`UPDATE tasks SET status = 'failed', executed_at = datetime('now'), error = ? WHERE id = ?`).run(e.message, task.id);
        console.error(`[task-queue] Task #${task.id} failed:`, e.message);
      }
    }
  }
}

// ── Task Execution ──────────────────────────────────────────────────────

async function executeTask(task) {
  // Check if target agent is busy
  if (isAgentActive(task.target_agent)) {
    // Re-queue for next check cycle
    db.prepare(`UPDATE tasks SET status = 'pending' WHERE id = ?`).run(task.id);
    console.log(`[task-queue] Task #${task.id}: target agent "${task.target_agent}" busy, will retry`);
    return { busy: true };
  }

  const prompt = `QUEUED TASK (created by agent "${task.creator_agent}"):\n\n${task.action_prompt}`;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      agent: task.target_agent,
      message: prompt,
    });

    const req = http.request({
      hostname: '127.0.0.1',
      port: HUB_PORT,
      path: '/api/chat',
      method: 'POST',
      headers: {
        [require('./auth').SERVICE_HEADER]: require('./auth').SERVICE_TOKEN,   // the hub calling itself
          'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 300000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 409) {
          // Lost the race with another turn: put it back, the next cycle retries.
          db.prepare(`UPDATE tasks SET status = 'pending' WHERE id = ?`).run(task.id);
          console.log(`[task-queue] Task #${task.id}: hub reported agent "${task.target_agent}" busy (409), will retry`);
          return resolve({ busy: true });
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`hub refused the turn (${res.statusCode}): ${data.slice(0, 200)}`));
        }
        resolve(data);
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Task execution timed out (5m)'));
    });
    req.write(body);
    req.end();
  });
}

// ── Query ───────────────────────────────────────────────────────────────

function listTasks({ status, agent, limit = 200 } = {}) {
  if (!db) initDB();

  let sql = 'SELECT * FROM tasks WHERE 1=1';
  const params = [];

  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (agent) {
    sql += ' AND (creator_agent = ? OR target_agent = ?)';
    params.push(agent, agent);
  }

  // created_at has one-second resolution; id breaks ties so the newest task is always first.
  const n = Math.max(1, parseInt(limit, 10) || 200);
  sql += ` ORDER BY created_at DESC, id DESC LIMIT ${n}`;
  return db.prepare(sql).all(...params);
}

function cancelTask(taskId) {
  if (!db) initDB();
  const result = db.prepare(`UPDATE tasks SET status = 'cancelled' WHERE id = ? AND status = 'pending'`).run(taskId);
  return result.changes > 0;
}

// ── Lifecycle ───────────────────────────────────────────────────────────

function startTaskQueue() {
  if (!db) initDB();
  if (checkInterval) return;

  checkInterval = setInterval(() => {
    if (require('./backup/recovery').active(require('path').join(__dirname, '..'))) return;   // after a restore: nothing runs until Resume
    checkPendingTasks().catch(e => console.error('[task-queue] Check error:', e.message));
  }, 10000); // Every 10 seconds

  console.log('[task-queue] Started (checking every 10s)');
}

function stopTaskQueue() {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
  if (db) {
    db.close();
    db = null;
  }
  console.log('[task-queue] Stopped');
}

// ── Exports ─────────────────────────────────────────────────────────────

module.exports = {
  createTask,
  listTasks,
  cancelTask,
  startTaskQueue,
  stopTaskQueue,
};
