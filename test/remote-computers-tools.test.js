'use strict';
// Remote computers, the tools: the gate (levels, sessions, the owner's approval), the PowerShell scripts for Windows, and the agent tools
// with a stand-in MeshCentral client. Nothing here talks to a computer: scripts are only built and read back.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGate, GateError } = require('../modules/remote-computers/lib/gate');
const win = require('../modules/remote-computers/lib/windows');
const { createShotStore, folderOf } = require('../modules/remote-computers/lib/shots');
const { MeshError } = require('../modules/remote-computers/lib/meshclient');
const { createRemote, TOOLS, APPROVE_HUB_TIMEOUT_MS } = require('../modules/remote-computers/server');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rc-tools-'));
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const decodeLine = (line) => {
  const m = /^iex \(\[Text\.Encoding\]::Unicode\.GetString\(\[Convert\]::FromBase64String\('([A-Za-z0-9+/=]+)'\)\)\)$/.exec(line);
  assert.ok(m, 'a single iex ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String(...))) line');
  assert.ok(line.length <= 60000 && !/[\r\n]/.test(line));
  return Buffer.from(m[1], 'base64').toString('utf16le');
};
const rejects = async (p, code, re) => {
  try { await p; } catch (e) {
    if (code) assert.strictEqual(e.code, code, e.message);
    if (re) assert.match(e.message, re);
    return e;
  }
  assert.fail('should have been refused');
  return null;
};

// ── the gate ─────────────────────────────────────────────────────────────────────────────────────
function newGate(over = {}) {
  let t = 5000000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const asked = [], toasts = [], logs = [];
  const real = createGate({
    levels: ['sam:act', 'pat:drive', 'lee:look'], sessionMinutes: 30, now: clock.now, log: (...a) => logs.push(a.join(' ')),
    approve: async (q) => { asked.push(q); return 'allow'; },
    toast: async (id, title, msg) => { toasts.push({ id, title, msg }); },
    ...over,
  });
  // Unless a test says otherwise, a call carries the hub's call id.
  const gate = { ...real, require: (agent, need, computer, opts) => real.require(agent, need, computer, opts === undefined ? { call: 'call-1' } : opts) };
  return { gate, raw: real, clock, asked, toasts, logs };
}
const PC = { id: 'pc1', name: 'demo-pc' };

test('gate: levels, unlisted agents get look, a missing agent is refused (EIDENT)', async () => {
  const { gate, asked } = newGate();
  assert.strictEqual(gate.levelOf('sam'), 'act');
  assert.strictEqual(gate.levelOf('pat'), 'drive');
  assert.strictEqual(gate.levelOf('stranger'), 'look');
  await gate.require('stranger', 'look', PC);
  await gate.require('stranger', 'look');
  assert.strictEqual(asked.length, 0, 'look never asks');
  for (const bad of ['', '   ', undefined, null, 42]) {
    await rejects(gate.require(bad, 'look'), 'EIDENT');
    await rejects(gate.require(bad, 'act', PC), 'EIDENT');
  }
  // When an agent is listed twice the lower level counts.
  const twice = createGate({ levels: ['x:drive', 'x:look', 'junk', 'y:fly'], approve: async () => 'allow' });
  assert.strictEqual(twice.levelOf('x'), 'look');
  assert.strictEqual(twice.levelOf('y'), 'look');
});

test('gate: a level that is too low is refused with ELEVEL and the owner is not asked', async () => {
  const { gate, asked } = newGate();
  const e = await rejects(gate.require('stranger', 'act', PC), 'ELEVEL', /Data connectors -> Remote computers -> Status and limits/);
  assert.match(e.message, /stranger/);
  assert.match(e.message, /look/);
  await rejects(gate.require('lee', 'drive', PC), 'ELEVEL');
  const d = await rejects(gate.require('sam', 'drive', PC), 'ELEVEL');
  assert.match(d.message, /sam/);
  assert.match(d.message, /run commands/);
  assert.strictEqual(asked.length, 0);
  assert.ok(new GateError('x', 'EX') instanceof Error);
});

test('gate: the owner is asked once per session with the agreed wording, then a toast shows on the computer', async () => {
  const { gate, asked, toasts, clock } = newGate();
  await gate.require('sam', 'act', { id: 'pc1', name: 'demo-pc' });
  assert.deepStrictEqual(asked, [{
    call: 'call-1', title: 'sam wants to use demo-pc (pc1)', minutes: 4,
    detail: 'For 30 minutes sam may run commands as the system account (full control) on demo-pc (pc1). Every action is logged. Say no if you did not expect this.',
  }]);
  assert.ok(!('agent' in asked[0]), 'the hub knows the agent from the call id');
  assert.deepStrictEqual(toasts, [{ id: 'pc1', title: 'My Maestro', msg: 'sam is using this computer for the next 30 minutes.' }]);
  await gate.require('sam', 'act', PC);
  assert.strictEqual(asked.length, 1, 'the session covers the next one');
  assert.deepStrictEqual(gate.sessions(), [{ agent: 'sam', computer: { id: 'pc1', name: 'demo-pc' }, level: 'act', expiresAt: clock.now() + 30 * 60000 }]);   // scopes are internal
  // Another computer is another session.
  await gate.require('sam', 'act', { id: 'pc2', name: 'laptop' });
  assert.strictEqual(asked.length, 2);
  // A long title is capped at 80.
  await gate.require('pat', 'act', { id: 'pc3', name: 'n'.repeat(200) });
  assert.ok(asked[2].title.length <= 80);
});

test('gate: the question carries the call id it was asked for, and without one the owner is not asked (EIDENT)', async () => {
  const { gate, asked } = newGate();
  await gate.require('sam', 'act', PC, { call: 'c-77' });
  assert.strictEqual(asked[0].call, 'c-77');
  assert.strictEqual(asked[0].minutes, 4);
  const fresh = newGate();
  for (const opts of [{}, { call: '' }, { call: '   ' }, { call: 5 }, null]) await rejects(fresh.raw.require('sam', 'act', PC, opts), 'EIDENT', /did not say which call/);
  await rejects(fresh.raw.require('sam', 'act', PC), 'EIDENT');
  assert.strictEqual(fresh.asked.length, 0);
  await fresh.raw.require('sam', 'look', PC);   // look needs no call
  // A live session needs no call either.
  await fresh.raw.require('sam', 'act', PC, { call: 'c-1' });
  await fresh.raw.require('sam', 'act', PC);
  assert.strictEqual(fresh.asked.length, 1);
});

test('gate: concurrent requires for one agent and computer share ONE question', async () => {
  const d = deferred();
  let calls = 0;
  const { gate, toasts } = newGate({ approve: async () => { calls++; return d.promise; } });
  const all = [gate.require('sam', 'act', PC), gate.require('sam', 'act', PC), gate.require('sam', 'act', PC)];
  await flush();
  assert.strictEqual(calls, 1);
  d.resolve('allow');
  await Promise.all(all);
  assert.strictEqual(calls, 1);
  assert.strictEqual(toasts.length, 1);
  // Shared refusals reach everyone who waited.
  const d2 = deferred();
  const g2 = newGate({ approve: async () => d2.promise }).gate;
  const two = [g2.require('sam', 'act', PC), g2.require('sam', 'act', PC)];
  await flush();
  d2.resolve('timeout');
  const r = await Promise.allSettled(two);
  assert.deepStrictEqual(r.map((x) => x.reason && x.reason.code), ['ETIMEOUT', 'ETIMEOUT']);
});

test('gate: a no is EDENIED and the owner is not asked again for 2 minutes; a timeout is ETIMEOUT and does not block', async () => {
  let answer = 'deny';
  const { gate, clock, asked } = newGate({ approve: async (q) => { asked.push(q); return answer; } });
  await rejects(gate.require('sam', 'act', PC), 'EDENIED', /said no/);
  assert.strictEqual(asked.length, 1);
  const again = await rejects(gate.require('sam', 'act', PC), 'EDENIED', /a moment ago/);
  assert.ok(again);
  assert.strictEqual(asked.length, 1, 'no new question');
  await gate.require('sam', 'look', PC);
  clock.advance(2 * 60000 - 1);
  await rejects(gate.require('sam', 'act', PC), 'EDENIED', /a moment ago/);
  clock.advance(2);
  answer = 'timeout';
  await rejects(gate.require('sam', 'act', PC), 'ETIMEOUT');
  assert.strictEqual(asked.length, 2);
  await rejects(gate.require('sam', 'act', PC), 'ETIMEOUT');
  assert.strictEqual(asked.length, 3, 'a timeout is asked again');
  // The cool-down is per agent and computer.
  answer = 'allow';
  await gate.require('pat', 'act', PC);
});

test('gate: approval scopes by account: act-system covers a user run, drive covers a user run only, a user run covers neither', async () => {
  const { gate, raw, asked } = newGate();
  // act as the system covers a run as the user; the reverse asks again, with the system wording.
  await gate.require('pat', 'act', PC, { call: 'c', as: 'system' });
  await gate.require('pat', 'act', PC, { call: 'c', as: 'user' });
  assert.strictEqual(asked.length, 1);
  assert.match(asked[0].detail, /may run commands as the system account \(full control\) on demo-pc \(pc1\)\./);
  assert.strictEqual(raw.stillValid('pat', 'pc1', 'act', 'user'), true);
  assert.strictEqual(raw.stillValid('pat', 'pc1', 'act'), true);
  assert.strictEqual(raw.stillValid('pat', 'pc1', 'drive'), false);
  await gate.require('pat', 'drive', PC);
  assert.strictEqual(asked.length, 2);
  assert.match(asked[1].detail, /may use the mouse and keyboard on demo-pc \(pc1\)\./);
  // The drive approval is added to the session: the system approval stays.
  await gate.require('pat', 'act', PC, { call: 'c', as: 'system' });
  await gate.require('pat', 'drive', PC);
  assert.strictEqual(asked.length, 2);
  assert.strictEqual(gate.sessions().length, 1);
  assert.strictEqual(gate.sessions()[0].level, 'drive');
  // A user run alone: no system run (asks again with the system wording), no drive.
  const u = newGate();
  await u.gate.require('sam', 'act', PC, { call: 'c', as: 'user' });
  assert.match(u.asked[0].detail, /may run commands as the signed-in user on/);
  await u.gate.require('sam', 'act', PC, { call: 'c', as: 'user' });
  assert.strictEqual(u.asked.length, 1);
  assert.strictEqual(u.raw.stillValid('sam', 'pc1', 'act', 'user'), true);
  assert.strictEqual(u.raw.stillValid('sam', 'pc1', 'act', 'system'), false);
  await u.gate.require('sam', 'act', PC, { call: 'c', as: 'system' });
  assert.strictEqual(u.asked.length, 2);
  assert.match(u.asked[1].detail, /may run commands as the system account \(full control\)/);
  // A drive approval covers a run as the user, never a run as the system.
  const dr = newGate();
  await dr.gate.require('pat', 'drive', PC);
  await dr.gate.require('pat', 'act', PC, { call: 'c', as: 'user' });
  assert.strictEqual(dr.asked.length, 1);
  assert.strictEqual(dr.raw.stillValid('pat', 'pc1', 'act', 'system'), false);
  await dr.gate.require('pat', 'act', PC, { call: 'c', as: 'system' });
  assert.strictEqual(dr.asked.length, 2);
  assert.match(dr.asked[1].detail, /as the system account/);
  // A drive question in flight is shared with an act request; an act question in flight is waited out by a drive request.
  const d = deferred();
  let n = 0;
  const g = newGate({ approve: async () => { n++; return n === 1 ? d.promise : 'allow'; } }).gate;
  const a = g.require('pat', 'act', { id: 'pc9', name: 'x' });
  await flush();
  const b = g.require('pat', 'drive', { id: 'pc9', name: 'x' });
  await flush();
  assert.strictEqual(n, 1);
  d.resolve('allow');
  await Promise.all([a, b]);
  assert.strictEqual(n, 2);
});

test('gate: the approval card says what the agent can do (system, signed-in user, mouse and keyboard) and shows the computer as name (first 6 of its id)', async () => {
  const { gate, asked } = newGate();
  const long = { id: 'Abcdefghijkl0123456789', name: 'office-pc' };
  await gate.require('sam', 'act', long, { call: 'c1', as: 'system' });
  await gate.require('sam', 'act', { ...long, id: 'Zzzzzz1234' }, { call: 'c2', as: 'user' });
  await gate.require('pat', 'drive', { ...long, id: 'Yyyyyy5678' }, { call: 'c3' });
  await gate.require('sam', 'act', { ...long, id: 'Xxxxxx9999' }, { call: 'c4' });   // as defaults to the system account, the wider one
  assert.deepStrictEqual(asked.map((q) => q.title), ['sam wants to use office-pc (Abcdef)', 'sam wants to use office-pc (Zzzzzz)', 'pat wants to use office-pc (Yyyyyy)', 'sam wants to use office-pc (Xxxxxx)']);
  assert.match(asked[0].detail, /^For 30 minutes sam may run commands as the system account \(full control\) on office-pc \(Abcdef\)\. Every action/);
  assert.match(asked[1].detail, /^For 30 minutes sam may run commands as the signed-in user on office-pc \(Zzzzzz\)\./);
  assert.match(asked[2].detail, /^For 30 minutes pat may use the mouse and keyboard on office-pc \(Yyyyyy\)\./);
  assert.match(asked[3].detail, /as the system account \(full control\)/);
  assert.ok(asked.every((q) => q.title.length <= 80));
});

test('gate: stillValid is true only while the agent\'s approved session for that computer is live and covers the level', async () => {
  const { gate, raw, clock } = newGate();
  assert.strictEqual(raw.stillValid('sam', 'pc1', 'look'), true);
  assert.strictEqual(raw.stillValid('sam', 'pc1', 'act'), false, 'no session yet');
  await gate.require('sam', 'act', PC);
  assert.strictEqual(raw.stillValid('sam', 'pc1', 'act'), true);
  assert.strictEqual(raw.stillValid('sam', 'pc1', 'drive'), false, 'act does not cover drive');
  assert.strictEqual(raw.stillValid('sam', 'pc2', 'act'), false, 'another computer');
  assert.strictEqual(raw.stillValid('pat', 'pc1', 'act'), false, 'another agent');
  assert.strictEqual(raw.stillValid('', 'pc1', 'act'), false);
  clock.advance(30 * 60000 + 1);
  assert.strictEqual(raw.stillValid('sam', 'pc1', 'act'), false, 'expired');
  await gate.require('sam', 'act', PC);
  raw.end('sam', 'pc1');
  assert.strictEqual(raw.stillValid('sam', 'pc1', 'act'), false, 'ended');
});

