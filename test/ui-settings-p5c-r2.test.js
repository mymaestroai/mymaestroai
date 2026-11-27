'use strict';
// Phase 5c, round 2 page fixes (Q1, Q4, Q5, Q6, Q7, Q8, Q10): pure functions, a fake post / readBack, fake inputs.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const G = require('../lib/ui-settings-groups.js');
const X = require('../lib/ui-settings-expert.js');
const row = (opt) => G.p5cByOpt(opt);
const tick = () => new Promise((r) => setImmediate(r));

function fakeSaver(opts = {}) {
  const raws = {}; const posts = []; const toasts = []; const paints = []; const asked = [];
  const data = opts.data || {};
  const saver = G.p5cSaver({
    data: () => data,
    readRaw: (r) => raws[r.opt],
    post: async (body) => { posts.push(body); return { ok: true }; },
    readBack: async () => { if (opts.backFails) throw new Error('down'); return opts.back ? opts.back(data, posts) : data; },
    confirm: (t) => { asked.push(t); return opts.yes !== false; },
    toast: (t) => toasts.push(t),
    paint: (r) => paints.push(r.opt),
  });
  return { saver, raws, posts, toasts, paints, asked, data };
}

// ── Q1: the reset question names the address a reset really uses (fallbackUrl), the built-in one when missing
test('Q1: reset names providers[p].fallbackUrl; without it the built-in address', async () => {
  const data = { providers: { ninfer: { url: 'https://203.0.113.10/v1', fallbackUrl: 'http://10.0.0.5:9000/v1' } } };
  assert.strictEqual(G.p5cConfirmText(row('OPT-0931'), null, 'https://203.0.113.10/v1', data),
    'Keys and prompts for NInfer will go to http://10.0.0.5:9000/v1 instead of https://203.0.113.10/v1. Change it?');
  assert.strictEqual(G.p5cConfirmText(row('OPT-0931'), null, 'https://203.0.113.10/v1', { providers: { ninfer: {} } }),
    'Keys and prompts for NInfer will go to http://127.0.0.1:8080/v1 instead of https://203.0.113.10/v1. Change it?');
  const f = fakeSaver({ data });
  await f.saver.save('OPT-0931', true);
  assert.deepStrictEqual(f.asked, ['Keys and prompts for NInfer will go to http://10.0.0.5:9000/v1 instead of https://203.0.113.10/v1. Change it?']);
});

// ── Q10: no question when the destination does not change
test('Q10: typing the address already in effect asks nothing (default, or the env address); a real move still asks', async () => {
  const a = fakeSaver({ data: { providers: { anthropic: {} } } });
  a.raws['OPT-0933'] = 'https://api.anthropic.com/';
  await a.saver.save('OPT-0933');
  assert.deepStrictEqual(a.asked, [], 'the default address typed: no question');
  assert.strictEqual(a.posts.length, 1);
  const b = fakeSaver({ data: { providers: { ninfer: { fallbackUrl: 'http://10.0.0.5:9000/v1' } } } });
  b.raws['OPT-0931'] = 'http://10.0.0.5:9000/v1';
  await b.saver.save('OPT-0931');
  assert.deepStrictEqual(b.asked, [], 'the env address typed: no question');
  const c = fakeSaver({ data: { providers: { ninfer: { fallbackUrl: 'http://10.0.0.5:9000/v1' } } } });
  c.raws['OPT-0931'] = 'https://proxy.example.com';
  await c.saver.save('OPT-0931');
  assert.strictEqual(c.asked.length, 1);
  assert.match(c.asked[0], /proxy\.example\.com instead of http:\/\/10\.0\.0\.5:9000\/v1/);
});

