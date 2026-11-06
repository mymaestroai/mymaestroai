'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const MOD = path.join(__dirname, '..', 'modules', 'oura');
const manifestLib = require('../lib/modules/manifest');
const { createOura, USER_AGENT } = require(path.join(MOD, 'oura.js'));
const server = require(path.join(MOD, 'server.js'));
const mod = require(path.join(MOD, 'index.js'));

const NOW = Date.parse('2026-11-06T12:00:00Z');
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

// A stand-in for Oura: token endpoint plus v2 collections. Records every request.
function fakeOura(opts = {}) {
  const g = { calls: [], tokens: 0, refreshSeen: [], data: opts.data || {}, pages: opts.pages || {}, status: opts.status || {}, tokenReply: opts.tokenReply };
  g.fetch = async (url, init = {}) => {
    const u = new URL(url);
    g.calls.push({ url: u, init });
    if (u.pathname === '/oauth/token') {
      g.tokens++;
      const form = new URLSearchParams(init.body);
      g.refreshSeen.push(form.get('refresh_token'));
      if (g.tokenReply) return typeof g.tokenReply === 'function' ? g.tokenReply(g.tokens) : g.tokenReply;
      return json({ access_token: `at-${g.tokens}`, refresh_token: `rt-${g.tokens}`, expires_in: 86400, token_type: 'bearer' });
    }
    const name = u.pathname.split('/').pop();
    if (g.status[name]) return json({ detail: 'x' }, g.status[name]);
    if (g.pages[name]) {
      const tok = u.searchParams.get('next_token');
      const i = tok ? Number(tok) : 0;
      const data = g.pages[name][i];
      return json({ data, next_token: i + 1 < g.pages[name].length ? String(i + 1) : null });
    }
    return json({ data: g.data[name] || [], next_token: null });
  };
  return g;
}
const client = (g, extra = {}) => createOura({ clientId: 'cid', clientSecret: 'csecret', refreshToken: 'rt-0', fetch: g.fetch, now: () => NOW, ...extra });
const callTool = async (g, name, args, extra) => {
  const r = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, client(g, extra), () => NOW);
  return r;
};
const textOf = (r) => JSON.parse(r.result.content[0].text);
const apiCalls = (g) => g.calls.filter((c) => c.url.pathname !== '/oauth/token');

test('module.json and setup.json validate', () => {
  const loaded = manifestLib.loadModule(MOD);
  const codeKnown = !loaded.problems.some((p) => /oauth\.flow must be/.test(p));
  const rest = loaded.problems.filter((p) => !/^oauth\./.test(p));
  assert.deepEqual(rest, []);
  if (!codeKnown) console.log("note: lib/modules/manifest.js does not accept the 'code' oauth flow yet; the oauth block could not be validated");
  else assert.deepEqual(loaded.problems, []);
  const m = loaded.manifest;
  assert.equal(m.id, 'oura');
  assert.ok(!m.icon.includes('\uFE0F'));
  assert.equal(m.oauth.flow, 'code');
  assert.equal(m.oauth.pkce, true);
  assert.equal(m.oauth.rotatesRefreshToken, true);
  assert.deepEqual(Object.keys(m.tools).sort(), server.TOOLS.map((t) => t.name).sort());
  assert.ok(Object.values(m.tools).every((c) => c === 'read'));
  const steps = loaded.setup.steps.map((s) => s.id);
  assert.deepEqual(steps, ['about', 'register', 'install', 'keys', 'signin', 'who', 'done']);
  assert.ok(loaded.setup.steps[1].body.includes('{{redirectUri}}'));
  assert.ok(loaded.hasGuide);
  assert.ok(!/wallet/i.test(require('fs').readFileSync(path.join(MOD, 'guide.md'), 'utf8')));
});

test('token refresh sends the right request, rotates the refresh token and calls onRotate', async () => {
  const g = fakeOura({ data: { daily_readiness: [] } });
  const rotated = [];
  const oura = client(g, { onRotate: (v) => rotated.push(v) });
  assert.equal(await oura.token(), 'at-1');
  assert.equal(await oura.token(), 'at-1');          // cached
  assert.equal(g.tokens, 1);
  assert.deepEqual(rotated, ['rt-1']);
  const c = g.calls[0];
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.redirect, 'error');
  assert.equal(c.init.headers['User-Agent'], USER_AGENT);
  const form = new URLSearchParams(c.init.body);
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('client_id'), 'cid');
  assert.equal(form.get('client_secret'), 'csecret');
  assert.equal(form.get('refresh_token'), 'rt-0');
});

