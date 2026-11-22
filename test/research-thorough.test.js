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
  // (real-eval fix: the next ordinary word is no part of the written form any more, so "1450" is found for "1,450 items")
  assert.strictEqual(T.checkFigure('1450', SOURCE, []), 'found_as_written');
  assert.strictEqual(T.checkFigure('1,450 items', SOURCE, []), 'found_as_written');
  // -3.2 has 2 significant digits, so it is now a common number (r2 fix 6) and needs a keyword nearby (r8: and its next word "points")
  assert.strictEqual(T.checkFigure('-3.2 points', SOURCE, ['points']), 'found_as_written');
  assert.strictEqual(T.checkFigure('-3.2 points', SOURCE, []), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('-3.2', SOURCE, ['points']), 'found_as_written'); // real-eval fix: "points" is an ordinary word, not part of the form
  // r9a: "and" and "a drop" are ordinary words after the number: no part of the written form (real-eval fix), so a bare 0.550 is found
  assert.strictEqual(T.checkFigure('0.550', SOURCE, []), 'found_as_written');
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
  // real-eval fix: the counts are two or three plain sentences with the exact numbers
  assert.match(t, /Of 10 figures, 7 were found in their sources as written and 3 were not; 0 had no source to check and 1 came from a source that could not be opened\. The reviewer confirmed the meaning of 0, found 0 that differ, and did not check 10\.\n/);
  assert.match(t, /Challenged by: GPT-5 \(2 rounds\)/);
  // real-eval fix: each full path alone in backticks on its own line (the chat shows a download card)
  assert.match(t, /\nFull document:\n`\/f\/r\.md`\n/);
  assert.match(t, /\nPDF:\n`\/f\/r\.pdf`\n/);
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
  assert.strictEqual(T.checkFigure('125', 'We enrolled 125 participants.', ['participants']), 'found_as_written'); // real-eval fix: "participants" is no part of the form (r8 had: not found)
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
  // (still not found, now for another reason: 125 is a common number and no word of this claim stands near it in the source)
  assert.strictEqual(T.checkClaims([{ ...claims[0], claim: '125 adults achieved 83% accuracy' }], F2).claims[0].figures[0].status, 'not_found_as_written');
  // real-eval fix: the ordinary word after the number is no part of the form: with a claim word near the number it is found
  assert.strictEqual(T.checkClaims([{ ...claims[0], claim: '125 enrolled adults achieved 83% accuracy' }], F2).claims[0].figures[0].status, 'found_as_written');
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
  // r8: Study B's source is not cited by any claim: no source to check
  assert.match(lines[1], /125 \[no source to check\]/);
  // real-eval fix: the figure with no citation at all takes the source of the one claim whose figure is written the same ("125 participants"):
  // it is checked against Study A's source and found, so it carries no mark (it said "no source to check" before)
  assert.doesNotMatch(r.prose, /Elsewhere 125 \[/);
  assert.strictEqual(r.marks, 1);
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
    assert.deepStrictEqual(r.totals, { claims: 0, figures: 0, found: 0, notFound: 0, notOpened: 0, noSource: 0, proseFigures: 2, proseFound: 0, proseNotFound: 0, proseNotOpened: 0, proseNoSource: 0, proseNotChecked: 2, sourcesReading: 2, sourcesConverted: 0, sourcesUnreadable: 0, tableFigures: 0, tableFound: 0, tableNotFound: 0, tableNotOpened: 0, tableNoSource: 0 }); /* r14: the source counts ride along; real-eval fix: the claims-table counts too */ // r8: the figures are counted as not checked, not as no source
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
  assert.strictEqual(T.checkFigure('0.05', text, ['beta']), 'found_as_written'); // real-eval fix: "and" is no part of the form (r9a had: not found)
  assert.strictEqual(T.checkFigure('450 workers', text, []), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('450 workers', text, ['workers']), 'found_as_written');
  assert.strictEqual(T.checkFigure('450', text, ['workers']), 'found_as_written'); // real-eval fix: a bare 450 is "450 workers" ("workers" is no part of the form)
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
  assert.strictEqual(T.checkFigure('300k', 'Served 300,000 requests.', []), 'found_as_written'); // real-eval fix: "requests" is no part of the form (r8 had: not found)
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
  // real-eval fix: "12.5 and" and "12.5 again" have the same written form (an ordinary word is no part of it): one figure (r8 had: two)
  assert.strictEqual(T.checkClaims([{ id: 'c', claim: 'Gain of 12.5 and 12.5 again', source_url: 'https://a.example/a', figures: ['12.5'] }], fetched).totals.figures, 1);
  // a unit still makes two forms: "12.5 ms" is not "12.5 s"
  assert.strictEqual(T.checkClaims([{ id: 'c', claim: 'Gain of 12.5 ms and 12.5 s', source_url: 'https://a.example/a', figures: [] }], fetched).totals.figures, 2);
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
  // real-eval fix: the counts are plain sentences with the exact numbers
  assert.match(t, /Of 16 figures, 9 were found in their sources as written and 7 were not; 3 had no source to check and 1 came from a source that could not be opened\./);
  const t1 = T.chatReport({ prose: '## Verdict\nA.', claims: [], totals: { ...totals, proseNoSource: 1 }, files: {} });
  assert.match(t1, /; 1 had no source to check and/);
  // totals saved by an older run have proseUnverified (figures not tied to a checked source): counted as no source to check
  const old = T.chatReport({ prose: '## Verdict\nA.', claims: [], totals: { claims: 3, figures: 10, found: 7, notFound: 2, notOpened: 1, proseFigures: 5, proseVerified: 2, proseUnverified: 3 }, files: {} });
  assert.match(old, /Of 13 figures, 7 were found in their sources as written and 6 were not; 3 had no source to check and 1 came from a source that could not be opened\./);
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
  // real-eval fix: its clause cites nothing, but exactly one claim (c1, source A) has this figure written the same: it is checked against A
  assert.ok(!/56\.4% \[/.test(n.prose));
  assert.ok(!/60\.2% \[[a-z ]+\]/.test(n.prose));
  // the same figure in two claims with different sources: still no source to check
  const dup = T.checkReport({ prose: `A reached 56.4% on X, 3.2 points above baseline (${A}), while B reached 60.2% (${B})`, claims: [...claims, { id: 'c3', claim: 'B also', source_url: B, figures: ['56.4%'] }], fetched, counts: {} });
  assert.match(dup.prose, /56\.4% \[no source to check\] on X/);
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
  assert.strictEqual(cf('C$5,000', 'paid C$5,000 today'), 'found_as_written'); // real-eval fix: "today" is an ordinary word, no part of the form
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
  assert.strictEqual(cf7('1,250', 'we had 1,250 participants'), 'found_as_written'); // real-eval fix: the next ordinary word is no part of the form (r8 had: not found)
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
  assert.strictEqual(T.checkFigure('4,200', text), 'found_as_written'); // "4,200 c": the word "c" is no part of its form (real-eval fix)
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
  // real-eval fix: "overall" is an ordinary word, no part of the form either (it was: not found)
  assert.strictEqual(judge('1,250 in total', '1,250 overall.'), 'found');
  assert.strictEqual(judge('1,250 overall', '1,250 overall.'), 'found');
  assert.strictEqual(judge('1,250', '1,250 overall.'), 'found');
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
  same('1,250 participants', '1,250 people') /* real-eval fix: an ordinary word is no part of the form (it was a near miss) */; diff('5 MB', '5 MiB'); diff('5 ton', '5 tonne'); diff('5 kg', '5 kilogram');
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
  // r16: a "(" directly followed by "±" is the plus-or-minus tail of the figure's form, so a source without that tail does not state this figure
  assert.strictEqual(T.checkFigure('85.2% (±1.3)', 'the score was 85.2% on test'), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('85.2% (±1.3)', 'the score was 85.2% (±1.3) on test'), 'found_as_written');
  // real-eval fix: "last" and a parenthesised year are ordinary words, no part of the form (they were)
  assert.strictEqual(T.checkFigure('$5.2B (2023)', 'revenue of $5.2 billion last year'), 'found_as_written');
  assert.strictEqual(T.checkFigure('$5.2B (2023)', 'revenue of $5.2 billion.'), 'found_as_written');
  // a unit in the parentheses still counts: "(USD)" is the dollar, "(EUR)" is not
  assert.strictEqual(T.checkFigure('5.2 billion (USD)', 'revenue of 5.2 billion (EUR).'), 'not_found_as_written');
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
  const line = T.chatReport({ prose: r.prose, claims: r.claims, totals: r.totals, files: {} }).split('\n').find((l) => /^Of \d+ figures/.test(l)); // real-eval fix: the counts are plain sentences
  assert.strictEqual(line, 'Of 4 figures (4 of them in the claims table), 1 was found in its source as written and 3 were not; 1 had no source to check and 1 came from a source that could not be opened. The reviewer confirmed the meaning of 0, found 0 that differ, and did not check 4.');
  // prose figures are counted too, with the three marks
  const prose = `Alpha had 1,250 participants (${A}). Beta had 900 participants (${B}). Gamma had 77 widgets (${C}).\n\nDelta had 55 things.`;
  const p = T.checkReport({ prose, claims, fetched });
  assert.strictEqual(p.prose, `Alpha had 1,250 participants (${A}). Beta had 900 [not found in source] participants (${B}). Gamma had 77 [source not opened] widgets (${C}).\n\nDelta had 55 [no source to check] things.`);
  assert.deepStrictEqual([p.totals.proseFound, p.totals.proseNotFound, p.totals.proseNotOpened, p.totals.proseNoSource], [1, 1, 1, 1]);
  const both = T.chatReport({ prose, claims: p.claims, totals: p.totals, files: {} });
  assert.match(both, /Of 8 figures \(4 of them in the claims table\), 2 were found in their sources as written and 6 were not; 2 had no source to check and 2 came from sources that could not be opened\./);
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
    { id: 'c2', claim: 'Beta survey', source_url: B, figures: ['1,250 ms'] }, // real-eval fix: was "1,250 adults" (an ordinary word is no part of the form now)
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
  // 1,250 ms vs 1,250 participants: the source's wording is shown, never counted as found
  assert.match(rows[1], /^\| 1,250 ms \| \[Beta study\]\(https:\/\/b\.example\/2\) \| "[^"|]*1,250 participants[^"|]*" \|$/);
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
  assert.notStrictEqual(T.claimKey({ ...base, figures: ['1,250 ms'] }), k); // real-eval fix: was "1,250 adults" (an ordinary word is no part of the form now)
  assert.strictEqual(T.claimKey({ ...base, figures: ['1,250 adults'] }), k);
  assert.strictEqual(T.claimKey({ ...base, id: 'c7' }), k);
  assert.strictEqual(T.claimKey({ ...base, id: 'c7', figures: ['1,250 participants'] }), k);
});

// ================================================================ r9a: fixes to "found as written"
// pairs: [figure, source text, 'found' | 'not found']. Each pair runs twice: through checkFigure (the claim figure against the text) and
// through checkReport (claim status and the mark in the report text, see judge).
function pairs(list) {
  for (const [fig, src, want] of list) {
    if (want === 'unreadable') { // r14: raw HTML the check does not read as plain text: source not opened, never found (both ways)
      assert.strictEqual(T.checkFigure(fig, 'Reported measurement: ' + src, ['reported']), 'source_not_opened', `checkFigure: ${fig} vs ${src}`);
      const rep = T.checkReport({ prose: `The reported measurement was ${fig} (${R8A}).`, claims: [{ id: 'c1', claim: 'Reported measurement', source_url: R8A, figures: [fig] }], fetched: [{ url: R8A, title: 'Paper', ok: true, text: 'Reported measurement: ' + src }] });
      assert.strictEqual(rep.claims[0].check_status, 'source_not_opened', `report: ${fig} vs ${src}`);
      assert.strictEqual(rep.claims[0].check, 'source could not be read in a checkable form');
      continue;
    }
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
    ['1250', '<!-- benchmark: 1250 -->', 'unreadable'], // r14: a comment makes the source unreadable (was: not found)
    ['1250', 'before <!-- a\nmulti-line 1250\ncomment --> after', 'unreadable'], // r14: same
    ['1250', '\n[ref]: /path " 1250 "', 'not found'], // a reference definition is a whole line
    ['1250', "\n[ref]: <https://example.org/a> '1250'", 'not found'], // real-eval fix: "<https:...>" is no tag (only known HTML elements are): a reference definition, blanked (r14: unreadable)
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
    ['1250', '<td>1250</td>', 'unreadable'], // r16: nothing is converted, any tag start is unreadable (was: found)
    ['1250', '<span class="x">1250</span> people', 'unreadable'], // r14: a tag with a class is unreadable (was: not found)
    ['1250 people', '<span class="x">1250</span> people', 'unreadable'], // r14: same (r11: was not found)
    ['1250', '<p>1250</p>', 'unreadable'], // r16: same (was: found)
    ['1250', '[1250](https://example.org/x)', 'found'], // the link text stays
  ]);
  // r16: a footnote line looks like a reference definition and code cannot be sure it is not one: blanked (was: found)
  assert.strictEqual(T.checkFigure('1250', '[^1]: the cost was 1250'), 'not_found_as_written');
  // offsets stay valid for the numbers after the removed parts
  const t = '[y]: /p "t"\n[x](http://a.example/p)\n4,200 units'; // r14: no comment (a comment makes the source unreadable); r16: a link blanks the rest of its line
  assert.strictEqual(T.checkFigure('4,200 units', t), 'found_as_written');
  // "&nbsp;" is white space of the same length (not one space: "1250&nbsp;mg" is not read as the unit "mg"; fail-safe)
  assert.strictEqual(T.checkFigure('1250 mg', 'dose 1250&nbsp;mg'), 'not_found_as_written');
  assert.strictEqual(T.checkFigure('1250', 'dose 1250&nbsp;.'), 'found_as_written');
});

test('r9a-3 markup between a sign or currency and the digits is not part of the form (sources and report text)', () => {
  pairs([
    ['1250', 'Total: **−** 1250', 'not found'],
    ['-1250', 'Total: **−** 1250', 'found'],
    ['-1250', 'Total: <b>-</b> 1250', 'unreadable'], // r16: any tag start is unreadable (was: found)
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
    // real-eval fix: an ordinary word is no part of the form, so its case does not matter (these two were: not found)
    ['1250 participants', '1250 PARTICIPANTS', 'found'],
    ['1250 kids', '1250 Kids', 'found'],
    ['1250 mL', '1250 ML', 'not found'], // a unit word keeps its case as written
    ['1250 mbar', '1250 MBAR', 'not found'],
  ]);
});

