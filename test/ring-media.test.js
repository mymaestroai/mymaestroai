'use strict';
// Ring media: stills, live video wiring, clips, frame sheet, pruning, times. The store is the real one (modules/ring/lib/store.js,
// with its pinned-descriptor helpers); the API and the child processes are stand-ins.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { execFileSync } = require('node:child_process');
const media = require('../modules/ring/lib/media');

const { createMedia } = media;
const { createStore } = require('../modules/ring/lib/store');
function setup(over = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ring-media-'));
  const mediaDir = path.join(tmp, 'media'), data = path.join(tmp, 'data'), decoy = path.join(tmp, 'decoy');
  for (const d of [mediaDir, data, decoy]) fs.mkdirSync(d, { recursive: true });
  const logs = [];
  const E = {
    tmp, mediaDir, data, decoy, logs, settings: { time_zone: 'America/New_York' }, clock: Date.now(), calls: [], api: {}, spawn: null,
    env: { CONNECTOR_DATA_HOME: data, CONNECTOR_MEDIA_DIR: mediaDir, RING_TEST: '1', RING_TEST_SNAPSHOT_DELAYS: '1,1,1' },
    ...over,
  };
  E.store = createStore({ dataHome: data, mediaDir, now: () => E.clock, log: (...a) => logs.push(a.join(' ')), freeBytes: over.storeOver && over.storeOver.freeBytes });
  E.make = (extra = {}) => createMedia({
    env: { ...E.env, ...(extra.env || {}) }, settings: () => E.settings, store: E.store, api: E.api, log: (...a) => logs.push(a.join(' ')),
    now: () => E.clock, spawn: (...a) => E.spawn(...a), ...extra.ctx,
  });
  return E;
}
const cleanup = (E) => fs.rmSync(E.tmp, { recursive: true, force: true });
const NY = 'America/New_York';
const dayOf = (msAgo) => new Intl.DateTimeFormat('en-CA', { timeZone: NY, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() - msAgo));
function put(dir, name, bytes, msAgo) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, Buffer.alloc(bytes, 1));
  const t = (Date.now() - msAgo) / 1000;
  fs.utimesSync(f, t, t);
  return f;
}
const exists = (f) => { try { fs.lstatSync(f); return true; } catch { return false; } };
const textOf = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const H = 3600000, D = 86400000;
const CLIP_RE = /^\d{4}-[a-z0-9-]+\.(mp4|jpg)$/;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 7)]);

test('saveStill: names, a link planted under the next name is skipped, a swapped folder is refused', () => {
  const E = setup();
  try {
    const m = E.make();
    const ts = Date.UTC(2026, 10, 3, 14, 17, 9);   // 09:17:09 in New York
    const a = m.saveStill(Buffer.from('jpeg-a'), false, ts, 'Front Door');
    const b = m.saveStill(Buffer.from('jpeg-b'), false, ts, 'Front Door');
    assert.strictEqual(a, 'events/2026-11-03/0917-front-door.jpg');
    assert.strictEqual(b, 'events/2026-11-03/0917-front-door-09.jpg');
    const events = path.join(E.mediaDir, 'events');
    fs.symlinkSync(path.join(E.decoy, 'planted.jpg'), path.join(events, '2026-11-03', '0917-front-door-09-2.jpg'));
    const c = m.saveStill(Buffer.from('jpeg-c'), false, ts, 'Front Door');
    assert.strictEqual(c, 'events/2026-11-03/0917-front-door-09-3.jpg');
    assert.ok(!exists(path.join(E.decoy, 'planted.jpg')));
    assert.strictEqual(fs.readFileSync(path.join(E.mediaDir, c), 'utf8'), 'jpeg-c');
    assert.strictEqual(fs.statSync(path.join(E.mediaDir, a)).mode & 0o777, 0o664);
    assert.strictEqual(m.saveStill(Buffer.from('x'), true, ts, 'Front Door'), 'events/2026-11-03/0917-front-door.png');

    fs.renameSync(path.join(events, '2026-11-03'), path.join(events, '2026-11-03.real'));
    fs.symlinkSync(E.decoy, path.join(events, '2026-11-03'));
    assert.throws(() => m.saveStill(Buffer.from('jpeg-d'), false, ts, 'Front Door'), /not a plain folder/);
    assert.deepStrictEqual(fs.readdirSync(E.decoy), []);
    fs.unlinkSync(path.join(events, '2026-11-03'));
    fs.renameSync(path.join(events, '2026-11-03.real'), path.join(events, '2026-11-03'));

    // the stills folder itself replaced by a link between two runs
    fs.renameSync(events, `${events}.real`);
    fs.symlinkSync(E.decoy, events);
    assert.throws(() => m.saveStill(Buffer.from('jpeg-e'), false, ts, 'Front Door'), /not a plain folder/);
    assert.deepStrictEqual(fs.readdirSync(E.decoy), []);
  } finally { cleanup(E); }
});

