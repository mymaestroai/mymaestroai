'use strict';
// The "Set up your team" card for existing installs: lib/team-card (cardState, answerCard), the ledger fields it keeps
// (cardAnsweredAt, offers), the admin-only routes, and setAgentModel clearing teamModelBy on a manual model change.
// Runs on a throwaway install (test/helpers/isolated-install.js); nothing under the real data/ is read or written.
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeIsolatedInstall, REAL } = require('./helpers/isolated-install');

const ISO = makeIsolatedInstall('team-card-');
const INST = ISO.inst;
const AGENTS_FILE = path.join(INST, 'data', 'agents.json');
const LEDGER = path.join(INST, 'data', 'team.json');
const L = (p) => require(path.join(INST, 'lib', p));
const card = L('team-card');
const st = L('starter-team');
const agentsLib = L('agents.js');
const access = L('access');

const AVAILABLE = ['claude-sdk/claude-opus-5-5', 'claude-sdk/claude-sonnet-5-5', 'claude-sdk/claude-haiku-5-5'];
const LEAD = 'claude-sdk/claude-opus-5-5';
const maestro = { name: 'maestro', model: LEAD, display: 'Maestro', category: 'primary', lead: true };
const mk = (over = {}) => ({ getAgents: async () => [maestro], getAvailableModels: async () => AVAILABLE, welcomeUnfinished: () => false, team: st, ...over });
const writeLedger = (doc) => fs.writeFileSync(LEDGER, typeof doc === 'string' ? doc : JSON.stringify(doc));
const readLedgerFile = () => JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
const created = (name) => ({ name, model: 'claude-sdk/claude-haiku-5-5', status: 'created', createdAt: '2026-01-01T00:00:00.000Z' });

beforeEach(() => { try { fs.unlinkSync(LEDGER); } catch {} });
after(() => { try { fs.rmSync(path.dirname(INST), { recursive: true, force: true }); } catch {} });

test('cardState: a plain existing install is shown the card with a plan to create', async () => {
  const r = await card.cardState({}, mk());
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.show, true);
  assert.strictEqual(r.body.reason, null);
  assert.deepStrictEqual(r.body.plan.map((e) => e.role), ['challenger', 'scout', 'builder', 'researcher']);
  assert.ok(r.body.plan.every((e) => e.action === 'create' && e.model));
});

test('cardState: every reason it stays away', async () => {
  // unreadable (also with again)
  writeLedger('{ not json');
  for (const again of [false, true]) {
    const r = await card.cardState({ again }, mk());
    assert.deepStrictEqual([r.body.show, r.body.reason], [false, 'unreadable'], `again=${again}`);
  }
  // a role recorded: "set up"
  writeLedger({ roles: { challenger: created('challenger') } });
  const set = await card.cardState({}, mk());
  assert.deepStrictEqual([set.body.show, set.body.reason], [false, 'set up']);
  // answered / skipped
  writeLedger({ roles: {}, cardAnsweredAt: '2026-01-02T00:00:00.000Z' });
  assert.deepStrictEqual((({ show, reason }) => [show, reason])((await card.cardState({}, mk())).body), [false, 'answered']);
  writeLedger({ roles: {}, skippedAt: '2026-01-02T00:00:00.000Z' });
  assert.deepStrictEqual((({ show, reason }) => [show, reason])((await card.cardState({}, mk())).body), [false, 'answered']);
  // the Welcome setup is unfinished: the Welcome page offers the team instead (also with again)
  fs.unlinkSync(LEDGER);
  for (const again of [false, true]) {
    const r = await card.cardState({ again }, mk({ welcomeUnfinished: () => true }));
    assert.deepStrictEqual([r.body.show, r.body.reason], [false, 'welcome'], `again=${again}`);
  }
  // nothing to create: no model reachable (also with again)
  for (const again of [false, true]) {
    const r = await card.cardState({ again }, mk({ getAvailableModels: async () => [], getAgents: async () => [{ ...maestro, model: 'codex/x' }] }));
    assert.deepStrictEqual([r.body.show, r.body.reason], [false, 'nothing to create'], `again=${again}`);
  }
});

