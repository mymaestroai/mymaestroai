'use strict';
/**
 * backup/service.js — backups for the running hub: the one place the server's routes use.
 *
 *   status()                    the key, places, the backup in progress, the last backup, the last restore, recovery mode
 *   setup(password)             the backup key; returns the recovery key once
 *   setFolders(list)            extra places (an external disk, a NAS, a synced folder, iCloud Drive on a Mac)
 *   backupNow({ now })          one backup at a time; waits for working agents unless now
 *   list()                      every backup found in the places, newest first (labels until opened)
 *   acceptUpload(stream)        a backup file sent from the browser, for a restore
 *   prepareRestore(opts)        open and check (restore.js); prepareRestore → confirmRestore after the caller's step-up
 *   confirmRestore({ id })      the journal (apply.js), then a restart
 *   cancelRestore()             forget a prepared restore
 *   undo()                      put the previous setup back (at a restart)
 *   decide(id, 'run'|'skip')    a held item after a restore (recovery.js)
 *   changePassword(opts)        the same key with a new password; the headers of the backups in our places are rewritten
 *   startRotation(opts)         "the password may have leaked": a new key and recovery key (shown once), saved first
 *   finishRotation(opts)        re-encrypt (or delete) our backups that use a retiring key; each old file goes only after
 *                               its new copy is written and checked; the key is retired once none is left
 *   filePath(name)              a backup's file in one of the places (downloads)
 *   setSchedule(s)              the nightly backup settings (schedule.js validates them)
 *   applyRetention(opts)        after a nightly backup: delete the nightly backups the keep rules don't keep. Only
 *                               backups this computer made as nightly ones (its index), in the places it wrote them,
 *                               each still the same size as made; tonight's backup must be there and the newest;
 *                               backups made by hand and files it didn't put there are never touched
 * Dependencies come in as options so tests can run it against a throwaway install.
 */
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const keys = require('./keys');
const places = require('./places');
const fmt = require('./format');
const restore = require('./restore');
const apply = require('./apply');
const recovery = require('./recovery');
const { createBackup } = require('./create');
const schedule = require('./schedule');

const { pipeline } = require('stream/promises');
const { Transform, Writable } = require('stream');
const err = (msg, code = 'EBACKUP') => Object.assign(new Error(msg), { code });
async function sha256Of(file) { const h = crypto.createHash('sha256'); for await (const c of fs.createReadStream(file)) h.update(c); return h.digest('hex'); }
function freeBytes(dir) { try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return Infinity; } }

