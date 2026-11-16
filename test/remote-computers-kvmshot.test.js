'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const jpeg = require('jpeg-js');
const kvm = require('../modules/remote-computers/lib/kvmshot');

const { captureDesktop, KvmError, CommandReader, parseCommands, jpegSize, boxScale, CMD } = kvm;

const RED = [220, 30, 30];
const GREEN = [30, 200, 30];
const BLUE = [30, 30, 220];
const YELLOW = [230, 230, 30];

// ---------- helpers ----------
class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.closed = 0;
  }
  send(d) { this.sent.push(d); }
  close() { this.closed++; }
}

function fakeTimers() {
  const list = [];
  return {
    list,
    setTimeout(fn, ms) { const t = { fn, ms, cleared: false, fired: false }; list.push(t); return t; },
    clearTimeout(t) { if (t) t.cleared = true; },
    fire(ms) {
      for (const t of list) {
        if (t.ms === ms && !t.cleared && !t.fired) { t.fired = true; t.fn(); return true; }
      }
      return false;
    },
  };
}

const u16 = (n) => [(n >> 8) & 255, n & 255];
function solid(w, h, [r, g, b]) {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255; }
  return Buffer.from(jpeg.encode({ data, width: w, height: h }, 95).data);
}
const cmdScreen = (w, h) => Buffer.from([0, 7, 0, 8, ...u16(w), ...u16(h)]);
function cmdTile(x, y, jpg) {
  const size = 8 + jpg.length;
  return Buffer.concat([Buffer.from([0, 3, ...u16(size), ...u16(x), ...u16(y)]), jpg]);
}
function cmdDisplays(ids, sel) {
  const size = 6 + ids.length * 2 + 2;
  return Buffer.from([0, 11, ...u16(size), ...u16(ids.length), ...ids.flatMap(u16), ...u16(sel)]);
}
function cmdInfo(entries) {
  const b = Buffer.alloc(4 + entries.length * 10);
  b.writeUInt16BE(82, 0);
  b.writeUInt16BE(b.length, 2);
  entries.forEach((e, i) => {
    const p = 4 + i * 10;
    b.writeUInt16BE(e.id, p); b.writeInt16BE(e.x, p + 2); b.writeInt16BE(e.y, p + 4);
    b.writeUInt16BE(e.w, p + 6); b.writeUInt16BE(e.h, p + 8);
  });
  return b;
}
const jumbo = (cmd) => Buffer.concat([Buffer.from([0, 27, 0, 8, 0, (cmd.length >> 16) & 255, (cmd.length >> 8) & 255, cmd.length & 255]), cmd]);

function start(opts = {}) {
  const ws = new FakeWs();
  const timers = fakeTimers();
  const promise = captureDesktop(ws, { timeoutMs: 5000, infoGraceMs: 50, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, ...opts });
  const bin = (b) => ws.emit('message', b, true);
  const text = (s) => ws.emit('message', Buffer.from(s), false);
  return { ws, timers, promise, bin, text };
}
function begin(opts) {
  const s = start(opts);
  s.text('c');
  return s;
}
function px(img, x, y) {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}
function near(actual, expected, tol = 30) {
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(actual[i] - expected[i]) <= tol, `got ${actual} want ${expected}`);
}
const dec = (r) => jpeg.decode(r.jpeg, { useTArray: true, formatAsRGBA: true });
async function rejectsWith(promise, code) {
  await assert.rejects(promise, (e) => e instanceof KvmError && e.code === code && e.name === 'KvmError');
}
function assertOnlyAllowed(sent) {
  for (const m of sent) {
    if (m === '2') continue;
    assert.ok(Buffer.isBuffer(m), 'binary sends are Buffers');
    const cmd = (m[0] << 8) | m[1];
    assert.ok([5, 8, 12].includes(cmd), 'unexpected command ' + cmd);
    assert.equal((m[2] << 8) | m[3], m.length);
  }
}
function quadrants(s) {
  s.bin(cmdScreen(64, 48));
  s.bin(cmdTile(0, 0, solid(32, 24, RED)));
  s.bin(cmdTile(32, 0, solid(32, 24, GREEN)));
  s.bin(cmdTile(0, 24, solid(32, 24, BLUE)));
  s.bin(cmdTile(32, 24, solid(32, 24, YELLOW)));
}

