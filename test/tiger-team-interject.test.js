'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

/** Slice the /api/tiger-team/inject route out of server.js and run it against fakes. */
function load({ running = ['alice', 'bob'], active = ['alice', 'bob'] } = {}) {
  const state = { id: 'tt', coordinator: 'coord', pendingMessages: [], calls: {
    'coord-call': { key: 'coord-call', agent: 'coord', status: 'running' },
    'a-call': { key: 'a-call', agent: 'alice', status: running.includes('alice') ? 'running' : 'completed' },
    'b-call': { key: 'b-call', agent: 'bob', status: running.includes('bob') ? 'running' : 'completed' },
  } };
  const writes = [], interjections = [], appended = [];
  const session = { tigerTeamId: 'tt', pendingMessages: state.pendingMessages, res: { destroyed: false, writableEnded: false, write: s => writes.push(s) } };
  const ctx = {
    console: { log() {} }, JSON, Object, Set, String, Array, Date,
    require: (m) => m === './lib/sdk-chat' ? { isAgentActive: a => active.includes(a), handleInterjection: ({ agent, message }) => { interjections.push({ agent, message }); return { success: true }; } }
      : m === './lib/tiger-team-live' ? require('../lib/tiger-team-live') : require(m),
    readBody: async req => JSON.stringify(req.body), global: { __tigerTeamSessions: { tt: session } },
    getTigerTeamState: id => id === 'tt' ? state : null, ttRecovery: require('../lib/tiger-team-recovery'),
    ttStore: { save() {}, append: (id, st, ev) => appended.push(ev) },
    jsonResponse: (res, status, body) => { res.status = status; res.body = body; },
    ttValidId: require('../lib/tiger-team-recovery').validId, activeTigerTeams: new Map(),
    getAgents: async () => [{ name: 'alice', display: 'Alice Writer' }, { name: 'bob', display: 'Bob' }],
  };
  vm.createContext(ctx);
  // The war-room helpers (ttLive, ttNewStream, ttTeamOf) as server.js defines them.
  const helpers = source.slice(source.indexOf('// A run writes to its own stream'), source.indexOf('// ── Setup Detection'));
  vm.runInContext(helpers.replace(/^const /gm, 'var '), ctx);
  const start = source.indexOf("    if (pathname === '/api/tiger-team/inject' && req.method === 'POST') {");
  const end = source.indexOf('    // Tiger Team update participants', start);
  assert.ok(start > 0 && end > start, 'inject route not found in server.js');
  vm.runInContext('this.route = async (pathname, req, res) => {' + source.slice(start, end) + '};', ctx);
  // Values built inside the vm realm have foreign prototypes; normalise before strict comparisons.
  const call = async (body) => { const res = {}; await ctx.route('/api/tiger-team/inject', { method: 'POST', body: { session_id: 'tt', ...body } }, res); res.body = JSON.parse(JSON.stringify(res.body)); return res; };
  return { call, state, writes, interjections, appended: { get 0() { return JSON.parse(JSON.stringify(appended[0])); }, get length() { return appended.length; } } };
}

