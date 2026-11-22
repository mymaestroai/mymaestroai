'use strict';
// Remote computers, the one-time link for Linux and Mac computers: token kinds, what the receiver serves for each kind,
// the generated shell script. Nothing here talks to a real MeshCentral: a stand-in fetcher answers.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createTokens, createInstaller, buildLinuxScript, checkMsh, MAX_TOKENS, LINK_FILE } = require('../modules/remote-computers/lib/installer');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rc-b2-'));
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.from('a pretend program')]);
const ZIP = Buffer.concat([Buffer.from('PK'), Buffer.from([3, 4]), Buffer.from('a pretend zip')]);
const ELF_X = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from('x86 agent')]);
const ELF_A = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from('arm agent')]);
const MSH = 'MeshName=My Maestro computers\r\nMeshType=2\r\nMeshID=0xABCDEF\r\nServerID=0123456789ABCDEF\r\nMeshServer=wss://hub.example.ts.net:9972/agent.ashx\r\n';
const clock = (t = 1783000000000) => { const c = { t, now: () => c.t, advance: (ms) => { c.t += ms; } }; return c; };
const tokenOf = (url) => /[?&]t=([a-z0-9]+)/.exec(url)[1];

function rig(over = {}) {
  const c = clock();
  const asked = [];
  const answers = { mac: ZIP, 'linux-x86_64': ELF_X, 'linux-aarch64': ELF_A, msh: Buffer.from(MSH), ...(over.answers || {}) };
  const home = 'home' in over ? over.home : tmp();
  const inst = createInstaller({
    home, now: c.now, address: () => over.host || 'hub.example.ts.net',
    fetchInstaller: async () => { asked.push('windows'); return over.exe || EXE; },
    fetchPath: async ({ what }) => { asked.push(what); const a = answers[what]; if (a instanceof Error) throw a; return a; },
  });
  const get = (token, extra = {}) => inst.receive({ method: 'GET', path: 'installer', query: { t: token, ...extra } });
  return { inst, c, home, asked, get, answers };
}
async function linuxLink(r) {
  await r.inst.prepare({ os: 'linux' });
  const l = r.inst.link({ os: 'linux' });
  const script = await r.get(tokenOf(l.url));
  const agentToken = /installer\?t=([a-z0-9]+)&arch=\$ARCH/.exec(script.body)[1];
  return { l, script, agentToken };
}

// ── tokens ──
test('tokens: each has a kind; a Linux pair counts as one link and shares one expiry', () => {
  const c = clock();
  const t = createTokens({ now: c.now });
  const a = t.make('windows'), m = t.make('mac');
  assert.strictEqual(t.peek(a.token).kind, 'windows');
  assert.strictEqual(t.peek(m.token).kind, 'mac');
  assert.strictEqual(t.make().token && t.size(), 3, 'the default kind is windows');
  assert.throws(() => t.make('freebsd'));
  const t2 = createTokens({ now: c.now });
  const agent = t2.make('linux-agent');
  c.advance(1000);
  const script = t2.make('linux-script', { with: agent.token, data: 'x' });
  assert.strictEqual(script.expiresAt, agent.expiresAt, 'the same expiry');
  assert.strictEqual(t2.size(), 1, 'one link');
  assert.deepStrictEqual([t2.peek(agent.token).kind, t2.peek(script.token).kind], ['linux-agent', 'linux-script']);
});

test('tokens: a Linux link takes one of the three places, and the oldest link goes with both its tokens', () => {
  const t = createTokens({});
  const agent = t.make('linux-agent');
  const script = t.make('linux-script', { with: agent.token });
  const others = [t.make('windows'), t.make('mac')];
  assert.strictEqual(t.size(), MAX_TOKENS);
  assert.ok(t.has(agent.token) && t.has(script.token));
  const fourth = t.make('windows');
  assert.strictEqual(t.size(), MAX_TOKENS);
  assert.ok(!t.has(agent.token) && !t.has(script.token), 'both of the oldest link are gone');
  assert.ok(t.has(others[0].token) && t.has(fourth.token));
});

