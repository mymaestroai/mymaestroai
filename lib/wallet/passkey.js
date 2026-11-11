'use strict';
// WebAuthn checks for unlocking the wallet with a passkey (no packages; attestation 'none';
// we trust the browser's getPublicKey()).

const crypto = require('crypto');

function b64u(buf) {
  return Buffer.from(buf).toString('base64url');
}

function passkeyError(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function fromB64u(str, { min = 0, max = 8192, name = 'value' } = {}) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str) || str.length % 4 === 1) {
    throw passkeyError('bad_input', `Bad ${name}.`);
  }
  const buf = Buffer.from(str, 'base64url');
  if (buf.length < min || buf.length > max) throw passkeyError('bad_input', `Bad ${name}.`);
  return buf;
}

function rpFromOrigin(origin) {
  let url;
  try {
    if (typeof origin !== 'string') throw new Error('not a string');
    url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol');
  } catch (_) {
    throw passkeyError('bad_address', "This page's address can't use Face ID or fingerprint.");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith('[') || hostname.includes(':') ||
    hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.') || hostname === ''
  ) {
    throw passkeyError('bad_address', `Face ID and fingerprint work on My Maestro's secure tailnet address (https), not on ${hostname}.`);
  }
  if (url.protocol !== 'https:') {
    throw passkeyError('bad_address', "Face ID and fingerprint need My Maestro's secure (https) address.");
  }
  return { rpId: hostname, origin: url.origin };
}

function createChallenges({ now = Date.now, ttlMs = 120000, max = 200 } = {}) {
  const map = new Map();

  function sweep() {
    const t = now();
    for (const [key, rec] of map) {
      if (rec.expires <= t) map.delete(key);
    }
  }

  function matches(rec, { purpose, userId } = {}) {
    return rec.purpose === purpose && rec.userId === String(userId);
  }

  function issue({ purpose, userId, rpId, origin, data = {} }) {
    sweep();
    while (map.size >= max) {
      map.delete(map.keys().next().value);
    }
    const challenge = b64u(crypto.randomBytes(32));
    map.set(challenge, { purpose, userId: String(userId), rpId, origin, data, expires: now() + ttlMs });
    return challenge;
  }

  function peek(challenge, opts) {
    const rec = map.get(challenge);
    if (!rec || rec.expires <= now() || !matches(rec, opts)) return null;
    return { ...rec };
  }

  function take(challenge, opts) {
    const rec = map.get(challenge);
    if (!rec) return null;
    if (rec.expires <= now()) {
      map.delete(challenge);
      return null;
    }
    if (!matches(rec, opts)) return null;
    map.delete(challenge);
    return rec;
  }

  return { issue, peek, take, size: () => map.size };
}

let sharedChallenges = null;
function getChallenges() {
  if (!sharedChallenges) sharedChallenges = createChallenges();
  return sharedChallenges;
}

function parseAuthData(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 37) throw passkeyError('bad_authdata', 'Bad authenticator data.');
  const f = buf[32];
  const flags = {
    up: !!(f & 0x01),
    uv: !!(f & 0x04),
    be: !!(f & 0x08),
    bs: !!(f & 0x10),
    at: !!(f & 0x40),
    ed: !!(f & 0x80),
  };
  let credentialId = null;
  if (flags.at) {
    if (buf.length < 55) throw passkeyError('bad_authdata', 'Bad authenticator data.');
    const len = buf.readUInt16BE(53);
    if (buf.length < 55 + len) throw passkeyError('bad_authdata', 'Bad authenticator data.');
    credentialId = Buffer.from(buf.subarray(55, 55 + len));
  }
  return {
    rpIdHash: Buffer.from(buf.subarray(0, 32)),
    flags,
    signCount: buf.readUInt32BE(33),
    credentialId,
  };
}

function checkClientData(buf, { type, challenge, origin }) {
  const fail = (detail) => {
    const err = passkeyError('mismatch', 'The passkey answer does not match this request.');
    err.detail = detail;
    return err;
  };
  let c;
  try {
    c = JSON.parse(Buffer.from(buf).toString('utf8'));
  } catch (_) {
    throw fail('json');
  }
  if (!c || typeof c !== 'object') throw fail('json');
  if (c.type !== type) throw fail('type');
  if (c.challenge !== challenge) throw fail('challenge');
  if (c.origin !== origin) throw fail('origin');
  if (c.crossOrigin === true) throw fail('crossOrigin');
  return c;
}

