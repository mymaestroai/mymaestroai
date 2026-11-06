'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pk = require('../lib/wallet/passkey');
const { Keystore } = require('../lib/wallet/keystore');
const { createPasskeyRoutes } = require('../lib/wallet/passkey-routes');

const RP = 'hub.example.ts.net';
const ORIGIN = 'https://hub.example.ts.net';
const PASS = 'correct horse battery';
const sha = (x) => crypto.createHash('sha256').update(x).digest();
const OWNER = { id: 'owner', login: 'owner@example.com', role: 'admin' };
const SAM = { id: 'sam', name: 'sam', role: 'admin' };

function makeAuthenticator(alg = -7) {
  let pair;
  if (alg === -7) pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  else if (alg === -8) pair = crypto.generateKeyPairSync('ed25519');
  else pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    alg,
    privateKey: pair.privateKey,
    credId: crypto.randomBytes(32),
    prf: crypto.randomBytes(32),
    spki: pk.b64u(pair.publicKey.export({ format: 'der', type: 'spki' })),
  };
}

function authData({ rpId = RP, at = false, credId, signCount = 0 }) {
  const flags = 0x01 | 0x04 | (at ? 0x40 : 0);
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

const clientData = (type, challenge, origin = ORIGIN) => Buffer.from(JSON.stringify({ type, challenge, origin }));

function sign(alg, privateKey, ad, cd) {
  const data = Buffer.concat([ad, sha(cd)]);
  if (alg === -7) return crypto.sign('sha256', data, { key: privateKey, dsaEncoding: 'der' });
  if (alg === -8) return crypto.sign(null, data, privateKey);
  return crypto.sign('sha256', data, privateKey);
}

function credentialFor(a, challenge) {
  return {
    id: pk.b64u(a.credId),
    clientDataJSON: pk.b64u(clientData('webauthn.create', challenge)),
    authenticatorData: pk.b64u(authData({ at: true, credId: a.credId })),
    publicKey: a.spki,
    publicKeyAlgorithm: a.alg,
  };
}

function assertionFor(a, challenge, extra = {}) {
  const ad = authData({ signCount: 5 });
  const cd = clientData('webauthn.get', challenge);
  return {
    challenge,
    clientDataJSON: pk.b64u(cd),
    authenticatorData: pk.b64u(ad),
    signature: pk.b64u(sign(a.alg, a.privateKey, ad, cd)),
    ...extra,
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkroutes-'));
  const ks = new Keystore({ file: path.join(dir, 'keystore.json'), kdf: { N: 1024, r: 8, p: 1 }, backupDir: path.join(dir, 'backups') });
  const audits = [];
  const clock = { t: 1000000 };
  const now = () => clock.t;
  const svc = {
    keystore: ks,
    status: () => ({ keystore: { exists: ks.exists(), unlocked: ks.isUnlocked() } }),
    audit: (...a) => audits.push(a),
  };
  const settings = {};
  const challenges = pk.createChallenges({ now });
  const warns = [];
  const notices = [];
  const hooks = { notify: (p) => { notices.push(p); } };
  const routes = createPasskeyRoutes({
    svc, getSetting: (k) => settings[k], challenges, now, log: { warn: (m) => warns.push(m), log() {}, error() {} }, walletAgents: () => ['trader'],
    notify: (p) => hooks.notify(p),
  });
  const call = (route, body, over = {}) => routes.handle({
    pathname: '/api/wallet/passkey/' + route, method: 'POST', body, origin: ORIGIN, host: RP, user: OWNER, ownerBrowser: true, ...over,
  });
  return { dir, ks, audits, clock, svc, settings, routes, call, warns, challenges, notices, hooks };
}

function withKeystore(env) {
  env.ks.init(PASS);
  return env;
}

// Register a passkey through the routes (PRF at create). Returns { a, res }.
async function registerPasskey(env, over = {}, user = OWNER) {
  const a = over.a || makeAuthenticator(over.alg || -7);
  const opts = await env.call('options', { purpose: 'register', passphrase: PASS }, { user });
  assert.strictEqual(opts.status, 200, JSON.stringify(opts.json));
  const res = await env.call('register', {
    passphrase: PASS, label: 'My phone', challenge: opts.json.challenge,
    credential: credentialFor(a, opts.json.challenge), prf: pk.b64u(a.prf),
  }, { user });
  return { a, res, opts };
}

test('refusals: method, owner browser, address, keystore, other paths', async () => {
  const env = setup();
  assert.strictEqual(await env.routes.handle({ pathname: '/api/wallet/status', method: 'GET' }), null);
  const get = await env.call('options', {}, { method: 'GET' });
  assert.deepStrictEqual(get, { status: 405, json: { error: 'Use POST.' } });
  const notOwner = await env.call('options', {}, { ownerBrowser: false });
  assert.strictEqual(notOwner.status, 403);
  assert.strictEqual(notOwner.json.error, 'admin_only');
  assert.strictEqual(notOwner.json.code, 'admin_only');
  const bad = await env.call('options', {}, { origin: 'http://127.0.0.1:9999', host: '127.0.0.1:9999' });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.json.code, 'bad_address');
  for (const o of ['http://localhost:9999', 'https://localhost', 'https://dev.localhost', 'http://hub.example.ts.net']) {
    const r = await env.call('options', {}, { origin: o, host: new URL(o).host });
    assert.strictEqual(r.status, 400, o);
    assert.strictEqual(r.json.code, 'bad_address', o);
  }
  const noOrigin = await env.call('options', {}, { origin: undefined });
  assert.strictEqual(noOrigin.json.code, 'bad_address');
  const other = await env.call('options', {}, { host: 'other.example.ts.net' });
  assert.strictEqual(other.status, 400);
  assert.strictEqual(other.json.code, 'mismatch');
  const none = await env.call('options', { purpose: 'unlock' });
  assert.strictEqual(none.status, 400);
  assert.strictEqual(none.json.code, 'no_keystore');
  env.ks.init(PASS);
  const unknown = await env.call('options', { purpose: 'dance' });
  assert.strictEqual(unknown.json.code, 'bad_input');
});

test('register with PRF at create: added, listed in status, audited without secrets', async () => {
  const env = withKeystore(setup());
  const { a, res, opts } = await registerPasskey(env);
  assert.strictEqual(opts.json.rp.id, RP);
  assert.strictEqual(opts.json.user.name, 'owner@example.com');
  assert.strictEqual(pk.fromB64u(opts.json.user.id).length, 16);
  const opts2 = await env.call('options', { purpose: 'register', passphrase: PASS });
  assert.notStrictEqual(opts2.json.user.id, opts.json.user.id);
  assert.deepStrictEqual(opts.json.pubKeyCredParams.map((p) => p.alg), [-7, -8, -257]);
  assert.strictEqual(opts.json.authenticatorSelection.userVerification, 'required');
  assert.deepStrictEqual(opts.json.excludeCredentials, []);
  assert.strictEqual(pk.fromB64u(opts.json.prfSalt).length, 32);
  assert.strictEqual(res.status, 200, JSON.stringify(res.json));
  assert.strictEqual(res.json.added.id, pk.b64u(a.credId));
  assert.strictEqual(res.json.added.label, 'My phone');
  assert.strictEqual(res.json.added.rpId, RP);
  assert.strictEqual(res.json.keystore.passkeys.length, 1);
  assert.deepStrictEqual(res.json.walletAgents, ['trader']);
  assert.strictEqual(res.json.lockedNotice, true);
  assert.strictEqual(env.routes.status().keystore.passkeys[0].id, pk.b64u(a.credId));
  env.settings.walletLockedNotice = false;
  assert.strictEqual(env.routes.status().lockedNotice, false);
  const added = env.audits.find((x) => x[1] === 'PASSKEY_ADDED');
  assert.ok(added);
  assert.strictEqual(added[3].ok, true);
  const json = JSON.stringify(env.audits) + JSON.stringify(env.warns);
  assert.ok(!json.includes(PASS));
  assert.ok(!json.includes(pk.b64u(a.prf)));
  assert.ok(!json.includes(a.prf.toString('hex')));
  // the same credential is excluded from the next registration and refused
  const again = await env.call('options', { purpose: 'register', passphrase: PASS });
  assert.strictEqual(again.json.excludeCredentials.length, 1);
  const dup = await env.call('register', {
    passphrase: PASS, label: 'Again', challenge: again.json.challenge,
    credential: credentialFor(a, again.json.challenge), prf: pk.b64u(a.prf),
  });
  assert.strictEqual(dup.status, 400);
  assert.match(dup.json.error, /already set up/);
});

test('register with a confirm assertion; a confirm tied to another challenge is refused', async () => {
  const env = withKeystore(setup());
  const a = makeAuthenticator(-8);
  const opts = await env.call('options', { purpose: 'register', passphrase: PASS });
  const conf = await env.call('options', { purpose: 'confirm', registerChallenge: opts.json.challenge });
  assert.strictEqual(conf.status, 200, JSON.stringify(conf.json));
  assert.strictEqual(conf.json.prfSalt, opts.json.prfSalt);
  assert.strictEqual(conf.json.rpId, RP);
  const res = await env.call('register', {
    passphrase: PASS, label: 'Laptop', challenge: opts.json.challenge,
    credential: credentialFor(a, opts.json.challenge), prf: pk.b64u(a.prf),
    confirm: assertionFor(a, conf.json.challenge),
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.json));
  assert.strictEqual(res.json.added.alg, -8);

  // confirm issued for registration one, used with registration two
  const o1 = await env.call('options', { purpose: 'register', passphrase: PASS });
  const o2 = await env.call('options', { purpose: 'register', passphrase: PASS });
  const c1 = await env.call('options', { purpose: 'confirm', registerChallenge: o1.json.challenge });
  const b = makeAuthenticator(-7);
  const bad = await env.call('register', {
    passphrase: PASS, label: 'Tablet', challenge: o2.json.challenge,
    credential: credentialFor(b, o2.json.challenge), prf: pk.b64u(b.prf),
    confirm: assertionFor(b, c1.json.challenge),
  });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(env.ks.passkeys().length, 1);

  // confirm for an unknown register challenge
  const miss = await env.call('options', { purpose: 'confirm', registerChallenge: pk.b64u(crypto.randomBytes(32)) });
  assert.strictEqual(miss.status, 400);
  assert.strictEqual(miss.json.code, 'expired');
});

test('wrong passphrase counts; ten failures block options and register only; allowed again after 15 minutes', async () => {
  const env = withKeystore(setup());
  const { a } = await registerPasskey(env);
  env.ks.lock();
  const first = await env.call('options', { purpose: 'register', passphrase: 'nope' });
  assert.strictEqual(first.status, 401);
  assert.strictEqual(first.json.error, 'Wrong passphrase.');
  for (let i = 1; i < 10; i++) {
    const r = await env.call('options', { purpose: 'register', passphrase: 'nope' });
    assert.strictEqual(r.status, 401);
  }
  const blocked = await env.call('options', { purpose: 'register', passphrase: PASS });
  assert.strictEqual(blocked.status, 429);
  assert.strictEqual(blocked.json.code, 'too_many');
  assert.strictEqual((await env.call('register', {})).status, 429);
  // unlock has its own counter: passphrase failures do not block it
  assert.notStrictEqual((await env.call('unlock', {})).status, 429);
  const uo = await env.call('options', { purpose: 'unlock' });
  assert.strictEqual(uo.status, 200);
  const id = pk.b64u(a.credId);
  const viaPasskey = await env.call('unlock', { ...assertionFor(a, uo.json.challenge), id, prf: pk.b64u(a.prf) });
  assert.strictEqual(viaPasskey.status, 200, JSON.stringify(viaPasskey.json));
  // other users are not blocked
  env.ks.lock();
  assert.strictEqual((await env.call('options', { purpose: 'register', passphrase: PASS }, { user: SAM })).status, 200);
  env.clock.t += 15 * 60 * 1000 + 1;
  const ok = await env.call('options', { purpose: 'register', passphrase: PASS });
  assert.strictEqual(ok.status, 200);
  assert.ok(a);
});

test('ten failed unlocks block unlock only, not registration', async () => {
  const env = withKeystore(setup());
  const { a } = await registerPasskey(env);
  env.ks.lock();
  const id = pk.b64u(a.credId);
  for (let i = 0; i < 10; i++) {
    const o = await env.call('options', { purpose: 'unlock' });
    const r = await env.call('unlock', { ...assertionFor(a, o.json.challenge), id, prf: pk.b64u(crypto.randomBytes(32)) });
    assert.strictEqual(r.status, 401);
  }
  const o = await env.call('options', { purpose: 'unlock' });
  const blocked = await env.call('unlock', { ...assertionFor(a, o.json.challenge), id, prf: pk.b64u(a.prf) });
  assert.strictEqual(blocked.status, 429);
  assert.strictEqual(blocked.json.code, 'too_many');
  const b = makeAuthenticator();
  const opts = await env.call('options', { purpose: 'register', passphrase: PASS });
  assert.strictEqual(opts.status, 200);
  const res = await env.call('register', {
    passphrase: PASS, label: 'Second', challenge: opts.json.challenge,
    credential: credentialFor(b, opts.json.challenge), prf: pk.b64u(b.prf),
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.json));
  env.clock.t += 15 * 60 * 1000 + 1;
  const o2 = await env.call('options', { purpose: 'unlock' });
  const good = await env.call('unlock', { ...assertionFor(a, o2.json.challenge), id, prf: pk.b64u(a.prf) });
  assert.strictEqual(good.status, 200);
});

test('admins are told when a passkey is added or removed; a failing notify never changes the reply', async () => {
  const env = withKeystore(setup());
  const { a, res } = await registerPasskey(env);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(env.notices.length, 1);
  assert.deepStrictEqual(env.notices[0], {
    title: 'Wallet passkey added',
    body: `"My phone" can now unlock the wallet (${RP}). If this wasn't you, remove it now in the Wallet: whoever added it knows your wallet passphrase.`,
    url: '/mobile?wallet=unlock',
    tag: 'wallet-passkey-added',
  });
  const removed = await env.call('remove', { id: pk.b64u(a.credId) });
  assert.strictEqual(removed.status, 200);
  assert.strictEqual(env.notices.length, 2);
  assert.deepStrictEqual(env.notices[1], {
    title: 'Wallet passkey removed',
    body: '"My phone" can no longer unlock the wallet.',
    url: '/mobile?wallet=unlock',
    tag: 'wallet-passkey-removed',
  });
  const text = JSON.stringify(env.notices);
  assert.ok(!text.includes(PASS));
  assert.ok(!text.includes(pk.b64u(a.prf)));

  env.hooks.notify = () => { throw new Error('push down'); };
  const b = await registerPasskey(env);
  assert.strictEqual(b.res.status, 200);
  env.hooks.notify = () => Promise.reject(new Error('push down'));
  const c = await registerPasskey(env);
  assert.strictEqual(c.res.status, 200);
  const rm = await env.call('remove', { id: pk.b64u(c.a.credId) });
  assert.strictEqual(rm.status, 200);
  await new Promise((r) => setImmediate(r));
  assert.ok(env.warns.some((w) => w.includes('passkey notice failed')));
});

test('register with a wrong passphrase at the final step is refused and counted', async () => {
  const env = withKeystore(setup());
  const a = makeAuthenticator();
  const opts = await env.call('options', { purpose: 'register', passphrase: PASS });
  const res = await env.call('register', {
    passphrase: 'wrong one', label: 'x', challenge: opts.json.challenge,
    credential: credentialFor(a, opts.json.challenge), prf: pk.b64u(a.prf),
  });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.json.code, 'wrong_passphrase');
  assert.strictEqual(env.ks.passkeys().length, 0);
  const refusal = env.audits.find((x) => x[1] === 'PASSKEY_ADDED' && x[3].ok === false);
  assert.ok(refusal);
  assert.ok(!JSON.stringify(env.audits).includes('wrong one'));
});

