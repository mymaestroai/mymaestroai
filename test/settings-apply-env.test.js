'use strict';
// Phase 5c, part A1: the startup file (.env) in lib/settings-apply (target / current / check / apply / setEnv), its journal entries and
// Restore (lib/settings-journal store "env"), the lead's settings tool for these records, the cleaners of the new settings keys, the
// records' lead class, and the pins on the routes in server.js. Runs against a throwaway install copy; nothing real is touched.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeIsolatedInstall, REAL } = require('./helpers/isolated-install');

const inst = makeIsolatedInstall('saenv-', { copy: ['templates/settings-records.json'] });
const L = (m) => require(path.join(inst.lib, m));
const apply = L('settings-apply');
const journal = L('settings-journal');
const records = L('settings-records');
const envFile = L('env-file');
const sdk = L('sdk-chat');
const auth = L('auth').getAuth();
const S = sdk.__settingsTool;
const rec = (id) => { const r = records.byId(id); assert.ok(r, `record ${id} exists`); return r; };
const entries = () => journal.list({ limit: 500 });
const envEntries = () => entries().filter((e) => e.store === 'env');
const tmpEnv = (text) => { const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'saenv-file-')); const f = path.join(d, '.env'); if (text !== null) fs.writeFileSync(f, text, { mode: 0o600 }); return f; };
const txt = (f) => fs.readFileSync(f, 'utf8');

const admin = auth.createUser({ login: 'owner@example.com', name: 'Owner', role: 'admin', password: 'owner-long-password-1' }).user;
const sam = auth.createUser({ login: 'sam@example.com', name: 'Sam', role: 'member', password: 'sam-long-password-1' }).user;
fs.writeFileSync(path.join(inst.data, 'agents.json'), JSON.stringify([{ name: 'maestro', model: 'openai/gpt-5.6', display: 'Maestro', category: 'primary', lead: true }]));

const WRITABLE_IDS = { HUB_TZ: 'OPT-0991', HUB_WORKER_DEFAULT_SCOPE: 'OPT-0990', HUB_SECURITY_CHECK_HOURS: 'OPT-0994', HUB_UPDATE_CHECK_HOURS: 'OPT-0995', HUB_UPDATE_CHECK_FIRST_SECONDS: 'OPT-0996', HUB_COMMS_DISABLED: 'OPT-0998', HUB_MEMORY_HEALTH: 'OPT-0993', HUB_SELFCHECK: 'OPT-0992', HUB_CONSULT_BUSY_WAIT_MS: 'OPT-1005', HUB_DELIVERY_COOLDOWN_MS: 'OPT-1006', HUB_PUSH_SUBJECT: 'OPT-1007', HUB_CODEX_TRANSPORT: 'OPT-1002', MM_VOICE_NO_AUTO_INSTALL: 'OPT-1020', HUB_SDK_AUTO_COMPACT_WINDOW: 'OPT-1001' };
const READONLY_IDS = { PORT: 'OPT-0982', HUB_HOME: 'OPT-1008', CLAUDE_SDK_PATH: 'OPT-1015', CLAUDE_CLI_PATH: 'OPT-1016', CODEX_CLI_PATH: 'OPT-1017', LLM_GATEWAY_URL: 'OPT-1009', GATEWAY_PROMPT_CACHE: 'OPT-1010', GATEWAY_MAX_CONNECTIONS: 'OPT-1011', GATEWAY_KEEPALIVE: 'OPT-1012', GATEWAY_NETWATCH: 'OPT-1013', HUB_STABLE_BRANCH: 'OPT-0997' };
const DANGER_IDS = { HUB_BIND_HOST: 'OPT-0983', HUB_ALLOWED_HOSTS: 'OPT-0984', HUB_TAILNET_USERS: 'OPT-0985', HUB_AUTH_USERNAME: 'OPT-0986', HUB_AUTH_PASSWORD: 'OPT-0987', HUB_REQUIRE_LOGIN: 'OPT-0988', HUB_AGENT_PERMISSION_MODE: 'OPT-0989', HUB_KEEP_ENV_KEYS: 'OPT-0999', HUB_WALLET_OWNER: 'OPT-1000', HUB_CODEX_APPROVALS: 'OPT-1003', HUB_CODEX_SANDBOX: 'OPT-1004' };
const SETTINGS_DANGER_IDS = ['OPT-0964', 'OPT-0965', 'OPT-0966', 'OPT-0967', 'OPT-0968'];
const PROVIDER_ADDRESS_IDS = ['OPT-0933', 'OPT-0934', 'OPT-0935', 'OPT-0936', 'OPT-0937', 'OPT-0938'];

