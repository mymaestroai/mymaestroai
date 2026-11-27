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

test('write(): in a CRLF file the changed and the added line are plain LF (the loader reads no \\r line); every other line keeps its bytes (Q6)', () => {
  const crlf = 'PORT=8888\r\n# note\r\nHUB_TZ=UTC\r\n\r\nHUB_HOME=/srv\r\n';
  const f = envAt(crlf);
  ef.write('HUB_TZ', 'Europe/Paris', { file: f });
  const one = 'PORT=8888\r\n# note\r\nHUB_TZ=Europe/Paris\n\r\nHUB_HOME=/srv\r\n';
  assert.equal(txt(f), one);
  ef.write('HUB_MEMORY_HEALTH', 'off', { file: f });
  assert.equal(txt(f), one + 'HUB_MEMORY_HEALTH=off\n');
  ef.write('HUB_TZ', '', { file: f });
  assert.equal(txt(f), 'PORT=8888\r\n# note\r\n\r\nHUB_HOME=/srv\r\nHUB_MEMORY_HEALTH=off\n');
  // what the real loader reads from the written file
  const g = envAt(crlf); ef.write('HUB_TZ', 'Europe/Paris', { file: g }); ef.write('HUB_MEMORY_HEALTH', 'off', { file: g });
  const env = {}; require('../lib/hub-secrets').loadEnvFile(g, { env });
  assert.equal(env.HUB_TZ, 'Europe/Paris'); assert.equal(env.HUB_MEMORY_HEALTH, 'off');
});

