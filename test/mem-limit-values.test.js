'use strict';
// lib/mem-limit.js values: what counts as a setting, the default reader that never reads files, the maximum.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ml = require('../lib/mem-limit');
const GB = ml.GB;

const lim = (v, total = 64 * GB) => ml.limitBytes({ getSetting: () => v, total });

test('numbers and numeric strings set the limit; 0 or "0" = no limit', () => {
  assert.strictEqual(lim(8), 8 * GB);
  assert.strictEqual(lim(' 8 '), 8 * GB);
  assert.strictEqual(lim('1.5'), 1.5 * GB);
  assert.strictEqual(lim(0), null);
  assert.strictEqual(lim('0'), null);
});

test('anything else is automatic, never "no limit"', () => {
  const auto = ml.autoBytes(64 * GB);
  for (const v of ['', '   ', false, true, [], [8], {}, NaN, Infinity, -1, '-2', 'abc', null, undefined]) assert.strictEqual(lim(v), auto, String(v));
});

test('the maximum is the computer\'s total memory', () => {
  assert.strictEqual(lim(500, 32 * GB), 32 * GB);
  assert.strictEqual(lim(8, 32 * GB), 8 * GB);
});

test('the default reader reads nothing (automatic); setSettingsReader installs the real one', () => {
  const t = 100 * GB;
  assert.strictEqual(ml.limitBytes({ total: t }), 25 * GB);
  ml.setSettingsReader((k, d) => (k === 'jobMemoryLimitGb' ? 3 : d));
  assert.strictEqual(ml.limitBytes({ total: t }), 3 * GB);
  ml.setSettingsReader(null);
  assert.strictEqual(ml.limitBytes({ total: t }), 25 * GB);
});

test('mem-limit never requires lib/settings itself; server.js installs the reader once', () => {
  assert.ok(!/require\(['"]\.\/settings['"]\)/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'mem-limit.js'), 'utf8')));
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /require\('\.\/lib\/mem-limit'\)\.setSettingsReader\(hubSettings\.getSetting\)/);
});
