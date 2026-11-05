'use strict';
// The chat file (data/conversations/<agent>.jsonl) is read from its end: loading history reads only the lines it
// returns, and a reply's progress saves replace only the last line. Results must match the old whole-file code exactly.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sdkChat = require('../lib/sdk-chat');
const { appendConversationLog, loadConversationLog, clearConversationLog } = sdkChat;

const AGENT = 'zz_convlog_test';
const convFile = path.join(__dirname, '..', 'data', 'conversations', `${AGENT}.jsonl`);
fs.mkdirSync(path.dirname(convFile), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'convlog-'));
after(() => { try { fs.unlinkSync(convFile); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); });

// The old code, as it was: the reference the new code must match.
function oldLoad(file, limit = 50) {
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function oldAppend(file, role, content, overwriteLast = false, metadata = undefined, ts = 'T') {
  if (!content || !content.trim()) return;
  const entry = JSON.stringify({ ts, role, content, ...(metadata || {}) });
  if (overwriteLast) {
    try {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length > 0) {
        try {
          const lastEntry = JSON.parse(lines[lines.length - 1]);
          if (lastEntry.role === 'assistant' && !lastEntry.ask) {
            const base = lastEntry.base || 0;
            const piece = base ? content.slice(base) : content;
            if (!piece.trim()) return;
            lines[lines.length - 1] = JSON.stringify({ ts, role, content: piece, ...(metadata || {}), ...(base ? { base } : {}) });
            fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
            return;
          }
          if (lastEntry.ask) {
            let prev = null;
            for (let i = lines.length - 2; i >= 0; i--) { const e = JSON.parse(lines[i]); if (e.ask) continue; prev = e.role === 'assistant' ? e : null; break; }
            if (prev) {
              const base = (prev.base || 0) + prev.content.length;
              const matches = prev.base ? content.length >= base : content.startsWith(prev.content);
              if (matches) {
                const piece = content.slice(base);
                if (!piece.trim()) return;
                fs.appendFileSync(file, JSON.stringify({ ts, role, content: piece, ...(metadata || {}), base }) + '\n', 'utf8');
                return;
              }
            }
          }
        } catch {}
      }
      fs.appendFileSync(file, entry + '\n', 'utf8');
    } catch { fs.appendFileSync(file, entry + '\n', 'utf8'); }
    return;
  }
  fs.appendFileSync(file, entry + '\n', 'utf8');
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    if (lines.length > 300) fs.writeFileSync(file, lines.slice(-200).join('\n') + '\n', 'utf8');
  } catch {}
}
const withoutTs = (rows) => rows.map(({ ts, ...rest }) => rest);

// A small seeded generator, so a failure can be replayed.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const PIECES = ['a', 'é', '漢', '🌿', ' ', '\n', '"', '\\', 'word ', 'x'.repeat(100)];
function text(r, n) { let s = ''; while (s.length < n) s += PIECES[Math.floor(r() * PIECES.length)]; return s; }

test('history from the end of the file matches the old whole-file read, across 64 KB chunk edges and multi-byte text', () => {
  const r = rng(7);
  for (let round = 0; round < 40; round++) {
    const f = path.join(tmp, `load-${round}.jsonl`);
    const lines = [];
    const n = 1 + Math.floor(r() * 120);
    for (let i = 0; i < n; i++) {
      const k = r();
      // lengths around the read chunk (64 KB) on purpose, plus short and empty-ish lines and a corrupt one now and then
      const len = k < 0.15 ? 65536 - 40 + Math.floor(r() * 80) : k < 0.25 ? 70000 + Math.floor(r() * 9000) : Math.floor(r() * 3000);
      // now and then a corrupt line, an empty line or a line of spaces
      lines.push(k > 0.98 ? '{not json' : k > 0.96 ? '' : k > 0.95 ? '  \t ' : JSON.stringify({ ts: 't', role: r() < 0.5 ? 'user' : 'assistant', content: text(r, len) }));
    }
    const tails = ['', '\n', '\n\n\n', '\n  \n\t\n'];   // no newline at the end, one, several, whitespace
    const head = r() < 0.1 ? '\n\n' : '';
    fs.writeFileSync(f, head + lines.join('\n') + tails[Math.floor(r() * tails.length)]);
    fs.copyFileSync(f, convFile);
    for (const limit of [1, 2, 7, 50, 500]) {
      assert.deepStrictEqual(loadConversationLog(AGENT, limit), oldLoad(f, limit), `round ${round}, limit ${limit}`);
    }
    fs.unlinkSync(f);
  }
  assert.deepStrictEqual(loadConversationLog('zz_convlog_missing', 50), [], 'a missing file is an empty history');
  fs.writeFileSync(convFile, '');
  assert.deepStrictEqual(loadConversationLog(AGENT, 50), [], 'an empty file is an empty history');
});

