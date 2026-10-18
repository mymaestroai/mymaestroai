'use strict';
/**
 * Shared folders an admin can grant to an agent: the list behind GET /api/folders and the "Shared folders"
 * picker on the agent settings page. A granted folder goes into the agent's policy.roots, which is what
 * lib/sandbox mountsFor() mounts into its container and what lib/tool-policy treats as writable.
 *
 * Kinds (and their labels):
 *   common     share/common, the one folder every admin-side agent shares
 *   team       medical/ and legal/ under the hub home, when they exist
 *   files      share/<agent>, the Files folder of every admin-side agent ("Files of <agent>")
 *   workspace  workspaces/<agent> of every admin-side agent, when it exists ("Workspace of <agent>")
 * Admin-side = owner null (infrastructure) or owned by an admin. Member trees (users/<id>) and data/ are
 * never listed. Paths are absolute.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { HUB_HOME, HUB_ROOT, TEAM_FOLDERS } = require('./tool-policy');

const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

/** listFolders({ agents, adminIds, hubHome, hubRoot, exists }) -> [{ path, label, kind }] */
function listFolders({ agents = [], adminIds = new Set(), hubHome = HUB_HOME, hubRoot = HUB_ROOT, exists = (p) => fs.existsSync(p) } = {}) {
  const admins = new Set([...adminIds].map(String));
  const adminSide = (a) => !a.owner || admins.has(String(a.owner));
  const names = [...new Set(agents.filter(a => a && typeof a.name === 'string' && a.name && adminSide(a)).map(a => a.name))].sort();
  const out = [];
  const common = path.join(hubHome, 'share', 'common');
  if (exists(common)) out.push({ path: common, label: 'Common folder (share/common)', kind: 'common' });
  for (const t of TEAM_FOLDERS) {
    const p = path.join(hubHome, t);
    if (exists(p)) out.push({ path: p, label: `${cap(t)} team folder`, kind: 'team' });
  }
  for (const n of names) out.push({ path: path.join(hubHome, 'share', n), label: `Files of ${n}`, kind: 'files' });
  for (const n of names) {
    const p = path.join(hubRoot, 'workspaces', n);
    if (exists(p)) out.push({ path: p, label: `Workspace of ${n}`, kind: 'workspace' });
  }
  return out;
}

/** resolveRoots(policy.roots) -> absolute paths in the same order (~ expanded), as lib/tool-policy resolves them. */
function resolveRoots(roots, home = os.homedir()) {
  return (Array.isArray(roots) ? roots : []).map(r => path.resolve(String(r).replace(/^~(?=\/|$)/, home)));
}

module.exports = { listFolders, resolveRoots };
