'use strict';

/**
 * service.js — on-chain wallet operations for the hub's trading agent.
 *
 * Owner's risk model: losses are capped by what each wallet holds, and (since
 * 2026-09-22) by the SIGNING FIREWALL in lib/wallet/firewall.js: every transaction,
 * dry run or not, must pay an allow-listed strategy contract with calldata whose
 * recipients are the wallet itself, or send plain ETH to the owner (settings.walletOwner)
 * or the wallet itself. Nothing else is simulated, let alone signed. There are no
 * spend limits; the agent decides sizes on its own. What this layer adds is the
 * machinery that stops money being lost to MISTAKES rather than to decisions:
 *
 *   - firewall first: `to` in the address book, calldata decoded, recipients checked
 *   - simulate first: every transaction is eth_call'd and gas-estimated from the
 *     wallet's address before signing; one that would revert is refused
 *   - dryRun: do everything except sign and broadcast (paper trading)
 *   - swaps go through one DEX aggregator, with a slippage cap, exact-amount token
 *     approvals, and a PINNED router address (a compromised API cannot redirect funds)
 *   - a pause switch that blocks every broadcast
 *   - an append-only audit log of every request, exportable as CSV
 *   - an alert when a wallet's balance drops without the hub having sent anything
 *     (the sign of a leaked key: refilling that wallet would just refill the thief)
 *
 * Private keys never leave lib/wallet/keystore.js except inside withPrivateKey().
 */

const fs = require('fs');
const path = require('path');
const { Firewall, FirewallError, OWNER } = require('./firewall');

const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const NETWORKS = {
  base: {
    chainId: 8453, name: 'Base', explorer: 'https://basescan.org',
    rpcs: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
    aggregator: { api: 'https://aggregator-api.kyberswap.com/base/api/v1', router: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5' },
    tokens: { ETH: NATIVE, WETH: '0x4200000000000000000000000000000000000006', USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
              USDBC: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', DAI: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', CBBTC: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf' },
  },
  'base-sepolia': {
    chainId: 84532, name: 'Base Sepolia (testnet)', explorer: 'https://sepolia.basescan.org',
    rpcs: ['https://sepolia.base.org'], aggregator: null,
    tokens: { ETH: NATIVE, WETH: '0x4200000000000000000000000000000000000006' },
  },
  // Hyperliquid's bridge chain: withdrawals from the exchange arrive here as USDC. No swaps in v1.
  arbitrum: {
    chainId: 42161, name: 'Arbitrum One (real money)', explorer: 'https://arbiscan.io',
    rpcs: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'], aggregator: null,
    tokens: { ETH: NATIVE, WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', USDCE: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8' },
  },
  // Recovery only: funds sent to a wallet's address on Zora by mistake. No swaps; bridge them to Base.
  zora: {
    chainId: 7777777, name: 'Zora (recovery only, real money)', explorer: 'https://explorer.zora.energy',
    rpcs: ['https://rpc.zora.energy'], aggregator: null,
    tokens: { ETH: NATIVE },
  },
};
const VIEM_CHAINS = { base: 'base', 'base-sepolia': 'baseSepolia', zora: 'zora', arbitrum: 'arbitrum' };
const DEFAULT_SLIPPAGE_BPS = 50;      // 0.5%
const MAX_SLIPPAGE_BPS = 2000;        // refuse obviously fat-fingered values (20%)
// KyberSwap's /route/build rounds minReturnAmount a few wei BELOW the exact quote*(10000-bps)/10000 (seen 1 wei low on
// every live Base build: 363319356924986 vs exact 363319356924987). One extra bps of tolerance absorbs that rounding;
// a build that lowers minReturnAmount by more than a rounding unit is still refused.
const FLOOR_TOLERANCE_BPS = 1;
// Open-wallet rules (tier 'open'): the selectors that are decoded, and the ones refused outright.
const OPEN_SELECTORS = { '0xa9059cbb': 'transfer', '0x23b872dd': 'transferFrom', '0x095ea7b3': 'approve', '0x39509351': 'increaseAllowance', '0xa22cb465': 'setApprovalForAll' };
const OPEN_REFUSED_SELECTORS = { '0xd505accf': 'permit (ERC-2612)', '0x87517c45': 'Permit2 approve', '0x2b67b570': 'Permit2 permit', '0x2a2d80d1': 'Permit2 permit (batch)' };
const OPEN_APPROVAL_ABI = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'increaseAllowance', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'addedValue', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'setApprovalForAll', stateMutability: 'nonpayable', inputs: [{ name: 'operator', type: 'address' }, { name: 'approved', type: 'bool' }], outputs: [] },
];
const OUTFLOW_GRACE_MS = 10 * 60 * 1000;