test('saveStill: names run out after 50, the disk reserve is respected, the zone decides the day', () => {
  const E = setup();
  try {
    const m = E.make();
    const ts = Date.UTC(2026, 10, 3, 14, 17, 9);
    const seen = new Set();
    for (let i = 0; i < 51; i++) seen.add(m.saveStill(Buffer.from('j'), false, ts, 'Cam'));
    assert.strictEqual(seen.size, 51);
    assert.ok(seen.has('events/2026-11-03/0917-cam-09-50.jpg'));
    assert.throws(() => m.saveStill(Buffer.from('j'), false, ts, 'Cam'), /too many/);
    assert.strictEqual(media.stillNames({ hour: '09', minute: '17', second: '09' }, 'Cam', false).length, 51);

    let free = 2 * 1024 ** 3 + 5;
    const low = setup({ storeOver: { freeBytes: () => free } });
    try {
      const m2 = low.make();
      assert.throws(() => m2.saveStill(Buffer.alloc(10), false, ts, 'Cam'), /disk is nearly full/);
      assert.deepStrictEqual(fs.readdirSync(low.mediaDir), []);
      assert.ok(m2.saveStill(Buffer.alloc(5), false, ts, 'Cam'));
      free = Infinity;
    } finally { cleanup(low); }

    E.settings = {};   // no zone set: UTC
    assert.strictEqual(E.make().saveStill(Buffer.from('j'), false, Date.UTC(2026, 10, 3, 3, 30, 0), 'Zed'), 'events/2026-11-03/0330-zed.jpg');
    E.settings = { time_zone: 'Not/AZone' };   // invalid: UTC too
    assert.strictEqual(E.make().zone(), 'UTC');
  } finally { cleanup(E); }
});

test('pruneMedia: age, names, links, pipes, kept files, empty folders', () => {
  const E = setup();
  try {
    const m = E.make();
    const CLIPS = path.join(E.mediaDir, 'clips');
    fs.mkdirSync(CLIPS);
    const old = dayOf(40 * D), oldDir = path.join(CLIPS, old);
    const gone = put(oldDir, '0101-cam-live.mp4', 100, 40 * D);
    const keptName = put(oldDir, 'notes.txt', 100, 40 * D);
    const keptListed = put(oldDir, '0102-cam-live.mp4', 100, 40 * D);
    fs.writeFileSync(path.join(E.decoy, '0103-cam-live.mp4'), 'decoy');
    fs.symlinkSync(path.join(E.decoy, '0103-cam-live.mp4'), path.join(oldDir, '0103-cam-live.mp4'));
    const emptyOld = path.join(CLIPS, dayOf(45 * D));
    fs.mkdirSync(emptyOld);
    fs.mkdirSync(path.join(E.decoy, 'inner'));
    fs.writeFileSync(path.join(E.decoy, 'inner', '0104-cam-live.mp4'), 'decoy');
    fs.symlinkSync(path.join(E.decoy, 'inner'), path.join(CLIPS, dayOf(50 * D)));   // a day folder that is a link
    const fifo = path.join(oldDir, '0105-cam-live.mp4');
    execFileSync('mkfifo', [fifo]);
    const n1 = m.pruneMedia(['clips'], CLIP_RE, 30, 1e12, new Set([`clips/${old}/0102-cam-live.mp4`]));
    assert.strictEqual(n1, 1);
    assert.ok(!exists(gone), 'an old clip is removed');
    assert.ok(exists(keptName) && exists(keptListed) && exists(fifo), 'other names, a listed file and a pipe are kept');
    assert.ok(textOf(path.join(E.decoy, '0103-cam-live.mp4')) === 'decoy' && exists(path.join(oldDir, '0103-cam-live.mp4')), 'a link with a clip\'s name is left alone');
    assert.strictEqual(textOf(path.join(E.decoy, 'inner', '0104-cam-live.mp4')), 'decoy', 'a day folder that is a link is never entered');
    assert.ok(!exists(emptyOld), 'an empty day folder is removed');
    assert.ok(exists(path.join(CLIPS, dayOf(50 * D))), 'the linked day folder itself stays');
  } finally { cleanup(E); }
});

