'use strict';
// Fix round r2 (hub): approvals are re-checked after the owner answers; connector tool results carry images to the
// agent (Claude SDK and gateway paths) without leaving them in text; the runtime check needs each entry file.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const installer = require('../lib/modules/installer');
const connectorsLib = require('../lib/connectors');
const { createConnectors } = connectorsLib;
const { createApprovals } = require('../lib/approvals');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

function rig(o = {}, result = { content: [{ type: 'text', text: 'ok' }] }) {
  const dir = tmp('hub-r2-');
  const all = [];
  class FakeClient extends EventEmitter {
    constructor() { super(); this.calls = []; this.responses = []; this.errors = []; all.push(this); }
    async connect() {} async listTools() { return [{ name: 'one' }]; } async disconnect() {}
    async callTool(name, args) { this.calls.push({ name, args }); return typeof result === 'function' ? result(name, args) : result; }
    respond(id, r) { this.responses.push({ id, result: r }); }
    respondError(id, code, message) { this.errors.push({ id, code, message }); }
  }
  const leads = ['owner'];
  const cx = createConnectors({ file: path.join(dir, 'connectors.json'), keyFile: path.join(dir, '.auth-key'), McpClient: FakeClient, log: () => {}, unlockTtlMs: 0, baseEnv: { PATH: process.env.PATH }, leadNames: () => leads, ...o });
  const up = (extra = {}) => cx.upsert({ id: 'rc', label: 'Remote computers', kind: 'mcp', command: process.execPath, args: ['x'], module: 'rc', enabled: true, approvals: true, agents: ['sam'], ...extra }, { byModule: true });
  const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
  const spec = async (agent = 'sam') => (await cx.toolSpecsFor(agent)).find(s => s.connector === 'rc');
  return { cx, dir, all, up, tick, spec, leads, done: () => { cx.shutdown(); rm(dir); } };
}

/** An approvals double the test answers by hand. */
function manualApprovals() {
  const open = [];
  return { open, request: (spec) => { let resolve; const promise = new Promise(r => { resolve = r; }); open.push({ spec, resolve }); return { id: `ap${open.length}`, promise }; } };
}

/** A call that is still running (so its id is live) and the id the hub put in its arguments. */
async function runningCall(r, agent = 'sam') {
  const s = await r.spec(agent);
  await s.handler({});                       // starts the (fake) server
  const cl = r.all[r.all.length - 1];
  let release;
  const prev = cl.callTool;
  cl.callTool = async function (name, args) { this.calls.push({ name, args }); await new Promise(res => { release = res; }); return { content: [{ type: 'text', text: 'ok' }] }; };
  const pending = s.handler({});
  await r.tick();
  cl.callTool = prev;
  return { cl, id: cl.calls[cl.calls.length - 1].args.__call, finish: async () => { release(); await pending; } };
}

// ---- 1. approval re-check ----
test('R2 approve: allow, then the grant is removed during the wait -> deny', async () => {
  const ap = manualApprovals();
  const r = rig({ getApprovals: () => ap });
  try {
    r.up();
    const { cl, id, finish } = await runningCall(r);
    cl.emit('request', { id: 1, method: 'hub/approve', params: { call: id, title: 'Open it' } }); await r.tick();
    assert.strictEqual(ap.open.length, 1);
    r.cx.upsert({ id: 'rc', agents: [] }, { byModule: true });   // the owner took the agent away meanwhile
    ap.open[0].resolve({ decision: 'allow', by: 'owner' }); await r.tick();
    assert.deepStrictEqual(cl.responses[0].result, { decision: 'deny' });
    await finish();
  } finally { r.done(); }
});

