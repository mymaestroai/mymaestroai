'use strict';
// "🔎 More OpenRouter models…": the chat header's model picker (phone and desktop) offers only the OpenRouter models
// ticked in Settings → OpenRouter. The last line of its OpenRouter group opens a search over the whole catalogue;
// choosing a model adds it to that list (so every picker offers it from then on) and switches the agent to it.
// The search and formatting functions are pure and are run here as they are in the pages.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const app = read('app.js'), mjs = read('mobile.js'), mhtml = read('mobile.html'), index = read('index.html');

function extract(src, name) {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} present`);
  // Skip the parameter list first (a default such as `opts = {}` holds braces), then take the body.
  let p = src.indexOf('(', at); let pd = 0;
  for (; p < src.length; p++) { if (src[p] === '(') pd++; else if (src[p] === ')' && --pd === 0) break; }
  let i = src.indexOf('{', p); let depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(at, i + 1);
}
const load = (src, names, ret) => new Function(`${names.map(n => extract(src, n)).join('\n')}; return ${ret};`)();
const phone = load(mjs, ['orSheetList', 'orOfferWith', 'orMeta'], '{ list: orSheetList, offerWith: orOfferWith, meta: orMeta }');
const desk = load(app, ['orPickList', 'orOfferWith', 'orPrice', 'orPickMeta'], '{ list: orPickList, offerWith: orOfferWith, meta: orPickMeta }');

const CATALOGUE = [
  { id: 'x-ai/grok-4.7', name: 'xAI: Grok 4.7', created: 300, tools: true, reasoning: true, images: true, context: 500000, prompt: 2e-6, completion: 1e-5 },
  { id: 'x-ai/grok-3-mini', name: 'xAI: Grok 3 Mini', created: 100, tools: true, reasoning: true, images: false, context: 131072, prompt: 3e-7, completion: 5e-7 },
  { id: 'moonshotai/kimi-k3', name: 'MoonshotAI: Kimi K3', created: 250, tools: true, reasoning: false, images: false, context: 1048576, prompt: 6e-7, completion: 2.5e-6 },
  { id: 'gryphe/mythomax-l2-13b', name: 'MythoMax 13B', created: 50, tools: false, reasoning: false, images: false, context: 4096, prompt: 6e-8, completion: 6e-8 },
  { id: 'openai/gpt-5.6-sol:batch', name: 'OpenAI: GPT-5.6 Sol (batch)', created: 400, tools: true, context: 400000, prompt: 1e-6, completion: 8e-6 },
];

for (const [label, page] of [['phone', phone], ['desktop', desk]]) {
  test(`${label}: the search lists tool-capable models newest first, never batch variants`, () => {
    assert.deepStrictEqual(page.list(CATALOGUE, '', false).map(m => m.id), ['x-ai/grok-4.7', 'moonshotai/kimi-k3', 'x-ai/grok-3-mini']);
    assert.deepStrictEqual(page.list(CATALOGUE, '', true).map(m => m.id), ['x-ai/grok-4.7', 'moonshotai/kimi-k3', 'x-ai/grok-3-mini', 'gryphe/mythomax-l2-13b'],
      'the "without tools" box adds chat-only models');
  });
  test(`${label}: every word of the query must match the id or the name, in any case`, () => {
    assert.deepStrictEqual(page.list(CATALOGUE, 'GROK 4', false).map(m => m.id), ['x-ai/grok-4.7']);
    assert.deepStrictEqual(page.list(CATALOGUE, 'moonshot', false).map(m => m.id), ['moonshotai/kimi-k3'], 'names count, not just ids');
    assert.deepStrictEqual(page.list(CATALOGUE, '  mini  grok ', false).map(m => m.id), ['x-ai/grok-3-mini']);
    assert.deepStrictEqual(page.list(CATALOGUE, 'mythomax', false), [], 'chat-only models stay out unless asked for');
    assert.deepStrictEqual(page.list(undefined, 'x', false), []);
  });
  test(`${label}: adding a model keeps the current list (the default offer included) and never repeats one`, () => {
    const cur = ['x-ai/grok-4.7', 'deepseek/deepseek-v4.1-flash'];
    assert.deepStrictEqual(page.offerWith(cur, 'moonshotai/kimi-k3'), ['x-ai/grok-4.7', 'deepseek/deepseek-v4.1-flash', 'moonshotai/kimi-k3']);
    assert.deepStrictEqual(cur, ['x-ai/grok-4.7', 'deepseek/deepseek-v4.1-flash'], 'the saved list is not changed in place');
    assert.deepStrictEqual(page.offerWith(cur, 'x-ai/grok-4.7'), cur);
    assert.deepStrictEqual(page.offerWith(undefined, 'x-ai/grok-4.7'), ['x-ai/grok-4.7']);
  });
  test(`${label}: each row says what the model can do, its context window and its price`, () => {
    assert.strictEqual(page.meta(CATALOGUE[0]), '🛠 🧠 🖼 · 500K context · $2.00 / $10 per M');
    assert.strictEqual(page.meta(CATALOGUE[2]), '🛠 · 1.0M context · $0.60 / $2.50 per M');
    assert.strictEqual(page.meta({ id: 'a/b', tools: false }), '', 'nothing known, nothing shown');
  });
}

test('both pages agree row for row', () => {
  for (const q of ['', 'grok', 'kimi k3', 'zzz']) {
    assert.deepStrictEqual(phone.list(CATALOGUE, q, true).map(m => m.id), desk.list(CATALOGUE, q, true).map(m => m.id), q);
  }
  for (const m of CATALOGUE) assert.strictEqual(phone.meta(m), desk.meta(m), m.id);
});

test('phone: the picker\'s OpenRouter group ends with the search entry, and choosing it opens the sheet', () => {
  assert.match(mjs, /const OR_MORE = '__or_more__';/);
  assert.match(mjs, /\+ \(label\.startsWith\('OpenRouter'\) \? `<option value="\$\{OR_MORE\}">🔎 More OpenRouter models…<\/option>` : ''\) \+ '<\/optgroup>'/);
  assert.match(mjs, /const model = sel\.value;\n  if \(model === OR_MORE\) \{ sel\.value = a \? a\.model : ''; if \(a\) openOrSheet\(name\); return; \}\n  if \(!a \|\| !model \|\| model === a\.model\) return;/,
    'the entry is never posted as a model');
  assert.match(mhtml, /<dialog id="or-sheet" data-no-dirty><\/dialog>/);   // search and filter only (lib/ui-dialog.js)
  assert.match(mhtml, /#or-sheet input\[type="search"\] \{[^}]*font-size: 16px;/, '16px, so iOS does not zoom into the search box');
  assert.match(mhtml, /#or-sheet \.ors-row \{[^}]*min-height: 48px;/, 'rows are finger-sized');
});

test('phone: the sheet loads the catalogue, adds the model to the list, then switches the agent', () => {
  const open = extract(mjs, 'openOrSheet'); const click = extract(mjs, 'onOrSheetClick');
  assert.match(open, /await api\('\/api\/openrouter'\)/);
  assert.match(open, /Date\.now\(\) - orSheetView\.at > 10 \* 60000/, 'the catalogue is reused for ten minutes');
  const add = click.indexOf("api('/api/openrouter', { method: 'POST'"); const sw = click.indexOf('/model`, { method: \'POST\'');
  assert.ok(add > 0 && sw > add, 'the list is saved before the agent switches');
  assert.match(click, /body: JSON\.stringify\(\{ models: orOfferWith\(v\.chosen, id\) \}\)/);
  assert.match(click, /if \(!\(v\.chosen \|\| \[\]\)\.includes\(id\)\)/, 'a model already in the list is not saved again');
  assert.match(click, /_modelListCache = null;/, 'the picker refetches the list');
  assert.match(click, /note = '\. It could not be added to the OpenRouter list';[\s\S]*?if \(\(d\.chosen \|\| \[\]\)\.includes\(id\)\) note = '';/,
    'the toast says so when the hub did not keep the model in the list');
  assert.match(click, /modelChanged\(a, name, model, note\);\n  if \(current === name\) fillModelPick\(\);/);
  assert.match(extract(mjs, 'modelChanged'), /switches to \$\{mpLabel\(model\)\} after this reply/, 'a busy agent switches after its reply, as from the picker');
});

