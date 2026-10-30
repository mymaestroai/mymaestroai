'use strict';
/**
 * backup/format.js — the backup file. It is the open age v1 format (age-encryption.org/v1), so a backup opens with the
 * free `age` tool and the recovery key even without My Maestro. Built on Node's own crypto (X25519, HKDF-SHA-256,
 * ChaCha20-Poly1305, scrypt, HMAC-SHA-256); no package.
 *
 * The header of a My Maestro backup carries three stanzas:
 *   X25519 <ephemeral share>              the file key, wrapped for the install's backup public key (the age spec)
 *   mymaestro-pw <keyId> <salt> <log2 N>  the backup PRIVATE key, locked with the backup password: scrypt(N=2^logN, r=8,
 *                                          p=1) over PW_LABEL + salt, then ChaCha20-Poly1305 with a zero nonce (each salt,
 *                                          so each key, locks exactly one plaintext). age identities MUST ignore stanzas
 *                                          they don't recognize, so the stock tool skips it and opens the file with the
 *                                          recovery key; age's own scrypt stanza can't be used because it must stand alone.
 *   mymaestro-info                         a small JSON body of labels for the list (date, version, size…). Covered by the
 *                                          header MAC, which can only be checked once the file key is unwrapped: until
 *                                          then it is a label, never a fact.
 * Payload: a 16-byte nonce, then age STREAM: 64 KiB chunks, ChaCha20-Poly1305, nonce = 11-byte counter + last-chunk flag.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');

const VERSION_LINE = 'age-encryption.org/v1';
const CHUNK = 64 * 1024;
const TAG = 16;
const PW_LABEL = 'mymaestro-backup/v1/pw';
const DEFAULT_LOGN = 18;            // 2^18 * 128 * 8 bytes = 256 MiB of memory, about a second of work
const LOGN_MIN = 15, LOGN_MAX = 18;   // a crafted file can't ask for more than the 256 MiB we use
const MAX_HEADER = 64 * 1024;
const MAX_STANZAS = 32;

const ERR = {
  notBackup: 'This file is not a My Maestro backup, or it is damaged.',
  password: 'That password does not open this backup.',
  key: 'That recovery key does not open this backup.',
  damaged: 'The backup is cut off or damaged, so it was not used.',
};
const fail = (msg, code) => Object.assign(new Error(msg), { code: code || 'EBACKUP' });

// ── encodings ────────────────────────────────────────────────────────────────────────────────────────────────────
const b64 = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '');
function unb64(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/]*$/.test(s)) throw fail(ERR.notBackup);
  const b = Buffer.from(s, 'base64');
  if (b64(b) !== s) throw fail(ERR.notBackup);   // age wants canonical, unpadded base64
  return b;
}

// Bech32 (BIP-173), as age uses it for keys: "age1…" public keys and "AGE-SECRET-KEY-1…" secret keys.
const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}
function hrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}
function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0;
  const out = [], maxv = (1 << to) - 1;
  for (const v of data) {
    acc = (acc << from) | v; bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
  }
  if (pad) { if (bits) out.push((acc << (to - bits)) & maxv); }
  else if (bits >= from || ((acc << (to - bits)) & maxv)) throw fail('That key is not valid.');
  return out;
}
function bech32Encode(hrp, bytes) {
  const data = convertBits([...bytes], 8, 5, true);
  const mod = polymod(hrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0])) ^ 1;
  const chk = [];
  for (let i = 0; i < 6; i++) chk.push((mod >>> (5 * (5 - i))) & 31);
  return hrp + '1' + data.concat(chk).map(d => B32[d]).join('');
}
function bech32Decode(str) {
  const s = String(str).trim();
  const lower = s.toLowerCase();
  if (s !== lower && s !== s.toUpperCase()) throw fail('That key is not valid.');
  const pos = lower.lastIndexOf('1');
  if (pos < 1 || pos + 7 > lower.length) throw fail('That key is not valid.');
  const data = [];
  for (const c of lower.slice(pos + 1)) { const d = B32.indexOf(c); if (d < 0) throw fail('That key is not valid.'); data.push(d); }
  if (polymod(hrpExpand(lower.slice(0, pos)).concat(data)) !== 1) throw fail('That key is not valid.');
  return { hrp: lower.slice(0, pos), bytes: Buffer.from(convertBits(data.slice(0, -6), 5, 8, false)) };
}

// ── primitives ───────────────────────────────────────────────────────────────────────────────────────────────────
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');
const privKeyObj = (raw) => crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: 'der', type: 'pkcs8' });
const pubKeyObj = (raw) => crypto.createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: 'der', type: 'spki' });
const rawPriv = (k) => k.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
const rawPub = (k) => k.export({ format: 'der', type: 'spki' }).subarray(-32);
function x25519(privRaw, pubRaw) {
  let out;
  try { out = crypto.diffieHellman({ privateKey: privKeyObj(privRaw), publicKey: pubKeyObj(pubRaw) }); }
  catch { return null; }   // a low-order point: OpenSSL refuses an all-zero result
  return out.every(b => b === 0) ? null : out;
}
function publicFromPrivate(privRaw) { return rawPub(crypto.createPublicKey(privKeyObj(privRaw))); }
function newKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  return { priv: Buffer.from(rawPriv(privateKey)), pub: Buffer.from(rawPub(publicKey)) };
}
const hkdf = (ikm, salt, info, len = 32) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
const ZERO_NONCE = Buffer.alloc(12);
function seal(key, nonce, pt) {
  const c = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG });
  return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
}
function unseal(key, nonce, ct) {
  if (ct.length < TAG) return null;
  try {
    const d = crypto.createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG });
    d.setAuthTag(ct.subarray(ct.length - TAG));
    return Buffer.concat([d.update(ct.subarray(0, ct.length - TAG)), d.final()]);
  } catch { return null; }
}

// ── keys ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const keyIdFor = (pubRaw) => crypto.createHash('sha256').update('mymaestro-backup-key:').update(pubRaw).digest('hex').slice(0, 16);
const encodeRecipient = (pubRaw) => bech32Encode('age', pubRaw);
const encodeIdentity = (privRaw) => bech32Encode('age-secret-key-', privRaw).toUpperCase();
function decodeRecipient(str) {
  const { hrp, bytes } = bech32Decode(str);
  if (hrp !== 'age' || bytes.length !== 32) throw fail('That key is not valid.');
  return bytes;
}
function decodeIdentity(str) {
  // Accept a bare key or an age identity file: the first line that starts with AGE-SECRET-KEY-1.
  const line = String(str).split(/\r?\n/).map(l => l.trim()).find(l => /^AGE-SECRET-KEY-1/i.test(l));
  if (!line) throw fail('That is not a recovery key. It starts with AGE-SECRET-KEY-1.');
  const { hrp, bytes } = bech32Decode(line);
  if (hrp !== 'age-secret-key-' || bytes.length !== 32) throw fail('That is not a recovery key. It starts with AGE-SECRET-KEY-1.');
  return bytes;
}

// The password lock on the private key (the "envelope"). Async: scrypt runs in Node's thread pool, not on the hub's
// event loop.
function scryptKey(password, salt, logN) {
  if (!Number.isInteger(logN) || logN < LOGN_MIN || logN > LOGN_MAX) return Promise.reject(fail(ERR.notBackup));
  const pw = Buffer.from(String(password).normalize('NFC'), 'utf8');
  return new Promise((resolve, reject) => crypto.scrypt(pw, Buffer.concat([Buffer.from(PW_LABEL), salt]), 32,
    { N: 2 ** logN, r: 8, p: 1, maxmem: 2 ** logN * 128 * 8 + 32 * 1024 * 1024 }, (e, k) => e ? reject(e) : resolve(k)));
}
async function makeEnvelope(password, privRaw, { keyId, logN = DEFAULT_LOGN } = {}) {
  if (!keyId) keyId = keyIdFor(publicFromPrivate(privRaw));
  const salt = crypto.randomBytes(16);
  const key = await scryptKey(password, salt, logN);
  return { type: 'mymaestro-pw', args: [keyId, b64(salt), String(logN)], body: seal(key, ZERO_NONCE, privRaw) };
}
async function openEnvelope(stanza, password) {
  const [keyId, saltB64, logNs] = stanza.args;
  if (stanza.args.length !== 3 || !/^[0-9a-f]{16}$/.test(keyId) || !/^\d{2}$/.test(logNs)) throw fail(ERR.notBackup);
  const salt = unb64(saltB64);
  if (salt.length !== 16 || stanza.body.length !== 32 + TAG) throw fail(ERR.notBackup);
  const priv = unseal(await scryptKey(password, salt, Number(logNs)), ZERO_NONCE, stanza.body);
  if (!priv) return null;
  return keyIdFor(publicFromPrivate(priv)) === keyId ? priv : null;
}
const infoStanza = (info) => ({ type: 'mymaestro-info', args: [], body: Buffer.from(JSON.stringify(info), 'utf8') });
// Proof of origin. The X25519 stanza alone lets anyone who knows the public key make a file that this install's password
// opens (the password stanza can be copied from any backup's header). The origin stanza is an HMAC, under a key derived
// from the private key (kept in Settings, so unattended backups can sign), over this file's X25519 stanza and the hash of
// its manifest; it is checked after unlocking, before anything is unpacked. age implementations ignore it.
const originKeyFrom = (privRaw) => hkdf(privRaw, Buffer.alloc(0), 'mymaestro-backup/v1/origin');
function originMac(macKey, x25519, manifestSha) {
  return crypto.createHmac('sha256', macKey).update(`mymaestro-origin/v1\n${x25519.args.join(' ')}\n${x25519.body.toString('base64')}\n${manifestSha}`).digest();
}
const originStanza = (macKey, x25519, manifestSha) => ({ type: 'mymaestro-origin', args: [manifestSha], body: originMac(macKey, x25519, manifestSha) });
function checkOrigin(stanzas, privRaw, manifestSha) {
  const o = stanzas.filter(s => s.type === 'mymaestro-origin'), x = stanzas.filter(s => s.type === 'X25519');
  if (o.length !== 1 || x.length !== 1 || o[0].args.length !== 1 || o[0].args[0] !== manifestSha) return false;
  const want = originMac(originKeyFrom(privRaw), x[0], manifestSha);
  return o[0].body.length === want.length && crypto.timingSafeEqual(o[0].body, want);
}
function readInfo(stanzas) {
  const s = stanzas.find(x => x.type === 'mymaestro-info');
  if (!s) return null;
  try { const v = JSON.parse(s.body.toString('utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}

// ── header ───────────────────────────────────────────────────────────────────────────────────────────────────────
function wrapBody(body) {
  const s = b64(body);
  const lines = [];
  for (let i = 0; i < s.length; i += 64) lines.push(s.slice(i, i + 64));
  if (s.length % 64 === 0) lines.push('');   // the last line is always shorter than 64 columns
  return lines.join('\n') + '\n';
}
function headerText(stanzas) {
  let h = VERSION_LINE + '\n';
  for (const s of stanzas) h += '-> ' + [s.type, ...s.args].join(' ') + '\n' + wrapBody(s.body);
  return h + '---';
}
function headerMac(fileKey, text) {
  return crypto.createHmac('sha256', hkdf(fileKey, Buffer.alloc(0), 'header')).update(Buffer.from(text, 'latin1')).digest();
}
function encodeHeader(stanzas, fileKey) {
  const text = headerText(stanzas);
  return Buffer.from(text + ' ' + b64(headerMac(fileKey, text)) + '\n', 'latin1');
}
// Parse a header from the start of buf. null = not enough bytes yet. { stanzas, macInput, mac, length }.
function parseHeader(buf) {
  let pos = 0;
  const nextLine = () => {
    const i = buf.indexOf(0x0a, pos);
    if (i < 0) { if (buf.length > MAX_HEADER) throw fail(ERR.notBackup); return null; }
    const line = buf.subarray(pos, i).toString('latin1');
    pos = i + 1;
    return line;
  };
  const first = nextLine();
  if (first === null) return null;
  if (first !== VERSION_LINE) throw fail(ERR.notBackup);
  const stanzas = [];
  for (;;) {
    const lineStart = pos;
    const line = nextLine();
    if (line === null) return null;
    if (line.startsWith('---')) {
      if (!line.startsWith('--- ')) throw fail(ERR.notBackup);
      const mac = unb64(line.slice(4));
      if (mac.length !== 32) throw fail(ERR.notBackup);
      return { stanzas, macInput: buf.subarray(0, lineStart + 3).toString('latin1'), mac, length: pos };
    }
    if (!line.startsWith('-> ')) throw fail(ERR.notBackup);
    const parts = line.slice(3).split(' ');
    if (!parts.every(p => /^[\x21-\x7e]+$/.test(p))) throw fail(ERR.notBackup);
    let body = '';
    for (;;) {
      const bl = nextLine();
      if (bl === null) return null;
      if (bl.length > 64) throw fail(ERR.notBackup);
      body += bl;
      if (bl.length < 64) break;
    }
    stanzas.push({ type: parts[0], args: parts.slice(1), body: unb64(body) });
    if (stanzas.length > MAX_STANZAS) throw fail(ERR.notBackup);
  }
}
function wrapX25519(fileKey, pubRaw) {
  const e = newKeyPair();
  const shared = x25519(e.priv, pubRaw);
  if (!shared) throw fail('That backup key is not valid.');
  const wk = hkdf(shared, Buffer.concat([e.pub, pubRaw]), 'age-encryption.org/v1/X25519');
  return { type: 'X25519', args: [b64(e.pub)], body: seal(wk, ZERO_NONCE, fileKey) };
}
function unwrapX25519(stanzas, privRaw) {
  const pubRaw = publicFromPrivate(privRaw);
  for (const s of stanzas) {
    if (s.type !== 'X25519') continue;
    if (s.args.length !== 1) throw fail(ERR.notBackup);
    const share = unb64(s.args[0]);
    if (share.length !== 32 || s.body.length !== 32) throw fail(ERR.notBackup);
    const shared = x25519(privRaw, share);
    if (!shared) continue;
    const fileKey = unseal(hkdf(shared, Buffer.concat([share, pubRaw]), 'age-encryption.org/v1/X25519'), ZERO_NONCE, s.body);
    if (fileKey) return fileKey;
  }
  return null;
}
function checkMac(header, fileKey) {
  const want = headerMac(fileKey, header.macInput);
  return want.length === header.mac.length && crypto.timingSafeEqual(want, header.mac);
}

// ── payload streams ──────────────────────────────────────────────────────────────────────────────────────────────
function chunkNonce(counter, last) {
  const n = Buffer.alloc(12);
  let c = counter;
  for (let i = 10; i >= 0 && c > 0n; i--) { n[i] = Number(c & 0xffn); c >>= 8n; }
  n[11] = last ? 1 : 0;
  return n;
}
// Encrypts to one backup public key; `stanzas` adds the envelope and the info stanza after the X25519 one.
class EncryptStream extends Transform {
  constructor({ recipient, stanzas = [], origin = null }) {
    super();
    const fileKey = crypto.randomBytes(16);
    const x = wrapX25519(fileKey, recipient);
    this.push(encodeHeader([x, ...stanzas, ...(origin ? [originStanza(origin.macKey, x, origin.manifestSha256)] : [])], fileKey));
    const nonce = crypto.randomBytes(16);
    this.push(nonce);
    this.key = hkdf(fileKey, nonce, 'payload');
    this.counter = 0n;
    this.pending = [];
    this.pendingLen = 0;
  }
  _transform(data, _enc, cb) {
    this.pending.push(data); this.pendingLen += data.length;
    if (this.pendingLen > CHUNK) {       // keep at least one byte back: only the flush knows which chunk is last
      let all = Buffer.concat(this.pending);
      while (all.length > CHUNK) { this.push(seal(this.key, chunkNonce(this.counter++, false), all.subarray(0, CHUNK))); all = all.subarray(CHUNK); }
      this.pending = [all]; this.pendingLen = all.length;
    }
    cb();
  }
  _flush(cb) {
    this.push(seal(this.key, chunkNonce(this.counter++, true), Buffer.concat(this.pending)));
    cb();
  }
}
// Decrypts. unlock(header) resolves the backup private key (from the password envelope or a recovery key) or null.
// Emits 'header' with { stanzas, info } once the header is authenticated. Plaintext is only ever released chunk by
// chunk after that chunk's tag checks out; a missing last chunk is an error at the end.
class DecryptStream extends Transform {
  constructor({ unlock }) {
    super();
    this.unlock = unlock;
    this.stage = 'header';
    this.buf = Buffer.alloc(0);
    this.counter = 0n;
  }
  _transform(data, _enc, cb) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data;
    this._drain(false).then(() => cb(), cb);
  }
  _flush(cb) { this._drain(true).then(() => cb(), cb); }
  async _drain(end) {
    if (this.stage === 'header') {
      const h = parseHeader(this.buf);
      if (!h) { if (end || this.buf.length > MAX_HEADER) throw fail(ERR.notBackup); return; }   // a header without end is not a backup
      this.stage = 'unlocking';
      const priv = await this.unlock(h);
      if (!priv) throw this.unlockError || fail(ERR.password, 'EPASSWORD');
      const fileKey = unwrapX25519(h.stanzas, priv);
      if (!fileKey) throw fail(ERR.key, 'EKEY');
      if (!checkMac(h, fileKey)) throw fail(ERR.damaged);
      this.fileKey = fileKey;
      this.buf = this.buf.subarray(h.length);
      this.stage = 'nonce';
      this.emit('header', { stanzas: h.stanzas, info: readInfo(h.stanzas) });
    }
    if (this.stage === 'nonce') {
      if (this.buf.length < 16) { if (end) throw fail(ERR.damaged); return; }
      this.key = hkdf(this.fileKey, this.buf.subarray(0, 16), 'payload');
      this.buf = this.buf.subarray(16);
      this.stage = 'payload';
    }
    if (this.stage === 'payload') {
      while (this.buf.length > CHUNK + TAG) {
        const pt = unseal(this.key, chunkNonce(this.counter, false), this.buf.subarray(0, CHUNK + TAG));
        if (!pt) throw fail(ERR.damaged);
        this.counter++;
        this.push(pt);
        this.buf = this.buf.subarray(CHUNK + TAG);
      }
      if (end) {
        const pt = unseal(this.key, chunkNonce(this.counter, true), this.buf);
        if (!pt || (pt.length === 0 && this.counter > 0n)) throw fail(ERR.damaged);
        this.push(pt);
        this.stage = 'done';
      }
    }
  }
}

// An unlock function for DecryptStream: the backup password, or a recovery key.
function unlockWith({ password, recoveryKey }) {
  return async function unlock(header) {
    if (recoveryKey) return decodeIdentity(recoveryKey);
    const env = header.stanzas.find(s => s.type === 'mymaestro-pw');
    if (!env) { this.unlockError = fail('This backup has no password lock. Open it with its recovery key.', 'ENOPW'); return null; }
    return openEnvelope(env, password);
  };
}

// The header only (labels for the list, the key id), without any password.
async function readHeader(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(MAX_HEADER);
    const { bytesRead } = await fh.read(buf, 0, MAX_HEADER, 0);
    const h = parseHeader(buf.subarray(0, bytesRead));
    if (!h) throw fail(ERR.notBackup);
    const pw = h.stanzas.find(s => s.type === 'mymaestro-pw');
    return { stanzas: h.stanzas, info: readInfo(h.stanzas), keyId: pw ? pw.args[0] : null, length: h.length };
  } finally { await fh.close(); }
}

// Rewrite only the header of a backup (a password change): the X25519 stanza stays, the envelope (and optionally the
// info) is replaced, the header MAC is recomputed with the file key, and the payload bytes are copied unchanged. The
// new file is written beside dst and renamed over it once complete.
async function rewriteHeader(src, dst, privRaw, { envelope, info } = {}) {
  const fh = await fs.promises.open(src, 'r');
  let h;
  try {
    const buf = Buffer.alloc(MAX_HEADER);
    const { bytesRead } = await fh.read(buf, 0, MAX_HEADER, 0);
    h = parseHeader(buf.subarray(0, bytesRead));
  } finally { await fh.close(); }
  if (!h) throw fail(ERR.notBackup);
  const fileKey = unwrapX25519(h.stanzas, privRaw);
  if (!fileKey || !checkMac(h, fileKey)) throw fail(ERR.key, 'EKEY');
  const stanzas = h.stanzas.filter(s => s.type === 'X25519');
  if (envelope) stanzas.push(envelope); else stanzas.push(...h.stanzas.filter(s => s.type === 'mymaestro-pw'));
  if (info) stanzas.push(infoStanza(info)); else stanzas.push(...h.stanzas.filter(s => s.type === 'mymaestro-info'));
  stanzas.push(...h.stanzas.filter(s => s.type === 'mymaestro-origin'));   // the same X25519 stanza, so still valid
  const tmp = `${dst}.rewrite-${process.pid}-${Date.now()}`;
  const out = await fs.promises.open(tmp, 'wx', 0o600);
  try {
    await out.write(encodeHeader(stanzas, fileKey));
    const inp = fs.createReadStream(src, { start: h.length });
    for await (const chunk of inp) await out.write(chunk);
    await out.sync();
  } catch (e) { await out.close().catch(() => {}); await fs.promises.rm(tmp, { force: true }); throw e; }
  await out.close();
  await fs.promises.rename(tmp, dst);
  syncDir(path.dirname(dst));
}
function syncDir(dir) { let fd; try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); } catch (e) { if (!['EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM', 'ENOSYS', 'EBADF'].includes(e.code)) throw e; } finally { if (fd != null) try { fs.closeSync(fd); } catch {} } }

module.exports = {
  CHUNK, DEFAULT_LOGN, LOGN_MIN, LOGN_MAX, ERR,
  newKeyPair, publicFromPrivate, keyIdFor, encodeRecipient, decodeRecipient, encodeIdentity, decodeIdentity,
  makeEnvelope, openEnvelope, infoStanza, readInfo, unlockWith, readHeader, rewriteHeader, originKeyFrom, checkOrigin, syncDir,
  createEncryptStream: (opts) => new EncryptStream(opts),
  createDecryptStream: (opts) => new DecryptStream(opts),
  _test: { parseHeader, encodeHeader, bech32Encode, bech32Decode, unwrapX25519, chunkNonce },
};
