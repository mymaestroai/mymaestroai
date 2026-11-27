#!/usr/bin/env node
'use strict';
// Builds templates/settings-records.json (the one record of every setting, indicator, door and action) from the
// configuration audit and the written help. The inputs live outside the repo, so their folders are arguments:
//
//   node scripts/build-settings-records.js --audit <config-audit dir> --help <help out dir> --repo <repo root> --out templates/settings-records.json [--overrides <file>]
//
// --overrides names a JSON file of corrections the audit got wrong: { "OPT-0341": { "who": "admin", "reason": "…file:line…" } };
// allowed keys who, danger, lead, anchors (replaces the list), home, scope, applyOk (true: a record with lead "apply" may keep risk
// words the apply check would refuse), what, when, risk, def, facts (a corrected sentence: say what the person does instead of
// "edit the file") and a required one-line reason. The build also fails when a secret record (isSecretKey) is not lead screen and
// dangerous, or a device record (localStorage) has lead apply or confirm. An unknown id or key fails. A key "+OPT-1082" ADDS a record the
// audit does not have: it needs every field of a record (ADD_FIELDS) and a reason; a missing field or an id that already exists fails.
// After the corrections: "Needs you" becomes "For your review" in every home, an alias takes the strictest who, danger and lead of
// itself and its target, and the build fails on a selector used by two records on a surface, on an install-wide record that
// members keep without being in MEMBER_INSTALL, and on danger/lead combinations the loader refuses.
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

// The group name the owner chose for the things that wait for a person's decision (the audit still says "Needs you").
const HOME_RENAMES = [[/Needs you/g, 'For your review']];
const DANGER_RANK = { everyday: 0, care: 1, dangerous: 2 };
const LEAD_RANK = { apply: 0, confirm: 1, screen: 2, none: 3 };
const OVERRIDE_KEYS = ['who', 'danger', 'lead', 'leadAgentAccess', 'anchors', 'home', 'scope', 'applyOk', 'name', 'what', 'when', 'risk', 'def', 'facts', 'labels', 'storedAs', 'reason'];
const TEXT_KEYS = ['name', 'what', 'when', 'risk', 'def', 'facts'];   // name: a record the audit merged into another option has only its key as a name   // corrected help text (a stale sentence); a non-empty string
// Every field a record added by an override must carry (facts and mergedInto are optional).
const ADD_FIELDS = ['kind', 'name', 'labels', 'what', 'when', 'risk', 'def', 'restart', 'danger', 'who', 'lead', 'words', 'scope', 'home', 'storedAs', 'anchors'];
// A record whose lead applies the change at once (and offers an undo) may not carry risk words that say it grants access, sends data
// out, costs money (or more plan or money) or downloads, builds or installs software: those need a confirm card. An override
// { "applyOk": true, "reason": … } states that the match is harmless.
const APPLY_RISK_RE = /costs? money|per use|are sent|sent there|can (see|read|hear|download|use)|who can|recipients|address|cost more|costs more|plan or money|more runs|spend|download|install|build|update the software/i;

const journal = require('../lib/settings-journal.js');
// A record that holds a secret (by the journal's isSecretKey, on any of its storedAs keys) is screen-only and dangerous: the lead
// never handles keys. A record on this list matches the secret words by name only; the reason says why it is not one.
const SECRET_OK = {
  'OPT-0999': 'a yes/no environment switch whose name says "keys" (HUB_KEEP_ENV_KEYS, lib/settings.js:149); it holds no secret',
};
// A secret record that a member meets cannot be "dangerous" (the loader refuses dangerous unless who is admin): lead screen still holds.
const SECRET_DANGER_OK = {
  'OPT-0151': 'a member changes their own password (app.js:760); dangerous needs who admin, so it stays care with lead screen',
};

