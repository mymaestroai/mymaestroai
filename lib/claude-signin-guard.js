'use strict';
// No test may ever reach the real machine. Under `node --test` (which sets NODE_TEST_CONTEXT in every test process, and the
// children they spawn inherit it) every DEFAULT real effect of the Claude sign-in code (the installer, the client's sign-in and
// status, the group supervisor, the check turn) refuses to run. A program that is a file inside os.tmpdir() or inside this
// repository's test/fixtures folder (the stand-in client the tests copy there) may still run. `bash` (the installer) never.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REFUSED = 'claude-signin: refused to run a real program under node --test';
const FIXTURES = path.join(__dirname, '..', 'test', 'fixtures');

function underTest() { return !!process.env.NODE_TEST_CONTEXT; }

function inside(file, dir) {
  let d;
  try { d = fs.realpathSync(dir); } catch { return false; }
  return file === d || file.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
}

/** True when `bin` is a real file inside os.tmpdir() or this repository's test/fixtures, and not `bash`. */
function allowedProgram(bin) {
  try {
    if (typeof bin !== 'string' || !bin) return false;
    if (path.basename(bin) === 'bash') return false;
    if (!bin.includes('/') && !bin.includes(path.sep)) return false;   // a bare name is looked up on PATH: the real machine
    let real;
    try { real = fs.realpathSync(bin); }
    catch { real = path.join(fs.realpathSync(path.dirname(bin)), path.basename(bin)); }   // a file that is not there runs nothing
    if (path.basename(real) === 'bash') return false;
    return inside(real, os.tmpdir()) || inside(real, FIXTURES);
  } catch { return false; }
}

/** Throws under node --test unless `bin` is an allowed stand-in. With no argument (the check turn): always throws under test. */
function guardProgram(bin) {
  if (!underTest()) return;
  if (arguments.length && allowedProgram(bin)) return;
  throw new Error(REFUSED);
}

module.exports = { REFUSED, underTest, allowedProgram, guardProgram };
