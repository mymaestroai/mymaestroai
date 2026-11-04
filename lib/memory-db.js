'use strict';

/**
 * memory-db.js — SQLite-backed memory system for My Maestro AI
 *
 * Provides:
 *   - Per-agent long-term memory (replaces MEMORY.md read/write)
 *   - Per-agent session notes (replaces memory/*.md files)
 *   - Shared memory pool (cross-agent knowledge base)
 *   - Auto-distillation (summarize old sessions into long-term memory)
 *
 * All data lives in data/memory.db (single file, zero infrastructure).
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.HUB_MEMORY_DB || path.join(__dirname, '..', 'data', 'memory.db');
const SESSION_RETENTION_DAYS = 90;

// ── Database Setup ──────────────────────────────────────────────────────

let db;

function getDb() {
  if (db) return db;

  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');      // Better concurrent read performance
  db.pragma('busy_timeout = 5000');     // Wait up to 5s on lock contention

  // Create tables
  db.exec(`
    -- Per-agent long-term memory (distilled knowledge, persists forever)
    CREATE TABLE IF NOT EXISTS long_term_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      section TEXT NOT NULL DEFAULT 'general',
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ltm_agent ON long_term_memory(agent);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ltm_agent_section ON long_term_memory(agent, section);

    -- Per-agent session notes (daily logs, retained ${SESSION_RETENTION_DAYS} days)
    CREATE TABLE IF NOT EXISTS session_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'chat',
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sn_agent_date ON session_notes(agent, date);

    -- Shared memory pool (cross-agent knowledge base)
    CREATE TABLE IF NOT EXISTS shared_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      content TEXT NOT NULL,
      author TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sm_topic ON shared_memory(topic);

    -- Distillation log (tracks what's been distilled to avoid re-processing)
    CREATE TABLE IF NOT EXISTS distillation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      date TEXT NOT NULL,
      distilled_at TEXT NOT NULL DEFAULT (datetime('now')),
      summary TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dl_agent_date ON distillation_log(agent, date);
  `);

  return db;
}

// ── Long-Term Memory ────────────────────────────────────────────────────

function readLongTermMemory(agent, section) {
  const db = getDb();
  if (section) {
    const row = db.prepare(
      'SELECT content FROM long_term_memory WHERE agent = ? AND section = ?'
    ).get(agent, section);
    return row ? row.content : null;
  }
  const rows = db.prepare(
    'SELECT section, content FROM long_term_memory WHERE agent = ? ORDER BY section'
  ).all(agent);

  if (rows.length === 0) return '(no long-term memory)';

  return rows.map(r => {
    if (r.section === 'general') return r.content;
    return `## ${r.section}\n${r.content}`;
  }).join('\n\n');
}

function writeLongTermMemory(agent, content, section = 'general') {
  const db = getDb();
  db.prepare(`
    INSERT INTO long_term_memory (agent, section, content, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(agent, section) DO UPDATE SET
      content = excluded.content,
      updated_at = datetime('now')
  `).run(agent, section, content);
  return 'Long-term memory updated.';
}

function appendLongTermMemory(agent, content, section = 'general') {
  const db = getDb();
  const existing = db.prepare(
    'SELECT content FROM long_term_memory WHERE agent = ? AND section = ?'
  ).get(agent, section);

  const newContent = existing
    ? existing.content + '\n' + content
    : content;

  return writeLongTermMemory(agent, newContent, section);
}

// ── Session Notes ───────────────────────────────────────────────────────

function readSessionNotes(agent, date) {
  const db = getDb();
  const d = date || require('./timezone').localDate(require('./timezone').zoneForAgent(agent));   // "today" for the person the agent works for
  const rows = db.prepare(
    'SELECT time, category, content FROM session_notes WHERE agent = ? AND date = ? ORDER BY id'
  ).all(agent, d);

  if (rows.length === 0) return `(no session notes for ${d})`;

  return rows.map(r => `## ${r.time} — ${r.category}\n${r.content}`).join('\n\n');
}

function writeSessionNote(agent, note, category = 'Chat') {
  const db = getDb();
  // The day and time where the person the agent works for is (lib/timezone). The date used to be the UTC date and the
  // time the computer's, so an evening note could land under tomorrow.
  const tz = require('./timezone'); const zone = tz.zoneForAgent(agent); const now = Date.now();
  const date = tz.localDate(zone, now);
  const time = `${tz.localHm(zone, now)} ${tz.zoneName(zone, now)}`;   // "15:47 EDT": the zone stays with the note

  db.prepare(
    'INSERT INTO session_notes (agent, date, time, category, content) VALUES (?, ?, ?, ?, ?)'
  ).run(agent, date, time, category, note);

  return 'Session note saved.';
}

function writeAutoSessionNote(agent, userMessage, agentResponse) {
  if (!agentResponse || agentResponse.length < 50) return;

  const userPreview = userMessage.length > 200 ? userMessage.slice(0, 200) + '...' : userMessage;
  const assistantPreview = agentResponse.length > 500 ? agentResponse.slice(0, 500) + '...' : agentResponse;
  const note = `**User:** ${userPreview}\n**${agent}:** ${assistantPreview}`;

  writeSessionNote(agent, note, 'Chat');
}

// ── Shared Memory Pool ──────────────────────────────────────────────────

function ensureOwnerColumn(db) {
  try { const cols = db.prepare('PRAGMA table_info(shared_memory)').all().map(c => c.name); if (!cols.includes('owner')) db.exec('ALTER TABLE shared_memory ADD COLUMN owner TEXT'); } catch {}
}

/** owner: user id of the pool (null = the admin side pool). Rows are only visible within their pool. */
function readSharedMemory(topic, owner = null) {
  const db = getDb();
  ensureOwnerColumn(db);

  if (topic) {
    // Search by topic (exact or LIKE)
    const rows = db.prepare(
      'SELECT topic, content, author, tags, updated_at FROM shared_memory WHERE (topic = ? OR topic LIKE ?) AND owner IS ? ORDER BY updated_at DESC'
    ).all(topic, `%${topic}%`, owner);

    if (rows.length === 0) return `(no shared memory matching "${topic}")`;
    return rows.map(r =>
      `### ${r.topic}\n*by ${r.author} — ${r.updated_at}*\n${r.content}`
    ).join('\n\n---\n\n');
  }

  // List all topics
  const rows = db.prepare(
    'SELECT topic, author, LENGTH(content) as size, updated_at FROM shared_memory WHERE owner IS ? ORDER BY updated_at DESC LIMIT 50'
  ).all(owner);

  if (rows.length === 0) return '(shared memory is empty)';
  return 'Available shared memories:\n' + rows.map(r =>
    `- **${r.topic}** (by ${r.author}, ${r.size} chars, ${r.updated_at})`
  ).join('\n');
}

