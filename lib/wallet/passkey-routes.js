'use strict';
// HTTP routes for unlocking the wallet keystore with a passkey (Face ID, fingerprint, screen lock).
// server.js passes ownerBrowser = true only for a signed-in admin's own browser session.
// Nothing secret (passphrase, PRF output, clientData, authenticatorData, signatures) goes into audits, logs or errors.

const crypto = require('crypto');
const pk = require('./passkey');

const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_MAX = 10;
const TIMEOUT_MS = 120000;
const RP_NAME = 'My Maestro AI';
const PREFIX = '/api/wallet/passkey/';

function fail(status, code, error) {
  const err = new Error(error);
  err.status = status;
  err.code = code;
  return err;
}

const expired = () => fail(400, 'expired', 'That request expired. Start again.');
const mismatch = () => fail(400, 'mismatch', 'The passkey answer does not match this request.');
const wrongPassphrase = () => fail(401, 'wrong_passphrase', 'Wrong passphrase.');

function createPasskeyRoutes({ svc, getSetting, challenges = pk.getChallenges(), now = Date.now, log = console, walletAgents = null, notify = () => {} }) {
  // user id -> timestamps of failures; one counter for passphrase tries, one for unlock tries
  const counters = { passphrase: new Map(), unlock: new Map() };

  function recentFailures(kind, userId) {
    const failures = counters[kind];
    const t = now();
    const list = (failures.get(userId) || []).filter((x) => t - x < FAIL_WINDOW_MS);
    if (list.length) failures.set(userId, list);
    else failures.delete(userId);
    return list.length;
  }
  function countFailure(kind, userId) {
    recentFailures(kind, userId);
    const failures = counters[kind];
    const list = failures.get(userId) || [];
    list.push(now());
    failures.set(userId, list);
  }
  function sendNotice(payload) {
    try {
      const p = notify(payload);
      if (p && typeof p.catch === 'function') p.catch((e) => log.warn(`[wallet] passkey notice failed: ${e && e.message}`));
    } catch (e) {
      log.warn(`[wallet] passkey notice failed: ${e && e.message}`);
    }
  }
  function guardFailures(kind, userId) {
    if (recentFailures(kind, userId) >= FAIL_MAX) {
      throw fail(429, 'too_many', 'Too many failed tries. Wait 15 minutes, or use the passphrase.');
    }
  }

  function status() {
    const base = svc.status();
    return {
      ...base,
      keystore: { ...base.keystore, passkeys: svc.keystore.passkeys() },
      lockedNotice: getSetting('walletLockedNotice') !== false,
      walletAgents: (walletAgents || require('./tools').walletAgents)(),
    };
  }

  const slotsFor = (rpId) => svc.keystore.passkeys().filter((p) => p.rpId === rpId);
  const saltB64u = (hex) => pk.b64u(Buffer.from(String(hex), 'hex'));

  function audit(action, params, result) {
    try { svc.audit('owner', action, params, result); } catch (e) { log.warn(`[wallet] audit failed: ${e.message}`); }
  }

  async function options({ body, user, userId, rpId, origin }) {
    const purpose = body.purpose;
    if (purpose === 'register') {
      if (!svc.keystore.verify(String(body.passphrase || ''))) {
        countFailure('passphrase', userId);
        audit('PASSKEY_ADDED', { rpId }, { ok: false, error: 'Wrong passphrase.' });
        throw wrongPassphrase();
      }
      const salt = crypto.randomBytes(32);
      const challenge = challenges.issue({ purpose: 'register', userId, rpId, origin, data: { salt: salt.toString('hex') } });
      return {
        challenge,
        rp: { id: rpId, name: RP_NAME },
        user: { id: pk.b64u(crypto.randomBytes(16)), name: String(user.login || user.email || user.name || 'owner'), displayName: 'My Maestro wallet' },
        pubKeyCredParams: [-7, -8, -257].map((alg) => ({ type: 'public-key', alg })),
        timeout: TIMEOUT_MS,
        attestation: 'none',
        authenticatorSelection: { residentKey: 'preferred', requireResidentKey: false, userVerification: 'required' },
        excludeCredentials: slotsFor(rpId).map((p) => ({ type: 'public-key', id: p.id })),
        prfSalt: pk.b64u(salt),
      };
    }
    if (purpose === 'confirm') {
      const rec = challenges.peek(String(body.registerChallenge || ''), { purpose: 'register', userId });
      if (!rec || rec.rpId !== rpId || rec.origin !== origin) throw expired();
      const challenge = challenges.issue({
        purpose: 'confirm', userId, rpId, origin,
        data: { parent: body.registerChallenge, salt: rec.data.salt },
      });
      return { challenge, rpId, timeout: TIMEOUT_MS, userVerification: 'required', prfSalt: saltB64u(rec.data.salt) };
    }
    if (purpose === 'unlock') {
      const slots = slotsFor(rpId);
      if (!slots.length) throw fail(400, 'no_passkey', 'No Face ID or fingerprint is set up for this address yet.');
      const ids = slots.map((p) => p.id);
      const challenge = challenges.issue({ purpose: 'unlock', userId, rpId, origin, data: { ids } });
      const prfSalts = {};
      for (const id of ids) prfSalts[id] = saltB64u(svc.keystore.passkey(id).salt);
      return {
        challenge, rpId, timeout: TIMEOUT_MS, userVerification: 'required',
        allowCredentials: ids.map((id) => ({ type: 'public-key', id })),
        prfSalts,
      };
    }
    throw fail(400, 'bad_input', 'Unknown request.');
  }

  async function register({ body, userId, rpId, origin }) {
    const rec = challenges.take(String(body.challenge || ''), { purpose: 'register', userId });
    if (!rec) throw expired();
    if (rec.rpId !== rpId || rec.origin !== origin) throw mismatch();
    const cred = body.credential || {};
    const alg = Number(cred.publicKeyAlgorithm);
    pk.verifyRegistration({
      id: cred.id,
      clientDataJSON: cred.clientDataJSON,
      authenticatorData: cred.authenticatorData,
      publicKey: cred.publicKey,
      alg,
      challenge: body.challenge,
      origin,
      rpId,
    });
    if (body.confirm) {
      const cf = body.confirm;
      const c = challenges.take(String(cf.challenge || ''), { purpose: 'confirm', userId });
      if (!c) throw expired();
      if (c.data.parent !== body.challenge || c.rpId !== rpId || c.origin !== origin) throw mismatch();
      pk.verifyAssertion({
        clientDataJSON: cf.clientDataJSON,
        authenticatorData: cf.authenticatorData,
        signature: cf.signature,
        publicKey: cred.publicKey,
        alg,
        challenge: cf.challenge,
        origin,
        rpId,
      });
    }
    const prf = pk.fromB64u(body.prf, { min: 32, max: 32, name: 'unlock secret' });
    let added;
    try {
      added = svc.keystore.addPasskey({
        passphrase: body.passphrase,
        id: cred.id,
        label: body.label,
        rpId,
        alg,
        publicKey: cred.publicKey,
        salt: rec.data.salt,
        prfOutput: prf,
      });
    } catch (e) {
      audit('PASSKEY_ADDED', { rpId }, { ok: false, error: e.message });
      if (e.message === 'Wrong passphrase.') {
        countFailure('passphrase', userId);
        throw wrongPassphrase();
      }
      throw fail(e.status || 400, e.code || 'bad_input', e.message);
    }
    audit('PASSKEY_ADDED', { label: added.label, rpId }, { ok: true });
    sendNotice({
      title: 'Wallet passkey added',
      body: `"${added.label}" can now unlock the wallet (${rpId}). If this wasn't you, remove it in the Wallet panel and change your password.`,
      url: '/mobile?wallet=unlock',
      tag: 'wallet-passkey',
    });
    return { added, ...status() };
  }

  async function unlock({ body, userId, rpId, origin }) {
    const rec = challenges.take(String(body.challenge || ''), { purpose: 'unlock', userId });
    if (!rec) throw expired();
    if (rec.rpId !== rpId || rec.origin !== origin) throw mismatch();
    const id = String(body.id || '');
    if (!rec.data.ids.includes(id)) throw mismatch();
    const slot = svc.keystore.passkey(id);
    if (!slot || slot.rpId !== rpId) throw mismatch();
    try {
      pk.verifyAssertion({
        clientDataJSON: body.clientDataJSON,
        authenticatorData: body.authenticatorData,
        signature: body.signature,
        publicKey: slot.publicKey,
        alg: slot.alg,
        challenge: body.challenge,
        origin,
        rpId,
      });
      const prf = pk.fromB64u(body.prf, { min: 32, max: 32, name: 'unlock secret' });
      try {
        svc.keystore.unlockWithPasskey(id, prf);
      } catch (e) {
        throw fail(401, 'no_unlock', e.message);
      }
    } catch (e) {
      countFailure('unlock', userId);
      audit('UNLOCK', { method: 'passkey', label: slot.label }, { ok: false, error: e.message });
      throw e;
    }
    audit('UNLOCK', { method: 'passkey', label: slot.label, rpId }, { ok: true });
    log.warn(`[wallet] unlocked with a passkey (${slot.label})`);
    return status();
  }

  async function remove({ body }) {
    let removed;
    try {
      removed = svc.keystore.removePasskey(String(body.id || ''));
    } catch (e) {
      throw fail(400, 'bad_input', e.message);
    }
    audit('PASSKEY_REMOVED', { label: removed.label, rpId: removed.rpId }, { ok: true });
    sendNotice({
      title: 'Wallet passkey removed',
      body: `"${removed.label}" can no longer unlock the wallet.`,
      url: '/mobile?wallet=unlock',
      tag: 'wallet-passkey',
    });
    return status();
  }

  async function handle({ pathname, method, body, origin, host, user, ownerBrowser }) {
    if (typeof pathname !== 'string' || !pathname.startsWith(PREFIX)) return null;
    try {
      if (method !== 'POST') throw fail(405, '', 'Use POST.');
      if (ownerBrowser !== true) throw fail(403, 'admin_only', 'admin_only');
      const { rpId, origin: cleanOrigin } = pk.rpFromOrigin(origin);
      if (new URL(origin).host !== String(host || '').toLowerCase()) {
        throw fail(400, 'mismatch', 'The page address does not match this server.');
      }
      if (!svc.keystore.exists()) throw fail(400, 'no_keystore', 'No wallet keystore yet.');
      body = body && typeof body === 'object' ? body : {};
      const u = user || {};
      const userId = String(u.id);
      const ctx = { body, user: u, userId, rpId, origin: cleanOrigin };
      const route = pathname.slice(PREFIX.length);
      let json;
      if (route === 'options') {
        if (body.purpose === 'register') guardFailures('passphrase', userId);
        json = await options(ctx);
      } else if (route === 'register') {
        guardFailures('passphrase', userId);
        json = await register(ctx);
      } else if (route === 'unlock') {
        guardFailures('unlock', userId);
        json = await unlock(ctx);
      } else if (route === 'remove') {
        json = await remove(ctx);
      } else {
        throw fail(404, 'not_found', 'Not found.');
      }
      return { status: 200, json };
    } catch (e) {
      const out = { error: e.message || 'Failed.' };
      if (e.code) out.code = e.code;
      return { status: Number(e.status) || 400, json: out };
    }
  }

  return { handle, status };
}

module.exports = { createPasskeyRoutes };
