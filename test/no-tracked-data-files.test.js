'use strict';
// R7-0 guard: no account database, user list, settings journal or install data is ever tracked in git (outside templates/).
// Reads the tracked file list with `git ls-files` (read-only; the only git use in the tests). Skipped when git is missing or this is
// not a git checkout. Writes nothing.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

// The pure rule, so it can be checked on made-up lists too.
// The one tracked file under data/ is the shipped example agents list (lib/ falls back to it when data/agents.json is missing).
const SHIPPED_EXAMPLES = new Set(['data/agents.example.json']);
function forbidden(files) {
  return files.filter((f) => {
    const p = f.split(path.sep).join('/');
    if (p.startsWith('templates/') || SHIPPED_EXAMPLES.has(p)) return false;
    const base = p.split('/').pop();
    if (base === 'auth.db' || base.startsWith('auth.db-') || base === 'users.json' || base === 'settings-journal.jsonl') return true;
    return p.split('/').slice(0, -1).some((d) => d === 'data' || d === 'acct');   // any file under a data/ or acct/ folder
  });
}

test('the rule: account files and anything under data/ or acct/ are caught; templates/ and ordinary files are not', () => {
  assert.deepEqual(forbidden(['acct/auth.db', 'data/users.json', 'x/data/a.txt', 'a/acct/b.txt', 'auth.db-wal', 'sub/auth.db-shm', 'settings-journal.jsonl', 'data/agents.json']).length, 8);
  assert.deepEqual(forbidden(['data/agents.example.json', 'templates/data/users.json', 'templates/auth.db', 'lib/auth.js', 'test/data-guard.txt', 'docs/database.md', 'scripts/hub-token.js']), []);
});

test('no auth.db, users.json, settings-journal.jsonl or file under a data/ or acct/ folder is tracked outside templates/', (t) => {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) { t.skip(`git is not available here or this is not a git checkout (${r.error ? r.error.code || r.error.message : String(r.stderr).trim()})`); return; }
  const files = r.stdout.split('\0').filter(Boolean);
  assert.ok(files.length > 0, 'git lists some tracked files');
  assert.deepEqual(forbidden(files), [], 'tracked data files that must never ship');
});
