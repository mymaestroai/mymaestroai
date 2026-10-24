'use strict';
// Behavioural unit tests for lib/images.js. The module hard-codes <hub>/data/uploads and <hub>/data/image-gen/out from its own
// __dirname, so it is copied into a temp "hub" and the copy is required. Only fs/path/crypto are used, so no node_modules link.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-images-'));
const HUB = path.join(ROOT, 'hub');
fs.mkdirSync(path.join(HUB, 'lib'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '..', 'lib', 'images.js'), path.join(HUB, 'lib', 'images.js'));
fs.copyFileSync(path.join(__dirname, '..', 'lib', 'hub-home.js'), path.join(HUB, 'lib', 'hub-home.js'));
fs.mkdirSync(path.join(ROOT, 'share'));                // an existing install's layout: share/ beside it keeps the hub home there (lib/hub-home)
const OUTSIDE = path.join(ROOT, 'outside');            // under os.tmpdir(): a servable root
fs.mkdirSync(OUTSIDE);
// A writable dir that is NOT under any servable root (/tmp, the hub dirs, ~/agent-hub/*): /var/tmp or /dev/shm.
const FORBIDDEN = fs.mkdtempSync(path.join(['/var/tmp', '/dev/shm'].find(d => { try { fs.accessSync(d, fs.constants.W_OK); return true; } catch { return false; } }), 'unit-images-outside-'));
const quiet = { log: console.log, error: console.error };
console.log = () => {}; console.error = () => {};
const images = require(path.join(HUB, 'lib', 'images.js'));
test.after(() => { console.log = quiet.log; console.error = quiet.error; fs.rmSync(ROOT, { recursive: true, force: true }); fs.rmSync(FORBIDDEN, { recursive: true, force: true }); });

// A genuine 1x1 PNG built from scratch (signature + IHDR + IDAT + IEND with CRCs).
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 0, 0]))), chunk('IEND', Buffer.alloc(0))]);
const PNG_B64 = PNG.toString('base64');

function fakeRes() { const r = { status: null, headers: null, body: null, writeHead(s, h) { r.status = s; r.headers = h; }, end(b) { r.body = b; } }; return r; }
const enc = (p) => Buffer.from(p).toString('base64');

test('module creates its upload and image-gen dirs under the (temp) hub at load', () => {
  assert.strictEqual(images.UPLOAD_DIR, path.join(HUB, 'data', 'uploads'));
  assert.deepStrictEqual(images.IMAGE_OUTPUT_DIRS, [path.join(HUB, 'data', 'image-gen', 'out')]);
  assert.ok(fs.statSync(images.UPLOAD_DIR).isDirectory());
  assert.ok(fs.statSync(images.IMAGE_OUTPUT_DIRS[0]).isDirectory());
});

test('saveUploadedImage: image data URLs land in UPLOAD_DIR with the extension taken from the MIME type', () => {
  const a = images.saveUploadedImage(`data:image/png;base64,${PNG_B64}`);
  assert.strictEqual(path.dirname(a), images.UPLOAD_DIR);
  assert.match(path.basename(a), /^[0-9a-f]{32}\.png$/);
  assert.ok(fs.readFileSync(a).equals(PNG));
  const b = images.saveUploadedImage(`data:image/png;base64,${PNG_B64}`);
  assert.notStrictEqual(a, b, 'unique name per save');
  assert.match(path.basename(images.saveUploadedImage(`data:image/jpeg;base64,${PNG_B64}`)), /\.jpg$/);
  assert.match(path.basename(images.saveUploadedImage(`data:image/webp;base64,${PNG_B64}`)), /\.webp$/);
  assert.match(path.basename(images.saveUploadedImage(`data:image/gif;base64,${PNG_B64}`)), /\.gif$/);
  assert.strictEqual(images.saveUploadedImage(undefined), null, 'non-string input -> null, no throw');
});

