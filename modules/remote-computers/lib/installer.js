'use strict';
// The one-time installer link: short-lived tokens kept in memory only, the web receiver behind them, and the download of the
// Windows x64 helper from the MeshCentral server (as the admin account), cached on disk for a day.
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';   // no 0, o, 1, l, i
const TOKEN_LENGTH = 8;
const TOKEN_TTL_MS = 15 * 60000;
const MAX_TOKENS = 3;
const CACHE_FILE = 'installer-win64.exe';
const CACHE_TTL_MS = 24 * 3600000;
const MAX_INSTALLER_BYTES = 12 * 1024 * 1024;   // the hub sends at most 16 MB; base64 adds a third
const RATE_LIMIT = 10, RATE_WINDOW_MS = 60000;   // RATE_LIMIT: bad, expired or spent tokens per minute; OVERALL_LIMIT: every request per minute
const OVERALL_LIMIT = 60;
const CONFIG_FILE = 'installer-win64.json';
const FILE_NAME = 'MyMaestro-RemoteAgent.exe';
const LINK_FILE = 'installer-link.json';
// What each download is on the MeshCentral server (agent ids: Windows x64 service 4, Linux x86-64 6, Linux ARM64 26, macOS universal 10005).
const MESH_PATHS = {
  windows: '/meshagents?id=4&meshid={meshid}',
  mac: '/meshosxagent?id=10005&meshid={meshid}',
  'linux-x86_64': '/meshagents?id=6',
  'linux-aarch64': '/meshagents?id=26',
  msh: '/meshsettings?id={meshid}',
};
const ARCHES = ['x86_64', 'aarch64'];
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const TOKEN_RE = /^[a-z0-9]{1,40}$/;
const MSH_LINE_RE = /^[A-Za-z0-9_]+=[^\r\n]*$/;
const MSH_DELIMITER = 'MYMAESTRO_MSH_END';
const MSH_MAX_CHARS = 65536;
const FILES = { windows: FILE_NAME, linux: 'install-mymaestro-agent.sh', mac: 'MyMaestro-RemoteAgent-Mac.zip' };
const MZ = (b) => b[0] === 0x4d && b[1] === 0x5a;
const PK = (b) => b[0] === 0x50 && b[1] === 0x4b;
const ELF = (b) => b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46;
const RECEIVE_FETCH_MS = 20000;   // the receiver's absolute limit when it has to fetch (the cache vanished after the link was made)
const PREPARE_MS = 90000;         // the same, for making the link
const GONE ='This link has expired. Make a new one in Data connectors -> Remote computers.\n';
const UNAVAILABLE = 'The installer is not available right now.\n';
const TEXT = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };

/** An error whose message is a plain sentence with no secrets: it may be shown to the owner as the reason. */
class PlainError extends Error { constructor(m) { super(m); this.plain = true; } }
const text = (status, body, extra) => ({ status, headers: { ...TEXT, ...(extra || {}) }, body });

const KINDS = ['windows', 'linux-script', 'linux-agent', 'mac'];

/**
 * createTokens({ now, random }) -> { make(kind, opts), consume(token) }. random(n) -> n random indexes below ALPHABET.length (tests inject it).
 * A token has a kind (windows, linux-script, linux-agent, mac). A Linux link is two tokens (the script and its agent) with one expiry:
 * make('linux-script', { with: <agent token>, data }) joins the new token to that one's link, and the pair counts once toward MAX_TOKENS.
 */
