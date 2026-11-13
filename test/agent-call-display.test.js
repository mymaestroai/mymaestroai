'use strict';
// An agent's default call display (callDisplay: none | orb | pack:<slug>): the record, its validation, the settings page.
// Nothing live: the agents file and the hub home live in a temp folder (lib/agents.js runs from a copy whose data/ is
// temporary), the character pack is a tiny synthetic one generated here, no artwork.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const vm = require('node:vm');
const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'call-display-'));
const HOME = path.join(ROOT, 'home');
fs.mkdirSync(HOME, { recursive: true });
process.env.HUB_HOME = HOME;   // before anything loads lib/hub-home

const REAL = path.join(__dirname, '..');
const INST = path.join(ROOT, 'inst');
const AGENTS_FILE = path.join(INST, 'data', 'agents.json');
fs.mkdirSync(path.join(INST, 'lib'), { recursive: true });
fs.mkdirSync(path.join(INST, 'data'), { recursive: true });
for (const f of fs.readdirSync(path.join(REAL, 'lib'))) {
  const dst = path.join(INST, 'lib', f);
  if (f === 'agents.js') fs.copyFileSync(path.join(REAL, 'lib', f), dst);
  else fs.symlinkSync(path.join(REAL, 'lib', f), dst);
}
const agentsLib = require(path.join(INST, 'lib', 'agents.js'));
const packs = require('../lib/faces/packs');

// ── a tiny synthetic pack (same shape as test/face-packs.test.js; the beak shapes a speaking pack needs) ──
function crc32(buf) { let c = 0xffffffff; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function png(w, h) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc((w * 4 + 1) * h))), chunk('IEND', Buffer.alloc(0))]);
}
function mp4() { const b = Buffer.alloc(88); b.writeUInt32BE(24, 0); b.write('ftypisom', 4, 'latin1'); b.write('isom', 16, 'latin1'); return b; }
const track = () => JSON.stringify({ fps: 24, w: 1280, h: 720, box: [0, 0, 10, 10], frames: Array.from({ length: 6 }, (_, i) => [640 + i, 360, 1, 0, 0.9]) });
function makePack(dir) {
  for (const d of ['web', 'tracks', 'beak']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const m = {
    version: 3, name: 'Test Bird', background: '#ffd6ab',
    clips: [
      { name: 'idle-one', state: 'idle', weight: 3, dur: 2, track: false, rare: false },
      { name: 'speaking-one', state: 'speaking', weight: 2, dur: 0.25, track: true, rare: false },
    ],
    beak: { roi: [10, 20, 8, 6], centre: [14, 23], shapes: ['closed', 'slight', 'half', 'wide', 'oo'], smile: 'smile', blendFrames: 3 },
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
  for (const c of m.clips) { fs.writeFileSync(path.join(dir, 'web', `${c.name}.mp4`), mp4()); if (c.track) fs.writeFileSync(path.join(dir, 'tracks', `${c.name}.json`), track()); }
  fs.writeFileSync(path.join(dir, 'beak', 'beak.json'), JSON.stringify({ roi: [10, 20, 8, 6], centre: [14, 23] }));
  for (const s of ['closed', 'slight', 'half', 'wide', 'oo', 'smile']) fs.writeFileSync(path.join(dir, 'beak', `${s}.png`), png(8, 6));
}
const packDir = (id) => path.join(HOME, 'faces', id);
const install = (id) => makePack(packDir(id));
const uninstall = (id) => { fs.rmSync(packDir(id), { recursive: true, force: true }); packs.clearCache(); };

const seed = (agents) => { fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2)); };
const onDisk = (name) => JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')).find(a => a.name === name);
const listed = async (name) => (await agentsLib.getAgents(true)).find(a => a.name === name);
const base = (extra = {}) => ({ name: 'tester', model: 'claude-sdk/default', display: 'Tester', category: 'specialist', ...extra });

