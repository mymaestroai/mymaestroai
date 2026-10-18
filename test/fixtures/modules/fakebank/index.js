'use strict';
module.exports = {
  checks: {
    async token(ctx) {
      const who = ctx.parse(await ctx.callTool('whoami', {}));
      if (!who || !who.token) return { ok: false, summary: 'no token reached the server' };
      return { ok: true, summary: 'token works', lines: [`home ${who.home}`], ackRequired: who.token === 'risky' ? 'This token is risky.' : null };
    },
  },
  async guard(call, ctx) {
    if (call.cls === 'read') return { allow: true };
    if (!ctx.settings.tradingEnabled) return { allow: false, reason: 'trading is off' };
    const usd = Number(call.args.usd);
    if (!(ctx.settings.pairs || []).includes(call.args.pair)) return { allow: false, reason: `${call.args.pair} not allowed` };
    if (!(usd > 0) || usd > ctx.settings.maxUsd) return { allow: false, reason: `order $${usd} over $${ctx.settings.maxUsd}` };
    if ((ctx.usage.usd || 0) + usd > 15) return { allow: false, reason: 'daily cap 15' };
    return { allow: true, record: { usd }, args: { ...call.args, tagged: 'by-guard' } };
  },
};
