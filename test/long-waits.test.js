'use strict';
// Long waits on workers (lib/long-waits): the record file, the two settings, the evidence rules and the lead's notice line.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lw = require('../lib/long-waits');

const dirs = [];
const tmpFile = () => { const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'long-waits-t-')); dirs.push(d); return path.join(d, 'long-waits.jsonl'); };
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

const NOW = Date.parse('2026-03-10T12:00:00Z');
const H = 3600000;
const D = 24 * H;
const iso = (ms) => new Date(ms).toISOString();

function fill(file, rows) { fs.writeFileSync(file, rows.map((r) => JSON.stringify({ at: iso(r.at), agent: r.agent, tool: r.tool || 'spawn_workers', minutes: r.minutes })).join('\n') + '\n'); }

test('record: one JSON line, mode 0600, appended', () => {
  const f = tmpFile();
  assert.strictEqual(lw.record({ agent: 'sam', tool: 'spawn_workers', minutes: 12, at: NOW }, { file: f }), true);
  assert.strictEqual(lw.record({ agent: 'sam', tool: 'consult_agent', minutes: 15, at: NOW + 1000 }, { file: f }), true);
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 2);
  assert.deepStrictEqual(JSON.parse(lines[0]), { at: '2026-03-10T12:00:00.000Z', agent: 'sam', tool: 'spawn_workers', minutes: 12 });
  assert.strictEqual(JSON.parse(lines[1]).tool, 'consult_agent');
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
});

test('record: past 2000 lines the file keeps only the last 30 days', () => {
  const f = tmpFile();
  const old = [], recent = [];
  const now = Date.now();
  for (let i = 0; i < 1500; i++) old.push({ at: now - 40 * D, agent: 'sam', minutes: 11 });
  for (let i = 0; i < 500; i++) recent.push({ at: now - 2 * D, agent: 'sam', minutes: 11 });
  fill(f, [...old, ...recent]);
  assert.strictEqual(fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length, 2000, 'exactly at the limit: untouched');
  lw.record({ agent: 'sam', tool: 'spawn_workers', minutes: 20, at: now }, { file: f });
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 501, '500 recent + the new one');
  assert.ok(lines.every((l) => Date.parse(JSON.parse(l).at) >= now - 30 * D));
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(f)), ['long-waits.jsonl'], 'no temp file left behind');
});

test('record: never throws', () => {
  const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'long-waits-t-')); dirs.push(d);
  assert.strictEqual(lw.record({ agent: 'sam', minutes: 5 }, { file: d }), false, 'a folder in place of the file');
});

test('thresholdMinutes: default 10, 0 or junk off, clamped 1..240', () => {
  const g = (v) => (k, d) => (k === 'handOffWaitMinutes' ? (v === undefined ? d : v) : d);
  assert.strictEqual(lw.thresholdMinutes(g(undefined)), 10);
  assert.strictEqual(lw.thresholdMinutes(g(25)), 25);
  assert.strictEqual(lw.thresholdMinutes(g(0)), 0);
  assert.strictEqual(lw.thresholdMinutes(g(-5)), 0);
  assert.strictEqual(lw.thresholdMinutes(g('20')), 0, 'a non-number is off');
  assert.strictEqual(lw.thresholdMinutes(g(NaN)), 0);
  assert.strictEqual(lw.thresholdMinutes(g(0.2)), 1);
  assert.strictEqual(lw.thresholdMinutes(g(9999)), 240);
  assert.strictEqual(lw.thresholdMinutes(() => { throw new Error('x'); }), 10);
});

test('cleanMinutes: integers 0..240, junk is the default', () => {
  assert.strictEqual(lw.cleanMinutes(15), 15);
  assert.strictEqual(lw.cleanMinutes('30'), 30);
  assert.strictEqual(lw.cleanMinutes(0), 0);
  assert.strictEqual(lw.cleanMinutes(-3), 0);
  assert.strictEqual(lw.cleanMinutes(500), 240);
  assert.strictEqual(lw.cleanMinutes(7.6), 8);
  for (const junk of [null, NaN, 'abc', '', {}, [], true]) assert.strictEqual(lw.cleanMinutes(junk), 10);
});