test('pruneMedia: over the quota the oldest goes first; nothing younger than 7 hours is ever removed', () => {
  const E = setup();
  try {
    const m = E.make();
    const dir = path.join(E.mediaDir, 'clips', dayOf(0));
    const r1 = put(dir, '0201-cam-live.mp4', 1000, 10 * H);
    const r2 = put(dir, '0202-cam-live.mp4', 1000, 9 * H);
    const r3 = put(dir, '0203-cam-live.mp4', 1000, 8 * H);
    const n = m.pruneMedia(['clips'], CLIP_RE, 30, 2000 + 300 + 100, new Set());
    assert.strictEqual(n, 1);
    assert.ok(!exists(r1) && exists(r2) && exists(r3), 'only as many as needed, oldest first');

    const young = put(dir, '0301-cam-live.mp4', 5000, 6 * H);   // newest and huge, but young
    const young2 = put(dir, '0302-cam-live.mp4', 5000, 60000);
    const n2 = m.pruneMedia(['clips'], CLIP_RE, 30, 10, new Set());
    assert.strictEqual(n2, 2, 'the two old ones go');
    assert.ok(exists(young) && exists(young2), 'files under 7 hours old stay, even over the quota');

    const oldDay = path.join(E.mediaDir, 'clips', dayOf(40 * D));
    const youngInOld = put(oldDir(oldDay), '0401-cam-live.mp4', 10, 2 * H);   // an old day folder name, a young file
    assert.strictEqual(m.pruneMedia(['clips'], CLIP_RE, 30, 1e12, new Set()), 0);
    assert.ok(exists(youngInOld));
  } finally { cleanup(E); }
  function oldDir(d) { return d; }
});

test('pruneMedia: a folder that is not below the media folder does nothing; the root swapped for a link is refused', () => {
  const E = setup();
  try {
    const m = E.make();
    fs.writeFileSync(path.join(E.decoy, '0103-cam-live.mp4'), 'decoy');
    assert.strictEqual(m.pruneMedia(['..', 'decoy'], /./, 0, 0, new Set()), 0);
    assert.strictEqual(m.pruneMedia(['a/b'], /./, 0, 0, new Set()), 0);
    assert.strictEqual(m.pruneMedia([], /./, 0, 0, new Set()), 0);
    assert.strictEqual(textOf(path.join(E.decoy, '0103-cam-live.mp4')), 'decoy');
    fs.mkdirSync(path.join(E.decoy, `${dayOf(40 * D)}`));
    put(path.join(E.decoy, dayOf(40 * D)), '0101-cam-live.mp4', 10, 40 * D);
    fs.symlinkSync(E.decoy, path.join(E.mediaDir, 'clips'));   // the clips folder is a link
    assert.strictEqual(m.pruneClips(), 0);
    assert.ok(exists(path.join(E.decoy, dayOf(40 * D), '0101-cam-live.mp4')));
  } finally { cleanup(E); }
});

test('pruneStills and pruneClips use their settings (days, quota in MB), stills and clips separately', () => {
  const E = setup();
  try {
    E.settings = { time_zone: NY, still_days: 10, still_quota_mb: 1, clip_days: 60, clip_quota_mb: 4096 };
    const m = E.make();
    const sOld = put(path.join(E.mediaDir, 'events', dayOf(20 * D)), '0900-front-door.jpg', 100, 20 * D);
    const sNew = put(path.join(E.mediaDir, 'events', dayOf(2 * D)), '0900-front-door.jpg', 100, 2 * D);
    const cMid = put(path.join(E.mediaDir, 'clips', dayOf(40 * D)), '0900-front-door-live.mp4', 100, 40 * D);
    const cFrames = put(path.join(E.mediaDir, 'clips', dayOf(70 * D)), '0900-front-door-live-frames.jpg', 100, 70 * D);
    assert.strictEqual(m.stillDays(), 10);
    assert.strictEqual(m.pruneStills(), 1);
    assert.strictEqual(m.pruneClips(), 1);
    assert.ok(!exists(sOld) && exists(sNew) && exists(cMid) && !exists(cFrames));
    assert.ok(E.logs.some((l) => /removed 1 old still/.test(l)));
    // defaults when unset: 30 days
    E.settings = { time_zone: NY };
    assert.strictEqual(E.make().stillDays(), 30);
  } finally { cleanup(E); }
});

test('pruneWork removes only an hour-old leftovers with the module\'s own names', () => {
  const E = setup();
  try {
    const m = E.make();
    const work = path.join(E.data, 'work');
    const old = put(work, '1700000000000-abcd1234.mp4', 10, 2 * H);
    const fresh = put(work, '1700000000001-abcd1234.jpg', 10, 60000);
    const other = put(work, 'notes.txt', 10, 2 * H);
    assert.strictEqual(m.pruneWork(), 1);
    assert.ok(!exists(old) && exists(fresh) && exists(other));
  } finally { cleanup(E); }
});