const COSE_ALGS = { '-7': 'ES256', '-8': 'EdDSA', '-257': 'RS256' };

function publicKeyFor(spkiB64u, alg) {
  const der = fromB64u(spkiB64u, { min: 32, max: 2048, name: 'public key' });
  const bad = () => passkeyError('bad_key', 'That passkey uses a key this wallet does not accept.');
  let key;
  try {
    key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch (_) {
    throw bad();
  }
  const type = key.asymmetricKeyType;
  const details = key.asymmetricKeyDetails || {};
  if (alg === -7) {
    if (type === 'ec' && details.namedCurve === 'prime256v1') return key;
  } else if (alg === -8) {
    if (type === 'ed25519') return key;
  } else if (alg === -257) {
    if (type === 'rsa' && details.modulusLength >= 2048) return key;
  }
  throw bad();
}

function checkRpIdHash(authData, rpId) {
  const expected = crypto.createHash('sha256').update(String(rpId)).digest();
  if (!crypto.timingSafeEqual(authData.rpIdHash, expected)) {
    const err = passkeyError('mismatch', 'The passkey answer does not match this request.');
    err.detail = 'rpIdHash';
    throw err;
  }
}

function requireUv(flags) {
  if (!(flags.up && flags.uv)) {
    throw passkeyError('no_uv', 'The device did not confirm it was you (Face ID, fingerprint or screen lock).', 403);
  }
}

function verifyRegistration({ id, clientDataJSON, authenticatorData, publicKey, alg, challenge, origin, rpId }) {
  const cd = fromB64u(clientDataJSON, { max: 4096, name: 'clientDataJSON' });
  const ad = fromB64u(authenticatorData, { min: 37, max: 8192, name: 'authenticatorData' });
  checkClientData(cd, { type: 'webauthn.create', challenge, origin });
  const auth = parseAuthData(ad);
  checkRpIdHash(auth, rpId);
  requireUv(auth.flags);
  if (!auth.flags.at || !auth.credentialId) throw passkeyError('bad_authdata', 'Bad authenticator data.');
  const idBuf = fromB64u(id, { name: 'credential id' });
  if (auth.credentialId.length !== idBuf.length || !crypto.timingSafeEqual(auth.credentialId, idBuf)) {
    const err = passkeyError('mismatch', 'The passkey answer does not match this request.');
    err.detail = 'credentialId';
    throw err;
  }
  publicKeyFor(publicKey, alg);
  return { publicKey, alg, signCount: auth.signCount, flags: auth.flags };
}

function verifyAssertion({ clientDataJSON, authenticatorData, signature, publicKey, alg, challenge, origin, rpId }) {
  const cd = fromB64u(clientDataJSON, { max: 4096, name: 'clientDataJSON' });
  const ad = fromB64u(authenticatorData, { min: 37, max: 8192, name: 'authenticatorData' });
  const sig = fromB64u(signature, { min: 8, max: 1024, name: 'signature' });
  checkClientData(cd, { type: 'webauthn.get', challenge, origin });
  const auth = parseAuthData(ad);
  checkRpIdHash(auth, rpId);
  requireUv(auth.flags);
  const key = publicKeyFor(publicKey, alg);
  const data = Buffer.concat([ad, crypto.createHash('sha256').update(cd).digest()]);
  let ok = false;
  try {
    if (alg === -7) ok = crypto.verify('sha256', data, { key, dsaEncoding: 'der' }, sig);
    else if (alg === -8) ok = crypto.verify(null, data, key, sig);
    else if (alg === -257) ok = crypto.verify('sha256', data, { key, padding: crypto.constants.RSA_PKCS1_PADDING }, sig);
  } catch (_) {
    ok = false;
  }
  if (!ok) throw passkeyError('bad_signature', 'The passkey answer could not be verified.', 403);
  return { signCount: auth.signCount, flags: auth.flags };
}

module.exports = {
  b64u,
  fromB64u,
  passkeyError,
  rpFromOrigin,
  createChallenges,
  getChallenges,
  parseAuthData,
  checkClientData,
  COSE_ALGS,
  publicKeyFor,
  verifyRegistration,
  verifyAssertion,
};
