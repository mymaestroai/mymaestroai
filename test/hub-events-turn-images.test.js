'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHubEvents } = require('../lib/hub-events');

const ROOT = path.join(__dirname, '..');

function start(hub, images) {
  const frames = [];
  hub.onPublish && hub.onPublish(() => {});
  const c = { writableLength: 0, writeHead() {}, write(s) { if (typeof s === 'string' && s.startsWith('id: ')) frames.push(JSON.parse(s.split('\ndata: ')[1])); return true; }, on() {} };
  hub.subscribe({ headers: {} }, c);
  const res = { write: () => true };
  const args = { agent: 'agent-a', origin: { kind: 'user' }, message: 'hi' };
  if (images !== undefined) args.images = images;
  hub.tapTurn(res, args);
  return frames.find(f => f.type === 'turn_start');
}

test('turn_start carries the pictures exactly as passed', () => {
  const hub = createHubEvents();
  const f = start(hub, ['/tmp/x/data/uploads/a.jpg', '/tmp/x/data/uploads/b.png']);
  assert.deepEqual(f.images, ['/tmp/x/data/uploads/a.jpg', '/tmp/x/data/uploads/b.png']);
  assert.deepEqual(hub.turnFor('agent-a').images, f.images);
});

test('turn_start drops non-strings, empty and relative paths, and caps at 8', () => {
  const hub = createHubEvents();
  const good = Array.from({ length: 10 }, (_, i) => `/tmp/x/data/uploads/p${i}.jpg`);
  const f = start(hub, [null, 5, {}, '', 'rel/a.jpg', './b.jpg', ...good]);
  assert.deepEqual(f.images, good.slice(0, 8));
});

test('no images key when none are passed or none survive', () => {
  for (const imgs of [undefined, [], ['', 'rel.jpg', 3], 'not-an-array']) {
    const hub = createHubEvents();
    const f = start(hub, imgs);
    assert.equal('images' in f, false);
    assert.equal('images' in hub.turnFor('agent-a'), false);
  }
});

test('the state keeps its own copy; turnFor returns a copy', () => {
  const hub = createHubEvents();
  const mine = ['/tmp/x/data/uploads/a.jpg'];
  const f = start(hub, mine);
  mine.push('/tmp/x/data/uploads/late.jpg');
  mine[0] = '/tmp/x/data/uploads/changed.jpg';
  assert.deepEqual(hub.turnFor('agent-a').images, ['/tmp/x/data/uploads/a.jpg']);
  const got = hub.turnFor('agent-a').images;
  got.push('/tmp/x/other.jpg');
  got[0] = '/tmp/x/mutated.jpg';
  assert.deepEqual(hub.turnFor('agent-a').images, ['/tmp/x/data/uploads/a.jpg']);
  assert.deepEqual(f.images, ['/tmp/x/data/uploads/a.jpg']);
});

test('sdk-chat passes only the uploaded paths to tapTurn, not image_files', () => {
  const chat = fs.readFileSync(path.join(ROOT, 'lib/sdk-chat.js'), 'utf8');
  assert.match(chat, /const uploadedPaths = \[\];/);
  assert.match(chat, /if \(p\) \{ imagePaths\.push\(p\); uploadedPaths\.push\(p\); \}/);
  assert.match(chat, /tapTurn\(res, \{[^}]*images: uploadedPaths \}\)/);
  // the image_files loop must not feed uploadedPaths
  const m = chat.match(/for \(const p of r\.paths\) if \(!imagePaths\.includes\(p\)\) imagePaths\.push\(p\);/);
  assert.ok(m, 'image_files still only extends imagePaths');
  assert.equal((chat.match(/uploadedPaths\.push/g) || []).length, 1);
});
