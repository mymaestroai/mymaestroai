'use strict';
/**
 * hub-home.js — where the hub keeps the folders it shares with you and your agents ("the hub home"): share/
 * (each agent's Files folder, and share/common), users/ (members' folders), medical/ and legal/ (team folders).
 *
 * Installs made before 5.6 keep them in the folder that holds the install: ~/agent-hub/share sits beside
 * ~/agent-hub/agent-hub-5.1.0. The one-line installer puts the install straight into the home folder
 * (~/mymaestroai), where that rule would scatter share/, users/ and the rest across the home folder, so new
 * installs keep them inside the install instead: <install>/hub-home. `mymaestro move-home` moves an older
 * install's folders out of the home folder into <install>/hub-home (moveHome below).
 *
 * In order: HUB_HOME from the environment; <install>/hub-home when it exists; the folder above the install when
 * it already holds the hub's folders; otherwise <install>/hub-home (created when first needed). In a home folder
 * only folders the hub itself made count (share/common, share/<an agent>, users/<a member id>): a home folder may
 * well have a share/ or legal/ of its own.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const HUB_ROOT = path.resolve(__dirname, '..');
const INSIDE = 'hub-home';
const FOLDERS = ['share', 'users', 'medical', 'legal'];

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function listDir(p) { try { return fs.readdirSync(p); } catch { return []; } }

/** Names of the agents in <root>/data/agents.json (empty when there is no list yet). */
function agentNames(root) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(root, 'data', 'agents.json'), 'utf8'));
    return (Array.isArray(list) ? list : []).map(a => a && a.name).filter(n => typeof n === 'string' && n);
  } catch { return []; }
}

/** The hub's own folders in a home folder: share/common, share/<an agent>, users/<a member id>. */
function hubMadeIn(dir, { root = HUB_ROOT, dirExists = isDir, list = listDir } = {}) {
  const found = [];
  const share = path.join(dir, 'share');
  if (dirExists(path.join(share, 'common')) || agentNames(root).some(n => dirExists(path.join(share, n)))) found.push('share');
  if (list(path.join(dir, 'users')).some(n => /^[0-9a-zA-Z_-]+$/.test(n) && dirExists(path.join(dir, 'users', n, 'files')))) found.push('users');
  return found;
}

function resolveHubHome({ root = HUB_ROOT, env = process.env, home = os.homedir(), dirExists = isDir, list = listDir } = {}) {
  const set = String(env.HUB_HOME || '').trim();
  if (set) return path.resolve(set);
  const inside = path.join(root, INSIDE);
  if (dirExists(inside)) return inside;
  const parent = path.dirname(path.resolve(root));
  if (path.resolve(parent) === path.resolve(home)) {
    return hubMadeIn(parent, { root, dirExists, list }).length ? parent : inside;
  }
  return FOLDERS.some(f => dirExists(path.join(parent, f))) ? parent : inside;
}

const HUB_HOME = resolveHubHome();

function isUnder(p, dir) { const rel = path.relative(dir, p); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); }

/** Every path in the agents' policy.roots (team folders such as ~/medical are granted there), '~' expanded as lib/tool-policy does. */
function grantedRoots(root, home = os.homedir()) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(root, 'data', 'agents.json'), 'utf8'));
    return (Array.isArray(list) ? list : []).flatMap(a => (a && a.policy && Array.isArray(a.policy.roots) ? a.policy.roots : []))
      .filter(r => typeof r === 'string' && r.trim())
      .map(r => { const s = r.trim(); return s === '~' || s.startsWith('~/') ? path.join(home, s.slice(1)) : s; })
      .filter(r => path.isAbsolute(r)).map(r => path.resolve(r));
  } catch { return []; }
}

