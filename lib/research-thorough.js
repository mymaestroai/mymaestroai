'use strict';
// Thorough deep research: pure, testable pieces. No model calls, no network, no hub state.
// Everything that does I/O (fetching pages, running a browser, checking files) is injected.

const fs = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({ maxSources: 12, readersAtOnce: 4, reviewRounds: 2, timeLimitMinutes: 60, pdf: true, readerModel: 'own' });
const STAGES = ['quick', 'select', 'fetch', 'read', 'synthesis', 'check', 'challenge', 'document'];

// ---------------------------------------------------------------- settings

function intIn(v, lo, hi, dflt) {
  let n = v;
  if (typeof n === 'string' && /^\s*-?\d+\s*$/.test(n)) n = Number(n);
  if (typeof n !== 'number' || !Number.isInteger(n) || n < lo || n > hi) return dflt;
  return n;
}

function settingsFrom(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const pdf = r.pdf === true || r.pdf === 'true' ? true : r.pdf === false || r.pdf === 'false' ? false : DEFAULTS.pdf;
  return {
    maxSources: intIn(r.maxSources, 1, 40, DEFAULTS.maxSources),
    readersAtOnce: intIn(r.readersAtOnce, 1, 12, DEFAULTS.readersAtOnce),
    reviewRounds: intIn(r.reviewRounds, 0, 5, DEFAULTS.reviewRounds),
    timeLimitMinutes: intIn(r.timeLimitMinutes, 10, 240, DEFAULTS.timeLimitMinutes),
    pdf,
    readerModel: r.readerModel === 'own' || r.readerModel === 'helper' ? r.readerModel : DEFAULTS.readerModel,
  };
}

// ---------------------------------------------------------------- URLs

function normUrl(u) {
  const s = String(u || '').trim();
  try {
    const x = new URL(s);
    if (x.protocol !== 'http:' && x.protocol !== 'https:') return '';
    let p = x.pathname.replace(/\/+$/, '');
    if (!p) p = '';
    return `${x.protocol}//${x.host.toLowerCase()}${p}${x.search}`;
  } catch { return ''; }
}

function arxivId(u) {
  try {
    const x = new URL(String(u || '').trim());
    if (!/(^|\.)arxiv\.org$/i.test(x.hostname)) return '';
    const m = x.pathname.match(/^\/(?:abs|html|pdf)\/(.+?)(?:\.pdf)?\/?$/i);
    if (!m) return '';
    return m[1].replace(/v\d+$/i, '').toLowerCase();
  } catch { return ''; }
}

function arxivVersion(u) {
  try {
    const x = new URL(String(u || '').trim());
    if (!/(^|\.)arxiv\.org$/i.test(x.hostname)) return '';
    const m = x.pathname.match(/^\/(?:abs|html|pdf)\/(.+?)(?:\.pdf)?\/?$/i);
    const v = m && m[1].match(/(v\d+)$/i);
    return v ? v[1].toLowerCase() : '';
  } catch { return ''; }
}

// Does `other` (a fetched URL) stand for the source the claim cites? An explicit arXiv version matches only that version.
function sameSource(claimUrl, other) {
  const cn = normUrl(claimUrl);
  if (!cn || !other) return false;
  if (normUrl(other) === cn) return true;
  const ca = arxivId(claimUrl);
  if (!ca || ca !== arxivId(other)) return false;
  const cv = arxivVersion(claimUrl);
  return !cv || cv === arxivVersion(other);
}

const URL_RE = /https?:\/\/[^\s<>"'`\])]+/g;

function cleanUrl(u) { return String(u).replace(/[.,;:!?*_]+$/, ''); }

function urlsIn(text) {
  const out = [];
  for (const m of String(text || '').matchAll(URL_RE)) {
    const u = cleanUrl(m[0]);
    if (normUrl(u)) out.push({ url: u, index: m.index });
  }
  return out;
}

// ---------------------------------------------------------------- source selection

function asFindingsList(findings) {
  if (Array.isArray(findings)) {
    return findings.map((f) => (typeof f === 'string' ? f : f && typeof f.text === 'string' ? f.text : f && typeof f.findings === 'string' ? f.findings : '')).filter(Boolean);
  }
  const s = String(findings || '');
  // A single string may hold several helpers' texts under "Helper N" headings.
  const parts = s.split(/^(?=\s*(?:#{1,4}\s*)?(?:helper|worker)\s*\d+\b)/im).filter((p) => p.trim());
  return parts.length ? parts : [s];
}

function findingsText(findings) { return asFindingsList(findings).join('\n\n'); }

function selectionBrief(question, findings, max) {
  const n = intIn(max, 1, 40, DEFAULTS.maxSources);
  return [
    'You are choosing which sources a research answer rests on most. Below is the question and the findings that helpers collected in a first quick pass.',
    '',
    `Question: ${String(question || '').trim()}`,
    '',
    `Pick at most ${n} sources, the ones the answer depends on most. Primary sources come first: research papers, official data, the vendor's own pages. Prefer one good source over several that repeat it. Use only URLs that appear in the findings; do not invent or fix URLs.`,
    '',
    'Reply with ONLY a fenced json block, nothing before or after it, in this shape:',
    '```json',
    '[{"url": "https://...", "title": "short title", "why": "one line: what the answer takes from this source"}]',
    '```',
    '',
    'Findings:',
    '"""',
    findingsText(findings),
    '"""',
  ].join('\n');
}

function lineTitle(line, url) {
  const t = String(line || '').replace(url, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/[\[\]()*_`>#|]/g, ' ').replace(/^\s*[-+\d.)]+\s+/, '').replace(/\s+/g, ' ').replace(/^[\s:–—-]+|[\s:–—-]+$/g, '').trim();
  return t.slice(0, 120);
}

function extractSources(findings, max) {
  const n = intIn(max, 1, 1000, DEFAULTS.maxSources);
  const list = asFindingsList(findings);
  const info = new Map(); // key -> { url, title, order, helpers:Set, inRead }
  let order = 0;
  list.forEach((text, hi) => {
    const lines = String(text).split('\n');
    let inRead = false;
    let readUrls = 0;
    for (const line of lines) {
      if (/^\s*(?:[#*_>\-\s]*)(?:sources?\s+read)/i.test(line)) { inRead = true; readUrls = 0; }
      else if (inRead && (/^\s*(?:#{1,6}\s|[A-Z][A-Z &]{3,}:?\s*$)/.test(line) || (!line.trim() && readUrls > 0))) inRead = false;
      else if (inRead && /https?:\/\//.test(line)) readUrls++;
      URL_RE.lastIndex = 0;
      for (const m of line.matchAll(URL_RE)) {
        const url = cleanUrl(m[0]);
        const key = normUrl(url);
        if (!key) continue;
        let e = info.get(key);
        if (!e) { e = { url, title: lineTitle(line, m[0]), order: order++, helpers: new Set(), inRead: false }; info.set(key, e); }
        e.helpers.add(hi);
        if (inRead) e.inRead = true;
        if (!e.title) e.title = lineTitle(line, m[0]);
      }
    }
  });
  const rank = (a, b) => b.helpers.size - a.helpers.size || a.order - b.order;
  const all = [...info.values()];
  const first = all.filter((e) => e.inRead).sort(rank);
  const rest = all.filter((e) => !e.inRead).sort(rank);
  return [...first, ...rest].slice(0, n).map((e) => ({ url: e.url, title: e.title, why: '' }));
}

// Pull the contents of a fenced block. lang may be a string or array of accepted tags; falls back to a bare array.
function fencedBlocks(text) {
  const out = [];
  const re = /```[ \t]*([A-Za-z0-9_-]*)[ \t]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(String(text || '')))) out.push({ lang: m[1].toLowerCase(), body: m[2], start: m.index, end: m.index + m[0].length });
  return out;
}

function bareJsonArray(text) {
  const s = String(text || '');
  for (let i = s.indexOf('['); i >= 0; i = s.indexOf('[', i + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) { try { const v = JSON.parse(s.slice(i, j + 1)); if (Array.isArray(v)) return v; } catch { /* keep looking */ } break; } }
    }
  }
  return null;
}

function parseJsonLoose(body) {
  const t = String(body || '').trim();
  try { return { value: JSON.parse(t) }; } catch (e) {
    // trailing commas
    try { return { value: JSON.parse(t.replace(/,\s*([\]}])/g, '$1')) }; } catch { return { error: e.message }; }
  }
}

function parseSelection(text, findings, max) {
  const n = intIn(max, 1, 1000, DEFAULTS.maxSources);
  const known = new Map(); // norm -> original url as it appears in findings
  for (const u of urlsIn(findingsText(findings))) { const k = normUrl(u.url); if (k && !known.has(k)) known.set(k, u.url); }
  let arr = null;
  const blocks = fencedBlocks(text);
  const pick = blocks.find((b) => b.lang === 'json') || blocks[0];
  if (pick) { const r = parseJsonLoose(pick.body); if (Array.isArray(r.value)) arr = r.value; }
  if (!arr) arr = bareJsonArray(text);
  const out = [];
  const seen = new Set();
  if (arr) {
    for (const it of arr) {
      const raw = typeof it === 'string' ? it : it && typeof it.url === 'string' ? it.url : '';
      const key = normUrl(cleanUrl(raw.trim()));
      if (!key || !known.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push({ url: known.get(key), title: typeof it === 'object' && typeof it.title === 'string' ? it.title.trim() : '', why: typeof it === 'object' && typeof it.why === 'string' ? it.why.trim() : '' });
      if (out.length >= n) break;
    }
  }
  if (!out.length) return extractSources(findings, n);
  return out;
}

// ---------------------------------------------------------------- fetching source texts

const EMPTY_PAGE_RE = /^\s*\((?:no readable content|no text in this pdf|binary content)/i;

// Fetch one URL page by page. Returns { text, via, title, finalUrl, capped, error }.
async function fetchUrlText(url, { fetchPage, maxChars, signal }, title0) {
  let text = '';
  let offset = 0;
  let via = '';
  let title = title0 || '';
  let finalUrl = '';
  let capped = false;
  try {
    for (let guard = 0; guard < 200; guard++) {
      if (signal && signal.aborted) { if (!text) return { text: '', via, title, finalUrl, capped, error: 'aborted' }; break; }
      const room = maxChars - text.length;
      if (room <= 0) { capped = true; break; }
      const p = await fetchPage(url, { maxLength: Math.min(200000, room), offset });
      const md = p && typeof p.markdown === 'string' ? p.markdown : '';
      if (!via && p && p.via) via = p.via;
      if (p && p.title && !title) title = p.title;
      if (p && p.finalUrl && !finalUrl) finalUrl = p.finalUrl;
      text += md;
      if (!p || !p.truncated || !md.length) break;
      offset += md.length;
      if (text.length >= maxChars) { capped = true; break; }
    }
  } catch (e) {
    return { text: '', via, title, finalUrl, capped, error: (e && e.message) || String(e) };
  }
  if (text.length > maxChars) { text = text.slice(0, maxChars); capped = true; }
  if (!text.trim() || EMPTY_PAGE_RE.test(text)) return { text: '', via, title, finalUrl, capped, error: text.trim() || 'empty page' };
  return { text, via, title, finalUrl, capped, error: '' };
}

const SUBSTANTIAL = 20000;

// For an arXiv abs/pdf/html URL: the full-text forms to try before the cited URL.
function arxivCandidates(url) {
  try {
    const x = new URL(String(url || '').trim());
    if (!/(^|\.)arxiv\.org$/i.test(x.hostname)) return null;
    const m = x.pathname.match(/^\/(abs|html|pdf)\/(.+?)(?:\.pdf)?\/?$/i);
    if (!m) return null;
    const id = m[2];
    return { kind: m[1].toLowerCase(), list: [`https://arxiv.org/html/${id}`, `https://arxiv.org/pdf/${id}`, String(url).trim()] };
  } catch { return null; }
}

async function fetchOne(src, { fetchPage, maxChars, signal }) {
  const base = { url: src.url, title: src.title || '', ok: false, text: '', via: '', chars: 0, error: '', partial: false, partialReason: null };
  if (signal && signal.aborted) return { ...base, error: 'aborted' };
  const arx = arxivCandidates(src.url);
  const urls = arx ? [...new Set(arx.list)] : [src.url];
  const got = [];
  for (const u of urls) {
    if (signal && signal.aborted && got.length) break;
    const r = await fetchUrlText(u, { fetchPage, maxChars, signal }, base.title);
    got.push({ u, r });
    if (!arx) break;
    if (r.text && r.text.length > SUBSTANTIAL) break;
  }
  const okOnes = got.filter((g) => g.r.text);
  const longest = () => okOnes.slice().sort((a, b) => b.r.text.length - a.r.text.length)[0];
  let pick = okOnes.find((g) => g.r.text.length > SUBSTANTIAL);
  // a cited abs page: the longest of html, pdf and abs wins; only when the abs page is the longest is the text abstract-only
  if (!pick) pick = arx && arx.kind === 'abs' ? longest() : okOnes.find((g) => g.u === String(src.url).trim()) || longest();
  if (!pick) {
    const e = got.find((g) => g.u === String(src.url).trim()) || got[got.length - 1];
    const r = e ? e.r : { title: base.title, via: '', finalUrl: '', error: 'empty page' };
    return { ...base, title: r.title || base.title, via: r.via, finalUrl: r.finalUrl || '', error: r.error || 'empty page' };
  }
  const r = pick.r;
  let text = r.text;
  let partial = false;
  let partialReason = null;
  if (r.capped) { partial = true; partialReason = `cut at ${maxChars} characters`; }
  else if (arx && arx.kind === 'abs' && pick.u === String(src.url).trim() && text.length <= SUBSTANTIAL) { partial = true; partialReason = 'abstract page only'; }
  const finalUrl = r.finalUrl || (pick.u !== String(src.url).trim() ? pick.u : '');
  return { url: src.url, title: r.title || base.title, ok: true, text, via: r.via, chars: text.length, error: '', finalUrl, truncated: !!r.capped, partial, partialReason };
}

async function fetchSourceTexts(sources, { fetchPage, maxChars = 600000, signal } = {}) {
  const list = Array.isArray(sources) ? sources : [];
  const results = new Array(list.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      results[i] = await fetchOne(list[i], { fetchPage, maxChars, signal });
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, list.length) }, worker));
  return results;
}

// ---------------------------------------------------------------- readers

function groupForReaders(sources, perReader = 2) {
  const n = Math.max(1, Math.floor(Number(perReader)) || 2);
  const out = [];
  const list = Array.isArray(sources) ? sources : [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

function readerBrief(question, sources) {
  const list = (Array.isArray(sources) ? sources : []).map((s, i) => `${i + 1}. ${s.title ? s.title + ' - ' : ''}${s.url}${s.why ? '\n   Why it matters: ' + s.why : ''}`).join('\n');
  return [
    'You are a careful reader. Read the FULL TEXT of the source(s) below for this research question, and report what the sources themselves say. Do not rely on summaries, abstracts or search snippets alone.',
    '',
    `Question: ${String(question || '').trim()}`,
    '',
    'Sources:',
    list,
    '',
    'How to read:',
    '- Open each source\'s full text with WebFetch. For an arXiv paper try https://arxiv.org/html/<id> and its versions (v1, v2, v3 if one fails); also try https://arxiv.org/pdf/<id>. PDFs are read as text by the fetch tool. For long pages call WebFetch again with offset to continue until the end.',
    '- Read the method, the experiments, the ablations and the appendix, not only the abstract.',
    '- Read only. Do NOT download, install or run any model, code or dataset. Do not clone repositories.',
    '- Never invent or round a number. Copy every number exactly as printed (0.550 stays 0.550). Every number carries its location (Table N, Section N, Figure N, Appendix X), who judged it (humans or a model), and the sample size (how many raters or items).',
    '- Report what the source\'s own evidence says mattered most (for example the ablation row that produced the gain), not what you think should matter.',
    '- Report the limits the authors state themselves.',
    '- If you could not open the full text, say exactly which URLs you tried and what came back. Do not fill the gap from memory.',
    '- Quote prompts, templates or definitions verbatim when the source prints them; if it only describes them, say "described, not printed".',
    '',
    'Output: your reply is the report; do not write files. For EACH source use exactly these headings:',
    '## <title> (<url>)',
    '- Full text opened: yes/no (URLs tried)',
    '### Method',
    '### Results (location, who judged, sample size)',
    '### What mattered most (the source\'s own evidence)',
    '### Limits',
    '### Could not read',
    '',
    'At most about 1,200 words per source. Put "Nothing" under a heading that has no content.',
  ].join('\n');
}

// ---------------------------------------------------------------- synthesis

function asText(v, joiner = '\n\n') {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : x && x.text ? x.text : x && x.notes ? x.notes : '')).filter(Boolean).join(joiner);
  return String(v || '');
}

function synthesisBrief(question, quickFindings, readerNotes, fetchedList) {
  const fetched = Array.isArray(fetchedList) ? fetchedList : [];
  const opened = fetched.filter((f) => f.ok);
  const notOpened = fetched.filter((f) => !f.ok);
  const fmt = (arr) => (arr.length ? arr.map((f) => `- ${f.title ? f.title + ' - ' : ''}${f.url}${f.error && !f.ok ? ' (' + String(f.error).slice(0, 120).replace(/\s+/g, ' ') + ')' : ''}`).join('\n') : '- none');
  return [
    'Write the research report. You have the first-pass findings, and detailed notes from readers who read the sources in full text. Where they differ, the full-text notes win.',
    '',
    `Question: ${String(question || '').trim()}`,
    '',
    'Write, in markdown, these sections in this order:',
    '## Verdict  (2-4 sentences: the answer)',
    '## Evidence  (bullets; each with the source title, URL and date)',
    '## Where sources disagree',
    '## Confidence  (high, medium or low, and why)',
    '## Corrections to the first pass  (what the full-text reading changed or corrected in the quick findings: wrong or mislabelled figures, versions of a paper with different numbers, claims the sources do not support; write "None" if there are none)',
    '',
    'Then a fenced block labelled claims containing a JSON array, one object per claim the report relies on:',
    '```claims',
    '[{"id": "c1", "claim": "...", "source_url": "...", "figures": ["56.4", "43.6"], "measured_result": "...", "judged_by": "humans", "evidence_strength": "strong", "inference": false}]',
    '```',
    'Field rules:',
    '- id: c1, c2, ... unique.',
    '- figures: every figure the claim relies on, each exactly as printed in the source, write each figure with its unit exactly as the source prints it (56.4% if the source prints 56.4%; 56.4 if it prints 56.4 in a table). A scale word may stay with the number (300k, 1.5 million). A count or amount keeps the word the source prints right after it ("1,250 participants", "$500 pesos", "1250 ms"), and a qualifier the source prints stays ("at least 1,250 participants"). Use the same wording for the figure in the report text: the hub checks each figure against the source as written, so "1,250 adults" is not found when the source says "1,250 participants".',
    '- judged_by: "humans", "model", "mixed" or "not stated".',
    '- evidence_strength: "strong", "moderate" or "weak".',
    '- inference: true when the claim is our inference and the source does not state it; false when the source states it.',
    '- source_url: the one source the claim comes from.',
    '',
    'Rules:',
    '- Every figure that appears in the prose must also appear in some claim\'s figures, with the source it comes from. A figure with no source does not go in the report.',
    '- Every paragraph or bullet that gives a figure names its source\'s URL in that same paragraph or bullet.',
    '- Use only figures that you can see in the reader notes below. Never invent, round or recompute a figure.',
    '- When two versions of a source report different numbers, say which version each comes from.',
    '- Say plainly what the sources do not show. Do not mention how this report was produced.',
    '',
    'Sources opened in full:',
    fmt(opened),
    '',
    'Sources NOT opened in full (say so in the report where a point rests on them):',
    fmt(notOpened),
    '',
    'First-pass findings:',
    '"""',
    asText(quickFindings),
    '"""',
    '',
    'Reader notes (full text):',
    '"""',
    asText(readerNotes),
    '"""',
  ].join('\n');
}

const JUDGED = new Set(['humans', 'model', 'mixed', 'not stated']);
const STRENGTH = new Set(['strong', 'moderate', 'weak']);

function parseClaims(text) {
  const src = String(text || '');
  const blocks = fencedBlocks(src);
  let block = blocks.find((b) => b.lang === 'claims');
  if (!block) block = [...blocks].reverse().find((b) => b.lang === 'json');
  if (!block) return { prose: src.trim(), claims: [], error: 'no claims block found' };
  const prose = (src.slice(0, block.start) + src.slice(block.end)).replace(/\n{3,}/g, '\n\n').trim();
  const r = parseJsonLoose(block.body);
  if (r.error) return { prose, claims: [], error: 'claims block is not valid JSON: ' + r.error };
  if (!Array.isArray(r.value)) return { prose, claims: [], error: 'claims block is not a JSON array' };
  const claims = [];
  const warnings = [];
  const ids = new Set();
  r.value.forEach((it, i) => {
    if (!it || typeof it !== 'object' || Array.isArray(it)) { warnings.push(`item ${i + 1} is not an object`); return; }
    const claim = typeof it.claim === 'string' ? it.claim.trim() : '';
    if (!claim) { warnings.push(`item ${i + 1} has no claim text`); return; }
    let id = typeof it.id === 'string' || typeof it.id === 'number' ? String(it.id).trim() : '';
    if (!id || ids.has(id)) {
      if (id) warnings.push(`duplicate id ${id} renumbered`);
      let k = claims.length + 1;
      while (ids.has('c' + k)) k++;
      id = 'c' + k;
    }
    ids.add(id);
    const figures = Array.isArray(it.figures) ? it.figures.filter((f) => typeof f === 'string' || typeof f === 'number').map((f) => String(f).trim()).filter(Boolean) : [];
    const jb = typeof it.judged_by === 'string' ? it.judged_by.trim().toLowerCase() : '';
    const es = typeof it.evidence_strength === 'string' ? it.evidence_strength.trim().toLowerCase() : '';
    claims.push({
      id,
      claim,
      source_url: typeof it.source_url === 'string' ? it.source_url.trim() : '',
      figures,
      measured_result: typeof it.measured_result === 'string' ? it.measured_result.trim() : '',
      judged_by: JUDGED.has(jb) ? jb : 'not stated',
      evidence_strength: STRENGTH.has(es) ? es : 'weak',
      inference: it.inference === true || it.inference === 'true',
    });
  });
  const out = { prose, claims, error: '' };
  if (warnings.length) out.warnings = warnings;
  return out;
}

// ---------------------------------------------------------------- figure check

function normFigure(s) {
  let t = String(s == null ? '' : s).trim().replace(/−/g, '-').replace(/[\u2009\u202f\u00a0]/g, '');
  t = t.replace(/(?<=\d),(?=\d{3}(?!\d))/g, '');
  t = t.replace(/^\+/, '').replace(/\s*(?:%|percent|per cent)$/i, '');
  t = t.replace(/^(-?)\./, (all, sign) => sign + '0.'); // ".125" is 0.125
  return t.trim();
}

function hadPercent(s) { return /(?:%|\bpercent|\bper cent)\s*$/i.test(String(s == null ? '' : s)); }

// A leading-dot decimal (".125") is one number when no digit, letter or dot is directly before the dot.
const NUM_RE = /(?<![\d.A-Za-z])\.\d+%?|(?<!\d)(?:\d{1,3}(?:[,\u2009\u202f\u00a0]\d{3})+(?!\d)(?:\.\d+)?|\d+(?:\.\d+)?)%?/g;
const PCT_AFTER = /^\s?(?:%|percent\b|per cent\b)/i;