test('random sequences of messages, progress saves and question pieces leave the same file as the old code', () => {
  const r = rng(11);
  for (let round = 0; round < 30; round++) {
    const ref = path.join(tmp, `ref-${round}.jsonl`);
    try { fs.unlinkSync(ref); } catch {}
    clearConversationLog(AGENT);
    let reply = '';
    for (let step = 0; step < 80; step++) {
      const k = r();
      if (k < 0.15) { reply = ''; const t = text(r, 1 + Math.floor(r() * 200)); appendConversationLog(AGENT, 'user', t); oldAppend(ref, 'user', t); }
      else if (k < 0.6) { reply += text(r, 1 + Math.floor(r() * (r() < 0.1 ? 70000 : 400))); appendConversationLog(AGENT, 'assistant', reply, true); oldAppend(ref, 'assistant', reply, true); }
      else if (k < 0.7) { const q = '❓ ' + text(r, 30); appendConversationLog(AGENT, 'assistant', q, false, { ask: true }); oldAppend(ref, 'assistant', q, false, { ask: true }); const a = '↳ ' + text(r, 10); appendConversationLog(AGENT, 'user', a, false, { ask: true }); oldAppend(ref, 'user', a, false, { ask: true }); }
      else if (k < 0.8) { appendConversationLog(AGENT, 'assistant', reply, false); oldAppend(ref, 'assistant', reply, false); reply = ''; }
      else { const t = text(r, 1 + Math.floor(r() * 50)); appendConversationLog(AGENT, 'assistant', t, true); oldAppend(ref, 'assistant', t, true); }
    }
    assert.deepStrictEqual(withoutTs(loadConversationLog(AGENT, 10000)), withoutTs(oldLoad(ref, 10000)), `round ${round}`);
  }
});

test('a progress save never reads or rewrites the whole chat file, and loading history reads only its end', () => {
  clearConversationLog(AGENT);
  const big = JSON.stringify({ ts: 't', role: 'assistant', content: 'y'.repeat(40000) });
  fs.writeFileSync(convFile, Array.from({ length: 290 }, () => big).join('\n') + '\n');   // ~12 MB, under the trim
  appendConversationLog(AGENT, 'user', 'start a reply');        // counts the lines once
  appendConversationLog(AGENT, 'assistant', 'first words', false);
  const size = fs.statSync(convFile).size;
  const calls = { readFile: 0, writeFile: 0, bytesRead: 0 };
  const orig = { readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync, readSync: fs.readSync };
  fs.readFileSync = function (p, ...rest) { if (String(p) === convFile) calls.readFile++; return orig.readFileSync.call(this, p, ...rest); };
  fs.writeFileSync = function (p, ...rest) { if (String(p) === convFile) calls.writeFile++; return orig.writeFileSync.call(this, p, ...rest); };
  fs.readSync = function (fd, buf, off, len, pos) { const n = orig.readSync.call(this, fd, buf, off, len, pos); calls.bytesRead += n; return n; };
  try {
    let reply = 'first words';
    for (let i = 0; i < 20; i++) { reply += ' and more'; appendConversationLog(AGENT, 'assistant', reply, true); }
    assert.strictEqual(calls.readFile, 0, 'progress saves must not read the whole file');
    assert.strictEqual(calls.writeFile, 0, 'progress saves must not rewrite the whole file');
    assert.ok(calls.bytesRead < 20 * 200 * 1024, `progress saves read only the end of the file (${calls.bytesRead} bytes for 20 saves of a ${size}-byte file)`);
    calls.bytesRead = 0;
    const h = loadConversationLog(AGENT, 5);
    assert.strictEqual(h.length, 5);
    assert.strictEqual(h[4].content, reply, 'the last line holds the latest progress save');
    assert.ok(calls.bytesRead < 400 * 1024, `history of 5 lines reads only the end of the file (${calls.bytesRead} bytes)`);
    appendConversationLog(AGENT, 'user', 'next message');
    assert.strictEqual(calls.readFile, 0, 'a new message under the trim limit does not reread the file either');
  } finally { Object.assign(fs, orig); }
});

