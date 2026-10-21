'use strict';
// Monthly API credits: the ledger sums one provider's spend since the credit last renewed (settings.apiCredits),
// and the desktop header and the phone menu show it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLedger, creditPeriod, creditPeriodStart, cleanCredit, CREDIT_PROVIDERS } = require('../lib/ledger');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();

test('creditPeriodStart: the latest renewal day on or before today, across month and year ends', () => {
  assert.strictEqual(creditPeriodStart(1, at(2026, 10, 19)), '2026-10-01');
  assert.strictEqual(creditPeriodStart(19, at(2026, 10, 19)), '2026-10-19');
  assert.strictEqual(creditPeriodStart(20, at(2026, 10, 19)), '2026-09-20');
  assert.strictEqual(creditPeriodStart(15, at(2027, 1, 10)), '2026-12-15');
  assert.strictEqual(creditPeriodStart(31, at(2026, 10, 30)), '2026-10-28', 'renewal days past 28 are treated as the 28th');
  assert.strictEqual(creditPeriodStart(0, at(2026, 10, 19)), '2026-10-01');
  assert.deepStrictEqual(creditPeriod(1, at(2026, 10, 19)), { since: '2026-10-01', until: '2026-11-01' });
  assert.deepStrictEqual(creditPeriod(20, at(2026, 10, 19)), { since: '2026-09-20', until: '2026-10-20' });
  assert.deepStrictEqual(creditPeriod(15, at(2027, 1, 10)), { since: '2026-12-15', until: '2027-01-15' });
});

test('cleanCredit: blank or zero means none; amounts and renewal days are checked', () => {
  assert.strictEqual(cleanCredit({ monthlyUsd: '' }), null);
  assert.strictEqual(cleanCredit({ monthlyUsd: 0 }), null);
  assert.strictEqual(cleanCredit(null), null);
  assert.deepStrictEqual(cleanCredit({ monthlyUsd: '$200' }), { monthlyUsd: 200, resetDay: 1 });
  assert.deepStrictEqual(cleanCredit({ monthlyUsd: '12.345', resetDay: '15' }), { monthlyUsd: 12.35, resetDay: 15 });
  assert.strictEqual(cleanCredit({ monthlyUsd: '0.004' }), null, 'rounds to zero: no credit (never a zero to divide by)');
  assert.throws(() => cleanCredit({ monthlyUsd: 'lots' }), /dollar amount/);
  assert.throws(() => cleanCredit({ monthlyUsd: -5 }), /dollar amount/);
  assert.throws(() => cleanCredit({ monthlyUsd: 200, resetDay: 29 }), /from 1 to 28/);
  assert.ok(CREDIT_PROVIDERS.includes('anthropic') && !CREDIT_PROVIDERS.includes('claude-sdk'), 'subscription turns are never billed against a credit');
});