test('tokens: a spent token comes back whole (kind and data) when restored', () => {
  const t = createTokens({});
  const a = t.make('linux-script', {}); // data comes with a record
  const rec = t.takeRecord(a.token);
  assert.strictEqual(t.has(a.token), false);
  assert.ok(t.restore(a.token, rec));
  assert.strictEqual(t.peek(a.token).kind, 'linux-script');
});

// ── the receiver ──
test('receiver: Windows is unchanged (exe, MZ file name, cached)', async () => {
  const r = rig();
  await r.inst.prepare();
  const l = r.inst.link();
  assert.deepStrictEqual([l.os, l.file], ['windows', 'MyMaestro-RemoteAgent.exe']);
  const res = await r.get(tokenOf(l.url));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers['content-type'], 'application/octet-stream');
  assert.strictEqual(res.headers['content-disposition'], 'attachment; filename="MyMaestro-RemoteAgent.exe"');
  assert.deepStrictEqual(Buffer.from(res.bodyBase64, 'base64'), EXE);
  assert.deepStrictEqual(r.asked, ['windows']);
});

test('receiver: Mac serves the zip as MyMaestro-RemoteAgent-Mac.zip, cached for a day', async () => {
  const r = rig();
  await r.inst.prepare({ os: 'mac' });
  const l = r.inst.link({ os: 'mac' });
  assert.deepStrictEqual([l.os, l.file], ['mac', 'MyMaestro-RemoteAgent-Mac.zip']);
  const res = await r.get(tokenOf(l.url));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers['content-disposition'], 'attachment; filename="MyMaestro-RemoteAgent-Mac.zip"');
  assert.deepStrictEqual(Buffer.from(res.bodyBase64, 'base64'), ZIP);
  assert.deepStrictEqual(r.asked, ['mac'], 'fetched once, at prepare');
  assert.ok(fs.existsSync(path.join(r.home, 'installer-mac.zip')));
  await r.inst.prepare({ os: 'mac' });
  assert.deepStrictEqual(r.asked, ['mac'], 'the second preparation uses the cache');
  r.c.advance(25 * 3600000);
  await r.inst.prepare({ os: 'mac' });
  assert.deepStrictEqual(r.asked, ['mac', 'mac'], 'a day later it is fetched again');
});

test('receiver: Mac refuses a file that is not a zip, and the link is not spent', async () => {
  const r = rig({ answers: { mac: Buffer.from('<html>please sign in</html>') } });
  await assert.rejects(r.inst.prepare({ os: 'mac' }), /could not be prepared: The server did not send a zip file/);
  assert.ok(!fs.existsSync(path.join(r.home, 'installer-mac.zip')));
  const l = r.inst.link({ os: 'mac' });
  const bad = await r.get(tokenOf(l.url));
  assert.strictEqual(bad.status, 502);
  // the token was given back: with a real zip from the server the same link works
  r.answers.mac = ZIP;
  const good = await r.get(tokenOf(l.url));
  assert.strictEqual(good.status, 200);
  assert.deepStrictEqual(Buffer.from(good.bodyBase64, 'base64'), ZIP);
});

test('receiver: the zip is also refused when it is not "PK" even after a cache file is planted', async () => {
  const r = rig();
  fs.writeFileSync(path.join(r.home, 'installer-mac.zip'), 'MZ not a zip');
  fs.writeFileSync(path.join(r.home, 'installer-mac.json'), JSON.stringify({ config: require('node:crypto').createHash('sha256').update('').digest('hex') }));
  await r.inst.prepare({ os: 'mac' });
  assert.deepStrictEqual(r.asked, ['mac'], 'the planted file was not trusted');
});

