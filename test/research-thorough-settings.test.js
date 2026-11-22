'use strict';
// Thorough research settings (admin) and the opt-in "both searches" option for research helpers.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('research-thorough-settings-');   // the lib modules below touch data/: a throwaway install
const lib = (name) => require(path.join(ISO.inst, 'lib', name));
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const server = read('server.js');
const app = read('app.js');

// ── server.js: the settings POST validation ──
// The validation block is cut out of the route's source and run against a stub store, so the real code is what is tested.
function validator(stored = {}) {
  const a = server.indexOf('if (patch && patch.researchThorough !== undefined) {');
  const b = server.indexOf('// Subscription usage (lib/codex-usage');
  assert.ok(a > 0 && b > a, 'the validation block is in the settings route');
  const src = server.slice(a, b);
  const fn = vm.runInNewContext(`(function (patch, jsonResponse, res, hubSettings) { ${src.replace(/return jsonResponse\(/g, 'return jsonResponse(')} return null; })`);
  return (patch) => {
    let out = null;
    const r = fn(patch, (rs, code, body) => { out = { code, body }; return out; }, {}, { getSetting: (k) => (k === 'researchThorough' ? stored : undefined) });
    return r || null;
  };
}

test('settings route: researchThorough good values pass and merge onto the stored ones', () => {
  const v = validator({ maxSources: 20, pdf: false });
  const patch = { researchThorough: { readersAtOnce: 6, timeLimitMinutes: '90', readerModel: 'helper', pdf: true } };
  assert.equal(v(patch), null);
  assert.deepEqual(patch.researchThorough, { maxSources: 20, pdf: true, readersAtOnce: 6, timeLimitMinutes: 90, readerModel: 'helper' });
  const edge = { researchThorough: { maxSources: 40, readersAtOnce: 1, reviewRounds: 0, timeLimitMinutes: 240 } };
  assert.equal(v(edge), null);
  assert.equal(edge.researchThorough.reviewRounds, 0);
  for (const val of ['default', 'both']) { const p = { researchHelperSearch: val }; assert.equal(v(p), null); assert.equal(p.researchHelperSearch, val); }
  assert.equal(v({ researchReminderDays: 7 }), null, 'a patch without the new keys is untouched by this block');
});

test('settings route: each bad researchThorough field is a 400 that names it', () => {
  const v = validator();
  const bad = (field, val) => {
    const r = v({ researchThorough: { [field]: val } });
    assert.ok(r && r.code === 400, `${field}=${JSON.stringify(val)} should be refused`);
    assert.ok(r.body.error.includes(field), `the error names ${field}: ${r.body.error}`);
  };
  for (const x of [0, 41, 1.5, 'abc', null, -1]) bad('maxSources', x);
  for (const x of [0, 13]) bad('readersAtOnce', x);
  for (const x of [-1, 6]) bad('reviewRounds', x);
  for (const x of [9, 241]) bad('timeLimitMinutes', x);
  for (const x of ['yes', 1, null]) bad('pdf', x);
  for (const x of ['fast', '', 5]) bad('readerModel', x);
  bad('bogus', 1);
  for (const x of [null, 'x', [], 5]) { const r = v({ researchThorough: x }); assert.equal(r.code, 400); }
  for (const x of ['', 'all', true, null]) { const r = v({ researchHelperSearch: x }); assert.equal(r.code, 400); assert.match(r.body.error, /researchHelperSearch/); }
});