test('R2 approve: allow, then the connector is disabled / the call id is gone -> deny; unchanged -> allow', async () => {
  const ap = manualApprovals();
  const clock = { t: 7000000 };
  const r = rig({ getApprovals: () => ap, now: () => clock.t });
  try {
    r.up();
    const a = await runningCall(r);
    a.cl.emit('request', { id: 1, method: 'hub/approve', params: { call: a.id, title: 'One' } }); await r.tick();
    ap.open[0].resolve({ decision: 'allow', by: 'owner' }); await r.tick();
    assert.deepStrictEqual(a.cl.responses[0].result, { decision: 'allow' }, 'nothing changed: the owner answer stands');
    // disabled during the wait
    clock.t += 16000;
    a.cl.emit('request', { id: 2, method: 'hub/approve', params: { call: a.id, title: 'Two' } }); await r.tick();
    r.cx.upsert({ id: 'rc', enabled: false }, { byModule: true });
    ap.open[1].resolve({ decision: 'allow', by: 'owner' }); await r.tick();
    assert.deepStrictEqual(a.cl.responses[1].result, { decision: 'deny' });
    await a.finish();
    // the call returned and its few seconds ran out during the wait
    r.up(); clock.t += 16000;
    const b = await runningCall(r);
    b.cl.emit('request', { id: 1, method: 'hub/approve', params: { call: b.id, title: 'Three' } }); await r.tick();
    await b.finish();
    clock.t += 10 * 60 * 1000;
    ap.open[2].resolve({ decision: 'allow', by: 'owner' }); await r.tick();
    assert.deepStrictEqual(b.cl.responses[0].result, { decision: 'deny' });
  } finally { r.done(); }
});

test('R2 approve: a deny or timeout from the owner is passed on unchanged', async () => {
  const ap = manualApprovals();
  const clock = { t: 8000000 };
  const r = rig({ getApprovals: () => ap, now: () => clock.t });
  try {
    r.up();
    const a = await runningCall(r);
    a.cl.emit('request', { id: 1, method: 'hub/approve', params: { call: a.id, title: 'One' } }); await r.tick();
    ap.open[0].resolve({ decision: 'deny', by: 'timeout' }); await r.tick();
    assert.deepStrictEqual(a.cl.responses[0].result, { decision: 'timeout' });
    await a.finish();
  } finally { r.done(); }
});

test('R2 approvals: changing the agents, disabling, locking or removing a connector denies its open cards', async () => {
  const ap = createApprovals({ log: () => {} });
  const clock = { t: 9000000 };
  const r = rig({ getApprovals: () => ap, now: () => clock.t });
  try {
    r.up();
    const ask = async (title) => {
      clock.t += 16000;
      const c = await runningCall(r);
      c.cl.emit('request', { id: 1, method: 'hub/approve', params: { call: c.id, title } }); await r.tick();
      return c;
    };
    let c = await ask('Grants');
    assert.strictEqual(ap.list().length, 1);
    r.cx.upsert({ id: 'rc', agents: [] }, { byModule: true }); await r.tick();
    assert.strictEqual(ap.list().length, 0, 'the card is gone when the grants change');
    assert.deepStrictEqual(c.cl.responses[0].result, { decision: 'deny' });
    await c.finish();
    r.up();
    c = await ask('Disabled');
    r.cx.upsert({ id: 'rc', enabled: false }, { byModule: true });
    assert.strictEqual(ap.list().length, 0, 'the card is gone when the connector is switched off');
    await c.finish();
    r.up();
    c = await ask('Removed');
    r.cx.remove('rc', { byModule: true });
    assert.strictEqual(ap.list().length, 0, 'the card is gone when the connector is removed');
    await c.finish();
  } finally { r.done(); }
});

// ---- 2. images in connector results ----
const crcless = (w, h, extra = 0) => {   // a PNG header (signature + IHDR) followed by `extra` filler bytes: enough for the hub's checks
  const b = Buffer.alloc(33 + extra);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
};
const jpeg = (w, h) => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
const part = (buf, mimeType) => ({ type: 'image', data: buf.toString('base64'), mimeType });

