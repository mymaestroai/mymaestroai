'use strict';
// The settings records (templates/settings-records.json, lib/settings-records, GET /api/settings-records).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const records = require('../lib/settings-records');
const access = require('../lib/access');

// Flip to true once the written help (help/out batches) is merged into the records: then every setting and indicator
// that keeps a home must carry its full help.
const HELP_MERGED = true;

const ROOT = path.join(__dirname, '..');
const FILES_BY_SURFACE = {
  desktop: ['app.js', 'index.html', 'comms-panel.js'],
  phone: ['mobile.js', 'mobile.html'],
  'agent-settings': ['agent-settings.html'],
  users: ['users.html'],
  modules: ['modules.html'],
  'local-models': ['local-models.html'],
  changes: ['changes.html'],
  welcome: ['welcome.html'],
  'simple-desktop': ['app.js', 'index.html'],
  'simple-phone': ['mobile.js', 'mobile.html'],
};

test('the committed JSON loads and validates; kinds are the four; every mergedInto resolves', () => {
  const all = records.all();
  assert.ok(all.length > 0);
  assert.match(records.version(), /^[0-9a-f]{40}$/);
  const ids = new Set(all.map((r) => r.id));
  assert.equal(ids.size, all.length, 'ids are unique');
  for (const r of all) {
    assert.ok(['setting', 'indicator', 'door', 'action'].includes(r.kind), `${r.id} kind ${r.kind}`);
    if (r.mergedInto) assert.ok(ids.has(r.mergedInto), `${r.id} mergedInto ${r.mergedInto}`);
  }
  assert.equal(records.byId(all[0].id), all[0]);
  assert.equal(records.byId('OPT-nope'), null);
});

test('validate refuses a broken file with a clear error', () => {
  const good = () => ({ version: 'v', records: [{ id: 'OPT-0001', kind: 'setting', name: 'A', labels: [], words: [], restart: false, danger: 'everyday', who: 'both', lead: 'none', anchors: [] }] });
  assert.doesNotThrow(() => records.validate(good()));
  const cases = [
    (d) => { d.records.push({ ...d.records[0] }); },                                  // duplicate id
    (d) => { d.records[0].kind = 'switch'; },
    (d) => { d.records[0].danger = 'high'; },
    (d) => { d.records[0].who = 'owner'; },
    (d) => { d.records[0].lead = 'always'; },
    (d) => { d.records[0].mergedInto = 'OPT-9999'; },
    (d) => { d.records[0].anchors = [{ surface: 'desktop', selector: 'no-hash' }]; },
    (d) => { d.records[0].anchors = [{ surface: 'nowhere', selector: '#x' }]; },
    (d) => { d.records[0].restart = 'no'; },
    (d) => { d.records[0].anchors = [{ surface: 'desktop', selector: '#x', label: 'X' }]; },   // both
    (d) => { d.records[0].anchors = [{ surface: 'desktop' }]; },                              // neither
    (d) => { d.records[0].anchors = [{ surface: 'desktop', label: '' }]; },
    (d) => { d.records[0].anchors = [{ surface: 'desktop', label: '   ' }]; },
    (d) => { d.records[0].anchors = [{ surface: 'desktop', label: 7 }]; },
    (d) => { d.records[0].anchors = [{ surface: 'nowhere', label: 'X' }]; },
  ];
  for (const mutate of cases) {
    const d = good(); mutate(d);
    assert.throws(() => records.validate(d), /settings-records:/);
  }
});

test('validate accepts an anchor by id and an anchor by label, on the page and Simple surfaces', () => {
  const d = { version: 'v', records: [{ id: 'OPT-0001', kind: 'setting', name: 'A', labels: [], words: [], restart: false, danger: 'everyday', who: 'both', lead: 'none',
    anchors: [{ surface: 'desktop', selector: '#a' }, { surface: 'desktop', label: 'Quiet hours' }, { surface: 'simple-desktop', label: 'Theme' }, { surface: 'simple-phone', selector: '#b' }] }] };
  assert.doesNotThrow(() => records.validate(d));
});