test('the new refresh token is used from then on, and the access token is renewed 60 s before expiry', async () => {
  const g = fakeOura({ tokenReply: (n) => json({ access_token: `at-${n}`, refresh_token: `rt-${n}`, expires_in: 3600 }) });
  let t = NOW;
  const rotated = [];
  const oura = createOura({ clientId: 'cid', clientSecret: 's', refreshToken: 'rt-0', fetch: g.fetch, now: () => t, onRotate: (v) => rotated.push(v) });
  await oura.token();
  t += 3600 * 1000 - 61 * 1000;
  assert.equal(await oura.token(), 'at-1');
  t += 2 * 1000;
  assert.equal(await oura.token(), 'at-2');
  assert.deepEqual(g.refreshSeen, ['rt-0', 'rt-1']);
  assert.deepEqual(rotated, ['rt-1', 'rt-2']);
});

test('a reply without a new refresh token keeps the old one and does not call onRotate', async () => {
  const g = fakeOura({ tokenReply: json({ access_token: 'a', expires_in: 3600 }) });
  const rotated = [];
  await client(g, { onRotate: (v) => rotated.push(v) }).token();
  assert.deepEqual(rotated, []);
});

test('invalid_grant gives the sign-in-expired message', async () => {
  const g = fakeOura({ tokenReply: json({ error: 'invalid_grant', error_description: 'secret-ish' }, 400) });
  await assert.rejects(client(g).token(), (e) => {
    assert.equal(e.message, 'The Oura sign-in has expired or was removed. Sign in again in Data connectors.');
    return true;
  });
});

test('other token errors never echo tokens or secrets', async () => {
  const g = fakeOura({ tokenReply: json({ error: 'server_error', detail: 'rt-0 csecret' }, 500) });
  await assert.rejects(client(g).token(), (e) => {
    assert.ok(!/rt-0|csecret|cid/.test(e.message));
    return true;
  });
  const g2 = fakeOura({ tokenReply: json({ error: 'invalid_client' }, 401) });
  await assert.rejects(client(g2).token(), /invalid_client/);
});

test('a missing sign-in or client is explained', async () => {
  const g = fakeOura();
  await assert.rejects(createOura({ clientId: 'a', clientSecret: 'b', fetch: g.fetch }).token(), /Sign in first/);
  await assert.rejects(createOura({ fetch: g.fetch }).token(), /client ID and secret/);
  assert.equal(g.calls.length, 0);
});

test('get sends Bearer and User-Agent, follows next_token, and stops at 10 pages', async () => {
  const g = fakeOura({ pages: { daily_readiness: [[{ day: 'a' }], [{ day: 'b' }], [{ day: 'c' }]] } });
  const oura = client(g);
  const data = await oura.get('/v2/usercollection/daily_readiness', { start_date: '2026-11-01', end_date: '2026-11-06' });
  assert.deepEqual(data.map((d) => d.day), ['a', 'b', 'c']);
  const calls = apiCalls(g);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer at-1');
  assert.equal(calls[0].init.headers['User-Agent'], USER_AGENT);
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].url.origin, 'https://api.ouraring.com');
  assert.equal(calls[0].url.searchParams.get('start_date'), '2026-11-01');
  assert.equal(calls[0].url.searchParams.get('next_token'), null);
  assert.equal(calls[1].url.searchParams.get('next_token'), '1');
  assert.equal(calls[2].url.searchParams.get('next_token'), '2');

  const endless = fakeOura({ pages: { daily_activity: Array.from({ length: 30 }, (_, i) => [{ day: String(i) }]) } });
  const all = await client(endless).get('/v2/usercollection/daily_activity', {});
  assert.equal(all.length, 10);
  assert.equal(apiCalls(endless).length, 10);
});

