'use strict';

/**
 * keystore.js — encrypted storage for the trading wallets' private keys.
 *
 * Threat model, stated plainly: every agent on this hub has a shell running as
 * the same OS user as the hub. So the goal is NOT "an agent can never get the
 * key" (only a separate OS user or hardware signer gives that). The owner caps
 * losses by capping what each wallet holds. The goals here are the cheap,
 * high-value ones:
 *
 *   - the key is never on disk in plaintext, never in .env, never in a log,
 *     never in a conversation, and never enters any agent's context;
 *   - a copied keystore file is useless without the passphrase;
 *   - the owner can always get the keys back out (reveal, with the passphrase;
 *     scripts/wallet-recover.js offline), and every write leaves a dated copy
 *     of the file in the backup directory.
 *
 * Wallets: generated ones come from a fresh 12-word seed phrase (account 0), and
 * the phrase is stored encrypted next to the key so the owner has the easy
 * recovery form. Imported ones take a private key, or a seed phrase from which
 * ONE account is derived; the imported phrase itself is NOT stored, so a leak of
 * this file can never expose the other accounts of an owner's seed.
 *
 * Format (data/wallet-keystore.json, mode 0600):
 *   { version, kdf:{N,r,p,salt}, check:{iv,tag,ct},
 *     wallets:[{name,address,createdAt,source,path?,enc:{iv,tag,ct},seed?:{iv,tag,ct}}] }
 * Key derivation: scrypt. Encryption: AES-256-GCM, fresh IV per record, the
 * wallet name bound in as additional authenticated data ("wallet:<name>" for the
 * key, "seed:<name>" for the phrase).
 *
 * The derived key lives in memory only while unlocked; a restart locks it again.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CHECK_PLAINTEXT = 'agent-hub-wallet-keystore-v1';
const KDF = { N: 1 << 15, r: 8, p: 1 };
const MIN_PASSPHRASE = 12;
const NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;
const PK_RE = /^(0x)?[0-9a-fA-F]{64}$/;
const HD_PATH = (index) => `m/44'/60'/0'/0/${index}`;
const DEFAULT_BACKUP_DIR = path.join(require('os').homedir(), 'agent-hub', 'backups');
/** Wallet tiers: 'guarded' runs the signing firewall; 'open' runs only the theft-primitive checks. */
const TIERS = ['guarded', 'open'];
/** What the tier signature covers. Fixed at creation; there is no way to change it in place. */
const tierCanonical = w => ['agent-hub wallet tier v1', w.name, String(w.address).toLowerCase(), w.tier, String(Number(w.fundingCapUsd)), w.createdAt].join('\n');
const timingSafeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);

function encrypt(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return { iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), ct: ct.toString('hex') };
}
function decrypt(key, rec, aad) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(rec.iv, 'hex'));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(rec.tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(rec.ct, 'hex')), d.final()]).toString('utf8');
}

class Keystore {
  /**
   * @param {object} o
   * @param {string} o.file
   * @param {() => `0x${string}`} o.generateKey        injectable; defaults to viem's generatePrivateKey
   * @param {(pk:string) => string} o.addressOf         injectable; defaults to viem's privateKeyToAccount
   */
  constructor({ file, generateKey, addressOf, kdf = KDF, backupDir = process.env.HUB_WALLET_BACKUP_DIR || DEFAULT_BACKUP_DIR } = {}) {
    this.file = file;
    this.kdf = kdf;
    this.backupDir = backupDir;
    this._key = null;
    this._customGenerate = !!generateKey;
    this._generateKey = generateKey || (() => require('viem/accounts').generatePrivateKey());
    this._addressOf = addressOf || (pk => require('viem/accounts').privateKeyToAccount(pk).address);
  }

  exists() { return fs.existsSync(this.file); }
  isUnlocked() { return !!this._key; }