test('blank lines, whitespace and a long run of newlines at the end read and save exactly as before', () => {
  const entry = (c) => JSON.stringify({ ts: 't', role: 'assistant', content: c });
  const files = [
    entry('a') + '\n' + entry('b') + '\n' + '\n'.repeat(65536),   // valid history, then 64 KB of newlines
    '\n\n' + entry('first') + '\n\n\n' + entry('second') + '\n   \n' + entry('third') + '\n \t \n',
    Array.from({ length: 30 }, (_, i) => entry('z'.repeat(5000) + i)).join('\n\n\n') + '\n\n',
    '\uFEFF' + entry('after a byte-order mark') + '\n' + entry('second') + '\n',   // a file saved by an editor with a BOM
  ];
  for (const [n, body] of files.entries()) {
    const f = path.join(tmp, `edge-${n}.jsonl`);
    fs.writeFileSync(f, body);
    fs.copyFileSync(f, convFile);
    for (const limit of [0, 1, 2, 3, 50]) assert.deepStrictEqual(loadConversationLog(AGENT, limit), oldLoad(f, limit), `file ${n}, limit ${limit}`);
    appendConversationLog(AGENT, 'assistant', 'replacement', true);
    oldAppend(f, 'assistant', 'replacement', true);
    assert.deepStrictEqual(withoutTs(loadConversationLog(AGENT, 1000)), withoutTs(oldLoad(f, 1000)), `file ${n}: a progress save replaces the last reply`);
  }
});

// fs.writeSync misbehaves for its first calls as `plan` says, then works again (a full disk that clears). Only the
// chat code calls fs.writeSync directly; appendFileSync takes its own path on the Node versions installs run.
function flakyWrites(plan) {
  const orig = fs.writeSync;
  let calls = 0;
  fs.writeSync = function (fd, buf, off, len, pos) {
    const step = plan[calls++];
    if (step === 'short') return orig.call(this, fd, buf, off, Math.max(1, Math.floor(len / 2)), pos);
    if (step === 'all-but-one') return orig.call(this, fd, buf, off, Math.max(1, len - 1), pos);
    if (step === 'enospc') { const e = new Error('ENOSPC: no space left on device'); e.code = 'ENOSPC'; throw e; }
    return orig.call(this, fd, buf, off, len, pos);
  };
  return { restore: () => { fs.writeSync = orig; }, calls: () => calls };
}
const wholeLines = () => {
  const raw = fs.readFileSync(convFile, 'utf8');
  return raw.endsWith('\n') && raw.trim().split('\n').every(l => { try { JSON.parse(l); return true; } catch { return false; } });
};
function quietErrors() { const errs = []; const orig = console.error; console.error = (...a) => errs.push(a.join(' ')); return { errs, restore: () => { console.error = orig; } }; }

test('a short write followed by a full disk never leaves a broken line: the reply is written anew as a whole line', () => {
  clearConversationLog(AGENT);
  appendConversationLog(AGENT, 'user', 'question');
  appendConversationLog(AGENT, 'assistant', 'partial reply', false);
  const w = flakyWrites(['short', 'enospc']);
  try { appendConversationLog(AGENT, 'assistant', 'partial reply, now longer', true); } finally { w.restore(); }
  assert.ok(w.calls() >= 2, 'the short write was retried');
  assert.ok(wholeLines(), 'every line is whole JSON and the file ends with a newline');
  assert.deepStrictEqual(loadConversationLog(AGENT, 50).map(e => e.content), ['question', 'partial reply, now longer'], 'the reply was kept');
  appendConversationLog(AGENT, 'assistant', 'partial reply, now longer still', true);
  assert.deepStrictEqual(loadConversationLog(AGENT, 50).map(e => e.content), ['question', 'partial reply, now longer still']);
});

