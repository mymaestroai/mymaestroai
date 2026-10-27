'use strict';
/**
 * static-files.js — which files under the install folder a browser may fetch.
 *
 * The pages have explicit routes in server.js; this is the fallback for everything else the UI loads (its scripts,
 * the vendored libraries, icons, images, the manifest). It is an allow-list, never a deny-list: a new asset is added
 * here, and nothing outside the list is a web resource however the path is spelled (encoded dots, backslashes,
 * symlinks). Before this the fallback served any existing file under the install folder to any signed-in user,
 * .env and data/ included (2026-10-16 security review, F01/V2).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** Files at the top of the install folder that browsers load directly. */
const TOP_FILES = new Set([
  'index.html', 'mobile.html', 'login.html', 'welcome.html', 'help.html', 'users.html', 'modules.html', 'local-models.html',
  'agent-settings.html', 'tiger-team.html',
  'app.js', 'mobile.js', 'comms-panel.js', 'sw.js', 'manifest.json', 'favicon.svg', 'favicon.ico', 'favicon-64.png',
]);
/** Web names for files kept elsewhere in the install: the dialog helper is one file (lib/ui-dialog.js) that app.js and
 *  mobile.js carry copies of and the other pages load directly. */
const ALIASES = new Map([['ui-dialog.js', 'lib/ui-dialog.js']]);
/** Folders whose files (of the listed types) are web assets. */
const DIRS = new Set(['vendor', 'icons', 'images']);
const EXT = new Set(['.js', '.mjs', '.css', '.map', '.json', '.webmanifest', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.woff', '.woff2', '.ttf', '.txt']);

/**
 * resolve(pathname, root) -> absolute real path of an allowed, existing regular file, or null.
 * `pathname` is the URL path (percent-encoded or not).
 */
function resolve(pathname, root = ROOT) {
  let p;
  try { p = decodeURIComponent(String(pathname || '')); } catch { return null; }
  if (!p || p.includes('\0') || p.includes('\\')) return null;
  const rel = path.posix.normalize(p).replace(/^\/+/, '');
  if (!rel || rel === '.' || rel === '..' || rel.startsWith('../')) return null;
  const segs = rel.split('/');
  if (segs.some(s => !s || s === '.' || s === '..' || s.startsWith('.'))) return null;   // no dotfiles, no traversal
  const ext = path.posix.extname(rel).toLowerCase();
  const alias = segs.length === 1 && ALIASES.has(segs[0]) ? ALIASES.get(segs[0]).split('/') : null;
  const ok = alias || (segs.length === 1 && TOP_FILES.has(segs[0])) || (segs.length >= 2 && DIRS.has(segs[0]) && EXT.has(ext));
  if (!ok) return null;
  if (alias) segs.splice(0, segs.length, ...alias);
  let real, realRoot;
  try { real = fs.realpathSync(path.join(root, ...segs)); realRoot = fs.realpathSync(root); } catch { return null; }
  if (!real.startsWith(realRoot + path.sep)) return null;   // a symlink that leaves the install folder
  try { if (!fs.statSync(real).isFile()) return null; } catch { return null; }
  return real;
}

module.exports = { resolve, TOP_FILES, ALIASES, DIRS, EXT, ROOT };