// ── records and target ───────────────────────────────────────────────────────────────────────────────
test('records: every writable startup value is a lead "confirm" record that targets its own line; read-only, protected and provider-address records are screen-only', () => {
  assert.deepEqual(Object.keys(WRITABLE_IDS).sort(), [...envFile.ENV_WRITABLE].sort());
  assert.deepEqual(Object.keys(READONLY_IDS).sort(), [...envFile.ENV_READONLY].sort());
  assert.deepEqual(Object.keys(DANGER_IDS).sort(), [...envFile.ENV_DANGER].sort());
  for (const [key, id] of Object.entries(WRITABLE_IDS)) {
    const r = rec(id);
    assert.equal(r.storedAs, `env:${key}`);
    assert.deepEqual(apply.target(r), { kind: 'env', key });
    assert.equal(r.lead, 'confirm', id);
    assert.equal(r.restart, true, `${id} takes effect after a restart`);
    assert.equal(r.home, 'Settings > Upkeep > More > Expert values', id);
  }
  for (const [key, id] of Object.entries(READONLY_IDS)) {
    const r = rec(id);
    assert.equal(r.storedAs, `env:${key}`);
    assert.deepEqual(apply.target(r), { kind: 'screen' }, `${id} ${key} is never written`);
    assert.equal(r.lead, 'screen', id);
    assert.equal(r.restart, true, id);
  }
  for (const [key, id] of Object.entries(DANGER_IDS)) {
    const r = rec(id);
    assert.equal(r.storedAs, `env:${key}`);
    assert.deepEqual(apply.target(r), { kind: 'screen' }, `${id} ${key}`);
    assert.equal(r.lead, 'screen', id);
    assert.equal(r.restart, true, id);
  }
  for (const id of SETTINGS_DANGER_IDS) assert.equal(rec(id).lead, 'screen', id);
  for (const id of PROVIDER_ADDRESS_IDS) { assert.equal(rec(id).lead, 'screen', id); assert.match(rec(id).storedAs, /^settings\.providers\.[a-z]+\.url$/); }
  // the other variables of the file that no record lists as one line are never a target
  assert.deepEqual(apply.target({ storedAs: 'env:LM_STUDIO_URL / OLLAMA_URL / OMLX_URL' }), { kind: 'screen' });
  assert.deepEqual(apply.target({ storedAs: 'env:ANTHROPIC_API_KEY' }), { kind: 'screen' });
  assert.deepEqual(apply.target({ storedAs: 'env:SEARXNG_URL' }), { kind: 'screen' });
});

test('records: the 16 protected options are exactly the 11 protected startup values and the 5 settings keys; the memory-limit record is kept', () => {
  assert.equal(Object.keys(DANGER_IDS).length + SETTINGS_DANGER_IDS.length, 16);
  const mem = rec('OPT-1095');
  assert.equal(mem.storedAs, 'settings.jobMemoryLimitGb');
  assert.equal(mem.home, 'Settings > Upkeep');
});

// ── check ────────────────────────────────────────────────────────────────────────────────────────────
test('check(): an admin only; the value is held to the key\'s rule; blank is the default again; the others are "screen"', () => {
  const tz = rec('OPT-0991');
  assert.deepEqual(apply.check({ record: tz, value: 'Europe/Paris', user: admin, isAdmin: true }), { ok: true, value: 'Europe/Paris', key: 'HUB_TZ' });
  assert.deepEqual(apply.check({ record: tz, value: '', user: admin, isAdmin: true }), { ok: true, value: '', key: 'HUB_TZ' });
  assert.deepEqual(apply.check({ record: tz, value: null, user: admin, isAdmin: true }), { ok: true, value: '', key: 'HUB_TZ' });
  assert.deepEqual(apply.check({ record: tz, value: 'Europe/Paris', user: sam, isAdmin: false }), { ok: false, error: 'admin' });
  assert.equal(apply.check({ record: tz, value: undefined, user: admin, isAdmin: true }).error, 'a value is needed');
  assert.match(apply.check({ record: tz, value: 'Mars/Olympus', user: admin, isAdmin: true }).error, /^HUB_TZ: /);
  assert.match(apply.check({ record: rec('OPT-1005'), value: '5', user: admin, isAdmin: true }).error, /^HUB_CONSULT_BUSY_WAIT_MS: must be a whole number from 1000 to 600000/);
  for (const id of [...Object.values(READONLY_IDS), ...Object.values(DANGER_IDS)]) {
    const r = apply.check({ record: rec(id), value: '1', user: admin, isAdmin: true, ownSession: true });
    assert.equal(r.ok, false, id);
    assert.ok(['screen', 'secret'].includes(r.error), `${id}: ${r.error}`);
  }
  // the protected settings keys: the bulk route drops them, so check() refuses them as protected (the lead tool never offers them)
  for (const id of ['OPT-0964', 'OPT-0965', 'OPT-0966', 'OPT-0967', 'OPT-0968']) assert.equal(apply.check({ record: rec(id), value: id === 'OPT-0964' ? false : {}, user: admin, isAdmin: true, ownSession: true }).ok, false, id);
});