  _read() { return JSON.parse(fs.readFileSync(this.file, 'utf8')); }
  _write(doc) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    fs.chmodSync(this.file, 0o600);
    try { this.backup(); } catch (e) { console.warn(`[wallet] keystore backup failed: ${e.message}`); }
  }
  /**
   * Copy the (encrypted) keystore file to the backup directory with a timestamp. Called after
   * every write; the owner can also trigger it. Useless without the passphrase, so a copy can
   * live anywhere. Returns the copy's path.
   */
  backup() {
    if (!this.exists() || !this.backupDir) return null;
    fs.mkdirSync(this.backupDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[-:.]/g, '');   // 20260922T121626527Z
    let dest = path.join(this.backupDir, `wallet-keystore-${stamp}.json`);
    for (let n = 2; fs.existsSync(dest); n++) dest = path.join(this.backupDir, `wallet-keystore-${stamp}-${n}.json`);
    fs.copyFileSync(this.file, dest); fs.chmodSync(dest, 0o600);
    return dest;
  }
  /** Newest backup copy, or null. */
  lastBackup() {
    try {
      const names = fs.readdirSync(this.backupDir).filter(n => /^wallet-keystore-\d{8}T\d{9}Z(-\d+)?\.json$/.test(n)).sort();
      return names.length ? { file: path.join(this.backupDir, names[names.length - 1]), count: names.length } : null;
    } catch { return null; }
  }
  _derive(passphrase, kdf) {
    return crypto.scryptSync(String(passphrase), Buffer.from(kdf.salt, 'hex'), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 });
  }

  /** Create a new, empty keystore protected by `passphrase`, and leave it unlocked. */
  init(passphrase) {
    if (this.exists()) throw new Error('A wallet keystore already exists. Unlock it instead.');
    if (String(passphrase || '').length < MIN_PASSPHRASE) throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE} characters. It is the only thing protecting the keys at rest.`);
    const kdf = { ...this.kdf, salt: crypto.randomBytes(16).toString('hex') };
    const key = this._derive(passphrase, kdf);
    this._write({ version: 1, kdf, check: encrypt(key, CHECK_PLAINTEXT, 'check'), wallets: [] });
    this._key = key;
  }

  unlock(passphrase) {
    if (!this.exists()) throw new Error('No wallet keystore yet. Create one first.');
    const doc = this._read();
    const key = this._derive(passphrase, doc.kdf);
    try { if (decrypt(key, doc.check, 'check') !== CHECK_PLAINTEXT) throw new Error('mismatch'); }
    catch { throw new Error('Wrong passphrase.'); }
    this._key = key;
  }

  /** True if `passphrase` opens this keystore. Never changes the locked/unlocked state. */
  verify(passphrase) {
    if (!this.exists()) return false;
    const doc = this._read(); const key = this._derive(passphrase, doc.kdf);
    try { return decrypt(key, doc.check, 'check') === CHECK_PLAINTEXT; } catch { return false; } finally { key.fill(0); }
  }

  lock() { if (this._key) this._key.fill(0); this._key = null; }

  /**
   * HMAC-SHA256 of `message` under a sub-key derived from the keystore key, hex encoded.
   * Used to sign owner-added allow-list entries so that nothing which lacks the passphrase
   * (an agent's shell, an edited JSON file) can add an address the wallet may pay.
   * With `passphrase`: derives the key, checks it, signs, zeroes it (works while locked).
   * Without: uses the unlocked key; throws if locked.
   */
  hmac(message, passphrase) {
    if (!this.exists()) throw new Error('No wallet keystore yet. Create one first.');
    let key, own = false;
    if (passphrase !== undefined && passphrase !== null) {
      const doc = this._read(); key = this._derive(passphrase, doc.kdf); own = true;
      try { if (decrypt(key, doc.check, 'check') !== CHECK_PLAINTEXT) throw new Error('mismatch'); }
      catch { key.fill(0); throw new Error('Wrong passphrase.'); }
    } else {
      if (!this._key) throw new Error('Keystore is locked.');
      key = this._key;
    }
    try {
      const sub = crypto.createHmac('sha256', key).update('agent-hub wallet allow-list v1').digest();
      const mac = crypto.createHmac('sha256', sub).update(String(message)).digest('hex');
      sub.fill(0); return mac;
    } finally { if (own) key.fill(0); }
  }

  /**
   * Names and addresses only. Works while locked; never returns key material.
   * `tier` is 'guarded' (signing firewall) or 'open' (theft-primitive checks only, for
   * high-risk bots). The tier and funding cap are fixed at creation and HMAC-signed with the
   * keystore key; a record whose signature is missing or wrong is reported as guarded
   * (fail closed) with `tierVerified` false. While locked the signature cannot be checked:
   * `tierVerified` is 'locked' and the tier is still reported as guarded.
   */
  list() {
    if (!this.exists()) return [];
    return this._read().wallets.map(w => {
      const base = { name: w.name, address: w.address, createdAt: w.createdAt, source: w.source || 'generated', hasSeed: !!w.seed };
      if (!w.tier || w.tier === 'guarded') return { ...base, tier: 'guarded', fundingCapUsd: null, tierVerified: true };
      let v = 'bad';
      if (w.tierSig) {
        if (!this.isUnlocked()) v = 'locked';
        else { try { v = timingSafeEqual(Buffer.from(this.hmac(tierCanonical(w)), 'hex'), Buffer.from(String(w.tierSig), 'hex')) ? 'ok' : 'bad'; } catch { v = 'bad'; } }
      }
      if (v !== 'ok') return { ...base, tier: 'guarded', fundingCapUsd: null, tierVerified: v === 'locked' ? 'locked' : false, declaredTier: w.tier };
      return { ...base, tier: 'open', fundingCapUsd: Number(w.fundingCapUsd), tierVerified: true };
    });
  }

  _checkName(doc, name) {
    if (!this.isUnlocked()) throw new Error('Keystore is locked.');
    if (!NAME_RE.test(String(name || ''))) throw new Error('Wallet name must be 2-32 chars: lowercase letters, digits, hyphens, starting with a letter.');
    if (doc.wallets.some(w => w.name === name)) throw new Error(`A wallet named "${name}" already exists.`);
  }
  /** Validate the tier options given at creation. Returns { tier, fundingCapUsd }. */
  static tierOptions({ tier = 'guarded', fundingCapUsd = null } = {}) {
    const t = String(tier || 'guarded').toLowerCase();
    if (!TIERS.includes(t)) throw new Error(`Wallet tier must be one of ${TIERS.join(', ')}.`);
    if (t === 'guarded') {
      if (fundingCapUsd !== null && fundingCapUsd !== undefined && fundingCapUsd !== '') throw new Error('A funding cap only applies to an open wallet.');
      return { tier: 'guarded', fundingCapUsd: null };
    }
    const cap = Number(fundingCapUsd);
    if (!Number.isFinite(cap) || cap <= 0) throw new Error('An open wallet needs a funding cap in USD (a positive number, e.g. 100).');
    return { tier: 'open', fundingCapUsd: cap };
  }
  _add(doc, { name, pk, mnemonic = null, source, path: hdPath = null, tier = 'guarded', fundingCapUsd = null }) {
    const address = this._addressOf(pk);
    const dup = doc.wallets.find(w => w.address.toLowerCase() === address.toLowerCase());
    if (dup) throw new Error(`That key is already in the keystore as "${dup.name}" (${address}).`);
    const opts = Keystore.tierOptions({ tier, fundingCapUsd });
    const rec = { name, address, createdAt: new Date().toISOString(), source, enc: encrypt(this._key, pk, `wallet:${name}`) };
    if (hdPath) rec.path = hdPath;
    if (mnemonic) rec.seed = encrypt(this._key, mnemonic, `seed:${name}`);
    if (opts.tier === 'open') {
      // Signed with the keystore's HMAC sub-key like an allow-list record: editing the file
      // cannot turn a guarded wallet open. There is no setter; the tier is immutable.
      rec.tier = 'open'; rec.fundingCapUsd = opts.fundingCapUsd; rec.tierSig = this.hmac(tierCanonical(rec));
    }
    doc.wallets.push(rec);
    this._write(doc);
    return { name, address, source, tier: opts.tier, fundingCapUsd: opts.tier === 'open' ? opts.fundingCapUsd : null };
  }

  /**
   * Generate a fresh wallet. With the default generator it comes from a new 12-word seed phrase
   * (account 0, m/44'/60'/0'/0/0) that is stored encrypted so the owner can recover it in any
   * wallet app; an injected generator yields a plain standalone key. Returns the address only.
   */
  createWallet(name, { tier = 'guarded', fundingCapUsd = null } = {}) {
    const doc = this._read(); this._checkName(doc, name);
    if (this._customGenerate) return this._add(doc, { name, pk: this._generateKey(), source: 'generated', tier, fundingCapUsd });
    const { generateMnemonic, english } = require('viem/accounts');
    const mnemonic = generateMnemonic(english);
    return this._add(doc, { name, pk: fromMnemonic(mnemonic, 0), mnemonic, source: 'generated', path: HD_PATH(0), tier, fundingCapUsd });
  }

  /**
   * Import an existing key. `secret` is a 0x private key, or a BIP-39 seed phrase from which
   * account `index` (default 0, path m/44'/60'/0'/0/<index>) is derived. A seed phrase is used
   * for the derivation and then dropped: only the one derived key is stored. Returns the address.
   */
  importWallet(name, secret, { index = 0, tier = 'guarded', fundingCapUsd = null } = {}) {
    const doc = this._read(); this._checkName(doc, name);
    const text = String(secret || '').trim();
    if (!text) throw new Error('Paste a private key (64 hex characters) or a seed phrase (12 or 24 words).');
    if (PK_RE.test(text)) {
      const pk = (text.startsWith('0x') ? text : '0x' + text).toLowerCase();
      return this._add(doc, { name, pk, source: 'imported-key', tier, fundingCapUsd });
    }
    const words = text.toLowerCase().split(/\s+/);
    if (![12, 15, 18, 21, 24].includes(words.length)) throw new Error(`That is neither a private key (64 hex characters) nor a seed phrase (12 or 24 words; got ${words.length} words).`);
    const i = Number(index); if (!Number.isInteger(i) || i < 0 || i > 1000) throw new Error('Account index must be a whole number from 0 to 1000.');
    return this._add(doc, { name, pk: fromMnemonic(words.join(' '), i), source: 'imported-seed', path: HD_PATH(i), tier, fundingCapUsd });
  }

  /**
   * Hand the secrets of one wallet back to the owner. Needs the passphrase every time, whether
   * or not the keystore is unlocked: this is the one operation that puts a key on a screen.
   */
  reveal(name, passphrase) {
    if (!this.exists()) throw new Error('No wallet keystore yet.');
    const doc = this._read();
    const w = doc.wallets.find(x => x.name === name); if (!w) throw new Error(`No wallet named "${name}".`);
    const key = this._derive(passphrase, doc.kdf);
    try {
      let check; try { check = decrypt(key, doc.check, 'check'); } catch { check = null; }
      if (check !== CHECK_PLAINTEXT) throw new Error('Wrong passphrase.');
      const out = { name, address: w.address, source: w.source || 'generated', privateKey: decrypt(key, w.enc, `wallet:${name}`) };
      if (w.seed) { out.mnemonic = decrypt(key, w.seed, `seed:${name}`); out.path = w.path || HD_PATH(0); }
      else if (w.path) out.path = w.path;
      return out;
    } finally { key.fill(0); }
  }

  /**
   * Hand the private key to `fn` for the duration of one signing operation.
   * The key is never returned to the caller, so it cannot end up in a tool result.
   */
  async withPrivateKey(name, fn) {
    if (!this.isUnlocked()) throw new Error('Keystore is locked. The hub owner must unlock it from the Wallet panel.');
    const w = this._read().wallets.find(x => x.name === name);
    if (!w) throw new Error(`No wallet named "${name}".`);
    return fn(decrypt(this._key, w.enc, `wallet:${name}`), w.address);
  }
}

/** Private key (0x hex) of account `index` of a BIP-39 phrase, standard Ethereum path. Throws on a bad phrase. */
function fromMnemonic(mnemonic, index) {
  const { mnemonicToAccount, english } = require('viem/accounts');
  if (!require('@scure/bip39').validateMnemonic(mnemonic, english)) throw new Error('Not a valid seed phrase: a word is not in the BIP-39 list or the checksum fails. Check the spelling and the word order.');
  let acct; try { acct = mnemonicToAccount(mnemonic, { addressIndex: index }); } catch (e) { throw new Error(`Not a valid seed phrase: ${e.message.split('\n')[0]}`); }
  const raw = acct.getHdKey().privateKey; if (!raw) throw new Error('Seed phrase yielded no private key.');
  return '0x' + Buffer.from(raw).toString('hex');
}

module.exports = { Keystore, MIN_PASSPHRASE, NAME_RE, HD_PATH, TIERS, fromMnemonic, decrypt, CHECK_PLAINTEXT };