test('times: parseWhen in the module\'s zone (impossible dates, skipped and repeated hours)', () => {
  const pw = (v) => media.parseWhen(v, NY);
  assert.strictEqual(pw('2026-11-03 04:06'), Date.UTC(2026, 10, 3, 9, 6));
  assert.strictEqual(pw('2026-07-04 12:00'), Date.UTC(2026, 6, 4, 16, 0));
  assert.strictEqual(pw('2026-11-31 10:00'), null);
  assert.strictEqual(pw('2026-11-02 24:30'), null);
  assert.strictEqual(pw('2026-02-29 10:00'), null);
  assert.strictEqual(pw('2026-02-31T10:00Z'), null);
  assert.strictEqual(pw('2026-06-31T12:00:00-04:00'), null);
  assert.strictEqual(pw('2026-03-08 02:30'), null);
  assert.strictEqual(pw('2026-03-08 03:30'), Date.UTC(2026, 2, 8, 7, 30));
  assert.strictEqual(pw('2026-11-01 01:30'), Date.UTC(2026, 10, 1, 5, 30));
  assert.strictEqual(pw('2026-11-01T01:30:00-05:00'), Date.UTC(2026, 10, 1, 6, 30));
  assert.strictEqual(pw('2026-11-03T09:06:00.000Z'), Date.UTC(2026, 10, 3, 9, 6));
  assert.strictEqual(pw(1793696760), 1793696760000);
  assert.strictEqual(pw('1793696760000'), 1793696760000);
  assert.strictEqual(pw('2028-02-29 10:00'), Date.UTC(2028, 1, 29, 15, 0));
  assert.strictEqual(pw('last tuesday'), null);
  assert.strictEqual(pw(-5), null);
  assert.strictEqual(media.parseWhen('2026-07-04 12:00', 'UTC'), Date.UTC(2026, 6, 4, 12, 0));
  // east of UTC and a 30-minute change
  assert.strictEqual(media.parseWhen('2026-10-25 02:30', 'Europe/Berlin'), Date.UTC(2026, 9, 25, 0, 30));
  assert.strictEqual(media.parseWhen('2026-03-29 02:30', 'Europe/Berlin'), null);
  assert.strictEqual(media.parseWhen('2026-04-05 01:45', 'Australia/Lord_Howe'), Date.UTC(2026, 3, 4, 14, 45));
  assert.strictEqual(media.parseWhen('2026-10-04 02:15', 'Australia/Lord_Howe'), null);
  assert.strictEqual(media.parseWhen('2026-10-25 01:30', 'Europe/London'), Date.UTC(2026, 9, 25, 0, 30));
  assert.strictEqual(media.parseWhen('2026-10-25 02:30', 'Europe/London'), Date.UTC(2026, 9, 25, 2, 30));
});

test('times: the factory reads the zone from settings; local time and day names follow it', () => {
  const E = setup();
  try {
    E.settings = { time_zone: 'Europe/London' };
    const m = E.make();
    assert.strictEqual(m.parseWhen('2026-07-04 12:00'), Date.UTC(2026, 6, 4, 11, 0));
    assert.strictEqual(m.localDay(Date.UTC(2026, 6, 4, 23, 30)), '2026-07-05');
    assert.match(m.localTime(Date.UTC(2026, 6, 4, 11, 0)), /Sat, Jul 4, 12:00 PM (GMT\+1|BST)/);
    E.settings = {};
    assert.strictEqual(E.make().localDay(Date.UTC(2026, 6, 4, 23, 30)), '2026-07-04');
  } finally { cleanup(E); }
});

test('fetchStill: the retry schedule, the last try asks for the latest image in range, stop and retry-after', async () => {
  const E = setup();
  try {
    E.clock = 1_700_000_000_000;
    const ts = E.clock - 5000;
    const asked = [];
    let answers = [{ why: 'Ring answered 404' }, { why: 'no image yet' }, { buf: JPEG, png: false }];
    E.api.imageDownload = async (dev, body) => { asked.push({ dev, body }); return answers.shift(); };
    const m = E.make();
    let r = await m.fetchStill('dev1', ts, 7);
    assert.ok(r.buf && r.png === false);
    assert.strictEqual(asked.length, 3);
    assert.deepStrictEqual(asked[0].body, { type: 'at_timestamp', timestamp: ts, image_options: { format: 'jpeg' }, components: [{ component_id: '7' }] });
    assert.strictEqual(asked[1].body.type, 'at_timestamp');
    assert.deepStrictEqual(asked[2].body, { type: 'latest_in_range', start_timestamp: ts - 15000, end_timestamp: E.clock, image_options: { format: 'jpeg' }, components: [{ component_id: '7' }] });

    asked.length = 0;
    answers = [{ why: 'x' }, { why: 'y' }, { why: 'no image in range' }];
    r = await m.fetchStill('dev1', E.clock + 99999, undefined);   // a future time is asked as now
    assert.deepStrictEqual(r, { error: 'no image in range' });
    assert.strictEqual(asked[0].body.timestamp, E.clock);
    assert.ok(!('components' in asked[0].body));
  } finally { cleanup(E); }

  const F = setup();
  try {
    F.clock = 1_700_000_000_000;
    let n = 0;
    F.api.imageDownload = async () => { n++; return { why: 'the camera is offline', stop: true }; };
    const r = await F.make().fetchStill('d', F.clock, null);
    assert.deepStrictEqual(r, { error: 'the camera is offline' });
    assert.strictEqual(n, 1, 'a stop ends the tries');

    n = 0;
    const bodies = [];
    F.api.imageDownload = async (d, b) => { bodies.push(b); n++; return { why: 'Ring answered 429', retryAfter: 0.001 }; };
    const r2 = await F.make().fetchStill('d', F.clock, null);
    assert.deepStrictEqual(r2, { error: 'Ring answered 429' });
    assert.strictEqual(n, 3);
    assert.ok(!('components' in bodies[0]));

    const defaults = F.make({ env: { RING_TEST: '0' } });   // without the test switch the real delays are used: just check the constant
    assert.ok(defaults && JSON.stringify(media.SNAP_DELAYS) === '[3000,5000,10000]');
  } finally { cleanup(F); }
});