// ---------- tests ----------
test('handshake: c and cr both answer with text 2; other text is ignored first', async () => {
  for (const hello of ['c', 'cr']) {
    const s = start();
    s.text('hello');
    assert.deepEqual(s.ws.sent, []);
    s.text(hello);
    assert.deepEqual(s.ws.sent, ['2']);
    s.text('c');
    assert.deepEqual(s.ws.sent, ['2']);
    s.ws.emit('close');
    await rejectsWith(s.promise, 'EKVMCLOSED');
  }
  const s = start();
  s.ws.emit('message', 'c'); // plain string
  assert.deepEqual(s.ws.sent, ['2']);
  s.ws.emit('close');
  await rejectsWith(s.promise, 'EKVMCLOSED');
});

test('screen command is answered with exact compression and unpause bytes', async () => {
  const s = begin({ quality: 70 });
  s.bin(cmdScreen(64, 48));
  assert.equal(s.ws.sent.length, 3);
  assert.deepEqual([...s.ws.sent[1]], [0x00, 0x05, 0x00, 0x0a, 1, 70, 0x04, 0x00, 0x00, 100]);
  assert.deepEqual([...s.ws.sent[2]], [0x00, 0x08, 0x00, 0x05, 0x00]);
  s.ws.emit('close');
  await rejectsWith(s.promise, 'EKVMCLOSED');
});

test('four tiles compose a 64x48 picture at full size', async () => {
  const s = begin();
  quadrants(s);
  s.bin(cmdDisplays([1], 1));
  const r = await s.promise;
  assert.equal(r.width, 64);
  assert.equal(r.height, 48);
  assert.equal(r.screenWidth, 64);
  assert.equal(r.screenHeight, 48);
  assert.equal(r.tiles, 4);
  assert.equal(r.primaryKnown, true);
  assert.equal(r.display, 1);
  const img = dec(r);
  near(px(img, 16, 12), RED);
  near(px(img, 48, 12), GREEN);
  near(px(img, 16, 36), BLUE);
  near(px(img, 48, 36), YELLOW);
  assert.equal(s.ws.closed, 1);
  assertOnlyAllowed(s.ws.sent);
});

test('a 1920x1080 screen of 8 tiles scales to maxWidth 960', async () => {
  const s = begin({ maxWidth: 960 });
  s.bin(cmdScreen(1920, 1080));
  const colors = [RED, GREEN, BLUE, YELLOW];
  const tileJpegs = colors.map((c) => solid(480, 540, c));
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 4; col++) s.bin(cmdTile(col * 480, row * 540, tileJpegs[(col + row) % 4]));
  }
  s.bin(cmdDisplays([1], 1));
  const r = await s.promise;
  assert.equal(r.width, 960);
  assert.equal(r.height, 540);
  assert.equal(r.screenWidth, 1920);
  assert.equal(r.screenHeight, 1080);
  assert.equal(r.tiles, 8);
  const img = dec(r);
  near(px(img, 100, 100), RED);
  near(px(img, 360, 100), GREEN);
  near(px(img, 100, 400), GREEN);
  near(px(img, 840, 400), RED);
});

test('jumbo header, padding and fragmentation', async () => {
  const s = begin();
  s.bin(cmdScreen(64, 48));
  const tl = cmdTile(0, 0, solid(32, 24, RED));
  const tr = cmdTile(32, 0, solid(32, 24, GREEN));
  const bl = cmdTile(0, 24, solid(32, 24, BLUE));
  const br = cmdTile(32, 24, solid(32, 24, YELLOW));
  s.bin(jumbo(tl)); // jumbo
  s.bin(Buffer.concat([tr, Buffer.alloc(5)])); // padded
  s.bin(bl.subarray(0, 6)); // fragmented over 3 messages
  s.bin(bl.subarray(6, 40));
  s.bin(bl.subarray(40));
  s.bin(br);
  s.bin(cmdDisplays([1], 1));
  const r = await s.promise;
  assert.equal(r.tiles, 4);
  const img = dec(r);
  near(px(img, 16, 12), RED);
  near(px(img, 48, 12), GREEN);
  near(px(img, 16, 36), BLUE);
  near(px(img, 48, 36), YELLOW);
});

