'use strict';
// Remote computers, the MeshCentral agent files: checked against the pinned manifest, downloaded only when missing or wrong.
// The fetch is a stand-in and every file lives in a temporary folder: nothing touches the network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ensureAgentFiles } = require('../modules/remote-computers/lib/agentfiles');

const sha = (buf) => crypto.createHash('sha384').update(buf).digest('hex');
const modeOf = (f) => fs.statSync(f).mode & 0o777;
const body = (s) => Buffer.from(s);

const FILES = [
  { filename: 'alpha.bin', asset: 'alpha-asset.bin', data: body('alpha contents') },
  { filename: 'beta.bin', asset: 'beta asset.bin'.replace(' ', '_'), data: body('beta contents are a bit longer') },
  { filename: 'gamma.bin', asset: 'gamma.bin', data: body('gamma') },
  { filename: 'delta.bin', asset: 'delta.bin', data: body('delta delta delta') },
];

function manifestFor(files = FILES, over = {}) {
  return {
    schemaVersion: 1,
    releases: [{ repository: 'example-org/example-agents', tag: 'v1.2.3', files: files.map((f) => ({ filename: f.filename, asset: f.asset, size: f.data.length, sha384: sha(f.data) })) }],
    ...over,
  };
}

function setup(manifest = manifestFor(), present = []) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-agents-'));
  const dir = path.join(runtimeDir, 'node_modules', 'meshcentral', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-defaults.json'), JSON.stringify(manifest));
  for (const f of present) fs.writeFileSync(path.join(dir, f.filename), f.data);
  return { runtimeDir, dir };
}

// A fetch that serves FILES by asset name and records what it was asked.
function serve(over = {}) {
  const calls = [];
  let active = 0, peak = 0;
  const fetch = async (url, opts) => {
    calls.push({ url, opts });
    active += 1; peak = Math.max(peak, active);
    try {
      await new Promise((r) => setImmediate(r));
      const asset = decodeURIComponent(url.split('/').pop());
      const f = FILES.find((x) => x.asset === asset);
      if (over.respond) return await over.respond(f, url, calls.length);
      return new Response(f.data, { status: 200 });
    } finally { active -= 1; }
  };
  return { fetch, calls, peak: () => peak };
}

const leftovers = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
const run = (s, fetch, extra = {}) => ensureAgentFiles({ runtimeDir: s.runtimeDir, fetch, ...extra });

test('all files present and correct: nothing is fetched', async () => {
  const s = setup(manifestFor(), FILES);
  const f = serve();
  const logs = [];
  const r = await run(s, f.fetch, { log: (m) => logs.push(m) });
  assert.deepStrictEqual(r, { total: 4, present: 4, downloaded: 0, bytes: 0 });
  assert.strictEqual(f.calls.length, 0);
  assert.deepStrictEqual(logs, []);
});

test('missing files are fetched, verified and renamed with mode 0600', async () => {
  const s = setup(manifestFor(), [FILES[0]]);
  const f = serve();
  const logs = [];
  const r = await run(s, f.fetch, { log: (m) => logs.push(m) });
  const want = FILES.slice(1).reduce((n, x) => n + x.data.length, 0);
  assert.deepStrictEqual(r, { total: 4, present: 1, downloaded: 3, bytes: want });
  for (const x of FILES) assert.deepStrictEqual(fs.readFileSync(path.join(s.dir, x.filename)), x.data);
  for (const x of FILES.slice(1)) assert.strictEqual(modeOf(path.join(s.dir, x.filename)), 0o600);
  assert.deepStrictEqual(leftovers(s.dir), []);
  assert.strictEqual(logs.length, 1);
  assert.match(logs[0], /^Downloading 3 MeshCentral agent files \(\d+ MB\) from GitHub \.\.\.$/);
  for (const c of f.calls) {
    assert.strictEqual(c.opts.redirect, 'follow');
    assert.strictEqual(c.opts.headers['User-Agent'], 'MyMaestro-RemoteComputers');
    assert.ok(c.opts.signal instanceof AbortSignal);
  }
});

