'use strict';
// lib/hand-off-folder.js: the helper process that makes a hand-off's job folder and reads its STATUS.md without /proc/self/fd.
// Real helper processes, temp folders only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { run, plainName } = require('../lib/hand-off-folder');

const temps = [];
function tmp() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ho-folder-')));
  temps.push(d);
  return d;
}
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

const BRIEF = '# Big Job\n\nFrom agent sam\n\nDo the thing\n';
const make = (base, extra = {}) => run({ op: 'make', base, caller: 'sam', slug: 'big-job', brief: BRIEF, ...extra });
const status = (base, names, maxBytes = 2000) => run({ op: 'status', base, names, maxBytes });

test('make: creates hand-offs/ and the job folder with brief.md; the same slug again gets -2', async () => {
  const base = tmp();
  const a = await make(base);
  assert.deepEqual(a, { ok: true, name: 'sam-big-job' });
  assert.equal(fs.readFileSync(path.join(base, 'hand-offs', 'sam-big-job', 'brief.md'), 'utf8'), BRIEF);
  const b = await make(base);
  assert.deepEqual(b, { ok: true, name: 'sam-big-job-2' });
  assert.equal(fs.readFileSync(path.join(base, 'hand-offs', 'sam-big-job-2', 'brief.md'), 'utf8'), BRIEF);
  assert.deepEqual(fs.readdirSync(path.join(base, 'hand-offs')).sort(), ['sam-big-job', 'sam-big-job-2']);
});

