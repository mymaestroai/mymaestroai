'use strict';
// Face view: the hub-events tap turns a `voice_mood` gateway event (made by the provider paths once the leading mood tag
// is stripped) into one `turn_mood` event: { agent, turnId, mood }, from a fixed allow-list. No network, no real data.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHubEvents } = require('../lib/hub-events');
const { MOODS } = require('../lib/voice/mood');

function fakeClient() {
  const out = [];
  const res = { writableLength: 0, writeHead() {}, write(s) { out.push(s); return true; }, on() {}, destroy() {} };
  return { req: { headers: {} }, res, out };
}
const frames = out => out.filter(s => typeof s === 'string' && s.startsWith('id: ')).map(s => JSON.parse(s.split('\ndata: ')[1]));
const sse = obj => 'data: ' + JSON.stringify(obj) + '\n\n';
const mood = m => ({ choices: [{ delta: {} }], gateway: { type: 'voice_mood', mood: m } });

function setup(origin = { kind: 'user' }) {
  const hub = createHubEvents();
  const c = fakeClient();
  hub.subscribe(c.req, c.res);
  const res = { write: () => true };
  const tap = hub.tapTurn(res, { agent: 'ada', origin, message: 'hi', turnId: 't-1' });
  return { hub, c, res, tap };
}

test('a voice_mood event becomes one turn_mood with the agent, the turn id and the word', () => {
  const { c, res } = setup();
  res.write(sse(mood('proud')));
  const f = frames(c.out).filter(x => x.type === 'turn_mood');
  assert.equal(f.length, 1);
  assert.equal(f[0].agent, 'ada');
  assert.equal(f[0].turnId, 't-1');
  assert.equal(f[0].mood, 'proud');
  assert.deepEqual(Object.keys(f[0]).filter(k => !['id', 'type', 'ts', 'at', 'bootId', 'seq'].includes(k)).sort(), ['agent', 'mood', 'turnId']);
});

test('every word of the fixed list is accepted; anything else is dropped', () => {
  for (const m of MOODS) {
    const { c, res } = setup();
    res.write(sse(mood(m)));
    assert.deepEqual(frames(c.out).filter(x => x.type === 'turn_mood').map(x => x.mood), [m]);
  }
  for (const bad of ['', 'Proud', 'happy', '[proud]', 'proud ', 'constructor', null, 7, { a: 1 }, ['proud']]) {
    const { c, res } = setup();
    res.write(sse(mood(bad)));
    assert.equal(frames(c.out).filter(x => x.type === 'turn_mood').length, 0, `rejected: ${JSON.stringify(bad)}`);
  }
});

test('at most one turn_mood per turn', () => {
  const { c, res } = setup();
  res.write(sse(mood('curious')));
  res.write(sse(mood('proud')));
  assert.deepEqual(frames(c.out).filter(x => x.type === 'turn_mood').map(x => x.mood), ['curious']);
});

test('only the person\'s own turn: a hub-started turn never shows a mood', () => {
  for (const kind of ['consultation', 'schedule', 'task', 'job_notice', 'job_report', 'consult_reply', 'alert']) {
    const { c, res } = setup({ kind });
    res.write(sse(mood('proud')));
    assert.equal(frames(c.out).filter(x => x.type === 'turn_mood').length, 0, kind);
  }
});

test('no mood after the turn is over, and none is replayed to a page that connects later', () => {
  const a = setup();
  a.tap.finish(true);
  a.res.write(sse(mood('proud')));
  assert.equal(frames(a.c.out).filter(x => x.type === 'turn_mood').length, 0, 'finished turn');

  const b = setup();
  b.res.write(sse(mood('proud')));
  const late = fakeClient();
  b.hub.subscribe(late.req, late.res);
  assert.equal(frames(late.out).filter(x => x.type === 'turn_mood').length, 0, 'a point-in-time reading is not kept for replay');
});

test('the mood event is not text: no delta, no activity row', () => {
  const { c, res } = setup();
  res.write(sse(mood('proud')));
  const types = frames(c.out).map(x => x.type);
  assert.ok(!types.includes('turn_delta'));
  assert.ok(!types.includes('turn_activity'));
});
