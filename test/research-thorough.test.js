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
  assert.strictEqual(T.checkFigure('56.4', SOURCE, []), 'found');
  assert.strictEqual(T.checkFigure('56.4%', SOURCE, []), 'found');
  assert.strictEqual(T.checkFigure('1450', SOURCE, []), 'found');
  assert.strictEqual(T.checkFigure('-3.2', SOURCE, []), 'found');
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
  assert.strictEqual(T.checkFigure('5%', SOURCE, ['groups']), 'found');
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
    { id: 'c1', claim: 'The new method is preferred over the baseline', source_url: 'https://arxiv.org/pdf/2401.01234', figures: ['56.4', '43.6'] },
    { id: 'c2', claim: 'Retrieval precision and recall are reported', source_url: 'https://arxiv.org/abs/2401.01234v1', figures: ['0.884', '0.55'] },
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
  assert.deepStrictEqual(pf('GPT-4.1 beat Llama-3.1-8B and o4-mini, v2 and 8B, 3x faster.'), []);
  assert.deepStrictEqual(pf('Model-A1 scored 56.4% and Atlas-7 scored 12.5'), ['56.4%', '12.5']);
  assert.deepStrictEqual(pf('It gained 4.1 points, not v4.1 or 4.1x.'), ['4.1']);
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
  assert.strictEqual(out[0].check, '1 of 2 found; not found: 43.7');
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
  assert.match(markdown, /### Not opened in full\n\n- \[Closed page\]\(https:\/\/example\.org\/none\)/);
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
  assert.ok(t.indexOf('Verified one') < t.indexOf('Unverified one'));
  assert.ok(!/\p{Extended_Pictographic}/u.test(t));
});

test('chatReport: no missing line, no PDF reason, None corrections, 1 round', () => {
  const t = T.chatReport({ prose: '## Verdict\nV.\n\n## Corrections to the first pass\nNone\n', claims: [], totals: { figures: 0, found: 0, notFound: 0, notOpened: 0 }, reviewer: 'Reviewer X', rounds: 1, files: { md: '/f/r.md', pdfError: 'no Chrome found' } });
  assert.doesNotMatch(t, /Missing:/);
  assert.match(t, /No PDF: no Chrome found/);
  assert.match(t, /Corrections to the first pass\nNone/);
  assert.match(t, /\(1 round\)/);
  const caps = T.chatReport({ prose: '## Verdict\nV.', claims: Array.from({ length: 9 }, (_, i) => ({ id: 'c' + i, claim: 'claim ' + i })), totals: {}, files: {} });
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
  assert.strictEqual(ann[0].check, '2 of 3 found; not found: 43.7');
});