// A scale suffix right after a number. The words thousand/million/billion/trillion/bn/tn/pp/percentage point(s)/times may follow a space; the
// one-letter scales k, K, M, B and x touch the number ("300k", "5M"); with a space they are the next word ("300 K" is kelvin).
// A lower-case "m" touching the number is not million: it is the attached "m" of the written form.
// The scale words are case-insensitive ("Million", "BILLION"); the one-letter ones keep their case; "×" is x.
// "percentage point(s)" is pp; "-fold" and " times" are x.
const SCALE_WORD_RE = /^(?: ?(thousand|million|billion|trillion|bn|tn|pp|percentage points?|times)|(-fold))(?![A-Za-z0-9])/i;
const SCALE_RE = /^(?:(k|K|M|B)|(x|×))(?![A-Za-z0-9])/;
function scaleAfter(s) {
  let m = SCALE_WORD_RE.exec(s);
  if (m) {
    const w = (m[1] || m[2]).toLowerCase();
    return { suffix: w === 'times' || w === '-fold' ? 'x' : w.startsWith('percentage') ? 'pp' : w, len: m[0].length };
  }
  m = SCALE_RE.exec(s);
  if (m) { const x = m[1] || m[2]; return { suffix: x === '×' ? 'x' : x, len: m[0].length }; }
  return null;
}
const SCALE_POW = { thousand: 3, k: 3, K: 3, million: 6, M: 6, billion: 9, bn: 9, B: 9, trillion: 12, tn: 12 };

// Move the decimal point of a plain digit string (optionally negative) by n places (right for n > 0, left for n < 0); trailing zeros dropped.
function shiftDecimal(v, n) {
  const neg = v.startsWith('-');
  let [i, d = ''] = v.replace(/^-/, '').split('.');
  if (n > 0) { d = d.padEnd(n, '0'); i += d.slice(0, n); d = d.slice(n); }
  else if (n < 0) { i = i.padStart(-n + 1, '0'); d = i.slice(n) + d; i = i.slice(0, n); }
  i = i.replace(/^0+(?=\d)/, '');
  d = d.replace(/0+$/, '');
  return (neg ? '-' : '') + i + (d ? '.' + d : '');
}