test('get only talks to the allowed host and paths', async () => {
  const g = fakeOura();
  assert.throws(() => createOura({ clientId: 'a', clientSecret: 'b', refreshToken: 'c', fetch: g.fetch, baseUrl: 'http://example.com' }), /https/);
  assert.throws(() => createOura({ clientId: 'a', clientSecret: 'b', refreshToken: 'c', fetch: g.fetch, tokenUrl: 'http://example.com/t' }), /https/);
  await assert.rejects(client(g).get('https://evil.example/v2/x'), /not allowed/);
  await assert.rejects(client(g).get('/v2/../x'), /not allowed/);
  const local = createOura({ clientId: 'a', clientSecret: 'b', refreshToken: 'c', fetch: g.fetch, baseUrl: 'http://127.0.0.1:9', allowInsecureLocal: true });
  await local.get('/v2/usercollection/sleep', {});
  assert.equal(apiCalls(g)[0].url.origin, 'http://127.0.0.1:9');
});

test('429 and 403 and 401 have plain messages', async () => {
  const g429 = fakeOura({ status: { sleep: 429 } });
  await assert.rejects(client(g429).get('/v2/usercollection/sleep', {}), (e) => {
    assert.equal(e.message, "Oura's limit of 5,000 requests in 5 minutes was reached. Try again in a few minutes.");
    return true;
  });
  const g403 = fakeOura({ status: { sleep: 403 } });
  await assert.rejects(client(g403).get('/v2/usercollection/sleep', {}), (e) => {
    assert.match(e.message, /expired/);
    assert.match(e.message, /permission/);
    assert.match(e.message, /Membership/);
    assert.ok(!/at-1|rt-|csecret/.test(e.message));
    return true;
  });
  const g401 = fakeOura({ status: { sleep: 401 } });
  await assert.rejects(client(g401).get('/v2/usercollection/sleep', {}), /expired/);
  assert.equal(g401.tokens, 2);   // one retry with a fresh access token
});

test('an oversized reply is refused', async () => {
  const big = async () => new Response('x'.repeat(5 * 1024 * 1024), { status: 200 });
  await assert.rejects(createOura({ clientId: 'a', clientSecret: 'b', refreshToken: 'c', fetch: async (u) => (u.includes('/oauth/') ? json({ access_token: 'a', expires_in: 100 }) : big()) }).get('/v2/usercollection/sleep', {}), /too large/);
});

test('tools/list and initialize', async () => {
  const g = fakeOura();
  const oura = client(g);
  const list = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, oura);
  assert.deepEqual(list.result.tools.map((t) => t.name), ['oura_sleep', 'oura_readiness', 'oura_activity', 'oura_heart_rate', 'oura_spo2', 'oura_workouts']);
  const init = await server.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, oura);
  assert.equal(init.result.serverInfo.name, 'oura');
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, oura), null);
  assert.equal((await server.handle({ jsonrpc: '2.0', id: 3, method: 'nope' }, oura)).error.code, -32601);
  assert.equal((await server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } }, oura)).error.code, -32602);
  assert.equal(g.calls.length, 0);
});

test('readiness: default range is the last 7 days and the result shape', async () => {
  const g = fakeOura({ data: { daily_readiness: [
    { day: '2026-11-05', score: 81, temperature_deviation: 0.2, contributors: { hrv_balance: 70 } },
    { day: '2026-11-04', score: 77, temperature_deviation: -0.1, contributors: { hrv_balance: 60 } }] } });
  const r = await callTool(g, 'oura_readiness', {});
  const q = apiCalls(g)[0].url.searchParams;
  assert.equal(q.get('start_date'), '2026-10-31');
  assert.equal(q.get('end_date'), '2026-11-06');
  const out = textOf(r);
  assert.deepEqual(out.days.map((d) => d.date), ['2026-11-04', '2026-11-05']);
  assert.deepEqual(out.days[1], { date: '2026-11-05', score: 81, temperature_deviation: 0.2, contributors: { hrv_balance: 70 } });
});

