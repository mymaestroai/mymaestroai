'use strict';
// POST /api/voice/call action 'route': the page tells the hub which microphone the browser picked (names and flags only, never audio); one log line per call per 2 s.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { Readable, Writable } = require('node:stream');
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('voice-route-log-iso-');
const L = (p) => require(path.join(ISO.lib, p));
const { createVoiceCalls } = L('voice/call');

function fakeRes() {
  const chunks = [];
  const r = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  r.writeHead = (code) => { r.statusCode = code; r.headersSent = true; };
  r.json = () => JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return r;
}
const sam = { id: 'u_sam', role: 'member', name: 'Sam' };
const alex = { id: 'u_alex', role: 'member', name: 'Alex' };
async function post(deps, url, body, user = sam) {
  const routes = L('voice/routes');
  const res = fakeRes();
  const done = new Promise((resolve) => res.on('finish', resolve));
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', url, headers: {}, hubUser: user, hubService: false });
  await routes.handle(url, req, res, deps);
  if (!res.writableEnded) res.end();
  await done;
  return { status: res.statusCode, json: res.json() };
}
function rig() {
  const clock = { t: Date.parse('2026-11-12T20:00:00Z') };
  const calls = createVoiceCalls({ now: () => clock.t, bus: { publish() {} }, setInterval: () => ({ unref() {} }), clearInterval: () => {} });
  const deps = {
    jsonResponse: (res, code, data) => { res.writeHead(code); res.end(JSON.stringify(data)); },
    readBody: (req) => new Promise((resolve) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => resolve(s)); }),
    getSetting: () => undefined, updateSettings: () => {}, getAgents: async () => [],
    getVoice: () => ({ engine: { status: () => ({}), paths: {} }, client: {} }),
    voiceCall: calls,
  };
  return { deps, calls };
}
async function startCall(r, agent = 'sam_assistant') {
  const s = await post(r.deps, '/api/voice/call', { agent, action: 'start' });
  return s.json.call.callId;
}
async function withLog(fn) {
  const lines = [], orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try { await fn(); } finally { console.log = orig; }
  return lines.filter((l) => l.startsWith('[voice] route'));
}
const body = (callId, route, agent = 'sam_assistant') => ({ agent, callId, action: 'route', route });

test('route: one log line with the names and flags of a Bluetooth route', async () => {
  const r = rig(); const id = await startCall(r);
  let ans;
  const lines = await withLog(async () => {
    ans = await post(r.deps, '/api/voice/call', body(id, { label: 'Car Kit (Bluetooth)', bluetooth: true, bluetoothListed: true, chosen: true, fellBack: false, renewed: 1, android: true, inputs: ['Car Kit (Bluetooth)', 'Phone mic'] }));
  });
  assert.strictEqual(ans.status, 200);
  assert.deepStrictEqual(ans.json, { ok: true, logged: true });
  assert.deepStrictEqual(lines, ['[voice] route sam_assistant: mic "Car Kit (Bluetooth)" bluetooth=yes listed=yes chosen=yes fellBack=no renewed=1 android=yes inputs=Car Kit (Bluetooth)|Phone mic']);
});

test('route: fields are cleaned (quotes and control characters out, 60 characters, 8 inputs)', async () => {
  const r = rig(); const id = await startCall(r);
  const label = 'He said "hi"\nthere' + 'x'.repeat(100);
  const lines = await withLog(async () => {
    await post(r.deps, '/api/voice/call', body(id, { label, bluetooth: false, inputs: Array.from({ length: 12 }, (_v, i) => 'in"' + i + '\u0007') }));
  });
  assert.strictEqual(lines.length, 1);
  const m = lines[0].match(/mic "([^"]*)"/);
  assert.ok(m && m[1].length === 60 && m[1].startsWith('He said hithere'), lines[0]);
  assert.ok(!/[\u0000-\u001f\u007f]/.test(lines[0]));
  assert.strictEqual(lines[0].split('inputs=')[1], Array.from({ length: 8 }, (_v, i) => 'in' + i).join('|'));
  assert.match(lines[0], /bluetooth=no listed=no chosen=no fellBack=no renewed=0 android=no/);
});

test('route: someone who is not on the call is refused like a heartbeat, and nothing is logged', async () => {
  const r = rig(); const id = await startCall(r);
  let hb, ans;
  const lines = await withLog(async () => {
    hb = await post(r.deps, '/api/voice/call', { agent: 'sam_assistant', callId: id, action: 'heartbeat' }, alex);
    ans = await post(r.deps, '/api/voice/call', body(id, { label: 'x' }), alex);
  });
  assert.strictEqual(hb.status, 403);
  assert.strictEqual(ans.status, hb.status);
  assert.deepStrictEqual(ans.json, hb.json);
  assert.deepStrictEqual(lines, []);
  const stale = await post(r.deps, '/api/voice/call', body('call-old', { label: 'x' }));
  assert.strictEqual(stale.status, 409);
});

test('route: a second report within 2 s answers ok but is not logged; another call is not held back', async () => {
  const r = rig(); const id = await startCall(r); const other = await startCall(r, 'sam_other');
  const answers = [];
  const lines = await withLog(async () => {
    answers.push((await post(r.deps, '/api/voice/call', body(id, { label: 'a' }))).json);
    answers.push((await post(r.deps, '/api/voice/call', body(id, { label: 'b' }))).json);
    answers.push((await post(r.deps, '/api/voice/call', body(other, { label: 'c' }, 'sam_other'))).json);
  });
  assert.deepStrictEqual(answers, [{ ok: true, logged: true }, { ok: true, logged: false }, { ok: true, logged: true }]);
  assert.strictEqual(lines.length, 2);
  assert.match(lines[0], /mic "a"/);
});

test('route: garbage fields do not throw', async () => {
  const cases = [
    { label: 5, bluetooth: 'yes', bluetoothListed: 1, chosen: 'true', fellBack: {}, renewed: 1000, android: [], inputs: 'nope' },
    { label: null, renewed: -3, inputs: [1, null, {}, 'ok'] },
    'a string', null, [1, 2],
  ];
  const out = [], lines = [];
  for (const route of cases) {
    const r = rig(); const id = await startCall(r);   // a new call each time, so the 2 s limit does not hide a line
    lines.push(...await withLog(async () => { out.push((await post(r.deps, '/api/voice/call', body(id, route))).status); }));
  }
  assert.deepStrictEqual(out, [200, 200, 200, 200, 200]);
  assert.strictEqual(lines.length, 5);
  assert.strictEqual(lines[0], '[voice] route sam_assistant: mic "5" bluetooth=no listed=no chosen=no fellBack=no renewed=0 android=no inputs=');
  assert.strictEqual(lines[1], '[voice] route sam_assistant: mic "" bluetooth=no listed=no chosen=no fellBack=no renewed=0 android=no inputs=ok');
});

test('route: C1 controls, line and paragraph separators are removed, and a bar inside an input label becomes a slash', async () => {
  const r = rig(); const id = await startCall(r);
  const lines = await withLog(async () => {
    await post(r.deps, '/api/voice/call', body(id, { label: 'A\u0085B\u2028C\u2029D\u009fE', inputs: ['Mic|One', 'Two\u0085x'] }));
  });
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /mic "ABCDE"/);
  assert.strictEqual(lines[0].split('inputs=')[1], 'Mic/One|Twox');
  assert.ok(!/[\u0080-\u009f\u2028\u2029]/.test(lines[0]));
});