test('team target: coordinator queued durably, every running participant gets it live, all journaled and announced', async () => {
  const h = load();
  const res = await h.call({ message: 'Focus on the auth service only' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.delivered, [{ agent: 'coord', how: 'queued' }, { agent: 'alice', how: 'live' }, { agent: 'bob', how: 'live' }]);
  assert.deepEqual(h.state.pendingMessages, ['Focus on the auth service only'], 'coordinator picks it up before its next model call');
  assert.deepEqual(h.interjections.map(i => i.agent), ['alice', 'bob']);
  assert.match(h.interjections[0].message, /^\[Interjection from the war room, addressed to the whole team\]: Focus/);
  assert.equal(h.appended[0].type, 'tt_interjection'); assert.equal(h.appended[0].target, 'team');
  assert.match(h.writes[0], /"type":"tt_user_message"/); assert.match(h.writes[0], /"delivered":\[/);
});

test('coordinator-only target touches no participant; a busy-elsewhere or finished participant is not interrupted', async () => {
  const h = load({ running: ['alice'], active: ['alice', 'bob'] });
  const res = await h.call({ message: 'x', target: 'coordinator' });
  assert.deepEqual(res.body.delivered, [{ agent: 'coord', how: 'queued' }]); assert.equal(h.interjections.length, 0);
  const t = await h.call({ message: 'y' });
  assert.deepEqual(t.body.delivered.map(d => d.agent), ['coord', 'alice'], 'bob finished its call: not interrupted even though active elsewhere');
});

test('a named participant gets it live only while working; otherwise 409 with advice; empty message 400', async () => {
  const h = load({ running: ['alice'] });
  const ok = await h.call({ message: 'alice: check the logs', target: 'alice' });
  assert.deepEqual(ok.body.delivered, [{ agent: 'alice', how: 'live' }]); assert.deepEqual(h.state.pendingMessages, [], 'not queued for the coordinator');
  const no = await h.call({ message: 'bob?', target: 'bob' }); assert.equal(no.status, 409); assert.match(no.body.error, /not working right now/);
  const empty = await h.call({ message: '' }); assert.equal(empty.status, 400);
});

test('a team that has ended answers 409 "This team is not running." and nothing is delivered or queued', async () => {
  const h = load();
  h.state.completedAt = Date.now();   // completed, stopped, failed or interrupted: the run is over
  for (const target of ['team', 'coordinator', 'alice']) {
    const res = await h.call({ message: 'hello?', target });
    assert.equal(res.status, 409); assert.equal(res.body.error, 'This team is not running.');
  }
  assert.deepEqual(h.state.pendingMessages, []); assert.equal(h.interjections.length, 0); assert.equal(h.appended.length, 0);
  assert.equal(h.writes.length, 0);
});

test('a message to one member is labelled with that member, not "the whole team"', async () => {
  const h = load();
  await h.call({ message: 'check the logs', target: 'alice' });
  assert.equal(h.interjections.length, 1);
  assert.equal(h.interjections[0].message, '[Interjection from the war room, addressed to Alice Writer]: check the logs');
  const t = await h.call({ message: 'all hands' });
  assert.match(t.body.delivered.length ? h.interjections[1].message : '', /^\[Interjection from the war room, addressed to the whole team\]: all hands/);
});

/** The /api/tiger-team/stop route run against fakes. */
function loadStop({ stopped }) {
  const session = { tigerTeamId: 'tt', stopped: false };
  const stops = [];
  const ctx = {
    console: { log() {} }, JSON, Object, String,
    require, readBody: async req => JSON.stringify(req.body), global: { __tigerTeamSessions: { s1: session } },
    ttTeamOf: body => body.tiger_team_id || null,
    stopTigerTeam: id => { stops.push(id); return stopped; },
    jsonResponse: (res, status, body) => { res.status = status; res.body = body; },
  };
  vm.createContext(ctx);
  const start = source.indexOf("    if (pathname === '/api/tiger-team/stop' && req.method === 'POST') {");
  const end = source.indexOf('    // Tiger Team save (manual', start);
  assert.ok(start > 0 && end > start, 'stop route not found in server.js');
  vm.runInContext('this.route = async (pathname, req, res) => {' + source.slice(start, end) + '};', ctx);
  return { stops, call: async body => { const res = {}; await ctx.route('/api/tiger-team/stop', { method: 'POST', body }, res); return { status: res.status, body: JSON.parse(JSON.stringify(res.body)) }; } };
}

test('Stop answers 409 "This team has already ended." when nothing was stopped, 200 when something was', async () => {
  const done = loadStop({ stopped: false });
  const no = await done.call({ session_id: 's1', tiger_team_id: 'tt' });
  assert.equal(no.status, 409); assert.equal(no.body.error, 'This team has already ended.');
  assert.deepEqual(done.stops, ['tt']);
  const live = loadStop({ stopped: true });
  const yes = await live.call({ session_id: 's1', tiger_team_id: 'tt' });
  assert.equal(yes.status, 200); assert.deepEqual(yes.body, { ok: true });
});

test('the war room shows those sentences and keeps the target list in step with the team', () => {
  const html = fs.readFileSync(path.join(__dirname, '../tiger-team.html'), 'utf8');
  assert.match(html, /r\.status === 409\) addSystemMsg\(\(await r\.json\(\)\.catch\(\(\) => \(\{\}\)\)\)\.error \|\| 'This team has already ended\.'\)/);
  assert.match(html, /if \(!ir\.ok\) \{ st\.textContent = '✗ ' \+ \(ij\.error/, 'the inject error sentence is shown on the card');
});

test('the war room labels the control as Interject and shows pickup acknowledgements', () => {
  const html = fs.readFileSync(path.join(__dirname, '../tiger-team.html'), 'utf8');
  assert.match(html, /id="interject-target"/); assert.match(html, />Interject<\/button>/);
  assert.match(html, /case 'interjection_received'/); assert.match(html, /picked it up/);
  const loop = fs.readFileSync(path.join(__dirname, '../lib/sdk-chat.js'), 'utf8');
  assert.match(loop, /type: 'interjection_received', agent: agentName, role: 'coordinator'/, 'coordinator pickup of war-room messages is acknowledged');
});
