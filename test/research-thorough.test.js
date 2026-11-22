'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('../lib/research-thorough');

const SOURCE = [
  'Abstract. We compare two ranking methods on a pool of 1,450 items rated by 30 raters.',
  'Table 6 shows the main result: the new method is preferred 56.4% against 43.6% for the baseline.',
  'In the retrieval study, precision 0.884, recall 0.550 and a drop of −3.2 points on the hard split.',
  'An unrelated list: 21450 tickets, 14.50 dollars, 156.4 meters.',
  'Elsewhere the text mentions 5 groups and 7 sites in a different context entirely.',
].join('\n');

const FETCHED = [{ url: 'https://arxiv.org/abs/2401.01234v2', finalUrl: 'https://arxiv.org/html/2401.01234v2', title: 'Ranking paper', ok: true, text: SOURCE }];

// ---------------------------------------------------------------- settings
test('settingsFrom: defaults, ranges, invalid fall back per field', () => {
  assert.deepStrictEqual(T.settingsFrom(undefined), T.DEFAULTS);
  const s = T.settingsFrom({ maxSources: 99, readersAtOnce: '6', reviewRounds: 0, timeLimitMinutes: 5, pdf: 'no', readerModel: 'helper' });
  assert.strictEqual(s.maxSources, 12);
  assert.strictEqual(s.readersAtOnce, 6);
  assert.strictEqual(s.reviewRounds, 0);
  assert.strictEqual(s.timeLimitMinutes, 60);
  assert.strictEqual(s.pdf, true);
  assert.strictEqual(s.readerModel, 'helper');
  assert.strictEqual(T.settingsFrom({ maxSources: 1.5, pdf: false, readerModel: 'x' }).maxSources, 12);
  assert.strictEqual(T.settingsFrom({ pdf: false }).pdf, false);
  assert.strictEqual(T.settingsFrom({ readerModel: 'x' }).readerModel, 'own');
  assert.strictEqual(T.settingsFrom({ maxSources: 40, readersAtOnce: 12, reviewRounds: 5, timeLimitMinutes: 240 }).timeLimitMinutes, 240);
  assert.deepStrictEqual(T.STAGES, ['quick', 'select', 'fetch', 'read', 'synthesis', 'check', 'challenge', 'document']);
});

// ---------------------------------------------------------------- numbers
test('normFigure: separators, minus, plus, percent, exact digits kept', () => {
  assert.strictEqual(T.normFigure('1,450'), '1450');
  assert.strictEqual(T.normFigure('1 450'), '1450');
  assert.strictEqual(T.normFigure('1 450'), '1450');
  assert.strictEqual(T.normFigure('−3.2'), '-3.2');
  assert.strictEqual(T.normFigure('+4.5'), '4.5');
  assert.strictEqual(T.normFigure('56.4%'), '56.4');
  assert.strictEqual(T.normFigure('0.550'), '0.550');
  assert.notStrictEqual(T.normFigure('0.550'), T.normFigure('0.55'));
});

test('numbersIn: tokens with positions, percents, negatives', () => {
  const toks = T.numbersIn('Got 1,450 items, 56.4% and −3.2 and 0.550.');
  assert.deepStrictEqual(toks.map((t) => t.value), ['1450', '56.4', '-3.2', '0.550']);
  assert.strictEqual(toks[1].percent, true);
  const text = 'Got 1,450 items';
  assert.strictEqual(text.slice(toks[0].index, toks[0].end), '1,450');
});

test('numbersIn: never part of a longer number', () => {
  const v = (s) => T.numbersIn(s).map((t) => t.value);
  assert.deepStrictEqual(v('21450'), ['21450']);
  assert.deepStrictEqual(v('14.50'), ['14.50']);
  assert.ok(!v('21450 and 14.50').includes('1450'));
  assert.deepStrictEqual(v('156.4'), ['156.4']);
  assert.ok(!v('156.4').includes('56.4'));
  assert.deepStrictEqual(v('1,4500'), ['1', '4500']);
  assert.deepStrictEqual(v('2019-2020'), ['2019', '2020']);
});

// ---------------------------------------------------------------- checkFigure
test('checkFigure: found, not found, exact digits', () => {
  // r4: units match exactly; SOURCE prints 56.4% so a bare 56.4 is not found (it used to be)
  assert.strictEqual(T.checkFigure('56.4', SOURCE, []), 'not_found');
  assert.strictEqual(T.checkFigure('56.4%', SOURCE, []), 'found');
  assert.strictEqual(T.checkFigure('1450', SOURCE, []), 'found');
  // -3.2 has 2 significant digits, so it is now a common number (r2 fix 6) and needs a keyword nearby
  assert.strictEqual(T.checkFigure('-3.2', SOURCE, ['points']), 'found');
  assert.strictEqual(T.checkFigure('-3.2', SOURCE, []), 'common_not_near');
  assert.strictEqual(T.checkFigure('0.550', SOURCE, []), 'found');
  assert.strictEqual(T.checkFigure('0.55', SOURCE, []), 'not_found');
  assert.strictEqual(T.checkFigure('43.7', SOURCE, []), 'not_found');
  const only = 'tickets: 21450 and 156.4 meters';
  assert.strictEqual(T.checkFigure('1450', only, []), 'not_found');
  assert.strictEqual(T.checkFigure('56.4', only, []), 'not_found');
});

test('checkFigure: common numbers need a keyword nearby', () => {
  assert.strictEqual(T.checkFigure('30', SOURCE, ['raters']), 'found');
  assert.strictEqual(T.checkFigure('30', SOURCE, ['elephants']), 'common_not_near');
  assert.strictEqual(T.checkFigure('30', SOURCE, []), 'common_not_near');
  assert.strictEqual(T.checkFigure('5', SOURCE, ['groups']), 'found');
  // r2 fix 1: a percent figure no longer matches a plain "5 groups" in the source
  assert.strictEqual(T.checkFigure('5%', SOURCE, ['groups']), 'not_found');
  const far = 'The number 30 appears here.' + ' filler'.repeat(100) + ' raters were many.';
  assert.strictEqual(T.checkFigure('30', far, ['raters']), 'common_not_near');
  assert.strictEqual(T.checkFigure('99', SOURCE, ['raters']), 'not_found');
});

test('keywordsFrom: 5+ letter words, longest first, top 8', () => {
  const k = T.keywordsFrom('The new method is preferred by thirty annotators across multiple benchmark datasets and categories');
  assert.ok(k.length <= 8);
  assert.ok(k.every((w) => w.length >= 5 && w === w.toLowerCase()));
  assert.strictEqual(k[0], 'annotators');
  assert.ok(!k.includes('the'));
});

// ---------------------------------------------------------------- checkClaims
test('checkClaims: all statuses, totals, arXiv variants', () => {
  const claims = [
    { id: 'c1', claim: 'The new method is preferred over the baseline', source_url: 'https://arxiv.org/pdf/2401.01234', figures: ['56.4%', '43.6%'] },
    { id: 'c2', claim: 'Retrieval precision and recall are reported', source_url: 'https://arxiv.org/abs/2401.01234v2', figures: ['0.884', '0.55'] },
    { id: 'c3', claim: 'Invented numbers appear here', source_url: 'https://arxiv.org/html/2401.01234', figures: ['77.7', '88.8'] },
    { id: 'c4', claim: 'Other source claim', source_url: 'https://example.org/other', figures: ['12.5', '9.9'] },
    { id: 'c5', claim: 'No numbers in this claim', source_url: 'https://arxiv.org/abs/2401.01234', figures: [] },
    { id: 'c6', claim: 'Raters count', source_url: 'https://arxiv.org/html/2401.01234v2', figures: ['30'] },
  ];
  const r = T.checkClaims(claims, FETCHED);
  const st = Object.fromEntries(r.claims.map((c) => [c.id, c.status]));
  assert.deepStrictEqual(st, { c1: 'verified', c2: 'partly', c3: 'unverified', c4: 'source_not_opened', c5: 'no_figures', c6: 'verified' });
  assert.strictEqual(r.claims[3].source_opened, false);
  assert.strictEqual(r.claims[0].source_opened, true);
  assert.deepStrictEqual(r.claims[1].figures.map((f) => f.status), ['found', 'not_found']);
  assert.deepStrictEqual(r.totals, { claims: 6, figures: 9, found: 4, notFound: 3, notOpened: 2 });
});

test('checkClaims: matches finalUrl and trailing slash/fragment/case', () => {
  const fetched = [{ url: 'https://short.example/x', finalUrl: 'https://Docs.Example.com/page/', ok: true, text: 'value 12.5 here' }];
  const r = T.checkClaims([{ id: 'c1', claim: 'Value', source_url: 'https://docs.example.com/page#top', figures: ['12.5'] }], fetched);
  assert.strictEqual(r.claims[0].status, 'verified');
  const r2 = T.checkClaims([{ id: 'c1', claim: 'Value', source_url: 'https://docs.example.com/page', figures: ['12.5'] }], [{ url: 'https://docs.example.com/page', ok: false, text: '', error: 'x' }]);
  assert.strictEqual(r2.claims[0].status, 'source_not_opened');
});

// ---------------------------------------------------------------- prose figures
const pf = (s) => T.figuresInProse(s).map((t) => t.raw);

test('figuresInProse: counts real figures', () => {
  assert.deepStrictEqual(pf('Preferred 56.4% against 43.6%, 1,450 items.'), ['56.4%', '43.6%', '1,450']);
});
test('figuresInProse exempt: years standing alone', () => {
  assert.deepStrictEqual(pf('Published in 2024 and 1999.'), []);
  assert.deepStrictEqual(pf('Up 2024%'), ['2024%']);
  assert.deepStrictEqual(pf('Cost 1850 units'), ['1850']);
});
test('figuresInProse exempt: full dates', () => {
  assert.deepStrictEqual(pf('Dated 2026-11-21 and 3/14/2025 and March 5, 2024 and 5 March 2024.'), []);
});
test('figuresInProse exempt: numbers inside URLs', () => {
  assert.deepStrictEqual(pf('See https://arxiv.org/abs/2401.01234v2 and [x](https://example.org/a/45/b?x=12).'), []);
});
test('figuresInProse exempt: list markers at line start', () => {
  assert.deepStrictEqual(pf('1. First\n2) Second\n  - 3. Third\nThen 7. no'), ['7']);
});
test('figuresInProse exempt: locations', () => {
  assert.deepStrictEqual(pf('See Table 6, Section 4.2, Figure 3, Appendix B2, Fig. 7 and Eq. 5.'), []);
  assert.deepStrictEqual(pf('Table 6 reports 12.5'), ['12.5']);
});
test('figuresInProse exempt: counts the report makes about itself', () => {
  assert.deepStrictEqual(pf('We read 12 sources, 5 papers, 8 claims, 4 readers, 2 rounds, 1 source.'), []);
  assert.deepStrictEqual(pf('12 sources of 40% error'), ['40%']);
});
test('figuresInProse exempt: numbers glued to letters (model names and versions)', () => {
  assert.deepStrictEqual(pf('GPT-4.1 beat Llama-3.1-8B and o4-mini, v2.'), []);
  // r2 fix 5: a word that starts with a digit is a figure (its numeric part is checked)
  assert.deepStrictEqual(pf('8B and 3x faster, 300k, 4.2B, 12.5pp'), ['8', '3', '300', '4.2', '12.5']);
  assert.deepStrictEqual(pf('Model-A1 scored 56.4% and Atlas-7 scored 12.5'), ['56.4%', '12.5']);
  assert.deepStrictEqual(pf('It gained 4.1 points, not v4.1 or 4.1x.'), ['4.1', '4.1']);
  const why = T.classifyProseNumbers('Llama-3.1-8B').map((x) => x.exempt);
  assert.deepStrictEqual(why, ['name or version', 'name or version']);
});

