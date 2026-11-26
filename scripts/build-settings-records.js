#!/usr/bin/env node
'use strict';
// Builds templates/settings-records.json (the one record of every setting, indicator, door and action) from the
// configuration audit and the written help. The inputs live outside the repo, so their folders are arguments:
//
//   node scripts/build-settings-records.js --audit <config-audit dir> --help <help out dir> --repo <repo root> --out templates/settings-records.json
//
// <config-audit dir> holds mapping.csv and inventory/ (options.csv plus one CSV per surface); <help out dir> holds
// batch-*.json help fragments ({ records: [{ id, name, what, when, risk, def, restart, words, facts }] }), and may be
// missing or partly filled. The output is stable: running it twice gives the same file. A summary goes to stdout only.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Which surface a source file belongs to (the pages that draw the controls).
const SURFACE_BY_FILE = {
  'app.js': 'desktop', 'index.html': 'desktop', 'comms-panel.js': 'desktop',
  'mobile.js': 'phone', 'mobile.html': 'phone',
  'agent-settings.html': 'agent-settings', 'users.html': 'users', 'modules.html': 'modules',
  'local-models.html': 'local-models', 'changes.html': 'changes', 'welcome.html': 'welcome',
};
const DANGER = { everyday: 'everyday', 'needs care': 'care', dangerous: 'dangerous' };
const LEAD = { 'apply+undo': 'apply', 'confirm card': 'confirm', 'screen only': 'screen' };
const ID_RE = /(?<![\w-])id=(["'])([A-Za-z][\w:.-]*)\1/;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    out[a.slice(2)] = argv[++i];
  }
  for (const k of ['audit', 'help', 'repo', 'out']) if (!out[k]) throw new Error(`missing --${k}`);
  if (!out.code) out.code = out.repo;   // where the audit's file:line references are read (the commit the line numbers were taken from)
  return out;
}

// The same normalisation the page uses to find a row by its label (lib/ui-settings-help.js).
const { normLabel } = require('../lib/ui-settings-help.js');

/** The words a row can be found by, or null when it has none worth matching (empty, too long, or a description rather than a label). */
function labelAnchorText(label) {
  const t = normLabel(label);
  if (!t || t.length > 60) return null;
  if (/ e\.g\./i.test(t)) return null;
  if (/^[a-z]{3,}\b/.test(t)) return null;   // starts with a lowercase verb phrase: "opens the …"
  return t;
}

/** A small CSV reader: quoted fields, doubled quotes, line breaks inside quotes. Returns an array of { header: value }. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift() || [];
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] === undefined ? '' : r[i]])));
}

const readCsv = (file) => parseCsv(fs.readFileSync(file, 'utf8'));

/** Every source row of the per-surface CSVs, by row id. */
function sourceRows(inv) {
  const byId = new Map();
  for (const f of fs.readdirSync(inv).sort()) {
    if (!f.endsWith('.csv') || f.endsWith('.help.csv') || f === 'options.csv' || f === 'lead-routes.csv') continue;
    for (const r of readCsv(path.join(inv, f))) if (r.id) byId.set(r.id, r);
  }
  return byId;
}

function helpFragments(dir) {
  const out = new Map();
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^batch-.*\.json$/.test(f)).sort(); } catch { /* no help yet */ }
  for (const f of files) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { throw new Error(`help fragment ${f}: ${e.message}`); }
    for (const r of (doc && Array.isArray(doc.records) ? doc.records : [])) if (r && r.id) out.set(r.id, r);
  }
  return { map: out, files: files.length };
}

function kindOf(rows) {
  const t = rows.map((r) => r.control_type);
  if (!t.length) return 'setting';
  if (t.every((x) => x === 'opens' || x === 'link')) return 'door';
  if (t.every((x) => x === 'button')) return 'action';
  if (t.every((x) => x === 'indicator')) return 'indicator';
  return 'setting';
}