test('cardState again=1: ignores the answer and a skip, and offers only what can still be created when some roles exist', async () => {
  writeLedger({ roles: {}, cardAnsweredAt: '2026-01-02T00:00:00.000Z', skippedAt: '2026-01-03T00:00:00.000Z' });
  const r = await card.cardState({ again: true }, mk());
  assert.strictEqual(r.body.show, true);
  writeLedger({ roles: { challenger: created('challenger') }, cardAnsweredAt: '2026-01-02T00:00:00.000Z' });
  const some = await card.cardState({ again: true }, mk());
  assert.strictEqual(some.body.show, true);
  assert.deepStrictEqual(some.body.plan.filter((e) => e.action === 'create').map((e) => e.role), ['scout', 'builder', 'researcher']);
  assert.strictEqual(some.body.plan[0].reason, 'created before');
  // every role recorded and nothing left to create: still not shown
  writeLedger({ roles: { challenger: created('challenger'), scout: created('scout'), builder: created('builder'), researcher: created('researcher') } });
  const all = await card.cardState({ again: true }, mk());
  assert.deepStrictEqual([all.body.show, all.body.reason], [false, 'nothing to create']);
});

test('answerCard: records cardAnsweredAt and keeps roles, skippedAt and offers', async () => {
  const doc = { roles: { challenger: created('challenger') }, skippedAt: '2026-01-02T00:00:00.000Z', offers: { challenger: { model: 'openai/gpt-x', since: '2026-01-05T00:00:00.000Z' } } };
  writeLedger(doc);
  const r = await card.answerCard({ answer: 'later' }, mk());
  assert.deepStrictEqual([r.status, r.body.ok], [200, true]);
  const after = readLedgerFile();
  assert.match(after.cardAnsweredAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepStrictEqual(after.roles, doc.roles);
  assert.strictEqual(after.skippedAt, doc.skippedAt);
  assert.deepStrictEqual(after.offers, doc.offers);
  assert.strictEqual(st.readLedger().cardAnsweredAt, after.cardAnsweredAt, 'readLedger carries it');
  // no ledger yet: it is made with the answer
  fs.unlinkSync(LEDGER);
  assert.strictEqual((await card.answerCard({ answer: 'later' }, mk())).status, 200);
  assert.deepStrictEqual(Object.keys(readLedgerFile()).sort(), ['cardAnsweredAt', 'roles']);
  // and the card is gone afterwards
  assert.strictEqual((await card.cardState({}, mk())).body.reason, 'answered');
});

test('answerCard: another answer is 400; an unreadable ledger is 409 and the file is not touched', async () => {
  for (const answer of [undefined, 'never', 'LATER', 5]) assert.strictEqual((await card.answerCard({ answer }, mk())).status, 400, String(answer));
  assert.ok(!fs.existsSync(LEDGER), '400 writes nothing');
  const bad = '{ "roles": 5 }';
  writeLedger(bad);
  const r = await card.answerCard({ answer: 'later' }, mk());
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.ok, false);
  assert.strictEqual(fs.readFileSync(LEDGER, 'utf8'), bad);
});

test('the ledger carries cardAnsweredAt and offers through write and read, and still accepts one without them', () => {
  const f = path.join(path.dirname(LEDGER), 'carry.json');
  const doc = { roles: { scout: created('scout') }, cardAnsweredAt: '2026-01-02T00:00:00.000Z', offers: { scout: { model: 'x/y', since: '2026-01-03T00:00:00.000Z' } } };
  st.writeLedger(doc, f);
  assert.deepStrictEqual(st.readLedger(f), doc);
  st.writeLedger({ roles: {} }, f);
  assert.deepStrictEqual(st.readLedger(f), { roles: {} });
  fs.writeFileSync(f, JSON.stringify({ roles: { scout: { status: 'created' } } }));
  assert.strictEqual(st.readLedger(f).unreadable, true, 'still strict about roles');
  fs.writeFileSync(f, JSON.stringify({ roles: {}, cardAnsweredAt: 5, offers: [] }));
  assert.deepStrictEqual(st.readLedger(f), { roles: {} }, 'wrong types are dropped, not trusted');
});

