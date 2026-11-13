'use strict';
// Voice phase 3, pages: the agent settings Voice row (cloud engines, privacy warning, sample) and the ElevenLabs key
// field in Settings -> providers. Source checks plus the page functions run against a tiny fake DOM.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const as = read('agent-settings.html'), app = read('app.js');

function between(src, from, to) { const a = src.indexOf(from), b = src.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return src.slice(a, b); }
const block = between(as, '  const VOICE_CLOUD_LISTS', '  async function playAgentVoiceSample');

function el(value) { return { value, style: {}, textContent: '', innerHTML: '', insertAdjacentHTML() {} }; }
function world({ kept = false, fetchImpl, confirmAnswer = true } = {}) {
  const ids = {};
  for (const id of ['voice-stt', 'voice-tts', 'voice-cloud-select', 'voice-cloud-id', 'voice-select', 'voice-cloud-row', 'voice-cloud-hint', 'voice-cloud-label', 'voice-kept-warning', 'voice-keys-line']) ids[id] = el('');
  ids['voice-stt'].value = 'local'; ids['voice-tts'].value = 'local';
  const statuses = [], confirms = [], calls = [];
  const ctx = {
    document: { getElementById: (id) => ids[id] || null },
    escapeHtml: (x) => String(x), pageGuard: { markLoaded() {} },
    showStatus: (id, type, msg) => statuses.push([type, msg]),
    confirm: (m) => { confirms.push(m); return confirmAnswer; },
    apiFetch: async () => ({}), agentName: 'zed',
    encodeURIComponent,
    fetch: async (url, opts) => { calls.push([url, opts]); return fetchImpl(url, opts); },
  };
  const f = new Function('ctx', `with (ctx) { ${block}; return { saveAgentVoice, paintVoiceCloud, paintVoiceNotes, set(k, v) { ({ kept: () => voiceKept = v, cloudKeys: () => voiceCloudKeys = v, cfg: () => voiceCfg = v })[k](); } }; }`);
  const api = f(ctx);
  api.set('kept', kept);
  return { api, ids, statuses, confirms, calls };
}
const okRes = (j, status = 200) => ({ status, ok: status < 400, json: async () => j });

test('Voice row: engine selects, cloud voice control, labels and the keys line', () => {
  assert.match(as, /<select id="voice-stt" onchange="saveAgentVoice\(\)"[^>]*><option value="local">Local \(free\)<\/option><option value="openai">OpenAI<\/option><option value="google">Google<\/option><\/select>/);
  assert.match(as, /<select id="voice-tts" onchange="saveAgentVoice\(\)"[^>]*><option value="local">Local \(free\)<\/option><option value="openai">OpenAI<\/option><option value="google">Google<\/option><option value="elevenlabs">ElevenLabs<\/option><\/select>/);
  assert.ok(as.includes('Speech recognition</label>') && as.includes('>Voice engine</label>'));
  assert.ok(as.includes('Local voice (also used if the cloud voice fails)'));
  assert.ok(as.includes('placeholder="ElevenLabs voice ID"') && as.includes('id="voice-cloud-hint"'));
  assert.match(as, /\['saveAgentVoice', 'voice-status', byId\('voice-select', 'voice-stt', 'voice-tts', 'voice-cloud-select', 'voice-cloud-id'\)\],/);
  assert.match(as, /SAVES_ON_CHANGE = new Set\(\[[^\]]*'saveAgentVoice'\]\)/);
  assert.ok(as.includes("key: ${voiceCloudKeys[k] ? 'set' : 'not set: add it in Settings -> providers'}") || as.includes("'not set: add it in Settings -> providers'"));
  assert.ok(as.includes('cost money per use and fall back to the free local engine'));
});

test('cloud voice lists match the spec', () => {
  assert.ok(block.includes("openai: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse']"));
  assert.ok(block.includes("google: ['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr']"));
  assert.ok(block.includes("{ openai: 'coral', google: 'Kore' }"));
  assert.ok(block.includes('/^[A-Za-z0-9]{10,40}$/'));
});