// ── apply, journal and Restore ───────────────────────────────────────────────────────────────────────
test('apply(): writes the one line, journals it (store env, key, before, after) as the actor, says a restart is needed; no secret reaches the journal', async () => {
  const f = tmpEnv('# keep me\nANTHROPIC_API_KEY=sk-test-secret-value\nHUB_AUTH_PASSWORD=pw-not-real\nHUB_TZ=Europe/London\n\n');
  const n = envEntries().length;
  const r = await apply.apply({ record: rec('OPT-0991'), value: 'America/Chicago', user: admin, isAdmin: true, envFile: f, actor: { kind: 'person', user: admin.id } });
  assert.equal(r.ok, true);
  assert.equal(r.before, 'Europe/London'); assert.equal(r.after, 'America/Chicago'); assert.equal(r.restart, true);
  assert.equal(r.journalIds.length, 1);
  assert.equal(txt(f), '# keep me\nANTHROPIC_API_KEY=sk-test-secret-value\nHUB_AUTH_PASSWORD=pw-not-real\nHUB_TZ=America/Chicago\n\n');
  const list = envEntries();
  assert.equal(list.length, n + 1);
  const e = list[0];
  assert.equal(e.store, 'env'); assert.equal(e.key, 'HUB_TZ'); assert.equal(e.record, 'OPT-0991');
  assert.equal(e.before, 'Europe/London'); assert.equal(e.after, 'America/Chicago');
  assert.equal(e.who.kind, 'person'); assert.equal(e.restorable, true);
  const journalText = fs.readFileSync(journal.fileOf(), 'utf8');
  for (const secret of ['sk-test-secret-value', 'pw-not-real', 'ANTHROPIC_API_KEY', 'HUB_AUTH_PASSWORD']) assert.ok(!journalText.includes(secret), `${secret} must not be in the journal`);
  const v = journal.viewEntry(e);
  assert.equal(v.name, rec('OPT-0991').name);
  assert.equal(v.before, 'Europe/London'); assert.equal(v.after, 'America/Chicago');
});

test('apply(): a refused value, a member and the same value again write nothing and journal nothing', async () => {
  const f = tmpEnv('HUB_TZ=UTC\n');
  const n = entries().length;
  assert.equal((await apply.apply({ record: rec('OPT-0991'), value: 'Mars/Olympus', user: admin, isAdmin: true, envFile: f })).ok, false);
  assert.equal((await apply.apply({ record: rec('OPT-0991'), value: 'UTC', user: sam, isAdmin: false, envFile: f })).error, 'admin');
  assert.equal((await apply.apply({ record: rec('OPT-0982'), value: '9000', user: admin, isAdmin: true, envFile: f })).error, 'screen');
  const same = await apply.apply({ record: rec('OPT-0991'), value: 'UTC', user: admin, isAdmin: true, envFile: f });
  assert.equal(same.ok, true); assert.deepEqual(same.journalIds, []);
  assert.equal(txt(f), 'HUB_TZ=UTC\n');
  assert.equal(entries().length, n);
});

