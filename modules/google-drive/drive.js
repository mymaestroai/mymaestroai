'use strict';
// A small Google Drive v3 client for the backup copies. Fetch, clock and sleep are injectable so tests need no network.
// It only ever touches the folder it created itself (marked with an appProperty), because the sign-in is limited to
// the drive.file permission. Messages thrown here never contain tokens.

const crypto = require('crypto');
const fs = require('fs');
const oauth = require('../../lib/oauth-device');

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FOLDER_NAME = 'My Maestro AI Backups';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SMALL_MS = 60 * 1000;
const BIG_MS = 10 * 60 * 1000;
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

const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function createDrive({ clientId, clientSecret, refreshToken, fetch = globalThis.fetch, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), chunkSize = CHUNK, tokenUrl = TOKEN_URL } = {}) {
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

  async function withTimeout(ms, fn) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    try { return await fn(ac.signal); }
    catch (e) { if (ac.signal.aborted) throw fail('Google Drive took too long to answer.', true); throw e; }
    finally { clearTimeout(timer); }
  }

  // One authorised request. consume(res) reads a successful body (default: text). Returns { status, headers, text, value }.
  async function send(url, { method = 'GET', headers = {}, body, consume } = {}, ms = SMALL_MS) {
    for (let attempt = 0; ; attempt++) {
      const token = await accessToken();
      const out = await withTimeout(ms, async (signal) => {
        let res;
        try { res = await fetch(url, { method, headers: { ...headers, Authorization: `Bearer ${token}` }, body, signal }); }
        catch (e) { if (signal.aborted) throw e; throw fail("Couldn't reach Google Drive.", true); }
        if (consume && res.status >= 200 && res.status < 300) return { res, value: await consume(res) };
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

  // The module's own folder. create=false returns null when it does not exist yet.
  async function folder(create = true) {
    const found = await listAll(`mimeType='${FOLDER_MIME}' and appProperties has { key='mymaestro' and value='backups' } and trashed=false`, 'id,name');
    if (found.length) return found[0].id;
    if (!create) return null;
    const made = await json(`${API}/files?fields=id`, {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME, appProperties: { mymaestro: 'backups' } }),
    });
    if (!made.id) throw fail('Google Drive did not create the folder.');
    return made.id;
  }

  const inFolder = (id) => `'${id}' in parents and trashed=false`;
  const byName = (id, name) => `${inFolder(id)} and name='${q(name)}'`;

  async function del(id) {
    const r = await send(`${API}/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (r.status !== 404 && (r.status < 200 || r.status >= 300)) throw httpError(r.status, r.text);
  }

  async function list() {
    const id = await folder(false);
    if (!id) return [];
    const files = await listAll(inFolder(id), 'id,name,size,createdTime');
    return files.map((f) => ({ id: f.id, name: f.name, size: Number(f.size || 0), createdTime: f.createdTime }));
  }

  // Resumable upload of a local file; returns { name, size, md5 } once Drive's own size and checksum match.
  async function put(file, name) {
    if (typeof name !== 'string' || !name.trim()) throw fail('A name is needed for the backup copy.');
    const st = await fs.promises.stat(file);
    if (!st.isFile()) throw fail('The backup is not a file.');
    const size = st.size;
    const parent = await folder(true);

    const init = await send(UPLOAD, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(size) },
      body: JSON.stringify({ name, parents: [parent], appProperties: { mymaestro: 'backup' } }),
    });
    if (init.status < 200 || init.status >= 300) throw httpError(init.status, init.text);
    const session = init.headers && init.headers.get && init.headers.get('location');
    if (!session) throw fail('Google Drive did not start the upload.');

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

    // The new copy is safe: drop older files with the same name.
    for (const old of await listAll(byName(parent, name), 'id')) if (old.id !== fileId) await del(old.id);
    return { name, size, md5 };
  }

  // Permanently deletes every file with that name; returns how many were deleted.
  async function remove(name) {
    const parent = await folder(false);
    if (!parent) return 0;
    const files = await listAll(byName(parent, name), 'id');
    for (const f of files) await del(f.id);
    return files.length;
  }

  // Downloads the newest file with that name to `out` (through out + '.part'); returns { size, md5 }.
  async function get(name, out) {
    const parent = await folder(false);
    const files = parent ? await listAll(byName(parent, name), 'id,size,md5Checksum') : [];
    if (!files.length) throw fail(`There is no backup copy named "${name}" in Google Drive.`);
    const f = files[files.length - 1];   // ordered by createdTime, so the last is the newest
    const part = `${out}.part`;
    try {
      const got = await (async () => {
        const hash = crypto.createHash('md5');
        let size = 0;
        const fh = await fs.promises.open(part, 'w', 0o600);
        const r = await send(`${API}/files/${encodeURIComponent(f.id)}?alt=media`, {
          consume: async (res) => {
            try {
              for await (const chunk of res.body) { hash.update(chunk); size += chunk.length; await fh.write(chunk); }
            } finally { await fh.close(); }
          },
        }, BIG_MS).catch(async (e) => { await fh.close().catch(() => {}); throw e; });
        if (r.status < 200 || r.status >= 300) { await fh.close().catch(() => {}); throw httpError(r.status, r.text); }
        return { size, md5: hash.digest('hex') };
      })();
      if (String(got.size) !== String(f.size) || got.md5 !== String(f.md5Checksum || '').toLowerCase()) {
        throw fail('The downloaded copy does not match what Google Drive holds. Try again.');
      }
      await fs.promises.rename(part, out);
      return got;
    } catch (e) {
      await fs.promises.rm(part, { force: true }).catch(() => {});
      throw e;
    }
  }

  return { accessToken, folder, put, list, remove, get };
}

module.exports = { createDrive, FOLDER_NAME, REVOKED };