test('the committed records: label anchors are non-empty words, doors and actions carry no anchors, and some rows are found by label', () => {
  let byLabel = 0;
  for (const r of records.all()) {
    if ((r.kind === 'door' || r.kind === 'action') && !r.mergedInto) assert.deepEqual(r.anchors, [], `${r.id} (${r.kind}) has anchors`);
    for (const a of r.anchors) if (a.label !== undefined) {
      byLabel++;
      assert.ok(typeof a.label === 'string' && a.label.trim() === a.label && a.label.length > 0 && a.label.length <= 60, `${r.id}: label ${JSON.stringify(a.label)}`);
      assert.ok(!('selector' in a), `${r.id}: both selector and label`);
    }
  }
  assert.ok(byLabel > 0);
});

test('every anchor selector id appears literally in its surface\'s files', () => {
  const text = {};
  const read = (f) => (text[f] = text[f] || fs.readFileSync(path.join(ROOT, f), 'utf8'));
  let n = 0;
  for (const r of records.all()) {
    for (const a of r.anchors) {
      if (a.selector === undefined) continue;   // anchored by label: nothing to look up
      const files = FILES_BY_SURFACE[a.surface];
      assert.ok(files, `${r.id}: unknown surface ${a.surface}`);
      let found;
      const attr = /^\[data-setting="(OPT-\d+)"\]$/.exec(a.selector);
      if (attr) {
        // a control with no id of its own carries data-setting; a generated row names its record in a map next to the code that builds it
        found = files.some((f) => read(f).includes(`data-setting="${attr[1]}"`) || (read(f).includes('data-setting') && read(f).includes(`'${attr[1]}'`)));
      } else {
        const id = a.selector.slice(1);
        // id="x" in the markup, or the id as a quoted word where a helper writes the id (sel('st-cl-provider', ...))
        found = files.some((f) => read(f).includes(`id="${id}"`) || read(f).includes(`id='${id}'`) || read(f).includes(`'${id}'`));
        // the provider inputs are drawn in a loop: id="st-key-${p.id}" for each provider of PROVIDERS ({ id: 'perplexity', … })
        const prov = /^st-(key|url)-([a-z]+)$/.exec(id);
        if (!found && prov) found = files.some((f) => read(f).includes('id="st-' + prov[1] + '-${p.id}"') && read(f).includes(`{ id: '${prov[2]}',`));
      }
      assert.ok(found, `${r.id}: ${a.selector} is not in ${files.join(' / ')} (renamed?)`);
      n++;
    }
  }
  assert.ok(n > 0);
});

test('completeness: every kept setting and indicator has its full help', (t) => {
  if (!HELP_MERGED) return t.skip('help/out is not merged into the records yet (HELP_MERGED is false)');
  const missing = [];
  for (const r of records.all()) {
    if (r.mergedInto || (r.kind !== 'setting' && r.kind !== 'indicator')) continue;
    const ok = ['name', 'what', 'when', 'risk', 'def'].every((k) => typeof r[k] === 'string' && r[k].trim())
      && typeof r.restart === 'boolean' && Array.isArray(r.words) && r.words.length >= 3;
    if (!ok) missing.push(r.id);
  }
  assert.deepEqual(missing, [], `${missing.length} records without full help`);
});

test('route body: a member gets only member/both records without facts or storedAs; an admin gets all', () => {
  const all = records.all();
  const member = records.routeBody({ id: 'u2', role: 'member' }, { isAdmin: false });
  const admin = records.routeBody({ id: 'u1', role: 'admin' }, { isAdmin: true });
  assert.equal(member.leadTool, false);
  assert.equal(member.version, records.version());
  assert.equal(admin.records.length, all.length);
  assert.ok(member.records.length > 0 && member.records.length < all.length);
  for (const r of member.records) assert.ok(r.who === 'member' || r.who === 'both', `${r.id} who ${r.who}`);
  const memberIds = new Set(member.records.map((r) => r.id));
  assert.deepEqual([...memberIds].sort(), all.filter((r) => r.who !== 'admin').map((r) => r.id).sort());
  for (const r of [...member.records, ...admin.records]) {
    assert.ok(!('facts' in r) && !('storedAs' in r), `${r.id} leaks a hidden field`);
  }
  // the stored records do carry them (so the view really removes something)
  assert.ok(all.some((r) => 'storedAs' in r));
  assert.equal(records.view({ id: 'x', facts: 'f', storedAs: 's', name: 'n' }).name, 'n');
});