// unit: '' | 'pct' | 'x' | 'pp'. mag: the quantity with the scale applied (300k and 300,000 share one mag).
// pct: the number carries a percent unit ("56.4%", "56.4 %", "56.4 percent", "56.4 per cent").
// Currency is a unit: $, US$, USD -> USD; € EUR -> EUR; £ GBP; ¥ JPY; ₹ INR. A symbol or code in front of or after the number.
// A letter-prefixed dollar sign (CA$, A$, C$) is its own unit 'X$:' + letters; US$ is USD. The extra ISO codes are matched
// upper case only (so ordinary words never match) and are each their own unit. After a number, "euro(s)" is EUR and "US dollar(s)" is USD.
// A symbol together with a code ("CAD $1,250", "$1,250 CAD"): the code wins over a bare "$"; any other symbol with a code that names
// a different currency is an unknown currency 'X?:' + both as written, upper case (it matches only the identical form).
// More symbols: ₩ KRW, ₽ RUB, ₺ TRY, ₪ ILS, ฿ THB, ₦ NGN; "Rs" / "Rs." before a number is the word-unit 'w:rupee'.
const CUR_SYMBOL = { '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '₩': 'KRW', '₽': 'RUB', '₺': 'TRY', '₪': 'ILS', '฿': 'THB', '₦': 'NGN' };
const CUR_OLD = '[Uu][Ss][Dd]|[Ee][Uu][Rr]|[Gg][Bb][Pp]|[Jj][Pp][Yy]|[Ii][Nn][Rr]';
const CUR_NEW = 'AUD|CAD|CHF|CNY|HKD|NZD|SGD|SEK|NOK|DKK|KRW|BRL|MXN|ZAR';
const CUR_CODES = `${CUR_OLD}|${CUR_NEW}`;
const CUR_SYM_CLASS = Object.keys(CUR_SYMBOL).join('');
// groups: 1 a code before a symbol, 2 letters before "$", 3 a symbol, 4 "Rs", 5 a code alone
const CUR_LEAD_RE = new RegExp(`(?:(?<![A-Za-z])(${CUR_CODES})\\s?)?(?:([A-Za-z]*)\\$|([${CUR_SYM_CLASS}])|(?<![A-Za-z])(Rs\\.?))\\s?$|(?<![A-Za-z])(${CUR_CODES})\\s?$`);
const CUR_TRAIL_RE = new RegExp(`^(?: ?(${CUR_CODES})(?![A-Za-z0-9])|\\s?([${CUR_SYM_CLASS}]))`);
const SIGN_PRE = /[\s(\[=:,;~<>≈"'/]/;

// The currency in front of a number: { from, code, sym: { cur, bare, text } | null, cut } or null. cut: a letter just before the
// matched text, i.e. the lookup window cut a longer word (the currency is then unknown).
function readLeadCur(s, index) {
  const m = CUR_LEAD_RE.exec(s.slice(Math.max(0, index - 12), index));
  if (!m) return null;
  const from = index - m[0].length;
  const lead = { from, code: (m[1] || m[5] || '').toUpperCase(), sym: null, cut: false };
  if (m[2] !== undefined) {
    const l = m[2].toUpperCase();
    lead.sym = { cur: !l || l === 'US' ? 'USD' : 'X$:' + l, bare: !l, text: l + '$' };
  } else if (m[3]) lead.sym = { cur: CUR_SYMBOL[m[3]], bare: false, text: m[3] };
  else if (m[4]) lead.sym = { cur: 'w:rupee', bare: false, text: 'Rs' };
  lead.cut = from > 0 && /^[A-Za-z]/.test(m[0]) && /[A-Za-z]/.test(s[from - 1]);
  return lead;
}

// Combine the currency in front (lead) with what follows the number (trail: { code, sym }).
function resolveCur(lead, trail) {
  const codes = [lead && lead.code, trail.code].filter(Boolean);
  const sym = (lead && lead.sym) || trail.sym || null;
  const unknown = 'X?:' + [lead && lead.code, sym && sym.text, trail.code].filter(Boolean).join(' ').toUpperCase();
  if (lead && lead.cut) return unknown;
  if (codes.length === 2 && codes[0] !== codes[1]) return unknown;
  const code = codes[0] || '';
  if (!sym) return code;
  if (sym.bare) return code || 'USD';
  if (!code) return sym.cur;
  return code === sym.cur ? code : unknown;
}

// Currency words after a number. "<word> dollars" ("Canadian dollars", "Hong Kong dollars": the last word before "dollars") is 'X$:' + that
// word upper case; "dollars" alone is 'X$:?' (never "$"). Other money words are their own 'w:<word>' unit.
const CUR_WORDS = [
  [/^ ?euros?(?![A-Za-z])/i, 'EUR'],
  [/^ ?u\.?s\.? dollars?(?![A-Za-z])/i, 'USD'],
  [/^ ?yen(?![A-Za-z])/i, 'JPY'],
  [/^ ?(?:yuan|renminbi)(?![A-Za-z])/i, 'CNY'],
  [/^ ?RMB(?![A-Za-z])/, 'CNY'],
  [/^ ?dollars?(?![A-Za-z])/i, 'X$:?'],
  [/^ ?rupees?(?![A-Za-z])/i, 'w:rupee'],
  [/^ ?pesos?(?![A-Za-z])/i, 'w:peso'],
  [/^ ?pounds?(?: sterling)?(?![A-Za-z])/i, 'w:pound'],
  [/^ ?rand(?![A-Za-z])/i, 'w:rand'],
  [/^ ?francs?(?![A-Za-z])/i, 'w:franc'],
  [/^ ?krona(?![A-Za-z])/i, 'w:krona'],
  [/^ ?kronor(?![A-Za-z])/i, 'w:kronor'],
  [/^ ?krone(?![A-Za-z])/i, 'w:krone'],
];
const DOLLARS_AFTER_RE = /^ (?:[A-Za-z]+ )?([A-Za-z]+) dollars?(?![A-Za-z])/;
function readCurWord(tail) {
  for (const [re, cur] of CUR_WORDS) { const m = re.exec(tail); if (m) return { cur, len: m[0].length }; }
  const d = DOLLARS_AFTER_RE.exec(tail);
  return d ? { cur: 'X$:' + d[1].toUpperCase(), len: d[0].length } : null;
}

// Measurement units: a closed table, each row one unit stored as 'u:<canonical>'. Columns: canonical, abbreviations (case matters:
// "MB" is not "mb"), whole words (any case), abbreviations read only after a space ("1990s" is not seconds).
// No conversion; KiB, MiB ... are not KB, MB ...; "kg" is not "kilogram".
const UNIT_DEFS = [
  ['ns', 'ns', 'nanosecond nanoseconds'],
  ['us', 'µs μs us', 'microsecond microseconds'],
  ['ms', 'ms msec', 'millisecond milliseconds'],
  ['s', 'sec secs', 'second seconds', 's'],
  ['min', 'min mins', 'minute minutes'],
  ['h', 'hr hrs', 'hour hours', 'h'],
  ['day', '', 'day days'],
  ['week', '', 'week weeks'],
  ['month', '', 'month months'],
  ['year', 'yr yrs', 'year years'],
  ['kB', 'kB KB'], ['KiB', 'KiB'], ['MB', 'MB'], ['MiB', 'MiB'], ['GB', 'GB'], ['GiB', 'GiB'], ['TB', 'TB'], ['TiB', 'TiB'], ['PB', 'PB'],
  ['bit', '', 'bit bits'],
  ['kbps', 'Kbps kbps'], ['Mbps', 'Mbps'], ['Gbps', 'Gbps'],
  ['nm', 'nm'], ['mm', 'mm'], ['cm', 'cm'], ['km', 'km'],
  ['metre', '', 'metre metres meter meters'],
  ['inch', '', 'inch inches'],
  ['ft', 'ft', 'foot feet'],
  ['mile', '', 'mile miles', 'mi'],
  ['mg', 'mg'], ['kg', 'kg'],
  ['gram', '', 'gram grams'],
  ['kilogram', '', 'kilogram kilograms'],
  ['lb', 'lb lbs'],
  ['tonne', '', 'tonne tonnes ton tons'],
  ['Hz', 'Hz'], ['kHz', 'kHz'], ['MHz', 'MHz'], ['GHz', 'GHz'],
  ['W', 'W', 'watt watts'], ['kW', 'kW'], ['MW', 'MW'], ['GW', 'GW'], ['kWh', 'kWh'], ['MWh', 'MWh'],
  ['V', 'V', 'volt volts'],
];
const UNIT_ABBR = new Map(); // abbreviation as written -> { u, spaced }
const UNIT_WORD = new Map(); // lower-case word -> u
for (const [u, abbr = '', words = '', spaced = ''] of UNIT_DEFS) {
  for (const a of abbr.split(' ').filter(Boolean)) UNIT_ABBR.set(a, { u, spaced: false });
  for (const a of spaced.split(' ').filter(Boolean)) UNIT_ABBR.set(a, { u, spaced: true });
  for (const w of words.split(' ').filter(Boolean)) UNIT_WORD.set(w, u);
}
// an abbreviation written in another case ("5 MS", "5 mb") is an unknown unit, never a bare number
const UNIT_ABBR_LOWER = new Set([...UNIT_ABBR].filter(([, v]) => !v.spaced).map(([k]) => k.toLowerCase()));
const UNIT_WORD_RE = /^( ?)([A-Za-zµμ]+)(?![A-Za-z0-9µμ])/;
const UNIT_TEMP_RE = /^ ?(° ?[CF]|℃|℉)(?![A-Za-z0-9])/;
// a unit that is part of a compound ("km/h", "m²", "MB·s") is not that unit alone: unknown, matches only the identical form
const UNIT_COMPOUND_RE = /^(?:\/ ?[A-Za-z]+|\^-?\d+|[²³⁴-⁹]|·[A-Za-z]+)/;
function readUnit(tail) {
  let u = '';
  let len = 0;
  const t = UNIT_TEMP_RE.exec(tail);
  if (t) {
    const k = t[1].slice(-1);
    u = '°' + (k === '℃' ? 'C' : k === '℉' ? 'F' : k);
    len = t[0].length;
  } else {
    const m = UNIT_WORD_RE.exec(tail);
    if (!m) return null;
    const a = UNIT_ABBR.get(m[2]);
    if (a && (!a.spaced || m[1])) u = a.u;
    else if (UNIT_WORD.has(m[2].toLowerCase())) u = UNIT_WORD.get(m[2].toLowerCase());
    else if (!a && UNIT_ABBR_LOWER.has(m[2].toLowerCase())) return { unit: 'X?:' + m[2].toUpperCase(), len: m[0].length };
    else return null;
    len = m[0].length;
  }
  const c = UNIT_COMPOUND_RE.exec(tail.slice(len));
  if (c) return { unit: 'X?:' + tail.slice(0, len + c[0].length).trim().toUpperCase(), len: len + c[0].length };
  return { unit: 'u:' + u, len };
}

// Exponents written right after a number's digits.
//   E-notation: "0.125e-3", "1.5E6", "2e+3", "1e−4" (e/E, an optional sign, digits, then no letter or digit).
//   "× 10^n", "x10^n", "·10^n", "* 10^n" (spaces optional) and the superscript form "× 10⁻³": the same scaling.
//   A number directly followed by "^n" or superscript digits (outside the "× 10" form) is a power: base 10 scales, any other base is an
//   unknown unit 'X?:pow' that matches only the identical written form ("2^10").
const SUPER_DIGITS = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-', '⁺': '+' };
const SUPER_CLASS = '[⁻⁺]?[⁰¹²³⁴⁵⁶⁷⁸⁹]+';
const E_NOTATION_RE = /^[eE]([-−+]?\d+)(?![A-Za-z\d])/;
const TIMES_TEN_RE = new RegExp(`^\\s?[×x·*]\\s?10\\s?(?:\\^\\s?\\{?([-\\u2212+]?\\d+)\\}?|(${SUPER_CLASS}))(?![A-Za-z\\d])`);
const POWER_RE = new RegExp(`^(?:\\^\\{?([-\\u2212+]?\\d+)\\}?|(${SUPER_CLASS}))`);
const MAX_EXPONENT = 60;
// the exponent as a plain string ("-3", "6")
function exponentText(m) {
  const t = m[1] !== undefined ? m[1] : m[2].replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]/g, (c) => SUPER_DIGITS[c]);
  return t.replace(/−/g, '-').replace(/^\+/, '');
}

// What may sit between the numbers of a compound figure ("5-10%", "5 to 10 ms", "1/8", "3:1"): one dash, " to ", one slash or one colon,
// nothing else (no white space around a dash: "Phase 2 - 30%" is two figures). Dash and "to" are one class.
function sepClass(gap) {
  if (/^[-–—]$/.test(gap) || gap === ' to ') return 'D';
  return gap === '/' || gap === ':' ? gap : '';
}

// "5-10%", "5 to 10 ms": the unit written at the end of a range applies to every part (the first number takes it).
function shareRangeUnits(s, toks) {
  for (let i = toks.length - 2; i >= 0; i--) {
    const a = toks[i];
    const b = toks[i + 1];
    if (a.unit || a.suffix || !b.unit || b.unit.startsWith('X?:pow') || sepClass(s.slice(a.end, b.from)) !== 'D') continue;
    a.unit = b.unit;
    a.pct = b.pct;
    a.cur = b.cur;
  }
}

const SIGN_CUR_RE = new RegExp(`[$${CUR_SYM_CLASS}]`);
const SCALE_WORDS = new Set(['thousand', 'million', 'billion', 'bn', 'trillion', 'tn']);

// ---- the written form of a number occurrence
// form = pre | post | word. pre: what is written directly before the number (a sign, a currency, letters), post: what is attached directly
// after it, word: the next word (unless it is a function word, or the number carries %, x, pp or an attached unit; a rate always counts).
// Two occurrences are "the same as written" when mag, unit, form and qualifier are equal. Nothing is converted; the aliases below are the
// only equivalences (applied to pre, post and word alike).
// (Words that can change a figure's meaning or be a unit are not function words: "in" is inches, "or", "and", "more", "less", "than",
// "over", "under", "all", "most", "only", "still", "so", "then", "also", "a", "an", "each".)
const FUNCTION_WORDS = new Set(('the of on at to for from by with but nor vs versus was were is are be been being as across among after before ' +
  'between during while whereas which that who whom whose when where if its their his her our this these those it they we he she both ' +
  'such into onto upon via').split(' '));
const WORD_ALIAS = new Map([
  ['percent', '%'], ['per cent', '%'], ['US$', '$'], ['USD', '$'], ['EUR', '€'], ['GBP', '£'], ['×', 'x'], ['times', 'x'], ['-fold', 'x'],
  ['percentage point', 'pp'], ['percentage points', 'pp'], ['millisecond', 'ms'], ['sec', 's'], ['second', 's'], ['minute', 'min'], ['hr', 'h'], ['hour', 'h'], ['−', '-'],
]);
// Qualifier words and phrases in front of a number (up to QUAL_MAX_WORDS words back, longest phrase first), as a list per qualifier.
// '~' approximation; '<' '>' '≤' '≥' bounds; 'not' a negation that matches only another "not". A negation in front of any other
// qualifier ("never above 5") voids it: the qualifier becomes 'not <q>', which no source occurrence has by accident.
const QUAL_LISTS = {
  '≤': ['a maximum of', 'maximum of', 'max.', 'capped at', 'up to', 'at most', 'no more than', 'not more than', 'not over', 'not above', 'not exceeding'],
  '≥': ['a minimum of', 'minimum of', 'min.', 'starting at', 'starting from', 'at least', 'no less than', 'no fewer than', 'not less than', 'not under', 'not below'],
  '>': ['exceeds', 'exceeded', 'exceeding', 'surpassed', 'surpassing', 'beyond', 'above', 'over', 'more than', 'greater than', 'in excess of'],
  '<': ['below', 'under', 'less than', 'fewer than'],
  '~': ['close to', 'some', 'circa', 'c.', 'ca.', 'an estimated', 'estimated', 'est.', 'on the order of', 'about', 'around', 'approximately', 'roughly', 'nearly', 'almost', '~', '≈'],
  not: ['not', 'not exactly', 'never'],
};
const QUAL_WORDS = new Map(Object.entries(QUAL_LISTS).flatMap(([q, words]) => words.map((w) => [w, q])));
const QUAL_MAX_WORDS = Math.max(...[...QUAL_WORDS.keys()].map((w) => w.split(' ').length));
const NEGATORS = new Set(['not', 'never']);
// "minus 5%", "negative 5": a sign word directly before the number is a sign
const SIGN_WORDS = new Map([['minus', '-'], ['negative', '-'], ['plus', '+'], ['positive', '+']]);
// Bound and approximation phrases written after a number: "5 or fewer", "5 or more users", "5 or so". They set the qualifier and are not the word.
const POST_QUAL_LISTS = {
  '≤': ['or fewer', 'or less', 'or below', 'or under', 'or lower', 'and below', 'and under', 'at most'],
  '≥': ['or more', 'or greater', 'or above', 'or over', 'or higher', 'and above', 'and over', 'or later'],
  '~': ['or so', 'or thereabouts'],
};
const POST_QUALS = new Map(Object.entries(POST_QUAL_LISTS).flatMap(([q, words]) => words.map((w) => [w, q])));
// Rates after a number: "per <word>", "/<word>", a superscript exponent, "a|an|each|every <word>" (as "per <word>"), and the frequency words.
const RATE_ARTICLES = new Set(['a', 'an', 'each', 'every']);
const RATE_FREQUENCY = new Set(['annually', 'annual', 'yearly', 'monthly', 'weekly', 'daily', 'hourly', 'quarterly', 'p.a', 'y/y', 'yoy']);
const QUAL_SYMBOLS = { '~': '~', '≈': '~', '<': '<', '>': '>', '≤': '≤', '≥': '≥', '<=': '≤', '>=': '≥' };
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Opening quotes and brackets, closing punctuation. (Markdown emphasis around a figure is blanked before the form is read, see blankMarkup;
// a marker left over wraps nothing and stays: "1250*" is not "1250".)
const OPENERS_START = /^[(\[{"'“‘]+/;
const CLOSERS_END = /[.,;:!?)\]}"'”’»]+$/;
const PRE_WORD_RE = new RegExp(`^(?:[-−+±~≈<>≤≥]|<=|>=|[$${CUR_SYM_CLASS}]|[A-Za-z]*\\$|[A-Z]{3}|Rs\\.?)$`);
const SUPERSCRIPT_RE = /[⁻⁺⁰¹²³⁴⁵⁶⁷⁸⁹]/;
const ENTITY_WORD_RE = /^&(?:#[xX]?[0-9a-fA-F]{1,7}|[A-Za-z][A-Za-z0-9]{1,8});$/; // an entity as a whole word (it stands undecoded only when unknown or invalid)

// One word as written: surrounding punctuation off; case-folded only when it has 5+ letters and no capital after the first ("Participants"
// = "participants"; "mbar" is not "Mbar" and "MiB" stays "MiB"); a plural "s" dropped from 5+ letters; aliases applied.
function canonWord(t) {
  if (t.length > 4 && !/[A-Z]/.test(t.slice(1))) t = t.toLowerCase();
  if (t.length >= 5 && /^[a-z]+s$/.test(t)) t = t.slice(0, -1);
  return WORD_ALIAS.get(t) || t;
}
const bareWord = (w) => String(w).replace(OPENERS_START, '').replace(CLOSERS_END, '');
const plainWord = (w) => canonWord(bareWord(w));
const nextWord = (w) => (FUNCTION_WORDS.has(bareWord(w).toLowerCase()) ? '' : plainWord(w));
const isRateWord = (w) => String(w).startsWith('/') || SUPERSCRIPT_RE.test(w);
const joinQual = (a, b) => (!a || a === b ? b : !b ? a : a + b);
// A rate at words[i]: { text, len } or null. "per month", "per user per day" (one rate each), "/s", "s⁻¹", "a month" (= "per month"), "annually".
function rateAt(words, i) {
  const w = words[i];
  if (!w) return null;
  const l = bareWord(w).toLowerCase();
  if ((l === 'per' || RATE_ARTICLES.has(l)) && words[i + 1]) return { text: 'per ' + plainWord(words[i + 1]), len: 2 };
  if (RATE_FREQUENCY.has(l) || isRateWord(w)) return { text: plainWord(w), len: 1 };
  return null;
}

// A plus-or-minus tail at words[i]: "±", "+/-", "+-" or "plus or minus" (the number may be attached: "±5%"), then what follows up to the next
// number and its unit: { text, len } or null. "± 5%" is "± 5%", "± 5 ms" is "± 5 ms" (a bare number takes the word after it if that is no
// function word), "±" alone is "±". It is part of the form of the number in front of it, like a rate.
const PLUS_MINUS_RE = /^(?:±|\+\/[-−]|\+[-−])/;
function plusMinusAt(words, i) {
  const w = words[i];
  if (!w) return null;
  let k = i + 1;
  let first = '';
  if (w.toLowerCase() === 'plus' && words[i + 1] && words[i + 1].toLowerCase() === 'or' && words[i + 2] && words[i + 2].toLowerCase() === 'minus') {
    k = i + 3;
  } else {
    const m = PLUS_MINUS_RE.exec(w);
    if (!m) return null;
    first = w.slice(m[0].length);
  }
  const parts = [];
  // the tokens after the marker, up to and including the first one with a digit (at most 4); a clause end stops it
  for (let n = 0; n < 4; n++) {
    let tok;
    if (n === 0 && first) tok = first;
    else if (k < words.length) tok = words[k++];
    else break;
    const bare = tok.replace(CLOSERS_END, '');
    if (bare) parts.push(bare);
    if (/\d/.test(tok)) {
      if (/^[\d.,]+$/.test(bare) && !endsClause(tok) && words[k] && /^[\p{L}µ°%$€£]/u.test(words[k])) { const u = nextWord(words[k]); if (u) { parts.push(u); k++; } }
      break;
    }
    if (endsClause(tok)) break;
  }
  return { text: ['±', ...parts].join(' '), len: k - i };
}

// The words after a number: a parenthesised group stays one token ("(USD)", "(n=20)"). Table scaffolding and sentence punctuation
// ("|", a lone dash, ".") is no word; any other symbol ("±", "/", "‰", "×", "*", "=") is a word as written.
const AFTER_TOKEN_RE = /\([^()\n]{1,60}\)|\S+/g;
const MAX_AFTER_TOKENS = 8;
const NO_WORD_TOKEN = /^[|\-–—.,;:!?…]+$/;
const CITATION_SHAPE = /https?:|www\.|:\/\//i;
function afterTokens(text) { return (text.match(AFTER_TOKEN_RE) || []).slice(0, MAX_AFTER_TOKENS); }
const endsClause = (w) => /[.,;:!?)\]}]$/.test(w);

// The written form after a number: its word (the first word that is not a function word, a parenthesised group or a symbol, when
// allowBase) and every rate after it, in order, and the bound phrase ("or more") if one stands there. Returns { word, bound }.
// A "(" directly followed by a plus-or-minus marker ("(± 5 ms)", "(+/-5%)", "(plus or minus 5)") is that tail: the group is read as its words.
const PM_GROUP_RE = /^\((?=±|\+\/[-−]|\+[-−]|plus or minus)([^()\n]*)\)$/i;
function afterNumber(rawWords, allowBase) {
  const words = rawWords.flatMap((w) => { const g = PM_GROUP_RE.exec(w); return g ? g[1].trim().split(/\s+/) : [w]; });
  let i = 0;
  let bound = '';
  const takeBound = () => {
    const q = words[i + 1] && POST_QUALS.get(`${bareWord(words[i]).toLowerCase()} ${bareWord(words[i + 1]).toLowerCase()}`);
    if (q) { bound = joinQual(bound, q); i += 2; }
  };
  takeBound();
  let base = '';
  const first = words[i];
  if (allowBase && first && !rateAt(words, i) && !plusMinusAt(words, i)) {
    const group = /^\(([^()\n]{1,60})\)$/.exec(first);
    if (group) {
      if (CITATION_SHAPE.test(group[1])) return { word: '', bound };
      base = group[1].trim().split(/\s+/).map(plainWord).join(' ');
    } else if (/^[(\[{]/.test(first) || NO_WORD_TOKEN.test(first)) return { word: '', bound };
    else if (!/[\p{L}\p{N}]/u.test(first)) base = canonWord(first);
    else base = nextWord(first);
    if (!base) return { word: '', bound };
    i++;
    if (!endsClause(words[i - 1])) takeBound();
  }
  // a plus-or-minus tail ("± 5%", "± 5 ms") is part of the form, in front of the rates
  let tail = '';
  if (i === 0 || !endsClause(words[i - 1])) {
    const pm = plusMinusAt(words, i);
    if (pm) { tail = pm.text; i += pm.len; }
  }
  // every rate after the word, in order; a word that ends a clause ("users.", "day,") ends the form
  const rates = [];
  if (i === 0 || !endsClause(words[i - 1])) {
    for (let r = rateAt(words, i); r; r = rateAt(words, i)) {
      rates.push(r.text);
      i += r.len;
      if (endsClause(words[i - 1])) break;
    }
  }
  // after the rates the bound and approximation phrases and the plus-or-minus tail are still read ("1250% per year or more",
  // "1250% per month ± 5%"); a tail after the rates stays after them in the form
  let lateTail = '';
  if (i > 0 && !endsClause(words[i - 1])) {
    takeBound();
    if (!tail && i < words.length && (i === 0 || !endsClause(words[i - 1]))) {
      const pm = plusMinusAt(words, i);
      if (pm) { lateTail = pm.text; i += pm.len; if (!bound && !endsClause(words[i - 1])) takeBound(); }
    }
  }
  return { word: [base, tail, ...rates, lateTail].filter(Boolean).join(' '), bound };
}

// What a qualifier word or phrase directly before the number says: the longest phrase of up to QUAL_MAX_WORDS words ending at the end
// of `text`; a negation in front of a phrase that is not itself a negation voids it.
function qualBefore(text) {
  const ws = text.trim().split(/\s+/).slice(-(QUAL_MAX_WORDS + 1)).map((w) => w.replace(OPENERS_START, '').toLowerCase());
  for (let n = Math.min(ws.length, QUAL_MAX_WORDS); n >= 1; n--) {
    const q = QUAL_WORDS.get(ws.slice(-n).join(' '));
    if (q) return q !== 'not' && NEGATORS.has(ws[ws.length - n - 1]) ? 'not ' + q : q;
  }
  return '';
}
// the symbols and codes in front of a number, as one canonical text
function canonPre(p) {
  return p.replace(/−/g, '-').replace(/(?<![A-Za-z])(?:US\$|USD)(?![A-Za-z])/g, '$').replace(/(?<![A-Za-z])EUR(?![A-Za-z])/g, '€').replace(/(?<![A-Za-z])GBP(?![A-Za-z])/g, '£');
}

// ds: where the digits start; fEnd: where the number ends (scale letters, %, exponent included; units and currency words not);
// carries: the number carries %, x or pp; wEnd: where a currency code or symbol after the number ends (the word is the next word after it).
function formOf(s, ds, fEnd, carries, wEnd = fEnd) {
  const before = s.slice(Math.max(0, ds - 80), ds);
  let rs = before.length;
  while (rs > 0 && !/\s/.test(before[rs - 1])) rs--;
  const run = before.slice(rs);
  const rawPost = /^\S*/.exec(s.slice(fEnd, fEnd + 120))[0];
  let post = canonWord(rawPost.replace(CLOSERS_END, ''));
  let pre = run.replace(OPENERS_START, '');
  // accounting negative "($1,250)": the opening bracket and the closing one stay
  const accounting = run.startsWith('(') && SIGN_CUR_RE.test(pre) && rawPost.replace(/[.,;:!?'"”’\]]+$/, '').endsWith(')');
  if (accounting) { pre = '(' + pre; post += ')'; }
  const attached = post !== '';
  // a currency code or symbol after the number, with a space, is its post ("$1,250 CAD" is not "CAD $1,250"); the word comes after it
  if (!attached && wEnd > fEnd) post = canonWord(s.slice(fEnd, wEnd).trim().toUpperCase());
  let qEnd = rs; // where the qualifier words may end
  if (run === '') {
    const head = before.slice(0, rs).replace(/\s+$/, '');
    const pm = /(\S+)$/.exec(head);
    const signWord = pm && SIGN_WORDS.get(bareWord(pm[1]).toLowerCase());
    if (pm && PRE_WORD_RE.test(pm[1])) { pre = pm[1]; qEnd = head.length - pm[1].length; }
    else if (signWord) { pre = signWord; qEnd = head.length - pm[1].length; }
    else if (pm && ENTITY_WORD_RE.test(pm[1])) { pre = pm[1]; qEnd = head.length - pm[1].length; } // an entity that stayed undecoded: part of the form as written
    else if (/\d[^\S\r\n]+$/.test(before)) pre = '#'; // spaced digit groups ("1  250", white space but no line break): never a number without it
  }
  let qual = '';
  const sm = /^(?:<=|>=|[~≈<>≤≥])/.exec(pre);
  if (sm) { qual = QUAL_SYMBOLS[sm[0]]; pre = pre.slice(sm[0].length); } else qual = qualBefore(before.slice(0, qEnd));
  pre = canonPre(pre);
  // sentence punctuation right after the number (or a parenthesis) ends the form: no word
  const afterPost = Math.max(wEnd, fEnd + rawPost.length);
  const ended = (rawPost !== '' && post === '' && !accounting) || (afterPost > fEnd + rawPost.length && /^\S/.test(s.slice(afterPost, afterPost + 1)));
  let word = '';
  if (!ended) {
    const after = afterNumber(afterTokens(s.slice(afterPost, afterPost + 200)), !carries && !attached);
    word = after.word;
    qual = joinQual(qual, after.bound);
  }
  return { pre, post, word, qual, form: `${pre}|${post}|${word}` };
}

// Consecutive numbers joined without white space by one dash, slash or colon (or " to ") are one compound figure: "5–10%", "1/8", "3:1".
// Returns the tokens with every such run replaced by one compound token (its pre and qualifier from the first part, post and word from the last).
// A trailing scale kept as written: "5–10 million" is the key "5-10|million" (the scale applies to the run, it is not converted into
// the last part only), so it never equals "5–10000000". Only when the last part has a scale and no earlier part does.
const SEP_KEY = { D: '-', '/': '/', ':': ':' };
const SCALE_NAME = { 3: 'thousand', 6: 'million', 9: 'billion', 12: 'trillion' }; // M and million are one scale word: "5–10M" is "5–10 million"
function compoundKey(parts, seps) {
  const last = parts[parts.length - 1];
  if (last.suffix && SCALE_POW[last.suffix] && parts.slice(0, -1).every((p) => !p.suffix)) {
    return parts.map((p, k) => (k ? SEP_KEY[seps[k - 1]] : '') + p.value).join('') + '|' + SCALE_NAME[SCALE_POW[last.suffix]];
  }
  return parts.map((p, k) => (k ? SEP_KEY[seps[k - 1]] : '') + p.mag).join('');
}

function groupRuns(text, toks, deadline) {
  const s = blankMarkup(text);
  const out = [];
  for (let i = 0; i < toks.length;) {
    if (deadline && Date.now() > deadline) throw TOO_SLOW;
    const seps = [];
    let j = i;
    while (j + 1 < toks.length) {
      const c = sepClass(s.slice(toks[j].end, toks[j + 1].from));
      if (!c) break;
      seps.push(c);
      j++;
    }
    if (j === i) { out.push(toks[i]); i++; continue; }
    const parts = toks.slice(i, j + 1);
    const first = parts[0];
    const last = parts[parts.length - 1];
    const key = compoundKey(parts, seps);
    out.push({ ...last, text: s.slice(first.from, last.end), raw: s.slice(first.index, last.end), mag: key, value: key, index: first.index, from: first.from, ...(first.signAt === undefined ? {} : { signAt: first.signAt }), suffix: '', pct: last.pct, percent: false,
      sci: parts.some((p) => p.sci), compound: true, parts: parts.map((p) => ({ value: p.mag, unit: p.unit })), seps, pre: first.pre, qual: first.qual, form: `${first.pre}|${last.post}|${last.word}` });
    i = j + 1;
  }
  return out;
}

// The numbers of a text (emphasis markers and HTML tags read as white space, see blankMarkup). deadline: a Date.now() value; indexing a
// text past it throws TOO_SLOW.
function numbersIn(text, deadline) {
  const { out: s, signs } = markupOf(text);
  const out = [];
  let upTo = 0; // a number inside an exponent already read ("10^-3": the 3) is not a token of its own
  NUM_RE.lastIndex = 0;
  for (const m of s.matchAll(NUM_RE)) {
    if (deadline && Date.now() > deadline) throw TOO_SLOW;
    if (m.index < upTo) continue;
    let index = m.index;
    let raw = m[0];
    let from = index;
    // a sign directly before the digits (also after a currency symbol: "$-1,250")
    const prev = s[index - 1];
    if (prev === '-' || prev === '−' || prev === '+') {
      const pp = s[index - 2];
      if (pp === undefined || SIGN_PRE.test(pp) || SIGN_CUR_RE.test(pp)) { index -= 1; raw = prev + raw; }
    }
    // a sign that was wrapped in markup ("**−** 1250") was moved next to its digits: signAt is where the text writes it
    const signAt = signs.get(index);
    let end = index + raw.length;
    let value = normFigure(raw);
    let mag = value;
    const percent = hadPercent(raw);
    const lead = percent ? null : readLeadCur(s, index);
    if (lead) {
      from = lead.from;
      // a sign in front of the currency: "-$1,250"
      const q = from - 1;
      const sg = s[q];
      if (!/^[-−+]/.test(raw) && (sg === '-' || sg === '−' || sg === '+') && (q === 0 || SIGN_PRE.test(s[q - 1]))) { value = mag = normFigure(sg + raw); from = q; }
    }
    // exponent forms: the number is then already scaled ('scaled'), or is a power of an unknown base ('fixed')
    let scaled = false;
    let fixed = false;
    if (!percent) {
      const tail = s.slice(end, end + 30);
      const ten = TIMES_TEN_RE.exec(tail) || E_NOTATION_RE.exec(tail);
      const hit = ten || POWER_RE.exec(tail);
      if (hit) {
        const e = exponentText(hit);
        const n = Number(e);
        raw = s.slice(index, end + hit[0].length);
        end += hit[0].length;
        if (Math.abs(n) <= MAX_EXPONENT && (ten || value === '10')) { mag = value = shiftDecimal(ten ? value : '1', n); scaled = true; }
        else { mag = value = value + (ten ? 'e' : '^') + e; fixed = true; }
      }
    }
    let suffix = '';
    if (!percent && !scaled && !fixed) {
      const sm = scaleAfter(s.slice(end, end + 20));
      if (sm) { suffix = sm.suffix; end += sm.len; }
    }
    const pct = !fixed && (percent || (!suffix && PCT_AFTER.test(s.slice(end, end + 12))));
    const ratio = suffix === 'x' || suffix === 'pp';
    // where the number itself ends for the written form: after "percent" / "per cent" too (units and currency words come after)
    let fEnd = end;
    if (pct && !percent && !suffix) fEnd += PCT_AFTER.exec(s.slice(end, end + 12))[0].length;
    // what follows the number: a currency code or symbol (also together with one in front), currency words, a measurement unit
    let cur = '';
    let unit = '';
    let wEnd = fEnd; // after a currency code or symbol that follows the number: the word of the form comes after it
    if (!pct && !ratio && !fixed) {
      const trail = { code: '', sym: null };
      const tr = CUR_TRAIL_RE.exec(s.slice(end, end + 8));
      if (tr && tr[1]) { trail.code = tr[1].toUpperCase(); end += tr[0].length; }
      else if (tr && !lead) { trail.sym = { cur: CUR_SYMBOL[tr[2]], bare: false, text: tr[2] }; end += tr[0].length; }
      if (tr && (tr[1] || !lead)) wEnd = end;
      cur = lead || trail.code || trail.sym ? resolveCur(lead, trail) : '';
      if (!cur) {
        const w = readCurWord(s.slice(end, end + 40));
        if (w) { cur = w.cur; end += w.len; }
        else if (!suffix || SCALE_WORDS.has(suffix)) {
          const u = readUnit(s.slice(end, end + 40));
          if (u) { unit = u.unit; end += u.len; }
        }
      }
      if (cur) unit = cur;
    } else if (fixed) unit = 'X?:pow' + (lead ? ':' + resolveCur(lead, { code: '', sym: null }) : '');
    else if (pct) unit = 'pct';
    else unit = suffix;
    const pow = SCALE_POW[suffix];
    if (index < from) from = index;
    upTo = end;
    const f = formOf(s, m.index, fEnd, pct || ratio, wEnd);
    out.push({ text: s.slice(from, end), raw, value, mag: pow ? shiftDecimal(value, pow) : mag, suffix, unit, cur, index, from, end, percent, pct, sci: scaled || fixed, ...(signAt === undefined ? {} : { signAt }), ...f });
  }
  shareRangeUnits(s, out);
  return out;
}

// What a figure is for matching: the number (value = mag; for a compound the parts' mags with their separators), its unit, its written
// form (pre|post|word) and its qualifier. A token of numbersIn / groupRuns is turned into this; so is a figure string.
function figOf(t) {
  return { value: t.mag, unit: t.unit, pct: t.unit === 'pct', pre: t.pre, post: t.post, word: t.word, form: t.form, qual: t.qual, ...(t.parts ? { parts: t.parts } : {}), ...(t.sci ? { sci: true } : {}) };
}

// Text that may stand in front of the first number of a figure string ("about 1,250", "at least $5"): a qualifier only.
const FIGURE_LEAD_RE = new RegExp(`^[\\s(~≈<>≤≥=]*(?:(?:${[...QUAL_WORDS.keys(), ...SIGN_WORDS.keys()].map(escapeRe).join('|')})\\s+)?$`, 'i');

// Parse one figure as written ("300k", "56.4%", "1,250 participants", "$1.5 Million", "5–10%") into a figure (see figOf). A figure string
// is read on its own: its form holds what the string itself says around the number. Several numbers joined by one dash, slash or colon
// ("5–10%", "1/8", "3:1") are one compound figure; a string that merely holds a second number ("85.2% (±1.3)") is its first number.
function parseFigure(figure) {
  const str = String(figure == null ? '' : figure).trim();
  const toks = groupRuns(str, numbersIn(str));
  const t = toks.find((x) => FIGURE_LEAD_RE.test(str.slice(0, x.from)));
  if (t) return figOf(t);
  return { value: normFigure(str), unit: hadPercent(str) ? 'pct' : '', pct: hadPercent(str), pre: '', post: '', word: '', form: '||', qual: '' };
}

// Common: an integer below 1000, or a decimal with fewer than 3 significant digits.
function isCommon(value) {
  const v = String(value).replace(/^-/, '');
  if (/^\d{1,3}$/.test(v)) return true;
  if (/^\d+\.\d+$/.test(v)) return v.replace('.', '').replace(/^0+/, '').length < 3;
  return false;
}

// ---- visible text. Every step below replaces what is not visible text with white space of the same length, so offsets stay valid.
const blankOut = (s) => s.replace(/[^\n]/g, ' ');

// HTML comments <!-- ... --> (an unterminated one hides the rest, as a browser shows it). Linear: no regex backtracking.
// gone: when given, every span blanked is added to it as [from, to) (see taintTouching).
function blankComments(s, gone) {
  let a = s.indexOf('<!--');
  if (a < 0) return s;
  let out = '';
  let i = 0;
  while (a >= 0) {
    const b = s.indexOf('-->', a + 4);
    const e = b < 0 ? s.length : b + 3;
    if (gone) gone.push([a, e]);
    out += s.slice(i, a) + blankOut(s.slice(a, e));
    i = e;
    a = s.indexOf('<!--', i);
  }
  return out + s.slice(i);
}

// Markdown links, one linear and fail-safe pass over the lines (no nested scans, no balancing of parentheses):
//  - from each "](" (a link or image destination, its title inside it) to the end of that line;
//  - each reference label "][...]" (from "][" to the next "]", or to the end of the line when none closes it);
//  - every reference-definition line (a line that begins, after any white space, with "[label]:"), and the line after it when that starts
//    (after optional white space) with a quote or "(" (its title).
// gone: every span blanked is added to it as [from, to). deadline: a Date.now() value; checked every 1024 lines (throws TOO_SLOW).
const REF_DEF_LINE_RE = /^[ \t]*\[[^\]\n]*\]:/;
const REF_TITLE_LINE_RE = /^[ \t]*["'(]/;
function blankLinks(s, gone, deadline) {
  if (s.indexOf('](') < 0 && s.indexOf('][') < 0 && s.indexOf(']:') < 0) return s;
  const parts = [];
  let from = 0; // what is copied so far
  const blank = (a, b) => { if (b <= a) return; gone.push([a, b]); parts.push(s.slice(from, a), blankOut(s.slice(a, b))); from = b; };
  let pos = 0;
  let titleNext = false;
  for (let n = 0; pos <= s.length; n++) {
    if (deadline && (n & 1023) === 0 && Date.now() > deadline) throw TOO_SLOW;
    let eol = s.indexOf('\n', pos);
    if (eol < 0) eol = s.length;
    const line = s.slice(pos, eol);
    if (REF_DEF_LINE_RE.test(line)) { blank(pos, eol); titleNext = true; }
    else if (titleNext && REF_TITLE_LINE_RE.test(line)) { blank(pos, eol); titleNext = false; }
    else {
      titleNext = false;
      let j = line.indexOf(']');
      while (j >= 0) {
        const c = line[j + 1];
        if (c === '(') { blank(pos + j + 1, eol); break; }
        if (c === '[') {
          const close = line.indexOf(']', j + 2);
          if (close < 0) { blank(pos + j + 1, eol); break; }
          blank(pos + j + 1, pos + close + 1);
          j = line.indexOf(']', close + 1);
        } else j = line.indexOf(']', j + 1);
      }
    }
    pos = eol + 1;
  }
  parts.push(s.slice(from));
  return parts.join('');
}
const BARE_URL_RE = /(?:https?:\/\/|www\.)[^\s<>"'`\])]+/gi;

// Entities that are decoded (case as written; the spaces are plain spaces). Any other named entity stays as written.
const NAMED_ENTITIES = {
  lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ', thinsp: ' ', ensp: ' ', emsp: ' ',
  minus: '−', ndash: '–', mdash: '—', plusmn: '±', times: '×', divide: '÷', le: '≤', ge: '≥', ne: '≠', asymp: '≈', approx: '≈',
  deg: '°', percnt: '%', permil: '‰', euro: '€', pound: '£', yen: '¥', cent: '¢', dollar: '$', micro: 'µ', middot: '·',
  sup1: '¹', sup2: '²', sup3: '³', frac12: '½', frac14: '¼', frac34: '¾',
  leq: '≤', geq: '≥', leqslant: '≤', geqslant: '≥', nle: '≰', nge: '≱', lne: '⪇', gne: '⪈', nlt: '≮', ngt: '≯',
  sim: '∼', thicksim: '∼', simeq: '≃', approxeq: '≊', pm: '±', mp: '∓', MinusPlus: '∓', PlusMinus: '±', sdot: '⋅',
  hyphen: '‐', dash: '‐', horbar: '―', commat: '@', num: '#',
};
const ENTITY_RE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,8}));/g;

// Every numeric entity and the named ones above become their character plus spaces up to the length written. The spaces go on the side
// away from what the character belongs to: before a sign, a bound or a currency ("&#x2212;1250" is "       −1250", the sign still
// sits right in front of its digits), after a character that follows its number (% ‰ ° ¹ ² ³: "1250&percnt;" is "1250%      ").
// One pass: "&amp;lt;" is "&lt;" and no more. A code point that is no character, or an unknown name, stays as written.
const FOLLOWS_NUMBER = /^[%‰°¹²³]$/;
// An entity (decoded or not) directly between two digits ("1&#44;250", "5&#45;10") becomes '#' characters of the same length: neither
// neighbour reads as a clean number. An entity that stays as written (unknown name, invalid code) is part of the form around a number
// (see formOf), so it never matches a plain figure.
// A number split by what was removed between its parts (see taintSplits) is tainted here too: the spaces an entity became are the removed span.
function decodeEntities(s) {
  const gone = []; // the spaces the entities became: [from, to), in order
  const out = s.replace(ENTITY_RE, (m, dec, hex, name, at) => {
    if (at > 0 && /\d/.test(s[at - 1]) && /\d/.test(s[at + m.length] || '')) return '#'.repeat(m.length);
    let ch = null;
    if (name) ch = Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : null;
    else {
      const cp = dec ? Number(dec) : parseInt(hex, 16);
      if (cp > 0 && cp <= 0x10FFFF && !(cp >= 0xD800 && cp <= 0xDFFF)) ch = String.fromCodePoint(cp);
    }
    if (ch === null) return m;
    const pad = ' '.repeat(m.length - ch.length);
    if (pad) gone.push(FOLLOWS_NUMBER.test(ch) ? [at + ch.length, at + m.length] : [at, at + pad.length]);
    return FOLLOWS_NUMBER.test(ch) ? ch + pad : pad + ch;
  });
  return gone.length ? taintSplits(out, gone) : out;
}

// Numbers split by removed markup: when something was removed (a tag, emphasis markers, an entity's spaces) directly next to a digit, and on the
// other side of the removed span a digit follows, or a ',' or '.' followed by a digit, or (the other way round) a digit followed by ',' or '.'
// ("1,<b>250</b>", "1.<b>5</b>", "1250&#46;&#53;"), neither side is a clean number: the first and the last character of the removed span
// become '#', so the number before it gets a '#' after it and the number after it a '#' in front of it (neither matches a plain figure).
// Other removed spans in between are looked through. t: the text; runs: the removed spans [from, to), ascending (touching ones are one span).
// A new line inside a span stays a new line.
const isDigitCh = (c) => c !== undefined && c >= '0' && c <= '9';
const isSepCh = (c) => c === ',' || c === '.';
function mergeSpans(runs) {
  const spans = [];
  for (const r of runs.slice().sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
    const last = spans[spans.length - 1];
    if (last && last[1] >= r[0]) last[1] = Math.max(last[1], r[1]); else spans.push([r[0], r[1]]);
  }
  return spans;
}
// A span that was blanked (an element that is not shown, a comment, an image, a reference definition, a link address) touches a number when
// the character right in front of it or right behind it (no white space between) is a digit, a sign, a currency symbol, '.' or ',' (or '&':
// an entity that may become one of them): the span's first and last character become '#', so the number next to it is not a clean one
// ("<span class="neg">-</span>1250", "1250<span class="u"> million</span>"). t: the text; runs: the blanked spans [from, to), any order.
// (Only the end that faces the touching character is tainted: a link address is always right behind "]" and a sentence's full stop may
// follow it: "[$1250](https://x.example/p)." keeps its figure clean, the stop only touches the span's last character.)
const touchesNumber = (c) => c !== undefined && (isDigitCh(c) || c === '.' || c === ',' || c === '&' || /[-−–+±]/.test(c) || /\p{Sc}/u.test(c));
function taintTouching(t, runs) {
  if (!runs.length) return t;
  let out = null;
  for (const [a, b] of mergeSpans(runs)) {
    const front = touchesNumber(t[a - 1]);
    const back = touchesNumber(t[b]);
    if (!front && !back) continue;
    let first = a;
    while (first < b && t[first] === '\n') first++;
    let last = b - 1;
    while (last > first && t[last] === '\n') last--;
    if (first < b) { if (!out) out = t.split(''); if (front) out[first] = '#'; if (back) out[last] = '#'; }
  }
  return out ? out.join('') : t;
}
function taintSplits(t, runs) {
  const spans = mergeSpans(runs);
  let out = null;
  for (let n = 0; n < spans.length; n++) {
    const [a, b] = spans[n];
    const L = [];
    for (let p = a - 1, k = n - 1; L.length < 2 && p >= 0;) {
      if (k >= 0 && p >= spans[k][0] && p < spans[k][1]) { p = spans[k][0] - 1; k--; continue; }
      L.push(t[p]); p--;
    }
    const R = [];
    for (let p = b, k = n + 1; R.length < 2 && p < t.length;) {
      if (k < spans.length && p >= spans[k][0] && p < spans[k][1]) { p = spans[k][1]; k++; continue; }
      R.push(t[p]); p++;
    }
    if (!((isDigitCh(L[0]) && (isDigitCh(R[0]) || (isSepCh(R[0]) && isDigitCh(R[1])))) || (isDigitCh(R[0]) && isSepCh(L[0]) && isDigitCh(L[1])))) continue;
    let first = a;
    while (first < b && t[first] === '\n') first++;
    let last = b - 1;
    while (last > first && t[last] === '\n') last--;
    if (first < b) { if (!out) out = t.split(''); out[first] = '#'; out[last] = '#'; }
  }
  return out ? out.join('') : t;
}

// ---- elements that are not visible text. An element's contents count as visible only when the element and every element around it is on
// the allowlist below and carries no attribute that code cannot read as harmless; any other element (script, style, dialog, details, an
// unknown tag, a tag with a class, style, id, hidden, data-* ... attribute) is blanked whole, contents too.
// (no sup / sub: "12<sup>3</sup>" is 123 or 12 cubed, code cannot tell which: such a source is unreadable)
const SHOWN_TAGS = new Set(['p', 'td', 'th', 'tr', 'table', 'thead', 'tbody', 'tfoot', 'caption', 'b', 'i', 'em', 'strong', 'li', 'ul', 'ol', 'dl', 'dt', 'dd',
  'span', 'div', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code', 'pre', 'small', 'u', 's', 'mark', 'q', 'cite', 'abbr', 'time', 'a']);
const SHOWN_ATTRS = { a: new Set(['href']), td: new Set(['colspan', 'rowspan']), th: new Set(['colspan', 'rowspan']) };
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']); // no closing tag
const MAX_ELEMENT = 20000; // an element longer than this, or never closed, is blanked to the end of the text (fail-safe)
const MAX_TAG = 2000;
// quoted attribute values may hold ">" ("<div title="a>b">"); every part is bounded, and each character has one way to be read
const QUOTED = `"[^"]{0,${MAX_TAG}}"|'[^']{0,${MAX_TAG}}'`;
const ANY_TAG_RE = new RegExp(`<(\\/?)([A-Za-z][A-Za-z0-9:-]{0,30})((?:${QUOTED}|[^<>"']){0,${MAX_TAG}})>`, 'g');
// one attribute (name, and a value in quotes or bare), after white space; sticky: read one after another from a position
const ATTR_STICKY = /\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>=`]*))?/y;

// A tag with no attribute at all, or only the ones listed for its name (href on a, colspan / rowspan on td and th). A self-closing slash is
// no attribute. Anything else, including a stray quote or a bare word, is not allowed.
function attrsAllowed(name, attrs) {
  const a = attrs.replace(/\/\s*$/, '');
  if (!a.trim()) return true;
  const ok = SHOWN_ATTRS[name];
  if (!ok) return false;
  let pos = 0;
  while (pos < a.length) {
    ATTR_STICKY.lastIndex = pos;
    const m = ATTR_STICKY.exec(a);
    if (!m) return !a.slice(pos).trim();
    if (!ok.has(m[1].toLowerCase())) return false;
    pos += m[0].length;
  }
  return true;
}

// Blank (with spaces, same length) every element that is not shown, from its opening tag to its matching closing tag. One pass over the tags,
// linear: inside a blanked element only the tags of its own name are counted (an open one adds, a closing one takes away; a self-closing
// slash on a non-void element is ignored: the element is open). An element with no matching close, or none within MAX_ELEMENT characters,
// is blanked to the end of the text. A void element that is not shown (img, input ...) is blanked as the tag only. deadline: a Date.now()
// value; past it the pass throws TOO_SLOW.
// A "<" followed by a letter or "/": the start of something a browser reads as a tag.
// ("<?" too: a processing instruction is markup, not text)
const TAG_START_RE = /<[A-Za-z/?]/g;
// none: true when a stylesheet may be at work (see STYLESHEET_RE): no element is shown, the allowlist is treated as empty.
// gone: when given, every span blanked is added to it as [from, to) (see taintTouching).
// A "<" + letter or "/" that does not start a tag closing within MAX_TAG characters (see ANY_TAG_RE) blanks from there to the end of the text.
function blankHiddenElements(s, deadline, gone, none) {
  if (s.indexOf('<') < 0) return s;
  let out = '';
  let from = 0; // s[from..] is not copied yet
  let name = ''; // the element being blanked ('' when none)
  let depth = 0;
  let open = 0; // where its opening tag ends
  let pos = 0; // the end of the last tag read: a tag start between it and the next tag was not read as a tag
  const blank = (a, b) => { if (gone) gone.push([a, b]); return blankOut(s.slice(a, b)); };
  ANY_TAG_RE.lastIndex = 0;
  TAG_START_RE.lastIndex = 0;
  for (let m = ANY_TAG_RE.exec(s); ; m = ANY_TAG_RE.exec(s)) {
    if (deadline && Date.now() > deadline) throw TOO_SLOW;
    TAG_START_RE.lastIndex = pos;
    const stray = TAG_START_RE.exec(s);
    if (stray && (!m || stray.index < m.index)) { // an unterminated or over-long tag: everything from it on is not visible text
      const a = name ? from : stray.index;
      out += s.slice(from, a) + blank(a, s.length);
      return out;
    }
    if (!m) break;
    pos = m.index + m[0].length;
    const tag = m[2].toLowerCase();
    const after = pos;
    if (name) {
      if (m.index >= open + MAX_ELEMENT) break; // no close within reach: blanked to the end below
      if (tag !== name) continue;
      if (!m[1]) depth++;
      else if (--depth === 0) { out += blank(from, after); from = after; name = ''; }
      continue;
    }
    if (m[1] || (!none && SHOWN_TAGS.has(tag) && attrsAllowed(tag, m[3]))) continue; // a closing tag outside any blanked element; a shown element
    if (VOID_TAGS.has(tag)) { out += s.slice(from, m.index) + blank(m.index, after); from = after; continue; }
    out += s.slice(from, m.index);
    from = m.index;
    name = tag; depth = 1; open = after;
  }
  if (name) { out += blank(from, s.length); from = s.length; }
  return out + s.slice(from);
}

// A markdown image is not visible text: "![alt" up to its matching "]" (brackets inside counted, a new line allowed, at most 2,000 characters;
// no match: the rest of the line), then the destination "(...)" or the reference "[...]" right after it. "![alt]" alone is blanked too.
const IMAGE_ALT_MAX = 2000;
const IMAGE_DEST_RE = /\((?:[^()\n]|\([^()\n]{0,300}\)){0,300}\)|\[[^\]\n]{0,200}\]/y;
// deadline: a Date.now() value; past it the pass throws TOO_SLOW. gone: when given, every span blanked is added to it as [from, to).
// The "]" that closes the "[" of an image is found with one pass over the text (a stack of open brackets, "\" skips the next character),
// so a text of many unclosed "![" costs no more than its length.
function blankImages(s, deadline, gone) {
  let i = s.indexOf('![');
  if (i < 0) return s;
  const closeOf = new Map(); // "[" position -> the position of its "]"
  const open = [];
  for (let j = 0; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') j++;
    else if (c === '[') open.push(j);
    else if (c === ']' && open.length) closeOf.set(open.pop(), j);
  }
  let out = '';
  let from = 0;
  while (i >= 0) {
    if (deadline && Date.now() > deadline) throw TOO_SLOW;
    const stop = Math.min(s.length, i + IMAGE_ALT_MAX);
    const j = closeOf.has(i + 1) ? closeOf.get(i + 1) : -1;
    let end;
    if (j >= i + 2 && j < stop) {
      end = j + 1;
      IMAGE_DEST_RE.lastIndex = end;
      const d = IMAGE_DEST_RE.exec(s);
      if (d) end += d[0].length;
    } else {
      const nl = s.indexOf('\n', i);
      end = nl < 0 ? s.length : nl;
    }
    if (gone) gone.push([i, end]);
    out += s.slice(from, i) + blankOut(s.slice(i, end));
    from = end;
    i = s.indexOf('![', end);
  }
  return out + s.slice(from);
}

// What a source states as visible text: no HTML comments, no elements that are not shown (see SHOWN_TAGS: script, style, a tag with a class or
// any other attribute ...), no markdown images, no reference definitions, no link addresses or titles (markdown link destinations and bare
// URLs; the link text stays), and the entities decoded (see decodeEntities). HTML tags and emphasis markers are blanked by blankMarkup, in
// numbersIn. deadline: a Date.now() value; the element pass throws TOO_SLOW past it.
// A stylesheet (a style element, a link to one, a style attribute) can hide any element or show any text in a way code cannot read: when the
// source has one, no element's contents count at all (text outside every element still does). Bounded, linear.
const STYLESHEET_RE = /<style\b|<link\b[^<]{0,2000}stylesheet|\bstyle\s*=/i;
// Every blanked span touching a number taints it (see taintTouching).
function visibleText(text, deadline) {
  const raw = String(text || '');
  const gone = [];
  const t = blankImages(blankComments(raw, gone), deadline, gone);
  const s = blankLinks(blankHiddenElements(t, deadline, gone, STYLESHEET_RE.test(raw)), gone, deadline).replace(BARE_URL_RE, blankOut);
  return decodeEntities(taintTouching(s, gone));
}

// Markup between a sign or currency and the digits is not part of the form: HTML tags (the tag itself, not the text between) and
// emphasis markers (** __ * _ `) that wrap text become spaces. A marker opens only after a non-word character and before text, and
// closes only after text and before a non-word character, so "1250*" and "3 * 10^5" keep their star. Used on sources and on report prose.
// A sign wrapped in markup ("**−** 1250", "<b>-</b>1250") is the sign of the number after it: the sign moves next to the digits.
// (a tag may hold quoted values with ">" in them, up to 2,000 characters; one that does not close that way is read as a plain tag of up to 500)
const TAG_RE = new RegExp(`<\\/?[A-Za-z](?:(?:${QUOTED}|[^<>"']){0,${MAX_TAG}}>|[^<>]{0,500}>)`, 'g');
const EMPHASIS_RE = /(?<![A-Za-z0-9])(\*\*|__|\*|_|`)(?=\S)([^\n]{0,200}?)(?<=\S)\1(?![A-Za-z0-9])/g;
const MARK_UNIT = '(?:<\\/?[A-Za-z][^<>]{0,100}>|[*_`])'; // one way to read each character: no exponential backtracking
// (the look-behind keeps a run of markers from being tried from each of its characters: linear on "*" repeated)
const WRAPPED_SIGN_RE = new RegExp(`(?<![A-Za-z0-9*_\`>])${MARK_UNIT}+([-−+])${MARK_UNIT}+[ \\t]*(?=\\d)`, 'g');
const MARK_RUN_RE = new RegExp(`^${MARK_UNIT}+`);
const markupMemo = { text: null, out: '', signs: new Map() };
// Returns { out, signs }: the text with its markup blanked; signs maps the place where a wrapped sign was moved to (right in front of
// its digits) to the place the sign was written at in the text ("**−** 1250": the sign character itself).
function markupOf(text) {
  const s = String(text == null ? '' : text);
  if (markupMemo.text === s) return markupMemo;
  const signs = new Map();
  const gone = []; // what the two passes below removed: [from, to)
  const blanked = s.replace(WRAPPED_SIGN_RE, (m, sign, offset) => {
    signs.set(offset + m.length - 1, offset + MARK_RUN_RE.exec(m)[0].length);
    return ' '.repeat(m.length - 1) + sign;
  }).replace(TAG_RE, (m, offset) => { gone.push([offset, offset + m.length]); return blankOut(m); })
    .replace(EMPHASIS_RE, (m, mark, inner, offset) => {
      gone.push([offset, offset + mark.length], [offset + m.length - mark.length, offset + m.length]);
      return ' '.repeat(mark.length) + inner + ' '.repeat(mark.length);
    });
  // a number split by what was removed ("1,<b>250</b>"): neither side is a clean number
  const out = gone.length ? taintSplits(blanked, gone.sort((x, y) => x[0] - y[0] || x[1] - y[1])) : blanked;
  markupMemo.text = s; markupMemo.out = out; markupMemo.signs = signs;
  return markupMemo;
}
function blankMarkup(text) { return markupOf(text).out; }

// A hard cap on the check per source: a text longer than maxChars, or one whose indexing takes longer than maxMs, is "too large to
// check" (buildIndex returns null). The limits are an object so a test can lower them.
const INDEX_LIMITS = { maxChars: 600000, maxMs: 2000 };
const TOO_SLOW = new Error('indexing took too long');

// ---- what the check reads of a source: plain reading text only. Rendering or converting raw HTML is not done: code cannot be sure what a
// converter leaves visible.
// checkableText(text, deadline) -> { text, kind }:
//   'reading'    no HTML tag start at all (no "<" followed by a letter, "/", "!" or "?"): the text as it is
//   'unreadable' any tag start (a processing instruction such as <?xml ... ?> is markup too)
//   'too_large'  longer than INDEX_LIMITS.maxChars, or past the deadline (a Date.now() value; default: INDEX_LIMITS.maxMs from now)
// One derived text per source: every offset, passage and excerpt of the check is read in it. The text of 'unreadable' / 'too_large' is ''.
const READ_TAG_START_RE = /<[A-Za-z/!?]/;
const UNREADABLE = Object.freeze({ text: '', kind: 'unreadable' });
const TOO_LARGE = Object.freeze({ text: '', kind: 'too_large' });
const checkCache = new Map(); // the last IDX_KEEP results (not 'too_large': a limit or a deadline may differ the next time)
// No conversion: any tag start ("<" and a letter, "/", "!" or "?") makes the source unreadable. When code cannot be sure, it does not count.
function checkableOf(src) {
  if (READ_TAG_START_RE.test(src)) return UNREADABLE;
  return { text: src, kind: 'reading' };
}
function checkableText(text, deadline) {
  const src = String(text == null ? '' : text);
  if (src.length > INDEX_LIMITS.maxChars) return TOO_LARGE;
  if (checkCache.has(src)) {
    const hit = checkCache.get(src);
    checkCache.delete(src);
    checkCache.set(src, hit);
    return hit;
  }
  let out;
  try { out = checkableOf(src, deadline || Date.now() + INDEX_LIMITS.maxMs); } catch (e) {
    if (e === TOO_SLOW) return TOO_LARGE;
    throw e;
  }
  checkCache.set(src, out);
  if (checkCache.size > IDX_KEEP) checkCache.delete(checkCache.keys().next().value);
  return out;
}

// The occurrences of every number in a text, by mag; a compound run ("5–10%") is one entry under its own key (its parts have none).
// Returns null when the text is too large to check. The last 24 used indexes are kept (a report checks several sources in turn; an entry
// is refreshed each time it is used), so indexing a source again within a run does not flip a result (a text that is too slow once).
const IDX_KEEP = 24;
const idxCache = new Map();
const INDEX_STATS = { built: 0 }; // how many indexes were built (not served from the cache): for tests
function buildIndex(text) {
  const src = String(text == null ? '' : text);
  if (idxCache.has(src)) {
    const hit = idxCache.get(src);
    idxCache.delete(src);
    idxCache.set(src, hit);
    return hit;
  }
  const map = indexOfText(src);
  idxCache.set(src, map);
  if (idxCache.size > IDX_KEEP) idxCache.delete(idxCache.keys().next().value);
  return map;
}
function indexOfText(src) {
  INDEX_STATS.built++;
  if (src.length > INDEX_LIMITS.maxChars) return null;
  const deadline = Date.now() + INDEX_LIMITS.maxMs;
  const map = new Map();
  try {
    const kind = checkableText(src, deadline).kind;
    if (kind === 'too_large' || kind === 'unreadable') return null; // nothing is found in a text the check cannot read as plain text
    const clean = visibleMemo(src, deadline);
    const toks = numbersIn(clean, deadline);
    // a number that is part of a compound run ("5 to 10 users", "5–10%") is indexed only as the compound, never on its own
    for (const t of groupRuns(clean, toks, deadline)) {
      let a = map.get(t.mag);
      if (!a) { a = []; map.set(t.mag, a); }
      a.push(t);
    }
  } catch (e) {
    if (e === TOO_SLOW) return null;
    throw e;
  }
  return map;
}

const GENERIC_WORDS = new Set(['accuracy', 'result', 'results', 'model', 'models', 'performance', 'score', 'scores', 'dataset', 'datasets', 'table', 'tables', 'figure', 'figures', 'human', 'humans', 'study', 'studies', 'using', 'which', 'their', 'these', 'those', 'between', 'compared', 'higher', 'lower', 'average', 'percent']);

function keywordsFrom(text) {
  const words = [...new Set((String(text || '').toLowerCase().match(/[a-z]{5,}/g) || []))].filter((w) => !GENERIC_WORDS.has(w));
  return words.map((w, i) => ({ w, i })).sort((a, b) => b.w.length - a.w.length || a.i - b.i).slice(0, 8).map((x) => x.w);
}

// The only statuses of a figure: found as written, not found as written, source not opened (and, in the report marks, no source to check).
const FOUND = 'found_as_written';
const NOT_FOUND = 'not_found_as_written';
const NOT_OPENED = 'source_not_opened';
const NO_SOURCE = 'no_source';
// Statuses saved by older runs: 'found' is found as written; 'not_found' and 'common_not_near' are not found as written. (Claim-level
// statuses 'verified', 'unverified', 'partly' of older runs map the same way.)
const SAVED_STATUS = { found: FOUND, verified: FOUND, not_found: NOT_FOUND, common_not_near: NOT_FOUND, unverified: NOT_FOUND, partly: 'partly_found_as_written' };
function savedStatus(s) { return Object.prototype.hasOwnProperty.call(SAVED_STATUS, s) ? SAVED_STATUS[s] : s; }

// Approximation qualifiers (~): the figure may carry one the source does not; the source may not carry one the figure does not.
// Bound qualifiers (< > ≤ ≥): equal on both sides.
function qualOk(fig, hit) {
  const f = fig || '';
  const h = hit || '';
  return f === h || (f === '~' && h === '');
}

// An occurrence is the same as the figure when the number, the unit, the written form (pre, post, next word) and the qualifier are equal;
// a compound also has equal parts (number and unit each) and separators.
function sameAsWritten(fig, h) {
  if (h.mag !== fig.value || (h.unit || '') !== (fig.unit || '') || h.form !== fig.form || !qualOk(fig.qual, h.qual)) return false;
  if (!fig.parts) return !h.parts;
  return !!h.parts && h.parts.length === fig.parts.length && h.parts.every((p, i) => p.unit === (fig.parts[i].unit || ''));
}

// fig: a figure (see figOf). Found as written only when the source has the same number written the same way; the common-number keyword
// rule (an integer below 1000 and the like) still needs a claim keyword within 300 characters.
function checkValue(fig, sourceText, keywords) {
  if (!fig || !fig.value) return NOT_FOUND;
  const text = String(sourceText || '');
  const index = buildIndex(text);
  if (!index) return NOT_OPENED; // too large to check
  const hits = (index.get(fig.value) || []).filter((h) => sameAsWritten(fig, h));
  if (!hits.length) return NOT_FOUND;
  const first = fig.parts ? fig.parts[0].value : fig.value;
  if (!isCommon(first)) return FOUND;
  const kws = (keywords || []).map((k) => String(k).toLowerCase()).filter(Boolean);
  const visible = visibleMemo(text); // the keyword must stand in text a reader sees (not in a comment, a hidden element, an image's alt text)
  for (const h of hits) {
    const win = visible.slice(Math.max(0, h.index - 300), h.end + 300).toLowerCase();
    if (kws.some((k) => win.includes(k))) return FOUND;
  }
  return NOT_FOUND;
}

function checkFigure(figure, sourceText, keywords) {
  return checkValue(parseFigure(figure), sourceText, keywords);
}

// The fetched record that stands for the source a claim cites, or null. A claim that names an arXiv version (".../2401.12345v2") is
// answered only by a fetch that really landed on that version (its finalUrl, else its url): a fetch whose url says v2 but whose
// finalUrl says v1 holds v1 text, so the claim has no source to check ('none' in sourceState). A claim without a version may use any.
function findFetched(url, fetched) {
  if (!normUrl(url)) return null;
  let best = null;
  for (const f of Array.isArray(fetched) ? fetched : []) {
    if (!f) continue;
    // where the fetch really landed is its finalUrl (else its url); it must be the same source (same arXiv paper id, and the same version
    // when the claim names one) as the claim's URL: a url that matches while the finalUrl is another paper credits nothing
    if (!sameSource(url, f.finalUrl || f.url)) continue;
    if (f.ok && f.text) return f;
    if (!best) best = f;
  }
  return best;
}

// Every figure a claim relies on: its figures array plus every checkable number in its claim and measured_result text.
// A figure is its number, unit, written form and qualifier: "125 participants" and "125% growth" are two figures.
// A bare figure from the figures array that the claim text shows with a unit or a word ("56.4" / "56.4%") is that figure as the claim wrote it.
function claimFigureList(c, counts) {
  const map = new Map();
  const add = (figure, p) => {
    if (!p.value) return;
    const key = [p.value, p.unit, p.form, p.qual].join('|');
    if (!map.has(key)) map.set(key, { figure: String(figure), ...p });
  };
  const inText = [];
  for (const text of [c.claim, c.measured_result]) for (const t of figuresInProse(text, counts)) inText.push({ figure: t.text, ...figOf(t) });
  const entries = (Array.isArray(c.figures) ? c.figures : []).map((f) => [f, parseFigure(f)]);
  for (const [f, p] of entries) {
    if (!p.value) continue;
    if (!p.unit && !p.post && !p.word && !inText.some((t) => t.value === p.value && t.unit === p.unit && t.form === p.form)) {
      const u = inText.find((t) => t.value === p.value && (t.unit || t.post || t.word));
      if (u) { const { figure, ...rest } = u; add(figure, rest); continue; }
    }
    add(f, p);
    // every other number written in the same entry ("85.2% (±1.3)": the 1.3) is a figure of its own, checked as written
    for (const t of figuresInProse(String(f), counts)) {
      const q = figOf(t);
      if (q.value === p.value && q.form === p.form && (q.unit || '') === (p.unit || '')) continue;
      add(t.text, q);
    }
  }
  for (const t of inText) { const { figure, ...rest } = t; add(figure, rest); }
  return [...map.values()];
}

// What the check says about a claim's source: 'opened' (the fetched text can be searched), 'not_opened' (fetched, but could not be opened)
// or 'none' (no citation, or a citation that is not among the fetched sources). A text too large to check (see buildIndex) is
// 'not_opened' with tooLarge: true.
function sourceState(url, fetched) {
  const src = findFetched(url, fetched);
  if (!src) return { src: null, state: 'none' };
  if (!(src.ok && src.text)) return { src, state: 'not_opened' };
  if (checkableText(src.text).kind === 'unreadable') return { src, state: 'not_opened', unreadable: true }; // not plain reading text (see checkableText)
  return buildIndex(src.text) ? { src, state: 'opened' } : { src, state: 'not_opened', tooLarge: true };
}

// One checked figure: its text and status. The parsed figure (value, unit, written form, qualifier) rides along, not enumerable, so the
// meaning check can find the occurrence that matched without parsing the figure text a second time.
function entryOf(x, status) {
  const e = { figure: x.figure, status };
  Object.defineProperty(e, 'parsed', { value: x, enumerable: false, writable: true, configurable: true });
  return e;
}

const UNREADABLE_CHECK = 'source could not be read in a checkable form';
const UNREADABLE_MARK = '(could not be read in a checkable form)';

// How the opened sources (ok, with text) were read: distinct sources by the kind of their checkable text (see checkableText). A source too
// large to check is counted in none of the three.
function sourceKindCounts(fetched) {
  const n = { sourcesReading: 0, sourcesConverted: 0, sourcesUnreadable: 0 };
  const seen = new Set();
  for (const f of Array.isArray(fetched) ? fetched : []) {
    if (!f || !f.ok || !f.text) continue;
    const key = normUrl(f.finalUrl || f.url) || String(f.finalUrl || f.url || '');
    if (key && seen.has(key)) continue;
    const kind = checkableText(f.text).kind;
    if (kind === 'too_large') continue;
    if (key) seen.add(key);
    if (kind === 'reading') n.sourcesReading++;
    else n.sourcesUnreadable++; // (sourcesConverted stays 0: nothing is converted any more)
  }
  return n;
}

function checkClaims(claims, fetched, counts) {
  const totals = { claims: 0, figures: 0, found: 0, notFound: 0, notOpened: 0, noSource: 0 };
  const out = [];
  for (const c of Array.isArray(claims) ? claims : []) {
    const figs = claimFigureList(c, counts);
    const { src, state, tooLarge, unreadable } = sourceState(c.source_url, fetched);
    const res = { id: c.id, source_opened: state === 'opened', figures: [], status: '' };
    if (tooLarge) res.too_large = true;
    if (unreadable) res.reason = 'unreadable';
    totals.claims++;
    totals.figures += figs.length;
    if (state !== 'opened') {
      const st = state === 'none' ? NO_SOURCE : NOT_OPENED;
      res.figures = figs.map((x) => entryOf(x, st));
      res.status = st;
      if (st === NO_SOURCE) totals.noSource += figs.length; else totals.notOpened += figs.length;
    } else if (!figs.length) {
      res.status = 'no_figures';
    } else {
      const kws = keywordsFrom(c.claim);
      res.figures = figs.map((x) => entryOf(x, checkValue(x, src.text, kws)));
      const f = res.figures.filter((x) => x.status === FOUND).length;
      totals.found += f;
      totals.notFound += figs.length - f;
      res.status = f === figs.length ? FOUND : f === 0 ? NOT_FOUND : 'partly_found_as_written';
    }
    out.push(res);
  }
  return { claims: out, totals };
}

// Numbers in prose that count as figures the report cites (everything except a fixed list of exemptions).
const MONTHS = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';
const DATE_RES = [
  /\b\d{4}-\d{1,2}-\d{1,2}\b/g,
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
  new RegExp(`\\b${MONTHS}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`, 'gi'),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTHS}\\s+\\d{4}\\b`, 'gi'),
];
const LOCATION_BEFORE = /(?:\b(?:Tables?|Sections?|Sec\.|Figures?|Fig\.|Appendix|Appendices|Eq\.|Equations?)|§)\s*[A-Za-z]?\s*$/i;
const SELF_COUNT_AFTER = /^\s(?:sources?|papers|claims|readers|rounds)\b/i;
// A 4-digit number is a year only in a year-like place.
const YEAR_BEFORE = new RegExp(`(?:\\b(?:in|since|from|until|by|of)|\\b${MONTHS}|[(–-])\\s*$`, 'i');
const YEAR_AFTER = /^(?:[),.;–]|-\d{4}\b|[ \t]*(?:\n|$))/;

function spansOf(text, re) {
  const out = [];
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) out.push([m.index, m.index + m[0].length]);
  return out;
}

// A number inside a word that starts with a letter is a name or a version (GPT-4.1, Llama-3.1-8B, o4-mini, v2).
function insideLetterWord(s, index) {
  let i = index - 1;
  const stop = Math.max(-1, index - 80); // bounded: a name longer than this is no name
  while (i > stop && /[A-Za-z0-9._-]/.test(s[i])) i--;
  return /^[A-Za-z]/.test(s.slice(i + 1, index).replace(/^[._-]+/, ''));
}

// Returns { token, exempt: reason|'' } for every number token. Exported for tests.
// counts: the numbers the report states about itself; "N sources" is a self count only when N is one of them.
// (Without counts, any "N sources|papers|claims|readers|rounds" is exempt.)
function classifyProseNumbers(prose, counts) {
  const s = String(prose || '');
  const urlSpans = spansOf(s, /(?:https?:\/\/|www\.)[^\s<>"'`\])]+/g);
  const dateSpans = DATE_RES.flatMap((re) => spansOf(s, re));
  const inSpan = (spans, a, b) => spans.some(([x, y]) => a >= x && b <= y);
  const own = counts && typeof counts === 'object' ? new Set(Object.values(counts).map(Number).filter(Number.isFinite)) : null;
  return numbersIn(s).map((t) => {
    let reason = '';
    const before = s.slice(0, t.index);
    const after = s.slice(t.end);
    const lineStart = before.slice(before.lastIndexOf('\n') + 1);
    if (inSpan(urlSpans, t.index, t.end)) reason = 'url';
    else if (inSpan(dateSpans, t.index, t.end)) reason = 'date';
    else if (!t.suffix && !t.unit && /^\d{4}$/.test(t.raw) && +t.raw >= 1900 && +t.raw <= 2100 && (YEAR_BEFORE.test(before) || YEAR_AFTER.test(after))) reason = 'year';
    else if (/^\s*(?:[-*+>]\s+)?$/.test(lineStart) && /^[.)](?:\s|$)/.test(after) && /^\d+$/.test(t.raw)) reason = 'list marker';
    else if (LOCATION_BEFORE.test(before)) reason = 'location';
    else if (!t.pct && SELF_COUNT_AFTER.test(after) && (!own || own.has(Number(t.value)))) reason = 'self count';
    // a currency code glued to the digits ("USD1,250", "EUR5") is a figure, not a name: the letters before it decide, not the code itself
    else if (insideLetterWord(s, t.cur && t.from < t.index ? t.from : t.index)) reason = 'name or version';
    return { token: t, exempt: reason };
  });
}