test('credits(): one provider\'s spend since the period began; subscription turns, other providers and earlier periods excluded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-credits-'));
  const clock = { t: at(2026, 9, 30) };
  let credits = { anthropic: { monthlyUsd: 200, resetDay: 1 }, openai: { monthlyUsd: '' }, bogus: { monthlyUsd: 50 } };
  const l = createLedger({ file: path.join(dir, 'ledger.db'), now: () => clock.t, getCredits: () => credits });
  try {
    l.record({ agent: 'doc', model: 'anthropic/claude-fable-5-1', costUsd: 5 });                   // last period
    clock.t = at(2026, 10, 2);
    l.record({ agent: 'doc', model: 'anthropic/claude-fable-5-1', costUsd: 3 });
    l.record({ agent: 'doc', model: 'anthropic/claude-fable-5-1', costUsd: 1.5, ok: false });      // a failed call was still billed
    l.record({ agent: 'maestro', model: 'claude-sdk/claude-opus-5-5', costUsd: 10 });               // subscription, API-equivalent only
    l.record({ agent: 'tester', model: 'openrouter/anthropic/claude-fable-5.1', costUsd: 2 });     // billed by OpenRouter
    l.record({ agent: 'doc', model: 'anthropic/zz-unknown-model', inputTokens: 1000, outputTokens: 100 });   // no known price
    clock.t = at(2026, 11, 2);
    l.record({ agent: 'doc', model: 'anthropic/claude-fable-5-1', costUsd: 9 });                   // next period
    clock.t = at(2026, 10, 25);
    l.record({ agent: 'doc', model: 'anthropic/claude-fable-5-1', costUsd: 7 });                   // later this period, i.e. after "now" below: mis-dated
    clock.t = at(2026, 10, 19);
    assert.deepStrictEqual(l.credits(), [{ provider: 'anthropic', monthlyUsd: 200, resetDay: 1, since: '2026-10-01', until: '2026-11-01', spent: 4.5, turns: 3, unpriced: 1 }]);
    credits = { anthropic: { monthlyUsd: 200, resetDay: 1 }, openrouter: { monthlyUsd: 20, resetDay: 1 } };
    assert.deepStrictEqual(l.credits().map(c => [c.provider, c.spent]), [['anthropic', 4.5], ['openrouter', 2]]);
    credits = {};
    assert.deepStrictEqual(l.credits(), [], 'no credit set: nothing to show');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('server: /api/ledger/today carries the credits; POST /api/ledger/credits validates and saves settings.apiCredits; admin-only', () => {
  const s = read('server.js');
  assert.match(s, /caps: l\.caps\(\), credits: l\.credits\(\)/);
  assert.match(s, /pathname === '\/api\/ledger\/credits' && req\.method === 'POST'/);
  assert.match(s, /hubSettings\.updateSettings\(\{ apiCredits: next \}\)/);
  const { classifyRoute } = require('../lib/access');
  assert.strictEqual(classifyRoute('/api/ledger/credits', 'POST').kind, 'admin');
  assert.strictEqual(classifyRoute('/api/ledger/today', 'GET').kind, 'admin');
  assert.match(read('lib/sdk-chat.js'), /getCredits: \(\) => \{ try \{ return require\('\.\/settings'\)\.getSetting\('apiCredits', \{\}\)/);
});

test('desktop: a credit chip beside today\'s spend (amber at 75%, rose at 90%), a Settings row to set it, hidden from members', () => {
  const html = read('index.html'), app = read('app.js');
  assert.match(html, /<span id="spend-today"[^>]*><\/span><span id="credit-meter" onclick="openSettingsAt\('st-spend-section'\)"><\/span>/);
  assert.match(html, /#credit-meter\.warn \{/);
  assert.match(html, /#credit-meter\.hot \{/);
  assert.match(app, /function paintCreditMeter\(\)/);
  assert.match(app, /el\.classList\.toggle\('hot', pct >= 0\.9\)/);
  assert.match(app, /el\.classList\.toggle\('warn', pct >= 0\.75 && pct < 0\.9\)/);
  assert.match(app, /paintSpendToday\(\);\n\s+paintCreditMeter\(\);/, 'repainted with every ledger refresh');
  assert.match(app, /id="st-credit-provider" onchange="fillCreditInputs\(\)"/);
  assert.match(app, /onclick="saveCredit\(\)"/);
  assert.match(app, /fetch\('\/api\/ledger\/credits', \{ method: 'POST'/);
  assert.match(app, /'credit-meter', 'spend-today', 'plan-warn'/, 'members never see it');
});

test('phone: the ⋮ menu shows the credit to admins when one is set', () => {
  const html = read('mobile.html'), js = read('mobile.js');
  assert.match(html, /<div id="menu">\n\s+<div id="menu-credit" hidden><\/div>/);
  assert.match(js, /if \(menu\.classList\.contains\('open'\)\) paintMenuCredit\(\);/);
  assert.match(js, /async function paintMenuCredit\(\) \{[\s\S]*?if \(!isAdmin\(\)\) \{ el\.hidden = true; return; \}[\s\S]*?api\('\/api\/ledger\/today'\)/);
  assert.match(read('sw.js'), /const VERSION = 'hub-mobile-v56'/);
});

test('no ledger: no credit figures, rather than a reassuring $0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-none-'));
  fs.writeFileSync(path.join(dir, 'a-file'), '');   // the ledger's folder would have to be inside a file: it cannot open
  const l = createLedger({ file: path.join(dir, 'a-file', 'ledger.db'), getCredits: () => ({ anthropic: { monthlyUsd: 200 } }) });
  const orig = console.error; console.error = () => {};
  try { assert.deepStrictEqual(l.credits(), []); } finally { console.error = orig; fs.rmSync(dir, { recursive: true, force: true }); }
});
