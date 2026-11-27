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
  assert.strictEqual(G.p5cConfirmText(row('OPT-0931'), null, data),
    'Keys and prompts for NInfer will go to http://10.0.0.5:9000/v1 instead of https://203.0.113.10/v1. Change it?');
  assert.strictEqual(G.p5cConfirmText(row('OPT-0931'), null, { providers: { ninfer: { url: 'https://203.0.113.10/v1' } } }),
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
  const b = fakeSaver({ data: { providers: { ninfer: { url: 'http://10.0.0.5:9000/v1', fallbackUrl: 'http://10.0.0.5:9000/v1' } } } });
  b.raws['OPT-0931'] = 'http://10.0.0.5:9000/v1';
  await b.saver.save('OPT-0931');
  assert.deepStrictEqual(b.asked, [], 'the env address typed: no question');
  const c = fakeSaver({ data: { providers: { ninfer: { url: 'http://10.0.0.5:9000/v1', fallbackUrl: 'http://10.0.0.5:9000/v1' } } } });
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

// ── Q5: the row is painted whole from the stored copy (the row is locked while it saves, so nothing of the row is a draft)
function fakeInput(id, value) { return { id, value, options: [], add() {} }; }
test('Q5: p5cFill sets every control of the row from the stored copy', () => {
  const r = row('OPT-0962');
  const els = {};
  for (const p of ['google', 'openai']) for (const w of ['fast', 'best']) els[`${p}-${w}`] = fakeInput(`st-p5c-imageModels-${p}-${w}`, `typing-${p}-${w}`);
  G.p5cFill(r, { google: { fast: 'S1', best: 'S2' }, openai: { fast: 'S3' } }, (s) => els[s], (v) => ({ value: v }));
  assert.deepStrictEqual(Object.fromEntries(Object.entries(els).map(([k, e]) => [k, e.value])), { 'google-fast': 'S1', 'google-best': 'S2', 'openai-fast': 'S3', 'openai-best': '' });
});

test('Q5: app.js paints the row through STG.p5cFill without a focus guard and locks the row while it saves', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.ok(app.includes('STG.p5cFill(r, set, (s) => (s ? byId(s) : el), (v) => new Option(v, v))'));
  assert.ok(!app.includes('document.activeElement && !STG'));
  assert.ok(app.includes('lock: p5cLock'));
});

// ── save path polish: focus, read-back timeout, "still saving", hasUrlOverride, order of painting
test('focus: given back only when nothing else has it; a hidden remembered control hands it to the row\'s main control', () => {
  const body = {}, use = { n: 'use' }, main = { n: 'main' }, other = { n: 'other' }, sib = { n: 'sib' };
  const base = { body, remembered: use, ctls: [main, sib, use], main, shown: () => true };
  assert.strictEqual(G.p5cRefocus({ ...base, active: null }), use, 'nothing focused');
  assert.strictEqual(G.p5cRefocus({ ...base, active: body }), use, 'body focused');
  assert.strictEqual(G.p5cRefocus({ ...base, active: use }), use, 'still on the remembered one');
  assert.strictEqual(G.p5cRefocus({ ...base, active: sib }), use, 'a control of the same row');
  assert.strictEqual(G.p5cRefocus({ ...base, active: other }), null, 'the person moved to another control: never pulled back');
  assert.strictEqual(G.p5cRefocus({ ...base, active: use, shown: (c) => c !== use }), main, 'Use default hid itself: the main control');
  assert.strictEqual(G.p5cRefocus({ ...base, active: null, shown: () => false }), null, 'nothing can take it');
  assert.strictEqual(G.p5cRefocus({ ...base, active: other, shown: (c) => c !== use }), null, 'moved on, remembered hidden: still left alone');
  assert.strictEqual(G.p5cRefocus({ ...base, active: null, remembered: null }), null, 'nothing had focus in the row');
});

test('read-back timeout: a read-back that fails or times out is "saved, but ... could not be asked to confirm it"', async () => {
  const f = fakeSaver({ data: { filesMaxUploadMb: 100 }, backFails: true });
  f.raws['OPT-0951'] = '200';
  await f.saver.save('OPT-0951');
  assert.deepStrictEqual(f.toasts, ['Biggest upload (MB): saved, but your Maestro could not be asked to confirm it.']);
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.ok(app.includes('new AbortController()') && app.includes('ac.abort(), 8000') && app.includes('signal: ac.signal') && app.includes('clearTimeout(timer)'));
});

