'use strict';
// Tiger Team batch 1, review round 1: the war-room page. Image src bypass, saved transcripts, Resume with a note.
// The page's own functions are cut out of tiger-team.html and run in a vm.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../tiger-team.html'), 'utf8');

function cut(from, to) {
  const a = html.indexOf(from); assert.ok(a > 0, from + ' not found');
  const b = html.indexOf(to, a); assert.ok(b > a, to + ' not found');
  return html.slice(a, b);
}

// ── 1. sameOriginImgSrc ──
const imgCtx = { URL }; vm.createContext(imgCtx);
vm.runInContext(cut('function sameOriginImgSrc', 'function purifyFixNode'), imgCtx);
const ORIGIN = 'https://hub.test';

test('sameOriginImgSrc: a tab, newline or CR inside the value is rejected (browsers strip them and load //evil)', () => {
  for (const src of ['/\t/evil.example/p.gif', '/\n/evil.example/p.gif', '/\r/evil.example/p.gif', '/\u0000/evil.example/p.gif', '/ /evil.example', '/\x7f/x', '/a b.png']) {
    assert.equal(imgCtx.sameOriginImgSrc(src, ORIGIN), false, JSON.stringify(src));
  }
});

test('sameOriginImgSrc: other origins, protocol-relative, backslash and data URLs are rejected; a plain same-origin path is kept', () => {
  for (const src of ['//x', '//evil.example/p.gif', '/\\x', 'https://x', 'https://hub.test/a.png', 'data:image/png;base64,AAAA', 'javascript:alert(1)', 'files/x.png', '']) {
    assert.equal(imgCtx.sameOriginImgSrc(src, ORIGIN), false, JSON.stringify(src));
  }
  assert.equal(imgCtx.sameOriginImgSrc('/api/files/download?x', ORIGIN), true);
  assert.equal(imgCtx.sameOriginImgSrc('/api/files/abc.png', ORIGIN), true);
});

test('purifyFixNode uses sameOriginImgSrc with the page origin', () => {
  assert.match(html, /if \(!sameOriginImgSrc\(src, location\.origin\)\) node\.removeAttribute\('src'\);/);
});

// ── 2. Saved sessions: no ids or names, the same hook ──
test('loadSaved: the saved-transcript sanitize no longer allows id, forbids id and name, and the hook is registered first', () => {
  const start = html.indexOf('timeline.innerHTML = DOMPurify.sanitize(rawTranscript');
  assert.ok(start > 0);
  const block = html.slice(start, html.indexOf('});', start));
  const addAttr = /ADD_ATTR: \[([^\]]*)\]/.exec(block)[1];
  assert.doesNotMatch(addAttr, /'id'/);
  const forbid = /FORBID_ATTR: \[([^\]]*)\]/.exec(block)[1];
  assert.match(forbid, /'id'/); assert.match(forbid, /'name'/);
  const before = html.slice(html.lastIndexOf('if (purifyReady()) {', start), start);
  assert.match(before, /ensurePurifyHook\(\);/, 'registered before the saved transcript is sanitized');
  const mdSrc = cut('function md(text)', 'let purifyHooked');
  assert.ok(mdSrc.indexOf('ensurePurifyHook();') > 0 && mdSrc.indexOf('ensurePurifyHook();') < mdSrc.indexOf('DOMPurify.sanitize('), 'md() registers before its sanitize');
  assert.equal((html.match(/DOMPurify\.addHook\(/g) || []).length, 1, 'one registration point');
});

test('ensurePurifyHook registers the node hook exactly once, and only when DOMPurify is there', () => {
  const calls = [];
  const ctx = { DOMPurify: { sanitize() {}, addHook: (name, fn) => calls.push([name, fn]) } }; vm.createContext(ctx);
  vm.runInContext('const purifyReady = () => typeof DOMPurify !== "undefined" && typeof DOMPurify.sanitize === "function"; function purifyFixNode() {}', ctx);
  vm.runInContext(cut('let purifyHooked', 'function sameOriginImgSrc'), ctx);
  vm.runInContext('ensurePurifyHook(); ensurePurifyHook(); ensurePurifyHook();', ctx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'afterSanitizeAttributes');
});