function createBackupService(opts) {
  const { root, hubHome, home = os.homedir(), platform = process.platform, settings = keys.hubSettings(),
    hubInfo = () => ({}), busyAgents = () => [], restart = () => {}, scheduled = null, consult = null, log = () => {}, hasAccounts = () => false, wrongMax = 5 } = opts;
  let running = null, lastError = null, unlocking = false, restoreStep = false, wrong = [];
  // Opening a backup password lock costs 256 MiB for about a second (scrypt): one at a time, so a burst of requests
  // can't exhaust this computer's memory; and after 5 wrong backup passwords in 15 minutes, a 15-minute pause.
  const WRONG_MAX = wrongMax, WRONG_WINDOW = 15 * 60 * 1000;
  async function oneUnlock(fn) {
    wrong = wrong.filter(t => Date.now() - t < WRONG_WINDOW);
    if (wrong.length >= WRONG_MAX) throw err('Too many wrong backup passwords. Try again in 15 minutes.', 'ELOCKED');
    if (unlocking) throw err('Another backup password check is running. Try again in a moment.', 'EBUSY');
    unlocking = true;
    try { return await fn(); }   // a success doesn't wipe the count: only time does
    catch (e) { if (e && e.code === 'EPASSWORD') wrong.push(Date.now()); throw e; }
    finally { unlocking = false; }
  }
  // Preparing, cancelling, confirming and undoing a restore: one at a time (a cancel can't race a confirm).
  async function oneRestoreStep(fn) {
    if (restoreStep) throw err('Another restore step is running. Try again in a moment.', 'EBUSY');
    restoreStep = true;
    try { return await fn(); } finally { restoreStep = false; }
  }
  const realOrSelf = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const inside = (p, base) => { const b = realOrSelf(base); return p === b || p.startsWith(b + path.sep); };
  const conf = () => ((settings.get() || {}).backup) || {};
  const allPlaces = () => {
    const out = [places.localPlace(hubHome)];
    for (const f of conf().folders || []) if (f && f.dir && f.enabled !== false) out.push(places.folderPlace(f.dir));
    return out;
  };
  const uploads = () => path.join(restore.restoreDirs(root).base, 'uploads');

  // A backup's bytes changed (new header or new key): keep this computer's record of it right.
  async function reindex(name, file, keyId) {
    const e = places.index(root).find(b => b.name === name);
    if (e) places.recordInIndex(root, { ...e, sha256: await sha256Of(file), size: fs.statSync(file).size, ...(keyId ? { keyId } : {}) });
  }
  // Extra folders that can't be read and written right now (an unplugged disk); this computer's folder may simply not exist yet.
  const unreachable = () => allPlaces().filter(p => { if (p.kind === 'local') return false; try { fs.accessSync(p.dir, fs.constants.R_OK | fs.constants.W_OK); return false; } catch { return true; } }).map(p => p.dir);
  // The old private key of a retiring key: its recovery key, or its password opening the lock in one of its backups.
  async function oldKeyFor(keyId, mine, { oldPassword, oldRecoveryKey }) {
    let priv = null;
    if (oldRecoveryKey) { try { priv = fmt.decodeIdentity(String(oldRecoveryKey).trim()); } catch { priv = null; } }
    else if (oldPassword && mine.length) {
      const h = await fmt.readHeader(mine[0].file);
      const env = h.stanzas.find(s => s.type === 'mymaestro-pw');
      if (env) priv = await fmt.openEnvelope(env, oldPassword);
    }
    if (!priv || fmt.keyIdFor(fmt.publicFromPrivate(priv)) !== keyId) throw err('That is not the old backup password, or its recovery key.', 'EPASSWORD');
    return priv;
  }
  // Re-encrypt one file to the current key; the old file is replaced only when the new copy opens with the new key and
  // holds exactly the same content.
  async function reencrypt(file, oldPriv, newPriv, key) {
    const h = await fmt.readHeader(file);
    // only files this hub made with the old key are signed again with the new one
    const o = h.stanzas.find(s => s.type === 'mymaestro-origin');
    if (!o || !fmt.checkOrigin(h.stanzas, oldPriv, o.args[0])) throw err('This file was not made by My Maestro with that key, so it was left alone.', 'EORIGIN');
    const envelope = { type: 'mymaestro-pw', args: key.envelope.args.slice(), body: Buffer.from(key.envelope.body, 'base64') };
    const tmp = `${file}.reencrypt-${process.pid}`;
    const plain = crypto.createHash('sha256'), check = crypto.createHash('sha256');
    try {
      await pipeline(fs.createReadStream(file), fmt.createDecryptStream({ unlock: async () => oldPriv }),
        new Transform({ transform(c, _e, cb) { plain.update(c); cb(null, c); } }),
        fmt.createEncryptStream({ recipient: fmt.decodeRecipient(key.publicKey), stanzas: [envelope, fmt.infoStanza({ ...(h.info || {}), keyId: key.keyId })], origin: { macKey: Buffer.from(key.originKey, 'base64'), manifestSha256: o.args[0] } }),
        fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
      const fh = await fsp.open(tmp, 'r'); try { await fh.sync(); } finally { await fh.close(); }
      await pipeline(fs.createReadStream(tmp), fmt.createDecryptStream({ unlock: async () => newPriv }), new Writable({ write(c, _e, cb) { check.update(c); cb(); } }));
      if (check.digest('hex') !== plain.digest('hex')) throw err('The re-encrypted copy did not match, so the old file was kept.');
      await fsp.rename(tmp, file);
      fmt.syncDir(path.dirname(file));
    } catch (e) { await fsp.rm(tmp, { force: true }); throw e; }
  }

  function resolveFile({ name, uploadId }) {
    if (uploadId) {
      if (!/^[0-9a-f]{24}$/.test(String(uploadId))) throw err('That upload is not known here.', 'ENOFILE');
      const f = path.join(uploads(), `${uploadId}.age`);
      if (!fs.existsSync(f)) throw err('That upload is not known here.', 'ENOFILE');
      return f;
    }
    if (!places.NAME.test(String(name || ''))) throw err('That is not a backup name.', 'ENOFILE');
    for (const p of allPlaces()) { const f = path.join(p.dir, name); try { if (fs.lstatSync(f).isFile()) return f; } catch { /* not here */ } }
    throw err('That backup is not in any of the backup places.', 'ENOFILE');
  }

  return {
    places: allPlaces,
    status() {
      const c = conf();
      const idx = places.index(root).slice().sort((a, b) => String(b.created).localeCompare(String(a.created)));
      return {
        key: (({ publicKey, ...k }) => k)(keys.status({ settings })), needsPassword: !!c.needsPassword, folders: c.folders || [], iCloud: places.iCloudDrive(home, platform), retiring: (c.retiring || []).filter(r => r && r.keyId),
        running, lastError, last: idx[0] || null, lastRestore: apply.lastRestore({ root }), recovery: recovery.state(root), schedule: schedule.normalize(c.schedule),
        places: allPlaces().map(p => ({ kind: p.kind, dir: p.dir })),
        // a checked backup waiting for the confirm step (the page can show the warning again from these facts)
        prepared: (() => { try { const p = JSON.parse(fs.readFileSync(restore.restoreDirs(root).prepared, 'utf8')); return fs.existsSync(restore.restoreDirs(root).staged) ? { id: p.id, mode: p.mode, backup: p.backup, report: p.report, summary: p.summary, workingNow: p.workingNow || [] } : null; } catch { return null; } })(),
      };
    },
    // A backup key for an install that has none. Replacing a key goes through "It may have leaked" (rotation), or, when
    // both the password and the recovery key are lost, replace: the old key is then listed as retiring.
    async setup(password, { logN, replace = false } = {}) {
      const before = keys.status({ settings });
      if (before.configured && !replace) throw err('Backups are already set up. Use "Change password", or "It may have leaked…" to make a new key.', 'EEXIST');
      const r = await oneUnlock(() => keys.setup(password, { settings, ...(logN ? { logN } : {}) }));
      if (before.configured) { const c = conf(); settings.update({ backup: { ...c, retiring: (c.retiring || []).filter(x => x && x.keyId !== before.keyId).concat([{ keyId: before.keyId, since: new Date().toISOString(), lost: true }]) } }); }
      if (conf().needsPassword) settings.update({ backup: { ...conf(), needsPassword: false } });
      return r;
    },
    setFolders(list, { create = false } = {}) {
      if (!Array.isArray(list)) throw err('Expected a list of folders.');
      const folders = [];
      const iCloud = places.iCloudDrive(home, platform);
      for (const f of list) {
        const dir = f && typeof f.dir === 'string' ? f.dir.trim() : '';
        if (!dir || !path.isAbsolute(dir)) throw err(`A backup folder must be a full path: ${dir || '(empty)'}`);
        // never inside My Maestro itself: agents and the Files panel can read those folders
        const real = realOrSelf(dir);
        if (inside(real, root) || inside(real, hubHome) || inside(real, path.join(home, '.claude')) || inside(real, path.join(home, '.codex'))) throw err(`A backup folder can't be inside My Maestro's own folders: ${dir}`);
        // Only the iCloud Drive folder is made here when missing (its parent, iCloud Drive itself, must exist)
        if (create && iCloud && path.resolve(dir) === iCloud && !fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw err(`That folder doesn't exist: ${dir}`);
        try { fs.accessSync(dir, fs.constants.W_OK); } catch { throw err(`My Maestro can't write in that folder: ${dir}`); }
        folders.push({ dir: path.resolve(dir), enabled: f.enabled !== false, label: typeof f.label === 'string' ? f.label.slice(0, 60) : undefined });
      }
      settings.update({ backup: { ...conf(), folders } });
      return folders;
    },
    async backupNow({ now = false, reason = 'manual' } = {}) {
      if (running) throw err('A backup is already running.', 'EBUSY');
      if (!keys.status({ settings }).configured) throw err('Backups aren\'t set up yet: choose a backup password first.', 'ENOKEY');
      if (conf().needsPassword) throw err('Choose a new backup password first: this setup was restored with the recovery key.', 'ENEEDSPW');
      const working = busyAgents();
      if (!now && working.length) return { waiting: true, working };
      running = { startedAt: new Date().toISOString(), step: 'starting', reason };
      try {
        const r = await createBackup({ root, hubHome, home, platform, settings, places: allPlaces(), reason, working, hub: hubInfo(), gate: (o) => require('../sandbox').holdLaunches(o), onProgress: (p) => { if (running) running.step = p.step; } });
        lastError = null;
        return { done: true, backup: { name: r.name, size: r.size, places: r.places, label: r.manifest.label, files: r.manifest.counts.files, skipped: (r.manifest.skipped || []).length } };
      } catch (e) { lastError = { at: new Date().toISOString(), message: e.message }; log(`[backup] failed: ${e.message}`); throw e; }
      finally { running = null; }
    },
    list() { return places.list(root, allPlaces()); },
    // A backup sent from the browser in pieces of at most 16 MiB (each a raw request body): the first creates the upload,
    // the next ones say where they go, the last (done) checks the file's header. Kept until restored or forgotten.
    async acceptUpload(stream, { limit = Math.max(0, freeBytes(root) - 1024 ** 3), expected = 0, uploadId = null, offset = 0, done = true } = {}) {
      const CHUNK_MAX = 16 * 1024 * 1024;
      if (expected > CHUNK_MAX) throw err('Send the file in pieces of at most 16 MiB.', 'ETOOBIG');
      if (expected > limit) throw err('The file is larger than this computer has room for.', 'ENOSPC');   // this piece against the room left now
      await fsp.mkdir(uploads(), { recursive: true, mode: 0o700 });
      const id = uploadId || crypto.randomBytes(12).toString('hex');
      const file = uploadId ? resolveFile({ uploadId }) : path.join(uploads(), `${id}.age`);
      const have = uploadId ? fs.statSync(file).size : 0;
      if (Number(offset) !== have) throw err('That piece of the upload is out of order. Start the upload again.', 'EORDER');
      let size = have;
      const out = fs.createWriteStream(file, { flags: uploadId ? 'a' : 'wx', mode: 0o600 });
      try {
        await new Promise((resolve, reject) => {
          stream.on('data', (c) => { size += c.length; if (size - have > limit || size - have > CHUNK_MAX) { stream.destroy(); const room = size - have > limit; reject(err(room ? 'The file is larger than this computer has room for.' : 'Send the file in pieces of at most 16 MiB.', room ? 'ENOSPC' : 'ETOOBIG')); return; } if (!out.write(c)) { stream.pause(); out.once('drain', () => stream.resume()); } });
          stream.on('end', resolve); stream.on('error', reject); out.on('error', reject);
        });
        await new Promise((r) => out.end(r));
        if (!done) return { uploadId: id, size };
        const h = await fmt.readHeader(file);
        return { uploadId: id, size, labels: h.info || null, keyId: h.keyId };
      } catch (e) { out.destroy(); await fsp.rm(file, { force: true }); throw e.code ? e : err(fmt.ERR.notBackup); }
    },
    async prepareRestore({ name, uploadId, password, recoveryKey, mode = 'existing' }) {
      const file = resolveFile({ name, uploadId });
      return oneRestoreStep(() => oneUnlock(() => restore.prepare({ file, password, recoveryKey, root, hubHome, home, platform, mode, working: busyAgents(), hubVersion: (hubInfo() || {}).version })));
    },
    async confirmRestore({ id }) {
      return oneRestoreStep(async () => {
        if (running) throw err('A backup is being made right now. Restore when it has finished.', 'EBUSY');
        const prep = (() => { try { return JSON.parse(fs.readFileSync(restore.restoreDirs(root).prepared, 'utf8')); } catch { return null; } })();
        if (prep && prep.mode === 'fresh' && hasAccounts()) throw err('That restore was checked for a new install, but an account exists now. Open and check the backup again.', 'ESTALE');
        const r = apply.confirm({ root, hubHome, home, platform, id });
        setTimeout(() => restart('restore a backup'), 300);
        return r;
      });
    },
    async cancelRestore() {
      return oneRestoreStep(async () => {
        const d = restore.restoreDirs(root);
        if (fs.existsSync(d.journal)) throw err('That restore is already confirmed: it finishes when My Maestro starts again.', 'EBUSY');
        await fsp.rm(d.staged, { recursive: true, force: true });
        await fsp.rm(d.prepared, { force: true });
        await fsp.rm(uploads(), { recursive: true, force: true });
        return true;
      });
    },
    async undo() {
      return oneRestoreStep(async () => {
        const r = apply.confirmUndo({ root });
        setTimeout(() => restart('undo a restore'), 300);
        return r;
      });
    },
    resume() { return recovery.resume(root); },
    decide(id, action) {
      if (!['run', 'skip'].includes(action)) throw err('Choose Run or Skip.');
      const s = recovery.state(root);
      const item = s && (s.held || []).find(h => h.id === id);
      if (!item) throw err('That item is no longer waiting.', 'ENOITEM');
      const run = action === 'run';
      if (item.kind === 'schedule') { const st = scheduled && scheduled(); if (!st || !st.decideHeld(item.taskId, run)) throw err('The scheduled task could not be changed.'); }
      else if (item.kind === 'delivery') { if (run) { const st = scheduled && scheduled(); if (!st) throw err('The scheduler is not available.'); st.requeue(item.item); } }
      else if (item.kind === 'task') {
        const Database = require('better-sqlite3');
        const db = new Database(path.join(root, 'data', 'task-queue.db'));
        try { db.prepare(`UPDATE tasks SET status = ?, error = ? WHERE id = ? AND status = 'held'`).run(run ? 'pending' : 'failed', run ? null : 'skipped after a restore', item.taskId); } finally { db.close(); }
      } else if (item.kind === 'consult') {
        if (run) { const q = consult && consult(); if (!q) throw err('The consultation queue is not available.'); const j = item.item || {}; const r = q.enqueue({ from: j.from, to: j.to, prompt: j.prompt, depth: j.depth || 1 }); if (!r || !r.ok) throw err(`The consultation could not be queued again: ${(r && r.reason) || 'unknown reason'}.`); }
      }
      return recovery.decided(root, id, action);
    },
    // After the check, a fresh install asks for an admin sign-in FROM THE BACKUP: not protection (whoever can open a
    // backup could alter it), but proof the person can sign in once it is restored.
    checkStagedAdmin({ login, password, code }) {
      const { verifyPassword, totpVerify } = require('../auth');
      const S = restore.restoreDirs(root).staged;
      let users; try { users = JSON.parse(fs.readFileSync(path.join(S, 'data', 'users.json'), 'utf8')).users || []; } catch { users = []; }
      const u = users.find(x => x && x.login === String(login || '').trim().toLowerCase());
      const no = err('That sign-in doesn\'t match an admin account in this backup.', 'ESIGNIN');
      if (!u || u.disabled || u.role !== 'admin' || !u.passwordHash || !verifyPassword(String(password || ''), u.passwordHash)) throw no;
      if (u.totp && u.totp.enabled) {
        let secret = null;
        try { const key = Buffer.from(fs.readFileSync(path.join(S, 'data', '.auth-key'), 'utf8').trim(), 'hex'); secret = restore._test.aesDecrypt(key, u.totp.secretEnc); } catch { throw no; }
        const c = totpVerify(secret, String(code || '').replace(/\s+/g, ''));
        if (c == null || c === false || c < 0) throw no;
      }
      return { login: u.login, name: u.name || null };
    },
    async changePassword({ password, recoveryKey, newPassword, logN }) {
      if (running) throw err('A backup is being made right now. Try again when it has finished.', 'EBUSY');
      running = { startedAt: new Date().toISOString(), step: 'changing the backup password', reason: 'password' };
      try {
        const { priv, envelope, keyId } = await oneUnlock(() => keys.changePassword({ password, recoveryKey }, newPassword, { settings, ...(logN ? { logN } : {}) }));
        const out = { rewritten: 0, failed: [], unreachable: unreachable() };
        for (const b of await places.list(root, allPlaces())) {
          for (const p of b.places) {
            if (p.keyId !== keyId) continue;
            try { running.step = `updating ${b.name}`; await fmt.rewriteHeader(p.file, p.file, priv, { envelope }); out.rewritten++; await reindex(b.name, p.file); }
            catch (e) { out.failed.push({ file: p.file, error: e.message }); }
          }
        }
        return out;
      } finally { running = null; }
    },
    async startRotation({ password, recoveryKey, newPassword, logN }) {
      if (running) throw err('A backup is being made right now. Try again when it has finished.', 'EBUSY');
      const r = await oneUnlock(() => keys.rotate({ password, recoveryKey }, newPassword, { settings, ...(logN ? { logN } : {}) }));
      const waiting = (await places.list(root, allPlaces())).reduce((n, b) => n + b.places.filter(p => p.keyId === r.oldKeyId).length, 0);
      return { keyId: r.keyId, recoveryKey: r.recoveryKey, waiting };
    },
    async finishRotation({ oldPassword, oldRecoveryKey, newPassword, action = 'reencrypt' }) {
      if (!['reencrypt', 'delete'].includes(action)) throw err('Choose re-encrypt or delete.');
      if (running) throw err('A backup is being made right now. Try again when it has finished.', 'EBUSY');
      const retiring = (conf().retiring || []).filter(r => r && r.keyId);
      const out = { reencrypted: 0, deleted: 0, failed: [], retired: [], unreachable: unreachable() };
      if (!retiring.length) return out;
      const { priv: newPriv, key } = await oneUnlock(() => keys.unlockCurrent({ password: newPassword }, { settings }));   // proves who asks, for both choices
      running = { startedAt: new Date().toISOString(), step: 'replacing the old backup key', reason: 'new-key' };
      try {
        const all = await places.list(root, allPlaces());
        for (const r of retiring) {
          const mine = all.flatMap(b => b.places.filter(p => p.keyId === r.keyId).map(p => ({ b, p })));
          const oldPriv = action === 'reencrypt' && mine.length ? await oneUnlock(() => oldKeyFor(r.keyId, mine.map(x => x.p), { oldPassword, oldRecoveryKey })) : null;
          let left = 0, n = 0;
          for (const { b, p } of mine) {
            running.step = `${action === 'delete' ? 'deleting' : 're-encrypting'} ${++n} of ${mine.length}`;
            try {
              if (action === 'delete') { await fsp.rm(p.file); out.deleted++; }
              else { await reencrypt(p.file, oldPriv, newPriv, key); out.reencrypted++; await reindex(b.name, p.file, key.keyId); }
            } catch (e) { left++; out.failed.push({ file: p.file, error: e.message }); }
          }
          // a place that can't be reached may still hold backups with that key: it stays retiring until it can be checked
          if (!left && !out.unreachable.length) { keys.retire(r.keyId, { settings }); out.retired.push(r.keyId); }
        }
        return out;
      } finally { running = null; }
    },
    // The recovery key again (the private key, unlocked by the backup password): for a lost printout or a closed page.
    async recoveryKey({ password }) {
      const { priv } = await oneUnlock(() => keys.unlockCurrent({ password }, { settings }));
      return { recoveryKey: fmt.encodeIdentity(priv) };
    },
    // the daily cleanup: never while a restore step (prepare, cancel, confirm, undo) is running
    async pruneDaily() {
      if (restoreStep) return false;
      return oneRestoreStep(async () => { apply.prune(root, Date.now, { log }); return true; });
    },
    filePath(name) { return resolveFile({ name }); },
    setSchedule(s) {
      const v = schedule.validate(s);
      // not while older backups are being removed with the counts read a moment ago (it takes a moment)
      if (running && running.reason === 'retention') throw err('Older nightly backups are being removed right now. Try again in a moment.', 'EBUSY');
      settings.update({ backup: { ...conf(), schedule: v } });
      return v;
    },
    async applyRetention({ keepNightly, keepWeekly, tz, justMade }) {
      const out = { deleted: [], kept: 0, failed: [], skipped: false, why: null };
      if (!justMade) return { ...out, skipped: true, why: 'no backup was named as tonight\'s' };
      const d = restore.restoreDirs(root);
      // never beside a restore in progress, a backup being made or a key being replaced
      if (running || restoreStep || fs.existsSync(d.journal) || fs.existsSync(d.prepared)) return { ...out, skipped: true };
      running = { startedAt: new Date().toISOString(), step: 'removing older nightly backups', reason: 'retention' };
      restoreStep = true;
      try {
        const made = new Map(places.index(root).filter(b => b && b.reason === 'nightly' && places.NAME.test(String(b.name))).map(b => [b.name, b]));
        // Tonight's backup must be there, whole, and the newest: otherwise (a wrong clock, a lost file) nothing is deleted.
        // A record dated more than a day ahead (an old clock glitch) keeps its slot but doesn't block this every night.
        {
          const cur = made.get(justMade), local = cur && path.join(places.localPlace(hubHome).dir, justMade);
          let ok = false; try { const st = fs.lstatSync(local); ok = st.isFile() && st.size === cur.size; } catch { ok = false; }
          const t = cur ? Date.parse(cur.created) : NaN, ahead = Date.now() + 86400000;
          const newer = cur && [...made.values()].some(b => b.name !== justMade && Date.parse(b.created) > t && Date.parse(b.created) <= ahead);
          if (!cur || !ok || newer || !Number.isFinite(t)) return { ...out, skipped: true, why: !cur || !ok ? 'tonight\'s backup is not where it was written' : 'tonight\'s backup is not the newest (is the computer\'s clock right?)' };
        }
        // Each copy is counted only where this computer wrote it (its record says so), still the size it was made with.
        const keyOf = (q) => (q.kind === 'local' ? 'local' : `folder:${path.resolve(String(q.dir || ''))}`);
        const written = (rec) => new Set((rec.places || []).filter(q => q && !q.error && (q.kind === 'local' || q.dir)).map(keyOf));
        const listed = new Map();   // place -> the names found there this pass (only places that could be read)
        const configured = new Set(allPlaces().map(keyOf));
        for (const p of allPlaces()) {
          const here = [], key = keyOf(p);
          let names; try { names = fs.readdirSync(p.dir).filter(n => made.has(n)); } catch { continue; }
          // a folder that holds none of the copies written there is taken as away (an unplugged disk leaves its empty
          // mount folder behind): the keep rules always leave a folder its newest copy
          if (p.kind !== 'local' && [...made.values()].some(rec => written(rec).has(key)) && !names.some(n => written(made.get(n)).has(key))) continue;
          listed.set(key, new Set(names));
          for (const n of names) {
            const rec = made.get(n), file = path.join(p.dir, n);
            if (!written(rec).has(key)) continue;             // a copy someone else put here: not ours to delete
            let st; try { st = fs.lstatSync(file); } catch { continue; }
            if (!st.isFile() || !Number.isFinite(rec.size) || st.size !== rec.size) continue;   // changed since: left alone
            here.push({ name: n, created: rec.created, file, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs });
          }
          const keep = schedule.toKeep(here, { keepNightly, keepWeekly, tz });
          if (justMade) keep.add(justMade);
          let removedHere = 0;
          for (const b of here) {
            if (keep.has(b.name)) { out.kept++; continue; }
            try {
              const now2 = fs.lstatSync(b.file);   // still the very file that was checked, unchanged
              if (!now2.isFile() || now2.dev !== b.dev || now2.ino !== b.ino || now2.size !== b.size || now2.mtimeMs !== b.mtimeMs || now2.ctimeMs !== b.ctimeMs) continue;
              await fsp.rm(b.file);
              out.deleted.push(b.file); removedHere++;
              listed.get(key).delete(b.name);
            } catch (e) { out.failed.push({ file: b.file, error: e.message }); }
          }
          if (removedHere) fmt.syncDir(p.dir);
        }
        // Forget a backup once no copy its record knows of is left: each place it was written to was read this pass and
        // has no such name (deleted now or on an earlier night), or is no longer a backup place. A folder that is away
        // can't be read, so it keeps the record (and its copy stays ours to tidy when it is back).
        const left = (rec) => { const known = written(rec); return !known.size || [...known].some(k => configured.has(k) && (!listed.has(k) || listed.get(k).has(rec.name))); };
        places.forget(root, [...made.values()].filter(rec => rec.name !== justMade && !left(rec)).map(rec => rec.name));
        return out;
      } finally { running = null; restoreStep = false; }
    },
    get running() { return running; },
  };
}

module.exports = { createBackupService };
