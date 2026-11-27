'use strict';
// lib/env-file: which startup-file (.env) values Settings may show and change, the rule for each, and the one-line, byte-preserving write.
// Every test writes only to its own temp folder; the install's real startup file is never read or written.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ef = require('../lib/env-file');

function tmp() { return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'env-file-')); }
function envAt(text, mode) { const d = tmp(); const f = path.join(d, '.env'); if (text !== null) fs.writeFileSync(f, text, { mode: mode || 0o600 }); return f; }
const txt = (f) => fs.readFileSync(f, 'utf8');
const rowOf = (f, key) => ef.read({ file: f }).rows.find((r) => r.key === key);

// ── the three sets ────────────────────────────────────────────────────────────────────────────────────
test('the sets: 14 writable, 11 read-only, 11 protected; disjoint; no writable key looks like a secret', () => {
  assert.equal(ef.ENV_WRITABLE.length, 14);
  assert.equal(ef.ENV_READONLY.length, 11);
  assert.equal(ef.ENV_DANGER.length, 11);
  const all = [...ef.ENV_WRITABLE, ...ef.ENV_READONLY, ...ef.ENV_DANGER];
  assert.equal(new Set(all).size, all.length);
  const { isSecretName } = require('../lib/hub-secrets');
  assert.deepEqual(ef.ENV_WRITABLE.filter((k) => isSecretName(k)), []);
  for (const k of ['HUB_TZ', 'HUB_WORKER_DEFAULT_SCOPE', 'HUB_SDK_AUTO_COMPACT_WINDOW', 'MM_VOICE_NO_AUTO_INSTALL']) assert.ok(ef.ENV_WRITABLE.includes(k), k);
  for (const k of ['PORT', 'HUB_HOME', 'GATEWAY_NETWATCH', 'HUB_STABLE_BRANCH']) assert.ok(ef.ENV_READONLY.includes(k), k);
  for (const k of ['HUB_BIND_HOST', 'HUB_AUTH_PASSWORD', 'HUB_CODEX_SANDBOX', 'HUB_WALLET_OWNER']) assert.ok(ef.ENV_DANGER.includes(k), k);
});

// ── validate: one good and one bad value per key ──────────────────────────────────────────────────────
const GOOD = {
  HUB_TZ: ['America/New_York', 'UTC', 'Europe/London'],
  HUB_WORKER_DEFAULT_SCOPE: ['read', 'full', 'none'],
  HUB_SECURITY_CHECK_HOURS: ['24', '1', '8760', 12],
  HUB_UPDATE_CHECK_HOURS: ['24', '1', '8760'],
  HUB_UPDATE_CHECK_FIRST_SECONDS: ['90', '1', '86400'],
  HUB_COMMS_DISABLED: ['1'],
  HUB_MEMORY_HEALTH: ['off'],
  HUB_SELFCHECK: ['off'],
  HUB_CONSULT_BUSY_WAIT_MS: ['20000', '1000', '600000'],
  HUB_DELIVERY_COOLDOWN_MS: ['60000', '1000', '3600000'],
  HUB_PUSH_SUBJECT: ['mailto:agent-hub@example.com', 'https://example.com/contact'],
  HUB_CODEX_TRANSPORT: ['exec', 'app-server'],
  MM_VOICE_NO_AUTO_INSTALL: ['1'],
  HUB_SDK_AUTO_COMPACT_WINDOW: ['200000', '10000', '2000000'],
};
const BAD = {
  HUB_TZ: ['Mars/Olympus', 'new york', '../etc', 'UTC; rm', 'a'.repeat(80)],
  HUB_WORKER_DEFAULT_SCOPE: ['write', 'FULL', 'read-only'],
  HUB_SECURITY_CHECK_HOURS: ['0', '-1', '24.5', 'abc', '8761', '1e3'],
  HUB_UPDATE_CHECK_HOURS: ['0', '-5', '1.5', 'daily', '9000'],
  HUB_UPDATE_CHECK_FIRST_SECONDS: ['0', '86401', 'soon', '-3'],
  HUB_COMMS_DISABLED: ['0', 'yes', 'true', 'off'],
  HUB_MEMORY_HEALTH: ['on', '1', 'false'],
  HUB_SELFCHECK: ['on', '0', 'no'],
  HUB_CONSULT_BUSY_WAIT_MS: ['999', '600001', 'x', '2.5'],
  HUB_DELIVERY_COOLDOWN_MS: ['10', '3600001', 'y'],
  HUB_PUSH_SUBJECT: ['agent-hub@example.com', 'http://example.com', 'mailto:nobody', 'https://', 'javascript:alert(1)'],
  HUB_CODEX_TRANSPORT: ['http', 'Exec', 'appserver'],
  MM_VOICE_NO_AUTO_INSTALL: ['0', 'yes', 'true'],
  HUB_SDK_AUTO_COMPACT_WINDOW: ['9999', '2000001', 'big', '-1'],
};

