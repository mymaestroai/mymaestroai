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
      const id = a.selector.slice(1);
      const files = FILES_BY_SURFACE[a.surface];
      assert.ok(files, `${r.id}: unknown surface ${a.surface}`);
      const found = files.some((f) => read(f).includes(`id="${id}"`) || read(f).includes(`id='${id}'`));
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

test('the route is a session route, served by server.js for signed-in people only (members filtered)', () => {
  assert.deepEqual(access.classifyRoute('/api/settings-records', 'GET'), { kind: 'session' });
  assert.ok(access.SESSION_EXACT.has('/api/settings-records'));
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /pathname === '\/api\/settings-records' && req\.method === 'GET'/);
  assert.match(server, /require\('\.\/lib\/settings-records'\)\.routeBody\(req\.hubUser \|\| null, \{ isAdmin \}\)/);
});