test('gate: a session ends after its minutes (injected clock), and end() ends it at once', async () => {
  const { gate, clock, asked, toasts } = newGate();
  await gate.require('sam', 'act', PC);
  clock.advance(30 * 60000 - 1);
  await gate.require('sam', 'act', PC);
  assert.strictEqual(asked.length, 1);
  clock.advance(2);
  assert.deepStrictEqual(gate.sessions(), []);
  await gate.require('sam', 'act', PC);
  assert.strictEqual(asked.length, 2);
  assert.strictEqual(toasts.length, 2);
  assert.strictEqual(gate.sessions().length, 1);
  gate.end('sam', 'pc1');
  assert.deepStrictEqual(gate.sessions(), []);
  await gate.require('sam', 'act', PC);
  assert.strictEqual(asked.length, 3);
});

test('gate: a toast that fails is logged and never stops the work; a question that cannot be asked is EAPPROVE', async () => {
  const { gate, logs } = newGate({ toast: async () => { throw new Error('mesh is down'); } });
  await gate.require('sam', 'act', PC);
  assert.ok(logs.some((l) => /toast failed/.test(l)));
  await gate.require('sam', 'act', PC);
  const g2 = newGate({ approve: async () => { throw new Error('hub gone'); } }).gate;
  const e = await rejects(g2.require('sam', 'act', PC), 'EAPPROVE');
  assert.doesNotMatch(e.message, /hub gone/);
  const g3 = newGate({ approve: async () => 'maybe' }).gate;
  await rejects(g3.require('sam', 'act', PC), 'EAPPROVE');
});

// ── windows.js ───────────────────────────────────────────────────────────────────────────────────
test('windows: encodePs makes ONE iex line (runcommands type 2) that decodes to the script, and refuses a line over 60000 characters', () => {
  const script = 'Write-Output "h\u00e9llo \u2603"';
  const line = win.encodePs(script);
  assert.ok(line.startsWith('iex ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String(\''));
  assert.ok(line.endsWith('\')))'));
  assert.doesNotMatch(line, /[\r\n]/);
  assert.doesNotMatch(line, /powershell\.exe|EncodedCommand/, 'no second process and no command-line option');
  assert.strictEqual(decodeLine(line), script);
  assert.strictEqual(win.MAX_LINE, 60000);
  // 60000 characters of line: the base64 of the UTF-16LE script is 8/3 characters per script character, plus the 70 of the wrapper.
  const fits = 'x'.repeat(22400), tooLong = 'x'.repeat(22500);
  assert.ok(win.encodePs(fits).length <= 60000);
  const e = assert.throws(() => win.encodePs(tooLong), (err) => err.code === 'ETOOLONG');
  assert.strictEqual(e, undefined);
  assert.throws(() => win.encodePs(''), win.WindowsError);
  assert.doesNotThrow(() => win.encodePs('a'.repeat(9000)));
});

test('windows: the longest text the type tool takes (2000 characters) and the longest run command (8000) fit on the line, with room to spare (measured)', () => {
  const typed = win.encodePs(win.typeScript({ text: 'a'.repeat(2000) }));
  const typedNl = win.encodePs(win.typeScript({ text: 'line\n'.repeat(400) }));
  const typedWide = win.encodePs(win.typeScript({ text: '\u2603'.repeat(2000) }));
  const run = win.encodePs('$ProgressPreference = \'SilentlyContinue\'\n[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n' + '\u2603'.repeat(8000));
  for (const [name, line] of Object.entries({ typed, typedNl, typedWide, run })) {
    assert.ok(line.length < 60000, `${name}: ${line.length}`);
    assert.doesNotMatch(line, /[\r\n]/);
  }
  assert.ok(typed.length < 30000, `type of 2000 characters is ${typed.length} characters on the line`);
  assert.ok(run.length < 30000, `run of 8000 characters is ${run.length} characters on the line`);
  // The old cmd.exe route would have broken the 8191-character limit with the same type text.
  assert.ok(typed.length > 8191);
});

test('windows: every script ends with MMOK and is built from a short fixed text', () => {
  const scripts = [win.clickScript({ x: 10, y: 20, screenWidth: 1920, screenHeight: 1080 }), win.typeScript({ text: 'hi' }), win.keyScript({ keys: 'ctrl+c' }), win.scrollScript({ amount: 3 })];
  for (const s of scripts) {
    assert.match(s, /\nWrite-Output 'MMOK'$/);
    assert.ok(win.encodePs(s).length < 30000);
    assert.match(s, /\$ErrorActionPreference = 'Stop'/);
  }
  assert.ok(win.sawOk('Microsoft Windows\r\nC:\\>x\r\nMMOK\r\nC:\\>exit\r\n'));
  assert.ok(win.sawOk('MMOK'));
  assert.ok(win.sawOk('PS C:\\Windows\\system32> MMOK\r\nPS C:\\Windows\\system32> exit\r\n'), 'PowerShell\'s own prompt in front of the line');
  assert.ok(win.sawOk('PS C:\\>MMOK\n'));
  assert.ok(!win.sawOk('PS C:\\> echo MMOK'));
  assert.ok(!win.sawOk('C:\\>echo MMOK'));
  assert.ok(!win.sawOk('error'));
});

test('windows: the screenshot script takes the primary screen with DPI awareness, scales, and prints one MMSHOT line', () => {
  const s = win.screenshotScript({});
  for (const part of ['SetProcessDPIAware', 'user32.dll', 'PrimaryScreen.Bounds', 'CopyFromScreen', 'image/jpeg', 'MMSHOT']) assert.ok(s.includes(part), part);
  assert.match(s, /\$nw -gt 1600/);
  assert.match(s, /\[long\]70/);
  const small = win.screenshotScript({ maxWidth: 800, quality: 55 });
  assert.match(small, /\$nw -gt 800/);
  assert.match(small, /\[long\]55/);
  for (const bad of [{ maxWidth: 100 }, { maxWidth: 5000 }, { maxWidth: 800.5 }, { maxWidth: '800' }, { quality: 0 }, { quality: '70; calc' }]) assert.throws(() => win.screenshotScript(bad), win.WindowsError);
  win.encodePs(s);
});

test('windows: parseScreenshot reads a good line (even around a cmd banner or a broken line) and throws with the start of anything else', () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('pretend picture bytes')]);
  const b64 = jpeg.toString('base64');
  const good = win.parseScreenshot(`MMSHOT 1600 900 1920 1080 ${b64}\r\n`);
  assert.deepStrictEqual({ w: good.width, h: good.height, sw: good.screenWidth, sh: good.screenHeight }, { w: 1600, h: 900, sw: 1920, sh: 1080 });
  assert.ok(Buffer.isBuffer(good.jpeg) && good.jpeg.equals(jpeg));
  const wrapped = win.parseScreenshot(`Microsoft Windows [Version 10.0]\r\n\r\nC:\\Windows>powershell ...\r\nMMSHOT 800 450 1920 1080 ${b64.slice(0, 10)}\r\n${b64.slice(10)} MMEND\r\nC:\\Windows>exit\r\n`);
  assert.ok(wrapped.jpeg.equals(jpeg));
  assert.strictEqual(wrapped.width, 800);
  const noise = 'x'.repeat(1000);
  const e1 = assert.throws(() => win.parseScreenshot(noise), (err) => err instanceof win.WindowsError);
  assert.strictEqual(e1, undefined);
  try { win.parseScreenshot(noise); } catch (e) { assert.ok(e.message.includes('x'.repeat(300))); assert.ok(!e.message.includes('x'.repeat(301))); }
  const ps = win.parseScreenshot(`PS C:\\Windows\\system32> MMSHOT 640 360 1920 1080 ${b64} MMEND\r\nPS C:\\Windows\\system32> exit\r\n`);
  assert.ok(ps.jpeg.equals(jpeg) && ps.width === 640, 'PowerShell\'s prompt in front of the MMSHOT line');
  assert.throws(() => win.parseScreenshot('MMSHOT 1 2 3 4 !!!!'), win.WindowsError);
  assert.throws(() => win.parseScreenshot(`MMSHOT 1 2 3 4 ${Buffer.from('not a jpeg at all').toString('base64')}`), win.WindowsError);
  assert.throws(() => win.parseScreenshot(''), win.WindowsError);
  assert.throws(() => win.parseScreenshot(null), win.WindowsError);
});

test('windows: typed text travels only as base64 (UTF-16LE); nothing of it appears in the script or the command line', () => {
  const nasty = 'He said "hi" & \'bye\'; $env:USERNAME `n $(calc) | whoami > x\r\nline2\t\u2603\ud83d\ude00 %PATH% ^& \\';
  const s = win.typeScript({ text: nasty });
  const norm = nasty.replace(/\r\n?/g, '\n');
  const b64 = Buffer.from(norm, 'utf16le').toString('base64');
  assert.ok(s.includes(`FromBase64String('${b64}')`));
  for (const frag of ['whoami', 'calc', 'USERNAME', 'He said', 'bye', 'line2', '%PATH%']) assert.ok(!s.includes(frag), `raw ${frag} in script`);
  const line = win.encodePs(s);
  for (const frag of ['whoami', 'calc', 'He said']) assert.ok(!line.includes(frag));
  assert.strictEqual(decodeLine(line), s);
  // The text decodes back to what was asked, with new lines as \n.
  const back = Buffer.from(/FromBase64String\('([^']+)'\)/.exec(decodeLine(line))[1], 'base64').toString('utf16le');
  assert.strictEqual(back, norm);
  // Every line of the script is fixed text (no caller text) except the one base64 line.
  const variable = s.split('\n').filter((l) => l.includes(b64));
  assert.strictEqual(variable.length, 1);
  assert.match(s, /\[MMIn\]::Key\(13, 0\)/, 'a new line is Enter');
  // Limits.
  assert.doesNotThrow(() => win.typeScript({ text: 'a'.repeat(2000) }));
  assert.throws(() => win.typeScript({ text: 'a'.repeat(2001) }), win.WindowsError);
  assert.throws(() => win.typeScript({ text: '' }), win.WindowsError);
  assert.throws(() => win.typeScript({ text: 5 }), win.WindowsError);
  assert.throws(() => win.typeScript({}), win.WindowsError);
});