test('unlock with a passkey', async () => {
  const env = withKeystore(setup());
  const { a } = await registerPasskey(env);
  env.ks.lock();
  assert.strictEqual(env.ks.isUnlocked(), false);

  const opts = await env.call('options', { purpose: 'unlock' });
  assert.strictEqual(opts.status, 200, JSON.stringify(opts.json));
  const id = pk.b64u(a.credId);
  assert.deepStrictEqual(opts.json.allowCredentials, [{ type: 'public-key', id }]);
  assert.strictEqual(opts.json.prfSalts[id], pk.b64u(Buffer.from(env.ks.passkey(id).salt, 'hex')));

  // wrong prf
  const wrongPrf = await env.call('unlock', { ...assertionFor(a, opts.json.challenge), id, prf: pk.b64u(crypto.randomBytes(32)) });
  assert.strictEqual(wrongPrf.status, 401);
  assert.strictEqual(wrongPrf.json.code, 'no_unlock');
  assert.strictEqual(env.ks.isUnlocked(), false);

  // bad signature (signed by another key)
  const opts2 = await env.call('options', { purpose: 'unlock' });
  const other = makeAuthenticator();
  const badSig = await env.call('unlock', { ...assertionFor(other, opts2.json.challenge), id, prf: pk.b64u(a.prf) });
  assert.strictEqual(badSig.status, 401);
  assert.strictEqual(badSig.json.code, 'bad_signature');
  assert.strictEqual(env.ks.isUnlocked(), false);

  // an id that was not offered
  const opts3 = await env.call('options', { purpose: 'unlock' });
  const notOffered = await env.call('unlock', { ...assertionFor(a, opts3.json.challenge), id: pk.b64u(crypto.randomBytes(32)), prf: pk.b64u(a.prf) });
  assert.strictEqual(notOffered.status, 400);
  assert.strictEqual(notOffered.json.code, 'mismatch');

  // good
  const opts4 = await env.call('options', { purpose: 'unlock' });
  const body = { ...assertionFor(a, opts4.json.challenge), id, prf: pk.b64u(a.prf) };
  const ok = await env.call('unlock', body);
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
  assert.strictEqual(ok.json.keystore.unlocked, true);
  assert.strictEqual(env.ks.isUnlocked(), true);
  const okAudit = env.audits.filter((x) => x[1] === 'UNLOCK' && x[3].ok === true);
  assert.strictEqual(okAudit.length, 1);
  assert.deepStrictEqual(okAudit[0][2], { method: 'passkey', label: 'My phone', rpId: RP });
  assert.ok(env.warns.some((w) => w.includes('unlocked with a passkey (My phone)')));
  assert.ok(env.audits.some((x) => x[1] === 'UNLOCK' && x[3].ok === false));
  const everything = JSON.stringify(env.audits) + JSON.stringify(env.warns);
  assert.ok(!everything.includes(PASS));
  assert.ok(!everything.includes(pk.b64u(a.prf)));
  assert.ok(!everything.includes(body.signature));
  assert.ok(!everything.includes(body.clientDataJSON));
  assert.ok(!everything.includes(body.authenticatorData));

  // the challenge cannot be reused
  env.ks.lock();
  const replay = await env.call('unlock', body);
  assert.strictEqual(replay.status, 400);
  assert.strictEqual(replay.json.code, 'expired');
  assert.strictEqual(env.ks.isUnlocked(), false);

  // a failed unlock is counted: ten failures block
  for (let i = 0; i < 10; i++) {
    const o = await env.call('options', { purpose: 'unlock' });
    const r = await env.call('unlock', { ...assertionFor(a, o.json.challenge), id, prf: pk.b64u(crypto.randomBytes(32)) });
    assert.ok(r.status === 401 || r.status === 429);
  }
  const o = await env.call('options', { purpose: 'unlock' });
  assert.strictEqual((await env.call('unlock', { ...assertionFor(a, o.json.challenge), id, prf: pk.b64u(a.prf) })).status, 429);
  assert.strictEqual(env.ks.isUnlocked(), false);
});

