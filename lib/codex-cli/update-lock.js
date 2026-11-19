'use strict';
/**
 * One flag, shared by every caller in the process: set while the Codex client is being replaced (lib/codex-cli/update).
 * Codex turns and model discovery wait for it, so nothing starts a half-installed CLI.
 */
let activeFlag = false;
let listeners = [];

function begin() {
  if (activeFlag) return false;
  activeFlag = true;
  return true;
}

function end() {
  activeFlag = false;
  const ls = listeners;
  listeners = [];
  for (const fn of ls) { try { fn(true); } catch { /* a listener never breaks the others */ } }
}

function active() { return activeFlag; }

/** -> Promise<boolean>: true as soon as no update is running, false when maxMs passes first. */
function waitIdle(maxMs = 15 * 60 * 1000) {
  if (!activeFlag) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer = null;
    const fn = (v) => { if (timer) clearTimeout(timer); resolve(v); };
    timer = setTimeout(() => { listeners = listeners.filter(l => l !== fn); resolve(false); }, Math.max(0, Number(maxMs) || 0));
    listeners.push(fn);
  });
}

module.exports = { begin, end, active, waitIdle };
