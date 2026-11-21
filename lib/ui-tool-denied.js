'use strict';
/**
 * Tool-result helper shared, VERBATIM, with the browser pages (app.js and mobile.js carry the same function
 * between the same begin/end marker comments as below; the pages are plain scripts and cannot require() this
 * file, so test/ui-tool-denied.test.js checks that both copies are character-for-character the code below).
 *
 *   toolResultDenied(output)   true when a tool call's result is the hub refusing it, not the tool failing: the
 *                              text the agent is given by the server (lib/tool-policy.js denialText, and the
 *                              wallet / comms "not authorised" lines) starts with [DENIED BY POLICY],
 *                              [DENIED BY OWNER], [NOT APPROVED] or [DENIED]. Only the START counts, so a result that
 *                              merely mentions the words (a file, a web page) is not a denial.
 */

// ── tool-result helpers (begin) ──
function toolResultDenied(output) {
  return /^\s*(?:PreToolUse:\S+ hook [A-Za-z ]*:\s*)?\[(?:DENIED(?: BY (?:POLICY|OWNER))?|NOT APPROVED)\]/.test(String(output ?? ''));
}
// ── tool-result helpers (end) ──

module.exports = { toolResultDenied };