test('setEnv(): the journal is written first; when the file cannot be written the entry is marked failed and history never shows the change', () => {
  const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'saenv-ro-'));
  fs.mkdirSync(path.join(d, '.env'));   // reading it fails: nothing is journaled at all
  const n = entries().length;
  const r = apply.setEnv('HUB_TZ', 'UTC', { file: path.join(d, '.env') });
  assert.equal(r.ok, false);
  assert.equal(entries().length, n);
  // a folder that cannot take the temp file: journaled pending, the write fails, the entry is marked failed
  const f = tmpEnv('HUB_TZ=Europe/London\n');
  fs.chmodSync(path.dirname(f), 0o500);
  try {
    if (process.getuid && process.getuid() !== 0) {
      const w = apply.setEnv('HUB_TZ', 'UTC', { file: f });
      assert.equal(w.ok, false); assert.match(w.error, /Nothing was changed/);
      assert.equal(entries().length, n, 'a failed write leaves no visible history line');
      assert.equal(txt(f), 'HUB_TZ=Europe/London\n');
    }
  } finally { fs.chmodSync(path.dirname(f), 0o700); }
});

test('Restore puts the line back through the same validated write; a removal is restored too; a changed file is left alone', () => {
  const f = tmpEnv('A=1\nHUB_TZ=Europe/London\n');
  const set = apply.setEnv('HUB_TZ', 'Asia/Tokyo', { file: f });
  assert.equal(set.ok, true);
  const e = envEntries().find((x) => x.key === 'HUB_TZ' && x.after === 'Asia/Tokyo');
  assert.ok(e);
  const back = journal.restore(e.id, { isAdmin: true, isAdminSession: true, envFile: f });
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.equal(txt(f), 'A=1\nHUB_TZ=Europe/London\n');
  assert.ok(envEntries().some((x) => x.who.kind === 'restore' && x.key === 'HUB_TZ' && x.after === 'Europe/London'), 'the restore is journaled too');
  // a new line (no value before) is put back by removing it
  const add = apply.setEnv('HUB_SELFCHECK', 'off', { file: f });
  const e2 = envEntries().find((x) => x.key === 'HUB_SELFCHECK' && x.after === 'off');
  assert.equal(e2.before, undefined);
  assert.equal(journal.restore(e2.id, { isAdmin: true, isAdminSession: true, envFile: f }).ok, true);
  assert.equal(txt(f), 'A=1\nHUB_TZ=Europe/London\n');
  // a removal is put back as the old value
  apply.setEnv('HUB_TZ', '', { file: f });
  const e3 = envEntries().find((x) => x.key === 'HUB_TZ' && x.before === 'Europe/London' && x.after === undefined);
  assert.ok(e3);
  assert.equal(journal.restore(e3.id, { isAdmin: true, isAdminSession: true, envFile: f }).ok, true);
  assert.equal(txt(f), 'A=1\nHUB_TZ=Europe/London\n');
  // the file was edited by hand since: "It has changed since", nothing is written
  apply.setEnv('HUB_TZ', 'Asia/Tokyo', { file: f });
  const e4 = envEntries().find((x) => x.key === 'HUB_TZ' && x.after === 'Asia/Tokyo' && x.id !== e.id);
  fs.writeFileSync(f, 'A=1\nHUB_TZ=Europe/Rome\n');
  const stale = journal.restore(e4.id, { isAdmin: true, isAdminSession: true, envFile: f });
  assert.equal(stale.ok, false); assert.equal(stale.status, 409);
  assert.equal(txt(f), 'A=1\nHUB_TZ=Europe/Rome\n');
  assert.equal(add.ok, true);
});

test('Restore of an env entry whose old value no longer passes the rule is refused (the write is validated again); a member cannot restore it', () => {
  const f = tmpEnv('HUB_TZ=Nowhere/Land\n');   // typed by hand: not a zone
  apply.setEnv('HUB_TZ', 'UTC', { file: f });
  const e = envEntries().find((x) => x.key === 'HUB_TZ' && x.before === 'Nowhere/Land');
  assert.ok(e);
  const r = journal.restore(e.id, { isAdmin: true, isAdminSession: true, envFile: f });
  assert.equal(r.ok, false);
  assert.equal(txt(f), 'HUB_TZ=UTC\n');
  assert.equal(journal.restoreFor(e.id, { user: sam.id, isAdmin: false }).status, 403);
});