test('receiver: a Linux link is a script token plus an agent token; the script has the root check, arch case, agent URL with the companion token and the msh heredoc', async () => {
  const r = rig();
  const { l, script, agentToken } = await linuxLink(r);
  assert.deepStrictEqual([l.os, l.file], ['linux', 'install-mymaestro-agent.sh']);
  assert.strictEqual(script.status, 200);
  assert.strictEqual(script.headers['content-type'], 'text/x-shellscript; charset=utf-8');
  assert.strictEqual(script.headers['content-disposition'], 'attachment; filename="install-mymaestro-agent.sh"');
  const s = script.body;
  assert.match(s, /^#!\/bin\/sh\n/);
  assert.match(s, /\nset -eu\n/);
  assert.match(s, /id -u/);
  assert.match(s, /Make a new link on your Maestro's setup page and run the command it shows\./);
  assert.match(s, /x86_64\|amd64\) ARCH=x86_64/);
  assert.match(s, /aarch64\|arm64\) ARCH=aarch64/);
  assert.match(s, /command -v curl/);
  assert.match(s, /mktemp -d/);
  assert.notStrictEqual(agentToken, tokenOf(l.url), 'the agent token is another one');
  assert.match(s, new RegExp(`curl -fsSL "https://hub\\.example\\.ts\\.net/hooks/remote-computers/installer\\?t=${agentToken}&arch=\\$ARCH"`));
  assert.ok(!s.includes(tokenOf(l.url)), 'the script does not hold its own token');
  assert.match(s, /chmod 755 "\$DIR\/meshagent"/);
  assert.match(s, /<<'MYMAESTRO_MSH_END'\nMeshName=My Maestro computers\nMeshType=2\nMeshID=0xABCDEF\nServerID=0123456789ABCDEF\nMeshServer=wss:\/\/hub\.example\.ts\.net:9972\/agent\.ashx\nMYMAESTRO_MSH_END\n/);
  assert.ok(!s.includes('\r'));
  assert.match(s, /\[ -d \/run\/systemd\/system \]/);
  assert.match(s, /\.\/meshagent -fullinstall --copy-msh=1/);
  assert.match(s, /installed as a service and will connect|installed as a service\. This computer will connect/);
  assert.match(s, /runs in this terminal until you close it/);
  assert.match(s, /exec \.\/meshagent --copy-msh=1/);
  assert.doesNotMatch(s, /meshinstall|meshagents\?|meshsettings|:9971|:9972\/mesh/);
  // opening the script is not a join yet
  assert.strictEqual(r.inst.stats().used, false);
  assert.deepStrictEqual(r.asked, ['msh'], 'only the settings were fetched ahead');
});

test('receiver: the generated script is valid shell (sh -n)', async () => {
  const r = rig();
  const { script } = await linuxLink(r);
  const dir = tmp();
  const file = path.join(dir, 'install.sh');
  fs.writeFileSync(file, script.body);
  const out = spawnSync('sh', ['-n', file], { encoding: 'utf8' });
  assert.strictEqual(out.status, 0, out.stderr);
});

