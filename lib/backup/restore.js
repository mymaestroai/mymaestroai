'use strict';
/**
 * backup/restore.js — restoring, step one: open and check. The whole backup is decrypted, unpacked and checked into a
 * staging folder (<install>/.restore/new) while nothing live changes. Then the staged copy is made ready for this
 * computer: links recreated last (only those that land inside the restored folders), safe permissions, this install's
 * port kept, folder paths rewritten for a different computer, the backup key settings chosen, accounts merged
 * (restoring over an existing install keeps today's sign-ins and revocations; accounts only in the backup come back
 * disabled; kept two-factor secrets are re-locked with the restored key file), and what would be lost counted.
 * The swap itself (journal, restart, recovery mode, undo) is step two (apply.js).
 *
 *   prepare(opts) → { id, backup: {...}, report: {...} }  and <install>/.restore/prepared.json
 * opts: { file, password | recoveryKey, root, hubHome, home, platform, mode: 'existing'|'fresh', working: [names],
 *         hubVersion }
 */
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const fmt = require('./format');
const { readTar } = require('./tar');
const { FOLDERS, rewritePaths } = require('../hub-home');
const { encodeClaudeProject, claudeDir } = require('./collect');

const MAX_MANIFEST = 64 * 1024 * 1024;
const ROOTS = ['data', 'workspaces', 'home', 'env', 'external'];
// this computer's own settings in .env: its port, where its hub home is, how it listens and which host names it answers
const ENV_KEEP = ['PORT', 'HUB_HOME', 'HUB_BIND_HOST', 'HUB_ALLOWED_HOSTS'];
const err = (msg, code = 'ERESTORE') => Object.assign(new Error(msg), { code });

