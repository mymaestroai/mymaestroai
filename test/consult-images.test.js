'use strict';
// consult_agent / spawn_workers images: schema, validation, and delivery to the consulted turn as imagePaths.
const { test, after, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-images-'));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(32)]);
const file = (name, buf) => { const p = path.join(tmp, name); fs.writeFileSync(p, buf); return p; };
const pngFile = file('a.png', PNG);
const jpgFile = file('b.jpg', JPG);
const webpFile = file('c.webp', WEBP);
const dataUrl = `data:image/png;base64,${PNG.toString('base64')}`;

let server, sdkChat, ci, port;
const seen = [];          // what each consulted turn received
const convDir = path.join(__dirname, '..', 'data', 'conversations');
const TARGET = 'zz_img_target';

before(async () => {
  port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  process.env.PORT = String(port);                       // sdk-chat reads the hub port when it loads
  delete process.env.HUB_AUTH_USERNAME; delete process.env.HUB_AUTH_PASSWORD;
  process.env.HUB_HALT_FILE = path.join(tmp, 'hub-halt.json');
  sdkChat = require('../lib/sdk-chat');
  ci = require('../lib/consult-images');
  const { sendSSE, makeChunk, setTestStreamer } = sdkChat.__turn;
  setTestStreamer(async ({ agent, res, message, imagePaths, finalMessage }) => {
    seen.push({ agent, message, imagePaths: [...imagePaths], finalMessage });
    sendSSE(res, makeChunk(`I can see ${imagePaths.length} image(s)`, 'm'));
    res.write('data: [DONE]\n\n'); res.end();
  });
  // a stand-in for the hub's own HTTP listener: consultations POST to it exactly as in production
  server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/chat/stream') { res.writeHead(404); return res.end(); }
    let b = ''; req.on('data', c => b += c); req.on('end', () => sdkChat.handleChatStream(JSON.parse(b), res).catch(e => { try { res.end(); } catch {} }));
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
});
after(() => {
  sdkChat && sdkChat.__turn.setTestStreamer(null);
  server && server.close();
  try { fs.unlinkSync(path.join(convDir, `${TARGET}.jsonl`)); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

const sdkStub = { tool: (name, description, shape, handler, opts) => ({ name, description, shape, handler, opts }), createSdkMcpServer: (cfg) => cfg };
const fakeRes = () => ({ writableEnded: false, destroyed: false, on() {}, write() { return true; } });
async function tools() { return (await sdkChat.__askUser.buildHubMcpServer('zz_img_caller', fakeRes(), sdkStub, {})).tools; }

test('SDK/Codex tool schemas: consult_agent and each spawn_workers entry take an optional images array', async () => {
  const t = await tools();
  const consult = t.find(x => x.name === 'consult_agent');
  assert.ok(consult.shape.images, 'consult_agent.images');
  assert.ok(consult.shape.images.isOptional());
  assert.strictEqual(consult.shape.images.safeParse(['/a.png']).success, true);
  assert.strictEqual(consult.shape.images.safeParse([1]).success, false);
  assert.match(consult.shape.images.description, /absolute file path|data URL/);
  const spawn = t.find(x => x.name === 'spawn_workers');
  const item = spawn.shape.workers.element;
  assert.ok(item.shape.images && item.shape.images.isOptional(), 'spawn_workers workers[].images');
});

test('the gateway tool list declares images too (JSON schema)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  const n = (src.match(/images: \{ type: 'array', items: \{ type: 'string' \}, description: consultImages\.IMAGES_DESCRIPTION \}/g) || []).length;
  assert.strictEqual(n, 2, 'consult_agent and spawn_workers.items in the gateway tool array');
});

test('consult_agent with a file path and a data URL: the consulted turn gets imagePaths; the log notes the attachment', async () => {
  seen.length = 0;
  const consult = (await tools()).find(x => x.name === 'consult_agent');
  const out = await consult.handler({ agent: TARGET, prompt: 'What is in these?', images: [pngFile, dataUrl, jpgFile] });
  assert.match(out.content[0].text, /I can see 3 image\(s\)/);
  assert.strictEqual(seen.length, 1);
  const s = seen[0];
  assert.strictEqual(s.agent, TARGET);
  assert.strictEqual(s.imagePaths.length, 3);
  assert.strictEqual(s.imagePaths[0], pngFile);
  assert.strictEqual(s.imagePaths[2], jpgFile);
  assert.ok(s.imagePaths[1] !== dataUrl && path.isAbsolute(s.imagePaths[1]) && fs.existsSync(s.imagePaths[1]), 'data URL was saved to a file');
  assert.match(s.finalMessage, /\[Image: .*a\.png\]/, 'image refs are prepended like an owner upload');
  assert.match(s.message, /\[3 images attached by "zz_img_caller"/, 'the consulted agent is told');
  const log = fs.readFileSync(path.join(convDir, `${TARGET}.jsonl`), 'utf8');
  assert.match(log, /3 images attached by/, 'the consulted agent\'s conversation records the attachment');
});

test('consult_agent without images is unchanged (no imagePaths, no note)', async () => {
  seen.length = 0;
  const consult = (await tools()).find(x => x.name === 'consult_agent');
  await consult.handler({ agent: TARGET, prompt: 'plain question' });
  assert.deepStrictEqual(seen[0].imagePaths, []);
  assert.doesNotMatch(seen[0].message, /attached/);
});

test('spawn_workers passes each worker its own images', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.match(src, /imagesByIndex\.get\(job\.index\)/);
  const spawn = (await tools()).find(x => x.name === 'spawn_workers');
  const out = await spawn.handler({ workers: [{ task: 'look', images: ['relative.png'] }] });
  assert.match(out.content[0].text, /worker 1: \[IMAGES REJECTED\].*not an absolute path/);
});

test('invalid images are rejected with a clear message and nothing is sent', async () => {
  seen.length = 0;
  const consult = (await tools()).find(x => x.name === 'consult_agent');
  const text = async (images) => (await consult.handler({ agent: TARGET, prompt: 'x', images })).content[0].text;
  assert.match(await text([path.join(tmp, 'missing.png')]), /\[IMAGES REJECTED\] images\[0\]: file not found/);
  assert.match(await text(['relative/p.png']), /not an absolute path/);
  assert.match(await text([file('notes.txt', Buffer.from('hello world, not an image at all'))]), /not a jpg, png, webp or gif file/);
  assert.match(await text([file('fake.png', Buffer.from('this is plainly not a png'))]), /does not contain image data/);
  assert.match(await text(Array(9).fill(pngFile)), /too many images: 9 given, at most 8/);
  assert.match(await text(['data:text/plain;base64,aGk=']), /data URL must be base64 image/);
  assert.match(await text('nope'), /must be an array|Expected|IMAGES REJECTED/);
  assert.strictEqual(seen.length, 0, 'no consultation ran');
});

test('size limit: a file over 10 MB is rejected', () => {
  const big = file('big.png', Buffer.concat([PNG, Buffer.alloc(ci.MAX_BYTES)]));
  const r = ci.resolveImages([big]);
  assert.match(r.error, /MB, the limit is 10 MB/);
  assert.strictEqual(ci.resolveImages([pngFile, jpgFile, webpFile]).paths.length, 3);
  assert.deepStrictEqual(ci.resolveImages(undefined), { paths: [] });
});

test('the chat route re-validates image_files (paths only, never data URLs)', async () => {
  const res = { code: null, body: '', writableEnded: false, destroyed: false, on() {}, writeHead(c) { this.code = c; }, write(s) { this.body += s; return true; }, end(s) { if (s) this.body += s; this.writableEnded = true; } };
  await sdkChat.handleChatStream({ agent: TARGET, message: 'hi', image_files: ['/nonexistent/x.png'] }, res);
  assert.strictEqual(res.code, 400);
  assert.match(res.body, /image_files\[0\]: file not found/);
  const res2 = { ...res, code: null, body: '' };
  await sdkChat.handleChatStream({ agent: TARGET, message: 'hi', image_files: [dataUrl] }, res2);
  assert.strictEqual(res2.code, 400);
  assert.match(res2.body, /data URLs are not accepted/);
});

test('imageNote names the count, the sender and the paths', () => {
  assert.strictEqual(ci.imageNote([], 'x'), '');
  assert.match(ci.imageNote([pngFile], 'maestro'), /\[1 image attached by "maestro": .*a\.png/);
  assert.match(ci.imageNote([pngFile, jpgFile], null), /\[2 images attached:/);
});
