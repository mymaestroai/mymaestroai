'use strict';
// lib/faces/packs.js on a tiny synthetic pack generated here (no real artwork or video).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const packs = require('../lib/faces/packs');

function crc32(buf) { let c = 0xffffffff; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function png(w, h, depth = 8, colour = 6) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = depth; ihdr[9] = colour;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function mp4(extra = 64) { const b = Buffer.alloc(24 + extra); b.writeUInt32BE(24, 0); b.write('ftypisom', 4, 'latin1'); b.write('isom', 16, 'latin1'); return b; }
const track = (n = 6) => JSON.stringify({ fps: 24, w: 1280, h: 720, box: [0, 0, 10, 10], frames: Array.from({ length: n }, (_, i) => [640 + i, 360, 1, 0, 0.9]) });

const ROI = [10, 20, 8, 6];
const FILES = ['beak/beak.json', 'beak/closed.png', 'beak/half.png', 'beak/oo.png', 'beak/slight.png', 'beak/smile.png', 'beak/wide.png', 'manifest.json', 'tracks/speaking-one.json', 'web/idle-one.mp4', 'web/reaction-delighted.mp4', 'web/speaking-one.mp4'];
/** Write a valid synthetic pack into dir; tweak(manifest) may change the manifest before it is written. */
function makePack(dir, tweak) {
  fs.mkdirSync(path.join(dir, 'web'), { recursive: true }); fs.mkdirSync(path.join(dir, 'tracks')); fs.mkdirSync(path.join(dir, 'beak'));
  const m = {
    version: 3, name: 'Test Bird', background: '#ffd6ab', futureField: { anything: [1, 2] },
    clips: [
      { name: 'idle-one', state: 'idle', weight: 3, dur: 2, track: false, rare: false, family: 'baton', startsFrom: 'A', endsOn: 'A', beakEnds: 'smile' },
      { name: 'speaking-one', state: 'speaking', weight: 2, dur: 0.25, track: true, rare: false, beakEnds: 'closed' },
      { name: 'reaction-delighted', state: 'reaction', weight: 2, dur: 2, track: false, rare: false, mood: 'delighted', extra: 'ignored' },
    ],
    beak: { roi: ROI, centre: [14, 23], shapes: ['closed', 'slight', 'half', 'wide', 'oo'], smile: 'smile', blendFrames: 3 },
  };
  if (tweak) tweak(m);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
  for (const c of m.clips || []) { if (typeof c.name === 'string' && /^[\w-]+$/.test(c.name)) { fs.writeFileSync(path.join(dir, 'web', `${c.name}.mp4`), mp4()); if (c.track) fs.writeFileSync(path.join(dir, 'tracks', `${c.name}.json`), track()); } }
  fs.writeFileSync(path.join(dir, 'beak', 'beak.json'), JSON.stringify({ roi: ROI, centre: [14, 23] }));
  for (const s of ['closed', 'slight', 'half', 'wide', 'oo', 'smile']) fs.writeFileSync(path.join(dir, 'beak', `${s}.png`), png(8, 6));
  return m;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'face-pk-'));
function fresh(tweak) { const root = tmp(); const src = path.join(root, 'bird-pack'); fs.mkdirSync(src); makePack(src, tweak); return { root, src, home: path.join(root, 'home') }; }
const rejects = (tweak, re) => { const { src } = fresh(tweak); const r = packs.validatePack(src); assert.strictEqual(r.ok, false); assert.match(r.error, re); };

test('a valid pack validates, tolerating unknown additive fields', () => {
  const { src } = fresh();
  const r = packs.validatePack(src);
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(Object.keys(r.files).sort(), FILES);
  assert.strictEqual(r.files['web/idle-one.mp4'].mime, 'video/mp4');
});

test('version 2 is accepted, other versions are not', () => {
  assert.strictEqual(packs.validatePack(fresh(m => { m.version = 2; }).src).ok, true);
  rejects(m => { m.version = 4; }, /version/);
  rejects(m => { delete m.version; }, /version/);
});

test('manifest field checks', () => {
  rejects(m => { m.clips[0].weight = 'x'; }, /weight/);
  rejects(m => { m.clips[0].weight = 0; }, /weight/);
  rejects(m => { m.clips[0].dur = -1; }, /dur/);
  rejects(m => { m.clips[0].track = 'yes'; }, /track/);
  rejects(m => { m.clips[0].rare = 1; }, /rare/);
  rejects(m => { m.clips[0].state = 'dancing'; }, /state/);
  rejects(m => { m.clips[0].startsFrom = 'C'; }, /startsFrom/);
  rejects(m => { m.clips[0].beakEnds = 'open'; }, /beakEnds/);
  rejects(m => { m.clips[0].family = '../x'; }, /family/);
  rejects(m => { m.background = 'red'; }, /background/);
  rejects(m => { m.clips[1].name = 'idle-one'; }, /twice/);
  rejects(m => { m.clips[1].name = 'Idle-One'; }, /twice/);
  rejects(m => { m.clips = []; }, /clips/);
  rejects(m => { m.clips[0].name = '../evil'; }, /name/);
  rejects(m => { m.clips[0].name = '.hidden'; }, /name/);
  rejects(m => { m.clips[0].name = 'a%2fb'; }, /name/);
  rejects(m => { m.beak.roi = [1, 2, 3]; }, /roi/);
  rejects(m => { m.beak.shapes = ['slight']; }, /closed/);
  rejects(m => { delete m.beak; }, /beak/);
});