test('CommandReader: jumbo, padding, fragmentation, short junk, ArrayBuffer input', () => {
  const t = cmdTile(1, 2, solid(8, 8, RED));
  const [a] = parseCommands(jumbo(t));
  assert.equal(a.cmd, CMD.TILE);
  assert.equal(a.size, t.length);
  assert.deepEqual(a.data, t);
  const [b] = parseCommands(Buffer.concat([t, Buffer.alloc(3)]));
  assert.equal(b.data.length, t.length);
  const rd = new CommandReader();
  assert.deepEqual(rd.push(Buffer.from([1, 2])), []); // under 4 bytes, ignored
  assert.deepEqual(rd.push(t.subarray(0, 10)), []);
  assert.equal(rd.pending, true);
  assert.deepEqual(rd.push(t.subarray(10, 20)), []);
  const out = rd.push(Buffer.concat([t.subarray(20), Buffer.alloc(4)]));
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].data, t);
  assert.equal(rd.pending, false);
  const ab = new Uint8Array(cmdScreen(5, 6)).buffer;
  assert.equal(parseCommands(ab)[0].cmd, CMD.SCREEN);
  // jumbo header split from its command
  const rd2 = new CommandReader();
  const j = jumbo(t);
  assert.deepEqual(rd2.push(j.subarray(0, 8)), []);
  assert.equal(rd2.push(j.subarray(8))[0].cmd, CMD.TILE);
});

test('jpegSize reads dimensions without decoding and rejects junk', () => {
  assert.deepEqual(jpegSize(solid(32, 24, RED)), { width: 32, height: 24 });
  assert.deepEqual(jpegSize(solid(5, 77, RED)), { width: 5, height: 77 });
  assert.equal(jpegSize(Buffer.from('not a jpeg')), null);
  assert.equal(jpegSize(solid(32, 24, RED).subarray(0, 12)), null);
  // fill bytes before a marker
  const j = solid(16, 16, RED);
  const padded = Buffer.concat([j.subarray(0, 2), Buffer.from([0xff, 0xff]), j.subarray(2)]);
  assert.deepEqual(jpegSize(padded), { width: 16, height: 16 });
});

test('boxScale averages areas', () => {
  const src = Buffer.from([0, 0, 0, 255, 100, 100, 100, 255, 200, 200, 200, 255, 100, 100, 100, 255]);
  const out = boxScale(src, 2, 2, 1, 1);
  assert.deepEqual([...out], [100, 100, 100, 255]);
});

test('a new screen command mid-frame restarts collection', async () => {
  const s = begin();
  s.bin(cmdScreen(64, 48));
  s.bin(cmdTile(0, 0, solid(32, 24, RED)));
  s.bin(cmdScreen(32, 24));
  s.bin(cmdTile(0, 0, solid(32, 24, GREEN)));
  s.bin(cmdDisplays([1], 1));
  const r = await s.promise;
  assert.equal(r.screenWidth, 32);
  assert.equal(r.tiles, 1);
  near(px(dec(r), 16, 12), GREEN);
  assert.equal(s.ws.sent.filter((m) => Buffer.isBuffer(m) && m[1] === 5).length, 2);
});

test('overlapping tiles: the later one wins', async () => {
  const s = begin();
  s.bin(cmdScreen(32, 24));
  s.bin(cmdTile(0, 0, solid(32, 24, RED)));
  s.bin(cmdTile(0, 0, solid(16, 8, GREEN)));
  s.bin(cmdDisplays([1], 1));
  const r = await s.promise;
  assert.equal(r.tiles, 2);
  const img = dec(r);
  near(px(img, 8, 4), GREEN);
  near(px(img, 24, 16), RED);
});

test('two displays: selected is not the primary -> SETDISPLAY once, completes on the new frame', async () => {
  const s = begin();
  s.bin(cmdScreen(32, 24));
  s.bin(cmdTile(0, 0, solid(32, 24, RED))); // display 1 frame (complete, but wrong display)
  s.bin(cmdDisplays([1, 2], 1));
  assert.equal(s.ws.sent.length, 3); // '2', compression, unpause
  s.bin(cmdInfo([{ id: 1, x: -1920, y: 0, w: 1920, h: 1080 }, { id: 2, x: 0, y: 0, w: 32, h: 24 }]));
  const sets = s.ws.sent.filter((m) => Buffer.isBuffer(m) && m[1] === 12);
  assert.equal(sets.length, 1);
  assert.deepEqual([...sets[0]], [0, 12, 0, 6, 0, 2]);
  s.bin(cmdTile(0, 0, solid(32, 24, RED))); // stale tile of the old frame is ignored
  s.bin(cmdDisplays([1, 2], 1)); // stale info is ignored too
  s.bin(cmdScreen(32, 24)); // display 2
  s.bin(cmdTile(0, 0, solid(32, 24, GREEN)));
  const r = await s.promise;
  assert.equal(r.display, 2);
  assert.equal(r.primaryKnown, true);
  near(px(dec(r), 16, 12), GREEN);
  assert.equal(s.ws.sent.filter((m) => Buffer.isBuffer(m) && m[1] === 12).length, 1);
  assertOnlyAllowed(s.ws.sent);
});