// ── who may see a record, danger and lead, the group name, anchors ─────────────────────────────────────────────────────
const MEMBER_INSTALL = require('../scripts/build-settings-records.js').MEMBER_INSTALL;
const memberSet = () => records.forUser({ id: 'sam', role: 'member' }, { isAdmin: false });

test('a member never gets the install-wide, key, backup, lockbox, sandbox and approval records', () => {
  const ids = new Set(memberSet().map((r) => r.id));
  for (const id of ['OPT-0309', 'OPT-0327', 'OPT-0340', 'OPT-0341', 'OPT-0342', 'OPT-0343', 'OPT-0344', 'OPT-0345', 'OPT-0424', 'OPT-0431', 'OPT-0440', 'OPT-0445']) {
    assert.ok(records.byId(id), `${id} exists`);
    assert.ok(!ids.has(id), `${id} is visible to a member`);
  }
});

test('install-wide records stay visible to a member only when MEMBER_INSTALL says why', () => {
  for (const r of memberSet()) {
    if (/(^|[^a-z])install([^a-z]|$)/.test(r.scope)) assert.ok(MEMBER_INSTALL[r.id], `${r.id} (${r.scope}, ${r.name}) is install-wide and visible to a member but not in MEMBER_INSTALL`);
  }
  for (const [id, why] of Object.entries(MEMBER_INSTALL)) {
    assert.ok(typeof why === 'string' && why.length > 10 && !/\n/.test(why), `${id} needs a one-line reason`);
    assert.notEqual(records.byId(id).who, 'admin', `${id} is listed in MEMBER_INSTALL but is admin only`);
  }
});

test('no record visible to a member points (mergedInto) at one they cannot see; the route drops such pointers', () => {
  const ids = new Set(memberSet().map((r) => r.id));
  for (const r of memberSet()) if (r.mergedInto) assert.ok(ids.has(r.mergedInto), `${r.id} is merged into ${r.mergedInto}, which a member cannot see`);
  const body = records.routeBody({ id: 'sam', role: 'member' }, { isAdmin: false });
  for (const r of body.records) if (r.mergedInto) assert.ok(ids.has(r.mergedInto), `${r.id} sent with mergedInto ${r.mergedInto}`);
  // view() drops a pointer outside the set it is given
  assert.equal(records.view({ id: 'OPT-0001', name: 'a', mergedInto: 'OPT-0002' }, new Set(['OPT-0001'])).mergedInto, undefined);
  assert.equal(records.view({ id: 'OPT-0001', name: 'a', mergedInto: 'OPT-0002' }, new Set(['OPT-0002'])).mergedInto, 'OPT-0002');
  assert.equal(records.view({ id: 'OPT-0001', name: 'a', mergedInto: 'OPT-0002' }).mergedInto, 'OPT-0002');
});

