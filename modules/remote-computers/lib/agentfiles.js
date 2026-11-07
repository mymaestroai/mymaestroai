'use strict';
// The MeshCentral agent programs. MeshCentral 1.3.1 does not ship them: at start it downloads them from GitHub, which the locked-down service cannot do.
// So the hub downloads them once into the runtime (node_modules/meshcentral/agents), checks every file against the pinned manifest
// (agent-defaults.json: size and SHA-384), and MeshCentral then finds them in its own agents folder ("bundled") and fetches nothing.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_RELEASES = 32;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TAG_RE = /^[A-Za-z0-9._-]{1,64}$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
const SHA384_RE = /^[a-f0-9]{96}$/;
const USER_AGENT = 'MyMaestro-RemoteComputers';

const clean = (s, max = 200) => String(s == null ? '' : s).replace(/[^\x20-\x7e]+/g, ' ').slice(0, max);
const MANIFEST = 'agent-defaults.json';
const TEMP_RE = /^\.[0-9a-f]{16}\.tmp$/;
const nameOk = (n) => typeof n === 'string' && NAME_RE.test(n) && n !== '.' && n !== '..';
// The code of a failed fetch: undici puts it on the cause ("TypeError: fetch failed", cause.code ECONNRESET).
const codeOf = (e) => clean((e && ((e.cause && (e.cause.code || e.cause.name)) || e.code || e.name)) || 'error', 60);

// Reads and checks the manifest; returns a flat list of { filename, url, size, sha384 }.
function readManifest(file) {
  let st;
  try { st = fs.lstatSync(file); } catch { throw new Error('the MeshCentral agent manifest (agent-defaults.json) is missing'); }
  if (!st.isFile()) throw new Error('the MeshCentral agent manifest is not a regular file');
  if (st.size > MAX_MANIFEST_BYTES) throw new Error('the MeshCentral agent manifest is too big');
  let m;
  try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('the MeshCentral agent manifest could not be read'); }
  const bad = (why) => new Error(`the MeshCentral agent manifest is not in the expected form (${why})`);
  if (!m || typeof m !== 'object' || m.schemaVersion !== 1) throw bad('schemaVersion');
  if (!Array.isArray(m.releases) || m.releases.length < 1 || m.releases.length > MAX_RELEASES) throw bad('releases');
  const list = [], seen = new Set();
  for (const r of m.releases) {
    if (!r || typeof r !== 'object') throw bad('release');
    if (typeof r.repository !== 'string' || !REPO_RE.test(r.repository)) throw bad('repository');
    if (typeof r.tag !== 'string' || !TAG_RE.test(r.tag)) throw bad('tag');
    if (!Array.isArray(r.files) || r.files.length < 1) throw bad('files');
    for (const f of r.files) {
      if (!f || typeof f !== 'object') throw bad('file');
      if (!nameOk(f.filename) || f.filename === MANIFEST) throw bad('filename');
      if (!nameOk(f.asset)) throw bad('asset');
      if (!Number.isInteger(f.size) || f.size < 1 || f.size > MAX_FILE_BYTES) throw bad('size');
      if (typeof f.sha384 !== 'string' || !SHA384_RE.test(f.sha384)) throw bad('sha384');
      if (seen.has(f.filename)) throw bad('a file name twice');
      seen.add(f.filename);
      list.push({ filename: f.filename, size: f.size, sha384: f.sha384,
        url: `https://github.com/${r.repository}/releases/download/${encodeURIComponent(r.tag)}/${encodeURIComponent(f.asset)}` });
    }
  }
  return list;
}

// Is this file a regular file (not a link) of the right size with the right SHA-384?
async function isGood(file, entry) {
  let st;
  try { st = fs.lstatSync(file); } catch { return false; }
  if (!st.isFile() || st.size !== entry.size) return false;
  try {
    const h = crypto.createHash('sha384');
    for await (const chunk of fs.createReadStream(file)) h.update(chunk);
    return h.digest('hex') === entry.sha384;
  } catch { return false; }
}