test('latestStill labels the origin and reports "no image" plainly; liveStill checks the frame', async () => {
  const E = setup();
  try {
    E.clock = 1_700_000_000_000;
    let got;
    E.api.imageDownload = async (d, body) => { got = body; return { buf: JPEG, png: false, origin: 'snapshot', mediaTs: 1234 }; };
    const m = E.make();
    const r = await m.latestStill('d', 30);
    assert.deepStrictEqual({ origin: r.origin, takenAt: r.takenAt }, { origin: 'periodic snapshot', takenAt: 1234 });
    assert.deepStrictEqual(got, { type: 'latest_in_range', start_timestamp: E.clock - 30 * 60000, end_timestamp: E.clock, image_options: { format: 'jpeg' } });
    E.api.imageDownload = async () => ({ buf: JPEG, origin: 'recording' });
    assert.strictEqual((await m.latestStill('d', 5)).origin, 'frame from a recording');
    assert.strictEqual((await m.latestStill('d', 5)).takenAt, E.clock);
    E.api.imageDownload = async () => ({ buf: JPEG });
    assert.strictEqual((await m.latestStill('d', 5)).origin, 'stored image');
    E.api.imageDownload = async () => ({ why: 'Ring answered 404' });
    assert.deepStrictEqual(await m.latestStill('d', 45), { error: 'no image from this camera in the last 45 minutes' });
    E.api.imageDownload = async () => ({ why: 'the camera is offline', stop: true });
    assert.deepStrictEqual(await m.latestStill('d', 45), { error: 'the camera is offline' });
  } finally { cleanup(E); }
});

// ── child-process stand-ins ──
function fakeChild(opts = {}) {
  const c = new EventEmitter();
  c.killed = [];
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.stdinText = '';
  c.stdin = new Writable({ write(chunk, enc, cb) { c.stdinText += chunk; cb(); } });
  c.kill = (sig) => { c.killed.push(sig); setImmediate(() => c.emit('close', null)); return true; };
  c.stdout.on('close', () => setImmediate(() => { if (opts.exitOnPipeClose !== undefined) c.emit('close', opts.exitOnPipeClose); }));
  return c;
}
// spawn stand-in: python helper and ffmpeg are told apart by the program path; the "ffmpeg" writes its output file
// (the last argument) and exits as the test says.
function fakeSpawn(cfg = {}) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    const isFfmpeg = /ffmpeg$/.test(cmd);
    const child = fakeChild(isFfmpeg ? {} : { exitOnPipeClose: cfg.srcExit === undefined ? 5 : cfg.srcExit });
    const call = { cmd, args, opts, child };
    calls.push(call);
    if (isFfmpeg && cfg.ffmpeg !== 'hang') {
      setImmediate(() => {
        if (cfg.ffmpeg === 'ok') fs.writeFileSync(args[args.length - 1], cfg.output || JPEG);
        child.emit('close', cfg.ffmpeg === 'ok' ? 0 : 1);
      });
    }
    return child;
  };
  fn.calls = calls;
  return fn;
}

