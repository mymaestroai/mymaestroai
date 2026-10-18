'use strict';
// Local models (lib/local-models): the registry, the llama-swap config it writes for each engine kind, folder
// scanning, the detached proxy process (a fake llama-swap here), what the hub asks it (context window, readiness),
// and the wiring pins: provider `local/` in settings, discovery, gateway client, billing, pickers, page and routes.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { createLocalModels, validateModel, LLAMA_SWAP_VERSION } = require('../lib/local-models');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'local-models-'));
function fresh(extra = {}) { const dataDir = fs.mkdtempSync(path.join(TMP, 'd-')); return { dataDir, lm: createLocalModels({ dataDir, log: () => {}, home: path.join(TMP, 'nohome'), ...extra }) }; }
const touch = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, '#!/bin/sh\n'); fs.chmodSync(p, 0o755); return p; };
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

test('validateModel: ids, engines, required fields, aliases, numbers', () => {
  const m = validateModel({ id: 'Qwen3.8-27B', engine: 'ninfer', path: '/m/q.ninfer', ctx: '200000', ttl: '', aliases: 'qwen, fast', env: 'A=1\nB=2', ngl: '' });
  assert.strictEqual(m.id, 'Qwen3.8-27B'); assert.strictEqual(m.ctx, 200000); assert.strictEqual(m.ttl, null); assert.deepStrictEqual(m.aliases, ['qwen', 'fast']); assert.deepStrictEqual(m.env, ['A=1', 'B=2']); assert.strictEqual(m.ngl, 99);
  assert.throws(() => validateModel({ id: 'bad id', engine: 'llama.cpp', path: '/x' }), /id:/);
  assert.throws(() => validateModel({ id: 'x', engine: 'vllm', path: '/x' }), /engine/);
  assert.throws(() => validateModel({ id: 'x', engine: 'llama.cpp' }), /path/);
  assert.throws(() => validateModel({ id: 'x', engine: 'command', cmd: 'serve --port 8000' }), /\$\{PORT\}/);
  assert.throws(() => validateModel({ id: 'x', engine: 'llama.cpp', path: '/x', aliases: 'ok,bad name' }), /alias/);
  assert.strictEqual(validateModel({ id: 'x', engine: 'command', cmd: 'serve --port ${PORT}' }).ttl, null);
});

test('registry: upsert, alias conflicts, remove, settings validation, persistence', () => {
  const { dataDir, lm } = fresh();
  lm.models.upsert({ id: 'a', engine: 'llama.cpp', path: '/m/a.gguf', aliases: 'alpha' });
  assert.throws(() => lm.models.upsert({ id: 'b', engine: 'llama.cpp', path: '/m/b.gguf', aliases: 'alpha' }), /already used/);
  assert.throws(() => lm.models.upsert({ id: 'alpha', engine: 'llama.cpp', path: '/m/b.gguf' }), /already used/);
  lm.models.upsert({ id: 'a', engine: 'llama.cpp', path: '/m/a2.gguf' });
  assert.strictEqual(lm.models.list().length, 1); assert.strictEqual(lm.models.get('a').path, '/m/a2.gguf');
  assert.throws(() => lm.update({ port: 80 }), /port/); assert.throws(() => lm.update({ globalTTL: -1 }), /globalTTL/);
  lm.update({ port: 19000, modelsDirs: '/one\n/two\n', enabled: true, llamaServer: '/opt/llama-server' });
  const again = createLocalModels({ dataDir, log: () => {} });
  assert.strictEqual(again.state().port, 19000); assert.deepStrictEqual(again.state().modelsDirs, ['/one', '/two']); assert.strictEqual(again.state().enabled, true);
  assert.strictEqual(again.baseUrl(), 'http://127.0.0.1:19000/v1');
  again.models.remove('a'); assert.strictEqual(again.models.list().length, 0); assert.throws(() => again.models.remove('a'), /no such/);
});

