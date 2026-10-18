'use strict';

/**
 * Open (unguarded) wallets: a per-wallet tier chosen at creation, signed like an allow-list record.
 * A guarded wallet still runs the full signing firewall (test/wallet-firewall.test.js and
 * test/wallet-service.test.js are unchanged). An open wallet only refuses the theft primitives:
 * plain ETH / ERC-20 transfers to strangers, approvals to non-router spenders, signature-based
 * approvals, and ETH value to an address without code. Guarded -> open funding is capped in USD,
 * and pause can be per wallet.
 */
process.env.HUB_WALLET_OWNER = '0x4444444444444444444444444444444444444444';   // tests never read the install's settings
process.env.HUB_WALLET_OWNER_LABEL = 'owner.eth';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const viem = require('viem');
const { Keystore } = require('../lib/wallet/keystore');
const { WalletService, NETWORKS } = require('../lib/wallet/service');
const { OWNER, FirewallError } = require('../lib/wallet/firewall');

const PASS = 'test passphrase 123';
const ROUTER = NETWORKS.base.aggregator.router, USDC = NETWORKS.base.tokens.USDC;
const AAVE = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';            // seeded with role contract
const STRANGER = '0x1111111111111111111111111111111111111111';
const STRANGER2 = '0x2222222222222222222222222222222222222222';
const MEME_TOKEN = '0x3333333333333333333333333333333333333333';
const usdc = n => BigInt(Math.round(n * 1e6));
const erc20 = (functionName, args) => viem.encodeFunctionData({ abi: viem.erc20Abi, functionName, args });

function mkKeystore(dir) {
  const ks = new Keystore({ file: path.join(dir, 'ks.json'), kdf: { N: 1024, r: 8, p: 1 }, backupDir: path.join(dir, 'bk') });
  ks.init(PASS); return ks;
}

