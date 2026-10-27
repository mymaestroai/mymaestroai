'use strict';
// The setup interview survives a closed window: the lead agent keeps its place in its Record setup-interview.md (the
// playbook says how), the Welcome page's "You're all set" screen points back to it until that Record says complete,
// and installs whose copy of the playbook was never edited get the new one at startup (refreshShippedWorkspaceFiles).
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { refreshShippedWorkspaceFiles } = require('../lib/agents');
const { createWelcome } = require('../lib/welcome');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'interview-'));

function layout(copyText, previous) {
  const root = tmp(), tpl = path.join(root, 'templates'), ws = path.join(root, 'workspaces');
  fs.mkdirSync(path.join(tpl, 'maestro'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'maestro'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'maestro', 'SETUP-INTERVIEW.md'), 'NEW GUIDE\n');
  if (copyText !== null) fs.writeFileSync(path.join(ws, 'maestro', 'SETUP-INTERVIEW.md'), copyText, { mode: 0o640 });
  const manifest = path.join(root, 'workspace-updates.json');
  fs.writeFileSync(manifest, JSON.stringify({ _about: 'x', 'maestro/SETUP-INTERVIEW.md': { current: sha('NEW GUIDE\n'), previous } }));
  return { root, tpl, ws, manifest, copy: path.join(ws, 'maestro', 'SETUP-INTERVIEW.md') };
}

test('an unedited earlier guide is replaced by the new one; an edited one, the current one, a missing one and a link stay', () => {
  let l = layout('OLD GUIDE\n', [sha('OLD GUIDE\n')]);
  assert.deepStrictEqual(refreshShippedWorkspaceFiles(l.tpl, l.ws, l.manifest), ['maestro/SETUP-INTERVIEW.md']);
  assert.strictEqual(fs.readFileSync(l.copy, 'utf8'), 'NEW GUIDE\n');
  assert.strictEqual(fs.statSync(l.copy).mode & 0o777, 0o640, 'the file keeps its mode');
  assert.deepStrictEqual(refreshShippedWorkspaceFiles(l.tpl, l.ws, l.manifest), [], 'a second start changes nothing');
  assert.deepStrictEqual(fs.readdirSync(path.join(l.ws, 'maestro')), ['SETUP-INTERVIEW.md'], 'no temporary file left');

  l = layout('OLD GUIDE\nplus my own rule\n', [sha('OLD GUIDE\n')]);
  assert.deepStrictEqual(refreshShippedWorkspaceFiles(l.tpl, l.ws, l.manifest), []);
  assert.strictEqual(fs.readFileSync(l.copy, 'utf8'), 'OLD GUIDE\nplus my own rule\n', 'the owner edited it: theirs stays');

  l = layout(null, [sha('OLD GUIDE\n')]);
  assert.deepStrictEqual(refreshShippedWorkspaceFiles(l.tpl, l.ws, l.manifest), [], 'no copy yet: seeding makes it');

  l = layout(null, [sha('OLD GUIDE\n')]);
  const elsewhere = path.join(l.root, 'elsewhere.md'); fs.writeFileSync(elsewhere, 'OLD GUIDE\n');
  fs.symlinkSync(elsewhere, l.copy);
  assert.deepStrictEqual(refreshShippedWorkspaceFiles(l.tpl, l.ws, l.manifest), []);
  assert.ok(fs.lstatSync(l.copy).isSymbolicLink() && fs.readFileSync(elsewhere, 'utf8') === 'OLD GUIDE\n', 'a link is never followed or replaced');

  // The agent folder itself a link to somewhere else: nothing there is written.
  l = layout(null, [sha('OLD GUIDE\n')]);
  const outside = path.join(l.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'SETUP-INTERVIEW.md'), 'OLD GUIDE\n');
  fs.rmSync(path.join(l.ws, 'maestro'), { recursive: true }); fs.symlinkSync(outside, path.join(l.ws, 'maestro'));
  assert.deepStrictEqual(refreshShippedWorkspaceFiles(l.tpl, l.ws, l.manifest), []);
  assert.strictEqual(fs.readFileSync(path.join(outside, 'SETUP-INTERVIEW.md'), 'utf8'), 'OLD GUIDE\n', 'a linked agent folder is not followed');

  // The write fails after the temporary file was created (a full disk): the copy is untouched and nothing is left.
  l = layout('OLD GUIDE\n', [sha('OLD GUIDE\n')]);
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = function (f, ...rest) { if (typeof f === 'number') throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); return realWrite.call(this, f, ...rest); };
  try { assert.deepStrictEqual(refreshShippedWorkspaceFiles(l.tpl, l.ws, l.manifest), []); } finally { fs.writeFileSync = realWrite; }
  assert.deepStrictEqual(fs.readdirSync(path.join(l.ws, 'maestro')), ['SETUP-INTERVIEW.md'], 'no temporary file left after a failed write');
  assert.strictEqual(fs.readFileSync(l.copy, 'utf8'), 'OLD GUIDE\n');

  l = layout('OLD GUIDE\n', [sha('OLD GUIDE\n')]);
  fs.writeFileSync(l.manifest, '{ not json');
  assert.deepStrictEqual(refreshShippedWorkspaceFiles(l.tpl, l.ws, l.manifest), [], 'a broken manifest changes nothing');
  fs.writeFileSync(l.manifest, JSON.stringify({ '../escape/SETUP-INTERVIEW.md': { previous: [sha('OLD GUIDE\n')] } }));
  assert.deepStrictEqual(refreshShippedWorkspaceFiles(l.tpl, l.ws, l.manifest), [], 'paths outside a workspace are ignored');
  // Templates and workspaces at different depths: there a "../" entry would really reach a file outside the workspaces.
  const root = tmp(), tpl = path.join(root, 't'), ws = path.join(root, 'w', 'x');
  fs.mkdirSync(tpl, { recursive: true }); fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(root, 'f.md'), 'NEW GUIDE\n'); fs.writeFileSync(path.join(root, 'w', 'f.md'), 'OLD GUIDE\n');
  const man = path.join(root, 'm.json'); fs.writeFileSync(man, JSON.stringify({ '../f.md': { previous: [sha('OLD GUIDE\n')] } }));
  assert.deepStrictEqual(refreshShippedWorkspaceFiles(tpl, ws, man), []);
  assert.strictEqual(fs.readFileSync(path.join(root, 'w', 'f.md'), 'utf8'), 'OLD GUIDE\n', 'nothing outside a workspace is written');
});

