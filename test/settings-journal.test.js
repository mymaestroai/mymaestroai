'use strict';
// The settings journal (lib/settings-journal): one journal for every settings change, hooked at the store layer
// (lib/settings.js, lib/agents.js, lib/auth.js preferences), with outside-edit detection, Restore and the routes' rules.
// Runs against a throwaway install copy (test/helpers/isolated-install.js); nothing of the real install is touched.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeIsolatedInstall } = require('./helpers/isolated-install');

const inst = makeIsolatedInstall('sj-', { copy: ['templates/settings-records.json'] });
const L = (m) => require(path.join(inst.lib, m));
const journal = L('settings-journal');
const settings = L('settings');
const agents = L('agents');
const access = L('access');
const SETTINGS_FILE = path.join(inst.data, 'settings.json');
const AGENTS_FILE = path.join(inst.data, 'agents.json');
const JOURNAL_FILE = path.join(inst.data, 'settings-journal.jsonl');
const auth = L('auth').createAuth({ dataDir: inst.data, log: () => {} });

// The entries a block of work adds, oldest first.
async function addedAsync(fn) {
  const seen = new Set(journal.list({ limit: 500 }).map((e) => e.id));
  await fn();
  return journal.list({ limit: 500 }).filter((e) => !seen.has(e.id)).reverse();
}
const byKey = (list, key) => list.find((e) => e.key === key);
const fakeTimers = () => {
  const q = [];
  return { q, timers: { setTimeout: (fn, ms) => { const t = { fn, ms, unref() {} }; q.push(t); return t; }, clearTimeout() {} } };
};

test('a settings change writes one entry per changed key, with before and after and the record id', () => {
  const es = journal.list({ limit: 5 });   // (the file does not exist yet: nothing)
  assert.deepEqual(es, []);
  settings.updateSettings({ voice: { enabled: true }, maxContextMessages: 30 });
  const list = journal.list({ limit: 50 }).reverse();
  const v = byKey(list, 'voice.enabled'), m = byKey(list, 'maxContextMessages');
  assert.ok(v && m, JSON.stringify(list));
  assert.equal(list.length, 2, 'one entry per changed key, nothing else');
  assert.equal(v.before, undefined); assert.equal(v.after, true);
  assert.equal(v.record, 'OPT-0227');
  assert.equal(v.store, 'settings'); assert.equal(v.who.kind, 'hub');
  assert.match(v.id, /^sj-[0-9a-f]{10}$/); assert.equal(typeof v.at, 'number'); assert.equal(v.restorable, false, 'voice.enabled goes through the Voice screen (R3-4)'); assert.equal(m.restorable, true);
  assert.equal(m.record, 'OPT-0381');
  settings.updateSettings({ maxContextMessages: 40 });
  const e2 = journal.list({ limit: 1 })[0];
  assert.equal(e2.key, 'maxContextMessages'); assert.equal(e2.before, 30); assert.equal(e2.after, 40);
  if (process.platform !== 'win32') assert.equal(fs.statSync(JOURNAL_FILE).mode & 0o777, 0o600);
});

test('a provider key is written as set / replaced, and no value is anywhere in the journal file', () => {
  settings.updateSettings({ providers: { openai: { apiKey: 'sk-TEST-FIRST-0001', url: 'https://api.example.test/v1' } } });
  settings.updateSettings({ providers: { openai: { apiKey: 'sk-TEST-SECOND-0002' } } });
  settings.updateSettings({ webSearch: { keys: { brave: 'brave-TEST-KEY-0003' } } });
  const list = journal.list({ limit: 50 }).reverse();
  const keys = list.filter((e) => e.key === 'providers.openai.apiKey');
  assert.equal(keys.length, 2);
  assert.equal(keys[0].after, 'set'); assert.equal(keys[0].before, undefined);
  assert.equal(keys[1].before, 'set'); assert.equal(keys[1].after, 'replaced');
  assert.ok(keys.every((e) => e.restorable === false));
  assert.equal(byKey(list, 'providers.openai.url').after, 'https://api.example.test/v1');   // not a secret
  const wk = byKey(list, 'webSearch.keys.brave');
  assert.equal(wk.after, 'set'); assert.equal(wk.restorable, false);
  const text = fs.readFileSync(JOURNAL_FILE, 'utf8');
  for (const s of ['sk-TEST-FIRST-0001', 'sk-TEST-SECOND-0002', 'brave-TEST-KEY-0003']) assert.ok(!text.includes(s), `${s} must not be in the journal`);
});

test('the secret rule: names, record storedAs, size limit', () => {
  const J = journal;
  for (const k of ['providers.x.apiKey', 'webSearch.keys.tavily', 'backup.key.envelope', 'agents.hazel.apiToken', 'prefs.u_1.sessionSecret', 'walletPassphrase', 'seedPhrase', 'privateKey', 'x.password']) assert.ok(J.isSecretKey(k), k);
  for (const k of ['maxCompletionTokens', 'agents.hazel.maxOutputTokens', 'webFetch.allowPrivate', 'voice.enabled', 'agents.keymaster']) assert.ok(!J.isSecretKey(k, null, k.startsWith('agents.') ? 'agents' : 'settings'), k);
  const e = J.recordChange('settings', [{ key: 'hubBrief', before: undefined, after: 'x'.repeat(5000) }]);
  assert.equal(e[0].restorable, false);
  assert.match(e[0].after, /not kept in the journal/);
  assert.ok(Buffer.byteLength(JSON.stringify(e[0])) < 600);
  // a secret field inside a whole value is dropped
  const e2 = J.recordChange('settings', [{ key: 'toolPolicy', before: undefined, after: { mode: 'a', apiKey: 'sk-NESTED-9' } }]);
  assert.deepEqual(e2[0].after, { mode: 'a' });
});

test('diff: per key down to depth 3, deeper objects and arrays as whole values', () => {
  const d = journal.diff({ a: { b: { c: { d: 1 } } }, l: [1, 2], p: { q: 1 } }, { a: { b: { c: { d: 2 } } }, l: [1, 3], p: { q: 1, r: 2 } }, '', 3);
  assert.deepEqual(d.map((x) => x.key), ['a.b.c', 'l', 'p.r']);
  assert.deepEqual(d[0], { key: 'a.b.c', before: { d: 1 }, after: { d: 2 } });
});

test('settings.json is written atomically: a temp file in the same folder, then a rename (never a direct write)', () => {
  const realWrite = fs.writeFileSync, realRename = fs.renameSync;
  const writes = [], renames = [];
  fs.writeFileSync = function (p, ...r) { writes.push(String(p)); return realWrite.call(this, p, ...r); };
  fs.renameSync = function (a, b) { renames.push([String(a), String(b)]); return realRename.call(this, a, b); };
  try { settings.updateSettings({ maxContextMessages: 41 }); } finally { fs.writeFileSync = realWrite; fs.renameSync = realRename; }
  assert.ok(!writes.includes(SETTINGS_FILE), 'settings.json itself is never written in place');
  const r = renames.find(([, to]) => to === SETTINGS_FILE);
  assert.ok(r, 'renamed over settings.json');
  assert.equal(path.dirname(r[0]), path.dirname(SETTINGS_FILE), 'temp file in the same folder');
  assert.notEqual(r[0], SETTINGS_FILE);
  assert.ok(writes.includes(r[0]));
  assert.equal(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')).maxContextMessages, 41);
  if (process.platform !== 'win32') assert.equal(fs.statSync(SETTINGS_FILE).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(inst.data).filter((n) => n.endsWith('.tmp')), [], 'no temp file left behind');
});

test('the hub\'s own write is not reported as an outside edit', () => {
  const { q, timers } = fakeTimers();
  journal.configure({ timers, notify: () => { throw new Error('no notice expected'); } });
  settings.updateSettings({ maxContextMessages: 42 });
  settings.get(); settings.get();
  assert.equal(journal.list({ limit: 50 }).filter((e) => e.who.kind === 'outside').length, 0);
  assert.equal(q.length, 0);
});

test('agents: updateAgentField and saveAgentsToDisk journal per field; an added or removed agent is one entry', async () => {
  const member = auth.createUser({ login: 'sam@example.com', name: 'Sam', role: 'member', password: 'sam-long-password-1' }).user;
  const other = auth.createUser({ login: 'ravi@example.com', name: 'Ravi', role: 'member', password: 'ravi-long-password-1' }).user;
  global.__t = { member, other };
  const added1 = await addedAsync(async () => {
    const list = agents.loadAgentsFromDisk();
    list.push({ name: 'hazel', model: 'claude-sdk/default', owner: member.id, apiToken: 'tok-AGENT-SECRET-1', voice: { stt: 'a' } });
    list.push({ name: 'rowan', model: 'claude-sdk/default', owner: other.id });
    agents.saveAgentsToDisk(list);
  });
  const hz = byKey(added1, 'agents.hazel');
  assert.ok(hz && hz.before === undefined && hz.after.name === 'hazel', JSON.stringify(added1));
  assert.ok(!('apiToken' in hz.after), 'secret fields of a whole record are dropped');
  assert.ok(added1.some((e) => e.key === 'agents.rowan'));
  assert.ok(!fs.readFileSync(JOURNAL_FILE, 'utf8').includes('tok-AGENT-SECRET-1'));

  const viaField = await addedAsync(async () => {
    const r = await agents.updateAgentField('hazel', { blurb: 'Keeps the notes', category: 'primary' });
    assert.equal(r.success, true);
  });
  assert.deepEqual(viaField.map((e) => e.key).sort(), ['agents.hazel.blurb', 'agents.hazel.category']);
  assert.equal(byKey(viaField, 'agents.hazel.blurb').after, 'Keeps the notes');
  assert.equal(byKey(viaField, 'agents.hazel.blurb').record, 'OPT-0005');

  const viaSave = await addedAsync(async () => {
    const list = agents.loadAgentsFromDisk();
    list.find((a) => a.name === 'hazel').model = 'claude-sdk/other';
    list.find((a) => a.name === 'hazel').voice.stt = 'b';
    agents.saveAgentsToDisk(list);
  });
  assert.deepEqual(viaSave.map((e) => e.key).sort(), ['agents.hazel.model', 'agents.hazel.voice.stt']);
  assert.equal(byKey(viaSave, 'agents.hazel.model').before, 'claude-sdk/default');
  assert.ok(fs.existsSync(AGENTS_FILE + '.bak'), 'the .bak is kept');

  const removed = await addedAsync(async () => {
    const list = agents.loadAgentsFromDisk();
    agents.saveAgentsToDisk(list.filter((a) => a.name !== 'rowan'));
  });
  assert.equal(removed.length, 1);
  assert.equal(removed[0].key, 'agents.rowan'); assert.equal(removed[0].after, undefined); assert.equal(removed[0].before.name, 'rowan');
  assert.equal(removed[0].restorable, false);
  // put rowan back for the route tests
  const list = agents.loadAgentsFromDisk(); list.push({ name: 'rowan', model: 'claude-sdk/default', owner: other.id }); agents.saveAgentsToDisk(list);
});

test('agents.json is written atomically by updateAgentField too (temp + rename)', async () => {
  const realWrite = fs.writeFileSync, realRename = fs.renameSync;
  const writes = [], renames = [];
  fs.writeFileSync = function (p, ...r) { writes.push(String(p)); return realWrite.call(this, p, ...r); };
  fs.renameSync = function (a, b) { renames.push([String(a), String(b)]); return realRename.call(this, a, b); };
  try { await agents.updateAgentField('hazel', { blurb: 'Keeps the notes well' }); } finally { fs.writeFileSync = realWrite; fs.renameSync = realRename; }
  assert.ok(!writes.includes(AGENTS_FILE));
  assert.ok(renames.some(([, to]) => to === AGENTS_FILE));
});

test('a preference change journals under store "prefs"; password and session data never appear', () => {
  const { member } = global.__t;
  const es = journal.list({ limit: 1 });
  const before = es.length;
  const r = auth.setPrefs(member.id, { uiMode: 'simple', theme: 'dark', planBadge: 'family' });
  assert.equal(r.ok, true);
  const list = journal.list({ limit: 10 }).reverse().filter((e) => e.store === 'prefs');
  assert.deepEqual(list.map((e) => e.key).sort(), [`prefs.${member.id}.planBadge`, `prefs.${member.id}.theme`, `prefs.${member.id}.uiMode`]);
  assert.equal(byKey(list, `prefs.${member.id}.theme`).after, 'dark');
  assert.equal(byKey(list, `prefs.${member.id}.uiMode`).record, 'OPT-0085');
  const noop = auth.setPrefs(member.id, { theme: 'dark' });
  assert.equal(noop.ok, true);
  assert.equal(journal.list({ limit: 10 }).filter((e) => e.store === 'prefs').length, 3, 'an unchanged value adds nothing');
  auth.setPrefs(member.id, { theme: 'light' });
  const text = fs.readFileSync(JOURNAL_FILE, 'utf8');
  for (const s of ['sam-long-password-1', 'passwordHash', 'totp', 'recovery', 'session']) assert.ok(!text.includes(s), s);
  void before;
});

test('an outside edit is journaled as outside on the next get(), and several edits make one batched notice', () => {
  const { q, timers } = fakeTimers();
  let now = 2_000_000_000_000;
  const notices = [];
  journal.configure({ clock: () => now, timers, notify: (p) => notices.push(p) });
  settings.get();
  const edit = (patch, pad) => {
    const cur = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    Object.assign(cur, patch); cur.__pad = 'x'.repeat(pad);
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(cur, null, 2));   // someone else writing the file directly
  };
  edit({ maxContextMessages: 50 }, 1);
  const s1 = settings.get();
  assert.equal(s1.maxContextMessages, 50, 'the hub reloaded the file');
  edit({ providers: { openai: { apiKey: 'sk-OUTSIDE-SECRET-77', url: 'https://api.example.test/v1' } } }, 2);
  settings.get();
  edit({ voice: { enabled: false } }, 3);
  settings.get();
  const outside = journal.list({ limit: 50 }).filter((e) => e.who.kind === 'outside').reverse();
  assert.ok(outside.length >= 3);
  assert.ok(outside.every((e) => e.why === 'file changed outside the hub'));
  const key = byKey(outside, 'providers.openai.apiKey');
  assert.equal(key.after, 'replaced'); assert.equal(key.restorable, false);
  assert.equal(byKey(outside, 'maxContextMessages').after, 50);
  assert.ok(!fs.readFileSync(JOURNAL_FILE, 'utf8').includes('sk-OUTSIDE-SECRET-77'));
  assert.equal(notices.length, 0, 'nothing is sent until the 60 s batch ends');
  assert.equal(q.length, 1, 'one timer for the whole batch');
  assert.equal(q[0].ms, 60_000);
  now += 60_000; q[0].fn();
  assert.equal(notices.length, 1, 'one notice for several edits');
  const body = notices[0].body;
  assert.match(body, /data\/settings\.json/);
  assert.match(body, /maxContextMessages/); assert.match(body, /voice\.enabled/);
  assert.match(body, /providers\.openai\.apiKey \(an API key or other secret was replaced\)/);
  assert.match(body, /a program on this computer, not your Maestro's screens or Maestro/);
  assert.match(body, /restore/i);
  assert.ok(!body.includes('sk-OUTSIDE-SECRET-77'));
  // another edit 1 minute later: its batch ends, but a second notice for the file waits until 10 minutes after the first
  now += 60_000;
  edit({ maxContextMessages: 51 }, 4); settings.get();
  assert.equal(q.length, 2);
  now += 60_000; q[1].fn();
  assert.equal(notices.length, 1, 'at most one notice per file per 10 minutes');
  assert.equal(q.length, 3, 'rolled into the next one');
  now += 11 * 60_000; q[2].fn();
  assert.equal(notices.length, 2);
  assert.match(notices[1].body, /maxContextMessages/);
  // a file that is not valid JSON: the hub keeps its copy and the notice says so
  fs.writeFileSync(SETTINGS_FILE, '{ not json');
  assert.equal(settings.get().maxContextMessages, 51);
  const t = q[q.length - 1];
  now += 60_000 + 10 * 60_000; t.fn();
  assert.equal(notices.length, 3);
  assert.match(notices[2].body, /not valid JSON/);
  // put the file right again (an outside write) so the next tests start from a good file
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings.get(), null, 2) + '\n');
  settings.get();
  journal.configure({ clock: Date.now, timers: { setTimeout, clearTimeout }, notify: null });
});