test('validate(): every writable key has a rule; it takes its good values and refuses its bad ones with a plain error', () => {
  assert.deepEqual(Object.keys(GOOD).sort(), [...ef.ENV_WRITABLE].sort());
  assert.deepEqual(Object.keys(BAD).sort(), [...ef.ENV_WRITABLE].sort());
  for (const key of ef.ENV_WRITABLE) {
    for (const g of GOOD[key]) { const r = ef.validate(key, g); assert.equal(r.ok, true, `${key}=${g}: ${JSON.stringify(r)}`); assert.equal(r.value, String(g)); }
    for (const b of BAD[key]) {
      const r = ef.validate(key, b);
      assert.equal(r.ok, false, `${key}=${b} must be refused`);
      assert.ok(r.error.startsWith(`${key}: `), r.error);
    }
    for (const blank of ['', '  ', null, undefined]) assert.deepEqual(ef.validate(key, blank), { ok: true, value: '' }, `${key} blank removes the line`);
  }
});

test('validate(): spaces, quotes, $, # and line breaks never get into the file; a key outside the allow-list is refused', () => {
  for (const v of ['a b', 'a"b', "a'b", 'a$b', 'a#b', 'a\nHUB_HOME=/x', 'a\\b', 'a`b']) assert.equal(ef.validate('HUB_PUSH_SUBJECT', v).ok, false, JSON.stringify(v));
  for (const key of [...ef.ENV_READONLY, ...ef.ENV_DANGER, 'ANTHROPIC_API_KEY', 'NOT_A_KEY', '', undefined, 7]) {
    const r = ef.validate(key, '1');
    assert.equal(r.ok, false, String(key));
    assert.match(r.error, /is not a setting that can be changed here/);
  }
  assert.equal(ef.validate('HUB_TZ', { zone: 'UTC' }).ok, false);
  assert.equal(ef.validate('HUB_TZ', NaN).ok, false);
});

// ── write: one line changes, every other byte stays ───────────────────────────────────────────────────
const SAMPLE = [
  '# the startup file',
  '',
  'PORT=8888',
  'export HUB_HOME="/srv/maestro home"   # quoted, with a trailing comment',
  "GATEWAY_KEEPALIVE='0'",
  '   indented junk line',
  '',
  'HUB_TZ=Europe/London',
  'ANTHROPIC_API_KEY=sk-test-not-a-real-key',
  '# last comment',
  '',
].join('\n');

test('write(): replaces only the key\'s line; comments, blank lines, quotes, export prefixes and the secret line stay byte for byte', () => {
  const f = envAt(SAMPLE);
  const r = ef.write('HUB_TZ', 'America/New_York', { file: f });
  assert.deepEqual(r, { ok: true, key: 'HUB_TZ', before: 'Europe/London', after: 'America/New_York', changed: true });
  assert.equal(txt(f), SAMPLE.replace('HUB_TZ=Europe/London', 'HUB_TZ=America/New_York'));
});

test('write(): a new key is appended after the last line; a file with no final line break gets one first', () => {
  const f = envAt(SAMPLE);
  ef.write('HUB_WORKER_DEFAULT_SCOPE', 'full', { file: f });
  assert.equal(txt(f), SAMPLE + 'HUB_WORKER_DEFAULT_SCOPE=full\n');
  const g = envAt('PORT=8888\n# end');
  ef.write('HUB_SELFCHECK', 'off', { file: g });
  assert.equal(txt(g), 'PORT=8888\n# end\nHUB_SELFCHECK=off\n');
  const none = envAt(null);
  assert.equal(ef.write('HUB_COMMS_DISABLED', '1', { file: none }).ok, true);
  assert.equal(txt(none), 'HUB_COMMS_DISABLED=1\n');
  assert.equal(fs.statSync(none).mode & 0o777, 0o600, 'a new file is private');
});