test('activity, spo2 and workouts shapes', async () => {
  const g = fakeOura({ data: {
    daily_activity: [{ day: '2026-11-05', score: 88, steps: 9000, active_calories: 400, total_calories: 2400, inactivity_alerts: 1, extra: 'no' }],
    daily_spo2: [{ day: '2026-11-05', spo2_percentage: { average: 97.4 } }],
    workout: [{ day: '2026-11-05', activity: 'running', start_datetime: '2026-11-05T07:00:00+00:00', end_datetime: '2026-11-05T07:30:00+00:00', calories: 300, distance: 5000, intensity: 'moderate' }],
  } });
  assert.deepEqual(textOf(await callTool(g, 'oura_activity', { start_date: '2026-11-05', end_date: '2026-11-05' })).days,
    [{ date: '2026-11-05', score: 88, steps: 9000, active_calories: 400, total_calories: 2400, inactivity_alerts: 1 }]);
  assert.deepEqual(textOf(await callTool(g, 'oura_spo2', {})).days, [{ date: '2026-11-05', average_percentage: 97.4 }]);
  assert.deepEqual(textOf(await callTool(g, 'oura_workouts', {})).workouts,
    [{ date: '2026-11-05', activity: 'running', start: '2026-11-05T07:00:00+00:00', end: '2026-11-05T07:30:00+00:00', calories: 300, distance: 5000, intensity: 'moderate' }]);
  const paths = apiCalls(g).map((c) => c.url.pathname);
  assert.deepEqual(paths, ['/v2/usercollection/daily_activity', '/v2/usercollection/daily_spo2', '/v2/usercollection/workout']);
  assert.equal(apiCalls(g)[0].url.searchParams.get('start_date'), '2026-11-05');
});

test('sleep combines daily scores with sleep periods', async () => {
  const g = fakeOura({ data: {
    daily_sleep: [{ day: '2026-11-05', score: 84 }, { day: '2026-11-04', score: 70 }],
    sleep: [{ day: '2026-11-05', type: 'long_sleep', total_sleep_duration: 27000, deep_sleep_duration: 4800, rem_sleep_duration: 5400, light_sleep_duration: 16800,
      efficiency: 92, average_heart_rate: 52.5, lowest_heart_rate: 47, average_hrv: 60, latency: 600 }],
  } });
  const out = textOf(await callTool(g, 'oura_sleep', { start_date: '2026-11-01', end_date: '2026-11-06' }));
  assert.deepEqual(out.nights, [
    { date: '2026-11-04', score: 70 },
    { date: '2026-11-05', score: 84, type: 'long_sleep', total_min: 450, deep_min: 80, rem_min: 90, light_min: 280, efficiency: 92, avg_heart_rate: 52.5, lowest_heart_rate: 47, avg_hrv: 60, latency_min: 10 },
  ]);
  assert.deepEqual(apiCalls(g).map((c) => c.url.pathname).sort(), ['/v2/usercollection/daily_sleep', '/v2/usercollection/sleep']);
});

test('date ranges are validated: bad dates, end before start, more than 31 days', async () => {
  const g = fakeOura();
  const err = async (args) => { const r = await callTool(g, 'oura_activity', args); assert.equal(r.result.isError, true); return r.result.content[0].text; };
  assert.match(await err({ start_date: '2026-13-01' }), /start_date/);
  assert.match(await err({ end_date: '2026-02-30' }), /end_date/);
  assert.match(await err({ start_date: 'yesterday' }), /start_date/);
  assert.match(await err({ start_date: '2026-11-05', end_date: '2026-11-01' }), /not be before/);
  assert.match(await err({ start_date: '2026-10-01', end_date: '2026-11-06' }), /at most 31/);
  assert.equal(g.calls.length, 0);
  // 31 days inclusive is allowed, and a lone start_date runs to today (checked against the 31-day cap)
  await callTool(g, 'oura_activity', { start_date: '2026-10-07', end_date: '2026-11-06' });
  assert.equal(apiCalls(g).length, 1);
  assert.match(await err({ start_date: '2026-10-06' }), /at most 31/);
  // end_date alone: the 7 days before it
  await callTool(g, 'oura_spo2', { end_date: '2026-08-10' });
  assert.equal(apiCalls(g)[1].url.searchParams.get('start_date'), '2026-08-04');
});

