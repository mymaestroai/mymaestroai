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
    '- figures: every figure the claim relies on, each exactly as printed in the source, numbers only, no units except %.',
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
  return t.trim();
}

function hadPercent(s) { return /(?:%|\bpercent|\bper cent)\s*$/i.test(String(s == null ? '' : s)); }

const NUM_RE = /(?<!\d)(?:\d{1,3}(?:[,\u2009\u202f]\d{3})+(?!\d)(?:\.\d+)?|\d+(?:\.\d+)?)%?/g;
const PCT_AFTER = /^\s?(?:%|percent\b|per cent\b)/i;

// A scale suffix right after a number. k/K/M/B/bn/pp/thousand/million/billion may follow a space; m (million), x and pp only touch the number.
const SCALE_RE = /^(?: ?(thousand|million|billion|bn|pp|k|K|M|B)|(m|x))(?![A-Za-z0-9])/;
const SCALE_POW = { thousand: 3, k: 3, K: 3, million: 6, M: 6, m: 6, billion: 9, bn: 9, B: 9 };

// Move the decimal point of a plain digit string (optionally negative) by n places; trailing zeros dropped.
function shiftDecimal(v, n) {
  const neg = v.startsWith('-');
  let [i, d = ''] = v.replace(/^-/, '').split('.');
  if (n > 0) { d = d.padEnd(n, '0'); i += d.slice(0, n); d = d.slice(n); }
  i = i.replace(/^0+(?=\d)/, '');
  d = d.replace(/0+$/, '');
  return (neg ? '-' : '') + i + (d ? '.' + d : '');
}

