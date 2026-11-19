'use strict';
/**
 * claude-offered.js: the Claude client version a pending My Maestro update would bring, or null.
 * When the update check says an update is available with a remote commit id (40 hex chars), package.json at that
 * commit is read with `git show` (async, so the hub keeps answering) and the Claude client dependency is taken from it.
 * Never throws; answers with a promise.
 */
const { execFile } = require('child_process');

const DEP = '@anthropic-ai/claude-agent-sdk';

function defaultGitShow(root, ref) {
  return new Promise((resolve, reject) => {
    execFile('git', ['show', `${ref}:package.json`], { cwd: root, timeout: 5000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

async function claudeOffered({ root, updateStatus, gitShow = defaultGitShow } = {}) {
  try {
    const st = typeof updateStatus === 'function' ? await updateStatus() : null;   // update-check status() is async; a sync reader works too
    if (!st || !st.available || typeof st.remote !== 'string' || !/^[0-9a-f]{40}$/i.test(st.remote)) return null;
    const pkg = JSON.parse(String(await gitShow(root, st.remote)));
    const raw = pkg && pkg.dependencies && pkg.dependencies[DEP];
    const v = typeof raw === 'string' ? raw.replace(/^[\^~]/, '') : '';
    return /^[0-9]+\.[0-9]+\.[0-9]+$/.test(v) ? v : null;
  } catch { return null; }
}

module.exports = { claudeOffered };
