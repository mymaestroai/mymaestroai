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
  assert.match(server, /patch\.modelOffers = patch\.modelOffers !== false/);
  assert.match(server, /model-offer\$\/\.test\(pathname\) && req\.method === 'GET'/);
  assert.match(server, /model-offer\\\/decline\$\/\.test\(pathname\) && req\.method === 'POST'/);
  assert.match(server, /That suggestion is no longer current\./);
});
