'use strict';

/**
 * tool-learning.js — Tool Error Learning System
 *
 * Tracks tool execution errors and builds a knowledge base of corrections.
 * Injects learned guidance into agent system prompts so errors aren't repeated.
 * 
 * This is how agents "improve over time" — they learn from mistakes.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'tool-learning.db');

let db;

function getDb() {
  if (!db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS tool_errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_name TEXT NOT NULL,
        args_summary TEXT,
        error_message TEXT NOT NULL,
        agent TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(tool_name, error_message)
      );
      CREATE TABLE IF NOT EXISTS tool_guidance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_pattern TEXT NOT NULL,
        guidance TEXT NOT NULL,
        source TEXT DEFAULT 'auto',
        priority INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(tool_pattern, guidance)
      );
      CREATE INDEX IF NOT EXISTS idx_errors_tool ON tool_errors(tool_name);
      CREATE INDEX IF NOT EXISTS idx_guidance_pattern ON tool_guidance(tool_pattern);
    `);
    seedGuidance();
  }
  return db;
}

/**
 * Seed the guidance table with known patterns from log analysis
 */
function seedGuidance() {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) as c FROM tool_guidance').get().c;
  if (count > 0) return; // Already seeded

  const seeds = [
    // Google Workspace patterns
    {
      tool_pattern: 'google%document%',
      guidance: 'When editing Google Docs, always provide both startIndex and endIndex for delete/insert operations. The endIndex must be greater than startIndex. You cannot delete the final newline character of a document segment.',
      priority: 5,
    },
    {
      tool_pattern: 'google%file%',
      guidance: 'When getting Google Drive file content, always specify the mimeType parameter (e.g. "text/plain" for docs, "text/csv" for sheets).',
      priority: 5,
    },
    // Slack patterns
    {
      tool_pattern: 'slack%send%message',
      guidance: 'Slack uses mrkdwn (NOT standard markdown): *bold* (single asterisks), _italic_ (underscores), ~strikethrough~ (tildes), ```code block```. Double newlines (\\n\\n) may be stripped by the MCP — if formatting matters, use the direct Slack Web API.',
      priority: 5,
    },
    // General
    {
      tool_pattern: '%',
      guidance: 'If a tool call fails, do NOT immediately retry with the same arguments. Read the error message carefully, understand what went wrong, and fix the specific issue before retrying.',
      priority: 3,
    },
  ];

  const insert = db.prepare(
    'INSERT OR IGNORE INTO tool_guidance (tool_pattern, guidance, source, priority) VALUES (?, ?, ?, ?)'
  );
  for (const s of seeds) {
    insert.run(s.tool_pattern, s.guidance, 'seed', s.priority);
  }
  console.log(`[tool-learning] Seeded ${seeds.length} guidance entries`);
}

/**
 * Record a tool error for learning
 */
function recordToolError(toolName, args, errorMessage, agentName) {
  try {
    const db = getDb();
    // Summarize args (don't store full content — could be huge)
    const argsSummary = typeof args === 'string' ? args.slice(0, 500) : JSON.stringify(args).slice(0, 500);
    
    db.prepare(
      'INSERT OR REPLACE INTO tool_errors (tool_name, args_summary, error_message, agent, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))'
    ).run(toolName, argsSummary, errorMessage.slice(0, 1000), agentName || 'unknown');

    // Auto-generate guidance from common error patterns
    autoGenerateGuidance(toolName, errorMessage);
  } catch (e) {
    // Don't let learning errors break tool execution
    console.error('[tool-learning] Error recording:', e.message);
  }
}

/**
 * Auto-generate guidance from error patterns.
 * Generates ACTIONABLE guidance (not just "column X doesn't exist" — that's useless).
 */
