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
  assert.deepStrictEqual(G.p5cPatch(row('OPT-0943'), 6, data), { updateCheck: { hours: 6 } }, 'only the one field: no stale sibling goes along');
  assert.deepStrictEqual(G.p5cPatch(row('OPT-0943'), null, data), { updateCheck: { hours: null } }, 'use default removes just the hours');
  assert.deepStrictEqual(G.p5cPatch(row('OPT-0945'), 80, data), { planFallback: { at: 80 } });
  assert.deepStrictEqual(G.p5cPatch(row('OPT-0946'), { opus: 'claude-sdk/x' }, data), { planFallback: { map: { opus: 'claude-sdk/x' } } });
  assert.deepStrictEqual(G.p5cPatch(row('OPT-0948'), 'tiny.en', data), { voice: { sttModel: 'tiny.en' } });
  assert.deepStrictEqual(G.p5cPatch(row('OPT-0948'), null, data), { voice: { sttModel: null } }, 'null is automatic');
  assert.deepStrictEqual(G.p5cPatch(row('OPT-0934'), 'https://proxy.example.com', data), { providers: { openai: { url: 'https://proxy.example.com' } } });
  assert.deepStrictEqual(G.p5cPatch(row('OPT-0934'), null, data), { providers: { openai: { url: null } } }, 'the hub falls back to its own address');
  assert.deepStrictEqual(G.p5cPatch(row('OPT-0931'), null, data), { providers: { ninfer: { url: null } } });
  // every row: Use default sends {<key>: null} (nested keys nest, nothing else goes along)
  for (const r of G.P5C) {
    const body = G.p5cPatch(r, null, { updateCheck: { enabled: true, hours: 12 }, imageModels: { google: { fast: 'a' } } });
    let o = body; for (const p of r.key.split('.')) { assert.ok(o && typeof o === 'object' && Object.keys(o).length === 1, `${r.opt}: one key at each level`); o = o[p]; }
    assert.strictEqual(o, null, `${r.opt}: null at the key`);
  }
  assert.deepStrictEqual(G.p5cPatch(row('OPT-0963'), null, data), { promptCache: null }, 'the default selection sends null');
});

test('picture models send only the tier that changed; clearing one is an explicit null; Use default is null', () => {
  const r = row('OPT-0962');
  const data = { imageModels: { google: { fast: 'gf', best: 'gb' }, openai: { fast: 'of' } } };
  assert.deepStrictEqual(G.p5cPatch(r, { google: { fast: 'gf', best: 'gb2' }, openai: { fast: 'of' } }, data), { imageModels: { google: { best: 'gb2' } } });
  assert.deepStrictEqual(G.p5cPatch(r, { google: { best: 'gb' }, openai: { fast: 'of' } }, data), { imageModels: { google: { fast: null } } }, 'a cleared tier removes it');
  assert.deepStrictEqual(G.p5cPatch(r, { google: { fast: 'gf', best: 'gb' }, openai: { fast: 'of', best: 'ob' } }, data), { imageModels: { openai: { best: 'ob' } } }, 'a new tier');
  assert.deepStrictEqual(G.p5cPatch(r, null, data), { imageModels: null });
  assert.deepStrictEqual(G.p5cPatch(r, { google: { fast: 'x' } }, {}), { imageModels: { google: { fast: 'x' } } });
});

test('the provider address question names the provider, the new address and the old one, for a reset too', () => {
  const d = { providers: { anthropic: { url: 'https://203.0.113.10/v1' } } };
  assert.strictEqual(G.p5cConfirmText(row('OPT-0933'), null, d), 'Keys and prompts for Anthropic will go to https://api.anthropic.com instead of https://203.0.113.10/v1. Change it?');
  assert.strictEqual(G.p5cConfirmText(row('OPT-0933'), 'https://p.example.com', {}), 'Keys and prompts for Anthropic will go to https://p.example.com instead of https://api.anthropic.com. Change it?');
});

// The row saver with a fake page. late: the post finishes when a gate is opened. lock events are recorded with the paints, in order.
function fakeSaver(opts = {}) {
  const raws = {}; const posts = []; const toasts = []; const paints = []; const asked = []; const gates = []; const events = [];
  const data = opts.data || {};
  const saver = G.p5cSaver({
    data: () => data,
    readRaw: (r) => raws[r.opt],
    post: (body) => new Promise((res) => { posts.push(body); gates.push(() => res(opts.fail ? { ok: false, error: opts.fail } : { ok: true })); if (!opts.late) gates.pop()(); }),
    readBack: async () => (opts.back ? opts.back(data) : data),
    confirm: (t) => { asked.push(t); return opts.yes !== false; },
    toast: (t) => toasts.push(t),
    paint: (r) => { paints.push(r.opt); events.push(`paint:${r.opt}`); },
    lock: (r, on) => events.push(`${on ? 'lock' : 'unlock'}:${r.opt}`),
  });
  return { saver, raws, posts, toasts, paints, asked, gates, events, data };
}
const tick = () => new Promise((r) => setImmediate(r));

