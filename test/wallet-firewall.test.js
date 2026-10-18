'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const viem = require('viem');
const { Keystore } = require('../lib/wallet/keystore');
// A dummy owner for the tests; the real owner address is configuration (settings.walletOwner), never code.
process.env.HUB_WALLET_OWNER = '0x1111111111111111111111111111111111111111';
process.env.HUB_WALLET_OWNER_LABEL = 'owner.eth';
const { Firewall, FirewallError, OWNER, NATIVE, SEED, ROLES, rules, allowedFor, ZERO, canon } = require('../lib/wallet/firewall');

const BASE = 8453, ZORA = 7777777;
const A = {
  POOL: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', WETH: '0x4200000000000000000000000000000000000006', USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  AWETH: '0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7', DEBT: '0x59dca05b6c26dbd64b5381374aAaC5CD05644C28', ADAPTER: '0x63dfa7c09Dc2Ff4030d6B8Dc2ce6262BF898C8A4',
  ROUTER: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5', RELAY: '0x4cd00e387622c35bddb9b4c962c136462338bc31',
};
const RANDOM = '0x000000000000000000000000000000000000dead', RANDOM2 = '0x00000000000000000000000000000000000beef1', EXEC = '0x00000000000000000000000000000000000e0ec1';
const ID = '0x' + '11'.repeat(32);
const SEL = { approve: '0x095ea7b3', transfer: '0xa9059cbb', transferFrom: '0x23b872dd', wethDeposit: '0xd0e30db0', wethWithdraw: '0x2e1a7d4d',
  supply: '0x617ba037', withdraw: '0x69328dec', borrow: '0xa415bcad', repay: '0x573ade81', repayWithATokens: '0x2dad97d4', setCollateral: '0x5a3b74b9',
  swapAndRepay: '0x4db9dc97', depositNative: '0x49290c1c', depositErc20_3: '0x5a1ee3ac', depositErc20_4: '0xe8017952', swap: '0xe21fd0e9', swapGeneric: '0x59e50fed', swapSimpleMode: '0x8af033fb' };

/** Encode calldata for a rule by selector (so the test breaks loudly if a selector in the table drifts). */
function call(selector, args) { const r = rules().get(selector); assert.ok(r, `no rule for ${selector}`); return viem.encodeFunctionData({ abi: r.abi, functionName: r.name, args }); }
const desc = (self, o = {}) => ({ srcToken: NATIVE, dstToken: A.USDC, srcReceivers: [], srcAmounts: [], feeReceivers: [], feeAmounts: [], dstReceiver: self, amount: 10n ** 15n, minReturnAmount: 1n, flags: 0n, permit: '0x', ...o });
const exec = (self, o = {}) => ({ callTarget: A.ROUTER, approveTarget: A.ROUTER, targetData: '0x', desc: desc(self, o), clientData: '0x' });
const permitNone = { amount: 0n, deadline: 0n, v: 0, r: '0x' + '00'.repeat(32), s: '0x' + '00'.repeat(32) };

