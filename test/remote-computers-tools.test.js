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
  const e = await rejects(gate.require('stranger', 'act', PC), 'ELEVEL', /Data connectors -> Remote computers -> Settings/);
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
    call: 'call-1', title: 'sam wants to use demo-pc', minutes: 4,
    detail: 'For 30 minutes sam may run commands on demo-pc. Every action is logged. Say no if you did not expect this.',
  }]);
  assert.ok(!('agent' in asked[0]), 'the hub knows the agent from the call id');
  assert.deepStrictEqual(toasts, [{ id: 'pc1', title: 'My Maestro', msg: 'sam is using this computer for the next 30 minutes.' }]);
  await gate.require('sam', 'act', PC);
  assert.strictEqual(asked.length, 1, 'the session covers the next one');
  assert.deepStrictEqual(gate.sessions(), [{ agent: 'sam', computer: { id: 'pc1', name: 'demo-pc' }, level: 'act', expiresAt: clock.now() + 30 * 60000 }]);
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

test('gate: drive covers act, act does not cover drive (it asks again with the drive wording)', async () => {
  const { gate, asked } = newGate();
  await gate.require('pat', 'act', PC);
  assert.strictEqual(asked.length, 1);
  assert.match(asked[0].detail, /may run commands on demo-pc\./);
  await gate.require('pat', 'drive', PC);
  assert.strictEqual(asked.length, 2);
  assert.match(asked[1].detail, /may run commands and use the mouse and keyboard on demo-pc\./);
  await gate.require('pat', 'act', PC);
  await gate.require('pat', 'drive', PC);
  assert.strictEqual(asked.length, 2, 'the drive session covers both');
  assert.strictEqual(gate.sessions().length, 1);
  assert.strictEqual(gate.sessions()[0].level, 'drive');
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
  const scripts = [win.clickScript({ x: 10, y: 20 }), win.typeScript({ text: 'hi' }), win.keyScript({ keys: 'ctrl+c' }), win.scrollScript({ amount: 3 })];
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
  const c = win.clickScript({ x: 960, y: 540 });
  assert.match(c, /\$mmx = 960; \$mmy = 540/);
  assert.match(c, /SetCursorPos/);
  assert.match(c, /Mouse\(2, 0\); \[MMIn\]::Pause\(30\); \[MMIn\]::Mouse\(4, 0\)/);
  const r = win.clickScript({ x: 1, y: 2, button: 'right' });
  assert.match(r, /Mouse\(8, 0\)/);
  assert.match(r, /Mouse\(16, 0\)/);
  assert.match(win.clickScript({ x: 1, y: 2, button: 'middle' }), /Mouse\(32, 0\)/);
  assert.strictEqual(win.clickScript({ x: 1, y: 2, double: true }).match(/Mouse\(2, 0\)/g).length, 2);
  assert.strictEqual(win.clickScript({ x: 1, y: 2 }).match(/Mouse\(2, 0\)/g).length, 1);
  for (const bad of [{ x: 1.5, y: 1 }, { x: '1', y: 1 }, { x: -1, y: 1 }, { x: 1, y: 99999 }, { x: 1, y: 1, button: 'left; calc' }, { x: 1, y: 1, button: 'x' }, { x: 1, y: 1, double: 'yes' }, { x: NaN, y: 1 }, { y: 1 }, {}]) {
    assert.throws(() => win.clickScript(bad), win.WindowsError, JSON.stringify(bad));
  }
  assert.match(win.scrollScript({ amount: 3 }), /Mouse\(0x0800, 360\)/);
  assert.match(win.scrollScript({ amount: -20 }), /Mouse\(0x0800, -2400\)/);
  assert.match(win.scrollScript({ x: 5, y: 6, amount: 1 }), /\$mmx = 5; \$mmy = 6[\s\S]*SetCursorPos/);
  assert.doesNotMatch(win.scrollScript({ amount: 1 }), /SetCursorPos\(\$/);
  for (const bad of [{ amount: 21 }, { amount: -21 }, { amount: 0 }, { amount: 1.5 }, { amount: '2' }, { amount: 1, x: 5 }, { amount: 1, x: 'a', y: 1 }, {}]) {
    assert.throws(() => win.scrollScript(bad), win.WindowsError, JSON.stringify(bad));
  }
});

// ── the tools, with a stand-in MeshCentral client ─────────────────────────────────────────────────
const ID_A = 'Abcdefghijkl0123456789', ID_B = 'Bcdefghijklm9876543210', ID_C = 'Cdefghijklmn1111111111', ID_D = 'Cdefghijklmn2222222222';
const NODES = {
  'mesh//g1': [
    { _id: `node//${ID_A}`, name: 'demo-pc', rname: 'DEMO-PC', osdesc: 'Windows 11 Pro', conn: 1, agct: 1783000000000, agent: { id: 4, ver: 12 } },
    { _id: `node//${ID_B}`, name: 'Laptop', osdesc: 'Windows 10', conn: 0, lastconnect: 1782000000000, agent: { id: 4, ver: 11 } },
    { _id: `node//${ID_C}`, name: 'dup', osdesc: 'Windows 10', conn: 1, agct: 1783000000000 },
    { _id: `node//${ID_D}`, name: 'Dup', osdesc: 'Windows 10', conn: 1, agct: 1783000000000 },
  ],
};
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('a picture')]);
const shotReply = (w = 1600, h = 900, sw = 1920, sh = 1080) => `Microsoft Windows [Version 10.0.22631]\r\n(c) Microsoft Corporation.\r\n\r\nC:\\Windows\\system32>powershell.exe -NoProfile ...\r\nMMSHOT ${w} ${h} ${sw} ${sh} ${JPEG.toString('base64')} MMEND\r\n\r\nC:\\Windows\\system32>exit\r\n`;