before(() => { install('bird'); assert.ok(packs.getPack('bird', { home: HOME }), 'the fixture pack must be valid'); });
beforeEach(() => { seed([base()]); packs.clearCache(); });

// ── load / normalization ──
test('an agent with no callDisplay reads as none', async () => {
  assert.strictEqual((await listed('tester')).callDisplay, 'none');
});

test('valid values are kept as they are on load', async () => {
  for (const v of ['none', 'orb', 'pack:bird']) {
    seed([base({ callDisplay: v })]);
    assert.strictEqual((await listed('tester')).callDisplay, v);
  }
});

test('a saved pack that is not installed right now is preserved on load (the pack may be back soon)', async () => {
  seed([base({ callDisplay: 'pack:gone-away' })]);
  assert.strictEqual((await listed('tester')).callDisplay, 'pack:gone-away');
  assert.strictEqual(onDisk('tester').callDisplay, 'pack:gone-away', 'loading never rewrites the file');
});

test('a pack that disappears and comes back keeps the agent default', async () => {
  seed([base({ callDisplay: 'pack:bird' })]);
  uninstall('bird');
  assert.strictEqual((await listed('tester')).callDisplay, 'pack:bird');
  install('bird');
  assert.strictEqual((await listed('tester')).callDisplay, 'pack:bird');
  assert.ok(packs.getPack('bird', { home: HOME }));
});

test('syntactically invalid stored values read as none', async () => {
  for (const v of ['pack:', 'pack:Bad Slug', 'pack:../x', 'PACK:bird', 'Orb', 'orb ', 'owl', 7, {}, [], true, 'pack:' + 'a'.repeat(80)]) {
    seed([base({ callDisplay: v })]);
    assert.strictEqual((await listed('tester')).callDisplay, 'none', JSON.stringify(v));
  }
});

// ── writes ──
test('none and orb can be written; none removes the field', async () => {
  assert.deepStrictEqual(await agentsLib.updateAgentField('tester', { callDisplay: 'orb' }), { success: true });
  assert.strictEqual(onDisk('tester').callDisplay, 'orb');
  assert.strictEqual((await listed('tester')).callDisplay, 'orb');
  assert.deepStrictEqual(await agentsLib.updateAgentField('tester', { callDisplay: 'none' }), { success: true });
  assert.ok(!('callDisplay' in onDisk('tester')));
  assert.strictEqual((await listed('tester')).callDisplay, 'none');
});

test('an installed, valid pack can be written', async () => {
  const r = await agentsLib.updateAgentField('tester', { callDisplay: 'pack:bird' });
  assert.deepStrictEqual(r, { success: true });
  assert.strictEqual(onDisk('tester').callDisplay, 'pack:bird');
  assert.strictEqual((await listed('tester')).callDisplay, 'pack:bird');
});

test('a pack that is not installed is refused, and the old value stays', async () => {
  seed([base({ callDisplay: 'orb' })]);
  const r = await agentsLib.updateAgentField('tester', { callDisplay: 'pack:nothing-here' });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /not installed/);
  assert.strictEqual(onDisk('tester').callDisplay, 'orb', 'refused, not silently reset to none');
});

test('a pack that is installed but invalid is refused', async () => {
  fs.mkdirSync(packDir('broken'), { recursive: true });
  fs.writeFileSync(path.join(packDir('broken'), 'manifest.json'), '{"version":3,"name":"x","clips":[]}');
  packs.clearCache();
  seed([base({ callDisplay: 'pack:bird' })]);
  const r = await agentsLib.updateAgentField('tester', { callDisplay: 'pack:broken' });
  assert.strictEqual(r.success, false);
  assert.strictEqual(onDisk('tester').callDisplay, 'pack:bird');
});

test('a pack removed after it was chosen can no longer be written, until it is back', async () => {
  uninstall('bird');
  assert.strictEqual((await agentsLib.updateAgentField('tester', { callDisplay: 'pack:bird' })).success, false);
  install('bird');
  assert.strictEqual((await agentsLib.updateAgentField('tester', { callDisplay: 'pack:bird' })).success, true);
});

