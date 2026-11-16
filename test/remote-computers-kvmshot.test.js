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
function assertOnlyAllowed(sent, observe = false) {
  for (const m of sent) {
    if (m === '2') continue;
    assert.ok(Buffer.isBuffer(m), 'binary sends are Buffers');
    const cmd = (m[0] << 8) | m[1];
    assert.ok((observe ? [6, 11] : [5, 8, 11, 12]).includes(cmd), 'unexpected command ' + cmd);
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
  assert.equal(s.ws.sent.length, 4);
  assert.deepEqual([...s.ws.sent[1]], [0x00, 0x05, 0x00, 0x0a, 1, 70, 0x04, 0x00, 0x00, 100]);
  assert.deepEqual([...s.ws.sent[2]], [0x00, 0x08, 0x00, 0x05, 0x00]);
  assert.deepEqual([...s.ws.sent[3]], [0x00, 0x0b, 0x00, 0x04], 'get-displays, like the MeshCentral viewer');
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
  assert.equal(s.ws.sent.length, 4); // '2', compression, unpause, get-displays
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
  b.bin(cmdTile(64, 0, solid(32, 24, RED))); // starts at the right edge
  await rejectsWith(b.promise, 'EKVMTILE');

  const c = begin();
  c.bin(cmdScreen(64, 48));
  c.bin(cmdTile(0, 48, solid(32, 24, RED))); // starts at the bottom edge
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

test('only 2, compression, unpause, get-displays and SETDISPLAY are ever sent (no input commands)', async () => {
  const s = begin();
  s.bin(cmdScreen(32, 24));
  s.bin(cmdDisplays([1, 2], 1));
  s.bin(cmdInfo([{ id: 2, x: 0, y: 0, w: 32, h: 24 }, { id: 1, x: 32, y: 0, w: 32, h: 24 }]));
  s.bin(cmdScreen(32, 24));
  s.bin(cmdTile(0, 0, solid(32, 24, RED)));
  await s.promise;
  assert.deepEqual(s.ws.sent.map((m) => (m === '2' ? '2' : m[1])), ['2', 5, 8, 11, 12, 5, 8]);
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

// ---------- r2 additions ----------
test('tiles are decoded when they arrive, with limits from the tile header', async () => {
  const calls = [];
  const s = begin({ decode: (buf, opts) => { calls.push(opts); return jpeg.decode(buf, opts); } });
  s.bin(cmdScreen(64, 48));
  s.bin(cmdTile(0, 0, solid(32, 24, RED)));
  assert.equal(calls.length, 1, 'decoded at once, before the frame is complete');
  assert.deepEqual(calls[0], { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 0.01, maxMemoryUsageInMB: 17 });
  s.bin(cmdTile(32, 0, solid(32, 24, GREEN)));
  s.bin(cmdTile(0, 24, solid(32, 24, BLUE)));
  s.bin(cmdTile(32, 24, solid(32, 24, YELLOW)));
  s.bin(cmdDisplays([1], 1));
  const r = await s.promise;
  assert.equal(calls.length, 4, 'not decoded again at completion');
  near(px(dec(r), 48, 36), YELLOW);

  const big = [];
  const t = begin({ decode: (buf, opts) => { big.push(opts); return jpeg.decode(buf, opts); } });
  t.bin(cmdScreen(480, 540));
  t.bin(cmdTile(0, 0, solid(480, 540, RED)));
  assert.equal(big[0].maxResolutionInMP, 0.26);
  assert.equal(big[0].maxMemoryUsageInMB, 22);   // ceil(259200 * 24 / 1048576) + 16
  t.ws.emit('close');
  await rejectsWith(t.promise, 'EKVMCLOSED');
  // A tile that cannot be decoded within its own limits is a bad tile.
  const u = begin({ decode: () => { throw new Error('over the limit'); } });
  u.bin(cmdScreen(64, 48));
  u.bin(cmdTile(0, 0, solid(32, 24, RED)));
  await rejectsWith(u.promise, 'EKVMTILE');
});

test('overlap bomb: tiles that re-cover the same area beyond the budget -> EKVMBIG quickly', async () => {
  let decoded = 0;
  const s = begin({ decode: (buf, opts) => { decoded++; return jpeg.decode(buf, opts); } });
  s.bin(cmdScreen(1000, 1000));
  const t = cmdTile(0, 0, solid(1000, 1000, RED));   // the whole screen, claimed again and again: 4 screens + slack are allowed
  for (let i = 0; i < 12 && s.ws.closed === 0; i++) s.bin(t);
  await assert.rejects(s.promise, (e) => e.code === 'EKVMBIG' && /far more picture/.test(e.message));
  assert.ok(decoded <= 9, 'stopped after ' + decoded);
  assert.equal(s.ws.closed, 1);
});

test('a tile that overhangs the right or bottom edge is clipped, not refused', async () => {
  const s = begin();
  s.bin(cmdScreen(64, 48));
  s.bin(cmdTile(0, 0, solid(64, 24, RED)));
  s.bin(cmdTile(40, 24, solid(32, 40, BLUE)));   // 72 > 64 and 64 > 48
  s.bin(cmdTile(0, 24, solid(40, 24, GREEN)));
  s.bin(cmdDisplays([1], 1));
  const r = await s.promise;
  const img = dec(r);
  near(px(img, 60, 40), BLUE);
  near(px(img, 63, 47), BLUE);
  near(px(img, 10, 40), GREEN);
  near(px(img, 10, 10), RED);
});

test('a tile that starts at or beyond the edge -> EKVMTILE', async () => {
  for (const [x, y] of [[64, 0], [0, 48], [100, 100]]) {
    const s = begin();
    s.bin(cmdScreen(64, 48));
    s.bin(cmdTile(x, y, solid(8, 8, RED)));
    await rejectsWith(s.promise, 'EKVMTILE');
  }
});

test('COPYRECT is refused at any time: before any screen, mid-frame, and after full coverage during the display grace', async () => {
  const copy = Buffer.from([0, 4, 0, 12, 0, 0, 0, 0, 0, 8, 0, 8]);
  const a = begin();
  a.bin(copy);
  await rejectsWith(a.promise, 'EKVMCOPY');
  const b = begin();
  b.bin(cmdScreen(32, 24));
  b.bin(cmdTile(0, 0, solid(32, 24, RED)));
  b.bin(cmdDisplays([1, 2], 1));   // complete, but waiting for display info
  assert.equal(b.timers.list.some((t) => t.ms === 50 && !t.cleared), true, 'in the grace');
  b.bin(copy);
  await rejectsWith(b.promise, 'EKVMCOPY');
  assert.equal(b.ws.closed, 1);
});

test('a SCREEN of the same size while collecting is ignored: no reset and no sends', async () => {
  const s = begin();
  s.bin(cmdScreen(64, 48));
  s.bin(cmdTile(0, 0, solid(32, 24, RED)));
  s.bin(cmdTile(32, 0, solid(32, 24, GREEN)));
  const sent = s.ws.sent.length;
  s.bin(cmdScreen(64, 48));
  s.bin(cmdScreen(64, 48));
  assert.equal(s.ws.sent.length, sent);
  s.bin(cmdTile(0, 24, solid(32, 24, BLUE)));
  s.bin(cmdTile(32, 24, solid(32, 24, YELLOW)));
  s.bin(cmdDisplays([1], 1));
  const r = await s.promise;
  near(px(dec(r), 16, 12), RED);   // the earlier tiles were kept
  near(px(dec(r), 48, 36), YELLOW);
  assert.equal(s.ws.sent.filter((m) => Buffer.isBuffer(m) && m[1] === 5).length, 1);
});

test('one display known from 82 or from 11 alone: the frame is ready without the grace', async () => {
  const a = begin();
  a.bin(cmdScreen(32, 24));
  a.bin(cmdTile(0, 0, solid(32, 24, RED)));
  a.bin(cmdInfo([{ id: 1, x: 0, y: 0, w: 32, h: 24 }]));
  const ra = await a.promise;
  assert.equal(ra.onPrimary, true);
  assert.equal(ra.primaryKnown, true);
  assert.equal(a.timers.list.some((t) => t.ms === 50 && t.fired), false);

  const b = begin();
  b.bin(cmdScreen(32, 24));
  b.bin(cmdTile(0, 0, solid(32, 24, RED)));
  b.bin(Buffer.from([0, 11, 0, 8, 0, 1, 0, 7]));   // malformed (no selected id): ignored, so nothing is known yet
  b.bin(cmdDisplays([7], 7));
  const rb = await b.promise;
  assert.equal(rb.onPrimary, true);
  assert.equal(rb.display, 7);
});

test('a socket that is already closing or closed -> EKVMCLOSED at once', async () => {
  for (const state of [2, 3]) {
    const ws = new FakeWs();
    ws.readyState = state;
    await rejectsWith(captureDesktop(ws, { timeoutMs: 5000 }), 'EKVMCLOSED');
    assert.equal(ws.listenerCount('message'), 0);
  }
  const ok = new FakeWs();
  ok.readyState = 1;
  const p = captureDesktop(ok, { timeoutMs: 5000 });
  ok.emit('close');
  await rejectsWith(p, 'EKVMCLOSED');
});

test('onPrimary: true for the primary or a single display, false otherwise', async () => {
  const a = begin();
  a.bin(cmdScreen(32, 24));
  a.bin(cmdTile(0, 0, solid(32, 24, RED)));
  a.bin(cmdDisplays([1, 2], 2));
  a.bin(cmdInfo([{ id: 2, x: 0, y: 0, w: 32, h: 24 }, { id: 1, x: 32, y: 0, w: 32, h: 24 }]));
  const ra = await a.promise;
  assert.equal(ra.onPrimary, true);
  const b = begin();
  b.bin(cmdScreen(32, 24));
  b.bin(cmdTile(0, 0, solid(32, 24, RED)));
  b.bin(cmdDisplays([1, 2], 2));
  b.timers.fire(50);
  const rb = await b.promise;
  assert.equal(rb.primaryKnown, false);
  assert.equal(rb.onPrimary, false);
  // An explicit list naming no display or one display (MeshCentral's viewer reads a count of 0 as "no multiple displays"): one screen, clickable.
  // The bare 6-byte form of a list of 0 (no selected id) counts too.
  for (const info of [cmdDisplays([], 0), Buffer.from([0, 11, 0, 6, 0, 0]), cmdDisplays([1], 1), cmdDisplays([1, 65535], 1)]) {
    const c = begin();
    c.bin(cmdScreen(32, 24));
    c.bin(cmdTile(0, 0, solid(32, 24, RED)));
    c.bin(info);
    c.timers.fire(50);
    const rc = await c.promise;
    assert.equal(rc.onPrimary, true);
    assert.equal(rc.primaryKnown, true);
  }
  // No display message at all: unknown. The picture is returned but never as the proven main screen.
  const u = begin();
  u.bin(cmdScreen(32, 24));
  u.bin(cmdTile(0, 0, solid(32, 24, RED)));
  u.timers.fire(50);
  const ru = await u.promise;
  assert.equal(ru.onPrimary, false);
  assert.equal(ru.primaryKnown, false);
  // A 82 with one entry proves one display, wherever it is; two entries do not.
  const v = begin();
  v.bin(cmdScreen(32, 24));
  v.bin(cmdTile(0, 0, solid(32, 24, RED)));
  v.bin(cmdInfo([{ id: 3, x: 0, y: 0, w: 32, h: 24 }]));
  const rv = await v.promise;
  assert.equal(rv.onPrimary, true);
  assert.equal(rv.primaryKnown, true);
});

test('memory ceiling: 16.8 MP at most; dual 4K and 5K fit, 8K and 36 MP do not', async () => {
  assert.equal(kvm.LIMITS.maxPixels, 16800000);
  for (const [w, h] of [[7680, 2160], [5120, 2880]]) {   // 16.6 MP and 14.7 MP
    const s = begin();
    s.bin(cmdScreen(w, h));
    assert.equal(s.ws.sent.length, 4);
    s.ws.emit('close');
    await rejectsWith(s.promise, 'EKVMCLOSED');
  }
  for (const [w, h] of [[7680, 4320], [6000, 6000], [7000, 5200]]) {
    const s = begin();
    s.bin(cmdScreen(w, h));
    await rejectsWith(s.promise, 'EKVMSIZE');
  }
});

test('a tile reaching 64 px or more past the right or bottom edge -> EKVMTILE with a plain reason, before any decode', async () => {
  for (const [w, h] of [[128, 48], [64, 112], [200, 200]]) {   // screen 64x48: 64 + 64 = 128 wide, 48 + 64 = 112 high
    let decoded = 0;
    const s = begin({ decode: (buf, opts) => { decoded++; return jpeg.decode(buf, opts); } });
    s.bin(cmdScreen(64, 48));
    s.bin(cmdTile(0, 0, solid(w, h, RED)));
    await assert.rejects(s.promise, (e) => e instanceof KvmError && e.code === 'EKVMTILE' && e.message === 'A piece of the screen reached past its edge.');
    assert.equal(decoded, 0, `${w}x${h}`);
    assert.equal(s.ws.closed, 1);
  }
  // 63 px past the edge is still padding: cropped
  const ok = begin();
  ok.bin(cmdScreen(64, 48));
  ok.bin(cmdTile(0, 0, solid(127, 111, GREEN)));
  ok.timers.fire(50);   // no display list: the grace decides
  const r = await ok.promise;
  assert.equal(r.screenWidth, 64);
  assert.equal(r.screenHeight, 48);
  // Away from the corner too, and each half of the check on its own: a tile at (40, 24) on 64x48.
  for (const [w, h, refused] of [[87, 87, false], [88, 24, true], [24, 88, true], [88, 88, true]]) {
    const s = begin();
    s.bin(cmdScreen(64, 48));
    s.bin(cmdTile(0, 0, solid(64, 48, BLUE)));
    s.bin(cmdTile(40, 24, solid(w, h, GREEN)));
    if (refused) {
      await assert.rejects(s.promise, (e) => e instanceof KvmError && e.code === 'EKVMTILE' && e.message === 'A piece of the screen reached past its edge.', `${w}x${h}`);
    } else {
      s.timers.fire(50);
      const rr = await s.promise;
      near(px(dec(rr), 50, 30), GREEN);
      near(px(dec(rr), 10, 10), BLUE);
    }
  }
});

test('an unexpected error inside the capture keeps a fixed sentence; its own text is only in detail', async () => {
  const s = start({ observe: () => { throw new TypeError('private detail 42'); } });
  s.text('c');   // the handshake asks the observe function, which throws
  await assert.rejects(s.promise, (e) => e instanceof KvmError && e.code === 'EKVMFAIL' && e.message === 'The screen capture failed.' && e.detail === 'private detail 42');
  assert.equal(s.ws.closed, 1);
});

// The real agent's frame, rebuilt with synthetic pixels: a 1920x1080 screen sent as ONE JPEG of 1920x1088 (its capture buffer padded
// to a multiple of 16), in the agent's own message order: SCREEN, display info (one display, id 1, at 0,0, 1920x1080) and a display
// list of 0 (8 bytes, selected 0), each repeated, a second same-size SCREEN, then commands 88 and 18 (5 bytes) before the tile.
test('a full-screen tile padded past the bottom edge (1920x1088 on 1920x1080) is cropped; the real message order gives a clickable picture', async () => {
  const W = 1920, H = 1080, PAD_H = 1088;
  const data = Buffer.alloc(W * PAD_H * 4);
  for (let y = 0; y < PAD_H; y++) {
    const c = y >= H ? RED : (y < H / 2 ? BLUE : GREEN);   // the padding rows are red and must never show
    for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255; }
  }
  const tile = Buffer.from(jpeg.encode({ data, width: W, height: PAD_H }, 80).data);
  assert.deepEqual(kvm.jpegSize(tile), { width: W, height: PAD_H });
  const info = Buffer.from([0x00, 0x52, 0x00, 0x0e, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x07, 0x80, 0x04, 0x38]);
  const list0 = Buffer.from([0x00, 0x0b, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00]);
  const s = begin({ maxWidth: 1920 });
  s.bin(cmdScreen(W, H));
  s.bin(info); s.bin(info); s.bin(list0);
  s.bin(cmdScreen(W, H));
  s.bin(info); s.bin(list0); s.bin(info); s.bin(list0);
  s.bin(Buffer.from([0x00, 0x58, 0x00, 0x05, 0x00]));
  s.bin(Buffer.from([0x00, 0x12, 0x00, 0x05, 0x00]));
  s.bin(Buffer.from([0x00, 0x58, 0x00, 0x05, 0x0e]));
  s.bin(jumbo(cmdTile(0, 0, tile)));
  const r = await s.promise;
  assert.equal(r.width, W);
  assert.equal(r.height, H);
  assert.equal(r.screenWidth, W);
  assert.equal(r.screenHeight, H);
  assert.equal(r.onPrimary, true, 'one display at the origin, list of 0: clickable');
  assert.equal(r.primaryKnown, true);
  assert.equal(s.ws.sent.filter((m) => Buffer.isBuffer(m) && m[1] === 12).length, 0, 'no SETDISPLAY');
  assertOnlyAllowed(s.ws.sent);
  const img = dec(r);
  near(px(img, 100, 10), BLUE);
  near(px(img, 100, H - 2), GREEN, 40);   // the last real row is green, not the red padding
});

test('decode memory limit follows the tile area: ceil(area * 24 / 1 MiB) + 16 (enough for 4:4:4 colour)', async () => {
  const seen = [];
  const s = begin({ decode: (buf, opts) => { seen.push(opts); return jpeg.decode(buf, opts); } });
  s.bin(cmdScreen(1000, 1000));
  s.bin(cmdTile(0, 0, solid(1000, 1000, RED)));
  assert.equal(seen[0].maxMemoryUsageInMB, Math.ceil((1000 * 1000 * 24) / 1048576) + 16);
  assert.equal(seen[0].maxResolutionInMP, 1);
  s.ws.emit('close');
  await rejectsWith(s.promise, 'EKVMCLOSED');
});

test('frame resets: more than 4 in one capture -> EKVMBIG, and a SCREEN alone allocates nothing', async () => {
  const s = begin();
  const t0 = Date.now();
  let n = 0;
  // 16.6 MP and 16.5 MP alternately: a canvas for each would be hundreds of MB and seconds of work.
  for (; n < 1000 && s.ws.closed === 0; n++) s.bin(n % 2 ? cmdScreen(7680, 2160) : cmdScreen(7680, 2150));
  await assert.rejects(s.promise, (e) => e.code === 'EKVMBIG' && /changed size too often/.test(e.message));
  assert.equal(n, 5, 'the fifth reset is the one refused');
  assert.ok(Date.now() - t0 < 1000, 'no canvas was allocated');
  // SETDISPLAY switches count too.
  const d = begin();
  d.bin(cmdScreen(32, 24));                                   // 1
  d.bin(cmdDisplays([1, 2], 1));
  d.bin(cmdInfo([{ id: 2, x: 0, y: 0, w: 32, h: 24 }, { id: 1, x: 32, y: 0, w: 32, h: 24 }]));   // 2 (switch)
  d.bin(cmdScreen(32, 24));                                   // 3
  d.bin(cmdScreen(16, 12));                                   // 4
  d.bin(cmdScreen(32, 24));                                   // 5
  await rejectsWith(d.promise, 'EKVMBIG');
});

test('get-displays is sent once, after the first SCREEN, in both modes', async () => {
  const GET = [0, 11, 0, 4];
  const a = begin();
  a.bin(cmdScreen(32, 24));
  a.bin(cmdScreen(16, 12));
  a.bin(cmdScreen(32, 24));
  assert.equal(a.ws.sent.filter((m) => Buffer.isBuffer(m) && m[1] === 11).length, 1);
  assert.deepEqual([...a.ws.sent.find((m) => Buffer.isBuffer(m) && m[1] === 11)], GET);
  a.ws.emit('close');
  await rejectsWith(a.promise, 'EKVMCLOSED');
  const b = begin({ observe: true });
  assert.equal(b.ws.sent.length, 2, 'not before the first SCREEN');
  b.bin(cmdScreen(32, 24));
  b.bin(cmdScreen(16, 12));
  assert.deepEqual(b.ws.sent.map((m) => (m === '2' ? '2' : m[1])), ['2', 6, 11]);
  assert.deepEqual([...b.ws.sent[2]], GET);
  b.ws.emit('close');
  await rejectsWith(b.promise, 'EKVMCLOSED');
});

test('a malformed display list (11) is ignored; a valid one is exact in size', async () => {
  const s = begin();
  s.bin(cmdScreen(32, 24));
  s.bin(cmdTile(0, 0, solid(32, 24, RED)));
  s.bin(Buffer.from([0, 11, 0, 10, 0, 2, 0, 1, 0, 2]));          // count 2 but only room for 1 id and no selected
  s.bin(Buffer.from([0, 11, 0, 12, 0, 1, 0, 1, 0, 1, 0, 9]));    // too long for count 1
  let done = false;
  s.promise.then(() => { done = true; }, () => { done = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false, 'nothing was learnt from them');
  s.timers.fire(50);
  const r = await s.promise;
  assert.equal(r.display, null);
  assert.equal(r.onPrimary, false);
  assert.equal(r.primaryKnown, false);
});

test('an observe function that turns true after the SCREEN: nothing that changes the view is sent afterwards', async () => {
  let calls = 0;
  let flip = false;
  const s = begin({ observe: () => { calls++; return flip; } });
  s.bin(cmdScreen(32, 24));
  assert.ok(calls >= 2, 'asked before compression and unpause');
  assert.deepEqual(s.ws.sent.map((m) => (m === '2' ? '2' : m[1])), ['2', 5, 8, 11]);
  flip = true;
  s.bin(cmdDisplays([1, 2], 1));
  s.bin(cmdInfo([{ id: 2, x: 0, y: 0, w: 32, h: 24 }, { id: 1, x: 32, y: 0, w: 32, h: 24 }]));   // would switch to 2
  s.bin(cmdScreen(16, 12));   // would send compression and unpause
  s.bin(cmdTile(0, 0, solid(16, 12, GREEN)));
  const r = await s.promise;
  // the flip is noticed before the switch: no SETDISPLAY, no compression, no unpause; one REFRESH asks for the whole screen
  assert.deepEqual(s.ws.sent.map((m) => (m === '2' ? '2' : m[1])), ['2', 5, 8, 11, 6]);
  assert.equal(r.display, 1);
  assert.equal(r.onPrimary, false, 'from then on only a proven primary counts');
  assert.equal(r.primaryKnown, false);
  // a person already views the desktop (the function is true from the start, as server.js passes it): REFRESH right after the
  // handshake, then only the display-list question
  const t = begin({ observe: () => true });
  assert.deepEqual(t.ws.sent.map((m) => (m === '2' ? '2' : m[1])), ['2', 6]);
  t.bin(cmdScreen(32, 24));
  assert.deepEqual(t.ws.sent.map((m) => (m === '2' ? '2' : m[1])), ['2', 6, 11]);
  t.bin(cmdScreen(16, 12));
  assert.deepEqual(t.ws.sent.map((m) => (m === '2' ? '2' : m[1])), ['2', 6, 11], 'REFRESH only once');
  t.ws.emit('close');
  await rejectsWith(t.promise, 'EKVMCLOSED');
  // a function that stays false behaves as the normal mode
  const u = begin({ observe: () => false });
  u.bin(cmdScreen(32, 24));
  assert.deepEqual(u.ws.sent.map((m) => (m === '2' ? '2' : m[1])), ['2', 5, 8, 11]);
  u.ws.emit('close');
  await rejectsWith(u.promise, 'EKVMCLOSED');
});

test('a same-size SCREEN after SETDISPLAY (selected is now the primary) is processed, not ignored', async () => {
  const s = begin();
  s.bin(cmdScreen(32, 24));
  s.bin(cmdTile(0, 0, solid(32, 24, RED)));
  s.bin(cmdDisplays([1, 2], 1));
  s.bin(cmdInfo([{ id: 2, x: 0, y: 0, w: 32, h: 24 }, { id: 1, x: 32, y: 0, w: 32, h: 24 }]));
  assert.equal(s.ws.sent.filter((m) => Buffer.isBuffer(m) && m[1] === 12).length, 1);
  s.bin(cmdScreen(32, 24));   // the new display, same size
  s.bin(cmdTile(0, 0, solid(32, 24, BLUE)));
  const r = await s.promise;
  assert.equal(r.display, 2);
  assert.equal(r.onPrimary, true);
  near(px(dec(r), 16, 12), BLUE);
});

test('observe mode: sends only 2, REFRESH and get-displays, never switches, and says whether the picture is the primary display', async () => {
  const REFRESH = [0, 6, 0, 4];
  // two displays, selected is not the primary: no SETDISPLAY, no compression, no unpause
  const a = begin({ observe: true });
  assert.equal(a.ws.sent.length, 2);
  assert.equal(a.ws.sent[0], '2');
  assert.deepEqual([...a.ws.sent[1]], REFRESH);
  a.bin(cmdScreen(32, 24));
  a.bin(cmdScreen(32, 24));
  a.bin(cmdDisplays([1, 2], 1));
  a.bin(cmdInfo([{ id: 2, x: 0, y: 0, w: 32, h: 24 }, { id: 1, x: 32, y: 0, w: 32, h: 24 }]));
  a.bin(cmdTile(0, 0, solid(32, 24, RED)));
  const ra = await a.promise;
  assert.equal(ra.primaryKnown, false);
  assert.equal(ra.onPrimary, false);
  assert.equal(ra.display, 1);
  assert.equal(a.ws.sent.length, 3);   // '2', REFRESH, get-displays (once)
  assertOnlyAllowed(a.ws.sent, true);

  // selected is the primary: proven
  const b = begin({ observe: true });
  b.bin(cmdScreen(32, 24));
  b.bin(cmdDisplays([1, 2], 2));
  b.bin(cmdInfo([{ id: 2, x: 0, y: 0, w: 32, h: 24 }, { id: 1, x: 32, y: 0, w: 32, h: 24 }]));
  b.bin(cmdTile(0, 0, solid(32, 24, GREEN)));
  const rb = await b.promise;
  assert.equal(rb.primaryKnown, true);
  assert.equal(rb.onPrimary, true);
  assert.deepEqual(b.ws.sent.map((m) => (m === '2' ? '2' : m[1])), ['2', 6, 11]);

  // one display: proven; two displays and nothing known: not proven, after the grace, even for All displays
  const c = begin({ observe: true });
  c.bin(cmdScreen(32, 24));
  c.bin(cmdTile(0, 0, solid(32, 24, RED)));
  c.bin(cmdDisplays([1], 1));
  const rc = await c.promise;
  assert.equal(rc.primaryKnown, true);
  const d = begin({ observe: true });
  d.bin(cmdScreen(32, 24));
  d.bin(cmdTile(0, 0, solid(32, 24, RED)));
  d.bin(cmdDisplays([1, 2, 65535], 65535));
  d.timers.fire(50);
  const rd = await d.promise;
  assert.equal(rd.primaryKnown, false);
  assert.equal(rd.onPrimary, false);
  assert.deepEqual(d.ws.sent.map((m) => (m === '2' ? '2' : m[1])), ['2', 6, 11]);
});
