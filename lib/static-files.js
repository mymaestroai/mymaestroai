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
  'index.html', 'mobile.html', 'login.html', 'welcome.html', 'help.html', 'users.html', 'changes.html', 'modules.html', 'local-models.html',
  'agent-settings.html', 'tiger-team.html', 'recordings.html', 'recordings.js',
  'app.js', 'mobile.js', 'comms-panel.js', 'password-eye.js', 'sw.js', 'manifest.json', 'favicon.svg', 'favicon.ico', 'favicon-64.png',
]);
/** Web names for files kept elsewhere in the install: the dialog helper is one file (lib/ui-dialog.js) that app.js and
 *  mobile.js carry copies of and the other pages load directly; the phone-layout check (lib/ui-phone-layout.js) is
 *  loaded by index.html. */
const ALIASES = new Map([
  ['ui-dialog.js', 'lib/ui-dialog.js'], ['ui-phone-layout.js', 'lib/ui-phone-layout.js'],
  // The call display (voice calls): the Orb, the Character player, and the shared view/driver with its stylesheet. Loaded by index.html and mobile.html before app.js / mobile.js.
  ['ui-voice-thinking.js', 'lib/ui-voice-thinking.js'],  // the call's thinking sound as seeded pop-cluster data (shared by the call controller, the sound and the display)
  ['ui-voice-orb.js', 'lib/ui-voice-orb.js'], ['ui-face-player.js', 'lib/ui-face-player.js'],
  ['ui-call-display.js', 'lib/ui-call-display.js'], ['ui-call-display.css', 'lib/ui-call-display.css'],
  ['ui-file-card.js', 'lib/ui-file-card.js'],  // the download cards under a reply (shared by index.html and mobile.html, loaded before app.js / mobile.js)
  ['ui-claude-signin.js', 'lib/ui-claude-signin.js'],  // the "Claude is signed out" notice, sign-in panel and Sign in again button (index.html and mobile.html)
  ['ui-hand-off-card.js', 'lib/ui-hand-off-card.js'],  // the "Handed off to ..." cards above the message box (index.html and mobile.html)
  ['ui-agent-dot.js', 'lib/ui-agent-dot.js'],  // the one helper that decides every agent dot (free, replying, question, background work) and its words
  ['ui-code-copy.js', 'lib/ui-code-copy.js'],  // the copy button on every code box in a chat message (index.html and mobile.html, loaded before app.js / mobile.js)
  ['ui-team-card.js', 'lib/ui-team-card.js'],  // the "Set up your team" card (index.html and mobile.html)
  ['ui-feature-card.js', 'lib/ui-feature-card.js'],  // the "new features are off until you say yes" card in the lead's chat (index.html and mobile.html)
  ['ui-teams.js', 'lib/ui-teams.js'],  // who reports to whom: the Teams view's tree and the reportsTo rules (desktop and phone pages; the server validates with the same file)
  ['ui-model-offer-groups.js', 'lib/ui-model-offer-groups.js'],
  ['ui-simple.js', 'lib/ui-simple.js'],  // Simple mode's shared helper (mode, theme, reasoning level, labels), loaded before app.js / mobile.js
  ['ui-settings-help.js', 'lib/ui-settings-help.js'],  // the ⓘ help beside a setting and the search by other words (index.html, mobile.html, agent-settings.html, users.html)
  ['ui-agent-card.js', 'lib/ui-agent-card.js'],  // the agent card: one panel (a full-screen sheet on the phone) with every setting of one agent (index.html, mobile.html)
  ['ui-agent-card-basics.js', 'lib/ui-agent-card-basics.js'],  // the agent card's Basics and Role and team rows (index.html, mobile.html, loaded after ui-agent-card.js)
  ['ui-agent-card-more.js', 'lib/ui-agent-card-more.js'],  // the agent card's Memory, Access and Schedule rows (index.html, mobile.html, loaded after ui-agent-card.js)
  ['ui-looks.js', 'lib/ui-looks.js'],  // the look registry and early loader, in the <head> of every page (public: login.html and welcome.html load it before sign-in)
]);
/** Look stylesheets: /looks/<id>.css for the ids in the registry (lib/ui-looks) only, kept under looks/. */
const LOOK_IDS = new Set(require('./ui-looks').LOOKS.filter(l => l.css).map(l => l.id));
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
  const lookCss = segs.length === 2 && segs[0] === 'looks' && segs[1].endsWith('.css') && LOOK_IDS.has(segs[1].slice(0, -4));   // exact case: /looks/x.CSS is not a look
  const ok = alias || lookCss || (segs.length === 1 && TOP_FILES.has(segs[0])) || (segs.length >= 2 && DIRS.has(segs[0]) && EXT.has(ext));
  if (!ok) return null;
  if (alias) segs.splice(0, segs.length, ...alias);
  let real, realRoot;
  try { real = fs.realpathSync(path.join(root, ...segs)); realRoot = fs.realpathSync(root); } catch { return null; }
  if (!real.startsWith(realRoot + path.sep)) return null;   // a symlink that leaves the install folder
  try { if (!fs.statSync(real).isFile()) return null; } catch { return null; }
  return real;
}

module.exports = { resolve, TOP_FILES, ALIASES, DIRS, EXT, ROOT };
