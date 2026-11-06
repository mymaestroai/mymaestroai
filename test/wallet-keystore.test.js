'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { Keystore } = require('../lib/wallet/keystore');
const FAST = { N: 1 << 10, r: 8, p: 1 };                       // cheap KDF so tests are quick
const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-')); return new Keystore({ file: path.join(d, 'data', 'wallet-keystore.json'), kdf: FAST, backupDir: path.join(d, 'backups') }); };
const PASS = 'correct horse battery';

describe('wallet keystore', () => {
  it('refuses weak passphrases and double init', () => {
    const ks = mk(); assert.throws(() => ks.init('short'), /at least 12/);
    ks.init(PASS); assert.throws(() => ks.init(PASS), /already exists/);
  });
  it('creates fresh keys, returns only the address, and never writes key material in the clear', () => {
    const ks = mk(); ks.init(PASS);
    const w = ks.createWallet('bot-one');
    assert.match(w.address, /^0x[0-9a-fA-F]{40}$/); assert.deepStrictEqual(Object.keys(w).sort(), ['address', 'fundingCapUsd', 'name', 'source', 'tier']);
    const raw = fs.readFileSync(ks.file, 'utf8');
    return ks.withPrivateKey('bot-one', (pk, addr) => {
      assert.match(pk, /^0x[0-9a-f]{64}$/); assert.strictEqual(addr, w.address);
      assert.ok(!raw.includes(pk.slice(2)), 'private key must not appear in the file');
      assert.strictEqual(fs.statSync(ks.file).mode & 0o777, 0o600);
    });
  });
  it('two wallets get different keys; names are validated and unique', () => {
    const ks = mk(); ks.init(PASS); const a = ks.createWallet('aa'), b = ks.createWallet('bb');
    assert.notStrictEqual(a.address, b.address);
    assert.throws(() => ks.createWallet('aa'), /already exists/); assert.throws(() => ks.createWallet('Bad Name'), /Wallet name/);
  });
  it('locked: addresses are listable, keys are not; wrong passphrase is rejected; right one works after "restart"', async () => {
    const ks = mk(); ks.init(PASS); const w = ks.createWallet('bot'); ks.lock();
    assert.deepStrictEqual(ks.list().map(x => x.address), [w.address]); assert.ok(!('enc' in ks.list()[0]));
    await assert.rejects(() => ks.withPrivateKey('bot', () => 1), /locked/);
    assert.throws(() => ks.createWallet('other'), /locked/);
    const again = new Keystore({ file: ks.file, kdf: FAST, backupDir: ks.backupDir });                  // a fresh process
    assert.strictEqual(again.isUnlocked(), false); assert.throws(() => again.unlock('wrong wrong wrong'), /Wrong passphrase/);
    again.unlock(PASS); await again.withPrivateKey('bot', (pk, addr) => assert.strictEqual(addr, w.address));
  });
  it('a tampered record fails authentication instead of yielding a wrong key', async () => {
    const ks = mk(); ks.init(PASS); ks.createWallet('bot');
    const doc = JSON.parse(fs.readFileSync(ks.file)); doc.wallets[0].enc.ct = doc.wallets[0].enc.ct.replace(/^../, 'ff'); fs.writeFileSync(ks.file, JSON.stringify(doc));
    await assert.rejects(() => ks.withPrivateKey('bot', () => 1));
  });
  it('a generated wallet comes from a fresh 12-word seed phrase that reveal() returns with the key', () => {
    const ks = mk(); ks.init(PASS); const w = ks.createWallet('gen');
    const r = ks.reveal('gen', PASS);
    assert.strictEqual(r.address, w.address); assert.strictEqual(r.mnemonic.split(' ').length, 12); assert.strictEqual(r.path, "m/44'/60'/0'/0/0");
    const { mnemonicToAccount } = require('viem/accounts');
    assert.strictEqual(mnemonicToAccount(r.mnemonic).address, w.address, 'the phrase re-derives the same account in any wallet app');
    assert.match(r.privateKey, /^0x[0-9a-f]{64}$/); assert.strictEqual(ks.list()[0].hasSeed, true);
    const raw = fs.readFileSync(ks.file, 'utf8'); assert.ok(!raw.includes(r.mnemonic.split(' ')[0] + ' '), 'phrase is not in the file in the clear');
  });
  it('imports a private key, or one account of a seed phrase without storing the phrase; rejects bad input and duplicates', () => {
    const ks = mk(); ks.init(PASS);
    const anvil = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    assert.deepStrictEqual(ks.importWallet('anvil', anvil.slice(2).toUpperCase()), { name: 'anvil', address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', source: 'imported-key', tier: 'guarded', fundingCapUsd: null });
    const phrase = 'test test test test test test test test test test test junk';
    assert.deepStrictEqual(ks.importWallet('seed-one', ' ' + phrase.toUpperCase() + '\n', { index: 1 }), { name: 'seed-one', address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', source: 'imported-seed', tier: 'guarded', fundingCapUsd: null });
    const r = ks.reveal('seed-one', PASS); assert.strictEqual(r.mnemonic, undefined, 'the imported phrase is not kept'); assert.strictEqual(r.path, "m/44'/60'/0'/0/1");
    assert.ok(!fs.readFileSync(ks.file, 'utf8').includes('junk'));
    assert.throws(() => ks.importWallet('dup', phrase, { index: 1 }), /already in the keystore as "seed-one"/);
    assert.throws(() => ks.importWallet('dup2', anvil), /already in the keystore as "anvil"/);
    assert.throws(() => ks.importWallet('bad', 'test test test test test test test test test test test test'), /Not a valid seed phrase/);
    assert.throws(() => ks.importWallet('bad', 'only five words in here now'), /neither a private key/);
    assert.throws(() => ks.importWallet('bad', ''), /Paste a private key/);
    assert.throws(() => ks.importWallet('bad', phrase, { index: -1 }), /Account index/);
    ks.lock(); assert.throws(() => ks.importWallet('x', anvil), /locked/);
  });
  it('reveal needs the passphrase every time, even while unlocked', () => {
    const ks = mk(); ks.init(PASS); ks.createWallet('bot');
    assert.throws(() => ks.reveal('bot', 'wrong wrong wrong'), /Wrong passphrase/); assert.throws(() => ks.reveal('bot', ''), /Wrong passphrase/);
    assert.throws(() => ks.reveal('nope', PASS), /No wallet named/);
    ks.lock(); assert.strictEqual(ks.reveal('bot', PASS).name, 'bot', 'works while locked: it derives from the passphrase');
  });
  it('every write leaves a dated encrypted copy in the backup directory; lastBackup reports it', () => {
    const ks = mk(); assert.strictEqual(ks.lastBackup(), null);
    ks.init(PASS); ks.createWallet('aa'); ks.createWallet('bb');
    const copies = fs.readdirSync(ks.backupDir).filter(n => /^wallet-keystore-\d{8}T\d{9}Z(-\d+)?\.json$/.test(n));
    assert.strictEqual(copies.length, 3, 'init + 2 wallets');
    assert.strictEqual(ks.lastBackup().count, 3); assert.strictEqual(fs.statSync(ks.lastBackup().file).mode & 0o777, 0o600);
    assert.strictEqual(fs.readFileSync(ks.lastBackup().file, 'utf8'), fs.readFileSync(ks.file, 'utf8'));
    const manual = ks.backup(); assert.ok(fs.existsSync(manual)); assert.strictEqual(ks.lastBackup().count, 4);
  });
  it('scripts/wallet-recover.js prints the keys from the file alone, without the hub', () => {
    const ks = mk(); ks.init(PASS); const gen = ks.createWallet('gen'); ks.importWallet('anvil', '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
    const { spawnSync } = require('child_process'); const script = path.join(__dirname, '../scripts/wallet-recover.js');
    const ok = spawnSync(process.execPath, [script, ks.file], { input: PASS + '\n', encoding: 'utf8' });
    assert.strictEqual(ok.status, 0, ok.stderr + ok.stdout);
    assert.ok(ok.stdout.includes(gen.address) && ok.stdout.includes('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'), ok.stdout);
    assert.ok(ok.stdout.includes('seed phrase:') && ok.stdout.includes('address check:   ok'), ok.stdout);
    const bad = spawnSync(process.execPath, [script, ks.file], { input: 'wrong wrong wrong\n', encoding: 'utf8' });
    assert.strictEqual(bad.status, 1); assert.match(bad.stderr, /Wrong passphrase/); assert.ok(!bad.stdout.includes('private key:'));
  });
});

describe('keystore: verify()', () => {
  it('checks a passphrase without changing the locked state', () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ksv-')); const ks = new Keystore({ file: path.join(d, 'ks.json'), kdf: { N: 1024, r: 8, p: 1 }, backupDir: path.join(d, 'bk') });
    assert.strictEqual(ks.verify('anything'), false, 'no keystore yet');
    ks.init('correct horse battery'); ks.lock();
    assert.strictEqual(ks.verify('wrong passphrase!'), false);
    assert.strictEqual(ks.verify('correct horse battery'), true);
    assert.strictEqual(ks.isUnlocked(), false, 'verify never unlocks');
    ks.unlock('correct horse battery'); assert.strictEqual(ks.verify('wrong passphrase!'), false); assert.strictEqual(ks.isUnlocked(), true, 'verify never locks');
  });
});

describe('wallet keystore: passkeys (Face ID / fingerprint unlock)', () => {
  const crypto = require('crypto');
  const pub = () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const id = (n = 1) => Buffer.alloc(24, n).toString('base64url');
  const salt = () => crypto.randomBytes(32).toString('hex');
  const slot = (over = {}) => ({ passphrase: PASS, id: id(), label: 'Phone', rpId: 'hub.example.ts.net', alg: -7, publicKey: pub(), salt: salt(), prfOutput: crypto.randomBytes(32), ...over });

  it('adds a passkey with the passphrase while locked, then unlocks with its PRF output and never writes on unlock', async () => {
    const ks = mk(); ks.init(PASS); const w = ks.createWallet('bot'); ks.lock();
    const s = slot();
    assert.throws(() => ks.addPasskey({ ...s, passphrase: 'wrong wrong wrong' }), /Wrong passphrase/);
    const added = ks.addPasskey(s);
    assert.deepStrictEqual(Object.keys(added).sort(), ['alg', 'createdAt', 'id', 'label', 'rpId']);
    assert.strictEqual(ks.isUnlocked(), false, 'adding a passkey must not unlock');
    const raw = fs.readFileSync(ks.file, 'utf8');
    assert.ok(!raw.includes(s.prfOutput.toString('hex')) && !raw.includes(s.prfOutput.toString('base64url')), 'the PRF output is never stored');
    const before = fs.statSync(ks.file).mtimeMs, backups = fs.readdirSync(ks.backupDir).length;
    const again = new Keystore({ file: ks.file, kdf: FAST, backupDir: ks.backupDir });           // a fresh process
    again.unlockWithPasskey(s.id, s.prfOutput.toString('base64url'));
    assert.strictEqual(again.isUnlocked(), true);
    await again.withPrivateKey('bot', (pk, addr) => assert.strictEqual(addr, w.address));
    assert.strictEqual(fs.statSync(ks.file).mtimeMs, before); assert.strictEqual(fs.readdirSync(ks.backupDir).length, backups);
  });
  it('a wrong PRF output, an unknown passkey or a tampered entry stays locked', () => {
    const ks = mk(); ks.init(PASS); ks.lock(); const s = slot(); ks.addPasskey(s);
    assert.throws(() => ks.unlockWithPasskey(s.id, crypto.randomBytes(32)), /could not unlock/);
    assert.throws(() => ks.unlockWithPasskey(s.id, Buffer.alloc(31)), /could not unlock/);
    assert.throws(() => ks.unlockWithPasskey(id(9), s.prfOutput), /not set up/);
    const doc = JSON.parse(fs.readFileSync(ks.file, 'utf8'));
    doc.passkeys[0].wrap.ct = doc.passkeys[0].wrap.ct.replace(/^./, c => (c === '0' ? '1' : '0'));
    fs.writeFileSync(ks.file, JSON.stringify(doc));
    assert.throws(() => ks.unlockWithPasskey(s.id, s.prfOutput), /could not unlock/);
    const doc2 = JSON.parse(fs.readFileSync(ks.file, 'utf8')); doc2.passkeys[0].salt = salt(); fs.writeFileSync(ks.file, JSON.stringify(doc2));
    assert.throws(() => ks.unlockWithPasskey(s.id, s.prfOutput), /could not unlock/);
    assert.strictEqual(ks.isUnlocked(), false);
  });
  it('lists public fields only; passkey(id) adds what a signature check needs but never the wrapped key', () => {
    const ks = mk(); ks.init(PASS); const s = slot(); ks.addPasskey(s);
    const [p] = ks.passkeys();
    assert.deepStrictEqual(Object.keys(p).sort(), ['alg', 'createdAt', 'id', 'label', 'rpId']);
    const full = ks.passkey(s.id);
    assert.strictEqual(full.publicKey, s.publicKey); assert.strictEqual(full.salt, s.salt); assert.ok(!('wrap' in full));
    assert.strictEqual(ks.passkey(id(7)), null);
  });
  it('refuses duplicates, bad input and more than ten; slots survive other writes; removal works while locked', () => {
    const ks = mk(); ks.init(PASS); const s = slot(); ks.addPasskey(s);
    assert.throws(() => ks.addPasskey(s), /already set up/);
    assert.throws(() => ks.addPasskey(slot({ id: id(2), rpId: '127.0.0.1' })), /web address name/);
    assert.throws(() => ks.addPasskey(slot({ id: id(2), rpId: 'Bad Host' })), /web address name/);
    assert.throws(() => ks.addPasskey(slot({ id: id(2), rpId: 'localhost' })), /not localhost/);
    assert.throws(() => ks.addPasskey(slot({ id: id(2), rpId: 'dev.localhost' })), /not localhost/);
    assert.throws(() => ks.addPasskey(slot({ id: id(2), alg: -35 })), /signature type/);
    assert.throws(() => ks.addPasskey(slot({ id: id(2), salt: 'abc' })), /salt/);
    assert.throws(() => ks.addPasskey(slot({ id: id(2), publicKey: 'short' })), /public key/);
    assert.throws(() => ks.addPasskey(slot({ id: 'tiny' })), /unusable id/);
    assert.throws(() => ks.addPasskey(slot({ id: id(2), prfOutput: Buffer.alloc(16) })), /usable secret/);
    for (let n = 2; n <= 10; n++) ks.addPasskey(slot({ id: id(n), label: 'Device\u0007 ' + n }));
    assert.strictEqual(ks.passkeys().length, 10); assert.strictEqual(ks.passkeys()[1].label, 'Device 2');
    assert.throws(() => ks.addPasskey(slot({ id: id(11) })), /At most 10/);
    ks.createWallet('later');                                                          // another write keeps the slots
    assert.strictEqual(ks.passkeys().length, 10);
    ks.lock(); const gone = ks.removePasskey(s.id);
    assert.strictEqual(gone.id, s.id); assert.strictEqual(ks.passkeys().length, 9);
    assert.throws(() => ks.unlockWithPasskey(s.id, s.prfOutput), /not set up/);
    assert.throws(() => ks.removePasskey(s.id), /No such passkey/);
  });
  it('labels are cleaned for any page, and malformed entries in the file are skipped', () => {
    const ks = mk(); ks.init(PASS); const s = slot({ label: 'x" onmouseover=\'go()\' <b>`' }); ks.addPasskey(s);
    assert.strictEqual(ks.passkeys()[0].label, 'x onmouseover= go() b');
    const doc = JSON.parse(fs.readFileSync(ks.file, 'utf8'));
    doc.passkeys[0].label = '"><img src=x onerror=alert(1)>';
    doc.passkeys.push({ ...doc.passkeys[0], id: 'bad" id' }, { ...doc.passkeys[0], id: id(5), rpId: 'Bad Host' }, null);
    fs.writeFileSync(ks.file, JSON.stringify(doc));
    const list = ks.passkeys();
    assert.strictEqual(list.length, 1); assert.ok(!/[<>"']/.test(list[0].label));
    assert.strictEqual(ks.passkey('bad" id'), null); assert.strictEqual(ks.passkey(id(5)), null);
    assert.throws(() => ks.unlockWithPasskey(id(5), s.prfOutput), /not set up/);
  });
  it('unlocking an already unlocked keystore with a passkey changes nothing', async () => {
    const ks = mk(); ks.init(PASS); const w = ks.createWallet('bot'); const s = slot(); ks.addPasskey(s);
    ks.unlockWithPasskey(s.id, s.prfOutput);
    assert.strictEqual(ks.isUnlocked(), true);
    await ks.withPrivateKey('bot', (pk, addr) => assert.strictEqual(addr, w.address));
  });
});
