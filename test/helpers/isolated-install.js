'use strict';
// A throwaway install for tests that load lib/ modules which keep data under <install>/data (agents.json, auth.db, memory.db,
// settings.json ...). The whole lib/ tree is COPIED (never symlinked: Node resolves a symlinked module to its real path, and that
// module would then compute data/ from the real install folder and open its databases, even in the live install). node_modules
// is linked, so packages load as usual. Nothing outside the returned folders is written.
//
// makeIsolatedInstall(prefix) -> { root, inst, home, data, lib } with process.env.HUB_HOME and HUB_AUTH_DIR pointing into it.
// Call it before requiring any lib/ module.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REAL = path.join(__dirname, '..', '..');

function makeIsolatedInstall(prefix = 'isolated-install-') {
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
  process.env.HUB_HOME = home;
  process.env.HUB_AUTH_DIR = data;
  return { root, inst, home, data, lib: path.join(inst, 'lib') };
}

module.exports = { makeIsolatedInstall, REAL };