test('the command line\'s own write leaves a marker, so the running hub does not journal it again as outside', () => {
  const cur = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  cur.maxContextMessages = 60;
  const tmp = path.join(inst.data, '.cli.tmp');
  fs.writeFileSync(tmp, JSON.stringify(cur, null, 2));
  const st = fs.statSync(tmp);
  fs.renameSync(tmp, SETTINGS_FILE);
  // what another process (scripts/hub-cli.js, actor kind "cli") does after its write: journal its entry and mark the new stamp
  journal.withActor({ kind: 'cli' }, () => {
    journal.recordChange('settings', [{ key: 'maxContextMessages', before: 51, after: 60 }]);
    journal.afterWrite('settings', `${st.mtimeMs}:${st.size}:${st.ino}`);
  });
  const { q, timers } = fakeTimers();
  journal.configure({ timers });
  const n = journal.list({ limit: 500 }).length;
  assert.equal(settings.get().maxContextMessages, 60);
  assert.equal(journal.list({ limit: 500 }).length, n, 'no second entry for the same change');
  assert.equal(q.length, 0);
  assert.equal(journal.list({ limit: 1 })[0].who.kind, 'cli');
  journal.configure({ timers: { setTimeout, clearTimeout } });
});

test('restore puts the old value back and journals it as restore; refused when the value changed since', () => {
  settings.updateSettings({ maxContextMessages: 25 });
  settings.updateSettings({ maxContextMessages: 26 });
  const e = journal.list({ limit: 1 })[0];
  assert.equal(e.before, 25); assert.equal(e.after, 26);
  const r = journal.restore(e.id, { user: 'u_owner', isAdmin: true, isAdminSession: false });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(settings.getSetting('maxContextMessages'), 25);
  assert.equal(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')).maxContextMessages, 25);
  const back = journal.list({ limit: 1 })[0];
  assert.equal(back.who.kind, 'restore'); assert.equal(back.who.user, 'u_owner');
  assert.equal(back.why, `restored ${e.id}`); assert.equal(back.after, 25);
  // the value is no longer the entry's "after": a second restore is a 409 with the current value
  const again = journal.restore(e.id, { isAdmin: true });
  assert.equal(again.ok, false); assert.equal(again.status, 409); assert.equal(again.current, 25);
  assert.equal(settings.getSetting('maxContextMessages'), 25);
});

test('restore of a key that did not exist removes it; a dangerous or protective key needs the admin\'s own browser session; secrets cannot be restored', () => {
  settings.updateSettings({ lockboxDefault: 'watch' });
  const e = journal.list({ limit: 1 })[0];
  assert.equal(e.key, 'lockboxDefault'); assert.equal(e.record, 'OPT-0431');
  const no = journal.restore(e.id, { isAdmin: true, isAdminSession: false });
  assert.equal(no.ok, false); assert.equal(no.status, 403);
  assert.equal(settings.getSetting('lockboxDefault'), 'watch', 'nothing changed');
  const yes = journal.restore(e.id, { isAdmin: true, isAdminSession: true });
  assert.equal(yes.ok, true);
  assert.equal('lockboxDefault' in settings.get(), false);
  // a protection by key name, without a record: sandbox / lockbox / policy / approvals / wallet
  for (const k of ['lockboxDefault', 'sandboxMemory', 'memberPolicy.send', 'approvalsEnabled', 'walletAgents']) assert.ok(journal.needsOwnSession('settings', k, null), k);
  assert.ok(!journal.needsOwnSession('settings', 'maxContextMessages', null));
  // a secret entry is never restorable
  const keyEntry = journal.list({ limit: 100 }).find((x) => x.key === 'providers.openai.apiKey');
  const sr = journal.restore(keyEntry.id, { isAdmin: true, isAdminSession: true });
  assert.equal(sr.ok, false); assert.equal(sr.status, 400); assert.match(sr.error, /secret/);
  assert.equal(journal.restore('sj-0000000000', { isAdmin: true }).status, 404);
});

test('restore of an agent field and of a preference goes through the same store hooks', async () => {
  const { member } = global.__t;
  const e = journal.list({ limit: 200 }).find((x) => x.key === 'agents.hazel.blurb' && x.after === 'Keeps the notes well');
  assert.ok(e);
  const r = journal.restore(e.id, { isAdmin: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(agents.readAgentValue('hazel', 'blurb'), 'Keeps the notes');
  assert.equal(journal.list({ limit: 1 })[0].who.kind, 'restore');
  const pe = journal.list({ limit: 200 }).find((x) => x.key === `prefs.${member.id}.theme` && x.after === 'light');
  const pr = journal.restore(pe.id, { user: member.id, isAdmin: false });
  assert.equal(pr.ok, true, JSON.stringify(pr));
  assert.equal(auth.getUser(member.id).theme, 'dark');
});

test('a journal that cannot be written refuses the change: the file, the memory and the other stores are unchanged', async () => {
  const { member } = global.__t;
  const bad = path.join(inst.data, 'journal-is-a-folder');
  fs.mkdirSync(bad);
  const real = journal.fileOf();
  const settingsBefore = fs.readFileSync(SETTINGS_FILE, 'utf8');
  const agentsBefore = fs.readFileSync(AGENTS_FILE, 'utf8');
  const usersBefore = fs.readFileSync(path.join(inst.data, 'users.json'), 'utf8');
  journal.configure({ file: bad });
  try {
    assert.throws(() => settings.updateSettings({ maxContextMessages: 99, hubBrief: 'changed' }), /change journal could not be written/);
    assert.equal(fs.readFileSync(SETTINGS_FILE, 'utf8'), settingsBefore, 'settings.json unchanged');
    assert.equal(settings.getSetting('maxContextMessages'), 25, 'memory unchanged');
    assert.equal(settings.getSetting('hubBrief'), undefined);
    const r = await agents.updateAgentField('hazel', { blurb: 'nope' });
    assert.equal(r.success, false); assert.match(r.error, /journal/);
    assert.equal(fs.readFileSync(AGENTS_FILE, 'utf8'), agentsBefore, 'agents.json unchanged');
    assert.throws(() => auth.setPrefs(member.id, { theme: 'auto' }), /journal/);
    assert.equal(fs.readFileSync(path.join(inst.data, 'users.json'), 'utf8'), usersBefore, 'users.json unchanged');
  } finally { journal.configure({ file: real }); }
  settings.updateSettings({ maxContextMessages: 27 });   // and it works again
  assert.equal(settings.getSetting('maxContextMessages'), 27);
});

test('rotation: past 5 MB the newest half is kept', () => {
  const j = journal.createJournal({ file: path.join(inst.data, 'rot.jsonl') });
  const pad = 'p'.repeat(1000);
  const entries = [];
  for (let i = 0; i < 6000; i++) entries.push({ id: `sj-${String(i).padStart(10, '0')}`, at: i, who: { kind: 'hub' }, store: 'settings', key: 'k', record: null, before: pad, after: i, why: null, restorable: true });
  for (let i = 0; i < entries.length; i += 500) j.append(entries.slice(i, i + 500));
  const size = fs.statSync(path.join(inst.data, 'rot.jsonl')).size;
  assert.ok(size < 5 * 1024 * 1024, `kept below the limit (${size})`);
  const all = j.list({ limit: 500 });
  assert.equal(all[0].after, 5999, 'the newest entry is kept');
  assert.ok(j.get('sj-0000000000') === null, 'the oldest is gone');
});

test('routes: access classes, a member sees only their own preferences and agents, restore permissions', async () => {
  const { member, other } = global.__t;
  assert.equal(access.classifyRoute('/api/settings-journal', 'GET').kind, 'session');
  assert.equal(access.classifyRoute('/api/settings-journal/sj-0123456789/restore', 'POST').kind, 'session');
  assert.equal(access.classifyRoute('/api/settings-journal/sj-nothex/restore', 'POST').kind, 'admin', 'a malformed id stays admin-only');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /pathname === '\/api\/settings-journal' && req\.method === 'GET'/);
  assert.match(src, /settings-journal\\\/\(sj-\[0-9a-f\]\{10\}\)\\\/restore/);
  assert.match(src, /restoreFor\(rm\[1\], \{[^}]*isAdminSession: access\.isAdminSession\(req\)/, 'the route passes the own-browser-session fact');
  assert.match(src, /sj\.listFor\(/);

  const roster = agents.loadAgentsFromDisk().map((a) => ({ name: a.name, owner: a.owner || null }));
  auth.setPrefs(other.id, { theme: 'dark' });
  const adminView = journal.listFor({ isAdmin: true, limit: 500 });
  assert.ok(adminView.some((e) => e.store === 'settings'));
  const mine = journal.listFor({ user: member.id, isAdmin: false, agents: roster, limit: 500 });
  assert.ok(mine.length > 0);
  for (const e of mine) {
    const ok = (e.store === 'prefs' && e.key.startsWith(`prefs.${member.id}.`)) || (e.store === 'agents' && e.key.split('.')[1] === 'hazel');
    assert.ok(ok, `a member must not see ${e.store}:${e.key}`);
  }
  assert.ok(mine.some((e) => e.store === 'prefs') && mine.some((e) => e.store === 'agents'));
  assert.ok(!JSON.stringify(mine).includes('rowan') && !JSON.stringify(mine).includes(other.id));
  assert.deepEqual(journal.listFor({ user: null, isAdmin: false, agents: roster }), []);

  // restore permissions
  settings.updateSettings({ maxContextMessages: 28 });
  const settingsEntry = journal.list({ limit: 1 })[0];
  assert.equal(journal.restoreFor(settingsEntry.id, { user: member.id, isAdmin: false, agents: roster }).status, 403, 'a member may not restore a hub setting');
  const otherPref = journal.list({ limit: 200 }).find((e) => e.key === `prefs.${other.id}.theme`);
  assert.equal(journal.restoreFor(otherPref.id, { user: member.id, isAdmin: false, agents: roster }).status, 403, 'nor another person\'s preference');
  const ownPref = journal.list({ limit: 200 }).find((e) => e.key === `prefs.${member.id}.theme` && e.after === 'light');
  assert.ok(ownPref);
  // an everyday field of an agent they own is allowed; a care field (category) is not
  await agents.updateAgentField('hazel', { blurb: 'Member blurb' });
  await agents.updateAgentField('hazel', { category: 'specialist' }).then(() => {
    const cat = journal.list({ limit: 5 }).find((e) => e.key === 'agents.hazel.category');
    assert.equal(journal.restoreFor(cat.id, { user: member.id, isAdmin: false, agents: roster }).status, 403, 'care: an admin\'s to restore');
    const blurb = journal.list({ limit: 10 }).find((e) => e.key === 'agents.hazel.blurb' && e.after === 'Member blurb');
    assert.equal(journal.restoreFor(blurb.id, { user: member.id, isAdmin: false, agents: roster }).ok, true);
    // an admin restores a care field
    assert.equal(journal.restoreFor(cat.id, { user: 'u_owner', isAdmin: true, isAdminSession: false, agents: roster }).ok, true);
  });
});

test('a dangerous agent field (sandbox) is restored only with the own-session fact, even by an admin', async () => {
  const r = await agents.updateAgentField('hazel', { sandbox: 'off' });
  assert.equal(r.success, true, JSON.stringify(r));
  const e = journal.list({ limit: 20 }).find((x) => x.key === 'agents.hazel.sandbox');
  assert.ok(e && e.restorable, JSON.stringify(e));
  assert.equal(e.record, 'OPT-0053');
  const refused = journal.restoreFor(e.id, { user: 'u_owner', isAdmin: true, isAdminSession: false, agents: [] });
  assert.equal(refused.status, 403);
  assert.equal(agents.readAgentValue('hazel', 'sandbox'), 'off');
  const done = journal.restoreFor(e.id, { user: 'u_owner', isAdmin: true, isAdminSession: true, agents: [] });
  assert.equal(done.ok, true, JSON.stringify(done));
  // restored through updateAgentField: "not set" is the field's own default word
  assert.equal(agents.readAgentValue('hazel', 'sandbox'), 'inherit');
});

// ── Review round 1 fixes (F2) ─────────────────────────────────────────────
const newest = () => journal.list({ limit: 1 })[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('S4: the keys with their own screen are journaled as not restorable and a restore is refused, even for an older line that says restorable', () => {
  for (const [key, value] of [['requireAdmin2fa', true], ['walletAgents', ['x']], ['walletOwner', '0xabc'], ['receiverAliases', { a: '/b' }], ['backup', { folders: ['/tmp/x'] }]]) {
    settings.updateSettings({ [key]: value });
    const e = journal.list({ limit: 20 }).find((x) => x.key === key || x.key.startsWith(`${key}.`));
    assert.ok(e, key);
    assert.equal(e.restorable, false, `${key} is not restorable`);
    const r = journal.restore(e.id, { isAdmin: true, isAdminSession: true });
    assert.equal(r.ok, false, key); assert.equal(r.status, 400, key);
    assert.match(r.error, /own screen/, key);
    assert.deepEqual(settings.getSetting(key), value, `${key} is untouched`);
  }
  // an older line (written before this rule) that claims restorable is refused too
  journal.append([{ id: 'sj-00000000a1', at: Date.now(), who: { kind: 'hub' }, store: 'settings', key: 'requireAdmin2fa', record: 'OPT-0298', before: false, after: true, why: null, restorable: true }]);
  settings.updateSettings({ requireAdmin2fa: false }); settings.updateSettings({ requireAdmin2fa: true });
  const old = journal.restore('sj-00000000a1', { isAdmin: true, isAdminSession: true });
  assert.equal(old.ok, false); assert.equal(old.status, 400);
  for (const k of ['requireAdmin2fa', 'walletAgents', 'walletOwner', 'receiverAliases', 'backup']) { const cur = settings.get(); delete cur[k]; }
  settings.updateSettings({ maxContextMessages: 29 });   // the in-memory deletions are saved away with the next write
});

test('G5: a reason is scrubbed with the secret patterns before it is written, and a URL credential never reaches the journal', () => {
  const secrets = ['sk-ant-api03-ABCDEFGH12345678', 'ghp_abcdefghijklmnopqrstuv0123', 'Bearer abcdef0123456789abcdef', 'password: hunter2-secret', 'xoxb-1234567890-abcdefghij', 'AKIAABCDEFGHIJKLMNOP'];
  const es = journal.withActor({ kind: 'lead', agent: 'maestro', why: `because ${secrets.join(' and ')} was in the ask` }, () => journal.recordChange('settings', [{ key: 'maxContextMessages', before: 29, after: 31 }]));
  const w = es[0].why;
  assert.match(w, /^because /);
  for (const s of ['ABCDEFGH12345678', 'abcdefghijklmnopqrstuv0123', 'abcdef0123456789abcdef', 'hunter2', '1234567890-abcdefghij', 'ABCDEFGHIJKLMNOP']) assert.ok(!w.includes(s), `${s} is scrubbed from: ${w}`);
  const e2 = journal.recordChange('settings', [{ key: 'hubBrief', before: undefined, after: 'x' }], { why: 'token = abc123XYZ789' });
  assert.ok(!e2[0].why.includes('abc123XYZ789'));
  assert.equal(journal.recordChange('settings', [{ key: 'hubBrief', before: 'x', after: 'y' }], { why: 'asked in chat' })[0].why, 'asked in chat', 'a plain reason is kept as it is');
  const text = fs.readFileSync(JOURNAL_FILE, 'utf8');
  for (const s of ['ABCDEFGH12345678', 'hunter2', 'abc123XYZ789']) assert.ok(!text.includes(s), `${s} is not in the file`);
  // the same text through a real writer: the actor's why is scrubbed in the file
  journal.withActor({ kind: 'hub', why: 'key sk-LIVE-0123456789abcdef used' }, () => settings.updateSettings({ maxContextMessages: 32 }));
  assert.ok(!fs.readFileSync(JOURNAL_FILE, 'utf8').includes('sk-LIVE-0123456789abcdef'));
  settings.updateSettings({ maxContextMessages: 27 });
});

test('follow-up: credentials inside a URL are redacted in journal values and in the notice, and such an entry cannot be restored', () => {
  const url = 'postgres://dbuser:S3cretPass@db.example.test:5432/app';
  const es = journal.recordChange('settings', [
    { key: 'someEndpoint', before: undefined, after: url },
    { key: 'proxies', before: undefined, after: { main: { url: 'https://tok123abc@proxy.example.test/x' }, plain: 'https://example.test/ok' } },
  ]);
  assert.equal(es[0].after, 'postgres://***@db.example.test:5432/app');
  assert.equal(es[1].after.main.url, 'https://***@proxy.example.test/x');
  assert.equal(es[1].after.plain, 'https://example.test/ok', 'a URL with no credential is kept');
  assert.equal(es[0].restorable, false); assert.equal(es[1].restorable, false);
  const plain = journal.recordChange('settings', [{ key: 'plainEndpoint', before: undefined, after: 'https://example.test/x' }])[0];
  assert.equal(plain.restorable, true);
  const text = fs.readFileSync(JOURNAL_FILE, 'utf8');
  for (const s of ['S3cretPass', 'dbuser', 'tok123abc']) assert.ok(!text.includes(s), s);
  // an outside edit that puts a credential in a URL: the journal and the notice never carry it
  const { q, timers } = fakeTimers();
  const notices = [];
  let now = 3_000_000_000_000;
  journal.configure({ clock: () => now, timers, notify: (p) => notices.push(p) });
  settings.get();
  const cur = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  cur['https://u:p4ss@h.example.test/a'] = 1; cur.mirror = 'https://admin:p4ssword@mirror.example.test/z'; cur.__pad = 'y'.repeat(7);
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(cur, null, 2));
  settings.get();
  const outside = journal.list({ limit: 20 }).filter((e) => e.who.kind === 'outside');
  assert.ok(outside.length >= 2);
  assert.ok(!JSON.stringify(outside).includes('p4ss'), JSON.stringify(outside));
  now += 60_000; q[0].fn();
  assert.equal(notices.length, 1);
  assert.ok(!notices[0].body.includes('p4ss'), notices[0].body);
  assert.match(notices[0].body, /\*\*\*@h\.example\.test/);
  journal.configure({ clock: Date.now, timers: { setTimeout, clearTimeout }, notify: null });
  const fixed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); delete fixed['https://u:p4ss@h.example.test/a']; delete fixed.mirror; delete fixed.__pad;
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(fixed, null, 2) + '\n'); settings.get();
});

test('G6: a failed file write restores the cached value, appends a failure line, propagates, and the entries are skipped by list and restore', async () => {
  settings.updateSettings({ maxContextMessages: 33 });
  const lastBefore = fs.readFileSync(SETTINGS_FILE, 'utf8');
  const realRename = fs.renameSync;
  fs.renameSync = function (a, b) { if (String(b) === SETTINGS_FILE) { const err = new Error('disk full (test)'); err.code = 'ENOSPC'; throw err; } return realRename.apply(this, arguments); };
  const nBefore = journal.list({ limit: 500 }).length;
  const log = console.error; console.error = () => {};
  try {
    assert.throws(() => settings.updateSettings({ maxContextMessages: 34, hubBrief: 'never written' }), /could not be written/);
  } finally { fs.renameSync = realRename; console.error = log; }
  assert.equal(settings.getSetting('maxContextMessages'), 33, 'the cached value is back');
  assert.equal(settings.getSetting('hubBrief'), undefined);
  assert.equal(fs.readFileSync(SETTINGS_FILE, 'utf8'), lastBefore, 'the file is as it was');
  const lines = fs.readFileSync(JOURNAL_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const failures = lines.filter((l) => typeof l.failedOf === 'string');
  assert.ok(failures.length >= 2, 'one failure line per entry');
  const failedEntries = failures.map((f) => lines.find((l) => l.id === f.failedOf));
  assert.ok(failedEntries.every((e) => e && e.who), 'each failure line names a written entry');
  assert.deepEqual(failedEntries.map((e) => e.key).sort(), ['hubBrief', 'maxContextMessages']);
  assert.equal(journal.list({ limit: 500 }).length, nBefore, 'list skips the failed entries');
  assert.equal(journal.get(failedEntries[0].id), null);
  assert.equal(journal.restore(failedEntries[0].id, { isAdmin: true, isAdminSession: true }).status, 404);
  // the next write starts from the last good state: its entry's before is 33, not the failed 34
  settings.updateSettings({ maxContextMessages: 35 });
  assert.equal(newest().before, 33); assert.equal(newest().after, 35);
  assert.equal(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')).maxContextMessages, 35);
  // agents.json: the same
  const agentsBefore = fs.readFileSync(AGENTS_FILE, 'utf8');
  const blurbBefore = agents.readAgentValue('hazel', 'blurb');
  fs.renameSync = function (a, b) { if (String(b) === AGENTS_FILE) throw new Error('disk full (test)'); return realRename.apply(this, arguments); };
  let r;
  try { r = await agents.updateAgentField('hazel', { blurb: 'never saved' }); } finally { fs.renameSync = realRename; }
  assert.equal(r.success, false); assert.match(r.error, /disk full/);
  assert.equal(fs.readFileSync(AGENTS_FILE, 'utf8'), agentsBefore);
  assert.equal(agents.readAgentValue('hazel', 'blurb'), blurbBefore, 'the cached agent list is back too');
  const aLines = fs.readFileSync(JOURNAL_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const aFail = aLines.filter((l) => typeof l.failedOf === 'string').map((f) => aLines.find((l) => l.id === f.failedOf)).find((e) => e.key === 'agents.hazel.blurb' && e.after === 'never saved');
  assert.ok(aFail, 'the agent entry has a failure line');
  assert.equal(journal.get(aFail.id), null);
  // apply() reports ok:false for a failed settings write
  const apply = L('settings-apply');
  const record = L('settings-records').byId('OPT-0381');
  fs.renameSync = function (a, b) { if (String(b) === SETTINGS_FILE) throw new Error('disk full (test)'); return realRename.apply(this, arguments); };
  console.error = () => {};
  let ar;
  try { ar = await apply.apply({ record, value: 77, user: { id: 'u_owner' }, isAdmin: true, actor: { kind: 'hub' } }); } finally { fs.renameSync = realRename; console.error = log; }
  assert.equal(ar.ok, false); assert.match(ar.error, /could not be written/);
  assert.equal(settings.getSetting('maxContextMessages'), 35);
});

test('G8: an operation\'s own ids never include a write that happened meanwhile', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const p = journal.withActorCollect({ kind: 'lead', agent: 'maestro' }, async () => {
    settings.updateSettings({ hubBrief: 'own one' });
    await gate;
    settings.updateSettings({ hubBrief: 'own two' });
    return 'done';
  });
  await sleep(5);
  settings.updateSettings({ maxContextMessages: 36 });   // someone else, in the middle (no actor context of its own)
  await journal.withActor({ kind: 'person', user: 'u_other' }, async () => { await sleep(1); settings.updateSettings({ maxContextMessages: 37 }); });
  release();
  const { result, ids } = await p;
  assert.equal(result, 'done');
  assert.equal(ids.length, 2);
  const entries = ids.map((id) => journal.get(id));
  assert.deepEqual(entries.map((e) => e.key), ['hubBrief', 'hubBrief']);
  assert.deepEqual(entries.map((e) => e.after), ['own one', 'own two']);
  assert.ok(entries.every((e) => e.who.kind === 'lead'));
  // nested scopes collect separately
  const outer = await journal.withActorCollect({ kind: 'hub' }, async () => {
    settings.updateSettings({ hubBrief: 'outer' });
    const inner = await journal.withActorCollect({ kind: 'cli' }, async () => { settings.updateSettings({ hubBrief: 'inner' }); });
    assert.equal(inner.ids.length, 1);
  });
  assert.equal(outer.ids.length, 1);
  settings.updateSettings({ hubBrief: undefined });
});

test('G4: an agent entry records the agent stamp and the owner; a new agent of the same name never inherits the old one\'s history or Restore', async () => {
  const { member, other } = global.__t;
  const list0 = agents.loadAgentsFromDisk();
  list0.push({ name: 'maple', box: 'box-aaa111', model: 'claude-sdk/default', owner: member.id });
  agents.saveAgentsToDisk(list0);
  const r1 = await agents.updateAgentField('maple', { blurb: 'first life' });
  assert.equal(r1.success, true);
  const e1 = journal.list({ limit: 5 }).find((e) => e.key === 'agents.maple.blurb');
  assert.equal(e1.stamp, 'box:box-aaa111'); assert.equal(e1.owner, member.id);
  const roster = () => agents.loadAgentsFromDisk().map((a) => ({ name: a.name, owner: a.owner || null, box: a.box }));
  assert.ok(journal.listFor({ user: member.id, isAdmin: false, agents: roster(), limit: 500 }).some((e) => e.id === e1.id), 'the owner sees it');
  // the agent is deleted and made again under the same name, now owned by another member
  agents.saveAgentsToDisk(agents.loadAgentsFromDisk().filter((a) => a.name !== 'maple'));
  const list1 = agents.loadAgentsFromDisk();
  list1.push({ name: 'maple', box: 'box-bbb222', model: 'claude-sdk/default', owner: other.id, blurb: 'first life' });
  agents.saveAgentsToDisk(list1);
  const r2 = await agents.updateAgentField('maple', { blurb: 'second life' });
  assert.equal(r2.success, true);
  const e2 = journal.list({ limit: 5 }).find((e) => e.key === 'agents.maple.blurb' && e.after === 'second life');
  assert.equal(e2.stamp, 'box:box-bbb222'); assert.equal(e2.owner, other.id);
  // the new owner sees only the new agent's entries; the old owner sees none of them
  const forOther = journal.listFor({ user: other.id, isAdmin: false, agents: roster(), limit: 500 }).filter((e) => e.key.startsWith('agents.maple.'));
  assert.ok(forOther.length > 0 && forOther.every((e) => e.stamp === 'box:box-bbb222'), JSON.stringify(forOther.map((e) => [e.key, e.stamp])));
  assert.ok(!forOther.some((e) => e.id === e1.id));
  assert.equal(journal.listFor({ user: member.id, isAdmin: false, agents: roster(), limit: 500 }).filter((e) => e.key.startsWith('agents.maple.')).length, 0, 'the old owner has no access to the new agent\'s history');
  // Restore: the new owner cannot put back the old agent's line; the old owner cannot either; an admin is refused while the stamp differs
  assert.equal(journal.restoreFor(e1.id, { user: other.id, isAdmin: false, agents: roster() }).status, 403);
  assert.equal(journal.restoreFor(e1.id, { user: member.id, isAdmin: false, agents: roster() }).status, 403);
  const adminTry = journal.restoreFor(e1.id, { user: 'u_owner', isAdmin: true, isAdminSession: true, agents: [] });
  assert.equal(adminTry.ok, false); assert.equal(adminTry.status, 409);
  assert.equal(agents.readAgentValue('maple', 'blurb'), 'second life');
  // the new owner restores their own agent's line (it still holds its new value)
  const r3 = await agents.updateAgentField('maple', { blurb: 'third' });
  assert.equal(r3.success, true);
  const e3 = journal.list({ limit: 5 }).find((e) => e.key === 'agents.maple.blurb' && e.after === 'third');
  assert.equal(journal.restoreFor(e3.id, { user: other.id, isAdmin: false, agents: roster() }).ok, true);
  assert.equal(agents.readAgentValue('maple', 'blurb'), 'second life');
  // a line with no stamp (older) is never shown to a member and an admin cannot restore it
  journal.append([{ id: 'sj-00000000b2', at: Date.now(), who: { kind: 'hub' }, store: 'agents', key: 'agents.maple.blurb', record: 'OPT-0005', before: 'x', after: 'second life', why: null, restorable: true }]);
  assert.ok(!journal.listFor({ user: other.id, isAdmin: false, agents: roster(), limit: 500 }).some((e) => e.id === 'sj-00000000b2'));
  assert.equal(journal.restore('sj-00000000b2', { isAdmin: true }).status, 409);
  // outside edits of an agent record the stamp and owner too
  const raw = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'));
  raw.find((a) => a.name === 'maple').blurb = 'edited by a program'; raw.push({ name: 'pad', pad: 'z'.repeat(11) });
  fs.writeFileSync(AGENTS_FILE, JSON.stringify(raw, null, 2));
  agents.loadAgentsFromDisk();
  const out = journal.list({ limit: 10 }).find((e) => e.who.kind === 'outside' && e.key === 'agents.maple.blurb');
  assert.ok(out && out.stamp === 'box:box-bbb222' && out.owner === other.id, JSON.stringify(out));
  const raw2 = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')).filter((a) => a.name !== 'pad');
  fs.writeFileSync(AGENTS_FILE, JSON.stringify(raw2, null, 2)); agents.loadAgentsFromDisk();
});

test('S5: restoring an agent field goes through updateAgentField with the guards and the follow-ups of PATCH /api/agents/:name', async () => {
  const apply = L('settings-apply');
  const removed = [];
  apply._setSandboxRemover((rec) => removed.push(rec.name));
  const events = L('hub-events').events;
  const seenEv = [];
  const realPublish = events.publish;
  events.publish = function (name, payload) { if (name === 'agent_updated') seenEv.push(payload); return realPublish.apply(this, arguments); };
  try {
    // a field with a cleaner: restore must clean the value (effort 'high' -> the field)
    await agents.updateAgentField('hazel', { effort: 'high' });
    await agents.updateAgentField('hazel', { effort: 'low' });
    const eff = journal.list({ limit: 10 }).find((e) => e.key === 'agents.hazel.effort' && e.after === 'low');
    const r = journal.restore(eff.id, { isAdmin: true, isAdminSession: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(agents.readAgentValue('hazel', 'effort'), 'high');
    await sleep(20);
    assert.ok(seenEv.some((p) => p.agent === 'hazel' && p.changed.includes('effort')), 'open pages are told (agent_updated)');
    // a sandbox change: the container is rebuilt on the next turn, as the route does
    await agents.updateAgentField('hazel', { sandbox: 'container' });
    const sb = journal.list({ limit: 10 }).find((e) => e.key === 'agents.hazel.sandbox' && e.after === 'container');
    removed.length = 0;
    const rs = journal.restoreFor(sb.id, { user: 'u_owner', isAdmin: true, isAdminSession: true, agents: [] });
    assert.equal(rs.ok, true, JSON.stringify(rs));
    await sleep(20);
    assert.deepEqual(removed, ['hazel'], 'the sandbox is rebuilt after a sandbox restore');
    // the route's guards hold for a restore too: recordings only by the owner, envKeep and reportsTo only by a signed-in admin, a member only the member fields
    const g = (field, who) => apply.restoreAgentField('hazel', field, undefined, who);
    assert.match(g('recordings', { isAdmin: true, user: 'u_owner' }).error, /only the owner can change: recordings/);
    assert.match(g('envKeep', { isAdmin: false, user: 'u_member' }).error, /only an admin can change: envKeep/);
    assert.match(g('policy', { isAdmin: false, user: 'u_member' }).error, /only an admin can change: policy/);
    assert.match(g('lockbox', { isAdmin: true, user: 'u_owner', isAdminSession: false }).error, /Sign in with an admin account in your browser/);
    assert.match(g('model', { isAdmin: true, user: 'u_owner' }).error, /its own screen/);
  } finally { events.publish = realPublish; apply._setSandboxRemover(null); }
});

test('S5: the PATCH route, the lead\'s tool path and Restore all call the one shared after-change function', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /settingsApply\.afterAgentChange\(name, body,/);
  const sa = fs.readFileSync(path.join(__dirname, '..', 'lib', 'settings-apply.js'), 'utf8');
  assert.match(sa, /await afterAgentChange\(agent, c\.fields,/);
  assert.match(sa, /afterAgentChange\(agentName, fields,/);
  for (const needle of ["greetIfFresh(name, u)", "title: 'Recording access changed'", "getSandbox().remove(rec)"]) {
    assert.ok(sa.includes(needle), `${needle} lives in lib/settings-apply`);
    assert.ok(!src.includes(needle), `${needle} is no longer in the route`);
  }
});

test('G7: a once-a-minute stamp watch journals a protected file changed by something other than the hub, without values, and the hub\'s own writes stay quiet', () => {
  const rawWrite = fs.writeFileSync;   // taken before the hook: stands for a program outside the hub
  const { q, timers } = fakeTimers();
  const notices = [];
  let now = 4_000_000_000_000;
  journal.configure({ clock: () => now, timers, notify: (p) => notices.push(p) });
  fs.mkdirSync(path.join(inst.data, 'push'), { recursive: true });
  const write = (f, text, raw = false) => (raw ? rawWrite : fs.writeFileSync)(path.join(inst.data, f), text);
  write('connectors.json', '{"connectors":[]}', true);
  write('modules.json', '{"modules":{}}', true);
  write('push/prefs.json', '{}', true);
  const w = journal.startWatch({ dataDir: inst.data, intervalMs: 0 });
  try {
    const n0 = journal.list({ limit: 500 }).length;
    w.tick();
    assert.equal(journal.list({ limit: 500 }).length, n0, 'the first look is the baseline');
    // the hub's own writes (a plain write, an atomic rename, an append, a brand new wallet file) are not reported
    write('connectors.json', '{"connectors":[{"id":"a"}]}');
    fs.writeFileSync(path.join(inst.data, '.m.tmp'), '{"modules":{"x":1}}'); fs.renameSync(path.join(inst.data, '.m.tmp'), path.join(inst.data, 'modules.json'));
    fs.writeFileSync(path.join(inst.data, 'wallet-state.json'), '{"a":1}');
    fs.appendFileSync(path.join(inst.data, 'wallet-audit.jsonl'), '{"row":1}\n');
    auth.setPrefs(global.__t.member.id, { theme: 'dark' });   // users.json, written by the hub's own account code
    w.tick();
    assert.equal(journal.list({ limit: 500 }).filter((e) => e.store === 'files').length, 0, 'own writes are quiet');
    assert.equal(q.length, 0, 'no notice queued');
    // a program writes users.json, push/prefs.json and a wallet file
    write('push/prefs.json', '{"users":{"u":{"a":1}}}', true);
    write('wallet-state.json', '{"a":1,"b":"owner changed this by hand"}', true);
    write('users.json', JSON.stringify({ users: [], note: 'edited by a script', secretish: 'hunter2-should-never-appear' }), true);
    w.tick();
    const files = journal.list({ limit: 50 }).filter((e) => e.store === 'files').reverse();
    assert.deepEqual(files.map((e) => e.key).sort(), ['files/push/prefs.json', 'files/users.json', 'files/wallet-state.json']);
    for (const e of files) { assert.equal(e.who.kind, 'outside'); assert.equal(e.restorable, false); assert.ok(!('before' in e) && !('after' in e), 'no values'); }
    assert.ok(!fs.readFileSync(JOURNAL_FILE, 'utf8').includes('hunter2-should-never-appear'));
    // one batched notice for the lot, not restorable wording
    assert.equal(q.length, 1);
    assert.equal(q[0].ms, 60_000);
    now += 60_000; q[0].fn();
    assert.equal(notices.length, 1);
    assert.match(notices[0].body, /protected files were edited by a program on this computer/);
    for (const n of ['users.json', 'push/prefs.json', 'wallet-state.json']) assert.ok(notices[0].body.includes(n), n);
    // a second look with nothing new reports nothing; a hub write after the outside one is again quiet
    w.tick();
    assert.equal(journal.list({ limit: 500 }).filter((e) => e.store === 'files').length, 3);
    write('users.json', JSON.stringify({ users: [], note: 'the hub wrote this, a longer text than before' }));
    w.tick();
    assert.equal(journal.list({ limit: 500 }).filter((e) => e.store === 'files').length, 3, 'a hub write after an outside one is quiet');
    // the settings page shape: a file entry has a name and no agent
    const v = journal.viewEntry(files[0]);
    assert.equal(v.name, files[0].key); assert.equal(v.agent, null);
  } finally {
    w.stop();
    journal.configure({ clock: Date.now, timers: { setTimeout, clearTimeout }, notify: null });
  }
  for (const f of ['connectors.json', 'modules.json', 'push/prefs.json', 'users.json', 'wallet-state.json', 'wallet-audit.jsonl']) { try { fs.rmSync(path.join(inst.data, f), { force: true }); } catch { /* gone */ } }
});

test('G7: the server starts the watch once a minute', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /require\('\.\/lib\/settings-journal'\)/);
  // the install's data/ and the moved account folder (the one resolver, relative values too) are watched, each folder once
  assert.match(src, /\.startWatches\(\[dataW, require\('\.\/lib\/auth'\)\.resolveAuthDir\(\)\]\)/);
});

// ── Round 2 ───────────────────────────────────────────────────────────────
const rawLines = () => fs.readFileSync(JOURNAL_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// Runs fn with fs.renameSync failing (disk full) for one destination file.
function failingRename(dest, fn) {
  const real = fs.renameSync;
  fs.renameSync = function (a, b) { if (String(b) === dest) { const e = new Error('disk full (test)'); e.code = 'ENOSPC'; throw e; } return real.apply(this, arguments); };
  const log = console.error; console.error = () => {};
  try { return fn(); } finally { fs.renameSync = real; console.error = log; }
}
// Runs fn and tells how many journal entries a reader could see at the moment the file for `dest` was renamed into place.
// A write the hook of the hub cannot see (file descriptors): stands for a program outside the hub.
function rawWrite(file, text) { const fd = fs.openSync(file, 'w'); try { fs.writeSync(fd, text); } finally { fs.closeSync(fd); } }
// An account store of its own on the test data folder (an earlier test removes users.json) with one member.
function freshAuth() {
  const au = L('auth').createAuth({ dataDir: inst.data, log: () => {} });
  const m = au.createUser({ login: `r2-${Date.now()}@example.com`, name: 'R2', role: 'member', password: 'r2-long-password-1' }).user;
  return { au, m };
}
function visibleDuringRename(dest, fn) {
  const real = fs.renameSync; let seen = null;
  fs.renameSync = function (a, b) { if (String(b) === dest) seen = journal.list({ limit: 500 }).length; return real.apply(this, arguments); };
  try { fn(); } finally { fs.renameSync = real; }
  return seen;
}

test('R2-3: a failed file write of a research, notify, voice or users preference is not kept: the entry is marked failed, the error propagates', () => {
  const { au, m: member } = freshAuth();
  const f = (n) => path.join(inst.data, n);
  const rp = L('research-prefs').createResearchPrefs({ file: f('research-prefs.json') });
  const np = L('notify-prefs').createNotifyPrefs({ file: f('notify-prefs.json') });
  const vp = L('voice-person-prefs').createVoicePersonPrefs({ file: f('voice-person-prefs.json') });
  const cases = [
    ['research', f('research-prefs.json'), () => rp.setChoice('u-r23', 'always'), () => rp.choiceOf('u-r23') === 'ask', 'prefs.u-r23.research.choice'],
    ['research level', f('research-prefs.json'), () => rp.setAlwaysLevel('u-r23', 'thorough'), () => rp.alwaysLevelOf('u-r23') === 'quick', 'prefs.u-r23.research.alwaysLevel'],
    ['notify', f('notify-prefs.json'), () => np.setDefault('u-r23', { questions: 'off' }), () => np.get('u-r23').default.questions === 'on', 'prefs.u-r23.notify.default.questions'],
    ['voice', f('voice-person-prefs.json'), () => vp.setInterruptReminder('u-r23', false), () => vp.interruptReminder('u-r23') === true, 'prefs.u-r23.voice.interruptReminder'],
    ['users', f('users.json'), () => au.setPrefs(member.id, { planBadge: 'five' }), () => au.getUser(member.id).planBadge !== 'five', `prefs.${member.id}.planBadge`],
  ];
  for (const [name, dest, change, unchanged, key] of cases) {
    const n0 = journal.list({ limit: 500 }).length;
    assert.throws(() => failingRename(dest, change), /disk full|could not be written/, `${name}: the error propagates`);
    assert.ok(unchanged(), `${name}: the change is not kept`);
    assert.equal(journal.list({ limit: 500 }).length, n0, `${name}: the change strip shows nothing`);
    const lines = rawLines();
    const written = lines.filter((l) => l.key === key && l.after !== undefined).pop();
    assert.ok(written, `${name}: the entry was written first (pending)`);
    assert.equal(written.pending, true, `${name}: as a pending entry`);
    assert.ok(lines.some((l) => l.failedOf === written.id), `${name}: and marked failed`);
    assert.equal(journal.get(written.id), null, `${name}: get() does not see it`);
    // the same change on a working disk: invisible while the file is written, visible after
    let seen;
    const n1 = journal.list({ limit: 500 }).length;
    seen = visibleDuringRename(dest, change);
    assert.equal(seen, n1, `${name}: nobody sees the entry before the file is written`);
    const now = journal.list({ limit: 500 });
    assert.equal(now.length, n1 + 1, `${name}: visible once the file is written`);
    assert.equal(now[0].key, key);
    assert.ok(rawLines().some((l) => l.commitOf === now[0].id), `${name}: through a commit line`);
  }
});

test('R2-3: the settings and agents stores are two-phase too, and a crash between the phases leaves a pending entry nobody sees', async () => {
  const n0 = journal.list({ limit: 500 }).length;
  const seenS = visibleDuringRename(SETTINGS_FILE, () => settings.updateSettings({ maxContextMessages: 71 }));
  assert.equal(seenS, n0, 'settings: invisible until the file is written');
  assert.equal(newest().key, 'maxContextMessages');
  const n1 = journal.list({ limit: 500 }).length;
  let seenA = null;
  const real = fs.renameSync;
  fs.renameSync = function (a, b) { if (String(b) === AGENTS_FILE) seenA = journal.list({ limit: 500 }).length; return real.apply(this, arguments); };
  try { await agents.updateAgentField('hazel', { blurb: 'two-phase blurb' }); } finally { fs.renameSync = real; }
  assert.equal(seenA, n1, 'agents: invisible until the file is written');
  assert.equal(newest().key, 'agents.hazel.blurb');
  // a crash after the pending line and before the commit line: the entry is in the file but never shows or restores
  const pend = journal.recordChange('settings', [{ key: 'maxContextMessages', before: 71, after: 72 }], { pending: true });
  assert.equal(pend[0].pending, true);
  assert.ok(fs.readFileSync(JOURNAL_FILE, 'utf8').includes(pend[0].id));
  assert.equal(journal.get(pend[0].id), null);
  assert.ok(!journal.list({ limit: 500 }).some((e) => e.id === pend[0].id));
  assert.equal(journal.restore(pend[0].id, { isAdmin: true, isAdminSession: true }).status, 404);
  assert.ok(!journal.restoredIds(0).has(pend[0].id));
  journal.commit(pend);
  assert.ok(journal.get(pend[0].id), 'visible after its commit line');
});

test('R2-4: an outside edit followed by a hub write to the same file before the tick is recorded first; the hub\'s deletion is the hub\'s', () => {
  const { q, timers } = fakeTimers();
  journal.configure({ timers, notify: () => {} });
  journal._pending.clear();
  const f = path.join(inst.data, 'connectors.json');
  rawWrite(f, '{"connectors":[]}');
  const w = journal.startWatch({ dataDir: inst.data, intervalMs: 0 });
  try {
    w.tick();
    const filesN = () => journal.list({ limit: 500 }).filter((e) => e.store === 'files' && e.key === 'files/connectors.json').length;
    const n0 = filesN();
    rawWrite(f, '{"connectors":[{"id":"edited by a script"}]}');   // outside
    fs.writeFileSync(f, '{"connectors":[{"id":"the hub wrote this later"}]}');   // the hub, before any tick
    assert.equal(filesN(), n0 + 1, 'the outside edit was recorded at the hub\'s own write');
    assert.equal(q.length, 1, 'with its notice');
    w.tick();
    assert.equal(filesN(), n0 + 1, 'the tick adds nothing more');
    // a hub write with nothing outside before it stays quiet
    fs.writeFileSync(f, '{"connectors":[{"id":"again"}]}'); w.tick();
    assert.equal(filesN(), n0 + 1);
    // an outside edit and then the hub's rename onto the file
    rawWrite(f, '{"connectors":["outside 2"]}');
    fs.writeFileSync(`${f}.tmp`, '{"connectors":["hub 2"]}'); fs.renameSync(`${f}.tmp`, f);
    assert.equal(filesN(), n0 + 2, 'also at a rename');
    // the hub deletes the file: its own change, not an outside one (unlink and rm)
    fs.unlinkSync(f); w.tick();
    assert.equal(filesN(), n0 + 2, 'unlink by the hub is not reported');
    fs.writeFileSync(f, '{"connectors":[]}'); w.tick();
    fs.rmSync(f); w.tick();
    assert.equal(filesN(), n0 + 2, 'rm by the hub is not reported');
    // a deletion by something else still is reported
    fs.writeFileSync(f, '{"connectors":[]}'); w.tick();
    require('node:child_process').execFileSync(process.execPath, ['-e', `require('fs').unlinkSync(${JSON.stringify(f)})`], { env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    w.tick();
    assert.equal(filesN(), n0 + 3, 'an outside deletion is still reported by the tick');
    fs.writeFileSync(f, '{"connectors":[]}'); w.tick();
    rawWrite(f, '{"connectors":["x"]}'); w.tick();
    assert.equal(filesN(), n0 + 4, 'and so is an outside edit');
  } finally {
    w.stop();
    journal.configure({ clock: Date.now, timers: { setTimeout, clearTimeout }, notify: null });
    try { fs.rmSync(f, { force: true }); } catch { /* gone */ }
  }
});

test('R2-4: the command line marks its writes to users.json and other watched files, so they are not reported as outside', () => {
  const { execFileSync } = require('node:child_process');
  const { q, timers } = fakeTimers();
  journal.configure({ timers, notify: () => {} });
  journal._pending.clear();
  const { au, m } = freshAuth();   // users.json exists
  const users = path.join(inst.data, 'users.json'), mods = path.join(inst.data, 'modules.json');
  const w = journal.startWatch({ dataDir: inst.data, intervalMs: 0 });
  try {
    w.tick();
    const filesN = () => journal.list({ limit: 500 }).filter((e) => e.store === 'files').length;
    const n0 = filesN(), q0 = q.length;
    // another process (what scripts/hub-cli.js does: startCliMarking, then the writes of the command)
    const code = `const sj=require(${JSON.stringify(path.join(inst.lib, 'settings-journal'))});const fs=require('fs');const p=require('path');const d=${JSON.stringify(inst.data)};
      sj.startCliMarking({dataDir:d});
      const u=JSON.parse(fs.readFileSync(p.join(d,'users.json'),'utf8'));u.note='cli wrote this';fs.writeFileSync(p.join(d,'users.json.tmp'),JSON.stringify(u));fs.renameSync(p.join(d,'users.json.tmp'),p.join(d,'users.json'));
      fs.writeFileSync(p.join(d,'modules.json'),'{"modules":{"cli":1}}');`;
    execFileSync(process.execPath, ['-e', code], { env: { PATH: process.env.PATH, HOME: process.env.HOME, MM_TEST_NO_REAL_CLAUDE: '1' } });
    assert.ok(rawLines().some((l) => l.marker && l.store === 'files/users.json'), 'a marker line for users.json');
    w.tick();
    assert.equal(filesN(), n0, 'the command\'s own writes are not outside edits');
    assert.equal(q.length, q0);
    // the hub writes users.json right after a command did, before its tick: still quiet
    execFileSync(process.execPath, ['-e', `const sj=require(${JSON.stringify(path.join(inst.lib, 'settings-journal'))});sj.startCliMarking({dataDir:${JSON.stringify(inst.data)}});require('fs').writeFileSync(${JSON.stringify(users)},require('fs').readFileSync(${JSON.stringify(users)},'utf8')+' ');`], { env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    au.setPrefs(m.id, { theme: 'auto' });
    w.tick();
    assert.equal(filesN(), n0, 'a hub write after a command write is quiet too');
    // an unmarked outside write is still reported
    execFileSync(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(mods)},'{"modules":{"by":"script"}}')`], { env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    w.tick();
    assert.equal(filesN(), n0 + 1);
  } finally {
    w.stop();
    journal.configure({ clock: Date.now, timers: { setTimeout, clearTimeout }, notify: null });
    try { fs.rmSync(mods, { force: true }); } catch { /* gone */ }
  }
});

test('R2-5: credentials in URL query parameters are redacted in journal values and in notices, and such entries cannot be restored', () => {
  const names = ['api_key', 'apikey', 'key', 'token', 'access_token', 'secret', 'password', 'pass', 'sig', 'signature', 'auth', 'API_KEY', 'Token', 'ACCESS_TOKEN'];
  const rows = names.map((n, i) => ({ key: `endpoint${i}`, before: undefined, after: `https://api.example.test/v1/items?page=2&${n}=SECRET${i}VALUE&x=1` }));
  rows.push({ key: 'fragment', before: undefined, after: 'https://app.example.test/cb#access_token=FRAGSECRET&state=ok' });
  rows.push({ key: 'first', before: undefined, after: 'https://api.example.test/v1?api_key=FIRSTSECRET' });
  rows.push({ key: 'nested', before: undefined, after: { feed: { url: 'wss://h.example.test/s?token=NESTEDSECRET' } } });
  const es = journal.recordChange('settings', rows);
  for (const e of es) assert.equal(e.restorable, false, `${e.key} is not restorable`);
  const text = fs.readFileSync(JOURNAL_FILE, 'utf8');
  for (const s of [...names.map((_, i) => `SECRET${i}VALUE`), 'FRAGSECRET', 'FIRSTSECRET', 'NESTEDSECRET']) assert.ok(!text.includes(s), s);
  assert.equal(es[0].after, 'https://api.example.test/v1/items?page=2&api_key=***&x=1', 'the rest of the URL is kept');
  assert.equal(es[names.length].after, 'https://app.example.test/cb#access_token=***&state=ok');
  const plain = journal.recordChange('settings', [{ key: 'plainPaging', before: undefined, after: 'https://example.test/list?page=2&sort=name' }])[0];
  assert.equal(plain.restorable, true); assert.equal(plain.after, 'https://example.test/list?page=2&sort=name');
  assert.equal(journal.redactUrlText('see https://h.test/a?Signature=ABC123&b=2 now'), 'see https://h.test/a?Signature=***&b=2 now');
  // an outside edit that puts such a URL in the settings file: neither the entry nor the notice carries it
  const { q, timers } = fakeTimers();
  const notices = [];
  let now = 3_100_000_000_000;
  journal.configure({ clock: () => now, timers, notify: (p) => notices.push(p) });
  journal._pending.clear();
  settings.get();
  const cur = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  cur['https://h.example.test/p?token=KEYNAMESECRET'] = 1; cur.mirror2 = 'https://m.example.test/z?password=OUTSIDESECRET'; cur.__pad2 = 'z'.repeat(9);
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(cur, null, 2));
  settings.get();
  const outside = journal.list({ limit: 20 }).filter((e) => e.who.kind === 'outside');
  assert.ok(outside.length >= 2);
  assert.ok(!JSON.stringify(outside).includes('SECRET'), JSON.stringify(outside));
  assert.ok(outside.every((e) => e.restorable === false || !/mirror2|token=/.test(e.key)));
  now += 60_000; q[0].fn();
  assert.ok(notices.length >= 1 && !notices[0].body.includes('SECRET'), notices[0] && notices[0].body);
  journal.configure({ clock: Date.now, timers: { setTimeout, clearTimeout }, notify: null });
  const fixed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); delete fixed['https://h.example.test/p?token=KEYNAMESECRET']; delete fixed.mirror2; delete fixed.__pad2;
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(fixed, null, 2) + '\n'); settings.get();
});

test('R2 follow-up: the keys never restored come from the bulk route\'s dropped keys (plus requireAdmin2fa)', () => {
  const sa = L('settings-apply');
  for (const k of [...Object.keys(sa.DROPPED_KEYS), 'requireAdmin2fa']) assert.equal(journal.neverRestorable('settings', k), true, k);
  assert.equal(journal.neverRestorable('settings', 'maxContextMessages'), false);
  assert.equal(journal.neverRestorable('agents', 'backup'), false, 'only the settings store');
  // a key added to the dropped list later is covered without touching the journal
  sa.DROPPED_KEYS.zzNewProtectedKey = 'test line';
  try { assert.equal(journal.neverRestorable('settings', 'zzNewProtectedKey.inner'), true); } finally { delete sa.DROPPED_KEYS.zzNewProtectedKey; }
});

test('R2 follow-up: the operation\'s own id collector never keeps an outside entry found on the way', async () => {
  settings.get();
  const cur = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  cur.outsideOnlyKey = 'added by a script'; cur.__pad3 = 'q'.repeat(11);
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(cur, null, 2));   // another stamp: the next get() journals it as outside, inside the operation
  const { ids } = await journal.withActorCollect({ kind: 'lead', agent: 'maestro', turn: 't-collect' }, async () => { settings.updateSettings({ maxContextMessages: 73 }); });
  assert.ok(ids.length >= 1);
  const outside = journal.list({ limit: 50 }).filter((e) => e.who.kind === 'outside' && e.key === 'outsideOnlyKey');
  assert.equal(outside.length, 1, 'the outside edit was journaled');
  for (const id of ids) { const e = journal.get(id); assert.ok(e && e.who.kind === 'lead', `${id} is the operation's own`); assert.notEqual(id, outside[0].id); }
  assert.ok(ids.some((id) => journal.get(id).key === 'maxContextMessages'));
  // a failed write is not in the ids either
  const r = await journal.withActorCollect({ kind: 'lead', agent: 'maestro' }, async () => {
    try { failingRename(SETTINGS_FILE, () => settings.updateSettings({ maxContextMessages: 74 })); } catch { /* expected */ }
  });
  assert.deepEqual(r.ids, [], 'an entry of a write that failed is dropped');
  const fixed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); delete fixed.outsideOnlyKey; delete fixed.__pad3;
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(fixed, null, 2) + '\n'); settings.get();
});

test('R2 follow-up: restoring an agent entry recorded without a stamp says it is an older entry from before agents were tracked', () => {
  const e = { id: 'sj-0a0b0c0d0e', at: Date.now(), who: { kind: 'person' }, store: 'agents', key: 'agents.hazel.blurb', record: null, before: 'old', after: 'older text', why: null, restorable: true };
  fs.appendFileSync(JOURNAL_FILE, JSON.stringify(e) + '\n');
  const r = journal.restore(e.id, { isAdmin: true, isAdminSession: true });
  assert.equal(r.ok, false); assert.equal(r.status, 409);
  assert.match(r.error, /older entry from before agents were tracked/);
  const stamped = { ...e, id: 'sj-0f0e0d0c0b', stamp: 'box:not-this-one' };
  fs.appendFileSync(JOURNAL_FILE, JSON.stringify(stamped) + '\n');
  assert.match(journal.restore(stamped.id, { isAdmin: true, isAdminSession: true }).error, /no longer the one/, 'a stamped entry of another agent keeps the other wording');
});

// ── Round 3 ───────────────────────────────────────────────────────────────
// Runs fn with every append of a commit line failing (a full disk at the second phase only).
function failingCommit(fn) {
  const real = fs.appendFileSync;
  fs.appendFileSync = function (f, text) { if (String(f) === JOURNAL_FILE && String(text).includes('"commitOf"')) { const e = new Error('disk full (test)'); e.code = 'ENOSPC'; throw e; } return real.apply(this, arguments); };
  const log = console.warn; console.warn = () => {};
  try { return fn(); } finally { fs.appendFileSync = real; console.warn = log; }
}

test('R3-2: a commit line that cannot be written leaves the change saved, history:false, no ids; the start-up reconcile commits it when the live value is the entry\'s after, else fails it', async () => {
  const person = { kind: 'person', user: 'u_owner' };
  let r;
  await failingCommit(async () => { r = await journal.withActorCollect(person, async () => { settings.updateSettings({ maxContextMessages: 75 }); }); });
  assert.equal(r.history, false, 'the operation is told the history line is missing');
  assert.deepEqual(r.ids, [], 'no entry id, so no Undo and no change line');
  assert.equal(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')).maxContextMessages, 75, 'the change itself was saved');
  const pendingLine = rawLines().filter((l) => l.pending && l.key === 'maxContextMessages').pop();
  assert.ok(pendingLine && !rawLines().some((l) => l.commitOf === pendingLine.id), 'a pending line without a commit line');
  assert.equal(journal.get(pendingLine.id), null, 'invisible until reconciled');
  // a second pending entry whose "after" is not what the file holds (the write never happened)
  const wrong = journal.recordChange('settings', [{ key: 'maxContextMessages', before: 75, after: 99 }], { pending: true });
  const res = journal.reconcile();
  assert.ok(res.committed >= 1 && res.failed >= 1, JSON.stringify(res));
  assert.ok(journal.get(pendingLine.id), 'committed: the live value is the entry\'s after');
  assert.equal(journal.get(wrong[0].id), null);
  assert.ok(rawLines().some((l) => l.failedOf === wrong[0].id), 'failed line for the entry the file does not show');
  // the pass is repeatable: nothing is pending now
  assert.deepEqual(journal.reconcile(), { committed: 0, failed: 0 });
  // a clean operation still says history:true
  const ok = await journal.withActorCollect(person, async () => { settings.updateSettings({ maxContextMessages: 76 }); });
  assert.equal(ok.history, true); assert.equal(ok.ids.length, 1);
});

test('R3-2: the server runs the reconcile pass at start-up next to the watch', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /require\('\.\/lib\/settings-journal'\)\.reconcile\(\)/);
});

test('R3-3: a query parameter whose name contains key, token, secret, pass, sig, auth or credential is redacted', () => {
  const cases = ['client_secret', 'refresh_token', 'auth_token', 'x-api-key', 'access_key', 'secret_key', 'authorization', 'Authorization', 'X-API-KEY', 'id_token', 'passwd', 'credential', 'signature', 'api_key', 'password'];
  for (const name of cases) {
    const t = journal.redactUrlText(`https://h.example/p?a=1&${name}=VALUE123&b=2`);
    assert.ok(!t.includes('VALUE123'), `${name}: ${t}`);
    assert.ok(t.includes('a=1') && t.includes('b=2'), 'the other parameters stay');
    assert.ok(!journal.redactUrlText(`#${name}=VALUE123`).includes('VALUE123'), `${name} in a fragment`);
  }
  assert.equal(journal.redactUrlText('https://h.example/p?page=2&q=cats'), 'https://h.example/p?page=2&q=cats');
  assert.deepEqual(journal.redactUrls({ url: 'https://x.example/cb?client_secret=ZZZ&code=1' }), { url: 'https://x.example/cb?client_secret=***&code=***' });
});

test('R4 follow-up: query parameter names are split on _ - . ; and camelCase: credential words are redacted, look-alike words are not', () => {
  const hide = ['code', 'pwd', 'pw', 'jwt', 'sid', 'session', 'bearer', 'otp', 'sig', 'accessToken', 'apiKey', 'APIKey', 'clientSecret', 'user.password', 'session-id', 'oauth_code', 'userPw', 'id_token'];
  for (const name of hide) {
    for (const sep of ['?', '&', '#', ';']) {
      const t = journal.redactUrlText(`https://h.example/p${sep === '?' ? '' : '?z=1'}${sep}${name}=VALUE123`);
      assert.ok(!t.includes('VALUE123'), `${name} after ${sep}: ${t}`);
    }
  }
  const keep = ['author', 'keyword', 'design', 'signal', 'bypass', 'monkey', 'page', 'q', 'passenger'];   // (codec contains "code": over-redacted since R5-1)
  for (const name of keep) {
    const u = `https://h.example/p?a=1&${name}=VISIBLE&b=2;${name}=VISIBLE`;
    assert.equal(journal.redactUrlText(u), u, name);
  }
  assert.equal(journal.redactUrlText('https://h.example/p?a=1;token=ZZZ;b=2'), 'https://h.example/p?a=1;token=***;b=2');
  assert.deepEqual(journal.redactUrls({ u: 'a=1;sid=ZZZ' }), { u: 'a=1;sid=***' });
});

test('R5-1: compact credential names are redacted (a name that CONTAINS a credential part), the safe list is kept, percent-encoded names are decoded', () => {
  const hide = ['accesstoken', 'refreshtoken', 'authtoken', 'idtoken', 'clientsecret', 'secretkey', 'sessionid', 'sessid', 'PHPSESSID', 'userpass', 'bearertoken', 'xapikey',
    'auth%5Ftoken', 'access%5Ftoken', 'api%2Dkey', 'client%255Fsecret', 'AccessToken', 'JSESSIONID', 'pwd', 'otp', 'jwt', 'credentials', 'verifycode'];
  for (const name of hide) {
    for (const sep of ['?', '&', '#', ';']) {
      const t = journal.redactUrlText(`https://h.example/p${sep === '?' ? '' : '?z=1'}${sep}${name}=VALUE123`);
      assert.ok(!t.includes('VALUE123'), `${name} after ${sep}: ${t}`);
      assert.ok(t.includes(`${sep}${name}=***`), `${name}: the original spelling stays in the shown URL: ${t}`);
    }
  }
  const keep = ['author', 'authors', 'keyword', 'keywords', 'design', 'signal', 'bypass', 'monkey', 'passenger', 'passage', 'compass', 'sort_key', 'country_code', 'zip_code',
    'postcode', 'postal_code', 'keyboard', 'monkeys', 'Author', 'SORT_KEY', 'page', 'q'];
  for (const name of keep) {
    const u = `https://h.example/p?a=1&${name}=VISIBLE&b=2;${name}=VISIBLE`;
    assert.equal(journal.redactUrlText(u), u, name);
  }
  assert.deepEqual(journal.redactUrls({ u: 'https://x.example/cb?accesstoken=ZZZ&author=me&auth%5Ftoken=YYY' }), { u: 'https://x.example/cb?accesstoken=***&author=me&auth%5Ftoken=***' });
});

test('R3-4: voice.enabled entries are never restorable (the Voice screen is the way) and Restore names that screen; the value stays', () => {
  settings.updateSettings({ voice: { enabled: false } });
  journal.withActor({ kind: 'person', user: 'u_owner' }, () => { settings.updateSettings({ voice: { enabled: true } }); });
  const e = journal.list({ limit: 20 }).find((x) => x.key === 'voice.enabled');
  assert.ok(e, 'journaled'); assert.equal(e.restorable, false);
  const r = journal.restore(e.id, { isAdmin: true, isAdminSession: true });
  assert.equal(r.ok, false); assert.match(r.error, /Voice and calls/);
  assert.match(r.link, /settings-for=OPT-0227/);
  assert.equal(settings.getPath('voice.enabled'), true, 'nothing changed');
  assert.equal(journal.viewEntry(e).screen, 'Settings > Voice and calls');
});

test('R3-5: the hub\'s own wallet temp files and renames give no outside entry; a vanished never-looked-at file is dropped; a rename\'s source is the hub\'s', () => {
  const { timers } = fakeTimers();
  journal.configure({ timers, notify: () => {} });
  journal._pending.clear();
  const d = (n) => path.join(inst.data, n);
  rawWrite(d('wallet-a.json'), '{"a":1}');
  const w = journal.startWatch({ dataDir: inst.data, intervalMs: 0 });
  const filesN = () => journal.list({ limit: 500 }).filter((e) => e.store === 'files').length;
  try {
    w.tick();
    const n0 = filesN();
    // temp write + rename onto a wallet file, a pid temp, a backup copy
    fs.writeFileSync(d('wallet-state.json.4242.tmp'), '{"s":1}');
    fs.renameSync(d('wallet-state.json.4242.tmp'), d('wallet-state.json'));
    fs.writeFileSync(d('wallet-state.json.tmp'), '{"s":2}');
    fs.copyFileSync(d('wallet-state.json'), d('wallet-state.json.bak'));
    w.tick();
    assert.equal(filesN(), n0, 'temp, pid temp and bak variants are never tracked');
    fs.unlinkSync(d('wallet-state.json.tmp'));
    rawWrite(d('wallet-stray.json.tmp'), 'x');   // even a program's temp copy of that name is not a protected file
    w.tick();
    assert.equal(filesN(), n0);
    // a file the hub wrote (the write itself counts as a sighting, R4-4) and another process removed before a tick: one outside deletion
    fs.writeFileSync(d('wallet-m.json'), '{"m":1}');
    require('node:child_process').execFileSync(process.execPath, ['-e', `require('fs').unlinkSync(${JSON.stringify(d('wallet-m.json'))})`], { env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    w.tick();
    assert.equal(filesN(), n0 + 1, 'a file the hub wrote and an outside process removed is reported');
    // the hub renames a file the watch knew: its source is gone by the hub's hand
    fs.renameSync(d('wallet-a.json'), d('wallet-b.json'));
    w.tick();
    assert.equal(filesN(), n0 + 1, 'the rename\'s source is recorded as the hub\'s');
    // an outside edit of a wallet file is still reported
    rawWrite(d('wallet-b.json'), '{"b":"by hand"}');
    w.tick();
    assert.equal(filesN(), n0 + 2);
  } finally {
    w.stop();
    journal.configure({ clock: Date.now, timers: { setTimeout, clearTimeout }, notify: null });
    for (const f of fs.readdirSync(inst.data)) if (/^wallet-/.test(f)) fs.rmSync(d(f), { force: true });
  }
});

test('R3 follow-up: a command-line deletion leaves a "gone" marker, so the running hub does not report it; a later unmarked deletion still is', async () => {
  const { execFileSync } = require('node:child_process');
  const { timers } = fakeTimers();
  journal.configure({ timers, notify: () => {} });
  journal._pending.clear();
  const f = path.join(inst.data, 'modules.json');
  rawWrite(f, '{"modules":{}}');
  const w = journal.startWatch({ dataDir: inst.data, intervalMs: 0 });
  const filesN = () => journal.list({ limit: 500 }).filter((e) => e.store === 'files' && e.key === 'files/modules.json').length;
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  const lib = JSON.stringify(path.join(inst.lib, 'settings-journal'));
  try {
    w.tick();
    const n0 = filesN();
    execFileSync(process.execPath, ['-e', `require(${lib}).startCliMarking({dataDir:${JSON.stringify(inst.data)}});require('fs').unlinkSync(${JSON.stringify(f)})`], { env });
    assert.ok(rawLines().some((l) => l.marker && l.store === 'files/modules.json' && l.stamp === 'gone'), 'a deletion marker');
    w.tick();
    assert.equal(filesN(), n0, 'the command\'s own deletion is not an outside edit');
    // the file comes back, the hub sees it, then a program deletes it without a marker: reported (the old marker is older than the last sighting)
    await new Promise((resolve) => setTimeout(resolve, 15));
    rawWrite(f, '{"modules":{"again":1}}'); w.tick();
    assert.equal(filesN(), n0 + 1, 'the recreation by a program is reported');
    execFileSync(process.execPath, ['-e', `require('fs').unlinkSync(${JSON.stringify(f)})`], { env });
    w.tick();
    assert.equal(filesN(), n0 + 2, 'an unmarked deletion is still reported');
  } finally {
    w.stop();
    journal.configure({ clock: Date.now, timers: { setTimeout, clearTimeout }, notify: null });
    try { fs.rmSync(f, { force: true }); } catch { /* gone */ }
  }
});

test('R3 follow-up: scripts/hub-token.js marks its writes to the protected files (users.json), so the running hub does not report them', () => {
  const { execFileSync } = require('node:child_process');
  const { timers } = fakeTimers();
  journal.configure({ timers, notify: () => {} });
  journal._pending.clear();
  const users = path.join(inst.data, 'users.json');
  rawWrite(users, JSON.stringify({ users: [] }));
  const w = journal.startWatch({ dataDir: inst.data, intervalMs: 0 });
  try {
    w.tick();
    const filesN = () => journal.list({ limit: 500 }).filter((e) => e.store === 'files').length;
    const n0 = filesN();
    // the script runs for real (list), then the same process writes users.json as a token command would
    const script = path.join(__dirname, '..', 'scripts', 'hub-token.js');
    const wrapper = `process.argv=[process.argv[0],${JSON.stringify(script)},'list','--data-dir',${JSON.stringify(inst.data)}];require(${JSON.stringify(script)});require('fs').writeFileSync(${JSON.stringify(users)},JSON.stringify({users:[],note:'token command'}));`;
    execFileSync(process.execPath, ['-e', wrapper], { env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    assert.ok(rawLines().some((l) => l.marker && l.store === 'files/users.json'), 'a marker line for users.json');
    w.tick();
    assert.equal(filesN(), n0, 'not an outside edit');
  } finally { w.stop(); journal.configure({ clock: Date.now, timers: { setTimeout, clearTimeout }, notify: null }); }
});

// ── Round 4: reconcile needs exact evidence (R4-2, R4-3); the watch sees what the hub wrote (R4-4) ──────────────
function tmpJournal() {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sj-r4-'));
  const file = path.join(dir, 'settings-journal.jsonl');
  const j = journal.createJournal({ file, clock: () => 4_100_000_000_000, notify: () => {}, timers: fakeTimers().timers });
  const lines = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const terminal = (id) => lines().filter((l) => l.commitOf === id || l.failedOf === id);
  return { dir, file, j, lines, terminal };
}

test('R4-2: a secret change (created, replaced, removed; live secret there or not) is never committed or failed by reconcile', () => {
  const t = tmpJournal();
  const key = 'providers.openai.apiKey';
  const made = [
    t.j.recordChange('settings', [{ key, before: undefined, after: 'sk-TEST-ONE-0001' }], { pending: true })[0],
    t.j.recordChange('settings', [{ key, before: 'sk-TEST-ONE-0001', after: 'sk-TEST-TWO-0002' }], { pending: true })[0],
    t.j.recordChange('settings', [{ key, before: 'sk-TEST-TWO-0002', after: undefined }], { pending: true })[0],
  ];
  for (const e of made) assert.equal(e.exactEvidence, false, 'a secret entry carries no exact evidence');
  for (const live of ['sk-TEST-TWO-0002', undefined, 'set', '']) {
    assert.deepEqual(t.j.reconcile({ read: () => live }), { committed: 0, failed: 0 });
  }
  for (const e of made) assert.deepEqual(t.terminal(e.id), [], 'still pending');
});

test('R4-2: a long value (equal byte length) and a value with a nested secret stripped stay pending', () => {
  const t = tmpJournal();
  const big1 = 'a'.repeat(MAX_BYTES + 10), big2 = 'b'.repeat(MAX_BYTES + 10);
  const e1 = t.j.recordChange('settings', [{ key: 'maxContextMessages', before: big1, after: big2 }], { pending: true })[0];
  assert.equal(e1.exactEvidence, false);
  assert.deepEqual(t.j.reconcile({ read: () => big2 }), { committed: 0, failed: 0 });
  const e2 = t.j.recordChange('settings', [{ key: 'webSearch', before: { keys: { brave: 'brave-TEST-KEY-1' }, on: true }, after: { on: true } }], { pending: true })[0];
  assert.equal(e2.exactEvidence, false, 'stripSecrets changed the value');
  assert.deepEqual(t.j.reconcile({ read: () => ({ on: true }) }), { committed: 0, failed: 0 });
  assert.deepEqual(t.terminal(e1.id), []); assert.deepEqual(t.terminal(e2.id), []);
});
const MAX_BYTES = journal.MAX_VALUE_BYTES;

test('R4-2: before equals after stays pending; a legacy pending entry without exactEvidence stays pending', () => {
  const t = tmpJournal();
  const same40 = t.j.recordChange('settings', [{ key: 'maxContextMessages', before: 40, after: 40 }], { pending: true })[0];
  t.j.append([{ id: 'sj-0123456789', at: 1, who: { kind: 'hub' }, store: 'settings', key: 'maxContextMessages', before: 40, after: 75, restorable: true, pending: true }]);
  assert.deepEqual(t.j.reconcile({ read: () => 40 }), { committed: 0, failed: 0 });
  assert.deepEqual(t.j.reconcile({ read: () => 75 }), { committed: 0, failed: 0 });
  assert.deepEqual(t.terminal(same40.id), []); assert.deepEqual(t.terminal('sj-0123456789'), []);
});

test('R4-2: three exact entries: live after commits, live before fails, anything else stays pending; a repeated pass adds nothing', () => {
  const t = tmpJournal();
  const mk = (key) => t.j.recordChange('settings', [{ key, before: 40, after: 75 }], { pending: true })[0];
  const [a, b, c] = ['maxContextMessages', 'maxToolRounds', 'otherSetting'].map(mk);
  assert.equal(a.exactEvidence, true);
  const live = { [a.key]: 75, [b.key]: 40, [c.key]: 60 };
  assert.deepEqual(t.j.reconcile({ read: (e) => live[e.key] }), { committed: 1, failed: 1 });
  assert.deepEqual(t.terminal(a.id).map((l) => Object.keys(l).find((k) => /Of$/.test(k))), ['commitOf']);
  assert.deepEqual(t.terminal(b.id).map((l) => Object.keys(l).find((k) => /Of$/.test(k))), ['failedOf']);
  assert.deepEqual(t.terminal(c.id), []);
  const n = t.lines().length;
  assert.deepEqual(t.j.reconcile({ read: (e) => live[e.key] }), { committed: 0, failed: 0 });
  assert.equal(t.lines().length, n, 'no duplicate terminal lines');
});

test('R4-3: a reading that throws leaves the entry pending; the next pass settles it', () => {
  const t = tmpJournal();
  const e = t.j.recordChange('settings', [{ key: 'maxContextMessages', before: 40, after: 75 }], { pending: true })[0];
  let calls = 0;
  const read = () => { if (calls++ === 0) throw new Error('unavailable'); return 75; };
  assert.deepEqual(t.j.reconcile({ read }), { committed: 0, failed: 0 });
  assert.deepEqual(t.terminal(e.id), []);
  assert.deepEqual(t.j.reconcile({ read }), { committed: 1, failed: 0 });
});

test('R4-3: a malformed settings.json never counts as an observed deletion; valid JSON without the field does', () => {
  const t = tmpJournal();
  const e = t.j.recordChange('settings', [{ key: 'maxContextMessages', before: 40, after: undefined }], { pending: true })[0];
  assert.equal(e.exactEvidence, true);
  fs.writeFileSync(path.join(t.dir, 'settings.json'), '{ not json');
  assert.deepEqual(t.j.reconcile(), { committed: 0, failed: 0 });
  assert.deepEqual(t.terminal(e.id), []);
  fs.writeFileSync(path.join(t.dir, 'settings.json'), '{}');
  assert.deepEqual(t.j.reconcile(), { committed: 1, failed: 0 });
});

test('R4-3: an unknown store and an unsupported prefs key stay pending, even with a reader that returns the proposed value', () => {
  const t = tmpJournal();
  const e1 = t.j.recordChange('widgets', [{ key: 'x.y', before: 1, after: 2 }], { pending: true })[0];
  const e2 = t.j.recordChange('prefs', [{ key: 'prefs.u_owner.someUnknown.thing', before: 'a', after: 'b' }], { pending: true })[0];
  assert.equal(e1.exactEvidence, true); assert.equal(e2.exactEvidence, true);
  assert.deepEqual(t.j.reconcile({ read: (e) => e.after }), { committed: 0, failed: 0 });
  assert.deepEqual(t.terminal(e1.id), []); assert.deepEqual(t.terminal(e2.id), []);
});

test('R4-3: a research choice stays pending while research-prefs.json is missing or malformed, and commits once the file shows it', () => {
  const t = tmpJournal();
  const e = t.j.recordChange('prefs', [{ key: 'prefs.u_owner.research.choice', before: 'ask', after: 'always' }], { pending: true })[0];
  assert.equal(e.exactEvidence, true);
  assert.deepEqual(t.j.reconcile(), { committed: 0, failed: 0 }, 'file missing');
  fs.writeFileSync(path.join(t.dir, 'research-prefs.json'), '{ broken');
  assert.deepEqual(t.j.reconcile(), { committed: 0, failed: 0 }, 'file malformed');
  fs.writeFileSync(path.join(t.dir, 'research-prefs.json'), JSON.stringify({ u_owner: { choice: 'always' } }));
  assert.deepEqual(t.j.reconcile(), { committed: 1, failed: 0 });
});

function watchSetup() {
  const { execFileSync } = require('node:child_process');
  const { timers } = fakeTimers();
  journal.configure({ timers, notify: () => {} });
  journal._pending.clear();
  const f = path.join(inst.data, 'research-prefs.json');
  fs.rmSync(f, { force: true });
  const w = journal.startWatch({ dataDir: inst.data, intervalMs: 0 });
  const filesN = () => journal.list({ limit: 500 }).filter((e) => e.store === 'files' && e.key === 'files/research-prefs.json').length;
  const outsideUnlink = () => execFileSync(process.execPath, ['-e', `require('fs').unlinkSync(${JSON.stringify(f)})`], { env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  const done = () => { w.stop(); journal.configure({ clock: Date.now, timers: { setTimeout, clearTimeout }, notify: null }); fs.rmSync(f, { force: true }); };
  return { f, w, filesN, outsideUnlink, done };
}

test('R4-4: a file created by the hub and deleted outside before the first tick gives exactly one outside-deletion entry', () => {
  const s = watchSetup();
  try {
    const n0 = s.filesN();
    fs.writeFileSync(s.f, '{}');
    s.outsideUnlink();
    s.w.tick(); s.w.tick();
    assert.equal(s.filesN(), n0 + 1);
  } finally { s.done(); }
});

test('R4-4: a file the hub created gives no outside-edit entry on later ticks, and the hub\'s own deletion stays quiet', () => {
  const s = watchSetup();
  try {
    const n0 = s.filesN();
    fs.writeFileSync(s.f, '{}');
    s.w.tick(); s.w.tick();
    assert.equal(s.filesN(), n0);
    fs.unlinkSync(s.f);
    s.w.tick();
    assert.equal(s.filesN(), n0);
  } finally { s.done(); }
});

test('R4-4: an old command-line deletion marker does not hide a newer outside deletion of a file the hub re-created', async () => {
  const s = watchSetup();
  try {
    const n0 = s.filesN();
    journal.append([{ marker: true, store: 'files/research-prefs.json', stamp: 'gone', at: Date.now() - 60_000 }]);
    await new Promise((resolve) => setTimeout(resolve, 15));
    fs.writeFileSync(s.f, '{"u":1}');
    s.outsideUnlink();
    s.w.tick();
    assert.equal(s.filesN(), n0 + 1, 'the old marker does not suppress the new deletion');
  } finally { s.done(); }
});

