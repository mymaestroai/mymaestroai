'use strict';
/**
 * backup/keys.js — the backup key. Setup makes an X25519 key pair; Settings keeps the public key (it encrypts every
 * backup, including the nightly ones made while nobody is around) and the private key locked with the backup password
 * (the envelope, copied unchanged into every backup). The password and the unlocked private key are never stored; the
 * private key is handed out once as the recovery key.
 *
 *   status(opts)                   { configured, keyId, publicKey, createdAt }
 *   setup(password, opts)          makes the key pair; returns { keyId, recoveryKey } (show it once)
 *   current(opts)                  { pub, keyId, envelope } for writing backups, or null
 *   unlockCurrent(unlock, opts)    the private key, from the backup password or the recovery key ({ password | recoveryKey })
 *   changePassword(unlock, pw)     the same key locked with a new password (the recovery key stays valid)
 *   rotate(unlock, pw)             "the password may have leaked": a new key pair and recovery key, saved first; the old
 *                                  key is listed as retiring until its backups are re-encrypted or deleted (retire())
 *   checkPassword(pw)              throws a plain-words error for a password that is too weak
 * opts.settings: { get(), update(patch) }, by default the hub's lib/settings.
 */
const fmt = require('./format');

function hubSettings() {
  const s = require('../settings');
  return { get: () => s.get(), update: (patch) => s.updateSettings(patch) };
}
const COMMON = new Set(['password', 'passw0rd', 'letmein', 'qwerty', 'iloveyou', 'welcome', 'admin', 'changeme', 'mymaestro', 'maestro', 'monkey', 'dragon', 'football', 'baseball', 'sunshine', 'princess']);
function checkPassword(pw) {
  const s = typeof pw === 'string' ? pw : '';
  const fail = (m) => Object.assign(new Error(m), { code: 'EWEAK' });
  if (s.length < 12) throw fail('The backup password needs at least 12 characters. A few random words work well.');
  if (/^(.)\1+$/.test(s)) throw fail('The backup password can\'t be one character repeated.');
  const plain = s.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (/^\d+$/.test(plain) || /^(0123456789|1234567890|abcdefghij)/.test(plain)) throw fail('The backup password is too easy to guess. A few random words work well.');
  for (const w of COMMON) if (plain.replace(/\d+$/, '') === w || plain === w.repeat(Math.ceil(plain.length / w.length)).slice(0, plain.length)) throw fail('The backup password is too easy to guess. A few random words work well.');
}
function readKey(settings) {
  const b = (settings.get() || {}).backup;
  return b && b.key && b.key.publicKey ? b.key : null;
}
function status({ settings = hubSettings() } = {}) {
  const k = readKey(settings);
  return k ? { configured: true, keyId: k.keyId, publicKey: k.publicKey, createdAt: k.createdAt || null } : { configured: false };
}
function current({ settings = hubSettings() } = {}) {
  const k = readKey(settings);
  if (!k) return null;
  return {
    pub: fmt.decodeRecipient(k.publicKey),
    keyId: k.keyId,
    envelope: { type: 'mymaestro-pw', args: k.envelope.args.slice(), body: Buffer.from(k.envelope.body, 'base64') },
    originKey: k.originKey ? Buffer.from(k.originKey, 'base64') : null,
  };
}
const err = (m, code) => Object.assign(new Error(m), { code });
const envelopeOf = (k) => ({ type: 'mymaestro-pw', args: k.envelope.args.slice(), body: Buffer.from(k.envelope.body, 'base64') });
const savedEnvelope = (env) => ({ args: env.args, body: env.body.toString('base64') });
async function unlockCurrent({ password, recoveryKey } = {}, { settings = hubSettings() } = {}) {
  const k = readKey(settings);
  if (!k) throw err('Backups aren\'t set up yet.', 'ENOKEY');
  let priv = null;
  if (recoveryKey) { try { priv = fmt.decodeIdentity(String(recoveryKey).trim()); } catch { priv = null; } }
  else if (password) priv = await fmt.openEnvelope(envelopeOf(k), password);
  if (!priv || fmt.keyIdFor(fmt.publicFromPrivate(priv)) !== k.keyId) throw err(recoveryKey ? 'That recovery key doesn\'t belong to this backup key.' : 'That is not the current backup password.', 'EPASSWORD');
  return { priv, key: k };
}
async function changePassword(unlock, newPassword, { settings = hubSettings(), logN } = {}) {
  checkPassword(newPassword);
  const { priv, key } = await unlockCurrent(unlock, { settings });
  const env = await fmt.makeEnvelope(newPassword, priv, { keyId: key.keyId, logN });
  const prev = (settings.get() || {}).backup || {};
  settings.update({ backup: { ...prev, needsPassword: false, key: { ...key, envelope: savedEnvelope(env), passwordChangedAt: new Date().toISOString() } } });
  return { priv, envelope: env, keyId: key.keyId };
}
async function rotate(unlock, newPassword, { settings = hubSettings(), logN } = {}) {
  checkPassword(newPassword);
  const { key: old } = await unlockCurrent(unlock, { settings });
  const kp = fmt.newKeyPair();
  const keyId = fmt.keyIdFor(kp.pub);
  const env = await fmt.makeEnvelope(newPassword, kp.priv, { keyId, logN });
  const prev = (settings.get() || {}).backup || {};
  const retiring = (prev.retiring || []).filter(r => r && r.keyId !== old.keyId).concat([{ keyId: old.keyId, since: new Date().toISOString() }]);
  settings.update({ backup: { ...prev, needsPassword: false, retiring, key: { publicKey: fmt.encodeRecipient(kp.pub), keyId, envelope: savedEnvelope(env), originKey: fmt.originKeyFrom(kp.priv).toString('base64'), createdAt: new Date().toISOString() } } });
  return { keyId, oldKeyId: old.keyId, recoveryKey: fmt.encodeIdentity(kp.priv) };
}
function retire(keyId, { settings = hubSettings() } = {}) {
  const prev = (settings.get() || {}).backup || {};
  const was = (prev.retiring || []).find(r => r && r.keyId === keyId);
  settings.update({ backup: { ...prev, retiring: (prev.retiring || []).filter(r => r && r.keyId !== keyId), retired: [...(prev.retired || []).filter(r => r && r.keyId !== keyId), { keyId, at: new Date().toISOString(), lost: !!(was && was.lost) }] } });   // kept for good: a restore says when a backup used a replaced key
}
async function setup(password, { settings = hubSettings(), logN } = {}) {
  checkPassword(password);
  const kp = fmt.newKeyPair();
  const keyId = fmt.keyIdFor(kp.pub);
  const env = await fmt.makeEnvelope(password, kp.priv, { keyId, logN });
  const prev = (settings.get() || {}).backup || {};
  settings.update({ backup: { ...prev, key: { publicKey: fmt.encodeRecipient(kp.pub), keyId, envelope: { args: env.args, body: env.body.toString('base64') }, originKey: fmt.originKeyFrom(kp.priv).toString('base64'), createdAt: new Date().toISOString() } } });
  return { keyId, recoveryKey: fmt.encodeIdentity(kp.priv) };
}

module.exports = { status, setup, current, unlockCurrent, changePassword, rotate, retire, checkPassword, hubSettings };