test('the URL is exactly the GitHub release URL', async () => {
  const data = body('odd name');
  const m = { schemaVersion: 1, releases: [{ repository: 'Some-Org/repo.name_1', tag: 'v1.0+x'.replace('+', '-'), files: [{ filename: 'out.bin', asset: 'a.b-c_d.bin', size: data.length, sha384: sha(data) }] }] };
  const s = setup(m);
  const urls = [];
  await ensureAgentFiles({ runtimeDir: s.runtimeDir, fetch: async (url) => { urls.push(url); return new Response(data); } });
  assert.deepStrictEqual(urls, ['https://github.com/Some-Org/repo.name_1/releases/download/v1.0-x/a.b-c_d.bin']);
});

test('a wrong hash, a short body, a long body, a 404 and a thrown fetch each refuse and leave nothing behind', async () => {
  const cases = [
    ['wrong hash', (f) => new Response(Buffer.alloc(f.data.length, 0x41)), /does not match its SHA-384/],
    ['short body', (f) => new Response(f.data.subarray(0, f.data.length - 1)), /shorter than expected/],
    ['404', () => new Response('gone', { status: 404 }), /HTTP 404/],
    ['thrown fetch', () => { throw Object.assign(new Error('https://example.invalid/?token=SECRET'), { code: 'ECONNRESET' }); }, /the download failed \(ECONNRESET\)/],
  ];
  for (const [label, respond, re] of cases) {
    const s = setup(manifestFor(), [FILES[1], FILES[2], FILES[3]]);   // alpha is the missing one
    const f = serve({ respond });
    await assert.rejects(() => run(s, f.fetch), (e) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /^alpha\.bin: /, label);
      assert.match(e.message, re, label);
      assert.ok(!/SECRET|https?:|\n at /.test(e.message), `${label}: no url or stack in the message`);
      return true;
    }, label);
    assert.deepStrictEqual(leftovers(s.dir), [], `${label}: no temp file`);
    assert.ok(!fs.existsSync(path.join(s.dir, 'alpha.bin')), `${label}: nothing renamed`);
    for (const x of FILES.slice(1)) assert.deepStrictEqual(fs.readFileSync(path.join(s.dir, x.filename)), x.data, `${label}: good files kept`);
  }
});

test('a body longer than the size stops being read early', async () => {
  const s = setup(manifestFor(), [FILES[1], FILES[2], FILES[3]]);
  const want = FILES[0].data.length;
  let pulled = 0, cancelled = false;
  const chunk = Buffer.alloc(want, 0x42);
  const stream = new ReadableStream({
    pull(ctl) { pulled += 1; if (pulled > 1000) { ctl.close(); return; } ctl.enqueue(chunk); },
    cancel() { cancelled = true; },
  });
  const f = serve({ respond: () => new Response(stream, { status: 200 }) });
  await assert.rejects(() => run(s, f.fetch), /^Error: alpha\.bin: the download was longer than expected$/);
  assert.ok(pulled < 20, `stopped reading early (pulled ${pulled})`);
  assert.ok(cancelled, 'the body was cancelled');
  assert.deepStrictEqual(leftovers(s.dir), []);
  assert.ok(!fs.existsSync(path.join(s.dir, 'alpha.bin')));
});

test('a file with the right size but a wrong hash on disk is replaced', async () => {
  const s = setup(manifestFor(), [FILES[1], FILES[2], FILES[3]]);
  fs.writeFileSync(path.join(s.dir, 'alpha.bin'), Buffer.alloc(FILES[0].data.length, 0x43));
  const f = serve();
  const r = await run(s, f.fetch);
  assert.strictEqual(r.downloaded, 1);
  assert.deepStrictEqual(fs.readFileSync(path.join(s.dir, 'alpha.bin')), FILES[0].data);
});

test('a symlink is not trusted: it is replaced by a download and its target is untouched', async () => {
  const s = setup(manifestFor(), [FILES[1], FILES[2], FILES[3]]);
  const outside = path.join(s.runtimeDir, 'outside.bin');
  fs.writeFileSync(outside, FILES[0].data);   // right size and hash, but behind a link
  fs.symlinkSync(outside, path.join(s.dir, 'alpha.bin'));
  const f = serve();
  const r = await run(s, f.fetch);
  assert.strictEqual(r.downloaded, 1);
  assert.strictEqual(f.calls.length, 1);
  assert.ok(fs.lstatSync(path.join(s.dir, 'alpha.bin')).isFile(), 'now a regular file');
  assert.deepStrictEqual(fs.readFileSync(path.join(s.dir, 'alpha.bin')), FILES[0].data);
  assert.deepStrictEqual(fs.readFileSync(outside), FILES[0].data, 'the link target is untouched');
});

