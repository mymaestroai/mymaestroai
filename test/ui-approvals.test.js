'use strict';
// Source-level checks for the action-approval cards, tool policy settings and spend readout
// (desktop app.js / index.html, mobile mobile.js / mobile.html, agent-settings.html). Offline.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const app = read('app.js');
const html = read('index.html');
const mobile = read('mobile.js');
const mhtml = read('mobile.html');

test('both UIs follow approval_request / approval_resolved on /api/events and read approvals from the status snapshot', () => {
  for (const ev of ['approval_request', 'approval_resolved']) {
    assert.ok(app.includes(`addEventListener('${ev}'`), `app.js listens to ${ev}`);
    assert.ok(mobile.includes(`on('${ev}'`), `mobile.js listens to ${ev}`);
  }
  assert.match(app, /addEventListener\('status_snapshot'[^\n]*if \(ev\.approvals\) applyApprovals\(ev\.approvals\)/);
  assert.match(mobile, /on\('status_snapshot'[^\n]*if \(ev\.approvals\) applyApprovals\(ev\.approvals\)/);
  // A snapshot without `approvals` (older hub) is ignored rather than clearing or throwing.
  for (const src of [app, mobile]) assert.match(src, /function applyApprovals\(list\) \{\s*if \(!Array\.isArray\(list\)\) return;/);
});

test('both UIs also take the card from the agent\'s own chat stream, deduped by id', () => {
  // Desktop: every stream reader (solo, group, tiger team, worker) routes gateway approval events to one handler.
  assert.ok((app.match(/type === 'approval_request' \|\| \w+\.type === 'approval_resolved'\) \{\s*onApprovalEvent\(/g) || []).length >= 4, 'all desktop stream readers');
  assert.match(mobile, /case 'approval_request':\s*case 'approval_resolved':\s*onApprovalEvent\(g\)/);
  for (const src of [app, mobile]) {
    assert.ok(src.includes('const approvals = new Map()'), 'one map of pending cards by id');
    assert.match(src, /function upsertApproval\(ev\) \{\s*if \(!ev \|\| !ev\.id\) return;/);
  }
});

test('both UIs answer through POST /api/approvals/<id> with allow / deny and offer "this kind for 1 hour"', () => {
  assert.match(app, /fetch\(`\/api\/approvals\/\$\{encodeURIComponent\(id\)\}`, \{\s*method: 'POST'/);
  assert.match(mobile, /api\(`\/api\/approvals\/\$\{encodeURIComponent\(id\)\}`, \{\s*method: 'POST'/);
  for (const src of [app, mobile]) {
    assert.ok(src.includes("JSON.stringify({ decision, remember: remember || null })"));
    assert.ok(src.includes("'allow', '1h'") || src.includes('data-remember="1h"'), 'remember 1h button');
    assert.ok(src.includes('Approve this kind for 1 hour'));
    assert.ok(src.includes('r.status === 404'), 'already answered elsewhere');
  }
  assert.ok(app.includes("'Already answered'") && mobile.includes("toast('Already answered')"));
});

test('cards read in plain words with a readable detail block and a countdown', () => {
  for (const src of [app, mobile]) {
    assert.ok(src.includes("send: 'send off this machine'") && src.includes("write_outside: 'write outside its folders'"));
    assert.ok(src.includes("admin: 'change hub data / another agent'") && src.includes("money: 'move money'"));
    assert.ok(src.includes('wants to ${'), 'agent display name + what it wants');
    assert.ok(src.includes("command: 'Command'") && src.includes("to: 'To'") && src.includes("path: 'Path'"), 'detail keys become labels');
    assert.ok(src.includes('function approvalCountdown(expiresAt)'));
    assert.ok(src.includes('Over a spend cap: '), 'capReason shown');
  }
});

test('desktop: cards stack newest first in a non-blocking fixed stack; the old confirm_tools flow is gone', () => {
  assert.ok(app.includes("stack.insertBefore(card, stack.firstChild)"), 'newest on top');
  assert.ok(html.includes('#approval-stack') && html.includes('.approval-card'));
  assert.ok(!html.includes('tool-confirm-overlay'), 'old modal CSS removed');
  assert.ok(!app.includes('/api/confirm_tools_toggle'), 'no more confirm_tools toggle fetches');
  assert.ok(!app.includes('showToolConfirmModal') && !app.includes("'tool_confirm'"), 'old modal and handler removed');
  assert.ok(!html.includes('confirm-tools-toggle'), 'toggle removed from the header');
  assert.ok(!app.includes('confirm_tools:'), 'chat requests no longer send confirm_tools');
  assert.ok(app.includes("fetch('/api/approvals'"), 'pending list polled while the event stream is down');
});

test('mobile: one bottom sheet for every screen, badge on the Agents tab, service worker bumped to v10', () => {
  assert.ok(mhtml.includes('<dialog id="approval-sheet">'));
  assert.ok(mhtml.includes('id="agents-approvals"'), 'badge element on the Agents tab');
  assert.match(mobile, /ap\.classList\.toggle\('on', approvals\.size > 0\)/);
  assert.ok(mobile.includes('sheet.show()'), 'non-modal: the rest of the app stays usable');
  assert.ok(mobile.includes("api('/api/approvals'"), 'pending list fetched on poll / foreground');
  assert.match(read('sw.js'), /const VERSION = 'hub-mobile-v103'/);
});

// removed (P4-2): 'agent settings: tool policy section reads /api/policy/<agent> and PATCHes policy' pinned the old page's source; the card's Access rows
// (OPT-0008..0013, 0017, 0018) read and PATCH {policy} - test/ui-agent-card-access.test.js. (The old page's line "ask pauses it on an approval card" is not on the card.)

test('desktop: spend readout and caps come from /api/ledger', () => {
  assert.ok(app.includes("fetch('/api/ledger/today'"));
  assert.match(app, /stSaveFetch\('\/api\/ledger\/caps', \{ method: 'POST'/);
  // Save now sends only the caps the person changed (the `send` object), still in the one POST shared with the monthly cap.
  assert.ok(app.includes('body: JSON.stringify(send)') && app.includes('send.monthlyUsd =') && app.includes('send.monthlyResetDay ='));
  assert.ok(html.includes('id="spend-today"'), 'sidebar readout');
  assert.ok(app.includes('`spent today ${usd(t.total)}`'));
  assert.match(app, /const show = !!t && typeof t\.paidTurns === 'number' && \(t\.total \|\| 0\) >= 0\.005/, 'hidden below half a cent of pay-per-use spend, and on an older hub answer');
  assert.match(app, /const SPEND_REFRESH_MS = 60000/);
  assert.match(app, /'turn_end'[^\n]*scheduleSpendRefresh\(\)/, 'refreshed after each turn_end');
  assert.ok(app.includes('id="st-cap-agent"') && app.includes('id="st-cap-hub"') && app.includes('placeholder="unlimited"'));
  assert.ok(app.includes('switch to ask for the rest of the day'));
});
