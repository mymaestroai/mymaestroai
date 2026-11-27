'use strict';
// Voice is easy to find, desktop page (part B1, reworked by part C1): the ⋯ menu item, the Voice group in Settings and its status lines, the Voice
// panel's two lines, the microphone that appears ONLY when voice is ready (hidden while getting ready, failed or off), the 20 s status read while
// getting ready, the Retry button, the one-time hint, and the Guide / help / welcome words.
// The functions are taken from app.js and run against small fake browser objects.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('app.js');
const html = read('index.html');

// The source of one top-level function or const of app.js (4-space indent): a one-liner, or up to its closing "    }" line.
function src(name) {
  const re = new RegExp(`^    (?:async )?function ${name}\\(|^    (?:const|let) ${name}\\b`, 'm');
  const m = re.exec(app);
  assert.ok(m, `${name} found in app.js`);
  const lineEnd = app.indexOf('\n', m.index);
  const first = app.slice(m.index, lineEnd);
  if (!/\{\s*$/.test(first) && !/=>\s*\($/.test(first)) return first;
  const end = app.indexOf('\n    }\n', m.index);
  assert.ok(end > 0, `${name} ends`);
  return app.slice(m.index, end + 6);
}
const NAMES = ['voiceMicState', 'voiceKind', 'voiceMbText', 'voicePctText', 'voiceSettingsLine', 'voiceAdminName', 'voiceAgentName', 'voiceOffText', 'voicePollWanted',
  'voiceWaitSchedule', 'voiceSummaryPaint', 'voicePaintSettings', 'voiceRetryNow', 'voicePaint', 'voiceMicIdleTitle', 'voiceHintKey', 'voiceHintSeen', 'voiceHintMark', 'voiceHintTarget', 'voiceHintBlocked',
  'voiceHintOk', 'voiceHintHide', 'voiceHintDismiss', 'voiceHintPlace', 'voiceHintShow', 'voiceHintTick', 'voiceReady', 'openVoiceSettings'];
const CONSTS = ['VOICE_HINT_TEXT', 'VOICE_HINT_DELAY_MS', 'VOICE_POLL_MS'];

function btn(id) {
  const attrs = {}, cls = new Set();
  return {
    id, style: {}, title: '', attrs, offsetParent: {}, innerHTML: '<svg>mic</svg>',
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c), toggle: (c, on) => { if (on === undefined ? !cls.has(c) : on) cls.add(c); else cls.delete(c); return cls.has(c); } },
    has: (c) => cls.has(c), setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: (k) => attrs[k],
    getBoundingClientRect: () => ({ top: 700, left: 300, right: 340, width: 40, height: 40 }),
  };
}

