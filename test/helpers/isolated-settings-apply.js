'use strict';
// Runs a lib/settings-apply function in a CHILD process against a throwaway install (test/helpers/isolated-install.js), so the call
// reads that copy's data/settings.json and never the real install's. The parent's process.env is left as it was found.
// callSettingsApply('cleanSettingsPatch', [patch, ctx]) -> the function's result, as JSON (a Set or function in it does not survive).
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { makeIsolatedInstall } = require('./isolated-install');

let made = null;
function install() {
  if (made) return made;
  const before = { ...process.env };
  try { made = makeIsolatedInstall('sa-call-'); }
  finally {
    for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
    for (const k of Object.keys(before)) process.env[k] = before[k];
  }
  return made;
}

function callSettingsApply(fn, args) {
  const inst = install();
  const env = { ...process.env, HUB_HOME: inst.home, HUB_AUTH_DIR: inst.data };
  for (const k of Object.keys(env)) if (/^HUB_[A-Z_]+_(FILE|DIR|DB)$/.test(k) && k !== 'HUB_AUTH_DIR') delete env[k];
  const code = 'const sa = require(process.argv[1]); const w = console.warn; console.warn = () => {};'
    + 'const r = sa[process.argv[2]](...JSON.parse(process.argv[3])); console.warn = w; process.stdout.write("\\n@@RESULT@@" + JSON.stringify(r === undefined ? null : r));';
  const out = execFileSync(process.execPath, ['-e', code, path.join(inst.lib, 'settings-apply.js'), fn, JSON.stringify(args)], { env, cwd: inst.inst, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out.slice(out.lastIndexOf('@@RESULT@@') + '@@RESULT@@'.length));   // the module may log to stdout first
}

module.exports = { callSettingsApply };