test('a failed save after a question card keeps the piece and its base: no text is written twice', () => {
  clearConversationLog(AGENT);
  appendConversationLog(AGENT, 'user', 'Tell me about the shed.');
  appendConversationLog(AGENT, 'assistant', 'Before.', false);
  appendConversationLog(AGENT, 'assistant', '❓ Which color? [Green / Blue]', false, { ask: true });
  appendConversationLog(AGENT, 'user', '↳ Green', false, { ask: true });
  appendConversationLog(AGENT, 'assistant', 'Before.After.', true);   // the piece after the question
  let log = loadConversationLog(AGENT, 50);
  assert.deepStrictEqual([log[4].content, log[4].base], ['After.', 'Before.'.length]);
  const w = flakyWrites(['short', 'enospc']);
  try { appendConversationLog(AGENT, 'assistant', 'Before.After.More.', true); } finally { w.restore(); }
  assert.ok(wholeLines());
  log = loadConversationLog(AGENT, 50);
  assert.deepStrictEqual(log.map(e => e.content), ['Tell me about the shed.', 'Before.', '❓ Which color? [Green / Blue]', '↳ Green', 'After.More.']);
  assert.strictEqual(log[4].base, 'Before.'.length, 'the piece keeps its base');
  assert.strictEqual(log.filter(e => e.role === 'assistant' && !e.ask).map(e => e.content).join(''), 'Before.After.More.', 'no text twice');
});

test('if cutting a failed line back fails too, nothing is added after it, and the next save puts the file right', () => {
  clearConversationLog(AGENT);
  appendConversationLog(AGENT, 'user', 'question');
  appendConversationLog(AGENT, 'assistant', 'partial reply', false);
  const w = flakyWrites(['all-but-one', 'enospc']);   // every byte but the newline, then a full disk
  const origTrunc = fs.ftruncateSync;
  let truncs = 0;
  fs.ftruncateSync = function (...a) { if (++truncs === 2) { const e = new Error('EIO: i/o error'); e.code = 'EIO'; throw e; } return origTrunc.apply(this, a); };
  const q = quietErrors();
  try { assert.doesNotThrow(() => appendConversationLog(AGENT, 'assistant', 'partial reply, now longer', true), 'a progress save never throws'); }
  finally { w.restore(); fs.ftruncateSync = origTrunc; q.restore(); }
  assert.ok(q.errs.some(m => /progress save failed/.test(m)), 'the failure is logged');
  assert.deepStrictEqual(loadConversationLog(AGENT, 50).map(e => e.content), ['question', 'partial reply, now longer'], 'the line is there once, not twice');
  appendConversationLog(AGENT, 'assistant', 'partial reply, now longer still', true);
  assert.ok(wholeLines(), 'the next save leaves whole lines');
  assert.deepStrictEqual(loadConversationLog(AGENT, 50).map(e => e.content), ['question', 'partial reply, now longer still']);
});

test('no save ever throws, even when nothing can be written, and the next one after the disk clears is normal', () => {
  clearConversationLog(AGENT);
  appendConversationLog(AGENT, 'user', 'question');
  appendConversationLog(AGENT, 'assistant', 'partial', false);
  const w = flakyWrites(Array(12).fill('enospc'));
  const q = quietErrors();
  try {
    assert.doesNotThrow(() => appendConversationLog(AGENT, 'assistant', 'partial and more', true), 'a progress save');
    assert.doesNotThrow(() => appendConversationLog(AGENT, 'assistant', 'a first save of a new reply', false), 'a first save (the Claude and ChatGPT routes)');
    assert.doesNotThrow(() => appendConversationLog(AGENT, 'user', 'a message'), 'a message');
  } finally { w.restore(); q.restore(); }
  assert.ok(q.errs.some(m => /progress save failed/.test(m)) && q.errs.some(m => /could not save/.test(m)), 'the failures are logged');
  assert.ok(wholeLines(), 'nothing half-written was left behind');
  appendConversationLog(AGENT, 'assistant', 'partial and more still', true);
  assert.ok(wholeLines());
  assert.deepStrictEqual(loadConversationLog(AGENT, 50).map(e => e.content), ['question', 'partial and more still']);
});