// ── the lead's settings tool ─────────────────────────────────────────────────────────────────────────
let turnN = 0;
function startTurn(agent) { const t = { turnId: `${agent}-env-t${++turnN}`, origin: { kind: 'user' }, personKey: admin.id, tainted: false, typed: '', voice: false, abortController: new AbortController() }; S.turnRegistry.set(agent, t); return t; }
function fakeRes() {
  const chunks = [];
  return { chunks, writableEnded: false, destroyed: false, on() {}, write(s) { chunks.push(String(s)); return true; },
    events() { const out = []; for (const c of chunks) for (const line of c.split('\n')) if (line.startsWith('data: ')) { try { out.push(JSON.parse(line.slice(6))); } catch { /* not json */ } } return out; } };
}
function findDeep(o, pred, depth = 0) { if (!o || typeof o !== 'object' || depth > 6) return null; if (pred(o)) return o; for (const v of Object.values(o)) { const r = findDeep(v, pred, depth + 1); if (r) return r; } return null; }
const cardsOf = (res) => res.events().map((e) => findDeep(e, (x) => x.type === 'ask_user_question')).filter(Boolean);
async function until(fn, ms = 5000) { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); } throw new Error('timed out'); }
const call = (res, args) => S.runChangeSetting('maestro', res, args, 0, null);
const answer = (card, text) => sdk.handleAskResponse({ request_id: card.request_id, answers: { 0: text }, agent: 'maestro' }, { isAdmin: true, personKey: admin.id });
const installEnv = path.join(inst.inst, '.env');

test('the lead changes an expert value only after the owner confirms on the fixed card; the line changes, one journal entry is made as the lead, and it says a restart is needed', async () => {
  fs.writeFileSync(installEnv, '# isolated install file\nPORT=8888\n', { mode: 0o600 });
  startTurn('maestro');
  const res = fakeRes();
  const p = call(res, { action: 'set', setting: 'OPT-0990', value: 'full', reason: 'trusted single-user install' });
  const card = await until(() => cardsOf(res)[0]);
  assert.equal(card.fixed, true);
  assert.equal(txt(installEnv), '# isolated install file\nPORT=8888\n', 'nothing is written before Confirm');
  assert.equal(answer(card, 'Confirm').success, true);
  const out = await p;
  assert.match(out, /^Changed /);
  assert.match(out, /takes effect after a restart/);
  assert.equal(txt(installEnv), '# isolated install file\nPORT=8888\nHUB_WORKER_DEFAULT_SCOPE=full\n');
  const e = envEntries().find((x) => x.key === 'HUB_WORKER_DEFAULT_SCOPE');
  assert.equal(e.who.kind, 'lead'); assert.equal(e.after, 'full');
});

test('the lead is refused, with no card and no write, for read-only values, protected values, provider addresses and protected settings keys; a bad value is refused plainly', async () => {
  const before = txt(installEnv);
  const n = entries().length;
  startTurn('maestro');
  for (const id of ['OPT-0982', 'OPT-1011', 'OPT-1009', 'OPT-0983', 'OPT-0987', 'OPT-1004', 'OPT-0933', 'OPT-0938', 'OPT-0964', 'OPT-0965', 'OPT-0966', 'OPT-0967', 'OPT-0968']) {
    const res = fakeRes();
    const out = await call(res, { action: 'set', setting: id, value: '1', reason: 'r' });
    assert.equal(cardsOf(res).length, 0, `${id}: no card`);
    assert.ok(out.includes(`(/#settings-for=${id})`), `${id}: ${out}`);
    assert.doesNotMatch(out, /^Turned|^Changed/);
  }
  const res = fakeRes();
  const bad = await call(res, { action: 'set', setting: 'OPT-0991', value: 'Mars/Olympus', reason: 'r' });
  assert.match(bad, /^Not changed: .*HUB_TZ/);
  assert.equal(cardsOf(res).length, 0);
  assert.equal(txt(installEnv), before);
  assert.equal(entries().length, n);
});

test('the lead reads a startup value as text and a protected secret as nothing (get)', async () => {
  startTurn('maestro');
  const g = JSON.parse(await call(fakeRes(), { action: 'get', setting: 'OPT-0990' }));
  assert.equal(g.current, 'full');
  assert.equal(g.class, 'needs your confirm');
  const ro = JSON.parse(await call(fakeRes(), { action: 'get', setting: 'OPT-0982' }));
  assert.equal(ro.class, 'only on its screen');
  assert.equal(ro.current, null, 'a value the lead may not change is not read out');
});