test('noticeOn: on unless explicitly false', () => {
  const g = (v) => (k, d) => (k === 'buildPartnerNotice' ? (v === undefined ? d : v) : d);
  assert.strictEqual(lw.noticeOn(g(undefined)), true);
  assert.strictEqual(lw.noticeOn(g(true)), true);
  assert.strictEqual(lw.noticeOn(g(false)), false);
  assert.strictEqual(lw.noticeOn(g(0)), true);
  assert.strictEqual(lw.noticeOn(g('no')), true);
});

const agents = [
  { name: 'sam', category: 'primary' },
  { name: 'ana', category: 'primary' },
  { name: 'lead', category: 'primary' },
  { name: 'helper', category: 'worker' },
  { name: 'partnered', category: 'primary', buildPartner: 'builder' },
  { name: 'builder', category: 'specialist' },
  { name: 'orphaned', category: 'primary', buildPartner: 'gone' },
  { name: 'virt', category: 'primary' },
];
const isLead = (n) => n === 'lead';
const isVirtual = (n) => n === 'virt';
const ev = (file, over = {}) => lw.evidence({ file, now: NOW, agents, isLead, isVirtual, ...over });

test('evidence: window, minCount, grouping and order', () => {
  const f = tmpFile();
  fill(f, [
    { at: NOW - 1 * D, agent: 'sam', minutes: 12 }, { at: NOW - 3 * D, agent: 'sam', minutes: 30 }, { at: NOW - 3 * D + H, agent: 'sam', minutes: 11 },
    { at: NOW - 2 * D, agent: 'ana', minutes: 14 }, { at: NOW - 5 * D, agent: 'ana', minutes: 16 },
    { at: NOW - 6 * D, agent: 'builder', minutes: 10 },
    { at: NOW - 8 * D, agent: 'orphaned', minutes: 50 },   // outside the 7 days
    { at: NOW - 1 * D, agent: 'orphaned', minutes: 10 },   // one inside: below minCount
  ]);
  const out = ev(f);
  assert.deepStrictEqual(out.map((e) => e.agent), ['sam', 'ana'], 'count desc, single waits dropped');
  assert.strictEqual(out[0].count, 3);
  assert.strictEqual(out[0].totalMinutes, 53);
  assert.strictEqual(out[0].longest, 30);
  assert.deepStrictEqual(out[0].dates, ['2026-03-07', '2026-03-09'], 'distinct, oldest first');
  assert.strictEqual(out[1].count, 2);
  assert.deepStrictEqual(ev(f, { minCount: 3 }).map((e) => e.agent), ['sam']);
  assert.deepStrictEqual(ev(f, { hours: 48 }).map((e) => e.agent), [], 'a narrower window');
  assert.deepStrictEqual(ev(tmpFile()), [], 'no file');
  // equal counts sort by name
  const g = tmpFile();
  fill(g, [{ at: NOW - D, agent: 'sam', minutes: 10 }, { at: NOW - 2 * D, agent: 'sam', minutes: 10 }, { at: NOW - D, agent: 'ana', minutes: 10 }, { at: NOW - 2 * D, agent: 'ana', minutes: 10 }]);
  assert.deepStrictEqual(ev(g).map((e) => e.agent), ['ana', 'sam']);
});