test('config: one entry per engine kind, ttl, aliases, NInfer name and health settings, env, disabled skipped, missing engine reported', () => {
  const { dataDir, lm } = fresh();
  const llama = touch(path.join(dataDir, 'bin', 'llama-server')); const ninfer = touch(path.join(dataDir, 'bin', 'ninfer-serve'));
  lm.update({ llamaServer: llama, ninferServe: ninfer, globalTTL: 600, startPort: 20000 });
  lm.models.upsert({ id: 'qwen', engine: 'ninfer', path: '/m/q.ninfer', ctx: 200000, ttl: 0, extraArgs: '--max-context 200000 --kv-capacity auto', notes: 'fast one' });
  lm.models.upsert({ id: 'glimmer', engine: 'llama.cpp', path: '/m/g 1.gguf', mmproj: '/m/mm.gguf', draft: '/m/d.gguf', draftArgs: '--spec-type draft-dflash', ctx: 16384, ttl: 300, aliases: ['muse'], env: ['CUDA_VISIBLE_DEVICES=0'] });
  lm.models.upsert({ id: 'custom', engine: 'command', cmd: 'my-server --port ${PORT} --model x' });
  lm.models.upsert({ id: 'off', engine: 'llama.cpp', path: '/m/off.gguf', enabled: false });
  const { yaml, problems } = lm.renderConfig();
  assert.deepStrictEqual(problems, []);
  assert.ok(yaml.includes('healthCheckTimeout: 900') && yaml.includes('startPort: 20000') && yaml.includes('globalTTL: 600'));
  assert.ok(yaml.includes(`"qwen":\n    cmd: "${ninfer} /m/q.ninfer --host 127.0.0.1 --port \${PORT} --model-id qwen --max-context 200000 --kv-capacity auto"`), yaml);
  assert.ok(yaml.includes('    ttl: 0\n') && yaml.includes('    useModelName: "qwen"\n    checkEndpoint: /health') && yaml.includes('description: "fast one"'));
  assert.ok(yaml.includes(`-m '/m/g 1.gguf' -ngl 99 --jinja -fa on -c 16384 --mmproj /m/mm.gguf -md /m/d.gguf --spec-type draft-dflash"`), 'llama.cpp command with quoting, projector and draft');
  assert.ok(yaml.includes('    ttl: 300') && yaml.includes('aliases: ["muse"]') && yaml.includes('env: ["CUDA_VISIBLE_DEVICES=0"]'));
  assert.ok(yaml.includes('cmd: "my-server --port ${PORT} --model x"'));
  assert.ok(!yaml.includes('"off":'), 'disabled model left out');
  lm.update({ llamaServer: '/nowhere/llama-server' });
  const r2 = lm.renderConfig();
  assert.ok(r2.problems.some(p => /glimmer: llama-server not found/.test(p)), r2.problems.join(';'));
  assert.ok(r2.yaml.includes('"qwen":') && !r2.yaml.includes('"glimmer":'), 'the model with a missing engine is left out, the rest stay');
  const w = lm.writeConfig(); assert.ok(fs.existsSync(w.file));
});

test('scan: gguf, projector, draft, ninfer, shards', () => {
  const { lm } = fresh();
  const d = fs.mkdtempSync(path.join(TMP, 'models-'));
  for (const f of ['a/model.gguf', 'a/mmproj-model.gguf', 'a/dflash-model.gguf', 'b/big-00001-of-00003.gguf', 'b/big-00002-of-00003.gguf', 'c/q.ninfer', 'c/readme.txt']) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), 'x'); }
  const found = lm.scan([d]);
  const kinds = Object.fromEntries(found.map(f => [f.name, f.kind]));
  assert.deepStrictEqual(kinds, { 'model.gguf': 'gguf', 'mmproj-model.gguf': 'mmproj', 'dflash-model.gguf': 'draft', 'big-00001-of-00003.gguf': 'gguf', 'q.ninfer': 'ninfer' });
  assert.strictEqual(found.find(f => f.name === 'q.ninfer').suggestedId, 'q');
  assert.ok(found.every(f => f.sizeText), 'sizes');
});

test('proxy process: start a fake llama-swap detached, see it healthy, read running, stop it', async () => {
  const { dataDir, lm } = fresh();
  const port = await freePort();
  lm.update({ port });
  const fake = path.join(dataDir, 'local-models', 'bin', 'llama-swap');
  fs.mkdirSync(path.dirname(fake), { recursive: true });
  fs.writeFileSync(fake, `#!${process.execPath}\n` + `const http=require('http');const i=process.argv.indexOf('-listen');const [h,p]=process.argv[i+1].split(':');
http.createServer((q,r)=>{if(q.url==='/health'){r.end('OK');return}if(q.url==='/running'){r.setHeader('content-type','application/json');r.end(JSON.stringify({running:[{model:'qwen',state:'ready'}]}));return}if(q.url==='/v1/models'){r.setHeader('content-type','application/json');r.end(JSON.stringify({data:[{id:'qwen'}]}));return}if(q.url==='/logs'){r.end('log line 1\\nlog line 2');return}if(q.url.startsWith('/api/models/unload')){r.end('OK');return}r.statusCode=404;r.end()}).listen(parseInt(p,10),h);
setInterval(()=>{},1000);`);
  fs.chmodSync(fake, 0o755);
  lm.models.upsert({ id: 'qwen', engine: 'command', cmd: 'x --port ${PORT}' });
  const r = await lm.start();
  assert.strictEqual(r.ok, true, JSON.stringify(r)); assert.ok(r.pid > 1);
  assert.strictEqual(lm.pid(), r.pid);
  const st = await lm.status();
  assert.strictEqual(st.running, true); assert.deepStrictEqual(st.loaded, [{ model: 'qwen', state: 'ready' }]); assert.deepStrictEqual(st.listed, ['qwen']);
  assert.ok((await lm.logs(5)).includes('log line 2'));
  assert.strictEqual((await lm.unload('qwen')).status, 200);
  assert.strictEqual((await lm.start()).note, 'already running');
  const a = await lm.apply(); assert.strictEqual(a.running, true);
  await lm.stop();
  assert.strictEqual(lm.pid(), null); assert.strictEqual(await lm.healthy(), false);
  assert.strictEqual((await lm.stop()).note, 'not running');
});

