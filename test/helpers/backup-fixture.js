'use strict';
// A throwaway install for the backup tests: the older layout (home folders beside the program folder) by default.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { encodeClaudeProject } = require('../../lib/backup/collect');

const SID = '11111111-2222-4333-8444-555555555555';
const TID = '01a0d0a5-93ff-7b00-ad3f-63e4291d147f';
const w = (f, s, mode) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s, mode ? { mode } : undefined); };
const AUTH_SCHEMA = `CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT, last_seen TEXT, expires_at TEXT, ua TEXT, ip TEXT, totp_ok INTEGER DEFAULT 0);
  CREATE TABLE trusted (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT, expires_at TEXT, ua TEXT);
  CREATE TABLE attempts (login TEXT, ts INTEGER, ok INTEGER);
  CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, user_id TEXT, action TEXT, detail TEXT, ip TEXT);
  CREATE TABLE tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT UNIQUE NOT NULL, scopes TEXT NOT NULL, agents TEXT, loopback_only INTEGER DEFAULT 1, created_at TEXT, created_by TEXT, expires_at TEXT, last_used TEXT, revoked_at TEXT);`;

function makeInstall(base, name, { layout = 'beside' } = {}) {
  const hubHome = layout === 'beside' ? path.join(base, name) : path.join(base, name, 'app', 'hub-home');
  const root = layout === 'beside' ? path.join(hubHome, 'app') : path.join(base, name, 'app');
  const home = path.join(base, `${name}-home`);
  const d = (...p) => path.join(root, 'data', ...p);
  w(d('settings.json'), JSON.stringify({ providers: { anthropic: { apiKey: 'sk-test-123' } }, backup: { folders: [] } }), 0o600);
  w(d('agents.json'), JSON.stringify([{ name: 'doc', policy: { roots: [path.join(hubHome, 'medical')] } }, { name: 'a' }, { name: 'open' }]));
  w(d('users.json'), JSON.stringify({ version: 1, users: [
    { id: 'u1', login: 'owner@example.com', role: 'admin', passwordHash: 'hash-at-backup', disabled: false },
    { id: 'u0', login: 'old@example.com', role: 'member', passwordHash: 'old-hash', disabled: false },
  ], invites: [] }), 0o600);
  w(d('agent-sessions.json'), JSON.stringify({ doc: { sessionId: SID } }));
  w(d('codex-sessions.json'), JSON.stringify({ open: { threadId: TID } }));
  w(d('conversations', 'doc.jsonl'), '{"role":"user","content":"hi"}\n');
  w(d('.auth-key'), 'a'.repeat(64), 0o600);
  w(d('setup-token'), 'one-time');
  w(d('local-models', 'config.yaml'), 'models: {}');
  w(d('uploads', 'img.png'), Buffer.alloc(5000, 7));
  const adb = new Database(d('auth.db'));
  adb.exec(AUTH_SCHEMA);
  adb.prepare("INSERT INTO sessions (id, user_id) VALUES ('s1', 'u1')").run();
  adb.prepare("INSERT INTO tokens (id, name, hash, scopes) VALUES ('t1', 'bot one', 'h1', 'chat'), ('t2', 'bot two', 'h2', 'chat')").run();
  adb.close();
  w(path.join(root, 'workspaces', 'doc', 'SOUL.md'), 'I am Doc');
  w(path.join(hubHome, 'medical', 'patients', 'patient-a.md'), 'notes');
  fs.mkdirSync(path.join(root, 'workspaces', 'doc', 'records'), { recursive: true });
  fs.symlinkSync(path.join(hubHome, 'medical', 'patients', 'patient-a.md'), path.join(root, 'workspaces', 'doc', 'records', 'patient-a.md'));
  w(path.join(hubHome, 'share', 'common', 'f.txt'), 'shared');
  w(path.join(root, '.env'), 'PORT=9966\nOTHER=from-backup\n', 0o600);
  w(path.join(root, 'package.json'), JSON.stringify({ version: '5.8.1' }));
  w(path.join(home, '.claude', '.credentials.json'), '{"claudeAiOauth":{}}', 0o600);
  w(path.join(home, '.claude', 'projects', encodeClaudeProject(root), `${SID}.jsonl`), '{"session":1}\n');
  w(path.join(home, '.codex', 'auth.json'), '{"tokens":{}}', 0o600);
  return { hubHome, root, home };
}
function memSettings() { const obj = {}; return { obj, get: () => obj, update: (p) => Object.assign(obj, p) }; }

module.exports = { makeInstall, memSettings, w, SID, TID, AUTH_SCHEMA };