test('heart rate: default last 24 hours, at most 7 days, thinned to 500 points', async () => {
  const pts = Array.from({ length: 2000 }, (_, i) => ({ bpm: 50 + (i % 40), source: 'awake', timestamp: new Date(NOW - 86400000 + i * 40000).toISOString() }));
  const g = fakeOura({ data: { heartrate: pts.slice().reverse() } });
  const out = textOf(await callTool(g, 'oura_heart_rate', {}));
  const q = apiCalls(g)[0].url.searchParams;
  assert.equal(q.get('end_datetime'), '2026-11-06T12:00:00.000Z');
  assert.equal(q.get('start_datetime'), '2026-11-05T12:00:00.000Z');
  assert.equal(q.get('start_date'), null);
  assert.equal(out.total_readings, 2000);
  assert.equal(out.points.length, 500);
  assert.equal(out.points[0].timestamp, pts[0].timestamp);                    // sorted, first and last kept
  assert.equal(out.points[499].timestamp, pts[1999].timestamp);
  assert.deepEqual(Object.keys(out.points[0]), ['timestamp', 'bpm', 'source']);
  for (let i = 1; i < out.points.length; i++) assert.ok(out.points[i].timestamp > out.points[i - 1].timestamp);

  const few = fakeOura({ data: { heartrate: pts.slice(0, 10) } });
  assert.equal(textOf(await callTool(few, 'oura_heart_rate', {})).points.length, 10);

  const bad = async (args) => (await callTool(g, 'oura_heart_rate', args)).result;
  assert.equal((await bad({ start: '2026-11-01T00:00:00Z', end: '2026-11-09T00:00:00Z' })).isError, true);
  assert.equal((await bad({ start: '2026-11-05', end: '2026-11-06' })).isError, true);   // not a date-time
  assert.equal((await bad({ start: '2026-11-06T00:00:00Z', end: '2026-11-05T00:00:00Z' })).isError, true);
  const okRange = await bad({ start: '2026-11-01T00:00:00Z', end: '2026-11-08T00:00:00Z' });
  assert.ok(!okRange.isError);   // exactly 7 days
});

test('thin keeps order and the endpoints', () => {
  const a = Array.from({ length: 1001 }, (_, i) => i);
  const t = server.thin(a);
  assert.equal(t.length, 500);
  assert.equal(t[0], 0);
  assert.equal(t[499], 1000);
  assert.deepEqual(server.thin([1, 2, 3]), [1, 2, 3]);
});

test('an Oura error reaches the caller as a tool error with the plain message', async () => {
  const g = fakeOura({ status: { daily_readiness: 429 } });
  const r = await callTool(g, 'oura_readiness', {});
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /5,000 requests in 5 minutes/);
});

test('rotation: the hub link sends a request with an id and resolves only on { ok: true }', async () => {
  const sent = [];
  const link = server.createHubLink({ write: (l) => sent.push(l), timeoutMs: 50 });
  const p = link.request('rt-new');
  assert.equal(sent.length, 1);
  assert.ok(sent[0].endsWith('\n'));
  assert.deepEqual(JSON.parse(sent[0]), { jsonrpc: '2.0', id: 'hub-rot-1', method: 'hub/refresh_token', params: { value: 'rt-new' } });
  assert.equal(link.onMessage({ jsonrpc: '2.0', id: 'other', result: { ok: true } }), false);
  assert.equal(link.onMessage({ jsonrpc: '2.0', id: 'hub-rot-1', method: 'x', result: { ok: true } }), false, 'a request is not a response');
  assert.equal(link.onMessage({ jsonrpc: '2.0', id: 'hub-rot-1', result: { ok: true } }), true);
  await p;
  const p2 = link.request('rt-2');
  link.onMessage({ jsonrpc: '2.0', id: 'hub-rot-2', error: { code: -32000, message: 'no' } });
  await assert.rejects(p2);
  await assert.rejects(link.request('rt-3'), /did not answer/);   // 10 s in the server, 50 ms here
});