function createTokens({ now = Date.now, random } = {}) {
  const pick = random || ((n) => Array.from({ length: n }, () => crypto.randomInt(ALPHABET.length)));
  const alive = new Map();   // token -> { exp, kind, link, data }, oldest first
  let linkSeq = 0;
  const purge = () => { const t = now(); for (const [k, r] of alive) if (r.exp <= t) alive.delete(k); };
  const links = () => new Set([...alive.values()].map((r) => r.link)).size;
  const makeRoom = () => {   // the newest link replaces the oldest
    while (links() >= MAX_TOKENS) { const gone = alive.values().next().value.link; for (const [k, r] of alive) if (r.link === gone) alive.delete(k); }
  };
  return {
    make(kind = 'windows', opts = {}) {
      if (!KINDS.includes(kind)) throw new Error('unknown token kind');
      purge();
      let token = '';
      do { token = pick(TOKEN_LENGTH).map((i) => ALPHABET[i]).join(''); } while (alive.has(token));
      const mate = opts.with !== undefined ? alive.get(opts.with) : undefined;
      if (opts.with !== undefined && !mate) throw new Error('the token to join is gone');
      if (!mate) makeRoom();
      const expiresAt = mate ? mate.exp : now() + TOKEN_TTL_MS;
      alive.set(token, { exp: expiresAt, kind, link: mate ? mate.link : ++linkSeq, data: opts.data });
      return { token, expiresAt };
    },
    /** What a live token is ({ kind, exp, link, data }); nothing is spent. null for an unknown, spent or expired one. */
    peek(token) { purge(); return typeof token === 'string' && alive.has(token) ? { ...alive.get(token) } : null; },
    /** The record of a live token, and the token is spent; null for an unknown, spent or expired one. */
    takeRecord(token) {
      purge();
      if (typeof token !== 'string' || !alive.has(token)) return null;
      const r = alive.get(token);
      alive.delete(token);
      return r;
    },
    /** The token's expiry (ms) once for a live token, and the token is spent; null for an unknown, spent or expired one. */
    take(token) { const r = this.takeRecord(token); return r ? r.exp : null; },
    /** True for a live token; nothing is spent. */
    has(token) { purge(); return typeof token === 'string' && alive.has(token); },
    /** True once for a live token; the token is spent. */
    consume(token) { return this.take(token) !== null; },
    /** Gives a spent token back with its old expiry, or its whole record (when the download it was for failed). */
    restore(token, expiresAt) {
      purge();
      const r = expiresAt && typeof expiresAt === 'object' ? expiresAt : { exp: expiresAt, kind: 'windows', link: ++linkSeq };
      if (typeof token !== 'string' || alive.has(token) || !(r.exp > now())) return false;
      if (![...alive.values()].some((o) => o.link === r.link)) makeRoom();
      alive.set(token, { ...r });
      return true;
    },
    /** Live links (a Linux script with its agent counts once). */
    size() { purge(); return links(); },
  };
}