test('read(): a line ending in \\r is not a value, as the real loader sees it; the row says note: crlf (Q6)', () => {
  const f = envAt('HUB_TZ=UTC\r\nHUB_SELFCHECK=off\r\nHUB_SELFCHECK=off\nHUB_MEMORY_HEALTH=off\r\nexport HUB_COMMS_DISABLED=1\r\n');
  const saved = { ...process.env }; const env = {};
  try {
    require('../lib/hub-secrets').loadEnvFile(f, { env });
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
  assert.equal(env.HUB_TZ, undefined); assert.equal(env.HUB_MEMORY_HEALTH, undefined); assert.equal(env.HUB_SELFCHECK, 'off');
  const tz = rowOf(f, 'HUB_TZ');
  assert.equal(tz.value, null); assert.equal(tz.set, false); assert.equal(tz.note, 'crlf');
  assert.equal(rowOf(f, 'HUB_MEMORY_HEALTH').note, 'crlf');
  const sc = rowOf(f, 'HUB_SELFCHECK');
  assert.equal(sc.value, 'off'); assert.equal(sc.note, undefined, 'one LF line of the key is read');
  assert.equal(rowOf(f, 'HUB_COMMS_DISABLED').note, 'export');
});

test('write(): reset removes every line of the key, an export-only or CRLF-only key too, and says changed (Q9)', () => {
  const f = envAt('A=1\nexport HUB_TZ=UTC\nB=2\n');
  const r = ef.write('HUB_TZ', '', { file: f });
  assert.equal(r.ok, true); assert.equal(r.changed, true);
  assert.equal(txt(f), 'A=1\nB=2\n');
  const g = envAt('A=1\r\nHUB_TZ=UTC\r\nexport HUB_TZ=Asia/Tokyo\r\nB=2\r\n');
  assert.equal(ef.write('HUB_TZ', '', { file: g }).changed, true);
  assert.equal(txt(g), 'A=1\r\nB=2\r\n');
  assert.equal(ef.write('HUB_TZ', '', { file: g }).changed, false, 'nothing left: no change');
  assert.equal(txt(g), 'A=1\r\nB=2\r\n');
});

test('write(): an "export KEY=" line is not read by the hub, so writing the key replaces it with a plain line (R11); a comment is not touched', () => {
  const f = envAt('# HUB_TZ=Asia/Tokyo\nexport HUB_TZ=UTC\nexport HUB_HOME=/srv\n');
  ef.write('HUB_TZ', 'Europe/Rome', { file: f });
  assert.equal(txt(f), '# HUB_TZ=Asia/Tokyo\nHUB_TZ=Europe/Rome\nexport HUB_HOME=/srv\n');
  // when a plain line of the key exists too, that one (the one the hub reads) is replaced and the export line stays
  const g = envAt('export HUB_TZ=UTC\nHUB_TZ=Asia/Tokyo\n');
  ef.write('HUB_TZ', 'Europe/Rome', { file: g });
  assert.equal(txt(g), 'export HUB_TZ=UTC\nHUB_TZ=Europe/Rome\n');
});

test('read(): an "export KEY=" line is not a value (the loader ignores it); the row says note: export (R11)', () => {
  const f = envAt('export HUB_TZ=UTC\nexport HUB_SELFCHECK=off\nHUB_SELFCHECK=off\n');
  const tz = rowOf(f, 'HUB_TZ');
  assert.equal(tz.value, null); assert.equal(tz.set, false); assert.equal(tz.note, 'export');
  const sc = rowOf(f, 'HUB_SELFCHECK');
  assert.equal(sc.value, 'off'); assert.equal(sc.note, undefined, 'a plain line of the key exists: that is what is read');
  assert.equal(rowOf(f, 'HUB_COMMS_DISABLED').note, undefined);
  // the loader and this reader agree
  const env = {}; const fsx = require('node:fs');
  require('../lib/hub-secrets').loadEnvFile(f, { env });
  assert.equal(env.HUB_TZ, undefined); assert.equal(env.HUB_SELFCHECK, 'off');
  assert.equal(fsx.existsSync(f), true);
});

test('write(): a trailing " # comment" of a replaced line moves to its own line above, so the hub reads only the value (R14), also after a quoted value and in CRLF files', () => {
  const f = envAt('HUB_TZ=UTC   # the zone\nHUB_SELFCHECK="off" # quoted\nHUB_MEMORY_HEALTH=off\n');
  ef.write('HUB_TZ', 'Europe/Rome', { file: f });
  ef.write('HUB_SELFCHECK', 'off', { file: f });
  ef.write('HUB_MEMORY_HEALTH', 'off', { file: f });
  assert.equal(txt(f), '# the zone\nHUB_TZ=Europe/Rome\n# quoted\nHUB_SELFCHECK=off\nHUB_MEMORY_HEALTH=off\n');
  const c = envAt('HUB_TZ=UTC # note\r\nA=1\r\n');
  ef.write('HUB_TZ', 'Asia/Tokyo', { file: c });
  assert.equal(txt(c), '# note\nHUB_TZ=Asia/Tokyo\nA=1\r\n');
  const q = envAt('HUB_PUSH_SUBJECT="mailto:a@example.com # x" # keep\n');
  ef.write('HUB_PUSH_SUBJECT', 'https://example.com/c', { file: q });
  assert.equal(txt(q), '# keep\nHUB_PUSH_SUBJECT=https://example.com/c\n');
  // the hub's own loader then reads exactly the new value
  const seen = {};
  const hs = require('../lib/hub-secrets');
  const before = process.env.HUB_PUSH_SUBJECT;
  delete process.env.HUB_PUSH_SUBJECT;
  try { hs.loadEnvFile(q); seen.v = process.env.HUB_PUSH_SUBJECT; } finally { if (before === undefined) delete process.env.HUB_PUSH_SUBJECT; else process.env.HUB_PUSH_SUBJECT = before; }
  assert.equal(seen.v, 'https://example.com/c');
});

// ── R6: the whole buffer is written, fsync must succeed, the rename comes last, nothing is left behind ──
function failsLeaveFileAlone(label, io, errRe) {
  const f = envAt(SAMPLE);
  const dir = path.dirname(f);
  const r = ef.write('HUB_WORKER_DEFAULT_SCOPE', 'full', { file: f, io });
  assert.equal(r.ok, false, label);
  assert.match(r.error, errRe, label);
  assert.equal(txt(f), SAMPLE, `${label}: the original is byte for byte the same`);
  assert.deepEqual(fs.readdirSync(dir), ['.env'], `${label}: no temp file is left`);
}
test('write(): a short write is finished in a loop (every byte lands); a write that takes nothing, ENOSPC and a failed fsync leave the file as it was and no temp file (R6)', () => {
  // a disk that takes 3 bytes at a time: the file still comes out whole
  const f = envAt(SAMPLE);
  let calls = 0;
  const slow = { writeSync: (fd, buf, off, len) => { calls++; return fs.writeSync(fd, buf, off, Math.min(3, len)); } };
  assert.equal(ef.write('HUB_WORKER_DEFAULT_SCOPE', 'full', { file: f, io: slow }).ok, true);
  assert.equal(txt(f), SAMPLE + 'HUB_WORKER_DEFAULT_SCOPE=full\n');
  assert.ok(calls > 10, 'written in pieces');
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['.env']);
  // a write that stops half way (takes some bytes, then nothing)
  let n = 0;
  failsLeaveFileAlone('short write', { writeSync: (fd, buf, off, len) => (n++ === 0 ? fs.writeSync(fd, buf, off, 5) : 0) }, /EIO/);
  failsLeaveFileAlone('ENOSPC', { writeSync: () => { const e = new Error('no space'); e.code = 'ENOSPC'; throw e; } }, /ENOSPC/);
  failsLeaveFileAlone('ENOSPC after some bytes', { writeSync: (fd, buf, off, len) => { if (off > 0) { const e = new Error('no space'); e.code = 'ENOSPC'; throw e; } return fs.writeSync(fd, buf, off, 4); } }, /ENOSPC/);
  failsLeaveFileAlone('fsync fails', { fsyncSync: () => { const e = new Error('io'); e.code = 'EIO'; throw e; } }, /EIO/);
  failsLeaveFileAlone('rename fails', { renameSync: () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } }, /EBUSY/);
  // the rename is never tried before the bytes and the fsync are done
  const order = [];
  const f2 = envAt(SAMPLE);
  ef.write('HUB_WORKER_DEFAULT_SCOPE', 'full', { file: f2, io: { writeSync: (...a) => { order.push('w'); return fs.writeSync(...a); }, fsyncSync: (fd) => { order.push('s'); fs.fsyncSync(fd); }, renameSync: (a, b) => { order.push('r'); fs.renameSync(a, b); } } });
  assert.equal(order[order.length - 1], 'r'); assert.equal(order[order.length - 2], 's');
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

test('read(): running is what the hub started with (captured once); pending is the file now differing from the file at start, not from the running value (R7)', () => {
  // HUB_TZ and HUB_MEMORY_HEALTH are set outside the file (as systemd or docker would); the file never said anything about them
  const f = envAt('HUB_TZ=America/Chicago\nHUB_SELFCHECK=off\nHUB_CONSULT_BUSY_WAIT_MS=30000\nHUB_CODEX_TRANSPORT=exec\n');
  const code = `const ef = require(process.argv[1]); const file = process.argv[2];
    const first = ef.read({ file }).rows;                  // the file as the hub started with it
    process.env.HUB_TZ = 'Asia/Tokyo';                     // changed after the start: running does not follow it
    ef.write('HUB_SELFCHECK', '', { file }); ef.write('HUB_CONSULT_BUSY_WAIT_MS', '45000', { file }); ef.write('HUB_COMMS_DISABLED', '1', { file });
    const again = ef.read({ file }).rows;
    const pick = (rows, k) => { const r = rows.find((x) => x.key === k); return { value: r.value, running: r.running, pending: r.pending, outside: r.outside }; };
    console.log(JSON.stringify({ tz: pick(first, 'HUB_TZ'), tz2: pick(again, 'HUB_TZ'), mem: pick(first, 'HUB_MEMORY_HEALTH'), mem2: pick(again, 'HUB_MEMORY_HEALTH'),
      port: pick(first, 'PORT'), self: pick(again, 'HUB_SELFCHECK'), wait: pick(again, 'HUB_CONSULT_BUSY_WAIT_MS'), comms: pick(again, 'HUB_COMMS_DISABLED'), transport: pick(again, 'HUB_CODEX_TRANSPORT'),
      pendingAny: again.filter((r) => r.pending).map((r) => r.key).sort(), readonlyPending: again.filter((r) => (r.readonly || r.danger) && r.pending).length }));`;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', code, path.join(__dirname, '..', 'lib', 'env-file.js'), f], { env: { PATH: process.env.PATH, HUB_TZ: 'UTC', HUB_MEMORY_HEALTH: 'off', PORT: '4321', HUB_SELFCHECK: 'off', HUB_CONSULT_BUSY_WAIT_MS: '30000' }, encoding: 'utf8' }));
  // the file says America/Chicago and the process has UTC (the file was edited by hand before this start, or the process was started with it): no change is waiting
  assert.deepEqual(out.tz, { value: 'America/Chicago', running: 'UTC', pending: false, outside: null });
  assert.deepEqual(out.tz2, out.tz, 'running was captured once; the file did not change');
  // a value the file has no line for is set outside it: shown as outside, never pending
  assert.deepEqual(out.mem, { value: null, running: 'off', pending: false, outside: 'off' });
  assert.deepEqual(out.mem2, out.mem);
  assert.deepEqual(out.port, { value: null, running: '4321', pending: false, outside: '4321' });
  // changes made here after the start wait for a restart: a line removed, a line changed, a line added
  assert.deepEqual(out.self, { value: null, running: 'off', pending: true, outside: null }, 'a line removed from the file waits for a restart (it is not "outside": the file had it at start)');
  assert.deepEqual(out.wait, { value: '45000', running: '30000', pending: true, outside: null });
  assert.deepEqual(out.comms, { value: '1', running: null, pending: true, outside: null });
  assert.deepEqual(out.transport, { value: 'exec', running: null, pending: false, outside: null });
  assert.deepEqual(out.pendingAny, ['HUB_COMMS_DISABLED', 'HUB_CONSULT_BUSY_WAIT_MS', 'HUB_SELFCHECK']);
  assert.equal(out.readonlyPending, 0);
});

test('read(): a read-only or protected row is never pending, even when its line changed in the file by hand; a secret has outside null and no value (R7)', () => {
  const f = envAt('PORT=8888\nHUB_BIND_HOST=127.0.0.1\nHUB_AUTH_PASSWORD=pw-not-real\n');
  ef.read({ file: f });   // the start
  fs.writeFileSync(f, 'PORT=9999\nHUB_BIND_HOST=0.0.0.0\nHUB_AUTH_PASSWORD=other-not-real\n');
  const rows = ef.read({ file: f }).rows;
  for (const k of ['PORT', 'HUB_BIND_HOST', 'HUB_AUTH_PASSWORD']) assert.equal(rows.find((r) => r.key === k).pending, false, k);
  const pw = rows.find((r) => r.key === 'HUB_AUTH_PASSWORD');
  assert.equal(pw.outside, null); assert.equal(pw.value, null); assert.equal(pw.running, null);
  assert.ok(!JSON.stringify(rows).includes('not-real'));
});
