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
  assert.strictEqual(T.checkFigure('56.4', SOURCE, []), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('56.4%', SOURCE, []), 'found_as_written');
  // r8: the written form counts: SOURCE says "1,450 items", so a bare 1450 is not found as written; "1,450 items" is
  assert.strictEqual(T.checkFigure('1450', SOURCE, []), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('1,450 items', SOURCE, []), 'found_as_written');
  // -3.2 has 2 significant digits, so it is now a common number (r2 fix 6) and needs a keyword nearby (r8: and its next word "points")
  assert.strictEqual(T.checkFigure('-3.2 points', SOURCE, ['points']), 'found_as_written');
  assert.strictEqual(T.checkFigure('-3.2 points', SOURCE, []), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('-3.2', SOURCE, ['points']), 'not_found_as_written');
  // r9a: "and" is a word of the form now (it is no function word) and "a drop" is a rate ("per drop"): the source's form is "and a drop"
  assert.strictEqual(T.checkFigure('0.550', SOURCE, []), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('0.550 and a drop', SOURCE, []), 'found_as_written');
  assert.strictEqual(T.checkFigure('0.55', SOURCE, []), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('43.7', SOURCE, []), 'not_found_as_written');
  const only = 'tickets: 21450 and 156.4 meters';
  assert.strictEqual(T.checkFigure('1450', only, []), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('1,450 items', only, []), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('56.4', only, []), 'not_found_as_written');
});

test('checkFigure: common numbers need a keyword nearby', () => {
  // r8: the figure is written with its next word, as the source has it ("30 raters")
  assert.strictEqual(T.checkFigure('30 raters', SOURCE, ['raters']), 'found_as_written');
  assert.strictEqual(T.checkFigure('30 raters', SOURCE, ['elephants']), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('30 raters', SOURCE, []), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('5 groups', SOURCE, ['groups']), 'found_as_written');
  // r2 fix 1: a percent figure no longer matches a plain "5 groups" in the source
  assert.strictEqual(T.checkFigure('5%', SOURCE, ['groups']), 'not_found_as_written');
  const far = 'The number 30 appears here.' + ' filler'.repeat(100) + ' raters were many.';
  assert.strictEqual(T.checkFigure('30 appears', far, ['raters']), 'not_found_as_written'); // the same written form, but the keyword is far away
  assert.strictEqual(T.checkFigure('30 appears', far, ['number']), 'found_as_written');
  assert.strictEqual(T.checkFigure('99', SOURCE, ['raters']), 'not_found_as_written');
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
    { id: 'c6', claim: 'Raters count', source_url: 'https://arxiv.org/html/2401.01234v2', figures: ['30 raters'] }, // r8: a counted number is written with its next word
  ];
  const r = T.checkClaims(claims, FETCHED);
  const st = Object.fromEntries(r.claims.map((c) => [c.id, c.status]));
  // r8: c4 cites a URL that is not among the fetched sources at all: no source to check (a fetched source that failed is source_not_opened)
  assert.deepStrictEqual(st, { c1: 'found_as_written', c2: 'partly_found_as_written', c3: 'not_found_as_written', c4: 'no_source', c5: 'no_figures', c6: 'found_as_written' });
  assert.strictEqual(r.claims[3].source_opened, false);
  assert.strictEqual(r.claims[0].source_opened, true);
  assert.deepStrictEqual(r.claims[1].figures.map((f) => f.status), ['found_as_written', 'not_found_as_written']);
  assert.deepStrictEqual(r.totals, { claims: 6, figures: 9, found: 4, notFound: 3, notOpened: 0, noSource: 2 });
});