test('runLive (still): the helper gets the token on stdin only, python runs isolated, ffmpeg reads the pipe', async () => {
  const E = setup();
  try {
    E.api.accessTokenFor = async () => 'tok-SECRET-123';
    const sp = fakeSpawn({ ffmpeg: 'ok' });
    E.spawn = sp;
    const m = E.make();
    const r = await m.runLive('ava.device/ID 1', 'still', 0);
    assert.ok(r.file && r.file.startsWith(path.join(E.data, 'work')), r.error);
    assert.ok(isJpeg(fs.readFileSync(r.file)));
    const [py, ff] = sp.calls;
    assert.strictEqual(py.cmd, '/usr/bin/python3');
    assert.deepStrictEqual(py.args, ['-I', path.resolve(__dirname, '..', 'modules', 'ring', 'rtsp-pull.py'), 'rtsps://video.rtsp.amazonvision.com:322/v1/devices/ava.device%2FID%201/stream', '25']);
    assert.deepStrictEqual(py.opts.stdio, ['pipe', 'pipe', 'pipe']);
    assert.ok(!JSON.stringify([py.args, py.opts, ff.args]).includes('SECRET'), 'the token is in no argument');
    assert.strictEqual(py.child.stdinText, 'tok-SECRET-123\n');
    assert.strictEqual(ff.cmd, '/usr/bin/ffmpeg');
    assert.deepStrictEqual(ff.args.slice(0, 11), ['-hide_banner', '-loglevel', 'error', '-f', 'mpegts', '-i', 'pipe:0', '-frames:v', '1', '-q:v', '3']);
    assert.strictEqual(ff.args[ff.args.length - 1], r.file);
    assert.ok(py.child.stdout.destroyed, 'the helper\'s pipe is closed once ffmpeg has its frame');
    await new Promise((res) => setTimeout(res, 30));
    assert.deepStrictEqual(py.child.killed, [], 'a helper that exits by itself is not killed');
  } finally { cleanup(E); }
  function isJpeg(b) { return b[0] === 0xff && b[1] === 0xd8; }
});

test('runLive (clip): seconds in the helper\'s limit and ffmpeg\'s -t, size cap, copy of the video stream only', async () => {
  const E = setup();
  try {
    E.api.accessTokenFor = async () => 'tok';
    const sp = fakeSpawn({ ffmpeg: 'ok', output: Buffer.from('mp4-bytes') });
    E.spawn = sp;
    const r = await E.make().runLive('dev', 'clip', 15);
    assert.ok(r.file.endsWith('.mp4'));
    const [py, ff] = sp.calls;
    assert.strictEqual(py.args[3], '35', 'helper limit is seconds + 20');
    assert.deepStrictEqual(ff.args.slice(7, 20), ['-t', '15', '-map', '0:v:0', '-c', 'copy', '-map_metadata', '-1', '-movflags', '+faststart', '-fs', String(300 * 1024 * 1024), '-y']);
    const lc = await E.make().liveClip('dev', 10);
    assert.ok(lc.file && Math.abs(lc.mediaTs - (Date.now() - 10000)) < 2000);
  } finally { cleanup(E); }
});

test('runLive: the kill timers (still 30 s, clip seconds + 35 s) end both processes', async (t) => {
  for (const [kind, seconds, ms] of [['still', 0, 30000], ['clip', 12, 47000]]) {
    const E = setup();
    try {
      E.api.accessTokenFor = async () => 'tok';
      const sp = fakeSpawn({ ffmpeg: 'hang', srcExit: 3 });
      E.spawn = sp;
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const p = E.make().runLive('dev', kind, seconds);
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
      assert.strictEqual(sp.calls.length, 2);
      t.mock.timers.tick(ms - 1);
      assert.deepStrictEqual(sp.calls.map((c) => c.child.killed.length), [0, 0], 'not before the time');
      t.mock.timers.tick(1);
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
      t.mock.timers.tick(4000);   // the wait for the helper to finish
      const r = await p;
      t.mock.timers.reset();
      assert.deepStrictEqual(sp.calls.map((c) => c.child.killed), [['SIGKILL'], ['SIGKILL']]);
      assert.ok(r.error && !r.file, JSON.stringify(r));
      assert.deepStrictEqual(fs.existsSync(path.join(E.data, 'work')) ? fs.readdirSync(path.join(E.data, 'work')) : [], [], 'no half-made file is left');
    } finally { t.mock.timers.reset(); cleanup(E); }
  }
});

test('runLive: what went wrong is told plainly (could not open, no video, no token, no ffmpeg output)', async () => {
  const E = setup();
  try {
    E.api.accessTokenFor = async () => 'tok';
    for (const [code, re] of [[3, /could not be opened/], [4, /carried no video/], [1, /no video arrived/]]) {
      E.spawn = fakeSpawn({ ffmpeg: 'fail', srcExit: code });
      const r = await E.make().runLive('dev', 'still', 0);
      assert.match(r.error, re);
    }
    E.api.accessTokenFor = async () => { throw new Error('Ring sign-in needs relinking'); };
    assert.deepStrictEqual(await E.make().runLive('dev', 'still', 0), { error: 'Ring sign-in needs relinking' });
    E.api.accessTokenFor = async () => 'tok';
    E.spawn = () => { throw Object.assign(new Error('spawn failed'), { code: 'ENOENT' }); };
    assert.deepStrictEqual(await E.make().runLive('dev', 'still', 0), { error: 'ENOENT' });
  } finally { cleanup(E); }
});