test('saveUploadedImage rejects non-image MIME, raw base64, payloads over 20 MB and invalid base64 (returns null, writes nothing)', () => {
  const before = fs.readdirSync(images.UPLOAD_DIR).length;
  const bad = [
    `data:text/html;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}`,
    `data:image/svg+xml;base64,${Buffer.from('<svg onload="x()"/>').toString('base64')}`,
    `data:image/bmp;base64,${PNG_B64}`,
    PNG_B64,                                                         // raw base64 without a data: header
    'data:image/png;base64',                                         // no payload separator
    `data:image/png;base64,${Buffer.alloc(21 * 1024 * 1024, 7).toString('base64')}`,
    'data:image/png;base64,!!!***###',                               // no base64 chars at all: decodes to 0 bytes
    'data:image/png;base64,',
  ];
  for (const input of bad) assert.strictEqual(images.saveUploadedImage(input), null, input.slice(0, 40));
  assert.strictEqual(fs.readdirSync(images.UPLOAD_DIR).length, before, 'nothing written for rejected inputs');
  const ok = images.saveUploadedImage(`data:image/png;base64,${Buffer.alloc(3 * 1024 * 1024, 7).toString('base64')}`);
  assert.strictEqual(fs.statSync(ok).size, 3 * 1024 * 1024, '3 MiB is under the limit');
});

test('serveImage: serves an image under UPLOAD_DIR with MIME, length and cache headers', () => {
  const p = images.saveUploadedImage(`data:image/png;base64,${PNG_B64}`);
  const res = fakeRes();
  images.serveImage(enc(p), res);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.headers, { 'Content-Type': 'image/png', 'Content-Length': PNG.length, 'Cache-Control': 'max-age=3600' });
  assert.ok(res.body.equals(PNG));
  const up = path.join(images.UPLOAD_DIR, 'x.JPG'); fs.writeFileSync(up, PNG);
  const r2 = fakeRes(); images.serveImage(enc(up), r2);
  assert.strictEqual(r2.headers['Content-Type'], 'image/jpeg', 'extension match is case-insensitive');
});

test('serveImage serves only files under the allowed roots (upload dir, image-gen out, /tmp, hub home dirs, workspaces)', () => {
  const tmpImg = path.join(OUTSIDE, 'chart.png'); fs.writeFileSync(tmpImg, PNG);   // OUTSIDE is under os.tmpdir(): allowed
  const a = fakeRes(); images.serveImage(enc(tmpImg), a);
  assert.strictEqual(a.status, 200); assert.ok(a.body.equals(PNG));
  const gen = path.join(images.IMAGE_OUTPUT_DIRS[0], 'g.webp'); fs.writeFileSync(gen, PNG);
  const g = fakeRes(); images.serveImage(enc(gen), g);
  assert.strictEqual(g.status, 200); assert.strictEqual(g.headers['Content-Type'], 'image/webp');
  const ws = path.join(HUB, 'workspaces', 'trader'); fs.mkdirSync(ws, { recursive: true });
  const wsImg = path.join(ws, 'plot.png'); fs.writeFileSync(wsImg, PNG);
  const w = fakeRes(); images.serveImage(enc(wsImg), w);
  assert.strictEqual(w.status, 200, 'hub workspaces/ is servable');
  const rel = fakeRes(); images.serveImage(enc(path.relative(process.cwd(), tmpImg)), rel);
  assert.strictEqual(rel.status, 200, 'relative paths resolve against cwd before the root check');
  // A file outside every root is a 404 even though it exists and has an image extension.
  const secret = path.join(FORBIDDEN, 'private-photo.png'); fs.writeFileSync(secret, PNG);
  const s = fakeRes(); images.serveImage(enc(secret), s);
  assert.strictEqual(s.status, 404); assert.strictEqual(s.body, 'Image not found');
  // A symlink inside an allowed root pointing outside is resolved and refused.
  const link = path.join(OUTSIDE, 'link.png'); fs.symlinkSync(secret, link);
  const l = fakeRes(); images.serveImage(enc(link), l);
  assert.strictEqual(l.status, 404);
  const trav = fakeRes(); images.serveImage(enc(path.join(OUTSIDE, '..', '..', path.relative(ROOT + '/..', FORBIDDEN), 'private-photo.png')), trav);
  assert.strictEqual(trav.status, 404, '.. traversal out of an allowed root is refused');
});

