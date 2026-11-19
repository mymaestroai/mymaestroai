'use strict';
// Standalone: node db-check.js <file>. Prints one JSON line { ok, result } and exits 0.
// Run as a child process so a slow or damaged database never blocks the main process.

function main() {
  const file = process.argv[2];
  let db = null;
  let out;
  try {
    if (!file) throw new Error('no file given');
    const Database = require('better-sqlite3');
    db = new Database(file, { readonly: true, fileMustExist: true });
    const rows = db.pragma('quick_check');
    const lines = rows.map((r) => String(r.quick_check !== undefined ? r.quick_check : Object.values(r)[0]));
    const ok = lines.length === 1 && lines[0] === 'ok';
    out = { ok, result: ok ? 'ok' : lines.slice(0, 5).join('; ') };
  } catch (e) {
    out = { ok: null, result: String((e && e.message) || e) };
  }
  try { if (db) db.close(); } catch { /* ignore */ }
  process.stdout.write(JSON.stringify(out) + '\n');
}

main();
