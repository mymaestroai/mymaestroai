'use strict';
// A check step may offer a choice (a system to pick) and a button text; a check answer may carry a QR code of its one-time link.
// Covers the manifest rules, runStep, the remote-computers installer check for each system, and the page (modules.html, in a vm).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('modules-choice-b1-');
const L = (p) => require(path.join(ISO.lib, p));
const manifestLib = L('modules/manifest');
const { createModules } = L('modules');
const rcMod = require('../modules/remote-computers/index');

const FIX = path.join(__dirname, 'fixtures', 'modules', 'guarddemo');
const base = () => JSON.parse(fs.readFileSync(path.join(FIX, 'module.json'), 'utf8'));

// ── manifest ──
const CHOICE = () => ({ key: 'os', label: 'Which?', default: 'windows', options: [{ value: 'windows', label: 'Windows', note: 'A note.' }, { value: 'linux', label: 'Linux' }] });
const setupProblems = (step) => manifestLib.validateSetup({ steps: [{ id: 'add', type: 'check', check: 'installer', title: 'Add', ...step }, { id: 'done', type: 'finish', title: 'Finish' }] }, { secretNames: new Set(), settingKeys: new Set(), hasOauth: false }, { installer() {} }, {}).join(' | ');

test('manifest: a check step may carry a choice and a button text', () => {
  assert.strictEqual(setupProblems({ choice: CHOICE(), button: 'Make the link' }), '');
  assert.strictEqual(setupProblems({}), '');
  const six = { ...CHOICE(), options: ['a', 'b', 'c', 'd', 'e', 'f'].map((v) => ({ value: v, label: v })) };
  assert.strictEqual(setupProblems({ choice: { ...six, default: 'f' } }), '');
  assert.strictEqual(setupProblems({ choice: { ...CHOICE(), options: [{ value: 'windows', label: 'W', note: 'x'.repeat(200) }, { value: 'linux', label: 'L' }] } }), '');
});

test('manifest: each wrong shape of choice or button is refused in plain words', () => {
  const c = CHOICE();
  assert.match(setupProblems({ choice: 'os' }), /choice must be an object/);
  assert.match(setupProblems({ choice: { ...c, key: 'Not valid' } }), /choice\.key must be a short identifier/);
  assert.match(setupProblems({ choice: { ...c, key: undefined } }), /choice\.key/);
  assert.match(setupProblems({ choice: { ...c, label: '' } }), /choice\.label is required/);
  assert.match(setupProblems({ choice: { ...c, options: [c.options[0]] } }), /2 to 6 options/);
  assert.match(setupProblems({ choice: { ...c, options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((v) => ({ value: v, label: v })) } }), /2 to 6 options/);
  assert.match(setupProblems({ choice: { ...c, options: 'x' } }), /2 to 6 options/);
  assert.match(setupProblems({ choice: { ...c, options: [{ value: 'Bad Value', label: 'W' }, c.options[1]] } }), /value that is a short identifier/);
  assert.match(setupProblems({ choice: { ...c, options: [{ value: 'windows', label: '' }, c.options[1]] } }), /needs a label/);
  assert.match(setupProblems({ choice: { ...c, options: [{ value: 'windows', label: 'W', note: 'x'.repeat(201) }, c.options[1]] } }), /note must be text of up to 200/);
  assert.match(setupProblems({ choice: { ...c, options: [{ value: 'windows', label: 'W', note: 5 }, c.options[1]] } }), /note must be text/);
  assert.match(setupProblems({ choice: { ...c, options: [c.options[0], c.options[0]] } }), /listed twice/);
  assert.match(setupProblems({ choice: { ...c, default: 'mac' } }), /default must be one of the option values/);
  assert.match(setupProblems({ choice: { ...c, default: undefined } }), /default must be one of/);
  for (const bad of ['', '   ', 'x'.repeat(41), 5]) assert.match(setupProblems({ button: bad }), /button must be text of 1 to 40/, String(bad));
});

