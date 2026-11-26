'use strict';
const fs = require('node:fs');
const path = require('node:path');

const REFUSED = 'claude-signin: refused to run a real program without the explicit opt-in (allowRealEffects)';
const FIXTURE = path.join(__dirname, '..', 'test', 'fixtures', 'fake-claude-client.js');

// Sample the launch mode once. A later environment cleanup cannot undo it.
const sealedAtLaunch = Boolean(process.env.NODE_TEST_CONTEXT) ||
  process.env.MM_TEST_NO_REAL_CLAUDE === '1' ||
  fs.existsSync(path.join(__dirname, '..', '.mm-test-install'));
let realEffects = false;
function underTest() { return sealedAtLaunch; }
function allowRealEffects() { realEffects = !sealedAtLaunch; }
function realAllowed() { return realEffects; }

function sameBytes(a, b) {
  try {
    const x = fs.readFileSync(a), y = fs.readFileSync(b);
    return x.length === y.length && x.equals(y);
  } catch { return false; }
}

function allowedProgram(bin) {
  if (typeof bin !== 'string' || !path.isAbsolute(bin)) return false;
  try {
    const real = fs.realpathSync(bin);
    const stat = fs.statSync(real);
    const fixture = fs.statSync(FIXTURE);
    return stat.isFile() && fixture.isFile() && stat.size === fixture.size &&
      sameBytes(real, FIXTURE);
  } catch { return false; }
}

function guardInstaller(spawn) {
  if (realAllowed()) return;
  if (typeof spawn === 'function' && Object.hasOwn(spawn, '__fakeSpawn') &&
      spawn.__fakeSpawn === true && spawn !== require('node:child_process').spawn) return;
  throw new Error(REFUSED);
}

/** Throws unless the opt-in was given or `bin` passes the boundary rule. With no argument (the check turn): throws without the opt-in. */
function guardProgram(bin) {
  if (realEffects) return;
  if (arguments.length && allowedProgram(bin)) return;
  throw new Error(REFUSED);
}

/** The same rule with the opt-in given by someone else (the supervisor receives it in its start message). */
function guardProgramWith(allowReal, bin) {
  if (!sealedAtLaunch && allowReal === true) return;
  if (allowedProgram(bin)) return;
  throw new Error(REFUSED);
}

module.exports = { guardInstaller, REFUSED, FIXTURE, allowRealEffects, realAllowed, underTest, allowedProgram, guardProgram, guardProgramWith };