test('too many clips', () => {
  rejects(m => { m.clips = Array.from({ length: 301 }, (_, i) => ({ name: `c${i}`, state: 'idle', weight: 1, dur: 1, track: false, rare: false })); }, /over the limit/);
});

test('a number JSON reads as Infinity, or a huge one, is rejected', () => {
  rejects(m => { m.clips[0].dur = 1e9; }, /dur/);
  const { src } = fresh();
  const mf = path.join(src, 'manifest.json');
  fs.writeFileSync(mf, fs.readFileSync(mf, 'utf8').replace('"weight":3', '"weight":1e999'));
  assert.match(packs.validatePack(src).error, /weight/);
});

test('missing, wrong or damaged files are rejected', () => {
  let f = fresh(); fs.rmSync(path.join(f.src, 'web', 'idle-one.mp4')); assert.match(packs.validatePack(f.src).error, /missing/);
  f = fresh(); fs.writeFileSync(path.join(f.src, 'web', 'idle-one.mp4'), Buffer.from('not a video at all')); assert.match(packs.validatePack(f.src).error, /ftyp/);
  f = fresh(); fs.writeFileSync(path.join(f.src, 'beak', 'closed.png'), Buffer.from('nope nope nope nope nope nope nope nope nope')); assert.match(packs.validatePack(f.src).error, /PNG/);
  f = fresh(); fs.writeFileSync(path.join(f.src, 'beak', 'closed.png'), png(9, 6)); assert.match(packs.validatePack(f.src).error, /9x6/);
  f = fresh(); const dmg = png(8, 6); dmg[20] ^= 0xff; fs.writeFileSync(path.join(f.src, 'beak', 'slight.png'), dmg); assert.match(packs.validatePack(f.src).error, /damaged|dimensions/);
  f = fresh(); fs.writeFileSync(path.join(f.src, 'beak', 'beak.json'), JSON.stringify({ roi: [0, 0, 8, 6], centre: [14, 23] })); assert.match(packs.validatePack(f.src).error, /does not match/);
  f = fresh(); fs.writeFileSync(path.join(f.src, 'manifest.json'), '{not json'); assert.match(packs.validatePack(f.src).error, /JSON/);
});

test('track geometry is checked', () => {
  const bad = (obj, re) => { const f = fresh(); fs.writeFileSync(path.join(f.src, 'tracks', 'speaking-one.json'), typeof obj === 'string' ? obj : JSON.stringify(obj)); assert.match(packs.validatePack(f.src).error, re); };
  bad({ fps: 0, w: 1, h: 1, frames: [[1, 1, 1, 0]] }, /fps/);
  bad({ fps: 24, w: 0, h: 1, frames: [[1, 1, 1, 0]] }, /w and h/);
  bad({ fps: 24, w: 10, h: 10, frames: [] }, /frames/);
  bad({ fps: 24, w: 10, h: 10, frames: [[1, 1, 1]] }, /frame 0/);
  bad({ fps: 24, w: 10, h: 10, frames: [[1, 1, 1, 0], [1, null, 1, 0]] }, /frame 1/);
  bad({ fps: 24, w: 10, h: 10, frames: [[1e9, 1, 1, 0]] }, /out of range/);
  bad('[1,2]', /object/);
});

test('size limits are checked by stat before reading', () => {
  const f = fresh();
  fs.truncateSync(path.join(f.src, 'web', 'idle-one.mp4'), 17 * 1024 * 1024);   // sparse: no real disk use
  assert.match(packs.validatePack(f.src).error, /limit for one file/);
  const g = fresh();
  fs.truncateSync(path.join(g.src, 'manifest.json'), 2 * 1024 * 1024);
  assert.match(packs.validatePack(g.src).error, /limit for one file/);
});

test('total size cap', () => {
  const f = fresh(m => { m.clips = Array.from({ length: 8 }, (_, i) => ({ name: `idle-${i}`, state: 'idle', weight: 1, dur: 1, track: false, rare: false })); m.clips.push({ name: 'speaking-one', state: 'speaking', weight: 1, dur: 1, track: true, rare: false }); });
  for (let i = 0; i < 8; i++) { const p = path.join(f.src, 'web', `idle-${i}.mp4`); fs.writeFileSync(p, mp4()); fs.truncateSync(p, 15 * 1024 * 1024); }
  const r = packs.validatePack(f.src);
  assert.strictEqual(r.ok, false); assert.match(r.error, /total limit/);
});