/** { surface, selector } for one source row, or { surface, none: true } when the row sits in an anchorable file but no literal id is near. */
function anchorFor(repo, code, cache, csvSurface) {
  const m = /^([\w./-]+):(\d+)$/.exec(String(code || '').trim());
  if (!m) return null;
  let surface = SURFACE_BY_FILE[path.basename(m[1])];
  if (!surface || m[1] !== path.basename(m[1])) return null;   // only the pages' own files (repo root)
  if (/simple/i.test(String(csvSurface || '')) && (surface === 'desktop' || surface === 'phone')) surface = 'simple-' + surface;
  let lines = cache.get(m[1]);
  if (!lines) {
    try { lines = fs.readFileSync(path.join(repo, m[1]), 'utf8').split('\n'); } catch { lines = []; }
    cache.set(m[1], lines);
  }
  const n = Number(m[2]) - 1;
  for (let k = 0; k <= 3; k++) {
    const line = lines[n + k];
    if (line === undefined) break;
    const id = ID_RE.exec(line);
    if (id) return { surface, selector: '#' + id[2] };
    // The element's opening tag continues on the next line only while the last "<" on this line has no ">" after it.
    const lt = line.lastIndexOf('<');
    if (lt < 0 || line.indexOf('>', lt) >= 0) break;
  }
  return { surface, none: true };
}

function build(args) {
  const audit = path.resolve(args.audit);
  const options = readCsv(path.join(audit, 'inventory', 'options.csv'));
  const mapping = new Map(readCsv(path.join(audit, 'mapping.csv')).map((r) => [r.option_id, r]));
  const src = sourceRows(path.join(audit, 'inventory'));
  const help = helpFragments(path.resolve(args.help));
  const code = path.resolve(args.code || args.repo);
  const fileCache = new Map();
  const stats = { removed: 0, noSource: [], badRows: 0, helped: 0, unanchoredRows: {}, byId: {}, byLabel: {}, noAnchor: [], whoDefaulted: [], labelOwners: new Map() };
  const bump = (m, k) => { m[k] = (m[k] || 0) + 1; };
  const records = [];

  for (const o of options) {
    const map = mapping.get(o.option_id) || {};
    const action = String(map.action || '');
    if (action === 'remove') { stats.removed++; continue; }
    const rows = String(o.source_ids || '').split('|').map((s) => s.trim()).filter(Boolean).map((id) => src.get(id)).filter(Boolean);
    if (!rows.length) stats.noSource.push(o.option_id);
    const h = help.map.get(o.option_id);
    if (h) stats.helped++;
    const merge = /^merge \(into (OPT-\d+)\)$/.exec(action);
    const labels = [...new Set(rows.map((r) => r.label).filter(Boolean))];
    const who = /^admin/.test(o.who) ? 'admin' : (o.who === 'member' || o.who === 'both' ? o.who : 'admin');
    if (!['admin', 'member', 'both'].includes(o.who) && o.who !== 'admin (owner only)') stats.whoDefaulted.push(o.option_id);

    // Doors and actions get no anchors (a record merged into another shows that one's help, so it does).
    const kind = kindOf(rows);
    const anchors = [];
    if (kind === 'setting' || kind === 'indicator' || merge) {
      for (const r of rows) {
        const a = anchorFor(code, r.code, fileCache, r.surface);
        if (!a) { bump(stats.unanchoredRows, '(no page file)'); continue; }
        if (!a.none) {
          if (!anchors.some((x) => x.surface === a.surface && x.selector === a.selector)) anchors.push(a);
          continue;
        }
        // no literal id on the row: find it by its label instead
        const text = labelAnchorText(r.label);
        if (!text) { bump(stats.unanchoredRows, a.surface); continue; }
        if (!anchors.some((x) => x.surface === a.surface && x.label === text)) anchors.push({ surface: a.surface, label: text });
      }
    }
    // a surface counts once per record: "by id" when it has an id anchor there, else "by label"
    const idSurfaces = new Set(anchors.filter((a) => a.selector).map((a) => a.surface));
    for (const s of idSurfaces) bump(stats.byId, s);
    for (const s of new Set(anchors.filter((a) => a.label && !idSurfaces.has(a.surface)).map((a) => a.surface))) bump(stats.byLabel, s);
    for (const a of anchors) if (a.label) {
      const key = `${a.surface}|${a.label.toLowerCase()}`;
      if (!stats.labelOwners.has(key)) stats.labelOwners.set(key, new Set());
      stats.labelOwners.get(key).add(o.option_id);
    }
    if (!anchors.length) stats.noAnchor.push(o.option_id);

    const rec = {
      id: o.option_id,
      kind,
      name: (h && h.name) || map.new_words || o.name,
      labels: labels.length ? labels : [o.name],
      what: (h && h.what) || '',
      when: (h && h.when) || '',
      risk: (h && h.risk) || '',
      def: (h && h.def) || '',
      restart: h && typeof h.restart === 'boolean' ? h.restart : o.needs_restart === 'yes',
      danger: DANGER[o.danger_class] || 'everyday',
      who,
      lead: LEAD[map.lead_proposed] || 'none',
      words: h && Array.isArray(h.words) ? h.words : [],
      scope: o.scope || '',
      home: map.new_home || '',
      storedAs: o.stored_as || '',
      anchors,
    };
    if (h && h.facts) rec.facts = h.facts;
    if (merge) rec.mergedInto = merge[1];
    records.push(rec);
  }
  records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // no invisible characters in the shipped words: emoji variation selectors and zero-width characters are dropped
  const INVIS = new RegExp('[' + String.fromCharCode(0xFE0E, 0xFE0F, 0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF) + ']', 'g'); const clean = (v) => (typeof v === 'string' ? v.replace(INVIS, '')
    : Array.isArray(v) ? v.map(clean) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)])) : v);
  for (let i = 0; i < records.length; i++) records[i] = clean(records[i]);
  const version = crypto.createHash('sha1').update(JSON.stringify(records)).digest('hex');
  return { doc: { version, records }, stats, helpFiles: help.files };
}

