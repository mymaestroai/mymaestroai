'use strict';
// A small Google Drive v3 client for the backup copies. Fetch, clock and sleep are injectable so tests need no network.
// Each hub install has its own folder, found by appProperties { mymaestro: 'backups', install }, and it only ever
// touches files in that folder. Messages thrown here never contain tokens.

const crypto = require('crypto');
const fs = require('fs');
const oauth = require('../../lib/oauth-device');

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FOLDER_NAME = 'My Maestro AI Backups';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SMALL_MS = 60 * 1000;
const BIG_MS = 10 * 60 * 1000;    // one upload chunk
const IDLE_MS = 2 * 60 * 1000;    // a download may take as long as it likes while bytes keep arriving
const MAX_HOPS = 5;
const INSTALL_RE = /^[0-9a-f]{16}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const CHUNK = 8 * 1024 * 1024;
const MAX_RETRIES = 5;
const REVOKED = 'The Google sign-in was revoked or has expired. Sign in again.';

function fail(message, transient = false) {
  const e = new Error(message);
  if (transient) e.transient = true;
  return e;
}

// Plain text from a Google error body: no tokens, no control characters, short.
function clean(s) {
  return String(s || '')
    .replace(/Bearer\s+\S+/gi, '[hidden]')
    .replace(/ya29\.[\w.-]+/g, '[hidden]')
    .replace(/1\/\/[\w.-]+/g, '[hidden]')
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .trim()
    .slice(0, 200);
}

function httpError(status, text) {
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  const err = body && body.error;
  const reason = err && Array.isArray(err.errors) && err.errors[0] ? String(err.errors[0].reason || '') : '';
  const msg = clean(err && typeof err === 'object' ? err.message : '');
  if (reason === 'storageQuotaExceeded') return fail('Your Google Drive is full. Free some space and try again.');
  if (status === 401) return fail('Google refused the sign-in. Sign in again.');
  if (status === 404) return fail('Google Drive could not find that file or folder.');
  const transient = status === 408 || status === 429 || status >= 500 || /rateLimitExceeded|userRateLimitExceeded/i.test(reason);
  return fail(`Google Drive answered ${status}${msg ? `: ${msg}` : '.'}`, transient);
}