test('symlinks are rejected everywhere', () => {
  let f = fresh(); fs.renameSync(path.join(f.src, 'web', 'idle-one.mp4'), path.join(f.root, 'real.mp4')); fs.symlinkSync(path.join(f.root, 'real.mp4'), path.join(f.src, 'web', 'idle-one.mp4'));
  assert.match(packs.validatePack(f.src).error, /symbolic link/);
  f = fresh(); fs.renameSync(path.join(f.src, 'web'), path.join(f.root, 'realweb')); fs.symlinkSync(path.join(f.root, 'realweb'), path.join(f.src, 'web'));
  assert.match(packs.validatePack(f.src).error, /symbolic link/);
  f = fresh(); fs.renameSync(path.join(f.src, 'manifest.json'), path.join(f.root, 'm.json')); fs.symlinkSync(path.join(f.root, 'm.json'), path.join(f.src, 'manifest.json'));
  assert.match(packs.validatePack(f.src).error, /symbolic link/);
  f = fresh(); const link = path.join(f.root, 'linked'); fs.symlinkSync(f.src, link);
  assert.match(packs.validatePack(link).error, /symbolic link/);
  assert.throws(() => packs.installPack(link, { home: f.home, id: 'x' }), /symbolic link/);
});

test('slugs are strict and bounded', () => {
  for (const ok of ['owl', 'a', 'owl-2', 'a'.repeat(40)]) assert.strictEqual(packs.validateSlug(ok).ok, true, ok);
  for (const no of ['', 'Owl', '-a', 'a-', 'a_b', 'a.b', '../x', 'a/b', 'a%2fb', '.hidden', 'a'.repeat(41), 'a b', 'con', null, 7]) assert.strictEqual(packs.validateSlug(no).ok, false, String(no));
  assert.strictEqual(packs.deriveSlug('My Owl_Pack!'), 'my-owl-pack');
  assert.strictEqual(packs.deriveSlug('...'), null);
});

test('install copies only the listed files, atomically, and refuses to overwrite', () => {
  const f = fresh();
  fs.writeFileSync(path.join(f.src, 'secret.txt'), 'private'); fs.writeFileSync(path.join(f.src, 'web', 'unlisted.mp4'), mp4()); fs.mkdirSync(path.join(f.src, '.git')); fs.writeFileSync(path.join(f.src, 'web', 'idle-one.mov'), 'x');
  const r = packs.installPack(f.src, { home: f.home, id: 'bird' });
  assert.strictEqual(r.id, 'bird');
  const dir = path.join(f.home, 'faces', 'bird');
  const all = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : all.push(path.relative(dir, path.join(d, e.name))); })(dir);
  assert.deepStrictEqual(all.sort(), FILES);
  assert.deepStrictEqual(fs.readdirSync(path.join(f.home, 'faces')), ['bird'], 'no staging folder left behind');
  assert.throws(() => packs.installPack(f.src, { home: f.home, id: 'bird' }), /already installed/);
  assert.deepStrictEqual(fs.readdirSync(path.join(f.home, 'faces')), ['bird']);
  assert.strictEqual(packs.installPack(f.src, { home: f.home }).id, 'bird-pack', 'the id defaults to the folder name');
});

test('install rejects a bad id, an invalid source, a symlinked faces folder or destination', () => {
  const f = fresh();
  assert.throws(() => packs.installPack(f.src, { home: f.home, id: '../x' }), /pack id/);
  assert.throws(() => packs.installPack(f.src, { home: f.home, id: 'Bad' }), /pack id/);
  fs.rmSync(path.join(f.src, 'web', 'idle-one.mp4'));
  assert.throws(() => packs.installPack(f.src, { home: f.home, id: 'bird' }), /Not a valid character pack/);
  assert.strictEqual(fs.existsSync(path.join(f.home, 'faces')), false, 'nothing created for an invalid pack');
  const g = fresh();
  fs.mkdirSync(path.join(g.home, 'elsewhere'), { recursive: true }); fs.symlinkSync(path.join(g.home, 'elsewhere'), path.join(g.home, 'faces'));
  assert.throws(() => packs.installPack(g.src, { home: g.home, id: 'bird' }), /not a link/);
  const h = fresh();
  fs.mkdirSync(path.join(h.home, 'faces'), { recursive: true }); fs.symlinkSync(h.root, path.join(h.home, 'faces', 'bird'));
  assert.throws(() => packs.installPack(h.src, { home: h.home, id: 'bird' }), /already installed/);
});

