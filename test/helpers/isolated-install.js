'use strict';
// A throwaway install for tests that load lib/ modules which keep data under <install>/data (agents.json, auth.db, memory.db,
// settings.json ...). The whole lib/ tree is COPIED (never symlinked: Node resolves a symlinked module to its real path, and that
// module would then compute data/ from the real install folder and open its databases, even in the live install). node_modules
// is linked, so packages load as usual. Nothing outside the returned folders is written.
//
// makeIsolatedInstall(prefix, { copy }) -> { root, inst, home, data, lib } with process.env.HUB_HOME and HUB_AUTH_DIR pointing
// into it. Call it before requiring any lib/ module. `copy` names more install paths to copy in (files or folders, relative
// to the install, e.g. ['server.js', 'scripts']) for tests that run them; data/agents.example.json (tracked in git) always
// comes along.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REAL = path.join(__dirname, '..', '..');

function makeIsolatedInstall(prefix = 'isolated-install-', { copy = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const inst = path.join(root, 'inst');
  const home = path.join(root, 'home');
  const data = path.join(inst, 'data');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.cpSync(path.join(REAL, 'lib'), path.join(inst, 'lib'), { recursive: true, dereference: true });
  fs.symlinkSync(path.join(REAL, 'node_modules'), path.join(inst, 'node_modules'));
  // Files at the top of the install that lib/ modules read (never write): copied so their paths stay inside the throwaway install.
  for (const f of ['package.json']) { try { fs.copyFileSync(path.join(REAL, f), path.join(inst, f)); } catch { /* not there */ } }
  // The example agents list is shipped in git (not install data); lib/ falls back to it when data/agents.json is missing.
  try { fs.copyFileSync(path.join(REAL, 'data', 'agents.example.json'), path.join(data, 'agents.example.json')); } catch { /* not there */ }
  for (const raw of copy) {
    const rel = path.posix.normalize(String(raw).split(path.sep).join('/'));
    if (path.isAbsolute(rel) || rel === '.' || /^data(\/|$)/.test(rel) || rel.split('/').includes('..')) throw new Error(`isolated-install: ${raw} is not a path to copy`);
    const to = path.join(inst, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(path.join(REAL, rel), to, { recursive: true, dereference: true });
  }
  process.env.HUB_HOME = home;
  process.env.HUB_AUTH_DIR = data;
  // Any other path override a parent shell may export (they win over the copy's own data/ paths) is cleared, so the copy keeps
  // everything under its own data/. Every process.env.HUB_*_FILE|DIR|DB that lib/ reads.
  for (const k of Object.keys(process.env)) if (/^HUB_[A-Z_]+_(FILE|DIR|DB)$/.test(k) && k !== 'HUB_AUTH_DIR') delete process.env[k];
  // The throwaway install goes when the test process ends (rmSync removes the node_modules link itself, never what it points to).
  process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });
  return { root, inst, home, data, lib: path.join(inst, 'lib') };
}

module.exports = { makeIsolatedInstall, REAL };