test('hub home is the folder holding the install, wherever it is: its share/, users/, medical/, legal/ are servable', () => {
  // Regression: HUB_HOME was fixed at ~/agent-hub, so with the install at e.g. ~/dev/mymaestroai/mymaestroai every
  // Files-folder image (share/<agent>/...) was a 404 and chat previews were blank. The home here is under /var/tmp
  // (or /dev/shm), outside every other root, so only the hub-home rule can make these files servable.
  const home = path.join(FORBIDDEN, 'hubhome');
  fs.mkdirSync(path.join(home, 'install', 'lib'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'lib', 'images.js'), path.join(home, 'install', 'lib', 'images.js'));
  fs.copyFileSync(path.join(__dirname, '..', 'lib', 'hub-home.js'), path.join(home, 'install', 'lib', 'hub-home.js'));
  fs.mkdirSync(path.join(home, 'share'));               // an install made before 5.6: its folders sit beside it (lib/hub-home)
  const placed = require(path.join(home, 'install', 'lib', 'images.js'));
  const realHome = fs.realpathSync(home);                  // macOS: /var is a link to /private/var
  assert.strictEqual(placed.HUB_HOME, realHome);
  for (const sub of ['share', 'users', 'medical', 'legal']) assert.ok(placed.SERVE_ROOTS.includes(path.join(realHome, sub)), sub);
  assert.ok(!placed.SERVE_ROOTS.includes(path.join(os.homedir(), 'agent-hub', 'share')) || home === path.join(os.homedir(), 'agent-hub'), 'no fixed ~/agent-hub root');
  const preview = path.join(home, 'share', 'agent-lead', 'preview', 'gh-desktop.png');
  fs.mkdirSync(path.dirname(preview), { recursive: true }); fs.writeFileSync(preview, PNG);
  const ok = fakeRes(); placed.serveImage(enc(preview), ok);
  assert.strictEqual(ok.status, 200, 'a Files-folder image under the real hub home is served');
  assert.strictEqual(ok.headers['Content-Type'], 'image/png');
  // A sibling of the hub home's folders is still outside: only the known subfolders are roots, not the home itself.
  const stray = path.join(home, 'backups', 'x.png'); fs.mkdirSync(path.dirname(stray), { recursive: true }); fs.writeFileSync(stray, PNG);
  const no = fakeRes(); placed.serveImage(enc(stray), no);
  assert.strictEqual(no.status, 404, 'backups/ under the hub home is not servable');
});

test('serveImage: missing, outside, non-image and directory paths all give the same 404 (no existence oracle)', () => {
  const expect404 = (p, label) => { const r = fakeRes(); images.serveImage(enc(p), r); assert.strictEqual(r.status, 404, label); assert.strictEqual(r.body, 'Image not found', label); };
  const exists = path.join(FORBIDDEN, 'notes.txt'); fs.writeFileSync(exists, 'hi');
  expect404(exists, 'existing non-image outside the roots');
  expect404(path.join(FORBIDDEN, 'missing.txt'), 'missing outside the roots');
  expect404(path.join(FORBIDDEN, 'missing.png'), 'missing image name outside the roots');
  const inside = path.join(OUTSIDE, 'notes.txt'); fs.writeFileSync(inside, 'hi');
  expect404(inside, 'existing non-image inside a root');
  expect404(path.join(OUTSIDE, 'missing.png'), 'missing inside a root');
  expect404(OUTSIDE, 'a directory');
  const dir = path.join(OUTSIDE, 'dir.png'); fs.mkdirSync(dir);
  expect404(dir, 'a directory named like an image');
  expect404('/etc/passwd', 'system file');
  const bad = fakeRes(); images.serveImage('%%%', bad);
  assert.strictEqual(bad.status, 404, 'undecodable path');
});