test('routes: /api/team/card and /api/team/card/answer are admin routes, wired in server.js, and the page script is served', () => {
  for (const [p, m] of [['/api/team/card', 'GET'], ['/api/team/card/answer', 'POST']]) assert.deepStrictEqual(access.classifyRoute(p, m), { kind: 'admin' }, `${m} ${p}`);
  const server = fs.readFileSync(path.join(REAL, 'server.js'), 'utf8');
  assert.match(server, /pathname === '\/api\/team\/card' && req\.method === 'GET'/);
  assert.match(server, /pathname === '\/api\/team\/card\/answer' && req\.method === 'POST'/);
  assert.match(server, /require\('\.\/lib\/team-card'\)\.cardState\(\{ again: [^}]*get\('again'\) === '1' \}\)/);
  assert.match(server, /require\('\.\/lib\/team-card'\)\.answerCard\(\{ answer: b\.answer \}\)/);
  const sf = require(path.join(INST, 'lib', 'static-files'));
  assert.strictEqual(sf.resolve('/ui-team-card.js', REAL), fs.realpathSync(path.join(REAL, 'lib', 'ui-team-card.js')));
  for (const page of ['index.html', 'mobile.html']) {
    const html = fs.readFileSync(path.join(REAL, page), 'utf8');
    assert.ok(html.includes('<script src="/ui-team-card.js"></script>'), page);
    assert.ok(html.indexOf('/ui-file-card.js') < html.indexOf('/ui-team-card.js'), `${page}: next to the file card`);
  }
});

test('setAgentModel clears teamModelBy only when the model really changes', async () => {
  const seed = () => fs.writeFileSync(AGENTS_FILE, JSON.stringify([maestro, { name: 'scout', model: 'claude-sdk/claude-haiku-5-5', display: 'Scout', category: 'worker', teamRole: 'worker', teamModelBy: 'hub' }], null, 2));
  const scout = () => JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')).find((a) => a.name === 'scout');
  seed();
  assert.deepStrictEqual(await agentsLib.setAgentModel('scout', 'claude-sdk/claude-haiku-5-5'), { success: true });
  assert.strictEqual(scout().teamModelBy, 'hub', 'the same model leaves it');
  assert.deepStrictEqual(await agentsLib.setAgentModel('scout', 'claude-sdk/claude-sonnet-5-5'), { success: true });
  assert.strictEqual(scout().model, 'claude-sdk/claude-sonnet-5-5');
  assert.ok(!('teamModelBy' in scout()), 'a manual change removes it');
  assert.strictEqual(scout().teamRole, 'worker', 'nothing else is touched');
});

// Review r1 (Sonnet follow-up): the cheap reasons end the check before any model list is asked for (a page load on an
// install that answered the card never lists the providers' models).
test('r1: answered, set up, unreadable and unfinished Welcome never ask for the model list', async () => {
  const noList = { getAvailableModels: async () => { throw new Error('must not be asked'); }, getAgents: async () => { throw new Error('must not be asked'); } };
  writeLedger({ roles: {}, cardAnsweredAt: '2026-01-01T00:00:00.000Z' });
  assert.strictEqual((await card.cardState({}, mk(noList))).body.reason, 'answered');
  writeLedger({ roles: { scout: { name: 'scout', status: 'created' } } });
  assert.strictEqual((await card.cardState({}, mk(noList))).body.reason, 'set up');
  writeLedger('{ not json');
  assert.strictEqual((await card.cardState({}, mk(noList))).body.reason, 'unreadable');
  writeLedger({ roles: {} });
  assert.strictEqual((await card.cardState({}, mk({ ...noList, welcomeUnfinished: () => true }))).body.reason, 'welcome');
});