test('manifest: a choice or a button on any other step type is refused', () => {
  const run = (st) => manifestLib.validateSetup({ steps: [{ id: 'one', title: 'One', ...st }] }, { secretNames: new Set(), settingKeys: new Set(), hasOauth: false }, {}, {}).join(' | ');
  assert.match(run({ type: 'explain', choice: CHOICE() }), /only a check step may offer a choice/);
  assert.match(run({ type: 'finish', button: 'Go' }), /only a check step may have a button text/);
});

// ── runStep ──
function rig(indexJs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-choice-'));
  const root = path.join(dir, 'root'); fs.mkdirSync(path.join(root, 'guarddemo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'guarddemo', 'module.json'), JSON.stringify({ ...base(), settings: [] }));
  fs.writeFileSync(path.join(root, 'guarddemo', 'setup.json'), JSON.stringify({ steps: [
    { id: 'install', type: 'install', title: 'Install' },
    { id: 'pick', type: 'check', check: 'pick', title: 'Pick', button: 'Make it', choice: CHOICE() },
    { id: 'plain', type: 'check', check: 'pick', title: 'Plain' },
    { id: 'done', type: 'finish', title: 'Finish' }] }));
  fs.writeFileSync(path.join(root, 'guarddemo', 'index.js'), indexJs);
  fs.copyFileSync(path.join(FIX, 'server.js'), path.join(root, 'guarddemo', 'server.js'));
  const conns = new Map();
  const connectors = {
    list: () => ({ connectors: [...conns.values()].map((c) => ({ ...c, secretNames: [] })) }),
    upsert: (spec) => { const c = { agents: [], ...(conns.get(spec.id) || {}), ...spec }; conns.set(spec.id, c); return c; },
    stop() {}, startBackground: () => [], remove: (id) => conns.delete(id), readSecrets: () => ({}),
  };
  const mods = createModules({ root, dataDir: path.join(dir, 'modules'), stateFile: path.join(dir, 'modules.json'), connectorsFile: path.join(dir, 'connectors.json'), connectors, listAgents: () => [], publish: () => {}, log: () => {} });
  return { dir, mods, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const PICK_JS = "module.exports = { checks: { async pick(ctx) { return { ok: true, summary: 'picked ' + String(ctx.choice), lines: ['L'], once: true, qr: globalThis.__qr }; } } };";

test('runStep check: a valid choice reaches ctx.choice; an unknown, a wrong type or none becomes the default', async () => {
  const r = rig(PICK_JS);
  try {
    await r.mods.runStep('guarddemo', 'install', {});
    for (const [input, want] of [[{ choice: 'linux' }, 'linux'], [{ choice: 'mac' }, 'windows'], [{ choice: ['linux'] }, 'windows'], [{ choice: '__proto__' }, 'windows'], [{}, 'windows']]) {
      const a = await r.mods.runStep('guarddemo', 'pick', input);
      assert.strictEqual(a.result.check.summary, `picked ${want}`, JSON.stringify(input));
    }
    const plain = await r.mods.runStep('guarddemo', 'plain', { choice: 'linux' });
    assert.strictEqual(plain.result.check.summary, 'picked undefined', 'a step with no choice passes none through');
    const viaRoute = await r.mods.check('guarddemo', 'pick');
    assert.strictEqual(viaRoute.summary, 'picked undefined', 'the /check route without a choice is unchanged');
  } finally { r.cleanup(); }
});

test('runStep check: qr is returned in the answer only and never saved; without once it is dropped; a non-https or huge one is dropped', async () => {
  const r = rig(PICK_JS);
  try {
    await r.mods.runStep('guarddemo', 'install', {});
    globalThis.__qr = 'https://hub.example.ts.net/hooks/x/installer?t=abc23456';
    const a = await r.mods.runStep('guarddemo', 'pick', { choice: 'mac' });
    assert.strictEqual(a.result.check.qr, globalThis.__qr);
    assert.ok(!fs.readFileSync(path.join(r.dir, 'modules.json'), 'utf8').includes('abc23456'), 'not on disk');
    assert.ok(!JSON.stringify(a.module).includes('abc23456'), 'not in the module detail');
    assert.strictEqual(r.mods.detail('guarddemo').lastCheck.qr, undefined);
    for (const bad of ['http://hub.example.ts.net/x', 'https://' + 'a'.repeat(2000), 'not a url', 5]) {
      globalThis.__qr = bad;
      assert.strictEqual((await r.mods.runStep('guarddemo', 'pick', {})).result.check.qr, undefined, String(bad).slice(0, 30));
    }
  } finally { delete globalThis.__qr; r.cleanup(); }
  const r2 = rig("module.exports = { checks: { async pick() { return { ok: true, summary: 'ok', lines: ['visible'], qr: 'https://hub.example.ts.net/a' }; } } };");
  try {
    await r2.mods.runStep('guarddemo', 'install', {});
    assert.strictEqual((await r2.mods.runStep('guarddemo', 'pick', {})).result.check.qr, undefined, 'qr without once is dropped');
  } finally { r2.cleanup(); }
});

// ── the remote-computers installer check ──
const URL_ = 'https://hub.example.ts.net/hooks/remote-computers/installer?t=abcd2345';
const asked = [];
const ctxFor = (choice, answer) => ({ choice, settings: {}, parse: (t) => { try { return JSON.parse(t); } catch { return null; } }, callTool: async (name, args) => { asked.push([name, args]); return typeof answer === 'function' ? answer(args) : answer; } });

test('installer check, Windows (and no choice): the old lines, the Windows link asked for, a QR of the link', async () => {
  for (const choice of [undefined, 'windows', 'something-else']) {
    asked.length = 0;
    const r = await rcMod.checks.installer(ctxFor(choice, JSON.stringify({ url: URL_, os: 'windows', file: 'MyMaestro-RemoteAgent.exe' })));
    assert.deepStrictEqual(asked, [['installer_link', { os: 'windows' }]]);
    assert.strictEqual(r.ok, true); assert.strictEqual(r.once, true); assert.strictEqual(r.qr, URL_);
    assert.ok(r.lines[0].includes(URL_) && /within 15 minutes/.test(r.lines[0]));
    assert.match(r.lines[1], /MyMaestro-RemoteAgent\.exe.*choose Install.*SmartScreen/);
    assert.strictEqual(r.lines[r.lines.length - 1], 'If the link runs out, make a new one.');
    assert.ok(!r.lines.some((l) => l.startsWith('Command: ')));
  }
  // an older connector that does not say which system it made is a Windows link
  const old = await rcMod.checks.installer(ctxFor('windows', JSON.stringify({ url: URL_ })));
  assert.strictEqual(old.ok, true);
});

test('installer check, Linux: the command line, no QR', async () => {
  asked.length = 0;
  const r = await rcMod.checks.installer(ctxFor('linux', JSON.stringify({ url: URL_, os: 'linux', file: 'install-mymaestro-agent.sh' })));
  assert.deepStrictEqual(asked, [['installer_link', { os: 'linux' }]]);
  assert.strictEqual(r.ok, true); assert.strictEqual(r.once, true); assert.strictEqual(r.qr, undefined, 'a command is not scanned');
  assert.deepStrictEqual(r.lines, [
    'On the Linux computer, open a terminal and run this command within 15 minutes. It asks for your password once.',
    `Command: curl -fsSL '${URL_}' | sudo sh`,
    'It installs the remote-control agent as a service and connects it. On a computer without systemd it runs in that terminal until you close it.',
    'If the link runs out, make a new one.',
  ]);
});

test('installer check, Mac: the download, the Terminal command, the Screen Recording note, and a QR', async () => {
  asked.length = 0;
  const r = await rcMod.checks.installer(ctxFor('mac', JSON.stringify({ url: URL_, os: 'mac', file: 'MyMaestro-RemoteAgent-Mac.zip' })));
  assert.deepStrictEqual(asked, [['installer_link', { os: 'mac' }]]);
  assert.strictEqual(r.ok, true); assert.strictEqual(r.once, true); assert.strictEqual(r.qr, URL_);
  assert.ok(r.lines[0].includes(URL_) && /^On the Mac, open the link in a browser within 15 minutes/.test(r.lines[0]));
  assert.strictEqual(r.lines[1], 'It downloads MyMaestro-RemoteAgent-Mac.zip.');
  assert.strictEqual(r.lines[2], 'Then open Terminal and run:');
  assert.strictEqual(r.lines[3], 'Command: cd ~/Downloads && unzip -o MyMaestro-RemoteAgent-Mac.zip -d MyMaestroAgent && xattr -dr com.apple.quarantine MyMaestroAgent && sudo installer -pkg MyMaestroAgent/MeshAgent.pkg -target /');
  assert.match(r.lines[4], /Screen Recording: switch on meshagent\. New on a Mac: not yet proven on a real Mac\.$/);
  assert.strictEqual(r.lines[5], 'If the link runs out, make a new one.');
});

test('installer check: an older connector that answers the Windows link for Linux or Mac is refused', async () => {
  for (const choice of ['linux', 'mac']) {
    for (const answer of [{ url: URL_, os: 'windows', file: 'MyMaestro-RemoteAgent.exe' }, { url: URL_ }]) {
      const r = await rcMod.checks.installer(ctxFor(choice, JSON.stringify(answer)));
      assert.deepStrictEqual([r.ok, r.summary, r.once, r.qr], [false, 'This version can only make a Windows link.', undefined, undefined], choice);
    }
  }
});

test('installer check: no link and a thrown error stay plain failures', async () => {
  const r = await rcMod.checks.installer(ctxFor('linux', 'The installer is not ready yet.'));
  assert.strictEqual(r.ok, false);
  const e = await rcMod.checks.installer({ choice: 'mac', parse: () => null, callTool: async () => { throw new Error('boom'); } });
  assert.deepStrictEqual([e.ok, e.summary], [false, 'boom']);
});

test('the add step of the setup offers Windows, Linux and Mac, Windows first, with the notes and the button text', () => {
  const setup = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'modules', 'remote-computers', 'setup.json'), 'utf8'));
  const add = setup.steps.find((s) => s.id === 'add');
  assert.strictEqual(add.title, 'Add a computer');
  assert.strictEqual(add.button, 'Make the link');
  assert.deepStrictEqual([add.choice.key, add.choice.default], ['os', 'windows']);
  assert.deepStrictEqual(add.choice.options.map((o) => [o.value, o.label]), [['windows', 'Windows'], ['linux', 'Linux'], ['mac', 'Mac']]);
  assert.strictEqual(add.choice.options[0].note, 'Look, Act and Drive. Proven on real computers.');
  assert.strictEqual(add.choice.options[1].note, 'Look and Act. New: a test Linux computer in a container joined; the tools there are not yet proven. Screen pictures need an X11 desktop.');
  assert.strictEqual(add.choice.options[2].note, 'New: not yet proven on a real Mac. Look and Act only.');
  assert.match(add.body, /^Sign in to Tailscale on that computer with the same account, then choose what kind of computer it is and make a one-time link\. The link works once, for 15 minutes\./);
  assert.strictEqual(manifestLib.loadModule(path.join(__dirname, '..', 'modules', 'remote-computers')).problems.filter((p) => /step add/.test(p)).join('|'), '');
});

test('the computer check says nothing Windows-only about the installer or the downloaded file', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'remote-computers', 'index.js'), 'utf8');
  const part = src.slice(src.indexOf('async computer(ctx)'));
  assert.ok(!/installer|downloaded file|choose Install/i.test(part.replace(/ctx\.callTool\('[^']*'/g, '')), 'neutral words');
});

// ── the page ──
const html = fs.readFileSync(path.join(__dirname, '..', 'modules.html'), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
function load({ qrcode, qrLoads = false } = {}) {
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, innerHTML: '', textContent: '', className: '', disabled: false, classList: { add() {}, remove() {}, contains() { return false; } }, scrollIntoView() {} });
  const sent = [];
  const win = { addEventListener() {}, ...(qrcode && !qrLoads ? { qrcode } : {}) };
  let checked = null;
  const document = {
    hidden: false,
    head: { appendChild(s) { setTimeout(() => { if (qrLoads) win.qrcode = qrcode; (qrLoads ? s.onload : s.onerror)(); }, 0); } },
    getElementById: (id) => el(id),
    createElement: () => ({}),
    querySelector: (q) => (/step-choice/.test(q) && checked ? { value: checked } : null), querySelectorAll: () => [], addEventListener() {},
  };
  const fetch = async (url, opts) => {
    if (url === '/api/modules') return { ok: true, status: 200, json: async () => ({ modules: [] }) };
    if (opts && opts.method === 'POST') sent.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const copied = [];
  const ctx = vm.createContext({ document, window: win, fetch, location: { origin: 'http://hub', search: '', hash: '', pathname: '/modules' }, history: { replaceState() {} }, navigator: { clipboard: { writeText: async (t) => { copied.push(t); } } }, setTimeout, clearTimeout, setInterval, clearInterval, Date, console, URLSearchParams });
  vm.runInContext(script + '\nthis.t = { stepHtml, setCurrent(m) { current = m; }, choiceHtml, onceHtml, showOnce, runCheck, copyAdminCmd };', ctx);
  return { t: ctx.t, els, sent, copied, pick: (v) => { checked = v; } };
}
const ADD = { id: 'add', type: 'check', title: 'Add a computer', body: 'Body.', check: 'installer', button: 'Make the link', done: false, doneAt: null, choice: JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'modules', 'remote-computers', 'setup.json'), 'utf8')).steps.find((s) => s.id === 'add').choice };
const DETAIL = (step) => ({ id: 'demo', name: 'Demo', state: 'setup', steps: [step], manifest: { settings: [] }, settings: {}, candidates: [], agents: [], leads: ['owner'], leadsAlways: true, enabled: false, finishedAt: null, secretsSet: [], installed: true, lastCheck: null });

