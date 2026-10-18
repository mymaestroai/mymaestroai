'use strict';

process.env.HUB_WALLET_AGENTS = 'trader';   // the wallet agent is configuration (settings.walletAgents), never code
process.env.HUB_WALLET_OWNER = '0x4444444444444444444444444444444444444444';   // tests never read the install's settings
process.env.HUB_WALLET_OWNER_LABEL = 'owner.eth';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { Keystore } = require('../lib/wallet/keystore');
const { WalletService, NETWORKS } = require('../lib/wallet/service');
const tools = require('../lib/wallet/tools');
const tw = require('../lib/temporal-workers');
const viem = require('viem');
const { OWNER, NATIVE, rules } = require('../lib/wallet/firewall');

const ROUTER = NETWORKS.base.aggregator.router, USDC = NETWORKS.base.tokens.USDC;
/** Real Kyber `swap` calldata paying `self`, as the firewall requires (the aggregator's bytes are checked, not trusted). */
const swapCalldata = (self, tokenIn, amount, minReturnAmount) => viem.encodeFunctionData({ abi: rules().get('0xe21fd0e9').abi, functionName: 'swap', args: [{ callTarget: ROUTER, approveTarget: ROUTER, targetData: '0x',
  desc: { srcToken: tokenIn.startsWith('0xEeee') ? NATIVE : USDC, dstToken: tokenIn.startsWith('0xEeee') ? USDC : NATIVE, srcReceivers: [], srcAmounts: [], feeReceivers: [], feeAmounts: [], dstReceiver: self, amount, minReturnAmount, flags: 0n, permit: '0x' }, clientData: '0x' }] });

