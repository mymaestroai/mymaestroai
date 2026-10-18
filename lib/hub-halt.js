'use strict';
// Hub-wide kill switch state. One flag file (data/hub-halt.json) so a halt survives a restart:
// {halted, at, reason}. The file is re-read when its mtime changes, so deleting it by hand also resumes.
// Everything that starts work (chat routes, scheduler, job runner, delegation tools) asks isHalted().

const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = process.env.HUB_HALT_FILE || path.join(__dirname, '..', 'data', 'hub-halt.json');
const REASON_MAX = 300;

function createHubHalt({ file = DEFAULT_FILE, now = Date.now } = {}) {
  let cache = { halted: false, at: null, reason: null };
  let stamp = -1;   // mtimeMs of the file behind `cache` (0 = no file)

  function refresh() {
    let m = 0;
    try { m = fs.statSync(file).mtimeMs; } catch {}
    if (m === stamp) return;
    stamp = m;
    cache = { halted: false, at: null, reason: null };
    if (!m) return;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j && j.halted === true) cache = { halted: true, at: j.at || null, reason: j.reason || null };
    } catch {}
  }

  function write(data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
    stamp = -1;
  }

  function status() { refresh(); return { ...cache }; }
  function isHalted() { refresh(); return cache.halted; }

  /** Set the flag. Already halted: keeps the original time and reason. */
  function halt(reason) {
    refresh();
    if (cache.halted) return { ...cache, already: true };
    write({ halted: true, at: new Date(now()).toISOString(), reason: reason ? String(reason).slice(0, REASON_MAX) : null });
    refresh();
    return { ...cache, already: false };
  }

  function resume() {
    refresh();
    const was = cache.halted;
    try { fs.unlinkSync(file); } catch {}
    stamp = -1;
    refresh();
    return { halted: false, was };
  }

  /** Text for tool results and refusals; null when not halted. */
  function refusal() {
    refresh();
    if (!cache.halted) return null;
    return `hub is halted${cache.reason ? ` (${cache.reason})` : ''}: the owner stopped all agents; do not retry until the hub is resumed`;
  }

  return { status, isHalted, halt, resume, refusal, file };
}

let singleton = null;
function getHubHalt() { return singleton || (singleton = createHubHalt()); }

module.exports = { createHubHalt, getHubHalt };