test('windows: keys come from an allow-list; presses go modifiers first and release in reverse; unknown names are refused', () => {
  const seq = win.parseKeys('ctrl+shift+esc');
  assert.deepStrictEqual(seq, [[0x11, 0], [0x10, 0], [0x1b, 0]]);
  const s = win.keyScript({ keys: 'Ctrl+C' });
  const downs = [...s.matchAll(/\[MMIn\]::Key\((\d+), (\d+)\)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.deepStrictEqual(downs, [[0x11, 0], [0x43, 0], [0x43, 2], [0x11, 2]]);
  assert.deepStrictEqual(win.parseKeys('win+r'), [[0x5b, 1], [0x52, 0]]);
  assert.deepStrictEqual(win.parseKeys('alt+tab'), [[0x12, 0], [0x09, 0]]);
  assert.deepStrictEqual(win.parseKeys('f5'), [[0x74, 0]]);
  assert.deepStrictEqual(win.parseKeys('pagedown'), [[0x22, 1]]);
  assert.deepStrictEqual(win.parseKeys('enter'), [[0x0d, 0]]);
  assert.deepStrictEqual(win.parseKeys('7'), [[0x37, 0]]);
  assert.deepStrictEqual(win.parseKeys('z'), [[0x5a, 0]]);
  assert.deepStrictEqual(win.parseKeys('win'), [[0x5b, 1]]);
  for (const bad of ['', ' ', 'ctrl+', '+', 'ctrl+foo', 'foo', 'powershell', 'a;b', 'ctrl+$(calc)', 'ctrl+ctrl+c', 'ctrl+alt+shift+win+ctrl+c', 'f13', 'ab', '!', 'ctrl+c; calc', 'x'.repeat(100), 5, undefined, null]) {
    assert.throws(() => win.keyScript({ keys: bad }), win.WindowsError, String(bad));
  }
  // The only things in a key script are numbers.
  const lines = s.split('\n').filter((l) => l.startsWith('[MMIn]::Key'));
  for (const l of lines) assert.match(l, /^\[MMIn\]::Key\(\d+, \d\)$/);
  win.encodePs(s);
});

test('windows: click and scroll only take whole numbers and fixed words', () => {
  const S = { screenWidth: 1920, screenHeight: 1080 };
  const c = win.clickScript({ x: 960, y: 540, ...S });
  assert.match(c, /\$mmx = 960; \$mmy = 540/);
  assert.match(c, /SetCursorPos/);
  assert.match(c, /Mouse\(2, 0\); \[MMIn\]::Pause\(30\); \[MMIn\]::Mouse\(4, 0\)/);
  // The live primary screen has to be the size of the screenshot, or the script throws before it moves the mouse.
  assert.match(c, /if \(\$mmb\.Width -ne 1920 -or \$mmb\.Height -ne 1080\) \{ throw "The screen changed since that screenshot; take a new one\." \}/);
  assert.ok(c.indexOf('The screen changed') < c.indexOf('SetCursorPos($mmx'), 'checked before the mouse moves');
  assert.strictEqual(win.SCREEN_CHANGED, 'The screen changed since that screenshot; take a new one.');
  const r = win.clickScript({ x: 1, y: 2, button: 'right', ...S });
  assert.match(r, /Mouse\(8, 0\)/);
  assert.match(r, /Mouse\(16, 0\)/);
  assert.match(win.clickScript({ x: 1, y: 2, button: 'middle', ...S }), /Mouse\(32, 0\)/);
  assert.strictEqual(win.clickScript({ x: 1, y: 2, double: true, ...S }).match(/Mouse\(2, 0\)/g).length, 2);
  assert.strictEqual(win.clickScript({ x: 1, y: 2, ...S }).match(/Mouse\(2, 0\)/g).length, 1);
  for (const bad of [{ x: 1.5, y: 1 }, { x: '1', y: 1 }, { x: -1, y: 1 }, { x: 1, y: 99999 }, { x: 1, y: 1, button: 'left; calc' }, { x: 1, y: 1, button: 'x' }, { x: 1, y: 1, double: 'yes' }, { x: NaN, y: 1 }, { y: 1 }, {}]) {
    assert.throws(() => win.clickScript({ ...S, ...bad }), win.WindowsError, JSON.stringify(bad));
  }
  for (const bad of [{}, { screenWidth: 1920 }, { screenHeight: 1080 }, { screenWidth: '1920', screenHeight: 1080 }, { screenWidth: 0, screenHeight: 1080 }, { screenWidth: 1920, screenHeight: 1080.5 }]) {
    assert.throws(() => win.clickScript({ x: 1, y: 1, ...bad }), win.WindowsError, `click without the screen size: ${JSON.stringify(bad)}`);
  }
  assert.match(win.scrollScript({ amount: 3 }), /Mouse\(0x0800, 360\)/);
  assert.match(win.scrollScript({ amount: -20 }), /Mouse\(0x0800, -2400\)/);
  assert.match(win.scrollScript({ x: 5, y: 6, amount: 1, ...S }), /\$mmx = 5; \$mmy = 6[\s\S]*throw "The screen changed since that screenshot[\s\S]*SetCursorPos/);
  assert.doesNotMatch(win.scrollScript({ amount: 1 }), /SetCursorPos\(\$/);
  assert.doesNotMatch(win.scrollScript({ amount: 1 }), /The screen changed/, 'no position, no screen check');
  assert.throws(() => win.scrollScript({ x: 5, y: 6, amount: 1 }), win.WindowsError, 'a position needs the screen size');
  for (const bad of [{ amount: 21 }, { amount: -21 }, { amount: 0 }, { amount: 1.5 }, { amount: '2' }, { amount: 1, x: 5 }, { amount: 1, x: 'a', y: 1 }, {}]) {
    assert.throws(() => win.scrollScript(bad), win.WindowsError, JSON.stringify(bad));
  }
});

// ── the tools, with a stand-in MeshCentral client ─────────────────────────────────────────────────
const ID_A = 'Abcdefghijkl0123456789', ID_B = 'Bcdefghijklm9876543210', ID_C = 'Cdefghijklmn1111111111', ID_D = 'Cdefghijklmn2222222222';
const NODES = {
  'mesh//g1': [
    { _id: `node//${ID_A}`, name: 'demo-pc', rname: 'DEMO-PC', osdesc: 'Windows 11 Pro', conn: 1, agct: 1783000000000, agent: { id: 4, ver: 12 }, ip: '::ffff:192.168.0.20', host: '100.64.0.7' },
    { _id: `node//${ID_B}`, name: 'Laptop', osdesc: 'Windows 10', conn: 0, lastconnect: 1782000000000, agent: { id: 4, ver: 11 } },
    { _id: `node//${ID_C}`, name: 'dup', osdesc: 'Windows 10', conn: 1, agct: 1783000000000 },
    { _id: `node//${ID_D}`, name: 'Dup', osdesc: 'Windows 10', conn: 1, agct: 1783000000000 },
  ],
};
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('a picture')]);
const shotReply = (w = 1600, h = 900, sw = 1920, sh = 1080) => `Microsoft Windows [Version 10.0.22631]\r\n(c) Microsoft Corporation.\r\n\r\nC:\\Windows\\system32>powershell.exe -NoProfile ...\r\nMMSHOT ${w} ${h} ${sw} ${sh} ${JPEG.toString('base64')} MMEND\r\n\r\nC:\\Windows\\system32>exit\r\n`;

function setup(over = {}) {
  const mediaDir = 'mediaDir' in over ? over.mediaDir : tmp();   // the connector's data folder; the private pictures go in <it>/screens
  const time = { t: new Date(2026, 10, 7, 9, 5, 3).getTime() };
  const calls = [], lines = [], logs = [];
  const handlers = { ...(over.handlers || {}) };
  const client = {
    request: async (action, fields, opts) => {
      calls.push({ action, fields, opts });
      if (handlers[action]) return handlers[action](fields, opts);
      if (action === 'nodes') return { action: 'nodes', nodes: NODES };
      if (action === 'toast') return { action: 'toast', result: 'ok' };
      throw new MeshError('Unexpected action in the test.', 'EMESH');
    },
  };
  const gateCalls = [], gateOpts = [], stillValidCalls = [];
  const fakeGate = over.realGate ? null : {
    require: async (agent, need, pc, opts) => { gateCalls.push({ agent, need, pc: pc && { id: pc.id, name: pc.name } }); gateOpts.push(opts); if (over.gateRefuses && need !== 'look') throw new GateError(over.gateRefuses, 'ELEVEL'); },
    stillValid: (agent, id, need) => { stillValidCalls.push({ agent, id, need }); return over.stillValid ? over.stillValid(agent, id, need) : true; },
  };
  const remote = createRemote({
    env: { MODULE_SETTINGS: JSON.stringify({ levels: ['sam:act', 'pat:drive'], session_minutes: 30, ...(over.settings || {}) }), CONNECTOR_DATA_HOME: mediaDir },
    write: (line) => lines.push(line), log: (...a) => logs.push(a.join(' ')),
    deps: { agentClient: client, group: 'mesh//g1', now: () => time.t, ...(over.deps || {}), ...(fakeGate ? { gate: fakeGate } : {}) },
  });
  let n = 0;
  const raw = async (name, args) => (await remote.handle({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } })).result;
  const call = async (name, args) => {
    const r = await raw(name, args);
    const text = r.content[0].text;
    return r.isError ? { error: text } : JSON.parse(text);
  };
  return { remote, client, calls, lines, logs, gateCalls, gateOpts, stillValidCalls, handlers, time, mediaDir, call, raw };
}
// A screenshot, and the shot id it gives (for click and scroll).
const shotOf = async (t, who = 'sam', computer = 'demo-pc') => (await t.call('screenshot', { __agent: who, __call: 'call-1', computer })).shot;
const AGENT = { __agent: 'sam', __call: 'call-1' };   // what the hub adds to an agent's call

test('tools: tools/list describes every tool for an agent, with the level it needs', () => {
  const by = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
  for (const [name, level] of Object.entries({ computers: 'Look', info: 'Look', screenshot: 'Look', run: 'Act', click: 'Drive', type: 'Drive', key: 'Drive', scroll: 'Drive' })) {
    assert.ok(by[name].description.startsWith(`${level} level.`), name);
    assert.strictEqual(by[name].inputSchema.type, 'object');
    if (level !== 'Look') assert.match(by[name].description, /asks the owner/);
  }
  assert.deepStrictEqual(by.run.inputSchema.required, ['computer', 'command']);
  assert.deepStrictEqual(Object.keys(by.run.inputSchema.properties).sort(), ['as', 'command', 'computer', 'shell', 'timeoutSec']);
  assert.deepStrictEqual(Object.keys(by.scroll.inputSchema.properties).sort(), ['amount', 'computer', 'shot', 'x', 'y']);
  assert.strictEqual(by.screenshot.inputSchema.properties.maxWidth.maximum, 1920);
  // click needs the shot id of the screenshot it points into; scroll needs it only with a position.
  assert.deepStrictEqual(by.click.inputSchema.required, ['computer', 'shot', 'x', 'y']);
  assert.deepStrictEqual(by.scroll.inputSchema.required, ['computer', 'amount']);
  for (const n of ['click', 'scroll']) { assert.strictEqual(by[n].inputSchema.properties.shot.type, 'string'); assert.match(by[n].description, /shot id/); }
  assert.match(by.screenshot.description, /shot id/);
  assert.doesNotMatch(by.screenshot.description, /Files folder|file path/, 'the picture is returned inline, not saved for the agent');
});

test('tools: computers maps the group list; a call with no agent from the hub is refused', async () => {
  const t = setup({ realGate: true });
  const anon = await t.call('computers', {});
  assert.match(anon.error, /did not say which agent/);
  assert.strictEqual(t.calls.length, 0, 'nothing was asked of the server');
  const list = await t.call('computers', AGENT);
  assert.deepStrictEqual(t.calls[0], { action: 'nodes', fields: { meshid: 'mesh//g1' }, opts: { timeoutMs: 15000 } });
  assert.deepStrictEqual(list[0], { id: ID_A.slice(0, 12), name: 'demo-pc', os: 'Windows 11 Pro', online: true, lastSeen: new Date(1783000000000).toISOString(), agentVersion: '12' });
  assert.deepStrictEqual(list[1], { id: ID_B.slice(0, 12), name: 'Laptop', os: 'Windows 10', online: false, lastSeen: new Date(1782000000000).toISOString(), agentVersion: '11' });
  assert.strictEqual(list.length, 4);
  assert.ok(!JSON.stringify(list).includes('node//'), 'the full node id is not shown');
});

test('tools: a computer is found by id, a short prefix or name (any case); an unknown or ambiguous one is a plain error', async () => {
  const t = setup();
  const ok = [ID_A, ID_A.slice(0, 12), 'demo-pc', 'DEMO-PC', '  Demo-Pc '];
  t.handlers.getsysinfo = async () => ({ action: 'getsysinfo', hardware: {} });
  for (const q of ok) {
    const r = await t.call('info', { ...AGENT, computer: q });
    assert.strictEqual(r.name, 'demo-pc', q);
  }
  assert.strictEqual(t.calls.filter((c) => c.action === 'getsysinfo').every((c) => c.fields.nodeid === `node//${ID_A}`), true);
  const none = await t.call('info', { ...AGENT, computer: 'nope' });
  assert.match(none.error, /No computer matches "nope"/);
  const short = await t.call('info', { ...AGENT, computer: 'Abc' });
  assert.match(short.error, /No computer matches/, 'a prefix under 6 characters is not enough');
  const amb = await t.call('info', { ...AGENT, computer: 'dup' });
  assert.match(amb.error, /More than one computer matches "dup": dup \(Cdefghijklmn\), Dup \(Cdefghijklmn\)/);
  const bad = await t.call('info', { ...AGENT, computer: { toString: null } });
  assert.match(bad.error, /give the name or the id/);
  assert.ok(!t.calls.some((c) => c.fields && c.fields.nodeid && !String(c.fields.nodeid).includes(ID_A)), 'only the resolved computer was queried');
});

test('tools: info gives a compact summary (at most 4 KB, unknown fields skipped)', async () => {
  const t = setup();
  t.handlers.getsysinfo = async (f) => ({
    action: 'getsysinfo', nodeid: f.nodeid,
    hardware: {
      identifiers: { cpu_name: 'Fallback CPU' },
      windows: {
        osinfo: { Caption: 'Microsoft Windows 11 Pro', Version: '10.0.22631', OSArchitecture: '64-bit', BitLockerSecret: 'must not appear' },
        cpu: [{ Name: 'Intel(R) Core(TM) i7' }],
        memory: [{ Capacity: '17179869184' }, { Capacity: 17179869184 }],
        volumes: { 'C:': { size: 500107862016, sizeremaining: 120000000000, recoveryPassword: 'secret-key' }, 'D:': { size: 'x' } },
        av: [{ product: 'Windows Defender', enabled: true, updated: true }],
        firewall: { enabled: true },
        pendingReboot: false,
      },
    },
    node: { conn: 1 },
    netif2: { Ethernet: [{ address: '192.168.0.20', family: 'IPv4' }, { address: 'fe80::1', family: 'IPv6' }], Loopback: [{ address: '127.0.0.1', family: 'IPv4' }], VPN: [{ address: '10.0.0.5', family: 'IPv4' }] },
  });
  const r = await t.call('info', { ...AGENT, computer: 'demo-pc' });
  // getnetworkinfo is never asked: the addresses come from the group list (ip, host) and getsysinfo.
  assert.ok(!t.calls.some((c) => c.action === 'getnetworkinfo'));
  assert.deepStrictEqual(t.calls.filter((c) => /^get/.test(c.action)).map((c) => c.action), ['getsysinfo']);
  assert.strictEqual(r.os, 'Windows 11 Pro, version 10.0.22631, 64-bit');
  assert.strictEqual(r.cpu, 'Intel(R) Core(TM) i7');
  assert.strictEqual(r.memoryGB, 32);
  assert.deepStrictEqual(r.disks, [{ drive: 'C:', sizeGB: 465.8, freeGB: 111.8 }]);
  assert.strictEqual(r.antivirus, 'Windows Defender, enabled: true, updated: true');
  assert.strictEqual(r.firewall, 'enabled: true');
  assert.strictEqual(r.pendingReboot, false);
  assert.deepStrictEqual(r.ipv4, ['192.168.0.20', '100.64.0.7', '10.0.0.5']);
  assert.strictEqual(r.agentVersion, '12');
  assert.strictEqual(r.lastConnect, new Date(1783000000000).toISOString());
  assert.strictEqual(r.defender, undefined);
  const text = JSON.stringify(r);
  assert.ok(!/secret|must not appear/.test(text));
  // Only the known facts come out, whatever else the server reports (unknown fields at any depth are left out).
  const KNOWN = ['name', 'id', 'online', 'status', 'os', 'cpu', 'memoryGB', 'disks', 'antivirus', 'firewall', 'defender', 'pendingReboot', 'ipv4', 'agentVersion', 'lastConnect'];
  assert.ok(Object.keys(r).every((k) => KNOWN.includes(k)), Object.keys(r).join(','));
  t.handlers.getsysinfo = async () => ({
    hardware: { windows: { osinfo: { Caption: 'Windows 11', ProductKey: 'AAAAA-BBBBB', SerialNumber: 'SN-123' }, cpu: [{ Name: 'CPU', Secret: 'cpu-secret' }], extraThing: { token: 'tok-1' } }, bios: { serial: 'BIOS-SN' }, users: ['alice'] },
    node: { name: 'x', token: 'tok-2', pr: false }, somethingNew: 'new-field-value', rights: 1,
  });
  const lean = await t.call('info', { ...AGENT, computer: 'demo-pc' });
  assert.ok(Object.keys(lean).every((k) => KNOWN.includes(k)), Object.keys(lean).join(','));
  assert.ok(!/AAAAA|SN-123|cpu-secret|tok-1|tok-2|BIOS-SN|alice|new-field-value/.test(JSON.stringify(lean)));
  // A huge report is cut to 4 KB.
  t.handlers.getsysinfo = async () => ({ hardware: { windows: { volumes: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`V${i}:`, { size: 1e12, sizeremaining: 5e11 }])), av: 'a'.repeat(5000) } } });
  const big = await t.call('info', { ...AGENT, computer: 'demo-pc' });
  assert.ok(Buffer.byteLength(JSON.stringify(big)) <= 4096);
  // The server has nothing on it yet.
  t.handlers.getsysinfo = async () => { throw new MeshError('Invalid device id', 'EMESH'); };
  const none = await t.call('info', { ...AGENT, computer: 'demo-pc' });
  assert.match(none.error, /No information about demo-pc yet/);
  // With nothing from getsysinfo, the group list's own addresses still show.
  t.handlers.getsysinfo = async () => ({ hardware: {} });
  const part = await t.call('info', { ...AGENT, computer: 'demo-pc' });
  assert.strictEqual(part.name, 'demo-pc');
  assert.deepStrictEqual(part.ipv4, ['192.168.0.20', '100.64.0.7']);
  assert.strictEqual(part.status, undefined);
});

