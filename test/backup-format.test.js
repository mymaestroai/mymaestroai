'use strict';
// The backup file format (lib/backup/format.js): age v1 with a password-locked private key stanza and an info stanza.
// Round trips at chunk boundaries, wrong keys, tampering and truncation, header rewrites, and interop with the real
// `age` tool in both directions (skipped when age isn't installed, as on CI).
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable, Writable } = require('stream');
const fmt = require('../lib/backup/format');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-format-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const LOGN = 15;   // fast in tests; the hub uses 18
const C = fmt.CHUNK;
const hasAge = spawnSync('age', ['--version']).status === 0;

function* pieces(buf, n) { for (let i = 0; i < buf.length; i += n) yield buf.subarray(i, i + n); if (!buf.length) yield Buffer.alloc(0); }
const sink = (arr) => new Writable({ write(c, _e, cb) { arr.push(c); cb(); } });
async function encrypt(pt, pub, stanzas = []) {
  const out = [];
  await pipeline(Readable.from(pieces(pt, 7001)), fmt.createEncryptStream({ recipient: pub, stanzas }), sink(out));
  return Buffer.concat(out);
}
async function decrypt(ct, how) {
  const out = []; let header = null;
  const d = fmt.createDecryptStream({ unlock: fmt.unlockWith(how) });
  d.on('header', h => { header = h; });
  await pipeline(Readable.from(pieces(ct, 5003)), d, sink(out));
  return { pt: Buffer.concat(out), header };
}
async function setup(password = 'correct horse battery staple') {
  const kp = fmt.newKeyPair();
  const env = await fmt.makeEnvelope(password, kp.priv, { logN: LOGN });
  const info = fmt.infoStanza({ created: '2026-10-29T07:30:00.000Z', version: '5.8.1', agents: 3 });
  return { ...kp, env, info, password, identity: fmt.encodeIdentity(kp.priv) };
}

test('keys: bech32 round trips, and an identity from age-keygen gives the same public key age printed', () => {
  const kp = fmt.newKeyPair();
  assert.match(fmt.encodeRecipient(kp.pub), /^age1[02-9ac-hj-np-z]{58}$/);
  assert.match(fmt.encodeIdentity(kp.priv), /^AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}$/);
  assert.deepStrictEqual(fmt.decodeRecipient(fmt.encodeRecipient(kp.pub)), kp.pub);
  assert.deepStrictEqual(fmt.decodeIdentity(fmt.encodeIdentity(kp.priv)), kp.priv);
  assert.deepStrictEqual(fmt.publicFromPrivate(kp.priv), kp.pub);
  assert.throws(() => fmt.decodeIdentity(fmt.encodeIdentity(kp.priv).slice(0, -1) + 'Q'), /not a recovery key|not valid/);
  if (hasAge) {
    const r = spawnSync('age-keygen', [], { encoding: 'utf8' });
    const pub = /public key: (age1\S+)/.exec(r.stdout + r.stderr)[1];
    assert.strictEqual(fmt.encodeRecipient(fmt.publicFromPrivate(fmt.decodeIdentity(r.stdout))), pub);
  }
});

test('round trips at chunk boundaries, with the password and with the recovery key', async () => {
  const k = await setup();
  for (const n of [0, 1, C - 1, C, C + 1, 2 * C, 3 * C + 5, 300000]) {
    const pt = require('crypto').randomBytes(n);
    const ct = await encrypt(pt, k.pub, [k.env, k.info]);
    const a = await decrypt(ct, { password: k.password });
    assert.ok(a.pt.equals(pt), `password, ${n} bytes`);
    assert.strictEqual(a.header.info.version, '5.8.1');
    const b = await decrypt(ct, { recoveryKey: k.identity });
    assert.ok(b.pt.equals(pt), `recovery key, ${n} bytes`);
  }
});