test('while a row saves it is locked and a second save of it is ignored; the end paints then unlocks', async () => {
  const f = fakeSaver({ late: true });
  f.raws['OPT-0951'] = '100';
  const first = f.saver.save('OPT-0951');
  await tick();
  assert.deepStrictEqual(f.posts, [{ filesMaxUploadMb: 100 }]);
  assert.deepStrictEqual(f.events, ['lock:OPT-0951']);
  f.raws['OPT-0951'] = '200'; await f.saver.save('OPT-0951');   // ignored: no queue
  await f.saver.save('OPT-0951', true);
  await tick();
  assert.strictEqual(f.posts.length, 1, 'no second save starts');
  f.gates.shift()();
  await first;
  assert.strictEqual(f.posts.length, 1, 'nothing replays afterwards');
  assert.strictEqual(f.data.filesMaxUploadMb, 100);
  assert.deepStrictEqual(f.events, ['lock:OPT-0951', 'paint:OPT-0951', 'unlock:OPT-0951'], 'painted from the stored copy, then enabled again');
  f.raws['OPT-0951'] = '300'; const again = f.saver.save('OPT-0951'); await tick();   // idle again: saves
  assert.deepStrictEqual(f.posts[1], { filesMaxUploadMb: 300 });
  f.gates.shift()(); await again;
});

test('a save in one row does not block another row, and the patch is worked out from the stored copy at that moment', async () => {
  const f = fakeSaver({ late: true, data: { imageModels: { google: { fast: 'gf', best: 'gb' } } } });
  f.raws['OPT-0951'] = '100'; f.raws['OPT-0962'] = { google: { fast: 'gf', best: 'gb2' }, openai: { fast: '', best: '' } };
  const a = f.saver.save('OPT-0951'); const b = f.saver.save('OPT-0962');
  await tick();
  assert.strictEqual(f.posts.length, 2, 'both rows save');
  assert.deepStrictEqual(f.posts[1], { imageModels: { google: { best: 'gb2' } } });
  f.gates.shift()(); f.gates.shift()();
  await Promise.all([a, b]);
  // another admin changed the fast tier meanwhile (the screen's copy follows a read-back): the next save sends only what differs from it now
  f.data.imageModels.google.fast = 'other-admin';
  f.raws['OPT-0962'] = { google: { fast: 'other-admin', best: 'gb3' }, openai: { fast: '', best: '' } };
  f.gates.length = 0;
  const c = f.saver.save('OPT-0962'); await tick();
  assert.deepStrictEqual(f.posts[2], { imageModels: { google: { best: 'gb3' } } }, 'the other admin\'s tier is not replayed over');
  f.gates.shift()(); await c;
});

test('after a save the stored value is read back: "back to the default" only when it really is', async () => {
  const stuck = fakeSaver({ data: { filesMaxUploadMb: 100 }, back: () => ({ filesMaxUploadMb: 100 }) });
  await stuck.saver.save('OPT-0951', true);
  assert.deepStrictEqual(stuck.posts, [{ filesMaxUploadMb: null }]);
  assert.ok(!stuck.toasts.some((t) => /back to the default/.test(t)), stuck.toasts.join('|'));
  assert.strictEqual(stuck.data.filesMaxUploadMb, 100, 'the screen shows what the hub holds');
  const ok = fakeSaver({ data: { filesMaxUploadMb: 100 }, back: () => ({}) });
  await ok.saver.save('OPT-0951', true);
  assert.deepStrictEqual(ok.toasts, ['Biggest upload: back to the default.']);
  assert.ok(!('filesMaxUploadMb' in ok.data));
});

test('a provider address asks before every change, a reset included; no answer, no change', async () => {
  const f = fakeSaver({ data: { providers: { anthropic: { url: 'https://203.0.113.10/v1' } } } });
  await f.saver.save('OPT-0933', true);
  assert.deepStrictEqual(f.asked, ['Keys and prompts for Anthropic will go to https://api.anthropic.com instead of https://203.0.113.10/v1. Change it?']);
  assert.deepStrictEqual(f.posts, [{ providers: { anthropic: { url: null } } }]);
  const no = fakeSaver({ yes: false, data: { providers: { anthropic: { url: 'https://203.0.113.10/v1' } } } });
  await no.saver.save('OPT-0933', true);
  assert.strictEqual(no.posts.length, 0);
  assert.deepStrictEqual(no.paints, ['OPT-0933']);
});

test('a failed save says the hub\'s words and puts the box back', async () => {
  const f = fakeSaver({ fail: 'Too big.' });
  f.raws['OPT-0951'] = '100';
  await f.saver.save('OPT-0951');
  assert.deepStrictEqual(f.toasts, ['Could not save: Too big.']);
  assert.deepStrictEqual(f.paints, ['OPT-0951']);
  assert.ok(!('filesMaxUploadMb' in f.data));
  assert.deepStrictEqual(f.events, ['lock:OPT-0951', 'paint:OPT-0951', 'unlock:OPT-0951']);
});