// ── the cleaners of the new settings keys ────────────────────────────────────────────────────────────
const stored = { updateCheck: { enabled: true, lastCheck: 'x' }, imageModels: { google: { fast: 'g-fast' } }, promptCache: { enabled: true }, ledger: { perAgentDailyUsd: 5, hubDailyUsd: 20 }, planFallback: { enabled: true } };
const clean = (patch) => apply.cleanSettingsPatch(patch, { getSetting: (k) => stored[k] });
const CASES = [
  // [label, good patch, bad patch, text the error carries]
  ['approvalTimeoutMinutes', { approvalTimeoutMinutes: 60 }, { approvalTimeoutMinutes: 0 }, /approvalTimeoutMinutes must be a whole number from 1 to 10080/],
  ['connectorsUnlockMinutes', { connectorsUnlockMinutes: 240 }, { connectorsUnlockMinutes: -1 }, /connectorsUnlockMinutes must be/],
  ['confirmTools', { confirmTools: false }, { confirmTools: 'yes' }, /confirmTools must be true or false/],
  ['providers.anthropic.url', { providers: { anthropic: { url: 'https://api.anthropic.com' } } }, { providers: { anthropic: { url: 'ftp://example.com' } } }, /providers\.anthropic\.url must be a web address/],
  ['providers.openai.url (sign-in details)', { providers: { openai: { url: 'https://api.openai.com/v1' } } }, { providers: { openai: { url: 'https://sam:pw@example.com/v1' } } }, /must not hold a user name or password/],
  ['updateCheck.hours', { updateCheck: { hours: 24 } }, { updateCheck: { hours: 0 } }, /updateCheck\.hours must be a whole number of hours from 1 to 8760/],
  ['planFallback.at', { planFallback: { at: 90 } }, { planFallback: { at: 150 } }, /planFallback\.at must be a number from 1 to 100/],
  ['planFallback.map', { planFallback: { map: { sonnet: 'claude-sdk/claude-haiku-5-5' } } }, { planFallback: { map: { sonnet: 'openai/gpt' } } }, /planFallback\.map\.sonnet must be a Claude model/],
  ['voice.sttModel', { voice: { sttModel: '' } }, { voice: { sttModel: 'huge.en' } }, /voice\.sttModel must be blank/],
  ['compactionMode', { compactionMode: 'dry' }, { compactionMode: 'maybe' }, /compactionMode must be one of: off, dry, on, assisted/],
  ['compactionAt', { compactionAt: 0.75 }, { compactionAt: 1.5 }, /compactionAt must be a number from 0\.3 to 0\.95/],
  ['filesMaxUploadMb', { filesMaxUploadMb: 512 }, { filesMaxUploadMb: 0 }, /filesMaxUploadMb must be a whole number from 1/],
  ['filesZipMaxMb', { filesZipMaxMb: 2048 }, { filesZipMaxMb: 5000 }, /filesZipMaxMb must be a whole number from 1 to 3900/],
  ['filesZipMaxFiles', { filesZipMaxFiles: 2000 }, { filesZipMaxFiles: 70000 }, /filesZipMaxFiles must be a whole number from 1 to 65535/],
  ['recordsMaxBytes', { recordsMaxBytes: 262144 }, { recordsMaxBytes: 10 }, /recordsMaxBytes must be a whole number from 4096/],
  ['sandboxMemory', { sandboxMemory: '4g' }, { sandboxMemory: 'lots' }, /sandboxMemory must be a size such as 4g or 512m/],
  ['sandboxCpus', { sandboxCpus: '2' }, { sandboxCpus: 'many' }, /sandboxCpus must be a number from 0\.1 to 256/],
  ['sandboxHomeMoveMinutes', { sandboxHomeMoveMinutes: 10 }, { sandboxHomeMoveMinutes: 0 }, /sandboxHomeMoveMinutes must be a whole number from 1 to 1440/],
  ['memberDefaultModel', { memberDefaultModel: 'claude-sdk/claude-sonnet-5-5' }, { memberDefaultModel: 'a b;c' }, /memberDefaultModel must be a model id/],
  ['memberModels', { memberModels: ['claude-sdk/claude-sonnet-5-5'] }, { memberModels: ['ok', 5] }, /memberModels must be a list of model ids/],
  ['hubBrief', { hubBrief: true }, { hubBrief: 'on' }, /hubBrief must be true or false/],
  ['imageProvider', { imageProvider: 'google' }, { imageProvider: 'bing' }, /imageProvider must be one of: google, openai/],
  ['imageModels', { imageModels: { openai: { fast: 'gpt-image-1', best: 'gpt-image-1' } } }, { imageModels: { bing: { fast: 'x' } } }, /imageModels\.bing is not a picture service/],
  ['promptCache', { promptCache: { enabled: true, ttl: '5m' } }, { promptCache: { ttl: '2h' } }, /promptCache\.ttl must be "5m" or "1h"/],
  ['jobMemoryLimitGb', { jobMemoryLimitGb: 0 }, { jobMemoryLimitGb: -2 }, /jobMemoryLimitGb must be a number from 0 to 4096/],
  ['ledger.monthlyUsd', { ledger: { monthlyUsd: 50, monthlyResetDay: 1 } }, { ledger: { monthlyUsd: 'abc' } }, /The monthly cap must be a dollar amount/],
  ['ledger.monthlyResetDay', { ledger: { monthlyResetDay: 28 } }, { ledger: { monthlyResetDay: 31 } }, /The month starts on a day from 1 to 28/],
  ['ledger.perAgentDailyUsd', { ledger: { perAgentDailyUsd: 3 } }, { ledger: { perAgentDailyUsd: 'lots' } }, /ledger\.perAgentDailyUsd must be a dollar amount/],
];
test('cleanSettingsPatch(): each new cleaner takes its default and refuses one bad value with a plain error', () => {
  for (const [label, good, bad, msg] of CASES) {
    const g = clean(JSON.parse(JSON.stringify(good)));
    assert.deepEqual(g.errors, [], `${label}: the default must pass (${g.errors[0]})`);
    const b = clean(JSON.parse(JSON.stringify(bad)));
    assert.equal(b.errors.length, 1, `${label}: the bad value must be refused`);
    assert.match(b.errors[0], msg, label);
    assert.equal(b.status, 400);
  }
});

