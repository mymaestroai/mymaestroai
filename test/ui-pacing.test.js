'use strict';
// Source-level checks for the provider pacing indicator (desktop banner, mobile bar). Offline.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const app = read('app.js');
const mobile = read('mobile.js');
const mhtml = read('mobile.html');

test('both UIs follow the pacing events and read pacing from the status snapshot', () => {
  for (const ev of ['provider_paced', 'provider_ramp', 'provider_recovered']) {
    assert.ok(app.includes(`addEventListener('${ev}'`), `app.js listens to ${ev}`);
    assert.ok(mobile.includes(`on('${ev}'`), `mobile.js listens to ${ev}`);
  }
  assert.match(app, /addEventListener\('status_snapshot'[^\n]*if \(ev\.pacing\) applyPacing\(ev\.pacing\.paced\)/);
  assert.match(mobile, /on\('status_snapshot'[^\n]*if \(ev\.pacing\) applyPacing\(ev\.pacing\.paced\)/);
  // A snapshot without `pacing` (older hub) is ignored rather than throwing or clearing.
  for (const src of [app, mobile]) assert.match(src, /function applyPacing\(list\) \{\s*if \(!Array\.isArray\(list\)\) return;/);
});

test('paced / ramp upsert into one map per provider; recovered deletes', () => {
  for (const src of [app, mobile]) {
    assert.ok(src.includes('const pacing = new Map()'));
    assert.match(src, /'provider_paced'[^\n]*upsertPacing\(ev, 'paced'\)/);
    assert.match(src, /'provider_ramp'[^\n]*upsertPacing\(ev, 'ramping'\)/);
    assert.match(src, /'provider_recovered'[^\n]*clearPacing\(ev\.provider\)/);
  }
});

test('both UIs restore full parallel through /api/hub/pacing/reset with the provider in the body', () => {
  assert.match(app, /fetch\('\/api\/hub\/pacing\/reset', \{ method: 'POST'/);
  assert.match(mobile, /api\('\/api\/hub\/pacing\/reset', \{\s*method: 'POST'/);
  assert.ok(app.includes('JSON.stringify(provider ? { provider } : {})'));
  assert.ok(mobile.includes('JSON.stringify(provider ? { provider } : {})'), 'mobile resets one provider or all');
});

test('several slowed providers collapse to one summary line on both UIs', () => {
  assert.ok(mobile.includes('function pacingSummary()') && mobile.includes('providers slowed: ${names} · tap for details'));
  assert.ok(app.includes('providers slowed · ') && app.includes("label: 'Resume all'"));
});

test('reason codes and provider keys map to readable labels', () => {
  for (const src of [app, mobile]) {
    assert.match(src, /rate_limit: 'rate limit'/);
    assert.match(src, /overloaded: 'provider overloaded'/);
    assert.match(src, /timeout: 'network timeouts'/);
    for (const pair of ["'claude-sdk': 'Claude'", "anthropic: 'Claude API'", "openai: 'OpenAI'", "google: 'Gemini'", "'codex-cli': 'Codex'", "codex: 'Codex'", "lmstudio: 'LM Studio'", "perplexity: 'Perplexity'"]) {
      assert.ok(src.includes(pair), pair);
    }
  }
});

test('desktop: amber banner under the halt banner, countdown tick, Resume button, Settings mirror', () => {
  assert.ok(app.includes("'hub-pacing-banner'") && app.includes('#b26a00'));
  assert.ok(app.includes("document.getElementById('hub-halt-banner')"), 'positions itself relative to the halt banner');
  assert.ok(app.includes('Resume full speed'));
  assert.ok(app.includes('one at a time (') && app.includes('parallel again in '));
  assert.ok(app.includes('ramping back up, ') && app.includes(' at a time'));
  assert.ok(app.includes('cooling off done, ramping as calls succeed'));
  assert.match(app, /pacingTimer = setInterval\(paintPacing, 1000\)/);
  assert.ok(app.includes('id="st-pacing"') && app.includes('function paintPacingSettings'));
  assert.ok(app.includes("'/api/hub/status'"), 'polled while the event stream is down');
});

test('mobile: slim bar on all three screens, confirm dialog before resetting, /api/hub/status fallback poll', () => {
  assert.strictEqual((mhtml.match(/class="pacing-bar"/g) || []).length, 3);
  assert.ok(mhtml.includes('<dialog id="pacing-confirm">') && mhtml.includes('id="pacing-yes"'));
  assert.ok(mobile.includes('Resume full parallel for '));
  assert.ok(mobile.includes(' one at a time · ') && mobile.includes(' ramping ${e.limit}/${e.cap}'));
  assert.ok(mobile.includes("$('pacing-yes').addEventListener('click', resetPacing)"));
  assert.match(mobile, /const HUB_POLL_MS = 30000/);
  assert.match(mobile, /es\.readyState !== EventSource\.OPEN\) pollHubStatus\(\); \}, HUB_POLL_MS\)/);
  assert.ok(mobile.includes("api('/api/hub/status'"));
});

test('desktop sends become interjections whenever the hub reports the agent busy, and a busy bounce is interjected once', () => {
  assert.ok(app.includes("const agentWorking = chat.status === 'thinking' || !!(liveNow && liveNow.busy);"));
  assert.ok(app.includes('if (content && agentWorking && pendingImages.length === 0 && !skipInterjectOnce.delete(chatId)) {'));
  assert.ok(app.includes("if (!imagesToSend.length && !chat.bounced409) {"), '409 busy -> interjection, once');
  assert.match(app, /not currently processing/, 'turn already over -> normal send');
  assert.ok(app.includes('skipInterjectOnce.add(chatId);'));
});