test('make refuses when hand-offs is a link to another folder: not_plain, nothing made in the target', async () => {
  const base = tmp();
  const outside = tmp();
  fs.symlinkSync(outside, path.join(base, 'hand-offs'));
  const a = await make(base);
  assert.equal(a.ok, false);
  assert.equal(a.code, 'not_plain');
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('make when the job folder name is an existing link to an outside folder: takes -2, writes nothing outside', async () => {
  const base = tmp();
  const outside = tmp();
  fs.mkdirSync(path.join(base, 'hand-offs'));
  fs.symlinkSync(outside, path.join(base, 'hand-offs', 'sam-big-job'));
  const a = await make(base);
  assert.deepEqual(a, { ok: true, name: 'sam-big-job-2' });
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(fs.readFileSync(path.join(base, 'hand-offs', 'sam-big-job-2', 'brief.md'), 'utf8'), BRIEF);
});

test('status: reads STATUS.md, bounded by maxBytes; null for missing, links, a named pipe and odd names', async () => {
  const base = tmp();
  const outside = tmp();
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET');
  fs.writeFileSync(path.join(outside, 'STATUS.md'), 'SECRET');
  const ho = path.join(base, 'hand-offs');
  fs.mkdirSync(ho);
  // good job
  fs.mkdirSync(path.join(ho, 'good'));
  fs.writeFileSync(path.join(ho, 'good', 'STATUS.md'), 'Step 3 of 5\nnext: tests');
  // long
  fs.mkdirSync(path.join(ho, 'long'));
  fs.writeFileSync(path.join(ho, 'long', 'STATUS.md'), 'x'.repeat(500));
  // missing STATUS.md
  fs.mkdirSync(path.join(ho, 'empty'));
  // STATUS.md is a link to a file
  fs.mkdirSync(path.join(ho, 'filelink'));
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(ho, 'filelink', 'STATUS.md'));
  // the job folder is a link
  fs.symlinkSync(outside, path.join(ho, 'folderlink'));
  // a named pipe
  let fifo = false;
  fs.mkdirSync(path.join(ho, 'pipe'));
  try { execFileSync('mkfifo', [path.join(ho, 'pipe', 'STATUS.md')]); fifo = true; } catch { /* no mkfifo: skipped */ }

  const t0 = Date.now();
  const a = await status(base, ['good', 'long', 'empty', 'filelink', 'folderlink', 'pipe', '..', 'a/b', '', 'nope'], 100);
  assert.ok(Date.now() - t0 < 3000, 'answers within 3 s (a named pipe never blocks it)');
  assert.equal(a.ok, true);
  assert.equal(a.status.good, 'Step 3 of 5\nnext: tests');
  assert.equal(a.status.long, 'x'.repeat(100), 'bounded by maxBytes');
  for (const n of ['empty', 'filelink', 'folderlink', 'pipe', '..', 'a/b', '', 'nope']) assert.equal(a.status[n], null, `${JSON.stringify(n)} is null`);
  if (!fifo) console.log('mkfifo missing: the named pipe part was skipped');

  // the hand-offs folder itself is a link
  const base2 = tmp();
  const real = tmp();
  fs.mkdirSync(path.join(real, 'job'));
  fs.writeFileSync(path.join(real, 'job', 'STATUS.md'), 'SECRET');
  fs.symlinkSync(real, path.join(base2, 'hand-offs'));
  const b = await status(base2, ['job']);
  assert.equal(b.ok, true);
  assert.equal(b.status.job, null);
});

// Starts a child process that swaps `target` between a real folder and a link to `outside`, as fast as it can.
function startSwapper(target, realDir, linkPath) {
  const script = `
    const fs = require('fs');
    const [target, realDir, linkPath] = process.argv.slice(1);
    // target is currently the real folder; swap it out and back in turn
    const park = target + '.parked';
    let state = 0;
    process.on('SIGTERM', () => process.exit(0));
    function step() {
      try {
        if (state === 0) { fs.renameSync(target, park); fs.renameSync(linkPath, target); state = 1; }
        else { fs.renameSync(target, linkPath); fs.renameSync(park, target); state = 0; }
      } catch (e) { /* a run in between: carry on */ }
    }
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1 << 30);
    (function loop() { for (let i = 0; i < 200; i++) step(); setImmediate(loop); })();
  `;
  const child = spawn(process.execPath, ['-e', script, target, realDir, linkPath], { stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise((res) => child.on('exit', res));
  const ready = new Promise((res) => child.stdout.once('data', res));
  return { child, exited, ready };
}

async function stopSwapper(s) {
  s.child.kill('SIGKILL');
  await s.exited;
}

test('race: a job folder swapped for a link while status runs never shows the outside file', async () => {
  const base = tmp();
  const outside = tmp();
  fs.writeFileSync(path.join(outside, 'STATUS.md'), 'SECRET');
  const ho = path.join(base, 'hand-offs');
  fs.mkdirSync(ho);
  const job = path.join(ho, 'job');
  fs.mkdirSync(job);
  fs.writeFileSync(path.join(job, 'STATUS.md'), 'ok');
  // the prepared link sits beside the folder, in the same hand-offs folder
  const linkPath = path.join(ho, 'job.link');
  fs.symlinkSync(outside, linkPath);
  const s = startSwapper(job, job, linkPath);
  await s.ready;
  const seen = { ok: 0, nul: 0 };
  try {
    const end = Date.now() + 3000;
    let calls = 0;
    while (calls < 40 || Date.now() < end) {
      const a = await status(base, ['job']);
      calls++;
      assert.equal(a.ok, true);
      const t = a.status.job;
      assert.ok(t === 'ok' || t === null, `got ${JSON.stringify(t)}`);
      if (t === 'ok') seen.ok++; else seen.nul++;
    }
    assert.ok(calls >= 40);
  } finally {
    await stopSwapper(s);
  }
  console.log(`status race: ${seen.ok} ok, ${seen.nul} null, never SECRET`);
});

test('race: hand-offs swapped for a link while make runs never writes in the outside folder', async () => {
  const base = tmp();
  const outside = tmp();
  const ho = path.join(base, 'hand-offs');
  fs.mkdirSync(ho);
  const linkPath = path.join(base, 'hand-offs.link');
  fs.symlinkSync(outside, linkPath);
  const s = startSwapper(ho, ho, linkPath);
  await s.ready;
  const answers = [];
  try {
    for (let i = 0; i < 20; i++) answers.push(await make(base, { slug: `race-${i}` }));
  } finally {
    await stopSwapper(s);
  }
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing was made in the outside folder');
  for (const a of answers) {
    assert.ok(a.ok === true || ['not_plain', 'error'].includes(a.code), JSON.stringify(a));
  }
  console.log(`make race: ${answers.filter((a) => a.ok).length} made, ${answers.filter((a) => !a.ok).length} refused`);
});

test('plainName', () => {
  assert.equal(plainName('sam-x'), true);
  for (const n of ['', '.', '..', 'a/b', 'a\u0000b']) assert.equal(plainName(n), false, JSON.stringify(n));
});

test('review r8: a hard link as STATUS.md (to a file outside the tree) is refused; the answer is cut to maxChars; odd names are plain keys', async () => {
  const base = tmp();
  const outside = tmp();
  const job = path.join(base, 'hand-offs', 'job');
  fs.mkdirSync(job, { recursive: true });
  const secret = path.join(outside, 'secret.txt');
  fs.writeFileSync(secret, 'SECRET');
  fs.linkSync(secret, path.join(job, 'STATUS.md'));
  let a = await status(base, ['job']);
  assert.equal(a.ok, true);
  assert.equal(a.status.job, null, 'a file with a second link is not read');
  // the plain file again: read, and cut to maxChars however long it is
  fs.unlinkSync(path.join(job, 'STATUS.md'));
  fs.writeFileSync(path.join(job, 'STATUS.md'), '\u0001'.repeat(5000));
  a = await run({ op: 'status', base, names: ['job', '__proto__'], maxBytes: 8000, maxChars: 100 });
  assert.equal(a.status.job.length, 100);
  assert.equal(a.status.__proto__, null);
  assert.ok(Object.prototype.hasOwnProperty.call(a.status, '__proto__'));
});