test('cleanSettingsPatch(): blank / null means "use the default" (stored as null or empty) for numbers, words and addresses', () => {
  const p = clean({ filesMaxUploadMb: null, compactionMode: '', compactionAt: '', sandboxMemory: null, sandboxCpus: '', memberDefaultModel: null, imageProvider: null, jobMemoryLimitGb: null, providers: { openai: { url: '' } } });
  assert.deepEqual(p.errors, []);
  assert.equal(p.patch.filesMaxUploadMb, null); assert.equal(p.patch.compactionMode, null); assert.equal(p.patch.compactionAt, null);
  assert.equal(p.patch.sandboxMemory, null); assert.equal(p.patch.sandboxCpus, null); assert.equal(p.patch.memberDefaultModel, null);
  assert.equal(p.patch.imageProvider, null); assert.equal(p.patch.jobMemoryLimitGb, null); assert.equal(p.patch.providers.openai.url, '');
});

test('cleanSettingsPatch(): numbers sent as text are made numbers; nested objects are merged onto the stored value; the monthly cap goes through the ledger cleaner', () => {
  const p = clean({ approvalTimeoutMinutes: '45', compactionAt: '0.6', sandboxCpus: 1.5, sandboxMemory: '512M', updateCheck: { hours: '12' }, promptCache: { ttl: '1h' }, ledger: { monthlyUsd: '$25.5', monthlyResetDay: '15' }, imageModels: { google: { best: 'g-best' } }, memberModels: ['a/b', 'a/b', 'c/d'] });
  assert.deepEqual(p.errors, []);
  assert.equal(p.patch.approvalTimeoutMinutes, 45); assert.equal(p.patch.compactionAt, 0.6); assert.equal(p.patch.sandboxCpus, '1.5'); assert.equal(p.patch.sandboxMemory, '512m');
  assert.deepEqual(p.patch.updateCheck, { enabled: true, lastCheck: 'x', hours: 12 });
  assert.deepEqual(p.patch.promptCache, { enabled: true, ttl: '1h' });
  assert.deepEqual(p.patch.ledger, { perAgentDailyUsd: 5, hubDailyUsd: 20, monthlyUsd: 25.5, monthlyResetDay: 15 });
  assert.deepEqual(p.patch.imageModels, { google: { fast: 'g-fast', best: 'g-best' } });
  assert.deepEqual(p.patch.memberModels, ['a/b', 'c/d']);
  // a lead patch for one cap key carries the whole stored object: the cap is still cleaned, and 0 means no cap
  assert.equal(clean({ ledger: { ...stored.ledger, monthlyUsd: 0 } }).patch.ledger.monthlyUsd, null);
  assert.deepEqual(clean({ updateCheck: { hours: null } }).patch.updateCheck, { enabled: true, lastCheck: 'x' });
});

