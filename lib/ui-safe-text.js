'use strict';
/**
 * Text-safety helpers shared, VERBATIM, with the browser pages (app.js and mobile.js carry the same four
 * functions between the same begin/end marker comments as below). The pages are plain scripts and cannot
 * require() this file, so test/ui-escaping.test.js checks that the copies in both pages are
 * character-for-character the functions below; behaviour is tested there, in Node, without a DOM.
 *
 *   escapeHtml(s)                 all five HTML-significant characters, for text nodes and attribute values
 *   autolinkEscaped(text, attrs)  bare http(s) URLs in ALREADY-ESCAPED text become anchors; the URL is cut
 *                                 at the first character outside a strict charset, so a quote never gets in
 *   safeLinkUrl(url)              a markdown link target: control characters and whitespace stripped; only
 *                                 http(s), mailto and same-origin relative paths pass; anything else is null
 *   imageSrcKind(src, origin)     an <img> source: { kind: 'same' | 'data' | 'blob' | 'external', url } or null
 */

// ── safe-text helpers (begin) ──
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function autolinkEscaped(text, attrs) {
  // Runs on text that is already HTML-escaped, so a quote can only appear as &quot; / &#39; and never raw.
  return String(text).replace(/(^|[^"=])(https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+)/g, (m, lead, url) => {
    const cut = url.search(/&quot;|&#39;|&lt;|&gt;/);
    const u = cut >= 0 ? url.slice(0, cut) : url;
    const rest = cut >= 0 ? url.slice(cut) : '';
    if (!/^https?:\/\/[A-Za-z0-9]/.test(u)) return m;
    return `${lead}<a href="${u}" target="_blank" rel="noopener noreferrer"${attrs || ''}>${u}</a>${rest}`;
  });
}
function safeLinkUrl(url) {
  const u = String(url ?? '').replace(/&amp;/g, '&').replace(/[\u0000- \u007f-\u009f\s]/g, '');
  if (!u) return null;
  if (/^https?:\/\//i.test(u) || /^mailto:/i.test(u)) return u;
  if (/^\/\//.test(u)) return null;                       // protocol-relative: another host
  if (/^[/#?]/.test(u)) return u;                         // same-origin path, fragment or query
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;          // relative path (no scheme at all)
  return null;                                            // javascript:, data:, vbscript:, file:, ...
}
function imageSrcKind(src, origin) {
  const s = String(src ?? '').replace(/[\u0000- \u007f-\u009f\s]/g, '');
  if (/^data:image\//i.test(s)) return { kind: 'data', url: s };
  if (/^blob:/i.test(s)) return { kind: 'blob', url: s };
  const u = safeLinkUrl(s);
  if (!u || /^mailto:/i.test(u)) return null;
  if (!/^https?:\/\//i.test(u)) return { kind: 'same', url: u };
  try { return { kind: new URL(u).origin === String(origin || '') ? 'same' : 'external', url: u }; } catch { return null; }
}
// ── safe-text helpers (end) ──

module.exports = { escapeHtml, autolinkEscaped, safeLinkUrl, imageSrcKind };