test('R2 images: a tool result with images reaches the agent as text plus image content (Claude SDK path)', async () => {
  const png = crcless(1600, 900, 210 * 1024);
  const r = rig({}, { content: [{ type: 'text', text: 'screen' }, part(png, 'image/png'), part(jpeg(640, 480), 'image/jpeg')] });
  try {
    r.up();
    const s = await r.spec();
    const out = await connectorsLib.sdkToolHandler(s)({});
    assert.strictEqual(out.content[0].type, 'text');
    assert.match(out.content[0].text, /^screen\n\[image: 1600x900 png, 210 KB\]\n\[image: 640x480 jpeg, 1 KB\]$/);
    const imgs = out.content.filter(p => p.type === 'image');
    assert.deepStrictEqual(imgs.map(p => p.mimeType), ['image/png', 'image/jpeg']);
    assert.strictEqual(imgs[0].data, png.toString('base64'));
    assert.ok(!out.content[0].text.includes(png.toString('base64').slice(0, 40)), 'no image data in the text');
    assert.doesNotMatch(await s.handler({}), /iVBOR|\/9j\//, 'the text-only handler carries no image data either');
  } finally { r.done(); }
});

test('R2 images: the gateway path queues the images on handlers.__images and returns only text', async () => {
  const png = crcless(32, 32);
  const r = rig({}, { content: [{ type: 'text', text: 'shot' }, part(png, 'image/png')] });
  try {
    r.up();
    const s = await r.spec();
    const handlers = new Map(); handlers.__images = [];
    const text = await connectorsLib.gatewayToolHandler(s, handlers)({});
    assert.strictEqual(text, 'shot\n[image: 32x32 png, 1 KB]');
    assert.strictEqual(handlers.__images.length, 1);
    assert.strictEqual(handlers.__images[0].tool, 'rc__one');
    assert.deepStrictEqual(Object.keys(handlers.__images[0].images[0]).sort(), ['base64', 'label', 'mime']);
    assert.strictEqual(handlers.__images[0].images[0].mime, 'image/png');
    // no hands tools this turn: the queue is made on demand
    const bare = new Map();
    await connectorsLib.gatewayToolHandler(s, bare)({});
    assert.strictEqual(bare.__images.length, 1);
  } finally { r.done(); }
});

test('R2 images: at most 2 per result, 5 MB each, png/jpeg/webp only; the rest are dropped with a note', async () => {
  const big = crcless(10, 10, 5 * 1024 * 1024);          // over 5 MB decoded
  const ok = crcless(10, 10);
  const webp = Buffer.alloc(40); webp.write('RIFF', 0, 'latin1'); webp.write('WEBP', 8, 'latin1'); webp.write('VP8X', 12, 'latin1'); webp.writeUIntLE(99, 24, 3); webp.writeUIntLE(49, 27, 3);
  const r = rig({}, { content: [
    part(ok, 'image/gif'), part(big, 'image/png'), part(Buffer.from('not an image at all, just text bytes'), 'image/png'),
    { type: 'image', data: '!!!', mimeType: 'image/png' },
    part(ok, 'image/png'), part(webp, 'image/webp'), part(ok, 'image/png'),
  ] });
  try {
    r.up();
    const out = await (await r.spec()).run({});
    assert.strictEqual(out.images.length, 2);
    assert.deepStrictEqual(out.images.map(i => i.mime), ['image/png', 'image/webp']);
    const lines = out.text.split('\n');
    assert.deepStrictEqual(lines, [
      '[image dropped: only jpeg, png and webp are shown]',
      `[image dropped: ${Math.ceil(big.length / 1024)} KB is over the 5 MB limit]`,
      '[image dropped: not valid image data]',
      '[image dropped: not valid image data]',
      '[image: 10x10 png, 1 KB]',
      '[image: 100x50 webp, 1 KB]',
      '[image dropped: at most 2 images per result]',
    ]);
  } finally { r.done(); }
});

test('R2 images: nothing is written to disk and no log line holds image data', async () => {
  const png = crcless(8, 8, 4096);
  const logs = [];
  const r = rig({ log: (m) => logs.push(String(m)) }, { content: [{ type: 'text', text: 'x' }, part(png, 'image/png')] });
  try {
    r.up();
    const s = await r.spec(); await s.run({});
    const before = fs.readdirSync(r.dir).sort();
    await s.run({});
    assert.deepStrictEqual(fs.readdirSync(r.dir).sort(), before, 'the connectors folder gained no file');
    for (const f of fs.readdirSync(r.dir)) assert.ok(!fs.readFileSync(path.join(r.dir, f), 'utf8').includes(png.toString('base64').slice(8, 60)), `${f} has no image data`);
    assert.ok(!logs.some(l => l.includes(png.toString('base64').slice(8, 60))));
  } finally { r.done(); }
});

test('R2 images: a plain text result and callTool() stay strings', async () => {
  const r = rig({}, { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, part(crcless(4, 4), 'image/png')] });
  try {
    r.up();
    assert.strictEqual(await r.cx.callTool('rc', 'one', {}), 'a\nb\n[image: 4x4 png, 1 KB]');
    const s = await r.spec();
    assert.deepStrictEqual(Object.keys(await s.run({})).sort(), ['images', 'text']);
  } finally { r.done(); }
});

