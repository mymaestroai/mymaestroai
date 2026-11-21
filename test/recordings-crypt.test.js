'use strict';
// Encryption of call recordings (lib/recordings/crypt.js).
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { deriveKey, seal, open } = require('../lib/recordings/crypt');

const KEY = deriveKey(Buffer.alloc(32, 7));
const AAD = 'biographer/20261113-214700-a1b2c3/0001-person.flac.enc';
const refused = (fn) => assert.throws(fn, (e) => e.code === 'bad_recording_file');

test('deriveKey is 32 bytes, deterministic, and matches HKDF-SHA256', () => {
  assert.strictEqual(KEY.length, 32);
  assert.ok(KEY.equals(deriveKey(Buffer.alloc(32, 7))));
  assert.ok(!KEY.equals(deriveKey(Buffer.alloc(32, 8))));
  assert.ok(KEY.equals(Buffer.from(crypto.hkdfSync('sha256', Buffer.alloc(32, 7), Buffer.from('mymaestro'), Buffer.from('call recordings v1'), 32))));
  assert.throws(() => deriveKey(Buffer.alloc(31)));
  assert.throws(() => deriveKey('x'.repeat(32)));
});

test('round trip, with the documented layout', () => {
  const plain = crypto.randomBytes(5000);
  const s = seal(KEY, plain, AAD);
  assert.strictEqual(s.toString('latin1', 0, 6), 'MMREC1');
  assert.strictEqual(s[6], 1);
  assert.strictEqual(s.length, 6 + 1 + 12 + plain.length + 16);
  assert.ok(open(KEY, s, AAD).equals(plain));
  assert.ok(open(KEY, seal(KEY, Buffer.alloc(0), AAD), AAD).equals(Buffer.alloc(0)));
});

test('the wrong key, wrong aad, a flipped bit, wrong magic or version and truncation are refused', () => {
  const s = seal(KEY, Buffer.from('hello recordings'), AAD);
  refused(() => open(deriveKey(Buffer.alloc(32, 9)), s, AAD));
  refused(() => open(KEY, s, AAD.replace('0001', '0002')));
  for (const at of [0, 6, 7, 19, s.length - 17, s.length - 1]) {
    const b = Buffer.from(s); b[at] ^= 1;
    refused(() => open(KEY, b, AAD));
  }
  refused(() => open(KEY, s.subarray(0, s.length - 1), AAD));
  refused(() => open(KEY, s.subarray(0, 20), AAD));
  refused(() => open(KEY, Buffer.alloc(0), AAD));
});

test('two seals of the same input differ', () => {
  const a = seal(KEY, Buffer.from('same'), AAD), b = seal(KEY, Buffer.from('same'), AAD);
  assert.ok(!a.equals(b));
  assert.ok(open(KEY, a, AAD).equals(open(KEY, b, AAD)));
});