test("write(): '' removes the key's line (the default again) and nothing else", () => {
  const f = envAt(SAMPLE);
  const r = ef.write('HUB_TZ', '', { file: f });
  assert.equal(r.ok, true); assert.equal(r.after, null); assert.equal(r.before, 'Europe/London');
  assert.equal(txt(f), SAMPLE.replace('HUB_TZ=Europe/London\n', ''));
  // removing a key that is not there changes nothing and says so
  const again = ef.write('HUB_TZ', '', { file: f });
  assert.deepEqual(again, { ok: true, key: 'HUB_TZ', before: null, after: null, changed: false });
  // an empty line "KEY=" is removed too, and every duplicate of the key goes (the first would take effect otherwise)
  const h = envAt('HUB_TZ=\nA=1\nHUB_TZ=UTC\nHUB_TZ=Asia/Tokyo\n');
  ef.write('HUB_TZ', '', { file: h });
  assert.equal(txt(h), 'A=1\n');
});

test('write(): CRLF files keep CRLF on the changed, the added and every other line', () => {
  const crlf = 'PORT=8888\r\n# note\r\nHUB_TZ=UTC\r\n\r\nHUB_HOME=/srv\r\n';
  const f = envAt(crlf);
  ef.write('HUB_TZ', 'Europe/Paris', { file: f });
  assert.equal(txt(f), crlf.replace('HUB_TZ=UTC', 'HUB_TZ=Europe/Paris'));
  ef.write('HUB_MEMORY_HEALTH', 'off', { file: f });
  assert.equal(txt(f), crlf.replace('HUB_TZ=UTC', 'HUB_TZ=Europe/Paris') + 'HUB_MEMORY_HEALTH=off\r\n');
  ef.write('HUB_TZ', '', { file: f });
  assert.equal(txt(f), 'PORT=8888\r\n# note\r\n\r\nHUB_HOME=/srv\r\nHUB_MEMORY_HEALTH=off\r\n');
});

test('write(): an "export " prefix on the key\'s own line is kept; a line with the same prefix text in a comment is not touched', () => {
  const f = envAt('# HUB_TZ=Asia/Tokyo\nexport HUB_TZ=UTC\n');
  ef.write('HUB_TZ', 'Europe/Rome', { file: f });
  assert.equal(txt(f), '# HUB_TZ=Asia/Tokyo\nexport HUB_TZ=Europe/Rome\n');
});

test('write(): the file mode is kept (0640 stays 0640), no temp file is left behind, a symlinked file stays a symlink', () => {
  const f = envAt('HUB_TZ=UTC\n', 0o640);
  fs.chmodSync(f, 0o640);
  ef.write('HUB_TZ', 'Europe/Rome', { file: f });
  assert.equal(fs.statSync(f).mode & 0o777, 0o640);
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['.env']);
  const d = tmp();
  const real = path.join(d, 'real.env'); fs.writeFileSync(real, 'HUB_TZ=UTC\n');
  const link = path.join(d, '.env'); fs.symlinkSync(real, link);
  ef.write('HUB_TZ', 'Europe/Rome', { file: link });
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(txt(real), 'HUB_TZ=Europe/Rome\n');
});

test('write(): not allow-listed and secret keys are refused and the file is untouched; so is an invalid value', () => {
  const f = envAt(SAMPLE);
  const refused = [
    ['PORT', '9000'], ['HUB_HOME', '/x'], ['HUB_BIND_HOST', '0.0.0.0'], ['HUB_REQUIRE_LOGIN', '1'], ['HUB_AUTH_PASSWORD', 'pw'],
    ['ANTHROPIC_API_KEY', 'sk-x'], ['OPENAI_API_KEY', 'sk-y'], ['HUB_WALLET_OWNER', '0xabc'], ['SOMETHING_TOKEN', 't'], ['NOT_LISTED', '1'],
  ];
  for (const [k, v] of refused) { const r = ef.write(k, v, { file: f }); assert.equal(r.ok, false, k); assert.equal(typeof r.error, 'string'); }
  assert.match(ef.write('ANTHROPIC_API_KEY', 'x', { file: f }).error, /secret/);
  assert.equal(ef.write('HUB_TZ', 'Mars/Olympus', { file: f }).ok, false);
  assert.equal(ef.write('HUB_WORKER_DEFAULT_SCOPE', 'root', { file: f }).ok, false);
  assert.equal(txt(f), SAMPLE, 'nothing changed');
});