test('malformed values are refused, never turned into none', async () => {
  seed([base({ callDisplay: 'pack:bird' })]);
  for (const v of ['pack:', 'pack:../etc', 'pack:Bird', 'Orb', 'owl', 'pack:bird/../bird', 5, true, {}, ['orb']]) {
    const r = await agentsLib.updateAgentField('tester', { callDisplay: v });
    assert.strictEqual(r.success, false, JSON.stringify(v));
    assert.match(r.error, /callDisplay/);
    assert.strictEqual(onDisk('tester').callDisplay, 'pack:bird', JSON.stringify(v));
  }
});

test('empty clears to the default none', async () => {
  for (const v of [null, '']) {
    seed([base({ callDisplay: 'orb' })]);
    assert.deepStrictEqual(await agentsLib.updateAgentField('tester', { callDisplay: v }), { success: true });
    assert.ok(!('callDisplay' in onDisk('tester')));
  }
});

test('a refused callDisplay saves nothing else in the same request that came after it', async () => {
  const r = await agentsLib.updateAgentField('tester', { callDisplay: 'pack:nothing-here', blurb: 'changed' });
  assert.strictEqual(r.success, false);
  assert.ok(!onDisk('tester').blurb, 'nothing was written');
});

test('other fields still save, and an unknown agent is reported', async () => {
  assert.deepStrictEqual(await agentsLib.updateAgentField('tester', { blurb: 'hello', callDisplay: 'orb' }), { success: true });
  assert.strictEqual(onDisk('tester').blurb, 'hello');
  assert.strictEqual((await agentsLib.updateAgentField('nobody', { callDisplay: 'orb' })).success, false);
});

// ── the server boundary: members cannot change it (server.js, not edited here) ──
test('a member cannot PATCH callDisplay: the server guard, run on the real source, refuses it', async () => {
  const src = fs.readFileSync(path.join(REAL, 'server.js'), 'utf8');
  const start = src.indexOf("if (!req.hubService && !access.isAdmin(req.hubUser)) {\n        const MEMBER_EDITABLE");
  assert.ok(start > 0, 'the member guard is in server.js');
  const open = src.indexOf('{', start);
  let depth = 0, end = open;
  for (let i = open; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (!depth) { end = i; break; } } }
  const guard = src.slice(start, end + 1);
  assert.doesNotMatch(guard, /callDisplay/, 'callDisplay is not in the member allowlist');
  const run = (user, body, hubService = false) => {
    let sent = null;
    const jsonResponse = (res, code, obj) => { sent = { code, obj }; return 'sent'; };
    const fn = vm.runInNewContext(`(function (req, body, access, jsonResponse, res) { ${guard}\n return 'continued'; })`, {});
    const out = fn({ hubService, hubUser: user }, body, require('../lib/access'), jsonResponse, {});
    return { out, sent };
  };
  const member = { id: 'u2', role: 'member' }, admin = { id: 'u1', role: 'admin' };
  const refused = run(member, { callDisplay: 'orb' });
  assert.strictEqual(refused.out, 'sent');
  assert.strictEqual(refused.sent.code, 403);
  assert.match(refused.sent.obj.error, /callDisplay/);
  assert.strictEqual(run(member, { blurb: 'x' }).out, 'continued', 'a member can still change what they may');
  assert.strictEqual(run(member, { blurb: 'x', callDisplay: 'none' }).sent.code, 403);
  assert.strictEqual(run(admin, { callDisplay: 'orb' }).out, 'continued');
  assert.strictEqual(run(null, { callDisplay: 'orb' }, true).out, 'continued', 'the hub itself');
  // and the PATCH route hands the body to updateAgentField unchanged
  assert.match(src, /const result = await updateAgentField\(name, body,/);
});

