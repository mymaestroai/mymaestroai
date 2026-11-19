'use strict';
/**
 * claude-offered.js: the Claude client version a pending My Maestro update would bring, or null.
 * When the update check says an update is available with a remote commit id (40 hex chars), package.json at that
 * commit is read with `git show` and the Claude client dependency is taken from it. Never throws.
 */
const { execFileSync } = require('child_process');

const DEP = '@anthropic-ai/claude-agent-sdk';

function defaultGitShow(root, ref) {
  return execFileSync('git', ['show', `${ref}:package.json`], { cwd: root, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
}

function claudeOffered({ root, updateStatus, gitShow = defaultGitShow } = {}) {
  try {
    const st = typeof updateStatus === 'function' ? updateStatus() : null;
    const run = (s) => {
      if (!s || !s.available || typeof s.remote !== 'string' || !/^[0-9a-f]{40}$/i.test(s.remote)) return null;
      const pkg = JSON.parse(String(gitShow(root, s.remote)));
      const raw = pkg && pkg.dependencies && pkg.dependencies[DEP];
      const v = typeof raw === 'string' ? raw.replace(/^[\^~]/, '') : '';
      return /^[0-9]+\.[0-9]+\.[0-9]+$/.test(v) ? v : null;
    };
    // update-check status() is async; a promise cannot be answered at once, so callers may pass a sync reader
    if (st && typeof st.then === 'function') return st.then(run).catch(() => null);
    return run(st);
  } catch { return null; }
}

module.exports = { claudeOffered };
