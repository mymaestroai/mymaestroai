'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const S = require('../lib/wallet/hyperliquid-signing');

// Vectors from the official SDK: hyperliquid-python-sdk/tests/signing_test.py
const PK = '0x0123456789012345678901234567890123456789012345678901234567890123';
const signer = S.signerFromPrivateKey(PK);
const hex = (n) => '0x' + n.toString(16);

describe('hyperliquid signing: byte-exact against the official SDK vectors', () => {
  it('phantom agent connectionId for an ETH IOC order matches production', () => {
    const action = S.orderAction([S.orderWire({ asset: 4, isBuy: true, price: 1670.1, size: 0.0147, reduceOnly: false, tif: 'Ioc' })]);
    assert.strictEqual(S.actionHash(action, { nonce: 1677777606040 }), '0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908');
  });

  it('L1 signing of a dummy action, mainnet and testnet', async () => {
    const action = { type: 'dummy', num: 100000000000 };   // float_to_int_for_hashing(1000)
    const m = await S.signL1Action(signer, action, { nonce: 0, isMainnet: true });
    assert.deepStrictEqual(m, { r: '0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298', s: '0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8', v: 27 });
    const t = await S.signL1Action(signer, action, { nonce: 0, isMainnet: false });
    assert.deepStrictEqual(t, { r: '0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510', s: '0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613', v: 28 });
  });

  it('L1 signing of a GTC order, with and without a cloid, and with a vault', async () => {
    const plain = S.orderAction([S.orderWire({ asset: 1, isBuy: true, price: 100, size: 100, tif: 'Gtc' })]);
    assert.deepStrictEqual(await S.signL1Action(signer, plain, { nonce: 0, isMainnet: true }),
      { r: '0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e', s: '0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e', v: 28 });
    assert.deepStrictEqual(await S.signL1Action(signer, plain, { nonce: 0, isMainnet: false }),
      { r: '0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54', s: '0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5', v: 27 });
    const withCloid = S.orderAction([S.orderWire({ asset: 1, isBuy: true, price: 100, size: 100, tif: 'Gtc', cloid: '0x00000000000000000000000000000001' })]);
    assert.deepStrictEqual(await S.signL1Action(signer, withCloid, { nonce: 0, isMainnet: true }),
      { r: '0x41ae18e8239a56cacbc5dad94d45d0b747e5da11ad564077fcac71277a946e3', s: '0x3c61f667e747404fe7eea8f90ab0e76cc12ce60270438b2058324681a00116da', v: 27 });
    const dummy = { type: 'dummy', num: 100000000000 };
    assert.deepStrictEqual(await S.signL1Action(signer, dummy, { nonce: 0, isMainnet: true, vaultAddress: '0x1719884eb866cb12b2287399b15f7db5e7d775ea' }),
      { r: '0x3c548db75e479f8012acf3000ca3a6b05606bc2ec0c29c50c515066a326239', s: '0x4d402be7396ce74fbba3795769cda45aec00dc3125a984f2a9f23177b190da2c', v: 28 });
  });

  it('user-signed actions: usdSend and withdraw3 on testnet', async () => {
    const send = { type: 'usdSend', destination: '0x5e9ee1089755c3435139848e47e6635505d5a13a', amount: '1', time: 1687816341423 };
    assert.deepStrictEqual(await S.signUserAction(signer, send, { isMainnet: false }),
      { r: '0x637b37dd731507cdd24f46532ca8ba6eec616952c56218baeff04144e4a77073', s: '0x11a6a24900e6e314136d2592e2f8d502cd89b7c15b198e1bee043c9589f9fad7', v: 27 });
    assert.strictEqual(send.hyperliquidChain, 'Testnet'); assert.strictEqual(send.signatureChainId, '0x66eee');
    const w = { type: 'withdraw3', destination: '0x5e9ee1089755c3435139848e47e6635505d5a13a', amount: '1', time: 1687816341423 };
    assert.deepStrictEqual(await S.signUserAction(signer, w, { isMainnet: false }),
      { r: '0x8363524c799e90ce9bc41022f7c39b4e9bdba786e5f9c72b20e43e1462c37cf9', s: '0x58b1411a775938b83e29182e8ef74975f9054c8e97ebf5ec2dc8d51bfc893881', v: 28 });
  });

  it('wire formatting and rounding follow the SDK rules', () => {
    assert.deepStrictEqual([100, 0.0147, 1670.1, 1e-7, 2747.55].map(S.floatToWire), ['100', '0.0147', '1670.1', '0.0000001', '2747.55']);
    assert.strictEqual(S.roundPrice(2747.5567, 4), 2747.6, '5 significant figures');
    assert.strictEqual(S.roundPrice(86161.53, 5), 86162, '5 sig figs, 1 decimal max for BTC (6-5) -> integer here');
    assert.strictEqual(S.roundPrice(95.27412, 2), 95.274, 'HYPE: 5 sig figs within 4 decimals');
    assert.strictEqual(S.roundSize(0.01239, 4), 0.0123, 'size floors to szDecimals');
    assert.throws(() => S.roundPrice(0, 4)); assert.throws(() => S.roundSize(-1, 4));
    assert.deepStrictEqual(Object.keys(S.orderWire({ asset: 1, isBuy: true, price: 1, size: 1, cloid: '0x1' })), ['a', 'b', 'p', 's', 'r', 't', 'c'], 'msgpack key order is part of the hash');
  });
});