function autoGenerateGuidance(toolName, errorMessage) {
  const db = getDb();
  const msg = errorMessage.toLowerCase();

  // Timeout — add retry guidance
  if (msg.includes('timeout') || msg.includes('timed out')) {
    db.prepare(
      'INSERT OR IGNORE INTO tool_guidance (tool_pattern, guidance, source, priority) VALUES (?, ?, ?, ?)'
    ).run(
      toolName,
      'Query timed out. DO NOT give up. Retry with: narrower time range, more WHERE filters, fewer columns, smaller LIMIT. Timeouts are almost always fixable by reducing scan scope.',
      'auto',
      9
    );
  }

  // Google: missing required parameters
  if (msg.includes('missing required parameters')) {
    const match = errorMessage.match(/Missing required parameters: (.+)/i);
    const params = match ? match[1] : 'unknown';
    db.prepare(
      'INSERT OR IGNORE INTO tool_guidance (tool_pattern, guidance, source, priority) VALUES (?, ?, ?, ?)'
    ).run(
      toolName,
      `Required parameters missing: ${params}. Always include all required parameters.`,
      'auto',
      7
    );
  }

  // Bash: command not found
  if (msg.includes('command not found')) {
    db.prepare(
      'INSERT OR IGNORE INTO tool_guidance (tool_pattern, guidance, source, priority) VALUES (?, ?, ?, ?)'
    ).run(
      'Bash',
      'Before using a CLI tool, verify it exists with "which <command>" or "command -v <command>".  Common missing tools: rg (use grep -r instead), cast/foundry (not installed), python3 (use python).',
      'auto',
      8
    );
  }

  // Bash: no such file or directory
  if (msg.includes('no such file or directory')) {
    db.prepare(
      'INSERT OR IGNORE INTO tool_guidance (tool_pattern, guidance, source, priority) VALUES (?, ?, ?, ?)'
    ).run(
      'Bash',
      'Always verify file/directory paths exist with "ls" before using them in commands.  Use absolute paths when possible.  Check for typos in path names.',
      'auto',
      8
    );
  }

  // Bash: permission denied
  if (msg.includes('permission denied')) {
    db.prepare(
      'INSERT OR IGNORE INTO tool_guidance (tool_pattern, guidance, source, priority) VALUES (?, ?, ?, ?)'
    ).run(
      'Bash',
      'Permission denied errors usually mean the file needs chmod +x (for scripts) or the directory has restricted access.  Check permissions with ls -la first.',
      'auto',
      7
    );
  }
}

/**
 * Get relevant guidance for tools being used in a conversation.
 * Returns a formatted string to inject into the system prompt.
 */
function getToolGuidance(toolNames) {
  try {
    const db = getDb();
    
    // Get guidance matching any of the tool names
    const allGuidance = new Map(); // dedup by guidance text
    
    for (const toolName of toolNames) {
      const rows = db.prepare(
        `SELECT guidance, priority FROM tool_guidance 
         WHERE ? LIKE tool_pattern 
         ORDER BY priority DESC`
      ).all(toolName);
      
      for (const row of rows) {
        if (!allGuidance.has(row.guidance) || allGuidance.get(row.guidance) < row.priority) {
          allGuidance.set(row.guidance, row.priority);
        }
      }
    }

    if (allGuidance.size === 0) return '';

    // Sort by priority, take top 15
    const sorted = [...allGuidance.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);

    const lines = sorted.map(([guidance]) => `• ${guidance}`).join('\n');
    return `\n\n## ⚠️ Tool Usage Rules (Learned from Past Errors)\n${lines}`;
  } catch (e) {
    console.error('[tool-learning] Error getting guidance:', e.message);
    return '';
  }
}

/**
 * Get all guidance entries (for API/debugging)
 */
function getAllGuidance() {
  const db = getDb();
  return db.prepare('SELECT * FROM tool_guidance ORDER BY priority DESC').all();
}

/**
 * Get recent errors (for API/debugging)
 */
function getRecentErrors(limit = 50) {
  const db = getDb();
  return db.prepare('SELECT * FROM tool_errors ORDER BY created_at DESC LIMIT ?').all(limit);
}

/**
 * Add manual guidance entry
 */