function writeSharedMemory(topic, content, author, tags = [], owner = null) {
  const db = getDb();
  ensureOwnerColumn(db);
  const tagsJson = JSON.stringify(tags);

  // One row per (topic, author): update it if present, insert otherwise.
  // (The table has no unique key, so INSERT ... ON CONFLICT never fired and
  // every rewrite used to add a duplicate row.)
  const existing = db.prepare('SELECT id FROM shared_memory WHERE topic = ? AND author = ? AND owner IS ?').get(topic, author, owner);
  if (existing) {
    db.prepare(`
      UPDATE shared_memory SET content = ?, tags = ?, updated_at = datetime('now')
      WHERE topic = ? AND author = ? AND owner IS ?
    `).run(content, tagsJson, topic, author, owner);
  } else {
    db.prepare(`
      INSERT INTO shared_memory (topic, content, author, tags, updated_at, owner)
      VALUES (?, ?, ?, ?, datetime('now'), ?)
    `).run(topic, content, author, tagsJson, owner);
  }

  return `Shared memory "${topic}" saved.`;
}

function searchSharedMemory(query, owner = null) {
  const db = getDb();
  ensureOwnerColumn(db);
  const like = `%${String(query).replace(/[\\%_]/g, '\\$&')}%`;
  const rows = db.prepare(
    `SELECT topic, content, author, tags, updated_at FROM shared_memory
     WHERE (content LIKE ? ESCAPE '\\' OR topic LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\') AND owner IS ?
     ORDER BY updated_at DESC LIMIT 20`
  ).all(like, like, like, owner);

  if (rows.length === 0) return `(no shared memory matching "${query}")`;
  return rows.map(r =>
    `### ${r.topic}\n*by ${r.author} — ${r.updated_at}*\n${r.content}`
  ).join('\n\n---\n\n');
}

// ── Context Loading (for System Prompt) ─────────────────────────────────