async function download(entry, dir, fetchFn, timeoutMs) {
  const fail = (why) => new Error(`${entry.filename}: ${why}`);
  const tmp = path.join(dir, `.${crypto.randomBytes(8).toString('hex')}.tmp`);
  let fd = null;
  try {
    let res;
    try {
      res = await fetchFn(entry.url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': USER_AGENT } });
    } catch (e) {
      throw fail(`the download failed (${codeOf(e)})`);
    }
    if (!res || !res.ok || !res.body) throw fail(`the download was refused (HTTP ${clean(res && res.status, 10) || '?'})`);
    fd = fs.openSync(tmp, 'wx', 0o600);
    const hash = crypto.createHash('sha384');
    let got = 0;
    try {
      for await (const chunk of res.body) {
        const buf = Buffer.from(chunk);
        got += buf.length;
        if (got > entry.size) { try { if (res.body.cancel) await res.body.cancel(); } catch { /* closed */ } throw fail('the download was longer than expected'); }
        hash.update(buf);
        for (let off = 0; off < buf.length;) {
          const n = fs.writeSync(fd, buf, off, buf.length - off);
          if (!(n > 0)) throw fail('writing the file made no progress');
          off += n;
        }
      }
    } catch (e) {
      if (e && typeof e.message === 'string' && e.message.startsWith(`${entry.filename}: `)) throw e;
      throw fail(`the download was interrupted (${codeOf(e)})`);
    }
    fs.closeSync(fd); fd = null;
    if (got !== entry.size) throw fail('the download was shorter than expected');
    if (hash.digest('hex') !== entry.sha384) throw fail('the download does not match its SHA-384 checksum');
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, path.join(dir, entry.filename));
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } }
    try { fs.unlinkSync(tmp); } catch { /* none */ }
    if (e && typeof e.message === 'string' && e.message.startsWith(`${entry.filename}: `)) throw e;
    throw fail(`it could not be saved (${clean((e && (e.code || e.name)) || 'error', 60)})`);
  }
}

async function ensureAgentFiles({ runtimeDir, fetch = globalThis.fetch, log = () => {}, concurrency = 3, timeoutMs = 120000 } = {}) {
  if (!runtimeDir) throw new Error('ensureAgentFiles needs runtimeDir');
  const dir = path.join(runtimeDir, 'node_modules', 'meshcentral', 'agents');
  const list = readManifest(path.join(dir, MANIFEST));
  // Temp files of a download that was cut off (the hub stopped half way) are not kept, so they never reach the service's copy.
  for (const name of fs.readdirSync(dir)) {
    if (!TEMP_RE.test(name)) continue;
    try { if (fs.lstatSync(path.join(dir, name)).isFile()) fs.unlinkSync(path.join(dir, name)); } catch { /* gone */ }
  }
  const total = list.length;
  const todo = [];
  let present = 0;
  for (const e of list) {
    if (await isGood(path.join(dir, e.filename), e)) present += 1; else todo.push(e);
  }
  if (!todo.length) return { total, present, downloaded: 0, bytes: 0 };
  if (typeof fetch !== 'function') throw new Error('no way to download the MeshCentral agent files on this computer');
  const sum = todo.reduce((n, e) => n + e.size, 0);
  log(`Downloading ${todo.length} MeshCentral agent files (${Math.max(1, Math.round(sum / 1048576))} MB) from GitHub ...`);
  let next = 0, failure = null, downloaded = 0, bytes = 0;
  const worker = async () => {
    while (!failure && next < todo.length) {
      const e = todo[next++];
      try { await download(e, dir, fetch, timeoutMs); downloaded += 1; bytes += e.size; } catch (err) { failure = failure || err; }
    }
  };
  const n = Math.max(1, Math.min(Math.floor(Number(concurrency)) || 1, todo.length));
  await Promise.all(Array.from({ length: n }, worker));
  if (failure) throw failure;
  return { total, present, downloaded, bytes };
}

module.exports = { ensureAgentFiles, readManifest };
