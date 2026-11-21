'use strict';
// Simple mode, part S: per-person page mode and theme (auth + /api/me + POST /api/me/prefs) and the per-turn reasoning level.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('simple-prefs-iso-');
const L = (p) => require(path.join(ISO.lib, p));
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const tmpDirs = [];
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function mkAuth() {
  const dir = tmp('simple-prefs-');
  const auth = L('auth').createAuth({ dataDir: dir, log: () => {} });
  const owner = auth.createUser({ login: 'owner@example.com', name: 'Owner', role: 'admin', password: 'correct-horse-battery-9' }).user;
  const sam = auth.createUser({ login: 'sam@example.com', name: 'Sam', role: 'member', password: 'correct-horse-battery-9' }).user;
  return { dir, auth, owner, sam };
}

test('auth: nothing saved by default; setPrefs saves, keeps the other value, and is kept in the users file', () => {
  const { dir, auth, sam } = mkAuth();
  assert.deepStrictEqual([sam.uiMode, sam.theme], [null, null]);
  const r1 = auth.setPrefs(sam.id, { uiMode: 'advanced' });
  assert.deepStrictEqual([r1.ok, r1.user.uiMode, r1.user.theme], [true, 'advanced', null]);
  const r2 = auth.setPrefs(sam.id, { theme: 'light' });
  assert.deepStrictEqual([r2.user.uiMode, r2.user.theme], ['advanced', 'light']);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf8')).users.find(u => u.id === sam.id);
  assert.deepStrictEqual([saved.uiMode, saved.theme], ['advanced', 'light']);
  assert.strictEqual(auth.getUser(sam.id).uiMode, 'advanced');
});

test('auth: strict values; nothing changes on a refusal', () => {
  const { auth, sam } = mkAuth();
  auth.setPrefs(sam.id, { uiMode: 'simple', theme: 'dark' });
  for (const bad of [{ uiMode: 'expert' }, { uiMode: 1 }, { uiMode: null }, { theme: 'blue' }, { theme: '' }, { uiMode: 'advanced', theme: 'pink' }, {}, null]) {
    const r = auth.setPrefs(sam.id, bad);
    assert.strictEqual(r.ok, false, JSON.stringify(bad));
    assert.ok(/\.$/.test(r.error), 'a plain sentence');
  }
  const u = auth.getUser(sam.id);
  assert.deepStrictEqual([u.uiMode, u.theme], ['simple', 'dark']);
  assert.strictEqual(auth.setPrefs('nobody', { uiMode: 'simple' }).ok, false);
});

test('server: /api/me returns uiMode (stored, else by role) and theme (stored, else auto)', () => {
  const s = read('server.js');
  assert.match(s, /out\.uiMode = \(u && u\.uiMode\) \|\| \(isAdmin \? 'advanced' : 'simple'\);/);
  assert.match(s, /out\.theme = \(u && u\.theme\) \|\| 'auto';/);
});

test('server: POST /api/me/prefs is for a signed-in person only and answers with the new values', () => {
  const s = read('server.js');
  const i = s.indexOf("pathname === '/api/me/prefs'");
  assert.ok(i > 0);
  const block = s.slice(i, s.indexOf("// This person's time zone", i));
  assert.match(block, /!req\.hubUser \|\| req\.hubService \|\| req\.hubToken \|\| req\.hubPendingTotp\) return jsonResponse\(res, 401/, 'signed out, the hub itself, tokens and half-signed-in sessions are refused');
  assert.match(block, /hubAuth\.setPrefs\(req\.hubUser\.id, /, 'only ever the caller\'s own record');
  assert.match(block, /jsonResponse\(res, 400, \{ error: r\.error \}\)/);
  assert.match(block, /jsonResponse\(res, 200, \{ ok: true, uiMode: /);
  assert.strictEqual(L('access').classifyRoute('/api/me/prefs', 'POST').kind, 'session', 'a member may reach it');
});

test('there is no self-serve name change: only the admin user route sets a name', () => {
  const s = read('server.js');
  assert.ok(!/\/api\/me\/(name|profile)/.test(s));
});

test('effort: a per-turn level replaces the agent\'s, capped by the model, ignored where the model has no levels', () => {
  const e = L('effort');
  assert.deepStrictEqual(e.TURN_LEVELS, ['low', 'medium', 'high', 'max']);
  assert.strictEqual(e.forTurn('claude-sdk/claude-opus-5-5', 'low', 'max'), 'low', 'replaces the stored level');
  assert.strictEqual(e.forTurn('claude-sdk/claude-opus-5-5', 'MAX', 'default'), 'max');
  assert.strictEqual(e.forTurn('claude-sdk/claude-opus-5-5', undefined, 'high'), 'high', 'no request: the agent\'s setting');
  assert.strictEqual(e.forTurn('claude-sdk/claude-opus-5-5', undefined, 'default'), null, 'no request, default: nothing sent (hub-started turns unchanged)');
  assert.strictEqual(e.forTurn('claude-sdk/claude-opus-5-5', 'xhigh', 'medium'), 'medium', 'not one of the four: ignored');
  assert.strictEqual(e.forTurn('claude-sdk/claude-opus-5-5', 'turbo', 'medium'), 'medium');
  assert.strictEqual(e.forTurn('claude-sdk/claude-opus-5-5', { a: 1 }, 'medium'), 'medium');
  assert.strictEqual(e.forTurn('openai/gpt-5.5', 'max', 'low'), 'xhigh', 'never above what the model takes');
  assert.strictEqual(e.forTurn('codex-cli/gpt-6-astra', 'max', 'low'), 'max', 'Deepest reaches max where the model has it');
  assert.strictEqual(e.forTurn('google/gemini-flash-latest', 'max', 'low'), 'high');
  assert.strictEqual(e.forTurn('ninfer/qwen3.8-27b', 'max', 'low'), null, 'a model with no levels: nothing, the request is ignored');
  assert.strictEqual(e.forTurn('openai/gpt-4.1', 'high', 'default'), null);
  assert.strictEqual(e.requestedLevel('high'), 'high');
  assert.strictEqual(e.requestedLevel('default'), null);
});

test('chat route: the body\'s effort reaches the Claude, Codex and gateway sites for this turn only', () => {
  const c = read('lib/sdk-chat.js');
  assert.ok(c.includes('const turnEffortAsked = body.effort;'));
  assert.strictEqual((c.match(/effort: turnEffortAsked,/g) || []).length, 3, 'Codex, Claude client and gateway options');
  assert.ok(c.includes("effortLib.forTurn(`claude-sdk/${sdkModel}`, options.effort, await agentEffort(agentName))"));
  assert.ok(c.includes('effortLib.forTurn(agentModel, options.effort, await agentEffort(agentName))'));
  assert.match(c, /if \(options && options\.effort\) \{ const asked = effortLib\.requestedLevel\(options\.effort\); if \(asked && effortLib\.supported\(model\)\) turnEffort = asked; \}/);
  // the stored agent setting is only read, never written, from the request
  assert.ok(!/updateAgent\([^)]*turnEffortAsked/.test(c));
});