test('r9a-5 words after a number: the shorter function-word list, bounds, rates, symbols and parentheses', () => {
  pairs([
    // real-eval fix: "in", "only", "and", "still", "then" are ordinary words after a number: no part of the form (they were words of the form: not found)
    ['1250', 'Length: 1250 in.', 'found'],
    ['1250', '1250 in thousands', 'found'],
    ['1250', '1250 only', 'found'],
    ['1250', '1250 and 300', 'found'],
    ['1250 and', '1250 and 300', 'found'],
    ['1250', '1250 still', 'found'],
    ['1250', '1250 then', 'found'],
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
    ['1250', '1250 (n=20)', 'found'], // real-eval fix: a parenthesised group of ordinary words is no part of the form (it was)
    ['1250 (USD)', '1250 (USD)', 'found'],
    ['1250 (EUR)', '1250 (USD)', 'not found'], // a unit in the group still counts
    // r15 3: what follows a plus-or-minus sign is part of the form ("1250 ±" no longer matches "1250 ± 50")
    ['1250 ±', '1250 ± 50', 'not found'],
    ['1250 ± 50', '1250 ± 50', 'found'],
    ['1250', '1250 | 300 |', 'found'], // a table bar is no word
    ['1250', '1250 - 300', 'found'], // a lone dash is no word
    ['1250', '1250 (https://example.org/x)', 'found'], // a citation is no word (in a source its address is blanked: nothing is left)
    ['1250', '1250 (see https://example.org/x)', 'found'], // real-eval fix: "see" is an ordinary word in a parenthesised group, no part of the form (it was: not found)
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
  // real-eval fix: a second claim, with another source, states the same figure: an uncited figure has no single claim to take its source from
  // (with one claim only, it would be checked against that claim's source)
  const claims = [{ id: 'c1', claim: 'Reported measurement', source_url: R8A, figures: ['1250 users'] }, { id: 'c2', claim: 'Other measurement', source_url: 'https://other.example/z', figures: ['1250 users'] }];
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
  // (r15 2: a destination that never closes is blanked to the end of its line, so the figure stands on a line of its own)
  const evil = '](' .repeat(300000) + '\n 1250 users';
  const t0 = Date.now();
  assert.strictEqual(T.checkFigure('1250 users', evil.slice(-600000)), 'found_as_written');
  for (const text of ['](' .repeat(300000), '*'.repeat(600000), '*a '.repeat(200000), '<!--'.repeat(150000), '<a '.repeat(200000), '&lt;'.repeat(150000), ']((((((('.repeat(70000)]) {
    T.checkFigure('1250', text);
  }
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  // a link destination with one level of parentheses is blanked whole; its figures are not source text
  assert.strictEqual(T.checkFigure('1250', '[Foo](https://en.example/wiki/Foo_(bar)_1250)'), 'not_found_as_written');
  // r17 4: the destination ends at its matching ")" (nested parentheses counted), so text after the link on the same line is text again
  // (was r16: the rest of the line was blanked: 'not_found_as_written')
  assert.strictEqual(T.checkFigure('1250', '[Foo](https://en.example/wiki/Foo_(bar)_1250) and 1250'), 'found_as_written');
  assert.strictEqual(T.checkFigure('1250', '[Foo](https://en.example/wiki/Foo_(bar)_1250)\nand 1250'), 'found_as_written');
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
    assert.match(t, /The reviewer confirmed the meaning of 0, found 0 that differ, and did not check 6\./); // real-eval fix: plain sentences
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
  // real-eval fix: the counts are plain sentences
  assert.ok(t.includes('Of 4 figures (4 of them in the claims table), 3 were found in their sources as written and 1 was not; 0 had no source to check. The reviewer confirmed the meaning of 2, found 1 that differs, and did not check 1.'));
  assert.ok(t.includes(T.SCOPE_SENTENCE));
  assert.ok(t.indexOf('Of 4 figures') < t.indexOf('The reviewer confirmed') && t.indexOf('The reviewer confirmed') < t.indexOf(T.SCOPE_SENTENCE));
  assert.match(T.SCOPE_SENTENCE, /with its sign, currency, unit, scale and rate/); // real-eval fix: "the word right after it" is no part of the check any more
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
  ]) assert.strictEqual(T.checkFigure('1250', html), 'source_not_opened', html); // r14: each is unreadable (was: not found)
  // visible text stays
  assert.strictEqual(T.checkFigure('1250 users', '<p>1250 users</p>'), 'source_not_opened'); // r16: nothing is converted (was: found)
  // r14: the rest are raw HTML the check does not read (was: found / not found); the visibleText pass itself is tested directly
  const NO = 'source_not_opened';
  assert.strictEqual(T.checkFigure('1250 users', '<script>9</script> 1250 users'), NO);
  assert.strictEqual(T.checkFigure('1250', '<p aria-hidden="false">1250</p>'), NO);
  assert.strictEqual(T.checkFigure('1250', '<div title="hidden">1250</div>'), NO);
  assert.strictEqual(T.checkFigure('1250 users', '<br hidden> 1250 users'), NO);
  assert.strictEqual(T.visibleText('<br hidden> 1250 users').trim(), '1250 users'); // a void element has no contents
  // an element longer than 20,000 characters: blanked from its opening tag to the end of the text
  assert.strictEqual(T.checkFigure('1250 users', '<div hidden>' + 'x '.repeat(11000) + '</div> 1250 users'), NO);
  assert.strictEqual(T.visibleText('<div hidden>' + 'x '.repeat(11000) + '</div> 1250 users').includes('1250'), false);
  assert.strictEqual(T.visibleText('<div hidden>' + 'x '.repeat(5000) + '</div> 1250 users').includes('1250 users'), true);
  // the visible text keeps its length (offsets stay valid)
  const html = 'a <script>var x = "1250";</script> b <p>1250 users</p> <a href="x>y">c</a>';
  assert.strictEqual(T.checkFigure('1250 users', html), NO);
  assert.strictEqual(T.checkFigure('1250 users', 'b <p title="a>b">1250 users</p>'), NO);
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
  // r16: the key follows sha256('prose|' + JSON of [heading path, block, position in the block, value, unit, form, qual, passage])
  const fig = T.parseFigure('1250 participants');
  assert.strictEqual(p[0].heading, 'Verdict');
  assert.strictEqual(p[0].meaningKey, require('crypto').createHash('sha256').update(['prose', JSON.stringify(['Verdict', p[0].sentence, 0, fig.value, fig.unit, fig.form, fig.qual, p[0].excerpt])].join('|')).digest('hex'));
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
  // r12: the heading, and the sentence with the occurrence marked ⟦ ⟧
  assert.ok(b.includes('Figures in the report text to compare (each with the heading it stands under, the sentence of the report that holds it with the occurrence to compare marked ⟦ ⟧, and the passage the hub cut from the source around it):'));
  assert.ok(b.includes(`  [p1] under the heading: "Verdict" | the report writes: "The treatment killed ⟦1250⟧ participants (${R_SRC})." | the figure: 1250 | passage: "`));
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
  // r11: a sentence longer than 400 characters is not shown to the reviewer at all (was: cut to 400 around the figure)
  // (r17 6: the limit is 1600 characters, was 800: the block is longer than 1600 here)
  const wordy = `${'word '.repeat(350)}had 1250 participants ${'more '.repeat(350)}(${R_SRC}).`;
  const w = T.figureExcerpts(T.checkReport({ prose: wordy, claims, fetched }).claims, fetched, undefined, wordy).filter((f) => f.prose);
  assert.deepStrictEqual(w, []);
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

// ================================================================ r11
test('r11 1 hidden HTML, as a class: nesting, styled sources, markdown images', () => {
  const nf = (fig, src) => assert.strictEqual(T.checkFigure(fig, src), NF, src);
  const fd = (fig, src) => assert.strictEqual(T.checkFigure(fig, src), FD, src);
  // r14: raw HTML with hidden, styled or unlisted markup is unreadable: source not opened (was: not found); the visibleText cases stay in r10 / r12
  const no = (fig, src) => assert.strictEqual(T.checkFigure(fig, src), 'source_not_opened', src);
  no('1250', '<div hidden><div>old</div>1250</div>');                       // nested tag of the same name: the first close is not the end
  no('1250', '<style>.archive{display:none}</style><span class="archive">1250</span>');
  no('1250', '<span class="x">1250</span>');
  no('1250', '<div id="a"><p>x</p><b>1250</b></div>');                      // nesting across tag names
  no('1250', '<p style="color:red">text <b>bold</b> more 1250');             // an element never closed
  nf('1250', '![Chart: 1250 users](c.png)');
  nf('1250', 'Plot ![1250](a.png "t") end');
  nf('1250', '![Chart 1250][ref]');
  no('1250 users', '<p>1250 users</p>');                                     // r16: nothing is converted (was: found)
  no('1250 users', '<style>p{}</style>Plain text: 1250 users');              // r14: a stylesheet makes the source unreadable (was: found)
  no('1250 users', '<div class="a"></div> 1250 users <br> more');            // r14: a class makes it unreadable (was: found)
  fd('1250 users', 'Markdown: 1250 users ![pic](c.png)');
  // an unclosed hidden element still blanks to the end; a nested one inside an element longer than 20,000 characters too
  no('1250 users', '<div hidden><div>a</div>' + 'x '.repeat(11000) + '</div> 1250 users'); // r14: unreadable (was: not found)
  // the length stays (offsets valid)
  assert.strictEqual(T.visibleText('a <div class="x">1250</div> ![i](p.png) b <p hidden><p>q</p>z</p> c').length, 'a <div class="x">1250</div> ![i](p.png) b <p hidden><p>q</p>z</p> c'.length);
  const t0 = Date.now();
  for (const text of ['<div class="a">'.repeat(40000), '<p id=x>'.repeat(40000) + '</p>'.repeat(40000), '![a'.repeat(60000)]) T.checkFigure('1250', text);
  assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`);
});

test('r11 2 entities: more names; an undecoded one taints the number; one between digits splits it', () => {
  const nf = (fig, src) => assert.strictEqual(T.checkFigure(fig, src), NF, `${fig} vs ${src}`);
  const fd = (fig, src) => assert.strictEqual(T.checkFigure(fig, src), FD, `${fig} vs ${src}`);
  nf('1250', '&leq; 1250');
  nf('1250', '&foo; 1250');
  nf('1250', '1250 &foo;');
  nf('1250', '&foo;1250');
  nf('1250', '&#9999999; 1250');                       // invalid code point: stays as written
  fd('at most 1250', '&leq; 1250');
  fd('≥1250', '&geq; 1250');
  assert.strictEqual(T.numbersIn(T.visibleText('&pm; 5'))[0].pre, '±'); // decoded like the character itself
  nf('250', '1&#44;250');
  nf('1250', '1&#44;250');
  nf('-10%', '5&#45;10%');
  nf('10%', '5&hyphen;10%');
  nf('5', '5&foo;10');
  assert.strictEqual(T.visibleText('1&#44;250 and 5&foo;10').slice(0, 9), '1#####250');
  fd('1250 text', 'plain 1250 text');
});

test('r11 3 a report block longer than 1600 characters is not presented, so its meaning stays not checked', () => {
  const { fetched, claims } = rFigs('Enrollment totaled 1250 participants.', 'Enrollment totaled 1250 participants', '1250 participants');
  // r16: the context is the whole block (was: the sentence, at most 400 characters), at most 800 characters; r17 6: at most 1600
  const long = (verb) => `The treatment ${verb} 1250 participants ${'in many sites across the study '.repeat(60)}(${R_SRC}).`;
  assert.ok(long('enrolled').length > 1600);
  const prose = long('enrolled');
  const all = T.figureExcerpts(T.checkReport({ prose, claims, fetched }).claims, fetched, undefined, prose);
  assert.deepStrictEqual(all.filter((f) => f.prose), []);
  // whatever the reviewer answers (here: every key of the short sentence's shape), the figure is not checked
  const short = `The treatment enrolled 1250 participants (${R_SRC}).`;
  const sAll = T.figureExcerpts(T.checkReport({ prose: short, claims, fetched }).claims, fetched, undefined, short).filter((f) => f.prose);
  assert.strictEqual(sAll.length, 1);
  const keys = { [sAll[0].meaningKey]: { meaning: 'matches', quote: 'Enrollment totaled 1250 participants' } };
  const r = T.checkReport({ prose, claims, fetched, counts: {}, meaningKeys: keys });
  assert.deepStrictEqual([r.totals.proseFound, r.totals.proseMatches, r.totals.proseDiffers], [1, 0, 0]);
  // a block of 1600 characters or less is still presented (one over 800 now too)
  const ok = `The treatment enrolled 1250 participants ${'x '.repeat(700)}(${R_SRC}).`;
  assert.ok(ok.length <= 1600 && ok.length > 800 && T.figureExcerpts(T.checkReport({ prose: ok, claims, fetched }).claims, fetched, undefined, ok).some((f) => f.prose));
});

test('r11 4 the span of a figure with a wrapped sign starts at the sign as the text writes it', () => {
  const text = 'Change: **−** 1250 participants in the trial overall.';
  const { figs } = rFigs(text, 'Change was -1250 participants', '-1250 participants');
  assert.strictEqual(figs.length, 1);
  assert.ok(figs[0].excerpt.includes('**−** 1250 participants'));
  assert.strictEqual(figs[0].excerpt.slice(figs[0].span.start, figs[0].span.start + 1), '−');
  assert.deepStrictEqual(rAnswer(figs, '1250 participants').keys, {});                 // without the sign: not covered
  assert.strictEqual(Object.keys(rAnswer(figs, '**−** 1250 participants').keys).length, 1);
  assert.strictEqual(Object.keys(rAnswer(figs, '−** 1250 participants').keys).length, 1); // starting at the sign itself
  // an HTML-wrapped sign too
  // r16: an HTML-wrapped sign: the source is raw HTML, nothing is converted, so it is unreadable and no passage is cut (r14: was cut from the converted text)
  const html = rFigs('Change: <b>-</b> 1250 participants in the trial overall.', 'Change was -1250 participants', '-1250 participants');
  assert.deepStrictEqual(html.figs, []);
});

test('r11 5 the id of the report text entry is not an id a claim uses', () => {
  const { fetched, claims } = rFigs('Enrollment totaled 1250 participants.', 'Enrollment totaled 1250 participants', '1250 participants');
  const prose = `The treatment killed 1250 participants (${R_SRC}).`;
  for (const [ids, want] of [[['c1'], 'report'], [['report'], 'report-text'], [['report', 'report-text'], 'report-text-2'], [['report', 'report-text', 'report-text-2'], 'report-text-3']]) {
    assert.strictEqual(T.reportIdFor(ids), want);
  }
  const cl = [{ ...claims[0], id: 'report' }];
  const checked = T.checkReport({ prose, claims: cl, fetched }).claims;
  const all = T.figureExcerpts(checked, fetched, undefined, prose);
  assert.deepStrictEqual(all.map((f) => [f.fid, f.id, !!f.prose]), [['report.f1', 'report', false], ['p1', 'report-text', true]]);
  const brief = T.challengeBrief('Q?', cl, T.challengeExcerpts(cl, fetched), all);
  assert.ok(brief.includes('{"id": "report-text", "figures": [...]}') && brief.includes('{"id": "report-text", "figures": [{"fid": "p1"'));
  const reply = jsonReply([{ id: 'report', verdict: 'supported', reason: 'r', figures: [{ fid: 'report.f1', meaning: 'matches', quote: 'Enrollment totaled 1250 participants' }] }, { id: 'report-text', figures: [{ fid: 'p1', meaning: 'matches', quote: 'Enrollment totaled 1250 participants' }] }]);
  const parsed = T.parseChallenge(reply, ['report'], all);
  assert.deepStrictEqual([parsed.results.map((x) => x.id), parsed.results[0].figures.map((x) => x.fid), parsed.report.id, parsed.report.figures.map((x) => x.fid), parsed.unknown], [['report'], ['report.f1'], 'report-text', ['p1'], []]);
  assert.strictEqual(Object.keys(T.figureMeanings(all, parsed).keys).length, 2);
  // the claim's own "report" entry never lands in the report text's answers
  const own = T.parseChallenge(jsonReply([{ id: 'report', verdict: 'supported', figures: [{ fid: 'p1', meaning: 'matches', quote: 'whatever it says' }] }]), ['report'], all);
  assert.deepStrictEqual([own.results[0].figures, own.report.figures], [[], []]);
});

test('r11 6 a source that cannot be indexed now (too large or too slow) is skipped, never a throw', () => {
  const was = T.INDEX_LIMITS.maxChars;
  const text = 'Fresh r11-6 source: enrollment totaled 1250 participants in the lab.';
  const fig = T.parseFigure('1250 participants');
  try {
    T.INDEX_LIMITS.maxChars = 10;
    assert.strictEqual(T.matchedHit(fig, null, text, []), undefined);
    const prose = `Enrollment totaled 1250 participants (${R_SRC}).`;
    const toks = T.figuresInProse(prose, {});
    const states = toks.map(() => ({ status: 'found_as_written', through: { src: { text }, kws: ['enrollment'] } }));
    assert.deepStrictEqual(T.proseEntries(prose, toks, states), []);
    // the claim entries: the saved statuses say found, the source is over the limit now
    const claims = [{ id: 'c1', claim: 'Enrollment totaled 1250 participants', source_url: R_SRC, figures: ['1250 participants'], figure_checks: [{ figure: '1250 participants', status: 'found_as_written' }] }];
    assert.deepStrictEqual(T.figureExcerpts(claims, [{ url: R_SRC, ok: true, text }], undefined, prose), []);
  } finally { T.INDEX_LIMITS.maxChars = was; }
});

test('r11 7 the index cache keeps 24 sources and refreshes an entry on use', () => {
  const tag = `r11-7 ${Date.now()} ${Math.random()}`;
  const src = (i) => `${tag} source ${i}: enrollment totaled ${1000 + i} participants.`;
  const built = () => T.INDEX_STATS.built;
  const b0 = built();
  for (let round = 0; round < 2; round++) for (let i = 0; i < 13; i++) T.checkFigure(String(1000 + i), src(i));
  assert.strictEqual(built() - b0, 13, 'each of 13 sources is indexed once');
  // least recently used: source 0 is used again after 23 others, so it survives 2 more new sources; source 1 does not
  const b1 = built();
  for (let i = 13; i < 24; i++) T.checkFigure(String(1000 + i), src(i)); // 24 sources in all
  T.checkFigure('1000', src(0));
  for (let i = 24; i < 26; i++) T.checkFigure(String(1000 + i), src(i));
  assert.strictEqual(built() - b1, 13);
  T.checkFigure('1000', src(0));
  assert.strictEqual(built() - b1, 13, 'source 0 is still cached');
  T.checkFigure('1001', src(1));
  assert.strictEqual(built() - b1, 14, 'source 1 was the least recently used and was dropped');
});

// ================================================================ r12
test('r12 1 raw HTML by allowlist: only plain allowed elements show their contents', () => {
  // r14: raw HTML with a tag or an attribute off the list is unreadable: source not opened (was: not found); the visibleText pass is tested below
  const nf = (fig, src, kws) => assert.strictEqual(T.checkFigure(fig, src, kws), 'source_not_opened', src);
  const fd = (fig, src, kws) => assert.strictEqual(T.checkFigure(fig, src, kws), FD, src);
  nf('1250', '<dialog>1250</dialog>');
  nf('1250', '<details><summary>Old</summary>1250</details>');
  nf('1250', '<div hidden/>1250</div>');                  // a self-closing slash on a non-void element is ignored: it is open
  nf('1250', '<div hidden><div/>x</div>1250</div>');
  nf('1250', '<span class="x">1250</span>');
  nf('1250', '<p data-x="1">1250</p>');
  // real-eval fix: an unknown tag is no markup (only known HTML elements are): plain text, and "1250</blink>" is not a clean 1250 (was: unreadable)
  assert.strictEqual(T.checkFigure('1250', '<blink>1250</blink>'), 'not_found_as_written');
  nf('1250', '<b><dialog><i>1250</i></dialog></b>');      // inside a not shown element, shown ones do not help
  nf('1250', '<div><p class="a">1250</p></div>');
  nf('1250', '<a target="_blank" href="x">1250</a>');     // href only
  nf('1250', '<td style="x">1250</td>');
  nf('1250', '<p>x</p><span title="t">1250');             // never closed: to the end
  // r16: nothing is converted: any tag start is unreadable, also the plain allowed elements (was: found)
  nf('1250 users', '<table><tr><td>1250 users</td></tr></table>');
  nf('1250 users', '<p>1250 users</p>');
  nf('1250 users', '<a href="https://x.example/a?b=1">1250 users</a>');
  nf('1250 users', '<table><tr><td colspan="2" rowspan=2>1250 users</td></tr></table>');
  nf('1250 users', '<DIV><P>1250 users</P></DIV>');
  nf('1250 users', '<div hidden>9</div><p>1250 users</p>');   // r14: unreadable (was: found)
  nf('1250 users', '<img src="a.png"><br/> 1250 users');       // r14: unreadable (was: found)
  // the visibleText pass (the guard's second line) still blanks by the allowlist
  assert.strictEqual(T.visibleText('<div hidden>9</div><p>1250 users</p>').includes('9'), false);
  assert.strictEqual(T.visibleText('<img src="a.png"><br/> 1250 users').includes('1250 users'), true);
  assert.strictEqual(T.visibleText('<dialog>1250</dialog>').includes('1250'), false);
  // the length stays (offsets valid)
  const html = 'a <dialog>1250</dialog> b <p class="q">c</p> <p>1250 users</p>';
  assert.strictEqual(T.visibleText(html).length, html.length);
  // hostile input stays linear
  const hostile = '<p class=x>' + '<b>'.repeat(100000) + '</c>'.repeat(75000);
  const t0 = Date.now();
  assert.strictEqual(T.visibleText(hostile).trim(), ''); // blanked to the end
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  assert.ok(T.checkFigure('1250', hostile) !== FD); // (over the 600,000 character limit: too large to check)
  nf('1250', '<p class=x>' + '<b>'.repeat(50000) + '1250' + '</c>'.repeat(40000));
  // the element pass honours the 2-second deadline: past it the source is too large to check
  const was = T.INDEX_LIMITS.maxMs;
  try {
    T.INDEX_LIMITS.maxMs = -1;
    assert.strictEqual(T.checkFigure('1', '<p>1 users r12 deadline</p>'), 'source_not_opened');
  } finally { T.INDEX_LIMITS.maxMs = was; }
});

test('r12 2 a number split by removed markup or an entity is no plain number on either side', () => {
  const nf = (fig, src, kws) => assert.strictEqual(T.checkFigure(fig, src, kws), NF, `${fig} vs ${src}`);
  const fd = (fig, src, kws) => assert.strictEqual(T.checkFigure(fig, src, kws), FD, `${fig} vs ${src}`);
  // r16: raw HTML is unreadable (nothing is converted): source not opened (was: not found / found)
  const no = (fig, src, kws) => assert.strictEqual(T.checkFigure(fig, src, kws), 'source_not_opened', `${fig} vs ${src}`);
  no('250', 'Total: 1,<b>250</b> users', ['total']);
  no('250 users', 'Total: 1,<b>250</b> users', ['total']);
  no('1', 'Total: 1,<b>250</b> users', ['total']);
  no('5', '1.<b>5</b>', ['total']);
  no('1', '1.<b>5</b> total', ['total']);
  nf('1250', 'Enrollment 1250&#46;&#53;');
  nf('250', 'Enrollment 1,&#50;50', ['enrollment']);
  nf('1250', '1,&#50;50');
  nf('250', 'Total: 1,**250** users', ['total']);        // emphasis markers are removed spans too
  // r15 5: a digit, an inline tag and a digit with no white space between make the converted source unreadable (was: not found)
  assert.strictEqual(T.checkFigure('1250', '1<b>,</b>250'), 'source_not_opened');
  assert.strictEqual(T.checkFigure('12', 'Total 1<b>2</b> users', ['total']), 'source_not_opened');
  // markup that does not split a number: still raw HTML, so unreadable
  no('250 users', 'Total: <b>250</b> users', ['total']);
  no('1250 users', 'Total: <b>1250</b> users');
  no('1250', 'Enrolled <b>1250</b>. Then <i>300</i>.');
  no('250 users', 'Total: 1, <b>users</b> 250 users', ['total']);
  no('1250', '<table><tr><td>Total</td><td>1250</td></tr></table>');
  no('250 users', 'Total 1,\n<b>250</b> users', ['total']);
  // r16 1: the reviewers' inputs: a tag between digits or a hidden entity in an attribute is never read
  no('12', '<p>1<b> </b>2</p>');
  no('5000 units', '<p>Revenue <a href="x&#41;&#32;5000&#32;units&#32;&#40;">report</a> rose.</p>');
  no('12', '<li>1</li><li>2</li>');
  no('1250 users', '<p>1250 users</p>');
  assert.strictEqual(T.checkFigure('1250 users', '<p>1250 users</p>'), 'source_not_opened');
});

test('r12 3 markdown images: the alt text goes with the image, brackets and new lines inside it', () => {
  const nf = (fig, src) => assert.strictEqual(T.checkFigure(fig, src), NF, JSON.stringify(src));
  const fd = (fig, src) => assert.strictEqual(T.checkFigure(fig, src), FD, JSON.stringify(src));
  nf('1250', '![Chart [1250 users] 2020](c.png)');
  nf('1250', '![Chart 1250 users]\n[Chart 1250 users]: c.png');   // a shortcut reference image
  nf('1250', '![Chart 1250 users]');
  nf('1250', '![Chart\n1250 users](c.png)');                       // a new line in the alt text
  nf('1250', '![Chart [a [b] 1250] x][ref]');
  nf('1250', '![Chart 1250 users (unclosed');                      // no closing bracket: the rest of the line
  fd('1250 users', '![broken alt 99\n1250 users');                 // ... and no more
  fd('1250 users', 'Plain 1250 users ![pic](c.png) end');
  fd('1250 users', '![pic](c.png "a (b) c") 1250 users');
  const text = '![a [b](c.png) 1250 users](d.png) ok';
  assert.strictEqual(T.visibleText(text).length, text.length);
  const t0 = Date.now();
  nf('1250', '![a'.repeat(60000));
  nf('1250', '![a]('.repeat(30000));
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});

test('r12 4 every occurrence of a figure in a report sentence has its own id, answer and key; the heading is part of the key', () => {
  const { fetched, claims } = rFigs('Enrollment totaled 1250 participants.', 'Enrollment totaled 1250 participants', '1250 participants');
  const sentence = `The study enrolled 1250 participants and later lost 1250 participants (${R_SRC}).`;
  const figsOf = (prose) => T.figureExcerpts(T.checkReport({ prose, claims, fetched }).claims, fetched, undefined, prose);
  const check = (prose, keys) => T.checkReport({ prose, claims, fetched, counts: {}, meaningKeys: keys });
  const answer = (all, fid) => T.figureMeanings(all, T.parseChallenge(jsonReply([{ id: 'c1', verdict: 'supported' }, { id: 'report', figures: [{ fid, meaning: 'matches', quote: 'Enrollment totaled 1250 participants' }] }]), ['c1'], all)).keys;
  const all = figsOf(sentence);
  const p = all.filter((f) => f.prose);
  assert.deepStrictEqual(p.map((f) => f.fid), ['p1', 'p2']);
  assert.notStrictEqual(p[0].meaningKey, p[1].meaningKey);
  assert.strictEqual(p[0].sentence, p[1].sentence);
  assert.ok(p[0].marked.startsWith('The study enrolled ⟦1250⟧ participants and later lost 1250 participants'));
  assert.ok(p[1].marked.startsWith('The study enrolled 1250 participants and later lost ⟦1250⟧ participants'));
  // one answer, for p1: that figure matches, the twin is not checked
  const r = check(sentence, answer(all, 'p1'));
  assert.deepStrictEqual([r.totals.proseFound, r.totals.proseMatches, r.totals.proseDiffers], [2, 1, 0]);
  const r2 = check(sentence, answer(all, 'p2'));
  assert.deepStrictEqual([r2.totals.proseFound, r2.totals.proseMatches], [2, 1]);
  // a "differs" for the twin marks only that occurrence
  const dk = T.figureMeanings(all, T.parseChallenge(jsonReply([{ id: 'c1', verdict: 'supported' }, { id: 'report', figures: [{ fid: 'p2', meaning: 'differs', quote: 'Enrollment totaled 1250 participants' }] }]), ['c1'], all)).keys;
  assert.strictEqual((check(sentence, dk).prose.match(/\[source says otherwise\]/g) || []).length, 1);
  // the same sentence under another heading is not answered
  const under = (h) => `## ${h}\n\n${sentence}`;
  const all2 = figsOf(under('Enrollment'));
  assert.deepStrictEqual(all2.filter((f) => f.prose).map((f) => f.heading), ['Enrollment', 'Enrollment']);
  const keys2 = answer(all2, 'p1');
  assert.deepStrictEqual(check(under('Enrollment'), keys2).totals.proseMatches, 1);
  assert.deepStrictEqual(check(under('Deaths during follow-up'), keys2).totals.proseMatches, 0);
  assert.deepStrictEqual(check(sentence, keys2).totals.proseMatches, 0);   // no heading at all: another key
  assert.strictEqual(figsOf(sentence).find((f) => f.prose).heading, '');
  // r13 4 (changed on purpose): every governing heading counts, from the top level down ("Report > Enrollment"; was: the nearest only)
  const nested = figsOf(`# Report\n\n## Enrollment\n\n${sentence}`).filter((f) => f.prose);
  assert.strictEqual(nested[0].heading, 'Report > Enrollment');
  // the brief shows the heading, the marked sentence and the passage for each
  const b = T.challengeBrief('Q?', T.checkReport({ prose: under('Enrollment'), claims, fetched }).claims, T.challengeExcerpts(claims, fetched), all2);
  assert.ok(b.includes('  [p1] under the heading: "Enrollment" | the report writes: "The study enrolled ⟦1250⟧ participants and later lost 1250 participants'));
  assert.ok(b.includes('  [p2] under the heading: "Enrollment" | the report writes: "The study enrolled 1250 participants and later lost ⟦1250⟧ participants'));
});

test('r12 5 the common-number keyword must stand in visible text', () => {
  const nf = (src, kws) => assert.strictEqual(T.checkFigure('12 users', src, kws), NF, src);
  const fd = (src, kws) => assert.strictEqual(T.checkFigure('12 users', src, kws), FD, src);
  const no = (src, kws) => assert.strictEqual(T.checkFigure('12 users', src, kws), 'source_not_opened', src); // r14: raw HTML off the list is unreadable (was: not found / found)
  no('<!-- enrollment --> Row 12 users here', ['enrollment']);
  no('<span class="a">enrollment</span> Row 12 users here', ['enrollment']);
  no('<script>var enrollment;</script> Row 12 users here', ['enrollment']);
  nf('![enrollment chart](c.png) Row 12 users here', ['enrollment']);
  fd('Enrollment: Row 12 users here', ['enrollment']);
  no('<!-- x --> Enrollment: <b>Row</b> 12 users here', ['enrollment']);
  no('Enrollment: <b>Row</b> 12 users here', ['enrollment']); // r16: nothing is converted (r14: converted, found)
  // the passage cut for the reviewer is found with the same rule
  const fig = T.parseFigure('12 users');
  const indexOf = (text) => { const v = T.visibleText(text); const m = new Map(); for (const t of T.groupRuns(v, T.numbersIn(v))) { if (!m.has(t.mag)) m.set(t.mag, []); m.get(t.mag).push(t); } return m; };
  const hidden = '<!-- enrollment --> Row 12 users here';
  assert.strictEqual(T.matchedHit(fig, indexOf(hidden), hidden, ['enrollment']), undefined);
  const shown = 'Enrollment: Row 12 users here';
  assert.ok(T.matchedHit(fig, indexOf(shown), shown, ['enrollment']));
});

// ---- r13
test('r13 1 a stylesheet switches the allowlist off: no element\'s contents count, text outside every element still does', () => {
  // r14: a source with a stylesheet (or any tag off the list) is unreadable: source not opened, also for the text outside every element
  const nf = (fig, src) => assert.strictEqual(T.checkFigure(fig, src), 'source_not_opened', src);
  const fd = (fig, src) => assert.strictEqual(T.checkFigure(fig, src), FD, src);
  nf('1250', '<style>p{display:none}</style><p>1250</p>');
  nf('1250', '<link rel="stylesheet" href="a.css"><p>1250</p>');
  nf('1250', '<LINK HREF="a.css" REL=stylesheet><p>1250</p>');
  nf('1250', '<p style="">x</p><p>1250</p>');
  nf('1250', '<p>x</p><div STYLE = "color:red"><b>1250</b></div>');
  nf('1250 users', '<style>x{}</style>Plain 1250 users'); // r14: was found
  nf('1250 users', '<link rel="stylesheet" href="a.css">\nPlain 1250 users'); // r14: was found
  // the visibleText pass (the guard's second line) still keeps the text outside every element
  assert.ok(T.visibleText('<style>x{}</style>Plain 1250 users').includes('Plain 1250 users'));
  assert.ok(!T.visibleText('<style>p{display:none}</style><p>1250</p>').includes('1250'));
  // r16: without any stylesheet raw HTML is still unreadable (nothing is converted; was: found)
  nf('1250 users', '<p>1250 users</p>');
  nf('1250 users', '<link rel="icon" href="a.ico"><p>1250 users</p>'); // r14: a link is off the list (was: found)
  // linear on many "<link" (no regex backtracking)
  const t0 = Date.now();
  T.visibleText('<link '.repeat(100000));
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
});

test('r13 2 a blanked span that touches a number taints it', () => {
  const nf = (fig, src) => assert.strictEqual(T.checkFigure(fig, src), NF, src);
  const fd = (fig, src) => assert.strictEqual(T.checkFigure(fig, src), FD, src);
  // r14: raw HTML with a class, a comment or a script is unreadable: source not opened (was: not found / found); the taint itself is tested on visibleText
  const no = (fig, src) => assert.strictEqual(T.checkFigure(fig, src), 'source_not_opened', src);
  no('1250 users', 'Net change: <span class="neg">-</span>1250 users.');
  no('1,250,000', 'Revenue <span class="cur">$</span>1,250,000.');
  no('1250', 'Revenue was 1250<span class="u"> million</span>.');
  no('250,000 dollars', 'Revenue <span class="n">1,</span>250,000 dollars');
  no('1250 users', '<p>1250 users</p>'); // r16: nothing is converted (was: found)
  // the other blanked spans: a comment, an image, a hidden element, a reference definition, a link address
  no('1250 users', 'Net change: <!-- minus -->1250 users.');
  nf('1250 users', 'Net change -![a](b.png)1250 users.');
  no('1250', 'Revenue was 1250<!-- million -->.');
  no('1250', 'Revenue was $<script>x()</script>1250.');
  assert.ok(/#1250 users/.test(T.visibleText('Net change: <!-- minus -->1250 users.')), 'the blanked comment taints the number after it');
  // ... but not where the span only stands between words, and a link address behind its text does not taint the text
  no('1250 users', 'Note <!-- c --> 1250 users here'); // r14: unreadable (was: found)
  no('1250 users', 'Total <span class="a">x</span> 1250 users here'); // r14: unreadable (was: found)
  fd('1250', 'see [1250](https://example.org/x) and more');
  fd('$1250', 'the price [$1250](https://example.org/p/1250).');
  // the '#' stands at the end of the span that faces the number
  const v = T.visibleText('A <span class="n">1,</span>250');
  assert.strictEqual(v.length, 'A <span class="n">1,</span>250'.length);
  assert.ok(/#250$/.test(v), JSON.stringify(v));
});

test('r13 3 an unterminated or over-long tag blanks to the end of the text', () => {
  const src = `<div hidden data-x="${'a'.repeat(2500)}">1250 users</div>`;
  // r14: an unterminated or over-long tag makes the source unreadable: source not opened (was: not found; text before the tag was found)
  const NO = 'source_not_opened';
  assert.strictEqual(T.checkFigure('1250 users', src), NO);
  assert.strictEqual(T.checkFigure('>1250 users', src), NO);
  assert.strictEqual(T.checkFigure('1250 users', 'Open <b class="x'), NO);
  assert.strictEqual(T.checkFigure('1250 users', 'Open <b class="x" 1250 users'), NO);
  assert.strictEqual(T.checkFigure('1250 users', 'Seen: 1250 users. Then <b class="x'), NO);
  assert.ok(T.visibleText('Seen: 1250 users. Then <b class="x').includes('1250 users')); // the visibleText pass: what stands before it counts
  assert.strictEqual(T.visibleText(src).length, src.length);
  assert.strictEqual(T.visibleText(src).trim(), '');
  // a tag that does close is unreadable too
  assert.strictEqual(T.checkFigure('1250 users', `<a href="${'a'.repeat(250)}">1250 users</a>`), NO); // r16: nothing is converted (was: found)
  // inside a hidden element too
  assert.strictEqual(T.checkFigure('1250 users', '<div class="x"><p>a</p> and then <i title="' + 'b'.repeat(2500) + '"> 1250 users'), NO);
});

test('r13 5 blankImages checks the deadline; many unclosed "![" are linear', () => {
  const t0 = Date.now();
  assert.strictEqual(T.checkFigure('1250', '![\n'.repeat(200000)), NF);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  // the deadline is checked in the image pass (a text with no tag at all reaches no other check): past it the source is "too large"
  const was = T.INDEX_LIMITS.maxMs;
  try {
    T.INDEX_LIMITS.maxMs = -1;
    assert.strictEqual(T.checkFigure('1250 users', '![a](b.png) 1250 users r13-deadline'), 'source_not_opened');
  } finally { T.INDEX_LIMITS.maxMs = was; }
  assert.strictEqual(T.checkFigure('1250 users', '![a](b.png) 1250 users r13-back-to-normal'), FD);
  // the images are cut as before
  assert.strictEqual(T.checkFigure('1250', '![Chart [a [b] 1250] x][ref]'), NF);
  assert.strictEqual(T.checkFigure('1250', '![Chart 1250 users (unclosed'), NF);
  assert.strictEqual(T.checkFigure('1250 users', '![broken alt 99\n1250 users'), FD);
  assert.strictEqual(T.checkFigure('1250 users', '![a\\]b](c.png) 1250 users'), FD);
});

test('r13 4 the report-text figure is presented with every governing heading and, in a table, its column header', () => {
  const { fetched, claims } = rFigs('Enrollment totaled 1250 participants.', 'Enrollment totaled 1250 participants', '1250 participants');
  const sentence = `The study enrolled 1250 participants (${R_SRC}).`;
  const figsOf = (prose) => T.figureExcerpts(T.checkReport({ prose, claims, fetched }).claims, fetched, undefined, prose);
  const check = (prose, keys) => T.checkReport({ prose, claims, fetched, counts: {}, meaningKeys: keys });
  const answer = (all, fid = 'p1') => T.figureMeanings(all, T.parseChallenge(jsonReply([{ id: 'c1', verdict: 'supported' }, { id: 'report', figures: [{ fid, meaning: 'matches', quote: 'Enrollment totaled 1250 participants' }] }]), ['c1'], all)).keys;
  const prose = (h) => `## ${h}\n### Total\n\n${sentence}`;
  const all = figsOf(prose('Enrollment'));
  assert.strictEqual(all.find((f) => f.prose).heading, 'Enrollment > Total');
  assert.ok(T.challengeBrief('Q?', T.checkReport({ prose: prose('Enrollment'), claims, fetched }).claims, T.challengeExcerpts(claims, fetched), all).includes('  [p1] under the heading: "Enrollment > Total" | the report writes:'));
  const keys = answer(all);
  assert.strictEqual(check(prose('Enrollment'), keys).totals.proseMatches, 1);
  assert.strictEqual(check(prose('Deaths'), keys).totals.proseMatches, 0); // only the parent heading changed: not checked
  // a heading of the same or a lower level closes the earlier ones; a deeper one stays under its parent
  assert.strictEqual(figsOf(`# A\n## B\n### C\n## D\n\n${sentence}`).find((f) => f.prose).heading, 'A > D');
  assert.strictEqual(figsOf(`# A\n### C\n\n${sentence}`).find((f) => f.prose).heading, 'A > C');
  // a table row: the header cell of the figure's column, in the entry, the brief and the key
  const table = (head, extra = '') => `## Enrollment\n\n${head}\n|---|---|\n| Total | 1250 participants (${R_SRC}) |${extra}`;
  const t1 = table('| Arm | Enrollment |');
  const tf = figsOf(t1).filter((f) => f.prose);
  assert.strictEqual(tf.length, 1);
  assert.strictEqual(tf[0].column, 'Enrollment');
  const b = T.challengeBrief('Q?', T.checkReport({ prose: t1, claims, fetched }).claims, T.challengeExcerpts(claims, fetched), figsOf(t1));
  assert.ok(b.includes('  [p1] under the heading: "Enrollment" | under the column: "Enrollment" | the report writes: "'));
  const tk = answer(figsOf(t1));
  assert.strictEqual(check(t1, tk).totals.proseMatches, 1);
  assert.strictEqual(check(table('| Arm | Deaths |'), tk).totals.proseMatches, 0); // the column header changed: not checked
  assert.strictEqual(figsOf(table('| Arm | Deaths |')).filter((f) => f.prose)[0].column, 'Deaths');
  assert.strictEqual(check(table('| Group | Enrollment |'), tk).totals.proseMatches, 0); // the header row is part of the key
  // no header row, or another number of cells: not presented
  assert.deepStrictEqual(figsOf(`| Total | 1250 participants (${R_SRC}) |\n| Other | 5 |`).filter((f) => f.prose), []);
  assert.deepStrictEqual(figsOf(`|---|---|\n| Total | 1250 participants (${R_SRC}) |`).filter((f) => f.prose), []);
  assert.deepStrictEqual(figsOf(`| Arm | Enrollment | Extra |\n|---|---|---|\n| Total | 1250 participants (${R_SRC}) |`).filter((f) => f.prose), []);
  assert.deepStrictEqual(figsOf(`| Arm |  |\n|---|---|\n| Total | 1250 participants (${R_SRC}) |`).filter((f) => f.prose), []);
  assert.deepStrictEqual(check(`| Total | 1250 participants (${R_SRC}) |`, keys).totals.proseMatches, 0);
  // a figure that is not in a table row has no column
  assert.strictEqual('column' in all.find((f) => f.prose), false);
});

// ================================================================ r14: the check reads only plain reading text
const R14 = 'https://r14.example/enrol';
const r14Claim = [{ id: 'c1', claim: 'Enrollment was 1250 users', source_url: R14, figures: ['1250 users'] }];
const r14Prose = `Enrollment was 1250 users (${R14}).`;
const r14Run = (text, extra = {}) => {
  const fetched = [{ url: R14, title: 'Enrol', ok: true, text, ...extra }];
  return { fetched, rep: T.checkReport({ prose: r14Prose, claims: r14Claim, fetched, counts: {} }) };
};
const UNREADABLE_TEXT = 'source could not be read in a checkable form';

test('r14 1 reading text (no tag at all): found / not found as before; the source counts as "reading"', () => {
  const md = '# Enrollment\n\nThe trial enrolled 1250 users in total, with 30 raters.\n\n| Arm | N |\n|---|---|\n| A | 600 |\n';
  const { rep } = r14Run(md);
  assert.strictEqual(rep.claims[0].check_status, 'found_as_written');
  assert.strictEqual(rep.claims[0].check, '1 of 1 found as written');
  assert.strictEqual(r14Run('The trial enrolled 1300 users in total.').rep.claims[0].check_status, 'not_found_as_written');
  assert.deepStrictEqual([rep.totals.sourcesReading, rep.totals.sourcesConverted, rep.totals.sourcesUnreadable], [1, 0, 0]);
  // a "<" that is no tag start stays reading text
  assert.strictEqual(r14Run('p < 0.05 and 3 < 4: enrolled 1250 users').rep.claims[0].check_status, 'found_as_written');
  assert.strictEqual(r14Run('x <= y, a<5; enrolled 1250 users').rep.totals.sourcesReading, 1);
});

test('r14 2 / r16 1 no conversion: any tag start, plain tags too, makes the source unreadable (r14: plain tags were converted)', () => {
  for (const html of ['<table><tr><td>1250 users</td></tr></table>', '<p>1250 users</p>', '<a href="https://x.example/a">1250 users</a>', '<p>1300 users</p>', '<p>&lt;b&gt;1250 users</p>',
    '<p>1<b> </b>2</p>', '<li>1</li><li>2</li>', '1250 users </p>', '1250 users <!-- x -->', '1250 users <?x ?>', '1250 users <!doctype html>']) {
    const { fetched, rep } = r14Run(html);
    assert.strictEqual(rep.claims[0].check_status, 'source_not_opened', html);
    assert.strictEqual(rep.claims[0].check, UNREADABLE_TEXT, html);
    assert.deepStrictEqual([rep.totals.sourcesReading, rep.totals.sourcesConverted, rep.totals.sourcesUnreadable], [0, 0, 1], html);
    assert.deepStrictEqual(T.figureExcerpts(rep.claims, fetched, undefined, r14Prose), [], html);
  }
  // the reviewers' inputs: each is "source not opened", never found
  for (const [fig, html] of [['12', '<p>1<b> </b>2</p>'], ['5000 units', '<p>Revenue <a href="x&#41;&#32;5000&#32;units&#32;&#40;">report</a> rose.</p>'], ['12', '<li>1</li><li>2</li>'], ['1250 users', '<p>1250 users</p>']]) {
    assert.strictEqual(T.checkFigure(fig, html), 'source_not_opened', html);
    assert.strictEqual(T.checkClaims([{ id: 'c1', claim: 'x', source_url: R14, figures: [fig] }], [{ url: R14, ok: true, text: html }]).claims[0].status, 'source_not_opened', html);
  }
  assert.strictEqual(T.checkFigure('1250 users', '1250 users'), 'found_as_written');
  // real-eval fix: "<!x>", "<?x>" (no "?>"), "<task>" and the like are no markup: only known HTML elements, comments, a doctype and "<?...?>" are (they were unreadable)
  for (const plain of ['1250 users <!x>', '1250 users <?x>', 'the template <task> 1250 users', '<response_a> 1250 users', 'y_{<t} and i<j: 1250 users', 'the format: protagonist: <a brief characterization>; 1250 users', '<skipped> 1250 users']) {
    assert.strictEqual(T.checkFigure('1250 users', plain), 'found_as_written', plain);
    assert.strictEqual(r14Run(plain).rep.totals.sourcesReading, 1, plain);
  }
});

test('real-eval 2: only real markup makes a source unreadable (an opening or closing tag of a known HTML element, a comment, a doctype, <?...?>)', (t) => {
  for (const html of ['<div hidden>1250</div>', '<span class=x>1250</span>', '<!-- 1250 -->', '<?php 1250 ?>', '<br/> 1250', '<br> 1250', '<BR /> 1250', 'x </div> 1250', '<td colspan=2>1250', '<details open>1250']) {
    assert.strictEqual(T.checkFigure('1250', html), 'source_not_opened', html);
  }
  // the second guard (visibleText) uses the same definition: "<a brief characterization>" is no element, so nothing after it is blanked
  assert.match(T.visibleText('the format: <a brief characterization>; then 1250 users'), /1250 users/);
  assert.match(T.visibleText('x <task> 1250 users'), /1250 users/);
  assert.doesNotMatch(T.visibleText('x <span class=x>1250</span> y'), /1250/);
  // the real run's sources (fetched texts of a real Thorough run): fixtures are read from the shared folder; skipped when it is missing
  const dir = (process.env.RESEARCH_FIXTURES || '/nonexistent') + '/sources';
  const fs = require('fs');
  if (!fs.existsSync(dir)) { t.skip('the fixture folder ' + dir + ' is missing: the real sources were not checked'); return; }
  for (const n of ['03', '04', '07', '08', '10', '11']) {
    const text = fs.readFileSync(`${dir}/${n}.txt`, 'utf8');
    const kinds = T.checkReport({ prose: 'x', claims: [{ id: 'c1', claim: 'x', source_url: 'https://none.example/', figures: [] }], fetched: [{ url: 'https://s.example/' + n, ok: true, text }] }).totals;
    assert.strictEqual(kinds.sourcesReading, 1, 'source ' + n + ' reads as plain text');
  }
});

test('r14 3 unreadable text: hidden, unlisted, styled, commented or unterminated markup is never read, never found', () => {
  const cases = [
    '<div hidden>1250</div>', '<dialog>1250</dialog>', '<span class="x">1250</span>', '<style>p{display:none}</style><p>1250</p>',
    '<!-- 1250 -->1250', '<p data-x="1">1250</p>', '<div hidden data-x="' + 'a'.repeat(2500),
    '<!DOCTYPE html><p>1250</p>', '<p>1250</p><script>x()</script>', '<img src="a.png"> 1250', '<p>1250 </ p>', '<a href="x" onclick="y">1250</a>',
  ];
  for (const text of cases) {
    const { fetched, rep } = r14Run(text.includes('1250') ? text.replace('1250', '1250 users') : text + ' 1250 users');
    const label = text.slice(0, 40);
    const c = rep.claims[0];
    assert.strictEqual(c.check_status, 'source_not_opened', label);
    assert.strictEqual(c.check, UNREADABLE_TEXT, label);
    assert.strictEqual(c.check_reason, 'unreadable', label);
    assert.ok(c.figure_checks === undefined, label); // no figure was checked
    assert.ok(!/found_as_written/.test(JSON.stringify([rep.claims, rep.totals])), label); // "found" appears nowhere
    assert.match(rep.prose, /1250 \[source not opened\] users/, label);
    assert.deepStrictEqual([rep.totals.sourcesReading, rep.totals.sourcesConverted, rep.totals.sourcesUnreadable], [0, 0, 1], label);
    const res = T.checkClaims(r14Claim, fetched);
    assert.deepStrictEqual([res.claims[0].status, res.claims[0].reason, res.claims[0].figures[0].status, res.claims[0].source_opened], ['source_not_opened', 'unreadable', 'source_not_opened', false], label);
    assert.strictEqual(T.checkFigure('1250 users', fetched[0].text), 'source_not_opened', label);
    // no passage for the reviewer
    assert.deepStrictEqual(T.challengeExcerpts(r14Claim, fetched), [{ id: 'c1', excerpts: [UNREADABLE_TEXT] }], label);
    assert.deepStrictEqual(T.figureExcerpts(r14Claim.map((x) => ({ ...x, figure_checks: [{ figure: '1250 users', status: 'found_as_written' }] })), fetched, undefined, r14Prose), [], label);
  }
  // a source that is too large stays "too large", not "unreadable"
  const big = r14Run('<p>1250 users</p>' + ' '.repeat(600001));
  assert.strictEqual(big.rep.claims[0].check, 'source too large to check');
  assert.deepStrictEqual([big.rep.totals.sourcesReading, big.rep.totals.sourcesConverted, big.rep.totals.sourcesUnreadable], [0, 0, 0]);
  // the text bound: the 2-second deadline makes a text "too large" as before (r16: a plain text; raw HTML is unreadable before any deadline)
  const was = T.INDEX_LIMITS.maxMs;
  try {
    T.INDEX_LIMITS.maxMs = -1;
    assert.strictEqual(r14Run('Enrollment: 1250 users r14 deadline').rep.claims[0].check, 'source too large to check');
  } finally { T.INDEX_LIMITS.maxMs = was; }
  assert.strictEqual(r14Run('Enrollment: 1250 users r14 a fast variant').rep.claims[0].check_status, 'found_as_written'); // back to normal (the verdict on a text is kept per text)
});

test('r14 4 the figure counts by kind, the chat line, and the document\'s Sources mark', () => {
  const mk = (n, text, extra = {}) => ({ url: `https://r14.example/${n}`, title: `Source ${n}`, ok: true, text, ...extra });
  const fetched = [
    mk('a', 'Plain markdown: 1250 users.'),
    mk('a2', 'Another plain text with 1250 users.'),
    mk('b', '<p>1250 users</p>'),
    mk('c', '<div hidden>1250 users</div>'),
    mk('d', '<span class="x">1250 users</span>'),
    mk('big', 'x '.repeat(300001)),            // too large: counted in none
    { url: 'https://r14.example/e', ok: false, text: '' }, // not opened: counted in none
    mk('a', 'Plain markdown: 1250 users.'),   // the same source again: distinct sources only
  ];
  const claims = [{ id: 'c1', claim: 'Enrollment was 1250 users', source_url: 'https://r14.example/a', figures: ['1250 users'] }, { id: 'c2', claim: 'Enrollment was 1250 users', source_url: 'https://r14.example/c', figures: ['1250 users'] }];
  const rep = T.checkReport({ prose: 'Enrollment was 1250 users (https://r14.example/a).', claims, fetched, counts: {} });
  assert.deepStrictEqual([rep.totals.sourcesReading, rep.totals.sourcesConverted, rep.totals.sourcesUnreadable], [2, 0, 3]); // r16: nothing is converted: b is unreadable too
  const chat = (totals) => T.chatReport({ prose: '## Verdict\n\nv\n', claims: rep.claims, totals, files: {}, level: 'thorough' });
  const lines = chat(rep.totals).split('\n');
  // real-eval fix: the count of unreadable sources is the last of the plain sentences of the counts line
  const counts = lines.find((l) => l.startsWith('Of '));
  assert.ok(counts.endsWith(' The reviewer confirmed the meaning of 0, found 0 that differ, and did not check 3. 3 sources could not be read.'), counts);
  // none unreadable (or totals of an older run): no such sentence
  assert.ok(!chat({ ...rep.totals, sourcesUnreadable: 0 }).includes('could not be read.'));
  assert.ok(!chat({ claims: 0, figures: 0, found: 0, notFound: 0, notOpened: 0 }).includes('could not be read.'));
  // the document marks each such source in the Sources section
  const doc = T.renderDocument({ question: 'Q?', preparedDate: '2026-01-01', prose: '## Verdict\n\nv', claims: rep.claims, sources: fetched }).markdown;
  const sources = doc.slice(doc.indexOf('## Sources'));
  assert.ok(sources.includes('[Source c](https://r14.example/c) (could not be read in a checkable form)'));
  assert.ok(sources.includes('[Source d](https://r14.example/d) (could not be read in a checkable form)'));
  assert.ok(sources.includes('- [Source a](https://r14.example/a)\n') && !sources.includes('[Source a](https://r14.example/a) (could'));
  assert.ok(sources.includes('[Source b](https://r14.example/b) (could not be read in a checkable form)')); // r16: was not marked (converted)
  assert.strictEqual((sources.match(/could not be read in a checkable form/g) || []).length, 3);
  // the table of claims says so too
  assert.ok(doc.includes('| source could not be read in a checkable form |'));
  // a claim with no claims at all still carries the three counts
  assert.deepStrictEqual([T.checkReport({ prose: 'x', claims: [], fetched }).totals.sourcesUnreadable], [3]);
});

// ================================================================ r15: round-13 fixes
const NOT_OPENED = 'source_not_opened';
test('r15 1 a processing instruction or other markup opener makes the source unreadable', () => {
  assert.strictEqual(T.checkFigure('987654', 'Note <?php echo 987654 ?> here'), NOT_OPENED);
  assert.strictEqual(T.checkFigure('1250 users', '<?xml-stylesheet type="text/css" href="a.css" ?>\nEnrollment was 1250 users.'), NOT_OPENED);
  assert.strictEqual(T.checkFigure('987654', 'Note <?php echo 987654 ?> here', ['note']), NOT_OPENED);
  // a "<" that starts nothing stays text
  assert.strictEqual(T.checkFigure('1250 users', 'Enrollment was 1250 users (n<5).'), FD);
  assert.ok(!T.visibleText('a <?php echo 987654 ?> b').includes('987654')); // the element pass blanks it too
});

test('r15 2 markdown link destinations and titles: nested parentheses, a title on the next line', () => {
  assert.strictEqual(T.checkFigure('1250 participants', '[x](a(b(c)) "old 1250 participants")'), NF);
  assert.strictEqual(T.checkFigure('1250 participants', '[ref]: https://x.org\n  "old 1250 participants"'), NF);
  assert.strictEqual(T.checkFigure('1250 participants', "[ref]: https://x.org\n  'old 1250 participants'"), NF);
  assert.strictEqual(T.checkFigure('1250 participants', '[ref]: https://x.org\n  (old 1250 participants)'), NF);
  assert.strictEqual(T.checkFigure('1250 participants', '[ref]: https://x.org "old 1250 participants"'), NF);
  // the link text is visible text
  assert.strictEqual(T.checkFigure('1250 participants', '[1250 participants](https://x.org)'), FD);
  assert.strictEqual(T.checkFigure('1250 participants', 'Enrolled [1250 participants](https://x.org/a_(b)_c "title") in all.'), FD);
  // no closing parenthesis: blanked to the end of the line, and no further
  assert.strictEqual(T.checkFigure('1250 participants', '[x](a(b "old 1250 participants"'), NF);
  assert.strictEqual(T.checkFigure('1250 participants', '[x](a(b "old\n1250 participants'), FD);
  // a line after a definition that is no title is text
  assert.strictEqual(T.checkFigure('1250 participants', '[ref]: https://x.org\n1250 participants'), FD);
  // bounded: a million "](" is no slower than its length
  const t0 = Date.now();
  assert.strictEqual(T.checkFigure('1250', '](('.repeat(190000)), NF);
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
});

test('r15 3 a plus-or-minus tail after a number with a unit is part of its form', () => {
  const cases = [
    ['1250%', '1250% ± 5%', NF],
    ['1250% ± 5%', '1250% ± 5%', FD],
    ['1250 ms', '1250 ms ± 5 ms', NF],
    ['1250 ms ± 5 ms', '1250 ms ± 5 ms', FD],
    ['1250 ms ± 6 ms', '1250 ms ± 5 ms', NF],
    ['1250%', '1250% +/- 5%', NF],
    ['1250%', '1250% +- 5%', NF],
    ['1250%', '1250% plus or minus 5%', NF],
    ['1250%', '1250% ±5%', NF],
    ['1250x', '1250x ± 2', NF],
    ['1250%', '1250% in all', FD],
  ];
  for (const [fig, src, want] of cases) assert.strictEqual(T.checkFigure(fig, src), want, `${fig} vs ${src}`);
});

test('r15 4 a setext heading is a heading in the path of a report figure', () => {
  const { fetched, claims } = rFigs('Enrollment totaled 1250 participants.', 'Enrollment totaled 1250 participants', '1250 participants');
  const sentence = `The study enrolled 1250 participants (${R_SRC}).`;
  const figsOf = (prose) => T.figureExcerpts(T.checkReport({ prose, claims, fetched }).claims, fetched, undefined, prose);
  const check = (prose, keys) => T.checkReport({ prose, claims, fetched, counts: {}, meaningKeys: keys });
  const answer = (all) => T.figureMeanings(all, T.parseChallenge(jsonReply([{ id: 'c1', verdict: 'supported' }, { id: 'report', figures: [{ fid: 'p1', meaning: 'matches', quote: 'Enrollment totaled 1250 participants' }] }]), ['c1'], all)).keys;
  const under = (h, u = '=') => `${h}\n${u.repeat(Math.max(2, h.length))}\n\n${sentence}`;
  assert.strictEqual(figsOf(under('Enrollment')).find((f) => f.prose).heading, 'Enrollment');
  assert.strictEqual(figsOf(under('Enrollment', '-')).find((f) => f.prose).heading, 'Enrollment');
  const keys = answer(figsOf(under('Enrollment')));
  assert.strictEqual(check(under('Enrollment'), keys).totals.proseMatches, 1);
  assert.strictEqual(check(under('Deaths'), keys).totals.proseMatches, 0);
  // levels: "=" is 1, "-" is 2 and sits under it
  assert.strictEqual(figsOf(`Report\n======\n\nEnrollment\n----------\n\n${sentence}`).find((f) => f.prose).heading, 'Report > Enrollment');
  // not a heading: a dash line after a blank line, a single dash, a table separator, a line in a code fence
  assert.strictEqual(figsOf(`Some text\n\n---\n\n${sentence}`).find((f) => f.prose).heading, '');
  assert.strictEqual(figsOf(`Some text\n-\n\n${sentence}`).find((f) => f.prose).heading, '');
  assert.strictEqual(figsOf(`| a | b |\n---\n\n${sentence}`).find((f) => f.prose).heading, '');
  assert.strictEqual(figsOf(`\`\`\`\nCode\n====\n\`\`\`\n\n${sentence}`).find((f) => f.prose).heading, '');
});

test('r15 5 the converted path: href values, sup / sub, digits split by an inline tag', () => {
  const nopen = (fig, src) => assert.strictEqual(T.checkFigure(fig, src), NOT_OPENED, src);
  nopen('5000', '<p>Revenue <a href="https://e.com/a) 5000 (b">report</a> rose.</p>');
  nopen('5000', '<p>Revenue <a href="https://e.com/a b">report</a> rose 5000 units.</p>');
  nopen('5000', "<p>Revenue <a href='https://e.com/a\"b'>report</a> rose 5000 units.</p>");
  nopen('5000', '<p>Revenue <a href="https://e.com/a`b">report</a> rose 5000 units.</p>');
  nopen('123 million', '<p>Revenue was 12<sup>3</sup> million</p>');
  nopen('1 million', '<p>Revenue was 1<sub>2</sub> million</p>');
  nopen('123 users', '<p>12<span>3</span> users</p>');
  nopen('1250', '<p>1<b>,</b>250</p>');
  nopen('12', '<p>1</b><b>2</b></p>'.replace('</b><b>', '</i><i>'));
  nopen('123 users', '<p><b>12</b>3 users</p>');
  nopen('123 users', '<p>12<a href="https://e.com/x">3</a> users</p>');
  // r16: no conversion: a plain link, a tag with white space around it, a tag next to a letter are unreadable too (was: found / not found)
  nopen('5000 units', '<p>Revenue <a href="https://e.com/a">report</a> rose 5000 units.</p>');
  nopen('5000 units', '<p>Revenue <a href=https://e.com/a>report</a> rose 5000 units.</p>');
  nopen('123 users', '<p>12 <span>3</span> users</p>');
  nopen('5000 units', '<p>Q3<b>units</b> were 5000 units.</p>');
});

test('r15 6 coversSpan: an entry without a span never matches', () => {
  const { figs } = rFigs('Enrollment totaled 1250 participants. Screening found 12500 candidates.', 'Enrollment totaled 1250 participants', '1250 participants');
  assert.strictEqual(Object.keys(rAnswer(figs, 'Enrollment totaled 1250 participants').keys).length, 1);
  const noSpan = figs.map((f) => { const g = { ...f }; delete g.span; return g; });
  assert.deepStrictEqual(rAnswer(noSpan, 'Enrollment totaled 1250 participants').keys, {});
  assert.deepStrictEqual(rAnswer(noSpan, 'Enrollment totaled 1250 participants', 'matches').keys, {});
});

// ================================================================ r16: round-14 fixes
test('r16 2 markdown links: "](" blanks the rest of the line, reference labels and definitions are blanked, one linear pass', () => {
  const nf = (src) => assert.strictEqual(T.checkFigure('1250 participants', src), NF, JSON.stringify(src).slice(0, 80));
  const fd = (src) => assert.strictEqual(T.checkFigure('1250 participants', src), FD, JSON.stringify(src).slice(0, 80));
  nf('[x](a "old 1250 participants")');
  nf('[x](a(b(c(d(e)))) 1250 participants) tail');         // nested parentheses are counted: the destination ends at the last ")"
  // r17 4: the rest of the line after a link is read again (was r16: not read); a destination with a quote (a title) still blanks to the line's end
  fd('See [text](u) 1250 participants');
  nf('[text][1250 participants]');                         // a reference label
  nf('[a][1250 participants] and [c][d]');
  nf('[a][b 1250 participants');                           // a label that never closes: blanked to the end of its line only ...
  fd('[a][b\n1250 participants [c]');                      // ... the next line is text
  nf('[ref]: https://x.org\n"old 1250 participants"');     // a definition and its title on the next line
  nf('    [ref]: https://x.org\n    "old 1250 participants"'); // an indented definition (4 spaces) is blanked too
  nf('\t[ref]: https://x.org 1250 participants');
  nf('[ref]: https://x.org\n(old 1250 participants)');
  assert.strictEqual(T.checkFigure('1250 participants', '[ref]: <https://x.org> \'1250 participants\''), NF); // real-eval fix: "<https:...>" is no tag (it was a tag start: unreadable); the definition line is blanked
  nf('[^1]: 1250 participants');
  fd('[ref]: https://x.org\nplain 1250 participants');      // a next line that is no title is text
  fd('[1250 participants](https://x.org)');                // the link text stays
  fd('[1250 participants][ref]');                          // ... also with a reference label after it
  fd('Enrolled [a](https://x.org)\n1250 participants');
  // one linear pass: no nested scans, the deadline is checked
  const t0 = Date.now();
  assert.strictEqual(T.checkFigure('1250', '](\n'.repeat(200000)), NF);
  for (const text of ['](\n'.repeat(200000), '][\n'.repeat(200000), '[a]:\n'.repeat(120000), '][ ]['.repeat(80000), ']'.repeat(500000)]) T.checkFigure('1250', text);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  const t1 = Date.now();
  T.checkFigure('1250', '](\n'.repeat(200000));
  assert.ok(Date.now() - t1 < 1000, `took ${Date.now() - t1} ms`);
});

test('r16 3 qualifiers after a rate and in brackets: bound and approximation phrases, a plus-or-minus tail', () => {
  const cases = [
    ['1250% per year', '1250% per year or more', NF],
    ['1250% per year or more', '1250% per year or more', FD],
    ['1250% per year', '1250% per year', FD],
    ['1250% per year', '1250% per year or fewer', NF],
    ['1250% per year', '1250% per year or so', NF],
    ['1250% per month', '1250% per month ± 5%', NF],
    ['1250% per month ± 5%', '1250% per month ± 5%', FD],
    ['1250% per month', '1250% per month +/- 5%', NF],
    ['1250% per month', '1250% per month plus or minus 5%', NF],
    ['1250 ms', '1250 ms (± 5 ms)', NF],
    ['1250 ms (± 5 ms)', '1250 ms (± 5 ms)', FD],
    ['1250 ms', '1250 ms (+/- 5)', NF],
    ['1250 ms', '1250 ms (plus or minus 5 ms)', NF],
    ['1250 ms', '1250 ms (±5 ms)', NF],
    ['1250%', '1250% (± 5%)', NF],
    ['1250%', '1250% (±5%)', NF],
    ['1250% (±5%)', '1250% (±5%)', FD],
    ['1250 per day or more', '1250 per day or more', FD],
    ['1250 per day', '1250 per day or more', NF],
    ['1250 per day', '1250 per day ± 3', NF],
    ['1250 per day', '1250 per day, or more', FD],                   // a clause end stops the form
    ['1250 ms', '1250 ms (n=20)', FD],                                // a bracket that is no plus-or-minus tail is not read after the word (as before)
  ];
  for (const [fig, src, want] of cases) assert.strictEqual(T.checkFigure(fig, src), want, `${fig} vs ${src}`);
  // the parsed form: the tail is part of the word, in its place; the bound is a qualifier
  assert.strictEqual(T.parseFigure('1250% per year or more').qual, '≥');
  assert.strictEqual(T.parseFigure('1250% per month ± 5%').form, '||per month ± 5%');
  assert.strictEqual(T.parseFigure('1250 ms (± 5 ms)').form, '||ms ± 5 ms');
  // each source string against itself is found
  for (const s of ['1250% per year or more', '1250% per month ± 5%', '1250 ms (± 5 ms)', '1250 ms (+/- 5 ms)', '1250 per day or so']) assert.strictEqual(T.checkFigure(s, s), FD, s);
});

test('r16 4 arXiv paper identity: a fetch whose finalUrl is another paper credits nothing', () => {
  const U = 'https://arxiv.org/abs/2401.12345';
  const text = 'The study enrolled 1,250 participants in total.';
  const claim = (url) => [{ id: 'c1', claim: 'The study enrolled participants', source_url: url, figures: ['1,250 participants'] }];
  // the reviewer's input: the claim names v2, the fetch url is that, its finalUrl is another paper's v2
  const other = [{ url: U + 'v2', finalUrl: 'https://arxiv.org/abs/2401.54321v2', ok: true, text }];
  assert.deepStrictEqual(T.checkClaims(claim(U + 'v2'), other).claims.map((c) => c.status), ['no_source']);
  assert.strictEqual(T.checkReport({ prose: `The study enrolled 1,250 participants (${U}v2).`, claims: claim(U + 'v2'), fetched: other, counts: {} }).claims[0].check, 'no source to check');
  // the same without a version in the claim
  assert.deepStrictEqual(T.checkClaims(claim(U), other.map((f) => ({ ...f, url: U }))).claims.map((c) => c.status), ['no_source']);
  // the same paper (finalUrl the same paper, or none) is credited
  for (const f of [{ url: U + 'v2', finalUrl: U + 'v2' }, { url: U + 'v2' }, { url: U, finalUrl: U + 'v2' }, { url: U + 'v2', finalUrl: 'https://arxiv.org/pdf/2401.12345v2.pdf' }]) {
    assert.strictEqual(T.checkClaims(claim(U + 'v2'), [{ ...f, ok: true, text }]).claims[0].status, 'found_as_written', JSON.stringify(f));
  }
  // a later fetch of the right paper is the one that counts
  assert.strictEqual(T.checkClaims(claim(U + 'v2'), [...other, { url: U + 'v2', finalUrl: U + 'v2', ok: true, text }]).claims[0].status, 'found_as_written');
});

test('r16 5 the second mark reads the whole block of the report text: paragraph, or list item with its parents and lead-in; at most 1600 characters', () => {
  const { fetched, claims } = rFigs('Enrollment totaled 1250 participants.', 'Enrollment totaled 1250 participants', '1250 participants');
  const figsOf = (prose) => T.figureExcerpts(T.checkReport({ prose, claims, fetched }).claims, fetched, undefined, prose).filter((f) => f.prose);
  const check = (prose, keys) => T.checkReport({ prose, claims, fetched, counts: {}, meaningKeys: keys });
  const answer = (all, fid = 'p1') => T.figureMeanings(all, T.parseChallenge(jsonReply([{ id: 'c1', verdict: 'supported' }, { id: 'report', figures: [{ fid, meaning: 'matches', quote: 'Enrollment totaled 1250 participants' }] }]), ['c1'], all)).keys;
  // the reviewer's nested bullet: the parent item is part of the context ("Enrollment:" -> "Deaths:" is another key)
  const nested = (parent) => `- ${parent}\n  - Total 1250 participants (${R_SRC})\n- Other: 5`;
  const n1 = figsOf(nested('Enrollment:'));
  assert.strictEqual(n1.length, 1);
  assert.strictEqual(n1[0].sentence, `Enrollment: Total 1250 participants (${R_SRC})`);
  assert.strictEqual(n1[0].marked, `Enrollment: Total ⟦1250⟧ participants (${R_SRC})`);
  const k1 = answer(n1);
  assert.strictEqual(check(nested('Enrollment:'), k1).totals.proseMatches, 1);
  assert.strictEqual(check(nested('Deaths:'), k1).totals.proseMatches, 0);
  // the lead-in line of the list is part of it, a sibling item is not
  const lead = (l, sib) => `${l}\n\n- A: 1250 participants (${R_SRC})\n- B: ${sib}`;
  const l1 = figsOf(lead('Enrollment by arm:', '7'));
  assert.strictEqual(l1[0].sentence, `Enrollment by arm: A: 1250 participants (${R_SRC})`);
  const kl = answer(l1);
  assert.strictEqual(check(lead('Enrollment by arm:', '7'), kl).totals.proseMatches, 1);
  assert.strictEqual(check(lead('Deaths by arm:', '7'), kl).totals.proseMatches, 0);
  assert.strictEqual(check(lead('Enrollment by arm:', '9'), kl).totals.proseMatches, 1);   // a sibling item changing is not part of the block
  // the preceding sentence of the same paragraph is part of it
  const para = (before) => `${before} The study enrolled 1250 participants (${R_SRC}).`;
  const p1 = figsOf(para('Deaths are not counted here.'));
  assert.strictEqual(p1[0].sentence, `Deaths are not counted here. The study enrolled 1250 participants (${R_SRC}).`);
  const kp = answer(p1);
  assert.strictEqual(check(para('Deaths are not counted here.'), kp).totals.proseMatches, 1);
  assert.strictEqual(check(para('Only deaths are counted here.'), kp).totals.proseMatches, 0);
  // the next paragraph is not part of it
  const after = (next) => `The study enrolled 1250 participants (${R_SRC}).\n\n${next}`;
  assert.strictEqual(check(after('Something else.'), answer(figsOf(after('Something else.')))).totals.proseMatches, 1);
  assert.strictEqual(check(after('Another thing.'), answer(figsOf(after('Something else.')))).totals.proseMatches, 1);
  // the key: heading path + block + position + figure + passage
  assert.strictEqual(figsOf(`## A\n\n${para('x')}`)[0].heading, 'A');
  assert.notStrictEqual(figsOf(`## A\n\n${para('x')}`)[0].meaningKey, figsOf(`## B\n\n${para('x')}`)[0].meaningKey);
  // a block over 1600 characters (r17 6; was 800) is not presented (not checked); a figure in a heading line neither
  const big = `${'Filler words that go on. '.repeat(80)}The study enrolled 1250 participants (${R_SRC}).`;
  assert.ok(big.length > 1600);
  assert.deepStrictEqual(figsOf(big), []);
  const bigItem = `- ${'Filler words that go on. '.repeat(80)}\n  - Total 1250 participants (${R_SRC})`;
  assert.deepStrictEqual(figsOf(bigItem), []);
  assert.strictEqual(figsOf(`The study enrolled 1250 participants (${R_SRC}).`).length, 1);
  // the brief shows the block with the occurrence marked
  const all = figsOf(nested('Enrollment:'));
  const b = T.challengeBrief('Q?', T.checkReport({ prose: nested('Enrollment:'), claims, fetched }).claims, T.challengeExcerpts(claims, fetched), all);
  assert.ok(b.includes(`the report writes: "Enrollment: Total ⟦1250⟧ participants (${R_SRC})"`));
});

// ================================================================ r17: final-round fixes
test('r17 1 a parenthesised rate or bound after a number is that rate or qualifier', () => {
  const cases = [
    ['1250 mg', '1250 mg (per day)', NF],
    ['1250 mg (per day)', '1250 mg', NF],
    ['12.5%', '12.5% (at most)', NF],
    ['12.5% (at most)', '12.5%', NF],
    ['1250 mg (per day)', '1250 mg per day', FD],
    ['1250 mg per day', '1250 mg (per day)', FD],
    ['1250 mg (a month)', '1250 mg per month', FD],
    ['1250 mg (per day)', '1250 mg (per month)', NF],
    ['12.5% (annually)', '12.5% annually', FD],
    ['12.5% (at most)', '12.5% (at least)', NF],
    ['1250 (or more)', '1250 or more', FD],
    ['1250 (or more)', '1250', NF],
    ['12.5% (about)', '12.5%', FD],                   // an approximation in the claim is met by the exact figure, as with "about 12.5%"
    ['12.5%', '12.5% (about)', NF],
    ['56.4% (n = 20)', '56.4%', FD],                  // unchanged from before: a bracket that is no rate or qualifier is not read
    ['56.4%', '56.4% (n = 20)', FD],
    ['56.4% (n = 20)', '56.4% (n = 30)', FD],
  ];
  for (const [fig, src, want] of cases) assert.strictEqual(T.checkFigure(fig, src), want, `${fig} vs ${src}`);
  for (const s of ['1250 mg (per day)', '12.5% (at most)', '12.5% (/s)', '1250 (or more)', '1250 mg (monthly)', '1250 mg (up to)']) assert.strictEqual(T.checkFigure(s, s), FD, s);
  assert.strictEqual(T.parseFigure('12.5% (at most)').qual, '≤');
  assert.strictEqual(T.parseFigure('1250 mg (per day)').form, '||mg per day');
  // a bracket further from the number is not read
  assert.strictEqual(T.checkFigure('1250 patients', '1250 patients were enrolled (up to day 30)'), FD);
});

test('r17 2 stacked qualifiers before a number are both, in order', () => {
  // the qualifier stands in the claim's text, so the claim is checked against the source (the figure alone has no words in front of it)
  const status = (claim, src) => T.checkClaims([{ id: 'c1', claim, source_url: R_SRC, figures: [] }], [{ url: R_SRC, ok: true, text: src }]).claims[0].figures[0].status;
  const cases = [
    ['The share was about 1.25%.', 'The share was a maximum of about 1.25%.', NF],
    ['The share was a maximum of about 1.25%.', 'The share was about 1.25%.', NF],
    ['The share was a maximum of 1.25%.', 'The share was a maximum of about 1.25%.', NF],
    ['Growth was up to roughly 1250 users.', 'Growth was up to 1250 users.', NF],
    ['Growth was roughly up to 1250 users.', 'Growth was up to roughly 1250 users.', NF], // the order matters
    ['The share was a maximum of about 1.25%.', 'The share was a maximum of about 1.25%.', FD],
    ['Growth was up to roughly 1250 users.', 'Growth was up to roughly 1250 users.', FD],
    ['Growth was up to 1250 users.', 'Growth was up to 1250 users.', FD],
    ['Growth was about 1250 users.', 'Growth was about 1250 users.', FD],
  ];
  for (const [claim, src, want] of cases) assert.strictEqual(status(claim, src), want, `${claim} vs ${src}`);
  const q = (s) => T.numbersIn(s)[0].qual;
  assert.strictEqual(q('a maximum of about 1.25%'), '≤~');
  assert.strictEqual(q('up to roughly 1250'), '≤~');
  assert.strictEqual(q('never up to roughly 1250'), 'not ≤~');
  assert.strictEqual(q('not about 1250'), 'not ~');
  assert.strictEqual(q('about 1250'), '~');
});

test('r17 3 a figure in a source table row is presented with that table\'s header row; no header row: not presented', () => {
  const rows = Array.from({ length: 35 }, (_, i) => `| Area ${i + 1} | ${300 + i} |`).join('\n');
  const table = (head) => `District figures.\n\n| ${head} |\n|---|---|\n${rows}\n| North | 1250 |\n| South | 777 |\n\nEnd.`;
  const claim = [{ id: 'c1', claim: 'North enrollment', source_url: R_SRC, figures: ['1250'] }];
  const run = (text, keys) => {
    const fetched = [{ url: R_SRC, title: 'Districts', ok: true, text }];
    const checked = T.checkReport({ prose: 'x', claims: claim, fetched, counts: {}, meaningKeys: keys });
    return { checked, figs: T.figureExcerpts(checked.claims, fetched) };
  };
  const a = run(table('District | Enrollment'));
  assert.strictEqual(a.figs.length, 1);
  assert.ok(a.figs[0].excerpt.startsWith('| District | Enrollment | |---|---| … '), a.figs[0].excerpt.slice(0, 80));
  assert.ok(a.figs[0].excerpt.includes('| North | 1250 |'));
  assert.strictEqual(a.figs[0].excerpt.slice(a.figs[0].span.start, a.figs[0].span.end), '1250');
  // the answer for this passage counts; the same source under another header is another key, so it is not checked after the re-check
  const keys = T.figureMeanings(a.figs, { results: [{ id: 'c1', figures: [{ fid: 'c1.f1', meaning: 'matches', quote: '| North | 1250 |' }] }] }).keys;
  assert.strictEqual(run(table('District | Enrollment'), keys).checked.claims[0].figure_checks[0].meaning, 'matches');
  const b = run(table('District | Deaths'), keys);
  assert.notStrictEqual(b.figs[0].meaningKey, a.figs[0].meaningKey);
  assert.strictEqual(b.checked.claims[0].figure_checks[0].meaning, 'not checked');
  // a short table: the passage reaches the header, which is not repeated
  const small = run('| District | Enrollment |\n|---|---|\n| North | 1250 |\n');
  assert.strictEqual(small.figs[0].excerpt, '| District | Enrollment | |---|---| | North | 1250 |');
  assert.strictEqual(small.figs[0].excerpt.slice(small.figs[0].span.start, small.figs[0].span.end), '1250');
  // no header row (no separator line after the first row): the figure is found but not presented
  const bare = run(`| North | 1250 |\n${rows}\n`);
  assert.strictEqual(bare.checked.claims[0].figure_checks[0].status, 'found_as_written');
  assert.deepStrictEqual(bare.figs, []);
  // text outside a table is cut as before
  assert.ok(!run('Enrollment in the north was 1250.').figs[0].excerpt.includes('|'));
  // the figures of the report text: the same rule
  const fetched = [{ url: R_SRC, title: 'Districts', ok: true, text: table('District | Enrollment') }];
  const prose = `North enrollment was 1250 (${R_SRC}).`;
  const pf = T.figureExcerpts(T.checkReport({ prose, claims: claim, fetched }).claims, fetched, undefined, prose).filter((f) => f.prose);
  assert.strictEqual(pf.length, 1);
  assert.ok(pf[0].excerpt.startsWith('| District | Enrollment | |---|---| … '));
  const bareFetched = [{ url: R_SRC, title: 'Districts', ok: true, text: `| North | 1250 |\n${rows}\n` }];
  assert.deepStrictEqual(T.figureExcerpts(T.checkReport({ prose, claims: claim, fetched: bareFetched }).claims, bareFetched, undefined, prose).filter((f) => f.prose), []);
});

test('r17 4 a link destination ends at its matching ")" on the line; with a quote or no closing ")" the rest of the line is blanked', () => {
  assert.strictEqual(T.checkFigure('85.2', '| [GPT-4](https://x.example/m) | 85.2 | 90.1 |'), FD);
  assert.strictEqual(T.checkFigure('90.1', '| [GPT-4](https://x.example/m) | 85.2 | 90.1 |'), FD);
  assert.strictEqual(T.checkFigure('12.5%', 'According to [Gartner](https://g.example/r), the market grew 12.5%.'), FD);
  assert.strictEqual(T.checkFigure('1250 participants', '[x](a "a closing ) and old 1250 participants here")'), NF);
  assert.strictEqual(T.checkFigure('1250 participants', '[x](a \'t) 1250 participants'), NF);          // a quote: to the end of the line
  assert.strictEqual(T.checkFigure('1250 participants', '[x](a 1250 participants'), NF);              // no closing ")": to the end of the line
  assert.strictEqual(T.checkFigure('1250', '[x](https://x.example/a_1250) see'), NF);                  // the destination itself is no text
  assert.strictEqual(T.checkFigure('1250 participants', '[a](b(c)) 1250 participants'), FD);           // nested parentheses
  assert.strictEqual(T.checkFigure('1250 participants', '[a](b(c) 1250 participants'), NF);            // not closed: the line
  assert.strictEqual(T.checkFigure('1250 participants', '[a](b) and [c](d) 1250 participants'), FD);
  assert.strictEqual(T.checkFigure('1250 participants', '[a](b) and [c](d "t) 1250 participants'), NF);
  assert.strictEqual(T.checkFigure('1250 participants', '[a](b)\n[c](d "t") and 1250 participants'), NF);
});

test('r17 5 a redirect is expected for a URL that is not arXiv: the fetch counts when the claim matches its url or its finalUrl', () => {
  const text = 'The study enrolled 1,250 participants in total.';
  const claim = (url) => [{ id: 'c1', claim: 'The study enrolled participants', source_url: url, figures: ['1,250 participants'] }];
  const DOI = 'https://doi.org/10.1000/x';
  const redirected = [{ url: DOI, finalUrl: 'https://publisher.example/a', ok: true, text }];
  assert.strictEqual(T.checkClaims(claim(DOI), redirected).claims[0].status, 'found_as_written');
  assert.strictEqual(T.checkReport({ prose: `The study enrolled 1,250 participants (${DOI}).`, claims: claim(DOI), fetched: redirected, counts: {} }).claims[0].check_status, 'found_as_written');
  // the claim names the page the fetch landed on
  assert.strictEqual(T.checkClaims(claim('https://publisher.example/a'), redirected).claims[0].status, 'found_as_written');
  // a fetch of another page is no source
  assert.deepStrictEqual(T.checkClaims(claim('https://other.example/z'), redirected).claims.map((c) => c.status), ['no_source']);
  // arXiv keeps its rule: a finalUrl that is another paper credits nothing
  const U = 'https://arxiv.org/abs/2401.12345';
  const other = [{ url: U, finalUrl: 'https://arxiv.org/abs/2401.54321', ok: true, text }];
  assert.deepStrictEqual(T.checkClaims(claim(U), other).claims.map((c) => c.status), ['no_source']);
});

test('r17 6 a report block of up to 1600 characters is presented', () => {
  const { fetched, claims } = rFigs('Enrollment totaled 1250 participants.', 'Enrollment totaled 1250 participants', '1250 participants');
  const block = (n) => `The study enrolled 1250 participants ${'x '.repeat(n)}(${R_SRC}).`;
  const figsOf = (prose) => T.figureExcerpts(T.checkReport({ prose, claims, fetched }).claims, fetched, undefined, prose).filter((f) => f.prose);
  const at = (len) => { let n = 0; while (block(n).length < len) n++; return block(n); };
  const edge = at(1600);
  assert.ok(edge.length >= 1600 && edge.length <= 1601, String(edge.length));
  const fits = edge.length === 1600 ? edge : block(Math.max(0, (edge.length - 1) - 1)).slice(0, 0) + at(1599);
  assert.strictEqual(figsOf(fits).length, 1, String(fits.length));
  assert.deepStrictEqual(figsOf(at(1602)), []);
});

// ================================================================ real-eval fixes (A): the figure check on real papers
const KW = ['stories', 'crowd', 'comparisons', 'captures'];
test('real-eval 1: "in the source" compares the number and its unit, scale and rate, not the next ordinary word (rows of a real run)', () => {
  const found = (fig, text, kws = KW) => assert.strictEqual(T.checkFigure(fig, text, kws), 'found_as_written', `${fig} vs ${text}`);
  const notFound = (fig, text, kws = KW) => assert.strictEqual(T.checkFigure(fig, text, kws), 'not_found_as_written', `${fig} vs ${text}`);
  found('2,480', 'a held-out test set of 2,480 debiased, human-labeled st');
  found('46 crowdworkers', 'we recruited 46 U.S./U.K. crowd-workers in all');
  found('64 stories', 'We generate 64 stories each seeded from 40 prompts');
  found('2,000 comparisons', 'with 2,000 pairwise comparisons per setting');
  // arXiv HTML prints math twice, rendered then as TeX: the echo is nothing
  found('70%', 'Balanced-55 already captures 70%70\\% and more');
  found('0.585', 'a correlation of 0.5850.585 here');
  found('4.9% to 6.3%', 'ranging from 4.9%4.9\\% to 6.3%6.3\\%.', ['ranging']);
  // two plain integers written together are one number, not an echo
  notFound('12', 'the year 1212 was');
  notFound('1.5', 'a value of 1.51.5.');
  // still not found: another unit, scale, rate, a bare number against a number with something attached, a longer number
  notFound('1250 ms', 'it took 1250 seconds');
  notFound('5 million', 'it took 5 in all');
  notFound('12.5%', 'it was 12.5 overall');
  notFound('250', 'it was 1,250 overall');
  notFound('1250', 'it was 1250 per day');
  notFound('$1250', 'a cost of $1250 Canadian dollars');
  notFound('1250 mL', 'a volume of 1250 gallons');
  notFound('1250 USD', 'it was 1250 USD cents');
  found('1250 ms', 'it took 1250 ms');
  found('1250', 'it was 1250 users per day'.replace(' per day', ''));
  // a rate still counts after an ordinary word; "each seeded" is no rate
  notFound('1250 users', 'it was 1250 users per day', ['users']);
  found('1250 per day', 'it was 1250 users per day');
  found('64 stories', 'We generate 64 stories each seeded from 40');
  assert.strictEqual(T.parseFigure('1250 users per day').form, '||per day');
});

test('real-eval 1b: the fixtures of the real run: rows found, and the sources read', (t) => {
  // real-run fixtures live outside the repo: RESEARCH_FIXTURES = the fixtures folder, RESEARCH_FIXTURE_DOC = the run's document
  const F = (process.env.RESEARCH_FIXTURES || '/nonexistent') + '/';
  const D = process.env.RESEARCH_FIXTURE_DOC || '/nonexistent';
  if (!fs.existsSync(F + 'sources/index.json') || !fs.existsSync(D)) { t.skip('the fixture folder or the run document is missing: the real rows were not measured'); return; }
  const md = fs.readFileSync(D, 'utf8');
  const idx = JSON.parse(fs.readFileSync(F + 'sources/index.json', 'utf8'));
  const text = (n) => fs.readFileSync(`${F}sources/${n}.txt`, 'utf8');
  const sec = md.split('\n## Figures not found as written')[1].split('\n## ')[0];
  const rows = [...sec.matchAll(/^\| (.+?) \| \[([^\]]+)\]\(([^)]+)\) \| (.+?) \|$/gm)].map((m) => ({ figure: m[1], url: m[3] }));
  assert.strictEqual(rows.length, 28);
  // the check as measure.js runs it (no claim keywords): common numbers (below 1000 ...) still need a keyword near them
  const found = rows.filter((r) => T.checkFigure(r.figure, text(idx.find((x) => x.url === r.url).n), []) === 'found_as_written').length;
  assert.ok(found >= 4, `rows found: ${found} of 28`); // the baseline before the fixes: 1 of 28
  // the sources: at least 10 of the 12 read as plain text
  const fetched = idx.map((e) => ({ url: e.url, ok: true, text: text(e.n) }));
  const totals = T.checkReport({ prose: 'x', claims: [{ id: 'c1', claim: 'x', source_url: 'https://none.example/', figures: [] }], fetched }).totals;
  assert.strictEqual(idx.length, 12);
  assert.ok(totals.sourcesReading >= 10, `reading: ${totals.sourcesReading} of 12`);
});

test('real-eval 3: a report-text figure with no citation takes the source of the claim whose figure is written the same', () => {
  const A = 'https://a.example/a';
  const B = 'https://b.example/b';
  const fetched = [{ url: A, title: 'Alpha paper study', ok: true, text: 'The trial enrolled 1,250 participants and reached 56.4% accuracy.' }, { url: B, title: 'Beta paper study', ok: true, text: 'The survey reached 1,250 respondents.' }];
  const one = [{ id: 'c1', claim: 'Accuracy of the trial', source_url: A, figures: ['56.4%', '1,250 participants'] }];
  // no citation in the sentence or the block: the figure equals c1's figure: checked against A, found
  const r = T.checkReport({ prose: 'The accuracy was 56.4% in the trial.', claims: one, fetched, counts: {} });
  assert.strictEqual(r.prose, 'The accuracy was 56.4% in the trial.');
  assert.deepStrictEqual([r.totals.proseFound, r.totals.proseNoSource], [1, 0]);
  // a figure that is not any claim's figure has no source to check; one that equals a claim's figure but is not in its source is not found
  const other = T.checkReport({ prose: 'The accuracy was 71.2% in the trial.', claims: one, fetched, counts: {} });
  assert.match(other.prose, /71\.2% \[no source to check\]/);
  const wrongSrc = [{ id: 'c1', claim: 'Accuracy of the trial', source_url: A, figures: ['99.9%'] }];
  const nf = T.checkReport({ prose: 'The accuracy was 99.9% in the trial.', claims: wrongSrc, fetched, counts: {} });
  assert.match(nf.prose, /99\.9% \[not found in source\]/);
  assert.strictEqual(nf.totals.proseNotFound, 1);
  // the same figure in two claims with different sources: no source to check
  const two = [...one, { id: 'c2', claim: 'Accuracy of the survey', source_url: B, figures: ['56.4%'] }];
  const amb = T.checkReport({ prose: 'The accuracy was 56.4% in the trial.', claims: two, fetched, counts: {} });
  assert.match(amb.prose, /56\.4% \[no source to check\]/);
  // two claims with the same source: that source
  const same = T.checkReport({ prose: 'The accuracy was 56.4% in the trial.', claims: [...one, { id: 'c3', claim: 'Accuracy again', source_url: A, figures: ['56.4%'] }], fetched, counts: {} });
  assert.strictEqual(same.prose, 'The accuracy was 56.4% in the trial.');
  // a citation in the sentence still decides: the figure is checked against the cited source, not the claim's
  const cited = T.checkReport({ prose: `The accuracy was 56.4% (${B}).`, claims: two, fetched, counts: {} });
  assert.match(cited.prose, /56\.4% \[not found in source\]/);
  // the brief asks for the source URL in brackets after every sentence with a figure, and the figures as in the claims list
  const brief = T.synthesisBrief('Q?', ['x'], ['y'], fetched);
  assert.match(brief, /Put the source URL in brackets after every sentence that states a figure/);
  assert.match(brief, /exactly as it is written in the claims list/);
});

test('real-eval 5: the figures of the claims table are counted by status in the totals, and in the chat report', () => {
  const A = 'https://a.example/a';
  const fetched = [{ url: A, title: 'T', ok: true, text: 'The trial reached 56.4% accuracy and 1,250 participants.' }, { url: 'https://c.example/c', ok: false, text: '' }];
  const claims = [
    { id: 'c1', claim: 'Accuracy', source_url: A, figures: ['56.4%', '71.2%'] },
    { id: 'c2', claim: 'Gone', source_url: 'https://c.example/c', figures: ['5 ms'] },
    { id: 'c3', claim: 'Nowhere', source_url: '', figures: ['7 ms'] },
  ];
  const r = T.checkReport({ prose: 'The accuracy was 56.4% (' + A + ').', claims, fetched, counts: {} });
  assert.deepStrictEqual([r.totals.tableFigures, r.totals.tableFound, r.totals.tableNotFound, r.totals.tableNotOpened, r.totals.tableNoSource], [4, 1, 1, 1, 1]);
  const chat = T.chatReport({ prose: '## Verdict\nA.', claims: r.claims, totals: r.totals, files: {} });
  assert.match(chat, /Of 5 figures \(4 of them in the claims table\), 2 were found in their sources as written and 3 were not; 1 had no source to check and 1 came from a source that could not be opened\./);
});

test('real-eval 6: the chat report says what is missing in plain words, puts each path alone in backticks, and counts in plain sentences', () => {
  const overloaded = '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
  assert.strictEqual(T.plainMissing(`challenge (round 2: ${overloaded})`), "challenge (round 2): the reviewer's model did not answer (it was overloaded)");
  assert.strictEqual(T.plainMissing('challenge (round 1: Error: 529 Overloaded)'), "challenge (round 1): the reviewer's model did not answer (it was overloaded)");
  assert.strictEqual(T.plainMissing('challenge (round 1: TypeError: x is not a function\n    at foo (/lib/a.js:12:3))'), "challenge (round 1): the reviewer's model failed");
  assert.strictEqual(T.plainMissing('challenge (round 3: {"error":"boom"})'), "challenge (round 3): the reviewer's model failed");
  assert.strictEqual(T.plainMissing('synthesis (Error: fetch failed)'), 'synthesis: the model failed');
  assert.strictEqual(T.plainMissing('challenge (round 1: the reviewer\'s reply could not be read)'), 'challenge (round 1: the reviewer\'s reply could not be read)'); // already plain
  assert.strictEqual(T.plainMissing('reader notes for 2 sources'), 'reader notes for 2 sources');
  const t = T.chatReport({ prose: '## Verdict\nA.', claims: [], totals: { figures: 54, found: 41, notFound: 4, notOpened: 0, noSource: 9, meaningMatches: 30, meaningDiffers: 2, sourcesUnreadable: 6 }, files: { md: '/f/a b.md', pdfError: 'none' }, missing: [`challenge (round 2: ${overloaded})`, 'reader notes for 2 sources'] });
  assert.match(t, /Missing: challenge \(round 2\): the reviewer's model did not answer \(it was overloaded\); reader notes for 2 sources/);
  assert.doesNotMatch(t, /overloaded_error|\{|"type"/);
  assert.match(t, /\nFull document:\n`\/f\/a b\.md`\n/);
  assert.ok(t.includes('Of 54 figures, 41 were found in their sources as written and 13 were not; 9 had no source to check. The reviewer confirmed the meaning of 30, found 2 that differ, and did not check 22. 6 sources could not be read.'));
  assert.ok(t.includes(T.SCOPE_SENTENCE));
});

// ================================================================ real-eval fixes B: identifiers, plus sign, keywords, TeX glue, the four corrections
const URL_X = 'https://arxiv.org/abs/2602.02219';
const fetchedOf = (text, url = URL_X) => [{ url, title: 'Paper', ok: true, text }];

test('B1 an arXiv identifier is no figure: in report text, claim text and the figures list', () => {
  const prose = 'The work (arXiv 2507.00769, also 2405.13769v1 and 2602.02219) scored 56.4% [' + URL_X + '].';
  assert.deepEqual(T.figuresInProse(prose).map((t) => t.text), ['56.4%']);
  assert.strictEqual(T.classifyProseNumbers('see 2507.00769').find((x) => /2507/.test(x.token.raw)).exempt, 'identifier');
  // a number that only looks like one stays a figure
  assert.deepEqual(T.figuresInProse('a gain of 2024.123456 and 12345.6789').map((t) => t.text), ['2024.123456', '12345.6789']);
  const claims = [{ id: 'c1', claim: 'Follows arXiv 2507.00769v2 and reports 56.4%', source_url: URL_X, figures: ['2405.13769', '56.4%'], measured_result: 'from 2602.02219: 56.4%' }];
  const res = T.checkClaims(claims, fetchedOf('Result: 56.4% on the test.'));
  assert.deepEqual(res.claims[0].figures.map((f) => f.figure), ['56.4%']);
  assert.strictEqual(res.claims[0].status, 'found_as_written');
  const rep = T.checkReport({ prose, claims, fetched: fetchedOf('Result: 56.4% on the test.') });
  assert.strictEqual(rep.totals.proseFigures, 1);
  assert.doesNotMatch(rep.prose, /2507\.00769[^\n]*\[not found/);
});

test('B2 a leading + is the same as no sign; - and the minus sign still differ', () => {
  const src = (s) => 'The measured change was ' + s + ' on the held-out split.';
  assert.strictEqual(T.checkFigure('+1250', src('1250'), []), FD);
  assert.strictEqual(T.checkFigure('1250', src('+1250'), []), FD);
  assert.strictEqual(T.checkFigure('+1250', src('+1250'), []), FD);
  assert.strictEqual(T.checkFigure('1250', src('-1250'), []), NF);
  assert.strictEqual(T.checkFigure('-1250', src('1250'), []), NF);
  assert.strictEqual(T.checkFigure('-1250', src('+1250'), []), NF);
  assert.strictEqual(T.checkFigure('−1250', src('-1250'), []), FD);
  assert.strictEqual(T.checkFigure('1250', src('−1250'), []), NF);
  // in prose: a bracketed plus, and "plus or minus" is not a plus sign
  assert.strictEqual(T.checkFigure('(+1250)', src('1250'), []), FD);
  assert.strictEqual(T.checkFigure('±1250', src('1250'), []), NF);
  assert.strictEqual(T.checkFigure('+/-1250', src('1250'), []), NF);
  // the word signs keep their meaning (r9a)
  assert.strictEqual(T.checkFigure('plus 1250', src('1250'), []), NF);
});

test('B3 keywords of the common-number rule: the measured result, the word after the figure, the words of the report sentence', () => {
  // real row, 05.txt: "96 stories" in the dataset table; the claim's own top words are elsewhere
  const src05 = 'Table 1: Dataset Statistics. | Dataset | Size | | --- | --- | | SummEval | 4 models | 320 | | HANNA | 96 stories ×\\times 6 criteria | 576 |' + ' filler'.repeat(60) + ' The paper studies correlation between LLM scores and human judgments under the permutation-based setting.';
  const claim = { id: 'c10', claim: 'Rubric option order biases LLM judges; shuffling a few orderings recovers most of the correlation gain.', source_url: URL_X, figures: ['96'], measured_result: 'HANNA subset has 96 stories' };
  const got = (c, text = src05) => T.checkClaims([c], fetchedOf(text)).claims[0].figures.map((f) => f.status);
  assert.deepStrictEqual(got(claim), [FD]);
  // the word after the figure in the claim text alone is enough
  assert.deepStrictEqual(got({ ...claim, measured_result: '', claim: claim.claim + ' It used 96 stories.' }), [FD]);
  // with the figures list only (no word in the claim text, nothing related): still not found
  assert.deepStrictEqual(got({ ...claim, measured_result: '' }), [NF]);
  // real row, 09.txt: "+5.3": the source writes "+5.3 higher Sui Generis score"; the claim's measured result names the metric
  const src09 = 'We test this approach by sampling a story (*S-100*) using GPT-4 with M=100 given a prompt from WritingPrompts. *S-100* obtains +5.3 higher Sui Generis score and is more interesting than the story generated in one pass.';
  const c15 = { id: 'c15', claim: 'LLM entailment judgments of plot-element recurrence tracked humans better than embedding similarity, with weak human validation; selection gave a +5.3 point gain.', source_url: URL_X, figures: ['+5.3'], measured_result: 'best-of-100 gained 5.3 points on Sui Generis' };
  assert.deepStrictEqual(got(c15, src09), [FD]);
  assert.deepStrictEqual(got({ ...c15, measured_result: '' }, src09), [NF]); // no related word of the claim near it
  // the report text: the words of its own sentence count
  const prose = 'Best-of-100 sampling raised the Sui Generis score by +5.3 [' + URL_X + '].';
  const rep = (c) => T.checkReport({ prose, claims: [c], fetched: fetchedOf(src09) });
  assert.strictEqual(rep({ ...c15, measured_result: '' }).totals.proseFound, 1);
  const prose2 = 'The weather gave +5.3 outings [' + URL_X + '].';
  assert.strictEqual(T.checkReport({ prose: prose2, claims: [{ ...c15, measured_result: '' }], fetched: fetchedOf(src09) }).totals.proseFound, 0);
  // a common number with no related word nearby is still not found
  const far = 'The value 7 stands alone.' + ' filler'.repeat(100) + ' A paper about rubric orderings and correlation.';
  assert.deepStrictEqual(got({ ...claim, figures: ['7'], measured_result: 'seven stories' }, far), [NF]);
  // the generic words stay out, and the helpers
  assert.deepStrictEqual(T.wordAfter('96 results here', 2), []);
  assert.deepStrictEqual(T.wordAfter('96 stories here', 2), ['stories']);
  assert.deepStrictEqual(T.wordAfter('96 the end', 2), []);
  assert.ok(T.claimKeywords({ claim: 'alpha beta', measured_result: 'about generis scores' }).includes('generis'));
});

test('B4 TeX glue: a number glued to its own TeX form with a unit or scale reads as one number with that unit or scale', () => {
  const src = 'The full study comprises roughly 2.12.1M judge calls across the six models.';
  assert.strictEqual(T.checkFigure('roughly 2.1M', src, []), FD);
  assert.strictEqual(T.checkFigure('about 2.1M', src, []), FD); // the same approximation
  assert.strictEqual(T.checkFigure('2.1M', 'We made 2.12.1M judge calls.', []), FD);
  assert.strictEqual(T.checkFigure('2.1M', 'We made 2.12.1 million judge calls.', []), FD);
  assert.strictEqual(T.checkFigure('2.1', 'We made roughly 2.12 judge calls.', []), NF);
  assert.strictEqual(T.checkFigure('2.12', 'We made 2.12 judge calls.', ['judge']), FD);
  assert.strictEqual(T.checkFigure('2.1', 'We made 2.12.1M judge calls.', []), NF); // the number carries its scale
  // the figure alone is "2.1M", the source says "roughly": the qualifier rule is unchanged (the source may not carry one the figure lacks)
  assert.strictEqual(T.checkFigure('2.1M', src, []), NF);
  // the report flow: "about 2.1M" in the text, the source has the glued form
  const rep = T.checkReport({ prose: 'The study made about 2.1M calls [' + URL_X + '].', claims: [{ id: 'c1', claim: 'The study made about 2.1M calls', source_url: URL_X, figures: ['2.1M'] }], fetched: fetchedOf(src) });
  assert.strictEqual(rep.totals.proseFound, 1);
  // two plain integers written together are not glue
  assert.strictEqual(T.checkFigure('12M', 'We saw 1212M items.', ['items']), NF);
  assert.deepStrictEqual(T.numbersIn('x 2.12.1M y').map((t) => t.mag), ['2100000']);
});

// ---- the four corrections
const FP = [
  '### Research 1',
  '**Verdict**',
  'Method A wins on the benchmark (https://example.org/paper-a).',
  '**Evidence**',
  '- Method A scored 56.4% overall: https://arxiv.org/abs/2401.00001v1',
  '**Where sources disagree**',
  'See https://example.org/paper-z for a different view.',
  'SOURCES READ:',
  '- https://example.org/paper-z',
].join('\n');
const SEL_FINDINGS = [FP, '### Research 2\nOther findings: https://example.org/paper-c and https://example.org/paper-d.'];
const letters = 'cdefghijklmn'.split('');
const chosen = (list) => '```json\n' + JSON.stringify(list.map((u) => ({ url: u, title: u, why: 'w' }))) + '\n```';

test('B5 selection: the sources the first pass rests on are always kept, the model chooses the rest', () => {
  const pinned = T.firstPassSources(SEL_FINDINGS, 12).map((s) => s.url);
  assert.deepStrictEqual(pinned, ['https://example.org/paper-a', 'https://arxiv.org/abs/2401.00001v1']);
  // the headings of a "#" report work too, and a line like "Evidence strength: strong" is no heading
  const md = '## Verdict (2-4 sentences)\nA wins [https://a.example/x].\n\n## Evidence\n- B: https://b.example/y\n\n## Confidence\nsee https://c.example/z\nEvidence strength: strong https://d.example/w';
  assert.deepStrictEqual(T.firstPassSources(md, 12).map((s) => s.url), ['https://a.example/x', 'https://b.example/y']);
  // the stand-in selector returns C..N and not A, B: A and B are kept first
  const urls = letters.map((l) => `https://example.org/paper-${l}`);
  const findings = [FP + '\n' + urls.map((u) => `- ${u}`).join('\n')];
  const out = T.parseSelection(chosen(urls), findings, 12).map((s) => s.url);
  assert.strictEqual(out.length, 12);
  assert.deepStrictEqual(out.slice(0, 2), ['https://example.org/paper-a', 'https://arxiv.org/abs/2401.00001v1']);
  assert.ok(!out.slice(2).includes('https://example.org/paper-a'));
  assert.deepStrictEqual(out.slice(2), urls.slice(0, 10));
  // the selector names one of them again (another version of the arXiv paper): it is not listed twice
  const again = T.parseSelection(chosen(['https://arxiv.org/abs/2401.00001v2'.replace('v2', 'v1'), 'https://example.org/paper-c']), findings, 12).map((s) => s.url);
  assert.deepStrictEqual(again, ['https://example.org/paper-a', 'https://arxiv.org/abs/2401.00001v1', 'https://example.org/paper-c']);
  // the fallback (the selector gave nothing usable) keeps them too
  const fb = T.parseSelection('no json at all', findings, 12).map((s) => s.url);
  assert.deepStrictEqual(fb.slice(0, 2), ['https://example.org/paper-a', 'https://arxiv.org/abs/2401.00001v1']);
  assert.ok(fb.length > 2 && fb.length <= 12);
  // never more than maxSources
  assert.strictEqual(T.parseSelection(chosen(urls), findings, 2).length, 2);
  assert.strictEqual(T.parseSelection(chosen(urls), findings, 1).map((s) => s.url)[0], 'https://example.org/paper-a');
  // the brief tells the model which sources are kept and how many more to pick
  const brief = T.selectionBrief('Q?', findings, 12);
  assert.ok(brief.includes('- https://example.org/paper-a') && brief.includes('- https://arxiv.org/abs/2401.00001v1'));
  assert.match(brief, /Pick at most 10 more sources/);
  // no verdict or evidence section: nothing is kept, the brief is the old one
  assert.deepStrictEqual(T.firstPassSources('Helper 1\nfound https://a.example/x', 12), []);
  assert.match(T.selectionBrief('Q?', 'Helper 1\nfound https://a.example/x', 12), /Pick at most 12 sources/);
  // the merge itself
  assert.deepStrictEqual(T.mergePinned([{ url: 'https://a.example/x', title: '', why: '' }], [{ url: 'https://b.example/y', title: 'B', why: '' }], 5).map((s) => s.url), ['https://a.example/x', 'https://b.example/y']);
});

test('B6 reader brief: the first-pass lines for the source and the heading "Differences from the first pass"', () => {
  const brief = T.readerBrief('Q?', [{ title: 'Paper A', url: 'https://example.org/paper-a', why: 'main' }, { title: 'Paper Z', url: 'https://example.org/paper-z' }], SEL_FINDINGS);
  assert.ok(brief.includes('What the first pass said about it:\n   > Method A wins on the benchmark (https://example.org/paper-a).'));
  assert.ok(brief.includes('> See https://example.org/paper-z for a different view.'));
  assert.ok(brief.includes('> - https://example.org/paper-z'));
  assert.ok(!brief.includes('Other findings')); // only the lines citing the source
  assert.match(brief, /\n### Differences from the first pass\n/);
  for (const w of ['other figures', 'another version', 'different scope', 'different method', 'fine-tuned against prompted', 'different counts', 'raters, items']) assert.ok(brief.includes(w), w);
  // an arXiv paper cited in another version matches
  assert.ok(T.readerBrief('Q?', [{ url: 'https://arxiv.org/html/2401.00001v2' }], SEL_FINDINGS).includes('> - Method A scored 56.4% overall'));
  // no findings given: the old brief plus the heading
  const plain = T.readerBrief('Q?', [{ url: 'https://example.org/paper-a' }]);
  assert.ok(!plain.includes('What the first pass said'));
  assert.match(plain, /### Differences from the first pass/);
  assert.deepStrictEqual(T.firstPassLines(SEL_FINDINGS, 'https://nope.example/x'), []);
});

test('B7 synthesis: the readers\' differences are passed on and a "Corrections to the first pass" section is required; the document renders it', () => {
  const notes = [
    '## Paper A (https://example.org/paper-a)\n### Method\nM\n### Differences from the first pass\n- First pass: 56.4% overall. Full text (Table 2, v2): 61.2% on one category only.\n### Limits\nNothing',
    '## Paper Z (https://example.org/paper-z)\n### Differences from the first pass\nNothing\n### Limits\nL',
    '## Paper Q (https://example.org/paper-q)\n### Differences from the first pass\n- First pass: 20 raters. Full text: 31 raters (Section 3).\n- Published version: 0.71 instead of 0.68.\n### Could not read\nNothing',
  ];
  assert.deepStrictEqual(T.readerDifferences(notes).map((d) => d.source), ['Paper A (https://example.org/paper-a)', 'Paper Q (https://example.org/paper-q)']);
  const brief = T.synthesisBrief('Q?', 'FIRST PASS', notes, []);
  assert.ok(brief.includes('Source: Paper A (https://example.org/paper-a)\n- First pass: 56.4% overall. Full text (Table 2, v2): 61.2% on one category only.'));
  assert.ok(brief.includes('- Published version: 0.71 instead of 0.68.'));
  assert.ok(!brief.includes('Source: Paper Z'));
  assert.match(brief, /The section "Corrections to the first pass" is required\. List in it every difference the readers reported under "Differences from the first pass"/);
  assert.match(brief, /with the source URL .* and the figures from the full text/);
  assert.match(brief, /exactly as in the claims list/);
  assert.match(brief, /## Corrections to the first pass {2}\(.*one bullet for EACH difference/);
  // no differences listed: the brief says so
  assert.ok(T.synthesisBrief('Q?', 'F', ['## P (https://a.example/x)\n### Differences from the first pass\nNothing'], []).includes('(the readers listed none)'));
  // the document renders the section of a report that has it, with its figures
  const prose = '## Verdict\nA wins.\n\n## Corrections to the first pass\n- On one category only, 61.2% (Table 2, v2) instead of 56.4% overall [https://example.org/paper-a].';
  const claims = [{ id: 'c1', claim: 'A scored 61.2% on one category', source_url: 'https://example.org/paper-a', figures: ['61.2%'], measured_result: '61.2%', judged_by: 'humans', evidence_strength: 'strong', inference: false }];
  const fetched = [{ url: 'https://example.org/paper-a', title: 'Paper A', ok: true, text: 'Table 2: one category 61.2% in v2.' }];
  const checked = T.checkReport({ prose, claims, fetched });
  const doc = T.renderDocument({ question: 'Q?', preparedDate: '2026-11-22', prose: checked.prose, claims: checked.claims, sources: fetched });
  assert.match(doc.markdown, /## Corrections to the first pass\n- On one category only, 61\.2% \(Table 2, v2\) instead of /);
  assert.match(doc.html, /<h2[^>]*>Corrections to the first pass<\/h2>/);
  // its figures are checked like the rest of the report: 61.2% is in the claims list and the source, 56.4% is in neither
  assert.match(doc.markdown, /instead of 56\.4% \[not found in source\] overall/);
  assert.doesNotMatch(doc.markdown, /61\.2% \[/);
});

// ---- the first-pass summary (spec C)
const FP_A = 'https://example.org/fp-a';
const FP_B = 'https://example.org/fp-b';
const FP_C = 'https://example.org/fp-c';

test('first-pass summary: its own stage label, a brief that asks for Verdict and Evidence from the findings', () => {
  assert.strictEqual(T.progressLabel('summary'), 'summarising the first pass');
  const brief = T.firstPassBrief('Which is best?', ['Finding one ' + FP_A]);
  assert.match(brief, /## Verdict/);
  assert.match(brief, /## Evidence/);
  assert.match(brief, /2 to 4 sentences/);
  assert.match(brief, /Up to 8 bullets/);
  assert.match(brief, /in brackets/);
  assert.ok(brief.includes('Which is best?') && brief.includes('Finding one ' + FP_A));
});

test('pinnedSources: the summary\'s cited URLs; a URL the findings never had is dropped', () => {
  const findings = [`Found ${FP_A} and ${FP_B} and ${FP_C}.`];
  const summary = `## Verdict\nA wins.\n\n## Evidence\n- A scored 5% [${FP_B}]\n- invented [https://example.org/not-in-findings]\n- B [${FP_A}]`;
  assert.deepStrictEqual(T.pinnedSources(summary, findings, 12).map((p) => p.url), [FP_B, FP_A]);
  // the findings alone have no Verdict or Evidence headings: the old code pinned nothing from them
  assert.deepStrictEqual(T.firstPassSources(findings, 12), []);
});

test('pinnedSources: a summary with no URLs falls back to the most cited sources, up to half of max, ties by first appearance', () => {
  const findings = [`x ${FP_A}\ny ${FP_B}\n${FP_C}`, `z ${FP_C}\nw ${FP_B}`, `v ${FP_C}`];
  // counts: C 3, B 2, A 1
  assert.deepStrictEqual(T.pinnedSources('## Verdict\nIt works.\n\n## Evidence\n- no link', findings, 4).map((p) => p.url), [FP_C, FP_B]);
  assert.deepStrictEqual(T.pinnedSources('## Verdict\nIt works.', findings, 1).map((p) => p.url), [FP_C], 'at least one');
  const tie = [`${FP_A} ${FP_B}`, `${FP_C}`];
  assert.deepStrictEqual(T.pinnedSources('## Verdict\nok', tie, 6).map((p) => p.url), [FP_A, FP_B, FP_C], 'ties keep the order of first appearance');
  // the same arXiv paper under two addresses is one source
  assert.deepStrictEqual(T.mostCitedSources(['https://arxiv.org/abs/2401.00001v1 https://arxiv.org/pdf/2401.00001', 'https://example.org/q'], 5).map((p) => p.url), ['https://arxiv.org/abs/2401.00001v1', 'https://example.org/q']);
  // no summary at all (its call failed): as before, from the findings' own headings
  const own = ['## Verdict\nok\n## Evidence\n- see ' + FP_A];
  assert.deepStrictEqual(T.pinnedSources('', own, 12).map((p) => p.url), [FP_A]);
  assert.deepStrictEqual(T.pinnedSources('', [`${FP_A}`], 12), []);
});

test('selectionBrief and parseSelection use the pinned list they are given', () => {
  const findings = [`${FP_A} ${FP_B} ${FP_C}`];
  const pinned = [{ url: FP_B, title: 'B', why: 'w' }];
  const brief = T.selectionBrief('Q?', findings, 4, pinned);
  assert.match(brief, /These 1 source are already kept/);
  assert.ok(brief.includes('- ' + FP_B));
  const out = T.parseSelection('```json\n' + JSON.stringify([{ url: FP_C }]) + '\n```', findings, 4, pinned);
  assert.deepStrictEqual(out.map((s) => s.url), [FP_B, FP_C]);
  // without the argument: the findings' own headings, as before
  assert.doesNotMatch(T.selectionBrief('Q?', findings, 4), /already kept/);
});

test('readerBrief: the summary\'s lines about a source come first; the findings are the fallback per source', () => {
  const findings = [`Raw note on ${FP_A}: 1% in the preprint.\nRaw note on ${FP_B}: 2%.`];
  const summary = `## Verdict\nA.\n\n## Evidence\n- A got 5% [${FP_A}]`;
  const brief = T.readerBrief('Q?', [{ url: FP_A, title: 'A' }, { url: FP_B, title: 'B' }], findings, summary);
  assert.match(brief, /> - A got 5% \[https:\/\/example\.org\/fp-a\]/);
  assert.doesNotMatch(brief, /1% in the preprint/, 'the summary replaces the findings for a source it cites');
  assert.match(brief, /> Raw note on https:\/\/example\.org\/fp-b: 2%\./, 'a source the summary does not cite falls back to the findings');
  // no summary: as before
  assert.match(T.readerBrief('Q?', [{ url: FP_A }], findings), /1% in the preprint/);
  assert.match(T.readerBrief('Q?', [{ url: FP_A }], findings, ''), /1% in the preprint/);
});

test('renderDocument: the first-pass summary is an appendix "What the first pass said"; the corrections section stays', () => {
  const prose = '## Verdict\nA wins.\n\n## Corrections to the first pass\n- The first pass said 5%; the paper says 6%.';
  const doc = T.renderDocument({ question: 'Q?', preparedDate: '2026-01-01', prose, claims: [], sources: [], firstPass: '## Verdict\nA probably wins.\n\n## Evidence\n- A got 5% [' + FP_A + ']' });
  assert.match(doc.markdown, /## Corrections to the first pass/);
  const i = doc.markdown.indexOf('## What the first pass said');
  assert.ok(i > doc.markdown.indexOf('## Sources'), 'the appendix comes last');
  const tail = doc.markdown.slice(i);
  assert.match(tail, /A probably wins\./);
  assert.match(tail, /A got 5% \[https:\/\/example\.org\/fp-a\]/);
  assert.doesNotMatch(tail, /^## (Verdict|Evidence)/m, 'its own headings do not repeat the report\'s sections');
  assert.match(doc.html, /<h2[^>]*>What the first pass said<\/h2>/);
  // without a summary there is no appendix
  assert.doesNotMatch(T.renderDocument({ question: 'Q?', prose, claims: [], sources: [] }).markdown, /What the first pass said/);
});

// ================================================================ review blockers D: units keep their identity, arXiv versions, section numbers
test('D1 a word that looks like a unit is compared exactly; ordinary count nouns stay ordinary', () => {
  const same = (fig, text) => assert.strictEqual(T.checkFigure(fig, text, KW), 'found_as_written', `${fig} vs ${text}`);
  const diff = (fig, text) => assert.strictEqual(T.checkFigure(fig, text, KW), 'not_found_as_written', `${fig} vs ${text}`);
  diff('1250 kilopascals', 'the pressure was 1250 megapascals here');
  diff('1250 megawatts', 'the plant gave 1250 kilowatts today');
  diff('1250 lumens', 'the lamp gave 1250 lux in all');
  diff('1250 fps', 'the engine ran at 1250 rps in all');
  diff('60 fps', 'the engine ran at 60 rps in all');
  same('1250 kilopascals', 'the pressure was 1250 kilopascals here');
  same('1250 kilopascals', 'the pressure was 1250 Kilopascal here');
  same('1250 fps', 'the engine ran at 1250 fps in all');
  same('1250 amps', 'the fuse took 1250 amp here');
  // plural scale words are scales
  diff('1250 millions', 'there were 1250 billions here');
  same('1250 millions', 'there were 1250 millions here');
  // ordinary count nouns, also those that end in a unit stem or begin with a prefix
  same('46 crowdworkers', 'we recruited 46 U.S./U.K. crowd-workers in all');
  same('1250 participants', 'we had 1250 raters in all');
  same('1250 parameters', 'a model with 1250 hyperparameters');
  same('1250 programs', 'it ran 1250 diagrams here');
  same('1250 decisions', 'there were 1250 choices here');
  same('2000 points', 'with 2000 comparisons here');
});

test('D2 arXiv versions are kept apart in pinning', () => {
  const A1 = 'https://arxiv.org/abs/2401.12345v1';
  const A2 = 'https://arxiv.org/abs/2401.12345v2';
  const AU = 'https://arxiv.org/abs/2401.12345';
  const sum = (...u) => ['## Verdict', 'A wins.', '## Evidence', ...u.map((x) => `- claim [${x}]`)].join('\n');
  const both = T.pinnedSources(sum(A1, A2), [sum(A1, A2)], 12);
  assert.deepStrictEqual(both.map((p) => p.url), [A1, A2]);
  assert.deepStrictEqual(T.firstPassSources(sum(A1, A2), 12).map((p) => p.url), [A1, A2]);
  assert.deepStrictEqual(T.mostCitedSources([`${A1} and ${A2}`], 12).map((p) => p.url), [A1, A2]);
  assert.deepStrictEqual(T.mergePinned([{ url: A1 }, { url: A2 }], [{ url: A1, title: 'T' }], 12).map((p) => p.url), [A1, A2]);
  assert.deepStrictEqual(T.mergePinned([{ url: A1 }], [{ url: A2 }], 12).map((p) => p.url), [A1, A2]);
  // an unversioned URL and a versioned one of the paper are one source, the versioned one
  assert.deepStrictEqual(T.firstPassSources(sum(AU, A1), 12).map((p) => p.url), [A1]);
  assert.deepStrictEqual(T.firstPassSources(sum(A1, AU), 12).map((p) => p.url), [A1]);
  assert.deepStrictEqual(T.mostCitedSources([`${AU} ${A2}`], 12).map((p) => p.url), [A2]);
  assert.deepStrictEqual(T.mergePinned([{ url: AU }], [{ url: A2, title: 'T' }], 12), [{ url: A2, title: 'T', why: '' }]);
  // known in the findings: that version, or the unversioned paper; not another version
  assert.deepStrictEqual(T.pinnedSources(sum(A2), [`## Evidence\n- ${A1}`], 12).map((p) => p.url), [A1]); // not pinned: falls back to the most cited
  assert.ok(!T.pinnedSources(sum(A2), [`## Evidence\n- ${A1}`], 12).some((p) => p.url === A2));
  assert.deepStrictEqual(T.pinnedSources(sum(A2), [`See ${AU}`], 12).map((p) => p.url), [A2]);
  assert.deepStrictEqual(T.pinnedSources(sum(AU), [`See ${A1}`], 12).map((p) => p.url), [AU]);
});

test('D3 a section number is no figure of a source', () => {
  const claim = 'improved accuracy by 2.1 points on the evaluation set';
  const st = (text) => T.checkFigure('2.1 points', text, ['accuracy', 'evaluation']);
  assert.strictEqual(st('## 2.1 Evaluation setup\nWe evaluate the model; accuracy was 0.91 on the evaluation set.'), 'not_found_as_written');
  assert.strictEqual(st('3.2.1 Evaluation setup\nWe evaluate the model on the evaluation set.'), 'not_found_as_written');
  assert.strictEqual(st('- 2.1 Evaluation setup\nWe evaluate the model on the evaluation set.'), 'not_found_as_written');
  assert.strictEqual(st('## 2.1 evaluation setup\nWe evaluate the model on the evaluation set.'), 'not_found_as_written');
  assert.strictEqual(st('The gain in accuracy was 2.1 points on the evaluation set.'), 'found_as_written');
  assert.strictEqual(T.checkFigure('2.1', '| Model | gain |\n| A | 2.1 |\n', ['gain']), 'found_as_written');
  assert.strictEqual(T.checkFigure('2.1', 'The gain in accuracy was 2.1 on the evaluation set.\n2.1 Evaluation setup', ['accuracy']), 'found_as_written');
  assert.ok(claim);
});

// ---------------------------------------------------------------- run 2 (real run), spec E
test('run-2 E1 a plus-or-minus pair printed twice (arXiv TeX echo) is read once as 3.164 ± 0.093', () => {
  const pm = 'Creativity 3.164±0.0933.164\\pm 0.093 for poems';
  assert.strictEqual(T.numbersIn(pm).length, 2); // 3.164 and 0.093, not four numbers
  assert.strictEqual(T.checkFigure('3.164±0.093', pm), FD);
  assert.strictEqual(T.checkFigure('3.164 ± 0.093', pm), FD); // glued or spaced is one written form
  assert.strictEqual(T.checkFigure('3.164 ± 0.093', 'Creativity 3.164 ± 0.093 for poems'), FD);
  // both ways: another SD, another mean, a copy that is not the echo of the first, and the bare mean (the tail is part of the form, as before)
  assert.strictEqual(T.checkFigure('3.164 ± 0.094', pm), NF);
  assert.strictEqual(T.checkFigure('3.165±0.093', pm), NF);
  assert.strictEqual(T.checkFigure('3.164±0.093', 'Creativity 3.164±0.0933.165\\pm 0.093'), NF);
  assert.strictEqual(T.checkFigure('3.164', pm), NF);
  // a 5.00±0.00 pair
  assert.strictEqual(T.checkFigure('5.001±0.003', 'score 5.001±0.0035.001\\pm 0.003 end'), FD);
});

test('run-2 E1 a label with "=" in front of a number is no part of its form', () => {
  const tau = 'Kendall τb=0.3117\\tau_{b}=0.3117 over humans';
  assert.strictEqual(T.checkFigure('0.3117', tau), FD);
  assert.strictEqual(T.checkFigure('τb = 0.3117', tau), FD);
  assert.strictEqual(T.checkFigure('τb=0.3117', tau), FD);
  assert.strictEqual(T.checkFigure('0.3118', tau), NF);
  assert.strictEqual(T.checkFigure('τb = 0.3118', tau), NF);
  assert.strictEqual(T.numbersIn(tau).length, 1); // the TeX copy of label and number is nothing
  assert.strictEqual(T.checkFigure('0.0711', 'Spearman ρ=0.0711\\rho=0.0711.'), FD);
  assert.strictEqual(T.checkFigure('0.6213', 'we find r=0.6213 here'), FD);
  assert.strictEqual(T.checkFigure('κ = 0.3317', 'Cohen κ = 0.3317 overall'), FD);
  assert.strictEqual(T.checkFigure('0.3317', 'Cohen κ = 0.3317 overall'), FD);
  assert.strictEqual(T.checkFigure('0.538', 'agreement ICC(A,2)=0.538 on poems'), FD);
  assert.strictEqual(T.checkFigure('0.539', 'agreement ICC(A,2)=0.538 on poems'), NF);
  // a qualifier in front of the label still applies; a bound written with "=" is still a bound
  assert.strictEqual(T.checkFigure('about 0.6213', 'about r=0.6213 here'), FD);
  assert.strictEqual(T.checkFigure('0.6213', 'about r=0.6213 here'), NF);
  assert.strictEqual(T.checkFigure('0.0517', 'significant at p<=0.0517'), NF); // "<=" is not a label's "=": unchanged
  assert.strictEqual(T.checkFigure('0.0517', 'significant at p ≤ 0.0517'), NF);
});

test('run-2 E1 a hyphenated ordinary noun glued after a number is ignored; a hyphenated unit counts', () => {
  assert.strictEqual(T.checkFigure('2,480-pair', 'a held-out test set of 2,480 debiased pairs'), FD);
  assert.strictEqual(T.checkFigure('2,480', 'a test set of 2,480-pair items'), FD);
  assert.strictEqual(T.checkFigure('2,480-pair', 'a test set of 2,480-pair items'), FD);
  assert.strictEqual(T.checkFigure('2,480', 'a test set of 2,480-pair. Then more'), FD);
  assert.strictEqual(T.checkFigure('2,481', 'a test set of 2,480-pair items'), NF); // another number
  assert.strictEqual(T.checkFigure('2,480 mg', 'a test set of 2,480-pair items'), NF); // another unit
  assert.strictEqual(T.checkFigure('2,480-judge', 'all 2,480 judges'), FD);
  // a hyphenated unit still counts: mg, day, -fold
  for (const unit of ['mg', 'day', 'fold']) {
    assert.strictEqual(T.checkFigure('2,480', `a ${'2,480'}-${unit} course`), NF, unit);
    assert.strictEqual(T.checkFigure(`2,480-${unit}`, `a 2,480-${unit} course`), FD, unit);
  }
  assert.strictEqual(T.checkFigure('2,480-mg', 'a 2,480-pair course'), NF);
  // the ignored noun is read like an ordinary following word ("2,480 pair items per year" has no rate); a rate right after it stays
  assert.strictEqual(T.checkFigure('2,480', 'a test set of 2,480-pair items per year'), FD);
  assert.strictEqual(T.checkFigure('2,480', 'a test of 2,480-pair per year'), NF);
  assert.strictEqual(T.checkFigure('2,480 per year', 'a test of 2,480-pair per year'), FD);
});

test('run-2 E1 arrows and "to" ranges across cells are compounds; one end alone is not found', () => {
  const arrow = 'Accuracy went 0.4137 → 0.6213 on the test';
  assert.strictEqual(T.checkFigure('0.4137 → 0.6213', arrow), FD);
  assert.strictEqual(T.checkFigure('0.4137→0.6213', arrow), FD);
  assert.strictEqual(T.checkFigure('23.14% → 80.05%', 'rate 23.14%→\\rightarrow80.05% overall'), FD); // with arXiv\'s TeX echo
  assert.strictEqual(T.checkFigure('0.4137 → 0.6214', arrow), NF);
  // one end alone is not found (no change for a "to" range, and now also for an arrow)
  assert.strictEqual(T.checkFigure('0.6213', arrow), NF);
  assert.strictEqual(T.checkFigure('0.4137', arrow), NF);
  const to = 'Accuracy rose 0.4137 to 0.6213 on the test';
  assert.strictEqual(T.checkFigure('0.4137 to 0.6213', to), FD);
  assert.strictEqual(T.checkFigure('0.6213', to), NF);
  assert.strictEqual(T.checkFigure('0.4137', to), NF);
  // an arrow and a "to" are written differently: not the same form
  assert.strictEqual(T.checkFigure('0.4137 to 0.6213', arrow), NF);
  assert.strictEqual(T.checkFigure('0.4137 → 0.6213', to), NF);
  assert.strictEqual(T.figuresInProse('It went 0.4137 → 0.6213 here.').length, 1);
});

const Q_SRC = 'https://s.example/lit';
const qCheck = (prose) => T.checkReport({
  prose,
  claims: [{ id: 'c1', claim: 'The human study reports 56.4% agreement', source_url: Q_SRC, figures: ['56.4%'] }],
  fetched: [{ url: Q_SRC, title: 'Literature study', ok: true, text: 'The human study reports 56.4% agreement among crowd-workers. A total of 8821 words was used.' }],
  counts: {},
});
const qProse = (corr) => `## Verdict\nIt holds.\n\n## Evidence\n- The human study reports 56.4% agreement [${Q_SRC}].\n\n## Corrections to the first pass\n${corr}\n`;

test('run-2 E2 a figure inside « » is the first pass\'s value: not checked, not marked, not counted, shown as written', () => {
  const r = qCheck(qProse(`- The first pass said «59.4%»; the full text gives 56.4% [${Q_SRC}].`));
  assert.ok(r.prose.includes('«59.4%»'), 'shown as written');
  assert.ok(!/59\.4%»? \[/.test(r.prose), 'not marked');
  assert.ok(!r.prose.includes('[not found in source]') && !r.prose.includes('[no source to check]'));
  assert.strictEqual(r.totals.proseFigures, 2); // 56.4% twice, not 59.4%
  assert.strictEqual(r.totals.proseNotFound, 0);
  // the same text without « »: the first pass's value is checked and not found
  const plain = qCheck(qProse(`- The first pass reported 59.4% agreement; the full text gives 56.4% [${Q_SRC}].`));
  assert.ok(plain.prose.includes('59.4% [not found in source]'));
  assert.strictEqual(plain.totals.proseFigures, 3);
  // « » anywhere in the report exempts what it holds; what is outside is still checked
  const mixed = qCheck(qProse(`- The full text gives 8821 words, not «9999 words», in ${Q_SRC}.`));
  assert.ok(mixed.prose.includes('«9999 words»') && !/9999 words»? \[/.test(mixed.prose));
  const why = (prose) => T.classifyProseNumbers(prose).filter((x) => x.exempt === 'quoted error').map((x) => x.token.text);
  assert.deepStrictEqual(why('The first pass said «59.4%» and «1,450».'), ['59.4%', '1,450']);
  // an unclosed « exempts nothing
  assert.deepStrictEqual(why('The first pass said «59.4% and more.'), []);
});

test('run-2 E2 fallback: a clause with a retraction cue and no assertion cue, in "Corrections to the first pass" only', () => {
  const bullets = [
    '- The 1450 words versus 840 for rejected are not supported by the excerpts and are removed.',
    '- The first pass attached the 1,800-pair and 52.7% figures to the StoryAlign URL. That page contains none of them.',
    '- The 1,133-instance count could not be confirmed and is dropped.',
    '- The 18 open-weight split does not appear in the full text.',
    '- A figure of 777 was reported as 888 in the first pass.',
  ].join('\n');
  const r = qCheck(qProse(bullets));
  assert.ok(!r.prose.includes('[not found in source]') && !r.prose.includes('[no source to check]'), r.prose);
  assert.strictEqual(r.totals.proseFigures, 1); // only the 56.4% of the evidence bullet
  // an asserted figure in the same bullet after ";" is still checked; the cue clause before it is not
  const two = qCheck(qProse(`- The 1450 words are not supported; the full text gives 8821 words and 7777 more [${Q_SRC}].`));
  assert.ok(!/1450 \[/.test(two.prose), 'the retracted figure is exempt');
  assert.ok(two.prose.includes('7777 [not found in source]'), 'the asserted figure is checked');
  assert.ok(!/8821 \[/.test(two.prose));
  assert.strictEqual(two.totals.proseFigures, 3);
  // a cue clause that also asserts ("gives", "is", "supported", "shows") keeps its figures checked
  const both = qCheck(qProse(`- The first pass said 59.4% but the full text gives 56.4% [${Q_SRC}].`));
  assert.ok(both.prose.includes('59.4% [not found in source]'));
  // the clause is the sentence (cut at sentence ends and ";", not at commas): an assertion in it keeps every figure of it checked
  const isIt = qCheck(qProse('- The 4321 is not in the excerpts, and 66.3 is GPT-4o.'));
  assert.ok(isIt.prose.includes('66.3 [') && /4321 \[/.test(isIt.prose));
  // "is dropped" and "are not supported" are retractions, not assertions
  const aux = qCheck(qProse('- The 4321 count is dropped. The 6543 split is not supported.'));
  assert.ok(!/(?:4321|6543) \[/.test(aux.prose), aux.prose);
});

test('run-2 E2 fallback: the same words outside the corrections section are checked', () => {
  const prose = `## Verdict\nIt holds.\n\n## Evidence\n- The 4321 words are not supported by the excerpts and are removed [${Q_SRC}].\n\n## Corrections to the first pass\nNone\n`;
  const r = qCheck(prose);
  assert.ok(r.prose.includes('4321 [not found in source]'));
  // a "Corrections" heading that ends: the next heading's text is outside
  const after = qCheck(`## Corrections to the first pass\n- The 1450 words are removed.\n\n## Confidence\nThe 4321 words are removed [${Q_SRC}].\n`);
  assert.ok(!/1450 \[/.test(after.prose) && after.prose.includes('4321 ['));
});

test('run-2 E2 the synthesis and revision briefs ask for « » around the first pass\'s values', () => {
  const b = T.synthesisBrief('Q?', ['first pass'], ['notes'], []);
  assert.ok(b.includes('«59.4%»'));
  assert.match(b, /does not check a figure inside « »/);
  const rv = T.reviseBrief('Q?', 'prose', [], []);
  assert.match(rv, /keep the « » as they are/);
});

test('run-2 E3 pinned sources are taken round-robin by Evidence bullet, so the cap never cuts a whole bullet', () => {
  const u = (n) => `https://x.example/p${n}`;
  const sum = ['## Verdict', `Short answer [${u(0)}].`, '## Evidence', `- one [${u(1)}] and [${u(2)}] and [${u(3)}]`, `- two [${u(4)}]`, `- three [${u(5)}] [${u(6)}]`, '## Other', `- not evidence [${u(7)}]`].join('\n');
  const all = T.firstPassSources(sum, 12).map((p) => p.url);
  assert.deepStrictEqual(all, [u(0), u(1), u(4), u(5), u(2), u(6), u(3)]);
  // the cap: the first URL of every bullet, none cut whole (citation order would have kept p0 p1 p2 p3 and cut bullets two and three)
  assert.deepStrictEqual(T.firstPassSources(sum, 4).map((p) => p.url), [u(0), u(1), u(4), u(5)]);
  assert.deepStrictEqual(T.pinnedSources(sum, [sum], 4).map((p) => p.url), [u(0), u(1), u(4), u(5)]);
  // a paper cited by two bullets belongs to the first
  const dup = ['## Evidence', `- a [${u(1)}] [${u(2)}]`, `- b [${u(1)}] [${u(3)}]`].join('\n');
  assert.deepStrictEqual(T.firstPassSources(dup, 12).map((p) => p.url), [u(1), u(3), u(2)]);
  // numbered bullets and a bullet that wraps onto a second line
  const wrapped = ['## Evidence', `1. a [${u(1)}]`, `   and also [${u(2)}]`, `2. b [${u(3)}]`].join('\n');
  assert.deepStrictEqual(T.firstPassSources(wrapped, 12).map((p) => p.url), [u(1), u(3), u(2)]);
  // a summary with one URL per bullet keeps its order
  const one = ['## Evidence', `- a [${u(1)}]`, `- b [${u(2)}]`, `- c [${u(3)}]`].join('\n');
  assert.deepStrictEqual(T.firstPassSources(one, 2).map((p) => p.url), [u(1), u(2)]);
});

test('run-2 E3 the first-pass brief asks for the URL of every statement', () => {
  const b = T.firstPassBrief('Q?', ['finding']);
  assert.match(b, /Keep the source URL of EVERY statement you take from the findings/);
  assert.match(b, /no URL the findings give for a statement is dropped/);
});

test('run-2 E3 "Also found, not read in full": the unread sources the helpers cited, with their description, not the ones read', () => {
  const A = 'https://a.example/pa';
  const D = 'https://d.example/pd';
  const E = 'https://e.example/pe';
  const F = 'https://f.example/pf';
  const findings = [`### Research 1\n- Paper A on judges ${A}\n- Paper D tested persona prompts ${D}\n- ${F} a note on bias\nSOURCES READ:\n- ${A}\n- ${E}`];
  const firstPass = `## Verdict\nIt works.\n\n## Evidence\n- Persona prompts raise diversity by 12.5% [${D}]`;
  const fetched = [
    { url: A, ok: true, text: 'x' },
    { url: 'https://redirect.example/r', finalUrl: F, ok: true, text: 'y' },
    { url: E, ok: true, partial: true, partialReason: 'abstract page only', text: 'z' },
  ];
  const s = T.alsoFoundSources(findings, firstPass, fetched);
  assert.deepStrictEqual(s.map((x) => x.url), [D, E]); // A read, F read through its final address, E only in part
  assert.strictEqual(s[0].description, 'Persona prompts raise diversity by 12.5%'); // from the first pass
  assert.strictEqual(s[1].description, ''); // none anywhere
  const sec = T.alsoFoundSection(findings, firstPass, fetched);
  assert.strictEqual(sec.count, 2);
  assert.match(sec.markdown, /^## Also found, not read in full\n/);
  assert.ok(sec.markdown.includes(`- ${D} - Persona prompts raise diversity by 12.5% (not checked)`));
  assert.ok(sec.markdown.includes(`- ${E} (not checked)`));
  assert.ok(!sec.markdown.includes(A) && !sec.markdown.includes(F));
  // a description from the findings when the first pass has none
  assert.ok(T.alsoFoundSection(findings, '', [{ url: A, ok: true, text: 'x' }]).markdown.includes(`- ${D} - Paper D tested persona prompts (not checked)`));
  // nothing unread: no section
  assert.deepStrictEqual(T.alsoFoundSection([`- ${A}`], '', [{ url: A, ok: true, text: 'x' }]), { markdown: '', count: 0, sources: [] });
  // an arXiv paper read under another version or form counts as read
  assert.strictEqual(T.alsoFoundSources(['- https://arxiv.org/abs/2401.00001v2'], '', [{ url: 'https://arxiv.org/pdf/2401.00001', ok: true, text: 'x' }]).length, 0);
  // the long list is cut and says how many more
  const many = Array.from({ length: 70 }, (_, i) => `- https://m.example/p${i}`).join('\n');
  const big = T.alsoFoundSection([many], '', []);
  assert.strictEqual(big.count, 70);
  assert.match(big.markdown, /And 10 more, not listed here\./);
});

test('run-2 E3 the figures of "Also found" are not checked: not counted, marked not checked, kept in the document', () => {
  const D = 'https://d.example/pd';
  const sec = T.alsoFoundSection([`- Paper D ${D}`], `## Evidence\n- Persona prompts raise diversity by 12.5% on 77 stories [${D}]`, []);
  const marked = T.markUnverified(sec.markdown);
  assert.ok(marked.includes('12.5% [not checked]') && marked.includes('77 [not checked]'), marked);
  assert.ok(!marked.includes('[not found in source]'));
  // the report check counts no figure of it when it is left out of the checked text (the runner adds it after the check)
  const base = qProse(`- The first pass said «59.4%»; the full text gives 56.4% [${Q_SRC}].`);
  assert.strictEqual(qCheck(base).totals.proseFigures, 2);
  const doc = T.renderDocument({ question: 'Q?', prose: base + '\n\n' + marked, claims: [], sources: [] });
  assert.match(doc.markdown, /## Also found, not read in full/);
  assert.ok(doc.markdown.includes('12.5% [not checked]'));
  assert.ok(doc.markdown.includes('«59.4%»'), 'the document shows a quoted first-pass value as written');
});

test('run-2 E3 the chat report gives the count of unread helper sources in one sentence', () => {
  const base = { prose: '## Verdict\nIt holds.', claims: [], totals: { figures: 0, found: 0, notFound: 0, notOpened: 0 }, files: {} };
  const three = T.chatReport({ ...base, alsoFound: 3 });
  assert.ok(three.includes('3 more sources the helpers cited were not read in full and are not checked; the document lists them under "Also found, not read in full".'));
  assert.ok(T.chatReport({ ...base, alsoFound: 1 }).includes('1 more source the helpers cited was not read in full and is not checked; the document lists it under'));
  assert.ok(!/not read in full/.test(T.chatReport({ ...base, alsoFound: 0 })));
  assert.ok(!/not read in full/.test(T.chatReport(base)));
});

test('run-2 E4 the counts sentence keeps "(N of them in the claims table)"', () => {
  const r = T.chatReport({ prose: '## Verdict\nIt holds.', claims: [], totals: { figures: 9, found: 4, notFound: 1, notOpened: 0, noSource: 0, proseFound: 3, proseNotFound: 1, tableFigures: 5 }, files: {} });
  assert.match(r, /Of 9 figures \(5 of them in the claims table\), 7 were found/);
});