test('tools: info on an offline computer does not ask it (no getsysinfo) and says since when it is offline', async () => {
  const t = setup();
  t.handlers.getsysinfo = async () => { throw new Error('must not be asked'); };
  const r = await t.call('info', { ...AGENT, computer: 'Laptop' });
  assert.strictEqual(r.name, 'Laptop');
  assert.strictEqual(r.online, false);
  assert.strictEqual(r.status, `offline since ${new Date(1782000000000).toISOString()}`);
  assert.strictEqual(r.lastConnect, new Date(1782000000000).toISOString());
  assert.ok(!t.calls.some((c) => /^get/.test(c.action)));
  assert.ok(Object.keys(r).every((k) => ['name', 'id', 'online', 'status', 'os', 'agentVersion', 'lastConnect'].includes(k)), Object.keys(r).join(','));
});

test('tools: screenshot runs the script as the signed-in user, returns the JPEG inline with a shot id, and keeps a private copy', async () => {
  const t = setup();
  t.handlers.runcommands = async () => ({ action: 'msg', type: 'runcommands', result: shotReply() });
  const raw = await t.raw('screenshot', { ...AGENT, computer: 'demo-pc', maxWidth: 1280 });
  // MCP content: the facts as text, then the picture as an image. No file path is given to the agent.
  assert.strictEqual(raw.isError, undefined);
  assert.strictEqual(raw.content.length, 2);
  assert.strictEqual(raw.content[0].type, 'text');
  assert.deepStrictEqual(raw.content[1], { type: 'image', data: JPEG.toString('base64'), mimeType: 'image/jpeg' });
  const r = JSON.parse(raw.content[0].text);
  assert.deepStrictEqual(Object.keys(r).sort(), ['computer', 'height', 'screen', 'shot', 'takenAt', 'width']);
  assert.match(r.shot, /^[a-z0-9]{8}$/);
  assert.strictEqual(r.computer, 'demo-pc');
  assert.ok(!raw.content[0].text.includes(t.mediaDir) && !/\.jpg|screens/.test(raw.content[0].text), 'no path to the private copy');
  const run = t.calls.find((c) => c.action === 'runcommands');
  assert.deepStrictEqual({ ids: run.fields.nodeids, type: run.fields.type, as: run.fields.runAsUser, ms: run.opts.timeoutMs }, { ids: [`node//${ID_A}`], type: 2, as: 2, ms: 30000 });
  assert.match(decodeLine(run.fields.cmds), /\$nw -gt 1280/);
  assert.deepStrictEqual(t.gateCalls.map((g) => g.need), ['look', 'look']);
  // The private copy: <data folder>/screens/<short id>/<yyyy-mm-dd>/<hhmmss>-<4 hex>.jpg, folders 0700, file 0600.
  const comp = folderOf(ID_A);
  assert.strictEqual(comp, ID_A.slice(0, 12));
  const screens = path.join(t.mediaDir, 'screens');
  const dayDir = path.join(screens, comp, '2026-11-07');
  const files = fs.readdirSync(dayDir);
  assert.strictEqual(files.length, 1);
  assert.match(files[0], /^090503-[0-9a-f]{4}\.jpg$/);
  assert.ok(fs.readFileSync(path.join(dayDir, files[0])).equals(JPEG));
  assert.strictEqual(fs.statSync(path.join(dayDir, files[0])).mode & 0o777, 0o600);
  for (const d of [screens, path.join(screens, comp), dayDir]) assert.strictEqual(fs.statSync(d).mode & 0o777, 0o700, d);
  assert.deepStrictEqual({ w: r.width, h: r.height, screen: r.screen, at: r.takenAt }, { w: 1600, h: 900, screen: { width: 1920, height: 1080 }, at: new Date(t.time.t).toISOString() });
  // The module log has the agent, the computer and the size, never the picture.
  const logged = t.logs.filter((l) => /screenshot of/.test(l));
  assert.deepStrictEqual(logged, [`screenshot of demo-pc for sam (1600x900, ${JPEG.length} bytes)`]);
  assert.ok(!t.logs.join('\n').includes(JPEG.toString('base64')));
  // A second picture is a second file and a second shot id.
  const r2 = await t.call('screenshot', { ...AGENT, computer: 'demo-pc' });
  assert.notStrictEqual(r2.shot, r.shot);
  assert.strictEqual(fs.readdirSync(dayDir).length, 2);
  assert.match(decodeLine(t.calls.filter((c) => c.action === 'runcommands')[1].fields.cmds), /\$nw -gt 1600/);
  // Refusals.
  assert.match((await t.call('screenshot', { ...AGENT, computer: 'Laptop' })).error, /Laptop is offline/);
  assert.match((await t.call('screenshot', { ...AGENT, computer: 'demo-pc', maxWidth: 100 })).error, /maxWidth/);
  t.handlers.runcommands = async () => ({ result: 'Access is denied.' });
  assert.match((await t.call('screenshot', { ...AGENT, computer: 'demo-pc' })).error, /did not return a picture: Access is denied/);
});

test('tools: a screenshot that gets no reply says what the screen tools need', async () => {
  const t = setup();
  t.handlers.runcommands = async () => { throw new MeshError('runcommands timed out after 30 s.', 'ETIMEDOUT'); };
  const r = await t.call('screenshot', { ...AGENT, computer: 'demo-pc' });
  assert.strictEqual(r.error, 'No reply from demo-pc within 30 seconds. No one may be signed in on it (then nothing ran): the screen tools need someone signed in to Windows on it (set it to sign in automatically and not lock). The computer may also be busy with another command. The command may still be running on it and must not be repeated blindly. Check its effect first, for example with a screenshot or a read-only command.');
});

test('tools: the private pictures kept per computer are the newest 200; a link in the way is refused (the agent still gets its picture)', async () => {
  const mediaDir = tmp();
  const t = setup({ mediaDir });
  const comp = path.join(mediaDir, 'screens', folderOf(ID_A));
  const day = path.join(comp, '2026-01-01');
  fs.mkdirSync(day, { recursive: true });
  for (let i = 0; i < 205; i++) fs.writeFileSync(path.join(day, `${String(i).padStart(6, '0')}-0000.jpg`), 'x');
  fs.writeFileSync(path.join(day, 'notes.txt'), 'not a picture');
  t.handlers.runcommands = async () => ({ result: shotReply() });
  const r = await t.call('screenshot', { ...AGENT, computer: 'demo-pc' });
  assert.match(r.shot, /^[a-z0-9]{8}$/);
  const all = (d) => fs.readdirSync(d, { withFileTypes: true });
  const pics = all(comp).filter((e) => e.isDirectory()).flatMap((e) => all(path.join(comp, e.name)).filter((f) => /\.jpg$/.test(f.name)).map((f) => `${e.name}/${f.name}`));
  assert.strictEqual(pics.length, 200);
  assert.ok(pics.some((p) => p.startsWith('2026-11-07/')), 'the new one is kept');
  assert.ok(!fs.existsSync(path.join(day, '000000-0000.jpg')), 'the oldest are gone');
  assert.ok(!fs.existsSync(path.join(day, '000005-0000.jpg')), 'the 6 oldest of 206 are gone');
  assert.ok(fs.existsSync(path.join(day, '000204-0000.jpg')));
  assert.ok(fs.existsSync(path.join(day, 'notes.txt')), 'files that are not pictures are left alone');
  // Folders: a symlink where the day folder goes is refused, and nothing is written through it.
  const elsewhere = tmp();
  const media2 = tmp();
  fs.mkdirSync(path.join(media2, 'screens', folderOf(ID_A)), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(media2, 'screens', folderOf(ID_A), '2026-11-07'));
  const t2 = setup({ mediaDir: media2 });
  t2.handlers.runcommands = async () => ({ result: shotReply() });
  assert.ok((await t2.call('screenshot', { ...AGENT, computer: 'demo-pc' })).shot, 'the picture is still returned');
  assert.ok(t2.logs.some((l) => /could not keep a private copy.*ENOTPLAIN/.test(l)));
  assert.deepStrictEqual(fs.readdirSync(elsewhere), []);
  // A link for the computer's folder, for the screens folder, and for the data folder itself.
  const media3 = tmp();
  fs.mkdirSync(path.join(media3, 'screens'));
  fs.symlinkSync(elsewhere, path.join(media3, 'screens', folderOf(ID_A)));
  const t3 = setup({ mediaDir: media3 });
  t3.handlers.runcommands = async () => ({ result: shotReply() });
  assert.ok((await t3.call('screenshot', { ...AGENT, computer: 'demo-pc' })).shot);
  assert.ok(t3.logs.some((l) => /ENOTPLAIN/.test(l)));
  const media3b = tmp();
  fs.symlinkSync(elsewhere, path.join(media3b, 'screens'));
  const t3b = setup({ mediaDir: media3b });
  t3b.handlers.runcommands = async () => ({ result: shotReply() });
  assert.ok((await t3b.call('screenshot', { ...AGENT, computer: 'demo-pc' })).shot);
  assert.ok(t3b.logs.some((l) => /ENOTPLAIN/.test(l)));
  const linkRoot = path.join(tmp(), 'data');
  fs.symlinkSync(elsewhere, linkRoot);
  const t4 = setup({ mediaDir: linkRoot });
  t4.handlers.runcommands = async () => ({ result: shotReply() });
  assert.ok((await t4.call('screenshot', { ...AGENT, computer: 'demo-pc' })).shot);
  assert.ok(t4.logs.some((l) => /ENOTPLAIN/.test(l)));
  assert.deepStrictEqual(fs.readdirSync(elsewhere), []);
  // No data folder at all: no private copy, and still a picture.
  const t5 = setup({ mediaDir: '' });
  t5.handlers.runcommands = async () => ({ result: shotReply() });
  assert.ok((await t5.call('screenshot', { ...AGENT, computer: 'demo-pc' })).shot);
  assert.ok(t5.logs.some((l) => /ENOHOME/.test(l)));
  // The store on its own: a smaller keep.
  const media6 = tmp();
  const store = createShotStore({ home: media6, keep: 2, now: () => new Date(2026, 0, 2, 3, 4, 5).getTime() });
  for (let i = 0; i < 4; i++) store.save('pc-x', JPEG);
  assert.strictEqual(fs.readdirSync(path.join(media6, 'screens', 'pc-x', '2026-01-02')).length, 2);
  assert.strictEqual(createShotStore({}).constructor, Object);
  assert.throws(() => createShotStore({ home: '' }).save('pc-x', JPEG), (e) => e.code === 'ENOHOME');
});

test('tools: run is an act tool; PowerShell travels encoded, cmd as typed; as picks the session; output is capped at 64 KB', async () => {
  const t = setup();
  t.handlers.runcommands = async () => ({ result: 'Microsoft Windows [Version 10.0.22631]\r\n(c) Microsoft Corporation. All rights reserved.\r\n\r\nC:\\Windows\\system32>\r\nhello\r\nC:\\Windows\\system32>exit\r\n' });
  const r = await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'Get-Date -Format "o"; "it\'s $x"' });
  assert.deepStrictEqual(t.gateCalls.slice(-1)[0], { agent: 'sam', need: 'act', pc: { id: ID_A, name: 'demo-pc' } });
  const c = t.calls.find((x) => x.action === 'runcommands');
  assert.deepStrictEqual({ type: c.fields.type, as: c.fields.runAsUser, ms: c.opts.timeoutMs }, { type: 2, as: 0, ms: 60000 });
  const script = decodeLine(c.fields.cmds);
  assert.ok(script.endsWith('Get-Date -Format "o"; "it\'s $x"'));
  assert.ok(!c.fields.cmds.includes('Get-Date'), 'the caller\'s text travels only as base64');
  assert.strictEqual(r.output, 'hello');
  assert.strictEqual(typeof r.took_ms, 'number');
  assert.deepStrictEqual(t.gateOpts.filter(Boolean).slice(-1)[0], { call: 'call-1', as: 'system' }, 'the hub\'s call id and the account go to the gate');
  await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'whoami', as: 'user' });
  assert.deepStrictEqual(t.gateOpts.filter(Boolean).slice(-1)[0], { call: 'call-1', as: 'user' });
  // PowerShell reading its commands from stdin may print prompts around the output.
  t.handlers.runcommands = async (f) => ({ result: `PS C:\\Windows\\system32> \r\n${f.cmds}\r\nhello\r\nPS C:\\Windows\\system32> exit\r\n` });
  assert.strictEqual((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'echo hello' })).output, 'hello');
  t.handlers.runcommands = async () => ({ result: 'Microsoft Windows [Version 10.0.22631]\r\n(c) Microsoft Corporation. All rights reserved.\r\n\r\nC:\\Windows\\system32>\r\nhello\r\nC:\\Windows\\system32>exit\r\n' });
  // cmd, as the user, with a longer wait.
  await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'dir C:\\', shell: 'cmd', as: 'user', timeoutSec: 120 });
  const c2 = t.calls.filter((x) => x.action === 'runcommands').slice(-1)[0];
  assert.deepStrictEqual({ cmds: c2.fields.cmds, type: c2.fields.type, as: c2.fields.runAsUser, ms: c2.opts.timeoutMs }, { cmds: 'dir C:\\\r\n', type: 1, as: 2, ms: 120000 });
  // Output over 64 KB is cut.
  t.handlers.runcommands = async () => ({ result: 'a'.repeat(70000) });
  const big = await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x' });
  assert.ok(big.output.startsWith('a'.repeat(65536) + '\n[... 4464 more bytes not shown]'));
  assert.strictEqual(big.output.length, 65536 + '\n[... 4464 more bytes not shown]'.length);
  // Arguments.
  for (const [args, re] of [
    [{ command: '' }, /command/], [{ command: 'x'.repeat(8001) }, /command/], [{ command: 5 }, /command/], [{ command: 'x', shell: 'bash' }, /shell/],
    [{ command: 'x', as: 'root' }, /as must/], [{ command: 'x', timeoutSec: 4 }, /timeoutSec/], [{ command: 'x', timeoutSec: 301 }, /timeoutSec/], [{ command: 'x', timeoutSec: 5.5 }, /timeoutSec/],
  ]) assert.match((await t.call('run', { ...AGENT, computer: 'demo-pc', ...args })).error, re, JSON.stringify(args).slice(0, 60));
  assert.match((await t.call('run', { ...AGENT, computer: 'Laptop', command: 'x' })).error, /offline/);
  // The longest command still fits on the line.
  t.handlers.runcommands = async () => ({ result: 'ok' });
  assert.strictEqual((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'y'.repeat(8000) })).output, 'ok');
  // cmd.exe takes about 8191 characters in a line: over 7000 is refused with a plain message, before the owner is asked or anything is sent.
  const sent = t.calls.length, asks = t.gateCalls.length;
  const longCmd = await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x'.repeat(7001), shell: 'cmd' });
  assert.match(longCmd.error, /too long for cmd \(7000 characters at most; it has 7001\)\. Use PowerShell/);
  assert.ok(!t.calls.slice(sent).some((x) => x.action === 'runcommands'));
  assert.ok(!t.gateCalls.slice(asks).some((g) => g.need === 'act'));
  const edge = await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x'.repeat(7000), shell: 'cmd' });
  assert.strictEqual(edge.output, 'ok');
  assert.deepStrictEqual(t.calls.filter((x) => x.action === 'runcommands').slice(-1)[0].fields.type, 1, 'cmd stays on type 1');
});