test('the shipped manifest matches the shipped guide: current is the template, earlier versions are listed', () => {
  const m = JSON.parse(read('templates/workspace-updates.json'));
  const e = m['maestro/SETUP-INTERVIEW.md'];
  const now = sha(fs.readFileSync(path.join(ROOT, 'templates/workspaces/maestro/SETUP-INTERVIEW.md')));
  assert.strictEqual(e.current, now, 'SETUP-INTERVIEW.md changed: move the old "current" into "previous" and set the new one');
  assert.ok(!e.previous.includes(now), 'the current version is not "previous"');
  assert.ok(e.previous.length >= 2 && e.previous.every(h => /^[0-9a-f]{64}$/.test(h)));
  for (const rel of Object.keys(m).filter(k => !k.startsWith('_'))) assert.ok(fs.existsSync(path.join(ROOT, 'templates/workspaces', rel)), rel);
});

test('the interview status comes from the first status line of the lead agent\'s Record', () => {
  const ws = tmp();
  const w = createWelcome({ dataDir: tmp(), workspacesDir: ws, env: {}, settings: {}, claudeAuth: {} });
  const put = (text) => { fs.mkdirSync(path.join(ws, 'maestro', 'records'), { recursive: true }); fs.writeFileSync(path.join(ws, 'maestro', 'records', 'setup-interview.md'), text); };
  assert.strictEqual(w.interviewStatus('maestro'), 'unknown', 'no Record: unknown');
  put('Status: in progress\nStep 1 done: Sam\nNext: Step 2\n');
  assert.strictEqual(w.interviewStatus('maestro'), 'in-progress');
  put('Status: complete\nStep 7 done\n');
  assert.strictEqual(w.interviewStatus('maestro'), 'complete');
  put('**Status:** Complete\n');
  assert.strictEqual(w.interviewStatus('maestro'), 'complete', 'markdown emphasis and case are fine');
  put('Status: complete\nStep 7 done\nStatus: in progress (an old line left below)\n');
  assert.strictEqual(w.interviewStatus('maestro'), 'complete', 'the first status line wins');
  put('# Setup interview\n- Step 1 status: complete\nnotes only\n');
  assert.strictEqual(w.interviewStatus('maestro'), 'unknown', 'a step note is not the status line');
  assert.strictEqual(w.interviewStatus('../maestro'), 'unknown', 'no path tricks');
  assert.strictEqual(w.interviewStatus(''), 'unknown');
});

