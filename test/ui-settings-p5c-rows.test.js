'use strict';
// Phase 5c, A2a: one row in Settings for each settings.json key that only a file edit changed (lib/ui-settings-groups.js P5C and the
// row code in app.js). The page itself is not run; the table, the checks and the patches are, and the wiring is read from the source.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const G = require('../lib/ui-settings-groups.js');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const records = (() => { const j = JSON.parse(read('templates/settings-records.json')); return Array.isArray(j) ? j : (j.records || []); })();
const row = (opt) => G.p5cByOpt(opt);

const WANT = ['OPT-0439', 'OPT-0509', 'OPT-0930', 'OPT-0931', 'OPT-0933', 'OPT-0934', 'OPT-0935', 'OPT-0936', 'OPT-0937', 'OPT-0938', 'OPT-0943', 'OPT-0945', 'OPT-0946',
  'OPT-0948', 'OPT-0949', 'OPT-0950', 'OPT-0951', 'OPT-0952', 'OPT-0953', 'OPT-0954', 'OPT-0955', 'OPT-0956', 'OPT-0957', 'OPT-0958', 'OPT-0959', 'OPT-0960', 'OPT-0961', 'OPT-0962', 'OPT-0963'];

test('every row has a record: same name, same stored key, a unique element id', () => {
  assert.deepStrictEqual(G.P5C.map((r) => r.opt).sort(), WANT.slice().sort(), 'the rows of the spec (OPT-0932 local address is ignored by the hub; OPT-1095 and the env rows are A2b)');
  const ids = G.P5C.map((r) => r.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'element ids are unique');
  for (const r of G.P5C) {
    const rec = records.find((x) => x.id === r.opt);
    assert.ok(rec, `${r.opt}: a record exists`);
    assert.strictEqual(r.name, rec.name, `${r.opt}: the label is the record's name`);
    assert.strictEqual(`settings.${r.key}`, rec.storedAs, `${r.opt}: the stored key`);
    assert.match(r.id, /^st-p5c-[a-zA-Z0-9-]+$/, `${r.opt}: an id the ⓘ anchor can use`);
    assert.ok(r.def && r.hint, `${r.opt}: default words and a hint line`);
    assert.ok(!/^st-(url|key)-/.test(r.id), `${r.opt}: not an id the shared Save collects`);
  }
});

test('where each row lives: the group the spec names, the rest in Upkeep > More > Expert values', () => {
  const home = (opt) => { const g = G.groupOfRow(`#${row(opt).id}`); return g ? `${g.group}${g.more ? '+more' : ''}` : 'expert'; };
  for (const o of ['OPT-0931', 'OPT-0933', 'OPT-0934', 'OPT-0935', 'OPT-0936', 'OPT-0937', 'OPT-0938', 'OPT-0945', 'OPT-0946']) assert.strictEqual(home(o), 'money+more', o);
  assert.strictEqual(home('OPT-0948'), 'voice+more');
  assert.strictEqual(home('OPT-0949'), 'upkeep'); assert.strictEqual(home('OPT-0950'), 'upkeep');
  assert.strictEqual(home('OPT-0958'), 'safety+more'); assert.strictEqual(home('OPT-0959'), 'safety+more');
  assert.strictEqual(home('OPT-0961'), 'tools+more'); assert.strictEqual(home('OPT-0962'), 'tools+more');
  // the approval wait and the box sizes sit with the boxes and approvals in People and safety (their records' home)
  for (const o of ['OPT-0439', 'OPT-0955', 'OPT-0956', 'OPT-0957']) assert.strictEqual(home(o), 'safety+more', o);
  for (const o of ['OPT-0509', 'OPT-0930', 'OPT-0943', 'OPT-0951', 'OPT-0952', 'OPT-0953', 'OPT-0954', 'OPT-0960', 'OPT-0963']) assert.strictEqual(home(o), 'expert', o);
  assert.deepStrictEqual(G.groupOfSection(G.EXPERT_SECTION), { group: 'upkeep', more: true });
  assert.ok(G.allSectionIds().includes('st-expert-section'));
  for (const r of G.P5C.filter((x) => x.to)) assert.strictEqual(G.groupOfSection(G.movedId(G.groupOfRow(`#${r.id}`) && { part: r.part })).group, r.to, `${r.opt}: its small section follows`);
});