// ── Q4: picture models
test('Q4: an empty tier diff posts nothing; clearing one tier sends only that tier null; only Use default sends imageModels:null', async () => {
  const r = row('OPT-0962');
  // same content in a different key order: nothing to send
  const data = { imageModels: { google: { fast: 'gf', best: 'gb' }, openai: { best: 'ob', fast: 'of' } } };
  assert.strictEqual(G.p5cPatch(r, { openai: { fast: 'of', best: 'ob' }, google: { best: 'gb', fast: 'gf' } }, data), null);
  const same = fakeSaver({ data });
  same.raws['OPT-0962'] = { openai: { fast: 'of', best: 'ob' }, google: { best: 'gb', fast: 'gf' } };
  await same.saver.save('OPT-0962');
  assert.deepStrictEqual(same.posts, [], 'key order is not a change');
  // clearing a single tier
  const one = fakeSaver({ data: { imageModels: { google: { fast: 'gf', best: 'gb' } } } });
  one.raws['OPT-0962'] = { google: { fast: 'gf', best: '' }, openai: { fast: '', best: '' } };
  await one.saver.save('OPT-0962');
  assert.deepStrictEqual(one.posts, [{ imageModels: { google: { best: null } } }]);
  // clearing the last tier by hand is not Use default
  const last = fakeSaver({ data: { imageModels: { google: { fast: 'gf' } } } });
  last.raws['OPT-0962'] = { google: { fast: '', best: '' }, openai: { fast: '', best: '' } };
  await last.saver.save('OPT-0962');
  assert.deepStrictEqual(last.posts, [{ imageModels: { google: { fast: null } } }]);
  // all empty and nothing stored: nothing to post
  const none = fakeSaver({ data: {} });
  none.raws['OPT-0962'] = { google: { fast: '', best: '' }, openai: { fast: '', best: '' } };
  await none.saver.save('OPT-0962');
  assert.deepStrictEqual(none.posts, []);
  // Use default
  const use = fakeSaver({ data: { imageModels: { google: { fast: 'gf' } } } });
  await use.saver.save('OPT-0962', true);
  assert.deepStrictEqual(use.posts, [{ imageModels: null }]);
});

// ── Q7: plan fallback map
test('Q7: a family stored and now Default is sent as null; families not changed are not sent', async () => {
  const r = row('OPT-0946');
  const data = { planFallback: { map: { opus: 'claude-sdk/a', sonnet: 'claude-sdk/b' } } };
  assert.deepStrictEqual(G.p5cPatch(r, { opus: 'claude-sdk/a' }, data), { planFallback: { map: { sonnet: null } } });
  assert.deepStrictEqual(G.p5cPatch(r, { opus: 'claude-sdk/a', sonnet: 'claude-sdk/b' }, data), null);
  assert.deepStrictEqual(G.p5cPatch(r, { opus: 'claude-sdk/a', sonnet: 'claude-sdk/c', fable: 'claude-sdk/d' }, data), { planFallback: { map: { sonnet: 'claude-sdk/c', fable: 'claude-sdk/d' } } });
  const f = fakeSaver({ data });
  f.raws['OPT-0946'] = { fable: '', opus: 'claude-sdk/a', sonnet: '' };
  await f.saver.save('OPT-0946');
  assert.deepStrictEqual(f.posts, [{ planFallback: { map: { sonnet: null } } }]);
  const all = fakeSaver({ data: { planFallback: { map: { opus: 'claude-sdk/a' } } } });
  all.raws['OPT-0946'] = { fable: '', opus: '', sonnet: '' };
  await all.saver.save('OPT-0946');
  assert.deepStrictEqual(all.posts, [{ planFallback: { map: { opus: null } } }], 'emptying every family is not Use default');
  const use = fakeSaver({ data: { planFallback: { map: { opus: 'claude-sdk/a' } } } });
  await use.saver.save('OPT-0946', true);
  assert.deepStrictEqual(use.posts, [{ planFallback: { map: null } }]);
});