/** A fake chain + fake aggregator. Records everything that would have touched money. */
function rig({ balance = 10n ** 18n, allowance = 0n, revert = null, router = ROUTER, receiptStatus = 'success', build = {}, quoteOut = '2760000' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  const ks = new Keystore({ file: path.join(dir, 'ks.json'), kdf: { N: 1024, r: 8, p: 1 }, backupDir: path.join(dir, 'bk') }); ks.init('test passphrase 123'); const w = ks.createWallet('bot');
  const sent = [], keysUsed = []; const state = { balance, allowance, now: 1_700_000_000_000 };
  const pub = {
    getBalance: async () => state.balance, getGasPrice: async () => 6_000_000n, estimateGas: async () => 150_000n,
    call: async () => { if (revert) { const e = new Error(revert); e.shortMessage = revert; throw e; } return { data: '0x' }; },
    readContract: async ({ functionName }) => functionName === 'decimals' ? 6 : functionName === 'allowance' ? state.allowance : functionName === 'balanceOf' ? 5_000_000n : 'USDC',
    waitForTransactionReceipt: async ({ hash }) => ({ status: receiptStatus, gasUsed: 120_000n, transactionHash: hash }),
  };
  const clientFactory = () => ({ public: pub, walletFor: pk => { keysUsed.push(pk); return { sendTransaction: async tx => { sent.push(tx); return '0x' + String(sent.length).padStart(64, 'a'); } }; } });
  const fetchImpl = async (url, init) => {
    let body;
    if (url.includes('/route/build')) {
      const { routeSummary: rs, slippageTolerance } = JSON.parse(init.body);
      // An honest build carries the quote: same amount in, minReturnAmount = quote minus the slippage we asked for.
      const amount = build.amount ?? BigInt(rs.amountIn), minOut = build.minReturnAmount ?? BigInt(rs.amountOut) * BigInt(10000 - slippageTolerance) / 10000n;
      body = { code: 0, data: { routerAddress: router, data: swapCalldata(w.address, rs.tokenIn, amount, minOut), amountOut: '2760000', transactionValue: rs.tokenIn.startsWith('0xEeee') ? '1000000000000000' : '0', gasUsd: '0.01' } };
    } else {
      const sp = new URL(url).searchParams;
      body = { code: 0, data: { routerAddress: router, routeSummary: { tokenIn: sp.get('tokenIn'), amountIn: sp.get('amountIn'), amountOut: quoteOut, amountInUsd: 2.76, amountOutUsd: 2.75, gasUsd: '0.01' } } };
    }
    return { ok: true, json: async () => body };
  };
  const svc = new WalletService({ dataDir: dir, keystore: ks, clientFactory, fetchImpl, now: () => state.now });
  const audit = () => fs.readFileSync(svc.auditFile, 'utf8').trim().split('\n').map(JSON.parse);
  return { svc, ks, w, sent, keysUsed, state, audit, dir };
}

describe('wallet service: sending', () => {
  it('dry run simulates and estimates but never signs or broadcasts', async () => {
    const r = rig(); const out = await r.svc.sendTransaction({ agent: 'trader', wallet: 'bot', to: OWNER, value: '0.01', dryRun: true });
    assert.strictEqual(out.dryRun, true); assert.strictEqual(out.simulated, true); assert.ok(out.feeEth);
    assert.strictEqual(r.sent.length, 0); assert.strictEqual(r.keysUsed.length, 0, 'the key must not even be decrypted');
    assert.strictEqual(r.audit().at(-1).dryRun, true);
  });
  it('a transaction that would revert is refused before signing', async () => {
    const r = rig({ revert: 'execution reverted: INSUFFICIENT_OUTPUT_AMOUNT' });
    await assert.rejects(() => r.svc.sendTransaction({ agent: 'trader', wallet: 'bot', to: USDC, data: viem.encodeFunctionData({ abi: viem.erc20Abi, functionName: 'approve', args: [ROUTER, 1n] }) }), /Simulation failed, so nothing was sent.*INSUFFICIENT_OUTPUT/);
    assert.strictEqual(r.sent.length, 0); assert.strictEqual(r.audit().at(-1).ok, false);
  });
  it('a real send signs through the keystore, returns the hash, and is audited', async () => {
    const r = rig(); const out = await r.svc.sendTransaction({ agent: 'trader', wallet: 'bot', to: OWNER, value: '0.01' });
    assert.match(out.txHash, /^0x/); assert.strictEqual(out.status, 'success'); assert.match(out.explorer, /basescan\.org\/tx\//);
    assert.strictEqual(r.sent.length, 1); assert.strictEqual(r.sent[0].value, 10n ** 16n);
    const row = r.audit().at(-1); assert.strictEqual(row.agent, 'trader'); assert.strictEqual(row.txHash, out.txHash);
  });
  it('an on-chain revert after inclusion is reported as a failure, not a success', async () => {
    const out = await rig({ receiptStatus: 'reverted' }).svc.sendTransaction({ agent: 'trader', wallet: 'bot', to: OWNER });
    assert.strictEqual(out.ok, false); assert.match(out.error, /REVERTED/);
  });
  it('pause blocks every broadcast but still allows dry runs', async () => {
    const r = rig(); r.svc.setPaused(true);
    await assert.rejects(() => r.svc.sendTransaction({ agent: 'trader', wallet: 'bot', to: OWNER }), /PAUSED/);
    assert.strictEqual(r.sent.length, 0);
    assert.strictEqual((await r.svc.sendTransaction({ agent: 'trader', wallet: 'bot', to: OWNER, dryRun: true })).dryRun, true);
    r.svc.setPaused(false); await r.svc.sendTransaction({ agent: 'trader', wallet: 'bot', to: OWNER }); assert.strictEqual(r.sent.length, 1);
  });
  it('a locked keystore cannot sign, and says who can fix it', async () => {
    const r = rig(); r.ks.lock();
    await assert.rejects(() => r.svc.sendTransaction({ agent: 'trader', wallet: 'bot', to: OWNER }), /locked.*owner/i);
  });
  it('bad inputs are rejected clearly', async () => {
    const r = rig();
    await assert.rejects(() => r.svc.sendTransaction({ wallet: 'bot', to: 'not-an-address' }), /0x address/);
    await assert.rejects(() => r.svc.sendTransaction({ wallet: 'nope', to: OWNER }), /No wallet named "nope"/);
    await assert.rejects(() => r.svc.balances({ wallet: 'bot', network: 'mainnet' }), /Unknown network/);
  });
});

describe('wallet service: swaps', () => {
  it('refuses a build whose calldata does not carry the quote (lower minReturnAmount or a different amount in)', async () => {
    const low = rig({ build: { minReturnAmount: 2_000_000n } });
    await assert.rejects(() => low.svc.swap({ agent: 'trader', wallet: 'bot', tokenIn: 'ETH', tokenOut: 'USDC', amountIn: '0.001' }), /REFUSED: the built route's minReturnAmount 2000000 is below the quoted floor/);
    assert.strictEqual(low.sent.length, 0);
    const more = rig({ build: { amount: 10n ** 16n } });
    await assert.rejects(() => more.svc.swap({ agent: 'trader', wallet: 'bot', tokenIn: 'ETH', tokenOut: 'USDC', amountIn: '0.001' }), /REFUSED: the built route spends 10000000000000000 of .* but the quote was for 1000000000000000/);
    assert.strictEqual(more.sent.length, 0);
    const ok = rig(); const out = await ok.svc.swap({ agent: 'trader', wallet: 'bot', tokenIn: 'ETH', tokenOut: 'USDC', amountIn: '0.001', slippageBps: 100 });
    assert.strictEqual(out.amountOutMin, '2.7324', 'the reported minimum is what the calldata enforces, not what the aggregator claims');
  });
  it('accepts Kyber\'s real rounding (minReturnAmount a wei under the exact floor) but not a bigger cut', async () => {
    // Two live Base builds at the default 50 bps, recorded 2026-09-22: Kyber returned one wei under the exact floor.
    for (const [quote, built] of [['365145082336671', 363319356924986n], ['547884753279004', 545145329512607n]]) {
      const exact = BigInt(quote) * 9950n / 10000n; assert.strictEqual(built, exact - 1n, 'the fixture is one wei under the exact floor');
      const ok = rig({ quoteOut: quote, build: { minReturnAmount: built } });
      const out = await ok.svc.swap({ agent: 'trader', wallet: 'bot', tokenIn: 'ETH', tokenOut: 'USDC', amountIn: '0.001', dryRun: true });
      assert.strictEqual(out.ok, true); assert.strictEqual(out.amountOutMin, viem.formatUnits(built, 6), 'the minimum reported is the one in the calldata');
      const tolerated = BigInt(quote) * 9949n / 10000n;   // 50 bps slippage + 1 bps rounding tolerance
      const edge = rig({ quoteOut: quote, build: { minReturnAmount: tolerated } });
      await assert.doesNotReject(() => edge.svc.swap({ agent: 'trader', wallet: 'bot', tokenIn: 'ETH', tokenOut: 'USDC', amountIn: '0.001', dryRun: true }));
      const cut = rig({ quoteOut: quote, build: { minReturnAmount: tolerated - 1n } });
      await assert.rejects(() => cut.svc.swap({ agent: 'trader', wallet: 'bot', tokenIn: 'ETH', tokenOut: 'USDC', amountIn: '0.001', dryRun: true }), /is below the quoted floor \d+ \(quote \d+ minus 50 bps and 1 bps rounding tolerance\)/);
      assert.strictEqual(cut.sent.length, 0);
    }
  });
  it('ETH in: sends to the pinned router with the quoted value', async () => {
    const r = rig(); const out = await r.svc.swap({ agent: 'trader', wallet: 'bot', tokenIn: 'ETH', tokenOut: 'USDC', amountIn: '0.001' });
    assert.strictEqual(r.sent.length, 1); assert.strictEqual(r.sent[0].to.toLowerCase(), ROUTER.toLowerCase()); assert.strictEqual(r.sent[0].value, 10n ** 15n);
    assert.strictEqual(out.amountOutExpected, '2.76'); assert.strictEqual(out.amountOutMin, '2.7462', '0.5% default slippage');
  });
  it('REFUSES when the aggregator names a different router', async () => {
    const r = rig({ router: '0x000000000000000000000000000000000000bad1' });
    await assert.rejects(() => r.svc.swap({ agent: 'trader', wallet: 'bot', tokenIn: 'ETH', tokenOut: 'USDC', amountIn: '0.001' }), /REFUSED.*not the pinned router/);
    assert.strictEqual(r.sent.length, 0);
  });
  it('ERC-20 in: approves the EXACT amount (never unlimited), then swaps', async () => {
    const r = rig({ allowance: 0n }); await r.svc.swap({ agent: 'trader', wallet: 'bot', tokenIn: 'USDC', tokenOut: 'ETH', amountIn: '2.5' });
    assert.strictEqual(r.sent.length, 2);
    assert.strictEqual(r.sent[0].to.toLowerCase(), USDC.toLowerCase(), 'first tx is the approval on the token');
    const viem = require('viem'); const dec = viem.decodeFunctionData({ abi: viem.erc20Abi, data: r.sent[0].data });
    assert.strictEqual(dec.functionName, 'approve'); assert.strictEqual(dec.args[0].toLowerCase(), ROUTER.toLowerCase()); assert.strictEqual(dec.args[1], 2_500_000n, 'exactly 2.5 USDC');
    assert.strictEqual(r.sent[1].to.toLowerCase(), ROUTER.toLowerCase());
  });
  it('ERC-20 in with enough allowance skips the approval; dry run never approves', async () => {
    const a = rig({ allowance: 10n ** 12n }); await a.svc.swap({ agent: 'trader', wallet: 'bot', tokenIn: 'USDC', tokenOut: 'ETH', amountIn: '2.5' }); assert.strictEqual(a.sent.length, 1);
    const b = rig({ allowance: 0n }); const out = await b.svc.swap({ agent: 'trader', wallet: 'bot', tokenIn: 'USDC', tokenOut: 'ETH', amountIn: '2.5', dryRun: true });
    assert.strictEqual(b.sent.length, 0); assert.strictEqual(out.needsApproval, true); assert.strictEqual(out.dryRun, true);
  });
  it('slippage must be sane; testnet has no swaps; unknown symbols explain themselves', async () => {
    const r = rig(); const base = { agent: 'trader', wallet: 'bot', tokenIn: 'ETH', tokenOut: 'USDC', amountIn: '0.001' };
    for (const bad of [0, 2001, 1.5, 'lots']) await assert.rejects(() => r.svc.swap({ ...base, slippageBps: bad }), /slippageBps/);
    await assert.rejects(() => r.svc.swap({ ...base, tokenOut: 'WETH', network: 'base-sepolia' }), /not available on Base Sepolia/);
    await assert.rejects(() => r.svc.quoteSwap({ tokenIn: 'ETH', tokenOut: 'SHIBX', amountIn: '1' }), /Unknown token "SHIBX".*0x contract address/);
    assert.strictEqual(r.sent.length, 0);
  });
  it('zora is a recovery-only network: a real viem chain, ETH only, swaps refused', async () => {
    const zora = NETWORKS.zora;
    assert.strictEqual(zora.chainId, 7777777); assert.strictEqual(zora.aggregator, null);
    assert.deepStrictEqual(Object.keys(zora.tokens), ['ETH']);
    assert.strictEqual(require('viem/chains').zora.id, zora.chainId, 'chain id must match the viem definition used for signing');
    const r = rig();
    await assert.rejects(() => r.svc.swap({ agent: 'trader', wallet: 'bot', tokenIn: 'ETH', tokenOut: '0x4200000000000000000000000000000000000006', amountIn: '0.001', network: 'zora' }), /not available on Zora/);
    assert.strictEqual(r.sent.length, 0);
  });
});

describe('wallet service: leaked-key alert and audit', () => {
  it('alerts when ETH leaves a wallet and the hub sent nothing; stays quiet for its own spending', async () => {
    const r = rig({ balance: 10n ** 18n }); assert.deepStrictEqual(await r.svc.checkOutflows(), [], 'first look only records a baseline');
    r.state.balance = 4n * 10n ** 17n; const raised = await r.svc.checkOutflows();
    assert.strictEqual(raised.length, 1); assert.strictEqual(raised[0].droppedEth, '0.6'); assert.match(raised[0].message, /do NOT refill/);
    assert.strictEqual(r.svc.status().alerts.length, 1); assert.strictEqual(r.audit().at(-1).action, 'UNEXPECTED_OUTFLOW');
    const q = rig({ balance: 10n ** 18n }); await q.svc.checkOutflows(); await q.svc.sendTransaction({ agent: 'trader', wallet: 'bot', to: OWNER, value: '0.5' });
    q.state.balance = 5n * 10n ** 17n; assert.deepStrictEqual(await q.svc.checkOutflows(), [], 'we spent it ourselves');
  });
  it('the audit trail and its CSV never contain key material', async () => {
    const r = rig(); await r.svc.swap({ agent: 'trader', wallet: 'bot', tokenIn: 'ETH', tokenOut: 'USDC', amountIn: '0.001' });
    const pk = r.keysUsed[0]; assert.match(pk, /^0x[0-9a-f]{64}$/);
    const csv = r.svc.auditCsv(); const raw = fs.readFileSync(r.svc.auditFile, 'utf8');
    assert.ok(!raw.includes(pk) && !csv.includes(pk) && !raw.includes(pk.slice(2)));
    assert.match(csv.split('\n')[0], /^ts,agent,action,network,wallet,ok,dryRun,txHash/); assert.match(csv, /trader,SEND_TX,base,bot,true/);
  });
});

describe('wallet tools: who gets them', () => {
  it('only the designated agent; never a temporary worker, even one spawned by that agent', () => {
    assert.strictEqual(tools.isWalletAgent('trader'), true);
    for (const n of ['maestro', 'worker', 'Trader', '', null, undefined]) assert.strictEqual(tools.isWalletAgent(n), false, String(n));
    const v = tw.createVirtual({ parent: 'trader', model: 'x' }); assert.strictEqual(tools.isWalletAgent(v.id), false); tw.releaseVirtual(v.id);
  });
  it('a non-authorised caller is denied even if it reaches the handler; results hide internals; errors are plain text', async () => {
    const r = rig(); const specs = tools.toolSpecs(() => r.svc); const by = n => specs.find(s => s.name === n);
    assert.match(await tools.runTool(by('wallet_status'), {}, 'maestro'), /^\[DENIED\]/);
    const quote = await tools.runTool(by('wallet_quote_swap'), { tokenIn: 'ETH', tokenOut: 'USDC', amountIn: '0.001' }, 'trader');
    assert.match(quote, /"amountOut": "2.76"/); assert.doesNotMatch(quote, /_routeSummary|_router|_rawIn/);
    assert.match(await tools.runTool(by('wallet_swap'), { wallet: 'bot', tokenIn: 'ETH', tokenOut: 'USDC', amountIn: '0.001', slippageBps: 9999 }, 'trader'), /^\[WALLET ERROR\] slippageBps/);
    assert.strictEqual(r.sent.length, 0);
  });
  it('exposes the six wallet tools plus the ten Hyperliquid tools, each usable by both agent runtimes', () => {
    const specs = tools.toolSpecs(() => ({})); const { z } = require('zod');
    assert.deepStrictEqual(specs.map(s => s.name), ['wallet_status', 'wallet_balances', 'wallet_read_contract', 'wallet_quote_swap', 'wallet_swap', 'wallet_send_transaction',
      'hl_status', 'hl_balances', 'hl_positions', 'hl_market', 'hl_deposit', 'hl_order', 'hl_cancel', 'hl_vault', 'hl_transfer', 'hl_withdraw']);
    for (const s of specs) { assert.strictEqual(s.parameters.type, 'object'); assert.strictEqual(typeof s.zod(z), 'object'); assert.ok(s.description.length > 40); }
    assert.ok(!specs.some(s => /unlock|create|import|export|key/i.test(s.name)), 'no tool can unlock, create, import or export');
  });
});
