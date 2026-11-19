'use strict';
// The war-room page (tiger-team.html), batch 1: member text cannot take over the page, input bar by state,
// times on cards, the target list, the final auto-save. The page's own functions are cut out of its source and run in a vm.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../tiger-team.html'), 'utf8');

/** One function (or the span from `from` up to `to`) of the page's script. */
function cut(from, to) {
  const a = html.indexOf(from); assert.ok(a > 0, from + ' not found');
  const b = to ? html.indexOf(to, a) : a; assert.ok(b >= a, to + ' not found');
  return html.slice(a, b);
}

// ── 1. Member text cannot take over the page ──
const mdSource = cut('function md(text)', 'function fmtDuration');

test('md(): no id attribute is allowed, SANITIZE_DOM is on, the node hook is installed', () => {
  const allowed = /ALLOWED_ATTR: \[([^\]]*)\]/.exec(mdSource)[1].split(',').map(s => s.trim().replace(/'/g, ''));
  assert.deepEqual(allowed.sort(), ['alt', 'class', 'href', 'rel', 'src', 'target']);
  assert.equal(allowed.includes('id'), false);
  assert.match(mdSource, /SANITIZE_DOM: true/);
  assert.match(mdSource, /FORBID_ATTR: \[[^\]]*'id'/, 'id is also forbidden outright');
  assert.match(mdSource, /DOMPurify\.addHook\('afterSanitizeAttributes', purifyFixNode\)/);
});

/** A minimal element: just the attribute calls the hook makes. */
function el(tagName, attrs) {
  const a = { ...attrs };
  return { tagName, getAttribute: k => (k in a ? a[k] : null), setAttribute: (k, v) => { a[k] = String(v); }, removeAttribute: k => { delete a[k]; }, attrs: a };
}
const hook = (() => { const ctx = {}; vm.createContext(ctx); vm.runInContext(cut('function purifyFixNode', '    function fmtDuration').replace(/\n\s*$/, ''), ctx); return ctx.purifyFixNode; })();

test('images keep src only for a same-origin path; every other src is dropped', () => {
  for (const src of ['https://evil.example/t.gif', 'http://evil.example/t.gif', 'data:image/png;base64,AAAA', '//evil.example/t.gif', '/\\evil.example/t.gif', 'javascript:alert(1)', 'files/x.png', '']) {
    const n = el('IMG', { src, alt: 'x' }); hook(n);
    assert.equal('src' in n.attrs, false, `src ${JSON.stringify(src)} must be dropped`);
  }
  const ok = el('IMG', { src: '/api/files/abc.png' }); hook(ok);
  assert.equal(ok.attrs.src, '/api/files/abc.png');
});

test('links get rel="noopener noreferrer"; external ones open in a new tab, same-origin ones do not', () => {
  const ext = el('A', { href: 'https://example.org/x' }); hook(ext);
  assert.equal(ext.attrs.rel, 'noopener noreferrer'); assert.equal(ext.attrs.target, '_blank');
  const proto = el('A', { href: '//example.org/x', target: '_self' }); hook(proto);
  assert.equal(proto.attrs.target, '_blank');
  const own = el('A', { href: '/api/files/a.pdf', target: '_blank' }); hook(own);
  assert.equal(own.attrs.rel, 'noopener noreferrer'); assert.equal('target' in own.attrs, false);
});

// ── 4. Times on cards ──
const timeCtx = {}; vm.createContext(timeCtx);
vm.runInContext(cut('function fmtDuration', '    let userScrolledUp'), timeCtx);

test('the clock time is 24-hour local HH:MM; durations read 42s / 3m 12s', () => {
  const at = new Date(2026, 10, 18, 22, 14, 9).getTime();
  assert.equal(timeCtx.clockTime(at), '22:14');
  assert.equal(timeCtx.clockTime(new Date(2026, 10, 18, 7, 5).getTime()), '07:05');
  assert.equal(timeCtx.fmtDuration(42), '42s'); assert.equal(timeCtx.fmtDuration(192), '3m 12s'); assert.equal(timeCtx.fmtDuration(-5), '0s');
  assert.equal(timeCtx.stampText(at, at - 192000), '22:14 · 3m 12s');
});

test('every card kind carries the stamp; a finished member card appends "· took …"', () => {
  assert.equal((html.match(/<span class="block-time">\$\{stamp\(\)\}<\/span>/g) || []).length, 6, 'agent, interjection, continuation, note, replayed-message and rounds-approval cards');
  assert.doesNotMatch(html, /<span class="block-time">\$\{elapsed\(\)\}/);
  assert.match(html, /m\.textContent = `⚙ \$\{text\} \(\$\{stamp\(\)\}\)`/, 'system notes too');
  const finish = cut('function finishCallBlock', 'function markUnfinishedTools');
  assert.match(finish, /' · took ' \+ fmtDuration\(\(\(eventNow \|\| Date\.now\(\)\) - block\.startedAt\) \/ 1000\)/);
  assert.match(cut('function makeBlock', 'function openBlock'), /startedAt: eventNow \|\| Date\.now\(\)/);
});

// ── 3. Input bar by state ──
function fakeDom() {
  const mk = (extra = {}) => ({ style: {}, disabled: false, value: '', placeholder: '', textContent: '', innerHTML: '', ...extra });
  const els = { 'user-input': mk(), 'btn-send': mk(), 'interject-target': mk({ style: { display: 'none' } }) };
  els.label = mk();
  const ctx = {
    document: { getElementById: id => els[id], querySelector: s => (s === '.input-label' ? els.label : null) },
    esc: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    agents: { alice: { display: 'Alice <Writer>' }, bob: { display: 'Bob' } }, participants: ['alice', 'bob', 'sam'],
    tigerTeamId: 'tt', backendRecoveryAvailable: true,
    injectMessage() {}, continueSession() {}, resumeWithNote() {},
  };
  vm.createContext(ctx);
  vm.runInContext(cut('/** The target choices while the team runs', '    // ── Stop ──') + '\nthis.setInputMode = setInputMode; this.buildTargetOptions = buildTargetOptions;', ctx);
  return { ctx, els };
}

test('running: "Interject:", the target select shown, button "Interject" wired to injectMessage', () => {
  const { ctx, els } = fakeDom();
  ctx.setInputMode('running');
  assert.match(els.label.textContent, /Interject:$/);
  assert.equal(els['interject-target'].style.display, '');
  assert.equal(els['btn-send'].textContent, 'Interject'); assert.equal(els['btn-send'].onclick, ctx.injectMessage);
  assert.equal(els['user-input'].disabled, false);
});

test('complete: "Continue:", select hidden, button "Continue", follow-up placeholder, wired to continueSession', () => {
  const { ctx, els } = fakeDom();
  ctx.setInputMode('running'); els['user-input'].value = 'old text';
  ctx.setInputMode('complete');
  assert.match(els.label.textContent, /Continue:$/);
  assert.equal(els['interject-target'].style.display, 'none');
  assert.equal(els['btn-send'].textContent, 'Continue'); assert.equal(els['btn-send'].onclick, ctx.continueSession);
  assert.equal(els['user-input'].placeholder, 'Ask a follow-up or give a new directive…');
  assert.equal(els['user-input'].disabled, false); assert.equal(els['btn-send'].disabled, false);
});

test('ended: "Continue:", select hidden, input ENABLED, "Resume with this note" wired to resumeWithNote', () => {
  const { ctx, els } = fakeDom();
  ctx.setInputMode('ended');
  assert.match(els.label.textContent, /Continue:$/);
  assert.equal(els['interject-target'].style.display, 'none');
  assert.equal(els['btn-send'].textContent, 'Resume with this note'); assert.equal(els['btn-send'].onclick, ctx.resumeWithNote);
  assert.equal(els['user-input'].placeholder, 'A note for the team; it resumes from where it stopped…');
  assert.equal(els['user-input'].disabled, false); assert.equal(els['btn-send'].disabled, false);
  ctx.backendRecoveryAvailable = false; ctx.setInputMode('ended');
  assert.equal(els['user-input'].disabled, true, 'no recovery backend: nothing to resume');
});

test('the target list: team, coordinator, and one "<Display> only" per member, names escaped', () => {
  const { ctx, els } = fakeDom();
  ctx.buildTargetOptions();
  const html1 = els['interject-target'].innerHTML;
  assert.deepEqual([...html1.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map(m => [m[1], m[2]]), [
    ['team', 'Team: coordinator + everyone working now'], ['coordinator', 'Coordinator only'],
    ['alice', 'Alice &lt;Writer&gt; only'], ['bob', 'Bob only'], ['sam', 'sam only'],
  ]);
  assert.doesNotMatch(html1, /<Writer>/);
});

test('every way a run ends lands in the same mode: complete -> Continue, stopped/failed/interrupted/saved-unfinished -> ended', () => {
  const section = (from, to) => cut(from, to);
  assert.match(section("case 'tt_complete':", "case 'tt_notice':"), /showContinueUI\(\)/);
  assert.match(section("case 'tt_error':", '// Interrupted mid-stream'), /setInputMode\('ended'\)/);
  assert.match(section("case 'tt_interrupted': {", "case 'tt_retry':"), /setInputMode\('ended'\)/);
  assert.match(section("case 'tt_state':", "case 'interjection_received'"), /showContinueUI\(\)[\s\S]*tt_interrupted/, 'a replayed team ends through the same two handlers');
  const saved = section('async function loadSaved(', '// ── Resume Interrupted Team');
  assert.match(saved, /\['interrupted', 'stopped', 'blocked', 'running', 'retrying', 'stopping', 'in_progress'\]\.includes\(status\)\) \{[^}]*setInputMode\('ended'\)/);
  assert.match(saved, /else \{[^}]*setInputMode\('complete'\)/);
  assert.match(html, /function showContinueUI\(\) \{\s*setInputMode\('complete'\);/);
  assert.match(html, /function setRunning\(running\) \{[\s\S]{0,200}if \(running\) setInputMode\('running'\)/);
});

test('Resume with a note posts the note to /resume and keeps it if the resume fails; the button click passes none', () => {
  const resume = cut('async function resumeInterruptedTeam(', 'async function deleteSaved');
  assert.match(resume, /note = typeof note === 'string' \? note\.trim\(\) : ''/);
  assert.match(resume, /JSON\.stringify\(\{ session_id: tigerTeamId, \.\.\.\(note \? \{ message: note \} : \{\}\) \}\)/);
  assert.match(resume, /setInputMode\('ended'\); input\.value = note;/);
  assert.match(html, /onclick="resumeInterruptedTeam\(\)"/);
});

// ── 6. The final auto-save ──
test('stopAutoSave forces the last save past the 10 s debounce; ordinary saves are still debounced', async () => {
  let posts = 0, now = 1000000;
  const ctx = {
    saveKey: 'k', sessionId: null, tigerTeamId: 'tt', lastAutoSave: 0, autoSaveInterval: null, isRunning: false,
    Date: { now: () => now }, clearInterval() {}, objectiveText: 'o', coordinator: 'coord', participants: [], mode: 'led',
    document: { getElementById: id => id === 'timeline' ? { innerHTML: 'x' } : { classList: { contains: () => true } } },
    fetch: async () => { posts++; return {}; },
  };
  vm.createContext(ctx);
  vm.runInContext(cut('async function autoSave(force)', 'function startAutoSave') + cut('function stopAutoSave', '    // Save on page unload') + '\nthis.autoSave = autoSave; this.stopAutoSave = stopAutoSave;', ctx);
  await ctx.autoSave(); assert.equal(posts, 1);
  now += 3000; await ctx.autoSave(); assert.equal(posts, 1, 'inside 10 s: debounced');
  now += 1000; ctx.stopAutoSave(); await new Promise(r => setImmediate(r)); assert.equal(posts, 2, 'the final save is not debounced');
});

test('the page script still parses', () => {
  for (const [, script] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(script);
});
