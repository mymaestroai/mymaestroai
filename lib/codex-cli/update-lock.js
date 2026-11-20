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

/** -> Promise<boolean>: true as soon as no update is running; false when maxMs passes first or `signal` aborts (a
 *  stopped turn stops waiting). */
function waitIdle(maxMs = 15 * 60 * 1000, signal = null) {
  if (!activeFlag) return Promise.resolve(true);
  if (signal && signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let timer = null;
    let settled = false;
    const done = (v) => {
      if (settled) return; settled = true;
      if (timer) clearTimeout(timer);
      listeners = listeners.filter(l => l !== fn);
      if (signal) { try { signal.removeEventListener('abort', onAbort); } catch { /* none */ } }
      resolve(v);
    };
    const fn = (v) => done(v);
    const onAbort = () => done(false);
    timer = setTimeout(() => done(false), Math.max(0, Number(maxMs) || 0));
    listeners.push(fn);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

module.exports = { begin, end, active, waitIdle };