test('picking an engine shows the right cloud voice control', () => {
  const w = world();
  w.ids['voice-tts'].value = 'openai'; w.api.set('cfg', { stt: 'local', tts: 'openai', cloudVoice: '' }); w.api.paintVoiceCloud();
  assert.strictEqual(w.ids['voice-cloud-row'].style.display, 'flex');
  assert.strictEqual(w.ids['voice-cloud-select'].value, 'coral');
  assert.strictEqual(w.ids['voice-cloud-id'].style.display, 'none');
  w.api.set('cfg', { stt: 'local', tts: 'google', cloudVoice: 'Puck' }); w.api.paintVoiceCloud();
  assert.strictEqual(w.ids['voice-tts'].value, 'google');
  assert.strictEqual(w.ids['voice-cloud-select'].value, 'Puck');
  w.api.set('cfg', { stt: 'local', tts: 'elevenlabs', cloudVoice: 'abcdefghij12' }); w.api.paintVoiceCloud();
  assert.strictEqual(w.ids['voice-cloud-select'].style.display, 'none');
  assert.strictEqual(w.ids['voice-cloud-id'].style.display, '');
  assert.strictEqual(w.ids['voice-cloud-id'].value, 'abcdefghij12');
  assert.strictEqual(w.ids['voice-cloud-label'].textContent, 'ElevenLabs voice ID');
  w.api.set('cfg', { stt: 'local', tts: 'local', cloudVoice: '' }); w.api.paintVoiceCloud();
  assert.strictEqual(w.ids['voice-cloud-row'].style.display, 'none');
});

test('keys line reports which cloud keys are set', () => {
  const w = world();
  w.api.set('cloudKeys', { openai: true, google: false, elevenlabs: false }); w.api.paintVoiceNotes();
  const t = w.ids['voice-keys-line'].textContent;
  assert.ok(t.includes('OpenAI key: set') && t.includes('Google key: not set: add it in Settings -> providers') && t.includes('ElevenLabs key: not set'));
  w.api.set('cloudKeys', null); w.api.paintVoiceNotes();   // members: no key state
  assert.ok(!/key:/.test(w.ids['voice-keys-line'].textContent));
});

test('normal agent: choosing OpenAI sends the engines with no confirm and no cloudConfirm', async () => {
  const w = world({ fetchImpl: async () => okRes({ success: true }) });
  w.ids['voice-stt'].value = 'openai'; w.ids['voice-tts'].value = 'openai'; w.ids['voice-cloud-select'].value = 'nova'; w.ids['voice-select'].value = 'af_heart';
  await w.api.saveAgentVoice();
  assert.strictEqual(w.confirms.length, 0);
  const [url, opts] = w.calls[0];
  assert.strictEqual(url, '/api/agents/zed'); assert.strictEqual(opts.method, 'PATCH');
  assert.deepStrictEqual(JSON.parse(opts.body), { voice: { voice: 'af_heart', stt: 'openai', tts: 'openai', cloudVoice: 'nova' } });
  assert.strictEqual(w.statuses.at(-1)[0], 'success');
});

test('local engines send no cloudVoice', async () => {
  const w = world({ fetchImpl: async () => okRes({ success: true }) });
  await w.api.saveAgentVoice();
  assert.deepStrictEqual(JSON.parse(w.calls[0][1].body), { voice: { voice: '', stt: 'local', tts: 'local' } });
});