test('evidence: leads, temporary workers, worker-category agents, agents with a build partner and unknown agents are left out', () => {
  const f = tmpFile();
  const two = (agent) => [{ at: NOW - D, agent, minutes: 12 }, { at: NOW - 2 * D, agent, minutes: 12 }];
  fill(f, [
    ...two('lead'), ...two('tw-sam-1-ab12'), ...two('virt'), ...two('helper'), ...two('partnered'), ...two('nobody'),
    ...two('orphaned'),   // its build partner names no existing agent: counts as none
    ...two('sam'),
  ]);
  assert.deepStrictEqual(ev(f).map((e) => e.agent), ['orphaned', 'sam']);
  // tw- names are dropped even when the record exists and no isVirtual is given
  const withTw = [...agents, { name: 'tw-sam-1-ab12', category: 'primary' }];
  assert.ok(!lw.evidence({ file: f, now: NOW, agents: withTw, isLead }).some((e) => e.agent.startsWith('tw-')));
});

test('evidence: dates in a zone', () => {
  const f = tmpFile();
  // 03:30 UTC on the 9th is still the 8th in New York; 23:30 UTC on the 8th is the 8th in both
  fill(f, [{ at: Date.parse('2026-03-09T03:30:00Z'), agent: 'sam', minutes: 12 }, { at: Date.parse('2026-03-08T23:30:00Z'), agent: 'sam', minutes: 12 }]);
  assert.deepStrictEqual(ev(f)[0].dates, ['2026-03-08', '2026-03-09']);
  assert.deepStrictEqual(ev(f, { zone: 'America/New_York' })[0].dates, ['2026-03-08']);
});

test('noticeLine: empty, one agent, and at most three agents', () => {
  assert.strictEqual(lw.noticeLine([]), '');
  assert.strictEqual(lw.noticeLine(undefined), '');
  const one = { agent: 'sam', count: 3, totalMinutes: 53, longest: 30, dates: ['2026-03-07', '2026-03-09'] };
  assert.strictEqual(lw.noticeLine([one]),
    '- Build partners: sam waited 3 times on workers this week (longest 30 min, on 2026-03-07, 2026-03-09) and has no build partner. Offer the owner a build partner for long work (hand_off), with this evidence, when it is relevant; create nothing without their yes.');
  const many = ['a', 'b', 'c', 'd', 'e'].map((agent) => ({ ...one, agent }));
  const text = lw.noticeLine(many);
  assert.match(text, /^- Build partners: a waited 3 times .*; b waited 3 times .*; c waited 3 times .* and has no build partner\. Offer the owner/);
  assert.doesNotMatch(text, /\bd waited|\be waited/);
  assert.strictEqual(text.split('\n').length, 1);
});

test('settings: the two keys are cleaned in the settings route and have a row in the Settings page', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  // the route's cleaners moved from server.js into lib/settings-apply cleanSettingsPatch, which the route calls
  const applySrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'settings-apply.js'), 'utf8');
  assert.match(server, /require\('\.\/lib\/settings-apply'\)\.cleanSettingsPatch\(patch,/);
  assert.match(applySrc, /patch\.handOffWaitMinutes !== undefined\) patch\.handOffWaitMinutes = require\('\.\/long-waits'\)\.cleanMinutes\(patch\.handOffWaitMinutes\)/);
  assert.match(applySrc, /patch\.buildPartnerNotice !== undefined\) patch\.buildPartnerNotice = patch\.buildPartnerNotice !== false/);
  assert.match(app, /<label>Notice long waits on workers<\/label>/);
  assert.match(app, /id="st-hw-minutes"[^>]*min="0" max="240"/);
  assert.match(app, /id="st-hw-notice" \$\{data\.buildPartnerNotice !== false \? 'checked' : ''\}> <span>Tell the lead when an agent has no build partner/);   // the words in a span beside the box (one line)
  assert.match(app, /patch\.handOffWaitMinutes = parseInt\(hwMin\.value, 10\)/);
  assert.match(app, /patch\.buildPartnerNotice = !!hwNotice\.checked/);
  // the defaults: 10 minutes, notice on
  assert.strictEqual(lw.thresholdMinutes((k, d) => d), 10);
  assert.strictEqual(lw.noticeOn((k, d) => d), true);
});