const checkInstall = (install) => {
  if (typeof install !== 'string' || !INSTALL_RE.test(install)) throw fail('The install id must be 16 hex characters.');
  return install;
};
const checkId = (id) => {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw fail('The file id is not valid.');
  return id;
};
const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function createDrive({ clientId, clientSecret, refreshToken, fetch = globalThis.fetch, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), chunkSize = CHUNK, tokenUrl = TOKEN_URL, idleMs = IDLE_MS } = {}) {
  let cached = null;      // { token, expiresAt }
  let pending = null;
  let refreshTok = refreshToken;

  async function accessToken() {
    if (cached && now() < cached.expiresAt - 60 * 1000) return cached.token;
    if (!clientId || !clientSecret) throw fail('The Google client ID and secret are not set.');
    if (!refreshTok) throw fail('Not signed in to Google yet. Sign in first.');
    if (!pending) {
      pending = oauth.refresh({ tokenUrl, clientId, clientSecret, refreshToken: refreshTok, fetch, now })
        .then((r) => {
          if (r.refreshToken) refreshTok = r.refreshToken;
          cached = { token: r.accessToken, expiresAt: r.expiresAt };
          return cached.token;
        })
        .catch((e) => { throw e && e.code === 'EREVOKED' ? fail(REVOKED) : e; })
        .finally(() => { pending = null; });
    }
    return pending;
  }

  // fn(signal, touch): touch() restarts the clock (a download calls it for every chunk, so only silence times out).
  async function withTimeout(ms, fn) {
    const ac = new AbortController();
    let timer;
    let expire;
    const expired = new Promise((_, rej) => { expire = rej; });
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => { ac.abort(); expire(fail('Google Drive took too long to answer.', true)); }, ms); };
    arm();
    try { return await Promise.race([fn(ac.signal, arm), expired]); }
    catch (e) { if (ac.signal.aborted) throw fail('Google Drive took too long to answer.', true); throw e; }
    finally { clearTimeout(timer); }
  }

  const sameOrigin = (a, b) => new URL(a).origin === new URL(b).origin;

  // One authorised request. consume(res, touch) reads a successful body (default: text). Returns { status, headers, text, value }.
  // API and upload calls refuse every redirect. follow: true (downloads) follows them by hand, https only, and sends the
  // token to the first address only.
  async function send(url, { method = 'GET', headers = {}, body, consume, follow = false } = {}, ms = SMALL_MS) {
    for (let attempt = 0; ; attempt++) {
      const token = await accessToken();
      const out = await withTimeout(ms, async (signal, touch) => {
        let res;
        let target = url;
        try {
          for (let hop = 0; ; hop++) {
            const h = sameOrigin(target, url) ? { ...headers, Authorization: `Bearer ${token}` } : { ...headers };
            res = await fetch(target, { method, headers: h, body, signal, redirect: follow ? 'manual' : 'error' });
            if (!follow || res.status < 300 || res.status >= 400 || res.status === 304) break;
            const loc = res.headers && res.headers.get && res.headers.get('location');
            if (!loc || hop >= MAX_HOPS) throw fail('Google Drive sent an unexpected redirect.');
            let next;
            try { next = new URL(loc, target); } catch { throw fail('Google Drive sent an unexpected redirect.'); }
            if (next.protocol !== 'https:') throw fail('Google Drive sent a redirect that is not secure, so it was not followed.');
            target = next.href;
          }
        } catch (e) {
          if (signal.aborted || e.message === 'Google Drive sent an unexpected redirect.' || /not secure/.test(e.message)) throw e;
          const why = `${(e && e.message) || ''} ${(e && e.cause && e.cause.message) || ''}`;
          if (/redirect/i.test(why)) throw fail('Google Drive sent an unexpected redirect.');
          throw fail("Couldn't reach Google Drive.", true);
        }
        if (consume && res.status >= 200 && res.status < 300) return { res, value: await consume(res, touch) };
        return { res, text: await res.text() };
      });
      if (out.res.status === 401 && attempt === 0) { cached = null; continue; }
      return { status: out.res.status, headers: out.res.headers, text: out.text, value: out.value };
    }
  }

  async function json(url, opts, ms) {
    const r = await send(url, opts, ms);
    if (r.status < 200 || r.status >= 300) throw httpError(r.status, r.text);
    if (!r.text) return {};
    try { return JSON.parse(r.text); } catch { throw fail('Google Drive sent a reply that could not be read.'); }
  }

  async function listAll(query, fields) {
    const files = [];
    let pageToken;
    do {
      const p = new URLSearchParams({ q: query, spaces: 'drive', pageSize: '1000', fields: `nextPageToken,files(${fields})`, orderBy: 'createdTime' });
      if (pageToken) p.set('pageToken', pageToken);
      const r = await json(`${API}/files?${p}`);
      files.push(...(r.files || []));
      pageToken = r.nextPageToken;
    } while (pageToken);
    return files;
  }

  // This install's folder. create=false returns null when it does not exist yet.
  async function folder(install, create = true) {
    checkInstall(install);
    const found = await listAll(`mimeType='${FOLDER_MIME}' and appProperties has { key='mymaestro' and value='backups' } and appProperties has { key='install' and value='${install}' } and trashed=false`, 'id,name');
    if (found.length) return found[0].id;
    if (!create) return null;
    const made = await json(`${API}/files?fields=id`, {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME, appProperties: { mymaestro: 'backups', install } }),
    });
    if (!made.id) throw fail('Google Drive did not create the folder.');
    return made.id;
  }

  const inFolder = (id) => `'${id}' in parents and trashed=false`;

  async function del(id) {
    const r = await send(`${API}/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (r.status !== 404 && (r.status < 200 || r.status >= 300)) throw httpError(r.status, r.text);
  }

  async function list(install) {
    const id = await folder(install, false);
    if (!id) return [];
    const files = await listAll(inFolder(id), 'id,name,size,createdTime');
    return files.map((f) => ({ id: f.id, name: f.name, size: Number(f.size || 0), createdTime: f.createdTime }));
  }

  // The file `id`, only when it is in this install's folder under this name; null when Google no longer has it.
  async function owned(parent, name, id, fields) {
    const r = await send(`${API}/files/${encodeURIComponent(checkId(id))}?${new URLSearchParams({ fields: `id,name,parents,trashed,${fields}` })}`);
    if (r.status === 404) return null;
    if (r.status < 200 || r.status >= 300) throw httpError(r.status, r.text);
    let f; try { f = JSON.parse(r.text); } catch { throw fail('Google Drive sent a reply that could not be read.'); }
    if (f.trashed) return null;
    if (!Array.isArray(f.parents) || !f.parents.includes(parent) || f.name !== name) throw fail(`That file is not the backup "${name}" in this install's folder, so it was left alone.`);
    return f;
  }

  // Resumable upload of a local file; returns { name, size, md5, id } once Drive's own size and checksum match.
  async function put(file, name, install) {
    if (typeof name !== 'string' || !name.trim()) throw fail('A name is needed for the backup copy.');
    const st = await fs.promises.stat(file);
    if (!st.isFile()) throw fail('The backup is not a file.');
    const size = st.size;
    const parent = await folder(install, true);

    const init = await send(UPLOAD, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(size) },
      body: JSON.stringify({ name, parents: [parent], appProperties: { mymaestro: 'backup', install } }),
    });
    if (init.status < 200 || init.status >= 300) throw httpError(init.status, init.text);
    const session = init.headers && init.headers.get && init.headers.get('location');
    if (!session) throw fail('Google Drive did not start the upload.');
    let sessionUrl = null;
    try { sessionUrl = new URL(session); } catch { /* below */ }
    if (!sessionUrl || sessionUrl.protocol !== 'https:' || sessionUrl.hostname !== 'www.googleapis.com' || sessionUrl.port) throw fail('Google Drive named an upload address that is not Google\'s, so nothing was sent.');

    const hash = crypto.createHash('md5');
    let hashed = 0;
    const fh = await fs.promises.open(file, 'r');
    let fileId;
    try {
      const readAt = async (pos, len) => {
        const buf = Buffer.alloc(len);
        let got = 0;
        while (got < len) {
          const { bytesRead } = await fh.read(buf, got, len - got, pos + got);
          if (!bytesRead) throw fail('The backup file changed while it was being uploaded.');
          got += bytesRead;
        }
        if (pos <= hashed && pos + len > hashed) { hash.update(buf.subarray(hashed - pos)); hashed = pos + len; }
        return buf;
      };
      const nextFrom = (headers) => {
        const m = /bytes=0-(\d+)/.exec((headers && headers.get && headers.get('range')) || '');
        return m ? Number(m[1]) + 1 : 0;
      };
      const asked = async () => {
        const r = await send(session, { method: 'PUT', headers: { 'Content-Range': `bytes */${size}` } }, SMALL_MS);
        return interpret(r, 0);
      };
      // -> { done: id } | { next: offset }
      const interpret = (r, sent) => {
        if (r.status === 308) return { next: nextFrom(r.headers) };
        if (r.status === 200 || r.status === 201) {
          let id; try { id = JSON.parse(r.text).id; } catch { /* below */ }
          if (!id) throw fail('Google Drive did not confirm the upload.');
          return { done: id };
        }
        throw httpError(r.status, r.text);
      };

      let offset = 0;
      let failures = 0;
      if (size === 0) {
        const r = await send(session, { method: 'PUT', body: Buffer.alloc(0) }, SMALL_MS);
        fileId = interpret(r).done;
      }
      while (fileId === undefined) {
        const len = Math.min(chunkSize, size - offset);
        const buf = await readAt(offset, len);
        let step;
        let asking = false;
        try {
          const r = await send(session, { method: 'PUT', headers: { 'Content-Range': `bytes ${offset}-${offset + len - 1}/${size}` }, body: buf }, BIG_MS);
          step = interpret(r);
        } catch (e) {
          if (!e.transient || ++failures > MAX_RETRIES) throw e;
          await sleep(Math.min(1000 * 2 ** (failures - 1), 30000));
          try { asking = true; step = await asked(); } catch (e2) {
            if (!e2.transient) throw e2;
            continue;   // could not ask either: send the same chunk again
          }
        }
        if (step.done) { fileId = step.done; break; }
        if (step.next > offset + len) throw fail('Google Drive reported more of the upload than was sent.');
        if (step.next <= offset && !asking) { if (++failures > MAX_RETRIES) throw fail('Google Drive stopped accepting the upload.'); await sleep(Math.min(1000 * 2 ** (failures - 1), 30000)); }
        else if (step.next > offset) failures = 0;
        offset = step.next;
        if (offset >= size) throw fail('Google Drive did not confirm the upload.');
      }
    } finally {
      await fh.close();
    }

    const md5 = hash.digest('hex');
    const meta = await json(`${API}/files/${encodeURIComponent(fileId)}?${new URLSearchParams({ fields: 'id,name,size,md5Checksum' })}`);
    if (hashed !== size || String(meta.size) !== String(size) || String(meta.md5Checksum || '').toLowerCase() !== md5) {
      try { await del(fileId); } catch { /* the failure below matters more */ }
      throw fail('Google Drive stored a different copy than the one sent, so the upload was removed. Try again.');
    }

    return { name, size, md5, id: fileId };
  }

  // Permanently deletes the file `id` after checking it is in this install's folder and has that name; returns how many (0 or 1).
  async function remove(name, id, install) {
    const parent = await folder(install, false);
    if (!parent) return 0;
    if (!await owned(parent, name, id, 'id')) return 0;
    await del(id);
    return 1;
  }

  // Downloads the file `id` (checked as for remove) to `out` through out + '.part'; returns { size, md5 }.
  async function get(name, id, out, install) {
    const parent = await folder(install, false);
    const f = parent ? await owned(parent, name, id, 'size,md5Checksum') : null;
    if (!f) throw fail(`There is no backup copy named "${name}" in Google Drive.`);
    const part = `${out}.part`;
    let fh;
    try {
      const hash = crypto.createHash('md5');
      let size = 0;
      fh = await fs.promises.open(part, 'w', 0o600);
      const r = await send(`${API}/files/${encodeURIComponent(f.id)}?alt=media`, {
        follow: true,
        consume: async (res, touch) => {
          for await (const chunk of res.body) {
            touch();
            hash.update(chunk); size += chunk.length;
            let off = 0;
            while (off < chunk.length) {   // a write may take fewer bytes than offered
              const { bytesWritten } = await fh.write(chunk, off, chunk.length - off);
              if (!bytesWritten) throw fail('The backup could not be written to disk.');
              off += bytesWritten;
            }
          }
        },
      }, idleMs);
      if (r.status < 200 || r.status >= 300) throw httpError(r.status, r.text);
      await fh.close(); fh = null;
      if (String(size) !== String(f.size) || hash.digest('hex') !== String(f.md5Checksum || '').toLowerCase()) {
        throw fail('The downloaded copy does not match what Google Drive holds. Try again.');
      }
      await fs.promises.rename(part, out);
      return { size, md5: String(f.md5Checksum).toLowerCase() };
    } catch (e) {
      if (fh) await fh.close().catch(() => {});
      await fs.promises.rm(part, { force: true }).catch(() => {});
      throw e;
    }
  }

  return { accessToken, folder, put, list, remove, get };
}

module.exports = { createDrive, FOLDER_NAME, REVOKED };