test('write(): the same value again changes nothing (changed: false) and does not rewrite the file', () => {
  const f = envAt(SAMPLE);
  const before = fs.statSync(f).ino;
  const r = ef.write('HUB_TZ', 'Europe/London', { file: f });
  assert.equal(r.ok, true); assert.equal(r.changed, false);
  assert.equal(fs.statSync(f).ino, before);
});

test('write(): an unreadable file is an error, not an empty file that would be overwritten', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, '.env'));   // a folder where the file should be: reading it fails with EISDIR
  const r = ef.write('HUB_TZ', 'UTC', { file: path.join(d, '.env') });
  assert.equal(r.ok, false);
  assert.match(r.error, /could not be read/);
});

// ── read: rows, secrets, pending ──────────────────────────────────────────────────────────────────────
test('read(): 36 rows, each with its group; a protected secret has no value, only set / not set', () => {
  const f = envAt(SAMPLE + 'HUB_AUTH_PASSWORD=hunter2-not-real\nHUB_AUTH_USERNAME=sam\nHUB_REQUIRE_LOGIN=1\n');
  const { rows } = ef.read({ file: f });
  assert.equal(rows.length, 36);
  assert.equal(rows.filter((r) => r.writable).length, 14);
  assert.equal(rows.filter((r) => r.readonly).length, 11);
  assert.equal(rows.filter((r) => r.danger).length, 11);
  const pw = rows.find((r) => r.key === 'HUB_AUTH_PASSWORD');
  assert.equal(pw.value, null); assert.equal(pw.set, true); assert.equal(pw.secret, true);
  assert.ok(!JSON.stringify(rows).includes('hunter2'), 'the secret never appears in the rows');
  assert.ok(!JSON.stringify(rows).includes('sk-test-not-a-real-key'), 'an unlisted key line never appears');
  assert.equal(rows.find((r) => r.key === 'HUB_AUTH_USERNAME').value, 'sam');
  assert.equal(rows.find((r) => r.key === 'PORT').value, '8888');
  assert.equal(rows.find((r) => r.key === 'HUB_TZ').value, 'Europe/London');
  assert.equal(rows.find((r) => r.key === 'HUB_SELFCHECK').set, false);
  const none = ef.read({ file: path.join(tmp(), 'missing.env') });
  assert.equal(none.rows.length, 36); assert.ok(none.rows.every((r) => r.value === null || r.secret === false));
});

test('read(): running is what the hub started with (captured once); pending is a saved value that differs from it', () => {
  const f = envAt('HUB_TZ=America/Chicago\nHUB_SELFCHECK=off\n');
  const code = `const ef = require(process.argv[1]); const file = process.argv[2];
    const first = ef.read({ file }).rows;
    process.env.HUB_TZ = 'Asia/Tokyo';             // changed after the start: running does not follow it
    const again = ef.read({ file }).rows;
    const pick = (rows, k) => { const r = rows.find((x) => x.key === k); return { value: r.value, running: r.running, pending: r.pending }; };
    console.log(JSON.stringify({ tz: pick(first, 'HUB_TZ'), tz2: pick(again, 'HUB_TZ'), self: pick(first, 'HUB_SELFCHECK'), mem: pick(first, 'HUB_MEMORY_HEALTH') }));`;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', code, path.join(__dirname, '..', 'lib', 'env-file.js'), f], { env: { PATH: process.env.PATH, HUB_TZ: 'UTC', HUB_MEMORY_HEALTH: 'off' }, encoding: 'utf8' }));
  assert.deepEqual(out.tz, { value: 'America/Chicago', running: 'UTC', pending: true });
  assert.deepEqual(out.tz2, out.tz, 'running was captured once');
  assert.deepEqual(out.self, { value: 'off', running: null, pending: true });
  assert.deepEqual(out.mem, { value: null, running: 'off', pending: true }, 'a line removed from the file also waits for a restart');
});