/** The keys a record is stored under: each part of storedAs without its trailing note, and without a leading "settings.". */
function storedKeys(r) {
  return String(r.storedAs || '').split('|').map((p) => p.trim().replace(/\s*\(.*$/, '').replace(/^settings\./, '')).filter(Boolean);
}
/** A device record keeps its value in the browser (the first storedAs part is localStorage): the lead cannot reach it. */
function isDeviceRecord(r) { return /^localStorage\b/.test(String(r.storedAs || '').trim()); }
/** True when the record holds a secret by the journal's rule (a device record is judged by what the browser keeps, not by key names). */
function isSecretRecord(r) {
  if (isDeviceRecord(r)) return false;
  return storedKeys(r).some((k) => journal.isSecretKey(k, r));
}

// Install-wide records that stay visible to members, with the reason each one is. An install-wide record that is
// not "admin" and not in this list fails the build: a member must really meet that control or indicator.
const MEMBER_INSTALL = {
  'OPT-0306': 'Shared links: a member lists and revokes the share links of their own files (files-shared-btn, app.js:1677; /api/share-links is a session route, lib/access.js:52)',
  'OPT-0749': 'the upload limit text sits beside Shared links in the Files panel every signed-in person opens (files-limit, app.js:1678); it shows the install-wide limit and nothing can be changed there',
  'OPT-0790': 'the Help page is open to every signed-in person (lib/access.js:82 classifies every page not in ADMIN_PAGES as a session page)',
  'OPT-0804': 'the Recordings link (menu-recordings, mobile.html:1722) is shown to anyone on a recording list; /api/recordings is a session route (lib/access.js:50)',
  'OPT-1067': 'the "?" Help button in the desktop header (index.html:3839) is not in the member-view hide list (app.js:659-661)',
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    out[a.slice(2)] = argv[++i];
  }
  for (const k of ['audit', 'help', 'repo', 'out']) if (!out[k]) throw new Error(`missing --${k}`);
  // --overrides <file>: corrections to the audit's columns, kept in one file with a reason each (see applyOverrides)
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

/** The corrections file: { "OPT-0341": { who, danger, lead, anchors, home, reason }, ... }. Every entry needs a reason. */
function readOverrides(file) {
  if (!file) return {};
  let doc;
  try { doc = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); } catch (e) { throw new Error(`overrides ${file}: ${e.message}`); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('overrides: the file must hold an object { "OPT-0001": { ... } }');
  return doc;
}

const SELECTOR_OK = /^(#[A-Za-z][\w:.-]*|\[data-setting="OPT-\d{4,}"\])$/;

/** Applies the corrections to the built records (by id); an unknown id or key, a missing reason or a bad value fails the build. */
function applyOverrides(records, overrides, applyOk = new Set()) {
  const byId = new Map(records.map((r) => [r.id, r]));
  const used = [];
  // Records the audit does not have: "+OPT-1082": { every field, reason }
  for (const [key, o] of Object.entries(overrides)) {
    if (!key.startsWith('+')) continue;
    const id = key.slice(1);
    if (!/^OPT-\d{4,}$/.test(id)) throw new Error(`overrides: ${key} is not a record id with a leading +`);
    if (byId.has(id)) throw new Error(`overrides: ${key} adds a record, but ${id} already exists`);
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(`overrides: ${key} must be an object`);
    if (typeof o.reason !== 'string' || !o.reason.trim() || /\n/.test(o.reason)) throw new Error(`overrides: ${key} needs a one-line reason`);
    const missing = ADD_FIELDS.filter((f) => o[f] === undefined);
    if (missing.length) throw new Error(`overrides: ${key} is missing ${missing.join(', ')}`);
    for (const k of Object.keys(o)) if (k !== 'reason' && k !== 'facts' && !ADD_FIELDS.includes(k)) throw new Error(`overrides: ${key} has an unknown key "${k}"`);
    const { reason: _reason, ...fields } = o;
    const rec = { id, ...fields };
    records.push(rec);
    byId.set(id, rec);
    used.push(id);
  }
  records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const [id, o] of Object.entries(overrides)) {
    if (id.startsWith('+')) continue;
    const r = byId.get(id);
    if (!r) throw new Error(`overrides: ${id} is not a record`);
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(`overrides: ${id} must be an object`);
    for (const k of Object.keys(o)) if (!OVERRIDE_KEYS.includes(k)) throw new Error(`overrides: ${id} has an unknown key "${k}" (allowed: ${OVERRIDE_KEYS.join(', ')})`);
    if (typeof o.reason !== 'string' || !o.reason.trim() || /\n/.test(o.reason)) throw new Error(`overrides: ${id} needs a one-line reason`);
    if (Object.keys(o).length < 2) throw new Error(`overrides: ${id} changes nothing`);
    if (o.who !== undefined) { if (!['admin', 'member', 'both'].includes(o.who)) throw new Error(`overrides: ${id} who ${JSON.stringify(o.who)}`); r.who = o.who; }
    if (o.danger !== undefined) { if (!(o.danger in DANGER_RANK)) throw new Error(`overrides: ${id} danger ${JSON.stringify(o.danger)}`); r.danger = o.danger; }
    if (o.lead !== undefined) { if (!(o.lead in LEAD_RANK)) throw new Error(`overrides: ${id} lead ${JSON.stringify(o.lead)}`); r.lead = o.lead; }
    for (const k of TEXT_KEYS) if (o[k] !== undefined) { if (typeof o[k] !== 'string' || !o[k].trim()) throw new Error(`overrides: ${id} ${k} must be a non-empty string`); r[k] = o[k]; }
    if (o.home !== undefined) { if (typeof o.home !== 'string' || !o.home.trim()) throw new Error(`overrides: ${id} home`); r.home = o.home; }
    if (o.scope !== undefined) { if (typeof o.scope !== 'string' || !o.scope.trim()) throw new Error(`overrides: ${id} scope`); r.scope = o.scope; }
    // labels: the words the row shows on screen (a list of non-empty strings); storedAs: where the value lives ("none" when it is not stored)
    if (o.labels !== undefined) {
      if (!Array.isArray(o.labels) || !o.labels.length || o.labels.some((l) => typeof l !== 'string' || !l.trim())) throw new Error(`overrides: ${id} labels must be a list of non-empty strings`);
      r.labels = o.labels.slice();
    }
    if (o.storedAs !== undefined) { if (typeof o.storedAs !== 'string' || !o.storedAs.trim()) throw new Error(`overrides: ${id} storedAs must be a non-empty string`); r.storedAs = o.storedAs; }
    // leadAgentAccess: a per-agent Access row the lead may change (always a card, never at once); the record must say lead confirm
    if (o.leadAgentAccess !== undefined) {
      if (o.leadAgentAccess !== true) throw new Error(`overrides: ${id} leadAgentAccess must be true`);
      if (r.lead !== 'confirm') throw new Error(`overrides: ${id} leadAgentAccess needs lead confirm`);
      r.leadAgentAccess = true;
    }
    if (o.applyOk !== undefined) { if (o.applyOk !== true) throw new Error(`overrides: ${id} applyOk must be true`); applyOk.add(id); }
    if (o.anchors !== undefined) {
      if (!Array.isArray(o.anchors)) throw new Error(`overrides: ${id} anchors must be a list`);
      for (const a of o.anchors) {
        const ok = a && typeof a === 'object' && typeof a.surface === 'string'
          && ((a.selector !== undefined) !== (a.label !== undefined))
          && (a.selector !== undefined ? SELECTOR_OK.test(String(a.selector)) : typeof a.label === 'string' && a.label.trim());
        if (!ok) throw new Error(`overrides: ${id} has a malformed anchor ${JSON.stringify(a)}`);
      }
      r.anchors = o.anchors.map((a) => ({ ...a }));
    }
    used.push(id);
  }
  return used;
}

/** An alias takes the strictest who (admin wins), danger and lead of itself and the record it is merged into. */
function harmoniseAliases(records) {
  const byId = new Map(records.map((r) => [r.id, r]));
  const rootOf = (r) => { const seen = new Set(); let x = r; while (x.mergedInto && !seen.has(x.id)) { seen.add(x.id); x = byId.get(x.mergedInto) || x; } return x; };
  for (let pass = 0; pass < 3; pass++) {   // chains are short; three passes settle them
    for (const r of records) {
      if (!r.mergedInto) continue;
      const t = byId.get(r.mergedInto);
      if (!t) continue;
      if (t.who === 'admin') r.who = 'admin';
      if (DANGER_RANK[t.danger] > DANGER_RANK[r.danger]) r.danger = t.danger;
      // "none" means the lead has no part in this control at all: it is not compared (an alias that is a plain door keeps its own)
      if (t.lead !== 'none' && r.lead !== 'none' && LEAD_RANK[t.lead] > LEAD_RANK[r.lead]) r.lead = t.lead;
    }
  }
  return rootOf;
}

/** No selector may belong to two records on one surface. Records that share help (an alias and what it is merged into) may
 *  share a selector: it stays on the target (or the first of them) and is dropped from the aliases. Returns the conflicts left. */
function dedupeSelectors(records, rootOf) {
  const owners = new Map();   // surface|selector -> [records]
  for (const r of records) for (const a of r.anchors) if (a.selector) {
    const k = `${a.surface}|${a.selector}`;
    if (!owners.has(k)) owners.set(k, []);
    if (!owners.get(k).includes(r)) owners.get(k).push(r);
  }
  const conflicts = [];
  for (const [k, list] of owners) {
    if (list.length < 2) continue;
    const roots = new Set(list.map((r) => rootOf(r).id));
    if (roots.size > 1) { conflicts.push(`${k}: ${list.map((r) => r.id).join(' ')}`); continue; }
    const keep = list.find((r) => !r.mergedInto) || list[0];
    const [surface, selector] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)];
    for (const r of list) if (r !== keep) r.anchors = r.anchors.filter((a) => !(a.surface === surface && a.selector === selector));
  }
  return conflicts;
}

