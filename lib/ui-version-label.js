'use strict';
/**
 * ui-version-label.js — the pure helpers behind the version label (desktop sidebar, phone ⋮ menu) and the About box.
 * The pages carry byte-identical copies between the markers below (app.js, mobile.js); test/ui-version-label.test.js
 * proves the copies match and tests the behaviour here. They return plain text: the pages escape it before use.
 *
 *   versionLabel(v)            GET /api/version → { text, kind: 'stable' | 'experimental' | 'other', title } or null
 *                                stable: "v5.7.3 · stable"; experimental: "v5.7.3-dev · 2522a10";
 *                                any other branch: "v5.7.3 · <branch> · 2522a10"
 *   updateStatusText(s)        GET /api/update-check → "Up to date" / "5.8.0 available" / "3 new changes available" /
 *                                "Check off" / "Check failed: …" / "Not checked yet"; null without one (members)
 *   versionDetailsText(v, u, ua)  the About box's "Copy details" block for bug reports (plain text, one fact per line)
 */

// ── version-label helpers (begin) ──
function versionLabel(v) {
  if (!v || !v.version) return null;
  const sha = v.commit ? String(v.commit).slice(0, 12) : '';
  if (v.channel === 'stable') return { text: `v${v.version} · stable`, kind: 'stable', title: `My Maestro AI ${v.version}, stable channel` };
  if (v.channel === 'experimental') return { text: `v${v.version}-dev${sha ? ` · ${sha}` : ''}`, kind: 'experimental', title: `My Maestro AI ${v.version}, experimental channel (branch ${v.branch || 'dev'})${sha ? `, commit ${sha}` : ''}` };
  const where = v.branch || 'no branch';
  return { text: `v${v.version} · ${where}${sha ? ` · ${sha}` : ''}`, kind: 'other', title: `My Maestro AI ${v.version}, branch ${where}${sha ? `, commit ${sha}` : ''}` };
}
function updateStatusText(s) {
  if (!s || typeof s !== 'object') return null;
  if (s.enabled === false) return 'Check off';
  if (s.available) {
    if (s.latestVersion && s.latestVersion !== s.currentVersion) return `${s.latestVersion} available`;
    const n = Number(s.behind) || 0;
    return n > 0 ? `${n} new change${n === 1 ? '' : 's'} available` : 'Update available';
  }
  if (s.error) return `Check failed: ${s.error}`;
  if (s.checking) return 'Checking…';
  return s.checkedAt ? 'Up to date' : 'Not checked yet';
}
function versionDetailsText(v, u, ua) {
  v = v || {};
  const when = (t) => { const d = new Date(t); return t && !isNaN(d) ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'unknown'; };
  const channel = v.channel ? `${v.channel}${v.branch ? ` (branch ${v.branch})` : ''}` : (v.branch ? `branch ${v.branch}` : 'unknown');
  const lines = [
    `My Maestro AI ${v.version || 'unknown'}`,
    `Channel: ${channel}`,
    `Commit: ${v.commit || 'unknown'}${v.commitDate ? ` (${v.commitDate})` : ''}`,
    `Hub started: ${when(v.startedAt)}`,
    `Node.js: ${v.node || 'unknown'}`,
    `Restart pending: ${v.restartPending == null ? 'unknown' : v.restartPending ? 'yes (code on disk is newer than the running hub)' : 'no'}`,
  ];
  const up = updateStatusText(u);
  if (up) lines.push(`Update: ${up}`);
  if (ua) lines.push(`Browser: ${ua}`);
  return lines.join('\n');
}
// ── version-label helpers (end) ──

module.exports = { versionLabel, updateStatusText, versionDetailsText };