function addGuidance(toolPattern, guidance, priority = 5) {
  const db = getDb();
  db.prepare(
    'INSERT OR REPLACE INTO tool_guidance (tool_pattern, guidance, source, priority) VALUES (?, ?, ?, ?)'
  ).run(toolPattern, guidance, 'manual', priority);
}

// ============================================================
// Schema Cache — remember DESCRIBE results so agents don't
// guess column names on subsequent queries to the same table
// ============================================================
const schemaCache = new Map(); // key: "DATABASE.SCHEMA.TABLE" → columns[]

function cacheSchema(tableName, columns) {
  if (!tableName || !columns || !columns.length) return;
  const key = tableName.toUpperCase().replace(/["`]/g, '');
  schemaCache.set(key, {
    columns,
    cachedAt: Date.now(),
  });
}

function getCachedSchema(tableName) {
  if (!tableName) return null;
  const key = tableName.toUpperCase().replace(/["`]/g, '');
  const entry = schemaCache.get(key);
  if (!entry) return null;
  // Expire after 1 hour
  if (Date.now() - entry.cachedAt > 3600000) {
    schemaCache.delete(key);
    return null;
  }
  return entry.columns;
}

// ============================================================
// Inline Error Guidance — appended directly to tool error results
// so the LLM sees correction advice RIGHT NEXT to the failure
// ============================================================
function getInlineErrorGuidance(toolName, errorMessage) {
  const msg = errorMessage.toLowerCase();
  const hints = [];

  if (msg.includes('invalid identifier') || msg.includes('unknown column')) {
    // Try to extract the table name from the error and provide cached columns
    const colMatch = errorMessage.match(/invalid identifier '([^']+)'/i);
    const badCol = colMatch ? colMatch[1] : null;
    hints.push(`⚠️ CORRECTION REQUIRED: Column "${badCol || '?'}" does not exist.  You MUST run DESCRIBE on the table first, then use only the columns returned.  Do NOT guess.`);

    // If we have cached schema, provide it
    for (const [table, entry] of schemaCache.entries()) {
      if (Date.now() - entry.cachedAt < 3600000) {
        const colNames = entry.columns.map(c => typeof c === 'string' ? c : c.name || c.column_name || c.COLUMN_NAME).filter(Boolean);
        if (colNames.length > 0 && colNames.length < 60) {
          hints.push(`📋 Cached columns for ${table}: ${colNames.join(', ')}`);
        }
      }
    }
  }

  if (msg.includes('does not exist or not authorized') || msg.includes('object does not exist')) {
    hints.push('⚠️ Table/view not found.  Run SHOW TABLES or list_objects to find the correct name.  Check database and schema prefix.');
  }

  if (msg.includes('timeout') || msg.includes('timed out')) {
    hints.push('⚠️ Query timed out.  Reduce scope: narrower time range, fewer columns, tighter WHERE, smaller LIMIT.  Retry immediately.');
  }

  if (msg.includes('command not found')) {
    const cmdMatch = errorMessage.match(/(\S+): command not found/);
    hints.push(`⚠️ Command "${cmdMatch ? cmdMatch[1] : '?'}" not installed.  Check with "which <cmd>" or "brew list" first.`);
  }

  if (msg.includes('no such file or directory')) {
    hints.push('⚠️ File/directory not found.  Verify the path with "ls" before using it.');
  }

  if (msg.includes('permission denied')) {
    hints.push('⚠️ Permission denied.  Check file permissions with "ls -la".  May need chmod or sudo.');
  }

  if (msg.includes('syntax error') && (toolName === 'Bash' || toolName.includes('query'))) {
    hints.push('⚠️ Syntax error.  Double-check quoting, escaping, and command structure before retrying.');
  }

  if (hints.length === 0) return '';
  return '\n\n---\n' + hints.join('\n');
}

module.exports = {
  recordToolError,
  getToolGuidance,
  getAllGuidance,
  getRecentErrors,
  addGuidance,
  cacheSchema,
  getCachedSchema,
  getInlineErrorGuidance,
};
