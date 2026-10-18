'use strict';
// scripts/relaunch.js end to end with real processes: a stub "server.js" listening on a free port stands in for the
// old hub; relaunch waits for it to exit (we stop it), waits for the port, starts the stub again detached, and
// reports the new pid from /api/health. The log it writes is what the page shows when a restart goes wrong.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path'); const net = require('net'); const http = require('http');
const { spawn, execFileSync } = require('child_process');

const STUB = `const http=require('http');const port=Number(process.env.PORT);const boot=Date.now()+'-'+process.pid;
http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',bootId:boot,pid:process.pid,argv:process.argv.slice(2)}))}).listen(port,'127.0.0.1');
process.on('SIGTERM',()=>process.exit(0));`;
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const get = (port) => new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 2000 }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on('error', reject); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('relaunch.js replaces a running server and proves it through /api/health', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relaunch-'));
  fs.writeFileSync(path.join(dir, 'server.js'), STUB);
  const port = await freePort();
  const env = { ...process.env, PORT: String(port) };
  const old = spawn(process.execPath, ['server.js', '--old'], { cwd: dir, env, stdio: 'ignore' });
  let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(250); h = await get(port).catch(() => null); }
  assert.ok(h && h.pid === old.pid, 'the old stub is up');
  const log = path.join(dir, 'restart.log'); const fd = fs.openSync(log, 'a');
  const relaunch = path.join(__dirname, '..', 'scripts', 'relaunch.js');
  const child = spawn(process.execPath, [relaunch, '--dir', dir, '--pid', String(old.pid), '--port', String(port), '--argv', JSON.stringify(['server.js', '--new']), '--grace', '2'], { cwd: dir, env, detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  // the hub would exit itself after 1.5 s; here the stub keeps running, so relaunch stops it after the 2 s grace
  let done = false; for (let i = 0; i < 120 && !done; i++) { await sleep(500); done = !isAlive(child.pid); }
  assert.ok(done, 'relaunch finished');
  const text = fs.readFileSync(log, 'utf8');
  assert.match(text, /old process \d+ still running after 2 s; sending SIGTERM/);
  assert.match(text, /old process \d+ has exited/);
  assert.match(text, /started pid \d+/);
  assert.match(text, /✅ hub is up: pid \d+/);
  const h2 = await get(port);
  assert.notStrictEqual(h2.pid, old.pid, 'a new process answers');
  assert.deepStrictEqual(h2.argv, ['--new'], 'started with the arguments given');
  assert.strictEqual(fs.readFileSync(path.join(dir, '.server.pid'), 'utf8'), String(h2.pid));
  assert.ok(fs.existsSync(path.join(dir, 'server.log')), 'the new server\'s output goes to server.log');
  try { process.kill(h2.pid, 'SIGTERM'); } catch {}
  try { process.kill(old.pid, 'SIGKILL'); } catch {}
});

test('relaunch.js reports a server that never comes up', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relaunch2-'));
  fs.writeFileSync(path.join(dir, 'server.js'), 'process.exit(3)');
  const port = await freePort();
  const log = path.join(dir, 'restart.log'); const fd = fs.openSync(log, 'a');
  const r = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'relaunch.js'), '--dir', dir, '--pid', '0', '--port', String(port), '--argv', '["server.js"]'], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', fd, fd] });
  const code = await new Promise(res => r.on('exit', res));
  assert.strictEqual(code, 1);
  assert.match(fs.readFileSync(log, 'utf8'), /❌ the new server did not answer \/api\/health \(it exited\)/);
});

function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
void execFileSync;