test('unlock options for an address with no passkeys; remove', async () => {
  const env = withKeystore(setup());
  const { a } = await registerPasskey(env);
  const id = pk.b64u(a.credId);
  const elsewhere = await env.call('options', { purpose: 'unlock' }, { origin: 'https://other.example.ts.net', host: 'other.example.ts.net' });
  assert.strictEqual(elsewhere.status, 400);
  assert.strictEqual(elsewhere.json.code, 'no_passkey');

  const bad = await env.call('remove', { id: 'nope' });
  assert.strictEqual(bad.status, 400);
  const removed = await env.call('remove', { id });
  assert.strictEqual(removed.status, 200);
  assert.deepStrictEqual(removed.json.keystore.passkeys, []);
  assert.strictEqual(env.ks.passkey(id), null);
  const rem = env.audits.find((x) => x[1] === 'PASSKEY_REMOVED');
  assert.deepStrictEqual(rem[2], { label: 'My phone', rpId: RP });
  const after = await env.call('options', { purpose: 'unlock' });
  assert.strictEqual(after.status, 400);
  assert.strictEqual(after.json.code, 'no_passkey');
});

test('a challenge works only for its own purpose and its own user', async () => {
  const env = withKeystore(setup());
  const a = makeAuthenticator();
  const opts = await env.call('options', { purpose: 'register', passphrase: PASS });
  // register challenge used as an unlock challenge
  const asUnlock = await env.call('unlock', { ...assertionFor(a, opts.json.challenge), id: pk.b64u(a.credId), prf: pk.b64u(a.prf) });
  assert.strictEqual(asUnlock.json.code, 'expired');
  // another user cannot take it
  const asSam = await env.call('register', {
    passphrase: PASS, label: 'x', challenge: opts.json.challenge,
    credential: credentialFor(a, opts.json.challenge), prf: pk.b64u(a.prf),
  }, { user: SAM });
  assert.strictEqual(asSam.status, 400);
  assert.strictEqual(asSam.json.code, 'expired');
  assert.strictEqual(env.ks.passkeys().length, 0);
  // an unlock challenge used for register
  const { a: b } = await registerPasskey(env);
  const un = await env.call('options', { purpose: 'unlock' });
  const c = makeAuthenticator();
  const asReg = await env.call('register', {
    passphrase: PASS, label: 'y', challenge: un.json.challenge,
    credential: credentialFor(c, un.json.challenge), prf: pk.b64u(c.prf),
  });
  assert.strictEqual(asReg.json.code, 'expired');
  // another user's unlock challenge
  const asSam2 = await env.call('unlock', { ...assertionFor(b, un.json.challenge), id: pk.b64u(b.credId), prf: pk.b64u(b.prf) }, { user: SAM });
  assert.strictEqual(asSam2.json.code, 'expired');
  // a confirm challenge is not a register challenge
  const o = await env.call('options', { purpose: 'register', passphrase: PASS });
  const cf = await env.call('options', { purpose: 'confirm', registerChallenge: o.json.challenge });
  const asReg2 = await env.call('register', {
    passphrase: PASS, label: 'z', challenge: cf.json.challenge,
    credential: credentialFor(c, cf.json.challenge), prf: pk.b64u(c.prf),
  });
  assert.strictEqual(asReg2.json.code, 'expired');
});