// ── the settings page ──
const page = fs.readFileSync(path.join(REAL, 'agent-settings.html'), 'utf8');
const fnSrc = (name) => {
  const m = new RegExp(`(?:async )?function ${name}\\(`).exec(page);
  assert.ok(m, `${name} is in the page`);
  const open = page.indexOf('{', page.indexOf(')', m.index));
  let depth = 0;
  for (let i = open; i < page.length; i++) { if (page[i] === '{') depth++; else if (page[i] === '}') { depth--; if (!depth) return page.slice(m.index, i + 1); } }
  throw new Error('unbalanced');
};

function harness({ facesReply, patchReply } = {}) {
  const els = {};
  const mk = (tag) => ({ tag, children: [], value: '', textContent: '', appendChild(c) { this.children.push(c); if (this.children.length === 1 && !this.value) this.value = c.value; } });
  els['call-display'] = mk('select');
  Object.defineProperty(els['call-display'], 'textContent', { get() { return ''; }, set() { this.children = []; this.value = ''; } });
  const calls = [], statuses = [];
  const ctx = {
    document: { getElementById: (id) => els[id] || null, createElement: mk },
    agentName: 'tester',
    apiFetch: async (url, opts) => {
      calls.push({ url, opts });
      if (url === '/api/faces') { if (facesReply instanceof Error) throw facesReply; return facesReply; }
      return patchReply;
    },
    showStatus: (id, type, msg) => statuses.push({ id, type, msg }),
    encodeURIComponent,
  };
  vm.createContext(ctx);
  vm.runInContext(`const CALL_DISPLAY_FIXED = [{ value: 'none', label: 'None' }, { value: 'orb', label: 'Orb' }];\n${fnSrc('callDisplayOptions')}\n${fnSrc('loadCallDisplay')}\n${fnSrc('saveCallDisplay')}`, ctx);
  return { ctx, els, calls, statuses, sel: els['call-display'] };
}
const labels = (h) => h.sel.children.map(c => [c.value, c.textContent]);

test('page: a "Default call display" dropdown that starts with None and Orb, with the user-wins hint', () => {
  assert.match(page, /<label for="call-display"[^>]*>Default call display<\/label>/);
  const sel = /<select id="call-display"[^>]*>([\s\S]*?)<\/select>/.exec(page);
  assert.ok(sel);
  assert.match(sel[1], /<option value="none">None<\/option>\s*<option value="orb">Orb<\/option>/);
  assert.match(sel[0], /onchange="saveCallDisplay\(\)"/);
  const help = /<small id="call-display-help"[^>]*>([^<]*)<\/small>/.exec(page);
  assert.ok(help);
  assert.match(help[1], /own choice[^.]*wins/);
  assert.ok(!/pack:[a-z]/.test(page.replace(/'pack:' \+|pack:<id>|startsWith\('pack:'\)|'pack:'/g, '')), 'no pack id is hardcoded in the page');
});

test('page: the save is wired like the other on-change saves, and loaded with the agent', () => {
  assert.match(page, /\['saveCallDisplay', 'call-display-status', byId\('call-display'\)\]/);
  assert.match(page, /SAVES_ON_CHANGE = new Set\([^)]*'saveCallDisplay'/);
  assert.match(page, /<div id="call-display-status" class="status"><\/div>/);
  assert.match(page, /loadCallDisplay\(agent\);/);
});

test('page: installed packs from GET /api/faces are listed after None and Orb by name', async () => {
  const h = harness({ facesReply: { packs: [{ id: 'bird', name: 'Test Bird' }, { id: 'fox', name: '' }, { id: 'bird', name: 'Dup' }, { name: 'no id' }] } });
  await h.ctx.loadCallDisplay({ callDisplay: 'none' });
  assert.deepStrictEqual(h.calls.map(c => c.url), ['/api/faces']);
  assert.deepStrictEqual(labels(h), [['none', 'None'], ['orb', 'Orb'], ['pack:bird', 'Test Bird'], ['pack:fox', 'fox']]);
  assert.strictEqual(h.sel.value, 'none');
});

