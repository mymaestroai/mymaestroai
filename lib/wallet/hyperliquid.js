'use strict';

/**
 * hyperliquid.js — a Hyperliquid account for the trading agent: perps, HLP vault, deposits and
 * withdrawals, under owner caps. Separate from the EVM networks on purpose: Hyperliquid is an
 * off-chain exchange with EIP-712 "actions" (lib/wallet/hyperliquid-signing.js), not contracts.
 *
 * Keys: the MAIN wallet (the keystore wallet the owner picks) owns the account and signs only
 * approveAgent, withdrawals and class transfers. An AGENT wallet, generated inside the keystore
 * as `hl-agent-<env>`, signs orders/cancels/leverage/vault actions and CANNOT withdraw: that is
 * Hyperliquid's own agent model, so a leaked agent key cannot drain the account.
 *
 * Owner controls (👛 panel): environment (testnet default), enabled, main wallet, per-tool
 * enable + dryRun (dryRun default ON: validates, signs, never submits), caps, asset allow-list.
 * Every call, accepted or refused, goes to the wallet audit log; the pause switch blocks
 * anything real. Isolated margin only. Withdrawals go to the main wallet's own address only.
 *
 * Deposits: Base USDC -> Hyperliquid core in one Relay step. The contract the wallet pays is
 * pinned AND re-checked against Relay's own chain metadata at run time; a quote naming any other
 * address is refused. Withdrawals land as USDC on Arbitrum (Hyperliquid's bridge chain).
 */

const fs = require('fs');
const path = require('path');
const S = require('./hyperliquid-signing');

const ENVS = {
  mainnet: { api: 'https://api.hyperliquid.xyz', isMainnet: true, hlpVault: '0xdfc24b077bc1425ad1dea75bcb6f8158e10df303', explorer: 'https://app.hyperliquid.xyz' },
  testnet: { api: 'https://api.hyperliquid-testnet.xyz', isMainnet: false, hlpVault: null, explorer: 'https://app.hyperliquid-testnet.xyz' },
};
const RELAY = { api: 'https://api.relay.link', hyperliquidChainId: 1337,
  // Relay's id for USDC on the Hyperliquid perp account (chain 1337). It is a 16-byte sentinel, not an EVM address:
  // GET https://api.relay.link/chains -> chains[id=1337].currency = { symbol:"USDC", name:"USDC (Perps)", address:"0x00000000000000000000000000000000" }
  // (also POST /currencies/v2 {chainIds:[1337]}). Verified 2026-09-22. Safe-fail: any other id is rejected by /quote (no steps), before anything is signed.
  hyperliquidUsdc: '0x00000000000000000000000000000000',
  // Relay's v2 depository on Base, from https://api.relay.link/chains (chain 8453 -> protocol.v2.depository). Re-verified live before every deposit.
  baseDepository: '0x4cd00e387622c35bddb9b4c962c136462338bc31' };
const DEFAULT_CAPS = { maxDepositPerCall: 250, maxDepositPerDay: 500, maxOrderNotionalUsd: 300, maxLeverage: 3, maxOpenPositions: 4, maxWithdrawPerDay: 1000 };
const DEFAULT_PERPS = ['ETH', 'BTC', 'HYPE'];
const DEFAULT_SPOT = ['HYPE'];
const TOOL_NAMES = ['hl_deposit', 'hl_order', 'hl_cancel', 'hl_vault', 'hl_transfer', 'hl_withdraw'];
const MIN_DEPOSIT_USDC = 5;      // Hyperliquid credits nothing below 5 USDC
const MIN_WITHDRAW_USDC = 5;     // fee is ~1 USDC; refuse dust withdrawals
const META_TTL_MS = 10 * 60 * 1000;
const LEDGER_KEEP_MS = 48 * 3600 * 1000;

class HlError extends Error { constructor(status, message) { super(message); this.status = status; } }
const refuse = (status, msg) => { throw new HlError(status, msg); };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };

class HyperliquidService {
  constructor({ dataDir, service, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), tokenCheck = () => false, sleep = (ms) => new Promise(r => setTimeout(r, ms)) }) {
    this.service = service; this.fetch = fetchImpl; this.now = now; this.tokenCheck = tokenCheck; this.sleep = sleep;
    this._chain = Promise.resolve();   // signing tools run one at a time: cap checks read the ledger/exchange, await the network, then write
    this.file = path.join(dataDir, 'wallet-hyperliquid.json');
    this._meta = {}; this._lastNonce = 0;
  }

  // ── config ──
  _load() {
    let c = {}; try { c = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* defaults */ }
    const tools = {}; for (const t of TOOL_NAMES) tools[t] = { enabled: false, dryRun: true, ...(c.tools && c.tools[t]) };
    return { env: ENVS[c.env] ? c.env : 'testnet', enabled: !!c.enabled, wallet: c.wallet || null, agents: c.agents || {}, tools,
      caps: { ...DEFAULT_CAPS, ...(c.caps || {}) }, perps: Array.isArray(c.perps) ? c.perps : DEFAULT_PERPS, spot: Array.isArray(c.spot) ? c.spot : DEFAULT_SPOT,
      ledger: Array.isArray(c.ledger) ? c.ledger : [], lastNonce: Number(c.lastNonce) || 0 };
  }
  _save(c) { fs.mkdirSync(path.dirname(this.file), { recursive: true }); const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 }); fs.renameSync(tmp, this.file); }
  env(c = this._load()) { return { key: c.env, ...ENVS[c.env] }; }
  settings() {
    const c = this._load(); const t = this.now(); const real = c.ledger.filter(e => !e.dryRun && e.ok);
    const sum = (kind, ms) => real.filter(e => e.kind === kind && t - e.ts < ms).reduce((a, e) => a + (e.usd || 0), 0);
    return { env: c.env, enabled: c.enabled, wallet: c.wallet, agent: c.agents[c.env] || null, tools: c.tools, caps: c.caps, perps: c.perps, spot: c.spot,
      hlpVault: ENVS[c.env].hlpVault || null, depositedToday: sum('deposit', 86400e3), withdrawnToday: sum('withdraw', 86400e3),
      recent: c.ledger.slice(-10).reverse(), explorer: ENVS[c.env].explorer };
  }
  configure(patch = {}) {
    const c = this._load();
    if (patch.env !== undefined) { if (!ENVS[patch.env]) refuse(400, 'env must be "testnet" or "mainnet".'); c.env = patch.env; }
    if (patch.enabled !== undefined) c.enabled = !!patch.enabled;
    if (patch.wallet !== undefined) { const w = String(patch.wallet || '').trim(); if (w) this.service.walletAddress(w); c.wallet = w || null; }
    for (const [k, v] of Object.entries(patch.tools || {})) { if (!TOOL_NAMES.includes(k)) refuse(400, `Unknown tool "${k}".`); if (v.enabled !== undefined) c.tools[k].enabled = !!v.enabled; if (v.dryRun !== undefined) c.tools[k].dryRun = !!v.dryRun; }
    for (const [k, v] of Object.entries(patch.caps || {})) {
      if (!(k in DEFAULT_CAPS)) refuse(400, `Unknown cap "${k}".`);
      const n = num(v); const whole = k === 'maxLeverage' || k === 'maxOpenPositions';
      if (!(n > 0) || (whole && !Number.isInteger(n))) refuse(400, `Cap "${k}" must be a positive ${whole ? 'whole ' : ''}number.`);
      c.caps[k] = n;
    }
    if (patch.perps !== undefined) c.perps = [...new Set(String(Array.isArray(patch.perps) ? patch.perps.join(',') : patch.perps).split(',').map(s => s.trim().toUpperCase()).filter(Boolean))];
    if (patch.spot !== undefined) c.spot = [...new Set(String(Array.isArray(patch.spot) ? patch.spot.join(',') : patch.spot).split(',').map(s => s.trim().toUpperCase()).filter(Boolean))];
    // The vault is pinned in code. The panel used to echo the pinned value back on every save, which this refused,
    // so "Save Hyperliquid settings" never worked. Ignore an empty or unchanged value; refuse only a real change.
    if (patch.hlpVault !== undefined) {
      const v = patch.hlpVault === null ? null : String(patch.hlpVault).trim().toLowerCase(); const pinned = String(ENVS[c.env].hlpVault || '').toLowerCase();
      if (v === null || (v && v !== pinned)) refuse(400, 'hlpVault is pinned in code and cannot be changed at runtime.');
    }
    this._save(c); return this.settings();
  }
  /**
   * Owner-only routes must prove ownership once a keystore exists: the keystore passphrase, and only
   * that. The executor token is handed to the trading agent, so accepting it here would let the agent
   * flip its own env/caps/agent-key settings. (Review finding: HIGH-1.)
   */
  ownerGate({ passphrase } = {}) {
    if (!this.service.keystore.exists()) return;
    if (passphrase && this.service.keystore.verify(passphrase)) return;
    refuse(401, 'Owner check failed: give the keystore passphrase to change Hyperliquid settings.');
  }
  _ledger(entry) { const c = this._load(); const keep = this.now() - LEDGER_KEEP_MS; c.ledger = c.ledger.filter(e => e.ts >= keep).concat([{ ts: this.now(), ...entry }]); this._save(c); }
  nextNonce() { const c = this._load(); const n = Math.max(this.now(), c.lastNonce + 1, this._lastNonce + 1); this._lastNonce = n; c.lastNonce = n; this._save(c); return n; }

  // ── HTTP ──
  async info(body, envKey) {
    const e = ENVS[envKey || this._load().env];
    const r = await this.fetch(`${e.api}/info`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`Hyperliquid info HTTP ${r.status}`);
    return r.json();
  }
  async exchange(payload, envKey) {
    const e = ENVS[envKey || this._load().env];
    const r = await this.fetch(`${e.api}/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.status !== 'ok') throw new Error(`Hyperliquid rejected the action: ${typeof j.response === 'string' ? j.response : JSON.stringify(j).slice(0, 300)}`);
    return j.response;
  }

  // ── keys ──
  mainAddress(c = this._load()) { if (!c.wallet) refuse(403, 'No main wallet selected for Hyperliquid. The owner picks one in the Wallet panel.'); return this.service.walletAddress(c.wallet); }
  agentWalletName(c = this._load()) { return `hl-agent-${c.env}`; }
  async _signL1(action, { vaultAddress = null } = {}) {
    const c = this._load(); const a = c.agents[c.env];
    if (!a || !a.approvedAt) refuse(403, `No approved agent key for ${c.env}. The owner sets it up in the Wallet panel ("Set up Hyperliquid agent key").`);
    const nonce = this.nextNonce();
    const signature = await this.service.keystore.withPrivateKey(a.wallet, pk => S.signL1Action(S.signerFromPrivateKey(pk), action, { vaultAddress, nonce, isMainnet: ENVS[c.env].isMainnet }));
    return { action, nonce, signature, vaultAddress: vaultAddress || null };
  }
  async _signUser(action) {
    const c = this._load(); const nonce = this.nextNonce();
    if (action.time === undefined && action.nonce === undefined) action.nonce = nonce;
    const signature = await this.service.keystore.withPrivateKey(c.wallet, pk => S.signUserAction(S.signerFromPrivateKey(pk), action, { isMainnet: ENVS[c.env].isMainnet }));
    return { action, nonce: action.time !== undefined ? action.time : action.nonce, signature };
  }
  /** Owner action: create the agent wallet in the keystore (once per env) and approve it with the main key. */
  async setupAgent() {
    const c = this._load(); const env = ENVS[c.env]; const main = this.mainAddress(c);
    if (!this.service.keystore.isUnlocked()) refuse(409, 'Unlock the keystore first.');
    const name = this.agentWalletName(c);
    let agent = this.service.keystore.list().find(w => w.name === name);
    if (!agent) agent = this.service.keystore.createWallet(name);
    const nonce = this.nextNonce();
    const action = { type: 'approveAgent', agentAddress: agent.address, agentName: `agenthub-${c.env}`, nonce };
    const signature = await this.service.keystore.withPrivateKey(c.wallet, pk => S.signUserAction(S.signerFromPrivateKey(pk), action, { isMainnet: env.isMainnet }));
    await this.exchange({ action, nonce, signature, vaultAddress: null }, c.env);
    c.agents[c.env] = { wallet: name, address: agent.address, approvedAt: new Date(this.now()).toISOString(), main };
    this._save(c);
    this.service.audit('owner', 'HL_AGENT_APPROVED', { env: c.env, main }, { ok: true, agent: agent.address });
    return c.agents[c.env];
  }
  /**
   * Owner action: approve an EXTERNAL agent (API) wallet on the account, by address and name, signed by the
   * main key. For a bot that keeps its own key outside the keystore (e.g. the trading agent's standalone
   * order tool). Hyperliquid lets an account carry several named agents; the hub's own agent is untouched.
   * An agent key can trade the account but cannot withdraw or transfer funds out. Returns the record and,
   * when the exchange's `extraAgents` listing could be read, whether the new agent appears in it.
   */
  async approveExternalAgent({ agentAddress, agentName } = {}) {
    const c = this._load(); const env = ENVS[c.env]; const main = this.mainAddress(c);
    if (!this.service.keystore.isUnlocked()) refuse(409, 'Unlock the keystore first.');
    const address = String(agentAddress || '').trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) refuse(400, 'agentAddress must be a 0x-prefixed 40-hex-digit address.');
    const name = String(agentName || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,31}$/.test(name)) refuse(400, 'agentName: 1-32 characters, letters, digits, space, _ . - only.');
    if (name === `agenthub-${c.env}`) refuse(400, `"${name}" is the hub's own agent name; pick another.`);
    const own = c.agents[c.env];
    if (own && own.address && own.address.toLowerCase() === address.toLowerCase()) refuse(400, 'That is the hub\'s own agent key; it is already approved.');
    if (address.toLowerCase() === String(main).toLowerCase()) refuse(400, 'The main wallet cannot be its own agent.');
    const nonce = this.nextNonce();
    const action = { type: 'approveAgent', agentAddress: address, agentName: name, nonce };
    const signature = await this.service.keystore.withPrivateKey(c.wallet, pk => S.signUserAction(S.signerFromPrivateKey(pk), action, { isMainnet: env.isMainnet }));
    try {
      await this.exchange({ action, nonce, signature, vaultAddress: null }, c.env);
    } catch (e) {
      this.service.audit('owner', 'HL_EXTERNAL_AGENT_APPROVED', { env: c.env, main, agent: address, name }, { ok: false, error: e.message });
      throw e;
    }
    let verified = null; let agents = null;
    try { agents = await this.listAgents(c.env); verified = agents.some(a => String(a.address || '').toLowerCase() === address.toLowerCase()); } catch { /* listing is best effort */ }
    const rec = { address, name, main, env: c.env, approvedAt: new Date(this.now()).toISOString(), verified };
    c.externalAgents = (Array.isArray(c.externalAgents) ? c.externalAgents : []).filter(a => a.address.toLowerCase() !== address.toLowerCase()).concat([rec]);
    this._save(c);
    this.service.audit('owner', 'HL_EXTERNAL_AGENT_APPROVED', { env: c.env, main, agent: address, name }, { ok: true, verified });
    return { ...rec, agents };
  }
  /** The account's approved agents as Hyperliquid reports them (`extraAgents`): [{ address, name, validUntil }]. */
  async listAgents(envKey) {
    const c = this._load(); const user = this.mainAddress(c);
    const list = await this.info({ type: 'extraAgents', user }, envKey || c.env);
    return (Array.isArray(list) ? list : []).map(a => ({ address: a.address, name: a.name, validUntil: a.validUntil }));
  }

  // ── market metadata ──
  async meta() {
    const c = this._load(); const cached = this._meta[c.env];
    if (cached && this.now() - cached.at < META_TTL_MS) return cached;
    const [perp, spot] = await Promise.all([this.info({ type: 'meta' }), this.info({ type: 'spotMeta' })]);
    const perps = {}; perp.universe.forEach((u, i) => { perps[u.name] = { asset: i, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage, onlyIsolated: !!u.onlyIsolated }; });
    const tokens = {}; for (const t of spot.tokens) tokens[t.index] = t;
    // Spot asset id = 10000 + the pair's OWN `index` field, never its array position: delisted pairs leave gaps, so on
    // mainnet most positions differ from the index (HYPE/USDC is @107 at position 105). A pair whose name and index
    // disagree means the metadata is not what this code understands: refuse every spot market rather than guess.
    const spots = {}; spot.universe.forEach(p => {
      if (!Number.isInteger(p.index) || p.index < 0) throw new Error(`Hyperliquid spotMeta: pair ${p.name} has no integer index; refusing to map spot markets.`);
      if (String(p.name).startsWith('@') && p.name !== `@${p.index}`) throw new Error(`Hyperliquid spotMeta: pair ${p.name} carries index ${p.index}; refusing to map spot markets.`);
      const base = tokens[p.tokens[0]], quote = tokens[p.tokens[1]];
      if (quote && quote.name === 'USDC' && base) spots[base.name] = { asset: 10000 + p.index, pair: p.name, szDecimals: base.szDecimals };
    });
    return (this._meta[c.env] = { at: this.now(), perps, spots });
  }
  async mids() { return this.info({ type: 'allMids' }); }
  async _market(coin, spot) {
    const m = await this.meta(); const c = this._load(); const sym = String(coin || '').toUpperCase();
    if (spot) { if (!c.spot.includes(sym)) refuse(403, `Spot "${sym}" is not on the owner's allow-list (${c.spot.join(', ') || 'none'}).`); const s = m.spots[sym]; if (!s) refuse(400, `No USDC spot market for ${sym}.`); return { ...s, coin: sym, isSpot: true, midKey: s.pair }; }
    if (!c.perps.includes(sym)) refuse(403, `Perp "${sym}" is not on the owner's allow-list (${c.perps.join(', ') || 'none'}).`);
    const p = m.perps[sym]; if (!p) refuse(400, `No perp market named ${sym}.`); return { ...p, coin: sym, isSpot: false, midKey: sym };
  }

  // ── gate for signing tools ──
  _gate(tool, dryRun) {
    const c = this._load();
    if (!c.enabled) refuse(403, 'Hyperliquid is disabled. The owner enables it in the Wallet panel.');
    if (!c.tools[tool].enabled) refuse(403, `${tool} is not enabled by the owner.`);
    const effective = c.tools[tool].dryRun || !!dryRun;
    if (!effective && this.service.isPaused()) refuse(403, 'Trading is PAUSED by the owner.');
    if (!effective && !this.service.keystore.isUnlocked()) refuse(409, 'The keystore is locked, so nothing can be signed. Dry runs still work.');
    return { c, dryRun: effective, env: ENVS[c.env] };
  }
  _done(agent, tool, params, result) { this.service.audit(agent, `HL_${tool.replace(/^hl_/, '').toUpperCase()}`, params, result); return result; }
  async _run(agent, tool, params, fn) {
    try { return await fn(); }
    catch (e) { this.service.audit(agent, `HL_${tool.replace(/^hl_/, '').toUpperCase()}`, params, { ok: false, refused: e instanceof HlError, error: e.message }); throw e; }
  }
  /**
   * _run, but one call at a time across all signing tools. Every cap check here is check-then-act
   * across network awaits (daily deposit/withdraw totals from the ledger, open-position count from
   * the exchange), so two overlapping calls could both pass; queueing them makes the second one see
   * the first one's result. Read-only tools are not queued.
   */
  _serial(agent, tool, params, fn) {
    const run = () => this._run(agent, tool, params, fn);
    const p = this._chain.then(run, run); this._chain = p.catch(() => {}); return p;
  }

  // ── read-only tools ──
  async status() {
    const s = this.settings(); let account = null;
    try {
      if (s.wallet) {
        const user = this.mainAddress();
        const [st, vaults] = await Promise.all([this.info({ type: 'clearinghouseState', user }), this._vaultEquities(user)]);
        const hlp = vaults.find(v => s.hlpVault && v.vaultAddress === String(s.hlpVault).toLowerCase());
        account = { accountValueUsd: num(st.marginSummary.accountValue), withdrawableUsd: num(st.withdrawable), marginUsedUsd: num(st.marginSummary.totalMarginUsed), openPositions: st.assetPositions.filter(p => num(p.position.szi) !== 0).length,
          hlpVaultEquityUsd: hlp ? hlp.equityUsd : 0, hlpVaultLockedUntil: hlp ? hlp.lockedUntil : null, vaults };
      }
    } catch (e) { account = { error: e.message }; }
    let externalAgents = null; try { if (s.wallet) externalAgents = await this.listAgents(); } catch { /* best effort */ }
    return { ...s, account, externalAgents, paused: this.service.isPaused(), keystoreUnlocked: this.service.keystore.isUnlocked(),
      note: 'dryRun tools validate and sign but never submit. Withdrawals go only to the main wallet, on Arbitrum. Isolated margin only.' };
  }
  /** Equity held in vaults (HLP and any other), from userVaultEquities. Empty on error: advisory data. */
  async _vaultEquities(user) {
    try { const v = await this.info({ type: 'userVaultEquities', user }); return (Array.isArray(v) ? v : []).map(x => ({ vaultAddress: String(x.vaultAddress).toLowerCase(), equityUsd: num(x.equity), lockedUntil: x.lockedUntilTimestamp ? new Date(Number(x.lockedUntilTimestamp)).toISOString() : null })); }
    catch { return []; }
  }
  _spotBalances(spot) { return (spot.balances || []).filter(b => num(b.total) > 0).map(b => ({ coin: b.coin, total: num(b.total), hold: num(b.hold) })); }
  async balances() {
    const user = this.mainAddress();
    const [perp, spot, vaults] = await Promise.all([this.info({ type: 'clearinghouseState', user }), this.info({ type: 'spotClearinghouseState', user }), this._vaultEquities(user)]);
    return { perp: { accountValueUsd: num(perp.marginSummary.accountValue), withdrawableUsd: num(perp.withdrawable), marginUsedUsd: num(perp.marginSummary.totalMarginUsed), notionalUsd: num(perp.marginSummary.totalNtlPos) },
      spot: this._spotBalances(spot), vaults };
  }
  async positions() {
    const user = this.mainAddress();
    const [st, orders, spot] = await Promise.all([this.info({ type: 'clearinghouseState', user }), this.info({ type: 'frontendOpenOrders', user }), this.info({ type: 'spotClearinghouseState', user })]);
    return { spot: this._spotBalances(spot), positions: st.assetPositions.filter(p => num(p.position.szi) !== 0).map(p => ({ coin: p.position.coin, size: num(p.position.szi), entryPx: num(p.position.entryPx), positionValueUsd: num(p.position.positionValue), unrealizedPnlUsd: num(p.position.unrealizedPnl), liquidationPx: p.position.liquidationPx === null ? null : num(p.position.liquidationPx), leverage: p.position.leverage, marginUsedUsd: num(p.position.marginUsed) })),
      openOrders: orders.map(o => ({ coin: o.coin, oid: o.oid, side: o.side === 'B' ? 'buy' : 'sell', size: num(o.sz), price: num(o.limitPx), reduceOnly: !!o.reduceOnly, tif: o.tif, timestamp: o.timestamp })) };
  }
  async market({ coin } = {}) {
    const sym = String(coin || '').toUpperCase(); const m = await this.meta();
    const [ctxs, book] = await Promise.all([this.info({ type: 'metaAndAssetCtxs' }), this.info({ type: 'l2Book', coin: sym })]);
    const i = ctxs[0].universe.findIndex(u => u.name === sym); if (i < 0) refuse(400, `No perp named ${sym}.`);
    const ctx = ctxs[1][i]; const bid = book.levels[0][0], ask = book.levels[1][0];
    return { coin: sym, midPx: num(ctx.midPx), markPx: num(ctx.markPx), oraclePx: num(ctx.oraclePx), fundingHourly: num(ctx.funding), fundingAnnualizedPct: num(ctx.funding) * 24 * 365 * 100, openInterest: num(ctx.openInterest), dayVolumeUsd: num(ctx.dayNtlVlm), premium: num(ctx.premium),
      bestBid: bid ? { px: num(bid.px), sz: num(bid.sz) } : null, bestAsk: ask ? { px: num(ask.px), sz: num(ask.sz) } : null, maxLeverage: m.perps[sym]?.maxLeverage, szDecimals: m.perps[sym]?.szDecimals };
  }

  // ── deposit: Base USDC -> Hyperliquid core through Relay ──
  async _relayDepository() {
    const r = await this.fetch(`${RELAY.api}/chains`); if (!r.ok) throw new Error(`Relay chains HTTP ${r.status}`);
    const j = await r.json(); const base = (j.chains || []).find(c => c.id === 8453);
    return String(base?.protocol?.v2?.depository || '').toLowerCase();
  }
  async deposit({ agent, usdc, dryRun } = {}) {
    const params = { usdc: String(usdc), dryRun: !!dryRun };
    return this._serial(agent, 'hl_deposit', params, async () => {
      const { c, dryRun: dry, env } = this._gate('hl_deposit', dryRun);
      if (!env.isMainnet) refuse(400, 'Deposits are mainnet only. On testnet, fund the account from the faucet at app.hyperliquid-testnet.xyz/drip (it requires a prior mainnet deposit from the same address).');
      const amount = num(usdc); if (!(amount >= MIN_DEPOSIT_USDC)) refuse(400, `usdc must be at least ${MIN_DEPOSIT_USDC} (smaller deposits are not credited by Hyperliquid).`);
      if (amount > c.caps.maxDepositPerCall) refuse(403, `Deposit cap is ${c.caps.maxDepositPerCall} USDC per call.`);
      const today = this.settings().depositedToday; if (today + amount > c.caps.maxDepositPerDay) refuse(429, `Daily deposit cap ${c.caps.maxDepositPerDay} USDC would be exceeded (already ${today.toFixed(2)} today).`);
      const from = this.mainAddress(c); const raw = String(Math.round(amount * 1e6));
      const usdcBase = this.service.net('base').tokens.USDC;
      const q = await this.fetch(`${RELAY.api}/quote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: from, recipient: from, originChainId: 8453, destinationChainId: RELAY.hyperliquidChainId, originCurrency: usdcBase, destinationCurrency: RELAY.hyperliquidUsdc, amount: raw, tradeType: 'EXACT_INPUT' }) });
      const quote = await q.json().catch(() => ({})); if (!q.ok || !quote.steps) refuse(502, `Relay quote failed: ${JSON.stringify(quote).slice(0, 200)}`);
      const live = await this._relayDepository();
      const steps = quote.steps.flatMap(s => s.items.map(it => ({ id: s.id, ...it.data, check: it.check })));
      const deposit = steps.find(s => s.id === 'deposit'); const approve = steps.find(s => s.id === 'approve');
      if (!deposit) refuse(502, 'Relay quote has no deposit step.');
      const to = String(deposit.to).toLowerCase();
      if (to !== RELAY.baseDepository || to !== live) refuse(409, `REFUSED: Relay asked to send funds to ${deposit.to}, which is not the pinned depository (${RELAY.baseDepository}) / Relay's own listed depository (${live || 'unknown'}).`);
      if (approve && String(approve.to).toLowerCase() !== usdcBase.toLowerCase()) refuse(409, 'REFUSED: the approval step targets a contract other than Base USDC.');
      if (String(quote.details?.recipient || '').toLowerCase() !== from.toLowerCase()) refuse(409, 'REFUSED: the quote recipient is not our own address.');
      const out = num(quote.details?.currencyOut?.amountFormatted); const feesUsd = Object.values(quote.fees || {}).reduce((a, f) => a + (num(f.amountUsd) || 0), 0);
      if (!(out >= MIN_DEPOSIT_USDC)) refuse(409, `After Relay fees only ${out} USDC would arrive; Hyperliquid credits nothing below ${MIN_DEPOSIT_USDC}. Deposit more.`);
      const summary = { usdcIn: amount, usdcOut: out, feesUsd: Number(feesUsd.toFixed(4)), depository: deposit.to, requestId: quote.steps[0]?.requestId || null };
      const viem = require('viem');
      if (dry) {
        const sim = await this.service.sendTransaction({ agent, wallet: c.wallet, to: usdcBase, abi: viem.erc20Abi, functionName: 'approve', args: [deposit.to, BigInt(raw)], network: 'base', dryRun: true, _meta: { step: 'hl-deposit approve (dry run)' } });
        return this._done(agent, 'hl_deposit', params, { ok: true, dryRun: true, ...summary, simulated: sim.ok, note: 'Dry run: Relay quote verified against the pinned depository and the approval simulated; nothing was sent.' });
      }
      const txHashes = [];
      const approveTx = (amt, step) => this.service.sendTransaction({ agent, wallet: c.wallet, to: usdcBase, abi: viem.erc20Abi, functionName: 'approve', args: [deposit.to, amt], network: 'base', _meta: { step } });
      // Invariant: an approval that was broadcast is revoked on every exit that does not consume it (same rule as the executor).
      let approved = false;
      try {
        if (approve) { const ap = await approveTx(BigInt(raw), 'hl-deposit approve'); txHashes.push(ap.txHash); if (!ap.ok || ap.status !== 'success') refuse(500, `Approval did not confirm (${ap.status}).`); approved = true; }
        // The bridge call is simulated first, and an RPC node can lag the approval it just confirmed by a block or two
        // ("Execution reverted for an unknown reason"). Retry the simulation a couple of times before giving up.
        let dp;
        for (let attempt = 1; ; attempt++) {
          try { dp = await this.service.sendTransaction({ agent, wallet: c.wallet, to: deposit.to, data: deposit.data, value: viem.formatEther(BigInt(deposit.value || '0')), network: 'base', _meta: { step: 'hl-deposit relay', attempt } }); break; }
          catch (e) { if (attempt >= 3 || !approved || !/Simulation failed/.test(e.message)) throw e; await this.sleep(3000); }
        }
        txHashes.push(dp.txHash); if (!dp.ok || dp.status !== 'success') refuse(500, `Deposit transaction did not confirm (${dp.status}). Hashes: ${txHashes.join(', ')}`);
        approved = false;   // consumed by the bridge (exact amount)
      } catch (e) {
        if (approved) {
          try { const rv = await approveTx(0n, 'hl-deposit revoke'); txHashes.push(rv.txHash); e.message += ` The USDC approval to ${deposit.to} was revoked (${rv.txHash}).`; }
          catch (re) { console.error(`[hyperliquid] REVOKE FAILED: an allowance of ${amount} USDC to ${deposit.to} is still standing:`, re.message); e.message += ` WARNING: the ${amount} USDC allowance to ${deposit.to} is STILL STANDING (revoke failed: ${re.message}). Revoke it: wallet_send_transaction approve(${deposit.to}, 0) on Base USDC.`; }
        }
        throw e;
      }
      let relayStatus = 'unknown';
      if (deposit.check?.endpoint) {
        const until = this.now() + 180000;
        while (this.now() < until) { try { const s = await (await this.fetch(`${RELAY.api}${deposit.check.endpoint}`)).json(); relayStatus = s.status || relayStatus; if (['success', 'failure', 'refund'].includes(relayStatus)) break; } catch {} await new Promise(r => setTimeout(r, 5000)); }
      }
      this._ledger({ kind: 'deposit', usd: amount, dryRun: false, ok: relayStatus !== 'failure' });
      return this._done(agent, 'hl_deposit', params, { ok: relayStatus !== 'failure', dryRun: false, ...summary, txHashes, relayStatus, note: relayStatus === 'success' ? 'Credited on Hyperliquid (check hl_balances).' : `Relay reports "${relayStatus}"; check hl_balances in a few minutes.` });
    });
  }

  // ── orders ──
  async order({ agent, coin, side, size, price, tif = 'Gtc', reduceOnly = false, leverage, slippageBps = 50, spot = false, dryRun } = {}) {
    const params = { coin, side, size: String(size), price: price === undefined ? 'market' : String(price), tif, reduceOnly: !!reduceOnly, leverage, slippageBps, spot: !!spot, dryRun: !!dryRun };
    return this._serial(agent, 'hl_order', params, async () => {
      const { c, dryRun: dry } = this._gate('hl_order', dryRun);
      const isBuy = String(side).toLowerCase() === 'buy'; if (!isBuy && String(side).toLowerCase() !== 'sell') refuse(400, 'side must be "buy" or "sell".');
      const mk = await this._market(coin, spot);
      const mids = await this.mids(); const mid = num(mids[mk.midKey]); if (!(mid > 0)) refuse(502, `No mid price for ${mk.coin}.`);
      let px, effTif = String(tif);
      if (price === undefined || price === null || String(price).toLowerCase() === 'market') { const bps = num(slippageBps); if (!(bps >= 1 && bps <= 500)) refuse(400, 'slippageBps must be 1..500.'); px = mid * (isBuy ? 1 + bps / 1e4 : 1 - bps / 1e4); effTif = 'Ioc'; }
      else { px = num(price); if (!(px > 0)) refuse(400, 'price must be positive or "market".'); if (Math.abs(px / mid - 1) > 0.25) refuse(409, `Price ${px} is more than 25% from the mid ${mid}; refusing as a likely mistake.`); }
      if (!['Gtc', 'Alo', 'Ioc'].includes(effTif)) refuse(400, 'tif must be Gtc, Alo or Ioc.');
      px = S.roundPrice(px, mk.szDecimals, mk.isSpot); const sz = S.roundSize(size, mk.szDecimals); if (!(sz > 0)) refuse(400, `Size rounds to zero at ${mk.szDecimals} decimals.`);
      const notional = sz * px;
      if (!reduceOnly && notional > c.caps.maxOrderNotionalUsd) refuse(403, `Order notional $${notional.toFixed(2)} exceeds the cap of $${c.caps.maxOrderNotionalUsd}.`);
      let lev = null, positions = [];
      if (!mk.isSpot) {
        const st = await this.info({ type: 'clearinghouseState', user: this.mainAddress(c) });
        positions = st.assetPositions.filter(p => num(p.position.szi) !== 0);
        const existing = positions.find(p => p.position.coin === mk.coin);
        lev = Math.min(Math.max(1, Math.floor(num(leverage) || 1)), c.caps.maxLeverage, mk.maxLeverage);
        if (leverage !== undefined && num(leverage) > lev) refuse(403, `Leverage ${leverage}x exceeds the cap (${Math.min(c.caps.maxLeverage, mk.maxLeverage)}x).`);
        if (!reduceOnly && !existing && positions.length >= c.caps.maxOpenPositions) refuse(403, `Open-position cap reached (${c.caps.maxOpenPositions}).`);
        if (existing && existing.position.leverage?.type === 'cross') refuse(409, `${mk.coin} currently has a CROSS-margin position; this hub only trades isolated. Close it first.`);
      }
      const wire = S.orderWire({ asset: mk.asset, isBuy, price: px, size: sz, reduceOnly: !!reduceOnly, tif: effTif });
      const action = S.orderAction([wire]);
      const preview = { coin: mk.coin, market: mk.isSpot ? 'spot' : 'perp', side: isBuy ? 'buy' : 'sell', size: sz, price: px, tif: effTif, reduceOnly: !!reduceOnly, notionalUsd: Number(notional.toFixed(2)), mid, leverage: lev, marginMode: mk.isSpot ? null : 'isolated' };
      if (dry) {
        const signed = await this._signL1(action).catch(e => ({ unsigned: e.message }));
        return this._done(agent, 'hl_order', params, { ok: true, dryRun: true, ...preview, signed: !signed.unsigned, ...(signed.unsigned ? { note: `Dry run: validated; not signed (${signed.unsigned}).` } : { nonce: signed.nonce, note: 'Dry run: validated and signed; NOT submitted.' }) });
      }
      if (!mk.isSpot) {
        const existing = positions.find(p => p.position.coin === mk.coin);
        if (!existing || existing.position.leverage?.value !== lev) { const l = await this._signL1({ type: 'updateLeverage', asset: mk.asset, isCross: false, leverage: lev }); await this.exchange(l); }
      }
      const payload = await this._signL1(action); const resp = await this.exchange(payload);
      const status = resp?.data?.statuses?.[0] || {};
      if (status.error) refuse(409, `Hyperliquid rejected the order: ${status.error}`);
      const filled = status.filled ? { filledSize: num(status.filled.totalSz), avgPx: num(status.filled.avgPx), oid: status.filled.oid } : null;
      this._ledger({ kind: 'order', usd: notional, dryRun: false, ok: true });
      return this._done(agent, 'hl_order', params, { ok: true, dryRun: false, ...preview, oid: status.resting?.oid ?? filled?.oid ?? null, state: filled ? 'filled' : status.resting ? 'resting' : 'unknown', ...(filled || {}) });
    });
  }
  async cancel({ agent, coin, oid, all = false } = {}) {
    const params = { coin, oid, all: !!all };
    return this._run(agent, 'hl_cancel', params, async () => {
      const { c } = this._gate('hl_cancel', false);
      const m = await this.meta(); let cancels = [];
      if (all) { const orders = await this.info({ type: 'frontendOpenOrders', user: this.mainAddress(c) }); cancels = orders.filter(o => !coin || o.coin === String(coin).toUpperCase()).map(o => ({ a: m.perps[o.coin] ? m.perps[o.coin].asset : (Object.values(m.spots).find(s => s.pair === o.coin) || {}).asset, o: o.oid })).filter(x => x.a !== undefined); }
      else { const sym = String(coin || '').toUpperCase(); const a = m.perps[sym]?.asset ?? m.spots[sym]?.asset; if (a === undefined) refuse(400, `Unknown coin ${sym}.`); if (!Number.isInteger(num(oid))) refuse(400, 'oid must be an integer.'); cancels = [{ a, o: Number(oid) }]; }
      if (!cancels.length) return this._done(agent, 'hl_cancel', params, { ok: true, cancelled: 0, note: 'No matching open orders.' });
      const payload = await this._signL1({ type: 'cancel', cancels }); const resp = await this.exchange(payload);
      const statuses = resp?.data?.statuses || [];
      return this._done(agent, 'hl_cancel', params, { ok: true, cancelled: statuses.filter(s => s === 'success').length, statuses });
    });
  }
  async vault({ agent, action, usd, dryRun } = {}) {
    const params = { action, usd: String(usd), dryRun: !!dryRun };
    return this._serial(agent, 'hl_vault', params, async () => {
      const { c, dryRun: dry, env } = this._gate('hl_vault', dryRun);
      const isDeposit = action === 'deposit'; if (!isDeposit && action !== 'withdraw') refuse(400, 'action must be "deposit" or "withdraw".');
      const amount = num(usd); if (!(amount > 0)) refuse(400, 'usd must be positive.');
      const vaultAddress = env.hlpVault; if (!vaultAddress) refuse(403, `No HLP vault is pinned for ${c.env}; hl_vault is mainnet-only.`);
      const details = await this.info({ type: 'vaultDetails', vaultAddress });
      if (!details || !/HLP|Hyperliquidity Provider/i.test(details.name || '')) refuse(409, `REFUSED: ${vaultAddress} is not the HLP vault (name: ${details && details.name}).`);
      if (details.vaultAddress && String(details.vaultAddress).toLowerCase() !== vaultAddress.toLowerCase()) refuse(409, `REFUSED: vaultDetails returned address ${details.vaultAddress}, expected the pinned HLP vault ${vaultAddress}.`);
      if (isDeposit && amount > c.caps.maxOrderNotionalUsd) refuse(403, `Vault deposit $${amount} exceeds the per-action cap of $${c.caps.maxOrderNotionalUsd}.`);
      const l1 = { type: 'vaultTransfer', vaultAddress, isDeposit, usd: Math.round(amount * 1e6) };
      if (dry) return this._done(agent, 'hl_vault', params, { ok: true, dryRun: true, vault: details.name, vaultAddress, action, usd: amount, note: 'Dry run: vault verified; NOT submitted. HLP withdrawals have a 4-day lockup after deposit.' });
      const payload = await this._signL1(l1); await this.exchange(payload);
      this._ledger({ kind: 'vault', usd: amount, dryRun: false, ok: true });
      return this._done(agent, 'hl_vault', params, { ok: true, dryRun: false, vault: details.name, vaultAddress, action, usd: amount });
    });
  }
  async transfer({ agent, amount, toPerp, dryRun } = {}) {
    const params = { amount: String(amount), toPerp: !!toPerp, dryRun: !!dryRun };
    return this._run(agent, 'hl_transfer', params, async () => {
      const { dryRun: dry } = this._gate('hl_transfer', dryRun);
      const a = num(amount); if (!(a > 0)) refuse(400, 'amount must be positive USDC.');
      const action = { type: 'usdClassTransfer', amount: S.floatToWire(a), toPerp: !!toPerp };
      if (dry) return this._done(agent, 'hl_transfer', params, { ok: true, dryRun: true, amount: a, direction: toPerp ? 'spot -> perp' : 'perp -> spot', note: 'Dry run: NOT submitted.' });
      const payload = await this._signUser(action); await this.exchange(payload);
      return this._done(agent, 'hl_transfer', params, { ok: true, dryRun: false, amount: a, direction: toPerp ? 'spot -> perp' : 'perp -> spot' });
    });
  }
  async withdraw({ agent, usdc, dryRun } = {}) {
    const params = { usdc: String(usdc), dryRun: !!dryRun };
    return this._serial(agent, 'hl_withdraw', params, async () => {
      const { c, dryRun: dry } = this._gate('hl_withdraw', dryRun);
      const amount = num(usdc); if (!(amount >= MIN_WITHDRAW_USDC)) refuse(400, `usdc must be at least ${MIN_WITHDRAW_USDC} (Hyperliquid charges about 1 USDC per withdrawal).`);
      const today = this.settings().withdrawnToday; if (today + amount > c.caps.maxWithdrawPerDay) refuse(429, `Daily withdrawal cap ${c.caps.maxWithdrawPerDay} USDC would be exceeded (already ${today.toFixed(2)} today).`);
      const destination = this.mainAddress(c).toLowerCase();   // ONLY ever the main wallet's own address
      const st = await this.info({ type: 'clearinghouseState', user: destination }); const avail = num(st.withdrawable);
      if (amount > avail) refuse(409, `Only ${avail} USDC is withdrawable right now (margin in use or vault lockup).`);
      const action = { type: 'withdraw3', destination, amount: S.floatToWire(amount), time: this.nextNonce() };
      if (dry) return this._done(agent, 'hl_withdraw', params, { ok: true, dryRun: true, usdc: amount, destination, arrivesOn: 'Arbitrum (USDC)', note: 'Dry run: NOT submitted. Real withdrawals take ~5 minutes and cost ~1 USDC.' });
      const payload = await this._signUser(action); await this.exchange(payload);
      this._ledger({ kind: 'withdraw', usd: amount, dryRun: false, ok: true });
      return this._done(agent, 'hl_withdraw', params, { ok: true, dryRun: false, usdc: amount, destination, arrivesOn: 'Arbitrum (USDC), ~5 minutes, ~1 USDC fee', note: 'Use the "arbitrum" network with wallet_balances / wallet_send_transaction to move it onward.' });
    });
  }
}

/** Tool definitions in the same shape as lib/wallet/tools.js (JSON schema + zod + run). Only wallet agents ever see them. */
function toolSpecs(getHl = () => getHyperliquidService()) {
  const R = (fn) => async (a, agent) => fn(getHl(), { ...a, agent });
  return [
    { name: 'hl_status', description: 'Hyperliquid overview: environment (testnet/mainnet), whether enabled, main wallet, agent key, which tools are enabled and which are dry-run only, caps, allow-listed assets, account value, open positions, HLP vault equity and lock-up. Call this first.', parameters: { type: 'object', properties: {} }, zod: () => ({}), run: R(hl => hl.status()) },
    { name: 'hl_balances', description: 'Hyperliquid balances: perp account value, withdrawable USDC, margin in use, spot token balances, and vault equity (HLP).', parameters: { type: 'object', properties: {} }, zod: () => ({}), run: R(hl => hl.balances()) },
    { name: 'hl_positions', description: 'Open perp positions (size, entry, PnL, liquidation price, leverage), open orders, and spot balances.', parameters: { type: 'object', properties: {} }, zod: () => ({}), run: R(hl => hl.positions()) },
    { name: 'hl_market', description: 'Live perp market data for one coin: mid/mark/oracle price, hourly funding rate (and annualised %), open interest, 24h volume, best bid/ask, max leverage.', parameters: { type: 'object', properties: { coin: { type: 'string' } }, required: ['coin'] }, zod: z => ({ coin: z.string() }), run: R((hl, a) => hl.market(a)) },
    { name: 'hl_deposit', description: 'Deposit USDC from the Base wallet into the Hyperliquid account in one Relay step (mainnet only). Refused unless the contract paid matches the pinned Relay depository. dryRun:true verifies the quote and simulates the approval without sending. Minimum 5 USDC; owner caps per call and per day.', parameters: { type: 'object', properties: { usdc: { type: 'number' }, dryRun: { type: 'boolean' } }, required: ['usdc'] }, zod: z => ({ usdc: z.number(), dryRun: z.boolean().optional() }), run: R((hl, a) => hl.deposit(a)) },
    { name: 'hl_order', description: 'Place a Hyperliquid order. coin (e.g. ETH), side buy|sell, size in coin units, price (a number, or "market" = IOC at the mid with slippageBps, default 50), tif Gtc|Alo|Ioc, reduceOnly, leverage (perps; isolated margin; capped by the owner), spot:true for the USDC spot market. Owner caps on notional, leverage and open positions apply. dryRun:true validates and signs but never submits.', parameters: { type: 'object', properties: { coin: { type: 'string' }, side: { type: 'string', enum: ['buy', 'sell'] }, size: { type: 'number' }, price: {}, tif: { type: 'string', enum: ['Gtc', 'Alo', 'Ioc'] }, reduceOnly: { type: 'boolean' }, leverage: { type: 'integer' }, slippageBps: { type: 'integer' }, spot: { type: 'boolean' }, dryRun: { type: 'boolean' } }, required: ['coin', 'side', 'size'] },
      zod: z => ({ coin: z.string(), side: z.enum(['buy', 'sell']), size: z.number(), price: z.union([z.number(), z.string()]).optional(), tif: z.enum(['Gtc', 'Alo', 'Ioc']).optional(), reduceOnly: z.boolean().optional(), leverage: z.number().int().optional(), slippageBps: z.number().int().optional(), spot: z.boolean().optional(), dryRun: z.boolean().optional() }), run: R((hl, a) => hl.order(a)) },
    { name: 'hl_cancel', description: 'Cancel an open order by coin + oid, or all:true (optionally for one coin).', parameters: { type: 'object', properties: { coin: { type: 'string' }, oid: { type: 'integer' }, all: { type: 'boolean' } } }, zod: z => ({ coin: z.string().optional(), oid: z.number().int().optional(), all: z.boolean().optional() }), run: R((hl, a) => hl.cancel(a)) },
    { name: 'hl_vault', description: 'Deposit USDC into, or withdraw from, the HLP vault (address pinned in code and cross-checked against the exchange vaultDetails). action deposit|withdraw, usd amount. HLP withdrawals have a 4-day lockup after each deposit. dryRun:true never submits.', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['deposit', 'withdraw'] }, usd: { type: 'number' }, dryRun: { type: 'boolean' } }, required: ['action', 'usd'] }, zod: z => ({ action: z.enum(['deposit', 'withdraw']), usd: z.number(), dryRun: z.boolean().optional() }), run: R((hl, a) => hl.vault(a)) },
    { name: 'hl_transfer', description: 'Move USDC between the perp and spot balances inside Hyperliquid (needed before buying spot). amount, toPerp true|false. dryRun:true never submits.', parameters: { type: 'object', properties: { amount: { type: 'number' }, toPerp: { type: 'boolean' }, dryRun: { type: 'boolean' } }, required: ['amount', 'toPerp'] }, zod: z => ({ amount: z.number(), toPerp: z.boolean(), dryRun: z.boolean().optional() }), run: R((hl, a) => hl.transfer(a)) },
    { name: 'hl_withdraw', description: 'Withdraw USDC from Hyperliquid to the main wallet\'s OWN address on Arbitrum (the only allowed destination). Minimum 5 USDC, ~1 USDC fee, ~5 minutes; owner daily cap. dryRun:true never submits.', parameters: { type: 'object', properties: { usdc: { type: 'number' }, dryRun: { type: 'boolean' } }, required: ['usdc'] }, zod: z => ({ usdc: z.number(), dryRun: z.boolean().optional() }), run: R((hl, a) => hl.withdraw(a)) },
  ];
}

let _singleton = null;
function getHyperliquidService() {
  if (!_singleton) {
    const { getWalletService } = require('./service');
    _singleton = new HyperliquidService({ dataDir: path.join(__dirname, '..', '..', 'data'), service: getWalletService() });
  }
  return _singleton;
}

module.exports = { HyperliquidService, HlError, getHyperliquidService, toolSpecs, ENVS, RELAY, DEFAULT_CAPS, TOOL_NAMES, MIN_DEPOSIT_USDC, MIN_WITHDRAW_USDC };