test('getRecentImages: filters by extension and mtime, sorted oldest first, ~ expands to HOME, missing dir -> []', () => {
  const dir = path.join(OUTSIDE, 'gen'); fs.mkdirSync(dir);
  const mk = (name, t) => { const p = path.join(dir, name); fs.writeFileSync(p, PNG); fs.utimesSync(p, t, t); return p; };
  const old = mk('old.png', 1000), mid = mk('mid.jpg', 2000), newest = mk('new.webp', 3000); mk('note.txt', 3000); mk('c.PNG', 2500);
  assert.deepStrictEqual(images.getRecentImages(dir, 0), [old, mid, path.join(dir, 'c.PNG'), newest]);
  assert.deepStrictEqual(images.getRecentImages(dir, 2000), [path.join(dir, 'c.PNG'), newest], 'strictly newer than sinceTime');
  assert.deepStrictEqual(images.getRecentImages(path.join(dir, 'nope'), 0), []);
  const savedHome = process.env.HOME; process.env.HOME = OUTSIDE;
  try { assert.deepStrictEqual(images.getRecentImages('~/gen', 2999), [newest]); } finally { process.env.HOME = savedHome; }
});

test('imagePathsToUrls: uploads are skipped, others become /api/image/<base64 path>', () => {
  const up = path.join(images.UPLOAD_DIR, 'a.png'), gen = path.join(images.IMAGE_OUTPUT_DIRS[0], 'b.png');
  assert.deepStrictEqual(images.imagePathsToUrls([up, gen, '/elsewhere/c.png']), [`/api/image/${enc(gen)}`, `/api/image/${enc('/elsewhere/c.png')}`]);
  assert.deepStrictEqual(images.imagePathsToUrls([]), []);
});

test('parseMediaLines: MEDIA: lines with existing files are extracted, Saved: lines dropped, rest kept verbatim', () => {
  const real = path.join(OUTSIDE, 'm.png'); fs.writeFileSync(real, PNG);
  const out = images.parseMediaLines(`Here you go\nMEDIA: ${real}  \nMEDIA: /nope/missing.png\nSaved: ${real}\n  MEDIA: indented stays\n\nend`);
  assert.deepStrictEqual(out, { cleanedText: 'Here you go\n  MEDIA: indented stays\n\nend', imagePaths: [real] });
  assert.deepStrictEqual(images.parseMediaLines(''), { cleanedText: '', imagePaths: [] });
});

test('imagesToAnthropicFormat: base64 blocks with media type by extension, unknown ext -> image/png, unreadable skipped', () => {
  const png = path.join(OUTSIDE, 'f.png'), jpg = path.join(OUTSIDE, 'f.jpeg'), odd = path.join(OUTSIDE, 'f.bin');
  for (const p of [png, jpg, odd]) fs.writeFileSync(p, PNG);
  const blocks = images.imagesToAnthropicFormat([png, jpg, odd, path.join(OUTSIDE, 'missing.png')]);
  assert.deepStrictEqual(blocks.map(b => [b.type, b.source.type, b.source.media_type]), [['image', 'base64', 'image/png'], ['image', 'base64', 'image/jpeg'], ['image', 'base64', 'image/png']]);
  assert.strictEqual(blocks[0].source.data, PNG_B64);
});

test('markProcessed / isProcessed track exact paths in memory', () => {
  assert.strictEqual(images.isProcessed('/a.png'), false);
  images.markProcessed('/a.png');
  assert.strictEqual(images.isProcessed('/a.png'), true);
  assert.strictEqual(images.isProcessed('/A.png'), false);
});

test('server.js hands serveImage the encoded path from the URL, not the request object (every embedded image was a 500)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(!/serveImage\(req,/.test(src), 'the old call passed req');
  assert.match(src, /pathname\.slice\('\/api\/image\/'\.length\)/);
  assert.match(src, /return serveImage\(encoded, res\)/);
});