test('a failure cleans only its own staging folder', () => {
  const f = fresh();
  fs.mkdirSync(path.join(f.home, 'faces'), { recursive: true });
  fs.mkdirSync(path.join(f.home, 'faces', '.staging-other'));
  // The second open of a source file (the copy, after validation) fails.
  const real = fs.openSync; let n = 0;
  fs.openSync = function (p, ...rest) { if (String(p).endsWith(path.join('bird-pack', 'tracks', 'speaking-one.json')) && ++n === 2) throw Object.assign(new Error('boom'), { code: 'EIO' }); return real.call(this, p, ...rest); };
  try { assert.throws(() => packs.installPack(f.src, { home: f.home, id: 'bird' })); } finally { fs.openSync = real; }
  assert.strictEqual(n, 2);
  assert.deepStrictEqual(fs.readdirSync(path.join(f.home, 'faces')), ['.staging-other']);
});

test('a source file that changes between the check and the copy is caught', () => {
  const f = fresh();
  const target = path.join(f.src, 'web', 'speaking-one.mp4');
  const wrap = fs.openSync; let count = 0;
  fs.openSync = function (p, ...rest) { if (String(p) === target && ++count === 2) fs.appendFileSync(target, 'grow'); return wrap.call(this, p, ...rest); };
  try { assert.throws(() => packs.installPack(f.src, { home: f.home, id: 'bird' }), /changed|grew/); } finally { fs.openSync = wrap; }
  assert.strictEqual(fs.existsSync(path.join(f.home, 'faces', 'bird')), false);
  assert.deepStrictEqual(fs.readdirSync(path.join(f.home, 'faces')), []);
});

test('list and get: valid packs only, invalid hidden, cached', () => {
  packs.clearCache();
  const f = fresh();
  packs.installPack(f.src, { home: f.home, id: 'bird' });
  packs.installPack(f.src, { home: f.home, id: 'bird-b' });
  const faces = path.join(f.home, 'faces');
  fs.rmSync(path.join(faces, 'bird-b', 'web', 'idle-one.mp4'));            // damaged after install
  fs.mkdirSync(path.join(faces, 'junk'));                                  // no manifest
  fs.mkdirSync(path.join(faces, '.hidden'));
  fs.symlinkSync(path.join(faces, 'bird'), path.join(faces, 'linked'));    // a symlinked pack
  fs.writeFileSync(path.join(faces, 'afile'), 'x');
  packs.clearCache();
  assert.deepStrictEqual(packs.listPacks({ home: f.home }).map(p => p.id), ['bird']);
  const p = packs.getPack('bird', { home: f.home });
  assert.strictEqual(p.id, 'bird'); assert.strictEqual(p.manifest.name, 'Test Bird');
  assert.ok(p.files['manifest.json'] && p.files['web/idle-one.mp4']);
  assert.strictEqual(p.files['../manifest.json'], undefined); assert.strictEqual(p.files.constructor, undefined);
  assert.strictEqual(packs.getPack('bird', { home: f.home }), p, 'cached');
  for (const id of ['linked', 'junk', 'bird-b', '../bird', 'nope', 'BIRD']) assert.strictEqual(packs.getPack(id, { home: f.home }), null, id);
  assert.deepStrictEqual(packs.listPacks({ home: path.join(f.root, 'nohome') }), []);
});

test('a changed file invalidates the cache once the interval is up', () => {
  packs.clearCache();
  const f = fresh(); packs.installPack(f.src, { home: f.home, id: 'bird' });
  const p1 = packs.getPack('bird', { home: f.home });
  const size = p1.files['web/idle-one.mp4'].size;
  fs.appendFileSync(path.join(f.home, 'faces', 'bird', 'web', 'idle-one.mp4'), 'x');
  assert.strictEqual(packs.getPack('bird', { home: f.home }).files['web/idle-one.mp4'].size, size, 'within the interval the cached answer stands');
  const real = Date.now; Date.now = () => real() + 60000;
  try { assert.strictEqual(packs.getPack('bird', { home: f.home }).files['web/idle-one.mp4'].size, size + 1); } finally { Date.now = real; }
});

test('PNG colour types 4 and 6 allow only bit depth 8 or 16', () => {
  const withPng = (buf) => { const f = fresh(); fs.writeFileSync(path.join(f.src, 'beak', 'closed.png'), buf); return packs.validatePack(f.src); };
  assert.strictEqual(withPng(png(8, 6, 16, 6)).ok, true);
  assert.strictEqual(withPng(png(8, 6, 8, 4)).ok, true);
  for (const [d, c] of [[1, 6], [2, 6], [4, 6], [4, 4], [1, 4], [2, 4], [3, 6], [8, 2], [8, 3]]) {
    const r = withPng(png(8, 6, d, c)); assert.strictEqual(r.ok, false, `depth ${d} colour ${c}`); assert.match(r.error, /RGBA or grey-alpha/);
  }
});

