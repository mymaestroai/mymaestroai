'use strict';

/**
 * hyperliquid-signing.js — the two Hyperliquid signature schemes, ported from the official
 * Python SDK (hyperliquid/utils/signing.py) and checked byte-for-byte against its test
 * vectors (tests/signing_test.py) in test/wallet-hyperliquid.test.js.
 *
 *  L1 actions (order, cancel, updateLeverage, vaultTransfer): signed by the AGENT key.
 *    connectionId = keccak256( msgpack(action) ‖ nonce:u64be ‖ (0x00 | 0x01‖vault) [‖ 0x00‖expiresAfter:u64be] )
 *    EIP-712 domain {name:"Exchange", version:"1", chainId:1337, verifyingContract:0x0},
 *    type Agent{source:string, connectionId:bytes32}, source "a" = mainnet, "b" = testnet.
 *
 *  User-signed actions (approveAgent, withdraw3, usdClassTransfer, usdSend): signed by the MAIN key.
 *    EIP-712 domain {name:"HyperliquidSignTransaction", version:"1", chainId:signatureChainId, verifyingContract:0x0},
 *    primary type "HyperliquidTransaction:<Name>"; the action carries hyperliquidChain and signatureChainId.
 *
 * msgpack field order is part of the hash: build wire objects in exactly the SDK's key order.
 * Private keys enter only through `signer` callbacks provided by the keystore; nothing here stores one.
 */

const { encode: msgpackEncode } = require('@msgpack/msgpack');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const L1_DOMAIN = { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: ZERO_ADDRESS };
const AGENT_TYPES = { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] };
const SIGNATURE_CHAIN_ID = '0x66eee';   // the SDK signs every user action with this; Hyperliquid accepts any chain here

const USER_SIGNED_TYPES = {
  'HyperliquidTransaction:ApproveAgent': [
    { name: 'hyperliquidChain', type: 'string' }, { name: 'agentAddress', type: 'address' }, { name: 'agentName', type: 'string' }, { name: 'nonce', type: 'uint64' }],
  'HyperliquidTransaction:Withdraw': [
    { name: 'hyperliquidChain', type: 'string' }, { name: 'destination', type: 'string' }, { name: 'amount', type: 'string' }, { name: 'time', type: 'uint64' }],
  'HyperliquidTransaction:UsdSend': [
    { name: 'hyperliquidChain', type: 'string' }, { name: 'destination', type: 'string' }, { name: 'amount', type: 'string' }, { name: 'time', type: 'uint64' }],
  'HyperliquidTransaction:UsdClassTransfer': [
    { name: 'hyperliquidChain', type: 'string' }, { name: 'amount', type: 'string' }, { name: 'toPerp', type: 'bool' }, { name: 'nonce', type: 'uint64' }],
};
const USER_ACTION_TYPE = { approveAgent: 'HyperliquidTransaction:ApproveAgent', withdraw3: 'HyperliquidTransaction:Withdraw', usdSend: 'HyperliquidTransaction:UsdSend', usdClassTransfer: 'HyperliquidTransaction:UsdClassTransfer' };

const hexToBytes = (h) => Buffer.from(String(h).replace(/^0x/, ''), 'hex');
function u64be(n) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; }

/** keccak256 of the msgpack'd action plus nonce / vault / expiry, exactly as the SDK builds it. */
function actionHash(action, { vaultAddress = null, nonce, expiresAfter = null }) {
  const viem = require('viem');
  const parts = [Buffer.from(msgpackEncode(action)), u64be(nonce)];
  if (vaultAddress) parts.push(Buffer.from([1]), hexToBytes(vaultAddress)); else parts.push(Buffer.from([0]));
  if (expiresAfter !== null && expiresAfter !== undefined) parts.push(Buffer.from([0]), u64be(expiresAfter));
  return viem.keccak256(Buffer.concat(parts));
}

function splitSignature(sig) {
  const h = String(sig).replace(/^0x/, '');
  const v = parseInt(h.slice(128, 130), 16);
  return { r: '0x' + h.slice(0, 64).replace(/^0+/, ''), s: '0x' + h.slice(64, 128).replace(/^0+/, ''), v: v < 27 ? v + 27 : v };
}

