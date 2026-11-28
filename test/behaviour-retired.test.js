'use strict';
// A behaviour change that was removed ("Protect your Maestro's own code", id protect-own-code): an install that decided it
// keeps the old entry in its state file. It is ignored without errors: not listed, no card asking about it, migrate and
// the review prompt run, and the other decisions stay as they were.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bc = require('../lib/behaviour-changes');

const at = '2026-11-20T10:00:00.000Z';
const oldState = (stateFile) => fs.writeFileSync(stateFile, JSON.stringify({ entries: {
  'protect-own-code': { state: 'on', by: 'owner@example.com', at },
  'own-code-guidance': { state: 'on', by: 'new-install', at },
  'team-guidance': { state: 'off', by: 'owner@example.com', at },
} }, null, 2));

test('the removed protect-own-code is gone from the manifest and from the code', () => {
  assert.ok(!bc.manifest().some((e) => e.id === 'protect-own-code'));
  assert.ok(bc.manifest().some((e) => e.id === 'own-code-guidance'), 'the lead guidance stays');
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'lib', 'code-protect.js')));
  const tp = require('../lib/tool-policy');
  assert.strictEqual(tp.setCodeProtectProvider, undefined);
});

test('an old state file that still holds protect-own-code: listed without it, no card, migrate and decide unaffected', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-retired-'));
  const stateFile = path.join(d, 'behaviour-reviews.json');
  oldState(stateFile);
  const agentsFile = path.join(d, 'agents.json');
  fs.writeFileSync(agentsFile, JSON.stringify({ agents: [{ name: 'maestro', category: 'primary', lead: true }] }));

  const listed = bc.list({ stateFile });
  const ids = (Array.isArray(listed) ? listed : listed.changes || listed.entries || []).map((e) => e.id);
  assert.ok(ids.length > 0);
  assert.ok(!ids.includes('protect-own-code'), 'not listed');
  const pending = (Array.isArray(listed) ? listed : listed.changes || listed.entries || []).filter((e) => e.state === 'pending').map((e) => e.id);
  assert.ok(!pending.includes('protect-own-code'), 'no card asking about it');

  assert.doesNotThrow(() => bc.migrate({ agentsFile, stateFile }));
  assert.strictEqual(bc.stateOf('team-guidance', { stateFile }), 'off', 'other decisions kept');
  assert.strictEqual(bc.stateOf('own-code-guidance', { stateFile }), 'on');
  await assert.rejects(() => bc.decide('protect-own-code', 'on', { user: 'owner@example.com', stateFile }), /no such change/);
  // the review prompt (the "Recent changes" review the lead runs) builds without it
  const review = require('../lib/behaviour-review');
  if (typeof review.reviewPrompt === 'function') {
    let text = '';
    assert.doesNotThrow(() => { text = String(review.reviewPrompt({ stateFile }) || ''); });
    assert.ok(!/protect-own-code|Protect your Maestro's own code/.test(text));
  }
});

test('the record of changes put aside before an update stays an agent-proof file', () => {
  const tp = require('../lib/tool-policy');
  const f = path.join(tp.HUB_ROOT, 'data', 'put-aside.json');
  const d = tp.decide({ agent: { name: 'maestro', category: 'primary', lead: true }, tool: 'Write', input: { file_path: f, content: '{}' }, cwd: tp.HUB_ROOT });
  assert.strictEqual(d.decision, 'deny');
  assert.strictEqual(d.cls, 'settings_file');
});