test('a wrong password or recovery key is refused; the labels read without any password', async () => {
  const k = await setup();
  const ct = await encrypt(Buffer.from('secret settings'), k.pub, [k.env, k.info]);
  await assert.rejects(decrypt(ct, { password: 'wrong password!!' }), (e) => e.code === 'EPASSWORD' && /does not open/.test(e.message));
  await assert.rejects(decrypt(ct, { recoveryKey: fmt.encodeIdentity(fmt.newKeyPair().priv) }), (e) => e.code === 'EKEY');
  const file = path.join(TMP, 'labels.age');
  fs.writeFileSync(file, ct);
  const h = await fmt.readHeader(file);
  assert.strictEqual(h.info.agents, 3);
  assert.strictEqual(h.keyId, fmt.keyIdFor(k.pub));
  // no envelope: the password route says to use the recovery key
  const bare = await encrypt(Buffer.from('x'), k.pub, [k.info]);
  await assert.rejects(decrypt(bare, { password: k.password }), (e) => e.code === 'ENOPW');
});

test('tampering anywhere and truncation at any point are refused', async () => {
  const k = await setup();
  const pt = require('crypto').randomBytes(2 * C);
  const ct = await encrypt(pt, k.pub, [k.env, k.info]);
  const hdrLen = ct.indexOf('\n', ct.indexOf('---')) + 1;
  const flip = (i) => { const b = Buffer.from(ct); b[i] ^= 0x01; return b; };
  await assert.rejects(decrypt(flip(hdrLen + 16 + 100), { password: k.password }), /cut off or damaged/);       // payload
  await assert.rejects(decrypt(flip(ct.length - 3), { password: k.password }), /cut off or damaged/);           // last tag
  // a changed info label: rewrite one base64 character of its body
  const infoAt = ct.indexOf('-> mymaestro-info\n') + '-> mymaestro-info\n'.length;
  const b = Buffer.from(ct); b[infoAt + 2] = b[infoAt + 2] === 0x41 ? 0x42 : 0x41;
  await assert.rejects(decrypt(b, { password: k.password }), /cut off or damaged|not a My Maestro backup/);
  await assert.rejects(decrypt(ct.subarray(0, ct.length - 10), { password: k.password }), /cut off or damaged/);
  await assert.rejects(decrypt(ct.subarray(0, hdrLen + 16 + C + 16), { password: k.password }), /cut off or damaged/);  // whole last chunk gone
  await assert.rejects(decrypt(Buffer.concat([ct, Buffer.from('more')]), { password: k.password }), /cut off or damaged/);
  await assert.rejects(decrypt(ct.subarray(0, hdrLen + 10), { password: k.password }), /cut off or damaged/);
  await assert.rejects(decrypt(ct.subarray(0, 40), { password: k.password }), /not a My Maestro backup/);
});

test('malformed headers are refused before any work', () => {
  const { parseHeader } = fmt._test;
  const ok = 'age-encryption.org/v1\n-> X25519 AAAA\nAAAA\n--- ' + 'A'.repeat(43) + '\n';
  assert.ok(parseHeader(Buffer.from(ok)));
  assert.throws(() => parseHeader(Buffer.from(ok.replace('v1', 'v2'))), /not a My Maestro backup/);
  assert.throws(() => parseHeader(Buffer.from(ok.replace('-> X25519 AAAA\nAAAA', '-> X25519 AAAA\nAAA='))), /not a My Maestro backup/);   // padded
  assert.throws(() => parseHeader(Buffer.from(ok.replace('-> X25519 AAAA\nAAAA', '-> X25519 AAAA\n' + 'A'.repeat(65)))), /not a My Maestro backup/);
  let many = 'age-encryption.org/v1\n'; for (let i = 0; i < 40; i++) many += '-> x\n\n';
  assert.throws(() => parseHeader(Buffer.from(many + '--- ' + 'A'.repeat(43) + '\n')), /not a My Maestro backup/);
  assert.throws(() => parseHeader(Buffer.alloc(70 * 1024, 0x41)), /not a My Maestro backup/);
  assert.strictEqual(parseHeader(Buffer.from('age-encryption.org/v1\n-> X25519 AAAA\n')), null);   // just not complete yet
});

