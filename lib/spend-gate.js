'use strict';
// spend-gate.js: the monthly spending cap for the few paid provider calls that do not go through lib/gateway-client
// (images, paid web search, the Perplexity classifier, Mythos on the Anthropic API, key tests that send a request).
// refusal({ provider, model, agent }) -> the person-facing sentence when the call must not be sent, else null.
// It uses the hub's shared ledger only if it already exists, so a unit test never opens the real database.
function refusal(args) {
  try {
    const l = require('./ledger').peekLedger();
    const g = l && l.monthlyGate ? l.monthlyGate(args || {}) : null;
    return g && g.refused ? g.text : null;
  } catch { return null; }
}
module.exports = { refusal };