test('danger and lead: dangerous is admin-only and never applied by the lead; per-person and per-device records are not dangerous', () => {
  for (const r of records.all()) {
    if (r.danger === 'dangerous') {
      assert.equal(r.who, 'admin', `${r.id} ${r.name}: dangerous but who ${r.who}`);
      assert.notEqual(r.lead, 'apply', `${r.id} ${r.name}: dangerous with lead apply`);
    }
    if ((r.scope === 'per-person' || r.scope === 'per-device') && r.who !== 'admin') assert.notEqual(r.danger, 'dangerous', `${r.id} ${r.name}: a per-person or per-device preference is dangerous`);
  }
  const by = (id) => records.byId(id);
  for (const id of ['OPT-0085', 'OPT-0148', 'OPT-0237', 'OPT-0779', 'OPT-1021', 'OPT-1022', 'OPT-1071']) assert.equal(by(id).danger, 'everyday', `${id} ${by(id).name}`);
  for (const id of ['OPT-0303', 'OPT-0497', 'OPT-0639', 'OPT-0641', 'OPT-0642', 'OPT-0643', 'OPT-0968', 'OPT-0629']) {
    assert.notEqual(by(id).danger, 'everyday', `${id} ${by(id).name} changes access, credentials or money`);
    assert.notEqual(by(id).lead, 'apply', `${id} ${by(id).name}: the lead must not apply it`);
  }
  assert.equal(by('OPT-0629').lead, 'screen');
  assert.throws(() => records.validate({ version: 'v', records: [{ id: 'OPT-0001', kind: 'setting', name: 'A', labels: [], words: [], restart: false, danger: 'dangerous', who: 'both', lead: 'none', anchors: [] }] }), /dangerous/);
  assert.throws(() => records.validate({ version: 'v', records: [{ id: 'OPT-0001', kind: 'setting', name: 'A', labels: [], words: [], restart: false, danger: 'dangerous', who: 'admin', lead: 'apply', anchors: [] }] }), /apply/);
  assert.doesNotThrow(() => records.validate({ version: 'v', records: [{ id: 'OPT-0001', kind: 'setting', name: 'A', labels: [], words: [], restart: false, danger: 'dangerous', who: 'admin', lead: 'screen', anchors: [] }] }));
});

test('no home says "Needs you": the group is "For your review"', () => {
  let review = 0;
  for (const r of records.all()) {
    assert.ok(!/Needs you/.test(r.home || ''), `${r.id}: home ${r.home}`);
    if (/For your review/.test(r.home || '')) review++;
  }
  assert.ok(review >= 40, `${review} records are homed under For your review`);
  assert.throws(() => records.validate({ version: 'v', records: [{ id: 'OPT-0001', kind: 'setting', name: 'A', labels: [], words: [], restart: false, danger: 'everyday', who: 'both', lead: 'none', home: 'Settings > Needs you', anchors: [] }] }), /Needs you/);
});

test('anchors: no selector belongs to two records on one surface (an alias shares its target\'s)', () => {
  const byId = new Map(records.all().map((r) => [r.id, r]));
  const root = (r) => { let x = r; const seen = new Set(); while (x.mergedInto && !seen.has(x.id)) { seen.add(x.id); x = byId.get(x.mergedInto) || x; } return x.id; };
  const owner = new Map();
  for (const r of records.all()) for (const a of r.anchors) {
    if (a.selector === undefined) continue;
    const k = `${a.surface}|${a.selector}`;
    if (owner.has(k)) assert.equal(owner.get(k), root(r), `${k} is used by ${r.id} and by another record`);
    else owner.set(k, root(r));
  }
  // the controls that used to share one
  const sel = (id, surface) => (byId.get(id).anchors.find((a) => a.surface === surface && a.selector) || {}).selector;
  assert.equal(sel('OPT-0372', 'desktop'), '#st-cl-provider');
  assert.equal(sel('OPT-0373', 'desktop'), '#st-cl-model');
  assert.equal(sel('OPT-0374', 'desktop'), '#st-cl-think');
  assert.equal(sel('OPT-0375', 'desktop'), '#st-cl-floor');
  assert.equal(sel('OPT-0376', 'desktop'), '#st-cl-shadow');
  const perms = ['OPT-0008', 'OPT-0009', 'OPT-0010', 'OPT-0011', 'OPT-0012', 'OPT-0013', 'OPT-0014'];
  for (const id of perms) assert.equal(sel(id, 'agent-settings'), `[data-setting="${id}"]`);
  for (const id of ['OPT-0017', 'OPT-0018']) assert.ok(sel(id, 'agent-settings'), `${id} has its own control`);
  assert.equal(sel('OPT-0016', 'agent-settings'), '#root-grant-status');
  assert.equal(sel('OPT-0017', 'agent-settings'), '#policy-folders');
  assert.equal(sel('OPT-0018', 'agent-settings'), '#policy-roots');
});