// ── 3. Resume with a note ──
function resumeHarness({ statusResp, statusThrows, postResp, statusData = {} }) {
  const timeline = { children: [], appendChild(c) { this.children.push(c); } };
  const input = { value: 'my note', disabled: false };
  const els = { timeline, 'user-input': input, 'btn-resume': { style: {}, disabled: false, textContent: '' }, 'btn-send': {}, 'btn-stop': {}, 'tt-error-banner': { style: {} } };
  const msgs = [];
  const ctx = {
    document: { getElementById: id => els[id] || (els[id] = { style: {} }), createElement: () => ({ className: '', innerHTML: '' }), title: '' },
    fetch: async (url) => {
      if (String(url).startsWith('/api/tiger-team/status')) {
        if (statusThrows) throw new Error('offline');
        return statusResp || { ok: true, status: 200, json: async () => statusData };
      }
      return postResp || { ok: true, status: 200, json: async () => ({}) };
    },
    encodeURIComponent, JSON, Error, Promise, msgs,
  };
  vm.createContext(ctx);
  vm.runInContext(`
    let tigerTeamId = 't1', continuationInFlight = false, isRunning = false;
    const sentInterjections = [];
    const addSystemMsg = m => msgs.push(m), addDivider = () => {}, setStatus = () => {}, setInputMode = () => {}, handleEvent = () => {};
    const closeBlock = () => {}, stamp = () => '22:00', scrollBottom = () => {}, md = t => t;
    const loadTeam = async () => true, loadSaved = async () => {}, readSSE = async () => {}, afterStreamEnd = async () => {};
  `, ctx);
  vm.runInContext(cut('async function resumeWithNote', 'async function continueSession'), ctx);
  vm.runInContext(cut('async function resumeInterruptedTeam', 'async function deleteSaved'), ctx);
  return { ctx, input, timeline, msgs, sent: () => Array.from(vm.runInContext('sentInterjections', ctx)) };
}

test('Resume with a note: status 404 -> the note stays in the input, no card, nothing recorded as sent', async () => {
  const h = resumeHarness({ statusResp: { ok: false, status: 404 } });
  await h.ctx.resumeWithNote();
  assert.equal(h.input.value, 'my note'); assert.equal(h.timeline.children.length, 0); assert.deepEqual(h.sent(), []);
});

test('Resume with a note: the status check throws -> the note stays, no card', async () => {
  const h = resumeHarness({ statusThrows: true });
  await h.ctx.resumeWithNote();
  assert.equal(h.input.value, 'my note'); assert.equal(h.timeline.children.length, 0); assert.deepEqual(h.sent(), []);
  assert.ok(h.msgs.some(m => /Status check failed/.test(m)));
});

test('Resume with a note: running elsewhere -> the note stays, no card', async () => {
  const h = resumeHarness({ statusData: { status: 'running' } });
  await h.ctx.resumeWithNote();
  assert.equal(h.input.value, 'my note'); assert.equal(h.timeline.children.length, 0); assert.deepEqual(h.sent(), []);
});

test('Resume with a note: already completed -> the note stays, no card', async () => {
  const h = resumeHarness({ statusData: { status: 'completed' } });
  await h.ctx.resumeWithNote();
  assert.equal(h.input.value, 'my note'); assert.equal(h.timeline.children.length, 0); assert.deepEqual(h.sent(), []);
});

test('Resume with a note: the resume POST is not ok -> the note stays, no card, nothing recorded as sent', async () => {
  const h = resumeHarness({ statusData: { status: 'interrupted' }, postResp: { ok: false, status: 500, json: async () => ({ error: 'boom' }) } });
  await h.ctx.resumeWithNote();
  assert.equal(h.input.value, 'my note'); assert.equal(h.timeline.children.length, 0); assert.deepEqual(h.sent(), []);
});

test('Resume with a note: the POST is ok -> the card is drawn once, the input is cleared, the note is recorded as sent', async () => {
  const h = resumeHarness({ statusData: { status: 'interrupted' } });
  await h.ctx.resumeWithNote();
  assert.equal(h.timeline.children.length, 1);
  assert.match(h.timeline.children[0].innerHTML, /Note/);
  assert.equal(h.input.value, '');
  assert.deepEqual(h.sent(), ['my note']);
});

test('Resume without a note draws no card', async () => {
  const h = resumeHarness({ statusData: { status: 'interrupted' } });
  h.input.value = '   ';
  await h.ctx.resumeWithNote();
  assert.equal(h.timeline.children.length, 0);
});