/**
 * Sign an L1 action. `signer(typedData)` must return a 65-byte hex signature (viem account.signTypedData).
 * Returns { r, s, v } in Hyperliquid's format (r/s without leading zeros, like eth_utils.to_hex).
 */
async function signL1Action(signer, action, { vaultAddress = null, nonce, expiresAfter = null, isMainnet }) {
  const connectionId = actionHash(action, { vaultAddress, nonce, expiresAfter });
  const sig = await signer({ domain: L1_DOMAIN, types: AGENT_TYPES, primaryType: 'Agent', message: { source: isMainnet ? 'a' : 'b', connectionId } });
  return splitSignature(sig);
}

/** Sign a user action. Mutates `action` to add hyperliquidChain / signatureChainId, as the SDK does. */
async function signUserAction(signer, action, { isMainnet }) {
  const primaryType = USER_ACTION_TYPE[action.type];
  if (!primaryType) throw new Error(`No user-signed type for action "${action.type}"`);
  action.signatureChainId = SIGNATURE_CHAIN_ID;
  action.hyperliquidChain = isMainnet ? 'Mainnet' : 'Testnet';
  const types = { [primaryType]: USER_SIGNED_TYPES[primaryType] };
  const message = {}; for (const f of USER_SIGNED_TYPES[primaryType]) message[f.name] = f.type === 'uint64' ? BigInt(action[f.name]) : action[f.name];
  const sig = await signer({ domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: parseInt(SIGNATURE_CHAIN_ID, 16), verifyingContract: ZERO_ADDRESS }, types, primaryType, message });
  return splitSignature(sig);
}

/** A signer callback from a viem private key (used only inside keystore.withPrivateKey). */
function signerFromPrivateKey(pk) {
  const { privateKeyToAccount } = require('viem/accounts');
  const account = privateKeyToAccount(pk);
  return (typedData) => account.signTypedData(typedData);
}

// ── wire helpers (SDK float_to_wire and the price/size rounding rules) ──
/** Decimal string with up to 8 places and no trailing zeros or exponent: 100 -> "100", 0.0147 -> "0.0147". */
function floatToWire(x) {
  const n = Number(x); if (!Number.isFinite(n)) throw new Error(`Not a number: ${x}`);
  const rounded = n.toFixed(8);
  if (Math.abs(Number(rounded) - n) >= 1e-12) throw new Error(`floatToWire causes rounding: ${x}`);
  let s = rounded.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0' || s === '') s = '0';
  return s;
}
/** Hyperliquid prices: at most 5 significant figures AND at most (6 - szDecimals) decimals for perps, (8 - szDecimals) for spot. */
function roundPrice(px, szDecimals, isSpot = false) {
  const n = Number(px); if (!(n > 0)) throw new Error(`Bad price ${px}`);
  const sig = Number(n.toPrecision(5));
  const maxDec = (isSpot ? 8 : 6) - szDecimals;
  return Number(sig.toFixed(Math.max(0, maxDec)));
}
function roundSize(sz, szDecimals) {
  const n = Number(sz); if (!(n > 0)) throw new Error(`Bad size ${sz}`);
  const f = 10 ** szDecimals; return Math.floor(n * f + 1e-9) / f;
}
/** Order wire in the SDK's exact key order. */
function orderWire({ asset, isBuy, price, size, reduceOnly = false, tif = 'Gtc', cloid = null }) {
  const w = { a: asset, b: !!isBuy, p: floatToWire(price), s: floatToWire(size), r: !!reduceOnly, t: { limit: { tif } } };
  if (cloid) w.c = cloid;
  return w;
}
const orderAction = (wires, grouping = 'na') => ({ type: 'order', orders: wires, grouping });

module.exports = { actionHash, signL1Action, signUserAction, signerFromPrivateKey, splitSignature, floatToWire, roundPrice, roundSize, orderWire, orderAction, USER_SIGNED_TYPES, SIGNATURE_CHAIN_ID, L1_DOMAIN };