/** The checks every build must pass; throws one error naming everything wrong. */
function checkRecords(records, conflicts, applyOk = new Set()) {
  const bad = [...conflicts.map((c) => `selector used by two records: ${c}`)];
  const byId = new Map(records.map((r) => [r.id, r]));
  for (const r of records) {
    if (r.lead === 'apply' && APPLY_RISK_RE.test(r.risk || '') && !applyOk.has(r.id)) bad.push(`${r.id}: lead apply, but its risk text says it grants access, sends data out or costs money (${APPLY_RISK_RE.exec(r.risk)[0]}); use confirm, or an override with applyOk and a reason`);
    if (isSecretRecord(r) && !SECRET_OK[r.id]) {
      if (r.lead !== 'screen') bad.push(`${r.id}: holds a secret (${storedKeys(r).join(' | ')}) but lead is ${r.lead}; the lead never handles keys: screen`);
      if (r.danger !== 'dangerous' && !SECRET_DANGER_OK[r.id]) bad.push(`${r.id}: holds a secret (${storedKeys(r).join(' | ')}) but danger is ${r.danger}; use dangerous`);
    }
    if (isDeviceRecord(r) && r.lead !== 'none' && r.lead !== 'screen') bad.push(`${r.id}: stored on the device (${r.storedAs.slice(0, 40)}) but lead is ${r.lead}; the lead cannot reach a device's storage: none`);
    if (/Needs you/.test(r.home)) bad.push(`${r.id}: home "${r.home}" still says "Needs you"`);
    if (r.danger === 'dangerous' && r.who !== 'admin') bad.push(`${r.id}: dangerous but who is ${r.who}`);
    if (r.danger === 'dangerous' && r.lead === 'apply') bad.push(`${r.id}: dangerous with lead apply`);
    if (/(^|[^a-z])install([^a-z]|$)/.test(r.scope) && r.who !== 'admin' && !MEMBER_INSTALL[r.id]) bad.push(`${r.id}: install-wide (${r.scope}) and who ${r.who}, but not in MEMBER_INSTALL`);
    if (r.mergedInto && byId.get(r.mergedInto) && byId.get(r.mergedInto).who === 'admin' && r.who !== 'admin') bad.push(`${r.id}: merged into an admin record but who is ${r.who}`);
  }
  for (const id of Object.keys(MEMBER_INSTALL)) { const r = byId.get(id); if (!r) bad.push(`MEMBER_INSTALL names ${id}, which is not a record`); else if (r.who === 'admin') bad.push(`MEMBER_INSTALL lists ${id}, but its who is admin`); }
  if (bad.length) throw new Error(`${bad.length} problem(s):\n  ${bad.slice(0, 600).join('\n  ')}${bad.length > 600 ? `\n  … and ${bad.length - 600} more` : ''}`);
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
  const applyOk = new Set();
  const overridden = applyOverrides(records, readOverrides(args.overrides), applyOk);
  for (const r of records) for (const [re, to] of HOME_RENAMES) r.home = r.home.replace(re, to);
  const rootOf = harmoniseAliases(records);
  const conflicts = dedupeSelectors(records, rootOf);
  checkRecords(records, conflicts, applyOk);
  stats.overridden = overridden.length;
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
  const whoCount = {};
  for (const r of doc.records) whoCount[r.who] = (whoCount[r.who] || 0) + 1;
  lines.push(`who: ${Object.keys(whoCount).sort().map((k) => `${k} ${whoCount[k]}`).join(', ')}; overrides applied: ${stats.overridden || 0}`);
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
module.exports = { parseCsv, kindOf, anchorFor, build, MEMBER_INSTALL, APPLY_RISK_RE, SECRET_OK, SECRET_DANGER_OK, isSecretRecord, isDeviceRecord };
