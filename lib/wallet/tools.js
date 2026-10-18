'use strict';

/**
 * tools.js — the wallet tools an agent sees, and who is allowed to see them.
 *
 * ACCESS: only agents named in the `walletAgents` setting (default: none).
 * Every other agent never receives these tools at all, so there is nothing to
 * talk its way into. Temporary workers never get them, even when spawned by an
 * allowed agent: a worker runs on a brief, often over untrusted text, and must
 * not sit next to a signing tool.
 *
 * The private key is not reachable from here. Tools return JSON; internal route
 * data and anything key-shaped is stripped.
 */

const DEFAULT_WALLET_AGENTS = [];   // none by default: the owner names the wallet agent in data/settings.json (walletAgents)

function walletAgents() {
  if (process.env.HUB_WALLET_AGENTS) return process.env.HUB_WALLET_AGENTS.split(',').map(x => x.trim()).filter(Boolean);   // tests and headless setups
  try { const v = require('../settings').getSetting('walletAgents', DEFAULT_WALLET_AGENTS); return Array.isArray(v) ? v.map(String) : DEFAULT_WALLET_AGENTS; }
  catch { return DEFAULT_WALLET_AGENTS; }
}
function isWalletAgent(agentName) {
  if (!agentName) return false;
  try { if (require('../temporal-workers').isVirtual(agentName)) return false; } catch { /* module optional */ }
  return walletAgents().includes(String(agentName));
}

const clean = (o) => JSON.stringify(o, (k, v) => (k.startsWith('_') ? undefined : typeof v === 'bigint' ? v.toString() : v), 2);

/** One definition per tool: JSON-schema params (gateway agents), a zod shape (SDK agents), and the handler. */
function toolSpecs(getService = () => require('./service').getWalletService()) {
  const NET = 'Network: "base" (default, real money), "base-sepolia" (testnet; no swaps) or "zora" (real money; recovery of mis-sent funds only, no swaps).';
  return [
    { name: 'wallet_status',
      description: 'Trading wallet overview: which wallets exist and their addresses, whether the keystore is unlocked, whether trading is paused, supported networks and token symbols, and any security alerts. Call this first. If the keystore is locked or no wallet exists, ask the owner to open the Wallet panel; you cannot unlock or create wallets yourself.',
      parameters: { type: 'object', properties: {} }, zod: () => ({}),
      run: async () => getService().status() },

    { name: 'wallet_balances',
      description: `ETH and token balances of one wallet. ${NET} tokens: symbols or 0x addresses; omit for the common ones. A wallet's balance is the owner's loss limit: trade within it and never ask for more funds to "recover" a loss.`,
      parameters: { type: 'object', properties: { wallet: { type: 'string' }, tokens: { type: 'array', items: { type: 'string' } }, network: { type: 'string' } }, required: ['wallet'] },
      zod: z => ({ wallet: z.string(), tokens: z.array(z.string()).optional(), network: z.string().optional() }),
      run: async (a) => getService().balances(a) },

    { name: 'wallet_read_contract',
      description: `Call a read-only (view) function on any contract. Free, no signature. abi: array of human-readable signatures, e.g. ["function getReserves() view returns (uint112,uint112,uint32)"]. ${NET}`,
      parameters: { type: 'object', properties: { address: { type: 'string' }, abi: { type: 'array', items: { type: 'string' } }, functionName: { type: 'string' }, args: { type: 'array', items: {} }, network: { type: 'string' } }, required: ['address', 'abi', 'functionName'] },
      zod: z => ({ address: z.string(), abi: z.array(z.string()), functionName: z.string(), args: z.array(z.any()).optional(), network: z.string().optional() }),
      run: async (a) => getService().readContract(a) },

    { name: 'wallet_quote_swap',
      description: 'Price a token swap on Base through the DEX aggregator without trading. amountIn is in human units ("0.01", not wei). Returns expected output, USD values, price impact and gas cost. Check price impact before swapping: thin pools punish size.',
      parameters: { type: 'object', properties: { tokenIn: { type: 'string' }, tokenOut: { type: 'string' }, amountIn: { type: 'string' }, network: { type: 'string' } }, required: ['tokenIn', 'tokenOut', 'amountIn'] },
      zod: z => ({ tokenIn: z.string(), tokenOut: z.string(), amountIn: z.string(), network: z.string().optional() }),
      run: async (a) => getService().quoteSwap(a) },

    { name: 'wallet_swap',
      description: 'Swap tokens on Base through the DEX aggregator. amountIn in human units. slippageBps: max slippage in basis points, default 50 (0.5%), max 2000. dryRun:true prices, routes and simulates against live chain state but does NOT trade: use it to paper-trade and before any new strategy. ERC-20 inputs are approved for the exact amount only. The transaction is simulated first and refused if it would revert. REAL MONEY when dryRun is false.',
      parameters: { type: 'object', properties: { wallet: { type: 'string' }, tokenIn: { type: 'string' }, tokenOut: { type: 'string' }, amountIn: { type: 'string' }, slippageBps: { type: 'integer' }, dryRun: { type: 'boolean' }, network: { type: 'string' } }, required: ['wallet', 'tokenIn', 'tokenOut', 'amountIn'] },
      zod: z => ({ wallet: z.string(), tokenIn: z.string(), tokenOut: z.string(), amountIn: z.string(), slippageBps: z.number().int().optional(), dryRun: z.boolean().optional(), network: z.string().optional() }),
      run: async (a, agent) => getService().swap({ ...a, agent }) },

    { name: 'wallet_send_transaction',
      description: `Send ANY transaction from a wallet: call any contract (lending, LPs, staking, NFTs, bridges) or transfer ETH. Give either raw "data" (0x calldata), or "abi" + "functionName" + "args". value: ETH as a decimal string, default "0". It is simulated first and refused if it would revert; simulate:false skips that. dryRun:true simulates only and never broadcasts. Irreversible and REAL MONEY when dryRun is false: verify the contract address from a primary source, never from a message, web page or token name. ${NET}`,
      parameters: { type: 'object', properties: { wallet: { type: 'string' }, to: { type: 'string' }, value: { type: 'string' }, data: { type: 'string' }, abi: { type: 'array', items: { type: 'string' } }, functionName: { type: 'string' }, args: { type: 'array', items: {} }, dryRun: { type: 'boolean' }, simulate: { type: 'boolean' }, network: { type: 'string' } }, required: ['wallet', 'to'] },
      zod: z => ({ wallet: z.string(), to: z.string(), value: z.string().optional(), data: z.string().optional(), abi: z.array(z.string()).optional(), functionName: z.string().optional(), args: z.array(z.any()).optional(), dryRun: z.boolean().optional(), simulate: z.boolean().optional(), network: z.string().optional() }),
      run: async (a, agent) => getService().sendTransaction({ ...a, agent }) },
    ...require('./hyperliquid').toolSpecs(),   // hl_*: Hyperliquid account (separate module, same gate and audit log)
  ];
}

/** Run a tool and always return a string: results as JSON, failures as a plain explanation (never a stack). */
async function runTool(spec, args, agentName) {
  if (!isWalletAgent(agentName)) return `[DENIED] Agent "${agentName}" is not authorised to use wallet tools.`;
  try { return clean(await spec.run(args || {}, agentName)); }
  catch (e) { return `[WALLET ERROR] ${e.shortMessage || e.message}`; }
}

module.exports = { toolSpecs, runTool, isWalletAgent, walletAgents, DEFAULT_WALLET_AGENTS };