test('a speaking clip must carry a track, and a speaking pack needs all five beak shapes', () => {
  rejects(m => { m.clips[1].track = false; }, /speaking clip needs track: true/);
  rejects(m => { m.beak.shapes = ['closed', 'slight', 'half', 'wide']; }, /"oo"/);
  rejects(m => { m.beak.shapes = ['closed']; }, /"slight"/);
  // no speaking clip: the generic "closed" alone is fine
  const f = fresh(m => { m.clips = [m.clips[0], m.clips[2]]; m.beak.shapes = ['closed']; });
  assert.strictEqual(packs.validatePack(f.src).ok, true, packs.validatePack(f.src).error);
});

test('"closed" must be spelled exactly, and a smile may not differ from a shape only by case', () => {
  rejects(m => { m.beak.shapes = ['Closed', 'slight', 'half', 'wide', 'oo']; }, /"closed"/);
  rejects(m => { m.clips = [m.clips[0]]; m.beak.shapes = ['CLOSED']; }, /"closed"/);
  rejects(m => { m.beak.smile = 'Slight'; }, /letter case/);
});

test('copying survives short writes and writes every byte', () => {
  const f = fresh();
  const real = fs.writeSync; let calls = 0;
  fs.writeSync = function (fd, buf, off, len, ...rest) { calls++; return real.call(this, fd, buf, off, Math.min(len, 7), ...rest); };
  try { packs.installPack(f.src, { home: f.home, id: 'bird' }); } finally { fs.writeSync = real; }
  assert.ok(calls > 20, 'the hook made writes partial');
  for (const rel of FILES) assert.ok(fs.readFileSync(path.join(f.src, rel)).equals(fs.readFileSync(path.join(f.home, 'faces', 'bird', rel))), rel);
});

test('a write that never progresses fails and cleans its staging folder', () => {
  const f = fresh();
  const real = fs.writeSync;
  fs.writeSync = function () { return 0; };
  try { assert.throws(() => packs.installPack(f.src, { home: f.home, id: 'bird' }), /no progress/); } finally { fs.writeSync = real; }
  assert.deepStrictEqual(fs.readdirSync(path.join(f.home, 'faces')), []);
});

test('a same-size in-place edit of a source file during the copy is caught, even with the mtime restored', () => {
  const f = fresh();
  const target = path.join(f.src, 'web', 'speaking-one.mp4');
  const real = fs.openSync; let count = 0;
  fs.openSync = function (p, ...rest) {
    if (String(p) === target && ++count === 2) { const st = fs.statSync(target); const b = fs.readFileSync(target); b[b.length - 1] ^= 0xff; fs.writeFileSync(target, b); fs.utimesSync(target, st.atime, st.mtime); }
    return real.call(this, p, ...rest);
  };
  try { assert.throws(() => packs.installPack(f.src, { home: f.home, id: 'bird' }), /changed/); } finally { fs.openSync = real; }
  assert.deepStrictEqual(fs.readdirSync(path.join(f.home, 'faces')), []);
});

test('a cached pack notices a swapped parent folder (symlink to the same files) at once', () => {
  packs.clearCache();
  const f = fresh(); packs.installPack(f.src, { home: f.home, id: 'bird' });
  const dir = path.join(f.home, 'faces', 'bird');
  const p1 = packs.getPack('bird', { home: f.home });
  assert.ok(p1);
  fs.renameSync(path.join(dir, 'web'), path.join(f.root, 'realweb')); fs.symlinkSync(path.join(f.root, 'realweb'), path.join(dir, 'web'));
  assert.strictEqual(packs.getPack('bird', { home: f.home }), null, 'within the interval, still refused');
  assert.strictEqual(packs.openVerified(p1, p1.files['web/idle-one.mp4']), null);
  fs.rmSync(path.join(dir, 'web')); fs.renameSync(path.join(f.root, 'realweb'), path.join(dir, 'web'));
  assert.ok(packs.getPack('bird', { home: f.home }), 'a real folder again validates again');
});

test('a cached pack notices a swapped faces folder or pack folder', () => {
  for (const which of ['faces', 'pack']) {
    packs.clearCache();
    const f = fresh(); packs.installPack(f.src, { home: f.home, id: 'bird' });
    assert.ok(packs.getPack('bird', { home: f.home }));
    const faces = path.join(f.home, 'faces');
    if (which === 'faces') { fs.renameSync(faces, path.join(f.root, 'faces-real')); fs.symlinkSync(path.join(f.root, 'faces-real'), faces); }
    else { fs.renameSync(path.join(faces, 'bird'), path.join(f.root, 'bird-real')); fs.symlinkSync(path.join(f.root, 'bird-real'), path.join(faces, 'bird')); }
    assert.strictEqual(packs.getPack('bird', { home: f.home }), null, which);
  }
});