test('page: a check step with a choice shows the label, one radio per option with the note under it, the default checked, and the button text', () => {
  const { t } = load(); const m = DETAIL(ADD); t.setCurrent(m);
  const out = t.stepHtml(ADD);
  assert.match(out, /What kind of computer is it\?/);
  const radios = out.match(/<input type="radio" name="step-choice" value="[a-z]+" ?(checked)?[^>]*>/g);
  assert.strictEqual(radios.length, 3);
  assert.deepStrictEqual(radios.map((r) => /checked/.test(r)), [true, false, false], 'Windows is the default');
  assert.match(out, /<b>Linux<\/b><br><span class="dim">Look and Act\. New: a test Linux computer in a container joined; the tools there are not yet proven\. Screen pictures need an X11 desktop\.<\/span>/);
  assert.match(out, /<b>Mac<\/b><br><span class="dim">New: not yet proven on a real Mac\. Look and Act only\.<\/span>/);
  assert.match(out, /onclick="runCheck\('add', this\)">Make the link<\/button>/);
  const plain = { ...ADD, choice: undefined, button: undefined }; delete plain.choice; delete plain.button;
  const o2 = t.stepHtml(plain);
  assert.ok(!/step-choice/.test(o2));
  assert.match(o2, />Run the check<\/button>/);
});