test('a re-written line that fails part-way after a question card is cut off too: no text twice, base kept', () => {
  clearConversationLog(AGENT);
  appendConversationLog(AGENT, 'user', 'Tell me about the shed.');
  appendConversationLog(AGENT, 'assistant', 'Before.', false);
  appendConversationLog(AGENT, 'assistant', '❓ Which color? [Green / Blue]', false, { ask: true });
  appendConversationLog(AGENT, 'user', '↳ Green', false, { ask: true });
  appendConversationLog(AGENT, 'assistant', 'Before.After.', true);
  // the replacement fails part-way (cut back), then writing it anew fails part-way too (cut back again)
  const w = flakyWrites(['short', 'enospc', 'short', 'enospc']);
  const q = quietErrors();
  try { appendConversationLog(AGENT, 'assistant', 'Before.After.More.', true); } finally { w.restore(); q.restore(); }
  assert.ok(wholeLines(), 'no fragment was left behind');
  appendConversationLog(AGENT, 'assistant', 'Before.After.More.Again.', true);   // the disk has cleared
  const log = loadConversationLog(AGENT, 50);
  assert.deepStrictEqual(log.map(e => e.content), ['Tell me about the shed.', 'Before.', '❓ Which color? [Green / Blue]', '↳ Green', 'After.More.Again.']);
  assert.strictEqual(log[4].base, 'Before.'.length, 'the piece keeps its base');
});

test('if a failed append cannot be cut back, the cut is made before the next write', () => {
  clearConversationLog(AGENT);
  appendConversationLog(AGENT, 'user', 'first');
  const w = flakyWrites(['all-but-one', 'enospc']);   // the whole line but its newline, then a full disk
  const origTrunc = fs.ftruncateSync;
  let failTrunc = true;
  fs.ftruncateSync = function (...a) { if (failTrunc) { failTrunc = false; const e = new Error('EIO: i/o error'); e.code = 'EIO'; throw e; } return origTrunc.apply(this, a); };
  const q = quietErrors();
  try { appendConversationLog(AGENT, 'user', 'lost to the full disk'); } finally { w.restore(); fs.ftruncateSync = origTrunc; q.restore(); }
  appendConversationLog(AGENT, 'user', 'second');
  assert.ok(wholeLines());
  assert.deepStrictEqual(loadConversationLog(AGENT, 50).map(e => e.content), ['first', 'second'], 'the fragment was cut before the next write');
});

