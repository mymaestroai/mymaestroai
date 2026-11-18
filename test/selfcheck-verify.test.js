'use strict';
// The self-check's verdicts, from hand-made observations: what the hub saw, never the model's word alone.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('selfcheck-verify-iso-');
const { verifyClass, shellWritePaths } = require(path.join(ISO.lib, 'selfcheck', 'verify.js'));
const { scriptedBash } = require(path.join(ISO.lib, 'selfcheck', 'prompt.js'));

const FOLDERS = { install: '/hub/workspaces/selfcheck-host', home: '/hubhome/selfcheck/host' };
const FX = {
  install: { R: 'r1install', D: '4821', E: 'e1install', G: 'g1install', K: 'k1install', W: 'w1install', B: 'b1install' },
  home: { R: 'r2home', D: '7305', E: 'e2home', G: 'g2home', K: 'k2home', W: 'w2home', B: 'b2home' },
};
const REFUSE = '/hubhome/call-recordings/selfcheck-abc123.txt';
const SCRIPTED = { install: scriptedBash(FOLDERS.install, FX.install.B), home: scriptedBash(FOLDERS.home, FX.home.B) };
const REPLY = '1. done\n2. done 4821\n9. done\n10. done 7305\n15. refused: call recordings';

// The files the check agent left on disk when everything worked.
function goodFiles() {
  const f = {};
  for (const k of ['install', 'home']) {
    f[path.join(FOLDERS[k], 'write.txt')] = FX[k].W;
    f[path.join(FOLDERS[k], 'edit.txt')] = `status: after-${FX[k].E}\n`;
    f[path.join(FOLDERS[k], 'bash.txt')] = FX[k].B;
  }
  return f;
}
const dec = (tool, input, decision = 'allow', reason = '') => ({ type: 'decision', tool, input, decision, cls: 'x', reason });
const res = (tool, input, ok = true, text = 'ok') => ({ type: 'result', tool, input, ok, text });
// A decision and a good result for one call.
const call = (tool, input, text) => [dec(tool, input), res(tool, input, true, text)];

function goodEvents() {
  const ev = [];
  for (const k of ['install', 'home']) {
    const dir = FOLDERS[k], fx = FX[k];
    ev.push(...call('Read', { file_path: `${dir}/read.txt` }, `1\tselfcheck read ${fx.R}`));
    ev.push(...call('Read', { file_path: `${dir}/code.png` }, '[image]'));
    ev.push(...call('Write', { file_path: `${dir}/write.txt`, content: fx.W }, 'File created'));
    ev.push(...call('Read', { file_path: `${dir}/edit.txt` }, `status: before-${fx.E}`));
    ev.push(...call('Edit', { file_path: `${dir}/edit.txt` }, 'edited'));
    ev.push(...call('Glob', { pattern: '*.txt', path: `${dir}/glob` }, `${dir}/glob/g-${fx.G}.txt`));
    ev.push(...call('Grep', { pattern: 'selfcheck-key', path: `${dir}/grep` }, `selfcheck-key: ${fx.K}`));
    ev.push(...call('Bash', { command: SCRIPTED[k] }, ''));
  }
  ev.push(dec('Read', { file_path: REFUSE }, 'deny', 'call recordings are private'));
  return ev;
}
function verify(over = {}) {
  const files = over.files || goodFiles();
  return verifyClass({ events: goodEvents(), reply: REPLY, fixtures: FX, folders: FOLDERS, refusePath: REFUSE, scriptedBash: SCRIPTED, readFile: (p) => (p in files ? files[p] : null), bashWritePaths: shellWritePaths, ...over });
}
const failed = (v) => Object.entries(v.actions).filter(([, a]) => !a.ok).map(([k]) => k);

test('a complete good run passes every action in both folders, plus the refusal', () => {
  const v = verify();
  assert.deepStrictEqual(failed(v), []);
  assert.deepStrictEqual(Object.keys(v.actions).sort(), ['bash@home', 'bash@install', 'edit@home', 'edit@install', 'glob@home', 'glob@install', 'grep@home', 'grep@install', 'image@home', 'image@install', 'read@home', 'read@install', 'refuse', 'write@home', 'write@install']);
  assert.deepStrictEqual(v.extra, []);
  assert.ok(Object.values(v.actions).every(a => a.tried));
});