test('cleanSettingsPatch(): toolPolicy, teamTemplates, walletAgents, walletOwner and receiverAliases are dropped; the lead cannot change them either', () => {
  for (const key of ['toolPolicy', 'teamTemplates', 'walletAgents', 'walletOwner', 'receiverAliases']) {
    assert.ok(key in apply.DROPPED_KEYS, key);
    const p = { [key]: key === 'toolPolicy' ? false : {} , other: 1 };
    const out = clean(p);
    assert.deepEqual(out.dropped, [key]);
    assert.equal(key in out.patch, false);
    assert.equal(out.patch.other, 1);
  }
  const t = apply.check({ record: rec('OPT-0964'), value: false, user: admin, isAdmin: true, ownSession: true });
  assert.equal(t.ok, false);
  // and Restore never puts them back
  assert.equal(journal.neverRestorable('settings', 'toolPolicy'), true);
  assert.equal(journal.neverRestorable('settings', 'teamTemplates'), true);
});

test('the lead\'s check() of a cap key goes through the ledger cleaner (survey finding 5): a bad day or amount is refused, a good one passes', () => {
  const ok = apply.check({ record: rec('OPT-1086'), value: 15, user: admin, isAdmin: true });
  assert.equal(ok.ok, true); assert.equal(ok.value, 15);
  assert.match(apply.check({ record: rec('OPT-1086'), value: 40, user: admin, isAdmin: true }).error, /The month starts on a day from 1 to 28/);
  assert.match(apply.check({ record: rec('OPT-1085'), value: 'abc', user: admin, isAdmin: true }).error, /The monthly cap must be a dollar amount/);
  assert.equal(apply.check({ record: rec('OPT-1085'), value: 50, user: admin, isAdmin: true }).value, 50);
});

test('the provider address records go through the same cleaner when an admin screen sends them (check): a bad address is refused', () => {
  // (check() holds the value to the rules; "screen only" is the record's lead class, which the settings tool applies: see the lead test above)
  assert.equal(apply.check({ record: rec('OPT-0933'), value: 'https://gateway.example.com/v1', user: admin, isAdmin: true }).ok, true);
  assert.match(apply.check({ record: rec('OPT-0933'), value: 'gateway', user: admin, isAdmin: true }).error, /^providers\.anthropic\.url must be a web address/);
  assert.equal(apply.check({ record: rec('OPT-0934'), value: '', user: admin, isAdmin: true }).value, '', 'blank is the provider\'s own address');
  const p = clean({ providers: { anthropic: { url: 'https://gateway.example.com' } } });
  assert.deepEqual(p.errors, []);
  assert.match(clean({ providers: { anthropic: { url: 'gateway' } } }).errors[0], /must be a web address/);
});

// ── the routes in server.js ──────────────────────────────────────────────────────────────────────────
test('GET and POST /api/settings/env: admin only (the route and the member / token classes); the body goes through setEnv; the shape is { ok, key, value, restartNeeded }', () => {
  const server = fs.readFileSync(path.join(REAL, 'server.js'), 'utf8');
  const at = server.indexOf("pathname === '/api/settings/env'");
  assert.ok(at > 0, 'the route exists');
  const block = server.slice(at, server.indexOf("pathname === '/api/settings/test-provider'"));
  assert.match(block, /access\.isAdmin\(req\.hubUser\)/);
  assert.match(block, /req\.hubPendingTotp/);
  assert.match(block, /jsonResponse\(res, 403, \{ error: 'admin_only' \}\)/);
  assert.ok(block.indexOf("error: 'admin_only'") < block.indexOf('readBody(req)'), 'the admin check comes before the body is read');
  assert.match(block, /require\('\.\/lib\/env-file'\)\.read\(\)/);
  assert.match(block, /require\('\.\/lib\/settings-apply'\)\.setEnv\(b\.key,/);
  assert.match(block, /jsonResponse\(res, 400, \{ error: w\.error \}\)/);
  assert.match(block, /\{ ok: true, key: w\.key, value: w\.after, restartNeeded: true \}/);
  const access = require(path.join(REAL, 'lib', 'access'));
  assert.deepEqual(access.classifyRoute('/api/settings/env', 'GET'), { kind: 'admin' });
  assert.deepEqual(access.classifyRoute('/api/settings/env', 'POST'), { kind: 'admin' });
  // the hub notes what it started with right after it reads .env
  assert.match(server, /loadEnvFile\(path\.join\(__dirname, '\.env'\)\); \} catch \{\}\ntry \{ require\('\.\/lib\/env-file'\); \} catch \{\}/);
});
