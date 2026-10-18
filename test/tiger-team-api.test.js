'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../tiger-team.html'), 'utf8');
function load(run) {
  const state = { id: 'tt', status: 'interrupted', completedAt: 1, coordinator: 'coord' };
  const ctx = { require, console, path, fs, ttRecovery: require('../lib/tiger-team-recovery'), __dirname: path.join(__dirname, '..'), global: {},
    readBody: async req => JSON.stringify(req.body), ttValidId: id => /^[a-zA-Z0-9_-]+$/.test(id),
    getTigerTeamState: id => id === 'tt' ? state : null,
    resumeTigerTeam: run || (async () => { state.status = 'completed'; }),
    continueTigerTeam: async () => {}, reconstituteTigerTeam: () => {},
    stopTigerTeam: () => { state.status = 'stopping'; }, ttStore: { save() {} },
    jsonResponse: (res, status, body) => { res.status = status; res.body = body; },
    setInterval: () => 1, clearInterval() {},
  };
  vm.createContext(ctx);
  const start = source.indexOf("    if (['/api/tiger-team/continue', '/api/tiger-team/resume']");
  const end = source.indexOf('    // Store TT launch params', start);
  vm.runInContext('this.route = async (pathname, req, res) => {' + source.slice(start, end) + '};', ctx);
  function response() {
    const res = new EventEmitter(); res.writes = []; res.writeHead = n => { res.status = n; };
    res.write = s => { res.writes.push(s); return true; }; res.end = () => { res.writableEnded = true; res.emit('close'); }; return res;
  }
  return { ctx, state, response, req: { method: 'POST', body: { session_id: 'tt' } } };
}
test('API reserves before execution and rejects duplicate Resume with 409', async () => {
  let release; const h = load(() => new Promise(r => release = r));
  const firstRes = h.response(); const first = h.ctx.route('/api/tiger-team/resume', h.req, firstRes);
  while (!release) await new Promise(r => setImmediate(r));
  const secondRes = h.response(); await h.ctx.route('/api/tiger-team/resume', h.req, secondRes);
  assert.equal(secondRes.status, 409); release(); await first;
  assert.equal(h.state.apiReserved, false);
});
test('normal SSE close does not cancel completed work', async () => {
  const h = load(); const res = h.response(); await h.ctx.route('/api/tiger-team/resume', h.req, res);
  assert.equal(res.status, 200); assert.equal(h.state.status, 'completed');
});
test('unexpected response disconnect requests targeted stop', async () => {
  let release; const h = load(() => new Promise(r => release = r)); const res = h.response();
  const run = h.ctx.route('/api/tiger-team/resume', h.req, res);
  while (!release) await new Promise(r => setImmediate(r));
  res.emit('close'); assert.equal(h.state.status, 'stopping'); release(); await run;
});
test('completed team requires Continue, not Resume', async () => {
  const h = load(); h.state.status = 'completed'; const res = h.response();
  await h.ctx.route('/api/tiger-team/resume', h.req, res); assert.equal(res.status, 409);
});
test('bad IDs are rejected before touching disk', async () => {
  const h = load(); const res = h.response(); h.req.body.session_id = '../secret';
  await h.ctx.route('/api/tiger-team/resume', h.req, res); assert.equal(res.status, 400);
});
test('runtime failure clears reservation and emits interruption, never completion', async () => {
  const h = load(async () => { throw new Error('test error'); }); const res = h.response();
  await h.ctx.route('/api/tiger-team/resume', h.req, res);
  assert.equal(h.state.apiReserved, false); assert.equal(h.state.status, 'blocked');
  assert.match(res.writes.join(''), /tt_interrupted/); assert.doesNotMatch(res.writes.join(''), /tt_complete/);
});
test('recovery UI parses and does not reject saved records just because they contain an error', () => {
  for (const [,script] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(script);
  const load = html.slice(html.indexOf('async function loadSaved('), html.indexOf('// ── Resume Interrupted Team'));
  assert.match(load, /if \(!resp.ok\)/);
  assert.doesNotMatch(load, /if \(data.error\) \{ alert/);
  const start = html.slice(html.indexOf('function startTigerTeam()'), html.indexOf('// ── Event Handler'));
  assert.doesNotMatch(start, /setStatus\('complete'/);
  assert.match(start, /tt_interrupted/);
});

test('resume failure after Stop never writes to an ended response', async () => {
  let release;
  const h = load(() => new Promise((resolve, reject) => { release = () => reject(new Error('stopped')); }));
  const res = h.response();
  const write = res.write;
  let lateWrites = 0;
  res.write = s => { if (res.writableEnded) lateWrites++; return write(s); };
  const run = h.ctx.route('/api/tiger-team/resume', h.req, res);
  while (!release) await new Promise(r => setImmediate(r));
  res.end(); release(); await run;
  assert.equal(lateWrites, 0);
});

// Exercise the actual start/stop route text over real Node HTTP responses.
// A fake response that accepts writes after end hid this process-crashing bug.
for (const mode of ['roundtable', 'led']) {
  test(`HTTP ${mode} Stop followed by unwinding cannot write after end`, async () => {
    const http = require('node:http');
    let release, started;
    const ready = new Promise(r => { started = r; });
    const state = { status: 'running' };
    const ctx = {
      require, console: { log() {}, error() {} }, global: {}, AbortController,
      readBody: async req => { let b = ''; for await (const chunk of req) b += chunk; return b; },
      jsonResponse: (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); },
      getTigerTeamState: () => state,
      stopTigerTeam: () => { state.status = 'stopped'; release('Tiger Team failed: Tiger Team stopped'); },
      setInterval, clearInterval, setTimeout,
    };
    ctx.runRoundtable = ctx.runTigerTeam = async ({ session }) => {
      session.tigerTeamId = 'synthetic';
      return new Promise(resolve => { release = resolve; started(); });
    };
    vm.createContext(ctx);
    const stopStart = source.indexOf("    if (pathname === '/api/tiger-team/stop'");
    const stopEnd = source.indexOf('    // Tiger Team save', stopStart);
    const start = source.indexOf("    if (pathname === '/api/tiger-team/start'");
    const end = source.indexOf('    // ── Image Routes', start);
    vm.runInContext('this.route = async (pathname, req, res) => {' + source.slice(stopStart, stopEnd) + source.slice(start, end) + '};', ctx);
    const errors = []; let lateWrites = 0;
    const server = http.createServer((req, res) => {
      const write = res.write.bind(res);
      res.write = (...args) => { if (res.writableEnded || res.destroyed) lateWrites++; return write(...args); };
      res.on('error', e => errors.push(e));
      ctx.route(req.url, req, res).catch(e => { errors.push(e); res.destroy(); });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (route, body) => fetch(base + route, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
    try {
      const run = post('/api/tiger-team/start', { coordinator: 'coord', objective: 'synthetic', mode });
      await ready;
      const response = await run;
      const session_id = Object.keys(ctx.global.__tigerTeamSessions)[0];
      assert.equal((await post('/api/tiger-team/stop', { session_id })).status, 200);
      assert.match(await response.text(), /tt_interrupted/);
      await new Promise(r => setImmediate(r));
      assert.equal(lateWrites, 0);
      assert.deepEqual(errors, []);
      assert.equal(Object.keys(ctx.global.__tigerTeamSessions).length, 0);
    } finally {
      server.closeAllConnections();
      await new Promise(r => server.close(r));
    }
  });
}

test('unknown outcomes block BOTH Resume and Continue before any model invocation', async () => {
  let runs = 0; const h = load(async () => { runs++; });
  h.state.calls = { a: { key: 'a', tools: { x: { name: 'Write', status: 'in_flight' } } } };
  for (const route of ['/api/tiger-team/resume', '/api/tiger-team/continue']) {
    h.req.body.message = 'Follow up'; const res = h.response();
    await h.ctx.route(route, h.req, res);
    assert.equal(res.status, 409); assert.equal(res.body.unresolved.length, 1);
  }
  assert.equal(runs, 0); assert.notEqual(h.state.apiReserved, true);
});

test('full-record export streams valid JSON containing exact artifacts and source events', async t => {
  const os = require('node:os');
  const recovery = require('../lib/tiger-team-recovery');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-api-archive-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new recovery.CheckpointStore(dir);
  const state = { id: 'tt', calls: { a: { key: 'a', agent: 'coord', tools: {} } } };
  store.save('tt', state);
  const artifact = store.artifact('tt', 'full'.repeat(10000));
  store.append('tt', state, { type: 'model_request', request: artifact });
  const ctx = { require, fs, path, URL, ttRecovery: recovery, ttStore: store, ttValidId: recovery.validId,
    getTigerTeamState: id => id === 'tt' ? state : null,
    jsonResponse: (res, status, body) => { res.status = status; res.body = body; } };
  vm.createContext(ctx);
  const start = source.indexOf("    if (pathname.startsWith('/api/tiger-team/archive/')");
  const end = source.indexOf('    // Only an explicit operator', start);
  vm.runInContext('this.route = async (pathname, req, res) => {' + source.slice(start, end) + '};', ctx);
  const res = new EventEmitter(); let text = '';
  res.writeHead = status => { res.status = status; }; res.write = s => { text += s; return true; };
  res.end = () => { res.writableEnded = true; }; res.destroy = () => { throw new Error('Unexpected export failure'); };
  await ctx.route('/api/tiger-team/archive/tt', { method: 'GET', url: '/api/tiger-team/archive/tt?download=1' }, res);
  const data = JSON.parse(text);
  assert.equal(data.artifacts[artifact.hash], 'full'.repeat(10000));
  assert.equal(data.events[0].type, 'model_request'); assert.equal(res.writableEnded, true);
});