test('test stand-ins (live file, ffmpeg path) work only when RING_TEST=1', async () => {
  const E = setup();
  try {
    E.api.accessTokenFor = async () => 'tok';
    E.spawn = fakeSpawn({ ffmpeg: 'ok' });
    const on = E.make({ env: { RING_TEST_LIVE_FILE: '/tmp/some.ts', RING_TEST_FFMPEG: '/opt/other-ffmpeg' } });
    await on.runLive('dev', 'still', 0);
    assert.strictEqual(E.spawn.calls[0].cmd, '/bin/cat');
    assert.deepStrictEqual(E.spawn.calls[0].args, ['/tmp/some.ts']);
    assert.strictEqual(E.spawn.calls[1].cmd, '/opt/other-ffmpeg');
    E.spawn = fakeSpawn({ ffmpeg: 'ok' });
    const off = E.make({ env: { RING_TEST: '', RING_TEST_LIVE_FILE: '/tmp/some.ts', RING_TEST_FFMPEG: '/opt/other-ffmpeg' } });
    await off.runLive('dev', 'still', 0);
    assert.strictEqual(E.spawn.calls[0].cmd, '/usr/bin/python3');
    assert.strictEqual(E.spawn.calls[1].cmd, '/usr/bin/ffmpeg');
  } finally { cleanup(E); }
});

test('frameSheet: 4 x 3 tile, fps from the length, 60 s kill', async (t) => {
  const E = setup();
  try {
    const sp = fakeSpawn({ ffmpeg: 'ok' });
    E.spawn = sp;
    const out = await E.make().frameSheet('/tmp/in.mp4', 30);
    assert.ok(out && out.endsWith('.jpg'));
    const a = sp.calls[0].args;
    assert.strictEqual(sp.calls[0].cmd, '/usr/bin/ffmpeg');
    assert.deepStrictEqual(a.slice(0, 5), ['-hide_banner', '-loglevel', 'error', '-i', '/tmp/in.mp4']);
    assert.strictEqual(a[6], 'fps=0.4000,scale=480:-2,tile=4x3:padding=4:margin=4');
    assert.deepStrictEqual(a.slice(7, 11), ['-frames:v', '1', '-q:v', '4']);
    sp.calls.length = 0;
    await E.make().frameSheet('/tmp/in.mp4', 0);
    assert.match(sp.calls[0].args[6], /^fps=10\.0000,/);
    await E.make().frameSheet('/tmp/in.mp4', 100000);
    assert.match(sp.calls[1].args[6], /^fps=0\.0200,/);
    // ffmpeg failing: no sheet and no file left
    E.spawn = fakeSpawn({ ffmpeg: 'fail' });
    assert.strictEqual(await E.make().frameSheet('/tmp/in.mp4', 30), null);
    // hanging ffmpeg is killed after 60 s
    E.spawn = fakeSpawn({ ffmpeg: 'hang' });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = E.make().frameSheet('/tmp/in.mp4', 30);
    t.mock.timers.tick(59999);
    assert.deepStrictEqual(E.spawn.calls[0].child.killed, []);
    t.mock.timers.tick(1);
    assert.strictEqual(await p, null);
    t.mock.timers.reset();
    assert.deepStrictEqual(E.spawn.calls[0].child.killed, ['SIGKILL']);
  } finally { t.mock.timers.reset(); cleanup(E); }
});

test('makeClip: a recorded clip and its frames land in clips/<day>/ under fresh names', async () => {
  const E = setup();
  try {
    const work = path.join(E.data, 'work');
    fs.mkdirSync(work, { recursive: true });
    const ts = Date.UTC(2026, 10, 3, 14, 17, 9);
    let asked;
    E.api.clipDownload = async (dev, start, secs) => {
      asked = { dev, start, secs };
      const f = path.join(work, 'dl-clip.mp4');
      fs.writeFileSync(f, Buffer.from('....ftypisom'));
      return { file: f, mediaTs: ts, lengthMs: 9000, partial: true };
    };
    E.spawn = fakeSpawn({ ffmpeg: 'ok' });
    const m = E.make();
    const r = await m.makeClip('dev', 'Front Door', 'recorded', 30, ts);
    assert.deepStrictEqual(asked, { dev: 'dev', start: ts, secs: 30 });
    assert.strictEqual(r.clip, 'clips/2026-11-03/0917-front-door-recorded.mp4');
    assert.strictEqual(r.frames, 'clips/2026-11-03/0917-front-door-recorded-frames.jpg');
    assert.deepStrictEqual({ seconds: r.seconds, partial: r.partial }, { seconds: 9, partial: true });
    assert.match(r.startsAt, /Nov 3.*9:17 AM/);
    assert.strictEqual(fs.statSync(path.join(E.mediaDir, r.clip)).mode & 0o777, 0o664);
    assert.match(E.spawn.calls[0].args.join(' '), /fps=1\.3333/, 'the sheet is spread over the real length');
    // the same minute again gets another name
    E.api.clipDownload = async () => { const f = path.join(work, 'dl-clip2.mp4'); fs.writeFileSync(f, 'x'); return { file: f, mediaTs: ts }; };
    const r2 = await m.makeClip('dev', 'Front Door', 'recorded', 30, ts);
    assert.strictEqual(r2.clip, 'clips/2026-11-03/0917-front-door-recorded-2.mp4');
    assert.strictEqual(r2.frames, 'clips/2026-11-03/0917-front-door-recorded-frames-2.jpg');
    assert.strictEqual(r2.seconds, 30);
    assert.deepStrictEqual(fs.readdirSync(work), [], 'the work folder is empty again');
    // a failed download is reported as it came
    E.api.clipDownload = async () => ({ error: 'Ring has no recording from that camera at that time' });
    assert.deepStrictEqual(await m.makeClip('dev', 'Front Door', 'recorded', 30, ts), { error: 'Ring has no recording from that camera at that time' });
  } finally { cleanup(E); }
});