// The figures a report cites: its non-exempt numbers, a run of numbers joined by one dash, slash or colon as one compound figure.
function figuresInProse(prose, counts) {
  const s = String(prose || '');
  return groupRuns(s, classifyProseNumbers(s, counts).filter((x) => !x.exempt).map((x) => x.token));
}

// The marks written after a figure in the text.
const MARK_NOT_FOUND = '[not found in source]';
const MARK_NOT_OPENED = '[source not opened]';
const MARK_NO_SOURCE = '[no source to check]';
// the check did not run on this text (it failed, the run stopped before it, the report had no claims list, or a section added after it)
const NOT_CHECKED = 'not_checked';
const MARK_NOT_CHECKED = '[not checked]';
// the second mark: a figure found as written whose surrounding words the reviewer found to say something different
const DIFFERS = 'meaning_differs';
const MARK_DIFFERS = '[source says otherwise]';
const MARK_OF = { [NOT_FOUND]: MARK_NOT_FOUND, [NOT_OPENED]: MARK_NOT_OPENED, [NO_SOURCE]: MARK_NO_SOURCE, [NOT_CHECKED]: MARK_NOT_CHECKED, [DIFFERS]: MARK_DIFFERS };
const ANY_MARK_RE = /^ \[(?:not found in source|source not opened|no source to check|not checked|source says otherwise)\]/;