test('settings route: the lead keys pass in range and merge; out of range, a bad engine or a bad model string is a 400 that names the key', () => {
  const v = validator({ maxSources: 20 });
  const p = { researchThorough: { engine: 'pipeline', leadSteps: 5, leadWallMinutes: '1440', leadReaderCalls: 400, leadReviewRounds: 0, leadReaderTextMax: 20000, leadReaderTopTextMax: 2000000,
    leadModel: 'auto', leadReaderModel: 'claude-sdk/claude-opus-5-5', leadReaderTopModel: 'a.b_c:d/e@f[1]-g' } };
  assert.equal(v(p), null);
  assert.deepEqual(p.researchThorough, { maxSources: 20, engine: 'pipeline', leadSteps: 5, leadWallMinutes: 1440, leadReaderCalls: 400, leadReviewRounds: 0, leadReaderTextMax: 20000, leadReaderTopTextMax: 2000000,
    leadModel: 'auto', leadReaderModel: 'claude-sdk/claude-opus-5-5', leadReaderTopModel: 'a.b_c:d/e@f[1]-g' });
  const ok = { researchThorough: { engine: 'lead', leadSteps: 300, leadWallMinutes: 10, leadReaderCalls: 1, leadReviewRounds: 50 } };
  assert.equal(v(ok), null);
  const bad = (field, val, re) => {
    const r = v({ researchThorough: { [field]: val } });
    assert.ok(r && r.code === 400, `${field}=${JSON.stringify(val)} should be refused`);
    assert.ok(r.body.error.includes(field), r.body.error);
    if (re) assert.match(r.body.error, re);
  };
  for (const x of [4, 301, 1.5, 'abc', null]) bad('leadSteps', x, /whole number from 5 to 300/);
  for (const x of [9, 1441]) bad('leadWallMinutes', x, /whole number from 10 to 1440/);
  for (const x of [0, 401]) bad('leadReaderCalls', x, /whole number from 1 to 400/);
  for (const x of [-1, 51]) bad('leadReviewRounds', x, /whole number from 0 to 50/);
  for (const x of [19999, 2000001]) { bad('leadReaderTextMax', x); bad('leadReaderTopTextMax', x); }
  for (const x of ['fixed', '', null, 1, 'Lead']) bad('engine', x, /'lead' or 'pipeline'/);
  for (const k of ['leadModel', 'leadReaderModel', 'leadReaderTopModel']) {
    for (const x of ['', 'a b', 'x;y', 'm'.repeat(121), 5, null, 'é']) bad(k, x, /must be 'auto' or a model id/);
  }
  bad('leadBogus', 1, /is not a setting/);
});

test('settings route: admin only (the whole route is an admin route)', () => {
  const access = lib('access');
  assert.equal(access.classifyRoute('/api/settings', 'POST').kind, 'admin');
});

// ── app.js: the Thorough block ──
function fnSrc(src, name) {
  let i = src.indexOf('async function ' + name + '(');
  if (i < 0) i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, 'missing function ' + name);
  const open = src.indexOf('{', src.indexOf(')', i));
  let depth = 0, k = open;
  for (; k < src.length; k++) { const c = src[k]; if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; } }
  return src.slice(i, k + 1);
}
function appFns(fetchImpl) {
  const toasts = [];
  const ctx = { hubToast: (m) => toasts.push(m), fetch: fetchImpl, JSON, Number, String, Number_: Number };
  vm.createContext(ctx);
  vm.runInContext(fnSrc(app, 'researchThoroughBlockHtml') + '\nlet researchThoroughSaving = false;\n' + fnSrc(app, 'saveResearchSetting') + '\nthis.block = researchThoroughBlockHtml; this.save = saveResearchSetting;', ctx);
  return { ctx, toasts };
}
const fakeEl = (type, value, saved) => ({ type, value, checked: value === true, dataset: { saved: String(saved) } });

test('Settings page: the Thorough block is drawn for admins only, after the reminder row', () => {
  assert.match(app, /\$\{isHubAdmin\(\) \? researchThoroughBlockHtml\(data\) : ''\}/);
  const remind = app.indexOf('id="st-research-remind"'), block = app.indexOf('researchThoroughBlockHtml(data)');
  assert.ok(remind > 0 && block > remind && block - remind < 2500);
  // and there is no phone control: mobile.js knows nothing of it
  assert.ok(!/researchThorough|researchHelperSearch/.test(read('mobile.js')));
});

