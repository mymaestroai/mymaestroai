#!/usr/bin/env node
'use strict';
/**
 * wallet-allowlist.js — owner-only maintenance of the signing firewall's address book.
 *
 *   node scripts/wallet-allowlist.js list
 *   node scripts/wallet-allowlist.js add        --address 0x… --chain 8453 --label "Aave v3 Pool" --role contract \
 *                                              --verified-by workspaces/verifier/reports/aave-pool.md [--any-selector] [--allow-value]
 *     roles: contract (wallet calls it), token, router (wallet approves + calls it), bridge, executor (a router's
 *     helper, e.g. the Kyber executor: never called by the wallet, only accepted as a Kyber callTarget/receiver)
 *   node scripts/wallet-allowlist.js deactivate --address 0x… --chain 8453 [--reason "why"]
 *   node scripts/wallet-allowlist.js check      --from 0x… --to 0x… --chain 8453 [--value 0.01] [--data 0x…]
 *
 * Works with the hub down. Every add/deactivate is HMAC-signed with a key derived from the
 * keystore passphrase (prompted, not echoed; WALLET_PASSPHRASE env is honoured for scripting),
 * so an entry that was pasted into the file by hand, or by an agent with shell access, is
 * ignored by the firewall. Nothing is ever removed: deactivate appends a record.
 *
 * Entries cannot be edited. To change one (say, widen it with --any-selector), deactivate it,
 * then add it again: a deactivation only reaches entries added before it, and lookups use the
 * newest live entry. Seed entries can be deactivated and superseded the same way.
 *
 * Roles: contract | token | router | bridge | executor. The owner destination (settings.walletOwner)
 * is fixed in code and cannot be added, changed, or pointed elsewhere from here.
 *
 * Flags for add:
 *   --any-selector  allow ANY function on a contract/router entry, not only the functions the
 *                   firewall has decoded rules for. Needed for contracts outside the built-in
 *                   rule table. Not allowed on executor entries.
 *   --allow-value   with --any-selector, also allow ETH value on those unknown calls. Without
 *                   it, value goes only where a decoded rule permits it. Not allowed on executor.
 *
 * Files (relative to this checkout unless HUB_DATA_DIR is set):
 *   data/wallet-allowlist.json   the append-only book (this script writes it)
 *   data/wallet-keystore.json    the keystore whose passphrase signs the records (read only)
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Keystore } = require('../lib/wallet/keystore');
const { Firewall, OWNER, ROLES } = require('../lib/wallet/firewall');

const DATA_DIR = process.env.HUB_DATA_DIR || path.join(__dirname, '..', 'data');

function askHidden(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) { const rl = readline.createInterface({ input: process.stdin }); rl.once('line', l => { rl.close(); resolve(l); }); return; }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (s) => { if (s.includes(question)) write(question); };
    rl.question(question, (a) => { rl._writeToOutput = write; rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true; else { out[key] = next; i++; }
  }
  return out;
}

function usage(code = 2) {
  console.error(fs.readFileSync(__filename, 'utf8').split('\n').slice(2).join('\n').split('\n * Files')[0].split('\n').map(l => l.replace(/^ \*\/?\s?/, '')).join('\n'));
  process.exit(code);
}

function printBook(entries) {
  const rows = entries.map(e => ({
    chain: e.chainId === null || e.chainId === undefined ? 'any' : String(e.chainId),
    address: e.address, role: e.role, label: e.label,
    state: e.active ? 'active' : 'DEACTIVATED', source: e.source + (e.verified === 'locked' ? ' (UNVERIFIED: keystore locked)' : ''),
    flags: [e.weth ? 'weth' : '', e.anySelector ? 'anySelector' : '', e.allowValue ? 'allowValue' : ''].filter(Boolean).join(','),
  }));
  const cols = ['chain', 'address', 'role', 'state', 'source', 'flags', 'label'];
  const w = Object.fromEntries(cols.map(c => [c, Math.max(c.length, ...rows.map(r => String(r[c] || '').length))]));
  console.log(cols.map(c => c.padEnd(w[c])).join('  '));
  for (const r of rows) console.log(cols.map(c => String(r[c] || '').padEnd(w[c])).join('  '));
  console.log(`\n${rows.length} entries; owner destination (settings.walletOwner): ${OWNER || 'none configured'}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || args.help) usage(cmd ? 2 : 0);

  const ks = new Keystore({ file: path.join(DATA_DIR, 'wallet-keystore.json') });
  const fw = new Firewall({ file: path.join(DATA_DIR, 'wallet-allowlist.json'), keystore: ks });
  console.log(`Allow-list: ${fw.file}`);

  if (cmd === 'list') {
    // Unlock so owner-added records can be verified; without it they show as UNVERIFIED and the firewall refuses them.
    if (ks.exists() && (process.env.WALLET_PASSPHRASE || process.stdin.isTTY)) {
      const p = process.env.WALLET_PASSPHRASE || await askHidden('Keystore passphrase (Enter to skip verification): ');
      if (p) { try { ks.unlock(p); } catch (e) { console.error(`Not unlocked: ${e.message}`); } }
    }
    printBook(fw.list()); ks.lock(); return;
  }

  if (cmd === 'check') {
    const viem = require('viem');
    if (ks.exists() && (process.env.WALLET_PASSPHRASE || process.stdin.isTTY)) {
      const p = process.env.WALLET_PASSPHRASE || await askHidden('Keystore passphrase (Enter to skip verification): ');
      if (p) { try { ks.unlock(p); } catch (e) { console.error(`Not unlocked: ${e.message}`); } }
    }
    try {
      const res = fw.check({ chainId: Number(args.chain), from: args.from, to: args.to, value: args.value ? viem.parseEther(String(args.value)) : 0n, data: args.data });
      console.log(`ALLOWED: ${res.rule} -> ${res.label}${res.selector ? ' (' + res.selector + ')' : ''}`);
    } catch (e) { console.log(e.message); process.exitCode = 1; }
    ks.lock(); return;
  }

  if (cmd !== 'add' && cmd !== 'deactivate') usage();
  if (!ks.exists()) { console.error(`No keystore at ${ks.file}; the book cannot be signed without one.`); process.exit(2); }
  if (!args.address || !args.chain) usage();

  if (cmd === 'add') {
    if (!args.label || !args.role || !args.verifiedBy) usage();
    if (!ROLES.includes(args.role) || args.role === 'owner') { console.error(`--role must be one of ${ROLES.filter(r => r !== 'owner').join(', ')}`); process.exit(2); }
    if (!fs.existsSync(path.resolve(args.verifiedBy))) console.error(`WARNING: --verified-by ${args.verifiedBy} does not exist on disk; recording it anyway.`);
  }

  const passphrase = process.env.WALLET_PASSPHRASE || await askHidden('Keystore passphrase: ');
  try {
    const rec = cmd === 'add'
      ? fw.add({ address: args.address, chainId: Number(args.chain), label: args.label, role: args.role, verifiedBy: args.verifiedBy,
                 anySelector: !!args.anySelector, allowValue: !!args.allowValue, by: process.env.USER ? `owner-cli:${process.env.USER}` : 'owner-cli' }, passphrase)
      : fw.deactivate({ address: args.address, chainId: Number(args.chain), reason: args.reason || '', by: process.env.USER ? `owner-cli:${process.env.USER}` : 'owner-cli' }, passphrase);
    const { sig, ...shown } = rec;
    console.log(`${cmd === 'add' ? 'Added' : 'Deactivated'}: ${JSON.stringify(shown)}`);
    ks.unlock(passphrase); printBook(fw.list()); ks.lock();
    console.log('\nThe running hub re-reads the book on every check; no restart is needed.');
  } catch (e) { console.error(`Refused: ${e.message}`); process.exit(1); }
}

main().catch(e => { console.error(e.message); process.exit(1); });