test('a bad value is refused with the row name, the default (empty) is accepted, a good value is kept', () => {
  const bad = {
    'OPT-0439': '0', 'OPT-0509': '-1', 'OPT-0943': '1.5', 'OPT-0951': 'many', 'OPT-0952': '5000', 'OPT-0953': '70000', 'OPT-0954': '1', 'OPT-0955': 'lots',
    'OPT-0956': '0', 'OPT-0957': '0', 'OPT-0945': '101', 'OPT-0950': '1',
    'OPT-0931': 'not an address', 'OPT-0933': 'ftp://example.com', 'OPT-0938': 'https://sam:pw@example.com/v1',
    'OPT-0948': 'huge', 'OPT-0949': 'sometimes', 'OPT-0961': 'bing', 'OPT-0958': 'a b', 'OPT-0959': 'not a list',
    'OPT-0946': { fable: 'gpt-4' }, 'OPT-0962': { google: { fast: 'bad name!' } }, 'OPT-0963': { enabled: true, ttl: '2h' },
  };
  for (const [opt, v] of Object.entries(bad)) {
    const c = G.p5cClean(row(opt), v);
    assert.strictEqual(c.ok, false, `${opt} refuses ${JSON.stringify(v)}`);
    assert.ok(c.error.includes(row(opt).name), `${opt}: the error names the row`);
  }
  for (const r of G.P5C) assert.deepStrictEqual(G.p5cClean(r, ''), { ok: true, value: null }, `${r.opt}: empty is the default`);
  assert.deepStrictEqual(G.p5cClean(row('OPT-0439'), '60'), { ok: true, value: 60 });
  assert.deepStrictEqual(G.p5cClean(row('OPT-0954'), '256'), { ok: true, value: 262144 }, 'KB in the box, bytes stored');
  assert.deepStrictEqual(G.p5cClean(row('OPT-0955'), ' 4G '), { ok: true, value: '4g' });
  assert.deepStrictEqual(G.p5cClean(row('OPT-0956'), '1.5'), { ok: true, value: 1.5 });
  assert.deepStrictEqual(G.p5cClean(row('OPT-0950'), '0.75'), { ok: true, value: 0.75 });
  assert.deepStrictEqual(G.p5cClean(row('OPT-0930'), true), { ok: true, value: true });
  assert.deepStrictEqual(G.p5cClean(row('OPT-0960'), false), { ok: true, value: false }, 'off is a value, not the default');
  assert.deepStrictEqual(G.p5cClean(row('OPT-0933'), 'https://proxy.example.com/'), { ok: true, value: 'https://proxy.example.com' });
  assert.deepStrictEqual(G.p5cClean(row('OPT-0949'), 'dry'), { ok: true, value: 'dry' });
  assert.deepStrictEqual(G.p5cClean(row('OPT-0959'), ['claude-sdk/claude-sonnet-5-5', 'claude-sdk/claude-sonnet-5-5']), { ok: true, value: ['claude-sdk/claude-sonnet-5-5'] });
  assert.deepStrictEqual(G.p5cClean(row('OPT-0946'), { fable: 'claude-sdk/claude-opus-5-5', opus: '', sonnet: '' }), { ok: true, value: { fable: 'claude-sdk/claude-opus-5-5' } });
  assert.deepStrictEqual(G.p5cClean(row('OPT-0962'), { google: { fast: 'm-fast', best: '' }, openai: { fast: '', best: '' } }), { ok: true, value: { google: { fast: 'm-fast' } } });
  assert.deepStrictEqual(G.p5cClean(row('OPT-0963'), { enabled: true, ttl: '5m' }), { ok: true, value: null }, 'the default is stored as unset');
  assert.deepStrictEqual(G.p5cClean(row('OPT-0963'), { enabled: false, ttl: '5m' }), { ok: true, value: { enabled: false, ttl: '5m' } });
});

test('the patch each row sends: nested keys, the default, a provider address', () => {
  const data = { updateCheck: { enabled: true, hours: 12 } };
  assert.deepStrictEqual(G.p5cPatch(row('OPT-0951'), 100, data), { filesMaxUploadMb: 100 });
  assert.deepStrictEqual(G.p5cPatch(row('OPT-0951'), null, data), { filesMaxUploadMb: null }, 'use default sends null');
  assert.deepStrictEqual(G.p5cPatch(row('OPT-0943'), 6, data), { updateCheck: { enabled: true, hours: 6 } }, 'the hub replaces updateCheck whole: the switch is kept');
  assert.deepStrictEqual(G.p5cPatch(row('OPT-0943'), null, data), { updateCheck: { enabled: true } });
  assert.deepStrictEqual(G.p5cPatch(row('OPT-0945'), 80, data), { planFallback: { at: 80 } });
  assert.deepStrictEqual(G.p5cPatch(row('OPT-0946'), { opus: 'claude-sdk/x' }, data), { planFallback: { map: { opus: 'claude-sdk/x' } } });
  assert.deepStrictEqual(G.p5cPatch(row('OPT-0948'), 'tiny.en', data), { voice: { sttModel: 'tiny.en' } });
  assert.deepStrictEqual(G.p5cPatch(row('OPT-0948'), null, data), { voice: { sttModel: '' } }, 'empty is automatic');
  assert.deepStrictEqual(G.p5cPatch(row('OPT-0934'), 'https://proxy.example.com', data), { providers: { openai: { url: 'https://proxy.example.com' } } });
  assert.deepStrictEqual(G.p5cPatch(row('OPT-0934'), null, data), { providers: { openai: { url: '' } } }, 'the hub falls back to its own address');
  assert.deepStrictEqual(G.p5cPatch(row('OPT-0931'), null, data), { providers: { ninfer: { url: '' } } });
});