test('desktop: the picker\'s OpenRouter group ends with the search entry, and choosing it opens the window', () => {
  assert.match(app, /const OR_MORE = '__or_more__';/);
  assert.match(app, /\+ \(label\.startsWith\('OpenRouter'\) \? `<option value="\$\{OR_MORE\}">🔎 More OpenRouter models…<\/option>` : ''\) \+ '<\/optgroup>'/);
  assert.match(extract(app, 'changeChatModel'), /if \(chat && model === OR_MORE\) \{ if \(sel\) sel\.value = chat\.model; openOrPicker\(chatId\); return false; \}\n\s*if \(!chat \|\| !model \|\| model === chat\.model\) return false;/);
  const open = extract(app, 'openOrPicker');
  assert.match(open, /fetch\('\/api\/openrouter', \{ credentials: 'include' \}\)/);
  assert.match(open, /if \(e\.target === ov\) closeOrPicker\(\);/, 'a click outside closes it');
  assert.match(open, /ov\.dataset\.noDirty = '1';/, 'search and filter only: Esc (the shared dialog guard) closes it without asking');
  const choose = extract(app, 'chooseOrModel');
  const add = choose.indexOf("fetch('/api/openrouter', { method: 'POST'"); const sw = choose.indexOf('await changeChatModel(chatId, model, { tested: true })');
  assert.ok(add > 0 && sw > add, 'the list is saved before the agent switches');
  assert.match(choose, /body: JSON\.stringify\(\{ models: orOfferWith\(v\.chosen, id\) \}\)/);
  assert.match(choose, /__modelListCache = null;/);
  assert.match(choose, /if \(\(j\.chosen \|\| \[\]\)\.includes\(id\)\) note = '';/, 'the toast says so when the hub did not keep the model in the list');
  assert.match(choose, /document\.querySelectorAll\('select\.model-pick\[data-filled\]'\)\.forEach\(s => \{ delete s\.dataset\.filled; \}\);/, 'every open chat\'s picker refills');
  assert.match(index, /\.gs-modal\.or-pick \{ max-width: 720px; \}/);
  assert.match(index, /\.or-pick-row \{[^}]*cursor: pointer;/);
});