function setup(over = {}) {
  const mediaDir = 'mediaDir' in over ? over.mediaDir : tmp();
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
  const gateCalls = [], gateOpts = [];
  const fakeGate = over.realGate ? null : {
    require: async (agent, need, pc, opts) => { gateCalls.push({ agent, need, pc: pc && { id: pc.id, name: pc.name } }); gateOpts.push(opts); if (over.gateRefuses && need !== 'look') throw new GateError(over.gateRefuses, 'ELEVEL'); },
  };
  const remote = createRemote({
    env: { MODULE_SETTINGS: JSON.stringify({ levels: ['sam:act', 'pat:drive'], session_minutes: 30, ...(over.settings || {}) }), CONNECTOR_MEDIA_DIR: mediaDir },
    write: (line) => lines.push(line), log: (...a) => logs.push(a.join(' ')),
    deps: { agentClient: client, group: 'mesh//g1', now: () => time.t, ...(fakeGate ? { gate: fakeGate } : {}) },
  });
  let n = 0;
  const call = async (name, args) => {
    const r = (await remote.handle({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } })).result;
    const text = r.content[0].text;
    return r.isError ? { error: text } : JSON.parse(text);
  };
  return { remote, client, calls, lines, logs, gateCalls, gateOpts, handlers, time, mediaDir, call };
}
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
  assert.deepStrictEqual(Object.keys(by.scroll.inputSchema.properties).sort(), ['amount', 'computer', 'x', 'y']);
  assert.strictEqual(by.screenshot.inputSchema.properties.maxWidth.maximum, 1920);
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
  t.handlers.getnetworkinfo = async () => ({ action: 'getnetworkinfo', netif2: {} });
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
  });
  t.handlers.getnetworkinfo = async () => ({ action: 'getnetworkinfo', netif2: { Ethernet: [{ address: '192.168.0.20', family: 'IPv4' }, { address: 'fe80::1', family: 'IPv6' }], Loopback: [{ address: '127.0.0.1', family: 'IPv4' }], VPN: [{ address: '100.64.0.7', family: 'IPv4' }] } });
  const r = await t.call('info', { ...AGENT, computer: 'demo-pc' });
  assert.strictEqual(r.os, 'Windows 11 Pro, version 10.0.22631, 64-bit');
  assert.strictEqual(r.cpu, 'Intel(R) Core(TM) i7');
  assert.strictEqual(r.memoryGB, 32);
  assert.deepStrictEqual(r.disks, [{ drive: 'C:', sizeGB: 465.8, freeGB: 111.8 }]);
  assert.strictEqual(r.antivirus, 'Windows Defender, enabled: true, updated: true');
  assert.strictEqual(r.firewall, 'enabled: true');
  assert.strictEqual(r.pendingReboot, false);
  assert.deepStrictEqual(r.ipv4, ['192.168.0.20', '100.64.0.7']);
  assert.strictEqual(r.agentVersion, '12');
  assert.strictEqual(r.lastConnect, new Date(1783000000000).toISOString());
  assert.strictEqual(r.defender, undefined);
  const text = JSON.stringify(r);
  assert.ok(!/secret|must not appear/.test(text));
  // Only the known facts come out, whatever else the server reports (unknown fields at any depth are left out).
  const KNOWN = ['name', 'id', 'online', 'os', 'cpu', 'memoryGB', 'disks', 'antivirus', 'firewall', 'defender', 'pendingReboot', 'ipv4', 'agentVersion', 'lastConnect'];
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
  // The network answer is optional.
  t.handlers.getsysinfo = async () => ({ hardware: {} });
  t.handlers.getnetworkinfo = async () => { throw new MeshError('x', 'EMESH'); };
  const part = await t.call('info', { ...AGENT, computer: 'demo-pc' });
  assert.strictEqual(part.name, 'demo-pc');
  assert.strictEqual(part.ipv4, undefined);
});