// ── Q8: toast words from the read-back
test('Q8: words come from the read-back; a failed read-back says saved but not confirmed', async () => {
  const lost = fakeSaver({ data: { filesMaxUploadMb: 100 }, backFails: true });
  await lost.saver.save('OPT-0951', true);
  assert.deepStrictEqual(lost.toasts, ['Biggest upload (MB): saved, but your Maestro could not be asked to confirm it.']);
  const lost2 = fakeSaver({ data: {}, back: () => null });
  lost2.raws['OPT-0951'] = '100';
  await lost2.saver.save('OPT-0951');
  assert.deepStrictEqual(lost2.toasts, ['Biggest upload (MB): saved, but your Maestro could not be asked to confirm it.']);
  // the hub holds something else than what was sent: not "saved."
  const odd = fakeSaver({ data: {}, back: () => ({ filesMaxUploadMb: 7 }) });
  odd.raws['OPT-0951'] = '100';
  await odd.saver.save('OPT-0951');
  assert.ok(!odd.toasts.some((t) => /: saved\.$/.test(t)), odd.toasts.join('|'));
  const good = fakeSaver({ data: {}, back: () => ({ filesMaxUploadMb: 100 }) });
  good.raws['OPT-0951'] = '100';
  await good.saver.save('OPT-0951');
  assert.deepStrictEqual(good.toasts, ['Biggest upload (MB): saved.']);
  const reset = fakeSaver({ data: { filesMaxUploadMb: 100 }, back: () => ({}) });
  await reset.saver.save('OPT-0951', true);
  assert.deepStrictEqual(reset.toasts, ['Biggest upload (MB): back to the default.']);
});

// ── Q5: a repaint never touches a focused or dirty input
function fakeInput(id, value) { return { id, value, options: [], add() {} }; }
test('Q5: p5cFill skips the focused input and a dirty one, and paints the rest', () => {
  const r = row('OPT-0962');
  const els = {};
  for (const p of ['google', 'openai']) for (const w of ['fast', 'best']) els[`${p}-${w}`] = fakeInput(`st-p5c-imageModels-${p}-${w}`, `typing-${p}-${w}`);
  const focused = els['google-fast'];
  G.p5cMarkDirty(els['openai-best'].id);
  const guard = (el) => el !== focused && !G.p5cIsDirty(el.id);
  G.p5cFill(r, { google: { fast: 'S1', best: 'S2' }, openai: { fast: 'S3', best: 'S4' } }, (s) => els[s], guard, (v) => ({ value: v }));
  assert.strictEqual(els['google-fast'].value, 'typing-google-fast', 'focused: untouched');
  assert.strictEqual(els['openai-best'].value, 'typing-openai-best', 'dirty: untouched');
  assert.strictEqual(els['google-best'].value, 'S2');
  assert.strictEqual(els['openai-fast'].value, 'S3');
  G.p5cClearDirty('st-p5c-imageModels');   // committed
  assert.strictEqual(G.p5cIsDirty(els['openai-best'].id), false);
  G.p5cFill(r, { openai: { best: 'S4' } }, (s) => els[s], guard, (v) => ({ value: v }));
  assert.strictEqual(els['openai-best'].value, 'S4', 'painted once committed');
  assert.strictEqual(els['google-fast'].value, 'typing-google-fast', 'still focused');
});

test('Q5: app.js marks inputs dirty from the input event, clears on commit, and paints through the guard', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.ok(app.includes("document.addEventListener('input'") && app.includes('STG.p5cMarkDirty(t.id)'));
  assert.ok(app.includes('STG.p5cClearDirty(r.id)'));
  assert.ok(app.includes('STG.p5cFill(r, set,') && app.includes('c !== document.activeElement && !STG.p5cIsDirty(c.id)'));
});

// ── Q6 page part
test('Q6: a row with note crlf says the line ends in a Windows line break', () => {
  const records = [{ id: 'OPT-0991', name: 'Time zone of this Maestro', storedAs: 'env:HUB_TZ', what: 'Sets the time zone.' }];
  const rows = [{ key: 'HUB_TZ', value: null, set: false, writable: true, readonly: false, danger: false, running: null, pending: false, note: 'crlf' }];
  const html = X.expertHtml(X.models(rows, records, null));
  assert.ok(html.includes('This line ends in a Windows line break, so it is not read.'), html);
  assert.ok(!html.includes('starts with export'));
});
