'use strict';
/**
 * backup/accounts.js — restoring over an existing install keeps today's accounts: passwords, two-factor (re-locked with the
 * restored key file), roles, sessions and trusted devices, and token rows (revocations, narrowed scopes); accounts only in
 * the backup come back disabled; tokens deleted since are revoked. Run when a restore is prepared (for the warning) and
 * again at the swap (lib/backup/apply.js), against today's final state. No requires that read settings: apply.js loads
 * this before .env is read.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const err = (msg, code = 'ERESTORE') => Object.assign(new Error(msg), { code });
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeJson(file, v) { const tmp = `${file}.tmp-${process.pid}`; fs.writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file); }

// ── accounts ─────────────────────────────────────────────────────────────────────────────────────────────────────
const BLOB = /^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]*$/;
function aesDecrypt(key, blob) {
  const [iv, tag, enc] = blob.split('.');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}
function aesEncrypt(key, text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return `${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}
// Re-lock every secret string inside v (encrypted with `from`) with `to`.
function relock(v, from, to) {
  if (typeof v === 'string' && BLOB.test(v) && from && to) {
    try { return aesEncrypt(to, aesDecrypt(from, v)); } catch { throw err('A two-factor secret could not be moved to the restored key, so nothing was changed.'); }
  }
  if (Array.isArray(v)) return v.map(x => relock(x, from, to));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, relock(x, from, to)]));
  return v;
}
const keyOf = (dir) => { try { return Buffer.from(fs.readFileSync(path.join(dir, '.auth-key'), 'utf8').trim(), 'hex'); } catch { return null; } };
const KEEP_FIELDS = ['login', 'name', 'role', 'passwordHash', 'totp', 'recovery', 'disabled', 'grants', 'totpLastCounter', 'timeZone', 'timeZonePinned'];

function mergeAccounts({ live, staged, mode, report }) {
  const Database = require('better-sqlite3');
  const sdbFile = path.join(staged, 'auth.db');
  const sdb = fs.existsSync(sdbFile) ? new Database(sdbFile) : null;
  try {
    if (sdb) for (const t of ['sessions', 'trusted', 'attempts']) { try { sdb.prepare(`DELETE FROM ${t}`).run(); } catch { /* an older database without that table */ } }
    if (mode !== 'existing') return;
    const lusers = readJson(path.join(live, 'users.json'));
    const susers = readJson(path.join(staged, 'users.json'));
    // both lists must be readable: otherwise today's passwords and two-factor would silently give way to the backup's
    if (!susers || !Array.isArray(susers.users)) throw err('The backup\'s list of accounts can\'t be read, so it was not used.');
    if ((!lusers || !Array.isArray(lusers.users)) && fs.existsSync(path.join(live, 'users.json'))) throw err('This install\'s list of accounts can\'t be read, so nothing was changed.');
    if (lusers && Array.isArray(lusers.users)) {
      const lkey = keyOf(live), skey = keyOf(staged);
      // a two-factor secret can only come along if both key files are there to re-lock it
      if ((!lkey || !skey) && lusers.users.some(u => u && u.totp)) throw err('A key file for two-factor sign-ins is missing, so nothing was changed.');
      const byId = new Map(lusers.users.map(u => [u.id, u]));
      for (const u of susers.users) {
        const l = byId.get(u.id);
        if (l) { for (const f of KEEP_FIELDS) { if (l[f] === undefined) delete u[f]; else u[f] = f === 'totp' ? relock(l[f], lkey, skey) : l[f]; } report.accounts.kept.push(u.login); byId.delete(u.id); }
        else { u.disabled = true; report.accounts.disabled.push(u.login); }
      }
      for (const l of byId.values()) { susers.users.push({ ...l, totp: relock(l.totp, lkey, skey) }); report.accounts.added.push(l.login); }
      writeJson(path.join(staged, 'users.json'), susers);
    }
    // API tokens: revoked or deleted here stays revoked; tokens made since the backup are kept.
    const ldbFile = path.join(live, 'auth.db');
    if (sdb && fs.existsSync(ldbFile)) {
      const ldb = new Database(ldbFile, { readonly: true, fileMustExist: true });
      try {
        // Today's sign-ins (sessions, trusted devices) stay, for accounts that stay on: whoever restores is still
        // signed in after the restart. The backup's own sessions were dropped above (old, maybe signed out since).
        const on = new Set(((readJson(path.join(staged, 'users.json')) || {}).users || []).filter(u => u && !u.disabled).map(u => u.id));
        for (const table of ['sessions', 'trusted']) {
          let rows = [], cols = [];
          try { rows = ldb.prepare(`SELECT * FROM ${table}`).all(); cols = sdb.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name); } catch { continue; }
          for (const row of rows) {
            if (!on.has(row.user_id)) continue;
            const use = cols.filter(c => c in row);
            try { sdb.prepare(`INSERT OR REPLACE INTO ${table} (${use.join(',')}) VALUES (${use.map(() => '?').join(',')})`).run(...use.map(c => row[c])); } catch { /* a shape this version lacks */ }
          }
        }
        const ltok = new Map(ldb.prepare('SELECT * FROM tokens').all().map(t => [t.id, t]));
        const now = new Date().toISOString();
        const scols = sdb.prepare('PRAGMA table_info(tokens)').all().map(c => c.name);
        for (const t of sdb.prepare('SELECT id, revoked_at FROM tokens').all()) {
          const l = ltok.get(t.id);
          if (l) {   // today's row wins: a scope narrowed, an expiry shortened or a revocation since the backup stays
            const use = scols.filter(c => c !== 'id' && c in l);
            if (use.length) sdb.prepare(`UPDATE tokens SET ${use.map(c => `${c} = ?`).join(', ')} WHERE id = ?`).run(...use.map(c => l[c]), t.id);
            if (l.revoked_at && !t.revoked_at) report.tokens.revoked++;
          } else if (!t.revoked_at) { sdb.prepare('UPDATE tokens SET revoked_at = ? WHERE id = ?').run(now, t.id); report.tokens.revoked++; }   // deleted since: revoked
          ltok.delete(t.id);
        }
        for (const l of ltok.values()) {
          const cols = Object.keys(l);
          try { sdb.prepare(`INSERT INTO tokens (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map(c => l[c])); report.tokens.added++; } catch { /* a column this version lacks */ }
        }
      } finally { ldb.close(); }
    }
  } finally {
    if (sdb) { try { sdb.prepare("INSERT INTO audit (ts, user_id, action, detail) VALUES (?, NULL, 'restore', ?)").run(new Date().toISOString(), `restored a backup (${mode})`); } catch {} sdb.close(); }
    for (const s of ['-wal', '-shm']) fs.rmSync(sdbFile + s, { force: true });
  }
}

// ── what would be lost ───────────────────────────────────────────────────────────────────────────────────────────

module.exports = { mergeAccounts, relock, aesEncrypt, aesDecrypt, keyOf, KEEP_FIELDS };