test('the playbook keeps its place, resumes, and pauses (never ends) on an unanswered question', () => {
  const g = read('templates/workspaces/maestro/SETUP-INTERVIEW.md');
  assert.match(g, /## Keep your place/);
  assert.match(g, /Record named `setup-interview\.md`/);
  assert.match(g, /Its first line is `Status: in progress`, or `Status: complete` once Step 7 is done/);
  assert.match(g, /Update it after every answer and after every agent you build, before you ask the next question/);
  assert.match(g, /While the Record says `Status: in progress`, read it before you answer anything/);
  assert.match(g, /Read a short answer \(a name, a number, "yes"\) against the question just before it: it answers `Next:` when that question was the interview's\./);
  assert.match(g, /A saved `Next:` is never permission for an action by itself\./);
  assert.match(g, /ask, and if they mean the interview, continue from `Next:`\./);
  assert.match(g, /never recreate an agent that is already there/);
  assert.match(g, /If the Record says `Status: complete`, the interview is finished/);
  assert.match(g, /If ask_user comes back NO_ANSWER, they stepped away: the interview is paused, not over\./);
  assert.match(g, /set the first line of the `setup-interview\.md` Record to `Status: complete`/);
  assert.match(read('templates/workspaces/maestro/SOUL.md'), /or to continue the setup interview, run the setup interview/);
});

test('"You\'re all set" points back to an unfinished interview, and the phone line points to steps that exist', () => {
  const page = read('welcome.html');
  const done = page.slice(page.indexOf('<section id="s-done">'), page.indexOf('</section>', page.indexOf('<section id="s-done">')));
  assert.match(done, /<div class="resume-box" id="done-interview" hidden>/);
  assert.match(done, /<button class="primary" type="button" id="done-interview-go">Continue with <span class="lead-name">Maestro<\/span><\/button>/);
  assert.ok(!/Setup checklist → Phone access/.test(page), 'the Settings entry it named never existed');
  assert.match(done, /Use it from your phone: ask <span class="lead-name">Maestro<\/span> to set it up with you, or see <a href="\/help#phone">Help → The phone app<\/a>\./);
  assert.match(read('help.html'), /<h2 id="phone">/);
  assert.match(page, /if \(id === 's-done'\) paintDone\(\);/);
  assert.match(page, /\$\('done-interview'\)\.hidden = st === 'complete';/);
  assert.match(page, /location\.href = '\/\?agent=' \+ encodeURIComponent\(lead\.name\);/);
  const srv = read('server.js');
  const admin = srv.slice(srv.indexOf("if (pathname === '/api/welcome/state'"), srv.indexOf("if (pathname === '/api/welcome/finish'"));
  assert.match(admin, /if \(admin\) \{[\s\S]*out\.interview = lead \? welcome\.interviewStatus\(lead\.name\) : 'unknown';/, 'admins only');
  assert.match(srv, /require\('\.\/lib\/agents'\)\.refreshShippedWorkspaceFiles\(\);/);
});
