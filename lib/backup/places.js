'use strict';
/**
 * backup/places.js — where backups are kept, and the list of them.
 *   localPlace(hubHome)        { kind: 'local', dir: <hub home>/backups }
 *   folderPlace(dir)           { kind: 'folder', dir }; iCloudDrive() is the iCloud Drive folder on a Mac (or null)
 *   list(root, places)         every backup found in the places, newest first, merged with the index. Labels come from
 *                              each file's header and are only labels until the file is opened.
 *   recordInIndex / index      data/backups.json (this computer's record of the backups it made); forget(names)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const fmt = require('./format');

const NAME = /^my-maestro-ai-\d{4}-\d{2}-\d{2}-\d{4}(-\d+)?\.age$/;
const localPlace = (hubHome) => ({ kind: 'local', dir: path.join(hubHome, 'backups') });
const folderPlace = (dir) => ({ kind: 'folder', dir: path.resolve(dir) });
function iCloudDrive(home = os.homedir(), platform = process.platform) {
  if (platform !== 'darwin') return null;
  const d = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  return fs.existsSync(d) ? path.join(d, 'My Maestro AI Backups') : null;
}
const indexFile = (root) => path.join(root, 'data', 'backups.json');
function index(root) {
  try { const j = JSON.parse(fs.readFileSync(indexFile(root), 'utf8')); return Array.isArray(j.backups) ? j.backups : []; } catch { return []; }
}
// Durable (flushed, then renamed, then the folder flushed): the record of a backup must survive a power cut.
function writeIndex(root, all) {
  const file = indexFile(root), tmp = `${file}.tmp-${process.pid}`;
  const buf = Buffer.from(JSON.stringify({ v: 1, backups: all }, null, 1));
  try {
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      // one write may take only part of it: go on until every byte is out
      for (let at = 0; at < buf.length;) { const n = fs.writeSync(fd, buf, at, buf.length - at); if (!(n > 0)) throw new Error('The list of backups could not be written.'); at += n; }
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
  fmt.syncDir(path.dirname(file));   // a real failure (not "this system can't") is an error: nothing is deleted after it
}
function recordInIndex(root, rec) {
  const all = index(root).filter(b => b.id !== rec.id);
  all.push(rec);
  writeIndex(root, all);
}
// backups deleted from every place (the keep rules): no longer this computer's to list
function forget(root, names) {
  const gone = new Set(names);
  const all = index(root);
  if (all.some(b => gone.has(b.name))) writeIndex(root, all.filter(b => !gone.has(b.name)));
}
async function list(root, placesList) {
  const known = new Map(index(root).map(b => [b.name, b]));
  const found = new Map();
  for (const p of placesList) {
    let names = [];
    try { names = fs.readdirSync(p.dir).filter(n => NAME.test(n)); } catch { continue; }
    for (const n of names) {
      const file = path.join(p.dir, n);
      let st, header = null;
      // regular files only: a folder, a link or a pipe named like a backup is not one (a pipe would block the read)
      try { st = fs.lstatSync(file); } catch { continue; }
      if (!st.isFile()) continue;
      try { header = await fmt.readHeader(file); } catch { /* listed as unreadable */ }
      const prev = found.get(n);
      // each copy has its own key id: after a password change or a new key, a place that was away still has the old one
      const where = { kind: p.kind, dir: p.dir, file, size: st ? st.size : null, readable: !!header, keyId: header ? header.keyId : null };
      if (prev) { prev.places.push(where); continue; }
      const info = (header && header.info) || {};
      found.set(n, {
        name: n, id: n.replace(/\.age$/, ''), created: info.created || (known.get(n) || {}).created || (st ? st.mtime.toISOString() : null),
        version: info.version || null, channel: info.channel || null, agents: info.agents ?? null, bytes: info.bytes ?? null,
        label: info.label || null, reason: info.reason || null, keyId: header ? header.keyId : null, size: st ? st.size : null,
        made: known.has(n), places: [where],
      });
    }
  }
  return [...found.values()].sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

module.exports = { NAME, localPlace, folderPlace, iCloudDrive, index, recordInIndex, forget, list };