test('page: the chosen radio is sent as choice with the step; with no radio nothing is sent', async () => {
  const a = load(); a.t.setCurrent(DETAIL(ADD)); a.pick('linux');
  await a.t.runCheck('add', null);
  const step = a.sent.find((b) => b.step === 'add');
  assert.deepStrictEqual(step.input, { acknowledged: false, choice: 'linux' });
  const b = load(); b.t.setCurrent(DETAIL(ADD));
  await b.t.runCheck('add', null);
  assert.deepStrictEqual(b.sent.find((x) => x.step === 'add').input, { acknowledged: false });
});

const QR_URL = 'https://hub.example.ts.net/hooks/remote-computers/installer?t=abcd2345';
const OC = { ok: true, once: true, summary: 'The Mac link is ready.', lines: ['Open it.', 'Command: cd ~/Downloads && echo a<b> && sudo sh', 'Last.'], qr: QR_URL };

test('page: the QR code of the link is drawn in a white box with its sentence when the script is there', async () => {
  const calls = [];
  const { t, els } = load({ qrcode: { svg: (text, o) => { calls.push([text, o]); return '<svg id="the-qr"></svg>'; } } });
  await t.showOnce(OC);
  const h = els['step-msg'].innerHTML;
  assert.strictEqual(JSON.stringify(calls), JSON.stringify([[QR_URL, { size: 168, margin: 2, dark: '#000', light: '#fff' }]]));
  assert.match(h, /<div class="qr-box" style="background:#fff[^"]*"><svg id="the-qr"><\/svg><\/div>/);
  assert.ok(h.includes("Scan it with the computer's camera or a phone to open the link there."));
});