// unit: '' | 'pct' | 'x' | 'pp'. mag: the quantity with the scale applied (300k and 300,000 share one mag).
// pct: the number carries a percent unit ("56.4%", "56.4 %", "56.4 percent", "56.4 per cent").
function numbersIn(text) {
  const s = String(text || '');
  const out = [];
  NUM_RE.lastIndex = 0;
  for (const m of s.matchAll(NUM_RE)) {
    let index = m.index;
    let raw = m[0];
    const prev = s[index - 1];
    if (prev === '-' || prev === '−' || prev === '+') {
      const pp = s[index - 2];
      if (pp === undefined || /[\s(\[=:,;~<>≈"'/]/.test(pp)) { index -= 1; raw = prev + raw; }
    }
    let end = index + raw.length;
    const percent = hadPercent(raw);
    let suffix = '';
    if (!percent) {
      const sm = SCALE_RE.exec(s.slice(end, end + 12));
      if (sm) { suffix = sm[1] || sm[2]; end += sm[0].length; }
    }
    const value = normFigure(raw);
    const pct = percent || (!suffix && PCT_AFTER.test(s.slice(end, end + 12)));
    const unit = suffix === 'x' || suffix === 'pp' ? suffix : pct ? 'pct' : '';
    const pow = SCALE_POW[suffix];
    out.push({ text: s.slice(index, end), raw, value, mag: pow ? shiftDecimal(value, pow) : value, suffix, unit, index, end, percent, pct, count: false });
  }
  for (const t of out) t.count = !t.pct && !t.unit && COUNT_AFTER.test(s.slice(t.end, t.end + 24));
  return out;
}

// A plural noun right after a number says the number counts things (it is not a rate or share).
const COUNT_NOUNS = 'participants|items|pairs|samples|raters|annotators|stories|papers|tokens|requests|users|examples|questions|respondents|people|patients|subjects|students|documents|images|queries|tasks|problems|instances|cases|records|rows|words|sentences|prompts|trials|runs|tests|annotations|reviews|articles|sessions|workers|customers|engineers|employees|studies|models|datasets|benchmarks|languages|classes|labels|judges|comparisons';
const COUNT_AFTER = new RegExp('^\\s+(?:' + COUNT_NOUNS + ')\\b', 'i');

// Parse one figure as written ("300k", "56.4%", "1,250") into { value (mag), unit }.
function parseFigure(figure) {
  const str = String(figure == null ? '' : figure).trim();
  const t = numbersIn(str).find((x) => str.slice(0, x.index).trim() === '');
  if (t) return { value: t.mag, unit: t.unit, pct: t.unit === 'pct' };
  return { value: normFigure(str), unit: hadPercent(str) ? 'pct' : '', pct: hadPercent(str) };
}

// Common: an integer below 1000, or a decimal with fewer than 3 significant digits.
function isCommon(value) {
  const v = String(value).replace(/^-/, '');
  if (/^\d{1,3}$/.test(v)) return true;
  if (/^\d+\.\d+$/.test(v)) return v.replace('.', '').replace(/^0+/, '').length < 3;
  return false;
}

const idxMemo = { text: null, map: null };
function buildIndex(text) {
  if (idxMemo.text === text && idxMemo.map) return idxMemo.map;
  const map = new Map();
  for (const t of numbersIn(text)) {
    let a = map.get(t.mag);
    if (!a) { a = []; map.set(t.mag, a); }
    a.push(t);
  }
  idxMemo.text = text; idxMemo.map = map;
  return map;
}

const GENERIC_WORDS = new Set(['accuracy', 'result', 'results', 'model', 'models', 'performance', 'score', 'scores', 'dataset', 'datasets', 'table', 'tables', 'figure', 'figures', 'human', 'humans', 'study', 'studies', 'using', 'which', 'their', 'these', 'those', 'between', 'compared', 'higher', 'lower', 'average', 'percent']);

function keywordsFrom(text) {
  const words = [...new Set((String(text || '').toLowerCase().match(/[a-z]{5,}/g) || []))].filter((w) => !GENERIC_WORDS.has(w));
  return words.map((w, i) => ({ w, i })).sort((a, b) => b.w.length - a.w.length || a.i - b.i).slice(0, 8).map((x) => x.w);
}

// fig: { value (normalised magnitude), unit ('' | 'pct' | 'x' | 'pp'), count }. A percent figure matches only a percent in the source;
// x and pp match only their own unit; a plain figure matches a plain or percent source number, unless it counts things (then plain only).
function checkValue(fig, sourceText, keywords) {
  if (!fig || !fig.value) return 'not_found';
  const text = String(sourceText || '');
  let hits = buildIndex(text).get(fig.value);
  if (hits) {
    if (fig.unit === 'pct') hits = hits.filter((h) => h.unit === 'pct');
    else if (fig.unit) hits = hits.filter((h) => h.unit === fig.unit);
    else hits = hits.filter((h) => h.unit === '' || (h.unit === 'pct' && !fig.count));
  }
  if (!hits || !hits.length) return 'not_found';
  if (!isCommon(fig.value)) return 'found';
  const kws = (keywords || []).map((k) => String(k).toLowerCase()).filter(Boolean);
  if (!kws.length) return 'common_not_near';
  for (const h of hits) {
    const win = text.slice(Math.max(0, h.index - 300), h.end + 300).toLowerCase();
    if (kws.some((k) => win.includes(k))) return 'found';
  }
  return 'common_not_near';
}

function checkFigure(figure, sourceText, keywords) {
  return checkValue(parseFigure(figure), sourceText, keywords);
}

function findFetched(url, fetched) {
  if (!normUrl(url)) return null;
  let best = null;
  for (const f of Array.isArray(fetched) ? fetched : []) {
    if (sameSource(url, f.url) || sameSource(url, f.finalUrl)) {
      if (f.ok && f.text) return f;
      if (!best) best = f;
    }
  }
  return best;
}

// Every figure a claim relies on: its figures array plus every checkable number in its claim and measured_result text.
// A figure is its value + unit (+ whether it counts things): "125 participants" and "125% growth" are two figures.
function claimFigureList(c, counts) {
  const map = new Map();
  const add = (figure, p) => {
    if (!p.value) return;
    const key = p.value + '|' + p.unit + '|' + (p.count ? 'n' : '');
    if (!map.has(key)) map.set(key, { figure: String(figure), value: p.value, unit: p.unit, count: !!p.count });
  };
  for (const f of Array.isArray(c.figures) ? c.figures : []) add(f, parseFigure(f));
  for (const text of [c.claim, c.measured_result]) for (const t of figuresInProse(text, counts)) add(t.text, { value: t.mag, unit: t.unit, count: t.count });
  // a bare figure that the text shows as a count is that count, not a second figure
  // and a bare figure (the figures array omits units) that the text shows as a percent is that percent
  for (const [k, e] of [...map]) {
    if (e.unit || e.count) continue;
    if (map.has(e.value + '||n')) map.delete(k);
    else if (map.has(e.value + '|pct|')) { e.unit = 'pct'; map.delete(e.value + '|pct|'); }
  }
  return [...map.values()];
}

function checkClaims(claims, fetched, counts) {
  const totals = { claims: 0, figures: 0, found: 0, notFound: 0, notOpened: 0 };
  const out = [];
  for (const c of Array.isArray(claims) ? claims : []) {
    const figs = claimFigureList(c, counts);
    const src = findFetched(c.source_url, fetched);
    const opened = !!(src && src.ok && src.text);
    const res = { id: c.id, source_opened: opened, figures: [], status: '' };
    totals.claims++;
    totals.figures += figs.length;
    if (!opened) {
      res.figures = figs.map((x) => ({ figure: x.figure, status: 'source_not_opened' }));
      res.status = 'source_not_opened';
      totals.notOpened += figs.length;
    } else if (!figs.length) {
      res.status = 'no_figures';
    } else {
      const kws = keywordsFrom(c.claim);
      res.figures = figs.map((x) => ({ figure: x.figure, status: checkValue(x, src.text, kws) }));
      const f = res.figures.filter((x) => x.status === 'found').length;
      totals.found += f;
      totals.notFound += figs.length - f;
      res.status = f === figs.length ? 'verified' : f === 0 ? 'unverified' : 'partly';
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
  while (i >= 0 && /[A-Za-z0-9._-]/.test(s[i])) i--;
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
    else if (!t.pct && !t.suffix && /^\d{4}$/.test(t.raw) && +t.raw >= 1900 && +t.raw <= 2100 && (YEAR_BEFORE.test(before) || YEAR_AFTER.test(after))) reason = 'year';
    else if (/^\s*(?:[-*+>]\s+)?$/.test(lineStart) && /^[.)](?:\s|$)/.test(after) && /^\d+$/.test(t.raw)) reason = 'list marker';
    else if (LOCATION_BEFORE.test(before)) reason = 'location';
    else if (!t.pct && SELF_COUNT_AFTER.test(after) && (!own || own.has(Number(t.value)))) reason = 'self count';
    else if (insideLetterWord(s, t.index)) reason = 'name or version';
    return { token: t, exempt: reason };
  });
}

function figuresInProse(prose, counts) {
  return classifyProseNumbers(prose, counts).filter((x) => !x.exempt).map((x) => x.token);
}

function insertMarks(s, toks) {
  const todo = toks.filter((t) => !s.startsWith(' [unverified]', t.end));
  let out = s;
  for (const t of [...todo].sort((a, b) => b.end - a.end)) out = out.slice(0, t.end) + ' [unverified]' + out.slice(t.end);
  return { prose: out, marks: todo.length };
}

function markProse(prose, verifiedSet) {
  const s = String(prose || '');
  const ok = verifiedSet instanceof Set ? verifiedSet : new Set(Array.isArray(verifiedSet) ? verifiedSet.map(normFigure) : []);
  return insertMarks(s, figuresInProse(s).filter((t) => !ok.has(t.value) && !ok.has(t.mag)));
}

// Normalised values of every figure that was found in its source (build the set markProse needs).
function verifiedFigures(result) {
  const set = new Set();
  for (const c of (result && result.claims) || []) for (const f of c.figures || []) if (f.status === 'found') { set.add(normFigure(f.figure)); set.add(parseFigure(f.figure).value); }
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

// Split a block into sentences: ., ? or ! followed by white space, or "; ". Returns [{ start, end }] (absolute offsets in text).
function sentencesOf(text, base) {
  const out = [];
  const re = /[.?!]+(?=\s)|;(?= )/g;
  let start = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const end = m.index + m[0].length;
    out.push({ start: base + start, end: base + end });
    start = end;
  }
  if (start < text.length) out.push({ start: base + start, end: base + text.length });
  return out;
}

// The whole figure check: claims against their sources, then every prose figure against a claim cited in its own sentence
// (or, when the sentence cites nothing, the block's single cited source). Anything else is unverified.
function checkReport({ prose, claims, fetched, counts } = {}) {
  const p = String(prose || '');
  const list = Array.isArray(claims) ? claims : [];
  const cnt = counts && typeof counts === 'object' ? counts : {};
  const toks = figuresInProse(p, cnt);
  if (!list.length) {
    const m = insertMarks(p, toks);
    return { prose: m.prose, claims: [], totals: { claims: 0, figures: 0, found: 0, notFound: 0, notOpened: 0, proseFigures: toks.length, proseVerified: 0, proseUnverified: toks.length }, notChecked: true, marks: m.marks };
  }
  const res = checkClaims(list, fetched, cnt);
  const annotated = applyCheck(list, res);
  const info = list.map((c) => {
    const src = findFetched(c.source_url, fetched);
    const title = src && src.title ? String(src.title).trim().toLowerCase() : '';
    return { c, text: src && src.ok && src.text ? src.text : '', title: title.length >= 6 ? title : '', kws: keywordsFrom(c.claim) };
  });
  const blocks = proseBlocks(p);
  const citedIn = (a, b) => {
    const text = p.slice(a, b);
    const lower = text.toLowerCase();
    const urls = urlsIn(text).map((u) => u.url);
    return info.filter((x) => (normUrl(x.c.source_url) && urls.some((u) => urlRelated(x.c.source_url, u))) || (x.title && lower.includes(x.title)));
  };
  const perBlock = blocks.map((b) => {
    const all = citedIn(b.start, b.end);
    const sources = [];
    for (const x of all) if (!sources.some((y) => urlRelated(x.c.source_url, y.c.source_url) && (normUrl(x.c.source_url) || x.title === y.title))) sources.push(x);
    return { sentences: sentencesOf(p.slice(b.start, b.end), b.start).map((sn) => ({ ...sn, cited: null })), all, single: sources.length === 1 };
  });
  const bad = toks.filter((t) => {
    const bi = blocks.findIndex((b) => t.index >= b.start && t.index < b.end);
    if (bi < 0) return true;
    const pb = perBlock[bi];
    const sn = pb.sentences.find((x) => t.index >= x.start && t.index < x.end);
    let use = [];
    if (sn) { if (!sn.cited) sn.cited = citedIn(sn.start, sn.end); use = sn.cited; }
    if (!use.length && pb.single) use = pb.all;
    return !use.some((x) => x.text && checkValue({ value: t.mag, unit: t.unit, count: t.count }, x.text, x.kws) === 'found');
  });
  const m = insertMarks(p, bad);
  const totals = { ...res.totals, proseFigures: toks.length, proseVerified: toks.length - bad.length, proseUnverified: bad.length };
  return { prose: m.prose, claims: annotated, totals, notChecked: false, marks: m.marks };
}

// Mark every checkable figure in a text as unverified (for sections added after the check).
function markUnverified(text) {
  return checkReport({ prose: text, claims: [] }).prose;
}

// A fingerprint of a claim: its text, its source and its figures. The id is not part of it.
function claimKey(claim) {
  const c = claim && typeof claim === 'object' ? claim : {};
  const norm = (x) => String(x == null ? '' : x).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const url = normUrl(c.source_url) || norm(c.source_url);
  const figs = (Array.isArray(c.figures) ? c.figures : []).map((f) => { const q = parseFigure(f); return q.value + (q.unit ? ' ' + q.unit : ''); }).sort();
  return require('crypto').createHash('sha256').update(norm(c.claim) + '|' + url + '|' + figs.join(',')).digest('hex');
}

function applyCheck(claims, result) {
  const byId = new Map(((result && result.claims) || []).map((r) => [r.id, r]));
  return (Array.isArray(claims) ? claims : []).map((c) => {
    const r = byId.get(c.id);
    const out = { ...c, figures: Array.isArray(c.figures) ? [...c.figures] : [] };
    if (!r) { out.check = 'not checked'; out.check_status = 'not_checked'; return out; }
    out.check_status = r.status;
    if (r.status === 'source_not_opened') { out.check = 'source not opened'; return out; }
    if (r.status === 'no_figures') { out.check = 'no figures'; return out; }
    const total = r.figures.length;
    const found = r.figures.filter((f) => f.status === 'found');
    const bad = r.figures.filter((f) => f.status !== 'found');
    const noun = total === 1 ? 'figure' : 'figures';
    out.check = bad.length ? `${found.length} of ${total} found; not found: ${bad.map((f) => f.figure).join(', ')}` : `${found.length} of ${total} ${noun} found`;
    if (bad.length && out.measured_result) {
      let mr = out.measured_result;
      const toks = numbersIn(mr);
      const inserts = [];
      for (const f of bad) {
        const v = parseFigure(f.figure);
        const t = toks.find((x) => x.mag === v.value && (x.unit === v.unit || (!v.unit && x.unit === 'pct')) && !inserts.some((i) => i.end === x.end) && !mr.startsWith(' [unverified]', x.end));
        if (t) inserts.push(t);
      }
      for (const t of inserts.sort((a, b) => b.end - a.end)) mr = mr.slice(0, t.end) + ' [unverified]' + mr.slice(t.end);
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
    const text = src.text;
    const index = buildIndex(text);
    const wins = [];
    const add = (a, b, width) => {
      const w = excerptAround(text, a, b, width);
      if (wins.some((x) => Math.abs(x.start - w.start) < width / 2)) return false;
      wins.push(w);
      return true;
    };
    const figs = [...new Set((c.figures || []).map(normFigure).filter(Boolean))];
    const hitLists = figs.map((f) => index.get(f) || []).filter((l) => l.length);
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

function cutEvenly(text, cap) {
  return text.length <= cap ? text : text.slice(0, Math.max(0, cap - 1)).trimEnd() + '…';
}

function challengeBrief(question, claims, excerpts) {
  const all = Array.isArray(claims) ? claims : [];
  const used = all.slice(0, CHALLENGE_MAX_CLAIMS);
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
    ].join('\n');
  }).join('\n\n---\n\n');
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
    'Reply with ONLY a fenced json array, nothing before or after it, one object per claim id, with a one-line reason:',
    '```json',
    '[{"id": "c1", "verdict": "supported", "reason": "..."}]',
    '```',
    '',
    ...(notes.length ? [notes.join(' '), ''] : []),
    'Claims:',
    '',
    blocks,
  ].join('\n');
}

const VERDICTS = ['supported', 'partly', 'not_supported', 'cannot_check'];

function parseChallenge(text, ids) {
  const want = Array.isArray(ids) ? ids.map(String) : [];
  const wantSet = new Set(want);
  const blocks = fencedBlocks(text);
  const pick = blocks.find((b) => b.lang === 'json') || blocks[0];
  let arr = null;
  let error = '';
  if (pick) { const r = parseJsonLoose(pick.body); if (Array.isArray(r.value)) arr = r.value; else error = r.error || 'not a JSON array'; }
  if (!arr) { arr = bareJsonArray(text); if (!arr && !error) error = 'no json block found'; }
  const byId = new Map();
  const unknown = [];
  for (const it of arr || []) {
    if (!it || typeof it !== 'object') continue;
    const id = String(it.id == null ? '' : it.id).trim();
    if (!wantSet.has(id)) { if (id) unknown.push(id); continue; }
    if (byId.has(id)) continue;
    const v = String(it.verdict || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    byId.set(id, { id, verdict: VERDICTS.includes(v) ? v : 'cannot_check', reason: typeof it.reason === 'string' ? it.reason.trim() : '' });
  }
  const missing = [];
  const results = want.map((id) => {
    if (byId.has(id)) return byId.get(id);
    missing.push(id);
    return { id, verdict: 'cannot_check', reason: 'the reviewer gave no verdict for this claim' };
  });
  const counts = { supported: 0, partly: 0, not_supported: 0, cannot_check: 0 };
  for (const r of results) counts[r.verdict]++;
  return { results, unknown, missing, counts, error: arr ? '' : error };
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

function reviseBrief(question, prose, claims, challenge) {
  const list = Array.isArray(challenge) ? challenge : (challenge && challenge.results) || [];
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
    '- Do not add new figures. Every figure in the prose must still be in a claim\'s figures with its source.',
    '- Keep the same output format: the markdown sections (## Verdict, ## Evidence, ## Where sources disagree, ## Confidence, ## Corrections to the first pass) and then the fenced ```claims block with the revised claims (same fields; keep ids of surviving claims).',
    '- List in "Corrections to the first pass" everything this review changed (dropped, corrected or qualified claims), besides what was listed already.',
    '- Do not mention reviewers, models or how the report was produced anywhere else in the report.',
    '',
    'Review results:',
    lines || '- none',
    '',
    'Current report:',
    '"""',
    String(prose || ''),
    '"""',
    '',
    'Current claims:',
    '```claims',
    JSON.stringify(Array.isArray(claims) ? claims.map(({ check, check_status, ...rest }) => rest) : [], null, 1),
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

function renderDocument({ question, preparedDate, prose, claims, sources, corrections } = {}) {
  const title = shortTitle(question);
  const list = Array.isArray(claims) ? claims : [];
  const fetched = Array.isArray(sources) ? sources : [];
  let body = String(prose || '').replace(/^\s*#\s+.*\n?/gm, '').trim();
  const corr = (Array.isArray(corrections) ? corrections : corrections ? [corrections] : []).map((x) => String(x).trim()).filter(Boolean);
  if (corr.length && !/^\s*#{1,6}\s*Corrections to the first pass/im.test(body)) body += (body ? '\n\n' : '') + '## Corrections to the first pass\n\n' + corr.map((x) => '- ' + x).join('\n');

  const label = (url) => { const f = findFetched(url, fetched); const t = f && f.title ? f.title : ''; return t ? `[${cell(t)}](${url})` : url || 'not given'; };
  const table = [
    '| Claim | Source | Measured result | Who judged | Evidence strength | Our inference | Figures checked |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...list.map((c) => {
      const f = findFetched(c.source_url, fetched);
      const checked = (c.check || 'not checked') + (f && f.ok && f.partial ? '; source opened in part' : '');
      return `| ${cell(c.id + ': ' + c.claim)} | ${cell(label(c.source_url))} | ${cell(c.measured_result || '-')} | ${cell(c.judged_by || 'not stated')} | ${cell(c.evidence_strength || 'weak')} | ${c.inference ? 'yes' : 'no'} | ${cell(checked)} |`;
    }),
  ];
  if (!list.length) table.push('| No claims recorded | | | | | | |');

  const src = (arr, withReason) => (arr.length ? arr.map((f) => `- ${f.title ? `[${cell(f.title)}](${f.url})` : f.url}${withReason && f.partialReason ? ' (' + cell(f.partialReason) + ')' : ''}`).join('\n') : 'None');
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

function chatReport({ question, prose, claims, totals, corrections, reviewer, rounds, files, missing, level, notChecked, review, doubtedIds, interrupted, unreviewedIds, interruptedBeforeCheck } = {}) {
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

  // Key evidence: only claims whose figures were verified and that the review did not doubt.
  const ev = list.filter((c) => c.check_status === 'verified' && !doubted.has(String(c.id)) && !unrev.has(String(c.id))).slice(0, 5);
  lines.push('Key evidence');
  if (ev.length) {
    for (const c of ev) lines.push(`- ${c.claim}${c.source_url ? ' [' + c.source_url + ']' : ''}${c.inference ? ' (our inference)' : ''} (figures verified)`);
  } else lines.push('- No claim has both its figures verified and no doubt from the review.');
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

  if (interruptedBeforeCheck) lines.push('Figures not checked (the run stopped before the check); every figure is marked unverified.');
  else if (notChecked) lines.push('Figures not checked: the report had no list of claims to check them against; every figure in it is marked unverified.');
  else if (interrupted && list.length && !totals && !list.some((c) => c.check_status)) lines.push('Figures not checked (the run stopped before the check).');
  else {
    const pu = Number(t.proseUnverified) || 0;
    const extra = pu > 0 ? `, and ${pu} ${pu === 1 ? 'figure' : 'figures'} in the text not tied to a checked source (marked unverified)` : '';
    lines.push(`Figures checked: ${t.found || 0} of ${t.figures || 0} found in the sources; ${t.notFound || 0} not found (marked unverified); ${t.notOpened || 0} from sources that could not be opened${extra}.`);
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
  normFigure, numbersIn, parseFigure, claimKey, markUnverified, checkFigure, checkReport, proseBlocks, challengeSummary, checkClaims, figuresInProse, markProse, applyCheck, verifiedFigures, keywordsFrom,
  challengeExcerpts, challengeBrief, parseChallenge, reviseBrief,
  renderDocument, mdToHtml, esc, findPdfRenderer, pdfArgs, renderPdf, fileBase, chatReport, progressLabel,
  normUrl, arxivId, classifyProseNumbers, sectionOf,
};
