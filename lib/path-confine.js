'use strict';
// Confine file access to a set of real directory roots, resolving symlinks on EVERY path component.
// Used by the boxed agents' file tools (lib/hub-tools.js) and the Records loader (lib/records.js): both run
// in the host hub process, so a lexical prefix check would follow a symlink an agent planted in its own
// writable mount out to any host file. resolveLanding() answers "where does this path really land?" even for
// a name that does not exist yet (a create) and for dangling or nested symlinks; callers then require the
// landing to be under an allowed real root.
//
// This is a pre-open check, not a race-free one: it does not by itself close a check-then-open TOCTOU where a
// concurrent process swaps a component to a symlink between the check and the syscall. Closing that fully
// means executing a boxed agent's file operations inside its container; this helper closes the one-shot
// (non-racing) escape, which was the reported path.

const fs = require('fs');
const path = require('path');

/**
 * resolveLanding(a) -> the real path where `a` lands, following symlinks on every component (recursively,
 * bounded by `budget` link hops), without requiring `a` to exist. A not-yet-created trailing name lands under
 * its fully-resolved real parent. A dangling or nested-through-another-symlink target resolves to its real
 * location (never to a lexical path that merely looks inside). A runaway symlink chain returns a sentinel that
 * is under no root (fail closed).
 */
function resolveLanding(startPath, budget = 256) {
  // The entry path is normalised once (Node hands the same string to the eventual open(), so its own `..`
  // cannot cross a symlink differently than the check). Symlink TARGETS, however, must be processed component
  // by component WITHOUT lexical normalisation: a target like `jump/../secret` where `jump` is a symlink must
  // follow `jump` before applying `..` (kernel semantics). `..` is therefore applied to the resolved-so-far
  // `cur`, and a link's own components are prepended to the work-list. One shared hop budget bounds total
  // symlink work (no per-branch budget, so a fan-out chain cannot blow up).
  const abs = path.resolve(startPath);
  const root = path.parse(abs).root || path.sep;
  const split = (s) => s.split(path.sep).filter((c) => c.length);   // only the real separator: a backslash is a legal POSIX filename char, not a separator
  let rest = split(abs.slice(root.length));
  let cur = root;
  let hops = budget;
  while (rest.length) {
    const comp = rest.shift();
    if (comp === '.') continue;
    if (comp === '..') { cur = path.dirname(cur); continue; }
    const next = path.join(cur, comp);
    let lst;
    try { lst = fs.lstatSync(next); }
    catch { return path.join(cur, comp, ...rest); }   // absent component: nothing more to cross, remainder is new
    if (lst.isSymbolicLink()) {
      if (--hops < 0) return '\u0000';                 // runaway chain / cycle: under no root (fail closed)
      let link; try { link = fs.readlinkSync(next); } catch { return '\u0000'; }
      if (path.isAbsolute(link)) { const r = path.parse(link).root || path.sep; cur = r; rest = split(link.slice(r.length)).concat(rest); }
      else rest = split(link).concat(rest);            // relative link: its components (incl. ..) apply to `cur`
    } else {
      cur = next;
    }
  }
  return cur;
}

/** true if `real` is one of `roots` or sits under one of them. */
function underAny(real, roots) {
  return roots.some(r => real === r || real.startsWith(r + path.sep));
}

/** realpath a root, falling back to a lexical resolve when it does not exist yet. */
function realRoot(r) { try { return fs.realpathSync.native(r); } catch { return path.resolve(r); } }

module.exports = { resolveLanding, underAny, realRoot };