test('tools: screenshot runs the script as the signed-in user, saves the JPEG in the Files folder and remembers the scale', async () => {
  const t = setup();
  t.handlers.runcommands = async () => ({ action: 'msg', type: 'runcommands', result: shotReply() });
  const r = await t.call('screenshot', { ...AGENT, computer: 'demo-pc', maxWidth: 1280 });
  const run = t.calls.find((c) => c.action === 'runcommands');
  assert.deepStrictEqual({ ids: run.fields.nodeids, type: run.fields.type, as: run.fields.runAsUser, ms: run.opts.timeoutMs }, { ids: [`node//${ID_A}`], type: 2, as: 2, ms: 30000 });
  assert.match(decodeLine(run.fields.cmds), /\$nw -gt 1280/);
  assert.deepStrictEqual(t.gateCalls.map((g) => g.need), ['look', 'look']);
  const comp = folderOf(ID_A);
  assert.strictEqual(comp, ID_A.slice(0, 12));
  assert.match(r.path, new RegExp(`^${t.mediaDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/${comp}/2026-11-07/090503-[0-9a-f]{4}\\.jpg$`));
  assert.ok(fs.readFileSync(r.path).equals(JPEG));
  assert.strictEqual(fs.statSync(r.path).mode & 0o777, 0o644);
  assert.deepStrictEqual({ w: r.width, h: r.height, screen: r.screen, at: r.takenAt }, { w: 1600, h: 900, screen: { width: 1920, height: 1080 }, at: new Date(t.time.t).toISOString() });
  // A second picture is a second file.
  const r2 = await t.call('screenshot', { ...AGENT, computer: 'demo-pc' });
  assert.notStrictEqual(r2.path, r.path);
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
  assert.strictEqual(r.error, 'No reply from demo-pc. The screen tools need someone signed in to Windows on it (set it to sign in automatically and not lock), or the computer is busy with another command.');
});