// ── the download from MeshCentral ──
function request(opts, body, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(new PlainError('Stopped.')); return; }
    const req = https.request(opts, (res) => {
      const chunks = []; let n = 0;
      res.on('data', (c) => {
        n += c.length;
        if (n > MAX_INSTALLER_BYTES) { req.destroy(new PlainError('The reply was too large.')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new PlainError('Timed out.')));
    if (signal) signal.addEventListener('abort', () => req.destroy(new PlainError('Stopped.')), { once: true });
    req.on('error', reject);
    req.end(body);
  });
}
// "xid=abc; Path=/; HttpOnly" lines -> "xid=abc; xid.sig=def" (only the two session cookies, nothing else is sent back)
function sessionCookies(setCookie) {
  const got = {};
  for (const line of Array.isArray(setCookie) ? setCookie : []) {
    const m = /^(xid|xid\.sig)=([^;]+)/.exec(String(line));
    if (m) got[m[1]] = m[2];
  }
  return got.xid && got['xid.sig'] ? `xid=${got.xid}; xid.sig=${got['xid.sig']}` : null;
}
/**
 * defaultFetcher({ port, servername, ca, user, pass, meshid }) -> Buffer. Logs in as the admin account (form post to /login,
 * the session cookie is bound to this source address) and downloads the Windows x64 helper for the device group.
 */
async function defaultFetcher({ port, servername, ca, user, pass, meshid, path: want, timeoutMs = 60000, signal }) {
  const base = { host: '127.0.0.1', port, ca, servername, rejectUnauthorized: true, headers: {} };
  const form = new URLSearchParams({ action: 'login', username: user, password: pass }).toString();
  const login = await request({ ...base, method: 'POST', path: '/login', headers: { host: `${servername}:${port}`, 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(form) } }, form, 20000, signal);
  const cookie = sessionCookies(login.headers['set-cookie']);
  if (!cookie) throw new PlainError(`The server did not start a session (status ${login.status}).`);
  const short = String(meshid || '').replace(/^mesh\/[^/]*\//, '');
  if (!short) throw new PlainError('The device group is not known yet.');
  // want: a MeshCentral path, "{meshid}" in it becomes the short group id; none = the Windows x64 helper
  const dlPath = typeof want === 'string' ? want.split('{meshid}').join(encodeURIComponent(short)) : MESH_PATHS.windows.split('{meshid}').join(encodeURIComponent(short));
  const dl = await request({ ...base, method: 'GET', path: dlPath, headers: { host: `${servername}:${port}`, cookie } }, undefined, timeoutMs, signal);
  if (dl.status !== 200) throw new PlainError(`The server answered ${dl.status} for the installer.`);
  return dl.body;
}

/** The group settings text as lines of key=value only (blank lines dropped), or a plain error: nothing else may reach the script. */
function checkMsh(buf) {
  const raw = Buffer.isBuffer(buf) ? buf.toString('utf8') : typeof buf === 'string' ? buf : '';
  // MeshCentral 1.3.1 sends about 29 KB: one translation= line holds the agent's interface texts as JSON.
  if (!raw || raw.length > MSH_MAX_CHARS || raw.includes(MSH_DELIMITER)) throw new PlainError('The server did not send the group settings in the expected form.');
  const lines = raw.split(/\r?\n/).filter((l) => l !== '');
  if (!lines.length || lines.some((l) => !MSH_LINE_RE.test(l))) throw new PlainError('The server did not send the group settings in the expected form.');
  return lines.join('\n');
}

/** The POSIX sh script for a Linux computer. Every value that goes in is checked here; throws a plain error for one that does not fit. */
function buildLinuxScript({ host, agentToken, mshText }) {
  if (typeof host !== 'string' || !HOST_RE.test(host)) throw new PlainError('The tailnet name in the settings is not a valid computer name.');
  if (typeof agentToken !== 'string' || !TOKEN_RE.test(agentToken)) throw new PlainError('The link could not be made.');
  const msh = checkMsh(mshText);
  const base = `https://${host}/hooks/remote-computers/installer?t=${agentToken}`;
  return [
    '#!/bin/sh',
    '# Installs the My Maestro remote computer helper on this Linux computer. Made for one use by your Maestro.',
    'set -eu',
    '',
    'if [ "$(id -u)" != "0" ]; then',
    '  echo "This must run as root (administrator)."',
    '  echo "Make a new link on your Maestro\'s setup page and run the command it shows."',
    '  exit 1',
    'fi',
    '',
    'case "$(uname -m)" in',
    '  x86_64|amd64) ARCH=x86_64 ;;',
    '  aarch64|arm64) ARCH=aarch64 ;;',
    '  *) echo "This computer\'s processor type ($(uname -m)) is not supported yet."; exit 1 ;;',
    'esac',
    '',
    'if ! command -v curl >/dev/null 2>&1; then',
    '  echo "This needs the program curl. Install it first, then make a new link on your Maestro\'s setup page."',
    '  exit 1',
    'fi',
    '',
    'DIR=$(mktemp -d)',
    'echo "Downloading the helper..."',
    `curl -fsSL "${base}&arch=$ARCH" -o "$DIR/meshagent"`,
    'chmod 755 "$DIR/meshagent"',
    '',
    `cat > "$DIR/meshagent.msh" <<'${MSH_DELIMITER}'`,
    msh,
    MSH_DELIMITER,
    '',
    'cd "$DIR"',
    'if [ -d /run/systemd/system ]; then',
    '  ./meshagent -fullinstall --copy-msh=1',
    '  echo "The helper is installed as a service. This computer will connect to your Maestro in about a minute."',
    'else',
    '  echo "This computer has no systemd, so the helper runs in this terminal until you close it."',
    '  exec ./meshagent --copy-msh=1',
    'fi',
    '',
  ].join('\n');
}

/**
 * createInstaller({ home, now, log, fetchInstaller, address, configKey }) -> { link(), receive(params) }.
 * fetchInstaller() -> Buffer (the exe); fetchPath({ what, signal }) -> Buffer for the other kinds (what: mac, linux-x86_64, linux-aarch64, msh; see MESH_PATHS); address() -> the tailnet name (throws a plain message when it is not set);
 * configKey() -> a text for the setup the helper is built for (name, computer port, device group, certificate); a cached file is reused only for the same key.
 */
function createInstaller({ home, now = Date.now, log = () => {}, fetchInstaller, fetchPath, address, configKey = () => '', tokens = createTokens({ now }), receiveMs = RECEIVE_FETCH_MS, prepareMs = PREPARE_MS }) {
  const bad = [], all = [];
  const flights = new Map();   // entry name -> { run, ctl }: one fetch at a time per file
  let msh = null;              // the group settings text of the last Linux preparation (memory only)
  const recent = (list) => { const t = now(); while (list.length && t - list[0] >= RATE_WINDOW_MS) list.shift(); return list; };
  const keyHash = () => crypto.createHash('sha256').update(String(configKey())).digest('hex');
  // The files the receiver can serve from the cache: what to call them, how to tell the right kind of file, and how to fetch them.
  const ENTRIES = {
    windows: { file: CACHE_FILE, meta: CONFIG_FILE, magic: MZ, notIt: 'The server did not send a program file.' },
    mac: { file: 'installer-mac.zip', meta: 'installer-mac.json', magic: PK, notIt: 'The server did not send a zip file.', what: 'mac' },
    'linux-x86_64': { file: 'installer-linux-x86_64.bin', meta: 'installer-linux-x86_64.json', magic: ELF, notIt: 'The server did not send a program file.', what: 'linux-x86_64' },
    'linux-aarch64': { file: 'installer-linux-aarch64.bin', meta: 'installer-linux-aarch64.json', magic: ELF, notIt: 'The server did not send a program file.', what: 'linux-aarch64' },
  };
  const fetchEntry = (name, signal) => {
    if (name === 'windows') return fetchInstaller({ signal });
    if (typeof fetchPath !== 'function') throw new PlainError('This kind of computer is not available on this server.');
    return fetchPath({ what: ENTRIES[name].what, signal });
  };

  function cached(name = 'windows') {
    const e = ENTRIES[name];
    if (!home) return null;
    const file = path.join(home, e.file);
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(home, e.meta), 'utf8'));
      if (!meta || meta.config !== keyHash()) return null;   // built for another setup (or never recorded): fetch it again
    } catch { return null; }
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || now() - st.mtimeMs >= CACHE_TTL_MS || now() < st.mtimeMs - 60000 || st.size < 2 || st.size > MAX_INSTALLER_BYTES) return null;
      const buf = fs.readFileSync(file);
      return e.magic(buf) ? buf : null;
    } catch { return null; }
  }
  function store(buf, config, name = 'windows') {
    if (!home) return;
    const e = ENTRIES[name];
    const file = path.join(home, e.file), tmp = `${file}.${process.pid}.tmp`, metaFile = path.join(home, e.meta), metaTmp = `${metaFile}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      try { fs.unlinkSync(metaFile); } catch { /* none */ }   // the old record goes first: a file without a matching record is never reused
      fs.writeFileSync(tmp, buf, { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, file);
      fs.utimesSync(file, new Date(now()), new Date(now()));
      fs.writeFileSync(metaTmp, JSON.stringify({ config }) + '\n', { mode: 0o600 });
      fs.chmodSync(metaTmp, 0o600);
      fs.renameSync(metaTmp, metaFile);
    } catch (e) {
      try { fs.unlinkSync(metaTmp); } catch { /* none */ }
      log('could not keep the installer:', String((e && e.code) || 'error').slice(0, 40));
      try { fs.unlinkSync(tmp); } catch { /* none */ }
    }
  }
  // The cached file, or a fetch that is given up (its requests aborted) when limitMs has passed: one absolute deadline, whatever the fetcher does.
  async function installer(limitMs, name = 'windows') {
    const have = cached(name);
    if (have) return have;
    if (!flights.has(name)) {
      const ctl = new AbortController();
      const run = (async () => {
        const config = keyHash();   // taken before the fetch: a setup changed meanwhile will not match the stored record
        const buf = await fetchEntry(name, ctl.signal);
        if (ctl.signal.aborted) throw new PlainError('Timed out.');
        if (!Buffer.isBuffer(buf) || buf.length < 2 || buf.length > MAX_INSTALLER_BYTES || !ENTRIES[name].magic(buf)) throw new PlainError(ENTRIES[name].notIt);
        store(buf, config, name);
        return buf;
      })();
      flights.set(name, { run, ctl });
      const done = () => { const f = flights.get(name); if (f && f.run === run) flights.delete(name); };
      run.then(done, done);
    }
    const { run, ctl } = flights.get(name);
    let timer;
    const limit = new Promise((_, reject) => {
      timer = setTimeout(() => { ctl.abort(); const f = flights.get(name); if (f && f.run === run) flights.delete(name); reject(new PlainError(`Timed out after ${Math.round(limitMs / 1000)} seconds.`)); }, limitMs);
    });
    try { return await Promise.race([run, limit]); } finally { clearTimeout(timer); }
  }
  // The group settings text (a few lines of key=value) for the Linux script: fetched with the admin login, checked line by line, kept in memory.
  async function fetchMsh(limitMs) {
    if (typeof fetchPath !== 'function') throw new PlainError('This kind of computer is not available on this server.');
    const ctl = new AbortController();
    let timer;
    const limit = new Promise((_, reject) => { timer = setTimeout(() => { ctl.abort(); reject(new PlainError(`Timed out after ${Math.round(limitMs / 1000)} seconds.`)); }, limitMs); });
    try {
      const buf = await Promise.race([Promise.resolve().then(() => fetchPath({ what: 'msh', signal: ctl.signal })), limit]);
      return checkMsh(buf);
    } finally { clearTimeout(timer); }
  }
  // Why a preparation failed, as a plain sentence: only our own messages or an error code, never what a server said.
  const reasonOf = (e) => {
    const m = e && e.plain ? String(e.message) : e && typeof e.code === 'string' && /^[A-Z_]{3,30}$/.test(e.code) ? `connection error ${e.code}` : 'the server did not give it';
    return m.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 120);
  };

  // A small record in the connector's own folder: when the last link was made and when one was last opened (times only, never a token).
  // The setup's "wait for the computer" check reads it to say why no computer has appeared.
  let seen = null;
  const readSeen = () => {
    if (seen) return seen;
    seen = { madeAt: null, usedAt: null };
    if (!home) return seen;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(home, LINK_FILE), 'utf8'));
      if (j && Number.isFinite(j.madeAt)) seen.madeAt = j.madeAt;
      if (j && Number.isFinite(j.usedAt)) seen.usedAt = j.usedAt;
    } catch { /* none yet */ }
    return seen;
  };
  const writeSeen = () => {
    if (!home) return;
    const file = path.join(home, LINK_FILE), tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify(seen) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* none */ }
      log('could not keep the link record:', String((e && e.code) || 'error').slice(0, 40));
    }
  };

  return {
    /** { made, used }: a link was ever made; the last link made was opened (the helper was downloaded). */
    stats() {
      const s = readSeen();
      return { made: s.madeAt !== null, used: s.usedAt !== null && (s.madeAt === null || s.usedAt >= s.madeAt) };
    },
    /** Makes sure a valid cached installer exists (fetching it when the cache is missing or was built for another setup). Throws a plain error. */
    async prepare({ os = 'windows' } = {}) {
      if (!FILES[os]) throw new PlainError('The kind of computer must be windows, linux or mac.');
      try {
        if (os === 'linux') msh = await fetchMsh(prepareMs);   // the agent files are fetched when the script downloads them
        else await installer(prepareMs, os);
      } catch (e) {
        log('installer could not be prepared:', String((e && (e.code || e.message)) || 'error').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 120));
        throw new PlainError(`The installer could not be prepared: ${reasonOf(e)}`);
      }
    },
    /** { url, expiresAt, os, file }. Linux needs prepare({ os: 'linux' }) first (the group settings go into the script). */
    link({ os = 'windows' } = {}) {
      if (!FILES[os]) throw new PlainError('The kind of computer must be windows, linux or mac.');
      const name = address();
      let made;
      if (os === 'linux') {
        if (!msh) throw new PlainError('The group settings are not ready yet. Try again.');
        if (!HOST_RE.test(String(name))) throw new PlainError('The tailnet name in the settings is not a valid computer name.');
        checkMsh(msh);
        made = tokens.make('linux-agent');
        const probe = buildLinuxScript({ host: name, agentToken: made.token, mshText: msh });
        made = { ...tokens.make('linux-script', { with: made.token, data: probe }), agent: made };
      } else made = tokens.make(os);
      readSeen().madeAt = now(); writeSeen();
      return { url: `https://${name}/hooks/remote-computers/installer?t=${made.token}`, expiresAt: new Date(made.expiresAt).toISOString(), os, file: FILES[os] };
    },
    // params: the hub's hub/receive request ({ method, path: 'installer', query: { t: '<token>' }, ... }); the hub routes only /hooks/<id>/<path>
    async receive(params) {
      const p = String((params && params.path) || '');
      const q = params && params.query;
      const t = q && typeof q === 'object' ? q.t : typeof q === 'string' ? new URLSearchParams(q).get('t') : undefined;
      const arch = q && typeof q === 'object' ? q.arch : typeof q === 'string' ? new URLSearchParams(q).get('arch') : undefined;
      const m = p === 'installer' && typeof t === 'string' ? TOKEN_RE.exec(t) : null;
      // Two limits: every request counts toward a loose cap; only a bad, expired or spent token counts toward the tight one (a guessing attempt).
      // A live token is looked at without spending it, so a flood of bad guesses never blocks the real link.
      const valid = !!m && tokens.has(m[0]);
      if (recent(all).length >= OVERALL_LIMIT || (!valid && recent(bad).length >= RATE_LIMIT)) return text(429, 'Too many requests\n', { 'retry-after': '60' });
      all.push(now());
      if (String((params && params.method) || 'GET').toUpperCase() !== 'GET') return text(405, 'Method not allowed\n', { allow: 'GET' });
      const peeked = valid ? tokens.peek(m[0]) : null;
      // The agent download needs a known processor type; asked wrongly, nothing is spent.
      if (peeked && peeked.kind === 'linux-agent' && !ARCHES.includes(arch)) return text(400, 'Unknown processor type. Use arch=x86_64 or arch=aarch64.\n');
      const rec = valid ? tokens.takeRecord(m[0]) : null;
      if (rec === null) { bad.push(now()); return text(404, GONE); }
      const octet = (name, buf) => ({
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' },
        bodyBase64: buf.toString('base64'),
      });
      try {
        if (rec.kind === 'linux-script') {   // the script is in memory with its token: nothing is fetched, and this is not yet a join
          return { status: 200, headers: { 'content-type': 'text/x-shellscript; charset=utf-8', 'content-disposition': `attachment; filename="${FILES.linux}"`, 'cache-control': 'no-store' }, body: rec.data };
        }
        const entry = rec.kind === 'linux-agent' ? `linux-${arch}` : rec.kind;   // the link was made after the file was prepared: normally no fetch here
        const buf = await installer(receiveMs, entry);
        readSeen().usedAt = now(); writeSeen();
        return octet(rec.kind === 'linux-agent' ? 'meshagent' : rec.kind === 'mac' ? FILES.mac : FILE_NAME, buf);
      } catch (e) {
        tokens.restore(m[0], rec);   // the download failed: the link was not used up
        log('installer download failed:', String((e && (e.code || e.message)) || 'error').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 120));
        return text(502, UNAVAILABLE);
      }
    },
  };
}

module.exports = { KINDS, MESH_PATHS, FILES, ARCHES, buildLinuxScript, checkMsh, PlainError, RECEIVE_FETCH_MS, PREPARE_MS, createTokens, createInstaller, defaultFetcher, sessionCookies, ALPHABET, TOKEN_LENGTH, TOKEN_TTL_MS, MAX_TOKENS, CACHE_FILE, CACHE_TTL_MS, RATE_LIMIT, OVERALL_LIMIT, CONFIG_FILE, FILE_NAME, LINK_FILE, GONE, UNAVAILABLE };
