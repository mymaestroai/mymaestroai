'use strict';
// The model suggestion box on agent-settings.html, the app.js toggle and the server routes, checked from source.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const page = read('agent-settings.html');
const fnBody = (src, name) => { const i = src.indexOf(`async function ${name}(`); assert.ok(i >= 0, name); const j = src.indexOf('\n  async function ', i + 10); return src.slice(i, j < 0 ? i + 3000 : j); };

test('the box is hidden by default and its texts are set with textContent', () => {
  assert.match(page, /id="model-offer" style="display:none/);
  const load = fnBody(page, 'loadModelOffer');
  assert.match(load, /model-offer-title'\)\.textContent/);
  assert.match(load, /model-offer-why'\)\.textContent/);
  assert.match(load, /A newer model is available: /);
  assert.match(load, /A stronger model for second opinions: /);
  const block = page.slice(page.indexOf('let currentOffer'), page.indexOf('async function saveModel()'));
  assert.doesNotMatch(block, /innerHTML/);
});

test('Switch posts the offered id to /model, Not now posts to /model-offer/decline', () => {
  const sw = fnBody(page, 'switchToOffer');
  assert.match(sw, /\/model`/);
  assert.match(sw, /JSON\.stringify\(\{ model: o\.to \}\)/);
  assert.match(sw, /loadModelOffer\(\)/);
  const dec = fnBody(page, 'declineOffer');
  assert.match(dec, /\/model-offer\/decline`/);
  assert.match(dec, /JSON\.stringify\(\{ model: o\.to \}\)/);
  assert.match(page, /id="model-offer-switch"/);
  assert.match(page, /id="model-offer-decline"/);
});

test('the pin saves modelPinned through PATCH and toggles the offer', () => {
  assert.match(page, /id="model-pinned"/);
  assert.match(page, /Keep this model \(no suggestions\)/);
  const pin = fnBody(page, 'saveModelPinned');
  assert.match(pin, /method: 'PATCH'/);
  assert.match(pin, /JSON\.stringify\(\{ modelPinned: on \}\)/);
  assert.match(pin, /hideOffer\(\)/);
  assert.match(pin, /loadModelOffer\(\)/);
});

test('settings toggle, setting patch and routes exist', () => {
  const app = read('app.js'), server = read('server.js');
  assert.match(app, /id="st-model-offers"[^>]*saveModelOffersToggle\(this\.checked\)/);
  assert.match(app, /Your Maestro suggests newer models for your agents\./);
  assert.match(app, /modelOffers: !!on/);
  // the cleaner moved to lib/settings-apply cleanSettingsPatch (POST /api/settings calls it): test the real function
  const clean = (v) => require('./helpers/isolated-settings-apply').callSettingsApply('cleanSettingsPatch', [{ modelOffers: v }, {}]).patch.modelOffers;   // in a throwaway install
  assert.strictEqual(clean(undefined) === undefined || clean(true), true);
  assert.strictEqual(clean(false), false); assert.strictEqual(clean('x'), true); assert.strictEqual(clean(0), true);
  assert.match(server, /require\('\.\/lib\/settings-apply'\)\.cleanSettingsPatch\(patch,/);
  assert.match(server, /model-offer\$\/\.test\(pathname\) && req\.method === 'GET'/);
  assert.match(server, /model-offer\\\/decline\$\/\.test\(pathname\) && req\.method === 'POST'/);
  assert.match(server, /That suggestion is no longer current\./);
});

test('review r1 (GPT-6): a suggestion answer that arrives after the pin was saved never shows the box again', async () => {
  const vm = require('vm');
  const block = page.slice(page.indexOf('  let currentOffer = null;'), page.indexOf('  async function switchToOffer('));
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, style: { display: 'none' }, textContent: '', checked: false });
  let release;
  const ctx = {
    agentName: 'helper-b',
    document: { getElementById: el },
    apiFetch: () => new Promise((ok) => { release = () => ok({ offer: { from: 'claude-sdk/claude-opus-5-5', to: 'claude-sdk/claude-opus-6', kind: 'newer', why: 'w', route: 'Subscription', cost: '' } }); }),
  };
  vm.createContext(ctx);
  vm.runInContext(block + '\nglobalThis.api = { loadModelOffer, hideOffer };', ctx);
  const p = ctx.api.loadModelOffer();          // the answer is still on its way
  el('model-pinned').checked = true;          // the pin is saved meanwhile
  ctx.api.hideOffer();
  release(); await p;
  assert.equal(el('model-offer').style.display, 'none');
  // and without a pin, an overtaken answer is dropped too: only the newest load draws
  el('model-pinned').checked = false;
  const first = ctx.api.loadModelOffer(); const r1 = release;
  const second = ctx.api.loadModelOffer(); const r2 = release;
  r2(); await second;
  assert.equal(el('model-offer').style.display, 'block');
  ctx.api.hideOffer();
  r1(); await first;
  assert.equal(el('model-offer').style.display, 'none', 'the older answer does not bring it back');
});