test('the agent page puts data-setting on every permission row and file tab', () => {
  const page = fs.readFileSync(path.join(ROOT, 'agent-settings.html'), 'utf8');
  // the permission's ⓘ sits in the row's first cell, on the element holding the permission's name, never on the <tr>
  assert.doesNotMatch(page, /tr\.setAttribute\('data-setting'/);
  assert.match(page, /<td style="padding:6px;"><b\$\{nameAttr\}[^>]*>\$\{escapeHtml\(cls\)\}<\/b>/);
  assert.match(page, /const nameAttr = POLICY_RECORD_IDS\[cls\] \? ` data-setting="\$\{POLICY_RECORD_IDS\[cls\]\}"` : ''/);
  assert.match(page, /tab\.setAttribute\('data-setting', FILE_TAB_RECORD_IDS\[fname\]\)/);
  for (const id of ['OPT-0008', 'OPT-0014', 'OPT-0068', 'OPT-0073']) assert.ok(page.includes(`'${id}'`), id);
});

test('access, spending, credentials and recording consent are never everyday + apply; the apply risk check exists and the records pass it', () => {
  const named = { 'OPT-0034': 'Who can download recordings', 'OPT-0598': 'Who can look at cameras', 'OPT-0575': 'Who can read Oura data', 'OPT-0565': 'Which agents may use the module',
    'OPT-0504': 'Telegram recipients', 'OPT-0347': 'Ollama address', 'OPT-0346': 'LM Studio address', 'OPT-0348': 'oMLX address', 'OPT-0608': 'Face recognizer address',
    'OPT-0350': 'OpenRouter', 'OPT-0567': 'Google Drive backup copy', 'OPT-0153': "Protect Maestro's own code", 'OPT-0562': 'Switch on / Switch off',
    'OPT-0036': 'Announce the recording', 'OPT-0033': 'Keep call recordings' };
  for (const [id, name] of Object.entries(named)) {
    const r = records.byId(id);
    assert.ok(r, id);
    assert.notEqual(r.danger, 'everyday', `${id} ${name}: danger`);
    assert.notEqual(r.lead, 'apply', `${id} ${name}: lead`);
  }
  // the risk text of any record that is applied at once must not say it grants access, sends data out or costs money, unless the override says applyOk
  const RISKY = /costs? money|per use|are sent|sent there|can (see|read|hear|download|use)|who can|recipients|address/i;
  const applyOk = ['OPT-0227', 'OPT-0645'];
  for (const r of records.all()) if (r.lead === 'apply' && RISKY.test(r.risk || '')) assert.ok(applyOk.includes(r.id), `${r.id} ${r.name}: lead apply with risk "${r.risk}"`);
  // the generator refuses it too
  const gen = fs.readFileSync(path.join(ROOT, 'scripts', 'build-settings-records.js'), 'utf8');
  assert.match(gen, /const APPLY_RISK_RE = \/costs\? money\|per use\|are sent\|sent there\|can \(see\|read\|hear\|download\|use\)\|who can\|recipients\|address\/i/);
  assert.match(gen, /r\.lead === 'apply' && APPLY_RISK_RE\.test\(r\.risk \|\| ''\) && !applyOk\.has\(r\.id\)/);
  assert.match(gen, /'applyOk'/);
});

test('OPT-0749 File size limit is an install-wide indicator without a confirm step', () => {
  const r = records.byId('OPT-0749');
  assert.equal(r.scope, 'install');
  assert.equal(r.danger, 'everyday');
  assert.equal(r.lead, 'none');
});

test('provider keys and addresses anchor to their input ids; no desktop label anchor occurs twice among the Settings dialog labels', () => {
  assert.deepEqual(records.byId('OPT-0343').anchors, [{ surface: 'desktop', selector: '#st-key-perplexity' }]);
  const keys = { 'OPT-0340': 'anthropic', 'OPT-0341': 'openai', 'OPT-0342': 'google', 'OPT-0344': 'openrouter', 'OPT-0345': 'elevenlabs' };
  for (const [id, p] of Object.entries(keys)) assert.deepEqual(records.byId(id).anchors, [{ surface: 'desktop', selector: `#st-key-${p}` }], id);
  for (const [id, p] of Object.entries({ 'OPT-0346': 'lmstudio', 'OPT-0347': 'ollama', 'OPT-0348': 'omlx' })) assert.deepEqual(records.byId(id).anchors, [{ surface: 'desktop', selector: `#st-url-${p}` }], id);
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.ok(app.includes('id="st-key-${p.id}"') && app.includes('id="st-url-${p.id}"'), 'the provider inputs are drawn with these ids');
  // the labels (<label> and <h4> text) the Settings dialog draws in openSettings(); a label anchor whose words occur twice there is ambiguous
  const from = app.indexOf('async function openSettings()');
  assert.ok(from > 0);
  const end = app.indexOf('\n    async function saveClassifier', from);
  assert.ok(end > from, 'end of openSettings');
  const body = app.slice(from, end);
  const { normLabel } = require('../lib/ui-settings-help.js');
  const seen = new Map();
  for (const m of body.matchAll(/<(label|h4)\b[^>]*>([^<>`$]{1,80})<\/\1>/g)) { const t = normLabel(m[2]).toLowerCase(); if (t) seen.set(t, (seen.get(t) || 0) + 1); }
  assert.ok(seen.size > 20, 'the labels were read');
  for (const r of records.all()) for (const a of r.anchors) {
    if (a.surface !== 'desktop' || a.label === undefined) continue;
    assert.ok((seen.get(normLabel(a.label).toLowerCase()) || 0) <= 1, `${r.id}: label anchor ${JSON.stringify(a.label)} occurs twice in the Settings dialog`);
  }
});

test('the team prefix has its own record, and the agent slug no longer shows the users page anchor', () => {
  const slug = records.byId('OPT-0001');
  assert.ok(!slug.anchors.some((a) => a.surface === 'users'), 'OPT-0001 has no users anchor');
  const p = records.byId('OPT-1082');
  assert.ok(p, 'OPT-1082 exists');
  assert.deepEqual(p.anchors, [{ surface: 'users', selector: '#p-prefix' }]);
  for (const f of ['kind', 'name', 'labels', 'what', 'when', 'risk', 'def', 'restart', 'danger', 'who', 'lead', 'words', 'scope', 'home', 'storedAs']) assert.ok(p[f] !== undefined && p[f] !== '', `OPT-1082 ${f}`);
  assert.equal(p.danger, 'everyday'); assert.equal(p.who, 'admin'); assert.equal(p.lead, 'screen'); assert.equal(p.restart, false); assert.equal(p.scope, 'per-person');
  assert.equal(p.home, records.byId('OPT-0618').home);
  assert.match(p.what, /jane_/);
  // no other record is anchored on #p-prefix on the users page
  for (const r of records.all()) if (r.id !== 'OPT-1082') assert.ok(!r.anchors.some((a) => a.surface === 'users' && a.selector === '#p-prefix'), `${r.id} shares #p-prefix`);
});

test('mobile.js creates no element with id simple-agent-switch, simple-more-agents or ss-research-level (the Simple sheets carry data-setting instead)', () => {
  const mob = fs.readFileSync(path.join(ROOT, 'mobile.js'), 'utf8');
  for (const id of ['simple-agent-switch', 'simple-more-agents', 'ss-research-level']) assert.ok(!mob.includes(id), `${id} is still in mobile.js`);
  for (const [id, rec] of [['OPT-0128', 'simple-phone'], ['OPT-1023', 'simple-phone'], ['OPT-1037', 'simple-phone']]) {
    assert.ok(mob.includes(`setAttribute('data-setting', '${id}')`), id);
    assert.ok(records.byId(id).anchors.some((a) => a.surface === rec && a.selector === `[data-setting="${id}"]`), `${id} anchor`);
  }
});

test('the route is a session route, served by server.js for signed-in people only (members filtered)', () => {
  assert.deepEqual(access.classifyRoute('/api/settings-records', 'GET'), { kind: 'session' });
  assert.ok(access.SESSION_EXACT.has('/api/settings-records'));
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /pathname === '\/api\/settings-records' && req\.method === 'GET'/);
  assert.match(server, /require\('\.\/lib\/settings-records'\)\.routeBody\(req\.hubUser \|\| null, \{ isAdmin \}\)/);
});
