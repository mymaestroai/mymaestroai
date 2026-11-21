'use strict';
// lib/faces/download.js: fetch a catalogue character pack (one tar.gz on a GitHub release) and install it.
//   startDownload(id, { home })  -> status      begins (or joins) the one transfer this hub runs at a time
//   downloadStatus(id, { home }) -> status      { id, state: idle|downloading|installing|done|failed|busy, received, total, error? }
// Safety: https only; the first address must be the catalogue's exact URL; redirects only to GitHub's own release
// storage hosts; the byte count and SHA-256 must match the catalogue; the archive is unpacked by the strict reader in
// tar.js into a private folder and then goes through packs.installPack, which validates everything again. Nothing is
// sent but a User-Agent and Accept header (no cookies, no tokens). Only our own .download-* file and .unpack-*
// folder are ever removed.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const packs = require('./packs');
const tar = require('./tar');
const { CATALOG, catalogEntry } = require('./catalog');

const URL_RE = /^https:\/\/github\.com\/mymaestroai\/mymaestroai\/releases\/download\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const REDIRECT_HOSTS = new Set(['objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com']);
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const IDLE_MS = 30 * 1000;
const TOTAL_MS = 15 * 60 * 1000;
const MSG = {
  redirect: 'The download was redirected to an unexpected address; nothing was installed.',
  mismatch: 'The download did not match the published file; nothing was installed.',
  busy: 'Another character is downloading; try again when it is done.',
};

class DlError extends Error {}
const fail = (msg) => { throw new DlError(msg); };

// The network layer. Tests (and a proof preload) may replace it; this is a function of this module only and is never
// reachable from the network. fn(url, options, onResponse) -> ClientRequest-like with .on('error'), .setTimeout, .destroy.
let transport = (url, options, onResponse) => https.get(url, options, onResponse);
function __setTransportForTests(fn) { transport = typeof fn === 'function' ? fn : ((url, options, onResponse) => https.get(url, options, onResponse)); }

let current = null;       // { id, status, promise } : the one running job
const failures = new Map();   // id -> failed status, until the next start for that id

function __resetForTests() { current = null; failures.clear(); transport = (url, options, onResponse) => https.get(url, options, onResponse); }
function __whenIdleForTests() { return current ? current.promise : Promise.resolve(); }

const copy = (s) => ({ ...s });

function facesDirOf(home) { return path.join(path.resolve(String(home)), 'faces'); }

/** <home>/faces must be a real folder (made when missing); never a link. */
function ensureFaces(home) {
  const dir = facesDirOf(home);
  let st = null;
  try { st = fs.lstatSync(dir); } catch { /* not there yet */ }
  if (st) { if (st.isSymbolicLink() || !st.isDirectory()) fail(`${dir} must be a normal folder, not a link or a file; nothing was installed.`); }
  else fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function removeOwn(p, facesDir, prefix, recursive) {
  if (!p || path.dirname(p) !== facesDir || !path.basename(p).startsWith(prefix)) return;
  try { fs.rmSync(p, { recursive, force: true }); } catch { /* hidden and ignored */ }
}

const STALE_MS = 20 * 60 * 1000;   // longer than the 15 minute total timeout: another process's live download is never touched

/** Remove leftovers of earlier runs: .download-* / .unpack-* entries in faces older than STALE_MS. lstat only; a link with such a name is unlinked, never followed. */
function sweepOld(facesDir) {
  let names = [];
  try { names = fs.readdirSync(facesDir); } catch { return; }
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith('.download-') && !name.startsWith('.unpack-')) continue;
    const p = path.join(facesDir, name);
    try {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) fs.unlinkSync(p);
      else if ((st.isFile() || st.isDirectory()) && now - st.mtimeMs > STALE_MS) fs.rmSync(p, { recursive: st.isDirectory(), force: true });
    } catch { /* hidden and ignored */ }
  }
}

function lookup(id, catalog) {
  const list = catalog || CATALOG;
  return (list === CATALOG ? catalogEntry(id) : list.find(e => e.id === id)) || null;
}

// ── One request, following the allowed redirects ─────────────────────────────────────────────────────────

function request(job, url) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = transport(url, { headers: { 'User-Agent': 'My-Maestro-AI-hub', Accept: 'application/octet-stream' } }, (res) => { job.res = res; if (job.opened) job.opened.push(res); resolve(res); });
    } catch (e) { reject(e); return; }
    job.req = req;
    if (job.opened) job.opened.push(req);
    req.on('error', (e) => reject(new DlError(`The download could not be started (${(e && e.code) || 'network error'}).`)));
  });
}

async function fetchFinal(job, entry) {
  let url = entry.url;
  if (url !== entry.url || !URL_RE.test(url)) fail('The catalogue address is not an allowed download address; nothing was installed.');
  for (let hops = 0; ; hops++) {
    const res = await Promise.race([request(job, url), job.killed]);
    const code = res.statusCode;
    if (REDIRECT_CODES.has(code)) {
      try { res.destroy(); } catch { /* gone */ }
      try { if (job.req) job.req.destroy(); } catch { /* gone */ }
      if (hops >= MAX_REDIRECTS) fail('The download was redirected too many times; nothing was installed.');
      let next;
      try { next = new URL(String(res.headers.location || ''), url); } catch { fail(MSG.redirect); }
      if (next.protocol !== 'https:' || !REDIRECT_HOSTS.has(next.hostname) || next.username || next.password || (next.port && next.port !== '443')) fail(MSG.redirect);
      url = next.href;
      continue;
    }
    if (code !== 200) { res.resume(); fail(`The download failed (the server answered ${code}); nothing was installed.`); }
    return res;
  }
}