/** Fake chain: `codeAt` says which addresses have code; `usdcOf` the USDC balance per address; `quoteFails` breaks the USD oracle. */
function rig({ balance = 10n ** 18n, codeAt = {}, usdcOf = {}, quoteFails = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-'));
  const ks = mkKeystore(dir);
  const bot = ks.createWallet('bot');
  const meme = ks.createWallet('meme', { tier: 'open', fundingCapUsd: 100 });
  const sent = []; const state = { balance, now: 1_700_000_000_000, quotes: 0 };
  const has = (m, a) => m[String(a).toLowerCase()];
  const pub = {
    getBalance: async () => state.balance, getGasPrice: async () => 6_000_000n, estimateGas: async () => 150_000n,
    getCode: async ({ address }) => { if (codeAt.throws) throw new Error('rpc down'); return has(codeAt, address) ? '0x6001' : '0x'; },
    call: async () => ({ data: '0x' }),
    readContract: async ({ functionName, args }) => functionName === 'decimals' ? 6 : functionName === 'balanceOf' ? (has(usdcOf, args[0]) ?? 0n) : functionName === 'allowance' ? 0n : 'USDC',
    waitForTransactionReceipt: async ({ hash }) => ({ status: 'success', gasUsed: 120_000n, transactionHash: hash }),
  };
  const clientFactory = () => ({ public: pub, walletFor: () => ({ sendTransaction: async tx => { sent.push(tx); return '0x' + String(sent.length).padStart(64, 'a'); } }) });
  const fetchImpl = async (url) => {
    state.quotes++; if (quoteFails) throw new Error('Kyber down');
    const sp = new URL(url).searchParams;
    return { ok: true, json: async () => ({ code: 0, data: { routerAddress: ROUTER, routeSummary: { tokenIn: sp.get('tokenIn'), amountIn: sp.get('amountIn'), amountOut: '2760000', amountInUsd: 2.76, amountOutUsd: 2.75, gasUsd: '0.01' } } }) };
  };
  const svc = new WalletService({ dataDir: dir, keystore: ks, clientFactory, fetchImpl, now: () => state.now });
  const audit = () => fs.readFileSync(svc.auditFile, 'utf8').trim().split('\n').map(JSON.parse);
  const send = (o) => svc.sendTransaction({ agent: 'trader', wallet: 'meme', dryRun: true, ...o });
  const refused = async (o, re) => { await assert.rejects(send(o), e => { assert.ok(e instanceof FirewallError, 'FirewallError: ' + e.message); assert.ok(e.firewall); assert.match(e.message, /^REFUSED \(firewall\): /); assert.match(e.message, re); return true; }); };
  return { svc, ks, bot, meme, sent, state, audit, dir, send, refused, usdcOf };
}

describe('open wallets: tier in the keystore', () => {
  it('is chosen at creation, defaults to guarded, and shows up in list()', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-')); const ks = mkKeystore(dir);
    const g = ks.createWallet('bot'); assert.strictEqual(g.tier, 'guarded'); assert.strictEqual(g.fundingCapUsd, null);
    const o = ks.createWallet('meme', { tier: 'OPEN', fundingCapUsd: '100' }); assert.strictEqual(o.tier, 'open'); assert.strictEqual(o.fundingCapUsd, 100);
    const byName = Object.fromEntries(ks.list().map(w => [w.name, w]));
    assert.deepStrictEqual({ tier: byName.bot.tier, cap: byName.bot.fundingCapUsd, v: byName.bot.tierVerified }, { tier: 'guarded', cap: null, v: true });
    assert.deepStrictEqual({ tier: byName.meme.tier, cap: byName.meme.fundingCapUsd, v: byName.meme.tierVerified }, { tier: 'open', cap: 100, v: true });
    // Imported keys take the same options.
    const anvil = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    const imp = ks.importWallet('imp', anvil, { tier: 'open', fundingCapUsd: 25 }); assert.strictEqual(imp.tier, 'open'); assert.strictEqual(imp.fundingCapUsd, 25);
  });
  it('validates the options: unknown tier, cap on a guarded wallet, open without a cap', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-')); const ks = mkKeystore(dir);
    assert.throws(() => ks.createWallet('aa', { tier: 'yolo' }), /Wallet tier must be one of guarded, open/);
    assert.throws(() => ks.createWallet('aa', { tier: 'guarded', fundingCapUsd: 100 }), /A funding cap only applies to an open wallet/);
    assert.throws(() => ks.createWallet('aa', { tier: 'open' }), /An open wallet needs a funding cap in USD/);
    assert.throws(() => ks.createWallet('aa', { tier: 'open', fundingCapUsd: -5 }), /An open wallet needs a funding cap in USD/);
    assert.throws(() => ks.createWallet('aa', { tier: 'open', fundingCapUsd: 'lots' }), /An open wallet needs a funding cap in USD/);
    assert.strictEqual(ks.list().length, 0, 'nothing was written');
  });
  it('persists across a reopen and is immutable: no setter, and editing the file falls back to guarded', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-')); const ks = mkKeystore(dir);
    ks.createWallet('meme', { tier: 'open', fundingCapUsd: 100 }); ks.createWallet('bot');
    const again = new Keystore({ file: ks.file, kdf: { N: 1024, r: 8, p: 1 }, backupDir: path.join(dir, 'bk') });
    assert.strictEqual(again.list().find(w => w.name === 'meme').tierVerified, 'locked', 'cannot check the signature while locked');
    assert.strictEqual(again.list().find(w => w.name === 'meme').tier, 'guarded', 'locked => reported guarded (fail closed)');
    again.unlock(PASS);
    assert.deepStrictEqual(again.list().find(w => w.name === 'meme').tier, 'open');
    for (const k of ['setTier', 'setFundingCap', 'updateWallet']) assert.strictEqual(typeof again[k], 'undefined', `no ${k}() exists`);
    // Tamper 1: raise the cap in the file. Tamper 2: declare the guarded wallet open by copying the fields.
    const doc = JSON.parse(fs.readFileSync(ks.file, 'utf8'));
    const m = doc.wallets.find(w => w.name === 'meme'), b = doc.wallets.find(w => w.name === 'bot');
    m.fundingCapUsd = 1_000_000; b.tier = 'open'; b.fundingCapUsd = 100; b.tierSig = m.tierSig;
    fs.writeFileSync(ks.file, JSON.stringify(doc));
    const l = Object.fromEntries(again.list().map(w => [w.name, w]));
    assert.deepStrictEqual({ tier: l.meme.tier, cap: l.meme.fundingCapUsd, v: l.meme.tierVerified, d: l.meme.declaredTier }, { tier: 'guarded', cap: null, v: false, d: 'open' });
    assert.deepStrictEqual({ tier: l.bot.tier, cap: l.bot.fundingCapUsd, v: l.bot.tierVerified, d: l.bot.declaredTier }, { tier: 'guarded', cap: null, v: false, d: 'open' });
  });
});

