'use strict';
// The model suggestion: the app.js toggle and the server routes, checked from source.
// (P4-2: the suggestion box on agent-settings.html is gone with the page; the agent card's "Switch to the suggested model?" row (OPT-0048) and its Keep-this-model pin
// do the same, and are tested in test/ui-agent-card-basics.test.js: 'Switch' posts the offered id to /model, 'Not now' posts to /model-offer/decline,
// the pin saves modelPinned through PATCH.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('the card reads the offer and answers it with the same routes the old page used', () => {
  const basics = read('lib/ui-agent-card-basics.js');
  assert.match(basics, /model-offer/);
  assert.match(basics, /model-offer\/decline/);
  assert.match(basics, /modelPinned/);
  assert.doesNotMatch(read('agent-settings.html'), /model-offer/, 'the redirect page has no suggestion box');
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

// removed (P4-2): 'review r1 (GPT-6): a suggestion answer that arrives after the pin was saved never shows the box again' ran the old page's loadModelOffer / hideOffer
// against a stand-in document; the card draws the row from one read per open, so there is no second answer to overtake. (No card test for the race: the card has none.)