function makeEnv(o = {}) {
  const calls = { toasts: [], refresh: 0, opened: [], settingsAt: [], sum: [], timers: [], cleared: 0, focused: [], fetches: [], settingsRefresh: 0 };
  const store = {};
  const mic = btn('mic-c1');
  mic.closest = (sel) => (o.row && sel === '.input-area' ? { getBoundingClientRect: () => ({ top: o.row }) } : null);   // the whole composer row, taller than the button
  const el = () => ({ style: {}, textContent: '', checked: false, disabled: false, value: 0 });
  const els = { 'mic-c1': mic, 'st-voice-status': el(), 'st-voice-retry': el(), 'st-voice-raw': el() };
  const appended = [];
  const doc = {
    hidden: false,
    documentElement: { clientWidth: 390 },
    getElementById: (id) => els[id] || null,
    querySelectorAll: (sel) => (sel === '.input-area .mic-btn' ? [mic] : []),
    querySelector: (sel) => (state.overlay && String(sel).includes(state.overlay) ? { id: 'overlay' } : null),
    createElement: () => {
      const e = { style: { setProperty(k, v) { e.style[k] = v; } }, attrs: {}, offsetWidth: 220, removed: false, handlers: {}, setAttribute(k, v) { e.attrs[k] = v; }, remove() { e.removed = true; const i = appended.indexOf(e); if (i >= 0) appended.splice(i, 1); },
        querySelector: (sel) => (sel === '.voice-hint-close' ? (e.close ||= { addEventListener: (t, f) => { e.handlers[t] = f; }, click: () => e.handlers.click() }) : null) };
      return e;
    },
    body: { classList: { toggle() {} }, appendChild: (e) => { appended.push(e); } },
  };
  const state = { status: o.status === undefined ? { enabled: true, ready: true } : o.status, admin: o.admin !== false, overlay: null };
  const stubs = {
    document: doc, window: { hubMe: o.me === undefined ? { user: { id: 'u7' }, isAdmin: true } : o.me, innerWidth: 390, innerHeight: 800 },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    chats: { c1: { agent: 'alice', display: 'Alice' }, c2: { agent: 'bob' } }, activeChat: 'c1',
    capName: (s) => s[0].toUpperCase() + s.slice(1),
    voiceById: (id) => els[id] || null,
    isHubAdmin: () => state.admin, hubToast: (t) => calls.toasts.push(t),
    voiceRefreshStatus: () => { calls.refresh++; }, voiceSettingsRefresh: () => { calls.settingsRefresh++; },
    fetch: async (url, opts) => { calls.fetches.push([url, opts && opts.method]); return { ok: o.retryOk !== false, status: o.retryOk === false ? 403 : 200, json: async () => (o.retryOk === false ? { error: 'admin_only' } : { ok: true }) }; }, openSettingsAt: async (id) => { calls.settingsAt.push(id); },
    stSum: (g, k, t) => calls.sum.push([g, k, t]),
    voicePrefsNow: () => ({ mode: o.mode || 'handsfree' }),
    voiceCallS: { call: null, active: false, starting: false, press: false }, voiceRec: { chatId: null },
    voiceDeviceFallback: () => false, voiceModeChipPaint() {}, voiceCallPaintBtn() {}, simpleOn: () => false,
    questionOverlays: {},
    setTimeout: (f, ms) => { calls.timers.push({ f, ms }); return calls.timers.length; }, clearTimeout: () => { calls.cleared++; },
    Date: { now: () => 0 },
  };
  // voiceStatus and activeChat are `let`s of the page: the harness keeps them in one object the functions read through getters.
  const names = Object.keys(stubs).filter((n) => n !== 'voiceStatus' && n !== 'activeChat');
  const body = CONSTS.map((c) => src(c)).join('\n') + '\nconst voiceHint = { el: null, chatId: null, due: 0 };\nlet voiceWaitTimer = null;\n'
    + NAMES.map((n) => src(n)).join('\n')
    + '\nreturn { voiceMicState, voiceKind, voiceSettingsLine, voicePollWanted, voiceRetryNow, voiceWaitSchedule, voiceSummaryPaint, voicePaint, voiceMicIdleTitle, voiceHintTick, voiceHintDismiss, voiceHintHide, voiceHintKey, voiceOffText, openVoiceSettings, voiceHint,'
    + ' setStatus: (s) => { voiceStatus = s; }, setChat: (c) => { activeChat = c; }, getTimer: () => voiceWaitTimer };';
  const api = new Function(...names, `let voiceStatus = ${JSON.stringify(state.status)}; let activeChat = 'c1';\n` + body)(...names.map((n) => stubs[n]));
  return { api, calls, store, mic, els, appended, doc, stubs, state };
}

