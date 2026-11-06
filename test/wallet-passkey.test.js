'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const pk = require('../lib/wallet/passkey');

const RP = 'hub.example.ts.net';
const ORIGIN = 'https://hub.example.ts.net';
const sha = (x) => crypto.createHash('sha256').update(x).digest();

function makeAuthenticator(alg) {
  let pair;
  if (alg === -7) pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  else if (alg === -8) pair = crypto.generateKeyPairSync('ed25519');
  else if (alg === 'rsa1024') pair = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  else pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    alg,
    privateKey: pair.privateKey,
    credId: crypto.randomBytes(32),
    spki: pk.b64u(pair.publicKey.export({ format: 'der', type: 'spki' })),
  };
}

function authData({ rpId = RP, up = true, uv = true, at = false, credId, signCount = 0 }) {
  const flags = (up ? 0x01 : 0) | (uv ? 0x04 : 0) | (at ? 0x40 : 0);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(signCount);
  const parts = [sha(rpId), Buffer.from([flags]), count];
  if (at) {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(credId.length);
    parts.push(Buffer.alloc(16), len, credId, Buffer.from([1, 2, 3, 4, 5]));
  }
  return Buffer.concat(parts);
}

function clientData({ type, challenge, origin = ORIGIN, crossOrigin }) {
  const o = { type, challenge, origin };
  if (crossOrigin !== undefined) o.crossOrigin = crossOrigin;
  return Buffer.from(JSON.stringify(o));
}

function sign(alg, privateKey, ad, cd) {
  const data = Buffer.concat([ad, sha(cd)]);
  if (alg === -7) return crypto.sign('sha256', data, { key: privateKey, dsaEncoding: 'der' });
  if (alg === -8) return crypto.sign(null, data, privateKey);
  return crypto.sign('sha256', data, privateKey);
}

const ALGS = [-7, -8, -257];
const CH = pk.b64u(crypto.randomBytes(32));

function regInput(a, over = {}) {
  const o = Object.assign({ type: 'webauthn.create', challenge: CH, origin: ORIGIN, rpId: RP, up: true, uv: true, at: true, credId: a.credId, id: pk.b64u(a.credId), publicKey: a.spki, alg: a.alg }, over);
  const ad = authData({ rpId: o.rpId, up: o.up, uv: o.uv, at: o.at, credId: a.credId });
  const cd = clientData({ type: o.type, challenge: o.challenge, origin: o.origin, crossOrigin: o.crossOrigin });
  return {
    id: o.id,
    clientDataJSON: pk.b64u(cd),
    authenticatorData: pk.b64u(ad),
    publicKey: o.publicKey,
    alg: o.alg,
    challenge: CH,
    origin: ORIGIN,
    rpId: RP,
  };
}

function assertInput(a, over = {}) {
  const o = Object.assign({ type: 'webauthn.get', challenge: CH, origin: ORIGIN, rpId: RP, up: true, uv: true }, over);
  const ad = authData({ rpId: o.rpId, up: o.up, uv: o.uv, signCount: 7 });
  const cd = clientData({ type: o.type, challenge: o.challenge, origin: o.origin });
  const sig = sign(a.alg, a.privateKey, ad, cd);
  return {
    clientDataJSON: pk.b64u(cd),
    authenticatorData: pk.b64u(ad),
    signature: pk.b64u(sig),
    publicKey: a.spki,
    alg: a.alg,
    challenge: CH,
    origin: ORIGIN,
    rpId: RP,
  };
}

const throwsCode = (fn, code) => assert.throws(fn, (e) => e.code === code, `expected ${code}`);

test('b64u and fromB64u round trip and refusals', () => {
  const buf = crypto.randomBytes(33);
  const s = pk.b64u(buf);
  assert.ok(!/[+/=]/.test(s));
  assert.deepStrictEqual(pk.fromB64u(s), buf);
  assert.deepStrictEqual(pk.fromB64u(pk.b64u(new Uint8Array([1, 2, 3]))), Buffer.from([1, 2, 3]));
  for (const bad of ['a+b', 'a/b', 'abcd=', null, undefined, 42, {}]) {
    throwsCode(() => pk.fromB64u(bad), 'bad_input');
  }
  throwsCode(() => pk.fromB64u(pk.b64u(Buffer.alloc(3)), { min: 4 }), 'bad_input');
  throwsCode(() => pk.fromB64u(pk.b64u(Buffer.alloc(5)), { max: 4 }), 'bad_input');
  assert.strictEqual(pk.fromB64u(pk.b64u(Buffer.alloc(4)), { min: 4, max: 4 }).length, 4);
  assert.throws(() => pk.fromB64u('+', { name: 'thing' }), /Bad thing\./);
});