// Write a mark after each figure: mark is a status ('not_found_as_written' ...) for all of them, or a function of the token.
function insertMarks(s, toks, mark = NOT_FOUND) {
  const todo = toks.filter((t) => !ANY_MARK_RE.test(s.slice(t.end, t.end + 24)));
  let out = s;
  for (const t of [...todo].sort((a, b) => b.end - a.end)) out = out.slice(0, t.end) + ' ' + MARK_OF[typeof mark === 'function' ? mark(t) : mark] + out.slice(t.end);
  return { prose: out, marks: todo.length };
}

// Mark every figure whose number is not in the set of found numbers ("not found in source").
function markProse(prose, verifiedSet) {
  const s = String(prose || '');
  const ok = verifiedSet instanceof Set ? verifiedSet : new Set(Array.isArray(verifiedSet) ? verifiedSet.map(normFigure) : []);
  return insertMarks(s, figuresInProse(s).filter((t) => !ok.has(t.value) && !ok.has(t.mag)));
}

// Normalised values of every figure that was found as written in its source (build the set markProse needs).
function verifiedFigures(result) {
  const set = new Set();
  for (const c of (result && result.claims) || []) for (const f of c.figures || []) if (savedStatus(f.status) === FOUND) { set.add(normFigure(f.figure)); set.add(parseFigure(f.figure).value); }
  return set;
}

// Blocks of prose: a blank line, or a bullet / numbered line, starts a new block. Returns [{ start, end }].
function proseBlocks(prose) {
  const s = String(prose || '');
  const blocks = [];
  let start = -1;
  let pos = 0;
  let last = 0;
  for (const line of s.split('\n')) {
    const lineEnd = pos + line.length;
    if (!line.trim()) { if (start >= 0) { blocks.push({ start, end: last }); start = -1; } }
    else {
      if (start >= 0 && /^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) { blocks.push({ start, end: last }); start = -1; }
      if (start < 0) start = pos;
      last = lineEnd;
    }
    pos = lineEnd + 1;
  }
  if (start >= 0) blocks.push({ start, end: last });
  return blocks;
}

function urlRelated(a, b) { return sameSource(a, b) || sameSource(b, a); }

// A source title names the source in prose only when it is long enough to be specific (3 words or 20 characters: "Pricing" is
// not) and only as whole words.
const TITLE_MIN_WORDS = 3;
const TITLE_MIN_CHARS = 20;
function citableTitle(title) {
  const t = String(title == null ? '' : title).trim().toLowerCase().replace(/\s+/g, ' ');
  return t && (t.split(' ').length >= TITLE_MIN_WORDS || t.length >= TITLE_MIN_CHARS) ? t : '';
}
function titleRegex(title) {
  const body = title.split(' ').map(escapeRe).join('\\s+');
  return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, 'i');
}