// A Linux and a macOS computer next to the Windows one (the OS comes from osdesc, or from the agent id when that is empty).
const OTHER_NODES = {
  'mesh//g1': [
    ...NODES['mesh//g1'].slice(0, 1),
    { _id: `node//${ID_B}`, name: 'penguin', osdesc: 'Ubuntu 24.04.1 LTS', conn: 1, agct: 1783000000000, agent: { id: 6, ver: 12 } },
    { _id: `node//${ID_C}`, name: 'apple', osdesc: 'macOS 14.5', conn: 1, agct: 1783000000000, agent: { id: 29, ver: 12 } },
    { _id: `node//${ID_D}`, name: 'bare', osdesc: '', conn: 1, agct: 1783000000000, agent: { id: 6, ver: 12 } },
  ],
};

test('tools: on Linux and macOS run uses runcommands type 3 with the text and a new line; sh is the default; powershell and cmd are refused there, sh on Windows', async () => {
  const t = setup({ handlers: { nodes: async () => ({ action: 'nodes', nodes: OTHER_NODES }) } });
  t.handlers.runcommands = async () => ({ result: 'root\n' });
  for (const name of ['penguin', 'apple', 'bare']) {
    const r = await t.call('run', { ...AGENT, computer: name, command: 'whoami' });
    assert.strictEqual(r.output, 'root', name);
    const c = t.calls.filter((x) => x.action === 'runcommands').slice(-1)[0];
    assert.deepStrictEqual({ type: c.fields.type, cmds: c.fields.cmds, as: c.fields.runAsUser }, { type: 3, cmds: 'whoami\n', as: 0 }, name);
  }
  await t.call('run', { ...AGENT, computer: 'penguin', command: 'id -u', shell: 'sh', as: 'user' });
  const u = t.calls.filter((x) => x.action === 'runcommands').slice(-1)[0];
  assert.deepStrictEqual({ type: u.fields.type, cmds: u.fields.cmds, as: u.fields.runAsUser }, { type: 3, cmds: 'id -u\n', as: 2 });
  assert.deepStrictEqual(t.gateOpts.filter(Boolean).slice(-1)[0], { call: 'call-1', as: 'user' });
  const sent = t.calls.length;
  for (const shell of ['powershell', 'cmd']) {
    const r = await t.call('run', { ...AGENT, computer: 'penguin', command: 'x', shell });
    assert.match(r.error, /penguin is not a Windows computer: use sh/, shell);
  }
  assert.match((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x', shell: 'sh' })).error, /demo-pc is a Windows computer: use powershell/);
  assert.ok(!t.calls.slice(sent).some((x) => x.action === 'runcommands'), 'nothing was sent');
  // Windows keeps its types.
  await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'dir', shell: 'cmd' });
  assert.strictEqual(t.calls.filter((x) => x.action === 'runcommands').slice(-1)[0].fields.type, 1);
  await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'dir' });
  assert.strictEqual(t.calls.filter((x) => x.action === 'runcommands').slice(-1)[0].fields.type, 2);
  assert.ok(TOOLS.find((x) => x.name === 'run').inputSchema.properties.shell.enum.includes('sh'));
});

test('tools: screenshot, click, type, key and scroll say they are Windows only on a Linux or macOS computer, and send nothing', async () => {
  const t = setup({ handlers: { nodes: async () => ({ action: 'nodes', nodes: OTHER_NODES }) } });
  t.handlers.runcommands = async () => { throw new Error('must not run'); };
  const NOPE = 'Screenshots and mouse/keyboard work on Windows computers for now.';
  for (const computer of ['penguin', 'apple']) {
    for (const [name, args] of [['screenshot', {}], ['click', { shot: 'abcd1234', x: 1, y: 1 }], ['type', { text: 'a' }], ['key', { keys: 'a' }], ['scroll', { amount: 1 }], ['scroll', { amount: 1, x: 1, y: 1, shot: 'abcd1234' }]]) {
      assert.strictEqual((await t.call(name, { ...AGENT, computer, ...args })).error, NOPE, `${computer} ${name}`);
    }
  }
  assert.ok(!t.calls.some((c) => c.action === 'runcommands'));
  assert.ok(!t.gateCalls.some((g) => g.need === 'act' || g.need === 'drive'), 'the owner is not asked for what cannot be done');
  t.handlers.getsysinfo = async () => ({ hardware: {} });
  assert.ok(!(await t.call('info', { ...AGENT, computer: 'penguin' })).error, 'info still works');
});

test('tools: with the real gate a run as the system asks again after a run as the user was approved; drive does not cover the system', async () => {
  const t = setup({ realGate: true });
  t.handlers.runcommands = async () => ({ result: 'done' });
  const asksOf = () => t.lines.map((l) => JSON.parse(l)).filter((m) => m.method === 'hub/approve');
  const answer = async (p) => { await flush(); const a = asksOf().slice(-1)[0]; t.remote.onLine(JSON.stringify({ jsonrpc: '2.0', id: a.id, result: { decision: 'allow' } })); return p; };
  const first = await answer(t.call('run', { ...AGENT, computer: 'demo-pc', command: 'whoami', as: 'user' }));
  assert.strictEqual(first.output, 'done');
  assert.match(asksOf()[0].params.detail, /may run commands as the signed-in user on/);
  assert.strictEqual((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'again', as: 'user' })).output, 'done');
  assert.strictEqual(asksOf().length, 1);
  const sys = await answer(t.call('run', { ...AGENT, computer: 'demo-pc', command: 'whoami' }));
  assert.strictEqual(sys.output, 'done');
  assert.strictEqual(asksOf().length, 2);
  assert.match(asksOf()[1].params.detail, /may run commands as the system account \(full control\)/);
  assert.strictEqual((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x', as: 'user' })).output, 'done');
  assert.strictEqual(asksOf().length, 2, 'the system approval covers a user run');
});