test('every progress-save timer and the shutdown flush go through the guard that keeps a failed save from stopping the hub', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  const timers = src.match(/incrementalSaveTimer = setInterval\(\(\) => [^\n]*/g) || [];
  assert.ok(timers.length >= 3, `found ${timers.length} save timers`);
  for (const t of timers) assert.match(t, /=> guardedSave\(agentName, \(\) => \{$/, t);
  const flush = src.slice(src.indexOf('function flushActiveResponses'), src.indexOf('function flushActiveResponses') + 800);
  assert.match(flush, /guardedSave\(agentName, \(\) => appendConversationLog\(/);
});

test('a save says whether it landed, and the save timers count a reply as saved only when it did', () => {
  clearConversationLog(AGENT);
  assert.strictEqual(appendConversationLog(AGENT, 'user', 'question'), true);
  assert.strictEqual(appendConversationLog(AGENT, 'assistant', 'partial', false), true);
  const w = flakyWrites(Array(8).fill('enospc'));
  const q = quietErrors();
  let p, m;
  try { p = appendConversationLog(AGENT, 'assistant', 'partial and more', true); m = appendConversationLog(AGENT, 'user', 'x'); } finally { w.restore(); q.restore(); }
  assert.strictEqual(p, false, 'a failed progress save says so');
  assert.strictEqual(m, false, 'a failed message save says so');
  assert.strictEqual(appendConversationLog(AGENT, 'assistant', 'partial and more', true), true, 'the same save, once the disk clears, lands');
  assert.deepStrictEqual(loadConversationLog(AGENT, 50).map(e => e.content), ['question', 'partial and more']);
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  const starts = [...src.matchAll(/incrementalSaveTimer = setInterval\(/g)].map(x => x.index);
  assert.ok(starts.length >= 3, `found ${starts.length} save timers`);
  for (const i of starts) {
    const block = src.slice(i, src.indexOf('}),', i) + 3);
    assert.match(block, /&& appendConversationLog\(/, 'the reply counts as saved only when the save landed');
    assert.doesNotMatch(block, /^\s*appendConversationLog\(/m, 'no save whose result is ignored');
  }
});

test('a pending cut survives a failed look at the file, and is never made on a file replaced since', () => {
  const failOnce = (name, code) => { const orig = fs[name]; let armed = true; fs[name] = function (...a) { if (armed) { armed = false; const e = new Error(code); e.code = code; throw e; } return orig.apply(this, a); }; return () => { fs[name] = orig; }; };
  const q = quietErrors();
  try {
    // the cut can't be made, and the next look at the file fails too: the cut stays pending, that save fails, the next one cuts
    clearConversationLog(AGENT);
    appendConversationLog(AGENT, 'user', 'first');
    let w = flakyWrites(['all-but-one', 'enospc']);
    let undo = failOnce('ftruncateSync', 'EIO');
    try { appendConversationLog(AGENT, 'user', 'lost'); } finally { w.restore(); undo(); }
    const origStat = fs.statSync; let armed = true;
    fs.statSync = function (p, ...rest) { if (armed && String(p) === convFile) { armed = false; const e = new Error('EIO'); e.code = 'EIO'; throw e; } return origStat.call(this, p, ...rest); };
    let r;
    try { r = appendConversationLog(AGENT, 'user', 'not now'); } finally { fs.statSync = origStat; }
    assert.strictEqual(r, false, 'the save fails while the file cannot be checked');
    appendConversationLog(AGENT, 'user', 'second');
    assert.deepStrictEqual(loadConversationLog(AGENT, 50).map(e => e.content), ['first', 'second']);
    // the chat file is replaced (a restore) before the next write: the cut is left for the old file, not made on the new one
    clearConversationLog(AGENT);
    appendConversationLog(AGENT, 'user', 'old one');
    w = flakyWrites(['all-but-one', 'enospc']);
    undo = failOnce('ftruncateSync', 'EIO');
    try { appendConversationLog(AGENT, 'user', 'lost'); } finally { w.restore(); undo(); }
    const restored = `${convFile}.restore-test`;
    fs.writeFileSync(restored, ['restored 1', 'restored 2', 'restored 3'].map(c => JSON.stringify({ ts: 't', role: 'user', content: c })).join('\n') + '\n');
    fs.renameSync(restored, convFile);
    appendConversationLog(AGENT, 'user', 'after the restore');
    assert.deepStrictEqual(loadConversationLog(AGENT, 50).map(e => e.content), ['restored 1', 'restored 2', 'restored 3', 'after the restore']);
  } finally { q.restore(); }
});

test('a reply whose message never reached the file is added, never written over the previous reply', () => {
  clearConversationLog(AGENT);
  appendConversationLog(AGENT, 'user', 'Q1');
  appendConversationLog(AGENT, 'assistant', 'A1', false);
  const w = flakyWrites(['enospc']); const q = quietErrors();
  let r; try { r = appendConversationLog(AGENT, 'user', 'Q2'); } finally { w.restore(); q.restore(); }
  assert.strictEqual(r, false, 'the message did not reach the file');
  appendConversationLog(AGENT, 'assistant', 'A2 so far', false);         // a reply's first save adds a line
  appendConversationLog(AGENT, 'assistant', 'A2 so far, and more', true);
  assert.deepStrictEqual(loadConversationLog(AGENT, 50).map(e => e.content), ['Q1', 'A1', 'A2 so far, and more'], 'A1 survives');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.doesNotMatch(src, /appendConversationLog\(agentName, 'assistant', (tracked\.)?fullResponse, true\b/, 'no route starts a reply by replacing the last line');
});

test('a pending cut is not made on a chat file rewritten in place since (same file, new contents)', () => {
  const q = quietErrors();
  try {
    clearConversationLog(AGENT);
    appendConversationLog(AGENT, 'user', 'old one');
    const w = flakyWrites(['all-but-one', 'enospc']);
    const origTrunc = fs.ftruncateSync; let armed = true;
    fs.ftruncateSync = function (...a) { if (armed) { armed = false; const e = new Error('EIO'); e.code = 'EIO'; throw e; } return origTrunc.apply(this, a); };
    try { appendConversationLog(AGENT, 'user', 'lost'); } finally { w.restore(); fs.ftruncateSync = origTrunc; }
    const ino = fs.statSync(convFile).ino;
    fs.writeFileSync(convFile, ['restored 1', 'restored 2'].map(c => JSON.stringify({ ts: 't', role: 'user', content: c })).join('\n') + '\n');   // copied over it
    const later = (Date.now() + 5000) / 1000;
    fs.utimesSync(convFile, later, later);
    assert.strictEqual(fs.statSync(convFile).ino, ino, 'the same file');
    appendConversationLog(AGENT, 'user', 'after the restore');
    assert.deepStrictEqual(loadConversationLog(AGENT, 50).map(e => e.content), ['restored 1', 'restored 2', 'after the restore']);
  } finally { q.restore(); }
});

test('the trim keeps the chat file\'s permissions, and copies a crash left behind are removed at start', () => {
  clearConversationLog(AGENT);
  for (let i = 1; i <= 300; i++) appendConversationLog(AGENT, 'user', `m${i}`);
  fs.chmodSync(convFile, 0o664);
  const old = process.umask(0o022);
  try { appendConversationLog(AGENT, 'user', 'm301'); } finally { process.umask(old); }
  assert.strictEqual(loadConversationLog(AGENT, 1000).length, 200);
  assert.strictEqual(fs.statSync(convFile).mode & 0o777, 0o664, 'the permissions are the chat file\'s, not the umask\'s');
  const left = `${convFile}.trim-999999999`;          // its process is gone
  const mine = `${convFile}.trim-${process.pid}`;     // this process is running: its trim may be under way
  fs.writeFileSync(left, 'x'); fs.writeFileSync(mine, 'x');
  sdkChat.__convlog.sweepTrimLeftovers(path.dirname(convFile));
  assert.strictEqual(fs.existsSync(left), false, 'a crashed trim\'s copy is removed');
  assert.strictEqual(fs.existsSync(mine), true, 'a running process\'s copy is left alone');
  fs.unlinkSync(mine);
});

test('a trim interrupted before its rename leaves the chat whole and no stray file', () => {
  clearConversationLog(AGENT);
  for (let i = 1; i <= 300; i++) appendConversationLog(AGENT, 'user', `m${i}`);
  const origRename = fs.renameSync;
  fs.renameSync = function (from, to) { if (String(to) === convFile) { const e = new Error('EIO: i/o error'); e.code = 'EIO'; throw e; } return origRename.call(this, from, to); };
  try { appendConversationLog(AGENT, 'user', 'm301'); } finally { fs.renameSync = origRename; }
  assert.strictEqual(loadConversationLog(AGENT, 1000).length, 301, 'the chat was left whole');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(convFile)).filter(n => n.startsWith(`${AGENT}.jsonl.`)), [], 'no temporary file was left');
  appendConversationLog(AGENT, 'user', 'm302');
  assert.strictEqual(loadConversationLog(AGENT, 1000).length, 200, 'the next message trims it');
});

test('a line torn by a crash stays on its own, and the next entries start on a new line', () => {
  clearConversationLog(AGENT);
  appendConversationLog(AGENT, 'user', 'hello');
  fs.appendFileSync(convFile, '{"ts":"t","role":"assistant","content":"cut of');   // the process died mid-write
  appendConversationLog(AGENT, 'assistant', 'the reply so far', true);
  appendConversationLog(AGENT, 'user', 'next');
  assert.deepStrictEqual(loadConversationLog(AGENT, 50).map(e => e.content), ['hello', 'the reply so far', 'next']);
});

test('the chat file is still trimmed to the last 200 entries once it passes 300, also after outside changes', () => {
  clearConversationLog(AGENT);
  for (let i = 1; i <= 300; i++) appendConversationLog(AGENT, 'user', `m${i}`);
  assert.strictEqual(loadConversationLog(AGENT, 1000).length, 300, 'no trim at 300');
  appendConversationLog(AGENT, 'user', 'm301');
  let h = loadConversationLog(AGENT, 1000);
  assert.strictEqual(h.length, 200, 'trimmed past 300');
  assert.deepStrictEqual([h[0].content, h[199].content], ['m102', 'm301']);
  // something else rewrites the file (a restore, a hand edit): the next check counts again instead of trusting its count
  fs.writeFileSync(convFile, Array.from({ length: 300 }, (_, i) => JSON.stringify({ ts: 't', role: 'user', content: `r${i + 1}` })).join('\n') + '\n');
  appendConversationLog(AGENT, 'user', 'r301');
  h = loadConversationLog(AGENT, 1000);
  assert.strictEqual(h.length, 200, 'the outside rewrite was counted');
  assert.strictEqual(h[199].content, 'r301');
});