describe('open wallets: the minimal invariants', () => {
  it('plain ETH only goes to the owner or another keystore wallet', async () => {
    const r = rig();
    assert.ok((await r.send({ to: OWNER, value: '0.01' })).ok);
    assert.ok((await r.send({ to: r.bot.address, value: '0.01' })).ok);
    await r.refused({ to: STRANGER, value: '0.01' }, /open wallet "meme": plain ETH may only go to the owner \(0x4444.*\) or another wallet in this keystore, not to 0x1111/);
    await r.refused({ to: STRANGER }, /plain ETH may only go to the owner/);      // zero-value empty call is still a plain payment shape
    const rows = r.audit().filter(a => a.action === 'FIREWALL_REFUSED');
    assert.strictEqual(rows.length, 2); assert.strictEqual(rows[0].params.tier, 'open'); assert.strictEqual(rows[0].params.wallet, 'meme'); assert.match(rows[0].error, /REFUSED \(firewall\): open wallet "meme"/);
    const ok = r.audit().filter(a => a.action === 'SEND_TX'); assert.strictEqual(ok[0].params.firewall, 'open:eth-to-owner'); assert.strictEqual(ok[1].params.firewall, 'open:eth-to-keystore'); assert.strictEqual(ok[0].params.tier, 'open');
  });
  it('ERC-20 transfer / transferFrom: the recipient must be the owner or a keystore wallet, on any token', async () => {
    const r = rig();
    assert.strictEqual((await r.send({ to: MEME_TOKEN, data: erc20('transfer', [OWNER, 5n]) })).ok, true);
    assert.strictEqual((await r.send({ to: USDC, data: erc20('transfer', [r.bot.address, 5n]) })).ok, true);
    assert.strictEqual((await r.send({ to: MEME_TOKEN, data: erc20('transferFrom', [STRANGER, r.meme.address, 5n]) })).ok, true);
    await r.refused({ to: MEME_TOKEN, data: erc20('transfer', [STRANGER, 5n]) }, /open wallet "meme": ERC-20 transfer may only pay the owner .* or another wallet in this keystore, not 0x1111/);
    await r.refused({ to: USDC, data: erc20('transferFrom', [r.meme.address, STRANGER2, 5n]) }, /ERC-20 transferFrom may only pay the owner .*, not 0x2222/);
    const rules = r.audit().filter(a => a.action === 'SEND_TX').map(a => a.params.firewall);
    assert.deepStrictEqual(rules, ['open:transfer-to-owner', 'open:transfer-to-keystore', 'open:transferFrom-to-keystore']);
  });
  it('approvals only to an allow-listed router or executor; signature-based approvals are refused', async () => {
    const r = rig();
    assert.strictEqual((await r.send({ to: MEME_TOKEN, data: erc20('approve', [ROUTER, 2n ** 256n - 1n]) })).ok, true);   // Kyber router is seeded
    r.svc.firewall.add({ address: STRANGER2, chainId: 8453, label: 'Some executor', role: 'executor', verifiedBy: 'r' }, PASS);
    assert.strictEqual((await r.send({ to: MEME_TOKEN, data: erc20('approve', [STRANGER2, 1n]) })).ok, true);
    await r.refused({ to: MEME_TOKEN, data: erc20('approve', [STRANGER, 1n]) }, /open wallet "meme": approve spender 0x1111.* is not an allow-listed router or executor on Base\. Add it to the address book with role router or executor first/);
    await r.refused({ to: MEME_TOKEN, data: erc20('approve', [AAVE, 1n]) }, /approve spender 0xA238.* is not an allow-listed router or executor on Base \(it is listed as contract\)/);
    await r.refused({ to: MEME_TOKEN, data: viem.encodeFunctionData({ abi: [{ type: 'function', name: 'increaseAllowance', inputs: [{ type: 'address' }, { type: 'uint256' }] }], functionName: 'increaseAllowance', args: [STRANGER, 1n] }) }, /increaseAllowance spender 0x1111/);
    await r.refused({ to: MEME_TOKEN, data: viem.encodeFunctionData({ abi: [{ type: 'function', name: 'setApprovalForAll', inputs: [{ type: 'address' }, { type: 'bool' }] }], functionName: 'setApprovalForAll', args: [STRANGER, true] }) }, /setApprovalForAll spender 0x1111/);
    // permit (ERC-2612) and Permit2 selectors: refused outright regardless of the arguments.
    for (const [sel, label] of [['0xd505accf', 'permit \\(ERC-2612\\)'], ['0x87517c45', 'Permit2 approve'], ['0x2b67b570', 'Permit2 permit']]) {
      await r.refused({ to: MEME_TOKEN, data: sel + '00'.repeat(64) }, new RegExp(`${label} is refused for open wallets for now \\(signature-based approvals\\)`));
    }
    // A deactivated router is no longer a valid spender.
    r.svc.firewall.deactivate({ address: STRANGER2, chainId: 8453, reason: 'test' }, PASS);
    await r.refused({ to: MEME_TOKEN, data: erc20('approve', [STRANGER2, 1n]) }, /approve spender 0x2222.* is not an allow-listed router or executor/);
    const rules = r.audit().filter(a => a.action === 'SEND_TX').map(a => a.params.firewall);
    assert.deepStrictEqual(rules, ['open:approve-router', 'open:approve-executor']);
  });
  it('everything else is allowed: any target, any selector, no address-book entry; ETH value only rides along to a contract with code', async () => {
    const r = rig({ codeAt: { [STRANGER2.toLowerCase()]: true } });
    const bonding = '0x12345678' + '00'.repeat(32);                          // an unknown selector on an unknown contract
    assert.strictEqual((await r.send({ to: STRANGER, data: bonding })).ok, true);
    assert.strictEqual((await r.send({ to: STRANGER2, data: bonding, value: '0.05' })).ok, true);
    await r.refused({ to: STRANGER, data: bonding, value: '0.05' }, /open wallet "meme": ETH value may only ride along a call to a contract with code; 0x1111.* has none \(so this would be a plain payment to 0x1111/);
    await r.refused({ to: MEME_TOKEN, data: 'not-hex' }, /calldata/i);
    const rules = r.audit().filter(a => a.action === 'SEND_TX').map(a => a.params.firewall);
    assert.deepStrictEqual(rules, ['open:any-call', 'open:any-call']);
    // If the code check itself fails, refuse rather than guess.
    const down = rig({ codeAt: { throws: true } });
    await down.refused({ to: STRANGER, data: bonding, value: '0.05' }, /could not check whether 0x1111.* is a contract \(rpc down\); ETH value only goes to contracts with code/);
    // ETH value to the owner with calldata is still fine (owner is trusted).
    assert.strictEqual((await down.send({ to: OWNER, data: bonding, value: '0.05' })).ok, true);
  });
  it('a swap from an open wallet goes through (Kyber calldata is just another call)', async () => {
    const r = rig();
    // Realistic shape: the aggregator router with the swap selector and a non-decoded body.
    const out = await r.send({ to: ROUTER, data: '0xe21fd0e9' + 'ab'.repeat(40) });
    assert.strictEqual(out.ok, true); assert.strictEqual(r.audit().at(-1).params.firewall, 'open:any-call');
  });
  it('the guarded wallet is untouched: full firewall, stranger calls refused with the guarded message', async () => {
    const r = rig();
    assert.strictEqual((await r.send({ wallet: 'bot', to: OWNER, value: '0.01' })).ok, true);
    await assert.rejects(r.send({ wallet: 'bot', to: STRANGER, data: '0x12345678' }), e => e instanceof FirewallError && !/open wallet/.test(e.message));
    const rows = r.audit(); assert.strictEqual(rows.at(-1).params.tier, 'guarded'); assert.strictEqual(rows.at(-1).action, 'FIREWALL_REFUSED');
  });
});

describe('open wallets: funding cap', () => {
  // The fake chain holds 1 ETH (quoted at $2.76 by the fake Kyber) per address; USDC per `usdcOf`.
  it('refuses a guarded -> open transfer that would push the open wallet above its cap, in USDC or ETH', async () => {
    const r = rig({ usdcOf: {} });
    const to = r.meme.address;
    // USDC: held $2.76 (ETH) + 0 USDC. 90 -> $92.76 fine; 98 -> $100.76 refused.
    const ok = await r.send({ wallet: 'bot', to: USDC, data: erc20('transfer', [to, usdc(90)]) });
    assert.strictEqual(ok.ok, true);
    const row = r.audit().at(-1); assert.strictEqual(row.params.tier, 'guarded'); assert.deepStrictEqual(row.params.fundingCap, { rule: 'funding-cap', target: 'meme', fundingCapUsd: 100, heldUsd: 2.76, inboundUsd: 90 });
    await assert.rejects(r.send({ wallet: 'bot', to: USDC, data: erc20('transfer', [to, usdc(98)]) }), e => e instanceof FirewallError && /^REFUSED \(firewall\): funding cap: open wallet "meme" would hold about \$100\.76 after this transfer \(holds ~\$2\.76, receiving ~\$98\.00\), above its funding cap of \$100\. Send less, or create a new open wallet with a higher cap\./.test(e.message));
    assert.strictEqual(r.audit().at(-1).action, 'FIREWALL_REFUSED');
    // transferFrom into the open wallet is the same inbound.
    await assert.rejects(r.send({ wallet: 'bot', to: USDC, data: erc20('transferFrom', [r.bot.address, to, usdc(98)]) }), /funding cap: open wallet "meme"/);
    // Plain ETH is valued through the quote: 1 ETH ~ $2.76 here, so it fits; a tiny-cap wallet already over its cap takes nothing.
    assert.strictEqual((await r.send({ wallet: 'bot', to, value: '1' })).ok, true);
    r.ks.createWallet('tiny', { tier: 'open', fundingCapUsd: 2 });
    await assert.rejects(r.send({ wallet: 'bot', to: r.ks.list().find(w => w.name === 'tiny').address, value: '0.001' }), /funding cap: open wallet "tiny" would hold about \$5\.52 .* above its funding cap of \$2/);
  });
  it('counts what the open wallet already holds (USDC + ETH); profits above the cap block further funding but never sending', async () => {
    // Give meme $150 of USDC on the fake chain: any inbound is now refused, even $1.
    const m = rig(); m.usdcOf[m.meme.address.toLowerCase()] = usdc(150);
    await assert.rejects(m.send({ wallet: 'bot', to: USDC, data: erc20('transfer', [m.meme.address, usdc(1)]) }), /would hold about \$153\.76 .* \(holds ~\$152\.76, receiving ~\$1\.00\)/);
    // Outbound from the over-cap open wallet: to the owner, to a guarded wallet, and to a router, all allowed.
    assert.strictEqual((await m.send({ to: OWNER, value: '0.5' })).ok, true);
    assert.strictEqual((await m.send({ to: USDC, data: erc20('transfer', [m.bot.address, usdc(150)]) })).ok, true);
    assert.strictEqual((await m.send({ to: MEME_TOKEN, data: erc20('approve', [ROUTER, 1n]) })).ok, true);
    // Guarded -> guarded and guarded -> owner carry no cap at all.
    const g = await m.send({ wallet: 'bot', to: OWNER, value: '0.5' }); assert.strictEqual(g.ok, true); assert.strictEqual(m.audit().at(-1).params.fundingCap, undefined);
  });
  it('refuses when the inbound amount cannot be valued in USD', async () => {
    const r = rig({ quoteFails: true });
    await assert.rejects(r.send({ wallet: 'bot', to: r.meme.address, value: '0.1' }), /REFUSED \(firewall\): funding cap: cannot value .* in USD on Base, so the transfer into open wallet "meme" \(cap \$100\) is refused/);
    // USDC needs no quote, but the ETH already held does: still refused, still closed.
    await assert.rejects(r.send({ wallet: 'bot', to: USDC, data: erc20('transfer', [r.meme.address, usdc(1)]) }), /cannot value .* in USD/);
  });
});

describe('open wallets: per-wallet pause', () => {
  it('pauses one wallet without touching the other; dry runs still work; global pause still stops everything', async () => {
    const r = rig();
    assert.strictEqual(r.svc.setPaused(true, 'owner', 'meme'), true);
    assert.throws(() => r.svc.setPaused(true, 'owner', 'nope'), /No wallet named "nope"/);
    assert.strictEqual(r.svc.isPaused('meme'), true); assert.strictEqual(r.svc.isPaused('bot'), false); assert.strictEqual(r.svc.isPaused(), false);
    assert.deepStrictEqual(r.svc.pausedWallets(), ['meme']);
    assert.strictEqual((await r.send({ to: OWNER, value: '0.01' })).ok, true, 'dry run while paused');
    await assert.rejects(r.send({ to: OWNER, value: '0.01', dryRun: false }), /Trading is PAUSED by the owner for wallet "meme"\. Dry runs still work/);
    assert.strictEqual((await r.send({ wallet: 'bot', to: OWNER, value: '0.01', dryRun: false })).ok, true, 'the guarded wallet still broadcasts');
    assert.strictEqual(r.sent.length, 1);
    const st = await r.svc.status(); assert.deepStrictEqual(st.pausedWallets, ['meme']); assert.strictEqual(st.wallets.find(w => w.name === 'meme').paused, true); assert.strictEqual(st.wallets.find(w => w.name === 'bot').paused, false);
    assert.strictEqual(st.wallets.find(w => w.name === 'meme').warning, 'OPEN: no signing firewall'); assert.strictEqual(st.wallets.find(w => w.name === 'bot').warning, undefined);
    r.svc.setPaused(false, 'owner', 'meme');
    assert.strictEqual((await r.send({ to: OWNER, value: '0.01', dryRun: false })).ok, true); assert.strictEqual(r.sent.length, 2);
    r.svc.setPaused(true, 'owner');
    await assert.rejects(r.send({ to: OWNER, value: '0.01', dryRun: false }), /Trading is PAUSED by the owner\. Dry runs/);
    await assert.rejects(r.send({ wallet: 'bot', to: OWNER, value: '0.01', dryRun: false }), /Trading is PAUSED by the owner\. Dry runs/);
    const pauses = r.audit().filter(a => a.action === 'PAUSE' || a.action === 'RESUME').map(a => [a.action, a.params.wallet || null]);
    assert.deepStrictEqual(pauses, [['PAUSE', 'meme'], ['RESUME', 'meme'], ['PAUSE', null]]);
    // Pause state survives a new service instance on the same data dir.
    const again = new WalletService({ dataDir: r.dir, keystore: r.ks, clientFactory: () => ({ public: {} }), fetchImpl: async () => {}, now: () => r.state.now });
    r.svc.setPaused(false, 'owner'); r.svc.setPaused(true, 'owner', 'meme');
    assert.deepStrictEqual(again.pausedWallets(), ['meme']); assert.strictEqual(again.isPaused(), false);
  });
  it('balances() labels the tier, cap, warning and pause per wallet', async () => {
    const r = rig(); r.svc.setPaused(true, 'owner', 'meme');
    const by = { meme: await r.svc.balances({ wallet: 'meme' }), bot: await r.svc.balances({ wallet: 'bot' }) };
    assert.deepStrictEqual({ t: by.meme.tier, c: by.meme.fundingCapUsd, w: by.meme.warning, p: by.meme.paused }, { t: 'open', c: 100, w: 'OPEN: no signing firewall', p: true });
    assert.deepStrictEqual({ t: by.bot.tier, c: by.bot.fundingCapUsd, w: by.bot.warning, p: by.bot.paused }, { t: 'guarded', c: null, w: undefined, p: false });
  });
});