test('(A) the question\'s "from" is the address in effect now (providers[p].url), not the stored override', async () => {
  // an environment gateway E is in effect, and the stored override equals the built-in address B: typing E is a real move away from B
  const E = 'http://gateway.example:9000/v1', B = 'http://127.0.0.1:8080/v1';
  const f = fakeSaver({ data: { providers: { ninfer: { url: B, fallbackUrl: E } } } });
  f.raws['OPT-0931'] = E;
  await f.saver.save('OPT-0931');
  assert.deepStrictEqual(f.asked, [`Keys and prompts for NInfer will go to ${E} instead of ${B}. Change it?`]);
  // a reset goes to the fallback address; asked whenever from != to (trailing slash ignored)
  const g = fakeSaver({ data: { providers: { ninfer: { url: 'https://proxy.example.com', fallbackUrl: E } } } });
  await g.saver.save('OPT-0931', true);
  assert.deepStrictEqual(g.asked, [`Keys and prompts for NInfer will go to ${E} instead of https://proxy.example.com. Change it?`]);
  const h = fakeSaver({ data: { providers: { ninfer: { url: E, fallbackUrl: E } } } });
  h.raws['OPT-0931'] = E + '/';
  await h.saver.save('OPT-0931');
  assert.deepStrictEqual(h.asked, [], 'same destination: no question');
  assert.deepStrictEqual(G.p5cDestination(row('OPT-0931'), 'https://x.example', { providers: { ninfer: { url: B } } }), { to: 'https://x.example', from: B });
});

test('(B) a failed save repaints its row, and a refused one flips back (the paint is not guarded by focus)', async () => {
  const f = fakeSaver({ fail: 'No.', data: {} });
  f.raws['OPT-0960'] = false;   // a switch toggled off from its default of on
  await f.saver.save('OPT-0960');
  assert.deepStrictEqual(f.toasts, ['Could not save: No.']);
  assert.deepStrictEqual(f.events, ['lock:OPT-0960', 'paint:OPT-0960', 'unlock:OPT-0960']);
  // the fill sets a focused switch too
  const sw = { id: 'st-p5c-hubBrief', checked: false };
  G.p5cFill(row('OPT-0960'), G.p5cValue(row('OPT-0960'), f.data), () => sw, (v) => ({ value: v }));
  assert.strictEqual(sw.checked, true, 'back to the stored (default on) value');
  const inp = { id: 'st-p5c-filesMaxUploadMb', value: 'typed' };
  G.p5cFill(row('OPT-0951'), 7, () => inp, (v) => ({ value: v }));
  assert.strictEqual(inp.value, '7');
});

test('(C) a draft in another row is untouched; a value the page\'s own check refuses keeps the typed text (no repaint, no lock)', async () => {
  const f = fakeSaver({ data: {} });
  f.raws['OPT-0951'] = 'many';
  await f.saver.save('OPT-0951');
  assert.deepStrictEqual(f.toasts, ['Biggest upload must be a number from 1 to 100000.']);
  assert.deepStrictEqual(f.events, [], 'no repaint, no lock');
  assert.deepStrictEqual(f.posts, []);
  const g = fakeSaver({ data: {} });
  g.raws['OPT-0952'] = '50';
  await g.saver.save('OPT-0952');
  assert.deepStrictEqual(g.paints, ['OPT-0952'], 'only the saved row is painted');
});

test('app.js: the row is locked while it saves, nothing tracks drafts, no repaint guard', () => {
  const app = read('app.js'), lib = read('lib/ui-settings-groups.js');
  assert.ok(app.includes('lock: p5cLock') && app.includes("setAttribute('aria-busy', 'true')") && app.includes('c.disabled = true') && app.includes('c.disabled = false') && app.includes('f.focus()'));
  assert.ok(!/p5cMarkDirty|p5cIsDirty|p5cClearDirty/.test(app + lib), 'the dirty tracking is gone');
  assert.ok(!app.includes("document.addEventListener('input', (e) => { const t = e.target; if (t && typeof t.id === 'string' && t.id.indexOf('st-p5c-')"), 'the input listener is gone');
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
  assert.ok(app.slice(at, at + 700).includes('id="st-expert-section"><h4 class="st-vh">Expert values</h4>'));
  assert.ok(app.includes('const di = `id="${r.id}" data-setting="${r.opt}"`;'), 'every control carries data-setting and its id');
  assert.ok(app.includes("p5cSave('${r.opt}', true)") && app.includes('>Use default</button>'), 'Use default');
  assert.ok(app.includes('STG.p5cSaver({') && app.includes("stSaveFetch('/api/settings', { method: 'POST'") && app.includes('JSON.stringify(body)'), 'saved through POST /api/settings by the shared saver');
  assert.ok(app.includes("readBack: async () => {") && app.includes("fetch('/api/settings', { credentials: 'include', signal: ac.signal })"), 'the stored value is read back');
  assert.ok(app.includes('new AbortController()') && app.includes('ac.abort(), 8000'), 'the read-back gives up after 8 seconds (a failed read-back)');
  assert.ok(app.includes('confirm: (t) => confirm(t)'), 'the address question goes through the saver, which words it (STG.p5cConfirmText)');
  assert.ok(app.includes('d.error || `HTTP ${resp.status}`'), 'a failure shows the hub\'s words');
  assert.ok(app.includes('paint: p5cPaint'), 'the box put back after');
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
