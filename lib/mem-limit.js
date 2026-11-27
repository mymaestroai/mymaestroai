'use strict';
// lib/mem-limit.js: the memory limit for background jobs and agents' own commands, so one runaway process
// cannot use up the computer's memory and get your Maestro itself killed.
//
//   settings.jobMemoryLimitGb: a number of GB; 0 = no limit; absent/blank = automatic.
//   Automatic = a quarter of this computer's memory, at least 4 GB and at most 64 GB: a quarter leaves room for the
//   hub, the person's own programs and a second big job; 4 GB keeps small computers usable for a browser proof or a
//   build; 64 GB is far above what any normal job needs and keeps a runaway on a large server from starving the rest.
//
//   limitBytes() -> bytes, or null (no limit)
//   scopeProps(bytes) -> systemd-run arguments for a transient scope: MemoryMax (hard: the kernel kills inside the
//     scope) and MemorySwapMax=0 (no swapping around the limit). No limit -> no arguments.
//   gbText(bytes) -> "48 GB" style text for notices.
const os = require('os');

const GB = 1024 * 1024 * 1024;
const MIN_AUTO = 4 * GB;
const MAX_AUTO = 64 * GB;

function autoBytes(total = os.totalmem()) {
  const quarter = Math.floor(Number(total) / 4);
  return Math.min(MAX_AUTO, Math.max(MIN_AUTO, quarter));
}

// The settings reader. The default reads nothing (= automatic), so a test or a tool that loads this module never touches
// data/settings.json; the running hub installs the real reader once at start (setSettingsReader, lib/sdk-chat.js).
let reader = () => null;
function setSettingsReader(fn) { reader = typeof fn === 'function' ? fn : () => null; }

function settingValue(getSetting) {
  try { return (getSetting || reader)('jobMemoryLimitGb', null); } catch { return null; }
}

/** Bytes for the configured limit; null = no limit.
 *  Only a finite number or a non-blank numeric string counts; 0 / "0" = no limit; anything else (blank, false, [], NaN,
 *  negative) = automatic. The maximum is the computer's total memory. */
function limitBytes({ getSetting, total } = {}) {
  const v = settingValue(getSetting);
  let n = null;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && v.trim() !== '') n = Number(v.trim());
  if (n === null || !Number.isFinite(n) || n < 0) return autoBytes(total);
  if (n === 0) return null;
  const mem = Number(total !== undefined ? total : os.totalmem());
  const cap = Number.isFinite(mem) && mem > 0 ? mem : Infinity;
  const bytes = Math.min(Math.max(Math.floor(n * GB), 256 * 1024 * 1024), cap);   // never below 256 MB (a typo can't make every job fail at start), never above the computer's memory
  return bytes;
}

// OOMScoreAdjust is a process (exec) setting: systemd-run --scope refuses it ("Unknown assignment"), so it is not set here.
// No MemoryHigh: past MemoryHigh the kernel throttles the processes instead of killing them, and a runaway can sit there
// stalled for as long as it likes (seen in the proof: a 1.5 GB allocation under a 512 MB limit never ended). A hard
// MemoryMax with no swap ends it at once.
function scopeProps(bytes) {
  if (!bytes) return [];
  const b = Math.floor(bytes);
  return ['-p', `MemoryMax=${b}`, '-p', 'MemorySwapMax=0'];
}

function gbText(bytes) {
  if (!bytes) return 'no limit';
  const g = bytes / GB;
  return g >= 10 ? `${Math.round(g)} GB` : `${Math.round(g * 10) / 10} GB`;
}

module.exports = { setSettingsReader, GB, MIN_AUTO, MAX_AUTO, autoBytes, limitBytes, scopeProps, gbText };