test('checkClaims: matches finalUrl and trailing slash/fragment/case', () => {
  const fetched = [{ url: 'https://short.example/x', finalUrl: 'https://Docs.Example.com/page/', ok: true, text: 'the value is 12.5.' }]; // r8: "12.5 here" would carry the word "here" in its form
  const r = T.checkClaims([{ id: 'c1', claim: 'Value', source_url: 'https://docs.example.com/page#top', figures: ['12.5'] }], fetched);
  assert.strictEqual(r.claims[0].status, 'found_as_written');
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

test('markProse: marks only the figures not found, counts', () => {
  const prose = 'Preferred 56.4% against 43.6%, with 1,450 items (Table 6) in 2024.';
  const r = T.markProse(prose, new Set(['56.4', '1450']));
  assert.strictEqual(r.marks, 1);
  assert.strictEqual(r.prose, 'Preferred 56.4% against 43.6% [not found in source], with 1,450 items (Table 6) in 2024.');
  const again = T.markProse(r.prose, new Set(['56.4', '1450']));
  assert.strictEqual(again.marks, 0);
  assert.strictEqual(T.markProse('A 9.5 and 9.5 again', new Set()).marks, 2);
});

test('applyCheck: annotates claims and measured_result', () => {
  const claims = [
    { id: 'c1', claim: 'Preferred over the baseline', source_url: 'https://arxiv.org/abs/2401.01234', figures: ['56.4', '43.7'], measured_result: '56.4% against 43.7%' },
    { id: 'c2', claim: 'Raters', source_url: 'https://arxiv.org/abs/2401.01234', figures: ['1450', '0.550 and a drop', '30 raters'], measured_result: '1,450 items' }, // r8: "30 raters" as the source writes it; r9a: "and a drop" is the form
    { id: 'c3', claim: 'Other', source_url: 'https://example.org/none', figures: ['9.9'], measured_result: '9.9 points' },
    { id: 'c4', claim: 'Plain statement', source_url: 'https://arxiv.org/abs/2401.01234', figures: [], measured_result: '' },
  ];
  const res = T.checkClaims(claims, FETCHED);
  const out = T.applyCheck(claims, res);
  assert.strictEqual(out[0].check, '1 of 2 found as written'); // r4: the bare 43.7 takes the % the claim text shows
  assert.strictEqual(out[0].measured_result, '56.4% against 43.7% [not found in source]');
  // r9b: every figure_check also carries its second mark (here nothing was reviewed: not checked)
  assert.deepStrictEqual(out[0].figure_checks, [{ figure: '56.4%', status: 'found_as_written', meaning: 'not checked', meaning_quote: '' }, { figure: '43.7%', status: 'not_found_as_written', meaning: 'not checked', meaning_quote: '' }]);
  assert.strictEqual(out[1].check, '3 of 3 found as written');
  // r8: c3 cites a URL that is not among the fetched sources: no source to check
  assert.strictEqual(out[2].check, 'no source to check');
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
  // r9b: the "Figures checked" column became two columns, "In the source" and "Means the same"
  assert.match(markdown, /\| Claim \| Source \| Measured result \| Who judged \| Evidence strength \| Our inference \| In the source \| Means the same \|/);
  assert.match(markdown, /\| yes \| source not opened \| not checked \|/);
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
    { id: 'c1', claim: 'Unverified one', source_url: 'https://a.example/1', check_status: 'not_found_as_written' },
    { id: 'c2', claim: 'Verified one', source_url: 'https://a.example/2', check_status: 'found_as_written', figure_checks: [{ figure: '5', status: 'found_as_written', meaning: 'matches', meaning_quote: 'five items' }] },
    { id: 'c3', claim: 'Inference', source_url: 'https://a.example/3', check_status: 'no_figures', inference: true },
  ];
  const t = T.chatReport({ question: 'Q', prose, claims, totals: { claims: 3, figures: 10, found: 7, notFound: 2, notOpened: 1, noSource: 0 }, reviewer: 'GPT-5', rounds: 2, files: { md: '/f/r.md', pdf: '/f/r.pdf' }, missing: ['reader notes for 2 sources'], level: 'thorough' });
  // r9b: the summary line is now "In the source (checked by code against the fetched text): ..." plus a "Means the same" line
  assert.match(t, /In the source \(checked by code against the fetched text\): 7 found as written; 2 not found as written \(marked "not found in source"\); 1 from sources that could not be opened \(marked "source not opened"\); 0 with no source to check\./);
  assert.match(t, /Means the same \(checked by the reviewer against the passage around each figure\): 0 matches; 0 differs \(marked "source says otherwise"\); 10 not checked\. Confirmed by both: 0 of 10 figures\./);
  assert.match(t, /Challenged by: GPT-5 \(2 rounds\)/);
  assert.match(t, /Full document: \/f\/r\.md/);
  assert.match(t, /PDF: \/f\/r\.pdf/);
  assert.match(t, /Missing: reader notes for 2 sources/);
  assert.match(t, /Verdict\nA is preferred\./);
  assert.match(t, /- The first pass said 55\.4%/);
  assert.match(t, /Confidence\nMedium: one study\./);
  // r2 fix 10 / r9b: Key evidence lists only claims whose figures were all confirmed (found as written and the meaning matches)
  assert.ok(t.includes('Verified one'));
  assert.match(t, /Verified one \[https:\/\/a\.example\/2\] \(figures confirmed by both checks\)/);
  assert.ok(!t.includes('Unverified one'));
  assert.ok(!/\p{Extended_Pictographic}/u.test(t));
});

test('chatReport: no missing line, no PDF reason, None corrections, 1 round', () => {
  const t = T.chatReport({ prose: '## Verdict\nV.\n\n## Corrections to the first pass\nNone\n', claims: [], totals: { figures: 0, found: 0, notFound: 0, notOpened: 0 }, reviewer: 'Reviewer X', rounds: 1, files: { md: '/f/r.md', pdfError: 'no Chrome found' } });
  assert.doesNotMatch(t, /Missing:/);
  assert.match(t, /No PDF: no Chrome found/);
  assert.match(t, /Corrections to the first pass\nNone/);
  assert.match(t, /\(1 round\)/);
  const caps = T.chatReport({ prose: '## Verdict\nV.', claims: Array.from({ length: 9 }, (_, i) => ({ id: 'c' + i, claim: 'claim ' + i, check_status: 'verified', figure_checks: [{ figure: '5', status: 'found_as_written', meaning: 'matches', meaning_quote: 'five items' }] })), totals: {}, files: {} });
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
  const reply = '## Verdict\nPreferred 56.4% against 43.7% (Table 6), 1,450 items, 2024.\n\n```claims\n[{"id":"c1","claim":"Preferred over the baseline","source_url":"https://arxiv.org/abs/2401.01234","figures":["56.4","43.7","1,450 items"],"measured_result":"56.4% vs 43.7%","judged_by":"humans","evidence_strength":"strong","inference":false}]\n```';
  const p = T.parseClaims(reply);
  const res = T.checkClaims(p.claims, FETCHED);
  assert.strictEqual(res.claims[0].status, 'partly_found_as_written');
  const marked = T.markProse(p.prose, T.verifiedFigures(res));
  assert.strictEqual(marked.marks, 1);
  assert.match(marked.prose, /43\.7% \[not found in source\]/);
  assert.doesNotMatch(marked.prose, /56\.4% \[not found in source\]/);
  const ann = T.applyCheck(p.claims, res);
  assert.strictEqual(ann[0].check, '2 of 3 found as written'); // r8: "1,450 items" is written as the source has it
});

// ================================================================ r2 review fixes
const SRC_A = 'Study A enrolled 125 participants and reported 56.4 percent agreement. Study A also used 2000 samples in 2048-token windows.';
const SRC_B = 'Study B enrolled 80 participants and reported 0.884 precision.';
const F2 = [
  { url: 'https://a.example/a', title: 'Study A paper', ok: true, text: SRC_A },
  { url: 'https://b.example/b', title: 'Study B paper', ok: true, text: SRC_B },
];

test('r2-1 figure units: 125% is not "125 participants"; 56.4 matches 56.4%', () => {
  assert.strictEqual(T.checkFigure('125%', 'We enrolled 125 participants.', ['participants']), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('125 participants', 'We enrolled 125 participants.', ['participants']), 'found_as_written');
  assert.strictEqual(T.checkFigure('125', 'We enrolled 125 participants.', ['participants']), 'not_found_as_written'); // r8: a bare 125 is not "125 participants"
  // r4: a bare 56.4 no longer matches 56.4% (it used to); exact units both ways
  assert.strictEqual(T.checkFigure('56.4', 'agreement 56.4% overall', []), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('56.4%', 'agreement 56.4% overall', []), 'found_as_written');
  assert.strictEqual(T.checkFigure('56.4', '| Method | 56.4 |', []), 'found_as_written');
  assert.strictEqual(T.checkFigure('56.4%', 'agreement 56.4 % overall', []), 'found_as_written');
  assert.strictEqual(T.checkFigure('56.4%', 'agreement 56.4 percent overall', []), 'found_as_written');
  assert.strictEqual(T.checkFigure('56.4 percent', 'agreement 56.4 per cent overall', []), 'found_as_written');
  assert.strictEqual(T.checkFigure('56.4%', 'agreement 56.4 points overall', []), 'not_found_as_written');
  assert.strictEqual(T.numbersIn('a 56.4 % b')[0].pct, true);
});

test('r2-2 arXiv versions: explicit version matches only that version', () => {
  const v1 = [{ url: 'https://arxiv.org/abs/2401.01234v1', ok: true, text: 'value 12.5 here', title: 'P' }];
  const mk = (u) => [{ id: 'c1', claim: 'Value', source_url: u, figures: ['12.5 here'] }]; // r8: the figure with its next word, as the source writes it
  // r8: v2 is not among the fetched sources: no source to check (not "source not opened", which is a fetched source that failed)
  assert.strictEqual(T.checkClaims(mk('https://arxiv.org/abs/2401.01234v2'), v1).claims[0].status, 'no_source');
  assert.strictEqual(T.checkClaims(mk('https://arxiv.org/pdf/2401.01234v1'), v1).claims[0].status, 'found_as_written');
  assert.strictEqual(T.checkClaims(mk('https://arxiv.org/html/2401.01234v1'), v1).claims[0].status, 'found_as_written');
  assert.strictEqual(T.checkClaims(mk('https://arxiv.org/abs/2401.01234'), v1).claims[0].status, 'found_as_written');
});

test('r2-3 claim text figures are checked against the claim source', () => {
  const claims = [{ id: 'c1', claim: '125 participants achieved 83% accuracy', source_url: 'https://a.example/a', figures: ['125'], measured_result: '' }];
  const r = T.checkClaims(claims, F2);
  assert.strictEqual(r.claims[0].status, 'partly_found_as_written');
  // r8: the bare "125" is checked as the claim text writes it, with its next word ("125 participants"); the source has that
  assert.deepStrictEqual(r.claims[0].figures.map((f) => [f.figure, f.status]), [['125', 'found_as_written'], ['83%', 'not_found_as_written']]);
  assert.strictEqual(T.checkClaims([{ ...claims[0], claim: '125 adults achieved 83% accuracy' }], F2).claims[0].figures[0].status, 'not_found_as_written');
  assert.strictEqual(r.totals.figures, 2);
  const m = T.checkClaims([{ id: 'c1', claim: 'Agreement', source_url: 'https://a.example/a', figures: [], measured_result: '56.4% and 71.2%' }], F2);
  assert.strictEqual(m.claims[0].status, 'partly_found_as_written');
});

test('r2-4 prose figures need a claim named in their own block', () => {
  const claims = [{ id: 'c1', claim: 'Study A enrolled participants', source_url: 'https://a.example/a', figures: ['125 participants'] }];
  const prose = '- Study A (https://a.example/a) enrolled 125 participants.\n- Study B (https://b.example/b) enrolled 125 participants.\n\nElsewhere 125 participants were mentioned with no source.';
  const r = T.checkReport({ prose, claims, fetched: F2, counts: {} });
  const lines = r.prose.split('\n');
  assert.ok(!/\[/.test(lines[0]));
  // r8: Study B's source is not cited by any claim: no source to check; the figure that has no source at all says so too
  assert.match(lines[1], /125 \[no source to check\]/);
  assert.match(r.prose, /Elsewhere 125 \[no source to check\] participants/);
  assert.strictEqual(r.marks, 2);
  assert.strictEqual(r.notChecked, false);
  assert.strictEqual(r.claims[0].check_status, 'found_as_written');
  // the fetched title also names a claim's source
  const t = T.checkReport({ prose: 'The Study A paper found 125 participants.', claims, fetched: F2, counts: {} });
  assert.strictEqual(t.marks, 0);
  assert.deepStrictEqual(T.proseBlocks('a\nb\n\n- c\n- d\n1. e').map((b) => [b.start, b.end]), [[0, 3], [5, 8], [9, 12], [13, 17]]);
  assert.strictEqual(T.proseBlocks('a\nb\n\n- c\n- d\n1. e').length, 4);
});

test('r2-4 checkReport: no claims -> everything checkable has no source to check, totals zero', () => {
  const prose = 'Preferred 56.4% of 1,450 items in 2024 (Table 6) with 12 sources.';
  for (const claims of [[], undefined]) {
    const r = T.checkReport({ prose, claims, fetched: F2, counts: { sourcesOpened: 12 } });
    assert.strictEqual(r.notChecked, true);
    // r8: no claims list means the check did not run: "not checked"
    assert.strictEqual(r.prose, 'Preferred 56.4% [not checked] of 1,450 [not checked] items in 2024 (Table 6) with 12 sources.');
    assert.deepStrictEqual(r.totals, { claims: 0, figures: 0, found: 0, notFound: 0, notOpened: 0, noSource: 0, proseFigures: 2, proseFound: 0, proseNotFound: 0, proseNotOpened: 0, proseNoSource: 0, proseNotChecked: 2 }); // r8: the figures are counted as not checked, not as no source
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
  // r8: each figure is written with its next word, as the text has it
  assert.strictEqual(T.checkFigure('1.5 points', text, []), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('1.5 points', text, ['points']), 'found_as_written');
  // r9a: the text's "0.05 and" is written with "and" (no function word any more)
  assert.strictEqual(T.checkFigure('0.05 and', text, []), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('0.05 and', text, ['beta']), 'found_as_written');
  assert.strictEqual(T.checkFigure('0.05', text, ['beta']), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('450 workers', text, []), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('450 workers', text, ['workers']), 'found_as_written');
  assert.strictEqual(T.checkFigure('450', text, ['workers']), 'not_found_as_written'); // a bare 450 is not "450 workers"
  assert.strictEqual(T.checkFigure('0.884 precision', text, []), 'found_as_written');
  assert.strictEqual(T.checkFigure('12.5 units', text, []), 'found_as_written');
  assert.strictEqual(T.checkFigure('1500 rows', text, []), 'found_as_written');
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
  // r8: check_status 'verified' / 'unverified' as an older run saved them still read as found / not found as written
  const claims = [
    { id: 'c1', claim: 'Good one', source_url: 'https://a.example/1', check_status: 'verified', figure_checks: [{ figure: '5', status: 'found_as_written', meaning: 'matches', meaning_quote: 'five items' }] },
    { id: 'c2', claim: 'Doubted one', source_url: 'https://a.example/2', check_status: 'found_as_written', figure_checks: [{ figure: '5', status: 'found_as_written', meaning: 'matches', meaning_quote: 'five items' }] },
    { id: 'c3', claim: 'Bad figures', source_url: 'https://a.example/3', check_status: 'unverified' },
  ];
  const t = T.chatReport({ prose, claims, totals: { figures: 3, found: 2, notFound: 1, notOpened: 0 }, doubtedIds: ['c2'], review: { label: 'GPT-5', rounds: 2, counts: { supported: 4, partly: 1, not_supported: 0, cannot_check: 2 }, uncheckedIds: ['c3', 'c7'], failed: false }, files: {} });
  assert.match(t, /Key evidence\n- Good one \[https:\/\/a\.example\/1\] \(figures confirmed by both checks\)\n\nDoubted by the review\n- Doubted one/);
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
  assert.match(n, /Figures not checked: the report had no list of claims to check them against; every figure in it is marked not checked\./);
  assert.doesNotMatch(n, /Figures checked against/);
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
  assert.strictEqual(T.checkFigure('300k', 'Served 300 requests.', []), 'not_found_as_written');
  // r8: the next word ("requests") is part of the form, so the figure is written with it
  assert.strictEqual(T.checkFigure('300k requests', 'Served 300,000 requests.', []), 'found_as_written');
  assert.strictEqual(T.checkFigure('300k', 'Served 300,000 requests.', []), 'not_found_as_written');
  // r9a: a one-letter scale counts only when it touches the number; "300 k" is a number and the word "k"
  assert.strictEqual(T.checkFigure('300k requests', 'Served 300 k requests.', []), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('300k requests', 'Served 300 thousand requests.', []), 'found_as_written');
  assert.strictEqual(T.checkFigure('300', 'Served 300k requests.', []), 'not_found_as_written');
  // r7: "dollars" alone is its own currency word (never "$" and never a bare number), so a bare 4.2B is not backed by it
  assert.strictEqual(T.checkFigure('4.2B', 'Revenue 4,200,000,000 dollars.', []), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('4.2B', 'Revenue 4.2 billion dollars.', []), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('4.2B dollars', 'Revenue 4.2 billion dollars.', []), 'found_as_written');
  // r8: "About" in the source is a qualifier the figure has to carry as well
  assert.strictEqual(T.checkFigure('about 1.5M users', 'About 1,500,000 users.', []), 'found_as_written');
  assert.strictEqual(T.checkFigure('1.5M users', 'About 1,500,000 users.', []), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('about 1.5M users', 'About 1.5 million users.', []), 'found_as_written');
  assert.strictEqual(T.checkFigure('about 1.2m users', 'About 1.2 million users.', []), 'not_found_as_written'); // r9a: a lower-case m touching the number is no million
  assert.strictEqual(T.checkFigure('3x', 'a 3 point gain', []), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('3x', 'a 3x speed-up', ['speed']), 'found_as_written');
  assert.strictEqual(T.checkFigure('5pp', 'a 5 pp rise', ['rise']), 'found_as_written');
  assert.strictEqual(T.checkFigure('5pp', 'a 5% rise', []), 'not_found_as_written');
  // the reviewer's probe, through the whole check
  const r = T.checkReport({ prose: 'Throughput reached 300k requests (https://a.example/a).', claims: [{ id: 'c1', claim: 'Throughput reached 300k requests', source_url: 'https://a.example/a', figures: ['300k'] }], fetched: [{ url: 'https://a.example/a', title: 'T', ok: true, text: 'We saw 300 requests.' }] });
  assert.match(r.prose, /300k \[not found in source\]/);
  assert.strictEqual(r.claims[0].check_status, 'not_found_as_written');
  // r9a: "1.5 M" (a space) is the number 1.5 and the word "M"; only a touching "1.5M" is a million
  assert.strictEqual(T.numbersIn('Got 300k and 4.2B and 1.5 M').map((t) => t.mag).join(','), '300000,4200000000,1.5');
  assert.strictEqual(T.numbersIn('Got 300k and 4.2B and 1.5M').map((t) => t.mag).join(','), '300000,4200000000,1500000');
});

test('r3-1 units: a figure is value + unit; a counted number needs a source number without %', () => {
  const claims = [{ id: 'c1', claim: 'Enrollment was 125 participants with 125% growth', source_url: 'https://a.example/a', figures: [] }];
  const fetched = [{ url: 'https://a.example/a', title: 'T', ok: true, text: 'Enrollment grew by 125% over the year.' }];
  const r = T.checkReport({ prose: 'x', claims, fetched });
  assert.strictEqual(r.totals.figures, 2);
  assert.strictEqual(r.totals.found, 1);
  assert.strictEqual(r.totals.notFound, 1);
  assert.strictEqual(r.claims[0].check, '1 of 2 found as written');
  const one = (claim, text) => T.checkClaims([{ id: 'c', claim, source_url: 'https://a.example/a', figures: ['56.4'] }], [{ url: 'https://a.example/a', ok: true, text }]).claims[0].status;
  assert.strictEqual(one('Share was 56.4%', 'agreement 56.4% overall'), 'found_as_written');
  assert.strictEqual(one('It had 56.4 participants', 'agreement 56.4% overall'), 'not_found_as_written');
  // r8: "12.5 and" (a function word is no part of the form) and "12.5 again" are two written forms: two figures
  assert.strictEqual(T.checkClaims([{ id: 'c', claim: 'Gain of 12.5 and 12.5 again', source_url: 'https://a.example/a', figures: ['12.5'] }], fetched).totals.figures, 2);
});

test('r3-2 sentence binding: a figure is tied to the claim cited in its own sentence', () => {
  const claims = [
    { id: 'c1', claim: 'Study A enrolled 1,250 participants', source_url: 'https://a.example/a', figures: ['1,250'] },
    { id: 'c2', claim: 'Study B enrolled participants', source_url: 'https://b.example/b', figures: ['800'] },
  ];
  const prose = 'Study A enrolled 1,250 participants (https://a.example/a). Study B enrolled 1,250 participants (https://b.example/b).';
  const r = T.checkReport({ prose, claims, fetched: [R3A, R3B] });
  assert.strictEqual(r.prose, 'Study A enrolled 1,250 participants (https://a.example/a). Study B enrolled 1,250 [not found in source] participants (https://b.example/b).');
  assert.strictEqual(r.totals.proseFigures, 2);
  assert.strictEqual(r.totals.proseFound, 1);
  assert.strictEqual(r.totals.proseNotFound, 1);
  assert.strictEqual(r.totals.proseNotOpened, 0);
  assert.strictEqual(r.totals.proseNoSource, 0);
});

test('r3-2 sentence binding: an uncited sentence uses the block only when the block cites exactly one source', () => {
  const one = [{ id: 'c1', claim: 'Study A enrolled participants', source_url: 'https://a.example/a', figures: [] }];
  const r1 = T.checkReport({ prose: 'Study A is described at https://a.example/a. It enrolled 1,250 participants.', claims: one, fetched: [R3A, R3B] });
  assert.strictEqual(r1.marks, 0);
  assert.strictEqual(r1.totals.proseFound, 1);
  const r1b = T.checkReport({ prose: 'Study A is described at https://a.example/a. It enrolled 1,300 participants.', claims: one, fetched: [R3A, R3B] });
  assert.strictEqual(r1b.marks, 1);
  assert.match(r1b.prose, /1,300 \[not found in source\] participants/);
  const two = [...one, { id: 'c2', claim: 'Study B enrolled participants', source_url: 'https://b.example/b', figures: [] }];
  const r2 = T.checkReport({ prose: 'See https://a.example/a and https://b.example/b. It enrolled 1,250 participants.', claims: two, fetched: [R3A, R3B] });
  assert.strictEqual(r2.marks, 1);
  // two sources in the block and none in the sentence: there is no single source to check against
  assert.strictEqual(r2.totals.proseNoSource, 1);
  assert.match(r2.prose, /1,250 \[no source to check\] participants/);
  const r3 = T.checkReport({ prose: 'A had 1,250 participants (https://a.example/a); B had 1,250 participants (https://b.example/b).', claims: two, fetched: [R3A, R3B] });
  assert.strictEqual(r3.totals.proseFound, 1);
  assert.match(r3.prose, /B had 1,250 \[not found in source\] participants/);
});

test('r3-3 chatReport: prose figures not tied to a source', () => {
  // r8: claim figures and prose figures are both counted in the summary line
  const totals = { claims: 3, figures: 10, found: 7, notFound: 2, notOpened: 1, noSource: 0, proseFigures: 6, proseFound: 2, proseNotFound: 1, proseNotOpened: 0, proseNoSource: 3 };
  const t = T.chatReport({ prose: '## Verdict\nA.', claims: [], totals, files: {} });
  // r9b: the first summary line is now "In the source (checked by code against the fetched text): ..."
  assert.match(t, /In the source \(checked by code against the fetched text\): 9 found as written; 3 not found as written \(marked "not found in source"\); 1 from sources that could not be opened \(marked "source not opened"\); 3 with no source to check\./);
  const t1 = T.chatReport({ prose: '## Verdict\nA.', claims: [], totals: { ...totals, proseNoSource: 1 }, files: {} });
  assert.match(t1, /; 1 with no source to check\./);
  // totals saved by an older run have proseUnverified (figures not tied to a checked source): counted as no source to check
  const old = T.chatReport({ prose: '## Verdict\nA.', claims: [], totals: { claims: 3, figures: 10, found: 7, notFound: 2, notOpened: 1, proseFigures: 5, proseVerified: 2, proseUnverified: 3 }, files: {} });
  assert.match(old, /7 found as written; 2 not found as written .*; 1 from sources that could not be opened .*; 3 with no source to check\./);
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
    { id: 'c1', claim: 'Kept one', source_url: 'https://a.example/1', check_status: 'verified', figure_checks: [{ figure: '5', status: 'found_as_written', meaning: 'matches', meaning_quote: 'five items' }] },
    { id: 'c4', claim: 'Edited one', source_url: 'https://a.example/4', check_status: 'verified', figure_checks: [{ figure: '5', status: 'found_as_written', meaning: 'matches', meaning_quote: 'five items' }] },
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
  assert.match(i, /Figures not checked \(the run stopped before the check\); every figure is marked not checked\./);
  assert.ok(!/Figures checked against/.test(i));
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
  // r8: the check did not run, so the figures say "not checked"
  assert.strictEqual(T.markUnverified('Added 56.4% and 300k users in 2024.'), 'Added 56.4% [not checked] and 300k [not checked] users in 2024.');
  assert.strictEqual(T.markUnverified('No figures here.'), 'No figures here.');
  assert.strictEqual(T.markUnverified(T.markUnverified('Got 9.5.')), 'Got 9.5 [not checked].');
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
  assert.strictEqual(r.prose, 'Study A enrolled 1,250 participants (https://a.example/a), while study B enrolled 1,250 [not found in source] participants (https://b.example/b).');
  assert.strictEqual(r.totals.proseNotFound, 1);
  // a clause with no citation of its own, or with two, has no source to check
  const none = T.checkReport({ prose: 'Study A (https://a.example/a) enrolled 1,250 participants, and study B (https://b.example/b) enrolled 800 participants versus 1,250 participants.', claims: R4CLAIMS, fetched: [R4A, R4B] });
  assert.match(none.prose, /versus 1,250 \[no source to check\] participants/);
  assert.match(none.prose, /enrolled 800 participants,? ?/);
  const two = T.checkReport({ prose: 'Both (https://a.example/a and https://b.example/b) enrolled 1,250 participants.', claims: R4CLAIMS, fetched: [R4A, R4B] });
  assert.match(two.prose, /1,250 \[not found in source\]/); // the " and " cuts a clause that cites B only; B says 800
  // one source in the sentence keeps today's rule
  const one = T.checkReport({ prose: 'Study A enrolled 1,250 participants, while others enrolled more (https://a.example/a).', claims: R4CLAIMS, fetched: [R4A, R4B] });
  assert.ok(!/\[/.test(one.prose));
});

test('r4-2 units match exactly, both ways', () => {
  const r = T.checkClaims([{ id: 'c', claim: '125 eligible participants', source_url: 'https://a.example/a', figures: [] }], [{ url: 'https://a.example/a', ok: true, text: 'Enrollment rose by 125% last year.' }]);
  assert.strictEqual(r.claims[0].status, 'not_found_as_written');
  assert.strictEqual(T.checkFigure('125', 'Enrollment rose by 125% last year.', ['eligible', 'participants']), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('56.4', 'agreement 56.4% overall', []), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('56.4%', 'agreement 56.4% overall', []), 'found_as_written');
  assert.strictEqual(T.checkFigure('56.4', '| model | 56.4 |', []), 'found_as_written');
  assert.strictEqual(T.checkFigure('56.4%', '| model | 56.4 |', []), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('2x', 'a 2 ratio', []), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('2x', 'a 2x speedup', ['speedup']), 'found_as_written');
  assert.strictEqual(T.checkFigure('2', 'a 2x speedup', []), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('3pp', 'points up 3 pp', ['points']), 'found_as_written');
  assert.strictEqual(T.checkFigure('3pp', 'up 3%', []), 'not_found_as_written');
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
  assert.strictEqual(T.claimKey({ ...withNum, measured_result: '56.4% against 43.7% [not found in source]', check: 'x', check_status: 'partly_found_as_written' }), T.claimKey(withNum), 'check marks are not content');
  // r8: older runs' marks are not content either
  assert.strictEqual(T.claimKey({ ...withNum, measured_result: '56.4% against 43.7% [unverified]' }), T.claimKey(withNum));
  assert.strictEqual(T.claimKey({ ...withNum, measured_result: '56.4% [source not opened] against 43.7% [no source to check]' }), T.claimKey({ ...withNum, measured_result: '56.4% against 43.7%' }));
});

test('r4-5 parseFigure / numbersIn: prefixes, case-insensitive scale words, ×, bare figure merges with x and pp', () => {
  for (const f of ['~1.5 BILLION'.replace('BILLION', 'million'), '≈ 1.5M', 'about 1.5 MILLION']) {
    // r8: the qualifier is kept (an approximation), it is no longer dropped; the figure also carries its written form
    const p = T.parseFigure(f);
    assert.deepStrictEqual([p.value, p.unit, p.pct, p.qual, p.form], ['1500000', '', false, '~', '||'], f);
  }
  // a currency sign is the figure's unit (r5)
  for (const [f, unit] of [['$1.5 Million', 'USD'], ['€1.5 million', 'EUR'], ['£1.5M', 'GBP']]) {
    const p = T.parseFigure(f);
    assert.deepStrictEqual([p.value, p.unit, p.pct, p.qual], ['1500000', unit, false, ''], f);
  }
  assert.strictEqual(T.parseFigure('about 56.4%').value, '56.4');
  assert.strictEqual(T.parseFigure('about 56.4%').unit, 'pct');
  assert.strictEqual(T.parseFigure('~300k').value, '300000');
  assert.strictEqual(T.checkFigure('$300k', 'cost $300,000.', []), 'found_as_written'); // r9a: "in" is a word of the form now, so no "in all"
  assert.strictEqual(T.checkFigure('300k', 'cost 300,000 dollars', []), 'not_found_as_written'); // r7: "dollars" is a unit of its own
  assert.strictEqual(T.numbersIn('worth 2 BILLION dollars')[0].mag, '2000000000');
  assert.strictEqual(T.numbersIn('worth 2 Billion dollars')[0].mag, '2000000000');
  const x = T.numbersIn('a 3× gain')[0];
  assert.strictEqual(x.unit, 'x');
  assert.strictEqual(T.checkFigure('3x', 'a 3× gain', ['gain']), 'found_as_written');
  const merge = (c, texts) => T.checkClaims([c], [{ url: 'https://a.example/a', ok: true, text: texts }]).claims[0];
  const mx = merge({ id: 'c', claim: 'A 3x faster run', source_url: 'https://a.example/a', figures: ['3'] }, 'it was 3x faster run');
  assert.strictEqual(mx.figures.length, 1);
  assert.strictEqual(mx.status, 'found_as_written');
  const mp = merge({ id: 'c', claim: 'Gained 4.5 pp over base', source_url: 'https://a.example/a', figures: ['4.5'] }, 'the method gained 4.5 pp over base');
  assert.strictEqual(mp.figures.length, 1);
  assert.strictEqual(mp.status, 'found_as_written');
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
    assert.ok(!/1,250 \[[a-z ]+\]/.test(r.prose), a + ' -> ' + r.prose);
  }
  const rows = '| Study | n |\n| --- | --- |\n| Study B (https://b.example/b) | 1,250 |\nStudy A (https://a.example/a) enrolled 1,250 participants.';
  const t = T.checkReport({ prose: rows, claims: R4CLAIMS, fetched: [R4A, R4B] });
  assert.match(t.prose, /\| 1,250 \[not found in source\] \|/);
  assert.match(t.prose, /enrolled 1,250 participants\./);
  assert.ok(!/participants\. \[[a-z ]+\]|1,250 \[[a-z ]+\] participants/.test(t.prose));
});

test('r4-8 chatReport: a failed figure check says so', () => {
  const t = T.chatReport({ prose: '## Verdict\nA.', claims: [{ id: 'c1', claim: 'A' }], notChecked: true, checkError: true, files: {} });
  assert.match(t, /Figures not checked \(the check failed\); every figure is marked not checked\./);
  assert.doesNotMatch(t, /no list of claims/);
});

// ---------------------------------------------------------------- r5
test('r5-1 an explicit citation that resolves to nothing is never borrowed from another source', () => {
  const A = 'https://a.example/a';
  const B = 'https://b.example/b';
  const claims = [{ id: 'c1', claim: 'Study A enrolled participants', source_url: A, figures: ['1,250'] }];
  const fetched = [{ url: A, title: 'Alpha paper', ok: true, text: 'Study A enrolled 1,250 participants.' }];
  const r = T.checkReport({ prose: `Study A enrolled 1,250 participants (${A}). Study B enrolled 1,250 participants (${B}).`, claims, fetched, counts: {} });
  assert.strictEqual(r.totals.proseFound, 1);
  assert.strictEqual(r.totals.proseNoSource, 1);
  assert.match(r.prose, /Study B enrolled 1,250 \[no source to check\]/);
  assert.ok(!/Study A enrolled 1,250 \[/.test(r.prose));
  // a citation to a source that was not fetched is the same
  const nf = T.checkReport({ prose: `Study A enrolled 1,250 participants (${A}), while 1,250 more joined (${B}).`, claims, fetched, counts: {} });
  assert.match(nf.prose, /while 1,250 \[no source to check\] more/);
  // the paragraph fallback applies only when the sentence cites nothing at all
  const fb = T.checkReport({ prose: `Study A (${A}) is the source.\nIt enrolled 1,250 participants.`, claims, fetched, counts: {} });
  assert.strictEqual(fb.marks, 0);
});

test('r5-2 currency is a unit', () => {
  assert.strictEqual(T.checkFigure('€1,250', 'We paid $1,250 in total.'), 'not_found_as_written');
  // r9a: "in" is a word of the form now, so the found cases carry no "in total"
  assert.strictEqual(T.checkFigure('€1,250', 'We paid EUR 1,250.'), 'found_as_written');
  assert.strictEqual(T.checkFigure('EUR 1,250', 'We paid €1,250.'), 'found_as_written');
  assert.strictEqual(T.checkFigure('$4.2B', 'revenue of $4,200,000,000'), 'found_as_written');
  // r8: the aliases hold within one position: "$" in front is "USD" in front, not "USD" after the number
  assert.strictEqual(T.checkFigure('$4.2B', 'revenue of 4.2 billion USD'), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('4.2B USD', 'revenue of 4.2 billion USD'), 'found_as_written');
  assert.strictEqual(T.checkFigure('1,250', 'We paid $1,250 in total.'), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('$1,250', 'We saw 1,250 items.'), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('USD 1,250', 'US$1,250'), 'found_as_written');
  assert.strictEqual(T.checkFigure('1,250 usd', 'US$1,250'), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('£1,250', 'We paid $1,250'), 'not_found_as_written');
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
  assert.strictEqual(r.totals.proseFound, 2);
  // swapped: each figure is bound to its own source, not the other
  const sw = T.checkReport({ prose: `According to A (${A}), accuracy was 60.2%, and according to B (${B}), 56.4%.`, claims, fetched, counts: {} });
  assert.strictEqual(sw.marks, 2);
  assert.strictEqual(sw.totals.proseNotFound, 2);
  // the neighbour has a figure of its own: no inheritance, so 56.4% has no source to check (its clause cites nothing)
  const n = T.checkReport({ prose: `A reached 56.4% on X, 3.2 points above baseline (${A}), while B reached 60.2% (${B})`, claims, fetched, counts: {} });
  assert.match(n.prose, /56\.4% \[no source to check\] on X/);
  assert.ok(!/60\.2% \[[a-z ]+\]/.test(n.prose));
});

test('r5-4 a figures entry with a unit does not absorb a bare number in the claim text (r6: fail-safe)', () => {
  // r6: the r5 merge is reverted: a bare 56.4 in the text is its own figure and is not backed by a source "56.4%"
  const claims = [{ id: 'c1', claim: 'Preference', source_url: 'https://a.example/a', figures: ['56.4%', '43.6%'], measured_result: '56.4 vs 43.6' }];
  const fetched = [{ url: 'https://a.example/a', title: 'T', ok: true, text: 'Preferred 56.4% against 43.6%.' }];
  const res = T.checkClaims(claims, fetched);
  assert.strictEqual(res.claims[0].figures.length, 4);
  assert.deepStrictEqual(res.claims[0].figures.filter((f) => f.status === 'not_found_as_written').map((f) => f.figure).sort(), ['43.6', '56.4']);
  const mr = T.applyCheck(claims, res)[0].measured_result;
  assert.match(mr, /56\.4 \[not found in source\]/);
  assert.match(mr, /43\.6 \[not found in source\]/);
});

test('r6-1 a unit figure does not hide a distinct bare quantity of the same value', () => {
  const claims = [{ id: 'c1', claim: 'Enrollment included 125 participants with 125% growth', source_url: 'https://a.example/a', figures: ['125%'] }];
  const fetched = [{ url: 'https://a.example/a', title: 'T', ok: true, text: 'Enrollment grew by 125%. Growth was 125% overall.' }];
  const res = T.checkClaims(claims, fetched);
  assert.strictEqual(res.claims[0].figures.length, 2);
  assert.strictEqual(res.claims[0].figures.filter((f) => f.status === 'not_found_as_written').map((f) => f.figure).join(), '125');
  assert.strictEqual(res.totals.found, 1);
  assert.strictEqual(res.totals.notFound, 1);
  // a bare figures entry still takes the unit the claim text shows
  const ok = T.checkClaims([{ id: 'c2', claim: 'Growth was 125% overall', source_url: 'https://a.example/a', figures: ['125'] }], fetched);
  assert.strictEqual(ok.claims[0].figures.length, 1);
  assert.strictEqual(ok.claims[0].status, 'found_as_written');
  // a currency figures entry does not back a bare number
  const cur = T.checkClaims([{ id: 'c3', claim: '1,250 respondents', source_url: 'https://a.example/a', figures: ['$1,250'] }], [{ url: 'https://a.example/a', title: 'T', ok: true, text: 'Paid $1,250.' }]); // r9a: "only" is a word of the form now
  assert.strictEqual(cur.claims[0].figures.filter((f) => f.status === 'not_found_as_written').map((f) => f.figure).join(), '1,250');
});

test('r6-2 a sign before or after a currency symbol is part of the figure', () => {
  const cf = (a, b) => T.checkFigure(a, b);
  assert.strictEqual(cf('-$1,250', 'We paid $1,250 in total.'), 'not_found_as_written');
  assert.strictEqual(cf('$-1,250', 'We paid $1,250 in total.'), 'not_found_as_written');
  assert.strictEqual(cf('-$1,250', 'We lost −$1,250.'), 'found_as_written'); // r9a: no "in total" ("in" is a word of the form now)
  assert.strictEqual(cf('-$1,250', 'We lost $-1,250 in total.'), 'not_found_as_written'); // r8: the place of the sign is part of the written form
  assert.strictEqual(cf('-€5M', 'We paid €5M in total.'), 'not_found_as_written');
  assert.strictEqual(cf('$1,250', 'We lost -$1,250 in total.'), 'not_found_as_written');
  assert.strictEqual(T.numbersIn('a -$1,250 b')[0].value, '-1250');
  assert.strictEqual(T.numbersIn('a $-1,250 b')[0].value, '-1250');
});

test('r6-3 letter-prefixed dollar signs and more currency codes', () => {
  const cf = (a, b) => T.checkFigure(a, b);
  assert.strictEqual(cf('US$1,250', 'paid CA$1,250 total'), 'not_found_as_written');
  assert.strictEqual(cf('$1.2 billion', 'raised A$1.2 billion'), 'not_found_as_written');
  assert.strictEqual(cf('A$1.2 billion', 'raised $1.2 billion'), 'not_found_as_written');
  // r8: the next word is part of the written form, so each figure is written with it
  assert.strictEqual(cf('C$5,000 today', 'paid C$5,000 today'), 'found_as_written');
  assert.strictEqual(cf('C$5,000', 'paid C$5,000 today'), 'not_found_as_written');
  assert.strictEqual(cf('C$5,000', 'paid CA$5,000.'), 'not_found_as_written');
  assert.strictEqual(cf('C$5,000', 'paid C$5,000.'), 'found_as_written');
  assert.strictEqual(cf('US$1,250 total', 'paid $1,250 total'), 'found_as_written'); // "US$" = "$" in front of the number
  assert.strictEqual(cf('1,250 CAD', 'paid 1,250 CHF total'), 'not_found_as_written');
  assert.strictEqual(cf('CAD 1,250', 'paid 1,250 CAD total'), 'not_found_as_written'); // a code in front is not the same written form as one after
  assert.strictEqual(cf('CAD 1,250', 'paid CAD 1,250.'), 'found_as_written');
  assert.strictEqual(cf('1,250 CAD', 'paid 1,250 total'), 'not_found_as_written');
  // r8: only the listed aliases are equivalent: "euros" and "US dollars" are not "€" and "$"
  assert.strictEqual(cf('€5,000', 'paid 5,000 euros today'), 'not_found_as_written');
  assert.strictEqual(cf('$5,000', 'paid 5,000 US dollars today'), 'not_found_as_written');
  assert.strictEqual(cf('$5,000', 'paid 5,000 Canadian dollars today'), 'not_found_as_written');
  assert.strictEqual(T.numbersIn('5 euros')[0].unit, 'EUR');
  assert.strictEqual(T.numbersIn('5 US dollars')[0].unit, 'USD');
  assert.strictEqual(T.numbersIn('5 Canadian dollars')[0].unit, 'X$:CANADIAN'); // r7: its own unit, not a bare number
  assert.strictEqual(T.numbersIn('about 1,250 cad and 1,250 chf').map((t) => t.unit).join('|'), '|');
  // a long run of letters before "$" is cut by the lookup window: never read as US dollars
  assert.notStrictEqual(T.numbersIn('xxxxxAUS$5,000').map((t) => t.unit).join(), 'USD');
  assert.strictEqual(cf('$5,000', 'paid xxxxxAUS$5,000 today'), 'not_found_as_written');
  assert.strictEqual(T.numbersIn('paid €5,000 today')[0].unit, 'EUR');
  assert.strictEqual(T.numbersIn('NZ$7').map((t) => t.unit).join(), 'X$:NZ');
});

test('r6-4 the paragraph fallback does not run when the block holds an unresolved explicit citation', () => {
  const A = 'https://a.example/a';
  const B = 'https://b.example/b';
  const claims = [{ id: 'c1', claim: 'Study A enrolled participants', source_url: A, figures: ['900 participants'] }];
  const fetched = [{ url: A, title: 'Alpha paper', ok: true, text: 'Study A enrolled 900 participants in a first wave and 1,250 participants in total.' }];
  const r = T.checkReport({ prose: `Study A enrolled 900 participants (${A}). Study B (${B}) was larger. It enrolled 1,250 participants.`, claims, fetched, counts: {} });
  assert.match(r.prose, /enrolled 900 participants \(/);
  assert.ok(!/900 \[[a-z ]+\]/.test(r.prose));
  assert.match(r.prose, /1,250 \[no source to check\]/);
  const one = T.checkReport({ prose: `Study A enrolled 900 participants (${A}). Study B was larger. It enrolled 1,250 participants.`, claims, fetched, counts: {} });
  assert.strictEqual(one.marks, 0);
});

test('r6-5 "No." is an abbreviation only before a number', () => {
  const A = 'https://a.example/a';
  const B = 'https://b.example/b';
  const claims = [
    { id: 'c1', claim: 'Study A ranking result', source_url: A, figures: ['56.4%'] },
    { id: 'c2', claim: 'Study B result', source_url: B, figures: ['60.2%'] },
  ];
  const fetched = [
    { url: A, title: 'Alpha paper', ok: true, text: 'Result No. 5 was 56.4% in the ranking.' }, // r9a: "in" is a word of the form now: the 5 is followed by "was", as in the report
    { url: B, title: 'Beta paper', ok: true, text: 'Result was 60.2%.' },
  ];
  const r = T.checkReport({ prose: `Result No. 5 was 56.4% (${A}). No. Study B reached 60.2% (${B}).`, claims, fetched, counts: {} });
  assert.strictEqual(r.marks, 0);
  assert.strictEqual(r.totals.proseFound, 3); // 5, 56.4%, 60.2%
  // a sentence ending in "No." ends there: the next sentence's figure is judged by its own citation only
  const C = 'https://c.example/c';
  const s = T.checkReport({ prose: `Study C (${C}) said No. Study A ranking was 56.4% (${A}).`, claims, fetched, counts: {} });
  assert.strictEqual(s.marks, 0);
});

test('r5-5 units: percentage points, -fold, times; No. only when capitalised', () => {
  const u = (s) => T.numbersIn(s).map((t) => t.unit);
  assert.deepStrictEqual(u('up 3.2 percentage points and 2 percentage point, 4 pp'), ['pp', 'pp', 'pp']);
  assert.deepStrictEqual(u('a 3-fold gain, 2.5 times faster, 4x'), ['x', 'x', 'x']);
  assert.strictEqual(T.checkFigure('3.2 pp', 'rose 3.2 percentage points in total', ['rose']), 'found_as_written');
  assert.strictEqual(T.checkFigure('3x', 'a 3-fold improvement', ['improvement']), 'found_as_written');
  assert.strictEqual(T.checkFigure('3x', 'three runs, 3 times as large', ['large']), 'found_as_written');
  assert.strictEqual(T.checkFigure('3.2', 'rose 3.2 percentage points', ['rose']), 'not_found_as_written');
  const s = (t) => T.checkReport({ prose: t, claims: [] }).prose;
  assert.strictEqual(s('Ranked No. 1,250 of all.'), 'Ranked No. 1,250 [not checked] of all.'); // r8: no check ran (claims: []): "not checked"
  // "no." ends a sentence: a figure after it is in a new sentence
  const A = 'https://a.example/a';
  const claims = [{ id: 'c1', claim: 'Study A enrolled participants', source_url: A, figures: ['1,250 participants'] }];
  const fetched = [{ url: A, title: 'Alpha paper', ok: true, text: 'enrolled 1,250 participants' }];
  // (the second sentence cites an unfetched B; if "no." did not split, B would taint the 1,250)
  const low = T.checkReport({ prose: `It enrolled 1,250 participants (${A}) was it no. And more were seen (https://b.example/b).`, claims, fetched, counts: {} });
  assert.strictEqual(low.marks, 0);
  // r6: capitalised "No." is an abbreviation only before a number, so "No. 5" is used here
  const cap = T.checkReport({ prose: `It enrolled 1,250 participants (${A}) was it No. 5 and more were seen (https://b.example/b).`, claims, fetched, counts: {} });
  // (the 5 itself is a figure too, so check that the 1,250 is the one tainted by B)
  assert.match(cap.prose, /1,250 \[no source to check\]/);
});

// ---------------------------------------------------------------- r7
const cf7 = (fig, src, kws) => T.checkFigure(fig, src, kws || []);

test('r7-1 a currency symbol together with a currency code', () => {
  assert.strictEqual(cf7('$1,250 CAD', 'paid $1,250 USD'), 'not_found_as_written');
  assert.strictEqual(cf7('$1,250 CAD', 'paid US$1,250'), 'not_found_as_written');
  // r8: the written form (what is directly before and after the number) has to be the same, not just the currency
  assert.strictEqual(cf7('$1,250 CAD', 'paid 1,250 CAD'), 'not_found_as_written');
  assert.strictEqual(cf7('$1,250 CAD', 'paid $1,250 CAD.'), 'found_as_written');
  assert.strictEqual(cf7('CAD $1,250', 'paid $1,250 CAD'), 'not_found_as_written');
  assert.strictEqual(cf7('CAD $1,250', 'paid CAD $1,250.'), 'found_as_written');
  assert.strictEqual(cf7('AUD $5 billion', 'raised $5 billion'), 'not_found_as_written');
  assert.strictEqual(cf7('$5 billion AUD', 'raised AUD $5 billion'), 'not_found_as_written');
  assert.strictEqual(cf7('$5 billion AUD', 'raised $5 billion AUD.'), 'found_as_written');
  assert.strictEqual(cf7('USD $5,000', 'paid $5,000'), 'found_as_written'); // the run directly before the number is "$" and the unit is USD in both
  assert.strictEqual(cf7('USD $5,000', 'paid USD $5,000.'), 'found_as_written');
  assert.strictEqual(cf7('€5,000 USD', 'paid €5,000'), 'not_found_as_written');
  assert.strictEqual(cf7('€5,000 EUR', 'paid €5,000'), 'not_found_as_written');
  assert.strictEqual(cf7('€5,000 EUR', 'paid €5,000 EUR.'), 'found_as_written');
  assert.strictEqual(cf7('€5,000 USD', 'paid €5,000 USD'), 'found_as_written'); // the identical unknown form
  const unit = (t) => T.numbersIn(t)[0].unit;
  assert.strictEqual(unit('$1,250 CAD'), 'CAD');
  assert.strictEqual(unit('CAD $1,250'), 'CAD');
  assert.strictEqual(unit('CAD$1,250'), 'CAD');
  assert.strictEqual(unit('USD $5'), 'USD');
  assert.strictEqual(unit('$5 billion AUD'), 'AUD');
  assert.strictEqual(T.numbersIn('$5 billion AUD')[0].mag, '5000000000');
  assert.strictEqual(unit('€5,000 USD'), 'X?:€ USD');
  assert.strictEqual(unit('US$5 CAD'), 'X?:US$ CAD');
});

test('r7-2 number forms: leading-dot decimals, exponents, powers', () => {
  assert.strictEqual(cf7('.125', 'a value of 125'), 'not_found_as_written');
  assert.strictEqual(cf7('.125', 'a value of 0.125'), 'found_as_written');
  assert.strictEqual(cf7('-.5', 'a change of -0.5', ['change']), 'found_as_written');
  assert.strictEqual(cf7('0.125', 'a value of 0.125e-3'), 'not_found_as_written');
  assert.strictEqual(cf7('0.125e-3', 'a value of 0.000125'), 'found_as_written');
  assert.strictEqual(cf7('1.5E6', '1,500,000'), 'found_as_written');
  assert.strictEqual(cf7('1.5E6', 'about 1,500,000 users'), 'not_found_as_written'); // r8: "about" and "users" are part of the written form
  assert.strictEqual(cf7('about 1.5E6 users', 'about 1,500,000 users'), 'found_as_written');
  assert.strictEqual(cf7('about 2e+3 users', 'about 2,000 users'), 'found_as_written');
  // a common value (one significant digit) still needs a keyword near it, however it was written
  assert.strictEqual(cf7('1e−4', 'a rate of 0.0001', ['rate']), 'found_as_written');
  assert.strictEqual(cf7('1e−4', 'a rate of 0.0001'), 'not_found_as_written');
  assert.strictEqual(cf7('1e0', 'chapter 1 of the book'), 'not_found_as_written');
  assert.strictEqual(cf7('1.25 × 10^-3', 'a value of 0.00125'), 'found_as_written');
  assert.strictEqual(cf7('1.25 × 10⁻³', 'a value of 0.00125'), 'found_as_written');
  assert.strictEqual(cf7('1.25x10^-3', 'a value of 0.00125'), 'found_as_written');
  assert.strictEqual(cf7('1.25 · 10^-3', 'a value of 0.00125'), 'found_as_written');
  assert.strictEqual(cf7('1.25 * 10^-3', 'a value of 0.00125'), 'found_as_written');
  assert.strictEqual(cf7('1.25 ×10³', 'a value of 1,250'), 'found_as_written');
  assert.strictEqual(cf7('10^-3', 'about 10 times'), 'not_found_as_written');
  assert.strictEqual(cf7('10^-3', 'a value of 0.001', ['value']), 'found_as_written');
  assert.strictEqual(cf7('about 10⁶ users', 'about 1,000,000 users'), 'found_as_written');
  assert.strictEqual(cf7('2^10', 'about 2 units'), 'not_found_as_written');
  assert.strictEqual(cf7('2^10', 'a size of 2^10'), 'found_as_written');
  assert.strictEqual(cf7('2^10', 'a size of 2^8'), 'not_found_as_written');
  // a letter after the exponent: not E-notation
  assert.strictEqual(T.numbersIn('1e3x')[0].mag, '1');
  assert.deepStrictEqual(T.numbersIn('the score was .87 overall').map((t) => t.value), ['0.87']);
  assert.strictEqual(T.numbersIn('the score was .87 overall').length, 1);
  assert.strictEqual(T.numbersIn('10^-3').length, 1);
  assert.strictEqual(T.numbersIn('x 1.25 × 10^-3 y').length, 1);
  // no dot-decimal after a digit, a letter or a dot: "3.2.1" and "v.5" keep their old tokens
  assert.deepStrictEqual(T.numbersIn('3.2.1').map((t) => t.value), ['3.2', '1']);
  assert.deepStrictEqual(T.numbersIn('v.5').map((t) => t.value), ['5']);
});

test('r7-3 measurement units and currency words', () => {
  assert.strictEqual(cf7('1250 ms', 'it took 1250 seconds'), 'not_found_as_written');
  assert.strictEqual(cf7('1250 ms', 'it took 1250 milliseconds'), 'found_as_written');
  assert.strictEqual(cf7('1250 ms', 'it took 1.25 seconds'), 'not_found_as_written');
  assert.strictEqual(cf7('1250 ms', 'it took 1250'), 'not_found_as_written');
  assert.strictEqual(cf7('1250', 'it took 1250 ms'), 'not_found_as_written');
  assert.strictEqual(cf7('1250 ms', 'it took 1250 MS'), 'not_found_as_written');
  // r8: an attached unit ("1250ms": post) is not the same written form as a spaced one ("1250 ms": next word)
  assert.strictEqual(cf7('1250 ms', 'it took 1250ms'), 'not_found_as_written');
  assert.strictEqual(cf7('1250ms', 'it took 1250ms.'), 'found_as_written');
  assert.strictEqual(cf7('5 GB', 'a size of 5 GiB'), 'not_found_as_written');
  assert.strictEqual(cf7('5 GB', 'a size of 5 gb'), 'not_found_as_written');
  assert.strictEqual(cf7('16 GB', 'a size of 16GB', ['size']), 'not_found_as_written');
  assert.strictEqual(cf7('16GB', 'a size of 16GB', ['size']), 'found_as_written');
  assert.strictEqual(cf7('3 GHz', 'a clock of 3 GHz', ['clock']), 'found_as_written');
  assert.strictEqual(cf7('3 GHz', 'a clock of 3 MHz'), 'not_found_as_written');
  assert.strictEqual(cf7('5 million tonnes', 'a mass of 5,000,000 tonnes'), 'found_as_written');
  assert.strictEqual(cf7('5 million tonnes', 'a mass of 5,000,000'), 'not_found_as_written');
  assert.strictEqual(cf7('25 °C', 'a temperature of 25°C', ['temperature']), 'not_found_as_written'); // r8: attached vs spaced
  assert.strictEqual(cf7('25°C', 'a temperature of 25°C', ['temperature']), 'found_as_written');
  assert.strictEqual(cf7('25 °C', 'a temperature of 25 °F', ['temperature']), 'not_found_as_written');
  assert.strictEqual(cf7('5 km', 'a speed of 5 km/h'), 'not_found_as_written');
  const one = (t) => T.numbersIn(t)[0];
  assert.strictEqual(one('in the 1990s').value, '1990');
  assert.strictEqual(one('in the 1990s').unit, '');
  assert.strictEqual(one('after 5 s').unit, 'u:s');
  assert.strictEqual(one('after 5 seconds').unit, 'u:s');
  assert.strictEqual(one('after 3 mi').unit, 'u:mile');
  assert.strictEqual(one('after 3mi').unit, '');
  assert.strictEqual(one('after 5 h').unit, 'u:h');
  assert.strictEqual(one('after 5h').unit, '');
  assert.strictEqual(one('5 million tonnes').mag, '5000000');
  assert.strictEqual(one('5 million tonnes').unit, 'u:tonne');
  assert.strictEqual(one('5k ms').unit, '');
  // a count noun stays bare
  assert.strictEqual(one('1,250 participants').unit, '');
  assert.strictEqual(cf7('1,250 participants', 'we had 1,250 participants'), 'found_as_written');
  assert.strictEqual(cf7('1,250', 'we had 1,250 participants'), 'not_found_as_written'); // r8: the next word is part of the form
  // currency words
  assert.strictEqual(cf7('$5,000', 'paid 5,000 Canadian dollars'), 'not_found_as_written');
  assert.strictEqual(cf7('5,000 Canadian dollars', 'paid 5,000 participants'), 'not_found_as_written');
  assert.strictEqual(cf7('5,000 Canadian dollars', 'paid CA$5,000'), 'not_found_as_written');
  assert.strictEqual(cf7('5,000 Canadian dollars', 'paid 5,000 Canadian dollars'), 'found_as_written');
  assert.strictEqual(cf7('5,000 dollars', 'paid $5,000'), 'not_found_as_written');
  assert.strictEqual(cf7('5,000 dollars', 'paid 5,000 dollars'), 'found_as_written');
  // r8: only the listed aliases are equivalent: "¥" is not "yen", "Rs" is not "rupees", "yuan" is not "RMB"
  assert.strictEqual(cf7('¥5,000', 'paid 5,000 yen'), 'not_found_as_written');
  assert.strictEqual(cf7('¥5,000', 'paid ¥5,000.'), 'found_as_written');
  assert.strictEqual(cf7('₩5,000', 'paid 5,000'), 'not_found_as_written');
  assert.strictEqual(cf7('Rs 5,000', 'paid 5,000 rupees'), 'not_found_as_written');
  assert.strictEqual(cf7('Rs. 5,000', 'paid 5,000 rupee'), 'not_found_as_written');
  assert.strictEqual(cf7('5,000 rupees', 'paid 5,000 rupee'), 'found_as_written'); // a plural "s" is dropped from words of 5+ letters
  assert.strictEqual(cf7('5,000 yuan', 'paid 5,000 RMB'), 'not_found_as_written');
  assert.strictEqual(one('5 Hong Kong dollars').unit, 'X$:KONG');
  assert.strictEqual(one('5 dollars').unit, 'X$:?');
  assert.strictEqual(one('5 pounds sterling').unit, 'w:pound');
  assert.deepStrictEqual(['₩5', '₽5', '₺5', '₪5', '฿5', '₦5'].map((t) => one(t).unit), ['KRW', 'RUB', 'TRY', 'ILS', 'THB', 'NGN']);
  assert.strictEqual(one('5 million Canadian dollars').mag, '5000000');
});

test('r7-4 a figure written as more than one number', () => {
  const kw = ['rate'];
  assert.strictEqual(cf7('5–10%', 'about 5 people and 10 others'), 'not_found_as_written');
  assert.strictEqual(cf7('5–10%', 'the rate was between 5% and 10%', kw), 'not_found_as_written'); // r8: not joined: not one run
  assert.strictEqual(cf7('5–10%', 'the rate was 5–10% overall', kw), 'found_as_written');
  assert.strictEqual(cf7('5-10%', 'the rate was 5%–10% overall', kw), 'found_as_written');
  assert.strictEqual(cf7('5 to 10%', 'the rate was 5–10% overall', kw), 'found_as_written');
  assert.strictEqual(cf7('5–10%', 'the rate was 10% then 5%', kw), 'not_found_as_written');
  assert.strictEqual(cf7('5–10%', 'the rate was 5% and 11%', kw), 'not_found_as_written');
  assert.strictEqual(cf7('1/8', 'the rate is 1 of 8', kw), 'not_found_as_written'); // r8: "1 of 8" is not "1/8"
  assert.strictEqual(cf7('1/8', 'the rate is 1 ' + 'x'.repeat(60) + ' of 8', kw), 'not_found_as_written');
  assert.strictEqual(cf7('1/8', 'the rate is 8 of 1', kw), 'not_found_as_written');
  assert.strictEqual(cf7('3:1', 'the rate is 3 runs', kw), 'not_found_as_written');
  assert.strictEqual(cf7('3:1', 'the rate is 3:1', kw), 'found_as_written');
  // the common-number keyword rule applies to the first part
  assert.strictEqual(cf7('1/8', 'a split of 1 of 8'), 'not_found_as_written');
  assert.strictEqual(cf7('1,250/8,400', 'a split of 1,250 of 8,400'), 'not_found_as_written');
  assert.strictEqual(cf7('1,250/8,400', 'a split of 1,250/8,400.'), 'found_as_written');
  // parseFigure and the claim list: one figure, its parts are not added again from the claim text
  const p = T.parseFigure('5–10%');
  assert.deepStrictEqual(p.parts, [{ value: '5', unit: 'pct' }, { value: '10', unit: 'pct' }]);
  assert.strictEqual(T.parseFigure('1.25 × 10^-3').parts, undefined); // one token, not compound
  const claims = [{ id: 'c1', claim: 'The rate was 5–10% in the cohort', source_url: 'https://a.example/a', figures: ['5–10%'], measured_result: 'rate 5–10%' }];
  const fetched = [{ url: 'https://a.example/a', title: 'T', ok: true, text: 'The rate was 5% to 10% in the cohort.' }];
  const res = T.checkClaims(claims, fetched);
  assert.strictEqual(res.claims[0].figures.length, 1);
  assert.strictEqual(res.claims[0].status, 'found_as_written'); // r8: "5% to 10%" is the same run with the unit at the end
  const bad = T.checkClaims(claims, [{ url: 'https://a.example/a', title: 'T', ok: true, text: 'The rate was 5 people and 10 others in the cohort.' }]);
  assert.strictEqual(bad.claims[0].figures.length, 1);
  assert.strictEqual(bad.claims[0].status, 'not_found_as_written');
  assert.match(T.applyCheck(claims, bad)[0].measured_result, /rate 5–10% \[not found in source\]/);
});

test('r7-5 a currency code glued to the digits is a figure', () => {
  const A = 'https://a.example/a';
  const claims = [{ id: 'c1', claim: 'Revenue was reported', source_url: A, figures: ['USD 1,250'] }];
  const ok = T.checkReport({ prose: `Revenue was USD1,250 (${A}).`, claims, fetched: [{ url: A, title: 'T', ok: true, text: 'revenue was USD 1,250' }], counts: {} });
  assert.strictEqual(ok.marks, 0);
  assert.strictEqual(ok.totals.proseFound, 1);
  const no = T.checkReport({ prose: `Revenue was USD1,250 (${A}).`, claims, fetched: [{ url: A, title: 'T', ok: true, text: 'revenue was 1,250' }], counts: {} });
  assert.match(no.prose, /USD1,250 \[not found in source\]/);
  // r8: markUnverified means the check did not run: "not checked"
  assert.strictEqual(T.markUnverified('It cost EUR5 and CAD5 and eur5.'), 'It cost EUR5 [not checked] and CAD5 [not checked] and eur5 [not checked].');
  assert.strictEqual(T.markUnverified('It cost A$5.'), 'It cost A$5 [not checked].');
  // names and versions stay exempt
  assert.strictEqual(T.markUnverified('Use GPT-4 and Llama3 and v2 and ABCUSD5.'), 'Use GPT-4 and Llama3 and v2 and ABCUSD5.');
});

// ================================================================ r8: the check compares the written form
// judge(figure, source): the whole check on one figure: the claim's figure against the fetched source text, and the same figure in the
// report text. The final claim status and the mark in the text have to agree; returns 'found' or 'not found'.
const R8A = 'https://a.example/a';
function judge(fig, src) {
  const claims = [{ id: 'c1', claim: 'Reported measurement', source_url: R8A, figures: [fig] }];
  const fetched = [{ url: R8A, title: 'Paper', ok: true, text: 'Reported measurement: ' + src }];
  const rep = T.checkReport({ prose: `The reported measurement was ${fig} (${R8A}).`, claims, fetched });
  const status = rep.claims[0].check_status;
  const marked = /\[not found in source\]/.test(rep.prose);
  // an entry with several numbers ("1250 ± 50") gives one figure per number: each is checked as written
  assert.ok(rep.claims[0].figure_checks.length >= 1, fig);
  assert.strictEqual(status === 'found_as_written', !marked, `${fig} vs ${src}: status ${status}, text ${rep.prose}`);
  assert.ok(!/\[(?:source not opened|no source to check)\]/.test(rep.prose), rep.prose);
  return status === 'found_as_written' ? 'found' : 'not found';
}

test('r8-1 round-7 false finds are not found as written (final status and mark)', () => {
  const NB = ' ';
  const pairs = [
    ['1/8', 'a ratio of 1 to 8.'],
    ['5–10 million', 'a count of 5 participants and 10000000 participants.'],
    ['1250 mL', 'a volume of 1250 gallons.'],
    ['1250', 'a count of 1250 basis points.'],
    ['1250', 'a count of 1250‰.'],
    ['1250 meters', 'a distance of 1250 meters per second.'],
    ['1250 MB', 'a rate of 1250 MB s⁻¹.'],
    ['250', `a count of 1${NB}250.`],
    ['1250', 'a count of 1250e-3ms.'],
    ['1250', 'a count of 1250 trillion.'],
    ['1250', 'a change of − 1250.'],
    ['$1250', 'a cost of ($1250).'],
    ['$1250', 'a cost of $1250 Canadian dollars.'],
    ['$1250', 'a cost of 1250 USD per month.'],
    ['1250', 'see https://example.org/paper/1250 for the paper.'],
    ['1250', 'see [the paper](https://example.org/paper/1250) for details.'],
    ['1250', 'a device ABC1250 was used.'],
    ['1250', 'a limit of ≤1250.'],
    ['1250', 'a limit of less than 1250.'],
    ['$500', 'a price of $500 pesos.'],
    ['$100', 'a price of $100 Australian dollars.'],
    ['128-GB', 'a size of 128-MB.'],
    ['50 MB per second', 'a rate of 50 MB.'],
    ['500 mL', 'a volume of 500 L.'],
    ['5,000 ppm', 'a level of 5,000 ppb.'],
    ['3%', 'In Phase 3 - 45% of cases.'],
    ['2%', 'In Phase 2 - 30% of cases.'],
  ];
  for (const [fig, src] of pairs) assert.strictEqual(judge(fig, src), 'not found', `${fig} vs ${src}`);
  // the same figure written the same way is found
  for (const [fig, src] of [['1250 mL', 'a volume of 1250 mL.'], ['$1250', 'a cost of $1250.'], ['128-GB', 'a size of 128-GB.'], ['50 MB per second', 'a rate of 50 MB per second.'], ['1250 meters', 'a distance of 1250 meters.']]) assert.strictEqual(judge(fig, src), 'found', `${fig} vs ${src}`);
  // the number reading itself
  assert.strictEqual(T.numbersIn(`1${NB}250`)[0].mag, '1250');
  assert.strictEqual(T.numbersIn(`1${NB}250`).length, 1);
  assert.strictEqual(T.numbersIn('1250 trillion')[0].mag, '1250000000000000');
  assert.strictEqual(T.numbersIn('1.5 tn')[0].mag, '1500000000000');
  // "Phase 2 - 30%": the 2 is not a percentage; no compound across a spaced dash
  const ph = T.numbersIn('Phase 2 - 30% and Phase 3 - 45%');
  assert.deepStrictEqual(ph.map((t) => [t.mag, t.unit]), [['2', ''], ['30', 'pct'], ['3', ''], ['45', 'pct']]);
  assert.strictEqual(T.figuresInProse('Phase 2 - 30% of cases').length, 2);
});

test('r8-2 links and markup are not source text: numbers inside URLs and link destinations do not count', () => {
  // a URL / a markdown link destination is blanked before indexing; the link text stays
  assert.strictEqual(T.checkFigure('1250', 'see https://example.org/paper/1250'), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('1250', 'see www.example.org/p/1250 now'), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('1250', 'see [the paper](https://example.org/x/1250)'), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('1250', 'see [the paper](paper-1250.html)'), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('1250', 'see [1250](https://example.org/x) and more'), 'found_as_written'); // the link text stays
  assert.strictEqual(judge('$1250', 'the price [$1250](https://example.org/p/1250).'), 'found');
  // offsets stay valid for the other numbers in the text
  const text = 'a https://example.org/1250/x b 4,200 c';
  assert.strictEqual(T.checkFigure('4,200', text), 'not_found_as_written'); // "4,200 c": the word "c" is part of its form
  assert.strictEqual(T.checkFigure('4,200 c', text), 'found_as_written');
  // numbers inside URLs stay exempt in the report text
  assert.deepStrictEqual(T.figuresInProse('See https://a.example/p/45 and [x](https://a.example/q/12).').map((t) => t.raw), []);
});

test('r8-3 still found: same number written the same way (aliases, qualifiers, function words)', () => {
  const found = [
    ['56.4%', '56.4 percent.'], ['56.4%', 'an accuracy of 56.4% on MMLU.'], ['56.4 percent', '56.4%.'], ['56.4%', '56.4 per cent.'],
    ['1,250 participants', '1,250 participants were enrolled.'],
    ['300k', '300,000.'], ['300,000', '300k.'],
    ['$4.2B', '$4.2 billion.'], ['$4.2 billion', '$4.2B.'],
    ['1250 ms', '1250 milliseconds.'], ['1250 milliseconds', '1250 ms.'],
    ['about 1,250', '1,250.'], ['about 1,250', 'about 1,250.'], ['~1,250', 'roughly 1,250.'],
    ['3x', '3-fold.'], ['3x', '3 times.'], ['3-fold', '3x.'], ['3 times', '3×.'], ['3×', '3x.'],
    ['12.5 pp', '12.5 percentage points.'], ['12.5 percentage points', '12.5 pp.'], ['12.5 pp', '12.5 percentage point.'],
    ['1.5E6', '1,500,000.'], ['1,500,000', '1.5E6.'],
    ['5–10%', '5%–10%.'], ['5%–10%', '5–10%.'], ['5–10%', '5 to 10%.'], ['5 to 10%', '5–10%.'], ['5-10%', '5—10%.'],
    ['1,250 in total', '1,250 in all.'], // "in" is a function word: no part of the form
  ];
  for (const [fig, src] of found) assert.strictEqual(judge(fig, src), 'found', `${fig} vs ${src}`);
  // "overall" is not a function word: it is part of the form
  assert.strictEqual(judge('1,250 in total', '1,250 overall.'), 'not found');
  assert.strictEqual(judge('1,250 overall', '1,250 overall.'), 'found');
  assert.strictEqual(judge('1,250', '1,250 overall.'), 'not found');
});

test('r8-4 aliases hold both ways, each with a near miss', () => {
  const same = (a, b) => { assert.strictEqual(judge(a, b + '.'), 'found', `${a} vs ${b}`); assert.strictEqual(judge(b, a + '.'), 'found', `${b} vs ${a}`); };
  const diff = (a, b) => { assert.strictEqual(judge(a, b + '.'), 'not found', `${a} vs ${b}`); assert.strictEqual(judge(b, a + '.'), 'not found', `${b} vs ${a}`); };
  // % = percent = per cent
  same('56.4%', '56.4 percent'); same('56.4%', '56.4 per cent'); diff('56.4%', '56.4 pct');
  // $ = US$ = USD
  same('$5,000', 'US$5,000'); same('$5,000', 'USD 5,000'); same('US$5,000', 'USD 5,000'); diff('US$5,000', 'CA$5,000'); diff('$5,000', 'A$5,000');
  // € = EUR, £ = GBP
  same('€5,000', 'EUR 5,000'); diff('€5,000', '£5,000'); same('£5,000', 'GBP 5,000'); diff('£5,000', 'GBP 5,000 USD');
  // x = × = times = -fold
  same('3x', '3×'); same('3x', '3 times'); same('3x', '3-fold'); same('3×', '3-fold'); diff('3x', '3 pp'); diff('3x', '3 percent');
  // pp = percentage points = percentage point
  same('12.5 pp', '12.5 percentage points'); same('12.5 pp', '12.5 percentage point'); diff('12.5 pp', '12.5%'); diff('12.5 pp', '12.5 points');
  // ms = millisecond(s); s = sec = second(s); min = minute(s); h = hr = hour(s)
  same('1250 ms', '1250 milliseconds'); same('1250 ms', '1250 millisecond'); diff('1250 ms', '1250 s'); diff('1250 ms', '1250 seconds');
  same('30 s', '30 seconds'); same('30 s', '30 sec'); same('30 sec', '30 second'); diff('30 s', '30 ms'); diff('30 s', '30 min');
  same('45 min', '45 minutes'); diff('45 min', '45 months'); diff('45 min', '45 s');
  same('3 h', '3 hours'); same('3 h', '3 hr'); same('3 hr', '3 hour'); diff('3 h', '3 days'); diff('3 h', '3 ms');
  // - = − (minus)
  same('-5.5', '−5.5'); diff('-5.5', '5.5'); diff('-5.5', '+5.5');
  // thousands separators, k / thousand, M / million / m, B / bn / billion, tn / trillion, E-notation and × 10^n: equivalent through the magnitude
  same('1,250,000', '1250000'); same('300k', '300 thousand'); same('1.5M', '1.5 million'); diff('1.5m', '1.5 million') /* r9a: a lower-case m touching the number is no million (fail-safe) */; same('2.5B', '2.5 bn'); same('2.5 billion', '2.5bn');
  same('1.25 tn', '1.25 trillion'); same('1.25E6', '1,250,000'); same('1.25 × 10^6', '1,250,000'); diff('1.25 tn', '1.25 billion');
  // nothing else is equivalent
  diff('1,250 participants', '1,250 people'); diff('5 MB', '5 MiB'); diff('5 ton', '5 tonne'); diff('5 kg', '5 kilogram');
});

test('r8-5 qualifiers: approximation words one way, bounds equal on both sides', () => {
  // a figure with an approximation qualifier matches a source with the same number and none, or the same one; not the other way round
  assert.strictEqual(judge('about 1,250', '1,250.'), 'found');
  assert.strictEqual(judge('around 1,250', 'approximately 1,250.'), 'found');
  assert.strictEqual(judge('1,250', 'about 1,250.'), 'not found');
  assert.strictEqual(judge('≈1,250', 'nearly 1,250.'), 'found');
  assert.strictEqual(judge('1,250', '~1,250.'), 'not found');
  // bounds: equal on both sides ("at most" is ≤, "at least" is ≥, "up to" is ≤, "more than" is >, "less than" is <, <= is ≤)
  assert.strictEqual(judge('at most 1,250', '≤1,250.'), 'found');
  assert.strictEqual(judge('<=1,250', 'up to 1,250.'), 'found');
  assert.strictEqual(judge('at least 1,250', '>=1,250.'), 'found');
  assert.strictEqual(judge('more than 1,250', '>1,250.'), 'found');
  assert.strictEqual(judge('over 1,250', 'above 1,250.'), 'found');
  assert.strictEqual(judge('less than 1,250', 'under 1,250.'), 'found');
  assert.strictEqual(judge('fewer than 1,250', '< 1,250.'), 'found');
  assert.strictEqual(judge('over 1,250', 'under 1,250.'), 'not found');
  assert.strictEqual(judge('at least 1,250', 'more than 1,250.'), 'not found');
  assert.strictEqual(judge('about 1,250', 'over 1,250.'), 'not found');
  assert.strictEqual(judge('over 1,250', '1,250.'), 'not found');
  assert.strictEqual(judge('over 1,250', 'about 1,250.'), 'not found');
});

test('r8-6 compound figures are one run', () => {
  assert.strictEqual(judge('5–10%', 'a range of 5–10%.'), 'found');
  assert.strictEqual(judge('5–10%', 'a range of 5 – 10%.'), 'not found'); // a spaced dash is not one run
  assert.strictEqual(judge('1/8', 'a ratio of 1/8.'), 'found');
  assert.strictEqual(judge('1/8', 'a ratio of 1:8.'), 'not found'); // / and : are their own classes
  assert.strictEqual(judge('3:1', 'a ratio of 3:1.'), 'found');
  assert.strictEqual(judge('5–10 ms', 'a range of 5-10 ms.'), 'found'); // - – — are one class
  assert.strictEqual(judge('5–10 ms', 'a range of 5-10 s.'), 'not found');
  assert.strictEqual(judge('5–10 million', 'a range of 5–10 million.'), 'found');
  // no 40-character chain: the numbers have to be written as one run
  assert.strictEqual(T.checkFigure('1/8', 'the rate is 1 of 8', ['rate']), 'not_found_as_written');
  // the parts are not checked separately, in the claim list or in the report text
  const p = T.parseFigure('5–10%');
  assert.deepStrictEqual(p.parts, [{ value: '5', unit: 'pct' }, { value: '10', unit: 'pct' }]);
  assert.strictEqual(T.figuresInProse('A rate of 5–10% and 1/8.').length, 2);
  const r = T.checkReport({ prose: `A rate of 5–10% (${R8A}).`, claims: [{ id: 'c1', claim: 'Rate', source_url: R8A, figures: ['5–10%'] }], fetched: [{ url: R8A, title: 'P', ok: true, text: 'the rate was 5% and later 10%' }] });
  assert.strictEqual(r.prose, `A rate of 5–10% [not found in source] (${R8A}).`);
  assert.strictEqual(r.totals.proseFigures, 1);
  // strings that merely hold two numbers are not compound: the first number with its form
  assert.deepStrictEqual(T.parseFigure('85.2% (±1.3)').parts, undefined);
  assert.strictEqual(T.parseFigure('85.2% (±1.3)').value, '85.2');
  assert.strictEqual(T.checkFigure('85.2% (±1.3)', 'the score was 85.2% on test'), 'found_as_written');
  assert.strictEqual(T.checkFigure('$5.2B (2023)', 'revenue of $5.2 billion last year'), 'not_found_as_written'); // "last" is a word of the source's form
  // r9a: a token in parentheses after a plain number is part of the form (as written, without its brackets)
  assert.strictEqual(T.checkFigure('$5.2B (2023)', 'revenue of $5.2 billion.'), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('$5.2B (2023)', 'revenue of $5.2 billion (2023).'), 'found_as_written');
});

test('r8-7 three states with their labels: summary line, marks, document section', () => {
  const A = 'https://a.example/1';
  const B = 'https://b.example/2';
  const C = 'https://c.example/3';
  const fetched = [
    { url: A, title: 'Alpha study', ok: true, text: 'Alpha enrolled 1,250 participants.' },
    { url: B, title: 'Beta study', ok: true, text: 'Beta enrolled 800 participants.' },
    { url: C, title: 'Gamma study', ok: false, text: '', error: 'blocked' },
  ];
  const claims = [
    { id: 'c1', claim: 'Alpha enrolled', source_url: A, figures: ['1,250 participants'] },
    { id: 'c2', claim: 'Beta enrolled', source_url: B, figures: ['900 participants'] },
    { id: 'c3', claim: 'Gamma enrolled', source_url: C, figures: ['77 widgets'] },
    { id: 'c4', claim: 'Delta enrolled', source_url: '', figures: ['55 things'] },
  ];
  const r = T.checkReport({ prose: '## Verdict\nSomething was found.', claims, fetched });
  assert.deepStrictEqual(r.claims.map((c) => c.check_status), ['found_as_written', 'not_found_as_written', 'source_not_opened', 'no_source']);
  assert.deepStrictEqual(r.claims.map((c) => c.check), ['1 of 1 found as written', '0 of 1 found as written', 'source not opened', 'no source to check']);
  assert.deepStrictEqual([r.totals.found, r.totals.notFound, r.totals.notOpened, r.totals.noSource], [1, 1, 1, 1]);
  const line = T.chatReport({ prose: r.prose, claims: r.claims, totals: r.totals, files: {} }).split('\n').find((l) => /^In the source/.test(l)); // r9b: renamed line
  assert.strictEqual(line, 'In the source (checked by code against the fetched text): 1 found as written; 1 not found as written (marked "not found in source"); 1 from sources that could not be opened (marked "source not opened"); 1 with no source to check.');
  // prose figures are counted too, with the three marks
  const prose = `Alpha had 1,250 participants (${A}). Beta had 900 participants (${B}). Gamma had 77 widgets (${C}).\n\nDelta had 55 things.`;
  const p = T.checkReport({ prose, claims, fetched });
  assert.strictEqual(p.prose, `Alpha had 1,250 participants (${A}). Beta had 900 [not found in source] participants (${B}). Gamma had 77 [source not opened] widgets (${C}).\n\nDelta had 55 [no source to check] things.`);
  assert.deepStrictEqual([p.totals.proseFound, p.totals.proseNotFound, p.totals.proseNotOpened, p.totals.proseNoSource], [1, 1, 1, 1]);
  const both = T.chatReport({ prose, claims: p.claims, totals: p.totals, files: {} });
  assert.match(both, /: 2 found as written; 2 not found as written \(marked "not found in source"\); 2 from sources that could not be opened \(marked "source not opened"\); 2 with no source to check\./);
  // no "verified" about figures anywhere in the chat report
  assert.doesNotMatch(both.replace(/Alpha enrolled|Beta enrolled|Gamma enrolled|Delta enrolled/g, ''), /unverified|\bverified\b/i);
  // the document: the column, and the section after the table
  const doc = T.renderDocument({ question: 'Q?', preparedDate: '2026-11-22', prose: p.prose, claims: p.claims, sources: fetched, proseMissed: p.totals.proseMissed });
  assert.match(doc.markdown, /\| 1 of 1 found as written \|/);
  const tableAt = doc.markdown.indexOf('## Traceability');
  const secAt = doc.markdown.indexOf('## Figures not found as written');
  assert.ok(tableAt >= 0 && secAt > tableAt && secAt < doc.markdown.indexOf('## Sources'), 'section follows the table');
  assert.match(doc.html, /<h2[^>]*>Figures not found as written<\/h2>/);
  assert.doesNotMatch(doc.markdown + doc.html.replace(/<style>[\s\S]*?<\/style>/, ''), /\[unverified\]|\bverified\b/i);
});

test('r8-8 the document section: the source wording when it has the same number in another form', () => {
  const A = 'https://a.example/1';
  const B = 'https://b.example/2';
  const C = 'https://c.example/3';
  const fetched = [
    { url: A, title: 'Alpha study', ok: true, text: 'The test took 1.25 seconds in total.' },
    { url: B, title: 'Beta study', ok: true, text: 'The survey reached 1,250 participants in 2024.' },
    { url: C, title: 'Gamma study', ok: true, text: 'The count was 77 here.' },
  ];
  const claims = [
    { id: 'c1', claim: 'Alpha timing', source_url: A, figures: ['1250 ms'] },
    { id: 'c2', claim: 'Beta survey', source_url: B, figures: ['1,250 adults'] },
    { id: 'c3', claim: 'Gamma count', source_url: C, figures: ['77 here'] }, // found: no row
  ];
  const r = T.checkReport({ prose: 'Done.', claims, fetched });
  assert.deepStrictEqual(r.claims.map((c) => c.check_status), ['not_found_as_written', 'not_found_as_written', 'found_as_written']);
  const { markdown } = T.renderDocument({ question: 'Q?', preparedDate: '2026-11-22', prose: 'Done.', claims: r.claims, sources: fetched });
  const sec = markdown.slice(markdown.indexOf('## Figures not found as written'), markdown.indexOf('## Sources'));
  const rows = sec.split('\n').filter((l) => /^\| /.test(l) && !/^\| (Figure in|---)/.test(l));
  assert.strictEqual(rows.length, 2);
  // 1.25 seconds is not 1250 ms in any form the check knows, and no number has the same digits: the number does not appear
  assert.match(rows[0], /^\| 1250 ms \| \[Alpha study\]\(https:\/\/a\.example\/1\) \| the number does not appear in the source \|$/);
  // 1,250 adults vs 1,250 participants: the source's wording is shown, never counted as found
  assert.match(rows[1], /^\| 1,250 adults \| \[Beta study\]\(https:\/\/b\.example\/2\) \| "[^"|]*1,250 participants[^"|]*" \|$/);
  assert.ok(!/\bverified\b/i.test(sec));
  // a report with nothing not found says so; a run with no per-figure results (an older run) has no section
  const ok = T.renderDocument({ question: 'Q?', preparedDate: '2026-11-22', prose: 'Done.', claims: [T.applyCheck([claims[2]], T.checkClaims([claims[2]], fetched))[0]], sources: fetched });
  assert.match(ok.markdown, /## Figures not found as written\n\n[^\n]+\n\nNone\./);
  const old = T.renderDocument({ question: 'Q?', preparedDate: '2026-11-22', prose: 'Done.', claims: [{ id: 'c1', claim: 'Old', source_url: A, figures: ['1'], check: '1 of 1 figure found' }], sources: fetched });
  assert.doesNotMatch(old.markdown, /Figures not found as written/);
  assert.match(old.markdown, /1 of 1 figure found/);
});

test('r8-9 saved runs: the old statuses read as the new ones', () => {
  assert.strictEqual(T.savedStatus('found'), 'found_as_written');
  assert.strictEqual(T.savedStatus('not_found'), 'not_found_as_written');
  assert.strictEqual(T.savedStatus('common_not_near'), 'not_found_as_written');
  assert.strictEqual(T.savedStatus('source_not_opened'), 'source_not_opened');
  assert.strictEqual(T.savedStatus('verified'), 'found_as_written');
  assert.strictEqual(T.savedStatus('unverified'), 'not_found_as_written');
  assert.strictEqual(T.savedStatus('found_as_written'), 'found_as_written');
  assert.strictEqual(T.savedStatus('no_figures'), 'no_figures');
  // a result saved by an older run still yields its found figures
  const old = { claims: [{ id: 'c1', figures: [{ figure: '56.4%', status: 'found' }, { figure: '43.7%', status: 'common_not_near' }] }] };
  assert.ok(T.verifiedFigures(old).has('56.4'));
  assert.ok(!T.verifiedFigures(old).has('43.7'));
  // a document of an older run: the old column text is shown as saved, the old claim status still counts for Key evidence
  const t = T.chatReport({ prose: '## Verdict\nA.', claims: [{ id: 'c1', claim: 'Old good', source_url: 'https://a.example/1', check_status: 'verified', figure_checks: [{ figure: '5', status: 'found_as_written', meaning: 'matches', meaning_quote: 'five items' }] }], totals: { claims: 1, figures: 2, found: 1, notFound: 1, notOpened: 0 }, files: {} });
  // r9b: Key evidence needs both marks; a saved run with no meaning for its figures has no key evidence
  assert.match(t, /Key evidence\n- Old good \[https:\/\/a\.example\/1\] \(figures confirmed by both checks\)/);
  const t0 = T.chatReport({ prose: '## Verdict\nA.', claims: [{ id: 'c1', claim: 'Old good', source_url: 'https://a.example/1', check_status: 'verified', figure_checks: [{ figure: '5', status: 'found' }] }], totals: { claims: 1, figures: 1, found: 1 }, files: {} });
  assert.match(t0, /Key evidence\n- No claim has all its figures confirmed by both checks/);
});

test('r8-10 the revise brief does not carry the per-figure results', () => {
  const claims = [{ id: 'c1', claim: 'A', source_url: 'u', figures: ['1.5'], check: '0 of 1 found as written', check_status: 'not_found_as_written', figure_checks: [{ figure: '1.5', status: 'not_found_as_written' }] }];
  const b = T.reviseBrief('Q?', '## Verdict\nA.', claims, { results: [{ id: 'c1', verdict: 'supported', reason: 'ok' }] });
  assert.doesNotMatch(b, /figure_checks|check_status|found as written/);
});

test('r8-11 marks are not written twice', () => {
  const r1 = T.checkReport({ prose: 'A 5.5% rise.', claims: [] });
  assert.strictEqual(r1.prose, 'A 5.5% [not checked] rise.'); // r8: no check ran (claims: []): "not checked"
  assert.strictEqual(T.markUnverified(r1.prose), r1.prose);
  assert.strictEqual(T.markProse('A 9.5 [not found in source] again', new Set()).marks, 0);
});

test('r8-12 not checked marks', () => {
  assert.strictEqual(T.markUnverified('Got 56.4% and 300k in 2024.'), 'Got 56.4% [not checked] and 300k [not checked] in 2024.');
  assert.doesNotMatch(T.markUnverified('Got 56.4%.'), /no source to check/);
  for (const claims of [undefined, []]) {
    const r = T.checkReport({ prose: 'Got 56.4% and 300k in 2024.', claims });
    assert.strictEqual(r.prose, 'Got 56.4% [not checked] and 300k [not checked] in 2024.');
    assert.strictEqual(r.notChecked, true);
    assert.strictEqual(r.totals.proseFigures, 2);
    assert.strictEqual(r.totals.proseNotChecked, 2);
    assert.strictEqual(r.totals.proseNotChecked, r.totals.proseFigures);
    assert.strictEqual(r.totals.proseFound, 0);
  }
});

test('r8-13 an arXiv version citation needs fetched text of that version', () => {
  const U = 'https://arxiv.org/abs/2401.01234';
  const claims = [{ id: 'c1', claim: 'The study enrolled participants', source_url: U, figures: ['1,250 participants'] }];
  const fetched = [{ url: U, finalUrl: U + 'v1', ok: true, text: 'The study enrolled 1,250 participants in total.' }];
  const run = (cite) => T.checkReport({ prose: `The study enrolled 1,250 participants (${cite}).`, claims, fetched, counts: {} });
  // v2 cited, only v1 fetched: the v1 text does not answer for v2, so the figure is not credited as found
  const v2 = run(U + 'v2');
  assert.strictEqual(v2.totals.proseFound, 0);
  assert.match(v2.prose, /1,250 \[[^\]]+\] participants/);
  // v1 cited: the fetched record is v1: found
  const v1 = run(U + 'v1');
  assert.strictEqual(v1.totals.proseFound, 1);
  assert.doesNotMatch(v1.prose, /1,250 \[/);
  // unversioned citation: found
  const un = run(U);
  assert.strictEqual(un.totals.proseFound, 1);
  assert.doesNotMatch(un.prose, /1,250 \[/);
});

test('r8-14 claimKey changes with a figure\'s written form', () => {
  const base = { id: 'c1', claim: 'The study enrolled people', source_url: 'https://a.example/a', figures: ['1,250 participants'] };
  const k = T.claimKey(base);
  assert.notStrictEqual(T.claimKey({ ...base, figures: ['1,250 adults'] }), k);
  assert.strictEqual(T.claimKey({ ...base, id: 'c7' }), k);
  assert.strictEqual(T.claimKey({ ...base, id: 'c7', figures: ['1,250 participants'] }), k);
});

// ================================================================ r9a: fixes to "found as written"
// pairs: [figure, source text, 'found' | 'not found']. Each pair runs twice: through checkFigure (the claim figure against the text) and
// through checkReport (claim status and the mark in the report text, see judge).
function pairs(list) {
  for (const [fig, src, want] of list) {
    assert.strictEqual(judge(fig, src), want, `report: ${fig} vs ${src}`);
    const direct = T.checkFigure(fig, 'Reported measurement: ' + src, ['reported', 'measurement']) === 'found_as_written' ? 'found' : 'not found';
    assert.strictEqual(direct, want, `checkFigure: ${fig} vs ${src}`);
  }
}

test('r9a-1 an arXiv version at claim level: a v2 claim is not answered by a fetch that landed on v1', () => {
  const U = 'https://arxiv.org/abs/2401.12345';
  const text = 'The study enrolled 1,250 participants in total.';
  const claim = (url) => [{ id: 'c1', claim: 'The study enrolled participants', source_url: url, figures: ['1,250 participants'] }];
  // fetch url says v2, the finalUrl says v1: the text is v1, so a v2 claim has no source to check (state 'none'), never "found"
  const landedOnV1 = [{ url: U + 'v2', finalUrl: U + 'v1', ok: true, text }];
  assert.deepStrictEqual(T.checkClaims(claim(U + 'v2'), landedOnV1).claims.map((c) => [c.status, c.figures[0].status]), [['no_source', 'no_source']]);
  const r = T.checkReport({ prose: `The study enrolled 1,250 participants (${U}v2).`, claims: claim(U + 'v2'), fetched: landedOnV1, counts: {} });
  assert.strictEqual(r.claims[0].check, 'no source to check');
  assert.match(r.prose, /1,250 \[no source to check\] participants/);
  // the fetch really is v2 (finalUrl, or url with no finalUrl): found
  for (const f of [{ url: U + 'v2', finalUrl: U + 'v2' }, { url: U + 'v2' }, { url: U, finalUrl: U + 'v2' }]) {
    assert.strictEqual(T.checkClaims(claim(U + 'v2'), [{ ...f, ok: true, text }]).claims[0].status, 'found_as_written', JSON.stringify(f));
  }
  // a finalUrl without a version cannot show which version the text is: no source to check
  assert.strictEqual(T.checkClaims(claim(U + 'v2'), [{ url: U + 'v2', finalUrl: U, ok: true, text }]).claims[0].status, 'no_source');
  // a claim without a version may use any fetched version (as before)
  assert.strictEqual(T.checkClaims(claim(U), landedOnV1).claims[0].status, 'found_as_written');
  assert.strictEqual(T.checkClaims(claim(U + 'v1'), landedOnV1).claims[0].status, 'found_as_written');
  // the second fetch of the same paper is the one that counts
  const both = [{ url: U + 'v2', finalUrl: U + 'v1', ok: true, text: 'The study enrolled 99 participants.' }, { url: U + 'v2', finalUrl: U + 'v2', ok: true, text }];
  assert.strictEqual(T.checkClaims(claim(U + 'v2'), both).claims[0].status, 'found_as_written');
});

test('r9a-2 visible text only: comments, tags, reference definitions, link titles, entities', () => {
  pairs([
    ['1250', '<!-- benchmark: 1250 -->', 'not found'],
    ['1250', 'before <!-- a\nmulti-line 1250\ncomment --> after', 'not found'],
    ['1250', '\n[ref]: /path " 1250 "', 'not found'], // a reference definition is a whole line
    ['1250', "\n[ref]: <https://example.org/a> '1250'", 'not found'],
    ['1250', '\n[ref]: /path (1250)', 'not found'],
    ['1250', '[Foo](https://example.org/a "the 1250 title")', 'not found'],
    ['1250', '![an image](pic.png "1250 pixels")', 'not found'],
    ['1250', '[Foo](https://en.example/wiki/Foo_(bar)_1250)', 'not found'],
    ['1250', '&lt; 1250', 'not found'],
    ['<1250', '&lt; 1250', 'found'],
    ['>1250', '&gt; 1250', 'found'],
    ['1250', '1250 &amp; 300', 'not found'], // "&amp;" reads "&", a symbol after the number: part of the form
    ['1250 &', '1250 &amp; 300', 'found'],
    ['−1250', '&minus;1250', 'found'], // r10: the entity's spaces go before the sign, so it sits right in front of its digits (was: a word of its own, fail-safe)
    ['1250', '<td>1250</td>', 'found'],
    ['1250', '<span class="x">1250</span> people', 'not found'], // "people" is the next word
    ['1250 people', '<span class="x">1250</span> people', 'found'],
    ['1250', '<p>1250</p>', 'found'],
    ['1250', '[1250](https://example.org/x)', 'found'], // the link text stays
  ]);
  // the text between two tags stays, a footnote line is not a reference definition
  assert.strictEqual(T.checkFigure('1250', '[^1]: the cost was 1250'), 'found_as_written');
  // offsets stay valid for the numbers after the removed parts
  const t = '<!-- c --> [x](http://a.example/p) 4,200 units';
  assert.strictEqual(T.checkFigure('4,200 units', t), 'found_as_written');
  // "&nbsp;" is white space of the same length (not one space: "1250&nbsp;mg" is not read as the unit "mg"; fail-safe)
  assert.strictEqual(T.checkFigure('1250 mg', 'dose 1250&nbsp;mg'), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('1250', 'dose 1250&nbsp;.'), 'found_as_written');
});

test('r9a-3 markup between a sign or currency and the digits is not part of the form (sources and report text)', () => {
  pairs([
    ['1250', 'Total: **−** 1250', 'not found'],
    ['-1250', 'Total: **−** 1250', 'found'],
    ['-1250', 'Total: <b>-</b> 1250', 'found'],
    ['1250', 'Total: **−1250**', 'not found'],
    ['-1250', 'Total: **−1250**', 'found'],
    ['1250', 'USD **1250**', 'not found'],
    ['USD 1250', 'USD **1250**', 'not found'], // the code is then a word in front, no longer the currency of the number (fail-safe)
    ['1250', '*1250*', 'found'],
    ['1250', '`1250`', 'found'],
    ['1250', '__1250__', 'found'],
    ['1250', '1250*', 'not found'], // a star that wraps nothing stays a symbol of the form
    ['1250', '1250 *', 'not found'],
    ['1250 people', '**1250** people', 'found'],
    ['1250 people', '**1250 people**', 'found'],
  ]);
  // report text: "**5** users" is the figure 5 with the word users (this was a false not found)
  const claims = [{ id: 'c1', claim: 'Reported measurement', source_url: R8A, figures: ['5 users'] }];
  const fetched = [{ url: R8A, title: 'Paper', ok: true, text: 'Reported measurement: 5 users.' }];
  const r = T.checkReport({ prose: `**5** users took part (${R8A}).`, claims, fetched });
  assert.strictEqual(r.prose, `**5** users took part (${R8A}).`);
  assert.strictEqual(r.totals.proseFound, 1);
  const wrong = T.checkReport({ prose: `**6** users took part (${R8A}).`, claims, fetched });
  assert.match(wrong.prose, /\*\*6 \[not found in source\]\*\* users/); // the mark follows the digits, inside the markers
  // a sign wrapped in markup in the report text is the sign of the figure
  const neg = T.checkReport({ prose: `Total: **−** 5 users (${R8A}).`, claims: [{ id: 'c1', claim: 'Reported measurement', source_url: R8A, figures: ['-5 users'] }], fetched: [{ url: R8A, title: 'Paper', ok: true, text: 'Reported measurement: -5 users.' }] });
  assert.strictEqual(neg.totals.proseFound, 1);
  // the offsets of the report text do not move: the mark comes right after the figure
  assert.strictEqual(T.checkReport({ prose: `A **7** rise (${R8A}).`, claims, fetched }).prose, `A **7 [not found in source]** rise (${R8A}).`);
});

test('r9a-4 case: a word is case-folded only when it has 5+ letters and no capital after the first', () => {
  pairs([
    ['1250 mbar', '1250 Mbar', 'not found'],
    ['1250 Mbar', '1250 Mbar', 'found'],
    ['1250 MiB', '1250 MiB', 'found'],
    ['1250 MiB', '1250 mib', 'not found'],
    ['1250 Participants', '1250 participants', 'found'],
    ['1250 participants', '1250 PARTICIPANTS', 'not found'], // a capital after the first letter: kept as written
    ['1250 kids', '1250 Kids', 'not found'], // 4 letters: kept as written
  ]);
});

test('r9a-5 words after a number: the shorter function-word list, bounds, rates, symbols and parentheses', () => {
  pairs([
    // "in", "a", "an", "each", "or", "and", "more", "less", "over", "under", "than", "all", "most", "only", "still", "so", "then", "also" are words
    ['1250', 'Length: 1250 in.', 'not found'],
    ['1250', '1250 in thousands', 'not found'],
    ['1250', '1250 only', 'not found'],
    ['1250', '1250 and 300', 'not found'],
    ['1250 and', '1250 and 300', 'found'],
    ['1250', '1250 still', 'not found'],
    ['1250', '1250 then', 'not found'],
    ['1250 of', '1250 of 3000', 'found'], // "of" is still a function word: no part of the form
    ['1250', '1250 of 3000', 'found'],
    // bound and approximation phrases after the number set the qualifier and are not the word
    ['1250 or fewer', '1250 or fewer', 'found'],
    ['1250 or fewer', '≤1250', 'found'],
    ['1250 or fewer', '1250 or more', 'not found'],
    ['1250', '1250 or fewer', 'not found'],
    ['1250', '1250 or more', 'not found'],
    ['1250 or more', '≥1250', 'found'],
    ['1250 or more', '1250 and above', 'found'],
    ['1250 or later', '1250 or more', 'found'],
    ['1250 and below', 'up to 1250', 'found'],
    ['1250 at most', 'up to 1250', 'found'],
    ['1250 at most', 'at least 1250', 'not found'],
    ['1250 or so', 'about 1250', 'found'],
    ['1250 or thereabouts', 'about 1250', 'found'],
    ['1250', '1250 or so', 'not found'],
    ['5 or more users', '≥ 5 users', 'found'],
    ['5 or more users', '5 users', 'not found'],
    ['at least 5 or more', 'at least 5', 'found'],
    ['at most 5 or more', 'at most 5', 'not found'], // two different bounds in one figure never match
    ['5% or more', '5% and above', 'found'],
    ['5%', '5% or more', 'not found'],
    // rates, after any number, all of them in order
    ['1250%', '1250% annually', 'not found'],
    ['1250% annually', '1250% annually', 'found'],
    ['1250% per user', '1250% per user per day', 'not found'],
    ['1250% per user per day', '1250% per user per day', 'found'],
    ['1250 mg per kg', '1250 mg per kg per day', 'not found'],
    ['1250 mg per kg per day', '1250 mg per kg per day', 'found'],
    ['$1,250 a month', '$1,250 a year', 'not found'],
    ['$1,250 a month', '$1,250 per month', 'found'],
    ['$1,250 each month', '$1,250 per month', 'found'],
    ['$1,250 every month', '$1,250 monthly', 'not found'],
    ['$1,250 monthly', '$1,250 monthly', 'found'],
    ['5%', '5% annual growth', 'not found'],
    ['5% annual', '5% annual growth', 'found'],
    ['5%', '5% yearly', 'not found'],
    ['5%', '5% y/y', 'not found'],
    ['5%', '5% yoy', 'not found'],
    ['5%', '5% p.a.', 'not found'],
    ['5%', '5% per annum', 'not found'],
    ['5x', '5x per day', 'not found'],
    ['5 pp', '5 pp a year', 'not found'],
    ['1250ms', '1250ms per call', 'not found'],
    ['1250', '1250 users daily', 'not found'],
    ['1250 users', '1250 users hourly', 'not found'],
    ['1250 m', '1250 m/s', 'not found'],
    ['1250 MB', '1250 MB s⁻¹', 'not found'],
    // a symbol or a parenthesised token after the number is part of the form
    ['1250', '1250 ± 50', 'not found'],
    ['1250', '1250 / 100', 'not found'],
    ['1250', '1250 ‰', 'not found'],
    ['1250', '1250 × 3', 'not found'],
    ['1250', '1250 = x', 'not found'],
    ['1250', '1250 (USD)', 'not found'],
    ['1250', '1250 (million)', 'not found'],
    ['1250', '1250 (n=20)', 'not found'],
    ['1250 (USD)', '1250 (USD)', 'found'],
    ['1250 (n=20)', '1250 (N=20)', 'not found'],
    ['1250 ±', '1250 ± 50', 'found'],
    ['1250', '1250 | 300 |', 'found'], // a table bar is no word
    ['1250', '1250 - 300', 'found'], // a lone dash is no word
    ['1250', '1250 (https://example.org/x)', 'found'], // a citation is no word (in a source its address is blanked: nothing is left)
    ['1250', '1250 (see https://example.org/x)', 'not found'], // fail-safe: "see" is left in a source
    // the word after a currency code is the next word after it
    ['1250 USD', '1250 USD cents', 'not found'],
    ['1250 USD cents', '1250 USD cents', 'found'],
    ['1250 USD', '1250 USD.', 'found'],
    ['1250 USD', '1250 USD', 'found'],
    ['1250 USD per month', '1250 USD per month', 'found'],
    ['1250 USD', '1250 USD per month', 'not found'],
    ['$1,250 CAD', '$1,250 CAD', 'found'],
    ['CAD $1,250', '$1,250 CAD', 'not found'],
  ]);
  // a rate in prose
  const claims = [{ id: 'c1', claim: 'Reported measurement', source_url: R8A, figures: ['$1,250 a month'] }];
  const fetched = [{ url: R8A, title: 'Paper', ok: true, text: 'Reported measurement: $1,250 a year.' }];
  assert.match(T.checkReport({ prose: `It cost $1,250 a month (${R8A}).`, claims, fetched }).prose, /\$1,250 \[not found in source\] a month/);
});

test('r9a-6 qualifiers before a number: negations, bounds, approximations, sign words', () => {
  pairs([
    // negations reverse or void
    ['more than 1250', 'no more than 1250', 'not found'],
    ['no more than 1250', 'at most 1250', 'found'],
    ['no more than 1250', 'not more than 1250', 'found'],
    ['not over 1250', 'up to 1250', 'found'],
    ['not above 1250', 'at most 1250', 'found'],
    ['not exceeding 1250', 'at most 1250', 'found'],
    ['no less than 1250', 'at least 1250', 'found'],
    ['no fewer than 1250', 'at least 1250', 'found'],
    ['not less than 1250', 'at least 1250', 'found'],
    ['not under 1250', 'at least 1250', 'found'],
    ['not below 1250', 'at least 1250', 'found'],
    ['over 1250', 'not over 1250', 'not found'],
    ['at most 1250', 'no less than 1250', 'not found'],
    ['1250', 'not exactly 1250', 'not found'],
    ['1250', 'never 1250', 'not found'],
    ['1250', 'not 1250', 'not found'],
    ['not exactly 1250', 'not exactly 1250', 'found'],
    ['not 1250', 'not exactly 1250', 'found'],
    ['not 1250', '1250', 'not found'],
    ['above 1250', 'never above 1250', 'not found'], // a negation in front of another qualifier voids it
    ['about 1250', 'not about 1250', 'not found'],
    // maximum, minimum
    ['1250', 'a maximum of 1250', 'not found'],
    ['at most 1250', 'a maximum of 1250', 'found'],
    ['up to 1250', 'maximum of 1250', 'found'],
    ['≤1250', 'max. 1250', 'found'],
    ['up to 1250', 'capped at 1250', 'found'],
    ['at least 1250', 'a minimum of 1250', 'found'],
    ['≥1250', 'minimum of 1250', 'found'],
    ['at least 1250', 'min. 1250', 'found'],
    ['at least 1250', 'starting at 1250', 'found'],
    ['at least 1250', 'starting from 1250', 'found'],
    ['at most 1250', 'a minimum of 1250', 'not found'],
    // greater, less
    ['more than 1250', 'exceeds 1250', 'found'],
    ['more than 1250', 'exceeded 1250', 'found'],
    ['over 1250', 'exceeding 1250', 'found'],
    ['over 1250', 'surpassed 1250', 'found'],
    ['over 1250', 'surpassing 1250', 'found'],
    ['over 1250', 'beyond 1250', 'found'],
    ['above 1250', 'greater than 1250', 'found'],
    ['>1250', 'in excess of 1250', 'found'],
    ['below 1250', 'less than 1250', 'found'],
    ['under 1250', 'fewer than 1250', 'found'],
    ['<1250', 'below 1250', 'found'],
    ['1250', 'in excess of 1250', 'not found'],
    ['1250', 'below 1250', 'not found'],
    ['more than 1250', 'less than 1250', 'not found'],
    ['over 1250', 'at least 1250', 'not found'],
    // approximations
    ['1250', 'an estimated 1250', 'not found'],
    ['about 1250', 'an estimated 1250', 'found'],
    ['about 1250', 'estimated 1250', 'found'],
    ['about 1250', 'close to 1250', 'found'],
    ['about 1250', 'circa 1250', 'found'],
    ['about 1250', 'c. 1250', 'found'],
    ['about 1250', 'ca. 1250', 'found'],
    ['about 1250', 'est. 1250', 'found'],
    ['about 1250', 'some 1250', 'found'],
    ['about 1250', 'on the order of 1250', 'found'],
    ['roughly 1250', '≈ 1250', 'found'],
    ['about 1250', '1250', 'found'], // an approximation may match an exact source
    ['1250', 'on the order of 1250', 'not found'],
    ['1250', 'some 1250', 'not found'],
    ['1250', '≈ 1250', 'not found'],
    ['about 1250', 'at least 1250', 'not found'],
    // sign words
    ['5%', 'minus 5%', 'not found'],
    ['5%', 'negative 5%', 'not found'],
    ['minus 5', 'minus 5', 'found'],
    ['minus 5', 'negative 5', 'found'],
    ['minus 5', '5', 'not found'],
    ['5', 'plus 5', 'not found'],
    ['plus 5', 'positive 5', 'found'],
    ['plus 5', '5', 'not found'],
    ['5', 'positive 5', 'not found'],
  ]);
});

test('r9a-7 scales touch the number; spaced digit groups; a compound keeps a trailing scale', () => {
  pairs([
    ['1250 K', '1250000', 'not found'],
    ['1250000', '1250 K', 'not found'],
    ['1250 K', '1250 K', 'found'],
    ['300k', '300,000', 'found'],
    ['300,000', '300k', 'found'],
    ['5M', '5 million', 'found'],
    ['$5M', '$5 million', 'found'],
    ['$5m', '$5 million', 'not found'], // documented: a lower-case m touching the number is an attached "m", not million (fail-safe)
    ['5 million', '5M', 'found'],
    ['7B', '7 billion', 'found'],
    ['5 M', '5 million', 'not found'],
    ['5 B', '5 billion', 'not found'],
    ['5 B', '5 B', 'found'],
    ['300 K', '300000', 'not found'],
    // spaced digit groups: the number is never one without the groups
    ['250', '1  250', 'not found'],
    ['250', '1 250 000', 'not found'],
    ['000', '1 250 000', 'not found'],
    ['1250', '1 250', 'not found'],
    ['250', 'room 250', 'found'],
    ['250', 'In 2020 250 people', 'not found'],
    ['5–10 million', '5–10000000', 'not found'],
    ['5–10 million', '5–10 million', 'found'],
    ['5–10 million', '5 million–10 million', 'not found'],
    ['5–10M', '5–10 million', 'found'],
    ['5–10 million', '5-10 million', 'found'],
    ['5–10 K', '5–10000', 'not found'],
  ]);
  assert.strictEqual(T.parseFigure('5–10 million').value, '5-10|million');
  assert.strictEqual(T.parseFigure('5–10%').value, '5-10');
  assert.strictEqual(T.parseFigure('5 million–10 million').value, '5000000-10000000');
  assert.deepStrictEqual(T.numbersIn('300 K and 5M and 7 B and 4m').map((t) => [t.mag, t.suffix, t.post]), [['300', '', ''], ['5000000', 'M', ''], ['7', '', ''], ['4', '', 'm']]);
  assert.deepStrictEqual(T.numbersIn('1  250').map((t) => [t.mag, t.pre]), [['1', ''], ['250', '#']]);
  assert.deepStrictEqual(T.numbersIn('1\n250').map((t) => [t.mag, t.pre]), [['1', ''], ['250', '']]); // a line break is no digit group
});

test('r9a-8 a source title names the source only with 3+ words or 20+ characters, on word boundaries', () => {
  const claims = [{ id: 'c1', claim: 'Reported measurement', source_url: R8A, figures: ['1250 users'] }];
  const run = (title, prose) => T.checkReport({ prose, claims, fetched: [{ url: R8A, title, ok: true, text: 'Reported measurement: 1250 users.' }], counts: {} });
  // "Pricing" is one short word: a sentence with "pricing" does not cite the source
  assert.match(run('Pricing', 'The pricing page lists 1250 users.').prose, /1250 \[no source to check\] users/);
  assert.match(run('Pricing', 'Pricing lists 1250 users.').prose, /1250 \[no source to check\] users/);
  // three words, or twenty characters, count
  assert.strictEqual(run('Pricing of cloud', 'The pricing of cloud lists 1250 users.').prose, 'The pricing of cloud lists 1250 users.');
  assert.strictEqual(run('Annual pricing report', 'The annual pricing report lists 1250 users.').prose, 'The annual pricing report lists 1250 users.');
  assert.strictEqual(run('Pricingoverviewdocument', 'The pricingoverviewdocument lists 1250 users.').prose, 'The pricingoverviewdocument lists 1250 users.');
  // word boundaries: a title inside a longer word does not count
  assert.match(run('Annual pricing report', 'The annual pricing reports list 1250 users.').prose, /1250 \[no source to check\] users/);
  assert.match(run('Annual pricing report', 'The nonannual pricing report lists 1250 users.').prose, /1250 \[no source to check\] users/);
  // an uncited short title of a source that was not opened does not close the block either
  const closed = T.checkReport({ prose: 'The pricing page lists 1250 users.', claims, fetched: [{ url: R8A, title: 'Pricing', ok: false, text: '' }], counts: {} });
  assert.match(closed.prose, /1250 \[no source to check\] users/);
});

test('r9a-9 a hard cap on the check per source: too large to check', () => {
  const head = 'Reported measurement: 1250 users. ';
  const claims = [{ id: 'c1', claim: 'Reported measurement', source_url: R8A, figures: ['1250 users'] }];
  const run = (text) => {
    const fetched = [{ url: R8A, title: 'Paper', ok: true, text }];
    return { res: T.checkClaims(claims, fetched), rep: T.checkReport({ prose: `There were 1250 users (${R8A}).`, claims, fetched, counts: {} }) };
  };
  // 600,000 characters are checked; 600,001 are too large
  const ok = run(head + ' '.repeat(600000 - head.length));
  assert.strictEqual(ok.res.claims[0].status, 'found_as_written');
  const big = run(head + ' '.repeat(600001 - head.length));
  assert.strictEqual(big.res.claims[0].status, 'source_not_opened');
  assert.deepStrictEqual(big.res.claims[0].figures.map((f) => f.status), ['source_not_opened']);
  assert.strictEqual(big.rep.claims[0].check, 'source too large to check');
  assert.strictEqual(big.rep.claims[0].check_status, 'source_not_opened');
  assert.match(big.rep.prose, /1250 \[source not opened\] users/);
  assert.strictEqual(big.rep.totals.notOpened, 1);
  assert.strictEqual(big.rep.totals.proseNotOpened, 1);
  assert.strictEqual(T.checkFigure('1250 users', head + ' '.repeat(600001 - head.length)), 'source_not_opened');
  // an unreadable source stays "source not opened" (its own check text)
  assert.strictEqual(T.checkReport({ prose: 'x', claims, fetched: [{ url: R8A, title: 'P', ok: false, text: '' }] }).claims[0].check, 'source not opened');
  // indexing that takes longer than the time limit is too large too (the limit is lowered here to make it certain)
  const was = T.INDEX_LIMITS.maxMs;
  try {
    T.INDEX_LIMITS.maxMs = -1;
    const slow = run(head + 'slow variant');
    assert.strictEqual(slow.rep.claims[0].check, 'source too large to check');
    assert.match(slow.rep.prose, /1250 \[source not opened\] users/);
  } finally { T.INDEX_LIMITS.maxMs = was; }
  assert.strictEqual(run(head + 'a fast variant').res.claims[0].status, 'found_as_written'); // back to normal (the verdict on a text is kept per text)
  // no regex scans without a bound: "](" repeated 300,000 times (600,000 characters) is checked in well under a second
  const evil = '](' .repeat(300000) + ' 1250 users';
  const t0 = Date.now();
  assert.strictEqual(T.checkFigure('1250 users', evil.slice(-600000)), 'found_as_written');
  for (const text of ['](' .repeat(300000), '*'.repeat(600000), '*a '.repeat(200000), '<!--'.repeat(150000), '<a '.repeat(200000), '&lt;'.repeat(150000), ']((((((('.repeat(70000)]) {
    T.checkFigure('1250', text);
  }
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  // a link destination with one level of parentheses is blanked whole; its figures are not source text
  assert.strictEqual(T.checkFigure('1250', '[Foo](https://en.example/wiki/Foo_(bar)_1250)'), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('1250', '[Foo](https://en.example/wiki/Foo_(bar)_1250) and 1250'), 'found_as_written');
});

// ---------------------------------------------------------------- r9b: the second mark, "Means the same"
const MSRC = 'https://s.example/study';
const MTEXT = 'Table 3. Response rate by arm, adults, 2024. The response rate was 56.4% in the treatment arm and 43.6% in the control arm. Enrolment was 1,250 participants in total.';
const MFETCHED = [{ url: MSRC, title: 'Trial report', ok: true, text: MTEXT }];
const mClaims = () => [
  { id: 'c1', claim: 'Response rate was 56.4% in the treatment arm', source_url: MSRC, figures: ['56.4%', '43.6%', '9.9%'], measured_result: '56.4% treatment, 43.6% control' },
  { id: 'c2', claim: 'Enrolment was 1,250 participants', source_url: MSRC, figures: ['1,250 participants'], measured_result: '' },
];
const jsonReply = (arr) => '```json\n' + JSON.stringify(arr) + '\n```';
const mCheck = (keys, claims = mClaims(), prose = `## Verdict\nThe rate was 56.4% in the treatment arm (${MSRC}) against 43.6% in the control arm (${MSRC}).`) => T.checkReport({ prose, claims, fetched: MFETCHED, counts: {}, meaningKeys: keys });
const mFigs = () => T.figureExcerpts(mCheck().claims, MFETCHED);
const M_PROSE = `## Verdict\nThe rate was 56.4% in the treatment arm (${MSRC}) against 43.6% in the control arm (${MSRC}).`;
// the entries for the figures of the report text only (fids p1, p2 ...)
const mProseFigs = (prose = M_PROSE, claims = mCheck().claims, fetched = MFETCHED) => T.figureExcerpts(claims, fetched, undefined, { prose, counts: {} }).filter((f) => f.prose);
// the reviewer's answers, run through the parser and the code validation
const mValidate = (items, figs = mFigs(), id = 'c1') => {
  const parsed = T.parseChallenge(jsonReply(['c1', 'c2'].map((x) => ({ id: x, verdict: 'supported', reason: 'r', figures: x === id ? items : [] }))), ['c1', 'c2'], figs);
  return { parsed, ...T.figureMeanings(figs, parsed), figs };
};
const keyOfFid = (figs, fid) => figs.find((f) => f.fid === fid).meaningKey;

test('r9b figureExcerpts: one passage per found figure, ids, keys, not found figures get none', () => {
  const figs = mFigs();
  assert.deepStrictEqual(figs.map((f) => f.fid), ['c1.f1', 'c1.f2', 'c2.f1']); // c1.f3 (9.9%) is not in the source: no passage
  assert.deepStrictEqual(figs.map((f) => f.figure), ['56.4%', '43.6%', '1,250 participants']);
  assert.ok(figs.every((f) => /^[0-9a-f]{64}$/.test(f.meaningKey)));
  assert.strictEqual(new Set(figs.map((f) => f.meaningKey)).size, 3);
  assert.ok(figs[0].excerpt.includes('The response rate was 56.4% in the treatment arm'));
  assert.deepStrictEqual(figs[0].numbers, ['56.4']); // the digits as the passage writes them, without the %
  // a source that was not opened, or a claim with no source: no passage
  const closed = [{ url: MSRC, ok: false, text: '' }];
  assert.deepStrictEqual(T.figureExcerpts(mCheck().claims, closed), []);
  assert.deepStrictEqual(T.figureExcerpts(mCheck().claims, []), []);
});

test('r9b figureExcerpts: 300 characters each side, cut at word boundaries, on the visible text', () => {
  const text = 'alpha '.repeat(120) + 'The rate was 56.4% overall. ' + 'omega '.repeat(120) + 'see https://x.example/' + 'z'.repeat(50);
  const fetched = [{ url: MSRC, ok: true, text }];
  const claims = [{ id: 'c1', claim: 'The rate was 56.4% overall', source_url: MSRC, figures: ['56.4%'] }];
  const first = T.checkReport({ prose: 'x', claims, fetched });
  const [f] = T.figureExcerpts(first.claims, fetched);
  assert.ok(f.excerpt.includes('The rate was 56.4% overall.'));
  const words = f.excerpt.split(' ');
  assert.ok(words.every((w) => ['alpha', 'omega', 'The', 'rate', 'was', '56.4%', 'overall.'].includes(w)), 'no word is cut');
  const before = f.excerpt.indexOf('56.4%'); // characters before the figure
  assert.ok(before <= 300 && before >= 285, 'about 300 characters before: ' + before);
  const after = f.excerpt.length - f.excerpt.indexOf('56.4%') - 5;
  assert.ok(after <= 300 + 20 && after >= 270, 'about 300 characters after: ' + after);
  // a link address is not visible text: it is not in the passage
  const near = [{ url: MSRC, ok: true, text: 'The rate was 56.4% overall, see https://x.example/secret-address for more.' }];
  const [g] = T.figureExcerpts(T.checkReport({ prose: 'x', claims, fetched: near }).claims, near);
  assert.ok(!g.excerpt.includes('secret-address') && g.excerpt.includes('for more'));
});

test('r9b figureExcerpts: at most 8 figures per claim and 120 per round', () => {
  const nums = Array.from({ length: 12 }, (_, i) => String(41001 + i));
  const fetched = [{ url: MSRC, ok: true, text: 'The values were ' + nums.map((n) => `(${n})`).join(' ') + ' in all.' }];
  const claims = Array.from({ length: 20 }, (_, i) => ({ id: 'c' + (i + 1), claim: 'Values were reported ' + i, source_url: MSRC, figures: nums }));
  const first = T.checkReport({ prose: 'x', claims, fetched });
  const figs = T.figureExcerpts(first.claims, fetched);
  assert.strictEqual(figs.filter((f) => f.id === 'c1').length, 8);
  assert.deepStrictEqual(figs.filter((f) => f.id === 'c1').map((f) => f.n), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.strictEqual(figs.length, 120);
  // the figures past the caps are "not checked", never "matches"
  const keys = Object.fromEntries(figs.map((f) => [f.meaningKey, { meaning: 'matches', quote: 'x' }]));
  const marked = T.checkReport({ prose: 'x', claims, fetched, meaningKeys: keys });
  assert.strictEqual(marked.claims[0].figure_checks.filter((f) => f.meaning === 'matches').length, 8);
  assert.strictEqual(marked.claims[0].figure_checks.filter((f) => f.meaning === 'not checked').length, marked.claims[0].figure_checks.length - 8); // the 4 past the cap, and the claim text's own "0"
});

test('r9b the brief carries each figure with its passage, and the reply shape', () => {
  const first = mCheck();
  const figs = T.figureExcerpts(first.claims, MFETCHED);
  const b = T.challengeBrief('Q?', first.claims, T.challengeExcerpts(first.claims, MFETCHED), figs);
  assert.ok(b.includes('Figures to compare (each with the passage the hub cut from the source around it):'));
  assert.ok(b.includes('[c1.f1] the report writes: 56.4% | passage: "'));
  assert.ok(b.includes('[c2.f1] the report writes: 1,250 participants | passage: "'));
  assert.ok(!b.includes('[c1.f3]'));
  assert.match(b, /Answer "matches" or "differs"/);
  assert.match(b, /must include the figure's number as the passage writes it/);
  assert.match(b, /Quotes must be copied exactly from the passage/);
  assert.ok(b.includes('"figures": [{"fid": "c1.f1", "meaning": "matches", "quote": "..."}]'));
  const none = T.challengeBrief('Q?', first.claims, T.challengeExcerpts(first.claims, MFETCHED));
  assert.ok(!none.includes('Figures to compare') && !none.includes('"fid"'));
});

test('r9b parseChallenge: figures only for the fids that were presented, for their own claim', () => {
  const figs = mFigs();
  const items = [
    { fid: 'c1.f1', meaning: 'matches', quote: 'The response rate was 56.4%' },
    { fid: 'c1.f3', meaning: 'matches', quote: 'nine point nine' },   // a figure that was not found: never presented
    { fid: 'c9.f1', meaning: 'matches', quote: 'does not exist' },    // unknown
    { fid: 'c2.f1', meaning: 'matches', quote: 'Enrolment was 1,250 participants' }, // presented, but for claim c2, not c1
    { fid: 'c1.f1', meaning: 'differs', quote: 'a second answer' },   // a repeat
    'junk', null,
  ];
  const { parsed } = mValidate(items, figs);
  assert.deepStrictEqual(parsed.results[0].figures, [{ fid: 'c1.f1', meaning: 'matches', quote: 'The response rate was 56.4%' }]);
  assert.deepStrictEqual(parsed.results[1].figures, []);
  assert.deepStrictEqual(T.parseChallenge(jsonReply([{ id: 'c1', verdict: 'supported', reason: '', figures: items }]), ['c1', 'c2'], figs).results[1].figures, []); // a missing claim
  // without the presented list nothing is kept
  assert.deepStrictEqual(T.parseChallenge(jsonReply([{ id: 'c1', verdict: 'supported', reason: '', figures: items }]), ['c1']).results[0].figures, []);
});

test('r9b validation: the quote must be in the passage, long enough, and for "matches" carry the number', () => {
  const figs = mFigs();
  const f1 = keyOfFid(figs, 'c1.f1');
  // matches with a good quote
  let v = mValidate([{ fid: 'c1.f1', meaning: 'matches', quote: 'The response rate was 56.4% in the treatment arm' }]);
  assert.deepStrictEqual(v.keys, { [f1]: { meaning: 'matches', quote: 'The response rate was 56.4% in the treatment arm' } });
  // a quote that is not in the passage
  v = mValidate([{ fid: 'c1.f1', meaning: 'matches', quote: 'The response rate was 56.4% in the placebo arm' }]);
  assert.deepStrictEqual(v.keys, {});
  // a quote from the passage without the figure's number
  v = mValidate([{ fid: 'c1.f1', meaning: 'matches', quote: 'response rate was' }]);
  assert.deepStrictEqual(v.keys, {});
  // a quote with another number does not help either
  v = mValidate([{ fid: 'c1.f1', meaning: 'matches', quote: 'and 43.6% in the control arm' }]);
  assert.deepStrictEqual(v.keys, {});
  // too short (fewer than 8 characters)
  v = mValidate([{ fid: 'c1.f1', meaning: 'matches', quote: '56.4%' }]);
  assert.deepStrictEqual(v.keys, {});
  // differs with a quote from the passage (the number is not needed): differs, with the quote
  v = mValidate([{ fid: 'c1.f2', meaning: 'differs', quote: 'in the control arm' }]);
  assert.deepStrictEqual(v.keys, { [keyOfFid(figs, 'c1.f2')]: { meaning: 'differs', quote: 'in the control arm' } });
  assert.deepStrictEqual(v.differs, [{ id: 'c1', fid: 'c1.f2', figure: '43.6%', quote: 'in the control arm' }]);
  // differs with a quote that is not in the passage
  assert.deepStrictEqual(mValidate([{ fid: 'c1.f2', meaning: 'differs', quote: 'in the placebo arm' }]).keys, {});
  // anything but exactly matches / differs
  for (const meaning of ['match', 'maybe', '', 'same']) assert.deepStrictEqual(mValidate([{ fid: 'c1.f1', meaning, quote: 'The response rate was 56.4% in the treatment arm' }]).keys, {}, meaning);
  // the verdict word in any case counts (the quote is what is checked)
  assert.strictEqual(Object.values(mValidate([{ fid: 'c1.f1', meaning: ' Matches ', quote: 'The response rate was 56.4% in the treatment arm' }]).keys)[0].meaning, 'matches');
  // white space is collapsed on both sides
  v = mValidate([{ fid: 'c1.f1', meaning: 'matches', quote: 'rate was   56.4%\n in the treatment' }]);
  assert.strictEqual(Object.keys(v.keys).length, 1);
  assert.strictEqual(v.keys[f1].quote, 'rate was 56.4% in the treatment');
  // a number with a thousands separator: the quote must have it as the passage writes it
  assert.deepStrictEqual(mValidate([{ fid: 'c2.f1', meaning: 'matches', quote: 'Enrolment was 125 participants' }], mFigs(), 'c2').keys, {});
  assert.strictEqual(Object.keys(mValidate([{ fid: 'c2.f1', meaning: 'matches', quote: 'Enrolment was 1,250 participants' }], mFigs(), 'c2').keys).length, 1);
});

test('r9b final marks: matches / differs / not checked, looked up by the current key; "[source says otherwise]" once', () => {
  const figs = mFigs();
  const keys = {
    [keyOfFid(figs, 'c1.f1')]: { meaning: 'matches', quote: 'The response rate was 56.4% in the treatment arm' },
    [keyOfFid(figs, 'c1.f2')]: { meaning: 'differs', quote: 'in the control arm' },
  };
  const r = mCheck(keys);
  const fc = r.claims[0].figure_checks;
  assert.deepStrictEqual(fc.map((f) => [f.figure, f.status, f.meaning, f.meaning_quote]), [
    ['56.4%', 'found_as_written', 'matches', 'The response rate was 56.4% in the treatment arm'],
    ['43.6%', 'found_as_written', 'differs', 'in the control arm'],
    ['9.9%', 'not_found_as_written', 'not checked', ''],
  ]);
  assert.strictEqual(r.claims[1].figure_checks[0].meaning, 'not checked'); // c2 was not reviewed
  // r10: the report text's figures take nothing from the claim figures they resemble: with only the claim answers, no mark in the text
  assert.strictEqual(r.prose, `## Verdict\nThe rate was 56.4% in the treatment arm (${MSRC}) against 43.6% in the control arm (${MSRC}).`);
  assert.strictEqual(r.claims[0].measured_result, '56.4% treatment, 43.6% [source says otherwise] control');
  assert.deepStrictEqual([r.totals.meaningMatches, r.totals.meaningDiffers, r.totals.proseMatches, r.totals.proseDiffers], [1, 1, 0, 0]);
  // the figures of the report text answer for themselves (p1 and p2): only "differs" is marked, once
  const pf = mProseFigs();
  assert.deepStrictEqual(pf.map((f) => f.fid), ['p1', 'p2']);
  const withProse = { ...keys, [pf[0].meaningKey]: { meaning: 'matches', quote: 'The response rate was 56.4% in the treatment arm' }, [pf[1].meaningKey]: { meaning: 'differs', quote: 'in the control arm' } };
  const rp = mCheck(withProse);
  assert.strictEqual(rp.prose, `## Verdict\nThe rate was 56.4% in the treatment arm (${MSRC}) against 43.6% [source says otherwise] in the control arm (${MSRC}).`);
  assert.deepStrictEqual([rp.totals.proseMatches, rp.totals.proseDiffers], [1, 1]);
  // checked again (its own output as input, or the same raw text again): the mark is not written twice
  assert.strictEqual(T.checkReport({ prose: rp.prose, claims: mClaims(), fetched: MFETCHED, counts: {}, meaningKeys: withProse }).prose, rp.prose);
  assert.strictEqual((mCheck(withProse).prose.match(/\[source says otherwise\]/g) || []).length, 1);
  // a prose figure of a claim that has no stored meaning stays "not checked": no mark, never "matches"
  const n = mCheck({});
  assert.ok(!n.prose.includes('[source says otherwise]'));
  assert.deepStrictEqual([n.totals.meaningMatches, n.totals.proseMatches], [0, 0]);
  assert.ok(n.claims.every((c) => c.figure_checks.every((f) => f.meaning === 'not checked' && f.meaning_quote === '')));
});

test('r9b no challenge: every figure "not checked", the summary says so, nothing reads matches', () => {
  for (const r of [mCheck(), mCheck(undefined), mCheck(null), mCheck({})]) {
    assert.ok(r.claims.every((c) => c.figure_checks.every((f) => f.meaning === 'not checked')));
    const t = T.chatReport({ prose: r.prose, claims: r.claims, totals: r.totals, files: {} });
    assert.match(t, /Means the same \(checked by the reviewer against the passage around each figure\): 0 matches; 0 differs \(marked "source says otherwise"\); 6 not checked\. Confirmed by both: 0 of 6 figures\./);
    assert.match(t, /Key evidence\n- No claim has all its figures confirmed by both checks/);
  }
  // the check itself did not run: the old line stays and the second line says so
  const none = T.chatReport({ prose: '## Verdict\nA.', claims: [], totals: {}, notChecked: true, files: {} });
  assert.match(none, /Figures not checked: the report had no list of claims/);
  assert.match(none, /\nMeans the same: not checked\.\n/);
  assert.doesNotMatch(none, /matches;/);
  assert.match(T.chatReport({ prose: '## Verdict\nA.', claims: [], totals: {}, checkError: true, files: {} }), /\nMeans the same: not checked\.\n/);
  // a stored entry in a wrong shape is no meaning
  const odd = mCheck({ [keyOfFid(mFigs(), 'c1.f1')]: { meaning: 'matches' }, x: 5 });
  assert.strictEqual(odd.claims[0].figure_checks[0].meaning, 'not checked');
});

test('r9b a revision after the review changes a figure\'s wording: its meaning is not checked', () => {
  const figs = mFigs();
  const keys = { [keyOfFid(figs, 'c1.f1')]: { meaning: 'matches', quote: 'The response rate was 56.4% in the treatment arm' } };
  assert.strictEqual(mCheck(keys).claims[0].figure_checks[0].meaning, 'matches');
  // the claim reworded
  const reworded = mClaims(); reworded[0].claim = 'Response rate was 56.4% in the treatment arm of adults';
  assert.strictEqual(mCheck(keys, reworded).claims[0].figure_checks[0].meaning, 'not checked');
  // only the way the figure is written changed: ~56.4%
  const rewritten = mClaims(); rewritten[0].figures = ['~56.4%', '43.6%', '9.9%']; rewritten[0].claim = 'Response rate was 56.4% in the treatment arm';
  const r = mCheck(keys, rewritten);
  assert.ok(r.claims[0].figure_checks.every((f) => f.meaning === 'not checked'));
  // a claim that did not change keeps its meaning, also when it is renumbered
  const renumbered = mClaims(); renumbered[0].id = 'c7';
  assert.strictEqual(mCheck(keys, renumbered).claims[0].figure_checks[0].meaning, 'matches');
});

test('r9b the two lines, the counts and Key evidence with a mix', () => {
  const figs = mFigs();
  const keys = {
    [keyOfFid(figs, 'c1.f1')]: { meaning: 'matches', quote: 'The response rate was 56.4% in the treatment arm' },
    [keyOfFid(figs, 'c1.f2')]: { meaning: 'differs', quote: 'in the control arm' },
    [keyOfFid(figs, 'c2.f1')]: { meaning: 'matches', quote: 'Enrolment was 1,250 participants' },
  };
  const r = T.checkReport({ prose: '## Verdict\nThe treatment arm did better.', claims: mClaims(), fetched: MFETCHED, counts: {}, meaningKeys: keys });
  const t = T.chatReport({ prose: r.prose, claims: r.claims, totals: r.totals, files: {} });
  assert.ok(t.includes('In the source (checked by code against the fetched text): 3 found as written; 1 not found as written (marked "not found in source"); 0 from sources that could not be opened (marked "source not opened"); 0 with no source to check.'));
  assert.ok(t.includes('Means the same (checked by the reviewer against the passage around each figure): 2 matches; 1 differs (marked "source says otherwise"); 1 not checked. Confirmed by both: 2 of 4 figures.'));
  assert.ok(t.includes(T.SCOPE_SENTENCE));
  assert.ok(t.indexOf('In the source') < t.indexOf('Means the same') && t.indexOf('Means the same') < t.indexOf(T.SCOPE_SENTENCE));
  assert.match(T.SCOPE_SENTENCE, /with its sign, currency, unit and the word right after it/);
  assert.match(T.SCOPE_SENTENCE, /a figure is confirmed only when both agree\.$/);
  // Key evidence: only the claim whose figures are all confirmed (c2); c1 has a figure that differs and one not found
  const ev = t.slice(t.indexOf('Key evidence'), t.indexOf('Corrections to the first pass'));
  assert.ok(ev.includes('Enrolment was 1,250 participants') && !ev.includes('Response rate was'));
  // a claim whose figures all match is key evidence unless the review doubted it
  const doubted = T.chatReport({ prose: r.prose, claims: r.claims, totals: r.totals, doubtedIds: ['c2'], files: {} });
  assert.doesNotMatch(doubted.slice(doubted.indexOf('Key evidence'), doubted.indexOf('Doubted by the review')), /Enrolment/);
  // found as written alone is no longer enough
  const nokeys = T.chatReport({ prose: r.prose, claims: mCheck({}).claims, totals: mCheck({}).totals, files: {} });
  assert.doesNotMatch(nokeys.slice(nokeys.indexOf('Key evidence'), nokeys.indexOf('Corrections')), /Enrolment/);
});

test('r9b the document: two columns, the section "Figures whose meaning differs", the scope sentence', () => {
  const figs = mFigs();
  const keys = {
    [keyOfFid(figs, 'c1.f1')]: { meaning: 'matches', quote: 'The response rate was 56.4% in the treatment arm' },
    [keyOfFid(figs, 'c1.f2')]: { meaning: 'differs', quote: 'in the control arm' },
  };
  const r = mCheck(keys);
  const { markdown, html } = T.renderDocument({ question: 'Q?', preparedDate: '2026-11-22', prose: r.prose, claims: r.claims, sources: MFETCHED, proseMissed: r.totals.proseMissed, reviewRounds: 1 });
  assert.match(markdown, /\| Our inference \| In the source \| Means the same \|\n\| --- \| --- \| --- \| --- \| --- \| --- \| --- \| --- \|/);
  assert.match(markdown, /\| 2 of 3 found as written \| 1 matches, 1 differs, 1 not checked \|/);
  assert.match(markdown, /\| 1 of 1 found as written \| 1 not checked \|/);
  assert.ok(markdown.includes(T.SCOPE_SENTENCE));
  assert.ok(markdown.indexOf('## Traceability') < markdown.indexOf(T.SCOPE_SENTENCE) && markdown.indexOf(T.SCOPE_SENTENCE) < markdown.indexOf('## Figures not found as written'));
  const at = markdown.indexOf('## Figures whose meaning differs');
  assert.ok(at > markdown.indexOf('## Figures not found as written') && at < markdown.indexOf('## Sources'));
  const sec = markdown.slice(at, markdown.indexOf('## Sources'));
  assert.ok(sec.includes('| 43.6% | c1: Response rate was 56.4% in the treatment arm | in the control arm | [Trial report](' + MSRC + ') |'));
  assert.ok(!sec.includes('56.4% | c1')); // the figure that matches is not listed
  assert.match(html, /<h2[^>]*>Figures whose meaning differs<\/h2>/);
  // all figures compared match: the section says None.
  const ok = mCheck({ [keyOfFid(figs, 'c1.f1')]: keys[keyOfFid(figs, 'c1.f1')] });
  const d2 = T.renderDocument({ question: 'Q?', prose: ok.prose, claims: ok.claims, sources: MFETCHED, reviewRounds: 1 }).markdown;
  assert.match(d2, /## Figures whose meaning differs\n\n[^\n]+\n\nNone\.\n/);
  // nothing compared: no section, one line
  const none = mCheck({});
  const d3 = T.renderDocument({ question: 'Q?', prose: none.prose, claims: none.claims, sources: MFETCHED, reviewRounds: 0 }).markdown;
  assert.ok(d3.includes("No figure's meaning was compared: the review did not run.") && !d3.includes('## Figures whose meaning differs'));
  const d4 = T.renderDocument({ question: 'Q?', prose: none.prose, claims: none.claims, sources: MFETCHED, reviewRounds: 2 }).markdown;
  assert.ok(d4.includes("No figure's meaning was compared: the reviewer compared none."));
  assert.match(d4, /\| 3 not checked \|/);
});

test('r9b reviseBrief: tells the reviser about figures that differ, strips the meaning fields', () => {
  const r = mCheck({});
  const claims = r.claims.map((c) => ({ ...c, meaning: 'matches', meaning_quote: 'SECRET-QUOTE' }));
  const b = T.reviseBrief('Q?', 'prose', claims, { results: [{ id: 'c1', verdict: 'partly', reason: 'r' }] }, [{ id: 'c1', fid: 'c1.f2', figure: '43.6%', quote: 'in the control arm' }]);
  assert.ok(b.includes('Figures whose passage says something different'));
  assert.ok(b.includes('- c1: "43.6%" | the source\'s passage says: "in the control arm"'));
  assert.match(b, /correct what the report says about it/);
  assert.doesNotMatch(b, /SECRET-QUOTE|meaning|figure_checks/);
  const plain = T.reviseBrief('Q?', 'prose', claims, { results: [] });
  assert.doesNotMatch(plain, /Figures whose passage says something different/);
});

// ---------------------------------------------------------------- r10: round-9 fixes
const NF = 'not_found_as_written';
const FD = 'found_as_written';

test('r10 1 visibleText: script, style, hidden elements and attributes with ">" are not source text', () => {
  for (const html of [
    '<script>1250</script>', '<style>1250</style>', '<noscript>1250</noscript>', '<template>1250</template>', '<head>1250</head>',
    '<svg>1250</svg>', '<textarea>1250</textarea>', '<iframe>1250</iframe>', '<object>1250</object>',
    '<span hidden>1250</span>', '<p aria-hidden="true">1250</p>', '<div style="display: none">1250</div>',
    '<div style="color:red; VISIBILITY : Hidden">1250</div>', '<DIV HIDDEN>1250</DIV>', '<div title="a>b 1250">x</div>',
    '<script>1250', // never closed: blanked to the end of the text
  ]) assert.strictEqual(T.checkFigure('1250', html), NF, html);
  // visible text stays
  assert.strictEqual(T.checkFigure('1250 users', '<p>1250 users</p>'), FD);
  assert.strictEqual(T.checkFigure('1250 users', '<script>9</script> 1250 users'), FD);
  assert.strictEqual(T.checkFigure('1250', '<p aria-hidden="false">1250</p>'), FD);
  assert.strictEqual(T.checkFigure('1250', '<div title="hidden">1250</div>'), FD); // "hidden" inside a value is no attribute
  assert.strictEqual(T.checkFigure('1250 users', '<br hidden> 1250 users'), FD); // a void element has no contents
  // an element longer than 20,000 characters: blanked from its opening tag to the end of the text
  assert.strictEqual(T.checkFigure('1250 users', '<div hidden>' + 'x '.repeat(11000) + '</div> 1250 users'), NF);
  assert.strictEqual(T.checkFigure('1250 users', '<div hidden>' + 'x '.repeat(5000) + '</div> 1250 users'), FD);
  // the visible text keeps its length (offsets stay valid)
  const html = 'a <script>var x = "1250";</script> b <p title="a>b">1250 users</p>';
  assert.strictEqual(T.checkFigure('1250 users', html), FD);
});

test('r10 1 tags with ">" in a quoted value are blanked in report text too, and the scan stays fast', () => {
  assert.deepStrictEqual(T.numbersIn('<div title="a>b 1250">x</div> 77').map((t) => t.value), ['77']);
  const t0 = Date.now();
  for (const text of ['<a "'.repeat(150000), '<div hidden>'.repeat(40000), '<p title="'.repeat(60000)]) T.checkFigure('1250', text);
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
});

test('r10 2 entities: numeric and the named list are decoded, an unknown name stays', () => {
  assert.strictEqual(T.checkFigure('1250', '&#x2212; 1250'), NF);
  assert.strictEqual(T.checkFigure('1250', '&#8722;1250'), NF);
  assert.strictEqual(T.checkFigure('-1250', '&#x2212;1250'), FD);
  assert.strictEqual(T.checkFigure('-1250', '&#8722;1250'), FD);
  assert.strictEqual(T.checkFigure('-1250', '&minus;1250'), FD);
  assert.strictEqual(T.checkFigure('1250', '&le; 1250'), NF);
  assert.strictEqual(T.checkFigure('at most 1250', '&le; 1250'), FD);
  assert.strictEqual(T.checkFigure('1250', '&foo;1250'), NF);
  assert.strictEqual(T.checkFigure('1250', '&amp;foo;1250'), NF);
  // other numeric entities and named ones: the character, padded to the length written
  assert.strictEqual(T.checkFigure('1250', '&#36;1250'), NF);       // "$" : a currency figure, not the bare number
  assert.strictEqual(T.checkFigure('$1250', '&dollar;1250'), FD);
  assert.strictEqual(T.checkFigure('1250%', '1250&percnt;'), FD);
  assert.strictEqual(T.checkFigure('1250 users', '1250&nbsp;users'), FD);
  assert.strictEqual(T.checkFigure('1250 users', '1250&thinsp;users'), FD);
  assert.strictEqual(T.checkFigure('1250 users', '&#49;250 users'), FD); // the padding goes before the digit: "1" and "250" are one number
  // one pass only: "&amp;lt;" is the text "&lt;", not "<"
  assert.strictEqual(T.checkFigure('<1250', '&amp;lt;1250'), NF);
  assert.strictEqual(T.checkFigure('<1250', '&lt;1250'), FD);
});

// r10 3-5: one claim, one source, the figure and a report text
const R_SRC = 'https://s.example/enrol';
const rFigs = (text, claim, figure) => {
  const fetched = [{ url: R_SRC, title: 'Enrolment study', ok: true, text }];
  const claims = [{ id: 'c1', claim, source_url: R_SRC, figures: [figure] }];
  return { fetched, claims, figs: T.figureExcerpts(T.checkReport({ prose: 'x', claims, fetched }).claims, fetched) };
};
const rAnswer = (figs, quote, meaning = 'matches', fid = 'c1.f1') => T.figureMeanings(figs, { results: [{ id: 'c1', figures: [{ fid, meaning, quote }] }] });

test('r10 3 a "matches" quote must cover the occurrence that matched, not the same digits elsewhere', () => {
  const text = 'Enrollment totaled 1250 participants. Screening found 12500 candidates.';
  const { figs } = rFigs(text, 'Enrollment totaled 1250 participants', '1250 participants');
  const at = figs[0].excerpt.indexOf('1250'); // the span is the number as written (with sign and unit when it has them; "participants" is no unit)
  assert.deepStrictEqual(figs[0].span, { start: at, end: at + 4 });
  assert.deepStrictEqual(rAnswer(figs, 'Screening found 12500 candidates.').keys, {});
  assert.deepStrictEqual(Object.values(rAnswer(figs, 'Enrollment totaled 1250 participants').keys), [{ meaning: 'matches', quote: 'Enrollment totaled 1250 participants' }]);
  // a "differs" quote only has to be in the passage
  assert.deepStrictEqual(Object.values(rAnswer(figs, 'Screening found 12500 candidates.', 'differs').keys), [{ meaning: 'differs', quote: 'Screening found 12500 candidates.' }]);
  // "In 2020, accuracy was 20%": the 20 of 2020 is not the figure
  const b = rFigs('In 2020, accuracy was 20% for the classifier.', 'The classifier reached 20%', '20%');
  assert.deepStrictEqual(rAnswer(b.figs, 'In 2020, accuracy').keys, {});
  assert.strictEqual(Object.keys(rAnswer(b.figs, 'accuracy was 20% for the classifier').keys).length, 1);
  // the span is right after white space is collapsed (line breaks, several spaces, a sign)
  const c = rFigs('Net change\n\n   was   −12.5 ms\nin the hard split overall.', 'Net change was -12.5 ms', '-12.5 ms');
  assert.strictEqual(Object.keys(rAnswer(c.figs, 'change was −12.5 ms in the hard split').keys).length, 1);
  assert.deepStrictEqual(rAnswer(c.figs, 'was 12.5 ms in the hard').keys, {}); // without the sign
  assert.deepStrictEqual(rAnswer(c.figs, 'change was −12.5').keys, {});        // stops before the unit
});

const REPORT_TEXT = (verb = 'killed') => `## Verdict\nThe treatment ${verb} 1250 participants (${R_SRC}).`;
test('r10 4 a figure of the report text is compared on its own: no meaning inherited from a claim figure', () => {
  const { fetched, claims, figs } = rFigs('Enrollment totaled 1250 participants. Screening found 12500 candidates.', 'Enrollment totaled 1250 participants', '1250 participants');
  const keys = Object.fromEntries(Object.values(rAnswer(figs, 'Enrollment totaled 1250 participants').keys).length ? Object.entries(rAnswer(figs, 'Enrollment totaled 1250 participants').keys) : []);
  const check = (prose, k) => T.checkReport({ prose, claims, fetched, counts: {}, meaningKeys: k });
  // the claim figure matches; the report text's own figure is not checked
  const r = check(REPORT_TEXT(), keys);
  assert.strictEqual(r.claims[0].figure_checks[0].meaning, 'matches');
  assert.deepStrictEqual([r.totals.proseFound, r.totals.proseMatches, r.totals.proseDiffers], [1, 0, 0]);
  // the entry: fid p1, the whole sentence (no heading), the passage cut around the source occurrence that matched
  const all = T.figureExcerpts(T.checkReport({ prose: REPORT_TEXT(), claims, fetched }).claims, fetched, undefined, { prose: REPORT_TEXT(), counts: {} });
  const p = all.filter((f) => f.prose);
  assert.strictEqual(p.length, 1);
  assert.deepStrictEqual([p[0].fid, p[0].id, p[0].n, p[0].figure], ['p1', 'report', 1, '1250']); // the figure as the report text writes it (with its sign and unit, if it has them)
  assert.strictEqual(p[0].sentence, `The treatment killed 1250 participants (${R_SRC}).`);
  assert.ok(p[0].excerpt.includes('Enrollment totaled 1250 participants'));
  assert.ok(all.some((f) => f.fid === 'c1.f1'), 'the claim entries are still there');
  // the key follows sha256('prose|' + sentence + '|' + value, unit, form, qual + '|' + passage)
  const fig = T.parseFigure('1250 participants');
  assert.strictEqual(p[0].meaningKey, require('crypto').createHash('sha256').update(['prose', p[0].sentence, fig.value, fig.unit, fig.form, fig.qual, p[0].excerpt].join('|')).digest('hex'));
  // the reviewer answers p1 under {"id": "report"}: validated like the others, no verdict, no claim result
  const reply = jsonReply([{ id: 'c1', verdict: 'supported', reason: 'r', figures: [] }, { id: 'report', figures: [{ fid: 'p1', meaning: 'matches', quote: 'Enrollment totaled 1250 participants' }] }]);
  const parsed = T.parseChallenge(reply, ['c1'], all);
  assert.deepStrictEqual(parsed.results.map((x) => x.id), ['c1']);
  assert.deepStrictEqual([parsed.unknown, parsed.missing, parsed.counts.supported], [[], [], 1]);
  const fm = T.figureMeanings(all, parsed);
  assert.deepStrictEqual(Object.values(fm.keys), [{ meaning: 'matches', quote: 'Enrollment totaled 1250 participants' }]);
  const answered = check(REPORT_TEXT(), { ...keys, ...fm.keys });
  assert.deepStrictEqual([answered.totals.proseMatches, answered.totals.proseDiffers], [1, 0]);
  // a revised sentence has a new key: not checked again
  const revised = check(REPORT_TEXT('harmed'), { ...keys, ...fm.keys });
  assert.deepStrictEqual([revised.totals.proseFound, revised.totals.proseMatches], [1, 0]);
  // a "differs" answer for p1 marks the figure in the text
  const dq = { fid: 'p1', meaning: 'differs', quote: 'Screening found 12500 candidates.' };
  const dfm = T.figureMeanings(all, T.parseChallenge(jsonReply([{ id: 'report', figures: [dq] }, { id: 'c1', verdict: 'supported' }]), ['c1'], all));
  assert.strictEqual(check(REPORT_TEXT(), dfm.keys).prose, `## Verdict\nThe treatment killed 1250 [source says otherwise] participants (${R_SRC}).`);
  // an answer for a fid that was not presented, or for report with a claim's fid, is dropped
  const stray = T.parseChallenge(jsonReply([{ id: 'report', figures: [{ fid: 'p9', meaning: 'matches', quote: 'whatever it says' }, { fid: 'c1.f1', meaning: 'matches', quote: 'Enrollment totaled 1250 participants' }] }, { id: 'c1', verdict: 'supported' }]), ['c1'], all);
  assert.deepStrictEqual(stray.report.figures, []);
});

test('r10 4 the brief lists the figures of the report text in their own block; at most 60, in text order', () => {
  const { fetched, claims, figs } = rFigs('Enrollment totaled 1250 participants.', 'Enrollment totaled 1250 participants', '1250 participants');
  const prose = REPORT_TEXT();
  const all = T.figureExcerpts(T.checkReport({ prose, claims, fetched }).claims, fetched, undefined, prose);
  const b = T.challengeBrief('Q?', T.checkReport({ prose, claims, fetched }).claims, T.challengeExcerpts(claims, fetched), all);
  assert.ok(b.includes('Figures in the report text to compare (each with the sentence of the report that holds it and the passage the hub cut from the source around it):'));
  assert.ok(b.includes(`  [p1] the report writes: "The treatment killed 1250 participants (${R_SRC})." | the figure: 1250 | passage: "`));
  assert.ok(b.includes('{"id": "report", "figures": [{"fid": "p1"'));
  assert.match(b, /\{"id": "report", "figures": \[\.\.\.\]\}; it has no verdict/);
  assert.ok(b.indexOf('[p1]') > b.indexOf('[c1.f1]'), 'the claim figures come first');
  // none without report figures
  const none = T.challengeBrief('Q?', T.checkReport({ prose, claims, fetched }).claims, T.challengeExcerpts(claims, fetched), figs);
  assert.ok(!none.includes('Figures in the report text') && !none.includes('"report"'));
  // the cap: 70 distinct figures in the text give 60 entries
  const nums = Array.from({ length: 70 }, (_, i) => String(31001 + i));
  const text = nums.map((n) => `Value ${n} was seen.`).join(' ');
  const f2 = [{ url: R_SRC, ok: true, text }];
  const c2 = [{ id: 'c1', claim: 'Values were seen', source_url: R_SRC, figures: ['31001'] }];
  const long = nums.map((n) => `Value ${n} was seen (${R_SRC}).`).join('\n\n');
  const ent = T.figureExcerpts(T.checkReport({ prose: long, claims: c2, fetched: f2 }).claims, f2, undefined, long).filter((f) => f.prose);
  assert.strictEqual(ent.length, 60);
  assert.deepStrictEqual(ent.slice(0, 3).map((f) => [f.fid, f.figure]), [['p1', '31001'], ['p2', '31002'], ['p3', '31003']]);
  // a sentence longer than 400 characters is cut to 400 around the figure
  const wordy = `${'word '.repeat(150)}had 1250 participants ${'more '.repeat(150)}(${R_SRC}).`;
  const w = T.figureExcerpts(T.checkReport({ prose: wordy, claims, fetched }).claims, fetched, undefined, wordy).filter((f) => f.prose);
  assert.ok(w[0].sentence.length <= 400 && w[0].sentence.includes('1250 participants'), String(w[0].sentence.length));
});

test('r10 5 a "differs" is never overwritten by a "matches" for the same key: within a round and across rounds', () => {
  const figs = mFigs();
  const key = keyOfFid(figs, 'c1.f2');
  const Q = 'The response rate was 56.4% in the treatment arm and 43.6% in the control arm';
  const reply = (...items) => ({ results: [{ id: 'c1', verdict: 'supported', figures: items }] });
  const m = { fid: 'c1.f2', meaning: 'matches', quote: Q };
  const d = { fid: 'c1.f2', meaning: 'differs', quote: 'in the control arm' };
  const d2 = { fid: 'c1.f2', meaning: 'differs', quote: 'treatment arm and 43.6%' };
  // within one round (the same key answered twice): both orders
  assert.deepStrictEqual(T.figureMeanings(figs, reply(m, d)).keys, { [key]: { meaning: 'differs', quote: 'in the control arm' } });
  assert.deepStrictEqual(T.figureMeanings(figs, reply(d, m)).keys, { [key]: { meaning: 'differs', quote: 'in the control arm' } });
  assert.deepStrictEqual(T.figureMeanings(figs, reply(d, m)).differs.map((x) => x.quote), ['in the control arm']);
  // a differs is replaced by a newer differs
  assert.deepStrictEqual(T.figureMeanings(figs, reply(d, d2)).keys, { [key]: { meaning: 'differs', quote: 'treatment arm and 43.6%' } });
  assert.deepStrictEqual(T.figureMeanings(figs, reply(d, d2)).differs.map((x) => x.quote), ['treatment arm and 43.6%']);
  // a matches can be replaced by a differs, and by a newer matches
  assert.strictEqual(T.figureMeanings(figs, reply(m, d)).keys[key].meaning, 'differs');
  // across rounds (mergeMeanings, as the runner stores the answers)
  const matches = { meaning: 'matches', quote: Q };
  const differs = { meaning: 'differs', quote: 'in the control arm' };
  assert.deepStrictEqual(T.mergeMeanings({ [key]: differs }, { [key]: matches }), { [key]: differs });
  assert.deepStrictEqual(T.mergeMeanings({ [key]: matches }, { [key]: differs }), { [key]: differs });
  assert.deepStrictEqual(T.mergeMeanings({ [key]: differs }, { [key]: { meaning: 'differs', quote: 'a newer quote' } }), { [key]: { meaning: 'differs', quote: 'a newer quote' } });
  assert.deepStrictEqual(T.mergeMeanings({ [key]: matches }, { [key]: { meaning: 'matches', quote: 'a newer quote' } }), { [key]: { meaning: 'matches', quote: 'a newer quote' } });
  assert.deepStrictEqual(T.mergeMeanings({ other: matches }, { [key]: differs }), { other: matches, [key]: differs });
});

test('r10 6 a number inside a compound run is indexed only as the compound', () => {
  const kw = ['users']; // a common number (below 1000) needs a keyword of the claim near it
  assert.strictEqual(T.checkFigure('10 users', '5 to 10 users', kw), NF);
  assert.strictEqual(T.checkFigure('5 to 10 users', '5 to 10 users', kw), FD);
  assert.strictEqual(T.checkFigure('10%', '5–10% users', kw), NF);
  assert.strictEqual(T.checkFigure('5–10%', '5–10% users', kw), FD);
  assert.strictEqual(T.checkFigure('1250', 'a ratio of 3:1250.'), NF);
  assert.strictEqual(T.checkFigure('1250', 'a 1250. and then 3:4'), FD); // a number outside any run is still itself
  // the reviewer's excerpt for a compound figure is still cut around the compound
  const fetched = [{ url: R_SRC, ok: true, text: 'Latency was 5 to 10 ms in the lab trial.' }];
  const claims = [{ id: 'c1', claim: 'Latency was 5 to 10 ms', source_url: R_SRC, figures: ['5 to 10 ms'] }];
  const ex = T.challengeExcerpts(claims, fetched);
  assert.ok(ex[0].excerpts[0].includes('5 to 10 ms'));
  assert.strictEqual(T.figureExcerpts(T.checkReport({ prose: 'x', claims, fetched }).claims, fetched).length, 1);
});