test('server.js wires the passkey routes, status, setting and start-up notice', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /pathname\.startsWith\('\/api\/wallet\/passkey\/'\)/);
  assert.match(src, /passkeyRoutes\(\)\.handle\(\{[^\n]*ownerBrowser: req\.hubIdentKind === 'user' && !req\.hubPendingTotp && !req\.hubToken && !req\.hubService && access\.isAdmin\(req\.hubUser\)/);
  assert.match(src, /pathname === '\/api\/wallet\/status' && req\.method === 'GET'\) \{\s*return jsonResponse\(res, 200, passkeyRoutes\(\)\.status\(\)\)/);
  assert.match(src, /patch\.walletLockedNotice !== undefined\) patch\.walletLockedNotice = patch\.walletLockedNotice !== false/);
  assert.match(src, /require\('\.\/lib\/wallet\/locked-notice'\)\.walletLockedNotice\(/);
  assert.match(src, /LOCKED_NOTICE_DELAY_MS\)\.unref\(\)/);
  assert.match(src, /createPasskeyRoutes\(\{ svc: require\('\.\/lib\/wallet\/service'\)\.getWalletService\(\)/);
  assert.match(src, /notify: \(p\) => require\('\.\/lib\/push'\)\.getPush\(\)\.notifyEach\(p, \{ adminsOnly: true, urgency: 'high' \}\)/);
});