test('receiver: the script refuses to run as a non-root user and an unknown processor, with plain words (run with a fake uname and id)', async () => {
  const r = rig();
  const { script } = await linuxLink(r);
  const dir = tmp(), bin = tmp();
  const file = path.join(dir, 'install.sh');
  fs.writeFileSync(file, script.body);
  const fake = (name, body) => { fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 }); };
  fake('id', 'echo 1000');
  const run = () => spawnSync('/bin/sh', [file], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` } });
  const a = run();
  assert.strictEqual(a.status, 1);
  assert.match(a.stdout, /must run as root/);
  assert.match(a.stdout, /Make a new link on your Maestro's setup page/);
  fake('id', 'echo 0');
  fake('uname', 'echo riscv64');
  const b = run();
  assert.strictEqual(b.status, 1);
  assert.match(b.stdout, /riscv64.*not supported/);
});

test('receiver: the agent token serves the ELF for its arch once, caches per arch, and spends usedAt', async () => {
  const r = rig();
  const { agentToken } = await linuxLink(r);
  assert.strictEqual(r.inst.stats().used, false);
  const a = await r.get(agentToken, { arch: 'aarch64' });
  assert.strictEqual(a.status, 200);
  assert.strictEqual(a.headers['content-type'], 'application/octet-stream');
  assert.strictEqual(a.headers['content-disposition'], 'attachment; filename="meshagent"');
  assert.deepStrictEqual(Buffer.from(a.bodyBase64, 'base64'), ELF_A);
  assert.strictEqual(r.inst.stats().used, true, 'the agent download is the join');
  assert.strictEqual((await r.get(agentToken, { arch: 'aarch64' })).status, 404, 'once');
  // a second link: x86_64 is another cache file; aarch64 comes from its own
  const second = await linuxLink(r);
  const x = await r.get(second.agentToken, { arch: 'x86_64' });
  assert.deepStrictEqual(Buffer.from(x.bodyBase64, 'base64'), ELF_X);
  const third = await linuxLink(r);
  const a2 = await r.get(third.agentToken, { arch: 'aarch64' });
  assert.deepStrictEqual(Buffer.from(a2.bodyBase64, 'base64'), ELF_A);
  assert.deepStrictEqual(r.asked.filter((w) => w.startsWith('linux-')), ['linux-aarch64', 'linux-x86_64'], 'each arch fetched once');
  assert.ok(fs.existsSync(path.join(r.home, 'installer-linux-aarch64.bin')) && fs.existsSync(path.join(r.home, 'installer-linux-x86_64.bin')));
});

test('receiver: a bad arch is a 400 in plain text and the agent token is NOT spent', async () => {
  const r = rig();
  const { agentToken } = await linuxLink(r);
  for (const arch of [undefined, '', 'arm', 'x86', 'X86_64', '../etc']) {
    const bad = await r.get(agentToken, arch === undefined ? {} : { arch });
    assert.strictEqual(bad.status, 400, String(arch));
    assert.match(bad.headers['content-type'], /^text\/plain/);
    assert.match(bad.body, /arch=x86_64 or arch=aarch64/);
  }
  assert.strictEqual((await r.get(agentToken, { arch: 'x86_64' })).status, 200, 'still works');
});

test('receiver: the agent file must start with the ELF header; a failed download gives the token back', async () => {
  const r = rig({ answers: { 'linux-x86_64': Buffer.from('<html>sign in</html>') } });
  const { agentToken } = await linuxLink(r);
  assert.strictEqual((await r.get(agentToken, { arch: 'x86_64' })).status, 502);
  assert.strictEqual(r.inst.stats().used, false);
  assert.ok(!fs.existsSync(path.join(r.home, 'installer-linux-x86_64.bin')));
  // the token was given back: with a real agent from the server the same link works
  r.answers['linux-x86_64'] = ELF_X;
  const again = await r.get(agentToken, { arch: 'x86_64' });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(r.inst.stats().used, true);
});

test('receiver: the script token is once and does not hand out the agent; the agent token never gives the script', async () => {
  const r = rig();
  const { l, script, agentToken } = await linuxLink(r);
  assert.strictEqual(script.status, 200);
  assert.strictEqual((await r.get(tokenOf(l.url), { arch: 'x86_64' })).status, 404, 'the script link is spent');
  const ag = await r.get(agentToken, { arch: 'x86_64' });
  assert.strictEqual(ag.status, 200);
  assert.deepStrictEqual(Buffer.from(ag.bodyBase64, 'base64'), ELF_X, 'a binary, not a script');
  const win = r.inst.link();   // a Windows link ignores arch and serves the exe
  await r.inst.prepare();
  const w = await r.get(tokenOf(win.url), { arch: 'aarch64' });
  assert.deepStrictEqual(Buffer.from(w.bodyBase64, 'base64'), EXE);
});

test('receiver: Linux link is refused when the settings text has a bad line or the delimiter', async () => {
  for (const bad of ['MeshName=a\nthis is not a setting\n', 'MeshName=a\n<html>sign in</html>\n', 'Mesh Name=a\n', 'MeshName=a\nMYMAESTRO_MSH_END\nrm -rf /\n', 'A=b\nMYMAESTRO_MSH_END=1\n', '', '\n\n']) {
    const r = rig({ answers: { msh: Buffer.from(bad) } });
    await assert.rejects(r.inst.prepare({ os: 'linux' }), /could not be prepared: The server did not send the group settings/, JSON.stringify(bad));
    assert.throws(() => r.inst.link({ os: 'linux' }), /not ready/);
    assert.strictEqual(r.inst.stats().made, false, 'no link was made');
  }
  assert.throws(() => checkMsh(Buffer.from('A=1\nB\n')));
  assert.strictEqual(checkMsh(Buffer.from('A=1\r\n\r\nB_2=x y\r\n')), 'A=1\nB_2=x y');
});

test('receiver: values put into the script are checked (host name, tokens)', () => {
  const ok = { host: 'hub.example.ts.net', agentToken: 'abcd2345', mshText: 'A=1' };
  assert.match(buildLinuxScript(ok), /hub\.example\.ts\.net/);
  for (const host of ['a b', 'x"; rm -rf / #', 'hub.example.ts.net/..', '$(id)', '-bad', 'a..b', '', 'h`id`', 'h\nx']) {
    assert.throws(() => buildLinuxScript({ ...ok, host }), /not a valid computer name/, JSON.stringify(host));
  }
  for (const agentToken of ['ABC', 'a;b', '', 'a b', '$(x)']) assert.throws(() => buildLinuxScript({ ...ok, agentToken }), /could not be made/, agentToken);
  const r = rig({ host: 'bad host;x' });
  return r.inst.prepare({ os: 'linux' }).then(() => assert.throws(() => r.inst.link({ os: 'linux' }), /not a valid computer name/));
});

test('receiver: the link record is written for every kind, and for Linux usedAt only at the agent download', async () => {
  const r = rig();
  for (const kind of ['windows', 'mac', 'linux']) {
    await r.inst.prepare({ os: kind });
    r.inst.link({ os: kind });
    assert.strictEqual(r.inst.stats().made, true, kind);
    assert.ok(JSON.parse(fs.readFileSync(path.join(r.home, LINK_FILE), 'utf8')).madeAt, kind);
  }
  const x = rig();
  const { script } = await linuxLink(x);
  assert.strictEqual(script.status, 200);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(x.home, LINK_FILE), 'utf8')).usedAt, null);
});

test('receiver: a kind that is not windows, linux or mac is refused by prepare and link', async () => {
  const r = rig();
  await assert.rejects(r.inst.prepare({ os: 'freebsd' }), /windows, linux or mac/);
  assert.throws(() => r.inst.link({ os: 'freebsd' }), /windows, linux or mac/);
});

// Found on a real MeshCentral 1.3.1 (the item 4 proof): /meshsettings answers about 29 KB, starting with an empty line, CRLF line ends,
// and one translation= line holding the agent's interface texts as JSON. That must pass; the 64 KB limit and the line rule still hold.
test('the group settings MeshCentral really sends pass the check: a leading empty line, CRLF and a 29 KB translation= JSON line', () => {
  const json = JSON.stringify({ en: Object.fromEntries(Array.from({ length: 700 }, (_, i) => [`text${i}`, `Some "quoted" interface text, number ${i}: it's fine.`])) });
  const raw = `\r\nMeshName=My Maestro computers\r\nMeshType=2\r\nMeshID=0x${'A'.repeat(96)}\r\nServerID=${'B'.repeat(96)}\r\nMeshServer=wss://hub.example.ts.net:9976/agent.ashx\r\ntranslation=${json}\r\n`;
  assert.ok(raw.length > 20000 && raw.length < 65536, `realistic size: ${raw.length}`);
  const out = checkMsh(Buffer.from(raw));
  assert.strictEqual(out.split('\n').length, 6);
  assert.ok(out.startsWith('MeshName=My Maestro computers\nMeshType=2\n'));
  assert.ok(buildLinuxScript({ host: 'hub.example.ts.net', agentToken: 'abcd2345', mshText: raw }).includes('translation={'));
  assert.throws(() => checkMsh(Buffer.from(`A=1\n${'x='.padEnd(70000, 'y')}\n`)), /expected form/, 'over 64 KB is still refused');
});