// ── the ⋯ menu is gone (P4-11): Voice is the gear's Voice and calls group ──
test('no ⋯ menu Voice item any more: the voice entry is openVoiceSettings (Settings at Voice and calls)', () => {
  assert.ok(!html.includes('id="more-voice-item"') && !html.includes('id="more-menu"'));
  assert.match(read('app.js'), /async function openVoiceSettings\(\) \{\s*await openSettingsAt\('st-voice-section'\);/);
});

test('openVoiceSettings: opens the voice section; an admin lands on the On switch, anyone else on the heading', async () => {
  for (const admin of [true, false]) {
    const env = makeEnv({ admin });
    env.state.admin = admin;
    env.els['st-voice-enabled'] = { focus() { env.calls.focused.push('enabled'); } };
    env.doc.querySelector = (sel) => (sel === '#st-voice-section h4' ? { tabIndex: 0, focus() { env.calls.focused.push('heading'); } } : null);
    await env.api.openVoiceSettings();
    assert.deepStrictEqual(env.calls.settingsAt, ['st-voice-section']);
    assert.deepStrictEqual(env.calls.focused, [admin ? 'enabled' : 'heading']);
  }
  assert.match(src('openVoiceSettings'), /target\.tabIndex = -1/, 'the heading gets tabindex -1');
});

// ── Settings ──
test('Settings: a Voice group right after Appearance, not in Tools; heading "Voice"; search words; the switch words', () => {
  const g = require('../lib/ui-settings-groups.js').GROUPS;   // eight groups now: Voice and calls is its own group, after Models and money
  const ids = g.map((x) => x.id);
  assert.strictEqual(ids[ids.indexOf('money') + 1], 'voice');
  assert.strictEqual(g.find((x) => x.id === 'voice').title, 'Voice and calls');
  assert.deepStrictEqual(g.find((x) => x.id === 'voice').sections, ['st-voice-section']);
  assert.ok(!g.find((x) => x.id === 'tools').sections.includes('st-voice-section'));
  const h = src('voiceSettingsHtml');
  assert.match(h, /<h4>Voice<\/h4>/);
  assert.doesNotMatch(h, /<h4>Voices<\/h4>/);
  assert.match(h, /<span class="st-search-words" hidden>voice microphone mic talk speak speech call dictation<\/span>/);
  assert.match(h, /if \(admin\) h \+= row\('Voice on or off for everyone', `<label[^\n]*id="st-voice-enabled" onchange="voiceSettingEnable\(this\)"> On for everyone on this Maestro<\/label>`\);/);
  // the search matches the section's textContent, and hidden words are part of it
  assert.match(src('stSearch'), /text: `\$\{s\.textContent\} \$\{wordHits\(s\)/);   // lower-cased by STG.search
});

test('Settings: no user-facing "Settings, Voices" is left', () => {
  assert.ok(!/Settings, Voices\.['`]/.test(app), 'toast and status words say Settings, Voice');
  assert.ok(!app.includes('An admin can turn it on in Settings, Voices.'));
});

test('summary line of the Voice group: On, ready / Getting ready (+ %) / Not ready: will retry / Off / Not supported', () => {
  const cases = [
    [{ enabled: true, ready: true }, 'On, ready'],
    [{ enabled: true, ready: false }, 'Getting ready'],
    [{ enabled: true, ready: false, installing: true, progress: 0.42 }, 'Getting ready 42%'],
    [{ enabled: true, ready: false, installing: true }, 'Getting ready'],
    [{ enabled: false, ready: false }, 'Off'],
    [{ enabled: true, ready: false, failed: true }, 'Not ready: will retry'],
    [{ enabled: true, ready: false, error: 'x', failReason: 'network' }, 'Not ready: will retry'],
    [{ enabled: true, ready: false, platformSupported: false }, 'Not supported'],
  ];
  for (const [st, want] of cases) {
    const { api, calls } = makeEnv();
    api.setStatus(st);
    api.voiceSummaryPaint();
    assert.deepStrictEqual(calls.sum.pop(), ['voice', 'state', want], JSON.stringify(st));
  }
});

test('Settings status line: ready, installing (size and %), waiting, each failure reason, off (admin / member), unsupported', () => {
  const L = (st, admin = true) => makeEnv().api.voiceSettingsLine(st, admin);
  assert.strictEqual(L({ enabled: true, ready: true }), 'Voice is on and ready.');
  assert.strictEqual(L({ enabled: true, installing: true, progress: 0.42, downloadBytes: 312400000 }), 'Getting voice ready: downloading the speech engines, about 312 MB (42%).');
  assert.strictEqual(L({ enabled: true, installing: true, progress: 0.42, bytesTotal: 500000000 }), 'Getting voice ready: downloading the speech engines, about 500 MB (42%).', 'bytesTotal when downloadBytes is missing');
  assert.strictEqual(L({ enabled: true, installing: true }), 'Getting voice ready: downloading the speech engines.', 'size and % omitted when unknown');
  assert.strictEqual(L({ enabled: true, ready: false, downloadBytes: 312400000 }), 'Getting voice ready: about 312 MB to download. It starts by itself.');
  const F = (r, extra) => L({ enabled: true, ready: false, failed: true, error: 'raw', failReason: r, downloadBytes: 312400000, ...extra });
  assert.strictEqual(F('network'), "Voice isn't ready: this computer couldn't reach the internet to download the speech engines. It tries again by itself.");
  assert.strictEqual(F('disk'), "Voice isn't ready: not enough free disk space for the speech engines (about 312 MB). It tries again by itself.");
  assert.strictEqual(F('damaged'), "Voice isn't ready: a download was damaged. It tries again by itself.");
  assert.strictEqual(F('other'), "Voice isn't ready: the speech engines didn't install. It tries again by itself.");
  assert.strictEqual(F(null), "Voice isn't ready: the speech engines didn't install. It tries again by itself.");
  assert.strictEqual(L({ enabled: false }), 'Voice is off.');
  assert.strictEqual(L({ enabled: false, adminName: 'Sam' }, false), 'Voice is off. Sam can turn it on.');
  assert.strictEqual(L({ enabled: false }, false), 'Voice is off. An admin can turn it on.');
  assert.strictEqual(L({ enabled: true, platformSupported: false }), 'Voice is not supported on this computer.');
});