test('page: the saved value is selected, including a pack and a missing field', async () => {
  const faces = { packs: [{ id: 'bird', name: 'Test Bird' }] };
  for (const [agent, want] of [[{ callDisplay: 'pack:bird' }, 'pack:bird'], [{ callDisplay: 'orb' }, 'orb'], [{}, 'none'], [undefined, 'none']]) {
    const h = harness({ facesReply: faces });
    await h.ctx.loadCallDisplay(agent);
    assert.strictEqual(h.sel.value, want);
  }
});

test('page: a saved pack that is not installed stays selected, labelled unavailable', async () => {
  const h = harness({ facesReply: { packs: [{ id: 'bird', name: 'Test Bird' }] } });
  await h.ctx.loadCallDisplay({ callDisplay: 'pack:gone-away' });
  assert.deepStrictEqual(labels(h).pop(), ['pack:gone-away', 'gone-away (unavailable: not installed)']);
  assert.strictEqual(h.sel.value, 'pack:gone-away');
  assert.strictEqual(h.calls.filter(c => c.opts && c.opts.method === 'PATCH').length, 0, 'loading never writes');
});

test('page: when the list cannot be fetched the page still shows the saved value', async () => {
  for (const facesReply of [new Error('offline'), { error: 'nope' }, null]) {
    const h = harness({ facesReply });
    await h.ctx.loadCallDisplay({ callDisplay: 'pack:bird' });
    assert.deepStrictEqual(labels(h).map(l => l[0]), ['none', 'orb', 'pack:bird']);
    assert.strictEqual(h.sel.value, 'pack:bird');
  }
});

test('page: choosing a value PATCHes { callDisplay } on the normal agent path', async () => {
  const h = harness({ facesReply: { packs: [] }, patchReply: { success: true } });
  h.sel.value = 'pack:bird';
  await h.ctx.saveCallDisplay();
  const c = h.calls[0];
  assert.strictEqual(c.url, '/api/agents/tester');
  assert.strictEqual(c.opts.method, 'PATCH');
  assert.deepStrictEqual(JSON.parse(c.opts.body), { callDisplay: 'pack:bird' });
  assert.strictEqual(h.statuses.pop().type, 'success');
});

test('page: a refusal from the hub is shown, a thrown error too', async () => {
  let h = harness({ patchReply: { success: false, error: 'callDisplay: the character "x" is not installed' } });
  h.sel.value = 'pack:x';
  await h.ctx.saveCallDisplay();
  assert.deepStrictEqual(h.statuses.pop(), { id: 'call-display-status', type: 'error', msg: 'callDisplay: the character "x" is not installed' });
  h = harness({}); h.ctx.apiFetch = async () => { throw new Error('boom'); };
  h.sel.value = 'orb';
  await h.ctx.saveCallDisplay();
  assert.strictEqual(h.statuses.pop().msg, 'boom');
});

test('page: the agent record the page reads carries callDisplay (GET /api/agents returns getAgents)', async () => {
  seed([base({ callDisplay: 'pack:bird' })]);
  const rec = await listed('tester');
  const h = harness({ facesReply: { packs: packs.listPacks({ home: HOME }).map(p => ({ id: p.id, name: p.manifest.name })) } });
  await h.ctx.loadCallDisplay(rec);
  assert.deepStrictEqual(labels(h).pop(), ['pack:bird', 'Test Bird']);
  assert.strictEqual(h.sel.value, 'pack:bird');
});

test('the allowlist change is only in lib/agents (no member change in the server)', () => {
  const src = fs.readFileSync(path.join(REAL, 'lib', 'agents.js'), 'utf8');
  assert.match(src, /allowedFields = \[[^\]]*'callDisplay'\]/);
});