test('openVerified refuses a same-size in-place edit, even with the mtime restored', () => {
  packs.clearCache();
  const f = fresh(); packs.installPack(f.src, { home: f.home, id: 'bird' });
  const p = packs.getPack('bird', { home: f.home });
  const file = p.files['web/idle-one.mp4'];
  const o = packs.openVerified(p, file); assert.ok(o); fs.closeSync(o.fd);
  const st = fs.statSync(file.abs); const b = fs.readFileSync(file.abs); b[b.length - 1] ^= 1; fs.writeFileSync(file.abs, b); fs.utimesSync(file.abs, st.atime, st.mtime);
  assert.ok(Math.abs(fs.statSync(file.abs).mtimeMs - st.mtimeMs) < 1, 'mtime restored (to the millisecond)');
  assert.strictEqual(packs.openVerified(p, file), null);
  const real = Date.now; Date.now = () => real() + 60000;
  try { const p2 = packs.getPack('bird', { home: f.home }); assert.notStrictEqual(p2.files['web/idle-one.mp4'].ctimeMs, file.ctimeMs, 'revalidated after the interval'); } finally { Date.now = real; }
});

// ── Posters and safe area ────────────────────────────────────────────────────────────────────────────────
function jpeg(w, h) {
  const sof = Buffer.alloc(19); sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(17, 2); sof[4] = 8; sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7); sof[9] = 3;
  const app0 = Buffer.from([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xda, 0, 2, 0, 0, 0xff, 0xd9])]);
}
function webp(w, h, kind = 'VP8X') {
  let body;
  if (kind === 'VP8X') { body = Buffer.alloc(18); body.writeUIntLE(w - 1, 4, 3); body.writeUIntLE(h - 1, 7, 3); }
  else if (kind === 'VP8L') { body = Buffer.alloc(10); body[0] = 0x2f; body.writeUInt32LE(((w - 1) | ((h - 1) << 14)) >>> 0, 1); }
  else { body = Buffer.alloc(10); body[3] = 0x9d; body[4] = 0x01; body[5] = 0x2a; body.writeUInt16LE(w, 6); body.writeUInt16LE(h, 8); }
  const ch = Buffer.alloc(8); ch.write(kind === 'VP8' ? 'VP8 ' : kind, 0, 'latin1'); ch.writeUInt32LE(body.length, 4);
  const hd = Buffer.alloc(12); hd.write('RIFF', 0, 'latin1'); hd.writeUInt32LE(4 + ch.length + body.length, 4); hd.write('WEBP', 8, 'latin1');
  return Buffer.concat([hd, ch, body]);
}
/** A valid pack whose manifest names posters; put(dir) may change the files afterwards. */
function withPosters(tweak, put) {
  const f = fresh(m => { m.poster = 'art/pose-a.png'; m.posters = { A: 'art/pose-a.png', B: 'art/pose-b.jpg' }; m.safeArea = { x: 0.1, y: 0.05, w: 0.8, h: 0.9 }; m.safeAreaTypical = { x: 0.2, y: 0.1, w: 0.6, h: 0.8 }; if (tweak) tweak(m); });
  fs.mkdirSync(path.join(f.src, 'art'));
  fs.writeFileSync(path.join(f.src, 'art', 'pose-a.png'), png(32, 48, 8, 6));
  fs.writeFileSync(path.join(f.src, 'art', 'pose-b.jpg'), jpeg(32, 48));
  if (put) put(f.src);
  return f;
}
const pRejects = (tweak, re, put) => { const f = withPosters(tweak, put); const r = packs.validatePack(f.src); assert.strictEqual(r.ok, false, 'should be rejected'); assert.match(r.error, re); };
const putArt = (name, buf) => (d) => fs.writeFileSync(path.join(d, 'art', name), buf);

test('valid posters (PNG, JPEG, WebP) and safe areas validate, with the right MIME types', () => {
  const f = withPosters(m => { m.posters.B = 'art/pose-b.webp'; m.posters.futurePose = 'art/not-checked.png'; }, putArt('pose-b.webp', webp(32, 48)));
  const r = packs.validatePack(f.src);
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.files['art/pose-a.png'].mime, 'image/png');
  assert.strictEqual(r.files['art/pose-b.webp'].mime, 'image/webp');
  assert.strictEqual(r.files['art/pose-a.png'].kind, 'poster');
  assert.ok(!r.files['art/not-checked.png'], 'unknown posters keys are neither read nor listed');
  for (const kind of ['VP8', 'VP8L', 'VP8X']) { const g = withPosters(m => { m.posters.B = 'art/b.webp'; }, putArt('b.webp', webp(7, 9, kind))); assert.strictEqual(packs.validatePack(g.src).ok, true, kind); }
  const j = withPosters(m => { m.poster = 'art/a.jpeg'; m.posters = { A: 'art/a.jpeg' }; }, putArt('a.jpeg', jpeg(10, 10)));
  const jr = packs.validatePack(j.src); assert.strictEqual(jr.ok, true, jr.error); assert.strictEqual(jr.files['art/a.jpeg'].mime, 'image/jpeg');
});

