'use strict';
/**
 * ui-retire.js — a line in the chat that has done its job leaves a few seconds later. During a long reply the
 * question lines (yellow) and the finished worker lines (green) sat under the reply and piled up at the bottom,
 * pushing the reply itself up the screen. The pages carry byte-identical copies between the markers below (app.js,
 * mobile.js); test/ui-retire.test.js proves the copies match and tests the behaviour here.
 *
 *   retireSoon(el, ms)  after ms (default RETIRE_AFTER_MS), the element folds away (the page's CSS class
 *                        `retiring` animates it) and is then removed. Once per element; an element no longer in
 *                        the page by then is left alone (and can be scheduled again). Returns true when it scheduled
 *                        the element. Callers retire a line only once its job is done for sure: a question once the
 *                        hub confirms the answer (or says it is closed), a worker once it finished.
 */
// ── retire helpers (begin) ──
const RETIRE_AFTER_MS = 4000;
const RETIRE_FOLD_MS = 600;
function retireSoon(el, ms = RETIRE_AFTER_MS) {
  if (!el || !el.dataset || el.dataset.retiring) return false;
  el.dataset.retiring = '1';
  setTimeout(() => {
    if (!el.isConnected) { delete el.dataset.retiring; return; }   // gone meanwhile: if it comes back, it can be retired again
    el.style.maxHeight = el.offsetHeight + 'px';   // fold from its own height, not from "none"
    void el.offsetHeight;
    el.classList.add('retiring');
    setTimeout(() => el.remove(), RETIRE_FOLD_MS);
  }, ms);
  return true;
}
// ── retire helpers (end) ──

module.exports = { retireSoon, RETIRE_AFTER_MS, RETIRE_FOLD_MS };