// Sections that are low-priority / high-volume — loaded last and trimmed hard.
// "Distilled Sessions" grows unbounded (one entry per day, forever).
const LOW_PRIORITY_SECTIONS = new Set(['Distilled Sessions']);
// How much of the memory budget the rolling distilled-session window gets.
const DISTILLED_BUDGET_RATIO = 0.35;

// Return only the most RECENT entries of a section that fit in `budget` bytes.
// Distilled Sessions are "### YYYY-MM-DD" delimited — keep newest, drop oldest.
function trimDistilled(content, budget) {
  if (content.length <= budget) return content;
  const parts = content.split(/\n(?=### \d{4}-\d{2}-\d{2})/);
  const kept = [];
  let size = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (size + parts[i].length > budget) break;
    kept.unshift(parts[i]);
    size += parts[i].length;
  }
  if (kept.length === 0) return content.slice(-budget);
  const dropped = parts.length - kept.length;
  return `_(${dropped} older session summaries archived — use read_memory("Distilled Sessions") to load them)_\n\n` + kept.join('\n');
}

// Memory sections are append-only logs (appendLongTermMemory adds at the end),
// so when one is over budget keep the NEWEST entries, cut at a line boundary.
function keepNewest(content, budget, section) {
  if (content.length <= budget) return content;
  const note = `_(older entries not shown — read_memory("${section}") loads the full section)_\n`;
  let tail = content.slice(-(budget - note.length));
  const nl = tail.indexOf('\n');
  if (nl > 0 && nl < tail.length - 1) tail = tail.slice(nl + 1);
  return note + tail;
}

// How many days of session notes go into the prompt: the most recent days
// that actually have notes, looking back at most SESSION_LOOKBACK_DAYS.
const SESSION_NOTE_DAYS = 2;
const SESSION_LOOKBACK_DAYS = 7;
const SHARED_ENTRIES = 10;
const SECTION_SEP = '\n\n---\n\n';

/** opts.sharedPool: owner id of the pool whose shared memory may appear in the prompt (null = the admin side pool). */
function getMemoryContext(agent, maxBytes = 32768, opts = {}) {
  const sharedPool = opts && opts.sharedPool !== undefined ? opts.sharedPool : null;
  const db = getDb();
  const sections = [];
  let totalLoaded = 0;

  // 1. Long-term memory (highest priority, but BUDGETED — this used to be unbounded
  //    and was pulling 150-200 KB per prompt on long-lived agents)
  const ltmRows = db.prepare(
    'SELECT section, content FROM long_term_memory WHERE agent = ? ORDER BY section'
  ).all(agent);

  if (ltmRows.length > 0) {
    const ltmBudget = Math.floor(maxBytes * 0.75); // leave room for session notes + shared
    const distilledBudget = Math.floor(ltmBudget * DISTILLED_BUDGET_RATIO);
    const highPriority = ltmRows.filter(r => !LOW_PRIORITY_SECTIONS.has(r.section));
    const lowPriority = ltmRows.filter(r => LOW_PRIORITY_SECTIONS.has(r.section));

    const parts = [];
    let ltmSize = 0;
    const coreBudget = ltmBudget - distilledBudget;

    // Smallest sections first, so short rule/feedback sections always load in
    // full; the big append-only log (usually "general") takes what is left.
    highPriority.sort((a, b) => a.content.length - b.content.length);
    for (const r of highPriority) {
      const heading = r.section === 'general' ? '' : `## ${r.section}\n`;
      const remaining = coreBudget - ltmSize - heading.length;
      if (remaining <= 100) break;
      const chunk = heading + keepNewest(r.content, remaining, r.section);
      parts.push(chunk);
      ltmSize += chunk.length;
    }
    // Rolling window over distilled sessions with whatever budget is left
    const leftover = ltmBudget - ltmSize;
    for (const r of lowPriority) {
      if (leftover <= 200) break;
      parts.push(`## ${r.section}\n${trimDistilled(r.content, leftover)}`);
      ltmSize += Math.min(r.content.length, leftover);
    }

    const section = `# Long-Term Memory\n${parts.join('\n\n')}`;
    sections.push(section);
    totalLoaded += section.length;
  }

  // 2. Recent session notes (the last SESSION_NOTE_DAYS days that have any)
  const tzLib = require('./timezone'); const zone = tzLib.zoneForAgent(agent);   // the same local days writeSessionNote files under
  // The latest days that have notes, in calendar days (a day can be 23 or 25 hours), counting up to two days ahead of
  // today: notes written in a zone further east before a flight west are filed under the day it already was there, and
  // no two zones' calendars are more than two days apart (UTC-12 to UTC+14).
  const today = tzLib.localDate(zone);
  const recent = getDb().prepare('SELECT DISTINCT date FROM session_notes WHERE agent = ? AND date >= ? AND date <= ? ORDER BY date DESC LIMIT ?')
    .all(agent, tzLib.addDays(today, -SESSION_LOOKBACK_DAYS), tzLib.addDays(today, 2), SESSION_NOTE_DAYS);
  for (const { date: d } of recent) {
    if (totalLoaded >= maxBytes) break;
    const notes = readSessionNotes(agent, d);
    if (notes && !notes.startsWith('(no session')) {
      const section = `# Session Memory (${d})\n${notes}`;
      const sep = sections.length ? SECTION_SEP.length : 0;
      const trimmed = section.slice(0, Math.max(0, maxBytes - totalLoaded - sep));
      if (!trimmed) break;
      sections.push(trimmed);
      totalLoaded += trimmed.length + sep;
    }
  }

  // 3. Relevant shared memory (latest entries, if budget allows)
  if (totalLoaded < maxBytes) {
    // Older writes could leave duplicate (topic, author) rows; show each once.
    const seen = new Set();
    ensureOwnerColumn(db);
    // Only this agent's pool: a member's agents never see the admin side's notes, and vice versa.
    const shared = db.prepare(
      'SELECT topic, content, author, updated_at FROM shared_memory WHERE owner IS ? ORDER BY updated_at DESC, id DESC LIMIT ?'
    ).all(sharedPool, SHARED_ENTRIES * 3).filter(r => {
      const key = `${r.topic}\u0000${r.author}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, SHARED_ENTRIES);

    if (shared.length > 0) {
      const sharedSection = '# Shared Memory Pool\n' + shared.map(r =>
        `## ${r.topic}\n*by ${r.author} — ${r.updated_at}*\n${r.content}`
      ).join('\n\n');

      const sep = sections.length ? SECTION_SEP.length : 0;
      const trimmed = sharedSection.slice(0, Math.max(0, maxBytes - totalLoaded - sep));
      if (trimmed.length > 50) {
        sections.push(trimmed);
        totalLoaded += trimmed.length + sep;
      }
    }
  }

  const out = sections.join(SECTION_SEP);
  return out.length > maxBytes ? out.slice(0, maxBytes) : out;
}

// ── Auto-Distillation ───────────────────────────────────────────────────

function getUndistilledDates(agent) {
  const db = getDb();
  const today = require('./timezone').localDate(require('./timezone').zoneForAgent(agent));   // the agent's local today

  // Find dates with session notes that haven't been distilled
  // (exclude today — we only distill completed days)
  const rows = db.prepare(`
    SELECT DISTINCT sn.date FROM session_notes sn
    WHERE sn.agent = ?
      AND sn.date < ?
      AND sn.date NOT IN (SELECT date FROM distillation_log WHERE agent = ?)
    ORDER BY sn.date
  `).all(agent, today, agent);

  return rows.map(r => r.date);
}

function getSessionNotesForDistillation(agent, date) {
  const db = getDb();
  const rows = db.prepare(
    'SELECT time, category, content FROM session_notes WHERE agent = ? AND date = ? ORDER BY id'
  ).all(agent, date);

  return rows.map(r => `[${r.time}] ${r.content}`).join('\n\n');
}

function saveDistillation(agent, date, summary) {
  const db = getDb();
  db.prepare(
    'INSERT OR REPLACE INTO distillation_log (agent, date, summary) VALUES (?, ?, ?)'
  ).run(agent, date, summary);

  // Append distilled knowledge to long-term memory
  appendLongTermMemory(agent, `\n### ${date}\n${summary}`, 'Distilled Sessions');
}

// ── Cleanup ─────────────────────────────────────────────────────────────

function cleanupOldSessions() {
  const db = getDb();
  // Each agent's notes are filed under its person's local days (lib/timezone): count the retention in those days.
  const tz = require('./timezone');
  let removed = 0;
  for (const { agent } of db.prepare('SELECT DISTINCT agent FROM session_notes').all()) {
    const cutoff = tz.addDays(tz.localDate(tz.zoneForAgent(agent)), -SESSION_RETENTION_DAYS);
    removed += db.prepare('DELETE FROM session_notes WHERE agent = ? AND date < ?').run(agent, cutoff).changes;
  }
  if (removed > 0) {
    console.log(`[memory] Cleaned up ${removed} session notes older than ${SESSION_RETENTION_DAYS} days`);
  }
}

// ── Migration: Import existing file-based memory ────────────────────────

function migrateFromFiles(agent, workspacePath) {
  const db = getDb();

  // Check if already migrated
  const existing = db.prepare(
    'SELECT COUNT(*) as count FROM long_term_memory WHERE agent = ?'
  ).get(agent);
  const existingNotes = db.prepare(
    'SELECT COUNT(*) as count FROM session_notes WHERE agent = ?'
  ).get(agent);

  if (existing.count > 0 || existingNotes.count > 0) return; // Already has data

  // 1. Import MEMORY.md → long_term_memory
  const memFile = path.join(workspacePath, 'MEMORY.md');
  if (fs.existsSync(memFile)) {
    const content = fs.readFileSync(memFile, 'utf8').trim();
    if (content) {
      writeLongTermMemory(agent, content, 'general');
      console.log(`[memory] Migrated MEMORY.md for ${agent}`);
    }
  }

  // 2. Import memory/*.md → session_notes
  const memDir = path.join(workspacePath, 'memory');
  if (fs.existsSync(memDir)) {
    const files = fs.readdirSync(memDir).filter(f => f.endsWith('.md')).sort();
    let totalNotes = 0;
    for (const file of files) {
      const date = file.replace('.md', '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

      const text = fs.readFileSync(path.join(memDir, file), 'utf8');
      // Parse the ## HH:MM sections
      const sections = text.split(/(?:^|\n)## /).filter(Boolean);
      for (const section of sections) {
        const lines = section.trim().split('\n');
        const header = lines[0].trim();
        const timeMatch = header.match(/^(\d{2}:\d{2})\s*(?:—\s*(.+))?$/);
        const time = timeMatch ? timeMatch[1] : '00:00';
        const category = timeMatch && timeMatch[2] ? timeMatch[2] : 'Chat';
        const content = lines.slice(1).join('\n').trim();
        if (content) {
          db.prepare(
            'INSERT INTO session_notes (agent, date, time, category, content) VALUES (?, ?, ?, ?, ?)'
          ).run(agent, date, time, category, content);
          totalNotes++;
        }
      }
    }
    if (totalNotes > 0) {
      console.log(`[memory] Migrated ${totalNotes} session notes for ${agent}`);
    }
  }
}

// ── Stats ───────────────────────────────────────────────────────────────

function getMemoryStats(agent) {
  const db = getDb();

  const ltmCount = db.prepare(
    'SELECT COUNT(*) as count FROM long_term_memory WHERE agent = ?'
  ).get(agent).count;

  const notesCount = db.prepare(
    'SELECT COUNT(*) as count FROM session_notes WHERE agent = ?'
  ).get(agent).count;

  const daysCount = db.prepare(
    'SELECT COUNT(DISTINCT date) as count FROM session_notes WHERE agent = ?'
  ).get(agent).count;

  const sharedCount = db.prepare(
    'SELECT COUNT(*) as count FROM shared_memory'
  ).get().count;

  const distilledCount = db.prepare(
    'SELECT COUNT(*) as count FROM distillation_log WHERE agent = ?'
  ).get(agent).count;

  return {
    longTermSections: ltmCount,
    sessionNotes: notesCount,
    sessionDays: daysCount,
    sharedMemories: sharedCount,
    distilledDays: distilledCount,
  };
}

// ── Exports ─────────────────────────────────────────────────────────────

module.exports = {
  getDb,
  // Long-term memory
  readLongTermMemory,
  writeLongTermMemory,
  appendLongTermMemory,
  // Session notes
  readSessionNotes,
  writeSessionNote,
  writeAutoSessionNote,
  // Shared memory
  readSharedMemory,
  writeSharedMemory,
  searchSharedMemory,
  // Context loading
  getMemoryContext,
  // Distillation
  getUndistilledDates,
  getSessionNotesForDistillation,
  saveDistillation,
  // Maintenance
  cleanupOldSessions,
  migrateFromFiles,
  getMemoryStats,
};