test('poster alone (no posters), a posters map with only A, and a beak PNG as poster are fine', () => {
  assert.strictEqual(packs.validatePack(withPosters(m => { delete m.posters; }).src).ok, true);
  assert.strictEqual(packs.validatePack(withPosters(m => { m.posters = { A: m.poster }; }).src).ok, true);
  const f = fresh(m => { m.poster = 'beak/closed.png'; });
  const r = packs.validatePack(f.src); assert.strictEqual(r.ok, true, r.error); assert.strictEqual(r.files['beak/closed.png'].kind, 'beak');
  fs.appendFileSync(path.join(f.src, 'beak', 'closed.png'), Buffer.alloc(1024 * 1024));
  assert.match(packs.validatePack(f.src).error, /1 MiB limit/, 'reusing a beak file does not bypass the poster limit');
});

test('poster and posters rules', () => {
  pRejects(m => { delete m.poster; }, /posters needs a "poster"/);
  pRejects(m => { m.poster = 'art/pose-b.jpg'; }, /same path as posters\.A/);
  pRejects(m => { delete m.posters.A; }, /pose "A"/);
  pRejects(m => { m.posters = ['art/pose-a.png']; }, /posters must be an object/);
  pRejects(m => { m.poster = 7; }, /poster must be a file path/);
  pRejects(m => { m.posters.B = 5; }, /posters\.B must be a file path/);
  pRejects(m => { m.posters.B = 'art/missing.png'; }, /missing/);
  pRejects(m => { m.poster = 'art/missing.png'; m.posters.A = 'art/missing.png'; }, /missing/);
});

test('unsafe poster paths are rejected', () => {
  for (const p of ['/etc/passwd.png', '../x.png', 'art/../x.png', 'art//x.png', './x.png', 'art/.hid.png', '.x.png', 'art\\x.png', 'art/%2e%2e.png', 'C:/x.png', 'art/x.png ', 'art/x.png.', 'x.gif', 'art/x', 'manifest.json', 'art/a\u0000.png', '', 'a/b/c/d/e.png', `art/${'x'.repeat(130)}.png`]) {
    pRejects(m => { m.poster = p; m.posters.A = p; }, /poster|path|manifest/);
  }
  pRejects(m => { m.posters.B = '../up.png'; }, /posters\.B/);
});