// ---- 3. runtime entry file ----
test('R2 installer: a runtime whose package entry file is gone is damaged', () => {
  const dir = tmp('hub-r2i-');
  try {
    const data = path.join(dir, 'modules'); const rt = path.join(data, 'demo', 'runtime');
    const lock = { name: 'x', lockfileVersion: 3, packages: { '': { name: 'x', version: '1.0.0', dependencies: { a: '1.0.0', b: '2.0.0', c: '3.0.0' } }, 'node_modules/a': { version: '1.0.0' }, 'node_modules/b': { version: '2.0.0' }, 'node_modules/c': { version: '3.0.0' } } };
    const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
    w(path.join(rt, 'package-lock.json'), JSON.stringify(lock));
    w(path.join(rt, installer.RUNTIME_MARK), JSON.stringify({ lockSha256: require('crypto').createHash('sha256').update(JSON.stringify(lock)).digest('hex') }));
    const nm = path.join(rt, 'node_modules');
    w(path.join(nm, 'a', 'package.json'), JSON.stringify({ name: 'a', version: '1.0.0', main: 'meshcentral.js' }));
    w(path.join(nm, 'a', 'meshcentral.js'), '');
    w(path.join(nm, 'b', 'package.json'), JSON.stringify({ name: 'b', version: '2.0.0' }));            // no main: index.js
    w(path.join(nm, 'b', 'index.js'), '');
    w(path.join(nm, 'c', 'package.json'), JSON.stringify({ name: 'c', version: '3.0.0', main: 'lib' }));   // a folder: lib/index.js
    w(path.join(nm, 'c', 'lib', 'index.js'), '');
    const ok = () => installer.runtimeInstalled(data, 'demo');
    assert.strictEqual(ok(), true);
    fs.rmSync(path.join(nm, 'a', 'meshcentral.js'));
    assert.strictEqual(ok(), false, 'main is gone');
    w(path.join(nm, 'a', 'meshcentral.js'), '');
    assert.strictEqual(ok(), true);
    fs.rmSync(path.join(nm, 'b', 'index.js'));
    assert.strictEqual(ok(), false, 'no main and no index.js');
    w(path.join(nm, 'b', 'index.js'), '');
    fs.rmSync(path.join(nm, 'c', 'lib', 'index.js'));
    assert.strictEqual(ok(), false, 'main is a folder without index.js');
    w(path.join(nm, 'c', 'lib', 'index.js'), '');
    w(path.join(nm, 'a', 'package.json'), JSON.stringify({ name: 'a', version: '1.0.0', main: 'meshcentral' }));   // Node adds .js
    assert.strictEqual(ok(), true);
    w(path.join(nm, 'a', 'package.json'), JSON.stringify({ name: 'a', version: '1.0.0', main: '../../b/index.js' }));   // never outside the package
    assert.strictEqual(ok(), false);
  } finally { rm(dir); }
});
