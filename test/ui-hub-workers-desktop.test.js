'use strict';
// The desktop Workers list (app.js) with hub-wide rows: the status patch keeps keys the feed lacks, a worker gone from a
// full feed is dropped, the poll rests while the page is hidden, one hub-row lookup at a time that never takes the screen,
// keyboard focus on hub rows, and the Workers-at-once setting never deletes a saved value for a bad input.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function extract(name) {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} present`);
  let p = src.indexOf('(', at); let pd = 0;
  for (; p < src.length; p++) { if (src[p] === '(') pd++; else if (src[p] === ')' && --pd === 0) break; }
  let i = src.indexOf('{', p); let depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(at, i + 1);
}

function page() {
  const body = `const agentStatus = {}; let statusKnown = false;
    const paintAgentStatus = () => {}, paintAgentsWorking = () => {}, paintAllAgentStatus = () => {}, reattachIfIdle = () => {};
    const busyIsWorker = (name, e) => e && typeof e.worker === 'boolean' ? e.worker : /^tw-/.test(name);
    ${extract('setAgentLive')}
    ${extract('statusPatchOf')}
    ${extract('applyStatusSnapshot')}
    return { agentStatus, applyStatusSnapshot };`;
  return new Function(body)();
}

test('a named-only refresh never wipes consultedBy or drops workers; a full feed drops a gone worker', () => {
  const { agentStatus, applyStatusSnapshot } = page();
  applyStatusSnapshot({ lead: { busy: true, consultedBy: 'helper' }, 'tw-lead-1-aa': { busy: true, worker: true, parent: 'lead', label: 'job', model: 'm' } });
  assert.strictEqual(agentStatus.lead.consultedBy, 'helper');
  applyStatusSnapshot({ lead: { busy: true } }, { namedOnly: true });
  assert.strictEqual(agentStatus.lead.consultedBy, 'helper');
  assert.ok(agentStatus['tw-lead-1-aa'], 'worker kept');
  applyStatusSnapshot({ lead: { busy: true, consultedBy: 'helper' } });
  assert.ok(!('tw-lead-1-aa' in agentStatus), 'worker gone from the full feed is deleted, not idle');
  applyStatusSnapshot({ lead: { busy: false } });
  assert.strictEqual(agentStatus.lead.consultedBy, null, 'idle clears consultedBy');
  applyStatusSnapshot({});
  assert.ok(agentStatus.lead && agentStatus.lead.busy === false, 'a named agent missing from the feed goes idle');
});

test('a full feed is the whole truth: an agent consulted, then busy with its own turn, loses consultedBy', () => {
  const { agentStatus, applyStatusSnapshot } = page();
  applyStatusSnapshot({ helper: { busy: true, consultedBy: 'lead' } });
  assert.strictEqual(agentStatus.helper.consultedBy, 'lead');
  applyStatusSnapshot({ helper: { busy: true } });
  assert.strictEqual(agentStatus.helper.consultedBy, null, 'a later full snapshot without consultedBy clears it');
  assert.strictEqual(agentStatus.helper.busy, true);
});

test('GET /api/agents gives a member the same redacted status as /api/agents/status', () => {
  const server = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  const at = server.indexOf("pathname === '/api/agents' && req.method === 'GET'");
  assert.ok(at > 0);
  const route = server.slice(at, server.indexOf('return jsonResponse', at));
  assert.match(route, /access\.statusForViewer\(req\.hubUser, status,/);
});

test('the worker poll rests while hidden, polls once on return, and opening the menu polls and repaints', () => {
  assert.ok(src.includes('setInterval(() => { if (!document.hidden && workerPollWanted()) pollWorkerStatus(); }, 5000);'));
  assert.ok(src.includes("document.addEventListener('visibilitychange', () => { if (!document.hidden && workerPollWanted()) pollWorkerStatus(); });"));
  assert.ok(src.includes('pollWorkerStatus().then(() => { if (!menu.hidden) renderWorkersMenu('));
});

test('openHubWorker: one lookup at a time, stops when the chat on screen is no longer the parent', () => {
  const fn = extract('openHubWorker');
  assert.ok(src.includes('let hubOpenSeq = 0'));
  assert.ok(fn.includes('++hubOpenSeq') && fn.includes('clearInterval(hubOpenTimer)'));
  assert.ok(fn.includes('findSoloChat(group.parent)?.id'));
  assert.ok(fn.includes('seq !== hubOpenSeq') && fn.includes('activeChat !== parentChatId'));
});

test('renderWorkersMenu keeps keyboard focus on a hub row by data-hubid', () => {
  const fn = extract('renderWorkersMenu');
  assert.ok(fn.includes("closest('.wm-hub')?.dataset.hubid"));
  assert.ok(fn.includes('.wm-hub[data-hubid='));
});

test('workersAtOnceFromPage: a blank, non-integer or out-of-range input keeps the saved value and is flagged', () => {
  const body = `let waoStored = { openai: 8, google: 6 };
    const WAO_LABELS = { openai: 'OpenAI API' };
    const alerts = [];
    const alert = (m) => alerts.push(m);
    const mk = (provider, value, dflt) => ({ value, dataset: { provider, default: String(dflt) }, valid: '', setCustomValidity(m) { this.valid = m; }, reportValidity() { this.reported = true; } });
    const inputs = [mk('openai', '', 4), mk('google', '5', 4), mk('ollama', '3', 1)];
    const box = { dataset: { loaded: '1' }, querySelectorAll: () => inputs };
    const document = { getElementById: () => box };
    ${extract('workersAtOnceFromPage')}
    const out = workersAtOnceFromPage();
    inputs[1].value = '4'; inputs[2].value = '99';
    const out2 = workersAtOnceFromPage();
    return { out, out2, alerts, inputs };`;
  const r = new Function(body)();
  assert.deepStrictEqual(r.out, { openai: 8, google: 5, ollama: 3 }, 'blank keeps the saved 8');
  assert.strictEqual(r.inputs[0].valid, '1 to 32');
  assert.ok(r.inputs[0].reported);
  assert.deepStrictEqual(r.out2, { openai: 8 }, 'equal to default removes the key; 99 for ollama keeps (nothing saved)');
  assert.strictEqual(r.inputs[2].valid, '1 to 32');
  assert.strictEqual(r.alerts[0], 'Workers at once: OpenAI API must be a whole number from 1 to 32; the previous value is kept.');
});