test('what the hub asks: context window, max output, readiness items, build command, pinned version', () => {
  const { lm } = fresh({ platform: 'linux' });
  lm.models.upsert({ id: 'qwen', engine: 'ninfer', path: '/m/q.ninfer', ctx: 200000, maxOutput: 32000, aliases: ['fast'] });
  assert.strictEqual(lm.contextFor('local/qwen'), 200000); assert.strictEqual(lm.contextFor('local/fast'), 200000); assert.strictEqual(lm.contextFor('local/none'), null);
  assert.strictEqual(lm.maxOutputFor('local/qwen'), 32000);
  assert.deepStrictEqual(lm.readinessItems(), [], 'off: silent');
  lm.update({ enabled: true, ninferServe: '/nowhere/ninfer-serve' });
  const ids = lm.readinessItems().map(i => i.id);
  assert.ok(ids.includes('local-models-proxy') && ids.includes('local-models-ninfer'), ids.join(','));
  assert.ok(lm.readinessItems().every(i => i.action && i.action.href === '/local-models'));
  const cmd = lm.llamaCppBuildCommand();
  assert.ok(cmd.includes('git clone --depth 1 https://github.com/ggml-org/llama.cpp') && cmd.includes('cmake --build') && cmd.includes('--target llama-server'), cmd);
  const mac = createLocalModels({ dataDir: fs.mkdtempSync(path.join(TMP, 'mac-')), platform: 'darwin', log: () => {} });
  assert.ok(mac.llamaCppBuildCommand().includes('brew install llama.cpp'));
  assert.match(LLAMA_SWAP_VERSION, /^\d+$/);
});

test('wiring: provider local/ in settings, discovery, gateway, billing, context, pickers; page, routes, menu, readiness, docs', () => {
  const s = read('lib/settings.js'); assert.ok(s.includes("local:     { url: 'http://127.0.0.1:18080/v1' }") && s.includes("if (provider === 'local')"));
  const d = read('lib/model-discovery.js'); assert.ok(d.includes("discoverOpenAICompat('local', config.localUrl, { apiKey: 'local' })") && d.includes('models.push(`local/${m}`)'));
  const g = read('lib/gateway-client.js'); assert.ok(g.includes("'ninfer', 'local'") && g.includes("if (provider === 'local') return 'local';"));
  assert.ok(read('lib/ledger.js').includes('ninfer|local)') && read('lib/compaction.js').includes('ninfer|local)'));
  const cb = read('lib/context-budget.js'); assert.ok(cb.includes("source: 'local-models'") && cb.includes('ninfer|local)'));
  assert.ok(read('lib/billing.js').includes("'ninfer', 'local'") && read('lib/model-quirks.js').includes('/^local\\//i'));
  for (const f of ['app.js', 'mobile.js', 'agent-settings.html']) assert.ok(read(f).includes("local: 'Local'") && read(f).includes("'ninfer', 'local'"), f);
  assert.ok(read('lib/temporal-workers.js').includes('local: 2') && read('lib/worker-policy.js').includes("startsWith('local/')"));
  const server = read('server.js');
  for (const p of ["pathname === '/api/local-models' && req.method === 'GET'", "'/api/local-models/install/llama-cpp'", "'/api/local-models/discover'", "filePath = path.join(__dirname, 'local-models.html')", "lm.state().enabled) lm.start()"]) assert.ok(server.includes(p), p);
  assert.ok(read('lib/access.js').includes("'/local-models'"), 'admin page');
  assert.ok(read('index.html').includes('id="account-local-models"') && read('app.js').includes("'account-local-models'") && read('app.js').includes('id="st-local-models-section"'));
  assert.ok(read('lib/readiness.js').includes('localModelItems'));
  const page = read('local-models.html'); for (const id of ['btn-install-swap', 'btn-build-llama', 'btn-scan', 'model-form', 'btn-save-settings', 'log-pre', 'f-engine']) assert.ok(page.includes(`id="${id}"`), id);
  assert.ok(read('docs/HUB-MAP.md').includes('**Local models**') && read('README.md').includes('## Local Models'));
});

test('gateway loop: a call that returns nothing is retried twice for a local engine and is an error otherwise, never a blank reply', () => {
  const sdk = read('lib/sdk-chat.js');
  const i = sdk.indexOf('EMPTY STREAM: the call returned nothing at all');
  assert.ok(i > 0, 'guard present');
  const block = sdk.slice(i, i + 1800);
  assert.ok(block.includes("!assistantText && toolCallMap.size === 0 && !lastFinishReason && !callUsage && !streamInterrupted"), 'only when nothing at all arrived');
  assert.ok(block.includes("['local', 'lmstudio', 'ollama', 'omlx', 'ninfer'].includes(prov)") && block.includes('emptyStreams <= 2') && block.includes('continue;'), 'two retries for local providers');
  assert.ok(block.includes("emptyStreams === 1 ? 2500 : 6000"), '2.5 s then 6 s');
  assert.ok(block.includes('throw new Error(`The model returned nothing'), 'error instead of a blank reply');
  assert.ok(sdk.indexOf('let emptyStreams = 0;') < i, 'counter declared before the loop');
});