test('markProse: marks only unverified, counts', () => {
  const prose = 'Preferred 56.4% against 43.6%, with 1,450 items (Table 6) in 2024.';
  const r = T.markProse(prose, new Set(['56.4', '1450']));
  assert.strictEqual(r.marks, 1);
  assert.strictEqual(r.prose, 'Preferred 56.4% against 43.6% [unverified], with 1,450 items (Table 6) in 2024.');
  const again = T.markProse(r.prose, new Set(['56.4', '1450']));
  assert.strictEqual(again.marks, 0);
  assert.strictEqual(T.markProse('A 9.5 and 9.5 again', new Set()).marks, 2);
});

test('applyCheck: annotates claims and measured_result', () => {
  const claims = [
    { id: 'c1', claim: 'Preferred over the baseline', source_url: 'https://arxiv.org/abs/2401.01234', figures: ['56.4', '43.7'], measured_result: '56.4% against 43.7%' },
    { id: 'c2', claim: 'Raters', source_url: 'https://arxiv.org/abs/2401.01234', figures: ['1450', '0.550', '30'], measured_result: '1,450 items' },
    { id: 'c3', claim: 'Other', source_url: 'https://example.org/none', figures: ['9.9'], measured_result: '9.9 points' },
    { id: 'c4', claim: 'Plain statement', source_url: 'https://arxiv.org/abs/2401.01234', figures: [], measured_result: '' },
  ];
  const res = T.checkClaims(claims, FETCHED);
  const out = T.applyCheck(claims, res);
  assert.strictEqual(out[0].check, '1 of 2 found; not found: 43.7%'); // r4: the bare 43.7 takes the % the claim text shows
  assert.strictEqual(out[0].measured_result, '56.4% against 43.7% [unverified]');
  assert.strictEqual(out[1].check, '3 of 3 figures found');
  assert.strictEqual(out[2].check, 'source not opened');
  assert.strictEqual(out[2].measured_result, '9.9 points');
  assert.strictEqual(out[3].check, 'no figures');
  assert.strictEqual(claims[0].measured_result, '56.4% against 43.7%', 'input not mutated');
  assert.ok(T.verifiedFigures(res).has('56.4'));
  assert.ok(!T.verifiedFigures(res).has('43.7'));
});

// ---------------------------------------------------------------- selection
const FINDINGS = [
  '## Helper 1\nFindings about ranking.\nSOURCES READ:\n- Ranking paper https://arxiv.org/abs/2401.01234\n- Vendor docs https://docs.vendor.example/guide/\n\nOther notes see https://blog.example/post.',
  '## Helper 2\nMore.\nSOURCES READ:\n- https://arxiv.org/abs/2401.01234 (again)\n- https://data.example/set.csv',
  '## Helper 3\nSOURCES READ:\n- https://arxiv.org/abs/2401.01234#sec3\n- https://docs.vendor.example/guide',
].join('\n\n');

test('extractSources: SOURCES READ first, ranked by helper count then appearance, capped', () => {
  const s = T.extractSources(FINDINGS, 10);
  assert.deepStrictEqual(s.map((x) => x.url), ['https://arxiv.org/abs/2401.01234', 'https://docs.vendor.example/guide/', 'https://data.example/set.csv', 'https://blog.example/post']);
  assert.strictEqual(T.extractSources(FINDINGS, 2).length, 2);
  assert.strictEqual(s[0].title, 'Ranking paper');
});

test('parseSelection: good json, invented URL dropped, dedupe, cap', () => {
  const reply = 'Here:\n```json\n[{"url":"https://arxiv.org/abs/2401.01234","title":"Ranking paper","why":"main"},{"url":"https://invented.example/x","title":"Fake","why":"x"},{"url":"HTTPS://ARXIV.ORG/abs/2401.01234/","title":"dupe"},{"url":"https://docs.vendor.example/guide","title":"Docs"},{"url":"https://data.example/set.csv","title":"Data"}]\n```';
  const s = T.parseSelection(reply, FINDINGS, 10);
  assert.deepStrictEqual(s.map((x) => x.title), ['Ranking paper', 'Docs', 'Data']);
  assert.ok(!s.some((x) => /invented/.test(x.url)));
  assert.strictEqual(T.parseSelection(reply, FINDINGS, 2).length, 2);
});

test('parseSelection: fallback to extractSources on bad json or nothing valid', () => {
  const expect = T.extractSources(FINDINGS, 3).map((x) => x.url);
  assert.deepStrictEqual(T.parseSelection('no json at all', FINDINGS, 3).map((x) => x.url), expect);
  assert.deepStrictEqual(T.parseSelection('```json\n[not json\n```', FINDINGS, 3).map((x) => x.url), expect);
  assert.deepStrictEqual(T.parseSelection('```json\n[{"url":"https://invented.example/a"},{"url":"ftp://x/y"}]\n```', FINDINGS, 3).map((x) => x.url), expect);
});

