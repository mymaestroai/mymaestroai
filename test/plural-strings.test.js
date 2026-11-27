'use strict';
// Real words by count in the texts a person reads (no "agent(s)"): the checklist, the security check, notices. Offline.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createReadiness } = require('../lib/readiness.js');
const { plural, word } = require('../lib/plural.js');
const TW = require('../lib/temporal-workers.js');

const root = path.join(__dirname, '..');
const byId = (r, id) => r.items.find((i) => i.id === id);

test('readiness: admin accounts say 1 / 2 by count, in the warning and in the all-clear', async () => {
  const mk = (admins) => createReadiness({ platform: 'linux', hasUsers: () => true, listUsers: () => admins, getSetting: (k) => (k === 'requireAdmin2fa' ? true : undefined) }).check();
  const off = (n) => ({ login: 'a' + n, role: 'admin', totpEnabled: false });
  const on = (n) => ({ login: 'b' + n, role: 'admin', totpEnabled: true });
  assert.strictEqual(byId(await mk([off(1)]), 'totp').title, '1 admin account without two-factor');
  assert.strictEqual(byId(await mk([off(1), off(2), on(3)]), 'totp').title, '2 admin accounts without two-factor');
  assert.match(byId(await mk([on(1)]), 'accounts').detail, /^1 admin account, all with two-factor\./);
  assert.match(byId(await mk([on(1), on(2), on(3)]), 'accounts').detail, /^3 admin accounts, all with two-factor\./);
});

test('temporary workers: the chat line says 1 worker / 3 workers', () => {
  const r = (ok) => ({ label: 'x', model: 'm', toolScope: 'read', ok, secs: 1, text: 't' });
  assert.match(TW.formatResults([r(true)]), /^1 temporary worker finished: 1 succeeded, 0 failed\./);
  assert.match(TW.formatResults([r(true), r(true), r(false)]), /^3 temporary workers finished: 2 succeeded, 1 failed\./);
});

test('plural(): nouns and the verbs that go with them', () => {
  assert.strictEqual(`${plural(1, 'agent')} ${word(1, 'uses', 'use')}`, '1 agent uses');
  assert.strictEqual(`${plural(3, 'agent')} ${word(3, 'uses', 'use')}`, '3 agents use');
  assert.strictEqual(`${plural(1, 'file')} / ${plural(3, 'file')}`, '1 file / 3 files');
});

test('no "name(s)" is left in the texts of the checklist, the security check and the notices a person reads', () => {
  for (const f of ['lib/readiness.js', 'lib/security-check.js', 'lib/behaviour-review.js', 'lib/git-sync.js', 'lib/hub-home.js', 'lib/temporal-workers.js', 'lib/system-health/wire.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    const hits = (src.match(/[A-Za-z]\((s|es)\)(?!\s*[=;{.,\]:?)])/g) || []).filter((h) => !/shQuote/.test(h));
    const lines = src.split('\n').filter((l) => /[A-Za-z]\((s|es)\)/.test(l) && !/shQuote|\bs\s*=>|\(s\)\s*=>|function\s/.test(l) && /`|'|"/.test(l));
    assert.deepStrictEqual(lines.filter((l) => /\w+\((s|es)\)\s*[\w`'" ]/.test(l) && !/^\s*(\/\/|\*)/.test(l) && /(agent|account|file|device|worker|container|commit|service|token|rule|note|warning|connector|subscription|admin|member)\(s\)/.test(l)), [], f + ': ' + hits.join(', '));
  }
});