test('Settings, failed: the reason, the raw error in small text and Retry now for an admin; a member sees the reason only; paints on every status read', () => {
  const st = { enabled: true, ready: false, failed: true, error: 'ENOTFOUND host', failReason: 'network' };
  const a = makeEnv({ status: st }); a.api.setStatus(st); a.api.voicePaint();
  assert.match(a.els['st-voice-status'].textContent, /^Voice isn't ready: this computer couldn't reach the internet/);
  assert.strictEqual(a.els['st-voice-raw'].textContent, 'ENOTFOUND host');
  assert.notStrictEqual(a.els['st-voice-raw'].style.display, 'none');
  assert.strictEqual(a.els['st-voice-retry'].style.display, '', 'Retry now shown');
  assert.strictEqual(a.mic.style.display, 'none', 'and the microphone stays hidden');
  const m = makeEnv({ admin: false }); m.api.setStatus({ ...st, error: undefined }); m.api.voicePaint();
  assert.match(m.els['st-voice-status'].textContent, /^Voice isn't ready/);
  assert.strictEqual(m.els['st-voice-retry'].style.display, 'none');
  assert.strictEqual(m.els['st-voice-raw'].style.display, 'none');
  a.api.setStatus({ enabled: true, ready: true }); a.api.voicePaint();
  assert.strictEqual(a.els['st-voice-retry'].style.display, 'none', 'gone when ready');
  assert.strictEqual(a.els['st-voice-status'].textContent, 'Voice is on and ready.');
  const h = src('voiceSettingsHtml');
  assert.match(h, /id="st-voice-retry"[^>]*onclick="voiceRetryNow\(this\)">Retry now<\/button>/);
});

test('Retry now: POST /api/voice/retry, then a refresh of Settings; a refusal is a toast', async () => {
  const e = makeEnv(); const b = { disabled: false };
  await e.api.voiceRetryNow(b);
  assert.deepStrictEqual(e.calls.fetches, [['/api/voice/retry', 'POST']]);
  assert.strictEqual(e.calls.settingsRefresh, 1);
  assert.strictEqual(b.disabled, false);
  const f = makeEnv({ retryOk: false }); await f.api.voiceRetryNow(b);
  assert.deepStrictEqual(f.calls.toasts, ['Could not retry: admin_only']);
  assert.strictEqual(f.calls.settingsRefresh, 1);
});

// ── the Voice panel ──
test('Voice panel: the admin gets "All voice settings" at the top, a member the "looked after by" line at the bottom', () => {
  const s = src('voicePopLinks') + '\n' + src('voicePopHtml');   // the role-dependent part lives in voicePopLinks (voicePopHtml itself has no admin gate)
  const make = (admin) => {
    const scope = {
      VOICE_CONTINUE_WAITS: [3000], voiceContinueWaitNow: () => 3000, voicePrefsNow: () => ({ mode: 'handsfree' }), chats: { c1: { agent: 'alice' } }, isHubAdmin: () => admin,
      hubEsc: String, voiceAdminName: () => 'Sam <b>', VOICE_ECHO_HINT: '', VOICE_KEEP_HINT: '', voiceKeepAliveNow: () => false,
    };
    for (const m of s.matchAll(/\b(voice[A-Z][A-Za-z]+)\(/g)) if (!(m[1] in scope) && m[1] !== 'voicePopHtml' && m[1] !== 'voicePopLinks') scope[m[1]] = () => '';
    for (const m of s.matchAll(/\b(voice[A-Z][A-Za-z]+Now)\b/g)) if (!(m[1] in scope)) scope[m[1]] = () => 1;
    scope.voiceSpeedLabel = () => '1x';
    const names = Object.keys(scope);
    return new Function(...names, s + '\nreturn voicePopHtml;')(...names.map((n) => scope[n]))('c1');
  };
  const a = make(true), m = make(false);
  assert.ok(a.startsWith('<div class="vp-row"><button type="button" class="vp-all-link" data-vp="all-settings"'), 'the link is first');
  assert.match(a, />All voice settings<\/button>/);
  assert.ok(!/looked after by/.test(a));
  assert.ok(!/all-settings/.test(m));
  assert.ok(m.trimEnd().endsWith('Voice for everyone on this Maestro is looked after by Sam <b>.</div>'), 'the member line is last, with the admin name');
  assert.match(app, /if \(t\.dataset\.vp === 'all-settings'\) \{ voicePopClose\(\); openVoiceSettings\(\); \}/, 'the panel click handler closes the panel and opens Settings');
});

const tickAll = (e, ms) => { e.api.voiceHintTick(ms); };
// ── the microphone: only when voice is ready ──
const STATES = [
  ['ready', { enabled: true, ready: true }, true],
  ['getting ready', { enabled: true, ready: false }, false],
  ['installing', { enabled: true, ready: false, installing: true, progress: 0.42 }, false],
  ['failed (failed)', { enabled: true, ready: false, failed: true }, false],
  ['failed (error)', { enabled: true, ready: false, error: 'boom', failReason: 'network' }, false],
  ['off', { enabled: false, ready: false }, false],
  ['off but flagged ready', { enabled: false, ready: true }, false],
  ['unsupported', { enabled: true, ready: false, platformSupported: false }, false],
  ['never read', null, false],
];
test('the microphone is shown only when voice is on and ready; no dimmed look exists', () => {
  for (const [name, st, shown] of STATES) {
    const { api, mic } = makeEnv();
    api.setStatus(st);
    api.voicePaint();
    assert.strictEqual(mic.style.display !== 'none', shown, name + ': shown');
    assert.strictEqual(mic.has('voice-wait-look') || mic.has('voice-off-look'), false, name + ': no dimmed look');
    assert.strictEqual(api.voiceMicState(), shown ? 'ready' : 'hidden', name);
  }
  assert.ok(!/voice-wait-look|voice-off-look|voiceNotReadyTap|voiceMicLook|voiceMicStateTitle/.test(app + html), 'the non-ready looks, taps and titles are gone');
});

test('mic title when ready names the agent in each mode; an idle ready mic keeps it', () => {
  const t = (mode) => { const e = makeEnv({ mode }); e.api.setStatus({ enabled: true, ready: true }); e.api.voicePaint(); return e.api.voiceMicIdleTitle('c1'); };
  assert.strictEqual(t('handsfree'), 'Talk to Alice: hands-free call');
  assert.strictEqual(t('press'), 'Talk to Alice: tap to talk');
  assert.strictEqual(t('tap'), 'Dictate a message to Alice');
  assert.strictEqual(makeEnv().api.voiceMicIdleTitle('c2'), 'Talk to Bob: hands-free call');
  assert.strictEqual(makeEnv().api.voiceMicIdleTitle('zz'), 'Talk to your agent: hands-free call');
});

test('the Simple call look is not given a non-ready look; mode chip and settings button keep today\'s rule: only when ready', () => {
  assert.ok(!/voiceMicLook/.test(src('simpleCallLook')));
  assert.match(app, /querySelectorAll\('\.input-area \.voice-extra'\)\) b\.style\.display = voiceReady\(\) \? '' : 'none'/);
  assert.match(app, /querySelectorAll\('\.input-area \.mic-btn'\)\) b\.style\.display = voiceReady\(\) \? '' : 'none'/);
});