// Reasoning effort in the chat header: OpenRouter models show the picker when OpenRouter's catalogue marks them as
// taking a reasoning level (the flag lib/effort reads too); unknown until the list arrives, then the picker repaints.
const CAT = { models: [
  { id: 'x-ai/grok-4.7', reasoning: true }, { id: 'meta-llama/llama-4-maverick', reasoning: false }, { id: '~x-ai/grok-latest', reasoning: true },
] };
const effortOf = (src, viewName, view) => {
  const loads = { n: 0 };
  const fn = new Function(viewName, 'orLoadCatalogue', `${extract(src, 'effortSupported')}\n${extract(src, 'orReasons')}; return effortSupported;`)(view, () => { loads.n++; });
  return { fn, loads };
};
for (const [label, src, viewName] of [['phone', mjs, 'orSheetView'], ['desktop', app, 'orPickView']]) {
  test(`${label}: the effort picker shows for OpenRouter models that take a reasoning level, and only those`, () => {
    const { fn, loads } = effortOf(src, viewName, { at: 1, view: CAT });
    assert.strictEqual(fn('openrouter/x-ai/grok-4.7'), true);
    assert.strictEqual(fn('openrouter/~x-ai/grok-latest'), true, 'aliases too');
    assert.strictEqual(fn('openrouter/meta-llama/llama-4-maverick'), false);
    assert.strictEqual(fn('openrouter/nobody/unknown'), false);
    assert.strictEqual(fn('claude-sdk/opus'), true, 'other routes unchanged');
    assert.strictEqual(fn('google/gemini-4-argon'), true);
    assert.strictEqual(fn('local/qwen3.8-27b'), false);
    assert.strictEqual(loads.n, 0, 'a loaded list is not fetched again');
  });
  test(`${label}: before the OpenRouter list is in, the picker stays hidden and the list is fetched`, () => {
    const { fn, loads } = effortOf(src, viewName, null);
    assert.strictEqual(fn('openrouter/x-ai/grok-4.7'), false);
    assert.strictEqual(loads.n, 1);
    assert.strictEqual(fn('claude-sdk/opus'), true);
    assert.strictEqual(loads.n, 1, 'only OpenRouter models need it');
  });
}
test('the list for effort is fetched by admins only, at most once a minute, then the picker repaints', () => {
  const ph = extract(mjs, 'orLoadCatalogue'); const dk = extract(app, 'orLoadCatalogue');
  assert.match(ph, /if \(!isAdmin\(\) \|\| Date\.now\(\) - orCatalogueTriedAt < 60000\) return;/);
  assert.match(ph, /await api\('\/api\/openrouter'\)/);
  assert.match(ph, /if \(orSheetView\) fillEffortPick\(\);/);
  assert.match(dk, /if \(!isHubAdmin\(\) \|\| Date\.now\(\) - orCatalogueTriedAt < 60000\) return;/);
  assert.match(dk, /fetch\('\/api\/openrouter', \{ credentials: 'include' \}\)/);
  assert.match(dk, /if \(orPickView\) for \(const c of Object\.values\(chats\)\) if \(c && c\.id\) refreshEffortPick\(c\);/);
  assert.match(read('agent-settings.html'), /OpenRouter models that take a reasoning level, marked 🧠 in the OpenRouter list, at high/);
});

test('the catalogue and the list are admin-only routes', () => {
  const { classifyRoute } = require('../lib/access');
  assert.strictEqual(classifyRoute('/api/openrouter', 'GET').kind, 'admin');
  assert.strictEqual(classifyRoute('/api/openrouter', 'POST').kind, 'admin');
});

test('the phone app version moved on, so phones load the new code', () => {
  assert.match(read('sw.js'), /const VERSION = 'hub-mobile-v60'/);
});