test('a second save of a row that is still saving says so, and posts nothing more', async () => {
  const toasts = []; const posts = []; let open;
  const saver = G.p5cSaver({ data: () => ({}), readRaw: () => '200', post: (b) => new Promise((res) => { posts.push(b); open = () => res({ ok: true }); }),
    readBack: async () => ({ filesMaxUploadMb: 200 }), confirm: () => true, toast: (t) => toasts.push(t), paint() {} });
  const first = saver.save('OPT-0951');
  await tick();
  await saver.save('OPT-0951');
  assert.deepStrictEqual(toasts, ['Biggest upload (MB): still saving…']);
  assert.strictEqual(posts.length, 1);
  open(); await first;
  assert.strictEqual(toasts[toasts.length - 1], 'Biggest upload (MB): saved.');
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.ok(app.includes("row.classList.add('st-p5c-saving')") && app.includes("row.classList.remove('st-p5c-saving')") && app.includes("h.textContent = 'Saving…'") && app.includes('hint.remove()'));
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'), /\.st-row\.st-p5c-saving \{ opacity: \.6; \}/);
  assert.ok(app.includes('STG.p5cRefocus({') && app.includes('if (f) f.focus();'));
});

test('hasUrlOverride: a stored address equal to the built-in one is an override: shown, reset asks and posts null', async () => {
  const r = row('OPT-0934');
  const mk = (over) => ({ providers: { openai: { url: 'https://api.openai.com/v1', defaultUrl: 'https://api.openai.com/v1', fallbackUrl: 'http://10.0.0.5:9000/v1', hasUrlOverride: over } } });
  assert.strictEqual(G.p5cValue(r, mk(true)), 'https://api.openai.com/v1', 'shown as set: Use default is visible');
  assert.strictEqual(G.p5cValue(r, mk(false)), undefined);
  const f = fakeSaver({ data: mk(true), back: () => ({ providers: { openai: { url: 'http://10.0.0.5:9000/v1', fallbackUrl: 'http://10.0.0.5:9000/v1', hasUrlOverride: false } } }) });
  await f.saver.save('OPT-0934', true);
  assert.deepStrictEqual(f.asked, ['Keys and prompts for OpenAI will go to http://10.0.0.5:9000/v1 instead of https://api.openai.com/v1. Change it?']);
  assert.deepStrictEqual(f.posts, [{ providers: { openai: { url: null } } }]);
  assert.strictEqual(f.data.providers.openai.hasUrlOverride, false);
  assert.strictEqual(G.p5cValue(r, f.data), undefined);
  assert.deepStrictEqual(f.toasts, ['Address for OpenAI: back to the default.']);
  // a reset with no override stored is a no-op
  const none = fakeSaver({ data: mk(false) });
  await none.saver.save('OPT-0934', true);
  assert.deepStrictEqual(none.posts, []);
  // typing sets the flag; p5cStore / p5cAssign keep it in step
  const d = mk(false);
  G.p5cStore(r, 'https://proxy.example.com', d); assert.strictEqual(d.providers.openai.hasUrlOverride, true);
  G.p5cStore(r, null, d); assert.strictEqual(d.providers.openai.hasUrlOverride, false);
  G.p5cAssign(r, 'https://api.openai.com/v1', d, true); assert.strictEqual(d.providers.openai.hasUrlOverride, true);
  G.p5cAssign(r, '', d); assert.strictEqual(d.providers.openai.hasUrlOverride, false);
});