/** Replace path prefix `from` with `to` in every string of a JSON value; returns [value, changed]. */
function rewritePaths(value, pairs) {
  let changed = false;
  const walk = (v) => {
    if (typeof v === 'string') {
      for (const [from, to] of pairs) {
        if (v === from || v.startsWith(from + path.sep)) { changed = true; return to + v.slice(from.length); }
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const out = walk(value);
  return [out, changed];
}

/** Why the folders can't move as they are (empty when they can). Nothing is changed while checking. */
function moveBlockers(home, root, names) {
  const out = [];
  const agents = new Set(agentNames(root));
  for (const name of names) {
    const dir = path.join(home, name);
    let st;
    try { st = fs.lstatSync(dir); } catch { continue; }
    if (st.isSymbolicLink()) { out.push(`${dir} is a link to somewhere else; move it by hand.`); continue; }
    const entries = listDir(dir);
    if (name === 'share') {
      const other = entries.filter(e => e !== 'common' && !agents.has(e));
      if (other.length) out.push(`${dir} also holds things that are not the hub's (${other.slice(0, 5).join(', ')}${other.length > 5 ? ', …' : ''}); move them out of ${dir} first.`);
    }
    if (name === 'users') {
      const other = entries.filter(e => !isDir(path.join(dir, e, 'files')));
      if (other.length) out.push(`${dir} also holds things that are not members' folders (${other.slice(0, 5).join(', ')}${other.length > 5 ? ', …' : ''}); move them out of ${dir} first.`);
    }
  }
  return out;
}

/**
 * moveHome({ root, home, env, apply, now, docker }) — for an install whose shared folders sit loose in the home
 * folder (made by the installer before 5.6): move them into <install>/hub-home. Run it with the hub stopped
 * (`mymaestro move-home --yes` stops and restarts it). share/ and users/ move when the hub made them, medical/ and
 * legal/ only when an agent is granted the whole folder (a home folder's own legal/ stays put). Anything that is not
 * the hub's in those folders, a folder that is a link, or a team folder granted only in part stops the move before
 * anything changes. The move is all or nothing: each folder is renamed and a link left at its old place (paths agents
 * wrote down keep working), then the paths in data/agents.json and data/settings.json are rewritten (copies kept as
 * *.bak-move-home-<time>); if any step fails, everything done so far is put back. Afterwards the sandbox containers
 * that had a moved folder mounted are removed, so they are made again with the new paths (their home volumes stay).
 * Without apply it only reports the plan.
 * Returns { ok, plan, done, notes, error, rolledBack, partial }.
 */
function moveHome({ root = HUB_ROOT, home = os.homedir(), env = process.env, apply = false, now = new Date(), docker = null,
  rename = fs.renameSync, symlink = (target, at) => fs.symlinkSync(target, at, 'dir') } = {}) {
  const res = { ok: true, plan: [], done: [], notes: [], error: null, rolledBack: false, partial: false, target: path.join(root, INSIDE) };
  const current = resolveHubHome({ root, env, home });
  const parent = path.dirname(path.resolve(root));
  if (String(env.HUB_HOME || '').trim()) { res.notes.push('HUB_HOME is set, so the shared folders stay where it points.'); return res; }
  if (current !== parent || path.resolve(parent) !== path.resolve(home)) { res.notes.push(`Nothing to move: the shared folders are in ${current}.`); return res; }
  const names = hubMadeIn(home, { root });
  const granted = grantedRoots(root, home);
  const blockers = [];
  for (const team of ['medical', 'legal']) {
    const dir = path.join(home, team);
    if (!isDir(dir) || !granted.some(r => isUnder(r, dir))) continue;
    if (granted.some(r => r === path.resolve(dir))) names.push(team);
    else blockers.push(`Only part of ${dir} is granted to an agent (${granted.filter(r => isUnder(r, dir)).slice(0, 3).join(', ')}); move it by hand.`);
  }
  blockers.push(...moveBlockers(home, root, names));
  if (blockers.length) { res.ok = false; res.error = `Nothing was moved. ${blockers.join(' ')}`; return res; }
  if (!names.length) { res.notes.push('Nothing to move: no folder in the home folder was made by the hub.'); return res; }
  if (fs.existsSync(res.target)) { res.ok = false; res.error = `${res.target} already exists; move by hand or remove it first.`; return res; }
  let rootDev = null;
  try { rootDev = fs.statSync(root).dev; } catch { /* checked per folder below */ }
  for (const name of names) {
    const from = path.join(home, name);
    let st;
    try { st = fs.lstatSync(from); } catch { continue; }
    if (rootDev !== null && st.dev !== rootDev) { res.ok = false; res.error = `Nothing was moved. ${from} is on another disk than ${root}; move it by hand.`; return res; }
    res.plan.push({ name, from, to: path.join(res.target, name) });
  }
  if (!apply || !res.plan.length) return res;

  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
  const json = [];   // { file, tmp, backup, replaced }
  try {
    fs.mkdirSync(res.target, { mode: 0o700 });
    for (const step of res.plan) {
      rename(step.from, step.to);
      res.done.push({ ...step, linked: false });
      symlink(step.to, step.from);
      res.done[res.done.length - 1].linked = true;
    }
    const pairs = res.done.map(s => [s.from, s.to]);
    for (const name of ['agents.json', 'settings.json']) {
      const file = path.join(root, 'data', name);
      let data;
      try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      const [next, changed] = rewritePaths(data, pairs);
      if (!changed) continue;
      const entry = { name, file, tmp: `${file}.move-home-tmp`, backup: `${file}.bak-move-home-${stamp}`, replaced: false };
      json.push(entry);
      fs.writeFileSync(entry.tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
      fs.copyFileSync(file, entry.backup);
    }
    for (const entry of json) { rename(entry.tmp, entry.file); entry.replaced = true; }
  } catch (e) {
    // Put everything back, so the hub finds its folders and settings where they were.
    const problems = [];
    for (const entry of json) {
      try { if (fs.existsSync(entry.tmp)) fs.unlinkSync(entry.tmp); } catch (x) { problems.push(`${entry.tmp}: ${x.message}`); }
      if (entry.replaced) { try { fs.copyFileSync(entry.backup, entry.file); } catch (x) { problems.push(`data/${entry.name}: ${x.message} (the old copy is ${entry.backup})`); } }
    }
    for (const step of [...res.done].reverse()) {
      try {
        if (step.linked) fs.unlinkSync(step.from);
        rename(step.to, step.from);
      } catch (x) { problems.push(`${step.name}: still at ${step.to} (${x.message})`); }
    }
    try { fs.rmdirSync(res.target); } catch (x) {
      // A leftover hub-home would win over the folders just put back (resolveHubHome), so it counts as not undone.
      if (x.code !== 'ENOENT') problems.push(`${res.target}: could not be removed (${x.message}); while it exists the hub would look there instead of ${home}`);
    }
    res.ok = false;
    if (problems.length) {
      res.partial = true;
      res.error = `Moving stopped (${e.message}) and could not be fully undone: ${problems.join('; ')}. Do not start the hub until these are back in ${home}.`;
    } else {
      res.rolledBack = true;
      res.done = [];
      res.error = `Moving stopped and was undone, so everything is where it was: ${e.message}`;
    }
    return res;
  }
  for (const entry of json) res.notes.push(`Updated the folder paths in data/${entry.name} (the old copy is data/${entry.name}.bak-move-home-${stamp}).`);
  if (docker) {
    // Only this install's sandboxes: the ones that had a moved folder mounted. Other hubs on the machine are left alone.
    const moved = res.done.map(s => s.from);
    try {
      const ids = docker(['ps', '-aq', '--filter', 'label=agent-hub=sandbox']).split(/\s+/).filter(Boolean);
      const stale = [];
      if (ids.length) {
        // docker inspect's JSON: mount paths may hold spaces or any other character.
        for (const c of JSON.parse(docker(['inspect', ...ids]))) {
          if ((c.Mounts || []).some(m => typeof m.Source === 'string' && moved.some(from => isUnder(path.resolve(m.Source), from)))) stale.push(c.Id);
        }
      }
      if (stale.length) docker(['rm', '-f', ...stale]);
      res.notes.push(stale.length ? `Removed ${stale.length} agent sandbox container(s) that used the old folders; they are made again, with the new folders, when next used.` : 'No agent sandbox container used the old folders.');
    } catch (e) {
      res.notes.push(`Could not check the agent sandbox containers (${e.message}). Before boxed agents run, remove the ones that mount ${moved.join(' or ')} with: docker rm -f <container>`);
    }
  }
  return res;
}

module.exports = { HUB_ROOT, HUB_HOME, INSIDE, FOLDERS, resolveHubHome, hubMadeIn, agentNames, moveHome, rewritePaths };