test('what a row shows: unset shows the default, a saved value shows as set, the screen copy follows a save', () => {
  const d = { filesZipMaxMb: 1000, recordsMaxBytes: 524288, providers: { openai: { url: 'https://api.openai.com/v1' }, google: { url: 'https://proxy.example.com' } }, hubBrief: false };
  assert.strictEqual(G.p5cValue(row('OPT-0951'), d), undefined);
  assert.strictEqual(G.p5cValue(row('OPT-0952'), d), 1000);
  assert.strictEqual(G.p5cValue(row('OPT-0954'), d), 512, 'bytes shown as KB');
  assert.strictEqual(G.p5cValue(row('OPT-0934'), d), undefined, 'an address equal to the default counts as unset');
  assert.strictEqual(G.p5cValue(row('OPT-0935'), d), 'https://proxy.example.com');
  assert.strictEqual(G.p5cValue(row('OPT-0960'), d), false);
  assert.strictEqual(G.p5cValue(row('OPT-0439'), { approvalTimeoutMinutes: null }), undefined, 'null is unset');
  assert.strictEqual(G.p5cDefaultText(row('OPT-0951')), 'Default: 512 MB.');
  G.p5cStore(row('OPT-0951'), 100, d); assert.strictEqual(d.filesMaxUploadMb, 100);
  G.p5cStore(row('OPT-0951'), null, d); assert.ok(!('filesMaxUploadMb' in d), 'default removes it');
  G.p5cStore(row('OPT-0945'), 80, d); assert.strictEqual(d.planFallback.at, 80);
  G.p5cStore(row('OPT-0935'), null, d); assert.strictEqual(d.providers.google.url, 'https://generativelanguage.googleapis.com/v1beta/openai');
});

test('app.js: admins only, the ⓘ attribute on every control, saves through POST /api/settings, the address confirm, errors in the hub words', () => {
  const app = read('app.js');
  const at = app.indexOf('if (isHubAdmin()) {\n        p5cData = data;');
  assert.ok(at > 0, 'the section is drawn inside an admin check');
  assert.ok(app.slice(at, at + 700).includes('id="st-expert-section"><h4>Expert values</h4>'));
  assert.ok(app.includes('const di = `id="${r.id}" data-setting="${r.opt}"`;'), 'every control carries data-setting and its id');
  assert.ok(app.includes("p5cSave('${r.opt}', true)") && app.includes('>Use default</button>'), 'Use default');
  assert.ok(app.includes('STG.p5cPatch(r, c.value, p5cData)') && app.includes("stSaveFetch('/api/settings', { method: 'POST'"), 'saved through POST /api/settings');
  assert.ok(app.includes('`Keys and prompts for ${r.label} go to this address. Change it?`'), 'the confirm words');
  assert.ok(app.includes("hubToast('Could not save: ' + e.message)") && app.includes('d.error || `HTTP ${resp.status}`'), 'a failure shows the hub\'s words');
  assert.ok(app.includes('p5cBusy[opt]') && app.includes('p5cPaint(r);'), 'one save at a time per row, the box put back after');
  const html = app.slice(app.indexOf('function p5cRowHtml('), app.indexOf('function p5cPaint('));
  assert.ok(html.includes('${STG.p5cDefaultText(r)}') || html.includes('STG.p5cDefaultText(r)'), 'Default: ... is shown');
  assert.ok(!/\bdata-setting="OPT-\d+"/.test(html), 'the id comes from the table, not typed in');
});

test('members see none of it: the section is only built for an admin and the row code never runs for the member frame', () => {
  const app = read('app.js');
  const open = app.slice(app.indexOf('async function openSettings() {'));
  const drawAt = open.indexOf('STG.P5C.map(r => p5cRowHtml(r, data))');
  assert.ok(drawAt > 0);
  const before = open.slice(Math.max(0, drawAt - 400), drawAt);
  assert.match(before, /if \(isHubAdmin\(\)\) \{/);
});

test('the module has no variation selector or invisible character', () => {
  const bad = new RegExp(`[${String.fromCharCode(0xFE0F, 0x200B, 0x200C, 0x200D, 0x2060)}]`);
  assert.doesNotMatch(read('lib/ui-settings-groups.js'), bad);
});