test('the mic handler never records unless ready, and the tap ends the hint', () => {
  const m = src('voiceMicToggle');
  assert.ok(m.indexOf('voiceHintDismiss();') > 0 && m.indexOf('voiceHintDismiss();') < m.indexOf('voiceCallS.active'), 'the hint is dismissed first');
  const g = m.indexOf('if (!voiceReady()) { hubToast(voiceOffText()); voiceRefreshStatus(); return; }');
  assert.ok(g > 0);
  assert.ok(g < m.indexOf('voiceCallStart('), 'no call');
  assert.ok(g < m.indexOf('voiceOpenMic('), 'no recording');
  assert.match(src('voiceCallStart'), /if \(!voiceReady\(\)\) \{ hubToast\(voiceOffText\(\)\); return; \}/);
});

// ── the 20 s status read while getting ready ──
test('getting ready (and failed): the status is read again every 20 s while the page shows; it stops when ready, off or hidden', () => {
  for (const st of [{ enabled: true, ready: false }, { enabled: true, ready: false, installing: true, progress: 0.1 }, { enabled: true, ready: false, failed: true, error: 'x' }]) {
    const e = makeEnv();
    e.api.setStatus(st);
    e.api.voicePaint();
    assert.strictEqual(e.calls.timers.length, 1, JSON.stringify(st));
    assert.strictEqual(e.calls.timers[0].ms, 20000);
    e.api.voicePaint();   // not scheduled twice
    assert.strictEqual(e.calls.timers.length, 1);
    e.calls.timers[0].f();
    assert.strictEqual(e.calls.refresh, 1, 'the timer reads the status');
    e.api.setStatus({ enabled: true, ready: true }); e.api.voicePaint();
    assert.strictEqual(e.api.getTimer(), null, 'stopped when ready');
  }
  const stops = { 'hidden page': [{ enabled: true, ready: false }, true], off: [{ enabled: false, ready: false }, false], unsupported: [{ enabled: true, ready: false, platformSupported: false }, false], ready: [{ enabled: true, ready: true }, false], 'never read': [null, false] };
  for (const [name, [st, hidden]] of Object.entries(stops)) {
    const h = makeEnv(); h.doc.hidden = hidden; h.api.setStatus(st); h.api.voicePaint();
    assert.strictEqual(h.calls.timers.length, 0, 'no poll: ' + name);
  }
  const t = makeEnv(); t.api.setStatus({ enabled: true, ready: false }); t.api.voicePaint(); t.api.setStatus({ enabled: false }); t.api.voicePaint();
  assert.strictEqual(t.api.getTimer(), null, 'stopped when turned off');
  assert.match(app, /document\.addEventListener\('visibilitychange', \(\) => \{ try \{ if \(!document\.hidden && voicePollWanted\(\)\) voiceRefreshStatus\(\)/, 'coming back reads it at once');
});

test('the microphone appears by itself when a status read turns ready (the hint may then show)', () => {
  const e = makeEnv();
  e.api.setStatus({ enabled: true, ready: false }); e.api.voicePaint();
  assert.strictEqual(e.mic.style.display, 'none');
  tickAll(e, 1000); tickAll(e, 5000);
  assert.strictEqual(e.appended.length, 0, 'no hint before ready');
  e.api.setStatus({ enabled: true, ready: true }); e.api.voicePaint();
  assert.notStrictEqual(e.mic.style.display, 'none', 'the microphone is painted');
  tickAll(e, 6000); tickAll(e, 7600);
  assert.strictEqual(e.appended.length, 1, 'the hint follows');
});

// ── the one-time hint ──
test('hint: shown once about 1.5 s after the conditions hold, the key set the moment it is shown, above the mic and inside the window', () => {
  const e = makeEnv();
  assert.strictEqual(e.api.voiceHintKey(), 'mm-voice-hint:u7');
  tickAll(e, 1000);   // conditions hold: the delay starts
  assert.strictEqual(e.appended.length, 0);
  tickAll(e, 2000);
  assert.strictEqual(e.appended.length, 0, '1 s is not enough');
  tickAll(e, 2600);
  assert.strictEqual(e.appended.length, 1);
  assert.strictEqual(e.store['mm-voice-hint:u7'], '1', 'set when shown');
  const h = e.appended[0];
  assert.match(h.innerHTML, /New: talk to your agents\. Tap the microphone\./);
  assert.match(h.innerHTML, /<button type="button" class="voice-hint-close" aria-label="Close">×<\/button>/);
  assert.strictEqual(h.attrs.role, 'status');
  const bottom = parseFloat(h.style.bottom), right = parseFloat(h.style.right);
  assert.strictEqual(bottom, 800 - 700 + 10, 'its bottom edge is 10 px above the top of the mic (window 800 high, mic top at 700)');
  assert.ok(390 - right - 220 >= 8 && right >= 8, 'inside a 390 px window');
  tickAll(e, 99999);
  assert.strictEqual(e.appended.length, 1, 'not shown twice');
  // a new page load (same storage): never again
  const again = makeEnv(); Object.assign(again.store, e.store);
  tickAll(again, 1000); tickAll(again, 9000);
  assert.strictEqual(again.appended.length, 0);
});

test('hint: the key is the signed-in user id, anon without one', () => {
  assert.strictEqual(makeEnv({ me: null }).api.voiceHintKey(), 'mm-voice-hint:anon');
  assert.strictEqual(makeEnv({ me: { isAdmin: true } }).api.voiceHintKey(), 'mm-voice-hint:anon');
});

test('hint: close sets the key and removes it; the mic tap sets the key without it ever showing', () => {
  const e = makeEnv();
  tickAll(e, 1000); tickAll(e, 2600);
  e.appended[0].close.click();
  assert.strictEqual(e.appended.length, 0);
  assert.strictEqual(e.store['mm-voice-hint:u7'], '1');
  const t = makeEnv();
  t.api.voiceHintDismiss();   // what the mic handler calls
  assert.strictEqual(t.store['mm-voice-hint:u7'], '1', 'the microphone used');
  tickAll(t, 1000); tickAll(t, 5000);
  assert.strictEqual(t.appended.length, 0);
});

test('hint: not without a chat, a visible ready microphone, or with a call, a call starting, or a question showing', () => {
  const cases = {
    'no chat': (e) => e.api.setChat(null),
    'mic hidden': (e) => { e.mic.style.display = 'none'; },
    'not ready': (e) => e.api.setStatus({ enabled: true, ready: false }),
    'off': (e) => e.api.setStatus({ enabled: false }),
    'call': (e) => { e.stubs.voiceCallS.call = {}; },
    'call active': (e) => { e.stubs.voiceCallS.active = true; },
    'call starting': (e) => { e.stubs.voiceCallS.starting = true; },
    'question': (e) => { e.stubs.questionOverlays.q1 = {}; },
  };
  for (const [name, set] of Object.entries(cases)) {
    const e = makeEnv(); set(e);
    tickAll(e, 1000); tickAll(e, 3000); tickAll(e, 9000);
    assert.strictEqual(e.appended.length, 0, name);
    assert.strictEqual(Object.keys(e.store).length, 0, name + ': the key stays unset');
  }
  const e = makeEnv();
  tickAll(e, 1000); tickAll(e, 1200); e.stubs.questionOverlays.q1 = {}; tickAll(e, 1300);   // a condition lost: the 1.5 s starts over
  delete e.stubs.questionOverlays.q1;
  tickAll(e, 2000); tickAll(e, 2600);
  assert.strictEqual(e.appended.length, 0, 'the delay restarts when a condition was lost');
  tickAll(e, 3600);
  assert.strictEqual(e.appended.length, 1);
});

test('hint: goes away on a chat switch, a call start and a question appearing', () => {
  const show = () => { const e = makeEnv(); tickAll(e, 1000); tickAll(e, 2600); assert.strictEqual(e.appended.length, 1); return e; };
  let e = show(); e.api.setChat('c2'); tickAll(e, 2700); assert.strictEqual(e.appended.length, 0, 'chat switch');
  e = show(); e.stubs.voiceCallS.starting = true; tickAll(e, 2700); assert.strictEqual(e.appended.length, 0, 'call start');
  e = show(); e.stubs.questionOverlays.q9 = {}; tickAll(e, 2700); assert.strictEqual(e.appended.length, 0, 'question');
  e = show(); e.api.setStatus({ enabled: false }); tickAll(e, 2700); assert.strictEqual(e.appended.length, 0, 'voice no longer ready');
});

test('hint: CSS is in index.html (fixed callout, close button) and the page ticks it', () => {
  assert.match(html, /\.voice-hint \{ position: fixed;[^}]*max-width: min\(260px, calc\(100vw - 16px\)\)/);
  assert.match(html, /\.voice-hint \.voice-hint-close \{/);
  assert.match(app, /setInterval\(\(\) => \{ try \{ voiceHintTick\(\); \}/);
});

// ── Guide, help, welcome ──
test('Guide: a Voice item after Agents; help.html and welcome.html mention talking to an agent', () => {
  const guide = html.slice(html.indexOf('id="guide-panel"'));
  const a = guide.indexOf('<h3>🤖 Agents</h3>'), v = guide.indexOf('<h3>🎙 Voice</h3>'), d = guide.indexOf('<h3>💬 Discussion Types</h3>');
  assert.ok(a > 0 && v > a && v < d, 'after Agents, before Discussion Types');
  assert.ok(guide.includes('Talk to any agent: tap the microphone by the message box for a hands-free call, or pick Tap to talk or Dictation in its settings. Voice runs on this computer; an admin can switch it off in Settings, Voice.'));
  assert.match(read('help.html'), /Or talk to it:<\/b> tap the microphone by the message box for a hands-free call/);
  assert.match(read('welcome.html'), /You can talk to your agents by voice too\./);
});

test('Settings, Voice: the switch row holds only the switch; a Status row under it holds the sentence, the bar, Retry now and the raw error, in that order', () => {
  const h = src('voiceSettingsHtml');
  const sw = h.slice(h.indexOf("row('Voice on or off for everyone'"), h.indexOf("h += row('Status'"));
  assert.match(sw, /id="st-voice-enabled"/);
  for (const id of ['st-voice-status', 'st-voice-progress', 'st-voice-retry', 'st-voice-raw']) assert.ok(!sw.includes(id), id + ' is not in the switch row');
  const st = h.slice(h.indexOf("h += row('Status'"), h.indexOf("row('Engines'"));
  const pos = ['st-voice-status', 'st-voice-progress', 'st-voice-retry', 'st-voice-raw'].map((id) => st.indexOf(`id="${id}"`));
  assert.ok(pos.every((x) => x > 0) && pos.every((x, i) => i === 0 || x > pos[i - 1]), 'status, bar, Retry now, raw error in order: ' + pos);
  assert.match(st, /id="st-voice-retry"[^>]*onclick="voiceRetryNow\(this\)"/);
  assert.match(st, /id="st-voice-raw"[^>]*font-size:0\.75rem/);
  assert.match(st, /id="st-voice-status"[^>]*width:100%/, 'the sentence takes the full width');
  // a member: one Status row with the sentence, no switch row
  const member = st.slice(st.indexOf(': `<span id="st-voice-status"'));
  assert.match(member, /id="st-voice-status"/);
  assert.ok(!/id="st-voice-(progress|retry|raw)"/.test(member));
  assert.match(h, /if \(admin\) h \+= row\('Voice on or off for everyone'/, 'the switch row is the admin\'s only');
});

test('hint: its bottom edge is 10 px above the top of the whole composer row, not the mic button', () => {
  const e = makeEnv({ row: 640 });   // the mic top is 700, the row (taller message box) starts at 640
  tickAll(e, 1000); tickAll(e, 2600);
  assert.strictEqual(e.appended.length, 1);
  assert.strictEqual(parseFloat(e.appended[0].style.bottom), 800 - 640 + 10);
  assert.match(src('voiceHintPlace'), /closest\('\.input-area'\)/);
});

test('hint: none while the Settings overlay (or another dialog) is open; it goes away when one opens and the key stays unset until shown', () => {
  for (const sel of ['#st-overlay', '#profile-overlay', 'dialog[open]']) {
    const e = makeEnv(); e.state.overlay = sel;
    tickAll(e, 1000); tickAll(e, 3000); tickAll(e, 9000);
    assert.strictEqual(e.appended.length, 0, sel);
    assert.strictEqual(Object.keys(e.store).length, 0, sel + ': the key stays unset');
  }
  const e = makeEnv();
  tickAll(e, 1000); tickAll(e, 2600);
  assert.strictEqual(e.appended.length, 1);
  e.state.overlay = '#st-overlay'; tickAll(e, 3000);
  assert.strictEqual(e.appended.length, 0, 'a showing hint is taken down when Settings opens');
});

// ── Settings, Voice: the switch the page ticks from the status is not a change by the person ──
test('voicePaintSettings marks the voice switch as put in by the page, so Close asks no "Discard changes?"', () => {
  // Fails on 046bca91: the switch was set from the status after Settings opened without dialogGuard.markLoaded, so the hub's
  // dialog guard saw a changed checkbox and Close asked "Discard changes?" although nothing was changed (seen in proof p3).
  const s = app.slice(app.indexOf('function voicePaintSettings('), app.indexOf('function voiceSettingsInit('));
  assert.ok(s.length > 0);
  assert.match(s, /en\.checked = !!\(st && st\.enabled\);\s*try \{ dialogGuard\.markLoaded\(en\); \}/);
});