function viemClients(netKey) {
  const viem = require('viem'); const chains = require('viem/chains'); const { privateKeyToAccount } = require('viem/accounts');
  const net = NETWORKS[netKey]; const chain = chains[VIEM_CHAINS[netKey]];
  const transport = viem.fallback(net.rpcs.map(u => viem.http(u, { timeout: 15000, retryCount: 2 })));
  const pub = viem.createPublicClient({ chain, transport });
  return { public: pub, walletFor: pk => viem.createWalletClient({ account: privateKeyToAccount(pk), chain, transport }) };
}

class WalletService {
  /**
   * @param {object} o
   * @param {string} o.dataDir
   * @param {import('./keystore').Keystore} o.keystore
   * @param {(net:string)=>{public:any, walletFor:(pk:string)=>any}} [o.clientFactory]  injectable for tests
   * @param {Function} [o.fetchImpl]
   */
  constructor({ dataDir, keystore, clientFactory = viemClients, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), firewall } = {}) {
    this.dataDir = dataDir; this.keystore = keystore; this.fetch = fetchImpl; this.now = now;
    this._clientFactory = clientFactory; this._clients = {};
    this.auditFile = path.join(dataDir, 'wallet-audit.jsonl');
    this.stateFile = path.join(dataDir, 'wallet-state.json');
    this.allowlistFile = path.join(dataDir, 'wallet-allowlist.json');
    this.firewall = firewall || new Firewall({ file: this.allowlistFile, keystore, now });
    this._decimals = new Map(); this._lastHubTx = new Map(); this._snapshot = new Map(); this.alerts = [];
  }

  // ── plumbing ──
  net(key = 'base') { const k = String(key || 'base').toLowerCase(); if (!NETWORKS[k]) throw new Error(`Unknown network "${key}". Use one of: ${Object.keys(NETWORKS).join(', ')}.`); return { key: k, ...NETWORKS[k] }; }
  clients(key) { return this._clients[key] || (this._clients[key] = this._clientFactory(key)); }
  _state() { let s = { paused: false }; try { s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { /* fresh */ } if (!s.wallets || typeof s.wallets !== 'object') s.wallets = {}; return s; }
  /** Global pause, or the named wallet's own pause. No wallet name: the global switch only. */
  isPaused(wallet = null) { const s = this._state(); return !!s.paused || !!(wallet && s.wallets[wallet] && s.wallets[wallet].paused); }
  pausedWallets() { const s = this._state(); return Object.keys(s.wallets).filter(n => s.wallets[n] && s.wallets[n].paused); }
  /** Pause or resume everything (wallet = null) or one wallet by name. */
  setPaused(paused, by = 'owner', wallet = null) {
    const s = this._state(); const at = new Date(this.now()).toISOString();
    if (wallet) { this.walletAddress(wallet); s.wallets[wallet] = { paused: !!paused, at, by }; }
    else { s.paused = !!paused; s.at = at; s.by = by; }
    fs.mkdirSync(this.dataDir, { recursive: true }); fs.writeFileSync(this.stateFile, JSON.stringify(s));
    this.audit(by, paused ? 'PAUSE' : 'RESUME', wallet ? { wallet } : {}, { ok: true }); return !!paused;
  }

  audit(agent, action, params, result) {
    const row = { ts: new Date(this.now()).toISOString(), agent: agent || 'unknown', action, params, ...result };
    try { fs.mkdirSync(this.dataDir, { recursive: true }); fs.appendFileSync(this.auditFile, JSON.stringify(row, (k, v) => typeof v === 'bigint' ? v.toString() : v) + '\n', { mode: 0o600 }); } catch { /* an audit failure must not break trading or hide the original error */ }
    return row;
  }
  auditCsv() {
    let rows = []; try { rows = fs.readFileSync(this.auditFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { /* none yet */ }
    const cols = ['ts', 'agent', 'action', 'network', 'wallet', 'ok', 'dryRun', 'txHash', 'status', 'tokenIn', 'amountIn', 'tokenOut', 'amountOut', 'feeEth', 'to', 'valueEth', 'error'];
    const cell = v => { const s = v === undefined || v === null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return [cols.join(',')].concat(rows.map(r => cols.map(c => cell(r[c] !== undefined ? r[c] : (r.params || {})[c])).join(','))).join('\n') + '\n';
  }

  resolveToken(net, t) {
    const viem = require('viem'); const s = String(t || '').trim();
    if (!s) throw new Error('Token is required (symbol or 0x address).');
    if (net.tokens[s.toUpperCase()]) return net.tokens[s.toUpperCase()];
    if (viem.isAddress(s)) return viem.getAddress(s);
    throw new Error(`Unknown token "${t}" on ${net.name}. Known symbols: ${Object.keys(net.tokens).join(', ')}. Any other token: pass its 0x contract address.`);
  }
  async decimals(net, token) {
    if (token === NATIVE) return 18;
    const k = net.key + ':' + token; if (this._decimals.has(k)) return this._decimals.get(k);
    const d = Number(await this.clients(net.key).public.readContract({ address: token, abi: require('viem').erc20Abi, functionName: 'decimals' }));
    this._decimals.set(k, d); return d;
  }
  walletAddress(name) { return this.walletInfo(name).address; }
  /** The keystore's view of a wallet: { name, address, tier ('guarded' | 'open'), fundingCapUsd, tierVerified, ... }. */
  walletInfo(name) { const w = this.keystore.list().find(x => x.name === name); if (!w) throw new Error(`No wallet named "${name}". Wallets: ${this.keystore.list().map(x => x.name).join(', ') || '(none yet: the owner creates them in the Wallet panel)'}.`); return w; }
  /** The keystore wallet that owns `address`, if any (any tier). */
  _walletAt(address) { const a = String(address || '').toLowerCase(); return this.keystore.list().find(w => String(w.address).toLowerCase() === a) || null; }

  // ── open wallets: no signing firewall, only the theft primitives are checked ──
  /**
   * The rules for a wallet of tier 'open'. Synchronous except for the "contract with code" test.
   * Refuses (FirewallError) when: plain ETH goes anywhere but the owner or a keystore wallet;
   * an ERC-20 transfer/transferFrom pays anyone but the owner or a keystore wallet; an approval
   * (approve / increaseAllowance / setApprovalForAll) names a spender that is not an active,
   * verified address-book router or executor on that chain; the calldata is a permit / Permit2
   * call; or ETH rides along a call to an address without code. Everything else is allowed.
   */
  async _checkOpen({ net, wallet, from, to, value = 0n, data } = {}) {
    const viem = require('viem');
    const no = why => { throw new FirewallError(`open wallet "${wallet}": ${why}`); };
    const lc = a => String(a || '').toLowerCase();
    const hex = data === undefined || data === null ? '' : String(data);
    if (hex && !/^0x[0-9a-fA-F]*$/.test(hex)) no('calldata is not valid hex');
    const bytes = hex.replace(/^0x/, ''); if (bytes.length % 2) no('calldata has an odd number of hex digits');
    const trusted = a => (!!OWNER && lc(a) === lc(OWNER)) || !!this._walletAt(a);
    const who = a => lc(a) === lc(OWNER) ? 'the owner' : (this._walletAt(a) || {}).name ? `keystore wallet "${this._walletAt(a).name}"` : a;
    if (!bytes.length) {
      if (!trusted(to)) no(`plain ETH may only go to the owner (${OWNER}) or another wallet in this keystore, not to ${to}.`);
      return { rule: 'open:eth-to-' + (lc(to) === lc(OWNER) ? 'owner' : 'keystore') };
    }
    const sel = ('0x' + bytes.slice(0, 8)).toLowerCase();
    const dec = abi => { try { return viem.decodeFunctionData({ abi, data: hex }); } catch (e) { no(`calldata for ${OPEN_SELECTORS[sel]} could not be decoded: ${e.shortMessage || e.message}`); } };
    if (sel === '0xa9059cbb' || sel === '0x23b872dd') {                       // transfer(to,amount) / transferFrom(from,to,amount)
      const d = dec(viem.erc20Abi); const recipient = sel === '0xa9059cbb' ? d.args[0] : d.args[1];
      if (!trusted(recipient)) no(`ERC-20 ${d.functionName} may only pay the owner (${OWNER}) or another wallet in this keystore, not ${recipient}.`);
      return { rule: `open:${d.functionName}-to-${lc(recipient) === lc(OWNER) ? 'owner' : 'keystore'}`, recipient, token: to, amount: d.args[d.args.length - 1] };
    }
    if (sel === '0x095ea7b3' || sel === '0x39509351' || sel === '0xa22cb465') { // approve / increaseAllowance / setApprovalForAll
      const d = dec(OPEN_APPROVAL_ABI); const spender = d.args[0];
      const e = this.firewall.book().find(x => x.active && x.verified !== 'locked' && lc(x.address) === lc(spender) && String(x.chainId) === String(net.chainId));
      if (!e || !['router', 'executor'].includes(e.role)) no(`${d.functionName} spender ${spender} is not an allow-listed router or executor on ${net.name}${e ? ` (it is listed as ${e.role})` : ''}. Add it to the address book with role router or executor first.`);
      return { rule: `open:${d.functionName}-${e.role}`, spender, label: e.label };
    }
    if (OPEN_REFUSED_SELECTORS[sel]) no(`${OPEN_REFUSED_SELECTORS[sel]} is refused for open wallets for now (signature-based approvals).`);
    const val = BigInt(value || 0);
    if (val > 0n && !trusted(to)) {
      let code = '0x'; try { code = (await this.clients(net.key).public.getCode({ address: viem.getAddress(to) })) || '0x'; } catch (e) { no(`could not check whether ${to} is a contract (${e.shortMessage || e.message}); ETH value only goes to contracts with code.`); }
      if (code === '0x' || code.length < 4) no(`ETH value may only ride along a call to a contract with code; ${to} has none (so this would be a plain payment to ${who(to)}).`);
    }
    return { rule: 'open:any-call', selector: sel };
  }
  /**
   * Funding cap: a guarded wallet paying an open wallet (plain ETH, or an ERC-20 transfer) may not
   * push the open wallet's ETH + USDC holdings above the cap the owner set at its creation. Money
   * the open wallet makes may sit above the cap; only inbound funding is capped.
   */
  async _checkFundingCap({ net, from, fromInfo, to, value = 0n, data } = {}) {
    const viem = require('viem');
    const hex = data === undefined || data === null ? '' : String(data); const bytes = hex.replace(/^0x/, '');
    let recipient = null, token = null, amount = 0n;
    if (!bytes.length) { recipient = to; token = NATIVE; amount = BigInt(value || 0); }
    else {
      const sel = ('0x' + bytes.slice(0, 8)).toLowerCase();
      if (sel !== '0xa9059cbb' && sel !== '0x23b872dd') return null;
      let d; try { d = viem.decodeFunctionData({ abi: viem.erc20Abi, data: hex }); } catch { return null; }
      recipient = sel === '0xa9059cbb' ? d.args[0] : d.args[1]; token = viem.getAddress(to); amount = BigInt(d.args[d.args.length - 1]);
    }
    const target = this._walletAt(recipient);
    if (!target || target.tier !== 'open' || amount <= 0n) return null;
    const cap = Number(target.fundingCapUsd);
    const no = why => { throw new FirewallError(`funding cap: ${why}`); };
    const usdc = net.tokens.USDC ? viem.getAddress(net.tokens.USDC) : null;
    const usdOf = async (tok, raw) => {
      if (raw <= 0n) return 0;
      if (usdc && tok === usdc) return Number(viem.formatUnits(raw, 6));
      const q = await this._usdQuote(net, tok, raw);
      if (typeof q !== 'number' || !(q >= 0)) no(`cannot value ${viem.formatUnits(raw, await this.decimals(net, tok))} of ${tok === NATIVE ? 'ETH' : tok} in USD on ${net.name}, so the transfer into open wallet "${target.name}" (cap $${cap}) is refused.`);
      return q;
    };
    const pub = this.clients(net.key).public;
    const inbound = await usdOf(token, amount);
    const held = await usdOf(NATIVE, await pub.getBalance({ address: target.address }))
      + (usdc ? await usdOf(usdc, await pub.readContract({ address: usdc, abi: viem.erc20Abi, functionName: 'balanceOf', args: [target.address] }).catch(() => 0n)) : 0);
    const after = held + inbound;
    if (after > cap + 1e-9) no(`open wallet "${target.name}" would hold about $${after.toFixed(2)} after this transfer (holds ~$${held.toFixed(2)}, receiving ~$${inbound.toFixed(2)}), above its funding cap of $${cap}. Send less, or create a new open wallet with a higher cap.`);
    return { rule: 'funding-cap', target: target.name, fundingCapUsd: cap, heldUsd: +held.toFixed(2), inboundUsd: +inbound.toFixed(2) };
  }
  /** USD value of `raw` units of `token` via the aggregator's quote (base's aggregator when this network has none: ETH is ETH). */
  async _usdQuote(net, token, raw) {
    const viem = require('viem');
    const qnet = net.aggregator ? net : this.net('base');
    const tin = token === NATIVE ? NATIVE : token, tout = qnet.tokens.USDC;
    if (!tout || tin === tout) return null;
    try { const d = await this._agg(qnet, `/routes?tokenIn=${tin}&tokenOut=${tout}&amountIn=${raw}`); const u = Number(d.routeSummary.amountInUsd); return Number.isFinite(u) ? u : null; }
    catch { return null; }
  }

  // ── reads ──
  status() {
    const pw = new Set(this.pausedWallets());
    return { keystore: { exists: this.keystore.exists(), unlocked: this.keystore.isUnlocked(), backupDir: this.keystore.backupDir || null, lastBackup: this.keystore.lastBackup ? this.keystore.lastBackup() : null }, paused: this.isPaused(), pausedWallets: [...pw],
             wallets: this.keystore.list().map(w => ({ ...w, paused: pw.has(w.name), ...(w.tier === 'open' ? { warning: 'OPEN: no signing firewall' } : {}) })),
             networks: Object.fromEntries(Object.entries(NETWORKS).map(([k, n]) => [k, { chainId: n.chainId, name: n.name, swaps: !!n.aggregator, tokens: Object.keys(n.tokens) }])), alerts: this.alerts.slice(-10) };
  }
  async balances({ wallet, tokens = [], network } = {}) {
    const viem = require('viem'); const net = this.net(network); const info = this.walletInfo(wallet); const address = info.address; const pub = this.clients(net.key).public;
    const out = { wallet, address, tier: info.tier, fundingCapUsd: info.fundingCapUsd, ...(info.tier === 'open' ? { warning: 'OPEN: no signing firewall' } : {}), paused: this.isPaused(wallet), network: net.key, balances: {} };
    out.balances.ETH = viem.formatEther(await pub.getBalance({ address }));
    const list = tokens.length ? tokens : Object.keys(net.tokens).filter(s => s !== 'ETH');
    for (const t of list) {
      const token = this.resolveToken(net, t); if (token === NATIVE) continue;
      try { const [raw, dec] = await Promise.all([pub.readContract({ address: token, abi: viem.erc20Abi, functionName: 'balanceOf', args: [address] }), this.decimals(net, token)]); out.balances[String(t).toUpperCase().startsWith('0X') ? token : String(t).toUpperCase()] = viem.formatUnits(raw, dec); }
      catch (e) { out.balances[t] = `error: ${e.shortMessage || e.message}`; }
    }
    return out;
  }
  _abi(abi) { const viem = require('viem'); if (!abi) throw new Error('abi is required: an array of human-readable signatures, e.g. ["function balanceOf(address) view returns (uint256)"], or a JSON ABI.'); return (Array.isArray(abi) && typeof abi[0] === 'string') ? viem.parseAbi(abi) : abi; }
  async readContract({ address, abi, functionName, args = [], network } = {}) {
    const net = this.net(network); const viem = require('viem');
    if (!viem.isAddress(String(address || ''))) throw new Error('address must be a 0x contract address.');
    const r = await this.clients(net.key).public.readContract({ address: viem.getAddress(address), abi: this._abi(abi), functionName, args });
    return JSON.parse(JSON.stringify({ result: r }, (k, v) => typeof v === 'bigint' ? v.toString() : v));
  }

  // ── writes ──
  /**
   * Send any transaction. Either raw `data`, or `abi` + `functionName` + `args`.
   * value: ETH as a decimal string ("0.01"). simulate defaults true; dryRun defaults false.
   */
  async sendTransaction({ agent, wallet, to, value = '0', data, abi, functionName, args = [], network, dryRun = false, simulate = true, _meta = {} } = {}) {
    const viem = require('viem'); const net = this.net(network); const from = this.walletAddress(wallet);
    const params = { network: net.key, wallet, to, valueEth: String(value), functionName: functionName || null, dryRun: !!dryRun, ..._meta };
    try {
      if (!viem.isAddress(String(to || ''))) throw new Error('"to" must be a 0x address.');
      const callData = data || (functionName ? viem.encodeFunctionData({ abi: this._abi(abi), functionName, args }) : undefined);
      const tx = { account: from, to: viem.getAddress(to), value: viem.parseEther(String(value || '0')), data: callData };
      // Signing firewall: before simulation, dry run or not. A refusal is audited under its own action.
      // A guarded wallet runs the full firewall (unchanged). An open wallet runs only the theft-primitive
      // checks; a guarded wallet paying an open one is also held to that open wallet's funding cap.
      const info = this.walletInfo(wallet); params.tier = info.tier;
      if (info.tier === 'open') {
        const fw = await this._checkOpen({ net, wallet, from, to: tx.to, value: tx.value, data: callData });
        params.firewall = fw.rule;
      } else {
        const peers = this.keystore.list().map(w => w.address).filter(a => String(a).toLowerCase() !== String(from).toLowerCase());
        const fw = this.firewall.check({ chainId: net.chainId, from, to: tx.to, value: tx.value, data: callData, peers });
        params.firewall = fw.rule;
        const cap = await this._checkFundingCap({ net, from, fromInfo: info, to: tx.to, value: tx.value, data: callData });
        if (cap) params.fundingCap = cap;
      }
      const pub = this.clients(net.key).public;
      let gas = null, feeEth = null;
      if (simulate || dryRun) {
        try { await pub.call(tx); gas = await pub.estimateGas(tx); }
        catch (e) {
          // The commonest cause by far is an under-funded wallet, and RPCs describe it badly. Say what it holds.
          let held = ''; try { const b = await pub.getBalance({ address: from }); held = ` The wallet holds ${viem.formatEther(b)} ETH and this transaction sends ${viem.formatEther(tx.value)} ETH plus gas` + (b <= tx.value ? ': it is under-funded.' : '.'); } catch { /* advisory */ }
          throw new Error(`Simulation failed, so nothing was sent: ${e.shortMessage || e.message}.${held}`);
        }
        try { const price = await pub.getGasPrice(); feeEth = viem.formatEther(gas * price); } catch { /* fee estimate is advisory */ }
      }
      if (dryRun) return this._done(agent, 'SEND_TX', params, { ok: true, dryRun: true, simulated: true, gasEstimate: gas && gas.toString(), feeEth, note: 'Dry run: simulated successfully against live chain state; NOT signed or broadcast.' });
      if (this.isPaused(wallet)) throw new Error(`Trading is PAUSED by the owner${this.isPaused() ? '' : ` for wallet "${wallet}"`}. Dry runs still work; nothing can be broadcast until it is resumed.`);
      const hash = await this.keystore.withPrivateKey(wallet, pk => this.clients(net.key).walletFor(pk).sendTransaction({ to: tx.to, value: tx.value, data: tx.data, ...(gas ? { gas: gas * 12n / 10n } : {}) }));
      this._lastHubTx.set(from.toLowerCase(), this.now());
      let receipt = null; try { receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90000 }); } catch { /* still pending: report the hash */ }
      const status = receipt ? receipt.status : 'pending';
      return this._done(agent, 'SEND_TX', params, { ok: status !== 'reverted', txHash: hash, status, gasUsed: receipt && receipt.gasUsed.toString(), feeEth, explorer: `${net.explorer}/tx/${hash}`,
        ...(status === 'reverted' ? { error: 'Transaction was mined but REVERTED on-chain (state changed between simulation and inclusion). Gas was spent.' } : {}) });
    } catch (e) {
      this.audit(agent, e instanceof FirewallError ? 'FIREWALL_REFUSED' : 'SEND_TX', params, { ok: false, error: e.message }); throw e;
    }
  }
  _done(agent, action, params, result) { this.audit(agent, action, params, result); return result; }

  // ── swaps (one aggregator, pinned router) ──
  async _agg(net, pathname, init) {
    if (!net.aggregator) throw new Error(`Swaps are not available on ${net.name} (no DEX aggregator / real liquidity there). Use network "base", with dryRun:true to paper-trade.`);
    const res = await this.fetch(net.aggregator.api + pathname, { ...init, headers: { 'Content-Type': 'application/json', 'x-client-id': 'agent-hub', ...(init && init.headers) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.code !== 0) throw new Error(`Aggregator error: ${body.message || 'HTTP ' + res.status}`);
    return body.data;
  }
  async quoteSwap({ tokenIn, tokenOut, amountIn, network } = {}) {
    const viem = require('viem'); const net = this.net(network);
    const tin = this.resolveToken(net, tokenIn), tout = this.resolveToken(net, tokenOut);
    if (tin === tout) throw new Error('tokenIn and tokenOut are the same.');
    const [din, dout] = await Promise.all([this.decimals(net, tin), this.decimals(net, tout)]);
    const raw = viem.parseUnits(String(amountIn), din); if (raw <= 0n) throw new Error('amountIn must be greater than zero.');
    const d = await this._agg(net, `/routes?tokenIn=${tin}&tokenOut=${tout}&amountIn=${raw}`);
    const s = d.routeSummary;
    return { network: net.key, tokenIn: tin, tokenOut: tout, amountIn: String(amountIn), amountOut: viem.formatUnits(BigInt(s.amountOut), dout), amountInUsd: s.amountInUsd, amountOutUsd: s.amountOutUsd, gasUsd: s.gasUsd,
             priceImpactPct: s.amountInUsd > 0 ? +(((s.amountInUsd - s.amountOutUsd) / s.amountInUsd) * 100).toFixed(3) : null, _routeSummary: s, _router: d.routerAddress, _rawIn: raw, _decOut: dout };
  }
  /** Decode the SwapDescriptionV2 out of Kyber router calldata (swap / swapGeneric / swapSimpleMode); throws if it is anything else. */
  _kyberDesc(data) {
    const viem = require('viem'); const { rules } = require('./firewall');
    const hex = String(data || ''); const rule = rules().get(hex.slice(0, 10).toLowerCase());
    if (!rule || !/^swap(Generic|SimpleMode)?$/.test(rule.name)) throw new Error(`REFUSED: the aggregator built calldata for ${rule ? rule.display : 'an unknown function'}, not a Kyber swap.`);
    let d; try { d = viem.decodeFunctionData({ abi: rule.abi, data: hex }); } catch (e) { throw new Error(`REFUSED: the aggregator's calldata could not be decoded: ${e.shortMessage || e.message}`); }
    return rule.name === 'swapSimpleMode' ? d.args[1] : d.args[0].desc;
  }
  async swap({ agent, wallet, tokenIn, tokenOut, amountIn, slippageBps = DEFAULT_SLIPPAGE_BPS, network, dryRun = false } = {}) {
    const viem = require('viem'); const net = this.net(network); const from = this.walletAddress(wallet);
    const bps = Number(slippageBps); const meta = { tokenIn, tokenOut, amountIn: String(amountIn), slippageBps: bps };
    try {
      if (!Number.isInteger(bps) || bps < 1 || bps > MAX_SLIPPAGE_BPS) throw new Error(`slippageBps must be a whole number from 1 to ${MAX_SLIPPAGE_BPS} (50 = 0.5%).`);
      const q = await this.quoteSwap({ tokenIn, tokenOut, amountIn, network: net.key });
      const built = await this._agg(net, '/route/build', { method: 'POST', body: JSON.stringify({ routeSummary: q._routeSummary, sender: from, recipient: from, slippageTolerance: bps }) });
      if (String(built.routerAddress).toLowerCase() !== net.aggregator.router.toLowerCase()) throw new Error(`REFUSED: the aggregator asked to send funds to ${built.routerAddress}, which is not the pinned router ${net.aggregator.router}.`);
      // The calldata the aggregator built must carry the quote it gave us: the router only enforces what
      // is inside the calldata, so a build that silently lowers minReturnAmount or raises the input is refused.
      const desc = this._kyberDesc(built.data);
      const quoteOut = BigInt(q._routeSummary.amountOut), floor = quoteOut * BigInt(10000 - bps - FLOOR_TOLERANCE_BPS) / 10000n;
      if (BigInt(desc.amount) !== q._rawIn) throw new Error(`REFUSED: the built route spends ${desc.amount} of ${q.tokenIn} but the quote was for ${q._rawIn}.`);
      if (BigInt(desc.minReturnAmount) < floor) throw new Error(`REFUSED: the built route's minReturnAmount ${desc.minReturnAmount} is below the quoted floor ${floor} (quote ${quoteOut} minus ${bps} bps and ${FLOOR_TOLERANCE_BPS} bps rounding tolerance); the build does not match the quote.`);
      const minOut = viem.formatUnits(BigInt(desc.minReturnAmount), q._decOut);
      const out = { amountOutExpected: viem.formatUnits(BigInt(built.amountOut), q._decOut), amountOutMin: minOut, priceImpactPct: q.priceImpactPct, gasUsd: built.gasUsd };
      const pub = this.clients(net.key).public;

      if (q.tokenIn !== NATIVE) {                       // ERC-20 in: the router needs an allowance. Exact amount, never unlimited.
        const allowance = await pub.readContract({ address: q.tokenIn, abi: viem.erc20Abi, functionName: 'allowance', args: [from, net.aggregator.router] });
        if (allowance < q._rawIn) {
          if (dryRun) return this._done(agent, 'SWAP', { network: net.key, wallet, ...meta, dryRun: true }, { ok: true, dryRun: true, ...out, needsApproval: true, note: 'Dry run: quote and route are valid. A real swap would first approve exactly this amount to the router, then swap. The swap itself cannot be simulated until that approval exists.' });
          const ap = await this.sendTransaction({ agent, wallet, to: q.tokenIn, abi: viem.erc20Abi, functionName: 'approve', args: [net.aggregator.router, q._rawIn], network: net.key, _meta: { step: 'approve', ...meta } });
          if (!ap.ok || ap.status !== 'success') throw new Error(`Token approval did not confirm (${ap.status}); swap not attempted.`);
        }
      }
      const r = await this.sendTransaction({ agent, wallet, to: net.aggregator.router, data: built.data, value: viem.formatEther(BigInt(built.transactionValue || '0')), network: net.key, dryRun, _meta: { step: 'swap', ...meta, amountOut: out.amountOutExpected } });
      return { ...r, ...out };
    } catch (e) {
      if (!/Simulation failed|PAUSED|approval did not/.test(e.message)) this.audit(agent, 'SWAP', { network: net.key, wallet, ...meta, dryRun: !!dryRun }, { ok: false, error: e.message });
      throw e;
    }
  }

  // ── leaked-key detector ──
  /** Call periodically. Raises an alert if ETH left a wallet and the hub did not send anything recently. */
  async checkOutflows(network = 'base') {
    const viem = require('viem'); const net = this.net(network); const pub = this.clients(net.key).public; const raised = [];
    for (const w of this.keystore.list()) {
      const key = net.key + ':' + w.address.toLowerCase(); let bal; try { bal = await pub.getBalance({ address: w.address }); } catch { continue; }
      const prev = this._snapshot.get(key); this._snapshot.set(key, bal);
      if (prev === undefined || bal >= prev) continue;
      const lastTx = this._lastHubTx.get(w.address.toLowerCase()) || 0;
      if (this.now() - lastTx <= OUTFLOW_GRACE_MS) continue;               // we spent it ourselves
      const alert = { ts: new Date(this.now()).toISOString(), wallet: w.name, address: w.address, network: net.key, droppedEth: viem.formatEther(prev - bal),
                      message: `ETH left wallet "${w.name}" but the hub sent nothing. If you did not move it yourself, the key is compromised: do NOT refill this wallet. Create a new one.` };
      this.alerts.push(alert); raised.push(alert); this.audit('hub', 'UNEXPECTED_OUTFLOW', { network: net.key, wallet: w.name }, { ok: false, error: alert.message, droppedEth: alert.droppedEth });
      console.warn(`[wallet] ALERT ${alert.message} (-${alert.droppedEth} ETH)`);
    }
    return raised;
  }
}

let _default = null;
function getWalletService() {
  if (_default) return _default;
  const { Keystore } = require('./keystore'); const dataDir = path.join(__dirname, '..', '..', 'data');
  _default = new WalletService({ dataDir, keystore: new Keystore({ file: path.join(dataDir, 'wallet-keystore.json') }) });
  return _default;
}

module.exports = { WalletService, getWalletService, NETWORKS, NATIVE, DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS, Firewall, FirewallError, OWNER };