test('page: the QR script loads late and is used; if it cannot load, nothing extra is shown and the lines stay', async () => {
  const late = load({ qrcode: { svg: () => '<svg id="late"></svg>' }, qrLoads: true });
  await late.t.showOnce(OC);
  assert.ok(late.els['step-msg'].innerHTML.includes('id="late"'));
  const none = load({});
  await none.t.showOnce(OC);
  const h = none.els['step-msg'].innerHTML;
  assert.ok(!/qr-box|<svg|Scan it/.test(h));
  assert.ok(h.includes('The Mac link is ready.') && h.includes('Open it.'));
  const noQr = load({ qrcode: { svg: () => '<svg id="x"></svg>' } });
  await noQr.t.showOnce({ ...OC, qr: undefined });
  assert.ok(!/<svg|Scan it/.test(noQr.els['step-msg'].innerHTML), 'no qr in the answer, no box');
  const broken = load({ qrcode: { svg: () => { throw new Error('too long'); } } });
  await broken.t.showOnce(OC);
  assert.ok(broken.els['step-msg'].innerHTML.includes('Open it.'), 'a failing drawing leaves the lines');
});

test('page: a "Command: " line is shown in a code box with a Copy button that copies just the command', async () => {
  const { t, els, copied } = load();
  await t.showOnce({ ...OC, qr: undefined });
  const h = els['step-msg'].innerHTML;
  assert.match(h, /<pre class="redirect-uri mono cmd-text" style="white-space:pre-wrap">cd ~\/Downloads &amp;&amp; echo a&lt;b&gt; &amp;&amp; sudo sh<\/pre> <button onclick="copyAdminCmd\(this, this\.previousElementSibling\)">Copy<\/button>/);
  assert.ok(!h.includes('Command: '), 'the prefix is not shown');
  assert.ok(h.includes('<div>Open it.</div>') && h.includes('<div>Last.</div>'));
  const btn = { textContent: 'Copy' };
  await t.copyAdminCmd(btn, { textContent: 'cd x && y' });
  assert.deepStrictEqual(copied, ['cd x && y']); assert.strictEqual(btn.textContent, 'Copied');
  // the administrator box still copies from #admin-cmd
  els['admin-cmd'] = { textContent: 'sudo admin' };
  const b2 = { textContent: 'Copy the command' };
  await t.copyAdminCmd(b2);
  assert.strictEqual(copied[1], 'sudo admin');
});