test('kept agent: warning text, confirm dialog, cloudConfirm true; cancel sends nothing', async () => {
  let w = world({ kept: true, fetchImpl: async () => okRes({ success: true }) });
  w.ids['voice-tts'].value = 'google'; w.ids['voice-cloud-select'].value = 'Kore';
  w.api.paintVoiceNotes();
  assert.strictEqual(w.ids['voice-kept-warning'].style.display, 'block');
  assert.ok(w.ids['voice-kept-warning'].textContent.startsWith("This agent's data is meant to stay on this computer. A cloud engine sends what you say, and what the agent says, to Google."));
  await w.api.saveAgentVoice();
  assert.strictEqual(w.confirms.length, 1);
  assert.strictEqual(JSON.parse(w.calls[0][1].body).voice.cloudConfirm, true);
  w = world({ kept: true, confirmAnswer: false, fetchImpl: async () => okRes({ success: true }) });
  w.ids['voice-tts'].value = 'openai'; w.ids['voice-cloud-select'].value = 'coral';
  await w.api.saveAgentVoice();
  assert.strictEqual(w.calls.length, 0);
  w = world({ kept: true, fetchImpl: async () => okRes({ success: true }) });   // local engines on a kept agent: no dialog
  await w.api.saveAgentVoice();
  assert.strictEqual(w.confirms.length, 0);
  assert.ok(!('cloudConfirm' in JSON.parse(w.calls[0][1].body).voice));
});

test('403 owner_confirmation_required shows the owner-only message', async () => {
  const w = world({ kept: true, fetchImpl: async () => okRes({ error: 'owner_confirmation_required' }, 403) });
  w.ids['voice-tts'].value = 'openai'; w.ids['voice-cloud-select'].value = 'coral';
  await w.api.saveAgentVoice();
  assert.deepStrictEqual(w.statuses.at(-1), ['error', 'Only the owner of this Maestro can choose a cloud engine for this agent.']);
});

test('ElevenLabs needs a valid voice id before anything is sent', async () => {
  const w = world({ fetchImpl: async () => okRes({ success: true }) });
  w.ids['voice-tts'].value = 'elevenlabs'; w.ids['voice-cloud-id'].value = 'short';
  await w.api.saveAgentVoice();
  assert.strictEqual(w.calls.length, 0);
  assert.strictEqual(w.statuses.at(-1)[0], 'error');
  w.ids['voice-tts'].value = 'elevenlabs'; w.ids['voice-cloud-id'].value = ' abcdefghij12 ';
  await w.api.saveAgentVoice();
  assert.strictEqual(JSON.parse(w.calls[0][1].body).voice.cloudVoice, 'abcdefghij12');
});

test('sample: reads X-Voice-Engine and X-Voice-Fallback; record load reads keptOnBox', () => {
  assert.ok(as.includes("r.headers.get('X-Voice-Engine')") && as.includes("r.headers.get('X-Voice-Fallback')"));
  assert.ok(as.includes('voiceKept = !!(rec && rec.keptOnBox)'));
  // the record comes from GET /api/agents (it carries voice and keptOnBox); there is no GET /api/agents/:name route
  assert.ok(/async function loadVoiceRecord\(listed\) \{[\s\S]{0,200}const rec = listed;/.test(as));
  assert.ok(!as.includes("apiFetch(`/api/agents/${encodeURIComponent(agentName)}`)"));
  assert.ok(as.includes('st.cloud'));
});

test('Settings -> providers: ElevenLabs key field, no Test button, counted in the Keys summary', () => {
  assert.ok(app.includes("{ id: 'elevenlabs', label: 'ElevenLabs (voice)', hasKey: true, hasUrl: false, hasTest: false }"));
  assert.ok(app.includes("${p.hasTest === false ? '' : `<button class=\"st-test-btn\" onclick=\"testProvider('${p.id}')\">Test</button>`}"));
  assert.ok(app.includes('PROVIDERS.filter(p => p.hasKey && pv[p.id] && pv[p.id].hasKey).length'));
  const pv = app.slice(app.indexOf('const PROVIDERS = ['), app.indexOf('];', app.indexOf('const PROVIDERS = [')));
  assert.strictEqual((pv.match(/hasKey: true/g) || []).length, 6);
  assert.strictEqual((pv.match(/hasUrl: true/g) || []).length, 3);
});

test('no U+FE0F or zero-width characters in the new code', () => {
  assert.ok(!/[\uFE0F\u200B-\u200D\u2060\uFEFF]/.test(block));
  assert.ok(!/[\uFE0F\u200B-\u200D\u2060\uFEFF]/.test(between(as, '<div class="section" id="voice-section">', '<div id="voice-status"')));
});