test('Settings page: the block shows the saved values, the defaults when nothing is saved, and the hint words', () => {
  const { ctx } = appFns(async () => ({ ok: true }));
  const d = ctx.block({});
  assert.match(d, /id="st-rt-sources"[^>]*value="12"/);
  assert.match(d, /id="st-rt-readers"[^>]*value="4"/);
  assert.match(d, /id="st-rt-rounds"[^>]*value="2"/);
  assert.match(d, /id="st-rt-minutes"[^>]*value="60"/);
  assert.match(d, /id="st-rt-pdf" checked/);
  assert.match(d, /<option value="own" selected>the agent's own model<\/option><option value="helper">the fast helper model/);
  assert.match(d, /<option value="default" selected>their usual search<\/option><option value="both">their usual search and the hub's search \(test\)/);
  assert.match(d, /Needs Chrome or Chromium on this computer; without one the document is Markdown and HTML\./);
  for (const t of ['Sources read in full', 'Readers at once', 'Review rounds', 'Time limit, minutes', 'Make a PDF', 'Readers use', 'Research helpers search with']) assert.ok(d.includes(t), t);
  const s = ctx.block({ researchThorough: { maxSources: 30, readersAtOnce: 8, reviewRounds: 0, timeLimitMinutes: 120, pdf: false, readerModel: 'helper' }, researchHelperSearch: 'both' });
  assert.match(s, /id="st-rt-sources"[^>]*value="30"/);
  assert.match(s, /id="st-rt-readers"[^>]*value="8"/);
  assert.match(s, /id="st-rt-rounds"[^>]*value="0"/);
  assert.match(s, /id="st-rt-minutes"[^>]*value="120"/);
  assert.doesNotMatch(s, /id="st-rt-pdf" checked/);
  assert.match(s, /<option value="helper" selected>/);
  assert.match(s, /<option value="both" selected>/);
  // a stored value out of range is drawn as the default, never as junk
  assert.match(ctx.block({ researchThorough: { maxSources: 999, readersAtOnce: 'x' } }), /id="st-rt-sources"[^>]*value="12"/);
});

test('Settings page: the lead controls show saved values or defaults; the fixed-stage rows are hidden when the engine is lead', () => {
  const { ctx } = appFns(async () => ({ ok: true }));
  const d = ctx.block({});
  assert.match(d, /id="st-rt-engine" data-saved="lead"[^>]*>\s*<option value="lead" selected>A lead model leads it \(recommended\)<\/option><option value="pipeline">Fixed stages \(the earlier method\)/);
  assert.match(d, /id="st-rt-steps"[^>]*value="60"/);
  assert.match(d, /id="st-rt-leadmin"[^>]*value="360"/);
  assert.match(d, /id="st-rt-reads"[^>]*value="40"/);
  assert.match(d, /id="st-rt-leadrounds"[^>]*value="10"/);
  for (const id of ['st-rt-lead', 'st-rt-reader2', 'st-rt-readertop']) assert.match(d, new RegExp(`id="${id}"[^>]*placeholder="automatic" value=""`));
  assert.match(d, /<div id="st-rt-pipeline" style="display:none">/);
  for (const t of ['How Thorough runs', 'Lead steps', 'Reader calls', 'Fixed stages only', '0 turns the review off', 'Type a model id to choose one.', 'finishes with what it has and says what was left open']) assert.ok(d.includes(t), t);
  assert.ok(d.indexOf('st-rt-engine') < d.indexOf('st-rt-pdf') && d.indexOf('st-rt-pdf') < d.indexOf('st-rt-pipeline') && d.indexOf('st-rt-pipeline') < d.indexOf('st-rt-search'));
  const s = ctx.block({ researchThorough: { engine: 'pipeline', leadSteps: 100, leadWallMinutes: 720, leadReaderCalls: 7, leadReviewRounds: 0, leadModel: 'claude-sdk/claude-fable-5-2', leadReaderModel: 'auto', leadReaderTopModel: 'x"y' } });
  assert.match(s, /id="st-rt-engine" data-saved="pipeline"[^>]*>\s*<option value="lead">[^<]*<\/option><option value="pipeline" selected>/);
  assert.match(s, /id="st-rt-steps"[^>]*value="100"/);
  assert.match(s, /id="st-rt-leadmin"[^>]*value="720"/);
  assert.match(s, /id="st-rt-reads"[^>]*value="7"/);
  assert.match(s, /id="st-rt-leadrounds"[^>]*value="0"/);
  assert.match(s, /id="st-rt-lead"[^>]*value="claude-sdk\/claude-fable-5-2"/);
  assert.match(s, /id="st-rt-reader2"[^>]*value=""/);
  assert.match(s, /id="st-rt-readertop"[^>]*value=""/, 'a junk model string is drawn as automatic');
  assert.match(s, /<div id="st-rt-pipeline">/);
  assert.match(ctx.block({ researchThorough: { leadSteps: 4, leadWallMinutes: 'x' } }), /id="st-rt-steps"[^>]*value="60"/);
});

test('Settings page: lead controls post numbers and strings; an empty model saves auto; the engine toggles the fixed-stage rows after a good save', async () => {
  const posts = [];
  const { ctx } = appFns(async (url, o) => { posts.push(JSON.parse(o.body)); return { ok: true }; });
  const shown = { style: { display: 'none' } };
  ctx.document = { getElementById: (id) => (id === 'st-rt-pipeline' ? shown : null) };
  await ctx.save('leadSteps', fakeEl('number', '90', 60));
  await ctx.save('leadModel', fakeEl('text', 'claude-sdk/x', ''));
  const e = fakeEl('text', '  ', 'claude-sdk/x'); await ctx.save('leadReaderModel', e);
  await ctx.save('leadReaderTopModel', fakeEl('text', '', ''));
  assert.deepEqual(posts, [{ researchThorough: { leadSteps: 90 } }, { researchThorough: { leadModel: 'claude-sdk/x' } }, { researchThorough: { leadReaderModel: 'auto' } }, { researchThorough: { leadReaderTopModel: 'auto' } }]);
  assert.equal(e.value, '', 'the box shows empty (automatic), not the word auto'); assert.equal(e.dataset.saved, '');
  await ctx.save('engine', fakeEl('select-one', 'pipeline', 'lead'));
  assert.equal(shown.style.display, '');
  await ctx.save('engine', fakeEl('select-one', 'lead', 'pipeline'));
  assert.equal(shown.style.display, 'none');
  assert.deepEqual(posts.slice(-2), [{ researchThorough: { engine: 'pipeline' } }, { researchThorough: { engine: 'lead' } }]);
  // a refused engine save leaves the rows as they were and puts the select back
  const bad = appFns(async () => ({ ok: false, status: 400, json: async () => ({ error: 'researchThorough.engine must be' }) }));
  const keep = { style: { display: 'none' } }; bad.ctx.document = { getElementById: () => keep };
  const sel = fakeEl('select-one', 'pipeline', 'lead'); await bad.ctx.save('engine', sel);
  assert.equal(keep.style.display, 'none'); assert.equal(sel.value, 'lead');
});

test('Settings page: a change posts the right patch, saved at once, with a toast', async () => {
  const posts = [];
  const { ctx, toasts } = appFns(async (url, o) => { posts.push({ url, body: JSON.parse(o.body) }); return { ok: true }; });
  await ctx.save('maxSources', fakeEl('number', '25', 12));
  await ctx.save('pdf', fakeEl('checkbox', false, true));
  await ctx.save('readerModel', fakeEl('select-one', 'helper', 'own'));
  await ctx.save('researchHelperSearch', fakeEl('select-one', 'both', 'default'));
  assert.deepEqual(posts.map((p) => p.body), [
    { researchThorough: { maxSources: 25 } },
    { researchThorough: { pdf: false } },
    { researchThorough: { readerModel: 'helper' } },
    { researchHelperSearch: 'both' },
  ]);
  assert.ok(posts.every((p) => p.url === '/api/settings'));
  assert.equal(toasts.length, 4);
  const el = fakeEl('number', '25', 12); await ctx.save('maxSources', el); assert.equal(el.dataset.saved, '25', 'the saved value moves on');
});

test('Settings page: a failed save puts the control back and says why; one save at a time', async () => {
  const { ctx, toasts } = appFns(async () => ({ ok: false, status: 400, json: async () => ({ error: 'researchThorough.maxSources must be a whole number from 1 to 40' }) }));
  const n = fakeEl('number', '99', 12);
  await ctx.save('maxSources', n);
  assert.equal(n.value, '12');
  assert.match(toasts[0], /^Could not save: researchThorough\.maxSources must be/);
  const c = fakeEl('checkbox', false, true); await ctx.save('pdf', c); assert.equal(c.checked, true);
  const net = appFns(async () => { throw new Error('offline'); });
  const s = fakeEl('select-one', 'helper', 'own'); await net.ctx.save('readerModel', s); assert.equal(s.value, 'own'); assert.match(net.toasts[0], /offline/);
  // while one save runs a second change is put back, not sent
  let release; const gate = new Promise((r) => { release = r; });
  const posts = [];
  const slow = appFns(async (u, o) => { posts.push(o.body); await gate; return { ok: true }; });
  const first = slow.ctx.save('maxSources', fakeEl('number', '5', 12));
  const second = fakeEl('number', '7', 4);
  await slow.ctx.save('readersAtOnce', second);
  assert.equal(second.value, '4'); assert.equal(posts.length, 1);
  release(); await first;
  const third = fakeEl('number', '7', 4); await slow.ctx.save('readersAtOnce', third); assert.equal(posts.length, 2, 'free again after the first one ended');
});

// ── the virtual worker record and the plumbing ──
test('temporal workers: createVirtual carries searchBoth only when true; runWorkers passes the job flag', async () => {
  const tw = lib('temporal-workers');
  const a = tw.createVirtual({ parent: 'p', model: 'claude-sdk/x', searchBoth: true });
  const b = tw.createVirtual({ parent: 'p', model: 'claude-sdk/x' });
  const c = tw.createVirtual({ parent: 'p', model: 'claude-sdk/x', searchBoth: 'yes' });
  assert.equal(a.searchBoth, true); assert.ok(!('searchBoth' in b)); assert.ok(!('searchBoth' in c));
  for (const v of [a, b, c]) tw.releaseVirtual(v.id);
  const seen = [];
  const lim = { run: async (p, fn) => fn() };
  await tw.runWorkers([{ index: 1, task: 'task one is long', model: 'claude-sdk/x', provider: 'claude-sdk', toolScope: 'read', label: 'a', searchBoth: true }, { index: 2, task: 'task two is long', model: 'claude-sdk/x', provider: 'claude-sdk', toolScope: 'read', label: 'b' }],
    { parent: 'p', limiter: lim, runOne: async (job, v) => { seen.push([job.label, v.searchBoth === true]); return 'ok'; } });
  assert.deepEqual(seen.sort(), [['a', true], ['b', false]]);
});

test('spawn plumbing: only the research runner may mark a worker; an agent\'s own spawn_workers call never can', () => {
  const sdk = read('lib/sdk-chat.js');
  assert.match(sdk, /runSpawnWorkers\(agent, workers, null, signal \|\| null, null, \{ detached: true, raw: true, admit: \(opts && opts\.admit\) \|\| null, allowSearchBoth: true \}\)/);
  assert.equal((sdk.match(/allowSearchBoth: true/g) || []).length, 1);
  assert.match(sdk, /if \(allowSearchBoth\) for \(const j of norm\.jobs\)/);
  assert.match(sdk, /helperSearchBoth: \(\) => \{ try \{ return require\('\.\/settings'\)\.getSetting\('researchHelperSearch'\) === 'both'; \}/);
});

// ── the SDK option builder ──
const sdkChat = lib('sdk-chat');
const hubTools = lib('hub-tools');
function fakeSdk() {
  const made = [];
  return {
    made,
    tool: (name, description, shape, handler, extra) => ({ name, description, handler, extra }),
    createSdkMcpServer: (o) => { made.push(o); return { type: 'sdk', ...o }; },
  };
}
const baseOptions = () => ({
  allowedTools: ['Bash(*)', 'Read(*)', 'WebFetch(*)', 'WebSearch(*)', 'mcp__agent-hub__*'],
  mcpServers: { 'agent-hub': { name: 'agent-hub' } },
  disallowedTools: ['Agent', 'Task', 'Bash', 'Write', 'Edit', 'NotebookEdit'],
});

test('SDK options: searchBoth on a client-mode worker adds the hub server with only WebSearch and WebFetch, and allows exactly those two', () => {
  const v = { id: 'tw-x', model: 'claude-sdk/x', toolScope: 'read', searchBoth: true };
  const applies = sdkChat.searchBothApplies(v, { hubHands: false, sandboxWithheld: false });
  assert.equal(applies, true);
  const sdk = fakeSdk();
  const tools = hubTools.createHubTools({ cwd: process.cwd() });
  const opts = sdkChat.withSearchBoth(baseOptions(), applies, () => sdkChat.buildHandsMcpServer(sdk, tools, { only: sdkChat.SEARCH_BOTH_TOOLS }));
  assert.deepEqual(opts.mcpServers.hub.tools.map((t) => t.name).sort(), ['WebFetch', 'WebSearch']);
  assert.ok(opts.mcpServers['agent-hub'], 'the hub MCP server of the agent stays');
  assert.ok(opts.allowedTools.includes('mcp__hub__WebSearch') && opts.allowedTools.includes('mcp__hub__WebFetch'));
  assert.ok(!opts.allowedTools.includes('mcp__hub__*'), 'no wildcard: no shell or file tool of the hub');
  assert.ok(opts.allowedTools.includes('WebSearch(*)') && opts.allowedTools.includes('WebFetch(*)'), 'the client keeps its own tools');
  assert.deepEqual(opts.disallowedTools, baseOptions().disallowedTools, 'nothing the client was refused is allowed back');
  assert.ok(!opts.disallowedTools.includes('mcp__hub__WebSearch'));
  // the tool names the policy gate will see are classified as the web class, like the client's own
  const tp = lib('tool-policy');
  assert.equal(tp.classifyTool({ tool: 'mcp__hub__WebSearch', input: { query: 'q' }, agentName: 'tw-x', policy: {} }).cls, 'web');
  assert.equal(tp.classifyTool({ tool: 'mcp__hub__WebFetch', input: { url: 'https://example.org/a' }, agentName: 'tw-x', policy: {} }).cls, 'web');
});

test('SDK options: setting off, hub mode, a withheld box, no tools and no flag all leave the options exactly as before', () => {
  const before = JSON.parse(JSON.stringify(baseOptions()));
  const make = () => { throw new Error('the server must not be built'); };
  const cases = [
    [{ id: 'a', toolScope: 'read' }, {}],                                            // setting off or unset: the record has no flag
    [{ id: 'a', toolScope: 'read', searchBoth: false }, {}],
    [{ id: 'a', toolScope: 'read', searchBoth: true }, { hubHands: true }],          // hands mode hub already has the hub's search
    [{ id: 'a', toolScope: 'read', searchBoth: true }, { sandboxWithheld: true }],
    [{ id: 'a', toolScope: 'none', searchBoth: true }, {}],                          // no tools at all
    [null, {}],                                                                        // an ordinary agent turn
  ];
  for (const [v, flags] of cases) {
    assert.equal(sdkChat.searchBothApplies(v, flags), false, JSON.stringify([v, flags]));
    const o = baseOptions();
    const r = sdkChat.withSearchBoth(o, sdkChat.searchBothApplies(v, flags), make);
    assert.strictEqual(r, o);
    assert.deepEqual(JSON.parse(JSON.stringify(r)), before);
  }
});

test('SDK options: the turn calls the builder with the worker, the hands mode and the withheld box; the hub-mode server code is unchanged', () => {
  const sdk = read('lib/sdk-chat.js');
  assert.match(sdk, /withSearchBoth\(queryOptions, searchBothApplies\(twVirtual, \{ hubHands, sandboxWithheld \}\),\n\s+\(\) => buildHandsMcpServer\(sdk, hands\.tools, \{ only: SEARCH_BOTH_TOOLS, signal: abortController\.signal \}\)\);/);
  assert.match(sdk, /queryOptions\.mcpServers\.hub = buildHandsMcpServer\(sdk, hands\.tools, \{ blocked: blockedTools, signal: abortController\.signal \}\);/);
});

test('Codex turn: a marked worker gets the hub\'s WebSearch and WebFetch through the bridge (only those), nothing else changes', () => {
  const sdk = read('lib/sdk-chat.js');
  const codex = sdk.slice(sdk.indexOf('async function streamViaCodex('));
  assert.match(codex, /const searchBoth = searchBothApplies\(twVirtual, \{ hubHands: hands\.mode === 'hub', sandboxWithheld: hands\.withheld \}\);\n\s+if \(searchBoth\) \{\n\s+const h = buildHandsMcpServer\(codexBridge\.collectingSdk, hands\.tools, \{ only: SEARCH_BOTH_TOOLS, signal: abortController\.signal \}\);\n\s+for \(const t of h\.tools\) hubTools\.push\(t\);/);
  // the bridge list for a marked worker is exactly the two, built the same way as the Claude client's
  const bridge = lib('codex-cli/bridge');
  const tools = hubTools.createHubTools({ cwd: process.cwd() });
  const h = sdkChat.buildHandsMcpServer(bridge.collectingSdk, tools, { only: sdkChat.SEARCH_BOTH_TOOLS });
  assert.deepEqual(h.tools.map((t) => t.name).sort(), ['WebFetch', 'WebSearch']);
  // an unmarked or hands-mode-hub turn adds nothing
  assert.equal(sdkChat.searchBothApplies({ toolScope: 'read' }, { hubHands: false }), false);
  assert.equal(sdkChat.searchBothApplies({ toolScope: 'read', searchBoth: true }, { hubHands: true }), false);
});

// ── r4 B2: the discovery gate settings ──
test('r4-B2 settingsFrom: leadTopicSearches 3 and leadSourcesPerSub 2 by default; 0 to 20 allowed, anything else is the default', () => {
  const T = lib('research-thorough.js');
  const d = T.settingsFrom({});
  assert.deepEqual([d.leadTopicSearches, d.leadSourcesPerSub], [3, 2]);
  assert.deepEqual([T.DEFAULTS.leadTopicSearches, T.DEFAULTS.leadSourcesPerSub], [3, 2]);
  for (const [k, dflt] of [['leadTopicSearches', 3], ['leadSourcesPerSub', 2]]) {
    assert.equal(T.settingsFrom({ [k]: 0 })[k], 0, k + ' 0 switches the rule off');
    assert.equal(T.settingsFrom({ [k]: 20 })[k], 20, k);
    assert.equal(T.settingsFrom({ [k]: '7' })[k], 7, k);
    for (const bad of [-1, 21, 1.5, 'x', null, undefined]) assert.equal(T.settingsFrom({ [k]: bad })[k], dflt, `${k}=${bad}`);
  }
});

test('r4-B2 settings route: the two gate numbers pass from 0 to 20 and are refused outside, naming the key', () => {
  const v = validator({});
  const p = { researchThorough: { leadTopicSearches: 0, leadSourcesPerSub: '20' } };
  assert.equal(v(p), null);
  assert.deepEqual(p.researchThorough, { leadTopicSearches: 0, leadSourcesPerSub: 20 });
  for (const k of ['leadTopicSearches', 'leadSourcesPerSub']) {
    for (const x of [-1, 21, 1.5, 'abc', null]) {
      const r = v({ researchThorough: { [k]: x } });
      assert.ok(r && r.code === 400, `${k}=${x}`);
      assert.ok(r.body.error.includes(k) && /0 to 20/.test(r.body.error), r.body.error);
    }
  }
});

test('r4-B2 Settings page: the two gate rows exist with their ids, defaults, saved values and hints', () => {
  const { ctx } = appFns(async () => ({ ok: true }));
  const d = ctx.block({});
  assert.match(d, /id="st-rt-topics"[^>]*min="0"[^>]*max="20"[^>]*value="3"[^>]*onchange="saveResearchSetting\('leadTopicSearches', this\)"/);
  assert.match(d, /id="st-rt-persub"[^>]*min="0"[^>]*max="20"[^>]*value="2"[^>]*onchange="saveResearchSetting\('leadSourcesPerSub', this\)"/);
  for (const t of ['Topic searches per sub-question', 'Sources per sub-question',
    'Before the first draft the lead must run this many topic searches for each sub-question, one of them limited to recent work. 0 switches the rule off.',
    'Distinct sources those searches must find for each sub-question before the first draft.']) assert.ok(d.includes(t), t);
  assert.ok(d.indexOf('st-rt-leadrounds') < d.indexOf('st-rt-topics') && d.indexOf('st-rt-persub') < d.indexOf('st-rt-pipeline'));
  const s = ctx.block({ researchThorough: { leadTopicSearches: 0, leadSourcesPerSub: 5 } });
  assert.match(s, /id="st-rt-topics"[^>]*value="0"/);
  assert.match(s, /id="st-rt-persub"[^>]*value="5"/);
  assert.match(ctx.block({ researchThorough: { leadTopicSearches: 21, leadSourcesPerSub: 'x' } }), /id="st-rt-topics"[^>]*value="3"[\s\S]*id="st-rt-persub"[^>]*value="2"/);
});

test('r4-B2 Settings page: the gate rows post a number under researchThorough', async () => {
  const posts = [];
  const { ctx } = appFns(async (url, o) => { posts.push(JSON.parse(o.body)); return { ok: true }; });
  await ctx.save('leadTopicSearches', fakeEl('number', '0', 3));
  await ctx.save('leadSourcesPerSub', fakeEl('number', '4', 2));
  assert.deepEqual(posts, [{ researchThorough: { leadTopicSearches: 0 } }, { researchThorough: { leadSourcesPerSub: 4 } }]);
});