// A full stop after one of these does not end a sentence.
// "No." (capitalised, as in "No. 5") is an abbreviation; "no." ends a sentence.
const ABBREV_BEFORE = /(?:^|[\s(\[“"'])(?:et al|e\.g|i\.e|vs|fig|figs|eq|inc|ltd|dr|approx|cf)$/i;
const ABBREV_NO = /(?:^|[\s(\[“"'])No$/;
const NUMBER_AFTER = /^\s*[\d#]/;

// Split a block into sentences: ., ? or ! followed by white space, or "; ", but not after a common abbreviation (et al., e.g., Fig.).
// A markdown table row (a line starting with "|") is its own sentence. Returns [{ start, end }] (absolute offsets in text).
function sentencesOf(text, base) {
  const out = [];
  const splitPlain = (seg, off) => {
    const re = /[.?!]+(?=\s)|;(?= )/g;
    let start = 0;
    for (let m = re.exec(seg); m; m = re.exec(seg)) {
      if (m[0] === '.' && (ABBREV_BEFORE.test(seg.slice(0, m.index)) || (ABBREV_NO.test(seg.slice(0, m.index)) && NUMBER_AFTER.test(seg.slice(m.index + 1))))) continue;
      const end = m.index + m[0].length;
      out.push({ start: base + off + start, end: base + off + end });
      start = end;
    }
    if (start < seg.length) out.push({ start: base + off + start, end: base + off + seg.length });
  };
  let pos = 0;
  let plainFrom = 0;
  for (const line of text.split('\n')) {
    const lineEnd = pos + line.length;
    if (/^\s*\|/.test(line)) {
      if (plainFrom < pos) splitPlain(text.slice(plainFrom, pos - 1), plainFrom);
      out.push({ start: base + pos, end: base + lineEnd });
      plainFrom = lineEnd + 1;
    }
    pos = lineEnd + 1;
  }
  if (plainFrom < text.length) splitPlain(text.slice(plainFrom), plainFrom);
  return out;
}

// Inside one sentence: the clauses, cut at ", " "; " and the words while, whereas, but, compared with, versus, vs, and
// ("and" only when a figure follows in the same clause). Returns [{ start, end }] (absolute offsets).
function clausesOf(text, start, end) {
  const seg = text.slice(start, end);
  const re = /, |; | while | whereas | but | compared with | versus | vs | and /gi;
  const cuts = [];
  for (let m = re.exec(seg); m; m = re.exec(seg)) {
    if (/^ and $/i.test(m[0])) {
      const rest = seg.slice(m.index + m[0].length);
      const nextCut = rest.search(/, |; | while | whereas | but | compared with | versus | vs /i);
      if (!/\d/.test(nextCut < 0 ? rest : rest.slice(0, nextCut))) continue;
    }
    cuts.push(m.index);
    re.lastIndex = m.index + m[0].length - 1;
  }
  const out = [];
  let from = 0;
  for (const c of cuts) { out.push({ start: start + from, end: start + c }); from = c; }
  out.push({ start: start + from, end });
  return out;
}

// The whole figure check: claims against their sources, then every prose figure against a claim cited in its own sentence
// (or, when the sentence cites nothing, the block's single cited source). A figure that has no such source is "no source to check";
// one whose cited source could not be opened is "source not opened"; one the opened source does not have as written is "not found".
// meaningKeys: { [meaningKey]: { meaning, quote } } from the credited review rounds (see figureMeanings). Without an entry for a figure's
// current key its meaning is "not checked": a figure never "matches" by default.
function checkReport({ prose, claims, fetched, counts, meaningKeys } = {}) {
  const p = String(prose || '');
  const list = Array.isArray(claims) ? claims : [];
  const cnt = counts && typeof counts === 'object' ? counts : {};
  const toks = figuresInProse(p, cnt);
  if (!list.length) {
    const m = insertMarks(p, toks, NOT_CHECKED);
    return { prose: m.prose, claims: [], totals: { claims: 0, figures: 0, found: 0, notFound: 0, notOpened: 0, noSource: 0, proseFigures: toks.length, proseFound: 0, proseNotFound: 0, proseNotOpened: 0, proseNoSource: 0, proseNotChecked: toks.length, ...sourceKindCounts(fetched) }, notChecked: true, marks: m.marks };
  }
  const res = checkClaims(list, fetched, cnt);
  Object.assign(res.totals, sourceKindCounts(fetched));
  const states = proseStates(p, list, fetched, cnt, toks);
  // the second mark: each found figure's meaning, looked up by its own current key. A claim figure: claim, figure, passage around it.
  // A figure of the report text: its sentence, the figure, the passage around it (never the meaning of a claim figure it resembles).
  const mk = meaningKeys && typeof meaningKeys === 'object' ? meaningKeys : null;
  if (mk && Object.keys(mk).length) {
    for (const x of figureExcerpts(list, fetched, res)) {
      const m = meaningOf(mk, x.meaningKey);
      if (!m) continue;
      const e = res.claims[x.claimIndex].figures[x.figIndex];
      e.meaning = m.meaning; e.meaning_quote = m.quote;
    }
    for (const x of proseEntries(p, toks, states)) {
      const m = meaningOf(mk, x.meaningKey);
      if (m) states[x.tokenIndex].meaning = m.meaning;
    }
  }
  const meanings = res.claims.flatMap((r) => r.figures).filter((f) => f.status === FOUND);
  res.totals.meaningMatches = meanings.filter((f) => f.meaning === 'matches').length;
  res.totals.meaningDiffers = meanings.filter((f) => f.meaning === 'differs').length;
  return reportResult(p, toks, states, res, applyCheck(list, res));
}

// The state of every figure of the report text (toks, in order): found as written / not found as written / source not opened / no
// source to check. A found one carries `through`, the claim record whose source had it as written. Each figure takes the citation in
// its own sentence (clause) or, when the sentence cites nothing, the block's single cited source.
function proseStates(p, list, fetched, cnt, toks) {
  const info = list.map((c, i) => {
    const { src, state } = sourceState(c.source_url, fetched);
    const title = citableTitle(src && src.title);
    return { i, c, src, state, text: state === 'opened' ? src.text : '', title, titleRe: title ? titleRegex(title) : null, kws: keywordsFrom(c.claim) };
  });
  // A citation in the text names this claim's source: the addresses are related, and a citation that names an arXiv version ("v2")
  // needs fetched text of that same version (an unversioned claim whose fetch landed on v1 does not answer for v2).
  const cites = (x, u) => {
    if (!normUrl(x.c.source_url) || !urlRelated(x.c.source_url, u)) return false;
    const v = arxivVersion(u);
    if (!v) return true;
    const actual = x.src && (x.src.finalUrl || x.src.url);
    return !!actual && arxivVersion(actual) === v;
  };
  const blocks = proseBlocks(p);
  const citedIn = (a, b) => {
    const text = p.slice(a, b);
    const urls = urlsIn(text).map((u) => u.url);
    return info.filter((x) => urls.some((u) => cites(x, u)) || (x.titleRe && x.titleRe.test(text)));
  };
  // An explicit citation (a URL, or a matched source title) in a span that does not resolve to a claim whose source was fetched.
  const unresolved = (a, b) => {
    const text = p.slice(a, b);
    if (urlsIn(text).some((u) => !info.some((x) => x.text && cites(x, u.url)))) return true;
    return info.some((x) => !x.text && x.titleRe && x.titleRe.test(text));
  };
  // Why a span's citation does not resolve: every unresolved address belongs to a source that was fetched but could not be opened
  // ("source not opened"), or something else is wrong ("no source to check").
  const unresolvedKind = (a, b) => {
    const text = p.slice(a, b);
    const gone = urlsIn(text).filter((u) => !info.some((x) => x.text && cites(x, u.url)));
    return gone.every((u) => info.some((x) => x.state === 'not_opened' && cites(x, u.url))) ? NOT_OPENED : NO_SOURCE;
  };
  const figureIn = (c) => toks.some((x) => x.index >= c.start && x.index < c.end);
  // A clause with a figure and no citation takes the citation of its nearest neighbouring clause (one with a citation or a figure),
  // only when that neighbour has no figure of its own and exactly one citation.
  const inherited = (cls, cl) => {
    const i = cls.indexOf(cl);
    for (let d = 1; d < cls.length; d++) {
      for (const j of [i - d, i + d]) {
        const nb = cls[j];
        if (!nb) continue;
        const nc = citedIn(nb.start, nb.end);
        const hasUrl = urlsIn(p.slice(nb.start, nb.end)).length > 0;
        if (!nc.length && !hasUrl && !figureIn(nb)) continue;
        return !figureIn(nb) && !unresolved(nb.start, nb.end) && distinct(nc).length === 1 ? nc : [];
      }
    }
    return [];
  };
  const distinct = (all) => {
    const sources = [];
    for (const x of all) if (!sources.some((y) => urlRelated(x.c.source_url, y.c.source_url) && (normUrl(x.c.source_url) || x.title === y.title))) sources.push(x);
    return sources;
  };
  const perBlock = blocks.map((b) => {
    const all = citedIn(b.start, b.end);
    const single = distinct(all).length === 1;
    return { sentences: sentencesOf(p.slice(b.start, b.end), b.start).map((sn) => ({ ...sn, cited: null })), all, single: single && !unresolved(b.start, b.end), closed: single && unresolved(b.start, b.end) && unresolvedKind(b.start, b.end) === NOT_OPENED };
  });
  // The state of one figure of the prose: found as written / not found as written / source not opened / no source to check.
  const stateOf = (t) => {
    const bi = blocks.findIndex((b) => t.index >= b.start && t.index < b.end);
    if (bi < 0) return { status: NO_SOURCE };
    const pb = perBlock[bi];
    const sn = pb.sentences.find((x) => t.index >= x.start && t.index < x.end);
    let use = [];
    if (sn) {
      if (!sn.cited) sn.cited = citedIn(sn.start, sn.end);
      const cls = clausesOf(p, sn.start, sn.end);
      const cl = cls.find((x) => t.index >= x.start && t.index < x.end);
      const clauseLevel = cls.length > 1 && cl && (distinct(sn.cited).length > 1 || unresolved(sn.start, sn.end));
      if (!clauseLevel) {
        // one clause (or one resolved source): every explicit citation in the sentence must resolve
        if (unresolved(sn.start, sn.end)) return { status: unresolvedKind(sn.start, sn.end) };
        if (distinct(sn.cited).length > 1) return { status: NO_SOURCE };
        use = sn.cited;
      } else {
        // a sentence with several sources: the figure belongs to the citation in its own clause; none or several there: no source to check
        if (unresolved(cl.start, cl.end)) return { status: unresolvedKind(cl.start, cl.end) };
        use = citedIn(cl.start, cl.end);
        if (!use.length) use = inherited(cls, cl);
        if (distinct(use).length !== 1) return { status: NO_SOURCE };
      }
    }
    if (!use.length && pb.single) use = pb.all;
    if (!use.length) return { status: pb.closed ? NOT_OPENED : NO_SOURCE };
    const fig = figOf(t);
    const open = use.filter((x) => x.text);
    const through = open.find((x) => checkValue(fig, x.text, x.kws) === FOUND);
    // its meaning is its own comparison (see proseEntries), never the meaning of a claim figure it resembles
    if (through) return { status: FOUND, meaning: 'not checked', through };
    return open.length ? { status: NOT_FOUND, source: open[0].c.source_url } : { status: NOT_OPENED };
  };
  return toks.map(stateOf);
}

// The result of checkReport once every figure of the text has its state: the marks in the text, the totals, the annotated claims.
function reportResult(p, toks, states, res, annotated) {
  const byToken = new Map(toks.map((t, i) => [t, states[i]]));
  const count = (st) => states.filter((x) => x.status === st).length;
  const differs = (t) => byToken.get(t).status === FOUND && byToken.get(t).meaning === 'differs';
  const m = insertMarks(p, toks.filter((t) => byToken.get(t).status !== FOUND || differs(t)), (t) => (differs(t) ? DIFFERS : byToken.get(t).status));
  // the prose figures not found as written, with the source each was checked against (for the document)
  const missed = toks.map((t, i) => ({ figure: t.text, source_url: states[i].source, status: states[i].status })).filter((x) => x.status === NOT_FOUND).map(({ figure, source_url }) => ({ figure, source_url })).slice(0, 200);
  const totals = { ...res.totals, proseFigures: toks.length, proseFound: count(FOUND), proseNotFound: count(NOT_FOUND), proseNotOpened: count(NOT_OPENED), proseNoSource: count(NO_SOURCE), proseMatches: states.filter((x) => x.status === FOUND && x.meaning === 'matches').length, proseDiffers: states.filter((x) => x.status === FOUND && x.meaning === 'differs').length, proseMissed: missed };
  return { prose: m.prose, claims: annotated, totals, notChecked: false, marks: m.marks };
}

// Mark every checkable figure in a text "no source to check" (for sections added after the check, and when the check could not run).
function markUnverified(text) {
  return checkReport({ prose: text, claims: [] }).prose;
}

// A fingerprint of a claim: its text, its source, its figures, its measured result (without any check mark), who judged it,
// whether it is an inference, and its evidence strength. The id and every check annotation are not part of it.
function claimKey(claim) {
  const c = claim && typeof claim === 'object' ? claim : {};
  const norm = (x) => String(x == null ? '' : x).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const url = normUrl(c.source_url) || norm(c.source_url);
  // each figure with its written form and qualifier, so a revision that changes only how a figure is written changes the key
  const figs = (Array.isArray(c.figures) ? c.figures : []).map((f) => { const q = parseFigure(f); return [q.value, q.unit || '', q.form || '', q.qual || ''].join(' '); }).sort();
  const mr = norm(String(c.measured_result == null ? '' : c.measured_result).replace(/\s*\[(?:unverified|not found in source|source not opened|no source to check|not checked|source says otherwise)[^\]]*\]/gi, ''));
  const inference = c.inference === true || c.inference === 'true';
  return require('crypto').createHash('sha256').update([norm(c.claim), url, figs.join(','), mr, norm(c.judged_by), inference ? 'inference' : 'stated', norm(c.evidence_strength)].join('|')).digest('hex');
}

function applyCheck(claims, result) {
  const byId = new Map(((result && result.claims) || []).map((r) => [r.id, r]));
  return (Array.isArray(claims) ? claims : []).map((c) => {
    const r = byId.get(c.id);
    const out = { ...c, figures: Array.isArray(c.figures) ? [...c.figures] : [] };
    if (!r) { out.check = 'not checked'; out.check_status = 'not_checked'; return out; }
    out.check_status = r.status;
    if (r.status === NOT_OPENED) {
      out.check = r.reason === 'unreadable' ? UNREADABLE_CHECK : r.too_large ? 'source too large to check' : 'source not opened';
      if (r.reason === 'unreadable') out.check_reason = 'unreadable';
      return out;
    }
    if (r.status === NO_SOURCE) { out.check = 'no source to check'; return out; }
    if (r.status === 'no_figures') { out.check = 'no figures'; return out; }
    const total = r.figures.length;
    const found = r.figures.filter((f) => f.status === FOUND);
    const bad = r.figures.filter((f) => f.status !== FOUND);
    out.check = `${found.length} of ${total} found as written`;
    // the second mark per figure: "matches", "differs" (with the reviewer's quote) or "not checked" (never "matches" by default)
    out.figure_checks = r.figures.map((f) => {
      const e = { figure: f.figure, status: f.status, meaning: f.status === FOUND && (f.meaning === 'matches' || f.meaning === 'differs') ? f.meaning : 'not checked', meaning_quote: f.status === FOUND && (f.meaning === 'matches' || f.meaning === 'differs') ? String(f.meaning_quote || '') : '' };
      if (f.parsed) Object.defineProperty(e, 'parsed', { value: f.parsed, enumerable: false, writable: true, configurable: true });
      return e;
    });
    const differing = r.figures.filter((f) => f.status === FOUND && f.meaning === 'differs');
    if ((bad.length || differing.length) && out.measured_result) {
      let mr = out.measured_result;
      const toks = groupRuns(mr, numbersIn(mr));
      const inserts = [];
      for (const [f, mark] of [...bad.map((x) => [x, MARK_NOT_FOUND]), ...differing.map((x) => [x, MARK_DIFFERS])]) {
        // the figure in the measured result: the same number and unit; the one written exactly as the figure is preferred
        const v = parseFigure(f.figure);
        const free = toks.filter((x) => x.mag === v.value && x.unit === v.unit && !inserts.some((i) => i.t === x) && !ANY_MARK_RE.test(mr.slice(x.end, x.end + 24)));
        const t = free.find((x) => x.text === f.figure) || free[0];
        if (t) inserts.push({ t, mark });
      }
      for (const { t, mark } of inserts.sort((a, b) => b.t.end - a.t.end)) mr = mr.slice(0, t.end) + ' ' + mark + mr.slice(t.end);
      out.measured_result = mr;
    }
    return out;
  });
}

// ---------------------------------------------------------------- challenge (reviewer)

function excerptAround(text, a, b, width) {
  const mid = Math.floor((a + b) / 2);
  const start = Math.max(0, mid - Math.floor(width / 2));
  const end = Math.min(text.length, start + width);
  return { start, end, text: text.slice(Math.max(0, end - width), end).replace(/\s+/g, ' ').trim() };
}

function challengeExcerpts(claims, fetched) {
  const out = [];
  for (const c of Array.isArray(claims) ? claims : []) {
    const src = findFetched(c.source_url, fetched);
    if (!src || !src.ok || !src.text) { out.push({ id: c.id, excerpts: ['source not opened'] }); continue; }
    const ct = checkableText(src.text);
    if (ct.kind === 'unreadable') { out.push({ id: c.id, excerpts: [UNREADABLE_CHECK] }); continue; } // no passage of a text the check cannot read
    const index = buildIndex(src.text);
    if (!index) { out.push({ id: c.id, excerpts: ['source too large to check'] }); continue; }
    const text = ct.text; // the checkable text: the passages are cut from the same text the index was built on
    const wins = [];
    const add = (a, b, width) => {
      const w = excerptAround(text, a, b, width);
      if (wins.some((x) => Math.abs(x.start - w.start) < width / 2)) return false;
      wins.push(w);
      return true;
    };
    // occurrences by magnitude + unit (300k finds 300,000); a bare figure the source prints with a unit still shows that passage
    const seenFig = new Set();
    const hitLists = [];
    for (const f of c.figures || []) {
      const pf = parseFigure(f);
      const q = pf.parts ? pf.parts[0] : pf;
      const k = q.value + '|' + q.unit;
      if (!q.value || seenFig.has(k)) continue;
      seenFig.add(k);
      // a compound figure's parts are not indexed on their own: the compound itself is, under its own key
      const all = [...(pf.parts ? index.get(pf.value) || [] : []), ...(index.get(q.value) || [])];
      const exact = all.filter((h) => h.unit === (q.unit || ''));
      const l = exact.length ? exact : all;
      if (l.length) hitLists.push(l);
    }
    for (let round = 0; wins.length < 3 && round < 3; round++) {
      for (const l of hitLists) { if (wins.length >= 3) break; if (l[round]) add(l[round].index, l[round].end, 600); }
    }
    if (!wins.length) {
      const kws = keywordsFrom(c.claim);
      const lower = text.toLowerCase();
      let best = null;
      for (const k of kws) {
        let pos = lower.indexOf(k);
        let guard = 0;
        while (pos >= 0 && guard++ < 400) {
          const win = lower.slice(Math.max(0, pos - 750), pos + 750);
          const score = kws.filter((q) => win.includes(q)).length;
          if (!best || score > best.score) best = { score, pos };
          pos = lower.indexOf(k, pos + k.length);
        }
      }
      if (best) add(best.pos, best.pos + 1, 1500);
    }
    out.push({ id: c.id, excerpts: wins.length ? wins.map((w) => w.text) : ['no matching passage found in the source'] });
  }
  return out;
}

const CHALLENGE_MAX_CLAIMS = 60;
const CHALLENGE_MAX_EXCERPT_CHARS = 60000;

// ---- the second mark: does the passage around a figure mean the same?
const FIGURE_SIDE = 300;          // characters of the source each side of the matched occurrence
const FIGURES_PER_CLAIM = 8;
const FIGURES_PER_ROUND = 120;
const PROSE_FIGURES_PER_ROUND = 60;  // figures of the report text compared per round
const MIN_QUOTE = 8;
const collapse = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// the visible text of the last few sources (the same few that are indexed): cutting excerpts for several claims reads a source repeatedly
const visCache = new Map();
function visibleMemo(text, deadline) {
  const src = String(text == null ? '' : text);
  if (visCache.has(src)) {
    const hit = visCache.get(src);
    visCache.delete(src);
    visCache.set(src, hit);
    return hit;
  }
  // the visible text of the checkable text (see checkableText): the same derived text for the index, the keyword windows and the excerpts
  const c = checkableText(src, deadline);
  if (c.kind === 'too_large' || c.kind === 'unreadable') return '';
  const v = visibleText(c.text, deadline);
  visCache.set(src, v);
  if (visCache.size > IDX_KEEP) visCache.delete(visCache.keys().next().value);
  return v;
}

// 300 characters each side of [a, b) in the visible text, cut at word boundaries (a word cut by the edge is left out), white space
// collapsed. Returns { text, start, end }: the passage and where [a, b) sits in it (offsets in the collapsed text).
function wordCut(clean, a, b) {
  let s = Math.max(0, a - FIGURE_SIDE);
  let e = Math.min(clean.length, b + FIGURE_SIDE);
  if (s > 0 && !/\s/.test(clean[s - 1]) && !/\s/.test(clean[s])) {
    let k = s;
    while (k < a && !/\s/.test(clean[k])) k++;
    s = k;
  }
  if (e < clean.length && !/\s/.test(clean[e - 1]) && !/\s/.test(clean[e])) {
    let k = e;
    while (k > b && !/\s/.test(clean[k - 1])) k--;
    e = k;
  }
  // collapse white space (as collapse() does), keeping track of where the characters at a and b-1 land
  let text = '';
  let gap = false;
  let start = -1;
  let end = 0;
  for (let i = s; i < e; i++) {
    if (/\s/.test(clean[i])) { gap = text.length > 0; continue; }
    if (gap) { text += ' '; gap = false; }
    if (start < 0 && i >= a) start = text.length;
    text += clean[i];
    if (i < b) end = text.length;
  }
  return { text, start: Math.max(0, start), end: Math.max(Math.max(0, start), end) };
}

// The occurrence of a found figure that matched: the first written the same way; for a common number, the first near a keyword of the
// claim (as the check itself requires). figure: a figure (see figOf). kws: lower-case keywords.
function matchedHit(figure, index, sourceText, kws) {
  if (!index) return undefined; // a source too large or too slow to index: nothing is presented for it
  const hits = (index.get(figure.value) || []).filter((h) => sameAsWritten(figure, h));
  if (hits.length && isCommon(figure.parts ? figure.parts[0].value : figure.value)) {
    const visible = visibleMemo(sourceText); // the keyword window reads the visible text, as checkValue does
    return hits.find((h) => { const win = visible.slice(Math.max(0, h.index - 300), h.end + 300).toLowerCase(); return kws.some((k) => win.includes(k)); });
  }
  return hits[0];
}

// The passage around a matched occurrence, the digits as the passage writes them, and where the figure (sign, currency, number, unit) sits in the passage.
function cutAroundHit(sourceText, hit) {
  // (a sign wrapped in markup, "**−** 1250", starts the span at the sign as the text writes it)
  const cut = wordCut(visibleMemo(sourceText), Math.min(hit.from == null ? hit.index : hit.from, hit.index, hit.signAt == null ? Infinity : hit.signAt), hit.end);
  const raw = collapse(hit.raw).replace(/^[-−+]\s*/, '').replace(/\D+$/, ''); // no sign, no % or unit
  const numbers = hit.compound ? (raw.match(/\d+(?:[.,]\d+)*/g) || [raw]) : [raw];
  return { excerpt: cut.text, span: { start: cut.start, end: cut.end }, numbers };
}

const sha = (parts) => require('crypto').createHash('sha256').update(parts.join('|')).digest('hex');

// The figures of the report text that were found as written, in text order: [{ tokenIndex, figure, sentence, marked, heading, position,
// excerpt, span, numbers, meaningKey }]. Every occurrence is an entry of its own, also when the same figure stands twice in a sentence.
// sentence: the whole sentence of the report that holds the figure (at most 400 characters, white space collapsed, check marks left out);
// marked: the same sentence with this occurrence in ⟦ ⟧ (the others unmarked); heading: the nearest markdown heading line above it ('' when
// none); position: the number of figures before it in its sentence; excerpt: the passage cut around the occurrence in the source that
// matched. The key holds the sentence, the position, the heading, the figure and the passage: a revised sentence, or the same sentence
// under another heading, has a new key.
const MARKS_TEXT_RE = /\s*\[(?:not found in source|source not opened|no source to check|not checked|source says otherwise)\]/g;
const HEADING_LINE_RE = /^[ \t]{0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/;
// two private-use characters, written as escapes (U+E000, U+E001)
const OPEN_MARK = String.fromCharCode(0xE000);
const CLOSE_MARK = String.fromCharCode(0xE001);
const SETEXT_UNDERLINE_RE = /^ {0,3}(?:(=+)|-{2,})[ \t]*$/;
// the markdown headings of a text (not inside a code fence): [{ end, text, level }], end = where the line ends (a setext heading: the
// underline), level = the number of # (setext: 1 for "=", 2 for "-")
function headingsOf(p) {
  const out = [];
  let pos = 0;
  let fence = false;
  const lines = p.split('\n');
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const end = pos + line.length;
    if (/^\s*(?:```|~~~)/.test(line)) fence = !fence;
    else if (!fence) {
      const m = HEADING_LINE_RE.exec(line);
      if (m && m[1]) out.push({ end, text: collapse(m[1]), level: /#+/.exec(line)[0].length });
      else if (n + 1 < lines.length && line.trim() && !m && !isTableRow(line) && !/^\s*(?:-+|=+)\s*$/.test(line) && !/^\s*(?:```|~~~)/.test(lines[n + 1])) {
        // a setext heading: this line, underlined by a line of only "=" (level 1) or "-" (level 2, two or more; the line before it is not blank)
        const u = SETEXT_UNDERLINE_RE.exec(lines[n + 1]);
        if (u) { out.push({ end: end + 1 + lines[n + 1].length, text: collapse(line), level: u[1] ? 1 : 2 }); pos = end + 1; n++; pos += lines[n].length + 1; continue; }
      }
    }
    pos = end + 1;
  }
  return out;
}
// The governing headings of a place in the text, from the top level down: "Enrollment > Total" for "### Total" under "## Enrollment"
// ('' when there is none). A heading closes every heading of its own or a lower level before it.
function headingPathAt(headings, at) {
  const stack = [];
  for (const h of headings) {
    if (h.end > at) break;
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    stack.push(h);
  }
  return stack.map((h) => h.text).join(' > ');
}

// A markdown table row is a line that starts with "|". The cells of one row: [{ text, from, to }] (offsets in the line), without the part
// before the first "|" and the empty part after a closing "|"; "\|" is no cell border.
const isTableRow = (line) => /^\s*\|/.test(line);
function rowCells(line) {
  const parts = [];
  let prev = -1;
  for (let k = 0; k < line.length; k++) {
    if (line[k] === '\\') k++;
    else if (line[k] === '|') { parts.push({ from: prev + 1, to: k }); prev = k; }
  }
  parts.push({ from: prev + 1, to: line.length });
  parts.shift();
  if (parts.length && !line.slice(parts[parts.length - 1].from).trim()) parts.pop();
  return parts.map((c) => ({ ...c, text: collapse(line.slice(c.from, c.to)) }));
}
// The table a position in the text sits in, when it sits in a table row: { header, column } = the first row of its table (white space
// collapsed) and the header cell of the column the position is in. null when it is in no table row; { header: '', column: '' } when the
// column header cannot be resolved: the table has no header row (a first row followed by a separator line like |---|---|), or the row
// has another number of cells than the header row, or the header cell is empty.
const SEPARATOR_CELL_RE = /^:?-+:?$/;
function tableAt(p, at) {
  const lineStart = (k) => (k > 0 ? p.lastIndexOf('\n', k - 1) + 1 : 0);
  const lineEnd = (k) => { const e = p.indexOf('\n', k); return e < 0 ? p.length : e; };
  const ls = lineStart(at);
  const line = p.slice(ls, lineEnd(at));
  if (!isTableRow(line)) return null;
  let first = ls;
  while (first > 0) {
    const before = lineStart(first - 1);
    if (!isTableRow(p.slice(before, first - 1))) break;
    first = before;
  }
  const headLine = p.slice(first, lineEnd(first));
  const next = lineEnd(first) < p.length ? p.slice(lineEnd(first) + 1, lineEnd(lineEnd(first) + 1)) : '';
  const head = rowCells(headLine);
  const sep = rowCells(next);
  const none = { header: '', column: '' };
  if (!isTableRow(next) || !sep.length || !sep.every((c) => SEPARATOR_CELL_RE.test(c.text)) || head.every((c) => SEPARATOR_CELL_RE.test(c.text))) return none;
  const cells = rowCells(line);
  if (cells.length !== head.length) return none;
  const col = cells.findIndex((c) => at - ls >= c.from && at - ls <= c.to);
  if (col < 0 || !head[col].text) return none;
  return { header: collapse(headLine), column: head[col].text };
}
// The markdown block that holds a place of the report: a paragraph (its lines), a table row (the row; its header comes from tableAt), or a
// list item with all its parent items and the lead-in line of its list. contextMap(p).segsAt(offset) -> segs | null; segs are the
// pieces [{ from, to }] (absolute offsets, a list marker left out) of the block in text order. null: a heading line, a blank line, or no
// line. (A continuation line belongs to the item it continues: indented more than the item, or directly after it with no blank line.)
const LIST_ITEM_RE = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+/;
const indentWidth = (ws) => ws.replace(/\t/g, '    ').length;
function contextMap(p) {
  const lines = [];
  const ctxs = [];
  let pos = 0;
  let fence = false;
  let stack = [];
  let para = null;
  let lead = null;
  let prevBlank = true;
  const raw = p.split('\n');
  const isHeading = new Array(raw.length).fill(false);
  for (let n = 0, f = false; n < raw.length; n++) {
    const line = raw[n];
    if (/^\s*(?:```|~~~)/.test(line)) { f = !f; continue; }
    if (f) continue;
    if (HEADING_LINE_RE.test(line)) { isHeading[n] = true; continue; }
    if (n + 1 < raw.length && line.trim() && !isTableRow(line) && !SETEXT_UNDERLINE_RE.test(line) && !/^\s*(?:```|~~~)/.test(raw[n + 1]) && SETEXT_UNDERLINE_RE.test(raw[n + 1])) { isHeading[n] = true; isHeading[n + 1] = true; n++; }
  }
  for (let n = 0; n < raw.length; n++) {
    const line = raw[n];
    const s = pos;
    const e = pos + line.length;
    pos = e + 1;
    lines.push(s);
    ctxs.push(null);
    if (/^\s*(?:```|~~~)/.test(line)) fence = !fence;
    else if (!fence && !line.trim()) { prevBlank = true; para = null; continue; }
    else if (!fence && isHeading[n]) { stack = []; para = null; lead = null; prevBlank = true; continue; }
    const item = fence ? null : LIST_ITEM_RE.exec(line);
    const seg = { from: s, to: e };
    if (item) {
      const indent = indentWidth(item[1]);
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      const parent = stack.length ? stack[stack.length - 1] : null;
      const it = { indent, segs: [{ from: s + item[0].length, to: e }], parent, lead: parent ? parent.lead : lead };
      stack.push(it);
      ctxs[n] = it;
      para = null;
    } else {
      const top = stack.length ? stack[stack.length - 1] : null;
      if (top && (!prevBlank || indentWidth(/^[ \t]*/.exec(line)[0]) > top.indent)) { top.segs.push(seg); ctxs[n] = top; } // a continuation of the item
      else {
        stack = [];
        const row = !fence && isTableRow(line);
        if (row) { ctxs[n] = { segs: [seg], parent: null, lead: null }; para = null; }
        else {
          if (!para) para = { segs: [], parent: null, lead: null };
          para.segs.push(seg);
          ctxs[n] = para;
          lead = seg;
        }
      }
    }
    prevBlank = false;
  }
  const segsOf = (c) => {
    if (!c) return null;
    const chain = [];
    for (let it = c; it; it = it.parent) chain.unshift(it);
    return [...(c.lead ? [c.lead] : []), ...chain.flatMap((it) => it.segs)];
  };
  return {
    segsAt(at) {
      let lo = 0;
      let hi = lines.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lines[mid] <= at) lo = mid; else hi = mid - 1; }
      return segsOf(ctxs[lo]);
    },
  };
}
// the longest block of the report shown to the reviewer as the context of a figure (white space collapsed); a longer one is not presented
const PROSE_BLOCK_MAX = 800;
function proseEntries(prose, toks, states) {
  const p = String(prose || '');
  const ctx = contextMap(p);
  const headings = headingsOf(p);
  const out = [];
  toks.forEach((t, tokenIndex) => {
    const st = states[tokenIndex];
    if (!st || st.status !== FOUND || !st.through) return;
    const src = st.through.src;
    const fig = figOf(t);
    const hit = matchedHit(fig, buildIndex(src.text), src.text, st.through.kws.map((k) => k.toLowerCase()));
    if (!hit) return;
    // the whole markdown block that holds the figure (see contextMap); a heading line holds none: not presented
    const segs = ctx.segsAt(t.index);
    if (!segs) return;
    // the occurrence is wrapped in two marker characters first, so it can be found again in the collapsed block; one that is not wholly inside
    // a piece of the block (a list marker, a line break) is not presented
    const rs = Math.min(t.from, t.index);
    const re = Math.max(rs, t.end);
    let placed = false;
    const pieces = segs.map((g) => {
      const raw = p.slice(g.from, g.to);
      if (!placed && rs >= g.from && re <= g.to) { placed = true; return raw.slice(0, rs - g.from) + OPEN_MARK + raw.slice(rs - g.from, re - g.from) + CLOSE_MARK + raw.slice(re - g.from); }
      return raw;
    });
    if (!placed) return;
    const cleaned = collapse(pieces.join(' ').replace(MARKS_TEXT_RE, ''));
    if (!cleaned.includes(OPEN_MARK) || !cleaned.includes(CLOSE_MARK)) return;
    const sentence = cleaned.split(OPEN_MARK).join('').split(CLOSE_MARK).join('');
    // a block longer than the limit is not shown to the reviewer, whole or cut (the key would not cover what is left out): this
    // figure is not presented and its meaning stays "not checked"
    if (sentence.length > PROSE_BLOCK_MAX) return;
    const marked = cleaned.replace(OPEN_MARK, '⟦').replace(CLOSE_MARK, '⟧').split(OPEN_MARK).join('').split(CLOSE_MARK).join('');
    let position = 0;
    for (const x of toks) { if (x === t) break; if (segs.some((g) => x.index >= g.from && x.index < g.to)) position++; }
    const heading = headingPathAt(headings, t.index); // every governing heading, from the top level down
    // a figure in a table row is presented with the header cell of its column; when that cannot be resolved it is not presented (not checked)
    const table = tableAt(p, t.index);
    if (table && !table.column) return;
    const { excerpt, span, numbers } = cutAroundHit(src.text, hit);
    const keyParts = [heading, sentence, position, fig.value, fig.unit || '', fig.form || '', fig.qual || '', excerpt];
    if (table) keyParts.push(table.header, table.column);
    out.push({ tokenIndex, figure: t.text, sentence, marked, heading, ...(table ? { column: table.column } : {}), position, excerpt, span, numbers, meaningKey: sha(['prose', JSON.stringify(keyParts)]) });
  });
  return out;
}

// For every claim figure found as written: one excerpt of the fetched source around the occurrence that matched (the first occurrence
// written the same way; for a common number, the first near a keyword of the claim, as the check itself requires). Figures that were
// not found, whose source was not opened, was too large or is missing get none (their meaning is "not checked"). At most 8 figures per
// claim, 120 per round, and only the claims the reviewer is shown (the first 60).
// checkResult: what checkClaims returned for these claims; without it the annotated claims' figure_checks are used.
// report: the report text (a string, or { prose, counts }): then every figure of it that was found as written (cited source, same rules
// as checkReport) gets an entry of its own after the claim ones, fid "p<n>", id "report", at most 60, in text order. Its "sentence" is
// the sentence of the report that holds it. Every occurrence has its own entry and fid, also two of the same figure in one sentence.
// Returns [{ fid, id, n, figure, numbers, span, excerpt, meaningKey, claimIndex, figIndex }] (a report entry has `sentence`, `marked`
// (the sentence with this occurrence in ⟦ ⟧), `heading` and `prose: true` instead of claimIndex and figIndex). span: where the matched occurrence (sign, number, unit) sits in the collapsed excerpt.
function figureExcerpts(claims, fetched, checkResult, report) {
  const out = claimFigureExcerpts(claims, fetched, checkResult);
  if (report === undefined || report === null) return out;
  const prose = typeof report === 'string' ? report : String(report.prose || '');
  const counts = report && typeof report === 'object' && report.counts && typeof report.counts === 'object' ? report.counts : {};
  const all = Array.isArray(claims) ? claims : [];
  const toks = figuresInProse(prose, counts);
  const seen = new Set();
  const rid = reportIdFor(all.map((c) => c.id));
  for (const e of proseEntries(prose, toks, proseStates(prose, all, fetched, counts, toks))) {
    if (seen.has(e.meaningKey)) continue;
    seen.add(e.meaningKey);
    if (seen.size > PROSE_FIGURES_PER_ROUND) break;
    out.push({ fid: `p${seen.size}`, id: rid, n: seen.size, figure: e.figure, sentence: e.sentence, marked: e.marked, heading: e.heading, ...(e.column ? { column: e.column } : {}), numbers: e.numbers, span: e.span, excerpt: e.excerpt, meaningKey: e.meaningKey, prose: true });
  }
  return out;
}

function claimFigureExcerpts(claims, fetched, checkResult) {
  const list = (Array.isArray(claims) ? claims : []).slice(0, CHALLENGE_MAX_CLAIMS);
  const byId = new Map(((checkResult && checkResult.claims) || []).map((r) => [String(r.id), r]));
  const out = [];
  for (let ci = 0; ci < list.length && out.length < FIGURES_PER_ROUND; ci++) {
    const c = list[ci];
    const r = checkResult ? byId.get(String(c.id)) : null;
    const entries = r ? r.figures : (Array.isArray(c.figure_checks) ? c.figure_checks : []);
    if (!entries.length || !entries.some((e) => savedStatus(e.status) === FOUND)) continue;
    const { src, state } = sourceState(c.source_url, fetched);
    if (state !== 'opened') continue;
    const index = buildIndex(src.text);
    if (!index) continue; // too large or too slow to index now: not presented, not checked
    const kws = keywordsFrom(c.claim).map((k) => k.toLowerCase());
    const ck = claimKey(c);
    let used = 0;
    for (let j = 0; j < entries.length && used < FIGURES_PER_CLAIM && out.length < FIGURES_PER_ROUND; j++) {
      const e = entries[j];
      if (savedStatus(e.status) !== FOUND) continue;
      const p = e.parsed || parseFigure(e.figure);
      const hit = matchedHit(p, index, src.text, kws);
      if (!hit) continue;
      const { excerpt, span, numbers } = cutAroundHit(src.text, hit);
      const meaningKey = sha([ck, p.value, p.unit || '', p.form || '', p.qual || '', excerpt]);
      out.push({ fid: `${c.id}.f${j + 1}`, id: String(c.id), n: j + 1, figure: String(e.figure), numbers, span, excerpt, meaningKey, claimIndex: ci, figIndex: j });
      used++;
    }
  }
  return out;
}

// A stored meaning counts only in its exact shape.
function meaningOf(keys, key) {
  const m = keys && Object.prototype.hasOwnProperty.call(keys, key) ? keys[key] : null;
  return m && (m.meaning === 'matches' || m.meaning === 'differs') && typeof m.quote === 'string' ? m : null;
}

// Does the quote q sit in the figure's excerpt at a place that holds the whole matched occurrence?
function coversSpan(f, q) {
  if (!f.span) return false; // an entry without a span never matches (code cannot be sure where the figure stands)
  for (let at = f.excerpt.indexOf(q); at >= 0; at = f.excerpt.indexOf(q, at + 1)) {
    if (at <= f.span.start && at + q.length >= f.span.end) return true;
  }
  return false;
}

// Add answers to a stored set of meanings (by key): a "differs" is never replaced by a "matches", only by another "differs".
function mergeMeanings(into, add) {
  for (const [key, m] of Object.entries(add || {})) {
    const old = Object.prototype.hasOwnProperty.call(into, key) ? into[key] : null;
    if (old && old.meaning === 'differs' && m.meaning !== 'differs') continue;
    into[key] = m;
  }
  return into;
}

// The reviewer's per-figure answers (parseChallenge(...).results[].figures), checked by code against the excerpts that were shown.
// A figure counts only when its fid was presented for that claim, the meaning is exactly "matches" or "differs", the quote (white
// space collapsed) is at least 8 characters and is in that figure's excerpt, and, for "matches", the quote covers the occurrence that
// matched: it is in the excerpt at a place that holds the whole figure as written (sign, number, unit; see span), so a quote that
// has the same digits elsewhere ("Screening found 12500 candidates") does not count. The figures of the report text (parsed.report,
// the reply's entry {"id": "report", ...}) are validated the same way. Everything else is left out: that figure stays "not checked".
// A "differs" answer is never overwritten by a "matches" for the same key (a newer "differs" replaces it).
// Returns { keys: { [meaningKey]: { meaning, quote } }, differs: [{ id, fid, figure, quote }] }.
function figureMeanings(figs, parsed) {
  const byFid = new Map((Array.isArray(figs) ? figs : []).map((f) => [f.fid, f]));
  const keys = {};
  const differsByKey = new Map();
  const answers = [...((parsed && Array.isArray(parsed.results)) ? parsed.results : []), ...(parsed && parsed.report ? [parsed.report] : [])];
  for (const r of answers) {
    for (const it of Array.isArray(r.figures) ? r.figures : []) {
      const f = byFid.get(it.fid);
      if (!f || String(f.id) !== String(r.id)) continue;
      if (it.meaning !== 'matches' && it.meaning !== 'differs') continue;
      const q = collapse(it.quote);
      if (q.length < MIN_QUOTE || !f.excerpt.includes(q)) continue;
      if (it.meaning === 'matches' && !coversSpan(f, q)) continue;
      mergeMeanings(keys, { [f.meaningKey]: { meaning: it.meaning, quote: q } });
      if (it.meaning === 'differs') differsByKey.set(f.meaningKey, { id: f.id, fid: f.fid, figure: f.figure, quote: q }); // the newest "differs" per key
    }
  }
  return { keys, differs: [...differsByKey.values()] };
}

function cutEvenly(text, cap) {
  return text.length <= cap ? text : text.slice(0, Math.max(0, cap - 1)).trimEnd() + '…';
}

// figs: figureExcerpts(...) for these claims (the figure passages the hub cut); optional.
function challengeBrief(question, claims, excerpts, figs) {
  const all = Array.isArray(claims) ? claims : [];
  const used = all.slice(0, CHALLENGE_MAX_CLAIMS);
  const figList = Array.isArray(figs) ? figs : [];
  const figsOf = (c) => figList.filter((f) => !f.prose && String(f.id) === String(c.id));
  const proseFigs = figList.filter((f) => f.prose);
  const rid = reportIdFor(all.map((c) => c.id));
  const left = all.length - used.length;
  const ex = new Map((Array.isArray(excerpts) ? excerpts : []).map((e) => [e.id, e.excerpts || []]));
  const totalOf = (c) => (ex.get(c.id) || []).reduce((n, t) => n + String(t).length, 0);
  // water-fill: every claim keeps what it needs up to a common cap, so the total stays within the limit
  let cap = Infinity;
  const sizes = used.map(totalOf).sort((x, y) => x - y);
  if (sizes.reduce((n, x) => n + x, 0) > CHALLENGE_MAX_EXCERPT_CHARS) {
    let remaining = CHALLENGE_MAX_EXCERPT_CHARS;
    for (let i = 0; i < sizes.length; i++) {
      const share = remaining / (sizes.length - i);
      if (sizes[i] <= share) remaining -= sizes[i]; else { cap = Math.floor(share); break; }
    }
  }
  const cut = Number.isFinite(cap);
  const blocks = used.map((c) => {
    let e = ex.get(c.id) || [];
    if (cut && totalOf(c) > cap) { const each = Math.max(1, Math.floor(cap / e.length)); e = e.map((t) => cutEvenly(String(t), each)); }
    return [
      `Claim ${c.id}: ${c.claim}`,
      `Source: ${c.source_url || '(none)'}`,
      `Figures given: ${(c.figures || []).join(', ') || 'none'}; measured result: ${c.measured_result || 'not given'}; judged by: ${c.judged_by || 'not stated'}`,
      'Excerpts from the source:',
      ...(e.length ? e.map((t, i) => `  [${i + 1}] ${t}`) : ['  (none)']),
      ...(figsOf(c).length ? ['Figures to compare (each with the passage the hub cut from the source around it):', ...figsOf(c).map((f) => `  [${f.fid}] the report writes: ${f.figure} | passage: "${f.excerpt}"`)] : []),
    ].join('\n');
  }).join('\n\n---\n\n');
  const proseBlock = proseFigs.length ? [
    'Figures in the report text to compare (each with the heading it stands under, the sentence of the report that holds it with the occurrence to compare marked ⟦ ⟧, and the passage the hub cut from the source around it):',
    ...proseFigs.map((f) => `  [${f.fid}] under the heading: ${f.heading ? `"${f.heading}"` : '(none)'}${f.column ? ` | under the column: "${f.column}"` : ''} | the report writes: "${f.marked || f.sentence}" | the figure: ${f.figure} | passage: "${f.excerpt}"`),
  ].join('\n') : '';
  const notes = [];
  if (left > 0) notes.push(`${left} further ${left === 1 ? 'claim was' : 'claims were'} left out of this review (the limit is ${CHALLENGE_MAX_CLAIMS} claims); give no verdict for them.`);
  if (cut) notes.push('Long excerpts were shortened to fit.');
  return [
    'You are an independent reviewer. A research report makes the claims below. For each claim, decide whether its source supports it. Use the excerpts; where they are not enough you may open the source yourself with WebFetch. Read only; download and run nothing. Be strict: a claim is "supported" only when the source says it, with those numbers, about that thing.',
    '',
    `Research question: ${String(question || '').trim()}`,
    '',
    'Verdicts:',
    '- supported: the source states this, with these figures.',
    '- partly: the source supports part of it, or with different scope, version or wording.',
    '- not_supported: the source does not say this, or says something different.',
    '- cannot_check: you could not see the relevant part of the source.',
    '',
    ...(figList.length ? [
      `Figures: under a claim you may find "Figures to compare"${proseFigs.length ? ', and after the claims "Figures in the report text to compare"' : ''}. For each figure id (like c1.f1${proseFigs.length ? ' or p1' : ''}), compare what the report says the figure is (what it measures, the direction, the period, the qualifiers, the units, the table heading) with the passage, using only the passage. Answer "matches" or "differs". For "matches", quote the words of the passage that state the figure; the quote must include the figure\'s number as the passage writes it, with its sign and unit, at the place where the passage states the figure. For "differs", quote the words of the passage that say something different. Quotes must be copied exactly from the passage. Leave a figure out when you cannot tell.${proseFigs.length ? ' A figure in the report text is the one marked ⟦ ⟧ in its sentence: when the same figure stands twice in a sentence, each has its own id and its own answer; take the heading into account.' : ''}`,
      ...(proseFigs.length ? [`Put the answers for the figures in the report text (p1, p2 ...) in one more object, {"id": "${rid}", "figures": [...]}; it has no verdict.`] : []),
      '',
    ] : []),
    'Reply with ONLY a fenced json array, nothing before or after it, one object per claim id, with a one-line reason:',
    '```json',
    figList.length
      ? `[{"id": "c1", "verdict": "supported", "reason": "...", "figures": [{"fid": "c1.f1", "meaning": "matches", "quote": "..."}]}${proseFigs.length ? `, {"id": "${rid}", "figures": [{"fid": "p1", "meaning": "matches", "quote": "..."}]}` : ''}]`
      : '[{"id": "c1", "verdict": "supported", "reason": "..."}]',
    '```',
    '',
    ...(notes.length ? [notes.join(' '), ''] : []),
    'Claims:',
    '',
    blocks,
    ...(proseBlock ? ['', '---', '', proseBlock] : []),
  ].join('\n');
}

const VERDICTS = ['supported', 'partly', 'not_supported', 'cannot_check'];
// The id of the reply's entry for the figures of the report text (and of their figure excerpts): "report", unless a claim has that id;
// then "report-text", "report-text-2" and so on (the first that no claim uses).
function reportIdFor(ids) {
  const used = new Set((Array.isArray(ids) ? ids : []).map((x) => String(x == null ? '' : x).trim()));
  if (!used.has('report')) return 'report';
  if (!used.has('report-text')) return 'report-text';
  for (let n = 2; ; n++) if (!used.has(`report-text-${n}`)) return `report-text-${n}`;
}

// figs: the figure excerpts presented in this round (figureExcerpts). Each result gets figures: [{ fid, meaning, quote }] for the fids
// that were presented for that claim; every other figure answer is dropped. The entry {"id": "report", "figures": [...]} (accepted
// only for the figures of the report text) is returned as `report: { id, figures }`: it is no result and has no verdict. Whether an answer counts is figureMeanings' decision.
function parseChallenge(text, ids, figs) {
  const presented = new Map((Array.isArray(figs) ? figs : []).map((f) => [String(f.fid), String(f.id)]));
  const want = Array.isArray(ids) ? ids.map(String) : [];
  const wantSet = new Set(want);
  const REPORT_ID = reportIdFor(want);
  const blocks = fencedBlocks(text);
  const pick = blocks.find((b) => b.lang === 'json') || blocks[0];
  let arr = null;
  let error = '';
  if (pick) { const r = parseJsonLoose(pick.body); if (Array.isArray(r.value)) arr = r.value; else error = r.error || 'not a JSON array'; }
  if (!arr) { arr = bareJsonArray(text); if (!arr && !error) error = 'no json block found'; }
  const byId = new Map();
  const unknown = [];
  const report = [];
  for (const it of arr || []) {
    if (!it || typeof it !== 'object') continue;
    const id = String(it.id == null ? '' : it.id).trim();
    if (id === REPORT_ID) { // the figures of the report text: answers only, no verdict, never a decisive verdict
      for (const g of Array.isArray(it.figures) ? it.figures : []) {
        if (!g || typeof g !== 'object') continue;
        const fid = String(g.fid == null ? '' : g.fid).trim();
        if (presented.get(fid) !== id || report.some((x) => x.fid === fid)) continue;
        report.push({ fid, meaning: typeof g.meaning === 'string' ? g.meaning.trim().toLowerCase() : '', quote: typeof g.quote === 'string' ? g.quote : '' });
      }
      continue;
    }
    if (!wantSet.has(id)) { if (id) unknown.push(id); continue; }
    if (byId.has(id)) continue;
    const v = String(it.verdict || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    const figures = [];
    for (const g of Array.isArray(it.figures) ? it.figures : []) {
      if (!g || typeof g !== 'object') continue;
      const fid = String(g.fid == null ? '' : g.fid).trim();
      if (presented.get(fid) !== id || figures.some((x) => x.fid === fid)) continue;
      // the verdict word in any case or spacing ("Matches"); the quote, checked against the passage, is what makes it count
      figures.push({ fid, meaning: typeof g.meaning === 'string' ? g.meaning.trim().toLowerCase() : '', quote: typeof g.quote === 'string' ? g.quote : '' });
    }
    byId.set(id, { id, verdict: VERDICTS.includes(v) ? v : 'cannot_check', reason: typeof it.reason === 'string' ? it.reason.trim() : '', figures });
  }
  const missing = [];
  const results = want.map((id) => {
    if (byId.has(id)) return byId.get(id);
    missing.push(id);
    return { id, verdict: 'cannot_check', reason: 'the reviewer gave no verdict for this claim', figures: [] };
  });
  const counts = { supported: 0, partly: 0, not_supported: 0, cannot_check: 0 };
  for (const r of results) counts[r.verdict]++;
  return { results, unknown, missing, counts, report: { id: REPORT_ID, figures: report }, error: arr ? '' : error };
}

// What a review round came to: decisive verdict count, the claims it could not check, the claims it doubted.
function challengeSummary(parsed) {
  const results = (parsed && Array.isArray(parsed.results)) ? parsed.results : [];
  const counts = { supported: 0, partly: 0, not_supported: 0, cannot_check: 0 };
  for (const r of results) if (r && counts[r.verdict] !== undefined) counts[r.verdict]++;
  return {
    decisive: counts.supported + counts.partly + counts.not_supported,
    counts,
    uncheckedIds: results.filter((r) => r && r.verdict === 'cannot_check').map((r) => r.id),
    doubtedIds: results.filter((r) => r && (r.verdict === 'partly' || r.verdict === 'not_supported')).map((r) => r.id),
  };
}

// differs: [{ id, figure, quote }] from figureMeanings: figures whose passage in the source says something different from the report.
function reviseBrief(question, prose, claims, challenge, differs) {
  const list = Array.isArray(challenge) ? challenge : (challenge && challenge.results) || [];
  const diff = (Array.isArray(differs) ? differs : []).filter((d) => d && d.figure && d.quote);
  const byId = new Map(list.map((r) => [r.id, r]));
  const lines = (Array.isArray(claims) ? claims : []).map((c) => {
    const r = byId.get(c.id) || { verdict: 'cannot_check', reason: '' };
    return `- ${c.id} [${r.verdict}] ${c.claim}${r.reason ? ' | reviewer: ' + r.reason : ''}`;
  }).join('\n');
  return [
    'An independent reviewer checked the claims in the report below against their sources. Revise the report to fit the review.',
    '',
    `Question: ${String(question || '').trim()}`,
    '',
    'Rules:',
    '- Drop, or correct, every claim marked not_supported. Remove the sentences and figures that rested on it.',
    '- Qualify every claim marked partly: say exactly what the source does support.',
    '- Keep supported claims. Claims marked cannot_check stay, but say they could not be confirmed.',
    ...(diff.length ? ['- For every figure listed under "Figures whose passage says something different", correct what the report says about it so it matches the quoted passage, or drop it.'] : []),
    '- Do not add new figures. Every figure in the prose must still be in a claim\'s figures with its source.',
    '- Keep the same output format: the markdown sections (## Verdict, ## Evidence, ## Where sources disagree, ## Confidence, ## Corrections to the first pass) and then the fenced ```claims block with the revised claims (same fields; keep ids of surviving claims).',
    '- List in "Corrections to the first pass" everything this review changed (dropped, corrected or qualified claims), besides what was listed already.',
    '- Do not mention reviewers, models or how the report was produced anywhere else in the report.',
    '',
    'Review results:',
    lines || '- none',
    '',
    ...(diff.length ? ['Figures whose passage says something different (the reviewer compared the figure with the passage around it in the source):', ...diff.map((d) => `- ${d.id}: "${d.figure}" | the source's passage says: "${d.quote}"`), ''] : []),
    'Current report:',
    '"""',
    String(prose || ''),
    '"""',
    '',
    'Current claims:',
    '```claims',
    JSON.stringify(Array.isArray(claims) ? claims.map(({ check, check_status, figure_checks, meaning, meaning_quote, ...rest }) => rest) : [], null, 1),
    '```',
  ].join('\n');
}

// ---------------------------------------------------------------- document output

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function inlineHtml(raw) {
  let s = String(raw == null ? '' : raw).replace(/\u0000/g, '');
  const stash = [];
  const put = (o) => { stash.push(o); return '\u0000' + (stash.length - 1) + '\u0000'; };
  s = s.replace(/`([^`\n]+)`/g, (m, c) => put({ html: '<code>' + esc(c) + '</code>' }));
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, t, u) => put({ href: u, text: t }));
  s = s.replace(/https?:\/\/[^\s<>"'`\])\u0000]+/g, (m) => {
    const u = m.replace(/[.,;:!?]+$/, '');
    return put({ href: u, text: u }) + m.slice(u.length);
  });
  const emph = (t) => esc(t)
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s](?:[^*\n]*?[^*\s])?)\*(?![*\w])/g, '$1<em>$2</em>');
  const restore = (t) => t.replace(/\u0000(\d+)\u0000/g, (m, i) => {
    const o = stash[+i];
    if (!o) return '';
    if (o.html) return o.html;
    return `<a href="${esc(o.href)}">${restore(emph(o.text))}</a>`;
  });
  return restore(emph(s));
}

function splitRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

const SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function mdToHtml(md) {
  const lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const isBlockStart = (l) => /^\s*#{1,6}\s/.test(l) || /^\s*```/.test(l) || /^\s*[-*+]\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l) || /^\s*\|/.test(l) || /^\s*(?:-{3,}|\*{3,})\s*$/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if (/^\s*```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
    } else if ((m = line.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/))) {
      out.push(`<h${m[1].length}>${inlineHtml(m[2])}</h${m[1].length}>`);
      i++;
    } else if (/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) {
      out.push('<hr>');
      i++;
    } else if (/^\s*\|/.test(line) && i + 1 < lines.length && SEP_RE.test(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(splitRow(lines[i++]));
      out.push('<table><thead><tr>' + head.map((c) => `<th>${inlineHtml(c)}</th>`).join('') + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + head.map((_, k) => `<td>${inlineHtml(r[k] || '')}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
    } else if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const re = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
      const items = [];
      while (i < lines.length && lines[i].trim()) {
        const mm = lines[i].match(re);
        if (mm) items.push(mm[1]);
        else if (isBlockStart(lines[i]) && !/^\s{2,}/.test(lines[i])) break;
        else if (items.length) items[items.length - 1] += ' ' + lines[i].trim();
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>` + items.map((t) => `<li>${inlineHtml(t)}</li>`).join('') + `</${tag}>`);
    } else {
      const buf = [];
      while (i < lines.length && lines[i].trim() && (buf.length === 0 || !isBlockStart(lines[i]))) buf.push(lines[i++].trim());
      out.push('<p>' + inlineHtml(buf.join(' ')) + '</p>');
    }
  }
  return out.join('\n');
}

