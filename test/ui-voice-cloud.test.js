'use strict';
// Voice phase 3, pages: the ElevenLabs key field in Settings -> providers.
// (P4-2: this file also ran the old agent-settings.html Voice row - cloud engines, the privacy warning, the sample - against a tiny fake DOM. The page is a redirect now;
// the card's Voice rows (OPT-0022..0027) are tested in test/ui-agent-card-basics.test.js: "Voice: an ElevenLabs voice needs its ID; a cloud engine for an agent kept on
// this computer asks first and says who may confirm", "going back to this computer for speech sends tts and removes the stored cloud voice with null", "only the changed key is sent".
// Not on the card, so not ported: the sample button's X-Voice-Engine / X-Voice-Fallback headers.)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('app.js');

test('Settings -> providers: ElevenLabs key field, no Test button, counted in the Keys summary', () => {
  assert.ok(app.includes("{ id: 'elevenlabs', label: 'ElevenLabs (voice)', hasKey: true, hasUrl: false, hasTest: false }"));
  assert.ok(app.includes("${p.hasTest === false ? '' : `<button class=\"st-test-btn\" onclick=\"testProvider('${p.id}')\">Test</button>`}"));
  assert.ok(app.includes('PROVIDERS.filter(p => p.hasKey && pv[p.id] && pv[p.id].hasKey).length'));
  const pv = app.slice(app.indexOf('const PROVIDERS = ['), app.indexOf('];', app.indexOf('const PROVIDERS = [')));
  assert.strictEqual((pv.match(/hasKey: true/g) || []).length, 6);
  assert.strictEqual((pv.match(/hasUrl: true/g) || []).length, 3);
});

test('no U+FE0F or zero-width characters in the card\'s voice code or the redirect page', () => {
  for (const f of ['lib/ui-agent-card-basics.js', 'agent-settings.html']) assert.ok(!/[\uFE0F\u200B-\u200D\u2060\uFEFF]/.test(read(f)), f);
});