test('selected 65535 with two displays and a known primary -> switch to the primary', async () => {
  const s = begin();
  s.bin(cmdDisplays([1, 2, 65535], 65535));
  s.bin(cmdInfo([{ id: 2, x: 0, y: 0, w: 32, h: 24 }, { id: 1, x: 32, y: 0, w: 32, h: 24 }]));
  assert.deepEqual([...s.ws.sent[1]], [0, 12, 0, 6, 0, 2]);
  s.bin(cmdScreen(32, 24));
  s.bin(cmdTile(0, 0, solid(32, 24, BLUE)));
  const r = await s.promise;
  assert.equal(r.display, 2);
});

test('selected 65535, two displays, no primary known -> EKVMPRIMARY after the grace', async () => {
  const s = begin();
  s.bin(cmdScreen(32, 24));
  s.bin(cmdTile(0, 0, solid(32, 24, RED)));
  s.bin(cmdDisplays([1, 2, 65535], 65535));
  assert.equal(s.timers.fire(50), true);
  await rejectsWith(s.promise, 'EKVMPRIMARY');
  assert.equal(s.ws.closed, 1);
});

test('two displays, no primary known, a single display selected -> accepted with primaryKnown false', async () => {
  const s = begin();
  s.bin(cmdScreen(32, 24));
  s.bin(cmdTile(0, 0, solid(32, 24, RED)));
  s.bin(cmdDisplays([1, 2], 2));
  s.timers.fire(50);
  const r = await s.promise;
  assert.equal(r.primaryKnown, false);
  assert.equal(r.display, 2);
});

