'use strict';
// The 📅 panel is the one place for scheduled tasks AND background jobs (run_job): no ⚙ button.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function loadPanel() {
  const a = app.indexOf('    // ── Job pool:'); const b = app.indexOf('    async function openWalletPanel');
  assert.ok(a > 0 && b > a, 'job pool + scheduler block found');
  const els = {}; const modals = []; const btn = { textContent: '', title: '', classList: { on: null, toggle(c, v) { this.on = v; } } };
  const document = { getElementById: (id) => id === 'schedule-btn' ? btn : (els[id] || null) };
  const soon = new Date(Date.now() + 20 * 60000).toISOString();
  const fetch = async (url) => ({ ok: true, json: async () => url.startsWith('/api/jobs')
    ? { mode: 'systemd', jobs: [{ id: 'job-1', name: 'backtest-hype', owner: 'trader', status: 'running', runningFor: '3m', startedAt: soon }, { id: 'job-2', name: 'old', owner: 'worker', status: 'finished', exitCode: 0 }] }
    : url.startsWith('/api/agents') ? { agents: [{ name: 'trader' }] }
    : { tz: 'America/New_York', limits: { perAgent: 25, minIntervalMinutes: 15 }, runs: [], tasksMd: [], tasksMdRuns: [],
        tasks: [{ id: 'st-1', label: 'follow up', agent: 'trader', createdBy: 'owner', schedule: 'once', status: 'active', nextRunAt: soon, nextRunLocal: 'soon' }] } });
  const gsModal = (h) => { modals.push(h); els['sched-tables'] = {}; els['sched-jobs'] = {}; };
  const timers = { setInterval: () => 0, setTimeout: () => 0, clearInterval() {} };
  const api = new Function('document', 'fetch', 'gsModal', 'setInterval', 'setTimeout', 'clearInterval', 'confirm',
    app.slice(a, b) + '\nreturn { openSchedulePanel, openJobsPanel, refreshScheduleBadge, refreshJobsBadge };')(
    document, fetch, gsModal, timers.setInterval, timers.setTimeout, timers.clearInterval, () => true);
  return { api, modals, btn };
}

test('index.html has only the 📅 button, no ⚙ job pool button', () => {
  assert.doesNotMatch(html, /id="jobs-btn"/);
  assert.match(html, /id="schedule-btn"[^>]*onclick="openSchedulePanel\(\)">📅<\/button>/);
});

test('the 📅 panel shows scheduled tasks and background jobs with Log/Cancel', async () => {
  const { api, modals } = loadPanel();
  await api.openSchedulePanel();
  const h = modals.at(-1);
  assert.match(h, /Scheduled tasks/);
  assert.match(h, /<div id="sched-jobs">[\s\S]*Background jobs[\s\S]*backtest-hype[\s\S]*jobsAct\('log', 'job-1'\)[\s\S]*jobsAct\('cancel', 'job-1'\)/);
  assert.doesNotMatch(h, /jobsAct\('cancel', 'job-2'\)/, 'finished jobs have no Cancel');
  await api.openJobsPanel();   // old entry point opens the same panel
  assert.match(modals.at(-1), /id="sched-panel"/);
});

test('the 📅 badge counts running jobs plus tasks due within the hour', async () => {
  const { api, btn } = loadPanel();
  await api.refreshJobsBadge();
  assert.strictEqual(btn.textContent, '📅 2');
  assert.match(btn.title, /1 active task, 1 due within the hour; 1 background job running/);
  assert.strictEqual(btn.classList.on, true);
});