test('selectionBrief / readerBrief / groupForReaders', () => {
  const b = T.selectionBrief('Which method wins?', FINDINGS, 5);
  assert.match(b, /at most 5/);
  assert.match(b, /Which method wins\?/);
  assert.match(b, /```json/);
  const srcs = [{ url: 'https://a.example/1', title: 'A' }, { url: 'https://b.example/2', title: 'B' }, { url: 'https://c.example/3', title: 'C' }];
  assert.deepStrictEqual(T.groupForReaders(srcs).map((g) => g.length), [2, 1]);
  assert.deepStrictEqual(T.groupForReaders(srcs, 1).length, 3);
  const rb = T.readerBrief('Which method wins?', srcs.slice(0, 2));
  for (const h of ['## <title> (<url>)', 'Full text opened: yes/no', '### Method', '### Results (location, who judged, sample size)', '### What mattered most', '### Limits', '### Could not read', 'arxiv.org/html', 'offset', 'Never invent or round']) assert.ok(rb.includes(h), h);
  assert.match(rb, /https:\/\/b\.example\/2/);
  assert.doesNotMatch(rb, /story/i);
});

// ---------------------------------------------------------------- claims parse
test('parseClaims: good block, prose without block', () => {
  const text = '## Verdict\nA wins.\n\n```claims\n[{"id":"c1","claim":" A is preferred ","source_url":"https://a.example/1","figures":["56.4","43.6"],"measured_result":"56.4% vs 43.6%","judged_by":"humans","evidence_strength":"strong","inference":false}]\n```\n';
  const r = T.parseClaims(text);
  assert.strictEqual(r.error, '');
  assert.strictEqual(r.claims.length, 1);
  assert.strictEqual(r.claims[0].claim, 'A is preferred');
  assert.deepStrictEqual(r.claims[0].figures, ['56.4', '43.6']);
  assert.strictEqual(r.prose, '## Verdict\nA wins.');
  assert.ok(!r.prose.includes('```'));
});
test('parseClaims: missing block and bad JSON keep the prose', () => {
  const a = T.parseClaims('## Verdict\nNo block here.');
  assert.ok(a.error);
  assert.strictEqual(a.prose, '## Verdict\nNo block here.');
  assert.deepStrictEqual(a.claims, []);
  const b = T.parseClaims('## Verdict\nX\n```claims\n[{"id": oops}\n```');
  assert.ok(/not valid JSON/.test(b.error));
  assert.strictEqual(b.prose, '## Verdict\nX');
  const c = T.parseClaims('X\n```claims\n{"a":1}\n```');
  assert.ok(/array/.test(c.error));
});
test('parseClaims: bad fields mapped, duplicate and missing ids, junk dropped', () => {
  const block = JSON.stringify([
    { id: 'c1', claim: 'one', source_url: 'u', figures: [5, ' 6.5 ', null, { x: 1 }], judged_by: 'Humans', evidence_strength: 'STRONG', inference: 'true' },
    { id: 'c1', claim: 'two', judged_by: 'robots', evidence_strength: 'huge', figures: 'nope' },
    { claim: 'three' },
    { id: 'c9' },
    'junk',
  ]);
  const r = T.parseClaims('p\n```claims\n' + block + '\n```');
  assert.strictEqual(r.claims.length, 3);
  assert.deepStrictEqual(r.claims[0].figures, ['5', '6.5']);
  assert.strictEqual(r.claims[0].judged_by, 'humans');
  assert.strictEqual(r.claims[0].evidence_strength, 'strong');
  assert.strictEqual(r.claims[0].inference, true);
  assert.strictEqual(r.claims[1].judged_by, 'not stated');
  assert.strictEqual(r.claims[1].evidence_strength, 'weak');
  assert.deepStrictEqual(r.claims[1].figures, []);
  assert.strictEqual(new Set(r.claims.map((c) => c.id)).size, 3);
  assert.ok(r.warnings.length >= 2);
});

test('synthesisBrief names the sections, the claims format and what was opened', () => {
  const b = T.synthesisBrief('Q?', 'quick text', ['notes one'], [{ url: 'https://a.example/1', title: 'A', ok: true }, { url: 'https://b.example/2', ok: false, error: 'blocked' }]);
  for (const h of ['## Verdict', '## Evidence', '## Where sources disagree', '## Confidence', '## Corrections to the first pass', '```claims', 'judged_by', 'evidence_strength', 'inference']) assert.ok(b.includes(h), h);
  assert.match(b, /Sources opened in full:\n- A - https:\/\/a\.example\/1/);
  assert.match(b, /NOT opened[\s\S]*https:\/\/b\.example\/2 \(blocked\)/);
  assert.match(b, /notes one/);
});

// ---------------------------------------------------------------- challenge
test('challengeExcerpts: figure windows, keyword window, source not opened', () => {
  const claims = [
    { id: 'c1', claim: 'Preferred over the baseline', source_url: 'https://arxiv.org/abs/2401.01234', figures: ['56.4', '0.550', '1450', '30'] },
    { id: 'c2', claim: 'The retrieval study shows a hard split result', source_url: 'https://arxiv.org/abs/2401.01234', figures: [] },
    { id: 'c3', claim: 'Missing', source_url: 'https://example.org/none', figures: ['1'] },
    { id: 'c4', claim: 'Zebra quagga okapi', source_url: 'https://arxiv.org/abs/2401.01234', figures: ['999'] },
  ];
  const pad = ' filler words go here.'.repeat(60);
  const spread = SOURCE.split('\n').join('\n' + pad + '\n');
  const ex = T.challengeExcerpts(claims, [{ ...FETCHED[0], text: spread }]);
  assert.strictEqual(ex[0].excerpts.length, 3);
  assert.ok(ex[0].excerpts.every((e) => e.length <= 600));
  assert.ok(ex[0].excerpts.some((e) => e.includes('56.4%')));
  assert.ok(ex[1].excerpts[0].includes('retrieval study'));
  assert.deepStrictEqual(ex[2].excerpts, ['source not opened']);
  assert.match(ex[3].excerpts[0], /no matching passage/);
});

test('challengeBrief: lists claims, excerpts, verdict set, json only', () => {
  const claims = [{ id: 'c1', claim: 'A is preferred', source_url: 'https://a.example/1', figures: ['56.4'], measured_result: '56.4%', judged_by: 'humans' }];
  const b = T.challengeBrief('Q?', claims, [{ id: 'c1', excerpts: ['preferred 56.4% against 43.6%'] }]);
  for (const x of ['supported', 'partly', 'not_supported', 'cannot_check', 'ONLY a fenced json array', 'Claim c1: A is preferred', 'preferred 56.4% against 43.6%', 'WebFetch']) assert.ok(b.includes(x), x);
});

test('parseChallenge: unknown ids dropped, missing ids cannot_check, counts', () => {
  const text = '```json\n[{"id":"c1","verdict":"supported","reason":"ok"},{"id":"c2","verdict":"Not-Supported","reason":"no"},{"id":"zz","verdict":"supported","reason":"?"},{"id":"c3","verdict":"maybe"}]\n```';
  const r = T.parseChallenge(text, ['c1', 'c2', 'c3', 'c4']);
  assert.deepStrictEqual(r.results.map((x) => [x.id, x.verdict]), [['c1', 'supported'], ['c2', 'not_supported'], ['c3', 'cannot_check'], ['c4', 'cannot_check']]);
  assert.deepStrictEqual(r.unknown, ['zz']);
  assert.deepStrictEqual(r.missing, ['c4']);
  assert.deepStrictEqual(r.counts, { supported: 1, partly: 0, not_supported: 1, cannot_check: 2 });
  const bad = T.parseChallenge('no json', ['c1']);
  assert.ok(bad.error);
  assert.strictEqual(bad.results[0].verdict, 'cannot_check');
});

test('reviseBrief: carries the review, the prose and the claims block', () => {
  const claims = [{ id: 'c1', claim: 'A', source_url: 'u', figures: ['1.5'], check: '1 of 1 figure found' }];
  const b = T.reviseBrief('Q?', '## Verdict\nA.', claims, { results: [{ id: 'c1', verdict: 'not_supported', reason: 'the source says otherwise' }] });
  assert.match(b, /c1 \[not_supported\] A \| reviewer: the source says otherwise/);
  assert.match(b, /## Verdict\nA\./);
  assert.match(b, /```claims/);
  assert.match(b, /Corrections to the first pass/);
  assert.doesNotMatch(b, /check_status|1 of 1 figure found/);
});

// ---------------------------------------------------------------- document
const DOC_CLAIMS = [
  { id: 'c1', claim: 'A is preferred <script>alert(1)</script> | pipe', source_url: 'https://arxiv.org/abs/2401.01234', figures: ['56.4'], measured_result: '56.4% against 43.6%', judged_by: 'humans', evidence_strength: 'strong', inference: false, check: '1 of 1 figure found' },
  { id: 'c2', claim: 'Our reading', source_url: 'https://example.org/none', figures: [], measured_result: '', judged_by: 'not stated', evidence_strength: 'weak', inference: true, check: 'source not opened' },
];
const DOC_FETCHED = [FETCHED[0], { url: 'https://example.org/none', title: 'Closed page', ok: false, text: '', error: 'blocked' }];
const DOC_PROSE = '# Heading to drop\n## Verdict\nA is preferred (**56.4%**) per *the study* and `code` <img src=x onerror=alert(1)>.\n\n## Evidence\n- [Ranking paper](https://arxiv.org/abs/2401.01234), 2024\n- Second https://example.org/page.\n\n1. one\n2. two\n\n## Corrections to the first pass\nNone';

test('renderDocument: markdown shape and traceability table', () => {
  const { markdown } = T.renderDocument({ question: 'Which ranking method do people prefer?', preparedDate: '2026-11-21', prose: DOC_PROSE, claims: DOC_CLAIMS, sources: DOC_FETCHED });
  assert.match(markdown, /^# Which ranking method do people prefer\n\nPrepared 2026-11-21\n/);
  assert.match(markdown, /## Traceability/);
  assert.match(markdown, /\| Claim \| Source \| Measured result \| Who judged \| Evidence strength \| Our inference \| Figures checked \|/);
  assert.match(markdown, /\| yes \| source not opened \|/);
  assert.match(markdown, /pipe/);
  assert.match(markdown, /### Read in full\n\n- \[Ranking paper\]\(https:\/\/arxiv\.org\/abs\/2401\.01234v2\)/);
  assert.match(markdown, /### Opened in part\n\nNone\n\n### Not opened\n\n- \[Closed page\]\(https:\/\/example\.org\/none\)/);
  assert.ok(!/Heading to drop/.test(markdown));
  assert.strictEqual((markdown.match(/^# /gm) || []).length, 1);
});

test('renderDocument: no process words', () => {
  const { markdown, html } = T.renderDocument({ question: 'Which ranking method do people prefer?', preparedDate: '2026-11-21', prose: DOC_PROSE, claims: DOC_CLAIMS, sources: DOC_FETCHED });
  const visible = html.replace(/<style>[\s\S]*?<\/style>/, '');
  for (const w of ['model', 'worker', 'prompt', 'hub', 'forge', 'agent']) {
    assert.ok(!new RegExp('\\b' + w, 'i').test(markdown), 'markdown has ' + w);
    assert.ok(!new RegExp('\\b' + w, 'i').test(visible), 'html has ' + w);
  }
});

test('renderDocument: html escapes input, renders links, tables, lists', () => {
  const { html } = T.renderDocument({ question: 'Q <b>bold</b>?', preparedDate: '2026-11-21', prose: DOC_PROSE, claims: DOC_CLAIMS, sources: DOC_FETCHED });
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('<img'));
  assert.ok(!/<b>bold/.test(html));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<a href="https:\/\/arxiv\.org\/abs\/2401\.01234">Ranking paper<\/a>/);
  assert.match(html, /<a href="https:\/\/example\.org\/page">https:\/\/example\.org\/page<\/a>\./);
  assert.match(html, /<table>[\s\S]*<th>Claim<\/th>/);
  assert.match(html, /<strong>56\.4%<\/strong>/);
  assert.match(html, /<em>the study<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<ol><li>one<\/li><li>two<\/li><\/ol>/);
  assert.match(html, /<ul><li>/);
  assert.match(html, /<style>[\s\S]*@media print/);
  assert.match(html, /border:1px solid/);
  assert.ok(!/<script|<link|<img|<iframe/i.test(html));
});

test('mdToHtml: unsafe link schemes are not turned into links', () => {
  const h = T.mdToHtml('[click](javascript:alert(1)) and [ok](https://e.example/a?b=1&c="2")');
  assert.ok(!h.includes('href="javascript'));
  assert.match(h, /href="https:\/\/e\.example\/a\?b=1&amp;c=&quot;2&quot;"/);
  assert.ok(!/<a [^>]*"[^>]*"[^>]*"[^>]*"/.test(h.replace(/href="[^"]*"/, '')));
});

test('renderDocument: corrections argument added when prose has no section', () => {
  const { markdown } = T.renderDocument({ question: 'Q', preparedDate: 'd', prose: '## Verdict\nX.', claims: [], sources: [], corrections: ['Fixed a figure'] });
  assert.match(markdown, /## Corrections to the first pass\n\n- Fixed a figure/);
  assert.match(markdown, /No claims recorded/);
});

// ---------------------------------------------------------------- PDF
test('findPdfRenderer: linux via which, then playwright newest', () => {
  const which = (n) => ({ chromium: '/usr/bin/chromium' })[n] || null;
  assert.strictEqual(T.findPdfRenderer({ platform: 'linux', which, exists: () => false, home: '/h', readdir: () => [] }), '/usr/bin/chromium');
  const order = [];
  T.findPdfRenderer({ platform: 'linux', which: (n) => { order.push(n); return null; }, exists: () => false, home: '/h', readdir: () => [] });
  assert.deepStrictEqual(order, ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']);
  const tree = { '/h/.cache/ms-playwright': ['chromium-1100', 'chromium-1200', 'chromium_headless_shell-1200', 'ffmpeg-1'], '/h/.cache/ms-playwright/chromium-1200': ['chrome-linux64'], '/h/.cache/ms-playwright/chromium-1100': ['chrome-linux'] };
  const present = new Set(['/h/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome', '/h/.cache/ms-playwright/chromium-1100/chrome-linux/chrome']);
  const readdir = (d) => tree[d] || [];
  assert.strictEqual(T.findPdfRenderer({ platform: 'linux', which: () => null, exists: (p) => present.has(p), home: '/h', readdir }), '/h/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome');
  present.delete('/h/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome');
  assert.strictEqual(T.findPdfRenderer({ platform: 'linux', which: () => null, exists: (p) => present.has(p), home: '/h', readdir }), '/h/.cache/ms-playwright/chromium-1100/chrome-linux/chrome');
  assert.strictEqual(T.findPdfRenderer({ platform: 'linux', which: () => null, exists: () => false, home: '/h', readdir }), null);
});

test('findPdfRenderer: darwin app paths then playwright; other platforms null', () => {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  assert.strictEqual(T.findPdfRenderer({ platform: 'darwin', exists: (p) => p === chrome, home: '/Users/x', readdir: () => [] }), chrome);
  const chromium = '/Applications/Chromium.app/Contents/MacOS/Chromium';
  assert.strictEqual(T.findPdfRenderer({ platform: 'darwin', exists: (p) => p === chromium, home: '/Users/x', readdir: () => [] }), chromium);
  const root = '/Users/x/Library/Caches/ms-playwright';
  const pw = root + '/chromium-1200/chrome-mac/Chromium.app/Contents/MacOS/Chromium';
  const readdir = (d) => (d === root ? ['chromium-1200'] : d === root + '/chromium-1200' ? ['chrome-mac'] : []);
  assert.strictEqual(T.findPdfRenderer({ platform: 'darwin', exists: (p) => p === pw, home: '/Users/x', readdir }), pw);
  assert.strictEqual(T.findPdfRenderer({ platform: 'darwin', exists: () => false, home: '/Users/x', readdir: () => [] }), null);
  assert.strictEqual(T.findPdfRenderer({ platform: 'win32', exists: () => true, which: () => '/x', home: '/h' }), null);
});

test('pdfArgs: exact flags, no sandbox switch', () => {
  assert.deepStrictEqual(T.pdfArgs('/tmp/a.html', '/tmp/a.pdf'), ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--print-to-pdf=/tmp/a.pdf', 'file:///tmp/a.html']);
});

test('renderPdf: success, failure, tiny file, no binary', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-pdf-'));
  try {
    const pdf = path.join(dir, 'a.pdf');
    let seen;
    const ok = await T.renderPdf({ binary: '/bin/chrome', htmlPath: '/x/a.html', pdfPath: pdf, execFile: (bin, args, opts, cb) => { seen = { bin, args, opts }; fs.writeFileSync(pdf, Buffer.alloc(5000, 1)); cb(null, '', ''); } });
    assert.deepStrictEqual(ok, { ok: true, error: '' });
    assert.strictEqual(seen.bin, '/bin/chrome');
    assert.strictEqual(seen.opts.timeout, 120000);
    assert.ok(seen.args.includes('--print-to-pdf=' + pdf));
    fs.rmSync(pdf);
    const bad = await T.renderPdf({ binary: '/bin/chrome', htmlPath: '/x/a.html', pdfPath: pdf, execFile: (b, a, o, cb) => cb(new Error('boom\nmore')) });
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /boom/);
    const thrown = await T.renderPdf({ binary: '/bin/chrome', htmlPath: '/x/a.html', pdfPath: pdf, execFile: () => { throw new Error('spawn'); } });
    assert.strictEqual(thrown.ok, false);
    const tiny = await T.renderPdf({ binary: '/bin/chrome', htmlPath: '/x/a.html', pdfPath: pdf, execFile: (b, a, o, cb) => { fs.writeFileSync(pdf, 'tiny'); cb(null); } });
    assert.strictEqual(tiny.ok, false);
    assert.match(tiny.error, /too small/);
    fs.rmSync(pdf);
    const none = await T.renderPdf({ binary: '/bin/chrome', htmlPath: '/x/a.html', pdfPath: pdf, execFile: (b, a, o, cb) => cb(null) });
    assert.strictEqual(none.ok, false);
    assert.match(none.error, /not created/);
    const promised = await T.renderPdf({ binary: '/bin/chrome', htmlPath: '/x/a.html', pdfPath: pdf, execFile: async () => { fs.writeFileSync(pdf, Buffer.alloc(3000, 1)); } });
    assert.strictEqual(promised.ok, true);
    assert.strictEqual((await T.renderPdf({ binary: null, htmlPath: 'a', pdfPath: 'b' })).ok, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fileBase: date, ascii slug up to 6 words', () => {
  assert.strictEqual(T.fileBase('Which ranking method do people prefer in practice today?', '2026-11-21'), 'deep-research-2026-11-21-which-ranking-method-do-people-prefer');
  assert.strictEqual(T.fileBase('Café & résumé: 100% über!!', new Date(2026, 10, 3)), 'deep-research-2026-11-03-cafe-resume-100-uber');
  assert.strictEqual(T.fileBase('???', '2026-11-21'), 'deep-research-2026-11-21-report');
});

// ---------------------------------------------------------------- fetchSourceTexts
test('fetchSourceTexts: pages through truncated results', async () => {
  const calls = [];
  const pages = ['aaa', 'bbb', 'ccc'];
  const fetchPage = async (url, { maxLength, offset }) => {
    calls.push({ url, offset, maxLength });
    const i = offset / 3;
    return { markdown: pages[i], truncated: i < 2, length: 9, offset, via: 'fetch', title: 'T', finalUrl: url + '/final' };
  };
  const [r] = await T.fetchSourceTexts([{ url: 'https://a.example/1', title: 'Given' }], { fetchPage });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, 'aaabbbccc');
  assert.strictEqual(r.chars, 9);
  assert.strictEqual(r.via, 'fetch');
  assert.strictEqual(r.title, 'Given');
  assert.strictEqual(r.finalUrl, 'https://a.example/1/final');
  assert.deepStrictEqual(calls.map((c) => c.offset), [0, 3, 6]);
});

test('fetchSourceTexts: throw and empty pages are ok:false with the error', async () => {
  const fetchPage = async (url) => {
    if (url.endsWith('/throw')) throw new Error('HTTP 403');
    if (url.endsWith('/empty')) return { markdown: '(no readable content extracted; the page may need JavaScript)', truncated: false, via: 'fetch' };
    if (url.endsWith('/blank')) return { markdown: '   ', truncated: false };
    if (url.endsWith('/pdf')) return { markdown: '(no text in this PDF; it may be scanned)', truncated: false, via: 'pdf' };
    return { markdown: 'good text', truncated: false, via: 'fetch', title: 'Good' };
  };
  const r = await T.fetchSourceTexts(['throw', 'empty', 'blank', 'pdf', 'good'].map((x) => ({ url: 'https://a.example/' + x })), { fetchPage });
  assert.deepStrictEqual(r.map((x) => x.ok), [false, false, false, false, true]);
  assert.strictEqual(r[0].error, 'HTTP 403');
  assert.match(r[1].error, /no readable content/);
  assert.ok(r[2].error);
  assert.match(r[3].error, /no text in this PDF/);
  assert.strictEqual(r[4].title, 'Good');
});

test('fetchSourceTexts: maxChars cap', async () => {
  const fetchPage = async (url, { maxLength, offset }) => ({ markdown: 'x'.repeat(maxLength), truncated: true, length: 1e9, offset });
  const [r] = await T.fetchSourceTexts([{ url: 'https://a.example/1' }], { fetchPage, maxChars: 450000 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.chars, 450000);
  assert.strictEqual(r.truncated, true);
});

test('fetchSourceTexts: at most 4 at a time, order kept, abort stops new fetches', async () => {
  let active = 0, peak = 0;
  const started = [];
  const ctl = new AbortController();
  const fetchPage = async (url) => {
    started.push(url);
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
    if (started.length >= 5) ctl.abort();
    return { markdown: 'text for ' + url, truncated: false };
  };
  const srcs = Array.from({ length: 12 }, (_, i) => ({ url: 'https://a.example/' + i }));
  const r = await T.fetchSourceTexts(srcs, { fetchPage, signal: ctl.signal });
  assert.strictEqual(r.length, 12);
  assert.ok(peak <= 4);
  assert.ok(started.length < 12, 'started ' + started.length);
  assert.deepStrictEqual(r.map((x) => x.url), srcs.map((s) => s.url));
  assert.ok(r.some((x) => x.ok));
  assert.ok(r.filter((x) => !x.ok).every((x) => x.error === 'aborted'));
  const pre = new AbortController(); pre.abort();
  const r2 = await T.fetchSourceTexts(srcs.slice(0, 2), { fetchPage: async () => { throw new Error('should not run'); }, signal: pre.signal });
  assert.deepStrictEqual(r2.map((x) => x.error), ['aborted', 'aborted']);
});

// ---------------------------------------------------------------- chat report + progress
test('chatReport: counts line, reviewer, files, missing', () => {
  const prose = '## Verdict\nA is preferred.\n\n## Evidence\n- x\n\n## Corrections to the first pass\n- The first pass said 55.4%; the paper says 56.4%.\n- v1 and v2 differ.\n\n## Confidence\nMedium: one study.';
  const claims = [
    { id: 'c1', claim: 'Unverified one', source_url: 'https://a.example/1', check_status: 'unverified' },
    { id: 'c2', claim: 'Verified one', source_url: 'https://a.example/2', check_status: 'verified' },
    { id: 'c3', claim: 'Inference', source_url: 'https://a.example/3', check_status: 'no_figures', inference: true },
  ];
  const t = T.chatReport({ question: 'Q', prose, claims, totals: { claims: 3, figures: 10, found: 7, notFound: 2, notOpened: 1 }, reviewer: 'GPT-5', rounds: 2, files: { md: '/f/r.md', pdf: '/f/r.pdf' }, missing: ['reader notes for 2 sources'], level: 'thorough' });
  assert.match(t, /Figures checked: 7 of 10 found in the sources; 2 not found \(marked unverified\); 1 from sources that could not be opened\./);
  assert.match(t, /Challenged by: GPT-5 \(2 rounds\)/);
  assert.match(t, /Full document: \/f\/r\.md/);
  assert.match(t, /PDF: \/f\/r\.pdf/);
  assert.match(t, /Missing: reader notes for 2 sources/);
  assert.match(t, /Verdict\nA is preferred\./);
  assert.match(t, /- The first pass said 55\.4%/);
  assert.match(t, /Confidence\nMedium: one study\./);
  // r2 fix 10: Key evidence lists only verified claims
  assert.ok(t.includes('Verified one'));
  assert.ok(!t.includes('Unverified one'));
  assert.ok(!/\p{Extended_Pictographic}/u.test(t));
});

test('chatReport: no missing line, no PDF reason, None corrections, 1 round', () => {
  const t = T.chatReport({ prose: '## Verdict\nV.\n\n## Corrections to the first pass\nNone\n', claims: [], totals: { figures: 0, found: 0, notFound: 0, notOpened: 0 }, reviewer: 'Reviewer X', rounds: 1, files: { md: '/f/r.md', pdfError: 'no Chrome found' } });
  assert.doesNotMatch(t, /Missing:/);
  assert.match(t, /No PDF: no Chrome found/);
  assert.match(t, /Corrections to the first pass\nNone/);
  assert.match(t, /\(1 round\)/);
  const caps = T.chatReport({ prose: '## Verdict\nV.', claims: Array.from({ length: 9 }, (_, i) => ({ id: 'c' + i, claim: 'claim ' + i, check_status: 'verified' })), totals: {}, files: {} });
  assert.strictEqual((caps.match(/^- claim /gm) || []).length, 5);
});

test('progressLabel', () => {
  assert.strictEqual(T.progressLabel('quick'), 'quick pass');
  assert.strictEqual(T.progressLabel('select'), 'choosing sources');
  assert.strictEqual(T.progressLabel('read', 3, 12), 'reading sources in full (3 of 12)');
  assert.strictEqual(T.progressLabel('check'), 'checking figures');
  assert.strictEqual(T.progressLabel('synthesis'), 'writing the report');
  assert.strictEqual(T.progressLabel('challenge', 1, 2), 'checking the report (round 1 of 2)');
  assert.strictEqual(T.progressLabel('document'), 'writing the document');
  assert.strictEqual(T.progressLabel('read'), 'reading sources in full');
});

test('end to end: parseClaims -> checkClaims -> applyCheck -> markProse', () => {
  const reply = '## Verdict\nPreferred 56.4% against 43.7% (Table 6), 1,450 items, 2024.\n\n```claims\n[{"id":"c1","claim":"Preferred over the baseline","source_url":"https://arxiv.org/abs/2401.01234","figures":["56.4","43.7","1450"],"measured_result":"56.4% vs 43.7%","judged_by":"humans","evidence_strength":"strong","inference":false}]\n```';
  const p = T.parseClaims(reply);
  const res = T.checkClaims(p.claims, FETCHED);
  assert.strictEqual(res.claims[0].status, 'partly');
  const marked = T.markProse(p.prose, T.verifiedFigures(res));
  assert.strictEqual(marked.marks, 1);
  assert.match(marked.prose, /43\.7% \[unverified\]/);
  assert.doesNotMatch(marked.prose, /56\.4% \[unverified\]/);
  const ann = T.applyCheck(p.claims, res);
  assert.strictEqual(ann[0].check, '2 of 3 found; not found: 43.7%');
});

// ================================================================ r2 review fixes
const SRC_A = 'Study A enrolled 125 participants and reported 56.4 percent agreement. Study A also used 2000 samples in 2048-token windows.';
const SRC_B = 'Study B enrolled 80 participants and reported 0.884 precision.';
const F2 = [
  { url: 'https://a.example/a', title: 'Study A paper', ok: true, text: SRC_A },
  { url: 'https://b.example/b', title: 'Study B paper', ok: true, text: SRC_B },
];

test('r2-1 figure units: 125% is not "125 participants"; 56.4 matches 56.4%', () => {
  assert.strictEqual(T.checkFigure('125%', 'We enrolled 125 participants.', ['participants']), 'not_found');
  assert.strictEqual(T.checkFigure('125', 'We enrolled 125 participants.', ['participants']), 'found');
  // r4: a bare 56.4 no longer matches 56.4% (it used to); exact units both ways
  assert.strictEqual(T.checkFigure('56.4', 'agreement 56.4% overall', []), 'not_found');
  assert.strictEqual(T.checkFigure('56.4%', 'agreement 56.4% overall', []), 'found');
  assert.strictEqual(T.checkFigure('56.4', '| Method | 56.4 |', []), 'found');
  assert.strictEqual(T.checkFigure('56.4%', 'agreement 56.4 % overall', []), 'found');
  assert.strictEqual(T.checkFigure('56.4%', 'agreement 56.4 percent overall', []), 'found');
  assert.strictEqual(T.checkFigure('56.4 percent', 'agreement 56.4 per cent overall', []), 'found');
  assert.strictEqual(T.checkFigure('56.4%', 'agreement 56.4 points overall', []), 'not_found');
  assert.strictEqual(T.numbersIn('a 56.4 % b')[0].pct, true);
});

test('r2-2 arXiv versions: explicit version matches only that version', () => {
  const v1 = [{ url: 'https://arxiv.org/abs/2401.01234v1', ok: true, text: 'value 12.5 here', title: 'P' }];
  const mk = (u) => [{ id: 'c1', claim: 'Value', source_url: u, figures: ['12.5'] }];
  assert.strictEqual(T.checkClaims(mk('https://arxiv.org/abs/2401.01234v2'), v1).claims[0].status, 'source_not_opened');
  assert.strictEqual(T.checkClaims(mk('https://arxiv.org/pdf/2401.01234v1'), v1).claims[0].status, 'verified');
  assert.strictEqual(T.checkClaims(mk('https://arxiv.org/html/2401.01234v1'), v1).claims[0].status, 'verified');
  assert.strictEqual(T.checkClaims(mk('https://arxiv.org/abs/2401.01234'), v1).claims[0].status, 'verified');
});

test('r2-3 claim text figures are checked against the claim source', () => {
  const claims = [{ id: 'c1', claim: '125 participants achieved 83% accuracy', source_url: 'https://a.example/a', figures: ['125'], measured_result: '' }];
  const r = T.checkClaims(claims, F2);
  assert.strictEqual(r.claims[0].status, 'partly');
  assert.deepStrictEqual(r.claims[0].figures.map((f) => [f.figure, f.status]), [['125', 'found'], ['83%', 'not_found']]);
  assert.strictEqual(r.totals.figures, 2);
  const m = T.checkClaims([{ id: 'c1', claim: 'Agreement', source_url: 'https://a.example/a', figures: [], measured_result: '56.4% and 71.2%' }], F2);
  assert.strictEqual(m.claims[0].status, 'partly');
});

test('r2-4 prose figures need a claim named in their own block', () => {
  const claims = [{ id: 'c1', claim: 'Study A enrolled participants', source_url: 'https://a.example/a', figures: ['125'] }];
  const prose = '- Study A (https://a.example/a) enrolled 125 participants.\n- Study B (https://b.example/b) enrolled 125 participants.\n\nElsewhere 125 participants were mentioned with no source.';
  const r = T.checkReport({ prose, claims, fetched: F2, counts: {} });
  const lines = r.prose.split('\n');
  assert.ok(!/unverified/.test(lines[0]));
  assert.match(lines[1], /125 \[unverified\]/);
  assert.match(r.prose, /Elsewhere 125 \[unverified\] participants/);
  assert.strictEqual(r.marks, 2);
  assert.strictEqual(r.notChecked, false);
  assert.strictEqual(r.claims[0].check_status, 'verified');
  // the fetched title also names a claim's source
  const t = T.checkReport({ prose: 'The Study A paper found 125 participants.', claims, fetched: F2, counts: {} });
  assert.strictEqual(t.marks, 0);
  assert.deepStrictEqual(T.proseBlocks('a\nb\n\n- c\n- d\n1. e').map((b) => [b.start, b.end]), [[0, 3], [5, 8], [9, 12], [13, 17]]);
  assert.strictEqual(T.proseBlocks('a\nb\n\n- c\n- d\n1. e').length, 4);
});

test('r2-4 checkReport: no claims -> everything checkable is unverified, totals zero', () => {
  const prose = 'Preferred 56.4% of 1,450 items in 2024 (Table 6) with 12 sources.';
  for (const claims of [[], undefined]) {
    const r = T.checkReport({ prose, claims, fetched: F2, counts: { sourcesOpened: 12 } });
    assert.strictEqual(r.notChecked, true);
    assert.strictEqual(r.prose, 'Preferred 56.4% [unverified] of 1,450 [unverified] items in 2024 (Table 6) with 12 sources.');
    assert.deepStrictEqual(r.totals, { claims: 0, figures: 0, found: 0, notFound: 0, notOpened: 0, proseFigures: 2, proseVerified: 0, proseUnverified: 2 });
    assert.strictEqual(r.marks, 2);
  }
});

test('r2-5 years: only year-like places are exempt', () => {
  assert.deepStrictEqual(pf('2000 samples, 2048-token windows, 1024 items, 1850 units'), ['2000', '2048', '1024', '1850']);
  assert.deepStrictEqual(pf('in 2024, since 2019, from 2020 to 2021, by 2030, of 1999, (2018), June 2020, 2019–2020, ended 2023.'), []);
  assert.deepStrictEqual(pf('Seen (2018) and 2022; and 2021,'), []);
});

test('r2-5 names/versions vs digit-first words', () => {
  assert.deepStrictEqual(pf('GPT-4.1, Llama-3.1-8B, o4-mini and v2 and H100'), []);
  assert.deepStrictEqual(pf('300k, 4.2B, 3.2x, 12.5pp'), ['300', '4.2', '3.2', '12.5']);
  const c = T.checkClaims([{ id: 'c1', claim: 'Throughput of 300k tokens', source_url: 'https://x.example/', figures: [] }], [{ url: 'https://x.example/', ok: true, text: 'tokens 300 per s' }]);
  assert.strictEqual(c.claims[0].figures.length, 1);
});

test('r2-5 self counts are exempt only when they equal one of the counts', () => {
  const counts = { sourcesSelected: 12, sourcesOpened: 9, claims: 7, rounds: 2 };
  assert.deepStrictEqual(figuresWith('We read 9 sources and 7 claims over 2 rounds.', counts), []);
  assert.deepStrictEqual(figuresWith('We read 40 sources and 7 claims.', counts), ['40']);
  assert.deepStrictEqual(figuresWith('We read 9 sources.', {}), ['9']);
  function figuresWith(s, cn) { return T.figuresInProse(s, cn).map((t) => t.raw); }
});

test('r2-6 common numbers: integers < 1000 and short decimals need a keyword', () => {
  const text = 'Alpha gained 1.5 points and beta used 0.05 and 450 workers and 0.884 precision and 12.5 units and 1500 rows.';
  assert.strictEqual(T.checkFigure('1.5', text, []), 'common_not_near');
  assert.strictEqual(T.checkFigure('0.05', text, []), 'common_not_near');
  assert.strictEqual(T.checkFigure('450', text, []), 'common_not_near');
  assert.strictEqual(T.checkFigure('450', text, ['workers']), 'found');
  assert.strictEqual(T.checkFigure('0.884', text, []), 'found');
  assert.strictEqual(T.checkFigure('12.5', text, []), 'found');
  assert.strictEqual(T.checkFigure('1500', text, []), 'found');
  const k = T.keywordsFrom('accuracy results models performance scores dataset table figure humans study using which their these those between compared higher lower average percent zebra');
  assert.deepStrictEqual(k, ['zebra']);
});

test('r2-7 fetchSourceTexts arXiv: html first, then pdf, then the cited URL', async () => {
  const big = 'full text 12.5 '.repeat(3000);
  const calls = [];
  const fp = (map) => async (url) => { calls.push(url); const v = map[url]; if (v instanceof Error) throw v; return { markdown: v || '', truncated: false, via: 'fetch' }; };
  const [a] = await T.fetchSourceTexts([{ url: 'https://arxiv.org/abs/2401.01234v2' }], { fetchPage: fp({ 'https://arxiv.org/html/2401.01234v2': big, 'https://arxiv.org/abs/2401.01234v2': 'abstract only' }) });
  assert.deepStrictEqual(calls, ['https://arxiv.org/html/2401.01234v2']);
  assert.strictEqual(a.ok, true); assert.strictEqual(a.partial, false); assert.strictEqual(a.partialReason, null);
  assert.strictEqual(a.url, 'https://arxiv.org/abs/2401.01234v2');
  assert.strictEqual(a.finalUrl, 'https://arxiv.org/html/2401.01234v2');
  assert.strictEqual(a.chars, big.length);
  calls.length = 0;
  const [b] = await T.fetchSourceTexts([{ url: 'https://arxiv.org/abs/2401.01234' }], { fetchPage: fp({ 'https://arxiv.org/html/2401.01234': new Error('404'), 'https://arxiv.org/pdf/2401.01234': big }) });
  assert.deepStrictEqual(calls, ['https://arxiv.org/html/2401.01234', 'https://arxiv.org/pdf/2401.01234']);
  assert.strictEqual(b.finalUrl, 'https://arxiv.org/pdf/2401.01234');
  assert.strictEqual(b.partial, false);
  calls.length = 0;
  const [c] = await T.fetchSourceTexts([{ url: 'https://arxiv.org/pdf/2401.01234v1.pdf' }], { fetchPage: fp({ 'https://arxiv.org/html/2401.01234v1.pdf': '', 'https://arxiv.org/abs/x': '' }) });
  assert.strictEqual(c.ok, false);
  const [d] = await T.fetchSourceTexts([{ url: 'https://arxiv.org/abs/2401.01234' }], { fetchPage: fp({ 'https://arxiv.org/abs/2401.01234': 'Abstract. We study things.' }) });
  assert.strictEqual(d.ok, true);
  assert.strictEqual(d.partial, true);
  assert.strictEqual(d.partialReason, 'abstract page only');
  assert.strictEqual(d.url, 'https://arxiv.org/abs/2401.01234');
});

test('r2-7 fetchSourceTexts: cut at maxChars is partial', async () => {
  const fetchPage = async (u, { maxLength }) => ({ markdown: 'x'.repeat(maxLength), truncated: true });
  const [r] = await T.fetchSourceTexts([{ url: 'https://a.example/1' }], { fetchPage, maxChars: 5000 });
  assert.strictEqual(r.partial, true);
  assert.strictEqual(r.partialReason, 'cut at 5000 characters');
  const [ok] = await T.fetchSourceTexts([{ url: 'https://a.example/1' }], { fetchPage: async () => ({ markdown: 'short', truncated: false }) });
  assert.strictEqual(ok.partial, false);
  assert.strictEqual(ok.partialReason, null);
});

test('r2-8 renderDocument: Sources split and the partial note in the table', () => {
  const fetched = [
    { url: 'https://a.example/full', title: 'Full', ok: true, text: 'x' },
    { url: 'https://a.example/part', title: 'Part', ok: true, text: 'x', partial: true, partialReason: 'abstract page only' },
    { url: 'https://a.example/no', title: 'No', ok: false, text: '' },
  ];
  const claims = [{ id: 'c1', claim: 'X', source_url: 'https://a.example/part', figures: [], check: '1 of 1 figure found' }, { id: 'c2', claim: 'Y', source_url: 'https://a.example/full', figures: [], check: '1 of 1 figure found' }];
  const { markdown } = T.renderDocument({ question: 'Q', preparedDate: 'd', prose: '## Verdict\nX.', claims, sources: fetched });
  assert.match(markdown, /### Read in full\n\n- \[Full\]\(https:\/\/a\.example\/full\)\n\n### Opened in part\n\n- \[Part\]\(https:\/\/a\.example\/part\) \(abstract page only\)\n\n### Not opened\n\n- \[No\]/);
  assert.match(markdown, /1 of 1 figure found; source opened in part \|/);
  assert.strictEqual((markdown.match(/source opened in part/g) || []).length, 1);
});

test('r2-9 challengeSummary', () => {
  const parsed = T.parseChallenge('```json\n[{"id":"c1","verdict":"supported"},{"id":"c2","verdict":"partly"},{"id":"c3","verdict":"not_supported"},{"id":"c4","verdict":"cannot_check"}]\n```', ['c1', 'c2', 'c3', 'c4', 'c5']);
  const s = T.challengeSummary(parsed);
  assert.deepStrictEqual(s, { decisive: 3, counts: { supported: 1, partly: 1, not_supported: 1, cannot_check: 2 }, uncheckedIds: ['c4', 'c5'], doubtedIds: ['c2', 'c3'] });
  assert.deepStrictEqual(T.challengeSummary(T.parseChallenge('nothing', ['c1'])).decisive, 0);
});

test('r2-10 chatReport: not checked, review lines, doubted, interrupted', () => {
  const prose = '## Verdict\nV.\n\n## Confidence\nMedium.';
  const claims = [
    { id: 'c1', claim: 'Good one', source_url: 'https://a.example/1', check_status: 'verified' },
    { id: 'c2', claim: 'Doubted one', source_url: 'https://a.example/2', check_status: 'verified' },
    { id: 'c3', claim: 'Bad figures', source_url: 'https://a.example/3', check_status: 'unverified' },
  ];
  const t = T.chatReport({ prose, claims, totals: { figures: 3, found: 2, notFound: 1, notOpened: 0 }, doubtedIds: ['c2'], review: { label: 'GPT-5', rounds: 2, counts: { supported: 4, partly: 1, not_supported: 0, cannot_check: 2 }, uncheckedIds: ['c3', 'c7'], failed: false }, files: {} });
  assert.match(t, /Key evidence\n- Good one \[https:\/\/a\.example\/1\] \(figures verified\)\n\nDoubted by the review\n- Doubted one/);
  assert.ok(t.indexOf('Good one') < t.indexOf('Doubted by the review'));
  assert.ok(!/Key evidence[\s\S]*Doubted one[\s\S]*Doubted by the review/.test(t));
  assert.ok(!t.includes('Bad figures'));
  assert.match(t, /Challenged by: GPT-5 \(2 rounds\): 4 supported, 1 partly, 0 not supported, 2 could not be checked\nNot checked by the reviewer: c3, c7\./);
  const f = T.chatReport({ prose, claims, totals: {}, review: { label: 'GPT-5', rounds: 1, counts: { supported: 0, partly: 0, not_supported: 0, cannot_check: 3 }, uncheckedIds: ['c1'] }, files: {} });
  assert.match(f, /Not challenged: the reviewer gave no usable verdicts\./);
  assert.doesNotMatch(f, /Challenged by/);
  const g = T.chatReport({ prose, claims, totals: {}, review: { label: 'X', rounds: 1, counts: { supported: 2 }, failed: true }, files: {} });
  assert.match(g, /Not challenged: the reviewer gave no usable verdicts\./);
  const one = T.chatReport({ prose, claims, totals: {}, review: { label: 'X', rounds: 1, counts: { supported: 2 } }, files: {} });
  assert.match(one, /Challenged by: X \(1 round\): 2 supported, 0 partly, 0 not supported, 0 could not be checked/);
  assert.doesNotMatch(one, /Not checked by the reviewer/);
  const n = T.chatReport({ prose, claims: [], notChecked: true, files: {} });
  assert.match(n, /Figures not checked: the report had no list of claims to check them against; every figure in it is marked unverified\./);
  assert.doesNotMatch(n, /Figures checked:/);
  const i = T.chatReport({ prose, claims: [{ id: 'c1', claim: 'A' }], interrupted: true, files: {} });
  assert.match(i, /Figures not checked \(the run stopped before the check\)\./);
});

test('r2-11 pdfArgs: file URL and a fresh profile dir; renderPdf makes one', async () => {
  assert.deepStrictEqual(T.pdfArgs('/tmp/a b.html', '/tmp/a.pdf', '/tmp/prof'), ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--user-data-dir=/tmp/prof', '--print-to-pdf=/tmp/a.pdf', 'file:///tmp/a%20b.html']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-pdf2-'));
  try {
    const pdf = path.join(dir, 'a.pdf');
    let seen;
    const made = [];
    const r = await T.renderPdf({ binary: '/bin/chrome', htmlPath: '/x/a.html', pdfPath: pdf, mkdtemp: () => { made.push('/tmp/fresh-1'); return '/tmp/fresh-1'; }, execFile: (b, a, o, cb) => { seen = a; fs.writeFileSync(pdf, Buffer.alloc(5000, 1)); cb(null); } });
    assert.strictEqual(r.ok, true);
    assert.ok(seen.includes('--user-data-dir=/tmp/fresh-1'));
    assert.strictEqual(made.length, 1);
    const bad = await T.renderPdf({ binary: '/bin/chrome', htmlPath: '/x/a.html', pdfPath: pdf, mkdtemp: () => { throw new Error('disk full'); }, execFile: () => { throw new Error('should not run'); } });
    assert.strictEqual(bad.ok, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('r2-12 briefs: figure-with-URL rule; challengeBrief caps claims and excerpt characters', () => {
  const b = T.synthesisBrief('Q?', 'q', 'n', []);
  assert.ok(b.includes('Every paragraph or bullet that gives a figure names its source\'s URL in that same paragraph or bullet.'));
  const claims = Array.from({ length: 100 }, (_, i) => ({ id: 'c' + i, claim: 'Claim text ' + i, source_url: 'https://a.example/' + i, figures: [] }));
  const ex = claims.map((c) => ({ id: c.id, excerpts: ['e'.repeat(1500), 'f'.repeat(1500)] }));
  const br = T.challengeBrief('Q?', claims, ex);
  assert.strictEqual((br.match(/^Claim c\d+:/gm) || []).length, 60);
  assert.match(br, /40 further claims were left out/);
  const letters = (br.match(/[ef]/g) || []).length; // excerpts are the only e/f runs of that size
  const runs = br.match(/e{20,}|f{20,}/g) || [];
  assert.ok(runs.join('').length <= 60000, 'excerpt chars ' + runs.join('').length);
  assert.ok(runs.length > 0 && letters > 0);
  const small = T.challengeBrief('Q?', claims.slice(0, 3), ex.slice(0, 3));
  assert.doesNotMatch(small, /left out/);
  assert.ok((small.match(/e{20,}/g) || []).every((x) => x.length === 1500));
});

// ================================================================ r3-A: engine fixes (review round 2)
const R3A = { url: 'https://a.example/a', title: 'Study A paper', ok: true, text: 'Study A enrolled 1,250 participants.' };
const R3B = { url: 'https://b.example/b', title: 'Study B paper', ok: true, text: 'Study B enrolled 800 participants.' };

test('r3-1 scale: 300k is not a bare 300; magnitudes compare; thousand/million/billion', () => {
  assert.strictEqual(T.checkFigure('300k', 'Served 300 requests.', []), 'not_found');
  assert.strictEqual(T.checkFigure('300k', 'Served 300,000 requests.', []), 'found');
  assert.strictEqual(T.checkFigure('300k', 'Served 300 k requests.', []), 'found');
  assert.strictEqual(T.checkFigure('300k', 'Served 300 thousand requests.', []), 'found');
  assert.strictEqual(T.checkFigure('300', 'Served 300k requests.', []), 'not_found');
  assert.strictEqual(T.checkFigure('4.2B', 'Revenue 4,200,000,000 dollars.', []), 'found');
  assert.strictEqual(T.checkFigure('4.2B', 'Revenue 4.2 billion dollars.', []), 'found');
  assert.strictEqual(T.checkFigure('1.5M', 'About 1,500,000 users.', []), 'found');
  assert.strictEqual(T.checkFigure('1.5M', 'About 1.5 million users.', []), 'found');
  assert.strictEqual(T.checkFigure('1.2m', 'About 1.2 million users.', []), 'found');
  assert.strictEqual(T.checkFigure('3x', 'a 3 point gain', []), 'not_found');
  assert.strictEqual(T.checkFigure('3x', 'a 3x speed-up', ['speed']), 'found');
  assert.strictEqual(T.checkFigure('5pp', 'a 5 pp rise', ['rise']), 'found');
  assert.strictEqual(T.checkFigure('5pp', 'a 5% rise', []), 'not_found');
  // the reviewer's probe, through the whole check
  const r = T.checkReport({ prose: 'Throughput reached 300k requests (https://a.example/a).', claims: [{ id: 'c1', claim: 'Throughput reached 300k requests', source_url: 'https://a.example/a', figures: ['300k'] }], fetched: [{ url: 'https://a.example/a', title: 'T', ok: true, text: 'We saw 300 requests.' }] });
  assert.match(r.prose, /300k \[unverified\]/);
  assert.strictEqual(r.claims[0].check_status, 'unverified');
  assert.strictEqual(T.numbersIn('Got 300k and 4.2B and 1.5 M').map((t) => t.mag).join(','), '300000,4200000000,1500000');
});

test('r3-1 units: a figure is value + unit; a counted number needs a source number without %', () => {
  const claims = [{ id: 'c1', claim: 'Enrollment was 125 participants with 125% growth', source_url: 'https://a.example/a', figures: [] }];
  const fetched = [{ url: 'https://a.example/a', title: 'T', ok: true, text: 'Enrollment grew by 125% over the year.' }];
  const r = T.checkReport({ prose: 'x', claims, fetched });
  assert.strictEqual(r.totals.figures, 2);
  assert.strictEqual(r.totals.found, 1);
  assert.strictEqual(r.totals.notFound, 1);
  assert.strictEqual(r.claims[0].check, '1 of 2 found; not found: 125');
  const one = (claim, text) => T.checkClaims([{ id: 'c', claim, source_url: 'https://a.example/a', figures: ['56.4'] }], [{ url: 'https://a.example/a', ok: true, text }]).claims[0].status;
  assert.strictEqual(one('Share was 56.4%', 'agreement 56.4% overall'), 'verified');
  assert.strictEqual(one('It had 56.4 participants', 'agreement 56.4% overall'), 'unverified');
  assert.strictEqual(T.checkClaims([{ id: 'c', claim: 'Gain of 12.5 and 12.5 again', source_url: 'https://a.example/a', figures: ['12.5'] }], fetched).totals.figures, 1);
});

test('r3-2 sentence binding: a figure is tied to the claim cited in its own sentence', () => {
  const claims = [
    { id: 'c1', claim: 'Study A enrolled 1,250 participants', source_url: 'https://a.example/a', figures: ['1,250'] },
    { id: 'c2', claim: 'Study B enrolled participants', source_url: 'https://b.example/b', figures: ['800'] },
  ];
  const prose = 'Study A enrolled 1,250 participants (https://a.example/a). Study B enrolled 1,250 participants (https://b.example/b).';
  const r = T.checkReport({ prose, claims, fetched: [R3A, R3B] });
  assert.strictEqual(r.prose, 'Study A enrolled 1,250 participants (https://a.example/a). Study B enrolled 1,250 [unverified] participants (https://b.example/b).');
  assert.strictEqual(r.totals.proseFigures, 2);
  assert.strictEqual(r.totals.proseVerified, 1);
  assert.strictEqual(r.totals.proseUnverified, 1);
});

test('r3-2 sentence binding: an uncited sentence uses the block only when the block cites exactly one source', () => {
  const one = [{ id: 'c1', claim: 'Study A enrolled participants', source_url: 'https://a.example/a', figures: [] }];
  const r1 = T.checkReport({ prose: 'Study A is described at https://a.example/a. It enrolled 1,250 participants.', claims: one, fetched: [R3A, R3B] });
  assert.strictEqual(r1.marks, 0);
  assert.strictEqual(r1.totals.proseVerified, 1);
  const r1b = T.checkReport({ prose: 'Study A is described at https://a.example/a. It enrolled 1,300 participants.', claims: one, fetched: [R3A, R3B] });
  assert.strictEqual(r1b.marks, 1);
  const two = [...one, { id: 'c2', claim: 'Study B enrolled participants', source_url: 'https://b.example/b', figures: [] }];
  const r2 = T.checkReport({ prose: 'See https://a.example/a and https://b.example/b. It enrolled 1,250 participants.', claims: two, fetched: [R3A, R3B] });
  assert.strictEqual(r2.marks, 1);
  assert.strictEqual(r2.totals.proseUnverified, 1);
  const r3 = T.checkReport({ prose: 'A had 1,250 participants (https://a.example/a); B had 1,250 participants (https://b.example/b).', claims: two, fetched: [R3A, R3B] });
  assert.strictEqual(r3.totals.proseVerified, 1);
  assert.match(r3.prose, /B had 1,250 \[unverified\] participants/);
});

test('r3-3 chatReport: prose figures not tied to a source', () => {
  const totals = { claims: 3, figures: 10, found: 7, notFound: 2, notOpened: 1, proseFigures: 5, proseVerified: 2, proseUnverified: 3 };
  const t = T.chatReport({ prose: '## Verdict\nA.', claims: [], totals, files: {} });
  assert.match(t, /1 from sources that could not be opened, and 3 figures in the text not tied to a checked source \(marked unverified\)\./);
  const t1 = T.chatReport({ prose: '## Verdict\nA.', claims: [], totals: { ...totals, proseUnverified: 1 }, files: {} });
  assert.match(t1, /and 1 figure in the text not tied/);
  const t0 = T.chatReport({ prose: '## Verdict\nA.', claims: [], totals: { ...totals, proseUnverified: 0 }, files: {} });
  assert.ok(!/not tied/.test(t0));
  assert.match(t0, /could not be opened\./);
});

test('r3-4 claimKey: content fingerprint, not the id', () => {
  const base = { id: 'c1', claim: 'A is preferred', source_url: 'https://a.example/a', figures: ['56.4', '43.6'] };
  const k = T.claimKey(base);
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.strictEqual(T.claimKey({ ...base, id: 'c9' }), k);
  assert.strictEqual(T.claimKey({ ...base, claim: '  a is   PREFERRED ' }), k);
  assert.strictEqual(T.claimKey({ ...base, figures: ['43.6', '56.4'] }), k);
  assert.strictEqual(T.claimKey({ ...base, source_url: 'https://A.example/a/' }), k);
  assert.notStrictEqual(T.claimKey({ ...base, claim: 'B is preferred' }), k);
  assert.notStrictEqual(T.claimKey({ ...base, source_url: 'https://a.example/b' }), k);
  assert.notStrictEqual(T.claimKey({ ...base, figures: ['56.4', '43.7'] }), k);
  assert.notStrictEqual(T.claimKey({ ...base, figures: ['56.4'] }), k);
});

test('r3-5 chatReport: unreviewed claims, failed last round, interrupted before the check', () => {
  const claims = [
    { id: 'c1', claim: 'Kept one', source_url: 'https://a.example/1', check_status: 'verified' },
    { id: 'c4', claim: 'Edited one', source_url: 'https://a.example/4', check_status: 'verified' },
  ];
  const review = { label: 'GPT-5', rounds: 1, counts: { supported: 3, partly: 1, not_supported: 0, cannot_check: 0 }, lastRoundFailed: true };
  const t = T.chatReport({ prose: '## Verdict\nA.', claims, totals: { figures: 1, found: 1 }, review, unreviewedIds: ['c4', 'c6'], files: {} });
  assert.match(t, /Changed after the last review \(not reviewed\): c4, c6\./);
  assert.ok(t.includes('Kept one'));
  assert.ok(!t.includes('Edited one'));
  assert.match(t, /Challenged by: GPT-5 \(1 round\): 3 supported, 1 partly, 0 not supported, 0 could not be checked; the last round gave no usable verdicts/);
  const ok = T.chatReport({ prose: '## Verdict\nA.', claims, totals: {}, review: { ...review, lastRoundFailed: false }, files: {} });
  assert.ok(!/last round/.test(ok));
  assert.ok(!/Changed after/.test(ok));
  const i = T.chatReport({ prose: '## Verdict\nA.', claims, totals: { figures: 1, found: 1 }, interruptedBeforeCheck: true, files: {} });
  assert.match(i, /Figures not checked \(the run stopped before the check\); every figure is marked unverified\./);
  assert.ok(!/Figures checked:/.test(i));
});

test('r3-6 fetchOne: for an abs URL the longest of html, pdf and abs wins; abstract-only only when abs is longest', async () => {
  const abs3 = 'a'.repeat(3000);
  const fp = async (u) => ({ markdown: u.includes('/html/') ? 'h'.repeat(15000) : u.includes('/pdf/') ? '' : abs3, truncated: false });
  const [a] = await T.fetchSourceTexts([{ url: 'https://arxiv.org/abs/2401.01234' }], { fetchPage: fp });
  assert.strictEqual(a.chars, 15000);
  assert.strictEqual(a.partial, false);
  assert.strictEqual(a.finalUrl, 'https://arxiv.org/html/2401.01234');
  const fp2 = async (u) => ({ markdown: u.includes('/html/') ? 'short html'.repeat(10) : u.includes('/pdf/') ? '' : abs3, truncated: false });
  const [b] = await T.fetchSourceTexts([{ url: 'https://arxiv.org/abs/2401.01234' }], { fetchPage: fp2 });
  assert.strictEqual(b.chars, 3000);
  assert.strictEqual(b.partial, true);
  assert.strictEqual(b.partialReason, 'abstract page only');
});

test('r3-7 markUnverified: marks every checkable figure, leaves years', () => {
  assert.strictEqual(T.markUnverified('Added 56.4% and 300k users in 2024.'), 'Added 56.4% [unverified] and 300k [unverified] users in 2024.');
  assert.strictEqual(T.markUnverified('No figures here.'), 'No figures here.');
  assert.strictEqual(T.markUnverified(T.markUnverified('Got 9.5.')), 'Got 9.5 [unverified].');
});

// ================================================================ r4: review round 3 fixes
const R4A = { url: 'https://a.example/a', title: 'Study A paper', ok: true, text: 'Study A enrolled 1,250 participants.' };
const R4B = { url: 'https://b.example/b', title: 'Study B paper', ok: true, text: 'Study B enrolled 800 participants.' };
const R4CLAIMS = [
  { id: 'c1', claim: 'Study A enrolled participants', source_url: 'https://a.example/a', figures: [] },
  { id: 'c2', claim: 'Study B enrolled participants', source_url: 'https://b.example/b', figures: [] },
];

test('r4-1 clause binding: a figure goes with the citation in its own clause', () => {
  const prose = 'Study A enrolled 1,250 participants (https://a.example/a), while study B enrolled 1,250 participants (https://b.example/b).';
  const r = T.checkReport({ prose, claims: R4CLAIMS, fetched: [R4A, R4B] });
  assert.strictEqual(r.prose, 'Study A enrolled 1,250 participants (https://a.example/a), while study B enrolled 1,250 [unverified] participants (https://b.example/b).');
  assert.strictEqual(r.totals.proseUnverified, 1);
  // a clause with no citation of its own, or with two, is unverified too
  const none = T.checkReport({ prose: 'Study A (https://a.example/a) enrolled 1,250 participants, and study B (https://b.example/b) enrolled 800 participants versus 1,250 participants.', claims: R4CLAIMS, fetched: [R4A, R4B] });
  assert.match(none.prose, /versus 1,250 \[unverified\] participants/);
  assert.match(none.prose, /enrolled 800 participants,? ?/);
  const two = T.checkReport({ prose: 'Both (https://a.example/a and https://b.example/b) enrolled 1,250 participants.', claims: R4CLAIMS, fetched: [R4A, R4B] });
  assert.match(two.prose, /1,250 \[unverified\]/);
  // one source in the sentence keeps today's rule
  const one = T.checkReport({ prose: 'Study A enrolled 1,250 participants, while others enrolled more (https://a.example/a).', claims: R4CLAIMS, fetched: [R4A, R4B] });
  assert.ok(!/unverified/.test(one.prose));
});

test('r4-2 units match exactly, both ways', () => {
  const r = T.checkClaims([{ id: 'c', claim: '125 eligible participants', source_url: 'https://a.example/a', figures: [] }], [{ url: 'https://a.example/a', ok: true, text: 'Enrollment rose by 125% last year.' }]);
  assert.strictEqual(r.claims[0].status, 'unverified');
  assert.strictEqual(T.checkFigure('125', 'Enrollment rose by 125% last year.', ['eligible', 'participants']), 'not_found');
  assert.strictEqual(T.checkFigure('56.4', 'agreement 56.4% overall', []), 'not_found');
  assert.strictEqual(T.checkFigure('56.4%', 'agreement 56.4% overall', []), 'found');
  assert.strictEqual(T.checkFigure('56.4', '| model | 56.4 |', []), 'found');
  assert.strictEqual(T.checkFigure('56.4%', '| model | 56.4 |', []), 'not_found');
  assert.strictEqual(T.checkFigure('2x', 'a 2 ratio', []), 'not_found');
  assert.strictEqual(T.checkFigure('2x', 'a 2x speedup', ['speedup']), 'found');
  assert.strictEqual(T.checkFigure('2', 'a 2x speedup', []), 'not_found');
  assert.strictEqual(T.checkFigure('3pp', 'points up 3 pp', ['points']), 'found');
  assert.strictEqual(T.checkFigure('3pp', 'up 3%', []), 'not_found');
  assert.match(T.synthesisBrief('Q?', 'f', 'n', []), /write each figure with its unit exactly as the source prints it \(56\.4% if the source prints 56\.4%; 56\.4 if it prints 56\.4 in a table\)/);
});

test('r4-3 claimKey covers measured_result, judged_by, inference, evidence_strength; not check marks or ids', () => {
  const base = { id: 'c1', claim: 'A is preferred', source_url: 'https://a.example/a', figures: ['56.4'], measured_result: 'increased', judged_by: 'humans', inference: false, evidence_strength: 'strong' };
  const k = T.claimKey(base);
  assert.notStrictEqual(T.claimKey({ ...base, measured_result: 'decreased' }), k);
  assert.notStrictEqual(T.claimKey({ ...base, judged_by: 'model' }), k);
  assert.notStrictEqual(T.claimKey({ ...base, inference: true }), k);
  assert.notStrictEqual(T.claimKey({ ...base, evidence_strength: 'weak' }), k);
  assert.strictEqual(T.claimKey({ ...base, id: 'c7' }), k, 'renumbering does not change it');
  const withNum = { ...base, measured_result: '56.4% against 43.7%' };
  assert.strictEqual(T.claimKey({ ...withNum, measured_result: '56.4% against 43.7% [unverified]', check: 'x', check_status: 'partly' }), T.claimKey(withNum), 'check marks are not content');
});

test('r4-5 parseFigure / numbersIn: prefixes, case-insensitive scale words, ×, bare figure merges with x and pp', () => {
  for (const f of ['~1.5 BILLION'.replace('BILLION', 'million'), '≈ 1.5M', 'about 1.5 MILLION']) {
    assert.deepStrictEqual(T.parseFigure(f), { value: '1500000', unit: '', pct: false }, f);
  }
  // a currency sign is the figure's unit (r5)
  for (const [f, unit] of [['$1.5 Million', 'USD'], ['€1.5 million', 'EUR'], ['£1.5M', 'GBP']]) {
    assert.deepStrictEqual(T.parseFigure(f), { value: '1500000', unit, pct: false }, f);
  }
  assert.strictEqual(T.parseFigure('about 56.4%').value, '56.4');
  assert.strictEqual(T.parseFigure('about 56.4%').unit, 'pct');
  assert.strictEqual(T.parseFigure('~300k').value, '300000');
  assert.strictEqual(T.checkFigure('$300k', 'cost $300,000 in all', []), 'found');
  assert.strictEqual(T.checkFigure('300k', 'cost 300,000 dollars', []), 'found');
  assert.strictEqual(T.numbersIn('worth 2 BILLION dollars')[0].mag, '2000000000');
  assert.strictEqual(T.numbersIn('worth 2 Billion dollars')[0].mag, '2000000000');
  const x = T.numbersIn('a 3× gain')[0];
  assert.strictEqual(x.unit, 'x');
  assert.strictEqual(T.checkFigure('3x', 'a 3× gain', ['gain']), 'found');
  const merge = (c, texts) => T.checkClaims([c], [{ url: 'https://a.example/a', ok: true, text: texts }]).claims[0];
  const mx = merge({ id: 'c', claim: 'A 3x faster run', source_url: 'https://a.example/a', figures: ['3'] }, 'it was 3x faster run');
  assert.strictEqual(mx.figures.length, 1);
  assert.strictEqual(mx.status, 'verified');
  const mp = merge({ id: 'c', claim: 'Gained 4.5 pp over base', source_url: 'https://a.example/a', figures: ['4.5'] }, 'the method gained 4.5 pp over base');
  assert.strictEqual(mp.figures.length, 1);
  assert.strictEqual(mp.status, 'verified');
});

test('r4-6 challengeExcerpts finds a 300k / 1.5M figure by magnitude and unit', () => {
  const text = 'x'.repeat(2000) + ' The service handled 300,000 requests and 1,500,000 users in total. ' + 'y'.repeat(2000);
  const ex = T.challengeExcerpts([{ id: 'c1', claim: 'Load', source_url: 'https://a.example/a', figures: ['300k', '1.5M'] }], [{ url: 'https://a.example/a', ok: true, text }]);
  assert.ok(ex[0].excerpts.some((e) => e.includes('300,000 requests')), JSON.stringify(ex[0].excerpts).slice(0, 200));
  assert.ok(!ex[0].excerpts.includes('no matching passage found in the source'));
});

test('r4-7 sentence splitting: not after et al., e.g., Fig., ...; a table row is its own sentence', () => {
  const abbrevs = ['Smith et al.', 'e.g.', 'i.e.', 'vs.', 'Fig.', 'Figs.', 'Eq.', 'No.', 'Inc.', 'Ltd.', 'Dr.', 'approx.', 'cf.'];
  for (const a of abbrevs) {
    const prose = `Study A (https://a.example/a) ${a} 7 enrolled 1,250 participants. Study B (https://b.example/b) enrolled 800 participants.`;
    const r = T.checkReport({ prose, claims: R4CLAIMS, fetched: [R4A, R4B] });
    assert.ok(!/1,250 \[unverified\]/.test(r.prose), a + ' -> ' + r.prose);
  }
  const rows = '| Study | n |\n| --- | --- |\n| Study B (https://b.example/b) | 1,250 |\nStudy A (https://a.example/a) enrolled 1,250 participants.';
  const t = T.checkReport({ prose: rows, claims: R4CLAIMS, fetched: [R4A, R4B] });
  assert.match(t.prose, /\| 1,250 \[unverified\] \|/);
  assert.match(t.prose, /enrolled 1,250 participants\./);
  assert.ok(!/participants\. \[unverified\]|1,250 \[unverified\] participants/.test(t.prose));
});

test('r4-8 chatReport: a failed figure check says so', () => {
  const t = T.chatReport({ prose: '## Verdict\nA.', claims: [{ id: 'c1', claim: 'A' }], notChecked: true, checkError: true, files: {} });
  assert.match(t, /Figures not checked \(the check failed\); every figure is marked unverified\./);
  assert.doesNotMatch(t, /no list of claims/);
});

// ---------------------------------------------------------------- r5
test('r5-1 an explicit citation that resolves to nothing is never borrowed from another source', () => {
  const A = 'https://a.example/a';
  const B = 'https://b.example/b';
  const claims = [{ id: 'c1', claim: 'Study A enrolled participants', source_url: A, figures: ['1,250'] }];
  const fetched = [{ url: A, title: 'Alpha paper', ok: true, text: 'Study A enrolled 1,250 participants.' }];
  const r = T.checkReport({ prose: `Study A enrolled 1,250 participants (${A}). Study B enrolled 1,250 participants (${B}).`, claims, fetched, counts: {} });
  assert.strictEqual(r.totals.proseVerified, 1);
  assert.strictEqual(r.totals.proseUnverified, 1);
  assert.match(r.prose, /Study B enrolled 1,250 \[unverified\]/);
  assert.ok(!/Study A enrolled 1,250 \[unverified\]/.test(r.prose));
  // a citation to a source that was not fetched is the same
  const nf = T.checkReport({ prose: `Study A enrolled 1,250 participants (${A}), while 1,250 more joined (${B}).`, claims, fetched, counts: {} });
  assert.match(nf.prose, /while 1,250 \[unverified\] more/);
  // the paragraph fallback applies only when the sentence cites nothing at all
  const fb = T.checkReport({ prose: `Study A (${A}) is the source.\nIt enrolled 1,250 participants.`, claims, fetched, counts: {} });
  assert.strictEqual(fb.marks, 0);
});

test('r5-2 currency is a unit', () => {
  assert.strictEqual(T.checkFigure('€1,250', 'We paid $1,250 in total.'), 'not_found');
  assert.strictEqual(T.checkFigure('€1,250', 'We paid EUR 1,250 in total.'), 'found');
  assert.strictEqual(T.checkFigure('EUR 1,250', 'We paid €1,250 in total.'), 'found');
  assert.strictEqual(T.checkFigure('$4.2B', 'revenue of $4,200,000,000'), 'found');
  assert.strictEqual(T.checkFigure('$4.2B', 'revenue of 4.2 billion USD'), 'found');
  assert.strictEqual(T.checkFigure('1,250', 'We paid $1,250 in total.'), 'not_found');
  assert.strictEqual(T.checkFigure('$1,250', 'We saw 1,250 items.'), 'not_found');
  assert.strictEqual(T.checkFigure('1,250 usd', 'US$1,250'), 'found');
  assert.strictEqual(T.checkFigure('£1,250', 'We paid $1,250'), 'not_found');
  assert.strictEqual(T.numbersIn('costs €1,250 or 1,250 EUR')[0].unit, 'EUR');
  assert.strictEqual(T.numbersIn('costs €1,250 or 1,250 EUR')[1].unit, 'EUR');
  assert.strictEqual(T.parseFigure('$').unit, '');
  assert.strictEqual(T.parseFigure('$5').unit, 'USD');
  // in a report a bare prose figure is not backed by a currency figure
  const claims = [{ id: 'c1', claim: 'Revenue', source_url: 'https://a.example/a', figures: ['$1,250'] }];
  const fetched = [{ url: 'https://a.example/a', title: 'T', ok: true, text: 'Revenue was $1,250.' }];
  assert.strictEqual(T.checkReport({ prose: 'Revenue was $1,250 (https://a.example/a).', claims, fetched }).marks, 0);
  assert.strictEqual(T.checkReport({ prose: 'Revenue was €1,250 (https://a.example/a).', claims, fetched }).marks, 1);
  assert.strictEqual(T.checkReport({ prose: 'Revenue was 1,250 (https://a.example/a).', claims, fetched }).marks, 1);
});

test('r5-3 a clause with no citation inherits a neighbour clause that has one citation and no figure', () => {
  const A = 'https://a.example/a';
  const B = 'https://b.example/b';
  const claims = [
    { id: 'c1', claim: 'A accuracy', source_url: A, figures: ['56.4%'] },
    { id: 'c2', claim: 'B accuracy', source_url: B, figures: ['60.2%'] },
  ];
  const fetched = [
    { url: A, title: 'Alpha paper', ok: true, text: 'Accuracy was 56.4% and 3.2 points above.' },
    { url: B, title: 'Beta paper', ok: true, text: 'Accuracy was 60.2%.' },
  ];
  const r = T.checkReport({ prose: `According to A (${A}), accuracy was 56.4%, and according to B (${B}), 60.2%.`, claims, fetched, counts: {} });
  assert.strictEqual(r.marks, 0);
  assert.strictEqual(r.totals.proseVerified, 2);
  // swapped: each figure is bound to its own source, not the other
  const sw = T.checkReport({ prose: `According to A (${A}), accuracy was 60.2%, and according to B (${B}), 56.4%.`, claims, fetched, counts: {} });
  assert.strictEqual(sw.marks, 2);
  // the neighbour has a figure of its own: no inheritance, so 56.4% stays unverified (its clause cites nothing)
  const n = T.checkReport({ prose: `A reached 56.4% on X, 3.2 points above baseline (${A}), while B reached 60.2% (${B})`, claims, fetched, counts: {} });
  assert.match(n.prose, /56\.4% \[unverified\] on X/);
  assert.ok(!/60\.2% \[unverified\]/.test(n.prose));
});

test('r5-4 a figures entry with a unit absorbs the same bare number in the claim text', () => {
  const claims = [{ id: 'c1', claim: 'Preference', source_url: 'https://a.example/a', figures: ['56.4%', '43.6%'], measured_result: '56.4 vs 43.6' }];
  const fetched = [{ url: 'https://a.example/a', title: 'T', ok: true, text: 'Preferred 56.4% against 43.6%.' }];
  const res = T.checkClaims(claims, fetched);
  assert.strictEqual(res.claims[0].status, 'verified');
  assert.strictEqual(res.claims[0].figures.length, 2);
  assert.ok(!/unverified/.test(T.applyCheck(claims, res)[0].measured_result));
  // a bare number of another value is still its own figure
  const more = T.checkClaims([{ ...claims[0], measured_result: '56.4 vs 43.6 over 7 runs' }], fetched);
  assert.strictEqual(more.claims[0].figures.length, 3);
});

test('r5-5 units: percentage points, -fold, times; No. only when capitalised', () => {
  const u = (s) => T.numbersIn(s).map((t) => t.unit);
  assert.deepStrictEqual(u('up 3.2 percentage points and 2 percentage point, 4 pp'), ['pp', 'pp', 'pp']);
  assert.deepStrictEqual(u('a 3-fold gain, 2.5 times faster, 4x'), ['x', 'x', 'x']);
  assert.strictEqual(T.checkFigure('3.2 pp', 'rose 3.2 percentage points in total', ['rose']), 'found');
  assert.strictEqual(T.checkFigure('3x', 'a 3-fold improvement', ['improvement']), 'found');
  assert.strictEqual(T.checkFigure('3x', 'three runs, 3 times as large', ['large']), 'found');
  assert.strictEqual(T.checkFigure('3.2', 'rose 3.2 percentage points', ['rose']), 'not_found');
  const s = (t) => T.checkReport({ prose: t, claims: [] }).prose;
  assert.strictEqual(s('Ranked No. 1,250 of all.'), 'Ranked No. 1,250 [unverified] of all.');
  // "no." ends a sentence: a figure after it is in a new sentence
  const A = 'https://a.example/a';
  const claims = [{ id: 'c1', claim: 'Study A enrolled participants', source_url: A, figures: ['1,250'] }];
  const fetched = [{ url: A, title: 'Alpha paper', ok: true, text: 'enrolled 1,250 participants' }];
  // (the second sentence cites an unfetched B; if "no." did not split, B would taint the 1,250)
  const low = T.checkReport({ prose: `It enrolled 1,250 participants (${A}) was it no. And more were seen (https://b.example/b).`, claims, fetched, counts: {} });
  assert.strictEqual(low.marks, 0);
  const cap = T.checkReport({ prose: `It enrolled 1,250 participants (${A}) was it No. And more were seen (https://b.example/b).`, claims, fetched, counts: {} });
  assert.strictEqual(cap.marks, 1);
});