const PAGE_CSS = [
  'body{font-family:Georgia,"Times New Roman",serif;line-height:1.5;color:#1a1a1a;max-width:52rem;margin:2rem auto;padding:0 1rem;}',
  'h1{font-size:1.7rem;margin-bottom:.2rem;}h2{font-size:1.25rem;margin-top:1.8rem;border-bottom:1px solid #ccc;padding-bottom:.2rem;}h3{font-size:1.05rem;}',
  'table{border-collapse:collapse;width:100%;margin:1rem 0;font-size:.85rem;}th,td{border:1px solid #888;padding:.3rem .45rem;text-align:left;vertical-align:top;overflow-wrap:anywhere;}th{background:#eee;}',
  'a{color:#0b4fa8;overflow-wrap:anywhere;}code{font-family:Consolas,monospace;background:#f2f2f2;padding:0 .2rem;}pre{background:#f2f2f2;padding:.6rem;overflow:auto;}',
  '@media print{body{max-width:none;margin:0;font-size:10.5pt;}tr,li{break-inside:avoid;}h2,h3{break-after:avoid;}a{color:#000;text-decoration:underline;}}',
].join('\n');

function shortTitle(question) {
  let t = String(question || '').replace(/\s+/g, ' ').trim();
  t = t.split(/(?<=[.?!])\s/)[0].replace(/[?.!\s]+$/, '');
  if (t.length > 80) t = t.slice(0, 80).replace(/\s+\S*$/, '');
  if (!t) t = 'Research report';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function cell(s) { return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim(); }

function sectionOf(prose, heading) {
  const lines = String(prose || '').split('\n');
  const re = new RegExp('^\\s*#{1,6}\\s*' + heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
  const start = lines.findIndex((l) => re.test(l));
  if (start < 0) return '';
  let end = lines.length;
  for (let k = start + 1; k < lines.length; k++) if (/^\s*#{1,6}\s/.test(lines[k])) { end = k; break; }
  return lines.slice(start + 1, end).join('\n').trim();
}

function bulletsOf(text) {
  return String(text || '').split('\n').map((l) => l.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/)).filter(Boolean).map((m) => m[1].trim()).filter(Boolean);
}

// The source's own wording for a figure that is not found as written: a 60-character excerpt around an occurrence of the same number (same
// mag, else the same digits), or "the number does not appear in the source". Code only finds the candidate; it never makes it "found".
function candidateWording(figure, text) {
  const fig = parseFigure(figure);
  const ct = checkableText(text);
  if (ct.kind === 'unreadable') return UNREADABLE_CHECK;
  const index = buildIndex(text);
  if (!index) return 'source too large to check';
  const clean = visibleText(ct.text);
  text = ct.text; // the passage is cut from the checkable text, as the index is built on it
  const key = fig.parts ? fig.parts[0].value : fig.value;
  let hit = (index.get(key) || [])[0];
  if (!hit) {
    const digits = String(figure).replace(/\D/g, '');
    if (digits) hit = numbersIn(clean).find((t) => t.raw.replace(/\D/g, '') === digits);
  }
  return hit ? `"${excerptAround(text, hit.index, hit.end, 60).text}"` : 'the number does not appear in the source';
}

// Rows [{ figure, url, wording }] for the document, or null when the run has no per-figure results (an older run).
function missedFigures(claims, fetched, proseMissed) {
  const rows = [];
  const seen = new Set();
  let known = Array.isArray(proseMissed);
  const add = (figure, url) => {
    const k = figure + '|' + url;
    if (seen.has(k)) return;
    seen.add(k);
    const f = findFetched(url, fetched);
    rows.push({ figure, url, wording: f && f.ok && f.text ? candidateWording(figure, f.text) : 'the number does not appear in the source' });
  };
  for (const c of claims) {
    if (!Array.isArray(c.figure_checks)) continue;
    known = true;
    for (const f of c.figure_checks) if (savedStatus(f.status) === NOT_FOUND) add(f.figure, c.source_url);
  }
  for (const m of Array.isArray(proseMissed) ? proseMissed : []) add(m.figure, m.source_url);
  return known ? rows : null;
}

// What the two marks mean, in plain words (the chat report and the document both carry it).
const SCOPE_SENTENCE = 'The code check confirms that each number, with its sign, currency, unit and the word right after it, appears in the cited source as it was fetched. Whether the surrounding words mean the same (what was measured, the direction, the period) is judged by the reviewer from the passage around the figure; a figure is confirmed only when both agree.';

// "1 matches, 1 differs, 1 not checked" for one claim, from its figure_checks (a claim without them: "not checked", or its own check text)
function meaningCell(c) {
  const fc = Array.isArray(c.figure_checks) ? c.figure_checks : null;
  if (!fc) return c.check_status === 'no_figures' ? 'no figures' : 'not checked';
  const n = (m) => fc.filter((f) => (f.meaning || 'not checked') === m).length;
  const parts = [[n('matches'), 'matches'], [n('differs'), 'differs'], [fc.length - n('matches') - n('differs'), 'not checked']].filter(([k]) => k > 0).map(([k, w]) => `${k} ${w}`);
  return parts.join(', ') || 'not checked';
}

// reviewRounds: how many review rounds were credited (tells "the review did not run" from "the reviewer compared none").
function renderDocument({ question, preparedDate, prose, claims, sources, corrections, proseMissed, reviewRounds } = {}) {
  const title = shortTitle(question);
  const list = Array.isArray(claims) ? claims : [];
  const fetched = Array.isArray(sources) ? sources : [];
  let body = String(prose || '').replace(/^\s*#\s+.*\n?/gm, '').trim();
  const corr = (Array.isArray(corrections) ? corrections : corrections ? [corrections] : []).map((x) => String(x).trim()).filter(Boolean);
  if (corr.length && !/^\s*#{1,6}\s*Corrections to the first pass/im.test(body)) body += (body ? '\n\n' : '') + '## Corrections to the first pass\n\n' + corr.map((x) => '- ' + x).join('\n');

  const label = (url) => { const f = findFetched(url, fetched); const t = f && f.title ? f.title : ''; return t ? `[${cell(t)}](${url})` : url || 'not given'; };
  const table = [
    '| Claim | Source | Measured result | Who judged | Evidence strength | Our inference | In the source | Means the same |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...list.map((c) => {
      const f = findFetched(c.source_url, fetched);
      const checked = (c.check || 'not checked') + (f && f.ok && f.partial ? '; source opened in part' : '');
      return `| ${cell(c.id + ': ' + c.claim)} | ${cell(label(c.source_url))} | ${cell(c.measured_result || '-')} | ${cell(c.judged_by || 'not stated')} | ${cell(c.evidence_strength || 'weak')} | ${c.inference ? 'yes' : 'no'} | ${cell(checked)} | ${cell(meaningCell(c))} |`;
    }),
  ];
  if (!list.length) table.push('| No claims recorded | | | | | | | |');

  // Figures not found as written: the figure as the report wrote it, the source it was checked against, and what that source has instead
  const missRows = missedFigures(list, fetched, proseMissed);
  const missSection = missRows ? [
    '## Figures not found as written',
    '',
    'The fetched text of the cited source does not have each figure below written the same way. This shows only that the figure is not in the source as written; it does not show that the source or the claim is right or wrong.',
    '',
    ...(missRows.length ? [
      '| Figure in the report | Checked against | The source\'s wording |',
      '| --- | --- | --- |',
      ...missRows.map((r) => `| ${cell(r.figure)} | ${cell(label(r.url))} | ${cell(r.wording)} |`),
    ] : ['None.']),
    '',
  ] : [];

  // Figures whose meaning differs: the figure, the claim as the report states it, the reviewer's quote from the passage, and the source.
  // Omitted (one line instead) when no figure's meaning was compared.
  const compared = list.some((c) => Array.isArray(c.figure_checks) && c.figure_checks.some((f) => f.meaning === 'matches' || f.meaning === 'differs'));
  const diffRows = list.flatMap((c) => (Array.isArray(c.figure_checks) ? c.figure_checks : []).filter((f) => f.meaning === 'differs').map((f) => ({ figure: f.figure, claim: `${c.id}: ${c.claim}`, quote: f.meaning_quote || '', url: c.source_url })));
  const diffSection = compared ? [
    '## Figures whose meaning differs',
    '',
    'The reviewer compared each figure below with the passage around it in the cited source and found that the passage says something different from the report. This is the reviewer\'s judgement from that passage, not a finding that the source is right.',
    '',
    ...(diffRows.length ? [
      '| Figure in the report | The claim as the report states it | The reviewer\'s quote from the source passage | Source |',
      '| --- | --- | --- | --- |',
      ...diffRows.map((r) => `| ${cell(r.figure)} | ${cell(r.claim)} | ${cell(r.quote)} | ${cell(label(r.url))} |`),
    ] : ['None.']),
    '',
  ] : [`No figure's meaning was compared: ${Number(reviewRounds) > 0 ? 'the reviewer compared none.' : 'the review did not run.'}`, ''];

  // an opened source the check could not read as plain reading text is marked (see checkableText)
  const unreadableMark = (f) => (f.ok && f.text && checkableText(f.text).kind === 'unreadable' ? ' ' + UNREADABLE_MARK : '');
  const src = (arr, withReason) => (arr.length ? arr.map((f) => `- ${f.title ? `[${cell(f.title)}](${f.url})` : f.url}${withReason && f.partialReason ? ' (' + cell(f.partialReason) + ')' : ''}${unreadableMark(f)}`).join('\n') : 'None');
  const md = [
    `# ${title}`,
    '',
    `Prepared ${preparedDate || ''}`.trim(),
    '',
    body,
    '',
    '## Traceability',
    '',
    ...table,
    '',
    SCOPE_SENTENCE,
    '',
    ...missSection,
    ...diffSection,
    '## Sources',
    '',
    '### Read in full',
    '',
    src(fetched.filter((f) => f.ok && !f.partial)),
    '',
    '### Opened in part',
    '',
    src(fetched.filter((f) => f.ok && f.partial), true),
    '',
    '### Not opened',
    '',
    src(fetched.filter((f) => !f.ok)),
    '',
  ].join('\n').replace(/\n{3,}/g, '\n\n');

  const html = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${esc(title)}</title>\n<style>\n${PAGE_CSS}\n</style>\n</head>\n<body>\n${mdToHtml(md)}\n</body>\n</html>\n`;
  return { markdown: md, html };
}

// ---------------------------------------------------------------- PDF

function defaultWhich(name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

function newestFirst(names) {
  const num = (n) => Number((String(n).match(/(\d+)/) || [])[1]) || 0;
  return [...names].sort((a, b) => num(b) - num(a));
}

function findPdfRenderer({ platform = process.platform, exists = fs.existsSync, which = defaultWhich, home = require('os').homedir(), readdir = (d) => { try { return fs.readdirSync(d); } catch { return []; } } } = {}) {
  const playwright = (root, archPrefix, tail) => {
    for (const d of newestFirst((readdir(root) || []).filter((n) => /^chromium-\d+$/.test(n)))) {
      for (const sub of newestFirst((readdir(path.join(root, d)) || []).filter((n) => n.startsWith(archPrefix)))) {
        const p = path.join(root, d, sub, ...tail);
        if (exists(p)) return p;
      }
    }
    return null;
  };
  if (platform === 'linux') {
    for (const n of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
      const p = which(n);
      if (p) return p;
    }
    return playwright(path.join(home, '.cache', 'ms-playwright'), 'chrome-linux', ['chrome']);
  }
  if (platform === 'darwin') {
    for (const p of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']) if (exists(p)) return p;
    return playwright(path.join(home, 'Library', 'Caches', 'ms-playwright'), 'chrome-mac', ['Chromium.app', 'Contents', 'MacOS', 'Chromium']);
  }
  return null;
}

function pdfArgs(htmlPath, pdfPath, userDataDir) {
  return ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', ...(userDataDir ? [`--user-data-dir=${userDataDir}`] : []), `--print-to-pdf=${pdfPath}`, require('url').pathToFileURL(htmlPath).href];
}

// A fresh profile directory per run so a Chrome already open on the desktop is not reused. The OS clears the temp dir.
async function renderPdf({ binary, htmlPath, pdfPath, execFile = require('child_process').execFile, timeoutMs = 120000, statSize = (p) => fs.statSync(p).size, mkdtemp = () => fs.mkdtempSync(path.join(require('os').tmpdir(), 'research-pdf-')) } = {}) {
  if (!binary) return { ok: false, error: 'no Chrome or Chromium found' };
  let profile;
  try { profile = mkdtemp(); } catch (e) { return { ok: false, error: 'the PDF renderer could not make a profile folder: ' + String((e && e.message) || e).split('\n')[0].slice(0, 200) }; }
  try {
    await new Promise((resolve, reject) => {
      let ret;
      try { ret = execFile(binary, pdfArgs(htmlPath, pdfPath, profile), { timeout: timeoutMs }, (err) => (err ? reject(err) : resolve())); } catch (e) { reject(e); return; }
      if (ret && typeof ret.then === 'function') ret.then(() => resolve(), reject);
    });
  } catch (e) {
    return { ok: false, error: 'the PDF renderer failed: ' + String((e && e.message) || e).split('\n')[0].slice(0, 200) };
  }
  let size = 0;
  try { size = statSize(pdfPath); } catch { return { ok: false, error: 'the PDF file was not created' }; }
  if (!(size > 1024)) return { ok: false, error: `the PDF file is too small (${size} bytes)` };
  return { ok: true, error: '' };
}

function fileBase(question, date) {
  let d = date;
  if (d instanceof Date) d = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  d = String(d || '').slice(0, 10);
  const words = String(question || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 6);
  return `deep-research-${d}-${words.join('-') || 'report'}`;
}

// ---------------------------------------------------------------- chat report

function chatReport({ question, prose, claims, totals, corrections, reviewer, rounds, files, missing, level, notChecked, review, doubtedIds, interrupted, unreviewedIds, interruptedBeforeCheck, checkError } = {}) {
  void question; void level;
  const p = String(prose || '');
  const t = totals || { figures: 0, found: 0, notFound: 0, notOpened: 0 };
  const list = Array.isArray(claims) ? claims : [];
  const doubted = new Set((Array.isArray(doubtedIds) ? doubtedIds : []).map(String));
  const unreviewed = (Array.isArray(unreviewedIds) ? unreviewedIds : []).map(String).filter(Boolean);
  const unrev = new Set(unreviewed);
  const lines = [];
  const verdict = sectionOf(p, 'Verdict') || p.split('\n').find((l) => l.trim() && !/^\s*#/.test(l)) || '';
  lines.push('Verdict', verdict.trim() || 'No verdict was written.', '');

  // Key evidence: only claims whose figures are all confirmed (found as written AND the reviewer found the meaning the same) and that the review did not doubt.
  const confirmed = (c) => savedStatus(c.check_status) === FOUND && Array.isArray(c.figure_checks) && c.figure_checks.length > 0 && c.figure_checks.every((f) => savedStatus(f.status) === FOUND && f.meaning === 'matches');
  const ev = list.filter((c) => confirmed(c) && !doubted.has(String(c.id)) && !unrev.has(String(c.id))).slice(0, 5);
  lines.push('Key evidence');
  if (ev.length) {
    for (const c of ev) lines.push(`- ${c.claim}${c.source_url ? ' [' + c.source_url + ']' : ''}${c.inference ? ' (our inference)' : ''} (figures confirmed by both checks)`);
  } else lines.push('- No claim has all its figures confirmed by both checks and no doubt from the review.');
  const dl = list.filter((c) => doubted.has(String(c.id))).slice(0, 8);
  if (dl.length) {
    lines.push('', 'Doubted by the review');
    for (const c of dl) lines.push(`- ${c.claim}${c.source_url ? ' [' + c.source_url + ']' : ''}`);
  }
  lines.push('');

  let corr = Array.isArray(corrections) ? corrections.map(String).filter(Boolean) : bulletsOf(sectionOf(p, 'Corrections to the first pass'));
  if (!corr.length && !Array.isArray(corrections)) {
    const raw = sectionOf(p, 'Corrections to the first pass');
    if (raw && !/^none\.?$/i.test(raw.trim())) corr = [raw.trim()];
  }
  lines.push('Corrections to the first pass');
  if (corr.length) corr.forEach((x) => lines.push('- ' + x)); else lines.push('None');
  lines.push('');

  const conf = sectionOf(p, 'Confidence');
  lines.push('Confidence', conf ? conf.split('\n').map((x) => x.trim()).filter(Boolean).join(' ').slice(0, 400) : 'Not stated.', '');

  const NO_MEANING = 'Means the same: not checked.';
  if (checkError) lines.push('Figures not checked (the check failed); every figure is marked not checked.', NO_MEANING);
  else if (interruptedBeforeCheck) lines.push('Figures not checked (the run stopped before the check); every figure is marked not checked.', NO_MEANING);
  else if (notChecked) lines.push('Figures not checked: the report had no list of claims to check them against; every figure in it is marked not checked.', NO_MEANING);
  else if (interrupted && list.length && !totals && !list.some((c) => c.check_status)) lines.push('Figures not checked (the run stopped before the check).', NO_MEANING);
  else {
    // claim figures and prose figures are both counted; totals saved by an older run have proseUnverified (figures not tied to a checked source)
    const n = (x) => Number(x) || 0;
    const oldRun = t.proseNoSource === undefined && t.proseUnverified !== undefined;
    const found = n(t.found) + n(t.proseFound);
    const notFound = n(t.notFound) + n(t.proseNotFound);
    const notOpened = n(t.notOpened) + n(t.proseNotOpened);
    const noSource = n(t.noSource) + n(t.proseNoSource) + (oldRun ? n(t.proseUnverified) : 0);
    lines.push(`In the source (checked by code against the fetched text): ${found} found as written; ${notFound} not found as written (marked "not found in source"); ${notOpened} from sources that could not be opened (marked "source not opened"); ${noSource} with no source to check.`);
    if (n(t.sourcesUnreadable) > 0) lines.push(n(t.sourcesUnreadable) === 1 ? '1 source could not be read in a checkable form; its figures are not checked against it.' : `${n(t.sourcesUnreadable)} sources could not be read in a checkable form; their figures are not checked against them.`);
    // the second mark: only a figure found as written can match or differ; every other figure is "not checked"
    const total = found + notFound + notOpened + noSource;
    const matches = Math.min(found, n(t.meaningMatches) + n(t.proseMatches));
    const differs = Math.min(found - matches, n(t.meaningDiffers) + n(t.proseDiffers));
    lines.push(`Means the same (checked by the reviewer against the passage around each figure): ${matches} matches; ${differs} differs (marked "source says otherwise"); ${total - matches - differs} not checked. Confirmed by both: ${matches} of ${total} figures.`);
    lines.push(SCOPE_SENTENCE);
  }
  const plural = (n) => `${n} ${n === 1 ? 'round' : 'rounds'}`;
  if (review && typeof review === 'object') {
    const k = review.counts || {};
    const n = (x) => Number(x) || 0;
    const decisive = n(k.supported) + n(k.partly) + n(k.not_supported);
    if (review.failed || decisive === 0) lines.push('Not challenged: the reviewer gave no usable verdicts.');
    else {
      lines.push(`Challenged by: ${review.label || reviewer || 'a reviewer'} (${plural(Math.max(0, Number(review.rounds) || 0))}): ${n(k.supported)} supported, ${n(k.partly)} partly, ${n(k.not_supported)} not supported, ${n(k.cannot_check)} could not be checked${review.lastRoundFailed && Number(review.rounds) >= 1 ? '; the last round gave no usable verdicts' : ''}`);
      const un = Array.isArray(review.uncheckedIds) ? review.uncheckedIds.map(String).filter(Boolean) : [];
      if (un.length) lines.push(`Not checked by the reviewer: ${un.join(', ')}.`);
    }
  } else {
    const r = Math.max(0, Number(rounds) || 0);
    lines.push(reviewer ? `Challenged by: ${reviewer} (${plural(r)})` : 'Challenged by: no one (the review did not run)');
  }
  if (unreviewed.length) lines.push(`Changed after the last review (not reviewed): ${unreviewed.join(', ')}.`);
  const f = files || {};
  const doc = f.md || f.markdown || f.document || f.html;
  if (doc) lines.push(`Full document: ${doc}`);
  if (f.pdf) lines.push(`PDF: ${f.pdf}`);
  else lines.push(`No PDF: ${f.pdfError || f.pdfReason || 'it was not made'}`);
  const miss = (Array.isArray(missing) ? missing : missing ? [missing] : []).map(String).filter(Boolean);
  if (miss.length) lines.push(`Missing: ${miss.join('; ')}`);
  return lines.join('\n');
}

const STAGE_LABELS = {
  quick: 'quick pass',
  select: 'choosing sources',
  fetch: 'fetching the source texts',
  read: 'reading sources in full',
  synthesis: 'writing the report',
  check: 'checking figures',
  challenge: 'checking the report',
  document: 'writing the document',
};

function progressLabel(stage, done, total) {
  const base = STAGE_LABELS[stage] || String(stage || '');
  const has = Number.isFinite(done) && Number.isFinite(total) && total > 0;
  if ((stage === 'read' || stage === 'fetch') && has) return `${base} (${done} of ${total})`;
  if (stage === 'challenge' && has) return `${base} (round ${done} of ${total})`;
  return base;
}

module.exports = {
  DEFAULTS, STAGES, settingsFrom,
  selectionBrief, parseSelection, extractSources,
  fetchSourceTexts,
  readerBrief, groupForReaders,
  synthesisBrief, parseClaims,
  normFigure, numbersIn, groupRuns, parseFigure, savedStatus, claimKey, markUnverified, checkFigure, checkReport, proseBlocks, challengeSummary, checkClaims, figuresInProse, markProse, applyCheck, verifiedFigures, keywordsFrom,
  challengeExcerpts, challengeBrief, parseChallenge, reviseBrief, figureExcerpts, figureMeanings, mergeMeanings, SCOPE_SENTENCE,
  renderDocument, mdToHtml, esc, findPdfRenderer, pdfArgs, renderPdf, fileBase, chatReport, progressLabel,
  normUrl, arxivId, classifyProseNumbers, sectionOf, INDEX_LIMITS, INDEX_STATS, visibleText, matchedHit, proseEntries, reportIdFor,
};
