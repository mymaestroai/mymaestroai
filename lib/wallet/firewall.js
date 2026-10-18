'use strict';

/**
 * firewall.js — the signing-layer firewall for the hub's trading wallets.
 *
 * Everything the trading agent signs goes through WalletService.sendTransaction(),
 * and sendTransaction() asks this module before it simulates or signs anything.
 * The model never sees, and cannot bypass, these rules. They enforce the owner's
 * mandate: "only interact with addresses associated with our investment strategies, and
 * only ever send assets / profits to the owner." The owner's address is configuration
 * (settings.walletOwner, or HUB_WALLET_OWNER), never code.
 *
 * Rules, in order:
 *   1. `to` must be the owner, the wallet itself, or an ACTIVE entry of the address
 *      book for that chain. Anything else is refused before simulation, dry run or not.
 *   2. Plain ETH (empty calldata) may only go to the owner or the wallet itself.
 *      Calldata may never go to the owner or the wallet itself (they are accounts).
 *   3. Calldata to a book entry is decoded. The 4-byte selector must have a rule,
 *      the rule must permit the entry's role, ETH value is only allowed where the
 *      rule says so, and every recipient-like parameter is validated:
 *        approve            spender must be a listed router / contract / bridge
 *        transfer           to must be the owner or the wallet
 *        transferFrom       from must be the wallet, to the owner or the wallet
 *        Aave supply/withdraw/borrow/repay   asset listed, onBehalfOf / to = wallet
 *        swapAndRepay       collateral and debt assets listed
 *        Relay depositNative / depositErc20  depositor = wallet, token listed
 *        KyberSwap swap / swapGeneric / swapSimpleMode  dstReceiver = wallet, tokens listed
 *      Unknown selector, or calldata that does not decode: refused, unless the entry
 *      was added with `anySelector: true` by the owner.
 *
 * The address book (data/wallet-allowlist.json) is append-only. Seed entries live in
 * this file (so they are versioned with the code). Owner-added records carry an
 * HMAC signed with a key derived from the keystore passphrase: a record without a
 * valid signature is ignored, so nothing that lacks the passphrase (an agent's shell,
 * a hand-edited file, a prompt injection) can add a destination. Removing an entry is
 * impossible; the owner can only DEACTIVATE it (also signed).
 *
 * Refusals are thrown as FirewallError ("REFUSED (firewall): ...") and audited by
 * the caller. Fail closed: any doubt is a refusal.
 */

const fs = require('fs');
const path = require('path');

/**
 * The owner's address: the only external account that may receive value. Configuration, never code:
 * HUB_WALLET_OWNER (and HUB_WALLET_OWNER_LABEL), else settings.walletOwner { address, label }. Without one, value
 * may only stay in the wallet itself (and other keystore wallets): nothing can be sent out.
 */
function configuredOwner() {
  let address = process.env.HUB_WALLET_OWNER || '', label = process.env.HUB_WALLET_OWNER_LABEL || '';
  if (!address) { try { const w = require('../settings').getSetting('walletOwner') || {}; address = w.address || ''; label = label || w.label || ''; } catch { /* no settings */ } }
  return /^0x[0-9a-fA-F]{40}$/.test(String(address)) ? { address: String(address), label: String(label || 'the owner') } : { address: null, label: 'the owner' };
}
const { address: OWNER, label: OWNER_LABEL } = configuredOwner();
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
/** `executor` = a swap-router helper (the Kyber executor) that a router may hand funds to. Nothing else may
 *  be called or approved by the wallet under that role, and no `contract`/`bridge`/`token` entry ever qualifies. */
const ROLES = ['contract', 'token', 'router', 'bridge', 'executor', 'owner'];
const SPENDER_ROLES = ['router', 'contract', 'bridge'];