test('poster content is sniffed: wrong type, extension mismatch, damage, bad dimensions', () => {
  pRejects(null, /not a PNG, JPEG or WebP/, putArt('pose-a.png', Buffer.from('GIF89a not an image at all, sorry')));
  pRejects(null, /JPEG image but its name ends in \.png/, putArt('pose-a.png', jpeg(4, 4)));
  pRejects(null, /PNG image but its name ends in \.jpg/, putArt('pose-b.jpg', png(4, 4)));
  pRejects(null, /WebP image but its name ends in \.jpg/, putArt('pose-b.jpg', webp(4, 4)));
  const dmg = png(4, 4); dmg[20] ^= 0xff; pRejects(null, /damaged|dimensions/, putArt('pose-a.png', dmg));
  pRejects(null, /dimensions/, putArt('pose-a.png', png(9000, 4)));
  pRejects(null, /dimensions/, putArt('pose-b.jpg', jpeg(9000, 4)));
  pRejects(null, /dimensions/, putArt('pose-b.jpg', jpeg(0, 4)));
  pRejects(null, /no JPEG frame|damaged JPEG/, putArt('pose-b.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xd9])));
  pRejects(null, /damaged JPEG/, putArt('pose-b.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0, 0, 0, 0])));
  const t = webp(4, 4); pRejects(m => { m.posters.B = 'art/b.webp'; }, /truncated WebP/, putArt('b.webp', t.subarray(0, t.length - 4)));
  pRejects(m => { m.posters.B = 'art/b.webp'; }, /unknown WebP layout/, putArt('b.webp', Buffer.concat([webp(4, 4).subarray(0, 12), Buffer.from('ZZZZ'), Buffer.alloc(30)])));
  pRejects(null, /empty/, putArt('pose-a.png', Buffer.alloc(0)));
});

test('poster size: 1 MiB is the cap and posters count toward the pack total', () => {
  const base = png(32, 48, 8, 6).length;
  const pad = (n) => (d) => fs.appendFileSync(path.join(d, 'art', 'pose-a.png'), Buffer.alloc(n));
  const r = packs.validatePack(withPosters(null, pad(MIB1 - base)).src);
  assert.strictEqual(r.ok, true, r.error); assert.strictEqual(r.files['art/pose-a.png'].size, MIB1);
  pRejects(null, /over the 1 MiB limit/, pad(MIB1 - base + 1));
  pRejects(null, /limit for one file/, (d) => fs.truncateSync(path.join(d, 'art', 'pose-b.jpg'), 17 * 1024 * 1024));
  const withArt = packs.validatePack(withPosters().src), plain = packs.validatePack(fresh().src);
  assert.strictEqual(withArt.total, Object.values(withArt.files).reduce((a, f) => a + f.size, 0));
  assert.ok(withArt.files['art/pose-a.png'] && withArt.files['art/pose-b.jpg'] && withArt.total > plain.total, 'posters are counted');
});
const MIB1 = 1024 * 1024;

test('a symlinked poster, or a poster inside a symlinked folder, is rejected', () => {
  let f = withPosters(); fs.renameSync(path.join(f.src, 'art', 'pose-a.png'), path.join(f.root, 'real.png')); fs.symlinkSync(path.join(f.root, 'real.png'), path.join(f.src, 'art', 'pose-a.png'));
  assert.match(packs.validatePack(f.src).error, /symbolic link/);
  f = withPosters(); fs.renameSync(path.join(f.src, 'art'), path.join(f.root, 'realart')); fs.symlinkSync(path.join(f.root, 'realart'), path.join(f.src, 'art'));
  assert.match(packs.validatePack(f.src).error, /symbolic link/);
  f = withPosters(); fs.rmSync(path.join(f.src, 'art', 'pose-b.jpg')); fs.mkdirSync(path.join(f.src, 'art', 'pose-b.jpg'));
  assert.match(packs.validatePack(f.src).error, /not a regular file/);
});

test('safeArea and safeAreaTypical geometry', () => {
  const sa = (v) => (m) => { m.safeArea = v; };
  for (const ok of [{ x: 0, y: 0, w: 1, h: 1 }, { x: 0.25, y: 0.1, w: 0.5, h: 0.9 }, { x: 0.7, y: 0, w: 0.3, h: 0.4 }]) assert.strictEqual(packs.validatePack(fresh(sa(ok)).src).ok, true, JSON.stringify(ok));
  for (const no of [{ x: -0.1, y: 0, w: 0.5, h: 0.5 }, { x: 0, y: -1, w: 0.5, h: 0.5 }, { x: 0, y: 0, w: 0, h: 0.5 }, { x: 0, y: 0, w: 0.5, h: -0.5 }, { x: 0.6, y: 0, w: 0.5, h: 0.5 }, { x: 0, y: 0.6, w: 0.5, h: 0.5 }, { x: 0, y: 0, w: 1.0001, h: 1 },
    { x: '0', y: 0, w: 1, h: 1 }, { x: null, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 1 }, { x: 0, y: 0, w: 1, h: 1, extra: 1 }, [0, 0, 1, 1], 'full', 5, null]) {
    rejects(sa(no), /safeArea/);
  }
  const huge = fresh(); const mf = path.join(huge.src, 'manifest.json'); fs.writeFileSync(mf, fs.readFileSync(mf, 'utf8').replace('"background"', '"safeArea":{"x":0,"y":0,"w":1e999,"h":1},"background"'));
  assert.match(packs.validatePack(huge.src).error, /safeArea/);
  rejects(m => { m.safeAreaTypical = { x: 0.9, y: 0, w: 0.5, h: 0.5 }; }, /safeAreaTypical/);
  rejects(m => { m.safeAreaTypical = 'x'; }, /safeAreaTypical/);
  assert.strictEqual(packs.validatePack(fresh(m => { m.safeAreaTypical = { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }; }).src).ok, true, 'typical alone is fine');
});

test('backward compatibility: packs without poster, posters or safe areas are unchanged', () => {
  const r = packs.validatePack(fresh().src);
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(Object.keys(r.files).sort(), FILES);
  assert.strictEqual(r.manifest.poster, undefined); assert.strictEqual(r.manifest.safeArea, undefined);
});

test('install copies exactly the listed poster files (not unlisted art) and rejects a bad safeArea', () => {
  const f = withPosters(m => { m.posters.unused = 'art/unused.png'; }, d => { fs.writeFileSync(path.join(d, 'art', 'unused.png'), png(4, 4)); fs.writeFileSync(path.join(d, 'art', 'extra.png'), png(4, 4)); });
  const r = packs.installPack(f.src, { home: f.home, id: 'bird' });
  assert.deepStrictEqual([...r.files].sort(), [...FILES, 'art/pose-a.png', 'art/pose-b.jpg'].sort());
  assert.ok(!fs.existsSync(path.join(f.home, 'faces', 'bird', 'art', 'extra.png')));
  assert.ok(!fs.existsSync(path.join(f.home, 'faces', 'bird', 'art', 'unused.png')));
  packs.clearCache();
  const p = packs.getPack('bird', { home: f.home });
  assert.strictEqual(p.files['art/pose-b.jpg'].mime, 'image/jpeg');
  assert.deepStrictEqual(p.manifest.safeArea, { x: 0.1, y: 0.05, w: 0.8, h: 0.9 });
  const bad = withPosters(m => { m.safeArea = { x: 0.5, y: 0, w: 0.9, h: 1 }; });
  assert.throws(() => packs.installPack(bad.src, { home: bad.home, id: 'bad' }), /safeArea/);
  assert.ok(!fs.existsSync(path.join(bad.home, 'faces', 'bad')));
});