const { restoreDirs } = require('./dirs');
const { mergeAccounts, relock, aesEncrypt, aesDecrypt } = require('./accounts');
function freeBytes(dir) { try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return Infinity; } }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeJson(file, v) { const tmp = `${file}.tmp-${process.pid}`; fs.writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file); }
const semver = (v) => (String(v || '').match(/^(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
function newerThan(a, b) {
  const x = semver(a), y = semver(b);
  if (x.length !== 3 || y.length !== 3) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// Where an archive path lands on this computer, or null when it has no place here (then it is left out).
function finalPath(arch, env) {
  const p = mapPath(arch, env);
  if (!p) return null;
  // never outside the place it belongs to, whatever the archive path says
  const { root, hubHome, home } = env;
  const bases = [path.join(root, 'data'), path.join(root, 'workspaces'), path.join(root, '.env'), ...FOLDERS.map(f => path.join(hubHome, f)), claudeDir(home), path.join(home, '.codex')];
  return bases.some(b => p === b || p.startsWith(b + path.sep)) && !arch.split('/').some(x => x === '' || x === '.' || x === '..') ? p : null;
}
function mapPath(arch, { root, hubHome, home, platform }) {
  const [top, ...rest] = arch.split('/');
  if (top === 'data' || top === 'workspaces') return path.join(root, top, ...rest);
  if (top === 'env') return rest.length === 1 && rest[0] === '.env' ? path.join(root, '.env') : (rest.length === 0 ? null : null);
  if (top === 'home') { const [folder, ...r] = rest; return FOLDERS.includes(folder) ? path.join(hubHome, folder, ...r) : null; }
  if (top === 'external') {
    const [tool, ...r] = rest;
    if (tool === 'claude') {
      if (r.length === 1 && r[0] === '.credentials.json') return platform === 'darwin' ? null : path.join(claudeDir(home), '.credentials.json');
      if (r.length === 2 && r[0] === 'projects' && /^[0-9a-f-]{36}\.jsonl$/.test(r[1])) return path.join(claudeDir(home), 'projects', encodeClaudeProject(root), r[1]);
      return null;
    }
    if (tool === 'codex') {
      if (r.length === 1 && (r[0] === 'auth.json' || r[0] === 'config.toml')) return path.join(home, '.codex', r[0]);
      if (r.length >= 2 && r[0] === 'sessions') return path.join(home, '.codex', ...r);
      return null;
    }
  }
  return null;
}
function detectCaseInsensitive(dir) {
  const probe = path.join(dir, `.CaseProbe-${process.pid}`);
  try { fs.writeFileSync(probe, ''); return fs.existsSync(path.join(dir, `.caseprobe-${process.pid}`)); }
  catch { return false; } finally { fs.rmSync(probe, { force: true }); }
}
function validateManifest(m) {
  if (!m || m.format !== 'my-maestro-backup' || !Array.isArray(m.entries)) throw err(fmt.ERR.notBackup);
  if (!(m.formatVersion >= 1)) throw err(fmt.ERR.notBackup);
  if (m.formatVersion > 1) throw err('This backup was made by a newer My Maestro AI. Update this one first, then restore.', 'ENEWER');
  // every path the list names (and every link target) is a clean relative path under one of the backup's roots
  const clean = (p) => typeof p === 'string' && p.length > 0 && !p.includes('\0') && !p.startsWith('/') && p.split('/').every(x => x !== '' && x !== '.' && x !== '..') && ROOTS.includes(p.split('/')[0]);
  for (const e of m.entries) {
    if (!e || !clean(e.path) || !['file', 'dir', 'link'].includes(e.type)) throw err(fmt.ERR.notBackup);
    if (e.type === 'link' && !clean(e.target)) throw err(fmt.ERR.notBackup);
    if (e.type === 'file' && (!Number.isInteger(e.size) || e.size < 0 || !/^[0-9a-f]{64}$/.test(e.sha256 || ''))) throw err(fmt.ERR.notBackup);
    if (e.type === 'link' && typeof e.target !== 'string') throw err(fmt.ERR.notBackup);
  }
}
const decryptsTo = (opts) => fmt.unlockWith(opts);

async function prepare(opts) {
  const { file, password, recoveryKey, root, hubHome, home = os.homedir(), platform = process.platform, mode = 'existing', working = [] } = opts;
  const hubVersion = opts.hubVersion || (readJson(path.join(root, 'package.json')) || {}).version;
  const env = { root, hubHome, home, platform };
  const dirs = restoreDirs(root);
  if (fs.existsSync(dirs.journal)) throw err('A restore is already waiting for a restart, or being undone. Finish that first.', 'EBUSY');
  await fsp.rm(dirs.staged, { recursive: true, force: true });
  await fsp.rm(dirs.prepared, { force: true });
  await fsp.mkdir(dirs.staged, { recursive: true, mode: 0o700 });
  const free = freeBytes(dirs.base);
  // drain: read past the archive's end to the authenticated end of the stream (the last encrypted chunk, the gzip check)
  const limits = { maxEntries: 2000000, maxPathBytes: 4096, maxFileBytes: 64 * 1024 ** 3, maxTotalBytes: Math.max(0, free - 512 * 1024 * 1024), drain: true, maxTail: 1024 * 1024 };
  const caseInsensitive = detectCaseInsensitive(dirs.staged);
  let manifest = null, byPath = null, headerInfo = null, privUsed = null, envelope = null, stanzas = [];
  const seen = new Set(), seenLower = new Set(), links = [];
  const fileHash = crypto.createHash('sha256');
  const hashTee = new Transform({ transform(c, _e, cb) { fileHash.update(c); cb(null, c); } });
  const baseUnlock = decryptsTo({ password, recoveryKey });
  const decrypt = fmt.createDecryptStream({ unlock: async function (h) { stanzas = h.stanzas; envelope = h.stanzas.find(s => s.type === 'mymaestro-pw') || null; privUsed = await baseUnlock.call(this, h); return privUsed; } });
  decrypt.on('header', (h) => { headerInfo = h.info; });
  try {
    await pipeline(fs.createReadStream(file), hashTee, decrypt, zlib.createGunzip(), async function (source) {
      for await (const e of readTar(source, limits)) {
        if (!manifest) {
          if (e.path !== 'manifest.json' || e.type !== 'file' || e.size > MAX_MANIFEST) throw err(fmt.ERR.notBackup);
          const parts = []; for await (const c of e.content()) parts.push(c);
          const raw = Buffer.concat(parts);
          // made by a hub that holds this backup key (not just by someone who knows its public key), before anything is unpacked
          if (!fmt.checkOrigin(stanzas, privUsed, crypto.createHash('sha256').update(raw).digest('hex'))) throw err('This backup wasn\'t made by a My Maestro with this backup key, so it was not used.', 'EORIGIN');
          try { manifest = JSON.parse(raw.toString('utf8')); } catch { throw err(fmt.ERR.notBackup); }
          validateManifest(manifest);
          byPath = new Map(manifest.entries.map(x => [x.path, x]));
          if (byPath.size !== manifest.entries.length) throw err('The backup\'s list names the same path twice, so it was not used.');
          if (manifest.entries.length > limits.maxEntries) throw err('The backup holds more entries than allowed.');
          if (newerThan(manifest.hub && manifest.hub.version, hubVersion)) throw err(`This backup was made by My Maestro AI ${manifest.hub.version}, which is newer than this install (${hubVersion}). Update first, then restore.`, 'ENEWER');
          continue;
        }
        const m = byPath.get(e.path);
        if (!m || m.type !== e.type) throw err(`The backup holds something its list doesn't name, so it was not used: ${e.path}`);
        if (seen.has(e.path)) throw err(`The backup holds the same path twice, so it was not used: ${e.path}`);
        seen.add(e.path);
        if (caseInsensitive) { const low = e.path.toLowerCase(); if (seenLower.has(low)) throw err(`Two paths in the backup differ only in capital letters, which this disk can't keep apart: ${e.path}`); seenLower.add(low); }
        if (!ROOTS.includes(e.path.split('/')[0])) throw err(`The backup holds a path that isn't allowed: ${e.path}`);
        const target = path.join(dirs.staged, ...e.path.split('/'));
        if (e.type === 'dir') { await fsp.mkdir(target, { recursive: true, mode: 0o700 }); continue; }
        if (e.type === 'link') { links.push(m); continue; }   // created last, after every file and permission
        if (e.size !== m.size) throw err(`A file in the backup doesn't match its list, so it was not used: ${e.path}`);
        await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        const fh = await fsp.open(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
        const h = crypto.createHash('sha256');
        try { for await (const c of e.content()) { h.update(c); await fh.write(c); } await fh.sync(); } finally { await fh.close(); }
        if (h.digest('hex') !== m.sha256) throw err(`A file in the backup doesn't match its checksum, so it was not used: ${e.path}`);
      }
    });
    if (!manifest) throw err(fmt.ERR.notBackup);
    for (const m of manifest.entries) if (!seen.has(m.path)) throw err(`The backup is missing something its list names, so it was not used: ${m.path}`);

    // The hub's own records must be readable, or the restored setup would start on broken files
    for (const f of ['users.json', 'settings.json', 'agents.json']) {
      const p = path.join(dirs.staged, 'data', f);
      if (fs.existsSync(p) && readJson(p) === null) throw err(`The backup's ${f} can't be read, so it was not used.`);
    }
    // Permissions set by the hub, not the archive: this account only (folders 700, files 600, the owner's run bit kept),
    // never special bits. Then times.
    for (const m of manifest.entries) {
      if (m.type === 'link') continue;
      const p = path.join(dirs.staged, ...m.path.split('/'));
      const want = m.type === 'dir' ? 0o700 : (0o600 | (m.mode & 0o100));
      await fsp.chmod(p, want);
      if (m.type === 'file' && m.mtime > 0) await fsp.utimes(p, new Date(m.mtime), new Date(m.mtime)).catch(() => {});
    }
    // Links last: only when the target is an entry of this backup and both ends land inside the restored folders.
    const linksDropped = [];
    for (const l of links) {
      const t = byPath.get(l.target);
      const at = finalPath(l.path, env), to = finalPath(l.target, env);
      // a link to a file or folder of this backup (not to another link), never from agents' or shared folders into the
      // hub's own records, settings or sign-ins
      const into = ['data', 'env', 'external'].includes(l.target.split('/')[0]) && ['workspaces', 'home'].includes(l.path.split('/')[0]);
      if (!t || t.type === 'link' || into || l.target === l.path || !at || !to) { linksDropped.push({ path: l.path, target: l.target }); continue; }
      const rel = path.relative(path.dirname(at), to) || '.';   // a link to its own folder
      const lands = path.resolve(path.dirname(at), rel);
      if (lands !== to) { linksDropped.push({ path: l.path, target: l.target }); continue; }
      const stagedLink = path.join(dirs.staged, ...l.path.split('/'));
      await fsp.mkdir(path.dirname(stagedLink), { recursive: true, mode: 0o700 });
      await fsp.symlink(rel, stagedLink);
    }

    // Which key made it, as this install sees it: its current key, one it replaced, or one it never had (another hub)
    const lkey = ((readJson(path.join(root, 'data', 'settings.json')) || {}).backup || {});
    const fileKeyId = privUsed ? fmt.keyIdFor(fmt.publicFromPrivate(privUsed)) : null;
    const keyStatus = !fileKeyId ? null : (lkey.key && lkey.key.keyId === fileKeyId) ? 'current' : ((lkey.retiring || []).some(r => r && r.keyId === fileKeyId) || (lkey.retired || []).some(r => r && r.keyId === fileKeyId)) ? 'replaced' : 'other';
    const report = { keyStatus, skipped: manifest.skipped || [], linksDropped, linksOutside: manifest.linksOutside || [], unsettled: manifest.unsettled || [], label: manifest.label, pathsRewritten: 0, accounts: { kept: [], disabled: [], added: [] }, tokens: { revoked: 0, added: 0 }, usedRecoveryKey: !!recoveryKey };
    const S = (...p) => path.join(dirs.staged, ...p);
    // This install's port (and home folder setting) stay; the rest of .env comes from the backup.
    const liveEnv = (() => { try { return fs.readFileSync(path.join(root, '.env'), 'utf8'); } catch { return ''; } })();
    if (fs.existsSync(S('env', '.env'))) {
      let staged = fs.readFileSync(S('env', '.env'), 'utf8');
      for (const k of ENV_KEEP) {
        const live = new RegExp(`^\\s*${k}\\s*=.*$`, 'm').exec(liveEnv);
        const re = new RegExp(`^\\s*${k}\\s*=.*$`, 'm');
        if (live) staged = re.test(staged) ? staged.replace(re, live[0]) : `${staged.replace(/\n?$/, '\n')}${live[0]}\n`;
        else staged = staged.replace(new RegExp(`^\\s*${k}\\s*=.*\\n?`, 'm'), '');
      }
      fs.writeFileSync(S('env', '.env'), staged, { mode: 0o600 });
    }
    // Folder paths in settings, agents and schedules, from the backup's computer to this one.
    const o = manifest.origin || {};
    const pairs = [];
    if (o.installDir && path.resolve(o.installDir) !== path.resolve(root)) pairs.push([path.resolve(o.installDir), path.resolve(root)]);
    if (o.hubHome) for (const f of FOLDERS) { const a = path.join(path.resolve(o.hubHome), f), b = path.join(path.resolve(hubHome), f); if (a !== b) pairs.push([a, b]); }
    pairs.sort((a, b) => b[0].length - a[0].length);
    if (pairs.length) for (const name of ['agents.json', 'settings.json', 'scheduled-tasks.json', 'connectors.json']) {
      const f = S('data', name), v = readJson(f);
      if (v == null) continue;
      const [next, changed] = rewritePaths(v, pairs);
      if (changed) { writeJson(f, next); report.pathsRewritten++; }
    }
    // The backup key settings: today's on an existing install; on a fresh one, the key that just opened this file.
    const sset = readJson(S('data', 'settings.json')) || {};
    const lset = readJson(path.join(root, 'data', 'settings.json')) || {};
    if (mode === 'existing') { if (lset.backup) sset.backup = lset.backup; else delete sset.backup; }
    else if (privUsed) {
      const pub = fmt.publicFromPrivate(privUsed);
      sset.backup = { ...(sset.backup || {}), key: envelope ? { publicKey: fmt.encodeRecipient(pub), keyId: fmt.keyIdFor(pub), envelope: { args: envelope.args, body: envelope.body.toString('base64') }, originKey: fmt.originKeyFrom(privUsed).toString('base64'), createdAt: (sset.backup && sset.backup.key && sset.backup.key.createdAt) || new Date().toISOString() } : undefined, needsPassword: !!recoveryKey || !envelope };
    }
    if (fs.existsSync(S('data', 'settings.json')) || sset.backup) writeJson(S('data', 'settings.json'), sset);
    // Accounts
    mergeAccounts({ live: path.join(root, 'data'), staged: S('data'), mode, report });

    const summary = mode === 'existing' ? lossSummary({ root, hubHome, staged: dirs.staged, created: manifest.created }) : null;
    const backup = { created: manifest.created, version: manifest.hub && manifest.hub.version, channel: manifest.hub && manifest.hub.channel, platform: manifest.platform, counts: manifest.counts, label: manifest.label, working: manifest.working || [], keyId: manifest.keyId, labelsInHeader: headerInfo };
    const id = crypto.randomBytes(12).toString('hex');
    writeJson(dirs.prepared, { id, file: path.resolve(file), fileSha256: fileHash.digest('hex'), mode, preparedAt: new Date().toISOString(), backup, report, summary, workingNow: working, env: { root, hubHome, home, platform } });
    return { id, mode, backup, report, summary, workingNow: working };
  } catch (e) {
    await fsp.rm(dirs.staged, { recursive: true, force: true });
    await fsp.rm(dirs.prepared, { force: true });
    throw e;
  }
}

function lineCount(file) { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } }
function lossSummary({ root, hubHome, staged, created }) {
  const since = Date.parse(created) || 0;
  const names = (f) => { const a = readJson(f); return new Set(Array.isArray(a) ? a.map(x => x && x.name).filter(Boolean) : []); };
  const liveAgents = names(path.join(root, 'data', 'agents.json')), stagedAgents = names(path.join(staged, 'data', 'agents.json'));
  let messages = 0; const chatAgents = new Set();
  const convDir = path.join(root, 'data', 'conversations');
  for (const f of (() => { try { return fs.readdirSync(convDir).filter(n => n.endsWith('.jsonl')); } catch { return []; } })()) {
    const d = lineCount(path.join(convDir, f)) - lineCount(path.join(staged, 'data', 'conversations', f));
    if (d > 0) { messages += d; chatAgents.add(f.replace(/\.jsonl$/, '')); }
  }
  let files = 0, scanned = 0;
  const walk = (dir) => {
    let list; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (++scanned > 300000) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { try { if (fs.statSync(p).mtimeMs > since) files++; } catch {} }
    }
  };
  walk(path.join(root, 'workspaces'));
  for (const f of FOLDERS) walk(path.join(hubHome, f));
  let jobs = 0;
  try { for (const j of fs.readdirSync(path.join(root, 'data', 'jobs'))) { try { if (fs.statSync(path.join(root, 'data', 'jobs', j)).mtimeMs > since) jobs++; } catch {} } } catch {}
  return {
    since: created,
    messages, chatAgents: [...chatAgents],
    agentsAdded: [...liveAgents].filter(n => !stagedAgents.has(n)),
    agentsBack: [...stagedAgents].filter(n => !liveAgents.has(n)),
    newerFiles: files, newerFilesCapped: scanned > 300000, jobs,
  };
}

module.exports = { prepare, finalPath, restoreDirs, newerThan, ROOTS, _test: { relock, aesEncrypt, aesDecrypt, mergeAccounts, lossSummary } };