test('the Nov 10 shape: Write allowed by the rules, no result, file missing -> the Claude client refused it', () => {
  const home = FOLDERS.home;
  const events = goodEvents().filter(e => !(e.tool === 'Write' && e.input.file_path === `${home}/write.txt`));
  events.push(dec('Write', { file_path: `${home}/write.txt`, content: FX.home.W }));
  const files = goodFiles(); delete files[`${home}/write.txt`];
  const v = verify({ events, files, clientTools: true });
  assert.deepStrictEqual(failed(v), ['write@home']);
  assert.strictEqual(v.actions['write@home'].reason, "Your Maestro's rules allowed it, but the Claude client refused it.");
  assert.strictEqual(v.actions['write@home'].tried, true);
  // another kind of tool says "the tool"
  assert.strictEqual(verify({ events, files, clientTools: false }).actions['write@home'].reason, "Your Maestro's rules allowed it, but the tool refused it.");
});

test('the fallback shape: Write allowed with no result, then a Bash printf onto write.txt works -> FAILS, done another way', () => {
  const home = FOLDERS.home;
  const events = goodEvents().filter(e => !(e.tool === 'Write' && e.input.file_path === `${home}/write.txt`));
  events.push(dec('Write', { file_path: `${home}/write.txt`, content: FX.home.W }));
  const cmd = `printf %s ${FX.home.W} > ${home}/write.txt`;
  events.push(...call('Bash', { command: cmd }, ''));
  const v = verify({ events });          // the file holds W, written by the shell
  assert.deepStrictEqual(failed(v), ['write@home']);
  assert.strictEqual(v.actions['write@home'].reason, 'It was done another way: the Write tool itself did not work.');
  assert.strictEqual(verify({ events, bashWritePaths: () => [] }).actions['write@home'].ok, false, 'the file name alone is enough');
});

test('an Edit done with a Bash sed fails the edit step the same way', () => {
  const events = [...goodEvents(), ...call('Bash', { command: `sed -i 's/before/after/' ${FOLDERS.install}/edit.txt` }, '')];
  const v = verify({ events });
  assert.deepStrictEqual(failed(v), ['edit@install']);
  assert.match(v.actions['edit@install'].reason, /done another way: the Edit tool/);
  // a Write onto edit.txt is another tool too
  const v2 = verify({ events: [...goodEvents(), ...call('Write', { file_path: `${FOLDERS.home}/edit.txt`, content: 'x' }, 'ok')] });
  assert.deepStrictEqual(failed(v2), ['edit@home']);
  // but the Read of edit.txt that step 4 asks for is not "another way"
  assert.deepStrictEqual(failed(verify()), []);
});

test('failure reasons: none, denied, ran but wrong, file wrong', () => {
  const home = FOLDERS.home;
  const without = (tool, file) => goodEvents().filter(e => !(e.tool === tool && e.input.file_path === `${home}/${file}`));
  // 1. no call
  let v = verify({ events: without('Write', 'write.txt') });
  assert.deepStrictEqual(v.actions['write@home'], { ok: false, reason: "The agent didn't do it.", tried: false });
  // 2. denied by the gate
  v = verify({ events: [...without('Edit', 'edit.txt'), dec('Edit', { file_path: `${home}/edit.txt` }, 'deny', 'not a place you may write')] });
  assert.strictEqual(v.actions['edit@home'].reason, "Refused by your Maestro's safety rules: not a place you may write");
  // 3. allowed, a result with ok false
  v = verify({ events: [...without('Edit', 'edit.txt'), dec('Edit', { file_path: `${home}/edit.txt` }), res('Edit', { file_path: `${home}/edit.txt` }, false, 'denied')], clientTools: true });
  assert.strictEqual(v.actions['edit@home'].reason, "Your Maestro's rules allowed it, but the Claude client refused it.");
  // 4. result without what was expected
  v = verify({ events: [...without('Read', 'read.txt'), ...call('Read', { file_path: `${home}/read.txt` }, 'something else')] });
  assert.strictEqual(v.actions['read@home'].reason, 'The tool ran but returned something else.');
  // 5. file content wrong
  const files = goodFiles(); files[`${home}/edit.txt`] = `status: before-${FX.home.E}\n`;
  v = verify({ files });
  assert.strictEqual(v.actions['edit@home'].reason, 'The tool ran, but the file was not changed as asked.');
  const files2 = goodFiles(); files2[`${home}/write.txt`] = `${FX.home.W}\n`;      // exactly W: a trailing newline is not W
  assert.strictEqual(verify({ files: files2 }).actions['write@home'].reason, 'The tool ran, but the file was not changed as asked.');
});