function summary(doc, stats, helpFiles) {
  const kinds = {};
  for (const r of doc.records) kinds[r.kind] = (kinds[r.kind] || 0) + 1;
  const lines = [];
  lines.push(`records: ${doc.records.length} (removed by mapping: ${stats.removed}); merged into another: ${doc.records.filter((r) => r.mergedInto).length}`);
  lines.push(`by kind: ${Object.keys(kinds).sort().map((k) => `${k} ${kinds[k]}`).join(', ')}`);
  lines.push(`help fragments: ${helpFiles} file(s), ${stats.helped} record(s) with help`);
  const surfaces = [...new Set([...Object.keys(stats.byId), ...Object.keys(stats.byLabel), ...Object.keys(stats.unanchoredRows)])].sort();
  lines.push('anchors per surface (records anchored by id / records anchored by label only / source rows of settings and indicators left with none):');
  for (const s of surfaces) lines.push(`  ${s}: ${stats.byId[s] || 0} / ${stats.byLabel[s] || 0} / ${stats.unanchoredRows[s] || 0}`);
  const ambiguous = [...stats.labelOwners].filter(([, v]) => v.size > 1);
  lines.push(`label anchors shared by two or more records (the page skips those): ${ambiguous.length}`);
  lines.push(`records with no anchor at all: ${stats.noAnchor.length} (doors and actions get none by design: ${doc.records.filter((r) => (r.kind === 'door' || r.kind === 'action') && !r.mergedInto).length})`);
  if (stats.noSource.length) lines.push(`records with no source row found: ${stats.noSource.join(' ')}`);
  if (stats.whoDefaulted.length) lines.push(`who missing in options.csv (set to admin): ${stats.whoDefaulted.join(' ')}`);
  lines.push(`unanchored: ${stats.noAnchor.join(' ')}`);
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { doc, stats, helpFiles } = build(args);
  const out = path.resolve(args.repo, args.out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
  console.log(summary(doc, stats, helpFiles));
  console.log(`wrote ${path.relative(path.resolve(args.repo), out)} (version ${doc.version})`);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(`build-settings-records: ${e.message}`); process.exit(1); }
}
module.exports = { parseCsv, kindOf, anchorFor, build };