/** Verified by verifier (workspaces/trader/PLAYBOOK.md) and by ABI fetch from Base Blockscout, 2026-09-22. */
const SEED = [
  ...(OWNER ? [{ chainId: null, address: OWNER, label: `${OWNER_LABEL} (owner)`, role: 'owner' }] : []),
  { chainId: 8453,    address: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', label: 'Aave v3 Pool (Base)', role: 'contract' },
  { chainId: 8453,    address: '0x4200000000000000000000000000000000000006', label: 'WETH (Base)', role: 'token', weth: true },
  { chainId: 8453,    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', label: 'USDC (Base)', role: 'token' },
  { chainId: 8453,    address: '0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7', label: 'Aave aWETH (Base)', role: 'token' },
  { chainId: 8453,    address: '0x59dca05b6c26dbd64b5381374aAaC5CD05644C28', label: 'Aave variableDebtUSDC (Base)', role: 'token' },
  { chainId: 8453,    address: '0x63dfa7c09Dc2Ff4030d6B8Dc2ce6262BF898C8A4', label: 'Aave ParaSwapRepayAdapter (Base)', role: 'contract' },
  { chainId: 8453,    address: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5', label: 'KyberSwap MetaAggregationRouterV2 (Base)', role: 'router' },
  { chainId: 8453,    address: '0x4cd00e387622c35bddb9b4c962c136462338bc31', label: 'Relay depository (Base)', role: 'bridge' },
  { chainId: 7777777, address: '0x4cd00e387622c35bddb9b4c962c136462338bc31', label: 'Relay depository (Zora)', role: 'bridge' },
].map(e => ({ ...e, source: 'seed', verifiedBy: 'workspaces/trader/PLAYBOOK.md (verifier) + Blockscout verified source', addedAt: '2026-09-22T00:00:00.000Z' }));

class FirewallError extends Error {
  constructor(msg) { super('REFUSED (firewall): ' + msg); this.name = 'FirewallError'; this.firewall = true; }
}
const refuse = msg => { throw new FirewallError(msg); };
const lc = a => String(a || '').toLowerCase();
const same = (a, b) => !!a && lc(a) === lc(b);
/** Date.parse, or `fallback` when the value is missing or unreadable. */
// Only strings are dates: record fields come from a file anyone with write access can edit, and Date.parse(obj) can throw.
const when = (v, fallback) => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : fallback; };
/** Latest addedAt first (seed entries and unreadable timestamps last). Stable, non-mutating. */
const newestFirst = entries => entries.map((e, i) => [e, i]).sort((x, y) => (when(y[0].addedAt, -Infinity) - when(x[0].addedAt, -Infinity)) || (y[1] - x[1])).map(([e]) => e);
const ZERO = '0x0000000000000000000000000000000000000000';
const short = a => { const s = String(a || ''); return s.length > 12 ? s.slice(0, 8) + '…' + s.slice(-4) : s; };

// ── ABIs and rules, keyed by 4-byte selector ──
let _rules = null;
function rules() {
  if (_rules) return _rules;
  const viem = require('viem');
  const KYBER_STRUCTS = [
    'struct SwapDescriptionV2 { address srcToken; address dstToken; address[] srcReceivers; uint256[] srcAmounts; address[] feeReceivers; uint256[] feeAmounts; address dstReceiver; uint256 amount; uint256 minReturnAmount; uint256 flags; bytes permit; }',
    'struct SwapExecutionParams { address callTarget; address approveTarget; bytes targetData; SwapDescriptionV2 desc; bytes clientData; }',
  ];
  const isSelf = (c, a, fn, p) => { if (!same(a, c.self)) refuse(`${fn}: ${p} must be the wallet itself (${c.self}), not ${a}`); };
  const isToken = (c, a, fn, p) => { if (!c.listed(a, ['token'])) refuse(`${fn}: ${p} ${a} is not an allow-listed token on chain ${c.chainId}`); };
  const isTokenOrNative = (c, a, fn, p) => { if (!same(a, NATIVE)) isToken(c, a, fn, p); };
  // `peers` (other wallets in the same keystore) are accepted as recipients only when the caller passed them:
  // the service does, so a guarded wallet can fund an open wallet (held to that wallet's funding cap there).
  const isPeer = (c, a) => (c.peers || []).some(p => same(p, a));
  const toOwnerOrSelf = (c, a, fn, p) => { if (!same(a, c.self) && !c.ownerActive(a) && !isPeer(c, a)) refuse(`${fn}: ${p} must be the owner (${OWNER_LABEL} ${OWNER || 'none configured'}) or the wallet itself${(c.peers || []).length ? ', or another wallet in this keystore' : ''}, not ${a}`); };
  const isWeth = (c, fn) => { if (!c.entry.weth) refuse(`${fn} is only allowed on WETH, not on ${c.entry.label}`); };
  // A Kyber swap moves `srcAmounts` to `srcReceivers`, pays `feeAmounts` to `feeReceivers`, then calls
  // `callTarget` (after approving `approveTarget`) with `targetData` that this firewall does not decode. Every one
  // of those is a place funds can go, so each must be the wallet, the router, or an entry listed under the
  // dedicated `executor` role. A generic `contract` entry (e.g. the Aave Pool) does NOT qualify: with the
  // router's approval and opaque targetData it could be driven to supply/deposit on behalf of a stranger.
  const isExecutor = (c, a, fn, p) => { if (!c.listed(a, ['router', 'executor'])) refuse(`${fn}: ${p} ${a} is not an allow-listed router or swap executor on chain ${c.chainId}`); };
  const kyberDesc = (c, d, fn, { callTarget, approveTarget, caller } = {}) => {
    isSelf(c, d.dstReceiver, fn, 'desc.dstReceiver');
    isTokenOrNative(c, d.srcToken, fn, 'desc.srcToken'); isTokenOrNative(c, d.dstToken, fn, 'desc.dstToken');
    if (!(BigInt(d.minReturnAmount || 0) > 0n)) refuse(`${fn}: desc.minReturnAmount must be > 0`);
    const srcR = d.srcReceivers || [], srcA = d.srcAmounts || [], feeR = d.feeReceivers || [], feeA = d.feeAmounts || [];
    if (srcR.length !== srcA.length) refuse(`${fn}: desc.srcReceivers (${srcR.length}) and desc.srcAmounts (${srcA.length}) differ in length`);
    if (feeR.length !== feeA.length) refuse(`${fn}: desc.feeReceivers (${feeR.length}) and desc.feeAmounts (${feeA.length}) differ in length`);
    for (let i = 0; i < feeA.length; i++) if (BigInt(feeA[i]) > 0n) refuse(`${fn}: desc.feeAmounts[${i}] = ${feeA[i]} would pay a fee to ${feeR[i]}; fees to third parties are not allowed`);
    let sum = 0n; for (const a of srcA) sum += BigInt(a);
    if (sum > BigInt(d.amount || 0)) refuse(`${fn}: desc.srcAmounts sum to ${sum}, more than desc.amount ${d.amount}`);
    for (let i = 0; i < srcR.length; i++) if (!same(srcR[i], c.self)) isExecutor(c, srcR[i], fn, `desc.srcReceivers[${i}]`);
    for (const [p, a] of [['execution.callTarget', callTarget], ['execution.approveTarget', approveTarget], ['caller', caller]]) {
      if (a === undefined) continue;
      if (!same(a, c.self) && !same(a, ZERO)) isExecutor(c, a, fn, p);
    }
  };

  const list = [
    // ERC-20
    { sig: 'function approve(address spender, uint256 amount)', roles: ['token'],
      check: (c, [spender]) => { if (!c.listed(spender, SPENDER_ROLES)) refuse(`approve: spender ${spender} is not an allow-listed router/contract/bridge on chain ${c.chainId}`); } },
    { sig: 'function transfer(address to, uint256 amount)', roles: ['token'], check: (c, [to]) => toOwnerOrSelf(c, to, 'transfer', 'recipient') },
    { sig: 'function transferFrom(address from, address to, uint256 amount)', roles: ['token'],
      check: (c, [from, to]) => { isSelf(c, from, 'transferFrom', 'from'); toOwnerOrSelf(c, to, 'transferFrom', 'recipient'); } },
    // WETH
    { sig: 'function deposit()', roles: ['token'], value: true, check: c => isWeth(c, 'deposit()') },
    { sig: 'function withdraw(uint256 wad)', roles: ['token'], check: c => isWeth(c, 'withdraw(uint256)') },
    // Aave v3 Pool
    { sig: 'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)', roles: ['contract'],
      check: (c, [asset, , onBehalfOf]) => { isToken(c, asset, 'supply', 'asset'); isSelf(c, onBehalfOf, 'supply', 'onBehalfOf'); } },
    { sig: 'function withdraw(address asset, uint256 amount, address to) returns (uint256)', roles: ['contract'],
      check: (c, [asset, , to]) => { isToken(c, asset, 'withdraw', 'asset'); isSelf(c, to, 'withdraw', 'to'); } },
    { sig: 'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)', roles: ['contract'],
      check: (c, [asset, , , , onBehalfOf]) => { isToken(c, asset, 'borrow', 'asset'); isSelf(c, onBehalfOf, 'borrow', 'onBehalfOf'); } },
    { sig: 'function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)', roles: ['contract'],
      check: (c, [asset, , , onBehalfOf]) => { isToken(c, asset, 'repay', 'asset'); isSelf(c, onBehalfOf, 'repay', 'onBehalfOf'); } },
    { sig: 'function repayWithATokens(address asset, uint256 amount, uint256 interestRateMode) returns (uint256)', roles: ['contract'],
      check: (c, [asset]) => isToken(c, asset, 'repayWithATokens', 'asset') },
    { sig: 'function setUserUseReserveAsCollateral(address asset, bool useAsCollateral)', roles: ['contract'],
      check: (c, [asset]) => isToken(c, asset, 'setUserUseReserveAsCollateral', 'asset') },
    // Aave ParaSwapRepayAdapter (repays for msg.sender; Augustus target is registry-checked by the adapter)
    { sig: 'function swapAndRepay(address collateralAsset, address debtAsset, uint256 collateralAmount, uint256 debtRepayAmount, uint256 debtRateMode, uint256 buyAllBalanceOffset, bytes paraswapData, (uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s) permitSignature)', roles: ['contract'],
      check: (c, [col, debt]) => { isToken(c, col, 'swapAndRepay', 'collateralAsset'); isToken(c, debt, 'swapAndRepay', 'debtAsset'); } },
    // Relay depository
    { sig: 'function depositNative(address depositor, bytes32 id) payable', roles: ['bridge'], value: true, check: (c, [depositor]) => isSelf(c, depositor, 'depositNative', 'depositor') },
    { sig: 'function depositErc20(address depositor, address token, bytes32 id)', roles: ['bridge'],
      check: (c, [depositor, token]) => { isSelf(c, depositor, 'depositErc20', 'depositor'); isToken(c, token, 'depositErc20', 'token'); } },
    { sig: 'function depositErc20(address depositor, address token, uint256 amount, bytes32 id)', roles: ['bridge'],
      check: (c, [depositor, token]) => { isSelf(c, depositor, 'depositErc20', 'depositor'); isToken(c, token, 'depositErc20', 'token'); } },
    // KyberSwap MetaAggregationRouterV2
    { sig: 'function swap(SwapExecutionParams execution) payable returns (uint256, uint256)', structs: KYBER_STRUCTS, roles: ['router'], value: true, check: (c, [ex]) => kyberDesc(c, ex.desc, 'swap', ex) },
    { sig: 'function swapGeneric(SwapExecutionParams execution) payable returns (uint256, uint256)', structs: KYBER_STRUCTS, roles: ['router'], value: true, check: (c, [ex]) => kyberDesc(c, ex.desc, 'swapGeneric', ex) },
    { sig: 'function swapSimpleMode(address caller, SwapDescriptionV2 desc, bytes executorData, bytes clientData) returns (uint256, uint256)', structs: KYBER_STRUCTS, roles: ['router'], check: (c, [caller, desc]) => kyberDesc(c, desc, 'swapSimpleMode', { caller }) },
  ];
  _rules = new Map();
  for (const r of list) {
    const abi = viem.parseAbi([...(r.structs || []), r.sig]);
    const fn = abi.find(x => x.type === 'function');
    const selector = viem.toFunctionSelector(fn);
    if (_rules.has(selector)) throw new Error(`firewall: duplicate selector ${selector}`);
    _rules.set(selector, { ...r, abi, name: fn.name, selector, display: `${fn.name}(${fn.inputs.map(i => i.type).join(',')})` });
  }
  return _rules;
}
function allowedFor(role) { return [...rules().values()].filter(r => r.roles.includes(role)).map(r => r.display); }

// ── the address book ──
// Domain-tagged, length-safe canonical form (JSON array, so no field can run into its neighbour) of
// every field that affects what a record permits, including who added it.
const CANON_TAG = 'agent-hub wallet allow-list v1';
function canon(rec) {
  return JSON.stringify([CANON_TAG, String(rec.type || ''), rec.chainId === null || rec.chainId === undefined ? 'any' : String(rec.chainId), lc(rec.address), String(rec.role || ''),
          rec.anySelector ? 1 : 0, rec.allowValue ? 1 : 0, String(rec.addedAt || rec.at || ''), String(rec.label || ''), String(rec.verifiedBy || ''), String(rec.reason || ''), String(rec.by || '')]);
}

class Firewall {
  /**
   * @param {object} o
   * @param {string} o.file        data/wallet-allowlist.json
   * @param {object} [o.keystore]  lib/wallet/keystore Keystore; signs and verifies owner-added records
   * @param {string} [o.owner]     override for tests only
   * @param {Array}  [o.seed]      override for tests only
   */
  constructor({ file, keystore = null, owner = OWNER, seed = SEED, now = () => Date.now() } = {}) {
    if (!file) throw new Error('firewall: file is required');
    this.file = file; this.keystore = keystore; this.owner = owner; this.seed = seed; this.now = now;
  }

  _readFile() {
    let doc; try { doc = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return { version: 1, records: [] }; refuse(`address book ${this.file} is unreadable (${e.message}); refusing everything until the owner fixes it`); }
    if (!doc || !Array.isArray(doc.records)) refuse(`address book ${this.file} is malformed; refusing everything until the owner fixes it`);
    return doc;
  }
  /** Write to a temp file, fsync, rename over the book, then read it back and require byte equality. */
  _writeFile(doc) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const text = JSON.stringify(doc, null, 2) + '\n', tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600); try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.file);
    if (fs.readFileSync(this.file, 'utf8') !== text) throw new Error(`firewall: ${this.file} did not read back what was written; check the disk`);
  }
  /** Cross-process lock for read-modify-write (hub and CLI can both append). Waits up to ~3 s. */
  _locked(fn) {
    const lock = this.file + '.lock'; const deadline = Date.now() + 3000; let fd;
    for (;;) {
      try { fd = fs.openSync(lock, 'wx'); break; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let stale = false; try { stale = Date.now() - fs.statSync(lock).mtimeMs > 10000; } catch { /* vanished */ }
        if (stale) { try { fs.unlinkSync(lock); } catch { /* raced */ } continue; }
        if (Date.now() > deadline) throw new Error(`firewall: ${lock} is held by another writer; try again`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
    try { return fn(); } finally { fs.closeSync(fd); try { fs.unlinkSync(lock); } catch { /* already gone */ } }
  }

  /** 'ok' | 'bad' | 'locked' (cannot verify because the keystore is locked or absent). */
  _verify(rec) {
    if (!rec || typeof rec.sig !== 'string' || !this.keystore) return this.keystore ? 'bad' : 'locked';
    // 'locked' only when the keystore really is locked: any other failure (e.g. a field whose toString throws,
    // making canon() throw) is a record that does not verify, and must not get the leniency 'locked' gets.
    if (!this.keystore.isUnlocked()) return 'locked';
    try { return this.keystore.hmac(canon(rec)) === rec.sig ? 'ok' : 'bad'; }
    catch { return 'bad'; }
  }

  /**
   * Effective book: seed entries + verified owner records, with deactivations applied.
   * Each entry gets `active` and `verified` ('seed' | 'ok' | 'locked'); unverifiable
   * 'add' records ('bad') are dropped entirely; deactivations always apply.
   *
   * Supersede: a deactivation kills every entry for its (address, chainId) that was added at or
   * before its signed `at`. A later 'add' for the same pair is a new, live entry, so an entry can
   * be replaced (deactivate, then add) without editing anything. Seed entries count as older than
   * any deactivation. Missing or unparseable timestamps count as killed (fail closed).
   */
  book() {
    const doc = this._readFile();
    const entries = this.seed.map(e => ({ ...e, active: true, verified: 'seed' }));
    const deactivations = [];
    for (const rec of doc.records) {
      if (!rec || typeof rec !== 'object') continue;
      const v = this._verify(rec);
      // An unsigned or badly signed 'add' is dropped. A deactivation is honoured whatever its
      // signature says: honouring it can only refuse more, never less (fail closed).
      if (v === 'bad' && rec.type !== 'deactivate') continue;
      if (rec.type === 'add') {
        if (!ROLES.includes(rec.role) || rec.role === 'owner') continue;
        entries.push({ chainId: rec.chainId, address: rec.address, label: rec.label, role: rec.role, verifiedBy: rec.verifiedBy, addedAt: rec.addedAt, by: rec.by,
                       anySelector: !!rec.anySelector, allowValue: !!rec.allowValue, source: 'owner', active: true, verified: v });
      } else if (rec.type === 'deactivate') {
        deactivations.push({ ...rec, reason: typeof rec.reason === 'string' ? rec.reason : null, verified: v });
      }
    }
    for (const e of entries) {
      const born = e.source === 'seed' ? -Infinity : Date.parse(e.addedAt);
      let killer = null;
      for (const d of deactivations) {
        if (!same(e.address, d.address) || String(e.chainId) !== String(d.chainId)) continue;
        // An unverifiable deactivation (keystore locked) still deactivates: fail closed. So does
        // one whose `at` cannot be read, whatever the entry's age. A badly signed one kills every
        // entry of the pair: its `at` is unauthenticated, so backdating it must not revive an add.
        // ('locked' keeps its `at`: the adds it could spare are 'locked' too, and lookup refuses those.)
        const at = d.verified === 'bad' ? Infinity : when(d.at, Infinity);
        if (e.source === 'seed' || !Number.isFinite(born) || born <= at) {
          if (!killer || at >= killer.kill) killer = { ...d, kill: at };
        }
      }
      if (killer) {
        e.active = false; e.deactivatedAt = killer.at; e.deactivatedReason = killer.reason || null;
        // Effective kill time (Infinity for a badly signed one); add() must use this, not the raw `at`.
        Object.defineProperty(e, 'deactivatedKill', { value: killer.kill, enumerable: false });
      }
    }
    return entries;
  }
  list() { return this.book(); }

  /** Active, verified entry for (chainId, address), or a refusal. The latest active entry wins. */
  _lookup(entries, chainId, address) {
    const hits = newestFirst(entries.filter(e => same(e.address, address) && (e.chainId === null || e.chainId === undefined ? e.role === 'owner' : String(e.chainId) === String(chainId))));
    if (!hits.length) return null;
    const active = hits.find(e => e.active);
    if (!active) refuse(`"to" ${address} (${hits[0].label}) is DEACTIVATED in the allow-list${hits[0].deactivatedReason ? ': ' + hits[0].deactivatedReason : ''}`);
    if (active.verified === 'locked') refuse(`"to" ${address} (${active.label}) was added by the owner, but the keystore is locked so its signature cannot be verified. Unlock the keystore and retry.`);
    return active;
  }

  /**
   * The check. Throws FirewallError; returns { ok: true, rule, label } when allowed.
   * @param {object} tx  { chainId, from, to, value (bigint|string), data (hex|undefined) }
   */
  check({ chainId, from, to, value = 0n, data, peers = [] } = {}) {
    const viem = require('viem');
    if (!viem.isAddress(String(from || ''))) refuse('sender is not a valid address');
    if (!viem.isAddress(String(to || ''))) refuse('"to" is not a valid address');
    if (chainId === undefined || chainId === null) refuse('chainId is unknown');
    const self = lc(from), dest = lc(to);
    const val = BigInt(value || 0);
    if (val < 0n) refuse(`value ${val} is negative`);
    const hex = data === undefined || data === null ? '' : String(data);
    if (hex && !/^0x[0-9a-fA-F]*$/.test(hex)) refuse('calldata is not valid hex');
    const bytes = hex.replace(/^0x/, '');
    if (bytes.length % 2) refuse('calldata has an odd number of hex digits');
    const hasData = bytes.length > 0;

    const entries = this.book();
    const ownerEntry = entries.find(e => e.role === 'owner' && same(e.address, this.owner));
    const ownerActive = a => !!ownerEntry && ownerEntry.active && same(a, this.owner);

    // 1+2: accounts (owner, self) take plain ETH only; nothing else takes plain ETH.
    if (dest === self || same(dest, this.owner)) {
      if (hasData) refuse(`calldata to ${dest === self ? 'the wallet itself' : `the owner (${OWNER_LABEL})`} is not allowed: it is an account, not a contract`);
      if (dest !== self && !ownerActive(dest)) refuse('the owner entry is deactivated in the allow-list; no external destination is currently allowed');
      return { ok: true, rule: dest === self ? 'plain-eth-to-self' : 'plain-eth-to-owner', label: dest === self ? 'wallet itself' : `${OWNER_LABEL} (owner)` };
    }
    // Another wallet in this keystore (passed in by the service) is an account too: plain ETH only. The
    // service applies the target's funding cap on top when that wallet is an open one.
    const peer = (peers || []).find(p => same(p, dest));
    if (peer) {
      if (hasData) refuse('calldata to another wallet in this keystore is not allowed: it is an account, not a contract');
      return { ok: true, rule: 'plain-eth-to-keystore', label: 'keystore wallet' };
    }
    const entry = this._lookup(entries, chainId, dest);
    if (!entry) refuse(`"to" ${viem.getAddress(dest)} is not in the allow-list for chain ${chainId}. Only the owner (${OWNER_LABEL} ${this.owner}), the wallet itself, and owner-approved strategy contracts may be paid. Ask the owner to add it (verifier-verified) if it belongs to a strategy.`);
    if (!hasData) refuse(`plain ETH transfers may only go to the owner (${OWNER_LABEL}) or the wallet itself; ${entry.label} is a contract`);
    if (bytes.length < 8) refuse(`calldata to ${entry.label} is shorter than a function selector`);

    // 3: decode and validate.
    const selector = '0x' + bytes.slice(0, 8).toLowerCase();
    const rule = rules().get(selector);
    const ctx = { chainId, self, entry, ownerActive, peers, listed: (a, roles) => { const e = newestFirst(entries).find(x => x.active && x.verified !== 'locked' && same(x.address, a) && String(x.chainId) === String(chainId)); return e && roles.includes(e.role) ? e : null; } };
    if (!rule) {
      if (!entry.anySelector) refuse(`selector ${selector} is not allowed on ${entry.label} (role ${entry.role}). Allowed there: ${allowedFor(entry.role).join(', ') || 'nothing'}`);
      if (val > 0n && !entry.allowValue) refuse(`ETH value is not allowed with unknown calldata on ${entry.label}`);
      return { ok: true, rule: 'any-selector', label: entry.label, selector };
    }
    if (!rule.roles.includes(entry.role)) refuse(`${rule.display} is not allowed on ${entry.label} (role ${entry.role}). Allowed there: ${allowedFor(entry.role).join(', ') || 'nothing'}`);
    if (val > 0n && !rule.value) refuse(`ETH value (${viem.formatEther(val)} ETH) is not allowed with ${rule.display} on ${entry.label}`);
    let decoded;
    try { decoded = viem.decodeFunctionData({ abi: rule.abi, data: hex }); } catch (e) { refuse(`calldata for ${rule.display} on ${entry.label} could not be decoded: ${e.shortMessage || e.message}`); }
    if (!decoded || decoded.functionName !== rule.name) refuse(`calldata for ${rule.display} on ${entry.label} decoded ambiguously`);
    // viem tolerates trailing bytes and non-canonical padding; we do not. The calldata must be exactly the canonical encoding of what we checked.
    let canonical;
    try { canonical = viem.encodeFunctionData({ abi: rule.abi, functionName: rule.name, args: decoded.args || [] }); } catch (e) { refuse(`calldata for ${rule.display} on ${entry.label} could not be re-encoded: ${e.shortMessage || e.message}`); }
    if (canonical.toLowerCase() !== hex.toLowerCase()) refuse(`calldata for ${rule.display} on ${entry.label} is not canonical (trailing or non-standard bytes); refusing rather than guessing what the contract would do with it`);
    rule.check(ctx, decoded.args || []);
    return { ok: true, rule: rule.display, label: entry.label, selector };
  }

  // ── owner actions (passphrase required; never callable through agent tools) ──
  /**
   * Append an entry. Requires the keystore passphrase; the record is HMAC-signed.
   * role 'owner' is refused: the owner destination is fixed in code.
   */
  add({ address, chainId, label, role, verifiedBy, anySelector = false, allowValue = false, by = 'owner' } = {}, passphrase) {
    const viem = require('viem');
    if (!this.keystore) throw new Error('firewall: no keystore; entries cannot be signed');
    if (!viem.isAddress(String(address || ''))) throw new Error('address must be a 0x address');
    if (!Number.isInteger(Number(chainId)) || Number(chainId) <= 0) throw new Error('chainId must be a positive integer');
    if (!ROLES.includes(role) || role === 'owner') throw new Error(`role must be one of ${ROLES.filter(r => r !== 'owner').join(', ')} (the owner destination is fixed in code)`);
    if (!String(label || '').trim()) throw new Error('label is required');
    if (!String(verifiedBy || '').trim()) throw new Error('verifiedBy is required (path of the verifier VERIFIED report)');
    if (same(address, this.owner)) throw new Error('the owner address is already the fixed destination');
    if (role === 'executor' && (anySelector || allowValue)) throw new Error('an executor entry may only be reached through a router; anySelector/allowValue are not allowed on it');
    // Only an ACTIVE entry blocks an add; deactivated ones are superseded by the new record. The new
    // record must be strictly younger than every deactivation of the pair, or book() would kill it.
    const guard = () => {
      const pair = this.book().filter(e => same(e.address, address) && String(e.chainId) === String(chainId));
      const live = pair.find(e => e.active);
      if (live) throw new Error(`${address} on chain ${chainId} is already in the book (${live.label}). Entries cannot be edited; deactivate it and add a new one if it must change.`);
      const kills = pair.filter(e => e.deactivatedAt !== undefined).map(e => e.deactivatedKill ?? when(e.deactivatedAt, Infinity));
      const last = Math.max(-Infinity, ...kills);
      // A deactivation with an unreadable or future date would kill the new entry too (or leave it dated in the
      // future). Refuse and say so, rather than write an entry that silently never becomes active.
      if (last > this.now() + 5 * 60 * 1000) throw new Error(`${address} on chain ${chainId} has a deactivation dated ${Number.isFinite(last) ? new Date(last).toISOString() : 'unreadably or without a valid signature'}; it cannot be superseded. Check the allow-list file for tampering.`);
      return last;
    };
    const lastKill = guard();
    const rec = { type: 'add', address: viem.getAddress(address), chainId: Number(chainId), label: String(label).trim(), role, verifiedBy: String(verifiedBy).trim(),
                  anySelector: !!anySelector, allowValue: !!allowValue, addedAt: new Date(Math.max(this.now(), lastKill + 1)).toISOString(), by };
    rec.sig = this.keystore.hmac(canon(rec), passphrase);    // throws 'Wrong passphrase.' (scrypt: slow, so signed outside the lock)
    this._locked(() => {
      // Re-check under the lock: another writer (hub or CLI) may have appended since.
      if (guard() >= Date.parse(rec.addedAt)) throw new Error(`${address} on chain ${chainId} was deactivated again while this add was being signed; try again`);
      const doc = this._readFile(); doc.records.push(rec); this._writeFile(doc);
    });
    return rec;
  }
  /** Append a deactivation for (address, chainId). Works on seed entries too. Never removes anything. */
  deactivate({ address, chainId, reason = '', by = 'owner' } = {}, passphrase) {
    const viem = require('viem');
    if (!this.keystore) throw new Error('firewall: no keystore; records cannot be signed');
    if (!viem.isAddress(String(address || ''))) throw new Error('address must be a 0x address');
    const guard = () => {
      const hits = this.book().filter(e => same(e.address, address) && (e.role === 'owner' ? (chainId === null || chainId === undefined || chainId === 'any') : String(e.chainId) === String(chainId)));
      if (!hits.length) throw new Error(`${address} on chain ${chainId} is not in the book`);
      const live = hits.filter(e => e.active);
      if (!live.length) throw new Error(`${address} on chain ${chainId} is already deactivated`);
      return { hits, newest: Math.max(-Infinity, ...live.filter(e => e.source !== 'seed').map(e => Date.parse(e.addedAt)).filter(Number.isFinite)) };
    };
    const { hits, newest } = guard();
    // `at` must be no earlier than every live entry's addedAt, or book() would leave that entry alive.
    const rec = { type: 'deactivate', address: viem.getAddress(address), chainId: hits[0].role === 'owner' ? null : Number(chainId), reason: String(reason || ''), at: new Date(Math.max(this.now(), newest)).toISOString(), by };
    rec.sig = this.keystore.hmac(canon(rec), passphrase);
    this._locked(() => {
      if (guard().newest > Date.parse(rec.at)) throw new Error(`${address} on chain ${chainId} was re-added while this deactivation was being signed; try again`);
      const doc = this._readFile(); doc.records.push(rec); this._writeFile(doc);
    });
    return rec;
  }
}

module.exports = { Firewall, FirewallError, OWNER, OWNER_LABEL, NATIVE, ZERO, SEED, ROLES, rules, allowedFor, canon };