test('password settings outside the allowed range are refused', async () => {
  const kp = fmt.newKeyPair();
  await assert.rejects(fmt.makeEnvelope('pw', kp.priv, { logN: 14 }));
  await assert.rejects(fmt.makeEnvelope('pw', kp.priv, { logN: 21 }));
  const env = await fmt.makeEnvelope('pw', kp.priv, { logN: LOGN });
  await assert.rejects(fmt.openEnvelope({ ...env, args: [env.args[0], env.args[1], '22'] }, 'pw'));
  assert.strictEqual(await fmt.openEnvelope(env, 'not it'), null);
  assert.deepStrictEqual(await fmt.openEnvelope(env, 'pw'), kp.priv);
});

test('a password change rewrites only the header; the old password stops working, the recovery key still opens it', async () => {
  const k = await setup('first password one');
  const pt = require('crypto').randomBytes(C + 777);
  const file = path.join(TMP, 'rewrite.age');
  fs.writeFileSync(file, await encrypt(pt, k.pub, [k.env, k.info]));
  const before = fs.readFileSync(file);
  const env2 = await fmt.makeEnvelope('second password two', k.priv, { logN: LOGN });
  await fmt.rewriteHeader(file, file, k.priv, { envelope: env2 });
  const after = fs.readFileSync(file);
  const tail = (b) => b.subarray(b.indexOf('\n', b.indexOf('---')) + 1);
  assert.ok(tail(before).equals(tail(after)), 'payload bytes unchanged');
  assert.ok((await decrypt(after, { password: 'second password two' })).pt.equals(pt));
  await assert.rejects(decrypt(after, { password: 'first password one' }), (e) => e.code === 'EPASSWORD');
  assert.ok((await decrypt(after, { recoveryKey: k.identity })).pt.equals(pt));
  assert.strictEqual((await fmt.readHeader(file)).info.version, '5.8.1', 'labels kept');
  assert.deepStrictEqual(fs.readdirSync(TMP).filter(f => f.includes('.rewrite-')), [], 'no temp file left');
  await assert.rejects(fmt.rewriteHeader(file, file, fmt.newKeyPair().priv, { envelope: env2 }), (e) => e.code === 'EKEY');
});

test('interop: the stock age tool opens our backups with the recovery key, and we open files age made', { skip: !hasAge && 'age is not installed' }, async () => {
  const k = await setup();
  const idFile = path.join(TMP, 'id.txt');
  fs.writeFileSync(idFile, `# recovery key\n${k.identity}\n`, { mode: 0o600 });
  for (const n of [0, C, C + 1, 200000]) {
    const pt = require('crypto').randomBytes(n);
    const file = path.join(TMP, `ours-${n}.age`);
    fs.writeFileSync(file, await encrypt(pt, k.pub, [k.env, k.info]));
    const r = spawnSync('age', ['-d', '-i', idFile, file], { maxBuffer: 1 << 26 });
    assert.strictEqual(r.status, 0, `age -d failed for ${n} bytes: ${r.stderr}`);
    assert.ok(r.stdout.equals(pt), `age output matches for ${n} bytes`);
    const theirs = path.join(TMP, `theirs-${n}.age`);
    const e = spawnSync('age', ['-r', fmt.encodeRecipient(k.pub), '-o', theirs], { input: pt });
    assert.strictEqual(e.status, 0, String(e.stderr));
    assert.ok((await decrypt(fs.readFileSync(theirs), { recoveryKey: k.identity })).pt.equals(pt), `ours opens age's ${n} bytes`);
  }
  const t = fs.readFileSync(path.join(TMP, 'ours-200000.age'));
  const bad = path.join(TMP, 'bad.age'); const b = Buffer.from(t); b[b.length - 5] ^= 1; fs.writeFileSync(bad, b);
  assert.notStrictEqual(spawnSync('age', ['-d', '-i', idFile, bad]).status, 0, 'age also refuses a damaged file');
});