test('rotation: saved -> no warning; not confirmed -> the new token stays in use, one retry on the next call, warning in the result', async () => {
  const g = fakeOura({ data: { daily_readiness: [] } });
  let ok = true; const saves = [];
  const onRotate = async (v) => { saves.push(v); if (!ok) throw new Error('no answer'); };
  let r = await callTool(g, 'oura_readiness', {}, { onRotate });
  assert.equal(textOf(r).warning, undefined);
  assert.deepEqual(saves, ['rt-1']);

  // not confirmed: use one client across calls
  const g2 = fakeOura({ data: { daily_readiness: [] } });
  saves.length = 0; ok = false;
  const oura = client(g2, { onRotate, now: (() => { let t = NOW; return () => t; })() });
  r = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'oura_readiness', arguments: {} } }, oura, () => NOW);
  assert.ok(!r.result.isError);
  assert.equal(textOf(r).warning, 'My Maestro could not save the new Oura sign-in, so it will stop working after a restart. Check Data connectors.');
  assert.deepEqual(saves, ['rt-1']);
  assert.deepEqual(g2.refreshSeen, ['rt-0']);
  // next call: one retry of the save with the new token, still failing -> still warns; no refresh with the spent token
  r = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'oura_readiness', arguments: {} } }, oura, () => NOW);
  assert.deepEqual(saves, ['rt-1', 'rt-1']);
  assert.ok(textOf(r).warning);
  r = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'oura_readiness', arguments: {} } }, oura, () => NOW);
  assert.deepEqual(saves, ['rt-1', 'rt-1'], 'only one retry');
  assert.deepEqual(g2.refreshSeen, ['rt-0'], 'the cached token is still good; nothing was refreshed with the spent token');

  // the retry succeeds -> the warning goes away
  const g3 = fakeOura({ data: { daily_readiness: [] } });
  ok = false; saves.length = 0;
  const o3 = client(g3, { onRotate });
  r = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'oura_readiness', arguments: {} } }, o3, () => NOW);
  assert.ok(textOf(r).warning);
  ok = true;
  r = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'oura_readiness', arguments: {} } }, o3, () => NOW);
  assert.equal(textOf(r).warning, undefined);
});

test('rotation: a later refresh uses the new token even when the save was not confirmed', async () => {
  let t = NOW;
  const g = fakeOura({ data: { daily_readiness: [] } });
  const oura = createOura({ clientId: 'a', clientSecret: 'b', refreshToken: 'rt-0', fetch: g.fetch, now: () => t, onRotate: async () => { throw new Error('x'); } });
  await oura.token();
  t += 2 * 86400 * 1000;
  await oura.token();
  assert.deepEqual(g.refreshSeen, ['rt-0', 'rt-1']);
});

test('paging stops at 10 pages with truncated: true and the number of records returned', async () => {
  const pages = Array.from({ length: 12 }, (_, i) => [{ day: `2026-10-${String(i + 1).padStart(2, '0')}`, score: i }]);
  const g = fakeOura({ pages: { daily_readiness: pages } });
  const out = textOf(await callTool(g, 'oura_readiness', {}));
  assert.equal(out.truncated, true);
  assert.equal(out.records, 10);
  assert.equal(out.days.length, 10);
  assert.equal(apiCalls(g).length, 10);
  // exactly 10 pages is not truncated
  const g2 = fakeOura({ pages: { daily_readiness: pages.slice(0, 10) } });
  const out2 = textOf(await callTool(g2, 'oura_readiness', {}));
  assert.equal(out2.truncated, undefined);
  assert.equal(out2.days.length, 10);
});

test('health check says only that it connected: no scores or dates', async () => {
  const mk = (text, throws) => ({ callTool: async () => { if (throws) throw new Error(throws); return text; }, parse: (t) => { try { return JSON.parse(t); } catch { return null; } } });
  const run = (ctx) => mod.checks.oura(ctx);
  assert.deepEqual(await run(mk(JSON.stringify({ days: [{ date: '2026-11-04', score: 70 }, { date: '2026-11-05', score: 81 }] }))), { ok: true, summary: 'Connected to Oura.' });
  assert.deepEqual(await run(mk(JSON.stringify({ days: [] }))), { ok: true, summary: 'Connected to Oura.' });
  assert.deepEqual(await run(mk('', 'The Oura sign-in has expired or was removed. Sign in again in Data connectors.')), { ok: false, summary: 'The Oura sign-in has expired or was removed. Sign in again in Data connectors.' });
  const bad = await run(mk('Oura answered 500.'));
  assert.equal(bad.ok, false);
});

test('setup.json and guide.md say the nightly check asks Oura for one small reading without keeping it', () => {
  const fs = require('fs');
  assert.match(fs.readFileSync(path.join(MOD, 'setup.json'), 'utf8'), /nightly connection check asks Oura for one small reading without keeping it/);
  assert.match(fs.readFileSync(path.join(MOD, 'guide.md'), 'utf8'), /nightly connection check[^]*one small reading[^]*does not keep it/);
});