test('a bad manifest is refused before any fetch', async () => {
  const file = (over) => ({ ...FILES[0], ...over });
  const withFiles = (files, rel = {}) => ({ schemaVersion: 1, releases: [{ repository: 'example-org/example-agents', tag: 'v1', ...rel, files }] });
  const ok = { filename: 'alpha.bin', asset: 'alpha.bin', size: 5, sha384: 'a'.repeat(96) };
  const cases = [
    ['filename ../x', withFiles([{ ...ok, filename: '../x' }])],
    ['filename a/b', withFiles([{ ...ok, filename: 'a/b' }])],
    ['filename ..', withFiles([{ ...ok, filename: '..' }])],
    ['asset a/b', withFiles([{ ...ok, asset: 'a/b' }])],
    ['bad repository', withFiles([ok], { repository: 'no-slash' })],
    ['repository with extra part', withFiles([ok], { repository: 'a/b/c' })],
    ['bad tag', withFiles([ok], { tag: 'v1/../x' })],
    ['duplicate filename', withFiles([ok, { ...ok, asset: 'other.bin' }])],
    ['non-hex sha384', withFiles([{ ...ok, sha384: 'g'.repeat(96) }])],
    ['upper-case sha384', withFiles([{ ...ok, sha384: 'A'.repeat(96) }])],
    ['size zero', withFiles([{ ...ok, size: 0 }])],
    ['size too big', withFiles([{ ...ok, size: 100 * 1024 * 1024 + 1 }])],
    ['size not an integer', withFiles([{ ...ok, size: 1.5 }])],
    ['schemaVersion 2', { ...withFiles([ok]), schemaVersion: 2 }],
    ['no releases', { schemaVersion: 1, releases: [] }],
    ['33 releases', { schemaVersion: 1, releases: Array.from({ length: 33 }, (_, i) => ({ repository: 'a/b', tag: `v${i}`, files: [{ ...ok, filename: `f${i}.bin` }] })) }],
  ];
  void file;
  for (const [label, m] of cases) {
    const s = setup(m);
    const f = serve();
    await assert.rejects(() => run(s, f.fetch), /agent manifest/, label);
    assert.strictEqual(f.calls.length, 0, `${label}: nothing fetched`);
    assert.deepStrictEqual(leftovers(s.dir), [], label);
  }
});

test('a missing, oversized or unreadable manifest is refused', async () => {
  const f = serve();
  const none = setup();
  fs.rmSync(path.join(none.dir, 'agent-defaults.json'));
  await assert.rejects(() => run(none, f.fetch), /manifest.*missing/);
  const big = setup();
  fs.writeFileSync(path.join(big.dir, 'agent-defaults.json'), ' '.repeat(1024 * 1024 + 1));
  await assert.rejects(() => run(big, f.fetch), /too big/);
  const junk = setup();
  fs.writeFileSync(path.join(junk.dir, 'agent-defaults.json'), '{nope');
  await assert.rejects(() => run(junk, f.fetch), /could not be read/);
  assert.strictEqual(f.calls.length, 0);
});

test('at most `concurrency` downloads run at once', async () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ filename: `f${i}.bin`, asset: `a${i}.bin`, data: body(`file number ${i}`) }));
  for (const conc of [1, 2, 3]) {
    const s = setup(manifestFor(many));
    let active = 0, peak = 0;
    const fetch = async (url) => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      const f = many.find((x) => x.asset === decodeURIComponent(url.split('/').pop()));
      return new Response(f.data);
    };
    const r = await ensureAgentFiles({ runtimeDir: s.runtimeDir, fetch, concurrency: conc });
    assert.strictEqual(r.downloaded, 9);
    assert.strictEqual(peak, conc, `peak with concurrency ${conc}`);
  }
  const s = setup(manifestFor(many));
  const f = serve();
  void f;
  let active = 0, peak = 0;
  await ensureAgentFiles({ runtimeDir: s.runtimeDir, fetch: async (url) => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
    return new Response(many.find((x) => x.asset === decodeURIComponent(url.split('/').pop())).data);
  } });
  assert.strictEqual(peak, 3, 'the default is 3');
});
