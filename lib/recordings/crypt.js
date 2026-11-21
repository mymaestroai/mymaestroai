'use strict';
// Encryption at rest for call recordings: AES-256-GCM with the file's relative path as additional data, so a file
// moved or renamed to another place no longer opens.
const crypto = require('crypto');

const MAGIC = Buffer.from('MMREC1', 'latin1');
const VERSION = 1;
const NONCE = 12;
const TAG = 16;
const HEADER = MAGIC.length + 1 + NONCE;

function badFile(msg) { const e = new Error(msg); e.code = 'bad_recording_file'; return e; }

function deriveKey(installKey) {
  if (!Buffer.isBuffer(installKey) || installKey.length !== 32) throw new Error('install key must be a 32-byte Buffer');
  return Buffer.from(crypto.hkdfSync('sha256', installKey, Buffer.from('mymaestro'), Buffer.from('call recordings v1'), 32));
}

function checkKey(key) { if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('key must be a 32-byte Buffer'); }

function seal(key, plaintext, aad) {
  checkKey(key);
  const nonce = crypto.randomBytes(NONCE);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(String(aad), 'utf8'));
  const body = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), nonce, body, c.getAuthTag()]);
}

function open(key, sealed, aad) {
  checkKey(key);
  if (!Buffer.isBuffer(sealed) || sealed.length < HEADER + TAG) throw badFile('recording file is too short');
  if (!sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw badFile('not a recording file');
  if (sealed[MAGIC.length] !== VERSION) throw badFile('unknown recording file version');
  const nonce = sealed.subarray(MAGIC.length + 1, HEADER);
  const tag = sealed.subarray(sealed.length - TAG);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    d.setAAD(Buffer.from(String(aad), 'utf8'));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(sealed.subarray(HEADER, sealed.length - TAG)), d.final()]);
  } catch {
    throw badFile('recording file does not open (wrong key, place or damaged)');
  }
}

module.exports = { deriveKey, seal, open };