test('tools: a login that timed out is not a command that got no answer; a command that did stays busy; the screen hold stays 60 s', async () => {
  const t = setup();
  const loginTimeout = () => Object.assign(new MeshError('The server did not log in within 20 seconds.', 'ETIMEDOUT'), { login: true });
  t.handlers.runcommands = async () => { throw loginTimeout(); };
  const r = await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x' });
  assert.strictEqual(r.error, 'The Remote computers server did not answer in time, so nothing was sent to demo-pc. Try again in a moment.');
  assert.doesNotMatch(r.error, /may still be running/);
  t.handlers.runcommands = async () => ({ result: 'fine' });
  assert.strictEqual((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x' })).output, 'fine', 'not left busy: nothing was sent');
  // A screenshot or input whose login timed out says the same, and does not hold the computer.
  t.handlers.runcommands = async () => { throw loginTimeout(); };
  assert.match((await t.call('screenshot', { ...AGENT, computer: 'demo-pc' })).error, /nothing was sent to demo-pc/);
  t.handlers.runcommands = async () => ({ result: shotReply() });
  assert.ok((await t.call('screenshot', { ...AGENT, computer: 'demo-pc' })).shot);
  // A command that got no answer: the run message, and a hold of 10 minutes.
  t.handlers.runcommands = async () => { throw new MeshError('runcommands timed out after 5 s.', 'ETIMEDOUT'); };
  assert.match((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x', timeoutSec: 5 })).error, /^No reply from demo-pc within 5 seconds\. The command may still be running/);
  // A screenshot that got no answer: the screen message, and a hold of 60 seconds (not 10 minutes).
  const u = setup();
  u.handlers.runcommands = async () => { throw new MeshError('runcommands timed out after 30 s.', 'ETIMEDOUT'); };
  assert.match((await u.call('screenshot', { ...AGENT, computer: 'demo-pc' })).error, /^No reply from demo-pc within 30 seconds\. No one may be signed in on it \(then nothing ran\): the screen tools need someone signed in/);
  u.handlers.runcommands = async () => ({ result: shotReply() });
  assert.match((await u.call('screenshot', { ...AGENT, computer: 'demo-pc' })).error, /busy, try again in a moment/);
  u.time.t += 59000;
  assert.match((await u.call('screenshot', { ...AGENT, computer: 'demo-pc' })).error, /busy/);
  u.time.t += 2000;
  assert.ok((await u.call('screenshot', { ...AGENT, computer: 'demo-pc' })).shot, 'free again after 60 s');
});

test('tools: one command per computer at a time; a timeout keeps it busy for 10 minutes', async () => {
  const t = setup();
  const d = deferred();
  t.handlers.runcommands = () => d.promise;
  const first = t.call('run', { ...AGENT, computer: 'demo-pc', command: 'slow' });
  await flush();
  const second = await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'other' });
  assert.match(second.error, /busy, try again in a moment/);
  // Another computer is free.
  t.handlers.runcommands = async () => ({ result: 'fine' });
  assert.strictEqual((await t.call('run', { ...AGENT, computer: ID_C, command: 'x' })).output, 'fine');
  d.resolve({ result: 'done' });
  assert.strictEqual((await first).output, 'done');
  assert.strictEqual((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x' })).output, 'fine');
  // A timeout.
  t.handlers.runcommands = async () => { throw new MeshError('runcommands timed out after 5 s.', 'ETIMEDOUT'); };
  const late = await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x', timeoutSec: 5 });
  assert.match(late.error, /^No reply from demo-pc within 5 seconds\./);
  t.handlers.runcommands = async () => ({ result: 'back' });
  t.time.t += 9 * 60000;
  assert.match((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x' })).error, /busy, try again in a moment/);
  t.time.t += 61000;
  assert.strictEqual((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x' })).output, 'back');
  // An error from the server does not leave the computer busy.
  t.handlers.runcommands = async () => { throw new MeshError('Agent not connected', 'EMESH'); };
  assert.strictEqual((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x' })).error, 'demo-pc: Agent not connected');
  t.handlers.runcommands = async () => ({ result: 'again' });
  assert.strictEqual((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x' })).output, 'again');
});

const CHECK_FIRST = /must not be repeated blindly\. Check its effect first, for example with a screenshot or a read-only command\.$/;
const failing = (code, sent) => async () => { throw Object.assign(new MeshError(`runcommands failed (${code})`, code), sent === undefined ? {} : { sent }); };

test('tools: run that failed BEFORE sending frees the computer and may say try again; AFTER sending it stays busy 10 minutes and says it may still be running', async () => {
  // Before sending: the server never got it (could not send, login failed). Nothing ran, so the computer is free at once.
  const t = setup();
  for (const [code, sent] of [['ECLOSED', false], ['EAUTH', false], ['ETIMEDOUT', false]]) {
    t.handlers.runcommands = failing(code, sent);
    const r = await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x' });
    assert.strictEqual(r.error, 'The Remote computers server did not answer. Try again in a moment.', code);
    assert.doesNotMatch(r.error, /may still be running/);
    t.handlers.runcommands = async () => ({ result: 'free' });
    assert.strictEqual((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x' })).output, 'free', `${code}: not busy after a failure before sending`);
  }
  // After sending, a lost connection.
  t.handlers.runcommands = failing('ECLOSED', true);
  const lost = await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x' });
  assert.match(lost.error, /^The connection to the server was lost after the command was sent to demo-pc\. The command may still be running on it and must not be repeated blindly\./);
  assert.match(lost.error, CHECK_FIRST);
  t.handlers.runcommands = async () => ({ result: 'again' });
  assert.match((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x' })).error, /busy, try again in a moment/);
  t.time.t += 9 * 60000;
  assert.match((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x' })).error, /busy/);
  t.time.t += 61000;
  assert.strictEqual((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x' })).output, 'again', 'free after 10 minutes');
  // After sending, no answer in time.
  t.handlers.runcommands = failing('ETIMEDOUT', true);
  const late = await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x', timeoutSec: 7 });
  assert.match(late.error, /^No reply from demo-pc within 7 seconds\. The command may still be running on it and must not be repeated blindly\./);
  assert.match(late.error, CHECK_FIRST);
  t.handlers.runcommands = async () => ({ result: 'again' });
  assert.match((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x' })).error, /busy/);
  // The server's own refusal after it was sent is a definite answer, not an unknown outcome: the computer is free.
  const u = setup();
  u.handlers.runcommands = failing('EMESH', true);
  assert.strictEqual((await u.call('run', { ...AGENT, computer: 'demo-pc', command: 'x' })).error, 'demo-pc: runcommands failed (EMESH)');
  u.handlers.runcommands = async () => ({ result: 'ok' });
  assert.strictEqual((await u.call('run', { ...AGENT, computer: 'demo-pc', command: 'x' })).output, 'ok');
});

test('tools: screenshot and input follow the same rule: before sending frees the computer, after sending holds it 60 seconds and says it may still be running', async () => {
  const t = setup();
  t.handlers.runcommands = async (f) => ({ result: /MMSHOT/.test(decodeLine(f.cmds)) ? shotReply() : 'MMOK\r\n' });
  const shot = await shotOf(t);
  for (const name of ['screenshot', 'click', 'type', 'key', 'scroll']) {
    const args = { ...AGENT, computer: 'demo-pc', ...({ screenshot: {}, click: { shot, x: 5, y: 5 }, type: { text: 'a' }, key: { keys: 'a' }, scroll: { amount: 1 } })[name] };
    // Before sending: free at once.
    t.handlers.runcommands = failing('ECLOSED', false);
    const before = await t.call(name, args);
    assert.strictEqual(before.error, 'The Remote computers server did not answer. Try again in a moment.', name);
    t.handlers.runcommands = async (f) => ({ result: /MMSHOT/.test(decodeLine(f.cmds)) ? shotReply() : 'MMOK\r\n' });
    assert.ok(!(await t.call(name, args)).error, `${name}: not busy after a failure before sending`);
    // After sending: held for 60 s.
    t.handlers.runcommands = failing('ETIMEDOUT', true);
    const after = await t.call(name, args);
    assert.match(after.error, new RegExp(`^No reply from demo-pc within ${name === 'screenshot' ? 30 : 20} seconds\\. `), name);
    assert.match(after.error, /The command may still be running on it and must not be repeated blindly\./);
    assert.match(after.error, CHECK_FIRST);
    t.handlers.runcommands = async (f) => ({ result: /MMSHOT/.test(decodeLine(f.cmds)) ? shotReply() : 'MMOK\r\n' });
    assert.match((await t.call(name, args)).error, /busy, try again in a moment/, name);
    t.time.t += 59000;
    assert.match((await t.call(name, args)).error, /busy/, name);
    t.time.t += 2000;
    assert.ok(!(await t.call(name, args)).error, `${name}: free after 60 s`);
    // A connection lost after sending says so too.
    t.handlers.runcommands = failing('ECLOSED', true);
    assert.match((await t.call(name, args)).error, /^The connection to the server was lost after the command was sent to demo-pc\. The command may still be running/, name);
    t.handlers.runcommands = async (f) => ({ result: /MMSHOT/.test(decodeLine(f.cmds)) ? shotReply() : 'MMOK\r\n' });
    t.time.t += 61000;
  }
});

test('tools: runcommands error-shape replies (Invalid nodeid, Access denied, ...) are errors, never output', async () => {
  const t = setup();
  for (const r of ['Invalid nodeid', 'Invalid domain', 'Access denied', 'Agent not connected', 'Invalid command type']) {
    t.handlers.runcommands = async () => ({ action: 'runcommands', responseid: 'x', result: r });
    const run = await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x' });
    assert.strictEqual(run.error, `demo-pc: ${r}`, r);
    assert.ok(!('output' in run));
    t.handlers.runcommands = async () => ({ action: 'runcommands', result: r });
    assert.strictEqual((await t.call('screenshot', { ...AGENT, computer: 'demo-pc' })).error, `demo-pc: ${r}`, `${r} on the screen tools`);
    assert.strictEqual((await t.call('key', { ...AGENT, computer: 'demo-pc', keys: 'a' })).error, `demo-pc: ${r}`);
  }
  // Not freed wrongly: an error is a definite answer, so the computer is not left busy.
  t.handlers.runcommands = async () => ({ result: 'fine' });
  assert.strictEqual((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x' })).output, 'fine');
  // The same words as the output of a command (a message, not the error shape) are just output.
  t.handlers.runcommands = async () => ({ action: 'msg', type: 'runcommands', result: 'Access denied' });
  assert.strictEqual((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x' })).output, 'Access denied');
});

test('tools: errors say what happened without the server\'s own words, a password or a path', async () => {
  const t = setup();
  t.handlers.runcommands = async () => { throw new MeshError('wss://127.0.0.1:9971 refused x-meshauth bWFlc3Rybw==,c2VjcmV0 ECONNREFUSED', 'ECONNREFUSED'); };
  const r = await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x' });
  assert.strictEqual(r.error, 'The Remote computers server did not answer. Try again in a moment.');
  t.handlers.nodes = async () => { throw new MeshError('login failed for maestro:hunter2', 'EAUTH'); };
  const n = await t.call('computers', AGENT);
  assert.doesNotMatch(n.error, /hunter2|maestro/);
  assert.ok(!t.logs.join('\n').includes('hunter2'));
});

test('tools: click needs the shot id of a screenshot, checks the place is inside it, and scales to screen pixels', async () => {
  const t = setup();
  t.handlers.runcommands = async (f) => ({ result: /MMSHOT/.test(decodeLine(f.cmds)) ? shotReply(1600, 900, 1920, 1080) : 'C:\\>x\r\nMMOK\r\nC:\\>exit\r\n' });
  const before = await t.call('click', { ...AGENT, computer: 'demo-pc', shot: 'abcd1234', x: 10, y: 10 });
  assert.strictEqual(before.error, 'Take a new screenshot and use its shot id.');
  assert.strictEqual(t.calls.filter((c) => c.action === 'runcommands').length, 0);
  assert.ok(!t.gateCalls.some((g) => g.need === 'drive'), 'the owner is not asked for a click that cannot go anywhere');
  assert.strictEqual((await t.call('click', { ...AGENT, computer: 'demo-pc', x: 10, y: 10 })).error, 'Take a new screenshot and use its shot id.', 'no shot at all');
  const shot = await shotOf(t);
  const ok = await t.call('click', { ...AGENT, computer: 'demo-pc', shot, x: 800, y: 450, double: true });
  assert.deepStrictEqual(ok, { ok: true });
  const c = t.calls.filter((x) => x.action === 'runcommands').slice(-1)[0];
  assert.deepStrictEqual({ type: c.fields.type, as: c.fields.runAsUser, ms: c.opts.timeoutMs }, { type: 2, as: 2, ms: 20000 });
  const script = decodeLine(c.fields.cmds);
  assert.match(script, /\$mmx = 960; \$mmy = 540/);
  assert.strictEqual(script.match(/Mouse\(2, 0\)/g).length, 2);
  // The script gets the screenshot's screen size and refuses when the live screen is another size.
  assert.match(script, /if \(\$mmb\.Width -ne 1920 -or \$mmb\.Height -ne 1080\) \{ throw "The screen changed since that screenshot; take a new one\." \}/);
  await t.call('click', { ...AGENT, computer: 'demo-pc', shot, x: 1599, y: 899, button: 'right' });
  assert.match(decodeLine(t.calls.filter((x) => x.action === 'runcommands').slice(-1)[0].fields.cmds), /\$mmx = 1919; \$mmy = 1079/);
  const nCalls = t.calls.length;
  for (const [x, y] of [[1600, 10], [10, 900], [-1, 5], [1.5, 5], ['5', 5]]) assert.match((await t.call('click', { ...AGENT, computer: 'demo-pc', shot, x, y })).error, /inside that screenshot/, `${x},${y}`);
  assert.match((await t.call('click', { ...AGENT, computer: 'demo-pc', shot, x: 1, y: 1, button: 'back' })).error, /button/);
  assert.ok(!t.calls.slice(nCalls).some((c2) => c2.action === 'runcommands'));
  // The computer says the screen changed: that is the answer (not "did not confirm").
  t.handlers.runcommands = async () => ({ result: 'Exception: The screen changed since that screenshot; take a new one.\r\nPS C:\\>' });
  assert.strictEqual((await t.call('click', { ...AGENT, computer: 'demo-pc', shot, x: 5, y: 5 })).error, 'The screen changed since that screenshot; take a new one.');
  // The input has to be confirmed.
  t.handlers.runcommands = async () => ({ result: 'The computer says no' });
  const unconfirmed = await t.call('click', { ...AGENT, computer: 'demo-pc', shot, x: 5, y: 5 });
  assert.match(unconfirmed.error, /did not confirm the input/);
  assert.doesNotMatch(unconfirmed.error, /says no/);
  // A different picture size gives a different scale (a 4K screen shown at 1600 wide), and each shot keeps its own.
  t.handlers.runcommands = async (f) => ({ result: /MMSHOT/.test(decodeLine(f.cmds)) ? shotReply(1600, 900, 3840, 2160) : 'MMOK\r\n' });
  const shot4k = await shotOf(t);
  await t.call('click', { ...AGENT, computer: 'demo-pc', shot: shot4k, x: 100, y: 100 });
  const last = decodeLine(t.calls.filter((x) => x.action === 'runcommands').slice(-1)[0].fields.cmds);
  assert.match(last, /\$mmx = 240; \$mmy = 240/);
  assert.match(last, /\$mmb\.Width -ne 3840 -or \$mmb\.Height -ne 2160/);
  await t.call('click', { ...AGENT, computer: 'demo-pc', shot, x: 100, y: 100 });
  assert.match(decodeLine(t.calls.filter((x) => x.action === 'runcommands').slice(-1)[0].fields.cmds), /\$mmx = 120; \$mmy = 120[\s\S]*Width -ne 1920/);
});

test('tools: a shot id is refused when unknown, expired (10 minutes), another agent\'s or another computer\'s; an agent keeps its last 20', async () => {
  const t = setup({ settings: { levels: ['sam:drive', 'pat:drive'] } });
  t.handlers.runcommands = async (f) => ({ result: /MMSHOT/.test(decodeLine(f.cmds)) ? shotReply() : 'MMOK\r\n' });
  const NEW = 'Take a new screenshot and use its shot id.';
  const click = (who, over) => t.call('click', { __agent: who, __call: `c-${who}`, computer: 'demo-pc', x: 5, y: 5, ...over });
  const shot = await shotOf(t, 'sam');
  assert.match(shot, /^[a-z0-9]{8}$/);
  assert.deepStrictEqual(await click('sam', { shot }), { ok: true });
  const sent = t.calls.filter((c) => c.action === 'runcommands').length;
  // Another agent cannot use it, however it is written.
  assert.strictEqual((await click('pat', { shot })).error, NEW);
  assert.strictEqual((await click('pat', { shot: shot.toUpperCase() })).error, NEW);
  // Another computer: the shot belongs to demo-pc.
  assert.strictEqual((await t.call('click', { __agent: 'sam', __call: 'c', computer: ID_C, shot, x: 5, y: 5 })).error, NEW);
  // Not made up, not the wrong type.
  for (const bad of ['zzzzzzzz', '', 'short', 12345678, null, { toString: () => shot }, [shot]]) assert.strictEqual((await click('sam', { shot: bad })).error, NEW, JSON.stringify(bad));
  assert.strictEqual(t.calls.filter((c) => c.action === 'runcommands').length, sent, 'nothing was sent for any of these');
  assert.ok(!t.gateCalls.slice(-8).some((g) => g.need === 'drive' && g.agent === 'pat'), 'the owner is not asked');
  // Scroll at a place needs one too; scroll without a place does not.
  assert.strictEqual((await t.call('scroll', { __agent: 'sam', __call: 'c', computer: 'demo-pc', x: 5, y: 5, amount: 1 })).error, NEW);
  assert.strictEqual((await t.call('scroll', { __agent: 'pat', __call: 'c', computer: 'demo-pc', shot, x: 5, y: 5, amount: 1 })).error, NEW);
  assert.deepStrictEqual(await t.call('scroll', { __agent: 'sam', __call: 'c', computer: 'demo-pc', shot, x: 5, y: 5, amount: 1 }), { ok: true });
  assert.deepStrictEqual(await t.call('scroll', { __agent: 'sam', __call: 'c', computer: 'demo-pc', amount: 1 }), { ok: true });
  // Expiry: 10 minutes.
  t.time.t += 10 * 60000 - 1;
  assert.deepStrictEqual(await click('sam', { shot }), { ok: true });
  t.time.t += 1;
  assert.strictEqual((await click('sam', { shot })).error, NEW);
  // The last 20 per agent: the 21st screenshot pushes the first out.
  const ids = [];
  for (let i = 0; i < 21; i++) ids.push(await shotOf(t, 'pat'));
  assert.strictEqual(new Set(ids).size, 21);
  assert.strictEqual((await click('pat', { shot: ids[0] })).error, NEW);
  assert.deepStrictEqual(await click('pat', { shot: ids[1] }), { ok: true });
  assert.deepStrictEqual(await click('pat', { shot: ids[20] }), { ok: true });
});

test('tools: type, key and scroll are drive tools that wait for MMOK', async () => {
  const t = setup();
  t.handlers.runcommands = async (f) => ({ result: /MMSHOT/.test(decodeLine(f.cmds)) ? shotReply(1600, 900, 1920, 1080) : 'Microsoft Windows\r\nMMOK\r\nC:\\>exit\r\n' });
  const last = () => decodeLine(t.calls.filter((x) => x.action === 'runcommands').slice(-1)[0].fields.cmds);
  assert.deepStrictEqual(await t.call('type', { ...AGENT, computer: 'demo-pc', text: 'hello "world"; $x\nnext' }), { ok: true });
  const typed = last();
  assert.ok(!typed.includes('hello') && !typed.includes('world'));
  assert.strictEqual(Buffer.from(/FromBase64String\('([^']+)'\)/.exec(typed)[1], 'base64').toString('utf16le'), 'hello "world"; $x\nnext');
  assert.deepStrictEqual(await t.call('key', { ...AGENT, computer: 'demo-pc', keys: 'alt+tab' }), { ok: true });
  assert.match(last(), /Key\(18, 0\)[\s\S]*Key\(9, 0\)[\s\S]*Key\(9, 2\)[\s\S]*Key\(18, 2\)/);
  assert.deepStrictEqual(await t.call('scroll', { ...AGENT, computer: 'demo-pc', amount: -5 }), { ok: true });
  assert.match(last(), /Mouse\(0x0800, -600\)/);
  assert.doesNotMatch(last(), /SetCursorPos\(\$/);
  assert.match((await t.call('scroll', { ...AGENT, computer: 'demo-pc', x: 10, y: 10, amount: 2 })).error, /Take a new screenshot and use its shot id/);
  const shot = await shotOf(t);
  assert.deepStrictEqual(await t.call('scroll', { ...AGENT, computer: 'demo-pc', shot, x: 800, y: 450, amount: 2 }), { ok: true });
  assert.match(last(), /\$mmx = 960; \$mmy = 540/);
  assert.match(last(), /\$mmb\.Width -ne 1920 -or \$mmb\.Height -ne 1080/);
  assert.match((await t.call('scroll', { ...AGENT, computer: 'demo-pc', shot, x: 800, amount: 2 })).error, /both x and y/);
  assert.match((await t.call('scroll', { ...AGENT, computer: 'demo-pc', amount: 99 })).error, /amount/);
  assert.match((await t.call('key', { ...AGENT, computer: 'demo-pc', keys: 'ctrl+alt+powershell' })).error, /not a key I can press/);
  assert.match((await t.call('type', { ...AGENT, computer: 'demo-pc', text: 'x'.repeat(2001) })).error, /at most 2000/);
  // No reply.
  t.handlers.runcommands = async () => { throw new MeshError('timed out', 'ETIMEDOUT'); };
  assert.match((await t.call('key', { ...AGENT, computer: 'demo-pc', keys: 'enter' })).error, /^No reply from demo-pc within 20 seconds\. No one may be signed in on it \(then nothing ran\): the screen tools need someone signed in/);
});

test('tools: a timeout says the wait that really applied (err.waitMs, after the deadline clamp), not the planned one', async () => {
  const slow = (waitMs) => async () => { throw Object.assign(new MeshError('runcommands timed out', 'ETIMEDOUT'), { sent: true, waitMs }); };
  const t = setup();
  t.handlers.runcommands = slow(12000);
  assert.match((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x', timeoutSec: 60 })).error, /^No reply from demo-pc within 12 seconds\. The command may still be running/);
  const u = setup();
  u.handlers.runcommands = slow(9400);
  assert.match((await u.call('run', { ...AGENT, computer: 'demo-pc', command: 'x', timeoutSec: 60, as: 'user' })).error, /^No reply from demo-pc within 9 seconds\. No one may be signed in/);
  const s = setup();
  s.handlers.runcommands = slow(7000);
  assert.match((await s.call('screenshot', { ...AGENT, computer: 'demo-pc' })).error, /^No reply from demo-pc within 7 seconds\. No one may be signed in/);
  const k = setup();
  k.handlers.runcommands = slow(5000);
  assert.match((await k.call('key', { ...AGENT, computer: 'demo-pc', keys: 'enter' })).error, /^No reply from demo-pc within 5 seconds\. No one may be signed in/);
});

// ── nobody signed in ──
const withUsers = (users, over = {}) => ({ 'mesh//g1': [{ ...NODES['mesh//g1'][0], ...(users === undefined ? {} : { users }), ...over }, ...NODES['mesh//g1'].slice(1)] });
const NOBODY = /^No one is signed in on demo-pc\. Screen tools and 'as user' commands need a signed-in Windows desktop: run as system instead, or sign in on the PC \(set it to sign in automatically\)\.$/;

test('tools: an empty users list refuses a run as user and every screen tool at once: nothing sent, owner not asked, not busy', async () => {
  const t = setup({ handlers: { nodes: async () => ({ action: 'nodes', nodes: withUsers([]) }) } });
  t.handlers.runcommands = async () => ({ result: 'fine' });
  const calls = [['run', { command: 'whoami', as: 'user' }], ['screenshot', {}], ['click', { shot: 'abcd1234', x: 1, y: 1 }], ['type', { text: 'a' }], ['key', { keys: 'a' }], ['scroll', { amount: 1 }]];
  for (const [name, args] of calls) {
    const r = await t.call(name, { ...AGENT, computer: 'demo-pc', ...args });
    assert.match(r.error, NOBODY, name);
  }
  assert.strictEqual(t.calls.filter((c) => c.action === 'runcommands').length, 0, 'nothing was sent');
  assert.strictEqual(t.gateCalls.filter((g) => g.pc).length, 0, 'the owner was not asked (the only gate calls are the per-call identity check)');
  assert.strictEqual((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'whoami' })).output, 'fine', 'a system run still works and the computer is not busy');
});

test('tools: someone signed in, or a users list never reported, does not stop a run as user; Linux wording has no Windows', async () => {
  for (const users of [['DEMO\\sam'], undefined]) {
    const t = setup({ handlers: { nodes: async () => ({ action: 'nodes', nodes: withUsers(users) }) } });
    t.handlers.runcommands = async () => ({ result: 'ok' });
    assert.strictEqual((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'whoami', as: 'user' })).output, 'ok');
  }
  const l = setup({ handlers: { nodes: async () => ({ action: 'nodes', nodes: withUsers([], { osdesc: 'Ubuntu 24.04', agent: { id: 6 } }) }) } });
  const r = await l.call('run', { ...AGENT, computer: 'demo-pc', command: 'id', as: 'user' });
  assert.strictEqual(r.error, "No one is signed in on demo-pc. Screen tools and 'as user' commands need a signed-in desktop: run as system instead, or sign in on the PC (set it to sign in automatically).");
});

test('tools: a run as user that gets no reply says no one may be signed in and holds the computer 60 seconds; a system run keeps 10 minutes', async () => {
  const t = setup();
  t.handlers.runcommands = async () => { throw new MeshError('runcommands timed out after 5 s.', 'ETIMEDOUT'); };
  const r = await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x', as: 'user', timeoutSec: 5 });
  assert.match(r.error, /^No reply from demo-pc within 5 seconds\. No one may be signed in on it, and then nothing ran: /);
  assert.match(r.error, /run as system instead/);
  t.handlers.runcommands = async () => ({ result: 'back' });
  assert.match((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x' })).error, /busy, try again in a moment/);
  t.time.t += 59000;
  assert.match((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x' })).error, /busy/);
  t.time.t += 2000;
  assert.strictEqual((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x' })).output, 'back', 'free after 60 s');
  // A system run: today's wording and the 10-minute hold.
  t.handlers.runcommands = async () => { throw new MeshError('runcommands timed out after 5 s.', 'ETIMEDOUT'); };
  const s = await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x', timeoutSec: 5 });
  assert.match(s.error, /^No reply from demo-pc within 5 seconds\. The command may still be running/);
  t.handlers.runcommands = async () => ({ result: 'back' });
  t.time.t += 9 * 60000;
  assert.match((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x' })).error, /busy/);
  t.time.t += 2 * 60000;
  assert.strictEqual((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x' })).output, 'back');
});

test('tools: every act and drive tool asks the gate for the right level with the agent the hub named', async () => {
  const t = setup();
  t.handlers.runcommands = async (f) => ({ result: /MMSHOT/.test(decodeLine(f.cmds)) ? shotReply() : 'MMOK\r\n' });
  t.handlers.getsysinfo = async () => ({ hardware: {} });
  const plan = [
    ['computers', {}, 'look'], ['info', { computer: 'demo-pc' }, 'look'], ['screenshot', { computer: 'demo-pc' }, 'look'],
    ['run', { computer: 'demo-pc', command: 'dir' }, 'act'], ['click', { computer: 'demo-pc', x: 1, y: 1 }, 'drive'],
    ['type', { computer: 'demo-pc', text: 'a' }, 'drive'], ['key', { computer: 'demo-pc', keys: 'a' }, 'drive'], ['scroll', { computer: 'demo-pc', amount: 1 }, 'drive'],
  ];
  for (const who of ['sam', 'pat-the-agent']) {
    for (const [name, args0, level] of plan) {
      const args = name === 'click' ? { ...args0, shot: await shotOf(t, who) } : args0;
      t.gateCalls.length = 0;
      t.gateOpts.length = 0;
      const r = await t.call(name, { ...args, __agent: who, __call: `call-${who}` });
      assert.ok(!r.error, `${name}: ${r.error}`);
      if (level !== 'look') assert.deepStrictEqual(t.gateOpts.slice(-1)[0], name === 'run' ? { call: `call-${who}`, as: 'system' } : { call: `call-${who}` }, `${name}: the call id reaches the gate`);
      assert.ok(t.gateCalls.every((g) => g.agent === who), name);
      const top = t.gateCalls.slice(-1)[0];
      assert.strictEqual(top.need, level, name);
      if (name !== 'computers') assert.deepStrictEqual(top.pc, { id: ID_A, name: 'demo-pc' }, name);
    }
  }
  // The gate's refusal is the answer, in its own words, and nothing is sent to the computer.
  const refused = setup({ gateRefuses: 'sam may only look.' });
  refused.handlers.runcommands = async () => { throw new Error('must not run'); };
  refused.handlers.runcommands = async (f) => { if (/MMSHOT/.test(decodeLine(f.cmds))) return { result: shotReply() }; throw new Error('must not run'); };
  const refusedShot = await shotOf(refused, 'sam');
  for (const [name, args] of plan.slice(3)) {
    const r = await refused.call(name, { ...args, ...(name === 'click' ? { shot: refusedShot } : {}), __agent: 'sam', __call: 'call-1' });
    assert.strictEqual(r.error, 'sam may only look.', name);
  }
  assert.strictEqual(refused.calls.filter((c) => c.action === 'runcommands').length, 1, 'only the screenshot was sent');
  // The hub's word for who is calling is a string; anything else is no identity.
  const gated = setup({ realGate: true });
  for (const bad of [undefined, '', '  ', 7, { name: 'sam' }]) assert.match((await gated.call('run', { computer: 'demo-pc', command: 'x', __agent: bad })).error, /did not say which agent/);
});

test('tools: with the real gate, the first act asks the owner through the hub, then the computer gets a notice and later calls need no question', async () => {
  const t = setup({ realGate: true });
  t.handlers.runcommands = async () => ({ result: 'done' });
  const pending = t.call('run', { ...AGENT, computer: 'demo-pc', command: 'whoami' });
  await flush();
  const asks = t.lines.map((l) => JSON.parse(l)).filter((m) => m.method === 'hub/approve');
  assert.strictEqual(asks.length, 1);
  assert.deepStrictEqual(asks[0].params, {
    call: 'call-1', title: 'sam wants to use demo-pc (Abcdef)', minutes: 4,
    detail: 'For 30 minutes sam may run commands as the system account (full control) on demo-pc (Abcdef). Every action is logged. Say no if you did not expect this.',
  });
  assert.ok(!('agent' in asks[0].params), 'no agent field: the hub reads it from the call');
  assert.ok(!t.calls.some((c) => c.action === 'runcommands'), 'nothing runs before the owner answers');
  // A second request while the question is open shares it.
  const other = t.call('run', { ...AGENT, computer: 'demo-pc', command: 'hostname' });
  await flush();
  assert.strictEqual(t.lines.map((l) => JSON.parse(l)).filter((m) => m.method === 'hub/approve').length, 1);
  t.remote.onLine(JSON.stringify({ jsonrpc: '2.0', id: asks[0].id, result: { decision: 'allow' } }));
  const results = await Promise.all([pending, other]);
  assert.ok(results.some((r) => r.output === 'done'));
  const toast = t.calls.find((c) => c.action === 'toast');
  assert.deepStrictEqual(toast.fields, { nodeids: [`node//${ID_A}`], title: 'My Maestro', msg: 'sam is using this computer for the next 30 minutes.' });
  assert.strictEqual(t.lines.map((l) => JSON.parse(l)).filter((m) => m.method === 'hub/approve').length, 1);
  assert.strictEqual((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'again' })).output, 'done');
  assert.strictEqual(t.lines.map((l) => JSON.parse(l)).filter((m) => m.method === 'hub/approve').length, 1, 'the session covers it');
  // Sam's level is act: drive is refused without asking.
  t.handlers.runcommands = async () => ({ result: 'MMSHOT 1 1 1 1 x' });
  const drive = await t.call('key', { ...AGENT, computer: 'demo-pc', keys: 'a' });
  assert.match(drive.error, /Data connectors -> Remote computers -> Status and limits/);
  // A no from the owner, and the cool-down.
  const no = t.call('run', { __agent: 'pat', __call: 'call-2', computer: ID_C, command: 'x' });
  await flush();
  const ask2 = t.lines.map((l) => JSON.parse(l)).filter((m) => m.method === 'hub/approve')[1];
  t.remote.onLine(JSON.stringify({ jsonrpc: '2.0', id: ask2.id, result: { decision: 'deny' } }));
  assert.strictEqual(ask2.params.call, 'call-2', 'each question carries its own call');
  assert.match((await no).error, /said no/);
  assert.match((await t.call('run', { __agent: 'pat', __call: 'call-3', computer: ID_C, command: 'x' })).error, /a moment ago/);
  assert.strictEqual(t.lines.map((l) => JSON.parse(l)).filter((m) => m.method === 'hub/approve').length, 2);
  // A call the hub did not number cannot be approved: the owner is not asked at all.
  const t3 = setup({ realGate: true });
  t3.handlers.runcommands = async () => { throw new Error('must not run'); };
  assert.match((await t3.call('run', { __agent: 'sam', computer: 'demo-pc', command: 'x' })).error, /did not say which call/);
  assert.match((await t3.call('run', { __agent: 'sam', __call: 7, computer: 'demo-pc', command: 'x' })).error, /did not say which call/);
  assert.strictEqual(t3.lines.map((l) => JSON.parse(l)).filter((m) => m.method === 'hub/approve').length, 0);
  assert.ok(!t3.calls.some((c) => c.action === 'runcommands'));
  // The approval wait: the hub is asked to wait 4 minutes, and the module waits a little longer for the answer, well inside a 300 s call.
  assert.ok(APPROVE_HUB_TIMEOUT_MS > 4 * 60000 && APPROVE_HUB_TIMEOUT_MS < 300000, String(APPROVE_HUB_TIMEOUT_MS));
  // A hub that answers with an error is "could not ask", not a yes.
  const t2 = setup({ realGate: true });
  const p2 = t2.call('run', { ...AGENT, computer: 'demo-pc', command: 'x' });
  await flush();
  const ask3 = JSON.parse(t2.lines.find((l) => /hub\/approve/.test(l)));
  t2.remote.onLine(JSON.stringify({ jsonrpc: '2.0', id: ask3.id, error: { code: -32000, message: 'Approvals are not set up.' } }));
  assert.match((await p2).error, /could not be asked/);
});

// An approval that arrives `late` ms into the call (the clock is the test's), for an agent with the real gate.
async function approvedAfter(t, late, name, args, who = 'sam') {
  const p = t.call(name, { __agent: who, __call: `call-${name}`, computer: 'demo-pc', ...args });
  await flush();
  const ask = t.lines.map((l) => JSON.parse(l)).filter((m) => m.method === 'hub/approve').slice(-1)[0];
  t.time.t += late;
  t.remote.onLine(JSON.stringify({ jsonrpc: '2.0', id: ask.id, result: { decision: 'allow' } }));
  return p;
}

test('tools: one deadline per call (start + 290 s): an approval that leaves less than the timeout + 5 s sends nothing and says to call again', async () => {
  // run with a 60 s wait needs 65 s: an approval at 225 s still runs, one at 226 s does not.
  const ok = setup({ realGate: true });
  ok.handlers.runcommands = async () => ({ result: 'ran' });
  assert.strictEqual((await approvedAfter(ok, 225000, 'run', { command: 'x', timeoutSec: 60 })).output, 'ran');
  const late = setup({ realGate: true });
  late.handlers.runcommands = async () => ({ result: 'ran' });
  const r = await approvedAfter(late, 226000, 'run', { command: 'x', timeoutSec: 60 });
  assert.strictEqual(r.error, 'Approved for 30 minutes. Call run again to run it now.');
  assert.ok(!late.calls.some((c) => c.action === 'runcommands'), 'nothing was sent');
  // The owner said yes, so calling again needs no new question and runs at once (a new call has a new deadline).
  assert.strictEqual((await late.call('run', { ...AGENT, computer: 'demo-pc', command: 'x', timeoutSec: 60 })).output, 'ran');
  assert.strictEqual(late.lines.map((l) => JSON.parse(l)).filter((m) => m.method === 'hub/approve').length, 1);
  // The default wait is 60 s; a 300 s wait needs 305 s, which no approval can leave.
  const long = setup({ realGate: true });
  long.handlers.runcommands = async () => ({ result: 'ran' });
  assert.match((await approvedAfter(long, 1, 'run', { command: 'x', timeoutSec: 300 })).error, /^Approved for 30 minutes\. Call run again to run it now\.$/);
  // The session length in the message is the setting.
  const s5 = setup({ realGate: true, settings: { session_minutes: 45 } });
  s5.handlers.runcommands = async () => ({ result: 'ran' });
  assert.match((await approvedAfter(s5, 280000, 'run', { command: 'x' })).error, /^Approved for 45 minutes\./);
  // The drive tools wait 20 s: they need 25 s. After an approval at 266 s only 24 s are left.
  for (const [name, args] of [['key', { keys: 'a' }], ['type', { text: 'a' }], ['scroll', { amount: 1 }]]) {
    const d = setup({ realGate: true });
    d.handlers.runcommands = async () => ({ result: 'MMOK\r\n' });
    assert.deepStrictEqual(await approvedAfter(d, 265000, name, args, 'pat'), { ok: true }, `${name}: 25 s left still runs`);
    const e = setup({ realGate: true });
    e.handlers.runcommands = async () => ({ result: 'MMOK\r\n' });
    assert.strictEqual((await approvedAfter(e, 266000, name, args, 'pat')).error, `Approved for 30 minutes. Call ${name} again to run it now.`, name);
    assert.ok(!e.calls.some((c) => c.action === 'runcommands'));
  }
  // Click too (with a shot id).
  const c = setup({ realGate: true });
  c.handlers.runcommands = async (f) => ({ result: /MMSHOT/.test(decodeLine(f.cmds)) ? shotReply() : 'MMOK\r\n' });
  const shot = await shotOf(c, 'pat');
  assert.strictEqual((await approvedAfter(c, 270000, 'click', { shot, x: 5, y: 5 }, 'pat')).error, 'Approved for 30 minutes. Call click again to run it now.');
  assert.strictEqual(c.calls.filter((x) => x.action === 'runcommands').length, 1, 'only the screenshot was sent');
  // A live session is not an approval: a call that finds one is not refused for the time spent before it.
  const live = setup({ realGate: true });
  live.handlers.runcommands = async () => ({ result: 'ran' });
  await approvedAfter(live, 0, 'run', { command: 'x' });
  live.time.t += 1000;
  assert.strictEqual((await live.call('run', { ...AGENT, computer: 'demo-pc', command: 'x', timeoutSec: 300 })).output, 'ran');
});

test('tools: immediately before sending an act or drive command the session is checked again; an ended one sends nothing and frees the computer', async () => {
  let valid = true;
  const t = setup({ stillValid: () => valid });
  t.handlers.runcommands = async (f) => ({ result: /MMSHOT/.test(decodeLine(f.cmds)) ? shotReply() : 'MMOK\r\n' });
  const shot = await shotOf(t);
  const checks0 = t.stillValidCalls.length;
  assert.ok(!(await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x' })).error);
  assert.deepStrictEqual(t.stillValidCalls.slice(checks0).slice(-1)[0], { agent: 'sam', id: ID_A, need: 'act' }, 'asked for the act level, for this agent and computer');
  valid = false;
  const sent = t.calls.filter((c) => c.action === 'runcommands').length;
  const plan = [['run', { command: 'x' }, 'act'], ['click', { shot, x: 1, y: 1 }, 'drive'], ['type', { text: 'a' }, 'drive'], ['key', { keys: 'a' }, 'drive'], ['scroll', { amount: 1 }, 'drive']];
  for (const [name, args, need] of plan) {
    const r = await t.call(name, { ...AGENT, computer: 'demo-pc', ...args });
    assert.strictEqual(r.error, 'The approval for demo-pc has ended, so nothing was sent. Call the tool again to ask the owner.', name);
    assert.deepStrictEqual(t.stillValidCalls.slice(-1)[0], { agent: 'sam', id: ID_A, need }, name);
  }
  assert.strictEqual(t.calls.filter((c) => c.action === 'runcommands').length, sent, 'nothing was sent');
  valid = true;
  assert.strictEqual((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x' })).output, 'MMOK', 'the computer was not left busy');
  // Screenshots are look level and need no session.
  valid = false;
  assert.ok((await t.call('screenshot', { ...AGENT, computer: 'demo-pc' })).shot);
  // With the real gate: a session that ended is not trusted (end() is the owner's or the hub's way to cut an agent off).
  const g = setup({ realGate: true });
  g.handlers.runcommands = async () => ({ result: 'ran' });
  assert.strictEqual((await approvedAfter(g, 0, 'run', { command: 'x' })).output, 'ran');
  const sentG = g.calls.filter((c) => c.action === 'runcommands').length;
  g.time.t += 31 * 60000;
  g.handlers.runcommands = async () => ({ result: 'ran' });
  const again = g.call('run', { ...AGENT, computer: 'demo-pc', command: 'x' });
  await flush();
  assert.strictEqual(g.lines.map((l) => JSON.parse(l)).filter((m) => m.method === 'hub/approve').length, 2, 'an expired session asks the owner again');
  assert.strictEqual(g.calls.filter((c) => c.action === 'runcommands').length, sentG, 'and nothing runs before the answer');
  g.remote.onLine(JSON.stringify({ jsonrpc: '2.0', id: g.lines.map((l) => JSON.parse(l)).filter((m) => m.method === 'hub/approve')[1].id, result: { decision: 'deny' } }));
  assert.match((await again).error, /said no/);
});

// ── r3 ──────────────────────────────────────────────────────────────────────────────────────────────
test('gate: every scope has its own expiry; a later approval of another scope does not stretch it', async () => {
  const { gate, raw, clock, asked } = newGate();
  const MIN = 60000, t0 = clock.now();
  await gate.require('pat', 'act', PC, { call: 'c1', as: 'system' });   // t0: act-system until t0+30
  assert.strictEqual(asked.length, 1);
  clock.advance(29 * MIN);
  await gate.require('pat', 'drive', PC, { call: 'c2' });             // t0+29: drive until t0+59
  assert.strictEqual(asked.length, 2);
  clock.advance(2 * MIN);                                             // t0+31
  assert.strictEqual(raw.stillValid('pat', 'pc1', 'act', 'system'), false, 'the system approval ended at t0+30');
  assert.strictEqual(raw.stillValid('pat', 'pc1', 'drive'), true);
  assert.strictEqual(raw.stillValid('pat', 'pc1', 'act', 'user'), true, 'drive covers a user run');
  await gate.require('pat', 'drive', PC, { call: 'c3' });
  await gate.require('pat', 'act', PC, { call: 'c3', as: 'user' });
  assert.strictEqual(asked.length, 2, 'drive and user runs are still covered');
  await gate.require('pat', 'act', PC, { call: 'c4', as: 'system' });   // a system run asks again
  assert.strictEqual(asked.length, 3);
  assert.strictEqual(asked[2].call, 'c4');
  // the new system approval does not push drive's end (t0+59) out, and drive's does not push the system one
  clock.advance(28 * MIN + 1);                                        // t0+59 and a moment
  assert.strictEqual(raw.stillValid('pat', 'pc1', 'drive'), false, 'drive ended at t0+59');
  assert.strictEqual(raw.stillValid('pat', 'pc1', 'act', 'system'), true, 'the system run approved at t0+31 lasts to t0+61');
  const list = raw.sessions();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].level, 'act');
  assert.strictEqual(list[0].expiresAt, t0 + 61 * MIN, 'listed with the latest end');
  clock.advance(3 * MIN);
  assert.deepStrictEqual(raw.sessions(), []);
});

// A stand-in for a reconnecting client: its runcommands handler is what runs between "connected" and sock.send, so it calls the check the client is given.
function reconnecting(t, delayMs) {
  const state = { sent: 0, checkError: null };
  t.handlers.runcommands = async (f, opts) => {
    t.time.t += delayMs;   // the connection took this long
    try { opts.beforeSend(); } catch (e) { state.checkError = e; throw Object.assign(e, { sent: false }); }
    state.sent++;
    return { result: /MMSHOT/.test(decodeLine(f.cmds)) ? shotReply() : 'MMOK\r\n' };
  };
  return state;
}

test('tools: the check given to the client runs after the connection is ready; a session that ended meanwhile sends nothing', async () => {
  const t = setup({ realGate: true });
  const quick = reconnecting(t, 0);
  await approvedAfter(t, 0, 'run', { command: 'x' });
  assert.strictEqual(quick.sent, 1);
  const slow = reconnecting(t, 31 * 60000);   // connecting outlasts the 30 minute approval
  const r = await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x' });
  assert.strictEqual(r.error, 'The approval for demo-pc has ended, so nothing was sent. Call the tool again to ask the owner.');
  assert.strictEqual(slow.sent, 0);
  assert.ok(slow.checkError instanceof Error);
  // The computer was not left busy: after a new approval the next run goes out.
  const fast = reconnecting(t, 0);
  const again = t.call('run', { ...AGENT, computer: 'demo-pc', command: 'y' });
  await flush();
  const ask = t.lines.map((l) => JSON.parse(l)).filter((m) => m.method === 'hub/approve').slice(-1)[0];
  t.remote.onLine(JSON.stringify({ jsonrpc: '2.0', id: ask.id, result: { decision: 'allow' } }));
  assert.ok(!(await again).error);
  assert.strictEqual(fast.sent, 1);
});

test('tools: every command waits at most what the call has left; under 5 s left it is not sent', async () => {
  const lastRun = (t) => t.calls.filter((c) => c.action === 'runcommands').slice(-1)[0];
  const t = setup({ realGate: true });
  t.handlers.runcommands = async () => ({ result: 'ran' });
  await approvedAfter(t, 0, 'run', { command: 'x' });
  assert.strictEqual(lastRun(t).opts.timeoutMs, 60000);
  // A live session (no new approval): the 300 s wait is cut to the 290 s deadline minus the 5 s margin.
  t.time.t += 1000;
  assert.strictEqual((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x', timeoutSec: 300 })).output, 'ran');
  assert.strictEqual(lastRun(t).opts.timeoutMs, 285000);
  // Time spent finding the computer counts: 100 s gone, so at most 185 s.
  t.handlers.nodes = async () => { t.time.t += 100000; return { action: 'nodes', nodes: NODES }; };
  assert.strictEqual((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x', timeoutSec: 300 })).output, 'ran');
  assert.strictEqual(lastRun(t).opts.timeoutMs, 185000);
  // A short wait is left as it is.
  await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x', timeoutSec: 30 });
  assert.strictEqual(lastRun(t).opts.timeoutMs, 30000);
  // 4 s left after the margin: nothing is sent and the computer is free for the next call.
  const sent = t.calls.filter((c) => c.action === 'runcommands').length;
  t.handlers.nodes = async () => { t.time.t += 286000; return { action: 'nodes', nodes: NODES }; };
  assert.strictEqual((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x', timeoutSec: 5 })).error, 'Call run again; this call is out of time.');
  assert.strictEqual(t.calls.filter((c) => c.action === 'runcommands').length, sent, 'nothing was sent');
  // exactly 5 s of wait left is still sent
  t.handlers.nodes = async () => { t.time.t += 280000; return { action: 'nodes', nodes: NODES }; };
  assert.strictEqual((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x', timeoutSec: 60 })).output, 'ran');
  assert.strictEqual(lastRun(t).opts.timeoutMs, 5000);
  delete t.handlers.nodes;
  assert.strictEqual((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x' })).output, 'ran', 'not left busy');

  // Screenshot (a look tool) and the drive tools have the same deadline.
  const d = setup({ realGate: true });
  d.handlers.runcommands = async (f) => ({ result: /MMSHOT/.test(decodeLine(f.cmds)) ? shotReply() : 'MMOK\r\n' });
  const shot = await shotOf(d, 'pat');
  await approvedAfter(d, 0, 'key', { keys: 'a' }, 'pat');
  assert.strictEqual(lastRun(d).opts.timeoutMs, 20000);
  d.handlers.nodes = async () => { d.time.t += 286000; return { action: 'nodes', nodes: NODES }; };
  const sentD = d.calls.filter((c) => c.action === 'runcommands').length;
  for (const [name, args] of [['screenshot', {}], ['click', { shot, x: 5, y: 5 }], ['type', { text: 'a' }], ['key', { keys: 'a' }], ['scroll', { amount: 1 }]]) {
    assert.strictEqual((await d.call(name, { __agent: 'pat', __call: 'call-1', computer: 'demo-pc', ...args })).error, `Call ${name} again; this call is out of time.`, name);
  }
  assert.strictEqual(d.calls.filter((c) => c.action === 'runcommands').length, sentD, 'none of them was sent');
  d.handlers.nodes = async () => { d.time.t += 270000; return { action: 'nodes', nodes: NODES }; };
  assert.deepStrictEqual(await d.call('key', { __agent: 'pat', __call: 'call-1', computer: 'demo-pc', keys: 'a' }), { ok: true });
  assert.strictEqual(lastRun(d).opts.timeoutMs, 15000, 'the 20 s wait is cut to the 15 s that are left');

  // After connecting the time is looked at again.
  const c = setup({ realGate: true });
  const slow = reconnecting(c, 287000);
  await approvedAfter(c, 0, 'run', { command: 'x' });   // the approval itself is quick
  assert.strictEqual(slow.sent, 0);
  const r = await c.call('run', { ...AGENT, computer: 'demo-pc', command: 'x' });
  assert.strictEqual(r.error, 'Call run again; this call is out of time.');
  assert.strictEqual(slow.sent, 0);
  const mid = setup({ realGate: true });
  const cut = reconnecting(mid, 100000);
  await approvedAfter(mid, 0, 'run', { command: 'x', timeoutSec: 60 });
  assert.strictEqual(cut.sent, 1, 'still enough time: sent');
});

test('tools: a computer that connected less than 10 s ago has unknown users; later an empty list refuses', async () => {
  const t = setup();
  t.handlers.runcommands = async () => ({ result: 'ran' });
  const nodesWith = (agct) => () => ({ action: 'nodes', nodes: { 'mesh//g1': [{ _id: `node//${ID_A}`, name: 'demo-pc', osdesc: 'Windows 11 Pro', conn: 1, agct, agent: { id: 4, ver: 12 }, users: [] }] } });
  const asUser = () => t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x', as: 'user' });
  t.handlers.nodes = nodesWith(t.time.t - 9999);
  assert.strictEqual((await asUser()).output, 'ran', '9.999 s: unknown, so not refused');
  t.handlers.nodes = nodesWith(Math.floor((t.time.t - 3000) / 1000));   // the server may report seconds
  assert.strictEqual((await asUser()).output, 'ran', 'seconds are understood');
  t.handlers.nodes = nodesWith(t.time.t - 10000);
  assert.match((await asUser()).error, /^No one is signed in on demo-pc/, '10 s: the empty list counts');
  t.handlers.nodes = nodesWith(undefined);
  assert.match((await asUser()).error, /^No one is signed in/, 'no connect time: the list counts');
  // The screen tools use the same rule.
  t.handlers.runcommands = async () => ({ result: shotReply() });
  t.handlers.nodes = nodesWith(t.time.t - 1000);
  assert.ok((await t.call('screenshot', { ...AGENT, computer: 'demo-pc' })).shot, 'a screenshot is tried right after the connect');
  t.handlers.nodes = nodesWith(t.time.t - 60000);
  assert.match((await t.call('screenshot', { ...AGENT, computer: 'demo-pc' })).error, /^No one is signed in/);
});