test('tools: the pictures kept per computer are the newest 500; a link in the way is refused', async () => {
  const mediaDir = tmp();
  const t = setup({ mediaDir });
  const comp = path.join(mediaDir, folderOf(ID_A));
  const day = path.join(comp, '2026-01-01');
  fs.mkdirSync(day, { recursive: true });
  for (let i = 0; i < 505; i++) fs.writeFileSync(path.join(day, `${String(i).padStart(6, '0')}-0000.jpg`), 'x');
  fs.writeFileSync(path.join(day, 'notes.txt'), 'not a picture');
  t.handlers.runcommands = async () => ({ result: shotReply() });
  const r = await t.call('screenshot', { ...AGENT, computer: 'demo-pc' });
  const all = (d) => fs.readdirSync(d, { withFileTypes: true });
  const pics = all(comp).filter((e) => e.isDirectory()).flatMap((e) => all(path.join(comp, e.name)).filter((f) => /\.jpg$/.test(f.name)).map((f) => `${e.name}/${f.name}`));
  assert.strictEqual(pics.length, 500);
  assert.ok(pics.includes(`2026-11-07/${path.basename(r.path)}`), 'the new one is kept');
  assert.ok(!fs.existsSync(path.join(day, '000000-0000.jpg')), 'the oldest are gone');
  assert.ok(!fs.existsSync(path.join(day, '000005-0000.jpg')), 'the 6 oldest of 506 are gone');
  assert.ok(fs.existsSync(path.join(day, '000504-0000.jpg')));
  assert.ok(fs.existsSync(path.join(day, 'notes.txt')), 'files that are not pictures are left alone');
  // Folders: a symlink where the day folder goes is refused, and nothing is written through it.
  const elsewhere = tmp();
  const media2 = tmp();
  fs.mkdirSync(path.join(media2, folderOf(ID_A)));
  fs.symlinkSync(elsewhere, path.join(media2, folderOf(ID_A), '2026-11-07'));
  const t2 = setup({ mediaDir: media2 });
  t2.handlers.runcommands = async () => ({ result: shotReply() });
  assert.match((await t2.call('screenshot', { ...AGENT, computer: 'demo-pc' })).error, /not a plain folder/);
  assert.deepStrictEqual(fs.readdirSync(elsewhere), []);
  // A link for the computer's folder, and for the Files folder itself.
  const media3 = tmp();
  fs.symlinkSync(elsewhere, path.join(media3, folderOf(ID_A)));
  const t3 = setup({ mediaDir: media3 });
  t3.handlers.runcommands = async () => ({ result: shotReply() });
  assert.match((await t3.call('screenshot', { ...AGENT, computer: 'demo-pc' })).error, /not a plain folder/);
  const linkRoot = path.join(tmp(), 'files');
  fs.symlinkSync(elsewhere, linkRoot);
  const t4 = setup({ mediaDir: linkRoot });
  t4.handlers.runcommands = async () => ({ result: shotReply() });
  assert.match((await t4.call('screenshot', { ...AGENT, computer: 'demo-pc' })).error, /not a plain folder/);
  assert.deepStrictEqual(fs.readdirSync(elsewhere), []);
  // No Files folder at all.
  const t5 = setup({ mediaDir: '' });
  t5.handlers.runcommands = async () => ({ result: shotReply() });
  assert.match((await t5.call('screenshot', { ...AGENT, computer: 'demo-pc' })).error, /no Files folder/);
  // The store on its own: a smaller keep.
  const media6 = tmp();
  const store = createShotStore({ mediaDir: media6, keep: 2, now: () => new Date(2026, 0, 2, 3, 4, 5).getTime() });
  for (let i = 0; i < 4; i++) store.save('pc-x', JPEG);
  assert.strictEqual(fs.readdirSync(path.join(media6, 'pc-x', '2026-01-02')).length, 2);
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
  assert.deepStrictEqual(t.gateOpts.filter(Boolean).slice(-1)[0], { call: 'call-1' }, 'the hub\'s call id goes to the gate');
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
  assert.ok((await t.call('screenshot', { ...AGENT, computer: 'demo-pc' })).path);
  // A command that got no answer: the run message, and a hold of 10 minutes.
  t.handlers.runcommands = async () => { throw new MeshError('runcommands timed out after 5 s.', 'ETIMEDOUT'); };
  assert.match((await t.call('run', { ...AGENT, computer: 'demo-pc', command: 'x', timeoutSec: 5 })).error, /^No reply from demo-pc within 5 seconds\. The command may still be running/);
  // A screenshot that got no answer: the screen message, and a hold of 60 seconds (not 10 minutes).
  const u = setup();
  u.handlers.runcommands = async () => { throw new MeshError('runcommands timed out after 30 s.', 'ETIMEDOUT'); };
  assert.match((await u.call('screenshot', { ...AGENT, computer: 'demo-pc' })).error, /^No reply from demo-pc\. The screen tools need someone signed in/);
  u.handlers.runcommands = async () => ({ result: shotReply() });
  assert.match((await u.call('screenshot', { ...AGENT, computer: 'demo-pc' })).error, /busy, try again in a moment/);
  u.time.t += 59000;
  assert.match((await u.call('screenshot', { ...AGENT, computer: 'demo-pc' })).error, /busy/);
  u.time.t += 2000;
  assert.ok((await u.call('screenshot', { ...AGENT, computer: 'demo-pc' })).path, 'free again after 60 s');
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

test('tools: click needs a screenshot first, checks the place is inside it, and scales to screen pixels', async () => {
  const t = setup();
  t.handlers.runcommands = async (f) => ({ result: /MMSHOT/.test(decodeLine(f.cmds)) ? shotReply(1600, 900, 1920, 1080) : 'C:\\>x\r\nMMOK\r\nC:\\>exit\r\n' });
  const before = await t.call('click', { ...AGENT, computer: 'demo-pc', x: 10, y: 10 });
  assert.match(before.error, /Take a screenshot first/);
  assert.strictEqual(t.calls.filter((c) => c.action === 'runcommands').length, 0);
  assert.ok(!t.gateCalls.some((g) => g.need === 'drive'), 'the owner is not asked for a click that cannot go anywhere');
  await t.call('screenshot', { ...AGENT, computer: 'demo-pc' });
  const ok = await t.call('click', { ...AGENT, computer: 'demo-pc', x: 800, y: 450, double: true });
  assert.deepStrictEqual(ok, { ok: true });
  const c = t.calls.filter((x) => x.action === 'runcommands').slice(-1)[0];
  assert.deepStrictEqual({ type: c.fields.type, as: c.fields.runAsUser, ms: c.opts.timeoutMs }, { type: 2, as: 2, ms: 20000 });
  const script = decodeLine(c.fields.cmds);
  assert.match(script, /\$mmx = 960; \$mmy = 540/);
  assert.strictEqual(script.match(/Mouse\(2, 0\)/g).length, 2);
  await t.call('click', { ...AGENT, computer: 'demo-pc', x: 1599, y: 899, button: 'right' });
  assert.match(decodeLine(t.calls.filter((x) => x.action === 'runcommands').slice(-1)[0].fields.cmds), /\$mmx = 1919; \$mmy = 1079/);
  const nCalls = t.calls.length;
  for (const [x, y] of [[1600, 10], [10, 900], [-1, 5], [1.5, 5], ['5', 5]]) assert.match((await t.call('click', { ...AGENT, computer: 'demo-pc', x, y })).error, /inside the last screenshot/, `${x},${y}`);
  assert.match((await t.call('click', { ...AGENT, computer: 'demo-pc', x: 1, y: 1, button: 'back' })).error, /button/);
  assert.ok(!t.calls.slice(nCalls).some((c2) => c2.action === 'runcommands'));
  // The input has to be confirmed.
  t.handlers.runcommands = async () => ({ result: 'The computer says no' });
  const unconfirmed = await t.call('click', { ...AGENT, computer: 'demo-pc', x: 5, y: 5 });
  assert.match(unconfirmed.error, /did not confirm the input/);
  assert.doesNotMatch(unconfirmed.error, /says no/);
  // A different picture size gives a different scale (a 4K screen shown at 1600 wide).
  t.handlers.runcommands = async (f) => ({ result: /MMSHOT/.test(decodeLine(f.cmds)) ? shotReply(1600, 900, 3840, 2160) : 'MMOK\r\n' });
  await t.call('screenshot', { ...AGENT, computer: 'demo-pc' });
  await t.call('click', { ...AGENT, computer: 'demo-pc', x: 100, y: 100 });
  assert.match(decodeLine(t.calls.filter((x) => x.action === 'runcommands').slice(-1)[0].fields.cmds), /\$mmx = 240; \$mmy = 240/);
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
  assert.match((await t.call('scroll', { ...AGENT, computer: 'demo-pc', x: 10, y: 10, amount: 2 })).error, /Take a screenshot first/);
  await t.call('screenshot', { ...AGENT, computer: 'demo-pc' });
  assert.deepStrictEqual(await t.call('scroll', { ...AGENT, computer: 'demo-pc', x: 800, y: 450, amount: 2 }), { ok: true });
  assert.match(last(), /\$mmx = 960; \$mmy = 540/);
  assert.match((await t.call('scroll', { ...AGENT, computer: 'demo-pc', x: 800, amount: 2 })).error, /both x and y/);
  assert.match((await t.call('scroll', { ...AGENT, computer: 'demo-pc', amount: 99 })).error, /amount/);
  assert.match((await t.call('key', { ...AGENT, computer: 'demo-pc', keys: 'ctrl+alt+powershell' })).error, /not a key I can press/);
  assert.match((await t.call('type', { ...AGENT, computer: 'demo-pc', text: 'x'.repeat(2001) })).error, /at most 2000/);
  // No reply.
  t.handlers.runcommands = async () => { throw new MeshError('timed out', 'ETIMEDOUT'); };
  assert.match((await t.call('key', { ...AGENT, computer: 'demo-pc', keys: 'enter' })).error, /^No reply from demo-pc\. The screen tools need someone signed in/);
});

test('tools: every act and drive tool asks the gate for the right level with the agent the hub named', async () => {
  const t = setup();
  t.handlers.runcommands = async (f) => ({ result: /MMSHOT/.test(decodeLine(f.cmds)) ? shotReply() : 'MMOK\r\n' });
  t.handlers.getsysinfo = async () => ({ hardware: {} });
  t.handlers.getnetworkinfo = async () => ({ netif2: {} });
  const plan = [
    ['computers', {}, 'look'], ['info', { computer: 'demo-pc' }, 'look'], ['screenshot', { computer: 'demo-pc' }, 'look'],
    ['run', { computer: 'demo-pc', command: 'dir' }, 'act'], ['click', { computer: 'demo-pc', x: 1, y: 1 }, 'drive'],
    ['type', { computer: 'demo-pc', text: 'a' }, 'drive'], ['key', { computer: 'demo-pc', keys: 'a' }, 'drive'], ['scroll', { computer: 'demo-pc', amount: 1 }, 'drive'],
  ];
  for (const who of ['sam', 'pat-the-agent']) {
    for (const [name, args, level] of plan) {
      t.gateCalls.length = 0;
      t.gateOpts.length = 0;
      const r = await t.call(name, { ...args, __agent: who, __call: `call-${who}` });
      assert.ok(!r.error, `${name}: ${r.error}`);
      if (level !== 'look') assert.deepStrictEqual(t.gateOpts.slice(-1)[0], { call: `call-${who}` }, `${name}: the call id reaches the gate`);
      assert.ok(t.gateCalls.every((g) => g.agent === who), name);
      const top = t.gateCalls.slice(-1)[0];
      assert.strictEqual(top.need, level, name);
      if (name !== 'computers') assert.deepStrictEqual(top.pc, { id: ID_A, name: 'demo-pc' }, name);
    }
  }
  // The gate's refusal is the answer, in its own words, and nothing is sent to the computer.
  const refused = setup({ gateRefuses: 'sam may only look.' });
  refused.handlers.runcommands = async () => { throw new Error('must not run'); };
  for (const [name, args] of plan.slice(3)) {
    const r = await refused.call(name, { ...args, __agent: 'sam', __call: 'call-1' });
    if (name === 'click' || name === 'scroll') continue;   // these stop earlier, at "take a screenshot first"
    assert.strictEqual(r.error, 'sam may only look.', name);
  }
  assert.ok(!refused.calls.some((c) => c.action === 'runcommands'));
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
    call: 'call-1', title: 'sam wants to use demo-pc', minutes: 4,
    detail: 'For 30 minutes sam may run commands on demo-pc. Every action is logged. Say no if you did not expect this.',
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
  assert.match(drive.error, /Data connectors -> Remote computers -> Settings/);
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