// ── service layer with a fake keystore, fake wallet service and fake HTTP ──
const fs = require('fs'), os = require('os'), path = require('path');
const { HyperliquidService, HlError, RELAY } = require('../lib/wallet/hyperliquid');
const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts');

function rig({ env = 'testnet', unlocked = true, paused = false, mids = { ETH: '2747.55', BTC: '86161.5', HYPE: '95.274', '@107': '95.2' }, withdrawable = '100', positions = [], spotUniverse } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-'));
  const keys = { bot: generatePrivateKey() }; const addr = n => privateKeyToAccount(keys[n]).address;
  const state = { posted: [], sent: [], audit: [], now: 1_700_000_000_000, quoteTo: RELAY.baseDepository, depository: RELAY.baseDepository, vaultName: 'Hyperliquidity Provider (HLP)', orderStatus: { resting: { oid: 77 } },
    sleeps: [], fail: {}, vaultEquities: [{ vaultAddress: '0xDFc24b077bc1425AD1DEA75bCB6f8158E10Df303', equity: '5.01', lockedUntilTimestamp: 1_700_000_000_000 + 4 * 86400e3 }] };
  const keystore = {
    exists: () => true, isUnlocked: () => unlocked, verify: p => p === 'pass pass pass 1',
    list: () => Object.keys(keys).map(n => ({ name: n, address: addr(n) })),
    createWallet: (n) => { keys[n] = generatePrivateKey(); return { name: n, address: addr(n) }; },
    withPrivateKey: async (n, fn) => { if (!unlocked) throw new Error('Keystore is locked.'); if (!keys[n]) throw new Error(`No wallet named "${n}".`); return fn(keys[n], addr(n)); },
  };
  const service = {
    keystore, isPaused: () => paused, walletAddress: n => { if (!keys[n]) throw new Error(`No wallet named "${n}".`); return addr(n); },
    audit: (agent, action, params, result) => state.audit.push({ agent, action, params, result }),
    net: () => ({ tokens: { USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' } }),
    sendTransaction: async (tx) => {
      state.sent.push(tx); const step = tx._meta && tx._meta.step; const f = state.fail[step];
      if (f === 'revert') return { ok: false, status: 'reverted', txHash: '0x' + String(state.sent.length).padStart(64, 'd') };
      if (typeof f === 'number' && f > 0) { state.fail[step] = f - 1; throw new Error('Simulation failed, so nothing was sent: Execution reverted for an unknown reason.'); }
      if (f === 'throw') throw new Error('RPC unreachable');
      return { ok: true, status: 'success', txHash: '0x' + String(state.sent.length).padStart(64, 'b') };
    },
  };
  const meta = { universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }, { name: 'ETH', szDecimals: 4, maxLeverage: 25 }, { name: 'HYPE', szDecimals: 2, maxLeverage: 10 }] };
  // Like mainnet: array position != index (delisted pairs leave gaps). HYPE/USDC is @107 at position 1.
  const spotMeta = { tokens: [{ index: 0, name: 'USDC', szDecimals: 8 }, { index: 1, name: 'HYPE', szDecimals: 2 }, { index: 9, name: 'FOO', szDecimals: 1 }],
    universe: spotUniverse || [{ name: '@72', tokens: [9, 0], index: 72 }, { name: '@107', tokens: [1, 0], index: 107 }] };
  const fetchImpl = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null; const ok = (j, status = 200) => ({ ok: status < 300, status, json: async () => j });
    if (url.endsWith('/info')) {
      if (body.type === 'meta') return ok(meta); if (body.type === 'spotMeta') return ok(spotMeta); if (body.type === 'allMids') return ok(mids);
      if (body.type === 'clearinghouseState') return ok({ marginSummary: { accountValue: '150', totalMarginUsed: '10', totalNtlPos: '30' }, withdrawable, assetPositions: positions });
      if (body.type === 'spotClearinghouseState') return ok({ balances: [{ coin: 'USDC', total: '20', hold: '0' }, { coin: 'HYPE', total: '0', hold: '0' }] });
      if (body.type === 'userVaultEquities') return ok(state.vaultEquities);
      if (body.type === 'frontendOpenOrders') return ok([{ coin: 'ETH', oid: 5, side: 'B', sz: '0.01', limitPx: '2000', reduceOnly: false, tif: 'Gtc', timestamp: 1 }]);
      if (body.type === 'vaultDetails') return ok({ name: state.vaultName, vaultAddress: body.vaultAddress });
      if (body.type === 'metaAndAssetCtxs') return ok([meta, [{ midPx: '86161', markPx: '86160', oraclePx: '86159', funding: '0.0000125', openInterest: '1000', dayNtlVlm: '5e8', premium: '0.0001' }, { midPx: '2747', markPx: '2747', oraclePx: '2746', funding: '0.00001', openInterest: '100', dayNtlVlm: '1e8', premium: '0' }, {}]]);
      if (body.type === 'l2Book') return ok({ levels: [[{ px: '2747.4', sz: '1' }], [{ px: '2747.6', sz: '2' }]] });
      if (body.type === 'extraAgents') return ok(state.posted.filter(p => p.action.type === 'approveAgent').map(p => ({ address: p.action.agentAddress, name: p.action.agentName, validUntil: 1_900_000_000_000 })));
    }
    if (url.endsWith('/exchange')) { state.posted.push(body); const t = body.action.type; return ok({ status: 'ok', response: t === 'order' ? { type: 'order', data: { statuses: [state.orderStatus] } } : t === 'cancel' ? { type: 'cancel', data: { statuses: ['success'] } } : { type: 'default' } }); }
    if (url.includes('/quote')) return ok({ steps: [{ id: 'approve', requestId: 'req1', items: [{ data: { to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', data: '0x095e', value: '0', chainId: 8453 } }] }, { id: 'deposit', requestId: 'req1', items: [{ data: { to: state.quoteTo, data: '0xe801', value: '0', chainId: 8453 }, check: { endpoint: '/intents/status?requestId=req1' } }] }], details: { recipient: addr('bot'), currencyOut: { amountFormatted: String(Number(body.amount) / 1e6 - 1.2) } }, fees: { gas: { amountUsd: '0.01' }, relayer: { amountUsd: '1.2' } } });
    if (url.includes('/chains')) return ok({ chains: [{ id: 8453, protocol: { v2: { depository: state.depository } } }] });
    if (url.includes('/intents/status')) return ok({ status: 'success' });
    throw new Error('unexpected fetch ' + url);
  };
  const hl = new HyperliquidService({ dataDir: dir, service, fetchImpl, now: () => state.now, tokenCheck: t => t === 'wx_current_executor_token', sleep: async (ms) => { state.sleeps.push(ms); } });
  hl.configure({ env, wallet: 'bot' });
  const enableAll = (extra = {}) => { const tools = {}; for (const t of ['hl_deposit', 'hl_order', 'hl_cancel', 'hl_vault', 'hl_transfer', 'hl_withdraw']) tools[t] = { enabled: true, dryRun: false }; hl.configure({ enabled: true, tools, ...extra }); };
  const refused = async (p, status, re) => assert.rejects(p, e => { assert.ok(e instanceof HlError, `expected HlError, got: ${e.message}`); assert.strictEqual(e.status, status, e.message); assert.match(e.message, re); return true; });
  return { hl, state, keystore, service, addr, enableAll, refused, dir };
}

describe('hyperliquid service: gate and owner controls', () => {
  it('is inert by default: testnet, disabled, every tool off and dry-run; settings never leak keys', () => {
    const r = rig(); const s = r.hl.settings();
    assert.deepStrictEqual([s.env, s.enabled, s.agent, s.tools.hl_order.enabled, s.tools.hl_order.dryRun, s.caps.maxLeverage], ['testnet', false, null, false, true, 3]);
    assert.strictEqual(fs.statSync(r.hl.file).mode & 0o777, 0o600);
  });
  it('read-only tools work while disabled; signing tools refuse when disabled, tool off, paused or locked', async () => {
    const r = rig(); assert.strictEqual((await r.hl.balances()).perp.accountValueUsd, 150);
    await r.refused(r.hl.order({ agent: 'trader', coin: 'ETH', side: 'buy', size: 0.01 }), 403, /disabled/);
    r.hl.configure({ enabled: true }); await r.refused(r.hl.order({ agent: 'trader', coin: 'ETH', side: 'buy', size: 0.01 }), 403, /not enabled/);
    const p = rig({ paused: true }); p.enableAll(); await p.refused(p.hl.order({ agent: 'trader', coin: 'ETH', side: 'buy', size: 0.01 }), 403, /PAUSED/);
    const l = rig({ unlocked: false }); l.enableAll(); await l.refused(l.hl.order({ agent: 'trader', coin: 'ETH', side: 'buy', size: 0.01 }), 409, /locked/);
    assert.ok(r.state.audit.every(a => a.result.refused === true));
  });
  it('owner gate, config validation, allow-lists', () => {
    const r = rig();
    assert.throws(() => r.hl.ownerGate({ passphrase: 'wrong' }), /Owner check failed/); assert.doesNotThrow(() => r.hl.ownerGate({ passphrase: 'pass pass pass 1' }));
    assert.throws(() => r.hl.ownerGate({}), /Owner check failed/); assert.throws(() => r.hl.ownerGate({ token: 'wx_bogus' }), /Owner check failed/);
    assert.throws(() => r.hl.ownerGate({ token: 'wx_current_executor_token' }), /Owner check failed/, 'the executor token is held by the trading agent, so it is not proof of ownership');
    const src = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    assert.match(src, /hl\.ownerGate\(\{ passphrase \}\)/, 'HL owner routes take only the passphrase');
    assert.match(src, /ex\.ownerGate\(\{ passphrase \}\)/, 'executor owner routes take only the passphrase');
    assert.ok(!/ownerGate\(\{[^}]*x-executor-token/.test(src), 'no owner route reads X-Executor-Token');
    for (const p of ["ownerProof('UNPAUSE'", "ownerProof('WALLET_CREATE'", "ownerProof('WALLET_IMPORT'", 'delete patch.walletAgents']) assert.ok(src.includes(p), `server.js must contain ${p}`);
    const svcSrc = fs.readFileSync(path.join(__dirname, '../lib/wallet/hyperliquid.js'), 'utf8');
    assert.ok(!/tokenCheck: \(t\)/.test(svcSrc), 'the live service no longer wires the executor token in as owner proof');
    assert.throws(() => r.hl.configure({ env: 'devnet' }), /env must/); assert.throws(() => r.hl.configure({ caps: { maxLeverage: 2.5 } }), /whole/); assert.throws(() => r.hl.configure({ hlpVault: 'nope' }), /pinned in code/);
    assert.throws(() => r.hl.configure({ hlpVault: null }), /pinned in code/);
    assert.deepStrictEqual(r.hl.configure({ perps: 'eth, sol ,eth' }).perps, ['ETH', 'SOL']);
  });
  it('setupAgent creates hl-agent-<env> in the keystore and posts approveAgent signed by the MAIN key', async () => {
    const r = rig(); const a = await r.hl.setupAgent();
    assert.strictEqual(a.wallet, 'hl-agent-testnet'); assert.strictEqual(a.address, r.addr('hl-agent-testnet')); assert.strictEqual(a.main, r.addr('bot'));
    const post = r.state.posted[0]; assert.strictEqual(post.action.type, 'approveAgent'); assert.strictEqual(post.action.agentAddress, a.address); assert.strictEqual(post.action.hyperliquidChain, 'Testnet');
    assert.ok(post.signature.r && post.signature.s && [27, 28].includes(post.signature.v));
    assert.ok(r.state.audit.some(x => x.action === 'HL_AGENT_APPROVED'));
    const again = await r.hl.setupAgent(); assert.strictEqual(again.address, a.address, 'same agent wallet reused');
  });
  it('approveExternalAgent: a bot\'s own key is approved by address + name, signed by the MAIN key, verified against extraAgents, recorded and audited; the hub\'s own agent is untouched', async () => {
    const r = rig(); await r.hl.setupAgent(); r.state.posted.length = 0;
    const ext = privateKeyToAccount(generatePrivateKey()).address;
    await assert.rejects(r.hl.approveExternalAgent({ agentAddress: '0x123', agentName: 'x' }), /40-hex/);
    await assert.rejects(r.hl.approveExternalAgent({ agentAddress: ext, agentName: '' }), /agentName/);
    await assert.rejects(r.hl.approveExternalAgent({ agentAddress: ext, agentName: 'agenthub-testnet' }), /hub's own agent name/);
    await assert.rejects(r.hl.approveExternalAgent({ agentAddress: r.addr('hl-agent-testnet'), agentName: 'dup' }), /already approved/);
    await assert.rejects(r.hl.approveExternalAgent({ agentAddress: r.addr('bot'), agentName: 'self' }), /cannot be its own agent/);
    assert.strictEqual(r.state.posted.length, 0, 'nothing posted for refused input');
    const a = await r.hl.approveExternalAgent({ agentAddress: ext, agentName: 'trader-own' });
    assert.deepStrictEqual([a.address, a.name, a.main, a.env, a.verified], [ext, 'trader-own', r.addr('bot'), 'testnet', true]);
    const post = r.state.posted[0];
    assert.deepStrictEqual([post.action.type, post.action.agentAddress, post.action.agentName, post.action.hyperliquidChain], ['approveAgent', ext, 'trader-own', 'Testnet']);
    assert.ok(post.signature.r && post.signature.s && [27, 28].includes(post.signature.v));
    assert.ok(Array.isArray(a.agents) && a.agents.some(x => x.address === ext && x.name === 'trader-own'));
    assert.ok(r.state.audit.some(x => x.action === 'HL_EXTERNAL_AGENT_APPROVED' && x.result && x.result.ok === true), 'audited');
    const s = r.hl.settings(); assert.strictEqual(s.agent.address, r.addr('hl-agent-testnet'), 'hub agent record unchanged');
    const st = await r.hl.status(); assert.ok(Array.isArray(st.externalAgents) && st.externalAgents.some(x => x.address === ext), 'status lists the exchange\'s agents');
    // the exchange refusing is reported and audited as a failure
    r.state.fail.exchange = true;
    const origFetch = r.hl.fetch; r.hl.fetch = async (url, init) => url.endsWith('/exchange') ? { ok: true, json: async () => ({ status: 'err', response: 'User or API Wallet does not exist' }) } : origFetch(url, init);
    await assert.rejects(r.hl.approveExternalAgent({ agentAddress: privateKeyToAccount(generatePrivateKey()).address, agentName: 'second' }), /rejected the action/);
    assert.ok(r.state.audit.some(x => x.action === 'HL_EXTERNAL_AGENT_APPROVED' && x.result && x.result.ok === false));
    const locked = rig({ unlocked: false });
    await assert.rejects(locked.hl.approveExternalAgent({ agentAddress: ext, agentName: 'n' }), /Unlock the keystore/);
  });
});

describe('hyperliquid service: orders, caps, invariants', () => {
  it('a market buy becomes an IOC limit at mid+slippage, rounded to the market rules, isolated leverage set first, signed by the agent', async () => {
    const r = rig(); r.enableAll(); await r.hl.setupAgent(); r.state.posted.length = 0;
    const out = await r.hl.order({ agent: 'trader', coin: 'eth', side: 'buy', size: 0.01234, price: 'market', slippageBps: 100, leverage: 2 });
    assert.deepStrictEqual([out.ok, out.tif, out.size, out.price, out.leverage, out.marginMode, out.state, out.oid], [true, 'Ioc', 0.0123, 2775, 2, 'isolated', 'resting', 77]);
    assert.deepStrictEqual(r.state.posted.map(p => p.action.type), ['updateLeverage', 'order']);
    assert.deepStrictEqual(r.state.posted[0].action, { type: 'updateLeverage', asset: 1, isCross: false, leverage: 2 });
    assert.deepStrictEqual(r.state.posted[1].action.orders[0], { a: 1, b: true, p: '2775', s: '0.0123', r: false, t: { limit: { tif: 'Ioc' } } });
    assert.ok(r.state.posted[1].nonce > r.state.posted[0].nonce, 'nonces strictly increase');
  });
  it('caps: notional, leverage, open positions, allow-list, far-from-mid price; reduce-only may close', async () => {
    const r = rig({ positions: [1, 2, 3, 4].map(i => ({ position: { coin: 'X' + i, szi: '1', leverage: { type: 'isolated', value: 1 } } })) }); r.enableAll(); await r.hl.setupAgent();
    await r.refused(r.hl.order({ agent: 'trader', coin: 'ETH', side: 'buy', size: 1 }), 403, /notional .* exceeds/);
    await r.refused(r.hl.order({ agent: 'trader', coin: 'ETH', side: 'buy', size: 0.01, leverage: 5 }), 403, /Leverage 5x exceeds/);
    await r.refused(r.hl.order({ agent: 'trader', coin: 'ETH', side: 'buy', size: 0.01 }), 403, /Open-position cap/);
    await r.refused(r.hl.order({ agent: 'trader', coin: 'SOL', side: 'buy', size: 0.01 }), 403, /allow-list/);
    await r.refused(r.hl.order({ agent: 'trader', coin: 'ETH', side: 'buy', size: 0.01, price: 1000 }), 409, /25% from the mid/);
    const ok = await r.hl.order({ agent: 'trader', coin: 'ETH', side: 'sell', size: 0.5, reduceOnly: true, price: 2700 }); assert.strictEqual(ok.reduceOnly, true, 'reduce-only bypasses notional and position caps');
    assert.strictEqual(r.state.sent.length, 0, 'orders never touch the EVM signer');
  });
  it('dry run validates and signs but never submits; without an agent key it validates only', async () => {
    const r = rig(); r.enableAll({ tools: { hl_order: { enabled: true, dryRun: true } } });
    const v = await r.hl.order({ agent: 'trader', coin: 'ETH', side: 'buy', size: 0.01, price: 2700 });
    assert.deepStrictEqual([v.dryRun, v.signed, r.state.posted.length], [true, false, 0]);
    await r.hl.setupAgent(); r.state.posted.length = 0;
    const s = await r.hl.order({ agent: 'trader', coin: 'ETH', side: 'buy', size: 0.01, price: 2700, dryRun: false });
    assert.deepStrictEqual([s.dryRun, s.signed, r.state.posted.length], [true, true, 0], "owner's dry-run default wins and nothing is posted");
  });
  it('spot asset ids never come from the array position; inconsistent spotMeta refuses every spot market', async () => {
    const r = rig(); const m = await r.hl.meta();
    assert.strictEqual(m.spots.HYPE.asset, 10107); assert.strictEqual(m.spots.HYPE.pair, '@107'); assert.strictEqual(m.spots.FOO.asset, 10072);
    assert.strictEqual(m.perps.HYPE.asset, 2, 'perp ids are still the array position, as the API defines them');
    const noIndex = rig({ spotUniverse: [{ name: '@107', tokens: [1, 0] }] });
    await assert.rejects(() => noIndex.hl.meta(), /pair @107 has no integer index; refusing to map spot markets/);
    const skewed = rig({ spotUniverse: [{ name: '@107', tokens: [1, 0], index: 105 }] }); skewed.enableAll(); await skewed.hl.setupAgent(); skewed.state.posted.length = 0;
    await assert.rejects(() => skewed.hl.meta(), /pair @107 carries index 105; refusing to map spot markets/);
    await assert.rejects(() => skewed.hl.order({ agent: 'trader', coin: 'HYPE', side: 'buy', size: 1.5, price: 95, spot: true }), /refusing to map spot markets/);
    assert.strictEqual(skewed.state.posted.length, 0, 'nothing reaches the exchange');
  });
  it('spot orders use asset 10000+index and the spot allow-list; exchange errors surface', async () => {
    const r = rig(); r.enableAll(); await r.hl.setupAgent(); r.state.posted.length = 0;
    const o = await r.hl.order({ agent: 'trader', coin: 'HYPE', side: 'buy', size: 1.5, price: 95, spot: true });
    assert.strictEqual(r.state.posted[0].action.orders[0].a, 10107, 'asset id comes from the pair index (107), not its array position (1)'); assert.strictEqual(o.market, 'spot'); assert.strictEqual(o.leverage, null);
    r.state.orderStatus = { error: 'Insufficient margin' };
    await r.refused(r.hl.order({ agent: 'trader', coin: 'ETH', side: 'buy', size: 0.01, price: 2700 }), 409, /Insufficient margin/);
  });
  it('cancel by oid and cancel-all', async () => {
    const r = rig(); r.enableAll(); await r.hl.setupAgent(); r.state.posted.length = 0;
    assert.strictEqual((await r.hl.cancel({ agent: 'trader', coin: 'ETH', oid: 5 })).cancelled, 1);
    assert.deepStrictEqual(r.state.posted[0].action, { type: 'cancel', cancels: [{ a: 1, o: 5 }] });
    assert.strictEqual((await r.hl.cancel({ agent: 'trader', all: true })).cancelled, 1);
  });
});

describe('hyperliquid service: money movement', () => {
  it('deposit: mainnet only, min 5, caps, quote must name the pinned AND Relay-listed depository, dry run sends nothing', async () => {
    const t = rig(); t.enableAll(); await t.refused(t.hl.deposit({ agent: 'trader', usdc: 20 }), 400, /mainnet only/);
    const r = rig({ env: 'mainnet' }); r.enableAll();
    await r.refused(r.hl.deposit({ agent: 'trader', usdc: 3 }), 400, /at least 5/);
    await r.refused(r.hl.deposit({ agent: 'trader', usdc: 300 }), 403, /per call/);
    r.state.quoteTo = '0x1111111111111111111111111111111111111111'; await r.refused(r.hl.deposit({ agent: 'trader', usdc: 20 }), 409, /not the pinned depository/);
    r.state.quoteTo = RELAY.baseDepository; r.state.depository = '0x2222222222222222222222222222222222222222'; await r.refused(r.hl.deposit({ agent: 'trader', usdc: 20 }), 409, /Relay's own listed depository/);
    r.state.depository = RELAY.baseDepository;
    const d = await r.hl.deposit({ agent: 'trader', usdc: 20, dryRun: true }); assert.deepStrictEqual([d.ok, d.dryRun, d.usdcOut, r.state.sent.length, r.state.sent[0].dryRun], [true, true, 18.8, 1, true]);
    r.state.sent.length = 0; const real = await r.hl.deposit({ agent: 'trader', usdc: 20 });
    assert.deepStrictEqual([real.ok, real.relayStatus, real.txHashes.length, r.state.sent.map(s => s.functionName || 'raw')], [true, 'success', 2, ['approve', 'raw']]);
    assert.strictEqual(r.state.sent[0].args[0], RELAY.baseDepository, 'approval goes to the depository only');
    assert.strictEqual(r.hl.settings().depositedToday, 20);
    await r.refused(r.hl.deposit({ agent: 'trader', usdc: 251 }), 403, /per call/); r.hl.configure({ caps: { maxDepositPerCall: 490 } });
    await r.refused(r.hl.deposit({ agent: 'trader', usdc: 490 }), 429, /Daily deposit cap/);
  });
  it('withdraw: only to the main wallet, min 5, within withdrawable and the daily cap, signed by the MAIN key', async () => {
    const r = rig({ withdrawable: '50' }); r.enableAll(); await r.hl.setupAgent(); r.state.posted.length = 0;
    await r.refused(r.hl.withdraw({ agent: 'trader', usdc: 2 }), 400, /at least 5/);
    await r.refused(r.hl.withdraw({ agent: 'trader', usdc: 60 }), 409, /Only 50 USDC is withdrawable/);
    const w = await r.hl.withdraw({ agent: 'trader', usdc: 30 });
    assert.strictEqual(w.destination, r.addr('bot').toLowerCase());
    const post = r.state.posted[0]; assert.strictEqual(post.action.type, 'withdraw3'); assert.strictEqual(post.action.destination, r.addr('bot').toLowerCase()); assert.strictEqual(post.action.amount, '30'); assert.strictEqual(post.nonce, post.action.time);
    assert.strictEqual(r.hl.settings().withdrawnToday, 30);
    r.hl.configure({ caps: { maxWithdrawPerDay: 40 } }); await r.refused(r.hl.withdraw({ agent: 'trader', usdc: 20 }), 429, /Daily withdrawal cap/);
  });
  it('vault: HLP verified by name, deposit capped, dry run never submits; transfer moves perp<->spot', async () => {
    const r = rig({ env: 'mainnet' }); r.enableAll(); await r.hl.setupAgent(); r.state.posted.length = 0;
    const d = await r.hl.vault({ agent: 'trader', action: 'deposit', usd: 50, dryRun: true }); assert.deepStrictEqual([d.dryRun, r.state.posted.length], [true, 0]);
    const v = await r.hl.vault({ agent: 'trader', action: 'deposit', usd: 50 }); assert.deepStrictEqual(r.state.posted[0].action, { type: 'vaultTransfer', vaultAddress: '0xdfc24b077bc1425ad1dea75bcb6f8158e10df303', isDeposit: true, usd: 50000000 });
    await r.refused(r.hl.vault({ agent: 'trader', action: 'deposit', usd: 5000 }), 403, /exceeds the per-action cap/);
    r.state.vaultName = 'Some Other Vault'; await r.refused(r.hl.vault({ agent: 'trader', action: 'withdraw', usd: 10 }), 409, /not the HLP vault/);
    const t = rig(); t.enableAll(); await t.hl.setupAgent(); await t.refused(t.hl.vault({ agent: 'trader', action: 'deposit', usd: 10 }), 403, /No HLP vault is pinned for testnet; hl_vault is mainnet-only/);
    const x = await t.hl.transfer({ agent: 'trader', amount: 12.5, toPerp: false }); assert.strictEqual(x.direction, 'perp -> spot');
    const last = t.state.posted[t.state.posted.length - 1]; assert.deepStrictEqual([last.action.type, last.action.amount, last.action.toPerp], ['usdClassTransfer', '12.5', false]);
  });
  it('market data and status are read-only summaries', async () => {
    const r = rig(); const m = await r.hl.market({ coin: 'BTC' });
    assert.deepStrictEqual([m.midPx, m.fundingHourly, m.bestBid.px, m.maxLeverage], [86161, 0.0000125, 2747.4, 40]);
    const s = await r.hl.status(); assert.strictEqual(s.account.accountValueUsd, 150); assert.strictEqual(s.paused, false);
  });
  it('status, balances and positions report HLP vault equity and spot balances', async () => {
    const r = rig({ env: 'mainnet' }); const s = await r.hl.status();
    assert.deepStrictEqual([s.account.hlpVaultEquityUsd, s.account.hlpVaultLockedUntil, s.account.vaults.length], [5.01, new Date(1_700_000_000_000 + 4 * 86400e3).toISOString(), 1]);
    const b = await r.hl.balances(); assert.strictEqual(b.vaults[0].equityUsd, 5.01); assert.deepStrictEqual(b.spot, [{ coin: 'USDC', total: 20, hold: 0 }], 'zero balances dropped');
    const p = await r.hl.positions(); assert.deepStrictEqual(p.spot, [{ coin: 'USDC', total: 20, hold: 0 }]); assert.ok('positions' in p && 'openOrders' in p);
    const t = rig(); t.state.vaultEquities = null; const ts = await t.hl.status(); assert.strictEqual(ts.account.hlpVaultEquityUsd, 0, 'no HLP on testnet: zero, not an error');
  });
});

describe('hyperliquid service: verifier review items', () => {
  it('deposit: the USDC approval is revoked when the bridge call reverts, and the error says so', async () => {
    const r = rig({ env: 'mainnet' }); r.enableAll(); r.state.fail['hl-deposit relay'] = 'revert';
    await r.refused(r.hl.deposit({ agent: 'trader', usdc: 20 }), 500, /did not confirm.*approval to 0x4cd0.*was revoked/s);
    const steps = r.state.sent.map(t => t._meta.step); assert.deepStrictEqual(steps, ['hl-deposit approve', 'hl-deposit relay', 'hl-deposit revoke']);
    assert.deepStrictEqual(r.state.sent[2].args, [RELAY.baseDepository, 0n], 'approve(depository, 0)');
    assert.strictEqual(r.hl.settings().depositedToday, 0, 'nothing in the ledger');
  });
  it('deposit: a failed revoke is reported loudly with the exact fix; a thrown bridge error also revokes', async () => {
    const r = rig({ env: 'mainnet' }); r.enableAll(); r.state.fail['hl-deposit relay'] = 'throw'; r.state.fail['hl-deposit revoke'] = 'throw';
    await assert.rejects(r.hl.deposit({ agent: 'trader', usdc: 20 }), /RPC unreachable.*STILL STANDING.*approve\(0x4cd0[0-9a-f]+, 0\)/s);
    assert.deepStrictEqual(r.state.sent.map(t => t._meta.step), ['hl-deposit approve', 'hl-deposit relay', 'hl-deposit revoke']);
  });
  it('deposit: when the bridge simulation fails right after the approval, it is retried after a pause; persistent failure revokes', async () => {
    const r = rig({ env: 'mainnet' }); r.enableAll(); r.state.fail['hl-deposit relay'] = 1;
    const d = await r.hl.deposit({ agent: 'trader', usdc: 20 }); assert.strictEqual(d.ok, true);
    assert.deepStrictEqual(r.state.sent.map(t => t._meta.step + (t._meta.attempt ? '#' + t._meta.attempt : '')), ['hl-deposit approve', 'hl-deposit relay#1', 'hl-deposit relay#2']);
    assert.deepStrictEqual(r.state.sleeps, [3000]);
    const p = rig({ env: 'mainnet' }); p.enableAll(); p.state.fail['hl-deposit relay'] = 9;
    await assert.rejects(p.hl.deposit({ agent: 'trader', usdc: 20 }), /Simulation failed.*was revoked/s);
    assert.deepStrictEqual(p.state.sent.map(t => t._meta.step), ['hl-deposit approve', 'hl-deposit relay', 'hl-deposit relay', 'hl-deposit relay', 'hl-deposit revoke']);
    assert.deepStrictEqual(p.state.sleeps, [3000, 3000], 'three attempts, two pauses');
  });
  it('caps are not racy: overlapping signing calls run one at a time, so the second sees the first in the ledger', async () => {
    const r = rig({ env: 'mainnet' }); r.enableAll(); r.hl.configure({ caps: { maxDepositPerCall: 300, maxDepositPerDay: 500 } });
    const results = await Promise.allSettled([r.hl.deposit({ agent: 'trader', usdc: 300 }), r.hl.deposit({ agent: 'trader', usdc: 300 })]);
    assert.deepStrictEqual(results.map(x => x.status), ['fulfilled', 'rejected'], results.map(x => x.reason && x.reason.message).join(' | '));
    assert.strictEqual(results[1].reason.status, 429); assert.match(results[1].reason.message, /already 300\.00 today/);
    assert.strictEqual(r.hl.settings().depositedToday, 300);
    const w = rig({ env: 'mainnet', withdrawable: '5000' }); w.enableAll(); w.hl.configure({ caps: { maxWithdrawPerDay: 1000 } });
    const ws = await Promise.allSettled([w.hl.withdraw({ agent: 'trader', usdc: 600 }), w.hl.withdraw({ agent: 'trader', usdc: 600 })]);
    assert.deepStrictEqual(ws.map(x => x.status), ['fulfilled', 'rejected'], ws.map(x => x.reason && x.reason.message).join(' | ')); assert.strictEqual(ws[1].reason.status, 429);
    const o = rig(); o.enableAll(); o.hl.configure({ caps: { maxOpenPositions: 1 } }); await o.hl.setupAgent();
    // two new positions on different coins at once: the exchange still reports none open, so only the queue can catch the second
    let opened = 0; const origFetch = o.hl.fetch;
    o.hl.fetch = async (url, init) => { const body = init && init.body ? JSON.parse(init.body) : null; if (url.endsWith('/exchange') && body.action.type === 'order') opened++; if (url.endsWith('/info') && body.type === 'clearinghouseState' && opened) return { ok: true, status: 200, json: async () => ({ marginSummary: { accountValue: '150', totalMarginUsed: '10', totalNtlPos: '30' }, withdrawable: '100', assetPositions: [{ position: { coin: 'ETH', szi: '0.01', leverage: { type: 'isolated', value: 1 } } }] }) }; return origFetch(url, init); };
    const os = await Promise.allSettled([o.hl.order({ agent: 'trader', coin: 'ETH', side: 'buy', size: 0.01 }), o.hl.order({ agent: 'trader', coin: 'BTC', side: 'buy', size: 0.001 })]);
    assert.deepStrictEqual(os.map(x => x.status), ['fulfilled', 'rejected'], os.map(x => x.reason && x.reason.message).join(' | ')); assert.match(os[1].reason.message, /Open-position cap reached/);
  });
  it('the Relay USDC sentinel is documented with its source', () => {
    const src = fs.readFileSync(path.join(__dirname, '../lib/wallet/hyperliquid.js'), 'utf8');
    assert.match(src, /chains\[id=1337\]\.currency[^\n]*USDC \(Perps\)[^\n]*0x00000000000000000000000000000000/);
  });
});

describe('hyperliquid settings: the pinned vault', () => {
  it('configure ignores an empty or unchanged hlpVault (the panel echoes it back) and refuses only a real change', () => {
    const r = rig({ env: 'mainnet' });
    const pinned = RELAY && require('../lib/wallet/hyperliquid').HyperliquidService ? r.hl.settings().hlpVault : null;
    assert.ok(pinned, 'mainnet has a pinned vault');
    assert.doesNotThrow(() => r.hl.configure({ hlpVault: '' }));
    assert.doesNotThrow(() => r.hl.configure({ hlpVault: pinned }));
    assert.doesNotThrow(() => r.hl.configure({ hlpVault: pinned.toUpperCase().replace('0X', '0x') }));
    assert.throws(() => r.hl.configure({ hlpVault: '0x0000000000000000000000000000000000000001' }), /pinned in code/);
  });
});
