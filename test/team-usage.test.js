'use strict';
// How agents were used (lib/team-usage.js): the counts-only summary from a temporary telemetry database, and the lead-only team_usage
// tool. Temp folders only; nothing under a real install's data/ is opened.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { makeIsolatedInstall, REAL } = require('./helpers/isolated-install');

const ISO = makeIsolatedInstall('team-usage-');
const tu = require(path.join(ISO.inst, 'lib', 'team-usage'));

const temps = [];
const tempDir = () => { const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'team-usage-t-')); temps.push(d); return d; };
after(() => { for (const d of temps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

// The requests table as lib/model-telemetry creates it (only the columns the summary reads matter).
function makeDb(rows) {
  const file = path.join(tempDir(), 'telemetry.db');
  const db = new Database(file);
  db.exec(`CREATE TABLE requests (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT DEFAULT (datetime('now')), model TEXT NOT NULL, agent TEXT, ok INTEGER NOT NULL, status INTEGER, error_class TEXT, error_msg TEXT, tool_count INTEGER DEFAULT 0)`);
  const ins = db.prepare('INSERT INTO requests (ts, model, agent, ok, tool_count, error_msg) VALUES (datetime(\'now\', ?), ?, ?, ?, ?, ?)');
  for (const r of rows) ins.run(r.ago || '-1 hours', r.model, r.agent, r.ok === false ? 0 : 1, r.tools || 0, r.msg || null);
  db.close();
  return file;
}
const agents = [
  { name: 'maestro', category: 'primary', lead: true },
  { name: 'scout', category: 'worker' },
  { name: 'kim_helper', category: 'primary', owner: 'u-member' },
  { name: 'ana_admin', category: 'specialist', owner: 'u-admin' },
];
const deps = (dbPath, over = {}) => ({ dbPath, agents, adminIds: new Set(['u-admin']), ...over });

test('usageSummary: per agent requests, failures, models and tool calls; temporary workers as one line; categories; members marked', () => {
  const f = makeDb([
    { agent: 'maestro', model: 'anthropic/big', tools: 5 }, { agent: 'maestro', model: 'anthropic/big', tools: 2 }, { agent: 'maestro', model: 'openai/small', ok: false },
    { agent: 'scout', model: 'openai/small', tools: 1 },
    { agent: 'kim_helper', model: 'openai/small', tools: 3, msg: 'SECRET CONVERSATION TEXT' },
    { agent: 'ana_admin', model: 'anthropic/big' },
    { agent: 'tw-maestro-1-ab12', model: 'openai/small' }, { agent: 'tw-maestro-2-cd34', model: 'openai/small' }, { agent: 'tw-kimhelper-3-ef56', model: 'anthropic/big', ok: false },
    { agent: 'maestro', model: 'old/model', ago: '-400 hours' },   // outside the last 7 days
  ]);
  const out = tu.usageSummary({ hours: 168 }, deps(f));
  assert.match(out, /last 7 days \(counts only\)/);
  assert.match(out, /- maestro \(primary\): 3 requests, 1 failed, 7 tool calls; models: anthropic\/big x2, openai\/small x1/);
  assert.match(out, /- scout \(worker\): 1 request, 0 failed, 1 tool call; models: openai\/small x1/);
  assert.match(out, /- kim_helper \(primary, member's agent\): 1 request, 0 failed, 3 tool calls/);
  assert.match(out, /- ana_admin \(specialist\): 1 request/, "an admin's own agent is not a member's");
  assert.doesNotMatch(out, /ana_admin \([^)]*member/);
  assert.match(out, /- temporary workers: 3 runs, 1 failed; models: openai\/small x2, anthropic\/big x1/);
  assert.doesNotMatch(out, /tw-/, 'temporary workers are not listed one by one');
  assert.doesNotMatch(out, /old\/model/);
  assert.doesNotMatch(out, /SECRET/, 'counts only: nothing of any message');
  assert.ok(out.length <= 3000);
  assert.match(tu.usageSummary({ hours: 24 }, deps(f)), /last 1 day /);
});

test('usageSummary: a section for long waits on workers when an agent has two and no build partner', () => {
  const f = makeDb([{ agent: 'ana_admin', model: 'anthropic/big' }]);
  const lwFile = path.join(tempDir(), 'long-waits.jsonl');
  const now = Date.now();
  const row = (agent, ago, minutes) => JSON.stringify({ at: new Date(now - ago).toISOString(), agent, tool: 'spawn_workers', minutes });
  fs.writeFileSync(lwFile, [row('ana_admin', 3600000, 12), row('ana_admin', 2 * 86400000, 31), row('maestro', 3600000, 20), row('maestro', 7200000, 20), row('kim_helper', 3600000, 12), row('kim_helper', 7200000, 12)].join('\n') + '\n');
  const isLead = (n) => n === 'maestro';
  const out = tu.usageSummary({ hours: 168 }, deps(f, { longWaitsFile: lwFile, isLead, zone: 'UTC' }));
  assert.match(out, /\nLong waits on workers \(this week, no build partner\):\n- ana_admin: 2 times, longest 31 min \(\d{4}-\d\d-\d\d(, \d{4}-\d\d-\d\d)?\)/);
  assert.match(out, /- kim_helper: 2 times, longest 12 min/, "a member's agent: counts only");
  assert.doesNotMatch(out, /- maestro: \d+ times/, 'a lead is not listed');
  assert.ok(out.length <= 3000);
  const none = tu.usageSummary({ hours: 168 }, deps(f, { longWaitsFile: path.join(tempDir(), 'none.jsonl'), isLead }));
  assert.doesNotMatch(none, /Long waits/);
});

test('usageSummary: no database or no rows is said plainly, never thrown', () => {
  assert.match(tu.usageSummary({}, deps(path.join(tempDir(), 'nope.db'))), /no requests recorded/);
  assert.match(tu.usageSummary({}, deps(makeDb([]))), /no requests recorded/);
  assert.match(tu.usageSummary({}, deps(makeDb([{ agent: 'x', model: 'm', ago: '-900 hours' }]))), /no requests recorded/);
  const bad = path.join(tempDir(), 'bad.db'); fs.writeFileSync(bad, 'not a database');
  assert.match(tu.usageSummary({}, deps(bad)), /no requests recorded/);
});

test('usageSummary: an injected open database is used and left open; the top 30 by requests, then "and N more"; at most about 3000 characters', () => {
  const rows = [];
  for (let i = 0; i < 45; i++) for (let k = 0; k <= i; k++) rows.push({ agent: `agent_${String(i).padStart(2, '0')}`, model: `m${i}`, tools: 1 });
  const f = makeDb(rows);
  const db = new Database(f, { readonly: true });
  const out = tu.usageSummary({ hours: 168 }, { db, agents: [], adminIds: new Set() });
  assert.doesNotThrow(() => db.prepare('select 1').get(), 'the caller\'s database stays open');
  db.close();
  assert.match(out, /- agent_44:/); assert.match(out, /- agent_15:/);
  assert.doesNotMatch(out, /- agent_14:/, 'the 15 quietest are cut');
  assert.match(out, /and 15 more/);
  assert.ok(out.length <= 3000, String(out.length));
  assert.ok(out.indexOf('agent_44') < out.indexOf('agent_43'), 'busiest first');
  // long model names squeeze the list under the cap with whole lines and an honest count
  const rows2 = [];
  for (let i = 0; i < 30; i++) for (let m = 0; m < 6; m++) rows2.push({ agent: `busy_${i}`, model: `provider-${m}/${'x'.repeat(40)}-${m}`, tools: 2 });
  const out2 = tu.usageSummary({}, deps(makeDb(rows2), { agents: [] }));
  assert.ok(out2.length <= 3000, String(out2.length));
  assert.match(out2, /and \d+ more$/m);
});

test('team_usage: a lead agent gets the summary; days are clamped to 1..30 and default to 7', () => {
  const f = makeDb([{ agent: 'maestro', model: 'm1' }, { agent: 'maestro', model: 'm1', ago: '-10 days' }, { agent: 'maestro', model: 'm1', ago: '-20 days' }]);
  const run = (args) => tu.runTeamUsage('maestro', args, deps(f, { isLead: (n) => n === 'maestro' }));
  assert.match(run({}), /last 7 days[\s\S]*maestro \(primary\): 1 request,/);
  assert.match(run({ days: 30 }), /last 30 days[\s\S]*3 requests/);
  assert.match(run({ days: 99 }), /last 30 days/); assert.match(run({ days: 0 }), /last 7 days/); assert.match(run({ days: 'x' }), /last 7 days/);
  assert.match(run({ days: 1 }), /last 1 day /);
});

test('team_usage refuses a non-lead, a member\'s agent (even flagged lead), an unknown caller, and a temporary worker of a non-lead', () => {
  const f = makeDb([{ agent: 'maestro', model: 'm1' }]);
  const refused = /Only a lead agent may use this/;
  const lead = (n) => n === 'maestro' || n === 'kim_helper';   // kim_helper is flagged a lead but is a member's agent
  const parents = { 'tw-a': 'scout', 'tw-b': 'maestro', 'tw-c': 'kim_helper', 'tw-check': null };
  const d = deps(f, { isLead: lead, parentOf: (n) => (n in parents ? parents[n] : undefined) });
  assert.match(tu.runTeamUsage('scout', {}, d), refused, 'a worker is not a lead');
  assert.match(tu.runTeamUsage('kim_helper', {}, d), refused, "a member's agent never");
  assert.match(tu.runTeamUsage('nobody', {}, d), refused);
  assert.match(tu.runTeamUsage('tw-a', {}, d), refused, "a temporary worker of a non-lead");
  assert.match(tu.runTeamUsage('tw-c', {}, d), refused, "a temporary worker of a member's agent");
  assert.match(tu.runTeamUsage('tw-check', {}, d), refused, 'a hub-internal check agent has no parent');
  assert.match(tu.runTeamUsage('maestro', {}, d), /counts only/);
  assert.match(tu.runTeamUsage('tw-b', {}, d), /counts only/, 'a temporary worker counts as its parent');
  assert.match(tu.runTeamUsage('maestro', {}, { ...d, parentOf: () => { throw new Error('boom'); } }), refused, 'fails closed');
});

test('team_usage is registered on the SDK and the gateway/Codex tool lists, with the lead-only description, and classified as a read', () => {
  const sdk = fs.readFileSync(path.join(REAL, 'lib', 'sdk-chat.js'), 'utf8');
  assert.match(sdk, /name: teamUsageLib\.TOOL_NAME,\n\s+description: teamUsageLib\.TOOL_DESCRIPTION,[\s\S]{0,300}handler: async \(args\) => handleTeamUsage\(agentName, args \|\| \{\}\)/, 'gateway (the list Codex shares through the bridge)');
  assert.match(sdk, /sdk\.tool\(teamUsageLib\.TOOL_NAME, teamUsageLib\.TOOL_DESCRIPTION,[\s\S]{0,200}handleTeamUsage\(agentName, args\)/, 'the SDK server');
  assert.strictEqual(tu.TOOL_NAME, 'team_usage');
  assert.strictEqual(tu.TOOL_DESCRIPTION, 'Lead only: how agents were used over the last days (requests per agent and model, failures, temporary workers), counts only. For deciding whether a permanent worker would help.');
  assert.match(sdk, /async function handleTeamUsage\(agentName, args\) \{[\s\S]{0,400}isLead: isLeadAgent[\s\S]{0,300}temporalWorkers\.getVirtual\(n\)/);
  const set = fs.readFileSync(path.join(REAL, 'lib', 'tool-policy.js'), 'utf8');
  assert.match(set, /const HUB_READ = new Set\([^;]*'team_usage'/);
  assert.doesNotMatch(set, /HUB_(WRITE_INSIDE|DELEGATE) = new Set\([^;]*'team_usage'/);
});

// Review r1 (Sonnet F2): team_usage appears in a tool list only for an admin-side lead and only while worker-proposals is on.
test('r1: team_usage is offered only to an admin-side lead while worker-proposals is on, on both tool paths', () => {
  const sdk = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.strictEqual((sdk.match(/\.\.\.\(teamUsageOffered\(agentName\) \? \[/g) || []).length, 2, 'gateway/Codex list and SDK tools');
  assert.match(sdk, /function teamUsageOffered\(agentName\) \{\n\s+try \{\n\s+if \(!require\('\.\/behaviour-changes'\)\.isOn\('worker-proposals'\)\) return false;/);
});