function receive(job, res, entry, fd) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const cl = res.headers && res.headers['content-length'];
    if (cl !== undefined && Number(cl) !== entry.size) { res.resume(); return reject(new DlError(MSG.mismatch)); }
    let done = false;
    const end = (err) => { if (done) return; done = true; if (err) reject(err); else resolve(hash.digest('hex')); };
    res.on('data', (chunk) => {
      if (done) return;
      job.touch();
      job.status.received += chunk.length;
      if (job.status.received > entry.size) { try { res.destroy(); } catch { /* gone */ } return end(new DlError(MSG.mismatch)); }
      hash.update(chunk);
      let w = 0;
      try { while (w < chunk.length) w += fs.writeSync(fd, chunk, w, chunk.length - w); } catch (e) { try { res.destroy(); } catch { /* gone */ } end(new DlError(`The download could not be saved (${e.code || 'error'}); nothing was installed.`)); }
    });
    res.on('end', () => end());
    res.on('error', () => end(new DlError('The download was interrupted; nothing was installed.')));
    res.on('close', () => end(new DlError('The download was interrupted; nothing was installed.')));
    res.on('aborted', () => end(new DlError('The download was interrupted; nothing was installed.')));
  });
}

// ── The job ──────────────────────────────────────────────────────────────────────────────────────────────

async function run(job, entry, home, timeouts) {
  const st = job.status;
  let facesDir = null, part = null, unpack = null, fd = null;
  let idleTimer = null, totalTimer = null;
  const kill = (msg) => { try { if (job.res) job.res.destroy(); } catch { /* gone */ } try { if (job.req) job.req.destroy(); } catch { /* gone */ } job.reject(new DlError(msg)); };
  job.touch = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => kill('The download stopped receiving data; nothing was installed.'), timeouts.idleMs); };
  try {
    facesDir = ensureFaces(home);
    sweepOld(facesDir);
    const tag = `${entry.id}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    part = path.join(facesDir, `.download-${tag}.part`);
    fd = fs.openSync(part, 'wx', 0o600);
    job.touch();
    totalTimer = setTimeout(() => kill('The download took too long; nothing was installed.'), timeouts.totalMs);
    const res = await fetchFinal(job, entry);
    const digest = await Promise.race([receive(job, res, entry, fd), job.killed]);
    clearTimeout(idleTimer); clearTimeout(totalTimer);
    fs.closeSync(fd); fd = null;
    if (st.received !== entry.size || digest !== entry.sha256) fail(MSG.mismatch);
    st.state = 'installing';
    unpack = path.join(facesDir, `.unpack-${tag}`);
    fs.mkdirSync(unpack, { mode: 0o700 });
    try { await tar.extractTarGz(part, unpack); } catch (e) { fail(`The downloaded file could not be unpacked: ${e.message}`); }
    try { packs.installPack(unpack, { home, id: entry.id }); } catch (e) { fail(`The downloaded character pack could not be installed: ${e.message}`); }
    packs.clearCache();
    st.state = 'done';
  } catch (e) {
    st.state = 'failed';
    st.error = e instanceof DlError ? e.message : `The download failed (${(e && (e.code || e.message)) || 'error'}); nothing was installed.`;
    failures.set(entry.id, copy(st));
  } finally {
    clearTimeout(idleTimer); clearTimeout(totalTimer);
    job.touch = () => {};
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } }
    for (const o of (job.opened || [])) { try { o.destroy(); } catch { /* gone */ } }
    try { if (job.res) job.res.destroy(); } catch { /* gone */ }
    try { if (job.req) job.req.destroy(); } catch { /* gone */ }
    removeOwn(part, facesDir, '.download-', false);
    removeOwn(unpack, facesDir, '.unpack-', true);
    if (current === job) current = null;
  }
}

function startDownload(id, { home, catalog, timeouts } = {}) {
  const entry = lookup(id, catalog);
  if (!entry) { const e = new Error('That character is not in the catalogue.'); e.code = 'not_in_catalogue'; throw e; }
  if (!home) throw new Error('No hub home was given.');
  if (packs.getPack(id, { home })) return { id, state: 'done', received: entry.size, total: entry.size };
  if (current) {
    if (current.id === id) return copy(current.status);
    return { id, state: 'busy', received: 0, total: entry.size, error: MSG.busy };
  }
  failures.delete(id);
  const job = { id, status: { id, state: 'downloading', received: 0, total: entry.size }, req: null, res: null, opened: [], touch: () => {} };
  job.killed = new Promise((_, rej) => { job.reject = rej; });
  job.killed.catch(() => {});
  current = job;
  job.promise = run(job, entry, home, { idleMs: (timeouts && timeouts.idleMs) || IDLE_MS, totalMs: (timeouts && timeouts.totalMs) || TOTAL_MS });
  return copy(job.status);
}

function downloadStatus(id, { home, catalog } = {}) {
  const entry = lookup(id, catalog);
  if (!entry) { const e = new Error('That character is not in the catalogue.'); e.code = 'not_in_catalogue'; throw e; }
  if (current && current.id === id) return copy(current.status);
  if (home && packs.getPack(id, { home })) return { id, state: 'done', received: entry.size, total: entry.size };
  const f = failures.get(id);
  if (f) return copy(f);
  return { id, state: 'idle', received: 0, total: entry.size };
}

module.exports = { startDownload, downloadStatus, __setTransportForTests, __resetForTests, __whenIdleForTests };