function mk({ keystore = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-'));
  let ks = null, self = '0x1111111111111111111111111111111111111111';
  if (keystore) { ks = new Keystore({ file: path.join(dir, 'ks.json'), kdf: { N: 1024, r: 8, p: 1 }, backupDir: path.join(dir, 'bk') }); ks.init('test passphrase 123'); self = ks.createWallet('bot').address; }
  const file = path.join(dir, 'wallet-allowlist.json');
  const fw = new Firewall({ file, keystore: ks, now: () => 1_700_000_000_000 });
  const ok = (tx, chainId = BASE) => fw.check({ chainId, from: self, ...tx });
  const no = (tx, re, chainIdOrMsg = BASE) => { const chainId = typeof chainIdOrMsg === 'number' ? chainIdOrMsg : BASE; const why = typeof chainIdOrMsg === 'string' ? chainIdOrMsg : ''; return assert.throws(() => fw.check({ chainId, from: self, ...tx }), e => { assert.ok(e instanceof FirewallError, `not a FirewallError: ${e.message}`); assert.match(e.message, /^REFUSED \(firewall\): /); assert.match(e.message, re, why); return true; }); };
  return { dir, file, ks, fw, self, ok, no, records: () => JSON.parse(fs.readFileSync(file, 'utf8')).records };
}

describe('firewall: the seed book', () => {
  it('names every strategy contract on Base, the Relay depository on Base and Zora, and the owner; nothing else', () => {
    const on = id => SEED.filter(e => e.chainId === id).map(e => e.address.toLowerCase()).sort();
    assert.deepStrictEqual(on(BASE), Object.values(A).map(a => a.toLowerCase()).sort());
    assert.deepStrictEqual(on(ZORA), [A.RELAY.toLowerCase()]);
    const owner = SEED.filter(e => e.role === 'owner'); assert.strictEqual(owner.length, 1); assert.strictEqual(owner[0].address, OWNER); assert.strictEqual(owner[0].chainId, null);
    assert.strictEqual(OWNER, '0x1111111111111111111111111111111111111111', 'the configured owner');
    for (const e of SEED) { assert.ok(ROLES.includes(e.role), e.label); assert.ok(viem.isAddress(e.address), e.label); assert.ok(e.verifiedBy && e.label); }
    assert.strictEqual(SEED.filter(e => e.weth).length, 1, 'exactly one WETH');
  });
  it('the selector table is what the strategies use, and every role has a bounded set of functions', () => {
    for (const [name, sel] of Object.entries(SEL)) assert.ok(rules().has(sel), `${name} ${sel}`);
    assert.strictEqual(rules().size, Object.keys(SEL).length, 'no untested selectors');
    assert.deepStrictEqual(allowedFor('owner'), []); assert.ok(allowedFor('token').includes('approve(address,uint256)')); assert.ok(allowedFor('bridge').every(d => d.startsWith('deposit')));
  });
});

describe('firewall: what trader may sign', () => {
  it('plain ETH may go to the owner or the wallet itself, and nowhere else', () => {
    const t = mk();
    assert.strictEqual(t.ok({ to: OWNER, value: 10n ** 17n }).rule, 'plain-eth-to-owner');
    assert.strictEqual(t.ok({ to: OWNER.toLowerCase(), value: 1n }).rule, 'plain-eth-to-owner');
    assert.strictEqual(t.ok({ to: t.self, value: 1n }).rule, 'plain-eth-to-self');
    assert.strictEqual(t.ok({ to: OWNER, value: 1n, data: '0x' }).rule, 'plain-eth-to-owner', 'empty calldata is plain');
    t.no({ to: A.ROUTER, value: 10n ** 15n }, /plain ETH transfers may only go to the owner \(owner\.eth\) or the wallet itself; KyberSwap.*is a contract/);
    t.no({ to: A.POOL }, /plain ETH transfers may only go to the owner/);
    t.no({ to: RANDOM, value: 1n }, /"to" 0x0+dEaD is not in the allow-list for chain 8453\. Only the owner \(owner\.eth 0x1111/);
    t.no({ to: RANDOM }, /not in the allow-list/);
  });
  it('accounts never take calldata', () => {
    const t = mk();
    t.no({ to: OWNER, data: call(SEL.transfer, [OWNER, 1n]) }, /calldata to the owner \(owner\.eth\) is not allowed: it is an account, not a contract/);
    t.no({ to: t.self, data: '0x00' }, /calldata to the wallet itself is not allowed/);
  });
  it('the whole strategy loop passes: approve, swap, supply, borrow, repay, withdraw, swapAndRepay, WETH wrap/unwrap, Relay deposits', () => {
    const t = mk(); const s = t.self;
    for (const spender of [A.ROUTER, A.POOL, A.ADAPTER, A.RELAY]) assert.strictEqual(t.ok({ to: A.USDC, data: call(SEL.approve, [spender, 2_500_000n]) }).rule, 'approve(address,uint256)', spender);
    assert.strictEqual(t.ok({ to: A.WETH, data: call(SEL.approve, [A.POOL, 10n ** 18n]) }).rule, 'approve(address,uint256)');
    assert.strictEqual(t.ok({ to: A.AWETH, data: call(SEL.approve, [A.ADAPTER, 10n ** 18n]) }).rule, 'approve(address,uint256)');
    assert.strictEqual(t.ok({ to: A.ROUTER, value: 10n ** 15n, data: call(SEL.swap, [exec(s)]) }).label, 'KyberSwap MetaAggregationRouterV2 (Base)');
    assert.ok(t.ok({ to: A.ROUTER, data: call(SEL.swap, [exec(s, { srcToken: A.USDC, dstToken: NATIVE })]) }).ok);
    assert.ok(t.ok({ to: A.ROUTER, value: 1n, data: call(SEL.swapGeneric, [exec(s)]) }).ok);
    assert.ok(t.ok({ to: A.ROUTER, data: call(SEL.swapSimpleMode, [A.ROUTER, desc(s, { srcToken: A.USDC, dstToken: A.WETH }), '0x', '0x']) }).ok);
    assert.ok(t.ok({ to: A.POOL, data: call(SEL.supply, [A.WETH, 10n ** 18n, s, 0]) }).ok);
    assert.ok(t.ok({ to: A.POOL, data: call(SEL.borrow, [A.USDC, 1_000_000n, 2n, 0, s]) }).ok);
    assert.ok(t.ok({ to: A.POOL, data: call(SEL.repay, [A.USDC, 1_000_000n, 2n, s]) }).ok);
    assert.ok(t.ok({ to: A.POOL, data: call(SEL.repayWithATokens, [A.USDC, 1_000_000n, 2n]) }).ok);
    assert.ok(t.ok({ to: A.POOL, data: call(SEL.withdraw, [A.WETH, 10n ** 17n, s]) }).ok);
    assert.ok(t.ok({ to: A.POOL, data: call(SEL.setCollateral, [A.WETH, true]) }).ok);
    assert.ok(t.ok({ to: A.ADAPTER, data: call(SEL.swapAndRepay, [A.WETH, A.USDC, 10n ** 17n, 1_000_000n, 2n, 0n, '0x1234', permitNone]) }).ok);
    assert.ok(t.ok({ to: A.WETH, value: 10n ** 17n, data: call(SEL.wethDeposit, []) }).ok);
    assert.ok(t.ok({ to: A.WETH, data: call(SEL.wethWithdraw, [10n ** 17n]) }).ok);
    assert.ok(t.ok({ to: A.RELAY, value: 10n ** 16n, data: call(SEL.depositNative, [s, ID]) }).ok);
    assert.ok(t.ok({ to: A.RELAY, value: 10n ** 16n, data: call(SEL.depositNative, [s, ID]) }, ZORA).ok, 'Zora -> Base recovery');
    assert.ok(t.ok({ to: A.RELAY, data: call(SEL.depositErc20_3, [s, A.USDC, ID]) }).ok);
    assert.ok(t.ok({ to: A.RELAY, data: call(SEL.depositErc20_4, [s, A.USDC, 1_000_000n, ID]) }).ok);
    assert.ok(t.ok({ to: A.USDC, data: call(SEL.transfer, [OWNER, 1n]) }).ok, 'profits to the owner');
    assert.ok(t.ok({ to: A.USDC, data: call(SEL.transferFrom, [s, OWNER, 1n]) }).ok);
    assert.ok(t.ok({ to: A.USDC, data: call(SEL.transfer, [s, 1n]) }).ok);
  });
  it('value may only leave with a call that is meant to carry it', () => {
    const t = mk();
    t.no({ to: A.USDC, value: 1n, data: call(SEL.approve, [A.ROUTER, 1n]) }, /ETH value \(0\.000000000000000001 ETH\) is not allowed with approve\(address,uint256\) on USDC \(Base\)/);
    t.no({ to: A.POOL, value: 10n ** 18n, data: call(SEL.supply, [A.WETH, 1n, t.self, 0]) }, /ETH value .* is not allowed with supply/);
    t.no({ to: A.RELAY, value: 1n, data: call(SEL.depositErc20_3, [t.self, A.USDC, ID]) }, /not allowed with depositErc20/);
  });
  it('value can only ever land on the wallet itself or the owner', () => {
    const t = mk(); const s = t.self;
    t.no({ to: A.USDC, data: call(SEL.transfer, [RANDOM, 1n]) }, /transfer: recipient must be the owner \(owner\.eth 0x1111.*\) or the wallet itself, not 0x0+dEaD/);
    t.no({ to: A.USDC, data: call(SEL.transferFrom, [s, RANDOM, 1n]) }, /transferFrom: recipient must be the owner/);
    t.no({ to: A.USDC, data: call(SEL.transferFrom, [RANDOM, s, 1n]) }, /transferFrom: from must be the wallet itself/);
    t.no({ to: A.USDC, data: call(SEL.approve, [RANDOM, 1n]) }, /approve: spender 0x0+dEaD is not an allow-listed router\/contract\/bridge on chain 8453/);
    t.no({ to: A.USDC, data: call(SEL.approve, [A.WETH, 1n]) }, /approve: spender .* is not an allow-listed router/, 'a token is not a spender');
    t.no({ to: A.USDC, data: call(SEL.approve, [OWNER, 1n]) }, /approve: spender/, 'not even the owner: approvals are for contracts');
    t.no({ to: A.POOL, data: call(SEL.supply, [A.WETH, 1n, RANDOM, 0]) }, /supply: onBehalfOf must be the wallet itself \(0x[0-9a-f]{40}\), not 0x0+dEaD/);
    t.no({ to: A.POOL, data: call(SEL.supply, [A.WETH, 1n, OWNER, 0]) }, /supply: onBehalfOf must be the wallet itself/, 'aTokens stay in the trading wallet');
    t.no({ to: A.POOL, data: call(SEL.borrow, [A.USDC, 1n, 2n, 0, RANDOM]) }, /borrow: onBehalfOf must be the wallet itself/);
    t.no({ to: A.POOL, data: call(SEL.repay, [A.USDC, 1n, 2n, RANDOM]) }, /repay: onBehalfOf must be the wallet itself/);
    t.no({ to: A.POOL, data: call(SEL.withdraw, [A.WETH, 1n, RANDOM]) }, /withdraw: to must be the wallet itself/);
    t.no({ to: A.POOL, data: call(SEL.withdraw, [A.WETH, 1n, OWNER]) }, /withdraw: to must be the wallet itself/);
    t.no({ to: A.ROUTER, data: call(SEL.swap, [exec(s, { dstReceiver: RANDOM })]) }, /swap: desc\.dstReceiver must be the wallet itself/);
    t.no({ to: A.ROUTER, data: call(SEL.swapSimpleMode, [A.ROUTER, desc(s, { dstReceiver: OWNER }), '0x', '0x']) }, /swapSimpleMode: desc\.dstReceiver must be the wallet itself/);
    t.no({ to: A.ROUTER, data: call(SEL.swap, [exec(s, { minReturnAmount: 0n })]) }, /swap: desc\.minReturnAmount must be > 0/);
    // Every other place a Kyber description can send funds: fee receivers, source receivers, the call/approve targets, the simple-mode caller.
    t.no({ to: A.ROUTER, data: call(SEL.swap, [exec(s, { feeReceivers: [RANDOM], feeAmounts: [1n] })]) }, /swap: desc\.feeAmounts\[0\] = 1 would pay a fee to 0x0+dEaD; fees to third parties are not allowed/);
    t.no({ to: A.ROUTER, data: call(SEL.swap, [exec(s, { feeReceivers: [RANDOM], feeAmounts: [] })]) }, /swap: desc\.feeReceivers \(1\) and desc\.feeAmounts \(0\) differ in length/);
    t.no({ to: A.ROUTER, data: call(SEL.swap, [exec(s, { srcReceivers: [RANDOM], srcAmounts: [1n] })]) }, /swap: desc\.srcReceivers\[0\] 0x0+dEaD is not an allow-listed router or swap executor on chain 8453/);
    t.no({ to: A.ROUTER, data: call(SEL.swap, [exec(s, { srcReceivers: [OWNER], srcAmounts: [1n] })]) }, /swap: desc\.srcReceivers\[0\] .* is not an allow-listed router or swap executor/, 'not even the owner: swap inputs go to a contract, profits go home via a plain transfer');
    t.no({ to: A.ROUTER, data: call(SEL.swap, [exec(s, { srcReceivers: [A.ROUTER], srcAmounts: [10n ** 15n + 1n] })]) }, /swap: desc\.srcAmounts sum to 1000000000000001, more than desc\.amount 1000000000000000/);
    t.no({ to: A.ROUTER, data: call(SEL.swapGeneric, [{ ...exec(s), callTarget: RANDOM }]) }, /swapGeneric: execution\.callTarget 0x0+dEaD is not an allow-listed router or swap executor/);
    t.no({ to: A.ROUTER, data: call(SEL.swap, [{ ...exec(s), approveTarget: RANDOM2 }]) }, /swap: execution\.approveTarget 0x0+bEEf1 is not an allow-listed router or swap executor/i);
    t.no({ to: A.ROUTER, data: call(SEL.swapSimpleMode, [RANDOM, desc(s), '0x', '0x']) }, /swapSimpleMode: caller 0x0+dEaD is not an allow-listed router or swap executor/);
    // A generic `contract` entry is not an executor: the router would approve it and call it with targetData nobody decodes.
    for (const [p, tx] of [['callTarget', { ...exec(s), callTarget: A.POOL }], ['approveTarget', { ...exec(s), approveTarget: A.ADAPTER }]])
      t.no({ to: A.ROUTER, data: call(SEL.swap, [tx]) }, new RegExp(`swap: execution\\.${p} .* is not an allow-listed router or swap executor`), `${p} may not be a plain contract entry`);
    t.no({ to: A.ROUTER, data: call(SEL.swap, [exec(s, { srcReceivers: [A.POOL], srcAmounts: [1n] })]) }, /srcReceivers\[0\] .* is not an allow-listed router or swap executor/);
    t.no({ to: A.ROUTER, data: call(SEL.swapSimpleMode, [A.ADAPTER, desc(s), '0x', '0x']) }, /swapSimpleMode: caller .* is not an allow-listed router or swap executor/);
    t.no({ to: A.ROUTER, data: call(SEL.swapSimpleMode, [A.RELAY, desc(s), '0x', '0x']) }, /swapSimpleMode: caller .* is not an allow-listed router or swap executor/, 'nor a bridge');
    // Once the owner lists an executor under its own role, the same shapes pass.
    t.fw.add({ address: EXEC, chainId: BASE, label: 'Kyber executor', role: 'executor', verifiedBy: 'r' }, 'test passphrase 123');
    assert.ok(t.ok({ to: A.ROUTER, data: call(SEL.swap, [{ ...exec(s, { srcReceivers: [A.ROUTER, EXEC, s], srcAmounts: [10n ** 14n, 10n ** 14n, 10n ** 14n], feeReceivers: [RANDOM], feeAmounts: [0n] }), callTarget: EXEC, approveTarget: EXEC }]) }).ok, 'listed receivers, zero fee, executor callTarget/approveTarget pass');
    assert.ok(t.ok({ to: A.ROUTER, data: call(SEL.swap, [{ ...exec(s), callTarget: ZERO, approveTarget: A.ROUTER }]) }).ok, 'zero callTarget and the router itself pass');
    assert.ok(t.ok({ to: A.ROUTER, data: call(SEL.swapSimpleMode, [EXEC, desc(s), '0x', '0x']) }).ok);
    // ...but the executor itself is still not something the wallet may call, approve, or pay.
    t.no({ to: EXEC, data: call(SEL.approve, [A.ROUTER, 1n]) }, /approve\(address,uint256\) is not allowed on Kyber executor \(role executor\)\. Allowed there: nothing/);
    t.no({ to: A.USDC, data: call(SEL.approve, [EXEC, 1n]) }, /approve: spender .* is not an allow-listed router\/contract\/bridge/);
    t.no({ to: EXEC, value: 1n }, /plain ETH transfers may only go to the owner/);
    assert.throws(() => t.fw.add({ address: RANDOM2, chainId: BASE, label: 'x', role: 'executor', verifiedBy: 'r', anySelector: true }, 'test passphrase 123'), /an executor entry may only be reached through a router/);
    t.no({ to: OWNER, value: -1n }, /value -1 is negative/);
    t.no({ to: A.RELAY, value: 1n, data: call(SEL.depositNative, [RANDOM, ID]) }, /depositNative: depositor must be the wallet itself/);
    t.no({ to: A.RELAY, data: call(SEL.depositErc20_4, [OWNER, A.USDC, 1n, ID]) }, /depositErc20: depositor must be the wallet itself/);
  });
  it('only allow-listed tokens may be moved through the strategy contracts', () => {
    const t = mk(); const s = t.self;
    t.no({ to: A.POOL, data: call(SEL.supply, [RANDOM, 1n, s, 0]) }, /supply: asset 0x0+dEaD is not an allow-listed token on chain 8453/);
    t.no({ to: A.POOL, data: call(SEL.supply, [A.ROUTER, 1n, s, 0]) }, /supply: asset .* is not an allow-listed token/, 'a router is not a token');
    t.no({ to: A.POOL, data: call(SEL.borrow, [RANDOM, 1n, 2n, 0, s]) }, /borrow: asset .* not an allow-listed token/);
    t.no({ to: A.POOL, data: call(SEL.setCollateral, [RANDOM, true]) }, /setUserUseReserveAsCollateral: asset/);
    t.no({ to: A.ADAPTER, data: call(SEL.swapAndRepay, [RANDOM, A.USDC, 1n, 1n, 2n, 0n, '0x', permitNone]) }, /swapAndRepay: collateralAsset .* not an allow-listed token/);
    t.no({ to: A.ADAPTER, data: call(SEL.swapAndRepay, [A.WETH, RANDOM, 1n, 1n, 2n, 0n, '0x', permitNone]) }, /swapAndRepay: debtAsset .* not an allow-listed token/);
    t.no({ to: A.ROUTER, data: call(SEL.swap, [exec(s, { srcToken: RANDOM })]) }, /swap: desc\.srcToken .* not an allow-listed token/);
    t.no({ to: A.ROUTER, data: call(SEL.swap, [exec(s, { dstToken: RANDOM })]) }, /swap: desc\.dstToken .* not an allow-listed token/);
    t.no({ to: A.RELAY, data: call(SEL.depositErc20_3, [s, RANDOM, ID]) }, /depositErc20: token .* not an allow-listed token/);
  });
  it('a function is only accepted on the kind of contract it belongs to', () => {
    const t = mk(); const s = t.self;
    t.no({ to: A.ROUTER, data: call(SEL.supply, [A.WETH, 1n, s, 0]) }, /supply\(address,uint256,address,uint16\) is not allowed on KyberSwap .* \(role router\)\. Allowed there: swap\(/);
    t.no({ to: A.POOL, data: call(SEL.approve, [A.ROUTER, 1n]) }, /approve\(address,uint256\) is not allowed on Aave v3 Pool \(Base\) \(role contract\)/);
    t.no({ to: A.USDC, data: call(SEL.swap, [exec(s)]) }, /swap\(.*\) is not allowed on USDC \(Base\) \(role token\)/);
    t.no({ to: A.USDC, value: 1n, data: call(SEL.wethDeposit, []) }, /deposit\(\) is only allowed on WETH, not on USDC \(Base\)/);
    t.no({ to: A.AWETH, data: call(SEL.wethWithdraw, [1n]) }, /withdraw\(uint256\) is only allowed on WETH, not on Aave aWETH \(Base\)/);
    t.no({ to: A.RELAY, data: call(SEL.transfer, [OWNER, 1n]) }, /transfer\(address,uint256\) is not allowed on Relay depository \(Base\) \(role bridge\)\. Allowed there: depositNative/);
  });
  it('unknown, short, or malformed calldata fails closed', () => {
    const t = mk();
    t.no({ to: A.POOL, data: '0xdeadbeef' + '00'.repeat(32) }, /selector 0xdeadbeef is not allowed on Aave v3 Pool \(Base\) \(role contract\)\. Allowed there: supply\(/);
    t.no({ to: A.ROUTER, data: '0xdeadbeef' }, /selector 0xdeadbeef is not allowed/);
    t.no({ to: A.POOL, data: '0x12' }, /calldata to Aave v3 Pool \(Base\) is shorter than a function selector/);
    t.no({ to: A.POOL, data: '0x123' }, /odd number of hex digits/);
    t.no({ to: A.POOL, data: '0xzz' }, /calldata is not valid hex/);
    t.no({ to: A.POOL, data: 'deadbeef' }, /calldata is not valid hex/);
    t.no({ to: A.POOL, data: SEL.supply + '00'.repeat(3) }, /calldata for supply\(.*\) on Aave v3 Pool \(Base\) could not be decoded/);
    t.no({ to: A.POOL, data: call(SEL.supply, [A.WETH, 1n, t.self, 0]) + 'ff' }, /is not canonical \(trailing or non-standard bytes\)/, 'trailing bytes');
  });
  it('is chain-aware: the same address on the wrong chain is unknown, and cross-chain look-ups never match', () => {
    const t = mk(); const s = t.self;
    t.no({ to: A.RELAY, value: 1n, data: call(SEL.depositNative, [s, ID]) }, /is not in the allow-list for chain 42161/, 42161);
    t.no({ to: A.POOL, data: call(SEL.supply, [A.WETH, 1n, s, 0]) }, /not in the allow-list for chain 7777777/, ZORA);
    t.no({ to: A.RELAY, data: call(SEL.depositErc20_3, [s, A.USDC, ID]) }, /depositErc20: token .* is not an allow-listed token on chain 7777777/, ZORA);
    assert.ok(t.ok({ to: OWNER, value: 1n }, ZORA).ok, 'the owner is the owner on every chain');
    assert.ok(t.ok({ to: OWNER, value: 1n }, 42161).ok);
  });
  it('address-poisoning look-alikes of the owner are refused like any stranger', () => {
    const t = mk();
    for (const fake of ['0x1111A500EBA9755d7628ac1b51F3445595671111', '0x1111a3Ce7C61dA2D942B082140CE702501111111', '0x111156f8eB9D1d7A94d3C12F4925B76241C21111']) {
      t.no({ to: fake.toLowerCase(), value: 1n }, /not in the allow-list/);
      t.no({ to: A.USDC, data: call(SEL.transfer, [fake.toLowerCase(), 1n]) }, /transfer: recipient must be the owner/);
      assert.throws(() => t.fw.check({ chainId: BASE, from: t.self, to: fake, value: 1n }), /not a valid address|not in the allow-list/, 'bad checksum or unknown, either way refused');
    }
  });
  it('rejects garbage inputs before looking anything up', () => {
    const t = mk();
    t.no({ to: OWNER, from: undefined }, /sender is not a valid address/);
    t.no({ to: 'owner.eth' }, /"to" is not a valid address/);
    assert.throws(() => t.fw.check({ chainId: undefined, from: t.self, to: OWNER }), /chainId is unknown/);
    assert.throws(() => t.fw.check({ chainId: BASE, from: t.self, to: OWNER, value: '1', data: 12 }), /calldata is not valid hex/);
  });
});

describe('firewall: the address book', () => {
  it('a record pasted into the file by hand (no signature) is ignored', () => {
    const t = mk();
    fs.writeFileSync(t.file, JSON.stringify({ version: 1, records: [{ type: 'add', address: RANDOM, chainId: BASE, label: 'evil', role: 'router', verifiedBy: 'me', addedAt: 'x', anySelector: true, allowValue: true }] }));
    assert.strictEqual(t.fw.list().filter(e => e.address.toLowerCase() === RANDOM).length, 0);
    t.no({ to: RANDOM, value: 1n, data: '0xdeadbeef' }, /not in the allow-list/);
    fs.writeFileSync(t.file, JSON.stringify({ version: 1, records: [{ type: 'deactivate', address: OWNER, chainId: null, at: 'x' }] }));
    t.no({ to: OWNER, value: 1n }, /the owner entry is deactivated in the allow-list/, 'an unsigned deactivation still deactivates: fail closed');
  });
  it('the owner adds an entry with the keystore passphrase; it is signed and immediately effective; tampering voids it', () => {
    const t = mk();
    const rec = t.fw.add({ address: RANDOM, chainId: BASE, label: 'New router', role: 'router', verifiedBy: 'workspaces/verifier/reports/new-router.md', by: 'test' }, 'test passphrase 123');
    assert.match(rec.sig, /^[0-9a-f]{64}$/); assert.strictEqual(rec.address, viem.getAddress(RANDOM)); assert.strictEqual(rec.addedAt, '2023-11-14T22:13:20.000Z');
    assert.strictEqual(fs.statSync(t.file).mode & 0o777, 0o600);
    const e = t.fw.list().find(x => x.address === rec.address); assert.strictEqual(e.source, 'owner'); assert.strictEqual(e.verified, 'ok'); assert.strictEqual(e.active, true);
    assert.ok(t.ok({ to: RANDOM, data: call(SEL.swap, [exec(t.self)]) }).ok);
    assert.ok(t.ok({ to: A.USDC, data: call(SEL.approve, [RANDOM, 1n]) }).ok, 'and it is now a legal spender');
    t.no({ to: RANDOM, data: '0xdeadbeef' }, /selector 0xdeadbeef is not allowed on New router/);
    // Tamper: upgrade the role in the file.
    const doc = JSON.parse(fs.readFileSync(t.file, 'utf8')); doc.records[0].anySelector = true; fs.writeFileSync(t.file, JSON.stringify(doc));
    t.no({ to: RANDOM, data: call(SEL.swap, [exec(t.self)]) }, /not in the allow-list/);
    t.no({ to: A.USDC, data: call(SEL.approve, [RANDOM, 1n]) }, /approve: spender/);
    doc.records[0].anySelector = false; doc.records[0].address = RANDOM2; fs.writeFileSync(t.file, JSON.stringify(doc));
    t.no({ to: RANDOM2, data: call(SEL.swap, [exec(t.self)]) }, /not in the allow-list/, 'the address is part of the signature');
  });
  it('anySelector / allowValue entries are the only way to loosen decoding, and they still cannot take plain ETH', () => {
    const t = mk();
    t.fw.add({ address: RANDOM, chainId: BASE, label: 'Opaque', role: 'contract', verifiedBy: 'r', anySelector: true }, 'test passphrase 123');
    assert.strictEqual(t.ok({ to: RANDOM, data: '0xdeadbeef' }).rule, 'any-selector');
    t.no({ to: RANDOM, value: 1n, data: '0xdeadbeef' }, /ETH value is not allowed with unknown calldata on Opaque/);
    t.no({ to: RANDOM, value: 1n }, /plain ETH transfers may only go to the owner/);
    t.no({ to: RANDOM, data: call(SEL.supply, [A.WETH, 1n, RANDOM2, 0]) }, /supply: onBehalfOf must be the wallet itself/, 'known selectors are still decoded and checked');
    t.fw.add({ address: RANDOM2, chainId: BASE, label: 'Payable opaque', role: 'contract', verifiedBy: 'r', anySelector: true, allowValue: true }, 'test passphrase 123');
    assert.ok(t.ok({ to: RANDOM2, value: 1n, data: '0xdeadbeef' }).ok);
  });
  it('refuses bad or dangerous additions: wrong passphrase, role owner, the owner address, duplicates, missing provenance', () => {
    const t = mk(); const good = { address: RANDOM, chainId: BASE, label: 'x', role: 'router', verifiedBy: 'r' };
    assert.throws(() => t.fw.add(good, 'wrong passphrase 123'), /Wrong passphrase\./); assert.ok(!fs.existsSync(t.file), 'nothing written');
    assert.throws(() => t.fw.add({ ...good, role: 'owner' }, 'test passphrase 123'), /the owner destination is fixed in code/);
    assert.throws(() => t.fw.add({ ...good, role: 'admin' }, 'test passphrase 123'), /role must be one of contract, token, router, bridge, executor/);
    assert.throws(() => t.fw.add({ ...good, address: OWNER }, 'test passphrase 123'), /already the fixed destination/);
    assert.throws(() => t.fw.add({ ...good, verifiedBy: ' ' }, 'test passphrase 123'), /verifiedBy is required/);
    assert.throws(() => t.fw.add({ ...good, label: '' }, 'test passphrase 123'), /label is required/);
    assert.throws(() => t.fw.add({ ...good, chainId: 0 }, 'test passphrase 123'), /chainId must be a positive integer/);
    assert.throws(() => t.fw.add({ ...good, address: A.POOL }, 'test passphrase 123'), /already in the book \(Aave v3 Pool \(Base\)\)\. Entries cannot be edited/);
    t.fw.add(good, 'test passphrase 123');
    assert.throws(() => t.fw.add({ ...good, label: 'again' }, 'test passphrase 123'), /already in the book \(x\)/);
    assert.strictEqual(t.records().length, 1);
    assert.throws(() => new Firewall({ file: t.file }).add(good, 'test passphrase 123'), /no keystore/);
  });
  it('deactivation is append-only, works on seed entries and the owner, and fails closed even when it cannot be verified', () => {
    const t = mk(); const s = t.self;
    assert.throws(() => t.fw.deactivate({ address: RANDOM, chainId: BASE }, 'test passphrase 123'), /is not in the book/);
    assert.throws(() => t.fw.deactivate({ address: A.ROUTER, chainId: BASE }, 'wrong passphrase 123'), /Wrong passphrase\./);
    t.fw.deactivate({ address: A.ROUTER, chainId: BASE, reason: 'compromised' }, 'test passphrase 123');
    t.no({ to: A.ROUTER, data: call(SEL.swap, [exec(s)]) }, /"to" .* \(KyberSwap MetaAggregationRouterV2 \(Base\)\) is DEACTIVATED in the allow-list: compromised/);
    t.no({ to: A.USDC, data: call(SEL.approve, [A.ROUTER, 1n]) }, /approve: spender .* is not an allow-listed router/, 'no longer a spender either');
    assert.throws(() => t.fw.deactivate({ address: A.ROUTER, chainId: BASE }, 'test passphrase 123'), /already deactivated/);
    assert.ok(t.ok({ to: A.POOL, data: call(SEL.supply, [A.WETH, 1n, s, 0]) }).ok, 'the rest of the book is untouched');
    assert.strictEqual(t.fw.list().find(e => e.label.startsWith('KyberSwap')).active, false);
    assert.strictEqual(t.records().length, 1, 'nothing removed, one record appended');
    t.ks.lock();
    t.no({ to: A.ROUTER, data: call(SEL.swap, [exec(s)]) }, /DEACTIVATED/, 'still deactivated while the signature cannot be checked');
    t.ks.unlock('test passphrase 123');
    // Cut the owner off: nothing can leave at all.
    t.fw.deactivate({ address: OWNER, chainId: null, reason: 'moving wallets' }, 'test passphrase 123');
    t.no({ to: OWNER, value: 1n }, /the owner entry is deactivated in the allow-list; no external destination is currently allowed/);
    t.no({ to: A.USDC, data: call(SEL.transfer, [OWNER, 1n]) }, /transfer: recipient must be the owner/);
    assert.ok(t.ok({ to: s, value: 1n }).ok, 'self is still fine');
    assert.doesNotThrow(() => t.fw.add({ address: RANDOM, chainId: BASE, label: 'x', role: 'router', verifiedBy: 'r' }, 'test passphrase 123'), 'adding is unaffected');
  });
  it('owner-added entries are unusable while the keystore is locked or absent; seed entries keep working', () => {
    const t = mk();
    t.fw.add({ address: RANDOM, chainId: BASE, label: 'New router', role: 'router', verifiedBy: 'r' }, 'test passphrase 123');
    t.ks.lock();
    t.no({ to: RANDOM, data: call(SEL.swap, [exec(t.self)]) }, /\(New router\) was added by the owner, but the keystore is locked so its signature cannot be verified\. Unlock the keystore and retry\./);
    t.no({ to: A.USDC, data: call(SEL.approve, [RANDOM, 1n]) }, /approve: spender/);
    assert.ok(t.ok({ to: A.ROUTER, data: call(SEL.swap, [exec(t.self)]) }).ok);
    assert.strictEqual(t.fw.list().find(e => e.label === 'New router').verified, 'locked');
    t.ks.unlock('test passphrase 123');
    assert.ok(t.ok({ to: RANDOM, data: call(SEL.swap, [exec(t.self)]) }).ok);
    const bare = new Firewall({ file: t.file });
    assert.throws(() => bare.check({ chainId: BASE, from: t.self, to: RANDOM, data: call(SEL.swap, [exec(t.self)]) }), /keystore is locked/);
    assert.ok(bare.check({ chainId: BASE, from: t.self, to: OWNER, value: 1n }).ok);
  });
  it('a damaged book refuses everything until fixed; a missing one is just the seed', () => {
    const t = mk();
    assert.strictEqual(t.fw.list().length, SEED.length);
    fs.writeFileSync(t.file, '{not json');
    assert.throws(() => t.fw.check({ chainId: BASE, from: t.self, to: OWNER, value: 1n }), e => e instanceof FirewallError && /^REFUSED \(firewall\): address book .* is unreadable .*refusing everything until the owner fixes it/.test(e.message));
    fs.writeFileSync(t.file, JSON.stringify({ records: 'nope' }));
    assert.throws(() => t.fw.check({ chainId: BASE, from: t.self, to: OWNER, value: 1n }), e => e instanceof FirewallError && /malformed; refusing everything/.test(e.message));
    assert.throws(() => t.fw.add({ address: RANDOM, chainId: BASE, role: 'contract', label: 'x', verifiedBy: 'r', passphrase: 'test passphrase 123' }), FirewallError, 'the owner cannot append to a damaged book either');
    assert.ok(!fs.existsSync(t.file + '.lock'), 'the write lock is released even when the write fails');
  });
});

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

describe('wallet firewall: supersede (deactivate, then re-add)', () => {
  const P = 'test passphrase 123';
  function clocked() {
    const t = mk(); let clock = 1_700_000_000_000;
    const fw = new Firewall({ file: t.file, keystore: t.ks, now: () => clock });
    const tick = (ms = 1000) => { clock += ms; };
    const swapTo = to => ({ to, data: call(SEL.swap, [exec(t.self)]) });
    return { ...t, fw, tick, swapTo, ok: tx => fw.check({ chainId: BASE, from: t.self, ...tx }) };
  }
  const entry = { address: RANDOM, chainId: BASE, label: 'Old', role: 'contract', verifiedBy: 'r1' };

  it('re-adding after a deactivation works, and lookups use the new entry', () => {
    const t = clocked();
    t.fw.add(entry, P); t.tick();
    assert.throws(() => t.ok({ to: RANDOM, data: '0xdeadbeef' }), /selector 0xdeadbeef is not allowed on Old \(role contract\)/);
    t.fw.deactivate({ address: RANDOM, chainId: BASE, reason: 'widen' }, P); t.tick();
    assert.throws(() => t.ok({ to: RANDOM, data: '0xdeadbeef' }), /DEACTIVATED in the allow-list: widen/);
    t.fw.add({ ...entry, label: 'New', anySelector: true, verifiedBy: 'r2' }, P);
    assert.deepStrictEqual(t.ok({ to: RANDOM, data: '0xdeadbeef' }), { ok: true, rule: 'any-selector', label: 'New', selector: '0xdeadbeef' });
    const pair = t.fw.list().filter(e => same(e.address, RANDOM));
    assert.deepStrictEqual(pair.map(e => [e.label, e.active]), [['Old', false], ['New', true]]);
    assert.strictEqual(t.records().length, 3, 'append-only: add, deactivate, add');
  });
  it('a re-add in the same millisecond as the deactivation is dated after it, so it is live', () => {
    const t = clocked();
    t.fw.add(entry, P); t.tick();
    t.fw.deactivate({ address: RANDOM, chainId: BASE }, P);
    const rec = t.fw.add({ ...entry, label: 'Same ms' }, P);
    assert.ok(Date.parse(rec.addedAt) > Date.parse(t.records()[1].at));
    assert.strictEqual(t.fw.list().find(e => e.label === 'Same ms').active, true);
  });
  it('an old deactivation does not kill a newer add; a deactivation after the re-add does', () => {
    const t = clocked();
    t.fw.add(entry, P); t.tick();
    t.fw.deactivate({ address: RANDOM, chainId: BASE, reason: 'first' }, P); t.tick();
    t.fw.add({ ...entry, label: 'Second', role: 'router' }, P); t.tick();
    assert.ok(t.ok(t.swapTo(RANDOM)).ok, 'the first deactivation does not reach the second add');
    t.fw.deactivate({ address: RANDOM, chainId: BASE, reason: 'second' }, P); t.tick();
    assert.throws(() => t.ok(t.swapTo(RANDOM)), /\(Second\) is DEACTIVATED in the allow-list: second/);
    assert.throws(() => t.fw.deactivate({ address: RANDOM, chainId: BASE }, P), /already deactivated/);
    // Record order in the file does not matter: the signed timestamps decide.
    const doc = JSON.parse(fs.readFileSync(t.file, 'utf8')); doc.records.reverse(); fs.writeFileSync(t.file, JSON.stringify(doc));
    assert.deepStrictEqual(t.fw.list().filter(e => same(e.address, RANDOM)).map(e => [e.label, e.active, e.deactivatedReason]).sort(), [['Old', false, 'second'], ['Second', false, 'second']]);
  });
  it('seed entries are still deactivatable, and can be superseded by an owner entry', () => {
    const t = clocked();
    t.fw.deactivate({ address: A.ROUTER, chainId: BASE, reason: 'rotate' }, P); t.tick();
    assert.throws(() => t.ok(t.swapTo(A.ROUTER)), /DEACTIVATED in the allow-list: rotate/);
    t.fw.add({ address: A.ROUTER, chainId: BASE, label: 'Kyber router (re-verified)', role: 'router', verifiedBy: 'r3' }, P);
    assert.strictEqual(t.ok(t.swapTo(A.ROUTER)).label, 'Kyber router (re-verified)');
    const seed = t.fw.list().find(e => e.source === 'seed' && same(e.address, A.ROUTER) && e.chainId === BASE);
    assert.strictEqual(seed.active, false, 'the seed stays dead');
  });
  it('adding over an ACTIVE entry is still refused, seed or owner', () => {
    const t = clocked();
    assert.throws(() => t.fw.add({ ...entry, address: A.POOL }, P), /already in the book \(Aave v3 Pool \(Base\)\)\. Entries cannot be edited; deactivate it and add a new one/);
    t.fw.add(entry, P); t.tick();
    t.fw.deactivate({ address: RANDOM, chainId: BASE }, P); t.tick();
    t.fw.add({ ...entry, label: 'Live' }, P); t.tick();
    assert.throws(() => t.fw.add({ ...entry, label: 'Third' }, P), /already in the book \(Live\)\. Entries cannot be edited/);
    assert.strictEqual(t.records().length, 3);
  });
  it('fails closed: unsigned deactivations still kill, forged adds are dropped, unreadable or future-dated deactivations block re-adds', () => {
    const t = clocked();
    t.fw.add(entry, P); t.tick();
    const doc = JSON.parse(fs.readFileSync(t.file, 'utf8'));
    doc.records.push({ type: 'deactivate', address: RANDOM, chainId: BASE, reason: 'unsigned', at: new Date(1_700_000_500_000).toISOString(), by: 'x' });
    doc.records.push({ type: 'add', address: RANDOM, chainId: BASE, label: 'Forged', role: 'router', verifiedBy: 'x', anySelector: true, allowValue: true, addedAt: new Date(1_700_000_900_000).toISOString(), by: 'x', sig: 'ab'.repeat(32) });
    fs.writeFileSync(t.file, JSON.stringify(doc));
    assert.throws(() => t.ok(t.swapTo(RANDOM)), /\(Old\) is DEACTIVATED in the allow-list: unsigned/);
    assert.ok(!t.fw.list().some(e => e.label === 'Forged'), 'forged add dropped');
    // The unsigned deactivation is ~8 minutes in this clock's future: re-adding is refused, not silently dead.
    assert.throws(() => t.fw.add({ ...entry, label: 'Blocked' }, P), /has a deactivation dated .* it cannot be superseded/);
    doc.records[1].at = 'not a date'; fs.writeFileSync(t.file, JSON.stringify(doc));
    assert.throws(() => t.fw.add({ ...entry, label: 'Blocked' }, P), /deactivation dated unreadably/);
    assert.throws(() => t.ok(t.swapTo(RANDOM)), /DEACTIVATED/);
    // An owner add with an unreadable addedAt cannot outlive any deactivation.
    doc.records = [JSON.parse(fs.readFileSync(t.file, 'utf8')).records[0]];
    doc.records[0].addedAt = 'garbage'; // breaks the signature too, so the add is dropped outright
    fs.writeFileSync(t.file, JSON.stringify(doc));
    assert.ok(!t.fw.list().some(e => same(e.address, RANDOM)));
  });
  it('a deactivation whose signature fails kills every entry of the pair: backdating it revives nothing', () => {
    const t = clocked();
    t.fw.add(entry, P); t.tick();
    t.fw.deactivate({ address: RANDOM, chainId: BASE, reason: 'retired' }, P); t.tick();
    t.fw.add({ ...entry, label: 'Second' }, P); t.tick();
    t.fw.deactivate({ address: RANDOM, chainId: BASE, reason: 'retired again' }, P); t.tick();
    // Tamper: move the second (signed) deactivation back before the second add, hoping to revive it.
    const doc = JSON.parse(fs.readFileSync(t.file, 'utf8'));
    doc.records[3].at = new Date(Date.parse(doc.records[2].addedAt) - 1).toISOString();
    fs.writeFileSync(t.file, JSON.stringify(doc));
    assert.throws(() => t.ok(t.swapTo(RANDOM)), /DEACTIVATED/);
    assert.ok(t.fw.list().filter(e => same(e.address, RANDOM)).every(e => !e.active), 'nothing revived');
    assert.throws(() => t.fw.add({ ...entry, label: 'Third' }, P), /deactivation dated unreadably or without a valid signature; it cannot be superseded/);
  });
  it('a deactivation made unverifiable by a throwing field counts as badly signed, not locked', () => {
    const t = clocked();
    t.fw.add(entry, P); t.tick();
    t.fw.deactivate({ address: RANDOM, chainId: BASE, reason: 'retired' }, P); t.tick();
    t.fw.add({ ...entry, label: 'Second' }, P); t.tick();
    t.fw.deactivate({ address: RANDOM, chainId: BASE, reason: 'retired again' }, P); t.tick();
    const doc = JSON.parse(fs.readFileSync(t.file, 'utf8'));
    doc.records[3].at = new Date(Date.parse(doc.records[2].addedAt) - 1).toISOString();
    doc.records[3].reason = { toString: 1 };
    fs.writeFileSync(t.file, JSON.stringify(doc));
    assert.throws(() => t.ok(t.swapTo(RANDOM)), /DEACTIVATED/);
    assert.ok(t.fw.list().filter(e => same(e.address, RANDOM)).every(e => !e.active), 'nothing revived');
    assert.throws(() => t.fw.add({ ...entry, label: 'Third' }, P), /cannot be superseded/);
  });

  it('executor restrictions are unchanged on re-add', () => {
    const t = clocked();
    t.fw.add({ address: EXEC, chainId: BASE, label: 'Exec', role: 'executor', verifiedBy: 'r' }, P); t.tick();
    t.fw.deactivate({ address: EXEC, chainId: BASE }, P); t.tick();
    assert.throws(() => t.fw.add({ address: EXEC, chainId: BASE, label: 'Exec2', role: 'executor', verifiedBy: 'r', anySelector: true }, P), /an executor entry may only be reached through a router/);
  });
});
