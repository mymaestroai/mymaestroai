'use strict';
// The guard fails closed. Real effects of the Claude sign-in code (the installer, the client's sign-in and status, the group
// supervisor's worker, the check turn) need an explicit in-process opt-in: allowRealEffects(). Only server.js (the hub boot) and the
// `connect claude` command in scripts/hub-cli.js call it. Without it, at the real process boundary:
//   - `bash` (the installer) is always refused;
//   - a bare program name is refused when it resolves on PATH (it would run the real program); a name that is not there is allowed
//     (only a fake spawn can "run" it);
//   - a program path that does not exist is allowed (only a fake spawn can "run" it);
//   - a program path that exists is allowed only when its real file is byte-identical to test/fixtures/fake-claude-client.js;
//   - the default check turn (no program given) is refused.
// The decision never depends on NODE_TEST_CONTEXT.
const fs = require('node:fs');
const path = require('node:path');

const REFUSED = 'claude-signin: refused to run a real program without the explicit opt-in (allowRealEffects)';
const FIXTURE = path.join(__dirname, '..', 'test', 'fixtures', 'fake-claude-client.js');

let realEffects = false;
function allowRealEffects() { realEffects = true; }
function realAllowed() { return realEffects; }

/** An extra signal only; no decision depends on it. */
function underTest() { return !!process.env.NODE_TEST_CONTEXT; }

function sameBytes(a, b) {
  try {
    const x = fs.readFileSync(a), y = fs.readFileSync(b);
    return x.length === y.length && x.equals(y);
  } catch { return false; }
}

function onPath(name) {
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    if (!d) continue;
    try {
      const p = path.join(d, name);
      if (fs.statSync(p).isFile()) { fs.accessSync(p, fs.constants.X_OK); return true; }
    } catch { /* not here */ }
  }
  return false;
}

/** The boundary rule for `bin` when the opt-in is not given. */
function allowedProgram(bin) {
  try {
    if (typeof bin !== 'string' || !bin) return false;
    if (path.basename(bin) === 'bash') return false;
    if (!bin.includes('/') && !bin.includes(path.sep)) return !onPath(bin);
    let real;
    try { real = fs.realpathSync(bin); }
    catch {
      try { fs.lstatSync(bin); return false; } catch { return true; }   // a dangling link is not "nothing"; a missing file runs nothing
    }
    if (path.basename(real) === 'bash') return false;
    return sameBytes(real, FIXTURE);
  } catch { return false; }
}

/** Throws unless the opt-in was given or `bin` passes the boundary rule. With no argument (the check turn): throws without the opt-in. */
function guardProgram(bin) {
  if (realEffects) return;
  if (arguments.length && allowedProgram(bin)) return;
  throw new Error(REFUSED);
}

/** The same rule with the opt-in given by someone else (the supervisor receives it in its start message). */
function guardProgramWith(allowReal, bin) {
  if (allowReal === true) return;
  if (allowedProgram(bin)) return;
  throw new Error(REFUSED);
}

module.exports = { REFUSED, FIXTURE, allowRealEffects, realAllowed, underTest, allowedProgram, guardProgram, guardProgramWith };