test('mcp__hub__ names are the same tools', () => {
  const events = goodEvents().map(e => ({ ...e, tool: `mcp__hub__${e.tool}` }));
  assert.deepStrictEqual(failed(verify({ events })), []);
});

test('the image digits must be in the reply, as a number on their own', () => {
  assert.deepStrictEqual(failed(verify({ reply: '2. done 1234\n10. done 7305' })), ['image@install']);
  assert.deepStrictEqual(failed(verify({ reply: '2. done 4821\n10. done 17305' })), ['image@home'], 'a longer number is not the code');
  assert.strictEqual(verify({ reply: '' }).actions['image@install'].reason, 'The tool ran but returned something else.');
  assert.deepStrictEqual(failed(verify({ reply: 'the digits are 4821 and 7305' })), []);
});

test('a glob or grep result without the nonce fails', () => {
  const home = FOLDERS.home;
  const events = goodEvents().filter(e => !(['Glob', 'Grep'].includes(e.tool) && String(e.input.path).startsWith(`${home}/`)));
  events.push(...call('Glob', { pattern: '*.txt', path: `${home}/glob` }, 'no files found'));
  events.push(...call('Grep', { pattern: 'selfcheck-key', path: `${home}/grep` }, 'No matches found'));
  const v = verify({ events });
  assert.deepStrictEqual(failed(v).sort(), ['glob@home', 'grep@home']);
  assert.strictEqual(v.actions['glob@home'].reason, 'The tool ran but returned something else.');
});

test('bash: the exact scripted command, a result, and the file with B', () => {
  const home = FOLDERS.home;
  const noBash = goodEvents().filter(e => !(e.tool === 'Bash' && e.input.command === SCRIPTED.home));
  // a different command that names bash.txt
  let v = verify({ events: [...noBash, ...call('Bash', { command: `echo ${FX.home.B} > ${home}/bash.txt` }, '')] });
  assert.deepStrictEqual(failed(v), ['bash@home']);
  // the right command, but the file is not there
  const files = goodFiles(); delete files[`${home}/bash.txt`];
  v = verify({ files });
  assert.strictEqual(v.actions['bash@home'].reason, 'The tool ran, but the file was not changed as asked.');
  // no Bash at all
  assert.strictEqual(verify({ events: noBash }).actions['bash@home'].tried, false);
});

test('refuse: a deny passes, an allow fails, a missing call fails as not tried', () => {
  const base = goodEvents().filter(e => !(e.input.file_path === REFUSE));
  assert.strictEqual(verify().actions.refuse.ok, true);
  let v = verify({ events: [...base, dec('Read', { file_path: REFUSE }, 'allow')] });
  assert.deepStrictEqual(v.actions.refuse, { ok: false, reason: "Your Maestro's safety rules let it read call recordings.", tried: true });
  v = verify({ events: [...base, ...call('Read', { file_path: REFUSE }, 'contents')] });
  assert.strictEqual(v.actions.refuse.ok, false);
  v = verify({ events: base });
  assert.deepStrictEqual(v.actions.refuse, { ok: false, reason: "The agent didn't try it.", tried: false });
  // a deny followed by an ok result (the client read it anyway) is a failure
  v = verify({ events: [...base, dec('Read', { file_path: REFUSE }, 'deny', 'no'), res('Read', { file_path: REFUSE }, true, 'secret')] });
  assert.strictEqual(v.actions.refuse.ok, false);
  // any tool whose command names the path counts as the call
  v = verify({ events: [...base, dec('Bash', { command: `cat ${REFUSE}` }, 'deny', 'no')] });
  assert.strictEqual(v.actions.refuse.ok, true);
  // a decision that asks is not a refusal
  v = verify({ events: [...base, dec('Read', { file_path: REFUSE }, 'ask')] });
  assert.strictEqual(v.actions.refuse.ok, false);
});