test('rpFromOrigin accepts good addresses', () => {
  assert.deepStrictEqual(pk.rpFromOrigin('https://hub.example.ts.net'), { rpId: RP, origin: ORIGIN });
  assert.strictEqual(pk.rpFromOrigin('https://HUB.Example.ts.net/path').rpId, RP);
});

test('rpFromOrigin refuses bad addresses', () => {
  for (const bad of ['http://localhost:9999', 'https://localhost', 'https://dev.localhost', 'https://localhost.', 'https://hub.example.ts.net.', 'https://127.0.0.1', 'http://127.0.0.1:9999', 'https://192.168.0.10', 'http://[::1]:9999', 'http://hub.example.com', 'not a url', undefined, 'ftp://hub.example.ts.net']) {
    throwsCode(() => pk.rpFromOrigin(bad), 'bad_address');
  }
  assert.throws(() => pk.rpFromOrigin('https://192.168.0.10'), /192\.168\.0\.10/);
  assert.throws(() => pk.rpFromOrigin('https://localhost'), /secure tailnet address \(https\), not on localhost\./);
  assert.throws(() => pk.rpFromOrigin('http://hub.example.ts.net'), /need My Maestro's secure \(https\) address\./);
  assert.strictEqual(pk.passkeyError('x', 'm').status, 400);
});

test('challenges: one use, wrong purpose or user, peek, expiry, max, size', () => {
  let t = 1000;
  const c = pk.createChallenges({ now: () => t, ttlMs: 100, max: 3 });
  const base = { rpId: RP, origin: ORIGIN };
  const ch = c.issue({ purpose: 'unlock', userId: 'owner', ...base });
  assert.strictEqual(c.size(), 1);
  assert.strictEqual(pk.fromB64u(ch).length, 32);
  assert.strictEqual(c.take(ch, { purpose: 'register', userId: 'owner' }), null);
  assert.strictEqual(c.take(ch, { purpose: 'unlock', userId: 'sam' }), null);
  assert.strictEqual(c.size(), 1);
  assert.strictEqual(c.peek(ch, { purpose: 'unlock', userId: 'sam' }), null);
  const p = c.peek(ch, { purpose: 'unlock', userId: 'owner' });
  assert.strictEqual(p.rpId, RP);
  assert.strictEqual(c.size(), 1);
  const rec = c.take(ch, { purpose: 'unlock', userId: 'owner' });
  assert.strictEqual(rec.origin, ORIGIN);
  assert.strictEqual(c.size(), 0);
  // replay
  assert.strictEqual(c.take(ch, { purpose: 'unlock', userId: 'owner' }), null);

  // expiry
  const e = c.issue({ purpose: 'unlock', userId: 'owner', ...base });
  t += 101;
  assert.strictEqual(c.peek(e, { purpose: 'unlock', userId: 'owner' }), null);
  assert.strictEqual(c.size(), 1);
  assert.strictEqual(c.take(e, { purpose: 'unlock', userId: 'owner' }), null);
  assert.strictEqual(c.size(), 0);

  // max drops the oldest
  const a = c.issue({ purpose: 'unlock', userId: 'owner', ...base });
  const b = c.issue({ purpose: 'unlock', userId: 'owner', ...base });
  const d = c.issue({ purpose: 'unlock', userId: 'owner', ...base });
  const f = c.issue({ purpose: 'unlock', userId: 'owner', ...base });
  assert.strictEqual(c.size(), 3);
  assert.strictEqual(c.peek(a, { purpose: 'unlock', userId: 'owner' }), null);
  for (const x of [b, d, f]) assert.ok(c.peek(x, { purpose: 'unlock', userId: 'owner' }));

  // expired entries dropped on issue
  t += 1000;
  c.issue({ purpose: 'unlock', userId: 'owner', ...base });
  assert.strictEqual(c.size(), 1);
});

test('getChallenges returns one shared instance', () => {
  assert.strictEqual(pk.getChallenges(), pk.getChallenges());
});

test('parseAuthData', () => {
  const credId = crypto.randomBytes(32);
  const p = pk.parseAuthData(authData({ at: true, credId, signCount: 258 }));
  assert.strictEqual(p.signCount, 258);
  assert.deepStrictEqual(p.credentialId, credId);
  assert.ok(p.flags.up && p.flags.uv && p.flags.at && !p.flags.ed);
  assert.deepStrictEqual(p.rpIdHash, sha(RP));
  assert.strictEqual(pk.parseAuthData(authData({})).credentialId, null);
  throwsCode(() => pk.parseAuthData(Buffer.alloc(36)), 'bad_authdata');
  const truncated = authData({ at: true, credId }).subarray(0, 60);
  throwsCode(() => pk.parseAuthData(truncated), 'bad_authdata');
});

test('checkClientData', () => {
  const ok = { type: 'webauthn.get', challenge: CH, origin: ORIGIN };
  assert.strictEqual(pk.checkClientData(clientData(ok), ok).type, 'webauthn.get');
  const cases = [
    [Buffer.from('{nope'), 'json'],
    [clientData({ ...ok, type: 'webauthn.create' }), 'type'],
    [clientData({ ...ok, challenge: 'other' }), 'challenge'],
    [clientData({ ...ok, origin: 'https://evil.example' }), 'origin'],
    [clientData({ ...ok, crossOrigin: true }), 'crossOrigin'],
  ];
  for (const [buf, detail] of cases) {
    assert.throws(() => pk.checkClientData(buf, ok), (e) => e.code === 'mismatch' && e.detail === detail);
  }
});

test('publicKeyFor', () => {
  for (const alg of ALGS) assert.ok(pk.publicKeyFor(makeAuthenticator(alg).spki, alg));
  const ed = makeAuthenticator(-8);
  const ec = makeAuthenticator(-7);
  throwsCode(() => pk.publicKeyFor(ed.spki, -7), 'bad_key');
  throwsCode(() => pk.publicKeyFor(ec.spki, -8), 'bad_key');
  throwsCode(() => pk.publicKeyFor(ec.spki, -999), 'bad_key');
  throwsCode(() => pk.publicKeyFor(pk.b64u(crypto.randomBytes(64)), -7), 'bad_key');
  throwsCode(() => pk.publicKeyFor('a+b', -7), 'bad_input');
  const p384 = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  throwsCode(() => pk.publicKeyFor(pk.b64u(p384.publicKey.export({ format: 'der', type: 'spki' })), -7), 'bad_key');
  assert.deepStrictEqual(pk.COSE_ALGS, { '-7': 'ES256', '-8': 'EdDSA', '-257': 'RS256' });
});

test('verifyRegistration passes for all algs', () => {
  for (const alg of ALGS) {
    const a = makeAuthenticator(alg);
    const r = pk.verifyRegistration(regInput(a));
    assert.strictEqual(r.alg, alg);
    assert.strictEqual(r.publicKey, a.spki);
    assert.strictEqual(r.signCount, 0);
    assert.ok(r.flags.uv && r.flags.at);
  }
});

test('verifyRegistration refusals', () => {
  const a = makeAuthenticator(-7);
  const cases = [
    ['type get', { type: 'webauthn.get' }, 'mismatch'],
    ['other challenge', { challenge: 'other' }, 'mismatch'],
    ['other origin', { origin: 'https://evil.example' }, 'mismatch'],
    ['crossOrigin', { crossOrigin: true }, 'mismatch'],
    ['other rpId', { rpId: 'evil.example' }, 'mismatch'],
    ['uv false', { uv: false }, 'no_uv'],
    ['up false', { up: false }, 'no_uv'],
    ['at false', { at: false }, 'bad_authdata'],
    ['other id', { id: pk.b64u(crypto.randomBytes(32)) }, 'mismatch'],
    ['bad id', { id: 'a+b' }, 'bad_input'],
    ['ed key as -7', { publicKey: makeAuthenticator(-8).spki }, 'bad_key'],
    ['bad base64url', { publicKey: 'a=b' }, 'bad_input'],
  ];
  for (const [name, over, code] of cases) {
    assert.throws(() => pk.verifyRegistration(regInput(a, over)), (e) => e.code === code, name);
  }
  assert.throws(() => pk.verifyRegistration(regInput(a, { uv: false })), (e) => e.status === 403);
  const rsa1024 = makeAuthenticator('rsa1024');
  throwsCode(() => pk.verifyRegistration(regInput(rsa1024, { alg: -257 })), 'bad_key');
  const bad = regInput(a);
  bad.clientDataJSON = '!!';
  throwsCode(() => pk.verifyRegistration(bad), 'bad_input');
  const bad2 = regInput(a);
  bad2.authenticatorData = pk.b64u(Buffer.alloc(10));
  throwsCode(() => pk.verifyRegistration(bad2), 'bad_input');
});

test('verifyAssertion passes for all algs', () => {
  for (const alg of ALGS) {
    const a = makeAuthenticator(alg);
    const r = pk.verifyAssertion(assertInput(a));
    assert.strictEqual(r.signCount, 7);
    assert.ok(r.flags.up && r.flags.uv);
  }
});

test('verifyAssertion refusals', () => {
  const a = makeAuthenticator(-7);
  const other = makeAuthenticator(-7);
  const good = assertInput(a);

  // flag flipped after signing (set the be bit)
  const ad = Buffer.from(pk.fromB64u(good.authenticatorData));
  ad[32] |= 0x08;
  throwsCode(() => pk.verifyAssertion({ ...good, authenticatorData: pk.b64u(ad) }), 'bad_signature');

  // clientDataJSON changed after signing (same content, extra field)
  const cd = JSON.parse(pk.fromB64u(good.clientDataJSON).toString());
  cd.extra = 1;
  throwsCode(() => pk.verifyAssertion({ ...good, clientDataJSON: pk.b64u(Buffer.from(JSON.stringify(cd))) }), 'bad_signature');

  // another key
  throwsCode(() => pk.verifyAssertion({ ...good, publicKey: other.spki }), 'bad_signature');

  // correctly signed but no UV
  assert.throws(() => pk.verifyAssertion(assertInput(a, { uv: false })), (e) => e.code === 'no_uv' && e.status === 403);
  throwsCode(() => pk.verifyAssertion(assertInput(a, { up: false })), 'no_uv');

  // mismatches
  throwsCode(() => pk.verifyAssertion(assertInput(a, { rpId: 'evil.example' })), 'mismatch');
  throwsCode(() => pk.verifyAssertion(assertInput(a, { origin: 'https://evil.example' })), 'mismatch');
  throwsCode(() => pk.verifyAssertion(assertInput(a, { type: 'webauthn.create' })), 'mismatch');
  throwsCode(() => pk.verifyAssertion(assertInput(a, { challenge: 'other' })), 'mismatch');

  // oversized
  throwsCode(() => pk.verifyAssertion({ ...good, signature: pk.b64u(Buffer.alloc(1025, 1)) }), 'bad_input');
  throwsCode(() => pk.verifyAssertion({ ...good, signature: pk.b64u(Buffer.alloc(4, 1)) }), 'bad_input');
  throwsCode(() => pk.verifyAssertion({ ...good, clientDataJSON: pk.b64u(Buffer.alloc(4097, 65)) }), 'bad_input');

  // garbage signature of valid size
  throwsCode(() => pk.verifyAssertion({ ...good, signature: pk.b64u(crypto.randomBytes(70)) }), 'bad_signature');

  // wrong alg for key
  throwsCode(() => pk.verifyAssertion({ ...good, alg: -8 }), 'bad_key');
});

test('verifyAssertion refuses tampering for EdDSA and RS256 too', () => {
  for (const alg of [-8, -257]) {
    const a = makeAuthenticator(alg);
    const good = assertInput(a);
    const ad = Buffer.from(pk.fromB64u(good.authenticatorData));
    ad[36] ^= 1;
    throwsCode(() => pk.verifyAssertion({ ...good, authenticatorData: pk.b64u(ad) }), 'bad_signature');
    throwsCode(() => pk.verifyAssertion({ ...good, publicKey: makeAuthenticator(alg).spki }), 'bad_signature');
  }
});

test('a taken challenge cannot be replayed', () => {
  const c = pk.createChallenges();
  const ch = c.issue({ purpose: 'unlock', userId: 'owner', rpId: RP, origin: ORIGIN });
  assert.ok(c.take(ch, { purpose: 'unlock', userId: 'owner' }));
  assert.strictEqual(c.take(ch, { purpose: 'unlock', userId: 'owner' }), null);
  assert.strictEqual(c.peek(ch, { purpose: 'unlock', userId: 'owner' }), null);
});