test('model list: only the controls that list models get options, keeping their selection; focus and text inputs are left alone', () => {
  const sel = (value) => { const e = { value, options: [{ value: '', text: 'Default' }], add(o) { this.options.push(o); } }; return e; };
  const o = { name: (m) => m.toUpperCase(), mkOption: (v, t) => ({ value: v, text: t }), focused: (e) => e.focus === true };
  const mr = row('OPT-0958'), one = sel('custom-x');
  G.p5cFillModels(mr, ['claude-sdk/a', 'gpt-x'], () => one, o);
  assert.deepStrictEqual(one.options.map((x) => x.value), ['', 'claude-sdk/a', 'gpt-x', 'custom-x']);
  assert.strictEqual(one.value, 'custom-x', 'selection kept, even one the list lacks');
  const focused = sel('claude-sdk/a'); focused.focus = true;
  const on = {}; focused.addEventListener = (ev, fn, opt) => { on[ev] = { fn, opt }; };
  G.p5cFillModels(mr, ['gpt-x'], () => focused, o);
  assert.deepStrictEqual(focused.options.map((x) => x.value), [''], 'a focused control is not touched');
  // ... and is filled once the person leaves it, keeping what they chose by then (review r5)
  assert.ok(on.blur && on.blur.opt && on.blur.opt.once === true, 'filled on blur, once');
  focused.focus = false; focused.value = 'claude-sdk/a';
  on.blur.fn();
  assert.deepStrictEqual(focused.options.map((x) => x.value), ['', 'gpt-x', 'claude-sdk/a']);
  assert.strictEqual(focused.value, 'claude-sdk/a');
  const pm = row('OPT-0946'), fam = { fable: sel('claude-sdk/a'), opus: sel(''), sonnet: sel('') };
  G.p5cFillModels(pm, ['claude-sdk/a', 'gpt-x'], (s) => fam[s], o);
  assert.deepStrictEqual(fam.fable.options.map((x) => x.value), ['', 'claude-sdk/a']);
  assert.strictEqual(fam.fable.value, 'claude-sdk/a');
  const img = row('OPT-0962'), txt = { value: 'typed', options: [], add() { throw new Error('touched'); } };
  G.p5cFillModels(img, ['gpt-x'], () => txt, o);
  assert.strictEqual(txt.value, 'typed');
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const at = app.indexOf('async function p5cAfterDraw()');
  const body = app.slice(at, app.indexOf('function p5cRaw(', at));
  assert.ok(body.indexOf('p5cPaint(r)') > 0 && body.indexOf('p5cPaint(r)') < body.indexOf('await modelList()'), 'rows are painted before the model list is awaited');
  assert.ok(body.includes('STG.p5cFillModels('));
  assert.ok(!/p5cPaint\(r\)[^]*await modelList\(\)[^]*p5cPaint\(r\)/.test(body), 'nothing is repainted after the list arrives');
});

// ── Q6 page part
test('Q6: a row with note crlf says the line ends in a Windows line break', () => {
  const records = [{ id: 'OPT-0991', name: 'Time zone of this Maestro', storedAs: 'env:HUB_TZ', what: 'Sets the time zone.' }];
  const rows = [{ key: 'HUB_TZ', value: null, set: false, writable: true, readonly: false, danger: false, running: null, pending: false, note: 'crlf' }];
  const html = X.expertHtml(X.models(rows, records, null));
  assert.ok(html.includes('This line ends in a Windows line break, so it is not read.'), html);
  assert.ok(!html.includes('starts with export'));
});

test('an address with no override of its own shows the address in effect, also one from the startup settings (review r5)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'app.js'), 'utf8');
  const i = src.indexOf('function p5cPaint(r)');
  const body = src.slice(i, src.indexOf('\n    }\n', i));
  assert.ok(/r\.kind === 'url' && unset/.test(body), 'url rows handle the inherited state');
  assert.ok(/p\.url \|\| p\.fallbackUrl \|\| r\.dflt/.test(body), 'the address in effect first, then where a reset leads, then the built-in one');
  assert.ok(/el\.placeholder = effective/.test(body));
  assert.ok(body.includes('In use now: ${effective} (from the startup settings).'));
});

test('the dialog guard takes what the new rows draw as saved: Close and leaving the page ask only about real edits (proof p1)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'app.js'), 'utf8');
  const i = src.indexOf('function p5cPaint(r)');
  const paint = src.slice(i, src.indexOf('\n    }\n', i));
  assert.ok(/dialogGuard\.markLoaded\(fields\)/.test(paint), 'each painted row marks its own fields loaded');
  assert.ok(/querySelectorAll\('input, select, textarea'\)/.test(paint), 'including the checkboxes of the member models box');
  assert.ok(/X\.renderMemoryLimit\(d, \{[^}]*loaded: guardLoaded/.test(src) && /X\.render\(d, \{[^}]*loaded: guardLoaded/.test(src), 'the startup values and the memory limit hand their drawn fields to the guard');
  assert.ok(/dialogGuard\.markLoaded\(\[\.\.\.el\.querySelectorAll\('input'\)\]\)/.test(src), 'the member models list rebuilt after the catalogue too');
});