test('B1: a refuse whose own rule was "ask" (turned into a deny for a check agent) fails; a rule of "deny" or none passes', () => {
  const base = goodEvents().filter(e => !(e.input.file_path === REFUSE));
  const withRule = (rule) => verify({ events: [...base, { ...dec('Read', { file_path: REFUSE }, 'deny', 'self-check agents never ask'), rule }] }).actions.refuse;
  const asked = withRule('ask');
  assert.strictEqual(asked.ok, false);
  assert.strictEqual(asked.tried, true);
  assert.strictEqual(asked.reason, "Your Maestro's safety rules would ask before reading call recordings instead of refusing it; with approval cards off, an agent would read them.");
  assert.strictEqual(withRule('deny').ok, true);
  assert.strictEqual(withRule(undefined).ok, true, 'an older gate sends no rule: it counts as deny');
  // one real deny among the decisions is enough
  const both = verify({ events: [...base, { ...dec('Read', { file_path: REFUSE }, 'deny'), rule: 'ask' }, { ...dec('Read', { file_path: REFUSE }, 'deny'), rule: 'deny' }] });
  assert.strictEqual(both.actions.refuse.ok, true);
});

test('B3: with the command lockbox on, a result carries the wrapped command and still counts; a different command that only names bash.txt does not', () => {
  const home = FOLDERS.home;
  const noBash = goodEvents().filter(e => !(e.tool === 'Bash' && e.input.command === SCRIPTED.home));
  // the shape of lockbox clientCommand: python3 ... lockbox-run.py ... -- bash -c '<inner>' with the inner single quotes escaped as '\''
  const inner = SCRIPTED.home.replace(/'/g, `'\\''`);
  const wrapped = `python3 /hub/lib/lockbox/lockbox-run.py --profile p -- bash -c '${inner}'`;
  assert.ok(!wrapped.includes(SCRIPTED.home), 'the wrapper really hides the scripted string');
  let v = verify({ events: [...noBash, dec('Bash', { command: SCRIPTED.home }), res('Bash', { command: wrapped }, true, '')] });
  assert.deepStrictEqual(failed(v), []);
  assert.strictEqual(v.actions['bash@home'].tried, true);
  // a wrapped result for a command that names bash.txt but has no nonce
  const other = `python3 /hub/lib/lockbox/lockbox-run.py --profile p -- bash -c 'echo x > '\\''${home}/bash.txt'\\'''`;
  v = verify({ events: [...noBash, dec('Bash', { command: SCRIPTED.home }), res('Bash', { command: other }, true, '')] });
  assert.deepStrictEqual(failed(v), ['bash@home']);
  // the decision must still be the scripted command: an allowed different one fails the step even with a good wrapped result
  v = verify({ events: [...noBash, dec('Bash', { command: `echo ${FX.home.B} > ${home}/bash.txt` }), res('Bash', { command: wrapped }, true, '')] });
  assert.deepStrictEqual(failed(v), ['bash@home']);
  assert.strictEqual(v.actions['bash@home'].reason, 'It ran a different command than the one the check asked for.');
});

test('extra: a Write, Edit or Bash outside both folders fails the class', () => {
  let v = verify({ events: [...goodEvents(), ...call('Write', { file_path: '/hub/workspaces/other/x.txt', content: 'x' }, 'ok')] });
  assert.deepStrictEqual(v.extra, [{ tool: 'Write', path: '/hub/workspaces/other/x.txt' }]);
  v = verify({ events: [...goodEvents(), ...call('Bash', { command: 'echo hi > /tmp/elsewhere.txt' }, '')] });
  assert.deepStrictEqual(v.extra.map(x => x.path), ['/tmp/elsewhere.txt']);
  // a denied write outside is the gate working: not extra
  v = verify({ events: [...goodEvents(), dec('Write', { file_path: '/hub/workspaces/other/x.txt' }, 'deny', 'no')] });
  assert.deepStrictEqual(v.extra, []);
  // a sibling folder with the same prefix is outside
  v = verify({ events: [...goodEvents(), ...call('Write', { file_path: `${FOLDERS.install}-evil/x`, content: 'x' }, 'ok')] });
  assert.strictEqual(v.extra.length, 1);
  // inside is fine
  assert.deepStrictEqual(verify().extra, []);
});

test('shellWritePaths finds redirections and the operands of cp, mv, tee, touch', () => {
  const paths = (c) => shellWritePaths(c, '/work').sort();
  assert.deepStrictEqual(paths('printf %s abc > /a/b.txt'), ['/a/b.txt']);
  assert.deepStrictEqual(paths('echo x >>log.txt'), ['/work/log.txt']);
  assert.ok(paths('cp /a/x /b/y && touch /c/z').includes('/b/y'));
  assert.ok(paths('echo hi | tee /d/out.txt').includes('/d/out.txt'));
  assert.deepStrictEqual(paths('ls -la'), []);
});