test('one display: no SETDISPLAY; no display list at all: accepted after the grace', async () => {
  const a = begin();
  a.bin(cmdScreen(32, 24));
  a.bin(cmdTile(0, 0, solid(32, 24, RED)));
  a.bin(cmdDisplays([1], 1));
  a.bin(cmdInfo([{ id: 1, x: 0, y: 0, w: 32, h: 24 }]));
  const ra = await a.promise;
  assert.equal(ra.primaryKnown, true);
  assert.equal(a.ws.sent.filter((m) => Buffer.isBuffer(m) && m[1] === 12).length, 0);

  const b = begin();
  b.bin(cmdScreen(32, 24));
  b.bin(cmdTile(0, 0, solid(32, 24, RED)));
  let done = false;
  b.promise.then(() => { done = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false);
  b.timers.fire(50);
  const rb = await b.promise;
  assert.equal(rb.display, null);
  assert.equal(b.ws.sent.filter((m) => Buffer.isBuffer(m) && m[1] === 12).length, 0);

  // A list that names no display (count 0, selected 0) with one display at the origin: never a SETDISPLAY, which might never be answered.
  const c = begin();
  c.bin(cmdScreen(32, 24));
  c.bin(cmdDisplays([], 0));
  c.bin(cmdInfo([{ id: 1, x: 0, y: 0, w: 32, h: 24 }]));
  c.bin(cmdTile(0, 0, solid(32, 24, RED)));
  const rc = await c.promise;
  assert.equal(rc.primaryKnown, true);
  assert.equal(c.ws.sent.filter((m) => Buffer.isBuffer(m) && m[1] === 12).length, 0);
});

test('COPYRECT before the frame is complete -> EKVMCOPY', async () => {
  const s = begin();
  s.bin(cmdScreen(64, 48));
  s.bin(cmdTile(0, 0, solid(32, 24, RED)));
  s.bin(Buffer.from([0, 4, 0, 12, 0, 0, 0, 0, 0, 8, 0, 8]));
  await rejectsWith(s.promise, 'EKVMCOPY');
  assert.equal(s.ws.closed, 1);
});

test('bad tiles -> EKVMTILE', async () => {
  const a = begin();
  a.bin(cmdScreen(64, 48));
  a.bin(cmdTile(0, 0, Buffer.from('definitely not a jpeg')));
  await rejectsWith(a.promise, 'EKVMTILE');

  const b = begin();
  b.bin(cmdScreen(64, 48));
  b.bin(cmdTile(40, 0, solid(32, 24, RED))); // 72 > 64
  await rejectsWith(b.promise, 'EKVMTILE');

  const c = begin();
  c.bin(cmdScreen(64, 48));
  c.bin(cmdTile(0, 30, solid(32, 24, RED))); // 54 > 48
  await rejectsWith(c.promise, 'EKVMTILE');
});

test('screen size limits -> EKVMSIZE', async () => {
  for (const [w, h] of [[0, 10], [10, 0], [16385, 10], [10, 16385], [8000, 6000]]) {
    const s = begin();
    s.bin(cmdScreen(w, h));
    await rejectsWith(s.promise, 'EKVMSIZE');
  }
});

test('too many tiles or too many bytes -> EKVMBIG', async () => {
  const a = begin();
  a.bin(cmdScreen(64, 48));
  const t = cmdTile(0, 0, solid(8, 8, RED));
  for (let i = 0; i < 50001 && a.ws.closed === 0; i++) a.bin(t);
  await rejectsWith(a.promise, 'EKVMBIG');

  const b = begin();
  const big = Buffer.alloc(70 * 1024 * 1024);
  b.bin(big);
  b.bin(big);
  await rejectsWith(b.promise, 'EKVMBIG');
});

test('socket closing or erroring early -> EKVMCLOSED', async () => {
  const a = begin();
  a.ws.emit('close');
  await rejectsWith(a.promise, 'EKVMCLOSED');
  assert.equal(a.ws.closed, 1);
  const b = begin();
  b.ws.emit('error', new Error('boom'));
  await rejectsWith(b.promise, 'EKVMCLOSED');
});

test('timeout -> EKVMTIMEOUT, socket closed, timers cleared', async () => {
  const s = begin();
  s.bin(cmdScreen(64, 48));
  assert.equal(s.timers.fire(5000), true);
  await assert.rejects(s.promise, (e) => e.code === 'EKVMTIMEOUT' && /did not arrive in time/.test(e.message));
  assert.equal(s.ws.closed, 1);
  assert.equal(s.ws.listenerCount('message'), 0);
  assert.equal(s.ws.listenerCount('close'), 0);
});

test('after settling: listeners removed, timers cleared, settles once, further traffic ignored', async () => {
  const s = begin();
  quadrants(s);
  s.bin(cmdDisplays([1], 1));
  await s.promise;
  assert.equal(s.ws.listenerCount('message'), 0);
  assert.equal(s.ws.listenerCount('close'), 0);
  assert.ok(s.timers.list.every((t) => t.cleared || t.fired));
  assert.equal(s.ws.closed, 1);
  const before = s.ws.sent.length;
  s.ws.emit('close'); // no listener left; must not throw
  s.ws.emit('error', new Error('late')); // must not throw
  assert.equal(s.ws.sent.length, before);
  assert.equal(s.ws.closed, 1);
});

test('only 2, compression, unpause and SETDISPLAY are ever sent (no input commands)', async () => {
  const s = begin();
  s.bin(cmdScreen(32, 24));
  s.bin(cmdDisplays([1, 2], 1));
  s.bin(cmdInfo([{ id: 2, x: 0, y: 0, w: 32, h: 24 }, { id: 1, x: 32, y: 0, w: 32, h: 24 }]));
  s.bin(cmdScreen(32, 24));
  s.bin(cmdTile(0, 0, solid(32, 24, RED)));
  await s.promise;
  assert.deepEqual(s.ws.sent.map((m) => (m === '2' ? '2' : m[1])), ['2', 5, 8, 12, 5, 8]);
  assertOnlyAllowed(s.ws.sent);
  for (const m of s.ws.sent) if (m !== '2') assert.ok(![1, 2, 6, 10, 15, 16].includes(m[1]));
});

test('bad maxWidth or quality are rejected', async () => {
  const ws = new FakeWs();
  for (const o of [{ maxWidth: 100 }, { maxWidth: 2000 }, { maxWidth: 800.5 }, { maxWidth: '800' }, { quality: 5 }, { quality: 101 }, { quality: 70.5 }]) {
    await rejectsWith(captureDesktop(ws, o), 'EBADARG');
  }
  assert.equal(ws.listenerCount('message'), 0);
});
