#!/usr/bin/env node
'use strict';
/**
 * wallet-recover.js — get the trading wallets' keys back out of a keystore file WITHOUT the hub.
 *
 *   node scripts/wallet-recover.js [path/to/wallet-keystore.json]
 *
 * Default path: data/wallet-keystore.json next to this checkout. Prompts for the passphrase
 * (not echoed), then prints every wallet's address, private key and, when stored, seed phrase.
 * Needs only Node's built-in crypto. If viem is installed the address is re-derived from the
 * key and checked against the file, so a wrong or corrupted record is flagged, never trusted.
 *
 * Run it only on a machine you trust, and clear the terminal afterwards.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const CHECK_PLAINTEXT = 'agent-hub-wallet-keystore-v1';

function decrypt(key, rec, aad) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(rec.iv, 'hex'));
  d.setAAD(Buffer.from(aad)); d.setAuthTag(Buffer.from(rec.tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(rec.ct, 'hex')), d.final()]).toString('utf8');
}

function askHidden(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) { const rl = readline.createInterface({ input: process.stdin }); rl.once('line', l => { rl.close(); resolve(l); }); return; }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (s) => { if (s.includes(question)) write(question); };   // echo the prompt, not the typed characters
    rl.question(question, (a) => { rl._writeToOutput = write; rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

async function main() {
  const file = path.resolve(process.argv[2] || path.join(__dirname, '..', 'data', 'wallet-keystore.json'));
  if (!fs.existsSync(file)) { console.error(`No keystore at ${file}`); process.exit(2); }
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (doc.version !== 1 || !doc.kdf || !doc.check) { console.error('Not an My Maestro AI wallet keystore (version 1).'); process.exit(2); }
  console.log(`Keystore: ${file}\nWallets: ${doc.wallets.length}`);
  const passphrase = process.env.WALLET_PASSPHRASE || await askHidden('Keystore passphrase: ');
  const key = crypto.scryptSync(String(passphrase), Buffer.from(doc.kdf.salt, 'hex'), 32, { N: doc.kdf.N, r: doc.kdf.r, p: doc.kdf.p, maxmem: 256 * 1024 * 1024 });
  let ok = false; try { ok = decrypt(key, doc.check, 'check') === CHECK_PLAINTEXT; } catch { ok = false; }
  if (!ok) { console.error('Wrong passphrase.'); process.exit(1); }
  let addressOf = null; try { addressOf = require('viem/accounts').privateKeyToAccount; } catch { /* print without the check */ }
  let bad = 0;
  for (const w of doc.wallets) {
    console.log(`\n== ${w.name}  (${w.source || 'generated'}${w.path ? ', ' + w.path : ''})\n   address in file: ${w.address}`);
    try {
      const pk = decrypt(key, w.enc, `wallet:${w.name}`);
      if (addressOf) { const derived = addressOf(pk).address; if (derived.toLowerCase() !== String(w.address).toLowerCase()) { bad++; console.log(`   !! key derives ${derived}, NOT the address in the file`); } else console.log('   address check:   ok'); }
      console.log(`   private key:     ${pk}`);
      if (w.seed) console.log(`   seed phrase:     ${decrypt(key, w.seed, `seed:${w.name}`)}`);
    } catch (e) { bad++; console.log(`   !! could not decrypt this record: ${e.message}`); }
  }
  key.fill(0);
  console.log(bad ? `\n${bad} record(s) had problems.` : '\nAll records decrypted. Clear this terminal when you are done.');
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