test('makeClip: a clip day folder swapped for a link is refused; nothing is written through it; the work file is removed', async () => {
  const E = setup();
  try {
    const work = path.join(E.data, 'work');
    fs.mkdirSync(work, { recursive: true });
    const ts = Date.UTC(2026, 10, 3, 14, 17, 9);
    fs.mkdirSync(path.join(E.mediaDir, 'clips'));
    fs.symlinkSync(E.decoy, path.join(E.mediaDir, 'clips', '2026-11-03'));
    E.api.clipDownload = async () => { const f = path.join(work, 'dl.mp4'); fs.writeFileSync(f, 'x'); return { file: f, mediaTs: ts }; };
    E.spawn = fakeSpawn({ ffmpeg: 'ok' });
    const r = await E.make().makeClip('d', 'Front Door', 'recorded', 30, ts);
    assert.match(r.error, /not a plain folder/);
    assert.deepStrictEqual(fs.readdirSync(E.decoy), []);
    assert.deepStrictEqual(fs.readdirSync(work), []);
  } finally { cleanup(E); }
});

test('makeClip (live) refuses when the disk is nearly full and keeps the clip when the sheet fails', async () => {
  const low = setup({ storeOver: { freeBytes: () => 1024 } });
  try {
    assert.deepStrictEqual(await low.make().makeClip('d', 'Cam', 'live', 15), { error: 'the disk is nearly full' });
    assert.strictEqual(low.make().spaceForLive(), false);
  } finally { cleanup(low); }
  const E = setup({ storeOver: { freeBytes: () => 10 * 1024 ** 3 } });
  try {
    E.api.accessTokenFor = async () => 'tok';
    let n = 0;
    const base = fakeSpawn({ ffmpeg: 'ok', output: Buffer.from('mp4') });
    E.spawn = (cmd, args, o) => { n++; return n === 3 ? fakeSpawnFail(cmd, args, o) : base(cmd, args, o); };
    const r = await E.make().makeClip('d', 'Cam', 'live', 15);
    assert.ok(r.clip && r.frames === null, JSON.stringify(r));
    assert.ok(E.make().spaceForLive());
  } finally { cleanup(E); }
  function fakeSpawnFail(cmd, args, o) { return fakeSpawn({ ffmpeg: 'fail' })(cmd, args, o); }
});

test('helpers: slug, clean, shortId, isImage', () => {
  assert.strictEqual(media.slug('Front Door live'), 'front-door-live');
  assert.strictEqual(media.slug('../../etc/passwd'), 'etc-passwd');
  assert.strictEqual(media.slug('!!!'), 'camera');
  assert.strictEqual(media.slug('x'.repeat(100)).length, 40);
  assert.strictEqual(media.clean('a\u0000b\n\tc   d', 80), 'a b c d');
  assert.strictEqual(media.clean({ toString: null }), '');
  assert.strictEqual(media.clean('abcdef', 3), 'abc');
  assert.strictEqual(media.shortId('ava.device.ABCDEF123456'), '…123456');
  assert.strictEqual(media.shortId(''), '-');
  assert.ok(media.isImage(JPEG));
  assert.ok(media.isImage(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)])));
  assert.ok(!media.isImage(Buffer.from('<html>not an image</html>')));
  assert.ok(!media.isImage(null) && !media.isImage(Buffer.alloc(4)));
  assert.ok(media.CLIP_NAME.test('0917-front-door-live-frames.jpg') && !media.CLIP_NAME.test('../0917-x.mp4'));
  assert.ok(media.STILL_NAME.test('0917-front-door-09-2.jpg') && !media.STILL_NAME.test('0917-front-door.mp4'));
});

test('rtsp-pull.py is the helper the wiring points at', () => {
  assert.strictEqual(media.PULL_SCRIPT, path.resolve(__dirname, '..', 'modules', 'ring', 'rtsp-pull.py'));
  assert.ok(fs.existsSync(media.PULL_SCRIPT));
  assert.match(fs.readFileSync(media.PULL_SCRIPT, 'utf8'), /first line of stdin/);
});
